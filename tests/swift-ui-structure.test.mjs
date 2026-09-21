import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const sourcePath = new URL("../Sources/CodexModelAssistantApp.swift", import.meta.url);

test("macOS 模型库二级 sheet 必须挂在模型库层，不能退回底层主窗口", async () => {
  const source = await fs.readFile(sourcePath, "utf8");
  const modelLibraryStart = source.indexOf("private var modelLibrary");
  const renameStart = source.indexOf("private func renameSheet", modelLibraryStart);
  assert.ok(modelLibraryStart > 0 && renameStart > modelLibraryStart);

  const root = source.slice(0, modelLibraryStart);
  const modelLibrary = source.slice(modelLibraryStart, renameStart);

  assert.match(root, /\.sheet\(isPresented: \$showModels\)/);
  assert.doesNotMatch(root, /\.sheet\(item: \$editing\)/, "编辑 sheet 挂在底层窗口会导致模型库里的 + 看似点不动");
  assert.doesNotMatch(root, /\.sheet\(isPresented: \$library\.showDiscovery\)/);
  assert.doesNotMatch(root, /\.sheet\(isPresented: \$library\.showDiagnostics\)/);

  assert.match(modelLibrary, /\.sheet\(item: \$editing\)/);
  assert.match(modelLibrary, /\.sheet\(isPresented: \$library\.showDiscovery\)/);
  assert.match(modelLibrary, /\.sheet\(isPresented: \$library\.showDiagnostics\)/);
});

test("macOS 活跃对话必须可点击打开所属窗口，并显示 Thread 追踪信息", async () => {
  const source = await fs.readFile(sourcePath, "utf8");
  const start = source.indexOf("private func liveThreadRow");
  const end = source.indexOf("private func threadColor", start);
  const block = source.slice(start, end);
  assert.match(block, /Button\s*\{/);
  assert.match(block, /library\.openThread\(thread\)/);
  assert.match(block, /复制 Thread ID/);
  assert.match(block, /thread\.scope/);
  assert.match(block, /thread\.id\.prefix\(8\)/);
});

test("fallback banner 必须说明 fallback 是单次请求，不得暗示整窗持续使用备用", async () => {
  const source = await fs.readFile(sourcePath, "utf8");
  const start = source.indexOf("private func fallbackBanner");
  const end = source.indexOf("private func fallbackIsRecent", start);
  const block = source.slice(start, end);
  assert.match(block, /只对那一次失败请求生效/);
  assert.match(block, /历史备用切换记录/);
  assert.match(block, /当前规则/);
  assert.match(block, /Thread ID/);
});

test("macOS 与 Windows 必须显示官方账号、提供账号同步，并区分已确认与未确认路由", async () => {
  const source = await fs.readFile(sourcePath, "utf8");
  const modelLibrary = await fs.readFile(new URL("../Sources/ModelLibrary.swift", import.meta.url), "utf8");
  const renderer = await fs.readFile(new URL("../windows/renderer.js", import.meta.url), "utf8");
  const html = await fs.readFile(new URL("../windows/index.html", import.meta.url), "utf8");
  assert.match(source, /library\.officialAccount\.label/);
  assert.match(source, /Button\("更换账号"\)/);
  assert.match(source, /library\.syncAccount\(\)/);
  assert.match(source, /只有“已确认”表示对应上游成功完成请求/);
  assert.match(modelLibrary, /response\.officialAccount/);
  assert.match(modelLibrary, /"sync-account"/);
  assert.match(html, /id="accountStatus"/);
  assert.match(html, /data-account-sync="1"/);
  assert.match(renderer, /state\.officialAccount/);
  assert.match(renderer, /latest\.confirmed/);
  assert.match(renderer, /call\("sync-account"\)/);
});

test("macOS 在线更新入口必须保留启动检查、周期检查与安装动作", async () => {
  const source = await fs.readFile(sourcePath, "utf8");
  assert.match(source, /Timer\.publish\(every: 6 \* 3600/);
  assert.match(source, /checkForUpdates\(currentVersion: bundleVersion, silent: true\)/);
  assert.match(source, /Button\("检查更新…"\)/);
  assert.match(source, /installUpdate\(currentVersion: bundleVersion\)/);
  assert.ok(source.includes('Button("新版 \\(library.updateInfo?.latestVersion'));
});

test("Windows 在线更新入口必须保留检查按钮、启动检查与安装 IPC", async () => {
  const renderer = await fs.readFile(new URL("../windows/renderer.js", import.meta.url), "utf8");
  const main = await fs.readFile(new URL("../windows/main.mjs", import.meta.url), "utf8");
  const html = await fs.readFile(new URL("../windows/index.html", import.meta.url), "utf8");
  assert.match(html, /id="updateBtn"/);
  assert.match(renderer, /checkUpdate\(true\)/);
  assert.match(renderer, /prepare-update/);
  assert.match(renderer, /installUpdate/);
  assert.match(main, /cma:install-update/);
  assert.match(main, /prepare-update/);
});
