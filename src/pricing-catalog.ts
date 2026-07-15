import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

// Live model pricing from the models.dev API — the standing source for ALL
// model cost estimation (user decision 2026-07-14; ccusage uses the same
// data). Same boring pattern as the update checker (version.ts): startup
// reads a small cache file synchronously, a background task refreshes it at
// most once per TTL, network failure keeps the previous cache. The filtered
// catalog is injected into the page as META.pricing; modelPricing consults
// it first and falls back to the embedded Claude table (pricing.ts), so
// everything still renders offline — just without costs for foreign models.

const MODELS_DEV_URL = "https://models.dev/api.json";
/** Providers whose models cctrace can actually meet on the wire. */
export const PRICING_PROVIDERS = ["anthropic", "openai", "xai"];

export const PRICING_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000; // the full api.json is ~3MB

/** USD per MTok. cacheWrite is the provider's 5m-equivalent write rate. */
export interface CatalogEntry {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface PricingCache {
  checkedAt: string;
  catalog: Record<string, CatalogEntry>;
}

function cacheFile(dataDir: string): string {
  return join(dataDir, "pricing.json");
}

export function readPricingCache(dataDir: string): PricingCache | null {
  try {
    const c = JSON.parse(readFileSync(cacheFile(dataDir), "utf8"));
    return c && typeof c.checkedAt === "string" && c.catalog && typeof c.catalog === "object" ? c : null;
  } catch {
    return null;
  }
}

export function writePricingCache(dataDir: string, cache: PricingCache): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(cacheFile(dataDir), JSON.stringify(cache) + "\n");
  } catch {
    // a failed cache write only costs an extra fetch next run
  }
}

/**
 * models.dev api.json -> flat { modelId: CatalogEntry } for the providers we
 * care about. Ids don't collide across anthropic/openai/xai; when a later
 * provider repeats an id the first one wins (provider order is trust order).
 */
export function filterCatalog(api: any): Record<string, CatalogEntry> {
  const out: Record<string, CatalogEntry> = {};
  for (const provider of PRICING_PROVIDERS) {
    const models = api && api[provider] && api[provider].models;
    if (!models || typeof models !== "object") continue;
    for (const [id, m] of Object.entries<any>(models)) {
      const c = m && m.cost;
      if (!c || typeof c.input !== "number" || typeof c.output !== "number") continue;
      if (out[id]) continue;
      const entry: CatalogEntry = { input: c.input, output: c.output };
      if (typeof c.cache_read === "number") entry.cacheRead = c.cache_read;
      if (typeof c.cache_write === "number") entry.cacheWrite = c.cache_write;
      out[id] = entry;
    }
  }
  return out;
}

/**
 * Refresh the pricing cache from models.dev if stale. Never throws; network
 * failure keeps the previous cache. `fetcher` is injectable for tests.
 */
export async function refreshPricingCache(
  dataDir: string,
  now: Date = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<PricingCache | null> {
  const existing = readPricingCache(dataDir);
  if (existing && now.getTime() - Date.parse(existing.checkedAt) < PRICING_TTL_MS) {
    return existing;
  }
  try {
    const resp = await fetcher(MODELS_DEV_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!resp.ok) return existing;
    const catalog = filterCatalog(await resp.json());
    if (!Object.keys(catalog).length) return existing; // schema drift — keep what we have
    const next: PricingCache = { checkedAt: now.toISOString(), catalog };
    writePricingCache(dataDir, next);
    return next;
  } catch {
    return existing;
  }
}

/** The catalog to inject as META.pricing, or undefined when never fetched. */
export function pricingCatalog(dataDir: string): Record<string, CatalogEntry> | undefined {
  const c = readPricingCache(dataDir);
  return c ? c.catalog : undefined;
}
