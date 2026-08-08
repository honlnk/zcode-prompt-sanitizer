/**
 * zcode-prompt-sanitizer — programmatic API.
 *
 * Everything needed to embed the proxy into another tool or test harness.
 */
export { Sanitizer, type RewriteResult } from './sanitizer.js';
export { createProxyServer, type RequestInfo, type ProxyDeps } from './proxy.js';
export { startServer, waitForListening, type RunningServer, type StartOptions } from './server.js';
export { loadConfig, resolveConfigPath, defaultConfigPath, validateRules, ConfigError } from './config/loader.js';
export { persistConfig } from './config/persist.js';
export { createDefaultConfig, BUILTIN_RULES, VERSION } from './config/defaults.js';
export type {
  RewriteRule,
  RewriteScope,
  SanitizerConfig,
  DashboardConfig,
  Upstream,
  UpstreamMap,
  StatsMap,
  RuleStats,
  SanitizerStatus,
} from './types.js';
