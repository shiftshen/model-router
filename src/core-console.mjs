import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ModelStore, atomicJSON, validID } from "./model-store.mjs";
import { gatewayURL } from "./model-gateway.mjs";
import { readRecentRoutes, readUsageReport } from "./product-service.mjs";

export const consolePort = 18794;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const json = (res, status, value) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(value)); };
const page = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Model Router 核心管理</title><style>body{font:15px system-ui;max-width:980px;margin:3rem auto;padding:0 1rem;color:#17212b}h1{font-size:1.7rem}section{border:1px solid #d6dce2;border-radius:12px;padding:1.2rem;margin:1rem 0}table{border-collapse:collapse;width:100%}td,th{padding:.55rem;text-align:left;border-bottom:1px solid #e6e9ed}input,button{font:inherit;padding:.55rem;border-radius:7px;border:1px solid #aeb7c2}button{cursor:pointer;background:#edf4ff}code{word-break:break-all}small{color:#5b6570}#usage{white-space:pre-line}</style><h1>Model Router 核心管理</h1><p>上游密钥只存于本机。给其他智能体复制下方生成的代理密钥和地址；它们不需要上游密钥。</p><section><h2>模型与上游密钥</h2><div id="routes">载入中…</div><button id="discover">查看网关可用模型</button><pre id="discovered"></pre></section><section><h2>智能体接入</h2><p>API 地址：<code id="base"></code></p><input id="agent" placeholder="智能体名称（小写英文）"><button id="create">生成代理密钥</button><p id="issued"></p><div id="agents"></div></section><section><h2>用量</h2><small>当前只统计请求数。供应商 token 用量和金额尚未核对时显示未知，不把请求次数换算成费用。</small><div id="usage"></div></section><script>
const key=location.hash.slice(1);history.replaceState(null,'',location.pathname);const api=async(path,method='GET',body)=>{const r=await fetch(path,{method,headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const v=await r.json();if(!r.ok)throw Error(v.error||r.status);return v};const el=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n};
async function load(){try{const d=await api('/api/status');document.getElementById('base').textContent=location.origin+'/v1';const t=el('table','');let h=el('tr','');for(const x of ['模型','路线','凭据','验证','操作'])h.append(el('th',x));t.append(h);for(const r of d.routes){let row=el('tr','');for(const x of [r.name,r.model,r.noKey?'本地服务':r.hasKey?'已配置':'缺失',r.verifiedAt||'未验证'])row.append(el('td',x||'—'));const cell=el('td','');if(r.protocol!=='oauth'&&!r.noKey){const b=el('button','更新 Key');b.onclick=async()=>{const secret=prompt('输入 '+r.name+' 的新上游 Key');if(!secret)return;try{await api('/api/credentials/'+r.id,'PUT',{secret});alert('已保存');load()}catch(e){alert(e.message)}};cell.append(b)}row.append(cell);t.append(row)}document.getElementById('routes').replaceChildren(t);const a=el('ul','');for(const x of d.agents){const li=el('li',x.id+' · '+x.createdAt+' ');const b=el('button','撤销');b.onclick=async()=>{if(!confirm('撤销 '+x.id+' 的代理密钥？'))return;await api('/api/agents/'+x.id,'DELETE');load()};li.append(b);a.append(li)}document.getElementById('agents').replaceChildren(a);const lines=d.usage.map(x=>x.day+'：网关请求 '+x.total+'，网关标记完成 '+x.confirmedTotal+'，失败 '+x.failedTotal);for(const [day,agents] of Object.entries(d.agentUsage||{}))for(const [name,v] of Object.entries(agents))lines.push(day+' · '+name+'：代理请求 '+v.requests+'，HTTP 2xx '+v.completed+'，非 2xx '+v.failed);document.getElementById('usage').textContent=(lines.join('\n')||'暂无记录')+'；费用未知'}catch(e){document.body.append(el('p','无法加载：'+e.message))}}
document.getElementById('create').onclick=async()=>{try{const id=document.getElementById('agent').value.trim();const d=await api('/api/agents','POST',{id});const box=document.getElementById('issued');box.replaceChildren(el('span','仅本次显示 '+id+' 的代理密钥： '),el('code',d.key));const b=el('button','复制密钥');b.onclick=()=>navigator.clipboard.writeText(d.key);box.append(b);load()}catch(e){alert(e.message)}};document.getElementById('discover').onclick=async()=>{try{const v=await api('/api/models');document.getElementById('discovered').textContent=(v.data||[]).map(x=>x.id).join('\n')||'没有可用模型'}catch(e){document.getElementById('discovered').textContent=e.message}};load();</script></html>`;

async function body(req) {
  let text = "";
  for await (const chunk of req) { text += chunk; if (text.length > 8 * 1024 * 1024) throw Error("请求过大"); }
  return JSON.parse(text || "{}");
}

export function createCoreConsole(store = new ModelStore(), { port = consolePort, gateway = gatewayURL } = {}) {
  const agentFile = path.join(store.root, "core-agents.json");
  const usageFile = path.join(store.root, "core-agent-usage.json");
  const readAgents = async () => { try { const v = JSON.parse(await fs.readFile(agentFile, "utf8")); return Array.isArray(v) ? v : []; } catch (e) { if (e.code === "ENOENT") return []; throw e; } };
  const readAgentUsage = async () => { try { return JSON.parse(await fs.readFile(usageFile, "utf8")); } catch (e) { if (e.code === "ENOENT") return {}; throw e; } };
  let agentsQueue = Promise.resolve();
  let usageQueue = Promise.resolve();
  const mutateAgents = (fn) => { const work = agentsQueue.then(async () => { const list = await readAgents(); const result = await fn(list); await atomicJSON(agentFile, list); return result; }); agentsQueue = work.catch(() => {}); return work; };
  const countAgentCall = (id, status) => { const work = usageQueue.then(async () => { const data = await readAgentUsage(); const day = new Date().toISOString().slice(0, 10); const row = data[day] ||= {}; const item = row[id] ||= { requests: 0, completed: 0, failed: 0 }; item.requests += 1; item[status >= 200 && status < 300 ? "completed" : "failed"] += 1; for (const stale of Object.keys(data).sort().slice(0, -60)) delete data[stale]; await atomicJSON(usageFile, data); }); usageQueue = work.catch(() => {}); return work; };
  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host;
      if (!host || !new RegExp(`^(127\\.0\\.0\\.1|localhost):${server.address().port}$`).test(host)) return json(res, 403, { error: "仅允许本机访问" });
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(res, 403, { error: "跨站请求被拒绝" });
      const pathname = new URL(req.url, `http://${host}`).pathname;
      if (pathname === "/" && req.method === "GET") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" }); return res.end(page); }
      const supplied = String(req.headers.authorization || "").replace(/^Bearer /, "");
      if (pathname.startsWith("/v1/")) {
        const agent = (await readAgents()).find((x) => same(x.digest, hash(supplied)));
        if (!agent) return json(res, 401, { error: "代理密钥无效" });
        if (!((pathname === "/v1/models" && req.method === "GET") || (pathname === "/v1/responses" && req.method === "POST"))) return json(res, 404, { error: "接口不存在" });
        const payload = req.method === "POST" ? await body(req) : null;
        const upstream = await fetch(`${gateway}/router${pathname}`, { method: req.method, headers: { authorization: `Bearer ${await store.token("router")}`, ...(payload ? { "content-type": "application/json" } : {}) }, body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(3600000) });
        if (pathname === "/v1/responses") await countAgentCall(agent.id, upstream.status);
        res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json", "cache-control": "no-store", "x-model-router-agent": agent.id });
        if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
        return res.end();
      }
      if (!same(supplied, await store.token("core-admin"))) return json(res, 401, { error: "管理令牌无效" });
      if (pathname === "/api/status" && req.method === "GET") {
        const data = await store.publicData();
        return json(res, 200, { routes: data.routes.map(({ id, name, model, protocol, noKey, hasKey, verifiedAt }) => ({ id, name, model, protocol, noKey, hasKey, verifiedAt })), agents: (await readAgents()).map(({ id, createdAt }) => ({ id, createdAt })), usage: await readUsageReport(store.root, 7), agentUsage: await readAgentUsage(), recentRoutes: await readRecentRoutes(store.root, 20) });
      }
      if (pathname === "/api/agents" && req.method === "POST") {
        const { id } = await body(req);
        if (!validID(id)) return json(res, 400, { error: "名称只能含小写英文、数字和连字符，且以字母开头" });
        const key = `mr-${randomBytes(32).toString("hex")}`;
        await mutateAgents((list) => { if (list.some((x) => x.id === id)) throw Error("名称已存在"); list.push({ id, digest: hash(key), createdAt: new Date().toISOString() }); });
        return json(res, 201, { id, key });
      }
      const agentMatch = pathname.match(/^\/api\/agents\/([a-z][a-z0-9-]{0,63})$/);
      if (agentMatch && req.method === "DELETE") { await mutateAgents((list) => { const at = list.findIndex((x) => x.id === agentMatch[1]); if (at < 0) throw Error("智能体不存在"); list.splice(at, 1); }); return json(res, 200, { ok: true }); }
      const credentialMatch = pathname.match(/^\/api\/credentials\/([a-z][a-z0-9-]{0,63})$/);
      if (credentialMatch && req.method === "PUT") {
        const route = await store.route(credentialMatch[1]);
        if (route.protocol === "oauth" || route.noKey) return json(res, 400, { error: "此路线无需上游 Key" });
        const { secret } = await body(req);
        await store.writeSecret(route.credentialID, secret);
        return json(res, 200, { ok: true, route: route.id });
      }
      if (pathname === "/api/models" && req.method === "GET") {
        const result = await fetch(`${gateway}/router/v1/models`, { headers: { authorization: `Bearer ${await store.token("router")}` }, signal: AbortSignal.timeout(10000) });
        return json(res, result.status, await result.json());
      }
      return json(res, 404, { error: "接口不存在" });
    } catch (error) { return json(res, 400, { error: String(error.message || error) }); }
  });
  return { server, async start() { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); }); const token = await store.token("core-admin"); return `http://127.0.0.1:${server.address().port}/#${token}`; }, close() { return new Promise((resolve) => server.close(resolve)); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const consoleServer = createCoreConsole();
  consoleServer.start().then((url) => process.stdout.write(`本机管理页：${url}\n`), (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
