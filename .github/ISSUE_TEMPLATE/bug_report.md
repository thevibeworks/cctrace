---
name: Bug report
about: Something cctrace captured wrong, missed, or crashed on
title: ""
labels: bug
---

<!--
⚠️  Do NOT paste raw `.cctrace/*.jsonl` or exported `.html` — they contain your
    real request/response traffic. Redaction covers known credential shapes, not
    everything. Describe the problem instead, or share a hand-sanitized snippet.
-->

**What happened**
A clear description of the bug.

**Environment**
- OS:
- `bun --version`:
- `claude --version`:
- Native binary or npm/JS install?:
- Mode (`--mode`):

**cctrace startup lines**
The `[cctrace] ...` lines it printed on start (these are safe to share).

**Expected vs actual**
What you expected to be captured/shown vs what happened.
