import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { ModelStore, validateRoute, atomicJSON } from "../src/model-store.mjs";
import { ProductService, renderProductConfig, renderRouterConfig, resolveRuntimeProfile } from "../src/product-service.mjs";
import { toChat, toAnthropic, fromCompletion, responseEvents, nativePayload } from "../src/protocol-adapter.mjs";
import { createGateway, upstream, estimateTokens, contextBudget } from "../src/model-gateway.mjs";
import { staleDays } from "../src/disk-cleanup.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isWindowsTest, sqliteTestBinary } from "./test-platform.mjs";

const execFileAsync = promisify(execFile);

// 造一个够真实的窗口任务库：disk-cleanup 要按 id/rollout_path/updated_at/archived/title 判断副本。
async function seedThreads(home, entries) {
  const db = path.join(home, "state_5.sqlite");
  await fs.mkdir(path.dirname(db), { recursive: true });
  await execFileAsync(sqliteTestBinary, [db, [
    "create table if not exists threads (id text primary key, rollout_path text, created_at integer, updated_at integer, source text, model_provider text, cwd text, title text, sandbox_policy text, approval_mode text, archived integer not null default 0, model text, reasoning_effort text);",
    "create table if not exists thread_attachments (thread_id text);",
    "create table if not exists thread_dynamic_tools (thread_id text);",
  ].join("\n")]);
  for (const entry of entries) {
    const file = path.join(home, "sessions", `${entry.id}.jsonl`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "x".repeat(entry.bytes ?? 64));
    await execFileAsync(sqliteTestBinary, [db, `insert or replace into threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, archived, model) values ('${entry.id}', '${file}', ${entry.updatedAt}, ${entry.updatedAt}, 'cli', 'cma_router', '/tmp', '会话 ${entry.id}', 'danger-full-access', 'never', ${entry.archived ?? 0}, 'deepseek-flash');`]);
  }
  return db;
}

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cma-product-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return new ModelStore(root);
}

test("seeds mainstream providers without pretending keys exist", async (context) => {
  const store = await fixture(context);
  const data = await store.publicData();
  assert.equal(data.routes.length, 18);
  assert.equal(data.templates.length, 14);
  assert.ok(data.routes.every((route) => !route.hasKey));
  assert.equal(data.routes.find((route) => route.id === "deepseek-flash").endpoint, "https://api.deepseek.com/v1");
  assert.ok(data.routes.filter((route) => route.id.startsWith("s5090-")).every((route) => route.protocol === "chat"));
  assert.equal(data.routes.find((route) => route.id === "official").name, "ChatGPT Desktop（官方）");
  assert.equal(data.routes.find((route) => route.id === "official").model, "");
});

test("Codex 环境 Auto：本地无 Key 默认 Lite，云端 Full，显式设置优先", () => {
  const local = validateRoute({ id:"local-lite", name:"Local", vendor:"local", endpoint:"http://127.0.0.1:18081/v1", protocol:"chat", model:"m", noKey:true, runtimeProfile:"auto" });
  const cloud = validateRoute({ id:"cloud-full", name:"Cloud", vendor:"cloud", endpoint:"https://api.example.com/v1", protocol:"chat", model:"m", noKey:false, runtimeProfile:"auto" });
  assert.equal(resolveRuntimeProfile(local), "lite");
  assert.equal(resolveRuntimeProfile(cloud), "full");
  assert.equal(resolveRuntimeProfile({ ...local, runtimeProfile:"full" }), "full");
  assert.equal(resolveRuntimeProfile({ ...cloud, runtimeProfile:"lite" }), "lite");
  assert.throws(() => validateRoute({ ...local, runtimeProfile:"turbo" }), /Codex 环境/);
});

test("Lite 配置不继承全局 Plugins/MCP/Skills/Agents/Projects，只保留顶层基础参数与当前 provider", () => {
  const source = `model = "gpt-5.6-sol"\nmodel_reasoning_effort = "medium"\nplan_mode_reasoning_effort = "medium"\n\n[agents]\nenabled = true\n\n[projects."/tmp/demo"]\ntrust_level = "trusted"\n\n[plugins."browser"]\nenabled = true\n\n[mcp_servers.playwright]\ncommand = "npx"\n`;
  const route = validateRoute({ id:"lite-route", name:"Lite", vendor:"local", endpoint:"http://127.0.0.1:18081/v1", protocol:"chat", model:"ternary-bonsai-2-27b", noKey:true, runtimeProfile:"auto" });
  const output = renderProductConfig(source, route, "/tmp/catalog.json");
  assert.match(output, /^model_reasoning_effort = "medium"$/m);
  assert.doesNotMatch(output, /^plan_mode_reasoning_effort/m);
  assert.ok(Buffer.byteLength(output) < 2048);
  assert.equal((output.match(/^\[/gm) || []).length, 2);
  assert.match(output, /\[model_providers\.cma_lite_route\]/);
  assert.doesNotMatch(output, /\[agents\]/);
  assert.doesNotMatch(output, /\[projects\./);
  assert.doesNotMatch(output, /\[plugins\./);
  assert.doesNotMatch(output, /\[mcp_servers\./);

  const router = renderRouterConfig(source, { model:"ternary-bonsai-2-27b", catalogPath:"/tmp/catalog.json", runtimeProfile:"lite" });
  assert.doesNotMatch(router, /\[agents\]|\[plugins\.|\[mcp_servers\.|\[projects\./);
  assert.match(router, /\[model_providers\.cma_router\]/);
});

test("升级会自动删除旧 official-gpt-* 代理，只保留唯一的 ChatGPT Desktop 官方入口", async (context) => {
  const store = await fixture(context);
  const data = await store.read();
  const oldOfficial = validateRoute({
    id: "official-gpt-5-6-sol",
    name: "官方 · GPT-5.6 Sol",
    vendor: "OpenAI（官方登录）",
    protocol: "chatgpt",
    model: "gpt-5.6-sol",
    hidden: true,
  });
  const deepseek = data.routes.find((route) => route.id === "deepseek-flash");
  data.routes.push(oldOfficial);
  data.routes[data.routes.findIndex((route) => route.id === deepseek.id)] = { ...deepseek, fallback: oldOfficial.id };
  await atomicJSON(store.file, data);

  const migrated = await store.read();
  assert.equal(migrated.routes.some((route) => route.id === oldOfficial.id), false);
  assert.equal(migrated.routes.find((route) => route.id === "deepseek-flash").fallback, "");
  const official = migrated.routes.find((route) => route.id === "official");
  assert.equal(official.name, "ChatGPT Desktop（官方）");
  assert.equal(official.model, "");
  assert.equal(official.endpoint, "");
  assert.equal(official.vendor, "OpenAI 官方");
  assert.equal(official.switchable, false);
  assert.ok(migrated.revision > data.revision);
  const backups = await fs.readdir(path.join(store.root, "backups"));
  assert.ok(backups.some((name) => name.startsWith("library-before-official-cleanup-")));
});

test("local chat bridge preserves MCP namespace, call and result history", () => {
  const tool = { type: "namespace", name: "mcp__paid_expert", tools: [{ type: "function", name: "consult_expert", parameters: { type: "object", properties: {} } }] };
  const converted = toChat({ model: "local", tools: [tool], input: [{ type: "function_call", namespace: "mcp__paid_expert", name: "consult_expert", call_id: "expert1", arguments: "{}" }, { type: "function_call_output", call_id: "expert1", output: "Advice" }] });
  assert.equal(converted.body.tools[0].function.name, "mcp__paid_expert__consult_expert");
  assert.equal(converted.body.messages[0].tool_calls[0].function.name, "mcp__paid_expert__consult_expert");
  assert.equal(converted.body.messages[1].tool_call_id, "expert1");
  const result = fromCompletion({ choices: [{ message: { tool_calls: converted.body.messages[0].tool_calls } }] }, converted.definitions, "chat", "local");
  assert.equal(result.output[0].namespace, "mcp__paid_expert");
  assert.equal(result.output[0].name, "consult_expert");
});

test("key changes stay private, empty keeps key, clearing removes it", async (context) => {
  const store = await fixture(context);
  const data = await store.read();
  const route = data.routes.find((entry) => entry.id === "deepseek-flash");
  await store.save(route, data.revision, "test-private-value");
  assert.equal(await store.secret("deepseek"), "test-private-value");
  await store.save({ ...route, name: "Updated" }, 2, "");
  assert.equal(await store.secret("deepseek"), "test-private-value");
  if (!isWindowsTest) assert.equal((await fs.stat(path.join(store.root, "credentials/deepseek"))).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(await store.publicData()).includes("test-private-value"));
  for (const file of await fs.readdir(path.join(store.root, "backups"))) assert.ok(!(await fs.readFile(path.join(store.root, "backups", file), "utf8")).includes("test-private-value"));
  await store.save(route, 3, "", true);
  assert.equal(await store.secret("deepseek"), "");
});

test("missing aliases in discovery are advisory rather than a model rejection", async (context) => {
  const store = await fixture(context);
  const server = http.createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "deepseek-v4-flash-ga-260731" }] }));
      return;
    }
    if (request.url === "/v1/responses") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "MODEL_ASSISTANT_OK" }] }] }));
      return;
    }
    response.writeHead(404).end();
  });
  const endpoint = await listen(server, context);
  const data = await store.read();
  const route = validateRoute({ id: "coding-plan", name: "Coding Plan", vendor: "Provider", endpoint: `${endpoint}/v1`, protocol: "responses", model: "deepseek-v4-flash", credentialID: "coding-plan" });
  await store.save(route, data.revision, "test-key");
  const service = new ProductService(store);
  const result = await service.check(route.id);
  assert.match(result.message, /连接正常/);
  assert.match(result.message, /真实推理请求/);
});

test("editing or adding a different endpoint never reuses original credentials", async (context) => {
  const store = await fixture(context);
  const route = (await store.read()).routes.find((entry) => entry.id === "deepseek-flash");
  await store.save(route, 1, "original-private-value");
  await store.save({ ...route, endpoint: "https://example.org/v1" }, 2);
  assert.notEqual((await store.route(route.id)).credentialID, "deepseek");
  assert.equal(await store.secret((await store.route(route.id)).credentialID), "");
  await store.save({ ...route, id: "new-route", endpoint: "https://example.net/v1" }, 3);
  assert.notEqual((await store.route("new-route")).credentialID, "deepseek");
});

test("concurrent stale edits are rejected without losing data", async (context) => {
  const store = await fixture(context);
  const route = (await store.read()).routes[1];
  await store.save({ ...route, name: "First writer" }, 1);
  await assert.rejects(store.save({ ...route, name: "Lost update" }, 1), /另一窗口更新/);
  assert.equal((await store.route(route.id)).name, "First writer");
});

test("archive is reversible and official recovery is protected", async (context) => {
  const store = await fixture(context);
  const route = (await store.read()).routes[1];
  await store.save({ ...route, archived: true }, 1);
  assert.equal((await store.route(route.id)).archived, true);
  await store.save({ ...route, archived: false }, 2);
  assert.equal((await store.route(route.id)).archived, false);
  assert.equal(validateRoute({ ...(await store.route("official")), archived: true }).archived, false);
  const normalizedOfficial = validateRoute({ ...(JSON.parse(JSON.stringify(route))), id: "official", name: "ChatGPT Desktop（官方）", protocol: "oauth", model: "agnes-2.5-flash" });
  assert.equal(normalizedOfficial.model, "");
  assert.equal(normalizedOfficial.endpoint, "");
});

test("imports cannot overwrite routes or bind existing credentials", async (context) => {
  const store = await fixture(context);
  const before = await store.read();
  const service = new ProductService(store);
  await service.importLibrary(before, 1);
  const after = await store.read();
  assert.equal(after.routes.length, before.routes.length * 2 - 1);
  assert.ok(after.routes.slice(before.routes.length).every((route) => route.id === route.credentialID));
});

test("rejects traversal, URL credentials, nonlocal cleartext and malformed fields", () => {
  const base = { id: "test", name: "Test", endpoint: "https://api.example.com/v1", protocol: "chat", model: "demo" };
  for (const invalid of [{ id: "../escape" }, { endpoint: "http://api.example.com/v1" }, { endpoint: "https://user:secret@example.com" }, { endpoint: "https://api.example.com?key=secret" }, { contextWindow: 3000000 }, { model: "model\nattack" }]) assert.throws(() => validateRoute({ ...base, ...invalid }));
  assert.equal(validateRoute({ ...base, endpoint: "http://192.168.1.20:11434/v1" }).endpoint, "http://192.168.1.20:11434/v1");
  // 0 / 留空表示「按模型自动匹配」，查不到也要有 512K 兜底，而不是卡在 128K。
  assert.equal(validateRoute({ ...base, contextWindow: 0 }).contextWindow, 512000);
  assert.equal(validateRoute({ ...base }).contextWindow, 512000);
});

test("dynamic config is idempotent, isolates provider, preserves project settings", () => {
  const route = validateRoute({ id: "test", name: "Test", endpoint: "https://example.com/v1", protocol: "chat", model: "test-model" });
  const source = 'model = "old"\nservice_tier = "priority"\n[projects."/workspace"]\ntrust_level = "trusted"\n';
  const rendered = renderProductConfig(source, route, "/tmp/catalog.json");
  assert.match(rendered, /model_provider = "cma_test"/);
  assert.match(rendered, /trust_level = "trusted"/);
  assert.ok(!rendered.includes("priority"));
  assert.equal(renderProductConfig(rendered, route, "/tmp/catalog.json"), rendered);
  assert.ok(!renderProductConfig(rendered, { ...route, id: "official", protocol: "oauth" }, "").includes("CMA_ROUTE_TOKEN"));
});

test("Chat bridge preserves function calls, namespaces, custom patch input and outputs", () => {
  const payload = { model: "test", tools: [{ type: "namespace", name: "functions", tools: [{ type: "function", name: "exec", parameters: { type: "object" } }] }, { type: "custom", name: "apply_patch" }], input: [{ type: "function_call", namespace: "functions", name: "exec", call_id: "call-1", arguments: '{"cmd":"pwd"}' }, { type: "function_call_output", call_id: "call-1", output: "/workspace" }, { type: "custom_tool_call", name: "apply_patch", call_id: "call-2", input: "*** patch" }, { type: "custom_tool_call_output", call_id: "call-2", output: "Done" }] };
  const result = toChat(payload);
  assert.equal(result.body.messages[0].tool_calls[0].function.name, "functions__exec");
  assert.equal(result.body.messages[1].tool_call_id, "call-1");
  assert.equal(JSON.parse(result.body.messages[2].tool_calls[0].function.arguments).input, "*** patch");
  const response = fromCompletion({ choices: [{ message: { tool_calls: [{ id: "new", function: { name: "apply_patch", arguments: '{"input":"*** patch"}' } }] } }] }, result.definitions, "chat", "test");
  assert.equal(response.output[0].type, "custom_tool_call");
  assert.equal(response.output[0].input, "*** patch");
  const events = responseEvents(response);
  assert.match(events, /response.custom_tool_call_input.delta/);
  assert.match(events, /response.completed/);
  assert.equal(nativePayload(payload, "pinned").input.length, 4);
});

test("Anthropic bridge preserves tool use and results with system messages", () => {
  const body = toAnthropic({ model: "test", messages: [{ role: "system", content: "You are helpful" }, { role: "assistant", tool_calls: [{ id: "call", function: { name: "exec", arguments: '{"command":"pwd"}' } }] }, { role: "tool", tool_call_id: "call", content: "/tmp" }] });
  assert.equal(body.system, "You are helpful");
  assert.equal(body.messages[0].content[0].type, "tool_use");
  assert.equal(body.messages[1].content[0].type, "tool_result");
  const response = fromCompletion({ content: [{ type: "text", text: "Done" }], usage: { input_tokens: 3, output_tokens: 2 } }, [], "anthropic", "test");
  assert.equal(response.usage.total_tokens, 5);
  assert.equal(response.output[0].content[0].text, "Done");
});

async function listen(server, context) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("gateway enforces route token and pinned model, bridges real HTTP SSE", async (context) => {
  const store = await fixture(context);
  let requests = 0;
  const upstreamURL = await listen(http.createServer(async (request, response) => {
    requests++;
    assert.equal(request.headers.authorization, "Bearer upstream-secret");
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.equal(JSON.parse(body).model, "test-model");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "MODEL_ASSISTANT_OK" } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }));
  }), context);
  await store.read();
  await store.save({ id: "test-route", name: "Test", endpoint: upstreamURL, protocol: "chat", model: "test-model" }, 1, "upstream-secret");
  const gateway = await listen(createGateway(store), context);
  const endpoint = `${gateway}/routes/test-route/v1/responses`;
  const headers = { "content-type": "application/json", authorization: `Bearer ${await store.token("test-route")}` };
  assert.equal((await fetch(endpoint, { method: "POST", body: "{}" })).status, 401);
  assert.equal((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ model: "wrong" }) })).status, 400);
  assert.equal((await fetch(endpoint, { method: "POST", headers: { ...headers, origin: "https://example.org" }, body: "{}" })).status, 403);
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ model: "test-model", input: "hello", stream: true }) });
  const text = await response.text();
  assert.match(text, /MODEL_ASSISTANT_OK/);
  assert.match(text, /response.output_text.delta/);
  assert.ok(!text.includes("upstream-secret"));
  assert.equal(requests, 1);
});

test("gateway queues local requests and sends heartbeat before completion", async (context) => {
  const store = await fixture(context);
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const target = await listen(http.createServer(async (_request, response) => {
    await blocker;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "done" } }] }));
  }), context);
  await store.read();
  await store.save({ id: "local-a", name: "Local A", endpoint: target, protocol: "chat", model: "same-local", noKey: true }, 1);
  const gateway = await listen(createGateway(store), context);
  const endpoint = `${gateway}/routes/local-a/v1/responses`;
  const headers = { "content-type": "application/json", authorization: `Bearer ${await store.token("local-a")}` };
  const first = fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ model: "same-local", input: "first" }) });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const second = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ model: "same-local", input: "second", stream: true }) });
  assert.equal(second.status, 200);
  const reader = second.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /: waiting/);
  release();
  assert.equal((await first).status, 200);
  let events = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    events += new TextDecoder().decode(chunk.value);
  }
  assert.match(events, /response.completed/);
});

test("verification record invalidates when key changes", async (context) => {
  const store = await fixture(context);
  const route = (await store.read()).routes[1];
  await store.save(route, 1, "old-key");
  await atomicJSON(path.join(store.root, "checks", `${route.id}.json`), { ok: true, testedAt: "2026-09-05", model: route.model, endpoint: route.endpoint, protocol: route.protocol, credentialVersion: await store.credentialVersion(route.credentialID) });
  assert.equal((await store.publicData()).routes[1].verifiedAt, "2026-09-05");
  await store.save(route, 2, "new-key");
  assert.equal((await store.publicData()).routes[1].verifiedAt, null);
});

test("upstream times out, rejects redirect, and redacts vendor error bodies", async (context) => {
  const target = await listen(http.createServer((request, response) => {
    if (request.url === "/slow") return;
    if (request.url === "/redirect") { response.writeHead(302, { location: "https://example.com" }); response.end(); return; }
    response.writeHead(401); response.end("secret-in-vendor-error");
  }), context);
  const route = validateRoute({ id: "timeout", name: "Timeout", endpoint: target, protocol: "chat", model: "test" });
  await assert.rejects(upstream(route, "private", "slow", null, 20), { name: "TimeoutError" });
  await assert.rejects(upstream(route, "private", "redirect", null, 1000));
  await assert.rejects(upstream(route, "private", "denied", null, 1000), (error) => error.status === 401 && !error.message.includes("secret-in-vendor-error"));
});

test("Anthropic gateway authenticates only with provider key and returns tool calls", async (context) => {
  const store = await fixture(context);
  const target = await listen(http.createServer(async (request, response) => {
    assert.equal(request.headers["x-api-key"], "anthropic-private");
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.url, "/v1/messages");
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.equal(JSON.parse(body).tools[0].name, "exec");
    response.end(JSON.stringify({ content: [{ type: "tool_use", id: "tool-1", name: "exec", input: { command: "pwd" } }], usage: { input_tokens: 2, output_tokens: 1 } }));
  }), context);
  await store.read();
  await store.save({ id: "claude-test", name: "Claude", endpoint: `${target}/v1`, protocol: "anthropic", model: "test" }, 1, "anthropic-private");
  const gateway = await listen(createGateway(store), context);
  const result = await fetch(`${gateway}/routes/claude-test/v1/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await store.token("claude-test")}` }, body: JSON.stringify({ model: "test", input: "pwd", tools: [{ type: "function", name: "exec", parameters: { type: "object" } }] }) });
  const data = await result.json();
  assert.equal(data.output[0].name, "exec");
  assert.equal(data.output[0].call_id, "tool-1");
  assert.equal(data.output[0].arguments, '{"command":"pwd"}');
});

test("native Responses proxy preserves tool history and rejects cross-route token", async (context) => {
  const store = await fixture(context);
  let seen = 0;
  const target = await listen(http.createServer(async (request, response) => {
    seen++;
    let body = "";
    for await (const chunk of request) body += chunk;
    const data = JSON.parse(body);
    assert.equal(data.input[0].type, "function_call");
    assert.equal(data.input[1].type, "function_call_output");
    response.setHeader("content-type", "text/event-stream");
    response.end('event: response.completed\ndata: {"type":"response.completed","response":{"output":[]}}\n\n');
  }), context);
  await store.read();
  await store.save({ id: "native", name: "Native", endpoint: target, protocol: "responses", model: "test", noKey: true }, 1);
  const gateway = await listen(createGateway(store), context);
  const endpoint = `${gateway}/routes/native/v1/responses`;
  const payload = JSON.stringify({ model: "test", stream: true, input: [{ type: "function_call", name: "exec", arguments: "{}", call_id: "one" }, { type: "function_call_output", call_id: "one", output: "done" }] });
  assert.equal((await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${await store.token("another")}` }, body: payload })).status, 401);
  const result = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${await store.token("native")}` }, body: payload });
  assert.match(await result.text(), /response.completed/);
  assert.equal(seen, 1);
});

// 副本堆得最多的是模型窗口（continuations-v1 / instances-v2），所以启动前也必须清一次。
test("启动模型窗口前清掉不重要副本，首次「导入原会话并继续」那一次不清理", async (context) => {
  const store = await fixture(context);
  const officialHome = path.join(store.root, "official-codex");
  const now = Math.floor(Date.now() / 1000);
  const ancient = now - (staleDays + 5) * 86400;

  // 官方库是权威：一条已归档、一条超 30 天、一条 30 天内的，三条都要留着。
  await seedThreads(officialHome, [
    { id: "arch-1", updatedAt: now, archived: 1 },
    { id: "old-1", updatedAt: ancient },
    { id: "fresh-1", updatedAt: now },
  ]);

  const routeID = "deepseek-flash";
  const windowRoot = path.join(store.root, "continuations-v1", routeID);
  await store.writeSecret((await store.route(routeID)).credentialID, "fixture-key");
  const winHome = path.join(windowRoot, "codex-home");
  // conversation-import.json 一在，这个窗口就被当成「续接窗口」，启动走的正是 prepare() 这条路径。
  await fs.mkdir(winHome, { recursive: true });
  await fs.writeFile(path.join(winHome, "conversation-import.json"), JSON.stringify({ source: officialHome, routeID, model: "deepseek-flash" }));
  await seedThreads(winHome, [
    { id: "arch-1", updatedAt: now, bytes: 2048 },
    { id: "old-1", updatedAt: ancient, bytes: 4096 },
    { id: "fresh-1", updatedAt: now, bytes: 512 },
    { id: "own-1", updatedAt: now, bytes: 1024 },
  ]);

  const service = new ProductService(store);
  service.officialHome = officialHome;
  service.check = async () => ({ ok: true });
  service.gatewayReady = async () => {};

  const prepared = await service.prepare(routeID);
  assert.equal(prepared.diskCleanup.deletedThreads, 2, "已归档 + 超 30 天各一条");
  assert.equal(prepared.diskCleanup.deletedCacheDirs, 0);
  assert.ok(prepared.diskCleanup.freedBytes > 0);
  await assert.rejects(() => fs.access(path.join(winHome, "sessions", "arch-1.jsonl")), /ENOENT/);
  await assert.rejects(() => fs.access(path.join(winHome, "sessions", "old-1.jsonl")), /ENOENT/);
  await fs.access(path.join(winHome, "sessions", "fresh-1.jsonl"));
  await fs.access(path.join(winHome, "sessions", "own-1.jsonl"));
  // 官方库只读：三条原件一条都不能少。
  for (const id of ["arch-1", "old-1", "fresh-1"]) await fs.access(path.join(officialHome, "sessions", `${id}.jsonl`));

  // 幂等：再启动一次没有可清的。
  const again = await service.prepare(routeID);
  assert.equal(again.diskCleanup.deletedThreads, 0);
  assert.equal(again.diskCleanup.freedBytes, 0);

  // 第一次「导入原会话并继续」：刚导入的会话不能被立刻当成旧副本删掉。
  await fs.rm(windowRoot, { recursive: true, force: true });
  const fresh = await service.prepare(routeID, { continueExisting: true });
  assert.match(fresh.diskCleanup.skipped, /先不清理/);
  for (const id of ["arch-1", "old-1", "fresh-1"]) {
    await fs.access(path.join(winHome, "sessions", `${id}.jsonl`));
  }
});

// 长会话回归：Codex 每轮都把整段历史发上来，8 MB 上限会让「换个模型继续」直接 502。
// 这里发一个 12 MB 的请求体（超过旧上限、远低于新上限），必须能正常走到上游。
test("长会话的大请求体能通过网关（旧 8 MB 上限会让它 502）", async (context) => {
  const store = await fixture(context);
  let receivedBytes = 0;
  const upstreamURL = await listen(http.createServer((request, response) => {
    let size = 0;
    request.on("data", (chunk) => { size += chunk.length; });
    request.on("end", () => {
      receivedBytes = size;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: "MODEL_ASSISTANT_OK" } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }));
    });
  }), context);
  await store.read();
  await store.save({ id: "big-route", name: "Big", endpoint: upstreamURL, protocol: "chat", model: "big-model" }, 1, "upstream-secret");
  const gateway = await listen(createGateway(store), context);
  const endpoint = `${gateway}/routes/big-route/v1/responses`;
  const headers = { "content-type": "application/json", authorization: `Bearer ${await store.token("big-route")}` };
  // 12 MB 的填充：旧上限 8 MB 会在这里抛错并回 502。
  const filler = "x".repeat(12 * 1024 * 1024);
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "big-model", input: filler, stream: false }),
  });
  assert.equal(response.status, 200, `12 MB 请求体应被接受，实际 ${response.status}`);
  assert.ok(receivedBytes > 12 * 1024 * 1024, `上游应收到完整请求体，实际 ${receivedBytes}`);
  assert.match(await response.text(), /MODEL_ASSISTANT_OK/);
});

test("超过新上限时报 413 并说清怎么办，而不是含糊的 502", async (context) => {
  const store = await fixture(context);
  await store.read();
  await store.save({ id: "limit-route", name: "Limit", endpoint: "http://127.0.0.1:1/v1", protocol: "chat", model: "limit-model" }, 1, "upstream-secret");
  const gateway = await listen(createGateway(store), context);
  const endpoint = `${gateway}/routes/limit-route/v1/responses`;
  const headers = { "content-type": "application/json", authorization: `Bearer ${await store.token("limit-route")}` };
  // 直接把上限压到很小来验证报错路径（否则要发 256 MB）。
  const { limitedJSON, PayloadTooLargeError, requestLimitBytes } = await import("../src/model-gateway.mjs");
  assert.equal(requestLimitBytes, 256 * 1024 * 1024);
  const { Readable } = await import("node:stream");
  await assert.rejects(() => limitedJSON(Readable.from([Buffer.alloc(2048)]), 1024), (error) => {
    assert.ok(error instanceof PayloadTooLargeError);
    assert.equal(error.status, 413);
    assert.match(error.message, /超过 0 MB 上限|超过 1 MB 上限|超过/);
    assert.match(error.message, /新开一个会话|压缩/);
    return true;
  });
  // 路由不存在时不该被误当成超限
  const missing = await fetch(`${gateway}/routes/nope/v1/responses`, { method: "POST", headers, body: "{}" });
  assert.equal(missing.status, 401);
});

// 用户的原话：「不能超过就断开服务啊，这完全不符合 codex 的操作逻辑」。
// 这条测试就是把这个承诺钉住：网关只能压缩，不能因为自己算出来的数字把对话掐断。
test("长会话超过模型窗口时不再拦下：压不动就照原样转发，绝不掐断对话", async (context) => {
  const store = await fixture(context);
  let upstreamHits = 0;
  const upstreamURL = await listen(http.createServer((request, response) => {
    upstreamHits += 1;
    request.resume();
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: "MODEL_ASSISTANT_OK" } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }));
    });
  }), context);
  await store.read();
  // 小上下文 + 大上下文两个可切换路由
  await store.save({ id: "small-ctx", name: "小上下文", endpoint: upstreamURL, protocol: "chat", model: "small-ctx", contextWindow: 512000, credentialID: "small-ctx" }, 1, "k1");
  const data = await store.read();
  await store.save({ id: "big-ctx", name: "大上下文", endpoint: upstreamURL, protocol: "chat", model: "big-ctx", contextWindow: 1000000, credentialID: "big-ctx" }, data.revision, "k2");
  const gateway = await listen(createGateway(store), context);
  const endpoint = `${gateway}/router/v1/responses`;
  const headers = { "content-type": "application/json", authorization: `Bearer ${await store.token("router")}` };
  // 2 MB ≈ 65 万 tokens：超过 512K 的小上下文，但 1M 的大上下文能接住（就是现场那次的形态）。
  // 2 MB ≈ 65 万 token：远超 512K 的小上下文。历史是纯字符串（没有可切的用户消息），
  // 压缩无从下手——这时候必须原样转发，让供应商自己判断，而不是网关替它拒绝。
  const big = "y".repeat(2 * 1024 * 1024);
  const oversize = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ model: "small-ctx", input: big, stream: false }) });
  assert.equal(oversize.status, 200, "超窗不是拒绝的理由，必须照发");
  assert.match(await oversize.text(), /MODEL_ASSISTANT_OK/);
  assert.equal(upstreamHits, 1);

  // 换成大上下文模型：同样放行
  const allowed = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ model: "big-ctx", input: big, stream: false }) });
  assert.equal(allowed.status, 200);
  assert.equal(upstreamHits, 2);
  assert.match(await allowed.text(), /MODEL_ASSISTANT_OK/);

  // 窗口预算就是「窗口的九成」：留出输出空间，也避免贴着上限发请求。
  assert.equal(contextBudget({ contextWindow: 512000 }), 460800);
  // 没填窗口不等于「无限」：按模型匹配、查不到就用 512K 兜底。
  assert.equal(contextBudget({ contextWindow: 0, model: "某个没见过的模型" }), 460800);
  assert.equal(contextBudget({}), 460800);
  // 官方模型用实测到的 272K，而不是旧的 128K 占位值。
  assert.equal(contextBudget({ model: "gpt-6-astra", contextWindow: 128000 }), Math.floor(272000 * 0.9));
});

// 现场那次的数字：会话里贴了几张截图（base64 一共十几 MB），网关按字节折算，
// 凭空多出几十万 token，于是「明明没超窗口」却报超过上限。图片必须按张计价。
test("base64 截图不再被当成文本：图片按张计价，估算不再凭空撑大", async () => {
  const text = { role: "user", content: [{ type: "input_text", text: "x".repeat(32000) }] };
  const screenshot = { role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${"A".repeat(400 * 1024)}` }] };
  const textOnly = estimateTokens({ input: [text] }, 33000);
  const withShot = estimateTokens({ input: [text, screenshot] }, 450000);
  assert.equal(textOnly, 10000);
  assert.ok(withShot - textOnly < 5000, `图片不该按字节折算：${withShot} vs ${textOnly}`);
  assert.ok(withShot >= textOnly + 1000, "图片也要算成本，只是不按字节算");
  // 结构认不出来时仍然退回按字节折算，宁可高估也不能漏算。
  assert.equal(estimateTokens({ input: "y".repeat(3200) }, 3200), 1000);
  assert.equal(estimateTokens({ max_output_tokens: 1000 }, 3200000), 1001000);
});

// 预检没算准、供应商仍然报「上下文超了」时，网关要自己补一次压缩再重试。
// Codex 不会做这件事——实测它只会把这一轮标记失败，对话就此断掉。
for (const runtimeProfile of ["full", "lite"]) {
test(`供应商超限后 ${runtimeProfile} 重试使用压缩历史并保留开发约束`, async (context) => {
  const store = await fixture(context);
  let hits = 0;
  const forwarded = [];
  const upstreamURL = await listen(http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      hits += 1;
      forwarded.push(JSON.parse(body));
      response.setHeader("content-type", "application/json");
      if (hits === 1) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: { code: "context_length_exceeded", message: "This model's maximum context length is exceeded." } }));
        return;
      }
      if (/上下文压缩/.test(body)) {
        response.end(JSON.stringify({ choices: [{ message: { content: "任务目标：继续做 X；待办：Y" } }], usage: {} }));
        return;
      }
      response.end(JSON.stringify({ choices: [{ message: { content: "MODEL_ASSISTANT_OK" } }], usage: {} }));
    });
  }), context);
  await store.read();
  // 窗口取 150K：预检算出来约 125K，够不着 135K 的预算，所以不会提前压缩——
  // 只有供应商真的回了一句「超了」，才会走到「压缩后重试」这条路上。
  await store.save({ id: "retry-ctx", name: "重试窗口", endpoint: upstreamURL, protocol: "chat", model: "retry-ctx", contextWindow: 150000, credentialID: "retry-ctx", runtimeProfile }, 1, "k1");
  const gateway = await listen(createGateway(store), context);
  const headers = { "content-type": "application/json", authorization: `Bearer ${await store.token("router")}` };
  const history = [{role:"developer",content:[{type:"input_text",text:"PROJECT_REQUIREMENT_PRESERVE"}]}];
  for (let index = 0; index < 20; index += 1) {
    history.push({ role: "user", content: [{ type: "input_text", text: `第 ${index} 轮：请处理 ${"x".repeat(20000)}` }] });
    history.push({ role: "assistant", content: [{ type: "input_text", text: `第 ${index} 轮完成` }] });
  }
  const response = await fetch(`${gateway}/router/v1/responses`, {
    method: "POST", headers, body: JSON.stringify({ model: "retry-ctx", input: history, stream: false, max_output_tokens: 200 }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `应压缩后重试成功，实际 ${response.status}: ${text.slice(0, 200)}`);
  assert.match(text, /MODEL_ASSISTANT_OK/);
  assert.equal(hits, 3, "一次被拒 + 一次摘要 + 一次重试");
  assert.ok(JSON.stringify(forwarded[2]).length < JSON.stringify(forwarded[0]).length * 0.75);
  assert.match(JSON.stringify(forwarded[2]), /PROJECT_REQUIREMENT_PRESERVE/);
});
}


// 供应商的报错里常常写着它真正能装多少。与其一直猜，不如记下来给下一条请求用。
test("供应商说出的真实上限会被记回条目，窗口自己会越用越准", async (context) => {
  const store = await fixture(context);
  const upstreamURL = await listen(http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.statusCode = 400;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: { message: "This model's maximum context length is 100000 tokens. Please shorten your messages." } }));
    });
  }), context);
  await store.read();
  await store.save({ id: "learn-ctx", name: "会学习", endpoint: upstreamURL, protocol: "chat", model: "自定义模型", contextWindow: 0, credentialID: "learn-ctx" }, 1, "k1");
  // 没填窗口时按模型匹配、查不到用 512K 兜底
  assert.equal((await store.route("learn-ctx")).contextWindow, 512000);
  const gateway = await listen(createGateway(store), context);
  const headers = { "content-type": "application/json", authorization: `Bearer ${await store.token("router")}` };
  await fetch(`${gateway}/router/v1/responses`, {
    method: "POST", headers, body: JSON.stringify({ model: "learn-ctx", input: [{ role: "user", content: [{ type: "input_text", text: "你好" }] }], stream: false }),
  });
  assert.equal((await store.route("learn-ctx")).contextWindow, 100000, "供应商说的上限要记下来");
});
