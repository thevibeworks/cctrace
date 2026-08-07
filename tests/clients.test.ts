import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CLIENTS, findClientBinary, wireTables } from "../src/clients";
import { codexProviderHosts } from "../src/clients/codex";
import { opencodeConfigHosts } from "../src/clients/opencode";

describe("client profiles (#20)", () => {
  test("claude, codex, grok, kimi, and opencode are registered", () => {
    for (const name of ["claude", "codex", "grok", "kimi", "opencode"]) {
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
    expect(Object.keys(w).sort()).toEqual(["claude", "codex", "grok", "kimi", "opencode"]);
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

describe("codex custom provider hosts (config.toml)", () => {
  test("every [model_providers.*] base_url enrolls; other sections and comments do not", () => {
    const toml = [
      'model_provider = "Corp"',
      'base_url = "https://top-level-ignored.example"', // not under a provider
      "",
      "[model_providers.Corp]",
      'name = "Corp"',
      'base_url = "https://gw.corp.example"',
      '# base_url = "https://commented-out.example"',
      'wire_api = "responses"',
      "",
      '[model_providers."second one"]',
      "base_url = 'https://alt.example:8443/v1'",
      "",
      "[features]",
      'base_url = "https://not-a-provider.example"',
      "",
      "[model_providers.broken]",
      'base_url = "not a url"',
    ].join("\n");
    expect(codexProviderHosts(toml).sort()).toEqual(["alt.example", "gw.corp.example"]);
  });

  test("configHosts reads $CODEX_HOME/config.toml fail-soft", () => {
    const dir = mkdtempSync(join(tmpdir(), "cctrace-codex-home-"));
    writeFileSync(join(dir, "config.toml"), '[model_providers.X]\nbase_url = "https://custom.provider.test"\n');
    expect(CLIENTS.codex!.configHosts!({ CODEX_HOME: dir })).toEqual(["custom.provider.test"]);
    // absent config: empty, never a throw
    expect(CLIENTS.codex!.configHosts!({ CODEX_HOME: join(dir, "nope") })).toEqual([]);
    expect(CLIENTS.codex!.configHosts!({})).toEqual(expect.any(Array));
  });
});

describe("opencode custom provider hosts (#89)", () => {
  test("every baseURL enrolls; JSONC comments and broken URLs don't break the scan", () => {
    const jsonc = [
      "{",
      '  // custom gateway with an https:// url in a comment: https://not-parsed.example',
      '  "provider": {',
      '    "zenmux": { "options": { "baseURL": "https://zenmux.ai/api/v1", }, },', // trailing commas
      '    "corp": { "options": { "baseURL": "https://gw.corp.example:8443/anthropic" } },',
      '    "broken": { "options": { "baseURL": "not a url" } }',
      "  }",
      "}",
    ].join("\n");
    expect(opencodeConfigHosts(jsonc).sort()).toEqual(["gw.corp.example", "zenmux.ai"]);
  });

  test("configHosts unions global + $OPENCODE_CONFIG files, fail-soft", () => {
    const home = mkdtempSync(join(tmpdir(), "cctrace-opencode-home-"));
    const cfgDir = join(home, ".config", "opencode");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, "opencode.json"), '{"provider":{"a":{"options":{"baseURL":"https://global.provider.test/v1"}}}}');
    const explicit = join(home, "explicit.jsonc");
    writeFileSync(explicit, '{"provider":{"b":{"options":{"baseURL":"https://explicit.provider.test/v1"}}}}');
    const hosts = CLIENTS.opencode!.configHosts!({ HOME: home, OPENCODE_CONFIG: explicit });
    expect(hosts).toContain("global.provider.test");
    expect(hosts).toContain("explicit.provider.test");
    // absent config: empty, never a throw
    expect(CLIENTS.opencode!.configHosts!({ HOME: join(home, "nope") })).toEqual(expect.any(Array));
  });
});
