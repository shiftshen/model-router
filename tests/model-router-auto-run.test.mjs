import assert from "node:assert/strict";
import { test } from "node:test";
import { autoRun } from "../scripts/model-router-auto-run.mjs";

test("auto mode selects a route before sending the real request to the gateway", async () => {
  const request = { model: "auto", input: [{ role: "user", content: "private task" }] };
  let selectCalls = 0;
  let sent = 0;
  const result = await autoRun({
    selectionArgs: ["--profile", "/profile.json"], request, token: "window-token",
    select: async (args) => {
      selectCalls += 1;
      assert.deepEqual(args, ["--profile", "/profile.json"]);
      return { mode: "advisory", status: "resolved", selected: { id: "qualified-slug" }, provenance: { selectedBy: "jev_fallback" } };
    },
    send: async (url, options) => {
      sent += 1;
      assert.equal(url, "http://127.0.0.1:18793/router/v1/responses");
      assert.equal(options.headers.authorization, "Bearer window-token");
      assert.deepEqual(JSON.parse(options.body), { ...request, model: "qualified-slug" });
      return { ok: true, text: async () => "response" };
    },
  });
  assert.equal(result.decision.selected.id, "qualified-slug");
  assert.equal(selectCalls, 1);
  assert.equal(sent, 1);
  assert.equal(request.model, "auto");
});

test("auto mode preserves an explicit model and never calls the engine or gateway", async () => {
  let calls = 0;
  await assert.rejects(autoRun({
    request: { model: "chosen-by-user" }, token: "token",
    select: async () => { calls += 1; }, send: async () => { calls += 1; },
  }), { code: "explicit_model_preserved" });
  assert.equal(calls, 0);
});

test("auto mode does not execute without a qualified recommendation", async () => {
  let sent = 0;
  await assert.rejects(autoRun({
    request: { model: "auto", input: "task" }, token: "token",
    select: async () => ({ mode: "advisory", status: "profile_unavailable", selected: null }),
    send: async () => { sent += 1; },
  }), { code: "no_qualified_model" });
  assert.equal(sent, 0);
});
