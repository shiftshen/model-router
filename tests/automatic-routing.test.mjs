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
  await fs.writeFile(path.join(root, "validation", "qualified.json"), JSON.stringify({ mode: "live", testedAt: new Date().toISOString(), routeId: route.id, model: route.model, endpoint: route.endpoint, protocol: route.protocol, credentialVersion: await store.credentialVersion(route.credentialID), byCategory: { planning: 100, backend: 100, debugging: 100, long_context: 100 } }));
  return { store, route, root };
}

test("profile only exposes fixed task labels, never prompt or history", () => {
  const marker = "PRIVATE_PROMPT_MARKER";
  const result = profileFromPayload({ input: [{ role: "user", content: [{ type: "input_text", text: `修复 API ${marker}` }] }] });
  assert.equal(result.category, "debugging");
  assert.deepEqual(result.profile.requiredCapabilities, ["coding", "debugging"]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROMPT_MARKER/);
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
