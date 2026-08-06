// The instances dashboard: every live run (heartbeat/probe-verified) and
// the recent finished runs (registry tombstones), across all projects and
// containers sharing this data dir — one central page. Served at
// /dashboard by EVERY live/view server: the registry is shared, so any
// port answers with the same picture; there is no "main" instance to find
// first. Data comes from the existing endpoints (/api/instances verified
// live list, /api/runs tombstones) — the page is a reader, never a fourth
// liveness judge.
//
// Values from the registry (first prompts, project names) are wire/user
// derived and hostile: every row builds through textContent, no innerHTML.
export function getDashboardHtml(meta: { version?: string } = {}): string {
  const version = meta.version || "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CCTrace · dashboard</title>
<style>
  :root {
    --bg: #0d1117; --bg-surface: #161b22; --border: #30363d;
    --text: #c9d1d9; --text-muted: #8b949e; --text-faint: #6e7681;
    --accent: #58a6ff; --green: #3fb950; --amber: #d29922;
    --hover: #1f2428;
    color-scheme: dark;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #fff; --bg-surface: #f6f8fa; --border: #d0d7de;
      --text: #1f2328; --text-muted: #656d76; --text-faint: #8c959f;
      --accent: #0969da; --green: #1a7f37; --amber: #9a6700;
      --hover: #eef1f4;
      color-scheme: light;
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text);
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    padding: 24px; max-width: 1100px; margin: 0 auto;
  }
  header { display: flex; align-items: baseline; gap: 10px; margin-bottom: 18px; }
  h1 { font-size: 16px; font-weight: 600; }
  h1 span { color: var(--text-faint); font-weight: 400; }
  .ver { color: var(--text-faint); font-size: 11px; margin-left: auto; }
  h2 {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--text-faint); margin: 18px 0 6px;
  }
  .list { border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .row {
    display: flex; align-items: center; gap: 10px; padding: 7px 12px;
    border-top: 1px solid var(--border); color: inherit; text-decoration: none;
    font-variant-numeric: tabular-nums; cursor: pointer;
  }
  .row:first-child { border-top: none; }
  .row:hover { background: var(--hover); }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--green); }
  .dot.past { background: var(--border); }
  .client {
    padding: 0 7px; border-radius: 999px; font-size: 10px; flex: none;
    text-transform: uppercase; color: var(--text-muted); border: 1px solid var(--border);
  }
  .proj { font-weight: 600; flex: none; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .prompt { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; min-width: 0; }
  .sid, .when, .port, .mode { color: var(--text-faint); flex: none; font-size: 11px; }
  .port { color: var(--accent); }
  .self { color: var(--amber); flex: none; font-size: 10px; }
  .gone { opacity: 0.55; }
  .empty { padding: 10px 12px; color: var(--text-faint); }
  .note { margin-top: 14px; color: var(--text-faint); font-size: 11px; }
  .copied { color: var(--green); }
</style>
</head>
<body>
<header><h1>cctrace <span>· dashboard</span></h1><span class="ver">${version ? "v" + version : ""}</span></header>
<h2>live</h2>
<div class="list" id="live"><div class="empty">loading…</div></div>
<h2>recent runs</h2>
<div class="list" id="past"><div class="empty">loading…</div></div>
<div class="note">live rows open that instance's UI · past rows copy their <b>cctrace view</b> command · refreshes every 15s</div>
<script>
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }
  function hm(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function baseRow(i, live) {
    var row = el(live ? 'a' : 'div', 'row');
    row.appendChild(el('span', 'dot' + (live ? '' : ' past')));
    row.appendChild(el('span', 'client', i.client || 'claude'));
    var proj = el('span', 'proj', i.project || '(unknown)');
    proj.title = i.projectPath || '';
    row.appendChild(proj);
    row.appendChild(el('span', 'prompt', i.firstPrompt || ''));
    if (i.sessionId) row.appendChild(el('span', 'sid', String(i.sessionId).slice(0, 8)));
    return row;
  }
  function renderLive(list) {
    var box = document.getElementById('live');
    box.textContent = '';
    if (!list.length) { box.appendChild(el('div', 'empty', 'no live instances')); return; }
    for (var k = 0; k < list.length; k++) {
      var i = list[k];
      var row = baseRow(i, true);
      row.href = 'http://' + location.hostname + ':' + Number(i.port) + '/';
      if (i.self) row.appendChild(el('span', 'self', 'this server'));
      row.appendChild(el('span', 'mode', i.mode || ''));
      row.appendChild(el('span', 'when', hm(i.startedAt)));
      row.appendChild(el('span', 'port', ':' + i.port));
      row.title = (i.projectPath || i.project || '') +
        (i.logFile ? '\\n' + i.logFile : '') +
        (i.pid ? '\\ncctrace pid ' + i.pid + (i.agentPid ? ' · agent pid ' + i.agentPid : '') : '');
      box.appendChild(row);
    }
  }
  function renderPast(all) {
    var box = document.getElementById('past');
    box.textContent = '';
    if (!all.length) { box.appendChild(el('div', 'empty', 'no finished runs in the registry (30-day window)')); return; }
    // Registries accumulate hundreds of tombstones in the 30-day window —
    // cap the page, say what was cut (no silent truncation).
    var list = all.slice(0, 50);
    for (var k = 0; k < list.length; k++) {
      (function (i) {
        var row = baseRow(i, false);
        if (i.traceExists === false) row.className += ' gone';
        row.appendChild(el('span', 'when', hm(i.endedAt)));
        var hint = el('span', 'mode', i.traceExists === false ? 'trace not on this host' : 'copy view cmd');
        row.appendChild(hint);
        row.title = (i.projectPath || '') + (i.logFile ? '\\n' + i.logFile : '');
        row.onclick = function () {
          if (!i.logFile) return;
          navigator.clipboard.writeText('cctrace view ' + i.logFile).then(function () {
            hint.textContent = 'copied';
            hint.className = 'mode copied';
            setTimeout(function () { hint.textContent = 'copy view cmd'; hint.className = 'mode'; }, 1200);
          });
        };
        box.appendChild(row);
      })(list[k]);
    }
    if (all.length > list.length) {
      box.appendChild(el('div', 'empty', '+ ' + (all.length - list.length) + ' more finished runs — cctrace view lists them all'));
    }
  }
  function refresh() {
    fetch('/api/instances').then(function (r) { return r.json(); }).then(renderLive).catch(function () {});
    fetch('/api/runs').then(function (r) { return r.json(); }).then(renderPast).catch(function () {});
  }
  refresh();
  setInterval(refresh, 15000);
</script>
</body>
</html>`;
}
