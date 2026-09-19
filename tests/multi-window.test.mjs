import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ModelStore } from "../src/model-store.mjs";
import { ProductService } from "../src/product-service.mjs";
import { toAnthropic, sanitizeAnthropicSchema } from "../src/protocol-adapter.mjs";
import { readWindowRegistry, windowPaths, windowsRootName, writeWindowRegistry } from "../src/window-registry.mjs";
import { isWindowsTest } from "./test-platform.mjs";

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cma-multi-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return new ModelStore(root);
}

async function withWindows(store) {
  const registry = await readWindowRegistry(store.root);
  await writeWindowRegistry(store.root, {
    ...registry,
    windows: [
      ...registry.windows,
      { id: "w2", name: "窗口 2", initialModel: "deepseek-flash", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "w3", name: "窗口 3", initialModel: "agnes", createdAt: "2026-01-01T00:00:00.000Z" },
    ],
  });
}

function commandFor(store, id) {
  return `/Applications/Codex.app/Contents/MacOS/ChatGPT --user-data-dir=${windowPaths(store.root, id).userDataPath}`;
}

// Anthropic 只接受字符串 enum；Codex 的工具 schema 里带数字 enum，原样转发会让整个请求 400。
test("转换 Anthropic 工具 schema：丢掉非字符串 enum，保留字符串 enum", () => {
  const schema = {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["fast", "slow"] },
      count: { type: "integer", enum: [0, 1] },
      nested: { type: "object", properties: { flag: { type: "boolean", enum: [true, false] } } },
    },
    required: ["mode"],
    additionalProperties: false,
  };
  const clean = sanitizeAnthropicSchema(schema);
  assert.deepEqual(clean.properties.mode.enum, ["fast", "slow"]);
  assert.equal(clean.properties.count.enum, undefined);
  assert.equal(clean.properties.count.type, "integer");
  assert.equal(clean.properties.nested.properties.flag.enum, undefined);
  assert.deepEqual(clean.required, ["mode"]);
  assert.equal(clean.additionalProperties, false);
  // 原始输入不能被就地改写
  assert.deepEqual(schema.properties.count.enum, [0, 1]);
});

test("toAnthropic 的工具里不再出现非字符串 enum", () => {
  const body = toAnthropic({
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hi" }],
    tools: [{
      type: "function",
      function: {
        name: "shell",
        description: "run",
        parameters: { type: "object", properties: { timeout: { type: "number", enum: [0, 1] }, mode: { type: "string", enum: ["a"] } } },
      },
    }],
  });
  const collected = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "enum") collected.push(...value);
      walk(value);
    }
  };
  walk(body.tools);
  assert.ok(collected.length > 0);
  assert.ok(collected.every((entry) => typeof entry === "string"), `应全是字符串：${JSON.stringify(collected)}`);
  assert.deepEqual(body.tools[0].input_schema.properties.mode.enum, ["a"]);
});

test("关窗只认目标窗口自己的进程，PID 不匹配就拒绝", async (context) => {
  const store = await fixture(context);
  await withWindows(store);
  const service = new ProductService(store);

  service.windowProcessCommand = async () => commandFor(store, "w2");
  assert.equal(await service.assertWindowProcess(4242, "w2"), true);
  await assert.rejects(() => service.assertWindowProcess(4242, "w3"), /不是「w3」窗口的进程/);

  // 进程已经退出：返回 false，由调用方按「没在运行」处理
  service.windowProcessCommand = async () => "";
  assert.equal(await service.assertWindowProcess(4242, "w2"), false);
});

test("多开时关窗不会误伤别的窗口和助手自己", async (context) => {
  const store = await fixture(context);
  await withWindows(store);
  const service = new ProductService(store);
  service.runningWindows = async () => new Map([["w2", 4242]]);
  // 命令行是 w3 的：说明 pid 归属对不上，必须拒绝而不是照杀
  service.windowProcessCommand = async () => commandFor(store, "w3");
  await assert.rejects(() => service.closeWindow("w2"), /不是「w2」窗口的进程/);

  await assert.rejects(() => service.killWindowProcess(process.pid), /拒绝结束助手自身的进程/);
  await assert.rejects(() => service.killWindowProcess(0), /进程号无效/);
});

test("每个窗口的运行判定互相独立", async (context) => {
  const store = await fixture(context);
  await withWindows(store);
  const service = new ProductService(store);
  service.runningWindows = async () => new Map([["w2", 11], ["w3", 22]]);
  service.runningSlots = async () => [
    { slot: windowsRootName, id: "w2", pid: 11 },
    { slot: windowsRootName, id: "w3", pid: 22 },
  ];
  const summary = await service.switchSummary();
  const byID = new Map(summary.windows.map((entry) => [entry.id, entry]));
  assert.equal(byID.get("w2").pid, 11);
  assert.equal(byID.get("w3").pid, 22);
  assert.equal(byID.get("router").running, false);
  assert.deepEqual(summary.orphans, []);
});

test("只有该窗口自己有进程时，ID 校验才通过（router 用 router-v1 目录）", async (context) => {
  const store = await fixture(context);
  const service = new ProductService(store);
  service.windowProcessCommand = async () => `/Applications/Codex.app/Contents/MacOS/ChatGPT --user-data-dir=${windowPaths(store.root, "router").userDataPath}`;
  assert.equal(await service.assertWindowProcess(99, "router"), true);
  await assert.rejects(() => service.assertWindowProcess(99, "w2"), /不是「w2」窗口的进程/);
});

// 关窗后 Codex 的 crashpad 助手会被 reparent 到 init，不受进程组信号影响，每开关一次留下两个。
// 多开重度使用时这些进程会一直堆积，所以要按窗口目录精确收掉，同时不能碰别的窗口。
test("清理窗口残留助手进程时只认本窗口目录，不误伤别的窗口", { skip: isWindowsTest }, async (context) => {
  const store = await fixture(context);
  await withWindows(store);
  const service = new ProductService(store);
  const markerFor = (id) => `--database=${windowPaths(store.root, id).userDataPath}/Crashpad`;
  // sh 的 argv 里保留标记，子进程 sleep 让它活着，模拟 reparent 到 init 的助手进程。
  // 必须是两条命令：/bin/sh 对「唯一的简单命令」会直接 exec，那样 argv 里的标记就没了。
  const spawnHelper = (id) => spawn("/bin/sh", ["-c", "sleep 30; :", "sh", markerFor(id)], { stdio: "ignore", detached: true });
  const mine = spawnHelper("w2");
  const other = spawnHelper("w3");
  context.after(() => {
    for (const child of [mine, other]) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* 已经退出 */ } }
  });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitFor = async (check, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (check()) return true; await new Promise((resolve) => setTimeout(resolve, 50)); }
    return check();
  };
  assert.equal(await waitFor(() => alive(mine.pid) && alive(other.pid)), true, "两个助手进程都要先跑起来");

  assert.equal(await service.sweepWindowHelpers("w2"), 1, "只应该收掉 w2 的助手");
  assert.equal(await waitFor(() => !alive(mine.pid)), true, "w2 的助手必须被收掉");
  assert.equal(alive(other.pid), true, "w3 的助手不能被误杀");
});


// 用户的原话：「你每个模型点开都是新窗口了啊，这个体验很不好」。
// 点模型是想换模型，不是想再开一个窗口——已经有窗口在跑就必须复用它。
test("点一个第三方模型时复用已开着的窗口，不再新建", async (context) => {
  const store = await fixture(context);
  await withWindows(store);
  const service = new ProductService(store);
  service.runningWindows = async () => new Map([["w2", 4242]]);
  const result = await service.openCodex("deepseek-flash");
  assert.equal(result.reused, true);
  assert.equal(result.delivered, false, "不应该启动新窗口");
  assert.equal(result.pid, 4242);
  assert.equal(result.window?.id, "w2");
});

// 官方入口点进去必须是官方那一个：默认资料、已登录、任务库是官方的。
// 以前这里会给官方入口造一个空资料窗口，用户看到的是「欢迎使用 ChatGPT 桌面版」的新手引导。
test("官方入口打开的是 ChatGPT Desktop 默认资料，不新建空资料窗口", async (context) => {
  const store = await fixture(context);
  const service = new ProductService(store);
  service.officialCodexRunning = async () => [{ pid: 4242, args: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" }];
  service.openOfficialDesktop = async () => ({ launched: true, appPath: "/Applications/ChatGPT.app", pid: 0 });
  const result = await service.openCodex("official");
  assert.equal(result.official, true);
  assert.equal(result.reused, true);
  assert.equal(result.pid, 4242);
  // 不能留下 instances-v2/official 这种空资料窗口
  await assert.rejects(() => fs.access(path.join(store.root, "instances-v2", "official", "codex-home")));
});

test("模型自己的窗口已经在跑时，launch 只切过去，不重复启动", async (context) => {
  const store = await fixture(context);
  const service = new ProductService(store);
  service.runningWindows = async () => new Map([["deepseek-flash", 777]]);
  const result = await service.launch("deepseek-flash");
  assert.equal(result.reused, true);
  assert.equal(result.pid, 777);
  assert.match(result.message, /已经开着/);
  assert.match(result.message, /没有重复启动/);
});


// 现场踩到的：单模型窗口（独立窗口/专用窗口）落在 continuations-v1 或 instances-v2，
// 而守卫只认 windows-v1，于是判定成「不是这个窗口的进程」——用户点关闭没反应，窗口关不掉。
test("单模型窗口落在 continuations-v1 / instances-v2 时同样能关", async (context) => {
  const store = await fixture(context);
  const service = new ProductService(store);
  const root = store.root;
  for (const slot of ["continuations-v1", "instances-v2", "windows-v1"]) {
    service.windowProcessCommand = async () =>
      `/Applications/Codex.app/Contents/MacOS/ChatGPT --user-data-dir=${root}/${slot}/deepseek-flash/browser-data`;
    assert.equal(await service.assertWindowProcess(4242, "deepseek-flash"), true, `${slot} 槽位应被认出来`);
  }
  // 别的窗口的进程仍然要拒绝
  service.windowProcessCommand = async () =>
    `/Applications/Codex.app/Contents/MacOS/ChatGPT --user-data-dir=${root}/windows-v1/w2/browser-data`;
  await assert.rejects(() => service.assertWindowProcess(4242, "deepseek-flash"), /不是「deepseek-flash」窗口的进程/);
});
