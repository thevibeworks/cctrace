# Live capture resources and recovery

Live proxy capture writes full redacted request bodies to JSONL, then folds
superseded bodies in the proxy and connected pages. The CLI accumulates exit
statistics without retaining the run's bodies. A live page starts with the
folded state; it does not load every repeated screenshot in a long session.

```sh
cctrace                              # full recording, bodies on demand
cctrace --live-body-mb 128            # larger live request-body budget
cctrace --live-bodies full            # retain every request body in the live view
cctrace --upstream-retry 0            # disable additional upstream retries
cctrace --upstream-retry 10           # shorter retry window
```

`--live-bodies folded` is the default for live MITM and base-URL capture.
`--live-body-mb` defaults to 64 and accepts 1–4096 MiB. The budget is the
serialized size of retained request bodies, not a process RSS limit.
Responses, metadata, runtime allocations, active captures, and explicitly
opened inspector/replay bodies use additional memory. Model SSE responses
are still retained in full; this change does not bound an indefinitely
growing response. Static snapshots and the legacy node interceptor retain
their existing behavior.

Folding changes presentation, not disk capture or the bytes sent to the
agent. Every pair remains listed. Older bodies become stubs with model,
session identity, history length, and a link to the next retained history.
An independent byte budget also folds older branch/epoch bodies when needed.
Request-derived usage and pricing parameters are preserved before eviction.

Open a folded request and select **load the original** to read its recorded
body. Only one explicitly loaded inspector body is retained; navigation
releases it. Historical replay loads the selected thread's anchor request
from disk, and reports a loading/error state while it is unavailable.
Session JSONL downloads and wire-spec exports read original records from
disk. Offset lookups verify pair identity and fall back to a scan after a
trace rewrite.

Detailed context composition/search over folded bodies is unavailable in
the live view. For complete per-request context analysis, use
`--live-bodies full` when starting capture, or reopen the recorded trace with
`cctrace view <target> --full`. Full mode consumes memory proportional to all
captured bodies; the request-body budget is ignored. Snapshot and slice
exports reflect the bodies currently loaded in the view; JSONL retains the
original recorded bodies. Folding does not imply that every historical
branch can be fully reconstructed from memory alone.

Capture scope is independent of live retention. `--messages-only` reduces
which calls are recorded. `--intercept-host HOST` enrolls a host for full
body capture. `--capture-external` decrypts external hosts, whose bodies
remain capped at 64 KiB; large external responses now discard capture bytes
while forwarding the complete response. Normal external traffic remains an
opaque, byte-counted tunnel. Credential redaction remains enabled in every
mode, including full mode.

## Upstream failures

A cctrace-generated 502 identifies an upstream transport failure and carries
`x-cctrace-error: upstream-transport`. Its pair has `response: null` plus an
`error` object: kind, runtime error code, controlled diagnostic message,
elapsed time, attempt count, and proxy origin or `direct`. Proxy credentials,
paths, query parameters, and raw exception text are not copied into it.

A TLS error label does not prove that the origin certificate caused an
outage. A reset or timeout does not establish whether the origin received
the request. These distinctions matter more than the displayed label.

MITM model calls retry only connection-refused and DNS failures, with
manual redirects so a failure cannot come from a redirect after the first
POST was processed. The default window for starting retries is 30 seconds,
with 1/2/4/8-second backoff and at most six attempts. `--upstream-retry`
accepts 0–60 seconds. Attempt duration counts against the window; it is not
a new timeout on an in-flight connection or long model inference. Client
cancellation stops waiting/retrying before response headers. Subsequent
streaming keeps the existing response pump's disconnect behavior.

TLS, reset, timeout, HTTP error responses, opaque tunnels, and non-model
calls are not retried by this layer. Base-URL mode retains automatic redirect
following and does not add retries. The agent's own retry policy still
applies. This cannot hide a sustained egress outage or resume a broken SSE
stream without risking duplicate model work.

The terminal gets one diagnostic when a failure streak starts and one when
that route recovers. During an agent-owned TUI these use the existing terminal
buffer and appear after the agent exits; they do not write over its screen.
Recorded failures are available immediately in the request inspector.
Recording callback failures are contained so they cannot turn a successful
upstream response into an agent failure; a recording gap and recovery are
reported through the same terminal mechanism. There is no disk spool for
recovering bytes lost while storage was unavailable.

## Archive cost

New zstd archives enable long-distance matching at the existing level 9,
128 MiB window and checksum settings. This finds repeated base64 image data
that can overwhelm the ordinary match tables. Frames use the existing
decoder format and window limit; old archives are not automatically rewritten.
The matcher has additional encoder memory cost, so improvements depend on
the input. Compression remains in the existing seal/archive workflow.
See the [Zstandard parameter documentation](https://facebook.github.io/zstd/doc/api_manual_v1.5.7.html).

The live footer caches its last decoded action. Session reconstruction
invalidates on model/token-call changes or body updates, rather than every
tunnel/telemetry arrival. A stalled viewer is disconnected when it already
has over 8 MiB queued before another broadcast, and can reconnect to current
state. Neither viewer presence nor a recording callback exception changes
upstream certificate verification.
