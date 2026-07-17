import { describe, test, expect } from "bun:test";
import { join } from "path";
import { buildSession, mainThread, turnContentSig, responseBlocks } from "../src/session";
import { readTraceText } from "../src/history";
import { wireTables } from "../src/clients";

// Regression fixture cut from a real controlled session (sanitized —
// equality-preserving hash tokens, zero original text): one chat thread
// that walked through five models via /model, with Claude Code's ephemeral
// notice turns repacking history between requests (hist lengths on the
// wire: 2,4,5,10,9,11,18,... — non-monotonic and gapped), one /rewind
// (three same-length requests at hist=69), and one client-side-edited
// tool_use reply. Devlog: docs/devlog/2026-07-17-multi-model-session-attribution.org
const pairs = readTraceText(join(import.meta.dir, "fixtures", "multi-model-session.jsonl.zst"))
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

const REWOUND_OKAY = "1784270691702_4m";   // the /rewind'd "okay" exchange
const REWOUND_ORIG = "1784270145971_4e";   // the pre-rewind original reply
// Two replies whose tool_use command was edited client-side before it
// entered history. In the live trace the second (_1u) edit sits beyond
// turnContentSig's 160-char cap, so the capped-prefix compare (the devlog's
// accepted CPU tradeoff) still attributes it; sanitization hashes whole
// strings and cannot preserve prefix-equality classes, so the fixture is
// strictly harsher and classifies both as unattributed.
const EDITED_REPLIES = ["1784266008784_1k", "1784266062530_1u"];

describe("multi-model session attribution (devlog 2026-07-17)", () => {
  const { threads } = buildSession(pairs, wireTables());
  const main = mainThread(threads);
  const byId = new Map(pairs.map((p: any) => [p.id, p]));

  test("all five models are reported, primary by output tokens", () => {
    expect(Object.keys(main.models).sort()).toEqual([
      "claude-fable-5", "claude-haiku-4-5-20251001", "claude-opus-4-6",
      "claude-opus-4-8", "claude-sonnet-5",
    ]);
    expect(main.model).toBe("claude-fable-5");
    expect(main.label).toContain("+4 models");
    // per-model buckets carry their own request counts and output tokens
    expect(main.models["claude-haiku-4-5-20251001"].requests).toBe(2);
    expect(main.models["claude-opus-4-6"].output).toBe(33);
  });

  test("every assistant turn is attributed except the client-side-edited replies", () => {
    const holes = main.turns
      .map((t: any, i: number) => ({ t, i }))
      .filter(({ t }: any) => t.role === "assistant" && !t.pairId);
    // the only holes are the client-side-edited replies — no wire pair
    // matches those packed turns, and saying "unattributed" is the truthful
    // answer. Everything else, across five models and repacked histories,
    // is attributed.
    expect(holes.length).toBe(EDITED_REPLIES.length);
  });

  test("model switches and repacked notice turns attribute despite index drift", () => {
    // The devlog's three silent holes: opus-4.6's reply (index pointed at a
    // user turn) and both haiku replies (indices 9/11 landed on system/user
    // turns). Content-scan must recover all three.
    for (const model of ["claude-opus-4-6", "claude-haiku-4-5-20251001"]) {
      const attributed = main.turns.filter((t: any) =>
        t.role === "assistant" && t.usage && t.usage.model === model && t.pairId);
      expect(attributed.length).toBeGreaterThanOrEqual(1);
    }
  });

  test("no misattribution: every verified claim matches its pair's response content", () => {
    for (const t of main.turns) {
      if (t.role !== "assistant" || !t.pairId) continue;
      const rsig = turnContentSig(responseBlocks(byId.get(t.pairId)));
      if (!rsig) continue; // unverifiable pair — index attribution allowed
      expect(turnContentSig(t.blocks)).toBe(rsig);
    }
  });

  test("rewound exchanges are kept and classified, never silently lost", () => {
    const rewoundIds = main.rewound.map((r: any) => r.pairId);
    expect(rewoundIds).toContain(REWOUND_OKAY);
    expect(rewoundIds).toContain(REWOUND_ORIG);
    const okay = main.rewound.find((r: any) => r.pairId === REWOUND_OKAY);
    expect(okay.at).toBe(69); // diverged at the rewritten history index
    expect(main.usage.rewound).toBe(main.rewound.length);
    // rewound pairs still count in the thread's wire pairs — nothing dropped
    expect(main.pairIds).toContain(REWOUND_OKAY);
  });

  test("the edited-reply pairs classify unattributed, not rewound", () => {
    expect(main.unattributed.sort()).toEqual([...EDITED_REPLIES].sort());
    expect(main.usage.unattributed).toBe(EDITED_REPLIES.length);
  });

  test("usage totals aggregate across all models into one thread", () => {
    const perModel = Object.values(main.models) as any[];
    const sum = perModel.reduce((s, m) => s + m.output, 0);
    expect(sum).toBe(main.usage.output);
    expect(main.usage.requests).toBe(44);
  });
});
