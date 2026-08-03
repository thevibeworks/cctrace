// Markdown transcript of a session's reconstructed conversation — the human
// half of the session dump (the .jsonl half is the wire truth, same pair set
// `cctrace merge` would write). Pure: pairs in, markdown out; used by the
// live server's /api/session.md route.
//
// Fidelity rules: user text in full (blockquoted — the human's voice),
// assistant text in full, every tool call one line with its result capped to
// one line, thinking omitted, utility threads omitted (counted in the
// header). Times are UTC — a dump is a shareable artifact, the reader's
// timezone is unknown.
import { buildSession, loopTurns, mainThread, toolPreview } from "./session";
import { shortModel, fmtCompact } from "./summarize";
import { fmtCost } from "./pricing";

const hms = (ts: number) => new Date(ts * 1000).toISOString().slice(11, 19);
const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

function blockText(b: any): string {
  if (!b) return "";
  if (typeof b === "string") return b;
  if (typeof b.text === "string") return b.text;
  if (typeof b.content === "string") return b.content;
  if (Array.isArray(b.content)) return b.content.map(blockText).join("\n");
  return "";
}

/** Real human text only: system-reminder blocks and tool results are noise
 * in a transcript (results attach to their tool line instead). */
function userText(blocks: any[]): string {
  const parts: string[] = [];
  for (const b of blocks || []) {
    if (!b || b.type !== "text" || typeof b.text !== "string") continue;
    const t = b.text.trim();
    if (!t || t.lastIndexOf("<system-reminder>", 0) === 0) continue;
    parts.push(t);
  }
  return parts.join("\n\n");
}

function oneLine(s: string, cap = 200): string {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > cap ? t.slice(0, cap) + "..." : t;
}

const quote = (s: string) => s.split("\n").map((l) => "> " + l).join("\n");

function renderThread(t: any, pairs: any[]): string {
  const out: string[] = [""];
  const kind = t.kind === "agent" ? "subagent" : t.kind;
  out.push("## " + kind + (t.label ? " · " + t.label : "") + (t.model ? " · " + shortModel(t.model) : ""));
  if (t.agentOf) {
    out.push("");
    out.push("dispatched by the parent thread" + (t.agentOf.agentType ? " as [" + t.agentOf.agentType + "]" : ""));
  }
  const vis = (t.turns || []).filter((x: any) => !x.toolResultsOnly);
  // Tool results live in later (often hidden) user turns — index them all.
  const results: Record<string, any> = {};
  for (const turn of t.turns || []) {
    for (const b of turn.blocks || []) {
      if (b && b.type === "tool_result" && b.tool_use_id) results[b.tool_use_id] = b;
    }
  }
  const loops = loopTurns(vis);
  for (let li = 0; li < loops.length; li++) {
    const loop = loops[li];
    const idxs = [...new Set([...(loop.head != null ? [loop.head] : []), ...loop.members])].sort((a: number, b: number) => a - b);
    // The loop's wall-clock: the first turn attribution pinned to a wire
    // pair (user heads rarely carry one — the reply turn does).
    let ts: any = null;
    for (const vi of idxs) {
      const tn = vis[vi];
      if (tn && tn.pairId) { ts = pairs.find((p) => p.id === tn.pairId); if (ts) break; }
    }
    out.push("");
    out.push("### turn " + String(li + 1).padStart(2, "0") + (ts && ts.request ? " · " + hms(ts.request.timestamp || 0) : ""));
    for (const vi of idxs) {
      const turn = vis[vi];
      if (!turn) continue;
      if (turn.role === "user") {
        const txt = userText(turn.blocks);
        if (txt) {
          out.push("");
          out.push(quote(txt));
        }
        continue;
      }
      for (const b of turn.blocks || []) {
        if (!b) continue;
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          out.push("");
          out.push(b.text.trim());
        } else if (b.type === "tool_use" || b.type === "server_tool_use") {
          const res = b.id ? results[b.id] : null;
          const pv = toolPreview(b.name || "?", b.input);
          out.push("");
          out.push("- " + (b.name || "?") + "(" + oneLine(pv, 120) + ")" +
            (res ? " -> " + (res.is_error ? "[err] " : "") + oneLine(blockText(res)) : ""));
        }
        // thinking / redacted_thinking: omitted on purpose
      }
    }
  }
  return out.join("\n");
}

export function renderTranscript(
  pairs: any[],
  wire?: any,
  meta?: { project?: string; client?: string; sid?: string },
): string {
  const { threads } = buildSession(pairs, wire);
  const sid = meta?.sid || (threads.find((t: any) => t.sessionId) || {}).sessionId || "";
  const main = mainThread(threads);
  const rest = threads
    .filter((t: any) => t !== main && t.kind !== "utility")
    .sort((a: any, b: any) => (a.firstAt || 0) - (b.firstAt || 0));
  const utils = threads.filter((t: any) => t !== main && t.kind === "utility");

  let t0 = Infinity, t1 = 0, req = 0, inTok = 0, outTok = 0, cost = 0;
  for (const t of threads) {
    if (t.firstAt) t0 = Math.min(t0, t.firstAt);
    t1 = Math.max(t1, t.lastAt || t.firstAt || 0);
    const u = t.usage || {};
    req += u.requests || 0;
    inTok += u.input || 0;
    outTok += u.output || 0;
    cost += u.cost || 0;
  }

  const out: string[] = [];
  out.push("# session " + (sid || "(no id on the wire)"));
  out.push("");
  const idbits: string[] = [];
  if (meta?.project) idbits.push(meta.project);
  if (meta?.client) idbits.push(meta.client);
  if (t0 !== Infinity) idbits.push(day(t0) + " " + hms(t0) + (t1 > t0 ? " - " + hms(t1) : "") + " UTC");
  if (idbits.length) out.push(idbits.join(" · "));
  out.push(req + " requests · in " + fmtCompact(inTok) + " · out " + fmtCompact(outTok) +
    (cost ? " · est " + fmtCost(cost) : ""));
  if (utils.length) out.push(utils.length + " utility thread" + (utils.length === 1 ? "" : "s") + " (probes, title generation) omitted");

  const convos = main ? [main, ...rest] : rest;
  for (const t of convos) out.push(renderThread(t, pairs));
  return out.join("\n") + "\n";
}
