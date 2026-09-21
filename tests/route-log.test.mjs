import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { ModelStore } from "../src/model-store.mjs";
import { confirmRoute, createGateway, noteFallback, noteRoute } from "../src/model-gateway.mjs";
import { ProductService, readFallbackEvents, readRecentRoutes, readUsageReport } from "../src/product-service.mjs";

// 这一组测试是为了钉住一个真实踩过的坑：
// model-gateway 里 import 的是 node:fs（回调版），但「留痕」函数用 await fs.readFile / fs.writeFile 写文件。
// 那两个调用会直接抛 TypeError（缺少 callback），又被外层 catch{} 吞掉——
// 结果是一条记录都没写下来，而调用方以为成功了。当时我据此告诉用户「fallback 0 次」，
// 其实那个 0 什么都不能证明。所以必须有测试真的去读文件，而不是只看返回值。
async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cma-route-log-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return new ModelStore(root);
}

// 直接调用 noteRoute 的测试仍允许等待异步文件系统抖动；真实网关请求另有测试锁定：
// 客户端看到响应完成时，对应路由必须已经确认并落盘。
async function waitFor(check, { timeout = 2000, step = 20 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
}

async function listen(server, context) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("noteRoute / noteFallback 真的把记录写进磁盘（不是只有返回值）", async (context) => {
  const store = await fixture(context);
  await noteRoute(store.root, { id: "r1", name: "路由一", endpoint: "https://opencode.ai/zen/go/v1" }, { model: "m", sessionId: "thread-123" });
  await noteFallback(store.root, { id: "a", name: "A" }, { id: "b", name: "B" }, "测试原因", { sessionId: "thread-123" });

  const routes = JSON.parse(await fs.readFile(path.join(store.root, "route-log.json"), "utf8"));
  assert.equal(routes.length, 1);
  assert.equal(routes[0].route, "r1");
  assert.equal(routes[0].host, "opencode.ai", "应该记下真实域名，用户就是靠这个核对扣费方");
  assert.equal(routes[0].sessionId, "thread-123", "路由日志必须绑定具体对话，否则无法回答哪条对话在扣费");

  const fallbacks = JSON.parse(await fs.readFile(path.join(store.root, "fallback-events.json"), "utf8"));
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0].fromName, "A");
  assert.equal(fallbacks[0].toName, "B");
  assert.equal(fallbacks[0].sessionId, "thread-123", "fallback 事件必须能追到具体 thread");
});

test("路由审计写不进磁盘时必须阻止调用，不能吞错后继续花费", async (context) => {
  const store = await fixture(context);
  const blocker = path.join(store.root, "not-a-directory");
  await fs.writeFile(blocker, "x");
  await assert.rejects(
    noteRoute(blocker, { id: "paid", name: "付费模型", endpoint: "https://provider.example/v1", protocol: "responses" }, { model: "expensive" }),
    /ENOTDIR|not a directory/i,
  );
  await assert.rejects(confirmRoute(store.root, "missing-request"), /路由确认记录丢失/);
});

test("读回来的是同一批（读接口不能自己 catch 成空数组掩盖问题）", async (context) => {
  const store = await fixture(context);
  assert.deepEqual(await readRecentRoutes(store.root), []);
  await noteRoute(store.root, { id: "r1", name: "路由一", endpoint: "https://api.deepseek.com/v1" }, {});
  const routes = await waitFor(async () => {
    const list = await readRecentRoutes(store.root);
    return list.length ? list : null;
  });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].host, "api.deepseek.com");
});

test("首选失败改用备用时，两个文件都要留下证据，界面才看得到", async (context) => {
  const store = await fixture(context);
  let primaryHits = 0;
  const primaryURL = await listen(http.createServer((request, response) => {
    primaryHits += 1;
    request.resume();
    request.on("end", () => { response.statusCode = 500; response.end("{}"); });
  }), context);
  const fallbackURL = await listen(http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: "FALLBACK_OK" } }], usage: {} }));
    });
  }), context);
  await store.read();
  await store.save({ id: "primary", name: "首选", endpoint: primaryURL, protocol: "chat", model: "primary", contextWindow: 200000, credentialID: "primary", fallback: "backup" }, 1, "k1");
  const data = await store.read();
  await store.save({ id: "backup", name: "备用", endpoint: fallbackURL, protocol: "chat", model: "backup", contextWindow: 200000, credentialID: "backup" }, data.revision, "k2");

  const gateway = await listen(createGateway(store), context);
  const headers = { "content-type": "application/json", authorization: `Bearer ${await store.token("router")}` };
  const response = await fetch(`${gateway}/router/v1/responses`, {
    method: "POST", headers,
    body: JSON.stringify({ model: "primary", session_id: "thread-fallback-1", input: [{ role: "user", content: [{ type: "input_text", text: "你好" }] }], stream: false }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /FALLBACK_OK/);
  assert.equal(primaryHits, 1, "首选确实被打过一次");

  const fallbacks = await waitFor(async () => {
    const list = await readFallbackEvents(store.root);
    return list.length ? list : null;
  });
  assert.equal(fallbacks.length, 1, "用了备用就必须留下记录");
  assert.equal(fallbacks[0].from, "primary");
  assert.equal(fallbacks[0].to, "backup");
  assert.equal(fallbacks[0].sessionId, "thread-fallback-1");
  // 记的是真实失败原因，不是占位文案——用户看到「为什么换了」才有用
  assert.match(fallbacks[0].reason, /HTTP 500/);

  const routes = await readRecentRoutes(store.root);
  // 两条：首选那次确实发出去了（真的到了对方服务器、真的可能计费），然后才是备用。
  // 只记一条会掩盖「首选也被调用过」这个事实。
  assert.equal(routes.length, 2);
  assert.equal(routes[0].route, "backup");
  assert.equal(routes[0].fallback, true);
  assert.equal(routes[0].status, "completed");
  assert.equal(routes[0].confirmed, true);
  assert.equal(routes[0].sessionId, "thread-fallback-1");
  assert.equal(routes[1].route, "primary");
  assert.equal(routes[1].fallback, false);
  assert.equal(routes[1].status, "failed");
  assert.equal(routes[1].confirmed, false);
  assert.equal(routes[1].sessionId, "thread-fallback-1");

  // 界面拿到的就是这两份数据
  const service = new ProductService(store);
  const summary = await service.switchSummary();
  assert.equal(summary.fallbacks.length, 1);
  assert.equal(summary.recentRoutes[0].route, "backup");
});

// 用户要跟两边后台对账，需要的是「今天请求都去了谁」，不是最近 10 条。
// 这条钉住按天累计真的在写、且读得回来。
test("按天累计：今天每个上游各收到多少次请求", async (context) => {
  const store = await fixture(context);
  await noteRoute(store.root, { id: "a", name: "A", endpoint: "https://opencode.ai/zen/go/v1" }, {});
  await noteRoute(store.root, { id: "a", name: "A", endpoint: "https://opencode.ai/zen/go/v1" }, {});
  await noteRoute(store.root, { id: "b", name: "B", endpoint: "https://api.deepseek.com/v1" }, { fallback: true });

  const report = await readUsageReport(store.root, 1);
  assert.equal(report.length, 1, "只该有今天这一天的桶");
  assert.equal(report[0].total, 3);
  assert.equal(report[0].hosts["opencode.ai"], 2);
  assert.equal(report[0].hosts["api.deepseek.com"], 1);
  assert.equal(report[0].fallbacks["api.deepseek.com"], 1, "备用要单独计数，否则看不出来钱被记到了别处");

  const summary = await new ProductService(store).switchSummary();
  assert.equal(summary.todayUsage.total, 3);
});

// 压缩摘要是「上下文最大的那次请求」，同样真花钱，而且它绕过了路由候选循环。
// 之前它完全不在账上——用户问「今天请求都去了谁」时会漏掉这笔。
test("压缩摘要的请求也记账，否则对账是漏的", async (context) => {
  const store = await fixture(context);
  let summaryHits = 0;
  const upstreamURL = await listen(http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const isSummary = /上下文压缩/.test(body);
      if (isSummary) summaryHits += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: isSummary ? "摘要内容" : "OK" } }], usage: {} }));
    });
  }), context);
  await store.read();
  await store.save({ id: "small", name: "小窗口", endpoint: upstreamURL, protocol: "chat", model: "small", contextWindow: 100000, credentialID: "small" }, 1, "k1");
  const gateway = await listen(createGateway(store), context);
  const headers = { "content-type": "application/json", authorization: `Bearer ${await store.token("router")}` };
  const history = [];
  for (let index = 0; index < 20; index += 1) {
    history.push({ role: "user", content: [{ type: "input_text", text: `第 ${index} 轮：${"x".repeat(20000)}` }] });
    history.push({ role: "assistant", content: [{ type: "input_text", text: `第 ${index} 轮完成` }] });
  }
  const response = await fetch(`${gateway}/router/v1/responses`, {
    method: "POST", headers,
    body: JSON.stringify({ model: "small", input: history, stream: false, max_output_tokens: 100 }),
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.ok(summaryHits >= 1, "应该真的发生过一次摘要请求");

  const report = await waitFor(async () => {
    const list = await readUsageReport(store.root, 1);
    const entry = list.at(-1);
    return entry && entry.summaries && Object.keys(entry.summaries).length ? entry : null;
  });
  // noteRoute 记的是 hostname（不含端口），别拿 host 去比
  const host = new URL(upstreamURL).hostname;
  assert.ok((report.summaries[host] ?? 0) >= 1, `摘要请求要单独计数：${JSON.stringify(report)}`);
  assert.ok(report.total >= 2, "摘要 + 正文都该算进总数");
  const routes = await readRecentRoutes(store.root);
  assert.ok(routes.some((entry) => entry.kind === "summary"), "滚动记录里也要能看出哪笔是摘要");
});
