// Isolated real Paseo daemon; only the model provider is synthetic.
import { join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createHostClient } from '@getpaseo/client/node';

const root = resolve(process.env.PASEO_BENCH_PACKAGE);
const { createTestPaseoDaemon } = await import(join(root, 'dist/server/server/test-utils/paseo-daemon.js'));
const { MockLoadTestAgentClient, MockLoadTestAgentSession } = await import(join(root, 'dist/server/server/agent/providers/mock-load-test-agent.js'));
const home = mkdtempSync(join(tmpdir(), 'lp-comparison-'));
const workspace = join(home, 'workspace'); mkdirSync(workspace);
let activeSession, ticks = [], expected = '', generated = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
class Session extends MockLoadTestAgentSession {
  scheduleStreamingAssistantTurn(turn) {
    activeSession = this;
    this.emitTurnStarted(turn);
    this.emitTimeline(turn.turnId, { type: 'assistant_message', text: 'BENCH_READY\n\n', messageId: turn.assistantMessageId });
    expected = 'BENCH_READY\n\n';
  }
}
class Provider extends MockLoadTestAgentClient {
  async createSession(config) {
    return new Session({ config: { ...config, featureValues: { mockStreamingAssistantResponse: 'controlled' } }, sessionId: randomUUID() });
  }
}
const disabled = Object.fromEntries(['claude', 'codex', 'copilot', 'opencode', 'pi', 'omp', 'mock-slow'].map(k => [k, { enabled: false }]));
const test = await createTestPaseoDaemon({
  paseoHomeRoot: home, mcpEnabled: false, isDev: true,
  agentClients: { mock: new Provider() }, providerOverrides: disabled,
  pluginsEnabled: false, webUi: { enabled: true, distDir: join(root, 'dist/server/web-ui') },
});
const endpoint = `127.0.0.1:${test.port}`;
const client = createHostClient(`ws://${endpoint}`, { clientId: 'benchmark-controller', clientType: 'cli' });
await client.connect();
const created = await client.createWorkspace({ source: { kind: 'directory', path: workspace } });
if (!created.workspace) throw new Error(JSON.stringify(created));
const agent = await client.createAgent({ workspaceId: created.workspace.id, cwd: workspace, provider: 'mock', model: 'one-minute-stream', title: 'Performance comparison' });
const agentId = agent.id;
if (!agentId) throw new Error(JSON.stringify(agent));
await client.sendMessage(agentId, 'Render the deterministic benchmark response.');
while (!activeSession) await sleep(20);
const serverId = client.getLastServerInfoMessage().serverId;
process.send({ type: 'ready', endpoint, serverId, agentId, workspaceId: created.workspace.id });
let running;
async function generate(kind, count, interval) {
  const session = activeSession, turn = session.activeTurn;
  if (kind === 'code') {
    const prefix = '```typescript\n' + Array.from({ length: 200 }, (_, i) => `const value${i} = "中文 ${i}";\n`).join('');
    expected += prefix;
    session.emitTimeline(turn.turnId, { type: 'assistant_message', text: prefix, messageId: turn.assistantMessageId });
  }
  const started = performance.now();
  for (let i = 1; i <= count; i++) {
    await sleep(Math.max(0, started + i * interval - performance.now()));
    const text = kind === 'code' ? `// BENCH_${String(i).padStart(5, '0')} 中文 abcdef0123456789\n` : `BENCH_${String(i).padStart(5, '0')} 中文 abcdef0123456789. `;
    expected += text; generated++;
    ticks.push({ index: i, at: Date.now(), elapsedMs: performance.now() - started });
    session.emitTimeline(turn.turnId, { type: 'assistant_message', text, messageId: turn.assistantMessageId });
  }
}
process.on('message', async ({ requestId, cmd, ...args }) => {
  try {
    let result;
    if (cmd === 'start') { running = generate(args.kind, args.count, args.interval); result = true; }
    else if (cmd === 'expected') { if (running) await running; result = { expected, generated, ticks, timeline: await client.fetchAgentTimeline(agentId, { limit: 100 }) }; }
    else if (cmd === 'shutdown') { await client.close(); await test.close(); rmSync(home, { recursive: true, force: true }); process.send({ requestId, result: true }); process.exit(); }
    process.send({ requestId, result });
  } catch (error) { process.send({ requestId, error: error.stack }); }
});
process.on('disconnect', () => process.exit());
