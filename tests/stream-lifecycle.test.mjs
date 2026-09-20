import test from "node:test";
import assert from "node:assert/strict";
import { createResponseStream, fromCompletion } from "../src/protocol-adapter.mjs";

test("custom tool input preserves raw patch, JSON string and input wrapper in both response modes", () => {
  const patch = "*** Begin Patch\n*** Update File: sum.mjs\n@@\n-old\n+new\n*** End Patch";
  const definitions = [{name:"apply_patch",original:"apply_patch",custom:true}];
  for (const args of [patch, JSON.stringify(patch), JSON.stringify({input:patch})]) {
    const result = fromCompletion({choices:[{message:{tool_calls:[{id:"call",function:{name:"apply_patch",arguments:args}}]}}]},definitions,"chat","local");
    assert.equal(result.output[0].input, patch);
    const stream = createResponseStream({model:"local",send:()=>{}});
    stream.created();
    stream.toolDelta(0,{id:"call",name:"apply_patch",arguments:args});
    assert.equal(stream.finish({definitions}).output[0].input, patch);
  }
});

for (const scenario of ["reasoning-text-tool", "tool-text", "reasoning-only"]) {
  test("Responses stream lifecycle: " + scenario, () => {
    const events = [];
    const stream = createResponseStream({model:"local",send:frame=>events.push(JSON.parse(frame.split("\ndata: ")[1]))});
    stream.created();
    if (scenario.startsWith("reasoning")) { stream.reasoningDelta("分析"); stream.reasoningDelta("完成"); }
    if (scenario === "tool-text") stream.toolDelta(0,{id:"call_1",name:"exec_command",arguments:'{"cmd":"pwd"}'});
    if (scenario !== "reasoning-only") {stream.textDelta("你"); stream.textDelta("好");}
    if (scenario === "reasoning-text-tool") stream.toolDelta(0,{id:"call_1",name:"exec_command",arguments:'{"cmd":"pwd"}'});
    const final = stream.finish();
    const active = new Map(), closed = new Set();
    for (const event of events) {
      if (event.type === "response.output_item.added") {
        assert.ok(!active.has(event.output_index), "each output index starts once");
        active.set(event.output_index,event.item.id);
      }
      if (event.item_id) assert.equal(active.get(event.output_index),event.item_id,"delta/part must reference an announced item");
      if (event.type === "response.output_item.done") {
        assert.equal(active.get(event.output_index),event.item.id,"done must reference an announced item");
        assert.ok(!closed.has(event.item.id));
        closed.add(event.item.id);
      }
    }
    assert.equal(closed.size, final.output.length);
    final.output.forEach((item,index)=>assert.equal(active.get(index),item.id));
    if (scenario.startsWith("reasoning")) {
      const item = final.output.find(x=>x.type==="reasoning");
      assert.equal(item.content[0].text,"分析完成");
      assert.ok(events.some(x=>x.type==="response.reasoning_text.done"));
    }
    if (scenario !== "reasoning-only") assert.equal(final.output.find(x=>x.type==="message").content[0].text,"你好");
  });
}

