import type { TracePair } from "./types";
import { CATEGORIES, categorizeUrl } from "./categorize";
import { wireTables } from "./clients";
import {
  parseSse,
  fmtCompact,
  fmtBytes,
  fmtMs,
  extractLatency,
  extractSizes,
  shortModel,
  extractMessageInfo,
  extractCallInfo,
  extractSessionId,
  extractTokenCount,
  extractUsageInfo,
  assembleAssistant,
  summarizePair,
  hasCacheControl,
  summarizeCache,
} from "./summarize";
import {
  wireDialect,
  openaiCompleted,
  openaiBlocks,
  normalizeOpenaiTurns,
  openaiSystemText,
  openaiTools,
  openaiFirstUserText,
  extractOpenaiInfo,
} from "./dialects/openai";
import {
  firstUserText,
  threadSig,
  normalizeTurns,
  turnContentSig,
  buildToolResultIndex,
  responseBlocks,
  buildSession,
  mainThread,
  toolPreview,
} from "./session";
import { modelPricing, pairCost, fmtCost, costTitle } from "./pricing";
import {
  pairStartMs,
  pairEndMs,
  isTurnPair,
  replayEvents,
  replaySpan,
  visibleAt,
  nextBoundary,
  prevBoundary,
  anchorAt,
  nextTick,
} from "./replay";

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
  /** CLI being traced: claude | codex | grok. */
  client?: string;
  /** cctrace version that produced this page/snapshot. */
  version?: string;
  /** Newer version known from the update check, if any. */
  latestVersion?: string;
  /** models.dev pricing catalog (src/pricing-catalog.ts) for cost chips. */
  pricing?: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>;
}

export function getLiveHtml(meta: PageMeta = {}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CCTrace</title>
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
    .ctx-client {
      display: inline-flex; align-items: center; gap: 5px;
      border: 1px solid var(--border); border-radius: 4px;
      padding: 1px 6px; font-size: 11px; color: var(--text-muted); flex: none;
    }
    .ctx-ico { width: 11px; height: 11px; flex-shrink: 0; }
    .ctx-sep { color: var(--text-faint); }
    .ctx-sess {
      font: inherit; color: var(--text-muted); cursor: pointer; flex-shrink: 0;
      background: var(--btn-bg); border: 1px solid var(--border);
      border-radius: 6px; padding: 1px 7px;
    }
    .ctx-sess:hover { color: var(--text); }
    .ctx-sess.copied { color: var(--green); border-color: var(--green); }
    /* Version badge: sits with the brand — what produced the page is a
       brand fact, separate from the run identity in .ctx. */
    .ver { display: inline-flex; align-items: baseline; gap: 6px; flex-shrink: 0; margin-left: 2px; }
    .ver-badge { color: var(--text-faint); font-size: 11px; }
    .ver-upd {
      color: var(--amber); font-size: 11px;
      text-decoration: none; border-bottom: 1px dashed var(--amber);
    }
    /* Instance switcher: appears only when other live cctrace runs exist. */
    .inst { position: relative; flex-shrink: 0; }
    .inst-btn {
      font: inherit; font-size: 12px; color: var(--text-muted); cursor: pointer;
      background: var(--btn-bg); border: 1px solid var(--border);
      border-radius: 6px; padding: 1px 7px;
    }
    .inst-btn:hover { color: var(--text); border-color: var(--accent); }
    .inst-menu {
      display: none; position: absolute; top: calc(100% + 8px); left: 0; z-index: 30;
      min-width: 260px; padding: 4px;
      background: var(--bg-surface); border: 1px solid var(--border); border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.35);
    }
    .inst-menu.open { display: block; }
    .inst-row {
      display: flex; align-items: baseline; gap: 8px;
      padding: 6px 10px; border-radius: 5px;
      color: var(--text); text-decoration: none; font-size: 12px;
      white-space: nowrap;
    }
    .inst-row:hover { background: var(--hover); }
    .inst-sess { color: var(--text-muted); font-size: 11px; }
    .inst-port { margin-left: auto; color: var(--text-faint); font-size: 11px; font-variant-numeric: tabular-nums; }
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
    /* Live arrivals only: one 160ms opacity fade says "this row just landed"
       — feedback, not ceremony (motion budget in docs/design/ui.md). Bulk
       renders and filter re-renders never animate; opacity-only keeps it
       acceptable under prefers-reduced-motion (movement is what's removed). */
    @keyframes arrive { from { opacity: 0; } }
    .pair.arrived { animation: arrive 160ms cubic-bezier(0.23, 1, 0.32, 1); }
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
    #split { flex: 1; display: flex; min-height: 0; position: relative; }
    body.view-session #split { display: none; }
    #pairs { flex: 1; min-width: 0; overflow-y: auto; padding: 8px; }
    #detail {
      display: none;
      min-width: 0;
      overflow-y: auto;
      padding: 0 16px 12px;
      border-left: 1px solid var(--border);
    }
    body.detail-open #detail { display: block; flex: 0 0 60%; max-width: 60%; }
    @media (max-width: 960px) {
      body.detail-open #pairs { display: none; }
      body.detail-open #detail { flex: 1; max-width: 100%; border-left: none; }
    }
    /* ---- Session view: threads + conversation ---- */
    #session-view { display: none; flex: 1; min-height: 0; position: relative; flex-direction: column; }
    body.view-session #session-view { display: flex; }
    #session-main { display: flex; flex: 1; min-height: 0; position: relative; }
    #threads { flex: 0 0 320px; min-width: 0; overflow-y: auto; padding: 8px; border-right: 1px solid var(--border); }
    #convo { flex: 1; min-width: 0; overflow-y: auto; padding: 12px 16px; }
    @media (max-width: 960px) { #threads { flex-basis: 220px; } }
    /* ---- Replay transport bar (body.replaying) ---- */
    #replay-toggle { display: none; }
    body.view-session #replay-toggle { display: inline-block; }
    body.replaying #replay-toggle { background: var(--accent); border-color: var(--accent); color: #fff; }
    #replay-bar {
      display: none; align-items: center; gap: 8px;
      padding: 7px 16px;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border);
      font-size: 12px;
    }
    body.replaying #replay-bar { display: flex; }
    .rp-btn {
      font: inherit; font-size: 12px; line-height: 1;
      background: var(--btn-bg); border: 1px solid var(--border);
      border-radius: 4px; color: var(--text); cursor: pointer;
      padding: 4px 9px;
    }
    .rp-btn:hover { border-color: var(--accent); }
    .rp-speeds { display: inline-flex; gap: 2px; }
    .rp-speed {
      font: inherit; font-size: 11px; line-height: 1;
      background: none; border: 1px solid transparent; border-radius: 4px;
      color: var(--text-faint); cursor: pointer; padding: 4px 6px;
      font-variant-numeric: tabular-nums;
    }
    .rp-speed:hover { color: var(--text); }
    .rp-speed.active { color: var(--accent); border-color: var(--border); background: var(--bg); }
    #rp-track {
      flex: 1; min-width: 80px; position: relative; height: 24px;
      cursor: pointer; touch-action: none;
    }
    #rp-track::before {
      content: ''; position: absolute; left: 0; right: 0; top: 50%;
      border-top: 1px solid var(--border);
    }
    #rp-fill {
      position: absolute; left: 0; top: 0; bottom: 0; width: 0;
      background: color-mix(in srgb, var(--accent) 14%, transparent);
      pointer-events: none;
    }
    #rp-marks { position: absolute; inset: 0; pointer-events: none; }
    .rp-mark {
      position: absolute; top: 50%; width: 2px; height: 7px;
      transform: translate(-1px, -50%);
      background: var(--text-faint); opacity: 0.7;
    }
    .rp-mark.turn { height: 13px; background: var(--accent); opacity: 0.9; }
    .rp-mark.err { background: var(--red); opacity: 1; }
    #rp-handle {
      position: absolute; top: 2px; bottom: 2px; width: 2px; left: 0;
      background: var(--accent); pointer-events: none;
      box-shadow: 0 0 4px color-mix(in srgb, var(--accent) 60%, transparent);
    }
    #rp-time { color: var(--text-muted); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    #rp-time .rp-skip { color: var(--text-faint); }
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
    .size { color: var(--text-faint); font-size: 11px; min-width: 84px; text-align: right; flex-shrink: 0; font-variant-numeric: tabular-nums; }
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
    .broken-item {
      margin: 4px 0; padding: 6px 10px;
      font-size: 11px; color: var(--red);
      border: 1px dashed color-mix(in srgb, currentColor 40%, transparent);
      border-radius: 6px; overflow-wrap: anywhere;
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
    /* Sticky: prev/next/close stay reachable while scrolled deep into a
       megabyte conversation. Solid bg so content never bleeds through. */
    .detail-top {
      display: flex; align-items: center; gap: 8px;
      position: sticky; top: 0; z-index: 4;
      background: var(--bg);
      padding: 10px 0; margin-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }
    .detail-pos { color: var(--text-muted); font-size: 11px; }
    .detail-id { margin-left: auto; color: var(--text-faint); font-size: 11px; overflow: hidden; text-overflow: ellipsis; }
    .btn-icon { padding: 4px 8px; font-size: 13px; line-height: 1; }
    /* ---- In-document nav rail (session convo + detail panel) ----
       Quiet until hovered; every affordance repeats a keyboard shortcut. */
    .nav-rail {
      position: absolute; right: 18px; top: 12px; z-index: 6;
      display: flex; flex-direction: column; gap: 2px;
      opacity: 0.45;
    }
    .nav-rail:hover, .nav-rail:focus-within { opacity: 1; }
    .nav-rail button {
      width: 26px; height: 22px; padding: 0;
      display: inline-flex; align-items: center; justify-content: center;
      background: var(--bg-surface); border: 1px solid var(--border);
      border-radius: 4px; color: var(--text-muted); cursor: pointer;
      font: inherit; font-size: 11px; line-height: 1;
    }
    .nav-rail button:hover { color: var(--text); border-color: var(--accent); }
    .nav-rail .rail-gap { height: 6px; }
    #rail-detail { display: none; top: 48px; }
    body.detail-open #rail-detail { display: flex; }
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
    /* User turns anchor the reading rhythm: extra space above starts the
       "paragraph", a faint accent wash on the header row guides a scanning
       eye. No hard border — a colored edge reads as UI chrome, not emphasis,
       and accent is reserved for interactive things. */
    .turn-user .turn-role {
      color: var(--accent);
      background: color-mix(in srgb, var(--accent) 9%, var(--bg-surface));
    }
    .turn-user { margin-top: 18px; }
    .turn-user:first-child { margin-top: 0; }
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
    /* Markdown subset inside assistant text (renderMd). Same type scale,
       no new colors: emphasis comes from weight and hairline boxes. */
    .msg-text code {
      background: var(--bg-surface); border: 1px solid var(--border);
      border-radius: 3px; padding: 0 4px; font-size: 11px;
    }
    .msg-text .md-code { margin: 6px 0; font-size: 11px; }
    .msg-text .md-h { font-weight: 600; color: var(--text); margin: 8px 0 2px; }
    .msg-text a { color: var(--accent); }
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
    /* Small mode buttons living inside a fold summary (headers raw toggle,
       body pretty/raw toggle, copy). Quiet until hovered, like the rail. */
    .fold-btn {
      font: inherit; font-size: 10px; line-height: 1; flex-shrink: 0;
      background: none; border: 1px solid var(--border); border-radius: 4px;
      color: var(--text-faint); cursor: pointer; padding: 2px 7px;
    }
    .fold-btn:hover { color: var(--text); border-color: var(--accent); }
    .fold-btn.copied { color: var(--green); border-color: var(--green); }
    /* Headers section: parsed k/v table by default, raw text when toggled. */
    .hdr-table { padding: 4px 0; font-size: 11px; }
    .hdr-row { display: flex; gap: 12px; padding: 2px 12px; }
    .hdr-row:hover { background: var(--hover); }
    .hdr-k { flex: 0 0 200px; min-width: 110px; color: var(--text-muted); overflow-wrap: anywhere; }
    .hdr-v { flex: 1; min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
    .hdr-fold .hdr-pre { display: none; }
    .hdr-fold[data-alt="1"] .hdr-table { display: none; }
    .hdr-fold[data-alt="1"] .hdr-pre { display: block; }
    .turn .fold { border-top: 1px solid var(--border); }
    .fold.box { border: 1px solid var(--border); border-radius: 6px; margin-bottom: 8px; }
    .fold.errline > summary .fold-title { color: var(--red); }
    /* Notable tool events keep their color even folded: subagent spawns,
       skill invocations, MCP calls. Everything else stays quiet. */
    .fold.fold-agent > summary .fold-title,
    .fold.fold-skill > summary .fold-title,
    .fold.fold-mcp > summary .fold-title { color: var(--purple); }
    .fold.fold-agent > summary .fold-hint { color: var(--text-muted); }
    .fold-link { color: var(--accent); font-size: 11px; text-decoration: none; flex: none; margin-left: auto; }
    .fold-link:hover { text-decoration: underline; }
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
    /* Session rollup line above the thread cards: counts across all threads,
       error parts red and only present when nonzero. */
    .threads-sum {
      padding: 4px 10px 8px; font-size: 11px; color: var(--text-faint);
      font-variant-numeric: tabular-nums;
    }
    .thread-reqs { border-top: 1px solid var(--border); }
    .treq {
      display: flex; gap: 10px; padding: 5px 10px; font-size: 11px;
      color: var(--text-muted); text-decoration: none;
      border-top: 1px dashed var(--border);
      font-variant-numeric: tabular-nums;
    }
    .treq:first-child { border-top: none; }
    .treq:hover { background: var(--hover); color: var(--text); }
    /* prompt-cache verdict per wire request: green hit, amber cold/miss */
    .cdot {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--border); flex: none; align-self: center;
    }
    .cdot-hit { background: var(--green); }
    .cdot-cold, .cdot-miss { background: var(--amber); }
    .treq-io { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .agent-note {
      padding: 8px 12px; margin-bottom: 8px;
      border: 1px dashed var(--purple); border-radius: 6px;
      font-size: 12px; color: var(--text-muted);
    }
    .rewound-mark {
      padding: 4px 12px; margin: 6px 0;
      font-size: 11px; color: var(--text-faint);
      border-left: 2px dashed var(--warn, #d29922);
    }
    .rewound-mark a { color: var(--text-muted); }
    .agent-note a { color: var(--accent); }
  </style>
</head>
<body>
  <header>
    <span class="brand">${HEADER_LOGO}<h1>cctrace</h1><span class="ver" id="ver"></span></span>
    <span class="ctx" id="ctx"></span>
    <span class="inst" id="inst"></span>
    <span class="count"><span id="count">0</span> requests</span>
    <span class="status disconnected" id="status">offline</span>
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
    <button id="replay-toggle" title="Replay this session — ←/→ step turns, Space plays">⏵ replay</button>
    <button id="prior-toggle" class="active" title="Show/hide requests merged from previous runs of this session">Prev runs</button>
    <button id="autoscroll" class="active">Auto-scroll</button>
    <button id="clear">Clear</button>
  </div>
  <div class="cats" id="cats"></div>
  <div id="split">
    <main id="pairs"></main>
    <aside id="detail"></aside>
    <div class="nav-rail" id="rail-detail"></div>
  </div>
  <div id="session-view">
    <div id="replay-bar">
      <button class="rp-btn" id="rp-restart" title="Jump to start (Home)">⏮</button>
      <button class="rp-btn" id="rp-play" title="Play / pause (Space) — idle gaps compressed to ≤2s">▶</button>
      <span class="rp-speeds">
        <button class="rp-speed active" data-speed="1">1x</button>
        <button class="rp-speed" data-speed="2">2x</button>
        <button class="rp-speed" data-speed="8">8x</button>
        <button class="rp-speed" data-speed="60">60x</button>
      </span>
      <div id="rp-track" title="Drag to scrub — ticks are wire requests, tall marks are turns">
        <div id="rp-fill"></div>
        <div id="rp-marks"></div>
        <div id="rp-handle"></div>
      </div>
      <span id="rp-time">0:00 / 0:00</span>
      <button class="rp-btn" id="rp-exit"></button>
    </div>
    <div id="session-main">
      <aside id="threads"></aside>
      <main id="convo"></main>
      <div class="nav-rail" id="rail-session"></div>
    </div>
    <button id="tail-pill" title="Jump to the newest turn">↓ new activity</button>
  </div>

  <script>
    const pairs = [];
    // Snapshot pages embed their pairs in <head>; live pages stream over WS.
    const IS_SNAPSHOT = Array.isArray(window.__PAIRS__);
    // Every pair enters through here: a structurally broken one (no request
    // object / url — a torn trace line or a capture bug) is dropped with a
    // console note. Renderers, buildSession, and the replay timeline all
    // assume request.url exists; one bad pair must not blank the page.
    let droppedPairs = 0;
    function ingestPair(p) {
      if (!p || !p.request || typeof p.request.url !== 'string') {
        droppedPairs++;
        console.warn('[cctrace] dropped broken pair', droppedPairs, p);
        return false;
      }
      p._cat = categorize(p.request.url, p.client, CLIENT_WIRE);
      pairs.push(p);
      return true;
    }
    let autoScroll = true;
    let filter = '';
    let activeCat = 'all';
    let showPrior = true;      // include prior-run pairs in the Requests list
    let view = 'requests';      // 'requests' | 'session'
    let detailId = null;        // request id open in the detail panel
    let sessionSelKey = null;   // selected thread in the session view
    let sessionCache = { key: '', threads: [] };

    // Run identity injected by the server / snapshot writer ({} when unknown,
    // e.g. a snapshot rebuilt by \`cctrace view\`).
    const META = ${jsonForScript(meta)};
    // modelPricing consults the ambient models.dev catalog (fail-soft: the
    // embedded Claude table still prices Claude traffic without it).
    if (META.pricing) window.__PRICING__ = META.pricing;

    // Category metadata + categorizer are injected from src/categorize.ts, the
    // single source of truth shared with the unit tests (no drift). The
    // per-client wire tables come from src/clients — data, not code, so the
    // plugin boundary stays in the source tree while the page stays flat.
    const CATS = ${JSON.stringify(CATEGORIES)};
    const CAT_BY_ID = Object.fromEntries(CATS.map(c => [c.id, c]));
    const CLIENT_WIRE = ${jsonForScript(wireTables())};
    const categorize = ${categorizeUrl.toString()};

    // Pure extraction/summary helpers injected from src/summarize.ts (unit
    // tested there; inlined here so live UI and snapshots stay identical).
    ${parseSse.toString()}
    ${fmtCompact.toString()}
    ${fmtBytes.toString()}
    ${fmtMs.toString()}
    ${extractLatency.toString()}
    ${extractSizes.toString()}
    ${shortModel.toString()}
    ${extractMessageInfo.toString()}
    ${extractCallInfo.toString()}
    ${extractSessionId.toString()}

    // OpenAI Responses dialect (codex/grok), injected from src/dialects/openai.ts.
    ${wireDialect.toString()}
    ${openaiCompleted.toString()}
    ${openaiBlocks.toString()}
    ${normalizeOpenaiTurns.toString()}
    ${openaiSystemText.toString()}
    ${openaiTools.toString()}
    ${openaiFirstUserText.toString()}
    ${extractOpenaiInfo.toString()}
    ${extractTokenCount.toString()}
    ${extractUsageInfo.toString()}
    ${assembleAssistant.toString()}
    ${hasCacheControl.toString()}
    ${summarizeCache.toString()}
    ${summarizePair.toString()}

    // Pricing + cost estimation, injected from src/pricing.ts.
    ${modelPricing.toString()}
    ${pairCost.toString()}
    ${fmtCost.toString()}
    ${costTitle.toString()}

    // Replay timeline primitives, injected from src/replay.ts.
    ${pairStartMs.toString()}
    ${pairEndMs.toString()}
    ${isTurnPair.toString()}
    ${replayEvents.toString()}
    ${replaySpan.toString()}
    ${visibleAt.toString()}
    ${nextBoundary.toString()}
    ${prevBoundary.toString()}
    ${anchorAt.toString()}
    ${nextTick.toString()}

    // Session reconstruction, injected from src/session.ts.
    ${firstUserText.toString()}
    ${threadSig.toString()}
    ${normalizeTurns.toString()}
    ${turnContentSig.toString()}
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
    const replayToggle = document.getElementById('replay-toggle');
    const rpPlay = document.getElementById('rp-play');
    const rpRestart = document.getElementById('rp-restart');
    const rpExit = document.getElementById('rp-exit');
    const rpTrack = document.getElementById('rp-track');
    const rpFill = document.getElementById('rp-fill');
    const rpMarks = document.getElementById('rp-marks');
    const rpHandle = document.getElementById('rp-handle');
    const rpTime = document.getElementById('rp-time');
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

    // ---- Header context: traced client + project + current session id ----

    const ctxEl = document.getElementById('ctx');

    // The session Claude is in right now: newest live pair wins; prior-run
    // pairs are the fallback so view-rebuilt snapshots still show an id.
    function currentSessionId() {
      let prior = '';
      for (let i = pairs.length - 1; i >= 0; i--) {
        const sid = extractSessionId(pairs[i], CLIENT_WIRE);
        if (!sid) continue;
        if (!pairs[i].prior) return sid;
        if (!prior) prior = sid;
      }
      return prior;
    }

    // The traced client (claude/codex/grok): newest labeled pair wins, the
    // run meta is the fallback. Old traces carry no label — show nothing
    // rather than guess.
    function currentClient() {
      for (let i = pairs.length - 1; i >= 0; i--) {
        if (pairs[i].client) return pairs[i].client;
      }
      return META.client || '';
    }

    // Quiet monogram glyphs for the traced client — generic shapes drawn in
    // currentColor (a spark, a hexagon, a slash), not vendor logos, so they
    // read as identity hints without shouting brand.
    const CLIENT_ICONS = {
      claude: '<svg class="ctx-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 3v18M3 12h18M5.8 5.8l12.4 12.4M18.2 5.8L5.8 18.2"/></svg>',
      codex: '<svg class="ctx-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.6l8.2 4.7v9.4L12 21.4l-8.2-4.7V7.3z"/></svg>',
      grok: '<svg class="ctx-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M7 21L17 3M17 21l-4.6-8.3"/></svg>',
    };

    let ctxKey = null;
    function renderCtx() {
      const sid = currentSessionId();
      const client = currentClient();
      const key = client + '|' + sid;
      if (key === ctxKey) return;
      ctxKey = key;
      var t = '';
      if (client) t += client;
      if (META.project) { if (t) t += ' \\u00b7 '; t += META.project; }
      if (sid) { if (t) t += ' \\u00b7 '; t += sid.slice(0, 8); }
      document.title = t ? 'CCTrace \\u00b7 ' + t : (IS_SNAPSHOT ? 'CCTrace' : 'CCTrace live');
      let html = '';
      if (client) {
        html += '<span class="ctx-client" title="traced CLI">' + (CLIENT_ICONS[client] || '') +
          '<span>' + escapeHtml(client) + '</span></span>';
      }
      if (META.project) {
        if (html) html += '<span class="ctx-sep">\\u00b7</span>';
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

    // ---- Version badge: static META, so rendered once, beside the brand ----
    // Separate from the run-identity ctx (project · session): what cctrace
    // version produced the page has nothing to do with which run it shows.
    (function renderVer() {
      if (!META.version) return;
      let html = '<span class="ver-badge" title="cctrace v' + escapeHtml(META.version) + '">v' + escapeHtml(META.version) + '</span>';
      if (META.latestVersion) {
        html += '<a class="ver-upd" href="https://github.com/thevibeworks/cctrace/blob/main/CHANGELOG.md"' +
          ' target="_blank" rel="noopener"' +
          ' title="update available \\u2014 npm i -g @thevibeworks/cctrace@latest (or rerun cctrace and accept the prompt)">' +
          'v' + escapeHtml(META.latestVersion) + ' available</a>';
      }
      document.getElementById('ver').innerHTML = html;
    })();

    // ---- Instance switcher: other live cctrace runs on this machine ----
    // The server exposes the registry at /api/instances (pid-liveness
    // filtered). Only rendered when there is somewhere else to go.
    const instEl = document.getElementById('inst');
    function renderInstances(list) {
      const others = (list || []).filter(i => i && !i.self && i.port);
      if (!others.length) { instEl.innerHTML = ''; return; }
      const open = !!instEl.querySelector('.inst-menu.open');
      let rows = '';
      for (const i of others) {
        // location.hostname, not localhost: this page may itself be viewed
        // through a forward. The port is still the sibling's own bound port —
        // across container namespaces it may not be reachable as-is.
        // Pids are informational and namespace-local — shown in the tooltip
        // so you can find/kill the run in YOUR namespace, never for liveness.
        rows += '<a class="inst-row" href="http://' + location.hostname + ':' + Number(i.port) + '/"' +
          ' title="' + escapeHtml((i.projectPath || i.project || '') + (i.sessionId ? ' \\u00b7 session ' + i.sessionId : '') +
            (i.pid ? ' \\u00b7 cctrace pid ' + i.pid : '') + (i.agentPid ? ' \\u00b7 agent pid ' + i.agentPid : '')) + '">' +
          '<span>' + escapeHtml((i.client ? i.client + ' \\u00b7 ' : '') + (i.project || '?')) + '</span>' +
          (i.sessionId ? '<span class="inst-sess">' + escapeHtml(String(i.sessionId).slice(0, 8)) + '</span>' : '') +
          '<span class="inst-port">:' + Number(i.port) + '</span></a>';
      }
      instEl.innerHTML =
        '<button class="inst-btn" title="Other live cctrace instances">\\u21c4 ' + others.length + ' more</button>' +
        '<div class="inst-menu' + (open ? ' open' : '') + '">' + rows + '</div>';
      const btn = instEl.querySelector('.inst-btn');
      const menu = instEl.querySelector('.inst-menu');
      btn.onclick = (e) => { e.stopPropagation(); menu.classList.toggle('open'); };
    }
    document.addEventListener('click', () => {
      const menu = instEl.querySelector('.inst-menu.open');
      if (menu) menu.classList.remove('open');
    });
    function pollInstances() {
      fetch('/api/instances')
        .then(r => r.json())
        .then(renderInstances)
        .catch(() => {})
        .finally(() => setTimeout(pollInstances, 15000));
    }
    if (!IS_SNAPSHOT) pollInstances();

    function catCounts() {
      const counts = { all: pairs.length };
      for (const c of CATS) counts[c.id] = 0;
      for (const p of pairs) counts[p._cat] = (counts[p._cat] || 0) + 1;
      return counts;
    }

    function renderCats() {
      const counts = catCounts();
      const chip = (id, label, color, n) =>
        '<div class="cat-chip ' + (activeCat === id ? 'active' : '') +
        '" style="--cat:' + (color || 'var(--text-muted)') + (activeCat === id ? ';color:' + (color || 'var(--text)') : '') + '" data-cat="' + id + '">' +
        (id === 'all' ? '' : '<span class="dot"></span>') +
        '<span>' + label + '</span><span class="n">' + n + '</span></div>';
      let html = chip('all', 'All', 'var(--accent)', counts.all);
      // Only categories this trace actually has: a codex run never issues
      // count_tokens or oauth/usage calls, and an empty chip is dead weight.
      // The active category stays visible even at zero so a live filter can
      // always be clicked off.
      for (const c of CATS) {
        const n = counts[c.id] || 0;
        if (n > 0 || activeCat === c.id) html += chip(c.id, c.label, c.color, n);
      }
      catsEl.innerHTML = html;
      catsEl.querySelectorAll('.cat-chip').forEach(el => {
        el.onclick = () => { activeCat = el.dataset.cat; render(); refreshDetailNav(); };
      });
    }

    function connect() {
      // Origin-relative, never a baked port: behind container/host port
      // forwards the server's bound port is not the port the browser sees,
      // and a baked URL can hand this page another instance's stream.
      const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
      ws.onopen = () => { statusEl.textContent = 'live'; statusEl.className = 'status connected'; };
      ws.onclose = () => {
        statusEl.textContent = 'offline'; statusEl.className = 'status disconnected';
        setTimeout(connect, 1000);
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'init') {
          pairs.length = 0;
          for (const p of msg.pairs) ingestPair(p);
          render();
          route();
        } else if (msg.type === 'pair') {
          if (!ingestPair(msg.pair)) return;
          countEl.textContent = pairs.length;
          renderCats();
          renderCtx();
          if (passesFilters(msg.pair)) {
            appendPair(msg.pair, true);
            if (autoScroll && !detailId) pairsEl.scrollTop = pairsEl.scrollHeight;
          }
          refreshDetailNav();
          if (view === 'session') showSession(sessionSelKey);
          if (replay.active) renderReplayBar(); // track grows at the right edge
        } else if (msg.type === 'history') {
          // Prior-run pairs of a continued session: merge, resort, re-render.
          const known = new Set(pairs.map(p => p.id));
          for (const p of msg.pairs) {
            if (!known.has(p.id)) ingestPair(p);
          }
          pairs.sort((a, b) => (a.request.timestamp || 0) - (b.request.timestamp || 0));
          render();
          refreshDetailNav();
          if (view === 'session') showSession(sessionSelKey);
        }
      };
    }

    // Besides the entity escapes, drop ANSI escape sequences (captured
    // terminal output is full of \\u001b[1m style SGR codes) and any other
    // C0 control chars \\t\\n\\r aside: control characters are HTML parse
    // errors and render as invisible junk like "[1m".
    function escapeHtml(str) {
      return String(str)
        .replace(/\\u001b\\[[0-9;:?]*[a-zA-Z]/g, '')
        .replace(/[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]/g, '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function formatJson(obj) {
      try { return escapeHtml(JSON.stringify(obj, null, 2)); } catch { return escapeHtml(String(obj)); }
    }
    // Fallback card for a single item whose renderer threw: one corrupt pair
    // in a trace must degrade to one visible error, never a blank page.
    function brokenItem(what, id, e) {
      return '<div class="broken-item">broken ' + what + (id ? ' \\u00b7 ' + escapeHtml(id) : '') +
        ' \\u2014 ' + escapeHtml((e && e.message) || String(e)) + '</div>';
    }
    function formatDuration(ms) { return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(2) + 's'; }
    // Wall-clock is always 24h — locale 12h AM/PM wastes row width and
    // reads slower in a dense table.
    function fmtTime(d) { return d.toTimeString().slice(0, 8); }
    function fmtDateTime(d) {
      const p = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + fmtTime(d);
    }
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

    // Sizes are memoized on the pair — estimating an un-stamped pair means
    // stringifying a potentially-megabyte body, too heavy per re-render.
    function sizesOf(p) {
      if (!p._sizes) p._sizes = extractSizes(p);
      return p._sizes;
    }

    function sizeTitle(s) {
      return 'request body ' + s.up.toLocaleString() + ' B \\u00b7 response body ' + s.down.toLocaleString() + ' B' +
        (s.exact ? '' : ' \\u2014 estimated from the decoded trace (captured before 0.17)');
    }

    function sizeCell(pair) {
      const s = sizesOf(pair);
      // Tunnel rows already carry their byte counts in the tunnel chip.
      if (!s || s.tunneled) return '<span class="size"></span>';
      const bits = [];
      if (s.up > 0) bits.push('\\u2191' + fmtBytes(s.up));
      if (s.down > 0) bits.push('\\u2193' + fmtBytes(s.down));
      if (!bits.length) return '<span class="size"></span>';
      return '<span class="size" title="' + escapeHtml(sizeTitle(s)) + '">' + bits.join(' ') + '</span>';
    }

    function appendPair(pair, live) {
      const div = document.createElement('div');
      try {
        const { request, response, duration } = pair;
        const status = response ? response.status : 'ERR';
        const cat = CAT_BY_ID[pair._cat] || CAT_BY_ID.other;
        div.className = 'pair' + (pair.id === detailId ? ' selected' : '') + (pair.prior ? ' prior' : '');
        div.dataset.id = pair.id;
        const when = new Date(request.timestamp * 1000);
        div.innerHTML =
          '<a class="pair-header" href="#/p/' + encodeURIComponent(pair.id) + '" title="' + escapeHtml(request.url) + '">' +
            '<span class="method">' + escapeHtml(request.method) + '</span>' +
            '<span class="status-code ' + getStatusClass(response && response.status) + '" title="HTTP ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span>' +
            '<span class="cat-badge" style="--cat:' + cat.color + '" title="' + cat.label + '">' + cat.label + '</span>' +
            (pair.prior ? '<span class="prior-badge" title="from ' + escapeHtml(pair.prior) + '">prev</span>' : '') +
            '<span class="url">' + escapeHtml(shortUrl(request.url)) + '</span>' +
            '<span class="sum">' + chipsHtml(pair) + '</span>' +
            sizeCell(pair) +
            '<span class="duration" title="' + escapeHtml(duration) + 'ms">' + formatDuration(duration) + '</span>' +
            '<span class="time" title="' + fmtDateTime(when) + '">' + (pair.prior ? fmtDateTime(when) : fmtTime(when)) + '</span>' +
          '</a>';
      } catch (e) {
        div.className = 'pair';
        div.innerHTML = brokenItem('request', pair && pair.id, e);
      }
      if (live) div.classList.add('arrived');
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
      } else if ((m = h.match(/^#\\/session(?:\\/([^/@][^/]*))?(?:\\/@(.+))?$/))) {
        let key = m[1] || null;
        if (key) { try { key = decodeURIComponent(key); } catch {} }
        let anchor = m[2] || null;
        if (anchor) { try { anchor = decodeURIComponent(anchor); } catch {} }
        setView('session');
        if (anchor) {
          // Deep link to a moment: enter replay paused at that pair's end.
          const p = pairs.find(x => x.id === anchor);
          if (p) {
            replay.cursor = pairEndMs(p);
            if (!replay.active) {
              replay.active = true;
              document.body.classList.add('replaying');
              tailPill.classList.remove('show');
              renderReplayMarks(true);
            }
            renderReplayBar();
          }
        }
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
      try { detailEl.innerHTML = renderDetail(id); }
      catch (e) { detailEl.innerHTML = detailNavHtml(id) + brokenItem('request', id, e); }
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
      } else if (view === 'session') {
        if (e.key === 'g') { railJump(convoEl, 'top'); return; }
        if (e.key === 'G') { railJump(convoEl, 'bottom'); return; }
        if (e.key === 's') { railJump(convoEl, 'sys'); return; }
        if (e.key === 'k') { railJump(convoEl, 'tprev'); return; }
        if (e.key === 'j') { railJump(convoEl, 'tnext'); return; }
        if (e.key === 'p') { railJump(convoEl, 'uprev'); return; }
        if (e.key === 'u') { railJump(convoEl, 'unext'); return; }
        if (e.key === 'Escape') {
          if (replay.active) exitReplay();
          else location.hash = '';
        } else if (e.key === ' ') {
          e.preventDefault();
          if (replay.playing) { pausePlayback(); updateReplayHash(); }
          else startPlayback();
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          stepReplay(e.key === 'ArrowRight' ? 1 : -1, !e.shiftKey);
        } else if (e.key === 'Home' && replay.active) {
          e.preventDefault();
          seekReplay(replaySpan(pairs).t0);
          updateReplayHash();
        } else if (e.key === 'End' && replay.active) {
          e.preventDefault();
          seekReplay(replaySpan(pairs).t1);
          updateReplayHash();
        }
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
        '<a class="btn btn-icon" href="#" title="Close (Esc)">\\u2715</a>' +
        '<button class="btn btn-icon" onclick="navDetail(-1)"' + (vIdx <= 0 ? ' disabled' : '') + ' title="Previous shown request (k)">\\u2039</button>' +
        '<button class="btn btn-icon" onclick="navDetail(1)"' + (vIdx === -1 || vIdx >= vis.length - 1 ? ' disabled' : '') + ' title="Next shown request (j)">\\u203a</button>' +
        '<span class="detail-pos">' + pos + '</span>' +
        '<span class="detail-id" title="request id">' + escapeHtml(id) + '</span>' +
      '</div>';
    }

    function refreshDetailNav() {
      if (!detailId) return;
      const nav = detailEl.querySelector('.detail-top');
      if (nav) nav.outerHTML = detailNavHtml(detailId);
    }

    // ---- In-document nav rail ----
    // Jump within the open conversation: top/bottom, prev/next turn,
    // prev/next user prompt, system prompt. One rail overlays the session
    // convo, one the request detail panel; same targets, same keys.
    const RAIL_BUTTONS = [
      { act: 'top', label: '\\u2912', title: 'Jump to top (g)' },
      { act: 'sys', label: '\\u00a7', title: 'System prompt (s)' },
      { gap: true },
      { act: 'tprev', label: '\\u2191', title: 'Previous turn (k)' },
      { act: 'tnext', label: '\\u2193', title: 'Next turn (j)' },
      { gap: true },
      { act: 'uprev', label: 'u\\u2191', title: 'Previous user prompt (p)' },
      { act: 'unext', label: 'u\\u2193', title: 'Next user prompt (u)' },
      { gap: true },
      { act: 'bottom', label: '\\u2913', title: 'Jump to bottom (G)' },
    ];

    function railJump(container, act) {
      if (!container) return;
      if (act === 'top') { container.scrollTop = 0; return; }
      if (act === 'bottom') { container.scrollTop = container.scrollHeight; return; }
      const cbox = container.getBoundingClientRect();
      if (act === 'sys') {
        const el = container.querySelector('.sys-fold');
        if (el) {
          el.open = true;
          container.scrollTop += el.getBoundingClientRect().top - cbox.top - 8;
        }
        return;
      }
      const sel = act === 'uprev' || act === 'unext' ? '.turn-user' : '.turn';
      const dir = act === 'uprev' || act === 'tprev' ? -1 : 1;
      let target = null;
      for (const el of container.querySelectorAll(sel)) {
        const rel = el.getBoundingClientRect().top - cbox.top;
        if (dir > 0) { if (rel > 6) { target = el; break; } }
        else { if (rel < -6) target = el; else break; }
      }
      if (target) container.scrollTop += target.getBoundingClientRect().top - cbox.top - 8;
    }

    function initRail(railEl, getContainer) {
      let html = '';
      for (const b of RAIL_BUTTONS) {
        html += b.gap
          ? '<span class="rail-gap"></span>'
          : '<button data-act="' + b.act + '" title="' + b.title + '">' + b.label + '</button>';
      }
      railEl.innerHTML = html;
      railEl.querySelectorAll('button').forEach(btn => {
        btn.onclick = () => railJump(getContainer(), btn.dataset.act);
      });
    }
    initRail(document.getElementById('rail-session'), () => convoEl);
    initRail(document.getElementById('rail-detail'), () => detailEl);

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
          '<span class="time">' + fmtDateTime(new Date(request.timestamp * 1000)) + '</span>' +
        '</div>';

      if (pair._cat === 'messages') html += messagesChips(pair) + renderConversation(pair);
      else if (pair._cat === 'tokens') html += tokensChips(pair) + renderConversation(pair);
      else if (pair._cat === 'usage') html += renderUsagePanel(pair);
      html += headersSection(pair);
      html += rawSections(pair);
      return html;
    }

    // Values are escaped here, not by callers: fmtCost can emit "<$0.0001"
    // and wire-derived strings can hold anything — a chip must never be able
    // to open a tag.
    function kv(label, value, cls, title) {
      return '<span class="chip ' + (cls || '') + '"' + (title ? ' title="' + escapeHtml(title) + '"' : '') + '><b>' + label + '</b>' + escapeHtml(value) + '</span>';
    }

    function messagesChips(pair) {
      const m = extractCallInfo(pair);
      let row1 = '';
      if (m.error) row1 += kv('error', m.error, 'err');
      if (m.model) row1 += kv('model', m.model, 'model');
      row1 += kv('stream', m.stream ? 'yes' : 'no');
      if (m.maxTokens != null) row1 += kv('max_tokens', m.maxTokens.toLocaleString());
      if (m.temperature != null) row1 += kv('temp', m.temperature);
      if (m.stopReason) row1 += kv('stop', m.stopReason, m.stopReason === 'end_turn' || m.stopReason === 'tool_use' ? '' : 'warn');
      if (m.serviceTier) row1 += kv('tier', m.serviceTier);
      if (m.error) return '<div class="chips">' + row1 + '</div>';
      let row2 = '';
      row2 += kv('input', m.input.toLocaleString());
      row2 += kv('output', m.output.toLocaleString());
      if (m.thinking > 0) row2 += kv('thinking', m.thinking.toLocaleString());
      const cache = summarizeCache(m, pair.request.body);
      if (cache) row2 += kv('cache', cache.v, cache.c, cache.title);
      // Derived metrics: effective prompt size, streaming speed, estimated cost.
      const prompt = m.input + m.cacheRead + m.cacheWrite;
      if (prompt > 0) row2 += kv('prompt', fmtCompact(prompt), '', prompt.toLocaleString() + ' prompt tokens = input + cache read + cache write');
      const lat = extractLatency(pair);
      if (lat) {
        row2 += kv(lat.isToken ? 'first token' : 'first byte', fmtMs(lat.ms), '',
          (lat.isToken ? 'time from request start to the first streamed token event'
            : 'time from request start to the first response body byte (no token event seen)') +
          (lat.pct != null ? ' \\u2014 ' + lat.pct + '% of ' + fmtMs(lat.totalMs) + ' wall-clock' : ''));
      }
      if (m.output > 0 && pair.duration > 400) {
        const streamMs = lat && lat.isToken && pair.duration > lat.ttftMs ? pair.duration - lat.ttftMs : null;
        const tps = m.output / ((streamMs || pair.duration) / 1000);
        row2 += kv('speed', (tps >= 10 ? Math.round(tps) : tps.toFixed(1)) + ' tok/s', '', streamMs
          ? 'output tokens / streaming time after the first token (' + fmtMs(streamMs) + ')'
          : 'output tokens / wall-clock duration (includes time-to-first-token)');
      }
      const cost = pairCost(m);
      if (cost && cost.total > 0) row2 += kv('cost', fmtCost(cost.total), '', costTitle(cost));
      return '<div class="chips">' + row1 + '</div><div class="chips">' + row2 + '</div>';
    }

    function tokensChips(pair) {
      const t = extractTokenCount(pair);
      const req = pair.request.body || {};
      let out = '';
      if (t.model) out += kv('model', t.model, 'model');
      if (t.tokens != null) out += kv('input tokens', t.tokens.toLocaleString(), 'ok');
      if (Array.isArray(req.messages)) out += kv('messages', req.messages.length);
      if (Array.isArray(req.tools) && req.tools.length) out += kv('tools', req.tools.length);
      return '<div class="chips">' + out + '</div>';
    }

    // extraHtml is raw (not escaped) — only trusted, renderer-built markup
    // like the subagent thread link goes there, never wire-derived strings.
    function fold(title, hint, body, cls, open, extraHtml) {
      return '<details class="fold ' + (cls || '') + '"' + (open ? ' open' : '') + '>' +
        '<summary><span class="fold-title">' + escapeHtml(title) + '</span>' +
        (hint ? '<span class="fold-hint">' + escapeHtml(hint) + '</span>' : '') +
        (extraHtml || '') +
        '</summary><div class="fold-body">' + body + '</div></details>';
    }

    function snippet(v, n) {
      let s = typeof v === 'string' ? v : (JSON.stringify(v) || '');
      s = s.replace(/\\s+/g, ' ').trim();
      return s.length > n ? s.slice(0, n) + '...' : s;
    }

    // Best-effort markdown for assistant reply text — a safe subset only:
    // fenced code, inline code, headings, bold, bare http(s) links. The text
    // is HTML-escaped FIRST; the transform emits nothing but our own tags,
    // so wire content can never smuggle markup in. Everything else renders
    // as-is (the container is pre-wrap, lists already read fine).
    function renderMd(text) {
      const lines = escapeHtml(String(text == null ? '' : text)).split('\\n');
      const inline = (s) => s
        .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
        .replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>')
        .replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      let out = '';
      let code = null; // non-null while inside a code fence
      for (const ln of lines) {
        if (/^\\s*\`\`\`/.test(ln)) {
          if (code === null) code = [];
          else { out += '<pre class="md-code">' + code.join('\\n') + '</pre>'; code = null; }
          continue;
        }
        if (code !== null) { code.push(ln); continue; }
        const h = ln.match(/^(#{1,4})\\s+(.*)$/);
        if (h) { out += '<div class="md-h">' + inline(h[2]) + '</div>'; continue; }
        out += inline(ln) + '\\n';
      }
      if (code !== null) out += '<pre class="md-code">' + code.join('\\n') + '</pre>'; // unclosed fence
      return out;
    }

    // Long texts render clamped with a "show all" expander; short ones inline.
    // md renders assistant reply text as markdown (safe subset, renderMd).
    function textBlock(text, cls, md) {
      const t = String(text == null ? '' : text);
      const inner = '<div class="msg-text' + (cls ? ' ' + cls : '') + '">' + (md ? renderMd(t) : escapeHtml(t)) + '</div>';
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

    function renderBlock(b, md) {
      if (b == null) return '';
      if (typeof b === 'string') return textBlock(b, '', md);
      const type = b.type;
      if (type === 'text') return textBlock(b.text, '', md);
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
      for (const b of blocks) inner += renderBlock(b, role === 'assistant');
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
      // .sys-fold is the nav rail's jump target (§ / s key).
      return fold('system prompt', blocks.length + ' block' + (blocks.length === 1 ? '' : 's') + ' \\u00b7 ' + fmtCompact(total) + ' chars', body, 'box sys-fold');
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
      if (req._cctrace_stub) {
        // cctrace compact folded this superseded request body; the thread's
        // kept (longest) request holds the full history. The response below
        // is untouched — compact never folds responses.
        html += '<div class="block-note">request body compacted \\u2014 ' +
          (req.historyLen || 0) + ' history turns, ' + fmtBytes(req.droppedBytes || 0) + ' dropped' +
          (req.keptPairId ? ' \\u00b7 <a href="#/p/' + encodeURIComponent(req.keptPairId) + '">full history</a>' : '') +
          '</div>';
      }
      if (wireDialect(pair) === 'openai') {
        // OpenAI Responses (codex/grok): normalize input[] into the same
        // turn/block model, so the folds render identically.
        const sys = openaiSystemText(req.input);
        if (sys) html += renderSystem(sys);
        const tools = openaiTools(req);
        if (tools.length) html += renderTools(tools);
        for (const t of normalizeOpenaiTurns(req.input)) {
          html += renderTurn(t.role, t.blocks, '');
        }
        const done = openaiCompleted(pair);
        let rblocks = [];
        for (const item of (done && done.output) || []) rblocks = rblocks.concat(openaiBlocks(item));
        if (rblocks.length) html += renderTurn('assistant', rblocks, 'response');
        if (!html) return '';
        return '<div class="section"><h4>Conversation</h4>' + html + '</div>';
      }
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

    // ---- Headers section (DevTools-style): General + parsed k/v tables ----

    function hdrRawText(headers) {
      const keys = Object.keys(headers || {}).sort();
      return keys.map(k => k + ': ' + headers[k]).join('\\n');
    }

    function hdrRows(entries) {
      let rows = '';
      for (const [k, v] of entries) {
        rows += '<div class="hdr-row"><span class="hdr-k">' + escapeHtml(k) + '</span><span class="hdr-v">' + escapeHtml(String(v)) + '</span></div>';
      }
      return rows || '<div class="block-note">none</div>';
    }

    // Both views render up front (headers are small); the raw toggle is pure
    // CSS via data-alt. Copy always copies the raw "name: value" text.
    function hdrFold(title, headers, open) {
      const keys = Object.keys(headers || {}).sort();
      return '<details class="fold box hdr-fold"' + (open ? ' open' : '') + '>' +
        '<summary><span class="fold-title">' + escapeHtml(title) + '</span>' +
        '<span class="fold-hint">' + keys.length + '</span>' +
        '<button class="fold-btn" onclick="copyFold(event, this)" title="Copy headers">copy</button>' +
        '<button class="fold-btn" onclick="toggleHdrRaw(event, this)" title="Raw view">raw</button>' +
        '</summary><div class="fold-body">' +
        '<div class="hdr-table">' + hdrRows(keys.map(k => [k, headers[k]])) + '</div>' +
        '<pre class="hdr-pre" data-copy>' + escapeHtml(hdrRawText(headers)) + '</pre>' +
        '</div></details>';
    }

    window.toggleHdrRaw = function(ev, btn) {
      ev.preventDefault(); ev.stopPropagation();
      const det = btn.closest('details');
      det.dataset.alt = det.dataset.alt === '1' ? '' : '1';
      btn.textContent = det.dataset.alt === '1' ? 'parsed' : 'raw';
      det.open = true;
    };

    window.copyFold = function(ev, btn) {
      ev.preventDefault(); ev.stopPropagation();
      const det = btn.closest('details');
      const src = det.querySelector('[data-copy]');
      navigator.clipboard.writeText(src ? src.textContent : '').then(function() {
        btn.classList.add('copied');
        const was = btn.textContent;
        btn.textContent = 'copied';
        setTimeout(function() { btn.classList.remove('copied'); btn.textContent = was; }, 1500);
      });
    };

    function headersSection(pair) {
      const r = pair.response;
      const s = sizesOf(pair);
      const general = [
        ['request url', pair.request.url],
        ['method', pair.request.method],
        ['status', r ? r.status + '' : 'no response'],
      ];
      try { general.push(['remote host', new URL(pair.request.url).host]); } catch {}
      general.push(['started', fmtDateTime(new Date(pair.request.timestamp * 1000))]);
      general.push(['duration', formatDuration(pair.duration)]);
      const lat = extractLatency(pair);
      if (lat) general.push([lat.isToken ? 'first token' : 'first byte', fmtMs(lat.ms)]);
      if (s && !s.tunneled && (s.up > 0 || s.down > 0)) {
        const ex = s.exact ? '' : ' (estimated)';
        if (s.up > 0) general.push(['request body', fmtBytes(s.up) + ex]);
        if (s.down > 0) general.push(['response body', fmtBytes(s.down) + ex]);
      }
      if (r && r.truncated) general.push(['truncated', 'upstream stream ended early']);
      let html = '<div class="section"><h4>Headers</h4>';
      html += '<details class="fold box" open><summary><span class="fold-title">general</span></summary>' +
        '<div class="fold-body"><div class="hdr-table">' + hdrRows(general) + '</div></div></details>';
      if (r) html += hdrFold('response headers', r.headers, false);
      html += hdrFold('request headers', pair.request.headers, false);
      return html + '</div>';
    }

    // Raw payloads render lazily on first expand — a full Claude Code request
    // body can be megabytes of JSON, so we only stringify when asked. Each
    // fold has two modes (data-alt refills the body): pretty JSON vs the
    // as-logged text for bodies, raw text vs parsed events for the SSE
    // stream. "Raw" for a JSON body is the trace's decoded body re-serialized
    // (single line), not the original wire bytes — those aren't stored.
    function rawFold(title, kind, open, altLabel) {
      return '<details class="fold box" data-raw="' + kind + '"' + (open ? ' open' : '') + '>' +
        '<summary><span class="fold-title">' + escapeHtml(title) + '</span>' +
        (altLabel ? '<span class="fold-hint"></span><button class="fold-btn" data-alt-label="' + escapeHtml(altLabel) + '" onclick="toggleRawMode(event, this)">' + escapeHtml(altLabel) + '</button>' : '') +
        '</summary><div class="fold-body"></div></details>';
    }

    function rawSections(pair) {
      const r = pair.response;
      // For categories with a rich view the raw payloads stay collapsed; for
      // everything else the bodies are the content, so open them.
      const rich = pair._cat === 'messages' || pair._cat === 'tokens' || pair._cat === 'usage';
      let html = '<div class="section"><h4>Body</h4>';
      let any = false;
      if (pair.request.body != null) { html += rawFold('request body', 'req-body', !rich, 'raw'); any = true; }
      if (r) {
        if (r.body != null) { html += rawFold('response body', 'resp-body', !rich, 'raw'); any = true; }
        if (r.bodyRaw) { html += rawFold('response stream (SSE)', 'resp-raw', false, 'events'); any = true; }
      } else {
        html += '<div class="block-note err">request failed &mdash; no response received</div>';
        any = true;
      }
      if (!any) html += '<div class="block-note">no body</div>';
      return html + '</div>';
    }

    window.toggleRawMode = function(ev, btn) {
      ev.preventDefault(); ev.stopPropagation();
      const det = btn.closest('details');
      det.dataset.alt = det.dataset.alt === '1' ? '' : '1';
      btn.textContent = det.dataset.alt === '1' ? 'pretty' : btn.dataset.altLabel;
      const body = det.querySelector(':scope > .fold-body');
      if (body) { body.dataset.filled = ''; body.innerHTML = ''; }
      det.open = true;
      fillRaw(det);
    };

    function rawText(v) {
      return typeof v === 'string' ? v : (JSON.stringify(v) || '');
    }

    function fillRaw(det) {
      const body = det.querySelector(':scope > .fold-body');
      if (!body || body.dataset.filled) return;
      const pair = pairs.find(p => p.id === detailId);
      if (!pair) return;
      body.dataset.filled = '1';
      const kind = det.dataset.raw;
      const alt = det.dataset.alt === '1';
      let out = '';
      if (kind === 'req-body') out = preBlock(alt ? escapeHtml(rawText(pair.request.body)) : formatJson(pair.request.body));
      else if (kind === 'resp-body') out = preBlock(alt ? escapeHtml(rawText(pair.response.body)) : formatJson(pair.response.body));
      else if (kind === 'resp-raw') {
        const raw = String(pair.response.bodyRaw || '');
        if (alt) {
          // Parsed events preview: one pretty JSON object per SSE data line.
          const events = parseSse(raw.slice(0, 400000));
          out = preBlock(escapeHtml(events.map(e => JSON.stringify(e, null, 2)).join('\\n\\n')) +
            (raw.length > 400000 ? '\\n... (truncated)' : ''));
        } else {
          out = preBlock(escapeHtml(raw.slice(0, 200000)) + (raw.length > 200000 ? '\\n... (truncated)' : ''));
        }
      }
      body.innerHTML = out;
    }

    detailEl.addEventListener('toggle', (e) => {
      const det = e.target;
      if (det && det.dataset && det.dataset.raw && det.open) fillRaw(det);
    }, true);

    // ---- Session view: wire threads (left) + reconstructed conversation ----

    // With replay active the session is rebuilt from the wire as of the
    // cursor — the same buildSession path that renders mid-capture sessions
    // live, so a partial history needs no special casing.
    function getThreads() {
      // Cache on the anchor pair, not the raw cursor: every cursor position
      // between two boundaries sees the same wire, so scrubbing stays cheap.
      const a = replay.active ? ((anchorAt(replayEvents(pairs), replay.cursor) || { id: '^' }).id) : 'live';
      const key = pairs.length + ':' + a;
      if (sessionCache.key !== key) {
        const src = replay.active ? visibleAt(pairs, replay.cursor) : pairs;
        sessionCache = { key, threads: buildSession(src, CLIENT_WIRE).threads };
      }
      return sessionCache.threads;
    }

    function showSession(key) {
      const threads = getThreads();
      if (!threads.length) {
        threadsEl.innerHTML = '';
        convoEl.innerHTML = '<div class="empty">' + (replay.active
          ? 'Nothing on the wire yet at this moment \\u2014 step forward (\\u2192) or press play.'
          : 'No /v1/messages requests captured yet.') + '</div>';
        convoKey = null;
        tailPill.classList.remove('show');
        return;
      }
      let sel = null;
      for (const t of threads) if (t.key === key) sel = t;
      if (!sel) sel = mainThread(threads);
      sessionSelKey = sel.key;
      agentThreadIndex = {};
      for (const t of threads) {
        if (t.agentOf && t.agentOf.toolUseId) agentThreadIndex[t.agentOf.toolUseId] = t.key;
      }
      renderThreadsPane(threads, sel);
      renderConvoPane(sel);
    }

    function threadCard(t, selected) {
      const u = t.usage;
      const errs = (u.wireErrors || 0) + (u.toolErrors || 0) + (u.truncated || 0);
      const meta = u.requests + ' req \\u00b7 in ' + fmtCompact(u.input) + ' \\u00b7 out ' + fmtCompact(u.output) +
        (u.cacheRead ? ' \\u00b7 cache ' + fmtCompact(u.cacheRead) : '') +
        (u.cost ? ' \\u00b7 ' + escapeHtml(fmtCost(u.cost)) : '') +
        (errs ? ' \\u00b7 <span class="err" title="' + escapeHtml(errTitle(u)) + '">' + errs + ' err</span>' : '');
      let reqs = '';
      if (selected) {
        let rows = '';
        for (const pid of t.pairIds) {
          const p = pairs.find(x => x.id === pid);
          if (!p) continue;
          const m = extractCallInfo(p);
          const cc = summarizeCache(m, p.request.body);
          rows += '<a class="treq" href="#/p/' + encodeURIComponent(pid) + '" title="open wire request' + (p.prior ? ' (prev run: ' + escapeHtml(p.prior) + ')' : '') + '">' +
            '<span class="cdot' + (cc ? ' cdot-' + cc.kind : '') + '" title="' + (cc ? escapeHtml(cc.title) : 'no prompt caching on this request') + '"></span>' +
            '<span>' + fmtTime(new Date(p.request.timestamp * 1000)) + '</span>' +
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

    // Spelled-out breakdown for an error count — the aggregate chip stays
    // compact, the tooltip says which kind of failure it was.
    function errTitle(u) {
      const bits = [];
      if (u.wireErrors) bits.push(u.wireErrors + ' failed request' + (u.wireErrors === 1 ? '' : 's') + ' (no response, HTTP 4xx/5xx, or an in-stream error event)');
      if (u.truncated) bits.push(u.truncated + ' truncated stream' + (u.truncated === 1 ? '' : 's') + ' (upstream died mid-response)');
      if (u.toolErrors) bits.push(u.toolErrors + ' failed tool call' + (u.toolErrors === 1 ? '' : 's') + (u.toolUses ? ' of ' + u.toolUses : ''));
      return bits.join(' \\u00b7 ');
    }

    function pctOf(part, whole) {
      return whole > 0 ? Math.round((part / whole) * 100) + '%' : '';
    }

    // Session rollup across all threads: one quiet line on top of the
    // threads pane; error parts render only when nonzero (and in red).
    function sessionSummary(threads) {
      const s = { requests: 0, wireErrors: 0, truncated: 0, toolErrors: 0, toolUses: 0 };
      for (const t of threads) {
        const u = t.usage || {};
        s.requests += u.requests || 0;
        s.wireErrors += u.wireErrors || 0;
        s.truncated += u.truncated || 0;
        s.toolErrors += u.toolErrors || 0;
        s.toolUses += u.toolUses || 0;
      }
      const bits = [threads.length + ' thread' + (threads.length === 1 ? '' : 's'), s.requests + ' req'];
      if (s.wireErrors) {
        const r = pctOf(s.wireErrors, s.requests);
        bits.push('<span class="err">' + s.wireErrors + ' req err' + (r ? ' (' + r + ')' : '') + '</span>');
      }
      if (s.truncated) bits.push('<span class="err">' + s.truncated + ' truncated</span>');
      if (s.toolErrors) {
        const r = pctOf(s.toolErrors, s.toolUses);
        bits.push('<span class="err">' + s.toolErrors + ' tool err' + (r ? ' (' + r + ')' : '') + '</span>');
      }
      return '<div class="threads-sum" title="' + escapeHtml(errTitle(s)) + '">' + bits.join(' \\u00b7 ') + '</div>';
    }

    function renderThreadsPane(threads, sel) {
      const convos = threads.filter(t => t.kind !== 'utility');
      const utils = threads.filter(t => t.kind === 'utility');
      const card = (t) => {
        try { return threadCard(t, t.key === sel.key); }
        catch (e) { return brokenItem('thread', t && t.key, e); }
      };
      let html = sessionSummary(threads);
      for (const t of convos) html += card(t);
      if (utils.length) {
        let inner = '';
        for (const t of utils) inner += card(t);
        html += fold('utility \\u00b7 ' + utils.length, 'probes, title generation', inner, 'box', utils.some(t => t.key === sel.key));
      }
      const top = threadsEl.scrollTop; // live re-renders must not move the list
      threadsEl.innerHTML = html;
      threadsEl.scrollTop = top;
    }

    // Focus hierarchy: EVERY tool_use folds to one line — on real sessions
    // the old "mutating tools render expanded" rule buried the conversation
    // under Read/Bash output. What stays visually distinct (purple title,
    // still folded) are the notable events: subagent spawns (with a jump
    // link to the reconstructed thread), skill invocations, and MCP calls.
    const SPAWN_TOOLS = { Task: 1, Agent: 1, TaskCreate: 1 };

    // tool_use id -> subagent thread key, rebuilt on each session render.
    let agentThreadIndex = {};

    function renderBlockS(b, results, md) {
      if (b && (b.type === 'tool_use' || b.type === 'server_tool_use')) {
        const name = b.name || '?';
        let title = name;
        let pv = toolPreview(name, b.input) || snippet(b.input, 110);
        let cls = '';
        let extra = '';
        if (SPAWN_TOOLS[name]) {
          title = 'subagent';
          cls = 'fold-agent';
          const dest = b.id && agentThreadIndex[b.id];
          if (dest) {
            extra = '<a class="fold-link" href="#/session/' + encodeURIComponent(dest) + '"' +
              ' onclick="event.stopPropagation()" title="open the reconstructed subagent thread">open thread \\u2192</a>';
          }
        } else if (name === 'Skill') {
          title = 'skill';
          cls = 'fold-skill';
        } else if (name.lastIndexOf('mcp__', 0) === 0) {
          title = 'mcp \\u00b7 ' + name.slice(5).split('__').join(' \\u00b7 ');
          cls = 'fold-mcp';
        }
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
        if (res && res.is_error) cls += ' errline';
        return fold(title, pv, body, cls, false, extra);
      }
      return renderBlock(b, md);
    }

    function renderSessionTurn(turn, results) {
      let inner = '';
      for (const b of turn.blocks) inner += renderBlockS(b, results, turn.role === 'assistant');
      let meta = '';
      if (turn.role === 'assistant' && turn.usage) {
        const u = turn.usage;
        const p = turn.pairId ? pairs.find(x => x.id === turn.pairId) : null;
        const bits = [];
        if (u.model) bits.push(escapeHtml(shortModel(u.model)));
        bits.push('in ' + fmtCompact(u.input));
        bits.push('out ' + fmtCompact(u.output));
        if (u.cacheRead) bits.push('cache ' + fmtCompact(u.cacheRead));
        const c = pairCost(u);
        if (c && c.total > 0) bits.push(escapeHtml(fmtCost(c.total)));
        if (p) bits.push(formatDuration(p.duration));
        if (p && p.response && typeof p.response.firstTokenMs === 'number')
          bits.push('ttft ' + fmtMs(p.response.firstTokenMs));
        meta = '<span class="turn-usage">' + bits.join(' \\u00b7 ') + '</span>' +
          (turn.pairId ? '<a class="turn-wire" href="#/p/' + encodeURIComponent(turn.pairId) + '" title="open wire request">wire</a>' : '');
      } else if (turn.role === 'assistant' && !turn.pairId) {
        // Never silently blank (devlog 2026-07-17): an assistant turn we
        // could not tie to a wire request says so, quietly.
        meta = '<span class="turn-usage" title="no captured request matches this reply \\u2014 history was repacked or the reply was edited before it entered history">unattributed</span>';
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
      // The face model is the one with the most output tokens; a mid-session
      // /model switch shows as "+N" with the per-model split in the tooltip.
      const mkeys = Object.keys(t.models || {});
      const mextra = Math.max(0, mkeys.length - 1);
      const mtitle = mkeys.length > 1
        ? mkeys.map(m => shortModel(m) + ': ' + t.models[m].requests + ' req \\u00b7 out ' + fmtCompact(t.models[m].output) + (t.models[m].cost ? ' \\u00b7 ' + fmtCost(t.models[m].cost) : '')).join('\\n')
        : undefined;
      chips += kv('model', (t.model || '?') + (mextra ? ' +' + mextra : ''), 'model', mtitle);
      chips += kv('requests', t.usage.requests);
      chips += kv('input', t.usage.input.toLocaleString());
      chips += kv('output', t.usage.output.toLocaleString());
      if (t.usage.cacheRead || t.usage.cacheWrite) {
        chips += kv('cache',
          (t.usage.cacheRead ? '\\u2193' + fmtCompact(t.usage.cacheRead) : '') +
          (t.usage.cacheRead && t.usage.cacheWrite ? ' ' : '') +
          (t.usage.cacheWrite ? '\\u2191' + fmtCompact(t.usage.cacheWrite) : ''),
          t.usage.cacheRead ? 'ok' : 'warn',
          'prompt cache totals over this thread\\u2019s requests \\u2014 \\u2193 read, \\u2191 written');
      }
      if (t.usage.cost) chips += kv('cost', fmtCost(t.usage.cost), '', 'estimated from sticker pricing \\u2014 sum over this thread\\u2019s requests');
      // Error metrics, reported separately — a failed wire request and a
      // failed tool call are different problems (idea: error rate per thread).
      const eu = t.usage;
      if (eu.wireErrors) {
        const r = pctOf(eu.wireErrors, eu.requests);
        chips += kv('req errors', eu.wireErrors + ' of ' + eu.requests + (r ? ' (' + r + ')' : ''), 'err',
          'requests that failed: no response, HTTP 4xx/5xx, or an in-stream error event');
      }
      if (eu.truncated) chips += kv('truncated', String(eu.truncated), 'err', 'streams the upstream dropped mid-response');
      if (eu.toolErrors) {
        const r = pctOf(eu.toolErrors, eu.toolUses);
        chips += kv('tool errors', eu.toolErrors + ' of ' + eu.toolUses + (r ? ' (' + r + ')' : ''), 'err',
          'tool_result blocks flagged is_error, over all tool calls in this thread');
      }
      if (eu.rewound) chips += kv('rewound', String(eu.rewound), 'warn',
        'requests whose exchange was erased from history (/rewind or an edited turn) \\u2014 the wire pairs are kept, never lost');
      if (eu.unattributed) chips += kv('unplaced', String(eu.unattributed), '',
        'wire requests whose reply matches no turn in the reconstruction (reply superseded before it entered history)');
      let html = '<div class="chips">' + chips + '</div>';
      if (t.agentOf) {
        html += '<div class="agent-note">subagent run' +
          (t.agentOf.agentType ? ' \\u00b7 [' + escapeHtml(t.agentOf.agentType) + '] ' + escapeHtml(t.agentOf.description || '') : '') +
          ' \\u2014 dispatched by <a href="#/session/' + encodeURIComponent(t.agentOf.thread) + '">parent thread</a></div>';
      }
      if (t.system) html += renderSystem(t.system);
      if (t.tools && t.tools.length) html += renderTools(t.tools);
      const results = buildToolResultIndex(t.turns);
      // Rewound exchanges mark their divergence point (devlog 2026-07-17
      // decision 4: keep + mark, never lose) — the erased branch's wire
      // pair stays one click away.
      const rewoundAt = {};
      for (const r of (t.rewound || [])) (rewoundAt[r.at] = rewoundAt[r.at] || []).push(r.pairId);
      let ti = 0;
      for (const turn of t.turns) {
        const marks = rewoundAt[ti];
        ti++;
        if (marks) for (const pid of marks) {
          html += '<div class="rewound-mark" title="an exchange here was erased by /rewind or an edit — its wire pair is kept">\\u21a9 rewound exchange \\u00b7 <a href="#/p/' + encodeURIComponent(pid) + '">wire</a></div>';
        }
        if (turn.toolResultsOnly) continue; // results fold into their tool_use
        try { html += renderSessionTurn(turn, results); }
        catch (e) { html += brokenItem('turn', turn && turn.pairId, e); }
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
        // The pill means "the live tail moved" — replay reveals are the
        // cursor's doing, not new activity.
        if (convoEl.scrollHeight > prevHeight && !replay.active) tailPill.classList.add('show');
      }
    }

    // ---- Session replay ----
    // A time cursor over the same data (docs/design/session-replay.md):
    // pairs whose response completed at or before the cursor are visible,
    // everything after doesn't exist yet. Both panes rebuild from the
    // visible subset via the normal buildSession path; playback is a
    // setTimeout ladder over response-end boundaries with idle compression.
    const replay = { active: false, cursor: 0, playing: false, speed: 1, timer: null };
    const IDLE_CAP_MS = 2000;

    function enterReplay(cursor) {
      const span = replaySpan(pairs);
      if (!span) return;
      replay.active = true;
      replay.cursor = cursor == null ? span.t1 : cursor;
      document.body.classList.add('replaying');
      tailPill.classList.remove('show');
      if (view !== 'session') { location.hash = '#/session'; }
      renderReplayMarks(true);
      refreshReplay();
      updateReplayHash();
    }

    function exitReplay() {
      pausePlayback();
      replay.active = false;
      document.body.classList.remove('replaying');
      if (view === 'session') {
        showSession(sessionSelKey);
        if (!IS_SNAPSHOT) convoToBottom();
        if (sessionSelKey) history.replaceState(null, '', '#/session/' + encodeURIComponent(sessionSelKey));
      }
    }

    function pausePlayback() {
      replay.playing = false;
      if (replay.timer) { clearTimeout(replay.timer); replay.timer = null; }
      rpPlay.textContent = '\\u25b6';
    }

    function startPlayback() {
      const span = replaySpan(pairs);
      if (!span) return;
      if (!replay.active) enterReplay(span.t0);
      // Play at the end of the tape restarts from the top.
      if (!nextBoundary(replayEvents(pairs), replay.cursor)) { replay.cursor = span.t0; refreshReplay(); }
      replay.playing = true;
      rpPlay.textContent = '\\u23f8';
      scheduleTick();
    }

    function scheduleTick() {
      const tick = nextTick(replayEvents(pairs), replay.cursor, replay.speed, IDLE_CAP_MS);
      if (!tick) { pausePlayback(); updateReplayHash(); return; }
      replay.timer = setTimeout(function() {
        replay.cursor = tick.cursor;
        refreshReplay();
        if (replay.playing) scheduleTick();
      }, tick.delay);
    }

    function stepReplay(dir, turnsOnly) {
      const span = replaySpan(pairs);
      if (!span) return;
      if (!replay.active) enterReplay(dir > 0 ? span.t0 - 1 : span.t1);
      pausePlayback();
      const events = replayEvents(pairs);
      const b = dir > 0 ? nextBoundary(events, replay.cursor, turnsOnly) : prevBoundary(events, replay.cursor, turnsOnly);
      if (b) { replay.cursor = b.t; refreshReplay(); }
      updateReplayHash();
    }

    function seekReplay(cursor) {
      pausePlayback();
      replay.cursor = cursor;
      refreshReplay();
    }

    function fmtClock(ms) {
      const s = Math.max(0, Math.round(ms / 1000));
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
      const mm = (h > 0 && m < 10 ? '0' : '') + m;
      const ss = (sec < 10 ? '0' : '') + sec;
      return (h > 0 ? h + ':' + mm + ':' : mm + ':') + ss;
    }

    // Minimap marks: one per pair at its response end — turns tall + accent,
    // errors red, everything else a quiet tick. Rebuilt when pairs arrive.
    let rpMarksN = -1;
    function renderReplayMarks(force) {
      if (rpMarksN === pairs.length && !force) return;
      rpMarksN = pairs.length;
      const span = replaySpan(pairs);
      if (!span) { rpMarks.innerHTML = ''; return; }
      const dur = Math.max(1, span.t1 - span.t0);
      let html = '';
      for (const p of pairs) {
        const x = ((pairEndMs(p) - span.t0) / dur) * 100;
        const err = !p.response || p.response.status >= 400;
        html += '<span class="rp-mark' + (isTurnPair(p) ? ' turn' : '') + (err ? ' err' : '') + '" style="left:' + x.toFixed(3) + '%"></span>';
      }
      rpMarks.innerHTML = html;
    }

    function renderReplayBar() {
      const span = replaySpan(pairs);
      if (!span) return;
      const dur = Math.max(1, span.t1 - span.t0);
      const frac = Math.min(1, Math.max(0, (replay.cursor - span.t0) / dur));
      rpFill.style.width = (frac * 100).toFixed(3) + '%';
      rpHandle.style.left = (frac * 100).toFixed(3) + '%';
      rpTime.textContent = fmtClock(replay.cursor - span.t0) + ' / ' + fmtClock(dur);
      renderReplayMarks();
    }

    function refreshReplay() {
      renderReplayBar();
      if (view === 'session') showSession(sessionSelKey);
    }

    // Deep-link anchor: #/session/<key>/@<pair-id> — pair ids survive
    // cross-run history merges where wall-clock offsets wouldn't. Only
    // written when paused (replaceState is rate-limited by browsers).
    function updateReplayHash() {
      if (!replay.active || replay.playing || view !== 'session' || !sessionSelKey) return;
      const a = anchorAt(replayEvents(pairs), replay.cursor);
      const base = '#/session/' + encodeURIComponent(sessionSelKey);
      history.replaceState(null, '', a ? base + '/@' + encodeURIComponent(a.id) : base);
    }

    replayToggle.onclick = () => { replay.active ? exitReplay() : enterReplay(); };
    rpExit.textContent = IS_SNAPSHOT ? '\\u2715 exit' : 'live \\u2913';
    rpExit.title = IS_SNAPSHOT ? 'Exit replay (Esc)' : 'Exit replay, back to the live tail (Esc)';
    rpExit.onclick = exitReplay;
    rpRestart.onclick = () => {
      if (!replay.active) enterReplay();
      seekReplay(replaySpan(pairs).t0);
      updateReplayHash();
    };
    rpPlay.onclick = () => {
      if (replay.playing) { pausePlayback(); updateReplayHash(); }
      else startPlayback();
    };
    document.querySelectorAll('.rp-speed').forEach(btn => {
      btn.onclick = () => {
        replay.speed = parseFloat(btn.dataset.speed) || 1;
        document.querySelectorAll('.rp-speed').forEach(b => b.classList.toggle('active', b === btn));
        if (replay.playing) { clearTimeout(replay.timer); scheduleTick(); }
      };
    });

    let rpDragging = false;
    function seekFromPointer(e) {
      const span = replaySpan(pairs);
      if (!span) return;
      const rect = rpTrack.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / Math.max(1, rect.width)));
      seekReplay(span.t0 + frac * (span.t1 - span.t0));
    }
    rpTrack.addEventListener('pointerdown', (e) => {
      if (!replay.active) enterReplay();
      rpDragging = true;
      try { rpTrack.setPointerCapture(e.pointerId); } catch {}
      seekFromPointer(e);
    });
    rpTrack.addEventListener('pointermove', (e) => { if (rpDragging) seekFromPointer(e); });
    rpTrack.addEventListener('pointerup', () => { rpDragging = false; updateReplayHash(); });

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
      sessionCache = { key: '', threads: [] };
      convoKey = null;
      tailPill.classList.remove('show');
      if (replay.active) exitReplay();
      if (detailId) location.hash = '';
      render();
    };

    renderCats();
    // Offline snapshot: if pairs are embedded (static export), load them and
    // skip the WebSocket. Otherwise connect live.
    if (IS_SNAPSHOT) {
      for (const p of window.__PAIRS__) ingestPair(p);
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
  const html = getLiveHtml(meta);
  // Inject before </head> so __PAIRS__ is defined before the body script runs.
  const inject = `<script>window.__PAIRS__ = ${jsonForScript(tracePairs)};</script>`;
  // Function replacement: a string replacement would $-substitute the payload
  // ($$ collapses, $& / $` splice document text into the JSON) — captured
  // conversations about code contain those daily.
  return html.replace("</head>", () => `${inject}\n</head>`);
}

/**
 * Self-check for a rendered snapshot: re-extract the embedded __PAIRS__
 * payload and prove it still parses to the pairs we meant to embed. This is
 * the write-time grammar gate — if an escaping regression (or a payload we
 * never anticipated) breaks the embedding, the CLI warns instead of silently
 * shipping a snapshot that dies on load. Returns null when healthy, else a
 * one-line problem description.
 */
export function verifySnapshot(html: string, expectedPairs: number): string | null {
  const m = html.match(/<script>window\.__PAIRS__ = (.*?);<\/script>\n<\/head>/s);
  if (!m) return "embedded __PAIRS__ script not found";
  if (m[1].includes("<")) return "embedded payload contains a raw '<' (tag breakout)";
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]);
  } catch (e) {
    return `embedded payload is not valid JSON: ${(e as Error).message}`;
  }
  if (!Array.isArray(parsed)) return "embedded payload is not an array";
  if (parsed.length !== expectedPairs) {
    return `embedded ${parsed.length} pairs, expected ${expectedPairs}`;
  }
  return null;
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
