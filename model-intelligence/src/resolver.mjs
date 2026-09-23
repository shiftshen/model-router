import { PRIVACY_LEVELS, TIER_VALUES } from "./constants.mjs";
import { createTaskProfile } from "./task-profile.mjs";

const AUTO_STATUSES = new Set(["preferred", "qualified"]);
const UNUSABLE_CREDENTIALS = new Set(["missing", "invalid", "exhausted"]);

const includesAll = (available, required) => required.every((item) => available.includes(item));

function effectiveStatus(model, taskType) {
  if (["blocked", "manual_only"].includes(model.status)) return model.status;
  return model.taskStatuses[taskType] ?? model.status;
}

function hardRejectionReasons(model, credential, task) {
  const reasons = [];
  if (!credential) reasons.push("credential_group_missing");
  else if (credential.provider !== model.provider) reasons.push("credential_provider_mismatch");
  else if (UNUSABLE_CREDENTIALS.has(credential.status)) reasons.push(`credential_${credential.status}`);
  else if (credential.quotaRemainingRatio === 0) reasons.push("credential_quota_exhausted");
  else if (credential.supportsModels.length > 0 && !credential.supportsModels.includes(model.id)) reasons.push("credential_model_not_allowed");
  if (!includesAll(model.capabilities, task.requiredCapabilities)) reasons.push("capability_mismatch");
  if (!includesAll(model.modalities, task.modalities)) reasons.push("modality_mismatch");
  if (!includesAll(model.languages, task.languages)) reasons.push("language_mismatch");
  if (model.contextWindow < task.contextRequirement + task.outputRequirement) reasons.push("context_too_small");
  if (model.maxOutput < task.outputRequirement) reasons.push("output_too_small");
  if (task.privacy === "local_required" && model.privacy !== "local") reasons.push("local_required");
  if (effectiveStatus(model, task.taskType) === "blocked") reasons.push("model_blocked");
  if (effectiveStatus(model, task.taskType) === "manual_only") reasons.push("manual_only");
  return reasons;
}

function scoreModel(model, credential, task, fallback) {
  const status = effectiveStatus(model, task.taskType);
  const qualityWeight = TIER_VALUES[task.qualityPriority];
  const costWeight = TIER_VALUES[task.costPriority];
  const latencyWeight = TIER_VALUES[task.latencyPriority];
  const verified = model.evidence.benchmark.length > 0 ? 8 : 0;
  const success = model.metrics.successRate == null ? 0 : model.metrics.successRate * 20 * qualityWeight;
  const format = model.metrics.formatSuccessRate == null ? 0 : model.metrics.formatSuccessRate * 8;
  const statusScore = { preferred: 18, qualified: 12, experimental: 2, degraded: -18 }[status] ?? -100;
  const costScore = (6 - model.costTier) * costWeight * 2;
  const latencyScore = (6 - model.latencyTier) * latencyWeight * 2;
  const contextHeadroom = task.contextRequirement === 0
    ? 0
    : Math.min(8, ((model.contextWindow - task.contextRequirement) / task.contextRequirement) * 4);
  const localPreference = task.privacy === "local_preferred" && model.privacy === "local" ? 18 : 0;
  const privacyScore = PRIVACY_LEVELS[model.privacy];
  const credentialPenalty = credential.status === "degraded" ? -12 : 0;
  const quotaPenalty = credential.quotaRemainingRatio != null && credential.quotaRemainingRatio < 0.1 ? -10 : 0;
  const failurePenalty = model.failureMarkers.length * -6;
  const fallbackPenalty = fallback ? -25 : 0;
  const breakdown = Object.freeze({
    status: statusScore,
    verified,
    success,
    format,
    cost: costScore,
    latency: latencyScore,
    contextHeadroom,
    localPreference,
    privacy: privacyScore,
    credential: credentialPenalty,
    quota: quotaPenalty,
    failures: failurePenalty,
    fallback: fallbackPenalty,
  });
  const score = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  return { score: Math.round(score * 100) / 100, breakdown };
}

export function resolve(input, registry) {
  const task = createTaskProfile(input);
  const rejected = [];
  const candidates = [];

  for (const model of registry.listModels(task.taskType)) {
    const credential = registry.getCredentialGroup(model.credentialGroupId);
    const reasons = hardRejectionReasons(model, credential, task);
    if (reasons.length) {
      rejected.push(Object.freeze({ modelId: model.id, reasons: Object.freeze(reasons) }));
      continue;
    }

    const status = effectiveStatus(model, task.taskType);
    const isExperimental = status === "experimental";
    const isDegraded = status === "degraded";
    if (isExperimental && !task.allowExperimental) {
      rejected.push(Object.freeze({ modelId: model.id, reasons: Object.freeze(["experimental_not_allowed"]) }));
      continue;
    }
    if (isDegraded && !task.allowDegradedFallback) {
      rejected.push(Object.freeze({ modelId: model.id, reasons: Object.freeze(["degraded_not_allowed"]) }));
      continue;
    }
    const fallback = isDegraded || !AUTO_STATUSES.has(status);
    const scored = scoreModel(model, credential, task, fallback);
    candidates.push(Object.freeze({
      modelId: model.id,
      provider: model.provider,
      credentialGroupId: credential.id,
      status,
      fallback,
      ...scored,
      reasons: Object.freeze([
        `matches:${task.requiredCapabilities.join("+") || "general"}`,
        `status:${status}`,
        `privacy:${model.privacy}`,
      ]),
    }));
  }

  candidates.sort((a, b) => b.score - a.score || a.modelId.localeCompare(b.modelId));
  const primaryCandidates = candidates.filter((item) => !item.fallback);
  const fallbackCandidates = candidates.filter((item) => item.fallback);
  const ranked = primaryCandidates.length ? [...primaryCandidates, ...fallbackCandidates] : fallbackCandidates;
  const selected = ranked[0] ?? null;

  return Object.freeze({
    task,
    status: selected ? (selected.fallback ? "fallback" : "resolved") : "no_match",
    selected,
    candidates: Object.freeze(ranked),
    fallbackChain: Object.freeze(ranked.slice(1)),
    rejected: Object.freeze(rejected),
    explanation: selected
      ? `${selected.modelId} selected with score ${selected.score}; ${selected.reasons.join(", ")}`
      : "No model satisfies the task's hard capability, availability, context and privacy constraints.",
  });
}
