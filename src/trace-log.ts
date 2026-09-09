import { appendFileSync, statSync, truncateSync } from "fs";
import type { TracePair } from "./types";

/** Small in-memory offsets into the live JSONL; request bodies belong to disk. */
export function createTraceLog(path: string) {
  const offsets = new Map<string, { start: number; bytes: number }>();
  return {
    append(pair: TracePair) {
      const data = Buffer.from(JSON.stringify(pair) + "\n");
      const start = statSync(path).size;
      try { appendFileSync(path, data); }
      catch (error) {
        // A short disk write must not join the next successful record to a
        // torn line. This sink is the sole appender of its run's file.
        try { truncateSync(path, start); } catch { /* disk may still be unavailable */ }
        throw error;
      }
      offsets.set(pair.id, { start, bytes: data.length });
    },
    async read(id: string): Promise<TracePair | null> {
      const at = offsets.get(id);
      if (!at) return null;
      try {
        const pair = await Bun.file(path).slice(at.start, at.start + at.bytes).json() as TracePair;
        // A purge may have rewritten the file. The caller can fall back to a
        // streaming search; a stale offset must never return a different pair.
        return pair?.id === id && pair.request ? pair : null;
      } catch { return null; }
    },
  };
}
