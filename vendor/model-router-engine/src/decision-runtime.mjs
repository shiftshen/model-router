import { spawn as nodeSpawn } from "node:child_process";
import { createTaskProfile } from "./task-profile.mjs";
import { deepFreeze } from "./validation.mjs";

export const LAYA_COREML_RUNTIME_CONTRACT_VERSION = "v1";
export const JEV_TYPED_CHOICE_CONTRACT_VERSION = "v1";

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const TOPOLOGY_CHOICES = Object.freeze(["single_model", "review_then_execute"]);
const LAYA_COREML_PROGRAM = [
  "import json, sys",
  "import laya_coreml as l",
  "agent = l.load(sys.argv[1], local_files_only=True)",
  "payload = json.load(sys.stdin)",
  "json.dump(agent.predict(payload['state'], payload['questions']), sys.stdout)",
].join("; ");

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function runtimeError(code) {
  return new DecisionRuntimeError(code);
}

function appendChunk(chunks, chunk, total, maxBytes) {
  const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const nextTotal = total + value.length;
  if (nextTotal > maxBytes) throw runtimeError("LAYA_OUTPUT_TOO_LARGE");
  chunks.push(value);
  return nextTotal;
}

function kill(child) {
  try { child.kill("SIGTERM"); } catch { /* A failed cleanup must not disclose runtime details. */ }
}

function typedState(task) {
  return deepFreeze({
    contractVersion: JEV_TYPED_CHOICE_CONTRACT_VERSION,
    taskType: task.taskType,
    requiredCapabilities: task.requiredCapabilities,
    modalities: task.modalities,
    languages: task.languages,
    contextRequirement: task.contextRequirement,
    outputRequirement: task.outputRequirement,
    privacy: task.privacy,
    accessMode: task.accessMode,
  });
}

function profileForTopology(task, topology) {
  const needsMultiAgent = topology === "review_then_execute";
  const roles = needsMultiAgent
    ? [
      { role: "review", required_capabilities: task.requiredCapabilities },
      { role: "execution", required_capabilities: task.requiredCapabilities },
    ]
    : [];
  return deepFreeze({
    task_type: task.taskType,
    difficulty: task.difficulty,
    required_capabilities: task.requiredCapabilities,
    modalities: task.modalities,
    languages: task.languages,
    context_requirement: task.contextRequirement,
    output_requirement: task.outputRequirement,
    privacy: task.privacy,
    quality_priority: task.qualityPriority,
    cost_priority: task.costPriority,
    latency_priority: task.latencyPriority,
    needs_multi_agent: needsMultiAgent,
    roles,
  });
}

function answerChoice(response) {
  if (typeof response === "string") return response;
  if (!plainObject(response)) return null;
  const answer = response.answers?.decision ?? response.decision;
  if (typeof answer === "string") return answer;
  if (plainObject(answer) && typeof answer.choice === "string") return answer.choice;
  return null;
}

function waitForJev(systemOne, request, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(runtimeError("JEV_ABORTED")); return; }
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    const onAbort = () => settle(reject, runtimeError("JEV_ABORTED"));
    const timer = setTimeout(() => settle(reject, runtimeError("JEV_TIMEOUT")), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => systemOne(request, { signal }))
      .then((response) => settle(resolve, response), () => settle(reject, runtimeError("JEV_TYPED_FAILED")));
  });
}

export class DecisionRuntimeError extends Error {
  constructor(code) {
    super(code);
    this.name = "DecisionRuntimeError";
    this.code = code;
  }
}

/**
 * Creates the only process boundary needed for local Laya CoreML inference.
 * The caller must explicitly supply both executable and model location.  The
 * process receives exactly one JSON request on stdin and writes one JSON
 * response on stdout; no shell, environment discovery, credentials, or local
 * cache paths are consulted by this package. `timeoutMs` defaults to 2,000 ms
 * for responsive routing. Local CoreML cold loading takes about five seconds
 * on the validated machine, so a caller performing real local inference must
 * explicitly set `timeoutMs: 15_000`.
 */
export function createLayaCoreMLTransport({ pythonBin, modelPath, spawn = nodeSpawn, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES } = {}) {
  nonEmptyString(pythonBin, "pythonBin");
  nonEmptyString(modelPath, "modelPath");
  if (typeof spawn !== "function") throw new TypeError("spawn must be a function");
  positiveInteger(timeoutMs, "timeoutMs");
  positiveInteger(maxOutputBytes, "maxOutputBytes");

  return async function transport(request, { signal } = {}) {
    if (signal?.aborted) throw runtimeError("LAYA_ABORTED");
    if (!plainObject(request) || !plainObject(request.state) || !plainObject(request.questions)) throw runtimeError("LAYA_INVALID_REQUEST");
    let input;
    try { input = JSON.stringify(request); } catch { throw runtimeError("LAYA_INVALID_REQUEST"); }

    return new Promise((resolve, reject) => {
      let child;
      let settled = false;
      const stdout = [];
      let stdoutBytes = 0;
      const settle = (fn, value, terminate = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (terminate && child) kill(child);
        fn(value);
      };
      const fail = (code, terminate = true) => settle(reject, runtimeError(code), terminate);
      const onAbort = () => fail("LAYA_ABORTED");
      const timer = setTimeout(() => fail("LAYA_TIMEOUT"), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        child = spawn(pythonBin, ["-c", LAYA_COREML_PROGRAM, modelPath], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
      } catch {
        fail("LAYA_SPAWN_FAILED", false);
        return;
      }
      if (!child || !child.stdin || !child.stdout || typeof child.on !== "function") {
        fail("LAYA_SPAWN_FAILED", true);
        return;
      }
      child.once?.("error", () => fail("LAYA_SPAWN_FAILED", false));
      child.stdout.on("data", (chunk) => {
        if (settled) return;
        try { stdoutBytes = appendChunk(stdout, chunk, stdoutBytes, maxOutputBytes); } catch (error) { fail(error.code); }
      });
      child.once?.("close", (code) => {
        if (settled) return;
        if (code !== 0) { fail("LAYA_PROCESS_FAILED", false); return; }
        let response;
        try { response = JSON.parse(Buffer.concat(stdout).toString("utf8")); } catch { fail("LAYA_INVALID_RESPONSE", false); return; }
        settle(resolve, response);
      });
      try {
        child.stdin.write(input);
        child.stdin.end();
      } catch {
        fail("LAYA_PROCESS_FAILED");
      }
    });
  };
}

/**
 * Adapts Jev's `systemOne` API to the planner's `profileTask` boundary.  Jev
 * selects a finite topology template only.  Every hard task constraint is
 * copied from the caller's validated profile, so Jev cannot manufacture an
 * unverified capability, lower privacy, or weaken token requirements.
 */
export function createJevTypedChoiceClient({ systemOne = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (systemOne !== null && typeof systemOne !== "function") throw new TypeError("systemOne must be a function or null");
  positiveInteger(timeoutMs, "timeoutMs");
  return Object.freeze({
    async profileTask(payload, { signal } = {}) {
      if (signal?.aborted) throw runtimeError("JEV_ABORTED");
      if (systemOne === null) throw runtimeError("JEV_TYPED_UNAVAILABLE");
      const task = createTaskProfile(payload);
      const allowed = task.requiredCapabilities.length === 0 ? ["single_model"] : TOPOLOGY_CHOICES;
      const request = deepFreeze({
        state: typedState(task),
        questions: {
          decision: {
            type: "choice",
            instructions: "Select the safe routing profile template that fits this task. Do not produce free text or JSON.",
            criteria: Object.fromEntries(allowed.map((topology) => [topology, topology === "single_model" ? "One execution model." : "Review followed by execution."])),
          },
        },
      });
      const response = await waitForJev(systemOne, request, signal, timeoutMs);
      const topology = answerChoice(response);
      if (!allowed.includes(topology)) throw runtimeError("JEV_TYPED_INVALID_RESPONSE");
      return profileForTopology(task, topology);
    },
  });
}
