import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveView, ViewError } from "../src/view";

const SID_A = "4f9a2c1e-1111-2222-3333-444444444444";
const SID_B = "9e8d7c6b-aaaa-bbbb-cccc-dddddddddddd";

function pair(id: string, sessionId: string, ts: number) {
  return {
    id,
    request: {
      timestamp: ts,
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: {},
      body: { model: "claude-opus-4-6", messages: [{ role: "user", content: "hi" }],
        metadata: { user_id: JSON.stringify({ session_id: sessionId }) } },
    },
    response: { timestamp: ts + 1, status: 200, headers: {}, body: {} },
    duration: 1, loggedAt: "x",
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cctrace-view-"));
  writeFileSync(join(dir, "trace-A.jsonl"), [pair("a1", SID_A, 100), pair("a2", SID_A, 200)].map((p) => JSON.stringify(p)).join("\n"));
  writeFileSync(join(dir, "trace-B.jsonl"), [pair("b1", SID_B, 300)].map((p) => JSON.stringify(p)).join("\n"));
  // A second file that continued session A (cross-run continuity).
  writeFileSync(join(dir, "trace-A2.jsonl"), [pair("a3", SID_A, 400)].map((p) => JSON.stringify(p)).join("\n"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("resolveView", () => {
  test("explicit .jsonl path renders that file, html sibling", () => {
    const r = resolveView(join(dir, "trace-B.jsonl"), dir);
    expect(r.matchedBy).toBe("file");
    expect(r.pairs).toHaveLength(1);
    expect(r.htmlPath).toBe(join(dir, "trace-B.html"));
  });

  test("session id merges every trace holding it, deduped and sorted", () => {
    const r = resolveView(SID_A, dir);
    expect(r.matchedBy).toBe("session");
    expect(r.pairs.map((p) => p.id)).toEqual(["a1", "a2", "a3"]);
    expect(r.sources.sort()).toEqual(["trace-A.jsonl", "trace-A2.jsonl"]);
    expect(r.htmlPath).toContain("session-4f9a2c1e");
  });

  test("session id prefix works", () => {
    const r = resolveView("4f9a2c1e", dir);
    expect(r.pairs).toHaveLength(3);
  });

  // Regression: the id is a substring of a merge output's filename, and
  // filename matching used to win — returning only the merged file and
  // silently dropping every newer unmerged trace of the session.
  test("session id still merges all traces when a merged session file exists", () => {
    writeFileSync(join(dir, "session-4f9a2c1e.jsonl"), JSON.stringify(pair("a1", SID_A, 100)));
    const r = resolveView("4f9a2c1e", dir);
    expect(r.matchedBy).toBe("session");
    expect(r.pairs.map((p) => p.id)).toEqual(["a1", "a2", "a3"]);
  });

  test("filename fragment with a single match renders it", () => {
    const r = resolveView("trace-B", dir);
    expect(r.matchedBy).toBe("filename");
    expect(r.pairs).toHaveLength(1);
  });

  test("no match throws ViewError listing recent traces", () => {
    expect(() => resolveView("nope-nothere", dir)).toThrow(ViewError);
  });
});
