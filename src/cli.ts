#!/usr/bin/env bun

import { dirname, join, resolve } from "path";
import { mkdirSync, existsSync, unlinkSync, appendFileSync, writeFileSync } from "fs";
import { spawn, type ChildProcess } from "child_process";
import { createServer, renderSnapshot } from "./server";
import { createCapturer, type CaptureMode, type Capturer } from "./capture";
import { isNativeBinary, resolveClaudeBashWrapper } from "./detect";
import { ensureCerts } from "./certs";
import { parseCliArgs, CliUsageError } from "./args";
import type { TracePair } from "./types";

// Live-UI port. Avoids 7890/7891 (Clash/mihomo proxy defaults). Falls back to
// an OS-assigned free port if this is taken (see createServer).
const DEFAULT_PORT = 9317;

// True when running as a `bun build --compile` standalone binary (sources live
// in the virtual /$bunfs). Matters twice: the on-disk cache can't sit next to
// the (virtual) sources, and bun's CLI quirk below doesn't apply.
const IS_COMPILED = import.meta.path.includes("$bunfs") || import.meta.path.includes("~BUN");

// cctrace [OPTIONS] [-- CLAUDE_ARGS...] — everything after "--" goes to the
// Claude CLI verbatim; unknown flags before it error with a hint (args.ts).
function parseArgvOrExit() {
  try {
    return parseCliArgs(Bun.argv.slice(2));
  } catch (err) {
    if (err instanceof CliUsageError) {
      let msg = err.message;
      // When run through bun's CLI (bunx / bun run / the bun-link shim), bun
      // itself eats a LEADING "--", so `cctrace -- --continue` reaches us as
      // `--continue` and lands here. The compiled binary is immune.
      if (!IS_COMPILED && msg.includes('put it after "--"')) {
        msg += `\n  note: bun run/bunx/bun link eats a leading "--". If you already typed one,` +
          `\n  install the compiled binary (make install) or put a cctrace flag before "--".`;
      }
      console.error(`[cctrace] ${msg}`);
      process.exit(1);
    }
    throw err;
  }
}
const { values, claudeArgs } = parseArgvOrExit();

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

function log(msg: string, color = C.reset) {
  console.log(`${color}[cctrace]${C.reset} ${msg}`);
}

const CAPTURE_MODES = ["auto", "mitm", "base-url", "node"] as const;

// Best-effort browser open, per platform. The URL is always printed too, so a
// missing opener (headless box, no xdg-open) degrades to "open it yourself".
function openBrowser(url: string) {
  const cmd =
    process.platform === "darwin" ? ["open", url] :
    process.platform === "win32" ? ["cmd", "/c", "start", "", url] :
    ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // ignored — the Live UI URL is already on screen
  }
}

// Repo-local .cache when running from source; XDG cache for the compiled
// binary (its import.meta.path is virtual and not writable).
const CACHE_DIR = IS_COMPILED
  ? join(process.env.XDG_CACHE_HOME || join(process.env.HOME || ".", ".cache"), "cctrace")
  : join(dirname(import.meta.path), "..", ".cache");
const MITM_CA_DIR = join(CACHE_DIR, "mitm");

function showHelp() {
  console.log(`
${C.cyan}cctrace${C.reset} - Trace HTTP traffic from Claude Code CLI

${C.yellow}USAGE:${C.reset}
  cctrace [OPTIONS] [-- CLAUDE_ARGS...]

  Everything after ${C.cyan}--${C.reset} is passed to the Claude CLI verbatim.

${C.yellow}OPTIONS:${C.reset}
  --mode MODE        Capture mode: auto (default), mitm, base-url, node
  -s, --static       Static mode (no live server, just files)
  -p, --port PORT    Live UI port (default: ${DEFAULT_PORT})
  --messages-only    Only capture /v1/messages (default: capture everything)
  --no-open          Don't auto-open browser
  --print-ca         Print the MITM CA cert path and exit
  --log NAME         Custom log file base name
  --dir PATH         Log directory (default: .cctrace)
  --claude-path PATH Custom Claude binary path
  -h, --help         Show this help

${C.yellow}CAPTURE MODES:${C.reset}
  ${C.cyan}mitm${C.reset}      TLS-intercepting proxy. Captures ALL Anthropic traffic
            (messages, OAuth, usage/credits, MCP). Auto-generates a CA that
            Claude trusts via NODE_EXTRA_CA_CERTS. ${C.dim}Default for native binaries.${C.reset}
  ${C.cyan}base-url${C.reset}  Reverse proxy via ANTHROPIC_BASE_URL. Zero setup, but only
            sees /v1/messages (OAuth/usage bypass it).
  ${C.cyan}node${C.reset}      Legacy fetch() injection via node --require. Only works for
            npm-installed (non-native) Claude. ${C.dim}Auto-selected for JS installs.${C.reset}

${C.yellow}EXAMPLES:${C.reset}
  cctrace                          ${C.dim}# Auto mode, capture everything${C.reset}
  cctrace --mode base-url          ${C.dim}# Lightweight, messages only, no CA${C.reset}
  cctrace -s                       ${C.dim}# Static mode (files only)${C.reset}
  cctrace -- --continue            ${C.dim}# Resume last Claude session, traced${C.reset}
  cctrace -- -p "explain this"     ${C.dim}# Claude print mode, traced${C.reset}
  cctrace --mode base-url -- --model opus --continue

  ${C.dim}Note: -p before "--" is cctrace's port; -p after "--" is Claude's print mode.${C.reset}
`);
}

function findClaude(): string {
  const custom = values["claude-path"];
  if (custom) {
    return resolve(custom);
  }

  const home = process.env.HOME || "";
  const paths = [
    join(home, ".claude", "bin", "claude"),
    join(home, ".claude", "local", "claude"),
    join(home, ".local", "bin", "claude"),
    join(home, ".npm-global", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];

  for (const p of paths) {
    if (existsSync(p)) return p;
  }

  const which = Bun.spawnSync(["which", "claude"]);
  if (which.exitCode === 0) {
    return which.stdout.toString().trim();
  }

  throw new Error("Claude not found. Install Claude Code or use --claude-path");
}

async function buildPreload(): Promise<string> {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

  const srcDir = dirname(import.meta.path);
  const preloadSrc = join(srcDir, "preload.ts");
  const preloadOut = join(CACHE_DIR, "preload.cjs");

  if (existsSync(preloadOut)) unlinkSync(preloadOut);

  const result = await Bun.build({
    entrypoints: [preloadSrc],
    outdir: CACHE_DIR,
    target: "node",
    format: "cjs",
    naming: "[name].cjs",
    minify: false,
  });

  if (!result.success) {
    throw new Error("Build failed: " + result.logs.join("\n"));
  }

  return preloadOut;
}

interface RunOpts {
  port: number;
  liveMode: boolean;
  logDir: string;
  logName?: string;
  logAll: boolean;
  noOpen: boolean;
}

interface LogSink {
  onPair: (pair: TracePair) => void;
  /** Write the categorized HTML report from everything collected. */
  writeHtml: () => string;
}

function makeLogSink(opts: RunOpts, livePort?: number): LogSink {
  if (!existsSync(opts.logDir)) mkdirSync(opts.logDir, { recursive: true });
  const base = opts.logName || `trace-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5)}`;
  const logFile = join(opts.logDir, `${base}.jsonl`);
  const htmlFile = join(opts.logDir, `${base}.html`);
  writeFileSync(logFile, "");
  log(`Log: ${logFile}`, C.blue);

  const collected: TracePair[] = [];

  return {
    onPair: (pair: TracePair) => {
      collected.push(pair);
      appendFileSync(logFile, JSON.stringify(pair) + "\n");
      if (livePort) {
        fetch(`http://localhost:${livePort}/api/pair`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(pair),
        }).catch(() => {});
      }
    },
    writeHtml: () => {
      writeFileSync(htmlFile, renderSnapshot(collected));
      return htmlFile;
    },
  };
}

function spawnClaudeWithCapturer(claudePath: string, claudeArgs: string[], capturer: Capturer, opts: RunOpts, onFinalize?: () => string) {
  log(`Capture: ${capturer.label}`, C.cyan);
  console.log("");

  const child: ChildProcess = spawn(claudePath, claudeArgs, {
    env: { ...(process.env as Record<string, string>), ...capturer.env },
    stdio: "inherit",
    cwd: process.cwd(),
  });

  child.on("error", (err) => {
    capturer.stop();
    log(`Error: ${err.message}`, C.yellow);
    process.exit(1);
  });

  child.on("exit", async (code, signal) => {
    await capturer.flush();
    log(`Traced ${capturer.pairCount()} request/response pairs`, C.green);
    capturer.stop();
    if (onFinalize) {
      const htmlFile = onFinalize();
      log(`HTML: ${htmlFile}`, C.green);
    }
    if (signal) log(`Terminated: ${signal}`, C.yellow);
    else if (code === 0) log("Session complete", C.green);
    process.exit(code ?? 0);
  });

  let shuttingDown = false;
  const handleSignal = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    child.kill(sig as NodeJS.Signals);
  };
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
}

async function runProxyCapture(mode: CaptureMode, claudePath: string, claudeArgs: string[], opts: RunOpts) {
  let livePort: number | undefined;
  if (opts.liveMode) {
    const server = createServer({ port: opts.port, logDir: opts.logDir, logName: opts.logName });
    livePort = server.port;
    log(`Live UI: http://localhost:${livePort}`, C.green);
    if (!opts.noOpen) {
      setTimeout(() => openBrowser(`http://localhost:${livePort}`), 500);
    }
  }

  const sink = makeLogSink(opts, livePort);
  const targetHost = process.env.ANTHROPIC_BASE_URL
    ? new URL(process.env.ANTHROPIC_BASE_URL).host
    : "api.anthropic.com";

  const capturer = await createCapturer(mode, {
    onPair: sink.onPair,
    logAll: opts.logAll,
    cacheDir: MITM_CA_DIR,
    targetHost,
  });

  spawnClaudeWithCapturer(claudePath, claudeArgs, capturer, opts, sink.writeHtml);
}

async function runNodeMode(claudePath: string, claudeArgs: string[], opts: RunOpts) {
  log("Mode: Node.js --require injection (legacy)", C.blue);

  const preloadPath = await buildPreload();
  const loaderPath = join(dirname(import.meta.path), "loader.cjs");

  let livePort = opts.port;
  if (opts.liveMode) {
    const server = createServer({ port: opts.port, logDir: opts.logDir, logName: opts.logName });
    livePort = server.port ?? opts.port;
    log(`Live UI: http://localhost:${livePort}`, C.green);
    if (!opts.noOpen) {
      setTimeout(() => openBrowser(`http://localhost:${livePort}`), 500);
    }
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CCTRACE_TRACE_ALL: opts.logAll ? "true" : "false",
    CCTRACE_INCLUDE_ALL: "true",
    CCTRACE_OPEN_BROWSER: opts.noOpen ? "false" : "true",
    CCTRACE_SERVER_MODE: opts.liveMode ? "true" : "false",
    CCTRACE_SERVER_PORT: String(livePort),
    CCTRACE_LOG_DIR: opts.logDir,
  };
  if (opts.logName) env.CCTRACE_LOG_NAME = opts.logName;

  log(`Tracing: ${opts.logAll ? "ALL requests" : "/v1/messages"}`, C.cyan);
  console.log("");

  const spawnArgs = ["--require", loaderPath, claudePath, ...claudeArgs];
  const child: ChildProcess = spawn("node", spawnArgs, { env, stdio: "inherit", cwd: process.cwd() });

  child.on("error", (err) => {
    log(`Error: ${err.message}`, C.yellow);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) log(`Terminated: ${signal}`, C.yellow);
    else if (code === 0) log("Session complete", C.green);
    process.exit(code ?? 0);
  });

  let shuttingDown = false;
  const handleSignal = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    child.kill(sig as NodeJS.Signals);
  };
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
}

/** Resolve the capture mode: honor --mode, else auto-detect from the binary. */
function resolveMode(claudePath: string): { mode: "mitm" | "base-url" | "node"; runPath: string } {
  const requested = values.mode?.toLowerCase();
  const jsPath = resolveClaudeBashWrapper(claudePath);
  const effectivePath = jsPath || claudePath;
  const native = isNativeBinary(claudePath) || (jsPath ? isNativeBinary(jsPath) : false);

  if (requested === "node") return { mode: "node", runPath: effectivePath };
  if (requested === "base-url") return { mode: "base-url", runPath: jsPath && !native ? effectivePath : claudePath };
  if (requested === "mitm") return { mode: "mitm", runPath: native ? (jsPath && isNativeBinary(jsPath) ? jsPath : claudePath) : claudePath };

  // auto
  if (native) {
    log("Detected: native binary (Bun-compiled)", C.yellow);
    return { mode: "mitm", runPath: jsPath && isNativeBinary(jsPath) ? jsPath : claudePath };
  }
  return { mode: "node", runPath: effectivePath };
}

async function main() {
  if (values.help) {
    showHelp();
    process.exit(0);
  }

  if (values["print-ca"]) {
    const certs = await ensureCerts(MITM_CA_DIR);
    console.log(certs.caCertPath);
    process.exit(0);
  }

  const requestedMode = values.mode?.toLowerCase();
  if (requestedMode && !CAPTURE_MODES.includes(requestedMode as (typeof CAPTURE_MODES)[number])) {
    console.error(`[cctrace] Error: unknown --mode "${requestedMode}". Use one of: ${CAPTURE_MODES.join(", ")}.`);
    process.exit(1);
  }

  const opts: RunOpts = {
    port: parseInt(values.port || String(DEFAULT_PORT), 10),
    liveMode: !values.static,
    logDir: values.dir || ".cctrace",
    logName: values.log,
    logAll: !values["messages-only"],
    noOpen: !!values["no-open"],
  };

  const claudePath = findClaude();
  log(`Claude: ${claudePath}`, C.blue);
  if (claudeArgs.length) log(`Claude args: ${claudeArgs.join(" ")}`, C.blue);

  const { mode, runPath } = resolveMode(claudePath);

  // Legacy node mode injects .cache/preload.cjs + src/loader.cjs, which only
  // exist when running from the repo — the compiled binary carries neither.
  if (mode === "node" && IS_COMPILED) {
    console.error(
      "[cctrace] node mode (legacy fetch injection) needs the cctrace sources — " +
        "run it via bun instead (bunx @thevibeworks/cctrace), or use --mode mitm/base-url.",
    );
    process.exit(1);
  }

  if (mode === "node") {
    await runNodeMode(runPath, claudeArgs, opts);
  } else {
    await runProxyCapture(mode, runPath, claudeArgs, opts);
  }
}

main().catch((err) => {
  console.error("[cctrace] Error:", err.message);
  process.exit(1);
});
