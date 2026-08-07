/**
 * Dashboard HTML — a single self-contained page with vanilla JS (no build step,
 * no external CDN) so the proxy works fully offline. Embedded as a TS string to
 * avoid shipping extra static-file-handling machinery.
 */
export function dashboardHtml(version: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>zcode-prompt-sanitizer</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --border: #30363d; --text: #c9d1d9;
    --muted: #8b949e; --accent: #2f81f7; --green: #3fb950; --red: #f85149;
    --yellow: #d29922; --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: var(--bg); color: var(--text); line-height: 1.5; }
  header { padding: 16px 24px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 16px; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header .meta { color: var(--muted); font-size: 13px; font-family: var(--mono); }
  header .badge { background: var(--green); color: #000; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  main { max-width: 1100px; margin: 0 auto; padding: 24px; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .stat { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px; }
  .stat .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat .value { font-size: 24px; font-weight: 600; margin-top: 4px; font-family: var(--mono); }
  .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .toolbar h2 { font-size: 14px; margin: 0; }
  button { background: var(--accent); color: #fff; border: 0; border-radius: 6px; padding: 6px 14px;
           font-size: 13px; cursor: pointer; font-weight: 500; }
  button.secondary { background: var(--panel); border: 1px solid var(--border); color: var(--text); }
  button.danger { background: var(--red); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border);
          border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: top; }
  th { background: #1c2128; color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.4px; }
  tr:last-child td { border-bottom: 0; }
  code { font-family: var(--mono); font-size: 12px; background: #1c2128; padding: 1px 5px; border-radius: 4px; word-break: break-all; }
  .toggle { position: relative; width: 36px; height: 20px; background: var(--border); border-radius: 10px; cursor: pointer; transition: background .15s; }
  .toggle.on { background: var(--green); }
  .toggle::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; background: #fff; border-radius: 50%; transition: transform .15s; }
  .toggle.on::after { transform: translateX(16px); }
  .match-count { color: var(--yellow); font-family: var(--mono); font-size: 12px; }
  .empty { padding: 40px; text-align: center; color: var(--muted); }
  details { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-top: 16px; }
  summary { cursor: pointer; font-size: 13px; color: var(--muted); }
  details textarea { width: 100%; min-height: 200px; margin-top: 12px; background: #0d1117; color: var(--text);
                     border: 1px solid var(--border); border-radius: 6px; padding: 10px; font-family: var(--mono); font-size: 12px; resize: vertical; }
  .toast { position: fixed; bottom: 24px; right: 24px; background: var(--panel); border: 1px solid var(--border);
           padding: 12px 16px; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.4); display: none; }
  .toast.show { display: block; }
  .toast.error { border-color: var(--red); }
  .hint { color: var(--muted); font-size: 12px; margin-top: 8px; }
</style>
</head>
<body>
<header>
  <h1>🛡 zcode-prompt-sanitizer</h1>
  <span class="badge" id="health">online</span>
  <span class="meta" id="meta">v${version}</span>
</header>
<main>
  <div class="stats" id="stats"></div>
  <div class="toolbar">
    <h2>Rewrite Rules (<span id="ruleCount">0</span>)</h2>
    <div>
      <button class="secondary" id="refresh">Refresh</button>
      <button id="newRule">+ New rule</button>
    </div>
  </div>
  <table>
    <thead><tr>
      <th style="width:48px">On</th><th>ID</th><th>Match → Replacement</th>
      <th>Scopes</th><th style="width:90px">Matches</th><th style="width:120px"></th>
    </tr></thead>
    <tbody id="rulesBody"></tbody>
  </table>
  <details>
    <summary>Raw config JSON (read-only view of the active ruleset)</summary>
    <textarea id="rawConfig" readonly></textarea>
  </details>
  <p class="hint">Point ZCode at <code id="baseUrl"></code> — the proxy forwards sanitized requests to your configured upstream. Edit <code>upstreams</code> in the config file to map providers.</p>
</main>
<div class="toast" id="toast"></div>

<script>
const $ = (id) => document.getElementById(id);
const api = '/__zps__/api';
let rules = [];

function toast(msg, isError) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast show' + (isError ? ' error' : '');
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
    stat('Rules enabled', s.rules.enabled + '/' + s.rules.total),
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
  if (!rules.length) { $('rulesBody').innerHTML = '<tr><td colspan="6" class="empty">No rules. Click "+ New rule" to add one.</td></tr>'; return; }
  $('rulesBody').innerHTML = rules.map((r) => ruleRow(r)).join('');
}
function ruleRow(r) {
  const stats = window.__stats?.[r.id] || {};
  return '<tr>' +
    '<td><div class="toggle '+(r.enabled?'on':'')+'" data-toggle="'+r.id+'"></div></td>' +
    '<td><code>'+esc(r.id)+'</code>'+(r.description?'<div class="hint">'+esc(r.description)+'</div>':'')+'</td>' +
    '<td><code>'+esc(r.match)+'</code> → <code>'+esc(r.replacement||'(delete)')+'</code></td>' +
    '<td>'+(r.scopes||[]).map(s=>'<code>'+esc(s)+'</code>').join(' ')+'</td>' +
    '<td><span class="match-count">'+(stats.matches||0)+'</span></td>' +
    '<td><button class="secondary" data-edit="'+r.id+'">Edit</button> <button class="danger" data-del="'+r.id+'">Del</button></td>' +
    '</tr>';
}
async function refresh() {
  const s = await jget('/status');
  window.__stats = s.stats || {};
  await loadRules();
}

document.addEventListener('click', async (e) => {
  const t = e.target;
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
  try { await loadStatus(); await refresh(); setInterval(loadStatus, 5000); }
  catch(e) { $('health').style.background = 'var(--red)'; $('health').textContent = 'offline'; toast(e.message, true); }
})();
</script>
</body>
</html>`;
}
