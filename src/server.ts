import type { ServerWebSocket } from "bun";
import type { TracePair } from "./types";
import { getLiveHtml, type PageMeta } from "./ui";
import { extractSessionId } from "./summarize";
import { loadPriorPairs, loadTraceFiles } from "./history";

export { renderSnapshot } from "./ui";

interface ServerConfig {
  port: number;
  logDir: string;
  /** The current run's log file — excluded from prior-trace scans. */
  logFile?: string;
  /** Disable cross-run history merging (--fresh). */
  noHistory?: boolean;
  /** Trace files to force-merge at startup (--with). */
  withFiles?: string[];
  /** Run identity (project name/path) shown in the page header. */
  meta?: PageMeta;
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
// files, so we never double-write. The page itself lives in ui.ts.
//
// Session continuity: when a live pair reveals a session_id we haven't seen,
// prior traces in logDir are scanned for that session and merged in as
// history (pair.prior = source file), so a --continue'd conversation keeps
// its old turns' usage/duration/wire links instead of looking incomplete.
export function createServer(config: ServerConfig) {
  if (config.withFiles?.length) {
    const merged = mergePairs(loadTraceFiles(config.withFiles));
    if (merged.length) console.log(`[cctrace] merged ${merged.length} pairs from --with`);
  }

  const onLivePair = (pair: TracePair) => {
    mergePairs([pair]);
    broadcast({ type: "pair", pair });
    if (config.noHistory) return;
    const sid = extractSessionId(pair);
    if (!sid || seenSessions.has(sid)) return;
    seenSessions.add(sid);
    const prior = mergePairs(loadPriorPairs(config.logDir, config.logFile || "", new Set([sid])));
    if (prior.length) {
      const files = [...new Set(prior.map((p) => p.prior))].join(", ");
      console.log(`[cctrace] session ${sid.slice(0, 8)} continued — merged ${prior.length} prior pairs from ${files}`);
      broadcast({ type: "history", pairs: prior });
    }
  };

  const serveOn = (port: number) => Bun.serve({
    port,
    fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        if (server.upgrade(req)) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      if (url.pathname === "/api/pair" && req.method === "POST") {
        return handlePair(req, onLivePair);
      }
      if (url.pathname === "/api/pairs") {
        return Response.json(pairs);
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        // Use the actually-bound port so the WebSocket URL is correct even
        // when we fell back off a busy preferred port.
        return new Response(getLiveHtml(server.port ?? port, config.meta), {
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

  // Try the preferred port; if it's taken (e.g. a system proxy owns it),
  // fall back to an OS-assigned free port instead of crashing.
  try {
    return serveOn(config.port);
  } catch {
    const server = serveOn(0);
    console.log(`[cctrace] Port ${config.port} busy — using ${server.port} instead`);
    return server;
  }
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
