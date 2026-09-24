import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelStore } from "../src/model-store.mjs";
import { automaticModelSlug, profileFromPayload, qualifiedAutomaticCandidates, resolveAutomaticRoute } from "../src/automatic-routing.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "automatic-routing-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ModelStore(root);
  await store.read();
  await store.save({ id: "qualified", name: "已验证", endpoint: "https://example.org/v1", protocol: "chat", model: "upstream-model", credentialID: "qualified" }, 1, "test-key");
  const route = await store.route("qualified");
  await fs.mkdir(path.join(root, "checks"));
  await fs.mkdir(path.join(root, "validation"));
  await fs.writeFile(path.join(root, "checks", "qualified.json"), JSON.stringify({ ok: true, testedAt: new Date().toISOString(), endpoint: route.endpoint, model: route.model, protocol: route.protocol, credentialVersion: await store.credentialVersion(route.credentialID) }));
  await fs.writeFile(path.join(root, "validation", "qualified.json"), JSON.stringify({ mode: "live", score: 95, testedAt: new Date().toISOString(), routeId: route.id, model: route.model, endpoint: route.endpoint, protocol: route.protocol, credentialVersion: await store.credentialVersion(route.credentialID), byCategory: { planning: 100, backend: 100, debugging: 100, tool_use: 100, long_context: 100 } }));
  return { store, route, root };
}

test("profile only exposes fixed task labels, never prompt or history", () => {
  const marker = "PRIVATE_PROMPT_MARKER";
  const result = profileFromPayload({ input: [{ role: "user", content: [{ type: "input_text", text: `修复 API ${marker}` }] }] });
  assert.equal(result.category, "debugging");
  assert.deepEqual(result.profile.requiredCapabilities, ["coding", "debugging"]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROMPT_MARKER/);
});

test("simple arithmetic, planning, and Codex tool use have distinct profiles", () => {
  const simple = profileFromPayload({ input: "What is 1+1? Reply with only the number." });
  assert.equal(simple.profile.difficulty, "simple");
  assert.equal(simple.category, "general");
  const planning = profileFromPayload({ input: "Plan the architecture for an API", tools: [{ type: "function", name: "shell" }] });
  assert.equal(planning.category, "planning");
  assert.equal(planning.profile.difficulty, "hard");
  assert.deepEqual(planning.requiredCategories, ["planning", "tool_use"]);
  const architecture = profileFromPayload({ input: "规划复杂项目架构" });
  assert.equal(architecture.category, "planning");
});

test("large repeated Codex tool schemas do not turn a short turn into unproven long context", () => {
  const payload = {
    input: [{ role: "user", content: [{ type: "input_text", text: "What is 1+1?" }] }],
    tools: [{ type: "function", name: "shell", description: "tool schema ".repeat(40000) }],
    __bytes: 500000,
  };
  const result = profileFromPayload(payload);
  assert.equal(result.profile.difficulty, "simple");
  assert.deepEqual(result.requiredCategories, ["tool_use"]);
  assert.ok(result.profile.contextRequirement < 100);
});

test("candidate requires current check, live validation, category score and credential", async (t) => {
  const { store, root } = await fixture(t);
  assert.equal((await qualifiedAutomaticCandidates(store, ["backend"])).length, 1);
  const file = path.join(root, "validation", "qualified.json");
  const validation = JSON.parse(await fs.readFile(file, "utf8"));
  validation.byCategory.backend = 79;
  await fs.writeFile(file, JSON.stringify(validation));
  assert.equal((await qualifiedAutomaticCandidates(store, ["backend"])).length, 0);
  validation.byCategory.backend = 100;
  await fs.writeFile(file, JSON.stringify(validation));
  await store.writeSecret("qualified", "rotated-key");
  assert.equal((await qualifiedAutomaticCandidates(store, ["backend"])).length, 0);
});

test("one verified primary needs no external decision service", async (t) => {
  const { store, route } = await fixture(t);
  const result = await resolveAutomaticRoute(store, { model: automaticModelSlug, input: "Implement a backend endpoint" });
  assert.equal(result.route.id, route.id);
  assert.equal(result.provenance.selectedBy, "single_qualified");
});

test("hard tasks need overall quality, quota failures stay excluded, long context is not inferred", async (t) => {
  const { store, root, route } = await fixture(t);
  const file = path.join(root, "validation", "qualified.json");
  const validation = JSON.parse(await fs.readFile(file, "utf8"));
  validation.score = 65;
  await fs.writeFile(file, JSON.stringify(validation));
  assert.equal((await qualifiedAutomaticCandidates(store, ["backend"], { difficulty: "hard" })).length, 0);
  assert.equal((await qualifiedAutomaticCandidates(store, ["backend"], { difficulty: "simple" })).length, 1);
  validation.score = 95;
  await fs.writeFile(file, JSON.stringify(validation));
  assert.equal((await qualifiedAutomaticCandidates(store, ["long_context"], { difficulty: "hard" })).length, 0);
  await fs.writeFile(path.join(root, "route-log.json"), JSON.stringify([{ route: route.id, at: new Date().toISOString(), status: "failed", error: "insufficient_quota" }]));
  assert.equal((await qualifiedAutomaticCandidates(store, ["backend"], { difficulty: "hard" })).length, 0);
});

test("resolved route must match candidate slug, upstream model and provider; multiple roles fail", async (t) => {
  const { store, route } = await fixture(t);
  const payload = { model: automaticModelSlug, input: "Please inspect API endpoint" };
  const result = await resolveAutomaticRoute(store, payload, { recommendAutomatic: async (input) => {
    assert.equal(JSON.stringify(input).includes("Please inspect"), false);
    return { mode: "advisory", status: "resolved", selected: { id: input.candidates[0].id, modelId: input.candidates[0].modelId, provider: input.candidates[0].provider }, roles: [], provenance: { selectedBy: "jev" } };
  } });
  assert.equal(result.route.id, route.id);
  assert.equal(result.slug, route.routerSlug);
  assert.equal(result.provenance.selectedBy, "jev");
  await assert.rejects(resolveAutomaticRoute(store, payload, { recommendAutomatic: async () => ({ mode: "advisory", status: "resolved", selected: { id: route.routerSlug, modelId: route.model, provider: "wrong" }, roles: [] }) }), { code: "auto_selection_mismatch" });
  await assert.rejects(resolveAutomaticRoute(store, payload, { recommendAutomatic: async () => ({ mode: "advisory", status: "resolved", selected: { id: route.routerSlug, modelId: route.model, provider: route.id }, roles: [{ role: "review" }, { role: "execution" }] }) }), { code: "auto_no_single_model" });
});

test("two Engine roles may share one model, but conflicting role models are rejected", async (t) => {
  const { store, route } = await fixture(t);
  const payload = { model: automaticModelSlug, input: "Debug API error" };
  const selected = { id: route.routerSlug, modelId: route.model, provider: route.id };
  const same = await resolveAutomaticRoute(store, payload, { recommendAutomatic: async () => ({
    mode: "advisory", status: "resolved", selected: null,
    roles: [{ decision: { selected } }, { decision: { selected: { ...selected } } }],
  }) });
  assert.equal(same.route.id, route.id);
  await assert.rejects(resolveAutomaticRoute(store, payload, { recommendAutomatic: async () => ({
    mode: "advisory", status: "resolved", selected: null,
    roles: [{ decision: { selected } }, { decision: { selected: { ...selected, modelId: "other" } } }],
  }) }), { code: "auto_no_single_model" });
});
