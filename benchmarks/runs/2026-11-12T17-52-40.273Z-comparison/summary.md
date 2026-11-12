# Official web UI comparison

Medians (min–max), five repetitions per variant. CPU: 100% = one core. PSS: sampled peaks in MiB. Latency: per-run p95 provider-to-DOM, ms. No energy measurement.

| Scenario | UI | Browser CPU % | Browser PSS MiB | p95 ms | BFF CPU % | Daemon CPU % |
|---|---|---:|---:|---:|---:|---:|
| code | litepaseo | 6.4 (5.7–6.6) | 283 (283–285) | 575 (574–576) | 0.7 (0.6–0.7) | 1.5 (1.4–2.9) |
| code | paseo | 140.7 (136.2–141.3) | 1052 (1005–1067) | 281 (276–285) | 0.0 (0.0–0.0) | 1.8 (1.2–2.0) |
