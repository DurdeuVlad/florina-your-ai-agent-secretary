import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

/**
 * Quote one argument for a `cmd.exe /c` command line. Wraps in double
 * quotes when the value is empty or contains whitespace, quotes, or cmd
 * metacharacters; backslash-escapes embedded quotes and doubles any
 * backslash run preceding a quote or the closing quote (MSVCRT rules).
 *
 * Known limitation (shared with cross-spawn): `%VAR%` sequences inside
 * quoted text are still expanded by cmd.exe.
 */
function quoteWinArg(arg: string): string {
  if (arg !== '' && !/[\s"&|<>^()%!]/.test(arg)) return arg;
  const escaped = arg.replace(/(\\*)("|$)/g, (_m, bs: string, tail: string) => {
    const doubled = '\\'.repeat(bs.length * 2);
    return tail === '"' ? `${doubled}\\"` : doubled;
  });
  return `"${escaped}"`;
}

/**
 * Cross-platform `spawn` for globally installed CLI shims.
 *
 * On Windows, npm-style global binaries (`claude`, `gemini`, `codex`, …)
 * are `.cmd`/`.bat` wrappers, which `child_process.spawn` refuses to run
 * directly since the CVE-2024-27980 fix (`EINVAL`). This routes the
 * spawn through `cmd.exe /d /s /c` with each argument quoted so shell
 * metacharacters in argument values cannot break out of the argument.
 * Non-Windows platforms spawn directly.
 */
export function spawnCli(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  if (process.platform !== 'win32') {
    return spawn(command, [...args], options);
  }
  const line = [command, ...args].map(quoteWinArg).join(' ');
  return spawn(process.env['ComSpec'] ?? 'cmd.exe', ['/d', '/s', '/c', line], {
    ...options,
    windowsVerbatimArguments: true,
  });
}
