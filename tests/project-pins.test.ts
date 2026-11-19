import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectoryStore } from '../src/web/directory-store.ts';
import { Store } from '../src/server/store.ts';
import { Hosts } from '../src/server/hosts.ts';
import { createApp } from '../src/server/app.ts';
const item = (key: string, project: string, activityAt: number, hostId = 'h') => ({key, project, activityAt, hostId, projectId: key, attention: false});
test('project pins lead recency, survive rename and updates, and apply to filters and hosts', () => {
  const d = new DirectoryStore<ReturnType<typeof item>>();
  const a = item('a', 'Driver', 1), b = item('b', 'Busy', 100), c = item('c', 'Other', 200, 'other');
  d.applyCollection({type: 'snapshot', generation: 'g', seq: 1, items: [a,b,c]});
  const names = () => d.groupedRows(0, 10000).filter(r => r.kind === 'group').map(r => r.group.name);
  d.setProjectPins({[JSON.stringify(['h','a'])]: 1, [JSON.stringify(['h','b'])]: 2});
  assert.deepEqual(names(), ['Driver','Busy','Other']);
  d.applyCollection({type: 'changes', generation: 'g', seq: 2, changes: [{key:'a', value:{...a,project:'Renamed'}}, {key:'b', value:{...b,activityAt:1000}}]});
  assert.deepEqual(names(), ['Renamed','Busy','Other']);
  d.setFilter(() => true);
  assert.deepEqual(names(), ['Renamed','Busy','Other']);
  d.setProjectPins({});
  assert.deepEqual(names(), ['Busy','Other','Renamed']);
});
test('project pin API persists stable host/project identities and unpin is idempotent', async () => {
  const dir=mkdtempSync(join(tmpdir(),'lp-pins-')), store=new Store(dir), hosts=new Hosts();
  hosts.clients.set('h', {} as never);
  let app=createApp(store,hosts,'test-token','/missing');
  const request=(body?: unknown) => app.request('/api/project-pins',{method:body?'POST':'GET',headers:{authorization:'Bearer test-token','content-type':'application/json'},body:body?JSON.stringify(body):undefined});
  try {
    const body={hostId:'h',projectIds:['a'],pinned:true};
    assert.equal((await request(body)).status,200);
    const first=await (await request()).json();
    await request(body);
    assert.deepEqual(await (await request()).json(),first);
    app.dispose(); app=createApp(store,hosts,'test-token','/missing');
    assert.deepEqual(await (await request()).json(),first);
    await request({...body,pinned:false});
    assert.deepEqual(await (await request()).json(),{});
    assert.equal((await request({...body,projectIds:[]})).status,400);
  } finally {app.dispose();store.close();rmSync(dir,{recursive:true,force:true});}
});
test('removing a host forgets its pins and message images, and only its own', async () => {
  const dir=mkdtempSync(join(tmpdir(),'lp-pins-')), store=new Store(dir), hosts=new Hosts();
  hosts.clients.set('h', {} as never);
  hosts.clients.set('other', {} as never);
  hosts.remove = async (id: string) => { hosts.clients.delete(id); };
  const app=createApp(store,hosts,'test-token','/missing');
  const call=(path: string, method='GET', body?: unknown) => app.request(path,{method,headers:{authorization:'Bearer test-token','content-type':'application/json'},body:body?JSON.stringify(body):undefined});
  try {
    await call('/api/project-pins','POST',{hostId:'h',projectIds:['a'],pinned:true});
    await call('/api/project-pins','POST',{hostId:'other',projectIds:['b'],pinned:true});
    const { saveMessageImages, messageImage } = await import('../src/server/message-images.ts');
    const image = { data: 'aGk=', mimeType: 'image/png' };
    saveMessageImages(store, 'h', 'agent', 'm1', [image]);
    saveMessageImages(store, 'other', 'agent', 'm2', [image]);
    saveMessageImages(store, 'h2', 'agent', 'm3', [image]);
    assert.equal((await call('/api/hosts/h','DELETE')).status,200);
    assert.deepEqual(Object.keys(await (await call('/api/project-pins')).json()),[JSON.stringify(['other','b'])]);
    assert.equal(messageImage(store,'h','agent','m1',0),null);
    assert.equal(store.setting(`message-images:${JSON.stringify(['h','agent','m1'])}`),null);
    assert.deepEqual(messageImage(store,'other','agent','m2',0),image);
    assert.deepEqual(messageImage(store,'h2','agent','m3',0),image,'a host whose ID merely starts the same is kept');
  } finally {app.dispose();store.close();rmSync(dir,{recursive:true,force:true});}
});
