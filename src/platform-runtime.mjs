import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const isWindows = process.platform === "win32";

function psEscape(value) {
  return String(value ?? "").replaceAll("'", "''");
}

async function powershell(script, options = {}) {
  const candidates = ["powershell.exe", "pwsh.exe"];
  let last;
  for (const executable of candidates) {
    try {
      return await execFileAsync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        ...options,
      });
    } catch (error) {
      last = error;
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw last ?? new Error("找不到 PowerShell");
}

export function normalizeProcessText(value) {
  return String(value ?? "").replaceAll("\\", "/");
}

export function windowsProcessRows(jsonText) {
  const text = String(jsonText ?? "").trim();
  if (!text) return [];
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .map((row) => ({
      pid: Number(row.ProcessId ?? row.processId ?? 0),
      command: normalizeProcessText(row.CommandLine || row.ExecutablePath || ""),
      executable: normalizeProcessText(row.ExecutablePath || ""),
    }))
    .filter((row) => Number.isInteger(row.pid) && row.pid > 0 && (row.command || row.executable));
}

export async function processRows() {
  if (!isWindows) {
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid,args"], { maxBuffer: 8 * 1024 * 1024 });
    return String(stdout).split("\n").map((line) => {
      const pid = Number((line.match(/^\s*(\d+)\s/) || [])[1]);
      return { pid, command: normalizeProcessText(line.replace(/^\s*\d+\s+/, "")), executable: "" };
    }).filter((row) => Number.isInteger(row.pid) && row.pid > 0 && row.command);
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "$rows = Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine,ExecutablePath",
    "$rows | ConvertTo-Json -Compress",
  ].join("; ");
  const { stdout } = await powershell(script);
  return windowsProcessRows(stdout);
}

export async function processListingText() {
  const rows = await processRows();
  return rows.map((row) => `${row.pid} ${row.command || row.executable}`).join("\n");
}

export async function processCommand(pid) {
  const target = Number(pid);
  if (!Number.isInteger(target) || target <= 0) return "";
  if (!isWindows) {
    try {
      const { stdout } = await execFileAsync("/bin/ps", ["-p", String(target), "-o", "args="], { maxBuffer: 1024 * 1024 });
      return normalizeProcessText(stdout).trim();
    } catch {
      return "";
    }
  }
  const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${target}" -ErrorAction SilentlyContinue; if($p){$p.CommandLine}`;
  try {
    const { stdout } = await powershell(script, { maxBuffer: 1024 * 1024 });
    return normalizeProcessText(stdout).trim();
  } catch {
    return "";
  }
}

export async function terminateProcessTree(pid) {
  const target = Number(pid);
  if (!Number.isInteger(target) || target <= 0) throw new Error("进程号无效");
  if (target === process.pid || target === process.ppid) throw new Error("拒绝结束助手自身进程");
  if (isWindows) {
    try {
      await execFileAsync("taskkill.exe", ["/PID", String(target), "/T", "/F"], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
      return;
    } catch (error) {
      const detail = String(error.stderr ?? error.message ?? "");
      if (/not found|no running instance|找不到|不存在/i.test(detail)) return;
      throw error;
    }
  }
  try {
    process.kill(-target, "SIGTERM");
  } catch (error) {
    if (!["ESRCH", "EPERM"].includes(error.code)) throw error;
    process.kill(target, "SIGTERM");
  }
}

export async function activateProcess(pid) {
  const target = Number(pid);
  if (!Number.isInteger(target) || target <= 0) return false;
  if (isWindows) {
    const script = `$ws=New-Object -ComObject WScript.Shell; if($ws.AppActivate(${target})){exit 0}else{exit 1}`;
    try { await powershell(script); return true; } catch { return false; }
  }
  try {
    await execFileAsync("/usr/bin/osascript", ["-e", `tell application "System Events" to set frontmost of first process whose unix id is ${target} to true`]);
    return true;
  } catch {
    return false;
  }
}

export function parseWindowsAppxCandidates(jsonText) {
  const text = String(jsonText ?? "").trim();
  if (!text) return [];
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .map((row) => ({
      name: String(row.Name ?? row.name ?? ""),
      family: String(row.PackageFamilyName ?? row.family ?? ""),
      installLocation: String(row.InstallLocation ?? row.installLocation ?? ""),
      executable: String(row.Executable ?? row.executable ?? ""),
      appId: String(row.AppId ?? row.appId ?? ""),
      displayName: String(row.DisplayName ?? row.displayName ?? ""),
    }))
    .filter((row) => row.installLocation && row.executable);
}

export function rankMacChatGPTAppCandidates(paths = []) {
  const unique = [...new Set([
    "/Applications/ChatGPT.app",
    ...paths.map((value) => String(value ?? "").trim()).filter(Boolean),
    "/Applications/Codex.app",
  ])];
  const score = (value) => {
    if (value === "/Applications/ChatGPT.app") return 100;
    if (/\/ChatGPT\.app$/i.test(value)) return 90;
    if (value === "/Applications/Codex.app") return 80;
    if (/\/Codex\.app$/i.test(value)) return 70;
    return 10;
  };
  return unique.sort((a, b) => score(b) - score(a));
}

async function macBundleExecutable(appPath) {
  const info = path.join(appPath, "Contents", "Info.plist");
  let executable = "ChatGPT";
  try {
    const { stdout } = await execFileAsync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", info], { maxBuffer: 1024 * 1024 });
    executable = String(stdout).trim() || executable;
  } catch { }
  const candidate = path.join(appPath, "Contents", "MacOS", executable);
  try { await fs.access(candidate); return candidate; } catch { return ""; }
}

export async function findMacChatGPTAppBundle() {
  if (isWindows) return null;
  let dynamic = [];
  try {
    const query = 'kMDItemCFBundleIdentifier == "com.openai.codex"c || kMDItemFSName == "ChatGPT.app"c || kMDItemFSName == "Codex.app"c';
    const { stdout } = await execFileAsync("/usr/bin/mdfind", [query], { maxBuffer: 2 * 1024 * 1024 });
    dynamic = String(stdout).split("\n").map((line) => line.trim()).filter((line) => /\.app$/i.test(line));
  } catch { }
  for (const appPath of rankMacChatGPTAppCandidates(dynamic)) {
    const executable = await macBundleExecutable(appPath);
    if (executable) return { appPath, executable };
  }
  throw new Error("没有找到官方 ChatGPT Desktop（需要安装在 /Applications 下）。请先安装或更新官方 ChatGPT 桌面应用。");
}

export async function findCodexDesktopExecutable() {
  const override = String(process.env.CMA_CODEX_DESKTOP ?? "").trim();
  if (override) {
    try { await fs.access(override); return override; }
    catch { throw new Error(`CMA_CODEX_DESKTOP 指向的文件不存在：${override}`); }
  }
  if (!isWindows) return (await findMacChatGPTAppBundle()).executable;
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$out=@()",
    "Get-AppxPackage | Where-Object { $_.Name -match 'ChatGPT|OpenAI|Codex' -or $_.PackageFamilyName -match 'ChatGPT|OpenAI|Codex' } | ForEach-Object {",
    "  $pkg=$_; $manifest=Get-AppxPackageManifest $pkg",
    "  foreach($app in $manifest.Package.Applications.Application){",
    "    if($app.Executable){ $out += [pscustomobject]@{Name=$pkg.Name;PackageFamilyName=$pkg.PackageFamilyName;InstallLocation=$pkg.InstallLocation;Executable=$app.Executable;AppId=$app.Id;DisplayName=$app.VisualElements.DisplayName} }",
    "  }",
    "}",
    "$out | ConvertTo-Json -Compress",
  ].join("; ");
  let candidates = [];
  try {
    const { stdout } = await powershell(script);
    candidates = parseWindowsAppxCandidates(stdout);
  } catch { }
  const ranked = candidates.slice().sort((a, b) => {
    const score = (row) => /chatgpt|codex/i.test(`${row.name} ${row.family} ${row.executable} ${row.displayName}`) ? 1 : 0;
    return score(b) - score(a);
  });
  for (const row of ranked) {
    const executable = path.join(row.installLocation, row.executable);
    try { await fs.access(executable); return executable; } catch { }
  }
  throw new Error("没有找到 Windows 版 ChatGPT/Codex。请先从 Microsoft Store 安装官方 ChatGPT 桌面应用；也可以用 CMA_CODEX_DESKTOP 指定可执行文件路径。");
}

export function desktopEnvironment(env = process.env) {
  const result = { ...env };
  // The Windows Electron host uses this flag for its Node service, never for a GUI child.
  for (const key of Object.keys(result)) {
    if (key.toUpperCase() === "ELECTRON_RUN_AS_NODE") delete result[key];
  }
  return result;
}

export function officialDesktopEnvironment(env = process.env) {
  const result = desktopEnvironment(env);
  for (const key of Object.keys(result)) {
    if (/^(CODEX_HOME|CODEX_PROFILE|OPENAI_BASE_URL|OPENAI_API_KEY|CMA_.*)$/i.test(key)) delete result[key];
  }
  return result;
}

export async function activateOfficialProcess(pid) {
  const target = Number(pid);
  if (!Number.isInteger(target) || target <= 0) return false;
  if (isWindows) return activateProcess(target);
  // Address the process, not the bundle: every managed window has the same bundle ID.
  // Native activation needs neither System Events nor Accessibility permission.
  const script = `ObjC.import('AppKit'); ObjC.import('CoreGraphics');
    var pid=${target}; var app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
    var ok=false;
    if(app && !app.isTerminated){
      var target=$.NSAppleEventDescriptor.descriptorWithProcessIdentifier(pid);
      function sendAppEvent(eventID){
        var event=$.NSAppleEventDescriptor.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(0x61657674,eventID,target,-1,0);
        var error=Ref(); event.sendEventWithOptionsTimeoutError(3,2,error);
      }
      // Reopen restores a closed/hidden window; activate is still required by
      // current ChatGPT Desktop builds to make this exact process frontmost.
      sendAppEvent(0x72617070);
      sendAppEvent(0x61637476);
      app.unhide; app.activateWithOptions(3);
      for(var i=0;i<12;i++){
        delay(0.15);
        var windows=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1,0)));
        var visible=windows.some(function(w){return w.kCGWindowOwnerPID===pid && w.kCGWindowLayer===0 && w.kCGWindowBounds.Width>1 && w.kCGWindowBounds.Height>1;});
        if(Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier)===pid && visible){ok=true;break;}
      }
    }
    JSON.stringify({delivered:ok});`;
  try {
    const { stdout } = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 7000, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout).delivered === true;
  } catch { return false; }
}

export async function openOfficialChatGPTDesktop({ pid = 0 } = {}) {
  if (pid > 0) return { pid, launched: false, delivered: await activateOfficialProcess(pid) };
  if (!isWindows) {
    const app = await findMacChatGPTAppBundle();
    // The caller has checked that the default instance is absent. A plain open
    // may reuse a managed instance; -n starts the default profile independently.
    await execFileAsync("/usr/bin/open", ["-n", "-a", app.appPath], { timeout: 15000, maxBuffer: 1024 * 1024, env: officialDesktopEnvironment() });
    return { launched: true, delivered: false, appPath: app.appPath, executable: app.executable, pid: 0 };
  }
  const executable = await findCodexDesktopExecutable();
  const child = spawn(executable, [], { env: officialDesktopEnvironment(), stdio: "ignore", detached: true, windowsHide: false });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
  return { launched: true, executable, pid: child.pid };
}

export async function spawnCodexDesktop(args = [], env = process.env) {
  const executable = await findCodexDesktopExecutable();
  const child = spawn(executable, args, {
    env: desktopEnvironment(env),
    stdio: "ignore",
    detached: true,
    windowsHide: false,
  });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
  return child;
}

export async function killGatewayProcesses() {
  if (!isWindows) {
    try { await execFileAsync("/usr/bin/pkill", ["-f", "model-gateway.mjs"]); } catch { }
    return;
  }
  const rows = await processRows().catch(() => []);
  for (const row of rows) {
    if (!row.command.includes("model-gateway.mjs")) continue;
    if (row.pid === process.pid || row.pid === process.ppid) continue;
    try { await terminateProcessTree(row.pid); } catch { }
  }
}

export async function linkSharedAsset(source, destination) {
  const stat = await fs.stat(source);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.lstat(destination);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!isWindows) {
    await fs.symlink(source, destination, stat.isDirectory() ? "dir" : "file");
    return;
  }
  if (stat.isDirectory()) {
    // NTFS junction 不要求 Developer Mode/管理员权限，而且能保持 skills/plugins 实时共享。
    await fs.symlink(path.resolve(source), destination, "junction");
    return;
  }
  // 同一用户目录通常在同一卷，hard link 不需要管理员并保持 auth/hooks 实时同步。
  try {
    await fs.link(source, destination);
  } catch (error) {
    if (!["EXDEV", "EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
    // 极少数跨卷/文件系统场景退化为复制；至少保证窗口能启动。
    await fs.copyFile(source, destination);
  }
}

export function runCommandWithInput(executable, args, input = "", { maxBuffer = 32 * 1024 * 1024, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { }
      reject(error);
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) return fail(new Error("子进程标准输出超过限制"));
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxBuffer) return fail(new Error("子进程错误输出超过限制"));
      stderr.push(chunk);
    });
    child.once("error", fail);
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: code ?? 1,
      };
      if (result.code === 0) return resolve(result);
      const error = new Error(result.stderr.trim() || `命令退出：${result.code}`);
      error.code = result.code;
      error.stdout = result.stdout;
      error.stderr = result.stderr;
      reject(error);
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") fail(error);
    });
    child.stdin.end(String(input ?? ""));
  });
}

export function sqliteExecutable() {
  const override = String(process.env.CMA_SQLITE3 ?? "").trim();
  if (override) return override;
  if (isWindows) {
    const resources = String(process.resourcesPath ?? "").trim();
    if (resources) return path.join(resources, "sqlite3.exe");
    return "sqlite3.exe";
  }
  return "/usr/bin/sqlite3";
}

export function tarExecutable() {
  if (isWindows) return "tar.exe";
  return "/usr/bin/tar";
}

export async function platformDiskRoot(target = os.homedir()) {
  if (!isWindows) return "/";
  const parsed = path.parse(path.resolve(target));
  return parsed.root || "C:\\";
}

