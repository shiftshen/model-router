import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createJevTypedChoiceClient, createLayaCoreMLTransport, DecisionRuntimeError } from "../src/routing-index.mjs";

function task(overrides = {}) {
  return {
    taskType: "coding", difficulty: "hard", requiredCapabilities: ["coding", "tool_use"], modalities: ["text"], languages: ["zh", "en"],
    contextRequirement: 32000, outputRequirement: 4000, privacy: "local_required", qualityPriority: "high", costPriority: "medium", latencyPriority: "medium", accessMode: "read_only",
    ...overrides,
  };
}

function request() {
  return { state: { taskType: "coding" }, questions: { decision: { type: "choice" } } };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = { written: "", write(value) { this.written += value; }, end() {} };
  child.stdout = new EventEmitter();
  child.killSignals = [];
  child.kill = (signal) => child.killSignals.push(signal);
  return child;
}

test("Laya CoreML transport spawns one shell-free process and exchanges JSON through stdio", async () => {
  const child = fakeChild();
  let spawnCall;
  const transport = createLayaCoreMLTransport({
    pythonBin: "/explicit/python", modelPath: "/explicit/model", timeoutMs: 100,
    spawn(...args) { spawnCall = args; queueMicrotask(() => { child.stdout.emit("data", JSON.stringify({ answers: {} })); child.emit("close", 0); }); return child; },
  });
  const response = await transport(request());
  assert.deepEqual(response, { answers: {} });
  assert.equal(spawnCall[0], "/explicit/python");
  assert.deepEqual(spawnCall[1].slice(0, 2), ["-c", spawnCall[1][1]]);
  assert.equal(spawnCall[1][2], "/explicit/model");
  assert.equal(spawnCall[2].shell, false);
  assert.deepEqual(JSON.parse(child.stdin.written), request());
});

test("Laya CoreML transport has sanitized failure, timeout, abort, and JSON error paths", async () => {
  const invalidJson = createLayaCoreMLTransport({ pythonBin: "python", modelPath: "model", spawn() { const child = fakeChild(); queueMicrotask(() => { child.stdout.emit("data", "secret stack trace"); child.emit("close", 0); }); return child; } });
  await assert.rejects(invalidJson(request()), (error) => error instanceof DecisionRuntimeError && error.code === "LAYA_INVALID_RESPONSE" && !error.message.includes("secret"));

  const timeoutChild = fakeChild();
  const timeout = createLayaCoreMLTransport({ pythonBin: "python", modelPath: "model", timeoutMs: 5, spawn: () => timeoutChild });
  await assert.rejects(timeout(request()), (error) => error instanceof DecisionRuntimeError && error.code === "LAYA_TIMEOUT");
  assert.deepEqual(timeoutChild.killSignals, ["SIGTERM"]);

  const abortChild = fakeChild();
  const abort = createLayaCoreMLTransport({ pythonBin: "python", modelPath: "model", spawn: () => abortChild });
  const controller = new AbortController();
  const pending = abort(request(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error instanceof DecisionRuntimeError && error.code === "LAYA_ABORTED");
  assert.deepEqual(abortChild.killSignals, ["SIGTERM"]);
});

test("Jev typed-choice client gives systemOne a finite template question and copies hard constraints", async () => {
  let received;
  const client = createJevTypedChoiceClient({ async systemOne(value, options) { received = { value, options }; return { answers: { decision: { choice: "review_then_execute" } } }; } });
  const controller = new AbortController();
  const profile = await client.profileTask(task(), { signal: controller.signal });
  assert.deepEqual(Object.keys(received.value.questions), ["decision"]);
  assert.deepEqual(Object.keys(received.value.questions.decision.criteria), ["single_model", "review_then_execute"]);
  assert.equal(received.value.questions.decision.type, "choice");
  assert.equal(received.options.signal, controller.signal);
  assert.equal(profile.privacy, "local_required");
  assert.equal(profile.context_requirement, 32000);
  assert.deepEqual(profile.roles.map((role) => role.required_capabilities), [["coding", "tool_use"], ["coding", "tool_use"]]);
});

test("Jev typed-choice client fails closed for invalid choice, timeout, and cancellation", async () => {
  const invalid = createJevTypedChoiceClient({ systemOne: async () => ({ decision: { choice: "free_text" } }) });
  await assert.rejects(invalid.profileTask(task()), (error) => error instanceof DecisionRuntimeError && error.code === "JEV_TYPED_INVALID_RESPONSE");

  const timedOut = createJevTypedChoiceClient({ systemOne: async () => new Promise(() => {}), timeoutMs: 5 });
  await assert.rejects(timedOut.profileTask(task()), (error) => error instanceof DecisionRuntimeError && error.code === "JEV_TIMEOUT");

  const cancelled = createJevTypedChoiceClient({ systemOne: async () => new Promise(() => {}) });
  const controller = new AbortController();
  const pending = cancelled.profileTask(task(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error instanceof DecisionRuntimeError && error.code === "JEV_ABORTED");
});

test("Jev typed-choice client cannot select a multi-agent template for capability-free work", async () => {
  const client = createJevTypedChoiceClient({ systemOne: async () => "review_then_execute" });
  await assert.rejects(client.profileTask(task({ requiredCapabilities: [] })), (error) => error instanceof DecisionRuntimeError && error.code === "JEV_TYPED_INVALID_RESPONSE");
});
