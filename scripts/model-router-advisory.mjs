#!/usr/bin/env node
// Advisory bridge: the public Codex catalog and an explicit capability snapshot
// are the only local inputs. No Codex config, prompt, or credential files are read.
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const OPTIONS = ["engine", "catalog", "candidates", "profile"];
const PROFILE_KEYS = new Set([
  "taskType", "difficulty", "requiredCapabilities", "modalities", "languages",
  "contextRequirement", "outputRequirement", "privacy", "qualityPriority",
  "costPriority", "latencyPriority", "allowExperimental", "allowDegradedFallback", "accessMode",
]);
const CANDIDATE_KEYS = [
  "id", "modelId", "provider", "capabilities", "modalities", "languages",
  "contextWindow", "maxOutput", "costTier", "latencyTier", "privacy",
  "status", "credentialStatus",
];
const MAX_INPUT_BYTES = 1_048_576;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function options(argv) {
  const found = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (!OPTIONS.includes(key) || argv[i] !== `--${key}` || !argv[i + 1] || found[key]) throw new Error("invalid_arguments");
    found[key] = argv[i + 1];
  }
  if (OPTIONS.some((key) => !found[key])) throw new Error("missing_arguments");
  return found;
}

async function readJSON(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new Error("invalid_input_file");
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function inputs(catalog, snapshot, profile) {
  if (!object(catalog) || !Array.isArray(catalog.models) || !object(snapshot) || !Array.isArray(snapshot.candidates) || !object(profile)) throw new Error("invalid_input_shape");
  if (!catalog.models.length || !snapshot.candidates.length || Object.keys(profile).some((key) => !PROFILE_KEYS.has(key))) throw new Error("invalid_input_shape");
  const slugs = catalog.models.filter((entry) => entry?.visibility === "list").map((entry) => entry?.slug);
  if (slugs.some((slug) => typeof slug !== "string" || !slug.trim()) || new Set(slugs).size !== slugs.length) throw new Error("invalid_catalog");
  const catalogIds = new Set(slugs);
  const candidates = snapshot.candidates.map((entry) => {
    if (!object(entry) || typeof entry.id !== "string" || !catalogIds.has(entry.id)) throw new Error("candidate_not_in_catalog");
    if (entry.status !== "qualified" || entry.credentialStatus !== "active") throw new Error("candidate_not_qualified");
    return Object.fromEntries(CANDIDATE_KEYS.filter((key) => Object.hasOwn(entry, key)).map((key) => [key, entry[key]]));
  });
  if (new Set(candidates.map((entry) => entry.id)).size !== candidates.length) throw new Error("duplicate_candidate");
  return { profile, candidates };
}

function invoke(engine, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [engine, "recommend"], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("engine_timeout")), 30_000);
    child.on("error", () => finish(new Error("engine_unavailable")));
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) finish(new Error("engine_output_too_large"));
      else output += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (code !== 0) { finish(new Error("engine_failed")); return; }
      try { finish(null, JSON.parse(output)); } catch { finish(new Error("engine_invalid_output")); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

function advisory(result, candidates) {
  if (!object(result) || result.mode !== "advisory") throw new Error("engine_invalid_output");
  const provenance = object(result?.provenance) ? Object.fromEntries(
    ["primary", "selectedBy", "layaCalls", "jevCalls", "fallbackReason"]
      .filter((key) => Object.hasOwn(result.provenance, key))
      .map((key) => [key, result.provenance[key]]),
  ) : null;
  if (result?.status !== "resolved" || !object(result.selected)) {
    return { mode: "advisory", status: result?.status ?? "no_match", selected: null, provenance };
  }
  const candidate = candidates.find((entry) => entry.id === result.selected.id);
  if (!candidate || result.selected.modelId !== (candidate.modelId ?? candidate.id) || result.selected.provider !== candidate.provider) {
    throw new Error("engine_selection_not_in_snapshot");
  }
  return {
    mode: "advisory",
    status: "resolved",
    selected: { id: candidate.id, modelId: candidate.modelId ?? candidate.id, provider: candidate.provider },
    provenance,
  };
}

export async function run(argv) {
  try {
    const paths = options(argv);
    const [catalog, snapshot, profile] = await Promise.all([
      readJSON(paths.catalog), readJSON(paths.candidates), readJSON(paths.profile),
    ]);
    const request = inputs(catalog, snapshot, profile);
    const result = await invoke(paths.engine, request);
    return advisory(result, request.candidates);
  } catch (error) {
    const known = new Set([
      "invalid_arguments", "missing_arguments", "invalid_input_file", "invalid_input_shape",
      "invalid_catalog", "candidate_not_in_catalog", "candidate_not_qualified",
      "duplicate_candidate", "engine_timeout", "engine_unavailable", "engine_output_too_large",
      "engine_failed", "engine_invalid_output", "engine_selection_not_in_snapshot",
    ]);
    return { mode: "advisory", status: "unavailable", selected: null, provenance: null, reason: known.has(error.message) ? error.message : "invalid_or_unreadable_input" };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "unavailable") process.exitCode = 1;
}
