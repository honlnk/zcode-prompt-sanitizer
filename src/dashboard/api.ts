import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import type { SanitizerConfig } from '../types.js';
import { Sanitizer } from '../sanitizer.js';
import { validateRules } from '../config/loader.js';
import { VERSION } from '../config/defaults.js';
import { dashboardHtml } from './html.js';

export interface DashboardApiDeps {
  config: SanitizerConfig;
  sanitizer: Sanitizer;
  startedAt: number;
  /** Persist current config to disk (best-effort). */
  persist?: (config: SanitizerConfig) => void;
}

/**
 * Minimal JSON API used by the dashboard web UI:
 *   GET  /__zps__/api/status   — version, uptime, rules summary, stats
 *   GET  /__zps__/api/rules    — full rules list
 *   PUT  /__zps__/api/rules    — replace the entire ruleset (body: {rules:[]})
 *   POST /__zps__/api/rules    — append a single rule
 *   POST /__zps__/api/rule/:id — toggle/update a rule (body: partial rule)
 *   DELETE /__zps__/api/rule/:id — delete a rule
 *   GET  /__zps__/            — dashboard HTML
 *
 * Returns true if the request was handled, false if it should fall through.
 */
export async function handleDashboardRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DashboardApiDeps,
): Promise<boolean> {
  const url = req.url ?? '/';
  if (!url.startsWith('/__zps__')) return false;

  // HTML page.
  if (url === '/__zps__' || url === '/__zps__/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(dashboardHtml(VERSION));
    return true;
  }

  const api = '/__zps__/api/';
  if (!url.startsWith(api)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return true;
  }

  const path = url.slice(api.length);
  const method = req.method ?? 'GET';

  try {
    if (path === 'status' && method === 'GET') {
      return ok(res, statusPayload(deps));
    }
    if (path === 'rules' && method === 'GET') {
      return ok(res, { rules: deps.config.rules });
    }
    if (path === 'rules' && method === 'PUT') {
      const body = await readJson(req);
      const rules = validateRules(body?.rules, 'dashboard');
      deps.config.rules = rules;
      deps.sanitizer.setRules(rules);
      deps.persist?.(deps.config);
      return ok(res, { rules });
    }
    if (path === 'rules' && method === 'POST') {
      const body = await readJson(req);
      const newRules = validateRules([body], 'dashboard');
      const merged = [...deps.config.rules, ...newRules];
      // validateRules already deduped within the new batch; now check against existing ids.
      const seen = new Set(deps.config.rules.map((r) => r.id));
      for (const r of newRules) {
        if (seen.has(r.id)) throw new Error(`Rule id "${r.id}" already exists`);
        seen.add(r.id);
      }
      deps.config.rules = merged;
      deps.sanitizer.setRules(merged);
      deps.persist?.(deps.config);
      return ok(res, { rules: merged });
    }
    if (path.startsWith('rule/') && (method === 'POST' || method === 'PATCH')) {
      const id = decodeURIComponent(path.slice('rule/'.length));
      const body = await readJson(req);
      const idx = deps.config.rules.findIndex((r) => r.id === id);
      if (idx === -1) return notFound(res, `rule "${id}" not found`);
      const existing = deps.config.rules[idx];
      const candidate = {
        ...existing,
        ...('enabled' in body ? { enabled: Boolean(body.enabled) } : {}),
        ...('match' in body ? { match: String(body.match) } : {}),
        ...('replacement' in body ? { replacement: String(body.replacement) } : {}),
        ...('description' in body ? { description: String(body.description ?? '') } : {}),
        ...('scopes' in body ? { scopes: body.scopes } : {}),
      };
      const validated = validateRules([candidate], 'dashboard')[0]!;
      deps.config.rules[idx] = validated;
      deps.sanitizer.setRules(deps.config.rules);
      deps.persist?.(deps.config);
      return ok(res, { rule: validated });
    }
    if (path.startsWith('rule/') && method === 'DELETE') {
      const id = decodeURIComponent(path.slice('rule/'.length));
      const before = deps.config.rules.length;
      deps.config.rules = deps.config.rules.filter((r) => r.id !== id);
      if (deps.config.rules.length === before) {
        return notFound(res, `rule "${id}" not found`);
      }
      deps.sanitizer.setRules(deps.config.rules);
      deps.persist?.(deps.config);
      return ok(res, { rules: deps.config.rules });
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `no route for ${method} ${path}` }));
    return true;
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: (err as Error).message } }));
    return true;
  }
}

function statusPayload(deps: DashboardApiDeps) {
  const { config, sanitizer, startedAt } = deps;
  const enabled = config.rules.filter((r) => r.enabled).length;
  return {
    version: VERSION,
    uptimeMs: Date.now() - startedAt,
    proxy: { host: config.host, port: config.port },
    dashboard: { enabled: config.dashboard.enabled, port: config.dashboard.port || config.port },
    rules: { total: config.rules.length, enabled },
    stats: sanitizer.getStats(),
  };
}

function ok(res: ServerResponse, body: unknown): boolean {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

function notFound(res: ServerResponse, msg: string): boolean {
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: msg }));
  return true;
}

async function readJson(req: IncomingMessage): Promise<any> {
  const buf = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  if (buf.length === 0) return {};
  return JSON.parse(buf.toString('utf8'));
}
