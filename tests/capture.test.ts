import { describe, expect, test } from "bun:test";
import { traceIdentityEnv } from "../src/capture";

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
