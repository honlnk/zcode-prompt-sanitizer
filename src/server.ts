import type { Server } from 'node:http';
import type { SanitizerConfig } from './types.js';
import { Sanitizer } from './sanitizer.js';
import { createProxyServer, type RequestInfo } from './proxy.js';
import { handleDashboardRoute } from './dashboard/api.js';
import { VERSION } from './config/defaults.js';
import { persistConfig } from './config/persist.js';

export interface StartOptions {
  /** Path the config was loaded from (for persistence). */
  configPath: string | null;
  /** Silence the startup banner. */
  quiet?: boolean;
}

export interface RunningServer {
  proxy: Server;
  sanitizer: Sanitizer;
  config: SanitizerConfig;
  close(): Promise<void>;
}

/**
 * Build and start the proxy (+ dashboard) server. Returns once the server is
 * listening. The dashboard is served from the same proxy port under the
 * /__zps__ prefix unless a separate dashboard port is configured.
 */
export function startServer(
  config: SanitizerConfig,
  opts: StartOptions,
): RunningServer {
  const sanitizer = new Sanitizer(config.rules);
  const startedAt = Date.now();

  const onRequest = (info: RequestInfo) => {
    if (!config.verbose) return;
    const flag = info.changed ? `[rewrote: ${info.firedRuleIds.join(',')}]` : '[passthrough]';
    console.log(
      `${new Date().toISOString()} ${info.method} ${info.url} → ${info.statusCode ?? '???'} ${flag} ${info.durationMs}ms`,
    );
  };

  // Wrap the proxy server so dashboard routes are intercepted first.
  const baseProxy = createProxyServer({ config, sanitizer, onRequest });
  const dashboardEnabled = config.dashboard.enabled;

  const proxyServer = composeWithDashboard(baseProxy, {
    config,
    sanitizer,
    startedAt,
    persist: (c) => persistConfig(c, opts.configPath),
  });

  // `listening` is emitted synchronously after listen() on the next tick.
  // We attach a one-shot handler so callers that read .address() right after
  // startServer returns work reliably (the event loop has flushed by then).
  proxyServer.listen(config.port, config.host, () => {
    if (opts.quiet) return;
    const bind = `http://${config.host}:${config.port}`;
    console.log(`\n  🛡  zcode-prompt-sanitizer v${VERSION}`);
    console.log(`     Proxy      →  ${bind}`);
    if (dashboardEnabled) {
      console.log(`     Dashboard  →  ${bind}/__zps__`);
    }
    const enabled = config.rules.filter((r) => r.enabled).length;
    console.log(`     Rules      →  ${enabled} active / ${config.rules.length} total`);
    if (Object.keys(config.upstreams).length) {
      console.log(`     Upstreams  →  ${Object.keys(config.upstreams).join(', ')}`);
    } else {
      console.log(`     Upstreams  →  none configured (passthrough by Host header)`);
    }
    console.log('');
  });

  return {
    proxy: proxyServer,
    sanitizer,
    config,
    close: () =>
      new Promise((resolve) => {
        proxyServer.close(() => resolve());
      }),
  };
}

/**
 * Wait until the server is actually listening (address is bound). Needed for
 * tests that use ephemeral port 0.
 */
export function waitForListening(server: Server, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start listening in time')), timeoutMs);
    const check = () => {
      if (server.listening) {
        clearTimeout(t);
        resolve();
      } else {
        server.once('listening', () => {
          clearTimeout(t);
          resolve();
        });
      }
    };
    check();
  });
}

/**
 * Wrap a proxy server so that requests to /__zps__* are handled by the
 * dashboard API and everything else falls through to the proxy.
 */
function composeWithDashboard(
  proxy: Server,
  deps: {
    config: SanitizerConfig;
    sanitizer: Sanitizer;
    startedAt: number;
    persist: (c: SanitizerConfig) => void;
  },
): Server {
  if (!deps.config.dashboard.enabled) return proxy;

  // Replace the request listener with one that tries the dashboard first.
  const listeners = proxy.listeners('request');
  proxy.removeAllListeners('request');
  const fallback = listeners[0] as (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => void;

  proxy.on('request', async (req, res) => {
    try {
      const handled = await handleDashboardRoute(req, res, {
        config: deps.config,
        sanitizer: deps.sanitizer,
        startedAt: deps.startedAt,
        persist: deps.persist,
      });
      if (!handled) fallback(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: (err as Error).message } }));
      }
    }
  });

  return proxy;
}
