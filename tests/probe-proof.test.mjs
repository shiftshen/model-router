import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelStore, validateRoute } from "../src/model-store.mjs";
import { ProductService } from "../src/product-service.mjs";
for (const output of ["", "hello", "MODEL_ASSISTANT_OK"]) {
  test("probe requires exact inference proof: " + JSON.stringify(output), async t => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),"probe-proof-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const store=new ModelStore(root),data=await store.read();
    await store.mutate(data.revision,d=>{d.routes=[validateRoute({id:"probe-test",name:"Probe",model:"probe-model",protocol:"responses",endpoint:"http://127.0.0.1:1/v1",noKey:true})];return d});
    const service=new ProductService(store);
    service.gatewayReady=async()=>{};
    service.ensureManagedLocalService=async()=>{};
    t.mock.method(globalThis,"fetch",async()=>new Response(JSON.stringify({output:[{type:"message",content:[{type:"output_text",text:output}]}]}),{status:200}));
    const file=path.join(root,"checks","probe-test.json");
    if(output==="MODEL_ASSISTANT_OK"){
      assert.equal((await service.probe("probe-test")).ok,true);
      assert.equal(JSON.parse(await fs.readFile(file,"utf8")).ok,true);
    } else {
      await assert.rejects(service.probe("probe-test"),/未返回准确/);
      await assert.rejects(fs.access(file));
    }
  });
}
