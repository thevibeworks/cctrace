import { readdirSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync, statSync } from "fs";
import { join } from "path";
import http from "http";

// Live-instance registry: every live-mode run writes one JSON file under
// <dataDir>/instances/<pid>.json so concurrent cctrace sessions can find
// each other — `cctrace ps` on the CLI, /api/instances + the header switcher
// in the web UI.
//
// Liveness is judged by HEARTBEAT + PORT PROBE, never by pid. The registry
// dir is often shared across pid namespaces (containers sharing a $HOME
// volume while ports are shared via host networking), where a pid check is
// meaningless in both directions: a live instance in another namespace looks
// dead (and pre-0.10 readers GC'd — i.e. deleted — its registry file!), and
// a recycled pid makes a dead one look alive. What an entry actually promises
// is its URL, so the URL is what gets verified:
//   - a live instance rewrites its file every HEARTBEAT_MS; a fresh mtime is
//     accepted as alive without any probing (the cheap common path)
//   - a stale file gets its port probed (/api/self, matched by the unique
//     per-run id) — only a definitive "dead" (connection refused, or another
//     run answering on that port) deletes the file; inconclusive probes hide
//     the entry but leave the file for the next reader
// The heartbeat also self-heals vandalism: if some reader wrongly deletes a
// live entry, it reappears within HEARTBEAT_MS.

export interface InstanceInfo {
  /** Unique per-run token — identity across pid namespaces (0.10+). */
  id?: string;
  pid: number;
  port: number;
  project: string;
  projectPath: string;
  logFile: string;
  mode: string;
  startedAt: string; // ISO
  sessionId?: string;
}

export interface InstanceHandle {
  /** Merge fields into the registry entry (e.g. sessionId once known). */
  update(patch: Partial<InstanceInfo>): void;
  /** The entry as currently written — served at /api/self. */
  snapshot(): InstanceInfo;
  unregister(): void;
}

// The UI port walk: first choice, then neighbors, then an OS-assigned port
// (server.ts). Also the sweep range for discovering live-but-unregistered
// instances — a pre-0.10 reader sharing the registry dir GC's entries whose
// pid it can't see, so the registry alone can't be trusted to be complete.
export const DEFAULT_PORT = 9317;
export const PORT_WALK = 10;
export const SCAN_PORTS = Array.from({ length: PORT_WALK }, (_, i) => DEFAULT_PORT + i);

export const HEARTBEAT_MS = 30_000;
/** Older than this and the entry must prove itself via port probe. */
export const STALE_MS = HEARTBEAT_MS * 3;
/**
 * No heartbeat for this long AND an inconclusive probe -> junk. Needed where
 * closed ports hang instead of refusing (see probeInstance), or "dead" would
 * never fire and crashed entries would pile up forever. A live instance
 * can't be this stale: its heartbeat rewrites the file every HEARTBEAT_MS.
 */
export const ABANDONED_MS = 24 * 60 * 60 * 1000;

export function instancesDir(dataDir: string): string {
  return join(dataDir, "instances");
}

export function registerInstance(
  dataDir: string,
  info: InstanceInfo,
  heartbeatMs: number = HEARTBEAT_MS,
): InstanceHandle {
  const dir = instancesDir(dataDir);
  // Keyed by run id, not pid: pids collide across the pid namespaces that
  // share this registry, and colliding runs would overwrite each other.
  const file = join(dir, `${info.id ?? info.pid}.json`);
  let current: InstanceInfo = { ...info };
  const write = () => {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(current, null, 2) + "\n");
    } catch {
      // registry is best-effort — never take a capture down over it
    }
  };
  write();
  const beat = setInterval(write, heartbeatMs);
  beat.unref?.();
  return {
    update(patch) {
      current = { ...current, ...patch };
      write();
    },
    snapshot: () => ({ ...current }),
    unregister() {
      clearInterval(beat);
      try {
        unlinkSync(file);
      } catch {
        // already gone
      }
    },
  };
}

interface RawEntry {
  info: InstanceInfo;
  file: string;
  mtimeMs: number;
}

/** Parseable entries with their file + mtime; unparseable files are deleted. */
function readEntries(dataDir: string): RawEntry[] {
  const dir = instancesDir(dataDir);
  if (!existsSync(dir)) return [];
  const out: RawEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    try {
      const info = JSON.parse(readFileSync(file, "utf8")) as InstanceInfo;
      if (typeof info.pid !== "number" || typeof info.port !== "number") throw new Error("bad shape");
      out.push({ info, file, mtimeMs: statSync(file).mtimeMs });
    } catch {
      try {
        unlinkSync(file);
      } catch {
        // raced with its owner — fine
      }
    }
  }
  return out;
}

function byStart(a: InstanceInfo, b: InstanceInfo): number {
  // Entries of unknown age (port-sweep finds of old instances) sort last.
  if (!a.startedAt !== !b.startedAt) return a.startedAt ? -1 : 1;
  return String(a.startedAt).localeCompare(String(b.startedAt)) || a.port - b.port;
}

/**
 * Every registered instance, oldest first, with NO liveness judgment beyond
 * dropping unparseable files. Debug/raw view — use listLiveInstances for
 * anything user-facing.
 */
export function listInstances(dataDir: string): InstanceInfo[] {
  return readEntries(dataDir)
    .map((e) => e.info)
    .sort(byStart);
}

export type ProbeVerdict = "alive" | "dead" | "unknown";
export type Probe = (info: InstanceInfo) => Promise<ProbeVerdict>;

/** What actually answers /api/self on a port. */
export type SelfProbe =
  | { kind: "self"; info: InstanceInfo } // a 0.10+ cctrace identified itself
  | { kind: "old" }                      // 404: an older cctrace, no /api/self
  | { kind: "other" }                    // something non-cctrace squats there
  | { kind: "closed" }                   // connection refused — nothing there
  | { kind: "silent" };                  // timeout etc. — inconclusive

/**
 * Ask the port itself what lives there. Only /api/self is probed — never an
 * old instance's /api/instances, whose handler GC's registry files as a side
 * effect. Timeouts are inconclusive, not death: some localhost setups
 * (container port forwarding) hang on closed ports instead of refusing.
 *
 * node:http, not fetch: fetch honors HTTP(S)_PROXY, and a traced session
 * always has those set — the probe must hit localhost directly.
 */
export function probeSelf(port: number): Promise<SelfProbe> {
  return new Promise((resolve) => {
    let done = false;
    const settle = (v: SelfProbe) => { if (!done) { done = true; resolve(v); } };
    const req = http.get(
      { host: "127.0.0.1", port, path: "/api/self", timeout: 800 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => { if (body.length < 16384) body += c; });
        res.on("end", () => {
          if (res.statusCode === 404) return settle({ kind: "old" });
          if (res.statusCode !== 200) return settle({ kind: "silent" });
          try {
            const info = JSON.parse(body) as InstanceInfo | null;
            if (info && typeof info === "object" && info.id) {
              return settle({ kind: "self", info: { ...info, port } });
            }
          } catch {
            // not JSON — fall through
          }
          settle({ kind: "other" });
        });
      },
    );
    req.on("timeout", () => { settle({ kind: "silent" }); req.destroy(); });
    req.on("error", (err) => {
      const s = `${(err as NodeJS.ErrnoException).code ?? ""} ${err.message}`;
      settle(/ECONNREFUSED|refused/i.test(s) ? { kind: "closed" } : { kind: "silent" });
    });
  });
}

/** Verdict on a specific registry entry: does ITS run still answer ITS port? */
export async function probeInstance(info: InstanceInfo): Promise<ProbeVerdict> {
  const r = await probeSelf(info.port);
  switch (r.kind) {
    case "self":
      // No id on the entry = written pre-0.10; any cctrace answering counts.
      return !info.id || r.info.id === info.id ? "alive" : "dead";
    case "old":
      return "alive";
    case "other":
    case "closed":
      return "dead";
    case "silent":
      return "unknown";
  }
}

export interface ListOptions {
  /** Liveness check for stale registry entries. */
  probe?: Probe;
  /**
   * Ports to sweep for live-but-unregistered instances (pass SCAN_PORTS).
   * Pre-0.10 readers sharing the registry dir delete entries whose pid they
   * can't see (other pid namespaces), so a missing file proves nothing — the
   * sweep synthesizes entries straight from each port's /api/self answer.
   * Default off: sweeping hits real localhost ports (tests must stay hermetic).
   */
  scanPorts?: number[];
  scan?: (port: number) => Promise<SelfProbe>;
  now?: number;
}

/**
 * Live instances, oldest first: heartbeat-fresh registry entries pass free,
 * stale ones must answer their port, and (with scanPorts) the port walk is
 * swept for instances the registry has lost. Definitively dead entries are
 * garbage-collected.
 */
export async function listLiveInstances(dataDir: string, opts: ListOptions = {}): Promise<InstanceInfo[]> {
  const { probe = probeInstance, scan = probeSelf, scanPorts = [], now = Date.now() } = opts;
  const out: InstanceInfo[] = [];
  await Promise.all(
    readEntries(dataDir).map(async ({ info, file, mtimeMs }) => {
      if (now - mtimeMs < STALE_MS) {
        out.push(info);
        return;
      }
      const verdict = await probe(info);
      if (verdict === "alive") {
        out.push(info);
      } else if (verdict === "dead" || now - mtimeMs > ABANDONED_MS) {
        try {
          unlinkSync(file);
        } catch {
          // raced — fine
        }
      }
      // recent "unknown": hide from this listing, keep the file for the next reader
    }),
  );
  const covered = new Set(out.map((i) => i.port));
  const seenIds = new Set(out.map((i) => i.id).filter(Boolean));
  await Promise.all(
    scanPorts.filter((p) => !covered.has(p)).map(async (port) => {
      const r = await scan(port);
      if (r.kind === "self" && !seenIds.has(r.info.id)) {
        out.push(r.info);
      } else if (r.kind === "old") {
        // An older cctrace is serving there but can't identify itself.
        out.push({ pid: 0, port, project: "", projectPath: "", logFile: "", mode: "", startedAt: "" });
      }
    }),
  );
  return out.sort(byStart);
}
