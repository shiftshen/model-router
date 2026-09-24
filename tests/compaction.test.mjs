import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { ModelStore } from "../src/model-store.mjs";
import { createGateway } from "../src/model-gateway.mjs";
import {
  buildCompactedInput,
  estimateTokens,
  fallbackSummary,
  safeSplitIndex,
  summaryRequest,
  transcriptOf,
  trimOldToolOutputs,
} from "../src/context-compaction.mjs";
import { contextWindowFromMessage, resolveContextWindow, defaultContextWindow } from "../src/model-windows.mjs";

const user = (text) => ({ role: "user", content: [{ type: "input_text", text }] });
const assistant = (text) => ({ role: "assistant", content: [{ type: "input_text", text }] });

// 造一段「用户提问 + 工具调用 + 工具返回 + 助手回答」的长会话。
function transcript(rounds, pad = 2000) {
  const items = [];
  for (let index = 0; index < rounds; index += 1) {
    items.push(user(`第 ${index} 轮：请处理这个任务 ${"x".repeat(pad)}`));
    items.push({ type: "function_call", name: "exec", call_id: `call_${index}`, arguments: "{}" });
    items.push({ type: "function_call_output", call_id: `call_${index}`, output: "y".repeat(pad) });
    items.push(assistant(`第 ${index} 轮完成`));
  }
  return items;
}

async function listen(server, context) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("压缩切点落在用户消息上，绝不把工具调用和它的返回拆开", () => {
  const items = transcript(40);
  const split = safeSplitIndex(items, 30000);
  assert.ok(split > 0 && split < items.length);
  assert.equal(items[split].role, "user", "尾巴必须从用户提问开始");
  assert.ok(!["function_call_output", "custom_tool_call_output"].includes(items[split].type));
  // 被裁掉的部分里，每个 function_call 都必须带着自己的 output
  const head = items.slice(0, split);
  const calls = new Set(head.filter((item) => item.type === "function_call").map((item) => item.call_id));
  for (const item of head.filter((entry) => entry.type === "function_call_output")) {
    assert.ok(calls.has(item.call_id), "工具返回不能悬空");
  }
  // 尾巴里也不能出现「找不到调用」的返回
  const tailCalls = new Set(items.slice(split).filter((item) => item.type === "function_call").map((item) => item.call_id));
  for (const item of items.slice(split).filter((entry) => entry.type === "function_call_output")) {
    assert.ok(tailCalls.has(item.call_id), "尾巴里的工具返回必须有对应调用");
  }
});

test("会话太短或找不到安全切点时宁可不压缩", () => {
  assert.equal(safeSplitIndex(transcript(1), 1000), 0);
  assert.equal(safeSplitIndex([], 1000), 0);
  // 没有用户消息的历史（例如只有工具往返）不能切
  const noUser = [{ type: "function_call", name: "exec", call_id: "c1", arguments: "{}" }, { type: "function_call_output", call_id: "c1", output: "y".repeat(500) }];
  assert.equal(safeSplitIndex(noUser, 100), 0);
});

test("压缩后的请求：摘要打头、最近对话原样保留", () => {
  const items = transcript(40);
  const split = safeSplitIndex(items, 30000);
  const out = buildCompactedInput({ summary: "任务目标：X；已完成：Y；待办：Z", tail: items.slice(split), droppedCount: split });
  assert.equal(out.length, items.length - split + 1);
  const head = out[0].content[0].text;
  assert.match(head, /较早对话已压缩/);
  assert.match(head, new RegExp(`前 ${split} 条记录`));
  assert.match(head, /任务目标：X/);
  assert.deepEqual(out.slice(1), items.slice(split), "保留段必须与原文完全一致");
});

test("摘要请求带上任务目标/待办等保真要求，并限制输出长度", () => {
  const request = summaryRequest(transcriptOf(transcript(3)), "some-model");
  assert.match(request.instructions, /任务目标/);
  assert.match(request.instructions, /待办/);
  assert.match(request.instructions, /文件路径/);
  assert.ok(request.max_output_tokens <= 8000);
  assert.equal(request.input[0].role, "user");
  assert.match(request.input[0].content[0].text, /用户：第 0 轮/);
});

test("兜底摘要会列出被裁掉的用户消息，不会静默丢上下文", () => {
  const items = transcript(6);
  const text = fallbackSummary(items.slice(0, 8));
  assert.match(text, /摘要模型本次不可用/);
  assert.match(text, /第 0 轮/);
});

test("token 估算把输出额度算进去，且偏保守", () => {
  assert.equal(estimateTokens({ max_output_tokens: 1000 }, 3200000), 1001000);
  assert.equal(estimateTokens({}, 320), 100);
  // 32 KB ≈ 1 万 tokens，这个量级不能低估（低估就会把请求发出去然后被供应商拒）
  assert.ok(estimateTokens({}, 32 * 1024) >= 10000);
});

test("切换模型导致超窗时，网关先压缩再继续，而不是报错", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cma-compact-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ModelStore(root);
  const seen = [];
  const upstreamURL = await listen(http.createServer((request, response) => {
    let size = 0;
    let body = "";
    request.on("data", (chunk) => { size += chunk.length; body += chunk.toString(); });
    request.on("end", () => {
      // chat 协议会把 instructions 转成 system 消息，所以按原文找标记，不依赖协议形态。
      seen.push({ size, isSummary: /上下文压缩/.test(body) });
      response.setHeader("content-type", "application/json");
      if (seen.at(-1).isSummary) {
        response.end(JSON.stringify({ choices: [{ message: { content: "任务目标：继续做 X；待办：Y" } }], usage: {} }));
      } else {
        response.end(JSON.stringify({ choices: [{ message: { content: "MODEL_ASSISTANT_OK" } }], usage: {} }));
      }
    });
  }), context);
  await store.read();
  await store.save({ id: "ctx-route", name: "小窗口", endpoint: upstreamURL, protocol: "chat", model: "ctx-route", contextWindow: 512000, credentialID: "ctx-route" }, 1, "k1");
  const gateway = await listen(createGateway(store), context);
  const endpoint = `${gateway}/router/v1/responses`;
  const headers = { "content-type": "application/json", authorization: `Bearer ${await store.token("router")}` };
  // 4.8 MB ≈ 150 万 tokens：确定超过 512K（阈值是 512000 * 3.2 ≈ 1.64 MB）
  const long = transcript(60, 20000);
  const sentBytes = JSON.stringify({ model: "ctx-route", input: long, stream: false }).length;
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ model: "ctx-route", input: long, stream: false, max_output_tokens: 500 }) });
  const text = await response.text();
  assert.equal(response.status, 200, `应压缩后继续，实际 ${response.status}: ${text.slice(0, 200)}`);
  assert.match(text, /MODEL_ASSISTANT_OK/);
  assert.equal(seen.length, 2, "一次摘要 + 一次正式请求");
  assert.equal(seen[0].isSummary, true, "第一次应是摘要请求");
  assert.equal(seen[1].isSummary, false);
  assert.ok(seen[1].size < sentBytes, `正式请求应比原始请求小：${seen[1].size} < ${sentBytes}`);
  assert.ok(sentBytes - seen[1].size > 1024 * 1024, `压缩应显著减小请求体：${sentBytes} → ${seen[1].size}`);
});


test("窗口不写死：按模型匹配真实值，明确设置时尊重用户值", () => {
  // 官方模型：实测过 272K，任何占位值都盖不过这个事实
  assert.equal(resolveContextWindow({ model: "gpt-6-astra", contextWindow: 128000 }), 272000);
  assert.equal(resolveContextWindow({ model: "gpt-5.6-sol", contextWindow: 200000 }), 200000);
  // 用户自己填的非占位值优先——128K 对不少模型确实是正确答案
  assert.equal(resolveContextWindow({ model: "agnes-2.5-flash", contextWindow: 128000 }), 128000);
  assert.equal(resolveContextWindow({ model: "deepseek-flash", contextWindow: 1000000 }), 1000000);
  assert.equal(resolveContextWindow({ model: "mimo-v2.6-flash", contextWindow: 0 }), 1048576);
  assert.equal(resolveContextWindow({ model: "mimo-v2.6-flash", contextWindow: 128000, contextWindowAuto: false }), 128000);
  // 旧占位值会被表里的公开值顶掉
  assert.equal(resolveContextWindow({ model: "claude-sonnet-4-6", contextWindow: 128000 }), 200000);
  // 查不到就 512K，而不是旧的 128K
  assert.equal(resolveContextWindow({ model: "谁都不认识的模型", contextWindow: 0 }), defaultContextWindow);
  assert.equal(resolveContextWindow({ model: "", contextWindow: undefined }), 512000);
});

test("供应商报错里的真实上限能被读出来，用来纠正窗口", () => {
  assert.equal(contextWindowFromMessage("This model's maximum context length is 131072 tokens."), 131072);
  assert.equal(contextWindowFromMessage("context length of 65536"), 65536);
  assert.equal(contextWindowFromMessage("context_window 200000 exceeded"), 200000);
  assert.equal(contextWindowFromMessage("额度不足"), 0);
  assert.equal(contextWindowFromMessage("maximum context length is 12"), 0, "太小的数字不是窗口");
});

test("整段历史都是工具往返时也要能压缩，不能把会话卡死", () => {
  const items = [];
  for (let index = 0; index < 20; index += 1) {
    items.push({ type: "function_call", name: "exec", call_id: `c${index}`, arguments: "{}" });
    items.push({ type: "function_call_output", call_id: `c${index}`, output: "y".repeat(4000) });
  }
  assert.equal(safeSplitIndex(items, 20000), 0, "默认策略下没有安全的用户消息切点");
  const forced = safeSplitIndex(items, 20000, { force: true });
  assert.ok(forced > 0, "强制模式下必须能切");
  assert.ok(!["function_call_output", "custom_tool_call_output"].includes(items[forced].type), "尾巴不能以工具输出开头");
});

test("压不动时缩短较早的工具输出，调用与返回仍然成对", () => {
  const items = [];
  for (let index = 0; index < 10; index += 1) {
    items.push({ role: "user", content: [{ type: "input_text", text: `第 ${index} 轮` }] });
    items.push({ type: "function_call", name: "exec", call_id: `c${index}`, arguments: "{}" });
    items.push({ type: "function_call_output", call_id: `c${index}`, output: "y".repeat(20000) });
  }
  const payload = { input: items, max_output_tokens: 100 };
  const before = estimateTokens(payload, 0);
  const trimmed = trimOldToolOutputs(payload, 20000);
  assert.ok(trimmed, "应该能缩");
  assert.equal(trimmed.input.length, items.length, "条目数量不变");
  const after = estimateTokens({ input: trimmed.input, max_output_tokens: 100 }, 0);
  assert.ok(after < before, `应该变小：${before} → ${after}`);
  const calls = new Set(trimmed.input.filter((item) => item.type === "function_call").map((item) => item.call_id));
  for (const item of trimmed.input.filter((entry) => entry.type === "function_call_output")) {
    assert.ok(calls.has(item.call_id), "工具返回不能悬空");
  }
});

test("要压缩的流式请求先发心跳注释，Codex 不会以为卡死而超时", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cma-beat-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ModelStore(root);
  const upstreamURL = await listen(http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: /上下文压缩/.test(body) ? "摘要" : "MODEL_ASSISTANT_OK" } }], usage: {} }));
    });
  }), context);
  await store.read();
  await store.save({ id: "beat-ctx", name: "心跳窗口", endpoint: upstreamURL, protocol: "chat", model: "beat-ctx", contextWindow: 100000, credentialID: "beat-ctx" }, 1, "k1");
  const gateway = await listen(createGateway(store), context);
  const headers = { "content-type": "application/json", authorization: `Bearer ${await store.token("router")}` };
  const history = [];
  for (let index = 0; index < 20; index += 1) {
    history.push(user(`第 ${index} 轮：${"x".repeat(20000)}`));
    history.push(assistant(`第 ${index} 轮完成`));
  }
  const response = await fetch(`${gateway}/router/v1/responses`, {
    method: "POST", headers, body: JSON.stringify({ model: "beat-ctx", input: history, stream: true, max_output_tokens: 200 }),
  });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.ok(text.startsWith(": compacting"), `第一段必须是压缩心跳而不是空白：${JSON.stringify(text.slice(0, 40))}`);
  assert.match(text, /MODEL_ASSISTANT_OK/);
});
