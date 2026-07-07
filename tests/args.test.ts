import { describe, test, expect } from "bun:test";
import { splitArgv, parseCliArgs, CliUsageError } from "../src/args";

describe("splitArgv", () => {
  test("no separator: everything is cctrace's", () => {
    expect(splitArgv(["-s", "--mode", "mitm"])).toEqual({ own: ["-s", "--mode", "mitm"], claudeArgs: [] });
  });

  test("splits at the first -- only; later -- goes to Claude verbatim", () => {
    expect(splitArgv(["-s", "--", "--continue", "--", "foo"])).toEqual({
      own: ["-s"],
      claudeArgs: ["--continue", "--", "foo"],
    });
  });

  test("leading -- means all args are Claude's", () => {
    expect(splitArgv(["--", "-p", "hi"])).toEqual({ own: [], claudeArgs: ["-p", "hi"] });
  });

  test("empty argv", () => {
    expect(splitArgv([])).toEqual({ own: [], claudeArgs: [] });
  });
});

describe("parseCliArgs", () => {
  test("own options parse with proper types", () => {
    const { values, claudeArgs } = parseCliArgs(["-s", "--mode", "mitm", "-p", "9000"]);
    expect(values.static).toBe(true);
    expect(values.mode).toBe("mitm");
    expect(values.port).toBe("9000");
    expect(claudeArgs).toEqual([]);
  });

  test("pass-through: cctrace -- --continue", () => {
    const { values, claudeArgs } = parseCliArgs(["--", "--continue"]);
    expect(values.help).toBeUndefined();
    expect(claudeArgs).toEqual(["--continue"]);
  });

  test("mixed: cctrace flags before --, Claude flags after", () => {
    const { values, claudeArgs } = parseCliArgs(["--mode", "base-url", "--", "--model", "opus", "--continue"]);
    expect(values.mode).toBe("base-url");
    expect(claudeArgs).toEqual(["--model", "opus", "--continue"]);
  });

  test("-p is cctrace's port before -- and Claude's print mode after", () => {
    const { values, claudeArgs } = parseCliArgs(["-s", "--", "-p", "hi"]);
    expect(values.port).toBeUndefined();
    expect(claudeArgs).toEqual(["-p", "hi"]);
  });

  test("--help after -- goes to Claude, not cctrace", () => {
    const { values, claudeArgs } = parseCliArgs(["--", "--help"]);
    expect(values.help).toBeUndefined();
    expect(claudeArgs).toEqual(["--help"]);
  });

  test("unknown option errors with a pass-through hint (not silently eaten)", () => {
    expect(() => parseCliArgs(["--continue"])).toThrow(CliUsageError);
    try {
      parseCliArgs(["--continue"]);
    } catch (e) {
      expect((e as Error).message).toContain('unknown option "--continue"');
      expect((e as Error).message).toContain("cctrace -- --continue");
    }
  });

  test("stray positional errors with a pass-through hint", () => {
    try {
      parseCliArgs(["hello world"]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CliUsageError);
      expect((e as Error).message).toContain("cctrace -- hello world");
    }
  });

  test("missing option value is a usage error", () => {
    expect(() => parseCliArgs(["--mode"])).toThrow(CliUsageError);
  });
});
