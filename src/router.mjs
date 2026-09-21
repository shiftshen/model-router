import { resolveContextWindow } from "./model-windows.mjs";

export const routerID = "router";
export const routerProviderID = "cma_router";

export function slugifyModel(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.\-]+|[.\-]+$/g, "");
}

// 可切换窗口只接入网关能转换的第三方接口；官方 ChatGPT 登录自带模型选择，不重复接入。
export function switchableRoutes(routes) {
  return routes
    .filter((route) => !route.archived && !["oauth", "chatgpt"].includes(route.protocol) && Boolean(route.model))
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function buildRouterTable(routes) {
  const taken = new Map(routes.filter(route => route.routerSlug).map(route => [route.routerSlug, route]));
  return switchableRoutes(routes).map((route) => {
    const base = route.routerSlug || slugifyModel(route.model) || slugifyModel(route.id) || "model";
    let slug = base;
    let suffix = 1;
    while (taken.has(slug) && taken.get(slug).id !== route.id) {
      suffix += 1;
      slug = `${base}-${suffix}`;
    }
    taken.set(slug, route);
    return { slug, route };
  });
}

export function routerTableEntry(table, slug) {
  const wanted = String(slug ?? "").trim();
  if (!wanted) return null;
  const legacy = table.filter(entry => entry.route.routerAliases?.includes(wanted));
  return (
    table.find((entry) => entry.slug === wanted) ||
    (legacy.length === 1 ? legacy[0] : null) ||
    table.find((entry) => entry.route.model === wanted) ||
    table.find((entry) => entry.route.model.toLowerCase() === wanted.toLowerCase()) ||
    table.find((entry) => entry.route.id === wanted) ||
    null
  );
}

export function modelInfo(route, slug) {
  const window = resolveContextWindow(route);
  return {
    slug,
    display_name: route.name,
    description: route.vendor,
    default_reasoning_level: "medium",
    supported_reasoning_levels: [],
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: "freeform",
    truncation_policy: { mode: "tokens", limit: 10000 },
    context_window: window,
    // Codex 自己会压缩：它按「context_window × effective_context_window_percent」算阈值，
    // 到点就自动摘要、换新窗口继续，不需要外面替它压缩。
    // 百分比对齐官方模型的 95；同时把阈值显式写出来，避免不同版本对空值默认值理解不一致。
    effective_context_window_percent: 95,
    auto_compact_token_limit: Math.floor(window * 0.95),
    experimental_supported_tools: [],
    input_modalities: ["text", "image"],
    supports_search_tool: false,
    supports_parallel_tool_calls: true,
    base_instructions: "",
  };
}

export function routerCatalog(table) {
  const models = table.map(({ slug, route }) => modelInfo(route, slug));
  const seen = new Set(models.map(model => model.slug));
  for (const { route } of table) {
    for (const alias of route.routerAliases || []) {
      if (seen.has(alias) || routerTableEntry(table, alias)?.route.id !== route.id) continue;
      seen.add(alias);
      models.push({ ...modelInfo(route, alias), visibility: "hide" });
    }
  }
  return { models };
}
