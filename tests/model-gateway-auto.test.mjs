import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { ModelStore } from "../src/model-store.mjs";
import { createGateway } from "../src/model-gateway.mjs";
import { automaticModelSlug } from "../src/automatic-routing.mjs";

async function listen(server, t) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, { qualify = true, recommendAutomatic, failModel = "" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-auto-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let hits = 0;
  const upstream = await listen(http.createServer((request, response) => {
    hits += 1;
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const model = JSON.parse(Buffer.concat(chunks).toString("utf8")).model;
      response.setHeader("content-type", "application/json");
      if (model === failModel) {
        response.statusCode = 429;
        response.end(JSON.stringify({ error: { message: "insufficient_quota" } }));
      } else response.end(JSON.stringify({ model, choices: [{ message: { content: "ROUTED" } }], usage: {} }));
    });
  }), t);
  const store = new ModelStore(root);
  await store.read();
  await store.save({ id: "real", name: "真实模型", endpoint: upstream, protocol: "chat", model: "real-model", credentialID: "real", contextWindow: 128000 }, 1, "test-key");
  const route = await store.route("real");
  if (qualify) {
    await fs.mkdir(path.join(root, "checks"));
    await fs.mkdir(path.join(root, "validation"));
    await fs.writeFile(path.join(root, "checks", "real.json"), JSON.stringify({ ok: true, testedAt: new Date().toISOString(), endpoint: route.endpoint, model: route.model, protocol: route.protocol, credentialVersion: await store.credentialVersion(route.credentialID) }));
    await fs.writeFile(path.join(root, "validation", "real.json"), JSON.stringify({ mode: "live", score: 95, testedAt: new Date().toISOString(), routeId: route.id, model: route.model, endpoint: route.endpoint, protocol: route.protocol, credentialVersion: await store.credentialVersion(route.credentialID), byCategory: { planning: 100, backend: 100 } }));
  }
  const gateway = await listen(createGateway(store, { recommendAutomatic }), t);
  const send = async (model) => {
    const response = await fetch(`${gateway}/router/v1/responses`, {
      method: "POST", headers: { authorization: `Bearer ${await store.token("router")}`, "content-type": "application/json" },
      body: JSON.stringify({ model, input: "Please design an API endpoint", stream: false }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { send, hits: () => hits, route, root, store, upstream };
}

test("explicit model bypasses automatic recommender", async (t) => {
  const app = await fixture(t, { qualify: false, recommendAutomatic: async () => { throw new Error("must not run"); } });
  const result = await app.send(app.route.routerSlug);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(app.hits(), 1);
});

test("auto resolves qualified model and records requested and actual route", async (t) => {
  let called = 0;
  const app = await fixture(t, { recommendAutomatic: async ({ candidates }) => {
    called += 1;
    return { mode: "advisory", status: "resolved", selected: { id: candidates[0].id, modelId: candidates[0].modelId, provider: candidates[0].provider }, roles: [], provenance: { primary: "laya_typed", selectedBy: "jev_fallback" } };
  } });
  const result = await app.send(automaticModelSlug);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(app.hits(), 1);
  assert.equal(called, 1);
  const log = JSON.parse(await fs.readFile(path.join(app.root, "route-log.json"), "utf8"));
  assert.equal(log[0].requestedModel, automaticModelSlug);
  assert.equal(log[0].route, app.route.id);
  assert.equal(log[0].model, app.route.model);
  assert.equal(log[0].decision.selectedBy, "jev_fallback");
  assert.equal(log[0].status, "completed");
});

test("auto retries a different qualified model after primary quota failure", async (t) => {
  const app = await fixture(t, { failModel: "real-model", recommendAutomatic: async ({ candidates }) => ({
    mode: "advisory", status: "resolved",
    selected: { id: candidates.find((item) => item.provider === "real").id, modelId: "real-model", provider: "real" }, roles: [],
  }) });
  await app.store.save({ id: "backup", name: "合格备用", endpoint: app.upstream, protocol: "chat", model: "backup-model", credentialID: "backup", contextWindow: 128000 }, (await app.store.read()).revision, "backup-key");
  const backup = await app.store.route("backup");
  await fs.writeFile(path.join(app.root, "checks", "backup.json"), JSON.stringify({ ok: true, testedAt: new Date().toISOString(), endpoint: backup.endpoint, model: backup.model, protocol: backup.protocol, credentialVersion: await app.store.credentialVersion(backup.credentialID) }));
  await fs.writeFile(path.join(app.root, "validation", "backup.json"), JSON.stringify({ mode: "live", score: 90, testedAt: new Date().toISOString(), routeId: backup.id, model: backup.model, endpoint: backup.endpoint, protocol: backup.protocol, credentialVersion: await app.store.credentialVersion(backup.credentialID), byCategory: { planning: 100, backend: 100 } }));
  const result = await app.send(automaticModelSlug);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(app.hits(), 2);
  const log = JSON.parse(await fs.readFile(path.join(app.root, "route-log.json"), "utf8"));
  assert.equal(log[0].status, "failed");
  assert.equal(log[1].status, "completed");
  assert.equal(log[1].route, backup.id);
  assert.equal(log[1].fallback, true);
  assert.match(log[1].decision.fallbackReason, /insufficient_quota/);
});

test("unqualified model and missing engine reject auto without upstream call", async (t) => {
  const unqualified = await fixture(t, { qualify: false, recommendAutomatic: async () => { throw new Error("must not run"); } });
  const first = await unqualified.send(automaticModelSlug);
  assert.equal(first.status, 409);
  assert.equal(first.body.error.code, "auto_no_qualified_model");
  assert.equal(unqualified.hits(), 0);
  const noEngine = await fixture(t, { qualify: true, recommendAutomatic: async () => { throw new Error("missing engine"); } });
  const second = await noEngine.send(automaticModelSlug);
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, "auto_engine_unavailable");
  assert.equal(noEngine.hits(), 0);
});
