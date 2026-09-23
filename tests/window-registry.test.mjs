import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelStore } from "../src/model-store.mjs";
import { ProductService, parseRunningWindows } from "../src/product-service.mjs";
import {
  allocateWindow,
  legacyWindowID,
  nextWindowID,
  nextWindowName,
  readWindowRegistry,
  registryLockPath,
  updateWindow,
  windowPaths,
  windowsRootName,
  writeWindowRegistry,
} from "../src/window-registry.mjs";

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cma-windows-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return new ModelStore(root);
}

// prepareWindow 会读真实的 ~/.codex 作为只读来源，并启动网关；测试里只替换掉“启动”这一步。
function quiet(service) {
  service.startGateway = async () => ({ message: "网关已就绪" });
  return service;
}

test("窗口注册表：缺省只有内置窗口，新建取 w2/w3 且不重复", async (context) => {
  const store = await fixture(context);
  const bare = await readWindowRegistry(store.root);
  assert.deepEqual(bare.windows.map((entry) => entry.id), [legacyWindowID]);
  assert.equal(nextWindowID(bare), "w2");
  assert.equal(nextWindowName(bare), "窗口 2");

  const withTwo = { schemaVersion: 1, windows: [...bare.windows, { id: "w2", name: "窗口 2" }, { id: "w4", name: "窗口 4" }] };
  assert.equal(nextWindowID(withTwo), "w3");
  assert.equal(nextWindowName(withTwo), "窗口 3");

  const written = await writeWindowRegistry(store.root, withTwo);
  assert.deepEqual((await readWindowRegistry(store.root)).windows.map((entry) => entry.id), [legacyWindowID, "w2", "w4"]);
  // 内置窗口即使被从文件里抹掉也会补回来，避免以后无法打开「窗口 1」。
  const repaired = await writeWindowRegistry(store.root, { schemaVersion: 1, windows: written.windows.filter((entry) => entry.id !== legacyWindowID) });
  assert.equal(repaired.windows[0].id, legacyWindowID);
  // 重复 id 只保留第一条
  assert.deepEqual((await writeWindowRegistry(store.root, { windows: [{ id: "w2", name: "甲" }, { id: "w2", name: "乙" }] })).windows.map((entry) => entry.name), ["窗口 1", "甲"]);
  // 内置窗口沿用历史路径，新窗口放进 windows-v1
  assert.equal(windowPaths(store.root, legacyWindowID).root, path.join(store.root, "router-v1"));
  assert.equal(windowPaths(store.root, "w2").root, path.join(store.root, windowsRootName, "w2"));
});

test("窗口标识非法时拒绝写入，注册表损坏时报错而不是清空", async (context) => {
  const store = await fixture(context);
  await assert.rejects(() => writeWindowRegistry(store.root, { windows: [{ id: "../escape", name: "坏" }] }), /窗口标识无效/);
  await fs.writeFile(path.join(store.root, "windows.json"), "{ not json");
  await assert.rejects(() => readWindowRegistry(store.root), /窗口注册表已损坏/);
  await fs.rm(path.join(store.root, "windows.json"));
  assert.equal((await readWindowRegistry(store.root)).windows.length, 1);
});

test("每个窗口有独立的 HOME 与浏览器数据目录，配置与模型目录互不串味", async (context) => {
  const store = await fixture(context);
  const service = quiet(new ProductService(store));
  const first = await service.prepareWindow(legacyWindowID, "");
  await writeWindowRegistry(store.root, { schemaVersion: 1, windows: [{ id: legacyWindowID, name: "窗口 1" }, { id: "w2", name: "窗口 2" }] });
  const second = await service.prepareWindow("w2", "deepseek-flash");

  assert.equal(first.homePath, path.join(store.root, "router-v1", "codex-home"));
  assert.equal(second.homePath, path.join(store.root, windowsRootName, "w2", "codex-home"));
  assert.notEqual(first.userDataPath, second.userDataPath);

  const firstConfig = await fs.readFile(path.join(first.homePath, "config.toml"), "utf8");
  const secondConfig = await fs.readFile(path.join(second.homePath, "config.toml"), "utf8");
  assert.ok(firstConfig.includes(`model = "${first.chosen.slug}"`));
  assert.match(secondConfig, /model = "deepseek-flash"/);
  assert.match(secondConfig, /cma_router/);
  // 两个窗口各自一份模型目录，且都指向自己的路径
  assert.notEqual(first.catalogPath, second.catalogPath);
  const firstCatalog = JSON.parse(await fs.readFile(first.catalogPath, "utf8"));
  const secondCatalog = JSON.parse(await fs.readFile(second.catalogPath, "utf8"));
  assert.deepEqual(firstCatalog.models.map((entry) => entry.slug), secondCatalog.models.map((entry) => entry.slug));
  // 切换窗口不写入任何供应商密钥：路由块只认环境变量令牌，配置里没有明文 Key
  assert.match(secondConfig, /env_key = "CMA_ROUTE_TOKEN"/);
  assert.ok(!/\bsk-[A-Za-z0-9_-]{8,}/.test(secondConfig));
  assert.ok(!/api_key\s*=\s*"/.test(secondConfig));
});

test("未知窗口不存在的槽位会被拒绝创建，也不会凭空建目录", async (context) => {
  const store = await fixture(context);
  const service = quiet(new ProductService(store));
  await assert.rejects(() => service.prepareWindow("w9", ""), /窗口不存在/);
  await assert.rejects(() => service.prepareWindow("bad id", ""), /窗口标识无效/);
  await assert.rejects(() => fs.access(path.join(store.root, windowsRootName, "w9")));
});

test("运行中的窗口只算一次，多个窗口可以同时识别", () => {
  const root = "/Users/test/.codex/model-assistant";
  const output = [
    "  37602 /Applications/Codex.app/Contents/MacOS/ChatGPT --user-data-dir=/Users/test/.codex/model-assistant/router-v1/browser-data",
    "  50608 /Applications/Codex.app/Contents/MacOS/ChatGPT --user-data-dir=/Users/test/.codex/model-assistant/windows-v1/w2/browser-data",
    "  50609 /Applications/Codex.app/Contents/MacOS/ChatGPT --type=renderer --user-data-dir=/Users/test/.codex/model-assistant/windows-v1/w2/browser-data",
    "  51111 /Applications/Codex.app/Contents/MacOS/ChatGPT --user-data-dir=/Users/test/.codex/model-assistant/windows-v1/w3/browser-data",
    "  52000 /Applications/Codex.app/Contents/MacOS/ChatGPT --user-data-dir=/Users/test/.codex/model-assistant/continuations-v1/deepseek-flash/browser-data",
  ].join("\n");
  const running = parseRunningWindows(output, root);
  assert.deepEqual([...running.keys()].sort(), ["deepseek-flash", "router", "w2", "w3"]);
  assert.equal(running.get("w2"), 50608);
  assert.equal(running.get("router"), 37602);
  // 别的根目录下的同名槽位不算数
  assert.deepEqual([...parseRunningWindows("  1 x --user-data-dir=/tmp/elsewhere/windows-v1/w2/browser-data", root).keys()], []);
});

test("状态刷新不递归测量历史单模型目录", async (context) => {
  const store = await fixture(context);
  const service = quiet(new ProductService(store));
  let options;
  service.unmanagedWindows = async (value) => { options = value; return []; };
  await service.switchSummary();
  assert.deepEqual(options, { measure: false });
});

test("新建窗口写进注册表并记住起始模型；重复打开不重复启动，关闭后可以再开", async (context) => {
  const store = await fixture(context);
  const service = quiet(new ProductService(store));
  const started = [];
  service.spawnWindow = async (prepared) => { started.push(prepared.userDataPath); return 60000 + started.length; };
  let running = new Map();
  service.runningWindows = async () => running;
  // 真实实现是向进程发 SIGTERM；这里换成“立刻消失”，免得测试真的去杀一个 pid。
  service.killWindowProcess = async () => { running = new Map(); };

  const created = await service.createWindow("deepseek-flash");
  assert.equal(created.delivered, true);
  assert.equal(started.length, 1);
  assert.equal(created.window.id, "w2");
  assert.equal(created.window.name, "窗口 2");
  assert.equal(created.window.initialModel, "deepseek-flash");
  assert.match(created.message, /已打开「窗口 2」/);
  assert.equal((await readWindowRegistry(store.root)).windows.length, 2);

  // 窗口在运行时不再重复启动
  running = new Map([["w2", created.pid]]);
  const again = await service.openWindow("w2");
  assert.equal(again.delivered, false);
  assert.equal(started.length, 1);
  assert.match(again.message, /已经在运行/);

  // 再开一个窗口：两个窗口并行，各自的 user-data-dir 不同
  const third = await service.createWindow("");
  assert.equal(third.window.id, "w3");
  assert.equal(started.length, 2);
  assert.notEqual(started[0], started[1]);

  // 重命名
  const renamed = await service.renameWindow("w3", "写代码");
  assert.match(renamed.message, /已重命名为「写代码」/);
  await assert.rejects(() => service.renameWindow("w3", "  "), /请输入窗口名称/);

  // 关闭运行时窗口，再打开会重新启动
  running = new Map([["w2", created.pid]]);
  const closed = await service.closeWindow("w2");
  assert.equal(closed.delivered, true);
  assert.equal(started.length, 2);
  running = new Map();
  assert.equal((await service.openWindow("w2")).delivered, true);
  assert.equal(started.length, 3);

  // 删除：窗口自己的数据一起移除
  const before = await fs.readdir(path.join(store.root, windowsRootName));
  await service.deleteWindow("w2");
  const after = await fs.readdir(path.join(store.root, windowsRootName));
  assert.ok(before.includes("w2") && !after.includes("w2"));
  assert.match((await service.switchSummary()).windows.map((entry) => entry.id).join(","), /^router,/);
  await assert.rejects(() => service.deleteWindow("w2"), /窗口不存在/);
  await assert.rejects(() => service.deleteWindow(legacyWindowID), /不能删除/);
});

test("运行中的窗口不会被删除，也不会被当成不存在", async (context) => {
  const store = await fixture(context);
  const service = quiet(new ProductService(store));
  service.spawnWindow = async () => 70001;
  service.runningWindows = async () => new Map();
  service.runningSlots = async () => [];
  await service.createWindow("deepseek-flash");
  service.runningWindows = async () => new Map([["w2", 70001]]);
  service.runningSlots = async () => [{ slot: windowsRootName, id: "w2", pid: 70001 }];
  await assert.rejects(() => service.deleteWindow("w2"), /请先关闭/);
  const summary = await service.switchSummary();
  assert.equal(summary.windows.find((entry) => entry.id === "w2").running, true);
  assert.equal(summary.windows.find((entry) => entry.id === "w2").pid, 70001);
  assert.equal(summary.routerRunning, false);
  assert.deepEqual(summary.orphans, []);
});

test("新建窗口启动失败时不留下打不开的空条目", async (context) => {
  const store = await fixture(context);
  const service = quiet(new ProductService(store));
  service.spawnWindow = async () => { throw new Error("启动失败"); };
  await assert.rejects(() => service.createWindow("deepseek-flash"), /启动失败/);
  assert.deepEqual((await readWindowRegistry(store.root)).windows.map((entry) => entry.id), [legacyWindowID]);
  // 失败后重试会拿到同一个编号，不会一路涨上去
  service.spawnWindow = async () => 80001;
  const created = await service.createWindow("deepseek-flash");
  assert.equal(created.window.id, "w2");
});

// 回归：并发建窗曾把编号算成同一个，后写的覆盖先写的，另一个 Codex 进程变成界面上看不见的孤儿。
test("并发建窗：每个请求都拿到独立编号，注册表一个都不丢", async (context) => {
  const store = await fixture(context);
  const service = quiet(new ProductService(store));
  const started = [];
  service.spawnWindow = async (prepared) => { started.push(prepared.userDataPath); return 90000 + started.length; };
  service.runningWindows = async () => new Map();

  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => service.createWindow(`model-${index}`)));
  const ids = results.map((entry) => entry.window.id);
  assert.equal(new Set(ids).size, ids.length, `编号必须互不相同，实际：${ids.join(",")}`);
  assert.equal(new Set(started).size, started.length, "每个窗口必须有自己的 browser-data 目录");

  const registry = await readWindowRegistry(store.root);
  assert.equal(registry.windows.length, 9, "内置窗口 + 8 个新窗口");
  for (const id of ids) assert.ok(registry.windows.some((entry) => entry.id === id), `${id} 必须留在注册表里`);
  // 起始模型也要各归各的，不能互相覆盖
  for (const result of results) {
    const stored = registry.windows.find((entry) => entry.id === result.window.id);
    assert.equal(stored.initialModel, result.window.initialModel);
  }
});

test("并发建窗会避开还在跑的未登记窗口，不会和它的目录撞车", async (context) => {
  const store = await fixture(context);
  const service = quiet(new ProductService(store));
  service.spawnWindow = async () => 91000;
  // w2 是并发事故里跑起来、但没登记的孤儿：新窗口必须跳过编号 w2。
  service.runningWindows = async () => new Map([["w2", 4242]]);
  const created = await service.createWindow("");
  assert.equal(created.window.id, "w3");
  assert.equal(created.window.name, "窗口 3");
});

test("注册表锁：并发改名不覆盖期间新建的窗口，陈旧锁能自动接管", async (context) => {
  const store = await fixture(context);
  const service = quiet(new ProductService(store));
  service.spawnWindow = async () => 92000;
  service.runningWindows = async () => new Map();
  await service.createWindow("");
  await service.createWindow("");

  // 改名和新窗口同时发生：两个写入都必须落盘。
  await Promise.all([service.renameWindow("w2", "写代码"), service.createWindow("")]);
  const registry = await readWindowRegistry(store.root);
  assert.equal(registry.windows.find((entry) => entry.id === "w2").name, "写代码");
  assert.equal(registry.windows.length, 4, "并发写入不能丢条目");

  // 陈旧锁（上次异常退出留下的）要被接管，而不是让后续操作永远超时
  await fs.writeFile(registryLockPath(store.root), "999999 stale\n");
  const past = new Date(Date.now() - 120000);
  await fs.utimes(registryLockPath(store.root), past, past);
  const renamed = await updateWindow(store.root, "w3", { name: "视频" });
  assert.equal(renamed.name, "视频");
  await assert.rejects(() => fs.access(registryLockPath(store.root)), /ENOENT/, "锁必须被释放");

  // 新鲜的锁要挡住写入，避免两边同时改
  await fs.writeFile(registryLockPath(store.root), "1 busy\n");
  await assert.rejects(() => updateWindow(store.root, "w3", { name: "x" }, { timeoutMs: 150 }), /占用/);
  assert.equal((await readWindowRegistry(store.root)).windows.find((entry) => entry.id === "w3").name, "视频", "被锁挡住时不能写坏数据");
  await fs.rm(registryLockPath(store.root), { force: true });
});

test("陈旧锁要在等待超时之前被接管，建窗不会报「正被占用」", async (context) => {
  const store = await fixture(context);
  // 默认参数下才成立：一旦有人把 staleMs 调到大于 timeoutMs，
  // 持有者异常退出后锁还没到接管时限就先撞上等待上限，用户看到的就是「点了没反应，只能开一个」。
  await fs.writeFile(registryLockPath(store.root), "424242 crashed\n");
  const stale = new Date(Date.now() - 6000);
  await fs.utimes(registryLockPath(store.root), stale, stale);
  const started = Date.now();
  const window = await allocateWindow(store.root, {});
  const elapsed = Date.now() - started;
  assert.equal(window.id, "w2", "陈旧锁被接管后照常建窗");
  assert.ok(elapsed < 2000, `接管必须在等待上限之前完成，实际用了 ${elapsed}ms`);
  await assert.rejects(() => fs.access(registryLockPath(store.root)), /ENOENT/, "接管后锁必须被释放");
});

test("接管孤儿窗口：注册表补齐后可以在列表里看到并管理", async (context) => {
  const store = await fixture(context);
  const service = quiet(new ProductService(store));
  const orphans = [
    { slot: windowsRootName, id: "w5", pid: 70001 },
    { slot: windowsRootName, id: "w6", pid: 70002 },
    { slot: "continuations-v1", id: "deepseek-flash", pid: 70003 },
  ];
  service.runningSlots = async () => orphans;
  service.runningWindows = async () => new Map(orphans.map((entry) => [entry.id, entry.pid]));
  // 孤儿窗口自己的 config.toml 决定它打开时用的模型
  const home = windowPaths(store.root, "w5").homePath;
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(home, "config.toml"), 'model = "deepseek-flash"\nmodel_provider = "cma_router"\n');

  const before = await service.switchSummary();
  assert.deepEqual(before.orphans.map((entry) => entry.id), ["w5", "w6"], "旧的单模型窗口不算孤儿");
  assert.deepEqual(before.windows.map((entry) => entry.id), [legacyWindowID], "孤儿在接管前不在窗口列表里");

  const adopted = await service.adoptWindows("all");
  assert.deepEqual(adopted.adopted, ["w5", "w6"]);
  assert.match(adopted.message, /已接管 2 个未登记的窗口/);
  const after = await service.switchSummary();
  assert.deepEqual(after.windows.map((entry) => entry.id), [legacyWindowID, "w5", "w6"]);
  assert.equal(after.windows.find((entry) => entry.id === "w5").running, true);
  assert.equal(after.windows.find((entry) => entry.id === "w5").pid, 70001);
  assert.equal(after.windows.find((entry) => entry.id === "w5").initialModel, "deepseek-flash");
  assert.deepEqual(after.orphans, []);

  // 已登记的窗口不会被重复接管，也不会改名
  const again = await service.adoptWindows("all");
  assert.deepEqual(again.adopted, []);
  assert.equal((await readWindowRegistry(store.root)).windows.length, 3);
});

test("allocateWindow 在锁内分配编号，连续调用不会重号", async (context) => {
  const store = await fixture(context);
  const first = await allocateWindow(store.root, {});
  const second = await allocateWindow(store.root, {});
  assert.equal(first.id, "w2");
  assert.equal(second.id, "w3");
  assert.equal(first.name, "窗口 2");
  assert.equal(second.name, "窗口 3");
  assert.equal((await readWindowRegistry(store.root)).windows.length, 3);
});
