# Markstream integration validation

2026-11-11. Markstream was adopted after reviewing the tradeoffs below.
Assistant messages use `markstream-vue@2.0.25`, loaded asynchronously after sign-in.
The small built-in `markdown.ts` renderer shows messages until Markstream has loaded.

## Configuration

- Full accumulated message text, chat mode, raw HTML escaped.
- Smooth streaming, typewriter, fade, code streaming, internal batch mounting,
  viewport deferral and node virtualization disabled. The BFF still flushes every
  500 ms; application status animation still advances twice per second.
- Fenced code renders through a scoped custom `code_block` (`CodeBlock.vue`): a plain
  `<pre>` with highlight.js tokens for common languages, without line numbers or header
  controls. Optional editor, diagram and KaTeX runtimes are not enabled. This does not add rich
  diagrams or mathematical typesetting.
- The application still owns the 150-message history window. Row identity includes
  host/agent, timeline epoch and sequence. Markstream owns nodes within a message.
- Earlier rows are final once a later row exists (the projection only appends text
  to adjacent compatible rows). The tail is final only with a live directory,
  connected host and explicit `turnActive: false`. Unknown state, initialization,
  active turns and permission waits do not imply completion. A temporary gap
  between SSE batches does not finalize the parser.
- Markstream follows the application's explicit/system light and dark choice.
  Async layout growth follows the live tail only while the reader stays at the
  bottom. History browsing and manual scrolling keep their position.
- The existing CSP remains in force, including its restriction on remote images.

## Checks

Validation passed: TypeScript checking, production build, 65 unit tests, and the
production browser suite.

The production browser suite covers headings, reference links, Unicode code,
HTML escaping, stable paragraph DOM during an append, replacement/truncation,
system theme changes, following a growing code block and not stealing manual
scroll position, plus the existing host switching, permission, composer, PWA,
authentication and mobile checks. A server test checks explicit turn activity,
including initialization and a pending permission with an active turn.

## Full application measurements

[Raw run](../benchmarks/runs/2026-11-11T22-18-25.725Z/results.json): three fresh
browser/BFF repetitions per scenario, 30 seconds each, real production frontend
and HTTP/SSE, deterministic daemon doubles. CPU is summed browser process CPU
as a percentage of one logical core, not battery drain. All nine runs passed.

| Scenario | Browser CPU, median | Long tasks per run | Max mounted rows |
| --- | ---: | ---: | ---: |
| Plain stream | 6.4% | 0 | 66 |
| Growing 12,000-line code block | 31.0% | 61 | 61 |
| History after 20 earlier pages | 3.3% | 0 | 150 |

These measurements preceded the final theme binding and async-layout follow
handler. The run includes the precise product patch, new component source and
built-asset hashes for that measured revision. Final-build smoke results were
recorded separately (smoke output is not kept in Git);
do not interpret a two-second smoke as a new CPU benchmark.

Content checks now compare the controlled fixtures' plain text/code body against
source, normalizing whitespace, instead of expecting the previous renderer's HTML
text (including its language label). History checks also verify scroll anchors,
forward/backward navigation, frozen historical content and return to live output.
This is not a general Markdown conformance test.

The prior full-app baseline was approximately 4.9% / 28.1% / 2.2% for these three
scenarios. This integration is not a universal CPU optimization. The isolated
multi-paragraph probe demonstrated useful DOM reuse and lower update cost; the
production browser test now verifies that reuse survives the application wrapper.
A huge single code block remains expensive and requires separate optimization.
The dependency also increases bundle size: the shared renderer chunk is about
702 kB minified / 227 kB gzip, beyond the previous small renderer.
