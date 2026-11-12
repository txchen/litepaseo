import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const dir = resolve(process.argv[2]);
const read = file => JSON.parse(readFileSync(join(dir, file), 'utf8'));
const manifest = read('manifest.json'), allResults = read('results.json');
const selectedScenarios = process.argv.find(arg => arg.startsWith('--scenarios='))?.slice('--scenarios='.length).split(',');
const results = selectedScenarios ? allResults.filter(r => selectedScenarios.includes(r.scenario)) : allResults;
assert.ok(results.every(r => r.passed), 'Do not summarize a run with failures');
const median = values => { const a = [...values].sort((a, b) => a - b); return (a[Math.floor((a.length - 1) / 2)] + a[Math.ceil((a.length - 1) / 2)]) / 2; };
const stats = values => ({ median: median(values), min: Math.min(...values), max: Math.max(...values) });
const raw = [];
const savedRaw = existsSync(join(dir, 'raw-counters.json')) ? read('raw-counters.json') : [];
for (const r of results) {
  const saved = savedRaw.find(x => x.name === r.name);
  const d = existsSync(join(dir, r.name, 'diagnostics.json')) ? read(`${r.name}/diagnostics.json`) : saved;
  const assets = d.resources.filter(r => /\.(js|css)$/.test(r.name));
  r.jsCssEncodedBytes = assets.reduce((n, r) => n + r.encodedBodySize, 0);
  r.jsCssDecodedBytes = assets.reduce((n, r) => n + r.decodedBodySize, 0);
  const events = saved?.events ?? read(`${r.name}/expected.json`).ticks.map(t => ({ ...t, domObservedAt: d.firstSeen[String(t.index).padStart(5, '0')] ?? null }));
  assert.ok(events.every(e => e.domObservedAt !== null), 'All deltas need DOM observation');
  assert.ok(events.every(e => e.domObservedAt >= e.at), 'DOM observation must not precede provider emission');
  assert.equal(events.length, r.generated);
  const samples = saved?.samples ?? read(`${r.name}/samples.json`);
  if (events.length) assert.ok(events.at(-1).domObservedAt <= samples.at(-1).epochMs, 'Final render must precede final CPU counters');
  raw.push({ name: r.name, samples, events, longTasks: d.longTasks, resources: d.resources });
}
const metrics = ['browserCpuPercent', 'browserPeakPssMiB', 'heapPeakMiB', 'readyMs', 'latencyP50', 'latencyP95', 'longTasks', 'longTaskMs', 'bffCpuPercent', 'daemonCpuPercent', 'jsCssEncodedBytes', 'jsCssDecodedBytes'];
const groups = [], comparisons = [];
for (const scenario of [...new Set(results.map(r => r.scenario))]) {
  for (const variant of ['litepaseo', 'paseo']) {
    const rows = results.filter(r => r.scenario === scenario && r.variant === variant);
    assert.equal(rows.length, manifest.repetitions);
    groups.push({ scenario, variant, n: rows.length, ...Object.fromEntries(metrics.filter(k => rows.every(r => r[k] !== null)).map(k => [k, stats(rows.map(r => r[k]))])) });
  }
  const pairs = Array.from({ length: manifest.repetitions }, (_, i) => {
    const a = results.find(r => r.scenario === scenario && r.variant === 'litepaseo' && r.rep === i + 1);
    const b = results.find(r => r.scenario === scenario && r.variant === 'paseo' && r.rep === i + 1);
    assert.equal(a.expectedHash, b.expectedHash); assert.equal(a.renderedNormalizedHash, b.renderedNormalizedHash);
    assert.equal(a.generated, b.generated);
    return { rep: i + 1, cpuReductionPercent: (1 - a.browserCpuPercent / b.browserCpuPercent) * 100, pssReductionPercent: (1 - a.browserPeakPssMiB / b.browserPeakPssMiB) * 100 };
  });
  comparisons.push({ scenario, pairs, pairedCpuReductionPercent: stats(pairs.map(r => r.cpuReductionPercent)), pairedPssReductionPercent: stats(pairs.map(r => r.pssReductionPercent)) });
}
writeFileSync(join(dir, 'summary.json'), JSON.stringify({ groups, comparisons, excluded: allResults.filter(r => !results.includes(r)).map(r => ({ name: r.name, passed: r.passed, reason: 'Explicit scenario selection; see report for fixture exclusion rationale.' })) }, null, 2));
writeFileSync(join(dir, 'raw-counters.json'), JSON.stringify(raw));
writeFileSync(join(dir, 'results.json'), JSON.stringify(allResults, null, 2));
const columns = ['scenario', 'rep', 'variant', 'wallSeconds', ...metrics, 'generated', 'eventSpanMs', 'passed'];
writeFileSync(join(dir, 'counters.csv'), columns.join(',') + '\n' + results.map(r => columns.map(k => r[k] ?? '').join(',')).join('\n') + '\n');
const fmt = (s, digits = 1) => s ? `${s.median.toFixed(digits)} (${s.min.toFixed(digits)}–${s.max.toFixed(digits)})` : '—';
writeFileSync(join(dir, 'summary.md'), '# Official web UI comparison\n\nMedians (min–max), five repetitions per variant. CPU: 100% = one core. PSS: sampled peaks in MiB. Latency: per-run p95 provider-to-DOM, ms. No energy measurement.\n\n| Scenario | UI | Browser CPU % | Browser PSS MiB | p95 ms | BFF CPU % | Daemon CPU % |\n|---|---|---:|---:|---:|---:|---:|\n' + groups.map(g => `| ${g.scenario} | ${g.variant} | ${fmt(g.browserCpuPercent)} | ${fmt(g.browserPeakPssMiB, 0)} | ${fmt(g.latencyP95, 0)} | ${fmt(g.bffCpuPercent)} | ${fmt(g.daemonCpuPercent)} |`).join('\n') + '\n');
for (const g of groups) console.log(g.scenario, g.variant, 'CPU', g.browserCpuPercent, 'PSS', g.browserPeakPssMiB, 'p95', g.latencyP95);
