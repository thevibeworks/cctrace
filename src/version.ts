import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import pkg from "../package.json";

// Version identity + the update checker. The checker is deliberately boring:
// it reads a small cache file synchronously at startup (so the CLI never
// waits on the network to boot) and refreshes that cache in the background
// at most once per UPDATE_CHECK_TTL_MS. A fresh release therefore surfaces
// on the *next* run — an acceptable lag for zero startup cost.

export const CCTRACE_VERSION: string = pkg.version;
export const NPM_PACKAGE = "@thevibeworks/cctrace";

// Build-time commit hash, injected by `make build` via bun's --define.
// Source runs fall back to asking git — but only when the tree actually IS
// the cctrace repo (an npm install's node_modules usually sits inside the
// USER's git repo, whose HEAD would be a lie).
declare const CCTRACE_GIT_SHA: string;
let commitCache: string | null = null;

export function cctraceCommit(): string {
  if (commitCache !== null) return commitCache;
  try {
    if (typeof CCTRACE_GIT_SHA === "string" && CCTRACE_GIT_SHA) return (commitCache = CCTRACE_GIT_SHA);
  } catch {
    // not defined — source run
  }
  try {
    const repoRoot = join(import.meta.dir, "..");
    if (existsSync(join(repoRoot, ".git"))) {
      const r = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "ignore",
      });
      const sha = r.exitCode === 0 ? r.stdout.toString().trim() : "";
      if (/^[0-9a-f]{4,}$/i.test(sha)) return (commitCache = sha);
    }
  } catch {
    // no git / compiled binary with a virtual path — version alone is fine
  }
  return (commitCache = "");
}

/** "0.17.0 (f68ed90)" when the commit is known, plain version otherwise. */
export function versionWithCommit(): string {
  const sha = cctraceCommit();
  return sha ? `${CCTRACE_VERSION} (${sha})` : CCTRACE_VERSION;
}
const REGISTRY_URL = `https://registry.npmjs.org/${NPM_PACKAGE}/latest`;

export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

export interface UpdateCache {
  /** Newest version seen on the registry. */
  latest: string;
  /** ISO timestamp of the last successful registry query. */
  checkedAt: string;
  /** Version the user declined to upgrade to — don't re-prompt for it. */
  snoozed?: string;
}

function cacheFile(dataDir: string): string {
  return join(dataDir, "update-check.json");
}

export function readUpdateCache(dataDir: string): UpdateCache | null {
  try {
    const c = JSON.parse(readFileSync(cacheFile(dataDir), "utf8"));
    return c && typeof c.latest === "string" && typeof c.checkedAt === "string" ? c : null;
  } catch {
    return null;
  }
}

export function writeUpdateCache(dataDir: string, cache: UpdateCache): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(cacheFile(dataDir), JSON.stringify(cache, null, 2) + "\n");
  } catch {
    // a failed cache write only costs an extra registry query next run
  }
}

/** Loose semver: numeric dot-parts compared left to right, prerelease tags ignored. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => String(v).replace(/^v/, "").split("-")[0].split(".").map((x) => parseInt(x, 10) || 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/**
 * Refresh the cache from the npm registry if it is stale. Never throws;
 * network failure keeps the previous cache. `fetcher` is injectable for
 * tests. Returns the cache in effect afterwards.
 */
export async function refreshUpdateCache(
  dataDir: string,
  now: Date = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<UpdateCache | null> {
  const existing = readUpdateCache(dataDir);
  if (existing && now.getTime() - Date.parse(existing.checkedAt) < UPDATE_CHECK_TTL_MS) {
    return existing;
  }
  try {
    const resp = await fetcher(REGISTRY_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!resp.ok) return existing;
    const body = (await resp.json()) as { version?: string };
    if (!body || typeof body.version !== "string") return existing;
    const next: UpdateCache = { latest: body.version, checkedAt: now.toISOString() };
    if (existing?.snoozed) next.snoozed = existing.snoozed;
    writeUpdateCache(dataDir, next);
    return next;
  } catch {
    return existing;
  }
}

/** The version to offer, or null (up to date / never checked). */
export function availableUpdate(cache: UpdateCache | null, current: string = CCTRACE_VERSION): string | null {
  return cache && isNewer(cache.latest, current) ? cache.latest : null;
}
