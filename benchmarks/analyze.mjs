import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const folder = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node benchmarks/analyze.mjs benchmarks/runs/<run>');
const results = JSON.parse(readFileSync(join(folder, 'results.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
const median = values => {
  const a = values.filter(x => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!a.length) return null;
  return (a[Math.floor((a.length - 1) / 2)] + a[Math.ceil((a.length - 1) / 2)]) / 2;
};
const spread = values => ({ median: median(values), min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null });
const mib = n => n / 1024 / 1024;
const groups = new Map();
for (const result of results) {
  const group = groups.get(result.spec.name) ?? [];
  group.push(result); groups.set(result.spec.name, group);
}
const summary = [...groups].map(([scenario, all]) => {
  const good = all.filter(r => r.passed);
  return { scenario, repetitions: all.length, passed: good.length,
    coldReadyMs: spread(good.map(r => median(r.coldReadyMs))),
    browserCpuPct: spread(good.map(r => r.browserCpuSeconds / r.wallSeconds * 100)),
    bffFixtureCpuPct: spread(good.map(r => r.bffFixtureCpuSeconds / r.wallSeconds * 100)),
    browserPeakPssMiB: spread(good.map(r => mib(r.browserPeakPss))),
    bffPeakRssMiB: spread(good.map(r => mib(r.bffPeakRss))),
    // Median of per-repetition p95s, not a pooled percentile.
    sampledLatencyP95Ms: median(good.map(r => r.latency.p95)),
    maxRows: Math.max(...good.map(r => r.maxTimelineRowsPerClient)),
    maxSidebarRows: Math.max(...good.map(r => r.maxSidebarRowsPerClient)),
    longTasks: median(good.map(r => r.longTasks)),
  };
});
writeFileSync(join(folder, 'summary.json'), JSON.stringify({ manifest: { commit: manifest.commit, chromium: manifest.chromium }, summary }, null, 2));
const fields = ['scenario', 'repetition', 'wall_seconds', 'browser_cpu_seconds', 'bff_fixture_cpu_seconds', 'browser_peak_pss_bytes', 'bff_peak_rss_bytes', 'sampled_latency_p95_ms', 'generated_events', 'final_visible_suffix_equal', 'energy_joules'];
const rows = results.map(r => [r.spec.name, r.spec.rep, r.wallSeconds, r.browserCpuSeconds, r.bffFixtureCpuSeconds, r.browserPeakPss, r.bffPeakRss, r.latency?.p95, r.generated, r.correctness?.every(c => c.equal), null]);
writeFileSync(join(folder, 'counters.csv'), [fields, ...rows].map(row => row.map(v => v ?? '').join(',')).join('\n') + '\n');
const round = (n, places = 1) => n == null ? '—' : Number(n.toFixed(places));
const table = ['| Scenario | Runs passed | Cold ready ms | Browser CPU % | BFF + fixture CPU % | Browser peak PSS MiB | Sampled p95 ms | Max message rows |',
  '|---|---:|---:|---:|---:|---:|---:|---:|',
  ...summary.map(r => `| ${r.scenario} | ${r.passed}/${r.repetitions} | ${round(r.coldReadyMs.median, 0)} | ${round(r.browserCpuPct.median)} | ${round(r.bffFixtureCpuPct.median)} | ${round(r.browserPeakPssMiB.median, 0)} | ${round(r.sampledLatencyP95Ms, 0)} | ${r.maxRows} |`)];
writeFileSync(join(folder, 'summary.md'), table.join('\n') + '\n');
console.log(table.join('\n'));

// One-minute memory windows expose GC sawteeth without asserting that growth is a leak.
const soakDir = readdirSync(folder).find(name => name === 'soak-r1');
if (soakDir) {
  const samples = readFileSync(join(folder, soakDir, 'samples.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  const start = samples[0].bff.at;
  const windows = [];
  for (let minute = 0; minute < 10; minute++) {
    const batch = samples.filter(s => s.bff.at - start >= minute * 60000 && s.bff.at - start < (minute + 1) * 60000);
    if (!batch.length) continue;
    windows.push({ minute: minute + 1, browserMedianPssMiB: median(batch.map(s => mib(s.browser.pss))),
      browserHeapMiB: median(batch.map(s => mib(s.views.reduce((n, v) => n + v.heapUsed, 0)))),
      bffMedianRssMiB: median(batch.map(s => mib(s.bff.memory.rss))),
      fixtureTextMiB: mib(batch.at(-1).bff.fixtureLiveTextBytes),
      fixtureRows: batch.at(-1).bff.fixtureLiveRows,
      maxDomRows: Math.max(...batch.flatMap(s => s.views.map(v => v.rows))) });
  }
  writeFileSync(join(folder, 'soak-memory.json'), JSON.stringify(windows, null, 2));
  console.log('Soak minute windows:', JSON.stringify(windows));
}
