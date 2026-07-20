import { describe, test, expect } from "bun:test";
import { join } from "path";
import { buildSession, mainThread } from "../src/session";
import { readTraceText } from "../src/history";

// Regression fixture cut from a real triple-packing session (sanitized by
// tests/sanitize-trace.ts — equality-preserving hash tokens, zero original
// text): one conversation that survived a fold-style compaction and two
// continuation packings, plus parallel same-prompt subagents and the
// false-agent-claim hazard (the continuation summary quoting old Task
// dispatch prompts). Every threshold calibrated on 2026-07-20 — the 10+
// turn drop, the 2-neighbor anchor, the system identity block — is pinned
// here against real wire mess, not synthetic shapes. If Claude Code
// changes its repacking behavior, this file is the tripwire.
// Devlog: docs/devlog/2026-07-20-thread-identity-under-compaction.org
const pairs = readTraceText(join(import.meta.dir, "fixtures", "compaction-session.jsonl.zst"))
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

// The pair from the original bug report ("it's not a /rewind request"):
// an injected recap exchange, answered then dropped from history.
const RECAP_PAIR = "1784519084902_16";
// The post-/compact requests that used to vanish into a false subagent
// thread ("Codex rescue fresh connectivity test").
const POST_COMPACT = ["1784536387048_6t", "1784536549549_70"];

describe("compaction session (real wire shapes, 2026-07-20)", () => {
  const { threads } = buildSession(pairs);
  const main = mainThread(threads);

  test("the conversation is ONE thread across three packings", () => {
    expect(main.turns.length).toBe(57);
    expect(main.usage.requests).toBe(29);
    // both post-compact requests belong to the main conversation…
    for (const id of POST_COMPACT) expect(main.pairIds).toContain(id);
    // …and to no other thread (the false-agent-claim regression)
    for (const t of threads) {
      if (t === main) continue;
      for (const id of POST_COMPACT) expect(t.pairIds).not.toContain(id);
    }
  });

  test("the compact boundary is exported for display", () => {
    expect(main.compactions).toEqual([
      { at: 46, pairId: "1784536387048_6t", fromTurns: 45, toTurns: 4, mode: "fold" },
    ]);
  });

  test("post-compact turns attribute; ephemeral recaps classify superseded at their ordinal", () => {
    for (const id of POST_COMPACT) {
      expect(main.turns.find((x: any) => x.pairId === id)).toBeTruthy();
    }
    const sup = main.rewound.map((r: any) => r.pairId);
    expect(sup).toContain(RECAP_PAIR);
    expect(main.rewound.find((r: any) => r.pairId === RECAP_PAIR).at).toBe(5);
    // the recap exchanges and one repack victim — nothing else flags
    expect(main.rewound.length).toBe(4);
    expect(main.unattributed.length).toBe(1);
  });

  test("sessions and subagents survive sanitization", () => {
    const sids = new Set(threads.map((t: any) => t.sessionId));
    expect(sids.size).toBe(2); // a /clear rotated the sid mid-trace
    // the three parallel same-prompt Task spawns each link to their own
    // dispatch (unique claiming — all three used to collapse onto one)
    const linked = threads.filter((t: any) => t.agentOf);
    expect(linked.length).toBe(3);
    expect(new Set(linked.map((t: any) => t.agentOf.toolUseId)).size).toBe(3);
  });
});
