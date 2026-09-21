import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { portableHistory } from "./portable-history.mjs";

// 官方 ChatGPT 登录与续期由 Codex 维护；网关只读取，避免竞争刷新令牌。
export const authPath = path.join(os.homedir(), ".codex", "auth.json");
export const chatgptBaseURL = "https://chatgpt.com/backend-api/codex";
export const chatgptClientID = "app_EMoamEEZ73f0CkXaXp7hrann";

export async function readAuth(file = authPath) {
  const auth = JSON.parse(await fs.readFile(file, "utf8"));
  if (auth.auth_mode !== "chatgpt" || !auth.tokens?.access_token) throw new Error("请先在 Codex 里登录 ChatGPT，再使用官方模型");
  return auth;
}

export function tokenExpiry(token) {
  try { return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString()).exp * 1000; }
  catch { return 0; }
}

function tokenClaims(token) {
  try { return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString()); }
  catch { return {}; }
}

// 只向产品界面暴露账号标识，不返回任何 access/refresh/id token。
// 工作窗口和网关都复用 ~/.codex/auth.json；这里显示的就是官方请求实际使用的账号。
export function accountSummary(auth, { now = Date.now() } = {}) {
  const tokens = auth?.tokens ?? {};
  const access = tokenClaims(tokens.access_token);
  const identity = tokenClaims(tokens.id_token);
  const profile = access["https://api.openai.com/profile"] ?? {};
  const accountID = String(tokens.account_id ?? "").trim();
  const expiry = tokenExpiry(tokens.access_token) || tokenExpiry(tokens.id_token);
  const signedIn = auth?.auth_mode === "chatgpt" && Boolean(tokens.access_token && accountID);
  return {
    signedIn,
    name: String(identity.name ?? access.name ?? profile.name ?? "").trim(),
    email: String(identity.email ?? access.email ?? profile.email ?? "").trim(),
    accountSuffix: accountID ? accountID.slice(-8) : "",
    expiresAt: expiry ? new Date(expiry).toISOString() : "",
    expired: Boolean(expiry && expiry <= now),
  };
}

export async function officialAccount({ file = authPath, now = Date.now() } = {}) {
  try { return accountSummary(JSON.parse(await fs.readFile(file, "utf8")), { now }); }
  catch { return { signedIn: false, name: "", email: "", accountSuffix: "", expiresAt: "", expired: false }; }
}

export async function officialTokens({ file = authPath, now = Date.now() } = {}) {
  // Codex owns refresh-token rotation. A proxy must not race it or overwrite auth.json.
  let auth;
  try { auth = await readAuth(file); }
  catch { const error = new Error("请先打开官方 ChatGPT Desktop / Codex 并登录；第三方模型仍可正常使用"); error.status = 401; throw error; }
  const expiry = tokenExpiry(auth.tokens.access_token);
  if (expiry && expiry <= now) {
    const error = new Error("官方登录已过期，请打开官方客户端刷新登录后重试；无需退出账号即可改用第三方模型");
    error.status = 401; throw error;
  }
  return auth.tokens;
}

export function officialHeaders(tokens, sessionID) {
  return {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: `Bearer ${tokens.access_token}`,
    "chatgpt-account-id": tokens.account_id,
    originator: "codex_cli_rs",
    session_id: sessionID,
    "user-agent": "codex_cli_rs/0.155.0-alpha.2.6 (Mac OS; arm64) terminal",
  };
}

// 官方后端不接受 max_output_tokens 等服务端自己管理的参数。
export function officialPayload(payload, model) {
  const body = portableHistory(payload);
  delete body.max_output_tokens;
  delete body.service_tier;
  delete body.session_id;
  body.model = model;
  body.store = false;
  body.stream = true;
  body.instructions ??= "";
  if (typeof body.input === "string") body.input = [{ role: "user", content: body.input }];
  return body;
}

export async function officialModels(home = path.dirname(authPath)) {
  await officialTokens({ file: path.join(home, "auth.json") });
  let catalog;
  try { catalog = JSON.parse(await fs.readFile(path.join(home, "models_cache.json"), "utf8")); }
  catch { throw new Error("请先在官方客户端打开一次模型菜单以更新模型目录，再同步登录模型"); }
  const models = (catalog.models || []).filter(m => typeof m.slug === "string" && m.visibility === "list");
  if (!models.length) throw new Error("官方模型目录为空，请先打开官方客户端刷新");
  return models;
}

export async function officialResponseJSON(response) {
  let buffer = "", bytes = 0;
  const decoder = new TextDecoder();
  const completedItems = new Map();
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 32 * 1024 * 1024) throw new Error("官方验证响应过大");
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!line.startsWith("data:")) continue;
      const value = line.slice(5).trim();
      if (!value || value === "[DONE]") continue;
      const event = JSON.parse(value);
      if (event.type === "response.output_item.done" && event.item) completedItems.set(event.output_index ?? completedItems.size, event.item);
      if (event.type === "response.completed") return { ...event.response, output: event.response?.output?.length ? event.response.output : [...completedItems].sort((a,b) => a[0]-b[0]).map(([,item]) => item) };
      if (event.type === "response.failed" || event.type === "error") {
        const error = new Error(event.response?.error?.message || event.error?.message || event.message || "官方推理失败");
        error.status = event.response?.error?.code === "insufficient_quota" ? 429 : 502;
        throw error;
      }
    }
  }
  throw new Error("官方响应中断，未收到完成事件");
}
