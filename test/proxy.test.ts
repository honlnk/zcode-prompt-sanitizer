import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { request } from 'node:http';
import { Sanitizer } from '../src/sanitizer.js';
import { createProxyServer } from '../src/proxy.js';
import { startServer, waitForListening } from '../src/server.js';
import { createDefaultConfig } from '../src/config/defaults.js';
import type { SanitizerConfig, RewriteRule } from '../src/types.js';

/** Helper: start a fake upstream that echoes the request body it received. */
function startEchoUpstream(handler: (body: any, headers: any) => void): Promise<{
  server: Server;
  port: number;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: any = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        handler(parsed, req.headers);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, received: parsed }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({
        server,
        port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** Start a fake SSE upstream that emits 3 chunks then closes. */
function startSseUpstream(): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      // Send 3 SSE chunks with small delays to verify streaming.
      let i = 0;
      const timer = setInterval(() => {
        res.write(`data: chunk-${i}\n\n`);
        i++;
        if (i >= 3) {
          clearInterval(timer);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }, 20);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({
        server,
        port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function httpRequestAsync(
  port: number,
  body: any,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
          'content-length': payload.length,
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const rule: RewriteRule = {
  id: 'pr-hint',
  enabled: true,
  scopes: ['system'],
  match: 'Main branch (you will usually use this for PRs):',
  replacement: 'Default git branch:',
};

let upstreamPort = 0;
let upstreamClose: () => Promise<void>;

beforeEach(async () => {
  const up = await startEchoUpstream(() => {});
  upstreamPort = up.port;
  upstreamClose = up.close;
});

afterEach(async () => {
  await upstreamClose();
});

describe('proxy end-to-end', () => {
  it('forwards requests and rewrites the trigger phrase before it reaches upstream', async () => {
    // Re-create upstream that captures what it received.
    let received: any = null;
    await upstreamClose();
    const up = await startEchoUpstream((body) => {
      received = body;
    });
    upstreamPort = up.port;
    upstreamClose = up.close;

    const config: SanitizerConfig = {
      ...createDefaultConfig(),
      port: 0,
      dashboard: { enabled: false, port: 0 },
      upstreams: { test: { target: `http://127.0.0.1:${upstreamPort}` } },
      rules: [rule],
    };
    const running = startServer(config, { configPath: null, quiet: true });
    await waitForListening(running.proxy);
    const proxyPort = (running.proxy.address() as any).port;

    const res = await httpRequestAsync(
      proxyPort,
      {
        messages: [
          {
            role: 'system',
            content: 'Main branch (you will usually use this for PRs): master',
          },
          { role: 'user', content: '你好' },
        ],
      },
      { 'x-zps-provider': 'test' },
    );

    expect(res.status).toBe(200);
    // Upstream should have received the REWRITTEN content.
    expect(received.messages[0].content).toBe('Default git branch: master');
    expect(received.messages[1].content).toBe('你好');

    await running.close();
  });

  it('does not mutate user-role content', async () => {
    let received: any = null;
    await upstreamClose();
    const up = await startEchoUpstream((body) => {
      received = body;
    });
    upstreamPort = up.port;
    upstreamClose = up.close;

    const config: SanitizerConfig = {
      ...createDefaultConfig(),
      port: 0,
      dashboard: { enabled: false, port: 0 },
      upstreams: { test: { target: `http://127.0.0.1:${upstreamPort}` } },
      rules: [rule],
    };
    const running = startServer(config, { configPath: null, quiet: true });
    await waitForListening(running.proxy);
    const proxyPort = (running.proxy.address() as any).port;

    await httpRequestAsync(
      proxyPort,
      {
        messages: [{ role: 'user', content: 'Main branch (you will usually use this for PRs): x' }],
      },
      { 'x-zps-provider': 'test' },
    );

    expect(received.messages[0].content).toBe('Main branch (you will usually use this for PRs): x');
    await running.close();
  });

  it('streams an SSE response back chunk-by-chunk without buffering', async () => {
    const sse = await startSseUpstream();
    const ssePort = sse.port;

    const config: SanitizerConfig = {
      ...createDefaultConfig(),
      port: 0,
      dashboard: { enabled: false, port: 0 },
      upstreams: { sse: { target: `http://127.0.0.1:${ssePort}` } },
      rules: [],
    };
    const running = startServer(config, { configPath: null, quiet: true });
    await waitForListening(running.proxy);
    const proxyPort = (running.proxy.address() as any).port;

    const arrivalTimes: number[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: proxyPort,
          method: 'POST',
          path: '/v1/chat/completions',
          headers: {
            'content-type': 'application/json',
            'x-zps-provider': 'sse',
          },
        },
        (res) => {
          expect(res.headers['content-type']).toBe('text/event-stream');
          res.on('data', () => arrivalTimes.push(Date.now()));
          res.on('end', () => resolve());
        },
      );
      req.on('error', reject);
      req.end(Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })));
    });

    // If streamed (not buffered), chunks arrive across ~40-60ms, so the gap
    // between first and last arrival should exceed 20ms.
    expect(arrivalTimes.length).toBeGreaterThanOrEqual(3);
    const span = arrivalTimes.at(-1)! - arrivalTimes[0]!;
    expect(span).toBeGreaterThan(15); // streamed, not all-at-once

    await running.close();
    await sse.close();
  });

  it('returns 502 on unreachable upstream', async () => {
    const config: SanitizerConfig = {
      ...createDefaultConfig(),
      port: 0,
      dashboard: { enabled: false, port: 0 },
      upstreams: { dead: { target: 'http://127.0.0.1:1' } },
      rules: [],
    };
    const running = startServer(config, { configPath: null, quiet: true });
    await waitForListening(running.proxy);
    const proxyPort = (running.proxy.address() as any).port;

    const res = await httpRequestAsync(
      proxyPort,
      { messages: [{ role: 'user', content: 'hi' }] },
      { 'x-zps-provider': 'dead' },
    );
    expect(res.status).toBe(502);
    await running.close();
  });
});

describe('proxy without configured upstream (Host-header passthrough)', () => {
  it('forwards to the host inferred from the Host header', async () => {
    let received: any = null;
    await upstreamClose();
    const up = await startEchoUpstream((body) => {
      received = body;
    });
    upstreamPort = up.port;
    upstreamClose = up.close;

    const config: SanitizerConfig = {
      ...createDefaultConfig(),
      port: 0,
      dashboard: { enabled: false, port: 0 },
      upstreams: {},
      rules: [],
    };
    const running = startServer(config, { configPath: null, quiet: true });
    await waitForListening(running.proxy);
    const proxyPort = (running.proxy.address() as any).port;

    // Send with Host header pointing at the fake upstream.
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }));
      const req = request(
        {
          host: '127.0.0.1',
          port: proxyPort,
          method: 'POST',
          path: '/v1/test',
          headers: {
            'content-type': 'application/json',
            'content-length': payload.length,
            host: `127.0.0.1:${upstreamPort}`,
          },
        },
        (r) => {
          const chunks: Buffer[] = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () =>
            resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          );
        },
      );
      req.on('error', reject);
      req.end(payload);
    });

    expect(res.status).toBe(200);
    expect(received).not.toBeNull();
    await running.close();
  });
});

describe('response fix: stripEmptyDeltaFields', () => {
  /** Fake upstream emitting Tencent-style SSE deltas with empty placeholders. */
  function startTencentStyleUpstream(): Promise<{
    server: Server;
    port: number;
    close: () => Promise<void>;
  }> {
    return new Promise((resolve) => {
      const server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (reasoning: string, content = '') =>
          `data: ${JSON.stringify({
            id: 'gen-1',
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                logprobs: null,
                finish_reason: '',
                delta: {
                  role: 'assistant',
                  content,
                  reasoning_content: reasoning,
                  function_call: null,
                  refusal: '',
                  tool_calls: [],
                },
              },
            ],
            usage: null,
          })}\n\n`;
        res.write(chunk('We'));
        res.write(chunk(' think'));
        res.write(
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: { content: '答案', reasoning_content: '' } }],
          })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
      });
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as any).port;
        resolve({
          server,
          port,
          close: () => new Promise((r) => server.close(() => r())),
        });
      });
    });
  }

  async function runProxyWithFix(enabled: boolean) {
    const up = await startTencentStyleUpstream();
    const config: SanitizerConfig = {
      ...createDefaultConfig(),
      port: 0,
      dashboard: { enabled: false, port: 0 },
      upstreams: { tencent: { target: `http://127.0.0.1:${up.port}` } },
      rules: [],
      responseFixes: { stripEmptyDeltaFields: enabled },
    };
    const running = startServer(config, { configPath: null, quiet: true });
    await waitForListening(running.proxy);
    const proxyPort = (running.proxy.address() as any).port;
    const res = await httpRequestAsync(
      proxyPort,
      { messages: [{ role: 'user', content: 'hi' }] },
      { 'x-zps-provider': 'tencent' },
    );
    await running.close();
    await up.close();
    return res;
  }

  it('strips empty delta fields when the toggle is on', async () => {
    const res = await runProxyWithFix(true);
    expect(res.status).toBe(200);
    const events = res.body.split('\n\n').filter(Boolean);
    expect(events.length).toBe(4); // 3 chunks + [DONE]
    const first = JSON.parse(events[0]!.replace(/^data: /, ''));
    expect(first.choices[0].delta.content).toBeUndefined();
    expect(first.choices[0].delta.reasoning_content).toBe('We');
    // The actual thinking-block splitter in older AI SDK builds.
    expect(first.choices[0].delta.tool_calls).toBeUndefined();
    expect(first.choices[0].finish_reason).toBeUndefined();
    const third = JSON.parse(events[2]!.replace(/^data: /, ''));
    expect(third.choices[0].delta.content).toBe('答案');
    expect(third.choices[0].delta.reasoning_content).toBeUndefined();
    expect(events[3]).toBe('data: [DONE]');
  });

  it('passes the stream through byte-identical when the toggle is off', async () => {
    const res = await runProxyWithFix(false);
    expect(res.status).toBe(200);
    expect(res.body).toContain('"content":""');
    expect(res.body).toContain('"reasoning_content":""');
    expect(res.body).toContain('"tool_calls":[]');
    expect(res.body).toContain('"finish_reason":""');
  });

  // Regression test: a client abort racing the upstream SSE response crashed
  // the whole proxy — pipeline() into the already-destroyed clientRes throws
  // ERR_STREAM_UNABLE_TO_PIPE synchronously, and uncaught it took the daemon
  // down (6 times in the wild within two weeks). The proxy must survive.
  it('survives a client abort racing the upstream SSE response', async () => {
    // Upstream that waits 100ms before sending SSE headers, so the client
    // abort lands while the response is still in flight.
    const slowSse = await new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
      const server = createServer((_req, res) => {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: {"choices":[]}\n\n');
          res.end();
        }, 100);
      });
      server.listen(0, '127.0.0.1', () => {
        resolve({
          port: (server.address() as any).port,
          close: () => new Promise((r) => server.close(() => r())),
        });
      });
    });

    const config: SanitizerConfig = {
      ...createDefaultConfig(),
      port: 0,
      dashboard: { enabled: false, port: 0 },
      upstreams: { tencent: { target: `http://127.0.0.1:${slowSse.port}` } },
      rules: [],
      responseFixes: { stripEmptyDeltaFields: true },
    };
    const running = startServer(config, { configPath: null, quiet: true });
    await waitForListening(running.proxy);
    const proxyPort = (running.proxy.address() as any).port;

    // Fire a request and abort it 20ms in — before the upstream responds.
    const aborting = request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        'x-zps-provider': 'tencent',
      },
    });
    aborting.on('error', () => {}); // ECONNRESET after destroy() is expected
    aborting.end(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }));
    await new Promise((r) => setTimeout(r, 20));
    aborting.destroy();

    // Let the upstream response (and, pre-fix, the synchronous throw) land.
    await new Promise((r) => setTimeout(r, 200));

    // The proxy must still be alive and serving.
    const res = await httpRequestAsync(
      proxyPort,
      { messages: [{ role: 'user', content: 'hi' }] },
      { 'x-zps-provider': 'tencent' },
    );
    expect(res.status).toBe(200);

    await running.close();
    await slowSse.close();
  });
});

describe('request fix: fixEmptyContentMessages', () => {
  // The wild poisoning scenario: GLM-era history replayed to a strict
  // upstream (Tencent WorkBuddy 11151). The proxy must clean it before it
  // leaves the machine.
  const poisonedBody = {
    model: 'kimi-k3.1-pro',
    messages: [
      { role: 'system', content: 'You are ZCode.' },
      { role: 'user', content: 'run tests' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'a', type: 'function', function: { name: 'bash', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'a', content: 'all green' },
      { role: 'assistant', content: '' }, // failed-turn placeholder
      { role: 'user', content: 'continue' },
    ],
  };

  async function runWithRequestFix(enabled: boolean) {
    let received: any = null;
    await upstreamClose();
    const up = await startEchoUpstream((body) => {
      received = body;
    });
    upstreamPort = up.port;
    upstreamClose = up.close;

    const config: SanitizerConfig = {
      ...createDefaultConfig(),
      port: 0,
      dashboard: { enabled: false, port: 0 },
      upstreams: { test: { target: `http://127.0.0.1:${up.port}` } },
      rules: [],
      requestFixes: { fixEmptyContentMessages: enabled },
    };
    const running = startServer(config, { configPath: null, quiet: true });
    await waitForListening(running.proxy);
    const proxyPort = (running.proxy.address() as any).port;
    const res = await httpRequestAsync(proxyPort, poisonedBody, {
      'x-zps-provider': 'test',
    });
    await running.close();
    return { res, received };
  }

  it('cleans a poisoned history before it reaches the upstream', async () => {
    const { res, received } = await runWithRequestFix(true);
    expect(res.status).toBe(200);
    expect(received.model).toBe('kimi-k3.1-pro'); // other fields untouched
    const msgs = received.messages;
    expect(msgs).toHaveLength(5);
    // Tool-call-only assistant turn kept but filled with " ".
    expect(msgs[2].role).toBe('assistant');
    expect(msgs[2].content).toBe(' ');
    expect(msgs[2].tool_calls).toHaveLength(1);
    // Blank failed-turn placeholder gone.
    expect(msgs.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
  });

  it('forwards the poisoned history verbatim when the toggle is off', async () => {
    const { received } = await runWithRequestFix(false);
    expect(received.messages).toHaveLength(6);
    expect(received.messages[2].content).toBeNull();
    expect(received.messages[4].content).toBe('');
  });
});

describe('response fix: failFastDeterministicErrors', () => {
  /** Fake upstream answering with a workbuddy2api-style wrapped error. */
  function startErrorUpstream(
    status: number,
    body: string,
    opts: { delayWrites?: boolean } = {},
  ): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
    return new Promise((resolve) => {
      const server = createServer((_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        if (opts.delayWrites && body.length > 1) {
          // Split the body across writes to exercise cross-chunk buffering.
          const mid = Math.floor(body.length / 2);
          res.write(body.slice(0, mid));
          setTimeout(() => res.end(body.slice(mid)), 15);
          return;
        }
        res.end(body);
      });
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as any).port;
        resolve({
          server,
          port,
          close: () => new Promise((r) => server.close(() => r())),
        });
      });
    });
  }

  const wb2apiStyleError = JSON.stringify({
    error: {
      message: 'a message has empty content, please check the conversation history and retry',
      type: 'api_error',
      code: 'no_healthy_account',
      gateway_hint: 'deterministic upstream error (code 11151)',
    },
  });

  async function runAgainst(up: { port: number; close: () => Promise<void> }, enabled: boolean) {
    const config: SanitizerConfig = {
      ...createDefaultConfig(),
      port: 0,
      dashboard: { enabled: false, port: 0 },
      upstreams: { test: { target: `http://127.0.0.1:${up.port}` } },
      rules: [],
      responseFixes: { stripEmptyDeltaFields: false, failFastDeterministicErrors: enabled },
    };
    const running = startServer(config, { configPath: null, quiet: true });
    await waitForListening(running.proxy);
    const proxyPort = (running.proxy.address() as any).port;
    const res = await httpRequestAsync(
      proxyPort,
      { messages: [{ role: 'user', content: 'hi' }] },
      { 'x-zps-provider': 'test' },
    );
    await running.close();
    await up.close();
    return res;
  }

  it('rewrites a 503 wrapping 11151 into a non-retryable 400', async () => {
    const up = await startErrorUpstream(503, wb2apiStyleError);
    const res = await runAgainst(up, true);
    expect(res.status).toBe(400);
    expect(res.headers['x-zps-rewritten-status']).toBe('503');
    // Body forwarded intact so the client sees the real upstream reason.
    const parsed = JSON.parse(res.body);
    expect(parsed.error.message).toContain('a message has empty content');
  });

  it('buffers correctly when the error body arrives across multiple chunks', async () => {
    const up = await startErrorUpstream(502, wb2apiStyleError, { delayWrites: true });
    const res = await runAgainst(up, true);
    expect(res.status).toBe(400);
    expect(res.headers['x-zps-rewritten-status']).toBe('502');
    expect(JSON.parse(res.body).error.code).toBe('no_healthy_account');
  });

  it('passes genuinely transient 5xx errors through verbatim', async () => {
    const transient = JSON.stringify({
      error: {
        message: 'upstream capacity is full (queue.full); retry after a short wait',
        type: 'api_error',
        code: 'upstream_busy',
      },
    });
    const up = await startErrorUpstream(503, transient);
    const res = await runAgainst(up, true);
    expect(res.status).toBe(503);
    expect(res.headers['x-zps-rewritten-status']).toBeUndefined();
    expect(res.body).toBe(transient);
  });

  it('passes 5xx through when the toggle is off', async () => {
    const up = await startErrorUpstream(503, wb2apiStyleError);
    const res = await runAgainst(up, false);
    expect(res.status).toBe(503);
    expect(res.headers['x-zps-rewritten-status']).toBeUndefined();
  });

  it('streams oversized 5xx JSON bodies verbatim without sniffing to a rewrite', async () => {
    // > 64KB: too large to treat as an error payload — must pass through.
    const padding = 'x'.repeat(70 * 1024);
    const oversized = JSON.stringify({
      error: { message: `empty content ${padding}`, type: 'api_error' },
    });
    const up = await startErrorUpstream(503, oversized);
    const res = await runAgainst(up, true);
    expect(res.status).toBe(503);
    expect(res.headers['x-zps-rewritten-status']).toBeUndefined();
    expect(res.body.length).toBe(oversized.length);
  });

  it('never touches 2xx JSON responses', async () => {
    const up = await startErrorUpstream(
      200,
      JSON.stringify({ ok: true, note: 'empty content in a success body' }),
    );
    const res = await runAgainst(up, true);
    expect(res.status).toBe(200);
    expect(res.headers['x-zps-rewritten-status']).toBeUndefined();
    expect(JSON.parse(res.body).ok).toBe(true);
  });
});

describe('single-upstream routing (no client hints required)', () => {
  // Regression test: when exactly one upstream is configured, the proxy must
  // forward to it unconditionally — no x-zps-provider header, no Authorization
  // substring match needed. This matches the standard behavior of http-proxy,
  // nginx, liteLLM, and one-api. Previously the proxy would fall back to a
  // Host-header passthrough and loop back to itself (EADDRNOTAVAIL).
  it('routes to the sole configured upstream without any routing header', async () => {
    let received: any = null;
    await upstreamClose();
    const up = await startEchoUpstream((body) => {
      received = body;
    });
    upstreamPort = up.port;
    upstreamClose = up.close;

    const config: SanitizerConfig = {
      ...createDefaultConfig(),
      port: 0,
      dashboard: { enabled: false, port: 0 },
      upstreams: {
        // Key deliberately does NOT match any header the client sends.
        'some-random-name': { target: `http://127.0.0.1:${upstreamPort}` },
      },
      rules: [],
    };
    const running = startServer(config, { configPath: null, quiet: true });
    await waitForListening(running.proxy);
    const proxyPort = (running.proxy.address() as any).port;

    // No x-zps-provider header, no matching Authorization — just a plain request.
    const res = await httpRequestAsync(proxyPort, {
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(res.status).toBe(200);
    expect(received).not.toBeNull();
    expect(received.messages[0].content).toBe('hello');
    await running.close();
  });
});
