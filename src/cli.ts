#!/usr/bin/env node
/**
 * zcode-prompt-sanitizer CLI entrypoint.
 *
 * Usage:
 *   zcode-prompt-sanitizer [config]
 *   zps [config]
 *
 * Options (env vars in parens):
 *   --config <path>      Config file path.            (ZPS_CONFIG)
 *   --port <n>           Override listen port.        (ZPS_PORT)
 *   --host <addr>        Override bind host.          (ZPS_HOST)
 *   --verbose            Verbose request logging.     (ZPS_VERBOSE=1)
 *   --no-dashboard       Disable the dashboard UI.    (ZPS_DASHBOARD=0)
 *   --version, -v        Print version and exit.
 *   --help, -h           Show help and exit.
 */
import { loadConfig, resolveConfigPath, defaultConfigPath } from './config/loader.js';
import { startServer } from './server.js';
import { VERSION } from './config/defaults.js';

interface ParsedArgs {
  configPath?: string;
  port?: number;
  host?: string;
  verbose?: boolean;
  dashboard?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '--config':
        out.configPath = argv[++i];
        break;
      case '--port':
        out.port = Number(argv[++i]);
        break;
      case '--host':
        out.host = argv[++i];
        break;
      case '--verbose':
        out.verbose = true;
        break;
      case '--no-dashboard':
        out.dashboard = false;
        break;
      case '--version':
      case '-v':
        console.log(VERSION);
        process.exit(0);
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        if (!a.startsWith('-') && !out.configPath) {
          out.configPath = a;
        }
    }
  }
  // Env var fallbacks.
  if (!out.configPath && process.env.ZPS_CONFIG) out.configPath = process.env.ZPS_CONFIG;
  if (out.port === undefined && process.env.ZPS_PORT) out.port = Number(process.env.ZPS_PORT);
  if (!out.host && process.env.ZPS_HOST) out.host = process.env.ZPS_HOST;
  if (out.verbose === undefined && process.env.ZPS_VERBOSE) out.verbose = true;
  if (out.dashboard === undefined && process.env.ZPS_DASHBOARD === '0') out.dashboard = false;
  return out;
}

function printHelp(): void {
  console.log(`
zcode-prompt-sanitizer v${VERSION}

Local reverse proxy that sanitizes ZCode-injected prompt fragments before they
reach third-party API providers, preventing WAF false positives.

USAGE
  zps [options] [config-path]
  zcode-prompt-sanitizer [options] [config-path]

OPTIONS
  --config <path>    Path to config file (yaml/yml/json)
  --port <n>         Listen port (default 18790)
  --host <addr>      Bind address (default 127.0.0.1)
  --verbose          Log every proxied request
  --no-dashboard     Disable the /__zps__ dashboard
  -v, --version      Print version
  -h, --help         Show this help

ENVIRONMENT
  ZPS_CONFIG         Config file path
  ZPS_PORT           Listen port
  ZPS_HOST           Bind address
  ZPS_VERBOSE        Set to "1" for verbose logging
  ZPS_DASHBOARD      Set to "0" to disable dashboard

CONFIG SEARCH PATH
  ~/.zcode-prompt-sanitizer/config.yaml   (default)

EXAMPLE
  # Start with built-in defaults (covers the known Tencent WAF trigger)
  zps

  # Start with a custom config
  zps ./my-sanitizer.yaml

Learn more: https://github.com/honlnk/zcode-prompt-sanitizer
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.configPath);

  // Apply CLI overrides.
  if (args.port !== undefined) config.port = args.port;
  if (args.host) config.host = args.host;
  if (args.verbose) config.verbose = true;
  if (args.dashboard === false) config.dashboard.enabled = false;

  // If no config file was found, fall back to the default home-dir path so that
  // dashboard edits still persist somewhere on the first run.
  const configPath = resolveConfigPath(args.configPath) ?? defaultConfigPath();
  startServer(config, { configPath });
}

main().catch((err) => {
  console.error('Failed to start zcode-prompt-sanitizer:', err);
  process.exit(1);
});
