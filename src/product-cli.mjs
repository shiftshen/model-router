import { ModelStore, atomicJSON, validID } from "./model-store.mjs";
import path from "node:path";
import os from "node:os";
import { ProductService } from "./product-service.mjs";
import { limitedJSON } from "./model-gateway.mjs";
import { legacyWindowID } from "./window-registry.mjs";
import { applyCleanup, applyOfficialArchived, cleanupPlan, describePlan, diskUsage, officialArchivedPlan } from "./disk-cleanup.mjs";
import { readDiskPolicy, saveDiskPolicy } from "./disk-policy.mjs";
import { readRecentRoutes, readUsageReport } from "./product-service.mjs";
import { resolveContextWindow } from "./model-windows.mjs";
import { liveThreadRows } from "./thread-ledger.mjs";
import { checkForUpdate, prepareUpdate } from "./update-service.mjs";
import { readCallLog, readWatchState, summarizeCalls } from "./deepseek-watch.mjs";
import { summarizeValidation, scoreValidation, validationPrompt, validationTasks } from "./model-validation.mjs";
import { gatewayURL } from "./model-gateway.mjs";
import { runTask } from "./task-executor.mjs";

const store = new ModelStore();
const service = new ProductService(store);
const [command = "library", id] = process.argv.slice(2);

// 官方库永远是权威、也只读：副本判定拿它当基准，清理绝不动它。
function officialHome() {
  return path.join(os.homedir(), ".codex");
}

export function humanBytes(bytes) {
  const value = Number(bytes) || 0;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${index === 0 ? size : size.toFixed(size >= 100 ? 0 : 1)} ${units[index]}`;
}

async function main() {
  if (command === "run-task") {
    const task = await limitedJSON(process.stdin, 128 * 1024);
    const result = await runTask(task, { store });
    return {
      ...result,
      ok: result.acceptance?.passed === true,
      message: result.acceptance?.passed === true
        ? "任务已通过验收"
        : result.status === "rejected" ? "没有符合本次任务要求的已验证路线" : "任务未通过验收",
    };
  }
  if (command === "library") {
    await store.read();
    await service.migrateSecrets();
    const data = await store.publicData();
    return {
      ...data,
      diskPolicy: await readDiskPolicy(store),
      ...(await service.switchSummary()),
      // 「哪个对话在用哪个模型」：Codex 的模型是按对话存的，窗口标题不代表对话归属。
      // 扫盘失败不该拖垮整个模型库，所以这里只降级成空列表。
      threads: await liveThreadRows(store.root, data.routes).catch(() => []),
    };
  }
  if (command === "save") {
    const input = await limitedJSON(process.stdin, 1024 * 1024);
    await store.save(input.route, input.revision, input.key, input.clearKey);
    let syncNote = "";
    try {
      const synced = await service.refreshRouteHomes(input.route.id);
      await service.refreshCatalogs();
      syncNote = synced.skipped.length ? "；正在运行的专用窗口需重开后应用新模型" : "；已有专用窗口配置已同步";
    } catch (error) { syncNote = `；窗口配置同步失败，重开前请重试保存：${error.message}`; }
    return { ...(await store.publicData()), message: `配置已保存${syncNote}；密钥留空时保留原值，修改端点后需重新填写密钥` };
  }
  if (command === "archive") {
    const input = await limitedJSON(process.stdin, 1024 * 1024);
    const route = await store.route(id);
    if (id === "official") throw new Error("官方恢复入口不能归档");
    await store.save({ ...route, archived: input.archived }, input.revision);
    return { ...(await store.publicData()), message: input.archived ? "已归档，可在归档列表中恢复" : "已恢复" };
  }
  if (command === "discover") return service.discover(await store.route(id));
  if (command === "check") return service.check(id);
  if (command === "autodetect") return { ...(await service.detectProtocol(id)), ...(await store.publicData()) };
  if (command === "probe") {
    try { const result = await service.probe(id); return { ...result, ...(await store.publicData()) }; }
    catch (error) {
      if (validID(id)) await atomicJSON(path.join(store.root, "checks", `${id}.json`), { ok: false, testedAt: new Date().toISOString() });
      return { ok: false, message: error.message, ...(await store.publicData()) };
    }
  }
  if (command === "validate-models") {
    const live = process.argv.includes("--live");
    const requested = String(id || "").trim();
    const data = await store.read();
    const selectedRoutes = data.routes.filter((route) => !route.archived && route.protocol !== "oauth" && route.protocol !== "chatgpt" && route.model && (!requested || route.id === requested));
    if (requested && !selectedRoutes.length) throw new Error("找不到可验证的已启用第三方模型");
    const routeReadiness = await Promise.all(selectedRoutes.map(async (route) => ({ route, ready: route.noKey || Boolean(await store.secret(route.credentialID)) })));
    if (live && requested && !routeReadiness[0].ready) throw new Error("请先配置 API Key；未发起验证请求，也未写入零分报告");
    const routes = live ? routeReadiness.filter((entry) => entry.ready).map((entry) => entry.route) : selectedRoutes;
    if (!live) {
      return { mode: "dry-run", tasks: validationTasks.map(({ id: taskId, category }) => ({ id: taskId, category })), routes: routes.map(({ id: routeId, name, model, protocol }) => ({ id: routeId, name, model, protocol })), message: "这是验证计划；加 --live 才会向模型发送测试请求并消耗额度" };
    }
    await service.gatewayReady();
    const reports = [];
    for (const route of routes) {
      // Local managed models need their service started before the gateway can
      // validate them. Remote routes simply return { managed: false }.
      await service.ensureManagedLocalService(route);
      const credentialVersion = await store.credentialVersion(route.credentialID);
      const results = [];
      for (const task of validationTasks) {
        const started = Date.now();
        try {
          const response = await fetch(`${gatewayURL}/routes/${route.id}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${await store.token(route.id)}` },
            body: JSON.stringify({ model: route.model, input: validationPrompt(task), max_output_tokens: 700, stream: false }),
            signal: AbortSignal.timeout(120000),
          });
          const body = await limitedJSON(response.body, 4 * 1024 * 1024);
          const text = body?.output?.filter((item) => item?.type === "message").flatMap((item) => item.content || []).map((part) => part.text || "").join("") || "";
          if (!response.ok) throw new Error(body?.error?.message || `HTTP ${response.status}`);
          results.push({ ...scoreValidation(task, text), latencyMs: Date.now() - started });
        } catch (error) {
          results.push({ taskId: task.id, category: task.category, passed: 0, total: 1, score: 0, validJSON: false, reasons: [error.message], latencyMs: Date.now() - started });
        }
      }
      const report = summarizeValidation(route, results, { mode: "live" });
      const currentRoute = await store.route(route.id);
      const currentCredentialVersion = await store.credentialVersion(route.credentialID);
      if (currentRoute.model !== route.model || currentRoute.endpoint !== route.endpoint || currentRoute.protocol !== route.protocol || currentRoute.credentialID !== route.credentialID || currentCredentialVersion !== credentialVersion) {
        throw new Error(`模型 ${route.id} 的配置或凭据在验证期间发生变化；本次结果不授予资格，请重新验证`);
      }
      await atomicJSON(path.join(store.root, "validation", `${route.id}.json`), {
        testedAt: new Date().toISOString(),
        ...report,
        endpoint: route.endpoint,
        protocol: route.protocol,
        credentialVersion,
      });
      reports.push(report);
    }
    return { mode: "live", reports, skippedUnconfigured: routeReadiness.length - routes.length, message: `已完成 ${reports.length} 个模型的能力验证；跳过 ${routeReadiness.length - routes.length} 个未配置凭据的模型。结果仅写入本地 validation 目录，不包含 Key` };
  }
  if (command === "start-gateway") return service.startGateway();
  // 旧客户端仍会调用 launch；3.3.1 起把它重定向到统一可切换窗口。
  if (command === "launch") return service.openCodex(id);
  // 侧边栏点一个模型：开着的窗口优先复用，官方入口开真官方。
  if (command === "open-codex") return service.openCodex(id || "");
  if (command === "delete-unmanaged-window") return service.deleteUnmanagedWindow(id || "");
  // 「今天我的请求都去了谁」：跟两边后台对账用的。
  if (command === "usage-report") {
    const days = Number(id) > 0 ? Number(id) : 1;
    const report = await readUsageReport(store.root, days);
    const lines = report.map((entry) => {
      const hosts = Object.entries(entry.hosts).map(([h, n]) => `${h} ×${n}`).join("、") || "无请求";
      const fb = Object.entries(entry.fallbacks).map(([h, n]) => `${h} ×${n}`).join("、");
      const sm = Object.entries(entry.summaries ?? {}).map(([h, n]) => `${h} ×${n}`).join("、");
      const notes = [fb ? `备用：${fb}` : "无备用", sm ? `含压缩摘要：${sm}` : ""].filter(Boolean).join("，");
      return `${entry.day}：${entry.total} 次 —— ${hosts}（${notes}）`;
    });
    return { ok: true, report, message: lines.join("\n") || "还没有记录" };
  }
  // 「我的请求到底走了谁」：直接列最近若干次请求的实际上游。
  if (command === "recent-routes") {
    const routes = await readRecentRoutes(store.root, Number(id) > 0 ? Number(id) : 10);
    const hostCount = {};
    for (const entry of routes) hostCount[entry.host] = (hostCount[entry.host] || 0) + 1;
    return {
      ...(await readRecentRoutes(store.root, 10)),
      ok: true,
      routes,
      hostCount,
      message: routes.length
        ? `最近 ${routes.length} 次请求：${Object.entries(hostCount).map(([h, n]) => `${h} ×${n}`).join("、")}`
        : "还没有记录（网关重启后才会开始记录）",
    };
  }
  if (command === "route-status") {
    return { ok: true, recentRoutes: await readRecentRoutes(store.root, 30) };
  }
  if (command === "live-threads") {
    const minutes = Number(id) > 0 ? Number(id) : 30;
    const rows = await liveThreadRows(store.root, (await store.read()).routes, { withinMinutes: minutes });
    const lines = rows.map((row) => {
      const where = row.cwd ? row.cwd.split("/").slice(-1)[0] : "?";
      const who = row.title ? `「${row.title}」` : `(${row.id.slice(0, 8)})`;
      return `${row.scope} · ${where} ${who} → ${row.model || "未知模型"}：${row.billing.label}`;
    });
    return {
      ok: true,
      threads: rows,
      message: lines.join("\n") || `最近 ${minutes} 分钟没有活跃对话`,
    };
  }
  // 「这台机器上还有谁在调 DeepSeek」：对扣费最直接的疑问。配置里换了模型
  // 不等于没人再打那个端点——压缩、后备链、别的程序都可能绕过去，这个命令
  // 读后台监控抓到的实际连接，按程序归类，不再靠推断。
  if (command === "deepseek-watch") {
    const records = await readCallLog(Number(id) > 0 ? Number(id) : 500);
    const summary = summarizeCalls(records);
    const state = await readWatchState();
    const lines = summary.map((entry) => {
      const at = new Date(Date.parse(entry.last) + 7 * 3600e3).toISOString().slice(11, 19);
      return `${entry.kind} ×${entry.count}（最近一次 ${at}）`;
    });
    return {
      ok: true,
      state,
      summary,
      calls: records.slice(-40).reverse(),
      message: lines.length ? lines.join("\n") : "还没有抓到任何对 DeepSeek 的调用",
    };
  }
  if (command === "continue") return service.launch(id, { continueExisting: true });
  if (command === "switch-status") return service.switchSummary();
  if (command === "windows") return service.switchSummary();
  // 把模型目录参数（含 Codex 自己的压缩阈值）同步到所有窗口，不必关掉正在用的窗口。
  if (command === "refresh-catalogs") return service.refreshCatalogs();
  // 新窗口：每个窗口一份独立的 CODEX_HOME + 浏览器数据目录，可以同时开多个、各自换模型。
  if (command === "new-window") return service.createWindow(id || "");
  if (command === "open-window") return service.openWindow(id || legacyWindowID);
  if (command === "rename-window") return service.renameWindow(id, process.argv[4] || "");
  if (command === "close-window") return service.closeWindow(id);
  if (command === "delete-window") return service.deleteWindow(id);
  // 接管在跑但没登记进注册表的窗口（并发建窗时代可能留下的孤儿进程）。
  if (command === "adopt-window") return service.adoptWindows(id || "all");
  // 清掉「只有项目名字、点开没聊天」的空分组（归属指向了本窗口不存在的会话）。
  if (command === "prune-empty-projects") return service.pruneEmptyProjects({ dryRun: process.argv.includes("--dry-run") });
  // 磁盘策略：控制「窗口启动前自动清理不重要副本」和「顺手清浏览器缓存」两个开关。
  if (command === "disk-policy") return { diskPolicy: await readDiskPolicy(store), message: "磁盘策略已读取" };
  // 官方库已归档会话：删的是原件、不可恢复，所以只认 --confirm，且 ChatGPT Desktop（官方）在跑时直接拒绝。
  if (command === "cleanup-official-plan" || command === "cleanup-official-apply") {
    const home = officialHome();
    // --older-than <天>：连「没归档但超过 N 天」的旧会话一起清（风险更高，必须显式给天数）。
    const olderIndex = process.argv.indexOf("--older-than");
    const olderThanDays = olderIndex > 0 && Number(process.argv[olderIndex + 1]) > 0 ? Number(process.argv[olderIndex + 1]) : null;
    // --archive <目录>：先打包再删，保底可恢复。
    const archiveIndex = process.argv.indexOf("--archive");
    const archiveDir = archiveIndex > 0 ? String(process.argv[archiveIndex + 1] ?? "") : "";
    const official = await officialArchivedPlan({ officialHome: home, olderThanDays });
    const running = await service.officialCodexRunning();
    const officialArchive = { count: official.items.length, bytes: official.reclaimBytes, officialRunning: running.length > 0, runningDetail: running[0]?.args ?? "" };
    if (command === "cleanup-official-plan") {
      return {
        officialArchive,
        officialSessions: {
          count: official.items.length,
          bytes: official.reclaimBytes,
          olderThanDays,
          byReason: official.items.reduce((acc, item) => { acc[item.reason] = (acc[item.reason] ?? 0) + 1; return acc; }, {}),
          sample: official.items.slice(0, 10).map(({ id, title, bytes, reason }) => ({ id, title: String(title).slice(0, 60), bytes, reason })),
        },
        message: official.items.length
          ? `官方库可清理 ${official.items.length} 条会话，共 ${humanBytes(official.reclaimBytes)}${olderThanDays ? `（含超 ${olderThanDays} 天的旧会话）` : "（仅已归档）"}${officialArchive.officialRunning ? "；但 ChatGPT Desktop（官方）正在运行，请先退出官方窗口" : ""}`
          : "官方库没有可清理的会话",
      };
    }
    const result = await applyOfficialArchived({ root: store.root, officialHome: home, plan: official, confirm: process.argv.includes("--confirm"), officialRunning: running.length > 0, archiveDir });
    const after = await officialArchivedPlan({ officialHome: home });
    return {
      officialCleanup: result,
      officialArchive: { count: after.items.length, bytes: after.reclaimBytes, officialRunning: false },
      message: result.deletedThreads
        ? `已删除官方库 ${result.deletedThreads} 条会话、${result.deletedFiles} 个文件，释放 ${humanBytes(result.freedBytes)}（官方库目录 ${humanBytes(result.beforeBytes)} → ${humanBytes(result.afterBytes)}）`
          + `${result.archive ? `；已先打包 ${result.archive.count} 个文件到 ${result.archive.file}（${humanBytes(result.archive.bytes)}）` : ""}`
          + `；审计清单：${result.backupManifest}`
        : "官方库没有需要清理的会话",
    };
  }
  if (command === "set-disk-policy") {
    const input = await limitedJSON(process.stdin, 16000);
    const saved = await saveDiskPolicy(store, input);
    return { diskPolicy: saved, message: `已保存：启动前自动清理${saved.autoCleanupOnLaunch ? "开启" : "关闭"}，浏览器缓存清理${saved.pruneBrowserCache ? "开启" : "关闭"}` };
  }
  // 磁盘治理：先看占用、再看计划，最后必须显式 --confirm 才真删。三件事拆开，避免误删。
  if (command === "disk-usage" || command === "cleanup-plan" || command === "cleanup-apply") {
    const root = store.root;
    const runningIds = new Set([...(await service.runningWindows()).keys()]);
    const build = () => cleanupPlan({ root, officialHome: officialHome(), runningIds });
    const plan = await build();
    // 官方库的已归档会话单独算一份：它删的是原件、不可恢复，必须和窗口副本分开呈现、分开确认。
    const official = await officialArchivedPlan({ officialHome: officialHome() });
    const officialRunning = await service.officialCodexRunning();
    const officialArchive = {
      count: official.items.length,
      bytes: official.reclaimBytes,
      officialRunning: officialRunning.length > 0,
      runningDetail: officialRunning[0]?.args ?? "",
    };
    if (command === "disk-usage" || command === "cleanup-plan") {
      const disk = await diskUsage({ root, plan });
      return {
        disk,
        cleanupPlan: describePlan(plan),
        diskPolicy: await readDiskPolicy(store),
        officialArchive,
        message: command === "disk-usage"
          ? `助手目录占用 ${humanBytes(disk.totalBytes)}，其中可回收 ${humanBytes(disk.reclaimable)}；系统剩余 ${disk.freeDiskPercent.toFixed(1)}%`
          : plan.items.length
            ? `可回收 ${humanBytes(plan.reclaimBytes)}：${plan.items.length} 个会话副本、${plan.caches.length} 个缓存目录（${plan.keepOriginals.count} 条原件保留、不删）`
            : plan.caches.length
              ? `可回收 ${humanBytes(plan.reclaimBytes)}：${plan.caches.length} 个浏览器缓存目录（会话副本没有可回收的）`
              : "没有可回收的会话副本",
      };
    }
    const result = await applyCleanup({ root, plan, confirm: process.argv.includes("--confirm"), runningIds });
    const after = await build();
    const skippedNote = result.skippedRunning?.length
      ? `；${result.skippedRunning.map((entry) => `${entry.id} 正在运行，${entry.threads} 个副本留到它关闭后再清`).join("；")}`
      : "";
    const parts = [];
    if (result.deletedThreads) parts.push(`${result.deletedThreads} 个会话副本、${result.deletedFiles} 个文件`);
    if (result.deletedCacheDirs) parts.push(`${result.deletedCacheDirs} 个缓存目录`);
    return {
      disk: await diskUsage({ root, plan: after }),
      cleanup: result,
      cleanupPlan: describePlan(after),
      diskPolicy: await readDiskPolicy(store),
      officialArchive,
      message: parts.length
        ? `已删除 ${parts.join("、")}，释放 ${humanBytes(result.freedBytes)}；审计清单：${result.backupManifest}${skippedNote}`
        : `没有需要清理的内容${skippedNote}`,
    };
  }
  // 遗留入口：等价于打开「窗口 1」。
  if (command === "switch-window") return service.launchSwitchWindow(id || "");
  if (command === "import-history") return service.importHistory(id || "all");
  if (command === "repair-work-window") return service.repairSwitchWindowMetadata(id || "all");
  if (command === "enable-switching") return { ...(await service.setSwitching(id, true)), ...(await store.publicData()) };
  if (command === "disable-switching") return { ...(await service.setSwitching(id, false)), ...(await store.publicData()) };
  if (command === "setup-official") {
    // 兼容旧入口：历史版本会创建 official-gpt-* 隐藏条目，现已废弃。
    // ModelStore.read() 会自动迁移删除；这里不再重新创建，官方只保留唯一的本机 Codex 入口。
    return { ...(await store.publicData()), message: "官方入口已统一为「本机 Codex」：模型请在原版 Codex 顶部选择。" };
  }
  if (command === "set-fallback") {
    const data = await store.read();
    const route = data.routes.find((entry) => entry.id === id);
    if (!route) throw new Error("模型不存在");
    const fallback = process.argv[4] || "";
    await store.save({ ...route, fallback }, data.revision);
    const target = fallback ? (await store.route(fallback)).name : "不设置";
    return { ...(await store.publicData()), message: `「${route.name}」失败时改用：${target}` };
  }
  if (command === "hide") {
    const data = await store.read();
    const route = data.routes.find((entry) => entry.id === id);
    if (!route) throw new Error("模型不存在");
    await store.save({ ...route, hidden: process.argv[4] !== "off" }, data.revision);
    return { ...(await store.publicData()), message: `「${route.name}」${process.argv[4] === "off" ? "已取消隐藏" : "已隐藏（仍在工作窗口里可选）"}` };
  }
  if (command === "check-update") {
    const currentVersion = id || "";
    const platform = process.argv[4] || process.platform;
    const variant = process.argv[5] || "installed";
    const update = await checkForUpdate({ currentVersion, platform, variant });
    return { ok: true, update, message: update.message };
  }
  if (command === "prepare-update") {
    const currentVersion = id || "";
    const platform = process.argv[4] || process.platform;
    const appPid = Number(process.argv[5] || 0);
    const appPath = process.argv[6] || "";
    const portable = process.argv[7] === "portable";
    const update = await prepareUpdate({ currentVersion, platform, root: store.root, appPid, appPath, portable });
    return { ok: true, update, message: update.available ? (update.prepared ? `新版本 ${update.latestVersion} 已下载，准备安装` : update.message) : update.message };
  }
  if (command === "sync-official-models") throw new Error("稳定版官方模型请在原官方窗口使用；API 工作窗口不混用官方登录");
  if (command === "sync-account") {
    const synced = await service.syncOfficialAuthHomes();
    return {
      ...(await service.switchSummary()),
      message: synced.account.signedIn
        ? "已刷新官方入口账号状态；API 窗口不共享此账号"
        : "当前没有可同步的官方 ChatGPT 登录，请先在官方客户端登录",
    };
  }
  if (command === "prepare") return service.prepare(id);
  if (command === "diagnostics") return service.diagnostics();
  if (command === "export") return { exportData: JSON.stringify(await store.read(), null, 2), message: "导出不包含 API Key 和登录凭据" };
  if (command === "import") {
    const input = await limitedJSON(process.stdin, 4 * 1024 * 1024);
    await service.importLibrary(JSON.parse(input.data), input.revision);
    return { ...(await store.publicData()), message: "已作为新模型导入，请重新填写密钥" };
  }
  throw new Error("未知操作");
}

main().then((result) => process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n")).catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, message: error.message }) + "\n");
  process.exitCode = 1;
});
