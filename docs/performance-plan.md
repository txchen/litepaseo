# Reproducible CPU and energy validation

Status: experiment specification only; no results or promised savings.

## Comparisons

Compare production builds of official Paseo web and LitePaseo on the same browser/device, plus official native separately if available. Record exact commits, browser/OS/Node versions, build flags, enabled plugins, daemon/provider versions, BFF placement, hardware, power mode, display brightness, refresh rate and thermal state. Run plugins off first, then a separately reported matched plugin scenario. Never compare different amounts of rendered content silently.

Use two layers. A deterministic fixture harness replays the same timestamped semantic timeline into each client's normal ingestion path (version-pinned adapters, no real model calls). Capture/sanitize one fixture and publish its hash, event count, bytes, durations and adaptation code. Validate equal final text, tool rows and approvals. This measures rendering/ingestion, not transport parity. A second two-daemon end-to-end run verifies transport and recovery with deterministic provider output where supported. If a mock provider cannot be installed without modifying official code, disclose that limitation and keep real-model runs exploratory because outputs vary.

Scenarios: 10-minute connected idle; 5-minute plain-text stream; 5-minute growing code/Markdown stream; large completed history plus new output; simultaneous output from two hosts; hidden tab for 5 minutes then foreground; one-host disconnect/reconnect; approval during streaming. Fix event cadence, text size, history size and exact scripted visibility/scroll/input actions in the fixture manifest. Include a long unfinished code fence and non-ASCII input.

## Procedure

1. Create a clean browser profile with extensions disabled. Fix screen/network/power conditions and background workloads. Place daemons off the measured laptop for the primary browser experiment.
2. Warm each production build for two minutes. Randomize A/B order in paired runs; run at least five pairs per scenario. Cool between runs to comparable temperature. Do not profile with DevTools open in the primary energy run.
3. Collect cumulative process CPU seconds before/after for the entire browser process tree, BFF and daemon separately. Report CPU seconds per wall second (one full core = 1), RSS/peak memory, network bytes, flush/parse/render counts, event-loop delay and browser long tasks. Account for shared browser processes consistently, preferably with only the test profile running.
4. Linux: use `pidstat`/process accounting for CPU, `perf stat` where available for context switches; use supported RAPL counters or an external power meter for joules. RAPL measures package domains, not process energy or whole-device energy. macOS: use supported Instruments/powermetrics workflows, separating Energy Impact scores from joules. Record tool versions, sampling interval, permissions and unsupported counters. Context switches are not interchangeable with hardware wakeups.
5. Measure idle baseline with the same instrumentation. Report raw and baseline-adjusted energy, measurement domain and elapsed time. For battery drain, use longer fixed-duration repeated trials with fixed initial charge bands; short percentage drops are too coarse. Use an external whole-device meter when practical, accounting for charging behavior.
6. Use the intended server-hosted BFF for the primary comparison; optionally run locally as a diagnostic. Report laptop energy and remote BFF CPU/energy separately; only sum comparable measured domains without double counting. Unknown daemon/remote energy stays unknown.
7. Record receipt-to-visible latency distribution, approval latency, final-state correctness, missing/duplicate rows and recovery time. A lower CPU value with lost events is a failed run.

Store `benchmarks/<run-id>/manifest.json`, fixture hashes, raw counter CSV, correctness results and analysis script. Suggested CSV fields: variant, repetition, scenario, wall_seconds, browser_cpu_seconds, bff_cpu_seconds, daemon_cpu_seconds, peak_rss_bytes, energy_joules, energy_domain, visible_latency_p50_ms, visible_latency_p95_ms, final_state_equal. Use null for unavailable measurements, never zero.

Report paired differences, medians, spread and confidence intervals with all failures disclosed. Tune batching at 250/750/1500 ms, holding all else constant. Compare Markstream with plain text and a baseline renderer, separately toggling highlighting/diagrams and history windowing to identify costs. Set an acceptance threshold only after establishing baseline variance and a user-acceptable latency budget. Source observations and renderer marketing are not measured performance evidence.
