import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CLIENTS, findClientBinary } from "../src/clients";

describe("client profiles (#20)", () => {
  test("claude, codex, and grok are registered", () => {
    for (const name of ["claude", "codex", "grok"]) {
      const p = CLIENTS[name]!;
      expect(p.name).toBe(name);
      expect(p.candidates("/home/x").length).toBeGreaterThan(0);
      expect(p.installHint).toBeTruthy();
    }
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
