import type { ServerWebSocket } from "bun";
import type { TracePair } from "./types";
import { getLiveHtml, type PageMeta } from "./ui";
import { extractSessionId } from "./summarize";
import { wireTables } from "./clients";
import { loadPriorPairs, loadTraceFiles } from "./history";
import { listLiveInstances, SCAN_PORTS, PORT_WALK, type InstanceInfo } from "./instances";

const WIRE = wireTables();

export { renderSnapshot, verifySnapshot } from "./ui";

interface ServerConfig {
  port: number;
  logDir: string;
  /** The current run's log file — excluded from prior-trace scans. */
  logFile?: string;
  /** Disable cross-run history merging (--fresh). */
  noHistory?: boolean;
  /** Trace files to force-merge at startup (--with). */
  withFiles?: string[];
  /** Pre-resolved pairs to seed the server with (`cctrace view --serve`). */
  initialPairs?: TracePair[];
  /** Run identity (project name/path) shown in the page header. */
  meta?: PageMeta;
  /** Data dir holding the live-instance registry (enables /api/instances). */
  dataDir?: string;
  /** This run's unique registry id — marks `self` in /api/instances. */
  instanceId?: string;
  /** This run's registry entry, served at /api/self for liveness probes. */
  self?: () => InstanceInfo | null;
  /** Called once per newly-seen Claude session id on the wire. */
  onSession?: (sid: string) => void;
}

const clients = new Set<ServerWebSocket<unknown>>();
const pairs: TracePair[] = [];
const knownIds = new Set<string>();
const seenSessions = new Set<string>();

function broadcast(data: unknown) {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    ws.send(msg);
  }
}

/** Insert history pairs (deduped by id), keep the array timestamp-sorted. */
function mergePairs(incoming: TracePair[]): TracePair[] {
  const fresh = incoming.filter((p) => p && p.id && !knownIds.has(p.id));
  if (!fresh.length) return [];
  for (const p of fresh) {
    knownIds.add(p.id);
    pairs.push(p);
  }
  pairs.sort((a, b) => (a.request?.timestamp || 0) - (b.request?.timestamp || 0));
  return fresh;
}

// The live server is a broadcast relay only — it holds pairs in memory and
// pushes them to connected browsers. The CLI's log sink owns the .jsonl/.html
// files, so we never double-write. The page itself lives in ui.ts. The sink
// hands pairs over via the returned in-process `ingest` — never a loopback
// HTTP hop, which is both a wasted round trip and an injection surface.
//
// Session continuity: when a live pair reveals a session_id we haven't seen,
// prior traces in logDir are scanned for that session and merged in as
// history (pair.prior = source file), so a --continue'd conversation keeps
// its old turns' usage/duration/wire links instead of looking incomplete.
export function createServer(config: ServerConfig) {
  if (config.initialPairs?.length) mergePairs(config.initialPairs);
  if (config.withFiles?.length) {
    const merged = mergePairs(loadTraceFiles(config.withFiles));
    if (merged.length) console.log(`[cctrace] merged ${merged.length} pairs from --with`);
  }

  const onLivePair = (pair: TracePair) => {
    mergePairs([pair]);
    broadcast({ type: "pair", pair });
    const sid = extractSessionId(pair, WIRE);
    if (!sid || seenSessions.has(sid)) return;
    seenSessions.add(sid);
    config.onSession?.(sid);
    if (config.noHistory) return;
    const prior = mergePairs(loadPriorPairs(config.logDir, config.logFile || "", new Set([sid])));
    if (prior.length) {
      const files = [...new Set(prior.map((p) => p.prior))].join(", ");
      console.log(`[cctrace] session ${sid.slice(0, 8)} continued — merged ${prior.length} prior pairs from ${files}`);
      broadcast({ type: "history", pairs: prior });
    }
  };

  const serveOn = (port: number) => Bun.serve({
    port,
    async fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        if (server.upgrade(req)) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      if (url.pathname === "/api/pair" && req.method === "POST") {
        // Only this run's own capture may inject pairs (legacy node mode
        // POSTs from the child process; proxy modes ingest in-process). The
        // socket can be reachable across containers/LAN, so reject the rest.
        if (config.instanceId && req.headers.get("x-cctrace-instance") !== config.instanceId) {
          return Response.json({ error: "wrong or missing x-cctrace-instance" }, { status: 403 });
        }
        return handlePair(req, onLivePair);
      }
      if (url.pathname === "/api/pairs") {
        return Response.json(pairs);
      }
      if (url.pathname === "/api/self") {
        // Identity for cross-instance liveness probes. Answers from memory
        // only — touching the registry here would let probes chain.
        const me = config.self?.();
        return Response.json(me ?? (config.instanceId ? { id: config.instanceId } : null));
      }
      if (url.pathname === "/api/instances") {
        // Sibling live instances, heartbeat/probe-verified, plus a sweep of
        // the port walk for runs the registry lost; `self` marks this one so
        // the UI's switcher can offer only the others. The id compare
        // matters: pids collide across containers sharing this registry.
        const list = config.dataDir
          ? await listLiveInstances(config.dataDir, { scanPorts: SCAN_PORTS })
          : [];
        return Response.json(list.map((i) => ({
          ...i,
          self: config.instanceId ? i.id === config.instanceId : i.pid === process.pid,
        })));
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        // The page connects its WebSocket origin-relative, so no port is
        // baked in — behind container/host port forwards the bound port is
        // not the port the browser sees.
        return new Response(getLiveHtml(config.meta), {
          headers: { "Content-Type": "text/html" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        ws.send(JSON.stringify({ type: "init", pairs }));
      },
      close(ws) {
        clients.delete(ws);
      },
      message() {},
    },
  });

  // Try the preferred port, then the next few (so concurrent instances land
  // on predictable neighbors: 9317, 9318, ... — the same walk SCAN_PORTS
  // sweeps for discovery), then an OS-assigned free port as the last resort
  // instead of crashing.
  let server;
  for (let i = 0; i < PORT_WALK && !server; i++) {
    try {
      server = serveOn(config.port + i);
      if (i > 0) console.log(`[cctrace] Port ${config.port} busy — using ${server.port} instead`);
    } catch {
      // taken (another instance, or a system proxy) — keep walking
    }
  }
  if (!server) {
    server = serveOn(0);
    console.log(`[cctrace] Ports ${config.port}-${config.port + PORT_WALK - 1} busy — using ${server.port} instead`);
  }
  return {
    port: server.port ?? config.port,
    ingest: onLivePair,
    stop: () => server.stop(true),
  };
}

async function handlePair(req: Request, onLivePair: (pair: TracePair) => void): Promise<Response> {
  try {
    const pair = await req.json() as TracePair;
    onLivePair(pair);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 400 });
  }
}
