import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseValidationJSON, scoreValidation, summarizeValidation, validationTasks, validationPrompt } from "../src/model-validation.mjs";

test("能力验证任务集覆盖规划、前端、后端、调试、工具和长上下文", () => {
  assert.deepEqual(validationTasks.map((task) => task.category), ["planning", "frontend", "backend", "debugging", "tool_use", "long_context"]);
  assert.ok(validationTasks.every((task) => validationPrompt(task).includes("只返回一个 JSON")));
});

test("解析带 Markdown 围栏或前后解释的 JSON", () => {
  assert.deepEqual(parseValidationJSON("```json\n{\"x\":1}\n```"), { x: 1 });
  assert.deepEqual(parseValidationJSON("结果：{\"x\":1}"), { x: 1 });
  assert.equal(parseValidationJSON("不是 JSON"), null);
});

test("按能力任务评分并报告失败原因", () => {
  const task = validationTasks.find((item) => item.id === "frontend");
  const result = scoreValidation(task, { task_type: "frontend", verification_steps: [1, 2, 3], accessibility: "check" });
  assert.equal(result.score, 100);
  const failed = scoreValidation(task, { task_type: "backend" });
  assert.equal(failed.score, 0);
  assert.ok(failed.reasons.length > 0);
});

test("工具安全任务要求删除和外部调用都确认", () => {
  const task = validationTasks.find((item) => item.id === "tool_safety");
  const result = scoreValidation(task, { actions: [
    { action: "删除历史会话", requires_confirmation: true },
    { action: "发送外部 API 请求", requires_confirmation: true },
    { action: "读取项目文件", requires_confirmation: false },
    { action: "修改源代码", requires_confirmation: true },
  ] });
  assert.equal(result.score, 100);
});

test("汇总按类别返回结果，供后续 JEV/Resolver 使用", () => {
  const route = { id: "r1", model: "test-model" };
  const results = validationTasks.slice(0, 2).map((task) => scoreValidation(task, {}));
  const summary = summarizeValidation(route, results);
  assert.equal(summary.routeId, "r1");
  assert.deepEqual(Object.keys(summary.byCategory), ["planning", "frontend"]);
});

test("未配置 Key 的真实验证拒绝发请求，也不落盘零分报告", (context) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "model-validation-no-key-"));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const command = path.resolve("src/product-cli.mjs");
  const run = spawnSync(process.execPath, [command, "validate-models", "deepseek-flash", "--live"], {
    env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(run.status, 1);
  const result = JSON.parse(run.stdout);
  assert.equal(result.ok, false);
  assert.match(result.message, /请先配置 API Key/);
  assert.equal(fs.existsSync(path.join(home, ".codex/model-assistant/validation/deepseek-flash.json")), false);
});
