import { buildRegistry, recommend as defaultRecommend } from "./engine.mjs";
import { resolve } from "./resolver.mjs";
import { cloneJson } from "./validation.mjs";

const AUTOMATIC_STATUSES = new Set(["qualified", "preferred"]);

function rejected(reason, recommendationStatus = null, source = null) {
  return {
    mode: "dispatch",
    decision: { status: "rejected", reason, recommendationStatus, source, selected: null },
    execution: { status: "skipped" },
  };
}

/**
 * Route a structured task, then hand the verified model identity to a host executor.
 * The host owns the prompt, credentials, model transport and execution policy.
 */
export async function dispatch(input, { recommendation, recommend = defaultRecommend, execute } = {}) {
  let request;
  let registry;
  let metadata;
  try {
    request = cloneJson(input, "request");
    ({ registry, metadata } = buildRegistry(request));
  } catch {
    return rejected("invalid_request");
  }

  if (typeof execute !== "function") return rejected("executor_unavailable");
  if (recommendation === undefined && typeof recommend !== "function") return rejected("recommender_unavailable");

  let plan = recommendation;
  if (plan === undefined) {
    try {
      plan = await recommend(request);
    } catch {
      return rejected("recommendation_failed");
    }
  }

  const recommendationStatus = typeof plan?.status === "string" ? plan.status : null;
  const source = typeof plan?.source === "string" ? plan.source : null;
  if (recommendationStatus !== "resolved" || !plan?.selected) {
    return rejected("no_resolved_selection", recommendationStatus, source);
  }

  const proposed = plan.selected;
  const known = metadata.get(proposed.id);
  const model = registry.getModel(proposed.id);
  if (!known || !model || proposed.id !== known.id || proposed.provider !== known.provider || proposed.modelId !== known.modelId) {
    return rejected("selection_identity_mismatch", recommendationStatus, source);
  }

  const credential = registry.getCredentialGroup(model.credentialGroupId);
  let eligible = false;
  let effectiveStatus;
  try {
    const validation = resolve(request.profile, registry);
    effectiveStatus = model.taskStatuses[validation.task.taskType] ?? model.status;
    eligible = validation.candidates.some((candidate) => candidate.modelId === proposed.id && !candidate.fallback);
  } catch {
    return rejected("invalid_request", recommendationStatus, source);
  }
  if (!AUTOMATIC_STATUSES.has(effectiveStatus) || proposed.status !== effectiveStatus || proposed.fallback !== false ||
      credential?.status !== "active" || credential.quotaRemainingRatio === 0 || !eligible) {
    return rejected("selection_not_qualified", recommendationStatus, source);
  }

  const selected = Object.freeze({ ...known });
  const decision = { status: "selected", recommendationStatus, source, selected };
  try {
    const result = await execute(selected, { profile: request.profile, source, provenance: plan.provenance ?? null });
    return { mode: "dispatch", decision, execution: { status: "completed", result } };
  } catch {
    return { mode: "dispatch", decision, execution: { status: "failed", reason: "executor_failed" } };
  }
}
