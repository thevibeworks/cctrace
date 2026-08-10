import { CLIENT_ICONS } from "./icons";

// The instances dashboard: every live run (heartbeat/probe-verified) and
// the finished runs (registry tombstones), across all projects and
// containers sharing this data dir — one central page. Served at
// /dashboard by EVERY live/view server: the registry is shared, so any
// port answers with the same picture; there is no "main" instance to find
// first. Data comes from the existing endpoints (/api/instances verified
// live list, /api/runs tombstones) — the page is a reader, never a fourth
// liveness judge.
//
// Rows open directly: live rows go to that instance's UI, past rows to
// /view/<run-id> — a snapshot the serving instance renders on demand from
// the run's trace (server.ts resolves the id through the registry; the
// page never names a file). Row stats (pairs, messages, tokens, cost) are
// stamped into the tombstone at exit; the on-disk size is re-stat'd by
// /api/runs per request. Nothing here reads a trace.
//
// Values from the registry (first prompts, project names) are wire/user
// derived and hostile: every row builds through textContent, no innerHTML —
// the one exception is our own icon glyphs (src/icons.ts, trusted source).
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
    --hover: #1f2428; --btn-bg: #21262d;
    color-scheme: dark;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #fff; --bg-surface: #f6f8fa; --border: #d0d7de;
      --text: #1f2328; --text-muted: #656d76; --text-faint: #8c959f;
      --accent: #0969da; --green: #1a7f37; --amber: #9a6700;
      --hover: #eef1f4; --btn-bg: #f6f8fa;
      color-scheme: light;
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text);
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    padding: 24px; max-width: 1180px; margin: 0 auto;
  }
  header { display: flex; align-items: baseline; gap: 10px; margin-bottom: 18px; }
  h1 { font-size: 16px; font-weight: 600; }
  h1 span { color: var(--text-faint); font-weight: 400; }
  .totals { color: var(--text-muted); font-size: 11px; margin-left: auto; font-variant-numeric: tabular-nums; }
  .ver { color: var(--text-faint); font-size: 11px; }
  .sect { display: flex; align-items: baseline; gap: 12px; margin: 18px 0 6px; }
  h2 {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--text-faint);
  }
  /* group-by control: same small-button grammar as the trace view toolbar */
  .grp { margin-left: auto; display: flex; align-items: center; gap: 4px; color: var(--text-faint); font-size: 11px; }
  .grp button {
    font: inherit; font-size: 11px; color: var(--text-muted); cursor: pointer;
    background: var(--btn-bg); border: 1px solid var(--border);
    border-radius: 6px; padding: 0 7px;
  }
  .grp button:hover { color: var(--text); border-color: var(--accent); }
  .grp button.active { color: var(--accent); border-color: var(--accent); }
  .list { border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .ghead {
    padding: 5px 12px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--text-faint); background: var(--bg-surface);
    border-top: 1px solid var(--border);
    display: flex; align-items: baseline; gap: 8px;
  }
  .ghead:first-child { border-top: none; }
  .ghead .gn { color: var(--text-faint); font-variant-numeric: tabular-nums; margin-left: auto; }
  .row {
    display: flex; align-items: center; gap: 10px; padding: 7px 12px;
    border-top: 1px solid var(--border); color: inherit; text-decoration: none;
    font-variant-numeric: tabular-nums;
  }
  .row:first-child { border-top: none; }
  a.row { cursor: pointer; }
  a.row:hover { background: var(--hover); }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--green); }
  .dot.past { background: var(--border); }
  .client {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 0 7px; border-radius: 999px; font-size: 10px; flex: none;
    text-transform: uppercase; color: var(--text-muted); border: 1px solid var(--border);
  }
  .client svg { width: 10px; height: 10px; flex-shrink: 0; }
  .proj { font-weight: 600; flex: none; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .prompt { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; min-width: 0; }
  .sid, .when, .port, .mode, .stat { color: var(--text-faint); flex: none; font-size: 11px; }
  .port { color: var(--accent); }
  .self { color: var(--amber); flex: none; font-size: 10px; }
  .gone { opacity: 0.55; }
  .cp {
    flex: none; font: inherit; font-size: 11px; color: var(--text-faint);
    background: none; border: none; cursor: pointer; padding: 0 2px;
  }
  .cp:hover { color: var(--text); }
  .cp.copied { color: var(--green); }
  .more {
    display: block; width: 100%; text-align: center; padding: 7px 12px;
    font: inherit; font-size: 11px; color: var(--accent); cursor: pointer;
    background: var(--bg-surface); border: none; border-top: 1px solid var(--border);
  }
  .more:hover { background: var(--hover); }
  .empty { padding: 10px 12px; color: var(--text-faint); }
  .note { margin-top: 14px; color: var(--text-faint); font-size: 11px; }
</style>
</head>
<body>
<header>
  <h1>cctrace <span>· dashboard</span></h1>
  <span class="totals" id="totals"></span>
  <span class="ver">${version ? "v" + version : ""}</span>
</header>
<div class="sect"><h2>live</h2></div>
<div class="list" id="live"><div class="empty">loading…</div></div>
<div class="sect"><h2>runs</h2>
  <span class="grp" id="grp">group
    <button data-g="project">project</button>
    <button data-g="client">client</button>
    <button data-g="none">time</button>
  </span>
</div>
<div class="list" id="past"><div class="empty">loading…</div></div>
<div class="note">live rows open that instance · past rows open a snapshot rendered from their trace · ⧉ copies the <b>cctrace view</b> command · refreshes every 15s</div>
<script>
  var ICONS = ${JSON.stringify(CLIENT_ICONS)};
  var SHOW_STEP = 100;
  var showCap = SHOW_STEP;
  var groupBy = localStorage.getItem('cctrace-dash-group') || 'project';
  var lastPast = [];

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
  function bytes(n) {
    if (!(n > 0)) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  function tok(n) {
    if (!(n > 0)) return '';
    if (n < 1000) return '' + n;
    if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
    return (n / 1000000).toFixed(1) + 'm';
  }
  function clientChip(name) {
    var chip = el('span', 'client');
    var ico = ICONS[name || 'claude'];
    if (ico) { var s = el('span'); s.innerHTML = ico; chip.appendChild(s.firstChild); }
    chip.appendChild(document.createTextNode(name || 'claude'));
    return chip;
  }
  function baseRow(i, live) {
    var row = el(live || (i.traceExists && i.id) ? 'a' : 'div', 'row');
    row.appendChild(el('span', 'dot' + (live ? '' : ' past')));
    row.appendChild(clientChip(i.client));
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
      row.href = 'http://' + location.hostname + ':' + Number(i.port) + '/trace';
      if (i.self) row.appendChild(el('span', 'self', 'this server'));
      row.appendChild(el('span', 'mode', i.mode || ''));
      row.appendChild(el('span', 'when', hm(i.startedAt)));
      row.appendChild(el('span', 'port', ':' + i.port));
      row.title = (i.projectPath || i.project || '') +
        (i.logFile ? '\\n' + i.logFile : '') +
        (i.pid ? '\\ncctrace pid ' + i.pid + (i.agentPid ? ' · agent pid ' + i.agentPid : '') : '');
      box.appendChild(row);
    }
    var t = document.getElementById('totals');
    t.textContent = list.length + ' live · ' + lastPast.length + ' runs';
  }
  function pastRow(i) {
    var row = baseRow(i, false);
    if (i.traceExists === false) row.className += ' gone';
    // stat cluster: size · pairs (msgs) · tokens · cost — whatever the
    // tombstone knows; old tombstones just show less.
    var stats = [];
    if (i.traceBytes > 0) stats.push(bytes(i.traceBytes));
    if (i.pairs > 0) stats.push(i.pairs + ' pairs' + (i.messages > 0 ? ' (' + i.messages + ' msg)' : ''));
    if (i.tokensIn > 0 || i.tokensOut > 0) stats.push(tok(i.tokensIn) + ' in / ' + tok(i.tokensOut) + ' out');
    if (i.costUsd > 0.005) stats.push('$' + i.costUsd.toFixed(2));
    if (stats.length) row.appendChild(el('span', 'stat', stats.join(' · ')));
    row.appendChild(el('span', 'when', hm(i.endedAt)));
    row.title = (i.projectPath || '') + (i.logFile ? '\\n' + i.logFile : '');
    if (i.traceExists !== false && i.id) {
      row.href = '/view/' + encodeURIComponent(i.id);
      row.target = '_blank';
      row.rel = 'noopener';
    } else {
      row.appendChild(el('span', 'mode', 'trace not on this host'));
    }
    if (i.logFile && i.traceExists !== false) {
      var cp = el('button', 'cp', '⧉');
      cp.title = 'copy: cctrace view ' + i.logFile;
      cp.onclick = function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        navigator.clipboard.writeText('cctrace view ' + i.logFile).then(function () {
          cp.textContent = '✓'; cp.className = 'cp copied';
          setTimeout(function () { cp.textContent = '⧉'; cp.className = 'cp'; }, 1200);
        });
      };
      row.appendChild(cp);
    }
    return row;
  }
  function groupKey(i) {
    if (groupBy === 'client') return i.client || 'claude';
    if (groupBy === 'project') return i.projectPath || i.project || '(unknown)';
    return '';
  }
  function groupLabel(i) {
    if (groupBy === 'client') return i.client || 'claude';
    return i.project || '(unknown)';
  }
  function renderPast(all) {
    lastPast = all;
    var box = document.getElementById('past');
    box.textContent = '';
    if (!all.length) { box.appendChild(el('div', 'empty', 'no finished runs in the registry (30-day window)')); return; }
    // newest first everywhere; grouping only changes the sections
    var list = all.slice().sort(function (a, b) {
      return String(b.endedAt || '').localeCompare(String(a.endedAt || ''));
    });
    var shown = 0;
    if (groupBy === 'none') {
      for (var k = 0; k < list.length && shown < showCap; k++, shown++) box.appendChild(pastRow(list[k]));
    } else {
      // groups ordered by their newest run, newest-first within
      var groups = [], byKey = {};
      for (var k2 = 0; k2 < list.length; k2++) {
        var key = groupKey(list[k2]);
        if (!byKey[key]) { byKey[key] = { label: groupLabel(list[k2]), items: [] }; groups.push(byKey[key]); }
        byKey[key].items.push(list[k2]);
      }
      for (var g = 0; g < groups.length && shown < showCap; g++) {
        var gh = el('div', 'ghead', groups[g].label);
        gh.appendChild(el('span', 'gn', groups[g].items.length + ' run' + (groups[g].items.length === 1 ? '' : 's')));
        box.appendChild(gh);
        for (var m = 0; m < groups[g].items.length && shown < showCap; m++, shown++) {
          box.appendChild(pastRow(groups[g].items[m]));
        }
      }
    }
    if (list.length > shown) {
      var more = el('button', 'more', 'show ' + Math.min(SHOW_STEP, list.length - shown) + ' more (' + (list.length - shown) + ' hidden)');
      more.onclick = function () { showCap += SHOW_STEP; renderPast(lastPast); };
      box.appendChild(more);
    }
    var t = document.getElementById('totals');
    var liveN = document.querySelectorAll('#live a.row').length;
    t.textContent = liveN + ' live · ' + all.length + ' runs';
  }
  var grp = document.getElementById('grp');
  function paintGrp() {
    var bs = grp.querySelectorAll('button');
    for (var k = 0; k < bs.length; k++) bs[k].className = bs[k].dataset.g === groupBy ? 'active' : '';
  }
  grp.onclick = function (ev) {
    var g = ev.target && ev.target.dataset && ev.target.dataset.g;
    if (!g) return;
    groupBy = g;
    localStorage.setItem('cctrace-dash-group', g);
    paintGrp();
    renderPast(lastPast);
  };
  paintGrp();
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
