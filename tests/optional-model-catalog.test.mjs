import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ModelStore, validateRoute } from '../src/model-store.mjs';
import { ProductService } from '../src/product-service.mjs';

async function fixture(t, status, data = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-catalog-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let calls = 0;
  const server = http.createServer((req, res) => { calls++; res.writeHead(status, { 'content-type':'application/json' }); res.end(JSON.stringify(data)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const store = new ModelStore(root);
  const route = validateRoute({ id:'coding-plan', name:'Coding Plan', vendor:'fixture', endpoint:`http://127.0.0.1:${server.address().port}/v3`, model:'ark-code-latest', protocol:'responses', runtimeProfile:'lite', credentialID:'fixture' });
  await store.save(route, (await store.read()).revision, 'fixture-key');
  const service = new ProductService(store);
  service.officialHome = path.join(root, 'official');
  service.gatewayReady = async () => {};
  service.runningWindows = async () => new Map();
  return { service, route, calls: () => calls };
}

test('startup does not request /models when discovery would fail with 401 or 404', async t => {
  for (const status of [401,404]) {
    const f = await fixture(t, status);
    const prepared = await f.service.prepare(f.route.id);
    assert.equal(f.calls(), 0);
    assert.match(await fs.readFile(path.join(prepared.homePath,'config.toml'),'utf8'), /ark-code-latest/);
  }
});

test('missing catalog retains manually configured alias without claiming inference succeeded', async t => {
  const f = await fixture(t,404);
  const discovery = await f.service.discover(f.route);
  assert.deepEqual(discovery.models,['ark-code-latest']);
  assert.equal(discovery.catalogUnavailable,true);
  assert.match(discovery.message,/手动输入/);
});

test('catalog does not drop configured aliases or duplicate listed IDs', async t => {
  const f = await fixture(t,200,{data:[{id:'versioned-model'},{id:'versioned-model'}]});
  const discovery=await f.service.discover(f.route);
  assert.deepEqual(discovery.models,['ark-code-latest','versioned-model']);
  assert.match((await f.service.check(f.route.id)).message,/未列出该别名/);
});

test('explicit discovery preserves real authorization failures', async t => {
  const f = await fixture(t,401,{error:{message:'fixture unauthorized'}});
  await assert.rejects(f.service.discover(f.route),error=>error.status===401);
});

test('saved model aliases synchronize existing homes without discovery or a thread database', async t => {
  const f = await fixture(t,404);
  const prepared = await f.service.prepare(f.route.id);
  const store = f.service.store;
  await store.save({...f.route,model:'new-alias'},(await store.read()).revision);
  await f.service.refreshRouteHomes(f.route.id);
  assert.match(await fs.readFile(path.join(prepared.homePath,'config.toml'),'utf8'),/new-alias/);
  const catalog=JSON.parse(await fs.readFile(path.join(prepared.homePath,'model-catalog.json'),'utf8'));
  assert.deepEqual(catalog.models.map(m=>m.slug),['new-alias']);
  assert.equal(f.calls(),0);
  f.service.runningWindows=async()=>new Map([[f.route.id,123]]);
  await store.save({...f.route,model:'next-alias'},(await store.read()).revision);
  const result=await f.service.refreshRouteHomes(f.route.id);
  assert.equal(result.skipped.length,1);
  assert.match(await fs.readFile(path.join(prepared.homePath,'config.toml'),'utf8'),/new-alias/);
});
