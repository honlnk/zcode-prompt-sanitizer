/**
 * Dashboard HTML — a single self-contained page with vanilla JS (no build step,
 * no external CDN) so the proxy works fully offline. Embedded as a TS string to
 * avoid shipping extra static-file-handling machinery.
 *
 * Visual design follows the sibling projects' language:
 *   - picsense's CSS-token system: semantic colors each paired with a soft
 *     translucent tint, plus automatic light/dark theming via prefers-color-scheme.
 *   - linkseek's table pattern: borderless, spacious, row-hover highlight.
 */

/**
 * Brand mark for zcode-prompt-sanitizer: a shield (sanitizer/protection) with a
 * filter funnel at its center (prompt rewriting). Visual style matches the
 * sibling projects linkseek / picsense — a solid rounded-square badge with
 * white line art and a single accent color. Kept as a 64×64 symbol so the same
 * art scales from favicon (16px) to header logo (~22px) without re-rendering.
 */
export const BRAND_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-labelledby="brand-title brand-desc">
  <title id="brand-title">zcode-prompt-sanitizer</title>
  <desc id="brand-desc">A shield with a filtering funnel</desc>
  <rect width="64" height="64" rx="16" fill="#0969DA"/>
  <path d="M32 9 50 16V30c0 11-7.5 19.5-18 23C21.5 49.5 14 41 14 30V16L32 9Z" fill="none" stroke="#fff" stroke-width="4" stroke-linejoin="round"/>
  <path d="M24 22h16l-3 7v3a3 3 0 0 1-3 3h-4a3 3 0 0 1-3-3v-3l-3-7Z" fill="none" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>
  <path d="M28 35h8M30 39h4" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;

/** URL-encoded brand SVG for use inside an <link rel=icon href=data:…>. */
function brandFaviconHref(): string {
  // encodeURIComponent matches the encoding <data:image/svg+xml,…> expects.
  return `data:image/svg+xml,${encodeURIComponent(BRAND_SVG)}`;
}

export function dashboardHtml(version: string): string {
  const favicon = brandFaviconHref();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" type="image/svg+xml" href="${favicon}" />
<link rel="apple-touch-icon" href="${favicon}" />
<title>zcode-prompt-sanitizer</title>
<style>
  /* ---- Design tokens (dark default, light via prefers-color-scheme) ---- */
  :root {
    --bg: #0d1117; --bg-soft: #161b22; --bg-code: #1c2128;
    --border: #30363d;
    --text: #e6edf3; --text-soft: #9198a1; --text-muted: #6e7681;
    --accent: #58a6ff; --accent-soft: rgba(56,139,253,0.15);
    --green: #3fb950; --green-soft: rgba(63,185,80,0.15);
    --red: #f85149; --red-soft: rgba(248,81,73,0.15);
    --yellow: #d29922; --yellow-soft: rgba(210,153,34,0.15);
    --purple: #a371f7; --purple-soft: rgba(163,113,247,0.15);
    --shadow: 0 1px 3px rgba(0,0,0,0.3), 0 8px 24px rgba(0,0,0,0.2);
    --mono: "SFMono-Regular", ui-monospace, "JetBrains Mono", Consolas, Menlo, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    --radius: 12px; --radius-sm: 8px;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #ffffff; --bg-soft: #f7f8fa; --bg-code: #f3f4f6;
      --border: #e5e7eb;
      --text: #1f2328; --text-soft: #57606a; --text-muted: #8b949e;
      --accent: #0969da; --accent-soft: #ddf4ff;
      --green: #1a7f37; --green-soft: #dafbe1;
      --red: #cf222e; --red-soft: #ffebe9;
      --yellow: #9a6700; --yellow-soft: #fff8c5;
      --purple: #8250df; --purple-soft: #fbefff;
      --shadow: 0 1px 3px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.04);
    }
  }

  * { box-sizing: border-box; }
  body { margin: 0; font-family: var(--sans); background: var(--bg); color: var(--text);
         line-height: 1.6; font-size: 14px; -webkit-font-smoothing: antialiased; }

  /* ---- Sticky header with blur ---- */
  header {
    position: sticky; top: 0; z-index: 10;
    padding: 0 24px; height: 56px;
    display: flex; align-items: center; gap: 12px;
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg) 85%, transparent);
    backdrop-filter: saturate(180%) blur(12px);
  }
  header .brand svg { width: 28px; height: 28px; display: block; flex-shrink: 0; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header .meta { color: var(--text-muted); font-size: 13px; font-family: var(--mono); margin-left: auto; }
  header .badge {
    padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600;
    background: var(--green-soft); color: var(--green);
    display: inline-flex; align-items: center; gap: 5px;
  }
  header .badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  header .badge.offline { background: var(--red-soft); color: var(--red); }

  /* ---- Layout ---- */
  main { max-width: 1000px; margin: 0 auto; padding: 24px; }
  section { margin-bottom: 24px; }

  /* ---- Stat cards ---- */
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
  .stat {
    background: var(--bg-soft); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 18px 20px; transition: box-shadow .2s;
  }
  .stat:hover { box-shadow: var(--shadow); }
  .stat .label { color: var(--text-soft); font-size: 12px; text-transform: uppercase;
                 letter-spacing: 0.06em; font-weight: 600; }
  .stat .value { font-size: 28px; font-weight: 700; margin-top: 6px; font-family: var(--mono);
                 font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }

  /* ---- Toolbar ---- */
  .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .toolbar h2 { font-size: 15px; margin: 0; font-weight: 600; }
  .toolbar .actions { display: flex; gap: 8px; }

  /* ---- Buttons ---- */
  button {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 7px 16px; border-radius: var(--radius-sm);
    font-size: 13px; font-weight: 600; font-family: var(--sans);
    border: 1px solid transparent; cursor: pointer; transition: all .15s;
    background: var(--accent); color: #fff;
  }
  button:hover { filter: brightness(1.1); }
  button.secondary { background: var(--bg-soft); border-color: var(--border); color: var(--text); }
  button.secondary:hover { background: var(--bg-code); filter: none; }
  button.ghost { background: transparent; color: var(--text-soft); padding: 7px 12px; }
  button.ghost:hover { background: var(--bg-code); color: var(--text); filter: none; }
  button.danger { background: transparent; color: var(--red); }
  button.danger:hover { background: var(--red-soft); filter: none; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }

  /* ---- Card wrapper (replaces the old raw table container) ---- */
  .card {
    background: var(--bg-soft); border: 1px solid var(--border);
    border-radius: var(--radius); overflow: hidden;
  }

  /* ---- Table: borderless, spacious, row-hover (linkseek style) ---- */
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  thead th {
    text-align: left; padding: 10px 16px; font-size: 12px; font-weight: 600;
    color: var(--text-soft); text-transform: uppercase; letter-spacing: 0.05em;
    background: var(--bg-code); border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  tbody td { padding: 14px 16px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr { transition: background .12s; }
  tbody tr:hover { background: color-mix(in srgb, var(--accent) 4%, transparent); }
  tbody tr:hover .row-actions { opacity: 1; }
  td.col-id { min-width: 120px; }
  td.col-match { min-width: 200px; }
  td.col-actions { text-align: right; white-space: nowrap; }

  /* ---- Inline code chips ---- */
  code {
    font-family: var(--mono); font-size: 12.5px;
    background: var(--bg-code); padding: 2px 7px; border-radius: 5px;
    color: var(--text); word-break: break-all;
  }
  code.accent { background: var(--accent-soft); color: var(--accent); }

  /* ---- Scope tags ---- */
  .scopes { display: flex; flex-wrap: wrap; gap: 4px; }
  .scope-tag {
    font-family: var(--mono); font-size: 11px; padding: 1px 7px; border-radius: 4px;
    background: var(--purple-soft); color: var(--purple); font-weight: 500;
  }

  /* ---- Toggle switch ---- */
  .toggle { position: relative; width: 38px; height: 22px; background: var(--border);
            border-radius: 999px; cursor: pointer; transition: background .2s; flex-shrink: 0; }
  .toggle.on { background: var(--green); }
  .toggle::after { content: ""; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px;
                   background: #fff; border-radius: 50%; transition: transform .2s;
                   box-shadow: 0 1px 3px rgba(0,0,0,0.2); }
  .toggle.on::after { transform: translateX(16px); }

  /* ---- Match count pill ---- */
  .match-count { font-family: var(--mono); font-size: 13px; font-weight: 600;
                 font-variant-numeric: tabular-nums; color: var(--text-soft); }
  .match-count.active { color: var(--yellow); }

  /* ---- Row actions: subtle until hover ---- */
  .row-actions { display: inline-flex; gap: 4px; opacity: 0.5; transition: opacity .15s; }

  /* ---- Empty state ---- */
  .empty { padding: 48px 24px; text-align: center; color: var(--text-muted); font-size: 14px; }

  /* ---- Hint text ---- */
  .hint { color: var(--text-soft); font-size: 13px; line-height: 1.7; }
  .hint code { font-size: 12px; }
  .rule-desc { color: var(--text-muted); font-size: 12px; margin-top: 4px; line-height: 1.4; }

  /* ---- Details / raw config ---- */
  details {
    background: var(--bg-soft); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 0; margin-top: 16px; overflow: hidden;
  }
  summary {
    cursor: pointer; font-size: 13px; font-weight: 600; color: var(--text-soft);
    padding: 14px 16px; user-select: none; transition: background .12s;
  }
  summary:hover { background: var(--bg-code); }
  details textarea {
    width: 100%; min-height: 220px; margin-top: 0; border: 0; border-top: 1px solid var(--border);
    background: var(--bg); color: var(--text); padding: 14px 16px;
    font-family: var(--mono); font-size: 12.5px; line-height: 1.6; resize: vertical; border-radius: 0;
  }
  details textarea:focus { outline: none; }

  /* ---- Toast ---- */
  .toast {
    position: fixed; bottom: 24px; right: 24px; z-index: 100;
    background: var(--bg-soft); border: 1px solid var(--border);
    padding: 12px 18px; border-radius: var(--radius-sm); box-shadow: var(--shadow);
    font-size: 13px; font-weight: 500; transform: translateY(100px); opacity: 0;
    transition: all .25s; pointer-events: none;
  }
  .toast.show { transform: translateY(0); opacity: 1; }
  .toast.error { border-color: var(--red); color: var(--red); }

  /* ---- Response fix row ---- */
  .fix-row { display: flex; gap: 14px; align-items: center; padding: 16px; }
  .fix-row .fix-title { font-weight: 600; font-size: 14px; }
  .fix-row .fix-title code { margin-left: 6px; font-size: 11.5px; }

  /* ---- Responsive ---- */
  @media (max-width: 720px) {
    .stats { grid-template-columns: repeat(2, 1fr); }
    main { padding: 16px; }
    .col-scopes, th.col-scopes { display: none; }
  }
</style>
</head>
<body>
<header>
  <span class="brand">${BRAND_SVG}</span>
  <h1>zcode-prompt-sanitizer</h1>
  <span class="badge" id="health">online</span>
  <span class="meta" id="meta">v${version}</span>
</header>
<main>
  <section class="stats" id="stats"></section>
  <section>
    <div class="toolbar">
      <h2>Response Fixes</h2>
    </div>
    <div class="card">
      <div class="fix-row">
        <div class="toggle" id="fixStrip"></div>
        <div>
          <div class="fix-title">Strip empty delta fields<code>stripEmptyDeltaFields</code></div>
          <div class="rule-desc">移除 SSE chunk 中的空占位字段（<code>content:""</code> / <code>reasoning_content:""</code> / <code>tool_calls:[]</code> / 空 <code>function_call</code> / 空 <code>finish_reason</code>）。修复腾讯系模型（hy 系列）在 ZCode 里一个思考阶段被拆成几十段"思考"的问题——元凶是每个 chunk 都带的 <code>tool_calls:[]</code> 会让客户端反复关闭思考块。即时生效并写入配置文件，默认关闭。</div>
        </div>
      </div>
    </div>
  </section>
  <section>
    <div class="toolbar">
      <h2>Rewrite Rules <span style="color:var(--text-muted);font-weight:400">(<span id="ruleCount">0</span>)</span></h2>
      <div class="actions">
        <button class="ghost" id="refresh">↻ Refresh</button>
        <button id="newRule">+ New rule</button>
      </div>
    </div>
    <div class="card">
      <table>
        <thead><tr>
          <th style="width:54px">Enabled</th>
          <th class="col-id">Rule</th>
          <th class="col-match">Match → Replacement</th>
          <th class="col-scopes">Scopes</th>
          <th style="width:80px;text-align:center">Matches</th>
          <th class="col-actions" style="width:120px"></th>
        </tr></thead>
        <tbody id="rulesBody"></tbody>
      </table>
    </div>
    <details>
      <summary>Raw config JSON</summary>
      <textarea id="rawConfig" readonly spellcheck="false"></textarea>
    </details>
    <p class="hint" style="margin-top:20px">
      将 ZCode 的 API 地址指向 <code class="accent" id="baseUrl"></code>，代理会自动改写请求中的敏感词并转发到上游。
      在配置文件中编辑 <code>upstreams</code> 来映射不同的供应商。
    </p>
  </section>
</main>
<div class="toast" id="toast"></div>

<script>
const $ = (id) => document.getElementById(id);
const api = '/__zps__/api';
let rules = [];

function toast(msg, isError) {
  const t = $('toast'); t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => t.className = 'toast', 2500);
}
async function jget(p) { const r = await fetch(api + p); if (!r.ok) throw new Error((await r.json()).error?.message || r.status); return r.json(); }
async function jsend(method, p, body) {
  const r = await fetch(api + p, { method, headers: {'content-type':'application/json'}, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error((await r.json()).error?.message || r.status);
  return r.json();
}
function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }
function fmtUptime(ms) {
  const s = Math.floor(ms/1000); const h = Math.floor(s/3600); const m = Math.floor((s%3600)/60); const sec = s%60;
  return h ? h+'h '+m+'m' : m ? m+'m '+sec+'s' : sec+'s';
}
async function loadStatus() {
  const s = await jget('/status');
  $('stats').innerHTML = [
    stat('Version', s.version),
    stat('Uptime', fmtUptime(s.uptimeMs)),
    stat('Rules enabled', s.rules.enabled + ' / ' + s.rules.total),
    stat('Total matches', Object.values(s.stats||{}).reduce((a,b)=>a+(b.matches||0),0)),
  ].join('');
  $('baseUrl').textContent = 'http://127.0.0.1:' + s.proxy.port;
}
function stat(label, value) { return '<div class="stat"><div class="label">'+label+'</div><div class="value">'+esc(value)+'</div></div>'; }

async function loadRules() {
  const data = await jget('/rules');
  rules = data.rules || [];
  $('ruleCount').textContent = rules.length;
  $('rawConfig').value = JSON.stringify(rules, null, 2);
  if (!rules.length) { $('rulesBody').innerHTML = '<tr><td colspan="6" class="empty">No rules yet. Click "+ New rule" to add one.</td></tr>'; return; }
  $('rulesBody').innerHTML = rules.map((r) => ruleRow(r)).join('');
}
function ruleRow(r) {
  const stats = window.__stats?.[r.id] || {};
  const matches = stats.matches || 0;
  return '<tr>' +
    '<td><div class="toggle '+(r.enabled?'on':'')+'" data-toggle="'+r.id+'"></div></td>' +
    '<td class="col-id"><code class="accent">'+esc(r.id)+'</code>'+(r.description?'<div class="rule-desc">'+esc(r.description)+'</div>':'')+'</td>' +
    '<td class="col-match"><code>'+esc(r.match)+'</code> <span style="color:var(--text-muted)">→</span> <code>'+esc(r.replacement||'(delete)')+'</code></td>' +
    '<td class="col-scopes"><div class="scopes">'+(r.scopes||[]).map(s=>'<span class="scope-tag">'+esc(s)+'</span>').join('')+'</div></td>' +
    '<td style="text-align:center"><span class="match-count'+(matches>0?' active':'')+'">'+matches+'</span></td>' +
    '<td class="col-actions"><div class="row-actions"><button class="ghost" data-edit="'+r.id+'">Edit</button><button class="danger" data-del="'+r.id+'">Delete</button></div></td>' +
    '</tr>';
}
async function loadSettings() {
  const s = await jget('/settings');
  const on = !!(s.responseFixes && s.responseFixes.stripEmptyDeltaFields);
  $('fixStrip').className = 'toggle' + (on ? ' on' : '');
}
async function refresh() {
  const s = await jget('/status');
  window.__stats = s.stats || {};
  await loadRules();
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, .toggle');
  if (!t) return;
  if (t.id === 'fixStrip') {
    const on = !t.classList.contains('on');
    try {
      await jsend('POST', '/settings', { responseFixes: { stripEmptyDeltaFields: on } });
      await loadSettings();
      toast(on ? 'Fix enabled' : 'Fix disabled');
    } catch(err) { toast(err.message, true); }
    return;
  }
  const toggleId = t.getAttribute('data-toggle');
  if (toggleId) {
    const rule = rules.find(r => r.id === toggleId);
    try { await jsend('POST', '/rule/'+encodeURIComponent(toggleId), { enabled: !rule.enabled }); await refresh(); }
    catch(err) { toast(err.message, true); }
    return;
  }
  const delId = t.getAttribute('data-del');
  if (delId) {
    if (!confirm('Delete rule "'+delId+'"?')) return;
    try { await jsend('DELETE', '/rule/'+encodeURIComponent(delId)); await refresh(); toast('Deleted'); }
    catch(err) { toast(err.message, true); }
    return;
  }
  const editId = t.getAttribute('data-edit');
  if (editId) { editRule(rules.find(r=>r.id===editId)); return; }
  if (t.id === 'refresh') { await refresh(); toast('Refreshed'); return; }
  if (t.id === 'newRule') { editRule(null); return; }
});

function editRule(rule) {
  const isNew = !rule;
  const r = rule || { id:'', description:'', enabled:true, scopes:['system'], match:'', replacement:'' };
  const id = prompt('Rule id (unique):', r.id); if (id === null) return;
  const match = prompt('Substring to match:', r.match); if (match === null) return;
  const replacement = prompt('Replacement (empty = delete match):', r.replacement); if (replacement === null) return;
  const scopes = prompt('Scopes (comma-sep: system,user,assistant,tool):', (r.scopes||[]).join(',')) || 'system';
  const description = prompt('Description (optional):', r.description || '');
  const payload = { id, match, replacement, scopes: scopes.split(',').map(s=>s.trim()).filter(Boolean), description, enabled: r.enabled };
  (async () => {
    try {
      if (isNew) { await jsend('POST', '/rules', payload); }
      else { await jsend('POST', '/rule/'+encodeURIComponent(r.id), payload); }
      await refresh(); toast('Saved');
    } catch(err) { toast(err.message, true); }
  })();
}

(async () => {
  try { await loadStatus(); await loadSettings(); await refresh(); setInterval(loadStatus, 5000); }
  catch(e) { $('health').classList.add('offline'); $('health').textContent = 'offline'; toast(e.message, true); }
})();
</script>
</body>
</html>`;
}
