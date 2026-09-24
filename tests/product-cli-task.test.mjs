import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("run-task CLI 对无合格路线的任务拒绝执行并只记录安全证据", (context) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "model-router-task-cli-"));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const text = "敏感任务内容只允许发给选中的执行模型，不能写进日志。";
  const run = spawnSync(process.execPath, [path.resolve("src/product-cli.mjs"), "run-task"], {
    env: { ...process.env, HOME: home },
    input: JSON.stringify({ text, complexity: "simple", category: "planning", acceptancePhrase: "完成" }),
    encoding: "utf8", timeout: 20_000,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout);
  assert.equal(result.ok, false);
  assert.equal(result.status, "rejected");
  assert.equal(result.acceptance.passed, false);
  assert.equal(result.output, "");
  assert.equal(result.attempts.length, 0);
  assert.ok(result.taskId);
  const log = fs.readFileSync(path.join(home, ".codex/model-assistant/task-runs", `${result.taskId}.json`), "utf8");
  assert.doesNotMatch(log, /敏感任务内容/);
  assert.equal(JSON.parse(log).status, "rejected");
});
