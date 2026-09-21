import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID, randomBytes } from "node:crypto";
import { templates } from "./provider-templates.mjs";
import { buildRouterTable } from "./router.mjs";
import { resolveContextWindow, usableWindow } from "./model-windows.mjs";

export const defaultRoot = path.join(os.homedir(), ".codex/model-assistant");
export const validID = (id) => typeof id === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(id);

export function isLegacyOfficialProxy(route) {
  return String(route?.id ?? "").startsWith("official-") && route?.protocol === "chatgpt";
}

export async function atomicJSON(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

// 用户常常直接粘贴控制台地址（例如 http://127.0.0.1:8080/#accounts）或省略 /v1，这里统一成可用的服务根地址。
export function normalizeEndpoint(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return raw;
  let text = raw.split("#")[0].split("?")[0].trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const local = /^(localhost|127\.0\.0\.1|\[::1\]|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?(\/|$)/.test(text);
    text = `${local ? "http" : "https"}://${text.replace(/^\/+/, "")}`;
  }
  try {
    const url = new URL(text);
    url.search = "";
    url.hash = "";
    const path = url.pathname.replace(/\/+$/, "");
    url.pathname = path === "" ? "/v1" : path;
    return url.href.replace(/\/$/, "");
  } catch {
    return raw;
  }
}

export function validateRoute(input) {
  if (!validID(input.id)) throw new Error("模型标识无效");
  const route = {};
  for (const key of ["id", "name", "vendor", "endpoint", "protocol", "model", "notes", "docs", "credentialID", "fallback", "runtimeProfile"]) {
    route[key] = String(input[key] ?? "").trim();
    if (route[key].length > (key === "notes" ? 2000 : 500) || /[\u0000-\u001f]/.test(route[key])) throw new Error("字段过长或包含控制字符");
  }
  if (input.routerSlug !== undefined) {
    if (typeof input.routerSlug !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,499}$/.test(input.routerSlug)) throw new Error("路由模型标识无效");
    route.routerSlug = input.routerSlug;
  }
  if (input.routerAliases !== undefined) {
    if (!Array.isArray(input.routerAliases) || input.routerAliases.length > 100 || input.routerAliases.some(x => typeof x !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,499}$/.test(x))) throw new Error("历史路由标识无效");
    route.routerAliases = [...new Set(input.routerAliases)];
  }
  if (Array.isArray(input.reasoningLevels)) route.reasoningLevels = input.reasoningLevels.filter(x => ["none","minimal","low","medium","high","xhigh","max","ultra"].includes(x));
  if (route.reasoningLevels?.includes(input.defaultReasoning)) route.defaultReasoning = input.defaultReasoning;
  if (!route.name) throw new Error("请输入模型名称");
  if (!["oauth", "responses", "chat", "anthropic", "chatgpt"].includes(route.protocol)) throw new Error("不支持此接口协议");
  route.runtimeProfile ||= "auto";
  if (!["auto", "lite", "full"].includes(route.runtimeProfile)) throw new Error("Codex 环境应为 auto / lite / full");
  if (route.protocol === "oauth" && route.id !== "official") throw new Error("ChatGPT 登录仅用于官方入口");
  if (route.id === "official" && route.protocol !== "oauth") throw new Error("官方入口不能更换协议");
  if (route.protocol === "oauth") {
    // 官方桌面端自己维护模型选择。Model Router 不保存也不伪造官方模型 ID。
    route.model = "";
    route.endpoint = "";
    route.credentialID = route.id;
    route.runtimeProfile = "full";
  }
  if (route.protocol === "chatgpt") {
    // 官方模型走 Codex 自己的 ChatGPT 登录，不需要地址和密钥。
    route.endpoint = "https://chatgpt.com/backend-api/codex";
    route.noKey = true;
    route.credentialID = route.id;
  } else if (route.protocol !== "oauth") {
    let url;
    try { url = new URL(route.endpoint); } catch { throw new Error("请输入有效的服务地址"); }
    const local = /^(localhost|127\.0\.0\.1|\[::1\]|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("远程服务必须使用 HTTPS；本机和局域网允许 HTTP");
    if (url.username || url.password || url.search || url.hash) throw new Error("地址不能包含密码、查询参数或片段");
    route.endpoint = url.href.replace(/\/$/, "");
  }
  if (route.docs && !route.docs.startsWith("https://")) throw new Error("文档地址必须使用 HTTPS");
  route.credentialID ||= route.id;
  if (!validID(route.credentialID)) throw new Error("密钥标识无效");
  route.noKey = route.protocol === "oauth" || Boolean(input.noKey);
  if (route.protocol === "chatgpt") route.noKey = true;
  // 隐藏条目不在模型库列表里显示，但仍会出现在可切换窗口的选择器中。
  route.hidden = route.protocol === "oauth" ? false : Boolean(input.hidden);
  route.archived = route.id === "official" ? false : Boolean(input.archived);
  // 官方登录入口自带模型选择；第三方条目可以选择"这个窗口也能切模型"。
  route.switchable = route.protocol === "oauth" ? false : Boolean(input.switchable);
  // 主模型失败（额度、限流、服务异常）时改用的备用条目，可为空。
  route.fallback = route.protocol === "oauth" ? "" : String(route.fallback || "").trim();
  if (route.fallback && (!validID(route.fallback) || route.fallback === route.id)) throw new Error("备用模型填写不正确");
  // 没填（或填 0）= 自动：按模型名匹配真实窗口，查不到就 512K 兜底。
  // 填了具体数字就按填的来，但越界要拦住，不能悄悄换成兜底值。
  const suppliedWindow = input.contextWindow;
  if (suppliedWindow === undefined || suppliedWindow === null || suppliedWindow === "" || Number(suppliedWindow) === 0) {
    route.contextWindow = resolveContextWindow({ model: route.model, contextWindow: 0 });
  } else {
    route.contextWindow = usableWindow(suppliedWindow);
    if (!route.contextWindow) throw new Error("上下文长度应为 4096–2000000（留空表示按模型自动匹配）");
  }
  if (!Number.isInteger(route.contextWindow) || route.contextWindow < 4096 || route.contextWindow > 2000000) throw new Error("上下文长度应为 4096–2000000");
  return route;
}

function seeds() {
  const routes = [
    { id: "official", name: "ChatGPT Desktop（官方）", vendor: "OpenAI 官方", model: "", protocol: "oauth", noKey: true },
    ...templates.filter((entry) => entry.id !== "custom").map((entry) => ({ ...entry, id: entry.id === "deepseek" ? "deepseek-flash" : entry.id, vendor: entry.name, credentialID: entry.id })),
    { id: "deepseek-pro", name: "DeepSeek Pro", vendor: "DeepSeek 官方", model: "deepseek-v4-pro", protocol: "responses", endpoint: "https://api.deepseek.com/v1", credentialID: "deepseek" },
    { id: "agnes", name: "Agnes 2.5 Flash", vendor: "已有服务", model: "agnes-2.5-flash", protocol: "responses", endpoint: "http://127.0.0.1:18790/v1" },
    { id: "s5090-qwen", name: "Qwen3.8 27B · 5090", vendor: "局域网 5090", model: "qwen3.8:27b-96k", protocol: "chat", endpoint: "http://127.0.0.1:18791/v1", noKey: true },
    { id: "s5090-ornith", name: "Ornith 1.5 35B · 5090", vendor: "局域网 5090", model: "ornith-1.5:35b-96k", protocol: "chat", endpoint: "http://127.0.0.1:18791/v1", noKey: true },
  ];
  const validated = routes.map(validateRoute);
  for (const { slug, route } of buildRouterTable(validated)) route.routerSlug = slug;
  return { schemaVersion: 2, revision: 1, routes: validated };
}

export class ModelStore {
  constructor(root = defaultRoot) { this.root = root; this.file = path.join(root, "library.json"); }
  async read() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (data.schemaVersion !== 2 || !Array.isArray(data.routes)) throw new Error("模型库版本不兼容");
      const before = structuredClone(data);
      const validated = data.routes.map(validateRoute);
      const legacyOfficialIDs = new Set(validated.filter(isLegacyOfficialProxy).map((route) => route.id));
      let migrated = legacyOfficialIDs.size > 0;
      for (const { slug, route } of buildRouterTable(validated)) {
        if (!route.routerSlug) { route.routerSlug = slug; migrated = true; }
      }
      data.routes = validated
        .filter((route) => !legacyOfficialIDs.has(route.id))
        .map((route) => {
          const next = { ...route };
          if (next.id === "official") {
            if (next.name !== "ChatGPT Desktop（官方）" || next.vendor !== "OpenAI 官方" || next.model !== "" || next.endpoint !== "") migrated = true;
            next.name = "ChatGPT Desktop（官方）";
            next.vendor = "OpenAI 官方";
            next.model = "";
            next.endpoint = "";
            next.hidden = false;
            next.archived = false;
            next.switchable = false;
            next.fallback = "";
          } else if (legacyOfficialIDs.has(next.fallback)) {
            next.fallback = "";
            migrated = true;
          }
          return next;
        });
      if (new Set(data.routes.map((route) => route.id)).size !== data.routes.length) throw new Error("模型库标识重复");
      if (migrated) {
        data.revision = Math.max(1, Number(data.revision) || 1) + 1;
        await atomicJSON(path.join(this.root, "backups", `library-before-official-cleanup-${Date.now()}-${randomUUID()}.json`), before);
        await atomicJSON(this.file, data);
        for (const id of legacyOfficialIDs) {
          await Promise.all([
            fs.rm(path.join(this.root, "checks", `${id}.json`), { force: true }),
            fs.rm(path.join(this.root, "tokens", id), { force: true }),
            fs.rm(path.join(this.root, "credentials", id), { force: true }),
          ]).catch(() => {});
        }
      }
      return data;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      const data = seeds();
      try { await fs.writeFile(this.file, JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" }); }
      catch (writeError) { if (writeError.code !== "EEXIST") throw writeError; return this.read(); }
      return data;
    }
  }
  async secret(id) {
    if (!validID(id)) throw new Error("密钥标识无效");
    try { return (await fs.readFile(path.join(this.root, "credentials", id), "utf8")).trim(); }
    catch (error) { if (error.code !== "ENOENT") throw error; return ""; }
  }
  async writeSecret(id, secret) {
    if (!validID(id) || typeof secret !== "string" || secret.length > 16000 || /[\r\n\0]/.test(secret)) throw new Error("密钥格式无效");
    const directory = path.join(this.root, "credentials");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const temporary = path.join(directory, `.${randomUUID()}`);
    await fs.writeFile(temporary, secret.trim(), { mode: 0o600 });
    await fs.rename(temporary, path.join(directory, id));
  }
  async route(id) {
    const route = (await this.read()).routes.find((entry) => entry.id === id);
    if (!route) throw new Error("模型不存在");
    return route;
  }
  async publicData() {
    const data = await this.read();
    const routes = await Promise.all(data.routes.map(async (route) => {
      let verifiedAt = null;
      try {
        const check = JSON.parse(await fs.readFile(path.join(this.root, "checks", `${route.id}.json`), "utf8"));
        if (check.ok && check.model === route.model && check.endpoint === route.endpoint && check.protocol === route.protocol && check.credentialVersion === await this.credentialVersion(route.credentialID)) verifiedAt = check.testedAt;
      } catch { }
      return { ...route, hasKey: Boolean(await this.secret(route.credentialID)), verifiedAt };
    }));
    return { ...data, routes, templates };
  }
  async credentialVersion(id) {
    if (!validID(id)) throw new Error("密钥标识无效");
    try { return (await fs.stat(path.join(this.root, "credentials", id))).mtimeMs; }
    catch (error) { if (error.code !== "ENOENT") throw error; return 0; }
  }
  async mutate(revision, operation) {
    await this.read();
    const lockPath = path.join(this.root, "library.lock");
    let lock;
    try { lock = await fs.open(lockPath, "wx", 0o600); }
    catch (error) {
      if (error.code === "EEXIST") throw new Error("另一窗口正在保存，请刷新后重试；异常退出后可检查模型库的 library.lock");
      throw error;
    }
    try {
      await lock.writeFile(String(process.pid));
      const data = await this.read();
      if (data.revision !== revision) throw new Error("配置已在另一窗口更新，请刷新后重试");
      const next = await operation(structuredClone(data));
      next.revision = data.revision + 1;
      await atomicJSON(path.join(this.root, "backups", `library-${Date.now()}-${randomUUID()}.json`), data);
      await atomicJSON(this.file, next);
      return next;
    } finally { await lock.close(); await fs.unlink(lockPath); }
  }
  async save(input, revision, secret, clearKey = false) {
    const route = validateRoute({ ...input, endpoint: normalizeEndpoint(input.endpoint) });
    return this.mutate(revision, async (data) => {
      const prior = data.routes.find((entry) => entry.id === route.id);
      // UI does not own routing identity. Preserve it across model, name and provider edits.
      delete route.routerSlug;
      if (prior?.routerAliases) route.routerAliases = prior.routerAliases;
      if (route.protocol === "chatgpt" && prior?.model === route.model && !route.reasoningLevels) { route.reasoningLevels = prior.reasoningLevels; route.defaultReasoning = prior.defaultReasoning; }
      if (prior?.routerSlug) route.routerSlug = prior.routerSlug;
      else {
        const entry = buildRouterTable([...data.routes.filter(r => r.id !== route.id), route]).find(e => e.route.id === route.id);
        if (entry) route.routerSlug = entry.slug;
      }
      const sharedElsewhere = data.routes.some((entry) => entry.id !== route.id && entry.credentialID === route.credentialID && entry.endpoint !== route.endpoint);
      if (sharedElsewhere || (prior && prior.endpoint !== route.endpoint && prior.credentialID === route.credentialID)) {
        route.credentialID = `key-${randomUUID()}`;
      }
      if (secret?.trim()) await this.writeSecret(route.credentialID, secret);
      else if (clearKey) await this.writeSecret(route.credentialID, "");
      const index = data.routes.findIndex((entry) => entry.id === route.id);
      if (index >= 0) data.routes[index] = route;
      else data.routes.push(route);
      return data;
    });
  }
  async token(id) {
    if (!validID(id)) throw new Error("模型标识无效");
    const directory = path.join(this.root, "tokens");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, id);
    try { await fs.writeFile(file, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    return fs.readFile(file, "utf8");
  }
}
