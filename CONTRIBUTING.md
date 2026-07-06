# Contributing

## Quick Start

```bash
git clone https://github.com/thevibeworks/cctrace.git
cd cctrace
bun install
bun test
```

You need [Bun](https://bun.sh) and `openssl` on PATH. To try it end to end you
also need Claude Code installed (`claude`).

## Guidelines

- **One capture path, one abstraction.** New capture modes implement the
  `Capturer` interface in `src/capture.ts`. `cli.ts` should not learn a fourth
  way to spawn Claude.
- **Categorization is single-source.** Endpoint → category logic lives only in
  `src/categorize.ts`; it is inlined into the web UI via `.toString()`, so it
  must stay pure (no imports, no closure references).
- **Never widen the intercept surface silently.** `isInterceptHost` and the leaf
  cert SANs in `src/certs.ts` must stay in sync — we only terminate TLS for
  hosts we can present a valid cert for. Everything else is blind-tunneled.
- **Credentials never hit disk in the clear.** If you touch header handling,
  keep the redaction path intact. A trace that leaks the user's token into a
  shareable `.html` is a security bug, not a feature.
- Match the existing code style. Read the code before proposing rewrites.

## Tests

```bash
bun test                                # unit: proxy, mitm/certs, categorize
bun run tests/e2e-live.ts mitm "hi"     # e2e against real Claude (all hosts)
bun run tests/e2e-live.ts base-url "hi" # e2e, messages only
```

Unit tests must not require a real Claude install or network. The `e2e-live.ts`
and `make-snapshot.ts` harnesses are dev-only (not `*.test.ts`, so `bun test`
skips them). e2e output lands in `test-output/` — gitignored.

## Pull Requests

- One feature per PR. Small diffs review faster.
- Add test coverage for new behavior.
- Update `CHANGELOG.md` when user-facing behavior changes.
- Run `bun test` before pushing. CI runs it on every push and PR to `main`.

## Bug Reports

Open an issue with:

1. Your OS and `bun --version`.
2. `claude --version` (and whether it's a native binary or npm install).
3. The mode you ran (`--mode`) and the full `[cctrace]` startup lines.
4. What you expected to be captured vs. what showed up in the UI.

Never paste a raw `.cctrace/*.jsonl` or exported `.html` into a public issue —
it contains your real request/response traffic.
