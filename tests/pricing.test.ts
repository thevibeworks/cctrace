import { describe, test, expect } from "bun:test";
import { modelPricing, pairCost, fmtCost, costTitle } from "../src/pricing";

describe("modelPricing", () => {
  test("current models resolve to their per-MTok sticker price", () => {
    expect(modelPricing("claude-fable-5")).toMatchObject({ input: 10, output: 50 });
    expect(modelPricing("claude-opus-4-8")).toMatchObject({ input: 5, output: 25 });
    expect(modelPricing("claude-sonnet-5")).toMatchObject({ input: 3, output: 15 });
    expect(modelPricing("claude-haiku-4-5-20251001")).toMatchObject({ input: 1, output: 5 });
  });

  test("legacy opus 3/4.0/4.1 keep the old $15/$75; opus 4.5+ the new $5/$25", () => {
    expect(modelPricing("claude-opus-4-1-20250805")).toMatchObject({ input: 15, output: 75 });
    expect(modelPricing("claude-opus-4-20250514")).toMatchObject({ input: 15, output: 75 });
    expect(modelPricing("claude-3-opus-20240229")).toMatchObject({ input: 15, output: 75 });
    expect(modelPricing("claude-opus-4-5-20251101")).toMatchObject({ input: 5, output: 25 });
    expect(modelPricing("claude-opus-4-7")).toMatchObject({ input: 5, output: 25 });
  });

  test("reversed 3.x family order normalizes (3-5-haiku, 3-5-sonnet)", () => {
    expect(modelPricing("claude-3-5-haiku-20241022")).toMatchObject({ input: 0.8, output: 4 });
    expect(modelPricing("claude-3-haiku-20240307")).toMatchObject({ input: 0.25, output: 1.25 });
    expect(modelPricing("claude-3-5-sonnet-20241022")).toMatchObject({ input: 3, output: 15 });
  });

  test("wrapper forms: bedrock prefix, [1m] marker, vertex @-version", () => {
    expect(modelPricing("anthropic.claude-opus-4-8")).toMatchObject({ input: 5, output: 25 });
    expect(modelPricing("claude-sonnet-4-5[1m]")).toMatchObject({ input: 3, output: 15 });
    expect(modelPricing("claude-opus-4-5@20251101")).toMatchObject({ input: 5, output: 25 });
  });

  test("cache rates derive from input: read 0.1x, write 1.25x (5m) / 2x (1h)", () => {
    const p = modelPricing("claude-sonnet-4-6");
    expect(p.cacheRead).toBeCloseTo(0.3);
    expect(p.cacheWrite5m).toBeCloseTo(3.75);
    expect(p.cacheWrite1h).toBeCloseTo(6);
  });

  test("unknown model and empty input return null", () => {
    expect(modelPricing("gpt-4o")).toBeNull();
    expect(modelPricing("")).toBeNull();
    expect(modelPricing(null)).toBeNull();
  });

  test("unknown future version of a known family falls back to the family's current price", () => {
    expect(modelPricing("claude-opus-5")).toMatchObject({ input: 5, output: 25 });
    expect(modelPricing("claude-haiku-5")).toMatchObject({ input: 1, output: 5 });
  });
});

describe("pairCost", () => {
  const info = (over: Record<string, unknown> = {}) => ({
    model: "claude-sonnet-4-6",
    input: 1_000_000,
    output: 100_000,
    cacheRead: 500_000,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    ...over,
  });

  test("computes input + output + cache read at sticker rates", () => {
    const c = pairCost(info());
    expect(c.input).toBeCloseTo(3); // 1M * $3/MTok
    expect(c.output).toBeCloseTo(1.5); // 100k * $15/MTok
    expect(c.cacheRead).toBeCloseTo(0.15); // 500k * $0.30/MTok
    expect(c.total).toBeCloseTo(4.65);
  });

  test("cache write with 5m/1h breakdown bills each TTL at its rate", () => {
    const c = pairCost(info({ cacheWrite: 2_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 }));
    expect(c.cacheWrite).toBeCloseTo(3.75 + 6);
  });

  test("cache write without a breakdown is billed at the 5m rate", () => {
    const c = pairCost(info({ cacheWrite: 1_000_000 }));
    expect(c.cacheWrite).toBeCloseTo(3.75);
  });

  test("unknown model or missing info returns null", () => {
    expect(pairCost(info({ model: "gpt-4o" }))).toBeNull();
    expect(pairCost(null)).toBeNull();
  });
});

describe("fmtCost", () => {
  test("scales precision to magnitude", () => {
    expect(fmtCost(123.4)).toBe("$123");
    expect(fmtCost(4.656)).toBe("$4.66");
    expect(fmtCost(0.123)).toBe("$0.123");
    expect(fmtCost(0.00123)).toBe("$0.0012");
    expect(fmtCost(0.00005)).toBe("<$0.0001");
    expect(fmtCost(0)).toBe("$0");
    expect(fmtCost(NaN)).toBe("$0");
  });
});

describe("costTitle", () => {
  test("lists only non-zero components", () => {
    const t = costTitle({ input: 0.5, output: 0.2, cacheRead: 0, cacheWrite: 0 });
    expect(t).toBe("estimated: input $0.50 + output $0.20");
  });
});
