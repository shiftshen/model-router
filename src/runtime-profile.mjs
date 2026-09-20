const localPattern = /^(localhost|127\.0\.0\.1|\[::1\]|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;

const liteToolNames = new Set([
  "exec_command",
  "write_stdin",
  "apply_patch",
  "view_image",
  "request_user_input",
  "create_goal",
  "update_goal",
  "get_goal",
]);

const strippedContextPrefixes = [
  "<skills_instructions>",
  "<apps_instructions>",
  "<recommended_plugins>",
];

export function isLocalEndpoint(endpoint) {
  try { return localPattern.test(new URL(String(endpoint ?? "")).hostname); }
  catch { return false; }
}

export function resolveRuntimeProfile(route) {
  const explicit = String(route?.runtimeProfile ?? "auto").trim().toLowerCase();
  if (explicit === "lite" || explicit === "full") return explicit;
  if (["oauth", "chatgpt"].includes(route?.protocol)) return "full";
  return route?.noKey && isLocalEndpoint(route?.endpoint) ? "lite" : "full";
}

function liteTool(tool) {
  if (!tool || typeof tool !== "object") return false;
  if (tool.type === "namespace") return tool.name === "functions" && tool.tools?.some(liteTool);
  if (!["function", "custom"].includes(tool.type)) return false;
  return liteToolNames.has(String(tool.name ?? tool.function?.name ?? ""));
}

function filterContent(content) {
  if (!Array.isArray(content)) return content;
  return content.filter((part) => {
    if (!part || typeof part !== "object" || typeof part.text !== "string") return true;
    const text = part.text.trimStart();
    return !strippedContextPrefixes.some((prefix) => text.startsWith(prefix) && text.trimEnd().endsWith(prefix.replace("<", "</")));
  });
}

function instructionText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && typeof part.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

export function litePayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const next = { ...payload };
  if (Array.isArray(payload.tools)) next.tools = payload.tools.filter(liteTool).map((tool) => tool.type === "namespace" ? { ...tool, tools: tool.tools.filter(liteTool) } : tool);
  if (Array.isArray(payload.input)) {
    const instructions = [typeof payload.instructions === "string" ? payload.instructions.trim() : ""];
    next.input = payload.input.map((item) => {
      if (!item || typeof item !== "object" || !Array.isArray(item.content)) return item;
      const content = filterContent(item.content);
      return content === item.content ? item : { ...item, content };
    }).filter((item) => {
      if (!item || !["system", "developer"].includes(item.role)) return true;
      const text = instructionText(item.content);
      if (text) instructions.push(text);
      return false;
    });
    const mergedInstructions = instructions.filter(Boolean).join("\n\n");
    if (mergedInstructions) next.instructions = mergedInstructions;
  }
  return next;
}

export function payloadForRoute(payload, route) {
  return resolveRuntimeProfile(route) === "lite" ? litePayload(payload) : payload;
}

export function payloadSize(payload) {
  try { return Buffer.byteLength(JSON.stringify(payload ?? null)); } catch { return 0; }
}
