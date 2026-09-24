import { createTaskProfile } from "./task-profile.mjs";
import { assertIdentifier, assertKnownKeys, assertNonNegativeInteger, assertPlainObject, assertStringArray, deepFreeze } from "./validation.mjs";

const PROFILE_KEYS = ["task_type", "difficulty", "required_capabilities", "modalities", "languages", "context_requirement", "output_requirement", "privacy", "quality_priority", "cost_priority", "latency_priority", "needs_multi_agent", "roles"];
const ROLE_KEYS = ["role", "required_capabilities", "modalities", "languages", "context_requirement", "output_requirement"];
const PRIVACY_ORDER = Object.freeze({ normal: 0, local_preferred: 1, local_required: 2 });

function stricterPrivacy(left, right) {
  if (!(left in PRIVACY_ORDER) || !(right in PRIVACY_ORDER)) throw new TypeError("JEV privacy is invalid");
  return PRIVACY_ORDER[left] >= PRIVACY_ORDER[right] ? left : right;
}

function parsePayload(output) {
  if (typeof output === "string") {
    if (output.trim() === "") throw new TypeError("JEV output is empty");
    try { return JSON.parse(output); } catch { throw new TypeError("JEV output is not valid JSON"); }
  }
  return output;
}

function normalizeRole(input, index, globalProfile) {
  assertPlainObject(input, `JEV roles[${index}]`);
  assertKnownKeys(input, ROLE_KEYS, `JEV roles[${index}]`);
  const roleCapabilities = assertStringArray(input.required_capabilities, `JEV roles[${index}].required_capabilities`, { requireNonEmpty: true });
  const roleModalities = assertStringArray(input.modalities, `JEV roles[${index}].modalities`, { defaultValue: [], requireNonEmpty: false });
  const roleLanguages = assertStringArray(input.languages, `JEV roles[${index}].languages`, { defaultValue: [], requireNonEmpty: false });
  const contextRequirement = assertNonNegativeInteger(input.context_requirement ?? 0, `JEV roles[${index}].context_requirement`);
  const outputRequirement = assertNonNegativeInteger(input.output_requirement ?? 0, `JEV roles[${index}].output_requirement`);
  return deepFreeze({
    role: assertIdentifier(input.role, `JEV roles[${index}].role`),
    profile: createTaskProfile({
      ...globalProfile,
      requiredCapabilities: roleCapabilities,
      modalities: [...new Set([...globalProfile.modalities, ...roleModalities])],
      languages: [...new Set([...globalProfile.languages, ...roleLanguages])],
      contextRequirement: Math.max(globalProfile.contextRequirement, contextRequirement),
      outputRequirement: Math.max(globalProfile.outputRequirement, outputRequirement),
      privacy: globalProfile.privacy,
      accessMode: globalProfile.accessMode,
      allowExperimental: false,
      allowDegradedFallback: false,
    }),
  });
}

export function validateJevProfile(output, constraints = {}) {
  const parsed = parsePayload(output);
  assertPlainObject(parsed, "JEV output");
  assertKnownKeys(parsed, PROFILE_KEYS, "JEV output");
  for (const key of PROFILE_KEYS) {
    if (!(key in parsed)) throw new TypeError(`JEV output is missing field: ${key}`);
  }
  if (typeof parsed.needs_multi_agent !== "boolean") throw new TypeError("JEV needs_multi_agent must be a boolean");
  if (!Array.isArray(parsed.roles)) throw new TypeError("JEV roles must be an array");
  const constraintModalities = assertStringArray(constraints.modalities, "task constraint modalities", { defaultValue: [] });
  const constraintLanguages = assertStringArray(constraints.languages, "task constraint languages", { defaultValue: [] });
  const globalProfile = createTaskProfile({
    taskType: parsed.task_type,
    difficulty: parsed.difficulty,
    requiredCapabilities: parsed.required_capabilities,
    modalities: [...new Set([...assertStringArray(parsed.modalities, "JEV modalities", { requireNonEmpty: true }), ...constraintModalities])],
    languages: [...new Set([...assertStringArray(parsed.languages, "JEV languages", { requireNonEmpty: true }), ...constraintLanguages])],
    contextRequirement: parsed.context_requirement,
    outputRequirement: parsed.output_requirement ?? 0,
    privacy: stricterPrivacy(parsed.privacy, constraints.privacy ?? "normal"),
    qualityPriority: parsed.quality_priority,
    costPriority: parsed.cost_priority,
    latencyPriority: parsed.latency_priority,
    accessMode: constraints.accessMode ?? "read_only",
    allowExperimental: false,
    allowDegradedFallback: false,
  });
  if (constraints.contextRequirement != null && globalProfile.contextRequirement < constraints.contextRequirement) throw new TypeError("JEV output weakened contextRequirement");
  if (constraints.outputRequirement != null && globalProfile.outputRequirement < constraints.outputRequirement) throw new TypeError("JEV output weakened outputRequirement");
  if (parsed.needs_multi_agent && parsed.roles.length === 0) throw new TypeError("JEV multi-agent output requires roles");
  if (!parsed.needs_multi_agent && parsed.roles.length !== 0) throw new TypeError("JEV single-model output must not contain roles");
  const roleNames = new Set();
  const roles = parsed.roles.map((role, index) => normalizeRole(role, index, globalProfile));
  for (const role of roles) {
    if (roleNames.has(role.role)) throw new TypeError(`duplicate JEV role: ${role.role}`);
    roleNames.add(role.role);
  }
  return deepFreeze({ profile: globalProfile, needsMultiAgent: parsed.needs_multi_agent, roles });
}

export function simpleRuleProfile(input) {
  assertPlainObject(input, "task input");
  if (input.difficulty !== "simple") return null;
  return deepFreeze({ profile: createTaskProfile(input), needsMultiAgent: false, roles: [] });
}
