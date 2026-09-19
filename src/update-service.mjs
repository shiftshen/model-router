import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const repo = "shiftshen/model-router";
const apiBase = `https://api.github.com/repos/${repo}`;
const userAgent = "Model-Router-Updater";

export function normalizeVersion(value) {
  const match = String(value ?? "").trim().match(/(?:^|v)(\d+)\.(\d+)\.(\d+)/i);
  if (!match) return "";
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
}

export function compareVersions(a, b) {
  const left = normalizeVersion(a).split(".").map(Number);
  const right = normalizeVersion(b).split(".").map(Number);
  if (left.length !== 3 || right.length !== 3 || left.some(Number.isNaN) || right.some(Number.isNaN)) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

function versionFromRelease(release) {
  return normalizeVersion(release?.tag_name || release?.name || "");
}

function assetForRelease(release, platform, variant = "installed") {
  const version = versionFromRelease(release);
  if (!version || !Array.isArray(release?.assets)) return null;
  if (platform === "darwin") {
    const name = `Model-Router-${version}-universal.dmg`;
    const checksumName = `Model-Router-${version}-SHA256.txt`;
    const asset = release.assets.find((item) => item.name === name);
    if (!asset) return null;
    return {
      asset,
      checksum: release.assets.find((item) => item.name === checksumName) ?? null,
    };
  }
  if (platform === "win32") {
    const name = variant === "portable" ? `Model.Router.${version}.exe` : `Model.Router.Setup.${version}.exe`;
    const asset = release.assets.find((item) => item.name === name);
    if (!asset) return null;
    return {
      asset,
      checksum: release.assets.find((item) => item.name === "SHA256SUMS-windows.txt") ?? null,
    };
  }
  return null;
}

export function selectUpdateRelease(releases, { currentVersion, platform = process.platform, variant = "installed" } = {}) {
  const current = normalizeVersion(currentVersion);
  const candidates = [];
  for (const release of Array.isArray(releases) ? releases : []) {
    if (release?.draft) continue;
    if (platform === "darwin" && release?.prerelease) continue;
    const version = versionFromRelease(release);
    const files = assetForRelease(release, platform, variant);
    if (!version || !files) continue;
    if (current && compareVersions(version, current) <= 0) continue;
    candidates.push({ release, version, files });
  }
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  return candidates[0] ?? null;
}

async function request(url, { timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": userAgent,
      },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkForUpdate({ currentVersion, platform = process.platform, variant = "installed", fetchReleases = null } = {}) {
  const current = normalizeVersion(currentVersion);
  if (!current) throw new Error(`当前版本号无效：${currentVersion}`);
  const releases = fetchReleases
    ? await fetchReleases()
    : await (await request(`${apiBase}/releases?per_page=30`)).json();
  const selected = selectUpdateRelease(releases, { currentVersion: current, platform, variant });
  if (!selected) {
    return {
      available: false,
      currentVersion: current,
      latestVersion: current,
      releaseUrl: `https://github.com/${repo}/releases`,
      message: `当前已是最新版本 ${current}`,
    };
  }
  const { release, version, files } = selected;
  return {
    available: true,
    currentVersion: current,
    latestVersion: version,
    tag: release.tag_name,
    releaseUrl: release.html_url || `https://github.com/${repo}/releases/tag/${release.tag_name}`,
    publishedAt: release.published_at || "",
    notes: String(release.body || "").slice(0, 6000),
    assetName: files.asset.name,
    assetUrl: files.asset.browser_download_url,
    assetSize: Number(files.asset.size || 0),
    checksumName: files.checksum?.name || "",
    checksumUrl: files.checksum?.browser_download_url || "",
    message: `发现新版本 ${version}`,
  };
}

async function sha256File(file) {
  const hash = createHash("sha256");
  const handle = await fs.open(file, "r");
  try {
    const stream = handle.createReadStream();
    for await (const chunk of stream) hash.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
  return hash.digest("hex");
}

function canonicalAssetName(value) {
  return path.posix.basename(String(value ?? "").trim().replaceAll("\\", "/"))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function checksumForAsset(text, assetName) {
  const wanted = canonicalAssetName(assetName);
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (!match) continue;
    const listed = match[2].trim().replaceAll("\\", "/");
    if (listed === assetName || path.posix.basename(listed) === assetName || canonicalAssetName(listed) === wanted) return match[1].toLowerCase();
  }
  return "";
}

export async function downloadUpdate(info, { root = path.join(os.homedir(), ".codex", "model-assistant") } = {}) {
  if (!info?.available || !info.assetUrl || !info.assetName) throw new Error("没有可下载的新版本");
  const directory = path.join(root, "updates", info.latestVersion);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, info.assetName);
  const temp = `${target}.part`;
  await fs.rm(temp, { force: true }).catch(() => {});

  const response = await request(info.assetUrl, { timeoutMs: 120000 });
  if (!response.body) throw new Error("GitHub 没有返回下载内容");
  await pipeline(Readable.fromWeb(response.body), (await fs.open(temp, "w", 0o600)).createWriteStream());
  await fs.rename(temp, target);

  const actual = await sha256File(target);
  let expected = "";
  if (info.checksumUrl) {
    const checksumText = await (await request(info.checksumUrl, { timeoutMs: 30000 })).text();
    expected = checksumForAsset(checksumText, info.assetName);
    if (!expected) throw new Error(`校验文件里没有找到 ${info.assetName}`);
    if (actual !== expected) {
      await fs.rm(target, { force: true }).catch(() => {});
      throw new Error(`下载校验失败：SHA256 不匹配（实际 ${actual}）`);
    }
  }
  return { path: target, sha256: actual, expectedSha256: expected || actual };
}

export function macInstallerScriptText() {
  return `#!/bin/zsh
set -euo pipefail
PID="$1"
DMG="$2"
TARGET="$3"
LOG="$4"
exec >>"$LOG" 2>&1
echo "[$(date -u +%FT%TZ)] updater start"
for i in {1..600}; do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.25
done
if kill -0 "$PID" 2>/dev/null; then
  echo "Model Router did not quit"
  exit 20
fi
/usr/bin/hdiutil verify "$DMG"
MOUNT="$(/usr/bin/mktemp -d /tmp/model-router-update.XXXXXX)"
cleanup() {
  /usr/bin/hdiutil detach "$MOUNT" -quiet >/dev/null 2>&1 || true
  /bin/rm -rf "$MOUNT"
}
trap cleanup EXIT
/usr/bin/hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT" "$DMG" >/dev/null
SOURCE="$MOUNT/Model Router.app"
[[ -d "$SOURCE" ]] || { echo "Model Router.app missing from DMG"; exit 21; }
/usr/bin/codesign --verify --deep --strict "$SOURCE"
/usr/sbin/spctl --assess --type execute "$SOURCE"
TMP="$TARGET.update-new"
BACKUP="$TARGET.update-old"
/bin/rm -rf "$TMP" "$BACKUP"
/usr/bin/ditto "$SOURCE" "$TMP"
if [[ -d "$TARGET" ]]; then /bin/mv "$TARGET" "$BACKUP"; fi
if ! /bin/mv "$TMP" "$TARGET"; then
  [[ -d "$BACKUP" ]] && /bin/mv "$BACKUP" "$TARGET"
  exit 22
fi
if [[ "\${CMA_UPDATE_SKIP_REOPEN:-0}" != "1" ]]; then /usr/bin/open "$TARGET"; fi
/bin/rm -rf "$BACKUP"
echo "[$(date -u +%FT%TZ)] updater success"
`;
}

async function writeMacInstaller({ root, dmgPath, targetApp, appPid }) {
  const updates = path.join(root, "updates");
  await fs.mkdir(updates, { recursive: true, mode: 0o700 });
  const script = path.join(updates, "install-macos-update.sh");
  const log = path.join(updates, "install-macos-update.log");
  const body = macInstallerScriptText();
  await fs.writeFile(script, body, { mode: 0o700 });
  const child = spawn("/bin/zsh", [script, String(appPid), dmgPath, targetApp, log], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { script, log, pid: child.pid };
}

export async function prepareUpdate({
  currentVersion,
  platform = process.platform,
  root = path.join(os.homedir(), ".codex", "model-assistant"),
  appPid = 0,
  appPath = "",
  portable = false,
} = {}) {
  const variant = portable ? "portable" : "installed";
  const info = await checkForUpdate({ currentVersion, platform, variant });
  if (!info.available) return { ...info, prepared: false };
  const downloaded = await downloadUpdate(info, { root });

  if (platform === "darwin") {
    if (!appPath || !/\.app$/i.test(appPath)) throw new Error("无法确定当前 Model Router.app 路径");
    if (!Number.isInteger(Number(appPid)) || Number(appPid) <= 0) throw new Error("无法确定当前 Model Router 进程号");
    const helper = await writeMacInstaller({
      root,
      dmgPath: downloaded.path,
      targetApp: appPath,
      appPid: Number(appPid),
    });
    return { ...info, prepared: true, downloadedPath: downloaded.path, sha256: downloaded.sha256, helperPid: helper.pid };
  }

  if (platform === "win32") {
    return {
      ...info,
      prepared: true,
      downloadedPath: downloaded.path,
      sha256: downloaded.sha256,
      portable: Boolean(portable),
    };
  }

  throw new Error(`暂不支持平台：${platform}`);
}
