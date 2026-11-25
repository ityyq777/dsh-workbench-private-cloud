// 浏览器概览页：服务端渲染一个静态外壳，数据由页面内脚本带密钥拉取 /v1/stats。
// 不引入任何外部依赖与 CDN，颜色跟随系统深浅色。
import { accessInfo } from "./access.js";

const KEY_STORAGE = "wb-private-cloud-key";

/** 连接方式卡片：服务端算好地址（本机 + 各局域网网卡），不依赖密钥就可见，方便照着在手机上打开。 */
function accessCard(config) {
  const access = accessInfo(config);
  const rows = [{ label: "本机连接", tag: "本机", url: access.local }];
  for (const item of access.lan) rows.push({ label: "局域网连接", tag: item.virtual ? item.interface + " · 虚拟" : item.interface, url: item.url });
  const lines = [
    '<section class="card access" id="access">',
    "<h2>连接方式</h2>",
    ...rows.map(
      (row) =>
        '<div class="access-row"><span class="access-label">' +
        escapeHtml(row.label) +
        '</span><code class="access-url">' +
        escapeHtml(row.url) +
        '</code><span class="access-iface">' +
        escapeHtml(row.tag) +
        '</span><button class="copy" type="button" data-copy="' +
        escapeHtml(row.url) +
        '">复制</button></div>',
    ),
    access.override
      ? '<p class="hint">局域网地址来自 <code>WB_PRIVATE_PUBLIC_HOST</code>（手动指定），不是网卡自动探测的结果。</p>'
      : access.lan.length
        ? '<p class="hint">手机与电脑连同一个 Wi-Fi 后，用「局域网连接」地址打开即可。打不开时先检查路由器是否开了 AP 隔离或访客网络，以及本机防火墙是否放行该端口。</p>'
        : '<p class="hint">没有探测到局域网 IPv4 地址（可能只连着 VPN 或网卡还没就绪）。可在 <code>.env</code> 里用 <code>WB_PRIVATE_PUBLIC_HOST</code> 手动指定对外地址。</p>',
    "</section>",
  ];
  return lines.join("\n");
}

export function dashboardHtml(config) {
  const title = "私人云端 · " + config.serverName;
  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>" + escapeHtml(title) + "</title>",
    "<style>" + CSS + "</style>",
    "</head>",
    '<body data-key-storage="' + KEY_STORAGE + '">',
    '<header class="top">',
    '<div class="brand"><span class="dot" id="dot"></span><h1 id="server-name">私人云端</h1><span class="badge" id="version"></span></div>',
    '<div class="meta"><span id="uptime">—</span><span id="server-time">—</span></div>',
    "</header>",
    '<main id="main">',
    accessCard(config),
    '<section class="card auth" id="auth-card" hidden>',
    "<h2>输入访问密钥</h2>",
    '<p class="hint">密钥就是服务端启动时的 <code>WB_PRIVATE_SECRET</code>。只保存在本浏览器的 localStorage 里。</p>',
    '<div class="row"><input id="key-input" type="password" placeholder="访问密钥" autocomplete="off"><button id="key-save" class="primary">连接</button></div>',
    '<p class="err" id="auth-err"></p>',
    "</section>",
    '<section class="grid" id="stats" hidden>',
    '<div class="card"><h2>存储用量</h2><div id="usage"></div></div>',
    '<div class="card"><h2>同步活动</h2><div id="changes"></div></div>',
    '<div class="card wide"><h2>设备</h2><div id="devices"></div></div>',
    '<div class="card wide"><h2>数据表</h2><div id="tables"></div></div>',
    '<div class="card wide"><h2>当前同步会话</h2><div id="session"></div></div>',
    '<div class="card wide danger">',
    "<h2>数据清空</h2>",
    '<p class="hint">删除本服务上的全部同步数据、设备记录与文件，实例身份保留。此操作不可撤销，且不会自动通知已连接的设备。</p>',
    '<ul class="scope"><li>业务表全部行：任务、标签、站点、储物、邮件等</li><li>变更日志、行状态、表版本与同步会话</li><li>设备记录与 blob 文件</li></ul>',
    '<div class="row"><input id="clear-input" type="text" placeholder="输入：清空云端数据" autocomplete="off"><button id="clear-go" class="danger" disabled>清空云端数据</button></div>',
    '<p class="err" id="clear-err"></p>',
    "</div>",
    "</section>",
    "</main>",
    '<footer class="foot"><span>dsh-workbench-private-cloud</span><button id="refresh" class="ghost">刷新</button></footer>',
    "<script>" + SCRIPT + "</script>",
    "</body>",
    "</html>",
  ].join("\n");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#1b1f24;--muted:#6a7280;--card:#fff;--line:#e3e6ea;--accent:#0f9b8e;--warn:#c2410c;--ok:#0f9b8e}
@media (prefers-color-scheme:dark){:root{--bg:#14171a;--fg:#e6e9ec;--muted:#9aa3ad;--card:#1b1f24;--line:#2a3037;--accent:#2dd4bf}}
*{box-sizing:border-box}
[hidden]{display:none !important}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
.top{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:1px solid var(--line);background:var(--card)}
.brand{display:flex;align-items:center;gap:10px}
.brand h1{font-size:17px;margin:0;font-weight:650}
.dot{width:9px;height:9px;border-radius:50%;background:var(--muted)}
.dot.on{background:var(--ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--ok) 25%,transparent)}
.badge{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:1px 8px}
.meta{display:flex;gap:14px;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
main{max-width:1080px;margin:0 auto;padding:20px 24px 8px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px}
.card.wide{grid-column:1/-1}
.card h2{font-size:13px;margin:0 0 12px;color:var(--muted);font-weight:600;letter-spacing:.02em}
.access{margin-bottom:16px}
.access-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;padding:7px 0;border-bottom:1px dashed var(--line)}
.access-row:last-of-type{border-bottom:0}
.access-label{color:var(--muted);font-size:12px;min-width:64px}
.access-url{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;overflow-wrap:anywhere}
.access-iface{font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:0 7px}
button.copy{margin-left:auto;font-size:12px;padding:4px 10px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);font-size:13px}
th{color:var(--muted);font-weight:500;white-space:nowrap}
tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right}
.empty{color:var(--muted);font-size:13px;padding:6px 0}
.kv{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px dashed var(--line)}
.kv:last-child{border-bottom:0}
.kv b{font-weight:600;font-variant-numeric:tabular-nums}
.bar{height:8px;border-radius:999px;background:var(--line);overflow:hidden;margin:8px 0 6px}
.bar > i{display:block;height:100%;background:var(--accent);width:0}
.auth{max-width:560px;margin:40px auto}
.row{display:flex;gap:10px}
input{flex:1;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
input:focus{outline:2px solid color-mix(in srgb,var(--accent) 45%,transparent);outline-offset:1px}
button{padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit;font:inherit;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#04211d;font-weight:600}
button.ghost{color:var(--muted)}
.hint{color:var(--muted);font-size:13px;margin:6px 0 12px}
.err{color:var(--warn);font-size:13px;min-height:20px;margin:8px 0 0}
.foot{display:flex;justify-content:space-between;align-items:center;max-width:1080px;margin:8px auto 24px;padding:0 24px;color:var(--muted);font-size:12px}
code{background:color-mix(in srgb,var(--fg) 8%,transparent);padding:1px 5px;border-radius:5px}
.danger{border-color:color-mix(in srgb,var(--warn) 42%,var(--line))}
.danger h2{color:var(--warn)}
.scope{margin:8px 0 12px;padding-left:18px;color:var(--muted);font-size:13px;line-height:1.75}
button.danger{border-color:var(--warn);color:var(--warn);background:transparent;font-weight:600}
button.danger:disabled{opacity:.42;cursor:default}
.err.ok{color:var(--ok)}
`;

const SCRIPT = `
(function(){
  var STORE = document.body.getAttribute("data-key-storage");
  var key = localStorage.getItem(STORE) || "";
  var els = {
    dot: document.getElementById("dot"), name: document.getElementById("server-name"),
    version: document.getElementById("version"), uptime: document.getElementById("uptime"),
    time: document.getElementById("server-time"), auth: document.getElementById("auth-card"),
    stats: document.getElementById("stats"), input: document.getElementById("key-input"),
    err: document.getElementById("auth-err")
  };
  function el(tag, cls, text){ var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function bytes(n){ n = Number(n)||0; var u=["B","KB","MB","GB","TB"], i=0; while(n>=1024 && i<u.length-1){ n/=1024; i++; } return (i? n.toFixed(n<10?2:1) : Math.round(n)) + " " + u[i]; }
  function when(ms){ if(!ms) return "—"; var d = new Date(Number(ms)); return d.toLocaleString("zh-CN",{hour12:false}); }
  function ago(ms){ if(!ms) return "从未同步"; var s = Math.max(0, (Date.now()-Number(ms))/1000); if(s<60) return "刚刚"; if(s<3600) return Math.round(s/60)+" 分钟前"; if(s<86400) return Math.round(s/3600)+" 小时前"; return Math.round(s/86400)+" 天前"; }
  function duration(s){ s = Number(s)||0; var d=Math.floor(s/86400), h=Math.floor(s%86400/3600), m=Math.floor(s%3600/60); if(d) return d+" 天 "+h+" 小时"; if(h) return h+" 小时 "+m+" 分"; if(m) return m+" 分"; return s+" 秒"; }
  function table(cols, rows){ if(!rows.length) return el("div","empty","暂无数据"); var t = el("table"); var tr = el("tr"); cols.forEach(function(c){ tr.appendChild(el("th", c.num?"num":null, c.label)); }); var head = el("thead"); head.appendChild(tr); t.appendChild(head); var body = el("tbody"); rows.forEach(function(r){ var row = el("tr"); cols.forEach(function(c){ row.appendChild(el("td", c.num?"num":null, c.get(r))); }); body.appendChild(row); }); t.appendChild(body); return t; }
  function kv(label, value){ var d = el("div","kv"); d.appendChild(el("span",null,label)); d.appendChild(el("b",null,value)); return d; }
  function showAuth(msg){ els.auth.hidden = false; els.stats.hidden = true; els.dot.className = "dot"; els.err.textContent = msg || ""; els.input.value = key; }
  function render(d){
    els.auth.hidden = true; els.stats.hidden = false; els.dot.className = "dot on";
    els.name.textContent = d.server.name; els.version.textContent = "v" + d.server.version;
    els.uptime.textContent = "已运行 " + duration(d.server.uptime_s); els.time.textContent = when(d.server.server_time);
    var u = d.usage, pct = u.quota_bytes ? Math.min(100, 100 * u.used_bytes / u.quota_bytes) : 0;
    var usage = document.getElementById("usage"); usage.textContent = "";
    usage.appendChild(kv("文件占用", bytes(u.used_bytes) + " / " + bytes(u.quota_bytes)));
    var bar = el("div","bar"); var fill = el("i"); fill.style.width = pct.toFixed(2) + "%"; bar.appendChild(fill); usage.appendChild(bar);
    usage.appendChild(kv("文件数", String(u.blob_count || 0)));
    usage.appendChild(kv("业务引用", String(u.file_refs || 0)));
    usage.appendChild(kv("单文件上限", bytes(u.max_file_bytes)));
    var c = d.changes, ch = document.getElementById("changes"); ch.textContent = "";
    ch.appendChild(kv("变更总数", String(c.total)));
    ch.appendChild(kv("序号范围", c.total ? (c.min_seq + " ~ " + c.max_seq) : "—"));
    ch.appendChild(kv("全量重置", String(c.resets)));
    var names = {}; d.devices.forEach(function(x){ names[x.id] = x.name || x.id; });
    var devs = c.by_device.slice(0, 5); devs.forEach(function(x){ ch.appendChild(kv(names[x.device_id] || x.device_id, String(x.changes))); });
    document.getElementById("devices").replaceChildren(table([
      { label: "设备", get: function(r){ return r.name || "未命名设备"; } },
      { label: "设备 ID", get: function(r){ return r.id; } },
      { label: "最后同步", get: function(r){ return ago(r.last_sync_at); } },
      { label: "变更", num: true, get: function(r){ return String(r.changes); } }
    ], d.devices));
    document.getElementById("tables").replaceChildren(table([
      { label: "表名", get: function(r){ return r.table; } },
      { label: "行数", num: true, get: function(r){ return String(r.rows); } },
      { label: "墓碑", num: true, get: function(r){ return String(r.deleted); } },
      { label: "版本", num: true, get: function(r){ return r.mode === "row" ? "—" : String(r.version); } },
      { label: "模式", get: function(r){ return r.mode; } },
      { label: "最后更新", get: function(r){ return when(r.updated_at); } }
    ], d.tables));
    var box = document.getElementById("session"); box.textContent = "";
    if (d.session) { box.appendChild(kv("设备", d.session.device_id)); box.appendChild(kv("开始", when(d.session.opened_at))); box.appendChild(kv("过期", when(d.session.expires_at) + (d.session.active ? "（进行中）" : "（已过期）"))); }
    else box.appendChild(el("div","empty","当前没有进行中的同步会话"));
  }
  function load(){
    if(!key){ showAuth(""); return; }
    fetch("/v1/stats", { headers: { authorization: "Bearer " + key } }).then(function(r){
      if(r.status === 401){ key = ""; localStorage.removeItem(STORE); showAuth("密钥不正确，请重新输入"); return null; }
      if(!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function(d){ if(d) render(d); }).catch(function(e){ showAuth("读取失败：" + e.message); });
  }
  document.getElementById("key-save").addEventListener("click", function(){
    key = els.input.value.trim(); if(!key) return; localStorage.setItem(STORE, key); load();
  });
  els.input.addEventListener("keydown", function(e){ if(e.key === "Enter") document.getElementById("key-save").click(); });
  document.getElementById("refresh").addEventListener("click", load);

  // 复制连接地址：局域网是 http 明文，navigator.clipboard 在非安全上下文不可用，需要回退到 execCommand。
  function copyText(text, done){
    function legacy(){
      var ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch(e) { /* 复制失败不影响页面其它功能 */ }
      ta.remove();
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, legacy);
    else legacy();
  }
  Array.prototype.forEach.call(document.querySelectorAll("button.copy"), function(btn){
    btn.addEventListener("click", function(){
      copyText(btn.getAttribute("data-copy") || "", function(){
        btn.textContent = "已复制";
        setTimeout(function(){ btn.textContent = "复制"; }, 1500);
      });
    });
  });

  // 数据清空：确认词与 /v1/admin/clear 一致，按钮只有输入完全匹配后才可用。
  var CLEAR_PHRASE = "清空云端数据";
  var clearInput = document.getElementById("clear-input");
  var clearGo = document.getElementById("clear-go");
  var clearErr = document.getElementById("clear-err");
  function syncClearButton(){ clearGo.disabled = clearInput.value.trim() !== CLEAR_PHRASE; }
  clearInput.addEventListener("input", syncClearButton);
  clearGo.addEventListener("click", function(){
    if(clearInput.value.trim() !== CLEAR_PHRASE) return;
    clearGo.disabled = true; clearErr.className = "err"; clearErr.textContent = "正在清空…";
    fetch("/v1/admin/clear", {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({ confirm: CLEAR_PHRASE })
    }).then(function(r){
      return r.json().catch(function(){ return null; }).then(function(d){ return { status: r.status, data: d }; });
    }).then(function(res){
      var d = res.data || {};
      if(res.status === 200 && d.ok){
        clearErr.className = "err ok";
        clearErr.textContent = "已清空 " + d.rows + " 行数据、" + d.blobs + " 个文件；正在刷新统计…";
        clearInput.value = "";
        load();
        return;
      }
      if(res.status === 401){ key = ""; localStorage.removeItem(STORE); showAuth("密钥不正确，请重新输入"); return; }
      clearErr.textContent = d.error || ("清空失败（HTTP " + res.status + "）");
    }).catch(function(e){ clearErr.textContent = "清空失败：" + e.message; })
      .then(syncClearButton);
  });

  load(); setInterval(function(){ if(key) load(); }, 15000);
})();
`;
