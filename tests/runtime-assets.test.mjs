import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProductService, renderRouterConfig } from '../src/product-service.mjs';
import { litePayload } from '../src/runtime-profile.mjs';
import { ModelStore } from '../src/model-store.mjs';
import { windowPaths, writeWindowRegistry } from '../src/window-registry.mjs';

test('Full to Lite unlinks shared assets without changing global originals; Full restores them', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'router-assets-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const official = path.join(root, 'official');
  const home = path.join(root, 'window');
  await fs.mkdir(official); await fs.mkdir(home);
  for (const name of ['skills', 'plugins']) {
    await fs.mkdir(path.join(official, name));
    await fs.writeFile(path.join(official, name, 'keep.txt'), 'original');
  }
  for (const name of ['auth.json', 'AGENTS.md', 'hooks.json', 'requirements.toml']) await fs.writeFile(path.join(official, name), 'original');
  const service = new ProductService(); service.officialHome = official;
  await service.syncSharedRuntimeAssets(home, 'full');
  const authPath = path.join(home, 'auth.json');
  assert.equal(await fs.readFile(authPath, 'utf8'), 'original');
  if (process.platform === 'win32') assert.equal((await fs.lstat(authPath)).isSymbolicLink(), false);
  else assert.equal((await fs.lstat(authPath)).isSymbolicLink(), true);
  await fs.writeFile(path.join(official, 'auth.next'), 'replacement');
  await fs.rename(path.join(official, 'auth.next'), path.join(official, 'auth.json'));
  if (process.platform !== 'win32') assert.equal(await fs.readFile(authPath, 'utf8'), 'replacement', 'macOS link must follow atomic account replacement immediately');
  await service.syncOfficialAuthAsset(home);
  assert.equal(await fs.readFile(authPath, 'utf8'), 'replacement');
  await service.syncSharedRuntimeAssets(home, 'lite');
  for (const name of ['skills', 'plugins', 'hooks.json', 'requirements.toml']) await assert.rejects(fs.lstat(path.join(home, name)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(official, 'AGENTS.md'), 'utf8'), 'original');
  assert.equal(await fs.readFile(path.join(official, 'skills', 'keep.txt'), 'utf8'), 'original');
  assert.match(await fs.readFile(path.join(home, 'AGENTS.md'), 'utf8'), /^# Model Router Lite/);
  await service.syncSharedRuntimeAssets(home, 'full');
  assert.equal(await fs.readFile(path.join(home, 'AGENTS.md'), 'utf8'), 'original');
});

test('account sync updates every registered work window and returns safe account status', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'router-account-sync-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ModelStore(path.join(root, 'store')); await store.read();
  const official = path.join(root, 'official'); await fs.mkdir(official);
  const jwt = (value) => 'x.' + Buffer.from(JSON.stringify(value)).toString('base64url') + '.x';
  await fs.writeFile(path.join(official, 'auth.json'), JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:jwt({exp:4102444800}),id_token:jwt({email:'owner@example.com',name:'Owner'}),account_id:'account-12345678'}}));
  await writeWindowRegistry(store.root, {windows:[{id:'router',name:'常用'},{id:'w2',name:'窗口 2'}]});
  for (const id of ['router','w2']) await fs.mkdir(windowPaths(store.root, id).homePath, {recursive:true});
  const service = new ProductService(store); service.officialHome = official;
  const result = await service.syncOfficialAuthHomes();
  assert.deepEqual(result.updated, ['router','w2']);
  assert.equal(result.account.email, 'owner@example.com');
  assert.equal(result.account.accountSuffix, '12345678');
  assert.ok(!JSON.stringify(result.account).includes('access_token'));
  for (const id of result.updated) assert.equal(JSON.parse(await fs.readFile(path.join(windowPaths(store.root, id).homePath, 'auth.json'), 'utf8')).tokens.account_id, 'account-12345678');
});

test('Lite config remains bounded even with huge top-level instructions and hundreds of sections', () => {
  const source = 'developer_instructions = "' + 'x'.repeat(120000) + '"\napproval_policy = "on-request"\n' + Array.from({length:200}, (_,i) => `[projects."/tmp/${i}"]\ntrust_level = "trusted"`).join('\n');
  const out = renderRouterConfig(source, {model:'local',catalogPath:'/tmp/catalog.json',runtimeProfile:'lite'});
  assert.ok(Buffer.byteLength(out) < 2048);
  assert.equal((out.match(/^\[/gm)||[]).length, 2);
  assert.match(out, /approval_policy = "on-request"/);
  assert.doesNotMatch(out, /developer_instructions|projects/);
});

test('Lite retains core tools inside functions namespace and mixed instruction content', () => {
  const text = '<skills_instructions>catalog</skills_instructions>\nKeep this project requirement.';
  const p = litePayload({ tools:[{type:'namespace',name:'functions',tools:[{type:'function',name:'exec_command'},{type:'function',name:'unrelated'}]}],input:[{role:'developer',content:[{type:'input_text',text}]}] });
  assert.equal(p.tools[0].tools[0].name, 'exec_command');
  assert.equal(p.tools[0].tools.length, 1);
  assert.ok(p.instructions?.includes(text) || p.input.some((item) => item.content?.some((part) => part.text === text)));
});
