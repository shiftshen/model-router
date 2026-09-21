import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelStore } from "../src/model-store.mjs";

test("旧配置中的单模型开关自动迁移为统一可切换", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "model-router-unified-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ModelStore(root);
  const data = await store.read();
  const route = data.routes.find((entry) => entry.id !== "official");
  const raw = JSON.parse(await fs.readFile(store.file, "utf8"));
  raw.routes.find((entry) => entry.id === route.id).switchable = false;
  await fs.writeFile(store.file, JSON.stringify(raw, null, 2));
  const migrated = await store.read();
  assert.equal(migrated.routes.find((entry) => entry.id === route.id).switchable, true);
  assert.ok((await fs.readdir(path.join(root, "backups"))).some((name) => name.startsWith("library-before-official-cleanup-")));
});

test("macOS 与 Windows 不再暴露单模型工作入口", async () => {
  const [mac, windows, html] = await Promise.all([
    fs.readFile(new URL("../Sources/CodexModelAssistantApp.swift", import.meta.url), "utf8"),
    fs.readFile(new URL("../windows/renderer.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../windows/index.html", import.meta.url), "utf8"),
  ]);
  assert.match(mac, /同步并打开可切换窗口/);
  assert.match(windows, /同步并打开可切换窗口/);
  assert.doesNotMatch(mac, /本窗口改为单模型|专用单模型窗口（不复用已有窗口）/);
  assert.doesNotMatch(html, /modelSwitchable|此模型窗口允许切换模型/);
  assert.doesNotMatch(windows, /data-sync-official/);
});
