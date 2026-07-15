import { describe, test, expect } from "bun:test";
import { buildInterceptSet, hostInSet } from "../src/certs";
import { CLIENTS } from "../src/clients";

// Tunnel-by-default (devlog 2026-07-15): only include-listed hosts are
// MITM'd; everything else is an opaque byte-counted tunnel. These tests pin
// the include-list contract BEFORE the policy applies: every host category
// the UI depends on must resolve to intercept=true, or the regression is
// subtle — traces still work, chips quietly vanish.

describe("intercept include-list", () => {
  for (const [name, plugin] of Object.entries(CLIENTS)) {
    test(`${name}: first-party hosts and subdomains are intercepted`, () => {
      const set = buildInterceptSet(plugin.wire);
      for (const h of plugin.wire.firstPartyHosts) {
        expect(hostInSet(h, set)).toBe(true);
        expect(hostInSet("api." + h, set)).toBe(true);
      }
    });

    test(`${name}: every pinned host (telemetry/oauth/... the UI reads) is intercepted`, () => {
      const set = buildInterceptSet(plugin.wire);
      for (const [hostPath] of plugin.wire.hostCategories) {
        const host = hostPath.split("/")[0]!;
        expect(hostInSet(host, set)).toBe(true);
      }
    });
  }

  test("claude: datadog intake (Claude Code's own telemetry on a third-party host) is pinned and intercepted", () => {
    const pins = CLIENTS.claude!.wire.hostCategories;
    const dd = pins.find(([hp]) => hp.includes("datadoghq.com"));
    expect(dd?.[1]).toBe("telemetry");
    const set = buildInterceptSet(CLIENTS.claude!.wire);
    expect(hostInSet("http-intake.logs.us5.datadoghq.com", set)).toBe(true);
  });

  test("genuinely external hosts are NOT intercepted for any client", () => {
    for (const plugin of Object.values(CLIENTS)) {
      const set = buildInterceptSet(plugin.wire);
      for (const h of ["registry.npmjs.org", "api.github.com", "pypi.org", "proxy.golang.org", "deb.debian.org"]) {
        expect(hostInSet(h, set)).toBe(false);
      }
    }
  });

  test("base-url env overrides enroll their hosts", () => {
    const set = buildInterceptSet(CLIENTS.claude!.wire, {
      env: {
        ANTHROPIC_BASE_URL: "https://relay.corp.example:8443/v1",
        OPENAI_BASE_URL: "https://oai-gw.internal/responses",
        OPENAI_API_BASE: "not a url", // must not throw
      },
    });
    expect(hostInSet("relay.corp.example", set)).toBe(true);
    expect(hostInSet("oai-gw.internal", set)).toBe(true);
  });

  test("--intercept-host extras enroll, with *. prefix tolerated", () => {
    const set = buildInterceptSet(CLIENTS.claude!.wire, { extraHosts: ["mcp.example.com", "*.tools.example"] });
    expect(hostInSet("mcp.example.com", set)).toBe(true);
    expect(hostInSet("run.tools.example", set)).toBe(true);
    expect(hostInSet("example.com", set)).toBe(false);
  });

  test("hostInSet is suffix-safe: evil-anthropic.com does not match anthropic.com", () => {
    const set = buildInterceptSet(CLIENTS.claude!.wire);
    expect(hostInSet("evil-anthropic.com", set)).toBe(false);
    expect(hostInSet("anthropic.com.evil.example", set)).toBe(false);
  });
});
