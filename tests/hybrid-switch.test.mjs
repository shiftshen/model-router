import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { portableHistory } from "../src/portable-history.mjs";
import { officialPayload, officialTokens } from "../src/chatgpt-auth.mjs";
import { ModelStore, validateRoute } from "../src/model-store.mjs";
import { buildRouterTable } from "../src/router.mjs";
import { createGateway } from "../src/model-gateway.mjs";
import { ProductService } from "../src/product-service.mjs";
const history = [
 {type:"message",role:"user",content:"Keep project goal",id:"msg_foreign"},
 {type:"reasoning",id:"rs_foreign",encrypted_content:"foreign-opaque"},
 {type:"function_call",id:"fc_foreign",call_id:"call_1",name:"shell",arguments:'{"cmd":"pwd"}'},
 {type:"function_call_output",call_id:"call_1",output:"/project"},
 {type:"message",role:"assistant",content:[{type:"output_text",text:"Progress"}]}
];
test("portable history preserves conversation and tool linkage without backend-owned references",()=>{
 const original={input:history,instructions:"Project rules",tools:[{type:"function",name:"shell"}],previous_response_id:"other-provider"};
 const converted=portableHistory(original);
 assert.equal(converted.input.length,4);
 assert.equal(converted.input[1].call_id,converted.input[2].call_id);
 assert.equal(converted.input[0].content,"Keep project goal");
 assert.equal(converted.instructions,"Project rules");
 assert.deepEqual(converted.tools,original.tools);
 assert.ok(!JSON.stringify(converted).includes("foreign"));
 assert.equal(original.input.length,5);
 assert.equal(original.previous_response_id,"other-provider");
 assert.throws(()=>portableHistory({input:[{type:"item_reference",id:"unrecoverable"}]}),/内部引用/);
 assert.throws(()=>portableHistory({input:[{type:"compaction",encrypted_content:"private"}]}),/内部引用/);
});
test("official payload is stateless, streaming, and does not forward local session metadata",()=>{
 const body=officialPayload({input:history,session_id:"local-thread",max_output_tokens:12,stream:false},"official-model");
 assert.equal(body.stream,true);assert.equal(body.store,false);assert.equal(body.model,"official-model");
 assert.equal(body.session_id,undefined);assert.equal(body.max_output_tokens,undefined);
 assert.equal(body.input.length,4);
});
test("official auth is read-only and an expired login does not rotate the desktop refresh token",async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"hybrid-auth-"));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,"auth.json");const token="x."+Buffer.from(JSON.stringify({exp:100})).toString("base64url")+".x";
 const text=JSON.stringify({auth_mode:"chatgpt",tokens:{access_token:token,refresh_token:"do-not-rotate",account_id:"account"}});
 await fs.writeFile(file,text);
 assert.equal((await officialTokens({file,now:99000})).access_token,token);
 await assert.rejects(officialTokens({file,now:101000}),/官方登录已过期/);
 assert.equal(await fs.readFile(file,"utf8"),text);
});
async function listen(server,t){await new Promise(r=>server.listen(0,"127.0.0.1",r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r)}));return "http://127.0.0.1:"+server.address().port;}
test("router accepts official and third-party turns and recovers from official quota failure",async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"hybrid-router-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 let thirdAuth="",thirdBody;
 const upstream=http.createServer(async(req,res)=>{thirdAuth=req.headers.authorization;let b="";for await(const c of req)b+=c;thirdBody=JSON.parse(b);res.setHeader("content-type","application/json");res.end(JSON.stringify({id:"third",object:"response",status:"completed",output:[]}));});
 const endpoint=await listen(upstream,t);
 const store=new ModelStore(root);const data=await store.read();
 const official=validateRoute({id:"chatgpt-test",name:"Official",protocol:"chatgpt",model:"official-model",switchable:true});
 const third=validateRoute({id:"third-test",name:"Third",protocol:"responses",model:"third-model",endpoint,credentialID:"third-test"});
 await store.mutate(data.revision,d=>{d.routes=[official,third];return d});
 await store.writeSecret("third-test","THIRD_ONLY");
 let fail=false,officialCalls=0;
 const server=createGateway(store,{officialUpstream:async(route,payload)=>{
   officialCalls++;const body=officialPayload(payload,route.model);
   assert.ok(!JSON.stringify(body).includes("rs_foreign"));
   if(fail){const e=new Error("Official subscription quota exhausted");e.status=Number(fail);e.detail=fail===429?"insufficient_quota":"invalid_authentication";throw e;}
   return new Response('data: '+JSON.stringify({type:"response.completed",response:{id:"official",object:"response",status:"completed",output:[]}})+'\n\n',{headers:{"content-type":"text/event-stream"}});
 }});
 const base=await listen(server,t),token=await store.token("router");
 const call=async model=>{const response=await fetch(base+"/router/v1/responses",{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify({model,input:history,stream:false})});return {status:response.status,body:await response.json()};};
 assert.equal(buildRouterTable((await store.read()).routes).length,2);
 assert.equal((await call("official-model")).status,200);
 assert.equal((await call("third-model")).status,200);
 assert.equal(thirdAuth,"Bearer THIRD_ONLY");
 assert.ok(!JSON.stringify(thirdBody).includes("foreign"));
 assert.equal(thirdBody.input[1].call_id,"call_1");
 assert.equal((await call("official-model")).status,200);
 fail=429;assert.notEqual((await call("official-model")).status,200);
 assert.equal((await call("third-model")).status,200);
 fail=401;assert.notEqual((await call("official-model")).status,200);
 assert.equal((await call("third-model")).status,200);
 assert.equal(officialCalls,4);
});
test("official catalog sync is explicit and idempotent; standalone official entry stays independent",async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"hybrid-sync-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const home=path.join(root,"official");await fs.mkdir(home);
 await fs.writeFile(path.join(home,"auth.json"),JSON.stringify({auth_mode:"chatgpt",tokens:{access_token:"opaque",account_id:"test"}}));
 await fs.writeFile(path.join(home,"models_cache.json"),JSON.stringify({models:[{slug:"gpt-test",display_name:"Test",visibility:"list",context_window:200000},{slug:"hidden-model",visibility:"hide"}]}));
 const store=new ModelStore(path.join(root,"store"));const service=new ProductService(store);service.officialHome=home;service.refreshCatalogs=async()=>({});
 await service.syncOfficialModels();await service.syncOfficialModels();
 const routes=(await store.read()).routes;assert.equal(routes.filter(r=>r.protocol==="chatgpt").length,1);
 assert.equal(routes.find(r=>r.id==="official").protocol,"oauth");
 assert.equal(buildRouterTable(routes).filter(r=>r.route.protocol==="chatgpt").length,1);
});

test("parallel conversations keep per-request models and cancellation does not start a fallback",async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"hybrid-parallel-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const store=new ModelStore(root);const data=await store.read();
 const a=validateRoute({id:"chatgpt-a",name:"A",protocol:"chatgpt",model:"official-a",switchable:true,fallback:"chatgpt-b"});
 const b=validateRoute({id:"chatgpt-b",name:"B",protocol:"chatgpt",model:"official-b",switchable:true});
 await store.mutate(data.revision,d=>{d.routes=[a,b];return d});
 const calls=[];let aborted=false;
 const server=createGateway(store,{officialUpstream:async(route,payload,signal)=>{
   calls.push({model:route.model,input:payload.input});
   if(payload.input==="cancel"){
     return new Response(new ReadableStream({start(controller){
       controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"pending","status":"in_progress"}}\n\n'));
       signal.addEventListener("abort",()=>{aborted=true;try{controller.error(new Error("cancelled"))}catch{}},{once:true});
     }}),{headers:{"content-type":"text/event-stream"}});
   }
   await new Promise(r=>setTimeout(r,route.model==="official-a"?20:1));
   return new Response('data: '+JSON.stringify({type:"response.completed",response:{id:payload.input,model:route.model,status:"completed",output:[]}})+'\n\n');
 }});
 const base=await listen(server,t),token=await store.token("router");
 const send=(model,input,stream=false)=>fetch(base+"/router/v1/responses",{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify({model,input,stream})});
 const responses=await Promise.all([send("official-a","thread-A"),send("official-b","thread-B")]);
 const bodies=await Promise.all(responses.map(r=>r.json()));
 assert.deepEqual(bodies.map(b=>[b.id,b.model]),[["thread-A","official-a"],["thread-B","official-b"]]);
 const response=await send("official-a","cancel",true);const reader=response.body.getReader();let received="";while(!received.includes("response.created")){const next=await reader.read();assert.equal(next.done,false);received+=new TextDecoder().decode(next.value);}await reader.cancel();
 for(let i=0;i<50&&!aborted;i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(aborted,true);assert.equal(calls.length,3);
});
