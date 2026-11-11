| Scenario | Runs passed | Cold ready ms | Browser CPU % | BFF + fixture CPU % | Browser peak PSS MiB | Sampled p95 ms | Max message rows |
|---|---:|---:|---:|---:|---:|---:|---:|
| catalog-100 | 3/3 | 259 | 16.4 | 0.1 | 227 | — | 60 |
| catalog-1000 | 3/3 | 334 | 16.7 | 0.2 | 239 | — | 60 |
| catalog-10000 | 3/3 | 660 | 18.7 | 0.2 | 299 | — | 60 |
| idle | 1/1 | 340 | 17.1 | 0.1 | 287 | — | 60 |
| plain | 3/3 | 338 | 34.7 | 1.4 | 299 | 68 | 66 |
| markdown-large | 3/3 | 331 | 111.6 | 0.9 | 641 | 177 | 61 |
| eight-clients | 3/3 | 608 | 267.6 | 2.2 | 1592 | 69 | 66 |
| history-expanded | 3/3 | 325 | 40.2 | 1.3 | 431 | 66 | 2066 |
| directory-churn | 3/3 | 688 | 24 | 0.9 | 297 | — | 60 |
| hidden-signal | 1/1 | 335 | 17.5 | 0.6 | 294 | — | 60 |
| soak | 1/1 | 304 | 66.6 | 1.3 | 474 | 68 | 150 |
