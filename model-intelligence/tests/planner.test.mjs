import test from "node:test";
import assert from "node:assert/strict";
import { DecisionCache, ModelRegistry, TaskPlanner } from "../src/routing-index.mjs";

function registry({ quota = 1 } = {}) {
  return new ModelRegistry()
    .addCredentialGroup({ id: "cloud", provider: "vendor", status: "active", quotaRemainingRatio: quota })
    .addCredentialGroup({ id: "local", provider: "local", status: "active", quotaRemainingRatio: quota })
    .addModel({ id: "fast", provider: "vendor", credentialGroupId: "cloud", modalities: ["text"], languages: ["en", "zh"], capabilities: ["general", "coding"], contextWindow: 64000, maxOutput: 8000, costTier: 1, latencyTier: 1, privacy: "remote", status: "qualified" })
    .addModel({ id: "local-planner", provider: "local", credentialGroupId: "local", modalities: ["text"], languages: ["zh"], capabilities: ["planning", "reasoning"], contextWindow: 200000, maxOutput: 16000, costTier: 2, latencyTier: 2, privacy: "local", status: "qualified" })
    .addModel({ id: "local-implementer", provider: "local", credentialGroupId: "local", modalities: ["text"], languages: ["zh"], capabilities: ["coding", "tool_use"], contextWindow: 200000, maxOutput: 16000, costTier: 2, latencyTier: 2, privacy: "local", status: "qualified" });
}

function singleOutput() {
  return { task_type: "coding", difficulty: "hard", required_capabilities: ["coding"], modalities: ["text"], languages: ["en"], context_requirement: 32000, output_requirement: 4000, privacy: "normal", quality_priority: "high", cost_priority: "medium", latency_priority: "medium", needs_multi_agent: false, roles: [] };
}

function multiRoleOutput() {
  return { task_type: "coding", difficulty: "hard", required_capabilities: ["coding", "planning"], modalities: ["text"], languages: ["zh"], context_requirement: 100000, output_requirement: 8000, privacy: "normal", quality_priority: "high", cost_priority: "low", latency_priority: "low", needs_multi_agent: true, roles: [
    { role: "planner", required_capabilities: ["planning", "reasoning"], context_requirement: 1000 },
    { role: "implementation", required_capabilities: ["coding", "tool_use"], context_requirement: 50000 },
  ] };
}

function layaDecision(profile = singleOutput(), confidence = 0.9) {
  return { profile, confidence };
}

test("simple tasks short-circuit JEV completely", async () => {
  let calls = 0;
  const planner = new TaskPlanner({ jevClient: { async profileTask() { calls += 1; return singleOutput(); } } });
  const result = await planner.plan({ taskType: "general", difficulty: "simple", requiredCapabilities: ["general"], languages: ["en"] }, registry());
  assert.equal(calls, 0);
  assert.equal(result.source, "rules");
  assert.equal(result.selected.modelId, "fast");
  assert.deepEqual(result.provenance, { primary: "rules", selectedBy: "rules", layaCalls: 0, jevCalls: 0, fallbackReason: null });
});

test("complex single-model task uses injected fake JEV client", async () => {
  let calls = 0;
  const planner = new TaskPlanner({ jevClient: { async profileTask() { calls += 1; return JSON.stringify(singleOutput()); } } });
  const result = await planner.plan({ taskType: "coding", difficulty: "hard", requiredCapabilities: ["coding"] }, registry());
  assert.equal(calls, 1);
  assert.equal(result.source, "jev");
  assert.equal(result.status, "resolved");
  assert.equal(result.selected.modelId, "fast");
  assert.deepEqual(result.provenance, { primary: "jev", selectedBy: "jev", layaCalls: 0, jevCalls: 1, fallbackReason: null });
});

test("complex tasks use a confident Laya typed decision before JEV", async () => {
  let layaCalls = 0;
  let jevCalls = 0;
  const planner = new TaskPlanner({
    layaClient: { async profileTask() { layaCalls += 1; return layaDecision(); } },
    jevClient: { async profileTask() { jevCalls += 1; return singleOutput(); } },
  });
  const result = await planner.plan({ taskType: "coding", difficulty: "hard", requiredCapabilities: ["coding"] }, registry());
  assert.equal(layaCalls, 1);
  assert.equal(jevCalls, 0);
  assert.equal(result.source, "laya");
  assert.equal(result.status, "resolved");
  assert.equal(result.selected.modelId, "fast");
  assert.deepEqual(result.provenance, { primary: "laya_typed", selectedBy: "laya_typed", layaCalls: 1, jevCalls: 0, fallbackReason: null });
});

test("low-confidence or incomplete Laya typed decisions fall back to JEV", async () => {
  for (const { decision, threshold = 0.5, fallbackReason } of [
    { decision: layaDecision(singleOutput(), 0.49), fallbackReason: "laya_low_confidence" },
    { decision: { profile: singleOutput() }, fallbackReason: "laya_invalid_output" },
    { decision: layaDecision(singleOutput(), 0.6), threshold: 0.7, fallbackReason: "laya_low_confidence" },
  ]) {
    let layaCalls = 0;
    let jevCalls = 0;
    const planner = new TaskPlanner({
      layaClient: { async profileTask() { layaCalls += 1; return decision; } },
      jevClient: { async profileTask() { jevCalls += 1; return singleOutput(); } },
      layaConfidenceThreshold: threshold,
    });
    const result = await planner.plan({ taskType: "coding", difficulty: "hard" }, registry());
    assert.equal(layaCalls, 1);
    assert.equal(jevCalls, 1);
    assert.equal(result.source, "jev");
    assert.equal(result.status, "resolved");
    assert.deepEqual(result.provenance, { primary: "laya_typed", selectedBy: "jev_fallback", layaCalls: 1, jevCalls: 1, fallbackReason });
  }
});

test("Laya errors, timeouts, invalid profiles and weakened constraints fall back to JEV", async () => {
  for (const client of [
    { async profileTask() { throw new Error("laya upstream secret"); } },
    { async profileTask() { return new Promise(() => {}); } },
    { async profileTask() { return { profile: singleOutput(), confidence: 1, extra: "forbidden" }; } },
    { async profileTask() { return layaDecision({ ...singleOutput(), context_requirement: 1 }, 1); } },
  ]) {
    let jevCalls = 0;
    const planner = new TaskPlanner({
      layaClient: client,
      jevClient: { async profileTask() { jevCalls += 1; return singleOutput(); } },
      timeoutMs: 10,
    });
    const result = await planner.plan({ taskType: "coding", difficulty: "hard", contextRequirement: 32000 }, registry());
    assert.equal(jevCalls, 1);
    assert.equal(result.source, "jev");
    assert.equal(result.status, "resolved");
  }
});

test("failed Laya and JEV attempts fail closed and are not cached", async () => {
  const cache = new DecisionCache();
  const planner = new TaskPlanner({
    layaClient: { async profileTask() { return layaDecision(singleOutput(), 0.1); } },
    jevClient: { async profileTask() { throw new Error("jev upstream secret"); } },
    cache,
  });
  const result = await planner.plan({ taskType: "coding", difficulty: "hard" }, registry());
  assert.equal(result.status, "profile_unavailable");
  assert.equal(result.reason, "jev_error");
  assert.equal(result.source, "jev");
  assert.equal(result.selected, null);
  assert.doesNotMatch(result.detail, /jev upstream secret/);
  assert.equal(cache.size, 0);
  assert.deepEqual(result.provenance, { primary: "laya_typed", selectedBy: null, layaCalls: 1, jevCalls: 1, fallbackReason: "laya_low_confidence" });
});

test("multi-role profiles inherit privacy, languages, modalities and context constraints", async () => {
  const planner = new TaskPlanner({ jevClient: { async profileTask() { return multiRoleOutput(); } } });
  const result = await planner.plan({ taskType: "coding", difficulty: "hard", privacy: "local_required", accessMode: "read_only", contextRequirement: 100000 }, registry());
  assert.equal(result.status, "resolved");
  assert.deepEqual(result.roles.map((entry) => entry.decision.selected.modelId), ["local-planner", "local-implementer"]);
  for (const entry of result.roles) {
    assert.equal(entry.profile.privacy, "local_required");
    assert.equal(entry.profile.accessMode, "read_only");
    assert.equal(entry.profile.contextRequirement, 100000);
    assert.deepEqual(entry.profile.languages, ["zh"]);
    assert.deepEqual(entry.profile.modalities, ["text"]);
  }
});

test("invalid, empty, errored and timed-out JEV output fail closed and are not cached", async () => {
  for (const client of [
    { async profileTask() { return ""; } },
    { async profileTask() { return { ...singleOutput(), model: "forbidden" }; } },
    { async profileTask() { throw new Error("upstream-internal-secret"); } },
    { async profileTask() { return new Promise(() => {}); } },
  ]) {
    const cache = new DecisionCache();
    const planner = new TaskPlanner({ jevClient: client, timeoutMs: 10, cache });
    const result = await planner.plan({ taskType: "coding", difficulty: "hard" }, registry());
    assert.equal(result.status, "profile_unavailable");
    assert.equal(result.selected, null);
    assert.doesNotMatch(result.detail, /upstream-internal-secret/);
    assert.equal(cache.size, 0);
  }
});

test("decision cache hits, expires by TTL, and invalidates on credential state change", async () => {
  let now = 1000;
  let calls = 0;
  const cache = new DecisionCache({ ttlMs: 50, clock: () => now });
  const planner = new TaskPlanner({ cache, jevClient: { async profileTask() { calls += 1; return singleOutput(); } } });
  const input = { taskType: "coding", difficulty: "hard" };
  const healthy = registry({ quota: 1 });
  const first = await planner.plan(input, healthy);
  const second = await planner.plan(input, healthy);
  assert.equal(first.cache.hit, false);
  assert.equal(second.cache.hit, true);
  assert.equal(calls, 1);

  const exhausted = registry({ quota: 0 });
  const changedHealth = await planner.plan(input, exhausted);
  assert.equal(changedHealth.cache.hit, false);
  assert.equal(changedHealth.status, "no_match");
  assert.equal(calls, 2);

  now += 51;
  const expired = await planner.plan(input, healthy);
  assert.equal(expired.cache.hit, false);
  assert.equal(calls, 3);
});
