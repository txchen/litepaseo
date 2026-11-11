// Explicit opt-in: creates and archives one real agent in a temporary directory.
// Run: LITEPASEO_TEST_HOST=127.0.0.1:6767 node tests/live-daemon.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
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
const uploadedPaths = [];
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
  assert.deepEqual((await request(agentPath + '/messages/status', 'POST', { messageIds: [message.messageId] })).confirmed, [message.messageId]);
  console.log('PASS exact message-ID reconciliation');
  if (process.env.LITEPASEO_TEST_ATTACHMENTS === '1') {
    const caps = await request(agentPath + '/attachments/capabilities');
    assert.ok(caps.images && caps.files);
    const originalUpload = driver.uploadFile.bind(driver);
    driver.uploadFile = async input => { const result = await originalUpload(input); if (result.file) uploadedPaths.push(result.file.path); return result; };
    const upload = async (name, mime, bytes) => {
      const response = await app.request('/api' + agentPath + '/attachments', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-file-name': encodeURIComponent(name), 'content-type': mime }, body: bytes });
      assert.equal(response.status, 201); return (await response.json()).id;
    };
    const marker = 'FILE_' + randomUUID().replaceAll('-', '');
    const fileId = await upload('integration-marker.txt', 'text/plain', Buffer.from(marker));
    // Solid red PNG, generated as a deterministic test fixture, not an external asset.
    const chunk = (name, bytes) => { const type = Buffer.from(name), size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(Buffer.concat([type, bytes]))); return Buffer.concat([size, type, bytes, checksum]); };
    const header = Buffer.alloc(13); header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
    const pixels = Buffer.alloc(64 * 193); for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) pixels[y * 193 + 1 + x * 3] = 255;
    const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
    const imageId = await upload('red.png', 'image/png', png);
    await request(agentPath + '/messages', 'POST', { messageId: randomUUID(), behavior: 'steer', attachmentIds: [fileId, imageId],
      text: 'Integration test: read the attached text file using a tool, and inspect the attached image. Reply with the exact file contents and the dominant image color. Do not modify files or use other tools.' });
    await until(async () => (await tail()).entries.some(e => e.item.type === 'assistant_message' && e.item.text?.includes(marker) && /red/i.test(e.item.text)), 'real file and image contents');
    console.log('PASS real file contents and image vision');
  }

  if (process.env.LITEPASEO_TEST_QUESTIONS === '1') {
    await request(agentPath + '/messages', 'POST', { messageId: randomUUID(), behavior: 'steer',
      text: 'This is a question protocol test. Use request_user_input_async to ask exactly one question: Which strategy? Suggested options: Incremental, Rewrite. Do not use any other tools or inspect files. Wait for my answer. After receiving it, reply exactly LITEPASEO_QUESTION_OK.' });
    let permission;
    await until(() => {
      permission = hosts.agents.snapshot().find(a => a.id === id)?.pendingPermissions.find(p => p.kind === 'question');
      return !!permission;
    }, 'real question request');
    const questions = permission.input?.questions;
    assert.ok(Array.isArray(questions) && questions.length);
    const answers = Object.fromEntries(questions.map(q => [q.header, q.options?.[0]?.label ?? 'Incremental']));
    await request(agentPath + '/permissions/' + encodeURIComponent(permission.id), 'POST', { behavior: 'allow', updatedInput: { answers } });
    await until(async () => (await tail()).entries.some(e => e.item.type === 'assistant_message' && e.item.text?.includes('LITEPASEO_QUESTION_OK')), 'answer after question');
    console.log('PASS real question request and structured response');
  }

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
  for (const path of uploadedPaths) {
    try { const deleted = await hosts.get(host.id).driver.deleteFileEntry({ cwd: dirname(path), path }); assert.ok(deleted.success && !deleted.error, "Test upload deletion failed"); }
    catch { console.error('Disposable uploaded file cleanup failed:', path); process.exitCode = 1; }
  }
  app.dispose();
  await hosts.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
