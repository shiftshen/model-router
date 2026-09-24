import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { ModelStore } from "../src/model-store.mjs";
import { createCoreConsole } from "../src/core-console.mjs";

test("core console manages local credentials and revocable agent proxy keys", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "model-router-core-"));
  const store = new ModelStore(root);
  const upstream = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${gatewayKey}`) { res.writeHead(401); return res.end(); }
    res.setHeader("content-type", "application/json");
    res.end(req.url.endsWith("models") ? JSON.stringify({ data: [{ id: "sample" }] }) : JSON.stringify({ model: "sample", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }));
  });
  const gatewayKey = await store.token("router");
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const consoleServer = createCoreConsole(store, { port: 0, gateway: `http://127.0.0.1:${upstream.address().port}` });
  try {
    const address = await consoleServer.start();
    const base = address.split("/#")[0];
    const admin = address.split("/#")[1];
    const call = (url, token, method = "GET", data) => fetch(base + url, { method, headers: { authorization: `Bearer ${token}`, ...(data ? { "content-type": "application/json" } : {}) }, body: data ? JSON.stringify(data) : undefined });
    const html = await (await fetch(base)).text();
    assert.doesNotThrow(() => new Function(html.split("<script>")[1].split("</script>")[0]));
    assert.equal((await call("/api/status", "wrong")).status, 401);
    assert.equal((await call("/api/status", admin)).status, 200);
    const created = await (await call("/api/agents", admin, "POST", { id: "codex" })).json();
    assert.match(created.key, /^mr-[0-9a-f]{64}$/);
    const agentsFile = await fs.readFile(path.join(root, "core-agents.json"), "utf8");
    assert.equal(agentsFile.includes(created.key), false);
    assert.deepEqual((await (await call("/v1/models", created.key)).json()).data, [{ id: "sample" }]);
    const task = await call("/v1/responses", created.key, "POST", { model: "sample", input: "hello" });
    assert.equal(task.status, 200);
    assert.equal((await task.json()).model, "sample");
    const usage = (await (await call("/api/status", admin)).json()).agentUsage;
    assert.equal(usage[new Date().toISOString().slice(0, 10)].codex.requests, 1);
    const route = (await store.read()).routes.find((entry) => entry.id === "deepseek-flash");
    assert.equal((await call(`/api/credentials/${route.id}`, admin, "PUT", { secret: "test-key" })).status, 200);
    assert.equal(await store.secret(route.credentialID), "test-key");
    assert.equal((await call(`/api/agents/codex`, admin, "DELETE")).status, 200);
    assert.equal((await call("/v1/models", created.key)).status, 401);
    const denied = await fetch(base + "/api/status", { headers: { authorization: `Bearer ${admin}`, origin: "https://evil.example" } });
    assert.equal(denied.status, 403);
  } finally {
    await consoleServer.close();
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
