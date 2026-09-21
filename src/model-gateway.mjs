import http from "node:http";
import fs from "node:fs";
// 注意：node:fs 是回调版。之前两个「留痕」函数用 await fs.readFile/fs.writeFile 写文件，
// 这两个调用会直接抛 TypeError（缺 callback），又被外层 catch{} 吞掉——
// 结果是记录一条都没写下来，而调用方以为成功了。写文件一律用 promises 版。
import fsPromises from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ModelStore } from "./model-store.mjs";
import { LocalQueue } from "./local-queue.mjs";
import { buildRouterTable, routerID, routerTableEntry } from "./router.mjs";
import { toChat, toAnthropic, fromCompletion, responseEvents, createResponseStream, nativePayload } from "./protocol-adapter.mjs";
import { anthropicStreamParser, chatStreamParser } from "./stream-parsers.mjs";
import { chatgptBaseURL, officialHeaders, officialPayload, officialTokens, officialResponseJSON } from "./chatgpt-auth.mjs";
import {
  buildCompactedInput,
  estimateTokens,
  extractSummary,
  fallbackSummary,
  safeSplitIndex,
  summaryRequest,
  transcriptOf,
  trimOldToolOutputs,
} from "./context-compaction.mjs";
import { contextWindowFromMessage, resolveContextWindow } from "./model-windows.mjs";
import { payloadForRoute, payloadSize } from "./runtime-profile.mjs";
export { estimateTokens };

export const gatewayPort = 18793;
export const gatewayURL = `http://127.0.0.1:${gatewayPort}`;
// 供应商长时间一个字节都不返回时主动断开，避免窗口卡死；正文在流动时不会触发。
export const streamIdleMs = 300000;

// 网关进程可能由 launchd、助手应用或 CLI 启动；用源码指纹判断在跑的进程是不是当前代码。
// 指纹只跟着真正的 import 走：改一个网关根本不加载的文件（例如 product-service.mjs）不该被误判成“必须重启”。
function loadedModules(entry, seen = new Set()) {
  const url = new URL(entry, import.meta.url);
  if (seen.has(url.href)) return seen;
  seen.add(url.href);
  let source;
  try { source = fs.readFileSync(url, "utf8"); } catch { return seen; }
  for (const pattern of [/from\s*["'](\.\/[^"']+)["']/g, /import\s*\(\s*["'](\.\/[^"']+)["']\s*\)/g]) {
    for (const match of source.matchAll(pattern)) loadedModules(match[1], seen);
  }
  return seen;
}

// 指纹必须与目录无关：仓库里的源码和安装后的 runtime-v2 副本是同一份代码，指纹要一致。
const gatewayRoot = path.dirname(fileURLToPath(import.meta.url));
export const gatewayBuild = createHash("sha256")
  .update([...loadedModules("model-gateway.mjs")]
    .map((href) => fileURLToPath(href))
    .map((file) => ({ name: path.relative(gatewayRoot, file), source: fs.readFileSync(file, "utf8") }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((entry) => `${entry.name}\n${entry.source}`)
    .join("\n"))
  .digest("hex")
  .slice(0, 12);

// 请求体上限按「整段对话历史」来定，不是按一轮对话：Codex 每发一次请求都会把完整历史
// （含工具输出的全文）重新发上来，所以一个几十 MB 的长会话完全正常。
// 以前是 8 MB，长会话必然撞线，用户看到的是「502 请求或响应超过大小限制」——看起来像模型坏了，
// 其实只是网关自己把请求挡掉了。
export const requestLimitBytes = 256 * 1024 * 1024;
export const responseLimitBytes = 512 * 1024 * 1024;

export class PayloadTooLargeError extends Error {
  constructor(message, limit, kind) {
    super(message);
    this.name = "PayloadTooLargeError";
    this.status = 413;
    this.limit = limit;
    this.kind = kind;
  }
}

export async function limitedJSON(stream, limit = requestLimitBytes) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > limit) {
      throw new PayloadTooLargeError(
        `这段对话的请求体超过 ${Math.round(limit / 1024 / 1024)} MB 上限（已读到 ${Math.round(length / 1024 / 1024)} MB）。`
        + "多轮长对话会把整段历史一起发上来，工具输出的长文本是主要来源。"
        + "可以：① 新开一个会话继续同一件事；② 在当前会话里改用「压缩」后继续；③ 在助手设置里调高上限。",
        limit,
        "request",
      );
    }
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const value = JSON.parse(text);
  // 调用方常常拿不到原始字节数（流已经读完了），而上下文预检需要它。
  // 挂在返回值上既不用改所有调用点，也不会混进 JSON 本身。
  if (value && typeof value === "object" && !Array.isArray(value)) Object.defineProperty(value, "__bytes", { value: length, enumerable: false });
  return value;
}

async function limitedText(stream, limit = responseLimitBytes) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > limit) {
      throw new PayloadTooLargeError(
        `供应商返回的响应超过 ${Math.round(limit / 1024 / 1024)} MB 上限。请缩小提问范围或换用上下文更小的模型。`,
        limit,
        "response",
      );
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// 供应商错误里常带着用户必须看到的原因（额度耗尽、模型不存在、区域限制）。
// 只取标准 JSON 错误里的 message，并抹掉像密钥的东西，其余原始正文一律不落盘、不回显。
export function redactDetail(text) {
  return String(text)
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_\-]{6,}/g, "[已隐藏密钥]")
    .replace(/\bBearer\s+[A-Za-z0-9._\-]{6,}/gi, "Bearer [已隐藏]")
    .replace(/\b[A-Za-z0-9+/=_-]{40,}\b/g, "[已隐藏长令牌]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

export async function failureDetail(response) {
  try {
    const text = (await response.text()).slice(0, 8192);
    const data = JSON.parse(text);
    const message = data?.error?.message ?? data?.error?.detail ?? data?.message ?? data?.error;
    if (typeof message !== "string" || !message.trim()) return "";
    return redactDetail(message);
  } catch { return ""; }
}

export const quotaPattern = /quota|resource_exhausted|额度|余额|balance|credit|insufficient|限流|rate limit|too many requests/i;

// 让 Codex 停止无效重试并显示真实原因：4xx 判为请求级失败，额度类判为额度失败，其余保持可重试。
export function failureCode(status, detail) {
  // Rate limits, authentication and context failures do not mean the balance is exhausted.
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_denied";
  // 供应商自己报的上下文超限：单独给一个 code，界面才能提示「换个上下文更大的模型」。
  if (/context_window|context length|ContextWindowExceeded|maximum context|too many tokens/i.test(String(detail ?? ""))) return "context_length_exceeded";
  // 超限要说清是「网关挡下的」而不是「模型坏了」：这个 code 让界面能给出可操作的建议。
  if (status === 413) return "payload_too_large";
  if (/insufficient_quota|quota[_ ](?:exceeded|exhausted)|(?:quota|credits?|balance).{0,24}(?:exhausted|depleted|insufficient)|(?:额度|余额).{0,8}(?:不足|耗尽|用尽)/i.test(String(detail ?? ""))) return "insufficient_quota";
  if (status === 429 || /rate.?limit|too many requests|resource_exhausted|限流|请求过于频繁/i.test(String(detail ?? ""))) return "rate_limit_exceeded";
  if (status >= 400 && status < 500) return "invalid_prompt";
  return "";
}

// 一个窗口实际能装下多少输入：要留出这次回答的输出空间，也要给摘要本身留位置。
// 官方模型按 95% 算，第三方引擎很难吃满标称窗口，这里按 90% 算——宁可早一点压缩，
// 也不要把请求发出去、等供应商报 400。
export function contextBudget(route) {
  const window = resolveContextWindow(route);
  return window > 0 ? Math.floor(window * 0.9) : 0;
}

// 供应商自己报「上下文超了」时用得上：Codex 对这类模型不会自己压缩（已实测），
// 所以网关要认得出这个错误，替它压一次再重试。
export function isContextOverflow(error) {
  return failureCode(error?.status ?? 0, error?.detail || "") === "context_length_exceeded";
}

// 压缩：把较早的记录换成摘要，保留最近一段完整对话。
// 保留量取窗口的 45%——留出输出空间，也让摘要本身有地方放。
// 返回值里的 note 会拼进用户可见的说明，让用户知道发生了什么，而不是悄悄改了他的历史。
export async function compactForWindow({ store, route, payload, limit, signal, keepRatio = 0.45, force = false, sessionId = "" }) {
  const items = payload?.input;
  if (!Array.isArray(items) || items.length < 6) return null;
  const keepBudgetBytes = Math.max(64 * 1024, Math.floor(limit * keepRatio) * 3.2);
  const split = safeSplitIndex(items, keepBudgetBytes, { force });
  if (!split) return null;
  const head = items.slice(0, split);
  const tail = items.slice(split);

  // 摘要请求本身也要装得下：给 128K 的模型做摘要时，把 150 万 token 的记录整段丢过去
  // 只会让摘要这一步也失败。所以先估一下摘要请求的量，装不下就换本机窗口最大的那个模型来做。
  const transcript = transcriptOf(head);
  const summarizer = await pickSummarizer(store, route, Math.round(transcript.length / 3.2));
  let summary = "";
  let summaryAudit = null;
  try {
    const key = await store.secret(summarizer.credentialID);
    const request = summaryRequest(transcript, summarizer.model);
    // 摘要请求也要走和正常请求同一套协议转换：chat / anthropic 供应商收到 Responses 结构只会报错。
    let suffix = "responses";
    let summaryBody = nativePayload(request, summarizer.model);
    if (summarizer.protocol === "chat") {
      suffix = "chat/completions";
      summaryBody = toChat(request).body;
    } else if (summarizer.protocol === "anthropic") {
      suffix = "messages";
      summaryBody = toAnthropic(toChat(request).body);
    }
    // 摘要请求同样会真花钱，而且带着整段历史（上下文最大的请求）。
    // 它绕过了上面那个路由候选循环，所以必须单独记一笔——否则「今天请求都去了谁」是漏的。
    summaryAudit = await noteRoute(store.root, summarizer, { model: summarizer.model, kind: "summary", sessionId });
    const result = summarizer.protocol === "chatgpt"
      ? await officialUpstream(summarizer, request, signal, 120000)
      : await upstream(summarizer, key, suffix, summaryBody, 120000, signal, sessionId);
    const body = summarizer.protocol === "chatgpt" ? await officialResponseJSON(result) : await limitedJSON(result.body, responseLimitBytes);
    await confirmRoute(store.root, summaryAudit.requestId, { observedModel: body?.model || "", protocol: summarizer.protocol });
    if (summarizer.protocol === "chat") summary = String(body?.choices?.[0]?.message?.content ?? "").trim();
    else if (summarizer.protocol === "anthropic") summary = extractSummary({ output: (body?.content ?? []).map((part) => ({ type: "message", content: [part] })) });
    else summary = extractSummary(body);
  } catch (error) {
    if (summaryAudit) await failRoute(store.root, summaryAudit.requestId, { protocol: summarizer.protocol, error: errorMessage(error) });
    // 摘要调不通也要让对话能继续：退回「列出被裁掉的用户消息」，并把这件事如实写在提示里。
    summary = "";
  }
  if (!summary) summary = fallbackSummary(head);
  const dropped = head.length;
  return {
    input: [...head.filter((item) => ["system", "developer"].includes(item?.role)), ...buildCompactedInput({ summary, tail, droppedCount: dropped })],
    note: `较早的 ${dropped} 条记录已压缩为摘要（保留最近 ${tail.length} 条，摘要由 ${summarizer.name || summarizer.id} 生成）`,
  };
}

// 优先用目标模型自己（不额外花钱、不跨供应商）；它装不下摘要请求时，
// 退而用本机窗口最大的那个条目——总比摘要失败、退化成「列出被裁掉的用户消息」好。
export async function pickSummarizer(store, route, neededTokens) {
  if (resolveContextWindow(route) >= neededTokens) return route;
  const data = await store.read();
  const candidates = data.routes
    .filter((entry) => !entry.archived && entry.protocol !== "oauth" && entry.model && (entry.protocol === "chatgpt") === (route.protocol === "chatgpt"))
    .sort((left, right) => resolveContextWindow(right) - resolveContextWindow(left));
  return candidates[0] ?? route;
}

// opencode 的 Go 接口要求每个请求带 x-opencode-session，缺了会直接 400
// （MissingSessionID）。后果不只是这次失败：网关会把它当成一次普通故障，
// 静默 fallback 到备用模型，而备用那条多半是按量计费的——用户以为在用订阅，
// 钱却扣在另一个账号上。所以这个头是必须的。
const opencodeSessions = new Map();
export function opencodeSessionFor(route, preferred = "") {
  const wanted = String(preferred ?? "").trim();
  if (wanted) return wanted;
  const key = `${new URL(route.endpoint).origin}`;
  if (!opencodeSessions.has(key)) opencodeSessions.set(key, randomUUID());
  return opencodeSessions.get(key);
}

function isOpencodeEndpoint(endpoint) {
  try { return new URL(endpoint).hostname.endsWith("opencode.ai"); } catch { return false; }
}

// 静默 fallback 会悄悄花用户的钱：从订阅制切到按量计费，界面上完全看不出来。
// 今天就发生过一次——opencode 因为缺一个请求头全部失败，几百次请求全部落到
// DeepSeek 官方按量扣费，用户只看到「官网的量一直在涨」，却不知道是谁在花。
// 所以每一次 fallback 都必须留痕：标准输出 + 一个供界面读取的事件文件。
// 每个请求实际走了哪个上游，都要留一条记录。
// 用户问「我的钱到底花在谁那儿」时，靠推理和日志都太绕——这条记录是直接答案：
// 最近 N 次请求分别打到了哪个域名、用的哪个条目。
let routeAuditQueue = Promise.resolve();
function serializeRouteAudit(operation) {
  const next = routeAuditQueue.then(operation, operation);
  routeAuditQueue = next.catch(() => {});
  return next;
}

function auditDay(value = new Date()) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

async function updateAuditUsage(root, entry, phase) {
  const file = path.join(root, "usage-by-day.json");
  let data = {};
  try { data = JSON.parse(await fsPromises.readFile(file, "utf8")); } catch { }
  if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
  const day = auditDay(new Date(entry.at));
  const bucket = data[day] && typeof data[day] === "object" ? data[day] : {};
  for (const field of ["hosts", "fallbacks", "summaries", "confirmed", "failed"]) bucket[field] = { ...(bucket[field] || {}) };
  const key = entry.host || "(无域名)";
  if (phase === "started") {
    bucket.hosts[key] = (bucket.hosts[key] || 0) + 1;
    if (entry.fallback) bucket.fallbacks[key] = (bucket.fallbacks[key] || 0) + 1;
    if (entry.kind === "summary") bucket.summaries[key] = (bucket.summaries[key] || 0) + 1;
  } else if (phase === "completed") {
    bucket.confirmed[key] = (bucket.confirmed[key] || 0) + 1;
  } else if (phase === "failed") {
    bucket.failed[key] = (bucket.failed[key] || 0) + 1;
  }
  data[day] = bucket;
  const days = Object.keys(data).sort();
  for (const stale of days.slice(0, Math.max(0, days.length - 60))) delete data[stale];
  await fsPromises.writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// started 表示请求确实发出（可能已经计费）；只有 completed 才能证明模型切换成功。
export async function noteRoute(root, route, { model = "", fallback = false, kind = "request", sessionId = "" } = {}) {
  let host = "";
  try { host = new URL(route.endpoint).hostname; } catch { host = route.endpoint || ""; }
  const entry = {
    requestId: randomUUID(),
    at: new Date().toISOString(),
    route: route.id,
    name: route.name,
    host,
    model,
    requestedModel: model,
    observedModel: "",
    protocol: route.protocol || "",
    fallback,
    kind,
    sessionId: String(sessionId ?? "").trim(),
    status: "started",
    confirmed: false,
  };
  await serializeRouteAudit(async () => {
    const file = path.join(root, "route-log.json");
    let list = [];
    try { list = JSON.parse(await fsPromises.readFile(file, "utf8")); } catch { }
    if (!Array.isArray(list)) list = [];
    list.push(entry);
    await fsPromises.writeFile(file, JSON.stringify(list.slice(-100), null, 2), { mode: 0o600 });
    try { await updateAuditUsage(root, entry, "started"); } catch { }
  });
  return entry;
}

async function settleRoute(root, requestId, status, { observedModel = "", protocol = "", error = "" } = {}) {
  return serializeRouteAudit(async () => {
    const file = path.join(root, "route-log.json");
    let list = [];
    try { list = JSON.parse(await fsPromises.readFile(file, "utf8")); } catch { }
    if (!Array.isArray(list)) list = [];
    const index = list.findIndex((entry) => entry.requestId === requestId);
    if (index < 0) return null;
    if (list[index].status !== "started") return list[index].status === status ? list[index] : null;
    const entry = {
      ...list[index],
      completedAt: new Date().toISOString(),
      status,
      confirmed: status === "completed",
      observedModel: String(observedModel || "").trim(),
      protocol: String(protocol || list[index].protocol || "").trim(),
      error: status === "failed" ? redactDetail(error) : "",
    };
    list[index] = entry;
    await fsPromises.writeFile(file, JSON.stringify(list.slice(-100), null, 2), { mode: 0o600 });
    try { await updateAuditUsage(root, entry, status); } catch { }
    return entry;
  });
}

export async function confirmRoute(root, requestId, details = {}) {
  const entry = await settleRoute(root, requestId, "completed", details);
  if (!entry) throw new Error("路由确认记录丢失，已拒绝把本次调用标记为成功");
  return entry;
}

export function failRoute(root, requestId, details = {}) {
  return settleRoute(root, requestId, "failed", details);
}

export async function noteFallback(root, from, to, reason, { sessionId = "" } = {}) {
  const entry = {
    at: new Date().toISOString(),
    from: from.id, fromName: from.name,
    to: to.id, toName: to.name,
    reason: String(reason ?? "").replace(/\s+/g, " ").slice(0, 200),
    sessionId: String(sessionId ?? "").trim(),
  };
  process.stdout.write(`[fallback] 「${entry.fromName}」失败 → 已改用「${entry.toName}」（会按它自己的计费扣）：${entry.reason}\n`);
  try {
    const file = path.join(root, "fallback-events.json");
    let list = [];
    try { list = JSON.parse(await fsPromises.readFile(file, "utf8")); } catch { }
    if (!Array.isArray(list)) list = [];
    list.push(entry);
    await fsPromises.writeFile(file, JSON.stringify(list.slice(-50), null, 2), { mode: 0o600 });
  } catch { }
  return entry;
}

export async function upstream(route, key, suffix, body, timeout = 3600000, signal, sessionId = "") {
  if (!route.noKey && !key) throw new Error("请先配置 API Key");
  const headers = { "content-type": "application/json" };
  if (route.protocol === "anthropic") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else if (key) headers.authorization = `Bearer ${key}`;
  if (isOpencodeEndpoint(route.endpoint)) headers["x-opencode-session"] = opencodeSessionFor(route, sessionId);
  const response = await fetch(`${route.endpoint}/${suffix}`, {
    method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)].filter(Boolean)) : AbortSignal.timeout(timeout), redirect: "error",
  });
  if (!response.ok) {
    throw upstreamFailure(response.status, await failureDetail(response));
  }
  return response;
}

export function upstreamFailure(status, detail) {
  const messages = { 401: "API Key 无效或已过期", 403: "该密钥无访问权限", 404: "接口或模型不存在，请核对地址和模型 ID", 429: "额度不足或请求过于频繁" };
  const error = new Error(messages[status] || `供应商服务异常（HTTP ${status}）`);
  error.status = status;
  error.detail = detail;
  return error;
}

// 官方模型：用 Codex 自己的 ChatGPT 登录，直接转发到官方后端，账号、额度、模型都由官方管理。
export async function officialUpstream(route, payload, signal, timeout = 3600000) {
  const tokens = await officialTokens();
  const response = await fetch(`${chatgptBaseURL}/responses`, {
    method: "POST",
    headers: officialHeaders(tokens, payload.session_id || randomUUID()),
    body: JSON.stringify(officialPayload(payload, route.model)),
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    redirect: "error",
  });
  if (!response.ok) {
    const error = upstreamFailure(response.status, await failureDetail(response));
    if (response.status === 401) error.message = "官方登录已失效，请打开官方客户端刷新登录；第三方模型仍可使用";
    if (response.status === 403) error.message = "当前官方账号无权使用这个模型";
    if (response.status === 429) error.message = "官方订阅额度不足或请求过于频繁，可在本会话切换第三方模型";
    throw error;
  }
  return response;
}

function modelFromWire(text) {
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim().replace(/^data:\s*/, "");
    if (!line || line === "[DONE]") continue;
    try {
      const value = JSON.parse(line);
      const model = value?.response?.model ?? value?.model;
      if (typeof model === "string" && model.trim()) return model.trim();
    } catch { }
  }
  return "";
}

function wireModelCapture(limit = 512 * 1024) {
  const chunks = [];
  let length = 0;
  const add = (chunk) => {
    if (length >= limit) return;
    const value = Buffer.from(chunk);
    const remaining = limit - length;
    chunks.push(value.subarray(0, remaining));
    length += Math.min(value.length, remaining);
  };
  return {
    add,
    model: () => modelFromWire(Buffer.concat(chunks).toString("utf8")),
  };
}

function waitForResponseDrain(response) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", drained);
      response.off("close", closed);
      response.off("error", failed);
    };
    const drained = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(new Error("客户端已断开")); };
    const failed = (error) => { cleanup(); reject(error); };
    response.once("drain", drained);
    response.once("close", closed);
    response.once("error", failed);
  });
}

async function forwardCapturedBody(body, response, capture) {
  for await (const chunk of Readable.fromWeb(body)) {
    if (response.destroyed || response.writableEnded) throw new Error("客户端已断开");
    capture.add(chunk);
    if (!response.write(chunk)) await waitForResponseDrain(response);
  }
}

function sendJSON(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

export function protocolChain(configured) {
  // 官方模型只有一条路；失败时按条目配置的备用模型继续，而不是换协议。
  if (configured === "chatgpt") return ["chatgpt"];
  return [configured, ...["responses", "chat", "anthropic"].filter((protocol) => protocol !== configured)];
}

// 主模型失败时按配置改用备用条目；备用条目也可以再带一层备用。
export async function failoverRoutes(store, route) {
  const data = await store.read();
  const chain = [];
  const seen = new Set([route.id]);
  let current = route;
  for (let depth = 0; depth < 3 && current?.fallback; depth++) {
    const next = data.routes.find((entry) => entry.id === current.fallback);
    if (!next || seen.has(next.id) || next.archived || next.protocol === "oauth" || !next.model) break;
    seen.add(next.id);
    chain.push(next);
    current = next;
  }
  return chain;
}

export function errorMessage(error) {
  if (["TimeoutError", "AbortError"].includes(error.name)) return "模型调用超时或已取消";
  return error.detail ? `${error.message}（供应商说明：${error.detail}）` : error.message;
}

// Codex 收到 response.failed 才会停止重试并显示原因；只发裸 error 事件会被当成断流重试。
export function failureEvents(error, message) {
  const code = failureCode(error.status ?? 0, error.detail || message);
  const failed = {
    id: `resp_${randomUUID()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "failed",
    error: code ? { code, message } : { message },
  };
  return [
    { type: "response.created", response: { ...failed, status: "in_progress" } },
    { type: "response.failed", response: failed },
  ].map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join("");
}

// 把供应商报错里的真实上限写回条目。只改这一个数字，不动用户其他配置。
async function rememberContextWindow(store, route, detail) {
  const found = contextWindowFromMessage(detail);
  if (!found) return 0;
  try {
    const data = await store.read();
    const current = data.routes.find((entry) => entry.id === route.id);
    if (!current || Number(current.contextWindow) === found) return 0;
    await store.save({ ...current, contextWindow: found }, data.revision);
    return found;
  } catch { return 0; }
}

async function rememberProtocol(store, route, protocol) {
  try {
    const data = await store.read();
    const current = data.routes.find((entry) => entry.id === route.id);
    if (!current || current.protocol === protocol) return;
    await store.save({ ...current, protocol }, data.revision);
  } catch { }
}

// 切换窗口接受切换令牌；被标记为"可切换"的条目窗口即使还在用旧环境变量启动，也能继续工作。
async function acceptedTokens(store, switched, routeID) {
  if (!switched) return [await store.token(routeID)];
  const data = await store.read();
  const tokens = [await store.token(routerID)];
  for (const route of data.routes.filter((entry) => entry.switchable)) tokens.push(await store.token(route.id));
  return tokens;
}

function localConcurrencyKey(route) {
  if (!route.noKey || route.protocol === "oauth") return "";
  try {
    const url = new URL(route.endpoint);
    const localHost = /^(localhost|127\.0\.0\.1|\[::1\]|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(url.hostname);
    return localHost ? url.origin : "";
  } catch { return ""; }
}

export function createGateway(store = new ModelStore(), options = {}) {
  const localQueue = new LocalQueue();
  let inflight = 0;
  const server = http.createServer(async (request, response) => {
    const abort = new AbortController();
    let release = () => {};
    let heartbeat;
    let sseStream = false;
    const idleMs = options.idleMs ?? streamIdleMs;
    let idleTimer;
    let idleAbort = null;
    // 每次尝试用独立的控制器：空闲超时只中断当前这次上游调用，不会连累备用模型的尝试。
    const armIdle = () => {
      clearTimeout(idleTimer);
      const target = idleAbort;
      if (!target) return;
      idleTimer = setTimeout(() => target.abort(new Error("供应商长时间没有返回数据，已断开")), idleMs);
    };
    const attemptSignal = () => {
      idleAbort = new AbortController();
      const current = idleAbort;
      armIdle();
      return AbortSignal.any([abort.signal, current.signal]);
    };
    const disarmIdle = () => clearTimeout(idleTimer);
    inflight += 1;
    response.on("close", () => { if (!response.writableEnded) abort.abort(); });
    try {
      if (request.method === "GET" && request.url === "/health") return sendJSON(response, 200, { ok: true, service: "codex-model-assistant", version: 2, build: gatewayBuild, inflight: inflight - 1 });
      if (request.headers.origin) return sendJSON(response, 403, { error: { message: "浏览器请求不允许访问模型网关" } });
      const match = request.url?.match(/^\/(?:routes\/([a-z][a-z0-9-]{0,63})\/|router\/)v1\/(responses|models)$/);
      if (!match) return sendJSON(response, 404, { error: { message: "接口不存在" } });
      const switched = !match[1];
      const endpoint = match[2];
      const supplied = String(request.headers.authorization || "").replace(/^Bearer /, "");
      const tokens = await acceptedTokens(store, switched, match[1]);
      if (!tokens.some((token) => supplied.length === token.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(token)))) return sendJSON(response, 401, { error: { message: "实例访问令牌无效" } });
      let route = switched ? null : await store.route(match[1]);
      if (route?.archived || route?.protocol === "oauth") return sendJSON(response, 403, { error: { message: "此模型不能通过网关调用" } });
      if (endpoint === "models" && request.method === "GET" && switched) {
        const table = buildRouterTable((await store.read()).routes);
        return sendJSON(response, 200, { object: "list", data: table.map(({ slug, route: entry }) => ({ id: slug, object: "model", owned_by: entry.vendor || "codex-model-assistant" })) });
      }
      if (endpoint === "models" && request.method === "GET") {
        const result = await upstream(route, await store.secret(route.credentialID), "models", null, 15000, abort.signal);
        return sendJSON(response, 200, await limitedJSON(result.body));
      }
      if (request.method !== "POST" || endpoint !== "responses") return sendJSON(response, 405, { error: { message: "请求方法不支持" } });
      // 先量一下请求体：后面既要用它做上下文预检，也要拿原始字节数去比 contextWindow。
      const payload = await limitedJSON(request, requestLimitBytes);
      payload.session_id ||= String(request.headers.session_id || request.headers["x-codex-thread-id"] || "").slice(0,200);
      const payloadBytes = Number(payload.__bytes) || 0;
      let payloadBytesNote = "";
      // 压缩只做一次：预检做过就不再重复，避免「压了又压」把会话掏空。
      let compactionAttempted = false;
      if (switched) {
        const table = buildRouterTable((await store.read()).routes);
        const entry = routerTableEntry(table, payload.model);
        if (!entry) return sendJSON(response, 400, { error: { code: "model_not_found", type: "invalid_request_error", message: "当前模型标识已失效或被归档，请在本对话的模型选择器中重新选择模型后继续；这不是额度不足。" } });
        route = entry.route;
        payload.model = route.model;
      } else if (!route.model || payload.model !== route.model) {
        return sendJSON(response, 400, { error: { message: "模型与实例不匹配，请在助手中创建对应实例" } });
      }
      const budgetPayload = payloadForRoute(payload, route);
      if (budgetPayload !== payload) {
        process.stdout.write(`[lite] ${route.id}: tools ${Array.isArray(payload.tools) ? payload.tools.length : 0}→${Array.isArray(budgetPayload.tools) ? budgetPayload.tools.length : 0}, request ${(payloadSize(payload) / 1024).toFixed(1)}→${(payloadSize(budgetPayload) / 1024).toFixed(1)} KB\n`);
      }
      // 会话比这个模型的窗口装得下时，静默压缩掉最早的部分再继续，绝不把请求挡回去。
      // 为什么必须由网关做：Codex 对目录里的自定义模型不会自己压缩——实测把
      // context_window=40000、auto_compact_token_limit=38000 喂给它（并打开 context_management /
      // token_budget 两个开关），它照样带着约 6 万 token 的历史一路往下发；供应商回
      // context_length_exceeded 时它也只把这一轮标记为失败，不会自己压缩重试。
      // 用户要的是「接着说」，所以压缩这件事得有人替它做，而且不能留下痕迹。
      const budget = contextBudget(route);
      let estimate = estimateTokens(budgetPayload, budgetPayload === payload ? payloadBytes : payloadSize(budgetPayload));
      if (budget > 0 && estimate > budget) {
        // 压缩要花时间（摘要模型可能跑十几秒）。先把响应头和一行注释写出去，
        // 让 Codex 知道连接还活着——否则它会以为卡死，弹「正在重新连接」，甚至直接超时断开。
        if (payload.stream && !response.headersSent) {
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
          sseStream = true;
          response.write(": compacting\n\n");
          heartbeat = setInterval(() => response.write(": waiting\n\n"), 5000);
        }
        // 一轮压缩通常够；不够就再压一轮（最多三轮），实在压不下去才交给供应商判。
        for (let pass = 0; pass < 3 && estimate > budget; pass += 1) {
          const compacted = await compactForWindow({ store, route, payload, limit: budget, signal: abort.signal, force: true });
          if (!compacted) break;
          payload.input = compacted.input;
          payloadBytesNote = compacted.note;
          compactionAttempted = true;
          const projected = payloadForRoute(payload, route);
          estimate = estimateTokens(projected, payloadSize(projected));
          process.stdout.write(`[compact] ${route.id}: ${compacted.note}\n`);
        }
        if (estimate > budget) {
          // 连一条可切的边界都找不到时，缩短较早的工具输出：调用与返回仍然成对，
          // 供应商不会因为「工具结果找不到调用」而 400，用户也不会看到对话被掐断。
          const trimmed = trimOldToolOutputs(payload, budget);
          if (trimmed) {
            payload.input = trimmed.input;
            payloadBytesNote = trimmed.note;
            compactionAttempted = true;
            process.stdout.write(`[compact] ${route.id}: ${trimmed.note}\n`);
          }
        }
      }

      const key = await store.secret(route.credentialID);
      const busyKey = localConcurrencyKey(route);
      if (payload.stream && route.protocol !== "responses" && !response.headersSent) {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        sseStream = true;
        response.write(": waiting\n\n");
        heartbeat = setInterval(() => response.write(": waiting\n\n"), 5000);
      }
      release = await localQueue.acquire(busyKey, AbortSignal.any([abort.signal, AbortSignal.timeout(600000)]));
      if ((await store.route(route.id)).archived) throw new Error("此模型已停用");
      // 供应商只实现了一种接口时，按 404/405 自动换成能用的那种并记下来，用户不必先猜对接口格式。
      const candidates = [{ route, key }, ...(await failoverRoutes(store, route)).map((entry) => ({ route: entry, key: null }))];
      let served = false;
      let lastError = null;
      let eventsSent = false;
      let candidateIndex = 0;
      for (const candidate of candidates) {
        const target = candidate.route;
        const targetKey = candidate.key ?? (await store.secret(target.credentialID));
        // started 先证明请求确实发出；完成后再原位改为 completed，不能把“尝试过”冒充“切换成功”。
        if (candidateIndex > 0) await noteFallback(store.root, route, target, errorMessage(lastError ?? new Error("首选条目不可用")), { sessionId: payload.session_id });
        const routeAudit = await noteRoute(store.root, target, { model: target.model, fallback: candidateIndex > 0, sessionId: payload.session_id });
        // 从真正发起请求就开始计时：供应商连响应头都不给的情况同样会断开并转备用。
        const callSignal = attemptSignal();
        const attempts = protocolChain(target.protocol);
        for (let index = 0; index < attempts.length; index += 1) {
          const attempt = attempts[index];
          const targetPayload = payloadForRoute(payload, target);
          try {
            let observedModel = "";
            if (attempt === "chatgpt") {
              const result = await (options.officialUpstream || officialUpstream)({ ...target, protocol: attempt }, { ...targetPayload, model: target.model }, callSignal);
              if (payload.stream && !response.headersSent) response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
              armIdle();
              if (!payload.stream) {
                const body = await officialResponseJSON(result);
                observedModel = body?.model || "";
                await confirmRoute(store.root, routeAudit.requestId, { observedModel, protocol: attempt });
                if (!response.headersSent) sendJSON(response, 200, body);
                else response.end(JSON.stringify(body));
              } else {
                sseStream = true;
                eventsSent = true;
                const capture = wireModelCapture();
                await forwardCapturedBody(result.body, response, capture);
                observedModel = capture.model();
                await confirmRoute(store.root, routeAudit.requestId, { observedModel, protocol: attempt });
                response.end();
              }
              disarmIdle();
            } else if (attempt === "responses") {
              const result = await upstream({ ...target, protocol: attempt }, targetKey, "responses", nativePayload({ ...targetPayload, model: target.model }, target.model), 3600000, callSignal, payload.session_id);
              if (attempt !== target.protocol) await rememberProtocol(store, target, attempt);
              // 这里必须直接转发，不能因为「已经发过响应头」就把整段缓冲下来：
              // 提前发出去的只是「正在压缩」的注释，正文仍然要一个 token 一个 token 地流。
              if (!response.headersSent) response.writeHead(200, { "content-type": result.headers.get("content-type") || "application/json", "cache-control": "no-store" });
              if ((result.headers.get("content-type") || "").includes("text/event-stream")) sseStream = true;
              armIdle();
              eventsSent = true;
              const capture = wireModelCapture();
              await forwardCapturedBody(result.body, response, capture);
              observedModel = capture.model();
              await confirmRoute(store.root, routeAudit.requestId, { observedModel, protocol: attempt });
              response.end();
              disarmIdle();
            } else {
              if (payload.stream && !response.headersSent) {
                response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
                sseStream = true;
                response.write(": waiting\n\n");
                heartbeat = setInterval(() => response.write(": waiting\n\n"), 5000);
              }
              const { body, definitions } = toChat({ ...targetPayload, model: target.model }, { stream: Boolean(payload.stream) });
              const path = attempt === "anthropic" ? "messages" : "chat/completions";
              const result = await upstream({ ...target, protocol: attempt }, targetKey, path, attempt === "anthropic" ? toAnthropic(body, { stream: Boolean(payload.stream) }) : body, 3600000, callSignal, payload.session_id);
              if (attempt !== target.protocol) await rememberProtocol(store, target, attempt);
              armIdle();
              if (!payload.stream) {
                const completion = await limitedJSON(result.body);
                observedModel = completion?.model || "";
                await confirmRoute(store.root, routeAudit.requestId, { observedModel, protocol: attempt });
                sendJSON(response, 200, fromCompletion(completion, definitions, attempt, target.model));
              }
              else if (!(result.headers.get("content-type") || "").includes("text/event-stream")) {
                const completion = await limitedJSON(result.body);
                observedModel = completion?.model || "";
                await confirmRoute(store.root, routeAudit.requestId, { observedModel, protocol: attempt });
                response.end(responseEvents(fromCompletion(completion, definitions, attempt, target.model)));
              } else {
                const stream = createResponseStream({ model: target.model, send: (chunk) => response.write(chunk) });
                stream.created();
                eventsSent = true;
                const parse = (attempt === "anthropic" ? anthropicStreamParser : chatStreamParser)((event) => {
                  if (event.type === "text") stream.textDelta(event.text);
                  else if (event.type === "reasoning") stream.reasoningDelta(event.text);
                  else if (event.type === "tool") stream.toolDelta(event.index, event);
                  else if (event.type === "usage") stream.setUsage(event.usage);
                });
                const decoder = new TextDecoder();
                const capture = wireModelCapture();
                armIdle();
                for await (const chunk of Readable.fromWeb(result.body)) {
                  armIdle();
                  capture.add(chunk);
                  parse(decoder.decode(chunk, { stream: true }));
                }
                observedModel = capture.model();
                disarmIdle();
                stream.finish({ definitions });
                await confirmRoute(store.root, routeAudit.requestId, { observedModel, protocol: attempt });
                response.end();
              }
            }
            await confirmRoute(store.root, routeAudit.requestId, { observedModel, protocol: attempt });
            served = true;
            break;
          } catch (error) {
            lastError = error;
            if (abort.signal.aborted) {
              await failRoute(store.root, routeAudit.requestId, { protocol: attempt, error: errorMessage(error) });
              throw error;
            }
            // 已经发出正文增量就不能再换供应商，否则客户端会收到两段拼接内容。
            if (eventsSent) {
              await failRoute(store.root, routeAudit.requestId, { protocol: attempt, error: errorMessage(error) });
              throw error;
            }
            const wrongEndpoint = [404, 405].includes(error.status);
            if (wrongEndpoint && index < attempts.length - 1) {
              clearInterval(heartbeat);
              heartbeat = undefined;
              continue;
            }
            // 预检没算准、供应商仍然报「上下文超了」时，在这里补一次压缩并重试同一个供应商。
            // Codex 自己不会做这件事（实测：它只会把这一轮标记失败），而用户想看到的是一句正常回答。
            // 只补一次：压完还超就说明这个窗口真的装不下，那时再如实报错。
            if (isContextOverflow(error)) {
              // 供应商的报错里往往写着它真正能装多少。与其慢慢猜，不如直接记下来。
              const learned = await rememberContextWindow(store, target, error.detail);
              if (learned) process.stdout.write(`[window] ${target.id}: 供应商说上限是 ${learned}，已记下\n`);
            }
            if (!compactionAttempted && isContextOverflow(error)) {
              compactionAttempted = true;
              const retried = await compactForWindow({ store, route, payload, limit: budget, signal: abort.signal });
              if (retried) {
                payload.input = retried.input;
                payloadBytesNote = retried.note;
                process.stdout.write(`[compact] ${route.id}: 供应商报超限，压缩后重试 —— ${retried.note}\n`);
                clearInterval(heartbeat);
                heartbeat = undefined;
                index -= 1;
                continue;
              }
              process.stdout.write(`[compact] ${route.id}: 供应商报超限，但历史没有可用的切点，如实报错\n`);
            }
            break;
          }
        }
        if (served) {
          break;
        }
        await failRoute(store.root, routeAudit.requestId, { error: errorMessage(lastError ?? new Error("上游没有成功响应")) });
        candidateIndex += 1;
      }
      if (!served) throw lastError || new Error("模型调用失败");
    } catch (error) {
      if (response.headersSent) {
        if (!response.destroyed) {
          const message = errorMessage(error);
          response.end(sseStream ? failureEvents(error, message) : `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "model_gateway_error", message } })}\n\n`);
        }
        return;
      }
      const code = failureCode(error.status ?? 0, error.detail || "");
      sendJSON(response, error.status || 502, { error: { code: code || undefined, message: errorMessage(error), type: "model_gateway_error" } });
    } finally {
      clearInterval(heartbeat);
      disarmIdle();
      release();
      inflight -= 1;
    }
  });
  // 出厂就挂一个 error 监听。以前这个监听只在主程序块里挂，于是：
  // 任何别处创建的 server 只要端口被占用，Node 就会以「Unhandled 'error' event」直接崩，
  // 日志里留下一堆吓人的栈（历史日志里那 117 次就是这么来的）。
  // 现在结构上保证不会存在没有监听的 server。
  server.on("error", (error) => {
    // 主程序块会自己处理（它会探测 /health 并优雅退出），这里只在没人管的时候兜底。
    if (server.listenerCount("error") > 1) return;
    process.stderr.write(`模型网关出错：${error?.code || error?.name || "未知"} — ${error?.message || error}\n`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createGateway();
  // Node 默认把请求体收在 16 KB 以内（maxRequestsPerSocket 之外还有 body 上限），
  // 不放开的话 256 MB 的上限根本走不到，请求会被 Node 自己先掐断。
  server.maxRequestsPerSocket = 0;
  server.requestTimeout = 3650000;
  server.headersTimeout = 15000;
  server.on("error", (error) => {
    void (async () => {
      if (error?.code === "EADDRINUSE") {
        try {
          const response = await fetch(`${gatewayURL}/health`, { signal: AbortSignal.timeout(1500), redirect: "error" });
          const data = await response.json();
          if (response.ok && data?.service === "codex-model-assistant" && data?.version === 2) {
            process.stdout.write("Model gateway already running on loopback\n");
            process.exit(0);
            return;
          }
        } catch { }
      }
      // 不打印原始堆栈：那会被当成「程序崩了」，而实际上只是端口被占。
      process.stderr.write(`端口 ${gatewayPort} 被占用，但健康检查没能确认是本机网关（${error?.code || error?.message}）。请检查是否有残留的网关进程。\n`);
      process.exit(1);
    })();
  });
  server.listen(gatewayPort, "127.0.0.1", () => process.stdout.write("Model gateway ready on loopback\n"));
}
