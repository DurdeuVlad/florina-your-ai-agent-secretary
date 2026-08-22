#!/usr/bin/env node
/**
 * CLI entrypoint for the `secretary` / `asec` binary (DEC-026).
 *
 * Wires subcommands to the local daemon. This is a stub; real commands land
 * in subsequent issues.
 */
export const VERSION = '0.0.1';

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write('secretary — an open-source attention broker for coding agents\n');
    process.stdout.write('Usage: secretary <command> [options]\n');
    return;
  }
  process.stdout.write(`Unknown command: ${args[0]}\n`);
  process.exitCode = 1;
}

main();
