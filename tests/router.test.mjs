import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { ModelStore, validateRoute } from "../src/model-store.mjs";
import { ProductService, parseOfficialRunning, renderRouterConfig, runningInstancesFromPS } from "../src/product-service.mjs";
import { buildRouterTable, modelInfo, routerCatalog, routerTableEntry } from "../src/router.mjs";
import { createGateway } from "../src/model-gateway.mjs";
import { sqliteSync } from "./test-platform.mjs";

function route(id, model, extra = {}) {
  return validateRoute({ id, name: `模型 ${id}`, vendor: "自定义", endpoint: "http://127.0.0.1:9/v1", protocol: "chat", model, noKey: true, ...extra });
}

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cma-router-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return new ModelStore(root);
}

async function listen(server, context) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

const sql = sqliteSync;

test("可切换窗口收录第三方模型并按模型名生成唯一标识", () => {
  const table = buildRouterTable([
    route("b-second", "dup"),
    route("archived-route", "ignored", { archived: true }),
    route("a-first", "dup"),
    route("blank", ""),
    { ...route("local", "qwen3.8:27b-96k"), protocol: "responses" },
    { ...route("official-entry", "gpt-6-astra"), id: "official", protocol: "oauth" },
    validateRoute({ id: "official-gpt-5-6-sol", name: "旧官方 Sol", vendor: "OpenAI（官方登录）", protocol: "chatgpt", model: "gpt-5.6-sol" }),
  ]);
  assert.deepEqual(table.map((entry) => entry.slug), ["dup", "dup-2", "qwen3.8-27b-96k"]);
  assert.equal(table[0].route.id, "a-first");
  assert.equal(table[1].route.id, "b-second");
  assert.equal(routerTableEntry(table, "dup-2").route.id, "b-second");
  assert.equal(routerTableEntry(table, "QWEN3.8:27B-96K").route.id, "local");
  assert.equal(routerTableEntry(table, "local").route.id, "local");
  assert.equal(routerTableEntry(table, "missing"), null);
  const catalog = routerCatalog(table);
  assert.equal(catalog.models.length, 3);
  assert.equal(catalog.models[0].display_name, "模型 a-first");
  assert.deepEqual(catalog.models[0].input_modalities, ["text", "image"]);
  // 本地优先 / 专家策略已移除，目录里不再注入任何内置指令
  assert.equal(catalog.models[2].base_instructions, "");
  assert.equal(catalog.models[0].base_instructions, "");
});

test("切换窗口配置指向网关 router 路由，且不写入任何供应商密钥", () => {
  const source = 'model = "old"\nservice_tier = "priority"\n[projects."/workspace"]\ntrust_level = "trusted"\n';
  const rendered = renderRouterConfig(source, { model: "dup", catalogPath: "/tmp/router/catalog.json" });
  assert.match(rendered, /model = "dup"/);
  assert.match(rendered, /model_provider = "cma_router"/);
  assert.match(rendered, /base_url = "http:\/\/127\.0\.0\.1:18793\/router\/v1"/);
  assert.match(rendered, /env_key = "CMA_ROUTE_TOKEN"/);
  assert.match(rendered, /trust_level = "trusted"/);
  assert.ok(!rendered.includes("priority"));
  assert.equal(renderRouterConfig(rendered, { model: "dup", catalogPath: "/tmp/router/catalog.json" }), rendered);
});

test("准备切换窗口时写出全部模型目录，官方与归档条目不进入", async (context) => {
  const store = await fixture(context);
  const data = await store.read();
  await store.save({ ...data.routes.find((entry) => entry.id === "agnes"), archived: true }, data.revision);
  const service = new ProductService(store);
  service.gatewayReady = async () => {};
  service.startGateway = async () => ({ message: "网关已就绪" });
  const prepared = await service.prepareSwitchWindow("deepseek-flash");
  assert.equal(prepared.chosen.route.id, "deepseek-flash");
  const catalog = JSON.parse(await fs.readFile(prepared.catalogPath, "utf8"));
  const slugs = catalog.models.map((entry) => entry.slug);
  assert.ok(slugs.includes("deepseek-flash"));
  assert.ok(!slugs.includes("agnes-2.5-flash"));
  assert.ok(!slugs.includes("gpt-6-astra"));
  const config = await fs.readFile(path.join(prepared.homePath, "config.toml"), "utf8");
  assert.match(config, /cma_router/);
  assert.ok(!config.includes("paid_expert"));
  const summary = await service.switchSummary();
  assert.ok(summary.switchModels.some((entry) => entry.id === "deepseek-flash"));
});

test("按进程命令行识别正在运行的模型窗口与可切换窗口", () => {
  const root = "/Users/test/.codex/model-assistant";
  const output = [
    "/Applications/Codex.app/Contents/MacOS/Codex --user-data-dir=/Users/test/.codex/model-assistant/router-v1/browser-data",
    "/Applications/Codex.app/Contents/MacOS/Codex --type=renderer --user-data-dir=/Users/test/.codex/model-assistant/router-v1/browser-data",
    "/Applications/Codex.app/Contents/MacOS/Codex --user-data-dir=/Users/test/.codex/model-assistant/instances-v2/agnes/browser-data",
    "/Applications/Codex.app/Contents/MacOS/Codex --user-data-dir=/Users/test/.codex/model-assistant/continuations-v1/deepseek-flash/browser-data",
    // 别的应用和别的根目录都不该被算进来
    "/Applications/Other.app/Contents/MacOS/Other --user-data-dir=/Users/test/Library/Application Support/other",
    "/Applications/Codex.app/Contents/MacOS/Codex --user-data-dir=/Users/test/elsewhere/router-v1/browser-data",
  ].join("\n");
  assert.deepEqual(runningInstancesFromPS(output, root), ["agnes", "deepseek-flash", "router"]);
  assert.deepEqual(runningInstancesFromPS(output, "/Users/test/nowhere"), []);
  assert.deepEqual(runningInstancesFromPS("", root), []);
  // 同一个窗口开多个进程只算一次
  assert.deepEqual(runningInstancesFromPS(output + "\n" + output, root), ["agnes", "deepseek-flash", "router"]);
});

test("Windows 反斜杠路径也能识别工作窗口，官方实例允许 exe 路径带引号", () => {
  const root = "C:\\Users\\test\\.codex\\model-assistant";
  const managed = `8124 \"C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe\" --user-data-dir=C:\\Users\\test\\.codex\\model-assistant\\windows-v1\\w2\\browser-data`;
  const official = `9001 \"C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe\"`;
  assert.deepEqual(runningInstancesFromPS(managed, root), ["w2"]);
  assert.equal(parseOfficialRunning(managed, root).length, 0);
  assert.equal(parseOfficialRunning(official, root)[0]?.pid, 9001);
});

test("工作窗口的合并来源排除已归档模型窗口，官方始终保留", async (context) => {
  const store = await fixture(context);
  const data = await store.read();
  await store.save({ ...data.routes.find((entry) => entry.id === "agnes"), archived: true }, data.revision);
  const service = new ProductService(store);
  await fs.mkdir(path.join(store.root, "instances-v2", "agnes", "codex-home"), { recursive: true });
  await fs.mkdir(path.join(store.root, "continuations-v1", "agnes", "codex-home"), { recursive: true });
  await fs.mkdir(path.join(store.root, "continuations-v1", "deepseek-flash", "codex-home"), { recursive: true });
  const sources = await service.switchWindowSources("all");
  assert.ok(sources.includes(path.join(store.root, "continuations-v1", "deepseek-flash", "codex-home")));
  assert.ok(!sources.some((entry) => entry.includes(`instances-v2${path.sep}agnes`)));
  assert.ok(!sources.some((entry) => entry.includes(`continuations-v1${path.sep}agnes`)));
  assert.ok(sources.some((entry) => entry.endsWith(path.join(path.sep, ".codex"))));
  // 显式指定某个条目时仍按用户意愿处理
  const explicit = await service.switchWindowSources("agnes");
  assert.ok(explicit.some((entry) => entry.includes(`continuations-v1${path.sep}agnes`)));
});

test("修复工作窗口会补齐侧边栏项目分组，且重复执行不再改动", async (context) => {
  const store = await fixture(context);
  const service = new ProductService(store);
  const paths = service.switchPaths();
  const stateFile = path.join(paths.homePath, ".codex-global-state.json");
  await fs.mkdir(path.join(paths.homePath, "sessions"), { recursive: true });
  sql(path.join(paths.homePath, "state_5.sqlite"), "CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, model_provider TEXT, model TEXT, title TEXT, cwd TEXT, project_id TEXT, thread_section_id TEXT);");
  sql(path.join(paths.homePath, "state_5.sqlite"), "CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT, metadata TEXT, position INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER);");
  sql(path.join(paths.homePath, "state_5.sqlite"), "CREATE TABLE project_roots(project_id TEXT, position INTEGER, path TEXT, PRIMARY KEY(project_id, position, path));");
  sql(path.join(paths.homePath, "state_5.sqlite"), "CREATE TABLE thread_sections(id TEXT PRIMARY KEY, name TEXT, appearance TEXT);");
  // 工作窗口里确实有这条会话：分组才有意义（归属指向不存在的会话时不该进侧边栏）。
  sql(path.join(paths.homePath, "state_5.sqlite"), "INSERT INTO threads(id, title) VALUES ('thread-1', '会话一');");
  // 这就是分组丢失的现场：任务库在、全局状态里一个项目也没有
  await fs.writeFile(stateFile, JSON.stringify({ "local-projects": {} }));

  const sourceHome = path.join(store.root, "continuations-v1", "deepseek-flash", "codex-home");
  await fs.mkdir(sourceHome, { recursive: true });
  await fs.writeFile(path.join(sourceHome, ".codex-global-state.json"), JSON.stringify({
    "local-projects": { "proj-a": { id: "proj-a", name: "Playground 2", rootPaths: ["/Users/test/playground"] } },
    "thread-project-assignments": { "thread-1": { projectId: "proj-a" } },
    "project-order": ["proj-a"],
  }));

  const first = await service.repairSwitchWindowMetadata("deepseek-flash");
  assert.equal(first.globalState.projects, 1);
  assert.equal(first.globalState.assignments, 1);
  assert.match(first.message, /已修复工作窗口分组/);
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(state["local-projects"]["proj-a"].name, "Playground 2");
  assert.equal(state["thread-project-assignments"]["thread-1"].projectId, "proj-a");

  const carried = await fs.readFile(stateFile, "utf8");
  const second = await service.repairSwitchWindowMetadata("deepseek-flash");
  assert.equal(second.globalState.projects, 1);
  assert.equal(second.globalState.assignments, 1);
  assert.equal(await fs.readFile(stateFile, "utf8"), carried);
});

// 新建的窗口没有任何对话。此时把来源的项目元数据整套并进来，侧边栏会列出一串
// 「暂无聊天」的空项目，看起来就像会话被弄丢了。
test("新建的空窗口不会被塞进一堆没有对话的项目", async (context) => {
  const store = await fixture(context);
  const service = new ProductService(store);
  const paths = service.switchPaths();
  const stateFile = path.join(paths.homePath, ".codex-global-state.json");
  await fs.mkdir(path.join(paths.homePath, "sessions"), { recursive: true });
  sql(path.join(paths.homePath, "state_5.sqlite"), "CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, model_provider TEXT, model TEXT, title TEXT, cwd TEXT, project_id TEXT, thread_section_id TEXT);");
  sql(path.join(paths.homePath, "state_5.sqlite"), "CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT, metadata TEXT, position INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER);");
  sql(path.join(paths.homePath, "state_5.sqlite"), "CREATE TABLE project_roots(project_id TEXT, position INTEGER, path TEXT, PRIMARY KEY(project_id, position, path));");
  sql(path.join(paths.homePath, "state_5.sqlite"), "CREATE TABLE thread_sections(id TEXT PRIMARY KEY, name TEXT, appearance TEXT);");
  await fs.writeFile(stateFile, JSON.stringify({ "local-projects": {} }));

  const sourceHome = path.join(store.root, "continuations-v1", "deepseek-flash", "codex-home");
  await fs.mkdir(sourceHome, { recursive: true });
  await fs.writeFile(path.join(sourceHome, ".codex-global-state.json"), JSON.stringify({
    "local-projects": {
      "proj-a": { id: "proj-a", name: "Playground 2", rootPaths: ["/Users/test/playground"] },
      "proj-b": { id: "proj-b", name: "Tiktok", rootPaths: ["/Users/test/tiktok"] },
    },
    "thread-project-assignments": { "thread-1": { projectId: "proj-a" }, "thread-2": { projectId: "proj-b" } },
    "project-order": ["proj-a", "proj-b"],
    "pinned-project-ids": ["proj-b"],
  }));

  const report = await service.repairSwitchWindowMetadata("deepseek-flash");
  assert.equal(report.globalState.projects, 0, "窗口里一条会话都没有，就不该出现项目");
  assert.equal(report.globalState.assignments, 0);
  assert.match(report.message, /清掉 2 个没有对话的空项目/);
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  // 空且原本不存在的键可以不写（已有的写入逻辑就是如此），所以只看「没有残留内容」。
  assert.deepEqual(state["local-projects"] ?? {}, {});
  assert.deepEqual(state["thread-project-assignments"] ?? {}, {});
  assert.deepEqual(state["project-order"] ?? [], []);
  assert.deepEqual(state["pinned-project-ids"] ?? [], []);
});

test("统一工作窗口会把指定模型已有会话补进来，首次未建库时返回待初始化", async (context) => {
  const store = await fixture(context);
  const service = new ProductService(store);
  service.startGateway = async () => ({ message: "网关已就绪" });
  const prepared = await service.prepareSwitchWindow("deepseek-flash");
  const pending = await service.syncSwitchWindowHistory(prepared.homePath, prepared.chosen.slug, "deepseek-flash");
  assert.equal(pending.pendingFirstLaunch, true);

  const schema = "CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, model_provider TEXT, model TEXT, title TEXT);";
  const history = "CREATE TABLE thread_items(thread_id TEXT, turn_id TEXT, item_id TEXT, item_json TEXT, PRIMARY KEY(thread_id, turn_id, item_id));";
  await fs.mkdir(path.join(prepared.homePath, "sessions"), { recursive: true });
  sql(path.join(prepared.homePath, "state_5.sqlite"), schema);
  sql(path.join(prepared.homePath, "thread_history_1.sqlite"), history);

  const sourceHome = path.join(store.root, "continuations-v1", "deepseek-flash", "codex-home");
  await fs.mkdir(path.join(sourceHome, "sessions", "2026", "01", "01"), { recursive: true });
  const rollout = path.join(sourceHome, "sessions", "2026", "01", "01", "rollout-old.jsonl");
  await fs.writeFile(rollout, '{"history":"KEEP"}\n');
  sql(path.join(sourceHome, "state_5.sqlite"), schema);
  sql(path.join(sourceHome, "thread_history_1.sqlite"), history);
  sql(path.join(sourceHome, "state_5.sqlite"), `INSERT INTO threads VALUES ('old-thread','${rollout}','OpenAI','gpt-6-astra','旧会话');`);
  sql(path.join(sourceHome, "thread_history_1.sqlite"), "INSERT INTO thread_items VALUES ('old-thread','turn-1','item-1','KEEP');");

  const imported = await service.syncSwitchWindowHistory(prepared.homePath, prepared.chosen.slug, "deepseek-flash");
  assert.equal(imported.imported, 1);
  assert.equal(sql(path.join(prepared.homePath, "state_5.sqlite"), "select model_provider||'|'||model from threads where id='old-thread';"), `cma_router|${prepared.chosen.slug}`);
  const copied = sql(path.join(prepared.homePath, "state_5.sqlite"), "select rollout_path from threads where id='old-thread';");
  assert.ok(copied.startsWith(prepared.homePath + path.sep));
  assert.equal(await fs.readFile(copied, "utf8"), '{"history":"KEEP"}\n');
});

test("网关切换路由按模型标识转发，未收录的模型被拒绝", async (context) => {
  const store = await fixture(context);
  const seen = [];
  const first = await listen(http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    seen.push(JSON.parse(body));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "FIRST_OK" } }] }));
  }), context);
  const second = await listen(http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    seen.push(JSON.parse(body));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "SECOND_OK" } }] }));
  }), context);
  await store.read();
  await store.save({ id: "a-first", name: "First", endpoint: first, protocol: "chat", model: "dup", noKey: true }, 1);
  await store.save({ id: "b-second", name: "Second", endpoint: second, protocol: "chat", model: "dup", noKey: true }, 2);
  const gateway = await listen(createGateway(store), context);
  const endpoint = `${gateway}/router/v1/responses`;
  const headers = { "content-type": "application/json", authorization: `Bearer ${await store.token("router")}` };
  assert.equal((await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer wrong" }, body: "{}" })).status, 401);
  assert.equal((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ model: "missing-model", input: "hi" }) })).status, 400);
  const firstResult = await (await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ model: "dup", input: "hi" }) })).json();
  assert.equal(firstResult.output[0].content[0].text, "FIRST_OK");
  const secondResult = await (await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ model: "dup-2", input: "hi" }) })).json();
  assert.equal(secondResult.output[0].content[0].text, "SECOND_OK");
  assert.deepEqual(seen.map((body) => body.model), ["dup", "dup"]);
  const models = await (await fetch(`${gateway}/router/v1/models`, { headers })).json();
  const ids = models.data.map((entry) => entry.id);
  assert.ok(ids.includes("dup") && ids.includes("dup-2"));
  assert.ok(!ids.includes("missing-model"));
});

test("切换窗口也能驱动原生 Responses 供应商并保留工具历史", async (context) => {
  const store = await fixture(context);
  let received = null;
  const target = await listen(http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received = JSON.parse(body);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: "resp_1", object: "response", status: "completed", output: [] }));
  }), context);
  await store.read();
  await store.save({ id: "native-switch", name: "Native", endpoint: target, protocol: "responses", model: "native-model", noKey: true }, 1);
  const gateway = await listen(createGateway(store), context);
  const result = await fetch(`${gateway}/router/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${await store.token("router")}` },
    body: JSON.stringify({ model: "native-model", input: [{ type: "function_call", name: "exec", arguments: "{}", call_id: "one" }, { type: "function_call_output", call_id: "one", output: "done" }] }),
  });
  assert.equal(result.status, 200);
  assert.equal(received.model, "native-model");
  assert.equal(received.input[0].type, "function_call");
  assert.equal(received.store, false);
});

test("地址粘贴控制台链接或省略版本号时自动补成可用服务根地址", async (context) => {
  const store = await fixture(context);
  await store.save({ id: "paste", name: "粘贴", endpoint: "http://127.0.0.1:8080/#accounts", protocol: "anthropic", model: "claude-sonnet-4-6", noKey: true }, (await store.read()).revision);
  assert.equal((await store.route("paste")).endpoint, "http://127.0.0.1:8080/v1");
  await store.save({ id: "paste2", name: "粘贴2", endpoint: "127.0.0.1:9000", protocol: "chat", model: "local", noKey: true }, (await store.read()).revision);
  assert.equal((await store.route("paste2")).endpoint, "http://127.0.0.1:9000/v1");
  await store.save({ id: "paste3", name: "粘贴3", endpoint: "https://api.deepseek.com/v1", protocol: "responses", model: "deepseek-flash" }, (await store.read()).revision);
  assert.equal((await store.route("paste3")).endpoint, "https://api.deepseek.com/v1");
});

test("供应商容量限制如实转达，不误报余额耗尽", async (context) => {
  const store = await fixture(context);
  const target = await listen(http.createServer(async (request, response) => {
    if (request.url === "/v1/messages") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "RESOURCE_EXHAUSTED: You have exhausted your capacity on gemini-3. Quota will reset after 149h2m19s. key sk-secretsecret123" } }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}");
  }), context);
  await store.read();
  await store.save({ id: "quota", name: "Quota", endpoint: `${target}/v1`, protocol: "anthropic", model: "gemini-3.7-flash-high", noKey: true }, 1);
  const gateway = await listen(createGateway(store), context);
  const headers = { "content-type": "application/json", authorization: `Bearer ${await store.token("quota")}` };
  const payload = JSON.stringify({ model: "gemini-3.7-flash-high", input: "hi", stream: true });
  const body = await (await fetch(`${gateway}/routes/quota/v1/responses`, { method: "POST", headers, body: payload })).text();
  assert.match(body, /response\.failed/);
  assert.match(body, /"code":"rate_limit_exceeded"/);
  assert.match(body, /RESOURCE_EXHAUSTED/);
  assert.ok(!body.includes("sk-secretsecret123"));
  const plain = await (await fetch(`${gateway}/routes/quota/v1/responses`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ model: "gemini-3.7-flash-high", input: "hi" }) })).json();
  assert.equal(plain.error.code, "rate_limit_exceeded");
  assert.match(plain.error.message, /RESOURCE_EXHAUSTED/);
});

test("接口格式选错时网关按 404 自动换成可用的接口并记住", async (context) => {
  const store = await fixture(context);
  const seen = [];
  const target = await listen(http.createServer(async (request, response) => {
    seen.push(request.url);
    if (request.url !== "/v1/chat/completions") { response.writeHead(404); response.end("{}"); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "ONLY_CHAT_OK" } }] }));
  }), context);
  await store.read();
  await store.save({ id: "wrong", name: "选错格式", endpoint: `${target}/v1`, protocol: "anthropic", model: "only-chat", noKey: true }, 1);
  const gateway = await listen(createGateway(store), context);
  const result = await fetch(`${gateway}/routes/wrong/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${await store.token("wrong")}` },
    body: JSON.stringify({ model: "only-chat", input: "hi" }),
  });
  const data = await result.json();
  assert.equal(result.status, 200);
  assert.equal(data.output[0].content[0].text, "ONLY_CHAT_OK");
  assert.deepEqual(seen, ["/v1/messages", "/v1/responses", "/v1/chat/completions"]);
  assert.equal((await store.route("wrong")).protocol, "chat");
  await store.save((await store.route("wrong")), (await store.read()).revision);
  assert.equal((await store.route("wrong")).protocol, "chat");
});

test("自动识别接口会挑出真正可用的那一套并保存", async (context) => {
  const store = await fixture(context);
  const target = await listen(http.createServer(async (request, response) => {
    if (request.url === "/v1/messages") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "pong" }], usage: { input_tokens: 1, output_tokens: 1 } }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}");
  }), context);
  await store.read();
  await store.save({ id: "messages-only", name: "只有 Messages", endpoint: `${target}/v1`, protocol: "chat", model: "claude-sonnet-4-6", noKey: true }, 1);
  const service = new ProductService(store);
  const detected = await service.detectProtocol("messages-only");
  assert.equal(detected.protocol, "anthropic");
  assert.equal(detected.changed, true);
  assert.match(detected.message, /自动把接口格式改为 anthropic/);
  assert.equal((await store.route("messages-only")).protocol, "anthropic");
  const again = await service.detectProtocol("messages-only");
  assert.equal(again.changed, false);
  assert.equal(again.tested.find((entry) => entry.protocol === "chat").ok, false);
  const failed = new ProductService(store);
  const broken = await store.read();
  await store.save({ ...broken.routes.find((entry) => entry.id === "messages-only"), endpoint: "http://127.0.0.1:9/v1" }, broken.revision);
  await assert.rejects(failed.detectProtocol("messages-only"), /三套接口都没跑通/);
});

test("已有条目的窗口可以改成可切换窗口且保留同一个任务库", async (context) => {
  const store = await fixture(context);
  await store.writeSecret((await store.route("deepseek-flash")).credentialID, "fixture-key");
  const service = new ProductService(store);
  service.check = async () => ({ ok: true });
  service.gatewayReady = async () => {};
  const first = await service.prepare("deepseek-flash");
  assert.match(await fs.readFile(path.join(first.homePath, "config.toml"), "utf8"), /routes\/deepseek-flash\/v1/);
  const single = JSON.parse(await fs.readFile(path.join(first.homePath, "model-catalog.json"), "utf8"));
  assert.equal(single.models.length, 1);
  const enabled = await service.setSwitching("deepseek-flash", true);
  assert.match(enabled.message, /可切换模型/);
  const config = await fs.readFile(path.join(first.homePath, "config.toml"), "utf8");
  assert.match(config, /cma_router/);
  assert.match(config, /router\/v1/);
  const catalog = JSON.parse(await fs.readFile(path.join(first.homePath, "model-catalog.json"), "utf8"));
  assert.ok(catalog.models.length > 1);
  assert.ok(catalog.models.some((entry) => entry.slug === "deepseek-flash"));
  assert.equal((await store.route("deepseek-flash")).switchable, true);
  await service.prepare("deepseek-flash");
  assert.match(await fs.readFile(path.join(first.homePath, "config.toml"), "utf8"), /cma_router/);
  await service.setSwitching("deepseek-flash", false);
  assert.match(await fs.readFile(path.join(first.homePath, "config.toml"), "utf8"), /routes\/deepseek-flash\/v1/);
  assert.equal((await store.route("deepseek-flash")).switchable, false);
  await assert.rejects(service.setSwitching("official", true), /不需要切换窗口/);
});

test("改成可切换的条目窗口沿用原有环境令牌也能走切换路由", async (context) => {
  const store = await fixture(context);
  const target = await listen(http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: `OK:${JSON.parse(body).model}` } }] }));
  }), context);
  await store.read();
  await store.save({ id: "deepseek-flash", name: "DeepSeek", endpoint: `${target}/v1`, protocol: "chat", model: "deepseek-flash", noKey: true }, 1);
  const service = new ProductService(store);
  await service.setSwitching("deepseek-flash", true);
  const gateway = await listen(createGateway(store), context);
  const instanceToken = await store.token("deepseek-flash");
  const switched = await fetch(`${gateway}/router/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${instanceToken}` },
    body: JSON.stringify({ model: "deepseek-flash", input: "hi" }),
  });
  assert.equal(switched.status, 200);
  assert.match((await switched.json()).output[0].content[0].text, /OK:deepseek-flash/);
  const other = await store.read();
  await store.save({ ...other.routes.find((entry) => entry.id === "deepseek-flash"), switchable: false }, other.revision);
  const rejected = await fetch(`${gateway}/router/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${instanceToken}` },
    body: JSON.stringify({ model: "deepseek-flash", input: "hi" }),
  });
  assert.equal(rejected.status, 401);
});

// Codex 自带压缩：它按模型的 context_window 与 effective_context_window_percent 决定何时压缩。
// 目录里必须把这两个值给对，否则长会话不会自动摘要，只会一路撞窗口。
test("模型目录把压缩参数给对，让 Codex 自己压缩", async (context) => {
  const store = await fixture(context);
  const data = await store.read();
  const route = data.routes.find((entry) => entry.id === "deepseek-flash");
  await store.save({ ...route, contextWindow: 1000000 }, data.revision);
  const table = buildRouterTable((await store.read()).routes);
  const catalog = routerCatalog(table);
  const entry = catalog.models.find((model) => model.slug === "deepseek-flash");
  assert.equal(entry.context_window, 1000000);
  assert.equal(entry.effective_context_window_percent, 95, "对齐官方模型的 95%");
  assert.equal(entry.auto_compact_token_limit, 950000, "压缩阈值要显式、且留出摘要空间");
  // 不该出现「窗口未设就当成无限」的情况：没配的按模型匹配，查不到用 512K 兜底
  const fallback = modelInfo({ id: "x", name: "X", vendor: "V", model: "x", contextWindow: 0 }, "x");
  assert.equal(fallback.context_window, 512000);
  assert.equal(fallback.auto_compact_token_limit, 486400);
  // 官方模型要用实测到的真实窗口，而不是旧的 128K 占位值
  const official = modelInfo({ id: "official", name: "官方", vendor: "OpenAI", model: "gpt-6-astra", contextWindow: 128000 }, "gpt-6-astra");
  assert.equal(official.context_window, 272000);
  assert.equal(official.auto_compact_token_limit, 258400);
});
