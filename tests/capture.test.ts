import { describe, expect, test } from "bun:test";
import { traceIdentityEnv, bypassHostEnv } from "../src/capture";

// #83: --bypass-host — the named hosts talk direct (child NO_PROXY append),
// with the tool's normal non-proxy behavior. Inherited values must survive.
describe("bypassHostEnv", () => {
  test("sets both NO_PROXY spellings for the named hosts", () => {
    expect(bypassHostEnv(["api.cloudflare.com"], {})).toEqual({
      NO_PROXY: "api.cloudflare.com",
      no_proxy: "api.cloudflare.com",
    });
  });

  test("appends to an inherited NO_PROXY instead of clobbering it", () => {
    expect(bypassHostEnv(["b.example"], { NO_PROXY: "a.example" })).toEqual({
      NO_PROXY: "a.example,b.example",
      no_proxy: "a.example,b.example",
    });
    expect(bypassHostEnv(["b.example"], { no_proxy: "a.example, c.example" })).toEqual({
      NO_PROXY: "a.example,c.example,b.example",
      no_proxy: "a.example,c.example,b.example",
    });
  });

  test("dedupes an already-present host and no-ops on an empty list", () => {
    expect(bypassHostEnv(["a.example"], { NO_PROXY: "a.example" })).toEqual({
      NO_PROXY: "a.example",
      no_proxy: "a.example",
    });
    expect(bypassHostEnv([], { NO_PROXY: "a.example" })).toEqual({});
  });
});

describe("traceIdentityEnv", () => {
  test("live run exports file, port, and instance id", () => {
    const env = traceIdentityEnv("/proj/.cctrace/trace-x.jsonl", { id: "run-1", port: 9317 });
    expect(env).toEqual({
      CCTRACE_TRACE_FILE: "/proj/.cctrace/trace-x.jsonl",
      CCTRACE_INSTANCE_ID: "run-1",
      CCTRACE_SERVER_PORT: "9317",
    });
  });

  test("static run (no live server) exports the trace file only", () => {
    expect(traceIdentityEnv("/proj/.cctrace/trace-x.jsonl", null)).toEqual({
      CCTRACE_TRACE_FILE: "/proj/.cctrace/trace-x.jsonl",
    });
    expect(traceIdentityEnv("/proj/.cctrace/trace-x.jsonl")).toEqual({
      CCTRACE_TRACE_FILE: "/proj/.cctrace/trace-x.jsonl",
    });
  });

  test("pre-0.10 instance without an id still exports the port", () => {
    expect(traceIdentityEnv("/t.jsonl", { port: 9318 })).toEqual({
      CCTRACE_TRACE_FILE: "/t.jsonl",
      CCTRACE_SERVER_PORT: "9318",
    });
  });
});
