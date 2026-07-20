// Cut a sanitized fixture from a real trace: equality-preserving hash
// tokens, zero original text. Structural properties buildSession keys on
// survive; the content does not.
//
//   bun tests/sanitize-trace.ts <trace.jsonl> <out.jsonl.zst> [sid-prefix]
//
// What is preserved (and why):
// - equality classes: the same string always hashes to the same token, so
//   threadSig grouping, turnContentSig attribution, and the anchor merge
//   behave as they did on the original. Whole-string hashing is strictly
//   HARSHER than the runtime's capped-prefix compares (prefix-equal but
//   different strings stop matching) — a fixture that passes here passes
//   on the messier original.
// - marker prefixes: <system-reminder> (firstUserText skips these — lose
//   the prefix and every thread collides on the shared reminder token),
//   <local-command-caveat>/<local-command-stdout>/"Base directory for
//   this skill" (turnSnippet wrappers), the continuation preamble (the
//   reunification vote), and x-anthropic-billing-header system blocks
//   (sysIdentity must keep skipping them).
// - structure: message counts (histLen), block shapes, roles, timestamps,
//   pair ids, usage numbers, the x-claude-code-agent-id header (value
//   hashed), and session ids (mapped to deterministic fake uuids).
//
// What is destroyed: every word of conversation content, tool inputs and
// results, system prompt text, URLs' query strings, all other headers.
import { readTraceText } from "../src/history";
import { parseSse, assembleAssistant, summarizePair } from "../src/summarize";

const [srcPath, outPath, sidFilter] = process.argv.slice(2);
if (!srcPath || !outPath) {
  console.error("usage: bun tests/sanitize-trace.ts <trace.jsonl[.zst|.gz]> <out.jsonl.zst> [sid-prefix]");
  process.exit(1);
}

function h(s: string): string {
  let a = 5381, b = 52711;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = ((a * 33) ^ c) >>> 0;
    b = ((b * 37) ^ c) >>> 0;
  }
  return a.toString(36) + b.toString(36);
}

const PREFIXES = [
  "<system-reminder>",
  "<local-command-caveat>",
  "<local-command-stdout>",
  "Base directory for this skill",
  "This session is being continued from a previous conversation",
  "x-anthropic-billing-header",
];

function sanText(s: string): string {
  if (typeof s !== "string" || !s) return s;
  for (const p of PREFIXES) {
    if (s.lastIndexOf(p, 0) === 0) return p + " [h:" + h(s) + "]";
  }
  return "[h:" + h(s) + "]";
}

function sanValue(v: unknown): unknown {
  if (typeof v === "string") return sanText(v);
  if (Array.isArray(v)) return v.map(sanValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = sanValue(x);
    return out;
  }
  return v;
}

function sanBlocks(content: unknown): unknown {
  if (typeof content === "string") return sanText(content);
  if (!Array.isArray(content)) return content;
  return content.map((b: any) => {
    if (!b || typeof b !== "object") return b;
    const out: any = { type: b.type };
    if (typeof b.text === "string") out.text = sanText(b.text);
    if (b.type === "tool_use" || b.type === "server_tool_use") {
      out.id = b.id;
      out.name = b.name;
      out.input = sanValue(b.input);
    }
    if (b.type === "tool_result") {
      out.tool_use_id = b.tool_use_id;
      if (b.is_error) out.is_error = true;
      out.content = sanBlocks(b.content);
    }
    if (b.type === "thinking") out.thinking = "[h:" + h(String(b.thinking || "")) + "]";
    return out;
  });
}

const sidMap = new Map<string, string>();
function sanSid(sid: string): string {
  let v = sidMap.get(sid);
  if (!v) {
    const t = h(sid).padEnd(12, "0").slice(0, 12);
    v = t.slice(0, 8) + "-" + t.slice(8, 12) + "-4aaa-8bbb-ccccdddd0000";
    sidMap.set(sid, v);
  }
  return v;
}

const lines = readTraceText(srcPath).split("\n").filter(Boolean);
const out: string[] = [];
let kept = 0;
for (const line of lines) {
  let p: any;
  try { p = JSON.parse(line); } catch { continue; }
  const body = p?.request?.body;
  if (!body || !Array.isArray(body.messages) || !/\/v1\/messages(\?|$)/.test(p.request.url || "")) continue;
  let sid = "";
  try { sid = JSON.parse(body.metadata?.user_id || "{}").session_id || ""; } catch { /* keep "" */ }
  if (sidFilter && sid.lastIndexOf(sidFilter, 0) !== 0) continue;

  const sys = body.system;
  const sanSys = typeof sys === "string" ? sanText(sys)
    : Array.isArray(sys) ? sys.map((b: any) => ({ type: "text", text: sanText(String(b?.text || "")) })) : sys;
  const info = summarizePair(p) ? null : null; // (placeholder: usage comes from the stream below)
  const events = p.response?.bodyRaw ? parseSse(p.response.bodyRaw) : [];
  const blocks = p.response?.body?.content ? sanBlocks(p.response.body.content) : sanBlocks(assembleAssistant(events));
  let usage: any = p.response?.body?.usage || null;
  let model = p.response?.body?.model || body.model;
  for (const ev of events) {
    if (ev?.type === "message_start" && ev.message) { usage = { ...ev.message.usage }; model = ev.message.model || model; }
    if (ev?.type === "message_delta" && ev.usage) usage = { ...usage, ...ev.usage };
  }

  const agentId = p.request.headers?.["x-claude-code-agent-id"];
  out.push(JSON.stringify({
    id: p.id,
    client: p.client,
    request: {
      timestamp: p.request.timestamp,
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: agentId ? { "x-claude-code-agent-id": "agent-" + h(String(agentId)) } : {},
      body: {
        model: body.model,
        max_tokens: body.max_tokens,
        stream: true,
        metadata: sid ? { user_id: JSON.stringify({ session_id: sanSid(sid) }) } : undefined,
        system: sanSys,
        tools: Array.isArray(body.tools)
          ? body.tools.map((t: any) => ({ name: t?.name || "?", description: "[h:" + h(String(t?.description || "")) + "]" }))
          : body.tools,
        messages: body.messages.map((m: any) => ({ role: m.role, content: sanBlocks(m.content) })),
      },
    },
    response: p.response ? {
      timestamp: p.response.timestamp,
      status: p.response.status,
      headers: {},
      body: { model, content: blocks, usage, stop_reason: "end_turn" },
      truncated: p.response.truncated || undefined,
    } : undefined,
    duration: p.duration,
    loggedAt: "sanitized",
  }));
  kept++;
}

Bun.write(outPath, Bun.zstdCompressSync(Buffer.from(out.join("\n") + "\n"), { level: 19 }));
console.log(`kept ${kept}/${lines.length} pairs -> ${outPath} (${out.join("\n").length} bytes raw)`);
