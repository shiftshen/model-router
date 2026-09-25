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

async function fixture(t, { qualify = true, recommendAutomatic, failModel = "", failStatus = 429, failMode = "", primaryProtocol = "chat", approvePaid = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-auto-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let hits = 0;
  const upstream = await listen(http.createServer((request, response) => {
    hits += 1;
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const model = payload.model;
      response.setHeader("content-type", "application/json");
      if (model === failModel) {
        if (failMode === "partial-stream" && payload.stream) {
          response.setHeader("content-type", "text/event-stream");
          response.write(primaryProtocol === "responses"
            ? 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"PARTIAL_FROM_FAILED_MODEL"}\n\n'
            : `data: ${JSON.stringify({ model, choices: [{ delta: { content: "PARTIAL_FROM_FAILED_MODEL" } }] })}\n\n`);
          response.end();
          return;
        }
        if (failMode === "missing-tool" && payload.stream) {
          response.setHeader("content-type", "text/event-stream");
          response.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { model, output: [{ type: "message", content: [{ type: "output_text", text: "No tool" }] }] } })}\n\n`);
          return;
        }
        response.statusCode = failStatus;
        response.end(JSON.stringify({ error: { message: failStatus === 429 ? "insufficient_quota" : failStatus === 404 ? `No endpoints found for ${model}.` : "temporary outage" } }));
      } else {
        const message = payload.tool_choice === "required"
          ? { content: null, tool_calls: [{ id: "call_step", type: "function", function: { name: "report_step", arguments: '{"step":"ROUTED"}' } }] }
          : { content: JSON.stringify(payload).includes("MODEL_ASSISTANT_OK") ? "MODEL_ASSISTANT_OK" : "ROUTED" };
        response.end(JSON.stringify({ model, choices: [{ message }], usage: {} }));
      }
    });
  }), t);
  const store = new ModelStore(root);
  await store.read();
  await store.save({ id: "real", name: "真实模型", endpoint: upstream, protocol: primaryProtocol, model: "real-model", credentialID: "real", contextWindow: 128000 }, 1, "test-key");
  const route = await store.route("real");
  if (approvePaid) await fs.writeFile(path.join(root, "auto-routing-runtime.json"), JSON.stringify({ autoApprovedPaidRoutes: ["real", "backup"] }));
  if (qualify) {
    await fs.mkdir(path.join(root, "checks"));
    await fs.mkdir(path.join(root, "validation"));
    await fs.writeFile(path.join(root, "checks", "real.json"), JSON.stringify({ ok: true, testedAt: new Date().toISOString(), endpoint: route.endpoint, model: route.model, protocol: route.protocol, credentialVersion: await store.credentialVersion(route.credentialID) }));
    await fs.writeFile(path.join(root, "validation", "real.json"), JSON.stringify({ mode: "live", score: 95, testedAt: new Date().toISOString(), routeId: route.id, model: route.model, endpoint: route.endpoint, protocol: route.protocol, credentialVersion: await store.credentialVersion(route.credentialID), byCategory: { planning: 100, backend: 100 } }));
  }
  const gateway = await listen(createGateway(store, { recommendAutomatic }), t);
  const send = async (model, stream = false, extra = {}) => {
    const response = await fetch(`${gateway}/router/v1/responses`, {
      method: "POST", headers: { authorization: `Bearer ${await store.token("router")}`, "content-type": "application/json" },
      body: JSON.stringify({ model, input: "Please design an API endpoint", stream, ...extra }),
    });
    return { status: response.status, body: stream ? await response.text() : await response.json() };
  };
  return { send, hits: () => hits, route, root, store, upstream };
}

test("explicit model bypasses automatic recommender", async (t) => {
  const app = await fixture(t, { qualify: false, recommendAutomatic: async () => { throw new Error("must not run"); } });
  const result = await app.send(app.route.routerSlug);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(app.hits(), 1);
});

test("gateway auto refuses an unapproved paid model without contacting upstream", async (t) => {
  const app = await fixture(t, { approvePaid: false });
  const result = await app.send(automaticModelSlug);
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, "auto_no_budget_model");
  assert.equal(app.hits(), 0);
  assert.equal((await app.send(app.route.routerSlug)).status, 200, "explicit manual selection remains available");
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

test("gateway auto performs a real lightweight check when the old check expired", async (t) => {
  const app = await fixture(t);
  const file = path.join(app.root, "checks", "real.json");
  const check = JSON.parse(await fs.readFile(file, "utf8"));
  await fs.writeFile(file, JSON.stringify({ ...check, testedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }));
  const result = await app.send(automaticModelSlug);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(app.hits(), 2, "one availability probe and one actual task call");
  assert.ok(Date.now() - Date.parse(JSON.parse(await fs.readFile(file, "utf8")).testedAt) < 60_000);
});

test("auto retries a different qualified model after primary quota failure", async (t) => {
  const app = await fixture(t, { failModel: "real-model", recommendAutomatic: async ({ candidates }) => ({
    mode: "advisory", status: "resolved",
    selected: (() => { const item = candidates.find((candidate) => candidate.provider === "real") ?? candidates[0]; return { id: item.id, modelId: item.modelId, provider: item.provider }; })(), roles: [],
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
  const second = await app.send(automaticModelSlug);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(app.hits(), 3, "next turn should skip the exhausted primary instead of charging another failed attempt");
  const nextLog = JSON.parse(await fs.readFile(path.join(app.root, "route-log.json"), "utf8"));
  assert.equal(nextLog[2].route, backup.id);
  assert.equal(nextLog[2].fallback, false);
});

test("temporary HTTP 503 also fails over and cools down on the next turn", async (t) => {
  const app = await fixture(t, { failModel: "real-model", failStatus: 503, recommendAutomatic: async ({ candidates }) => {
    const item = candidates.find((candidate) => candidate.provider === "real") ?? candidates[0];
    return { mode: "advisory", status: "resolved", selected: { id: item.id, modelId: item.modelId, provider: item.provider }, roles: [] };
  } });
  await app.store.save({ id: "backup", name: "备用", endpoint: app.upstream, protocol: "chat", model: "backup-model", credentialID: "backup", contextWindow: 128000 }, (await app.store.read()).revision, "backup-key");
  const backup = await app.store.route("backup");
  await fs.writeFile(path.join(app.root, "checks", "backup.json"), JSON.stringify({ ok: true, testedAt: new Date().toISOString(), endpoint: backup.endpoint, model: backup.model, protocol: backup.protocol, credentialVersion: await app.store.credentialVersion(backup.credentialID) }));
  await fs.writeFile(path.join(app.root, "validation", "backup.json"), JSON.stringify({ mode: "live", score: 90, testedAt: new Date().toISOString(), routeId: backup.id, model: backup.model, endpoint: backup.endpoint, protocol: backup.protocol, credentialVersion: await app.store.credentialVersion(backup.credentialID), byCategory: { planning: 100, backend: 100 } }));
  assert.equal((await app.send(automaticModelSlug)).status, 200);
  assert.equal((await app.send(automaticModelSlug)).status, 200);
  assert.equal(app.hits(), 3);
  const log = JSON.parse(await fs.readFile(path.join(app.root, "route-log.json"), "utf8"));
  assert.equal(log[2].route, backup.id);
  assert.equal(log[2].fallback, false);
});

test("auto stream switches on no-endpoints 404 and avoids the dead model next turn", async (t) => {
  const app = await fixture(t, { failModel: "real-model", failStatus: 404, recommendAutomatic: async ({ candidates }) => {
    const item = candidates.find((candidate) => candidate.provider === "real") ?? candidates[0];
    return { mode: "advisory", status: "resolved", selected: { id: item.id, modelId: item.modelId, provider: item.provider }, roles: [] };
  } });
  await app.store.save({ id: "backup", name: "合格备用", endpoint: app.upstream, protocol: "chat", model: "backup-model", credentialID: "backup", contextWindow: 128000 }, (await app.store.read()).revision, "backup-key");
  const backup = await app.store.route("backup");
  await fs.writeFile(path.join(app.root, "checks", "backup.json"), JSON.stringify({ ok: true, testedAt: new Date().toISOString(), endpoint: backup.endpoint, model: backup.model, protocol: backup.protocol, credentialVersion: await app.store.credentialVersion(backup.credentialID) }));
  await fs.writeFile(path.join(app.root, "validation", "backup.json"), JSON.stringify({ mode: "live", score: 90, testedAt: new Date().toISOString(), routeId: backup.id, model: backup.model, endpoint: backup.endpoint, protocol: backup.protocol, credentialVersion: await app.store.credentialVersion(backup.credentialID), byCategory: { planning: 100, backend: 100 } }));
  const first = await app.send(automaticModelSlug, true);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.match(first.body, /ROUTED/);
  const log = JSON.parse(await fs.readFile(path.join(app.root, "route-log.json"), "utf8"));
  assert.deepEqual(log.map((entry) => entry.route), ["real", "backup"]);
  assert.deepEqual(log.map((entry) => entry.status), ["failed", "completed"]);
  const failedCheck = JSON.parse(await fs.readFile(path.join(app.root, "checks", "real.json"), "utf8"));
  assert.equal(failedCheck.ok, false);
  assert.equal(failedCheck.reason, "provider_has_no_endpoint");
  const second = await app.send(automaticModelSlug, true);
  assert.equal(second.status, 200);
  assert.equal(app.hits(), 3, "a second auto turn must not retry a model with no endpoint");
});

test("auto stream hides a partial failed answer and switches to a qualified backup", async (t) => {
  const app = await fixture(t, { failModel: "real-model", failMode: "partial-stream", recommendAutomatic: async ({ candidates }) => {
    const item = candidates.find((candidate) => candidate.provider === "real") ?? candidates[0];
    return { mode: "advisory", status: "resolved", selected: { id: item.id, modelId: item.modelId, provider: item.provider }, roles: [] };
  } });
  await app.store.save({ id: "backup", name: "合格备用", endpoint: app.upstream, protocol: "chat", model: "backup-model", credentialID: "backup", contextWindow: 128000 }, (await app.store.read()).revision, "backup-key");
  const backup = await app.store.route("backup");
  await fs.writeFile(path.join(app.root, "checks", "backup.json"), JSON.stringify({ ok: true, testedAt: new Date().toISOString(), endpoint: backup.endpoint, model: backup.model, protocol: backup.protocol, credentialVersion: await app.store.credentialVersion(backup.credentialID) }));
  await fs.writeFile(path.join(app.root, "validation", "backup.json"), JSON.stringify({ mode: "live", score: 90, testedAt: new Date().toISOString(), routeId: backup.id, model: backup.model, endpoint: backup.endpoint, protocol: backup.protocol, credentialVersion: await app.store.credentialVersion(backup.credentialID), byCategory: { planning: 100, backend: 100 } }));
  const result = await app.send(automaticModelSlug, true);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.match(result.body, /ROUTED/);
  assert.doesNotMatch(result.body, /PARTIAL_FROM_FAILED_MODEL/);
});

test("auto Responses stream also hides partial output before switching", async (t) => {
  const app = await fixture(t, { failModel: "real-model", failMode: "partial-stream", primaryProtocol: "responses", recommendAutomatic: async ({ candidates }) => ({ mode: "advisory", status: "resolved", selected: { id: candidates[0].id, modelId: candidates[0].modelId, provider: candidates[0].provider }, roles: [] }) });
  await app.store.save({ id: "backup", name: "合格备用", endpoint: app.upstream, protocol: "chat", model: "backup-model", credentialID: "backup", contextWindow: 128000 }, (await app.store.read()).revision, "backup-key");
  const backup = await app.store.route("backup");
  await fs.writeFile(path.join(app.root, "checks", "backup.json"), JSON.stringify({ ok: true, testedAt: new Date().toISOString(), endpoint: backup.endpoint, model: backup.model, protocol: backup.protocol, credentialVersion: await app.store.credentialVersion(backup.credentialID) }));
  await fs.writeFile(path.join(app.root, "validation", "backup.json"), JSON.stringify({ mode: "live", score: 90, testedAt: new Date().toISOString(), routeId: backup.id, model: backup.model, endpoint: backup.endpoint, protocol: backup.protocol, credentialVersion: await app.store.credentialVersion(backup.credentialID), byCategory: { planning: 100, backend: 100 } }));
  const result = await app.send(automaticModelSlug, true);
  assert.equal(result.status, 200, result.body);
  assert.match(result.body, /ROUTED/);
  assert.doesNotMatch(result.body, /PARTIAL_FROM_FAILED_MODEL/);
});

test("auto Responses stream switches when a required tool call is missing", async (t) => {
  const app = await fixture(t, { failModel: "real-model", failMode: "missing-tool", primaryProtocol: "responses", recommendAutomatic: async ({ candidates }) => ({ mode: "advisory", status: "resolved", selected: { id: candidates[0].id, modelId: candidates[0].modelId, provider: candidates[0].provider }, roles: [] }) });
  const primaryValidation = path.join(app.root, "validation", "real.json");
  const primaryReport = JSON.parse(await fs.readFile(primaryValidation, "utf8"));
  await fs.writeFile(primaryValidation, JSON.stringify({ ...primaryReport, byCategory: { ...primaryReport.byCategory, tool_use: 100 } }));
  await app.store.save({ id: "backup", name: "合格备用", endpoint: app.upstream, protocol: "chat", model: "backup-model", credentialID: "backup", contextWindow: 128000 }, (await app.store.read()).revision, "backup-key");
  const backup = await app.store.route("backup");
  await fs.writeFile(path.join(app.root, "checks", "backup.json"), JSON.stringify({ ok: true, testedAt: new Date().toISOString(), endpoint: backup.endpoint, model: backup.model, protocol: backup.protocol, credentialVersion: await app.store.credentialVersion(backup.credentialID) }));
  await fs.writeFile(path.join(app.root, "validation", "backup.json"), JSON.stringify({ mode: "live", score: 90, testedAt: new Date().toISOString(), routeId: backup.id, model: backup.model, endpoint: backup.endpoint, protocol: backup.protocol, credentialVersion: await app.store.credentialVersion(backup.credentialID), byCategory: { planning: 100, backend: 100, tool_use: 100 } }));
  const result = await app.send(automaticModelSlug, true, {
    tool_choice: "required",
    tools: [{ type: "function", name: "report_step", parameters: { type: "object", properties: { step: { type: "string" } } } }],
  });
  assert.equal(result.status, 200, result.body);
  assert.match(result.body, /ROUTED/);
  assert.doesNotMatch(result.body, /No tool/);
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
