import type { ServerWebSocket } from "bun";
import type { TracePair } from "./types";
import { CATEGORIES, categorizeUrl } from "./categorize";

interface ServerConfig {
  port: number;
  logDir: string;
  logName?: string;
}

const clients = new Set<ServerWebSocket<unknown>>();
const pairs: TracePair[] = [];

function broadcast(data: unknown) {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    ws.send(msg);
  }
}

// The live server is a broadcast relay only — it holds pairs in memory and
// pushes them to connected browsers. The CLI's log sink owns the .jsonl/.html
// files, so we never double-write.
export function createServer(config: ServerConfig) {
  const serveOn = (port: number) => Bun.serve({
    port,
    fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        if (server.upgrade(req)) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      if (url.pathname === "/api/pair" && req.method === "POST") {
        return handlePair(req);
      }
      if (url.pathname === "/api/pairs") {
        return Response.json(pairs);
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        // Use the actually-bound port so the WebSocket URL is correct even
        // when we fell back off a busy preferred port.
        return new Response(getLiveHtml(server.port ?? port), {
          headers: { "Content-Type": "text/html" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        ws.send(JSON.stringify({ type: "init", pairs }));
      },
      close(ws) {
        clients.delete(ws);
      },
      message() {},
    },
  });

  // Try the preferred port; if it's taken (e.g. a system proxy owns it),
  // fall back to an OS-assigned free port instead of crashing.
  try {
    return serveOn(config.port);
  } catch {
    const server = serveOn(0);
    console.log(`[cctrace] Port ${config.port} busy — using ${server.port} instead`);
    return server;
  }
}

async function handlePair(req: Request): Promise<Response> {
  try {
    const pair = await req.json() as TracePair;
    pairs.push(pair);
    broadcast({ type: "pair", pair });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 400 });
  }
}

// The cctrace mark: "cc" monogram + a dot->ring trace line. Kept as raw
// geometry (no font) so it renders identically inline and as a favicon.
const LOGO_PATHS = `<path stroke-width="26" d="M270.75 175.6A125 125 0 1 0 270.75 336.4"/><path stroke-width="26" d="M395.75 175.6A125 125 0 1 0 395.75 336.4"/><line stroke-width="9" x1="250" y1="256" x2="452" y2="256"/><circle stroke-width="9" cx="452" cy="256" r="17"/>`;
const HEADER_LOGO = `<svg class="logo" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round">${LOGO_PATHS}<circle fill="currentColor" stroke="none" cx="250" cy="256" r="12"/></g></svg>`;
const FAVICON_HREF = "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><style>@media(prefers-color-scheme:dark){.s{stroke:#e6edf3}.f{fill:#e6edf3}}</style><g fill="none" stroke="#0d1117" stroke-linecap="round"><path class="s" stroke-width="26" d="M270.75 175.6A125 125 0 1 0 270.75 336.4"/><path class="s" stroke-width="26" d="M395.75 175.6A125 125 0 1 0 395.75 336.4"/><line class="s" stroke-width="9" x1="250" y1="256" x2="452" y2="256"/><circle class="s" stroke-width="9" cx="452" cy="256" r="17"/><circle class="f" fill="#0d1117" stroke="none" cx="250" cy="256" r="12"/></g></svg>`,
);
const GITHUB_ICON = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;

function getLiveHtml(port: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>cctrace live</title>
  <link rel="icon" href="${FAVICON_HREF}">
  <script>(function(){var t=localStorage.getItem('cctrace-theme');if(t&&t!=='system')document.documentElement.setAttribute('data-theme',t)})()</script>
  <style>
    :root {
      --bg: #0d1117; --bg-surface: #161b22; --border: #30363d;
      --text: #c9d1d9; --text-muted: #8b949e; --text-faint: #6e7681;
      --accent: #58a6ff; --text-method: #79c0ff;
      --green: #3fb950; --red: #f85149;
      --status-ok: #238636; --status-warn: #9e6a03; --status-err: #da3633;
      --btn-bg: #21262d; --hover: #1f2428;
      color-scheme: dark;
    }
    @media (prefers-color-scheme: light) {
      :root:not([data-theme="dark"]) {
        --bg: #fff; --bg-surface: #f6f8fa; --border: #d0d7de;
        --text: #1f2328; --text-muted: #656d76; --text-faint: #8c959f;
        --accent: #0969da; --text-method: #0550ae;
        --green: #1a7f37; --red: #cf222e;
        --status-ok: #1a7f37; --status-warn: #9a6700; --status-err: #cf222e;
        --btn-bg: #e1e4e8; --hover: #eef1f4;
        color-scheme: light;
      }
    }
    [data-theme="light"] {
      --bg: #fff; --bg-surface: #f6f8fa; --border: #d0d7de;
      --text: #1f2328; --text-muted: #656d76; --text-faint: #8c959f;
      --accent: #0969da; --text-method: #0550ae;
      --green: #1a7f37; --red: #cf222e;
      --status-ok: #1a7f37; --status-warn: #9a6700; --status-err: #cf222e;
      --btn-bg: #e1e4e8; --hover: #eef1f4;
      color-scheme: light;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
      background: var(--bg);
      color: var(--text);
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      padding: 12px 16px;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .brand { display: flex; align-items: center; gap: 9px; }
    .logo { width: 24px; height: 24px; color: var(--accent); flex-shrink: 0; }
    h1 { font-size: 16px; color: var(--accent); letter-spacing: 0.5px; }
    .status { font-size: 12px; color: var(--text-muted); }
    .status.connected { color: var(--green); }
    .status.disconnected { color: var(--red); }
    .count { color: var(--text-muted); margin-left: auto; }
    .header-actions { display: flex; align-items: center; gap: 2px; }
    .icon-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; border-radius: 6px;
      background: none; border: 1px solid transparent;
      color: var(--text-faint); cursor: pointer; padding: 0;
      text-decoration: none; transition: color .15s, background .15s;
    }
    .icon-btn:hover { background: var(--btn-bg); border-color: var(--border); color: var(--text); }
    .icon-btn svg { width: 16px; height: 16px; }
    .toolbar {
      padding: 8px 16px;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border);
      display: flex;
      gap: 8px;
    }
    .toolbar input {
      flex: 1;
      padding: 6px 10px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text);
      font-family: inherit;
      font-size: 12px;
    }
    .toolbar input:focus { outline: none; border-color: var(--accent); }
    .toolbar button {
      padding: 6px 12px;
      background: var(--btn-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text);
      cursor: pointer;
      font-family: inherit;
      font-size: 12px;
    }
    .toolbar button:hover { background: var(--border); }
    .toolbar button.active { background: var(--status-ok); border-color: var(--status-ok); color: #fff; }
    .cats {
      padding: 8px 16px;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border);
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .cat-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 999px;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 11px;
      user-select: none;
    }
    .cat-chip:hover { border-color: var(--accent); }
    .cat-chip.active { border-color: currentColor; }
    .cat-chip .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--cat, var(--text-faint)); }
    .cat-chip .n { color: var(--text-faint); font-variant-numeric: tabular-nums; }
    .cat-chip.active .n { color: var(--text); }
    .cat-chip.zero { opacity: 0.4; }
    .cat-badge {
      padding: 1px 7px;
      border-radius: 999px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: #fff;
      background: var(--cat, var(--text-faint));
    }
    main {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }
    .pair {
      border: 1px solid var(--border);
      border-radius: 6px;
      margin-bottom: 6px;
      overflow: hidden;
      animation: slideIn 0.2s ease-out;
    }
    @keyframes slideIn {
      from { opacity: 0; transform: translateY(-10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .pair-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      background: var(--bg-surface);
      cursor: pointer;
      font-size: 12px;
    }
    .pair-header:hover { background: var(--hover); }
    .method { font-weight: 600; color: var(--text-method); min-width: 45px; }
    .status-code {
      padding: 2px 6px;
      border-radius: 3px;
      color: #fff;
      font-weight: 500;
      font-size: 11px;
    }
    .status-2xx { background: var(--status-ok); }
    .status-4xx { background: var(--status-warn); }
    .status-5xx { background: var(--status-err); }
    .status-err { background: var(--status-err); }
    .url {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .duration { color: var(--text-muted); min-width: 50px; text-align: right; }
    .time { color: var(--text-faint); font-size: 11px; }
    .pair-body {
      display: none;
      padding: 12px;
      background: var(--bg);
      border-top: 1px solid var(--border);
    }
    .pair.expanded .pair-body { display: block; }
    .section { margin-bottom: 12px; }
    .section:last-child { margin-bottom: 0; }
    .section h4 {
      color: var(--text-muted);
      font-size: 10px;
      text-transform: uppercase;
      margin-bottom: 6px;
    }
    pre {
      background: var(--bg-surface);
      padding: 10px;
      border-radius: 4px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 300px;
      overflow-y: auto;
      font-size: 11px;
    }
    .empty {
      text-align: center;
      padding: 40px;
      color: var(--text-faint);
    }
    .pair-meta {
      padding: 6px 12px;
      background: var(--bg-surface);
      border-top: 1px solid var(--border);
      font-size: 11px;
      color: var(--text-muted);
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
    }
    .pair-meta .val { color: var(--text); font-variant-numeric: tabular-nums; }
    .pair-meta .cache-hit { color: var(--green); }
    .pre-wrap { position: relative; }
    .pre-wrap .copy-btn {
      position: absolute; top: 6px; right: 6px;
      background: var(--btn-bg); border: 1px solid var(--border);
      border-radius: 4px; padding: 3px 5px; cursor: pointer;
      color: var(--text-faint); display: none;
      align-items: center; justify-content: center;
      z-index: 1; line-height: 1;
    }
    .pre-wrap:hover .copy-btn { display: inline-flex; }
    .copy-btn:hover { color: var(--text); }
    .copy-btn.copied { color: var(--green); border-color: var(--green); }
    .copy-btn svg { width: 14px; height: 14px; }
  </style>
</head>
<body>
  <header>
    <span class="brand">${HEADER_LOGO}<h1>cctrace</h1></span>
    <span class="status disconnected" id="status">disconnected</span>
    <span class="count"><span id="count">0</span> requests</span>
    <span class="header-actions">
      <button class="icon-btn" id="theme-toggle" title="Theme: system"></button>
      <a class="icon-btn" href="https://github.com/thevibeworks/cctrace" target="_blank" rel="noopener" title="GitHub">${GITHUB_ICON}</a>
    </span>
  </header>
  <div class="toolbar">
    <input type="text" id="filter" placeholder="Filter by URL, method, status...">
    <button id="autoscroll" class="active">Auto-scroll</button>
    <button id="clear">Clear</button>
  </div>
  <div class="cats" id="cats"></div>
  <main id="pairs"></main>

  <script>
    const pairs = [];
    let autoScroll = true;
    let filter = '';
    let activeCat = 'all';

    // Category metadata + categorizer are injected from src/categorize.ts, the
    // single source of truth shared with the unit tests (no drift).
    const CATS = ${JSON.stringify(CATEGORIES)};
    const CAT_BY_ID = Object.fromEntries(CATS.map(c => [c.id, c]));
    const categorize = ${categorizeUrl.toString()};

    const statusEl = document.getElementById('status');
    const countEl = document.getElementById('count');
    const pairsEl = document.getElementById('pairs');
    const filterEl = document.getElementById('filter');
    const autoScrollBtn = document.getElementById('autoscroll');
    const clearBtn = document.getElementById('clear');
    const catsEl = document.getElementById('cats');
    const themeToggle = document.getElementById('theme-toggle');

    // Theme toggle: system -> light -> dark -> system
    const THEME_ICONS = {
      system: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="9" rx="1"/><line x1="8" y1="12" x2="8" y2="14.5"/><line x1="4.5" y1="14.5" x2="11.5" y2="14.5"/></svg>',
      light: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><line x1="8" y1="1.5" x2="8" y2="3"/><line x1="8" y1="13" x2="8" y2="14.5"/><line x1="1.5" y1="8" x2="3" y2="8"/><line x1="13" y1="8" x2="14.5" y2="8"/><line x1="3.4" y1="3.4" x2="4.5" y2="4.5"/><line x1="11.5" y1="11.5" x2="12.6" y2="12.6"/><line x1="3.4" y1="12.6" x2="4.5" y2="11.5"/><line x1="11.5" y1="4.5" x2="12.6" y2="3.4"/></svg>',
      dark: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.2 9.5A5.5 5.5 0 0 1 6.5 2.8 5 5 0 1 0 13.2 9.5z"/></svg>'
    };
    function getThemePref() { return localStorage.getItem('cctrace-theme') || 'system'; }
    function applyTheme(pref) {
      if (pref === 'system') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', pref);
      themeToggle.innerHTML = THEME_ICONS[pref];
      themeToggle.title = 'Theme: ' + pref;
    }
    themeToggle.onclick = function() {
      var order = ['system', 'light', 'dark'];
      var cur = getThemePref();
      var next = order[(order.indexOf(cur) + 1) % 3];
      localStorage.setItem('cctrace-theme', next);
      applyTheme(next);
    };
    applyTheme(getThemePref());

    function catCounts() {
      const counts = { all: pairs.length };
      for (const c of CATS) counts[c.id] = 0;
      for (const p of pairs) counts[p._cat] = (counts[p._cat] || 0) + 1;
      return counts;
    }

    function renderCats() {
      const counts = catCounts();
      const chip = (id, label, color, n) =>
        '<div class="cat-chip ' + (activeCat === id ? 'active' : '') + (n === 0 && id !== 'all' ? ' zero' : '') +
        '" style="--cat:' + (color || 'var(--text-muted)') + (activeCat === id ? ';color:' + (color || 'var(--text)') : '') + '" data-cat="' + id + '">' +
        (id === 'all' ? '' : '<span class="dot"></span>') +
        '<span>' + label + '</span><span class="n">' + n + '</span></div>';
      let html = chip('all', 'All', 'var(--accent)', counts.all);
      for (const c of CATS) html += chip(c.id, c.label, c.color, counts[c.id] || 0);
      catsEl.innerHTML = html;
      catsEl.querySelectorAll('.cat-chip').forEach(el => {
        el.onclick = () => { activeCat = el.dataset.cat; render(); };
      });
    }

    function connect() {
      const ws = new WebSocket('ws://localhost:${port}/ws');
      ws.onopen = () => { statusEl.textContent = 'connected'; statusEl.className = 'status connected'; };
      ws.onclose = () => {
        statusEl.textContent = 'disconnected'; statusEl.className = 'status disconnected';
        setTimeout(connect, 1000);
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'init') {
          pairs.length = 0;
          for (const p of msg.pairs) { p._cat = categorize(p.request.url); pairs.push(p); }
          render();
        } else if (msg.type === 'pair') {
          msg.pair._cat = categorize(msg.pair.request.url);
          pairs.push(msg.pair);
          countEl.textContent = pairs.length;
          renderCats();
          if (passesFilters(msg.pair)) {
            renderPair(msg.pair, pairs.length - 1);
            if (autoScroll) pairsEl.scrollTop = pairsEl.scrollHeight;
          }
        }
      };
    }

    function escapeHtml(str) {
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function formatJson(obj) {
      try { return escapeHtml(JSON.stringify(obj, null, 2)); } catch { return String(obj); }
    }
    function formatDuration(ms) { return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(2) + 's'; }
    function getStatusClass(status) {
      if (!status) return 'status-err';
      if (status >= 200 && status < 300) return 'status-2xx';
      if (status >= 400 && status < 500) return 'status-4xx';
      return 'status-5xx';
    }

    function passesFilters(pair) {
      if (activeCat !== 'all' && pair._cat !== activeCat) return false;
      if (filter) {
        const q = filter.toLowerCase();
        var parts = [pair.request.method, pair.request.url, pair.response?.status];
        try { parts.push(JSON.stringify(pair.request.headers)); } catch {}
        try { parts.push(JSON.stringify(pair.request.body)); } catch {}
        try { parts.push(JSON.stringify(pair.response?.headers)); } catch {}
        try { parts.push(JSON.stringify(pair.response?.body)); } catch {}
        if (pair.response?.bodyRaw) parts.push(pair.response.bodyRaw);
        if (!parts.join(' ').toLowerCase().includes(q)) return false;
      }
      return true;
    }

    var COPY_SVG = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25zM5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25z"/></svg>';
    var CHECK_SVG = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.751.751 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>';

    window.copyBlock = function(btn) {
      var pre = btn.nextElementSibling;
      navigator.clipboard.writeText(pre.textContent).then(function() {
        btn.classList.add('copied');
        btn.innerHTML = CHECK_SVG;
        setTimeout(function() { btn.classList.remove('copied'); btn.innerHTML = COPY_SVG; }, 1500);
      });
    };

    function preBlock(content) {
      return '<div class="pre-wrap"><button class="copy-btn" onclick="copyBlock(this)" title="Copy">' + COPY_SVG + '</button><pre>' + content + '</pre></div>';
    }

    function tokenMeta(pair) {
      if (pair._cat !== 'messages') return '';
      var body = pair.response?.body;
      if (!body || !body.usage) return '';
      var u = body.usage;
      var model = (body.model || '').replace('claude-', '');
      var cacheRead = u.cache_read_input_tokens || 0;
      var totalIn = (u.input_tokens || 0) + cacheRead;
      var cachePct = totalIn > 0 ? Math.round(cacheRead / totalIn * 100) : 0;
      var parts = [];
      parts.push('<span class="val">' + model + '</span>');
      parts.push('in <span class="val">' + (u.input_tokens || 0).toLocaleString() + '</span>');
      parts.push('out <span class="val">' + (u.output_tokens || 0).toLocaleString() + '</span>');
      if (cacheRead > 0) parts.push('cache <span class="val cache-hit">' + cacheRead.toLocaleString() + ' (' + cachePct + '%)</span>');
      if (u.service_tier && u.service_tier !== 'standard') parts.push('tier <span class="val">' + u.service_tier + '</span>');
      return '<div class="pair-meta">' + parts.join('<span style="color:var(--border)">|</span>') + '</div>';
    }

    function renderPair(pair, idx) {
      if (!passesFilters(pair)) return;
      const { request, response, duration } = pair;
      const url = new URL(request.url);
      const shortUrl = url.hostname + url.pathname;
      const status = response?.status || 'ERR';
      const statusClass = getStatusClass(response?.status);
      const cat = CAT_BY_ID[pair._cat] || CAT_BY_ID.other;

      const div = document.createElement('div');
      div.className = 'pair';
      div.dataset.idx = idx;
      div.innerHTML = \`
        <div class="pair-header" onclick="toggle(\${idx})" title="\${escapeHtml(request.url)}">
          <span class="method">\${request.method}</span>
          <span class="status-code \${statusClass}" title="HTTP \${status}">\${status}</span>
          <span class="cat-badge" style="--cat:\${cat.color}" title="\${cat.label}">\${cat.label}</span>
          <span class="url">\${escapeHtml(shortUrl)}</span>
          <span class="duration" title="\${duration}ms">\${formatDuration(duration)}</span>
          <span class="time">\${new Date(request.timestamp * 1000).toLocaleTimeString()}</span>
        </div>
        \${tokenMeta(pair)}
        <div class="pair-body">
          <div class="section">
            <h4>Request Headers</h4>
            \${preBlock(formatJson(request.headers))}
          </div>
          \${request.body ? \`<div class="section"><h4>Request Body</h4>\${preBlock(formatJson(request.body))}</div>\` : ''}
          \${response ? \`
            <div class="section"><h4>Response Headers</h4>\${preBlock(formatJson(response.headers))}</div>
            \${response.body ? \`<div class="section"><h4>Response Body</h4>\${preBlock(formatJson(response.body))}</div>\` : ''}
            \${response.bodyRaw ? \`<div class="section"><h4>Response (Raw)</h4>\${preBlock(escapeHtml(response.bodyRaw.slice(0, 50000)))}</div>\` : ''}
          \` : '<div class="section"><h4>Error</h4><pre>Request failed</pre></div>'}
        </div>
      \`;
      pairsEl.appendChild(div);
    }

    function render() {
      renderCats();
      pairsEl.innerHTML = '';
      countEl.textContent = pairs.length;
      const visible = pairs.filter(passesFilters);
      if (pairs.length === 0) {
        pairsEl.innerHTML = '<div class="empty">Waiting for requests...</div>';
        return;
      }
      if (visible.length === 0) {
        pairsEl.innerHTML = '<div class="empty">No requests match this filter.</div>';
        return;
      }
      pairs.forEach((p, i) => renderPair(p, i));
      if (autoScroll) pairsEl.scrollTop = pairsEl.scrollHeight;
    }

    window.toggle = (idx) => {
      const el = document.querySelector(\`.pair[data-idx="\${idx}"]\`);
      el?.classList.toggle('expanded');
    };

    filterEl.oninput = () => { filter = filterEl.value; render(); };
    autoScrollBtn.onclick = () => {
      autoScroll = !autoScroll;
      autoScrollBtn.classList.toggle('active', autoScroll);
    };
    clearBtn.onclick = () => { pairs.length = 0; activeCat = 'all'; render(); };

    renderCats();
    // Offline snapshot: if pairs are embedded (static export), load them and
    // skip the WebSocket. Otherwise connect live.
    if (Array.isArray(window.__PAIRS__)) {
      for (const p of window.__PAIRS__) { p._cat = categorize(p.request.url); pairs.push(p); }
      statusEl.textContent = 'snapshot';
      statusEl.className = 'status connected';
      autoScroll = false;
      autoScrollBtn.classList.remove('active');
      render();
    } else {
      connect();
    }
  </script>
</body>
</html>`;
}

export function getServerUrl(port: number): string {
  return `http://localhost:${port}`;
}

/**
 * Self-contained static HTML with the pairs embedded — same categorized UI as
 * the live view, but loads from window.__PAIRS__ and skips the WebSocket. For
 * offline review of a saved .jsonl trace.
 */
export function renderSnapshot(tracePairs: TracePair[]): string {
  const html = getLiveHtml(0);
  // Inject before </head> so __PAIRS__ is defined before the body script runs.
  const inject = `<script>window.__PAIRS__ = ${JSON.stringify(tracePairs)};</script>`;
  return html.replace("</head>", `${inject}\n</head>`);
}
