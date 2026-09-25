import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ModelStore, atomicJSON, validateRoute } from "./model-store.mjs";
import { errorMessage, gatewayBuild, gatewayURL, upstream, limitedJSON } from "./model-gateway.mjs";
import { cleanupPlan, cleanupWindowOnLaunch, directorySize, diskUsage } from "./disk-cleanup.mjs";
import { readDiskPolicy } from "./disk-policy.mjs";
import { resolveContextWindow } from "./model-windows.mjs";
import { autoModelName, autoRouterSlug, stableRouterTable as buildRouterTable, modelInfo, routerCatalog, routerID, routerProviderID, routerTableEntry } from "./router.mjs";
import { resolveRuntimeProfile } from "./runtime-profile.mjs";
import { officialAccount, officialModels, officialTokens } from "./chatgpt-auth.mjs";
export { resolveRuntimeProfile } from "./runtime-profile.mjs";
import {
  allocateWindow,
  findWindow,
  isValidWindowID,
  legacyWindowID,
  registerRunningWindow,
  readWindowRegistry,
  removeWindow,
  updateWindow,
  windowPaths,
  windowRootCandidates,
  windowUserDataCandidates,
  windowsRootName,
} from "./window-registry.mjs";
import {
  importConversations,
  inspectConversationStore,
  inspectGlobalProjectState,
  mergeGlobalProjectState,
  readThreadIDs,
  repairProjectMetadata,
  snapshotConversations,
} from "./session-transfer.mjs";
import {
  activateProcess,
  findCodexDesktopExecutable,
  openOfficialChatGPTDesktop,
  isWindows,
  killGatewayProcesses,
  linkSharedAsset,
  normalizeProcessText,
  processCommand as platformProcessCommand,
  processListingText,
  spawnCodexDesktop,
  terminateProcessTree,
} from "./platform-runtime.mjs";

const sharedHome = path.join(os.homedir(), ".codex");
const sharedRuntimeAssets = Object.freeze(["AGENTS.md", "skills", "plugins", "requirements.toml", "hooks.json"]);
const liteBlockedRuntimeAssets = Object.freeze(["skills", "plugins", "requirements.toml", "hooks.json"]);
const liteAgentsText = `# Model Router Lite\n- 简单问题直接回答，不扫描无关项目。\n- 代码任务只读必要文件，做最小修改并运行相关检查。\n- 默认只使用 Codex 核心文件/终端/编辑能力；不要主动依赖 Plugins、MCP、Skills 或子智能体。\n- 需要完整工具生态时，把该模型的“Codex 环境”改为 Full。\n`;
const execFileAsync = promisify(execFile);

async function removeManagedAsset(target) {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) await fs.unlink(target);
    else if (stat.isDirectory()) await fs.rename(target, `${target}.disabled-${randomUUID()}`);
    else await fs.unlink(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function composeConfig(source, marker, { model, provider, catalogPath, name, baseURL, runtimeProfile = "full" }) {
  const clean = source.replace(new RegExp(`\\n?# BEGIN ${marker}[\\s\\S]*?# END ${marker}\\n?`, "g"), "\n");
  const lines = clean.split(/\r?\n/);
  const section = lines.findIndex((line) => /^\s*\[/.test(line));
  const top = (section === -1 ? lines : lines.slice(0, section)).filter((line) => runtimeProfile === "lite"
    ? /^\s*(approval_policy|sandbox_mode|model_reasoning_effort|model_verbosity)\s*=\s*("[^"\n]*"|'[^'\n]*')\s*(#.*)?$/.test(line)
    : !/^\s*(model|model_provider|model_catalog_json|service_tier|profile|cli_auth_credentials_store)\s*=/.test(line));
  const routing = [`model = ${JSON.stringify(model)}`, 'cli_auth_credentials_store = "file"'];
  if (provider) routing.push(`model_provider = "${provider}"`, `model_catalog_json = ${JSON.stringify(catalogPath)}`);
  const inheritedSections = runtimeProfile === "lite" ? "" : (section === -1 ? "" : lines.slice(section).join("\n").trim());
  const liteFeatures = runtimeProfile === "lite" ? `[features]\napps = false\nplugins = false\nmulti_agent = false\nplugin_sharing = false\nremote_plugin = false\nin_app_browser = false\nbrowser_use = false\nbrowser_use_external = false\nmemories = false\nchronicle = false\nskill_search = false` : "";
  const block = provider ? `# BEGIN ${marker}\n[model_providers.${provider}]\nname = ${JSON.stringify(name)}\nbase_url = ${JSON.stringify(baseURL)}\nenv_key = "CMA_ROUTE_TOKEN"\nwire_api = "responses"\nrequires_openai_auth = false\n# END ${marker}` : "";
  return [top.join("\n").trim(), routing.join("\n"), liteFeatures, inheritedSections, block].filter(Boolean).join("\n\n") + "\n";
}

export function renderProductConfig(source, route, catalogPath) {
  const official = route.protocol === "oauth";
  return composeConfig(source, "CODEX MODEL ASSISTANT V2", {
    model: route.model,
    provider: official ? "" : `cma_${route.id.replaceAll("-", "_")}`,
    catalogPath,
    name: route.name,
    baseURL: `${gatewayURL}/routes/${route.id}/v1`,
    runtimeProfile: resolveRuntimeProfile(route),
  });
}

export function renderRouterConfig(source, { model, catalogPath, runtimeProfile = "full" }) {
  return composeConfig(source, "CODEX MODEL ASSISTANT SWITCH WINDOW", {
    model,
    provider: routerProviderID,
    catalogPath,
    name: "Model Router · 可切换窗口",
    baseURL: `${gatewayURL}/router/v1`,
    runtimeProfile,
  });
}

export function catalog(route) {
  return { models: [modelInfo(route, route.model)] };
}

// 进程命令行里的 --user-data-dir 决定哪个窗口正在运行：模型窗口是 <root>/<instances-v2|continuations-v1>/<id>/browser-data，
// 工作窗口是 <root>/windows-v1/<id>/browser-data，遗留工作窗口是 <root>/router-v1/browser-data（仍记作 router）。
// 抽成纯函数，便于用真实 ps 输出回归。
export function runningInstancesFromPS(output, root) {
  return [...parseRunningWindows(output, root).keys()].sort();
}

// 解析出运行中的 Codex 进程属于哪个槽位：windows-v1/<id>、router-v1 由注册表管理，
// instances-v2 / continuations-v1 是更早的「一个模型一个窗口」用法，不参与注册表比对。
export function parseRunningSlots(output, root) {
  const normalizedOutput = normalizeProcessText(output);
  const rawRoot = String(root ?? "");
  const resolvedRoot = (/^[A-Za-z]:[\\/]/.test(rawRoot) || rawRoot.startsWith("/")) ? rawRoot : path.resolve(rawRoot);
  const escapedRoot = normalizeProcessText(resolvedRoot).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `--user-data-dir=${escapedRoot}/(?:(instances-v2|continuations-v1|${windowsRootName})/([^/]+)|router-v1)/browser-data`,
  );
  const found = [];
  const seen = new Set();
  for (const line of normalizedOutput.split("\n")) {
    const match = line.match(pattern);
    if (!match) continue;
    const slot = match[1] ?? "router-v1";
    const id = match[2] ?? legacyWindowID;
    if (seen.has(`${slot}/${id}`)) continue;
    seen.add(`${slot}/${id}`);
    const pid = Number((line.match(/^\s*(\d+)\s/) || [])[1]);
    found.push({ slot, id, pid: Number.isInteger(pid) ? pid : 0 });
  }
  return found;
}

// 同一个窗口可能有多个子进程共用同一 user-data-dir（主进程 + 渲染进程），取最先出现的那个 pid。
export function parseRunningWindows(output, root) {
  const found = new Map();
  for (const entry of parseRunningSlots(output, root)) {
    if (found.has(entry.id)) continue;
    found.set(entry.id, entry.pid);
  }
  return found;
}

// 官方 ChatGPT Desktop 是否在跑：兼容新版 ChatGPT.app 与旧 Codex.app；完全不提助手目录的才是官方实例。
// 助手自己开的窗口（含 crashpad 助手进程）命令行里一定有助手目录，所以不会被误判——
// 误判成「官方在跑」会让我们白拒绝清理，误判成「没在跑」则会去动正在使用的官方库，两个方向都要防。
export function parseOfficialRunning(output, root) {
  const rawRoot = String(root ?? "");
  const resolvedRoot = (/^[A-Za-z]:[\\/]/.test(rawRoot) || rawRoot.startsWith("/")) ? rawRoot : path.resolve(rawRoot);
  const managedRoot = normalizeProcessText(resolvedRoot);
  const found = [];
  for (const original of String(output ?? "").split("\n")) {
    const line = normalizeProcessText(original);
    // 必须是主程序本身：macOS 的 ChatGPT 主程序，或 Windows Store/MSIX 的 ChatGPT/Codex.exe。
    const macMain = /\/(ChatGPT|Codex)\.app\/Contents\/MacOS\/ChatGPT(\s|$)/i.test(line);
    const windowsMain = /\/(ChatGPT|Codex)\.exe[\"']?(\s|$)/i.test(line);
    if (!macMain && !windowsMain) continue;
    // 主进程没有 Chromium renderer/crashpad 的子进程参数；这些不能算官方窗口。
    if (/\s--type=/.test(line) || /\s--database=/.test(line)) continue;
    // 带自定义资料目录的都是助手窗口，官方那一个是不带这个参数的。
    if (/--user-data-dir(?:=|\s)/.test(line)) continue;
    if (line.includes(managedRoot)) continue;
    const pid = Number((line.match(/^\s*(\d+)\s/) || [])[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    found.push({ pid, args: line.trim().slice(0, 160) });
  }
  return found;
}

// 窗口当前实际在用的模型。Codex 会把自己的选择写进窗口 home 的 .codex-global-state.json，
// 而助手以前只显示「启动时模型」——用户随时会在 Codex 顶部换模型，那个字段永远停在第一次的值，
// 界面上就一直显示旧的，看起来像「我切了但没生效」。
export async function readWindowCurrentModel(homePath) {
  try {
    const raw = await fs.readFile(path.join(homePath, ".codex-global-state.json"), "utf8");
    const state = JSON.parse(raw)?.["electron-persisted-atom-state"] ?? {};
    const recent = state["composer-recent-model-configurations-v1"];
    if (!Array.isArray(recent) || !recent.length) return "";
    const model = recent[0]?.model;
    return typeof model === "string" ? model.trim() : "";
  } catch {
    return "";
  }
}

// Codex 的最近选择状态可能尚未写盘；此时保留窗口 config.toml 中已经选定的模型。
async function readWindowPreferredModel(homePath) {
  const recent = await readWindowCurrentModel(homePath);
  if (recent) return recent;
  try {
    const config = await fs.readFile(path.join(homePath, "config.toml"), "utf8");
    const match = config.match(/^\s*model\s*=\s*"([^"\n]+)"/m);
    return match?.[1] ?? "";
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

// 目录大小的短时缓存：见 unmanagedWindows()，避免每次刷新界面都跑一遍 du。
const unmanagedSizeCache = { at: 0, map: new Map() };

// 网关每次动用备用条目都会写一条，这里读出来给界面用。
export async function readFallbackEvents(root, limit = 5) {
  try {
    const list = JSON.parse(await fs.readFile(path.join(root, "fallback-events.json"), "utf8"));
    if (!Array.isArray(list)) return [];
    return list.slice(-limit).reverse();
  } catch {
    return [];
  }
}

// 新机器上第一个拦路虎往往是「Codex 本体还没装」。直接抛 fs.access 的 ENOENT，
// 用户看到的是「ENOENT: no such file or directory, access '/Applications/Codex.app/...'」——
// 既看不懂也不知道该装什么。这里换成一句人话，启动入口共用。
async function requireCodexApp() {
  return findCodexDesktopExecutable();
}

// 网关每次请求都会写一条「走了谁」，这里读出来给界面用。
export async function readRecentRoutes(root, limit = 30) {
  try {
    const list = JSON.parse(await fs.readFile(path.join(root, "route-log.json"), "utf8"));
    if (!Array.isArray(list)) return [];
    return list.slice(-limit).reverse();
  } catch {
    return [];
  }
}

// 按天读「请求去了哪些上游」。用户拿它跟 DeepSeek / opencode 两边的后台对账，
// 比任何解释都有用——数字对不上就是有问题，对得上就可以放心。
export async function readUsageReport(root, days = 1) {
  try {
    const data = JSON.parse(await fs.readFile(path.join(root, "usage-by-day.json"), "utf8"));
    const wanted = Object.keys(data).sort().slice(-Math.max(1, days));
    return wanted.map((day) => ({
      day,
      hosts: data[day]?.hosts ?? {},
      fallbacks: data[day]?.fallbacks ?? {},
      summaries: data[day]?.summaries ?? {},
      confirmed: data[day]?.confirmed ?? {},
      failed: data[day]?.failed ?? {},
      total: Object.values(data[day]?.hosts ?? {}).reduce((sum, n) => sum + Number(n || 0), 0),
      confirmedTotal: Object.values(data[day]?.confirmed ?? {}).reduce((sum, n) => sum + Number(n || 0), 0),
      failedTotal: Object.values(data[day]?.failed ?? {}).reduce((sum, n) => sum + Number(n || 0), 0),
    }));
  } catch {
    return [];
  }
}

export class ProductService {
  constructor(store = new ModelStore()) {
    this.store = store;
    // 官方库路径可注入：测试要把它指到临时目录，绝不能读到真实的 ~/.codex。
    this.officialHome = sharedHome;
    this.openOfficialDesktop = openOfficialChatGPTDesktop;
  }
  async syncOfficialAuthAsset(homePath) {
    const source = path.join(this.officialHome, "auth.json");
    const destination = path.join(homePath, "auth.json");
    await fs.access(source);
    await fs.mkdir(homePath, { recursive: true, mode: 0o700 });
    const temporary = path.join(homePath, `.auth-${randomUUID()}.tmp`);
    try {
      if (isWindows) await fs.copyFile(source, temporary);
      else await fs.symlink(source, temporary, "file");
      try {
        await fs.rename(temporary, destination);
      } catch (error) {
        if (!["EEXIST", "EPERM", "EACCES"].includes(error.code)) throw error;
        await removeManagedAsset(destination);
        await fs.rename(temporary, destination);
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  // 工作窗口默认不继承官方原版账号：用户必须在这个窗口自己登录，才能使用官方模型。
  // 旧版本留下的全局 symlink/复制会先备份再解除，避免窗口之间串账号。
  async ensureOfficialAuthAsset(homePath) {
    const destination = path.join(homePath, "auth.json");
    await fs.mkdir(homePath, { recursive: true, mode: 0o700 });
    const marker = path.join(homePath, ".model-router-window-auth-v2");
    let marked = false;
    try {
      await fs.access(marker);
      marked = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    // Codex/旧版助手可能在启动时重新放回指向全局 ~/.codex/auth.json 的 symlink。
    // 标记存在也不能直接跳过：每次准备窗口都要拆掉这个全局链接，但保留窗口自己登录后生成的本地 auth.json。
    if (marked) {
      try {
        const stat = await fs.lstat(destination);
        if (stat.isSymbolicLink()) {
          const linked = path.resolve(path.dirname(destination), await fs.readlink(destination));
          const official = path.resolve(this.officialHome, "auth.json");
          if (linked === official) await fs.unlink(destination);
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      return false;
    }
    try {
      await fs.lstat(destination);
      const backup = destination + ".before-window-auth-v2-" + Date.now();
      await fs.rename(destination, backup);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await fs.writeFile(marker, "window-local-auth\n", { mode: 0o600 });
    return true;
  }
  async syncOfficialAuthHomes() {
    const account = await officialAccount({ file: path.join(this.officialHome, "auth.json") });
    if (!account.signedIn) return { account, checked: [] };
    const registry = await readWindowRegistry(this.store.root);
    const checked = [];
    for (const entry of registry.windows) {
      const homePath = windowPaths(this.store.root, entry.id).homePath;
      try {
        await fs.access(homePath);
        checked.push(entry.id);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return { account, checked };
  }
  async officialModelsForAllHomes() {
    const homes = [this.officialHome];
    const registry = await readWindowRegistry(this.store.root);
    for (const entry of registry.windows) homes.push(windowPaths(this.store.root, entry.id).homePath);
    const bySlug = new Map();
    let lastError = null;
    for (const home of [...new Set(homes)]) {
      try {
        for (const model of await officialModels(home)) {
          if (!bySlug.has(model.slug)) bySlug.set(model.slug, model);
        }
      } catch (error) {
        lastError = error;
      }
    }
    if (!bySlug.size && lastError) throw lastError;
    return [...bySlug.values()];
  }
  async syncSharedRuntimeAssets(homePath, runtimeProfile = "full") {
    try { await this.ensureOfficialAuthAsset(homePath); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (runtimeProfile === "lite") {
      for (const name of liteBlockedRuntimeAssets) await removeManagedAsset(path.join(homePath, name));
      await removeManagedAsset(path.join(homePath, "AGENTS.md"));
      await fs.writeFile(path.join(homePath, "AGENTS.md"), liteAgentsText, { mode: 0o600 });
      return;
    }
    try {
      const agentsPath = path.join(homePath, "AGENTS.md");
      const current = await fs.readFile(agentsPath, "utf8");
      if (current.startsWith("# Model Router Lite")) await removeManagedAsset(agentsPath);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const name of sharedRuntimeAssets) {
      const sourcePath = path.join(this.officialHome, name);
      try {
        await fs.access(sourcePath);
        await linkSharedAsset(sourcePath, path.join(homePath, name));
      } catch (error) {
        if (!["ENOENT", "EEXIST"].includes(error.code)) throw error;
      }
    }
  }
  // 窗口运行状态：id → pid（0 表示命令行里没有 pid，通常来自测试夹具）。
  async runningSlots() {
    try {
      return parseRunningSlots(await processListingText(), this.store.root);
    } catch {
      return [];
    }
  }
  async runningWindows() {
    const found = new Map();
    for (const entry of await this.runningSlots()) {
      if (found.has(entry.id)) continue;
      found.set(entry.id, entry.pid);
    }
    return found;
  }
  // 官方实例的进程列表：清理官方库前必须为空。
  async officialCodexRunning() {
    try {
      return parseOfficialRunning(await processListingText(), this.store.root);
    } catch {
      return [];
    }
  }
  // 「专用单模型窗口」按设计不写进注册表，于是它们既不在窗口面板里、也没有入口关掉或删掉。
  // 实测磁盘上已经堆了 11 个、3.8 GB——用户只能看着空间变少却找不到是谁占的。
  // 这里把它们读出来，交给界面显示与管理。
  async unmanagedWindows({ measure = true } = {}) {
    const running = await this.runningWindows();
    const found = [];
    for (const slot of ["instances-v2", "continuations-v1"]) {
      let names = [];
      try { names = await fs.readdir(path.join(this.store.root, slot)); } catch { continue; }
      for (const id of names) {
        const base = path.join(this.store.root, slot, id);
        let stat;
        try { stat = await fs.stat(base); } catch { continue; }
        if (!stat.isDirectory()) continue;
        found.push({
          id,
          slot,
          root: base,
          homePath: path.join(base, "codex-home"),
          running: running.has(id),
          pid: running.get(id) ?? 0,
          bytes: 0,
        });
      }
    }
    if (!found.length) return found;
    // 普通状态刷新不能递归遍历历史目录：这些目录可能有数 GB、数千个文件。
    // 只有磁盘管理/删除流程明确要求 measure 时才计算大小。
    if (!measure) return found;
    // du 要遍历好几个 GB，目录大小变化很慢，30 秒内直接复用上一次的结果。
    const now = Date.now();
    if (now - unmanagedSizeCache.at > 30000) {
      try {
        const map = new Map();
        await Promise.all(found.map(async (entry) => map.set(entry.root, await directorySize(entry.root))));
        unmanagedSizeCache.at = now;
        unmanagedSizeCache.map = map;
      } catch { unmanagedSizeCache.at = now; }
    }
    for (const entry of found) entry.bytes = unmanagedSizeCache.map.get(entry.root) ?? 0;
    return found.sort((left, right) => right.bytes - left.bytes);
  }

  // 删除一个不在注册表里的单模型窗口目录：正在跑的先拒绝，避免删掉正在用的资料。
  async deleteUnmanagedWindow(id = "") {
    const wanted = String(id ?? "").trim();
    if (!wanted) throw new Error("请指定要删除的窗口");
    const found = await this.unmanagedWindows({ measure: true });
    const target = found.find((entry) => entry.id === wanted);
    if (!target) throw new Error(`没有找到窗口「${wanted}」`);
    if (target.running) throw new Error(`「${wanted}」正在运行，请先关闭它再删除`);
    await fs.rm(target.root, { recursive: true, force: true });
    return {
      ...(await this.switchSummary()),
      unmanaged: await this.unmanagedWindows({ measure: false }),
      message: `已删除窗口「${wanted}」（${Math.round(target.bytes / 1024 / 1024)} MB）。这是一次性资料，删掉就没了。`,
    };
  }

  // 跑着但不在注册表里的 windows-v1 窗口：并发建窗丢过记录时会留下这种孤儿，
  // 它们在任务管理器里占着内存，用户却在助手界面里看不到、也关不掉。
  async orphanWindows() {
    const registry = await readWindowRegistry(this.store.root);
    const known = new Set(registry.windows.map((entry) => entry.id));
    const orphans = [];
    for (const entry of await this.runningSlots()) {
      if (entry.slot !== windowsRootName || known.has(entry.id)) continue;
      if (orphans.some((item) => item.id === entry.id)) continue;
      orphans.push({ id: entry.id, pid: entry.pid, name: `未登记的窗口 ${entry.id}`, homePath: windowPaths(this.store.root, entry.id).homePath });
    }
    return orphans;
  }
  async migrateSecrets() {
    // DeepSeek 是用户可选的第三方按量接口，默认不得从其他工具的密钥目录
    // 静默导入。否则模型库看似“已配置”，用户却不知道请求会走哪个账号。
    // Agnes 是本机已部署服务，仍保留兼容迁移。
    for (const [id, relative] of [["agnes", ".openclaw/secrets/openclaw-runtime/secret-005"]]) {
      if (await this.store.secret(id)) continue;
      const marker = path.join(this.store.root, `.migrated-${id}`);
      try { await fs.access(marker); continue; } catch { }
      try {
        const secret = await fs.readFile(path.join(os.homedir(), relative), "utf8");
        await this.store.writeSecret(id, secret.trim());
        await fs.writeFile(marker, "1", { mode: 0o600 });
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  async ensureManagedLocalService(route) {
    if (isWindows || route?.id !== "bonsai2-27b") return { managed: false };
    const endpoint = String(route.endpoint ?? "");
    let url;
    try { url = new URL(endpoint); } catch { return { managed: false }; }
    if (url.hostname !== "127.0.0.1" || url.port !== "18081") return { managed: false };
    const memoryCap = os.totalmem() <= 72 * 1024 * 1024 * 1024 ? 65536 : 131072;
    const configuredWindow = Number(route.contextWindow) > 0 ? Number(route.contextWindow) : memoryCap;
    const contextWindow = Math.min(configuredWindow, memoryCap);
    const health = `${url.protocol}//${url.host}/health`;
    try {
      const response = await fetch(health, { signal: AbortSignal.timeout(1200) });
      if (response.ok) return { managed: true, started: false, health, contextWindow: configuredWindow };
    } catch { }
    if (Number(route.contextWindow) !== contextWindow) {
      try {
        const data = await this.store.read();
        const current = data.routes.find((entry) => entry.id === route.id);
        if (current) await this.store.save({ ...current, contextWindow }, data.revision);
      } catch { }
    }
    const base = path.join(os.homedir(), "Library", "Application Support", "Model Router", "Bonsai-demo");
    const binary = path.join(base, "bin", "mac", "llama-server");
    const model = path.join(base, "models", "bonsai2-gguf", "27B", "Ternary-Bonsai-2-27B-PQ2_0.gguf");
    const mmproj = path.join(base, "models", "bonsai2-gguf", "27B", "Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf");
    for (const required of [binary, model, mmproj]) {
      try { await fs.access(required); }
      catch { throw new Error(`Bonsai 托管运行时不完整：缺少 ${required}`); }
    }
    const child = spawn(binary, [
      "-m", model,
      "--alias", route.model,
      "--host", "127.0.0.1",
      "--port", "18081",
      "-ngl", "99",
      "-fa", "on",
      "-c", String(contextWindow),
      "--temp", "1.0",
      "--top-p", "0.95",
      "--top-k", "20",
      "--jinja",
      "--mmproj", mmproj,
      "--cache-type-k", "q4_0",
      "--cache-type-v", "q4_0",
      "--sleep-idle-seconds", "300",
    ], { detached: true, stdio: "ignore" });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        const response = await fetch(health, { signal: AbortSignal.timeout(900) });
        if (response.ok) return { managed: true, started: true, pid: child.pid, health, contextWindow };
      } catch { }
    }
    throw new Error("Bonsai 27B 已启动但 15 秒内没有通过健康检查；请查看本机内存占用或模型运行日志");
  }

  async syncOfficialModels() {
    const models = await this.officialModelsForAllHomes();
    const data = await this.store.read();
    await this.store.mutate(data.revision, library => {
      for (const model of models) {
        const id = "chatgpt-" + model.slug.replace(/[^a-z0-9-]/gi, "-").toLowerCase().slice(0,55);
        if (library.routes.some(route => route.id === id)) continue;
        library.routes.push(validateRoute({ id, name: "ChatGPT · " + (model.display_name || model.slug),
          vendor: "OpenAI · 登录订阅额度", protocol: "chatgpt", model: model.slug,
          noKey: true, switchable: true, runtimeProfile: "full", contextWindow: model.context_window || 0,
          reasoningLevels: (model.supported_reasoning_levels || []).map(level => level.effort), defaultReasoning: model.default_reasoning_level,
          notes: "复用官方登录。可在同一工作会话切换第三方模型，无需退出账号。官方额度由 OpenAI 管理。" }));
      }
      return library;
    });
    const authSync = await this.syncOfficialAuthHomes();
    await this.refreshCatalogs();
    return {
      ...(await this.store.publicData()),
      ...(await this.switchSummary()),
      message: "已读取官方原版与各工作窗口的账号状态，并同步 " + models.length + " 个官方模型目录。账号不会跨窗口复制；在目标窗口内登录后才会使用该窗口账号。",
    };
  }
  async discover(route) {
    const checked = validateRoute(route);
    await this.ensureManagedLocalService(checked);
    if (checked.protocol === "oauth") return { models: [], message: "官方模型由 ChatGPT Desktop 自己管理，请在原版客户端内选择" };
    if (checked.protocol === "chatgpt") {
      const models = (await officialModels(this.officialHome)).map(model => model.slug);
      return { models: [...new Set([checked.model, ...models].filter(Boolean))], listedModels: models, message: "官方登录模型目录；可用性和额度以真实验证为准" };
    }
    let data;
    try {
      const result = await upstream(checked, await this.store.secret(checked.credentialID), "models", null, 15000);
      data = await limitedJSON(result.body);
    } catch (error) {
      if (![404, 405, 501].includes(error.status)) throw error;
      return { models: checked.model ? [checked.model] : [], catalogUnavailable: true, message: "此接口不提供模型目录；已保留当前模型，可手动输入供应商支持的模型 ID，再执行真实验证。" };
    }
    if (!Array.isArray(data.data)) throw new Error("供应商未返回标准模型列表，请手动输入模型 ID");
    const listed = data.data.map((entry) => entry.id).filter((id) => typeof id === "string").slice(0, 2000);
    return { models: [...new Set([checked.model, ...listed].filter(Boolean))], listedModels: listed, message: "已保留当前模型及供应商目录候选；可手动输入模型 ID，实际可用性以真实验证为准。" };
  }
  async check(id) {
    const route = await this.store.route(id);
    if (route.archived) throw new Error("此模型已归档，请先恢复");
    if (route.protocol === "oauth") {
      const auth = JSON.parse(await fs.readFile(path.join(sharedHome, "auth.json"), "utf8"));
      if (auth.auth_mode !== "chatgpt" || !auth.tokens?.access_token) throw new Error("请先在 ChatGPT Desktop / Codex 中登录 ChatGPT");
      return { message: "ChatGPT Desktop 已登录；官方模型请在原版客户端内选择" };
    }
    if (!route.model) throw new Error("请先选择模型 ID");
    const result = await this.discover(route);
    if (result.catalogUnavailable) return { message: result.message };
    if (!(result.listedModels ?? result.models).includes(route.model)) {
      return { message: "连接正常，但 /models 未列出该别名；不阻止启动，请用真实推理请求验证。" };
    }
    return { message: "连接正常，模型已列出；尚不等同真实推理验证" };
  }
  // 不知道供应商实现的是哪套接口时，逐个真跑一次最小请求，把能用的那套记下来。
  async detectProtocol(id, { save = true } = {}) {
    const route = await this.store.route(id);
    await this.ensureManagedLocalService(route);
    if (route.archived) throw new Error("此模型已归档，请先恢复");
    if (route.protocol === "oauth") return { protocol: "oauth", message: "ChatGPT Desktop 官方入口不需要识别接口", tested: [] };
    if (route.protocol === "chatgpt") { await officialTokens({ file: path.join(this.officialHome, "auth.json") }); return { protocol: "chatgpt", changed: false, tested: [], message: "官方登录使用固定接口，无需探测第三方协议" }; }
    if (!route.model) throw new Error("请先选择模型 ID");
    const key = await this.store.secret(route.credentialID);
    const marker = "MODEL_ASSISTANT_OK";
    const prompt = `Reply exactly ${marker}`;
    const probes = {
      responses: { suffix: "responses", body: { model: route.model, input: prompt, max_output_tokens: 256, store: false } },
      chat: { suffix: "chat/completions", body: { model: route.model, messages: [{ role: "user", content: prompt }], max_tokens: 256, stream: false } },
      anthropic: { suffix: "messages", body: { model: route.model, max_tokens: 256, messages: [{ role: "user", content: prompt }] } },
    };
    const tested = [];
    for (const protocol of [route.protocol, ...["responses", "chat", "anthropic"].filter((entry) => entry !== route.protocol)]) {
      const probe = probes[protocol];
      try {
        const result = await upstream({ ...route, protocol }, key, probe.suffix, probe.body, 30000);
        const body = await limitedJSON(result.body);
        const output = protocol === "responses"
          ? body.output?.filter((item) => item.type === "message").flatMap((item) => item.content || []).map((part) => part.text || "").join("")
          : protocol === "chat" ? body.choices?.[0]?.message?.content
            : body.content?.filter((part) => part.type === "text").map((part) => part.text || "").join("");
        if (body.status === "failed" || String(output ?? "").trim() !== marker) throw new Error("服务已响应，但未返回准确的验证文本");
        tested.push({ protocol, ok: true });
      } catch (error) {
        tested.push({ protocol, ok: false, reason: errorMessage(error) });
      }
    }
    const working = tested.filter((entry) => entry.ok).map((entry) => entry.protocol);
    if (!working.length) throw new Error(`三套接口都没通过真实文本验证，请核对地址、密钥和模型 ID：\n${tested.map((entry) => `${entry.protocol}：${entry.reason}`).join("\n")}`);
    const chosen = working.includes(route.protocol) ? route.protocol : working[0];
    if (save && chosen !== route.protocol) {
      const data = await this.store.read();
      await this.store.save({ ...route, protocol: chosen }, data.revision);
    }
    return {
      protocol: chosen,
      changed: save && chosen !== route.protocol,
      tested,
      message: chosen === route.protocol
        ? `接口已确认：${chosen} 可用${working.length > 1 ? `（也可用：${working.filter((entry) => entry !== chosen).join("、")}）` : ""}`
        : `已自动把接口格式改为 ${chosen}（原来写的 ${route.protocol} 不通），现在可以验证了`,
    };
  }
  async gatewayHealth() {
    const response = await fetch(`${gatewayURL}/health`, { signal: AbortSignal.timeout(2000), redirect: "error" });
    const data = await response.json();
    if (!response.ok || data.service !== "codex-model-assistant" || data.version !== 2) throw new Error("模型网关不可用，请重新安装或检查诊断");
    return data;
  }
  async gatewayReady() {
    await this.gatewayHealth();
  }
  async restartGateway() {
    if (!isWindows) {
      try { await execFileAsync("/bin/launchctl", ["kickstart", "-k", `gui/${process.getuid()}/local.shift.codex-model-gateway`]); return; }
      catch { }
    }
    await killGatewayProcesses();
  }
  async startGateway() {
    let health = null;
    try { health = await this.gatewayHealth(); } catch { }
    if (health?.build === gatewayBuild) return { message: "模型网关已运行" };
    let stale = null;
    if (health) {
      // 有请求正在跑就先不升级，避免打断别人的任务；下次操作再试。
      if (Number(health.inflight) > 0) {
        return { message: `模型网关有 ${health.inflight} 个请求正在进行，本次沿用当前进程（${health.build}），下次操作会自动升级到 ${gatewayBuild}` };
      }
      await this.restartGateway();
      await new Promise((resolve) => setTimeout(resolve, 500));
      try { if ((await this.gatewayHealth()).build === gatewayBuild) return { message: "模型网关已升级到当前版本" }; } catch { }
      stale = health.build;
    }
    const child = spawn(process.execPath, [fileURLToPath(new URL("./model-gateway.mjs", import.meta.url))], { stdio: "ignore", detached: true });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        const current = await this.gatewayHealth();
        if (current.build === gatewayBuild) return { message: health ? "模型网关已升级到当前版本" : "模型网关已启动" };
        stale = current.build;
      } catch { }
    }
    // 升级失败（常见于端口被 launchd 托管的旧进程占着，而部署目录还没更新）：只要它还在正常服务就继续用它，
    // 不要把用户挡在门外——真正要换代码时跑一次安装脚本或重启助手即可。
    if (stale) return { message: `模型网关正在跑旧版本（${stale}），本次沿用它；要切到最新代码请重新运行安装脚本或重启 Model Router` };
    throw new Error("模型网关未能启动，请查看运行诊断");
  }
  async probe(id) {
    const route = await this.store.route(id);
    await this.ensureManagedLocalService(route);
    if (route.archived) throw new Error("请选择已启用且配置完整的模型");
    if (route.protocol === "oauth") return this.check(id);
    if (!route.model) throw new Error("请选择已启用且配置完整的模型");
    await this.gatewayReady();
    const started = Date.now();
    const call = async (payload) => {
      const response = await fetch(`${gatewayURL}/routes/${id}/v1/responses`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await this.store.token(id)}` },
        body: JSON.stringify({ model: route.model, max_output_tokens: 256, stream: false, ...payload }), signal: AbortSignal.timeout(90000),
      });
      const data = await limitedJSON(response.body);
      if (!response.ok) throw new Error(data.error?.message || `调用失败 HTTP ${response.status}`);
      if (data.status === "failed") throw new Error(data.error?.message || "供应商返回失败状态");
      return data;
    };
    const answer = (data) => data.output?.filter((item) => item.type === "message").flatMap((item) => item.content || []).map((part) => part.text || "").join("") || "";
    const textPayload = { input: "Reply exactly MODEL_ASSISTANT_OK" };
    let result, detected = null;
    try { result = await call(textPayload); }
    catch (error) {
      // 常见情况是接口格式选错（供应商只有 Chat 或 Messages）；自动识别一次并重试，用户不需要自己猜。
      detected = await this.detectProtocol(id).catch(() => null);
      if (!detected?.changed) throw error;
      result = await call(textPayload);
    }
    // 必须返回验证词；HTTP 200 或空 output 不能证明推理成功。
    const verified = answer(result).trim() === "MODEL_ASSISTANT_OK";
    if (!verified) {
      detected = await this.detectProtocol(id).catch(() => null);
      if (!detected?.changed) throw new Error("服务已响应，但未返回准确的验证文本；不能确认真实推理通过");
      result = await call(textPayload);
      if (answer(result).trim() !== "MODEL_ASSISTANT_OK") throw new Error("接口已切换，但仍未返回准确的验证文本；不能确认真实推理通过");
    }
    const toolName = "model_router_echo";
    const toolInput = "MODEL_ASSISTANT_TOOL_INPUT";
    const toolOutput = "MODEL_ASSISTANT_TOOL_OK";
    const prompt = `Call the ${toolName} tool with input ${toolInput}. Do not answer directly.`;
    const tool = { type: "custom", name: toolName, description: "Echo text supplied by the user", format: { type: "text" } };
    const toolResult = await call({ input: prompt, tools: [tool], tool_choice: "required" });
    const toolCall = toolResult.output?.find((item) => item.type === "custom_tool_call" && item.name === toolName && item.input?.trim() === toolInput && item.call_id);
    if (!toolCall) throw new Error("文本验证通过，但模型未真正调用 Codex 工具；此模型暂不能用于 Codex 工作窗口");
    const continuation = await call({ input: [
      { role: "user", content: prompt },
      { type: "custom_tool_call", name: toolName, call_id: toolCall.call_id, input: toolCall.input },
      { type: "custom_tool_call_output", call_id: toolCall.call_id, output: toolOutput },
      { role: "user", content: `Reply exactly ${toolOutput}` },
    ], tools: [tool], tool_choice: "none" });
    if (answer(continuation).trim() !== toolOutput) throw new Error("工具调用成功，但模型未正确读取工具结果；此模型暂不能用于 Codex 工作窗口");
    const current = await this.store.route(id);
    const proof = { testedAt: new Date().toISOString(), latencyMs: Date.now() - started, model: current.model, endpoint: current.endpoint, protocol: current.protocol, credentialVersion: await this.store.credentialVersion(current.credentialID), ok: true, codexTools: true };
    await atomicJSON(path.join(this.store.root, "checks", `${id}.json`), proof);
    return { ...proof, detected, message: `${detected?.changed ? `接口格式已按实测自动改为 ${detected.protocol}；` : ""}文本、Codex 工具调用及结果回传均通过 · ${proof.latencyMs} ms（其他工具仍需按实际任务验证）` };
  }
  async prepare(id, { continueExisting = false } = {}) {
    let route = await this.store.route(id);
    if (route.archived || !route.model) throw new Error("模型未配置完整或已归档");
    // Model discovery is optional and may use a different permission scope.
    // Never gate inference startup on GET /models, even when it returns 401/404.
    if (route.protocol === "oauth") await this.check(id);
    else {
      if (!route.noKey && !(await this.store.secret(route.credentialID))) throw new Error("请先配置 API Key");
      await this.ensureManagedLocalService(route);
    }
    if (route.protocol !== "oauth") await this.gatewayReady();
    const { hasContinuation } = await this.instancePaths(id);
    if (continueExisting && route.protocol === "oauth") throw new Error("官方会话无需导入第三方实例");
    // 第一次「导入原会话并继续」会整份快照官方会话；这一次不能顺手清理，否则刚导入就被当成旧副本删掉。
    // 之后 continuation 目录已经建好，再启动就是普通启动，照常清理。
    const freshImport = continueExisting && !hasContinuation;
    const continuationHome = path.join(this.store.root, "continuations-v1", id, "codex-home");
    if (freshImport) await snapshotConversations(this.officialHome, continuationHome, route);
    const instanceRoot = continueExisting || hasContinuation ? "continuations-v1" : "instances-v2";
    const homePath = path.join(this.store.root, instanceRoot, id, "codex-home");
    const userDataPath = path.join(this.store.root, instanceRoot, id, "browser-data");
    await fs.mkdir(homePath, { recursive: true, mode: 0o700 });
    await fs.mkdir(userDataPath, { recursive: true, mode: 0o700 });
    // 模型窗口（instances-v2 / continuations-v1）才是副本堆得最多的地方，启动前也要清一次。
    // 此刻 Codex 还没打开任务库，删副本不会和运行中的进程抢锁。
    let diskCleanup = null;
    if (freshImport) {
      diskCleanup = { skipped: "本次要把官方会话导入进来，先不清理" };
    } else {
      try {
        diskCleanup = await cleanupWindowOnLaunch({
          root: this.store.root,
          officialHome: this.officialHome,
          windowID: id,
          home: homePath,
          runningIds: new Set([...(await this.runningWindows()).keys()]),
          policy: await readDiskPolicy(this.store),
        });
      } catch (error) {
        diskCleanup = { error: error.message };
      }
    }
    if (continueExisting && !freshImport) await snapshotConversations(this.officialHome, continuationHome, route);
    const catalogPath = path.join(homePath, "model-catalog.json");
    let source = "";
    try { source = await fs.readFile(path.join(this.officialHome, "config.toml"), "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const switching = route.switchable && route.protocol !== "oauth";
    let runtimeProfile = resolveRuntimeProfile(route);
    let config;
    if (switching) {
      const table = buildRouterTable((await this.store.read()).routes);
      await atomicJSON(catalogPath, routerCatalog(table));
      const remembered = await readWindowPreferredModel(homePath);
      const chosen = this.routerSelection(table, remembered, id);
      runtimeProfile = this.routerRuntimeProfile(chosen);
      config = renderRouterConfig(source, { model: chosen.slug, catalogPath, runtimeProfile });
    } else {
      await atomicJSON(catalogPath, catalog(route));
      config = renderProductConfig(source, route, catalogPath);
    }
    const temporary = path.join(homePath, `.config-${randomUUID()}.toml`);
    await fs.writeFile(temporary, config, { mode: 0o600 });
    await fs.rename(temporary, path.join(homePath, "config.toml"));
    await this.syncSharedRuntimeAssets(homePath, runtimeProfile);
    await fs.mkdir(path.join(homePath, "memories"), { recursive: true, mode: 0o700 });
    return { route, homePath, userDataPath, diskCleanup, runtimeProfile };
  }
  // 一个条目可能只有普通实例目录，也可能已经有一份"导入原会话"的副本目录。
  async instancePaths(id) {
    const continuationHome = path.join(this.store.root, "continuations-v1", id, "codex-home");
    let hasContinuation = false;
    try { await fs.access(path.join(continuationHome, "conversation-import.json")); hasContinuation = true; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const root = hasContinuation ? "continuations-v1" : "instances-v2";
    return { hasContinuation, homePath: path.join(this.store.root, root, id, "codex-home") };
  }
  // 让已有条目的窗口也能在 Codex 里直接换模型：同一个 CODEX_HOME，对话和任务库原地保留。
  async setSwitching(id, enabled) {
    const route = await this.store.route(id);
    if (route.protocol === "oauth") throw new Error("官方 ChatGPT 入口自带模型选择，不需要切换窗口");
    if (!route.model) throw new Error("请先选择模型 ID");
    // 3.3.1 起只保留统一可切换窗口。继续接受旧客户端的命令，但永远保持开启，
    // 避免旧 UI 把窗口重新降级成只能使用一个模型。
    const unified = true;
    const data = await this.store.read();
    await this.store.save({ ...route, switchable: unified }, data.revision);
    // 该条目可能同时有普通实例目录和"导入原会话"副本目录，两个都改，保证下次打开哪个窗口都一致。
    const homes = ["instances-v2", "continuations-v1"].map((root) => path.join(this.store.root, root, id, "codex-home"));
    const table = buildRouterTable((await this.store.read()).routes);
    let source = "";
    try { source = await fs.readFile(path.join(this.officialHome, "config.toml"), "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    let touched = false;
    for (const homePath of homes) {
      try { await fs.access(path.join(homePath, "config.toml")); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      touched = true;
      if ((await this.runningWindows()).has(id)) continue;
      const catalogPath = path.join(homePath, "model-catalog.json");
      const current = await this.store.route(id);
      const remembered = await readWindowPreferredModel(homePath);
      const chosen = this.routerSelection(table, remembered, id);
      const runtimeProfile = this.routerRuntimeProfile(chosen);
      const updated = renderRouterConfig(source, { model: chosen.slug, catalogPath, runtimeProfile });
      await atomicJSON(catalogPath, routerCatalog(table));
      const temporary = path.join(homePath, `.config-${randomUUID()}.toml`);
      await fs.writeFile(temporary, updated, { mode: 0o600 });
      await fs.rename(temporary, path.join(homePath, "config.toml"));
      await this.syncSharedRuntimeAssets(homePath, runtimeProfile);
    }
    return {
      ...(await this.switchSummary()),
      message: `「${route.name}」使用统一可切换窗口${touched ? "" : "（首次启动生效）"}：重开窗口后，可在 Codex 顶部直接选择官方登录模型或第三方模型。`,
    };
  }
  // ChatGPT Desktop（官方）入口必须打开官方默认资料 + ~/.codex。
  // 以前这里也给它造了一个窗口（CODEX_HOME 指向助手目录、--user-data-dir 指向空目录），
  // 结果用户点进去看到的是「欢迎使用 ChatGPT 桌面版」的新手引导——登录状态和任务库全没了。
  async launchOfficial() {
    if (this.officialLaunchPending) return this.officialLaunchPending;
    this.officialLaunchPending = this.launchOfficialOnce();
    try { return await this.officialLaunchPending; }
    finally { this.officialLaunchPending = null; }
  }

  async launchOfficialOnce() {
    let running = await this.officialCodexRunning();
    const reused = running.length > 0;
    if (!reused) {
      await this.openOfficialDesktop();
      // A successful launch command is not evidence of a running default instance.
      for (let attempt = 0; attempt < 40; attempt++) {
        running = await this.officialCodexRunning();
        if (running.length) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    const pid = running[0]?.pid ?? 0;
    const stillOfficial = pid > 0 && (await this.officialCodexRunning()).some((row) => row.pid === pid);
    const opened = stillOfficial ? await this.openOfficialDesktop({ pid }) : null;
    const delivered = opened?.delivered === true && opened?.pid === pid;
    if (!delivered) throw new Error(pid
      ? `官方 ChatGPT 进程存在（PID ${pid}），但未确认窗口可见并置前。请重试；不会切换到第三方窗口或重复启动。`
      : "官方 ChatGPT 启动后未检测到默认实例。请直接打开 /Applications/ChatGPT.app 检查启动状态，再重试。");
    return { official: true, reused, pid, delivered, message: `已打开并确认 ChatGPT Desktop（官方）窗口在前台（PID ${pid}），使用原登录状态和任务库。` };
  }

  // 侧边栏点一个模型时的默认动作。原则：已经开着的窗口优先复用，只有确实没有窗口时才新建。
  // 用户点模型是想换模型，不是想再开一个窗口；每点一次就多一个窗口，是最容易被骂的体验。
  async openCodex(modelID = "") {
    const id = String(modelID ?? "").trim();
    const route = id ? await this.store.route(id) : null;
    if (route?.protocol === "oauth") return this.launchOfficial();
    const running = await this.runningWindows();
    const registry = await readWindowRegistry(this.store.root);
    // 优先切到「起始模型就是这个模型」的那个窗口；没有才退而用第一个开着的窗口。
    const preferred = route ? registry.windows.find((entry) => entry.initialModel === route.id && running.has(entry.id)) : null;
    const target = preferred?.id ?? [...running.keys()][0];
    if (target) {
      const entry = findWindow(registry, target);
      const summary = await this.switchSummary();
      const window = summary.windows.find((item) => item.id === target) ?? null;
      const same = Boolean(route) && window?.initialModel === route.id;
      return {
        ...summary,
        window,
        delivered: false,
        reused: true,
        pid: running.get(target),
        message: same
          ? `「${entry?.name ?? target}」已经开着，起始模型就是「${route.name}」（PID ${running.get(target)}），已切到它。`
          : `已切到开着的「${entry?.name ?? target}」（PID ${running.get(target)}）。在 Codex 顶部的模型选择里点「${route?.name ?? "目标模型"}」就切过去了；想再开一个独立窗口，用侧边栏的「新建窗口」。`,
      };
    }
    return this.createWindow(id);
  }

  async launch(id, options = {}) {
    const route = await this.store.route(id);
    if (route?.protocol === "oauth") return this.launchOfficial();
    // 这个模型的窗口已经在跑：切到它，而不是再开一个一模一样的。
    const running = await this.runningWindows();
    if (!options.continueExisting && running.has(id)) {
      const paths = windowPaths(this.store.root, id);
      return {
        reused: true,
        pid: running.get(id),
        homePath: paths.homePath,
        userDataPath: paths.userDataPath,
        message: `「${route?.name ?? id}」的窗口已经开着（PID ${running.get(id)}），已切到它，没有重复启动。`,
      };
    }
    const prepared = await this.prepare(id, options);
    await requireCodexApp();
    const environment = { ...process.env, CODEX_HOME: prepared.homePath };
    delete environment.OPENAI_API_KEY;
    delete environment.OPENAI_BASE_URL;
    delete environment.AGNES_API_KEY;
    delete environment.DEEPSEEK_API_KEY;
    if (prepared.route.protocol !== "oauth") environment.CMA_ROUTE_TOKEN = await this.store.token(prepared.route.switchable ? routerID : id);
    else delete environment.CMA_ROUTE_TOKEN;
    const child = await spawnCodexDesktop([`--user-data-dir=${prepared.userDataPath}`], environment);
    const cleaned = prepared.diskCleanup?.freedBytes
      ? ` 顺手清掉了 ${prepared.diskCleanup.deletedThreads} 个不重要副本和 ${prepared.diskCleanup.deletedCacheDirs} 个缓存目录，释放 ${(prepared.diskCleanup.freedBytes / 1024 ** 3).toFixed(1)} GB。`
      : "";
    return {
      homePath: prepared.homePath,
      userDataPath: prepared.userDataPath,
      diskCleanup: prepared.diskCleanup,
      message: (options.continueExisting
        ? "已打开原会话的独立副本；后续工作保存在此模型窗口，原官方会话不受影响。"
        : `已为「${prepared.route.name}」打开兼容窗口（PID ${child.pid}）：窗口内可从 Codex 顶部切换自定义 API 模型。`) + cleaned,
    };
  }
  switchPaths() {
    // 遗留入口：早期只有一个「可切换窗口」，现在它只是注册表里的第一个窗口（槽位 router）。
    return windowPaths(this.store.root, legacyWindowID);
  }
  async switchSummary() {
    const data = await this.store.read();
    const table = buildRouterTable(data.routes);
    const registry = await readWindowRegistry(this.store.root);
    const slots = await this.runningSlots();
    const running = new Map();
    for (const entry of slots) {
      if (running.has(entry.id)) continue;
      running.set(entry.id, entry.pid);
    }
    const known = new Set(registry.windows.map((entry) => entry.id));
    const orphans = [];
    for (const entry of slots) {
      if (entry.slot !== windowsRootName || known.has(entry.id)) continue;
      if (orphans.some((item) => item.id === entry.id)) continue;
      orphans.push({
        id: entry.id,
        name: `未登记的窗口 ${entry.id}`,
        pid: entry.pid,
        homePath: windowPaths(this.store.root, entry.id).homePath,
      });
    }
    return {
      // 最近发生过的「静默改用备用模型」。备用条目的计费方可能完全不同，
      // 界面必须能把它摆到用户面前，而不是只躺在日志里。
      fallbacks: await readFallbackEvents(this.store.root),
      recentRoutes: await readRecentRoutes(this.store.root),
      todayUsage: (await readUsageReport(this.store.root, 1)).at(-1) ?? null,
      officialAccount: await officialAccount({ file: path.join(this.officialHome, "auth.json") }),
      switchModels: [
        ...(table.length ? [{ id: autoRouterSlug, slug: autoRouterSlug, name: autoModelName, model: "按任务选择", vendor: "Model Router", protocol: "auto" }] : []),
        ...table.map(({ slug, route }) => ({ id: route.id, slug, name: route.name, model: route.model, vendor: route.vendor, protocol: route.protocol })),
      ],
      unmanaged: await this.unmanagedWindows({ measure: false }),
      windows: await Promise.all(registry.windows.map(async (entry) => ({
        id: entry.id,
        name: entry.name,
        initialModel: entry.initialModel,
        currentModel: await readWindowCurrentModel(windowPaths(this.store.root, entry.id).homePath),
        createdAt: entry.createdAt,
        legacy: entry.id === legacyWindowID,
        running: running.has(entry.id),
        pid: running.get(entry.id) || 0,
        homePath: windowPaths(this.store.root, entry.id).homePath,
        officialAccount: await officialAccount({ file: path.join(windowPaths(this.store.root, entry.id).homePath, "auth.json") }),
      }))),
      orphans,
      routerRunning: running.has(legacyWindowID),
      routerRunningInstances: [...running.keys()].sort(),
    };
  }
  // Auto 是目录中的虚拟条目，真实路由表中没有。route 只供非 Auto 选择和环境推断使用。
  routerSelection(table, initial, remembered) {
    for (const value of [initial, remembered]) {
      const wanted = String(value ?? "").trim();
      if (!wanted) continue;
      if (wanted === autoRouterSlug) return { slug: autoRouterSlug, route: table[0].route };
      const found = routerTableEntry(table, wanted);
      if (found) return found;
    }
    return table[0];
  }
  routerRuntimeProfile(chosen) {
    // Auto 请求可能选中本地或云端模型；保持完整工具环境，避免固定为 Lite 后限制后续请求。
    return chosen.slug === autoRouterSlug ? "full" : resolveRuntimeProfile(chosen.route);
  }
  async windowRegistry() {
    return readWindowRegistry(this.store.root);
  }
  // 把模型目录参数同步到每个窗口。目录只在开窗时生成，所以升级了参数（比如 Codex 自己的压缩阈值）
  // 之后，老窗口不会自动生效；这条命令负责补齐，不必逼用户关掉正在用的窗口。
  // 只写我们自己生成的 model-catalog.json，不碰任务库、不碰会话。
  // 把「按模型匹配出来的窗口」写回条目本身。不写回的话，目录里的数字是对的，
  // 但界面上显示的仍然是旧占位值（比如官方模型挂着 128K），看着就像没改。
  // 只有当解析结果确实不同才动，用户自己填的非占位值不会被覆盖。
  async syncContextWindows() {
    const changed = [];
    const before = await this.store.read();
    for (const route of before.routes) {
      const wanted = resolveContextWindow(route);
      if (wanted === Number(route.contextWindow)) continue;
      const current = await this.store.read();
      const live = current.routes.find((entry) => entry.id === route.id);
      if (!live) continue;
      await this.store.save({ ...live, contextWindow: wanted }, current.revision);
      changed.push({ id: route.id, from: Number(live.contextWindow), to: wanted });
    }
    return changed;
  }

  async refreshRouteHomes(id) {
    const route = await this.store.route(id);
    if (!route || route.protocol === "oauth" || route.archived) return { updated: [], skipped: [] };
    const running = await this.runningWindows();
    const updated = [], skipped = [];
    let source = "";
    try { source = await fs.readFile(path.join(this.officialHome, "config.toml"), "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const table = buildRouterTable((await this.store.read()).routes);
    for (const root of ["instances-v2", "continuations-v1"]) {
      const home = path.join(this.store.root, root, id, "codex-home");
      try { await fs.access(path.join(home, "config.toml")); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (running.has(id)) { skipped.push(home); continue; }
      const catalogPath = path.join(home, "model-catalog.json");
      const remembered = await readWindowPreferredModel(home);
      const chosen = route.switchable ? this.routerSelection(table, remembered, id) : null;
      const runtimeProfile = chosen ? this.routerRuntimeProfile(chosen) : resolveRuntimeProfile(route);
      await atomicJSON(catalogPath, route.switchable ? routerCatalog(table) : catalog(route));
      const config = route.switchable
        ? renderRouterConfig(source, { model: chosen.slug, catalogPath, runtimeProfile })
        : renderProductConfig(source, route, catalogPath);
      const temporary = path.join(home, `.config-${randomUUID()}.toml`);
      await fs.writeFile(temporary, config, { mode: 0o600 });
      await fs.rename(temporary, path.join(home, "config.toml"));
      await this.syncSharedRuntimeAssets(home, runtimeProfile);
      updated.push(home);
    }
    return { updated, skipped };
  }

  async refreshCatalogs() {
    const repaired = await this.syncContextWindows();
    const data = await this.store.read();
    const table = buildRouterTable(data.routes);
    const registry = await readWindowRegistry(this.store.root);
    const legacyEntry = registry.windows.find((entry) => entry.id === legacyWindowID);
    const targets = [{ id: legacyWindowID, home: windowPaths(this.store.root, legacyWindowID).homePath, initialModel: legacyEntry?.initialModel || "" }];
    for (const entry of registry.windows) {
      if (entry.id === legacyWindowID) continue;
      targets.push({ id: entry.id, home: windowPaths(this.store.root, entry.id).homePath, initialModel: entry.initialModel || "" });
    }
    const running = new Set([...(await this.runningWindows()).keys()]);
    const updated = [];
    const skipped = [];
    for (const target of targets) {
      try { await fs.access(path.join(target.home, "config.toml")); }
      catch (error) { if (error.code === "ENOENT") { skipped.push({ id: target.id, reason: "窗口尚未初始化" }); continue; } throw error; }
      const catalogPath = path.join(target.home, "model-catalog.json");
      await atomicJSON(catalogPath, routerCatalog(table));
      if (running.has(target.id)) {
        skipped.push({ id: target.id, reason: "窗口正在运行，环境变更将在重开后生效" });
        continue;
      }
      const currentModel = await readWindowPreferredModel(target.home);
      const chosen = this.routerSelection(table, currentModel, target.initialModel);
      const runtimeProfile = this.routerRuntimeProfile(chosen);
      let source = "";
      try { source = await fs.readFile(path.join(this.officialHome, "config.toml"), "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const temporary = path.join(target.home, `.config-${randomUUID()}.toml`);
      await fs.writeFile(temporary, renderRouterConfig(source, { model: chosen.slug, catalogPath, runtimeProfile }), { mode: 0o600 });
      await fs.rename(temporary, path.join(target.home, "config.toml"));
      await this.syncSharedRuntimeAssets(target.home, runtimeProfile);
      updated.push({ id: target.id, running: running.has(target.id), models: table.length, runtimeProfile });
    }
    const repairNote = repaired.length
      ? `；顺手把 ${repaired.length} 个模型的上下文长度改成按模型匹配的值（${repaired.map((entry) => `${entry.id} ${entry.from}→${entry.to}`).join("、")}）`
      : "";
    return {
      updated,
      skipped,
      repaired,
      message: `已把模型目录同步到 ${updated.length} 个窗口（其中 ${updated.filter((entry) => entry.running).length} 个正在运行，下次开新对话时生效）${repairNote}`,
    };
  }
  async prepareWindow(id, initial = "", { importHistory = false, model = "" } = {}) {
    if (!isValidWindowID(id)) throw new Error("窗口标识无效");
    const data = await this.store.read();
    const table = buildRouterTable(data.routes);
    if (!table.length) throw new Error("还没有可切换的模型：请先配置至少一个第三方模型并填写密钥");
    const registry = await readWindowRegistry(this.store.root);
    const entry = findWindow(registry, id);
    if (!entry && id !== legacyWindowID) throw new Error("窗口不存在，请先新建窗口");
    const remembered = await readWindowPreferredModel(windowPaths(this.store.root, id).homePath);
    const chosen = initial
      ? this.routerSelection(table, initial, entry?.initialModel)
      : this.routerSelection(table, remembered, entry?.initialModel);
    const runtimeProfile = this.routerRuntimeProfile(chosen);
    await this.startGateway();
    const paths = windowPaths(this.store.root, id);
    await fs.mkdir(paths.homePath, { recursive: true, mode: 0o700 });
    await fs.mkdir(paths.userDataPath, { recursive: true, mode: 0o700 });
    // 启动前清理遵守磁盘策略；此时 Codex 尚未打开任务库，可以安全删除旧副本。
    let diskCleanup = null;
    try {
      diskCleanup = await cleanupWindowOnLaunch({
        root: this.store.root,
        officialHome: this.officialHome,
        windowID: id,
        home: paths.homePath,
        runningIds: new Set([...(await this.runningWindows()).keys()]),
        policy: await readDiskPolicy(this.store),
      });
    } catch (error) {
      diskCleanup = { error: error.message };
    }
    // 启动前补项目分组：此刻没有 Codex 进程持有全局状态，不会被内存态写回覆盖。
    let globalState = null;
    try {
      // 只把「本窗口真有会话」的项目并进来：新窗口还没有任何对话时，
      // 否则侧边栏会列出一串点开空空的项目名（用户看到的就是「只剩项目名字」）。
      globalState = await mergeGlobalProjectState([paths.homePath], paths.homePath, { existingThreads: await readThreadIDs(paths.homePath) });
    } catch (error) {
      globalState = { destination: paths.homePath, error: error.message, wrote: false };
    }
    await atomicJSON(paths.catalogPath, routerCatalog(table));
    let source = "";
    try { source = await fs.readFile(path.join(this.officialHome, "config.toml"), "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const temporary = path.join(paths.homePath, `.config-${randomUUID()}.toml`);
    await fs.writeFile(temporary, renderRouterConfig(source, { model: chosen.slug, catalogPath: paths.catalogPath, runtimeProfile }), { mode: 0o600 });
    await fs.rename(temporary, path.join(paths.homePath, "config.toml"));
    await this.syncSharedRuntimeAssets(paths.homePath, runtimeProfile);
    await fs.mkdir(path.join(paths.homePath, "memories"), { recursive: true, mode: 0o700 });
    let imported = null;
    if (importHistory) imported = await this.syncSwitchWindowHistory(paths.homePath, chosen.slug);
    return { ...paths, table, chosen, globalState, imported, model, diskCleanup, runtimeProfile };
  }
  async spawnWindow(prepared) {
    await requireCodexApp();
    // --user-data-dir 决定 Chromium 侧隔离；CODEX_ELECTRON_USER_DATA_PATH 让桌面端自己的状态也落在同一个窗口目录，
    // 二者同值（Codex 官方演示启动器就是这么做的）。
    const environment = {
      ...process.env,
      CODEX_HOME: prepared.homePath,
      CODEX_ELECTRON_USER_DATA_PATH: prepared.userDataPath,
      // 每个工作窗口使用自己的访问令牌，网关才能把官方请求绑定到这个窗口的 auth.json。
      CMA_ROUTE_TOKEN: await this.store.token("window-" + prepared.id),
    };
    delete environment.OPENAI_API_KEY;
    delete environment.OPENAI_BASE_URL;
    delete environment.AGNES_API_KEY;
    delete environment.DEEPSEEK_API_KEY;
    const child = await spawnCodexDesktop([`--user-data-dir=${prepared.userDataPath}`], environment);
    return child.pid;
  }
  async createWindow(initial = "") {
    // 编号在锁里分配：两次并发建窗一定拿到 w2 / w3，不会都算出 w2 互相覆盖。
    const reserved = [...(await this.runningWindows()).keys()];
    const window = await allocateWindow(this.store.root, { reserved });
    const id = window.id;
    try {
      return await this.openWindow(id, initial, { reuse: false, fresh: true });
    } catch (error) {
      // 启动失败（网关没起来、Codex 不在等）就把刚建的空窗口撤掉，免得注册表里留下一个打不开的条目。
      await removeWindow(this.store.root, id);
      await fs.rm(windowPaths(this.store.root, id).root, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
  async openWindow(id, initial = "", { reuse = true, fresh = false } = {}) {
    const registry = await readWindowRegistry(this.store.root);
    const entry = findWindow(registry, id);
    if (!entry) throw new Error("窗口不存在，请先新建窗口");
    const running = await this.runningWindows();
    if (reuse && running.has(id)) {
      const summary = await this.switchSummary();
      return {
        ...summary,
        window: summary.windows.find((item) => item.id === id) ?? null,
        delivered: false,
        message: `「${entry.name}」已经在运行（PID ${running.get(id)}），本次没有重复启动。想同时多开请点「新建窗口」；已经在跑的窗口如果被压住或最小化，用「置前」把它切到最前。`,
      };
    }
    // 首次建立任务库的窗口才补历史；新建窗口按约定留空，需要时再手动导入。
    const importHistory = false; // History is imported only by an explicit user action.
    const prepared = await this.prepareWindow(id, initial, { importHistory });
    const pid = await this.spawnWindow(prepared);
    // 记住起始模型：只改这一个窗口，不动期间新建的其它窗口。
    await updateWindow(this.store.root, id, { initialModel: prepared.chosen.slug === autoRouterSlug ? autoRouterSlug : prepared.chosen.route.id });
    const summary = await this.switchSummary();
    const importedMessage = prepared.imported?.pendingFirstLaunch
      ? " 首次打开会先建立统一任务库；关闭后再次打开，会自动把官方与 API 会话补进来。"
      : prepared.imported?.imported
        ? ` 已自动补入 ${prepared.imported.imported} 个已有会话。`
        : "";
    const cleanupMessage = prepared.diskCleanup?.freedBytes
      ? ` 顺手清掉了 ${prepared.diskCleanup.deletedThreads} 个不重要副本和 ${prepared.diskCleanup.deletedCacheDirs} 个缓存目录，释放 ${(prepared.diskCleanup.freedBytes / 1024 ** 3).toFixed(1)} GB。`
      : "";
    return {
      ...summary,
      window: summary.windows.find((item) => item.id === id) ?? null,
      delivered: true,
      pid,
      diskCleanup: prepared.diskCleanup,
      message: `已打开「${entry.name}」（PID ${pid}）：在 Codex 顶部的模型选择里直接换模型，同一个窗口里的对话继续有效。当前起始模型 ${prepared.chosen.slug === autoRouterSlug ? autoModelName : prepared.chosen.route.name}，可选 ${prepared.table.length + 1} 个模型。${importedMessage}${cleanupMessage}`,
    };
  }
  async renameWindow(id, name) {
    const clean = String(name ?? "").trim().slice(0, 40);
    if (!clean) throw new Error("请输入窗口名称");
    if (/[\u0000-\u001f]/.test(clean)) throw new Error("窗口名称包含控制字符");
    if (!(await updateWindow(this.store.root, id, { name: clean }))) throw new Error("窗口不存在");
    return { ...(await this.switchSummary()), message: `窗口已重命名为「${clean}」` };
  }
  async closeWindow(id) {
    const running = await this.runningWindows();
    const pid = running.get(id);
    if (!pid) return { ...(await this.switchSummary()), delivered: false, message: "该窗口没有在运行" };
    await this.assertWindowProcess(pid, id);
    try { await this.killWindowProcess(pid); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (!(await this.runningWindows()).has(id)) break;
    }
    const stillRunning = (await this.runningWindows()).has(id);
    // 主进程退出后再收尾，免得助手进程被当成「窗口还开着」。
    if (!stillRunning) await this.sweepWindowHelpers(id);
    return {
      ...(await this.switchSummary()),
      delivered: !stillRunning,
      message: stillRunning ? `已发送关闭请求，但 PID ${pid} 仍在运行，请手动关闭该窗口` : "窗口已关闭；对话和任务库都留在磁盘上，随时可以再打开",
    };
  }
  async refreshWindowModels(id) {
    // Codex Desktop caches the model picker in memory. Reopening the same
    // managed profile preserves its conversation store and browser login.
    // Never interrupt a live gateway request just to refresh the picker.
    const health = await this.gatewayHealth();
    if (Number(health.inflight) > 0) throw new Error(`仍有 ${health.inflight} 个模型请求进行中；请等任务结束后再刷新窗口模型`);
    const running = await this.runningWindows();
    if (running.has(id)) {
      const closed = await this.closeWindow(id);
      if (!closed.delivered) throw new Error(closed.message || "工作窗口尚未关闭，未执行刷新");
    }
    await this.refreshCatalogs();
    const opened = await this.openWindow(id);
    return { ...opened, message: `模型列表已刷新；「${opened.window?.name ?? id}」已用原有会话和登录资料重新打开。` };
  }
  // 关窗后还会剩下 reparent 到 init 的 crashpad 助手进程（命令行里的 --database 指向本窗口的 browser-data/Crashpad）。
  // 它们不占界面，但每开关一次就留下两个，多开重度使用会越积越多；标记精确到本窗口目录，不会误伤其它窗口。
  async sweepWindowHelpers(id) {
    const markers = windowUserDataCandidates(this.store.root, id).map((dir) => `--database=${normalizeProcessText(dir)}/Crashpad`);
    let stdout = "";
    try {
      stdout = await processListingText();
    } catch {
      return 0;
    }
    let ended = 0;
    for (const line of String(stdout).split("\n")) {
      if (!markers.some((marker) => normalizeProcessText(line).includes(marker))) continue;
      const pid = Number(line.trim().split(/\s+/)[0]);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || pid === process.ppid) continue;
      try {
        await terminateProcessTree(pid);
        ended += 1;
      } catch { /* 已经自己退出了 */ }
    }
    return ended;
  }
  async killWindowProcess(pid) {
    const target = Number(pid);
    if (!Number.isInteger(target) || target <= 0) throw new Error("窗口进程号无效，已取消关闭");
    if (target === process.pid || target === process.ppid) throw new Error("拒绝结束助手自身的进程");
    if (await this.windowProcessCommand(target) === "") return;
    await terminateProcessTree(target);
  }
  // 取进程命令行；进程已退出时返回空字符串（正常情况，不算错误）。
  async windowProcessCommand(pid) {
    return platformProcessCommand(pid);
  }
  // 关窗前确认这个 PID 真的是目标窗口：命令行必须带该窗口自己的 --user-data-dir。
  // 多开时最怕「关一个结果全关」，所以这条校验不通过就直接拒绝动手。
  async assertWindowProcess(pid, id) {
    const command = await this.windowProcessCommand(pid);
    if (command === "") return false;
    const normalized = normalizeProcessText(command);
    const expected = windowUserDataCandidates(this.store.root, id).map((dir) => `--user-data-dir=${normalizeProcessText(dir)}`);
    if (!expected.some((flag) => normalized.includes(flag))) throw new Error(`PID ${pid} 不是「${id}」窗口的进程，已取消操作（避免误伤其它窗口）`);
    return true;
  }
  async deleteWindow(id) {
    if (id === legacyWindowID) throw new Error("「窗口 1」是内置窗口，不能删除；可以改名或先关闭它");
    const registry = await readWindowRegistry(this.store.root);
    if (!findWindow(registry, id)) throw new Error("窗口不存在");
    if ((await this.runningWindows()).has(id)) throw new Error("窗口正在运行，请先关闭再删除");
    await this.sweepWindowHelpers(id);
    await removeWindow(this.store.root, id);
    const paths = windowPaths(this.store.root, id);
    await fs.rm(paths.root, { recursive: true, force: true });
    return { ...(await this.switchSummary()), message: "窗口已删除，它自己的任务库和会话副本一并移除；官方库和其它窗口不受影响" };
  }
  // 接管在跑但没登记的窗口：并发建窗时代的遗留进程，接管后就能在列表里看到、关闭或打开。
  async adoptWindows(target = "all") {
    const orphans = await this.orphanWindows();
    const wanted = target === "all" || !target ? orphans.map((entry) => entry.id) : [target];
    const adopted = [];
    for (const id of wanted) {
      const orphan = orphans.find((entry) => entry.id === id);
      if (!orphan) continue;
      let initialModel = "";
      try {
        const config = await fs.readFile(path.join(orphan.homePath, "config.toml"), "utf8");
        const slug = (config.match(/^\s*model\s*=\s*"([^"]+)"/m) || [])[1] ?? "";
        const data = await this.store.read();
        const hit = (data.routes ?? []).find((route) => route.model === slug || route.id === slug);
        initialModel = hit?.id ?? "";
      } catch { initialModel = ""; }
      const result = await registerRunningWindow(this.store.root, id, { initialModel });
      if (result.added) adopted.push(id);
    }
    const summary = await this.switchSummary();
    return {
      ...summary,
      adopted,
      message: adopted.length
        ? `已接管 ${adopted.length} 个未登记的窗口（${adopted.join("、")}）；它们本来就开着，现在可以在列表里关闭或重新打开`
        : "没有发现需要接管的窗口",
    };
  }
  async switchWindowSources(target = "all") {
    const sources = [];
    if (target === "all" || target === "shared") sources.push(sharedHome);
    // 已归档的模型窗口不参与合并，免得把停用模型的项目带进工作窗口；显式指定某个条目时仍按用户意愿处理。
    const archived = new Set();
    if (target === "all") {
      const data = await this.store.read();
      for (const route of data.routes ?? []) if (route.archived) archived.add(route.id);
    }
    // windows-v1 是 2.3 起的新窗口槽位；router-v1 作为目标时不会把自己当来源（mergeGlobalProjectState 会跳过 destination）。
    for (const slot of ["instances-v2", "continuations-v1", windowsRootName]) {
      if (target === "all") {
        let names = [];
        try { names = await fs.readdir(path.join(this.store.root, slot)); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        sources.push(...names.filter((name) => !archived.has(name)).map((name) => path.join(this.store.root, slot, name, "codex-home")));
      } else if (target !== "shared") {
        sources.push(path.join(this.store.root, slot, target, "codex-home"));
      }
    }
    return [...new Set(sources.map((entry) => path.resolve(entry)))];
  }
  async syncSwitchWindowHistory(homePath, model, target = "all") {
    try { await fs.access(path.join(homePath, "state_5.sqlite")); }
    catch (error) {
      if (error.code === "ENOENT") return { imported: 0, missingFiles: 0, sources: [], pendingFirstLaunch: true };
      throw error;
    }
    return importConversations(await this.switchWindowSources(target), homePath, { model, provider: routerProviderID });
  }
  // 侧边栏里「点开空空的项目」：归属指向了本窗口根本不存在的会话。
  // 新建窗口最容易踩到——它一句对话都没有，却继承了整份项目元数据。
  // 这里逐个窗口按「本窗口真实存在的会话」重算，把空项目清掉；不动官方库。
  async pruneEmptyProjects({ dryRun = false } = {}) {
    const homes = [];
    for (const slot of ["continuations-v1", windowsRootName]) {
      let names = [];
      try { names = await fs.readdir(path.join(this.store.root, slot)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      for (const name of names.sort()) homes.push({ id: String(name), slot, home: path.join(this.store.root, slot, name, "codex-home") });
    }
    homes.push({ id: legacyWindowID, slot: "router-v1", home: windowPaths(this.store.root, legacyWindowID).homePath });
    const windows = [];
    let prunedProjects = 0;
    let prunedAssignments = 0;
    for (const entry of homes) {
      try {
        await fs.access(path.join(entry.home, ".codex-global-state.json"));
      } catch {
        windows.push({ id: entry.id, slot: entry.slot, skipped: "还没有全局状态，没东西可清" });
        continue;
      }
      const existingThreads = await readThreadIDs(entry.home);
      const result = await mergeGlobalProjectState([entry.home], entry.home, { existingThreads, dryRun });
      prunedProjects += result.projectsPruned ?? 0;
      prunedAssignments += result.assignmentsPruned ?? 0;
      windows.push({
        id: entry.id,
        slot: entry.slot,
        threads: existingThreads.size,
        // after 是 inspectGlobalProjectState 的计数结果，这里本来就是数字。
        projects: Number(result.after?.projects ?? 0),
        prunedProjects: result.projectsPruned ?? 0,
        prunedAssignments: result.assignmentsPruned ?? 0,
      });
    }
    const touched = windows.filter((entry) => entry.prunedProjects).length;
    return {
      windows,
      prunedProjects,
      prunedAssignments,
      dryRun,
      message: prunedProjects
        ? `${dryRun ? "预计" : "已"}清掉 ${prunedProjects} 个没有对话的空项目、${prunedAssignments} 条指向不存在会话的归属，涉及 ${touched} 个窗口`
        : "所有窗口的项目分组都只包含真实存在的会话，无需处理",
    };
  }
  async repairSwitchWindowMetadata(target = "all") {
    const { homePath } = this.switchPaths();
    const report = await repairProjectMetadata(await this.switchWindowSources(target), homePath);
    const addedProjects = Math.max(0, (report.after.projects || 0) - (report.before.projects || 0));
    const addedRoots = Math.max(0, (report.after.projectRoots || 0) - (report.before.projectRoots || 0));
    const reassignedThreads = report.reassignedThreads || 0;
    const global = report.globalState ?? {};
    const parts = [];
    if (addedProjects || addedRoots) parts.push(`补入 ${addedProjects} 个项目、${addedRoots} 条目录映射`);
    if (reassignedThreads) parts.push(`为 ${reassignedThreads} 条会话补回项目归属`);
    if (global.wrote) parts.push(`补入 ${global.projectsAdded || 0} 个侧边栏分组、${global.assignmentsAdded || 0} 条会话归属（去重 ${global.projectsDeduped || 0} 个重复项目）`);
    // 空项目是「只剩项目名字、点开没聊天」的元凶，修掉多少要说清楚。
    if (global.projectsPruned) parts.push(`清掉 ${global.projectsPruned} 个没有对话的空项目`);
    const changed = Boolean(parts.length);
    const running = (await this.runningWindows()).has(legacyWindowID);
    return {
      ...(await this.switchSummary()),
      switchHealth: report.after,
      globalState: global.after ?? null,
      message: [
        changed ? `已修复工作窗口分组：${parts.join("，")}。` : "工作窗口的项目分组元数据已完整，无需修复。",
        changed && running ? "工作窗口正在运行，需重启工作窗口后才能看到分组。" : changed ? "重新打开工作窗口后即可看到。" : "",
        global.error ? `侧边栏分组修复未完成：${global.error}` : "",
      ].filter(Boolean).join(" "),
    };
  }
  // 遗留入口：等价于打开注册表里的第一个窗口；没有在运行时才真的启动。
  async prepareSwitchWindow(initial = "") {
    return this.prepareWindow(legacyWindowID, initial);
  }
  async launchSwitchWindow(initial = "") {
    return this.openWindow(legacyWindowID, initial);
  }
  async importHistory(target = "all") {
    const prepared = await this.prepareSwitchWindow("");
    const report = await this.syncSwitchWindowHistory(prepared.homePath, prepared.chosen.slug, target);
    if (report.pendingFirstLaunch) throw new Error("请先启动一次可切换窗口，让 Codex 建好任务库，然后关闭它再导入已有会话");
    const scanned = report.sources.filter((entry) => entry.imported > 0).length;
    const global = report.globalState ?? {};
    const grouping = global.wrote
      ? ` 同时补入 ${global.projectsAdded || 0} 个侧边栏分组、${global.assignmentsAdded || 0} 条会话归属。`
      : "";
    return {
      ...(await this.switchSummary()),
      importReport: report,
      message: report.imported
        ? `已导入 ${report.imported} 个会话（来自 ${scanned} 个任务库）。重新打开切换窗口后即可看到；来源任务库没有被改动。${grouping}`
        : `没有发现新的会话可导入；已有的会话已全部在切换窗口里。${grouping}`,
    };
  }
  async importLibrary(input, revision) {
    if (input.schemaVersion !== 2 || !Array.isArray(input.routes) || input.routes.length > 500) throw new Error("导入格式不正确，最多允许 500 个模型");
    return this.store.mutate(revision, (data) => {
      for (const entry of input.routes) {
        if (entry.id === "official") continue;
        const id = `import-${randomUUID()}`;
        const route = validateRoute({ ...entry, id, credentialID: id });
        data.routes.push(route);
      }
      return data;
    });
  }
  async diagnostics() {
    const data = await this.store.publicData();
    let gateway = "未运行";
    try { await this.gatewayReady(); gateway = "正常"; } catch { }
    let installed = false;
    try { await requireCodexApp(); installed = true; } catch { }
    const table = buildRouterTable(data.routes);
    const active = data.routes.filter((route) => !route.archived && route.protocol !== "oauth");
    const missingKey = active.filter((route) => !route.noKey && !route.hasKey).map((route) => route.name);
    const verifiedCount = active.filter((route) => route.verifiedAt).length;
    const switchable = active.filter((route) => route.switchable).map((route) => route.name);
    const prepared = active.filter((route) => route.fallback).length;
    const switchStore = await inspectConversationStore(this.switchPaths().homePath);
    const switchLine = switchStore.ready
      ? `工作窗口任务库：${switchStore.threads} 条会话，${switchStore.projects} 个项目，${switchStore.projectRoots} 条目录映射，${switchStore.threadsWithProject || 0} 条已挂到项目`
      : "工作窗口任务库：尚未初始化，先打开一次工作窗口即可建立";
    const switchHealth = switchStore.ready && switchStore.threads > 0 && (
      switchStore.projects === 0 ||
      (switchStore.projects > 0 && (switchStore.threadsWithProject || 0) === 0)
    )
      ? "项目分组关系缺失：会话仍在，但侧边栏可能只剩列表；可直接点「修复工作窗口」补回"
      : "项目分组元数据：正常";
    // 磁盘也要出现在诊断里：副本堆到 30 GB 以上是这套多窗口机制最容易失控的地方。
    let diskLine = "磁盘：无法读取";
    try {
      const plan = await cleanupPlan({ root: this.store.root, officialHome: this.officialHome, runningIds: new Set([...(await this.runningWindows()).keys()]) });
      const usage = await diskUsage({ root: this.store.root, plan });
      const gb = (bytes) => Math.round((bytes / 1024 ** 3) * 10) / 10;
      diskLine = `磁盘：助手目录 ${gb(usage.totalBytes)} GB，可回收 ${gb(usage.reclaimable)} GB（${plan.items.length} 个会话副本 + ${plan.caches.length} 个缓存目录），系统剩余 ${usage.freeDiskPercent.toFixed(1)}%；官方库与 ${plan.keepOriginals.count} 条原件不动`;
      // 正在运行的窗口现在要报出「关掉后还能回收多少」，只说「正在运行」用户没法判断值不值得关。
      for (const entry of plan.skipped) diskLine += `；${entry.id} 正在运行，关闭后自动清理 ${gb(entry.bytes ?? 0)} GB`;
    } catch (error) {
      diskLine = `磁盘：读取失败（${error.message}）`;
    }
    return {
      message: [
        `模型网关：${gateway}`,
        `Codex App：${installed ? "已安装" : "未安装"}`,
        `模型库：${data.routes.length} 个，版本 ${data.revision}`,
        `可切换窗口：${table.length} 个模型可选（官方 ChatGPT 登录与已归档模型不在其中）`,
        switchLine,
        switchHealth,
        diskLine,
        `本窗口可切换的条目：${switchable.length ? switchable.join("、") : "尚未开启，可在条目里点「本窗口也可切换模型」"}`,
        `配置了备用模型：${prepared ? `${prepared} 个` : "无，可在编辑模型里选「主模型失败时改用」"}`,
        `真实推理已验证：${verifiedCount}/${active.length}${missingKey.length ? `；还缺 Key：${missingKey.join("、")}` : ""}`,
        "密钥：用户私有文件（0700/0600），不包含在导出中",
        "接口适配：Responses / Chat / Anthropic；Chat 与 Anthropic 按流式增量输出，函数调用支持",
        "各供应商权限与完整工具兼容性需要实际验证",
      ].join("\n"),
    };
  }
}
