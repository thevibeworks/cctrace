#!/usr/bin/env bun

import { basename, dirname, join, resolve } from "path";
import { mkdirSync, existsSync, unlinkSync, appendFileSync, writeFileSync, statSync } from "fs";
import { spawn, type ChildProcess } from "child_process";
import { createServer, renderSnapshot, verifySnapshot } from "./server";
import { createCapturer, type CaptureMode, type Capturer } from "./capture";
import { isNativeBinary, resolveClaudeBashWrapper } from "./detect";
import { ensureCerts, migrateCaDir, buildInterceptSet } from "./certs";
import { parseCliArgs, CliUsageError } from "./args";
import { loadPriorPairs, loadTraceFiles, newestPriorSessionId } from "./history";
import { extractSessionId } from "./summarize";
import { termWrite, muteTerm, unmuteTerm } from "./termlog";
import { writeView, resolveView, listTraceInfos, ViewError } from "./view";
import { registerInstance, listLiveInstances, listPastRuns, SCAN_PORTS, DEFAULT_PORT, type InstanceHandle } from "./instances";
import { CLIENTS, findClientBinary, wireTables } from "./clients";
import {
  CCTRACE_VERSION, NPM_PACKAGE, readUpdateCache, writeUpdateCache, refreshUpdateCache, availableUpdate,
  versionWithCommit,
} from "./version";
import type { PageMeta } from "./ui";
import { pricingCatalog, refreshPricingCache } from "./pricing-catalog";
import {
  planClean, applyClean, planMerge, applyMerge, planCompress, applyCompress,
  planPurge, applyPurge, human,
} from "./storage";
import { planCompact, applyCompact } from "./compact";
import { CATEGORIES, categorizeUrl } from "./categorize";
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
function parseArgvOrExit(argv: string[]) {
  try {
    return parseCliArgs(argv);
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
const ARGV_HEAD = RAW_ARGV[0] ?? "";
const SUBCOMMANDS = new Set(["view", "clean", "merge", "compress", "purge", "compact", "ps"]);
const SUBCOMMAND = SUBCOMMANDS.has(ARGV_HEAD) ? ARGV_HEAD : null;
// A leading client word picks who gets traced: `cctrace codex -- exec ...`.
// Omitted (or "claude") keeps the original grammar; the rest parses the same.
const CLIENT_SELECTED = !SUBCOMMAND && ARGV_HEAD in CLIENTS;
const CLIENT = CLIENTS[CLIENT_SELECTED ? ARGV_HEAD : "claude"]!;
const OWN_ARGV = CLIENT_SELECTED ? RAW_ARGV.slice(1) : RAW_ARGV;
const { values, claudeArgs } = SUBCOMMAND ? { values: {} as Record<string, never>, claudeArgs: [] } : parseArgvOrExit(OWN_ARGV);

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

// All cctrace terminal output funnels through termWrite: while a spawned TUI
// client owns the screen the lines buffer and flush after it exits, so a
// mid-session continuity merge or crash-guard note never corrupts the TUI.
function log(msg: string, color = C.reset) {
  termWrite(`${color}[cctrace]${C.reset} ${msg}`);
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
  return promptLine(question, timeoutMs).then((a) => /^y(es)?$/i.test(a));
}

function promptLine(question: string, timeoutMs: number): Promise<string> {
  process.stdout.write(question);
  return new Promise((resolve) => {
    const finish = (answer: string, newline = false) => {
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.pause();
      if (newline) process.stdout.write("\n");
      resolve(answer);
    };
    const timer = setTimeout(() => finish("", true), timeoutMs);
    const onData = (buf: Buffer) => finish(buf.toString().trim());
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

/** "2h ago" / "3d ago" — trace-picker age column. */
function ago(mtimeMs: number): string {
  const s = Math.max(0, (Date.now() - mtimeMs) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
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

// `cctrace view <target> [--html] [--port N] [--dir DIR] [--no-open]` —
// reopen a saved trace (a .jsonl[.zst|.gz] path, a session id, or a trace
// filename fragment). Default serves the UI from the live web server — no
// snapshot file, so a several-hundred-MB session can't choke the browser.
// --html writes the self-contained snapshot .html instead (shareable, works
// offline); --serve is the pre-0.13 spelling of the default, kept as a
// no-op. No proxy, no Claude spawn either way. Returns true when a server
// was started and the process must stay alive.
async function runView(args: string[]): Promise<boolean> {
  const usage = "usage: cctrace view [file.jsonl[.zst|.gz] | session-id | latest] [--html] [--port N] [--dir DIR] [--no-open]";
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        dir: { type: "string" },
        "no-open": { type: "boolean" },
        html: { type: "boolean" },
        serve: { type: "boolean" }, // legacy alias of the default
        port: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    console.error(`[cctrace] view: ${(err as Error).message}\n  ${usage}`);
    process.exit(1);
  }
  const logDir = (parsed.values.dir as string) || ".cctrace";
  let target = parsed.positionals[0];
  // No target: show what's viewable instead of demanding a filename the
  // user has no way to know. On a TTY, let them pick; Enter opens the
  // newest — the answer they almost always want.
  if (!target) {
    const infos = listTraceInfos(logDir);
    // The run catalog (registry tombstones) knows about traces in OTHER
    // projects — list recent ones after this dir's, resolvable by number.
    // Re-stat before offering: a tombstone written in another container may
    // name a path that doesn't resolve here (list nothing, never error).
    const localDir = resolve(logDir);
    const seen = new Set<string>();
    const elsewhere = listPastRuns(DATA_DIR).filter((r) => {
      if (!r.logFile || resolve(dirname(r.logFile)) === localDir) return false;
      if (seen.has(r.logFile)) return false;
      seen.add(r.logFile);
      try { return statSync(r.logFile).isFile(); } catch { return false; }
    }).slice(0, 8);
    if (!infos.length && !elsewhere.length) {
      console.error(`[cctrace] view: no .jsonl traces in ${logDir}\n  ${usage}`);
      process.exit(1);
    }
    const shown = infos.slice(0, 15);
    if (shown.length) {
      log(`traces in ${logDir} (newest first):`, C.cyan);
      shown.forEach((t, i) => {
        console.log(
          `  ${String(i + 1).padStart(2)}  ${t.base.padEnd(44)} ${human(t.size).padStart(9)}   ${ago(t.mtimeMs)}`,
        );
      });
      if (infos.length > shown.length) console.log(`      ... ${infos.length - shown.length} more`);
    }
    if (elsewhere.length) {
      log(`recent runs elsewhere:`, C.cyan);
      elsewhere.forEach((r, i) => {
        const when = r.endedAt ? ago(Date.parse(r.endedAt)) : "";
        const label = `${r.project || "?"}${r.client ? ` (${r.client})` : ""}`;
        console.log(
          `  ${String(shown.length + i + 1).padStart(2)}  ${label.padEnd(28)} ${basename(r.logFile).padEnd(34)} ${when}`,
        );
      });
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      log(`pick one: cctrace view <filename fragment | session-id | latest>`, C.dim);
      return false;
    }
    const answer = await promptLine(`${C.cyan}[cctrace]${C.reset} view which? [1] `, 60_000);
    if (/^q(uit)?$/i.test(answer)) return false;
    const n = /^\d+$/.test(answer) ? parseInt(answer, 10) : answer === "" ? 1 : 0;
    if (n > 0 && n <= shown.length) target = shown[n - 1]!.path;
    else if (n > shown.length && n <= shown.length + elsewhere.length) target = elsewhere[n - shown.length - 1]!.logFile;
    else if (n > 0) { console.error(`[cctrace] view: no trace #${n}`); process.exit(1); }
    else target = answer; // free-form: fragment / session id / path
  }
  try {
    refreshPricingCache(DATA_DIR).catch(() => {});
    if (!parsed.values.html) {
      serveView(target, logDir, {
        port: parsed.values.port ? parseInt(parsed.values.port as string, 10) : DEFAULT_PORT,
        noOpen: !!parsed.values["no-open"],
      });
      return true;
    }
    const result = writeView(target, logDir, { pricing: pricingCatalog(DATA_DIR) });
    log(`Rebuilt ${result.pairs.length} pairs from ${result.sources.join(", ")}`, C.cyan);
    for (const w of result.warnings) log(`warning: ${w}`, C.yellow);
    log(`HTML: ${result.htmlPath}`, C.green);
    const mb = statSync(result.htmlPath).size / (1024 * 1024);
    if (mb > 100) {
      log(`snapshot is ${mb.toFixed(0)}MB — browsers struggle at this size; serve it instead: cctrace view ${target}`, C.yellow);
    }
    if (!parsed.values["no-open"]) openBrowser(result.htmlPath);
  } catch (err) {
    if (err instanceof ViewError) {
      console.error(`[cctrace] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  return false;
}

// The --serve half of `cctrace view`: same target resolution, but the pairs
// are seeded into the live web server instead of embedded in a file. The run
// registers in the instance registry like any live capture (mode "view"), so
// `cctrace ps` and the header switcher see it. Ctrl-C stops it.
function serveView(target: string, logDir: string, opts: { port: number; noOpen: boolean }) {
  const result = resolveView(target, logDir);
  log(`Rebuilt ${result.pairs.length} pairs from ${result.sources.join(", ")}`, C.cyan);
  for (const w of result.warnings) log(`warning: ${w}`, C.yellow);

  const traceName = (result.sources[0] || target).replace(/\.jsonl(\.zst|\.gz)?$/, "");
  // The header shows <project>/<trace-file>: the project is the traced
  // repo, i.e. the log dir's parent when it's a standard ./.cctrace.
  const viewDir = resolve(logDir);
  const viewProject = basename(viewDir) === ".cctrace" ? basename(dirname(viewDir)) : basename(viewDir);
  // The rebuilt pairs know who produced them (0.13+ traces); older traces
  // carry no label and the header degrades to project-only.
  const client = result.pairs.findLast((p) => p.client)?.client;
  const instanceId = crypto.randomUUID();
  let instance: InstanceHandle | null = null;
  const server = createServer({
    port: opts.port,
    logDir,
    meta: { ...pageMeta(client), project: viewProject, projectPath: viewDir, traceFile: basename(result.sources[0] || target) },
    dataDir: DATA_DIR,
    instanceId,
    initialPairs: result.pairs,
    self: () => instance?.snapshot() ?? null,
  });
  instance = registerInstance(DATA_DIR, {
    id: instanceId,
    pid: process.pid,
    port: server.port,
    project: traceName,
    projectPath: resolve(logDir),
    logFile: resolve(logDir, result.sources[0] || ""),
    mode: "view",
    client,
    startedAt: new Date().toISOString(),
  });
  process.on("exit", () => instance?.unregister());
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  log(`Serving ${result.sources.join(", ")} at http://localhost:${server.port} — Ctrl-C to stop`, C.green);
  if (!opts.noOpen) setTimeout(() => openBrowser(`http://localhost:${server.port}`), 300);
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
  // Pids are namespace-local: they identify/kill runs in YOUR namespace but
  // mean nothing across containers — liveness stays heartbeat+probe.
  const rows = list.map((i) => ({
    url: `http://localhost:${i.port}`,
    pid: String(i.pid),
    agent: i.agentPid ? String(i.agentPid) : "-",
    client: i.client || "-",
    project: i.project || "?",
    session: i.sessionId ? i.sessionId.slice(0, 8) : "-",
    started: i.startedAt ? new Date(i.startedAt).toLocaleTimeString() : "-",
  }));
  const w = (k: keyof (typeof rows)[0], h: string) => Math.max(h.length, ...rows.map((r) => r[k].length));
  const widths = { url: w("url", "URL"), pid: w("pid", "PID"), agent: w("agent", "AGENT"), client: w("client", "CLIENT"), project: w("project", "PROJECT"), session: w("session", "SESSION"), started: w("started", "STARTED") };
  const line = (r: Record<string, string>) =>
    `  ${r.url.padEnd(widths.url)}  ${r.pid.padEnd(widths.pid)}  ${r.agent.padEnd(widths.agent)}  ${r.client.padEnd(widths.client)}  ${r.project.padEnd(widths.project)}  ${r.session.padEnd(widths.session)}  ${r.started}`;
  console.log(C.dim + line({ url: "URL", pid: "PID", agent: "AGENT", client: "CLIENT", project: "PROJECT", session: "SESSION", started: "STARTED" }) + C.reset);
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

// `cctrace compress` — zstd-archive .jsonl traces; view reads .zst (and
// legacy .gz) transparently. Session traces are mostly re-sent conversation
// prefixes, which zstd's long window compresses 40-60x where gzip got 3x.
// --older-than N limits to traces older than N days.
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
  if (!plan.files.length && !plan.upgrades.length) {
    log(`No .jsonl traces to compress in ${logDir}${olderThan != null ? ` older than ${olderThan}d` : ""}`, C.green);
    return;
  }
  if (plan.files.length) {
    log(`${plan.files.length} trace(s), ${human(plan.bytes)} to archive as .zst:`, C.cyan);
    for (const f of plan.files) console.log(`    ${f.name}  ${C.dim}${human(f.size)}${C.reset}`);
  }
  if (plan.upgrades.length) {
    log(`${plan.upgrades.length} legacy .gz archive(s) to re-encode as .zst (long-window: typically 10-20x smaller):`, C.cyan);
    for (const f of plan.upgrades) console.log(`    ${f.name}  ${C.dim}${human(f.size)}${C.reset}`);
  }
  if (!v.yes) {
    log(`Would archive ${human(plan.bytes)} (session traces compress 40-60x)${v["keep-jsonl"] ? "" : "; originals removed after"}. ${DRY}`, C.yellow);
    return;
  }
  const res = applyCompress(plan, { keepJsonl: !!v["keep-jsonl"] });
  for (const a of res.archived) {
    console.log(`    ${a.name.replace(/\.gz$/, "")}.zst  ${C.dim}${human(a.before)} → ${human(a.after)}${C.reset}`);
  }
  const ratio = res.before > 0 ? (res.before / Math.max(res.after, 1)).toFixed(1) : "0";
  log(`Archived ${res.archived.length} trace(s): ${human(res.before)} → ${human(res.after)} (${ratio}x), saved ${human(res.before - res.after)}`, C.green);
  if (res.skipped.length) {
    log(`Skipped ${res.skipped.length} trace(s) that changed since the plan (live run?): ${res.skipped.join(", ")}`, C.yellow);
  }
}

// `cctrace purge` — drop whole categories of pairs from saved traces. The
// default set (telemetry + count_tokens) is the noise: on a real large trace
// it's ~45% of rows but only ~9% of bytes, so the summary is explicit about
// rows vs disk — `compress` is the space tool, purge is the noise tool.
function runPurge(args: string[]) {
  const usage = "cctrace purge [--dir DIR] [--drop CATS] [--keep CATS] [--yes]";
  const { values: v } = parseStorageArgs(
    "purge", args,
    { drop: { type: "string" }, keep: { type: "string" } },
    usage,
  );
  const logDir = (v.dir as string) || ".cctrace";
  const ids = new Set(CATEGORIES.map((c) => c.id));
  const parseCats = (flag: string, raw: string): Set<string> => {
    const cats = new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
    for (const c of cats) {
      if (!ids.has(c)) {
        console.error(`[cctrace] purge: unknown category "${c}" for ${flag}\n  categories: ${[...ids].join(", ")}`);
        process.exit(1);
      }
    }
    return cats;
  };
  if (v.drop && v.keep) {
    console.error(`[cctrace] purge: --drop and --keep are mutually exclusive\n  ${usage}`);
    process.exit(1);
  }
  let drop: Set<string>;
  if (v.keep) {
    const keep = parseCats("--keep", v.keep as string);
    drop = new Set([...ids].filter((c) => !keep.has(c)));
  } else {
    // Default drop: the non-valuable bulk. external joined in 0.16 — old
    // traces carry decoded third-party payloads (npm tarballs, gh API
    // bodies); new tunnel-by-default traces only lose ~100-byte meta rows.
    drop = v.drop ? parseCats("--drop", v.drop as string) : new Set(["telemetry", "tokens", "external"]);
  }
  if (drop.has("messages")) {
    log(`dropping "messages" deletes the conversations themselves — that's the 87% of bytes the other tools preserve`, C.yellow);
  }

  const wire = wireTables();
  const categorize = (url: string, client?: string) => categorizeUrl(url, client, wire);
  const plan = planPurge(logDir, drop, categorize);
  if (!plan.files.length) {
    log(`Nothing to purge in ${logDir} (no pairs in: ${[...drop].join(", ")})`, C.green);
    return;
  }
  log(`Dropping categories: ${[...drop].join(", ")}`, C.cyan);
  for (const f of plan.files) {
    const cats = Object.entries(f.dropped).map(([c, n]) => `${n} ${c}`).join(", ");
    const fate = f.empty ? "→ empty, file removed" : `keep ${f.kept}`;
    console.log(`    ${f.name}  ${C.dim}drop ${cats} (${human(f.droppedBytes)}), ${fate}${C.reset}`);
  }
  log(`${plan.droppedCount} pair(s) / ${human(plan.droppedBytes)} of raw trace lines; ${plan.keptCount} pair(s) stay`, C.cyan);
  log(`purge trims rows, not disk — messages dominate trace bytes; for space use 'cctrace compress' (40-60x)`, C.dim);
  if (!v.yes) {
    log(DRY, C.yellow);
    return;
  }
  const res = applyPurge(plan, categorize, drop);
  log(`Rewrote ${res.rewritten.length} trace(s), removed ${res.removed.length}, freed ${human(res.bytes)}`, C.green);
  if (res.skipped.length) {
    log(`Skipped ${res.skipped.length} trace(s) that changed since the plan (live run?): ${res.skipped.join(", ")}`, C.yellow);
  }
}

// `cctrace compact` — aggressive post-hoc shrinking, body-level only (never
// deletes pairs; whole-pair deletion stays purge's job, privacy only).
// Measured design (docs/design/ideas.md #9): ~79% of trace bytes are
// messages request bodies re-sending the conversation; keeping one full
// request per thread-epoch retains everything the session view renders.
function runCompact(args: string[]) {
  const usage = "cctrace compact [--dir DIR] [--zstd] [--yes]";
  const { values: v } = parseStorageArgs("compact", args, { zstd: { type: "boolean" } }, usage);
  const logDir = (v.dir as string) || ".cctrace";
  const wire = wireTables();
  const categorize = (url: string, client?: string) => categorizeUrl(url, client, wire);
  const plan = planCompact(logDir, categorize, wire);
  if (!plan.files.length) {
    log(`Nothing to compact in ${logDir} (no superseded request bodies, no collapsible noise)`, C.green);
    return;
  }
  log(`Compacting ${plan.files.length} trace(s) in ${logDir}:`, C.cyan);
  for (const f of plan.files) {
    const bits = [];
    if (f.stubbed) bits.push(`stub ${f.stubbed} superseded request bodies`);
    if (f.collapsed) bits.push(`collapse ${f.collapsed} noise bodies to meta`);
    console.log(`    ${f.name}  ${C.dim}${bits.join(", ")} — saves ~${human(f.savedBytes)} of ${human(f.size)}${C.reset}`);
  }
  log(`${plan.stubbed} request bodies stubbed (longest per thread-epoch kept full), ${plan.collapsed} noise bodies collapsed (first/last/largest/slowest/errors kept)`, C.cyan);
  log(`known loss: exact wire bytes of superseded requests — mid-epoch system-prompt/tool changes keep only the kept request's version; rewound/edited branch tips are detected and kept full`, C.dim);
  if (!v.yes) {
    log(`Would save ~${human(plan.savedBytes)} of raw trace lines${v.zstd ? ", then zstd-archive" : " (add --zstd to also archive)"}. ${DRY}`, C.yellow);
    return;
  }
  const res = applyCompact(plan, categorize, wire);
  log(`Rewrote ${res.rewritten.length} trace(s), saved ${human(res.bytes)}`, C.green);
  if (res.skipped.length) {
    log(`Skipped ${res.skipped.length} trace(s) that changed since the plan (live run?): ${res.skipped.join(", ")}`, C.yellow);
  }
  if (v.zstd) {
    const cplan = planCompress(logDir, Date.now(), undefined);
    if (cplan.files.length || cplan.upgrades.length) {
      const cres = applyCompress(cplan, { keepJsonl: false });
      const ratio = cres.before > 0 ? (cres.before / Math.max(cres.after, 1)).toFixed(1) : "0";
      log(`Archived ${cres.archived.length} trace(s): ${human(cres.before)} → ${human(cres.after)} (${ratio}x)`, C.green);
      if (cres.skipped.length) log(`Skipped ${cres.skipped.length} live trace(s): ${cres.skipped.join(", ")}`, C.yellow);
    }
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
${C.cyan}cctrace${C.reset} - Trace coding-agent CLI HTTP traffic (Claude Code, Codex, Grok)

${C.yellow}USAGE:${C.reset}
  cctrace [CLIENT] [OPTIONS] [-- CLIENT_ARGS...]
  cctrace <SUBCOMMAND> [ARGS]

  Everything after ${C.cyan}--${C.reset} is passed to the traced CLI verbatim.
  CLIENT picks who gets traced: ${C.cyan}claude${C.reset} (default), ${C.cyan}codex${C.reset}, ${C.cyan}grok${C.reset}.
  Non-Claude clients always use mitm capture.
  Every run writes .cctrace/trace-<ts>.jsonl — that file IS the trace;
  reopen it anytime with ${C.cyan}cctrace view${C.reset}.

${C.yellow}SUBCOMMANDS:${C.reset} ${C.dim}(operate on saved traces; no proxy, no client spawn)${C.reset}
  ${C.cyan}view${C.reset} [target] [--html] [--port N]
                          Reopen a saved trace in the web UI (serves it from
                          a local server; Ctrl-C stops). No target lists the
                          traces and lets you pick (Enter = newest). Target is
                          ${C.cyan}latest${C.reset}, a .jsonl[.zst|.gz] path, a session id, or a
                          trace filename fragment. ${C.cyan}--html${C.reset} writes a self-contained
                          snapshot .html instead (shareable, but huge traces
                          choke browsers).
  ${C.cyan}clean${C.reset}                     Delete regenerable .html snapshots + empty traces.
  ${C.cyan}merge${C.reset} [--prune]           Consolidate each session's pairs into one deduped
                          session-<id>.jsonl; --prune drops merged sources.
  ${C.cyan}compress${C.reset} [--older-than N] [--keep-jsonl]
                          zstd-archive traces, 40-60x on session traces
                          (view reads .zst/.gz directly; upgrades old .gz).
  ${C.cyan}purge${C.reset} [--drop CATS | --keep CATS]
                          Drop categories from saved traces (default drop:
                          telemetry,tokens,external — trims rows/noise, not disk).
  ${C.cyan}compact${C.reset} [--zstd]          Fold redundant bodies in saved traces (-95%+ on real
                          sessions): superseded messages request bodies become
                          stubs (the longest request per thread-epoch stays
                          full — the session view renders identically);
                          telemetry/external/bootstrap collapse to meta-only
                          except first/last/largest/slowest/errors. Loses the
                          exact wire bytes of superseded requests (per-turn
                          "what exactly was sent" diffing). Never deletes
                          pairs. --zstd archives afterwards.
  ${C.cyan}ps${C.reset} [--json]               List live cctrace instances (URL, client, project,
                          session).
  ${C.dim}All take --dir DIR (default .cctrace). clean/merge/compress/purge/compact${C.reset}
  ${C.dim}are dry-run by default; add ${C.reset}${C.cyan}--yes${C.reset}${C.dim} to apply.${C.reset}

${C.yellow}OPTIONS:${C.reset}
  --mode MODE        Capture mode: auto (default), mitm, base-url, node
  -s, --static       Static mode: no live server, write .jsonl + snapshot .html
  -p, --port PORT    Live UI port (default: ${DEFAULT_PORT}, walks up if busy)
  --messages-only    Only capture model API calls
  --capture-external MITM every host (default: non-first-party hosts pass
                     through as opaque byte-counted tunnels). External
                     bodies over 64KB are summarized, not stored
  --intercept-host H Also MITM host H with FULL body capture (repeatable —
                     remote MCP servers, unusual providers)
  --no-open          Don't auto-open browser
  --print-ca         Print the MITM CA cert path and exit
  --log NAME         Custom log file base name
  --dir PATH         Log directory (default: .cctrace)
  --fresh            Don't merge prior traces of a continued session
  --with FILE        Merge a specific trace file into the view (repeatable)
  --claude-path PATH Custom Claude binary path
  --client-path PATH Custom binary path for any client (codex/grok too)
  --data-dir PATH    MITM CA / data dir (default: ~/.local/share/cctrace;
                     or set CCTRACE_DATA_DIR. --cache-dir still works)
  --no-update-check  Skip the daily npm version check + upgrade prompt
                     (or set CCTRACE_NO_UPDATE_CHECK=1)
  -V, --version      Print the cctrace version and exit
  -h, --help         Show this help

${C.yellow}CAPTURE MODES:${C.reset}
  ${C.cyan}mitm${C.reset}      TLS-intercepting proxy. Captures ALL traffic (messages, OAuth,
            usage/credits, MCP, telemetry). Auto-generates a CA trusted via
            NODE_EXTRA_CA_CERTS + a combined bundle for subprocesses.
            ${C.dim}Default for native binaries; the only mode for codex/grok.${C.reset}
  ${C.cyan}base-url${C.reset}  Reverse proxy via ANTHROPIC_BASE_URL. Zero setup, but only
            sees /v1/messages (OAuth/usage bypass it). Claude only.
  ${C.cyan}node${C.reset}      Legacy fetch() injection via node --require. Only works for
            npm-installed (non-native) Claude. ${C.dim}Auto-selected for JS installs.${C.reset}

${C.yellow}EXAMPLES:${C.reset}
  cctrace                          ${C.dim}# Auto mode, capture everything${C.reset}
  cctrace --mode base-url          ${C.dim}# Lightweight, messages only, no CA${C.reset}
  cctrace -s                       ${C.dim}# Static mode (files + snapshot .html)${C.reset}
  cctrace -- --continue            ${C.dim}# Resume last Claude session, traced${C.reset}
  cctrace -- -p "explain this"     ${C.dim}# Claude print mode, traced${C.reset}
  cctrace --mode base-url -- --model opus --continue
  cctrace codex -- exec "fix tests" ${C.dim}# trace the OpenAI Codex CLI${C.reset}
  cctrace grok                      ${C.dim}# trace the Grok CLI${C.reset}
  cctrace view                      ${C.dim}# list traces, pick one (Enter = newest)${C.reset}
  cctrace view latest               ${C.dim}# reopen the newest trace directly${C.reset}
  cctrace view trace-2026-07-08     ${C.dim}# reopen a saved trace (filename fragment)${C.reset}
  cctrace view 4f9a2c1e             ${C.dim}# reopen by Claude Code session id${C.reset}
  cctrace view 4f9a2c1e --html      ${C.dim}# write a shareable snapshot .html instead${C.reset}
  cctrace purge --drop telemetry --yes ${C.dim}# strip telemetry rows from saved traces${C.reset}

  ${C.dim}Note: -p before "--" is cctrace's port; -p after "--" is Claude's print mode.${C.reset}
`);
}

function findClient(): string {
  const custom = values["client-path"] || values["claude-path"];
  return findClientBinary(CLIENT, custom ? resolve(custom) : undefined);
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

/** Run identity for the page header: the project is the cwd the client runs
 * in; `client` is who gets traced (omit when unknown, e.g. view rebuilds —
 * the UI then falls back to per-pair labels). */
function pageMeta(client?: string): PageMeta {
  const cwd = process.cwd();
  const meta: PageMeta = { project: basename(cwd) || cwd, projectPath: cwd, version: CCTRACE_VERSION };
  if (client) meta.client = client;
  if (!NO_UPDATE_CHECK) {
    const latest = availableUpdate(readUpdateCache(DATA_DIR));
    if (latest) meta.latestVersion = latest;
  }
  const pricing = pricingCatalog(DATA_DIR);
  if (pricing) meta.pricing = pricing;
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

function makeLogSink(opts: RunOpts, logFile: string, htmlFile: string, ingest?: (pair: TracePair) => void): LogSink {
  if (!existsSync(opts.logDir)) mkdirSync(opts.logDir, { recursive: true });
  writeFileSync(logFile, "");
  log(`Log: ${logFile}`, C.blue);

  const collected: TracePair[] = [];

  return {
    onPair: (pair: TracePair) => {
      // Label who produced this traffic — the one choke point every pair
      // passes through, so the file and the live UI can't disagree.
      pair.client = CLIENT.name;
      collected.push(pair);
      appendFileSync(logFile, JSON.stringify(pair) + "\n");
      ingest?.(pair);
    },
    // The snapshot merges prior-run pairs of the same Claude session (and any
    // --with files) so a --continue'd session's .html is complete on its own.
    writeHtml: () => {
      let all = collected;
      const extra: TracePair[] = opts.withFiles.length ? loadTraceFiles(opts.withFiles) : [];
      if (!opts.fresh) {
        const sids = new Set(collected.map((p) => extractSessionId(p, wireTables())).filter(Boolean));
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
      const snapHtml = renderSnapshot(all, { ...pageMeta(CLIENT.name), traceFile: basename(logFile) });
      const problem = verifySnapshot(snapHtml, all.length);
      if (problem) log(`warning: snapshot self-check failed: ${problem}`, C.yellow);
      writeFileSync(htmlFile, snapHtml);
      return htmlFile;
    },
  };
}

function spawnClaudeWithCapturer(claudePath: string, claudeArgs: string[], capturer: Capturer, opts: RunOpts, logFile: string, onFinalize?: () => string, onAgentPid?: (pid: number) => void) {
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
  // The client owns the terminal from here to exit (TUI repaints the whole
  // screen; -p writes the result to stdout) — cctrace stays silent, buffering
  // anything it would have said and flushing once the screen is ours again.
  muteTerm();
  if (child.pid && onAgentPid) onAgentPid(child.pid);

  child.on("error", (err) => {
    for (const line of unmuteTerm()) console.log(line);
    capturer.stop();
    log(`Error: ${err.message}`, C.yellow);
    process.exit(1);
  });

  child.on("exit", async (code, signal) => {
    await capturer.flush();
    for (const line of unmuteTerm()) console.log(line);
    log(`Traced ${capturer.pairCount()} request/response pairs`, C.green);
    capturer.stop();
    if (onFinalize) {
      // Static mode: the self-contained snapshot is the deliverable.
      const htmlFile = onFinalize();
      log(`HTML: ${htmlFile}`, C.green);
      if (!opts.noOpen) openBrowser(htmlFile);
    } else {
      log(`Reopen anytime: cctrace view ${logFile}`, C.dim);
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
  let ingest: ((pair: TracePair) => void) | undefined;
  let liveInstance: InstanceHandle | null = null;
  // --continue/--resume: the resumed session id isn't on the wire until the
  // first request, but we can GUESS it now — an explicit `--resume <id>`
  // names it, and --continue almost always means the newest prior session in
  // this log dir. The server preloads the guess so the UI opens populated,
  // then confirms or evicts it on the first live pair.
  let speculateSid: string | undefined;
  if (opts.liveMode && CLIENT.name === "claude" && !opts.fresh && isContinuation(claudeArgs)) {
    const ri = claudeArgs.findIndex((a) => a === "--resume" || a === "-r");
    const resumeArg = ri >= 0 ? claudeArgs[ri + 1] : undefined;
    if (resumeArg && /^[0-9a-f][0-9a-f-]{6,}$/i.test(resumeArg)) speculateSid = resumeArg;
    else speculateSid = newestPriorSessionId(opts.logDir, logFile)?.sid;
  }
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
      speculate: speculateSid,
      meta: { ...pageMeta(CLIENT.name), traceFile: basename(logFile) },
      dataDir: DATA_DIR,
      instanceId,
      self: () => instance?.snapshot() ?? null,
      onSession: (sid) => instance?.update({ sessionId: sid }),
    });
    ingest = server.ingest;
    instance = registerInstance(DATA_DIR, {
      id: instanceId,
      pid: process.pid,
      port: server.port,
      project: pageMeta().project || "",
      projectPath: pageMeta().projectPath || "",
      // Absolute: the tombstone catalog is read from other projects' cwds.
      logFile: resolve(logFile),
      mode,
      client: CLIENT.name,
      startedAt: new Date().toISOString(),
    });
    liveInstance = instance;
    // Capture runs leave a tombstone, not a deletion: the finished run stays
    // findable (view picker's "recent runs elsewhere", future trace library).
    process.on("exit", () => instance?.tombstone());
    log(`Live UI: http://localhost:${server.port}`, C.green);
    if (!opts.noOpen) {
      setTimeout(() => openBrowser(`http://localhost:${server.port}`), 500);
    }
  }

  const sink = makeLogSink(opts, logFile, htmlFile, ingest);
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

  // Tunnel-by-default: only the include-list gets decrypted. The traced
  // client's wire table + base-url env overrides + --intercept-host extras;
  // everything else passes through as a byte-counted opaque tunnel.
  const interceptHosts = buildInterceptSet(CLIENT.wire, {
    env: process.env,
    extraHosts: (values["intercept-host"] as string[] | undefined) || [],
  });
  const capturer = await createCapturer(mode, {
    onPair: sink.onPair,
    logAll: opts.logAll,
    cacheDir: MITM_CA_DIR,
    targetHost,
    interceptHosts,
    captureExternal: !!values["capture-external"],
    onStatus: (msg) => log(msg, C.dim),
  });

  // --continue/--resume: the preload above covers the likely session; when
  // there was nothing to preload, say why the view starts empty.
  if (CLIENT.name === "claude" && !opts.fresh && isContinuation(claudeArgs) && !speculateSid) {
    log("Continuing a session — prior turns merge into Session view on Claude's first request", C.dim);
  }

  // Live mode: the .jsonl is the deliverable — `cctrace view` rebuilds the UI
  // from it anytime, so don't also write a snapshot .html at exit (on big
  // sessions it runs to hundreds of MB). Static mode's whole point is the
  // self-contained .html, so it keeps the finalize step.
  spawnClaudeWithCapturer(
    claudePath, claudeArgs, capturer, opts, logFile,
    opts.liveMode ? undefined : sink.writeHtml,
    (pid) => liveInstance?.update({ agentPid: pid }),
  );
}

async function runNodeMode(claudePath: string, claudeArgs: string[], opts: RunOpts) {
  log("Mode: Node.js --require injection (legacy)", C.blue);

  const preloadPath = await buildPreload();
  const loaderPath = join(dirname(import.meta.path), "loader.cjs");

  let livePort = opts.port;
  // The child process authenticates its /api/pair POSTs with this id.
  const instanceId = crypto.randomUUID();
  if (opts.liveMode) {
    // Legacy mode: the preload names the log file itself, so the server can't
    // exclude it from prior-trace scans — pair-id dedupe covers that instead.
    let instance: InstanceHandle | null = null;
    const server = createServer({
      port: opts.port,
      logDir: opts.logDir,
      noHistory: opts.fresh,
      withFiles: opts.withFiles,
      meta: pageMeta(CLIENT.name),
      dataDir: DATA_DIR,
      instanceId,
      self: () => instance?.snapshot() ?? null,
      onSession: (sid) => instance?.update({ sessionId: sid }),
    });
    livePort = server.port;
    instance = registerInstance(DATA_DIR, {
      id: instanceId,
      pid: process.pid,
      port: livePort,
      project: pageMeta().project || "",
      projectPath: pageMeta().projectPath || "",
      logFile: "",
      mode: "node",
      client: CLIENT.name,
      startedAt: new Date().toISOString(),
    });
    process.on("exit", () => instance?.tombstone());
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
    CCTRACE_INSTANCE_ID: instanceId,
    CCTRACE_LOG_DIR: opts.logDir,
  };
  if (opts.logName) env.CCTRACE_LOG_NAME = opts.logName;

  log(`Tracing: ${opts.logAll ? "ALL requests" : "/v1/messages"}`, C.cyan);
  console.log("");

  const spawnArgs = ["--require", loaderPath, claudePath, ...claudeArgs];
  const child: ChildProcess = spawn("node", spawnArgs, { env, stdio: "inherit", cwd: process.cwd() });
  muteTerm();

  child.on("error", (err) => {
    for (const line of unmuteTerm()) console.log(line);
    log(`Error: ${err.message}`, C.yellow);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    for (const line of unmuteTerm()) console.log(line);
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
    if (SUBCOMMAND === "view") {
      if (await runView(rest)) return; // serving: the web server keeps us alive
    }
    else if (SUBCOMMAND === "clean") runClean(rest);
    else if (SUBCOMMAND === "merge") runMerge(rest);
    else if (SUBCOMMAND === "compress") runCompress(rest);
    else if (SUBCOMMAND === "purge") runPurge(rest);
    else if (SUBCOMMAND === "compact") runCompact(rest);
    else if (SUBCOMMAND === "ps") await runPs(rest);
    process.exit(0);
  }

  if (values.version) {
    console.log(`cctrace v${versionWithCommit()}`);
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

  log(`cctrace v${versionWithCommit()}`, C.dim);
  await maybeOfferUpdate();
  // Refresh the update cache in the background — never blocks the session.
  if (!NO_UPDATE_CHECK) refreshUpdateCache(DATA_DIR).catch(() => {});
  refreshPricingCache(DATA_DIR).catch(() => {});

  const clientPath = findClient();
  log(`${CLIENT.name === "claude" ? "Claude" : CLIENT.name}: ${clientPath}`, C.blue);
  if (claudeArgs.length) log(`${CLIENT.name} args: ${claudeArgs.join(" ")}`, C.blue);

  // Non-Claude clients (codex, grok) always run mitm: base-url rides
  // ANTHROPIC_BASE_URL and node mode injects into Claude's fetch — both are
  // Claude-specific plumbing. The mitm side needs neither; HTTPS_PROXY plus
  // the combined CA bundle (#17) cover Rust/Go/Node clients alike.
  if (CLIENT.name !== "claude") {
    if (requestedMode && requestedMode !== "auto" && requestedMode !== "mitm") {
      console.error(`[cctrace] Error: --mode ${requestedMode} only applies to Claude — ${CLIENT.name} is traced via mitm.`);
      process.exit(1);
    }
    await runProxyCapture("mitm", clientPath, claudeArgs, opts);
    return;
  }

  const { mode, runPath } = resolveMode(clientPath);

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
