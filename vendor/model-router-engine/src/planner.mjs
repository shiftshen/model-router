import { DecisionCache, DECISION_CACHE_VERSION, decisionCacheKey } from "./decision-cache.mjs";
import { simpleRuleProfile, validateJevProfile } from "./jev-profile.mjs";
import { resolve } from "./resolver.mjs";
import { assertKnownKeys, assertPlainObject, cloneJson, deepFreeze } from "./validation.mjs";

function routeProvenance({ primary, selectedBy = null, layaCalls = 0, jevCalls = 0, fallbackReason = null }) {
  return deepFreeze({ primary, selectedBy, layaCalls, jevCalls, fallbackReason });
}

function errorResult(reason, detail = "", source = "jev", provenance = routeProvenance({ primary: "jev" })) {
  return deepFreeze({ status: "profile_unavailable", reason, detail, source, provenance, selected: null, roles: [], cache: { hit: false, version: DECISION_CACHE_VERSION } });
}

function profileConstraints(input) {
  return {
    privacy: input.privacy,
    accessMode: input.accessMode,
    contextRequirement: input.contextRequirement,
    outputRequirement: input.outputRequirement,
    modalities: input.modalities,
    languages: input.languages,
  };
}

async function callWithTimeout(client, payload, timeoutMs, timeoutCode) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => client.profileTask(payload, { signal: controller.signal })),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(timeoutCode)); }, timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function validateLayaDecision(output, confidenceThreshold) {
  let parsed = output;
  if (typeof output === "string") {
    if (output.trim() === "") throw new TypeError("Laya typed decision is empty");
    try { parsed = JSON.parse(output); } catch { throw new TypeError("Laya typed decision is not valid JSON"); }
  }
  assertPlainObject(parsed, "Laya typed decision");
  assertKnownKeys(parsed, ["profile", "confidence"], "Laya typed decision");
  if (!("confidence" in parsed)) throw new TypeError("Laya typed decision is missing confidence");
  if (typeof parsed.confidence !== "number" || !Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1) {
    throw new TypeError("Laya typed decision confidence must be a number from 0 to 1");
  }
  if (parsed.confidence < confidenceThreshold) return { accepted: false, reason: "laya_low_confidence" };
  if (!("profile" in parsed)) throw new TypeError("Laya typed decision is missing profile");
  return { accepted: true, profile: parsed.profile };
}

async function profileWithJev(client, payload, timeoutMs, constraints) {
  let raw;
  try {
    raw = await callWithTimeout(client, payload, timeoutMs, "JEV_TIMEOUT");
  } catch (error) {
    if (error?.message === "JEV_TIMEOUT") return { reason: "jev_timeout" };
    return { reason: "jev_error" };
  }
  try {
    return { profiled: validateJevProfile(raw, constraints) };
  } catch (error) {
    return { reason: "jev_invalid_output", detail: error.message };
  }
}

async function profileWithLaya(client, payload, timeoutMs, constraints, confidenceThreshold) {
  let raw;
  try {
    raw = await callWithTimeout(client, payload, timeoutMs, "LAYA_TIMEOUT");
  } catch (error) {
    return { reason: error?.message === "LAYA_TIMEOUT" ? "laya_timeout" : "laya_error" };
  }

  let decision;
  try {
    decision = validateLayaDecision(raw, confidenceThreshold);
  } catch (error) {
    return { reason: "laya_invalid_output", detail: error.message };
  }
  if (!decision.accepted) return decision;
  try {
    return { profiled: validateJevProfile(decision.profile, constraints) };
  } catch (error) {
    return { reason: "laya_invalid_output", detail: error.message };
  }
}

function resolvedPlan(profiled, registry, source, provenance) {
  if (!profiled.needsMultiAgent) {
    const decision = resolve(profiled.profile, registry);
    return deepFreeze({ status: decision.status, source, provenance, profile: profiled.profile, selected: decision.selected, decision, roles: [] });
  }
  const roles = profiled.roles.map(({ role, profile }) => deepFreeze({ role, profile, decision: resolve(profile, registry) }));
  const status = roles.every((entry) => entry.decision.status === "resolved")
    ? "resolved"
    : roles.some((entry) => entry.decision.status === "no_match") ? "no_match" : "fallback";
  return deepFreeze({ status, source, provenance, profile: profiled.profile, selected: null, decision: null, roles });
}

export class TaskPlanner {
  #layaClient;
  #jevClient;
  #timeoutMs;
  #layaConfidenceThreshold;
  #cache;

  constructor({ layaClient = null, jevClient = null, timeoutMs = 2_000, layaConfidenceThreshold = 0.5, cache = new DecisionCache() } = {}) {
    if (layaClient !== null && typeof layaClient?.profileTask !== "function") throw new TypeError("layaClient must expose profileTask()");
    if (jevClient !== null && typeof jevClient?.profileTask !== "function") throw new TypeError("jevClient must expose profileTask()");
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive integer");
    if (typeof layaConfidenceThreshold !== "number" || !Number.isFinite(layaConfidenceThreshold) || layaConfidenceThreshold < 0 || layaConfidenceThreshold > 1) {
      throw new TypeError("layaConfidenceThreshold must be a number from 0 to 1");
    }
    this.#layaClient = layaClient;
    this.#jevClient = jevClient;
    this.#timeoutMs = timeoutMs;
    this.#layaConfidenceThreshold = layaConfidenceThreshold;
    this.#cache = cache;
  }

  async plan(input, registry) {
    assertPlainObject(input, "task input");
    const safeInput = cloneJson(input, "task input");
    const key = decisionCacheKey(safeInput, registry);
    const cached = this.#cache.get(key);
    if (cached) return deepFreeze({ ...cached, cache: { hit: true, version: DECISION_CACHE_VERSION } });

    const simple = simpleRuleProfile(safeInput);
    if (simple) {
      const result = resolvedPlan(simple, registry, "rules", routeProvenance({ primary: "rules", selectedBy: "rules" }));
      const stored = this.#cache.set(key, result);
      return deepFreeze({ ...stored, cache: { hit: false, version: DECISION_CACHE_VERSION } });
    }
    const constraints = profileConstraints(safeInput);
    let layaFailure = null;
    if (this.#layaClient) {
      const laya = await profileWithLaya(this.#layaClient, safeInput, this.#timeoutMs, constraints, this.#layaConfidenceThreshold);
      if (laya.profiled) {
        const result = resolvedPlan(laya.profiled, registry, "laya", routeProvenance({
          primary: "laya_typed", selectedBy: "laya_typed", layaCalls: 1,
        }));
        const stored = this.#cache.set(key, result);
        return deepFreeze({ ...stored, cache: { hit: false, version: DECISION_CACHE_VERSION } });
      }
      layaFailure = laya;
    }

    if (!this.#jevClient) {
      if (layaFailure) {
        return errorResult(layaFailure.reason, layaFailure.detail ?? "", "laya", routeProvenance({
          primary: "laya_typed", layaCalls: 1, fallbackReason: layaFailure.reason,
        }));
      }
      return errorResult("jev_unavailable", "", "jev", routeProvenance({ primary: "jev" }));
    }
    const jev = await profileWithJev(this.#jevClient, safeInput, this.#timeoutMs, constraints);
    if (!jev.profiled) {
      return errorResult(jev.reason, jev.detail ?? "", "jev", routeProvenance({
        primary: layaFailure ? "laya_typed" : "jev",
        layaCalls: layaFailure ? 1 : 0,
        jevCalls: 1,
        fallbackReason: layaFailure?.reason ?? null,
      }));
    }
    const result = resolvedPlan(jev.profiled, registry, "jev", routeProvenance({
      primary: layaFailure ? "laya_typed" : "jev",
      selectedBy: layaFailure ? "jev_fallback" : "jev",
      layaCalls: layaFailure ? 1 : 0,
      jevCalls: 1,
      fallbackReason: layaFailure?.reason ?? null,
    }));
    const stored = this.#cache.set(key, result);
    return deepFreeze({ ...stored, cache: { hit: false, version: DECISION_CACHE_VERSION } });
  }
}
