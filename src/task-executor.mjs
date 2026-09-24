import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ModelStore, atomicJSON } from "./model-store.mjs";
import { qualifiedTaskCandidates, TASK_CATEGORIES } from "./task-qualification.mjs";
import { recommendWithEngineCLI } from "./automatic-routing.mjs";

const DEFAULT_GATEWAY = "http://127.0.0.1:18793/router/v1/responses";

export class TaskExecutionError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function taskProfile(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) throw new TaskExecutionError("invalid_task");
  if (typeof task.text !== "string" || !task.text.trim() || Buffer.byteLength(task.text) > 40_000) throw new TaskExecutionError("invalid_task_text");
  const complexity = task.complexity;
  const category = task.category;
  if (!["simple", "complex"].includes(complexity) || !TASK_CATEGORIES.includes(category)) throw new TaskExecutionError("invalid_profile");
  const privacy = task.privacy ?? "normal";
  if (!["normal", "local_preferred", "local_required"].includes(privacy)) throw new TaskExecutionError("invalid_privacy");
  const minimumContext = Math.ceil(Buffer.byteLength(task.text) / 3) + 256;
  const contextRequirement = task.contextRequirement ?? minimumContext;
  const outputRequirement = task.outputRequirement ?? (complexity === "simple" ? 256 : 700);
  if (!Number.isSafeInteger(contextRequirement) || contextRequirement < minimumContext
    || !Number.isSafeInteger(outputRequirement) || outputRequirement < 1 || outputRequirement > 700) {
    throw new TaskExecutionError("invalid_context_or_output");
  }
  return {
    category, complexity, privacy, contextRequirement, outputRequirement,
    engine: {
      taskType: "code_analysis", difficulty: complexity === "simple" ? "simple" : "hard",
      requiredCapabilities: [category], modalities: ["text"], languages: ["zh", "en"],
      contextRequirement, outputRequirement, privacy,
      allowExperimental: false, allowDegradedFallback: false,
    },
  };
}

function acceptancePolicy(task) {
  if (task.acceptancePhrase !== undefined) {
    if (typeof task.acceptancePhrase !== "string" || !task.acceptancePhrase.trim() || task.acceptancePhrase.length > 500) throw new TaskExecutionError("invalid_acceptance");
    return { type: "contains_all", values: [task.acceptancePhrase.trim()] };
  }
  const policy = task.acceptance;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new TaskExecutionError("acceptance_required");
  if (policy.type === "exact_text" && typeof policy.expected === "string" && policy.expected.trim() && policy.expected.length <= 1000) return policy;
  if (policy.type === "contains_all" && Array.isArray(policy.values) && policy.values.length > 0 && policy.values.length <= 8
    && policy.values.every((item) => typeof item === "string" && item.trim() && item.length <= 500)) return policy;
  if (policy.type === "json_subset" && policy.expected && typeof policy.expected === "object"
    && !Array.isArray(policy.expected) && JSON.stringify(policy.expected).length <= 2000) return policy;
  throw new TaskExecutionError("invalid_acceptance");
}

function subset(expected, actual) {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    return actual && typeof actual === "object" && !Array.isArray(actual)
      && Object.entries(expected).every(([key, value]) => subset(value, actual[key]));
  }
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length
    && expected.every((item, index) => subset(item, actual[index]));
  return Object.is(expected, actual);
}

export function evaluateTaskOutput(body, output, policy) {
  if (body?.status && body.status !== "completed") return { passed: false, reason: "response_incomplete" };
  if (!output.trim()) return { passed: false, reason: "empty_final_answer" };
  if (policy.type === "exact_text") return { passed: output.trim() === policy.expected.trim(), reason: output.trim() === policy.expected.trim() ? "exact_match" : "exact_mismatch" };
  if (policy.type === "contains_all") {
    const passed = policy.values.every((value) => output.includes(value));
    return { passed, reason: passed ? "required_phrases_present" : "required_phrase_missing" };
  }
  try {
    const parsed = JSON.parse(output.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\s*\x60\x60\x60$/, ""));
    const passed = subset(policy.expected, parsed);
    return { passed, reason: passed ? "json_subset_match" : "json_subset_mismatch" };
  } catch { return { passed: false, reason: "invalid_json" }; }
}

function outputText(body) {
  return Array.isArray(body?.output) ? body.output
    .filter((item) => item?.type === "message")
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .filter((part) => part?.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text).join("") : "";
}

function selectedFromDecision(decision, candidates) {
  const roles = Array.isArray(decision?.roles) ? decision.roles.map((role) => role?.decision?.selected) : [];
  const selected = decision?.selected ?? (roles.length && roles.every((item) => item?.id === roles[0]?.id
    && item?.modelId === roles[0]?.modelId && item?.provider === roles[0]?.provider) ? roles[0] : null);
  if (decision?.mode !== "advisory" || decision?.status !== "resolved" || !selected
    || roles.some((item) => item?.id !== selected.id || item?.modelId !== selected.modelId || item?.provider !== selected.provider)) return null;
  return candidates.find((item) => item.candidate.id === selected.id
    && item.candidate.modelId === selected.modelId && item.candidate.provider === selected.provider) ?? null;
}

function sortedCandidates(candidates) {
  return [...candidates].sort((a, b) => b.evidence.categoryScore - a.evidence.categoryScore
    || b.evidence.overallScore - a.evidence.overallScore
    || a.candidate.id.localeCompare(b.candidate.id));
}

async function routeAudit(root, sessionId, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  for (let index = 0; index < 5; index += 1) {
    let list = [];
    try { list = JSON.parse(await fs.readFile(path.join(root, "route-log.json"), "utf8")); } catch { }
    const matches = Array.isArray(list) ? list.filter((entry) => entry?.kind === "request" && entry.sessionId === sessionId) : [];
    if (matches.length && matches.every((entry) => entry.status !== "started")) return matches;
    await pause(100);
  }
  return [];
}

function safeSnapshot(entry) {
  return {
    id: entry.candidate.id, routeId: entry.route.id, modelId: entry.candidate.modelId,
    privacy: entry.candidate.privacy, contextWindow: entry.candidate.contextWindow,
    categoryScore: entry.evidence.categoryScore, overallScore: entry.evidence.overallScore,
    checkAt: entry.evidence.checkAt, validationAt: entry.evidence.validationAt,
    quotaEvidence: entry.evidence.quota,
  };
}

async function saveAudit(store, audit) {
  await atomicJSON(path.join(store.root, "task-runs", `${audit.taskId}.json`), audit);
}

/**
 * Execute text-only, objectively checkable tasks. The prompt only enters the
 * gateway request; Engine receives profile + the frozen qualified snapshot.
 * The returned output stays in memory and is never written to task audit.
 */
export async function runTask(task, {
  store = new ModelStore(), gatewayURL = DEFAULT_GATEWAY, recommend = recommendWithEngineCLI,
  send = fetch, now = Date.now, fetcher = fetch, readAudit = routeAudit,
} = {}) {
  const profile = taskProfile(task);
  const policy = acceptancePolicy(task);
  const taskId = randomUUID();
  const createdAt = new Date(now()).toISOString();
  const { eligible, rejected } = await qualifiedTaskCandidates(store, profile, { now: now(), fetcher });
  const ranked = sortedCandidates(eligible);
  const audit = {
    schema: "task-run-v1", taskId, createdAt,
    profile: { category: profile.category, complexity: profile.complexity, privacy: profile.privacy,
      contextRequirement: profile.contextRequirement, outputRequirement: profile.outputRequirement },
    acceptanceType: policy.type, candidates: ranked.map(safeSnapshot),
    rejectedRoutes: rejected, decisionSource: "", selectedRoute: "", attempts: [], status: "started",
  };
  await saveAudit(store, audit);
  const result = (status, output = "") => ({
    taskId, status, selectedRoute: audit.selectedRoute, actualRoute: audit.attempts.at(-1)?.actualRoute ?? "",
    decisionSource: audit.decisionSource, acceptance: audit.attempts.at(-1)?.acceptance ?? { passed: false, reason: status === "rejected" ? "no_qualified_model" : "not_accepted" },
    output, attempts: audit.attempts,
  });
  if (!ranked.length) {
    audit.status = "rejected";
    audit.failureCode = "no_qualified_model";
    await saveAudit(store, audit);
    return result("rejected");
  }
  let primary;
  if (profile.complexity === "simple") {
    primary = ranked[0];
    audit.decisionSource = "qualified_rule";
  } else {
    let decision;
    try { decision = await recommend(null, { profile: profile.engine, candidates: ranked.map((item) => item.candidate) }, store.root); }
    catch {
      audit.status = "rejected"; audit.failureCode = "engine_unavailable";
      await saveAudit(store, audit);
      return result("rejected");
    }
    primary = selectedFromDecision(decision, ranked);
    audit.decisionSource = ["laya_typed", "jev_fallback", "qualified_rule"].includes(decision?.provenance?.selectedBy)
      ? decision.provenance.selectedBy : "engine";
    if (!primary) {
      audit.status = "rejected"; audit.failureCode = "engine_selection_not_in_snapshot";
      await saveAudit(store, audit);
      return result("rejected");
    }
  }
  audit.selectedRoute = primary.route.id;
  const ordered = [primary, ...ranked.filter((item) => item.route.id !== primary.route.id)];
  const maxAttempts = Math.min(3, Math.max(1, Number.isSafeInteger(task.maxAttempts) ? task.maxAttempts : 2));
  const token = await store.token("router");
  let lastOutput = "";
  for (const [index, entry] of ordered.slice(0, maxAttempts).entries()) {
    const sessionId = `task-${taskId}-a${index + 1}`;
    const started = now();
    const attempt = {
      attempt: index + 1, routeId: entry.route.id, slug: entry.candidate.id,
      gatewayRequestId: "", actualRoute: "", responseModel: "", status: "started",
      acceptance: { passed: false, reason: "not_accepted" }, elapsedMs: 0,
      switchReason: index ? audit.attempts.at(-1)?.acceptance.reason ?? "prior_attempt_failed" : "",
    };
    audit.attempts.push(attempt);
    await saveAudit(store, audit);
    let response, body;
    try {
      response = await send(gatewayURL, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: entry.candidate.id, input: task.text,
          max_output_tokens: profile.outputRequirement, stream: false, session_id: sessionId }),
        signal: AbortSignal.timeout(120_000),
      });
      body = await response.json();
    } catch {
      attempt.status = "failed"; attempt.acceptance.reason = "gateway_transport";
    }
    const traces = await readAudit(store.root, sessionId);
    const trace = traces.at(-1);
    attempt.gatewayRequestId = String(trace?.requestId ?? "");
    attempt.actualRoute = String(trace?.route ?? "");
    const reportedModel = String(body?.model ?? trace?.observedModel ?? "");
    attempt.responseModel = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(reportedModel)
      ? reportedModel : "untrusted_model_identifier";
    if (response && body) {
      lastOutput = outputText(body);
      if (!response.ok) {
        attempt.status = "failed"; attempt.acceptance.reason = `gateway_http_${response.status}`;
      } else if (traces.length !== 1 || trace?.route !== entry.route.id || trace?.status !== "completed") {
        attempt.status = "failed"; attempt.acceptance.reason = "gateway_route_unconfirmed";
      } else if (trace.observedModel && body.model && trace.observedModel !== body.model) {
        attempt.status = "failed"; attempt.acceptance.reason = "response_model_mismatch";
      } else {
        attempt.acceptance = evaluateTaskOutput(body, lastOutput, policy);
        attempt.status = attempt.acceptance.passed ? "passed" : "failed";
      }
    }
    attempt.elapsedMs = Math.max(0, now() - started);
    await saveAudit(store, audit);
    if (attempt.status === "passed") {
      audit.status = "passed"; audit.completedAt = new Date(now()).toISOString();
      await saveAudit(store, audit);
      return result("passed", lastOutput);
    }
  }
  audit.status = "failed"; audit.failureCode = audit.attempts.at(-1)?.acceptance.reason ?? "not_accepted";
  audit.completedAt = new Date(now()).toISOString();
  await saveAudit(store, audit);
  return result("failed", lastOutput);
}
