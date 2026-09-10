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
 *   --daemon, -d         Run in background, print banner, exit. (ZPS_DAEMON=1)
 *   --stop               Stop the background daemon.
 *   --version, -v        Print version and exit.
 *   --help, -h           Show help and exit.
 */
import { loadConfig, resolveConfigPath, defaultConfigPath } from './config/loader.js';
import { formatBanner, startServer, waitForListening } from './server.js';
import {
  clearDaemonState,
  isDaemonChild,
  runDaemonParent,
  setupDaemonLogging,
  stopDaemon,
  writeDaemonState,
  type DaemonReply,
} from './daemon.js';
import { VERSION } from './config/defaults.js';

interface ParsedArgs {
  configPath?: string;
  port?: number;
  host?: string;
  verbose?: boolean;
  dashboard?: boolean;
  daemon?: boolean;
  stop?: boolean;
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
      case '--daemon':
      case '-d':
        out.daemon = true;
        break;
      case '--stop':
        out.stop = true;
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
  if (out.verbose === undefined && process.env.ZPS_VERBOSE === '1') out.verbose = true;
  if (out.dashboard === undefined && process.env.ZPS_DASHBOARD === '0') out.dashboard = false;
  if (out.daemon === undefined && process.env.ZPS_DAEMON === '1') out.daemon = true;
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
  -d, --daemon       Run in background; print the banner and exit
  --stop             Stop the background daemon started with --daemon
  -v, --version      Print version
  -h, --help         Show this help

ENVIRONMENT
  ZPS_CONFIG         Config file path
  ZPS_PORT           Listen port
  ZPS_HOST           Bind address
  ZPS_VERBOSE        Set to "1" for verbose logging
  ZPS_DASHBOARD      Set to "0" to disable dashboard
  ZPS_DAEMON         Set to "1" to run as a background daemon

CONFIG SEARCH PATH
  ~/.zcode-prompt-sanitizer/config.yaml   (default)

DAEMON STATE
  ~/.zcode-prompt-sanitizer/zps.log       daemon stdout/stderr
  ~/.zcode-prompt-sanitizer/zps.pid       daemon pidfile (JSON)

EXAMPLE
  # Start with built-in defaults (covers the known Tencent WAF trigger)
  zps

  # Start in the background, then stop it later
  zps --daemon
  zps --stop

  # Start with a custom config
  zps ./my-sanitizer.yaml

Learn more: https://github.com/honlnk/zcode-prompt-sanitizer
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.stop) {
    process.exit(await stopDaemon());
  }

  // Foreground parent of daemon mode: spawn the detached child, relay its
  // startup banner, then exit. The marker env var prevents re-daemonizing.
  if (args.daemon && !isDaemonChild()) {
    const passthrough = process.argv
      .slice(2)
      .filter((a) => a !== '--daemon' && a !== '-d');
    process.exit(await runDaemonParent(process.argv[1]!, passthrough));
  }

  const config = loadConfig(args.configPath);

  // Apply CLI overrides.
  if (args.port !== undefined) config.port = args.port;
  if (args.host) config.host = args.host;
  if (args.verbose) config.verbose = true;
  if (args.dashboard === false) config.dashboard.enabled = false;

  // If no config file was found, fall back to the default home-dir path so that
  // dashboard edits still persist somewhere on the first run.
  const configPath = resolveConfigPath(args.configPath) ?? defaultConfigPath();

  // Daemon child: route console.* through the rotating log stream before
  // anything (like the startup banner) gets logged.
  if (isDaemonChild()) setupDaemonLogging();

  const server = startServer(config, { configPath });

  // Detached daemon child: report readiness (or failure) to the parent over
  // IPC, keep a pidfile for `--stop`, and shut down cleanly on signals.
  if (isDaemonChild()) {
    // process.send() is queued on the IPC channel, so exiting immediately after
    // would lose the message — always wait for the send callback (or a short
    // timeout) before terminating.
    const replyAndExit = (msg: DaemonReply, code: number): void => {
      let done = false;
      const finish = (): void => {
        if (!done) {
          done = true;
          process.exit(code);
        }
      };
      try {
        if (!process.send) return finish();
        process.send(msg, () => finish());
        setTimeout(finish, 500).unref();
      } catch {
        finish();
      }
    };

    const onEarlyError = (err: Error): void => {
      replyAndExit({ ok: false, error: err.message }, 1);
    };
    server.proxy.once('error', onEarlyError);

    try {
      await waitForListening(server.proxy);
    } catch (err) {
      replyAndExit({ ok: false, error: (err as Error).message }, 1);
      return;
    }
    server.proxy.removeListener('error', onEarlyError);

    writeDaemonState({
      pid: process.pid,
      host: config.host,
      port: config.port,
      startedAt: new Date().toISOString(),
    });
    try {
      process.send?.({
        ok: true,
        banner: formatBanner(config),
        pid: process.pid,
        host: config.host,
        port: config.port,
      } satisfies DaemonReply);
    } catch {
      // parent already gone — keep serving anyway
    }

    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      clearDaemonState();
      setTimeout(() => process.exit(0), 2000).unref();
      void server.close().then(() => process.exit(0));
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }
}

main().catch((err) => {
  console.error('Failed to start zcode-prompt-sanitizer:', err);
  // Daemon child: surface config-load failures to the waiting parent too.
  if (isDaemonChild()) {
    try {
      process.send?.({ ok: false, error: (err as Error).message } satisfies DaemonReply);
    } catch {
      // parent already gone
    }
    setTimeout(() => process.exit(1), 300).unref();
    return;
  }
  process.exit(1);
});
