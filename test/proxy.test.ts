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
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'content-length': payload.length, ...headers },
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

    const res = await httpRequestAsync(proxyPort, {
      messages: [
        {
          role: 'system',
          content: 'Main branch (you will usually use this for PRs): master',
        },
        { role: 'user', content: '你好' },
      ],
    }, { 'x-zps-provider': 'test' });

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
      { messages: [{ role: 'user', content: 'Main branch (you will usually use this for PRs): x' }] },
      { 'x-zps-provider': 'test' },
    );

    expect(received.messages[0].content).toBe(
      'Main branch (you will usually use this for PRs): x',
    );
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
          r.on('end', () => resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
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
                delta: {
                  role: 'assistant',
                  content,
                  reasoning_content: reasoning,
                  function_call: null,
                  refusal: '',
                },
              },
            ],
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
