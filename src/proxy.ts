import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage, Server, ServerOptions, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { pipeline } from 'node:stream';
import { Buffer } from 'node:buffer';
import type { SanitizerConfig, Upstream } from './types.js';
import { Sanitizer } from './sanitizer.js';
import { createEmptyDeltaStripper } from './sse.js';
import { fixEmptyContentMessages } from './request-fixes.js';

/** Hop-by-hop headers that must NOT be forwarded between client and upstream. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

export interface ProxyDeps {
  config: SanitizerConfig;
  sanitizer: Sanitizer;
  /** Called for every proxied request with a short log line. */
  onRequest?: (info: RequestInfo) => void;
}

export interface RequestInfo {
  method: string;
  url: string;
  upstreamTarget: string;
  changed: boolean;
  firedRuleIds: string[];
  statusCode?: number;
  streamed: boolean;
  /** Empty delta-placeholder fields stripped from an SSE response (0/undefined = none). */
  responseFixedFields?: number;
  /** Empty-content messages dropped from the request (0/undefined = none). */
  requestDropped?: number;
  /** Empty-content messages filled with a placeholder (0/undefined = none). */
  requestFilled?: number;
  /** Original upstream status when a deterministic error was rewritten to 400. */
  rewrittenStatus?: number;
  durationMs: number;
}

/**
 * Create the reverse proxy HTTP server. Requests are:
 *   1. Body-buffered up to `maxBodyBytes`.
 *   2. Parsed as JSON and passed through the sanitizer (request bodies only).
 *   3. Forwarded to the resolved upstream, preserving method/path/query/headers.
 *   4. Response is streamed back verbatim, including SSE chunked streams.
 */
export function createProxyServer(deps: ProxyDeps): Server {
  const { config, sanitizer } = deps;
  const server = createServer(async (clientReq, clientRes) => {
    const started = Date.now();
    const info: RequestInfo = {
      method: clientReq.method ?? 'GET',
      url: clientReq.url ?? '/',
      upstreamTarget: '',
      changed: false,
      firedRuleIds: [],
      streamed: false,
      durationMs: 0,
    };

    try {
      const upstream = resolveUpstream(clientReq, config);
      info.upstreamTarget = upstream.target;

      // Buffer the request body (we must parse JSON to sanitize).
      const rawBody = await readBody(clientReq, config.maxBodyBytes);

      let outboundBody: Buffer | null = rawBody;
      let contentType = getHeader(clientReq.headers, 'content-type') ?? '';

      if (rawBody && rawBody.length > 0 && contentType.toLowerCase().includes('application/json')) {
        try {
          const parsed = JSON.parse(rawBody.toString('utf8'));
          let mutated = false;
          // Request-side fix first: drop/fill empty-content messages that
          // strict upstreams (Tencent WorkBuddy, error 11151) reject the
          // whole request over. Missing config key behaves as enabled.
          if (config.requestFixes?.fixEmptyContentMessages !== false) {
            const fix = fixEmptyContentMessages(parsed);
            if (fix.changed) {
              mutated = true;
              info.requestDropped = fix.dropped;
              info.requestFilled = fix.filled;
            }
          }
          const result = sanitizer.rewrite(parsed);
          if (result.changed) {
            mutated = true;
            info.changed = true;
            info.firedRuleIds = result.firedRuleIds;
          }
          if (mutated) {
            outboundBody = Buffer.from(JSON.stringify(parsed), 'utf8');
          }
        } catch {
          // Not valid JSON despite content-type — forward as-is.
        }
      }

      const upstreamUrl = new URL(clientReq.url ?? '/', upstream.target);
      const isTls = upstreamUrl.protocol === 'https:';
      const transport = isTls ? httpsRequest : httpRequest;

      // Build forwarded headers.
      const headers: Record<string, string> = {};
      for (const [key, values] of Object.entries(clientReq.headers)) {
        if (HOP_BY_HOP.has(key.toLowerCase())) continue;
        if (key.toLowerCase() === 'x-zps-provider') continue; // internal hint
        if (Array.isArray(values)) headers[key] = values.join(', ');
        else if (typeof values === 'string') headers[key] = values;
      }
      // Apply upstream header overrides.
      if (upstream.headers) {
        for (const [k, v] of Object.entries(upstream.headers)) headers[k] = v;
      }
      if (upstream.changeHost !== false) {
        headers.host = upstreamUrl.host;
      }
      if (outboundBody !== null) {
        headers['content-length'] = String(outboundBody.length);
      }

      const upstreamReq = transport(
        {
          protocol: upstreamUrl.protocol,
          hostname: upstreamUrl.hostname,
          port: upstreamUrl.port || (isTls ? 443 : 80),
          method: clientReq.method,
          path: upstreamUrl.pathname + upstreamUrl.search,
          headers,
        },
        (upstreamRes) => {
          info.statusCode = upstreamRes.statusCode;
          // Strip hop-by-hop from the response too.
          const respHeaders: Record<string, string> = {};
          for (const [key, values] of Object.entries(upstreamRes.headers)) {
            if (HOP_BY_HOP.has(key.toLowerCase())) continue;
            if (Array.isArray(values)) respHeaders[key] = values.join(', ');
            else if (typeof values === 'string') respHeaders[key] = values;
          }
          // HEAD/204/304 have no body.
          if (
            info.statusCode !== undefined &&
            (info.statusCode === 204 || info.statusCode === 304 || clientReq.method === 'HEAD')
          ) {
            clientRes.writeHead(info.statusCode, respHeaders);
            clientRes.end();
            info.streamed = false;
            info.durationMs = Date.now() - started;
            deps.onRequest?.(info);
            return;
          }

          // Optional response-side fix: rewrite deterministic upstream errors
          // (e.g. Tencent 11151 empty-content, wrapped in a 503 by account
          // pools) to a non-retryable 400 so clients fail fast instead of
          // backing off for minutes on a doomed request. Buffers error-sized
          // JSON bodies; everything else takes the streaming paths below.
          const respContentType = upstreamRes.headers['content-type'];
          const respIsJson =
            typeof respContentType === 'string' &&
            respContentType.toLowerCase().includes('application/json');
          const declaredLength = Number(upstreamRes.headers['content-length']);
          if (
            config.responseFixes?.failFastDeterministicErrors === true &&
            (info.statusCode ?? 200) >= 500 &&
            respIsJson &&
            !(declaredLength > ERROR_SNIFF_LIMIT_BYTES)
          ) {
            forwardWithDeterministicSniff(upstreamRes, clientRes, respHeaders, info, started, deps);
            return;
          }

          clientRes.writeHead(info.statusCode ?? 200, respHeaders);
          info.streamed = true;

          // Optional response-side fix: normalize SSE chat chunks. Only kicks
          // in when the toggle is on AND the upstream speaks SSE; the stream
          // itself decides per event whether anything needs changing.
          const fixSse =
            config.responseFixes?.stripEmptyDeltaFields === true &&
            typeof respContentType === 'string' &&
            respContentType.toLowerCase().includes('text/event-stream');

          if (fixSse) {
            const stripper = createEmptyDeltaStripper((fix) => {
              info.responseFixedFields = (info.responseFixedFields ?? 0) + fix.fields;
            });
            // pipeline destroys all streams on premature close of any of them.
            // But if the client disconnected before the upstream response
            // arrived, clientRes is already destroyed and pipeline() throws
            // synchronously (ERR_STREAM_UNABLE_TO_PIPE) — an uncaught throw
            // here killed the whole daemon in the wild. Drop the orphaned
            // response instead.
            try {
              pipeline(upstreamRes, stripper, clientRes, () => {});
            } catch {
              upstreamRes.destroy();
            }
          } else {
            // Stream verbatim — SSE chunks pass through unbuffered.
            upstreamRes.pipe(clientRes);
            upstreamRes.on('error', () => {
              if (!clientRes.writableEnded) clientRes.end();
            });
            clientRes.on('close', () => {
              if (!upstreamRes.destroyed) upstreamRes.destroy();
            });
          }
          upstreamRes.on('end', () => {
            info.durationMs = Date.now() - started;
            deps.onRequest?.(info);
          });
        },
      );

      upstreamReq.on('error', (err) => {
        info.durationMs = Date.now() - started;
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { 'content-type': 'application/json' });
          clientRes.end(
            JSON.stringify({
              error: {
                message: `zcode-prompt-sanitizer: upstream error (${err.message})`,
                type: 'upstream_error',
                target: upstream.target,
              },
            }),
          );
        } else if (!clientRes.writableEnded) {
          clientRes.end();
        }
        deps.onRequest?.(info);
      });

      if (outboundBody !== null) upstreamReq.end(outboundBody);
      else upstreamReq.end();
    } catch (err) {
      info.durationMs = Date.now() - started;
      if (!clientRes.headersSent) {
        clientRes.writeHead(500, { 'content-type': 'application/json' });
        clientRes.end(
          JSON.stringify({
            error: {
              message: `zcode-prompt-sanitizer: ${(err as Error).message}`,
              type: 'internal_error',
            },
          }),
        );
      }
      deps.onRequest?.(info);
    }
  });

  return server;
}

function resolveUpstream(req: IncomingMessage, config: SanitizerConfig): Upstream {
  const upstreamKeys = Object.keys(config.upstreams);

  // Standard behavior (matches http-proxy, nginx, liteLLM, one-api): when only
  // ONE upstream is configured, forward everything to it unconditionally — no
  // client-side routing header required. This is the common case for a local
  // sanitizer where ZCode just points its baseURL at the proxy.
  if (upstreamKeys.length === 1) {
    return config.upstreams[upstreamKeys[0]!]!;
  }

  // Multi-upstream routing: try explicit hint first, then heuristics.
  const providerHint = getHeader(req.headers, 'x-zps-provider');
  if (providerHint) {
    const key = findUpstreamKey(config.upstreams, providerHint);
    if (key) return config.upstreams[key];
  }
  const auth = getHeader(req.headers, 'authorization') ?? '';
  if (auth) {
    const key = findUpstreamKey(config.upstreams, auth);
    if (key) return config.upstreams[key];
  }
  const host = getHeader(req.headers, 'host');
  if (host) {
    const key = findUpstreamKey(config.upstreams, host);
    if (key) return config.upstreams[key];
  }

  // Fall back: synthesize a passthrough upstream from the Host header so the
  // proxy can operate without any config when the client points directly at it.
  if (host) {
    return { target: `http://${host}`, changeHost: false };
  }
  return { target: 'http://localhost', changeHost: false };
}

function findUpstreamKey(map: SanitizerConfig['upstreams'], needle: string): string | null {
  const lower = needle.toLowerCase();
  // Exact key match first.
  for (const k of Object.keys(map)) {
    if (k.toLowerCase() === lower) return k;
  }
  // Substring match on Authorization value (e.g. "Bearer workbuddy-xxx").
  for (const k of Object.keys(map)) {
    if (lower.includes(k.toLowerCase())) return k;
  }
  return null;
}

function getHeader(headers: IncomingMessage['headers'], name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        if (!done) {
          done = true;
          reject(new Error(`Request body exceeds ${maxBytes} bytes`));
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(chunks.length ? Buffer.concat(chunks) : null);
      }
    });
    req.on('error', (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

/**
 * Known deterministic upstream error signatures: failures no amount of
 * retrying will ever fix because the request itself is rejected. Currently
 * only the Tencent WorkBuddy empty-content rejection (code 11151, message
 * "a message has empty content ..."). Genuinely transient errors
 * (no_healthy_account, upstream_busy, rate limits, timeouts) never match.
 * Extend this list as new deterministic upstream errors are observed.
 */
const DETERMINISTIC_ERROR_SIGNATURES: readonly RegExp[] = [/empty content/i, /\b11151\b/];

/** Error bodies larger than this are streamed verbatim without sniffing. */
const ERROR_SNIFF_LIMIT_BYTES = 64 * 1024;

/**
 * Buffer a >=500 JSON error response (bounded by ERROR_SNIFF_LIMIT_BYTES),
 * test it against DETERMINISTIC_ERROR_SIGNATURES, and either:
 *  - match → respond 400 with the original body plus an
 *    `x-zps-rewritten-status` header carrying the upstream status, or
 *  - no match / oversized / malformed → forward verbatim with the original
 *    status (buffered bytes first, remainder piped).
 */
function forwardWithDeterministicSniff(
  upstreamRes: IncomingMessage,
  clientRes: ServerResponse,
  respHeaders: Record<string, string>,
  info: RequestInfo,
  started: number,
  deps: ProxyDeps,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let gaveUp = false;
  let settled = false;

  const finish = () => {
    if (settled) return;
    settled = true;
    info.durationMs = Date.now() - started;
    deps.onRequest?.(info);
  };

  const forwardVerbatim = () => {
    clientRes.writeHead(info.statusCode ?? 200, respHeaders);
    info.streamed = true;
    if (chunks.length) clientRes.write(Buffer.concat(chunks));
    if (upstreamRes.readableEnded) {
      clientRes.end();
      finish();
      return;
    }
    upstreamRes.pipe(clientRes);
    upstreamRes.on('end', finish);
  };

  upstreamRes.on('data', (chunk: Buffer) => {
    if (gaveUp) return;
    size += chunk.length;
    if (size > ERROR_SNIFF_LIMIT_BYTES) {
      // Too large to be an error payload worth sniffing — give up and
      // stream verbatim. The overflowing chunk must join the buffer too,
      // otherwise it is silently dropped and the body arrives truncated.
      gaveUp = true;
      chunks.push(chunk);
      forwardVerbatim();
      return;
    }
    chunks.push(chunk);
  });

  upstreamRes.on('end', () => {
    if (gaveUp || settled) {
      finish();
      return;
    }
    const body = Buffer.concat(chunks).toString('utf8');
    if (DETERMINISTIC_ERROR_SIGNATURES.some((re) => re.test(body))) {
      const original = info.statusCode ?? 503;
      respHeaders['x-zps-rewritten-status'] = String(original);
      info.rewrittenStatus = original;
      info.statusCode = 400; // what the client actually receives
      info.streamed = false;
      clientRes.writeHead(400, respHeaders);
      clientRes.end(body);
    } else {
      forwardVerbatim();
      return;
    }
    finish();
  });

  upstreamRes.on('error', () => {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'content-type': 'application/json' });
      clientRes.end(
        JSON.stringify({
          error: {
            message: 'zcode-prompt-sanitizer: upstream error while buffering error body',
            type: 'upstream_error',
          },
        }),
      );
    } else if (!clientRes.writableEnded) {
      clientRes.end();
    }
    finish();
  });
}

/** Options bag forwarded to createServer consumers. */
export type { ServerOptions };
