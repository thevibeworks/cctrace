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

function getLiveHtml(port: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>cctrace live</title>
  <link rel="icon" href="${FAVICON_HREF}">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
      background: #0d1117;
      color: #c9d1d9;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      padding: 12px 16px;
      background: #161b22;
      border-bottom: 1px solid #30363d;
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .brand { display: flex; align-items: center; gap: 9px; }
    .logo { width: 24px; height: 24px; color: #58a6ff; flex-shrink: 0; }
    h1 { font-size: 16px; color: #58a6ff; letter-spacing: 0.5px; }
    .status { font-size: 12px; color: #8b949e; }
    .status.connected { color: #3fb950; }
    .status.disconnected { color: #f85149; }
    .count { color: #8b949e; margin-left: auto; }
    .toolbar {
      padding: 8px 16px;
      background: #161b22;
      border-bottom: 1px solid #30363d;
      display: flex;
      gap: 8px;
    }
    .toolbar input {
      flex: 1;
      padding: 6px 10px;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 4px;
      color: #c9d1d9;
      font-family: inherit;
      font-size: 12px;
    }
    .toolbar input:focus { outline: none; border-color: #58a6ff; }
    .toolbar button {
      padding: 6px 12px;
      background: #21262d;
      border: 1px solid #30363d;
      border-radius: 4px;
      color: #c9d1d9;
      cursor: pointer;
      font-family: inherit;
      font-size: 12px;
    }
    .toolbar button:hover { background: #30363d; }
    .toolbar button.active { background: #238636; border-color: #238636; }
    .cats {
      padding: 8px 16px;
      background: #161b22;
      border-bottom: 1px solid #30363d;
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .cat-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 999px;
      color: #8b949e;
      cursor: pointer;
      font-size: 11px;
      user-select: none;
    }
    .cat-chip:hover { border-color: #58a6ff; }
    .cat-chip.active { color: #fff; border-color: currentColor; }
    .cat-chip .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--cat, #6e7681); }
    .cat-chip .n { color: #6e7681; font-variant-numeric: tabular-nums; }
    .cat-chip.active .n { color: #c9d1d9; }
    .cat-chip.zero { opacity: 0.4; }
    .cat-badge {
      padding: 1px 7px;
      border-radius: 999px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: #fff;
      background: var(--cat, #6e7681);
    }
    main {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }
    .pair {
      border: 1px solid #30363d;
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
      background: #161b22;
      cursor: pointer;
      font-size: 12px;
    }
    .pair-header:hover { background: #1f2428; }
    .method { font-weight: 600; color: #79c0ff; min-width: 45px; }
    .status-code {
      padding: 2px 6px;
      border-radius: 3px;
      color: #fff;
      font-weight: 500;
      font-size: 11px;
    }
    .status-2xx { background: #238636; }
    .status-4xx { background: #9e6a03; }
    .status-5xx { background: #da3633; }
    .status-err { background: #da3633; }
    .url {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .duration { color: #8b949e; min-width: 50px; text-align: right; }
    .time { color: #6e7681; font-size: 11px; }
    .pair-body {
      display: none;
      padding: 12px;
      background: #0d1117;
      border-top: 1px solid #30363d;
    }
    .pair.expanded .pair-body { display: block; }
    .section { margin-bottom: 12px; }
    .section:last-child { margin-bottom: 0; }
    .section h4 {
      color: #8b949e;
      font-size: 10px;
      text-transform: uppercase;
      margin-bottom: 6px;
    }
    pre {
      background: #161b22;
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
      color: #6e7681;
    }
  </style>
</head>
<body>
  <header>
    <span class="brand">${HEADER_LOGO}<h1>cctrace</h1></span>
    <span class="status disconnected" id="status">disconnected</span>
    <span class="count"><span id="count">0</span> requests</span>
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
        '" style="--cat:' + (color || '#8b949e') + (activeCat === id ? ';color:' + (color || '#c9d1d9') : '') + '" data-cat="' + id + '">' +
        (id === 'all' ? '' : '<span class="dot"></span>') +
        '<span>' + label + '</span><span class="n">' + n + '</span></div>';
      let html = chip('all', 'All', '#58a6ff', counts.all);
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
        const text = [pair.request.method, pair.request.url, pair.response?.status].join(' ').toLowerCase();
        if (!text.includes(q)) return false;
      }
      return true;
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
        <div class="pair-header" onclick="toggle(\${idx})">
          <span class="method">\${request.method}</span>
          <span class="status-code \${statusClass}">\${status}</span>
          <span class="cat-badge" style="--cat:\${cat.color}">\${cat.label}</span>
          <span class="url" title="\${escapeHtml(request.url)}">\${escapeHtml(shortUrl)}</span>
          <span class="duration">\${formatDuration(duration)}</span>
          <span class="time">\${new Date(request.timestamp * 1000).toLocaleTimeString()}</span>
        </div>
        <div class="pair-body">
          <div class="section">
            <h4>Request Headers</h4>
            <pre>\${formatJson(request.headers)}</pre>
          </div>
          \${request.body ? \`<div class="section"><h4>Request Body</h4><pre>\${formatJson(request.body)}</pre></div>\` : ''}
          \${response ? \`
            <div class="section"><h4>Response Headers</h4><pre>\${formatJson(response.headers)}</pre></div>
            \${response.body ? \`<div class="section"><h4>Response Body</h4><pre>\${formatJson(response.body)}</pre></div>\` : ''}
            \${response.bodyRaw ? \`<div class="section"><h4>Response (Raw)</h4><pre>\${escapeHtml(response.bodyRaw.slice(0, 50000))}</pre></div>\` : ''}
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
