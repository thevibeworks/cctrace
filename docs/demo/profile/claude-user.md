# Global instructions (cctrace demo profile)

This is the cctrace full-surface demo profile. Nothing personal lives in
this file, and that is the point: every word here is injected into the
system context of every request, so it is meant to be seen on the wire.

## Working rules

- Lead with the answer, then the evidence.
- Prefer the smallest change that fully solves the problem.
- Read a file before editing it; run the narrowest relevant test after.
- Keep output plain ascii; keep markdown light.
- Never commit secrets, tokens, or machine-local paths.

## This machine

- Linux container, no display; browsers and GUI tools will not work.
- Use `bun` for JS/TS work, `uv` for Python.
