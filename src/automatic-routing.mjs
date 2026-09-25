import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { autoRouterSlug, buildRouterTable } from "./router.mjs";
import { resolveContextWindow } from "./model-windows.mjs";
import { estimateTokens } from "./context-compaction.mjs";
import { CHECK_MAX_AGE_MS } from "./task-qualification.mjs";

export const automaticModelSlug = autoRouterSlug;
const categories = ["planning", "frontend", "backend", "debugging", "tool_use", "long_context"];
// Capability tests describe a model/configuration, while connection probes
// describe current availability. Keep the former longer, but refresh the
// latter on demand before an automatic turn when too few backups remain.
const AUTO_VALIDATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function automaticError(code, message) {
  const error = new Error(message);
  error.status = 409;
  error.code = code;
  return error;
}

function latestUserText(payload) {
  const input = payload?.input;
  if (typeof input === "string") return input.slice(-12000);
  if (!Array.isArray(input)) return "";
  const latest = [...input].reverse().find((entry) => entry?.role === "user");
  if (!latest) return "";
  if (typeof latest.content === "string") return latest.content.slice(-12000);
  return (Array.isArray(latest.content) ? latest.content : [])
    .filter((part) => part?.type === "input_text" && typeof part.text === "string")
    .map((part) => part.text).join(" ").slice(-12000);
}

// Only a small, fixed vocabulary leaves the gateway. User text and history stay local.
export function profileFromPayload(payload) {
  const text = latestUserText(payload);
  const simple = /^\s*(?:what\s+is\s+)?\d+\s*[+\-*/]\s*\d+\s*(?:[=?]|\s|$)/i.test(text)
    || /^\s*(?:你好|hi|hello|谢谢|thank you)[!！。,.\s]*$/i.test(text);
  const hasTools = Array.isArray(payload?.tools) && payload.tools.length > 0;
  const category = /debug|bug|报错|排查|修复|错误|fix the|investigate/i.test(text) ? "debugging"
    : /规划|架构|architecture|roadmap|design decisions|设计方案/i.test(text) ? "planning"
    : /front.?end|frontend|ui|css|界面|页面|按钮|组件|布局/i.test(text) ? "frontend"
    : /api|server|backend|后端|接口|数据库|网关/i.test(text) ? "backend"
    : /tool|工具|权限|安全|删除|执行命令/i.test(text) ? "tool_use"
    : "general";
  const inputBytes = Number(payload?.__bytes) || Buffer.byteLength(JSON.stringify(payload?.input ?? ""));
  const outputRequirement = Number.isSafeInteger(payload?.max_output_tokens) && payload.max_output_tokens > 0 ? payload.max_output_tokens : 0;
  // Codex sends large tool schemas with every request. Their serialized JSON
  // size is not the conversation history. Use the same content-aware estimate
  // as gateway compaction or ordinary turns become false "long context" tasks.
  const contextRequirement = Math.max(0, estimateTokens(payload, inputBytes) - outputRequirement);
  const requiredCategories = category === "general" ? [] : [category];
  if (hasTools && !requiredCategories.includes("tool_use")) requiredCategories.push("tool_use");
  if (contextRequirement > 32000 && !requiredCategories.includes("long_context")) requiredCategories.push("long_context");
  const hasImage = Array.isArray(payload?.input) && payload.input.some((entry) =>
    Array.isArray(entry?.content) && entry.content.some((part) => part?.type === "input_image"));
  return {
    category,
    requiredCategories,
    profile: {
      taskType: "code",
      difficulty: contextRequirement > 20000 || /架构|重构|复杂|发布|上线|refactor|release|architecture|design the system|plan the architecture/i.test(text) ? "hard" : (simple ? "simple" : "medium"),
      requiredCapabilities: ["coding", ...requiredCategories.filter((item) => item !== "long_context")],
      modalities: hasImage ? ["text", "image"] : ["text"],
      languages: ["zh", "en"],
      contextRequirement,
      outputRequirement,
      allowExperimental: false,
      allowDegradedFallback: false,
    },
  };
}

async function readEvidence(root, directory, id) {
  try { return JSON.parse(await fs.readFile(path.join(root, directory, `${id}.json`), "utf8")); }
  catch { return null; }
}

function persistentQuotaFailure(error) {
  // The gateway's generic 429 heading says "额度不足或请求过于频繁" for both
  // exhausted balances and temporary rate limits. Only the supplier detail
  // can justify excluding a route until a later successful call.
  const detail = String(error ?? "").replaceAll("额度不足或请求过于频繁", "");
  return /insufficient_quota|quota.{0,25}(?:exhausted|depleted|insufficient)|(?:credits?|balance).{0,25}(?:exhausted|depleted|insufficient)|(?:余额|额度).{0,8}(?:不足|耗尽|用尽)/i.test(detail);
}

function unavailableModelFailure(error) {
  const detail = String(error ?? "");
  return /No endpoints found for\b|not supported by any configured account in this group/i.test(detail);
}

function knownNoApiCharge(route) {
  const url = new URL(route.endpoint);
  const local = route.noKey && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return local || (url.hostname === "openrouter.ai" && (route.model.endsWith(":free") || route.model === "openrouter/free"));
}

async function approvedPaidRoutes(root) {
  let config;
  try { config = JSON.parse(await fs.readFile(path.join(root, "auto-routing-runtime.json"), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return new Set();
    throw automaticError("auto_cost_policy_invalid", "自动选模费用设置无效；已阻止付费调用");
  }
  const ids = config?.autoApprovedPaidRoutes ?? [];
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(id))) {
    throw automaticError("auto_cost_policy_invalid", "自动选模费用设置无效；已阻止付费调用");
  }
  return new Set(ids);
}

export async function qualifiedAutomaticCandidates(store, requiredCategories, profile = {}, { allowStaleCheck = false } = {}) {
  const routes = (await store.read()).routes;
  const table = buildRouterTable(routes);
  let routeLog = [];
  try { routeLog = JSON.parse(await fs.readFile(path.join(store.root, "route-log.json"), "utf8")); } catch { }
  if (!Array.isArray(routeLog)) routeLog = [];
  const qualified = [];
  for (const { slug, route } of table) {
    if (slug === automaticModelSlug || route.archived || ["oauth", "chatgpt"].includes(route.protocol) || !route.model
      || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(route.model)
      || /^gpt-5\.6(?:[.-]|$)/i.test(route.model)) continue;
    const [check, validation, secret, credentialVersion] = await Promise.all([
      readEvidence(store.root, "checks", route.id),
      readEvidence(store.root, "validation", route.id),
      store.secret(route.credentialID),
      store.credentialVersion(route.credentialID),
    ]);
    if (!check?.ok || !Number.isFinite(Date.parse(check.testedAt)) || (!allowStaleCheck && Date.now() - Date.parse(check.testedAt) > CHECK_MAX_AGE_MS)
      || check.endpoint !== route.endpoint || check.model !== route.model
      || check.protocol !== route.protocol || check.credentialVersion !== credentialVersion
      || (!route.noKey && !secret)) continue;
    if (validation?.mode !== "live" || !Number.isFinite(Date.parse(validation.testedAt))
      || Date.now() - Date.parse(validation.testedAt) > AUTO_VALIDATION_MAX_AGE_MS
      || validation.routeId !== route.id || validation.model !== route.model
      || validation.endpoint !== route.endpoint || validation.protocol !== route.protocol
      || validation.credentialVersion !== credentialVersion) continue;
    if ((Number(validation.score) || 0) < (profile.difficulty === "hard" ? 80 : 60)
      || !categories.some((category) => Number(validation.byCategory?.[category]) >= 80)
      || !requiredCategories.every((category) => categories.includes(category) && Number(validation.byCategory?.[category]) >= 80)) continue;
    // Short capability probes are not proof of an advertised 128K/1M context.
    // Large turns must fail closed until a real long-input validation exists.
    if (requiredCategories.includes("long_context") || (Number(profile.contextRequirement) || 0) > 32000) continue;
    if (route.model === "qwen3-vl:latest" && (profile.difficulty !== "simple" || requiredCategories.includes("tool_use"))) continue;
    const failures = routeLog.filter((item) => item.route === route.id && item.status === "failed"
      && persistentQuotaFailure(item.error));
    const lastFailure = failures.at(-1);
    if (lastFailure && !routeLog.some((item) => item.route === route.id && item.status === "completed"
      && Date.parse(item.completedAt ?? item.at) > Date.parse(lastFailure.completedAt ?? lastFailure.at))) continue;
    // A model page or an old successful probe is not proof that the supplier
    // still has a routable endpoint. Keep it out of auto until a later real
    // call succeeds; manually selected models remain under user control.
    const unavailable = routeLog.filter((item) => item.route === route.id && item.status === "failed"
      && unavailableModelFailure(item.error)).at(-1);
    if (unavailable && !routeLog.some((item) => item.route === route.id && item.status === "completed"
      && Date.parse(item.completedAt ?? item.at) > Date.parse(unavailable.completedAt ?? unavailable.at))) continue;
    // Temporary provider outages/rate limits cool down for two minutes. A later
    // successful call immediately restores the route; a bad prompt (HTTP 400)
    // is task-specific and must not blacklist the provider.
    const transient = routeLog.filter((item) => item.route === route.id && item.status === "failed"
      && /HTTP 5\d\d|额度不足或请求过于频繁|限流|rate.?limit|too many requests|ECONN|ENOTFOUND|服务暂不可用/i.test(String(item.error ?? ""))).at(-1);
    if (transient && Date.now() - Date.parse(transient.completedAt ?? transient.at) < 120_000
      && !routeLog.some((item) => item.route === route.id && item.status === "completed"
        && Date.parse(item.completedAt ?? item.at) > Date.parse(transient.completedAt ?? transient.at))) continue;
    if (requiredCategories.includes("tool_use")) {
      const incompatible = routeLog.filter((item) => item.route === route.id && item.status === "failed"
        && /custom tools require|additional_tools requires|unsupported tool|工具.{0,12}不支持/i.test(String(item.error ?? ""))).at(-1);
      if (incompatible && !routeLog.some((item) => item.route === route.id && item.status === "completed"
        && Date.parse(item.completedAt ?? item.at) > Date.parse(incompatible.completedAt ?? incompatible.at))) continue;
    }
    if (resolveContextWindow(route) < (Number(profile.contextRequirement) || 0) + (Number(profile.outputRequirement) || 0)) continue;
    const local = route.noKey && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(route.endpoint).hostname);
    // Six short probes do not prove that a small local model can own a complex
    // coding turn. Keep local execution as a qualified simple-task fallback.
    if (local && profile.difficulty !== "simple") continue;
    if (local) {
      try {
        const available = await fetch(`${route.endpoint}/models`, { signal: AbortSignal.timeout(3000) });
        if (!available.ok || !(await available.json())?.data?.some((item) => item?.id === route.model)) continue;
      } catch { continue; }
    }
    const capabilities = ["coding", ...categories.filter((category) => Number(validation.byCategory?.[category]) >= 80)];
    qualified.push({
      route,
      score: Number(validation.score) || 0,
      candidate: {
        id: slug, modelId: route.model, provider: route.id,
        capabilities, modalities: ["text"], languages: ["zh", "en"],
        contextWindow: resolveContextWindow(route), maxOutput: 4096,
        costTier: knownNoApiCharge(route) ? 1 : 3, latencyTier: 3,
        privacy: local ? "local" : "remote",
        status: "qualified", credentialStatus: "active",
      },
    });
  }
  return qualified;
}

const runtimeEngineCLI = fileURLToPath(new URL("../model-router-engine/bin/model-router-engine.mjs", import.meta.url));
const developmentEngineCLI = fileURLToPath(new URL("../vendor/model-router-engine/bin/model-router-engine.mjs", import.meta.url));
const appNodeEngineCLI = path.join(path.dirname(process.execPath), "model-router-engine", "bin", "model-router-engine.mjs");

async function engineCLI(enginePath) {
  if (enginePath) return enginePath;
  for (const candidate of [runtimeEngineCLI, appNodeEngineCLI, developmentEngineCLI]) {
    try { await fs.access(candidate); return candidate; } catch { }
  }
  throw automaticError("auto_engine_unavailable", "自动选模引擎未安装");
}

async function engineEnvironment(root) {
  let config;
  try { config = JSON.parse(await fs.readFile(path.join(root, "auto-routing-runtime.json"), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return process.env;
    throw automaticError("auto_engine_config_invalid", "自动选模本机配置无效");
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw automaticError("auto_engine_config_invalid", "自动选模本机配置无效");
  const env = { ...process.env };
  for (const [field, target] of [["layaPython", "LAYA_PYTHON"], ["layaModelPath", "LAYA_MODEL_PATH"]]) {
    if (config[field] === undefined) continue;
    if (typeof config[field] !== "string" || !path.isAbsolute(config[field]) || /[\r\n\0]/.test(config[field])) {
      throw automaticError("auto_engine_config_invalid", "自动选模本机配置无效");
    }
    env[target] = config[field];
  }
  return env;
}

export async function recommendWithEngineCLI(enginePath, input, root) {
  const cli = await engineCLI(enginePath);
  const env = await engineEnvironment(root);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "recommend"], { stdio: ["pipe", "pipe", "pipe"], env });
    let output = "";
    let finished = false;
    const done = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(result);
    };
    const timer = setTimeout(() => done(automaticError("auto_engine_timeout", "自动选模引擎超时")), 30_000);
    child.on("error", () => done(automaticError("auto_engine_unavailable", "自动选模引擎未安装")));
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.length > 1_048_576) done(automaticError("auto_engine_invalid", "自动选模引擎输出无效"));
    });
    child.on("close", (code) => {
      if (code !== 0) return done(automaticError("auto_engine_unavailable", "自动选模引擎无法使用"));
      try { done(null, JSON.parse(output)); }
      catch { done(automaticError("auto_engine_invalid", "自动选模引擎输出无效")); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

export async function resolveAutomaticRoute(store, payload, { recommendAutomatic, enginePath, refreshAutomaticCheck } = {}) {
  const { category, requiredCategories, profile } = profileFromPayload(payload);
  if (profile.modalities.includes("image")) throw automaticError("auto_no_qualified_model", "当前模型能力验证未覆盖图片任务");
  const approvedPaid = await approvedPaidRoutes(store.root);
  const withinBudget = (entry) => knownNoApiCharge(entry.route) || approvedPaid.has(entry.route.id);
  let availableQualified = await qualifiedAutomaticCandidates(store, requiredCategories, profile);
  let qualified = availableQualified.filter(withinBudget);
  if (qualified.length < 2 && refreshAutomaticCheck) {
    const stale = (await qualifiedAutomaticCandidates(store, requiredCategories, profile, { allowStaleCheck: true })).filter(withinBudget);
    const refresh = stale.filter((entry) => !qualified.some((current) => current.route.id === entry.route.id))
      .sort((left, right) => right.score - left.score).slice(0, 2);
    for (const entry of refresh) {
      try { await refreshAutomaticCheck(entry.route); } catch { /* fail closed and try the next known candidate */ }
    }
    if (refresh.length) {
      availableQualified = await qualifiedAutomaticCandidates(store, requiredCategories, profile);
      qualified = availableQualified.filter(withinBudget);
    }
  }
  if (!availableQualified.length) throw automaticError("auto_no_qualified_model", "没有通过当前任务所需能力验证的模型，请先在应用中运行连接和能力验证");
  if (!qualified.length) throw automaticError("auto_no_budget_model", "本轮没有通过验证且可用的免费模型；自动模式已阻止未明确批准的付费路线，未调用收费模型。可手动选择具体模型。");
  // Local models are the emergency/low-cost fallback, not the primary route
  // while an independently billed API route is qualified for this turn.
  const remote = qualified.filter(({ candidate }) => candidate.privacy !== "local");
  const primaryCandidates = remote.length ? remote : qualified;
  if (primaryCandidates.length === 1 && !recommendAutomatic) {
    const [only] = primaryCandidates;
    const fallbackRoutes = qualified.filter((entry) => entry !== only)
      .sort((left, right) => right.score - left.score)
      .slice(0, 2).map((entry) => entry.route);
    return { route: only.route, slug: only.candidate.id, category,
      provenance: { primary: "qualification", selectedBy: "single_qualified", fallbackReason: "" }, fallbackRoutes };
  }
  const recommend = recommendAutomatic ?? ((input) => recommendWithEngineCLI(enginePath || process.env.MODEL_ROUTER_ENGINE_PATH, input, store.root));
  let decision;
  try { decision = await recommend({ profile, candidates: primaryCandidates.map(({ candidate }) => candidate) }); }
  catch (error) {
    if (error?.code?.startsWith("auto_")) throw error;
    throw automaticError("auto_engine_unavailable", "自动选模引擎无法使用");
  }
  const roleSelections = Array.isArray(decision?.roles) ? decision.roles.map((role) => role?.decision?.selected) : [];
  if (decision?.status === "profile_unavailable") {
    throw automaticError("auto_decision_unavailable", `自动选模决策暂不可用（${String(decision.reason || "unknown").slice(0, 64)}）；本轮未调用执行模型`);
  }
  const selected = decision?.selected ?? (roleSelections.length > 0 && roleSelections.every((item) => item?.id === roleSelections[0]?.id
    && item?.modelId === roleSelections[0]?.modelId && item?.provider === roleSelections[0]?.provider)
    ? roleSelections[0] : null);
  if (decision?.mode !== "advisory" || decision.status !== "resolved" || !selected
    || roleSelections.some((item) => item?.id !== selected.id || item?.modelId !== selected.modelId || item?.provider !== selected.provider)) {
    throw automaticError("auto_no_single_model", "自动选模未给出单模型的合格结果");
  }
  const found = primaryCandidates.find(({ candidate }) => candidate.id === selected.id
    && candidate.modelId === selected.modelId && candidate.provider === selected.provider);
  if (!found) throw automaticError("auto_selection_mismatch", "自动选模结果与已验证模型不匹配");
  const fallbackRoutes = qualified.filter((entry) => entry !== found)
    .sort((left, right) => (left.candidate.privacy === "local") - (right.candidate.privacy === "local") || right.score - left.score)
    .slice(0, 2).map((entry) => entry.route);
  return { route: found.route, slug: found.candidate.id, category, provenance: decision.provenance ?? null, fallbackRoutes };
}
