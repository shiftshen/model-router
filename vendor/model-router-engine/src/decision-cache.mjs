import { deepFreeze } from "./validation.mjs";

export const DECISION_CACHE_VERSION = "m2-v1";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function decisionCacheKey(taskInput, registry) {
  if (!registry || typeof registry.stateVersion !== "function") throw new TypeError("registry must expose stateVersion()");
  return JSON.stringify({ version: DECISION_CACHE_VERSION, task: stable(taskInput), registry: registry.stateVersion() });
}

export class DecisionCache {
  #entries = new Map();
  #clock;
  #ttlMs;
  #maxEntries;

  constructor({ ttlMs = 60_000, maxEntries = 100, clock = Date.now } = {}) {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new TypeError("ttlMs must be a positive integer");
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) throw new TypeError("maxEntries must be a positive integer");
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
    this.#clock = clock;
  }

  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.#clock()) {
      this.#entries.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value) {
    if (this.#entries.size >= this.#maxEntries && !this.#entries.has(key)) {
      this.#entries.delete(this.#entries.keys().next().value);
    }
    const frozen = deepFreeze(value);
    this.#entries.set(key, { expiresAt: this.#clock() + this.#ttlMs, value: frozen });
    return frozen;
  }

  clear() { this.#entries.clear(); }
  get size() { return this.#entries.size; }
}
