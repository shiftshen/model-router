import { CREDENTIAL_STATUSES, MODEL_STATUSES, PRIVACY_LEVELS } from "./constants.mjs";
import { assertIdentifier, assertIsoDate, assertPlainObject, assertRatio, assertStringArray, cloneJson, deepFreeze } from "./validation.mjs";

const assertChoice = (value, choices, field) => {
  if (!choices.includes(value)) {
    throw new TypeError(`${field} must be one of: ${choices.join(", ")}`);
  }
};

const assertTier = (value, field) => {
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new TypeError(`${field} must be an integer from 1 to 5`);
  }
};

export function defineCredentialGroup(input) {
  assertPlainObject(input, "credential group");
  const id = assertIdentifier(input.id, "credential group id");
  const provider = assertIdentifier(input.provider, "credential provider");
  const status = input.status ?? "active";
  assertChoice(status, CREDENTIAL_STATUSES, "credential status");
  return deepFreeze({
    id,
    provider,
    status,
    quotaRemainingRatio: assertRatio(input.quotaRemainingRatio ?? null, "quotaRemainingRatio"),
    supportsModels: assertStringArray(input.supportsModels, "supportsModels"),
    metadata: cloneJson(input.metadata ?? {}, "credential metadata"),
  });
}

export function defineModel(input) {
  assertPlainObject(input, "model");
  const id = assertIdentifier(input.id, "model id");
  const provider = assertIdentifier(input.provider, "model provider");
  const credentialGroupId = assertIdentifier(input.credentialGroupId, "credentialGroupId");
  const status = input.status ?? "experimental";
  assertChoice(status, MODEL_STATUSES, "model status");
  if (!(input.privacy in PRIVACY_LEVELS)) {
    throw new TypeError("model privacy must be local, private-cloud or remote");
  }
  assertTier(input.costTier, "costTier");
  assertTier(input.latencyTier, "latencyTier");
  if (!Number.isInteger(input.contextWindow) || input.contextWindow <= 0) {
    throw new TypeError("contextWindow must be a positive integer");
  }
  if (!Number.isInteger(input.maxOutput) || input.maxOutput <= 0) {
    throw new TypeError("maxOutput must be a positive integer");
  }

  const rawTaskStatuses = input.taskStatuses ?? {};
  assertPlainObject(rawTaskStatuses, "taskStatuses");
  const taskStatuses = {};
  for (const [key, value] of Object.entries(rawTaskStatuses)) {
    const taskType = assertIdentifier(key, "task status key");
    assertChoice(value, MODEL_STATUSES, "task status");
    taskStatuses[taskType] = value;
  }
  const rawEvidence = input.evidence ?? {};
  const rawMetrics = input.metrics ?? {};
  assertPlainObject(rawEvidence, "evidence");
  assertPlainObject(rawMetrics, "metrics");

  return deepFreeze({
    id,
    provider,
    credentialGroupId,
    modalities: assertStringArray(input.modalities, "modalities", { requireNonEmpty: true }),
    languages: assertStringArray(input.languages, "languages", { requireNonEmpty: true }),
    capabilities: assertStringArray(input.capabilities, "capabilities", { requireNonEmpty: true }),
    contextWindow: input.contextWindow,
    maxOutput: input.maxOutput,
    costTier: input.costTier,
    latencyTier: input.latencyTier,
    privacy: input.privacy,
    status,
    taskStatuses,
    failureMarkers: assertStringArray(input.failureMarkers, "failureMarkers"),
    evidence: {
      public: assertStringArray(rawEvidence.public, "evidence.public", { identifiers: false }),
      benchmark: assertStringArray(rawEvidence.benchmark, "evidence.benchmark"),
      lastVerifiedAt: rawEvidence.lastVerifiedAt == null ? null : assertIsoDate(rawEvidence.lastVerifiedAt, "evidence.lastVerifiedAt"),
    },
    metrics: {
      successRate: assertRatio(rawMetrics.successRate ?? null, "successRate"),
      formatSuccessRate: assertRatio(rawMetrics.formatSuccessRate ?? null, "formatSuccessRate"),
      fallbackRate: assertRatio(rawMetrics.fallbackRate ?? null, "fallbackRate"),
    },
  });
}

export class ModelRegistry {
  #credentials = new Map();
  #models = new Map();
  #revision = 0;

  addCredentialGroup(input) {
    const group = defineCredentialGroup(input);
    if (this.#credentials.has(group.id)) throw new Error(`duplicate credential group: ${group.id}`);
    this.#credentials.set(group.id, group);
    this.#revision += 1;
    return this;
  }

  addModel(input) {
    const model = defineModel(input);
    if (!this.#credentials.has(model.credentialGroupId)) {
      throw new Error(`unknown credential group: ${model.credentialGroupId}`);
    }
    if (this.#models.has(model.id)) throw new Error(`duplicate model: ${model.id}`);
    this.#models.set(model.id, model);
    this.#revision += 1;
    return this;
  }

  getCredentialGroup(id) { return this.#credentials.get(id) ?? null; }
  getModel(id) { return this.#models.get(id) ?? null; }
  listCredentialGroups() { return Object.freeze([...this.#credentials.values()]); }
  listModels() { return Object.freeze([...this.#models.values()]); }
  stateVersion() {
    const credentials = this.listCredentialGroups().map(({ id, provider, status, quotaRemainingRatio, supportsModels }) => ({ id, provider, status, quotaRemainingRatio, supportsModels }));
    const models = this.listModels().map(({ id, provider, credentialGroupId, modalities, languages, capabilities, contextWindow, maxOutput, costTier, latencyTier, privacy, status, taskStatuses, failureMarkers, metrics }) => ({ id, provider, credentialGroupId, modalities, languages, capabilities, contextWindow, maxOutput, costTier, latencyTier, privacy, status, taskStatuses, failureMarkers, metrics }));
    credentials.sort((left, right) => left.id.localeCompare(right.id));
    models.sort((left, right) => left.id.localeCompare(right.id));
    return JSON.stringify({ schema: 1, revision: this.#revision, credentials, models });
  }
}
