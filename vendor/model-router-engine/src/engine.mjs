import { access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { ModelRegistry, TaskPlanner, createJevTypedChoiceClient, createLayaCoreMLTransport, createLayaTypedDecisionsClient } from "./routing-index.mjs";
import { assertIdentifier, assertKnownKeys, assertPlainObject } from "./validation.mjs";

const PROFILE_KEYS = ["taskType", "difficulty", "requiredCapabilities", "modalities", "languages", "contextRequirement", "outputRequirement", "privacy", "qualityPriority", "costPriority", "latencyPriority", "allowExperimental", "allowDegradedFallback", "accessMode"];
const CANDIDATE_KEYS = ["id", "modelId", "provider", "capabilities", "modalities", "languages", "contextWindow", "maxOutput", "costTier", "latencyTier", "privacy", "status", "credentialStatus", "quotaRemainingRatio", "taskStatuses", "failureMarkers", "evidence", "metrics"];
const MAX_CANDIDATES = 100;

function parsePositiveInteger(value, fallback, field) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`${field} must be a positive integer`);
  return parsed;
}

function parseThreshold(value) {
  if (value == null || value === "") return 0.5;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new TypeError("LAYA_CONFIDENCE_THRESHOLD must be from 0 to 1");
  return parsed;
}

async function fileExists(path) {
  if (!path) return false;
  try { await access(path); return true; } catch { return false; }
}

function keychainKey() {
  if (process.platform !== "darwin") return null;
  try {
    const account = process.env.USER || userInfo().username;
    const value = execFileSync("/usr/bin/security", ["find-generic-password", "-a", account, "-s", "typesafe.ai.jev", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim();
    return value || null;
  } catch { return null; }
}

function getJevKey(env) {
  if (typeof env.TYPESAFE_API_KEY === "string" && env.TYPESAFE_API_KEY.trim()) return { key: env.TYPESAFE_API_KEY.trim(), source: "environment" };
  const key = keychainKey();
  return key ? { key, source: "keychain" } : { key: null, source: null };
}

export function buildRegistry(input) {
  assertPlainObject(input, "request");
  assertKnownKeys(input, ["profile", "candidates"], "request");
  assertPlainObject(input.profile, "profile");
  assertKnownKeys(input.profile, PROFILE_KEYS, "profile");
  if (!Array.isArray(input.candidates) || input.candidates.length === 0 || input.candidates.length > MAX_CANDIDATES) {
    throw new TypeError(`candidates must contain 1 to ${MAX_CANDIDATES} models`);
  }
  const registry = new ModelRegistry();
  const metadata = new Map();
  input.candidates.forEach((candidate, index) => {
    assertPlainObject(candidate, `candidates[${index}]`);
    assertKnownKeys(candidate, CANDIDATE_KEYS, `candidates[${index}]`);
    const id = assertIdentifier(candidate.id, `candidates[${index}].id`);
    const provider = assertIdentifier(candidate.provider, `candidates[${index}].provider`);
    const modelId = candidate.modelId == null ? id : assertIdentifier(candidate.modelId, `candidates[${index}].modelId`);
    if (typeof candidate.status !== "string" || typeof candidate.credentialStatus !== "string") {
      throw new TypeError(`candidates[${index}] requires explicit status and credentialStatus`);
    }
    const credentialGroupId = `candidate:${id}`;
    registry.addCredentialGroup({ id: credentialGroupId, provider, status: candidate.credentialStatus, quotaRemainingRatio: candidate.quotaRemainingRatio, supportsModels: [id] });
    registry.addModel({ ...candidate, id, provider, credentialGroupId });
    metadata.set(id, { id, modelId, provider });
  });
  return { registry, metadata };
}

export async function runtimeStatus(env = process.env) {
  const pythonSet = Boolean(env.LAYA_PYTHON);
  const modelSet = Boolean(env.LAYA_MODEL_PATH);
  const layaReady = pythonSet && modelSet && await fileExists(env.LAYA_PYTHON) && await fileExists(env.LAYA_MODEL_PATH);
  const jev = getJevKey(env);
  return {
    laya: { configured: pythonSet && modelSet, ready: layaReady, reason: layaReady ? null : pythonSet !== modelSet ? "incomplete_configuration" : pythonSet ? "path_unavailable" : "not_configured" },
    jev: { configured: Boolean(jev.key), credentialSource: jev.source },
  };
}

export async function createClients({ env = process.env, sdkLoader = () => import("@typesafe-ai/sdk") } = {}) {
  const status = await runtimeStatus(env);
  const timeoutMs = parsePositiveInteger(env.ROUTER_TIMEOUT_MS, 20_000, "ROUTER_TIMEOUT_MS");
  let layaClient = null;
  if (status.laya.ready) {
    const transport = createLayaCoreMLTransport({ pythonBin: env.LAYA_PYTHON, modelPath: env.LAYA_MODEL_PATH, timeoutMs });
    layaClient = createLayaTypedDecisionsClient({ transport });
  }
  let jevClient = null;
  if (status.jev.configured) {
    const { TypeSafeClient } = await sdkLoader();
    if (typeof TypeSafeClient !== "function") throw new TypeError("Jev SDK is unavailable");
    const { key } = getJevKey(env);
    const sdk = new TypeSafeClient({ apiKey: key, defaultModel: "jev-latest", logLevel: "off", retry: { maxRetries: 0 }, timeout: timeoutMs });
    jevClient = createJevTypedChoiceClient({ systemOne: (request) => sdk.systemOne({ ...request, model: "jev-latest" }), timeoutMs });
  }
  return { layaClient, jevClient, status, timeoutMs, layaConfidenceThreshold: parseThreshold(env.LAYA_CONFIDENCE_THRESHOLD) };
}

function decorateSelection(selected, metadata) {
  if (!selected) return null;
  const model = metadata.get(selected.modelId);
  return { ...selected, ...model };
}

export async function recommend(input, { env = process.env, clients = null } = {}) {
  const { registry, metadata } = buildRegistry(input);
  const active = clients ?? await createClients({ env });
  const planner = new TaskPlanner({ layaClient: active.layaClient, jevClient: active.jevClient, timeoutMs: active.timeoutMs ?? 20_000, layaConfidenceThreshold: active.layaConfidenceThreshold ?? 0.5 });
  const plan = await planner.plan(input.profile, registry);
  const roles = plan.roles.map((role) => ({ ...role, decision: { ...role.decision, selected: decorateSelection(role.decision.selected, metadata) } }));
  return { ...plan, mode: "advisory", selected: decorateSelection(plan.selected, metadata), roles };
}

export async function compare(input, { env = process.env, clients = null, now = () => Date.now() } = {}) {
  assertPlainObject(input, "comparison request");
  assertKnownKeys(input, ["cases"], "comparison request");
  if (!Array.isArray(input.cases) || input.cases.length === 0 || input.cases.length > 10) throw new TypeError("cases must contain 1 to 10 requests");
  const active = clients ?? await createClients({ env });
  const results = [];
  for (const [index, item] of input.cases.entries()) {
    assertPlainObject(item, `cases[${index}]`);
    assertKnownKeys(item, ["id", "profile", "candidates"], `cases[${index}]`);
    const id = assertIdentifier(item.id, `cases[${index}].id`);
    const row = { id };
    for (const [mode, layaClient, jevClient] of [
      ["laya_only", active.layaClient, null],
      ["jev_only", null, active.jevClient],
      ["laya_then_jev", active.layaClient, active.jevClient],
    ]) {
      const started = now();
      const plan = await recommend({ profile: item.profile, candidates: item.candidates }, { clients: { layaClient, jevClient, timeoutMs: active.timeoutMs, layaConfidenceThreshold: active.layaConfidenceThreshold } });
      row[mode] = { status: plan.status, source: plan.source, selected: plan.selected?.id ?? null, provenance: plan.provenance, elapsedMs: now() - started };
    }
    results.push(row);
  }
  return { mode: "advisory_comparison", cases: results };
}
