import test from "node:test";
import assert from "node:assert/strict";
import { buildLayaTypedDecisionRequest, createLayaTypedDecisionsClient, LayaTypedDecisionsError, validateJevProfile } from "../src/routing-index.mjs";

function task(overrides = {}) {
  return {
    taskType: "coding",
    difficulty: "hard",
    requiredCapabilities: ["coding", "tool_use"],
    modalities: ["text"],
    languages: ["zh", "en"],
    contextRequirement: 32000,
    outputRequirement: 4000,
    privacy: "local_required",
    qualityPriority: "high",
    costPriority: "medium",
    latencyPriority: "medium",
    accessMode: "read_only",
    ...overrides,
  };
}

function layaResponse(overrides = {}) {
  return {
    model: "laya-rl-agent",
    answers: {
      difficulty: { choice: "hard", confidence: 0.42 },
      quality: { choice: "high", confidence: 0.44 },
      cost: { choice: "medium", confidence: 0.41 },
      latency: { choice: "medium", confidence: 0.46 },
      topology: { choice: "review_then_execute", confidence: 0.4 },
    },
    ...overrides,
  };
}

test("typed decision request sends a minimal constrained state and finite choices", () => {
  const request = buildLayaTypedDecisionRequest(task());
  assert.deepEqual(Object.keys(request.state), ["contractVersion", "taskType", "requiredCapabilities", "modalities", "languages", "contextRequirement", "outputRequirement", "privacy", "accessMode"]);
  assert.deepEqual(Object.keys(request.questions.topology.criteria), ["single_model", "review_then_execute"]);
  assert.deepEqual(Object.keys(request.questions.difficulty), ["type", "instructions", "criteria"]);
  assert.equal(request.questions.difficulty.type, "choice");
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.questions), true);
});

test("client maps typed labels into a valid Jev schema without inventing constraints", async () => {
  let received;
  const client = createLayaTypedDecisionsClient({
    async transport(request, options) {
      received = { request, options };
      return layaResponse();
    },
  });
  const controller = new AbortController();
  const result = await client.profileTask(task(), { signal: controller.signal });
  assert.equal(result.confidence, 0.4);
  assert.deepEqual(result.profile.required_capabilities, ["coding", "tool_use"]);
  assert.deepEqual(result.profile.modalities, ["text"]);
  assert.deepEqual(result.profile.languages, ["zh", "en"]);
  assert.equal(result.profile.privacy, "local_required");
  assert.deepEqual(result.profile.roles.map((role) => role.required_capabilities), [["coding", "tool_use"], ["coding", "tool_use"]]);
  assert.equal(received.options.signal, controller.signal);
  assert.doesNotThrow(() => validateJevProfile(result.profile, task()));
});

test("empty capability inputs cannot create a multi-agent profile", async () => {
  const client = createLayaTypedDecisionsClient({
    async transport(request) {
      assert.deepEqual(Object.keys(request.questions.topology.criteria), ["single_model"]);
      return layaResponse({ answers: { ...layaResponse().answers, topology: { choice: "single_model", confidence: 0.3 } } });
    },
  });
  const result = await client.profileTask(task({ requiredCapabilities: [] }));
  assert.equal(result.profile.needs_multi_agent, false);
  assert.deepEqual(result.profile.roles, []);
});

test("missing confidence and unsupported labels fail closed", async () => {
  for (const response of [
    layaResponse({ answers: { ...layaResponse().answers, quality: { choice: "high" } } }),
    layaResponse({ answers: { ...layaResponse().answers, topology: { choice: "free_text", confidence: 0.9 } } }),
  ]) {
    const client = createLayaTypedDecisionsClient({ transport: async () => response });
    await assert.rejects(client.profileTask(task()), (error) => error instanceof LayaTypedDecisionsError && ["LAYA_INVALID_CONFIDENCE", "LAYA_INVALID_RESPONSE"].includes(error.code));
  }
});

test("unconfigured, transport failure, and cancellation use sanitized failure codes", async () => {
  const unavailable = createLayaTypedDecisionsClient();
  await assert.rejects(unavailable.profileTask(task()), (error) => error instanceof LayaTypedDecisionsError && error.code === "LAYA_UNAVAILABLE");

  const failed = createLayaTypedDecisionsClient({ transport: async () => { throw new Error("private runtime path /secrets/token"); } });
  await assert.rejects(failed.profileTask(task()), (error) => error instanceof LayaTypedDecisionsError && error.code === "LAYA_TRANSPORT_FAILED" && !error.message.includes("/secrets"));

  const controller = new AbortController();
  controller.abort();
  const client = createLayaTypedDecisionsClient({ transport: async () => layaResponse() });
  await assert.rejects(client.profileTask(task(), { signal: controller.signal }), (error) => error instanceof LayaTypedDecisionsError && error.code === "LAYA_ABORTED");
});
