#!/opt/homebrew/bin/node
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { detectRoute, routeDefinitions } from "./route-config.mjs";
import { applyRoute, checkModelsEndpoint, prepareInstance } from "./route-manager-lib.mjs";
import { findCodexDesktopExecutable } from "./platform-runtime.mjs";

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const configPath = path.join(codexHome, "config.toml");
const backupDirectory = path.join(codexHome, "model-assistant", "backups");

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: error.message }));
  });
}

async function readSecret(routeId) {
  const route = routeDefinitions[routeId];
  if (route.provider === "agnes") {
    if (process.env.AGNES_API_KEY) return process.env.AGNES_API_KEY;
    return (await fs.readFile(path.join(os.homedir(), ".openclaw/secrets/openclaw-runtime/secret-005"), "utf8")).trim();
  }
  if (route.provider === "deepseek-official") {
    if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
    return (await fs.readFile(path.join(os.homedir(), ".openclaw/secrets/codex-providers/deepseek_api_key"), "utf8")).trim();
  }
  return null;
}

async function validateConfig() {
  const desktopExecutable = await findCodexDesktopExecutable();
  const appRoot = desktopExecutable.replace(/[\\/]Contents[\\/]MacOS[\\/][^\\/]+$/, "");
  const codexBinary = path.join(appRoot, "Contents", "Resources", "codex");
  const result = await run(codexBinary, ["--strict-config", "--version"]);
  return {
    ok: result.code === 0,
    message: result.stderr.trim() || result.stdout.trim(),
  };
}

async function checkRoute(routeId) {
  const route = routeDefinitions[routeId];
  if (!route) throw new Error(`Unknown route: ${routeId}`);

  if (routeId === "official") {
    const auth = JSON.parse(await fs.readFile(path.join(codexHome, "auth.json"), "utf8"));
    const ok = auth.auth_mode === "chatgpt" && Boolean(auth.tokens?.access_token);
    return {
      ok,
      message: ok ? "ChatGPT OAuth 已登录" : "需要登录 ChatGPT",
      routeId,
      model: route.model,
    };
  }

  let token = null;
  try {
    token = await readSecret(routeId);
  } catch {
    return { ok: false, message: "缺少对应 API 密钥", routeId, model: route.model };
  }
  const result = await checkModelsEndpoint({
    endpoint: route.endpoint,
    model: route.model,
    token,
  });
  return { ...result, routeId, model: route.model };
}

async function main() {
  const [command = "status", routeId] = process.argv.slice(2);
  if (command === "routes") {
    print({ ok: true, routes: routeDefinitions });
    return;
  }
  if (command === "status") {
    const config = await fs.readFile(configPath, "utf8");
    const activeRoute = detectRoute(config);
    print({ ok: true, activeRoute, route: routeDefinitions[activeRoute] ?? null });
    return;
  }
  if (command === "check") {
    print(await checkRoute(routeId));
    return;
  }
  if (command === "apply") {
    const health = await checkRoute(routeId);
    if (!health.ok) {
      print(health);
      process.exitCode = 2;
      return;
    }
    const result = await applyRoute(routeId, {
      configPath,
      backupDirectory,
      validate: validateConfig,
    });
    print({ ok: true, ...result, route: routeDefinitions[routeId] });
    return;
  }
  if (command === "prepare") {
    const health = await checkRoute(routeId);
    if (!health.ok) {
      print(health);
      process.exitCode = 2;
      return;
    }
    const result = await prepareInstance(routeId, {
      sharedHome: codexHome,
      instanceRoot: path.join(codexHome, "model-assistant", "instances"),
    });
    print({ ok: true, ...result, route: routeDefinitions[routeId] });
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  print({ ok: false, message: error.message });
  process.exitCode = 1;
});
