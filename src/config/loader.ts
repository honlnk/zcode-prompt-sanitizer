import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import type { RewriteRule, RewriteScope, SanitizerConfig } from '../types.js';
import { createDefaultConfig } from './defaults.js';

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

const VALID_SCOPES: ReadonlySet<RriteScope> = new Set<RewriteScope>([
  'system',
  'user',
  'assistant',
  'tool',
]);

// Fix typo-guard alias kept for clarity.
type RriteScope = RewriteScope;

/**
 * Resolve the config path from, in order:
 *   1. explicit `path` argument
 *   2. ZPS_CONFIG env var
 *   3. ~/.zcode-prompt-sanitizer/config.yaml (unified home-dir location)
 * Returns null when no file is found — callers should then use defaults.
 */
export function resolveConfigPath(explicit?: string): string | null {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '~';
  const candidates: string[] = [];
  if (explicit) candidates.push(resolve(explicit));
  if (process.env.ZPS_CONFIG) candidates.push(resolve(process.env.ZPS_CONFIG));
  candidates.push(resolve(home, '.zcode-prompt-sanitizer', 'config.yaml'));

  for (const c of candidates) {
    try {
      readFileSync(c, 'utf8');
      return c;
    } catch {
      // continue
    }
  }
  return null;
}

/**
 * The default config path under the home directory. Used as the fallback when
 * no config exists yet — the dashboard writes rule edits here.
 */
export function defaultConfigPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '~';
  return resolve(home, '.zcode-prompt-sanitizer', 'config.yaml');
}

/**
 * Load and validate configuration, merging onto built-in defaults.
 */
export function loadConfig(path?: string): SanitizerConfig {
  const base = createDefaultConfig();
  const resolved = resolveConfigPath(path);
  if (!resolved) return base;

  let raw: unknown;
  try {
    const text = readFileSync(resolved, 'utf8');
    raw = resolved.endsWith('.json') ? JSON.parse(text) : yaml.load(text);
  } catch (e) {
    throw new ConfigError(
      `Failed to parse config file: ${(e as Error).message}`,
      resolved,
    );
  }

  return mergeConfig(base, raw, resolved);
}

/**
 * Validate a user-supplied rules object (from file or dashboard) and return a
 * clean list. Throws ConfigError on any invalid rule.
 */
export function validateRules(rules: unknown, source?: string): RewriteRule[] {
  if (!Array.isArray(rules)) {
    throw new ConfigError('`rules` must be an array', source);
  }
  const seenIds = new Set<string>();
  const out: RewriteRule[] = [];
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i] as Record<string, unknown>;
    if (!r || typeof r !== 'object') {
      throw new ConfigError(`rules[${i}] must be an object`, source);
    }
    const id = stringifyField(r.id, 'id', i, source);
    if (seenIds.has(id)) {
      throw new ConfigError(`Duplicate rule id "${id}"`, source);
    }
    seenIds.add(id);

    const match = stringifyField(r.match, 'match', i, source);
    if (match.length === 0) {
      throw new ConfigError(`rules[${i}].match must be a non-empty string`, source);
    }
    const replacement =
      typeof r.replacement === 'string' ? r.replacement : '';
    const enabled = r.enabled === undefined ? true : Boolean(r.enabled);
    const scopesRaw = Array.isArray(r.scopes) ? r.scopes : ['system'];
    const scopes: RewriteScope[] = [];
    for (const s of scopesRaw) {
      if (typeof s !== 'string' || !VALID_SCOPES.has(s as RewriteScope)) {
        throw new ConfigError(
          `rules[${i}].scopes contains invalid scope "${String(s)}"`,
          source,
        );
      }
      scopes.push(s as RewriteScope);
    }
    out.push({
      id,
      description: typeof r.description === 'string' ? r.description : undefined,
      enabled,
      scopes,
      match,
      replacement,
    });
  }
  return out;
}

function stringifyField(v: unknown, field: string, i: number, source?: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new ConfigError(
      `rules[${i}].${field} must be a non-empty string`,
      source,
    );
  }
  return v;
}

function mergeConfig(
  base: SanitizerConfig,
  raw: unknown,
  source: string,
): SanitizerConfig {
  const out = structuredClone(base);
  // An empty document (e.g. a `touch`ed placeholder config file) means
  // "use defaults" rather than a parse failure.
  if (raw === null || raw === undefined) return out;
  if (typeof raw !== 'object') {
    throw new ConfigError('Config root must be an object', source);
  }
  const obj = raw as Record<string, unknown>;

  if (obj.port !== undefined) {
    if (typeof obj.port !== 'number' || !Number.isInteger(obj.port)) {
      throw new ConfigError('`port` must be an integer', source);
    }
    out.port = obj.port;
  }
  if (typeof obj.host === 'string') out.host = obj.host;
  if (typeof obj.maxBodyBytes === 'number') out.maxBodyBytes = obj.maxBodyBytes;
  if (typeof obj.verbose === 'boolean') out.verbose = obj.verbose;

  if (obj.dashboard && typeof obj.dashboard === 'object') {
    const d = obj.dashboard as Record<string, unknown>;
    if (typeof d.enabled === 'boolean') out.dashboard.enabled = d.enabled;
    if (typeof d.port === 'number') out.dashboard.port = d.port;
  }

  if (obj.upstreams && typeof obj.upstreams === 'object') {
    const ups: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj.upstreams as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') {
        throw new ConfigError(`upstreams.${k} must be an object`, source);
      }
      const u = v as Record<string, unknown>;
      if (typeof u.target !== 'string') {
        throw new ConfigError(`upstreams.${k}.target must be a string URL`, source);
      }
      ups[k] = {
        target: u.target,
        headers:
          u.headers && typeof u.headers === 'object'
            ? (u.headers as Record<string, string>)
            : undefined,
        changeHost: typeof u.changeHost === 'boolean' ? u.changeHost : undefined,
      };
    }
    out.upstreams = ups as SanitizerConfig['upstreams'];
  }

  if (obj.responseFixes && typeof obj.responseFixes === 'object') {
    const rf = obj.responseFixes as Record<string, unknown>;
    if (typeof rf.stripEmptyDeltaFields === 'boolean') {
      out.responseFixes.stripEmptyDeltaFields = rf.stripEmptyDeltaFields;
    }
  }

  // `rules`, if present, fully replaces the default ruleset.
  if (obj.rules !== undefined) {
    out.rules = validateRules(obj.rules, source);
  }

  return out;
}
