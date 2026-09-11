import { existsSync } from "fs";
import { claude } from "./claude";
import { codex } from "./codex";
import { grok } from "./grok";
import { kimi } from "./kimi";
import { opencode } from "./opencode";
import type { ClientPlugin, ClientWire } from "./types";

export type { ClientPlugin, ClientProfile, ClientWire } from "./types";

export const CLIENTS: Record<string, ClientPlugin> = { claude, codex, grok, kimi, opencode };

/**
 * The merged per-client wire tables, JSON-safe: embedded into the web UI
 * page as a constant (like META) and passed to categorizeUrl in Node.
 */
export function wireTables(): Record<string, ClientWire> {
  const out: Record<string, ClientWire> = {};
  for (const [name, p] of Object.entries(CLIENTS)) out[name] = p.wire;
  return out;
}

/**
 * The display name for a traced client: the plugin's own `label`, else the
 * id with its first letter capitalized (an unlabeled pre-0.51 trace, or a
 * client this build has never heard of).
 *
 * Pure and self-contained on purpose — both pages inline it beside the
 * embedded `CLIENT_WIRE` tables (`clientLabel(pair.client, CLIENT_WIRE)`),
 * so a run reads as "Kimi Code" in the dashboard, the rail run card and the
 * trace header without any of them keeping a second list of names.
 */
export function clientLabel(name: string, wire?: Record<string, { label?: string }>): string {
  const id = String(name || "claude");
  const known = wire && wire[id] && wire[id].label;
  return known || id.charAt(0).toUpperCase() + id.slice(1);
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
