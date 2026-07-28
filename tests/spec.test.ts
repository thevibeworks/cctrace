import { describe, test, expect } from "bun:test";
import {
  buildSpecCatalog,
  diffSpecCatalogs,
  renderSpecDiff,
  renderSpecMarkdown,
  normalizePath,
  sseEventCounts,
} from "../src/spec";
import type { TracePair } from "../src/types";

function pair(over: Record<string, any> = {}): TracePair {
  const respOver = "response" in over ? over.response : {};
  return {
    id: over.id || "p1",
    request: {
      timestamp: 1785200000,
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        authorization: "Bearer sk-ant-oat01-SUPERSECRET",
        "user-agent": "claude-cli/2.1.220 (external, cli)",
      },
      body: {
        model: "claude-fable-5",
        stream: true,
        messages: [{ role: "user", content: "the user's private prompt text" }],
      },
      ...over.request,
    },
    response: respOver === null ? null : {
      timestamp: 1785200002,
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: "event: message_start\ndata: {}\n\nevent: content_block_delta\ndata: {}\n\nevent: message_stop\ndata: {}\n\n",
      ...respOver,
    },
    duration: 2000,
    loggedAt: "x",
  } as unknown as TracePair;
}

describe("normalizePath", () => {
  test("uuid, hex, and long-numeric segments become placeholders", () => {
    expect(normalizePath("/api/oauth/organizations/3f9a2c1e-1234-5678-9abc-def012345678/prepaid/credits"))
      .toBe("/api/oauth/organizations/{uuid}/prepaid/credits");
    expect(normalizePath("/v1/traces/deadbeefdeadbeef01")).toBe("/v1/traces/{hex}");
    expect(normalizePath("/api/runs/1234567")).toBe("/api/runs/{n}");
    expect(normalizePath("/v1/messages")).toBe("/v1/messages");
  });

  test("embedded uuids inside a segment normalize too", () => {
    expect(normalizePath("/api/session_3f9a2c1e-1234-5678-9abc-def012345678/state"))
      .toBe("/api/session_{uuid}/state");
  });

  test("random mixed-case tokens normalize; API words survive", () => {
    expect(normalizePath("/api/eval/sdk-zAZezfDKGoZuXXKe")).toBe("/api/eval/{token}");
    expect(normalizePath("/v1/messages/count_tokens")).toBe("/v1/messages/count_tokens");
    expect(normalizePath("/api/claude_code_penguin_mode")).toBe("/api/claude_code_penguin_mode");
  });
});

describe("buildSpecCatalog", () => {
  test("catalog carries names, shapes, and counts — never secret values", () => {
    const p2 = pair({ id: "p2" });
    (p2.request.body as any).metadata = { user_id: "session-secret" }; // optional field
    const catalog = buildSpecCatalog([pair(), p2], { generator: "cctrace test" });

    expect(catalog.pairsScanned).toBe(2);
    expect(catalog.endpoints.length).toBe(1);
    const ep = catalog.endpoints[0]!;
    expect(ep.method).toBe("POST");
    expect(ep.host).toBe("api.anthropic.com");
    expect(ep.path).toBe("/v1/messages");
    expect(ep.samples).toBe(2);
    expect(ep.statuses["200"]).toBe(2);
    expect(ep.firstSeen.startsWith("2026-")).toBe(true);

    // header NAMES present; auth VALUE absent anywhere in the artifact
    expect(ep.requestHeaders["authorization"]!.seen).toBe(2);
    const dumped = JSON.stringify(catalog);
    expect(dumped).not.toContain("SUPERSECRET");
    expect(dumped).not.toContain("private prompt text");
    expect(dumped).not.toContain("session-secret");

    // allowlisted values ARE surface facts
    expect(ep.requestHeaders["anthropic-version"]!.values).toEqual(["2023-06-01"]);
    expect(ep.requestBody!.fields!["model"]!.values).toEqual(["claude-fable-5"]);

    // presence counts make optionality an observation, not a guess
    expect(ep.requestBody!.fields!["metadata"]!.seen).toBe(1);
    expect(ep.requestBody!.seen).toBe(2);

    // SSE responses catalog event types instead of body shapes
    expect(ep.sseEvents!["message_start"]).toBe(2);
    expect(ep.sseEvents!["content_block_delta"]).toBe(2);
    expect(ep.responseBody).toBeUndefined();

    // provenance: observed clients
    expect(Object.keys(catalog.clients)).toEqual(["claude-cli/2.1.220 (external, cli)"]);
  });

  test("tunnel meta pairs are skipped — nothing was observed", () => {
    const tunnel = pair({
      id: "t1",
      request: { method: "CONNECT", url: "https://github.com/", body: null },
      response: { status: 200, headers: {}, body: { tunneled: true, bytesUp: 100, bytesDown: 200 } },
    });
    const catalog = buildSpecCatalog([tunnel]);
    expect(catalog.pairsScanned).toBe(0);
    expect(catalog.endpoints.length).toBe(0);
  });

  test("json response bodies get shapes; missing responses count as status none", () => {
    const ok = pair({
      id: "p3",
      response: { status: 200, headers: { "content-type": "application/json" }, body: { id: "x", usage: { input_tokens: 5 } } },
    });
    const failed = pair({ id: "p4", response: null });
    const catalog = buildSpecCatalog([ok, failed]);
    const ep = catalog.endpoints[0]!;
    expect(ep.responseBody!.fields!["usage"]!.fields!["input_tokens"]!.types).toEqual(["number"]);
    expect(ep.statuses["none"]).toBe(1);
  });
});

describe("sseEventCounts", () => {
  test("counts event lines, ignores non-SSE strings and objects", () => {
    expect(sseEventCounts("event: a\ndata: {}\n\nevent: a\n\nevent: b\n")).toEqual({ a: 2, b: 1 });
    expect(sseEventCounts("just some text")).toBeUndefined();
    expect(sseEventCounts({ foo: 1 })).toBeUndefined();
  });
});

describe("diffSpecCatalogs", () => {
  test("added endpoints, headers, fields, and sse events are reported", () => {
    const prev = buildSpecCatalog([pair()]);
    const p2 = pair({ id: "p2" });
    (p2.request.headers as any)["x-claude-code-agent-id"] = "abc";
    (p2.request.body as any).output_config = { effort: "high" };
    (p2.response as any).body += "event: brand_new_event\ndata: {}\n\n";
    const oauth = pair({
      id: "p3",
      request: { url: "https://api.anthropic.com/api/oauth/profile", method: "GET", body: null },
      response: { status: 200, headers: {}, body: { account: { uuid: "u" } } },
    });
    const next = buildSpecCatalog([pair(), p2, oauth]);

    const d = diffSpecCatalogs(prev, next);
    expect(d.addedEndpoints).toEqual(["GET api.anthropic.com/api/oauth/profile"]);
    expect(d.removedEndpoints).toEqual([]);
    const notes = d.changed[0]!.notes;
    expect(notes).toContain("+ request header x-claude-code-agent-id");
    expect(notes).toContain("+ request field output_config");
    expect(notes).toContain("+ request field output_config.effort");
    expect(notes).toContain("+ sse event brand_new_event");

    const text = renderSpecDiff(d);
    expect(text).toContain("+ endpoint GET api.anthropic.com/api/oauth/profile");
    expect(renderSpecDiff(diffSpecCatalogs(prev, prev))).toBe("no changes");
  });
});

describe("renderSpecMarkdown", () => {
  test("renders endpoint sections with presence counts and no secrets", () => {
    const p2 = pair({ id: "p2" });
    (p2.request.body as any).metadata = { user_id: "session-secret" };
    const md = renderSpecMarkdown(buildSpecCatalog([pair(), p2], { generator: "cctrace test" }));
    expect(md).toContain("## POST api.anthropic.com/v1/messages");
    expect(md).toContain("- metadata: object (1/2)");
    expect(md).toContain("model: string = claude-fable-5");
    expect(md).toContain("message_start");
    expect(md).not.toContain("SUPERSECRET");
    expect(md).not.toContain("session-secret");
  });
});
