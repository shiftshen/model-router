import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { desktopEnvironment, linkSharedAsset, normalizeProcessText, parseWindowsAppxCandidates, rankMacChatGPTAppCandidates, windowsProcessRows } from "../src/platform-runtime.mjs";

test("Desktop children do not inherit Electron service mode, while route isolation remains intact", () => {
  const original = {ELECTRON_RUN_AS_NODE:"1",electron_run_as_node:"1",CODEX_HOME:"isolated",CMA_ROUTE_TOKEN:"fixture",PATH:"original"};
  assert.deepEqual(desktopEnvironment(original), {CODEX_HOME:"isolated",CMA_ROUTE_TOKEN:"fixture",PATH:"original"});
  assert.equal(original.ELECTRON_RUN_AS_NODE, "1");
});

test("Windows 进程 JSON 会规范成可供现有窗口解析器使用的正斜杠命令行", () => {
  const rows = windowsProcessRows(JSON.stringify([
    { ProcessId: 42, CommandLine: 'C:\\Program Files\\ChatGPT\\ChatGPT.exe --user-data-dir=C:\\Users\\me\\.codex\\model-assistant\\windows-v1\\w2\\browser-data', ExecutablePath: 'C:\\Program Files\\ChatGPT\\ChatGPT.exe' },
  ]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pid, 42);
  assert.match(rows[0].command, /C:\/Program Files\/ChatGPT/);
  assert.match(rows[0].command, /--user-data-dir=C:\/Users\/me/);
  assert.equal(normalizeProcessText("C:\\a\\b"), "C:/a/b");
});

test("AppX 清单候选兼容单对象与数组", () => {
  const one = parseWindowsAppxCandidates(JSON.stringify({
    Name: "OpenAI.ChatGPT",
    PackageFamilyName: "OpenAI.ChatGPT_123",
    InstallLocation: "C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT",
    Executable: "app\\ChatGPT.exe",
    AppId: "App",
    DisplayName: "ChatGPT",
  }));
  assert.equal(one.length, 1);
  assert.equal(one[0].executable, "app\\ChatGPT.exe");
  const many = parseWindowsAppxCandidates(JSON.stringify([one[0], one[0]]));
  assert.equal(many.length, 2);
});

test("macOS 官方桌面候选优先新版 ChatGPT.app，同时保留 Codex.app 兼容", () => {
  const ranked = rankMacChatGPTAppCandidates([
    "/Applications/Codex.app",
    "/Applications/ChatGPT.app",
    "/Users/test/Applications/ChatGPT.app",
  ]);
  assert.equal(ranked[0], "/Applications/ChatGPT.app");
  assert.ok(ranked.indexOf("/Applications/Codex.app") > ranked.indexOf("/Applications/ChatGPT.app"));
});

test("共享资源：文件与目录链接保持实时可见，Windows 不要求管理员 symlink", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cma-platform-link-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));

  const sourceFile = path.join(root, "source", "auth.json");
  const targetFile = path.join(root, "window", "auth.json");
  await fs.mkdir(path.dirname(sourceFile), { recursive: true });
  await fs.writeFile(sourceFile, "one");
  await linkSharedAsset(sourceFile, targetFile);
  assert.equal(await fs.readFile(targetFile, "utf8"), "one");
  await fs.writeFile(sourceFile, "two");
  assert.equal(await fs.readFile(targetFile, "utf8"), "two");

  const sourceDir = path.join(root, "source", "skills");
  const targetDir = path.join(root, "window", "skills");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, "one.txt"), "A");
  await linkSharedAsset(sourceDir, targetDir);
  assert.equal(await fs.readFile(path.join(targetDir, "one.txt"), "utf8"), "A");
  await fs.writeFile(path.join(sourceDir, "two.txt"), "B");
  assert.equal(await fs.readFile(path.join(targetDir, "two.txt"), "utf8"), "B");
});
