import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  filterCatalog,
  readPricingCache,
  writePricingCache,
  refreshPricingCache,
  pricingCatalog,
  PRICING_TTL_MS,
} from "../src/pricing-catalog";
import { modelPricing, pairCost } from "../src/pricing";

// models.dev api.json shape (verified 2026-07-14): provider -> models ->
// cost in USD/MTok. anthropic entries carry cache_read + cache_write (the 5m
// rate); openai/xai carry cache_read only — no cache_write means the
// provider doesn't bill writes.
const API = {
  anthropic: {
    models: {
      "claude-opus-4-5": { cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } },
      "claude-embedding": { name: "no cost field" },
    },
  },
  openai: {
    models: {
      "gpt-5.6": { cost: { input: 2, output: 8, cache_read: 0.5 } },
    },
  },
  xai: {
    models: {
      "grok-4.5": { cost: { input: 1.25, output: 2.5, cache_read: 0.2 } },
    },
  },
  "some-reseller": {
    models: { "gpt-5.6": { cost: { input: 99, output: 99 } } },
  },
};

const CATALOG = filterCatalog(API);

describe("filterCatalog", () => {
  test("keeps only priced models from the trusted providers", () => {
    expect(Object.keys(CATALOG).sort()).toEqual(["claude-opus-4-5", "gpt-5.6", "grok-4.5"]);
    expect(CATALOG["gpt-5.6"]).toEqual({ input: 2, output: 8, cacheRead: 0.5 });
    expect(CATALOG["claude-opus-4-5"]).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
  });

  test("reseller providers never override the trusted price", () => {
    expect(CATALOG["gpt-5.6"].input).toBe(2);
  });

  test("garbage input yields an empty catalog, never a throw", () => {
    expect(filterCatalog(null)).toEqual({});
    expect(filterCatalog({ openai: { models: "nope" } })).toEqual({});
  });
});

describe("pricing cache", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "cctrace-pricing-"));

  test("write/read round-trip; corrupt file reads as null", async () => {
    const d = dir();
    expect(readPricingCache(d)).toBe(null);
    writePricingCache(d, { checkedAt: "2026-07-14T00:00:00.000Z", catalog: CATALOG });
    expect(readPricingCache(d)!.catalog["grok-4.5"].input).toBe(1.25);
    await Bun.write(join(d, "pricing.json"), "{broken");
    expect(readPricingCache(d)).toBe(null);
  });

  test("a fresh cache short-circuits — no fetch", async () => {
    const d = dir();
    writePricingCache(d, { checkedAt: new Date().toISOString(), catalog: CATALOG });
    let called = 0;
    const out = await refreshPricingCache(d, new Date(), (() => {
      called++;
      throw new Error("no");
    }) as any);
    expect(called).toBe(0);
    expect(out!.catalog["gpt-5.6"].output).toBe(8);
  });

  test("a stale cache refreshes and persists", async () => {
    const d = dir();
    writePricingCache(d, { checkedAt: new Date(Date.now() - PRICING_TTL_MS - 1000).toISOString(), catalog: {} });
    const out = await refreshPricingCache(d, new Date(), (async () => new Response(JSON.stringify(API))) as any);
    expect(out!.catalog["grok-4.5"].output).toBe(2.5);
    expect(readPricingCache(d)!.catalog["gpt-5.6"].input).toBe(2);
  });

  test("network failure and schema drift keep the previous cache", async () => {
    const d = dir();
    const prev = { checkedAt: new Date(Date.now() - PRICING_TTL_MS - 1000).toISOString(), catalog: CATALOG };
    writePricingCache(d, prev);
    const failed = await refreshPricingCache(d, new Date(), (async () => {
      throw new Error("offline");
    }) as any);
    expect(failed!.catalog["gpt-5.6"].input).toBe(2);
    const drifted = await refreshPricingCache(d, new Date(), (async () => new Response(JSON.stringify({ unknown: {} }))) as any);
    expect(drifted!.catalog["gpt-5.6"].input).toBe(2);
  });

  test("pricingCatalog exposes the catalog or undefined", () => {
    const d = dir();
    expect(pricingCatalog(d)).toBeUndefined();
    writePricingCache(d, { checkedAt: "2026-01-01T00:00:00.000Z", catalog: CATALOG });
    expect(pricingCatalog(d)!["grok-4.5"].cacheRead).toBe(0.2);
  });
});

describe("modelPricing with the models.dev catalog", () => {
  afterEach(() => {
    delete (globalThis as any).__PRICING__;
  });

  test("exact id, date-suffix strip, and trailing-segment fallback", () => {
    expect(modelPricing("grok-4.5", CATALOG)!.input).toBe(1.25);
    expect(modelPricing("claude-opus-4-5-20251101", CATALOG)!.input).toBe(5);
    // the real codex wire model: gpt-5.6-sol -> gpt-5.6
    expect(modelPricing("gpt-5.6-sol", CATALOG)!.input).toBe(2);
  });

  test("missing cache rates mean the provider doesn't bill them", () => {
    const p = modelPricing("gpt-5.6", CATALOG)!;
    expect(p.cacheRead).toBe(0.5);
    expect(p.cacheWrite5m).toBe(0);
    expect(p.cacheWrite1h).toBe(0);
    // anthropic entry: explicit write rate, 1h = input x2 (ccusage convention)
    const a = modelPricing("claude-opus-4-5", CATALOG)!;
    expect(a.cacheWrite5m).toBe(6.25);
    expect(a.cacheWrite1h).toBe(10);
  });

  test("catalog miss falls back to the embedded Claude table", () => {
    expect(modelPricing("claude-sonnet-4-5", CATALOG)!.input).toBe(3);
    expect(modelPricing("some-unknown-model", CATALOG)).toBe(null);
  });

  test("the ambient globalThis.__PRICING__ catalog is honored (page path)", () => {
    expect(modelPricing("grok-4.5")).toBe(null);
    (globalThis as any).__PRICING__ = CATALOG;
    expect(modelPricing("grok-4.5")!.output).toBe(2.5);
  });

  test("pairCost prices an OpenAI-usage pair end to end", () => {
    const usage = { model: "grok-4.5", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 };
    expect(pairCost(usage)).toBe(null); // no catalog -> unknown model
    (globalThis as any).__PRICING__ = CATALOG;
    expect(pairCost(usage)!.total).toBeCloseTo(1.25 + 2.5 + 0.2, 5);
  });
});
