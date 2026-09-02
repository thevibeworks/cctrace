import { spawn, type ChildProcess } from "child_process";
import { readdir, stat } from "fs/promises";
import { dirname, join, resolve } from "path";
import { isTraceFile } from "./history";
import { planCompress } from "./storage";
import { projectPathOf, storeRoot, liveLogFiles, staleSealJobs } from "./store";
import { selfExecArgv } from "./version";

// The dashboard's housekeeping half: what the trace store looks like right
// now (/api/store), and the one job that changes it — `cctrace compress
// --all --yes` run from the page instead of a terminal (/api/store/archive).
//
// Two rules shape this file:
//
// 1. The picture is derived from the SAME plan the job will execute
//    (planCompress, live runs excluded via liveLogFiles) — never a second
//    estimate that can disagree with what the button then does.
// 2. The job runs in a CHILD process, not here. A store-wide archive walks
//    GBs and its union path reads whole traces into memory; doing that on
//    the event loop of a capture run would stall the MITM proxy the traced
//    session depends on. Same reasoning that made the exit seal a detached
//    helper (docs/design/store.md). The child is the ordinary CLI command,
//    so there is exactly one implementation of archiving, and the page's
//    live output is that command's output.
//
// Truth about what changed comes from re-measuring the store when the child
// exits (before/after), not from parsing its human-readable lines.

export interface StoreDirView {
  dir: string;
  /** From the dir's project.json marker; null for a hand-made dir. */
  project: string | null;
  traces: number;
  bytes: number;
  /** Plain .jsonl the archive job would take (live runs already excluded). */
  plain: number;
  plainBytes: number;
}

export interface StorePicture {
  root: string;
  projects: number;
  traces: number;
  /** Everything on disk in the store, archived and plain alike. */
  bytes: number;
  /** What `archive now` would act on: plain traces, no live run holding them. */
  plain: number;
  plainBytes: number;
  /** Legacy .jsonl.gz archives the same job re-encodes as .zst. */
  upgrades: number;
  /** Plain traces skipped because a heartbeat-fresh run is writing them. */
  liveHeld: number;
  /** Exit seals orphaned by a dead helper — `compress --yes` finishes these
   * inline before it plans, so the button clears them too. */
  staleSeals: number;
  /** Biggest projects first, capped by the caller's `top`. */
  dirs: StoreDirView[];
}

/**
 * Scan the store: per-project sizes plus the exact archive plan. No trace is
 * read — but a real store is 80 project dirs and 1000 files, which measured
 * 160-800ms of statting on a bind-mounted FS. That is a capture run's event
 * loop, and its MITM proxy is on it, so the walk is ASYNC and yields between
 * project dirs: the block is one dir's worth, never the store's.
 *
 * `listStoreProjects` (sync, whole store) is deliberately not reused here for
 * that reason; the archive rule still comes from planCompress, per dir.
 */
export async function storePicture(dataDir: string, top = 8): Promise<StorePicture> {
  const live = liveLogFiles(dataDir);
  const liveDirs = new Map<string, number>();
  for (const f of live) liveDirs.set(dirname(f), (liveDirs.get(dirname(f)) || 0) + 1);
  const now = Date.now();
  const root = storeRoot(dataDir);
  let keys: string[] = [];
  try { keys = await readdir(root); } catch { /* no store yet */ }
  const dirs: StoreDirView[] = [];
  let traces = 0, bytes = 0, plain = 0, plainBytes = 0, upgrades = 0, liveHeld = 0;
  for (const key of keys) {
    const dir = join(root, key);
    let names: string[];
    try { names = await readdir(dir); } catch { continue; } // a stray file, or gone
    const sizes = await Promise.all(
      names.filter(isTraceFile).map((n) => stat(join(dir, n)).then((st) => st.size, () => -1)),
    );
    let dirTraces = 0, dirBytes = 0;
    for (const b of sizes) { if (b >= 0) { dirTraces++; dirBytes += b; } }
    // Per dir, so the sync part of the scan stays one dir wide.
    const plan = planCompress(dir, now, undefined, live);
    if (!dirTraces && !plan.files.length && !plan.upgrades.length) continue;
    dirs.push({
      dir,
      project: projectPathOf(dir),
      traces: dirTraces,
      bytes: dirBytes,
      plain: plan.files.length,
      plainBytes: plan.bytes,
    });
    traces += dirTraces;
    bytes += dirBytes;
    plain += plan.files.length;
    plainBytes += plan.bytes;
    upgrades += plan.upgrades.length;
    liveHeld += liveDirs.get(resolve(dir)) || 0;
  }
  dirs.sort((a, b) => b.plainBytes - a.plainBytes || b.bytes - a.bytes);
  return {
    root,
    projects: dirs.length,
    traces, bytes, plain, plainBytes, upgrades, liveHeld,
    staleSeals: staleSealJobs(dataDir, now).length,
    dirs: dirs.slice(0, top),
  };
}

/** The dashboard polls; a store scan is I/O. Serve a recent one instead of
 * re-walking 80 dirs for every open tab — 2s is under one poll interval, so
 * nothing a reader can perceive goes stale. The job's own before/after
 * measurements call storePicture directly: those must be exact. */
let cached: { dataDir: string; top: number; at: number; pic: StorePicture } | null = null;
const PICTURE_TTL_MS = 2000;

export async function storePictureCached(dataDir: string, top = 8): Promise<StorePicture> {
  const now = Date.now();
  if (cached && cached.dataDir === dataDir && cached.top === top && now - cached.at < PICTURE_TTL_MS) {
    return cached.pic;
  }
  const pic = await storePicture(dataDir, top);
  cached = { dataDir, top, at: Date.now(), pic };
  return pic;
}

export interface ArchiveJob {
  id: string;
  startedAt: number;
  endedAt?: number;
  state: "running" | "done" | "failed" | "cancelled";
  /** The command line the page is watching — no hidden magic. */
  command: string;
  /** Tail of the child's output, ANSI stripped. */
  lines: string[];
  /** Output dropped off the front of `lines` (the tail is bounded). */
  dropped: number;
  before: { plain: number; plainBytes: number; bytes: number };
  after?: { plain: number; plainBytes: number; bytes: number };
  exitCode?: number;
  error?: string;
}

/** Enough scrollback to hold a big store's per-file lines; the head is
 * dropped, not the tail — the summary is what a reader wants. */
const MAX_LINES = 600;

let job: ArchiveJob | null = null;
let child: ChildProcess | null = null;
/** Set by cancelArchive so the exit handler can tell "we stopped it" from
 * "it died". */
let cancelled = false;

export const currentArchiveJob = (): ArchiveJob | null => job;

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const totals = (p: StorePicture) => ({ plain: p.plain, plainBytes: p.plainBytes, bytes: p.bytes });

export interface StartArchiveOpts {
  /** Override the child command — tests only; production uses the CLI. */
  argv?: string[];
}

/**
 * Start `cctrace compress --all --yes` as a child and track it. One job at a
 * time per server: a second start returns the running one untouched (the
 * caller answers 409), because two concurrent archives of one store are
 * wasted work — safe (every unlink re-stats) but noisy.
 */
export async function startArchive(dataDir: string, opts: StartArchiveOpts = {}): Promise<{ job: ArchiveJob; started: boolean }> {
  if (job?.state === "running") return { job, started: false };
  // The data dir travels in the environment, not in argv: the storage
  // subcommands take --dir/--all/--yes only, and CCTRACE_DATA_DIR is the
  // documented way to point a cctrace at another store.
  const cliArgs = ["compress", "--all", "--yes"];
  const argv = opts.argv ?? selfExecArgv(cliArgs);
  cancelled = false;
  const j: ArchiveJob = {
    id: `arch-${Date.now().toString(36)}`,
    startedAt: Date.now(),
    state: "running",
    command: opts.argv ? argv.join(" ") : `cctrace ${cliArgs.join(" ")}`,
    lines: [],
    dropped: 0,
    before: totals(await storePicture(dataDir, 0)),
  };
  job = j;
  const push = (text: string) => {
    for (const line of stripAnsi(text).split("\n")) {
      const t = line.replace(/\s+$/, "");
      if (!t) continue;
      j.lines.push(t);
      if (j.lines.length > MAX_LINES) { j.lines.shift(); j.dropped++; }
    }
  };
  let finishing = false;
  const finish = (state: ArchiveJob["state"], code?: number, error?: string) => {
    if (finishing || j.state !== "running") return;
    finishing = true;
    child = null;
    if (code != null) j.exitCode = code;
    if (error) j.error = error;
    // Re-measure instead of trusting the log — this is the number the page
    // reports as reclaimed — and flip the state only once it's in hand: a
    // job that reads "done" must already carry what it did. Housekeeping
    // isn't over until we know the result anyway.
    storePicture(dataDir, 0)
      .then((pic) => { j.after = totals(pic); }, () => { /* store vanished */ })
      .then(() => { j.state = state; j.endedAt = Date.now(); });
  };
  try {
    const [cmd, ...args] = argv;
    const proc = spawn(cmd!, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // A housekeeping child must not prompt, phone home, or inherit the
      // traced session's proxy vars.
      env: {
        ...process.env,
        CCTRACE_DATA_DIR: dataDir,
        CCTRACE_NO_UPDATE_CHECK: "1",
        HTTPS_PROXY: "", HTTP_PROXY: "",
      },
    });
    child = proc;
    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", push);
    proc.stderr?.on("data", push);
    proc.on("error", (e) => finish("failed", undefined, e.message));
    // "exit", not "close": close waits for the stdio pipes to drain, which a
    // grandchild can hold open long after the archive itself is gone. Late
    // lines still land — push() doesn't care that the job is finished.
    proc.on("exit", (code, signal) => {
      if (signal && cancelled) return finish("cancelled", undefined, `stopped (${signal})`);
      finish(code === 0 ? "done" : "failed", code ?? undefined, signal ? `killed by ${signal}` : undefined);
    });
  } catch (e) {
    finish("failed", undefined, e instanceof Error ? e.message : String(e));
  }
  return { job: j, started: true };
}

/** Stop a running archive. The child dies between files: applyCompress
 * writes tmp-then-rename and unlinks a source only after its archive
 * verifies, so a cancelled job leaves the store consistent (at worst an
 * orphaned .tmp, which the next run's sweep removes). */
export function cancelArchive(): boolean {
  if (!child || job?.state !== "running") return false;
  cancelled = true;
  try { child.kill("SIGTERM"); } catch { return false; }
  return true;
}

/** Tests only: forget the job so each case starts clean. */
export function resetArchiveJob() {
  if (child) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  child = null;
  job = null;
  cancelled = false;
}
