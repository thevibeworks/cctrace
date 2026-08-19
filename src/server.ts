import type { ServerWebSocket } from "bun";
import type { TracePair } from "./types";
import { getLiveHtml, renderSnapshot, type PageMeta } from "./ui";
import { sliceWindow, pairEndMs } from "./replay";
import { createSpecAccumulator, renderSpecMarkdown } from "./spec";
import { renderTranscript } from "./transcript";
import { planCompact, applyCompact } from "./compact";
import { categorizeUrl } from "./categorize";
import { extractSessionId } from "./summarize";
import { firstPromptOfPair } from "./session";
import { wireTables } from "./clients";
import { loadPriorPairs, loadTraceFiles } from "./history";
import { termWrite } from "./termlog";
import { listLiveInstances, listPastRuns, listAllRuns, SCAN_PORTS, PORT_WALK, type InstanceInfo } from "./instances";
import { getDashboardHtml } from "./dashboard";
import { resolveView, findTraceCarrier } from "./view";
import { projectTraceDir } from "./store";
import { statSync, existsSync } from "fs";
import { dirname, basename, resolve } from "path";

const WIRE = wireTables();

export { renderSnapshot, verifySnapshot } from "./ui";

/** The project's store dir for a registry entry — findTraceCarrier's last
 * place to look (an adopted trace, or one another container captured
 * straight into the shared store). */
const storeDirFor = (dataDir: string | undefined, i: InstanceInfo): string | undefined =>
  dataDir && i.projectPath ? projectTraceDir(dataDir, i.projectPath) : undefined;

interface ServerConfig {
  port: number;
  /** The run's log dir — where housekeeping (web compact) acts. */
  logDir: string;
  /** Dirs continuity readers scan for prior traces (the store dir first,
   * then a legacy ./.cctrace); defaults to [logDir]. */
  readDirs?: string[];
  /** The current run's log file — excluded from prior-trace scans. */
  logFile?: string;
  /** Current trace file size on disk — the header's .jsonl metric. */
  traceSize?: () => number;
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
  /** Called once, with the human's first real prompt seen on the wire —
   * capture-time identity for the registry entry / view picker. */
  onPrompt?: (snippet: string) => void;
  /**
   * Deletes the given (already memory-removed) pairs from their backing
   * trace files — the web UI's select-to-purge. Absent = memory-only purge
   * (pairs return on the next restart/reload from disk).
   */
  onPurge?: (removed: TracePair[]) => { files: string[]; skippedFiles: string[] };
  /**
   * Session id to preload as a GUESS at startup (`--continue` before the
   * first request reveals the real one). Confirmed or evicted when the
   * first live pair carries a session id.
   */
  speculate?: string;
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
    // Streamed reads are async; the page that connects first sees them land
    // as a "history" push, exactly like a continuity merge.
    loadTraceFiles(config.withFiles).then((loaded) => {
      const merged = mergePairs(loaded);
      if (!merged.length) return;
      termWrite(`[cctrace] merged ${merged.length} pairs from --with`);
      broadcast({ type: "history", pairs: merged });
    }).catch(() => {});
  }

  // Speculative continuity: --continue can't reveal its session until the
  // first request, but the newest prior session is almost always the one
  // being resumed. Preload it so the UI opens populated; the first live
  // session id confirms the guess or evicts the preload.
  let speculativeSid: string | null = null;
  let promptStamped = false;
  // The preload arrives async (streamed from disk); until it lands, or if
  // the first live request beats it, the guess is simply not made.
  if (config.speculate && !config.noHistory) {
    const guess = config.speculate;
    loadPriorPairs(config.readDirs ?? config.logDir, config.logFile || "", new Set([guess])).then((prior) => {
      if (!prior.length || seenSessions.size) return; // a real session already spoke
      for (const p of prior) (p as TracePair & { speculative?: boolean }).speculative = true;
      const merged = mergePairs(prior);
      if (!merged.length) return;
      speculativeSid = guess;
      termWrite(`[cctrace] preloaded ${merged.length} pairs from session ${guess.slice(0, 8)} — confirming on first request`);
      broadcast({ type: "history", pairs: merged });
    }).catch(() => {});
  }

  const resolveSpeculation = (sid: string) => {
    if (sid === speculativeSid) {
      // Guess was right: the preload IS the continuity merge (loadPriorPairs
      // already swept the whole dir for this sid), so skip the rescan.
      for (const p of pairs) delete (p as TracePair & { speculative?: boolean }).speculative;
      seenSessions.add(sid);
      config.onSession?.(sid);
      termWrite(`[cctrace] session ${sid.slice(0, 8)} continued — preloaded turns confirmed`);
    } else {
      // Wrong guess: drop the preload and make every client rebuild from the
      // corrected list (init replaces wholesale). The real sid then flows
      // through the normal continuity path below.
      let evicted = 0;
      for (let i = pairs.length - 1; i >= 0; i--) {
        if ((pairs[i] as TracePair & { speculative?: boolean }).speculative) {
          knownIds.delete(pairs[i].id);
          pairs.splice(i, 1);
          evicted++;
        }
      }
      if (evicted) {
        broadcast({ type: "init", pairs, traceBytes: config.traceSize?.() });
        termWrite(`[cctrace] resumed a different session — dropped ${evicted} preloaded pairs`);
      }
    }
    speculativeSid = null;
  };

  const onLivePair = (pair: TracePair) => {
    // A pair the server already holds is not news: capture ids are unique,
    // but a --tail follower re-scanning a truncated file replays old lines
    // — broadcasting those would duplicate rows on every connected page.
    if (!mergePairs([pair]).length) return;
    broadcast({ type: "pair", pair, traceBytes: config.traceSize?.() });
    if (config.onPrompt && !promptStamped) {
      const prompt = firstPromptOfPair(pair);
      if (prompt) {
        promptStamped = true;
        config.onPrompt(prompt.slice(0, 120));
      }
    }
    const sid = extractSessionId(pair, WIRE);
    if (!sid) return;
    if (speculativeSid) resolveSpeculation(sid);
    if (seenSessions.has(sid)) return;
    seenSessions.add(sid);
    config.onSession?.(sid);
    if (config.noHistory) return;
    loadPriorPairs(config.readDirs ?? config.logDir, config.logFile || "", new Set([sid])).then((loaded) => {
      const prior = mergePairs(loaded);
      if (!prior.length) return;
      const files = [...new Set(prior.map((p) => p.prior))].join(", ");
      termWrite(`[cctrace] session ${sid.slice(0, 8)} continued — merged ${prior.length} prior pairs from ${files}`);
      broadcast({ type: "history", pairs: prior });
    }).catch(() => {});
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
      if (url.pathname === "/api/purge" && req.method === "POST") {
        // Select-to-purge from the web UI: remove named pairs from memory
        // AND the backing trace files (via config.onPurge), then tell every
        // connected page. Trust boundary: anyone who can load the page can
        // already read the whole trace; purge only ever deletes trace data,
        // and only pairs this server holds.
        try {
          const body = (await req.json()) as { ids?: unknown };
          const ids = Array.isArray(body?.ids)
            ? body.ids.filter((x): x is string => typeof x === "string")
            : [];
          if (!ids.length) return Response.json({ error: "ids required" }, { status: 400 });
          const idSet = new Set(ids);
          const removedPairs: TracePair[] = [];
          for (let i = pairs.length - 1; i >= 0; i--) {
            const p = pairs[i]!;
            if (idSet.has(p.id)) {
              removedPairs.push(p);
              knownIds.delete(p.id);
              pairs.splice(i, 1);
            }
          }
          let files: string[] = [];
          let skippedFiles: string[] = [];
          if (removedPairs.length && config.onPurge) {
            ({ files, skippedFiles } = config.onPurge(removedPairs));
          }
          if (removedPairs.length) broadcast({ type: "purged", ids: removedPairs.map((p) => p.id) });
          return Response.json({ ok: true, removed: removedPairs.length, files, skippedFiles });
        } catch (e) {
          return Response.json({ error: String(e) }, { status: 400 });
        }
      }
      if (url.pathname === "/api/compact" && req.method === "POST") {
        // The web face of `cctrace compact`: dry-run plan by default,
        // {apply:true} rewrites. applyCompact re-stats every file — one a
        // live capture appended to since the plan is skipped, not torn.
        try {
          const body = (await req.json().catch(() => ({}))) as { apply?: boolean };
          const cat = (u: string, client?: string) => categorizeUrl(u, client, WIRE);
          const plan = planCompact(config.logDir, cat, WIRE);
          if (!body?.apply) {
            return Response.json({ ok: true, applied: false, files: plan.files.length, stubbed: plan.stubbed, collapsed: plan.collapsed, savedBytes: plan.savedBytes });
          }
          const res = applyCompact(plan, cat, WIRE);
          return Response.json({ ok: true, applied: true, rewritten: res.rewritten.length, skipped: res.skipped.length, savedBytes: res.bytes });
        } catch (e) {
          return Response.json({ error: String(e) }, { status: 500 });
        }
      }
      if (url.pathname === "/api/snapshot.html") {
        // The web face of `view --html`: a full self-contained snapshot of
        // everything this server holds. On-demand only — big sessions make
        // big files, which is exactly why live runs stopped writing these.
        return new Response(renderSnapshot(pairs, { ...config.meta, mode: undefined }), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-disposition": `attachment; filename="cctrace-snapshot-${pairs.length}pairs.html"`,
          },
        });
      }
      if (url.pathname === "/api/spec.json" || url.pathname === "/api/spec.md") {
        // The web face of `cctrace spec`: the observed-wire catalog of this
        // run's pairs. Same redaction guarantees as the CLI (values never
        // enter the artifact except negotiation headers + model ids).
        const acc = createSpecAccumulator({ generator: "cctrace live server" });
        acc.add(pairs);
        const catalog = acc.finish();
        const md = url.pathname.endsWith(".md");
        return new Response(md ? renderSpecMarkdown(catalog) : JSON.stringify(catalog, null, 2), {
          headers: {
            "content-type": md ? "text/markdown; charset=utf-8" : "application/json",
            "content-disposition": `attachment; filename="wire-spec.${md ? "md" : "json"}"`,
          },
        });
      }
      if (url.pathname === "/api/session.jsonl" || url.pathname === "/api/session.md") {
        // The session dump: every pair of ONE session — the same set
        // `cctrace merge` writes to session-<sid8>.jsonl — as raw wire
        // pairs, or rendered as a markdown transcript. Viewer-only load
        // markers (prior/speculative) are stripped from the .jsonl: they
        // describe this server's load path, not the wire.
        const sid = url.searchParams.get("sid") || "";
        if (!sid) return Response.json({ error: "sid required" }, { status: 400 });
        const sel = pairs.filter((p) => extractSessionId(p, WIRE) === sid);
        if (!sel.length) return Response.json({ error: "unknown session id" }, { status: 404 });
        const short = sid.slice(0, 8);
        if (url.pathname.endsWith(".md")) {
          const body = renderTranscript(sel, WIRE, { project: config.meta?.project, client: config.meta?.client, sid });
          return new Response(body, {
            headers: {
              "content-type": "text/markdown; charset=utf-8",
              "content-disposition": `attachment; filename="session-${short}.md"`,
            },
          });
        }
        const lines = sel.map((p) => {
          const { prior, speculative, ...rest } = p as TracePair & { prior?: string; speculative?: boolean };
          return JSON.stringify(rest);
        });
        return new Response(lines.join("\n") + "\n", {
          headers: {
            "content-type": "application/x-ndjson; charset=utf-8",
            "content-disposition": `attachment; filename="session-${short}.jsonl"`,
          },
        });
      }
      if (url.pathname === "/api/slice.html") {
        // Slice export: a snapshot holding exactly the pairs whose response
        // completed between the two named pairs' ends (inclusive) — the
        // shareable artifact behind the UI's "export" button. Addressed by
        // pair ids, same as the deep link, so the URL survives merges.
        const from = url.searchParams.get("from") || "";
        const to = url.searchParams.get("to") || "";
        const pa = pairs.find((p) => p.id === from);
        const pb = pairs.find((p) => p.id === to);
        if (!pa || !pb) return Response.json({ error: "unknown slice pair id" }, { status: 404 });
        const win = sliceWindow(pairs, pairEndMs(pa), pairEndMs(pb));
        const html = renderSnapshot(win, { ...config.meta, mode: undefined });
        return new Response(html, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-disposition": `attachment; filename="slice-${win.length}pairs.html"`,
          },
        });
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
      if (url.pathname === "/api/runs") {
        // Finished runs (registry tombstones) for the dashboard — the live
        // side is /api/instances. The trace is re-resolved per request via
        // findTraceCarrier: the tombstone's logFile routinely stops being
        // the trace's real name on THIS host (compress renamed it .zst/.gz,
        // a later run's auto-merge absorbed it into session-<sid8>.jsonl),
        // so a single stat would grey out perfectly viewable runs. The
        // carrier's stat also carries the current on-disk size (post-
        // merge/compress, so fresher than anything stamped at exit).
        const list = config.dataDir ? listPastRuns(config.dataDir) : [];
        return Response.json(list.map((i) => {
          const carrier = i.logFile ? findTraceCarrier(i.logFile, i.sessionId, storeDirFor(config.dataDir, i)) : null;
          return {
            ...i,
            traceExists: carrier !== null,
            ...(carrier ? { traceBytes: carrier.bytes } : {}),
            ...(carrier && carrier.path !== i.logFile ? { traceCarrier: carrier.path } : {}),
          };
        }));
      }
      if (url.pathname.startsWith("/view/")) {
        // Direct-open for a finished run: the dashboard row's click target.
        // The run id resolves through the REGISTRY — the client never names
        // a path, so this cannot read arbitrary files. Rendered on demand
        // from the run's trace (by session id when known, merging every
        // trace of that session in its log dir — the same continuity the
        // CLI's `cctrace view <sid>` gets; by file otherwise).
        const id = decodeURIComponent(url.pathname.slice("/view/".length));
        const run = config.dataDir ? listAllRuns(config.dataDir).find((r) => r.id === id) : undefined;
        if (!run?.logFile) return new Response("unknown run id", { status: 404 });
        try {
          // Session-id first (merges every trace of the session), but the
          // registry's sid can be REDACTED (masked uuid) or purged from the
          // traces — any resolve failure falls back to the trace file, via
          // findTraceCarrier because the tombstone's logFile may have been
          // renamed by compress or absorbed into a session file since.
          // The carrier decides WHERE the session's traces live now (the
          // recorded dir, or the project's store dir after an adopt), then
          // every trace of the session in that dir merges in.
          const carrier = findTraceCarrier(run.logFile, run.sessionId, storeDirFor(config.dataDir, run));
          if (!carrier) {
            return new Response(
              `trace missing: ${run.logFile} (deleted, or recorded by another machine and not adopted into the store)`,
              { status: 404 },
            );
          }
          // Both the carrier's dir and the project's store dir: a session
          // that spans the upgrade has traces in a legacy ./.cctrace AND
          // the store, and `cctrace view <sid>` in the project reads both.
          const storeDir = storeDirFor(config.dataDir, run);
          const viewDirs = [dirname(carrier.path)];
          if (storeDir && existsSync(storeDir) && resolve(storeDir) !== resolve(viewDirs[0]!)) viewDirs.push(storeDir);
          let result;
          try {
            result = run.sessionId ? await resolveView(run.sessionId, viewDirs) : null;
          } catch {
            result = null;
          }
          if (!result) result = await resolveView(carrier.path, viewDirs);
          let traceBytes = 0;
          for (const p of result.sourcePaths) { try { traceBytes += statSync(p).size; } catch {} }
          const html = renderSnapshot(result.pairs, {
            version: config.meta?.version,
            pricing: config.meta?.pricing,
            latestVersion: config.meta?.latestVersion,
            project: run.project || undefined,
            projectPath: run.projectPath || undefined,
            client: run.client,
            traceFile: basename(carrier.path),
            traceRelPath: carrier.path,
            traceBytes,
          });
          return new Response(html, { headers: { "Content-Type": "text/html" } });
        } catch (e) {
          return new Response(`could not render run: ${e instanceof Error ? e.message : e}`, { status: 500 });
        }
      }
      if (url.pathname === "/dashboard") {
        // The central picture: every live + recent run sharing this data
        // dir. Any instance's port serves the same page — the registry is
        // shared, so there is no "main" instance to hunt for.
        return new Response(getDashboardHtml({ version: config.meta?.version }), {
          headers: { "Content-Type": "text/html" },
        });
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        // Root redirects to the dashboard — the right landing page when
        // arriving via a hostname (cctrace.localhost) or a bookmark. The
        // live trace lives at /trace; openBrowser links there directly.
        return Response.redirect(new URL("/dashboard", req.url).href, 302);
      }
      if (url.pathname === "/trace") {
        // The page connects its WebSocket origin-relative, so no port is
        // baked in — behind container/host port forwards the bound port is
        // not the port the browser sees.
        return new Response(getLiveHtml(config.meta), {
          headers: { "Content-Type": "text/html" },
        });
      }
      if (url.pathname === "/s" || url.pathname.startsWith("/s/")) {
        // Short session jump — the URL a statusline can afford to print:
        // /s/<sid-prefix> lands on that session's conversation, /s on the
        // newest one. A pure rewrite to the hash route: the page already
        // resolves sid prefixes (falling back to the newest thread) and
        // enters the live sessions view scrolled to the newest turn, so
        // the server adds no state — and the self-describing /trace#…
        // URL is what the browser bar, history, and bookmarks keep.
        const rest = url.pathname.slice(3);
        return Response.redirect(
          new URL(`/trace#/session${rest ? `/${rest}` : ""}`, req.url).href,
          302,
        );
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        ws.send(JSON.stringify({ type: "init", pairs, traceBytes: config.traceSize?.() }));
      },
      close(ws) {
        clients.delete(ws);
      },
      message() {},
    },
  });

  // Try the preferred port, then the next few (so concurrent instances land
  // on predictable neighbors: 8722, 8723, ... — the same walk SCAN_PORTS
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
