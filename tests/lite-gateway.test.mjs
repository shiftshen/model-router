import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { ModelStore } from "../src/model-store.mjs";
import { createGateway } from "../src/model-gateway.mjs";

async function listen(server, context) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("Full Codex 请求切到本地 Lite route 时，gateway 上游前必须删除巨大 namespace tools", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cma-lite-gateway-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ModelStore(root);

  let captured = null;
  const upstreamURL = await listen(http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    captured = JSON.parse(raw);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{ message: { content: "LITE_OK" } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }));
  }), context);

  const data = await store.read();
  await store.save({
    id: "local-lite-gateway",
    name: "Local Lite",
    vendor: "local",
    endpoint: upstreamURL,
    protocol: "chat",
    model: "local-model",
    noKey: true,
    runtimeProfile: "auto",
    contextWindow: 65536,
  }, data.revision);

  const gatewayURL = await listen(createGateway(store), context);
  const token = await store.token("local-lite-gateway");
  const response = await fetch(`${gatewayURL}/routes/local-lite-gateway/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      model: "local-model",
      stream: false,
      tools: [
        { type: "namespace", name: "mcp__codex_apps__adobe", tools: [{ type: "function", name: "huge", parameters: { type: "object", properties: { x: { type: "string", description: "x".repeat(50000) } } } }] },
        { type: "namespace", name: "mcp__codex_apps__webcodex", tools: [{ type: "function", name: "run", parameters: { type: "object" } }] },
        { type: "function", name: "exec_command", description: "run shell", parameters: { type: "object", properties: { cmd: { type: "string" } } } },
        { type: "function", name: "request_plugin_install", parameters: { type: "object" } },
        { type: "custom", name: "apply_patch" },
      ],
      input: [
        { role: "developer", content: [
          { type: "input_text", text: "<apps_instructions>huge apps metadata</apps_instructions>" },
          { type: "input_text", text: "<permissions instructions>keep</permissions instructions>" },
        ] },
        { role: "user", content: [
          { type: "input_text", text: "<recommended_plugins>gmail drive</recommended_plugins>" },
          { type: "input_text", text: "你好" },
        ] },
      ],
    }),
  });
  assert.equal(response.status, 200);
  assert.ok(captured);
  assert.deepEqual(captured.tools.map((tool) => tool.function.name), ["exec_command", "apply_patch"]);
  const text = JSON.stringify(captured.messages);
  assert.doesNotMatch(text, /apps_instructions|recommended_plugins|mcp__codex_apps/);
  assert.match(text, /permissions instructions/);
  assert.match(text, /你好/);
});
