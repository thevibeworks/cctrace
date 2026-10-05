/** Public demo: a REAL captured session, rendered by the shipped cctrace UI.
 *
 * Capture it first (docs/demo/capture.sh) — a sandboxed Claude Code run whose
 * context holds nothing personal by construction — then render it:
 *
 *   bun run docs/demo/build.ts ~/cctrace-demo/trace/trace-*.jsonl
 *
 * Three safety layers, in order of strength:
 *   1. Capture: credentials never reach disk (src/redact.ts); --redact-ids
 *      masks account/session/device ids as they are captured.
 *   2. Build: SCRUB rewrites machine-local identifiers (home paths, the
 *      operator's proxy, stray addresses) that the sandbox could not avoid,
 *      and pseudonymizes the operator's account ids read from their own
 *      config files (telemetry carries them under keys --redact-ids has
 *      no name for).
 *   3. Publish gate: SCAN greps the FINAL html for anything that looks
 *      personal and fails the build on a hit. A demo is not worth a leak.
 *
 * Writes docs/demo/sample.html (the interactive page) and
 * docs/assets/demo-data.js (the landing page's context chart, computed by the
 * production calculator from the same session).
 */
import { copyFileSync, mkdirSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { renderSnapshot, verifySnapshot } from "../../src/ui";
import { buildSession, mainThread } from "../../src/session";
import { contextComposition, CTX_CATS } from "../../src/context";
import { createFold } from "../../src/fold";
import { readTracePairs } from "../../src/history";
import { categorizeUrl } from "../../src/categorize";
import { wireTables } from "../../src/clients";
import { stepCost } from "../../src/cost";
import { extractCallInfo } from "../../src/summarize";
import type { TracePair } from "../../src/types";
import { version } from "../../package.json";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const traces = args.filter((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--"));
if (!traces.length) {
  console.error("usage: bun run docs/demo/build.ts <trace.jsonl> [--bytes N | --full] [--force]");
  process.exit(2);
}
/** Bodies the page may carry in full. The rest fold to stubs (src/fold.ts) —
 * every request still reaches the page, with its timings, tokens and cost. */
const BODY_BYTES = Number(flag("bytes", String(8 * 1024 * 1024)));
const FORCE = args.includes("--force");

// ---------------------------------------------------------------- scrub ----
// Machine-local identifiers the sandbox cannot avoid carrying. Each rule is
// narrow and counted: a rule that never fires is reported, so this list stays
// honest instead of growing into decoration.
const SCRUB: [RegExp, string][] = [
  // The sandbox's own home first — it sits under the demo root, so the demo
  // root rule would otherwise rewrite it into a path the scan reads as real.
  [/\/home\/[a-z][a-z0-9_-]*\/cctrace-demo\/home/g, "/home/agent"],
  [/\/home\/[a-z][a-z0-9_-]*\/cctrace-demo\/cctrace/g, "/work/cctrace"],
  [/\/home\/[a-z][a-z0-9_-]*\/cctrace-demo/g, "/work"],
  [/\/Users\/[A-Za-z0-9._-]+/g, "/work"],
  [/\/home\/[a-z][a-z0-9_-]*/g, "/home/agent"],
  [/-home-[a-z0-9-]*cctrace-demo-cctrace/g, "-work-cctrace"],
  [/-(home|Users)-[A-Za-z0-9-]+/g, "-work"],
  [/host\.docker\.internal(:\d+)?/g, "proxy.local"],
  [/\bDEVA_[A-Z0-9_]+\s*=\s*\S+/g, "DEVA_VAR=[REDACTED]"],
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  // Addresses that are not the demo identity the capture sets on purpose.
  [/[A-Za-z0-9._%+-]+@(?!cctrace\.dev|example\.com|anthropic\.com|noreply\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "demo@example.com"],
];
// One block the sandbox cannot keep out: Claude Code reads the operator's
// global ~/.claude/CLAUDE.md even with HOME and CLAUDE_CONFIG_DIR pointed at a
// sandbox (measured 2026-09-14 on cc 2.1.272 — it does not resolve that path
// from the environment). It is a personal file, so the build SUBSTITUTES it
// with the demo profile's own instructions, byte for byte in the wire JSON,
// and says so in the report. Everything else on the page is what the wire
// carried. Set DEMO_KEEP_OPERATOR_MEMORY=1 to publish it as captured.
const OPERATOR_MEMORY = `${process.env.HOME}/.claude/CLAUDE.md`;
let substituted = 0;
let lineSwept = 0;
function operatorMemoryText(): string {
  if (process.env.DEMO_KEEP_OPERATOR_MEMORY === "1") return "";
  try { return readFileSync(OPERATOR_MEMORY, "utf8").trim(); } catch { return ""; }
}
function substituteOperatorMemory(json: string): string {
  const original = operatorMemoryText();
  if (!original) return json;
  const replacement = readFileSync(new URL("profile/claude-user.md", import.meta.url), "utf8").trim();
  const esc = (t: string) => JSON.stringify(t).slice(1, -1);
  // Two forms reach the wire: the injected instruction block (raw), and the
  // Read tool's line-numbered rendering when the agent opens the file itself.
  const numbered = (t: string) => t.split("\n").map((l, i) => `${i + 1}\t${l}`).join("\n");
  let out = json;
  for (const [from, to] of [[original, replacement], [numbered(original), numbered(replacement)]]) {
    const parts = out.split(esc(from));
    substituted += parts.length - 1;
    out = parts.join(esc(to));
  }
  // Whatever survives (a truncated read, a differently numbered rendering) is
  // swept line by line. Ugly on the page, but a leak is worse than a gap.
  for (const line of original.split("\n")) {
    const t = line.trim();
    if (t.length < 30) continue;
    const parts = out.split(esc(t));
    if (parts.length > 1) { lineSwept += parts.length - 1; out = parts.join("[removed from the public demo]"); }
  }
  return out;
}

// The operator's account identity. --redact-ids masks the identity fields
// the capture knows by key, but Claude Code's telemetry (statsig, datadog)
// carries the organization uuid, account uuid and device id under other
// keys and inside hash attributes — measured 2026-10-05: 1,529 copies of the
// org uuid in a sample that had passed the gate. So the build reads the ids
// from the operator's own config files and pseudonymizes each one, and the
// gate (below) checks for the same ids by construction.
const OPERATOR_CONFIG = [
  `${process.env.CLAUDE_CONFIG_DIR || `${process.env.HOME}/.claude`}/.credentials.json`,
  `${process.env.HOME}/.claude.json`,
  `${process.env.HOME}/.claude/.credentials.json`,
];
function operatorIdentityIds(): string[] {
  const ids = new Set<string>();
  for (const path of OPERATOR_CONFIG) {
    let text = "";
    try { text = readFileSync(path, "utf8"); } catch { continue; }
    for (const m of text.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) ids.add(m[0]);
    for (const m of text.matchAll(/"(?:userID|deviceID|device_id|account_?uuid|organization_?uuid)"\s*:\s*"([0-9a-f]{16,})"/gi)) ids.add(m[1]!);
  }
  return [...ids].sort();
}
const OPERATOR_IDS = operatorIdentityIds();
function pseudonym(id: string, index: number): string {
  const tag = String(index + 1).padStart(4, "0");
  return id.includes("-") ? `00000000-0000-4000-8000-00000000${tag}` : "0".repeat(id.length - 4) + tag;
}
let identityHits = 0;
function scrubIdentity(text: string): string {
  let out = text;
  OPERATOR_IDS.forEach((id, i) => {
    const parts = out.split(id);
    identityHits += parts.length - 1;
    out = parts.join(pseudonym(id, i));
  });
  return out;
}

const scrubHits = new Map<number, number>();
function scrub(text: string): string {
  let out = text;
  SCRUB.forEach(([re, to], i) => {
    out = out.replace(re, () => {
      scrubHits.set(i, (scrubHits.get(i) || 0) + 1);
      return to;
    });
  });
  return scrubIdentity(out);
}

// ----------------------------------------------------------------- scan ----
// The publish gate. Anything here in the rendered page fails the build.
const SCAN: [string, RegExp][] = [
  ["home path", /\/(Users|home)\/(?!agent\b)[A-Za-z0-9._-]+/],
  ["api key", /sk-ant-[A-Za-z0-9_-]{8,}/],
  ["jwt", /eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["operator proxy", /host\.docker\.internal/],
  ["deva env var", /DEVA_[A-Z0-9_]{3,}/],
  ["credentials file", /\.credentials\.json/],
  ["email", /[A-Za-z0-9._%+-]+@(?!cctrace\.dev|example\.com|anthropic\.com|users\.noreply\.github\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
];
function scan(html: string): string[] {
  const found: string[] = [];
  // Built from the operator's own file, so the gate cannot be fooled by a
  // rendering the substitution did not anticipate.
  const memo = operatorMemoryText();
  for (const line of memo.split("\n")) {
    const t = line.trim();
    if (t.length < 40) continue;
    if (html.includes(JSON.stringify(t).slice(1, -1)) || html.includes(t)) {
      found.push(`operator memory: ${t.slice(0, 60)}…`);
      break;
    }
  }
  // Same construction for identity: the ids come from the operator's files,
  // so a telemetry field the scrub did not anticipate still fails the gate.
  for (const id of OPERATOR_IDS) {
    if (html.includes(id)) found.push(`operator identity: ${id.slice(0, 8)}… (${html.split(id).length - 1} copies)`);
  }
  for (const [label, re] of SCAN) {
    const global = new RegExp(re.source, "g");
    const hits = new Set<string>();
    for (const m of html.matchAll(global)) {
      hits.add(html.slice(Math.max(0, m.index! - 30), m.index! + m[0].length + 30).replace(/\s+/g, " "));
      if (hits.size >= 3) break;
    }
    if (hits.size) found.push(`${label}: ${[...hits].join(" | ")}`);
  }
  return found;
}

// ------------------------------------------------------------------ read ----
const WIRE = wireTables();
// A demo page should never show a reader a stub it cannot open: a folded body
// is fetched back from the serving cctrace, and a published file has none. So
// --full (the default for a trace this size) carries every byte.
const FULL = args.includes("--full") || !args.includes("--bytes");
const fold = createFold({
  categorize: (url: string, pair?: TracePair) => categorizeUrl(url, pair, WIRE),
  wire: WIRE,
  bodyBytes: BODY_BYTES,
});
let rawBytes = 0;
let raw: TracePair[] = [];
let folded: any = { superseded: 0, budgeted: 0, foldedBytes: 0 };
for (const path of traces) {
  rawBytes += statSync(path).size;
  if (FULL) raw = raw.concat((await readTracePairs(path)).pairs);
  else await fold.addFile(path);
}
if (!FULL) {
  folded = fold.finish();
  raw = folded.pairs;
}
const pairs: TracePair[] = JSON.parse(scrub(substituteOperatorMemory(JSON.stringify(raw))));
if (!pairs.length) throw new Error("no pairs in trace");

// --------------------------------------------------------------- inspect ----
const session = buildSession(pairs);
const main = mainThread(session.threads);
if (!main) throw new Error("no main session in trace");
const agents = session.threads.filter((t: any) => t.agentOf).length;
const cats = new Map<string, number>();
for (const p of pairs) {
  const c = categorizeUrl(p.request.url, p, WIRE);
  cats.set(c, (cats.get(c) || 0) + 1);
}
let inTok = 0, cacheRead = 0, outTok = 0, cost = 0;
for (const p of pairs) {
  const info = extractCallInfo(p as any);
  if (info) {
    inTok += info.input || 0;
    cacheRead += info.cacheRead || 0;
    outTok += info.output || 0;
  }
  cost += stepCost(p as any)?.total || 0;
}

// ---------------------------------------------------------------- render ----
const first = pairs[0]!.request.timestamp;
const last = pairs[pairs.length - 1]!.request.timestamp;
let html = renderSnapshot(pairs, {
  project: "cctrace",
  projectPath: "/work/cctrace",
  client: "claude",
  mode: "view",
  traceFile: basename(traces[0]!),
  version,
});
// The tab name a reader sees when they open the link from somewhere else.
html = html.replace(/<title>[^<]*<\/title>/, "<title>cctrace — a real Claude Code session, captured</title>");
const broken = verifySnapshot(html, pairs.length);
if (broken) throw new Error(broken);
const leaks = scan(html);
if (leaks.length) {
  console.error("\nPUBLISH GATE FAILED — the page still carries:");
  for (const l of leaks) console.error("  - " + l);
  if (!FORCE) {
    console.error("\nAdd a SCRUB rule (or re-capture) and rebuild. --force overrides.\n");
    process.exit(1);
  }
  console.error("\n--force given: writing anyway.\n");
}
writeFileSync(new URL("sample.html", import.meta.url), html);

// The landing page's chart reads the same session through the same calculator.
const pairOf = (id: string) => pairs.find((p) => p.id === id);
const steps = pairs
  .filter((p) => main.pairIds.includes(p.id))
  .map((p) => ({ id: p.id, composition: contextComposition(p as any, pairOf) }))
  .filter((s) => s.composition && s.composition.est > 0);
// The page's "open this request" link: the heaviest step of the main thread —
// the one whose window is worth opening.
const peak = steps.reduce((a, b) => (b.composition.est > a.composition.est ? b : a), steps[0]);
mkdirSync(new URL("../assets/", import.meta.url), { recursive: true });
copyFileSync(
  new URL("../../assets/cctrace-logo.svg", import.meta.url),
  new URL("../assets/logo.svg", import.meta.url),
);
writeFileSync(
  new URL("../assets/demo-data.js", import.meta.url),
  "const CCTRACE_DEMO = " + JSON.stringify(steps) + ";\n" +
    "const CCTRACE_CATEGORIES = " + JSON.stringify(CTX_CATS) + ";\n" +
    "const CCTRACE_DEMO_PAIR = " + JSON.stringify(peak?.id || "") + ";\n",
);

// ---------------------------------------------------------------- report ----
const mb = (n: number) => (n / 1024 / 1024).toFixed(1) + " MB";
const pageBytes = Buffer.byteLength(html);
console.log(`
demo built from a real capture
  source        ${traces.map((t) => basename(t)).join(", ")} (${mb(rawBytes)} on disk)
  pairs         ${pairs.length} — ${[...cats].map(([c, n]) => `${n} ${c}`).join(", ")}
  session       ${session.threads.length} threads (${agents} subagent), ${main.turns.length} turns on the main thread
  compactions   ${main.compactions.length}
  span          ${new Date(first * 1000).toISOString()} → ${new Date(last * 1000).toISOString()}
  tokens        in ${inTok.toLocaleString()} · cache read ${cacheRead.toLocaleString()} · out ${outTok.toLocaleString()}
  est cost      $${cost.toFixed(2)}
  page          ${mb(pageBytes)} ${FULL ? "(every body in full)" : `(folded ${folded.superseded} superseded + ${folded.budgeted} budgeted bodies, ${mb(folded.foldedBytes)} out)`}
  chart steps   ${steps.length} (peak ${peak ? peak.composition.est.toLocaleString() : 0} est tokens at ${peak?.id})
  scrub         ${SCRUB.map((_, i) => scrubHits.get(i) || 0).join("/")} hits per rule
  identity      ${OPERATOR_IDS.length} operator id(s) known, ${identityHits} copies pseudonymized
  substituted   ${substituted} copy(ies) of ${OPERATOR_MEMORY} -> docs/demo/profile/claude-user.md${lineSwept ? `, ${lineSwept} stray line(s) removed` : ""}
  publish gate  ${leaks.length ? "FAILED (forced)" : "clean"}
`);
