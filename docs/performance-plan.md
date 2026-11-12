# LitePaseo vs. official Paseo web UI

LitePaseo is built for an agent dashboard that stays open for hours: less CPU spent
on status animation and streaming, less memory occupied by the browser, and smaller
downloads. The goal is a lightweight console designed with battery life in mind.

In the local comparison below, LitePaseo used **91–95% less browser CPU**, **55–73%
less browser memory**, and downloaded **92% less compressed JavaScript/CSS** than
the official Paseo web UI. These are measured resource savings; battery runtime
and energy consumption were not measured.

## CPU and memory

Measured on **2026-11-12**, using LitePaseo commit
[`15d873c`](https://github.com/txchen/litepaseo/commit/15d873cabe526e50d153fe0d4baa26312614e1e5)
with **1 fps decorative animation** and **500 ms message batching**, against the
published **Paseo 0.15.4 production web UI**. Both ran in the same headless Chromium
on the same Linux laptop, with normal motion enabled.

Values are medians of **five runs per UI per scenario**. CPU ranges are min–max.
**100% CPU means one logical core**, not the whole machine. Memory is browser
process-tree PSS: shared memory is apportioned, and each run contributes its largest
two-second sample during measurement.

| Scenario | LitePaseo CPU | Paseo web CPU | LitePaseo memory | Paseo web memory |
|---|---:|---:|---:|---:|
| Running agent waiting, no new output | **1.5%** (1.2–1.7) | 17.8% (17.3–18.4) | **226 MiB** | 499 MiB |
| Continuous text, one growing paragraph | **10.1%** (9.4–10.5) | 114.7% (111.9–116.5) | **297 MiB** | 763 MiB |
| Growing code block, 200 → 800 lines | **6.4%** (5.7–6.6) | 140.7% (136.2–141.3) | **283 MiB** | 1,052 MiB |

Both streaming cases append exactly **600 chunks at 20 chunks/s over 30 seconds**,
including Chinese text. The waiting case keeps the agent running and its status
indicators active; it does not represent a dashboard with every task finished.
The code case is a rendering stress test. LitePaseo displays plain code blocks;
Paseo uses syntax highlighting. Both display the same complete source text, with
new output kept in view, but they do different amounts of presentation work.

The table measures the browser. LitePaseo's separate BFF added median **0.03% / 0.64%
/ 0.68%** of one core for waiting / text / code. The real daemon's CPU is also
recorded separately. This comparison does not include actual model execution.

Sources: [waiting and text results](../benchmarks/runs/2026-11-12T17-33-56.747Z-comparison/summary.md),
[code results](../benchmarks/runs/2026-11-12T17-52-40.273Z-comparison/summary.md).
Headline reductions use the unrounded medians; per-pair reductions and full ranges
are available in the corresponding `summary.json` files.

## Smaller downloads

The browser fetched these JavaScript and CSS resources while opening a conversation.
**LitePaseo's deferred Markstream renderer is included**, so this is not just a
comparison of its small initial entry script against Paseo's complete application.

| Loaded JS + CSS | LitePaseo | Paseo web | Reduction |
|---|---:|---:|---:|
| Compressed HTTP response bodies | **290 KiB** | 3,764 KiB | 92% |
| Decoded source | **1.08 MiB** | 22.85 MiB | 95% |

These are actual resource response sizes from fresh browser profiles, excluding
HTML, fonts, images, headers and conversation traffic. They describe the tested
conversation route, not every optional feature or the npm installation size.
[Resource entries and raw counters](../benchmarks/runs/2026-11-12T17-33-56.747Z-comparison/raw-counters.json)
include the fetched file names and byte counts.

## The tradeoff: fewer updates, lower CPU

LitePaseo deliberately avoids rendering every incoming chunk. Its
[status animation clock](../src/web/motion-clock.ts) advances once per second;
[message updates](../src/server/timeline-view.ts) are batched every 500 ms.
The 1 fps setting applies to persistent decorative animation, not to the entire
page or to keyboard input. Its [Markdown configuration](../src/web/MarkdownMessage.vue)
also disables typewriter effects and uses simplified code blocks.

Batching adds visible waiting time. The benchmark records **every chunk's** time
from provider emission until its text appears in the DOM, including the daemon,
transport and batching. The following values are medians of each run's p95:

| Output | LitePaseo p95 | Paseo web p95 |
|---|---:|---:|
| Plain text | 567 ms | **142 ms** |
| Code | 575 ms | **281 ms** |

Paseo showed incoming text sooner in these tests. LitePaseo used substantially less
CPU while updating about twice per second. These timings are DOM observations,
not physical screen-paint or keyboard-response measurements. Lower average CPU
also does not guarantee an absence of occasional long tasks; those are recorded
in the raw data.

## What the comparison establishes

The result supports LitePaseo's lightweight, battery-conscious design: the tested
browser has less CPU work to do, a smaller memory footprint, and fewer frontend
bytes to download. **A 91% CPU reduction does not mean 91% less battery drain.**
Energy counters were unreadable on this machine, so watts, joules and additional
hours of battery life remain unmeasured.

The test machine was a Core Ultra 7 256V laptop with 8 logical CPUs and 15.2 GiB RAM,
on AC power with the `powersave` governor, Linux `7.2.13-200.fc44.x86_64`, Node
`26.12.1` and headless Chromium `158.0.8127.18`, at 1280 × 900. Headless software
rendering is not a substitute for a GPU-accelerated desktop or phone battery test.
The host was shared and temperature was not controlled; these short runs do not
establish long-term memory behavior or performance for every workload.

Each run used a fresh isolated **real Paseo daemon**, its deterministic mock-provider
extension point, and a fresh browser profile. The official UI used WebSocket;
LitePaseo used its normal SDK-backed BFF and HTTP/SSE. Both frontends were production
builds, plugins were off, and there was one workspace and one agent. After a
10-second warmup, each measurement covered 30 seconds plus at least one second
of drain, waiting for final output before taking final counters. Paired A/B order
alternated. Servers ran locally and their counters were separated from the browser.

All **30 reported runs** passed complete rendered-text equality after Markdown
fence/whitespace normalization, ordered-marker checks and page-error checks.
An earlier 1,000-line code fixture grew beyond Paseo's
[32,000-character rendering cap](https://github.com/getpaseo/paseo/blob/v0.15.4/packages/app/src/components/assistant-message-render-limit.web.ts).
That incomplete pair was excluded, then replaced by five pairs using the smaller
code fixture above. The [excluded case and exact capped-prefix verification](../benchmarks/runs/2026-11-12T17-33-56.747Z-comparison/excluded-code-case.json)
are retained; no performance saving is calculated from missing output.

See [benchmark methodology and reproduction commands](../benchmarks/README.md)
for the runner, per-repetition CSVs, raw samples, per-chunk timings, source and
production-build hashes. The earlier LitePaseo-only tuning experiments are kept
in the [historical optimization log](../benchmarks/legacy-baseline.md).
