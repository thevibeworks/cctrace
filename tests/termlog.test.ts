import { describe, test, expect, afterEach } from "bun:test";
import { muteTerm, unmuteTerm, isTermMuted, termWrite } from "../src/termlog";

describe("termlog mute buffer", () => {
  afterEach(() => {
    unmuteTerm(); // never leak a mute into other tests
  });

  test("writes pass straight through when unmuted", () => {
    const seen: string[] = [];
    const orig = console.log;
    console.log = (line: string) => void seen.push(line);
    try {
      termWrite("hello");
    } finally {
      console.log = orig;
    }
    expect(seen).toEqual(["hello"]);
  });

  test("muted writes buffer in order and flush on unmute", () => {
    const seen: string[] = [];
    const orig = console.log;
    console.log = (line: string) => void seen.push(line);
    try {
      muteTerm();
      expect(isTermMuted()).toBe(true);
      termWrite("one");
      termWrite("two");
      expect(seen).toEqual([]); // nothing hit the terminal while muted
      expect(unmuteTerm()).toEqual(["one", "two"]);
      expect(isTermMuted()).toBe(false);
      termWrite("three"); // pass-through again
      expect(seen).toEqual(["three"]);
    } finally {
      console.log = orig;
    }
  });

  test("unmute clears the buffer — a second unmute returns nothing", () => {
    muteTerm();
    termWrite("held");
    expect(unmuteTerm()).toEqual(["held"]);
    expect(unmuteTerm()).toEqual([]);
  });
});
