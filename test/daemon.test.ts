import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearDaemonState,
  daemonLogPath,
  readDaemonState,
  rotateDaemonLogIfNeeded,
  runDaemonParent,
  setupDaemonLogging,
  stopDaemon,
  writeDaemonState,
} from '../src/daemon.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE = join(here, 'fixtures', 'daemon-child.mjs');

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'zps-daemon-test-'));
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = savedHome;
  delete process.env.FIXTURE_PORT;
  delete process.env.FIXTURE_PIDFILE;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function silenceConsole(): { logs: string[]; writes: string[] } {
  const logs: string[] = [];
  const writes: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  return { logs, writes };
}

async function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolvePromise(port));
      } else {
        reject(new Error('no address'));
      }
    });
  });
}

describe('daemon state (pidfile)', () => {
  it('round-trips state and clears it', () => {
    expect(readDaemonState()).toBeNull();
    const state = {
      pid: 12345,
      host: '127.0.0.1',
      port: 18790,
      startedAt: '2026-09-10T00:00:00.000Z',
    };
    writeDaemonState(state);
    expect(readDaemonState()).toEqual(state);
    clearDaemonState();
    expect(readDaemonState()).toBeNull();
  });

  it('returns null on a corrupt pidfile', () => {
    writeDaemonState({ pid: 1, host: 'h', port: 1, startedAt: 'x' });
    writeFileSync(join(home, '.zcode-prompt-sanitizer', 'zps.pid'), 'not json');
    expect(readDaemonState()).toBeNull();
  });

  it('puts the log file under the state dir', () => {
    expect(daemonLogPath()).toBe(join(home, '.zcode-prompt-sanitizer', 'zps.log'));
  });
});

describe('stopDaemon', () => {
  it('reports no instance when no pidfile exists', async () => {
    const { logs } = silenceConsole();
    expect(await stopDaemon()).toBe(0);
    expect(logs.join('\n')).toContain('没有运行中的后台实例');
  });

  it('cleans up a stale pidfile', async () => {
    const { logs } = silenceConsole();
    // 2^30 exceeds every platform's pid_max, so it can never be alive.
    writeDaemonState({ pid: 2 ** 30, host: 'h', port: 1, startedAt: 'x' });
    expect(await stopDaemon()).toBe(0);
    expect(logs.join('\n')).toContain('清理了残留的 pidfile');
    expect(readDaemonState()).toBeNull();
  });

  it('SIGTERMs a live process and clears the pidfile', async () => {
    const { logs } = silenceConsole();
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    writeDaemonState({
      pid: sleeper.pid!,
      host: '127.0.0.1',
      port: 18790,
      startedAt: new Date().toISOString(),
    });

    expect(await stopDaemon()).toBe(0);
    expect(readDaemonState()).toBeNull();
    expect(logs.join('\n')).toContain('zps stopped');
  });
});

describe('log rotation', () => {
  const stateDir = () => join(home, '.zcode-prompt-sanitizer');
  const logFile = () => join(stateDir(), 'zps.log');
  const rotatedFile = () => join(stateDir(), 'zps.log.1');

  it('does nothing when the log is missing or under the cap', () => {
    expect(rotateDaemonLogIfNeeded(100)).toBe(false);
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(logFile(), 'small');
    expect(rotateDaemonLogIfNeeded(100)).toBe(false);
    expect(readFileSync(logFile(), 'utf8')).toBe('small');
    expect(existsSync(rotatedFile())).toBe(false);
  });

  it('rotates an oversized log and replaces the previous generation', () => {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(logFile(), 'x'.repeat(200));

    expect(rotateDaemonLogIfNeeded(100)).toBe(true);
    expect(existsSync(logFile())).toBe(false); // parent reopens it fresh
    expect(readFileSync(rotatedFile(), 'utf8')).toBe('x'.repeat(200));

    // Second rotation overwrites .1 instead of piling up generations.
    writeFileSync(logFile(), 'y'.repeat(200));
    expect(rotateDaemonLogIfNeeded(100)).toBe(true);
    expect(readFileSync(rotatedFile(), 'utf8')).toBe('y'.repeat(200));
  });

  it('setupDaemonLogging captures console output and rotates mid-run', async () => {
    const logging = setupDaemonLogging({ maxBytes: 64, checkIntervalMs: 20 });
    try {
      for (let i = 0; i < 10; i++) console.log('request log line '.repeat(4));

      // Poll until the interval-driven rotation produces zps.log.1. The
      // deadline stays well under the test timeout so `finally` always runs
      // and the swapped console is restored before vitest could abort us.
      const deadline = Date.now() + 2000;
      while (!existsSync(rotatedFile()) && Date.now() < deadline) {
        console.log('more output to cross the cap');
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(existsSync(rotatedFile())).toBe(true);
      expect(existsSync(logFile())).toBe(true); // reopened for new writes
    } finally {
      logging.restore();
    }
  }, 10000);

  it('setupDaemonLogging restore() puts the original console back', () => {
    const before = globalThis.console;
    const logging = setupDaemonLogging({ maxBytes: 1024 });
    expect(globalThis.console).not.toBe(before);
    logging.restore();
    expect(globalThis.console).toBe(before);
  });
});

describe('runDaemonParent', () => {
  it('spawns the child detached, prints its banner, and leaves it running', async () => {
    const { logs, writes } = silenceConsole();
    const pidFile = join(home, 'fixture.pid');
    const port = await freePort();
    // runDaemonParent passes process.env through to the child; the fixture
    // reads its port and pidfile location from there.
    process.env.FIXTURE_PORT = String(port);
    process.env.FIXTURE_PIDFILE = pidFile;

    const code = await runDaemonParent(FIXTURE, []);
    expect(code).toBe(0);
    expect(writes.join('')).toContain('fixture banner');
    expect(logs.join('\n')).toContain('Daemon');

    // The detached child keeps serving after the parent returned.
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('fixture ok');

    process.kill(pid, 'SIGKILL');
  }, 30000);

  it('short-circuits when a live instance is already recorded', async () => {
    const { logs } = silenceConsole();
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    writeDaemonState({
      pid: sleeper.pid!,
      host: '127.0.0.1',
      port: 18790,
      startedAt: new Date().toISOString(),
    });

    expect(await runDaemonParent(FIXTURE, [])).toBe(0);
    expect(logs.join('\n')).toContain('已在后台运行');

    sleeper.kill('SIGKILL');
  });
});
