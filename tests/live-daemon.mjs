// Explicit opt-in: creates and archives one real agent in a temporary directory.
// Run: LITEPASEO_TEST_HOST=127.0.0.1:6767 node tests/live-daemon.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHostClient } from '@getpaseo/client/node';
import { createPaseoApi } from '@getpaseo/client';
import { Store } from '../src/server/store.ts';
import { Hosts } from '../src/server/hosts.ts';
import { createApp } from '../src/server/app.ts';

if (!process.env.LITEPASEO_TEST_HOST) throw new Error('Set LITEPASEO_TEST_HOST explicitly to opt in to real agent creation.');
const directory = mkdtempSync(join(tmpdir(), 'litepaseo-live-'));
const store = new Store(join(directory, 'data'));
const hosts = new Hosts();
const host = store.addHost('Integration test', process.env.LITEPASEO_TEST_HOST);
const token = randomUUID();
const app = createApp(store, hosts, token, directory, { pushSender: { async send() {} } });
let id;
async function connectHost() {
  const driver = createHostClient(host.connection, {
    clientId: `litepaseo-live-${host.id}`, clientType: 'cli', reconnect: { enabled: true },
    ...(process.env.LITEPASEO_TEST_CREDENTIAL_FILE ? {
      localCredential: () => readFileSync(process.env.LITEPASEO_TEST_CREDENTIAL_FILE, 'utf8').trim(),
    } : {}),
  });
  hosts.attach(host.id, driver, createPaseoApi(driver));
  await driver.connect();
}
async function request(path, method = 'GET', body) {
  const response = await app.request('/api' + path, {
    method, headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(value)}`);
  return value;
}
async function until(check, label, ms = 120_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Timed out: ' + label);
}
try {
  await connectHost();
  await until(() => hosts.state(host.id) === 'connected', 'connect', 15_000);
  console.log('PASS real SDK connection');
  const providers = await request(`/hosts/${host.id}/providers`);
  assert.ok(providers.some(p => p.id === 'codex'));
  await request(`/hosts/${host.id}/projects`);
  console.log('PASS provider and project discovery');
  const input = { idempotencyKey: randomUUID(), cwd: directory, provider: 'codex', prompt: 'This is a protocol integration test. Do not use tools or modify files. Reply with exactly LITEPASEO_LIVE_OK.' };
  const created = await request(`/hosts/${host.id}/agents`, 'POST', input);
  id = created.id;
  console.log('Created disposable agent', id);
  const duplicate = await request(`/hosts/${host.id}/agents`, 'POST', input);
  assert.equal(duplicate.id, id);
  console.log('PASS create idempotency');
  const agentPath = `/hosts/${host.id}/agents/${id}`;
  const driver = hosts.get(host.id).driver;
  const tail = () => driver.fetchAgentTimeline(id, { direction: 'tail', limit: 100, projection: 'projected', wholeTurns: true });
  await until(async () => (await tail()).entries.some(e => e.item.type === 'assistant_message' && e.item.text?.includes('LITEPASEO_LIVE_OK')), 'first answer');
  await until(() => hosts.agents.snapshot().some(a => a.id === id && a.status !== 'running'), 'directory update');
  console.log('PASS real response and directory synchronization');
  const stream = await app.request('/api' + agentPath + '/timeline/stream', { headers: { authorization: `Bearer ${token}` } });
  const reader = stream.body.getReader();
  let timer;
  try {
    const first = await Promise.race([reader.read(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timeline stream timeout')), 15_000); })]);
    const data = new TextDecoder().decode(first.value);
    assert.ok(data.includes('LITEPASEO_LIVE_OK'), 'projected stream must contain the real answer');
    console.log('PASS BFF timeline stream');
  } finally { clearTimeout(timer); await reader.cancel(); }

  const message = { messageId: randomUUID(), behavior: 'steer', text: 'Again without tools: reply exactly LITEPASEO_SECOND_OK.' };
  await request(agentPath + '/messages', 'POST', message);
  await until(async () => (await tail()).entries.some(e => e.item.type === 'assistant_message' && e.item.text?.includes('LITEPASEO_SECOND_OK')), 'second answer');
  console.log('PASS message send');
  const page = await tail();
  assert.ok(page.startCursor);
  await request(agentPath + '/timeline?cursor=' + encodeURIComponent(JSON.stringify(page.startCursor)));
  console.log('PASS history API');
  // Stop is safe for a settled turn too; active cancellation is a separate acceptance case.
  await request(agentPath + '/stop', 'POST', {});
  console.log('PASS stop API on settled agent');
  // Only reconnect our own SDK client, never restart the shared daemon.
  await hosts.remove(host.id);
  await connectHost();
  await until(() => hosts.state(host.id) === 'connected' && hosts.agents.snapshot().some(a => a.id === id), 'reconnect', 20_000);
  assert.ok((await hosts.get(host.id).driver.fetchAgentTimeline(id, { direction: 'tail', limit: 100, projection: 'projected' })).entries.some(e => e.item.text?.includes('LITEPASEO_SECOND_OK')));
  console.log('PASS client reconnect and authoritative history');
} finally {
  if (id) {
    try {
      if (!hosts.clients.has(host.id)) await connectHost();
      await request(`/hosts/${host.id}/agents/${id}/archive`, 'POST', {}); console.log('Archived disposable agent', id); }
    catch (error) { console.error('Cleanup requires archiving agent', id, error.message); process.exitCode = 1; }
  }
  await hosts.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
