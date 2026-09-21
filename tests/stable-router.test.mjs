import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { ModelStore } from "../src/model-store.mjs";
import { buildRouterTable, routerTableEntry } from "../src/router.mjs";
import { createGateway, failureCode, failureEvents } from "../src/model-gateway.mjs";

test("旧会话标识在编辑模型、增加同名条目及归档其他条目后不变", async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"stable-router-"));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const store=new ModelStore(root);
 const save=async r=>store.save(r,(await store.read()).revision);
 const r=(id,model)=>({id,name:id,model,protocol:"responses",endpoint:"http://127.0.0.1:9/v1",noKey:true});
 await save(r("b-route","same"));await save(r("c-route","same"));
 const before=buildRouterTable((await store.read()).routes);
 const a=before.find(e=>e.route.id==="b-route").slug,b=before.find(e=>e.route.id==="c-route").slug;
 await save({...await store.route("b-route"),model:"ark-code-latest",routerSlug:"untrusted-ui-value"});
 await save(r("a-route","same"));
 await save({...await store.route("a-route"),archived:true});
 const after=buildRouterTable((await store.read()).routes);
 assert.equal(routerTableEntry(after,a).route.id,"b-route");
 assert.equal(routerTableEntry(after,a).route.model,"ark-code-latest");
 assert.equal(routerTableEntry(after,b).route.id,"c-route");
 assert.equal(after.find(e=>e.route.id==="c-route").slug,b);
});

test("同一对话 A→B→A 切换且编辑模型后旧标识继续指向原供应商", async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"router-roundtrip-"));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const seen=[];
 const upstream=http.createServer(async(req,res)=>{
  let text="";for await(const c of req)text+=c;
  const p=JSON.parse(text);seen.push({model:p.model,input:p.input});
  res.writeHead(200,{"content-type":"application/json"});
  res.end(JSON.stringify({id:"resp_test",object:"response",status:"completed",output:[],usage:{input_tokens:1,output_tokens:1}}));
 });
 const listen=async s=>{await new Promise(r=>s.listen(0,"127.0.0.1",r));t.after(()=>new Promise(r=>{s.closeAllConnections();s.close(r)}));return "http://127.0.0.1:"+s.address().port};
 const url=await listen(upstream),store=new ModelStore(root);
 for(const id of ["a","b"])await store.save({id,name:id,model:id,protocol:"responses",endpoint:url+"/v1",noKey:true},(await store.read()).revision);
 const gateway=await listen(createGateway(store));
 const headers={"content-type":"application/json",authorization:"Bearer "+await store.token("router")};
 const input=[{role:"user",content:"remember context"},{role:"assistant",content:"remembered"},{role:"user",content:"continue"}];
 for(const slug of ["a","b","a"]){
  const res=await fetch(gateway+"/router/v1/responses",{method:"POST",headers,body:JSON.stringify({model:slug,input})});
  assert.equal(res.status,200);await res.json();
 }
 await store.save({...await store.route("a"),model:"renamed-a"},(await store.read()).revision);
 const res=await fetch(gateway+"/router/v1/responses",{method:"POST",headers,body:JSON.stringify({model:"a",input})});
 assert.equal(res.status,200);await res.json();
 assert.deepEqual(seen.map(x=>x.model),["a","b","a","renamed-a"]);
 assert.ok(seen.every(x=>JSON.stringify(x.input)===JSON.stringify(input)));
 const bad=await fetch(gateway+"/router/v1/responses",{method:"POST",headers,body:JSON.stringify({model:"missing",input})});
 assert.equal(bad.status,400);assert.equal((await bad.json()).error.code,"model_not_found");
});

test("限流、上下文、认证、权限不伪装成额度耗尽，JSON/SSE 一致",()=>{
 for(const [status,detail,code] of [
 [429,"Too many requests","rate_limit_exceeded"],
 [429,"context length exceeded; rate limit","context_length_exceeded"],
 [401,"invalid API key","authentication_error"],
 [403,"insufficient permissions","permission_denied"],
 [400,"insufficient_quota","insufficient_quota"],
 [429,"余额不足","insufficient_quota"],
 [400,"RESOURCE_EXHAUSTED: capacity","rate_limit_exceeded"],
 [400,"unknown model","invalid_prompt"]
 ]){
 assert.equal(failureCode(status,detail),code);
 assert.match(failureEvents({status,detail},detail),new RegExp('"code":"'+code+'"'));
 }
});

test("修复前旧模型别名只恢复到有明确归属的条目",()=>{
 const table=buildRouterTable([
 {id:"a",model:"ark-code-latest",protocol:"responses",routerSlug:"stable-a",routerAliases:["old-alias","ambiguous"]},
 {id:"b",model:"other",protocol:"responses",routerSlug:"stable-b",routerAliases:["ambiguous"]}
 ]);
 assert.equal(routerTableEntry(table,"old-alias").route.id,"a");
 assert.equal(routerTableEntry(table,"ambiguous"),null);
});
