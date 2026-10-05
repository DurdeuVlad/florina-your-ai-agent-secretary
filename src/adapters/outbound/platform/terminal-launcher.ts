/**
 * Visible-terminal launcher (issue #294): opens the provider's own
 * sign-in command in a *new, user-visible* terminal window so the
 * interactive login flow happens in the provider's native UI — Florina
 * never brokers, proxies, or captures the credential exchange.
 *
 * Honest contract: `ok: true` is returned only after the terminal
 * process itself spawned (the `spawn` event won the race against
 * `error`). A missing binary (e.g. no `x-terminal-emulator` on a
 * minimal DE) reports `{ ok: false, detail }` with the manual command,
 * so callers surface instructions instead of a silent no-op. Once the
 * terminal exists we can't observe the command inside it — `detail`
 * says exactly what was asked, not that sign-in succeeded.
 */
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export interface TerminalLaunchResult {
  readonly ok: boolean;
  /** What was launched, or why nothing could be. */
  readonly detail: string;
}

export interface TerminalLauncherDeps {
  readonly platform?: NodeJS.Platform;
  /** Injectable for tests — production uses node:child_process.spawn. */
  readonly spawnFn?: typeof spawn;
  /**
   * Injectable for tests — production resolves the command's executable
   * on PATH (`where` on Windows, `which` elsewhere). A terminal window
   * whose payload command doesn't exist only shows the user a raw
   * "not recognized" error, so we refuse before opening anything.
   */
  readonly resolveFn?: (executable: string) => boolean;
  /** Race window for the spawn/error verdict. */
  readonly timeoutMs?: number;
}

/**
 * The executable a payload command starts with: first whitespace token,
 * or the quoted token when the command opens with `"` (spaced paths).
 * Returns null when nothing parseable is present.
 */
function leadingExecutable(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    return end > 1 ? trimmed.slice(1, end) : null;
  }
  return trimmed.split(/\s+/, 1)[0] ?? null;
}

function defaultResolve(executable: string, platform: NodeJS.Platform): boolean {
  // A path the caller already resolved (absolute, or containing a
  // separator) is existence-checked directly — `where`/`which` search
  // PATH only and would lie about a known-good absolute path.
  if (isAbsolute(executable) || executable.includes('/') || executable.includes('\\')) {
    return existsSync(executable);
  }
  const probe = platform === 'win32' ? 'where.exe' : 'which';
  try {
    return spawnSync(probe, [executable], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Wait for the child to declare itself: resolves `true` on the `spawn`
 * event (process exists), `false` on `error` (e.g. ENOENT) or timeout.
 * Handles both sync throws and the async error event.
 */
function spawnSucceeded(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off('spawn', onSpawn);
      child.off('error', onError);
    };
    const onSpawn = (): void => {
      cleanup();
      resolve(true);
    };
    const onError = (): void => {
      cleanup();
      resolve(false);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

/**
 * A child that lost its race is still a live EventEmitter: a late
 * `error` event with no listener throws uncaught (daemon crash), and a
 * late `spawn` can pop a phantom window. Muzzle + release (and kill
 * where a late window is wrong) every losing path.
 */
function muzzleLoser(child: ChildProcess, kill: boolean): void {
  try {
    child.on?.('error', () => {});
    child.unref?.();
    if (kill) child.kill?.('SIGKILL');
  } catch {
    /* already gone or a minimal fake */
  }
}

/**
 * Wait for a short-lived helper (osascript) to declare its verdict:
 * resolves 'ok' on exit code 0, 'fail' on nonzero exit or error, and
 * 'timeout' when the race window lapses. On macOS a timeout is *not*
 * proof of failure — a pending automation-permission (TCC) prompt can
 * hold osascript open while still delivering Terminal later — so the
 * caller reports the timeout as requested-but-unverified, not failure.
 */
function exitSucceeded(child: ChildProcess, timeoutMs: number): Promise<'ok' | 'fail' | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve('timeout');
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      resolve(code === 0 ? 'ok' : 'fail');
    };
    const onError = (): void => {
      cleanup();
      resolve('fail');
    };
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

/**
 * Launch `command` in a new visible terminal window.
 *
 * - Windows: `start "" cmd /k <command>` — a fresh console window that
 *   stays open so OAuth prompts/errors are visible.
 * - macOS: Terminal.app via AppleScript `do script`; success requires
 *   the osascript process to exit 0 — a mere spawn says nothing (a TCC
 *   denial exits nonzero; a pending permission prompt may time out
 *   while still delivering).
 * - Linux: `x-terminal-emulator` when present (the common freedesktop
 *   abstraction); no terminal binary found → `ok: false`.
 */
export async function launchVisibleTerminal(
  command: string,
  deps: TerminalLauncherDeps = {},
): Promise<TerminalLaunchResult> {
  const platform = deps.platform ?? process.platform;
  const run = deps.spawnFn ?? spawn;
  const resolve = deps.resolveFn ?? ((exe: string): boolean => defaultResolve(exe, platform));
  const timeoutMs = deps.timeoutMs ?? 2000;
  const options: SpawnOptions = { detached: true, stdio: 'ignore', windowsHide: false };

  // Preflight: a terminal whose payload command isn't on PATH opens a
  // window that only prints "not recognized" — refuse honestly instead
  // of presenting a failure we authored as progress.
  const exe = leadingExecutable(command);
  if (exe !== null && !resolve(exe)) {
    return {
      ok: false,
      detail:
        `\`${exe}\` isn't installed or isn't on PATH — install it first ` +
        `(see the provider's own docs), then run \`${command}\` yourself`,
    };
  }

  let child: ChildProcess;
  let launchedDetail: string;
  try {
    if (platform === 'win32') {
      // `start` needs a quoted window title before the command; `cmd /k`
      // keeps the window open so the user can complete and read the flow.
      child = run('cmd.exe', ['/d', '/s', '/c', 'start', '""', 'cmd.exe', '/k', command], options);
      launchedDetail = `opened a terminal running \`${command}\``;
    } else if (platform === 'darwin') {
      child = run(
        'osascript',
        [
          '-e',
          'tell application "Terminal" to activate',
          '-e',
          `tell application "Terminal" to do script "${command.replace(/"/g, '\\"')}"`,
        ],
        options,
      );
      launchedDetail = `opened Terminal running \`${command}\``;
    } else {
      // Linux/other: try the common terminal launchers in order —
      // x-terminal-emulator is the freedesktop abstraction but plenty of
      // DEs ship only their own binary. Each candidate is a real spawn
      // attempt so a missing binary falls through to the next.
      const candidates: Array<[string, string[]]> = [
        ['x-terminal-emulator', ['-e', 'sh', '-c', `${command}; exec $SHELL`]],
        ['gnome-terminal', ['--', 'sh', '-c', `${command}; exec $SHELL`]],
        ['konsole', ['-e', 'sh', '-c', `${command}; exec $SHELL`]],
        ['xterm', ['-e', 'sh', '-c', `${command}; exec $SHELL`]],
      ];
      for (const [bin, args] of candidates) {
        try {
          const attempt = run(bin, args, options);
          if (await spawnSucceeded(attempt, timeoutMs)) {
            attempt.unref();
            return { ok: true, detail: `opened a terminal running \`${command}\`` };
          }
          // The attempt lost the race (error or timeout) — a late
          // `error` event with no listener crashes the daemon and a
          // late `spawn` pops a phantom terminal beside the next
          // candidate's. Muzzle, release, kill.
          muzzleLoser(attempt, true);
        } catch {
          // missing binary — try the next candidate
        }
      }
      return {
        ok: false,
        detail: `no terminal could be opened on this machine — run \`${command}\` yourself`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      detail:
        `couldn't open a terminal (${err instanceof Error ? err.message : String(err)})` +
        ` — run \`${command}\` yourself`,
    };
  }

  // macOS verdict comes from osascript's exit status: spawning the
  // interpreter proves nothing about the AppleScript result.
  if (platform === 'darwin') {
    const verdict = await exitSucceeded(child, timeoutMs);
    if (verdict === 'fail') {
      muzzleLoser(child, true);
      return {
        ok: false,
        detail:
          `couldn't open Terminal — macOS may have blocked the automation ` +
          `(Privacy & Security → Automation) — run \`${command}\` yourself`,
      };
    }
    if (verdict === 'timeout') {
      // Probably a pending permission dialog — the window can still
      // appear after we answer: keep the child alive but muzzle a late
      // 'error'. Report the ask, not a claim.
      muzzleLoser(child, false);
      return {
        ok: true,
        detail: `asked macOS to open Terminal running \`${command}\` — if a permission prompt appears, allow it`,
      };
    }
    child.unref();
    return { ok: true, detail: launchedDetail };
  }

  const spawned = await spawnSucceeded(child, timeoutMs);
  if (!spawned) {
    muzzleLoser(child, true);
    return {
      ok: false,
      detail: `no terminal could be opened on this machine — run \`${command}\` yourself`,
    };
  }
  child.unref();
  return { ok: true, detail: launchedDetail };
}
