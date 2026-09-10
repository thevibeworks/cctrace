import { UI_ICONS } from "./vendor/ui-icons";

// Shared material and navigation for trace and dashboard pages.
export const CHROME_CSS = `
    /* ---- The material: the Claude Design System, adopted ----
       cctrace traces Claude Code, so it reads as part of the same product.
       Nothing here is invented: every value was MEASURED off claude.ai on
       2026-09-02 (769 --cds-* custom properties resolved in the live page,
       both themes) — palette, geometry, type ramp. The names below are
       cctrace's own; the CDS token behind each value is on the line.
       What CDS leaves undecided is decided here and marked "ours": row
       density inside the system's range, and the data colors a wire tracer
       needs. Provenance and the rules: docs/design/ui.md. */
    :root {
      color-scheme: dark;
      --bg: #0b0b0b;                        /* --cds-page-bg   */
      --bg-surface: #151515;                /* --cds-surface-1 */
      --surface-2: #1a1a19;                 /* --cds-surface-2 */
      --overlay: #20201f;                   /* --cds-surface-3 */
      --text: #f0efec;                      /* --cds-text-primary   */
      --text-muted: #c3c2b7;                /* --cds-text-secondary */
      --text-faint: rgba(240,239,236,0.62);
      --border: rgba(255,255,255,0.10);     /* --cds-border        */
      --border-strong: rgba(255,255,255,0.20); /* --cds-border-strong */
      /* Clay is IDENTITY and the one primary action on a screen; blue is
         "this is interactive / this is selected". CDS keeps them apart and
         so do we — a page that paints its buttons orange is not this
         system. */
      --clay: #d97757;                      /* --cds-clay       */
      --clay-strong: #c6613f;               /* --cds-fill-brand */
      --clay-text: #d97757;                 /* clay as TEXT: its own step (light darkens it) */
      --accent: #6da7ec;                    /* --cds-text-accent   dark */
      --accent-hover: #86b6ef;
      --accent-soft: #032042;               /* --cds-bg-accent     dark */
      --accent-line: #184f95;               /* --cds-border-accent */
      --accent-fg: #0b0b0b;
      --text-method: #6da7ec;
      /* State: CDS ships these as fills, so text gets its own step. */
      --green: #4cc46a; --green-soft: #11260f;   /* --cds-bg-success dark */
      --red: #ec7e7e;   --red-soft: #3c0e0e;     /* --cds-text-danger / --cds-bg-danger dark */
      --red-line: #8e2626;                       /* --cds-border-danger */
      --amber: #cba43c; --amber-soft: #311a00;   /* --cds-bg-warning dark */
      --purple: #a78bea;
      --btn-bg: #1a1a19; --hover: #20201f;
      /* Where wall-clock went: model / tools / waiting / subagents. One
         wire fact, one hue, wherever it is drawn — the context overview's
         time track and the trajectory bar's lanes. Deliberately
         theme-independent (these are data colors, not chrome) and taken
         from the six hues CDS already ships for git status, so a cctrace
         lane and a Claude Code diff badge are the same six inks. */
      --lane-model: #4a8fdb; --lane-tools: #1baf7a; --lane-waiting: #c39b2b;
      --lane-agents: #8e6bd9; --lane-extra: #c5621b; --lane-idle: #737373;
      --lane-ink: #0b0b0b;   /* text ON a lane span: the hues never flip, so neither does the ink */
      /* Where the money went: the four billed components, cheap to
         expensive. One sequential ramp off the brand ink — never six
         categorical hues, so the cost track cannot read as a second
         composition track. */
      --cost-read: color-mix(in srgb, #d97757 30%, #0b0b0b);
      --cost-write: color-mix(in srgb, #d97757 50%, #0b0b0b);
      --cost-input: color-mix(in srgb, #d97757 72%, #0b0b0b);
      --cost-output: #d97757;
      /* What a byte in the trace store is doing: at rest, held by a live
         run, a legacy .gz, or still plain. One ramp off the same ink,
         ordered by distance from rest — the store in four states is ONE
         thing, so it never gets four categorical hues. */
      --store-zst: color-mix(in srgb, #d97757 26%, #0b0b0b);
      --store-live: color-mix(in srgb, #d97757 46%, #0b0b0b);
      --store-gz: color-mix(in srgb, #d97757 68%, #0b0b0b);
      --store-plain: #d97757;
      /* Faces. anthropic-sans / anthropic-mono are licensed and not ours to
         ship, so the stack is CDS's own declared fallback chain. Mono
         appears only where wire characters matter: urls, ids, numbers,
         payloads. */
      --font-body: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace;
      /* Type: the CDS ramp, six sizes, weights 400/500/600 (measured: CDS
         controls are 400, not 600). */
      --text-xs: 11px;      /* --cds-font-size-caption--xs */
      --text-sm: 12px;      /* --cds-font-size-caption     */
      --text-code: 13px;    /* --cds-font-size-code        */
      --text-body: 14px;    /* --cds-font-size-body        */
      --text-heading: 15px; /* --cds-font-size-heading     */
      --text-title: 22px;   /* --cds-font-size-title       */
      /* Geometry, measured: a CDS button is 32px tall with an 8px radius;
         the checkbox radius is 5px; panels 12px. */
      --radius: 8px; --radius-sm: 5px; --radius-lg: 12px; --radius-full: 999px;
      --control-h: 32px;
      --row-h: 26px;        /* ours: density inside the system's range — an
                               operator surface reads 38 rows per 1000px */
      --shadow-1: 0 1px 2px 0 rgba(0,0,0,0.40), 0 2px 8px 0 rgba(0,0,0,0.30);
      --shadow-2: 0 2px 6px 0 rgba(0,0,0,0.45), 0 8px 20px 0 rgba(0,0,0,0.35);
      --dur-micro: 100ms; --dur-base: 180ms;
      --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
      --nav: 208px;
    }
    @media (prefers-color-scheme: light) {
      :root:not([data-theme="dark"]) {
        color-scheme: light;
        --bg: #fcfcfb; --bg-surface: #f9f9f7; --surface-2: #fff; --overlay: #fff;
        --text: #0b0b0b; --text-muted: #52514e; --text-faint: rgba(11,11,11,0.58);
        --border: rgba(11,11,11,0.10); --border-strong: rgba(11,11,11,0.20);
        --accent: #184f95; --accent-hover: #2a78d6; --accent-soft: #cde2fb;
        --accent-line: #86b6ef; --accent-fg: #fcfcfb; --text-method: #184f95;
        --clay-text: color-mix(in srgb, #c6613f 80%, #0b0b0b);
        /* CDS ships success and warning as FILL hues. As text they need
           their own step, and the floor that binds is the text ON its own
           soft ground (a 200 tag, a warn chip), not on paper: green at 78%
           reads 3.95:1 on --green-soft and gold at 100% reads 4.08:1 on
           --amber-soft. Measured with kit/render-check.mjs. */
        --green: color-mix(in srgb, #1e9e3c 65%, #0b0b0b); --green-soft: #caeac7;
        --red: #8e2626; --red-soft: #fad6d6; --red-line: #f09595;
        --amber: color-mix(in srgb, #98801f 70%, #0b0b0b); --amber-soft: #f9dca4;
        --purple: color-mix(in srgb, #8e6bd9 72%, #0b0b0b);
        --btn-bg: #fff; --hover: #f9f9f7;
        --cost-read: color-mix(in srgb, #d97757 28%, #fcfcfb);
        --cost-write: color-mix(in srgb, #d97757 52%, #fcfcfb);
        --cost-input: color-mix(in srgb, #d97757 76%, #fcfcfb);
        --cost-output: #c6613f;
        --store-zst: color-mix(in srgb, #d97757 26%, #fcfcfb);
        --store-live: color-mix(in srgb, #d97757 48%, #fcfcfb);
        --store-gz: color-mix(in srgb, #d97757 70%, #fcfcfb);
        --store-plain: #c6613f;
        --shadow-1: 0 1px 2px 0 rgba(11,11,11,0.06), 0 2px 8px 0 rgba(11,11,11,0.08);
        --shadow-2: 0 2px 4px 0 rgba(11,11,11,0.07), 0 6px 16px 0 rgba(11,11,11,0.08);
      }
    }
    [data-theme="light"] {
      color-scheme: light;
      --bg: #fcfcfb; --bg-surface: #f9f9f7; --surface-2: #fff; --overlay: #fff;
      --text: #0b0b0b; --text-muted: #52514e; --text-faint: rgba(11,11,11,0.58);
      --border: rgba(11,11,11,0.10); --border-strong: rgba(11,11,11,0.20);
      --accent: #184f95; --accent-hover: #2a78d6; --accent-soft: #cde2fb;
      --accent-line: #86b6ef; --accent-fg: #fcfcfb; --text-method: #184f95;
      --clay-text: color-mix(in srgb, #c6613f 80%, #0b0b0b);
      --green: color-mix(in srgb, #1e9e3c 65%, #0b0b0b); --green-soft: #caeac7;
      --red: #8e2626; --red-soft: #fad6d6; --red-line: #f09595;
      --amber: color-mix(in srgb, #98801f 70%, #0b0b0b); --amber-soft: #f9dca4;
      --purple: color-mix(in srgb, #8e6bd9 72%, #0b0b0b);
      --btn-bg: #fff; --hover: #f9f9f7;
      --cost-read: color-mix(in srgb, #d97757 28%, #fcfcfb);
      --cost-write: color-mix(in srgb, #d97757 52%, #fcfcfb);
      --cost-input: color-mix(in srgb, #d97757 76%, #fcfcfb);
      --cost-output: #c6613f;
      --store-zst: color-mix(in srgb, #d97757 26%, #fcfcfb);
      --store-live: color-mix(in srgb, #d97757 48%, #fcfcfb);
      --store-gz: color-mix(in srgb, #d97757 70%, #fcfcfb);
      --store-plain: #c6613f;
      --shadow-1: 0 1px 2px 0 rgba(11,11,11,0.06), 0 2px 8px 0 rgba(11,11,11,0.08);
      --shadow-2: 0 2px 4px 0 rgba(11,11,11,0.07), 0 6px 16px 0 rgba(11,11,11,0.08);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    /* Chrome-quality details: quiet scrollbars, accent selection, visible
       keyboard focus. The UI should feel like a well-kept terminal. */
    :root { scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
    ::-webkit-scrollbar { width: 10px; height: 10px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb {
      background: var(--border); border-radius: var(--radius-sm);
      border: 2px solid transparent; background-clip: padding-box;
    }
    ::-webkit-scrollbar-thumb:hover { background-color: var(--text-faint); }
    ::selection { background: color-mix(in srgb, var(--accent) 30%, transparent); }
    :focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }
    /* ---- The shell: rail | work ---- */
    #shell { display: flex; height: 100%; min-height: 0; }
    #work {
      flex: 1; min-width: 0; display: flex; flex-direction: column;
      background: var(--bg); min-height: 0;
    }
    /* ---- The destination rail ---- */
    #nav {
      flex: 0 0 var(--nav); width: var(--nav);
      display: flex; flex-direction: column; gap: 14px;
      padding: 12px; min-height: 0;
      border-right: 1px solid var(--border);
      background: var(--bg-surface);
    }
    #nav .brand {
      display: flex; align-items: center; gap: 8px;
      padding: 4px; color: var(--text); text-decoration: none;
    }
    #nav .brand b { font-size: var(--text-heading); font-weight: 600; letter-spacing: 0; }
    .logo { width: 22px; height: 22px; color: var(--clay); flex-shrink: 0; }
    /* The run card: what am I looking at. Client, trace, session id, and
       whether this page is live — the identity that used to sit in a strip
       above the content. */
    .runcard {
      border: 1px solid var(--border); border-radius: var(--radius);
      background: var(--surface-2); padding: 7px 9px;
      display: grid; gap: 3px; min-width: 0;
    }
    .ctx { display: grid; gap: 3px; min-width: 0; font-size: var(--text-sm); color: var(--text-muted); }
    .ctx-sep { display: none; }
    .ctx-proj { color: var(--text); font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* The trace title copies its path (into the store, or project-relative
       for a legacy trace) — the string you paste into "cctrace view" or
       hand to an agent. */
    .ctx-proj.ctx-copy { cursor: pointer; }
    .ctx-proj.ctx-copy:hover { color: var(--accent); }
    .ctx-proj.copied { color: var(--green); }
    .ctx-title { color: var(--text-muted); font-size: var(--text-xs); font-style: italic; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ctx-client {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: var(--text-sm); color: var(--text-muted); min-width: 0;
    }
    .ctx-client svg { width: 13px; height: 13px; flex-shrink: 0; }
    .ctx-sess {
      font: inherit; font-family: var(--font-mono); font-size: var(--text-xs);
      color: var(--text-faint); cursor: pointer; justify-self: start;
      background: none; border: none; padding: 0; text-align: left;
    }
    .ctx-sess:hover { color: var(--accent); }
    .ctx-sess.copied { color: var(--green); }
    /* ---- The run identity: one grammar wherever a run is named ----
       A run is a PROJECT (the name a human says out loud, in the reading
       face) produced by a CLIENT, with one line of what it was about (its
       generated title, else the human's first prompt) and its wire meta in
       mono. The dashboard's rows and the rails' run cards are that same
       block at two widths — nothing that names a run invents its own
       layout, and the project stops being a path fragment set in mono. */
    .runid { display: grid; gap: 1px; min-width: 0; }
    .runid-top { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
    .runid-mark { display: flex; align-self: center; width: 16px; height: 16px; flex: none; }
    .runid-mark svg, .runid-mark img { width: 16px; height: 16px; }
    .runid-name {
      font-size: var(--text-body); font-weight: 500; color: var(--text);
      min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* Two projects can share a basename; the parent segment disambiguates
       without promoting the whole path to the name. */
    .runid-parent { color: var(--text-faint); font-weight: 400; }
    .runid-client { flex: none; font-size: var(--text-sm); color: var(--text-faint); }
    .runid-line {
      font-size: var(--text-sm); color: var(--text-muted);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .runid-line:empty { display: none; }
    .runid-meta {
      display: flex; align-items: center; gap: 10px; min-width: 0;
      font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--text-xs); color: var(--text-faint);
    }
    /* Live is a STATE, not a section: one dot, the same one, wherever a run
       appears. It heartbeats only while the run is live. */
    .live-dot { width: 7px; height: 7px; border-radius: var(--radius-full); background: var(--green); flex: none; }
    .live-dot.past { background: var(--border-strong); }
    .status { font-size: var(--text-xs); color: var(--text-muted); display: inline-flex; align-items: center; gap: 6px; }
    .status::before { content: ''; width: 6px; height: 6px; border-radius: var(--radius-full); background: currentColor; flex-shrink: 0; }
    .status.connected { color: var(--green); }
    .status.connected::before { animation: heartbeat 2.4s ease-in-out infinite; }
    .status.disconnected { color: var(--red); }
    .status.snapshot { color: var(--text-faint); }
    @keyframes heartbeat { 50% { opacity: 0.3; } }
    @media (prefers-reduced-motion: reduce) {
      .status.connected::before { animation: none; }
    }
    /* Destinations: one row each, the count on the right. */
    .dests { display: grid; gap: 2px; align-content: start; }
    .dest {
      display: flex; align-items: center; gap: 8px;
      height: var(--control-h); padding: 0 8px;
      border: 0; border-radius: var(--radius); background: transparent;
      color: var(--text-muted); font: inherit; font-size: var(--text-body);
      text-align: left; text-decoration: none; cursor: pointer;
      transition: background var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out);
    }
    .dest:hover { background: var(--surface-2); color: var(--text); }
    .dest.active {
      background: var(--surface-2); color: var(--text); font-weight: 500;
      box-shadow: inset 0 0 0 1px var(--border);
    }
    .dest .gl { display: flex; width: 16px; height: 16px; color: var(--text-faint); flex-shrink: 0; }
    .dest .gl svg { width: 16px; height: 16px; }
    .dest.active .gl { color: var(--accent); }
    .dest .lb { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dest .n { margin-left: auto; font-size: var(--text-sm); color: var(--text-faint); }
    .dest .n:empty { display: none; }
    .navfoot {
      margin-top: auto; display: grid; gap: 6px;
      border-top: 1px solid var(--border); padding-top: 10px;
    }
    .nav-icons { display: flex; align-items: center; gap: 2px; }
    /* The rail holds its labels as long as it can: four glyphs beside four
       numbers is a rebus, not navigation. Under 1000px it narrows, under
       760px it becomes a labelled bottom bar with 44px targets. */
    @media (max-width: 1000px) { :root { --nav: 168px; } }
    @media (max-width: 760px) {
      #shell { flex-direction: column-reverse; }
      #nav {
        flex: none; width: 100%; flex-direction: row; align-items: center;
        gap: 10px; padding: 6px 10px; overflow-x: auto;
        border-right: none; border-top: 1px solid var(--border);
      }
      #nav .brand b, .runcard, .navfoot .ver { display: none; }
      .dests { grid-auto-flow: column; grid-auto-columns: max-content; }
      .dest { height: 44px; }
      .navfoot { margin-top: 0; margin-left: auto; border-top: none; padding-top: 0; }
      /* a bar you touch: every target in it clears 44px */
      #nav .brand, .nav-icons .icon-btn { width: 44px; height: 44px; justify-content: center; }
      .inst-menu { bottom: calc(100% + 8px); left: auto; right: 0; }
    }
    [hidden] { display: none !important; }
    .ui-icon { width: 16px; height: 16px; flex: none; vertical-align: middle; }
    .icon-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; padding: 0; flex: none;
      border: 1px solid transparent; border-radius: var(--radius-sm);
      background: transparent; color: var(--text-muted); cursor: pointer;
      text-decoration: none;
    }
    .icon-btn:hover { color: var(--text); background: var(--hover); border-color: var(--border); }
    .icon-btn svg { width: 16px; height: 16px; }
    .icon-btn[aria-pressed="true"] { color: var(--accent); background: var(--accent-soft); }
    .navfoot .ver { margin-right: auto; }
    .ctx-client svg { width: 16px; height: 16px; }
    .header-actions { margin-left: auto; display: flex; align-items: center; gap: 6px; flex: none; }
    @media (min-width: 761px) {
      .nav-collapsed #nav { flex-basis: 56px; width: 56px; padding: 12px 7px; }
      .nav-collapsed #nav .brand { justify-content: center; padding: 4px 0; }
      .nav-collapsed #nav .brand b, .nav-collapsed .runcard,
      .nav-collapsed .dest .lb, .nav-collapsed .dest .n, .nav-collapsed .navfoot .ver { display: none; }
      .nav-collapsed .dest { justify-content: center; padding: 0; height: 36px; }
      .nav-collapsed .nav-icons { flex-direction: column; }
      .nav-collapsed .inst-btn { font-size: 0; min-height: 28px; }
      .nav-collapsed .inst-btn::before { content: '\\21C4'; font-size: 16px; }
    }
    @media (max-width: 760px) {
      #nav { padding: 4px 8px max(4px, env(safe-area-inset-bottom)); gap: 4px; overflow: visible; }
      #nav > .brand, #nav .inst, #nav .navfoot .ver, #nav .nav-icons > a,
      #nav-toggle { display: none; }
      #nav .dests { display: flex; flex: 1; min-width: 0; gap: 2px; }
      #nav .dest { flex: 1; min-width: 0; height: 48px; padding: 3px 2px; gap: 2px; flex-direction: column; justify-content: center; font-size: 11px; }
      #nav .dest .n { display: none; }
      #nav .navfoot { flex: none; margin: 0; }
      .icon-btn { min-width: 44px; height: 44px; }
    }
`;

export const PREFS_SCRIPT = `(function () {
  try {
    var t = localStorage.getItem('cctrace-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    document.documentElement.classList.toggle('nav-collapsed', localStorage.getItem('cctrace-nav-collapsed') === '1');
  } catch (_) {}
})()`;

export const NAV_SCRIPT = `(function () {
  var button = document.getElementById('nav-toggle');
  function paint() {
    var collapsed = document.documentElement.classList.contains('nav-collapsed');
    button.innerHTML = collapsed ? ${JSON.stringify(UI_ICONS.panelLeftOpen)} : ${JSON.stringify(UI_ICONS.panelLeftClose)};
    button.setAttribute('aria-expanded', String(!collapsed));
    button.setAttribute('aria-label', collapsed ? 'Expand navigation' : 'Collapse navigation');
    button.title = collapsed ? 'Expand navigation' : 'Collapse navigation';
    button.dataset.tip = button.title;
  }
  button.onclick = function () {
    var collapsed = document.documentElement.classList.toggle('nav-collapsed');
    try { localStorage.setItem('cctrace-nav-collapsed', collapsed ? '1' : '0'); } catch (_) {}
    paint();
  };
  paint();
})()`;
