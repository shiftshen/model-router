#!/usr/bin/env node
import { compare, recommend, runtimeStatus } from "../src/engine.mjs";

async function readJson() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1_048_576) throw new TypeError("input exceeds 1 MiB");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new TypeError("input must be valid JSON"); }
}

async function main() {
  const command = process.argv[2] ?? "help";
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write("Usage: model-router-engine doctor | recommend | compare\nrecommend and compare read one JSON object from stdin and write one JSON object to stdout.\n");
    return;
  }
  let output;
  if (command === "doctor") output = { mode: "advisory", runtime: await runtimeStatus() };
  else if (command === "recommend") output = await recommend(await readJson());
  else if (command === "compare") output = await compare(await readJson());
  else throw new TypeError("unknown command");
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch((error) => {
  const validation = error instanceof TypeError || error instanceof SyntaxError;
  process.stdout.write(`${JSON.stringify({ error: validation ? "invalid_input" : "runtime_unavailable", detail: validation ? error.message : "The configured runtime could not be started." })}\n`);
  process.exitCode = validation ? 2 : 3;
});
