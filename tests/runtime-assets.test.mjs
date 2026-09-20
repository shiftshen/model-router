import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProductService, renderRouterConfig } from '../src/product-service.mjs';
import { litePayload } from '../src/runtime-profile.mjs';

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
  await service.syncSharedRuntimeAssets(home, 'lite');
  for (const name of ['skills', 'plugins', 'hooks.json', 'requirements.toml']) await assert.rejects(fs.lstat(path.join(home, name)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(official, 'AGENTS.md'), 'utf8'), 'original');
  assert.equal(await fs.readFile(path.join(official, 'skills', 'keep.txt'), 'utf8'), 'original');
  assert.match(await fs.readFile(path.join(home, 'AGENTS.md'), 'utf8'), /^# Model Router Lite/);
  await service.syncSharedRuntimeAssets(home, 'full');
  assert.equal(await fs.readFile(path.join(home, 'AGENTS.md'), 'utf8'), 'original');
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
