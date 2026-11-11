import { chromium } from '@playwright/test';
import { fork, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { cpus, totalmem, release, platform } from 'node:os';
import { createHash } from 'node:crypto';
import { renderMarkdown } from '../src/web/markdown.ts';

const smoke = process.argv.includes('--smoke');
const motion = process.argv.includes('--motion');
const out = resolve(process.env.BENCH_OUT ?? `benchmarks/runs/${new Date().toISOString().replaceAll(':', '-')}${smoke ? '-smoke' : motion ? '-motion' : ''}`);
mkdirSync(out, { recursive: true });
mkdirSync(join(out, 'harness'), { recursive: true });
for (const file of ['run.mjs', 'fixture-server.mjs']) copyFileSync(join('benchmarks', file), join(out, 'harness', file));
const read = path => { try { return readFileSync(path, 'utf8').trim(); } catch { return null; } };
const hash = value => createHash('sha256').update(value).digest('hex');
const ticksPerSecond = Number(execFileSync('getconf', ['CLK_TCK']).toString());
const pageSize = Number(execFileSync('getconf', ['PAGESIZE']).toString());
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const manifest = {
  startedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim(),
  sourceStatus: execFileSync('git', ['status', '--short']).toString(), node: process.version, os: `${platform()} ${release()}`,
  cpu: cpus()[0].model, logicalCpus: cpus().length, totalMemory: totalmem(), governor: read('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor'),
  acOnline: read('/sys/class/power_supply/ADP1/online'), batteryStatus: read('/sys/class/power_supply/BAT0/status'), loadavg: read('/proc/loadavg'),
  energy: { available: false, reason: 'Energy counters are not sampled by this harness; no joule or battery-drain claims.' },
  harness: { server: hash(readFileSync('benchmarks/fixture-server.mjs')), runner: hash(readFileSync('benchmarks/run.mjs')) },
  methodology: 'Production frontend over real loopback HTTP/SSE, actual BFF/HostDirectory/TimelineView source loaded with Node type stripping; SDK facades are deterministic in-process doubles. BFF CPU/memory includes fixture generation/logging, not real daemon/network/provider costs. Fresh Chromium process and BFF per repetition. Browser CPU sums sampled /proc process-tree counters; RSS double-counts shared pages, PSS is also collected. Latency is event-generation to the rAF following a DOM mutation, sampled <=1Hz, not a physical paint/energy measurement. All clients use separate contexts in one headless Chromium process. Samples every 2s. No official-client comparison. Shared host, plugged in, powersave governor, no controlled thermal/brightness conditions.',
};
const cases = [];
for (const sessions of [100, 1000, 10000]) for (let rep = 1; rep <= (smoke ? 1 : 3); rep++) cases.push({ name: 'catalog-' + sessions, sessions, duration: smoke ? 1 : 2, rep, clients: 1, rate: 0 });
if (!smoke) cases.push({ name: 'idle', sessions: 1000, duration: 60, rep: 1, clients: 1, rate: 0 });
for (const scenario of [
  { name: 'plain', sessions: 1000, clients: 1, rate: 20, rowEvery: 100 },
  { name: 'markdown-large', sessions: 1000, clients: 1, rate: 20, kind: 'markdown', prefillLines: 12000, rowEvery: 0 },
  { name: 'eight-clients', sessions: 10000, clients: 8, rate: 20, rowEvery: 100 },
  { name: 'history-expanded', sessions: 1000, clients: 1, rate: 20, rowEvery: 100, olderPages: 20 },
  { name: 'directory-churn', sessions: 10000, clients: 1, rate: 0, directoryRate: 50 },
]) for (let rep = 1; rep <= (smoke ? 1 : 3); rep++) cases.push({ ...scenario, duration: smoke ? 2 : 30, rep });
cases.push({ name: 'hidden-signal', sessions: 1000, duration: smoke ? 3 : 60, rep: 1, clients: 1, rate: 20, rowEvery: 100, hidden: true });
if (!smoke) cases.push({ name: 'soak', sessions: 1000, duration: 600, rep: 1, clients: 2, rate: 20, rowEvery: 3 });
if (motion) {
  cases.length = 0;
  // Alternate order across pairs to reduce simple order/thermal bias.
  for (let rep = 1; rep <= 3; rep++) for (const reduced of (rep % 2 ? [false, true] : [true, false])) {
    cases.push({ name: reduced ? 'idle-motion-reduced' : 'idle-motion-default', sessions: 1000,
      duration: 20, rep, clients: 1, rate: 0, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  }
}
const onlyScenario = process.argv.find(arg => arg.startsWith('--scenario='))?.split('=')[1];
if (onlyScenario) {
  const selected = cases.filter(spec => spec.name === onlyScenario);
  if (!selected.length) throw new Error('Unknown scenario: ' + onlyScenario);
  cases.splice(0, cases.length, ...selected);
}
manifest.cases = cases;
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('Artifacts:', out);

function processTree(root, ledger) {
  const visit = [root], seen = new Set();
  let rss = 0, pss = 0, pssAvailable = true;
  while (visit.length) {
    const pid = visit.pop(); if (seen.has(pid)) continue;
    const stat = read(`/proc/${pid}/stat`); if (!stat) continue;
    seen.add(pid);
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
    const key = `${pid}:${fields[19]}`;
    ledger.set(key, (Number(fields[11]) + Number(fields[12])) / ticksPerSecond);
    rss += Number(fields[21]) * pageSize;
    const memory = read(`/proc/${pid}/smaps_rollup`);
    const match = memory?.match(/^Pss:\s+(\d+) kB/m);
    if (match) pss += Number(match[1]) * 1024; else pssAvailable = false;
    // Linux children files are per-thread. Chromium starts its network service from
    // a non-main thread; reading only task/<pid>/children silently omits that process.
    try {
      for (const tid of readdirSync(`/proc/${pid}/task`)) {
        const children = read(`/proc/${pid}/task/${tid}/children`);
        if (children) visit.push(...children.split(/\s+/).map(Number));
      }
    } catch { /* A process may exit during sampling. */ }
  }
  return { cpuSeconds: [...ledger.values()].reduce((a, b) => a + b, 0), rss, pss: pssAvailable ? pss : null, processes: seen.size, processIds: [...seen] };
}
function instrumentation() {
  window.__bench = { longTasks: 0, longTaskMs: 0, latencies: [], last: '', lastSample: 0 };
  try { new PerformanceObserver(list => { for (const e of list.getEntries()) { window.__bench.longTasks++; window.__bench.longTaskMs += e.duration; } }).observe({ type: 'longtask', buffered: true }); } catch {}
  const observer = new MutationObserver(() => {
    const b = window.__bench;
    if (performance.now() - b.lastSample < 1000 || document.hidden) return;
    b.lastSample = performance.now();
    requestAnimationFrame(() => {
      const text = document.querySelector('.timeline-inner > .row:last-child')?.textContent?.slice(-180) ?? '';
      const matches = [...text.matchAll(/LP(h[01]):(\d+):(\d+)/g)];
      const match = matches.at(-1);
      if (match && match[0] !== b.last) { b.last = match[0]; b.latencies.push({ sequence: Number(match[2]), ms: Date.now() - Number(match[3]) }); }
    });
  });
  document.addEventListener('DOMContentLoaded', () => observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true }));
}
const results = [];
let failures = 0;
for (const spec of cases) {
  const name = `${spec.name}-r${spec.rep}`, folder = join(out, name);
  mkdirSync(folder, { recursive: true });
  const config = { history: 20000, kind: 'plain', ...spec, out: folder };
  writeFileSync(join(folder, 'config.json'), JSON.stringify(config, null, 2));
  console.log('START', name);
  let child, browserServer, browser, rpc, stopTimer;
  const errors = [], samples = [], cold = [], latency = [], contexts = [], pages = [], cdps = [], ledger = new Map();
  const rpcPending = new Map(); let serial = 0;
  try {
    child = fork(resolve('benchmarks/fixture-server.mjs'), [], { env: { ...process.env, BENCH_CONFIG: JSON.stringify(config) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.on('data', data => appendFileSync(join(folder, 'server-output.txt'), data));
    child.stderr.on('data', data => appendFileSync(join(folder, 'server-output.txt'), data));
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture startup timed out')), 30000);
      child.on('message', message => {
        if (message.type === 'ready') { clearTimeout(timer); resolve(message); }
        else if (rpcPending.has(message.requestId)) { const pending = rpcPending.get(message.requestId); rpcPending.delete(message.requestId); message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result); }
      });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Fixture exited: ' + code)); for (const entry of rpcPending.values()) entry.reject(new Error('Fixture exited')); });
    });
    rpc = (cmd, args = {}) => new Promise((resolve, reject) => {
      const requestId = ++serial;
      const timer = setTimeout(() => { rpcPending.delete(requestId); reject(new Error('Fixture RPC timeout: ' + cmd)); }, 30000);
      rpcPending.set(requestId, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      child.send({ cmd, requestId, ...args });
    });
    browserServer = await chromium.launchServer({ headless: true });
    browser = await chromium.connect(browserServer.wsEndpoint());
    if (!manifest.chromium) { manifest.chromium = browser.version(); writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2)); }
    for (let i = 0; i < spec.clients; i++) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: spec.reducedMotion ?? 'no-preference' }); contexts.push(context);
      await context.addInitScript(instrumentation);
      const login = await context.request.post(ready.url + '/api/login', { data: { token: 'benchmark-token' } });
      if (!login.ok()) throw new Error('Fixture login failed');
      const page = await context.newPage(); pages.push(page);
      page.on('pageerror', e => errors.push(e.message));
      const cdp = await context.newCDPSession(page); cdps.push(cdp); await cdp.send('Performance.enable');
      const started = performance.now();
      await page.goto(ready.url + `/?session=h${i % 2}:a0`);
      await page.waitForFunction(count => Number(document.querySelector('.tabs .count')?.textContent) === count && document.querySelectorAll('.timeline-inner > .row').length === 60, spec.sessions);
      cold.push(performance.now() - started);
      if (await page.evaluate(() => document.hidden)) throw new Error('Expected a visible headless client');
    }
    let historyLoadMs = null;
    if (spec.olderPages) {
      const started = performance.now();
      for (let i = 0; i < spec.olderPages; i++) {
        await pages[0].getByRole('button', { name: 'Show earlier messages' }).click();
        await pages[0].waitForFunction(count => document.querySelectorAll('.timeline-inner > .row').length >= count, 60 + (i + 1) * 100);
      }
      historyLoadMs = performance.now() - started;
    }
    // Let startup layout settle. This is a short baseline, not the full 2-minute energy protocol.
    await sleep(smoke ? 200 : 2000);
    for (const page of pages) await page.evaluate(() => { window.__bench.longTasks = 0; window.__bench.longTaskMs = 0; window.__bench.latencies = []; window.__bench.lastSample = 0; });
    if (spec.hidden) await pages[0].evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    const sample = async () => {
      const bff = await rpc('metrics');
      const browserStats = processTree(browserServer.process().pid, ledger);
      const views = await Promise.all(pages.map(async (page, i) => {
        const metrics = Object.fromEntries((await cdps[i].send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
        const view = await page.evaluate(() => ({ rows: document.querySelectorAll('.timeline-inner > .row').length,
          sidebarRows: document.querySelectorAll('.session-row').length, domNodes: document.getElementsByTagName('*').length,
          longTasks: window.__bench.longTasks, longTaskMs: window.__bench.longTaskMs,
          latencies: window.__bench.latencies.splice(0), hidden: document.hidden }));
        for (const value of view.latencies) latency.push({ client: i, ...value });
        delete view.latencies;
        return { ...view, heapUsed: metrics.JSHeapUsedSize, taskSeconds: metrics.TaskDuration, layoutSeconds: metrics.LayoutDuration };
      }));
      const record = { bff, browser: browserStats, views, loadavg: read('/proc/loadavg') };
      samples.push(record); appendFileSync(join(folder, 'samples.ndjson'), JSON.stringify(record) + '\n');
      return record;
    };
    await sample(); await rpc('start');
    // Stop generation independently of browser probes: a saturated renderer can delay CDP.
    const stopAtDeadline = new Promise((resolve, reject) => {
      stopTimer = setTimeout(() => rpc('stop').then(resolve, reject), spec.duration * 1000);
    });
    // A later probe failure can enter cleanup before this promise is awaited.
    void stopAtDeadline.catch(() => {});
    const started = performance.now(); let progress = 0;
    while (performance.now() - started < spec.duration * 1000) {
      await sleep(Math.min(2000, spec.duration * 1000 - (performance.now() - started)));
      await sample();
      if (performance.now() - started > progress + 30000) { progress += 30000; console.log('PROGRESS', name, Math.round((performance.now() - started) / 1000), 'seconds'); }
    }
    const stopped = await stopAtDeadline;
    let hiddenEnd = null, resumeMs = null;
    if (spec.hidden) {
      hiddenEnd = await rpc('metrics');
      const resumed = performance.now();
      await pages[0].evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
      await pages[0].waitForFunction(n => document.querySelector('.timeline-inner > .row:last-child')?.textContent?.includes(`:${n}:`), Math.floor(stopped.generated / 2), { timeout: 10000 });
      resumeMs = performance.now() - resumed;
    }
    await sleep(1000);
    const after = await sample();
    const correctness = [];
    for (let i = 0; i < pages.length; i++) {
      const actual = await pages[i].locator('.timeline-inner > .row').allTextContents();
      const expected = (await rpc('expected', { limit: actual.length }))['h' + (i % 2)];
      const html = expected.map(row => row.item.type === 'assistant_message' ? renderMarkdown(row.item.text) : null);
      const wanted = await pages[i].evaluate(({ expected, html }) => expected.map((row, j) => {
        if (html[j] === null) return row.item.text;
        const template = document.createElement('template'); template.innerHTML = html[j]; return template.content.textContent;
      }), { expected, html });
      correctness.push({ client: i, rows: actual.length, expectedHash: hash(JSON.stringify(wanted)), actualHash: hash(JSON.stringify(actual)), equal: JSON.stringify(actual) === JSON.stringify(wanted) });
    }
    const first = samples[0];
    const wall = (after.bff.at - first.bff.at) / 1000;
    const result = { name, spec, coldReadyMs: cold, historyLoadMs, resumeMs,
      wallSeconds: wall, browserCpuSeconds: after.browser.cpuSeconds - first.browser.cpuSeconds,
      bffFixtureCpuSeconds: ((after.bff.cpu.user + after.bff.cpu.system) - (first.bff.cpu.user + first.bff.cpu.system)) / 1e6,
      bffStartRss: first.bff.memory.rss, bffEndRss: after.bff.memory.rss, bffPeakRss: Math.max(...samples.map(s => s.bff.memory.rss)),
      browserStartPss: first.browser.pss, browserEndPss: after.browser.pss, browserPeakPss: Math.max(...samples.map(s => s.browser.pss ?? 0)),
      browserPeakSummedRss: Math.max(...samples.map(s => s.browser.rss)),
      browserHeapStart: first.views.map(v => v.heapUsed), browserHeapEnd: after.views.map(v => v.heapUsed),
      wireBytes: after.bff.bytes - first.bff.bytes, initialWireBytes: first.bff.bytes, generated: after.bff.generated,
      directoryChanges: after.bff.directoryChanges, eventLoop: after.bff.eventLoop,
      longTasks: after.views.reduce((n, v) => n + v.longTasks, 0), longTaskMs: after.views.reduce((n, v) => n + v.longTaskMs, 0),
      maxDomNodesPerClient: Math.max(...samples.flatMap(s => s.views.map(v => v.domNodes))),
      maxTimelineRowsPerClient: Math.max(...samples.flatMap(s => s.views.map(v => v.rows))),
      maxSidebarRowsPerClient: Math.max(...samples.flatMap(s => s.views.map(v => v.sidebarRows))),
      endDirectoryStreams: after.bff.streams, hiddenEnd, correctness, errors,
    };
    const sorted = latency.map(v => v.ms).sort((a,b) => a-b);
    result.latency = { samples: sorted.length, p50: sorted.length ? sorted[Math.floor((sorted.length - 1) * .5)] : null,
      p95: sorted.length ? sorted[Math.floor((sorted.length - 1) * .95)] : null, max: sorted.at(-1) ?? null };
    result.passed = errors.length === 0 && correctness.every(c => c.equal) && (!spec.hidden || hiddenEnd.streams === 0);
    if (!result.passed) failures++;
    await Promise.all(contexts.map(c => c.close()));
    await sleep(200);
    result.directoryStreamsAfterClose = (await rpc('metrics')).streams;
    if (result.directoryStreamsAfterClose !== 0) { result.passed = false; failures++; }
    writeFileSync(join(folder, 'latency.json'), JSON.stringify(latency));
    writeFileSync(join(folder, 'result.json'), JSON.stringify(result, null, 2));
    results.push(result); writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
    console.log('DONE', name, JSON.stringify({ pass: result.passed, coldMs: Math.round(cold[0]), browserCpuPct: Math.round(result.browserCpuSeconds / wall * 1000) / 10, bffCpuPct: Math.round(result.bffFixtureCpuSeconds / wall * 1000) / 10, latencyP95: result.latency.p95, rows: result.maxTimelineRowsPerClient }));
  } catch (error) {
    failures++; const failed = { name, spec, failed: error.stack, errors };
    writeFileSync(join(folder, 'failure.json'), JSON.stringify(failed, null, 2)); results.push(failed);
    writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2)); console.log('FAIL', name, error.message);
  } finally {
    clearTimeout(stopTimer);
    await browser?.close().catch(() => {}); await browserServer?.close().catch(() => {});
    if (child?.connected && rpc) await rpc('shutdown').catch(() => child.kill('SIGTERM'));
    else child?.kill('SIGTERM');
    const eventFile = join(folder, 'events.ndjson');
    if (existsSync(eventFile)) writeFileSync(join(folder, 'events.sha256'), hash(readFileSync(eventFile)) + '\n');
  }
}
manifest.finishedAt = new Date().toISOString(); manifest.failures = failures;
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('FINISHED', out, 'failures=' + failures);
process.exitCode = failures ? 1 : 0;
