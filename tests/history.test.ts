import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { scanTraceText, parseTraceText, loadPriorPairs, loadTraceFiles } from "../src/history";

const SID_A = "70683b4f-e779-414c-bcdb-9b22361a0232";
const SID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function messagesPair(id: string, sessionId: string, ts: number) {
  return {
    id,
    request: {
      timestamp: ts,
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: {},
      body: {
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "hi" }],
        metadata: { user_id: JSON.stringify({ device_id: "d", account_uuid: "a", session_id: sessionId }) },
      },
    },
    response: { timestamp: ts + 1, status: 200, headers: {}, body: {} },
    duration: 1000,
    loggedAt: "x",
  };
}

function oauthPair(id: string, ts: number) {
  return {
    id,
    request: { timestamp: ts, method: "GET", url: "https://api.anthropic.com/api/oauth/usage", headers: {}, body: null },
    response: { timestamp: ts, status: 200, headers: {}, body: {} },
    duration: 50,
    loggedAt: "x",
  };
}

const toJsonl = (pairs: unknown[]) => pairs.map((p) => JSON.stringify(p)).join("\n") + "\n";

describe("scanTraceText", () => {
  test("keeps only pairs of wanted sessions", () => {
    const text = toJsonl([messagesPair("1_a", SID_A, 10), messagesPair("2_b", SID_B, 20), oauthPair("3_c", 30)]);
    const got = scanTraceText(text, new Set([SID_A]));
    expect(got.map((p) => p.id)).toEqual(["1_a"]);
  });

  test("skips torn tail lines and blanks", () => {
    const text = toJsonl([messagesPair("1_a", SID_A, 10)]) + '\n{"id":"torn';
    expect(scanTraceText(text, new Set([SID_A])).length).toBe(1);
  });

  test("empty wanted set matches nothing", () => {
    const text = toJsonl([messagesPair("1_a", SID_A, 10)]);
    expect(scanTraceText(text, new Set())).toEqual([]);
  });
});

describe("parseTraceText", () => {
  test("keeps all pairs regardless of session", () => {
    const text = toJsonl([messagesPair("1_a", SID_A, 10), oauthPair("2_b", 20)]);
    expect(parseTraceText(text).length).toBe(2);
  });
});

describe("loadPriorPairs / loadTraceFiles", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cctrace-history-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("finds matching session pairs across files, excluding the current log, sorted by time", () => {
    writeFileSync(join(dir, "trace-old1.jsonl"), toJsonl([messagesPair("2_b", SID_A, 200)]));
    writeFileSync(join(dir, "trace-old2.jsonl"), toJsonl([messagesPair("1_a", SID_A, 100), messagesPair("9_z", SID_B, 150)]));
    writeFileSync(join(dir, "trace-current.jsonl"), toJsonl([messagesPair("3_c", SID_A, 300)]));
    writeFileSync(join(dir, "notes.txt"), "not a trace");

    const got = loadPriorPairs(dir, join(dir, "trace-current.jsonl"), new Set([SID_A]));
    expect(got.map((p) => p.id)).toEqual(["1_a", "2_b"]);
    expect(got[0]?.prior).toBe("trace-old2.jsonl");
    expect(got[1]?.prior).toBe("trace-old1.jsonl");
  });

  test("no sessions or missing dir returns empty", () => {
    expect(loadPriorPairs(dir, "", new Set())).toEqual([]);
    expect(loadPriorPairs(join(dir, "nope"), "", new Set([SID_A]))).toEqual([]);
  });

  test("loadTraceFiles loads everything from named files, marked prior", () => {
    const f = join(dir, "manual.jsonl");
    writeFileSync(f, toJsonl([oauthPair("5_e", 50), messagesPair("4_d", SID_B, 40)]));
    const got = loadTraceFiles([f, join(dir, "missing.jsonl")]);
    expect(got.map((p) => p.id)).toEqual(["4_d", "5_e"]);
    expect(got.every((p) => p.prior === "manual.jsonl")).toBe(true);
  });
});
