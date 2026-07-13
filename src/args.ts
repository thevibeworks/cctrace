import { parseArgs } from "util";

// CLI argument handling, split from cli.ts so it stays a pure, testable unit.
//
// Contract (docker/kubectl style):
//   cctrace [OPTIONS] [-- CLAUDE_ARGS...]
// Everything after the FIRST "--" is passed to the Claude CLI verbatim (any
// later "--" included). cctrace's own options are parsed strictly: an unknown
// flag or stray positional is an error with a hint, never silently swallowed.

export const CLI_OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
  "no-update-check": { type: "boolean" },
  static: { type: "boolean", short: "s" },
  mode: { type: "string" }, // auto | mitm | base-url | node
  "messages-only": { type: "boolean" },
  "no-open": { type: "boolean" },
  "print-ca": { type: "boolean" },
  log: { type: "string" },
  dir: { type: "string" },
  port: { type: "string", short: "p" },
  "claude-path": { type: "string" },
  "client-path": { type: "string" }, // generic form for codex/grok profiles

  "data-dir": { type: "string" },
  "cache-dir": { type: "string" }, // legacy alias for --data-dir (pre-0.6)
  fresh: { type: "boolean" },
  with: { type: "string", multiple: true },
} as const;

/** A user-facing usage error: print the message and exit, no stack trace. */
export class CliUsageError extends Error {}

/** Split argv at the first "--": cctrace's own args before, Claude's after. */
export function splitArgv(argv: string[]): { own: string[]; claudeArgs: string[] } {
  const i = argv.indexOf("--");
  return i === -1
    ? { own: argv, claudeArgs: [] }
    : { own: argv.slice(0, i), claudeArgs: argv.slice(i + 1) };
}

export function parseCliArgs(argv: string[]) {
  const { own, claudeArgs } = splitArgv(argv);
  try {
    const { values } = parseArgs({
      args: own,
      options: CLI_OPTIONS,
      allowPositionals: false,
      strict: true,
    });
    return { values, claudeArgs };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const token = /'([^']+)'/.exec(e.message || "")?.[1];
    if (e.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" && token) {
      throw new CliUsageError(
        `unknown option "${token}"\n` +
          `  cctrace options:  cctrace --help\n` +
          `  to pass it to Claude, put it after "--":  cctrace -- ${token}`,
      );
    }
    if (e.code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL" && token) {
      throw new CliUsageError(
        `unexpected argument "${token}"\n` +
          `  to pass it to Claude, put it after "--":  cctrace -- ${token}`,
      );
    }
    // e.g. missing value for a string option
    throw new CliUsageError(`${e.message || String(err)}\n  see: cctrace --help`);
  }
}
