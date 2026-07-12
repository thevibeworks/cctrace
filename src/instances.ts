import { readdirSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

// Live-instance registry: every live-mode run writes one JSON file under
// <dataDir>/instances/<pid>.json so concurrent cctrace sessions can find
// each other — `cctrace ps` on the CLI, /api/instances + the header switcher
// in the web UI. Files are removed on clean exit; a crash leaves a stale
// file behind, so every read filters (and garbage-collects) entries whose
// pid is no longer alive. Same-machine only by design: the pid check is the
// liveness test, and the URLs are localhost.

export interface InstanceInfo {
  pid: number;
  port: number;
  project: string;
  projectPath: string;
  logFile: string;
  mode: string;
  startedAt: string; // ISO
  sessionId?: string;
}

export interface InstanceHandle {
  /** Merge fields into the registry entry (e.g. sessionId once known). */
  update(patch: Partial<InstanceInfo>): void;
  unregister(): void;
}

export function instancesDir(dataDir: string): string {
  return join(dataDir, "instances");
}

/** Is the process alive? EPERM means alive-but-not-ours, which still counts. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function registerInstance(dataDir: string, info: InstanceInfo): InstanceHandle {
  const dir = instancesDir(dataDir);
  const file = join(dir, `${info.pid}.json`);
  let current: InstanceInfo = { ...info };
  const write = () => {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(current, null, 2) + "\n");
    } catch {
      // registry is best-effort — never take a capture down over it
    }
  };
  write();
  return {
    update(patch) {
      current = { ...current, ...patch };
      write();
    },
    unregister() {
      try {
        unlinkSync(file);
      } catch {
        // already gone
      }
    },
  };
}

/**
 * All live instances, oldest first. Stale entries (dead pid, unparseable
 * file) are deleted as they're found, so the registry is self-healing.
 */
export function listInstances(dataDir: string): InstanceInfo[] {
  const dir = instancesDir(dataDir);
  if (!existsSync(dir)) return [];
  const out: InstanceInfo[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    let info: InstanceInfo | null = null;
    try {
      info = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      info = null;
    }
    if (!info || typeof info.pid !== "number" || typeof info.port !== "number" || !pidAlive(info.pid)) {
      try {
        unlinkSync(file);
      } catch {
        // raced with its owner — fine
      }
      continue;
    }
    out.push(info);
  }
  out.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  return out;
}
