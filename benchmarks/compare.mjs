import { chromium } from '@playwright/test';
import { fork, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { cpus, release, totalmem } from 'node:os';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const smoke = process.argv.includes('--smoke');
const duration = smoke ? 2 : 30, repetitions = smoke ? 1 : 5;
const out = resolve(process.env.BENCH_OUT ?? `benchmarks/runs/${new Date().toISOString().replaceAll(':', '-')}-comparison${smoke ? '-smoke' : ''}`);
mkdirSync(out, { recursive: true });
const read = path => { try { return readFileSync(path, 'utf8').trim(); } catch { return null; } };
const hash = s => createHash('sha256').update(s).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ticksPerSecond = +execFileSync('getconf', ['CLK_TCK']);
function tree(root, ledger) {
  const todo = [root], seen = new Set(); let pss = 0;
  while (todo.length) {
    const pid = todo.pop(); if (seen.has(pid)) continue;
    const stat = read(`/proc/${pid}/stat`); if (!stat) continue;
    seen.add(pid);
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
    ledger.set(`${pid}:${f[19]}`, (+f[11] + +f[12]) / ticksPerSecond);
    const memory = read(`/proc/${pid}/smaps_rollup`)?.match(/^Pss:\s+(\d+) kB/m);
    if (!memory) throw new Error(`PSS unavailable for ${pid}`);
    pss += +memory[1] * 1024;
    try { for (const tid of readdirSync(`/proc/${pid}/task`)) {
      const children = read(`/proc/${pid}/task/${tid}/children`);
      if (children) todo.push(...children.split(/\s+/).map(Number));
    } } catch {}
  }
  return { cpuSeconds: [...ledger.values()].reduce((a, b) => a + b, 0), pss, pids: [...seen] };
}
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);
}
const official = resolve(process.env.PASEO_BENCH_PACKAGE);
const manifest = {
  startedAt: new Date().toISOString(), litepaseoCommit: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim(),
  sourceStatus: execFileSync('git', ['status', '--short']).toString(),
  officialVersion: JSON.parse(read(join(official, 'package.json'))).version,
  node: process.version, os: release(), cpu: cpus()[0].model, logicalCpus: cpus().length, totalMemory: totalmem(),
  governor: read('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor'), acOnline: read('/sys/class/power_supply/ADP1/online'),
  energy: { joules: null, reason: 'RAPL energy_uj is not readable; no direct energy measurement.' },
  duration, repetitions, warmupSeconds: smoke ? 1 : 10, viewport: { width: 1280, height: 900 },
  rate: 20, codePrefillLines: 200, browserMode: 'headless',
  methodology: 'Fresh real daemon with deterministic mock provider, no plugins, one workspace/agent and one prompt. Published official production web UI; local production LitePaseo UI with real source BFF and SDK. Same semantic events through normal transports. Fresh browser per case. Alternating paired order. Entire browser process-tree CPU and PSS sampled every 2s. 100% CPU = one core. Shared AC-powered host; thermals uncontrolled. Startup excluded from CPU. 1s drain included. Browser, BFF and daemon reported separately. Not battery drain, physical paint, or network-speed measurement.',
};
const artifacts = {};
for (const [label, dir] of [['litepaseo', resolve('dist/web')], ['paseo', join(official, 'dist/server/web-ui')]]) {
  artifacts[label] = files(dir).map(path => ({ path: path.slice(dir.length + 1), bytes: readFileSync(path).length, sha256: hash(readFileSync(path)) }));
}
writeFileSync(join(out, 'build-hashes.json'), JSON.stringify(artifacts, null, 2));
for (const name of ['compare.mjs', 'compare-daemon.mjs', 'compare-bff.mjs']) {
  mkdirSync(join(out, 'harness'), { recursive: true });
  writeFileSync(join(out, 'harness', name), readFileSync(join('benchmarks', name)));
}
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
const results = [];
let serial = 0;
async function child(file, env, log) {
  const proc = fork(resolve(file), [], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  proc.stdout.on('data', x => appendFileSync(log, x)); proc.stderr.on('data', x => appendFileSync(log, x));
  const pending = new Map();
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { proc.kill(); reject(new Error('Startup timeout: ' + file)); }, 60000);
    proc.on('message', m => {
      if (m.type === 'ready') { clearTimeout(timeout); resolve(m); }
      else if (pending.has(m.requestId)) { const cb = pending.get(m.requestId); pending.delete(m.requestId); m.error ? cb.reject(new Error(m.error)) : cb.resolve(m.result); }
    });
    proc.on('exit', code => { clearTimeout(timeout); reject(new Error(`${file} exited ${code}`)); for (const cb of pending.values()) cb.reject(new Error('Child exited')); });
  });
  return { proc, ready, rpc(cmd, args = {}) { return new Promise((resolve, reject) => {
    const requestId = ++serial; const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error('RPC timeout: ' + cmd)); }, 60000);
    pending.set(requestId, { resolve(x) { clearTimeout(timeout); resolve(x); }, reject(e) { clearTimeout(timeout); reject(e); } });
    proc.send({ cmd, requestId, ...args });
  }); } };
}
const scenarios = process.env.BENCH_SCENARIOS?.split(',') ?? ['idle', 'plain', 'code'];
manifest.scenarios = scenarios;
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
for (const scenario of scenarios) for (let rep = 1; rep <= repetitions; rep++) {
  for (const variant of (rep % 2 ? ['litepaseo', 'paseo'] : ['paseo', 'litepaseo'])) {
    const name = `${scenario}-${rep}-${variant}`, folder = join(out, name); mkdirSync(folder);
    console.log('START', name);
    let daemon, bff, browserServer, browser, page;
    const errors = [], samples = [], ledgers = { browser: new Map(), daemon: new Map(), bff: new Map() };
    try {
      daemon = await child('benchmarks/compare-daemon.mjs', {}, join(folder, 'daemon.log'));
      if (variant === 'litepaseo') bff = await child('benchmarks/compare-bff.mjs', { BENCH_ENDPOINT: daemon.ready.endpoint }, join(folder, 'bff.log'));
      browserServer = await chromium.launchServer({ headless: true }); browser = await chromium.connect(browserServer.wsEndpoint());
      manifest.chromium = browser.version(); writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
      const context = await browser.newContext({ viewport: manifest.viewport, reducedMotion: 'no-preference', colorScheme: 'dark' });
      if (variant === 'paseo') await context.addInitScript(({ endpoint, serverId }) => {
        const connection = { id: `direct:${endpoint}`, type: 'directTcp', endpoint };
        localStorage.setItem('@paseo:daemon-registry', JSON.stringify([{ serverId, label: 'Benchmark', connections: [connection], preferredConnectionId: connection.id, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }]));
        localStorage.setItem('@paseo:onboarding', JSON.stringify({ completedAt: new Date(0).toISOString() }));
        localStorage.setItem('@paseo:app-settings', JSON.stringify({ chatDisplay: 'full' }));
      }, daemon.ready);
      await context.addInitScript(() => {
        window.__bench = { longTasks: [], firstSeen: {} };
        new PerformanceObserver(list => { for (const e of list.getEntries()) window.__bench.longTasks.push({ start: e.startTime, duration: e.duration }); }).observe({ type: 'longtask' });
      });
      if (bff) assert.ok((await context.request.post(bff.ready.url + '/api/login', { data: { token: 'benchmark-token' } })).ok());
      page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
      const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
      const url = bff ? `${bff.ready.url}/?session=benchmark:${daemon.ready.agentId}` : `http://${daemon.ready.endpoint}/h/${daemon.ready.serverId}/agent/${daemon.ready.agentId}`;
      const navStart = performance.now(); await page.goto(url);
      const selector = bff ? '.row-assistant .prose' : '[data-testid="assistant-message"]';
      await page.locator(selector).filter({ hasText: 'BENCH_READY' }).waitFor({ timeout: 30000 });
      const readyMs = performance.now() - navStart;
      assert.equal(await page.evaluate(() => document.hidden), false);
      if (bff) assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--motion-step-ms').trim()), '1000');
      await sleep(manifest.warmupSeconds * 1000);
      await page.evaluate(({ selector, scenario }) => {
        window.__bench.longTasks = []; window.__bench.firstSeen = {};
        new MutationObserver(() => {
          // Match the reading position: both products keep newly appended code visible.
          // LitePaseo caps its code block's height, so its inner scroller needs following.
          if (scenario === 'code') for (const pre of document.querySelectorAll(`${selector} pre`)) pre.scrollTop = pre.scrollHeight;
          const text = [...document.querySelectorAll(selector)].map(e => e.textContent).join('');
          for (const match of text.matchAll(/BENCH_(\d{5})/g)) window.__bench.firstSeen[match[1]] ??= Date.now();
        }).observe(document.body, { childList: true, subtree: true, characterData: true });
      }, { selector, scenario });
      const sample = async () => {
        const at = performance.now();
        const b = tree(browserServer.process().pid, ledgers.browser), d = tree(daemon.proc.pid, ledgers.daemon), f = bff ? tree(bff.proc.pid, ledgers.bff) : null;
        const metrics = await cdp.send('Performance.getMetrics');
        const heap = metrics.metrics.find(m => m.name === 'JSHeapUsedSize').value;
        const result = { at, epochMs: Date.now(), browser: b, daemon: d, bff: f, heap, loadavg: read('/proc/loadavg') }; samples.push(result); return result;
      };
      const before = await sample();
      if (scenario !== 'idle') await daemon.rpc('start', { kind: scenario, count: duration * 20, interval: 50 });
      const end = before.at + duration * 1000;
      while (performance.now() < end) { await sleep(Math.min(2000, Math.max(0, end - performance.now()))); await sample(); }
      await sleep(1000);
      const expected = await daemon.rpc('expected');
      if (scenario !== 'idle') await page.waitForFunction(({ selector, last }) => [...document.querySelectorAll(selector)].some(e => e.textContent.includes(last)), { selector, last: `BENCH_${String(duration * 20).padStart(5, '0')}` }, { timeout: 15000 });
      const after = await sample();
      const visible = await page.locator(selector).allTextContents();
      if (scenario === 'code') assert.ok(await page.evaluate(({ selector, last }) => {
        for (const root of document.querySelectorAll(selector)) {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          for (let node; (node = walker.nextNode());) {
            const index = node.textContent.indexOf(last); if (index < 0) continue;
            const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + last.length);
            const rect = range.getBoundingClientRect();
            if (rect.top < 0 || rect.bottom > innerHeight) return false;
            const pre = node.parentElement.closest('pre');
            return !pre || rect.bottom <= pre.getBoundingClientRect().bottom;
          }
        }
        return false;
      }, { selector, last: `BENCH_${String(duration * 20).padStart(5, '0')}` }), 'Last code chunk must be within the viewport and code scroller');
      writeFileSync(join(folder, 'visible.json'), JSON.stringify(visible, null, 2));
      writeFileSync(join(folder, 'expected.json'), JSON.stringify(expected, null, 2));
      const markers = [...visible.join('').matchAll(/BENCH_\d{5}/g)].map(m => m[0]);
      const expectedMarkers = [...expected.expected.matchAll(/BENCH_\d{5}/g)].map(m => m[0]);
      assert.deepEqual(markers, expectedMarkers, 'Every generated marker must appear exactly once and in order');
      const normalize = text => text.replace('```typescript\n', '').replace(/\s/g, '');
      assert.equal(normalize(visible.join('')), normalize(expected.expected), 'Complete rendered message must match (Markdown fence and whitespace normalized)');
      assert.equal(errors.length, 0, 'No page errors');
      const diagnostics = await page.evaluate(() => ({ ...window.__bench, resources: performance.getEntriesByType('resource').map(e => ({ name: new URL(e.name).pathname, type: e.initiatorType, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize })), nodes: document.querySelectorAll('*').length }));
      const latencies = expected.ticks.map(t => diagnostics.firstSeen[String(t.index).padStart(5, '0')] - t.at).filter(Number.isFinite).sort((a, b) => a - b);
      const wall = (after.at - before.at) / 1000;
      const result = { name, scenario, rep, variant, readyMs, wallSeconds: wall,
        browserCpuPercent: (after.browser.cpuSeconds - before.browser.cpuSeconds) / wall * 100,
        daemonCpuPercent: (after.daemon.cpuSeconds - before.daemon.cpuSeconds) / wall * 100,
        bffCpuPercent: bff ? (after.bff.cpuSeconds - before.bff.cpuSeconds) / wall * 100 : 0,
        browserPeakPssMiB: Math.max(...samples.map(s => s.browser.pss)) / 1048576,
        heapPeakMiB: Math.max(...samples.map(s => s.heap)) / 1048576,
        latencyP50: latencies[Math.floor(latencies.length * .5)] ?? null, latencyP95: latencies[Math.floor(latencies.length * .95)] ?? null,
        latencySamples: latencies.length, longTasks: diagnostics.longTasks.length, longTaskMs: diagnostics.longTasks.reduce((n, t) => n + t.duration, 0),
        markerCount: markers.length, markerHash: hash(markers.join('\n')), expectedHash: hash(expected.expected), renderedNormalizedHash: hash(normalize(visible.join(''))),
        generated: expected.generated, eventSpanMs: expected.ticks.length ? expected.ticks.at(-1).elapsedMs : 0,
        errors, passed: true, nodes: diagnostics.nodes,
      };
      await page.screenshot({ path: join(folder, 'screen.png') });
      writeFileSync(join(folder, 'samples.json'), JSON.stringify(samples, null, 2));
      writeFileSync(join(folder, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2));
      results.push(result); console.log('PASS', name, JSON.stringify(result));
    } catch (error) {
      if (page) { await page.screenshot({ path: join(folder, 'failure.png') }).catch(() => {}); writeFileSync(join(folder, 'failure.html'), await page.content().catch(() => '')); }
      results.push({ name, scenario, rep, variant, passed: false, error: error.stack, errors });
      console.error('FAIL', name, error); process.exitCode = 1;
    } finally {
      await browser?.close().catch(() => {}); await browserServer?.close().catch(() => {});
      for (const c of [bff, daemon]) if (c) { await c.rpc('shutdown').catch(() => {}); c.proc.kill(); }
      writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
    }
    if (process.exitCode) process.exit(process.exitCode);
  }
}
console.log('Artifacts:', out);
