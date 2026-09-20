import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelStore } from "../src/model-store.mjs";
import { ProductService } from "../src/product-service.mjs";
import { writeWindowRegistry } from "../src/window-registry.mjs";

test("profiles follow remembered models across windows and continuations; running windows defer changes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "router-lifecycle-"));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const store = new ModelStore(path.join(root, "data"));
  const service = new ProductService(store);
  service.officialHome = path.join(root, "official");
  await fs.mkdir(service.officialHome);
  await fs.writeFile(path.join(service.officialHome, "config.toml"), 'model_reasoning_effort = "medium"\n[mcp_servers.example]\ncommand = "example"\n');
  await fs.writeFile(path.join(service.officialHome, "AGENTS.md"), "full instructions");
  await fs.mkdir(path.join(service.officialHome, "skills"));
  for (const [id, endpoint] of [["local", "http://127.0.0.1:18081/v1"], ["cloud", "https://example.com/v1"]]) {
    const data = await store.read();
    await store.save({id,name:id,vendor:id,endpoint,protocol:"chat",model:id,noKey:true,switchable:true,runtimeProfile:"auto"}, data.revision);
  }
  service.startGateway = service.gatewayReady = service.check = async () => {};
  service.runningWindows = async () => new Map();
  service.switchWindowSources = async () => [];
  service.switchSummary = async () => ({});
  await writeWindowRegistry(store.root, {windows:[{id:"w2",name:"Local",initialModel:"local"}]});
  const prepared = await service.prepareWindow("w2");
  const home = prepared.homePath;
  assert.equal(prepared.runtimeProfile, "lite");
  assert.ok((await fs.stat(path.join(home,"config.toml"))).size < 2048);
  const remember = async (dir, model) => fs.writeFile(path.join(dir, ".codex-global-state.json"), JSON.stringify({"electron-persisted-atom-state":{"composer-recent-model-configurations-v1":[{model}]}}));
  await remember(home, "removed-model");
  assert.equal((await service.prepareWindow("w2")).chosen.route.id, "local", "removed recent model falls back to this window's starting model");
  await remember(home, "cloud");
  assert.equal((await service.prepareWindow("w2")).runtimeProfile, "full");
  assert.match(await fs.readFile(path.join(home,"config.toml"),"utf8"), /mcp_servers/);
  await fs.writeFile(path.join(home,"state_5.sqlite"), "");
  await remember(home, "local");
  service.runningWindows = async () => new Map([["w2", 123]]);
  await service.refreshCatalogs();
  assert.match(await fs.readFile(path.join(home,"config.toml"),"utf8"), /mcp_servers/);
  service.runningWindows = async () => new Map();
  await service.refreshCatalogs();
  assert.doesNotMatch(await fs.readFile(path.join(home,"config.toml"),"utf8"), /mcp_servers/);
  await assert.rejects(fs.lstat(path.join(home,"skills")), {code:"ENOENT"});
  for (const slot of ["instances-v2","continuations-v1"]) {
    const dir = path.join(store.root,slot,"local","codex-home");
    await fs.mkdir(dir,{recursive:true});
    await fs.writeFile(path.join(dir,"config.toml"),"old");
    await remember(dir,"cloud");
  }
  await service.setSwitching("local",true);
  const continuation = path.join(store.root,"continuations-v1","local","codex-home");
  assert.match(await fs.readFile(path.join(continuation,"config.toml"),"utf8"), /mcp_servers/);
  assert.equal((await service.prepare("local")).runtimeProfile, "full");
  await fs.writeFile(path.join(continuation,"conversation-import.json"), "{}");
  await remember(continuation,"local");
  assert.equal((await service.prepare("local")).runtimeProfile, "lite");
});

