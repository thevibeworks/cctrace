import { CLIENT_ICONS, CCTRACE_MARK } from "./icons";
import { UI_ICONS } from "./vendor/ui-icons";
import { CHROME_CSS, NAV_SCRIPT, PREFS_SCRIPT } from "./chrome";
import { clientLabel, wireTables } from "./clients";
import { escHtml } from "./session";

// The instances dashboard: every live run (heartbeat/probe-verified) and
// the finished runs (registry tombstones), across all projects and
// containers sharing this data dir — one central page. Served at
// /dashboard by EVERY live/view server: the registry is shared, so any
// port answers with the same picture; there is no "main" instance to find
// first. Data comes from the existing endpoints (/api/instances verified
// live list, /api/runs tombstones, /api/self this server's own identity) —
// the page is a reader, never a fourth liveness judge.
//
// ONE LIST, ONE GROUPING (0.51): live and finished runs are the same
// objects in the same list. "Live" is a STATE — a green dot, a port, a stop
// control, a filter chip — not a section, because a section makes the
// grouping lie: with live runs above it, "group by project" only grouped
// half the page. Grouping (project / client / day) applies to every run,
// live rows sort first inside their group, and each group pages on its own
// so one busy project cannot crowd the others out of view.
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
  const version = escHtml(meta.version || "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CCTrace · dashboard</title>
<script>${PREFS_SCRIPT}</script>
<style>
  ${CHROME_CSS}
  * { box-sizing: border-box; margin: 0; padding: 0; }
  b, strong { font-weight: 600; }
  body {
    background: var(--bg); color: var(--text);
    font: var(--text-body)/1.5 var(--font-body);
    height: 100vh; height: 100dvh; overflow: hidden;
  }
  /* Mono carries the WIRE and nothing else: ids, ports, clock times, byte
     counts, file names. Project names, prompts, labels and controls are the
     reading face — the same split the trace view makes. */
  .sid, .when, .port, .stat, .gn, .totals, .ver, .joblog, .num,
  .lead, .pbytes, .fname, .fbytes, .fwhen, .rc-trace, .jstat {
    font-family: var(--font-mono); font-variant-numeric: tabular-nums;
  }
  header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--border); flex: none; }
  h1 { font-size: var(--text-heading); font-weight: 600; letter-spacing: 0; }
  .totals { color: var(--text-muted); font-size: var(--text-sm); }
  .ver { color: var(--text-faint); font-size: var(--text-xs); }
  /* ---- the rail's run card: what THIS server is ---- */
  a.runcard { text-decoration: none; color: inherit; }
  a.runcard[href] { cursor: pointer; }
  a.runcard[href]:hover { border-color: var(--border-strong); background: var(--overlay); }
  .rc-kind { display: flex; align-items: center; gap: 6px; font-size: var(--text-xs); color: var(--text-faint); }
  .rc-kind .status { margin-left: auto; }
  .rc-trace { font-size: var(--text-xs); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* ---- section headers: the trace view's treatment ---- */
  .sect { display: flex; align-items: center; gap: 12px; padding: 16px 16px 8px; }
  h2 { font-size: var(--text-sm); font-weight: 500; letter-spacing: 0; color: var(--text-muted); }
  .sect .stat { margin-left: auto; max-width: 55%; color: var(--text-faint); font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* group-by control: the trace view toolbar's small-button grammar */
  .grp { margin-left: auto; display: flex; align-items: center; gap: 1px; padding: 2px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-surface); }
  .grp button {
    font: inherit; font-size: var(--text-sm); color: var(--text-muted); cursor: pointer;
    background: transparent; border: 1px solid transparent;
    border-radius: var(--radius-sm); height: 24px; padding: 0 9px;
    transition: color var(--dur-micro) var(--ease-out);
  }
  .grp button:hover { color: var(--text); }
  .grp button.active { color: var(--accent); border-color: var(--accent-line); background: var(--accent-soft); }
  .list { border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); background: var(--bg); }
  .ghead {
    position: sticky; top: 0; z-index: 1;
    padding: 6px 16px; font-size: var(--text-xs); letter-spacing: 0;
    color: var(--text-faint); background: var(--bg-surface);
    border-top: 1px solid var(--border);
    display: flex; align-items: center; gap: 8px;
  }
  .ghead:first-child { border-top: none; }
  .ghead .gn { color: var(--text-faint); margin-left: auto; }
  /* ---- a run row ----
     Identity gets a MEASURE, the numbers that say what the run is worth
     travel right after it, and the slack goes before the transport columns
     (clock, port) that hold the right edge — never between a label and its
     own number (docs/design/ui.md). */
  .row {
    display: grid; grid-template-columns: 7px minmax(0, 60ch) auto 1fr auto;
    align-items: center; gap: 12px; padding: 7px 16px;
    border-top: 1px solid var(--border); color: inherit; text-decoration: none;
    transition: background var(--dur-micro) var(--ease-out);
  }
  .row:first-child { border-top: none; }
  a.row { cursor: pointer; }
  a.row:hover { background: var(--hover); }
  .row .live-dot { align-self: center; }
  .row-tx { justify-self: end; }
  .row-val .stat { max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .port { color: var(--accent); }
  .self { color: var(--clay-text); }
  .gone { opacity: 0.55; }
  .tag { font-size: var(--text-xs); color: var(--text-faint); font-family: var(--font-body); }
  .row-act { display: flex; align-items: center; gap: 6px; }
  .row-act:empty { display: none; }
  .cp {
    flex: none; font: inherit; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-faint);
    background: none; border: none; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px;
  }
  .cp:hover { color: var(--text); }
  .cp.copied { color: var(--green); }
  /* row actions (stop / force): quiet until armed, then unmistakable */
  .act {
    flex: none; font: inherit; font-size: var(--text-xs); cursor: pointer;
    color: var(--text-faint); background: var(--btn-bg);
    border: 1px solid var(--border); border-radius: var(--radius-sm); height: 24px; padding: 0 8px;
    white-space: nowrap;
  }
  .act:hover { color: var(--text); border-color: var(--border-strong); }
  .act.arm { color: var(--red); border-color: var(--red); }
  .act.err { color: var(--amber); border-color: var(--amber); }
  .act:disabled { cursor: default; opacity: 0.6; }
  /* The page's ONE primary action wears clay — the same ink as the mark,
     spent once per screen (docs/design/ui.md). */
  .act.go { color: #fff; background: var(--clay-strong); border-color: transparent; height: 28px; font-size: var(--text-sm); padding: 0 12px; }
  .act.go:hover { color: #fff; background: var(--clay); border-color: transparent; }
  .row-act .act { min-width: 64px; text-align: center; }
  .pending { color: var(--amber); flex: none; font-size: var(--text-xs); }
  /* ---- the filter row ---- */
  .dash-toolbar { display: flex; align-items: center; gap: 10px; padding: 8px 16px; border-bottom: 1px solid var(--border); flex: none; }
  .dash-search { display: flex; align-items: center; gap: 8px; min-width: 0; width: 300px; height: 28px; padding: 0 9px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); color: var(--text-faint); }
  .dash-search:focus-within { border-color: var(--accent-line); }
  .dash-search input { width: 100%; min-width: 0; font: inherit; font-size: var(--text-sm); color: var(--text); border: 0; outline: 0; background: transparent; }
  /* the trace view's filter chip, same geometry */
  .fchip {
    display: inline-flex; align-items: center; gap: 6px; flex: none;
    height: 24px; padding: 0 10px; font: inherit; font-size: var(--text-sm);
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-full); color: var(--text-muted); cursor: pointer;
  }
  .fchip:hover { color: var(--text); border-color: var(--border-strong); }
  .fchip[aria-pressed="true"] { color: var(--text); border-color: currentColor; }
  .fchip .n { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--text-faint); }
  .more {
    display: block; width: 100%; text-align: left; padding: 6px 16px;
    font: inherit; font-size: var(--text-sm); color: var(--accent); cursor: pointer;
    background: transparent; border: none; border-top: 1px solid var(--border);
  }
  .more:hover { background: var(--hover); }
  .empty { padding: 12px 16px; color: var(--text-faint); font-size: var(--text-sm); }
  .note { margin: 12px 16px; color: var(--text-faint); font-size: var(--text-sm); }
  .note.stale { color: var(--amber); }
  .note:empty { display: none; }
  #dashboard-content { flex: 1; min-height: 0; overflow-y: auto; padding-bottom: 24px; }
  /* ---- loading: the shape of the answer, not a spinner ---- */
  .sk { padding: 9px 16px; border-top: 1px solid var(--border); display: flex; align-items: center; gap: 12px; }
  .sk:first-child { border-top: none; }
  .sk i { display: block; height: 9px; border-radius: 3px; background: var(--border); }
  .sk .s1 { width: 7px; height: 7px; border-radius: var(--radius-full); flex: none; }
  .sk .s2 { flex: 1 1 auto; max-width: 260px; }
  .sk .s3 { width: 90px; margin-left: auto; }
  /* ---- storage ---- */
  .srow { display: flex; align-items: center; gap: 12px; padding: 8px 16px; border-top: 1px solid var(--border); font-size: var(--text-sm); }
  .srow:first-child { border-top: none; }
  .srow .lead { font-weight: 500; flex: none; color: var(--text); }
  .srow .fill { flex: 1 1 auto; min-width: 0; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .srow.jobrow { background: var(--bg-surface); }
  .jstate { flex: none; font-size: var(--text-xs); letter-spacing: 0; }
  .jstate.running { color: var(--accent); }
  .jstate.done { color: var(--green); }
  .jstate.failed, .jstate.cancelled { color: var(--amber); }
  .jstat { flex: none; font-size: var(--text-xs); color: var(--text-faint); }
  .joblog {
    margin: 0; padding: 8px 16px; max-height: 260px; overflow: auto;
    border-top: 1px solid var(--border); background: var(--bg);
    color: var(--text-muted); font-size: var(--text-xs); white-space: pre-wrap; word-break: break-word;
  }
  /* The store's stacked bar: one ramp, four states, a 2px surface gap
     between fills so adjacent steps stay countable. */
  .sbar { display: flex; height: 10px; width: 100%; min-width: 0; border-radius: 2px; background: var(--bg-surface); box-shadow: inset 0 0 0 1px var(--border); overflow: hidden; }
  .sbar i { display: block; height: 100%; border-right: 2px solid var(--bg); }
  .sbar i:last-child { border-right: 0; }
  .s-zst { background: var(--store-zst); }
  .s-live { background: var(--store-live); }
  .s-gz { background: var(--store-gz); }
  .s-plain { background: var(--store-plain); }
  .barrow { padding: 10px 16px 12px; border-top: 1px solid var(--border); }
  .slegend { display: flex; flex-wrap: wrap; gap: 4px 18px; padding: 8px 16px 10px; border-top: 1px solid var(--border); font-size: var(--text-sm); }
  .slegend span.it { display: inline-flex; align-items: center; gap: 6px; color: var(--text-muted); }
  .slegend i { width: 9px; height: 9px; border-radius: 2px; flex: none; }
  .slegend b { font-weight: 400; font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--text); }
  .phead {
    display: grid; grid-template-columns: 22px minmax(110px, 190px) minmax(0, 1fr) 82px 78px;
    align-items: center; gap: 10px; padding: 6px 16px;
    border-top: 1px solid var(--border);
    transition: background var(--dur-micro) var(--ease-out);
  }
  .phead:hover { background: var(--hover); }
  .prow:first-child .phead { border-top: none; }
  .tw {
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; padding: 0; flex: none;
    border: 1px solid transparent; border-radius: var(--radius-sm);
    background: transparent; color: var(--text-faint); cursor: pointer;
  }
  .tw:hover { color: var(--text); background: var(--hover); }
  .tw svg { width: 14px; height: 14px; }
  .tw[aria-expanded="true"] svg { transform: rotate(90deg); }
  .pname { font-size: var(--text-sm); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pname .runid-parent { color: var(--text-faint); }
  .pbytes { font-size: var(--text-xs); color: var(--text-muted); text-align: right; }
  .phead .act { justify-self: end; }
  .pfiles { background: var(--bg-surface); border-top: 1px solid var(--border); }
  /* A file list is its own small table: the name gets a measure and the
     columns sit right beside it, so the eye reads one line instead of
     crossing the page to find the size. */
  .frow {
    display: grid; grid-template-columns: minmax(0, 42ch) 84px 82px 90px;
    align-items: center; gap: 10px; padding: 3px 16px 3px 38px;
    font-size: var(--text-xs); color: var(--text-faint);
  }
  .fname { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fstate { display: inline-flex; align-items: center; gap: 5px; font-family: var(--font-body); }
  .fstate i { width: 7px; height: 7px; border-radius: 2px; flex: none; }
  .fbytes, .fwhen { text-align: right; }
  @media (max-width: 1100px) {
    .row { grid-template-columns: 7px minmax(0, 1fr) auto; row-gap: 3px; }
    .row-val { grid-area: 2 / 2 / 3 / 3; }
    .row-tx { grid-area: 2 / 3 / 3 / 4; }
    .row-act { grid-area: 1 / 3 / 2 / 4; justify-self: end; }
    .row-val .stat { max-width: none; }
    .phead { grid-template-columns: 22px minmax(90px, 150px) minmax(0, 1fr) 74px 70px; }
  }
  /* Touch tier: row actions reach the 44px floor on a thumb-sized screen. */
  @media (max-width: 760px) {
    header { padding: 6px 12px; gap: 8px; }
    .totals { font-size: var(--text-xs); }
    .dash-toolbar { padding: 6px 12px; gap: 8px; flex-wrap: wrap; }
    .dash-search { width: 100%; height: 44px; }
    .grp { margin-left: 0; }
    .grp button { height: 40px; min-width: 60px; }
    .fchip { height: 40px; }
    .row, .ghead, .srow, .barrow, .slegend, .empty, .more, .joblog { padding-left: 12px; padding-right: 12px; }
    .row .sid { display: none; }
    .act, .cp { height: 44px; min-width: 44px; }
    .row-act .act { min-width: 76px; }
    .phead { grid-template-columns: 30px minmax(0, 1fr) 74px; padding-left: 12px; padding-right: 12px; }
    .phead .sbar-wrap { display: none; }
    .phead .act { grid-column: 2 / 4; justify-self: start; }
    .frow { grid-template-columns: minmax(0, 1fr) 74px; padding-left: 30px; }
    .frow .fwhen { display: none; }
    .tw, .tw svg { width: 30px; }
  }
</style>
</head>
<body>
<div id="shell">
<nav id="nav" aria-label="destinations">
  <a class="brand" href="/dashboard" title="cctrace">${CCTRACE_MARK}<b>cctrace</b></a>
  <a class="runcard" id="selfcard"></a>
  <div class="dests">
    <a class="dest active" id="dash-runs" aria-label="Runs" href="#runs" aria-current="page" title="Runs"><span class="gl">${UI_ICONS.layoutGrid}</span><span class="lb">Runs</span><span class="n" id="dash-runs-count"></span></a>
    <a class="dest" id="dash-store" aria-label="Storage" href="#store" title="Storage"><span class="gl">${UI_ICONS.archive}</span><span class="lb">Storage</span><span class="n" id="dash-store-count"></span></a>
  </div>
  <div class="navfoot"><span class="nav-icons"><span class="ver">${version ? "v" + version : ""}</span><button class="icon-btn" id="theme-toggle" aria-label="Theme" title="Theme">${UI_ICONS.monitor}</button></span></div>
</nav>
<div id="work">
<header>
  <button class="icon-btn" id="nav-toggle" aria-controls="nav" aria-expanded="true" aria-label="Collapse navigation" title="Collapse navigation">${UI_ICONS.panelLeftClose}</button>
  <h1 id="page-title">Runs</h1>
  <span class="totals" id="totals"></span>
  <span class="header-actions"><button class="icon-btn" id="refresh" aria-label="Refresh dashboard" title="Refresh dashboard">${UI_ICONS.refreshCw}</button></span>
</header>
<div class="dash-toolbar" id="runs-toolbar">
  <label class="dash-search">${UI_ICONS.search}<input id="run-filter" type="search" aria-label="Filter runs" placeholder="Filter runs"></label>
  <button class="fchip" id="live-only" aria-pressed="false" title="show only the runs that are live right now"><span class="live-dot"></span>live only<span class="n" id="live-n"></span></button>
  <span class="grp" id="grp" role="group" aria-label="Group runs by">
    <button data-g="project">project</button>
    <button data-g="client">client</button>
    <button data-g="day">day</button>
  </span>
</div>
<main id="dashboard-content">
<section id="runs-section" aria-label="Runs">
<div class="list" id="runs"></div>
</section>
<section id="store-section" aria-label="Storage" hidden>
<div class="sect"><h2>The store</h2><span class="stat" id="store-root"></span></div>
<div class="list" id="store-overview"></div>
<div class="sect"><h2>Projects by size</h2><span class="stat" id="store-projn"></span></div>
<div class="list" id="store-projects"></div>
<div class="sect"><h2>Archive</h2></div>
<div class="list" id="store-plan"></div>
</section>
<div class="note" id="note" role="status"></div>
</main>
</div>
</div>
<script>
  ${NAV_SCRIPT};
  var UI = ${JSON.stringify(UI_ICONS)};
  var ICONS = ${JSON.stringify(CLIENT_ICONS)};
  // The plugins' own wire tables (src/clients) — here for the one thing a
  // dashboard needs from them: how each client writes its name.
  var CLIENT_WIRE = ${JSON.stringify(wireTables())};
  ${clientLabel.toString()}

  var GROUP_STEP = 20;
  var groupBy = localStorage.getItem('cctrace-dash-group') || 'project';
  if (['project', 'client', 'day'].indexOf(groupBy) < 0) groupBy = 'project';
  var lastPast = null;
  var lastLive = null;
  var query = '';
  var liveOnly = false;
  var shown = {};        // group key -> how many rows that group is showing
  var stopping = {};     // run id -> when we asked it to stop
  var selfStopped = false;
  var FORCE_AFTER_MS = 8000;

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
  function plural(n, one) { return n + ' ' + one + (n === 1 ? '' : 's'); }

  // ---- run identity -------------------------------------------------
  // A run is a PROJECT produced by a CLIENT, with one line of what it was
  // about. The project is its directory's name, not its path: the path is
  // the tooltip, and only a name that COLLIDES on this page grows its
  // parent segment (WIP/deva-chore) — disambiguation where it is needed,
  // nowhere else.
  var ambiguous = {};
  function projectParts(i) {
    var full = String(i.projectPath || '');
    var segs = full.split('/').filter(Boolean);
    var base = segs.length ? segs[segs.length - 1] : String(i.project || '(unknown)');
    return { base: base, parent: segs.length > 1 ? segs[segs.length - 2] : '', full: full || base };
  }
  function markAmbiguous(list) {
    var byBase = {};
    ambiguous = {};
    for (var k = 0; k < list.length; k++) {
      var p = projectParts(list[k]);
      if (!byBase[p.base]) byBase[p.base] = {};
      byBase[p.base][p.full] = 1;
    }
    for (var base in byBase) {
      if (Object.keys(byBase[base]).length > 1) ambiguous[base] = 1;
    }
  }
  function clientMark(name) {
    var m = el('span', 'runid-mark');
    var ico = ICONS[name || 'claude'];
    if (ico) m.innerHTML = ico;   // our own asset (src/icons.ts), never wire data
    return m;
  }
  function runIdentity(i) {
    var box = el('span', 'runid');
    var top = el('span', 'runid-top');
    var p = projectParts(i);
    top.appendChild(clientMark(i.client));
    var name = el('span', 'runid-name');
    if (ambiguous[p.base] && p.parent) name.appendChild(el('span', 'runid-parent', p.parent + '/'));
    name.appendChild(document.createTextNode(p.base));
    name.title = p.full;
    top.appendChild(name);
    top.appendChild(el('span', 'runid-client', clientLabel(i.client, CLIENT_WIRE)));
    box.appendChild(top);
    // The generated session title when one exists (cctrace title), else the
    // human's first prompt — the wire-derived identity.
    var line = el('span', 'runid-line', i.title || i.firstPrompt || '');
    line.title = [i.title, i.firstPrompt].filter(Boolean).join(' \\u00b7 ');
    box.appendChild(line);
    return box;
  }

  // ---- the one list -------------------------------------------------
  function isViewer(i) { return i.mode === 'view' || i.mode === 'tail'; }
  function runTime(i) { return (i._live ? i.startedAt : (i.endedAt || i.startedAt)) || ''; }
  function allRuns() {
    var out = [];
    var k;
    for (k = 0; k < (lastLive || []).length; k++) { lastLive[k]._live = true; out.push(lastLive[k]); }
    for (k = 0; k < (lastPast || []).length; k++) { lastPast[k]._live = false; out.push(lastPast[k]); }
    return out;
  }
  function matchesRun(i) {
    if (liveOnly && !i._live) return false;
    if (!query) return true;
    return [i.project, i.projectPath, i.client, clientLabel(i.client, CLIENT_WIRE), i.title, i.firstPrompt, i.sessionId]
      .join(' ').toLowerCase().indexOf(query) !== -1;
  }
  function dayKey(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d)) return 'undated';
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function dayLabel(iso) {
    var key = dayKey(iso);
    if (key === 'undated') return 'undated';
    var now = new Date();
    if (key === dayKey(now.toISOString())) return 'Today';
    if (key === dayKey(new Date(now.getTime() - 86400000).toISOString())) return 'Yesterday';
    return key;
  }
  function groupKey(i) {
    if (groupBy === 'client') return i.client || 'claude';
    if (groupBy === 'project') return i.projectPath || i.project || '(unknown)';
    return dayKey(runTime(i));
  }
  function groupLabel(i) {
    if (groupBy === 'client') return clientLabel(i.client, CLIENT_WIRE);
    if (groupBy === 'project') {
      var p = projectParts(i);
      return ambiguous[p.base] && p.parent ? p.parent + '/' + p.base : p.base;
    }
    return dayLabel(runTime(i));
  }

  function statCluster(i) {
    // size · pairs (msgs) · tokens · cost — whatever the tombstone knows;
    // old tombstones just show less.
    var full = [], compact = [];
    if (i.traceBytes > 0) {
      full.push(bytes(i.traceBytes) + (/\\.(zst|gz)$/.test(i.traceCarrier || i.logFile || '') ? ' on disk (zst)' : ''));
      compact.push(bytes(i.traceBytes));
    }
    if (i.pairs > 0) {
      full.push(plural(i.pairs, 'pair') + (i.messages > 0 ? ' (' + i.messages + ' msg)' : ''));
      compact.push(i.pairs + ' pairs');
    }
    if (i.tokensIn > 0 || i.tokensOut > 0) {
      full.push(tok(i.tokensIn) + ' in / ' + tok(i.tokensOut) + ' out');
      compact.push(tok((i.tokensIn || 0) + (i.tokensOut || 0)) + ' tok');
    }
    if (i.costUsd > 0.005) { full.push('$' + i.costUsd.toFixed(2)); compact.push('$' + i.costUsd.toFixed(2)); }
    if (!compact.length) return null;
    var stat = el('span', 'stat', compact.join(' \\u00b7 '));
    stat.title = full.join(' \\u00b7 ');
    return stat;
  }

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
      b.textContent = 'sending\\u2026';
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

  function copyButton(path) {
    var cp = el('button', 'cp');
    cp.innerHTML = UI.copy;
    cp.setAttribute('aria-label', 'Copy view command');
    cp.title = 'copy: cctrace view ' + path;
    cp.onclick = function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      navigator.clipboard.writeText('cctrace view ' + path).then(function () {
        cp.innerHTML = UI.check; cp.className = 'cp copied';
        setTimeout(function () { cp.innerHTML = UI.copy; cp.className = 'cp'; }, 1200);
      }).catch(function () { cp.title = 'Could not copy view command'; });
    };
    return cp;
  }

  function runRow(i) {
    var live = !!i._live;
    var openable = live || (i.traceExists !== false && i.id);
    var row = el(openable ? 'a' : 'div', 'row' + (i.traceExists === false ? ' gone' : ''));
    row.appendChild(el('span', 'live-dot' + (live ? '' : ' past')));
    row.appendChild(runIdentity(i));
    // val travels with the identity; tx (clock, port) holds the right edge.
    var meta = el('span', 'runid-meta row-val');
    var tx = el('span', 'runid-meta row-tx');
    var act = el('span', 'row-act');
    if (i.sessionId) meta.appendChild(el('span', 'sid', String(i.sessionId).slice(0, 8)));
    if (live) {
      if (i.self) meta.appendChild(el('span', 'self', 'this server'));
      if (isViewer(i)) meta.appendChild(el('span', 'tag', 'viewer'));
      tx.appendChild(el('span', 'when', hm(i.startedAt)));
      tx.appendChild(el('span', 'port', ':' + i.port));
      // The sibling's TRACE view — its root would redirect back to a dashboard.
      row.href = 'http://' + location.hostname + ':' + Number(i.port) + '/trace';
      var asked = i.id ? stopping[i.id] : 0;
      if (asked) act.appendChild(el('span', 'pending', 'stopping\\u2026'));
      if (i.id) act.appendChild(stopButton(i, asked && Date.now() - asked > FORCE_AFTER_MS));
      row.title = projectParts(i).full +
        (i.mode ? '\\n' + i.mode : '') +
        (i.logFile ? '\\n' + i.logFile : '') +
        (i.pid ? '\\ncctrace pid ' + i.pid + (i.agentPid ? ' \\u00b7 agent pid ' + i.agentPid : '') : '');
    } else {
      var stat = statCluster(i);
      if (stat) meta.appendChild(stat);
      tx.appendChild(el('span', 'when', hm(i.endedAt)));
      var tracePath = i.traceCarrier || i.logFile;
      if (openable) {
        row.href = '/view/' + encodeURIComponent(i.id);
        row.target = '_blank';
        row.rel = 'noopener';
      } else {
        meta.appendChild(el('span', 'tag', 'trace missing'));
      }
      if (tracePath && openable) act.appendChild(copyButton(tracePath));
      row.title = projectParts(i).full + (tracePath ? '\\n' + tracePath : '');
    }
    row.appendChild(meta);
    row.appendChild(tx);
    row.appendChild(act);
    return row;
  }

  function skeleton(box, n) {
    box.textContent = '';
    for (var k = 0; k < n; k++) {
      var s = el('div', 'sk');
      s.appendChild(el('i', 's1'));
      s.appendChild(el('i', 's2'));
      s.appendChild(el('i', 's3'));
      box.appendChild(s);
    }
  }

  function paintTotals() {
    var live = (lastLive || []).length, past = (lastPast || []).length;
    document.getElementById('totals').textContent = live + ' live \\u00b7 ' + plural(past, 'recorded run');
    document.getElementById('dash-runs-count').textContent = String(live + past);
    document.getElementById('live-n').textContent = String(live);
  }

  function renderRuns() {
    var box = document.getElementById('runs');
    if (lastLive === null && lastPast === null) return skeleton(box, 8);
    paintTotals();
    var all = allRuns();
    markAmbiguous(all);
    box.textContent = '';
    if (!all.length) {
      box.appendChild(el('div', 'empty', selfStopped
        ? 'no live instances — this server stopped too'
        : 'no runs in the registry (live runs and the last 30 days)'));
      return;
    }
    // newest first everywhere; the grouping only decides the sections, and
    // a live run always heads its own group.
    var list = all.filter(matchesRun).sort(function (a, b) {
      return String(runTime(b)).localeCompare(String(runTime(a)));
    });
    if (!list.length) {
      box.appendChild(el('div', 'empty', liveOnly && !query ? 'nothing is live right now' : 'no runs match this filter'));
      return;
    }
    var groups = [], byKey = Object.create(null);
    for (var k = 0; k < list.length; k++) {
      var key = groupKey(list[k]);
      if (!byKey[key]) { byKey[key] = { key: key, label: groupLabel(list[k]), items: [] }; groups.push(byKey[key]); }
      byKey[key].items.push(list[k]);
    }
    for (var g = 0; g < groups.length; g++) {
      var grp = groups[g];
      grp.items.sort(function (a, b) {
        if (!a._live !== !b._live) return a._live ? -1 : 1;
        return String(runTime(b)).localeCompare(String(runTime(a)));
      });
      var liveN = grp.items.filter(function (i) { return i._live; }).length;
      var gh = el('div', 'ghead', grp.label);
      if (liveN) gh.appendChild(el('span', 'live-dot'));
      gh.appendChild(el('span', 'gn', plural(grp.items.length, 'run')));
      box.appendChild(gh);
      // Paging is per GROUP: one busy project must not spend the whole page.
      var cap = shown[grp.key] || GROUP_STEP;
      for (var m = 0; m < grp.items.length && m < cap; m++) box.appendChild(runRow(grp.items[m]));
      if (grp.items.length > cap) {
        var hidden = grp.items.length - cap;
        var more = el('button', 'more', 'show ' + Math.min(GROUP_STEP, hidden) + ' more (' + hidden + ' hidden)');
        more.dataset.key = grp.key;
        more.onclick = function (ev) {
          var k2 = ev.currentTarget.dataset.key;
          shown[k2] = (shown[k2] || GROUP_STEP) + GROUP_STEP;
          renderRuns();
        };
        box.appendChild(more);
      }
    }
  }

  // ---- the rail's run card: what this server IS ----------------------
  // A live capture says "This run" with the live dot; a cctrace view server
  // says "Viewing" and names the trace. Either way the card links to the
  // trace this server holds — the destination that used to be a nameless
  // "Current trace" row.
  function renderSelf(me) {
    var card = document.getElementById('selfcard');
    card.textContent = '';
    var known = me && (me.projectPath || me.project || me.logFile);
    if (!known) {
      card.className = 'runcard';
      card.removeAttribute('href');
      card.appendChild(el('span', 'rc-kind', 'All runs'));
      card.appendChild(el('span', 'ctx-title', 'every run sharing this data dir'));
      return;
    }
    var viewer = isViewer(me);
    card.className = 'runcard';
    card.setAttribute('href', '/trace');
    var kind = el('span', 'rc-kind', viewer ? 'Viewing' : 'This run');
    kind.appendChild(el('span', 'status ' + (viewer ? 'snapshot' : 'connected')));
    card.appendChild(kind);
    card.appendChild(runIdentity(me));
    if (viewer && me.logFile) {
      var trace = el('span', 'rc-trace', String(me.logFile).split('/').pop());
      trace.title = me.logFile;
      card.appendChild(trace);
    }
    var meta = el('span', 'runid-meta');
    if (me.sessionId) meta.appendChild(el('span', 'sid', String(me.sessionId).slice(0, 8)));
    if (me.port) meta.appendChild(el('span', 'port', ':' + me.port));
    if (meta.childNodes.length) card.appendChild(meta);
  }

  // ---- store: the picture, and the job that changes it ---------------
  //
  // The page shows what /api/store measured (states, plan and totals) and,
  // while an archive runs, that job's own output. It never estimates: the
  // button triggers cctrace compress server-side and the numbers come back
  // from a re-measure.
  var STATE_ORDER = ['zst', 'live', 'gz', 'plain'];
  var STATE_LABEL = { zst: 'archived', live: 'held by a live run', gz: 'legacy gz', plain: 'plain' };
  var jobLogOpen = false;
  var lastJobId = '';
  var archiving = false;
  var lastStore = null;
  var openDirs = {};

  function stateSum(st) { return (st.plain || 0) + (st.zst || 0) + (st.gz || 0) + (st.live || 0); }
  function stackBar(states, scale) {
    var bar = el('span', 'sbar');
    var total = scale || stateSum(states);
    for (var k = 0; k < STATE_ORDER.length; k++) {
      var s = STATE_ORDER[k], v = states[s] || 0;
      if (!v || total <= 0) continue;
      var seg = el('i', 's-' + s);
      seg.style.width = ((v / total) * 100).toFixed(3) + '%';
      seg.title = STATE_LABEL[s] + ': ' + bytes(v);
      bar.appendChild(seg);
    }
    return bar;
  }
  function legend(states) {
    var box = el('div', 'slegend');
    for (var k = 0; k < STATE_ORDER.length; k++) {
      var s = STATE_ORDER[k], v = states[s] || 0;
      if (!v) continue;
      var it = el('span', 'it');
      it.appendChild(el('i', 's-' + s));
      it.appendChild(document.createTextNode(STATE_LABEL[s]));
      it.appendChild(el('b', null, bytes(v)));
      box.appendChild(it);
    }
    return box;
  }
  function projectNameOf(dir) {
    var dirs = (lastStore && lastStore.dirs) || [];
    for (var k = 0; k < dirs.length; k++) {
      if (dirs[k].dir === dir) return (dirs[k].project || dir).split('/').pop() || dir;
    }
    return String(dir).split('/').pop();
  }
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
  // What a finished job did, from the store measured before and after — not
  // from its log, whose last line is usually about the last dir it walked
  // rather than the run as a whole.
  function jobSummary(job) {
    if (job.state === 'running') return job.lines.length ? job.lines[job.lines.length - 1] : job.command;
    if (job.error) return job.error;
    if (!job.after) return job.command;
    var n = job.before.plain - job.after.plain;
    var saved = job.before.bytes - job.after.bytes;
    if (n <= 0) return 'nothing to archive — the store was already at rest';
    return 'archived ' + plural(n, 'trace') + ' \\u00b7 ' +
      bytes(job.before.bytes) + ' \\u2192 ' + bytes(job.after.bytes) + ' on disk' +
      (saved > 0 ? ' \\u00b7 saved ' + bytes(saved) : '');
  }
  function jobRow(job) {
    var r = el('div', 'srow jobrow');
    r.appendChild(el('span', 'jstate ' + job.state, job.state));
    // A one-project job says whose project it is, in the name the chart uses
    // (the store key it archives under is not a name anybody reads).
    if (job.dir) r.appendChild(el('span', 'lead', projectNameOf(job.dir)));
    r.appendChild(el('span', 'fill', jobSummary(job)));
    if (job.state === 'running') {
      r.appendChild(el('span', 'jstat', since(job.startedAt)));
      var cancel = el('button', 'act', 'cancel');
      cancel.title = 'stop the archive between files — nothing half-written survives';
      cancel.onclick = function () { cancel.disabled = true; archiveRequest({ cancel: true }); };
      r.appendChild(cancel);
    } else if (job.endedAt) {
      r.appendChild(el('span', 'jstat', 'took ' + Math.max(1, Math.round((job.endedAt - job.startedAt) / 1000)) + 's'));
    }
    if (job.lines.length) {
      var tog = el('button', 'act', jobLogOpen ? 'hide output' : 'output');
      tog.onclick = function () { jobLogOpen = !jobLogOpen; renderStore(lastStore, job); };
      r.appendChild(tog);
    }
    return r;
  }
  function fileRow(f) {
    var r = el('div', 'frow');
    r.appendChild(el('span', 'fname', f.name));
    var st = el('span', 'fstate');
    st.appendChild(el('i', 's-' + f.state));
    st.appendChild(document.createTextNode(STATE_LABEL[f.state] === 'held by a live run' ? 'live' : STATE_LABEL[f.state]));
    r.appendChild(st);
    r.appendChild(el('span', 'fbytes', bytes(f.bytes) || '0 B'));
    r.appendChild(el('span', 'fwhen', hm(new Date(f.mtimeMs).toISOString())));
    return r;
  }
  function projectRow(d, scale) {
    var wrap = el('div', 'prow');
    var head = el('div', 'phead');
    var open = !!openDirs[d.dir];
    var dirFiles = d.files || [];
    var tw = el('button', 'tw');
    tw.innerHTML = UI.chevronRight;
    tw.setAttribute('aria-expanded', String(open));
    tw.setAttribute('aria-label', (open ? 'Hide' : 'Show') + ' files in ' + (d.project || d.dir));
    head.appendChild(tw);
    var name = el('span', 'pname', (d.project || d.dir).split('/').pop() || d.dir);
    name.title = (d.project || '(no project marker)') + '\\n' + d.dir + '\\n' + plural(d.traces, 'trace');
    head.appendChild(name);
    var states = d.states || {};
    var barWrap = el('span', 'sbar-wrap');
    barWrap.appendChild(stackBar(states, scale));
    head.appendChild(barWrap);
    head.appendChild(el('span', 'pbytes', bytes(d.bytes) || '0 B'));
    var work = (states.plain || 0) + (states.gz || 0);
    if (work > 0 && !archiving) {
      var go = el('button', 'act', 'archive');
      go.title = 'runs cctrace compress --dir ' + d.dir + ' --yes: ' + bytes(work) + ' of this project goes to .zst';
      go.onclick = function (ev) {
        ev.stopPropagation();
        go.disabled = true; go.textContent = 'starting\\u2026';
        archiveRequest({ dir: d.dir });
      };
      head.appendChild(go);
    } else {
      head.appendChild(el('span'));
    }
    var files = el('div', 'pfiles');
    files.hidden = !open;
    var toggle = function () {
      openDirs[d.dir] = !openDirs[d.dir];
      files.hidden = !openDirs[d.dir];
      tw.setAttribute('aria-expanded', String(!!openDirs[d.dir]));
    };
    tw.onclick = function (ev) { ev.stopPropagation(); toggle(); };
    head.onclick = toggle;
    for (var k = 0; k < dirFiles.length; k++) files.appendChild(fileRow(dirFiles[k]));
    if (!dirFiles.length) files.appendChild(el('div', 'empty', 'no trace files'));
    else if (d.moreFiles > 0) files.appendChild(el('div', 'empty', plural(d.moreFiles, 'smaller file') + ' not listed'));
    wrap.appendChild(head);
    wrap.appendChild(files);
    return wrap;
  }

  function renderStore(s, job) {
    var overview = document.getElementById('store-overview');
    var projects = document.getElementById('store-projects');
    var plan = document.getElementById('store-plan');
    if (s === undefined) return skeleton(overview, 3);
    lastStore = s;
    overview.textContent = '';
    projects.textContent = '';
    plan.textContent = '';
    document.getElementById('store-root').textContent = s ? s.root : '';
    document.getElementById('dash-store-count').textContent = s ? String(s.projects) : '';
    document.getElementById('store-projn').textContent = s ? plural(s.projects, 'project') : '';
    if (!s) { overview.appendChild(el('div', 'empty', 'no store on this server')); return; }
    job = job !== undefined ? job : s.job;
    archiving = !!(job && job.state === 'running');

    // (1) the whole store in one line and one bar
    overview.appendChild(srow(
      el('span', 'lead', bytes(s.bytes) || '0 B'),
      el('span', 'fill', plural(s.traces, 'trace') + ' across ' + plural(s.projects, 'project'))
    ));
    var bar = el('div', 'barrow');
    bar.appendChild(stackBar(s.states || {}));
    overview.appendChild(bar);
    overview.appendChild(legend(s.states || {}));

    // (2) where the weight is, biggest project first
    var scale = 0;
    for (var k = 0; k < s.dirs.length; k++) scale = Math.max(scale, s.dirs[k].bytes);
    scale = Math.max(scale, s.rest ? s.rest.bytes : 0);
    for (var d = 0; d < s.dirs.length; d++) projects.appendChild(projectRow(s.dirs[d], scale));
    if (s.rest && s.rest.projects > 0) {
      var rest = el('div', 'prow');
      var rhead = el('div', 'phead');
      rhead.appendChild(el('span'));
      rhead.appendChild(el('span', 'pname', plural(s.rest.projects, 'smaller project')));
      var rw = el('span', 'sbar-wrap');
      rw.appendChild(stackBar(s.rest.states, scale));
      rhead.appendChild(rw);
      rhead.appendChild(el('span', 'pbytes', bytes(s.rest.bytes) || '0 B'));
      rhead.appendChild(el('span'));
      rest.appendChild(rhead);
      projects.appendChild(rest);
    }
    if (!s.dirs.length) projects.appendChild(el('div', 'empty', 'no traces in the store yet'));

    // (3) the plan, and the one button that runs it
    // A live run's trace is NOT work: it can't be archived while it's being
    // written, so it never justifies the button — it only explains a number.
    var held = s.liveHeld > 0 ? plural(s.liveHeld, 'trace') + ' held by a live run' : '';
    var pending = [];
    if (s.plain > 0) pending.push(plural(s.plain, 'plain trace') + ' \\u00b7 ' + bytes(s.plainBytes));
    if (s.upgrades > 0) pending.push(s.upgrades + ' legacy .gz to re-encode');
    if (s.staleSeals > 0) pending.push(plural(s.staleSeals, 'interrupted exit seal'));
    if (held) pending.push(held);

    if (s.plain > 0 || s.upgrades > 0 || s.staleSeals > 0) {
      var r = srow(el('span', 'lead', 'not archived'), el('span', 'fill', pending.join(' \\u00b7 ')));
      if (!archiving) {
        var goAll = el('button', 'act go', 'archive now');
        goAll.title = 'runs cctrace compress --all --yes: zstd at rest (40-90x), each archive verified before its original is removed';
        goAll.onclick = function () { goAll.disabled = true; goAll.textContent = 'starting\\u2026'; archiveRequest({}); };
        r.appendChild(goAll);
      }
      plan.appendChild(r);
    } else {
      plan.appendChild(srow(
        el('span', 'lead', 'at rest'),
        el('span', 'fill', 'every trace is archived as .zst' + (held ? ' \\u00b7 ' + held : ''))
      ));
    }

    if (job) {
      if (job.id !== lastJobId) { lastJobId = job.id; jobLogOpen = job.state === 'running'; }
      plan.appendChild(jobRow(job));
      if (jobLogOpen && job.lines.length) {
        var pre = el('pre', 'joblog', (job.dropped ? '\\u2026 ' + job.dropped + ' earlier line(s) dropped\\n' : '') + job.lines.join('\\n'));
        plan.appendChild(pre);
        pre.scrollTop = pre.scrollHeight;
      }
      if (job.error) plan.appendChild(srow(el('span', 'lead', 'error'), el('span', 'fill', job.error)));
    }
  }
  var storeTimer = null;
  function pollStore() {
    clearTimeout(storeTimer);
    fetch('/api/store').then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) { renderStore(s); })
      .catch(function () { /* keep the last picture */ })
      .then(function () {
        // A running job is worth watching closely; an idle store is not.
        storeTimer = setTimeout(pollStore, archiving ? 2000 : 15000);
      });
  }

  // ---- routing, controls, refresh ------------------------------------
  function dashboardRoute() {
    var storage = location.hash === '#store';
    document.getElementById('runs-section').hidden = storage;
    document.getElementById('runs-toolbar').hidden = storage;
    document.getElementById('store-section').hidden = !storage;
    document.getElementById('page-title').textContent = storage ? 'Storage' : 'Runs';
    document.getElementById('totals').hidden = storage;
    for (var key of ['runs', 'store']) {
      var a = document.getElementById('dash-' + key);
      var active = (key === 'store') === storage;
      a.classList.toggle('active', active);
      if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
  }
  window.addEventListener('hashchange', dashboardRoute);
  dashboardRoute();

  var themeButton = document.getElementById('theme-toggle');
  function themePaint(pref) {
    if (pref === 'light' || pref === 'dark') document.documentElement.setAttribute('data-theme', pref);
    else document.documentElement.removeAttribute('data-theme');
    themeButton.innerHTML = pref === 'light' ? UI.sun : pref === 'dark' ? UI.moon : UI.monitor;
    themeButton.title = 'Theme: ' + pref;
    themeButton.setAttribute('aria-label', themeButton.title);
  }
  themePaint(localStorage.getItem('cctrace-theme') || 'system');
  themeButton.onclick = function () {
    var order = ['system', 'light', 'dark'];
    var next = order[(order.indexOf(localStorage.getItem('cctrace-theme') || 'system') + 1) % 3];
    localStorage.setItem('cctrace-theme', next);
    themePaint(next);
  };
  document.getElementById('run-filter').oninput = function (ev) {
    query = ev.target.value.trim().toLowerCase();
    shown = {};
    renderRuns();
  };
  var liveChip = document.getElementById('live-only');
  liveChip.onclick = function () {
    liveOnly = !liveOnly;
    liveChip.setAttribute('aria-pressed', String(liveOnly));
    shown = {};
    renderRuns();
  };
  var grp = document.getElementById('grp');
  function paintGrp() {
    var bs = grp.querySelectorAll('button');
    for (var k = 0; k < bs.length; k++) {
      var active = bs[k].dataset.g === groupBy;
      bs[k].className = active ? 'active' : '';
      bs[k].setAttribute('aria-pressed', String(active));
    }
  }
  grp.onclick = function (ev) {
    var g = ev.target && ev.target.dataset && ev.target.dataset.g;
    if (!g) return;
    groupBy = g;
    localStorage.setItem('cctrace-dash-group', g);
    paintGrp();
    shown = {};
    renderRuns();
  };
  paintGrp();

  function refresh() {
    var button = document.getElementById('refresh');
    if (button.disabled) return;
    button.disabled = true;
    function read(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); }); }
    // /api/self answers from memory — this server's own identity for the
    // rail card. It must never fail the run listing, so it is optional.
    read('/api/self').then(renderSelf, function () {});
    Promise.all([read('/api/instances'), read('/api/runs')]).then(function (data) {
      lastLive = data[0];
      lastPast = data[1];
      // A run that left the list has stopped — forget the pending mark.
      for (var id in stopping) {
        if (!lastLive.some(function (i) { return i.id === id; })) delete stopping[id];
      }
      renderRuns();
      var note = document.getElementById('note');
      note.className = 'note';
      note.textContent = '';
    }).catch(function () {
      // The server that served this page is gone — say so instead of quietly
      // showing a frozen picture (stopping THIS instance does exactly that).
      // The last good picture stays on screen; only the note changes.
      var n = document.getElementById('note');
      n.textContent = selfStopped
        ? 'this server was stopped from here — open the dashboard from another live instance'
        : 'not reaching this dashboard server — showing the last picture it sent';
      n.className = 'note stale';
    }).finally(function () { button.disabled = false; });
  }
  document.getElementById('refresh').onclick = function () { refresh(); pollStore(); };
  renderRuns();
  renderStore(undefined);
  refresh();
  pollStore();
  setInterval(refresh, 15000);
</script>
</body>
</html>`;
}
