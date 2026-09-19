import test from "node:test";
import assert from "node:assert/strict";

import {
  checksumForAsset,
  compareVersions,
  macInstallerScriptText,
  normalizeVersion,
  selectUpdateRelease,
} from "../src/update-service.mjs";

function release(tag, { prerelease = false, assets = [] } = {}) {
  return {
    tag_name: tag,
    name: tag,
    draft: false,
    prerelease,
    html_url: `https://github.com/shiftshen/model-router/releases/tag/${tag}`,
    published_at: "2026-09-20T00:00:00Z",
    assets: assets.map((name) => ({ name, browser_download_url: `https://example.test/${name}`, size: 123 })),
  };
}

test("版本比较只看 X.Y.Z，preview tag 也能提取基础版本", () => {
  assert.equal(normalizeVersion("v3.1.0-windows-preview.1"), "3.1.0");
  assert.equal(compareVersions("3.1.0", "3.0.9"), 1);
  assert.equal(compareVersions("3.0.3", "3.0.3"), 0);
  assert.equal(compareVersions("3.0.2", "3.0.3"), -1);
});

test("SHA256 文件兼容纯文件名与 release/ 前缀路径", () => {
  const hash = "a".repeat(64);
  assert.equal(checksumForAsset(`${hash}  Model-Router-3.1.0-universal.dmg`, "Model-Router-3.1.0-universal.dmg"), hash);
  assert.equal(checksumForAsset(`${hash}  release/Model-Router-3.1.0-universal.dmg`, "Model-Router-3.1.0-universal.dmg"), hash);
  assert.equal(checksumForAsset(`${hash}  release\\Model-Router-3.1.0-universal.dmg`, "Model-Router-3.1.0-universal.dmg"), hash);
  assert.equal(checksumForAsset(`${hash}  Model Router Setup 3.1.0.exe`, "Model.Router.Setup.3.1.0.exe"), hash);
});

test("macOS updater helper 包含验证、回滚与重开步骤", () => {
  const script = macInstallerScriptText();
  assert.match(script, /hdiutil verify/);
  assert.match(script, /codesign --verify --deep --strict/);
  assert.match(script, /spctl --assess --type execute/);
  assert.match(script, /TARGET\.update-old/);
  assert.match(script, /\/usr\/bin\/open/);
  assert.match(script, /CMA_UPDATE_SKIP_REOPEN/);
});

test("macOS 只选最新稳定 DMG，不把 Windows prerelease 当更新", () => {
  const releases = [
    release("v3.2.0-windows-preview.1", {
      prerelease: true,
      assets: ["Model.Router.Setup.3.2.0.exe", "SHA256SUMS-windows.txt"],
    }),
    release("v3.1.0", {
      assets: ["Model-Router-3.1.0-universal.dmg", "Model-Router-3.1.0-SHA256.txt"],
    }),
    release("v3.0.3", {
      assets: ["Model-Router-3.0.3-universal.dmg", "Model-Router-3.0.3-SHA256.txt"],
    }),
  ];
  const selected = selectUpdateRelease(releases, { currentVersion: "3.0.3", platform: "darwin" });
  assert.equal(selected.version, "3.1.0");
  assert.equal(selected.files.asset.name, "Model-Router-3.1.0-universal.dmg");
});

test("Windows 安装版与 Portable 各选自己的资产，并允许 Preview release", () => {
  const releases = [
    release("v3.1.0-windows-preview.1", {
      prerelease: true,
      assets: [
        "Model.Router.Setup.3.1.0.exe",
        "Model.Router.3.1.0.exe",
        "SHA256SUMS-windows.txt",
      ],
    }),
  ];
  const installed = selectUpdateRelease(releases, { currentVersion: "3.0.3", platform: "win32", variant: "installed" });
  const portable = selectUpdateRelease(releases, { currentVersion: "3.0.3", platform: "win32", variant: "portable" });
  assert.equal(installed.files.asset.name, "Model.Router.Setup.3.1.0.exe");
  assert.equal(portable.files.asset.name, "Model.Router.3.1.0.exe");
});

test("没有比当前版本新的 Release 时返回 null", () => {
  const releases = [
    release("v3.0.3", { assets: ["Model-Router-3.0.3-universal.dmg"] }),
    release("v3.0.2", { assets: ["Model-Router-3.0.2-universal.dmg"] }),
  ];
  assert.equal(selectUpdateRelease(releases, { currentVersion: "3.0.3", platform: "darwin" }), null);
});
