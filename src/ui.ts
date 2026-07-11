import type { TracePair } from "./types";
import { CATEGORIES, categorizeUrl } from "./categorize";
import {
  parseSse,
  fmtCompact,
  shortModel,
  extractMessageInfo,
  extractSessionId,
  extractTokenCount,
  extractUsageInfo,
  assembleAssistant,
  summarizePair,
} from "./summarize";
import {
  threadSig,
  normalizeTurns,
  buildToolResultIndex,
  responseBlocks,
  buildSession,
  mainThread,
  toolPreview,
} from "./session";

// The whole web UI lives in this file: one self-contained HTML page serving
// three views — the Requests list (with a split detail panel) and the Session
// view (wire timeline + reconstructed conversation side by side). The same
// page powers the live server (WebSocket) and offline snapshots (__PAIRS__).

// The cctrace mark: "cc" monogram + a dot->ring trace line. Kept as raw
// geometry (no font) so it renders identically inline and as a favicon.
const LOGO_PATHS = `<path stroke-width="26" d="M270.75 175.6A125 125 0 1 0 270.75 336.4"/><path stroke-width="26" d="M395.75 175.6A125 125 0 1 0 395.75 336.4"/><line stroke-width="9" x1="250" y1="256" x2="452" y2="256"/><circle stroke-width="9" cx="452" cy="256" r="17"/>`;
const HEADER_LOGO = `<svg class="logo" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round">${LOGO_PATHS}<circle fill="currentColor" stroke="none" cx="250" cy="256" r="12"/></g></svg>`;
const FAVICON_HREF = "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><style>@media(prefers-color-scheme:dark){.s{stroke:#e6edf3}.f{fill:#e6edf3}}</style><g fill="none" stroke="#0d1117" stroke-linecap="round"><path class="s" stroke-width="26" d="M270.75 175.6A125 125 0 1 0 270.75 336.4"/><path class="s" stroke-width="26" d="M395.75 175.6A125 125 0 1 0 395.75 336.4"/><line class="s" stroke-width="9" x1="250" y1="256" x2="452" y2="256"/><circle class="s" stroke-width="9" cx="452" cy="256" r="17"/><circle class="f" fill="#0d1117" stroke="none" cx="250" cy="256" r="12"/></g></svg>`,
);
const GITHUB_ICON = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;

/** Run identity shown in the page header. All fields optional: `cctrace view`
 * rebuilds from a saved trace where the original cwd is unknown. */
export interface PageMeta {
  /** Project name — basename of the directory cctrace ran in. */
  project?: string;
  /** Full path of that directory (tooltip). */
  projectPath?: string;
}

export function getLiveHtml(port: number, meta: PageMeta = {}): string {
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
      --green: #3fb950; --red: #f85149; --amber: #d29922; --purple: #a371f7;
      --status-ok: #238636; --status-warn: #9e6a03; --status-err: #da3633;
      --btn-bg: #21262d; --hover: #1f2428;
      color-scheme: dark;
    }
    @media (prefers-color-scheme: light) {
      :root:not([data-theme="dark"]) {
        --bg: #fff; --bg-surface: #f6f8fa; --border: #d0d7de;
        --text: #1f2328; --text-muted: #656d76; --text-faint: #8c959f;
        --accent: #0969da; --text-method: #0550ae;
        --green: #1a7f37; --red: #cf222e; --amber: #9a6700; --purple: #8250df;
        --status-ok: #1a7f37; --status-warn: #9a6700; --status-err: #cf222e;
        --btn-bg: #e1e4e8; --hover: #eef1f4;
        color-scheme: light;
      }
    }
    [data-theme="light"] {
      --bg: #fff; --bg-surface: #f6f8fa; --border: #d0d7de;
      --text: #1f2328; --text-muted: #656d76; --text-faint: #8c959f;
      --accent: #0969da; --text-method: #0550ae;
      --green: #1a7f37; --red: #cf222e; --amber: #9a6700; --purple: #8250df;
      --status-ok: #1a7f37; --status-warn: #9a6700; --status-err: #cf222e;
      --btn-bg: #e1e4e8; --hover: #eef1f4;
      color-scheme: light;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    /* Chrome-quality details: quiet scrollbars, accent selection, visible
       keyboard focus. The UI should feel like a well-kept terminal. */
    :root { scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
    ::-webkit-scrollbar { width: 10px; height: 10px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb {
      background: var(--border); border-radius: 5px;
      border: 2px solid transparent; background-clip: padding-box;
    }
    ::-webkit-scrollbar-thumb:hover { background-color: var(--text-faint); }
    ::selection { background: color-mix(in srgb, var(--accent) 30%, transparent); }
    :focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }
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
    .ctx { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 12px; color: var(--text-muted); }
    .ctx-proj { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ctx-sep { color: var(--text-faint); }
    .ctx-sess {
      font: inherit; color: var(--text-muted); cursor: pointer; flex-shrink: 0;
      background: var(--btn-bg); border: 1px solid var(--border);
      border-radius: 6px; padding: 1px 7px;
    }
    .ctx-sess:hover { color: var(--text); }
    .ctx-sess.copied { color: var(--green); border-color: var(--green); }
    .status { font-size: 12px; color: var(--text-muted); flex-shrink: 0; display: inline-flex; align-items: center; gap: 6px; }
    .status::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
    .status.connected { color: var(--green); }
    .status.connected::before { animation: heartbeat 2.4s ease-in-out infinite; }
    .status.disconnected { color: var(--red); }
    .status.snapshot { color: var(--accent); }
    @keyframes heartbeat { 50% { opacity: 0.3; } }
    @media (prefers-reduced-motion: reduce) {
      .status.connected::before { animation: none; }
      * { scroll-behavior: auto !important; }
    }
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
      align-items: center;
    }
    .tabs { display: flex; gap: 4px; }
    .tab {
      padding: 6px 12px;
      background: var(--btn-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text-muted);
      cursor: pointer;
      font-family: inherit;
      font-size: 12px;
    }
    .tab:hover { color: var(--text); }
    .tab.active { background: var(--accent); border-color: var(--accent); color: #fff; }
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
    body.view-session #filter, body.view-session #autoscroll, body.view-session #clear { display: none; }
    #prior-toggle { display: none; }
    #prior-toggle.avail { display: inline-block; }
    body.view-session #prior-toggle { display: none; }
    body.view-session .cats { display: none; }
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
      flex-shrink: 0;
    }
    /* Pairs merged in from a previous run's trace (same Claude session). */
    .pair.prior .pair-header { opacity: 0.72; }
    .prior-badge {
      padding: 1px 7px;
      border-radius: 999px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: var(--text-muted);
      border: 1px dashed var(--text-faint);
      flex-shrink: 0;
    }
    /* ---- Requests view: list + split detail panel ---- */
    #split { flex: 1; display: flex; min-height: 0; }
    body.view-session #split { display: none; }
    #pairs { flex: 1; min-width: 0; overflow-y: auto; padding: 8px; }
    #detail {
      display: none;
      min-width: 0;
      overflow-y: auto;
      padding: 12px 16px;
      border-left: 1px solid var(--border);
    }
    body.detail-open #detail { display: block; flex: 0 0 60%; max-width: 60%; }
    @media (max-width: 960px) {
      body.detail-open #pairs { display: none; }
      body.detail-open #detail { flex: 1; max-width: 100%; border-left: none; }
    }
    /* ---- Session view: threads + conversation ---- */
    #session-view { display: none; flex: 1; min-height: 0; position: relative; }
    body.view-session #session-view { display: flex; }
    #threads { flex: 0 0 320px; min-width: 0; overflow-y: auto; padding: 8px; border-right: 1px solid var(--border); }
    #convo { flex: 1; min-width: 0; overflow-y: auto; padding: 12px 16px; }
    @media (max-width: 960px) { #threads { flex-basis: 220px; } }
    #tail-pill {
      position: absolute; right: 24px; bottom: 16px; z-index: 5;
      display: none; align-items: center; gap: 6px;
      font: inherit; font-size: 12px; color: var(--text);
      background: var(--bg-surface); border: 1px solid var(--border);
      border-radius: 999px; padding: 5px 12px; cursor: pointer;
      box-shadow: 0 2px 8px rgba(0,0,0,0.35);
    }
    #tail-pill.show { display: inline-flex; }
    #tail-pill:hover { border-color: var(--accent); color: var(--accent); }
    /* Shared value colors (index chips + detail) */
    .ok { color: var(--green); }
    .warn { color: var(--amber); }
    .err { color: var(--red); }
    .model { color: var(--text-method); }
    .pair {
      border: 1px solid var(--border);
      border-radius: 6px;
      margin-bottom: 6px;
      overflow: hidden;
      animation: slideIn 0.2s ease-out;
    }
    .pair.selected { border-color: var(--accent); }
    .pair.selected .pair-header { background: var(--hover); }
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
      color: inherit;
      text-decoration: none;
    }
    .pair-header:hover { background: var(--hover); }
    .method { font-weight: 600; color: var(--text-method); min-width: 45px; flex-shrink: 0; }
    .status-code {
      padding: 2px 6px;
      border-radius: 3px;
      color: #fff;
      font-weight: 500;
      font-size: 11px;
      flex-shrink: 0;
    }
    .status-2xx { background: var(--status-ok); }
    .status-4xx { background: var(--status-warn); }
    .status-5xx { background: var(--status-err); }
    .status-err { background: var(--status-err); }
    .url {
      flex: 0 1 auto;
      min-width: 60px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sum {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      align-items: center;
      overflow: hidden;
      white-space: nowrap;
      color: var(--text-muted);
      font-size: 11px;
    }
    .sum > span { flex-shrink: 0; }
    .sum > span + span::before { content: '\\00B7'; margin: 0 7px; color: var(--text-faint); }
    .duration { color: var(--text-muted); min-width: 50px; text-align: right; flex-shrink: 0; }
    .time { color: var(--text-faint); font-size: 11px; flex-shrink: 0; }
    .empty {
      text-align: center;
      padding: 40px;
      color: var(--text-faint);
    }
    .empty a { color: var(--accent); }
    .empty-hint { margin-top: 10px; font-size: 11px; color: var(--text-faint); opacity: 0.8; }
    .empty-hint kbd {
      font: inherit; color: var(--text-muted);
      border: 1px solid var(--border); border-bottom-width: 2px;
      border-radius: 4px; padding: 0 5px;
    }
    .section { margin-bottom: 14px; }
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
      max-height: 420px;
      overflow-y: auto;
      font-size: 11px;
    }
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
    /* ---- Detail panel ---- */
    .detail-top { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
    .detail-pos { color: var(--text-muted); font-size: 11px; }
    .detail-id { margin-left: auto; color: var(--text-faint); font-size: 11px; }
    .btn {
      padding: 4px 10px;
      background: var(--btn-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text);
      cursor: pointer;
      font-family: inherit;
      font-size: 12px;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
    }
    .btn:hover { background: var(--border); }
    .btn[disabled] { opacity: 0.4; pointer-events: none; }
    .detail-req {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      padding: 10px 12px; background: var(--bg-surface);
      border: 1px solid var(--border); border-radius: 6px;
      margin-bottom: 8px; font-size: 12px;
    }
    .detail-url { flex: 1; min-width: 200px; word-break: break-all; }
    .chips {
      display: flex; flex-wrap: wrap; gap: 4px 18px;
      padding: 8px 12px; background: var(--bg-surface);
      border: 1px solid var(--border); border-radius: 6px;
      margin-bottom: 8px; font-size: 12px;
    }
    .chip { font-variant-numeric: tabular-nums; }
    .chip b { color: var(--text-muted); font-weight: 500; margin-right: 6px; }
    .turn { border: 1px solid var(--border); border-radius: 6px; margin-bottom: 8px; }
    .turn-role {
      display: flex; align-items: center; gap: 8px;
      padding: 5px 12px; font-size: 10px;
      text-transform: uppercase; letter-spacing: 0.05em;
      color: var(--text-muted);
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border);
    }
    .turn-user .turn-role { color: var(--accent); }
    .turn-assistant .turn-role { color: var(--green); }
    .turn-tag { color: var(--text-faint); text-transform: none; letter-spacing: 0; }
    .turn-usage {
      margin-left: auto; color: var(--text-faint); font-size: 10px;
      text-transform: none; letter-spacing: 0; font-variant-numeric: tabular-nums;
    }
    .turn-wire { color: var(--accent); font-size: 10px; text-transform: none; letter-spacing: 0; text-decoration: none; }
    .turn-wire:hover { text-decoration: underline; }
    .msg-text {
      padding: 10px 12px;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.5;
    }
    .msg-text.think { color: var(--text-muted); font-style: italic; }
    /* Long texts clamp with an explicit expander instead of an inner scrollbar,
       so the mouse wheel never gets trapped inside a turn. */
    .msg-clamp.clamped .msg-text {
      max-height: 380px;
      overflow: hidden;
      -webkit-mask-image: linear-gradient(to bottom, #000 85%, transparent);
      mask-image: linear-gradient(to bottom, #000 85%, transparent);
    }
    .msg-more {
      display: block;
      width: 100%;
      padding: 6px 12px;
      background: none;
      border: none;
      border-top: 1px dashed var(--border);
      color: var(--accent);
      cursor: pointer;
      font-family: inherit;
      font-size: 11px;
      text-align: left;
    }
    .msg-more:hover { background: var(--hover); }
    .block-note { padding: 6px 12px; color: var(--text-faint); font-size: 11px; }
    .fold > summary {
      display: flex; align-items: baseline; gap: 8px;
      padding: 7px 12px; cursor: pointer; user-select: none;
      font-size: 11px; color: var(--text-muted);
      list-style: none;
    }
    .fold > summary::-webkit-details-marker { display: none; }
    .fold > summary::before {
      content: '\\25B8';
      color: var(--text-faint);
      flex-shrink: 0;
      transition: transform 0.12s;
    }
    .fold[open] > summary::before { transform: rotate(90deg); }
    .fold > summary:hover { color: var(--text); }
    .fold-title { flex-shrink: 0; }
    .fold-hint {
      flex: 1; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: var(--text-faint);
    }
    .fold-body { border-top: 1px solid var(--border); }
    .fold-body > .pre-wrap > pre { border-radius: 0 0 6px 6px; }
    .turn .fold { border-top: 1px solid var(--border); }
    .fold.box { border: 1px solid var(--border); border-radius: 6px; margin-bottom: 8px; }
    .fold.errline > summary .fold-title { color: var(--red); }
    .sys-block { border-bottom: 1px dashed var(--border); }
    .sys-block:last-child { border-bottom: none; }
    .cc-tag { padding: 8px 12px 0; font-size: 10px; color: var(--amber); }
    .tool-row { display: flex; gap: 12px; padding: 6px 12px; border-top: 1px solid var(--border); font-size: 12px; }
    .tool-row:first-child { border-top: none; }
    .tool-name { flex: 0 0 160px; color: var(--text-method); overflow: hidden; text-overflow: ellipsis; }
    .tool-desc { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tool-res { border-top: 1px solid var(--border); }
    .tool-res-label { padding: 6px 12px 0; font-size: 10px; text-transform: uppercase; color: var(--text-faint); }
    .tool-res.errline .tool-res-label { color: var(--red); }
    .ubar-row { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; font-size: 12px; }
    .ubar-label { flex: 0 0 90px; }
    .ubar {
      flex: 0 1 240px; height: 8px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 99px; overflow: hidden;
    }
    .ubar-fill { display: block; height: 100%; border-radius: 99px; }
    .ubar-fill.ok { background: var(--green); }
    .ubar-fill.warn { background: var(--amber); }
    .ubar-fill.err { background: var(--red); }
    .ubar-pct { flex: 0 0 48px; text-align: right; font-variant-numeric: tabular-nums; }
    .ubar-resets { color: var(--text-faint); font-size: 11px; }
    /* ---- Session view components ---- */
    .thread { border: 1px solid var(--border); border-radius: 6px; margin-bottom: 6px; overflow: hidden; }
    .thread.selected { border-color: var(--accent); }
    .thread-head {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 10px; background: var(--bg-surface);
      color: inherit; text-decoration: none; cursor: pointer;
    }
    .thread-head:hover { background: var(--hover); }
    .tkind {
      padding: 1px 7px; border-radius: 999px; font-size: 10px;
      text-transform: uppercase; color: #fff; flex-shrink: 0;
    }
    .tkind-chat { background: var(--status-ok); }
    .tkind-agent { background: var(--purple); }
    .tkind-utility { background: var(--text-faint); }
    .thread-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .thread-meta { padding: 6px 10px; font-size: 11px; color: var(--text-muted); }
    .thread-reqs { border-top: 1px solid var(--border); }
    .treq {
      display: flex; gap: 10px; padding: 5px 10px; font-size: 11px;
      color: var(--text-muted); text-decoration: none;
      border-top: 1px dashed var(--border);
      font-variant-numeric: tabular-nums;
    }
    .treq:first-child { border-top: none; }
    .treq:hover { background: var(--hover); color: var(--text); }
    .treq-io { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .agent-note {
      padding: 8px 12px; margin-bottom: 8px;
      border: 1px dashed var(--purple); border-radius: 6px;
      font-size: 12px; color: var(--text-muted);
    }
    .agent-note a { color: var(--accent); }
  </style>
</head>
<body>
  <header>
    <span class="brand">${HEADER_LOGO}<h1>cctrace</h1></span>
    <span class="ctx" id="ctx"></span>
    <span class="status disconnected" id="status">offline</span>
    <span class="count"><span id="count">0</span> requests</span>
    <span class="header-actions">
      <button class="icon-btn" id="theme-toggle" title="Theme: system"></button>
      <a class="icon-btn" href="https://github.com/thevibeworks/cctrace" target="_blank" rel="noopener" title="GitHub">${GITHUB_ICON}</a>
    </span>
  </header>
  <div class="toolbar" id="toolbar">
    <span class="tabs">
      <button class="tab active" id="tab-requests">Requests</button>
      <button class="tab" id="tab-session">Session</button>
    </span>
    <input type="text" id="filter" placeholder="Filter by URL, method, status...  ( / )">
    <button id="prior-toggle" class="active" title="Show/hide requests merged from previous runs of this session">Prev runs</button>
    <button id="autoscroll" class="active">Auto-scroll</button>
    <button id="clear">Clear</button>
  </div>
  <div class="cats" id="cats"></div>
  <div id="split">
    <main id="pairs"></main>
    <aside id="detail"></aside>
  </div>
  <div id="session-view">
    <aside id="threads"></aside>
    <main id="convo"></main>
    <button id="tail-pill" title="Jump to the newest turn">↓ new activity</button>
  </div>

  <script>
    const pairs = [];
    // Snapshot pages embed their pairs in <head>; live pages stream over WS.
    const IS_SNAPSHOT = Array.isArray(window.__PAIRS__);
    let autoScroll = true;
    let filter = '';
    let activeCat = 'all';
    let showPrior = true;      // include prior-run pairs in the Requests list
    let view = 'requests';      // 'requests' | 'session'
    let detailId = null;        // request id open in the detail panel
    let sessionSelKey = null;   // selected thread in the session view
    let sessionCache = { n: -1, threads: [] };

    // Run identity injected by the server / snapshot writer ({} when unknown,
    // e.g. a snapshot rebuilt by \`cctrace view\`).
    const META = ${jsonForScript(meta)};

    // Category metadata + categorizer are injected from src/categorize.ts, the
    // single source of truth shared with the unit tests (no drift).
    const CATS = ${JSON.stringify(CATEGORIES)};
    const CAT_BY_ID = Object.fromEntries(CATS.map(c => [c.id, c]));
    const categorize = ${categorizeUrl.toString()};

    // Pure extraction/summary helpers injected from src/summarize.ts (unit
    // tested there; inlined here so live UI and snapshots stay identical).
    ${parseSse.toString()}
    ${fmtCompact.toString()}
    ${shortModel.toString()}
    ${extractMessageInfo.toString()}
    ${extractSessionId.toString()}
    ${extractTokenCount.toString()}
    ${extractUsageInfo.toString()}
    ${assembleAssistant.toString()}
    ${summarizePair.toString()}

    // Session reconstruction, injected from src/session.ts.
    ${threadSig.toString()}
    ${normalizeTurns.toString()}
    ${buildToolResultIndex.toString()}
    ${responseBlocks.toString()}
    ${buildSession.toString()}
    ${mainThread.toString()}
    ${toolPreview.toString()}

    const statusEl = document.getElementById('status');
    const countEl = document.getElementById('count');
    const pairsEl = document.getElementById('pairs');
    const detailEl = document.getElementById('detail');
    const threadsEl = document.getElementById('threads');
    const convoEl = document.getElementById('convo');
    const tailPill = document.getElementById('tail-pill');
    const filterEl = document.getElementById('filter');
    const autoScrollBtn = document.getElementById('autoscroll');
    const clearBtn = document.getElementById('clear');
    const priorToggle = document.getElementById('prior-toggle');
    const catsEl = document.getElementById('cats');
    const themeToggle = document.getElementById('theme-toggle');
    const tabRequests = document.getElementById('tab-requests');
    const tabSession = document.getElementById('tab-session');

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

    // ---- Header context: project name + current Claude session id ----

    const ctxEl = document.getElementById('ctx');
    if (META.project) document.title = META.project + ' \\u00b7 cctrace';

    // The session Claude is in right now: newest live pair wins; prior-run
    // pairs are the fallback so view-rebuilt snapshots still show an id.
    function currentSessionId() {
      let prior = '';
      for (let i = pairs.length - 1; i >= 0; i--) {
        const sid = extractSessionId(pairs[i]);
        if (!sid) continue;
        if (!pairs[i].prior) return sid;
        if (!prior) prior = sid;
      }
      return prior;
    }

    let ctxSid = null;
    function renderCtx() {
      const sid = currentSessionId();
      if (sid === ctxSid) return;
      ctxSid = sid;
      let html = '';
      if (META.project) {
        html += '<span class="ctx-proj" title="' + escapeHtml(META.projectPath || META.project) + '">' + escapeHtml(META.project) + '</span>';
      }
      if (sid) {
        if (html) html += '<span class="ctx-sep">\\u00b7</span>';
        html += '<button class="ctx-sess" title="session ' + escapeHtml(sid) + ' \\u2014 click to copy">' + escapeHtml(sid.slice(0, 8)) + '</button>';
      }
      ctxEl.innerHTML = html;
      const btn = ctxEl.querySelector('.ctx-sess');
      if (btn) btn.onclick = function() {
        navigator.clipboard.writeText(sid).then(function() {
          btn.classList.add('copied');
          btn.textContent = 'copied';
          setTimeout(function() { btn.classList.remove('copied'); btn.textContent = sid.slice(0, 8); }, 1200);
        });
      };
    }

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
        el.onclick = () => { activeCat = el.dataset.cat; render(); refreshDetailNav(); };
      });
    }

    function connect() {
      const ws = new WebSocket('ws://localhost:${port}/ws');
      ws.onopen = () => { statusEl.textContent = 'live'; statusEl.className = 'status connected'; };
      ws.onclose = () => {
        statusEl.textContent = 'offline'; statusEl.className = 'status disconnected';
        setTimeout(connect, 1000);
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'init') {
          pairs.length = 0;
          for (const p of msg.pairs) { p._cat = categorize(p.request.url); pairs.push(p); }
          render();
          route();
        } else if (msg.type === 'pair') {
          msg.pair._cat = categorize(msg.pair.request.url);
          pairs.push(msg.pair);
          countEl.textContent = pairs.length;
          renderCats();
          renderCtx();
          if (passesFilters(msg.pair)) {
            appendPair(msg.pair);
            if (autoScroll && !detailId) pairsEl.scrollTop = pairsEl.scrollHeight;
          }
          refreshDetailNav();
          if (view === 'session') showSession(sessionSelKey);
        } else if (msg.type === 'history') {
          // Prior-run pairs of a continued session: merge, resort, re-render.
          const known = new Set(pairs.map(p => p.id));
          for (const p of msg.pairs) {
            if (known.has(p.id)) continue;
            p._cat = categorize(p.request.url);
            pairs.push(p);
          }
          pairs.sort((a, b) => (a.request.timestamp || 0) - (b.request.timestamp || 0));
          render();
          refreshDetailNav();
          if (view === 'session') showSession(sessionSelKey);
        }
      };
    }

    function escapeHtml(str) {
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function formatJson(obj) {
      try { return escapeHtml(JSON.stringify(obj, null, 2)); } catch { return escapeHtml(String(obj)); }
    }
    function formatDuration(ms) { return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(2) + 's'; }
    function getStatusClass(status) {
      if (!status) return 'status-err';
      if (status >= 200 && status < 300) return 'status-2xx';
      if (status >= 400 && status < 500) return 'status-4xx';
      return 'status-5xx';
    }

    function passesFilters(pair) {
      if (pair.prior && !showPrior) return false;
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
    function visibleList() { return pairs.filter(passesFilters); }

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

    // ---- Requests list ----

    function shortUrl(u) {
      try {
        const url = new URL(u);
        return (url.hostname === 'api.anthropic.com' ? '' : url.hostname) + url.pathname;
      } catch { return String(u); }
    }

    function chipsHtml(pair) {
      const chips = summarizePair(pair, pair._cat);
      return chips.map(c =>
        '<span class="' + (c.c || '') + '"' + (c.title ? ' title="' + escapeHtml(c.title) + '"' : '') + '>' + escapeHtml(c.t) + '</span>'
      ).join('');
    }

    function appendPair(pair) {
      const { request, response, duration } = pair;
      const status = response ? response.status : 'ERR';
      const cat = CAT_BY_ID[pair._cat] || CAT_BY_ID.other;
      const div = document.createElement('div');
      div.className = 'pair' + (pair.id === detailId ? ' selected' : '') + (pair.prior ? ' prior' : '');
      div.dataset.id = pair.id;
      const when = new Date(request.timestamp * 1000);
      div.innerHTML =
        '<a class="pair-header" href="#/p/' + encodeURIComponent(pair.id) + '" title="' + escapeHtml(request.url) + '">' +
          '<span class="method">' + escapeHtml(request.method) + '</span>' +
          '<span class="status-code ' + getStatusClass(response && response.status) + '" title="HTTP ' + status + '">' + status + '</span>' +
          '<span class="cat-badge" style="--cat:' + cat.color + '" title="' + cat.label + '">' + cat.label + '</span>' +
          (pair.prior ? '<span class="prior-badge" title="from ' + escapeHtml(pair.prior) + '">prev</span>' : '') +
          '<span class="url">' + escapeHtml(shortUrl(request.url)) + '</span>' +
          '<span class="sum">' + chipsHtml(pair) + '</span>' +
          '<span class="duration" title="' + duration + 'ms">' + formatDuration(duration) + '</span>' +
          '<span class="time" title="' + when.toLocaleString() + '">' + (pair.prior ? when.toLocaleString() : when.toLocaleTimeString()) + '</span>' +
        '</a>';
      pairsEl.appendChild(div);
    }

    function render() {
      renderCats();
      renderCtx();
      priorToggle.classList.toggle('avail', pairs.some(p => p.prior));
      countEl.textContent = pairs.length;
      pairsEl.innerHTML = '';
      if (pairs.length === 0) {
        pairsEl.innerHTML = '<div class="empty">Waiting for requests...' +
          '<div class="empty-hint"><kbd>j</kbd> <kbd>k</kbd> walk requests \\u00b7 <kbd>/</kbd> filter \\u00b7 <kbd>Esc</kbd> close</div></div>';
        return;
      }
      let any = false;
      for (const p of pairs) {
        if (passesFilters(p)) { appendPair(p); any = true; }
      }
      if (!any) {
        pairsEl.innerHTML = '<div class="empty">No requests match this filter.</div>';
        return;
      }
      if (autoScroll && !detailId) pairsEl.scrollTop = pairsEl.scrollHeight;
      markSelected();
    }

    // ---- Routing: '' -> list, #/p/<id> -> detail panel, #/session[/<key>] ----

    function route() {
      const h = location.hash;
      let m;
      if ((m = h.match(/^#\\/p\\/(.+)$/))) {
        let id = m[1];
        try { id = decodeURIComponent(id); } catch {}
        setView('requests');
        openDetail(id);
      } else if ((m = h.match(/^#\\/session(?:\\/(.+))?$/))) {
        let key = m[1] || null;
        if (key) { try { key = decodeURIComponent(key); } catch {} }
        setView('session');
        showSession(key);
      } else {
        setView('requests');
        closeDetail();
      }
    }
    window.addEventListener('hashchange', route);

    function setView(v) {
      view = v;
      document.body.classList.toggle('view-session', v === 'session');
      tabRequests.classList.toggle('active', v === 'requests');
      tabSession.classList.toggle('active', v === 'session');
    }
    tabRequests.onclick = () => { location.hash = ''; };
    tabSession.onclick = () => { location.hash = '#/session'; };

    function openDetail(id) {
      const isNew = detailId !== id;
      detailId = id;
      document.body.classList.add('detail-open');
      detailEl.innerHTML = renderDetail(id);
      detailEl.querySelectorAll('details[data-raw][open]').forEach(fillRaw);
      if (isNew) detailEl.scrollTop = 0;
      countEl.textContent = pairs.length;
      markSelected();
    }

    function closeDetail() {
      if (detailId === null) { markSelected(); return; }
      detailId = null;
      document.body.classList.remove('detail-open');
      detailEl.innerHTML = '';
      markSelected();
    }

    function markSelected() {
      pairsEl.querySelectorAll('.pair.selected').forEach(el => el.classList.remove('selected'));
      if (!detailId) return;
      const esc = window.CSS && CSS.escape ? CSS.escape(detailId) : detailId;
      const el = pairsEl.querySelector('.pair[data-id="' + esc + '"]');
      if (el) { el.classList.add('selected'); el.scrollIntoView({ block: 'nearest' }); }
    }

    // prev/next walk the FILTERED list, not the full capture.
    function navDetail(step) {
      const vis = visibleList();
      if (!vis.length) return;
      const i = vis.findIndex(p => p.id === detailId);
      const next = i === -1 ? vis[0] : vis[i + step];
      if (next) location.hash = '#/p/' + encodeURIComponent(next.id);
    }
    window.navDetail = navDetail;

    document.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      if (e.key === '/') { filterEl.focus(); e.preventDefault(); return; }
      if (view === 'requests' && detailId) {
        if (e.key === 'Escape') location.hash = '';
        else if (e.key === 'j' || e.key === 'ArrowDown') { navDetail(1); e.preventDefault(); }
        else if (e.key === 'k' || e.key === 'ArrowUp') { navDetail(-1); e.preventDefault(); }
      } else if (view === 'session' && e.key === 'Escape') {
        location.hash = '';
      }
    });

    // ---- Detail panel ----

    function detailNavHtml(id) {
      const vis = visibleList();
      const vIdx = vis.findIndex(p => p.id === id);
      const pos = vIdx === -1
        ? 'filtered out'
        : (vIdx + 1) + ' / ' + vis.length + (vis.length !== pairs.length ? ' shown' : '');
      return '<div class="detail-top">' +
        '<a class="btn" href="#" title="Close (Esc)">\\u2715 close</a>' +
        '<button class="btn" onclick="navDetail(-1)"' + (vIdx <= 0 ? ' disabled' : '') + ' title="Previous shown request (k)">\\u2039 prev</button>' +
        '<button class="btn" onclick="navDetail(1)"' + (vIdx === -1 || vIdx >= vis.length - 1 ? ' disabled' : '') + ' title="Next shown request (j)">next \\u203a</button>' +
        '<span class="detail-pos">' + pos + '</span>' +
        '<span class="detail-id" title="request id">' + escapeHtml(id) + '</span>' +
      '</div>';
    }

    function refreshDetailNav() {
      if (!detailId) return;
      const nav = detailEl.querySelector('.detail-top');
      if (nav) nav.outerHTML = detailNavHtml(detailId);
    }

    function renderDetail(id) {
      const pair = pairs.find(p => p.id === id);
      if (!pair) {
        return detailNavHtml(id) + '<div class="empty">Request "' + escapeHtml(id) + '" not found' +
          (pairs.length === 0 ? ' (no requests loaded yet)' : '') +
          ' &mdash; <a href="#">back to list</a></div>';
      }
      const { request, response, duration } = pair;
      const cat = CAT_BY_ID[pair._cat] || CAT_BY_ID.other;
      const status = response ? response.status : 'ERR';

      let html = detailNavHtml(id) +
        '<div class="detail-req">' +
          '<span class="method">' + escapeHtml(request.method) + '</span>' +
          '<span class="status-code ' + getStatusClass(response && response.status) + '">' + status + '</span>' +
          '<span class="cat-badge" style="--cat:' + cat.color + '">' + cat.label + '</span>' +
          (pair.prior ? '<span class="prior-badge" title="merged from a previous run of this session">prev \\u00b7 ' + escapeHtml(pair.prior) + '</span>' : '') +
          '<span class="detail-url">' + escapeHtml(request.url) + '</span>' +
          '<span class="duration">' + formatDuration(duration) + '</span>' +
          '<span class="time">' + new Date(request.timestamp * 1000).toLocaleString() + '</span>' +
        '</div>';

      if (pair._cat === 'messages') html += messagesChips(pair) + renderConversation(pair);
      else if (pair._cat === 'tokens') html += tokensChips(pair) + renderConversation(pair);
      else if (pair._cat === 'usage') html += renderUsagePanel(pair);
      html += rawSections(pair);
      return html;
    }

    function kv(label, value, cls) {
      return '<span class="chip ' + (cls || '') + '"><b>' + label + '</b>' + value + '</span>';
    }

    function messagesChips(pair) {
      const m = extractMessageInfo(pair);
      let row1 = '';
      if (m.error) row1 += kv('error', escapeHtml(m.error), 'err');
      if (m.model) row1 += kv('model', escapeHtml(m.model), 'model');
      row1 += kv('stream', m.stream ? 'yes' : 'no');
      if (m.maxTokens != null) row1 += kv('max_tokens', m.maxTokens.toLocaleString());
      if (m.temperature != null) row1 += kv('temp', m.temperature);
      if (m.stopReason) row1 += kv('stop', escapeHtml(m.stopReason), m.stopReason === 'end_turn' || m.stopReason === 'tool_use' ? '' : 'warn');
      if (m.serviceTier) row1 += kv('tier', escapeHtml(m.serviceTier));
      if (m.error) return '<div class="chips">' + row1 + '</div>';
      let row2 = '';
      row2 += kv('input', m.input.toLocaleString());
      row2 += kv('output', m.output.toLocaleString());
      if (m.thinking > 0) row2 += kv('thinking', m.thinking.toLocaleString());
      row2 += kv('cache read', m.cacheRead.toLocaleString() +
        (m.cacheRead > 0 && m.cachePct != null ? ' (' + m.cachePct + '% of prompt)' : ''), m.cacheRead > 0 ? 'ok' : '');
      let cw = m.cacheWrite.toLocaleString();
      if (m.cacheWrite > 0) {
        const parts = [];
        if (m.cacheWrite5m > 0) parts.push(m.cacheWrite5m.toLocaleString() + ' 5m');
        if (m.cacheWrite1h > 0) parts.push(m.cacheWrite1h.toLocaleString() + ' 1h');
        if (parts.length) cw += ' (' + parts.join(' + ') + ')';
      }
      row2 += kv('cache write', cw, m.cacheWrite > 0 ? 'warn' : '');
      return '<div class="chips">' + row1 + '</div><div class="chips">' + row2 + '</div>';
    }

    function tokensChips(pair) {
      const t = extractTokenCount(pair);
      const req = pair.request.body || {};
      let out = '';
      if (t.model) out += kv('model', escapeHtml(t.model), 'model');
      if (t.tokens != null) out += kv('input tokens', t.tokens.toLocaleString(), 'ok');
      if (Array.isArray(req.messages)) out += kv('messages', req.messages.length);
      if (Array.isArray(req.tools) && req.tools.length) out += kv('tools', req.tools.length);
      return '<div class="chips">' + out + '</div>';
    }

    function fold(title, hint, body, cls, open) {
      return '<details class="fold ' + (cls || '') + '"' + (open ? ' open' : '') + '>' +
        '<summary><span class="fold-title">' + escapeHtml(title) + '</span>' +
        (hint ? '<span class="fold-hint">' + escapeHtml(hint) + '</span>' : '') +
        '</summary><div class="fold-body">' + body + '</div></details>';
    }

    function snippet(v, n) {
      let s = typeof v === 'string' ? v : (JSON.stringify(v) || '');
      s = s.replace(/\\s+/g, ' ').trim();
      return s.length > n ? s.slice(0, n) + '...' : s;
    }

    // Long texts render clamped with a "show all" expander; short ones inline.
    function textBlock(text, cls) {
      const t = String(text == null ? '' : text);
      const inner = '<div class="msg-text' + (cls ? ' ' + cls : '') + '">' + escapeHtml(t) + '</div>';
      if (t.length <= 2000) return inner;
      return '<div class="msg-clamp clamped">' + inner +
        '<button class="msg-more" onclick="toggleClamp(this)">show all \\u00b7 ' + fmtCompact(t.length) + ' chars</button></div>';
    }
    window.toggleClamp = function(btn) {
      const clamped = btn.parentElement.classList.toggle('clamped');
      if (clamped) {
        btn.textContent = btn.dataset.label;
        btn.parentElement.scrollIntoView({ block: 'nearest' });
      } else {
        btn.dataset.label = btn.textContent;
        btn.textContent = 'collapse';
      }
    };

    function renderBlock(b) {
      if (b == null) return '';
      if (typeof b === 'string') return textBlock(b);
      const type = b.type;
      if (type === 'text') return textBlock(b.text);
      if (type === 'thinking') {
        const t = b.thinking || '';
        if (!t) return '<div class="block-note">thinking (no visible content)</div>';
        return fold('thinking', fmtCompact(t.length) + ' chars \\u00b7 ' + snippet(t, 90), textBlock(t, 'think'));
      }
      if (type === 'redacted_thinking') return '<div class="block-note">redacted thinking</div>';
      if (type === 'tool_use' || type === 'server_tool_use') {
        return fold('tool_use \\u00b7 ' + (b.name || '?'), snippet(b.input, 110), preBlock(formatJson(b.input)));
      }
      if (type === 'tool_result') {
        let body = '';
        if (typeof b.content === 'string') body = textBlock(b.content);
        else if (Array.isArray(b.content)) { for (const c of b.content) body += renderBlock(c); }
        else body = preBlock(formatJson(b.content));
        const len = typeof b.content === 'string' ? fmtCompact(b.content.length) + ' chars \\u00b7 ' : '';
        return fold('tool_result' + (b.is_error ? ' \\u00b7 error' : ''), len + snippet(b.content, 90), body, b.is_error ? 'errline' : '');
      }
      if (type === 'image') {
        const mt = b.source && b.source.media_type;
        return '<div class="block-note">[image' + (mt ? ' \\u00b7 ' + escapeHtml(mt) : '') + ']</div>';
      }
      return fold(String(type || 'block'), '', preBlock(formatJson(b)));
    }

    function renderTurn(role, content, tag) {
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : (Array.isArray(content) ? content : []);
      let inner = '';
      for (const b of blocks) inner += renderBlock(b);
      return '<div class="turn turn-' + escapeHtml(String(role)) + '">' +
        '<div class="turn-role">' + escapeHtml(String(role)) +
        (tag ? '<span class="turn-tag">' + escapeHtml(tag) + '</span>' : '') +
        '</div>' + inner + '</div>';
    }

    function renderSystem(system) {
      const blocks = typeof system === 'string' ? [{ type: 'text', text: system }] : system;
      if (!Array.isArray(blocks) || !blocks.length) return '';
      let total = 0;
      let body = '';
      for (const b of blocks) {
        const text = (b && b.text) || '';
        total += text.length;
        const cc = b && b.cache_control
          ? '<div class="cc-tag">cache_control: ' + escapeHtml(b.cache_control.type + (b.cache_control.ttl ? ' ' + b.cache_control.ttl : '')) + '</div>'
          : '';
        body += '<div class="sys-block">' + cc + textBlock(text) + '</div>';
      }
      return fold('system prompt', blocks.length + ' block' + (blocks.length === 1 ? '' : 's') + ' \\u00b7 ' + fmtCompact(total) + ' chars', body, 'box');
    }

    function renderTools(tools) {
      let body = '';
      for (const t of tools) {
        const desc = String((t && t.description) || '').split('\\n')[0];
        body += '<div class="tool-row"><span class="tool-name">' + escapeHtml((t && t.name) || '?') + '</span><span class="tool-desc">' + escapeHtml(desc.slice(0, 200)) + '</span></div>';
      }
      const names = tools.map(t => (t && t.name) || '?').slice(0, 6).join(', ') + (tools.length > 6 ? ', ...' : '');
      return fold('tools \\u00b7 ' + tools.length, names, body, 'box');
    }

    function renderConversation(pair) {
      const req = pair.request.body || {};
      let html = '';
      if (req.system) html += renderSystem(req.system);
      if (Array.isArray(req.tools) && req.tools.length) html += renderTools(req.tools);
      for (const msg of (Array.isArray(req.messages) ? req.messages : [])) {
        html += renderTurn(msg.role, msg.content, '');
      }
      const resp = pair.response;
      if (resp) {
        let blocks = null;
        if (resp.body && Array.isArray(resp.body.content)) blocks = resp.body.content;
        else if (resp.bodyRaw) blocks = assembleAssistant(parseSse(resp.bodyRaw));
        if (blocks && blocks.length) html += renderTurn('assistant', blocks, 'response');
      }
      if (!html) return '';
      return '<div class="section"><h4>Conversation</h4>' + html + '</div>';
    }

    function relTime(iso) {
      const d = new Date(iso).getTime() - Date.now();
      if (!isFinite(d)) return '';
      const abs = Math.abs(d);
      const h = Math.floor(abs / 3600000), m = Math.floor((abs % 3600000) / 60000);
      const s = h >= 24 ? Math.floor(h / 24) + 'd ' + (h % 24) + 'h' : h > 0 ? h + 'h ' + m + 'm' : m + 'm';
      return d >= 0 ? 'in ' + s : s + ' ago';
    }

    function renderUsagePanel(pair) {
      const u = extractUsageInfo(pair);
      if (!u || !u.limits.length) return '';
      let rows = '';
      for (const l of u.limits) {
        const pct = typeof l.percent === 'number' ? l.percent : 0;
        const cls = (l.severity && l.severity !== 'normal') || pct >= 90 ? 'err' : pct >= 75 ? 'warn' : 'ok';
        rows += '<div class="ubar-row">' +
          '<span class="ubar-label">' + escapeHtml(l.label) + '</span>' +
          '<span class="ubar"><span class="ubar-fill ' + cls + '" style="width:' + Math.min(100, pct) + '%"></span></span>' +
          '<span class="ubar-pct">' + pct + '%</span>' +
          '<span class="ubar-resets"' + (l.resetsAt ? ' title="' + escapeHtml(l.resetsAt) + '"' : '') + '>' +
          (l.resetsAt ? 'resets ' + relTime(l.resetsAt) : '') + '</span>' +
        '</div>';
      }
      if (u.credits) {
        const d = Math.pow(10, u.credits.decimalPlaces);
        rows += '<div class="ubar-row"><span class="ubar-label">credits</span><span class="ubar-pct" style="flex:none">' +
          (u.credits.used / d) + ' / ' + (u.credits.limit / d) + ' ' + escapeHtml(u.credits.currency) + '</span></div>';
      }
      return '<div class="section"><h4>Usage limits</h4>' + rows + '</div>';
    }

    // Raw payloads render lazily on first expand — a full Claude Code request
    // body can be megabytes of JSON, so we only stringify when asked.
    function rawFold(title, kind, open) {
      return '<details class="fold box" data-raw="' + kind + '"' + (open ? ' open' : '') + '>' +
        '<summary><span class="fold-title">' + escapeHtml(title) + '</span></summary>' +
        '<div class="fold-body"></div></details>';
    }

    function rawSections(pair) {
      const r = pair.response;
      // For categories with a rich view the raw payloads stay collapsed; for
      // everything else the bodies are the content, so open them.
      const rich = pair._cat === 'messages' || pair._cat === 'tokens' || pair._cat === 'usage';
      let html = '<div class="section"><h4>Raw</h4>';
      html += rawFold('request headers', 'req-headers', false);
      if (pair.request.body != null) html += rawFold('request body', 'req-body', !rich);
      if (r) {
        html += rawFold('response headers', 'resp-headers', false);
        if (r.body != null) html += rawFold('response body', 'resp-body', !rich);
        if (r.bodyRaw) html += rawFold('response stream (SSE)', 'resp-raw', false);
      } else {
        html += '<div class="block-note err">request failed &mdash; no response received</div>';
      }
      return html + '</div>';
    }

    function fillRaw(det) {
      const body = det.querySelector(':scope > .fold-body');
      if (!body || body.dataset.filled) return;
      const pair = pairs.find(p => p.id === detailId);
      if (!pair) return;
      body.dataset.filled = '1';
      const kind = det.dataset.raw;
      let out = '';
      if (kind === 'req-headers') out = preBlock(formatJson(pair.request.headers));
      else if (kind === 'req-body') out = preBlock(formatJson(pair.request.body));
      else if (kind === 'resp-headers') out = preBlock(formatJson(pair.response.headers));
      else if (kind === 'resp-body') out = preBlock(formatJson(pair.response.body));
      else if (kind === 'resp-raw') {
        const raw = String(pair.response.bodyRaw || '');
        out = preBlock(escapeHtml(raw.slice(0, 200000)) + (raw.length > 200000 ? '\\n... (truncated)' : ''));
      }
      body.innerHTML = out;
    }

    detailEl.addEventListener('toggle', (e) => {
      const det = e.target;
      if (det && det.dataset && det.dataset.raw && det.open) fillRaw(det);
    }, true);

    // ---- Session view: wire threads (left) + reconstructed conversation ----

    function getThreads() {
      if (sessionCache.n !== pairs.length) {
        sessionCache = { n: pairs.length, threads: buildSession(pairs).threads };
      }
      return sessionCache.threads;
    }

    function showSession(key) {
      const threads = getThreads();
      if (!threads.length) {
        threadsEl.innerHTML = '';
        convoEl.innerHTML = '<div class="empty">No /v1/messages requests captured yet.</div>';
        convoKey = null;
        tailPill.classList.remove('show');
        return;
      }
      let sel = null;
      for (const t of threads) if (t.key === key) sel = t;
      if (!sel) sel = mainThread(threads);
      sessionSelKey = sel.key;
      renderThreadsPane(threads, sel);
      renderConvoPane(sel);
    }

    function threadCard(t, selected) {
      const u = t.usage;
      const meta = u.requests + ' req \\u00b7 in ' + fmtCompact(u.input) + ' \\u00b7 out ' + fmtCompact(u.output) +
        (u.cacheRead ? ' \\u00b7 cache ' + fmtCompact(u.cacheRead) : '');
      let reqs = '';
      if (selected) {
        let rows = '';
        for (const pid of t.pairIds) {
          const p = pairs.find(x => x.id === pid);
          if (!p) continue;
          const m = extractMessageInfo(p);
          rows += '<a class="treq" href="#/p/' + encodeURIComponent(pid) + '" title="open wire request' + (p.prior ? ' (prev run: ' + escapeHtml(p.prior) + ')' : '') + '">' +
            '<span>' + new Date(p.request.timestamp * 1000).toLocaleTimeString() + '</span>' +
            '<span class="treq-io">in ' + fmtCompact(m.input + m.cacheRead + m.cacheWrite) + ' \\u00b7 out ' + fmtCompact(m.output) + '</span>' +
            '<span>' + formatDuration(p.duration) + '</span></a>';
        }
        reqs = '<div class="thread-reqs">' + rows + '</div>';
      }
      return '<div class="thread' + (selected ? ' selected' : '') + '">' +
        '<a class="thread-head" href="#/session/' + encodeURIComponent(t.key) + '">' +
          '<span class="tkind tkind-' + t.kind + '">' + t.kind + '</span>' +
          '<span class="thread-label">' + escapeHtml(t.label) + '</span>' +
        '</a>' +
        '<div class="thread-meta">' + meta + '</div>' + reqs + '</div>';
    }

    function renderThreadsPane(threads, sel) {
      const convos = threads.filter(t => t.kind !== 'utility');
      const utils = threads.filter(t => t.kind === 'utility');
      let html = '';
      for (const t of convos) html += threadCard(t, t.key === sel.key);
      if (utils.length) {
        let inner = '';
        for (const t of utils) inner += threadCard(t, t.key === sel.key);
        html += fold('utility \\u00b7 ' + utils.length, 'probes, title generation', inner, 'box', utils.some(t => t.key === sel.key));
      }
      const top = threadsEl.scrollTop; // live re-renders must not move the list
      threadsEl.innerHTML = html;
      threadsEl.scrollTop = top;
    }

    // Tools that mutate or spawn work render expanded (ccx convention);
    // read-only lookups stay folded.
    const ACTIVE_TOOLS = { Bash: 1, Write: 1, Edit: 1, NotebookEdit: 1, Task: 1, Agent: 1, TaskCreate: 1, Skill: 1, AskUserQuestion: 1 };

    function renderBlockS(b, results) {
      if (b && (b.type === 'tool_use' || b.type === 'server_tool_use')) {
        const name = b.name || '?';
        const pv = toolPreview(name, b.input) || snippet(b.input, 110);
        let body = preBlock(formatJson(b.input));
        const res = results[b.id];
        if (res) {
          let rbody = '';
          if (typeof res.content === 'string') rbody = textBlock(res.content);
          else if (Array.isArray(res.content)) { for (const c of res.content) rbody += renderBlock(c); }
          else rbody = preBlock(formatJson(res.content));
          body += '<div class="tool-res' + (res.is_error ? ' errline' : '') + '">' +
            '<div class="tool-res-label">result' + (res.is_error ? ' \\u00b7 error' : '') + '</div>' + rbody + '</div>';
        } else {
          body += '<div class="block-note">no result captured</div>';
        }
        return fold(name, pv, body, res && res.is_error ? 'errline' : '', !!ACTIVE_TOOLS[name]);
      }
      return renderBlock(b);
    }

    function renderSessionTurn(turn, results) {
      let inner = '';
      for (const b of turn.blocks) inner += renderBlockS(b, results);
      let meta = '';
      if (turn.role === 'assistant' && turn.usage) {
        const u = turn.usage;
        const p = turn.pairId ? pairs.find(x => x.id === turn.pairId) : null;
        const bits = [];
        if (u.model) bits.push(shortModel(u.model));
        bits.push('in ' + fmtCompact(u.input));
        bits.push('out ' + fmtCompact(u.output));
        if (u.cacheRead) bits.push('cache ' + fmtCompact(u.cacheRead));
        if (p) bits.push(formatDuration(p.duration));
        meta = '<span class="turn-usage">' + bits.join(' \\u00b7 ') + '</span>' +
          (turn.pairId ? '<a class="turn-wire" href="#/p/' + encodeURIComponent(turn.pairId) + '" title="open wire request">wire</a>' : '');
      }
      return '<div class="turn turn-' + escapeHtml(String(turn.role)) + '">' +
        '<div class="turn-role">' + escapeHtml(String(turn.role)) + meta + '</div>' + inner + '</div>';
    }

    // ---- Live tail ----
    // The conversation pane behaves like tail -f: opening a session live
    // (including a page refresh) lands on the newest turn, re-renders stick
    // to the bottom while you're there, and never yank the view while you're
    // reading history — new activity surfaces as a pill instead. Snapshots
    // open at the top: reviewing a finished session is reading, not tailing.
    let convoKey = null;   // thread key currently rendered in the convo pane
    const TAIL_SLACK = 60; // px from the bottom that still counts as tailing

    function convoAtBottom() {
      return convoEl.scrollHeight - convoEl.scrollTop - convoEl.clientHeight < TAIL_SLACK;
    }
    function convoToBottom() {
      convoEl.scrollTop = convoEl.scrollHeight;
      tailPill.classList.remove('show');
    }
    tailPill.onclick = convoToBottom;
    convoEl.addEventListener('scroll', () => {
      if (convoAtBottom()) tailPill.classList.remove('show');
    });

    function renderConvoPane(t) {
      const sameThread = convoKey === t.key;
      const stick = sameThread && convoAtBottom();
      const prevTop = convoEl.scrollTop;
      const prevHeight = convoEl.scrollHeight;
      // Fold state survives re-renders positionally: turns only mutate at the
      // tail (new turns append; the last one re-reconstructs), so details N
      // is the same fold before and after for everything the user toggled.
      const foldState = sameThread
        ? Array.prototype.map.call(convoEl.querySelectorAll('details'), d => d.open)
        : null;
      let chips = '';
      chips += kv('model', escapeHtml(t.model || '?'), 'model');
      chips += kv('requests', t.usage.requests);
      chips += kv('input', t.usage.input.toLocaleString());
      chips += kv('output', t.usage.output.toLocaleString());
      if (t.usage.cacheRead) chips += kv('cache read', t.usage.cacheRead.toLocaleString(), 'ok');
      if (t.usage.cacheWrite) chips += kv('cache write', t.usage.cacheWrite.toLocaleString(), 'warn');
      let html = '<div class="chips">' + chips + '</div>';
      if (t.agentOf) {
        html += '<div class="agent-note">subagent run' +
          (t.agentOf.agentType ? ' \\u00b7 [' + escapeHtml(t.agentOf.agentType) + '] ' + escapeHtml(t.agentOf.description || '') : '') +
          ' \\u2014 dispatched by <a href="#/session/' + encodeURIComponent(t.agentOf.thread) + '">parent thread</a></div>';
      }
      if (t.system) html += renderSystem(t.system);
      if (t.tools && t.tools.length) html += renderTools(t.tools);
      const results = buildToolResultIndex(t.turns);
      for (const turn of t.turns) {
        if (turn.toolResultsOnly) continue; // results fold into their tool_use
        html += renderSessionTurn(turn, results);
      }
      convoEl.innerHTML = html;
      if (foldState) {
        const details = convoEl.querySelectorAll('details');
        for (let i = 0; i < details.length && i < foldState.length; i++) details[i].open = foldState[i];
      }
      convoKey = t.key;
      if (!sameThread) {
        convoEl.scrollTop = IS_SNAPSHOT ? 0 : convoEl.scrollHeight;
        tailPill.classList.remove('show');
      } else if (stick) {
        convoToBottom();
      } else {
        convoEl.scrollTop = prevTop;
        if (convoEl.scrollHeight > prevHeight) tailPill.classList.add('show');
      }
    }

    filterEl.oninput = () => { filter = filterEl.value; render(); refreshDetailNav(); };
    priorToggle.onclick = () => {
      showPrior = !showPrior;
      priorToggle.classList.toggle('active', showPrior);
      render();
      refreshDetailNav();
    };
    autoScrollBtn.onclick = () => {
      autoScroll = !autoScroll;
      autoScrollBtn.classList.toggle('active', autoScroll);
    };
    clearBtn.onclick = () => {
      pairs.length = 0;
      activeCat = 'all';
      sessionCache = { n: -1, threads: [] };
      convoKey = null;
      tailPill.classList.remove('show');
      if (detailId) location.hash = '';
      render();
    };

    renderCats();
    // Offline snapshot: if pairs are embedded (static export), load them and
    // skip the WebSocket. Otherwise connect live.
    if (IS_SNAPSHOT) {
      for (const p of window.__PAIRS__) { p._cat = categorize(p.request.url); pairs.push(p); }
      statusEl.textContent = 'snapshot';
      statusEl.className = 'status snapshot';
      autoScroll = false;
      autoScrollBtn.classList.remove('active');
    } else {
      connect();
    }
    render();
    route();
  </script>
</body>
</html>`;
}

/**
 * Self-contained static HTML with the pairs embedded — same UI as the live
 * view, but loads from window.__PAIRS__ and skips the WebSocket. For offline
 * review of a saved .jsonl trace.
 */
export function renderSnapshot(tracePairs: TracePair[], meta: PageMeta = {}): string {
  const html = getLiveHtml(0, meta);
  // Inject before </head> so __PAIRS__ is defined before the body script runs.
  const inject = `<script>window.__PAIRS__ = ${jsonForScript(tracePairs)};</script>`;
  // Function replacement: a string replacement would $-substitute the payload
  // ($$ collapses, $& / $` splice document text into the JSON) — captured
  // conversations about code contain those daily.
  return html.replace("</head>", () => `${inject}\n</head>`);
}

/**
 * JSON.stringify for embedding inside an inline <script>. Plain stringify is
 * unsafe here: a captured payload containing the literal "</script>" (common
 * when Claude is discussing HTML) closes the tag early and the browser throws
 * "Invalid or unexpected token". Escaping "<" as \u003c makes any tag-like
 * substring inert; U+2028/U+2029 are valid in JSON but are newlines to a JS
 * parser, so escape those too. All three decode back to the original on parse.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
