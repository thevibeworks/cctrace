#!/usr/bin/env bun

import { basename, dirname, join, relative, resolve } from "path";
import { mkdirSync, existsSync, unlinkSync, appendFileSync, writeFileSync, statSync, readFileSync } from "fs";
import { spawn, type ChildProcess } from "child_process";
import { createServer, renderSnapshot, verifySnapshot } from "./server";
import { createCapturer, traceIdentityEnv, bypassHostEnv, type CaptureMode, type Capturer } from "./capture";
import { isNativeBinary, resolveClaudeBashWrapper } from "./detect";
import { ensureCerts, migrateCaDir, buildInterceptSet } from "./certs";
import { parseCliArgs, CliUsageError } from "./args";
import { loadPriorPairs, loadTraceFiles, newestPriorSessionId, readTracePairs } from "./history";
import { createSpecAccumulator, diffSpecCatalogs, renderSpecDiff, renderSpecMarkdown } from "./spec";
import { extractSessionId } from "./summarize";
import { termWrite, muteTerm, unmuteTerm } from "./termlog";
import { writeView, resolveView, applySlice, followTrace, listTraceInfos, peekTrace, findTraceCarrier, truncationNotice, ViewError } from "./view";
import {
  resolveTraceDirs, ensureProjectDir, projectTraceDir, projectPathOf, listStoreProjects, storeRoot,
  registryLegacyDirs, scanLegacyDirs, planAdopt, applyAdopt, liveLogFiles, parseRebase, LEGACY_DIRNAME, type TraceDirs, type Rebase,
} from "./store";
import { registerInstance, listLiveInstances, listPastRuns, listAllRuns, SCAN_PORTS, DEFAULT_PORT, PORT_WALK, type InstanceHandle, type InstanceInfo } from "./instances";
import { CLIENTS, findClientBinary, wireTables } from "./clients";
import {
  CCTRACE_VERSION, NPM_PACKAGE, readUpdateCache, writeUpdateCache, refreshUpdateCache, availableUpdate,
  versionWithCommit,
} from "./version";
import type { PageMeta } from "./ui";
import { pricingCatalog, refreshPricingCache } from "./pricing-catalog";
import {
  planClean, applyClean, planMerge, applyMerge, planCompress, applyCompress,
  planPurge, applyPurge, purgePairsById, human, archiveTrace, planStaleSweep, type MergeProgress, type ArchiveStamp,
} from "./storage";
import { planCompact, applyCompact } from "./compact";
import { CATEGORIES, categorizeUrl } from "./categorize";
import { traceSummary, type TraceStats } from "./report";
import { setIdentityRedaction } from "./redact";
import { parseArgs } from "util";
import type { TracePair } from "./types";

// Live-UI port: DEFAULT_PORT (8722 — TRAC on a phone keypad) lives in
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
const SUBCOMMANDS = new Set(["view", "clean", "merge", "compress", "purge", "compact", "ps", "spec", "history", "store", "adopt"]);
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
  const usage = "usage: cctrace view [file.jsonl[.zst|.gz] | session-id | latest] [--tail] [--full] [--html] [--slice a..b] [--port N] [--dir DIR] [--no-open]";
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        dir: { type: "string" },
        "no-open": { type: "boolean" },
        html: { type: "boolean" },
        serve: { type: "boolean" }, // legacy alias of the default
        tail: { type: "boolean" },  // follow the trace file live (tail -f the .jsonl)
        live: { type: "boolean" },  // alias of --tail
        slice: { type: "string" },  // pair-id window: the @a..b of a slice deep link
        full: { type: "boolean" },  // every pair, not just the newest 256 MB of lines
        port: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    console.error(`[cctrace] view: ${(err as Error).message}\n  ${usage}`);
    process.exit(1);
  }
  const dirs = traceDirsFor(parsed.values.dir as string | undefined);
  const logDir = dirs.readDirs;
  let target = parsed.positionals[0];
  // No target: show what's viewable instead of demanding a filename the
  // user has no way to know. On a TTY, let them pick; Enter opens the
  // newest — the answer they almost always want.
  if (!target) {
    const infos = listTraceInfos(logDir);
    // The run catalog (registry tombstones) knows about traces in OTHER
    // projects — list recent ones after this dir's, resolvable by number.
    // Re-resolve before offering: a tombstone written in another container
    // may name a path that doesn't resolve here (list nothing, never error).
    const localDirs = new Set(logDir.map((d) => resolve(d)));
    const seen = new Set<string>();
    const elsewhere: (InstanceInfo & { carrier: string })[] = [];
    for (const r of listPastRuns(DATA_DIR)) {
      if (elsewhere.length >= 8) break;
      if (!r.logFile || localDirs.has(resolve(dirname(r.logFile))) || seen.has(r.logFile)) continue;
      seen.add(r.logFile);
      const carrier = findTraceCarrier(r.logFile, r.sessionId, r.projectPath ? projectTraceDir(DATA_DIR, r.projectPath) : undefined);
      if (carrier && !localDirs.has(resolve(dirname(carrier.path)))) elsewhere.push({ ...r, carrier: carrier.path });
    }
    if (!infos.length && !elsewhere.length) {
      console.error(`[cctrace] view: no .jsonl traces in ${logDir.join(", ")}\n  ${usage}`);
      process.exit(1);
    }
    const shown = infos.slice(0, 15);
    const snip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
    if (shown.length) {
      // Identity-first rows: a timestamp filename says nothing when a dozen
      // sessions ran today. The registry stamped client/session/first-prompt
      // at capture time (0.25+); older traces get a bounded head-read.
      const byLog = new Map<string, InstanceInfo>();
      for (const r of listAllRuns(DATA_DIR)) {
        if (!r.logFile) continue;
        const key = resolve(r.logFile);
        const prev = byLog.get(key);
        if (!prev || (!prev.firstPrompt && r.firstPrompt)) byLog.set(key, r);
      }
      log(`traces in ${logDir.join(" + ")} (newest first):`, C.cyan);
      for (const [i, t] of shown.entries()) {
        const reg = byLog.get(resolve(t.path));
        const peek = reg?.client && reg?.sessionId && reg?.firstPrompt ? {} : await peekTrace(t.path);
        const client = reg?.client || peek.client || "";
        const sid = (reg?.sessionId || peek.sessionId || "").slice(0, 8);
        const prompt = reg?.firstPrompt || peek.prompt || "";
        const who = prompt ? `"${snip(prompt, 46)}"` : t.base;
        console.log(
          `  ${String(i + 1).padStart(2)}  ${client.padEnd(6)} ${(sid || "-").padEnd(8)} ` +
          `${who.padEnd(48)} ${human(t.size).padStart(8)}  ${ago(t.mtimeMs)}`,
        );
      }
      if (infos.length > shown.length) console.log(`      ... ${infos.length - shown.length} more`);
    }
    if (elsewhere.length) {
      log(`recent runs elsewhere:`, C.cyan);
      elsewhere.forEach((r, i) => {
        const when = r.endedAt ? ago(Date.parse(r.endedAt)) : "";
        const label = `${r.project || "?"}${r.client ? ` (${r.client})` : ""}`;
        const who = r.firstPrompt ? `"${snip(r.firstPrompt, 34)}"` : basename(r.logFile);
        console.log(
          `  ${String(shown.length + i + 1).padStart(2)}  ${label.padEnd(28)} ${who.padEnd(36)} ${when}`,
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
    else if (n > shown.length && n <= shown.length + elsewhere.length) target = elsewhere[n - shown.length - 1]!.carrier;
    else if (n > 0) { console.error(`[cctrace] view: no trace #${n}`); process.exit(1); }
    else target = answer; // free-form: fragment / session id / path
  }
  try {
    refreshPricingCache(DATA_DIR).catch(() => {});
    const tailBytes = parsed.values.full ? Infinity : undefined;
    if (!parsed.values.html) {
      await serveView(target, dirs, {
        port: parsed.values.port ? parseInt(parsed.values.port as string, 10) : DEFAULT_PORT,
        noOpen: !!parsed.values["no-open"],
        slice: parsed.values.slice as string | undefined,
        tail: !!(parsed.values.tail || parsed.values.live),
        tailBytes,
      });
      return true;
    }
    const result = await writeView(target, logDir, { pricing: pricingCatalog(DATA_DIR) }, { slice: parsed.values.slice as string | undefined, projectPath: viewProjectRoot(dirs), tailBytes });
    log(`Rebuilt ${result.pairs.length} pairs from ${result.sources.join(", ")}`, C.cyan);
    if (result.truncated) log(truncationNotice(result), C.yellow);
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

// `cctrace spec [target] [--out FILE] [--md] [--diff CATALOG.json]` — the
// observed-wire catalog: endpoints, methods, header names, body field
// shapes, SSE event types, each with sample counts and first/last-seen
// stamps. Observations with provenance, never inferred truth (no OpenAPI
// guessing); values are redacted except content-negotiation headers and
// model ids. No target = every trace in the log dir (the catalog gets
// better with more observations). --diff compares against a previously
// written catalog and prints what changed — the changelog of the wire.
async function runSpec(args: string[]) {
  const usage =
    "usage: cctrace spec [file.jsonl[.zst|.gz] | session-id | latest] [--dir DIR] [--out FILE] [--md] [--diff CATALOG.json]";
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        dir: { type: "string" },
        out: { type: "string" },
        md: { type: "boolean" },
        diff: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    console.error(`[cctrace] spec: ${(err as Error).message}\n  ${usage}`);
    process.exit(1);
  }
  const logDir = traceDirsFor(parsed.values.dir as string | undefined).readDirs;
  const target = parsed.positionals[0];
  // Fold traces into the catalog ONE FILE AT A TIME — a log dir of multi-GB
  // session traces cannot be held as pairs all at once (a real dir OOM'd
  // the process, exit 137). The accumulator keeps only counters and shapes.
  const acc = createSpecAccumulator({ generator: `cctrace ${CCTRACE_VERSION}` });
  let sourceCount = 0;
  try {
    if (target) {
      const result = await resolveView(target, logDir, { tailBytes: Infinity });
      acc.add(result.pairs);
      sourceCount = result.sources.length;
    } else {
      const infos = listTraceInfos(logDir);
      if (!infos.length) {
        console.error(`[cctrace] spec: no .jsonl traces in ${logDir.join(", ")}\n  ${usage}`);
        process.exit(1);
      }
      for (const t of infos) {
        try {
          acc.add((await readTracePairs(t.path, { tailBytes: Infinity })).pairs);
          sourceCount++;
        } catch {
          // unreadable trace: the catalog is built from what opens
        }
      }
    }
  } catch (err) {
    if (err instanceof ViewError) {
      console.error(`[cctrace] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const catalog = acc.finish();
  // Summary to stderr: stdout is the artifact (pipeable).
  console.error(
    `[cctrace] spec: ${catalog.pairsScanned} pairs from ${sourceCount} trace(s) -> ` +
      `${catalog.endpoints.length} endpoints`,
  );
  if (parsed.values.diff) {
    let prev;
    try {
      prev = JSON.parse(readFileSync(parsed.values.diff as string, "utf8"));
    } catch (err) {
      console.error(`[cctrace] spec: cannot read ${parsed.values.diff}: ${(err as Error).message}`);
      process.exit(1);
    }
    console.log(renderSpecDiff(diffSpecCatalogs(prev, catalog)));
    return;
  }
  const text = parsed.values.md ? renderSpecMarkdown(catalog) : JSON.stringify(catalog, null, 2);
  if (parsed.values.out) {
    writeFileSync(parsed.values.out as string, text);
    log(`wrote ${parsed.values.out}`, C.green);
  } else {
    process.stdout.write(text + "\n");
  }
}

// The --serve half of `cctrace view`: same target resolution, but the pairs
// are seeded into the live web server instead of embedded in a file. The run
// registers in the instance registry like any live capture (mode "view"), so
// `cctrace ps` and the header switcher see it. Ctrl-C stops it.
async function serveView(target: string, dirs: TraceDirs, opts: { port: number; noOpen: boolean; slice?: string; tail?: boolean; tailBytes?: number }) {
  const logDir = dirs.writeDir;
  const result = await resolveView(target, dirs.readDirs, { tailBytes: opts.tailBytes });
  if (opts.slice) result.pairs = applySlice(result.pairs, opts.slice);
  // --tail follows plain .jsonl files only: archives can't grow, and a
  // slice is a closed window — both quietly fall back to a static view.
  const tailPaths = opts.tail && !opts.slice
    ? result.sourcePaths.filter((p) => /\.jsonl$/.test(p))
    : [];
  const tailing = tailPaths.length > 0;
  if (opts.tail && !tailing) log("--tail: no plain .jsonl source to follow (archive or slice) — serving static view", C.yellow);
  log(`Rebuilt ${result.pairs.length} pairs from ${result.sources.join(", ")}` +
    (opts.slice ? ` (slice ${opts.slice})` : ""), C.cyan);
  if (result.truncated) log(truncationNotice(result), C.yellow);
  for (const w of result.warnings) log(`warning: ${w}`, C.yellow);

  const traceName = (result.sources[0] || target).replace(/\.jsonl(\.zst|\.gz)?$/, "");
  // The header shows <project>/<trace-file>: the project is the traced
  // repo — the cwd (whose store dir this is), a legacy ./.cctrace's parent,
  // or the marker of an explicit --dir. projectPath must be that repo root
  // too — the UI relativizes tool-call file paths against it (wsRoot).
  const projectRoot = viewProjectRoot(dirs);
  const viewProject = basename(projectRoot);
  const viewTrace = basename(result.sources[0] || target);
  const viewTracePath = result.sourcePaths[0] || join(logDir, viewTrace);
  // The rebuilt pairs know who produced them (0.13+ traces); older traces
  // carry no label and the header degrades to project-only.
  const client = result.pairs.findLast((p) => p.client)?.client;
  const instanceId = crypto.randomUUID();
  let instance: InstanceHandle | null = null;
  const server = createServer({
    port: opts.port,
    logDir,
    meta: {
      ...pageMeta(client), project: viewProject, projectPath: projectRoot,
      traceFile: viewTrace, traceRelPath: traceRelPath(projectRoot, viewTracePath),
      mode: tailing ? "tail" : "view",
    },
    dataDir: DATA_DIR,
    instanceId,
    initialPairs: result.pairs,
    traceSize: () => {
      let n = 0;
      for (const p of result.sourcePaths) { try { n += statSync(p).size; } catch {} }
      return n;
    },
    self: () => instance?.snapshot() ?? null,
    onPurge: (removed) => {
      const res = purgePairsById(result.sourcePaths, new Set(removed.map((p) => p.id)));
      const touched = res.rewritten.concat(res.removed);
      log(`web purge: dropped ${res.droppedCount} pair(s) from ${touched.join(", ") || "no file"}` +
        (res.skipped.length ? ` — skipped ${res.skipped.join(", ")}` : ""), C.yellow);
      return { files: touched, skippedFiles: res.skipped };
    },
  });
  instance = registerInstance(DATA_DIR, {
    id: instanceId,
    pid: process.pid,
    port: server.port,
    project: traceName,
    projectPath: projectRoot,
    logFile: resolve(viewTracePath),
    mode: "view",
    client,
    startedAt: new Date().toISOString(),
  });
  if (tailing) {
    // Follow each source from its current end — the initial load already
    // holds everything before it; the server's knownIds dedups overlap.
    for (const p of tailPaths) {
      let off = 0;
      try { off = statSync(p).size; } catch {}
      followTrace(p, off, (pairs) => { for (const pr of pairs) server.ingest(pr); });
    }
  }
  process.on("exit", () => instance?.unregister());
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  log(`Serving ${result.sources.join(", ")} at http://localhost:${server.port}/trace${tailing ? " — tailing live" : ""} — Ctrl-C to stop`, C.green);
  if (!opts.noOpen) setTimeout(() => openBrowser(`http://localhost:${server.port}/trace`), 300);
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
    url: `http://localhost:${i.port}/trace`,
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
  // Any instance serves the same central picture — the registry is shared.
  log(`Dashboard (all runs): http://localhost:${list[0]!.port}/dashboard`, C.dim);
}

// `cctrace history` — the global run log: every traced run this data dir
// knows about (live runs + tombstones), newest first, across all projects
// and containers sharing the dir. `ps` answers "what's running"; history
// answers "what ran".
/** Where a registry entry's trace lives now, store fallback included. */
function carrierOf(r: InstanceInfo) {
  return r.logFile ? findTraceCarrier(r.logFile, r.sessionId, r.projectPath ? projectTraceDir(DATA_DIR, r.projectPath) : undefined) : null;
}

async function runHistory(args: string[]) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { json: { type: "boolean" }, all: { type: "boolean" }, limit: { type: "string" }, "data-dir": { type: "string" } },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    console.error(`[cctrace] history: ${(err as Error).message}\n  usage: cctrace history [--limit N | --all] [--json] [--data-dir PATH]`);
    process.exit(1);
  }
  const dataDir = parsed.values["data-dir"] ? resolve(parsed.values["data-dir"] as string) : DATA_DIR;
  const live = await listLiveInstances(dataDir, { scanPorts: SCAN_PORTS });
  const liveIds = new Set(live.map((i) => i.id).filter(Boolean));
  const past = listPastRuns(dataDir).filter((i) => !liveIds.has(i.id));
  // Global recency, not the picker's project grouping: "what did I trace
  // last" is a timeline question. A run's moment is when it was last alive.
  const seen = (i: InstanceInfo) => i.endedAt || i.startedAt || "";
  const runs = [...live.map((i) => ({ ...i, live: true })), ...past.map((i) => ({ ...i, live: false }))]
    .sort((a, b) => seen(b).localeCompare(seen(a)));
  const limit = parsed.values.all ? runs.length : Math.max(1, parseInt((parsed.values.limit as string) || "30", 10));
  const shown = runs.slice(0, limit);
  if (parsed.values.json) {
    console.log(JSON.stringify(shown.map((r) => ({ ...r, traceHere: !!carrierOf(r) })), null, 2));
    return;
  }
  if (!shown.length) {
    log("No traced runs recorded yet", C.dim);
    return;
  }
  const when = (iso: string) => {
    if (!iso) return "?";
    const d = new Date(iso);
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const rows = shown.map((r) => ({
    when: when(seen(r)),
    state: r.live ? "live" : "-",
    client: r.client || "-",
    project: r.project || "?",
    session: r.sessionId ? r.sessionId.slice(0, 8) : "-",
    prompt: (r.firstPrompt || "").replace(/\s+/g, " ").slice(0, 48),
    // A tombstone from another container may name a trace that doesn't
    // resolve here — list it (it happened), but dimmed as not-openable.
    here: !!carrierOf(r),
  }));
  const w = (k: "when" | "state" | "client" | "project" | "session", h: string) => Math.max(h.length, ...rows.map((r) => r[k].length));
  const widths = { when: w("when", "WHEN"), state: w("state", "STATE"), client: w("client", "CLIENT"), project: w("project", "PROJECT"), session: w("session", "SESSION") };
  const line = (r: { when: string; state: string; client: string; project: string; session: string; prompt: string }) =>
    `  ${r.when.padEnd(widths.when)}  ${r.state.padEnd(widths.state)}  ${r.client.padEnd(widths.client)}  ${r.project.padEnd(widths.project)}  ${r.session.padEnd(widths.session)}  ${r.prompt}`;
  console.log(C.dim + line({ when: "WHEN", state: "STATE", client: "CLIENT", project: "PROJECT", session: "SESSION", prompt: "PROMPT" }) + C.reset);
  for (const r of rows) console.log(r.here ? line(r) : C.dim + line(r) + C.reset);
  if (runs.length > shown.length) log(`… ${runs.length - shown.length} older run(s) — --all shows everything`, C.dim);
  log(`Open one: cctrace view <SESSION>`, C.dim);
  if (live.length) log(`Dashboard (all runs): http://localhost:${live[0]!.port}/dashboard`, C.dim);
}

// `cctrace store` — where traces live and what they cost: the store root,
// one row per project (biggest first), plain-vs-archived counts, the total.
// The answer to "where did 73 GB go" in one screen (docs/design/store.md).
function runStore(args: string[]) {
  let parsed;
  try {
    parsed = parseArgs({ args, options: { json: { type: "boolean" }, "data-dir": { type: "string" } }, allowPositionals: false, strict: true });
  } catch (err) {
    console.error(`[cctrace] store: ${(err as Error).message}\n  usage: cctrace store [--json] [--data-dir PATH]`);
    process.exit(1);
  }
  const dataDir = parsed.values["data-dir"] ? resolve(parsed.values["data-dir"] as string) : DATA_DIR;
  const projects = listStoreProjects(dataDir);
  const total = projects.reduce((n, p) => n + p.bytes, 0);
  const raw = projects.reduce((n, p) => n + p.raw, 0);
  if (parsed.values.json) {
    console.log(JSON.stringify({ root: storeRoot(dataDir), bytes: total, projects }, null, 2));
    return;
  }
  log(`Store: ${storeRoot(dataDir)}`, C.cyan);
  if (!projects.length) {
    log(`Empty — the next traced run writes here. Legacy ./.cctrace dirs move in with: cctrace adopt`, C.dim);
    return;
  }
  const rows = projects.map((p) => ({
    size: human(p.bytes),
    traces: String(p.traces) + (p.raw ? ` (${p.raw} raw)` : ""),
    when: p.newestMs ? ago(p.newestMs) : "-",
    project: p.projectPath ?? p.key,
  }));
  const w = (k: "size" | "traces" | "when", h: string) => Math.max(h.length, ...rows.map((r) => r[k].length));
  const widths = { size: w("size", "SIZE"), traces: w("traces", "TRACES"), when: w("when", "NEWEST") };
  const line = (r: { size: string; traces: string; when: string; project: string }) =>
    `  ${r.size.padStart(widths.size)}  ${r.traces.padEnd(widths.traces)}  ${r.when.padEnd(widths.when)}  ${r.project}`;
  console.log(C.dim + line({ size: "SIZE", traces: "TRACES", when: "NEWEST", project: "PROJECT" }) + C.reset);
  for (const r of rows) console.log(line(r));
  log(`${human(total)} across ${projects.length} project(s)` + (raw ? ` — ${raw} plain .jsonl not yet archived: cctrace compress --all` : ""), C.cyan);
  log(`Reclaim: cctrace clean --all · cctrace compress --all · rm -rf <a project dir above>`, C.dim);
}

// `cctrace adopt [DIR...] [--scan ROOT] [--rebase FROM=TO] [--copy] [--zst]
// [--yes]` — move legacy ./.cctrace dirs into the store. No DIR = the cwd's
// plus every legacy dir the registry knows that resolves here; --scan walks
// a tree; --rebase names legacy dirs mounted from another machine by that
// machine's paths; --copy leaves the sources; --zst archives plain traces on
// the way in (streamed, decode-verified). Dry-run by default.
async function runAdopt(args: string[]) {
  const usage = "cctrace adopt [DIR...] [--scan ROOT] [--rebase FROM=TO] [--copy] [--zst] [--yes]";
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { scan: { type: "string", multiple: true }, rebase: { type: "string" }, copy: { type: "boolean" }, zst: { type: "boolean" }, yes: { type: "boolean" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    console.error(`[cctrace] adopt: ${(err as Error).message}\n  usage: ${usage}`);
    process.exit(1);
  }
  let rebase: Rebase | null = null;
  if (parsed.values.rebase != null) {
    rebase = parseRebase(parsed.values.rebase as string);
    if (!rebase) {
      console.error(`[cctrace] adopt: --rebase wants FROM=TO (e.g. --rebase ./mounts=/Users/me/wrk)\n  usage: ${usage}`);
      process.exit(1);
    }
    log(`Rebase: ${rebase.from} → ${rebase.to} (project paths + store keys as that host names them)`, C.dim);
  }
  const candidates = new Set<string>();
  for (const d of parsed.positionals) candidates.add(resolve(d));
  for (const root of (parsed.values.scan as string[] | undefined) ?? []) {
    log(`Scanning ${resolve(root)} for ${LEGACY_DIRNAME}/ dirs…`, C.dim);
    for (const d of scanLegacyDirs(root)) candidates.add(d);
  }
  if (!parsed.positionals.length && !parsed.values.scan) {
    candidates.add(join(process.cwd(), LEGACY_DIRNAME));
    for (const d of registryLegacyDirs(DATA_DIR)) candidates.add(d);
  }
  const plan = await planAdopt(DATA_DIR, [...candidates], { rebase, copy: !!parsed.values.copy, archive: !!parsed.values.zst });
  const verb = plan.copy ? "copy" : "move";
  if (!plan.dirs.length) {
    log(`Nothing to adopt — no legacy ${LEGACY_DIRNAME}/ dir with traces resolves here` +
      (plan.absent.length && parsed.positionals.length ? ` (checked ${plan.absent.length})` : "") +
      `. Name dirs, or --scan ROOT to walk a tree.`, C.green);
    return;
  }
  log(`${plan.dirs.length} legacy dir(s), ${plan.files} file(s), ${human(plan.bytes)} → ${storeRoot(DATA_DIR)}:`, C.cyan);
  for (const d of plan.dirs) {
    console.log(`    ${d.legacyDir}  ${C.dim}${d.moves.length} file(s), ${human(d.bytes)} → ${basename(d.targetDir)}/${C.reset}`);
    for (const sk of d.skipped) console.log(`      ${C.dim}keep ${sk.name} — ${sk.reason}${C.reset}`);
  }
  if (!parsed.values.yes) {
    log(`Would ${verb} ${plan.files} file(s) (${human(plan.bytes)})` +
      (parsed.values.zst ? "; plain traces arrive as verified .zst (30-180x smaller)" : plan.copy ? "" : "; same-disk moves are instant renames") + `. ${DRY}`, C.yellow);
    return;
  }
  const res = await applyAdopt(DATA_DIR, plan, (m, i, n) => {
    if (m.size >= 16 * 1024 * 1024) console.log(`    ${C.dim}[${i}/${n}] ${m.archive ? "archiving" : verb + "ing"} ${m.name} (${human(m.size)})${C.reset}`);
  });
  log(`${plan.copy ? "Copied" : "Moved"} ${res.moved.length} file(s), ${human(res.bytes)}` +
    (res.storedBytes !== res.bytes ? ` → ${human(res.storedBytes)} on disk (${(res.bytes / Math.max(res.storedBytes, 1)).toFixed(0)}x)` : "") +
    (res.removedDirs.length ? `; removed ${res.removedDirs.length} empty legacy dir(s)` : "") +
    (res.repointed ? `; re-pointed ${res.repointed} registry entr${res.repointed === 1 ? "y" : "ies"}` : ""), C.green);
  if (res.skipped.length) log(`Kept ${res.skipped.length} file(s): ${res.skipped.map((k) => `${k.name} (${k.reason})`).join(", ")}`, C.yellow);
  log(`Next: cctrace compress --all --yes  (archives plain traces 40-90x)`, C.dim);
}

/** Parse a storage subcommand's flags; exit(1) with usage on error. */
function parseStorageArgs(
  cmd: string,
  args: string[],
  options: Record<string, { type: "string" | "boolean" }>,
  usage: string,
) {
  try {
    return parseArgs({ args, options: { dir: { type: "string" }, all: { type: "boolean" }, yes: { type: "boolean" }, ...options }, allowPositionals: true, strict: true });
  } catch (err) {
    console.error(`[cctrace] ${cmd}: ${(err as Error).message}\n  usage: ${usage}`);
    process.exit(1);
  }
}

const DRY = `${C.yellow}dry run${C.reset} — re-run with ${C.cyan}--yes${C.reset} to apply`;

/**
 * The dir(s) a housekeeping command acts on: --dir DIR as given; --all =
 * every project dir in the store (headed per dir so the output stays
 * attributable); default = this project's store dir, plus a legacy
 * ./.cctrace when one still holds traces (headed the same way).
 */
async function forStorageDirs(v: { dir?: string; all?: boolean }, fn: (logDir: string) => void | Promise<void>): Promise<void> {
  let dirs: string[];
  if (v.all) {
    dirs = listStoreProjects(DATA_DIR).map((p) => p.dir);
    if (!dirs.length) { log(`Store is empty: ${storeRoot(DATA_DIR)}`, C.dim); return; }
  } else {
    dirs = traceDirsFor(v.dir).readDirs;
  }
  for (const d of dirs) {
    if (dirs.length > 1) log(`== ${projectPathOf(d) ?? d}`, C.cyan);
    await fn(d);
  }
}

// `cctrace clean` — delete regenerable .html snapshots and 0-byte aborted
// traces. Never touches conversation data.
async function runClean(args: string[]) {
  const { values: v } = parseStorageArgs("clean", args, {}, "cctrace clean [--dir DIR | --all] [--yes]");
  await forStorageDirs(v, async (logDir) => {
    const plan = planClean(logDir);
    if (!plan.htmls.length && !plan.empties.length && !plan.tmps.length) {
      log(`Nothing to clean in ${logDir} (no .html snapshots, no empty traces, no orphaned .tmp)`, C.green);
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
    if (plan.tmps.length) {
      log(`${plan.tmps.length} orphaned .tmp file(s) from an interrupted merge/compress (idle > 1h):`, C.cyan);
      for (const f of plan.tmps) console.log(`    ${f.name}  ${C.dim}${human(f.size)}${C.reset}`);
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
  });
}

// `cctrace merge` — consolidate each session's pairs (across --continue runs)
// into one deduped session-<id>.jsonl. --prune also removes fully-merged
// source traces (never one carrying un-attributable utility pairs).
async function runMerge(args: string[]) {
  const { values: v } = parseStorageArgs("merge", args, { prune: { type: "boolean" } }, "cctrace merge [--dir DIR | --all] [--prune] [--yes]");
  await forStorageDirs(v, async (logDir) => {
    const onProgress = mergeProgressPrinter();
    const plan = planMerge(logDir, { onProgress });
    for (const b of plan.blocked) {
      log(`Skipped ${b.outName}: ${b.reason} — merge never overwrites what it can't fully read`, C.yellow);
    }
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
    const res = applyMerge(plan, { prune: !!v.prune, onProgress });
    log(`Wrote ${res.written.length} merged session file(s)`, C.green);
    if (res.pruned.length) log(`Pruned ${res.pruned.length} source(s), freed ${human(res.bytes)}`, C.green);
    if (res.skipped.length) {
      log(`Kept ${res.skipped.length} source(s) that grew since the plan (live run?): ${res.skipped.join(", ")}`, C.yellow);
    }
  });
}

// `cctrace compress` — zstd-archive .jsonl traces; view reads .zst (and
// legacy .gz) transparently. Session traces are mostly re-sent conversation
// prefixes, which zstd's long window compresses 40-60x where gzip got 3x.
// --older-than N limits to traces older than N days.
async function runCompress(args: string[]) {
  const { values: v } = parseStorageArgs(
    "compress", args,
    { "older-than": { type: "string" }, "keep-jsonl": { type: "boolean" } },
    "cctrace compress [--dir DIR | --all] [--older-than DAYS] [--keep-jsonl] [--yes]",
  );
  await forStorageDirs(v, async (logDir) => {
    const olderThan = v["older-than"] != null ? parseInt(v["older-than"] as string, 10) : undefined;
    if (olderThan != null && (isNaN(olderThan) || olderThan < 0)) {
      console.error("[cctrace] compress: --older-than needs a non-negative number of days");
      process.exit(1);
    }
    // Live runs' files (heartbeat-fresh registry entries) are never planned:
    // an idle-but-live session's trace would otherwise archive and unlink
    // under it (safe — the next append recreates it and exit unions — but
    // pointless churn, and worse with --all sweeping every project).
    const plan = planCompress(logDir, Date.now(), olderThan, liveLogFiles(DATA_DIR));
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
    const res = await applyCompress(plan, { keepJsonl: !!v["keep-jsonl"], onProgress: compressProgressPrinter() });
    for (const a of res.archived) {
      console.log(`    ${a.name.replace(/\.gz$/, "")}.zst  ${C.dim}${human(a.before)} → ${human(a.after)}${C.reset}`);
    }
    const ratio = res.before > 0 ? (res.before / Math.max(res.after, 1)).toFixed(1) : "0";
    log(`Archived ${res.archived.length} trace(s): ${human(res.before)} → ${human(res.after)} (${ratio}x), saved ${human(res.before - res.after)}`, C.green);
    if (res.skipped.length) {
      log(`Skipped ${res.skipped.length} trace(s) that changed since the plan (live run?): ${res.skipped.join(", ")}`, C.yellow);
    }
  });
}

// `cctrace purge` — drop whole categories of pairs from saved traces. The
// default set (telemetry + count_tokens) is the noise: on a real large trace
// it's ~45% of rows but only ~9% of bytes, so the summary is explicit about
// rows vs disk — `compress` is the space tool, purge is the noise tool.
async function runPurge(args: string[]) {
  const usage = "cctrace purge [--dir DIR | --all] [--drop CATS] [--keep CATS] [--yes]";
  const { values: v } = parseStorageArgs(
    "purge", args,
    { drop: { type: "string" }, keep: { type: "string" } },
    usage,
  );
  await forStorageDirs(v, async (logDir) => {
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
  });
}

// `cctrace compact` — aggressive post-hoc shrinking, body-level only (never
// deletes pairs; whole-pair deletion stays purge's job, privacy only).
// Measured design (docs/design/ideas.md #9): ~79% of trace bytes are
// messages request bodies re-sending the conversation; keeping one full
// request per thread-epoch retains everything the session view renders.
async function runCompact(args: string[]) {
  const usage = "cctrace compact [--dir DIR | --all] [--zstd] [--yes]";
  const { values: v } = parseStorageArgs("compact", args, { zstd: { type: "boolean" } }, usage);
  await forStorageDirs(v, async (logDir) => {
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
    log(`known loss: exact wire bytes of superseded requests — mid-epoch system-prompt/tool changes keep only the kept request's version, and a stubbed turn's request meta (stream/max_tokens/temperature/tools/system counts) is gone from the Sessions view + spec; rewound/edited branch tips are detected and kept full`, C.dim);
    log(`note: traces archived as .zst already compress this redundancy 30-180x — compact rarely earns its loss on an archived store`, C.dim);
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
      const cplan = planCompress(logDir, Date.now(), undefined, liveLogFiles(DATA_DIR));
      if (cplan.files.length || cplan.upgrades.length) {
        const cres = await applyCompress(cplan, { keepJsonl: false, onProgress: compressProgressPrinter() });
        const ratio = cres.before > 0 ? (cres.before / Math.max(cres.after, 1)).toFixed(1) : "0";
        log(`Archived ${cres.archived.length} trace(s): ${human(cres.before)} → ${human(cres.after)} (${ratio}x)`, C.green);
        if (cres.skipped.length) log(`Skipped ${cres.skipped.length} live trace(s): ${cres.skipped.join(", ")}`, C.yellow);
      }
    }
  });
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

/** The trace dirs for this cwd (docs/design/store.md): --dir as given, else
 * the project's store dir to write + a legacy ./.cctrace to read. */
function traceDirsFor(dirFlag?: string): TraceDirs {
  return resolveTraceDirs({ dataDir: DATA_DIR, cwd: process.cwd(), dirFlag });
}

/** The project a view/serve of these dirs belongs to: the cwd when the
 * store is in charge; an explicit --dir's marker, its parent when it is a
 * legacy ./.cctrace, else the dir itself. */
function viewProjectRoot(dirs: TraceDirs): string {
  const d = dirs.writeDir;
  if (resolve(d) === projectTraceDir(DATA_DIR, process.cwd())) return process.cwd();
  return projectPathOf(d) ?? (basename(d) === LEGACY_DIRNAME ? dirname(d) : d);
}

/** Progress line for a big archive step — silent for small files. */
function compressProgressPrinter(): (ev: { name: string; bytes: number }) => void {
  const SIZEABLE = 64 * 1024 * 1024;
  return (ev) => { if (ev.bytes >= SIZEABLE) log(`  compressing ${ev.name} (${human(ev.bytes)})`, C.dim); };
}

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
${C.cyan}cctrace${C.reset} - Trace coding-agent CLI HTTP traffic (Claude Code, Codex, Grok, Kimi, opencode)

${C.yellow}USAGE:${C.reset}
  cctrace [CLIENT] [OPTIONS] [-- CLIENT_ARGS...]
  cctrace <SUBCOMMAND> [ARGS]

  Everything after ${C.cyan}--${C.reset} is passed to the traced CLI verbatim.
  CLIENT picks who gets traced: ${C.cyan}claude${C.reset} (default), ${C.cyan}codex${C.reset}, ${C.cyan}grok${C.reset}, ${C.cyan}kimi${C.reset}, ${C.cyan}opencode${C.reset}.
  Non-Claude clients always use mitm capture.
  Every run writes trace-<ts>.jsonl into the store — one dir per project
  under ~/.local/share/cctrace/traces/ (archived to .zst at exit); that file
  IS the trace; reopen it anytime with ${C.cyan}cctrace view${C.reset}.

${C.yellow}SUBCOMMANDS:${C.reset} ${C.dim}(operate on saved traces; no proxy, no client spawn)${C.reset}
  ${C.cyan}view${C.reset} [target] [--html] [--full] [--port N]
                          Reopen a saved trace in the web UI (serves it from
                          a local server; Ctrl-C stops). No target lists the
                          traces and lets you pick (Enter = newest). Target is
                          ${C.cyan}latest${C.reset}, a .jsonl[.zst|.gz] path, a session id, or a
                          trace filename fragment. Traces stream in from the
                          tail: the newest 256 MB of lines open, older ones
                          are noted (${C.cyan}--full${C.reset} loads everything). ${C.cyan}--html${C.reset} writes
                          a self-contained snapshot .html instead (shareable,
                          but huge traces choke browsers).
  ${C.cyan}clean${C.reset}                     Delete regenerable .html snapshots + empty traces.
  ${C.cyan}merge${C.reset} [--prune]           Consolidate each session's pairs into one deduped
                          session-<id>.jsonl; --prune drops merged sources.
                          ${C.dim}A capture run does this for its own session at exit
                          (--no-auto-merge opts out); this is the whole-dir sweep.${C.reset}
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
  ${C.cyan}spec${C.reset} [target] [--out FILE] [--md] [--diff CATALOG.json]
                          Observed-wire catalog: endpoints, methods, header
                          names, body field shapes, SSE event types — sample
                          counts and first/last-seen on every entry, values
                          redacted (except content-negotiation headers and
                          model ids). No target scans every trace in the dir.
                          --diff against a saved catalog prints what changed
                          on the wire between two observations.
  ${C.cyan}ps${C.reset} [--json]               List live cctrace instances (URL, client, project,
                          session).
  ${C.cyan}history${C.reset} [--limit N | --all] [--json]
                          The global run log: every traced run (live + past),
                          newest first, across all projects sharing the data
                          dir. ps = what's running; history = what ran.
  ${C.cyan}store${C.reset} [--json]            Where traces live and what they cost: the store
                          root, one row per project (size, traces, newest),
                          the total — and the commands that reclaim space.
  ${C.cyan}adopt${C.reset} [DIR...] [--scan ROOT] [--rebase FROM=TO] [--copy] [--zst]
                          Move legacy ./.cctrace dirs into the store. No DIR:
                          this project's + every one the run registry knows;
                          --scan walks a tree. Same-disk moves are renames.
                          --rebase: dirs mounted from another machine under
                          FROM belong to projects at TO there (keys, markers
                          and live checks use that machine's paths).
                          --copy keeps the sources; --zst archives plain
                          traces on the way in (streamed, decode-verified).
  ${C.dim}view/spec/clean/merge/compress/purge/compact take --dir DIR (default: this${C.reset}
  ${C.dim}project's store dir); the housekeeping five also take --all (every project${C.reset}
  ${C.dim}in the store) and are dry-run by default; add ${C.reset}${C.cyan}--yes${C.reset}${C.dim} to apply.${C.reset}

${C.yellow}OPTIONS:${C.reset}
  --mode MODE        Capture mode: auto (default), mitm, base-url, node
  -s, --static       Static mode: no live server, write .jsonl + snapshot .html
  -p, --port PORT    Live UI port (default: ${DEFAULT_PORT}; walks ${DEFAULT_PORT}..${DEFAULT_PORT + PORT_WALK - 1}
                     when busy, then an OS-assigned port)
  --inform-agent     Append a note to the agent's system prompt (claude only):
                     you are traced, the live UI address, and how to bypass the
                     proxy for the one command that misbehaves behind one
  --messages-only    Only capture model API calls
  --capture-external MITM every host (default: non-first-party hosts pass
                     through as opaque byte-counted tunnels). External
                     bodies over 64KB are summarized, not stored
  --intercept-host H Also MITM host H with FULL body capture (repeatable —
                     remote MCP servers, unusual providers)
  --bypass-host H    Exempt host H from the proxy entirely (repeatable):
                     appended to the child's NO_PROXY, so the tool talks
                     direct with its normal non-proxy behavior. For the
                     rare tool that misbehaves behind a proxy (wrangler).
                     Costs only that host's ~100B tunnel audit line
  --redact-ids       Also mask identity ids (session/user/device uuids) at
                     capture time, for traces that will leave the machine
                     (or set CCTRACE_REDACT_IDS=1). Credentials — tokens,
                     keys, cookies — are ALWAYS redacted, flag or not
  --no-open          Don't auto-open browser
  --print-ca         Print the MITM CA cert path and exit
  --log NAME         Custom log file base name
  --dir PATH         Log directory (default: the project's dir in the store,
                     ~/.local/share/cctrace/traces/<project-key>/)
  --fresh            Don't merge prior traces of a continued session
                     (also skips the exit auto-merge)
  --no-auto-merge    Don't consolidate this run's session into
                     session-<id>.jsonl at exit (see the merge subcommand)
  --no-compress      Leave the trace as plain .jsonl at exit (default:
                     archived to .jsonl.zst, 40-90x smaller; view reads both)
  --with FILE        Merge a specific trace file into the view (repeatable)
  --claude-path PATH Custom Claude binary path
  --client-path PATH Custom binary path for any client (codex/grok/kimi/opencode too)
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
            ${C.dim}Default for native binaries; the only mode for non-Claude clients.${C.reset}
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
  cctrace kimi                      ${C.dim}# trace the Kimi Code CLI (Moonshot)${C.reset}
  cctrace opencode                  ${C.dim}# trace opencode (all its providers)${C.reset}
  cctrace view                      ${C.dim}# list traces, pick one (Enter = newest)${C.reset}
  cctrace view latest               ${C.dim}# reopen the newest trace directly${C.reset}
  cctrace view trace-2026-07-08     ${C.dim}# reopen a saved trace (filename fragment)${C.reset}
  cctrace view 4f9a2c1e             ${C.dim}# reopen by Claude Code session id${C.reset}
  cctrace view 4f9a2c1e --html      ${C.dim}# write a shareable snapshot .html instead${C.reset}
  cctrace view latest --slice a..b  ${C.dim}# just a slice window (the @a..b of a slice link)${C.reset}
  cctrace view latest --tail        ${C.dim}# follow a running capture's trace live (tail -f)${C.reset}
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
  /** Where this run writes: the project's store dir, or --dir. */
  logDir: string;
  /** Where continuity readers look: logDir, then a legacy ./.cctrace. */
  readDirs: string[];
  /** Leave the trace as plain .jsonl at exit (default: archive to .zst). */
  noCompress: boolean;
  logName?: string;
  logAll: boolean;
  noOpen: boolean;
  fresh: boolean;
  noAutoMerge: boolean;
  withFiles: string[];
  /** Append a trace-awareness note to the agent's system prompt (claude only). */
  informAgent?: boolean;
  /** Hosts exempted from the proxy via the child's NO_PROXY (#83). */
  bypassHosts?: string[];
}

interface LogSink {
  onPair: (pair: TracePair) => void;
  /** Write the categorized HTML report from everything collected. */
  writeHtml: () => Promise<string>;
  /** This run's pairs (no prior-run merges) — feeds the exit summary. */
  pairs: () => TracePair[];
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

/** Trace path relative to the project dir (".cctrace/trace-….jsonl") — the
 * header title's click-to-copy value. A trace outside the project (custom
 * --dir elsewhere) keeps its absolute path: a relpath would be a lie. */
function traceRelPath(projectDir: string, traceFile: string): string {
  const rel = relative(projectDir, resolve(traceFile));
  return rel && !rel.startsWith("..") ? rel : resolve(traceFile);
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
  if (resolve(opts.logDir) === projectTraceDir(DATA_DIR, process.cwd())) ensureProjectDir(DATA_DIR, process.cwd());
  else if (!existsSync(opts.logDir)) mkdirSync(opts.logDir, { recursive: true });
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
    writeHtml: async () => {
      let all = collected;
      const extra: TracePair[] = opts.withFiles.length ? await loadTraceFiles(opts.withFiles) : [];
      if (!opts.fresh) {
        const sids = new Set(collected.map((p) => extractSessionId(p, wireTables())).filter(Boolean));
        extra.push(...await loadPriorPairs(opts.readDirs, logFile, sids));
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
      const snapHtml = renderSnapshot(all, { ...pageMeta(CLIENT.name), traceFile: basename(logFile), traceRelPath: traceRelPath(process.cwd(), logFile) });
      const problem = verifySnapshot(snapHtml, all.length);
      if (problem) log(`warning: snapshot self-check failed: ${problem}`, C.yellow);
      writeFileSync(htmlFile, snapHtml);
      return htmlFile;
    },
    pairs: () => collected,
  };
}

/**
 * Consolidate this run's own session(s) on the way out. A resumed session
 * fragments across one trace-*.jsonl per run; `cctrace merge` fixes that by
 * hand, and doing it at exit keeps the log dir one file per session instead
 * of a pile the user has to reason about. Scoped to the sessions this run saw
 * on the wire — a concurrent run's trace is never a source — and it only
 * fires when there IS something to consolidate: a fresh single-file session
 * leaves its trace exactly as written. Returns the merged output path when
 * this run's own log file was absorbed into it, so callers can stop pointing
 * at a file that no longer exists. Fail-soft: housekeeping never costs the
 * exit receipt or the exit code.
 */
/**
 * Progress printer for the slow merge phases. Silent for small dirs (the
 * merge finishes before anyone wonders); a sizeable file scan/parse or any
 * session write prints a line, headed once by what is going on — a huge
 * session's exit used to sit in planMerge for minutes with zero output,
 * indistinguishable from a hang.
 */
function mergeProgressPrinter(): (ev: MergeProgress) => void {
  const SIZEABLE = 16 * 1024 * 1024;
  let announced = false;
  const announce = () => {
    if (announced) return;
    announced = true;
    log("Consolidating session traces — safe to ctrl-c (atomic writes; sources kept until fully merged):", C.cyan);
  };
  return (ev) => {
    if (ev.phase === "write") {
      announce();
      log(`  writing ${ev.name} (${ev.pairs} pairs)`, C.dim);
    } else if ((ev.bytes ?? 0) >= SIZEABLE) {
      announce();
      log(`  ${ev.phase === "scan" ? "scanning" : "reading"} ${ev.name} (${human(ev.bytes!)})`, C.dim);
    }
  };
}

interface AutoMergeOutcome {
  /** The session file this run's own trace was absorbed into (and pruned
   * from), if any — the receipt/tombstone must point there instead. */
  absorbedInto: string | null;
  /** Every session file the merge wrote, with the archive the plan saw
   * (null = none) — each plain file is a verified union of THAT archive, so
   * the exit archive step may overwrite it while it is still that one. */
  written: { path: string; priorArchive: ArchiveStamp | null }[];
}

function autoMergeOnExit(opts: RunOpts, logFile: string, pairs: TracePair[]): AutoMergeOutcome {
  const none: AutoMergeOutcome = { absorbedInto: null, written: [] };
  try {
    const wire = wireTables();
    const sids = new Set<string>();
    for (const p of pairs) {
      const sid = extractSessionId(p, wire);
      if (sid) sids.add(sid);
    }
    if (!sids.size) return none;
    const onProgress = mergeProgressPrinter();
    const plan = planMerge(opts.logDir, { sessionIds: sids, fragmentedOnly: true, onProgress });
    for (const b of plan.blocked) log(`Auto-merge skipped ${b.outName}: ${b.reason}`, C.dim);
    if (!plan.sessions.length) return none;
    const res = applyMerge(plan, { prune: true, onProgress });
    if (!res.written.length) return none;
    const sources = new Set(plan.sessions.flatMap((s) => s.sources));
    log(`Merged ${sources.size} trace file(s) → ${res.written.join(", ")}`, C.cyan);
    if (res.skipped.length) log(`Kept ${res.skipped.length} source(s) that grew mid-merge: ${res.skipped.join(", ")}`, C.dim);
    const written = plan.sessions.filter((s) => res.written.includes(s.outName)).map((s) => ({ path: s.outPath, priorArchive: s.priorArchive }));
    if (!res.pruned.includes(basename(logFile))) return { absorbedInto: null, written };
    const absorbed = plan.sessions.find((s) => s.sources.includes(basename(logFile)));
    return { absorbedInto: absorbed ? absorbed.outPath : null, written };
  } catch (err) {
    log(`Auto-merge skipped: ${err instanceof Error ? err.message : String(err)}`, C.dim);
    return none;
  }
}

/**
 * Archive this run's final trace file plus every session file the merge
 * wrote, then sweep the dir for plain traces a killed run left behind.
 * Returns the archive path of `traceFile` when it was archived (so the
 * receipt/tombstone can point at it), else null.
 */
async function restTracesOnExit(opts: RunOpts, traceFile: string, mergeWritten: AutoMergeOutcome["written"]): Promise<string | null> {
  const onProgress = compressProgressPrinter();
  const rest = async (path: string, supersedesArchive: ArchiveStamp | null | undefined): Promise<string | null> => {
    // Two attempts: a pair can still land during the first pass (a tunnel
    // closing as the child dies logs its meta pair late), which the archive
    // step detects and refuses to seal; by the second pass the writers are
    // done.
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await archiveTrace(path, { supersedesArchive, onProgress });
      if (res.archived.length) {
        const a = res.archived[0]!;
        log(`Archived ${basename(path)} → ${basename(path)}.zst (${human(a.before)} → ${human(a.after)})`, C.dim);
        return `${path}.zst`;
      }
      if (!res.skipped.length) return null; // nothing to do (empty / not a .jsonl)
      if (attempt === 1) log(`Left ${basename(path)} uncompressed (still being written, or an archive that can't be unioned) — cctrace compress catches it`, C.dim);
    }
    return null;
  };
  let rested: string | null = null;
  try {
    const written = new Map(mergeWritten.map((w) => [resolve(w.path), w.priorArchive]));
    for (const [p, stamp] of written) {
      const out = await rest(p, stamp);
      if (p === resolve(traceFile)) rested = out;
    }
    if (!written.has(resolve(traceFile))) rested = await rest(traceFile, undefined);
  } catch (err) {
    log(`Archive skipped: ${err instanceof Error ? err.message : String(err)}`, C.dim);
  }
  try {
    const exclude = liveLogFiles(DATA_DIR);
    exclude.add(resolve(traceFile));
    const plan = planStaleSweep(opts.logDir, exclude);
    if (plan.files.length) {
      const res = await applyCompress(plan, { keepJsonl: false, onProgress });
      if (res.archived.length) log(`Archived ${res.archived.length} leftover trace(s) from earlier runs (${human(res.before)} → ${human(res.after)})`, C.dim);
    }
  } catch (err) {
    log(`Leftover sweep skipped: ${err instanceof Error ? err.message : String(err)}`, C.dim);
  }
  return rested;
}

function spawnClaudeWithCapturer(claudePath: string, claudeArgs: string[], capturer: Capturer, opts: RunOpts, logFile: string, identityEnv: Record<string, string>, onFinalize?: () => Promise<string>, onAgentPid?: (pid: number) => void, getPairs?: () => TracePair[], onTraceMoved?: (path: string) => void, onStats?: (stats: TraceStats) => void) {
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

  const childEnv = {
    ...(process.env as Record<string, string>),
    ...capturer.env,
    ...bypassHostEnv(opts.bypassHosts ?? []),
    ...identityEnv,
  };
  if (opts.bypassHosts?.length) {
    log(`Bypassing the proxy (direct, normal non-proxy behavior): ${opts.bypassHosts.join(", ")}`, C.dim);
  }
  const child: ChildProcess = spawn(claudePath, claudeArgs, {
    env: childEnv,
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

  const startedAt = Date.now();
  child.on("exit", async (code, signal) => {
    await capturer.flush();
    for (const line of unmuteTerm()) console.log(line);
    // The close-out: what got traced (count, categories, wall-clock, disk),
    // whose session, how many tokens and dollars, what failed — the receipt
    // for the run, not just a pair count.
    if (getPairs) {
      let sizeBytes = 0;
      try { sizeBytes = statSync(logFile).size; } catch {}
      const sum = traceSummary(getPairs(), {
        wire: wireTables(), pricing: pricingCatalog(DATA_DIR),
        sizeBytes, durationMs: Date.now() - startedAt,
      });
      log(sum.traced, C.green);
      if (sum.session) log(sum.session, C.cyan);
      if (sum.errors) log(sum.errors, C.yellow);
      // Stamp the numbers into the registry entry BEFORE the tombstone
      // writes — the dashboard's per-run stats come from here, never from
      // re-reading traces.
      onStats?.(sum.stats);
    } else {
      log(`Traced ${capturer.pairCount()} request/response pairs`, C.green);
    }
    capturer.stop();
    // Fold this run's trace into its session file before anything names it:
    // the receipt, the registry tombstone and `cctrace view` must point at
    // where the pairs actually live now. --fresh opts out along with the
    // viewer-side merge; --no-auto-merge opts out of just this.
    let traceFile = logFile;
    let mergeWritten: AutoMergeOutcome["written"] = [];
    if (!opts.fresh && !opts.noAutoMerge) {
      const merged = autoMergeOnExit(opts, logFile, getPairs?.() ?? []);
      mergeWritten = merged.written;
      if (merged.absorbedInto) {
        traceFile = merged.absorbedInto;
        onTraceMoved?.(resolve(merged.absorbedInto));
      }
    }
    // Everything this run touched goes to rest as .zst (docs/design/
    // store.md): the merged session file(s) were just written as verified
    // unions of any prior archive, so they may overwrite one; the run's own
    // trace never has one unless a sweep raced us, in which case the union
    // path runs. Then the leftovers of killed runs in this dir. All fail-
    // soft — housekeeping never costs the exit code.
    if (!opts.noCompress) {
      const rested = await restTracesOnExit(opts, traceFile, mergeWritten);
      if (rested) {
        traceFile = rested;
        onTraceMoved?.(resolve(rested));
      }
    }
    if (onFinalize) {
      // Static mode: the self-contained snapshot is the deliverable.
      const htmlFile = await onFinalize();
      log(`HTML: ${htmlFile}`, C.green);
      if (!opts.noOpen) openBrowser(htmlFile);
    } else {
      log(`Reopen anytime: cctrace view ${traceFile}`, C.dim);
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
    else speculateSid = (await newestPriorSessionId(opts.readDirs, logFile))?.sid;
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
      readDirs: opts.readDirs,
      logFile,
      noHistory: opts.fresh,
      withFiles: opts.withFiles,
      speculate: speculateSid,
      meta: { ...pageMeta(CLIENT.name), traceFile: basename(logFile), traceRelPath: traceRelPath(process.cwd(), logFile) },
      traceSize: () => { try { return statSync(logFile).size; } catch { return 0; } },
      dataDir: DATA_DIR,
      instanceId,
      self: () => instance?.snapshot() ?? null,
      onSession: (sid) => instance?.update({ sessionId: sid }),
      onPrompt: (p) => instance?.update({ firstPrompt: p }),
      onPurge: (removed) => {
        // A pair belongs to this run's log file unless it was merged from a
        // prior trace (pair.prior = basename in the log dir) or an explicit
        // --with file (basename of an arbitrary path).
        const withByBase = new Map(opts.withFiles.map((f) => [basename(f), resolve(f)]));
        // A prior basename lives in whichever read dir holds it (the store
        // dir, or a legacy ./.cctrace) — first hit wins, store first.
        const priorPath = (name: string) => opts.readDirs.map((d) => join(d, name)).find((f) => existsSync(f)) ?? join(opts.logDir, name);
        const files = new Set<string>();
        for (const p of removed) {
          files.add(p.prior ? withByBase.get(p.prior) ?? priorPath(p.prior) : logFile);
        }
        const res = purgePairsById([...files], new Set(removed.map((p) => p.id)));
        const touched = res.rewritten.concat(res.removed);
        log(`web purge: dropped ${res.droppedCount} pair(s) from ${touched.join(", ") || "no file"}` +
          (res.skipped.length ? ` — skipped ${res.skipped.join(", ")}` : ""), C.yellow);
        return { files: touched, skippedFiles: res.skipped };
      },
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
    log(`Live UI: http://localhost:${server.port}/trace`, C.green);
    log(`Dashboard (all runs): http://localhost:${server.port}/dashboard`, C.dim);
    if (!opts.noOpen) {
      setTimeout(() => openBrowser(`http://localhost:${server.port}/trace`), 500);
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
    extraHosts: [
      ...((values["intercept-host"] as string[] | undefined) || []),
      // The client's own config can route model calls to a custom host
      // (codex model_providers base_url) — enroll those automatically, or
      // the trace shows an empty Messages view behind a custom provider.
      ...(CLIENT.configHosts?.(process.env) || []),
    ],
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

  // --inform-agent: tell the traced agent it runs under a tracing proxy, and
  // how to bypass it for the rare command that misbehaves behind one (the
  // wrangler case: proxy-present code paths change tool behavior). Claude
  // only — the other client CLIs have no system-prompt flag.
  let childArgs = claudeArgs;
  if (opts.informAgent) {
    if (CLIENT.name === "claude") {
      childArgs = [...claudeArgs, "--append-system-prompt", agentAwarenessNote(liveInstance?.snapshot().port, resolve(logFile))];
      log("Agent informed of the traced env (--append-system-prompt)", C.dim);
    } else {
      log(`--inform-agent supports claude only — for ${CLIENT.name}, put the note in its instructions file (see docs/agent-awareness.md)`, C.yellow);
    }
  }

  // Live mode: the .jsonl is the deliverable — `cctrace view` rebuilds the UI
  // from it anytime, so don't also write a snapshot .html at exit (on big
  // sessions it runs to hundreds of MB). Static mode's whole point is the
  // self-contained .html, so it keeps the finalize step.
  spawnClaudeWithCapturer(
    claudePath, childArgs, capturer, opts, logFile,
    traceIdentityEnv(resolve(logFile), liveInstance?.snapshot() ?? null),
    opts.liveMode ? undefined : sink.writeHtml,
    (pid) => liveInstance?.update({ agentPid: pid }),
    sink.pairs,
    // The tombstone is the cross-project run catalog: point it at the merged
    // session file, not the trace the merge just absorbed.
    (path) => liveInstance?.update({ logFile: path }),
    (stats) => liveInstance?.update(stats),
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
      onPrompt: (p) => instance?.update({ firstPrompt: p }),
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
    log(`Live UI: http://localhost:${livePort}/trace`, C.green);
    log(`Dashboard (all runs): http://localhost:${livePort}/dashboard`, C.dim);
    if (!opts.noOpen) {
      setTimeout(() => openBrowser(`http://localhost:${livePort}/trace`), 500);
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

/** The --inform-agent note, appended to Claude's system prompt: what the
 * traced env means and the one escape hatch worth knowing. Kept terse — it
 * rides every request of the session. */
function agentAwarenessNote(port: number | undefined, traceFile: string): string {
  return [
    "cctrace: this session's HTTPS traffic is traced by a local transparent proxy (HTTPS_PROXY points at it; subprocesses inherit it).",
    port ? `Live trace UI: http://localhost:${port}/trace — every request, token, and cost this session puts on the wire.` : "",
    `Trace file: ${traceFile}.`,
    "Anthropic API calls are captured; other hosts pass through an opaque tunnel (bytes counted, content untouched), so the proxy adds no meaningful latency.",
    "Caveat: some tools change behavior when proxy env vars are set (wrangler swaps undici's global dispatcher, so its timeout overrides only take effect with the proxy vars unset).",
    "If a large upload or deploy times out through the proxy, re-run just that one command with the proxy cleared: env -u HTTPS_PROXY -u https_proxy <command> (if the network itself needs a proxy, set HTTPS_PROXY to that real proxy instead).",
    "Never unset the proxy globally or kill the cctrace process — that severs the whole session's capture.",
  ].filter(Boolean).join(" ");
}

async function main() {
  if (SUBCOMMAND) {
    const rest = RAW_ARGV.slice(1);
    if (SUBCOMMAND === "view") {
      if (await runView(rest)) return; // serving: the web server keeps us alive
    }
    else if (SUBCOMMAND === "clean") await runClean(rest);
    else if (SUBCOMMAND === "merge") await runMerge(rest);
    else if (SUBCOMMAND === "compress") await runCompress(rest);
    else if (SUBCOMMAND === "purge") await runPurge(rest);
    else if (SUBCOMMAND === "compact") await runCompact(rest);
    else if (SUBCOMMAND === "spec") await runSpec(rest);
    else if (SUBCOMMAND === "ps") await runPs(rest);
    else if (SUBCOMMAND === "history") await runHistory(rest);
    else if (SUBCOMMAND === "store") runStore(rest);
    else if (SUBCOMMAND === "adopt") await runAdopt(rest);
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

  // Identity-id masking (session/user/device uuids) is OPT-IN — a local
  // session uuid is workflow identity, not a credential, and masking it
  // breaks sid-keyed continuity. Credentials always redact, no opt-out.
  if (values["redact-ids"] || process.env.CCTRACE_REDACT_IDS === "1") {
    setIdentityRedaction(true);
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

  const dirs = traceDirsFor(values.dir);
  const opts: RunOpts = {
    port: values.port ? parseInt(values.port, 10) : DEFAULT_PORT,
    liveMode: !values.static,
    logDir: dirs.writeDir,
    readDirs: dirs.readDirs,
    noCompress: !!values["no-compress"],
    logName: values.log,
    logAll: !values["messages-only"],
    noOpen: !!values["no-open"],
    fresh: !!values.fresh,
    noAutoMerge: !!values["no-auto-merge"],
    withFiles: values.with ? [...values.with] : [],
    informAgent: !!values["inform-agent"],
    bypassHosts: values["bypass-host"] ? [...values["bypass-host"]] : [],
  };

  log(`cctrace v${versionWithCommit()}`, C.dim);
  if (dirs.legacy) {
    // Read for continuity, never written: one line so the user knows where
    // new traces go and how to bring the old ones along.
    log(`Legacy ${relative(process.cwd(), dirs.legacy) || dirs.legacy} still holds traces — new traces go to the store; move them: cctrace adopt`, C.yellow);
  }
  await maybeOfferUpdate();
  // Refresh the update cache in the background — never blocks the session.
  if (!NO_UPDATE_CHECK) refreshUpdateCache(DATA_DIR).catch(() => {});
  refreshPricingCache(DATA_DIR).catch(() => {});

  const clientPath = findClient();
  log(`${CLIENT.name === "claude" ? "Claude" : CLIENT.name}: ${clientPath}`, C.blue);
  if (claudeArgs.length) log(`${CLIENT.name} args: ${claudeArgs.join(" ")}`, C.blue);

  // Non-Claude clients (codex, grok, kimi) always run mitm: base-url rides
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
