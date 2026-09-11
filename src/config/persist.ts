import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import yaml from 'js-yaml';
import type { SanitizerConfig } from '../types.js';

/**
 * Persist config to disk in the same format it was loaded from. If the original
 * path had a .json extension, writes JSON; otherwise YAML. Creates the file if
 * needed; never throws in the caller (best-effort).
 */
export function persistConfig(config: SanitizerConfig, path: string | null): void {
  if (!path) return; // no file configured — cannot persist
  try {
    const serializable = {
      port: config.port,
      host: config.host,
      verbose: config.verbose,
      maxBodyBytes: config.maxBodyBytes,
      dashboard: config.dashboard,
      upstreams: config.upstreams,
      responseFixes: config.responseFixes,
      rules: config.rules,
    };
    const text = path.endsWith('.json')
      ? JSON.stringify(serializable, null, 2)
      : yaml.dump(serializable, { lineWidth: 120 });
    if (!existsSync(dirname(path))) {
      mkdirSync(dirname(path), { recursive: true });
    }
    writeFileSync(path, text, 'utf8');
  } catch {
    // Best-effort: dashboard edits are also held in memory.
  }
}
