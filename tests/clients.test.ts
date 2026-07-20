import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CLIENTS, findClientBinary, wireTables } from "../src/clients";

describe("client profiles (#20)", () => {
  test("claude, codex, grok, and kimi are registered", () => {
    for (const name of ["claude", "codex", "grok", "kimi"]) {
      const p = CLIENTS[name]!;
      expect(p.name).toBe(name);
      expect(p.candidates("/home/x").length).toBeGreaterThan(0);
      expect(p.installHint).toBeTruthy();
    }
  });

  test("every plugin carries a complete wire table", () => {
    for (const p of Object.values(CLIENTS)) {
      expect(["anthropic", "openai"]).toContain(p.wire.dialect);
      expect(p.wire.firstPartyHosts.length).toBeGreaterThan(0);
      // session/thread headers are strings; a stateless dialect (kimi's Chat
      // Completions) legitimately carries neither, so "" is valid.
      expect(typeof p.wire.sessionHeader).toBe("string");
      expect(typeof p.wire.threadHeader).toBe("string");
    }
  });

  // The tables are embedded into the web UI page as data — they must survive
  // a JSON round-trip (no regexes, functions, or undefined).
  test("wireTables() is JSON-safe and drops discovery fields", () => {
    const w = wireTables();
    expect(JSON.parse(JSON.stringify(w))).toEqual(w);
    expect(Object.keys(w).sort()).toEqual(["claude", "codex", "grok", "kimi"]);
    expect((w.claude as any).candidates).toBeUndefined();
  });

  test("an explicit override wins without any lookup", () => {
    expect(findClientBinary(CLIENTS.codex!, "/custom/bin/codex")).toBe("/custom/bin/codex");
  });

  test("well-known paths are tried before $PATH", () => {
    const home = mkdtempSync(join(tmpdir(), "cctrace-clients-"));
    const bin = join(home, ".npm-global", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "codex"), "#!/bin/sh\n");
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(findClientBinary(CLIENTS.codex!)).toBe(join(bin, "codex"));
    } finally {
      process.env.HOME = prevHome;
    }
  });

  test("a missing client throws the install hint", () => {
    const profile = {
      name: "ghost",
      bin: "cctrace-test-no-such-binary",
      candidates: () => ["/nonexistent/ghost"],
      installHint: "Install ghost first",
    };
    expect(() => findClientBinary(profile)).toThrow("Install ghost first");
  });
});
