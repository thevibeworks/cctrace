import type { ServerWebSocket } from "bun";
import type { TracePair } from "./types";
import { getLiveHtml } from "./ui";

export { renderSnapshot } from "./ui";

interface ServerConfig {
  port: number;
  logDir: string;
  logName?: string;
}

const clients = new Set<ServerWebSocket<unknown>>();
const pairs: TracePair[] = [];

function broadcast(data: unknown) {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    ws.send(msg);
  }
}

// The live server is a broadcast relay only — it holds pairs in memory and
// pushes them to connected browsers. The CLI's log sink owns the .jsonl/.html
// files, so we never double-write. The page itself lives in ui.ts.
export function createServer(config: ServerConfig) {
  const serveOn = (port: number) => Bun.serve({
    port,
    fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        if (server.upgrade(req)) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      if (url.pathname === "/api/pair" && req.method === "POST") {
        return handlePair(req);
      }
      if (url.pathname === "/api/pairs") {
        return Response.json(pairs);
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        // Use the actually-bound port so the WebSocket URL is correct even
        // when we fell back off a busy preferred port.
        return new Response(getLiveHtml(server.port ?? port), {
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

async function handlePair(req: Request): Promise<Response> {
  try {
    const pair = await req.json() as TracePair;
    pairs.push(pair);
    broadcast({ type: "pair", pair });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 400 });
  }
}
