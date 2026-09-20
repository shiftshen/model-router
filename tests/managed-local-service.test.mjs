import test from "node:test";
import assert from "node:assert/strict";
import { ProductService } from "../src/product-service.mjs";

test("healthy externally managed Bonsai keeps its configured context window", async (t) => {
  const service = new ProductService();
  let reads = 0;
  service.store = { read: async () => { reads++; throw new Error("must not rewrite a running service"); } };
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "http://127.0.0.1:18081/health");
    return new Response('{"status":"ok"}', {status:200});
  });
  const result = await service.ensureManagedLocalService({id:"bonsai2-27b",endpoint:"http://127.0.0.1:18081/v1",contextWindow:153600});
  assert.equal(reads, 0);
  if (process.platform !== "win32") {
    assert.equal(result.started, false);
    assert.equal(result.contextWindow, 153600);
  } else assert.equal(result.managed, false);
});

