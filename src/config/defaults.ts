import type { SanitizerConfig } from '../types.js';

/**
 * Built-in default ruleset. These cover the specific ZCode injections that
 * trigger third-party WAF false positives observed in the wild — most notably
 * the git status hint `Main branch (you will usually use this for PRs): master`
 * which Tencent Copilot's WAF flags as a prompt-injection pattern.
 *
 * Rules are deliberately conservative: substring matches against system-role
 * content only, no regex.
 */
export const BUILTIN_RULES = [
  {
    id: 'zcode-git-pr-hint',
    description:
      "Neutralize ZCode's injected 'Main branch ... use this for PRs' git hint that Tencent WAF flags as prompt injection.",
    enabled: true,
    scopes: ['system' as const],
    // Match the whole injected sentence; replacement keeps the branch name
    // visible so the model still knows the default branch.
    match: 'Main branch (you will usually use this for PRs):',
    replacement: 'Default git branch:',
  },
  {
    id: 'zcode-git-pr-hint-lowercase',
    description: 'Same hint, lowercase variant used by some ZCode versions.',
    enabled: true,
    scopes: ['system' as const],
    match: 'main branch (you will usually use this for PRs):',
    replacement: 'Default git branch:',
  },
];

export function createDefaultConfig(): SanitizerConfig {
  return {
    port: 18790,
    host: '127.0.0.1',
    dashboard: {
      enabled: true,
      port: 0,
    },
    rules: structuredClone(BUILTIN_RULES),
    upstreams: {},
    maxBodyBytes: 8 * 1024 * 1024,
    verbose: false,
  };
}

export const VERSION = '0.1.1';
