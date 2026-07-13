#!/usr/bin/env bun

import { basename, dirname, join, resolve } from "path";
import { mkdirSync, existsSync, unlinkSync, appendFileSync, writeFileSync } from "fs";
import { spawn, type ChildProcess } from "child_process";
import { createServer, renderSnapshot, verifySnapshot } from "./server";
import { createCapturer, type CaptureMode, type Capturer } from "./capture";
import { isNativeBinary, resolveClaudeBashWrapper } from "./detect";
import { ensureCerts, migrateCaDir } from "./certs";
import { parseCliArgs, CliUsageError } from "./args";
import { loadPriorPairs, loadTraceFiles } from "./history";
import { extractSessionId } from "./summarize";
import { writeView, ViewError } from "./view";
import { registerInstance, listLiveInstances, SCAN_PORTS, DEFAULT_PORT, type InstanceHandle } from "./instances";
import {
  CCTRACE_VERSION, NPM_PACKAGE, readUpdateCache, writeUpdateCache, refreshUpdateCache, availableUpdate,
} from "./version";
import type { PageMeta } from "./ui";
import {
  planClean, applyClean, planMerge, applyMerge, planCompress, applyCompress, human,
} from "./storage";
import { parseArgs } from "util";
import type { TracePair } from "./types";

// Live-UI port: DEFAULT_PORT (9317, avoids Clash/mihomo defaults) lives in
// instances.ts so the discovery sweep and the allocation walk stay one list.

// True when running as a `bun build --compile` standalone binary (sources live
// in the virtual /$bunfs). Matters twice: the on-disk cache can't sit next to
// the (virtual) sources, and bun's CLI quirk below doesn't apply.
const IS_COMPILED = import.meta.path.includes("$bunfs") || import.meta.path.includes("~BUN");

// cctrace [OPTIONS] [-- CLAUDE_ARGS...] — everything after "--" goes to the
// Claude CLI verbatim; unknown flags before it error with a hint (args.ts).
function parseArgvOrExit() {
  try {
    return parseCliArgs(Bun.argv.slice(2));
  } catch (err) {
    if (err instanceof CliUsageError) {
      let msg = err.message;
      // When run through bun's CLI (bunx / bun run / the bun-link shim), bun
      // itself eats a LEADING "--", so `cctrace -- --continue` reaches us as
      // `--continue` and lands here. The compiled binary is immune.
      if (!IS_COMPILED && msg.includes('put it after "--"')) {
        msg += `\n  note: bun run/bunx/bun link eats a leading "--". If you already typed one,` +
          `\n  install the compiled binary (make install) or put a cctrace flag before "--".`;
      }
      console.error(`[cctrace] ${msg}`);
      process.exit(1);
    }
    throw err;
  }
}
// Subcommands (view/clean/merge/compress) bypass the OPTIONS/-- grammar, so
// detect them before the strict parser rejects their positionals.
const RAW_ARGV = Bun.argv.slice(2);
const SUBCOMMANDS = new Set(["view", "clean", "merge", "compress", "ps"]);
const SUBCOMMAND = SUBCOMMANDS.has(RAW_ARGV[0]) ? RAW_ARGV[0] : null;
const { values, claudeArgs } = SUBCOMMAND ? { values: {} as Record<string, never>, claudeArgs: [] } : parseArgvOrExit();

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

function log(msg: string, color = C.reset) {
  console.log(`${color}[cctrace]${C.reset} ${msg}`);
}

const CAPTURE_MODES = ["auto", "mitm", "base-url", "node"] as const;

// ---- update check ----
// The startup path only ever reads the local cache (never the network), and
// the cache refreshes in the background at most once a day — a new release
// is offered on the run after it's seen. Opt out per-run (--no-update-check)
// or permanently (CCTRACE_NO_UPDATE_CHECK=1).
const NO_UPDATE_CHECK = !!values["no-update-check"] || process.env.CCTRACE_NO_UPDATE_CHECK === "1";

/** How this install upgrades: an auto-runnable command, or instructions. */
function upgradeHint(): { cmd: string[] | null; note: string } {
  const p = import.meta.path;
  if (p.includes("node_modules")) {
    return p.includes("/.bun/") || p.includes("\\.bun\\")
      ? { cmd: ["bun", "add", "-g", `${NPM_PACKAGE}@latest`], note: "bun global install" }
      : { cmd: ["npm", "install", "-g", `${NPM_PACKAGE}@latest`], note: "npm global install" };
  }
  if (IS_COMPILED) {
    return { cmd: null, note: `compiled binary — upgrade with: git pull && make install (or npm i -g ${NPM_PACKAGE}@latest)` };
  }
  return { cmd: null, note: "source checkout — upgrade with: git pull" };
}

/** One-line y/N on stdin with a timeout; timeout and anything but y/yes = no. */
function promptYesNo(question: string, timeoutMs: number): Promise<boolean> {
  process.stdout.write(question);
  return new Promise((resolve) => {
    const finish = (answer: boolean, newline = false) => {
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.pause();
      if (newline) process.stdout.write("\n");
      resolve(answer);
    };
    const timer = setTimeout(() => finish(false, true), timeoutMs);
    const onData = (buf: Buffer) => finish(/^y(es)?$/i.test(buf.toString().trim()));
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

/**
 * If the cache says a newer version exists, offer the upgrade. Interactive
 * only on a TTY and never in Claude's print mode (-p/--print — the user is
 * scripting); declining snoozes that version so it's a quiet notice, not a
 * nag. Runs the upgrade command when the install method makes it
 * unambiguous, otherwise prints the right instructions.
 */
async function maybeOfferUpdate(): Promise<void> {
  if (NO_UPDATE_CHECK) return;
  const cache = readUpdateCache(DATA_DIR);
  const latest = availableUpdate(cache);
  if (!latest || !cache) return;
  const { cmd, note } = upgradeHint();
  const interactive =
    process.stdin.isTTY && process.stdout.isTTY &&
    !claudeArgs.includes("-p") && !claudeArgs.includes("--print");
  if (!interactive || cache.snoozed === latest) {
    log(`update available: v${CCTRACE_VERSION} → v${latest} (${note})`, C.yellow);
    return;
  }
  const yes = await promptYesNo(
    `${C.yellow}[cctrace]${C.reset} update available: v${CCTRACE_VERSION} → v${latest} — upgrade now? [y/N] (10s) `,
    10_000,
  );
  if (!yes) {
    writeUpdateCache(DATA_DIR, { ...cache, snoozed: latest });
    log(`skipping v${latest} — won't ask again for this version (--no-update-check silences the notice too)`, C.dim);
    return;
  }
  if (!cmd) {
    log(note, C.yellow);
    return;
  }
  log(`running: ${cmd.join(" ")}`, C.cyan);
  const res = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
  if (res.exitCode === 0) log(`upgraded to v${latest} — applies to your next run`, C.green);
  else log(`upgrade failed (exit ${res.exitCode}) — ${note}`, C.yellow);
}

/** Does Claude get a flag that resumes an existing session? */
function isContinuation(args: string[]): boolean {
  return args.some((a) => a === "--continue" || a === "-c" || a === "--resume" || a === "-r");
}

// Best-effort browser open, per platform. The URL is always printed too, so a
// missing opener (headless box, no xdg-open) degrades to "open it yourself".
function openBrowser(url: string) {
  const cmd =
    process.platform === "darwin" ? ["open", url] :
    process.platform === "win32" ? ["cmd", "/c", "start", "", url] :
    ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // ignored — the Live UI URL is already on screen
  }
}

// `cctrace view <target> [--dir DIR] [--no-open]` — rebuild a snapshot .html
// from a saved trace (a .jsonl path, a Claude Code session id, or a trace
// filename fragment) and open it. No proxy, no Claude spawn.
function runView(args: string[]) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        dir: { type: "string" },
        "no-open": { type: "boolean" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    console.error(`[cctrace] view: ${(err as Error).message}\n  usage: cctrace view <file.jsonl | session-id> [--dir DIR] [--no-open]`);
    process.exit(1);
  }
  const target = parsed.positionals[0];
  if (!target) {
    console.error("[cctrace] view: need a target\n  usage: cctrace view <file.jsonl | session-id> [--dir DIR] [--no-open]");
    process.exit(1);
  }
  const logDir = (parsed.values.dir as string) || ".cctrace";
  try {
    const result = writeView(target, logDir);
    log(`Rebuilt ${result.pairs.length} pairs from ${result.sources.join(", ")}`, C.cyan);
    for (const w of result.warnings) log(`warning: ${w}`, C.yellow);
    log(`HTML: ${result.htmlPath}`, C.green);
    if (!parsed.values["no-open"]) openBrowser(result.htmlPath);
  } catch (err) {
    if (err instanceof ViewError) {
      console.error(`[cctrace] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

// `cctrace ps` — list live cctrace instances from the registry. Every
// live-mode run registers itself under <data-dir>/instances/ and heartbeats;
// stale entries must answer a port probe or they're garbage-collected, so
// what's printed is what actually serves (see instances.ts).
async function runPs(args: string[]) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { json: { type: "boolean" }, "data-dir": { type: "string" } },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    console.error(`[cctrace] ps: ${(err as Error).message}\n  usage: cctrace ps [--json] [--data-dir PATH]`);
    process.exit(1);
  }
  const dataDir = parsed.values["data-dir"] ? resolve(parsed.values["data-dir"] as string) : DATA_DIR;
  const list = await listLiveInstances(dataDir, { scanPorts: SCAN_PORTS });
  if (parsed.values.json) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  if (!list.length) {
    log("No live cctrace instances", C.dim);
    return;
  }
  const rows = list.map((i) => ({
    url: `http://localhost:${i.port}`,
    pid: String(i.pid),
    project: i.project || "?",
    session: i.sessionId ? i.sessionId.slice(0, 8) : "-",
    started: i.startedAt ? new Date(i.startedAt).toLocaleTimeString() : "-",
  }));
  const w = (k: keyof (typeof rows)[0], h: string) => Math.max(h.length, ...rows.map((r) => r[k].length));
  const widths = { url: w("url", "URL"), pid: w("pid", "PID"), project: w("project", "PROJECT"), session: w("session", "SESSION"), started: w("started", "STARTED") };
  const line = (r: Record<string, string>) =>
    `  ${r.url.padEnd(widths.url)}  ${r.pid.padEnd(widths.pid)}  ${r.project.padEnd(widths.project)}  ${r.session.padEnd(widths.session)}  ${r.started}`;
  console.log(C.dim + line({ url: "URL", pid: "PID", project: "PROJECT", session: "SESSION", started: "STARTED" }) + C.reset);
  for (const r of rows) console.log(line(r));
}

/** Parse a storage subcommand's flags; exit(1) with usage on error. */
function parseStorageArgs(
  cmd: string,
  args: string[],
  options: Record<string, { type: "string" | "boolean" }>,
  usage: string,
) {
  try {
    return parseArgs({ args, options: { dir: { type: "string" }, yes: { type: "boolean" }, ...options }, allowPositionals: true, strict: true });
  } catch (err) {
    console.error(`[cctrace] ${cmd}: ${(err as Error).message}\n  usage: ${usage}`);
    process.exit(1);
  }
}

const DRY = `${C.yellow}dry run${C.reset} — re-run with ${C.cyan}--yes${C.reset} to apply`;

// `cctrace clean` — delete regenerable .html snapshots and 0-byte aborted
// traces. Never touches conversation data.
function runClean(args: string[]) {
  const { values: v } = parseStorageArgs("clean", args, {}, "cctrace clean [--dir DIR] [--yes]");
  const logDir = (v.dir as string) || ".cctrace";
  const plan = planClean(logDir);
  if (!plan.htmls.length && !plan.empties.length) {
    log(`Nothing to clean in ${logDir} (no .html snapshots, no empty traces)`, C.green);
    return;
  }
  if (plan.htmls.length) {
    log(`${plan.htmls.length} regenerable HTML snapshot(s), ${human(plan.htmls.reduce((s, f) => s + f.size, 0))} — rebuild any with 'cctrace view':`, C.cyan);
    for (const f of plan.htmls) console.log(`    ${f.name}  ${C.dim}${human(f.size)}${C.reset}`);
  }
  if (plan.empties.length) {
    log(`${plan.empties.length} empty/aborted trace(s):`, C.cyan);
    for (const f of plan.empties) console.log(`    ${f.name}  ${C.dim}0 B${C.reset}`);
  }
  if (plan.kept.length) {
    log(`${plan.kept.length} .html kept — no source trace left to rebuild from:`, C.dim);
    for (const f of plan.kept) console.log(`    ${f.name}  ${C.dim}${human(f.size)}${C.reset}`);
  }
  if (!v.yes) {
    log(`Would free ${human(plan.bytes)}. ${DRY}`, C.yellow);
    return;
  }
  const res = applyClean(plan);
  log(`Deleted ${res.removed.length} file(s), freed ${human(res.bytes)}`, C.green);
  if (res.skipped.length) {
    log(`Skipped ${res.skipped.length} file(s) that changed since the plan: ${res.skipped.join(", ")}`, C.yellow);
  }
}

// `cctrace merge` — consolidate each session's pairs (across --continue runs)
// into one deduped session-<id>.jsonl. --prune also removes fully-merged
// source traces (never one carrying un-attributable utility pairs).
function runMerge(args: string[]) {
  const { values: v } = parseStorageArgs("merge", args, { prune: { type: "boolean" } }, "cctrace merge [--dir DIR] [--prune] [--yes]");
  const logDir = (v.dir as string) || ".cctrace";
  const plan = planMerge(logDir);
  if (!plan.sessions.length) {
    log(`No session traces to merge in ${logDir}`, C.green);
    return;
  }
  log(`${plan.sessions.length} session(s) across ${logDir}:`, C.cyan);
  for (const s of plan.sessions) {
    const dup = s.dupes ? `, ${s.dupes} dupe(s) dropped` : "";
    const prev = s.existing ? `, ${s.existing} kept from a previous merge` : "";
    console.log(`    ${s.outName}  ${C.dim}${s.pairCount} pairs${dup}${prev} — from ${s.sources.join(", ")}${C.reset}`);
  }
  if (plan.unattributable) {
    log(`${plan.unattributable} utility pair(s) with no session id left in place`, C.dim);
  }
  if (v.prune && plan.subsumed.length) {
    log(`--prune would remove ${plan.subsumed.length} fully-merged source(s), freeing ${human(plan.subsumed.reduce((s, f) => s + f.size, 0))}:`, C.cyan);
    for (const f of plan.subsumed) console.log(`    ${f.name}  ${C.dim}${human(f.size)}${C.reset}`);
  }
  if (!v.yes) {
    log(`Would write ${plan.sessions.length} merged file(s)${v.prune ? "" : " (add --prune to also drop merged sources)"}. ${DRY}`, C.yellow);
    return;
  }
  const res = applyMerge(plan, { prune: !!v.prune });
  log(`Wrote ${res.written.length} merged session file(s)`, C.green);
  if (res.pruned.length) log(`Pruned ${res.pruned.length} source(s), freed ${human(res.bytes)}`, C.green);
  if (res.skipped.length) {
    log(`Kept ${res.skipped.length} source(s) that grew since the plan (live run?): ${res.skipped.join(", ")}`, C.yellow);
  }
}

// `cctrace compress` — gzip -9 archive .jsonl traces for backup; view reads
// .gz transparently. --older-than N limits to traces older than N days.
function runCompress(args: string[]) {
  const { values: v } = parseStorageArgs(
    "compress", args,
    { "older-than": { type: "string" }, "keep-jsonl": { type: "boolean" } },
    "cctrace compress [--dir DIR] [--older-than DAYS] [--keep-jsonl] [--yes]",
  );
  const logDir = (v.dir as string) || ".cctrace";
  const olderThan = v["older-than"] != null ? parseInt(v["older-than"] as string, 10) : undefined;
  if (olderThan != null && (isNaN(olderThan) || olderThan < 0)) {
    console.error("[cctrace] compress: --older-than needs a non-negative number of days");
    process.exit(1);
  }
  const plan = planCompress(logDir, Date.now(), olderThan);
  if (!plan.files.length) {
    log(`No .jsonl traces to compress in ${logDir}${olderThan != null ? ` older than ${olderThan}d` : ""}`, C.green);
    return;
  }
  log(`${plan.files.length} trace(s), ${human(plan.bytes)} to gzip -9:`, C.cyan);
  for (const f of plan.files) console.log(`    ${f.name}  ${C.dim}${human(f.size)}${C.reset}`);
  if (!v.yes) {
    log(`Would archive ${human(plan.bytes)} (JSON gzips ~10-20x)${v["keep-jsonl"] ? "" : "; originals removed after"}. ${DRY}`, C.yellow);
    return;
  }
  const res = applyCompress(plan, { keepJsonl: !!v["keep-jsonl"] });
  for (const a of res.archived) {
    console.log(`    ${a.name}.gz  ${C.dim}${human(a.before)} → ${human(a.after)}${C.reset}`);
  }
  const ratio = res.before > 0 ? (res.before / Math.max(res.after, 1)).toFixed(1) : "0";
  log(`Archived ${res.archived.length} trace(s): ${human(res.before)} → ${human(res.after)} (${ratio}x), saved ${human(res.before - res.after)}`, C.green);
  if (res.skipped.length) {
    log(`Skipped ${res.skipped.length} trace(s) that changed since the plan (live run?): ${res.skipped.join(", ")}`, C.yellow);
  }
}

// One stable data dir for every install method (source, bun link, compiled
// binary) so the MITM CA is generated once and reused. The CA is identity
// material — rotating it silently breaks any trust the user exported with
// --print-ca — so it lives in XDG *data* (~/.local/share/cctrace), not cache:
// cache dirs are fair game for cleaners. Override with --data-dir /
// CCTRACE_DATA_DIR (the pre-0.6 --cache-dir / CCTRACE_CACHE_DIR still work).
function resolveDataDir(): string {
  const v = values as { "data-dir"?: string; "cache-dir"?: string };
  const flag = v["data-dir"] || v["cache-dir"];
  if (flag) return resolve(flag);
  const env = process.env.CCTRACE_DATA_DIR || process.env.CCTRACE_CACHE_DIR;
  if (env) return resolve(env);
  const base = process.env.XDG_DATA_HOME || join(process.env.HOME || ".", ".local", "share");
  return join(base, "cctrace");
}
const DATA_DIR = resolveDataDir();
const MITM_CA_DIR = join(DATA_DIR, "mitm");

// Pre-0.6 the CA lived in XDG cache; move it once, preserving CA identity.
function migrateLegacyCa() {
  const cacheBase = process.env.XDG_CACHE_HOME || join(process.env.HOME || ".", ".cache");
  try {
    if (migrateCaDir(join(cacheBase, "cctrace", "mitm"), MITM_CA_DIR)) {
      log(`Moved MITM CA to ${MITM_CA_DIR} (data, not cache — cleaners wipe ~/.cache)`, C.dim);
    }
  } catch {
    // Fall through: ensureCerts regenerates at the new location.
  }
}

function showHelp() {
  console.log(`
${C.cyan}cctrace${C.reset} - Trace HTTP traffic from Claude Code CLI

${C.yellow}USAGE:${C.reset}
  cctrace [OPTIONS] [-- CLAUDE_ARGS...]
  cctrace <SUBCOMMAND> [ARGS]

  Everything after ${C.cyan}--${C.reset} is passed to the Claude CLI verbatim.

${C.yellow}SUBCOMMANDS:${C.reset} ${C.dim}(operate on saved traces; no proxy, no Claude)${C.reset}
  ${C.cyan}view${C.reset} <file|session-id>   Rebuild a snapshot .html and open it. Target is a
                          .jsonl/.jsonl.gz path, a Claude Code session id, or a
                          trace filename fragment.
  ${C.cyan}clean${C.reset}                     Delete regenerable .html snapshots + empty traces.
  ${C.cyan}merge${C.reset}                     Consolidate each session's pairs into one .jsonl.
  ${C.cyan}compress${C.reset}                  gzip -9 archive traces (view reads .gz directly).
  ${C.cyan}ps${C.reset}                        List live cctrace instances (URL, project, session).
  ${C.dim}clean/merge/compress dry-run by default; add ${C.reset}${C.cyan}--yes${C.reset}${C.dim} to apply.${C.reset}

${C.yellow}OPTIONS:${C.reset}
  --mode MODE        Capture mode: auto (default), mitm, base-url, node
  -s, --static       Static mode (no live server, just files)
  -p, --port PORT    Live UI port (default: ${DEFAULT_PORT})
  --messages-only    Only capture /v1/messages (default: capture everything)
  --no-open          Don't auto-open browser
  --print-ca         Print the MITM CA cert path and exit
  --log NAME         Custom log file base name
  --dir PATH         Log directory (default: .cctrace)
  --fresh            Don't merge prior traces of a continued session
  --with FILE        Merge a specific trace file into the view (repeatable)
  --claude-path PATH Custom Claude binary path
  --data-dir PATH    MITM CA / data dir (default: ~/.local/share/cctrace;
                     or set CCTRACE_DATA_DIR. --cache-dir still works)
  --no-update-check  Skip the daily npm version check + upgrade prompt
                     (or set CCTRACE_NO_UPDATE_CHECK=1)
  -V, --version      Print the cctrace version and exit
  -h, --help         Show this help

${C.yellow}CAPTURE MODES:${C.reset}
  ${C.cyan}mitm${C.reset}      TLS-intercepting proxy. Captures ALL Anthropic traffic
            (messages, OAuth, usage/credits, MCP). Auto-generates a CA that
            Claude trusts via NODE_EXTRA_CA_CERTS. ${C.dim}Default for native binaries.${C.reset}
  ${C.cyan}base-url${C.reset}  Reverse proxy via ANTHROPIC_BASE_URL. Zero setup, but only
            sees /v1/messages (OAuth/usage bypass it).
  ${C.cyan}node${C.reset}      Legacy fetch() injection via node --require. Only works for
            npm-installed (non-native) Claude. ${C.dim}Auto-selected for JS installs.${C.reset}

${C.yellow}EXAMPLES:${C.reset}
  cctrace                          ${C.dim}# Auto mode, capture everything${C.reset}
  cctrace --mode base-url          ${C.dim}# Lightweight, messages only, no CA${C.reset}
  cctrace -s                       ${C.dim}# Static mode (files only)${C.reset}
  cctrace -- --continue            ${C.dim}# Resume last Claude session, traced${C.reset}
  cctrace -- -p "explain this"     ${C.dim}# Claude print mode, traced${C.reset}
  cctrace --mode base-url -- --model opus --continue
  cctrace view .cctrace/trace-2026-07-08T05-51-43.jsonl  ${C.dim}# reopen a saved trace${C.reset}
  cctrace view 4f9a2c1e             ${C.dim}# rebuild by Claude Code session id${C.reset}

  ${C.dim}Note: -p before "--" is cctrace's port; -p after "--" is Claude's print mode.${C.reset}
`);
}

function findClaude(): string {
  const custom = values["claude-path"];
  if (custom) {
    return resolve(custom);
  }

  const home = process.env.HOME || "";
  const paths = [
    join(home, ".claude", "bin", "claude"),
    join(home, ".claude", "local", "claude"),
    join(home, ".local", "bin", "claude"),
    join(home, ".npm-global", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];

  for (const p of paths) {
    if (existsSync(p)) return p;
  }

  const which = Bun.spawnSync(["which", "claude"]);
  if (which.exitCode === 0) {
    return which.stdout.toString().trim();
  }

  throw new Error("Claude not found. Install Claude Code or use --claude-path");
}

async function buildPreload(): Promise<string> {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  const srcDir = dirname(import.meta.path);
  const preloadSrc = join(srcDir, "preload.ts");
  const preloadOut = join(DATA_DIR, "preload.cjs");

  if (existsSync(preloadOut)) unlinkSync(preloadOut);

  const result = await Bun.build({
    entrypoints: [preloadSrc],
    outdir: DATA_DIR,
    target: "node",
    format: "cjs",
    naming: "[name].cjs",
    minify: false,
  });

  if (!result.success) {
    throw new Error("Build failed: " + result.logs.join("\n"));
  }

  return preloadOut;
}

interface RunOpts {
  port: number;
  liveMode: boolean;
  logDir: string;
  logName?: string;
  logAll: boolean;
  noOpen: boolean;
  fresh: boolean;
  withFiles: string[];
}

interface LogSink {
  onPair: (pair: TracePair) => void;
  /** Write the categorized HTML report from everything collected. */
  writeHtml: () => string;
}

/** Run identity for the page header: Claude's project is the cwd it runs in. */
function pageMeta(): PageMeta {
  const cwd = process.cwd();
  const meta: PageMeta = { project: basename(cwd) || cwd, projectPath: cwd, version: CCTRACE_VERSION };
  if (!NO_UPDATE_CHECK) {
    const latest = availableUpdate(readUpdateCache(DATA_DIR));
    if (latest) meta.latestVersion = latest;
  }
  return meta;
}

/** The current run's log paths, computed once so server + sink agree. */
function logPaths(opts: RunOpts): { logFile: string; htmlFile: string } {
  const base = opts.logName || `trace-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5)}`;
  return {
    logFile: join(opts.logDir, `${base}.jsonl`),
    htmlFile: join(opts.logDir, `${base}.html`),
  };
}

function makeLogSink(opts: RunOpts, logFile: string, htmlFile: string, livePort?: number): LogSink {
  if (!existsSync(opts.logDir)) mkdirSync(opts.logDir, { recursive: true });
  writeFileSync(logFile, "");
  log(`Log: ${logFile}`, C.blue);

  const collected: TracePair[] = [];

  return {
    onPair: (pair: TracePair) => {
      collected.push(pair);
      appendFileSync(logFile, JSON.stringify(pair) + "\n");
      if (livePort) {
        fetch(`http://localhost:${livePort}/api/pair`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(pair),
        }).catch(() => {});
      }
    },
    // The snapshot merges prior-run pairs of the same Claude session (and any
    // --with files) so a --continue'd session's .html is complete on its own.
    writeHtml: () => {
      let all = collected;
      const extra: TracePair[] = opts.withFiles.length ? loadTraceFiles(opts.withFiles) : [];
      if (!opts.fresh) {
        const sids = new Set(collected.map(extractSessionId).filter(Boolean));
        extra.push(...loadPriorPairs(opts.logDir, logFile, sids));
      }
      if (extra.length) {
        // known also dedupes within extra: --with files and prior-run scans
        // can hand us the same pair twice (e.g. a trace and its merge output).
        const known = new Set(collected.map((p) => p.id));
        all = [...collected];
        for (const p of extra) {
          if (!p.id || known.has(p.id)) continue;
          known.add(p.id);
          all.push(p);
        }
        all.sort((a, b) => (a.request?.timestamp || 0) - (b.request?.timestamp || 0));
      }
      const snapHtml = renderSnapshot(all, pageMeta());
      const problem = verifySnapshot(snapHtml, all.length);
      if (problem) log(`warning: snapshot self-check failed: ${problem}`, C.yellow);
      writeFileSync(htmlFile, snapHtml);
      return htmlFile;
    },
  };
}

function spawnClaudeWithCapturer(claudePath: string, claudeArgs: string[], capturer: Capturer, opts: RunOpts, onFinalize?: () => string) {
  // The proxy must outlive any single failed connection: if this process dies,
  // Claude's HTTPS_PROXY dies with it and the live session is severed. Bun's
  // stream internals can throw from native callbacks (observed: process-fatal
  // TypeError when a proxied SSE connection dropped mid-stream) — log the pair
  // as lost and keep serving.
  const survive = (kind: string) => (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log(`${kind}: ${msg} — capture continues`, C.yellow);
  };
  process.on("uncaughtException", survive("Uncaught exception"));
  process.on("unhandledRejection", survive("Unhandled rejection"));

  log(`Capture: ${capturer.label}`, C.cyan);
  console.log("");

  const child: ChildProcess = spawn(claudePath, claudeArgs, {
    env: { ...(process.env as Record<string, string>), ...capturer.env },
    stdio: "inherit",
    cwd: process.cwd(),
  });

  child.on("error", (err) => {
    capturer.stop();
    log(`Error: ${err.message}`, C.yellow);
    process.exit(1);
  });

  child.on("exit", async (code, signal) => {
    await capturer.flush();
    log(`Traced ${capturer.pairCount()} request/response pairs`, C.green);
    capturer.stop();
    if (onFinalize) {
      const htmlFile = onFinalize();
      log(`HTML: ${htmlFile}`, C.green);
      // Static mode has no live tab, so open the finished snapshot. Live mode
      // already has the same UI on screen; point at `view` to reopen instead.
      if (!opts.noOpen && !opts.liveMode) {
        openBrowser(htmlFile);
      } else {
        log(`Reopen anytime: cctrace view ${htmlFile.replace(/\.html$/, ".jsonl")}`, C.dim);
      }
    }
    if (signal) log(`Terminated: ${signal}`, C.yellow);
    else if (code === 0) log("Session complete", C.green);
    process.exit(code ?? 0);
  });

  let shuttingDown = false;
  const handleSignal = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    child.kill(sig as NodeJS.Signals);
  };
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
}

async function runProxyCapture(mode: CaptureMode, claudePath: string, claudeArgs: string[], opts: RunOpts) {
  const { logFile, htmlFile } = logPaths(opts);
  let livePort: number | undefined;
  if (opts.liveMode) {
    // Register in the live-instance registry so `cctrace ps` and the UI's
    // instance switcher can find concurrent runs. The session id joins the
    // entry once Claude's first request reveals it on the wire. The id is
    // the run's identity for cross-instance probes — pids can't be, they
    // collide across containers sharing the data dir.
    const instanceId = crypto.randomUUID();
    let instance: InstanceHandle | null = null;
    const server = createServer({
      port: opts.port,
      logDir: opts.logDir,
      logFile,
      noHistory: opts.fresh,
      withFiles: opts.withFiles,
      meta: pageMeta(),
      dataDir: DATA_DIR,
      instanceId,
      self: () => instance?.snapshot() ?? null,
      onSession: (sid) => instance?.update({ sessionId: sid }),
    });
    livePort = server.port;
    instance = registerInstance(DATA_DIR, {
      id: instanceId,
      pid: process.pid,
      port: livePort ?? opts.port,
      project: pageMeta().project || "",
      projectPath: pageMeta().projectPath || "",
      logFile,
      mode,
      startedAt: new Date().toISOString(),
    });
    process.on("exit", () => instance?.unregister());
    log(`Live UI: http://localhost:${livePort}`, C.green);
    if (!opts.noOpen) {
      setTimeout(() => openBrowser(`http://localhost:${livePort}`), 500);
    }
  }

  const sink = makeLogSink(opts, logFile, htmlFile, livePort);
  const targetHost = process.env.ANTHROPIC_BASE_URL
    ? new URL(process.env.ANTHROPIC_BASE_URL).host
    : "api.anthropic.com";

  // Source runs used to keep the CA under the repo's .cache/ — that key can
  // forge Anthropic certs, so don't leave it behind as silent archaeology.
  const legacyCaDir = join(dirname(import.meta.path), "..", ".cache", "mitm");
  if (mode === "mitm" && legacyCaDir !== MITM_CA_DIR && existsSync(legacyCaDir)) {
    log(`Legacy CA cache at ${legacyCaDir} is no longer used — safe to delete`, C.yellow);
  }
  if (mode === "mitm") migrateLegacyCa();

  const capturer = await createCapturer(mode, {
    onPair: sink.onPair,
    logAll: opts.logAll,
    cacheDir: MITM_CA_DIR,
    targetHost,
    onStatus: (msg) => log(msg, C.dim),
  });

  // --continue/--resume can't reveal which session until Claude's first request
  // hits the wire, so prior turns merge then, not now. Say so, or a user waits.
  if (!opts.fresh && isContinuation(claudeArgs)) {
    log("Continuing a session — prior turns merge into Session view on Claude's first request", C.dim);
  }

  spawnClaudeWithCapturer(claudePath, claudeArgs, capturer, opts, sink.writeHtml);
}

async function runNodeMode(claudePath: string, claudeArgs: string[], opts: RunOpts) {
  log("Mode: Node.js --require injection (legacy)", C.blue);

  const preloadPath = await buildPreload();
  const loaderPath = join(dirname(import.meta.path), "loader.cjs");

  let livePort = opts.port;
  if (opts.liveMode) {
    // Legacy mode: the preload names the log file itself, so the server can't
    // exclude it from prior-trace scans — pair-id dedupe covers that instead.
    const instanceId = crypto.randomUUID();
    let instance: InstanceHandle | null = null;
    const server = createServer({
      port: opts.port,
      logDir: opts.logDir,
      noHistory: opts.fresh,
      withFiles: opts.withFiles,
      meta: pageMeta(),
      dataDir: DATA_DIR,
      instanceId,
      self: () => instance?.snapshot() ?? null,
      onSession: (sid) => instance?.update({ sessionId: sid }),
    });
    livePort = server.port ?? opts.port;
    instance = registerInstance(DATA_DIR, {
      id: instanceId,
      pid: process.pid,
      port: livePort,
      project: pageMeta().project || "",
      projectPath: pageMeta().projectPath || "",
      logFile: "",
      mode: "node",
      startedAt: new Date().toISOString(),
    });
    process.on("exit", () => instance?.unregister());
    log(`Live UI: http://localhost:${livePort}`, C.green);
    if (!opts.noOpen) {
      setTimeout(() => openBrowser(`http://localhost:${livePort}`), 500);
    }
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CCTRACE_TRACE_ALL: opts.logAll ? "true" : "false",
    CCTRACE_INCLUDE_ALL: "true",
    CCTRACE_OPEN_BROWSER: opts.noOpen ? "false" : "true",
    CCTRACE_SERVER_MODE: opts.liveMode ? "true" : "false",
    CCTRACE_SERVER_PORT: String(livePort),
    CCTRACE_LOG_DIR: opts.logDir,
  };
  if (opts.logName) env.CCTRACE_LOG_NAME = opts.logName;

  log(`Tracing: ${opts.logAll ? "ALL requests" : "/v1/messages"}`, C.cyan);
  console.log("");

  const spawnArgs = ["--require", loaderPath, claudePath, ...claudeArgs];
  const child: ChildProcess = spawn("node", spawnArgs, { env, stdio: "inherit", cwd: process.cwd() });

  child.on("error", (err) => {
    log(`Error: ${err.message}`, C.yellow);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) log(`Terminated: ${signal}`, C.yellow);
    else if (code === 0) log("Session complete", C.green);
    process.exit(code ?? 0);
  });

  let shuttingDown = false;
  const handleSignal = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    child.kill(sig as NodeJS.Signals);
  };
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
}

/** Resolve the capture mode: honor --mode, else auto-detect from the binary. */
function resolveMode(claudePath: string): { mode: "mitm" | "base-url" | "node"; runPath: string } {
  const requested = values.mode?.toLowerCase();
  const jsPath = resolveClaudeBashWrapper(claudePath);
  const effectivePath = jsPath || claudePath;
  const native = isNativeBinary(claudePath) || (jsPath ? isNativeBinary(jsPath) : false);

  if (requested === "node") return { mode: "node", runPath: effectivePath };
  if (requested === "base-url") return { mode: "base-url", runPath: jsPath && !native ? effectivePath : claudePath };
  if (requested === "mitm") return { mode: "mitm", runPath: native ? (jsPath && isNativeBinary(jsPath) ? jsPath : claudePath) : claudePath };

  // auto
  if (native) {
    log("Detected: native binary (Bun-compiled)", C.yellow);
    return { mode: "mitm", runPath: jsPath && isNativeBinary(jsPath) ? jsPath : claudePath };
  }
  return { mode: "node", runPath: effectivePath };
}

async function main() {
  if (SUBCOMMAND) {
    const rest = RAW_ARGV.slice(1);
    if (SUBCOMMAND === "view") runView(rest);
    else if (SUBCOMMAND === "clean") runClean(rest);
    else if (SUBCOMMAND === "merge") runMerge(rest);
    else if (SUBCOMMAND === "compress") runCompress(rest);
    else if (SUBCOMMAND === "ps") await runPs(rest);
    process.exit(0);
  }

  if (values.version) {
    console.log(`cctrace v${CCTRACE_VERSION}`);
    const latest = availableUpdate(readUpdateCache(DATA_DIR));
    if (latest) console.log(`latest: v${latest} (update available)`);
    process.exit(0);
  }

  if (values.help) {
    showHelp();
    process.exit(0);
  }

  if (values["print-ca"]) {
    migrateLegacyCa();
    const certs = await ensureCerts(MITM_CA_DIR);
    console.log(certs.caCertPath);
    process.exit(0);
  }

  const requestedMode = values.mode?.toLowerCase();
  if (requestedMode && !CAPTURE_MODES.includes(requestedMode as (typeof CAPTURE_MODES)[number])) {
    console.error(`[cctrace] Error: unknown --mode "${requestedMode}". Use one of: ${CAPTURE_MODES.join(", ")}.`);
    process.exit(1);
  }

  const opts: RunOpts = {
    port: parseInt(values.port || String(DEFAULT_PORT), 10),
    liveMode: !values.static,
    logDir: values.dir || ".cctrace",
    logName: values.log,
    logAll: !values["messages-only"],
    noOpen: !!values["no-open"],
    fresh: !!values.fresh,
    withFiles: values.with ? [...values.with] : [],
  };

  log(`cctrace v${CCTRACE_VERSION}`, C.dim);
  await maybeOfferUpdate();
  // Refresh the update cache in the background — never blocks the session.
  if (!NO_UPDATE_CHECK) refreshUpdateCache(DATA_DIR).catch(() => {});

  const claudePath = findClaude();
  log(`Claude: ${claudePath}`, C.blue);
  if (claudeArgs.length) log(`Claude args: ${claudeArgs.join(" ")}`, C.blue);

  const { mode, runPath } = resolveMode(claudePath);

  // Legacy node mode injects .cache/preload.cjs + src/loader.cjs, which only
  // exist when running from the repo — the compiled binary carries neither.
  if (mode === "node" && IS_COMPILED) {
    console.error(
      "[cctrace] node mode (legacy fetch injection) needs the cctrace sources — " +
        "run it via bun instead (bunx @thevibeworks/cctrace), or use --mode mitm/base-url.",
    );
    process.exit(1);
  }

  if (mode === "node") {
    await runNodeMode(runPath, claudeArgs, opts);
  } else {
    await runProxyCapture(mode, runPath, claudeArgs, opts);
  }
}

main().catch((err) => {
  console.error("[cctrace] Error:", err.message);
  process.exit(1);
});
