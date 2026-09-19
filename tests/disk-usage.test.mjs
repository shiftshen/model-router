import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  applyCleanup,
  applyOfficialArchived,
  cleanupFolder,
  cleanupPlan,
  cleanupWindowOnLaunch,
  describePlan,
  diskUsage,
  officialArchivedPlan,
  staleDays,
  systemDisk,
} from "../src/disk-cleanup.mjs";
import { parseOfficialRunning } from "../src/product-service.mjs";
import { defaultDiskPolicy, readDiskPolicy, saveDiskPolicy } from "../src/disk-policy.mjs";
import { isWindowsTest, sqliteAsync, sqliteTestBinary, tarTestBinary } from "./test-platform.mjs";

const execFileAsync = promisify(execFile);
const sqliteBinary = sqliteTestBinary;

async function sqlite(dbPath, sql) {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  await sqliteAsync(dbPath, sql);
}

// 造一条会话：state_5 的 threads 行 + 任务库行 + 真实 rollout 文件（带字节数，便于核对释放量）。
async function addThread({ home, id, bytes = 1024, updatedAt = Math.floor(Date.now() / 1000), archived = 0, title = `会话 ${id}`, history = true }) {
  const rolloutPath = path.join(home, "sessions", `${id}.jsonl`);
  await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
  await fs.writeFile(rolloutPath, "x".repeat(bytes));
  await sqlite(path.join(home, "state_5.sqlite"), [
    "create table if not exists threads (id text primary key, rollout_path text, updated_at integer, archived integer, title text);",
    "create table if not exists thread_attachments (thread_id text);",
    "create table if not exists thread_dynamic_tools (thread_id text);",
    `insert or replace into threads (id, rollout_path, updated_at, archived, title) values ('${id}', '${rolloutPath}', ${updatedAt}, ${archived}, '${title}');`,
    `insert into thread_attachments (thread_id) values ('${id}');`,
    `insert into thread_dynamic_tools (thread_id) values ('${id}');`,
  ].join("\n"));
  if (history) {
    await sqlite(path.join(home, "thread_history_1.sqlite"), [
      "create table if not exists thread_turns (thread_id text, payload text);",
      "create table if not exists thread_items (thread_id text, payload text);",
      "create table if not exists thread_realtime_items (thread_id text, payload text);",
      `insert into thread_turns (thread_id, payload) values ('${id}', '${"t".repeat(200)}');`,
      `insert into thread_items (thread_id, payload) values ('${id}', '${"i".repeat(200)}');`,
      `insert into thread_realtime_items (thread_id, payload) values ('${id}', '${"r".repeat(200)}');`,
    ].join("\n"));
  }
  return rolloutPath;
}

async function rowCount(dbPath, table, id, key = "thread_id") {
  const { stdout } = await execFileAsync(sqliteBinary, ["-json", dbPath, `select count(*) as n from ${table} where ${key} = '${id}'`]);
  const rows = JSON.parse(String(stdout).trim() || "[]");
  return Number(rows[0]?.n ?? 0);
}

async function fixture(context) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cma-disk-"));
  context.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "model-assistant");
  const officialHome = path.join(base, "official-codex");
  await fs.mkdir(root, { recursive: true });
  // 官方库必须有 threads 表，否则 plan 会拒绝执行。
  await sqlite(path.join(officialHome, "state_5.sqlite"), "create table if not exists threads (id text primary key, rollout_path text, updated_at integer, archived integer, title text);");
  return { base, root, officialHome };
}

const continuationHome = (root, id) => path.join(root, "continuations-v1", id, "codex-home");
const routerHome = (root) => path.join(root, "router-v1", "codex-home");

test("磁盘治理：官方库已有的会话在窗口里算副本，窗口独有的算原件、永不入选", async (context) => {
  const { root, officialHome } = await fixture(context);
  const home = continuationHome(root, "deepseek-flash");
  await addThread({ home: officialHome, id: "shared-1", bytes: 10 });
  await addThread({ home, id: "shared-1", bytes: 4096 });
  await addThread({ home, id: "copy-1", bytes: 8192, title: "只在窗口里的对话" });

  const plan = await cleanupPlan({ root, officialHome });
  assert.deepEqual(plan.items.map((item) => item.id), ["shared-1"], "只有官方库存在的才是副本");
  assert.equal(plan.reclaimBytes, 4096);
  assert.equal(plan.keepOriginals.count, 1, "窗口独有的对话算原件");
  assert.equal(plan.keepOriginals.bytes, 8192);

  const summary = describePlan(plan);
  assert.equal(summary.items.count, 1);
  assert.equal(summary.items.sample[0].reason, "副本");
});

test("磁盘治理：续接窗口清全部副本，工作窗口只清官方已归档或超 30 天", async (context) => {
  const { root, officialHome } = await fixture(context);
  const now = Date.now();
  const fresh = Math.floor(now / 1000);
  const ancient = Math.floor(now / 1000) - (staleDays + 5) * 86400;
  await addThread({ home: officialHome, id: "fresh-live", bytes: 10, updatedAt: fresh });
  await addThread({ home: officialHome, id: "fresh-archived", bytes: 10, updatedAt: fresh, archived: 1 });
  await addThread({ home: officialHome, id: "old-live", bytes: 10, updatedAt: ancient });

  const continuation = continuationHome(root, "deepseek-flash");
  await addThread({ home: continuation, id: "fresh-live", bytes: 2048, updatedAt: fresh });
  await addThread({ home: continuation, id: "fresh-archived", bytes: 2048, updatedAt: fresh });
  await addThread({ home: continuation, id: "old-live", bytes: 2048, updatedAt: ancient });

  const router = routerHome(root);
  await addThread({ home: router, id: "fresh-live", bytes: 1024, updatedAt: fresh });
  await addThread({ home: router, id: "fresh-archived", bytes: 1024, updatedAt: fresh });
  await addThread({ home: router, id: "old-live", bytes: 1024, updatedAt: ancient });
  await addThread({ home: router, id: "router-own", bytes: 4096, updatedAt: fresh, title: "工作窗口自己的对话" });

  const plan = await cleanupPlan({ root, officialHome, now });
  const picked = plan.items.map((item) => `${item.windowID}/${item.id}`);
  assert.deepEqual(picked.sort(), [
    "deepseek-flash/fresh-archived",
    "deepseek-flash/fresh-live",
    "deepseek-flash/old-live",
    "router/fresh-archived",
    "router/old-live",
  ]);
  assert.equal(plan.items.find((item) => item.id === "fresh-archived" && item.windowID === "router").reason, "副本 · 官方已归档");
  assert.equal(plan.items.find((item) => item.id === "old-live" && item.windowID === "router").reason, `副本 · 超 ${staleDays} 天`);
  assert.equal(plan.keepOriginals.count, 1, "工作窗口独有的对话要保留");
});

test("磁盘治理：窗口在运行时跳过它的副本，并算出「关掉后能回收多少」", async (context) => {
  const { root, officialHome } = await fixture(context);
  const now = Date.now();
  const fresh = Math.floor(now / 1000);
  const ancient = Math.floor(now / 1000) - (staleDays + 5) * 86400;
  await addThread({ home: officialHome, id: "fresh-live", bytes: 10, updatedAt: fresh });
  await addThread({ home: officialHome, id: "archived-one", bytes: 10, updatedAt: fresh, archived: 1 });
  await addThread({ home: officialHome, id: "old-live", bytes: 10, updatedAt: ancient });
  const router = routerHome(root);
  const rollout = await addThread({ home: router, id: "archived-one", bytes: 4096 });
  await addThread({ home: router, id: "old-live", bytes: 8192, updatedAt: ancient });
  await addThread({ home: router, id: "fresh-live", bytes: 1024, updatedAt: fresh });

  const runningIds = new Set(["router"]);
  const plan = await cleanupPlan({ root, officialHome, runningIds, now });
  assert.deepEqual(plan.items, [], "运行中的窗口不选任何副本");
  assert.equal(plan.reclaimBytes, 0);
  const window = plan.windows.find((entry) => entry.id === "router");
  assert.equal(window.running, true);
  // 关掉它之后能回收的必须算出来，否则用户只看到「正在运行」，没法判断值不值得关。
  assert.equal(window.pendingCount, 2, "已归档 + 超 30 天各一条");
  assert.equal(window.pendingBytes, 4096 + 8192);
  assert.match(plan.skipped[0].reason, /窗口正在运行/);
  assert.equal(plan.skipped[0].copyBytes, 4096 + 8192);
  assert.equal(plan.skipped[0].bytes, 4096 + 8192);
  // 只跳过「不重要」的那两条：30 天内的副本压根不在待清列表里。
  assert.ok(rollout);

  // 手动构造一个指向运行窗口的计划：执行阶段必须跳过它、不碰它的文件，并在结果里点名。
  const forced = { items: [{ windowID: "router", home: router, id: "archived-one", rolloutPath: rollout, bytes: 4096, reason: "副本" }] };
  const result = await applyCleanup({ root, plan: forced, confirm: true, runningIds });
  assert.equal(result.deletedThreads, 0);
  assert.deepEqual(result.skippedRunning, [{ id: "router", threads: 1, bytes: 4096 }]);
  await fs.access(rollout);
});

test("磁盘治理：一个窗口在跑，其它窗口照样清干净（多开是常态，不能整体卡死）", async (context) => {
  const { root, officialHome } = await fixture(context);
  await addThread({ home: officialHome, id: "shared-1", bytes: 10 });
  const router = routerHome(root);
  const routerRollout = await addThread({ home: router, id: "shared-1", bytes: 4096 });
  const continuation = continuationHome(root, "deepseek-flash");
  const continuationRollout = await addThread({ home: continuation, id: "shared-1", bytes: 8192 });

  const runningIds = new Set(["router"]);
  const plan = await cleanupPlan({ root, officialHome, runningIds });
  assert.deepEqual(plan.items.map((item) => item.windowID), ["deepseek-flash"]);

  const result = await applyCleanup({ root, plan, confirm: true, runningIds });
  assert.equal(result.deletedThreads, 1);
  assert.equal(result.skippedRunning.length, 0, "计划本身已经把运行中的窗口排除了");
  await fs.access(routerRollout);
  await assert.rejects(() => fs.access(continuationRollout), /ENOENT/, "另一个窗口的副本要清掉");
});

test("磁盘治理：不确认就不落盘，确认后删文件与三类行并回收空间，再跑一次为空", async (context) => {
  const { root, officialHome } = await fixture(context);
  await addThread({ home: officialHome, id: "shared-1", bytes: 10 });
  const home = continuationHome(root, "deepseek-flash");
  const rollout = await addThread({ home, id: "shared-1", bytes: 300 * 1024 });

  const plan = await cleanupPlan({ root, officialHome });
  assert.equal(plan.items.length, 1);
  await assert.rejects(() => applyCleanup({ root, plan, confirm: false }), /必须显式确认/);
  await fs.access(rollout);
  assert.equal(await rowCount(path.join(home, "state_5.sqlite"), "threads", "shared-1", "id"), 1, "未确认时数据库不能被改");

  const result = await applyCleanup({ root, plan, confirm: true });
  assert.equal(result.deletedThreads, 1);
  assert.equal(result.deletedFiles, 1);
  await assert.rejects(() => fs.access(rollout), /ENOENT/, "rollout 文件必须删掉");
  assert.equal(await rowCount(path.join(home, "state_5.sqlite"), "threads", "shared-1", "id"), 0);
  assert.equal(await rowCount(path.join(home, "state_5.sqlite"), "thread_attachments", "shared-1"), 0);
  assert.equal(await rowCount(path.join(home, "state_5.sqlite"), "thread_dynamic_tools", "shared-1"), 0);
  assert.equal(await rowCount(path.join(home, "thread_history_1.sqlite"), "thread_turns", "shared-1"), 0);
  assert.equal(await rowCount(path.join(home, "thread_history_1.sqlite"), "thread_items", "shared-1"), 0);
  assert.equal(await rowCount(path.join(home, "thread_history_1.sqlite"), "thread_realtime_items", "shared-1"), 0);

  // 审计清单必须完整可解析
  const manifest = JSON.parse(await fs.readFile(result.backupManifest, "utf8"));
  assert.equal(manifest.items.length, 1);
  assert.equal(manifest.items[0].id, "shared-1");
  assert.equal(manifest.items[0].rolloutPath, rollout);
  assert.ok(manifest.items[0].bytes > 0);
  assert.ok(manifest.items[0].reason);
  assert.ok(manifest.appliedAt);
  assert.equal(path.basename(path.dirname(result.backupManifest)), cleanupFolder);

  const again = await cleanupPlan({ root, officialHome });
  assert.equal(again.items.length, 0, "第二次必然为空（幂等）");
  assert.equal(again.reclaimBytes, 0);
});

test("磁盘治理：VACUUM 之后任务库文件确实变小", async (context) => {
  const { root, officialHome } = await fixture(context);
  await addThread({ home: officialHome, id: "shared-1", bytes: 10 });
  const home = continuationHome(root, "deepseek-flash");
  await addThread({ home, id: "shared-1", bytes: 1024 });
  // 再塞一段大文本，制造空闲页，VACUUM 才有可回收的空间。
  const history = path.join(home, "thread_history_1.sqlite");
  await sqlite(history, `insert into thread_items (thread_id, payload) values ('shared-1', '${"z".repeat(400000)}');`);
  const before = (await fs.stat(history)).size;

  const plan = await cleanupPlan({ root, officialHome });
  await applyCleanup({ root, plan, confirm: true });
  const after = (await fs.stat(history)).size;
  assert.ok(after < before, `任务库应收缩：${before} -> ${after}`);
});

test("磁盘治理：剩余空间按容量算，APFS 上不能把 10% 报成 80%", { skip: isWindowsTest }, async () => {
  const disk = await systemDisk("/");
  const { stdout } = await execFileAsync("/bin/df", ["-k", "/"]);
  const columns = String(stdout).trim().split("\n").at(-1).split(/\s+/);
  const expected = (Number(columns[3]) / Number(columns[1])) * 100;
  // 两次 df 之间磁盘还会有少量读写，所以留 1 个百分点的余量；
  // 要抓的回归是把 free/(used+free) 当分母（本机 10% 会算成 80%）那种量级的错。
  assert.ok(Math.abs(disk.freePercent - expected) < 1, `剩余比例应按容量算：得到 ${disk.freePercent}，应为 ${expected}`);
  assert.ok(disk.freePercent <= 100);
  assert.ok(Math.abs(disk.freeBytes - Number(columns[3]) * 1024) < 2 * 1024 ** 3);
});

test("磁盘治理：占用统计把每窗口的数字汇总出来", async (context) => {
  const { root, officialHome } = await fixture(context);
  await addThread({ home: officialHome, id: "shared-1", bytes: 10 });
  const home = continuationHome(root, "deepseek-flash");
  await addThread({ home, id: "shared-1", bytes: 2048 });
  const plan = await cleanupPlan({ root, officialHome });
  const usage = await diskUsage({ root, plan });
  assert.ok(usage.totalBytes > 0);
  assert.equal(usage.reclaimable, plan.reclaimBytes);
  assert.equal(usage.perWindow.length, plan.windows.length);
  assert.ok(usage.freeDiskPercent > 0 && usage.freeDiskPercent <= 100);
});

// 造一个窗口的浏览器数据目录：白名单里的缓存 + 必须保住的东西（登录态、白名单外的目录）。
async function addBrowserData(root, windowID, { cacheBytes = 4096 } = {}) {
  const base = path.join(root, "windows-v1", windowID, "browser-data");
  const files = {
    "component_crx_cache/component.crx": cacheBytes,
    "GraphiteDawnCache/dawn.bin": cacheBytes,
    "Default/Cache/data_0": cacheBytes,
    "Default/Code Cache/js": cacheBytes,
    "Default/Local Storage/leveldb/CURRENT": 512,
    "Default/Network/Cookies": 512,
    "KeepMe/important.bin": 2048,
  };
  for (const [relative, bytes] of Object.entries(files)) {
    const file = path.join(base, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "x".repeat(bytes));
  }
  return base;
}

test("磁盘治理：只清浏览器缓存白名单，登录态和白名单外的目录一律不动", async (context) => {
  const { root, officialHome } = await fixture(context);
  const base = await addBrowserData(root, "w2");

  const plan = await cleanupPlan({ root, officialHome });
  const relatives = plan.caches.map((item) => item.relative).sort();
  assert.deepEqual(relatives, ["Default/Cache", "Default/Code Cache", "GraphiteDawnCache", "component_crx_cache"]);
  assert.equal(plan.cacheBytes, 4 * 4096);
  assert.equal(plan.reclaimBytes, plan.threadBytes + plan.cacheBytes);
  const summary = describePlan(plan);
  assert.equal(summary.caches.count, 4);
  assert.equal(summary.caches.bytes, 4 * 4096);

  const result = await applyCleanup({ root, plan, confirm: true });
  assert.equal(result.deletedCacheDirs, 4);
  await assert.rejects(() => fs.access(path.join(base, "component_crx_cache")), /ENOENT/);
  await assert.rejects(() => fs.access(path.join(base, "Default/Cache")), /ENOENT/);
  await fs.access(path.join(base, "Default/Local Storage/leveldb/CURRENT"));
  await fs.access(path.join(base, "Default/Network/Cookies"));
  await fs.access(path.join(base, "KeepMe/important.bin"));
  await fs.access(path.join(base, "Default"));

  const again = await cleanupPlan({ root, officialHome });
  assert.equal(again.caches.length, 0, "第二次没有缓存可清（幂等）");
});

test("磁盘治理：窗口在跑时它的浏览器缓存也不动，关闭后才清", async (context) => {
  const { root, officialHome } = await fixture(context);
  const base = await addBrowserData(root, "w2");
  const plan = await cleanupPlan({ root, officialHome, runningIds: new Set(["w2"]) });
  assert.deepEqual(plan.caches, []);
  assert.equal(plan.cacheBytes, 0);
  assert.match(plan.skipped.find((entry) => entry.id === "w2").reason, /正在运行/);
  await fs.access(path.join(base, "component_crx_cache/component.crx"));
});

test("磁盘治理：启动前自动清理只清这一个窗口的不重要副本，官方原件和重要会话都在", async (context) => {
  const { root, officialHome } = await fixture(context);
  const now = Date.now();
  const fresh = Math.floor(now / 1000);
  const ancient = Math.floor(now / 1000) - (staleDays + 5) * 86400;
  const officialFresh = await addThread({ home: officialHome, id: "fresh-live", bytes: 10, updatedAt: fresh });
  const officialArchived = await addThread({ home: officialHome, id: "archived-one", bytes: 10, updatedAt: fresh, archived: 1 });
  const officialOld = await addThread({ home: officialHome, id: "old-live", bytes: 10, updatedAt: ancient });

  const router = routerHome(root);
  const routerFresh = await addThread({ home: router, id: "fresh-live", bytes: 1024, updatedAt: fresh });
  const routerArchived = await addThread({ home: router, id: "archived-one", bytes: 2048, updatedAt: fresh });
  const routerOld = await addThread({ home: router, id: "old-live", bytes: 4096, updatedAt: ancient });
  const routerOwn = await addThread({ home: router, id: "router-own", bytes: 8192, updatedAt: fresh, title: "工作窗口自己的对话" });
  const base = await addBrowserData(root, "w2");

  const result = await cleanupWindowOnLaunch({ root, officialHome, windowID: "router", home: router, now });
  assert.equal(result.deletedThreads, 2, "已归档 + 超 30 天各一条");
  assert.deepEqual(result.reasons.sort(), ["副本 · 官方已归档", `副本 · 超 ${staleDays} 天`]);
  await assert.rejects(() => fs.access(routerArchived), /ENOENT/);
  await assert.rejects(() => fs.access(routerOld), /ENOENT/);
  await fs.access(routerFresh);
  await fs.access(routerOwn);
  // 官方库是权威、只读：三条原件必须原样都在。
  await fs.access(officialFresh);
  await fs.access(officialArchived);
  await fs.access(officialOld);
  // 只清被点名的窗口：别的窗口缓存不受影响。
  await fs.access(path.join(base, "component_crx_cache/component.crx"));

  const again = await cleanupWindowOnLaunch({ root, officialHome, windowID: "router", home: router, now });
  assert.equal(again.deletedThreads, 0, "第二次没有可清的（幂等）");
  assert.equal(again.freedBytes, 0);

  const off = await cleanupWindowOnLaunch({ root, officialHome, windowID: "router", home: router, now, policy: { autoCleanupOnLaunch: false } });
  assert.match(off.skipped, /关闭/);
});

test("磁盘策略：读出来有默认值，保存时校验类型并递增版本", async (context) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cma-policy-"));
  context.after(() => fs.rm(base, { recursive: true, force: true }));
  const store = { root: path.join(base, "model-assistant") };

  const initial = await readDiskPolicy(store);
  assert.deepEqual(initial, { ...defaultDiskPolicy });
  assert.equal(initial.autoCleanupOnLaunch, true);

  const saved = await saveDiskPolicy(store, { ...initial, autoCleanupOnLaunch: false });
  assert.equal(saved.autoCleanupOnLaunch, false);
  assert.equal(saved.revision, initial.revision + 1);
  assert.equal((await readDiskPolicy(store)).autoCleanupOnLaunch, false);

  await assert.rejects(() => saveDiskPolicy(store, { ...saved, pruneBrowserCache: "yes" }), /true 或 false/);
  await assert.rejects(() => saveDiskPolicy(store, { revision: 1, autoCleanupOnLaunch: true }), /true 或 false/);
});

// 官方库清理是唯一会动 ~/.codex 的操作：只清已归档、必须确认、官方在跑就拒绝。
test("官方库清理：只删已归档会话，未归档的与窗口数据一律不动", async (context) => {
  const { root, officialHome } = await fixture(context);
  const now = Math.floor(Date.now() / 1000);
  const ancient = now - (staleDays + 5) * 86400;
  const archivedFile = await addThread({ home: officialHome, id: "arch-1", bytes: 4096, updatedAt: now, archived: 1 });
  const archivedOld = await addThread({ home: officialHome, id: "arch-old", bytes: 2048, updatedAt: ancient, archived: 1 });
  const liveOld = await addThread({ home: officialHome, id: "live-old", bytes: 8192, updatedAt: ancient, archived: 0 });
  const liveNew = await addThread({ home: officialHome, id: "live-new", bytes: 1024, updatedAt: now, archived: 0 });
  // 窗口里放一份副本，清理官方库不应该碰它（那是另一件事）
  const winHome = continuationHome(root, "deepseek-flash");
  const windowCopy = await addThread({ home: winHome, id: "arch-1", bytes: 4096, updatedAt: now });

  const plan = await officialArchivedPlan({ officialHome });
  assert.deepEqual(plan.items.map((item) => item.id).sort(), ["arch-1", "arch-old"]);
  assert.equal(plan.reclaimBytes, 4096 + 2048);
  assert.ok(plan.items.every((item) => item.reason === "官方库 · 已归档"));

  await assert.rejects(() => applyOfficialArchived({ root, officialHome, plan, confirm: false }), /不可恢复/);
  await fs.access(archivedFile);
  await assert.rejects(() => applyOfficialArchived({ root, officialHome, plan, confirm: true, officialRunning: true }), /ChatGPT Desktop（官方）正在运行/);
  await fs.access(archivedFile);

  const result = await applyOfficialArchived({ root, officialHome, plan, confirm: true });
  assert.equal(result.deletedThreads, 2);
  assert.equal(result.deletedFiles, 2);
  await assert.rejects(() => fs.access(archivedFile), /ENOENT/);
  await assert.rejects(() => fs.access(archivedOld), /ENOENT/);
  await fs.access(liveOld);
  await fs.access(liveNew);
  await fs.access(windowCopy);
  assert.equal(await rowCount(path.join(officialHome, "state_5.sqlite"), "threads", "arch-1", "id"), 0);
  assert.equal(await rowCount(path.join(officialHome, "state_5.sqlite"), "threads", "live-old", "id"), 1);
  assert.equal(await rowCount(path.join(winHome, "state_5.sqlite"), "threads", "arch-1", "id"), 1, "窗口里的副本不受官方库清理影响");

  const manifest = JSON.parse(await fs.readFile(result.backupManifest, "utf8"));
  assert.equal(manifest.kind, "official-archived");
  assert.equal(manifest.items.length, 2);
  assert.equal((await officialArchivedPlan({ officialHome })).items.length, 0, "第二次没有可清的（幂等）");
});

test("官方实例判定：只有命令行里完全没提助手目录的 Codex 才算官方在跑", () => {
  const ps = [
    "  100 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    "  101 /Applications/Codex.app/Contents/MacOS/ChatGPT",
    "  202 /Applications/Codex.app/Contents/MacOS/ChatGPT --user-data-dir=/Users/x/.codex/model-assistant/router-v1/browser-data",
    "  303 /Applications/Codex.app/Contents/MacOS/ChatGPT --type=renderer --database=/Users/x/.codex/model-assistant/windows-v1/w2/browser-data/Crashpad",
    "  404 /usr/sbin/other --user-data-dir=/tmp/nope",
  ].join("\n");
  const found = parseOfficialRunning(ps, "/Users/x/.codex/model-assistant");
  assert.deepEqual(found.map((entry) => entry.pid), [100, 101]);
  const onlyManaged = ps
    .replace("  100 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n", "")
    .replace("  101 /Applications/Codex.app/Contents/MacOS/ChatGPT\n", "");
  assert.equal(parseOfficialRunning(onlyManaged, "/Users/x/.codex/model-assistant").length, 0);
});

// 按时间清官方库旧会话：风险更高，所以必须显式给天数，并且默认先打包归档再删。
test("官方库按时间清理：选出超期旧会话，先打包归档再删，归档里能解回原文", async (context) => {
  const { root, officialHome } = await fixture(context);
  const now = Date.now();
  const fresh = Math.floor(now / 1000);
  const ancient = Math.floor(now / 1000) - (staleDays + 5) * 86400;
  const archived = await addThread({ home: officialHome, id: "arch-1", bytes: 2048, updatedAt: fresh, archived: 1, title: "已归档" });
  const old = await addThread({ home: officialHome, id: "old-1", bytes: 4096, updatedAt: ancient, title: "很旧但没归档" });
  const recent = await addThread({ home: officialHome, id: "new-1", bytes: 1024, updatedAt: fresh, title: "新的" });

  // 不给天数时只清已归档
  const archivedOnly = await officialArchivedPlan({ officialHome, now });
  assert.deepEqual(archivedOnly.items.map((item) => item.id), ["arch-1"]);
  // 给了天数才把「没归档但很旧」的算进来
  const withAge = await officialArchivedPlan({ officialHome, olderThanDays: staleDays, now });
  assert.deepEqual(withAge.items.map((item) => item.id).sort(), ["arch-1", "old-1"]);
  const reasons = Object.fromEntries(withAge.items.map((item) => [item.id, item.reason]));
  assert.equal(reasons["arch-1"], "官方库 · 已归档");
  assert.equal(reasons["old-1"], `官方库 · 超 ${staleDays} 天`);

  const archiveDir = path.join(root, "archive");
  const plan = await officialArchivedPlan({ officialHome, olderThanDays: staleDays, now });
  const result = await applyOfficialArchived({ root, officialHome, plan, confirm: true, archiveDir });
  assert.equal(result.deletedThreads, 2);
  assert.ok(result.archive, "应当生成归档包");
  assert.equal(result.archive.count, 2);
  assert.match(result.archive.file, /official-archive-.*\.tar\.gz$/);
  assert.ok(result.archive.bytes > 0);
  await assert.rejects(() => fs.access(archived), /ENOENT/);
  await assert.rejects(() => fs.access(old), /ENOENT/);
  await fs.access(recent);
  assert.equal(await rowCount(path.join(officialHome, "state_5.sqlite"), "threads", "new-1", "id"), 1);

  // 归档包能解出原始 rollout，且附了说明
  await fs.access(`${result.archive.file}.txt`);
  const extractDir = path.join(root, "extract");
  await fs.mkdir(extractDir, { recursive: true });
  await execFileAsync(tarTestBinary, ["-xzf", result.archive.file, "-C", extractDir]);
  // 解包出来保持 sessions/ 原样结构，路径可预测
  const restored = await fs.readdir(path.join(extractDir, "sessions"));
  assert.deepEqual(restored.sort(), ["arch-1.jsonl", "old-1.jsonl"]);
  assert.equal(await officialArchivedPlan({ officialHome, olderThanDays: staleDays, now }).then((p) => p.items.length), 0, "再次执行为空（幂等）");
});

test("归档包比原始 rollout 小（JSONL 压缩比），否则这套方案就不划算", async (context) => {
  const { root, officialHome } = await fixture(context);
  const ancient = Math.floor(Date.now() / 1000) - (staleDays + 5) * 86400;
  // 造一点像真实 rollout 的重复 JSON 文本
  await addThread({ home: officialHome, id: "old-a", bytes: 200000, updatedAt: ancient });
  const plan = await officialArchivedPlan({ officialHome, olderThanDays: staleDays });
  const result = await applyOfficialArchived({ root, officialHome, plan, confirm: true, archiveDir: path.join(root, "archive") });
  assert.ok(result.archive.bytes < plan.reclaimBytes, `归档 ${result.archive.bytes} 应小于原始 ${plan.reclaimBytes}`);
});
