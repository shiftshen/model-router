import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { ModelStore } from "../src/model-store.mjs";
import { createGateway } from "../src/model-gateway.mjs";

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cma-stream-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return new ModelStore(root);
}

async function listen(server, context) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}

function sseData(value) { return `data: ${JSON.stringify(value)}\n\n`; }

async function callGateway(gateway, id, payload, token) {
  const response = await fetch(`${gateway}/routes/${id}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  return { status: response.status, contentType: response.headers.get("content-type"), text, events: text.split("\n").filter((line) => line.startsWith("event: ")).map((line) => line.slice(7)) };
}

test("Chat 供应商边收边发：首字先到，工具入参最后汇总", async (context) => {
  const store = await fixture(context);
  let release;
  const nextChunk = new Promise((resolve) => { release = resolve; });
  let firstDeltaSeen;
  const firstDelta = new Promise((resolve) => { firstDeltaSeen = resolve; });
  const upstreamURL = await listen(http.createServer(async (request, response) => {
    const body = await readBody(request);
    assert.equal(body.stream, true);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(sseData({ choices: [{ delta: { content: "第一段" } }] }));
    await nextChunk;
    response.write(sseData({ choices: [{ delta: { content: "第二段" } }] }));
    response.write(sseData({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "exec", arguments: '{"cmd"' } }] } }] }));
    response.write(sseData({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ': "pwd"}' } }] } }] }));
    response.write(sseData({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 9 } }));
    response.write("data: [DONE]\n\n");
    response.end();
  }), context);
  await store.read();
  await store.save({ id: "chatty", name: "Chatty", endpoint: `${upstreamURL}/v1`, protocol: "chat", model: "m", noKey: true }, 1);
  const token = await store.token("chatty");
  const gateway = await listen(createGateway(store), context);
  const response = await fetch(`${gateway}/routes/chatty/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: "m", stream: true, input: "hi", tools: [{ type: "function", name: "exec", parameters: { type: "object" } }] }),
  });
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  let text = "";
  let sawFirstDelta = false;
  let releasedByTimer = false;
  const timer = setTimeout(() => { releasedByTimer = true; release(); }, 4000);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (!sawFirstDelta && text.includes("第一段")) { sawFirstDelta = true; clearTimeout(timer); release(); }
  }
  assert.ok(sawFirstDelta && !releasedByTimer, "首字没有在第二段之前到达，说明网关仍在整体缓冲");
  assert.match(text, /response.completed/);
  assert.match(text, /"text":"第一段第二段"/);
  assert.match(text, /"arguments":"\{\\"cmd\\": \\"pwd\\"\}"/);
  assert.match(text, /"input_tokens":7/);
  assert.ok(!text.includes("第二段第二段"));
});

test("Anthropic 供应商流式：文本增量 + tool_use 汇总", async (context) => {
  const store = await fixture(context);
  const upstreamURL = await listen(http.createServer(async (request, response) => {
    const body = await readBody(request);
    assert.equal(body.stream, true);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("event: message_start\ndata: " + JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 11 } } }) + "\n\n");
    response.write("event: content_block_start\ndata: " + JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) + "\n\n");
    response.write("event: content_block_delta\ndata: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } }) + "\n\n");
    response.write("event: content_block_stop\ndata: " + JSON.stringify({ type: "content_block_stop", index: 0 }) + "\n\n");
    response.write("event: content_block_start\ndata: " + JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "exec" } }) + "\n\n");
    response.write("event: content_block_delta\ndata: " + JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"cmd"' } }) + "\n\n");
    response.write("event: content_block_delta\ndata: " + JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ': "pwd"}' } }) + "\n\n");
    response.write("event: message_delta\ndata: " + JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }) + "\n\n");
    response.write("event: message_stop\ndata: " + JSON.stringify({ type: "message_stop" }) + "\n\n");
    response.end();
  }), context);
  await store.read();
  await store.save({ id: "claude", name: "Claude", endpoint: `${upstreamURL}/v1`, protocol: "anthropic", model: "claude-sonnet-4-6", noKey: true }, 1);
  const token = await store.token("claude");
  const gateway = await listen(createGateway(store), context);
  const result = await callGateway(gateway, "claude", { model: "claude-sonnet-4-6", stream: true, input: "hi", tools: [{ type: "function", name: "exec", parameters: { type: "object" } }] }, token);
  assert.deepEqual(result.events.filter((name) => name.endsWith(".delta")), ["response.output_text.delta"]);
  assert.match(result.text, /"text":"你好"/);
  assert.match(result.text, /"type":"function_call"/);
  assert.match(result.text, /"arguments":"\{\\"cmd\\": \\"pwd\\"\}"/);
  assert.match(result.text, /"output_tokens":5/);
  assert.match(result.text, /response\.completed/);
});

test("供应商不支持流式时自动退回整体转换", async (context) => {
  const store = await fixture(context);
  const upstreamURL = await listen(http.createServer(async (request, response) => {
    const body = await readBody(request);
    assert.equal(body.stream, true);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "整段回答" } }] }));
  }), context);
  await store.read();
  await store.save({ id: "buffered", name: "Buffered", endpoint: `${upstreamURL}/v1`, protocol: "chat", model: "m", noKey: true }, 1);
  const token = await store.token("buffered");
  const gateway = await listen(createGateway(store), context);
  const result = await callGateway(gateway, "buffered", { model: "m", stream: true, input: "hi" }, token);
  assert.equal(result.status, 200);
  assert.match(result.text, /response\.output_text\.delta/);
  assert.match(result.text, /"text":"整段回答"/);
  assert.match(result.text, /response\.completed/);
});

test("主模型额度用尽时自动改用备用模型，且正常时不打扰备用", async (context) => {
  const store = await fixture(context);
  let primaryHits = 0;
  let backupHits = 0;
  const primary = await listen(http.createServer(async (request, response) => {
    primaryHits += 1;
    await readBody(request);
    response.writeHead(429, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "quota exhausted" } }));
  }), context);
  const backup = await listen(http.createServer(async (request, response) => {
    backupHits += 1;
    await readBody(request);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "BACKUP_ANSWER" } }] }));
  }), context);
  await store.read();
  await store.save({ id: "primary", name: "Primary", endpoint: `${primary}/v1`, protocol: "chat", model: "m1", noKey: true, fallback: "backup" }, 1);
  await store.save({ id: "backup", name: "Backup", endpoint: `${backup}/v1`, protocol: "chat", model: "m2", noKey: true }, 2);
  const token = await store.token("primary");
  const gateway = await listen(createGateway(store), context);
  const result = await callGateway(gateway, "primary", { model: "m1", input: "hi" }, token);
  assert.equal(result.status, 200);
  assert.match(result.text, /BACKUP_ANSWER/);
  assert.equal(primaryHits, 1);
  assert.equal(backupHits, 1);
  await store.save({ ...(await store.read()).routes.find((entry) => entry.id === "primary"), fallback: "" }, (await store.read()).revision);
  const again = await callGateway(gateway, "primary", { model: "m1", input: "hi" }, token);
  assert.equal(again.status, 429);
  assert.equal(backupHits, 1);
  assert.match(again.text, /quota exhausted/);
});

test("要求工具时主模型假 200 只写文字，流式请求会改用真正调用工具的备用模型", async (context) => {
  const store = await fixture(context);
  let backupHits = 0;
  const primary = await listen(http.createServer(async (request, response) => {
    await readBody(request);
    if (request.url !== "/v1/chat/completions") { response.writeHead(404); response.end("{}"); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sseData({ choices: [{ delta: { content: "我会调用工具（其实没有）" } }] }) + "data: [DONE]\n\n");
  }), context);
  const backup = await listen(http.createServer(async (request, response) => {
    backupHits += 1;
    await readBody(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sseData({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_good", function: { name: "echo", arguments: '{"input":"hello"}' } }] } }] }) + "data: [DONE]\n\n");
  }), context);
  await store.read();
  await store.save({ id: "pretend", name: "Pretend", endpoint: `${primary}/v1`, protocol: "chat", model: "m1", noKey: true, runtimeProfile: "full", fallback: "real-tool" }, 1);
  await store.save({ id: "real-tool", name: "Real tool", endpoint: `${backup}/v1`, protocol: "chat", model: "m2", noKey: true, runtimeProfile: "full" }, 2);
  const gateway = await listen(createGateway(store), context);
  const result = await callGateway(gateway, "pretend", {
    model: "m1", stream: true, input: "Call echo with hello", tool_choice: "required",
    tools: [{ type: "custom", name: "echo", description: "Echo", format: { type: "text" } }],
  }, await store.token("pretend"));
  assert.equal(result.status, 200);
  assert.equal(backupHits, 1);
  assert.match(result.text, /"type":"custom_tool_call"/);
  assert.match(result.text, /"input":"hello"/);
  assert.doesNotMatch(result.text, /我会调用工具/);
  assert.equal(result.events.filter((event) => event === "response.completed").length, 1);
});

test("已经开始输出正文后不再切换供应商，改为如实报错", async (context) => {
  const store = await fixture(context);
  let backupHits = 0;
  const primary = await listen(http.createServer(async (request, response) => {
    await readBody(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(sseData({ choices: [{ delta: { content: "开头" } }] }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    response.destroy();
  }), context);
  const backup = await listen(http.createServer(async (request, response) => {
    backupHits += 1;
    await readBody(request);
    response.end(JSON.stringify({ choices: [{ message: { content: "不该出现" } }] }));
  }), context);
  await store.read();
  await store.save({ id: "halfway", name: "Halfway", endpoint: `${primary}/v1`, protocol: "chat", model: "m1", noKey: true, fallback: "spare" }, 1);
  await store.save({ id: "spare", name: "Spare", endpoint: `${backup}/v1`, protocol: "chat", model: "m2", noKey: true }, 2);
  const token = await store.token("halfway");
  const gateway = await listen(createGateway(store), context);
  const result = await callGateway(gateway, "halfway", { model: "m1", stream: true, input: "hi" }, token);
  assert.match(result.text, /开头/);
  assert.match(result.text, /response\.failed/);
  assert.equal(backupHits, 0);
  assert.ok(!result.text.includes("不该出现"));
});

test("供应商长时间不返回数据时主动断开，并改用备用模型", async (context) => {
  const store = await fixture(context);
  let backupHits = 0;
  const silent = await listen(http.createServer(async (request) => {
    await readBody(request);
    // 一直不回任何字节，模拟卡死的供应商
  }), context);
  const backup = await listen(http.createServer(async (request, response) => {
    backupHits += 1;
    await readBody(request);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "备用接住了" } }] }));
  }), context);
  await store.read();
  await store.save({ id: "stuck", name: "Stuck", endpoint: `${silent}/v1`, protocol: "chat", model: "m1", noKey: true, fallback: "rescue" }, 1);
  await store.save({ id: "rescue", name: "Rescue", endpoint: `${backup}/v1`, protocol: "chat", model: "m2", noKey: true }, 2);
  const token = await store.token("stuck");
  const gateway = await listen(createGateway(store, { idleMs: 300 }), context);
  const started = Date.now();
  const result = await callGateway(gateway, "stuck", { model: "m1", input: "hi" }, token);
  assert.equal(result.status, 200);
  assert.match(result.text, /备用接住了/);
  assert.equal(backupHits, 1);
  assert.ok(Date.now() - started < 5000, "应当在空闲超时后很快改用备用模型");
});

test("没有备用模型时，卡死的供应商按超时如实回报", async (context) => {
  const store = await fixture(context);
  const silent = await listen(http.createServer(async (request) => { await readBody(request); }), context);
  await store.read();
  await store.save({ id: "lonely", name: "Lonely", endpoint: `${silent}/v1`, protocol: "chat", model: "m1", noKey: true }, 1);
  const token = await store.token("lonely");
  const gateway = await listen(createGateway(store, { idleMs: 300 }), context);
  const result = await callGateway(gateway, "lonely", { model: "m1", input: "hi" }, token);
  assert.equal(result.status, 502);
  assert.match(result.text, /长时间没有返回数据/);
});
