import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { ModelStore } from "../src/model-store.mjs";
import { createGateway, failRoute, noteRoute } from "../src/model-gateway.mjs";
import { qualifiedTaskCandidates } from "../src/task-qualification.mjs";
import { evaluateTaskOutput, runTask } from "../src/task-executor.mjs";

async function listen(server, t) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, answers = { a: "wrong", b: "42" }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-executor-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ModelStore(root);
  await store.read();
  const received = [];
  for (const [index, id] of ["a", "b"].entries()) {
    const upstream = await listen(http.createServer(async (request, response) => {
      if (request.url === "/v1/models") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [{ id: `model-${id}` }] }));
        return;
      }
      let raw = "";
      for await (const chunk of request) raw += chunk;
      received.push({ id, body: JSON.parse(raw) });
      response.setHeader("content-type", "application/json");
      if (answers[id] === "HTTP_503") {
        response.writeHead(503);
        response.end(JSON.stringify({ error: { message: "provider unavailable" } }));
        return;
      }
      response.end(JSON.stringify({ model: `model-${id}`, choices: [{ message: { content: answers[id] } }], usage: {} }));
    }), t);
    const before = await store.read();
    await store.save({ id, name: id, endpoint: `${upstream}/v1`, protocol: "chat", model: `model-${id}`,
      credentialID: id, noKey: true, contextWindow: 8192, fallback: id === "a" ? "b" : "" }, before.revision);
    const route = await store.route(id);
    await fs.mkdir(path.join(root, "checks"), { recursive: true });
    await fs.mkdir(path.join(root, "validation"), { recursive: true });
    const common = { testedAt: new Date().toISOString(), model: route.model, endpoint: route.endpoint,
      protocol: route.protocol, credentialVersion: await store.credentialVersion(route.credentialID) };
    await fs.writeFile(path.join(root, "checks", `${id}.json`), JSON.stringify({ ...common, ok: true }));
    await fs.writeFile(path.join(root, "validation", `${id}.json`), JSON.stringify({
      ...common, mode: "live", routeId: id, score: index === 0 ? 95 : 90, byCategory: { backend: index === 0 ? 100 : 90 },
    }));
  }
  const gatewayURL = (await listen(createGateway(store), t)) + "/router/v1/responses";
  return { store, root, gatewayURL, received };
}

test("simple task accepts only qualified backup after real gateway response fails acceptance", async (t) => {
  const { store, root, gatewayURL, received } = await fixture(t);
  const prompt = "PRIVATE_TASK_TEXT: What is six times seven?";
  const result = await runTask({ text: prompt, complexity: "simple", category: "backend",
    acceptance: { type: "exact_text", expected: "42" } }, { store, gatewayURL });
  assert.equal(result.status, "passed");
  assert.equal(result.selectedRoute, "a");
  assert.equal(result.actualRoute, "b");
  assert.equal(result.output, "42");
  assert.deepEqual(received.map((entry) => entry.id), ["a", "b"]);
  assert.ok(received.every((entry) => entry.body.messages.some((item) => item.content.includes(prompt))));
  assert.deepEqual(result.attempts.map((item) => item.acceptance.passed), [false, true]);
  assert.ok(result.attempts.every((item) => item.gatewayRequestId && item.actualRoute === item.routeId));
  const routeLog = JSON.parse(await fs.readFile(path.join(root, "route-log.json"), "utf8"));
  for (const attempt of result.attempts) {
    const gateway = routeLog.find((entry) => entry.requestId === attempt.gatewayRequestId);
    assert.equal(gateway.route, attempt.actualRoute);
    assert.equal(gateway.status, "completed");
    assert.equal(gateway.observedModel, attempt.responseModel);
  }
  const audit = await fs.readFile(path.join(root, "task-runs", `${result.taskId}.json`), "utf8");
  assert.doesNotMatch(audit, /PRIVATE_TASK_TEXT|What is six times seven|"output"|test-key/);
  assert.equal(JSON.parse(audit).attempts.length, 2);
});

test("task requests disable gateway's unchecked fallback; executor switches after a failed attempt", async (t) => {
  const { store, root, gatewayURL, received } = await fixture(t, { a: "HTTP_503", b: "42" });
  const result = await runTask({ text: "Return 42 for this backend check", complexity: "simple", category: "backend",
    acceptance: { type: "exact_text", expected: "42" } }, { store, gatewayURL });
  assert.equal(result.status, "passed");
  assert.deepEqual(received.map((item) => item.id), ["a", "b"]);
  assert.deepEqual(result.attempts.map((item) => item.actualRoute), ["a", "b"]);
  assert.equal(result.attempts[1].switchReason, result.attempts[0].acceptance.reason);
  const routes = JSON.parse(await fs.readFile(path.join(root, "route-log.json")));
  assert.equal(routes.length, 2);
  assert.notEqual(routes[0].sessionId, routes[1].sessionId);
});

test("task route log stores a safe failure code when provider echoes the prompt", async (t) => {
  const { root } = await fixture(t);
  const sessionId = `task-${randomUUID()}-a1`;
  const started = await noteRoute(root, { id: "a", name: "a", endpoint: "http://127.0.0.1:1/v1" }, { sessionId });
  await failRoute(root, started.requestId, { error: "PRIVATE_PROMPT_TEXT was rejected" });
  const routes = JSON.parse(await fs.readFile(path.join(root, "route-log.json")));
  assert.equal(routes.at(-1).error, "task_upstream_failed");
  assert.doesNotMatch(JSON.stringify(routes), /PRIVATE_PROMPT_TEXT/);
});

test("complex Engine sees only structured snapshot and selected identity must match", async (t) => {
  const { store, gatewayURL, received } = await fixture(t, { a: "wrong", b: "42" });
  let engineInput = null;
  const recommend = async (_enginePath, input) => {
    engineInput = input;
    const b = input.candidates.find((item) => item.id === "model-b");
    return { mode: "advisory", status: "resolved", selected: { id: b.id, modelId: b.modelId, provider: b.provider },
      roles: [], provenance: { selectedBy: "jev_fallback" } };
  };
  const result = await runTask({ text: "PRIVATE_COMPLEX_PROMPT: analyze backend migration",
    complexity: "complex", category: "backend", acceptance: { type: "exact_text", expected: "42" } },
  { store, gatewayURL, recommend });
  assert.equal(result.status, "passed");
  assert.equal(result.decisionSource, "jev_fallback");
  assert.equal(result.selectedRoute, "b");
  assert.deepEqual(received.map((entry) => entry.id), ["b"]);
  assert.doesNotMatch(JSON.stringify(engineInput), /PRIVATE_COMPLEX_PROMPT|analyze backend migration/);
  const bad = await runTask({ text: "Do backend work", complexity: "complex", category: "backend",
    acceptancePhrase: "42" }, { store, gatewayURL, recommend: async () => ({
      mode: "advisory", status: "resolved", selected: { id: "unqualified", modelId: "x", provider: "x" }, roles: [],
    }) });
  assert.equal(bad.status, "rejected");
  assert.equal(received.length, 1);
});

test("stale evidence, changed endpoint, GPT-5.6 policy and absent GPT-6/local routes fail qualification", async (t) => {
  const { store, root } = await fixture(t);
  const data = await store.read();
  await store.save({ id: "legacy", name: "GPT 5.6", endpoint: "https://example.org/v1", protocol: "responses",
    model: "gpt-5.6-sol", credentialID: "legacy", contextWindow: 8192 }, data.revision, "test-key");
  const legacy = await store.route("legacy");
  const common = { testedAt: new Date().toISOString(), model: legacy.model, endpoint: legacy.endpoint,
    protocol: legacy.protocol, credentialVersion: await store.credentialVersion(legacy.credentialID) };
  await fs.writeFile(path.join(root, "checks", "legacy.json"), JSON.stringify({ ...common, ok: true }));
  await fs.writeFile(path.join(root, "validation", "legacy.json"), JSON.stringify({
    ...common, routeId: legacy.id, mode: "live", score: 100, byCategory: { backend: 100 },
  }));
  const profile = { category: "backend", privacy: "normal", contextRequirement: 500, outputRequirement: 256 };
  let qualification = await qualifiedTaskCandidates(store, profile);
  assert.ok(qualification.rejected.find((item) => item.routeId === "legacy")?.reasons.includes("excluded_gpt_5_6"));
  assert.ok(!qualification.eligible.some((item) => item.route.model === "gpt-6-sol" || item.route.model === "qwen3-vl:latest"));
  const stale = JSON.parse(await fs.readFile(path.join(root, "validation", "a.json")));
  stale.testedAt = new Date(Date.now() - 4 * 86400000).toISOString();
  await fs.writeFile(path.join(root, "validation", "a.json"), JSON.stringify(stale));
  qualification = await qualifiedTaskCandidates(store, profile);
  assert.ok(qualification.rejected.find((item) => item.routeId === "a")?.reasons.includes("validation_stale_or_mismatch"));
});

test("HTTP 200, reasoning only, or non-completed status cannot pass task acceptance", () => {
  const policy = { type: "exact_text", expected: "42" };
  assert.deepEqual(evaluateTaskOutput({ status: "in_progress" }, "42", policy), { passed: false, reason: "response_incomplete" });
  assert.deepEqual(evaluateTaskOutput({ status: "completed" }, "", policy), { passed: false, reason: "empty_final_answer" });
  assert.equal(evaluateTaskOutput({ status: "completed" }, "not 42", policy).passed, false);
});
