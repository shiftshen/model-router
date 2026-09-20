import test from "node:test";
import assert from "node:assert/strict";

import {
  isLocalEndpoint,
  litePayload,
  payloadForRoute,
  payloadSize,
  resolveRuntimeProfile,
} from "../src/runtime-profile.mjs";

test("runtime profile: 本地无 Key Auto 为 Lite，云端为 Full，显式值优先", () => {
  assert.equal(resolveRuntimeProfile({ endpoint:"http://127.0.0.1:18081/v1", noKey:true, protocol:"chat", runtimeProfile:"auto" }), "lite");
  assert.equal(resolveRuntimeProfile({ endpoint:"http://192.168.1.8:8080/v1", noKey:true, protocol:"chat" }), "lite");
  assert.equal(resolveRuntimeProfile({ endpoint:"https://api.example.com/v1", noKey:false, protocol:"chat" }), "full");
  assert.equal(resolveRuntimeProfile({ protocol:"oauth", runtimeProfile:"auto" }), "full");
  assert.equal(resolveRuntimeProfile({ endpoint:"http://127.0.0.1:1", noKey:true, protocol:"chat", runtimeProfile:"full" }), "full");
  assert.equal(resolveRuntimeProfile({ endpoint:"https://api.example.com", noKey:false, protocol:"chat", runtimeProfile:"lite" }), "lite");
  assert.equal(isLocalEndpoint("http://localhost:8080/v1"), true);
  assert.equal(isLocalEndpoint("https://api.openai.com/v1"), false);
});

test("lite payload: 删除 Apps/MCP/插件工具，只保留核心开发工具", () => {
  const payload = {
    model:"local",
    tools:[
      { type:"namespace", name:"mcp__codex_apps__adobe", tools:[{type:"function",name:"giant",parameters:{type:"object"}}] },
      { type:"namespace", name:"mcp__codex_apps__webcodex", tools:[{type:"function",name:"run",parameters:{type:"object"}}] },
      { type:"function", name:"exec_command", parameters:{type:"object"} },
      { type:"function", name:"request_plugin_install", parameters:{type:"object"} },
      { type:"custom", name:"apply_patch" },
      { type:"function", name:"view_image", parameters:{type:"object"} },
    ],
    input:[
      { role:"developer", content:[
        { type:"input_text", text:"<skills_instructions>very long skill catalog</skills_instructions>" },
        { type:"input_text", text:"<apps_instructions>apps</apps_instructions>" },
        { type:"input_text", text:"<permissions instructions>keep me</permissions instructions>" },
      ]},
      { role:"user", content:[
        { type:"input_text", text:"<recommended_plugins>gmail, drive</recommended_plugins>" },
        { type:"input_text", text:"# AGENTS.md instructions\nkeep project rules" },
      ]},
      { role:"user", content:[{ type:"input_text", text:"你好" }]},
    ],
  };
  const filtered = litePayload(payload);
  assert.deepEqual(filtered.tools.map((tool) => tool.name), ["exec_command","apply_patch","view_image"]);
  const texts = filtered.input.flatMap((item) => item.content || []).map((part) => part.text || "");
  assert.equal(texts.some((text) => text.startsWith("<skills_instructions>")), false);
  assert.equal(texts.some((text) => text.startsWith("<apps_instructions>")), false);
  assert.equal(texts.some((text) => text.startsWith("<recommended_plugins>")), false);
  assert.ok(filtered.instructions.includes("<permissions instructions>"));
  assert.ok(texts.some((text) => text.startsWith("# AGENTS.md instructions")));
  assert.equal(filtered.input.some((item) => ["system", "developer"].includes(item.role)), false);
  assert.ok(texts.includes("你好"));
  assert.ok(payloadSize(filtered) < payloadSize(payload));
  assert.equal(payload.tools.length, 6, "不能原地修改调用方 payload");
});


test("lite payload: 合并散落的 system/developer 消息，兼容只允许首条 system 的本地模板", () => {
  const payload = {
    instructions:"root instructions",
    input:[
      { role:"user", content:[{ type:"input_text", text:"first" }] },
      { role:"developer", content:[{ type:"input_text", text:"late developer" }] },
      { role:"system", content:[{ type:"input_text", text:"late system" }] },
      { role:"user", content:[{ type:"input_text", text:"last" }] },
    ],
  };
  const filtered = litePayload(payload);
  assert.equal(filtered.instructions, "root instructions\n\nlate developer\n\nlate system");
  assert.deepEqual(filtered.input.map((item) => item.role), ["user", "user"]);
  assert.equal(payload.input.length, 4, "不能原地修改调用方 payload");
});

test("payloadForRoute: Full 保持原对象，Lite 返回裁剪副本", () => {
  const payload={tools:[{type:"namespace",name:"huge",tools:[]},{type:"function",name:"exec_command",parameters:{}}],input:"hi"};
  const full=payloadForRoute(payload,{endpoint:"https://api.example.com",noKey:false,protocol:"chat"});
  const lite=payloadForRoute(payload,{endpoint:"http://127.0.0.1:18081/v1",noKey:true,protocol:"chat"});
  assert.equal(full,payload);
  assert.notEqual(lite,payload);
  assert.equal(lite.tools.length,1);
});
