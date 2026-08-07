import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage, Server, ServerOptions } from 'node:http';
import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import type { SanitizerConfig, Upstream } from './types.js';
import { Sanitizer } from './sanitizer.js';

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

      if (
        rawBody &&
        rawBody.length > 0 &&
        contentType.toLowerCase().includes('application/json')
      ) {
        try {
          const parsed = JSON.parse(rawBody.toString('utf8'));
          const result = sanitizer.rewrite(parsed);
          if (result.changed) {
            outboundBody = Buffer.from(JSON.stringify(parsed), 'utf8');
            info.changed = true;
            info.firedRuleIds = result.firedRuleIds;
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
            (info.statusCode === 204 ||
              info.statusCode === 304 ||
              clientReq.method === 'HEAD')
          ) {
            clientRes.writeHead(info.statusCode, respHeaders);
            clientRes.end();
            info.streamed = false;
            info.durationMs = Date.now() - started;
            deps.onRequest?.(info);
            return;
          }

          clientRes.writeHead(info.statusCode ?? 200, respHeaders);
          info.streamed = true;
          // Stream verbatim — SSE chunks pass through unbuffered.
          upstreamRes.pipe(clientRes);
          upstreamRes.on('error', () => {
            if (!clientRes.writableEnded) clientRes.end();
          });
          clientRes.on('close', () => {
            if (!upstreamRes.destroyed) upstreamRes.destroy();
          });
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
  const providerHint = getHeader(req.headers, 'x-zps-provider');
  if (providerHint) {
    const key = findUpstreamKey(config.upstreams, providerHint);
    if (key) return config.upstreams[key];
  }
  // Infer from Authorization bearer prefix or path segment.
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

function getHeader(
  headers: IncomingMessage['headers'],
  name: string,
): string | undefined {
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

/** Options bag forwarded to createServer consumers. */
export type { ServerOptions };
