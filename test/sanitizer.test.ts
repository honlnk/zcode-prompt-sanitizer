import { describe, it, expect } from 'vitest';
import { Sanitizer } from '../src/sanitizer.js';
import { createDefaultConfig, BUILTIN_RULES } from '../src/config/defaults.js';
import type { RewriteRule } from '../src/types.js';

describe('Sanitizer', () => {
  const systemRule: RewriteRule = {
    id: 'test-pr-hint',
    enabled: true,
    scopes: ['system'],
    match: 'Main branch (you will usually use this for PRs):',
    replacement: 'Default git branch:',
  };

  it('rewrites the known ZCode git hint in system messages', () => {
    const s = new Sanitizer([systemRule]);
    const body = {
      messages: [
        { role: 'system', content: 'Main branch (you will usually use this for PRs): master' },
        { role: 'user', content: '你好' },
      ],
    };
    const res = s.rewrite(body);
    expect(res.changed).toBe(true);
    expect(res.firedRuleIds).toEqual(['test-pr-hint']);
    expect((body.messages as any)[0].content).toBe('Default git branch: master');
    // User message untouched.
    expect((body.messages as any)[1].content).toBe('你好');
  });

  it('does NOT rewrite the same text in a user message when scope is system-only', () => {
    const s = new Sanitizer([systemRule]);
    const body = {
      messages: [
        { role: 'user', content: 'Main branch (you will usually use this for PRs): master' },
      ],
    };
    const res = s.rewrite(body);
    expect(res.changed).toBe(false);
    expect((body.messages as any)[0].content).toBe(
      'Main branch (you will usually use this for PRs): master',
    );
  });

  it('handles array-form content (vision style)', () => {
    const s = new Sanitizer([systemRule]);
    const body = {
      messages: [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'Main branch (you will usually use this for PRs): master' },
            { type: 'image_url', image_url: { url: 'data:...' } },
          ],
        },
      ],
    };
    const res = s.rewrite(body);
    expect(res.changed).toBe(true);
    expect((body.messages as any)[0].content[0].text).toBe('Default git branch: master');
    // image part untouched
    expect((body.messages as any)[0].content[1].type).toBe('image_url');
  });

  it('replaces all occurrences of a match', () => {
    const s = new Sanitizer([
      { id: 'dup', enabled: true, scopes: ['system'], match: 'AAA', replacement: 'B' },
    ]);
    const body = { messages: [{ role: 'system', content: 'AAA and AAA again AAA' }] };
    s.rewrite(body);
    expect((body.messages as any)[0].content).toBe('B and B again B');
  });

  it('deletes the match when replacement is empty', () => {
    const s = new Sanitizer([
      {
        id: 'del',
        enabled: true,
        scopes: ['system'],
        match: 'SECRET-',
        replacement: '',
      },
    ]);
    const body = { messages: [{ role: 'system', content: 'token: SECRET-1234' }] };
    s.rewrite(body);
    expect((body.messages as any)[0].content).toBe('token: 1234');
  });

  it('skips disabled rules', () => {
    const s = new Sanitizer([{ ...systemRule, enabled: false }]);
    const body = {
      messages: [{ role: 'system', content: 'Main branch (you will usually use this for PRs): x' }],
    };
    const res = s.rewrite(body);
    expect(res.changed).toBe(false);
  });

  it('records match stats per rule', () => {
    const s = new Sanitizer([
      { id: 'r1', enabled: true, scopes: ['system'], match: 'foo', replacement: 'bar' },
    ]);
    s.rewrite({ messages: [{ role: 'system', content: 'foo foo' }] });
    s.rewrite({ messages: [{ role: 'system', content: 'foo' }] });
    const stats = s.getStats();
    expect(stats.r1.matches).toBe(3);
    expect(stats.r1.lastMatchedAt).toBeTruthy();
  });

  it('treats match text literally (no regex interpretation)', () => {
    const s = new Sanitizer([
      {
        id: 'literal',
        enabled: true,
        scopes: ['system'],
        match: '.*',
        replacement: 'STAR',
      },
    ]);
    const body = { messages: [{ role: 'system', content: 'use .* literally' }] };
    s.rewrite(body);
    expect((body.messages as any)[0].content).toBe('use STAR literally');
  });

  it('applies rules in order, chaining replacements', () => {
    const s = new Sanitizer([
      { id: 'a', enabled: true, scopes: ['system'], match: 'foo', replacement: 'bar' },
      { id: 'b', enabled: true, scopes: ['system'], match: 'bar', replacement: 'baz' },
    ]);
    const body = { messages: [{ role: 'system', content: 'foo' }] };
    s.rewrite(body);
    // Rule a turns foo->bar, then rule b turns bar->baz in the same pass.
    expect((body.messages as any)[0].content).toBe('baz');
  });

  it('returns unchanged for bodies without messages', () => {
    const s = new Sanitizer([systemRule]);
    expect(s.rewrite({ foo: 1 }).changed).toBe(false);
    expect(s.rewrite(null).changed).toBe(false);
    expect(s.rewrite('string').changed).toBe(false);
    expect(s.rewrite({ messages: 'not-array' }).changed).toBe(false);
  });

  it('the built-in default ruleset rewrites the known trigger phrase', () => {
    const cfg = createDefaultConfig();
    const s = new Sanitizer(cfg.rules);
    const body = {
      messages: [
        {
          role: 'system',
          content: 'You are in a git repo. Main branch (you will usually use this for PRs): master\n',
        },
        { role: 'user', content: '你好' },
      ],
    };
    const res = s.rewrite(body);
    expect(res.changed).toBe(true);
    expect((body.messages as any)[0].content).toContain('Default git branch: master');
    expect((body.messages as any)[0].content).not.toContain('you will usually use this for PRs');
  });

  it('BUILTIN_RULES target exactly the two known casing variants', () => {
    expect(BUILTIN_RULES).toHaveLength(2);
    expect(BUILTIN_RULES.map((r) => r.match)).toEqual([
      'Main branch (you will usually use this for PRs):',
      'main branch (you will usually use this for PRs):',
    ]);
  });
});
