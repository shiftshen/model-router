#!/usr/bin/env node
// Explicit auto mode: select from a qualified snapshot, then send the request
// through the existing Model Router gateway. The request never goes to the
// decision engine; it receives only the structured profile and candidates.
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ModelStore } from "../src/model-store.mjs";
import { run as recommend } from "./model-router-advisory.mjs";

const gatewayURL = "http://127.0.0.1:18793/router/v1/responses";
const selectionOptions = ["engine", "catalog", "candidates", "profile"];

export class AutoRouteError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export async function autoRun({ selectionArgs, request, token, select = recommend, send = fetch } = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new AutoRouteError("invalid_request");
  if (request.model !== undefined && request.model !== "auto") throw new AutoRouteError("explicit_model_preserved");
  if (typeof token !== "string" || !token) throw new AutoRouteError("missing_gateway_token");

  const decision = await select(selectionArgs);
  if (decision?.mode !== "advisory" || decision.status !== "resolved" || !decision.selected?.id) {
    throw new AutoRouteError("no_qualified_model");
  }
  const response = await send(gatewayURL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ...request, model: decision.selected.id }),
  });
  return { decision, response };
}

async function main(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "");
    if (![...selectionOptions, "request"].includes(key) || argv[index] !== `--${key}` || !argv[index + 1] || options[key]) {
      throw new AutoRouteError("invalid_arguments");
    }
    options[key] = argv[index + 1];
  }
  if ([...selectionOptions, "request"].some((key) => !options[key])) throw new AutoRouteError("missing_arguments");
  const stat = await fs.stat(options.request);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new AutoRouteError("invalid_request_file");
  const request = JSON.parse(await fs.readFile(options.request, "utf8"));
  const token = process.env.CMA_ROUTE_TOKEN || await new ModelStore().token("router");
  const selectionArgs = selectionOptions.flatMap((key) => [`--${key}`, options[key]]);
  const { decision, response } = await autoRun({ selectionArgs, request, token });
  process.stderr.write(`Model Router auto selected ${decision.selected.id} (${decision.provenance?.selectedBy || "unknown"})\n`);
  process.stdout.write(await response.text());
  if (!response.ok) process.exitCode = 4;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Model Router auto: ${error instanceof AutoRouteError ? error.code : "unavailable"}\n`);
    process.exitCode = 2;
  });
}
