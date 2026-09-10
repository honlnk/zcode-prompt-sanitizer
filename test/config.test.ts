import { describe, it, expect } from 'vitest';
import { validateRules, ConfigError, loadConfig } from '../src/config/loader.js';
import { createDefaultConfig, BUILTIN_RULES } from '../src/config/defaults.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('validateRules', () => {
  it('accepts a valid rule and fills defaults', () => {
    const rules = validateRules([{ id: 'x', match: 'foo', replacement: 'bar' }]);
    expect(rules[0]).toMatchObject({
      id: 'x',
      match: 'foo',
      replacement: 'bar',
      enabled: true,
      scopes: ['system'],
    });
    expect(rules[0].description).toBeUndefined();
  });

  it('rejects empty / missing match', () => {
    expect(() => validateRules([{ id: 'x', match: '' }])).toThrow(ConfigError);
    expect(() => validateRules([{ id: 'x' }])).toThrow(ConfigError);
  });

  it('rejects empty / missing id', () => {
    expect(() => validateRules([{ id: '', match: 'foo' }])).toThrow(ConfigError);
    expect(() => validateRules([{ match: 'foo' }])).toThrow(ConfigError);
  });

  it('rejects duplicate ids', () => {
    expect(() =>
      validateRules([
        { id: 'dup', match: 'a', replacement: 'b' },
        { id: 'dup', match: 'c', replacement: 'd' },
      ]),
    ).toThrow(/Duplicate rule id/);
  });

  it('rejects invalid scopes', () => {
    expect(() =>
      validateRules([{ id: 'x', match: 'a', scopes: ['developer'] }]),
    ).toThrow(/invalid scope/);
  });
});

describe('loadConfig', () => {
  it('returns defaults when no config file exists', () => {
    const cfg = createDefaultConfig();
    expect(cfg.port).toBe(18790);
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.rules).toHaveLength(BUILTIN_RULES.length);
  });

  it('treats an empty config file as defaults instead of crashing', () => {
    // Compose docs suggest putting a config at ./config.yaml — a `touch`ed
    // placeholder must not take the container down.
    const dir = mkdtempSync(join(tmpdir(), 'zps-'));
    const file = join(dir, 'empty.yaml');
    writeFileSync(file, '', 'utf8');
    const cfg = loadConfig(file);
    expect(cfg.port).toBe(18790);
    expect(cfg.rules).toHaveLength(BUILTIN_RULES.length);
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads a YAML config and merges over defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zps-'));
    const file = join(dir, 'sanitizer.config.yaml');
    writeFileSync(
      file,
      `port: 9999
rules:
  - id: custom
    match: hello
    replacement: hi
upstreams:
  workbuddy:
    target: https://example.com
    headers:
      x-foo: bar
`,
      'utf8',
    );
    const cfg = loadConfig(file);
    expect(cfg.port).toBe(9999);
    expect(cfg.rules).toHaveLength(1);
    expect(cfg.rules[0]!.id).toBe('custom');
    expect(cfg.upstreams.workbuddy.target).toBe('https://example.com');
    expect(cfg.upstreams.workbuddy.headers?.['x-foo']).toBe('bar');
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads a JSON config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zps-'));
    const file = join(dir, 'sanitizer.config.json');
    writeFileSync(
      file,
      JSON.stringify({ port: 1234, rules: [{ id: 'j', match: 'x', replacement: 'y' }] }),
      'utf8',
    );
    const cfg = loadConfig(file);
    expect(cfg.port).toBe(1234);
    expect(cfg.rules[0]!.id).toBe('j');
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws on malformed YAML', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zps-'));
    const file = join(dir, 'sanitizer.config.yaml');
    writeFileSync(file, 'port: [unterminated', 'utf8');
    expect(() => loadConfig(file)).toThrow(ConfigError);
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws on invalid port type', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zps-'));
    const file = join(dir, 'sanitizer.config.yaml');
    writeFileSync(file, 'port: "not-a-number"', 'utf8');
    expect(() => loadConfig(file)).toThrow(ConfigError);
    rmSync(dir, { recursive: true, force: true });
  });
});
