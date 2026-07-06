import { renderSnapshot } from "../src/server";
import { readFileSync, writeFileSync } from "fs";
const jsonl = process.argv[2];
const out = process.argv[3];
const pairs = readFileSync(jsonl, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
writeFileSync(out, renderSnapshot(pairs));
console.log(`snapshot: ${out} (${pairs.length} pairs)`);
