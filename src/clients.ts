import { existsSync } from "fs";
import { join } from "path";

// Client profiles (#20): the mitm capture core is client-agnostic — TLS
// interception + the combined CA bundle (#17) work for any CLI that honors
// HTTPS_PROXY and the standard cert env vars, which Rust/Go/Node clients do.
// What actually differs per client is only how to find the binary. Claude
// keeps its richer path in cli.ts (native/node detection, base-url mode,
// bash-wrapper resolve); every other client runs mitm.
export interface ClientProfile {
  /** Selector word on the CLI: `cctrace codex -- ...` */
  name: string;
  /** Executable name for the $PATH fallback. */
  bin: string;
  /** Well-known install locations, tried before $PATH. */
  candidates: (home: string) => string[];
  /** Shown when the binary can't be found. */
  installHint: string;
}

export const CLIENTS: Record<string, ClientProfile> = {
  claude: {
    name: "claude",
    bin: "claude",
    candidates: (home) => [
      join(home, ".claude", "bin", "claude"),
      join(home, ".claude", "local", "claude"),
      join(home, ".local", "bin", "claude"),
      join(home, ".npm-global", "bin", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ],
    installHint: "Install Claude Code or use --claude-path",
  },
  codex: {
    name: "codex",
    bin: "codex",
    candidates: (home) => [
      join(home, ".npm-global", "bin", "codex"),
      join(home, ".local", "bin", "codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    ],
    installHint: "Install the OpenAI Codex CLI (npm i -g @openai/codex) or use --client-path",
  },
  grok: {
    name: "grok",
    bin: "grok",
    candidates: (home) => [
      join(home, ".local", "bin", "grok"),
      join(home, ".npm-global", "bin", "grok"),
      "/opt/homebrew/bin/grok",
      "/usr/local/bin/grok",
    ],
    installHint: "Install the Grok CLI or use --client-path",
  },
};

/** Locate a client binary: explicit override > well-known paths > $PATH. */
export function findClientBinary(profile: ClientProfile, override?: string): string {
  if (override) return override;
  const home = process.env.HOME || "";
  for (const p of profile.candidates(home)) {
    if (existsSync(p)) return p;
  }
  const which = Bun.spawnSync(["which", profile.bin]);
  if (which.exitCode === 0) {
    const found = which.stdout.toString().trim();
    if (found) return found;
  }
  throw new Error(`${profile.name} not found. ${profile.installHint}`);
}
