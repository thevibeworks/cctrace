import type { TracePair } from "./types";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatJson(obj: unknown): string {
  try {
    return escapeHtml(JSON.stringify(obj, null, 2));
  } catch {
    return String(obj);
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function getStatusColor(status: number): string {
  if (status >= 200 && status < 300) return "#22c55e";
  if (status >= 400 && status < 500) return "#f59e0b";
  if (status >= 500) return "#ef4444";
  return "#6b7280";
}

function renderPair(pair: TracePair, index: number): string {
  const { request, response, duration } = pair;
  const statusColor = response ? getStatusColor(response.status) : "#ef4444";
  const statusText = response ? response.status : "ERR";

  const urlObj = new URL(request.url);
  const shortUrl = `${urlObj.hostname}${urlObj.pathname}`;

  return `
    <div class="pair" id="pair-${index}">
      <div class="pair-header" onclick="toggle(${index})">
        <span class="method">${request.method}</span>
        <span class="status" style="background:${statusColor}">${statusText}</span>
        <span class="url" title="${escapeHtml(request.url)}">${escapeHtml(shortUrl)}</span>
        <span class="duration">${formatDuration(duration)}</span>
        <span class="time">${new Date(request.timestamp * 1000).toTimeString().slice(0, 8)}</span>
      </div>
      <div class="pair-body" id="body-${index}" style="display:none">
        <div class="section">
          <h4>Request Headers</h4>
          <pre>${formatJson(request.headers)}</pre>
        </div>
        ${request.body ? `
        <div class="section">
          <h4>Request Body</h4>
          <pre>${formatJson(request.body)}</pre>
        </div>
        ` : ""}
        ${response ? `
        <div class="section">
          <h4>Response Headers</h4>
          <pre>${formatJson(response.headers)}</pre>
        </div>
        ${response.body ? `
        <div class="section">
          <h4>Response Body</h4>
          <pre>${formatJson(response.body)}</pre>
        </div>
        ` : ""}
        ${response.bodyRaw ? `
        <div class="section">
          <h4>Response (Raw)</h4>
          <pre>${escapeHtml(response.bodyRaw.slice(0, 50000))}${response.bodyRaw.length > 50000 ? "\n... (truncated)" : ""}</pre>
        </div>
        ` : ""}
        ` : `
        <div class="section error">
          <h4>Error</h4>
          <p>Request failed - no response received</p>
        </div>
        `}
      </div>
    </div>
  `;
}

export function generateHtml(pairs: TracePair[]): string {
  const pairsHtml = pairs.map((p, i) => renderPair(p, i)).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>cctrace - ${pairs.length} requests</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
      background: #0d1117;
      color: #c9d1d9;
      padding: 16px;
    }
    h1 { font-size: 18px; margin-bottom: 16px; color: #58a6ff; }
    .stats { color: #8b949e; margin-bottom: 16px; }
    .pair {
      border: 1px solid #30363d;
      border-radius: 6px;
      margin-bottom: 8px;
      overflow: hidden;
    }
    .pair-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 12px;
      background: #161b22;
      cursor: pointer;
    }
    .pair-header:hover { background: #1f2428; }
    .method {
      font-weight: 600;
      color: #79c0ff;
      min-width: 50px;
    }
    .status {
      padding: 2px 8px;
      border-radius: 4px;
      color: #fff;
      font-weight: 500;
      font-size: 12px;
    }
    .url {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #c9d1d9;
    }
    .duration { color: #8b949e; min-width: 60px; text-align: right; }
    .time { color: #6e7681; font-size: 11px; }
    .pair-body { padding: 12px; background: #0d1117; }
    .section { margin-bottom: 16px; }
    .section:last-child { margin-bottom: 0; }
    .section h4 {
      color: #8b949e;
      font-size: 11px;
      text-transform: uppercase;
      margin-bottom: 8px;
    }
    pre {
      background: #161b22;
      padding: 12px;
      border-radius: 6px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 400px;
      overflow-y: auto;
    }
    .error { color: #f85149; }
    .filter {
      margin-bottom: 16px;
      display: flex;
      gap: 8px;
    }
    .filter input {
      flex: 1;
      padding: 8px 12px;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #c9d1d9;
      font-family: inherit;
    }
    .filter input:focus { outline: none; border-color: #58a6ff; }
  </style>
</head>
<body>
  <h1>cctrace</h1>
  <div class="stats">${pairs.length} requests captured</div>
  <div class="filter">
    <input type="text" id="search" placeholder="Filter by URL or method..." oninput="filter()">
  </div>
  <div id="pairs">
    ${pairsHtml}
  </div>
  <script>
    function toggle(i) {
      const el = document.getElementById('body-' + i);
      el.style.display = el.style.display === 'none' ? 'block' : 'none';
    }
    function filter() {
      const q = document.getElementById('search').value.toLowerCase();
      document.querySelectorAll('.pair').forEach(p => {
        const text = p.textContent.toLowerCase();
        p.style.display = text.includes(q) ? 'block' : 'none';
      });
    }
  </script>
</body>
</html>`;
}
