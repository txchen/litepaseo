# Local performance baseline

Linux, Node >=24.11, installed dependencies and Playwright Chromium are required.

```sh
npm run build
node benchmarks/run.mjs --smoke
node benchmarks/run.mjs
node benchmarks/run.mjs --motion
node benchmarks/run.mjs --scenario=markdown-large
node benchmarks/analyze.mjs benchmarks/runs/<timestamp>
```

The complete run takes roughly 22 minutes. The separate `--motion` diagnostic takes
about three minutes: three alternating-order pairs with default/reduced motion,
20 seconds each, connected with running status badges but no incoming events.
Run these sequentially to avoid competing benchmark processes.
`BENCH_OUT` overrides the output directory;
use a fresh directory for each invocation. A smoke run validates the harness only.
The runner exits nonzero on a failed case and records the failure with other results.

The production frontend talks over real loopback HTTP/SSE to the application's BFF,
directory and timeline code. Two in-process SDK facade doubles provide deterministic
session metadata and timeline deltas. They never contact the user's daemon, agents,
providers or stored configuration. The BFF is loaded from TypeScript source using
Node's type stripping, rather than from the packaged CLI. Fixture generation, storage
and event logging are included in its CPU and memory counters.

Every repetition launches a fresh BFF and headless Chromium. Clients are independent
authenticated browser contexts within that Chromium, not eight separate browsers.
Only the first context's navigation includes the BFF's cold initial directory work;
all per-client navigation timings are retained in `result.json`. Catalog ready time
ends when the full session count and initial 60 message rows are present. It excludes
Chromium launch, login and process startup. The sidebar is virtualized.

Streaming targets 20 deltas/s **per host**, 40/s aggregate; scheduling can reduce the
actual rate, and generated counts are recorded. Each client observes one
host. History has 20,000 synthetic rows per host, fetched lazily. Plain text starts a
new message every 100 deltas; soak starts one every 3 deltas to cross retention limits.
The large Markdown case starts with an unfinished 12,000-line code fence, then appends
small deltas. This is an intentionally extreme single-message case, not typical prose.
Directory churn updates 50 agent/workspace pairs per second across both hosts.

Summary tables use medians across repetitions, with min/max retained in `summary.json`.
Multi-client cold time first takes the median across clients within each repetition.
Latency summaries take the median of each repetition's p95, not a pooled p95.
Three repetitions are a variance check, not a well-powered statistical comparison.

CPU is CPU seconds / measured wall seconds; **100% is one logical core**. Browser
counters sum the sampled process tree, retaining counters from observed exited
processes. Child processes are enumerated across every task/thread, including
Chromium's network service. Processes born and exited between samples can be missed. PSS apportions
shared memory; summed RSS is also recorded but double-counts shared pages. BFF RSS
includes the fixture, whose full live history is intentionally retained for validation.
Reported peaks are sampled within the measurement window, not continuous high-water
marks and not peaks during cold navigation.
Memory and CPU probes run every two seconds, including DOM queries and CDP metrics;
their overhead is present in all cases. Measurement includes a one-second final drain.
`wireBytes` counts response-body bytes, excluding request traffic and HTTP/TLS headers;
it is not a packet capture or a complete network-traffic counter.
The idle case is 60 seconds, with a two-second startup settle, not a full energy trial.

Latency samples use the newest event marker in the last rendered message, measured
at the animation-frame callback following DOM mutation, at most once per second per
client. This includes batching and loopback delivery, but is **not physical display
latency**, a latency for every delta, or a frame-rate measurement. Coalescing can hide
older-event latency. There is no network delay simulation. `hidden-signal` overrides
`document.hidden` and dispatches visibility events: it tests application unsubscribe
and resume behavior, not real OS/background-tab throttling.

Correctness checks compare the complete final **visible suffix** to the authoritative
fixture after Markdown rendering, with SHA-256 hashes for both sides. They do not
validate all historical rows, directory contents under churn, tool cards, approvals,
or provider behavior. All directory SSE clients must close after each run. Hidden
visibility must close directory SSE while hidden, then catch up on foreground.

Artifacts include environment and harness hashes, scenario configuration, raw event
logs with SHA-256 hashes, two-second counter samples, latency samples, final correctness
checks, per-run results, CSV counters and the analysis script's grouped medians/ranges.
Event logs may be gzip-compressed after collection; hashes refer to uncompressed bytes.
The `harness/` directory archives the exact runner/server sources used for that run;
its imports are relative to the original `benchmarks/` location.
Smoke output is ignored by Git. These measurements establish a LitePaseo baseline;
they do not compare official Paseo, measure daemon/provider cost or establish energy
savings. See [the experiment plan and measured results](../docs/performance-plan.md).
