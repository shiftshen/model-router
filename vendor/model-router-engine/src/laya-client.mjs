import { createTaskProfile } from "./task-profile.mjs";
import { deepFreeze } from "./validation.mjs";

export const LAYA_TYPED_DECISIONS_CONTRACT_VERSION = "v1";

const DECISION_OPTIONS = Object.freeze({
  difficulty: Object.freeze(["simple", "medium", "hard"]),
  quality: Object.freeze(["low", "medium", "high"]),
  cost: Object.freeze(["low", "medium", "high"]),
  latency: Object.freeze(["low", "medium", "high"]),
  topology: Object.freeze(["single_model", "review_then_execute"]),
});

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function layaError(code) {
  return new LayaTypedDecisionsError(code);
}

function answerChoice(response, id, allowed) {
  if (!plainObject(response) || !plainObject(response.answers) || !plainObject(response.answers[id])) throw layaError("LAYA_INVALID_RESPONSE");
  const answer = response.answers[id];
  if (typeof answer.choice !== "string" || !allowed.includes(answer.choice)) throw layaError("LAYA_INVALID_RESPONSE");
  if (typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) {
    throw layaError("LAYA_INVALID_CONFIDENCE");
  }
  return answer;
}

function question(id, instruction, criteria) {
  return deepFreeze({
    type: "choice",
    instructions: instruction,
    criteria: Object.fromEntries(criteria.map((choice) => [choice, choice.replaceAll("_", " ")])),
  });
}

/**
 * Produces the constrained choice questionnaire accepted by Laya's Core ML
 * `system_one`/`predict` API.  It intentionally has no free-text field: all
 * profile values are either selected from a finite safe set or copied from the
 * caller's already-validated task constraints.
 */
export function buildLayaTypedDecisionRequest(payload) {
  const task = createTaskProfile(payload);
  const canSplitRoles = task.requiredCapabilities.length > 0;
  const questions = {
    difficulty: question("difficulty", "Classify the task difficulty.", DECISION_OPTIONS.difficulty),
    quality: question("quality", "Choose the required output quality priority.", DECISION_OPTIONS.quality),
    cost: question("cost", "Choose the cost sensitivity.", DECISION_OPTIONS.cost),
    latency: question("latency", "Choose the latency sensitivity.", DECISION_OPTIONS.latency),
    topology: question(
      "topology",
      canSplitRoles ? "Choose one model or a review followed by execution." : "Use a single model when no explicit capability is required.",
      canSplitRoles ? DECISION_OPTIONS.topology : ["single_model"],
    ),
  };
  const state = {
    contractVersion: LAYA_TYPED_DECISIONS_CONTRACT_VERSION,
    taskType: task.taskType,
    requiredCapabilities: task.requiredCapabilities,
    modalities: task.modalities,
    languages: task.languages,
    contextRequirement: task.contextRequirement,
    outputRequirement: task.outputRequirement,
    privacy: task.privacy,
    accessMode: task.accessMode,
  };
  return deepFreeze({ state, questions });
}

function profileFromTypedDecisions(task, request, response) {
  const difficulty = answerChoice(response, "difficulty", DECISION_OPTIONS.difficulty);
  const quality = answerChoice(response, "quality", DECISION_OPTIONS.quality);
  const cost = answerChoice(response, "cost", DECISION_OPTIONS.cost);
  const latency = answerChoice(response, "latency", DECISION_OPTIONS.latency);
  const topology = answerChoice(response, "topology", Object.keys(request.questions.topology.criteria));
  const needsMultiAgent = topology.choice === "review_then_execute";

  // Role capabilities are copied from the caller's constraints.  The typed
  // model cannot introduce an unverified capability, modality, language, or
  // privacy relaxation through a label or a generated string.
  const roles = needsMultiAgent
    ? [
      { role: "review", required_capabilities: task.requiredCapabilities },
      { role: "execution", required_capabilities: task.requiredCapabilities },
    ]
    : [];
  const profile = {
    task_type: task.taskType,
    difficulty: difficulty.choice,
    required_capabilities: task.requiredCapabilities,
    modalities: task.modalities,
    languages: task.languages,
    context_requirement: task.contextRequirement,
    output_requirement: task.outputRequirement,
    privacy: task.privacy,
    quality_priority: quality.choice,
    cost_priority: cost.choice,
    latency_priority: latency.choice,
    needs_multi_agent: needsMultiAgent,
    roles,
  };
  const confidence = Math.min(difficulty.confidence, quality.confidence, cost.confidence, latency.confidence, topology.confidence);
  return deepFreeze({ profile, confidence });
}

export class LayaTypedDecisionsError extends Error {
  constructor(code) {
    super(code);
    this.name = "LayaTypedDecisionsError";
    this.code = code;
  }
}

/**
 * Create a JEV-compatible profiling client backed by a caller-provided Laya
 * runtime boundary.  `transport` receives `{ state, questions }` and
 * `{ signal }`, then returns the JSON object emitted by Laya Core ML's
 * `predict` API.  The package never locates a model, starts Python, or reads a
 * local cache itself.
 */
export function createLayaTypedDecisionsClient({ transport = null } = {}) {
  if (transport !== null && typeof transport !== "function") throw new TypeError("transport must be a function or null");
  return Object.freeze({
    async profileTask(payload, { signal } = {}) {
      if (signal?.aborted) throw layaError("LAYA_ABORTED");
      if (transport === null) throw layaError("LAYA_UNAVAILABLE");
      const task = createTaskProfile(payload);
      const request = buildLayaTypedDecisionRequest(task);
      let response;
      try {
        response = await transport(request, { signal });
      } catch (error) {
        if (error?.name === "AbortError" || signal?.aborted) throw layaError("LAYA_ABORTED");
        throw layaError("LAYA_TRANSPORT_FAILED");
      }
      return profileFromTypedDecisions(task, request, response);
    },
  });
}
