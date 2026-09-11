/**
 * Core type definitions for zcode-prompt-sanitizer.
 */

/**
 * A single rewrite rule. Applied to `role === "system"` message content by
 * default. Matching is plain substring search; replacement is a literal string
 * substitution (no regex) to keep behavior predictable and safe.
 */
export interface RewriteRule {
  /** Stable, human-readable identifier. Must be unique within a ruleset. */
  id: string;
  /** Optional description shown in the dashboard. */
  description?: string;
  /** Whether the rule is active. Inactive rules are skipped. */
  enabled: boolean;
  /**
   * Which message roles to apply the rule to. Defaults to system messages,
   * which is where ZCode injects git status and similar context.
   */
  scopes: RewriteScope[];
  /** Exact substring to search for. */
  match: string;
  /** Literal replacement string. Use empty string to delete the match. */
  replacement: string;
}

export type RewriteScope = 'system' | 'user' | 'assistant' | 'tool';

/**
 * How a rule matched: aggregate counters and recent sample.
 */
export interface RuleStats {
  matches: number;
  lastMatchedAt: string | null;
}

/**
 * Runtime statistics aggregated by rule id.
 */
export type StatsMap = Record<string, RuleStats>;

/**
 * Sanitizer proxy configuration.
 */
export interface SanitizerConfig {
  /** Port the local proxy listens on. */
  port: number;
  /** Address to bind. Always 127.0.0.1 for a local-only tool. */
  host: string;
  /** Whether the management dashboard / API is served. */
  dashboard: DashboardConfig;
  /** Ordered list of rewrite rules. */
  rules: RewriteRule[];
  /**
   * Upstream overrides per provider key. The key is matched case-insensitively
   * against the incoming `x-zps-provider` header or, absent that, inferred from
   * the Authorization header / request path. If no override matches, the proxy
   * forwards to the host in the incoming Host header.
   */
  upstreams: UpstreamMap;
  /** Request body size limit in bytes for the sanitizer middleware. */
  maxBodyBytes: number;
  /** Enable verbose request logging to stdout. */
  verbose: boolean;
  /** Response-side normalizations, each independently toggleable. */
  responseFixes: ResponseFixesConfig;
}

export interface ResponseFixesConfig {
  /**
   * Strip empty-string placeholder fields from SSE chat-chunk deltas
   * (`content: ""`, `reasoning_content: ""`, and the empty
   * `function_call: {name:"",arguments:""}` placeholder). Some providers
   * (Tencent hunyuan via copilot.tencent.com) send these on every chunk;
   * clients like ZCode treat each empty `content` delta as the end of the
   * current reasoning block, splitting one thinking phase into dozens of
   * "thinking" UI segments.
   */
  stripEmptyDeltaFields: boolean;
}

export interface DashboardConfig {
  enabled: boolean;
  /** Port for the management API + web UI. 0 = serve on the same proxy port. */
  port: number;
}

export type UpstreamMap = Record<string, Upstream>;

export interface Upstream {
  /** Target base URL, e.g. https://copilot.tencent.com */
  target: string;
  /**
   * Optional header overrides applied on every proxied request. Useful for
   * injecting provider-specific keys when ZCode only knows the local proxy.
   */
  headers?: Record<string, string>;
  /** Rewrite the Host header to the upstream host. Default true. */
  changeHost?: boolean;
}

/**
 * A compact serialization format for API responses.
 */
export interface SanitizerStatus {
  version: string;
  uptimeMs: number;
  proxy: { host: string; port: number };
  dashboard: { enabled: boolean; port: number };
  rules: { total: number; enabled: number };
  stats: StatsMap;
}
