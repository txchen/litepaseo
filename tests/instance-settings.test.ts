import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { Hosts } from '../src/server/hosts.ts';
import { createApp } from '../src/server/app.ts';

test('instance names are validated, authenticated and persist across server restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(),'lp-instance-'));
  let store = new Store(dir), app = createApp(store,new Hosts(),'test-token','/missing');
  const put = (name: unknown) => app.request('/api/instance',{method:'PUT',headers:{authorization:'Bearer test-token','content-type':'application/json'},body:JSON.stringify({name})});
  try {
    assert.equal((await app.request('/api/instance',{method:'PUT',body:JSON.stringify({name:'untrusted'})})).status,401);
    for (const invalid of [null,42,'x'.repeat(65),'one\ntwo']) assert.equal((await put(invalid)).status,400);
    assert.deepEqual(await (await put('  家里的 <server>  ')).json(),{name:'家里的 <server>'});
    app.dispose(); store.close(); store = new Store(dir); app = createApp(store,new Hosts(),'test-token','/missing');
    assert.equal((await (await app.request('/api/auth')).json()).instanceName,'家里的 <server>');
    assert.deepEqual(await (await put('   ')).json(),{name:''});
    assert.equal(store.setting('instance-name'),null);
  } finally {app.dispose();store.close();rmSync(dir,{recursive:true,force:true});}
});
