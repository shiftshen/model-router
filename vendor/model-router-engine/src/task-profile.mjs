import { PRIORITY_LEVELS } from "./constants.mjs";
import { assertBoolean, assertIdentifier, assertPlainObject, assertStringArray, deepFreeze } from "./validation.mjs";

export function createTaskProfile(input = {}) {
  assertPlainObject(input, "task profile");
  const profile = {
    taskType: assertIdentifier(input.taskType ?? "general", "taskType"),
    difficulty: input.difficulty ?? "medium",
    requiredCapabilities: assertStringArray(input.requiredCapabilities, "requiredCapabilities"),
    modalities: assertStringArray(input.modalities, "modalities", { defaultValue: ["text"], requireNonEmpty: true }),
    languages: assertStringArray(input.languages, "languages", { defaultValue: ["en"], requireNonEmpty: true }),
    contextRequirement: input.contextRequirement ?? 0,
    outputRequirement: input.outputRequirement ?? 0,
    privacy: input.privacy ?? "normal",
    qualityPriority: input.qualityPriority ?? "high",
    costPriority: input.costPriority ?? "medium",
    latencyPriority: input.latencyPriority ?? "medium",
    allowExperimental: assertBoolean(input.allowExperimental ?? false, "allowExperimental"),
    allowDegradedFallback: assertBoolean(input.allowDegradedFallback ?? false, "allowDegradedFallback"),
    accessMode: input.accessMode ?? "read_only",
  };

  if (!Number.isInteger(profile.contextRequirement) || profile.contextRequirement < 0) {
    throw new TypeError("contextRequirement must be a non-negative integer");
  }
  if (!Number.isInteger(profile.outputRequirement) || profile.outputRequirement < 0) {
    throw new TypeError("outputRequirement must be a non-negative integer");
  }
  if (!["simple", "medium", "hard"].includes(profile.difficulty)) {
    throw new TypeError("difficulty must be simple, medium or hard");
  }
  if (!["normal", "local_preferred", "local_required"].includes(profile.privacy)) {
    throw new TypeError("privacy must be normal, local_preferred or local_required");
  }
  if (!["read_only", "write_requires_confirmation"].includes(profile.accessMode)) {
    throw new TypeError("accessMode must be read_only or write_requires_confirmation");
  }
  for (const key of ["qualityPriority", "costPriority", "latencyPriority"]) {
    if (!PRIORITY_LEVELS.includes(profile[key])) throw new TypeError(`${key} is invalid`);
  }
  return deepFreeze(profile);
}
