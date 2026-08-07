import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request } from 'node:http';
import { startServer, waitForListening } from '../src/server.js';
import { createDefaultConfig } from '../src/config/defaults.js';
import type { SanitizerConfig } from '../src/types.js';

let proxyPort = 0;
let closeFn: () => Promise<void>;

const cfg: SanitizerConfig = {
  ...createDefaultConfig(),
  port: 0,
  dashboard: { enabled: true, port: 0 },
  upstreams: {},
};

function apiCall(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers: Record<string, string> = {};
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    const req = request(
      { host: '127.0.0.1', port: proxyPort, method, path: '/__zps__/api' + path, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

beforeEach(async () => {
  const running = startServer({ ...cfg, rules: cfg.rules.map((r) => ({ ...r })) }, {
    configPath: null,
    quiet: true,
  });
  await waitForListening(running.proxy);
  proxyPort = (running.proxy.address() as any).port;
  closeFn = running.close;
});

afterEach(async () => {
  await closeFn();
});

describe('dashboard API', () => {
  it('GET /status returns version, uptime, rule summary', async () => {
    const res = await apiCall('GET', '/status');
    expect(res.status).toBe(200);
    expect(res.body.version).toBeTruthy();
    expect(res.body.rules.total).toBe(cfg.rules.length);
    expect(res.body.rules.enabled).toBeGreaterThan(0);
  });

  it('GET /rules returns the rules list', async () => {
    const res = await apiCall('GET', '/rules');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rules)).toBe(true);
    expect(res.body.rules.length).toBe(cfg.rules.length);
  });

  it('POST /rules appends a new rule', async () => {
    const res = await apiCall('POST', '/rules', {
      id: 'new1',
      match: 'sensitive',
      replacement: '***',
    });
    expect(res.status).toBe(200);
    expect(res.body.rules.some((r: any) => r.id === 'new1')).toBe(true);
  });

  it('POST /rule/:id updates an existing rule', async () => {
    const firstId = cfg.rules[0]!.id;
    const res = await apiCall('POST', `/rule/${encodeURIComponent(firstId)}`, {
      enabled: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.rule.enabled).toBe(false);
  });

  it('POST /rule/:id returns 404 for unknown id', async () => {
    const res = await apiCall('POST', '/rule/nonexistent', { enabled: false });
    expect(res.status).toBe(404);
  });

  it('DELETE /rule/:id removes a rule', async () => {
    const firstId = cfg.rules[0]!.id;
    const res = await apiCall('DELETE', `/rule/${encodeURIComponent(firstId)}`);
    expect(res.status).toBe(200);
    expect(res.body.rules.some((r: any) => r.id === firstId)).toBe(false);
  });

  it('PUT /rules replaces the entire ruleset', async () => {
    const res = await apiCall('PUT', '/rules', {
      rules: [{ id: 'only', match: 'x', replacement: 'y' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.rules).toHaveLength(1);
    expect(res.body.rules[0].id).toBe('only');
  });

  it('rejects invalid rule payloads with 400', async () => {
    const res = await apiCall('POST', '/rules', { id: 'bad', match: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('GET /__zps__ serves the dashboard HTML', async () => {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: proxyPort, method: 'GET', path: '/__zps__' },
        (r) => {
          const chunks: Buffer[] = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () =>
            resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('<!doctype html>');
    expect(res.body).toContain('zcode-prompt-sanitizer');
  });
});
