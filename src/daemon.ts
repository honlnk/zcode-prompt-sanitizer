import { spawn } from 'node:child_process';
import { Console } from 'node:console';
import {
  closeSync,
  createWriteStream,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type WriteStream,
} from 'node:fs';
import { resolve } from 'node:path';

/**
 * Daemon mode: `zps --daemon` re-spawns the CLI as a detached background
 * process, waits for it to report "listening" over IPC, echoes the startup
 * banner, and then lets the foreground process exit — so the terminal is free
 * while the proxy keeps running. State lives next to the config file:
 *
 *   ~/.zcode-prompt-sanitizer/zps.log   child stdout/stderr (banner, requests)
 *   ~/.zcode-prompt-sanitizer/zps.log.1 previous generation (rotated at 5 MiB)
 *   ~/.zcode-prompt-sanitizer/zps.pid   JSON {pid, host, port, startedAt}
 */

const CHILD_ENV = 'ZPS_DAEMON_CHILD';

/** True inside the detached child process spawned by runDaemonParent. */
export function isDaemonChild(): boolean {
  return process.env[CHILD_ENV] === '1';
}

function stateDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '~';
  return resolve(home, '.zcode-prompt-sanitizer');
}

export function daemonLogPath(): string {
  return resolve(stateDir(), 'zps.log');
}

function rotatedLogPath(): string {
  return `${daemonLogPath()}.1`;
}

/** Per-generation log cap. Two generations are kept (zps.log + zps.log.1),
 * so the total on-disk footprint stays under ~2× this value. */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Rotate zps.log → zps.log.1 when it exceeds the cap (replacing any previous
 * .1). Called by the parent *before* opening the log fd, so a fresh daemon
 * always starts on a bounded file. Returns true when a rotation happened.
 */
export function rotateDaemonLogIfNeeded(maxBytes = LOG_MAX_BYTES): boolean {
  let size: number;
  try {
    size = statSync(daemonLogPath()).size;
  } catch {
    return false; // no log yet
  }
  if (size <= maxBytes) return false;
  try {
    unlinkSync(rotatedLogPath());
  } catch {
    // no previous generation
  }
  renameSync(daemonLogPath(), rotatedLogPath());
  return true;
}

export interface DaemonLogging {
  /** Restore the original console and stop the rotation timer (for tests). */
  restore(): void;
}

/**
 * Child-side logging: route console.* through an append stream to zps.log and
 * rotate it (zps.log → zps.log.1) once it grows past the cap, re-checking on
 * an interval so a long-running daemon never grows the log unbounded. Stream
 * errors are swallowed — logging must never take the proxy down.
 */
export function setupDaemonLogging(
  opts: { maxBytes?: number; checkIntervalMs?: number } = {},
): DaemonLogging {
  const maxBytes = opts.maxBytes ?? LOG_MAX_BYTES;
  const intervalMs = opts.checkIntervalMs ?? 60 * 60 * 1000;
  const originalConsole = globalThis.console;

  mkdirSync(stateDir(), { recursive: true });
  let stream: WriteStream = createWriteStream(daemonLogPath(), { flags: 'a' });
  const bind = (): void => {
    stream.on('error', () => {});
    globalThis.console = new Console({ stdout: stream, stderr: stream });
  };
  bind();

  const rotate = (): void => {
    let size = 0;
    try {
      size = statSync(daemonLogPath()).size;
    } catch {
      return;
    }
    if (size <= maxBytes) return;
    const old = stream;
    // Writes during the few-ms reopen window are dropped — acceptable for a
    // local diagnostic log.
    old.end(() => {
      try {
        renameSync(daemonLogPath(), rotatedLogPath());
      } catch {
        // log vanished underneath us — just reopen
      }
      stream = createWriteStream(daemonLogPath(), { flags: 'a' });
      bind();
    });
  };

  const timer = setInterval(rotate, intervalMs);
  timer.unref();

  return {
    restore() {
      clearInterval(timer);
      globalThis.console = originalConsole;
      stream.end();
    },
  };
}

function daemonPidPath(): string {
  return resolve(stateDir(), 'zps.pid');
}

export interface DaemonState {
  pid: number;
  host: string;
  port: number;
  startedAt: string;
}

export function readDaemonState(): DaemonState | null {
  try {
    const raw = JSON.parse(readFileSync(daemonPidPath(), 'utf8')) as DaemonState;
    return typeof raw?.pid === 'number' ? raw : null;
  } catch {
    return null;
  }
}

export function writeDaemonState(state: DaemonState): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(daemonPidPath(), JSON.stringify(state));
}

export function clearDaemonState(): void {
  try {
    unlinkSync(daemonPidPath());
  } catch {
    // already gone
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Message the daemon child sends over IPC once listen() settles. */
export interface DaemonReply {
  ok: boolean;
  banner?: string;
  error?: string;
  pid?: number;
  host?: string;
  port?: number;
}

/**
 * Parent side of `--daemon`: spawn the detached child, wait for its readiness
 * IPC message, print the banner, and return the exit code the foreground
 * process should use. The child keeps running after we exit.
 */
export async function runDaemonParent(
  cliScript: string,
  cliArgs: string[],
): Promise<number> {
  const existing = readDaemonState();
  if (existing && pidAlive(existing.pid)) {
    const bind = `http://${existing.host}:${existing.port}`;
    console.log(`\n  🛡  zcode-prompt-sanitizer 已在后台运行（pid ${existing.pid}）`);
    console.log(`     Proxy      →  ${bind}`);
    console.log(`     Dashboard  →  ${bind}/__zps__`);
    console.log(`     停止       →  zps --stop`);
    console.log(`     日志       →  ${daemonLogPath()}\n`);
    return 0;
  }
  if (existing) clearDaemonState(); // stale pidfile from a dead instance

  mkdirSync(stateDir(), { recursive: true });
  rotateDaemonLogIfNeeded(); // start each daemon on a bounded log file
  const logFd = openSync(daemonLogPath(), 'a');

  const child = spawn(process.execPath, [cliScript, ...cliArgs], {
    env: { ...process.env, [CHILD_ENV]: '1' },
    detached: true,
    stdio: ['ignore', logFd, logFd, 'ipc'],
  });

  const code = await new Promise<number>((resolvePromise) => {
    let settled = false;
    const finish = (report: () => void, exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      report();
      resolvePromise(exitCode);
    };

    const timer = setTimeout(() => {
      finish(() => {
        console.error(`\n  ✗ 后台进程启动超时，详情见日志: ${daemonLogPath()}\n`);
      }, 1);
      try {
        child.kill();
      } catch {
        // already gone
      }
    }, 20000);

    child.once('message', (msg: DaemonReply) => {
      if (msg?.ok) {
        finish(() => {
          process.stdout.write(msg.banner ?? '');
          console.log(`     Daemon     →  pid ${msg.pid}（日志: ${daemonLogPath()}）`);
          console.log(`     停止       →  zps --stop\n`);
        }, 0);
      } else {
        finish(() => {
          console.error(`\n  ✗ 后台启动失败: ${msg?.error ?? '未知错误'}`);
          console.error(`     日志: ${daemonLogPath()}\n`);
        }, 1);
      }
    });

    child.once('exit', (exitCode) => {
      finish(() => {
        console.error(
          `\n  ✗ 后台进程提前退出（code ${exitCode ?? '?'}），日志: ${daemonLogPath()}\n`,
        );
      }, exitCode ?? 1);
    });
  });

  // Sever the IPC channel and the handle so the parent can exit immediately.
  child.disconnect();
  child.unref();
  closeSync(logFd);
  return code;
}

/**
 * `--stop`: terminate the daemon started with `--daemon`, via the pidfile.
 * Returns the process exit code.
 */
export async function stopDaemon(): Promise<number> {
  const state = readDaemonState();
  if (!state) {
    console.log('🛡  没有运行中的后台实例（找不到 pidfile）');
    return 0;
  }
  if (!pidAlive(state.pid)) {
    clearDaemonState();
    console.log('🛡  后台实例已经退出（清理了残留的 pidfile）');
    return 0;
  }

  try {
    process.kill(state.pid, 'SIGTERM');
  } catch (err) {
    console.error(`停止失败: ${(err as Error).message}`);
    return 1;
  }

  // Give the child a moment to shut down gracefully (it clears the pidfile
  // itself on the way out). Sleeping via the event loop (not a busy wait) so
  // the runtime can reap the process and pidAlive() turns false.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && pidAlive(state.pid)) {
    await new Promise((r) => setTimeout(r, 100));
  }

  if (pidAlive(state.pid)) {
    console.error(`🛡  进程 ${state.pid} 未在 3 秒内退出，可手动执行: kill -9 ${state.pid}`);
    return 1;
  }
  clearDaemonState();
  console.log('🛡  zps stopped');
  return 0;
}
