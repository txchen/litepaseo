# Performance benchmarks

## LitePaseo versus official Paseo web UI

The reader-facing comparison is in [performance-plan.md](../docs/performance-plan.md).
The older LitePaseo-only optimization log is [archived separately](legacy-baseline.md).

### Reproduce the comparison

Use Linux, Node 26, installed project dependencies and Playwright Chromium. Install
the official package into a **separate temporary directory**, leaving this project's
dependencies and your normal Paseo daemon untouched:

```sh
npm install
npx playwright install chromium
comparison_deps=$(mktemp -d)
npm install --prefix "$comparison_deps" --no-audit --no-fund @getpaseo/server@0.15.4
export PASEO_BENCH_PACKAGE="$comparison_deps/node_modules/@getpaseo/server"
npm run build
node benchmarks/compare.mjs --smoke
node benchmarks/compare.mjs
node benchmarks/analyze-comparison.mjs benchmarks/runs/<timestamp>-comparison
```

The full comparison takes about 25 minutes; run it without other benchmarks or
builds competing for resources. `BENCH_OUT` selects a fresh output directory;
`BENCH_SCENARIOS=idle,plain,code` selects scenarios. Smoke results are excluded from
the report. The runner stops on the first failed case and preserves its error.

`compare-daemon.mjs` starts a fresh, real, published Paseo daemon for each case,
using its packaged test bootstrap and mock-provider extension point. Only provider
output is replaced: the unmodified daemon, SDK, transports and frontend process it
normally. Development mode enables the mock provider; the served official web UI
is the **published production bundle**, not a development server. Plugins and real
providers are disabled. Each case has one workspace, one running agent, one user
message and one assistant message. Temporary homes isolate all benchmark data.

Official Paseo connects directly by WebSocket. LitePaseo uses its normal SDK-backed
BFF and HTTP/SSE. The BFF runs from this repo's source; its frontend is the production
build. Browser, BFF and daemon CPU are separate counters. Both servers are local
for reproducibility; this is not a remote-network test or total system power test.

The same deterministic message is used for each pair:

| Case | Input during measurement |
|---|---|
| `idle` | Running agent waiting, no incoming deltas; status indicators remain active |
| `plain` | 600 numbered plain-text chunks, 20/s over 30 seconds |
| `code` | An unfinished TypeScript fence containing 200 lines, then 600 numbered comment chunks at 20/s |

Chunks include Chinese text. The mock provider holds the turn open so both UIs
retain their running state. These scenarios do not test tool calls, approvals,
completed turns, large directories, history pagination, hidden tabs or reconnection.
The code case has equal source text but different presentation: LitePaseo uses a
plain `pre` block, while Paseo renders syntax highlighting. This is a comparison
of product defaults, not an isolated comparison of framework efficiency.

The first full run used 1,000 initial code lines. Its 47,807-character final message
exceeded Paseo 0.15.4's 32,000-character render cap; the official client's DOM matched
that exact capped prefix and could not pass full-text validation. Both sides of
that pair are excluded from performance ratios, with the failure retained in
`results.json` and explained in `excluded-code-case.json`. The corrected 200-line
fixture ends at 27,807 characters. To regenerate the first run's summary from its
saved top-level artifacts, use `--scenarios=idle,plain` with `analyze-comparison.mjs`;
the corrected code run is analyzed separately without that filter. The current
runner uses the corrected fixture for all new runs.

Each case uses a fresh headless Chromium process and profile, 1280 × 900 viewport,
dark color preference and normal motion. LitePaseo's CSS motion setting is asserted
to be 1,000 ms. Official onboarding is marked complete and chat display is set to
full. No UI source is patched. After the initial message appears, wait ten seconds,
then measure 30 seconds plus at least a one-second drain, waiting for the final
chunk before taking final counters. Five pairs alternate A/B then B/A
order; this is balanced approximately, **not randomized**. No thermal stabilization
or exclusive machine reservation is enforced.

CPU is the difference in cumulative `/proc` CPU seconds for the entire browser
process tree divided by wall time: 100% means one logical core. Child discovery
visits every thread's children list. Observed exited processes stay in the ledger;
processes born and exited between samples may be missed. PSS apportions shared
memory; the reported peak is the largest two-second sample within the measured
window, not a continuous high-water mark or a startup peak. JS heap covers the page,
not all browser processes. CPU includes sampling and in-page observer overhead.

A MutationObserver records when **each numbered chunk** first appears in assistant
DOM text. Latency runs from provider emission to that callback, including daemon,
transport, batching and rendering. It is not physical paint latency. Unlike the old
baseline's newest-marker sampling, this measures the wait of every chunk in a batch.
Long tasks are page main-thread tasks exceeding 50 ms. These metrics do not measure
keypress latency or display FPS. Screenshots happen after CPU measurement.

Correctness checks require every marker exactly once in order, plus equality of
the **complete** assistant text after removing the code fence and normalizing
whitespace. Both sides' final hashes and generated counts must match within each
pair. The analyzer also checks that the last chunk was observed before the final
CPU sample. For the code case, the harness scrolls nested `pre` elements to the end
on DOM changes and verifies the final marker is within the viewport and code
scroller; this keeps LitePaseo's capped code region following new output, matching
Paseo's automatic follow. Scroll overhead is included. Earlier setup runs without
this scroll condition are excluded.

Loading metrics use fresh browser caches, but warm host file caches. Ready time
starts at navigation and ends when the initial assistant text is mounted; it
excludes login, browser/server startup, and may precede deferred imports. Resource
sizes therefore separately sum all fetched JS/CSS through the end of the case,
including LitePaseo's deferred Markstream import. Encoded body bytes reflect actual
HTTP compression; decoded bytes represent the source delivered to the browser.
Neither includes HTML, fonts, images, protocol headers, WebSocket or SSE traffic.

Artifacts: environment and versions (`manifest.json`), production file hashes
(`build-hashes.json`), per-repetition results, `counters.csv`, grouped medians and
min/max (`summary.json`), and raw process samples, per-chunk timings, long tasks and
resource entries (`raw-counters.json`). These top-level artifacts accompany the report.
Per-case screenshots, rendered text, daemon timeline snapshots and archived harness
copies stay local under the repository's existing ignore rules. The included
harness regenerates them. Five repetitions describe local variability, not a
statistically representative battery-life study. Energy is unavailable, not zero.

## Historical LitePaseo-only baseline

Linux, Node >=24.11, installed dependencies and Playwright Chromium are required.

```sh
npm run build
node benchmarks/run.mjs --smoke
node benchmarks/run.mjs
node benchmarks/run.mjs --motion
node benchmarks/run.mjs --motion-sweep
node benchmarks/run.mjs --scenario=markdown-large
node benchmarks/run.mjs --scenario=plain,markdown-large,history-expanded
node benchmarks/analyze.mjs benchmarks/runs/<timestamp>
```

The complete run takes roughly 22 minutes. The separate `--motion` diagnostic takes
about three minutes: three alternating-order pairs with default/reduced motion,
20 seconds each, connected with running status badges but no incoming events.
The current default advances persistent decorative animations once per second;
live timeline bodies flush every 500 ms. `--motion-sweep` overrides the motion
clock and animation phases to compare two versus one animation updates/s.
Motion diagnostics also check actual animation-clock changes and stopping while hidden.
Run these sequentially to avoid competing benchmark processes.
`BENCH_OUT` overrides the output directory;
use a fresh directory for each invocation. A smoke run validates the harness only.
The runner exits nonzero on a failed case and records the failure with other results.

The production frontend talks over real loopback HTTP/SSE to the application's BFF,
directory and timeline code. Two in-process SDK facade doubles provide deterministic
session metadata and timeline deltas. They never contact a real daemon, agents,
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

After the history fix, `history-expanded` navigates 20 older pages inside a 150-row
window, checks scroll anchors and newer-page navigation, then keeps that historical
snapshot fixed during incoming output. It compares the displayed historical range
to the fixture and checks return-to-latest afterward. Its CPU is therefore not a
like-for-like comparison to the original benchmark's 2,066 live-updating rows;
the old harness sources remain archived with that baseline. It still demonstrates
the bounded rendering behavior and absence of history displacement during streaming.

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
Smoke output, raw per-repetition data and archives are ignored by Git; only each
run's top-level summaries are committed. These measurements establish a LitePaseo baseline;
they do not compare official Paseo, measure daemon/provider cost or establish energy
savings. See [the historical optimization log](legacy-baseline.md); the separate
comparison harness above measures both clients.
