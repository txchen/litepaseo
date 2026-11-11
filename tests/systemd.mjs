// Explicit opt-in Linux systemd integration. Creates only a transient unit and temporary data.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
if (process.env.LITEPASEO_TEST_SYSTEMD !== '1') throw new Error('Set LITEPASEO_TEST_SYSTEMD=1 to create a temporary systemd user unit.');
const directory = mkdtempSync(join(tmpdir(), 'lp-systemd-'));
const name = 'litepaseo-test-' + randomUUID();
const env = { ...process.env, LITEPASEO_HOME: directory, LITEPASEO_PORT: '0' };
const cli = resolve('dist/server/cli.mjs');
const command = (file, args) => execFileSync(file, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
async function ready(previous) {
  for (let i = 0; i < 100; i++) {
    try {
      const state = JSON.parse(command(process.execPath, [cli, 'status']));
      if (state.ready && state.pid !== previous) return state;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Timed out waiting for the transient service');
}
try {
  command('systemd-run', ['--user', '--collect', '--unit=' + name, '--property=Restart=on-failure', '--property=RestartSec=1',
    '--setenv=LITEPASEO_HOME=' + directory, '--setenv=LITEPASEO_PORT=0', process.execPath, cli, 'serve']);
  const first = await ready();
  const mainPid = Number(command('systemctl', ['--user', 'show', name, '--property=MainPID', '--value']).trim());
  assert.equal(first.pid, mainPid);
  process.kill(mainPid, 'SIGKILL');
  const restarted = await ready(mainPid);
  assert.equal((await fetch(restarted.url)).status, 200);
  console.log('PASS systemd user service restarts a killed supervisor and restores HTTP readiness');
} finally {
  try { command('systemctl', ['--user', 'stop', name]); } finally { rmSync(directory, { recursive: true, force: true }); }
}
