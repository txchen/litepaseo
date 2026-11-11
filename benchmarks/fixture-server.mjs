import { serve } from '@hono/node-server';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { mkdtempSync, rmSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/server/store.ts';
import { Hosts } from '../src/server/hosts.ts';
import { createApp } from '../src/server/app.ts';

const config = JSON.parse(process.env.BENCH_CONFIG);
const home = mkdtempSync(join(tmpdir(), 'lp-perf-'));
const store = new Store(home), hosts = new Hosts();
const drivers = new Map();
const events = openSync(join(config.out, 'events.ndjson'), 'w');
const histogram = monitorEventLoopDelay({ resolution: 20 }); histogram.enable();
let bytes = 0, chunks = 0, timelineSubscriptions = 0, generated = 0, directoryChanges = 0;
let streamTimer, directoryTimer, tick = 0;
const stamp = '2026-01-01T00:00:00.000Z';
const fixtureText = 'Fixture 中文 response with deterministic content. '.repeat(20);

class Driver {
  constructor(host) {
    this.host = host; this.agentObserver = null; this.workspaceObserver = null;
    this.handlers = new Set(); this.live = []; this.liveBytes = 0; this.seq = config.history; this.syncSeq = config.sessions;
    this.agents = []; this.workspaces = [];
    for (let i = 0; i < config.sessions / 2; i++) {
      const project = 'project-' + (i % 50);
      this.agents.push({ id: 'a' + i, workspaceId: 'w' + i, title: `Session ${host}-${i}`, provider: 'codex', cwd: '/fixture/' + project,
        status: i === 0 ? 'running' : 'idle', updatedAt: stamp, pendingPermissions: [], createdAt: stamp });
      this.workspaces.push({ id: 'w' + i, projectId: project, projectDisplayName: project, projectRootPath: '/fixture/' + project,
        workspaceDirectory: '/fixture/' + project, workspaceKind: 'local_checkout', name: `Session ${host}-${i}`, title: null,
        status: i === 0 ? 'running' : 'done', pinnedAt: i === 0 ? stamp : null, activityAt: stamp, syncSeq: i + 1 });
    }
    this.api = { dispose: async () => {}, providers: { listUsage: async () => ({ providers: [] }) }, agents: { ref: () => ({
      refresh: async () => {}, current: () => ({ provider: 'codex' }), capabilities: { supportsToolInvocations: true },
      pendingPermissions: [],
    }) } };
  }
  getConnectionState() { return { status: 'connected' }; }
  subscribeConnectionStatus() { return () => {}; }
  getLastServerInfoMessage() { return { features: { directorySync: true } }; }
  observeAgents() { return { subscribe: o => {
    this.agentObserver = o;
    o.snapshot({ entries: this.agents.map((agent, i) => ({ agent, syncSeq: i + 1, project: { projectKey: 'project-' + (i % 50), projectName: 'project-' + (i % 50) } })),
      pageInfo: { hasMore: false, nextCursor: null }, sync: { generation: this.host, headSeq: this.syncSeq, mode: 'snapshot', removals: [] } });
    return () => {};
  }, release: async () => { this.agentObserver = null; } }; }
  observeWorkspaces() { return { subscribe: o => {
    this.workspaceObserver = o;
    o.snapshot({ entries: this.workspaces, pageInfo: { hasMore: false, nextCursor: null }, sync: { generation: this.host, headSeq: this.syncSeq, mode: 'snapshot', removals: [] } });
    return () => {};
  }, release: async () => { this.workspaceObserver = null; } }; }
  clearAgentAttention() { return Promise.resolve(); }
  clearWorkspaceAttention() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  subscribeAgentTimeline(_id, callback) {
    this.handlers.add(callback); timelineSubscriptions++;
    let active = true;
    const release = async () => { if (active) { active = false; timelineSubscriptions--; this.handlers.delete(callback); } };
    return Object.assign(() => void release(), { ready: Promise.resolve(), release });
  }
  initial(index) {
    return { seqStart: index, seqEnd: index, timestamp: stamp, provider: 'codex', turnId: 'history-' + index,
      item: { type: index % 2 ? 'user_message' : 'assistant_message', text: `History ${this.host}-${index}: ` + fixtureText } };
  }
  allTail(limit, before = Infinity) {
    const live = this.live.filter(row => row.seqStart < before);
    const result = live.slice(-limit);
    const end = Math.min(config.history, before - 1);
    for (let i = end; i >= 1 && result.length < limit; i--) result.unshift(this.initial(i));
    return result;
  }
  async fetchAgentTimeline(_id, options) {
    let rows;
    if (options.direction === 'after') {
      rows = [];
      for (let i = options.cursor.seq + 1; i <= config.history && rows.length < options.limit; i++) rows.push(this.initial(i));
      rows.push(...this.live.filter(row => row.seqEnd > options.cursor.seq).slice(0, options.limit - rows.length));
    }
    else rows = this.allTail(options.limit, options.direction === 'before' ? options.cursor.seq : Infinity);
    return { epoch: this.host, reset: false, entries: structuredClone(rows),
      window: { minSeq: 1, maxSeq: this.seq, nextSeq: this.seq + 1 },
      hasOlder: (rows[0]?.seqStart ?? 1) > 1, hasNewer: false,
      startCursor: rows.length ? { epoch: this.host, seq: rows[0].seqStart } : null,
      endCursor: { epoch: this.host, seq: this.seq } };
  }
  append(n) {
    const startNew = !this.live.length || (config.rowEvery && (n - 1) % config.rowEvery === 0);
    const marker = `LP${this.host}:${n}:${Date.now()}`;
    const delta = `line 中文 ${'abcdef0123456789'.repeat(2)} ${marker}\n`;
    const item = { type: 'assistant_message', text: (startNew && config.kind === 'markdown' ? '```typescript\n' + 'const sample = "中文";\n'.repeat(config.prefillLines ?? 0) : '') + delta };
    this.liveBytes += Buffer.byteLength(item.text);
    const seq = ++this.seq;
    const turnId = startNew ? `live-${n}` : this.live.at(-1).turnId;
    if (startNew) this.live.push({ seqStart: seq, seqEnd: seq, timestamp: new Date().toISOString(), provider: 'codex', turnId, item: { ...item } });
    else { const row = this.live.at(-1); row.item.text += item.text; row.seqEnd = seq; }
    const payload = { agentId: 'a0', epoch: this.host, seq, timestamp: new Date().toISOString(), event: { type: 'timeline', provider: 'codex', turnId, item } };
    for (const handler of this.handlers) handler({ type: 'agent_stream', payload });
    generated++;
    writeSync(events, JSON.stringify({ host: this.host, ...payload }) + '\n');
  }
  change(n) {
    const index = (n * 97) % this.agents.length;
    const agent = { ...this.agents[index], title: `Session ${this.host}-${index} update ${n}`, updatedAt: new Date().toISOString() };
    const workspace = { ...this.workspaces[index], name: agent.title, activityAt: agent.updatedAt };
    this.agents[index] = agent; this.workspaces[index] = workspace;
    const seq = ++this.syncSeq;
    this.agentObserver?.update({ type: 'agent_update', payload: { kind: 'upsert', agent, generation: this.host, seq } });
    this.workspaceObserver?.update({ type: 'workspace_update', payload: { kind: 'upsert', workspace, generation: this.host, seq } });
    directoryChanges++;
  }
}
for (const id of ['h0', 'h1']) {
  store.db.prepare('INSERT INTO hosts VALUES(?,?,?)').run(id, 'Fixture ' + id, 'ws://fixture.invalid');
  const driver = new Driver(id); drivers.set(id, driver); hosts.attach(id, driver, driver.api);
}
const app = createApp(store, hosts, 'benchmark-token', resolve('dist/web'), { pushSender: { async send() {} } });
const server = serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
  const response = await app.fetch(request);
  if (!response.body) return response;
  const reader = response.body.getReader();
  return new Response(new ReadableStream({
    async pull(controller) {
      try { const result = await reader.read(); if (result.done) controller.close(); else { bytes += result.value.byteLength; chunks++; controller.enqueue(result.value); } }
      catch (error) { controller.error(error); }
    }, cancel: reason => reader.cancel(reason),
  }), { status: response.status, headers: response.headers });
} });
await new Promise(resolve => server.once('listening', resolve));
process.send({ type: 'ready', url: `http://127.0.0.1:${server.address().port}` });
const stop = () => { clearInterval(streamTimer); clearInterval(directoryTimer); streamTimer = directoryTimer = undefined; };
process.on('message', async message => {
  try {
    let result;
    if (message.cmd === 'start') {
      histogram.reset();
      if (config.rate) streamTimer = setInterval(() => { tick++; for (const driver of drivers.values()) driver.append(tick); }, 1000 / config.rate);
      if (config.directoryRate) directoryTimer = setInterval(() => {
        for (let i = 0; i < config.directoryRate / 10; i++) { const n = directoryChanges + 1; drivers.get('h' + (n % 2)).change(n); }
      }, 100);
      result = { started: Date.now() };
    } else if (message.cmd === 'stop') { stop(); result = { tick, generated }; }
    else if (message.cmd === 'expected') result = Object.fromEntries([...drivers].map(([id, d]) => [id, d.allTail(message.limit, message.before ?? Infinity)]));
    else if (message.cmd === 'metrics') result = {
      at: Date.now(), cpu: process.cpuUsage(), memory: process.memoryUsage(), bytes, chunks, generated, directoryChanges,
      streams: app.openStreams(), timelineSubscriptions, agents: hosts.agents.size,
      eventLoop: { meanMs: histogram.mean / 1e6, p95Ms: histogram.percentile(95) / 1e6, maxMs: histogram.max / 1e6 },
      fixtureLiveRows: [...drivers.values()].reduce((sum, d) => sum + d.live.length, 0),
      fixtureLiveTextBytes: [...drivers.values()].reduce((sum, d) => sum + d.liveBytes, 0),
    };
    else if (message.cmd === 'shutdown') {
      stop(); histogram.disable(); app.dispose(); await hosts.close(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); store.close(); closeSync(events); rmSync(home, { recursive: true, force: true });
      process.send({ requestId: message.requestId, result: true }); process.disconnect(); return;
    }
    process.send({ requestId: message.requestId, result });
  } catch (error) { process.send({ requestId: message.requestId, error: error.stack }); }
});
process.on('disconnect', () => { stop(); rmSync(home, { recursive: true, force: true }); process.exit(); });
