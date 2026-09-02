import { CLIENT_ICONS, CCTRACE_MARK } from "./icons";

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
  /* The material is the Claude Design System, measured off claude.ai on
     2026-09-02 — the same tokens the trace view carries (src/ui.ts), so
     the two pages of this product read as one. */
  :root {
    color-scheme: dark;
    --bg: #0b0b0b; --bg-surface: #151515; --surface-2: #1a1a19;
    --text: #f0efec; --text-muted: #c3c2b7; --text-faint: rgba(240,239,236,0.62);
    --border: rgba(255,255,255,0.10); --border-strong: rgba(255,255,255,0.20);
    --clay: #d97757; --clay-strong: #c6613f; --clay-text: #d97757;
    --accent: #6da7ec; --accent-soft: #032042; --accent-line: #184f95;
    --green: #4cc46a; --amber: #cba43c; --red: #ec7e7e;
    --hover: #20201f; --btn-bg: #1a1a19;
    --font-body: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace;
    --text-xs: 11px; --text-sm: 12px; --text-code: 13px; --text-body: 14px;
    --text-heading: 15px; --text-title: 22px;
    --radius: 8px; --radius-sm: 5px; --radius-lg: 12px; --radius-full: 999px;
    --dur-micro: 100ms; --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  }
  @media (prefers-color-scheme: light) {
    :root {
      color-scheme: light;
      --bg: #fcfcfb; --bg-surface: #f9f9f7; --surface-2: #fff;
      --text: #0b0b0b; --text-muted: #52514e; --text-faint: rgba(11,11,11,0.58);
      --border: rgba(11,11,11,0.10); --border-strong: rgba(11,11,11,0.20);
      --accent: #184f95; --accent-soft: #cde2fb; --accent-line: #86b6ef;
      /* clay as TEXT on paper needs its own step: the brand ink itself
         reads 3.1:1 (kit/render-check.mjs). Identity keeps --clay. */
      --clay-text: color-mix(in srgb, #c6613f 80%, #0b0b0b);
      --green: #17842f; --amber: #98801f; --red: #8e2626;
      --hover: #f9f9f7; --btn-bg: #fff;
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  b, strong { font-weight: 600; }
  ::selection { background: color-mix(in srgb, var(--accent) 30%, transparent); }
  :focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }
  body {
    background: var(--bg); color: var(--text);
    font: var(--text-body)/1.5 var(--font-body);
    padding: 28px 24px 40px; max-width: 1180px; margin: 0 auto;
  }
  /* Wire values are mono; labels and prose are not. */
  .sid, .when, .port, .stat, .gn, .totals, .ver, .cp, .joblog, .num,
  .srow .lead, .proj { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  header { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
  .logo { width: 24px; height: 24px; color: var(--clay); flex: none; }
  h1 { font-size: var(--text-heading); font-weight: 600; letter-spacing: -0.01em; }
  h1 span { color: var(--text-faint); font-weight: 400; }
  .totals { color: var(--text-muted); font-size: var(--text-sm); margin-left: auto; }
  .ver { color: var(--text-faint); font-size: var(--text-xs); }
  .sect { display: flex; align-items: center; gap: 12px; margin: 22px 0 8px; }
  h2 {
    font-size: var(--text-sm); font-weight: 500; letter-spacing: 0;
    text-transform: none; color: var(--text-muted);
  }
  /* group-by control: same small-button grammar as the trace view toolbar */
  .grp { margin-left: auto; display: flex; align-items: center; gap: 4px; color: var(--text-faint); font-size: var(--text-sm); }
  .grp button {
    font: inherit; font-size: var(--text-sm); color: var(--text-muted); cursor: pointer;
    background: var(--btn-bg); border: 1px solid var(--border);
    border-radius: var(--radius); height: 24px; padding: 0 9px;
    transition: border-color var(--dur-micro) var(--ease-out);
  }
  .grp button:hover { color: var(--text); border-color: var(--border-strong); }
  .grp button.active { color: var(--accent); border-color: var(--accent-line); background: var(--accent-soft); }
  .list { border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; background: var(--surface-2); }
  .ghead {
    padding: 6px 12px; font-size: var(--text-xs); letter-spacing: 0;
    color: var(--text-faint); background: var(--bg-surface);
    border-top: 1px solid var(--border);
    display: flex; align-items: center; gap: 8px;
  }
  .ghead:first-child { border-top: none; }
  .ghead .gn { color: var(--text-faint); margin-left: auto; }
  .row {
    display: flex; align-items: center; gap: 10px; padding: 6px 12px;
    border-top: 1px solid var(--border); color: inherit; text-decoration: none;
    font-size: var(--text-sm);
    transition: background var(--dur-micro) var(--ease-out);
  }
  .row:first-child { border-top: none; }
  a.row { cursor: pointer; }
  a.row:hover { background: var(--hover); }
  .dot { width: 7px; height: 7px; border-radius: var(--radius-full); flex: none; background: var(--green); }
  .dot.past { background: var(--border-strong); }
  .client {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 0 7px; border-radius: var(--radius-full); font-size: var(--text-xs); flex: none;
    color: var(--text-muted); border: 1px solid var(--border);
  }
  .client svg { width: 11px; height: 11px; flex-shrink: 0; }
  .proj { font-weight: 500; flex: none; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-code); }
  .prompt { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; min-width: 0; }
  .sid, .when, .port, .mode, .stat { color: var(--text-faint); flex: none; font-size: var(--text-xs); }
  .port { color: var(--accent); }
  .self { color: var(--clay-text); flex: none; font-size: var(--text-xs); }
  .gone { opacity: 0.55; }
  .cp {
    flex: none; font: inherit; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-faint);
    background: none; border: none; cursor: pointer;
    min-width: 24px; height: 24px;
  }
  .cp:hover { color: var(--text); }
  .cp.copied { color: var(--green); }
  /* row actions (stop / force): quiet until armed, then unmistakable */
  .act {
    flex: none; font: inherit; font-size: var(--text-xs); cursor: pointer;
    color: var(--text-faint); background: var(--btn-bg);
    border: 1px solid var(--border); border-radius: var(--radius-sm); height: 22px; padding: 0 8px;
  }
  .act:hover { color: var(--text); border-color: var(--border-strong); }
  .act.arm { color: var(--red); border-color: var(--red); }
  .act.err { color: var(--amber); border-color: var(--amber); }
  .act:disabled { cursor: default; opacity: 0.6; }
  .act.go { color: var(--accent); border-color: var(--accent-line); }
  .pending { color: var(--amber); flex: none; font-size: var(--text-xs); }
  /* store: the housekeeping picture + the one job that changes it */
  .srow { display: flex; align-items: center; gap: 10px; padding: 6px 12px; border-top: 1px solid var(--border); font-size: var(--text-sm); }
  .srow:first-child { border-top: none; }
  .srow .lead { font-weight: 500; flex: none; }
  .srow .fill { flex: 1 1 auto; min-width: 0; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .srow.jobrow { background: var(--bg-surface); }
  .jstate { flex: none; font-size: var(--text-xs); letter-spacing: 0; }
  .jstate.running { color: var(--accent); }
  .jstate.done { color: var(--green); }
  .jstate.failed, .jstate.cancelled { color: var(--amber); }
  .joblog {
    margin: 0; padding: 8px 12px; max-height: 260px; overflow: auto;
    border-top: 1px solid var(--border); background: var(--bg);
    color: var(--text-muted); font-size: var(--text-xs); white-space: pre-wrap; word-break: break-word;
  }
  .more {
    display: block; width: 100%; text-align: center; padding: 7px 12px;
    font: inherit; font-size: var(--text-sm); color: var(--accent); cursor: pointer;
    background: var(--bg-surface); border: none; border-top: 1px solid var(--border);
  }
  .more:hover { background: var(--hover); }
  .empty { padding: 12px; color: var(--text-faint); font-size: var(--text-sm); }
  .note { margin-top: 16px; color: var(--text-faint); font-size: var(--text-sm); }
  .note.stale { color: var(--amber); }
  /* Touch tier: row actions reach the 44px floor on a thumb-sized screen. */
  @media (max-width: 760px) {
    .act { height: 44px; min-width: 44px; }
    .cp { min-width: 44px; height: 44px; }
  }
</style>
</head>
<body>
<header>
  ${CCTRACE_MARK}
  <h1>cctrace <span>· dashboard</span></h1>
  <span class="totals" id="totals"></span>
  <span class="ver">${version ? "v" + version : ""}</span>
</header>
<div class="sect"><h2>live</h2></div>
<div class="list" id="live"><div class="empty">loading…</div></div>
<div class="sect"><h2>store</h2>
  <span class="grp" id="storeact"></span>
</div>
<div class="list" id="store"><div class="empty">loading…</div></div>
<div class="sect"><h2>runs</h2>
  <span class="grp" id="grp">group
    <button data-g="project">project</button>
    <button data-g="client">client</button>
    <button data-g="none">time</button>
  </span>
</div>
<div class="list" id="past"><div class="empty">loading…</div></div>
<div class="note" id="note">live rows open that instance · <b>stop</b> ends a run through its normal close-out (the trace is sealed) · past rows open a snapshot rendered from their trace · ⧉ copies the <b>cctrace view</b> command · refreshes every 15s</div>
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
    // The generated session title when one exists (cctrace title), else
    // the human's first prompt — the wire-derived identity.
    var who = el('span', 'prompt', i.title || i.firstPrompt || '');
    if (i.title && i.firstPrompt) who.title = i.firstPrompt;
    row.appendChild(who);
    if (i.sessionId) row.appendChild(el('span', 'sid', String(i.sessionId).slice(0, 8)));
    return row;
  }
  // A run we asked to stop: id -> when. The row keeps saying so until the
  // instance leaves the live list (its own exit unregisters it), and offers
  // the harder ask once a graceful stop has clearly not landed.
  var stopping = {};
  var FORCE_AFTER_MS = 8000;

  function isViewer(i) { return i.mode === 'view' || i.mode === 'tail'; }

  // Two-step, because the graceful path still ENDS somebody's session: the
  // first click arms, the second sends. Arming decays after 5s.
  function stopButton(i, force) {
    var viewer = isViewer(i);
    var b = el('button', 'act' + (force ? ' err' : ''), force ? 'force' : 'stop');
    b.title = force
      ? 'SIGKILL the traced client — use when a stop did not land'
      : viewer
        ? 'close this viewer (nothing is captured here)'
        : 'end this traced session — the client exits, then cctrace flushes, prints its receipt and seals the trace';
    var armed = false, timer = null;
    var disarm = function () { armed = false; b.className = 'act' + (force ? ' err' : ''); b.textContent = force ? 'force' : 'stop'; };
    b.onclick = function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      if (!armed) {
        armed = true;
        b.className = 'act arm';
        b.textContent = force ? 'kill it?' : viewer ? 'close?' : 'end session?';
        timer = setTimeout(disarm, 5000);
        return;
      }
      clearTimeout(timer);
      armed = false;
      b.disabled = true;
      b.className = 'act';
      b.textContent = 'sending…';
      fetch('/api/instances/stop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: i.id, force: !!force })
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; });
      }).then(function (res) {
        if (!res.ok) {
          b.disabled = false;
          b.className = 'act err';
          b.textContent = 'refused';
          b.title = res.j.error || res.j.detail || 'the run did not accept the stop';
          return;
        }
        stopping[i.id] = Date.now();
        if (i.self) selfStopped = true;
        refresh();
      }).catch(function (e) {
        b.disabled = false;
        b.className = 'act err';
        b.textContent = 'failed';
        b.title = String(e);
      });
    };
    return b;
  }

  function renderLive(list) {
    var box = document.getElementById('live');
    box.textContent = '';
    if (!list.length) { box.appendChild(el('div', 'empty', selfStopped ? 'no live instances — this server stopped too' : 'no live instances')); return; }
    var seen = {};
    for (var k = 0; k < list.length; k++) {
      var i = list[k];
      seen[i.id] = 1;
      var row = baseRow(i, true);
      row.href = 'http://' + location.hostname + ':' + Number(i.port) + '/trace';
      if (i.self) row.appendChild(el('span', 'self', 'this server'));
      row.appendChild(el('span', 'mode', i.mode || ''));
      row.appendChild(el('span', 'when', hm(i.startedAt)));
      row.appendChild(el('span', 'port', ':' + i.port));
      var asked = i.id ? stopping[i.id] : 0;
      if (asked) row.appendChild(el('span', 'pending', 'stopping…'));
      if (i.id) row.appendChild(stopButton(i, asked && Date.now() - asked > FORCE_AFTER_MS));
      row.title = (i.projectPath || i.project || '') +
        (i.logFile ? '\\n' + i.logFile : '') +
        (i.pid ? '\\ncctrace pid ' + i.pid + (i.agentPid ? ' · agent pid ' + i.agentPid : '') : '');
      box.appendChild(row);
    }
    // A run that left the list has stopped — forget the pending mark.
    for (var id in stopping) { if (!seen[id]) delete stopping[id]; }
    var t = document.getElementById('totals');
    t.textContent = list.length + ' live · ' + lastPast.length + ' runs';
  }
  function pastRow(i) {
    var row = baseRow(i, false);
    if (i.traceExists === false) row.className += ' gone';
    // stat cluster: size · pairs (msgs) · tokens · cost — whatever the
    // tombstone knows; old tombstones just show less.
    var stats = [];
    if (i.traceBytes > 0) stats.push(bytes(i.traceBytes) + (/\\.(zst|gz)$/.test(i.traceCarrier || i.logFile || '') ? ' on disk (zst)' : ''));
    if (i.pairs > 0) stats.push(i.pairs + ' pairs' + (i.messages > 0 ? ' (' + i.messages + ' msg)' : ''));
    if (i.tokensIn > 0 || i.tokensOut > 0) stats.push(tok(i.tokensIn) + ' in / ' + tok(i.tokensOut) + ' out');
    if (i.costUsd > 0.005) stats.push('$' + i.costUsd.toFixed(2));
    if (stats.length) row.appendChild(el('span', 'stat', stats.join(' · ')));
    row.appendChild(el('span', 'when', hm(i.endedAt)));
    var tracePath = i.traceCarrier || i.logFile;
    row.title = (i.projectPath || '') + (tracePath ? '\\n' + tracePath : '');
    if (i.traceExists !== false && i.id) {
      row.href = '/view/' + encodeURIComponent(i.id);
      row.target = '_blank';
      row.rel = 'noopener';
    } else {
      row.appendChild(el('span', 'mode', 'trace missing'));
    }
    if (tracePath && i.traceExists !== false) {
      var cp = el('button', 'cp', '⧉');
      cp.title = 'copy: cctrace view ' + tracePath;
      cp.onclick = function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        navigator.clipboard.writeText('cctrace view ' + tracePath).then(function () {
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
  // ---- store: the housekeeping picture, and the job that changes it ----
  //
  // The page shows what /api/store measured (plan and totals) and, while an
  // archive runs, that job's own output. It never estimates: the button
  // triggers cctrace compress --all --yes server-side and the numbers come
  // back from a re-measure.
  var jobLogOpen = false;
  var lastJobId = '';
  var selfStopped = false;
  var archiving = false;

  function srow() {
    var r = el('div', 'srow');
    for (var k = 0; k < arguments.length; k++) if (arguments[k]) r.appendChild(arguments[k]);
    return r;
  }
  function since(ms) {
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  }
  function archiveRequest(body) {
    return fetch('/api/store/archive', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) { if (j.job) renderStore(lastStore, j.job); pollStore(); });
  }
  // What a finished job did, from the store measured before and after —
  // not from its log, whose last line is usually about the last dir it
  // walked rather than the run as a whole.
  function jobSummary(job) {
    if (job.state === 'running') return job.lines.length ? job.lines[job.lines.length - 1] : job.command;
    if (job.error) return job.error;
    if (!job.after) return job.command;
    var n = job.before.plain - job.after.plain;
    var saved = job.before.bytes - job.after.bytes;
    if (n <= 0) return 'nothing to archive — the store was already at rest';
    return 'archived ' + n + ' trace' + (n === 1 ? '' : 's') + ' · ' +
      bytes(job.before.bytes) + ' → ' + bytes(job.after.bytes) + ' on disk' +
      (saved > 0 ? ' · saved ' + bytes(saved) : '');
  }
  function jobRow(job) {
    var r = el('div', 'srow jobrow');
    r.appendChild(el('span', 'jstate ' + job.state, job.state));
    r.appendChild(el('span', 'fill', jobSummary(job)));
    if (job.state === 'running') {
      r.appendChild(el('span', 'stat', since(job.startedAt)));
      var cancel = el('button', 'act', 'cancel');
      cancel.title = 'stop the archive between files — nothing half-written survives';
      cancel.onclick = function () { cancel.disabled = true; archiveRequest({ cancel: true }); };
      r.appendChild(cancel);
    } else if (job.endedAt) {
      r.appendChild(el('span', 'stat', 'took ' + Math.max(1, Math.round((job.endedAt - job.startedAt) / 1000)) + 's'));
    }
    if (job.lines.length) {
      var tog = el('button', 'act', jobLogOpen ? 'hide output' : 'output');
      tog.onclick = function () { jobLogOpen = !jobLogOpen; renderStore(lastStore, job); };
      r.appendChild(tog);
    }
    return r;
  }
  var lastStore = null;
  function renderStore(s, job) {
    lastStore = s;
    var box = document.getElementById('store');
    var act = document.getElementById('storeact');
    box.textContent = '';
    act.textContent = '';
    if (!s) { box.appendChild(el('div', 'empty', 'no store on this server')); return; }
    job = job !== undefined ? job : s.job;
    archiving = !!(job && job.state === 'running');

    var head = srow(
      el('span', 'lead', bytes(s.bytes) || '0 B'),
      el('span', 'fill', s.traces + ' trace' + (s.traces === 1 ? '' : 's') + ' across ' + s.projects + ' project' + (s.projects === 1 ? '' : 's')),
      el('span', 'stat', s.root)
    );
    box.appendChild(head);

    // A live run's trace is NOT work: it can't be archived while it's being
    // written, so it never justifies the button — it only explains a number.
    var held = s.liveHeld > 0 ? s.liveHeld + ' held by live run' + (s.liveHeld === 1 ? '' : 's') : '';
    var pending = [];
    if (s.plain > 0) pending.push(s.plain + ' plain trace' + (s.plain === 1 ? '' : 's') + ' · ' + bytes(s.plainBytes));
    if (s.upgrades > 0) pending.push(s.upgrades + ' legacy .gz to re-encode');
    if (s.staleSeals > 0) pending.push(s.staleSeals + ' interrupted exit seal' + (s.staleSeals === 1 ? '' : 's'));
    if (held) pending.push(held);

    if (s.plain > 0 || s.upgrades > 0 || s.staleSeals > 0) {
      var r = srow(el('span', 'lead', 'not archived'), el('span', 'fill', pending.join(' · ')));
      if (!archiving) {
        var go = el('button', 'act go', 'archive now');
        go.title = 'runs cctrace compress --all --yes: zstd at rest (40-90x), each archive verified before its original is removed';
        go.onclick = function () { go.disabled = true; go.textContent = 'starting…'; archiveRequest({}); };
        r.appendChild(go);
      }
      box.appendChild(r);
    } else {
      box.appendChild(srow(
        el('span', 'lead', 'at rest'),
        el('span', 'fill', 'every trace is archived as .zst' + (held ? ' · ' + held : ''))
      ));
    }

    // Where the weight is: the biggest projects still holding plain traces.
    for (var k = 0; k < s.dirs.length && k < 3; k++) {
      var d = s.dirs[k];
      if (!d.plain) break;
      box.appendChild(srow(
        el('span', 'proj', (d.project || d.dir).split('/').pop() || d.dir),
        el('span', 'fill', d.plain + ' plain · ' + bytes(d.plainBytes)),
        el('span', 'stat', bytes(d.bytes) + ' total')
      ));
    }

    if (job) {
      if (job.id !== lastJobId) { lastJobId = job.id; jobLogOpen = job.state === 'running'; }
      box.appendChild(jobRow(job));
      if (jobLogOpen && job.lines.length) {
        var pre = el('pre', 'joblog', (job.dropped ? '… ' + job.dropped + ' earlier line(s) dropped\\n' : '') + job.lines.join('\\n'));
        box.appendChild(pre);
        pre.scrollTop = pre.scrollHeight;
      }
      if (job.error) box.appendChild(srow(el('span', 'lead', 'error'), el('span', 'fill', job.error)));
    }
  }
  var storeTimer = null;
  function pollStore() {
    clearTimeout(storeTimer);
    fetch('/api/store').then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) { renderStore(s); })
      .catch(function () {})
      .then(function () {
        // A running job is worth watching closely; an idle store is not.
        storeTimer = setTimeout(pollStore, archiving ? 2000 : 15000);
      });
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
    fetch('/api/instances').then(function (r) { return r.json(); }).then(function (list) {
      renderLive(list);
      document.getElementById('note').className = 'note';
    }).catch(function () {
      // The server that served this page is gone — say so instead of
      // quietly showing a frozen picture (stopping THIS instance does it).
      var n = document.getElementById('note');
      n.textContent = selfStopped
        ? 'this server was stopped from here — open the dashboard from another live instance'
        : 'not reaching this dashboard server — showing the last picture it sent';
      n.className = 'note stale';
    });
    fetch('/api/runs').then(function (r) { return r.json(); }).then(renderPast).catch(function () {});
  }
  refresh();
  pollStore();
  setInterval(refresh, 15000);
</script>
</body>
</html>`;
}
