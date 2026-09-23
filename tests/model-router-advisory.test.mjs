import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { run } from "../scripts/model-router-advisory.mjs";

const catalog = { models: [
  { slug: "codex-good", visibility: "list", base_instructions: "ignored" },
  { slug: "codex-hidden", visibility: "hide" },
] };
const candidate = {
  id: "codex-good", modelId: "upstream-model", provider: "example",
  capabilities: ["coding"], modalities: ["text"], languages: ["en"],
  contextWindow: 32000, maxOutput: 4000, costTier: 2, latencyTier: 2,
  privacy: "remote", status: "qualified", credentialStatus: "active",
};
const profile = { taskType: "code", difficulty: "hard", requiredCapabilities: ["coding"], modalities: ["text"], languages: ["en"] };

async function fixture(t, { catalogValue = catalog, candidates = [candidate], profileValue = profile, engineResult } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "model-router-advisory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = Object.fromEntries(["engine", "catalog", "candidates", "profile"].map((name) => [name, path.join(root, `${name}.mjs`)]));
  await fs.writeFile(files.engine, `let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => { const request = JSON.parse(data); process.stdout.write(JSON.stringify(${JSON.stringify(engineResult ?? { mode: "advisory", status: "resolved", selected: { id: candidate.id, modelId: candidate.modelId, provider: candidate.provider }, provenance: { primary: "laya_typed", selectedBy: "jev_fallback", layaCalls: 1, jevCalls: 1, fallbackReason: "laya_low_confidence" } })})); });`);
  await fs.writeFile(files.catalog, JSON.stringify(catalogValue));
  await fs.writeFile(files.candidates, JSON.stringify({ candidates }));
  await fs.writeFile(files.profile, JSON.stringify(profileValue));
  return { root, files, args: ["--engine", files.engine, "--catalog", files.catalog, "--candidates", files.candidates, "--profile", files.profile] };
}

test("Codex advisory accepts a qualified exact catalog slug and retains provenance", async (t) => {
  const { files, args } = await fixture(t);
  const before = await Promise.all([files.catalog, files.candidates, files.profile].map((file) => fs.readFile(file, "utf8")));
  const result = await run(args);
  assert.equal(result.status, "resolved");
  assert.deepEqual(result.selected, { id: "codex-good", modelId: "upstream-model", provider: "example" });
  assert.equal(result.mode, "advisory");
  assert.equal(result.provenance.selectedBy, "jev_fallback");
  assert.deepEqual(await Promise.all([files.catalog, files.candidates, files.profile].map((file) => fs.readFile(file, "utf8"))), before);
});

test("Codex advisory rejects an engine choice outside the explicit snapshot", async (t) => {
  const { args } = await fixture(t, { engineResult: { mode: "advisory", status: "resolved", selected: { id: "codex-hidden", modelId: "codex-hidden", provider: "example" } } });
  const result = await run(args);
  assert.equal(result.selected, null);
  assert.equal(result.reason, "engine_selection_not_in_snapshot");
});

test("Codex advisory rejects a response without advisory mode or with mismatched provider", async (t) => {
  const wrongMode = await fixture(t, { engineResult: { mode: "automatic", status: "resolved", selected: { id: candidate.id, modelId: candidate.modelId, provider: candidate.provider } } });
  const rejectedMode = await run(wrongMode.args);
  assert.equal(rejectedMode.selected, null);
  assert.equal(rejectedMode.reason, "engine_invalid_output");
  const wrongProvider = await fixture(t, { engineResult: { mode: "advisory", status: "resolved", selected: { id: candidate.id, modelId: candidate.modelId, provider: "other" } } });
  const rejected = await run(wrongProvider.args);
  assert.equal(rejected.selected, null);
  assert.equal(rejected.reason, "engine_selection_not_in_snapshot");
});

test("Codex advisory rejects hidden catalog aliases and unqualified candidates", async (t) => {
  const hidden = await fixture(t, { candidates: [{ ...candidate, id: "codex-hidden" }] });
  assert.equal((await run(hidden.args)).reason, "candidate_not_in_catalog");
  const unqualified = await fixture(t, { candidates: [{ ...candidate, status: "experimental" }] });
  assert.equal((await run(unqualified.args)).reason, "candidate_not_qualified");
});

test("Codex advisory closes on missing paths and profile fields that could carry prompts", async (t) => {
  assert.deepEqual((await run([])).selected, null);
  const { args } = await fixture(t, { profileValue: { ...profile, prompt: "private text" } });
  const result = await run(args);
  assert.equal(result.selected, null);
  assert.equal(result.reason, "invalid_input_shape");
});
