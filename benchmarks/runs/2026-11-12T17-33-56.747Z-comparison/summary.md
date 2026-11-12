# Official web UI comparison

Medians (min–max), five repetitions per variant. CPU: 100% = one core. PSS: sampled peaks in MiB. Latency: per-run p95 provider-to-DOM, ms. No energy measurement.

| Scenario | UI | Browser CPU % | Browser PSS MiB | p95 ms | BFF CPU % | Daemon CPU % |
|---|---|---:|---:|---:|---:|---:|
| idle | litepaseo | 1.5 (1.2–1.7) | 226 (222–227) | — | 0.0 (0.0–0.0) | 0.4 (0.3–0.4) |
| idle | paseo | 17.8 (17.3–18.4) | 499 (498–500) | — | 0.0 (0.0–0.0) | 0.4 (0.3–0.4) |
| plain | litepaseo | 10.1 (9.4–10.5) | 297 (296–299) | 567 (566–568) | 0.6 (0.6–0.6) | 1.5 (1.4–2.7) |
| plain | paseo | 114.7 (111.9–116.5) | 763 (758–767) | 142 (138–161) | 0.0 (0.0–0.0) | 1.4 (1.4–2.4) |
