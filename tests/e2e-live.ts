#!/usr/bin/env bun
// End-to-end live test: runs the real Claude binary through a capture mode and
// records what was captured. Writes results to test-output/ (workspace, not
// /tmp). Usage:
//   bun run tests/e2e-live.ts mitm      "say hi in 3 words"
//   bun run tests/e2e-live.ts base-url  "say hi in 3 words"

import { createCapturer, type CaptureMode } from "../src/capture";
import { spawn } from "child_process";
import { join, dirname } from "path";
import { appendFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import type { TracePair } from "../src/types";

const root = dirname(import.meta.dir);
const mode = (process.argv[2] as CaptureMode) || "mitm";
const prompt = process.argv[3] || "say hi in exactly three words";

const outDir = join(root, "test-output");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
const jsonl = join(outDir, `e2e-${mode}-${stamp}.jsonl`);
const summary = join(outDir, `e2e-${mode}-${stamp}.summary.txt`);
const latest = join(outDir, "latest.txt");
writeFileSync(jsonl, "");

const claudePath = process.env.HOME + "/.npm-global/bin/claude";
const seen: string[] = [];

const capturer = await createCapturer(mode, {
  onPair: (pair: TracePair) => {
    appendFileSync(jsonl, JSON.stringify(pair) + "\n");
    const path = pair.request.url.replace(/^https:\/\/[^/]+/, "");
    const size = (pair.response?.bodyRaw || JSON.stringify(pair.response?.body ?? "")).length;
    seen.push(`${pair.request.method} ${path} -> ${pair.response?.status ?? "ERR"} (${size}b)`);
  },
  logAll: true,
  cacheDir: join(root, ".cache", "mitm"),
});

const lines: string[] = [];
const emit = (s: string) => { lines.push(s); console.log(s); };

emit(`[e2e] mode: ${mode}`);
emit(`[e2e] ${capturer.label}`);
emit(`[e2e] injecting env: ${Object.keys(capturer.env).join(", ")}`);
emit(`[e2e] spawning: claude -p "${prompt}"`);
emit("");

const child = spawn(claudePath, ["-p", prompt], {
  env: { ...process.env, ...capturer.env, ANTHROPIC_BASE_URL: capturer.env.ANTHROPIC_BASE_URL ?? "" },
  stdio: ["inherit", "pipe", "inherit"],
});

let stdout = "";
child.stdout?.on("data", (d) => { stdout += d.toString(); });

child.on("exit", async (code) => {
  await capturer.flush();
  capturer.stop();
  emit(`[e2e] claude exited ${code}`);
  emit(`[e2e] claude said: ${stdout.trim().slice(0, 120)}`);
  emit("");
  emit(`[e2e] captured ${capturer.pairCount()} pairs:`);
  for (const s of seen) emit(`   ${s}`);
  emit("");

  // Assertions
  const hasMessages = seen.some((s) => s.includes("/v1/messages"));
  const hasOauth = seen.some((s) => s.includes("/api/oauth") || s.includes("/api/claude"));
  emit(`[e2e] ASSERT captured /v1/messages: ${hasMessages ? "PASS" : "FAIL"}`);
  if (mode === "mitm") {
    emit(`[e2e] ASSERT captured non-inference (oauth/bootstrap): ${hasOauth ? "PASS" : "FAIL"}`);
  }
  const ok = hasMessages && (mode !== "mitm" || hasOauth);
  emit("");
  emit(`[e2e] RESULT: ${ok ? "PASS" : "FAIL"}`);

  writeFileSync(summary, lines.join("\n") + "\n");
  writeFileSync(latest, `mode=${mode}\nresult=${ok ? "PASS" : "FAIL"}\njsonl=${jsonl}\nsummary=${summary}\n\n` + lines.join("\n") + "\n");
  emit(`[e2e] wrote: ${summary}`);
  process.exit(ok ? 0 : 1);
});
