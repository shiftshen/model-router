import fs from "node:fs/promises";
import path from "node:path";
import { buildRouterTable } from "./router.mjs";

export const CHECK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const VALIDATION_MAX_AGE_MS = 72 * 60 * 60 * 1000;
export const TASK_CATEGORIES = Object.freeze(["planning", "frontend", "backend", "debugging", "tool_use", "long_context"]);

function recent(iso, maxAge, now) {
  const time = Date.parse(iso);
  return Number.isFinite(time) && time <= now && now - time <= maxAge;
}

async function record(root, directory, id) {
  try { return JSON.parse(await fs.readFile(path.join(root, directory, `${id}.json`), "utf8")); }
  catch { return null; }
}

function endpointPrivacy(route) {
  try {
    const host = new URL(route.endpoint).hostname;
    // A loopback endpoint with a supplier key can be a cloud proxy. Only a
    // keyless loopback service is eligible for local_required in this version.
    return route.noKey && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(host) ? "local" : "remote";
  } catch { return "unknown"; }
}

async function localAvailable(route, key, fetcher) {
  try {
    const response = await fetcher(`${route.endpoint}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return Array.isArray(body?.data) && body.data.some((item) => item?.id === route.model);
  } catch { return false; }
}

function quotaAvailable(routeLog, routeId, since) {
  const entries = routeLog.filter((item) => item?.route === routeId && Date.parse(item.at) >= since);
  const lastQuotaFailure = entries.filter((item) => item.status === "failed"
    && /insufficient_quota|quota.{0,25}(?:exhausted|depleted|insufficient)|额度.{0,8}(?:不足|耗尽|用尽)/i.test(String(item.error ?? "")))
    .at(-1);
  if (!lastQuotaFailure) return true;
  return entries.some((item) => item.status === "completed"
    && Date.parse(item.completedAt ?? item.at) > Date.parse(lastQuotaFailure.completedAt ?? lastQuotaFailure.at));
}

/**
 * A capability report is evidence for its tested category only. Recent
 * successful calls indicate current request availability, never a balance.
 */
export async function qualifiedTaskCandidates(store, profile, { now = Date.now(), fetcher = fetch } = {}) {
  if (!TASK_CATEGORIES.includes(profile.category)) throw new TypeError("unsupported task category");
  const routes = (await store.read()).routes;
  const table = buildRouterTable(routes);
  let routeLog = [];
  try { routeLog = JSON.parse(await fs.readFile(path.join(store.root, "route-log.json"), "utf8")); }
  catch { }
  if (!Array.isArray(routeLog)) routeLog = [];
  const eligible = [];
  const rejected = [];
  for (const { slug, route } of table) {
    const reasons = [];
    if (route.archived || ["oauth", "chatgpt"].includes(route.protocol) || !route.model) continue;
    // Historical GPT-5.6 reports remain on disk, but this product policy
    // never promotes those routes into new automatic assignments.
    if (/^gpt-5\.6(?:[.-]|$)/i.test(route.model)) reasons.push("excluded_gpt_5_6");
    const privacy = endpointPrivacy(route);
    if (privacy === "unknown" || (profile.privacy === "local_required" && privacy !== "local")) reasons.push("privacy");
    // Six short probes do not establish the advertised full context window.
    // Cap this task executor to 8K until a real long-input probe exists.
    if (!Number.isSafeInteger(route.contextWindow) || Math.min(route.contextWindow, 8192) < profile.contextRequirement + profile.outputRequirement) reasons.push("context_unproven");
    const [check, validation, key, credentialVersion] = await Promise.all([
      record(store.root, "checks", route.id),
      record(store.root, "validation", route.id),
      route.noKey ? Promise.resolve(null) : store.secret(route.credentialID),
      store.credentialVersion(route.credentialID),
    ]);
    if (!route.noKey && !key) reasons.push("credential_missing");
    if (!check?.ok || !recent(check.testedAt, CHECK_MAX_AGE_MS, now)
      || check.model !== route.model || check.endpoint !== route.endpoint
      || check.protocol !== route.protocol || check.credentialVersion !== credentialVersion) reasons.push("check_stale_or_mismatch");
    if (validation?.mode !== "live" || !recent(validation.testedAt, VALIDATION_MAX_AGE_MS, now)
      || validation.routeId !== route.id || validation.model !== route.model
      || validation.endpoint !== route.endpoint || validation.protocol !== route.protocol
      || validation.credentialVersion !== credentialVersion) reasons.push("validation_stale_or_mismatch");
    const categoryScore = Number(validation?.byCategory?.[profile.category]);
    if (!Number.isFinite(categoryScore) || categoryScore < 80) reasons.push("category_unqualified");
    if ((Number(validation?.score) || 0) < (profile.complexity === "complex" ? 80 : 60)) reasons.push("overall_score_insufficient");
    // The bundled long_context test asks about a large context; it does not
    // actually send one. Do not turn that answer into a context capability.
    if (profile.category === "long_context") reasons.push("long_context_unproven");
    if (route.model === "qwen3-vl:latest" && profile.complexity !== "simple") reasons.push("local_simple_only");
    if (route.model === "qwen3-vl:latest" && profile.outputRequirement < 700) reasons.push("local_output_budget_unproven");
    if (!quotaAvailable(routeLog, route.id, Math.max(Date.parse(check?.testedAt) || 0, Date.parse(validation?.testedAt) || 0))) reasons.push("quota_exhausted");
    if (privacy === "local" && !(await localAvailable(route, key, fetcher))) reasons.push("local_service_unavailable");
    if (reasons.length) {
      rejected.push({ routeId: route.id, slug, reasons });
      continue;
    }
    const candidate = {
      id: slug, modelId: route.model, provider: route.id,
      capabilities: [profile.category], modalities: ["text"], languages: ["zh", "en"],
      contextWindow: route.contextWindow, maxOutput: 700,
      costTier: privacy === "local" ? 1 : 3, latencyTier: 3,
      privacy, status: "qualified", credentialStatus: "active",
    };
    eligible.push({
      route, candidate,
      evidence: {
        checkAt: check.testedAt, validationAt: validation.testedAt,
        categoryScore, overallScore: Number(validation.score) || 0,
        credentialVersion, quota: "recent_success_no_balance_guarantee",
      },
    });
  }
  return { eligible, rejected };
}
