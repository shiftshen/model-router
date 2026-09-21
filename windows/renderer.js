let state = { revision: 0, routes: [], windows: [], threads: [], switchModels: [], todayUsage: null, fallbacks: [], update: null };
let platformInfo = { platform: "win32", arch: "x64", version: "0.0.0", packaged: false, portable: false };
const byId = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[ch]));

async function call(command, args, input) {
  const result = await window.cma.call(command, args || [], input == null ? null : input);
  if (!result || result.ok === false) throw new Error(result && result.message || "操作失败");
  return result;
}

function setStatus(message, error) {
  const node = byId("status");
  node.textContent = message || "";
  node.style.color = error ? "#ff7d7d" : "";
}

function routeById(id) { return state.routes.find((item) => item.id === id); }
function baseName(value) { return String(value || "").replaceAll("\\\\", "/").split("/").filter(Boolean).at(-1) || "?"; }

function renderUsage() {
  const u = state.todayUsage;
  const hosts = u && u.hosts ? Object.entries(u.hosts).map(([k,v]) => k + " ×" + v).join(" · ") : "今天还没有网关请求";
  byId("usage").textContent = hosts;
}

function renderWindows() {
  const target = byId("windows");
  const items = state.windows || [];
  const official = '<article class="card official-card"><div class="card-head"><div><div class="title">ChatGPT Desktop（官方）</div><div class="muted">原版 · 复用你的 ChatGPT/Codex 登录</div></div><span class="badge ok">官方</span></div><div class="official-note">直接打开系统里的官方 ChatGPT Desktop / Codex 默认资料。不会创建 Model Router CODEX_HOME，也不会进入第三方模型路由；官方模型请在原版客户端里选择。</div><div class="card-actions"><button data-sync-official="1">加入可切换窗口</button><button class="primary" data-official-open="1">打开 / 切到 ChatGPT Desktop</button></div></article>';
  const managed = items.map((w) => {
    const current = state.switchModels.find((m) => m.slug === w.currentModel || m.id === w.currentModel || m.model === w.currentModel);
    const initial = routeById(w.initialModel);
    return '<article class="card"><div class="card-head"><div><div class="title">' + escapeHtml(w.name || w.id) + '</div><div class="muted">' + escapeHtml(w.id) + '</div></div><span class="badge ' + (w.running ? "ok" : "") + '">' + (w.running ? "运行中 · PID " + (w.pid || "") : "未运行") + '</span></div><div>当前模型：' + escapeHtml(current && current.name || w.currentModel || "未选择") + '</div><div class="muted">起始模型：' + escapeHtml(initial && initial.name || w.initialModel || "自动") + '</div><div class="card-actions"><button data-win-open="' + escapeHtml(w.id) + '">打开</button>' + (w.running ? '<button data-win-close="' + escapeHtml(w.id) + '">关闭</button>' : '') + '</div></article>';
  }).join("");
  target.innerHTML = official + managed;
}

function renderThreads() {
  const target = byId("threads");
  const rows = state.threads || [];
  if (!rows.length) { target.innerHTML = '<div class="empty">最近 30 分钟没有活跃对话</div>'; return; }
  target.innerHTML = rows.slice(0, 12).map((t) => {
    const billing = t.billing || {};
    const title = t.title || String(t.id || "").slice(0,8);
    const where = (t.scope || "未知窗口") + " · " + baseName(t.cwd);
    const detail = "Thread " + (t.id || "?") + " | provider " + (t.providerID || "?") + " | route " + (t.routeName || t.routeID || "未记录");
    return '<button class="list-row thread-row" data-thread-open="' + escapeHtml(t.scopeKey || "") + '" data-thread-id="' + escapeHtml(t.id || "") + '" title="' + escapeHtml(detail) + '"><strong>' + escapeHtml(where) + '</strong><span>' + escapeHtml(title) + ' <small>#' + escapeHtml(String(t.id || "").slice(0,8)) + '</small></span><code>' + escapeHtml(t.model || "未记录模型") + '</code><span class="billing-' + escapeHtml(billing.kind || "unknown") + '">' + escapeHtml(billing.label || "未知上游") + '</span><span class="muted">' + escapeHtml(t.minutesAgo == null ? "" : t.minutesAgo + " 分钟") + '</span></button>';
  }).join("");
}

function renderModels() {
  const showArchived = byId("showArchived").checked;
  const query = byId("modelSearch").value.trim().toLowerCase();
  const routes = (state.routes || []).filter((r) => {
    if (!showArchived && r.archived) return false;
    if (!query) return true;
    return [r.name, r.vendor, r.model, r.endpoint].some((value) => String(value || "").toLowerCase().includes(query));
  });
  byId("modelCount").textContent = routes.length + " / " + (state.routes || []).length;
  const target = byId("models");
  target.innerHTML = routes.map((r) => {
    const official = r.protocol === "oauth";
    const ready = r.protocol === "oauth" || (!!r.model && (r.noKey || r.hasKey || r.protocol === "chatgpt"));
    const statusClass = r.verifiedAt ? "ok" : (ready ? "" : "warn");
    const statusText = r.archived ? "已归档" : (r.verifiedAt ? "已验证" : (ready ? "待验证" : "待配置"));
    const modelText = official ? "模型由 ChatGPT Desktop 内选择" : (r.model || "尚未选择模型 ID");
    return '<article class="card model-card"><div class="card-head"><div><div class="title">' + escapeHtml(r.name) + '</div><div class="model-vendor">' + escapeHtml(r.vendor || "") + '</div></div><span class="badge ' + statusClass + '">' + statusText + '</span></div><code title="' + escapeHtml(modelText) + '">' + escapeHtml(modelText) + '</code><div class="muted model-endpoint" title="' + escapeHtml(r.endpoint || "") + '">' + escapeHtml(r.endpoint || (official ? "ChatGPT 官方服务" : "")) + '</div><div class="card-actions"><button data-open-model="' + escapeHtml(r.id) + '">' + (official ? "打开 ChatGPT Desktop" : "打开") + '</button>' + (official ? "" : '<button data-edit-model="' + escapeHtml(r.id) + '">编辑</button><button data-check-model="' + escapeHtml(r.id) + '">检查</button><button data-probe-model="' + escapeHtml(r.id) + '">验证</button>') + '</div></article>';
  }).join("") || '<div class="empty">模型库为空</div>';

  const options = (state.switchModels || []).map((m) => '<option value="' + escapeHtml(m.id) + '">' + escapeHtml(m.name) + '</option>').join("");
  byId("newWindowModel").innerHTML = options;
}

function renderFallbacks() {
  const target = byId("fallbacks");
  const rows = state.fallbacks || [];
  if (!rows.length) { target.innerHTML = ""; return; }
  const f = rows[0];
  const from = routeById(f.from);
  const stillConfigured = !!from && from.fallback === f.to;
  const recent = Number.isFinite(Date.parse(f.at)) && Date.now() - Date.parse(f.at) < 6 * 3600 * 1000;
  const thread = f.sessionId ? (state.threads || []).find((t) => t.id === f.sessionId) : null;
  const threadHtml = thread
    ? '<button data-thread-open="' + escapeHtml(thread.scopeKey || "") + '" data-thread-id="' + escapeHtml(thread.id) + '">打开对应对话所在窗口：' + escapeHtml((thread.scope || "?") + " · " + baseName(thread.cwd) + " · #" + thread.id.slice(0,8)) + '</button>'
    : (f.sessionId ? '<div class="muted">Thread：' + escapeHtml(f.sessionId) + '（当前不在活跃列表）</div>' : '<div class="muted">旧版本事件未记录 Thread ID，无法追溯具体对话。</div>');
  target.innerHTML = '<section class="fallback-card ' + (recent ? "recent" : "stale") + '"><strong>' + (recent ? "备用模型触发记录" : "历史备用切换记录") + '：' + escapeHtml(f.fromName) + ' → ' + escapeHtml(f.toName) + '</strong><div>fallback 只对那一次失败请求生效，不代表窗口或所有对话持续使用备用模型。</div><div class="muted">时间：' + escapeHtml(f.at) + ' · 原因：' + escapeHtml(f.reason || "未记录") + '</div><div class="muted">当前规则：' + (stillConfigured ? "仍配置该备用，下次失败仍可能触发" : "该备用配置已经不存在，这里只是历史记录") + '</div>' + threadHtml + '</section>';
}

function renderUpdate() {
  const target = byId("updateBanner");
  const update = state.update;
  if (!update || !update.available) { target.innerHTML = ""; return; }
  const mode = platformInfo.portable ? "Portable：下载新版后手动替换旧文件" : "安装版：确认后自动下载、校验并安装";
  target.innerHTML = '<section class="fallback-card recent"><strong>发现 Model Router ' + escapeHtml(update.latestVersion || "新版本") + '</strong><div>' + escapeHtml(mode) + '</div><div class="muted">更新源：GitHub Releases · ' + escapeHtml(update.assetName || "") + '</div><button data-update-install="1">' + (platformInfo.portable ? "下载新版" : "下载并安装") + '</button></section>';
}

async function checkUpdate(silent) {
  try {
    if (!silent) setStatus("正在检查 GitHub 新版本…");
    const variant = platformInfo.portable ? "portable" : "installed";
    const result = await call("check-update", [platformInfo.version, "win32", variant]);
    state.update = result.update || null;
    renderUpdate();
    if (!silent) setStatus(result.message || (state.update && state.update.available ? "发现新版本" : "当前已是最新版本"));
  } catch (error) {
    if (!silent) setStatus(error.message, true);
  }
}

function accept(data) {
  state = { ...state, ...data };
  renderUsage(); renderWindows(); renderThreads(); renderModels(); renderFallbacks(); renderUpdate();
}

async function refresh() {
  setStatus("正在刷新…");
  try {
    await call("start-gateway");
    const data = await call("library");
    accept(data);
    setStatus(data.message || "已刷新");
  } catch (error) {
    setStatus(error.message, true);
  }
}

function openEditor(route) {
  const isNew = !route;
  const current = route || { id: "model-" + crypto.randomUUID().replaceAll("-","").slice(0,20), name:"", vendor:"自定义", endpoint:"https://api.deepseek.com/v1", protocol:"responses", model:"", notes:"", docs:"", credentialID:"", noKey:false, archived:false, switchable:true, fallback:"", contextWindow:0 };
  byId("dialogTitle").textContent = isNew ? "新增模型" : "编辑模型";
  byId("modelId").value = current.id || "";
  byId("modelName").value = current.name || "";
  byId("modelVendor").value = current.vendor || "";
  byId("modelModel").value = current.model || "";
  byId("modelProtocol").value = current.protocol || "responses";
  byId("modelEndpoint").value = current.endpoint || "";
  byId("modelKey").value = "";
  byId("modelContext").value = current.contextWindow || "";
  byId("modelRuntimeProfile").value = current.runtimeProfile || "auto";
  byId("modelNoKey").checked = !!current.noKey;
  byId("modelSwitchable").checked = current.switchable !== false;
  byId("modelFallback").innerHTML = '<option value="">不设置</option>' + (state.routes || []).filter((x) => x.id !== current.id && x.protocol !== "oauth" && !x.archived).map((x) => '<option value="' + escapeHtml(x.id) + '">' + escapeHtml(x.name) + '</option>').join("");
  byId("modelFallback").value = current.fallback || "";
  byId("modelDialog").showModal();
}

async function saveEditor(event) {
  event.preventDefault();
  const id = byId("modelId").value;
  const prior = routeById(id) || {};
  const route = {
    ...prior,
    id,
    name: byId("modelName").value.trim(),
    vendor: byId("modelVendor").value.trim() || "自定义",
    endpoint: byId("modelEndpoint").value.trim(),
    protocol: byId("modelProtocol").value,
    model: byId("modelModel").value.trim(),
    notes: prior.notes || "",
    docs: prior.docs || "",
    credentialID: prior.credentialID || id,
    noKey: byId("modelNoKey").checked,
    runtimeProfile: byId("modelRuntimeProfile").value,
    archived: !!prior.archived,
    hidden: !!prior.hidden,
    switchable: byId("modelSwitchable").checked,
    fallback: byId("modelFallback").value,
    contextWindow: Number(byId("modelContext").value || 0)
  };
  try {
    setStatus("正在保存…");
    const result = await call("save", [], { route, revision: state.revision, key: byId("modelKey").value, clearKey: false });
    byId("modelDialog").close();
    accept(result);
    await refresh();
  } catch (error) { setStatus(error.message, true); }
}

document.addEventListener("click", async (event) => {
  const el = event.target.closest("button");
  if (!el) return;
  try {
    if (el.dataset.editModel) return openEditor(routeById(el.dataset.editModel));
    if (el.dataset.syncOfficial) { el.disabled = true; try { const result = await call("sync-official-models"); await refresh(); accept(result); setStatus(result.message || "官方登录模型已加入"); } finally { el.disabled = false; } return; }
    if (el.dataset.officialOpen) { setStatus("正在打开 ChatGPT Desktop（官方）…"); accept(await call("open-codex", ["official"])); return; }
    if (el.dataset.openModel) { setStatus("正在打开 Codex…"); accept(await call("open-codex", [el.dataset.openModel])); return; }
    if (el.dataset.checkModel) { setStatus("正在检查连接…"); setStatus((await call("check", [el.dataset.checkModel])).message || "连接正常"); return; }
    if (el.dataset.probeModel) { setStatus("正在真实验证…"); accept(await call("probe", [el.dataset.probeModel])); return; }
    if (el.dataset.winOpen) { setStatus("正在打开窗口…"); accept(await call("open-window", [el.dataset.winOpen])); return; }
    if (el.dataset.winClose) { setStatus("正在关闭窗口…"); accept(await call("close-window", [el.dataset.winClose])); return; }
    if (el.dataset.updateInstall) {
      const variant = platformInfo.portable ? "portable" : "installed";
      setStatus("正在从 GitHub 下载并校验更新…");
      const result = await call("prepare-update", [platformInfo.version, "win32", "0", "", variant]);
      state.update = result.update || state.update;
      const action = await window.cma.installUpdate(state.update.downloadedPath, !!state.update.portable, state.update.releaseUrl || "");
      setStatus(action.message || result.message || "更新已准备");
      return;
    }
    if (el.dataset.threadOpen) {
      const key = el.dataset.threadOpen;
      setStatus("正在打开对话所在窗口…");
      if (key === "official") accept(await call("open-codex", ["official"]));
      else if ((state.windows || []).some((w) => w.id === key)) accept(await call("open-window", [key]));
      else if (key) accept(await call("open-codex", [key]));
      else setStatus("这条对话缺少窗口归属，Thread ID：" + (el.dataset.threadId || "?"), true);
      return;
    }
  } catch (error) { setStatus(error.message, true); }
});

byId("refreshBtn").addEventListener("click", refresh);
byId("diagBtn").addEventListener("click", async () => { try { setStatus("正在诊断…"); setStatus((await call("diagnostics")).message || "诊断完成"); } catch(e){ setStatus(e.message,true); } });
byId("dataBtn").addEventListener("click", () => window.cma.openDataDir());
byId("updateBtn").addEventListener("click", () => checkUpdate(false));
byId("addBtn").addEventListener("click", () => openEditor(null));
byId("showArchived").addEventListener("change", renderModels);
byId("modelSearch").addEventListener("input", renderModels);
byId("newWindowBtn").addEventListener("click", async () => { try { const id = byId("newWindowModel").value; setStatus("正在新建窗口…"); accept(await call("new-window", [id])); } catch(e){ setStatus(e.message,true); } });
byId("modelForm").addEventListener("submit", saveEditor);

(async () => {
  platformInfo = await window.cma.platform();
  byId("subtitle").textContent = "Windows Preview · v" + platformInfo.version + " · " + platformInfo.arch + (platformInfo.portable ? " · Portable" : "");
  await refresh();
  await checkUpdate(true);
  setInterval(() => checkUpdate(true), 6 * 60 * 60 * 1000);
})();
