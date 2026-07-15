import { existsSync } from "fs";
import { claude } from "./claude";
import { codex } from "./codex";
import { grok } from "./grok";
import type { ClientPlugin, ClientWire } from "./types";

export type { ClientPlugin, ClientProfile, ClientWire } from "./types";

export const CLIENTS: Record<string, ClientPlugin> = { claude, codex, grok };

/**
 * The merged per-client wire tables, JSON-safe: embedded into the web UI
 * page as a constant (like META) and passed to categorizeUrl in Node.
 */
export function wireTables(): Record<string, ClientWire> {
  const out: Record<string, ClientWire> = {};
  for (const [name, p] of Object.entries(CLIENTS)) out[name] = p.wire;
  return out;
}

/** Locate a client binary: explicit override > well-known paths > $PATH. */
export function findClientBinary(
  profile: Pick<ClientPlugin, "name" | "bin" | "candidates" | "installHint">,
  override?: string,
): string {
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
