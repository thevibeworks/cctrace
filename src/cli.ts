#!/usr/bin/env bun

import { dirname, join, resolve } from "path";
import { mkdirSync, existsSync, unlinkSync, appendFileSync, writeFileSync } from "fs";
import { spawn, type ChildProcess } from "child_process";
import { createServer, renderSnapshot } from "./server";
import { createCapturer, type CaptureMode, type Capturer } from "./capture";
import { isNativeBinary, resolveClaudeBashWrapper } from "./detect";
import { ensureCerts } from "./certs";
import { parseCliArgs, CliUsageError } from "./args";
import { loadPriorPairs, loadTraceFiles } from "./history";
import { extractSessionId } from "./summarize";
import { writeView, ViewError } from "./view";
import {
  planClean, applyClean, planMerge, applyMerge, planCompress, applyCompress, human,
} from "./storage";
import { parseArgs } from "util";
import type { TracePair } from "./types";

// Live-UI port. Avoids 7890/7891 (Clash/mihomo proxy defaults). Falls back to
// an OS-assigned free port if this is taken (see createServer).
const DEFAULT_PORT = 9317;

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
const SUBCOMMANDS = new Set(["view", "clean", "merge", "compress"]);
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

// One stable cache dir for every install method (source, bun link, compiled
// binary) so the MITM CA is generated once and reused — regenerating it each
// run would defeat any CA the user trusted into their system store. Override
// with --cache-dir or CCTRACE_CACHE_DIR; else XDG cache (~/.cache/cctrace).
function resolveCacheDir(): string {
  const flag = (values as { "cache-dir"?: string })["cache-dir"];
  if (flag) return resolve(flag);
  if (process.env.CCTRACE_CACHE_DIR) return resolve(process.env.CCTRACE_CACHE_DIR);
  const base = process.env.XDG_CACHE_HOME || join(process.env.HOME || ".", ".cache");
  return join(base, "cctrace");
}
const CACHE_DIR = resolveCacheDir();
const MITM_CA_DIR = join(CACHE_DIR, "mitm");

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
  --cache-dir PATH   MITM CA / cache dir (default: ~/.cache/cctrace;
                     or set CCTRACE_CACHE_DIR)
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
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

  const srcDir = dirname(import.meta.path);
  const preloadSrc = join(srcDir, "preload.ts");
  const preloadOut = join(CACHE_DIR, "preload.cjs");

  if (existsSync(preloadOut)) unlinkSync(preloadOut);

  const result = await Bun.build({
    entrypoints: [preloadSrc],
    outdir: CACHE_DIR,
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
      writeFileSync(htmlFile, renderSnapshot(all));
      return htmlFile;
    },
  };
}

function spawnClaudeWithCapturer(claudePath: string, claudeArgs: string[], capturer: Capturer, opts: RunOpts, onFinalize?: () => string) {
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
    const server = createServer({
      port: opts.port,
      logDir: opts.logDir,
      logFile,
      noHistory: opts.fresh,
      withFiles: opts.withFiles,
    });
    livePort = server.port;
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
    const server = createServer({
      port: opts.port,
      logDir: opts.logDir,
      noHistory: opts.fresh,
      withFiles: opts.withFiles,
    });
    livePort = server.port ?? opts.port;
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
    process.exit(0);
  }

  if (values.help) {
    showHelp();
    process.exit(0);
  }

  if (values["print-ca"]) {
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
