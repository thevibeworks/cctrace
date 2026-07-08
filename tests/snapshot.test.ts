import { describe, test, expect } from "bun:test";
import { renderSnapshot, jsonForScript } from "../src/ui";
import type { TracePair } from "../src/types";

// Regression: a captured payload containing "</script>" (common when Claude is
// discussing HTML) must not close the inline <script> early. Before the fix,
// renderSnapshot embedded raw JSON.stringify and the browser threw
// "Invalid or unexpected token" at load.

const SEP_2028 = String.fromCharCode(0x2028);
const SEP_2029 = String.fromCharCode(0x2029);

function pairWith(body: string): TracePair {
  return {
    id: "p1",
    request: { timestamp: 1, method: "POST", url: "https://api.anthropic.com/v1/messages", headers: {}, body: { text: body } },
    response: { timestamp: 2, status: 200, headers: {}, body: {} },
    duration: 1,
    loggedAt: "x",
  } as unknown as TracePair;
}

describe("jsonForScript", () => {
  test("escapes < so no tag can close or open early", () => {
    const out = jsonForScript({ a: "</script><script>alert(1)</script>" });
    expect(out.includes("<")).toBe(false);
    expect(out.includes("\\u003c")).toBe(true);
  });

  test("escapes the JS-only line separators U+2028 / U+2029", () => {
    const out = jsonForScript({ a: `x${SEP_2028}y${SEP_2029}z` });
    expect(out.includes(SEP_2028)).toBe(false);
    expect(out.includes(SEP_2029)).toBe(false);
  });

  test("round-trips to the identical value", () => {
    const value = { a: "</script>", b: `sep${SEP_2028}`, c: [1, "<b>", null] };
    expect(JSON.parse(jsonForScript(value))).toEqual(value);
  });
});

describe("renderSnapshot", () => {
  test("embedded __PAIRS__ has no raw < and parses as JSON", () => {
    const html = renderSnapshot([pairWith("please close this: </script> now")]);
    const m = html.match(/window\.__PAIRS__ = (.*?);\n?<\/script>/s);
    expect(m).not.toBeNull();
    const payload = m![1];
    expect(payload.includes("<")).toBe(false);
    const parsed = JSON.parse(payload);
    expect(parsed).toHaveLength(1);
    expect((parsed[0].request.body as { text: string }).text).toContain("</script>");
  });

  // Regression: the </head> injection must use a function replacement — a
  // string replacement $-substitutes the payload ($$ collapses, $& / $` / $'
  // splice document text into the JSON), and captured conversations about
  // code (Makefiles, regexes) contain those daily.
  test("payload with $-substitution patterns survives injection intact", () => {
    const text = "make: $$(CC) regex: $& before: $` after: $'";
    const html = renderSnapshot([pairWith(text)]);
    const m = html.match(/window\.__PAIRS__ = (.*?);\n?<\/script>/s);
    expect(m).not.toBeNull();
    const parsed = JSON.parse(m![1]);
    expect((parsed[0].request.body as { text: string }).text).toBe(text);
  });
});
