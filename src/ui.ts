/**
 * Server-rendered HTML pages. Every page is a single self-contained document so the
 * service keeps running as one Node.js process without a bundler or a static assets folder.
 *
 * Client scripts are plain strings (no template-literal interpolation) so they can be
 * audited easily and so no server-side value is ever interpolated into executable code.
 */

export const escapeHtml = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );

const css = `
:root{--bg:#f4f6f8;--panel:#fff;--border:#dbe1e8;--text:#15202b;--muted:#5f6b7a;--up:#15803d;--up-bg:#dcfce7;--down:#b91c1c;--down-bg:#fee2e2;--warn:#b45309;--warn-bg:#fef3c7;--info:#1d4ed8;--info-bg:#dbeafe;--accent:#2563eb}
@media(prefers-color-scheme:dark){:root{--bg:#0f141a;--panel:#171e26;--border:#2a3441;--text:#e6ebf0;--muted:#94a3b8;--up:#4ade80;--up-bg:#14532d;--down:#fca5a5;--down-bg:#7f1d1d;--warn:#fcd34d;--warn-bg:#78350f;--info:#93c5fd;--info-bg:#1e3a8a;--accent:#3b82f6}}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:1180px;margin:auto;padding:20px 16px;background:var(--bg);color:var(--text);line-height:1.45}
h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.1rem;margin:0 0 12px}h3{font-size:1rem;margin:12px 0 6px}
a{color:var(--accent)}
nav{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:8px 0 16px;color:var(--muted)}
.panel,.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px;margin:12px 0}
.cards{display:grid;gap:12px}
.row{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}
.muted{color:var(--muted);font-size:13px}
.badge{display:inline-block;background:var(--up-bg);color:var(--up);border-radius:20px;padding:4px 10px;font-size:12px;font-weight:600;white-space:nowrap}
.badge.down{background:var(--down-bg);color:var(--down)}
.badge.warn{background:var(--warn-bg);color:var(--warn)}
.badge.info{background:var(--info-bg);color:var(--info)}
.actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}
button{padding:7px 11px;border:1px solid var(--border);border-radius:6px;background:var(--panel);color:var(--text);cursor:pointer;font:inherit;font-size:13px}
button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
button.danger{color:var(--down)}
button:disabled{opacity:.5;cursor:default}
input,select,textarea{width:100%;padding:8px;margin-top:4px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font:inherit;font-size:13px}
textarea{min-height:60px;font-family:ui-monospace,monospace}
label{display:block;font-size:13px}
form.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.wide{grid-column:span 2}.full{grid-column:1/-1}
@media(max-width:700px){form.grid{grid-template-columns:1fr}.wide,.full{grid-column:auto}}
.stats{display:flex;gap:16px;flex-wrap:wrap;margin:8px 0}
.stats div{font-size:12px;color:var(--muted)}
.stats strong{display:block;font-size:15px;color:var(--text)}
.summary{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0}
.summary span{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:6px 12px;font-size:13px}
svg.spark{width:100%;max-width:360px;height:36px;display:block}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--border);vertical-align:top}
pre,code{font-family:ui-monospace,monospace;font-size:12px}
pre{background:var(--bg);padding:10px;border-radius:6px;overflow:auto;white-space:pre-wrap;word-break:break-all}
.msg{min-height:20px;margin:8px 0 0}
.msg.error{color:var(--down)}
.incident{font-size:13px;padding:4px 0;border-top:1px solid var(--border)}
details summary{cursor:pointer;font-size:13px;color:var(--muted)}
.group-title{margin:18px 0 4px;font-size:.95rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.hidden{display:none !important}
.announcement{border-left:4px solid var(--info)}.announcement.warn{border-left-color:var(--warn)}.announcement.down{border-left-color:var(--down)}
`;

function page(title: string, body: string, script = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${css}</style></head><body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;
}

/* Client-side helpers shared by every admin page. Kept free of backticks and "${". */
const clientHelpers = `
var $ = function (id) { return document.getElementById(id); };
var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
var csrf = function () { var m = document.cookie.match(/(?:^|; )csrf=([^;]+)/); return m ? m[1] : ''; };
var api = function (url, method, body) {
  return fetch(url, { method: method || 'GET', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf() }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(function (r) { if (r.status === 401) { location = '/login'; throw new Error('Authentication required'); } return r; });
};
var showMessage = function (id, text, isError) { var el = $(id); el.textContent = text; el.className = 'msg' + (isError ? ' error' : ''); };
var when = function (ts) { return ts ? new Date(ts).toLocaleString() : 'never'; };
var ago = function (ts) { if (!ts) return 'never'; var s = Math.round((Date.now() - ts) / 1000); if (s < 60) return s + 's ago'; if (s < 3600) return Math.round(s / 60) + 'm ago'; if (s < 86400) return Math.round(s / 3600) + 'h ago'; return Math.round(s / 86400) + 'd ago'; };
var duration = function (ms) { if (ms == null) return 'ongoing'; var m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24); return d ? d + 'd ' + (h % 24) + 'h' : h ? h + 'h ' + (m % 60) + 'm' : m + 'm'; };
var sparkline = function (history) {
  if (!history || !history.length) return '';
  var max = Math.max.apply(null, history.map(function (h) { return h.latency; }).concat([1]));
  var w = 360, h = 36, step = w / Math.max(history.length, 1);
  var bars = history.map(function (p, i) {
    var height = Math.max(2, Math.round((p.latency / max) * (h - 4)));
    var color = p.status === 'DOWN' ? 'var(--down)' : p.slow ? 'var(--warn)' : 'var(--up)';
    return '<rect x="' + (i * step + 1).toFixed(1) + '" y="' + (h - height) + '" width="' + Math.max(1, step - 2).toFixed(1) + '" height="' + height + '" rx="1" fill="' + color + '"><title>' + esc(new Date(p.timestamp).toLocaleString()) + ' · ' + p.status + ' · ' + p.latency + ' ms</title></rect>';
  }).join('');
  return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-label="Latency history">' + bars + '</svg>';
};
`;

function announcementBanner(a: any) {
  const cls = a.kind === 'incident' ? 'down' : a.kind === 'maintenance' ? 'warn' : 'info';
  const window = `${new Date(a.startsAt).toLocaleString()}${a.endsAt ? ` to ${new Date(a.endsAt).toLocaleString()}` : ''}`;
  return `<section class="card announcement ${cls}"><div class="row"><strong>${escapeHtml(a.title)}</strong><span class="badge ${cls}">${escapeHtml(a.kind)}</span></div>${a.body ? `<p style="white-space:pre-wrap;margin:6px 0 0">${escapeHtml(a.body)}</p>` : ''}<p class="muted">${escapeHtml(window)}</p></section>`;
}

export function publicPage(data: any[], announcements: any[] = []) {
  const down = data.filter((m) => m.state === 'DOWN' && !m.maintenance);
  const headline =
    data.length === 0
      ? 'No monitors configured'
      : down.length
        ? `${down.length} ${down.length === 1 ? 'system is' : 'systems are'} down`
        : 'All systems operational';
  const groups = new Map<string, any[]>();
  for (const m of data) {
    const key = m.group || '';
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  const card = (m: any) => {
    const badge = m.maintenance ? 'warn' : m.state === 'DOWN' ? 'down' : '';
    const label = m.maintenance ? 'MAINTENANCE' : m.state;
    const bars = (m.history as any[])
      .map((p) => {
        const color = p.status === 'DOWN' ? 'var(--down)' : p.slow ? 'var(--warn)' : 'var(--up)';
        return `<span style="display:inline-block;width:8px;height:14px;margin-right:2px;border-radius:2px;background:${color}" title="${escapeHtml(new Date(p.timestamp).toLocaleString())} · ${escapeHtml(p.status)}"></span>`;
      })
      .join('');
    const openIncident = (m.incidents as any[]).find((i) => !i.recoveredAt);
    return `<article class="card"><div class="row"><div><strong>${escapeHtml(m.name)}</strong><div class="muted">${escapeHtml(m.type)}</div></div><span class="badge ${badge}">${escapeHtml(label)}</span></div><div class="stats"><div>24h<strong>${m.uptime24h.toFixed(2)}%</strong></div><div>7d<strong>${m.uptime7d.toFixed(2)}%</strong></div><div>30d<strong>${m.uptime30d.toFixed(2)}%</strong></div><div>Latency<strong>${m.latestLatency == null ? 'n/a' : `${m.latestLatency} ms`}</strong></div></div><div>${bars}</div>${openIncident ? `<p class="muted">Incident since ${escapeHtml(new Date(openIncident.startedAt).toLocaleString())}</p>` : ''}</article>`;
  };
  const sections = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([name, items]) =>
        `${name ? `<h2 class="group-title">${escapeHtml(name)}</h2>` : ''}<div class="cards">${items.map(card).join('')}</div>`
    )
    .join('');
  return page(
    'Status',
    `<h1>${escapeHtml(headline)}</h1><p class="muted">Updated ${escapeHtml(new Date().toLocaleString())} · refreshes automatically</p>${announcements.map(announcementBanner).join('')}${sections}<p class="muted">Powered by a self-hosted uptime monitor.</p>`,
    'setTimeout(function(){location.reload()},60000)'
  );
}

export function loginPage() {
  return page(
    'Sign in',
    `<section class="panel" style="max-width:420px;margin:40px auto"><h1>Admin sign in</h1><form id="f"><label>Username<input id="u" autocomplete="username" required></label><label>Password<input id="p" type="password" autocomplete="current-password" required></label><label>Authenticator or recovery code<input id="t" autocomplete="one-time-code" placeholder="Leave empty if TOTP is not enabled"></label><p><button class="primary">Sign in</button></p></form><p id="m" class="msg"></p></section>`,
    `document.getElementById('f').onsubmit = async function (e) {
  e.preventDefault();
  var auth = 'Basic ' + btoa(document.getElementById('u').value + ':' + document.getElementById('p').value);
  var r = await fetch('/api/auth/login', { method: 'POST', headers: { Authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ code: document.getElementById('t').value }) });
  if (r.ok) { location = '/dashboard'; return; }
  var data = await r.json().catch(function () { return {}; });
  var m = document.getElementById('m'); m.textContent = data.error || 'Sign-in failed'; m.className = 'msg error';
};`
  );
}

const navigation = (active: string) =>
  `<nav>${[
    ['/dashboard', 'Monitors'],
    ['/dashboard/notifications', 'Notifications'],
    ['/dashboard/security', 'Security'],
    ['/status', 'Public status'],
  ]
    .map(([href, label]) =>
      href === active ? `<strong>${label}</strong>` : `<a href="${href}">${label}</a>`
    )
    .join(
      ' · '
    )} · <a href="/api/admin/export">Export JSON</a> · <a href="/api/admin/export.csv">Export CSV</a> · <button id="logout">Log out</button></nav>`;

const logoutScript = `$('logout').onclick = function () { api('/api/auth/logout', 'POST').then(function () { location = '/login'; }); };`;

const monitorForm = `<form id="monitor-form" class="grid" autocomplete="off">
<input type="hidden" id="monitor-id">
<label>Name<input id="name" required></label>
<label>Type<select id="type">
<option value="http">HTTP / HTTPS</option><option value="ssl">SSL certificate</option><option value="tcp">TCP port</option><option value="udp">UDP request</option><option value="dns">DNS</option><option value="ping">Ping</option><option value="websocket">WebSocket</option><option value="heartbeat">Heartbeat / Cron</option><option value="domain">Domain expiration</option>
</select></label>
<label>Group<input id="group" placeholder="Optional"></label>
<label class="full" data-types="http ssl tcp udp dns ping websocket domain">URL / Host<input id="url" placeholder="https://example.com" required><span class="muted" id="url-help"></span></label>
<label data-types="http ssl tcp udp dns ping websocket domain">Interval (seconds)<input id="interval" type="number" min="5" value="60"></label>
<label data-types="http ssl tcp udp dns ping websocket domain">Timeout (ms)<input id="timeout" type="number" min="100" value="10000"></label>
<label data-types="http ssl">Expected status<input id="expectedStatus" type="number" min="100" max="599" value="200"></label>
<label data-types="http ssl">Method<select id="method"><option>GET</option><option>HEAD</option><option>POST</option><option>PUT</option><option>PATCH</option></select></label>
<label data-types="http ssl">Keyword (optional)<input id="keyword"></label>
<label data-types="http ssl tcp udp dns ping websocket">Max latency ms (optional)<input id="maxLatency" type="number" min="1"></label>
<label class="full" data-types="http ssl">Request headers (JSON object, optional)<textarea id="headers" placeholder='{"Authorization":"Bearer ..."}'></textarea></label>
<label class="full" data-types="http ssl">Request body (optional)<textarea id="body"></textarea></label>
<label data-types="http ssl">JSON path (optional)<input id="jsonPath" placeholder="data.status"></label>
<label data-types="http ssl">Expected JSON value<input id="jsonExpected" placeholder="ok"></label>
<label data-types="heartbeat">Expected interval (seconds)<input id="expectedInterval" type="number" min="1" value="60"></label>
<label data-types="heartbeat">Grace period (seconds)<input id="gracePeriod" type="number" min="0" value="60"></label>
<label data-types="domain">Warn before expiration<select id="warningThreshold"><option value="30">30 days</option><option value="14">14 days</option><option value="7">7 days</option></select></label>
<label data-types="udp">UDP payload (optional)<input id="udpPayload"></label>
<label data-types="udp">Expected UDP response (optional)<input id="udpExpectedResponse"></label>
<label>Failure threshold<input id="failureThreshold" type="number" min="1" value="2"></label>
<label>Repeat alert every N minutes (0 = off)<input id="repeatNotificationMinutes" type="number" min="0" value="0"></label>
<label>Notifications<select id="notificationsEnabled"><option value="true">Enabled</option><option value="false">Disabled</option></select></label>
<label>Recovery notifications<select id="recoveryNotifications"><option value="true">Enabled</option><option value="false">Disabled</option></select></label>
<div class="full actions"><button class="primary" id="save">Save monitor</button><button type="button" id="cancel" class="hidden">Cancel edit</button></div>
</form><p id="monitor-message" class="msg"></p>`;

const dashboardScript = `
${clientHelpers}
var monitors = [];
var editing = null;
var fields = ['name','type','group','url','interval','timeout','expectedStatus','method','keyword','maxLatency','headers','body','jsonPath','jsonExpected','expectedInterval','gracePeriod','warningThreshold','udpPayload','udpExpectedResponse','failureThreshold','repeatNotificationMinutes','notificationsEnabled','recoveryNotifications'];
var urlHelp = { http: 'https://example.com/health', ssl: 'https://example.com', tcp: 'tcp://db.example.com:5432', udp: 'udp://example.com:53', dns: 'dns://example.com', ping: 'ping://example.com', websocket: 'wss://example.com/socket', domain: 'example.com', heartbeat: 'A private URL is generated after saving' };

function applyType() {
  var type = $('type').value;
  document.querySelectorAll('[data-types]').forEach(function (el) {
    el.classList.toggle('hidden', el.getAttribute('data-types').split(' ').indexOf(type) < 0);
  });
  $('url').required = type !== 'heartbeat';
  $('url-help').textContent = 'Example: ' + urlHelp[type];
}
$('type').onchange = applyType;

function numberOrUndefined(id) { var v = $(id).value; return v === '' ? undefined : Number(v); }
function textOrUndefined(id) { var v = $(id).value.trim(); return v === '' ? undefined : v; }

function formData() {
  var type = $('type').value;
  var data = {
    name: $('name').value, type: type, group: textOrUndefined('group'),
    url: type === 'heartbeat' ? 'heartbeat://pending' : $('url').value.trim(),
    interval: Number($('interval').value) || 60, timeout: Number($('timeout').value) || 10000,
    expectedStatus: Number($('expectedStatus').value) || 200, method: $('method').value,
    keyword: textOrUndefined('keyword'), maxLatency: numberOrUndefined('maxLatency'),
    body: textOrUndefined('body'), jsonPath: textOrUndefined('jsonPath'), jsonExpected: textOrUndefined('jsonExpected'),
    expectedInterval: numberOrUndefined('expectedInterval'), gracePeriod: numberOrUndefined('gracePeriod'),
    warningThreshold: Number($('warningThreshold').value),
    udpPayload: textOrUndefined('udpPayload'), udpExpectedResponse: textOrUndefined('udpExpectedResponse'),
    failureThreshold: Number($('failureThreshold').value) || 2,
    repeatNotificationMinutes: Number($('repeatNotificationMinutes').value) || 0,
    notificationsEnabled: $('notificationsEnabled').value === 'true',
    recoveryNotifications: $('recoveryNotifications').value === 'true'
  };
  var headers = $('headers').value.trim();
  if (headers) { try { data.headers = JSON.parse(headers); } catch (e) { throw new Error('Request headers must be a JSON object'); } }
  return data;
}

function fillForm(m) {
  editing = m ? m.id : null;
  $('monitor-id').value = m ? m.id : '';
  fields.forEach(function (key) {
    var el = $(key);
    var value = m ? m[key] : undefined;
    if (key === 'headers') el.value = value ? JSON.stringify(value) : '';
    else if (typeof value === 'boolean') el.value = String(value);
    else if (value == null) el.value = el.defaultValue || '';
    else el.value = value;
  });
  if (m && m.type === 'heartbeat') $('url').value = '';
  $('save').textContent = m ? 'Update monitor' : 'Save monitor';
  $('cancel').classList.toggle('hidden', !m);
  $('form-title').textContent = m ? 'Edit "' + m.name + '"' : 'Add monitor';
  applyType();
  if (m) window.scrollTo({ top: 0, behavior: 'smooth' });
}

$('cancel').onclick = function () { fillForm(null); showMessage('monitor-message', ''); };
$('monitor-form').onsubmit = async function (e) {
  e.preventDefault();
  var data;
  try { data = formData(); } catch (err) { showMessage('monitor-message', err.message, true); return; }
  var r = await api('/api/admin/monitors' + (editing ? '/' + editing : ''), editing ? 'PUT' : 'POST', data);
  if (r.ok) { showMessage('monitor-message', editing ? 'Monitor updated' : 'Monitor created'); fillForm(null); load(); }
  else showMessage('monitor-message', await r.text(), true);
};

function statusBadge(m) {
  if (!m.active) return '<span class="badge info">PAUSED</span>';
  if (m.maintenance) return '<span class="badge warn">MAINTENANCE</span>';
  return '<span class="badge ' + (m.state === 'DOWN' ? 'down' : '') + '">' + m.state + '</span>';
}

function details(m) {
  var parts = [];
  if (m.type === 'heartbeat') {
    parts.push('<p class="muted">Last heartbeat: ' + esc(ago(m.lastHeartbeatAt)) + ' · expected every ' + m.expectedInterval + 's (+' + m.gracePeriod + 's grace)</p>');
    if (m.heartbeatUrl) parts.push('<p class="muted">Ping URL (keep private): <code id="hb-' + m.id + '">' + esc(m.heartbeatUrl) + '</code> <button data-copy="' + esc(m.heartbeatUrl) + '">Copy</button></p>');
  }
  if (m.type === 'domain') {
    parts.push('<p class="muted">Domain expires: ' + (m.domainExpirationDate ? esc(new Date(m.domainExpirationDate).toLocaleDateString()) + ' (' + m.domainDaysRemaining + ' days)' : 'unknown yet') + ' · warning at ' + m.warningThreshold + ' days</p>');
  }
  if (m.sslExpiresAt != null) {
    var sslClass = m.sslValid ? (m.sslDaysRemaining <= 30 ? 'warn' : '') : 'down';
    parts.push('<p class="muted">Certificate: <span class="badge ' + sslClass + '">' + (m.sslValid ? 'valid' : 'invalid') + '</span> expires ' + esc(new Date(m.sslExpiresAt).toLocaleDateString()) + ' (' + m.sslDaysRemaining + ' days)</p>');
  }
  var last = m.history && m.history.length ? m.history[m.history.length - 1] : null;
  if (last && last.error) parts.push('<p class="muted">Last error: ' + esc(last.error) + '</p>');
  if (m.consecutiveFailures) parts.push('<p class="muted">Consecutive failures: ' + m.consecutiveFailures + ' / ' + m.failureThreshold + '</p>');
  var incidents = (m.incidents || []).slice(0, 3).map(function (i) {
    return '<div class="incident">' + esc(when(i.startedAt)) + ' · ' + esc(duration(i.recoveredAt ? i.duration : null)) + (i.error ? ' · ' + esc(i.error) : '') + '</div>';
  }).join('');
  if (incidents) parts.push('<details><summary>Recent incidents (' + m.incidents.length + ')</summary>' + incidents + '</details>');
  return parts.join('');
}

function card(m) {
  return '<article class="card" data-id="' + esc(m.id) + '">' +
    '<div class="row"><div><strong>' + esc(m.name) + '</strong><div class="muted">' + esc(m.type === 'heartbeat' ? 'heartbeat' : m.url) + ' · ' + esc(m.type) + (m.group ? ' · ' + esc(m.group) : '') + '</div></div>' + statusBadge(m) + '</div>' +
    '<div class="stats"><div>24h<strong>' + m.uptime24h.toFixed(2) + '%</strong></div><div>7d<strong>' + m.uptime7d.toFixed(2) + '%</strong></div><div>30d<strong>' + m.uptime30d.toFixed(2) + '%</strong></div><div>Latency<strong>' + (m.latestLatency == null ? 'n/a' : m.latestLatency + ' ms' + (m.latestSlow ? ' (slow)' : '')) + '</strong></div><div>Last check<strong>' + esc(ago(m.lastChecked)) + '</strong></div></div>' +
    sparkline(m.history) + details(m) +
    '<div class="actions">' +
    '<button data-action="test">Test now</button>' +
    '<button data-action="edit">Edit</button>' +
    '<button data-action="active" data-value="' + (!m.active) + '">' + (m.active ? 'Pause' : 'Resume') + '</button>' +
    '<button data-action="maintenance" data-value="' + (!m.maintenance) + '">' + (m.maintenance ? 'End maintenance' : 'Maintenance') + '</button>' +
    '<button data-action="delete" class="danger">Delete</button>' +
    '</div><p class="msg" data-msg></p></article>';
}

function render() {
  var up = 0, down = 0, maintenance = 0, paused = 0;
  monitors.forEach(function (m) { if (!m.active) paused++; else if (m.maintenance) maintenance++; else if (m.state === 'DOWN') down++; else up++; });
  $('summary').innerHTML = '<span>Total ' + monitors.length + '</span><span>Up ' + up + '</span><span>Down ' + down + '</span><span>Maintenance ' + maintenance + '</span><span>Paused ' + paused + '</span>';
  var groups = {};
  monitors.forEach(function (m) { var g = m.group || ''; (groups[g] = groups[g] || []).push(m); });
  var names = Object.keys(groups).sort();
  $('monitors').innerHTML = names.map(function (g) {
    return (g ? '<h2 class="group-title">' + esc(g) + '</h2>' : '') + '<div class="cards">' + groups[g].map(card).join('') + '</div>';
  }).join('') || '<div class="card">No monitors yet. Add the first one above.</div>';
}

async function load() {
  try {
    var r = await api('/api/admin/monitors');
    monitors = await r.json();
    render();
  } catch (err) { showMessage('monitor-message', 'Could not load monitors: ' + err.message, true); }
}

$('monitors').onclick = async function (e) {
  var copy = e.target.closest('[data-copy]');
  if (copy) { navigator.clipboard.writeText(copy.getAttribute('data-copy')).then(function () { copy.textContent = 'Copied'; }); return; }
  var button = e.target.closest('[data-action]');
  if (!button) return;
  var article = button.closest('[data-id]');
  var id = article.getAttribute('data-id');
  var m = monitors.find(function (x) { return x.id === id; });
  var action = button.getAttribute('data-action');
  var msg = article.querySelector('[data-msg]');
  button.disabled = true;
  try {
    if (action === 'edit') { fillForm(m); }
    else if (action === 'test') {
      var result = await (await api('/api/admin/monitors/' + id + '/test', 'POST')).json();
      msg.textContent = 'Test result: ' + result.status + ' in ' + result.latency + ' ms' + (result.error ? ' · ' + result.error : '');
      msg.className = 'msg' + (result.status === 'DOWN' ? ' error' : '');
      load();
    }
    else if (action === 'active') { await api('/api/admin/monitors/' + id + '/active', 'POST', { active: button.getAttribute('data-value') === 'true' }); load(); }
    else if (action === 'maintenance') { await api('/api/admin/monitors/' + id + '/maintenance', 'POST', { maintenance: button.getAttribute('data-value') === 'true' }); load(); }
    else if (action === 'delete') {
      if (!confirm('Delete "' + m.name + '" and all of its history?')) return;
      await api('/api/admin/monitors/' + id, 'DELETE');
      if (editing === id) fillForm(null);
      load();
    }
  } catch (err) { msg.textContent = err.message; msg.className = 'msg error'; }
  finally { button.disabled = false; }
};

var announcements = [], editingAnnouncement = null;
var toLocalInput = function (ts) { var d = new Date(ts); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
function fillAnnouncement(a) {
  editingAnnouncement = a ? a.id : null;
  $('ann-title-input').value = a ? a.title : '';
  $('ann-kind').value = a ? a.kind : 'info';
  $('ann-body').value = a ? a.body : '';
  $('ann-starts').value = a ? toLocalInput(a.startsAt) : '';
  $('ann-ends').value = a && a.endsAt ? toLocalInput(a.endsAt) : '';
  $('ann-cancel').classList.toggle('hidden', !a);
  $('ann-title').textContent = a ? 'Edit announcement' : 'Status page announcements';
}
function renderAnnouncements() {
  var now = Date.now();
  $('announcements').innerHTML = announcements.map(function (a) {
    var active = a.startsAt <= now && (!a.endsAt || a.endsAt > now);
    var cls = a.kind === 'incident' ? 'down' : a.kind === 'maintenance' ? 'warn' : 'info';
    return '<article class="card" data-ann="' + a.id + '"><div class="row"><div><strong>' + esc(a.title) + '</strong><div class="muted">' + esc(when(a.startsAt)) + (a.endsAt ? ' to ' + esc(when(a.endsAt)) : ', no end') + ' · ' + (active ? 'visible now' : a.startsAt > now ? 'scheduled' : 'expired') + '</div></div><span class="badge ' + cls + '">' + esc(a.kind) + '</span></div>' + (a.body ? '<p style="white-space:pre-wrap">' + esc(a.body) + '</p>' : '') + '<div class="actions"><button data-ann-action="edit">Edit</button><button data-ann-action="delete" class="danger">Delete</button></div></article>';
  }).join('') || '<p class="muted">No announcements. Use them for planned maintenance or incident updates on the public page.</p>';
}
async function loadAnnouncements() { announcements = await (await api('/api/admin/announcements')).json(); renderAnnouncements(); }
$('ann-form').onsubmit = async function (e) {
  e.preventDefault();
  var body = { title: $('ann-title-input').value, kind: $('ann-kind').value, body: $('ann-body').value, startsAt: $('ann-starts').value ? new Date($('ann-starts').value).getTime() : null, endsAt: $('ann-ends').value ? new Date($('ann-ends').value).getTime() : null };
  var r = await api('/api/admin/announcements' + (editingAnnouncement ? '/' + editingAnnouncement : ''), editingAnnouncement ? 'PUT' : 'POST', body);
  showMessage('ann-message', r.ok ? 'Announcement saved' : await r.text(), !r.ok);
  if (r.ok) { fillAnnouncement(null); loadAnnouncements(); }
};
$('ann-cancel').onclick = function () { fillAnnouncement(null); };
$('announcements').onclick = async function (e) {
  var button = e.target.closest('[data-ann-action]'); if (!button) return;
  var id = Number(button.closest('[data-ann]').getAttribute('data-ann'));
  var a = announcements.find(function (x) { return x.id === id; });
  if (button.getAttribute('data-ann-action') === 'edit') { fillAnnouncement(a); window.scrollTo({ top: $('ann-form').offsetTop - 20, behavior: 'smooth' }); return; }
  if (!confirm('Delete announcement "' + a.title + '"?')) return;
  await api('/api/admin/announcements/' + id, 'DELETE');
  if (editingAnnouncement === id) fillAnnouncement(null);
  loadAnnouncements();
};
loadAnnouncements();
$('backup').onclick = async function () {
  var r = await api('/api/admin/backup', 'POST');
  showMessage('tools-message', r.ok ? 'Backup written to ' + (await r.json()).file : await r.text(), !r.ok);
};
${logoutScript}
applyType();
load();
setInterval(function () { if (!editing && document.visibilityState === 'visible') load(); }, 15000);
`;

export function dashboardPage() {
  return page(
    'Dashboard',
    `<h1>Monitor dashboard</h1>${navigation('/dashboard')}<div id="summary" class="summary"></div><section class="panel"><h2 id="form-title">Add monitor</h2>${monitorForm}</section><div id="monitors"></div><section class="panel"><h2 id="ann-title">Status page announcements</h2><form id="ann-form" class="grid"><input type="hidden" id="ann-id"><label class="wide">Title<input id="ann-title-input" required></label><label>Kind<select id="ann-kind"><option value="info">Info</option><option value="maintenance">Maintenance</option><option value="incident">Incident</option></select></label><label class="full">Message<textarea id="ann-body"></textarea></label><label>Visible from (empty = now)<input id="ann-starts" type="datetime-local"></label><label>Visible until (empty = until deleted)<input id="ann-ends" type="datetime-local"></label><div class="full actions"><button class="primary">Publish announcement</button><button type="button" id="ann-cancel" class="hidden">Cancel edit</button></div></form><p id="ann-message" class="msg"></p><div id="announcements"></div></section>
<section class="panel"><h2>Tools</h2><div class="actions"><button id="backup">Create database backup</button></div><p id="tools-message" class="msg"></p></section>`,
    dashboardScript
  );
}

const notificationsScript = `
${clientHelpers}
var map = { name: 'wh-name', url: 'wh-url', timeoutMs: 'wh-timeout', headers: 'wh-headers', enabled: 'wh-enabled', eventDown: 'wh-down', eventRecovered: 'wh-recovered', eventStillDown: 'wh-still' };
async function load() {
  var settings = await (await api('/api/admin/notifications/settings')).json();
  $('env-summary').innerHTML =
    '<tr><th>Environment webhook</th><td>' + (settings.envWebhookConfigured ? esc(settings.envProvider) + ' (configured)' : 'not configured') + '</td></tr>' +
    '<tr><th>SMTP email</th><td>' + (settings.smtpConfigured ? 'configured' : 'not configured') + '</td></tr>' +
    '<tr><th>Active webhook source</th><td>' + esc(settings.activeSource) + '</td></tr>';
  var x = await (await api('/api/admin/webhook')).json();
  Object.keys(map).forEach(function (key) {
    var el = $(map[key]);
    var value = x[key];
    if (key === 'headers') el.value = JSON.stringify(value || {});
    else if (value == null) el.value = el.defaultValue || '';
    else el.value = String(value);
  });
  $('wh-state').textContent = x.url ? (x.enabled ? 'Stored webhook is enabled' : 'Stored webhook is saved but disabled') : 'No stored webhook';
  var h = await (await api('/api/admin/notifications/history')).json();
  $('history').innerHTML = h.map(function (n) {
    return '<tr><td>' + esc(when(n.sentAt)) + '</td><td>' + esc(n.monitorName || n.monitorId) + '</td><td>' + esc(n.eventType) + '</td><td>' + esc(n.provider) + '</td><td>' + (n.success ? 'Success' : '<span class="badge down">Failed</span>') + '</td><td>' + esc(n.error || '') + '</td></tr>';
  }).join('') || '<tr><td colspan="6" class="muted">No notifications sent yet.</td></tr>';
}
function payload() {
  var headers;
  try { headers = JSON.parse($('wh-headers').value || '{}'); } catch (e) { throw new Error('Headers must be a JSON object'); }
  return { name: $('wh-name').value, url: $('wh-url').value, timeoutMs: Number($('wh-timeout').value) || 10000, headers: headers, enabled: $('wh-enabled').value === 'true', eventDown: $('wh-down').value === 'true', eventRecovered: $('wh-recovered').value === 'true', eventStillDown: $('wh-still').value === 'true' };
}
$('webhook-form').onsubmit = async function (e) {
  e.preventDefault();
  try {
    var r = await api('/api/admin/webhook', 'PUT', payload());
    showMessage('wh-message', r.ok ? 'Webhook saved' : await r.text(), !r.ok);
  } catch (err) { showMessage('wh-message', err.message, true); }
  load();
};
$('test-webhook').onclick = async function () {
  var r = await api('/api/admin/webhook/test', 'POST');
  var result = await r.json().catch(function () { return { error: 'Request failed' }; });
  showMessage('wh-message', result.success ? 'Test notification delivered' : 'Test failed: ' + (result.error || 'unknown error'), !result.success);
  load();
};
$('delete-webhook').onclick = async function () {
  if (!confirm('Remove the stored webhook?')) return;
  await api('/api/admin/webhook', 'DELETE');
  showMessage('wh-message', 'Stored webhook removed');
  load();
};
${logoutScript}
load();
`;

export function notificationsPage() {
  return page(
    'Notifications',
    `<h1>Notifications</h1>${navigation('/dashboard/notifications')}
<section class="panel"><h2>Delivery channels</h2><table id="env-summary"></table><p class="muted">Environment channels come from <code>.env</code>. A stored webhook, when enabled, replaces the environment webhook.</p></section>
<section class="panel"><h2>Generic JSON webhook</h2><p id="wh-state" class="muted"></p><form id="webhook-form" class="grid">
<label>Name<input id="wh-name" placeholder="Ops hook" required></label>
<label class="wide">URL<input id="wh-url" placeholder="https://hooks.example.com/uptime" required></label>
<label>Timeout (ms)<input id="wh-timeout" type="number" min="100" value="10000"></label>
<label>Enabled<select id="wh-enabled"><option value="true">Yes</option><option value="false">No</option></select></label>
<label>Send DOWN<select id="wh-down"><option value="true">Yes</option><option value="false">No</option></select></label>
<label>Send RECOVERED<select id="wh-recovered"><option value="true">Yes</option><option value="false">No</option></select></label>
<label>Send STILL_DOWN<select id="wh-still"><option value="true">Yes</option><option value="false">No</option></select></label>
<label class="full">Headers (JSON object)<textarea id="wh-headers">{}</textarea></label>
<div class="full actions"><button class="primary">Save webhook</button><button type="button" id="test-webhook">Send test</button><button type="button" id="delete-webhook" class="danger">Remove</button></div>
</form><p id="wh-message" class="msg"></p></section>
<section class="panel"><h2>Notification history</h2><table><thead><tr><th>Time</th><th>Monitor</th><th>Event</th><th>Provider</th><th>Result</th><th>Error</th></tr></thead><tbody id="history"></tbody></table></section>`,
    notificationsScript
  );
}

const securityScript = `
${clientHelpers}
async function load() {
  var x = await (await api('/api/admin/security')).json();
  $('auth-state').textContent = x.authConfigured ? 'Admin credentials are configured. ' + (x.totpConfigured ? 'TOTP is enabled.' : 'TOTP is not enabled: sign-in only needs the password.') : 'Admin credentials are not configured: the dashboard is open. Set ADMIN_USERNAME, ADMIN_PASSWORD and AUTH_ENCRYPTION_KEY to protect it.';
  $('setup').disabled = !x.authConfigured;
  $('disable').disabled = !x.totpConfigured;
  $('setup').textContent = x.totpConfigured ? 'Regenerate authenticator' : 'Enable authenticator';
}
$('setup').onclick = async function () {
  if (!confirm('This replaces any existing authenticator and recovery codes. Continue?')) return;
  var x = await (await api('/api/admin/security/regenerate', 'POST')).json();
  $('qr').src = x.qrDataUrl; $('qr').classList.remove('hidden');
  $('secret').textContent = 'Secret: ' + x.secret;
  $('codes').textContent = 'Recovery codes (each works once):\\n' + x.recoveryCodes.join('\\n');
  load();
};
$('disable').onclick = async function () {
  if (!confirm('Disable TOTP? Sign-in will only need the password.')) return;
  await api('/api/admin/security/disable', 'POST');
  $('qr').classList.add('hidden'); $('codes').textContent = ''; $('secret').textContent = '';
  load();
};
${logoutScript}
load();
`;

export function securityPage() {
  return page(
    'Security',
    `<h1>Security</h1>${navigation('/dashboard/security')}<section class="panel"><h2>Two-factor authentication (TOTP)</h2><p id="auth-state" class="muted">Loading...</p><div class="actions"><button id="setup" class="primary">Enable authenticator</button><button id="disable" class="danger">Disable TOTP</button></div><p><img id="qr" class="hidden" alt="TOTP QR code" style="max-width:260px;background:#fff;padding:8px;border-radius:8px"></p><p id="secret" class="muted"></p><pre id="codes"></pre><p class="muted">Scan the QR code with an authenticator app. Store the recovery codes offline; they are shown only once.</p></section>`,
    securityScript
  );
}
