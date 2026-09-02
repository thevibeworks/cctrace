import type { TracePair } from "./types";
import { CATEGORIES, categorizeUrl } from "./categorize";
import { wireTables } from "./clients";
import { CLIENT_ICONS } from "./icons";
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
  extractEffort,
} from "./summarize";
import {
  wireDialect,
  openaiInput,
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
  threadEpochs,
  turnSnippet,
  mainThread,
  toolPreview,
  wsPath,
  wsRelText,
  cwdFromText,
  harnessPrompt,
  harnessTurnKind,
  continuationSummaryTurn,
  loopTurns,
  threadTimeSplit,
  isSpawnTool,
  escHtml,
  diffHunk,
  richToolBody,
} from "./session";
import { modelPricing, modelWindow, pairRates, pairCost, fmtCost, costTitle } from "./pricing";
import { stepCost, threadCostSplit, costEvents, usagePolls } from "./cost";
import {
  CTX_CATS,
  CTX_IMG_EST,
  estTokens,
  ctxTextCat,
  ctxBlockTokens,
  ctxEnvelope,
  ctxNormalizeTurns,
  ctxSnippet,
  contextComposition,
  contextItems,
  ctxGroupOf,
  contextGraph,
  ctxFlameTree,
  ctxFlameFind,
  ctxFlameLayout,
  ctxFlameDefault,
  contextTimeline,
  ctxInjectLabel,
  ctxAggregateTurns,
  ctxWindowTurns,
  ctxTurnSig,
  ctxOriginTurn,
  ctxCarrySpan,
  trajectoryRecords,
  trajectoryAtLevel,
  trajLabel,
  trajResultPreview,
} from "./context";
import markedSrc from "./vendor/marked.umd.js" with { type: "text" };
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
  sliceWindow,
  stepOutcome,
  sessionLanes,
  soFar,
  axisTicks,
  mergeBusy,
  timeScale,
  scaleX,
  scaleT,
  threadExtent,
  beatAt,
  chaptersOf,
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

// Dashboard entry: a 2x2 grid — "all the runs", not just this page's.
const DASH_ICON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="1.5" y="1.5" width="5.2" height="5.2" rx="1"/><rect x="9.3" y="1.5" width="5.2" height="5.2" rx="1"/><rect x="1.5" y="9.3" width="5.2" height="5.2" rx="1"/><rect x="9.3" y="9.3" width="5.2" height="5.2" rx="1"/></svg>`;

/** Run identity shown in the page header. All fields optional: `cctrace view`
 * rebuilds from a saved trace where the original cwd is unknown. */
export interface PageMeta {
  /** Project name — basename of the directory cctrace ran in. */
  project?: string;
  /** Full path of that directory (tooltip). */
  projectPath?: string;
  /** Basename of the trace file behind this page (live log or view source). */
  traceFile?: string;
  /** That file's path — relative to the project dir for a legacy ./.cctrace
   * trace, absolute into the store otherwise — the header title's
   * click-to-copy value, ready for `cctrace view`. */
  traceRelPath?: string;
  /** CLI being traced: claude | codex | grok. */
  client?: string;
  /** Trace size — the decoded .jsonl bytes — at render time (snapshots/
   * view exports); live pages get the growing number over the WebSocket. */
  traceBytes?: number;
  /** What the trace occupies on disk when that differs from traceBytes: an
   * archived (.zst/.gz) source. The chip shows the trace, the tip the disk. */
  traceDiskBytes?: number;
  /** "view" when the page serves a saved trace (cctrace view) — the UI
   * reads as a document (no live/offline framing, opens at the top). */
  mode?: string;
  /** The page holds the newest slice of a budgeted read, not the whole
   * trace — the header must say so (a silent 78% drop once shipped).
   * Shape mirrors ViewResult.truncated in src/view.ts. */
  truncated?: { droppedLines: number; droppedBytes: number; keptBytes: number; olderFiles?: number };
  /** The session's generated name (`cctrace title`), when one exists. */
  sessionTitle?: string;
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
      /* Where wall-clock went: model / tools / waiting. One wire fact, one
         hue, wherever it is drawn — the context overview's time track and
         the replay strip's lanes. Deliberately theme-independent (these
         are data colors, not chrome) and mid-tone enough to read on both
         backgrounds. */
      --lane-model: #4184e4; --lane-tools: #39c5cf; --lane-waiting: #d29922;
      --lane-ink: #0d1117;   /* text ON a lane span: the hues never flip, so neither does the ink */
      /* Where the money went: the four billed components, cheap to
         expensive. A sequential ramp, not six categorical hues — the cost
         track must not read as a second composition track. Data colors,
         so they are stated per theme only for contrast, never for state:
         green/red stay reserved for state. */
      --cost-read: #4c7f9b; --cost-write: #7c6fd0; --cost-input: #d4753c; --cost-output: #48a68a;
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
        --cost-read: #35708c; --cost-write: #6355b8; --cost-input: #b25a24; --cost-output: #2f8a70;
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
      --cost-read: #35708c; --cost-write: #6355b8; --cost-input: #b25a24; --cost-output: #2f8a70;
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
    /* The trace title copies its path (into the store, or project-relative
       for a legacy trace) — the string you paste into "cctrace view" or
       hand to an agent. */
    .ctx-proj.ctx-copy { cursor: pointer; }
    .ctx-proj.ctx-copy:hover { color: var(--accent); }
    .ctx-proj.copied { color: var(--green); }
    .ctx-title { color: var(--muted); font-style: italic; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 34ch; }
    .ctx-client {
      display: inline-flex; align-items: center; gap: 5px;
      border: 1px solid var(--border); border-radius: 4px;
      padding: 1px 6px; font-size: 11px; color: var(--text-muted); flex: none;
    }
    .ctx-client svg { width: 11px; height: 11px; flex-shrink: 0; }
    .ctx-sep { color: var(--text-faint); }
    .ctx-sess {
      font: inherit; color: var(--text-muted); cursor: pointer; flex-shrink: 0;
      background: var(--btn-bg); border: 1px solid var(--border);
      border-radius: 6px; padding: 1px 7px;
    }
    .ctx-sess:hover { color: var(--text); }
    .ctx-sess.copied { color: var(--green); border-color: var(--green); }
    /* Version badge: right side with the page chrome — what produced the
       page is a brand fact, separate from the run identity in .ctx. The
       hover tooltip is a miniature release note: slogan + fresh features. */
    .ver { display: inline-flex; align-items: baseline; gap: 6px; flex-shrink: 0; }
    .ver-badge { color: var(--text-faint); font-size: 11px; cursor: default; }
    .ver-badge:hover { color: var(--text-muted); }
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
      display: none; position: absolute; top: calc(100% + 8px); right: 0; z-index: 30;
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
    /* the page holds a budgeted tail of the trace, and says so */
    .trunc { font-size: 12px; color: var(--amber); flex-shrink: 0; white-space: nowrap; }
    .trunc:empty { display: none; }
    .trunc a { color: inherit; text-decoration: underline dotted; }
    .count { color: var(--text-muted); margin-left: auto; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
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
    /* Mask mode: blur identity values for screen sharing; hover to reveal
       one deliberately. Display-layer only (see src/redact.ts for capture). */
    /* mask categories: body carries mask-<key> classes for the enabled
       set (right-click the eye to choose); sid is OFF by default */
    body.mask-title [data-mask="title"], body.mask-sid [data-mask="sid"],
    body.mask-usage [data-mask="usage"] { filter: blur(5px); }
    body.mask-title [data-mask="title"]:hover, body.mask-sid [data-mask="sid"]:hover,
    body.mask-usage [data-mask="usage"]:hover { filter: none; }
    .mask-menu {
      position: absolute; right: 8px; top: 34px; z-index: 30; display: none;
      background: var(--bg-surface); border: 1px solid var(--border);
      border-radius: 6px; padding: 6px 10px; font-size: 11px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.35);
    }
    .mask-menu.open { display: block; }
    #act-wrap { position: relative; display: inline-block; }
    .act-menu { position: absolute; right: 0; top: 30px; z-index: 30; display: none;
      background: var(--bg-surface); border: 1px solid var(--border); border-radius: 6px;
      padding: 5px 0; font-size: 11px; min-width: 230px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.35); }
    .act-menu.open { display: block; }
    .act-menu a, .act-menu button { display: block; width: 100%; text-align: left;
      padding: 5px 12px; color: var(--text); background: none; border: none;
      font: inherit; cursor: pointer; text-decoration: none; }
    .act-menu a:hover, .act-menu button:hover { background: var(--hover); }
    .act-menu .am-head { padding: 4px 12px 2px; color: var(--text-faint); font-size: 10px; }
    .act-menu .am-sep { border-top: 1px solid var(--border); margin: 4px 0; }
    .act-menu .am-hint { color: var(--text-faint); font-size: 10px; padding-left: 6px; }
    .mask-menu label { display: flex; gap: 6px; align-items: center; padding: 3px 0; cursor: pointer; color: var(--text-muted); }
    .mask-menu .mm-head { color: var(--text-faint); padding-bottom: 3px; }
    /* rich tool bodies: git-style diffs, checklists, plan markdown */
    .diffview { margin: 4px 0; padding: 6px 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; font-size: 11px; line-height: 1.5; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
    .dv-del { display: block; background: color-mix(in srgb, var(--red) 11%, transparent); }
    .dv-add { display: block; background: color-mix(in srgb, var(--green) 11%, transparent); }
    .dv-note { color: var(--text-faint); font-size: 10px; padding: 2px 0; }
    .todolist { padding: 4px 2px; font-size: 12px; }
    .todo-row { padding: 1px 0; }
    .todo-st { margin-right: 7px; color: var(--text-muted); }
    .todo-completed { color: var(--text-faint); }
    .todo-in_progress .todo-st { color: var(--accent); }
    .todo-opt { padding-left: 16px; color: var(--text-muted); }
    .mdplan { padding: 4px 2px; }
    details.rawin { margin-top: 4px; }
    details.rawin summary { color: var(--text-faint); font-size: 10px; cursor: pointer; }
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
    /* Pressed toggles wear a quiet accent tint — accent means interactive
       (ui.md one-accent rule); green/red stay reserved for state. */
    .toolbar button.active {
      background: color-mix(in srgb, var(--accent) 12%, var(--btn-bg));
      border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
      color: var(--accent);
    }
    /* Toolbar groups: tight gap inside a group, the toolbar's own gap
       between groups; page + trace groups open with a hairline. The list
       group's flexible filter holds the right edge in the requests view;
       margin-left:auto holds it when the session view hides the middle. */
    .tb-group { display: flex; gap: 6px; align-items: center; min-width: 0; }
    #tb-list { flex: 1; }
    #tb-page, #tb-trace { border-left: 1px solid var(--border); padding-left: 8px; }
    #tb-trace { margin-left: auto; }
    body.view-session #tb-list, body.view-session #tb-page { display: none; }
    /* find is the session view's list-group counterpart: same slot, same
       leading position, so tb-trace keeps its hairline at the right edge */
    #tb-find { flex: 1; display: none; }
    body.view-session #tb-find { display: flex; }
    #sfind { max-width: 320px; }
    #sfind-count { color: var(--text-faint); font-size: 11px; font-variant-numeric: tabular-nums; flex: none; }
    /* ---- Select-to-purge ---- */
    /* Rows grow a quiet check gutter in selection mode; the purge button
       wears the state color — it deletes trace data permanently. */
    #sel-actions { display: none; align-items: center; gap: 6px; }
    body.selecting #sel-actions { display: inline-flex; }
    #sel-count { color: var(--text-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
    #sel-purge { color: var(--red); }
    #sel-purge[disabled] { opacity: 0.4; pointer-events: none; }
    body.selecting .pair-header::before {
      content: '\\25cb'; color: var(--text-faint); flex-shrink: 0; font-size: 11px;
    }
    body.selecting .pair.sel .pair-header::before { content: '\\25cf'; color: var(--accent); }
    body.selecting .pair.sel { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
    body.selecting .pair.sel .pair-header { background: color-mix(in srgb, var(--accent) 7%, var(--bg-surface)); }
    #prior-toggle { display: none; }
    #prior-toggle.avail { display: inline-block; }
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
      /* right padding clears the floating #rail-detail (right:18 + 26px) */
      padding: 0 48px 12px 16px;
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
    /* wider since rows carry ToolName(args) + file paths now */
    #threads { flex: 0 0 400px; min-width: 0; overflow-y: auto; padding: 8px; border-right: 1px solid var(--border); }
    /* right padding clears the floating nav-rail (right:18 + 26px button) so
       conversation text never sits under it */
    #convo { flex: 1; min-width: 0; overflow-y: auto; padding: 12px 48px 12px 16px; }
    @media (max-width: 960px) { #threads { flex-basis: 220px; } }
    /* ---- The trajectory bar: the session's overview, replay's instrument ---- */
    #replay-toggle { display: none; }
    body.view-session #replay-toggle { display: inline-block; }
    body.replaying #replay-toggle { background: var(--accent); border-color: var(--accent); color: #fff; }
    /* The bar is FRAME in the session view, ALWAYS (rev 3): the strip is
       the session's overview even before any replay — touching it enters
       replay at that moment. It scopes the panes below and must never
       scroll away with them. */
    #replay-bar {
      display: none; flex-direction: column; align-items: stretch; gap: 6px;
      padding: 7px 16px;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border);
      font-size: 12px;
    }
    body.view-session #replay-bar, body.replaying #replay-bar { display: flex; }
    /* No session pairs yet: an empty band asserting nothing is not a frame */
    body:not(.replaying) #replay-bar.rp-empty { display: none; }
    /* Replay's own chrome waits for replay: the strip without a cursor
       states history; the cursor states a moment. The veil/handle/slice
       carry inline styles, hence the !important. */
    body:not(.replaying) .rp-transport { display: none; }
    body:not(.replaying) #rp-veil, body:not(.replaying) #rp-handle,
    body:not(.replaying) #rp-slice { display: none !important; }
    /* Collapsed (the chevron in the clock gutter cell): the lanes fold
       away, the ~13px clock row stays — a thin ruler is still an overview.
       Replay needs its lanes, so replaying overrides the fold. */
    body:not(.replaying) #replay-bar.rp-collapsed #rp-lanes-body,
    body:not(.replaying) #replay-bar.rp-collapsed #rp-rules,
    body:not(.replaying) #replay-bar.rp-collapsed #rp-breaks,
    body:not(.replaying) #replay-bar.rp-collapsed .rp-glbl:not(.rp-g0) { display: none; }
    .rp-clps {
      font: inherit; font-size: 9px; line-height: var(--rp-lh);
      background: none; border: none; padding: 0 3px 0 0; margin: 0;
      color: var(--text-faint); cursor: pointer;
    }
    .rp-clps:hover { color: var(--text); }
    body.replaying .rp-clps { visibility: hidden; }
    .rp-transport { display: flex; align-items: center; gap: 8px; }
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
    /* ---- the trajectory strip: lanes x wall-clock ---- */
    /* One row per actor, one x axis, one playhead. The label gutter names
       every lane (a lane whose meaning is unstated is a decoration); the
       track scrolls horizontally inside the frame when zoomed. */
    #rp-lanes { --rp-lh: 13px; display: flex; align-items: flex-start; gap: 6px; }
    #rp-gut { flex: 0 0 56px; display: flex; flex-direction: column; }
    .rp-glbl {
      height: var(--rp-lh); line-height: var(--rp-lh);
      font-size: 10px; color: var(--text-faint);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #rp-scroll { flex: 1; min-width: 80px; overflow-x: auto; overflow-y: hidden; }
    #rp-lanes-track { position: relative; cursor: pointer; touch-action: none; user-select: none; }
    /* clipped: a label running past the last span must not grow the
       strip's scrollable width */
    .rp-lane { position: relative; height: var(--rp-lh); overflow: hidden; }
    .rp-lane::before {
      content: ''; position: absolute; left: 0; right: 0; top: 50%;
      border-top: 1px solid var(--border); opacity: 0.5;
    }
    /* every span is a wire timestamp: [t0, t1] of a pair, a gap, or a
       child thread. min-width keeps a 40ms call clickable. */
    .rp-span {
      position: absolute; top: 2px; bottom: 2px; min-width: 2px;
      border-radius: 2px; overflow: hidden;
      font-size: 10px; line-height: calc(var(--rp-lh) - 4px);
      color: var(--lane-ink); padding: 0 2px; white-space: nowrap;
    }
    .rp-span.model { background: var(--lane-model); }
    .rp-span.tools { background: var(--lane-tools); }
    /* waiting is the same gap lane, dimmed: the harness came back on its
       own, nothing was called */
    .rp-span.waiting { background: var(--lane-waiting); opacity: 0.45; }
    .rp-span.agent { background: var(--purple); }
    .rp-span.agent.more { opacity: 0.4; }
    .rp-span.open { background: none; border: 1px dashed var(--lane-model); color: var(--text-muted); }
    .rp-span.err { outline: 1px solid var(--red); outline-offset: -1px; }
    /* the TURNS lane (rev 6): one block per working loop, the prompt's
       instant (its accent left edge — what the human point was) to the
       loop's last reply. The minimap's clickable unit: the number shows
       at any depth the block can hold it, because the number IS the
       point; the prompt's words wait for full depth. The block under the
       conversation's reading position wears .cur — the sync, on the block. */
    /* (.rp-turn, not .turn — the conversation's turns own that name) */
    .rp-span.rp-turn {
      background: color-mix(in srgb, var(--accent) 18%, transparent);
      box-shadow: inset 2px 0 0 var(--accent);
      color: var(--text-muted); cursor: pointer;
    }
    .rp-span.rp-turn:hover { background: color-mix(in srgb, var(--accent) 30%, transparent); color: var(--text); }
    .rp-span.rp-turn.cur {
      background: color-mix(in srgb, var(--accent) 36%, transparent); color: var(--text);
      outline: 1px solid var(--accent); outline-offset: -1px;
    }
    /* a loop the harness started (a nudge, a loaded tool): a turn on the
       rail, but not the human's — its edge is faint */
    .rp-span.rp-turn.inj { box-shadow: inset 2px 0 0 var(--text-faint); opacity: 0.7; }
    #rp-lanes .rp-span.rp-turn.w24 .rp-lbl.i { display: inline; }
    #rp-lanes[data-depth="full"] .rp-span.rp-turn.w24 .rp-lbl.i { display: none; }
    .rp-point {
      position: absolute; top: 1px; bottom: 1px; width: 2px;
      transform: translateX(-1px);
      background: var(--accent); font-size: 10px; color: var(--text-muted);
      line-height: calc(var(--rp-lh) - 2px); white-space: nowrap;
    }
    .rp-point .rp-lbl { position: absolute; left: 5px; top: 0; }
    /* reading depth is a function of zoom, never a toggle: map = shapes,
       read = initials and marks, full = names. The markup always carries
       the labels; only CSS decides. .w24 = wide enough to hold one. */
    .rp-lbl, .rp-mk { display: none; }
    #rp-lanes[data-depth="read"] .rp-span.w24 .rp-lbl.i,
    #rp-lanes[data-depth="full"] .rp-span.w24 .rp-lbl.n,
    #rp-lanes[data-depth="full"] .rp-point .rp-lbl,
    #rp-lanes[data-depth="read"] .rp-mk,
    #rp-lanes[data-depth="full"] .rp-mk { display: inline; }
    /* the CLOCK row: a ruler in the page's local time. A hairline with its
       label to the right; a major tick (the first of a calendar day) names
       the date and drops a rule through every lane below. */
    #rp-axis { position: relative; height: var(--rp-lh); overflow: hidden; }
    .rp-tick {
      position: absolute; top: 0; height: var(--rp-lh);
      border-left: 1px solid var(--border); padding-left: 3px;
      font-size: 10px; line-height: var(--rp-lh); color: var(--text-faint);
      white-space: nowrap; font-variant-numeric: tabular-nums;
    }
    .rp-tick.major { color: var(--text-muted); border-left-color: var(--text-faint); }
    /* a compressed idle stretch: the thread did nothing here, so its time is
       a fixed 28px column instead of half the strip. The clock row names how
       long was skipped (the ruler compresses; the clock never lies), the
       column hatches it across every lane. */
    .rp-bk {
      position: absolute; top: 0; height: var(--rp-lh);
      transform: translateX(-50%);
      font-size: 10px; line-height: var(--rp-lh); color: var(--text-faint);
      white-space: nowrap; font-variant-numeric: tabular-nums;
    }
    /* against a track edge the label anchors INSIDE it, never half off */
    .rp-bk.at-end { transform: translateX(-100%); }
    .rp-bk.at-start { transform: none; }
    #rp-breaks { position: absolute; left: 0; right: 0; top: var(--rp-lh); bottom: 0; pointer-events: none; }
    .rp-break {
      position: absolute; top: 0; bottom: 0;
      background: repeating-linear-gradient(
        135deg,
        color-mix(in srgb, var(--border) 35%, transparent) 0 2px,
        transparent 2px 5px);
    }
    /* drawn BEFORE the lanes so the spans read over it, never under */
    #rp-rules { position: absolute; left: 0; right: 0; top: var(--rp-lh); bottom: 0; pointer-events: none; }
    .rp-rule { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--border); opacity: 0.55; }
    /* the VEIL: the future is dimmed. A replay never shows the reader
       something that has not happened — the same statement the convo
       makes, made on the strip. (The rev-1 accent-tinted PAST cost the
       model spans their contrast exactly where the reader looks.) */
    #rp-veil {
      position: absolute; left: 0; right: 0; top: 0; bottom: 0;
      background: color-mix(in srgb, var(--bg-surface) 55%, transparent);
      pointer-events: none;
    }
    /* the selected thread draws full, every other thread ghosts: the shape
       of the whole capture stays readable, the selected loop is the picture */
    #rp-lanes-body .other { opacity: 0.3; }
    /* the slice band: a selected range of the timeline (shift+drag) */
    #rp-slice {
      position: absolute; top: 0; bottom: 0; display: none;
      background: color-mix(in srgb, var(--accent) 16%, transparent);
      border-left: 1px solid var(--accent); border-right: 1px solid var(--accent);
      pointer-events: none;
    }
    #rp-slice-chip { display: none; align-items: center; gap: 6px; font-size: 11px;
      color: var(--text-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
    #rp-slice-chip .rp-btn { font-size: 10px; padding: 3px 7px; }
    /* the harness lane: marks, not spans — a compaction and a failed
       request are moments, and both surfaces paint them the same. */
    .rp-mark {
      position: absolute; top: 0; bottom: 0; width: 1px;
      transform: translateX(-0.5px);
      font-size: 10px; line-height: var(--rp-lh);
    }
    .rp-mark .rp-mk { position: absolute; left: 2px; top: 0; }
    /* a context boundary on the timeline: where the window collapsed
       (compaction / rewind). The trajectory's axis break, full height. */
    .rp-mark.cut { background: var(--amber); color: var(--amber); opacity: 0.85; }
    .rp-mark.err { background: var(--red); color: var(--red); }
    /* the playhead: the page's ONE moving thing while replaying. A halo in
       the strip's own surface color so it reads over a span of any hue, and
       a flag on the clock row so the eye finds it in a dense region. */
    #rp-handle {
      position: absolute; top: 0; bottom: 0; width: 2px; left: 0;
      background: var(--accent); pointer-events: none;
      box-shadow: 0 0 0 1px var(--bg-surface);
    }
    #rp-handle::before {
      content: ''; position: absolute; top: 0; left: -2px;
      border-left: 3px solid transparent; border-right: 3px solid transparent;
      border-top: 5px solid var(--accent);
    }
    /* the READING marker: where the conversation's viewport sits, on the
       strip — the playhead's quiet reading-mode twin (replay-stage.md rev 4).
       Moves only under the reader's own scroll; hides while replaying,
       where the playhead owns position. */
    #rp-read {
      position: absolute; top: 0; bottom: 0; width: 0; display: none;
      border-left: 1px solid var(--text-faint); opacity: 0.7;
      pointer-events: none;
    }
    #rp-read::before {
      content: ''; position: absolute; top: 0; left: -3px;
      border-left: 3px solid transparent; border-right: 3px solid transparent;
      border-top: 4px solid var(--text-faint);
    }
    body.replaying #rp-read { display: none !important; }
    #rp-time { margin-left: auto; color: var(--text-muted); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    /* the live chip: at the edge it is STATE (a green dot, the header status
       dot's own green), behind it is the control that snaps back. Live runs
       only — a saved trace has no edge to chase. */
    #rp-live { display: inline-flex; align-items: center; }
    #rp-live .at-edge {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 11px; color: var(--text-faint); white-space: nowrap;
    }
    #rp-live .at-edge::before {
      content: ''; width: 7px; height: 7px; border-radius: 50%;
      background: var(--green); flex-shrink: 0;
    }
    /* ---- the stage (#stage): the beat, the tally ----
       Top of the threads column while replaying (the rail stays under it:
       the strip is time navigation, the rail is still the outline). The
       stage is what this STEP did; the moment is the strip's cursor. */
    #stage { padding: 2px 4px 8px; border-bottom: 1px solid var(--border); margin-bottom: 6px; }
    /* so far: the call tally as of the cursor — the only place the
       per-tool count is stated */
    .st-sofar {
      font-size: 10px; color: var(--text-faint); padding: 6px 6px 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    @media (prefers-reduced-motion: reduce) {
      .sb.arrived { animation: none; }
    }
    /* the beat: what the agent did at this step, one row per fact */
    .sb { margin-top: 8px; }
    /* a tail advance landed a NEW step: the same 160ms fade a live row
       gets. A scrub never fades — scrubbing is continuous. */
    .sb.arrived { animation: arrive 160ms cubic-bezier(0.23, 1, 0.32, 1); }
    /* the loop's head: which task this step serves, so the reader never
       has to find it in the rail. Click jumps to that chapter. */
    .sb-head {
      font-size: 11px; color: var(--text-faint); padding: 0 6px 5px; cursor: pointer;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .sb-head:hover { color: var(--text-muted); }
    .sb-cap {
      font-size: 11px; color: var(--text-faint); padding: 0 6px 4px;
      font-variant-numeric: tabular-nums;
    }
    .sb-cap .sb-turn { color: var(--text); }
    .sb-row { display: flex; align-items: flex-start; gap: 6px; padding: 0 6px; }
    .sb-row > details { flex: 1 1 auto; min-width: 0; }
    .sb-mark { flex: none; font-size: 10px; color: var(--text-faint); line-height: 20px; }
    .sb-line { display: flex; align-items: baseline; gap: 6px; padding: 2px 6px; font-size: 11px; }
    .sb-lbl { flex: none; font-size: 10px; color: var(--text-faint); }
    .sb-txt { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); }
    /* the model's stated reasoning is a claim it made, not an observation:
       dimmed and labelled, never drawn as causation (replay-stage.md) */
    .sb-think .sb-txt { color: var(--text-faint); font-style: italic; }
    .sb-foot {
      display: flex; align-items: baseline; gap: 6px; margin-top: 6px;
      padding: 4px 6px 0; border-top: 1px solid var(--border);
      font-size: 11px; color: var(--text-faint); font-variant-numeric: tabular-nums;
    }
    .sb-gap { flex: 1 1 auto; min-width: 6px; }
    .sb-amt { flex: none; color: var(--text-muted); }
    .sb-none { font-size: 11px; color: var(--text-faint); padding: 4px 6px; }
    /* presentation (F): the chrome steps out, the panes take the viewport.
       Type scale unchanged — a presentation is the same page, undressed. */
    body.present header, body.present #toolbar, body.present .cats, body.present .nav-rail { display: none; }
    /* boot placeholder: a verb while the wire loads (ccx tradition) */
    .boot-wait { padding: 48px 24px; color: var(--text-faint); font-size: 13px; }
    .bw-star { color: var(--accent); display: inline-block; animation: bwPulse 1.6s ease-in-out infinite; }
    @keyframes bwPulse { 50% { opacity: 0.25; } }
    /* the pulse: a terminal-like status line for LIVE eyes (live + tail
       pages, session view) — what the agent last did, how long ago, and
       the one cache deadline that matters (the newest request's) */
    #pulse {
      position: absolute; left: 0; right: 0; bottom: 0; z-index: 4;
      display: none; align-items: center; gap: 10px; padding: 8px 16px;
      font-size: 12px; color: var(--text);
      background: linear-gradient(90deg,
        color-mix(in srgb, var(--accent) 8%, var(--bg-surface)) 0%,
        color-mix(in srgb, var(--bg-surface) 94%, transparent) 45%);
      backdrop-filter: blur(4px); border-top: 1px solid var(--border);
      white-space: nowrap; overflow: hidden;
    }
    body.view-session.pulse-on #pulse { display: flex; }
    /* fresh = the star spins and breathes (the agent is between requests);
       idle = it settles. The verb leads while fresh — the eyes' answer to
       "is it doing something". */
    #pulse .p-star { color: var(--accent); display: inline-block; animation: pspin 3.2s linear infinite, bwPulse 1.6s ease-in-out infinite; }
    #pulse.idle .p-star { animation: none; opacity: 0.45; }
    @keyframes pspin { to { transform: rotate(360deg); } }
    #pulse .p-verb { color: var(--accent); flex: none; }
    #pulse.idle .p-verb { display: none; }
    #pulse .p-act { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    #pulse.idle .p-act { color: var(--text-muted); }
    #pulse .p-t { color: var(--text-faint); font-variant-numeric: tabular-nums; flex: none; }
    #pulse .p-exp { color: var(--amber); flex: none; }
    .p-fade { animation: pfade 160ms ease-out; }
    @keyframes pfade { from { opacity: 0; } }
    /* the pulse floats over the panes' bottom edge — give both scroll ends
       clearance so the session's last line reads above it, not beneath it */
    body.view-session.pulse-on #convo { padding-bottom: 64px; }
    body.view-session.pulse-on #threads { padding-bottom: 64px; }
    /* find jump: one amber breath on the landed node, then gone */
    .find-flash { animation: findflash 1.2s ease-out; }
    @keyframes findflash { 0% { outline: 2px solid var(--amber); outline-offset: 3px; } 100% { outline: 2px solid transparent; outline-offset: 3px; } }
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
    /* No entry animation on .pair itself: bulk renders and filter
       re-renders must be instant (motion budget) — live arrivals get the
       one .arrived opacity fade below. */
    .pair {
      border: 1px solid var(--border);
      border-radius: 6px;
      margin-bottom: 6px;
      overflow: hidden;
    }
    .pair.selected { border-color: var(--accent); }
    .pair.selected .pair-header { background: var(--hover); }
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
    .ttft { color: var(--text-faint); font-size: 11px; min-width: 52px; text-align: right; flex-shrink: 0; font-variant-numeric: tabular-nums; }
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
    /* The sticky-bar request id doubles as click-to-copy (reachable even
       mid-scroll inside a megabyte conversation — that is why the bar is
       sticky). Button reset keeps it reading as the quiet label it was. */
    .detail-id {
      margin-left: auto; color: var(--text-faint); font-size: 11px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      background: none; border: none; padding: 0; font-family: inherit;
      cursor: pointer;
    }
    .detail-id:hover { color: var(--text-muted); }
    .detail-id.copied { color: var(--green); }
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
    /* the outline's numbering, repeated on the turn itself — turn03 in the
       pane is turn03 here; stays faint whatever the role bar's color */
    .turn-ord {
      color: var(--text-faint); text-transform: none; letter-spacing: 0;
      font-variant-numeric: tabular-nums;
    }
    /* an intermediate step's address ("01.3") — quieter than turn ordinals */
    .turn-sord { opacity: 0.75; }
    .turn-usage {
      margin-left: auto; color: var(--text-faint); font-size: 10px;
      text-transform: none; letter-spacing: 0; font-variant-numeric: tabular-nums;
    }
    .turn-wire { color: var(--accent); font-size: 10px; text-transform: none; letter-spacing: 0; text-decoration: none; }
    .turn-wire:hover { text-decoration: underline; }
    /* wall-clock at the role bar's right edge; solo = no usage span holding
       the edge (user turns), so it takes the flexible gap itself */
    .turn-time {
      color: var(--text-faint); font-size: 10px; flex-shrink: 0;
      text-transform: none; letter-spacing: 0; font-variant-numeric: tabular-nums;
    }
    .turn-time.tt-solo { margin-left: auto; }
    .msg-text {
      padding: 10px 12px;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.5;
    }
    .msg-text.think { color: var(--text-muted); font-style: italic; }
    /* Inline code + code blocks (shared by old snapshots and marked output) */
    .msg-text code {
      background: var(--bg-surface); border: 1px solid var(--border);
      border-radius: 3px; padding: 0 4px; font-size: 11px;
    }
    .msg-text .md-code { margin: 6px 0; font-size: 11px; }
    .msg-text .md-code code {
      background: none; border: none; border-radius: 0; padding: 0;
    }
    .msg-text .md-h { font-weight: 600; color: var(--text); margin: 8px 0 2px; }
    .msg-text a { color: var(--accent); }
    /* ---- Full markdown (marked.js GFM) ---- */
    .msg-md { white-space: normal; }
    .msg-md p { margin: 0 0 8px; }
    .msg-md p:last-child { margin-bottom: 0; }
    .msg-md > :first-child { margin-top: 0; }
    .msg-md > :last-child { margin-bottom: 0; }
    .msg-md h1, .msg-md h2, .msg-md h3,
    .msg-md h4, .msg-md h5, .msg-md h6 {
      font-weight: 600; color: var(--text);
      margin: 14px 0 6px; line-height: 1.3;
    }
    .msg-md h1 { font-size: 15px; }
    .msg-md h2 { font-size: 14px; }
    .msg-md h3 { font-size: 13px; }
    .msg-md h4, .msg-md h5, .msg-md h6 { font-size: 12px; }
    .msg-md ul, .msg-md ol {
      margin: 4px 0 8px; padding-left: 22px;
    }
    .msg-md li { margin: 2px 0; }
    .msg-md li > p { margin: 2px 0; }
    .msg-md li > ul, .msg-md li > ol { margin: 2px 0 2px; }
    .msg-md input[type="checkbox"] {
      margin: 0 6px 0 -18px; vertical-align: middle;
      pointer-events: none;
    }
    .msg-md table {
      border-collapse: collapse; margin: 8px 0;
      font-size: 11px; width: auto; max-width: 100%;
      display: block; overflow-x: auto;
    }
    .msg-md th, .msg-md td {
      border: 1px solid var(--border); padding: 4px 10px;
      text-align: left; white-space: nowrap;
    }
    .msg-md th {
      background: var(--bg-surface); font-weight: 600; color: var(--text);
    }
    .msg-md td { white-space: normal; }
    .msg-md tr:nth-child(even) td {
      background: color-mix(in srgb, var(--bg-surface) 30%, var(--bg));
    }
    .msg-md blockquote {
      margin: 8px 0; padding: 2px 12px;
      border-left: 3px solid var(--border); color: var(--text-muted);
    }
    .msg-md blockquote p { margin: 4px 0; }
    .msg-md hr {
      border: none; border-top: 1px solid var(--border); margin: 12px 0;
    }
    .msg-md strong { font-weight: 600; color: var(--text); }
    .msg-md del { color: var(--text-muted); }
    .msg-md img { max-width: 100%; }
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
    /* wire image attachments: thumbnail by default, click for full size —
       the bytes were already in the trace, rendering them adds nothing */
    .msg-imgwrap { padding: 6px 12px; }
    .msg-img {
      display: block; max-width: 320px; max-height: 240px;
      border: 1px solid var(--border); border-radius: 4px;
      cursor: zoom-in; background: var(--bg-surface);
    }
    .msg-img.full { max-width: 100%; max-height: none; cursor: zoom-out; }
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
    /* Conversation folds appear by the hundred — their copy button reveals
       on summary hover (same pattern as .pre-wrap's copy), visibility so the
       layout never shifts. Payload folds keep theirs visible (few of them,
       matches the Headers section's copy). */
    .fold > summary .fold-copy { visibility: hidden; }
    .fold > summary:hover .fold-copy, .fold[open] > summary .fold-copy { visibility: visible; }
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
    .fold-ico { display: inline-flex; flex: none; }
    .fold.fold-agent > summary .fold-ico,
    .fold.fold-skill > summary .fold-ico,
    .fold.fold-mcp > summary .fold-ico { color: var(--purple); }
    /* the spawned thread's outcome, on the spawn itself */
    .fold-stat {
      flex: none; margin-left: auto; color: var(--text-faint);
      font-size: 11px; font-variant-numeric: tabular-nums;
    }
    .fold-link { color: var(--accent); font-size: 11px; text-decoration: none; flex: none; margin-left: auto; }
    .fold-stat ~ .fold-link { margin-left: 10px; }
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
    /* Selection is a wash, not an edge (accent edges read as chrome —
       same rule as user-turn emphasis). The expanded request list below
       the selected card is the louder signal anyway. */
    .thread.selected { border-color: color-mix(in srgb, var(--accent) 30%, var(--border)); }
    .thread.selected .thread-head {
      background: color-mix(in srgb, var(--accent) 9%, var(--bg-surface));
    }
    .thread-head {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 10px; background: var(--bg-surface);
      color: inherit; text-decoration: none; cursor: pointer;
    }
    .thread-head:hover { background: var(--hover); }
    /* One accent (ui.md rule 2): kind chips are neutral outlines — the
       word carries the meaning; red/amber stay reserved for state. */
    .tkind {
      padding: 1px 7px; border-radius: 999px; font-size: 10px;
      text-transform: uppercase; color: var(--text-muted);
      border: 1px solid var(--border); flex-shrink: 0;
    }
    .thread-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* the model wears the identifier color (same as request METHOD and
       tool names) — it is the header fact people look for; hover carries
       the exact id, effort level, and context-window facts */
    .tmodel {
      margin-left: auto; flex-shrink: 0; font-size: 10px;
      color: var(--text-method); font-variant-numeric: tabular-nums;
    }
    /* the container's key, small caps: SESSION <sid> — accent-tinted so
       the eye finds the identity without the value itself shouting */
    .klabel {
      color: color-mix(in srgb, var(--accent) 55%, var(--text-faint));
      font-size: 9px; margin-right: 4px;
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    .thread-meta {
      padding: 6px 10px; font-size: 11px; color: var(--text-muted);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* The conversation outline as a RAIL (session-tab round 9): one
       continuous line down the session body, every row a node on it.
       .rgut is the shared gutter column — the line lives in its ::before,
       the node (dot/ring) sits on top and punches through with a bg halo.
       One grammar for epoch heads, turns, superseded rows, and subagent
       branches; the rail itself carries the git-branch metaphor. */
    .thread-turns { border-top: 1px solid var(--border); }
    .rgut {
      position: relative; align-self: stretch; flex: none;
      width: 14px; display: flex; align-items: center; justify-content: center;
    }
    .rgut::before {
      content: ''; position: absolute; left: 50%; top: 0; bottom: 0;
      width: 1px; margin-left: -0.5px;
      background: color-mix(in srgb, var(--accent) 22%, var(--border));
    }
    /* branch elbow: the rail continues, an arm curves off to the row */
    .rgut-br::after {
      content: ''; position: absolute; left: 50%; top: -2px;
      width: 9px; height: 58%; margin-left: -0.5px;
      border-left: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border));
      border-bottom: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border));
      border-bottom-left-radius: 7px;
    }
    /* epoch node: a hollow accent ring on the rail — structure, not a
       message; bigger than turn dots, same family as the klabel tint */
    .enode {
      position: relative; width: 8px; height: 8px; border-radius: 50%;
      flex: none; background: var(--bg); box-shadow: 0 0 0 2px var(--bg);
      border: 1.5px solid color-mix(in srgb, var(--accent) 55%, var(--text-faint));
    }
    .tepoch {
      display: flex; align-items: center; gap: 8px;
      padding: 4px 10px; font-size: 11px;
      color: var(--text); text-decoration: none;
      font-variant-numeric: tabular-nums;
    }
    .tepoch .rgut { margin: -4px 0; }
    .tepoch:hover { background: var(--hover); }
    .tepoch-ord { color: var(--text-faint); flex-shrink: 0; }
    .tepoch-turns { margin-left: auto; color: var(--text-faint); }
    /* subagent branch row: attached at its spawn turn, elbow off the rail,
       outcome stats inline — the thread is one click away */
    .tbranch {
      display: flex; align-items: center; gap: 8px;
      padding: 3px 10px; font-size: 11px;
      color: var(--text-faint); text-decoration: none;
      font-variant-numeric: tabular-nums;
    }
    .tbranch .rgut { margin: -3px 0; }
    .tbranch:hover { background: var(--hover); }
    /* content indents one outline level under its spawn turn — the rail
       column itself never moves, only the arm reaches further */
    .tbranch-label {
      margin-left: 12px; color: var(--purple); overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap;
    }
    .tbranch-model { color: var(--text-method); flex: none; font-size: 10px; }
    .tbranch-stat { margin-left: auto; flex-shrink: 0; }
    /* compact boundary: the request body sent to the API changed
       completely here — a break mark on the rail (two slanted hairlines,
       the axis-break glyph), grey like superseded: a timeline fact. */
    .cnode {
      position: relative; width: 9px; height: 7px; flex: none;
      background: var(--bg); box-shadow: 0 0 0 2px var(--bg);
    }
    .cnode::before, .cnode::after {
      content: ''; position: absolute; left: 0; right: 0; height: 1px;
      background: var(--text-muted); transform: rotate(-14deg);
    }
    .cnode::before { top: 1px; }
    .cnode::after { bottom: 1px; }
    .tcompact {
      display: flex; align-items: center; gap: 8px;
      padding: 3px 10px; font-size: 11px;
      color: var(--text-muted); text-decoration: none;
      font-variant-numeric: tabular-nums;
    }
    .tcompact .rgut { margin: -3px 0; }
    .tcompact:hover { background: var(--hover); }
    .tcompact-label {
      text-transform: uppercase; font-size: 9px; letter-spacing: 0.5px;
    }
    .tcompact-note { margin-left: auto; color: var(--text-faint); }
    /* sessions-layer glyphs: stroke-only, inherit the row's color */
    .sico { width: 12px; height: 12px; flex-shrink: 0; color: var(--text-faint); }
    .sess > summary .sico { color: color-mix(in srgb, var(--accent) 55%, var(--text-faint)); }
    /* Instant hover panel (session pane): filled from data-tip, first
       line = heading, blank lines = section gaps, "---" lines = hairline
       section dividers, "> " lines = faint interaction hints. Width is
       capped below the threads pane's 400px so a hover never blankets
       the whole sidebar column. */
    .tip {
      position: fixed; z-index: 100; display: none;
      max-width: 320px; padding: 7px 10px;
      background: var(--bg-surface); border: 1px solid var(--border);
      border-radius: 6px; box-shadow: 0 6px 20px rgba(0,0,0,0.35);
      font-size: 11px; line-height: 1.55; color: var(--text-muted);
      pointer-events: none; font-variant-numeric: tabular-nums;
      overflow-wrap: break-word;
    }
    .tip.show { display: block; }
    .tip-head { color: var(--text); }
    .tip-gap { height: 6px; }
    .tip-sep { border-top: 1px solid var(--border); margin: 6px -10px; }
    .tip-hint { color: var(--text-faint); font-size: 10px; }
    .tturn {
      display: flex; align-items: center; gap: 8px;
      padding: 3px 10px; font-size: 11px;
      color: var(--text-faint); text-decoration: none;
      font-variant-numeric: tabular-nums;
    }
    .tturn .rgut { margin: -3px 0; }
    /* Every turn is a node on the rail. User turns are a hollow ring (the
       human's side has no wire verdict); assistant dots carry the request's:
       green = healthy cache hit, amber = weak hit (<90%) / cold / miss,
       red = failed request, neutral = no cache in play / unattributed. */
    .cdot {
      position: relative; width: 6px; height: 6px; border-radius: 50%;
      background: var(--border); flex: none;
      box-shadow: 0 0 0 2px var(--bg);
    }
    .cdot-hit { background: var(--green); }
    .cdot-warn { background: var(--amber); }
    .cdot-err { background: var(--red); }
    /* The human's rows are a terminal prompt glyph, not a wire dot — the
       user has no wire verdict; ❯ is the shell's own "your turn" marker.
       The rail line skips user heads: the rail spans the WORK of a turn. */
    .gut-user {
      color: color-mix(in srgb, var(--accent) 65%, var(--text-muted));
      font-weight: 600; font-size: 10px; line-height: 1;
      background: var(--bg); box-shadow: 0 0 0 2px var(--bg);
    }
    .tturn-user .rgut::before { display: none; }
    /* The ❯ gutter doubles as the turn's fold toggle: clicking it collapses
       the loop's agent work under the head (terminal semantics — the prompt
       line stays, the output folds). Hover names the affordance. */
    .tturn-head .rgut { cursor: pointer; }
    .tturn-head .rgut:hover .gut-user, .tturn-head .rgut:hover .cdot { color: var(--accent); background: var(--accent); }
    .tturn-head .rgut:hover .gut-user { background: var(--bg); }
    .tturn-fold-n { margin-left: auto; flex: none; color: var(--text-faint); font-size: 10px; }
    /* step sub-ordinal (".2" under the head's "01") — quieter than the head */
    .tturn-sord { font-size: 10px; opacity: 0.75; }
    /* step outcome: a tool call this step made returned is_error */
    .tturn-terr { margin-left: auto; flex: none; color: var(--red); font-size: 10px; opacity: 0.8; }
    .tturn-user .tturn-text { color: var(--text); }
    .tturn-fin .tturn-text { color: var(--text-muted); }
    .tturn:hover { background: var(--hover); color: var(--text); }
    .tturn-ord { color: var(--text-faint); flex-shrink: 0; }
    .tturn:hover .tturn-text { color: var(--text); }
    .tturn-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tturn-tools { color: var(--text-faint); }
    /* Tool names are the agent's verbs — same color as the request METHOD
       column, no new palette entry. Args stay in the row's quiet color. */
    .tname { color: var(--text-method); }
    .tname-agent { color: var(--purple); }
    .fold-tool > summary .fold-title { color: var(--text-method); }
    /* Working-loop nesting: agent work + final response indent under their
       user head; intermediate rows read quieter than the final response. */
    .tturn-sub { padding-left: 20px; }
    .tturn-mid .tturn-text { color: var(--text-faint); }
    /* Harness-authored messages wear one small-caps SYS tag (same family
       as the convo's continuation-summary tag) — recap, tool loads,
       automated notifications: system scope, never the human speaking. */
    .sys-tag {
      font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px;
      color: var(--text-muted); border: 1px solid var(--border);
      border-radius: 4px; padding: 0 4px; margin-right: 6px; flex: none;
    }
    /* a superseded exchange at its timeline position: grey, half-present —
       it happened here, then left history */
    .tturn-sup { opacity: 0.6; }
    .tturn-sup:hover { opacity: 1; }
    /* Session rollup line above the thread cards: counts across all threads,
       error parts red and only present when nonzero. */
    .threads-sum {
      padding: 4px 10px 8px; font-size: 11px; color: var(--text-faint);
      font-variant-numeric: tabular-nums;
    }
    /* turn-level truth markers: rewound branch tips, compact-folded
       bodies, failed requests — quiet bordered tags, no fill */
    .treq-mark {
      font-size: 10px; color: var(--text-faint); align-self: center;
      border: 1px solid var(--border); border-radius: 4px; padding: 0 4px;
      white-space: nowrap;
    }
    .treq-mark.amber { color: var(--amber); border-color: var(--amber); }
    .treq-mark.err { color: var(--red); border-color: var(--red); }
    .amber { color: var(--amber); }
    /* The sessions layer: the SESSION is the container — same card grammar
       as a thread card, one level up. Threads flatten to divided rows
       inside it; invisible on single-session traces (zero new chrome). */
    .sess {
      border: 1px solid var(--border); border-radius: 6px;
      margin-bottom: 8px; overflow: hidden;
    }
    .sess > summary {
      display: flex; gap: 10px; align-items: baseline;
      cursor: pointer; padding: 7px 10px; font-size: 12px;
      background: var(--bg-surface); color: var(--text-muted);
      list-style: none; user-select: none;
    }
    .sess > summary::-webkit-details-marker { display: none; }
    .sess > summary::before {
      content: '\\25B8'; font-size: 10px; color: var(--text-faint);
      align-self: center; flex-shrink: 0;
    }
    .sess[open] > summary::before { content: '\\25BE'; }
    .sess > summary:hover { background: var(--hover); }
    .sess.selected {
      border-color: color-mix(in srgb, var(--accent) 30%, var(--border));
    }
    .sess.selected > summary {
      background: color-mix(in srgb, var(--accent) 8%, var(--bg-surface));
    }
    /* not bold — the sid is identity, not emphasis; the model chip is the
       thing worth finding on a header */
    .sess-sid { color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .sess-sid[data-sid]:hover { text-decoration: underline dashed; }
    .sess-sid.copied { color: var(--green); }
    .sess-turns { color: var(--text-muted); font-size: 11px; flex-shrink: 0; }
    .sess-attrs {
      margin-left: auto; flex-shrink: 0; text-align: right;
      color: var(--text-faint); font-size: 11px; font-variant-numeric: tabular-nums;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* an absorbed chat's model chip sits with the identity, not the attrs
       (which own the right edge via their auto margin) */
    .sess > summary .tmodel { margin-left: 0; }
    /* threads become rows of their session card, not cards-in-a-card */
    .sess .thread {
      border: none; border-radius: 0; margin: 0;
      border-top: 1px solid var(--border);
    }
    .sess .fold.box { border: none; border-top: 1px solid var(--border); border-radius: 0; margin: 0; }
    /* rows inside the card stay plain — the card header owns the surface */
    .sess .thread-head { background: transparent; }
    .sess .thread-head:hover { background: var(--hover); }
    .sess .thread.selected .thread-head {
      background: color-mix(in srgb, var(--accent) 9%, var(--bg));
    }
    /* subagent cards nest under their dispatching thread: an indented
       block hanging off the same rail tint as the outline — structure,
       not accent (the tree edge is a fact, not an interaction) */
    .tkids { position: relative; padding-left: 14px; }
    .tkids::before {
      content: ''; position: absolute; left: 7px; top: 0; bottom: 0;
      width: 1px; background: color-mix(in srgb, var(--accent) 22%, var(--border));
    }
    .tkids .thread { border-top: 1px solid var(--border); }
    /* the way home from a stray subagent card (parent in another session) */
    .tparent { color: var(--text-muted); text-decoration: none; }
    .tparent:hover { color: var(--accent); }
    .agent-note {
      padding: 8px 12px; margin-bottom: 8px;
      border: 1px dashed var(--purple); border-radius: 6px;
      font-size: 12px; color: var(--text-muted);
    }
    /* an exchange that left history — grey, not amber: it's a timeline
       fact, not a warning (we can't know if it was /rewind, an edit, or
       an ephemeral injected exchange) */
    .rewound-mark {
      padding: 4px 12px; margin: 6px 0;
      font-size: 11px; color: var(--text-faint);
      border-left: 2px dashed var(--border);
    }
    .rewound-mark a { color: var(--text-muted); }
    /* a failed-request run IS a warning — red edge, state color */
    .errrun-mark { border-left-color: var(--red); }
    /* compact divider (convo pane): dashed — the context above it was
       rewritten; the conversation continues but the model's memory of it
       is the summary/folded form only */
    .cmark {
      display: flex; align-items: center; gap: 10px;
      margin: 16px 0 8px; font-size: 11px; color: var(--text-faint);
      font-variant-numeric: tabular-nums; white-space: nowrap;
    }
    .cmark::before, .cmark::after {
      content: ''; flex: 1; border-top: 1px dashed var(--border);
    }
    .cmark a { color: var(--text-muted); text-decoration: none; }
    .cmark a:hover { text-decoration: underline; }
    /* the continuation summary is not a normal prompt — tag it */
    .sum-tag {
      font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px;
      color: var(--text-muted); border: 1px solid var(--border);
      border-radius: 4px; padding: 0 4px; margin-left: 8px; flex: none;
    }
    /* epoch divider: a hairline where a /model switch takes over — the
       conversation flows through it, so a rule, not a box */
    .epoch-mark {
      display: flex; align-items: center; gap: 10px;
      margin: 16px 0 8px; font-size: 11px; color: var(--text-faint);
      font-variant-numeric: tabular-nums; white-space: nowrap;
    }
    .epoch-mark::before, .epoch-mark::after {
      content: ''; flex: 1; border-top: 1px solid var(--border);
    }
    .agent-note a { color: var(--accent); }
    /* ---- Context view: an overview that drives three decks ----
       THESIS: this page has ONE subject (the agent's context window over
       time) and ONE selection (a pinned step + a brushed range). Every
       question a reader has about it — what is in the window, what the
       agent did, what changed it — is a READING of that selection, never
       a different place to navigate to. So: a DevTools shell. An
       interactive overview owns the time axis and belongs to the FRAME
       (scrolling away the control that scopes the content under it is
       the thing a stacked report gets wrong); a margin states the
       balance that must close — six categories summing to the assembled
       window, the estimate reconciled against the provider's prompt, the
       whole against the model's limit — and never scrolls away; one deck
       at a time answers the question.
       This replaces two shipped mistakes: a 1100px ribbon of five
       equal-weight sections (0.44) that made the answer arrive fifth,
       and a fourth TAB (Trajectory) for a second reading of the same
       thread, which cost the reader their thread and their step to ask a
       different question about them.
       OWN-WORLD: the trace viewer's own material (docs/design/ui.md) —
       GitHub-dark tokens, system mono, 11/12/13 + 9/10 micro, one accent,
       the six fixed data hues. Its device is the RULE: hairline section
       rules and a ruled margin, never a card.
       STORY: how full is the window -> what is filling it -> what the
       agent did -> when did it change -> which of my sessions is worst.
       Category colors are DATA colors (fixed hex from CTX_CATS in
       src/context.ts, same rule as the request-category chips); accent
       stays interactive-only. */
    #context-view { display: none; flex: 1; min-height: 0; flex-direction: column; }
    body.view-context #context-view { display: flex; }
    body.view-context #split { display: none; }
    body.view-context .cats { display: none; }
    body.view-context #tb-list, body.view-context #tb-page { display: none; }

    /* ---- the record stream (the "stream" deck) ----
       The thread as one linear stream of records — system, the human,
       the CONTEXT the harness injected inline, the model’s thinking,
       each tool call fused with its result, the reply. It used to be its
       own tab; it is a READING of the same selection, so it is a deck. */
    .tj-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .tj-lvls, .tj-kinds { display: inline-flex; gap: 2px; }
    .tj-lvl, .tj-kind { font: inherit; font-size: 11px; background: var(--bg-surface); color: var(--text-faint); border: 1px solid var(--border); padding: 2px 8px; border-radius: 5px; cursor: pointer; }
    .tj-lvl.active { color: var(--text); border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
    .tj-kind.active { color: var(--text); border-color: var(--tjc, var(--accent)); background: color-mix(in srgb, var(--tjc, var(--accent)) 14%, transparent); }
    .tj-search { font: inherit; font-size: 11px; background: var(--bg-surface); color: var(--text); border: 1px solid var(--border); padding: 3px 8px; border-radius: 5px; width: 170px; }
    .tj-hidden { font-size: 10px; color: var(--text-faint); }
    /* the list is the deck's main column; its rows bleed to the canvas
       edge (the turn dividers are sticky inside the deck's own scroll) */
    .tj-list { margin: 0 -16px; padding: 4px 0 24px; }
    .tj-turn { font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-faint); padding: 8px 16px 3px; position: sticky; top: 0; background: var(--bg); z-index: 1; }
    .tj-row { display: flex; align-items: center; gap: 8px; padding: 3px 16px; text-decoration: none; color: var(--text); border-left: 2px solid transparent; font-size: 12px; }
    .tj-row:hover { background: var(--hover); }
    .tj-row.sel { background: color-mix(in srgb, var(--accent) 12%, transparent); border-left-color: var(--accent); }
    .tj-badge { flex: 0 0 auto; font-size: 9px; font-weight: 700; letter-spacing: 0.05em; color: var(--tjc, var(--text-faint)); width: 52px; text-align: right; }
    .tj-row.tj-think .tj-badge, .tj-row.tj-think .tj-label { color: var(--text-faint); }
    .tj-label { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tj-label.tj-mono { color: var(--tjc); flex: 0 0 auto; max-width: 32ch; }
    .tj-arrow { flex: 0 0 auto; color: var(--text-faint); }
    .tj-result { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-faint); }
    .tj-row.tj-err .tj-result, .tj-row.tj-err .tj-label { color: var(--red); }
    .tj-gap { flex: 1 1 auto; min-width: 8px; }
    .tj-tok { flex: 0 0 auto; color: var(--text-faint); font-size: 11px; }
    /* the shell: a fixed head, the OVERVIEW that never scrolls away, then
       a ruled margin that reconciles beside a deck that scrolls. The
       same two-pane grammar the requests (list|detail) and sessions
       (rail|convo) views already use, with one addition: the overview is
       the page's time axis and every deck below reads its selection, so
       it belongs to the frame, not to the scroll. */
    .cx-cols { flex: 1; min-height: 0; display: flex; align-items: stretch; }
    .cx-margin {
      flex: 0 0 300px; min-width: 0; overflow-y: auto;
      padding: 12px 16px 24px; border-right: 1px solid var(--border);
    }
    .cx-canvas { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; padding: 0 16px; }
    /* the deck row: the deck's main column beside the INSPECTOR. Each
       scrolls itself — the canvas never adds a scrollbar around them, so
       the deck bar and the hint stay put while either column runs long. */
    .cx-deck { flex: 1 1 auto; min-height: 0; display: flex; align-items: stretch; padding-top: 10px; }
    .cx-deck-main { flex: 1; min-width: 0; overflow-y: auto; padding-bottom: 24px; }
    /* ---- the inspector: ONE right panel for every deck ----
       Opens on a pick (an icicle node, a stream record, an event row),
       closes on × / Esc, and the deck takes the whole width until the
       next pick. Inside: a head that names the picked thing, then a
       VERTICAL rail of facets — the questions the wire can answer about
       it (content · schema · origin · wire) — beside the facet's body.
       The rail is vertical because it is a table of contents, not a
       toolbar: it grows down, never wraps, and the labels line up. */
    .cx-insp { flex: 0 0 40%; max-width: 560px; min-width: 300px; display: flex; flex-direction: column; min-height: 0; margin-left: 12px; border-left: 1px solid var(--border); }
    .cx-insp[hidden] { display: none; }
    .cx-insp-h {
      flex: none; display: flex; align-items: center; gap: 8px; min-width: 0;
      padding: 2px 8px 7px 12px; border-bottom: 1px solid var(--border);
      font-size: 11px; color: var(--text-muted); font-variant-numeric: tabular-nums;
    }
    .cx-insp-t { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
    .cx-insp-addr, .cx-insp-n { flex: none; color: var(--text-faint); font-size: 10px; white-space: nowrap; }
    .cx-insp-tok { flex: none; margin-left: auto; color: var(--text-faint); white-space: nowrap; }
    .cx-insp-x {
      flex: none; font: inherit; font-size: 12px; line-height: 1; cursor: pointer;
      background: none; border: 0; border-radius: 4px; color: var(--text-faint); padding: 2px 5px;
    }
    .cx-insp-x:hover { color: var(--text); background: var(--hover); }
    .cx-insp-cols { flex: 1; min-height: 0; display: flex; }
    .cx-insp-rail { flex: 0 0 66px; display: flex; flex-direction: column; gap: 1px; padding-top: 8px; border-right: 1px solid var(--border); }
    .cx-facet {
      font: inherit; font-size: 11px; text-align: left; cursor: pointer;
      background: none; border: 0; border-left: 2px solid transparent;
      color: var(--text-faint); padding: 4px 6px 4px 10px;
    }
    .cx-facet:hover { color: var(--text); background: var(--hover); }
    .cx-facet.active { color: var(--text); border-left-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
    .cx-insp-body { flex: 1; min-width: 0; overflow-y: auto; padding: 8px 12px 24px; font-size: 11px; }
    /* a facet's key/value lines (the wire facet, the origin facet) */
    .cx-kv { display: flex; gap: 10px; padding: 2px 0; font-size: 11px; font-variant-numeric: tabular-nums; line-height: 1.5; }
    .cx-kv-k { flex: 0 0 80px; color: var(--text-faint); }
    .cx-kv-v { flex: 1; min-width: 0; color: var(--text-muted); overflow-wrap: anywhere; }
    .cx-kv-v b { color: var(--text); font-weight: 500; }
    .cx-kv-v .turn-wire { margin-right: 10px; }
    .cx-insp-note { font-size: 11px; color: var(--text-faint); padding: 4px 0 8px; line-height: 1.5; }
    .cx-insp-desc { font-size: 11px; color: var(--text-muted); white-space: pre-wrap; overflow-wrap: anywhere; padding: 4px 0 10px; line-height: 1.5; }
    /* a compaction's before → after, one line per category */
    .cx-cmp { display: flex; align-items: center; gap: 8px; padding: 2px 0; font-size: 11px; font-variant-numeric: tabular-nums; color: var(--text-muted); }
    .cx-cmp-l { flex: 0 0 110px; display: inline-flex; align-items: center; gap: 6px; }
    .cx-cmp-n { flex: 0 0 52px; text-align: right; }
    .cx-cmp-d { flex: 0 0 62px; text-align: right; }
    .cx-head {
      flex: none; display: flex; align-items: center; gap: 8px; font-size: 12px;
      padding: 10px 16px 8px; border-bottom: 1px solid var(--border);
    }
    /* ---- the deck switcher: three readings of ONE selection ----
       Not tabs. The page has one subject (this thread's context) and one
       selection (the pinned step + the brushed range); these are the
       three questions you can ask it — what is in the window, what the
       agent did, what changed it. */
    .cx-modes {
      flex: none; display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
      padding: 8px 0 7px; border-bottom: 1px solid var(--border);
      position: sticky; top: 0; z-index: 4; background: var(--bg);
    }
    .cx-mode {
      font: inherit; font-size: 11px; background: none; cursor: pointer;
      border: 1px solid transparent; border-radius: 5px; color: var(--text-faint); padding: 3px 10px;
    }
    .cx-mode:hover { color: var(--text); background: var(--hover); }
    .cx-mode.active { color: var(--text); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); background: color-mix(in srgb, var(--accent) 10%, transparent); }
    .cx-mode-n { color: var(--text-faint); font-size: 10px; margin-left: 4px; font-variant-numeric: tabular-nums; }
    .cx-mode-r { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .cx-deck-hint { flex: none; font-size: 10px; color: var(--text-faint); padding: 7px 0 3px; }
    .cx-deck-hint b { color: var(--text-muted); font-weight: 400; }
    .cx-head .thread-label { color: var(--text); }
    .cx-goto { margin-left: auto; color: var(--accent); font-size: 11px; text-decoration: none; flex: none; }
    .cx-goto:hover { text-decoration: underline; }
    /* ---- the margin's balance: the largest signal on the sheet ---- */
    .cx-bal { padding-bottom: 12px; font-variant-numeric: tabular-nums; }
    .cx-bal-n { font-size: 24px; line-height: 1.1; color: var(--text); display: block; }
    .cx-bal-n .cx-bal-u { font-size: 12px; color: var(--text-muted); margin-left: 3px; }
    .cx-bal-d { display: block; font-size: 10px; color: var(--text-muted); padding: 3px 0 8px; }
    /* the composition bar: six colored segments + the grey headroom track */
    .cx-bar {
      display: flex; height: 10px; border-radius: 4px; overflow: hidden;
      background: var(--bg-surface); border: 1px solid var(--border);
    }
    .cx-seg { height: 100%; min-width: 0; }
    .cx-bal-foot { display: flex; align-items: baseline; gap: 8px; padding-top: 5px; font-size: 10px; color: var(--text-faint); }
    .cx-bal-pct { color: var(--text); font-size: 11px; }
    .cx-bal-win { margin-left: auto; }
    /* the reconciliation line: what the estimate is worth against the
       number the provider actually billed. The sheet's own check. */
    .cx-recon { font-size: 10px; color: var(--text-faint); padding-top: 6px; line-height: 1.5; }
    .cx-recon b { color: var(--text-muted); font-weight: 400; }
    .cx-dot { width: 8px; height: 8px; border-radius: 2px; flex: none; background: var(--cx, var(--text-faint)); }
    .cx-topt { padding-top: 8px; font-size: 10px; color: var(--text-faint); line-height: 1.6; }
    .cx-topt b { color: var(--text-muted); font-weight: 500; }
    /* where the thread's wall-clock went: the time track's totals, and the
       legend that names its three hues */
    .cx-lanes { display: flex; height: 8px; border-radius: 3px; overflow: hidden; margin: 2px 0 6px; background: var(--bg-surface); }
    .cx-lane { min-width: 2px; }
    .cx-lane-key { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 10px; color: var(--text-faint); }
    .cx-lane-key i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
    /* where the money went: the same lane grammar, plus the per-model
       lines and the bumps line (a control — it opens the events deck
       filtered to cost). Every figure is an estimate and wears the ≈. */
    .cx-mrow {
      display: flex; align-items: baseline; gap: 8px; font-size: 10px;
      color: var(--text-faint); font-variant-numeric: tabular-nums; padding-top: 4px;
    }
    .cx-mrow-n { margin-left: auto; color: var(--text-muted); }
    button.cx-mrow { font: inherit; font-size: 10px; background: none; border: 0; width: 100%; text-align: left; cursor: pointer; }
    button.cx-mrow:hover { color: var(--accent); }
    button.cx-mrow:hover .cx-mrow-n { color: var(--accent); }
    /* quota, as the client polled it: one row per limit window */
    .cx-qrow { display: flex; align-items: center; gap: 7px; font-size: 11px; font-variant-numeric: tabular-nums; padding: 2px 0; }
    .cx-qlabel { flex: 0 0 60px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cx-qn { flex: 0 0 34px; text-align: right; color: var(--text); }
    .cx-qr { flex: 1; text-align: right; color: var(--text-faint); font-size: 10px; }
    .cx-qfoot { font-size: 10px; color: var(--text-faint); padding-top: 6px; line-height: 1.5; }
    /* the margin's own section labels — quieter than the canvas's h4s,
       because the margin is one continuous sheet, not stacked reports */
    .cx-mlabel {
      display: flex; align-items: baseline; gap: 8px;
      font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em;
      color: var(--text-faint); padding: 0 0 5px;
    }
    .cx-mlabel-r { margin-left: auto; text-transform: none; letter-spacing: 0; }
    /* #cx-bal is the repaint handle for the step-dependent blocks, not a
       box: display:contents keeps every .cx-mblock a direct sibling in the
       margin, so the rules below (and the narrow-tier grid) see them all. */
    #cx-bal { display: contents; }
    /* #cx-bal + .cx-mblock is NOT redundant: display:contents changes the
       box tree, never the DOM tree, so the threads block's adjacent DOM
       sibling is #cx-bal itself and the rule above cannot reach it. */
    .cx-mblock + .cx-mblock,
    #cx-bal + .cx-mblock { padding-top: 12px; margin-top: 12px; border-top: 1px solid var(--border); }
    /* ---- the OVERVIEW: the page's time axis, DevTools-shaped ----
       Three tracks on one x axis — the assembled context per step, where
       that step's wall-clock went, what it cost — under one brush. Drag to
       select a range, wheel to zoom, drag the handles to resize, drag
       the window to pan, click a column to pin it. Everything below
       reads that selection: the PIN drives the balance and the window
       deck, the RANGE scopes the stream and the events.
       Columns are equal-width and GAPLESS on purpose: the brush overlay
       positions its edges at i/N of the track, which is only exact when
       every column occupies exactly 1/N of it (a 2px gap drifts the
       overlay by a column-width across 100 steps). The breathing room
       moved inside the column, where it costs the geometry nothing. */
    .cx-ov { --cx-ov-h: 116px; --cx-ov-th: 24px; --cx-ov-ch: 26px; flex: none; border-bottom: 1px solid var(--border); padding: 0 16px 7px; }
    .cx-ov-bar {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      padding: 7px 0 6px; font-size: 10px; color: var(--text-faint);
    }
    .cx-ov-sel { color: var(--accent); }
    .cx-ov-tools { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; }
    .cx-ov-z { font-variant-numeric: tabular-nums; min-width: 34px; text-align: center; }
    .cx-ov-body { display: flex; align-items: stretch; gap: 6px; }
    /* the gutter names each track and states its own top of scale — a
       track whose height means something unstated is a decoration */
    .cx-ov-gut { flex: 0 0 38px; display: flex; flex-direction: column; text-align: right; }
    .cx-ov-gl {
      display: flex; flex-direction: column; justify-content: flex-start; overflow: hidden;
      font-size: 9px; color: var(--text-faint); font-variant-numeric: tabular-nums; line-height: 1.35;
    }
    .cx-ov-gn { text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.7; }
    .cx-ov-scroll { flex: 1; min-width: 0; overflow-x: auto; overflow-y: hidden; }
    .cx-ov-tracks { position: relative; touch-action: none; user-select: none; }
    .cx-chart { display: flex; align-items: flex-end; height: var(--cx-ov-h); padding-top: 13px; }
    .cx-colw {
      display: flex; flex-direction: column; align-items: center;
      justify-content: flex-end; height: 100%; cursor: pointer;
      flex: 1 1 0; min-width: 0;
    }
    .cx-colw.out { opacity: 0.32; }
    /* The COLUMN always takes exactly 1/N of the track (the brush's
       geometry depends on it) — the BAR inside it is what gets capped, so
       a five-step thread reads as five slim bars across the axis instead
       of a 110px huddle in a 1000px field, and every column keeps a
       full-width hit target. */
    /* the time track: where THIS step's wall-clock went (model, then the
       gap to the next request — tools when the reply made calls, waiting
       when the harness came back on its own). Same x, same brush; the
       totals and the legend live in the margin. */
    .cx-time { display: flex; align-items: flex-end; height: var(--cx-ov-th); border-top: 1px solid var(--border); padding-top: 2px; }
    .cx-tw { display: flex; align-items: flex-end; justify-content: center; height: 100%; flex: 1 1 0; min-width: 0; cursor: pointer; }
    .cx-tw.out { opacity: 0.32; }
    .cx-tb { display: flex; flex-direction: column-reverse; width: calc(100% - 2px); min-width: 1px; max-width: 28px; border-radius: 1px 1px 0 0; overflow: hidden; }
    .cx-tb > span { width: 100%; }
    /* the cost track: what THIS step cost, stacked cache read / cache
       write / input / output. Same x, same brush. A step that re-bought
       its prefix wears a $ mark, positioned ABSOLUTELY so the mark never
       shortens the bar it sits over. */
    .cx-cost { display: flex; align-items: flex-end; height: var(--cx-ov-ch); border-top: 1px solid var(--border); padding-top: 2px; }
    .cx-cw {
      position: relative; display: flex; align-items: flex-end; justify-content: center;
      height: 100%; flex: 1 1 0; min-width: 0; cursor: pointer;
    }
    .cx-cw.out { opacity: 0.32; }
    .cx-cb { display: flex; flex-direction: column-reverse; width: calc(100% - 2px); min-width: 1px; max-width: 28px; border-radius: 1px 1px 0 0; overflow: hidden; }
    .cx-cb > span { width: 100%; }
    .cx-cmark {
      position: absolute; top: -1px; left: 0; right: 0; text-align: center;
      font-size: 9px; line-height: 1; color: var(--amber); pointer-events: none;
    }
    /* the brush: two dim panels and a window with grab handles */
    .cx-brush { position: absolute; inset: 0; pointer-events: none; z-index: 2; }
    .cx-brush-dim { position: absolute; top: 0; bottom: 0; background: color-mix(in srgb, var(--bg) 62%, transparent); }
    .cx-brush-win {
      position: absolute; top: 0; bottom: 0;
      border-left: 1px solid var(--accent); border-right: 1px solid var(--accent);
      background: color-mix(in srgb, var(--accent) 6%, transparent);
    }
    .cx-brush-h { position: absolute; top: 0; bottom: 0; width: 7px; cursor: ew-resize; pointer-events: auto; background: color-mix(in srgb, var(--accent) 28%, transparent); }
    .cx-brush-h.l { left: -4px; }
    .cx-brush-h.r { right: -4px; }
    /* the raised outlier: a cut is an axis break, drawn full height. AMBER,
       because that is what .rp-mark.cut already paints this exact wire fact
       on the replay track — one compaction, one color, both surfaces. (The
       tools segment is amber-adjacent, but it is ~6% at the foot of the
       bar and the break runs the whole height.) */
    .cx-colw.cut { position: relative; }
    .cx-colw.cut::before {
      content: ''; position: absolute; top: 12px; bottom: 0; left: 50%;
      border-left: 1px dashed color-mix(in srgb, var(--amber) 75%, transparent);
    }
    .cx-mark { font-size: 9px; line-height: 1.2; color: var(--amber); }
    .cx-col {
      display: flex; flex-direction: column-reverse; width: calc(100% - 2px); min-width: 1px; max-width: 28px;
      border-radius: 1px 1px 0 0; overflow: hidden;
    }
    .cx-colw:hover .cx-col, .cx-colw.pinned .cx-col { outline: 1px solid var(--accent); outline-offset: 1px; }
    .cx-colw.pinned .cx-col { outline-width: 2px; }
    .cx-col-failed { outline: 1px dashed var(--red) !important; }
    .cx-seg-v { width: 100%; }
    .cx-seg-stub { width: 100%; background: var(--border); }
    /* turn-granularity axis labels: the outline's ordinals under the bars */
    .cx-tlbl { font-size: 9px; color: var(--text-faint); padding-top: 2px; font-variant-numeric: tabular-nums; }
    /* ---- the ledger rows: the six categories of the picked step ----
       ONE rendering of these six numbers on the page (the icicle's row 1
       is the other, and it is a chart, not a list — it reorders and it
       disappears when you zoom; this is the invariant that does not).
       Every row is a control: it zooms the chart to its category. */
    .cx-dhead {
      display: flex; flex-wrap: wrap; gap: 3px 10px; font-size: 10px;
      color: var(--text-muted); font-variant-numeric: tabular-nums; padding-bottom: 8px;
    }
    .cx-dhead .cx-dt { color: var(--text); flex-basis: 100%; font-size: 11px; }
    .cx-crow {
      display: flex; align-items: center; gap: 7px; padding: 3px 4px; margin: 0 -4px;
      border-radius: 4px; font-size: 11px; font-variant-numeric: tabular-nums;
      color: inherit; text-decoration: none; cursor: pointer;
    }
    .cx-crow:hover { background: var(--hover); }
    .cx-crow.sel { background: color-mix(in srgb, var(--accent) 10%, transparent); }
    .cx-crow-label { flex: 1; min-width: 0; color: var(--text-muted); display: inline-flex; align-items: center; gap: 6px; }
    .cx-crow:hover .cx-crow-label, .cx-crow.sel .cx-crow-label { color: var(--text); }
    .cx-crow-label > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cx-track {
      flex: none; width: 54px; height: 5px; border-radius: 99px; overflow: hidden;
      background: var(--bg-surface); border: 1px solid var(--border);
    }
    .cx-fill { display: block; height: 100%; background: var(--cx, var(--text-faint)); }
    .cx-crow-n { flex: 0 0 52px; text-align: right; color: var(--text); }
    .cx-crow-pct { flex: 0 0 32px; text-align: right; color: var(--text-faint); }
    /* context events */
    .cx-fchip {
      font: inherit; font-size: 10px; line-height: 1; cursor: pointer; white-space: nowrap;
      background: none; border: 1px solid var(--border); border-radius: 999px;
      color: var(--text-muted); padding: 3px 9px;
    }
    .cx-fchip:hover { border-color: var(--accent); }
    .cx-fchip.active { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); background: color-mix(in srgb, var(--accent) 10%, transparent); }
    .cx-ev { display: flex; align-items: baseline; gap: 10px; padding: 2px 4px; margin: 0 -4px; border-radius: 4px; font-size: 11px; font-variant-numeric: tabular-nums; cursor: pointer; }
    .cx-ev:hover { background: var(--hover); }
    .cx-ev.sel { background: color-mix(in srgb, var(--accent) 12%, transparent); }
    .cx-ev-kind {
      flex: 0 0 58px; text-align: center; font-size: 9px; text-transform: uppercase;
      letter-spacing: 0.03em; color: var(--text-muted);
      border: 1px solid var(--border); border-radius: 4px; padding: 0 4px;
    }
    .cx-ev-glyph { flex: 0 0 12px; text-align: center; color: var(--text-faint); }
    .cx-ev-label { flex: 0 1 46ch; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
    .cx-ev-gap { flex: 1; min-width: 8px; }
    .cx-ev-at { flex: none; color: var(--text-faint); }
    .cx-ev-at a { color: var(--text-faint); text-decoration: none; }
    .cx-ev-at a:hover { color: var(--accent); }
    .cx-ev-n { flex: none; color: var(--text-faint); font-size: 10px; }
    .cx-delta { flex: 0 0 66px; text-align: right; }
    .cx-ev { max-width: 1100px; }
    .cx-delta.plus { color: var(--amber); }
    .cx-delta.minus { color: var(--green); }
    .cx-ev-time { flex: 0 0 60px; text-align: right; color: var(--text-faint); }
    .cx-more { padding: 4px 0; font-size: 11px; color: var(--text-faint); }
    /* ---- the context graph: an icicle ----
       Rows top-down, width = tokens, every child inside its parent's span.
       Row 1 is the composition bar's own six categories, same order, same
       hues — the graph IS that bar growing downward, which is why the
       nodes wear TINTS of the data color (they carry text; the bar does
       not) with the full-strength hue stated as a 2px left edge. */
    .cx-crumbs { display: flex; align-items: baseline; gap: 6px; padding: 2px 0 6px; font-size: 11px; }
    .cx-crumb { color: var(--accent); text-decoration: none; }
    .cx-crumb:hover { text-decoration: underline; }
    .cx-crumb.cur { color: var(--text); }
    .cx-crumb-sep { color: var(--text-faint); }
    .cx-crumb-hint { margin-left: auto; color: var(--text-faint); font-size: 10px; }
    .cx-flame { position: relative; }
    .cx-frow { position: relative; height: 17px; margin-bottom: 1px; }
    /* row 0 is the frame: this whole width is the focused node */
    .cx-frow:first-child .cx-fn { border: 1px solid var(--border); }
    .cx-fn {
      position: absolute; top: 0; bottom: 0; overflow: hidden;
      display: flex; align-items: center; gap: 5px; padding: 0 4px;
      font-size: 10px; line-height: 1; color: var(--text); cursor: pointer;
      white-space: nowrap; font-variant-numeric: tabular-nums;
    }
    .cx-fn:hover { outline: 1px solid var(--accent); outline-offset: -1px; }
    .cx-fn.sel { outline: 1px solid var(--accent); outline-offset: -1px; }
    .cx-fn.errn .cx-fn-l { color: var(--red); }
    /* the merged sliver node is a count, not a place you can go */
    .cx-fn.tailn { cursor: default; color: var(--text-faint); font-style: italic; }
    .cx-fn.tailn:hover { outline: none; }
    .cx-fn-l { overflow: hidden; text-overflow: ellipsis; }
    .cx-fn-n { flex: none; color: var(--text-muted); font-size: 9px; }
    .cx-fn-t { flex: none; margin-left: auto; color: var(--text-muted); font-size: 9px; }
    /* the picked node, opened — the inspector's content facet on the
       window deck (a leaf: its bytes; a group: its heaviest items as
       folds; a container: its children ranked) */
    .cx-pane-body { font-size: 11px; }
    .cx-prow {
      display: flex; align-items: center; gap: 8px; padding: 2px 4px; border-radius: 4px;
      font-size: 11px; color: var(--text-muted); text-decoration: none; font-variant-numeric: tabular-nums;
    }
    .cx-prow:hover { background: var(--hover); color: var(--text); }
    /* Same rule as the events row: a label capped at a readable measure,
       then the weight and the number, then the slack. A ranked list whose
       amounts sit 800px from their labels is not a column, it is a hunt. */
    .cx-prow-l { flex: 0 1 46ch; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* .fold-hint is flex:1 app-wide (right for the detail panel, where the
       row IS the label). Here the row also carries a number, so the label
       gets a measure and the slack goes after it — scoped, never a change
       to the shared rule. */
    .cx-item > summary .fold-hint { flex: 0 1 auto; }
    .cx-prow-gap { flex: 1; min-width: 8px; }
    .cx-since { margin-left: 8px; color: var(--text-faint); font-size: 10px; white-space: nowrap; cursor: pointer; }
    .cx-since:hover, .cx-since:focus-visible { color: var(--accent); }
    .cx-item > summary { padding: 4px 12px; }
    .cx-item > summary .fold-hint { color: var(--text-muted); }
    .cx-item-n { flex: none; color: var(--text-faint); font-size: 10px; font-variant-numeric: tabular-nums; min-width: 84px; text-align: right; }
    .cx-item-err .fold-title { color: var(--red); }
    /* the weight track, reused by the pane's ranked rows */
    .cx-wt {
      flex: none; width: 120px; height: 5px; border-radius: 99px;
      background: var(--bg-surface); border: 1px solid var(--border); overflow: hidden;
    }
    .cx-wf { display: block; height: 100%; min-width: 1px; }
    .cx-note { padding: 4px 0 8px; font-size: 11px; color: var(--text-faint); }
    /* the other sheets: peak assembled context per thread, all bars on
       one scale. It lives in the margin because switching sheets must
       not need a scroll — but it is the margin's quietest block. */
    .cx-thlist { max-height: 168px; overflow-y: auto; }
    .cx-sess { display: flex; align-items: baseline; gap: 8px; padding: 5px 0 1px; font-size: 9px; color: var(--text-faint); }
    .cx-sess-t { margin-left: auto; }
    .cx-th {
      display: flex; align-items: center; gap: 6px; padding: 2px 4px; margin: 0 -4px; border-radius: 4px;
      font-size: 11px; color: var(--text-muted); text-decoration: none;
      font-variant-numeric: tabular-nums;
    }
    .cx-th:hover { background: var(--hover); }
    .cx-th.selected { background: color-mix(in srgb, var(--accent) 10%, transparent); }
    .cx-th.selected .cx-th-label { color: var(--text); }
    .cx-th-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cx-th-bar {
      flex: none; width: 44px; height: 4px; border-radius: 99px; overflow: hidden;
      background: var(--bg-surface); border: 1px solid var(--border);
    }
    .cx-th-fill { display: block; height: 100%; min-width: 1px; background: var(--text-faint); }
    .cx-th.selected .cx-th-fill { background: var(--accent); }
    .cx-th-n { flex: 0 0 42px; text-align: right; color: var(--text); }
    .cx-th-pct { flex: 0 0 28px; text-align: right; color: var(--text-faint); }
    .cx-th-cut { flex: 0 0 22px; text-align: right; color: var(--purple); font-size: 9px; }
    /* Narrow tier: the margin unsticks and becomes the sheet's top block,
       and the two-column decks stack. 960px is the page's established
       breakpoint (threads rail, detail). */
    @media (max-width: 960px) {
      .cx-cols { display: block; overflow-y: auto; }
      .cx-margin {
        flex: none; overflow: visible;
        padding: 12px 16px 14px; margin-bottom: 14px;
        border-right: none; border-bottom: 1px solid var(--border);
        /* a band of columns, not one stretched sheet: a ledger row spread
           across 1400px puts 800px of nothing between label and amount.
           Multicol, not grid — grid rows take the tallest block's height
           and leave dead cells; columns just pack. */
        columns: 300px; column-gap: 28px;
      }
      .cx-canvas { overflow: visible; }
      #cx-bal { display: block; }
      .cx-mblock { break-inside: avoid; padding-bottom: 14px; }
      .cx-mblock + .cx-mblock,
      #cx-bal + .cx-mblock { padding-top: 0; margin-top: 0; border-top: none; }
      /* the deck row stacks: the deck, then the inspector under it */
      .cx-deck { flex-direction: column; }
      .cx-deck-main { overflow: visible; }
      .tj-list { max-height: 58vh; overflow-y: auto; }
      .cx-insp { flex: none; max-width: none; min-width: 0; margin-left: 0; border-left: none; border-top: 1px solid var(--border); max-height: 45vh; }
    }
    /* the rail's trajectory gutter: per-step context occupancy, split into
       the cached prefix and what was billed fresh (session view) */
    .tctx {
      flex: none; width: 30px; height: 4px; border-radius: 99px; overflow: hidden;
      background: var(--bg-surface); border: 1px solid var(--border); display: flex;
    }
    .tctx-b { display: flex; height: 100%; min-width: 1px; }
    .tctx-b > span { flex: none; height: 100%; }
    .tctx-none { background: none; border-color: transparent; }
    .tctx-c { background: color-mix(in srgb, var(--green) 70%, transparent); }
    .tctx-f { background: color-mix(in srgb, var(--amber) 80%, transparent); }
    .tctx-x { background: color-mix(in srgb, var(--red) 70%, transparent); }
  </style>
</head>
<body>
  <header>
    <span class="brand">${HEADER_LOGO}<h1>cctrace</h1></span>
    <span class="ctx" id="ctx"></span>
    <span class="count" id="stats"></span>
    <span class="inst" id="inst"></span>
    <span class="status disconnected" id="status">offline</span>
    <span class="trunc" id="trunc"></span>
    <span class="ver" id="ver"></span>
    <span class="header-actions">
      <a class="icon-btn" id="dash-link" href="/dashboard" hidden title="dashboard&#10;Every live instance and recent run, all projects sharing this data dir.&#10;Any instance serves the same page.">${DASH_ICON}</a>
      <button class="icon-btn" id="mask-toggle" title="mask identity"></button>
      <button class="icon-btn" id="theme-toggle" title="theme"></button>
      <a class="icon-btn" href="https://github.com/thevibeworks/cctrace" target="_blank" rel="noopener" title="GitHub">${GITHUB_ICON}</a>
    </span>
  </header>
  <!-- Toolbar grammar: scope narrows left to right — view tabs, then the
       list group (query + list-scoped toggles), then page behavior, then
       the trace controls holding the right edge in both views. Groups are
       spans so the session view hides whole groups, not button ids. -->
  <div class="toolbar" id="toolbar">
    <span class="tabs">
      <button class="tab active" id="tab-requests">requests</button>
      <button class="tab" id="tab-session">sessions</button>
      <button class="tab" id="tab-context" title="context&#10;The agent&#8217;s context window over time. An interactive overview on top &#8212; one column per wire request, a second track for where its time went &#8212; then three readings of what you select: the WINDOW (what the model is carrying, decomposed), the STREAM (every record the run produced, injections inline), and the EVENTS (what grew or reclaimed it).&#10;---&#10;&gt; drag the overview to select a range, wheel to zoom, click a column to pin it">context</button>
    </span>
    <span class="tb-group" id="tb-list">
      <input type="text" id="filter" placeholder="filter by url, method, status…  ( / )">
      <button id="prior-toggle" class="active" title="previous runs&#10;Requests merged from earlier runs of this session — same wire session id, older trace files.&#10;---&#10;> click shows/hides them in the list">prev runs</button>
      <button id="select-toggle" title="select to purge&#10;Pick requests to delete from the trace file — a privacy tool, removal is permanent.&#10;---&#10;> rows grow a check gutter · Esc leaves selection">select</button>
      <span id="sel-actions">
        <span id="sel-count"></span>
        <button id="sel-shown" title="select all shown&#10;Selects every request currently listed.&#10;---&#10;> filter first — pick a category chip, then select all shown">all shown</button>
        <button id="sel-none" title="clear the selection">none</button>
        <button id="sel-purge" title="purge selected&#10;Removes the selected requests from the page AND rewrites the backing .jsonl trace file(s).&#10;---&#10;> no undo — a confirm dialog spells out what gets deleted">purge</button>
      </span>
    </span>
    <span class="tb-group" id="tb-find">
      <input type="text" id="sfind" placeholder="find in session…  ( / )" title="find in session&#10;Case-insensitive search over the conversation, folded tool bodies included.&#10;---&#10;> Enter next hit · shift+Enter previous&#10;> hits inside closed folds open on jump · Esc clears">
      <span id="sfind-count"></span>
    </span>
    <span class="tb-group" id="tb-page">
      <button id="autoscroll" class="active" title="tail&#10;Stick to the newest request as pairs arrive.&#10;---&#10;> click toggles">tail</button>
      <button id="clear" title="clear the page&#10;Empties the request list on this page only — the trace file is untouched.">clear</button>
    </span>
    <span class="tb-group" id="tb-trace">
      <button id="replay-toggle" title="replay&#10;Step back through the session as it happened: the trajectory strip — lanes over wall-clock — above, the loop row — where in the agent's loop the cursor sits — under it, the beat at the top of the outline.&#10;---&#10;> ←/→ step turns · shift+←/→ step requests · [ / ] jump chapters&#10;> Space plays · drag scrubs · shift+drag selects a slice&#10;> wheel zooms the strip · click a span jumps there&#10;> F presentation · Esc peels present, then replay">⏵ replay</button>
      <span id="act-wrap"><button id="actions-toggle" title="trace actions&#10;Downloads (snapshot .html, wire spec .json/.md, per-session dumps .jsonl/.md) and housekeeping (purge categories, compact) for this trace.&#10;---&#10;> merge &amp; compress sweep the whole log dir — terminal only">⌘ actions</button><div class="act-menu" id="act-menu"></div></span>
    </span>
  </div>
  <div class="cats" id="cats"></div>
  <div id="split">
    <main id="pairs"><div class="boot-wait"><span class="bw-star">✻</span> <span id="boot-verb">Tracing</span>…</div></main>
    <aside id="detail"></aside>
    <div class="nav-rail" id="rail-detail"></div>
  </div>
  <div id="session-view">
    <div id="replay-bar">
      <div id="rp-lanes" data-depth="map" title="trajectory&#10;Lanes over wall-clock: the human's prompts, the model's requests, the tool gaps, the subagents, and the harness marks (✂ compaction, ✗ failed). The selected thread draws full, the others ghost; the faint marker tracks where the conversation is scrolled. While replaying, everything right of the playhead is dimmed — it has not happened yet.&#10;---&#10;> click jumps the conversation there · ⏵ replays · wheel zooms&#10;> replaying: drag scrubs · shift+drag selects a slice&#10;> the ▾ chevron folds the lanes to the clock row">
        <div id="rp-gut"></div>
        <div id="rp-scroll">
          <div id="rp-lanes-track">
            <div id="rp-axis"></div>
            <div id="rp-rules"></div>
            <div id="rp-lanes-body"></div>
            <div id="rp-breaks"></div>
            <div id="rp-veil"></div>
            <div id="rp-slice"></div>
            <div id="rp-handle"></div>
            <div id="rp-read"></div>
          </div>
        </div>
      </div>
      <div class="rp-transport">
        <button class="rp-btn" id="rp-restart" title="jump to start&#10;> key: Home">⏮</button>
        <button class="rp-btn" id="rp-play" title="play / pause&#10;Idle gaps compress to ≤2s.&#10;> key: Space · speeds 1/2/8/60x">▶</button>
        <button class="rp-btn" id="rp-end" title="jump to the end of the tape&#10;On a live run that is the live edge — replay tails from there.&#10;> key: End">⏭</button>
        <span class="rp-speeds">
          <button class="rp-speed active" data-speed="1">1x</button>
          <button class="rp-speed" data-speed="2">2x</button>
          <button class="rp-speed" data-speed="8">8x</button>
          <button class="rp-speed" data-speed="60">60x</button>
        </span>
        <span id="rp-time">0:00 / 0:00</span>
        <span id="rp-slice-chip"></span>
        <span id="rp-live"></span>
        <button class="rp-btn" id="rp-exit"></button>
      </div>
    </div>
    <div id="session-main">
      <aside id="threads"></aside>
      <main id="convo"></main>
      <div class="nav-rail" id="rail-session"></div>
    </div>
    <button id="tail-pill" title="Jump to the newest turn">↓ new activity</button>
    <div id="pulse"></div>
  </div>
  <div id="context-view"></div>

  <script>${markedSrc}</script>
  <script>
    const pairs = [];
    // Snapshot pages embed their pairs in <head>; live pages stream over WS.
    const IS_SNAPSHOT = Array.isArray(window.__PAIRS__);
    // Run identity injected by the server / snapshot writer ({} when unknown,
    // e.g. a snapshot rebuilt by \`cctrace view\`). Declared before anything
    // derives from it — IS_VIEW below reads it at top level.
    const META = ${jsonForScript(meta)};
    // A served saved trace (cctrace view): the WebSocket is only the data
    // channel — the page must read as a finished document, never as a live
    // capture that happens to be "offline" (ui.md: never pretend).
    const IS_VIEW = !IS_SNAPSHOT && META.mode === 'view';
    // A --tail view: a saved trace being FOLLOWED — live behavior (auto-
    // tail, pulse), but the chip says what it is.
    const IS_TAIL = !IS_SNAPSHOT && META.mode === 'tail';
    const IS_READING = IS_SNAPSHOT || IS_VIEW;
    // Every pair enters through here: a structurally broken one (no request
    // object / url — a torn trace line or a capture bug) is dropped with a
    // console note. Renderers, buildSession, and the replay timeline all
    // assume request.url exists; one bad pair must not blank the page.
    let droppedPairs = 0;
    let lastModelPair = null; // newest completed model call — the pulse's subject
    let traceBytes = META.traceBytes || 0; // .jsonl size on disk (ws frames refresh it live)
    function ingestPair(p) {
      if (!p || !p.request || typeof p.request.url !== 'string') {
        droppedPairs++;
        console.warn('[cctrace] dropped broken pair', droppedPairs, p);
        return false;
      }
      p._cat = categorize(p.request.url, p.client, CLIENT_WIRE);
      pairs.push(p);
      if (p._cat === 'messages' && (!lastModelPair || pairEndMs(p) >= pairEndMs(lastModelPair))) lastModelPair = p;
      return true;
    }

    // Loading verbs (the ccx tradition): pure decoration while the wire
    // loads — wire-flavored next to cooking and nonsense, gerunds only.
    const VERBS = ['Tracing', 'Intercepting', 'Decrypting', 'Teeing',
      'Attributing', 'Reassembling', 'Unspooling', 'Redacting', 'Replaying',
      'Tokenizing', 'Pondering', 'Mulling', 'Triangulating', 'Percolating',
      'Sauteing', 'Kneading', 'Proofing', 'Zesting',
      'Reticulating', 'Discombobulating', 'Moseying'];
    (function rotateBootVerb() {
      const t = setInterval(() => {
        const el = document.getElementById('boot-verb');
        if (!el) { clearInterval(t); return; } // first render replaced the placeholder
        el.textContent = VERBS[Math.floor(Math.random() * VERBS.length)];
      }, 1400);
    })();
    let autoScroll = true;
    let filter = '';
    let activeCat = 'all';
    let showPrior = true;      // include prior-run pairs in the Requests list
    let selMode = false;       // select-to-purge mode (Requests view)
    const selIds = new Set();  // selected pair ids
    let view = 'requests';      // 'requests' | 'session' | 'context'
    let detailId = null;        // request id open in the detail panel
    let sessionSelKey = null;   // selected thread in the session + context views
    let ctxGran = localStorage.getItem('cctrace-ctx-gran') === 'turn' ? 'turn' : 'step';
    let ctxPinned = null;       // pinned step's pairId (the overview's click)
    let ctxEvFilter = 'all';    // context events filter
    let ctxSort = localStorage.getItem('cctrace-ctx-sort') === 'order' ? 'order' : 'size';
    // The three readings of one selection. The deck is a preference, so it
    // survives reloads and thread switches; the RANGE and the ZOOM belong
    // to the thread you are looking at and reset when it changes.
    const CTX_MODES = ['window', 'stream', 'events'];
    let ctxMode = localStorage.getItem('cctrace-ctx-mode') || 'window';
    if (CTX_MODES.indexOf(ctxMode) === -1) ctxMode = 'window';
    function setCtxMode(m) {
      if (CTX_MODES.indexOf(m) === -1) return;
      ctxMode = m;
      localStorage.setItem('cctrace-ctx-mode', m);
    }
    // The brush: an inclusive [i0, i1] over the thread's flat step list
    // (never over the turn columns), so the granularity toggle re-draws
    // the same selection instead of silently meaning something else.
    let ctxRange = null;
    let ctxZoom = 1;            // 1 = fit; >1 = the overview is N screens wide
    let ctxFocusKey = '';       // context graph zoom (a node key; falls back to root)
    let ctxSelKey = '';         // context graph selection (the window deck's pick)
    // The inspector — one right panel for every deck. Open while there is
    // a pick and the reader has not closed it; × / Esc closes, the next
    // pick reopens. The facet is a preference: it holds across picks and
    // falls back to content when the picked thing lacks it.
    let ctxInspOpen = true;
    let ctxFacet = 'content';
    let ctxEvSel = null;        // the events deck's pick: { key, pairId } of a rolled run
    let ctxAddr = null;         // the current thread's pairId -> {ord, step} map
    let ctxLastFl = null;       // the icicle layout drawn last (the pick resolves against it)
    let ctxEvRolled = [];       // the events deck's rolled rows as drawn last
    let ctxInspLastKey = '';    // what the inspector showed last (a changed pick drops its scroll)
    const liveSids = new Set(); // session ids seen so far (live-follow guard)
    // Requests FORWARDED with no response yet, keyed by the id the eventual
    // pair carries (the server's start events). Live state only: a
    // snapshot has none, and the id is dropped the moment its pair lands.
    const openStarts = new Map();
    let sessionCache = { key: '', threads: [] };

    // pairId -> pair. The session/context layers resolve pair ids inside
    // per-turn loops; pairs.find() there is O(turns x pairs), which on a
    // long trace is the difference between a rail that renders and one that
    // stalls. Rebuilt only when the capture grows (pairs is append-only).
    let pairIdx = { n: -1, map: null };
    function pairOf(id) {
      if (!id) return null;
      if (pairIdx.n !== pairs.length) {
        const m = {};
        for (const p of pairs) m[p.id] = p;
        pairIdx = { n: pairs.length, map: m };
      }
      return pairIdx.map[id] || null;
    }

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

    // OpenAI dialect (codex/grok Responses + kimi Chat Completions), injected from src/dialects/openai.ts.
    ${wireDialect.toString()}
    ${openaiInput.toString()}
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
    ${extractEffort.toString()}
    ${summarizePair.toString()}

    // Pricing + cost estimation, injected from src/pricing.ts.
    ${modelPricing.toString()}
    ${pairRates.toString()}
    ${modelWindow.toString()}
    ${pairCost.toString()}
    ${fmtCost.toString()}
    ${costTitle.toString()}

    // The cost layer (docs/design/cost.md), injected from src/cost.ts:
    // where the money went, and which steps re-bought their prefix.
    ${stepCost.toString()}
    ${threadCostSplit.toString()}
    ${costEvents.toString()}
    ${usagePolls.toString()}

    // The context layer, injected from src/context.ts (unit tested there).
    const CTX_CATS = ${JSON.stringify(CTX_CATS)};
    const CTX_IMG_EST = ${JSON.stringify(CTX_IMG_EST)};
    ${estTokens.toString()}
    ${ctxTextCat.toString()}
    ${ctxBlockTokens.toString()}
    ${ctxEnvelope.toString()}
    ${ctxNormalizeTurns.toString()}
    ${ctxSnippet.toString()}
    ${contextComposition.toString()}
    ${contextItems.toString()}
    ${ctxGroupOf.toString()}
    ${contextGraph.toString()}
    ${ctxFlameTree.toString()}
    ${ctxFlameFind.toString()}
    ${ctxFlameLayout.toString()}
    ${ctxFlameDefault.toString()}
    ${contextTimeline.toString()}
    ${ctxInjectLabel.toString()}
    ${ctxAggregateTurns.toString()}
    ${ctxWindowTurns.toString()}
    ${ctxTurnSig.toString()}
    ${ctxOriginTurn.toString()}
    ${ctxCarrySpan.toString()}
    ${trajectoryRecords.toString()}
    ${trajectoryAtLevel.toString()}
    ${trajLabel.toString()}
    ${trajResultPreview.toString()}

    // Replay timeline primitives, injected from src/replay.ts.
    ${pairStartMs.toString()}
    ${pairEndMs.toString()}
    ${isTurnPair.toString()}
    ${replayEvents.toString()}
    ${replaySpan.toString()}
    ${visibleAt.toString()}
    ${nextBoundary.toString()}
    ${prevBoundary.toString()}
    ${sliceWindow.toString()}
    ${anchorAt.toString()}
    ${nextTick.toString()}

    // The stage layer (docs/design/replay-stage.md), injected from
    // src/replay.ts + src/session.ts: the trace as lanes over wall-clock,
    // the observed state at the cursor read into the now line and lit on
    // the loop row, the tally behind it, the beat, the strip's clock ruler.
    // Pure, unit-tested there.
    ${isSpawnTool.toString()}
    ${stepOutcome.toString()}
    ${sessionLanes.toString()}
    ${soFar.toString()}
    ${axisTicks.toString()}
    ${mergeBusy.toString()}
    ${timeScale.toString()}
    ${scaleX.toString()}
    ${scaleT.toString()}
    ${threadExtent.toString()}
    ${beatAt.toString()}
    ${chaptersOf.toString()}

    // Session reconstruction, injected from src/session.ts.
    ${firstUserText.toString()}
    ${threadSig.toString()}
    ${normalizeTurns.toString()}
    ${turnContentSig.toString()}
    ${buildToolResultIndex.toString()}
    ${responseBlocks.toString()}
    ${threadEpochs.toString()}
    ${turnSnippet.toString()}
    ${buildSession.toString()}
    ${mainThread.toString()}
    ${toolPreview.toString()}
    ${wsPath.toString()}
    ${wsRelText.toString()}
    ${cwdFromText.toString()}
    ${harnessPrompt.toString()}
    ${harnessTurnKind.toString()}
    ${continuationSummaryTurn.toString()}
    ${loopTurns.toString()}
    ${threadTimeSplit.toString()}
    ${escHtml.toString()}
    ${diffHunk.toString()}
    ${richToolBody.toString()}

    const statusEl = document.getElementById('status');
    const statsEl = document.getElementById('stats');
    const pairsEl = document.getElementById('pairs');
    const detailEl = document.getElementById('detail');
    const threadsEl = document.getElementById('threads');
    const convoEl = document.getElementById('convo');
    const tailPill = document.getElementById('tail-pill');
    const replayToggle = document.getElementById('replay-toggle');
    const rpPlay = document.getElementById('rp-play');
    const rpRestart = document.getElementById('rp-restart');
    const rpExit = document.getElementById('rp-exit');
    const rpLanes = document.getElementById('rp-lanes');
    const rpBar = document.getElementById('replay-bar');
    const rpGut = document.getElementById('rp-gut');
    const rpScroll = document.getElementById('rp-scroll');
    const rpTrack = document.getElementById('rp-lanes-track');
    const rpBody = document.getElementById('rp-lanes-body');
    const rpAxis = document.getElementById('rp-axis');
    const rpRules = document.getElementById('rp-rules');
    const rpBreaks = document.getElementById('rp-breaks');
    const rpVeil = document.getElementById('rp-veil');
    const rpHandle = document.getElementById('rp-handle');
    const rpRead = document.getElementById('rp-read');
    const rpTime = document.getElementById('rp-time');
    const rpEnd = document.getElementById('rp-end');
    const rpLive = document.getElementById('rp-live');
    const rpSlice = document.getElementById('rp-slice');
    const pulseEl = document.getElementById('pulse');
    const rpSliceChip = document.getElementById('rp-slice-chip');
    const filterEl = document.getElementById('filter');
    const autoScrollBtn = document.getElementById('autoscroll');
    const clearBtn = document.getElementById('clear');
    const priorToggle = document.getElementById('prior-toggle');
    const catsEl = document.getElementById('cats');
    const themeToggle = document.getElementById('theme-toggle');
    const tabRequests = document.getElementById('tab-requests');
    const tabSession = document.getElementById('tab-session');
    const tabContext = document.getElementById('tab-context');
    const contextEl = document.getElementById('context-view');

    // Dashboard link: only meaningful when a server answers /dashboard —
    // a snapshot opened from disk (file://) has no routes to link to.
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      document.getElementById('dash-link').hidden = false;
    }

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
      themeToggle.title = 'theme: ' + pref + '\\n> click cycles system \\u2192 light \\u2192 dark';
    }
    themeToggle.onclick = function() {
      var order = ['system', 'light', 'dark'];
      var cur = getThemePref();
      var next = order[(order.indexOf(cur) + 1) % 3];
      localStorage.setItem('cctrace-theme', next);
      applyTheme(next);
    };
    applyTheme(getThemePref());

    // ---- Mask toggle: blur identity for screen sharing ----
    // Display-layer courtesy only (capture-time redaction is a separate
    // thing, src/redact.ts): blur [data-mask] values (session id, project,
    // credits); hover any one to reveal it deliberately.
    const maskToggle = document.getElementById('mask-toggle');
    const MASK_ICONS = {
      off: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z"/><circle cx="8" cy="8" r="2"/></svg>',
      on: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2l12 12M6.3 6.3A2 2 0 008 10a2 2 0 001.7-1M4.2 4.4C2.3 5.6 1 8 1 8s2.5 4.5 7 4.5c1.2 0 2.2-.2 3.1-.6M7 3.5A7.5 7.5 0 018 3.5c4.5 0 7 4.5 7 4.5s-.6 1.1-1.8 2.3"/></svg>',
    };
    // What masks is a SET the user owns (right-click the eye): session id
    // is excluded by default — it's a local uuid, not a credential, and a
    // blurred header chip reads worse than it protects. The eye stays the
    // master switch.
    const MASK_KEYS = [
      { k: 'title', label: 'project & trace title' },
      { k: 'sid', label: 'session ids' },
      { k: 'usage', label: 'usage & credits' },
    ];
    function maskKeySet() {
      try {
        const v = JSON.parse(localStorage.getItem('cctrace-mask-keys') || 'null');
        if (Array.isArray(v)) return v;
      } catch {}
      return ['title', 'usage']; // default: sid stays readable
    }
    function applyMask(on) {
      const keys = maskKeySet();
      document.body.classList.toggle('masked', on);
      for (const mk of MASK_KEYS) document.body.classList.toggle('mask-' + mk.k, on && keys.indexOf(mk.k) !== -1);
      maskToggle.innerHTML = on ? MASK_ICONS.on : MASK_ICONS.off;
      maskToggle.title = on
        ? 'identity masked\\nHover any blurred value to reveal it deliberately.\\n---\\n> click to unmask \\u00b7 right-click to choose what blurs'
        : 'mask identity\\nBlur identity values for screen sharing \\u2014 project & trace title, usage & credits by default.\\n---\\n> click to mask \\u00b7 right-click to choose what blurs';
    }
    maskToggle.onclick = function() {
      var on = !document.body.classList.contains('masked');
      localStorage.setItem('cctrace-mask', on ? '1' : '0');
      applyMask(on);
    };
    // Right-click: the category picker.
    const maskMenu = document.createElement('div');
    maskMenu.className = 'mask-menu';
    if (document.body.appendChild) document.body.appendChild(maskMenu);
    maskToggle.addEventListener('contextmenu', function(e) {
      e.preventDefault();
      const keys = maskKeySet();
      maskMenu.innerHTML = '<div class="mm-head">blur when masked:</div>' + MASK_KEYS.map(mk =>
        '<label><input type="checkbox" data-mk="' + mk.k + '"' + (keys.indexOf(mk.k) !== -1 ? ' checked' : '') + '>' + mk.label + '</label>').join('');
      maskMenu.classList.add('open');
      maskMenu.querySelectorAll('input[data-mk]').forEach(inp => {
        inp.onchange = function() {
          const set = maskKeySet().filter(k => k !== inp.dataset.mk);
          if (inp.checked) set.push(inp.dataset.mk);
          localStorage.setItem('cctrace-mask-keys', JSON.stringify(set));
          applyMask(document.body.classList.contains('masked'));
        };
      });
    });
    document.addEventListener('click', function() { maskMenu.classList.remove('open'); });
    applyMask(localStorage.getItem('cctrace-mask') === '1');

    // ---- Actions: the CLI's surface, runnable from the page ----
    // Two sections, two contracts. Downloads stream from the server with
    // the CLI's redaction rules. Housekeeping RUNS here: category purge
    // rides the existing /api/purge (memory + file rewrite + broadcast),
    // compact is plan → confirm → apply against /api/compact (applyCompact
    // re-stats, so a live capture appending mid-flight is skipped, never
    // torn). merge/compress stay terminal-only — they sweep the whole log
    // dir, which is more than a page should reach for. Snapshots have no
    // server; the button hides there.
    const actionsToggle = document.getElementById('actions-toggle');
    const actMenu = document.getElementById('act-menu');
    if (IS_SNAPSHOT) {
      actionsToggle.style.display = 'none';
      // With actions gone and replay session-only, the trace group can sit
      // empty in the requests view — its hairline must not float alone.
      const tbTrace = document.getElementById('tb-trace');
      if (tbTrace) { tbTrace.style.borderLeft = 'none'; tbTrace.style.paddingLeft = '0'; }
    }
    else {
      const NOISE_CATS = ['telemetry', 'tokens', 'external'];
      function renderActMenu() {
        const counts = {};
        for (const c of NOISE_CATS) counts[c] = 0;
        for (const p of pairs) if (counts[p._cat] !== undefined) counts[p._cat]++;
        // Session dumps: one .jsonl (wire pairs, merge format) + one .md
        // (readable transcript) per session on the page, newest first.
        const dumpSids = [];
        const seenSid = {};
        for (let i = pairs.length - 1; i >= 0; i--) {
          const s = extractSessionId(pairs[i], CLIENT_WIRE);
          if (s && !seenSid[s]) { seenSid[s] = 1; dumpSids.push(s); }
        }
        actMenu.innerHTML =
          '<div class="am-head">download</div>' +
          '<a href="/api/snapshot.html">snapshot .html <span class="am-hint">whole page, offline</span></a>' +
          '<a href="/api/spec.json">wire spec .json <span class="am-hint">observed catalog</span></a>' +
          '<a href="/api/spec.md">wire spec .md</a>' +
          dumpSids.slice(0, 4).map(s =>
            '<a href="/api/session.jsonl?sid=' + encodeURIComponent(s) + '">session <span data-mask="sid">' + s.slice(0, 8) + '</span> .jsonl <span class="am-hint">wire pairs, merge format</span></a>' +
            '<a href="/api/session.md?sid=' + encodeURIComponent(s) + '">session <span data-mask="sid">' + s.slice(0, 8) + '</span> .md <span class="am-hint">readable transcript</span></a>').join('') +
          (dumpSids.length > 4 ? '<div class="am-head">+' + (dumpSids.length - 4) + ' more session' + (dumpSids.length - 4 === 1 ? '' : 's') + ' \\u2014 terminal: cctrace merge</div>' : '') +
          '<a href="/dashboard">\\u2302 instances dashboard <span class="am-hint">every live + recent run</span></a>' +
          '<div class="am-sep"></div>' +
          '<div class="am-head">housekeeping \\u2014 runs on this trace</div>' +
          NOISE_CATS.map(c => counts[c]
            ? '<button data-purgecat="' + c + '">purge ' + c + ' <span class="am-hint">' + counts[c] + ' pairs, rewrites the file</span></button>'
            : '<button disabled>purge ' + c + ' <span class="am-hint">none</span></button>').join('') +
          '<button data-compact="plan">compact bodies <span class="am-hint">plan first \\u2014 folds superseded request bodies</span></button>' +
          '<div class="am-sep"></div>' +
          '<div class="am-head">deeper (whole log dir): terminal \\u2014 cctrace merge \\u00b7 compress</div>';
        actMenu.querySelectorAll('button[data-purgecat]').forEach(btn => {
          btn.onclick = function(ev) {
            ev.stopPropagation();
            const cat = btn.dataset.purgecat;
            const ids = pairs.filter(p => p._cat === cat).map(p => p.id).filter(Boolean);
            if (!ids.length) return;
            if (!confirm('Purge ' + ids.length + ' ' + cat + ' request' + (ids.length === 1 ? '' : 's') + ' from the trace?\\n\\nThis deletes them from the page AND rewrites the .jsonl trace file(s). There is no undo.')) return;
            fetch('/api/purge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) })
              .then(r => r.json())
              .then(() => renderActMenu())
              .catch(() => { btn.querySelector('.am-hint').textContent = 'failed \\u2014 see server log'; });
          };
        });
        const cbtn = actMenu.querySelector('button[data-compact]');
        if (cbtn) cbtn.onclick = function(ev) {
          ev.stopPropagation();
          const hint = cbtn.querySelector('.am-hint');
          if (cbtn.dataset.compact === 'plan') {
            hint.textContent = 'planning\\u2026';
            fetch('/api/compact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
              .then(r => r.json())
              .then(plan => {
                if (!plan.stubbed && !plan.collapsed) { hint.textContent = 'nothing to fold'; return; }
                cbtn.dataset.compact = 'apply';
                hint.textContent = 'would fold ' + (plan.stubbed + plan.collapsed) + ' bodies in ' + plan.files + ' file(s), save ' + fmtBytes(plan.savedBytes) + ' \\u2014 click again to apply';
              })
              .catch(() => { hint.textContent = 'failed \\u2014 see server log'; });
          } else {
            hint.textContent = 'applying\\u2026';
            fetch('/api/compact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"apply":true}' })
              .then(r => r.json())
              .then(res => {
                cbtn.dataset.compact = 'plan';
                hint.textContent = 'done: ' + res.rewritten + ' file(s) rewritten, saved ' + fmtBytes(res.savedBytes) + (res.skipped ? ', ' + res.skipped + ' skipped (changed mid-flight)' : '');
              })
              .catch(() => { hint.textContent = 'failed \\u2014 see server log'; });
          }
        };
      }
      actionsToggle.onclick = function(e) {
        e.stopPropagation();
        if (!actMenu.classList.contains('open')) renderActMenu();
        actMenu.classList.toggle('open');
      };
      actMenu.onclick = function(e) { e.stopPropagation(); };
      document.addEventListener('click', function() { actMenu.classList.remove('open'); });
    }

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
    // Shared per-client glyphs (src/icons.ts) — the same marks the
    // dashboard rows use, so a client reads identically everywhere.
    const CLIENT_ICONS = ${jsonForScript(CLIENT_ICONS)};

    // ---- Header trace totals: what this whole trace adds up to ----
    // requests · in/out tokens · est cost, live-updating; the hover carries
    // the full breakdown (model calls, cache, thinking, failures, span).
    // Call info + cost are memoized per pair (extractCallInfo parses SSE —
    // too heavy to redo for every arriving pair times every pair).
    function renderStats() {
      let calls = 0, inTok = 0, outTok = 0, cr = 0, cw = 0, think = 0, cost = 0, errs = 0;
      let t0 = Infinity, t1 = 0;
      for (const p of pairs) {
        const ts = p.request.timestamp || 0;
        if (ts) { if (ts < t0) t0 = ts; if (ts > t1) t1 = ts; }
        if (!p.response || p.response.status >= 400) errs++;
        if (p._cat !== 'messages') continue;
        const m = p._ci || (p._ci = extractCallInfo(p));
        calls++;
        inTok += m.input || 0; outTok += m.output || 0;
        cr += m.cacheRead || 0; cw += m.cacheWrite || 0; think += m.thinking || 0;
        const sc = stepCost(p);
        cost += sc ? sc.total : 0;
      }
      // "in" is TOTAL input — uncached + cache read + cache written — the
      // same number the exit report and the dashboard call in; the tip
      // breaks it down. (Uncached alone read as "2.1k in, $5.62" nonsense.)
      const totalIn = inTok + cr + cw;
      let t = pairs.length + ' req';
      if (calls) {
        t += ' \\u00b7 in ' + fmtCompact(totalIn) + ' \\u00b7 out ' + fmtCompact(outTok);
        if (cost > 0) t += ' \\u00b7 ' + fmtCost(cost);
      }
      if (traceBytes > 0) t += ' \\u00b7 ' + fmtBytes(traceBytes);
      const tip = ['trace totals'];
      tip.push(pairs.length + ' requests \\u00b7 ' + calls + ' model calls' + (errs ? ' \\u00b7 ' + errs + ' failed' : ''));
      const diskBytes = META.traceDiskBytes || 0;
      if (traceBytes > 0) {
        tip.push('trace: ' + fmtBytes(traceBytes) + ' of .jsonl' +
          (diskBytes > 0 && diskBytes !== traceBytes ? ' \\u00b7 ' + fmtBytes(diskBytes) + ' on disk (archived)' : IS_SNAPSHOT || IS_VIEW ? ' at export/serve time' : ', growing live') +
          ' \\u2014 cctrace compact folds redundant bodies');
      }
      if (calls) {
        tip.push('input ' + totalIn.toLocaleString() + ' total \\u2014 ' + inTok.toLocaleString() + ' uncached' +
          (cr || cw ? ' \\u00b7 cache read ' + cr.toLocaleString() + ' \\u00b7 written ' + cw.toLocaleString() : '') +
          ' \\u00b7 output ' + outTok.toLocaleString() + (think ? ' \\u00b7 thinking ' + think.toLocaleString() : ''));
        if (cost > 0) tip.push('est. cost ' + fmtCost(cost) + ' \\u2014 sticker pricing over every model call');
      }
      if (t0 !== Infinity && t1 > t0) {
        tip.push('');
        tip.push(fmtDateTime(new Date(t0 * 1000)) + ' \\u2013 ' + fmtTime(new Date(t1 * 1000)));
      }
      statsEl.textContent = t;
      statsEl.dataset.tip = tip.join('\\n');
    }

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
      if (META.sessionTitle) t = META.sessionTitle + (t ? ' \\u00b7 ' + t : '');
      document.title = t ? 'CCTrace \\u00b7 ' + t : (IS_READING ? 'CCTrace' : 'CCTrace live');
      let html = '';
      if (client) {
        html += '<span class="ctx-client" title="traced CLI">' + (CLIENT_ICONS[client] || '') +
          '<span>' + escapeHtml(client) + '</span></span>';
      }
      if (META.project) {
        if (html) html += '<span class="ctx-sep">\\u00b7</span>';
        // The trace title: <project>/<trace-file> — names the artifact
        // behind this page, live log and view rebuild alike. Clicking it
        // copies the trace's project-relative path (.cctrace/…jsonl) —
        // the string you paste into "cctrace view" or hand to an agent.
        const label = META.project + (META.traceFile ? '/' + META.traceFile : '');
        const rel = META.traceRelPath || META.traceFile || '';
        const tip = (META.projectPath || META.project) + (META.traceFile ? ' \\u00b7 trace ' + META.traceFile : '') +
          (rel ? '\\n\\nclick to copy ' + rel : '');
        html += '<span class="ctx-proj' + (rel ? ' ctx-copy' : '') + '" data-mask="title" title="' + escapeHtml(tip) + '">' + escapeHtml(label) + '</span>';
      }
      if (sid) {
        if (html) html += '<span class="ctx-sep">\\u00b7</span>';
        html += '<button class="ctx-sess" data-mask="sid" title="session ' + escapeHtml(sid) + ' \\u2014 click to copy">' + escapeHtml(sid.slice(0, 8)) + '</button>';
      }
      if (META.sessionTitle) {
        // The session's generated name (cctrace title) — read-only identity,
        // after the artifact and the id it names.
        if (html) html += '<span class="ctx-sep">\\u00b7</span>';
        html += '<span class="ctx-title" title="' + escapeHtml(META.sessionTitle) + ' \\u2014 generated by cctrace title">' + escapeHtml(META.sessionTitle) + '</span>';
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
      const proj = ctxEl.querySelector('.ctx-copy');
      if (proj) proj.onclick = function() {
        navigator.clipboard.writeText(META.traceRelPath || META.traceFile || '').then(function() {
          // color flash only — swapping the text would shift the header
          proj.classList.add('copied');
          setTimeout(function() { proj.classList.remove('copied'); }, 1200);
        });
      };
    }

    // ---- Version badge: static META, so rendered once, beside the brand ----
    // Separate from the run-identity ctx (project · session): what cctrace
    // version produced the page has nothing to do with which run it shows.
    (function renderVer() {
      if (!META.version) return;
      // The version tip is a miniature release note: slogan first, then the
      // freshest features \\u2014 refresh the list when cutting a release so it
      // reads like the CHANGELOG's top, not a museum plaque.
      const about = 'cctrace v' + META.version + '\\n' +
        'X-ray vision for coding agents \\u2014 every request, token, and dollar on the wire.\\n' +
        'Traces Claude Code, Codex, Grok, Kimi, and opencode at the TLS layer, then rebuilds sessions, turns, costs, and cache behavior.\\n' +
        '---\\n' +
        'fresh off the wire:\\n' +
        '\\u00b7 the Context view has ONE inspector \\u2014 a right panel a pick opens (an icicle node, a stream record, an event row), a vertical rail of facets the wire can answer: content, a tool\\u2019s schema and weight, the ORIGIN (which step carried it in, how many requests re-sent it since), the wire request; \\u00d7 or Esc closes it\\n' +
        '\\u00b7 the trajectory bar is the session\\u2019s minimap, always on top \\u2014 one clickable block per TURN (its tally on hover, the one you are reading lit), the selected thread\\u2019s own time with idle folded to \\u29f8\\u29f8 breaks, synced with the conversation both ways; the loop-row diagram is gone\\n' +
        '\\u00b7 replay holds your thread \\u2014 enters and restarts on its own edges, the arrows step its own turns, waiting folds like idle, and a live run still tails\\n' +
        '\\u00b7 pricing follows the 2026-09 docs \\u2014 Fable 5.1 / Mythos 5.1 cache reads at 0.025x, Sonnet 5 at $2/$10, 1M windows on Claude 4.6+, and two modifiers read off the wire: fast mode (usage.speed) doubles every rate, US-only inference is 1.1x \\u2014 named in the cost tooltip\\n' +
        '\\u00b7 cctrace insights folds every run sharing the data dir into windowed aggregates (runs / tokens / \\u2248$ by day, project, client; --scan for the cache split and quota off the wire) \\u2014 the cctrace-insights skill reads it; /view/<run-id> budgets long sessions and says what it left out\\n' +
        '---\\n' +
        '> github.com/thevibeworks/cctrace';
      let html = '<span class="ver-badge" title="' + escapeHtml(about) + '">v' + escapeHtml(META.version) + '</span>';
      if (META.latestVersion) {
        html += '<a class="ver-upd" href="https://github.com/thevibeworks/cctrace/blob/main/CHANGELOG.md"' +
          ' target="_blank" rel="noopener"' +
          ' title="update available \\u2014 v' + escapeHtml(META.latestVersion) + '\\nnpm i -g @thevibeworks/cctrace@latest, or rerun cctrace and accept the prompt.\\n> click for the changelog">' +
          'v' + escapeHtml(META.latestVersion) + ' available</a>';
      }
      document.getElementById('ver').innerHTML = html;
    })();

    // The truncation chip: this page is the newest slice of a BUDGETED
    // read, and the header says so — a silent drop is data loss to the
    // reader. On a /view/<run-id> route the chip is the escape hatch
    // (?full=1); elsewhere it states the fact and names the CLI's --full.
    (function renderTrunc() {
      const t = META.truncated;
      const el = document.getElementById('trunc');
      if (!t || !el) return;
      const total = t.keptBytes + t.droppedBytes;
      const label = 'newest ' + fmtBytes(t.keptBytes) + ' of ' + fmtBytes(total);
      // location.pathname is absent on a file:// snapshot's stub-ish
      // environments; the chip must state the fact everywhere.
      const path = (typeof location !== 'undefined' && location.pathname) || '';
      const onViewRoute = path.indexOf('/view/') === 0;
      const tip = 'partial view\\n' +
        'This page holds the newest ' + fmtBytes(t.keptBytes) + ' of a ' + fmtBytes(total) + ' trace \\u2014 ' +
        t.droppedLines.toLocaleString() + ' older line' + (t.droppedLines === 1 ? '' : 's') + ' are not on it' +
        (t.olderFiles ? ' (+' + t.olderFiles + ' older trace file' + (t.olderFiles > 1 ? 's' : '') + ' unscanned)' : '') + '.\\n' +
        '---\\n' +
        (onViewRoute ? '> click loads everything \\u2014 a very large page may hang the tab\\n' : '') +
        '> the cctrace view command takes --full in the terminal';
      el.innerHTML = onViewRoute
        ? '<a href="' + escapeHtml(path) + '?full=1" data-tip="' + escapeHtml(tip) + '">' + label + '</a>'
        : '<span data-tip="' + escapeHtml(tip) + '">' + label + '</span>';
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
        rows += '<a class="inst-row" href="http://' + location.hostname + ':' + Number(i.port) + '/trace"' +
          ' title="' + escapeHtml((i.projectPath || i.project || '') + (i.sessionId ? ' \\u00b7 session ' + i.sessionId : '') +
            (i.pid ? ' \\u00b7 cctrace pid ' + i.pid : '') + (i.agentPid ? ' \\u00b7 agent pid ' + i.agentPid : '')) + '">' +
          '<span>' + escapeHtml((i.client ? i.client + ' \\u00b7 ' : '') + (i.project || '?')) + '</span>' +
          (i.sessionId ? '<span class="inst-sess">' + escapeHtml(String(i.sessionId).slice(0, 8)) + '</span>' : '') +
          '<span class="inst-port">:' + Number(i.port) + '</span></a>';
      }
      instEl.innerHTML =
        '<button class="inst-btn" title="other live cctrace runs on this machine\\n> click to list & switch">\\u21c4 ' + others.length + ' more</button>' +
        '<div class="inst-menu' + (open ? ' open' : '') + '">' + rows +
        '<a class="inst-row inst-dash" href="/dashboard" title="every live + recent run sharing this data dir \\u2014 served by any instance"><span>\\u2302 dashboard</span><span class="inst-port">all runs</span></a></div>';
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
      ws.onopen = () => {
        if (IS_VIEW) { statusEl.textContent = 'view'; statusEl.className = 'status snapshot'; }
        else if (IS_TAIL) { statusEl.textContent = 'tail'; statusEl.className = 'status connected'; }
        else { statusEl.textContent = 'live'; statusEl.className = 'status connected'; }
      };
      ws.onclose = () => {
        // A view page losing its server is not an outage — the document is
        // already here. Only a live capture reports "offline".
        if (IS_VIEW) { statusEl.textContent = 'view'; statusEl.className = 'status snapshot'; }
        else { statusEl.textContent = 'offline'; statusEl.className = 'status disconnected'; }
        setTimeout(connect, 1000);
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'init') {
          if (msg.traceBytes) traceBytes = msg.traceBytes;
          pairs.length = 0;
          for (const p of msg.pairs) ingestPair(p);
          // Requests in flight when this page connected: the server hands
          // them over so a page that arrives MID-request knows the model is
          // working, instead of waiting for a start event it already missed.
          openStarts.clear();
          for (const s of msg.starts || []) if (s && s.id) openStarts.set(s.id, s);
          for (const p of pairs) {
            openStarts.delete(p.id);
            const s = extractSessionId(p, CLIENT_WIRE);
            if (s) liveSids.add(s);
          }
          render();
          route();
          renderPulse();
        } else if (msg.type === 'start') {
          // A model call was forwarded and has no response yet. The strip
          // draws it as an open span to the newest known time; nothing
          // else on the page reads it, and no timer ticks it.
          if (msg.start && msg.start.id && !openStarts.has(msg.start.id)) {
            openStarts.set(msg.start.id, msg.start);
            rpLiveRefresh();
          }
        } else if (msg.type === 'start-end') {
          // The server gave up on an in-flight request (no pair after its
          // TTL) — the one retirement a page cannot see for itself.
          if (msg.id && openStarts.delete(msg.id)) rpLiveRefresh();
        } else if (msg.type === 'pair') {
          if (msg.traceBytes) traceBytes = msg.traceBytes;
          // TAIL, measured BEFORE the pair lands: was the cursor at the live
          // edge, and was the reader at the bottom of the conversation?
          // Terminal semantics — stick when you're there, never yank when
          // you're not (docs/design/ui.md 3).
          const preSpan = replay.active ? replaySpan(pairs) : null;
          const wasAtEdge = !!preSpan && replay.cursor >= preSpan.t1 - 0.5;
          const wasAtBottom = wasAtEdge && convoAtBottom();
          // The step the stage is showing, BEFORE the pair lands: the
          // live-arrived fade is only honest when the beat actually moves
          // (telemetry, count_tokens probes and usage polls land here too).
          const preBeat = wasAtEdge ? stageBeatId() : '';
          // The response retires its start even when the page rejects the
          // pair — the server retires silently on land, nothing else would.
          if (msg.pair && msg.pair.id) openStarts.delete(msg.pair.id);
          if (!ingestPair(msg.pair)) return;
          renderStats();
          renderCats();
          renderCtx();
          renderPulse();
          if (passesFilters(msg.pair)) {
            appendPair(msg.pair, true);
            if (autoScroll && !detailId) pairsEl.scrollTop = pairsEl.scrollHeight;
          }
          refreshDetailNav();
          // A NEW session id mid-run (e.g. /clear): follow it only while
          // tailing — reading history is never yanked (terminal semantics).
          const nsid = extractSessionId(msg.pair, CLIENT_WIRE);
          if (nsid && !liveSids.has(nsid)) {
            const firstSid = liveSids.size === 0;
            liveSids.add(nsid);
            if (!firstSid && view === 'session' && convoAtBottom()) sessionSelKey = null;
          }
          // While tailing, the tail branch below owns the session render:
          // it moves the cursor first, so rendering here would build the
          // whole view twice per landed pair, once at a cursor already gone.
          if (view === 'session' && !wasAtEdge) showSession(sessionSelKey);
          if (view === 'context') showContext(sessionSelKey);
          rpLiveRefresh(); // the strip grows at the right edge
          if (wasAtEdge) {
            // The cursor FOLLOWS: the loop row, the beat and the convo all
            // move to the new edge. The beat gets the page's live-arrived
            // fade once — a scrub never fades, and neither does a pair that
            // left the beat where it was.
            const postSpan = replaySpan(pairs);
            if (postSpan) {
              replay.cursor = postSpan.t1;
              stageFade = stageBeatId() !== preBeat;
              try { refreshReplay({ follow: false }); } finally { stageFade = false; }
              if (wasAtBottom) convoToBottom();
              updateReplayHash();
            }
          }
        } else if (msg.type === 'history') {
          // Prior-run pairs of a continued session: merge, resort, re-render.
          const known = new Set(pairs.map(p => p.id));
          for (const p of msg.pairs) {
            if (!known.has(p.id)) ingestPair(p);
            openStarts.delete(p.id);
            const s = extractSessionId(p, CLIENT_WIRE);
            if (s) liveSids.add(s);
          }
          pairs.sort((a, b) => (a.request.timestamp || 0) - (b.request.timestamp || 0));
          render();
          refreshDetailNav();
          // Merged history moves the tape's LEFT edge, not the cursor — but
          // the axis it hangs on is new, so the playhead, the veil and the
          // tape length have to be re-read on it or they point at the old one.
          if (replay.active) renderReplayBar();
          if (view === 'session') showSession(sessionSelKey);
          if (view === 'context') showContext(sessionSelKey);
        } else if (msg.type === 'purged') {
          // Pairs deleted via select-to-purge (this page or another one on
          // the same server): drop them everywhere and re-render.
          const gone = new Set(msg.ids || []);
          for (let i = pairs.length - 1; i >= 0; i--) if (gone.has(pairs[i].id)) pairs.splice(i, 1);
          for (const id of gone) selIds.delete(id);
          sessionCache = { key: '', threads: [] };
          // The replay caches key on pairs.length: a purge of k followed by
          // k arrivals would otherwise serve the purged picture again.
          fullCache = { key: '', threads: [] };
          laneCache = { key: '', lanes: null };
          rpStripKey = '';
          if (detailId && gone.has(detailId)) location.hash = '';
          render();
          updateSelBar();
          refreshDetailNav();
          if (view === 'session') showSession(sessionSelKey);
          if (view === 'context') showContext(sessionSelKey);
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
    // Spans of minutes and hours (where a session's time went): "820ms",
    // "4.2s", "31m 09s", "2h 13m" — compact, static, never a ticking surface.
    function fmtSpan(ms) {
      if (ms < 1000) return Math.round(ms) + 'ms';
      const s = ms / 1000;
      if (s < 60) return s.toFixed(1) + 's';
      const m = Math.floor(s / 60), sec = Math.round(s % 60);
      if (m < 60) return m + 'm ' + (sec < 10 ? '0' : '') + sec + 's';
      const h = Math.floor(m / 60), mm = m % 60;
      return h + 'h ' + (mm < 10 ? '0' : '') + mm + 'm';
    }
    // The same span at the resolution a SKIPPED stretch deserves: "1h 29m",
    // "12m". Seconds on an hour-long hole are noise, not precision.
    function fmtSpanCoarse(ms) {
      if (ms < 60000) return fmtSpan(ms);
      const m = Math.round(ms / 60000);
      if (m < 60) return m + 'm';
      const h = Math.floor(m / 60), mm = m % 60;
      return h + 'h' + (mm ? ' ' + (mm < 10 ? '0' : '') + mm + 'm' : '');
    }
    // Wall-clock is always 24h — locale 12h AM/PM wastes row width and
    // reads slower in a dense table.
    function fmtTime(d) { return d.toTimeString().slice(0, 8); }
    // Wall-clock per conversation turn, in wire seconds: an attributed reply
    // uses its own request's timestamp; a user/unattributed turn inherits the
    // NEXT attributed one — that request is the wire message that carried it
    // (trailing gaps fall back to the previous known). 0 = no wire time.
    function turnTimes(list) {
      const ts = list.map(x => {
        const p = x && x.pairId ? pairOf(x.pairId) : null;
        return p && p.request && p.request.timestamp ? p.request.timestamp : 0;
      });
      for (let i = ts.length - 2; i >= 0; i--) if (!ts[i]) ts[i] = ts[i + 1];
      for (let i = 1; i < ts.length; i++) if (!ts[i]) ts[i] = ts[i - 1];
      return ts;
    }
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

    window.copyReqId = function(ev, btn) {
      ev.preventDefault(); ev.stopPropagation();
      navigator.clipboard.writeText(btn.dataset.id || '').then(function() {
        var was = btn.textContent;
        btn.classList.add('copied');
        btn.textContent = 'copied';
        setTimeout(function() { btn.classList.remove('copied'); btn.textContent = was; }, 1200);
      });
    };

    // Session-header sid copy — same confirmation grammar as every other
    // click-to-copy on the page: the value flashes to a green "copied".
    window.copySessSid = function(ev, el) {
      ev.preventDefault(); ev.stopPropagation();
      if (!navigator.clipboard || !el.dataset.sid) return;
      navigator.clipboard.writeText(el.dataset.sid).then(function() {
        var was = el.textContent;
        el.classList.add('copied');
        el.textContent = 'copied';
        setTimeout(function() { el.classList.remove('copied'); el.textContent = was; }, 1200);
      });
    };

    // ---- Requests list ----

    function shortUrl(u) {
      try {
        const url = new URL(u);
        return (url.hostname === 'api.anthropic.com' ? '' : url.hostname) + url.pathname;
      } catch { return String(u); }
    }

    // The newest model call is the one whose cache deadline still means
    // anything (later hits refresh the TTL) — its ≡ chip may say "expired",
    // computed at render time, never a ticking countdown.
    function newestMessagesId() {
      for (let i = pairs.length - 1; i >= 0; i--) if (pairs[i]._cat === 'messages') return pairs[i].id;
      return null;
    }

    // Workspace root for path display: the page's own project metadata when
    // it has one, else the cwd the traced CLI stated on the wire (system/env
    // text, precise shapes only — see cwdFromText). Cached; rescans on new
    // pairs until found. null = unknown, previews keep full paths honestly.
    let _ws = null, _wsScan = -1;
    function wsRoot() {
      if (META.projectPath) return META.projectPath;
      if (_ws !== null || _wsScan === pairs.length) return _ws;
      _wsScan = pairs.length;
      let seen = 0;
      for (const p of pairs) {
        if (p._cat !== 'messages') continue;
        if (++seen > 3) break;
        const req = (p.request && p.request.body) || {};
        const texts = [];
        if (typeof req.system === 'string') texts.push(req.system);
        else if (Array.isArray(req.system)) for (const b of req.system) if (b && typeof b.text === 'string') texts.push(b.text);
        if (typeof req.instructions === 'string') texts.push(req.instructions);
        const items = openaiInput(req);
        for (let i = 0; i < items.length && i < 12; i++) {
          const it = items[i];
          if (!it || it.type !== 'message') continue;
          const c = it.content;
          if (typeof c === 'string') texts.push(c);
          else if (Array.isArray(c)) for (const part of c) if (part && typeof part.text === 'string') texts.push(part.text);
        }
        for (const t of texts) { const c = cwdFromText(t); if (c) { _ws = c; return _ws; } }
      }
      return _ws;
    }

    function chipsHtml(pair) {
      const chips = summarizePair(pair, pair._cat, { newest: pair.id === newestMessagesId(), now: Date.now() });
      // Usage/credits chips carry account identity — mask them for screen
      // sharing (hover reveals). data-mask is inert until body.masked is on.
      const mask = pair._cat === 'usage' ? ' data-mask="usage"' : '';
      return chips.map(c =>
        '<span class="' + (c.c || '') + '"' + (c.title ? ' title="' + escapeHtml(c.title) + '"' : '') + mask + '>' + escapeHtml(c.t) + '</span>'
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

    // First-token delay as its own right-aligned wire column (row order:
    // content chips · sizes · ttft · duration · time). Empty when the pair
    // never streamed a token event.
    function ttftCell(pair) {
      const lat = extractLatency(pair);
      if (!lat || !lat.isToken) return '<span class="ttft"></span>';
      return '<span class="ttft" title="' + escapeHtml('time to first streamed token' +
        (lat.pct != null ? ' \\u2014 ' + lat.pct + '% of ' + fmtMs(lat.totalMs) + ' wall-clock' : '')) + '">' +
        escapeHtml(fmtMs(lat.ttftMs)) + '</span>';
    }

    function appendPair(pair, live) {
      const div = document.createElement('div');
      try {
        const { request, response, duration } = pair;
        const status = response ? response.status : 'ERR';
        const cat = CAT_BY_ID[pair._cat] || CAT_BY_ID.other;
        div.className = 'pair' + (pair.id === detailId ? ' selected' : '') + (pair.prior ? ' prior' : '') +
          (selMode && selIds.has(pair.id) ? ' sel' : '');
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
            ttftCell(pair) +
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
      renderStats();
      priorToggle.classList.toggle('avail', pairs.some(p => p.prior));
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
      } else if ((m = h.match(/^#\\/session(?:\\/([^/@][^/]*))?(?:\\/([^/@][^/]*))?(?:\\/@(.+))?$/))) {
        // #/session[/<sid8-or-thread-key>[/<thread-key>]][/@<pair>] — the
        // first segment resolves as a thread key first (back-compat), then
        // as a session-id prefix (the sessions layer).
        let key = m[1] || null;
        if (key) { try { key = decodeURIComponent(key); } catch {} }
        let sub = m[2] || null;
        if (sub) { try { sub = decodeURIComponent(sub); } catch {} }
        let anchor = m[3] || null;
        if (anchor) { try { anchor = decodeURIComponent(anchor); } catch {} }
        setView('session');
        if (anchor) {
          // Deep link to a moment (@pair) or a slice (@a..b): enter replay
          // paused — at that pair's end, or at the window's end with the
          // slice set (pair ids survive cross-run merges; clocks wouldn't).
          const dots = anchor.indexOf('..');
          const pa = pairs.find(x => x.id === (dots === -1 ? anchor : anchor.slice(0, dots)));
          const pb = dots === -1 ? pa : pairs.find(x => x.id === anchor.slice(dots + 2));
          if (pa && pb) {
            if (dots !== -1) {
              replay.sliceA = pairEndMs(pa);
              replay.sliceB = pairEndMs(pb);
            }
            replay.cursor = Math.max(pairEndMs(pa), pairEndMs(pb));
            if (!replay.active) {
              replay.active = true;
              document.body.classList.add('replaying');
              tailPill.classList.remove('show');
              renderReplayStrip(true);
            }
            renderReplayBar();
          }
        }
        showSession(key, sub);
      } else if ((m = h.match(/^#\\/context(?:\\/([^/@=][^/]*))?(?:\\/([^/@=][^/]*))?(?:\\/=(\\w+))?$/))) {
        // #/context[/<sid8-or-thread-key>[/<thread-key>]][/=<deck>] — same
        // key grammar as the sessions view; the selection is SHARED with
        // it, so tab switches keep the conversation in focus. The deck
        // (window|stream|events) rides an '='-marked tail segment so it
        // can never be mistaken for a thread key.
        let key = m[1] || null;
        if (key) { try { key = decodeURIComponent(key); } catch {} }
        let sub = m[2] || null;
        if (sub) { try { sub = decodeURIComponent(sub); } catch {} }
        if (m[3]) setCtxMode(m[3]);
        setView('context');
        showContext(key, sub);
      } else if ((m = h.match(/^#\\/trajectory(?:\\/([^/@][^/]*))?(?:\\/([^/@][^/]*))?$/))) {
        // The Trajectory tab folded into the context page (0.45): the
        // record stream is one of its three decks, not a second view of
        // the same thread. Old links keep working — they land on the
        // stream and rewrite themselves to the context route.
        let key = m[1] || null;
        if (key) { try { key = decodeURIComponent(key); } catch {} }
        let sub = m[2] || null;
        if (sub) { try { sub = decodeURIComponent(sub); } catch {} }
        setCtxMode('stream');
        setView('context');
        showContext(key, sub);
        history.replaceState(null, '', ctxHash(sessionSelKey, 'stream'));
      } else {
        setView('requests');
        closeDetail();
      }
    }
    window.addEventListener('hashchange', route);

    function setView(v) {
      // Entering the sessions view must POSITION both panes — the outline
      // scrolled to its active row, the conversation at its landing point —
      // instantly: arrival is not a jump, the destination is simply there
      // (ui.md motion budget; animation is reserved for in-view jumps).
      if (v === 'session' && view !== 'session') pendingSessionFocus = true;
      view = v;
      if (v !== 'requests' && selMode) setSelMode(false);
      // Presentation belongs to the sessions view: leaving it must not
      // strand a reader on a page with no header and no toolbar.
      if (v !== 'session') document.body.classList.remove('present');
      document.body.classList.toggle('view-session', v === 'session');
      document.body.classList.toggle('view-context', v === 'context');
      tabRequests.classList.toggle('active', v === 'requests');
      tabSession.classList.toggle('active', v === 'session');
      tabContext.classList.toggle('active', v === 'context');
    }
    tabRequests.onclick = () => { location.hash = ''; };
    tabSession.onclick = () => { location.hash = '#/session'; };
    // The context tab keeps the sessions view's selection — same thread,
    // different lens.
    tabContext.onclick = () => { location.hash = ctxHash(sessionSelKey, ctxMode); };
    function ctxHash(key, mode) {
      return '#/context' + (key ? '/' + encodeURIComponent(shortKeyStr(key)) : '') +
        (mode && mode !== 'window' ? '/=' + mode : '');
    }

    function openDetail(id) {
      const isNew = detailId !== id;
      detailId = id;
      document.body.classList.add('detail-open');
      try { detailEl.innerHTML = renderDetail(id); }
      catch (e) { detailEl.innerHTML = detailNavHtml(id) + brokenItem('request', id, e); }
      detailEl.querySelectorAll('details[data-raw][open]').forEach(fillRaw);
      if (isNew) detailEl.scrollTop = 0;
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

    // ---- Find in session: fold-aware text search over the conversation ----
    // Hits are top-level conversation nodes containing the query — folded
    // tool bodies included, since folds are <details> already in the DOM.
    // Jumping opens exactly the folds that hold the text, which is the one
    // thing the browser's own Ctrl+F cannot do here.
    const sfindEl = document.getElementById('sfind');
    const sfindCount = document.getElementById('sfind-count');
    let sfindIdx = -1;
    function sfindHits() {
      const q = (sfindEl.value || '').trim().toLowerCase();
      const hits = [];
      if (q) {
        for (const node of convoEl.children) {
          if ((node.textContent || '').toLowerCase().includes(q)) hits.push(node);
        }
      }
      return { q, hits };
    }
    function sfindShow(n, total) {
      sfindCount.textContent = !sfindEl.value.trim() ? ''
        : !total ? 'no hits'
        : n ? n + '/' + total
        : total + ' hit' + (total === 1 ? '' : 's');
    }
    function sfindJump(step) {
      const { q, hits } = sfindHits();
      if (!hits.length) { sfindIdx = -1; sfindShow(0, 0); return; }
      sfindIdx = ((sfindIdx + step) % hits.length + hits.length) % hits.length;
      const node = hits[sfindIdx];
      for (const d of node.querySelectorAll('details')) {
        if (!d.open && (d.textContent || '').toLowerCase().includes(q)) d.open = true;
      }
      node.scrollIntoView({ block: 'center' });
      node.classList.remove('find-flash');
      void node.offsetWidth; // restart the flash animation
      node.classList.add('find-flash');
      sfindShow(sfindIdx + 1, hits.length);
    }
    if (sfindEl) {
      sfindEl.addEventListener('input', () => { sfindIdx = -1; sfindShow(0, sfindHits().hits.length); });
      sfindEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { sfindJump(e.shiftKey ? -1 : 1); e.preventDefault(); }
        else if (e.key === 'Escape') {
          if (sfindEl.value) { sfindEl.value = ''; sfindIdx = -1; sfindShow(0, 0); }
          else sfindEl.blur();
          e.stopPropagation();
        }
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      if (e.key === '/') { (view === 'session' && sfindEl ? sfindEl : filterEl).focus(); e.preventDefault(); return; }
      if (view === 'context') {
        const ctxThread = () => getThreads().find(x => x.key === sessionSelKey);
        if (e.key === 'Escape') {
          // Escape peels one layer at a time: the inspector, the brushed
          // range, then the zoom, then the view. Dropping straight out of
          // a page you have scoped is the thing that makes a reader stop
          // scoping.
          const t = ctxThread();
          if (ctxInspOpen && ctxPick() && t) { ctxInspOpen = false; ctxRepaintInsp(); return; }
          if (ctxRange && t) { ctxRange = null; renderContextView(t); return; }
          if (ctxZoom > 1 && t) { ctxZoom = 1; renderContextView(t); return; }
          location.hash = '';
          return;
        }
        if (e.key === '1' || e.key === '2' || e.key === '3') {
          const t = ctxThread();
          if (!t) return;
          setCtxMode(CTX_MODES[+e.key - 1]);
          history.replaceState(null, '', ctxHash(t.key, ctxMode));
          renderContextView(t);
          return;
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          // Walk the pinned step through the overview — the keyboard face
          // of click-to-pin.
          e.preventDefault();
          const t = ctxThread();
          if (!t) return;
          const steps = ctxData(t).tl.steps;
          if (!steps.length) return;
          let i = steps.findIndex(s => s.pairId === ctxPinned);
          if (i === -1) i = steps.length - 1;
          i = Math.max(0, Math.min(steps.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)));
          ctxPinned = steps[i].pairId;
          renderContextView(t);
          const el = contextEl.querySelector('[data-cxbar="' + (window.CSS && CSS.escape ? CSS.escape(ctxPinned) : ctxPinned) + '"]');
          if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          return;
        }
        return;
      }
      if (view === 'requests' && selMode && !detailId && e.key === 'Escape') { setSelMode(false); return; }
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
        // Presentation: the chrome steps out and the panes take the
        // viewport. Not persisted — a presentation is a moment.
        if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) {
          document.body.classList.toggle('present');
          return;
        }
        // While replaying, [ / ] are CHAPTERS — the working-loop heads of
        // the thread on screen. They only switch SESSIONS when replay is
        // off: with a cursor on the tape, moving between loops is what the
        // reader means, and the session switcher is one Esc away.
        if ((e.key === '[' || e.key === ']') && replay.active) {
          e.preventDefault();
          seekChapter(e.key === ']' ? 1 : -1);
          return;
        }
        if (e.key === '[' || e.key === ']') {
          // Previous/next session, newest-first (same order as the pane).
          const threads = getThreads();
          const at = {};
          for (const t of threads) {
            if (!t.sessionId) continue;
            at[t.sessionId] = Math.max(at[t.sessionId] || 0, t.lastAt || t.firstAt || 0);
          }
          const sids = Object.keys(at).sort((a, b) => at[b] - at[a]);
          if (sids.length > 1) {
            let cur = null;
            for (const t of threads) if (t.key === sessionSelKey) cur = t.sessionId;
            let i = sids.indexOf(cur);
            i = e.key === ']' ? Math.min(sids.length - 1, i + 1) : Math.max(0, i - 1);
            location.hash = '#/session/' + encodeURIComponent(sids[i].slice(0, 8));
          }
          return;
        }
        if (e.key === 'Escape') {
          // Peel one layer at a time: presentation, then replay, then the
          // view. Dropping straight out of a mode you entered on purpose is
          // the thing that makes a reader stop entering modes.
          if (document.body.classList.contains('present')) { document.body.classList.remove('present'); return; }
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
          seekReplay(rpHome());
          updateReplayHash();
        } else if (e.key === 'End' && replay.active) {
          e.preventDefault();
          seekEnd();
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
        '<button class="detail-id" data-id="' + escapeHtml(id) + '" onclick="copyReqId(event, this)" title="request id \\u2014 click to copy">' + escapeHtml(id) + '</button>' +
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

      // Chips (short identity) stay on top; then the Headers + Body folds
      // (short or collapsed); the conversation is the megabyte tail, so it
      // renders last — reaching Headers no longer means scrolling past it.
      if (pair._cat === 'messages') html += messagesChips(pair);
      else if (pair._cat === 'tokens') html += tokensChips(pair);
      html += headersSection(pair);
      html += rawSections(pair);
      if (pair._cat === 'messages' || pair._cat === 'tokens') html += renderConversation(pair);
      else if (pair._cat === 'usage') html += renderUsagePanel(pair);
      return html;
    }

    // Values are escaped here, not by callers: fmtCost can emit "<$0.0001"
    // and wire-derived strings can hold anything — a chip must never be able
    // to open a tag.
    function kv(label, value, cls, title) {
      return '<span class="chip ' + (cls || '') + '"' + (title ? ' title="' + escapeHtml(title) + '"' : '') + '><b>' + label + '</b>' + escapeHtml(value) + '</span>';
    }

    function isNewestModelPair(pair) {
      if (pair._cat !== 'messages') return false;
      for (const p of pairs) {
        if (p._cat === 'messages' && p !== pair && pairEndMs(p) > pairEndMs(pair)) return false;
      }
      return true;
    }

    function messagesChips(pair) {
      const m = extractCallInfo(pair);
      let row1 = '';
      if (m.error) row1 += kv('error', m.error, 'err');
      if (m.model) row1 += kv('model', m.model, 'model');
      row1 += kv('stream', m.stream ? 'yes' : 'no');
      if (m.maxTokens != null) row1 += kv('max_tokens', m.maxTokens.toLocaleString());
      if (m.temperature != null) row1 += kv('temp', m.temperature);
      const eff = extractEffort(pair.request.body);
      if (eff) row1 += kv('effort', eff.v, '', eff.title);
      if (m.stopReason) row1 += kv('stop', m.stopReason, m.stopReason === 'end_turn' || m.stopReason === 'tool_use' ? '' : 'warn');
      if (pair.response && pair.response.truncated) row1 += kv('stopped', 'early', 'warn', 'stream ended before completion \\u2014 the partial response up to that point was captured (cctrace keeps capturing after a CLI abort)');
      if (m.serviceTier) row1 += kv('tier', m.serviceTier);
      if (m.error) return '<div class="chips">' + row1 + '</div>';
      let row2 = '';
      row2 += kv('input', m.input.toLocaleString());
      row2 += kv('output', m.output.toLocaleString());
      if (m.thinking > 0) row2 += kv('thinking', m.thinking.toLocaleString());
      const cache = summarizeCache(m, pair.request.body,
        pair.response && typeof pair.response.timestamp === 'number' ? pair.response.timestamp * 1000 : null);
      if (cache) {
        // "expired" only on the NEWEST model call: older deadlines are
        // meaningless (any later hit refreshed the TTL) — same rule as
        // the requests list.
        const expired = cache.expiresAt && isNewestModelPair(pair) && Date.now() > cache.expiresAt;
        row2 += kv('cache', cache.v + (expired ? ' \u00b7 expired' : ''), expired ? 'warn' : cache.c,
          cache.title + (expired ? ' \u2014 EXPIRED at render time: resuming this session now re-writes the prefix at write price' : ''));
      }
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
    function fold(title, hint, body, cls, open, extraHtml, icon) {
      // A hint long enough to ellipsize gets the full text in the hover,
      // led by the fold's own name — for a tool_use that reads "Edit" then
      // the full file list the row truncated, then metrics/hints. The
      // tooltip answers "what does the rest of this command/preview say"
      // before the user has to open the fold.
      const hintTip = hint && hint.length > 60
        ? ' data-tip="' + escapeHtml(String(title) + '\\n' +
            String(hint).slice(0, 600) + (hint.length > 600 ? '\\u2026' : '') +
            '\\n---\\n> click to expand') + '"'
        : '';
      return '<details class="fold ' + (cls || '') + '"' + (open ? ' open' : '') + '>' +
        '<summary' + hintTip + '>' + (icon ? '<span class="fold-ico">' + icon + '</span>' : '') +
        '<span class="fold-title">' + escapeHtml(title) + '</span>' +
        (hint ? '<span class="fold-hint">' + escapeHtml(hint) + '</span>' : '') +
        (extraHtml || '') +
        (hint ? '' : '<span class="fold-hint"></span>') +
        '<button class="fold-btn fold-copy" onclick="copyFoldBody(event, this)" title="Copy contents">copy</button>' +
        '</summary><div class="fold-body">' + body + '</div></details>';
    }

    function snippet(v, n) {
      let s = typeof v === 'string' ? v : (JSON.stringify(v) || '');
      s = s.replace(/\\s+/g, ' ').trim();
      return s.length > n ? s.slice(0, n) + '...' : s;
    }

    // Full GFM markdown via marked.js — tables, lists, task lists, code
    // blocks, blockquotes, strikethrough, and everything the old regex
    // renderer missed. Raw HTML in model output is escaped (same security
    // posture as before). Links open in a new tab.
    marked.use({
      gfm: true,
      breaks: true,
      renderer: {
        html({ text }) { return escapeHtml(text); },
        link({ href, title, tokens }) {
          const t = this.parser.parseInline(tokens);
          return '<a href="' + href + '" target="_blank" rel="noopener"' +
            (title ? ' title="' + title + '"' : '') + '>' + t + '</a>';
        },
        code({ text, lang }) {
          const cls = lang ? ' class="language-' + escapeHtml(lang) + '"' : '';
          return '<pre class="md-code"><code' + cls + '>' + text + '</code></pre>';
        },
      },
    });
    function renderMd(text) {
      let t = String(text == null ? '' : text);
      t = t.replace(/\\u001b\\[[0-9;:?]*[a-zA-Z]/g, '')
           .replace(/[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]/g, '');
      return marked.parse(t);
    }

    // Long texts render clamped with a "show all" expander; short ones inline.
    // md renders assistant reply text as markdown (marked.js GFM).
    function textBlock(text, cls, md, copy) {
      const t = String(text == null ? '' : text);
      const mcls = 'msg-text' + (md ? ' msg-md' : '') + (cls ? ' ' + cls : '');
      const inner = '<div class="' + mcls + '">' + (md ? renderMd(t) : escapeHtml(t)) + '</div>';
      // copy: a hover copy button for standalone user/assistant text (thinking
      // and tool_result text live inside folds that already carry copy). The
      // button copies the block's full text even when it renders clamped.
      const box = copy && t
        ? '<div class="pre-wrap"><button class="copy-btn" onclick="copyBlock(this)" title="Copy">' + COPY_SVG + '</button>' + inner + '</div>'
        : inner;
      if (t.length <= 2000) return box;
      return '<div class="msg-clamp clamped">' + box +
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

    // The LAST turn is what the user came back to read — the final answer
    // renders in full, no "show all" click. Earlier turns keep the clamp
    // (they're context, and unclamping all of them makes the page a scroll
    // marathon). Runs after a convo render; a live patch that rebuilds the
    // tail node re-applies it via the clamp-state carry in applyConvoParts.
    function unclampLastTurn() {
      if (!convoEl.querySelectorAll) return; // headless test stub
      const turns = convoEl.querySelectorAll('.turn');
      if (!turns.length) return;
      const last = turns[turns.length - 1];
      for (const mc of last.querySelectorAll('.msg-clamp.clamped')) {
        const btn = mc.querySelector(':scope > .msg-more');
        if (btn) window.toggleClamp(btn);
      }
    }

    function renderBlock(b, md) {
      if (b == null) return '';
      if (typeof b === 'string') return textBlock(b, '', md, true);
      const type = b.type;
      if (type === 'text') return textBlock(b.text, '', md, true);
      if (type === 'thinking') {
        const t = b.thinking || '';
        if (!t) return '<div class="block-note">thinking (no visible content)</div>';
        return fold('thinking', fmtCompact(t.length) + ' chars \\u00b7 ' + snippet(t, 90), textBlock(t, 'think'));
      }
      if (type === 'redacted_thinking') return '<div class="block-note">redacted thinking</div>';
      if (type === 'tool_use' || type === 'server_tool_use') {
        const pv = toolPreview(b.name || '?', b.input, wsRoot()) || snippet(b.input, 110);
        return fold(b.name || '?', pv ? '(' + pv + ')' : '', preBlock(formatJson(b.input)), 'fold-tool');
      }
      if (type === 'tool_result') {
        let body = '';
        if (typeof b.content === 'string') body = textBlock(b.content);
        else if (Array.isArray(b.content)) { for (const c of b.content) body += renderBlock(c); }
        else body = preBlock(formatJson(b.content));
        const len = typeof b.content === 'string' ? fmtCompact(b.content.length) + ' chars \\u00b7 ' : '';
        return fold('tool_result' + (b.is_error ? ' \\u00b7 error' : ''), len + snippet(b.content, 90), body, b.is_error ? 'errline' : '');
      }
      if (type === 'image') return renderImageBlock(b);
      return fold(String(type || 'block'), '', preBlock(formatJson(b)));
    }

    // Image blocks render as REAL thumbnails when the bytes are already in
    // the trace (Anthropic base64 source, or a data: URL an OpenAI-dialect
    // image_url carried) — click toggles full size. Wire-controlled fields
    // are validated, not trusted: media_type against an image/* shape, the
    // base64 payload against its alphabet. A REMOTE url stays a note with
    // the address — the viewer must never auto-fetch a wire-named resource
    // (a captured conversation could point the reader's browser anywhere).
    function renderImageBlock(b) {
      const src = b.source || {};
      const mt = typeof src.media_type === 'string' && /^image\\/[\\w.+-]+$/.test(src.media_type) ? src.media_type : '';
      let dataUrl = '';
      if (src.type === 'base64' && typeof src.data === 'string' && mt &&
          /^[A-Za-z0-9+/=\\s]+$/.test(src.data.slice(0, 4096))) {
        dataUrl = 'data:' + mt + ';base64,' + src.data.replace(/[^A-Za-z0-9+/=]/g, '');
      } else if (typeof src.dataUrl === 'string' && /^data:image\\/[\\w.+-]+[;,]/.test(src.dataUrl)) {
        dataUrl = src.dataUrl;
      }
      if (dataUrl) {
        const kb = Math.round((dataUrl.length * 3) / 4 / 1024);
        return '<div class="msg-imgwrap"><img class="msg-img" loading="lazy" src="' + escapeHtml(dataUrl) + '"' +
          ' onclick="this.classList.toggle(\\'full\\')"' +
          ' title="' + escapeHtml((mt || 'image') + (kb ? ' \\u00b7 ~' + kb + ' KB stored' : '') + '\\n> click toggles full size') + '"></div>';
      }
      if (typeof src.url === 'string' && src.url) {
        return '<div class="block-note">[image \\u00b7 remote \\u00b7 ' + escapeHtml(src.url.slice(0, 120)) + ' \\u2014 not fetched]</div>';
      }
      return '<div class="block-note">[image' + (mt ? ' \\u00b7 ' + escapeHtml(mt) : '') + ']</div>';
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
        // OpenAI dialect: Responses (codex/grok) input[] and Chat Completions
        // (kimi) messages[] both normalize through openaiInput into the same
        // turn/block model, so the folds render identically.
        const input = openaiInput(req);
        const sys = openaiSystemText(input);
        if (sys) html += renderSystem(sys);
        const tools = openaiTools(req);
        if (tools.length) html += renderTools(tools);
        for (const t of normalizeOpenaiTurns(input)) {
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

    // The usage-limit "resets in Xh Ym" is a countdown against wall-clock,
    // not against the capture: tick every rendered instance so a page left
    // open stays truthful (a lapsed window flips to "Nm ago").
    setInterval(() => {
      for (const el of document.querySelectorAll('[data-resets]')) {
        const r = relTime(el.dataset.resets);
        if (r) el.textContent = 'resets ' + r;
      }
    }, 30000);

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
          '<span class="ubar-resets"' + (l.resetsAt ? ' title="' + escapeHtml(l.resetsAt) + '" data-resets="' + escapeHtml(l.resetsAt) + '"' : '') + '>' +
          (l.resetsAt ? 'resets ' + relTime(l.resetsAt) : '') + '</span>' +
        '</div>';
      }
      if (u.credits) {
        const d = Math.pow(10, u.credits.decimalPlaces);
        rows += '<div class="ubar-row"><span class="ubar-label">credits</span><span class="ubar-pct" data-mask="usage" style="flex:none">' +
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

    // Copy a fold's body: the pretty JSON of a tool_use / body fold, the full
    // system-prompt text, etc. Lazy raw folds (data-raw) are filled first so
    // there is something to copy. The button lives in the summary and stops
    // the click from toggling the fold.
    window.copyFoldBody = function(ev, btn) {
      ev.preventDefault(); ev.stopPropagation();
      const det = btn.closest('details');
      if (det.dataset && det.dataset.raw) fillRaw(det);
      const body = det.querySelector(':scope > .fold-body');
      navigator.clipboard.writeText(body ? body.textContent : '').then(function() {
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
        '<summary><span class="fold-title">' + escapeHtml(title) + '</span><span class="fold-hint"></span>' +
        (altLabel ? '<button class="fold-btn" data-alt-label="' + escapeHtml(altLabel) + '" onclick="toggleRawMode(event, this)">' + escapeHtml(altLabel) + '</button>' : '') +
        '<button class="fold-btn" onclick="copyFoldBody(event, this)" title="Copy contents">copy</button>' +
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
      // A slice narrows the source to its window first — the session
      // rebuilds from exactly the pairs the slice (and its export) holds.
      const base = replay.active ? slicePairs(pairs) : pairs;
      const a = replay.active ? ((anchorAt(replayEvents(base), replay.cursor) || { id: '^' }).id) : 'live';
      const key = pairs.length + ':' + a + (sliceActive() ? ':' + replay.sliceA + '-' + replay.sliceB : '');
      if (sessionCache.key !== key) {
        const src = replay.active ? visibleAt(base, replay.cursor) : pairs;
        sessionCache = { key, threads: buildSession(src, CLIENT_WIRE).threads };
      }
      return sessionCache.threads;
    }

    // Default focus is ALWAYS the most recent session (session-tab design):
    // when several session ids exist, the main-thread pick scopes to the one
    // with the newest wire activity.
    function newestMainThread(threads) {
      let sid = '';
      let at = -1;
      for (const t of threads) {
        if (t.sessionId && (t.lastAt || t.firstAt || 0) >= at) { at = t.lastAt || t.firstAt || 0; sid = t.sessionId; }
      }
      const scoped = sid ? threads.filter(t => t.sessionId === sid) : threads;
      return mainThread(scoped) || mainThread(threads);
    }

    // Resolve a URL key to a thread — shared by the sessions and context
    // views (one key grammar, one resolution): exact key, short key
    // ('<sid8>|<grouping>'), session-id prefix (+ optional sub thread-key),
    // then the newest session's main thread.
    function resolveThreadSel(threads, key, sub) {
      let sel = null;
      for (const t of threads) if (t.key === key) sel = t;
      if (!sel && key) {
        // Short thread key: '<sid8>|<grouping>' — what the URLs carry
        // (the full wire uuid in the hash was noise, and redacted traces
        // put literal **** in the URL bar). Full-key links stay valid via
        // the exact match above.
        const cut = key.indexOf('|');
        if (cut >= 0) {
          const sp = key.slice(0, cut), rest = key.slice(cut);
          for (const t of threads) {
            const tc = t.key.indexOf('|');
            if (tc >= 0 && t.key.slice(tc) === rest && t.key.slice(0, tc).lastIndexOf(sp, 0) === 0) { sel = t; break; }
          }
        }
      }
      if (!sel && key) {
        // Session-id prefix: /<sid8>[/<thread-key>] selects that session's
        // named thread, or its main thread.
        const st = threads.filter(t => t.sessionId && t.sessionId.lastIndexOf(key, 0) === 0);
        if (st.length) sel = (sub && st.find(t => t.key === sub || shortKeyStr(t.key) === sub)) || mainThread(st);
      }
      return sel || newestMainThread(threads);
    }

    function showSession(key, sub) {
      const threads = getThreads();
      if (!threads.length) {
        // The stage still stands while replaying: at a cursor before the
        // first response it says so, instead of blanking the column.
        threadsEl.innerHTML = stageHtml();
        convoEl.innerHTML = '<div class="empty">' + (replay.active
          ? 'Nothing on the wire yet at this moment \\u2014 step forward (\\u2192) or press play.'
          : 'No /v1/messages requests captured yet.') + '</div>';
        convoKey = null;
        tailPill.classList.remove('show');
        return;
      }
      let sel = resolveThreadSel(threads, key, sub);
      // Replaying: the SELECTION is the reader's, resolved once against the
      // whole capture. The cursored rebuild must never steal it — before the
      // selected thread's first response it resolves to the fallback, which
      // used to flip the rail, the convo AND the strip's axis to whatever
      // thread happened to exist at the cursor (rev 5).
      if (replay.active) {
        const want = resolveThreadSel(fullThreads(), key || sessionSelKey, sub);
        if (want) {
          sessionSelKey = want.key;
          const cur = threads.find(t => t.key === want.key);
          if (cur) sel = cur;
          else {
            // Not on the wire yet at this moment: the rail renders without a
            // selection to mark, the convo says so, the stage still stands.
            renderThreadsPane(threads, { key: want.key });
            convoEl.innerHTML = '<div class="empty">Nothing on this thread\\u2019s wire yet at this moment \\u2014 step forward (\\u2192) or press play.</div>';
            convoKey = null;
            tailPill.classList.remove('show');
            renderReplayBar();
            return;
          }
        }
      }
      sessionSelKey = sel.key;
      agentThreadIndex = {};
      agentThreadStats = {};
      agentThreadMeta = {};
      for (const t of threads) {
        if (t.agentOf && t.agentOf.toolUseId) {
          agentThreadIndex[t.agentOf.toolUseId] = t.key;
          const u = t.usage || {};
          const n = loopCountOf(t);
          let s = n + ' turn' + (n === 1 ? '' : 's') + ' \\u00b7 out ' + fmtCompact(u.output || 0);
          if (u.cost) s += ' \\u00b7 ' + fmtCost(u.cost);
          const errs = (u.wireErrors || 0) + (u.toolErrors || 0) + (u.truncated || 0);
          if (errs) s += ' \\u00b7 ' + errs + ' err';
          agentThreadStats[t.agentOf.toolUseId] = s;
          agentThreadMeta[t.agentOf.toolUseId] = { t: t, stats: s };
        }
      }
      renderThreadsPane(threads, sel);
      renderConvoPane(sel);
      // The strip is RULED by the selected thread (its extent is the axis)
      // and ghosts every other one, so a rail click repaints the whole bar —
      // keyed on the selection, so this is a no-op otherwise. Outside replay
      // the strip alone renders (rev 3): it is the view's overview; the
      // veil, the handle and the loop row wait for a cursor.
      if (replay.active) renderReplayBar();
      else { renderReplayStrip(); rpQueueSyncRead(); }
      if (pendingSessionFocus) {
        pendingSessionFocus = false;
        focusThreadsPane();
        // Live entry lands on the newest turn (terminal semantics); reading
        // modes (snapshot/view) keep their document position.
        if (!IS_READING) convoToBottom();
      }
    }

    // On entry the outline must answer "where am I": scroll the threads
    // pane so the selected session/thread is in view. Instant — arrival
    // positioning, not a jump. Live re-renders preserve scrollTop, so this
    // runs once per entry into the sessions view.
    let pendingSessionFocus = false;
    function focusThreadsPane() {
      const el = threadsEl.querySelector && (
        threadsEl.querySelector('.thread.selected') ||
        threadsEl.querySelector('details.sess.selected'));
      if (!el || !el.getBoundingClientRect) return;
      const top = el.getBoundingClientRect().top - threadsEl.getBoundingClientRect().top;
      threadsEl.scrollTop = Math.max(0, threadsEl.scrollTop + top - 8);
    }

    // ---- Designed tooltip (page-wide) ----
    // Native title waits ~1s and renders unstyled; every hover detail on the
    // page deserves better. One fixed singleton, filled from data-tip: first
    // line renders as the heading, blank lines as section gaps, a line of
    // exactly "---" as a hairline divider between sections (content /
    // metrics / hints), and lines starting with "> " as faint interaction
    // hints. Elements that carry a plain title= get folded into the same
    // panel — the title is moved into data-tip on first hover so the native
    // tooltip never fires. A short show-delay keeps mousing across a row of
    // chips from flickering panels. Pointer-events off so it never traps
    // the mouse; guarded so headless boots (tests) skip it.
    let tipDetachedGuard = function() {};
    if (document.createElement && document.body) {
      const tipEl = document.createElement('div');
      tipEl.className = 'tip';
      document.body.appendChild(tipEl);
      const SHOW_DELAY = 120;
      let tipFor = null, showTimer = 0;
      const hideTip = () => { clearTimeout(showTimer); tipFor = null; tipEl.classList.remove('show'); };
      // Live re-renders replace sidebar/convo DOM under the mouse; a tip
      // anchored to a detached node would linger until the next mouse move.
      tipDetachedGuard = () => {
        if (tipFor && document.body.contains && !document.body.contains(tipFor)) hideTip();
      };
      const showTipFor = (t) => {
        const lines = String(t.dataset.tip || '').split('\\n');
        let h = '';
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].trim()) { h += '<div class="tip-gap"></div>'; continue; }
          if (lines[i].trim() === '---') { h += '<div class="tip-sep"></div>'; continue; }
          if (lines[i].lastIndexOf('> ', 0) === 0) { h += '<div class="tip-hint">' + escapeHtml(lines[i].slice(2)) + '</div>'; continue; }
          h += '<div class="' + (i === 0 ? 'tip-head' : 'tip-line') + '">' + escapeHtml(lines[i]) + '</div>';
        }
        tipEl.innerHTML = h;
        tipEl.classList.add('show');
        tipEl.style.left = '0px';
        tipEl.style.top = '0px';
        const r = t.getBoundingClientRect();
        const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
        // Threads-pane anchors fly out to the RIGHT of the sidebar instead
        // of dropping below — a below-tip covered the very rows the user
        // was scanning (the whole outline under the cursor went blind).
        const pane = t.closest ? t.closest('#threads') : null;
        if (pane && pane.getBoundingClientRect) {
          const pr = pane.getBoundingClientRect();
          let x = pr.right + 8;
          if (x + tw > window.innerWidth - 8) x = Math.max(8, window.innerWidth - tw - 12);
          tipEl.style.left = x + 'px';
          tipEl.style.top = Math.max(8, Math.min(r.top, window.innerHeight - th - 8)) + 'px';
          return;
        }
        // A tip dropped below a 17px icicle row covers the rows underneath
        // it — the very ones being scrubbed (same scar as the threads
        // pane, docs/design/ui.md). Flame and lane anchors open UPWARD,
        // falling back down only when there is no room above.
        const flame = t.closest ? t.closest('.cx-flame, #rp-lanes') : null;
        let y = flame && r.top - th - 6 >= 8 ? r.top - th - 6 : r.bottom + 6;
        if (y + th > window.innerHeight - 8) y = Math.max(8, r.top - th - 6);
        tipEl.style.left = Math.max(8, Math.min(r.left, window.innerWidth - tw - 12)) + 'px';
        tipEl.style.top = y + 'px';
      };
      document.addEventListener('mouseover', (e) => {
        const t = e.target && e.target.closest ? e.target.closest('[data-tip],[title]') : null;
        // Fold a plain title into the designed panel and kill the native one.
        // Re-reading title= each time keeps dynamic titles (theme toggle) fresh.
        if (t && t.hasAttribute('title')) { t.dataset.tip = t.getAttribute('title'); t.removeAttribute('title'); }
        if (t === tipFor) return;
        clearTimeout(showTimer);
        tipEl.classList.remove('show');
        tipFor = t;
        if (!t) return;
        // A blank tip (title="") must not summon an empty panel.
        if (!String(t.dataset.tip || '').trim()) return;
        showTimer = setTimeout(() => showTipFor(t), SHOW_DELAY);
      });
      document.addEventListener('scroll', hideTip, true);
      document.addEventListener('mouseleave', hideTip);
    }

    // Quiet stroke glyphs for the sessions layer (currentColor, no fills):
    // a prompt-in-a-frame for the session, a branch for a model run.
    const ICON_SESSION = '<svg class="sico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M4.3 6.2l2.3 1.8-2.3 1.8M8.6 10h3"/></svg>';
    // branch-off-a-rail shape: matches the session rail's own vocabulary
    // (one line, one arm, one node) — used on subagent spawn folds.
    const ICON_EPOCH = '<svg class="sico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 2v12M4.5 6.5c0 3 2.6 3.3 5.1 3.5"/><circle cx="11.6" cy="10.2" r="1.8"/></svg>';
    // Notable-event glyphs for conversation folds: a bolt for skills, a
    // plug for MCP; subagent spawns reuse the branch (they ARE a thread).
    const ICON_SKILL = '<svg class="sico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M9 1.5L3.5 9H7l-1 5.5L11.5 7H8z"/></svg>';
    const ICON_MCP = '<svg class="sico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M5.5 1.5v3.5M10.5 1.5v3.5M3.5 5h9v2.5a4.5 4.5 0 01-9 0zM8 12v2.5"/></svg>';

    // URL form of a thread key: '<sid8>|<grouping>'. Internal state keeps
    // full keys; only what lands in the location hash is shortened.
    function shortKeyStr(key) {
      const cut = (key || '').indexOf('|');
      if (cut <= 0) return key || '';
      return key.slice(0, Math.min(8, cut)) + key.slice(cut);
    }
    function threadHash(key) {
      return '#/session/' + encodeURIComponent(shortKeyStr(key));
    }

    // A thread's turn count in working-loop units (user request → agent
    // work → final response) — what a human means by "12 turns", and the
    // same numbering the outline's ordinals use.
    function loopCountOf(t) {
      return loopTurns((t.turns || []).filter(x => !x.toolResultsOnly)).length;
    }

    function threadMeta(t, nested) {
      const u = t.usage;
      const errs = (u.wireErrors || 0) + (u.toolErrors || 0) + (u.truncated || 0);
      // A subagent card that ISN'T nested under its parent (the parent
      // lives in another session section) still names the way home.
      const parent = !nested && t.agentOf
        ? ' \\u00b7 <a class="tparent" href="' + threadHash(t.agentOf.thread) + '"' +
          ' data-key="' + escapeHtml(t.agentOf.thread) + '" data-tuid="' + escapeHtml(t.agentOf.toolUseId || '') + '"' +
          ' onclick="return jumpToParent(event, this)"' +
          ' data-tip="dispatched by a thread in another session\\n---\\n> click to open the parent at its spawn turn">\\u21b0 parent</a>'
        : '';
      const meta = u.requests + ' req \\u00b7 in ' + fmtCompact(u.input) + ' \\u00b7 out ' + fmtCompact(u.output) +
        (u.cacheRead ? ' \\u00b7 cache ' + fmtCompact(u.cacheRead) : '') +
        (u.cost ? ' \\u00b7 ' + escapeHtml(fmtCost(u.cost)) : '') +
        (errs ? ' \\u00b7 <span class="err" title="' + escapeHtml(errTitle(u)) + '">' + errs + ' err</span>' : '') +
        (u.rewound ? ' \\u00b7 <span title="exchanges that left the conversation history (/rewind, an edited message, or an ephemeral injected exchange) \\u2014 the wire pairs are kept">' + u.rewound + ' superseded</span>' : '') +
        parent;
      return '<div class="thread-meta">' + meta + '</div>';
    }

    // One epoch section head: branch icon + T<n> ordinal + model + turn
    // count. Click = jump to where that model takes over.
    function epochHead(t, e, i) {
      const pad = (x) => (x < 10 ? '0' + x : '' + x);
      // Per-epoch rollup for the hover: what this model run produced.
      const vis = [];
      for (const turn of t.turns) if (!turn.toolResultsOnly) vis.push(turn);
      // Turn count in working-loop units (loopTurns): the loops whose head
      // starts inside this epoch's range — matches the outline's ordinals.
      const loops = loopTurns(vis);
      const ords = [];
      for (let li = 0; li < loops.length; li++) {
        const start = loops[li].head != null ? loops[li].head : (loops[li].members.length ? loops[li].members[0] : 0);
        if (start >= e.from && start <= e.to) ords.push(li);
      }
      const n = ords.length;
      let out = 0, cost = 0, t0 = 0, t1 = 0;
      for (let vi = e.from; vi <= e.to && vi < vis.length; vi++) {
        const u = vis[vi].usage;
        if (!u) continue;
        out += u.output || 0;
        const c = pairCost(u);
        if (c) cost += c.total;
        const p = vis[vi].pairId ? pairOf(vis[vi].pairId) : null;
        if (p) { if (!t0) t0 = p.request.timestamp; t1 = p.request.timestamp; }
      }
      const tip = 'T' + i + ' \\u00b7 ' + (shortModel(e.model) || 'unknown model') + ' run\\n' +
        (n ? 'turns ' + pad(ords[0] + 1) + '\\u2013' + pad(ords[n - 1] + 1) + ' (' + n + ' turn' + (n === 1 ? '' : 's') + ')'
           : 'takes over mid-turn') +
        (t0 ? '\\n' + fmtDateTime(new Date(t0 * 1000)) + (t1 && t1 !== t0 ? ' \\u2013 ' + fmtTime(new Date(t1 * 1000)) : '') : '') +
        '\\nout ' + fmtCompact(out) + (cost ? ' \\u00b7 est. ' + fmtCost(cost) : '') +
        (i > 0 ? '\\nopened by a /model switch \\u2014 same conversation, different model' : '') +
        '\\n\\nclick to jump to where this run starts';
      return '<a class="tepoch" href="' + threadHash(t.key) + '" data-key="' + escapeHtml(t.key) + '" data-turn="' + e.from + '"' +
        ' data-tip="' + escapeHtml(tip) + '">' +
        '<span class="rgut"><span class="enode"></span></span>' +
        '<span class="tepoch-ord">T' + i + '</span>' +
        '<span class="tepoch-model">' + escapeHtml(shortModel(e.model) || '?') + '</span>' +
        '<span class="tepoch-turns">' + (n ? n + ' turn' + (n === 1 ? '' : 's') : 'mid-turn') + '</span></a>';
    }

    // Model epochs as visible rows under a conversation: t0/t1/t2 mark each
    // /model switch (session-tab design — epochs are sub-structure INSIDE
    // the chat, never new threads; identity stays the conversation). Only
    // multi-epoch threads render rows; the single-model case pays nothing.
    function epochRows(t) {
      const eps = t.epochs || [];
      if (eps.length < 2) return '';
      let rows = '';
      for (let i = 0; i < eps.length; i++) rows += epochHead(t, eps[i], i);
      return '<div class="thread-turns">' + rows + '</div>';
    }

    // An assistant turn with no text block is a pure tool-call turn — the
    // agent acted without narrating. Name what it did instead of a dead
    // "tools\\u2026": same vocabulary as the convo folds (Task/skill/mcp/plain
    // tool name), deduped, capped. The rail should narrate the agent's
    // actions, which is cctrace's whole job.
    // Returns HTML (caller must NOT re-escape): ToolName(args) items, the
    // name colorized via .tname — tools are the agent's verbs, so they wear
    // the same color as the request METHOD column; args say what was acted
    // on (file workspace-relative, Bash's own intent line, skill name).
    function turnToolLabel(turn) {
      const items = [];
      const seen = {};
      const ws = wsRoot();
      for (const b of turn.blocks || []) {
        if (!b || (b.type !== 'tool_use' && b.type !== 'server_tool_use')) continue;
        const n = b.name || '?';
        const i = b.input || {};
        let name = n, args = '', ncls = 'tname';
        // Spawn shape only (subagent_type / prompt): task-tracking
        // TaskCreate {subject} falls through to the generic preview.
        if (SPAWN_TOOLS[n] && (i.subagent_type || typeof i.prompt === 'string')) {
          // The real tool name (Task/Agent) + who was spawned for what —
          // a bare "Task" said nothing when the subagent thread wasn't
          // linked (no branch row). Purple name: spawns are notable.
          ncls = 'tname tname-agent';
          args = (i.subagent_type || '') +
            (i.subagent_type && i.description ? ' \\u00b7 ' : '') + (i.description || '');
        }
        else if (n === 'Skill') { name = 'skill'; args = i.skill || i.command || ''; }
        else if (n.lastIndexOf('mcp__', 0) === 0) { name = 'mcp'; args = n.slice(5).split('__')[0]; }
        else if (n === 'Read' || n === 'Write' || n === 'Edit' || n === 'MultiEdit' || n === 'NotebookEdit') {
          // Name WHAT was touched, workspace-relative — "Edit(src/ui.ts)"
          // says more than "Edit". Dedupe is per tool+file.
          args = wsPath(i.file_path || i.notebook_path, ws) || '';
        }
        // Bash: the model's own intent line beats the raw command; the
        // command itself stays in the convo fold. Paths relativize.
        else if (n === 'Bash') args = typeof i.description === 'string' && i.description ? i.description : wsRelText(String(i.command || ''), ws).slice(0, 60);
        else if (n === 'Grep') args = i.pattern || '';
        else {
          // Everything else (Glob, WebFetch, SlashCommand, AskUserQuestion,
          // ExitPlanMode, TaskUpdate, Workflow, MCP resources, ...) takes
          // its one-line preview — one vocabulary with the convo folds.
          args = toolPreview(n, i, ws);
          if (args.length > 60) args = args.slice(0, 59) + '\\u2026';
        }
        const key = name + '(' + args + ')';
        if (seen[key]) continue;
        seen[key] = 1;
        items.push('<span class="' + ncls + '">' + escapeHtml(name) + '</span>' + (args ? '(' + escapeHtml(args) + ')' : ''));
      }
      if (!items.length) return '';
      return items.slice(0, 3).join(', ') + (items.length > 3 ? ', +' + (items.length - 3) : '');
    }

    // The SELECTED conversation's outline (session-tab 2026-07-20): epoch
    // section heads with their turns nested under —
    //     t0 fable-5
    //       turn00  <the prompt>
    //       turn01  out 28 · 3.7s
    //     t1 opus-4.8
    //       turn02  ...
    // — so the pane reads top-to-bottom like the transcript. Turn rows jump
    // to the turn in the convo pane (wire detail is one click further, on
    // the turn's wire link). Wire pairs that produced no visible turn stay
    // out UNLESS they carry a story (rewound tip, failed request) — those
    // append as wire rows, because captured data never silently disappears.
    function epochTurnList(t) {
      const vis = [];
      // superseded exchanges (t.rewound: prefix-divergent pairs) belong AT
      // their timeline position, greyed with the ordinal they occupied —
      // strictly session order, never a trailing appendix. visAt maps the
      // full-turn divergence index to the visible ordinal.
      const supAt = {};
      const compAt = {};
      const errAt = {};
      // The turn AT a rewrite-mode boundary is the injected continuation
      // summary — same position-first rule the convo tag uses, so the
      // outline's recap head and the convo's sum-tag can never disagree.
      const sumVisAt = {};
      {
        let vi2 = 0;
        const fullToVis = [];
        for (const turn of t.turns) { fullToVis.push(vi2); if (!turn.toolResultsOnly) { vis.push(turn); vi2++; } }
        fullToVis.push(vi2);
        for (const r of (t.rewound || [])) {
          const at = Math.min(Math.max(0, r.at), fullToVis.length - 1);
          (supAt[fullToVis[at]] = supAt[fullToVis[at]] || []).push(r.pairId);
        }
        for (const c of (t.compactions || [])) {
          const at = Math.min(Math.max(0, c.at), fullToVis.length - 1);
          (compAt[fullToVis[at]] = compAt[fullToVis[at]] || []).push(c);
          if (c.mode === 'rewrite') sumVisAt[fullToVis[at]] = 1;
        }
        // Failed requests (t.failed: no response / HTTP error) collapse into
        // one run per timeline position — a 429 retry storm is one row
        // ("21 failed · 429"), ordered where it happened, not 21 rows
        // dumped at the tail.
        for (const e of (t.failed || [])) {
          const at = Math.min(Math.max(0, e.at), fullToVis.length - 1);
          (errAt[fullToVis[at]] = errAt[fullToVis[at]] || []).push(e);
        }
      }
      const eps = (t.epochs && t.epochs.length) ? t.epochs : [{ model: t.model, from: 0, to: vis.length - 1 }];
      const multi = eps.length > 1;
      const supRow = (pid, vi) => {
        const p = pairOf(pid);
        if (!p) return '';
        const b = p.request.body || {};
        const hist = Array.isArray(b.messages) ? b.messages : [];
        let prompt = '';
        for (let i = hist.length - 1; i >= 0 && !prompt; i--) {
          if (hist[i] && hist[i].role === 'user') prompt = turnSnippet(normalizeTurns([hist[i]])[0].blocks);
        }
        const near = linfo[Math.min(vi, vis.length - 1)];
        const ord = near && near.ord != null ? ordFmt(near.ord) : '?';
        const tip = (prompt ? prompt.slice(0, 400) + (prompt.length > 400 ? '\\u2026' : '') + '\\n\\n' : '') +
          'turn ' + ord + ' \\u00b7 superseded exchange\\n' + fmtDateTime(new Date(p.request.timestamp * 1000)) +
          '\\n\\nthis exchange left the conversation history \\u2014 /rewind, an edited message, or an ephemeral injected exchange (recap, notices). The wire pair is kept.\\nclick to open the wire pair';
        return '<a class="tturn tturn-sup" href="#/p/' + encodeURIComponent(pid) + '" data-tip="' + escapeHtml(tip) + '">' +
          '<span class="rgut"><span class="cdot"></span></span>' +
          '<span class="tturn-ord">' + ord + '</span>' +
          '<span class="tturn-text">' + (prompt ? escapeHtml(prompt.slice(0, 120)) : 'superseded exchange') + '</span>' +
          '<span class="treq-mark">superseded</span>' + trajNone + '</a>';
      };
      // The compact boundary: the request body sent to the API changed
      // completely at this point — everything above lives on only in the
      // summary/folded form. Break mark on the rail, wire pair linked;
      // the hover spells out the context collapse in turns AND tokens.
      const compRow = (c) => {
        const p = pairOf(c.pairId);
        const info = p ? extractCallInfo(p) : null;
        const postTok = info ? (info.input || 0) + (info.cacheRead || 0) + (info.cacheWrite || 0) : 0;
        let preTok = 0;
        const pt = p ? p.request.timestamp : Infinity;
        for (const pid of t.pairIds) {
          const pp = pairOf(pid);
          if (!pp || pp.request.timestamp >= pt) continue;
          const u = extractCallInfo(pp);
          const tot = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
          if (tot > preTok) preTok = tot;
        }
        // A rewind is the same axis-break grammar with the honest word:
        // history was TRUNCATED back to an earlier point (/rewind or an
        // edited message) and regrew on a new branch — nothing above the
        // line was summarized, it just left the conversation history.
        const rw = c.mode === 'rewind';
        const tip = (rw ? 'rewound \\u00b7 history stepped back' : 'compacted \\u00b7 context rewritten') +
          (p ? '\\n' + fmtDateTime(new Date(p.request.timestamp * 1000)) : '') +
          '\\nthe request body sent to the API changed completely: ' + c.fromTurns + ' \\u2192 ' + c.toTurns + ' turns' +
          (preTok && postTok ? '\\ncontext \\u2248' + fmtCompact(preTok) + ' \\u2192 \\u2248' + fmtCompact(postTok) + ' tok' : '') +
          '\\n' + (rw
            ? '/rewind or an edited message \\u2014 the conversation resumed from an earlier point on a new branch'
            : c.mode === 'rewrite'
            ? 'full rewrite \\u2014 history replaced by a continuation summary'
            : 'fold \\u2014 older turns rewritten/folded, recent tail kept verbatim') +
          '\\n\\n' + (rw
            ? 'the turns above this line left the conversation history; their wire pairs are kept\\nclick to open the first post-rewind wire request'
            : 'everything above this line survives only in the summary/folded form\\nclick to open the first post-compact wire request');
        return '<a class="tcompact" href="#/p/' + encodeURIComponent(c.pairId) + '" data-tip="' + escapeHtml(tip) + '">' +
          '<span class="rgut"><span class="cnode"></span></span>' +
          '<span class="tcompact-label">' + (rw ? 'rewound' : 'compacted') + '</span>' +
          '<span class="tcompact-note">' + c.fromTurns + ' \\u2192 ' + c.toTurns + ' turns</span></a>';
      };
      // A run of failed requests at one timeline position: one collapsed
      // row ("21 failed requests · 429"), ordered where the storm
      // happened. The wire pairs are one click away; the retry that finally
      // landed renders as the normal turn right below.
      const errRow = (list) => {
        const n = list.length;
        const stat = {};
        let etype = '';
        let etypeOk = true;
        const times = [];
        for (const e of list) {
          stat[e.status ? String(e.status) : 'no response'] = 1;
          const p = pairOf(e.pairId);
          if (!p) continue;
          times.push(p.request.timestamp);
          const ty = (p.response && p.response.body && p.response.body.error && p.response.body.error.type) || '';
          if (ty && !etype) etype = ty;
          else if (ty && ty !== etype) etypeOk = false;
        }
        if (!etypeOk) etype = '';
        const stats = Object.keys(stat).join('/');
        const label = (n > 1 ? n + ' failed requests' : 'failed request') + ' \\u00b7 ' + stats + (etype ? ' ' + etype : '');
        const span = times.length ? fmtTime(new Date(times[0] * 1000)) + (times.length > 1 ? ' \\u2192 ' + fmtTime(new Date(times[times.length - 1] * 1000)) : '') : '';
        const tip = label + (span ? '\\n' + span : '') +
          '\\nno reply from these requests entered the conversation \\u2014 retries at the same history position' +
          '\\nclick to open the first failed wire pair';
        return '<a class="tturn terr-run" href="#/p/' + encodeURIComponent(list[0].pairId) + '" data-tip="' + escapeHtml(tip) + '">' +
          '<span class="rgut"><span class="cdot cdot-err"></span></span>' +
          '<span class="tturn-ord">wire</span>' +
          '<span class="tturn-text">' + escapeHtml(label) + '</span>' +
          '<span class="treq-mark err">err</span>' + trajNone + '</a>';
      };
      // A subagent spawned by this turn attaches HERE, as a branch off the
      // rail — label + outcome inline, the thread one click away (its
      // detached card disappears while this thread is the selected one).
      const branchRows = (turn) => {
        let out = '';
        for (const b of turn.blocks || []) {
          if (!b || b.type !== 'tool_use' || !SPAWN_TOOLS[b.name] || !b.id) continue;
          const m = agentThreadMeta[b.id];
          if (!m) continue;
          out += '<a class="tbranch" href="' + threadHash(m.t.key) + '"' +
            ' data-tip="' + escapeHtml(threadTitle(m.t) + '\\n---\\n> click to open this subagent thread') + '">' +
            '<span class="rgut rgut-br"></span>' +
            '<span class="tbranch-label">' + escapeHtml(m.t.label || 'subagent') + '</span>' +
            (m.t.model ? '<span class="tbranch-model">' + escapeHtml(shortModel(m.t.model)) + '</span>' : '') +
            '<span class="tbranch-stat">' + escapeHtml(m.stats || '') + '</span></a>';
        }
        return out;
      };
      // Working-loop grouping (loopTurns): the outline's TURN is the human
      // unit — user request, agent work nested under it, final response —
      // not one wire message. Ordinals number loops; member rows indent.
      const loops = loopTurns(vis);
      const linfo = {};
      const loopSize = {};  // member rows a folded head hides
      const loopSteps = {}; // steps (wire requests) per loop, for "of N"
      for (let li = 0; li < loops.length; li++) {
        const L = loops[li];
        loopSize[li] = L.members.length;
        loopSteps[li] = L.stepCount || 0;
        if (L.head != null) linfo[L.head] = { ord: li, kind: 'head', injected: L.headInjected || '' };
        for (let mi = 0; mi < L.members.length; mi++) {
          const v = L.members[mi];
          linfo[v] = {
            ord: li,
            kind: v === L.final ? 'final' : 'mid',
            injected: L.injected[v] || '',
            // step = this assistant message's 1-based position in the
            // loop's agentic cycle (one step = one wire request)
            step: (L.steps && L.steps[v]) || 0,
            // a headless loop (thread cut mid-history) shows its ordinal on
            // its first row so the numbering never skips silently
            lead: L.head == null && mi === 0,
          };
        }
      }
      // Per-step outcomes need the tool results that answered each step's
      // tool calls — they live in the (hidden) result-only turns.
      const toolRes = buildToolResultIndex(t.turns);
      // ---- the trajectory gutter ----
      // dsh's Trajectory tab reads the agent's path as a shape; the rail is
      // already that path in cctrace, it just carried no magnitude. One
      // track per step: width = how full the window was, split into the
      // prefix READ FROM CACHE (green) and what was billed fresh (amber).
      // Stacked down the rail it IS the trajectory — context climbs, a
      // \u2702 row drops it, the step after a boundary is all-amber (cold),
      // then green again. Every number is provider-reported; nothing here
      // is estimated.
      // Denominator: the model's context window when models.dev knows it,
      // else this thread's own peak — named in each hover, so the bar never
      // implies a figure the wire didn't state.
      const trajPeak = ctxThreadStat(t).peak;
      let trajWin = ctxWindowOf(t);
      // A prompt larger than the resolved window proves the window wrong
      // (same guard as the context view) \u2014 fall back to the peak.
      if (trajWin && trajPeak > trajWin) trajWin = 0;
      const trajDen = trajWin || trajPeak;
      const trajNone = '<span class="tctx tctx-none"></span>';
      const trajBar = (u, failed) => {
        // Nothing to measure -> the invisible SPACER, never an empty
        // outlined track. A bordered pill with no fill is a bar claiming a
        // measurement it does not have (TASTE 2026-07-28: what does this
        // surface CLAIM vs what does it KNOW), and on a real trace 36 of
        // 141 tracks were exactly that. The spacer still holds the column,
        // so the rail's rhythm does not break — which is the whole reason
        // the class exists.
        if (!trajDen || failed || !u) return trajNone;
        const tot = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
        if (!tot) return trajNone;
        const w = Math.max(3, Math.min(100, (tot / trajDen) * 100));
        const c = Math.round(((u.cacheRead || 0) / tot) * 100);
        return '<span class="tctx"><span class="tctx-b" style="width:' + w.toFixed(1) + '%">' +
          (c > 0 ? '<span class="tctx-c" style="width:' + c + '%"></span>' : '') +
          (c < 100 ? '<span class="tctx-f" style="width:' + (100 - c) + '%"></span>' : '') +
          '</span></span>';
      };
      const trajLine = (u) => {
        const tot = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
        if (!tot) return '';
        return 'context ' + fmtCompact(tot) +
          (trajDen ? ' \u00b7 ' + Math.round((tot / trajDen) * 100) + '% of ' +
            (trajWin ? 'a ' + fmtCompact(trajWin) + ' window' : 'this thread\u2019s peak') : '');
      };
      // Wall-clock per visible turn for the row hovers — user heads inherit
      // the time of the request that carried them (turnTimes).
      const vts = turnTimes(vis);
      const vtsLine = (vi) => vts[vi] ? '\\n' + fmtDateTime(new Date(vts[vi] * 1000)) : '';
      // Ordinals render BARE and 1-based ("01") — the word "turn" repeated
      // down the rail is noise, and humans count exchanges from 1, so the
      // last label agrees with the "N turns" counts. Prose surfaces (hover,
      // convo role bar) spell "turn 01"; the number is the shared key.
      const ordFmt = (n) => { const v = n + 1; return v < 10 ? '0' + v : '' + v; };
      let html = '';
      for (let ei = 0; ei < eps.length; ei++) {
        const e = eps[ei];
        if (multi) html += epochHead(t, e, ei);
        for (let vi = e.from; vi <= e.to && vi < vis.length; vi++) {
          if (compAt[vi]) for (const c of compAt[vi]) html += compRow(c);
          if (supAt[vi]) for (const pid of supAt[vi]) html += supRow(pid, vi);
          if (errAt[vi]) html += errRow(errAt[vi]);
          const turn = vis[vi];
          const li = linfo[vi] || { ord: null, kind: 'mid' };
          // A folded loop (❯ gutter click) hides its member rows — the
          // head line stays with a "⋯ N" count; truth markers (compact/
          // superseded/failed rows) above never fold away.
          const folded = li.ord != null && foldedTurns[t.key + '#' + li.ord];
          if (folded && li.kind !== 'head' && !li.lead) continue;
          const ord = li.ord != null ? ordFmt(li.ord) : '?';
          // Steps carry a sub-ordinal in the same cell — a faint ".2" under
          // the head's "01" reads as 01.2, addressing each wire request
          // without repeating the turn number down the rail.
          const ordLabel = li.kind === 'head' || li.lead ? ord
            : li.kind === 'final' ? '\\u21b3'
            : li.step ? '.' + li.step : '';
          const rowCls = (li.kind === 'head' || li.lead ? ' tturn-head' : '') +
            (li.kind === 'head' ? ' tturn-user'
            : ' tturn-sub' + (li.kind === 'mid' ? ' tturn-mid' : ' tturn-fin'));
          // The tooltip leads with the FULL text the row had to truncate;
          // a divider, then metrics, then faint click hints — hover answers
          // "what does the rest say" first, "what can I do" last.
          const foldHint = '> click \\u276F to ' + (folded ? 'unfold' : 'fold') + ' this turn\\u2019s work';
          let text = '';
          let dot = '';
          let tip = '';
          let errMark = '';
          let traj = trajNone;   // the trajectory gutter; blank on non-wire rows
          if (turn.role === 'assistant') {
            let raw = '';
            for (const b of turn.blocks || []) {
              if (b && b.type === 'text' && b.text) { raw = String(b.text); break; }
            }
            text = raw ? escapeHtml(raw.slice(0, 120)) : '';
            if (!text) {
              const tl = turnToolLabel(turn); // pre-escaped HTML (.tname spans)
              text = '<span class="tturn-tools">' + (tl ? tl
                : (turn.blocks || []).some(b => b && b.type === 'thinking' && b.thinking) ? 'thinking\\u2026'
                : '(no text)') + '</span>';
            }
            const u = turn.usage;
            const p = turn.pairId ? pairOf(turn.pairId) : null;
            // The dot leads the row — a status gutter. Assistant dots carry
            // the wire verdict: red = failed request, green = healthy cache
            // hit, amber = weak hit / cold / miss, neutral = no cache in
            // play or unattributed. The row shows the MESSAGE; every metric
            // (tokens, cost, ttft, duration, folded) lives in the hover —
            // inline numbers were fighting the text for the same pixels.
            const failed = p && (!p.response || p.response.status >= 400);
            const cc = u && p ? summarizeCache(u, p.request.body, isNewestModelPair(p) ? pairEndMs(p) : null) : null;
            dot = '<span class="cdot' + (failed ? ' cdot-err' : cc ? (cc.c === 'ok' ? ' cdot-hit' : ' cdot-warn') : '') + '"></span>';
            // Step outcome: tool calls this step made whose folded results
            // came back is_error — a failed step is state, not chrome.
            let stepErrs = 0;
            for (const b of turn.blocks || []) {
              if (b && b.type === 'tool_use' && b.id && toolRes[b.id] && toolRes[b.id].is_error) stepErrs++;
            }
            if (stepErrs) errMark = '<span class="tturn-terr">tool err</span>';
            traj = trajBar(u, failed);
            const tbits = [];
            if (raw.length > 120) tbits.push(raw.slice(0, 600) + (raw.length > 600 ? '\\u2026' : ''), '---');
            // The heading names the node in the tree: a step is one wire
            // request of the loop; the final response is its last step.
            tbits.push('turn ' + ord +
              (li.kind === 'final'
                ? ' \\u00b7 final response' + (li.step > 1 ? ' \\u00b7 step ' + li.step + ' of ' + (loopSteps[li.ord] || li.step) : '')
                : li.step ? ' \\u00b7 step ' + li.step + ' of ' + (loopSteps[li.ord] || li.step) : ' \\u00b7 agent work') +
              (u && u.model ? ' \\u00b7 ' + shortModel(u.model) : ''));
            if (p) tbits.push(fmtDateTime(new Date(p.request.timestamp * 1000)));
            if (u) {
              let l = 'in ' + fmtCompact(u.input) + ' \\u00b7 out ' + fmtCompact(u.output);
              const c = pairCost(u);
              if (c && c.total > 0) l += ' \\u00b7 ' + fmtCost(c.total);
              tbits.push(l);
            }
            if (p) {
              let l = formatDuration(p.duration);
              if (p.response && typeof p.response.firstTokenMs === 'number') l = 'ttft ' + fmtMs(p.response.firstTokenMs) + ' \\u00b7 ' + l + ' total';
              tbits.push(l);
            }
            if (u && !failed) { const tj = trajLine(u); if (tj) tbits.push(tj); }
            // The final's stop is a wire fact, not an inference: end_turn is
            // a finished response; tool_use here means the loop was cut
            // mid-work and this "final" is just the last reply captured.
            if (li.kind === 'final' && p && !failed) {
              const ci = p._ci || (p._ci = extractCallInfo(p));
              if (ci && ci.stopReason) tbits.push(
                ci.stopReason === 'tool_use'
                  ? 'stop: tool_use \\u2014 the loop was cut mid-work; this is the last reply, not a finished response'
                  : 'stop: ' + ci.stopReason);
            }
            if (stepErrs) tbits.push(stepErrs + ' tool call' + (stepErrs === 1 ? '' : 's') + ' this step returned an error');
            if (failed) tbits.push('request FAILED: no response or HTTP error \\u2014 see the wire pair');
            if (cc) tbits.push(cc.title);
            if (cc && cc.expiresAt && Date.now() > cc.expiresAt) tbits.push('cache EXPIRED \u2014 resuming this session now re-writes the prefix at write price');
            if (p && p.request.body && p.request.body._cctrace_stub) tbits.push('request body folded by cctrace compact \\u2014 the kept request holds the full history');
            if (!p) tbits.push('unattributed \\u2014 no captured request matches this reply');
            tip = tbits.join('\\n') + '\\n---\\n> click to jump to this turn' + (li.lead ? '\\n' + foldHint : '');
          } else if (li.injected) {
            // A user-ROLE wire message the harness generated (recap, tool
            // load, automated notification) — it must never read as the
            // human speaking. Notifications still head their turn (they
            // start real agent work), but as a CLI-authored one. The SYS
            // tag is the one system-scope marker, shared with the convo.
            let s = turnSnippet(turn.blocks) || firstUserText(turn.blocks);
            if (!s) {
              // reminder-only messages snippet to "" (turnSnippet strips
              // <system-reminder>) — preview the reminder text itself
              const tb = (turn.blocks || []).find(b => b && b.type === 'text' && b.text);
              s = tb ? String(tb.text).replace(/<\\/?system-reminder>/g, '').trim() : '';
            }
            text = '<span class="sys-tag">' + escapeHtml(li.injected) + '</span>' +
              '<span class="tturn-tools">' + escapeHtml(s.slice(0, 90)) + '</span>';
            dot = '<span class="cdot"></span>';
            tip = s.slice(0, 600) + (s.length > 600 ? '\\u2026' : '') + '\\n---\\n' +
              'turn ' + ord + ' \\u00b7 harness-injected prompt (' + li.injected + ')' + vtsLine(vi) + '\\n' +
              'sent with role \\u201cuser\\u201d by the Claude Code CLI itself, not typed by the human' +
              '\\n---\\n> click to jump to this turn' + (li.kind === 'head' ? '\\n' + foldHint : '');
          } else if (sumVisAt[vi] || continuationSummaryTurn(turn.blocks)) {
            // The auto recap: /compact (or a session resume) injected this
            // user-role summary as the model's entire memory of the
            // conversation above. It heads its turn — it does start real
            // agent work — but it is harness-authored, never the human's ❯.
            const s = turnSnippet(turn.blocks) || firstUserText(turn.blocks);
            text = '<span class="sys-tag">recap</span>' +
              '<span class="tturn-tools">' + escapeHtml(s.slice(0, 90)) + '</span>';
            dot = '<span class="cdot"></span>';
            tip = s.slice(0, 600) + (s.length > 600 ? '\\u2026' : '') + '\\n---\\n' +
              'turn ' + ord + ' \\u00b7 auto recap (continuation summary)' + vtsLine(vi) + '\\n' +
              'injected by the harness as the model\\u2019s entire memory of the conversation above \\u2014 not typed by the human' +
              '\\n---\\n> click to jump to this turn' + (li.kind === 'head' ? '\\n' + foldHint : '');
          } else {
            const s = turnSnippet(turn.blocks) || firstUserText(turn.blocks);
            text = escapeHtml(s.slice(0, 120));
            dot = '<span class="gut-user">\\u276F</span>'; // the human's prompt
            tip = s.slice(0, 600) + (s.length > 600 ? '\\u2026' : '') + '\\n---\\n' +
              'turn ' + ord + ' \\u00b7 user prompt' + vtsLine(vi) + '\\n---\\n> click to jump to this turn\\n' + foldHint;
          }
          const hidN = folded ? loopSize[li.ord] - (li.kind === 'head' ? 0 : 1) : 0;
          const foldN = hidN > 0 ? '<span class="tturn-fold-n" title="' + hidN + ' agent message' + (hidN === 1 ? '' : 's') + ' folded \\u2014 click \\u276F to unfold">\\u22ef ' + hidN + '</span>' : '';
          // The gutter is the fold toggle on head rows — hovering the
          // symbol itself explains the symbol, not the whole row.
          const canFold = li.ord != null && (li.kind === 'head' || li.lead);
          const gutTip = canFold
            ? ' data-tip="' + escapeHtml('fold toggle\\n' +
                (folded ? 'this turn\\u2019s agent work is folded under the prompt line'
                  : 'collapses this turn\\u2019s agent work under the prompt line') +
                '\\n---\\n> click to ' + (folded ? 'unfold' : 'fold')) + '"'
            : '';
          html += '<a class="tturn' + rowCls + '" href="' + threadHash(t.key) + '"' +
            ' data-key="' + escapeHtml(t.key) + '" data-turn="' + vi + '"' +
            (canFold ? ' data-fold="' + li.ord + '"' : '') +
            ' data-tip="' + escapeHtml(tip) + '">' +
            '<span class="rgut"' + gutTip + '>' + dot + '</span>' +
            '<span class="tturn-ord' + (li.kind === 'mid' && li.step ? ' tturn-sord' : '') + '">' + ordLabel + '</span>' +
            '<span class="tturn-text">' + text + '</span>' + errMark + foldN + traj + '</a>';
          if (turn.role === 'assistant' && !folded) html += branchRows(turn);
        }
      }
      // boundary rows / superseded exchanges / error runs whose position
      // lands past the last turn (clamped) render at the tail — still in
      // timeline order.
      const lastVi = vis.length;
      if (compAt[lastVi]) for (const c of compAt[lastVi]) html += compRow(c);
      if (supAt[lastVi]) for (const pid of supAt[lastVi]) html += supRow(pid, lastVi - 1 >= 0 ? lastVi - 1 : 0);
      if (errAt[lastVi]) html += errRow(errAt[lastVi]);
      return '<div class="thread-turns">' + html + '</div>';
    }

    // Spelled-out hover summary for a thread: what it is, when it ran,
    // what it used, what went wrong.
    function threadTitle(t) {
      const u = t.usage || {};
      const bits = [t.kind + (t.label ? ' \\u00b7 ' + t.label : '')];
      if (t.firstAt) {
        bits.push(fmtDateTime(new Date(t.firstAt * 1000)) +
          (t.lastAt && t.lastAt !== t.firstAt ? ' \\u2013 ' + fmtTime(new Date(t.lastAt * 1000)) : ''));
      }
      bits.push(u.requests + ' req \\u00b7 in ' + fmtCompact(u.input || 0) + ' \\u00b7 out ' + fmtCompact(u.output || 0) +
        (u.cacheRead ? ' \\u00b7 cache \\u2193' + fmtCompact(u.cacheRead) : ''));
      if (u.cost) bits.push('est. cost ' + fmtCost(u.cost));
      const mt = modelTitle(t);
      if (mt) bits.push('models:\\n' + mt);
      else if (t.model) bits.push('model ' + shortModel(t.model));
      const et = errTitle(u);
      if (et) bits.push(et);
      return bits.join('\\n');
    }

    function threadCard(t, selected, nested) {
      return '<div class="thread' + (selected ? ' selected' : '') + '">' +
        '<a class="thread-head" href="' + threadHash(t.key) + '" data-tip="' + escapeHtml(threadTitle(t)) + '">' +
          '<span class="tkind tkind-' + t.kind + '">' + t.kind + '</span>' +
          '<span class="thread-label">' + escapeHtml(t.label) + '</span>' +
          modelChip(t) +
        '</a>' +
        (selected ? epochTurnList(t) : epochRows(t)) + threadMeta(t, nested) + '</div>';
    }

    // Per-model breakdown for a thread's tooltip — one line per model when
    // /model switched mid-thread, undefined for the single-model case.
    function modelTitle(t) {
      const keys = Object.keys(t.models || {});
      if (keys.length < 2) return undefined;
      return keys.map(m => shortModel(m) + ': ' + t.models[m].requests + ' req \\u00b7 out ' + fmtCompact(t.models[m].output) +
        (t.models[m].cost ? ' \\u00b7 ' + fmtCost(t.models[m].cost) : '')).join('\\n');
    }

    // The model as an attribute chip, right-aligned on the thread card —
    // never part of the thread's identity (a thread is a conversation; it
    // can span models). "+N" marks mid-thread switches.
    // Wire-level model config for a thread's hover: exact ids, the effort
    // level(s) requested, 1m-context beta. Read from the thread's own
    // pairs (capped scan) — facts the wire states, never inferred.
    function threadWireFacts(t) {
      const effs = [];
      const seen = {};
      let ctx1m = false;
      let scanned = 0;
      for (const turn of t.turns || []) {
        if (!turn.pairId) continue;
        if (++scanned > 80) break;
        const p = pairOf(turn.pairId);
        if (!p || !p.request) continue;
        const e = extractEffort(p.request.body);
        if (e && !seen[e.v]) { seen[e.v] = 1; effs.push(e.v); }
        if (!ctx1m && String((p.request.headers || {})['anthropic-beta'] || '').indexOf('context-1m') !== -1) ctx1m = true;
      }
      return { effs, ctx1m };
    }

    function modelChip(t) {
      if (!t.model) return '';
      const extra = Math.max(0, Object.keys(t.models || {}).length - 1);
      const mt = modelTitle(t);
      const ids = Object.keys(t.models || {});
      const wf = threadWireFacts(t);
      const tip = 'model ' + shortModel(t.model) + (extra ? ' (+' + extra + ' via /model)' : '') +
        (ids.length ? '\\nexact: ' + ids.join(', ') : '') +
        (wf.effs.length ? '\\neffort: ' + wf.effs.join(' / ') : '') +
        (wf.ctx1m ? '\\ncontext: 1m (anthropic-beta context-1m)' : '') +
        '\\nprimary = most output tokens, never last-used' +
        (mt ? '\\n\\n' + mt : '');
      return '<span class="tmodel" data-tip="' + escapeHtml(tip) + '">' +
        escapeHtml(shortModel(t.model)) + (extra ? ' +' + extra : '') + '</span>';
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
    function sessionSummary(threads, sessionCount) {
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
      if (sessionCount > 1) bits.unshift(sessionCount + ' sessions');
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

    // Session-fold state must survive live re-renders — keyed by sid, not
    // positionally (sections can appear mid-run). Unset = default (newest
    // session and the selection's session open, the rest collapsed).
    const sessOpen = {};
    // Outline turns folded via the ❯ gutter — keyed by thread key + loop
    // ordinal so live re-renders (and thread switches back and forth)
    // keep what the user collapsed.
    const foldedTurns = {};

    // Was the stage up on the LAST render? Entering replay drops one at the
    // top of a column the reader may have scrolled deep into (focusThreadsPane
    // lands on the selected thread), so the first render with a stage lands on
    // it. Every later render keeps the reader's scroll — the stage is a
    // document region, not floating chrome.
    let stageWasUp = false;

    function renderThreadsPane(threads, sel) {
      const card = (t, nested) => {
        try { return threadCard(t, t.key === sel.key, nested); }
        catch (e) { return brokenItem('thread', t && t.key, e); }
      };
      // Deterministic card order: conversation start time, key as the
      // tie-break — never wire push order, which shuffles on merged
      // multi-run traces and long-running subagents.
      const byStart = (a, b) => (a.firstAt || a.lastAt || 0) - (b.firstAt || b.lastAt || 0) ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      const section = (list, face) => {
        // A subagent nests under the thread that dispatched it — ALWAYS,
        // so a card never jumps between "sibling" and "hidden" as the
        // selection moves (the outline's branch row marks the spawn's
        // timeline position; the nested card is the thread's home).
        // face = the absorbed chat whose card is the session header:
        // its subagents render as the section's first block.
        const byKey = {};
        for (const t of list) byKey[t.key] = 1;
        if (face) byKey[face.key] = 1;
        const isChild = (t) => t.kind !== 'utility' && t.agentOf &&
          t.agentOf.thread !== t.key && byKey[t.agentOf.thread];
        const kids = {};
        for (const t of list) if (isChild(t)) (kids[t.agentOf.thread] = kids[t.agentOf.thread] || []).push(t);
        const kidBlock = (key) => {
          const ch = (kids[key] || []).sort(byStart);
          if (!ch.length) return '';
          let inner = '';
          for (const t of ch) inner += card(t, true);
          return '<div class="tkids">' + inner + '</div>';
        };
        const tops = list.filter(t => t.kind !== 'utility' && !isChild(t)).sort(byStart);
        const utils = list.filter(t => t.kind === 'utility').sort(byStart);
        let out = face ? kidBlock(face.key) : '';
        for (const t of tops) out += card(t) + kidBlock(t.key);
        if (utils.length) {
          let inner = '';
          for (const t of utils) inner += card(t);
          out += fold('utility \\u00b7 ' + utils.length, 'probes, title generation', inner, 'box', utils.some(t => t.key === sel.key));
        }
        return out;
      };
      // The sessions layer: threads grouped by wire session id, newest
      // activity first. A single-session trace renders with ZERO new chrome
      // — exactly the flat pane (the common case pays nothing).
      const sids = [];
      const bySid = {};
      for (const t of threads) {
        const sid = t.sessionId || '';
        if (!bySid[sid]) { bySid[sid] = []; sids.push(sid); }
        bySid[sid].push(t);
      }
      // The stage sits ABOVE the rail while replaying: the strip is the time
      // navigation, the stage is where/what, the rail is still the outline.
      let html = stageHtml() + sessionSummary(threads, sids.length);
      {
        // EVERY trace renders the sessions layer — a single-session trace
        // is one open container (2026-07-20 round 5: the old flat mode
        // showed a redundant "[chat] N turns" card where the session
        // header says it better; the absorbed container IS the compact
        // view).
        const lastAt = (g) => Math.max.apply(null, g.map(t => t.lastAt || t.firstAt || 0));
        // Newest activity first, sid as the tie-break — ties must not let
        // two sessions swap places between live re-renders.
        sids.sort((a, b) => lastAt(bySid[b]) - lastAt(bySid[a]) || (a < b ? -1 : a > b ? 1 : 0));
        for (let i = 0; i < sids.length; i++) {
          const sid = sids[i];
          const g = bySid[sid];
          const hasSel = g.some(t => t.key === sel.key);
          const open = sid in sessOpen ? sessOpen[sid] : (i === 0 || hasSel);
          // A container with exactly one chat collapses into its parent
          // (session-tab design): the session header absorbs the chat card
          // — "session → chat" said the same thing twice, and /clear
          // rotates the sid, so one-chat sessions ARE the common case.
          // Epochs, the request list, and agent/utility threads hang
          // directly under the header; clicking the header selects the
          // chat (clicking again folds).
          const chats = g.filter(t => t.kind === 'chat');
          const face = chats.length === 1 ? chats[0] : null;
          const body = face
            ? (face.key === sel.key ? epochTurnList(face) : epochRows(face)) + section(g.filter(t => t !== face), face)
            : section(g);
          // Selection emphasis lives on the SESSION container — the active
          // conversation's home; the thread inside marks itself quietly.
          html += '<details class="sess' + (hasSel ? ' selected' : '') + '" data-sid="' + escapeHtml(sid) + '"' + (open ? ' open' : '') + '>' +
            '<summary' + (face ? ' data-goto="' + escapeHtml(face.key) + '"' : '') + ' data-tip="' + escapeHtml(sessTitle(sid, g)) + '">' +
            sessHeader(sid, g, face) + '</summary>' + body + '</details>';
        }
      }
      const top = threadsEl.scrollTop; // live re-renders must not move the list
      threadsEl.innerHTML = html;
      threadsEl.scrollTop = replay.active && !stageWasUp ? 0 : top;
      stageWasUp = replay.active;
      tipDetachedGuard(); // the hovered row may have just been replaced
      for (const d of threadsEl.querySelectorAll('details.sess')) {
        d.addEventListener('toggle', () => { sessOpen[d.dataset.sid] = d.open; });
        const sum = d.querySelector(':scope > summary');
        if (sum && sum.dataset.goto) sum.addEventListener('click', (e) => {
          // First click on an absorbed session selects its chat (and opens
          // the fold); once selected, clicks toggle the fold as usual.
          if (sum.dataset.goto !== sel.key) {
            e.preventDefault();
            sessOpen[d.dataset.sid] = true;
            location.hash = threadHash(sum.dataset.goto);
          }
        });
      }
      for (const a of threadsEl.querySelectorAll('a.tepoch[data-key], a.tturn[data-key]')) {
        a.addEventListener('click', (e) => {
          // The ❯ gutter on a turn head is the fold toggle; the rest of the
          // row jumps. One row, two targets — like a tree view.
          if (a.dataset.fold != null && e.target && e.target.closest && e.target.closest('.rgut')) {
            e.preventDefault();
            e.stopPropagation();
            const k = a.dataset.key + '#' + a.dataset.fold;
            foldedTurns[k] = !foldedTurns[k];
            showSession(sessionSelKey);
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          jumpToTurn(a.dataset.key, +a.dataset.turn);
        });
      }
    }

    // Epoch/turn row click: select the thread (if needed) and scroll the
    // convo pane to that visible turn. Scroll math is done against the
    // pane's own scrollTop — scrollIntoView proved unreliable for targets
    // deep in the pane (it consults offset parents this layout doesn't
    // guarantee), which broke jumps beyond the first epoch.
    function jumpToTurn(key, vis) {
      if (sessionSelKey !== key) {
        history.replaceState(null, '', threadHash(key));
        showSession(key);
      }
      const el = convoEl.querySelectorAll('.turn')[vis];
      if (el) {
        convoScrollTo(convoEl.scrollTop + el.getBoundingClientRect().top - convoEl.getBoundingClientRect().top - 8);
        tailPill.classList.remove('show');
      }
    }

    // Reverse of the spawn fold's "open thread →": from a subagent back to
    // the exact turn in its parent that dispatched it. Falls back to the
    // parent's head when the spawn tool_use isn't in the reconstruction
    // (a cross-run merge can lose the dispatching request).
    window.jumpToParent = function (ev, el) {
      ev.preventDefault();
      ev.stopPropagation();
      const key = el.dataset.key || '';
      const tuid = el.dataset.tuid || '';
      const parent = getThreads().find(t => t.key === key);
      if (!parent) return false;
      let vi = -1;
      if (tuid) {
        const vis = (parent.turns || []).filter(x => !x.toolResultsOnly);
        for (let i = 0; i < vis.length && vi < 0; i++) {
          for (const b of (vis[i].blocks || [])) {
            if (b && (b.type === 'tool_use' || b.type === 'server_tool_use') && b.id === tuid) { vi = i; break; }
          }
        }
      }
      if (vi >= 0) jumpToTurn(key, vi);
      else { history.replaceState(null, '', threadHash(key)); showSession(key); }
      return false;
    };

    // Spelled-out hover summary for a session section: full id, when it
    // ran, and totals across its threads.
    function sessTitle(sid, g) {
      let t0 = Infinity, t1 = 0, req = 0, inTok = 0, outTok = 0, cost = 0, turns = 0;
      const errs = { wireErrors: 0, truncated: 0, toolErrors: 0, toolUses: 0 };
      const models = {};
      for (const t of g) {
        if (t.firstAt) t0 = Math.min(t0, t.firstAt);
        t1 = Math.max(t1, t.lastAt || t.firstAt || 0);
        const u = t.usage || {};
        req += u.requests || 0;
        inTok += u.input || 0;
        outTok += u.output || 0;
        cost += u.cost || 0;
        errs.wireErrors += u.wireErrors || 0;
        errs.truncated += u.truncated || 0;
        errs.toolErrors += u.toolErrors || 0;
        errs.toolUses += u.toolUses || 0;
        if (t.kind !== 'utility') turns += loopCountOf(t);
        for (const m in (t.models || {})) models[m] = 1;
      }
      const bits = ['session ' + (sid || '(no id on the wire)')];
      if (t0 !== Infinity) {
        bits.push(fmtDateTime(new Date(t0 * 1000)) + (t1 && t1 !== t0 ? ' \\u2013 ' + fmtTime(new Date(t1 * 1000)) : ''));
      }
      bits.push(g.length + ' thread' + (g.length === 1 ? '' : 's') + ' \\u00b7 ' + turns + ' turns \\u00b7 ' + req + ' req');
      bits.push('in ' + fmtCompact(inTok) + ' \\u00b7 out ' + fmtCompact(outTok) + (cost ? ' \\u00b7 est. ' + fmtCost(cost) : ''));
      const mk = Object.keys(models);
      if (mk.length) bits.push('models: ' + mk.map(shortModel).join(', '));
      const et = errTitle(errs);
      if (et) bits.push(et);
      return bits.join('\\n') + (sid ? '\\n---\\n> click the id to copy it' : '');
    }

    // Session card header — same visual grammar as a thread card, one level
    // up: identity on the left (short sid, click = copy full, plus the
    // conversation size), quiet attributes right-aligned (time range,
    // request count, errors). No "session" word — the box IS the session.
    // face = the absorbed chat when the session holds exactly one: its
    // model chip joins the header, since the header now IS the chat's card.
    function sessHeader(sid, g, face) {
      let t0 = Infinity, t1 = 0, req = 0, errs = 0, turns = 0;
      for (const t of g) {
        if (t.firstAt) t0 = Math.min(t0, t.firstAt);
        t1 = Math.max(t1, t.lastAt || t.firstAt || 0);
        const u = t.usage || {};
        req += u.requests || 0;
        errs += (u.wireErrors || 0) + (u.toolErrors || 0) + (u.truncated || 0);
        if (t.kind !== 'utility') turns += loopCountOf(t);
      }
      // HH:MM only — seconds are noise at the session level; a
      // single-moment session shows one time, not a degenerate range.
      const hm = (ts) => fmtTime(new Date(ts * 1000)).slice(0, 5);
      const range = t0 === Infinity ? '' : (hm(t0) === hm(t1) ? hm(t0) : hm(t0) + '\\u2013' + hm(t1));
      return ICON_SESSION + '<span class="klabel">session</span>' +
        '<span class="sess-sid" data-mask="sid"' +
        (sid ? ' data-sid="' + escapeHtml(sid) + '"' +
          ' onclick="copySessSid(event, this)"' : '') +
        '>' + (sid ? escapeHtml(sid.slice(0, 8)) : 'no session id') + '</span>' +
        '<span class="sess-turns">' + turns + ' turn' + (turns === 1 ? '' : 's') + '</span>' +
        (face ? modelChip(face) : '') +
        '<span class="sess-attrs">' + (range ? range + ' \\u00b7 ' : '') + req + ' req' +
          (errs ? ' \\u00b7 <span class="err">' + errs + ' err</span>' : '') + '</span>';
    }

    // Focus hierarchy: EVERY tool_use folds to one line — on real sessions
    // the old "mutating tools render expanded" rule buried the conversation
    // under Read/Bash output. What stays visually distinct (purple title,
    // still folded) are the notable events: subagent spawns (with a jump
    // link to the reconstructed thread), skill invocations, and MCP calls.
    const SPAWN_TOOLS = { Task: 1, Agent: 1, TaskCreate: 1 };

    // tool_use id -> subagent thread key / one-line stats, rebuilt on each
    // session render (the stats line puts the spawned thread's outcome on
    // the fold itself — what it cost is visible without opening anything).
    let agentThreadIndex = {};
    let agentThreadStats = {};
    let agentThreadMeta = {};

    function renderBlockS(b, results, md) {
      if (b && (b.type === 'tool_use' || b.type === 'server_tool_use')) {
        const name = b.name || '?';
        let title = name;
        let pv = toolPreview(name, b.input, wsRoot()) || snippet(b.input, 110);
        let cls = '';
        let extra = '';
        let icon = '';
        const inp = b.input || {};
        // Spawn shape only — task-tracking TaskCreate {subject} is a plain
        // tool fold, not a "subagent" title with no thread behind it.
        if (SPAWN_TOOLS[name] && (inp.subagent_type || typeof inp.prompt === 'string')) {
          title = 'subagent';
          cls = 'fold-agent';
          icon = ICON_EPOCH;
          const dest = b.id && agentThreadIndex[b.id];
          const stat = b.id && agentThreadStats[b.id];
          if (stat) extra += '<span class="fold-stat">' + escapeHtml(stat) + '</span>';
          if (dest) {
            extra += '<a class="fold-link" href="' + threadHash(dest) + '"' +
              ' onclick="event.stopPropagation()" title="open the reconstructed subagent thread">open thread \\u2192</a>';
          }
        } else if (name === 'Skill') {
          const i = b.input || {};
          title = 'skill' + (i.skill || i.command ? ' \\u00b7 ' + (i.skill || i.command) : '');
          pv = typeof i.args === 'string' && i.args ? i.args : '';
          cls = 'fold-skill';
          icon = ICON_SKILL;
        } else if (name.lastIndexOf('mcp__', 0) === 0) {
          title = 'mcp \\u00b7 ' + name.slice(5).split('__').join(' \\u00b7 ');
          cls = 'fold-mcp';
          icon = ICON_MCP;
        } else {
          // Plain tool: ToolName(args) — colored name (.fold-tool title),
          // the preview parenthesized as its arguments.
          cls = 'fold-tool';
          if (pv) pv = '(' + pv + ')';
        }
        let body = '';
        const rich = b.name === 'ExitPlanMode' && b.input && typeof b.input.plan === 'string'
          ? '<div class="mdplan msg-md">' + renderMd(b.input.plan) + '</div>'
          : richToolBody(b.name, b.input);
        if (rich) {
          body = rich + '<details class="rawin"><summary>raw input</summary>' + preBlock(formatJson(b.input)) + '</details>';
        } else {
          body = preBlock(formatJson(b.input));
        }
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
        return fold(title, pv, body, cls, false, extra, icon);
      }
      return renderBlock(b, md);
    }

    function renderSessionTurn(turn, results, ord, isSummary, stepLbl, ts) {
      let inner = '';
      for (const b of turn.blocks) inner += renderBlockS(b, results, turn.role === 'assistant');
      let meta = '';
      if (turn.role === 'assistant' && turn.usage) {
        const u = turn.usage;
        const p = turn.pairId ? pairOf(turn.pairId) : null;
        const bits = [];
        // Every attributed reply names its model — with /model switches the
        // set is the story, and the epoch divider marks where it changes.
        if (u.model) bits.push(escapeHtml(shortModel(u.model)));
        bits.push('in ' + fmtCompact(u.input));
        bits.push('out ' + fmtCompact(u.output));
        if (u.cacheRead) bits.push('cache ' + fmtCompact(u.cacheRead));
        const c = pairCost(u);
        if (c && c.total > 0) bits.push(escapeHtml(fmtCost(c.total)));
        if (p) bits.push(formatDuration(p.duration));
        if (p && p.response && typeof p.response.firstTokenMs === 'number')
          bits.push('ttft ' + fmtMs(p.response.firstTokenMs));
        // The step's own tool / wait time (threadTimeSplit): the gap from
        // this reply's end to the working loop's next request.
        const tsp = convoTime && turn.pairId ? convoTime.byPair[turn.pairId] : null;
        if (tsp && tsp.tools) bits.push('tools ' + fmtSpan(tsp.tools));
        else if (tsp && tsp.waiting) bits.push('waiting ' + fmtSpan(tsp.waiting));
        meta = '<span class="turn-usage">' + bits.join(' \\u00b7 ') + '</span>' +
          (turn.pairId ? '<a class="turn-wire" href="#/p/' + encodeURIComponent(turn.pairId) + '" title="open wire request">wire</a>' : '');
      } else if (turn.role === 'assistant' && !turn.pairId) {
        // Never silently blank (devlog 2026-07-17): an assistant turn we
        // could not tie to a wire request says so, quietly.
        meta = '<span class="turn-usage" title="no captured request matches this reply \\u2014 history was repacked or the reply was edited before it entered history">unattributed</span>';
      }
      // The ordinal ties the turn to the outline in the threads pane —
      // "03" there is "turn 03" here, one shared 1-based numbering; an
      // intermediate step carries its step address ("01.3") the same way.
      const ordHtml = ord != null ? '<span class="turn-ord">turn ' + (ord + 1 < 10 ? '0' + (ord + 1) : ord + 1) + '</span>'
        : stepLbl ? '<span class="turn-ord turn-sord">' + stepLbl + '</span>' : '';
      // The continuation summary is not a normal prompt — it's the text
      // /compact injected as the model's entire memory of the conversation
      // above. Tag it so nobody reads it as something the user typed.
      let tag = '';
      // Position-first (isSummary: the turn AT a rewrite-mode compact
      // boundary IS the injected summary — no string coupling); the
      // preamble check stays as a fallback for packings where the
      // boundary wasn't computable (e.g. a post-compact spine). Via
      // turnSnippet, not firstUserText: the continuation message often
      // opens with a <local-command-caveat> wrapper only it skips.
      if (turn.role === 'user' && (isSummary || continuationSummaryTurn(turn.blocks))) {
        tag = '<span class="sum-tag" title="injected by /compact \\u2014 this text replaced the full history in the model\\u2019s context; it is not something the user typed">continuation summary</span>';
      } else if (turn.role === 'user') {
        // Same system scope as the continuation tag: harness-authored
        // user-role messages (recap, tool loads, notifications, reminder
        // nudges) carry a sys tag so they never read as the human speaking.
        const hk = harnessTurnKind(turn.blocks);
        if (hk) tag = '<span class="sum-tag" title="sent with role \\u201cuser\\u201d by the Claude Code CLI itself \\u2014 not typed by the human">' + escapeHtml(hk) + '</span>';
      }
      // Wall-clock closes the role bar (24h, hover = full date) — a user
      // turn's time is inherited from the request that carried it. Static
      // text computed at render, never a ticking surface.
      const timeHtml = ts
        ? '<span class="turn-time' + (meta ? '' : ' tt-solo') + '" title="' + fmtDateTime(new Date(ts * 1000)) + '">' + fmtTime(new Date(ts * 1000)) + '</span>'
        : '';
      // data-ts (ms) is the trajectory bar's sync hook: the reading marker
      // reads the topmost visible turn's time, a bar click walks these to
      // find the turn at an instant (replay-stage.md rev 4).
      return '<div class="turn turn-' + escapeHtml(String(turn.role)) + '"' + (ts ? ' data-ts="' + (ts * 1000) + '"' : '') + '>' +
        '<div class="turn-role">' + ordHtml + escapeHtml(String(turn.role)) + tag + meta + timeHtml + '</div>' + inner + '</div>';
    }

    // ---- Live tail ----
    // The conversation pane behaves like tail -f: opening a session live
    // (including a page refresh) lands on the newest turn, re-renders stick
    // to the bottom while you're there, and never yank the view while you're
    // reading history — new activity surfaces as a pill instead. Snapshots
    // open at the top: reviewing a finished session is reading, not tailing.
    let convoKey = null;   // thread key currently rendered in the convo pane
    let convoTime = null;  // threadTimeSplit of that thread (the role bars read it)
    const TAIL_SLACK = 60; // px from the bottom that still counts as tailing

    function convoAtBottom() {
      return convoEl.scrollHeight - convoEl.scrollTop - convoEl.clientHeight < TAIL_SLACK;
    }
    // User-initiated jumps animate (the one scroll the motion budget
    // allows); render-time tail sticking stays instant — animating every
    // live append would be constant motion.
    const REDUCED_MOTION = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    function convoScrollTo(top) {
      if (convoEl.scrollTo && !REDUCED_MOTION) convoEl.scrollTo({ top, behavior: 'smooth' });
      else convoEl.scrollTop = top;
    }
    function convoToBottom() {
      convoEl.scrollTop = convoEl.scrollHeight;
      tailPill.classList.remove('show');
    }
    tailPill.onclick = () => {
      convoScrollTo(convoEl.scrollHeight);
      tailPill.classList.remove('show');
    };
    convoEl.addEventListener('scroll', () => {
      if (convoAtBottom()) tailPill.classList.remove('show');
      rpQueueSyncRead();
    });

    // ---- the bar <-> convo sync (replay-stage.md rev 4) ----
    // The READING marker: the topmost visible turn's wall-clock, marked on
    // the strip through the same scale as every other position. It moves
    // only under the reader's own scroll (the scrollbar-thumb exemption in
    // the motion budget) and hides while replaying — the playhead owns
    // position there.
    let rpReadQueued = false;
    function rpSyncRead() {
      if (!rpRead || !rpRead.style) return;
      if (replay.active || view !== 'session') { rpRead.style.display = 'none'; return; }
      const sc = rpScale();
      if (!sc || !convoEl.querySelectorAll) { rpRead.style.display = 'none'; return; }
      const cbox = convoEl.getBoundingClientRect ? convoEl.getBoundingClientRect() : null;
      let ts = 0;
      for (const el of convoEl.querySelectorAll('.turn[data-ts]')) {
        if (!cbox || !el.getBoundingClientRect) { ts = parseFloat(el.dataset.ts); break; }
        if (el.getBoundingClientRect().bottom - cbox.top > 24) { ts = parseFloat(el.dataset.ts); break; }
      }
      if (!ts) { rpRead.style.display = 'none'; return; }
      const frac = Math.min(1, Math.max(0, scaleX(sc, ts) / sc.px));
      rpRead.style.left = (frac * 100).toFixed(3) + '%';
      rpRead.style.display = 'block';
      // The turn block under the reading position lights — the sync made
      // visible on the block itself. A class flip under the reader's own
      // scroll: no motion.
      if (rpBody.querySelectorAll) {
        for (const b of rpBody.querySelectorAll('.rp-span.rp-turn')) {
          const on = ts >= parseFloat(b.dataset.t0) - 0.5 && ts <= parseFloat(b.dataset.t1) + 0.5;
          b.classList.toggle('cur', on);
        }
      }
    }
    function rpQueueSyncRead() {
      // A hidden tab never fires rAF — sync now so the marker is right the
      // moment the reader comes back, instead of one frame stale.
      if (typeof requestAnimationFrame !== 'function' || document.hidden) { rpSyncRead(); return; }
      if (rpReadQueued) return;
      rpReadQueued = true;
      requestAnimationFrame(() => { rpReadQueued = false; rpSyncRead(); });
    }

    // A click on the bar outside replay jumps the CONVERSATION to the last
    // turn at or before that instant — the outline's own jump, keyed by
    // time. The bar is the minimap; replay entry stays on ⏵ / the keyboard.
    // head: land on the FIRST turn at that instant, not the last — a turn
    // block's prompt shares its timestamp with the harness turns the same
    // request carried (the hook output, the reminders), and the reader who
    // clicked the block wants the prompt, not the last banner before the
    // reply.
    function rpJumpConvoTo(t, head) {
      if (!convoEl.querySelectorAll) return;
      let target = null;
      for (const el of convoEl.querySelectorAll('.turn[data-ts]')) {
        const ts = parseFloat(el.dataset.ts);
        if (head) { if (ts >= t - 0.5) { target = el; break; } continue; }
        if (ts <= t + 0.5) target = el; else break;
      }
      if (!target) return;
      if (target.getBoundingClientRect && convoEl.getBoundingClientRect) {
        convoScrollTo(convoEl.scrollTop + target.getBoundingClientRect().top - convoEl.getBoundingClientRect().top - 8);
      }
      tailPill.classList.remove('show');
      rpQueueSyncRead();
    }

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
      const mextra = Math.max(0, Object.keys(t.models || {}).length - 1);
      chips += kv('model', (t.model || '?') + (mextra ? ' +' + mextra : ''), 'model', modelTitle(t));
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
      // Where the wall-clock went (dsh's Trajectory lanes — Input / Model /
      // Tools — read off cctrace's own pairs, see threadTimeSplit). One
      // chip, the split in the hover; every figure is a wire timestamp.
      convoTime = threadTimeSplit(t, pairOf);
      if (convoTime.steps > 1) {
        const tb = ['model ' + fmtSpan(convoTime.model)];
        if (convoTime.tools) tb.push('tools ' + fmtSpan(convoTime.tools));
        if (convoTime.waiting) tb.push('waiting ' + fmtSpan(convoTime.waiting));
        if (convoTime.between) tb.push('between turns ' + fmtSpan(convoTime.between));
        chips += kv('time', tb.join(' \\u00b7 '), '',
          'where this thread\\u2019s ' + fmtSpan(convoTime.wall) + ' went, from the wire alone \\u2014 model: the requests\\u2019 own durations; tools: the gap after a reply that made tool calls until the same working loop\\u2019s next request (one gap may cover several calls run in parallel); waiting: such a gap after a reply with no tool call (the harness came back on its own); between turns: the gap before the next prompt. Failed and superseded requests are not on the path.');
      }
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
      if (eu.rewound) chips += kv('superseded', String(eu.rewound), '',
        'exchanges that left the conversation history \\u2014 /rewind, an edited message, or an ephemeral injected exchange (recap, notices); the wire pairs are kept, never lost');
      if (eu.unattributed) chips += kv('unplaced', String(eu.unattributed), '',
        'wire requests whose reply matches no turn in the reconstruction (reply superseded before it entered history)');
      // The context view is the same thread through the other lens — what
      // each request's window was assembled from.
      chips += '<a class="turn-wire" href="' + ctxHash(t.key, ctxMode) + '" title="context view\\nThis thread\\u2019s context window over time \\u2014 an interactive overview, then the window decomposed, the record stream, or what changed it.">context \\u2192</a>';
      // The pane renders as a PARTS array — one string per top-level node —
      // so live re-renders can patch only the nodes whose html actually
      // changed (see the apply step below).
      const parts = ['<div class="chips">' + chips + '</div>'];
      if (t.agentOf) {
        parts.push('<div class="agent-note">subagent run' +
          (t.agentOf.agentType ? ' \\u00b7 [' + escapeHtml(t.agentOf.agentType) + '] ' + escapeHtml(t.agentOf.description || '') : '') +
          ' \\u2014 dispatched by <a href="' + threadHash(t.agentOf.thread) + '"' +
          ' data-key="' + escapeHtml(t.agentOf.thread) + '" data-tuid="' + escapeHtml(t.agentOf.toolUseId || '') + '"' +
          ' onclick="return jumpToParent(event, this)"' +
          ' data-tip="back to the dispatching thread\\n---\\n> opens the parent at its spawn turn">parent thread \\u21b0</a></div>');
      }
      if (t.system) parts.push(renderSystem(t.system));
      if (t.tools && t.tools.length) parts.push(renderTools(t.tools));
      const results = buildToolResultIndex(t.turns);
      // Rewound exchanges mark their divergence point (devlog 2026-07-17
      // decision 4: keep + mark, never lose) — the erased branch's wire
      // pair stays one click away.
      const rewoundAt = {};
      for (const r of (t.rewound || [])) (rewoundAt[r.at] = rewoundAt[r.at] || []).push(r.pairId);
      // Compact boundaries mark where the request body sent to the API
      // changed completely — keyed by FULL turn index (same clock as
      // rewoundAt), rendered as a dashed divider the conversation flows
      // through.
      const compactAt = {};
      for (const c of (t.compactions || [])) (compactAt[c.at] = compactAt[c.at] || []).push(c);
      // Failed-request runs at their timeline position (same clock as
      // rewoundAt): one quiet line per run, wire pair linked. Positions
      // past the last turn (a trailing failure) clamp to just after it.
      const failedAt = {};
      for (const e of (t.failed || [])) {
        const at = Math.max(0, Math.min(e.at, t.turns.length));
        (failedAt[at] = failedAt[at] || []).push(e);
      }
      // Epoch dividers: a quiet rule where a /model switch takes over —
      // placed BEFORE the prompt that the new model answered (everything
      // below the line is that model's run). Keyed by visible-turn ordinal,
      // the same indexing threadEpochs emits and the epoch rows jump to.
      const epochAt = {};
      const eps = t.epochs || [];
      for (let i = 1; i < eps.length; i++) epochAt[eps[i].from] = eps[i].model;
      let ti = 0;
      let vi = 0;
      // Working-loop ordinals, same numbering as the outline: the user head
      // and the final response of each loop carry turnNN; intermediate
      // agent-work messages carry none — they are inside the turn.
      const cvis = t.turns.filter(x => !x.toolResultsOnly);
      const cloops = loopTurns(cvis);
      const cts = turnTimes(cvis);
      const viOrd = {};
      const viStep = {}; // intermediate steps carry "01.3" — same address as the outline
      for (let li = 0; li < cloops.length; li++) {
        const L = cloops[li];
        if (L.head != null) viOrd[L.head] = li;
        if (L.final != null) viOrd[L.final] = li;
        if (L.head == null && L.members.length) viOrd[L.members[0]] = li;
        for (const v of L.members) {
          if (v !== L.final && L.steps && L.steps[v])
            viStep[v] = (li + 1 < 10 ? '0' + (li + 1) : '' + (li + 1)) + '.' + L.steps[v];
        }
      }
      // The turn sitting AT a rewrite-mode boundary is the injected
      // continuation summary — tagged by position, not by matching
      // harness strings that can change under us.
      const sumTurnAt = {};
      for (const c of (t.compactions || [])) if (c.mode === 'rewrite') sumTurnAt[c.at] = 1;
      for (const turn of t.turns) {
        const marks = rewoundAt[ti];
        const cms = compactAt[ti];
        const fails = failedAt[ti];
        const isSummary = !!sumTurnAt[ti];
        ti++;
        if (cms) for (const c of cms) {
          const rw = c.mode === 'rewind';
          parts.push('<div class="cmark" title="' +
            escapeHtml('the request body sent to the API changed completely here \\u2014 ' +
              (rw ? 'history was truncated back to an earlier point (/rewind or an edited message); the turns above left the conversation history, their wire pairs are kept'
                : (c.mode === 'rewrite' ? 'history replaced by a continuation summary' : 'older turns folded, recent tail kept') +
                  '; everything above survives only in that form')) + '">' +
            '<a href="#/p/' + encodeURIComponent(c.pairId) + '">' +
            (rw ? 'rewound \\u00b7 history stepped back' : 'compacted \\u00b7 context rewritten') + ' \\u00b7 ' +
            c.fromTurns + ' \\u2192 ' + c.toTurns + ' turns \\u00b7 wire</a></div>');
        }
        if (marks) for (const pid of marks) {
          parts.push('<div class="rewound-mark" title="an exchange here left the conversation history — /rewind, an edited message, or an ephemeral injected exchange (recap, notices); its wire pair is kept">superseded exchange \\u00b7 <a href="#/p/' + encodeURIComponent(pid) + '">wire</a></div>');
        }
        if (fails) {
          parts.push('<div class="rewound-mark errrun-mark" title="failed wire requests at this position \\u2014 no reply entered the conversation; retries at the same history position">' +
            (fails.length > 1 ? fails.length + ' failed requests' : 'failed request') + ' \\u00b7 <a href="#/p/' + encodeURIComponent(fails[0].pairId) + '">wire</a></div>');
        }
        if (turn.toolResultsOnly) continue; // results fold into their tool_use
        if (epochAt[vi] !== undefined) {
          parts.push('<div class="epoch-mark" title="/model switch \\u2014 the conversation continues, a different model answers from here">\\u2192 ' + escapeHtml(shortModel(epochAt[vi]) || '?') + '</div>');
        }
        try { parts.push(renderSessionTurn(turn, results, viOrd[vi] != null ? viOrd[vi] : null, isSummary, viStep[vi] || '', cts[vi] || 0)); }
        catch (e) { parts.push(brokenItem('turn', turn && turn.pairId, e)); }
        vi++;
      }
      // Trailing failures: the storm after the last completed turn.
      const tailFails = failedAt[t.turns.length];
      if (tailFails) {
        parts.push('<div class="rewound-mark errrun-mark" title="failed wire requests at this position \\u2014 no reply entered the conversation; retries at the same history position">' +
          (tailFails.length > 1 ? tailFails.length + ' failed requests' : 'failed request') + ' \\u00b7 <a href="#/p/' + encodeURIComponent(tailFails[0].pairId) + '">wire</a></div>');
      }
      applyConvoParts(t, parts, foldState, sameThread);
      convoKey = t.key;
      if (!sameThread) {
        convoEl.scrollTop = IS_READING ? 0 : convoEl.scrollHeight;
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

    // Apply the parts array to the pane. Same thread + aligned node counts
    // = patch mode: only nodes whose html changed are replaced, so the DOM
    // the user is READING — an expanded final response, a text selection,
    // an opened fold — is never rebuilt by a live pair landing elsewhere
    // in the conversation (turns only mutate at the tail). Anything else
    // (thread switch, mid-stream inserts shifting alignment, headless test
    // stubs without a children list) falls back to the full innerHTML
    // rewrite with the positional fold restore.
    let convoParts = null; // per-node html of the last render, patch baseline
    function applyConvoParts(t, rawParts, foldState, sameThread) {
      const parts = rawParts.filter(s => s); // renderSystem may yield ''
      const canPatch = sameThread && convoParts && convoEl.replaceChild &&
        convoEl.children && convoEl.children.length === convoParts.length;
      if (!canPatch) {
        convoEl.innerHTML = parts.join('');
        if (foldState) {
          const details = convoEl.querySelectorAll('details');
          for (let i = 0; i < details.length && i < foldState.length; i++) details[i].open = foldState[i];
        }
        convoParts = parts;
        unclampLastTurn();
        tipDetachedGuard();
        return;
      }
      const n = Math.min(convoParts.length, parts.length);
      for (let i = 0; i < n; i++) {
        if (convoParts[i] === parts[i]) continue;
        const tmp = document.createElement('div');
        tmp.innerHTML = parts[i];
        const nu = tmp.firstElementChild;
        if (!nu) continue;
        // Carry the replaced node's own fold state across, positionally.
        const old = convoEl.children[i];
        const of_ = old.querySelectorAll('details'), nf = nu.querySelectorAll('details');
        for (let j = 0; j < of_.length && j < nf.length; j++) nf[j].open = of_[j].open;
        // Clamp state rides along too: a final answer the user expanded (or
        // unclampLastTurn did) must not snap shut when its node re-renders.
        const oc = old.querySelectorAll('.msg-clamp'), nc = nu.querySelectorAll('.msg-clamp');
        for (let j = 0; j < oc.length && j < nc.length; j++) {
          if (!oc[j].classList.contains('clamped') && nc[j].classList.contains('clamped')) {
            const btn = nc[j].querySelector(':scope > .msg-more');
            if (btn) window.toggleClamp(btn);
          }
        }
        convoEl.replaceChild(nu, old);
      }
      const grew = parts.length > convoParts.length;
      for (let i = convoParts.length; i < parts.length; i++) {
        const tmp = document.createElement('div');
        tmp.innerHTML = parts[i];
        if (tmp.firstElementChild) convoEl.appendChild(tmp.firstElementChild);
      }
      while (convoEl.children.length > parts.length) convoEl.removeChild(convoEl.lastElementChild);
      convoParts = parts;
      if (grew) unclampLastTurn(); // a new tail turn = a new final answer
      tipDetachedGuard();
    }

    // ---- Context view ----
    // What the model's context window was assembled from, request by
    // request (docs/design/context-view.md; the idea owes dsh-context).
    // Four sections over the SELECTED thread (selection shared with the
    // sessions view): current composition, per-step history chart, context
    // events, and a per-step browser. cctrace's edge over an event-log
    // fold: every captured request body IS the assembled context, so each
    // step is exact, and each carries the provider-reported prompt tokens
    // to anchor the estimates against.

    // Timeline + step-address cache: recompute only when the selected
    // thread gained pairs (per-pair composition/usage memoize on the pair).
    // Keyed by THREAD, not one slot: a trace holds many sessions and many
    // threads, and switching between them must not re-walk every body.
    // Bounded (oldest entry evicted) so a 40-thread trace can't pin 40
    // timelines in memory.
    const ctxTlCache = new Map();
    const CTX_TL_KEEP = 8;
    function ctxData(t) {
      const key = t.key + ':' + t.pairIds.length + ':' + pairs.length;
      let hit = ctxTlCache.get(t.key);
      if (!hit || hit.key !== key) {
        const tpairs = t.pairIds.map(id => pairOf(id)).filter(Boolean);
        const tl = contextTimeline(tpairs, t.compactions);
        // pairId -> {ord, step}: the outline's working-loop address for
        // each wire request — bars and events speak "turn 04 · step 2",
        // the same numbering the sessions rail uses.
        const vis = (t.turns || []).filter(x => !x.toolResultsOnly);
        const loops = loopTurns(vis);
        const addr = {};
        for (let li = 0; li < loops.length; li++) {
          const L = loops[li];
          for (const v of L.members) {
            const turn = vis[v];
            // vi = the VISIBLE turn index: what jumpToTurn addresses, so a
            // bar in the history chart can land on its turn in the rail.
            if (turn && turn.role === 'assistant' && turn.pairId) addr[turn.pairId] = { ord: li, step: (L.steps && L.steps[v]) || 0, vi: v };
          }
        }
        // The cost reading of the same steps (docs/design/cost.md): the
        // thread's bill by component, and the steps that re-bought a
        // prefix a warm cache would have read. The bumps join the context
        // events in ONE time-ordered list — the events deck answers "what
        // moved my window", and a cost bump is the same question about
        // the bill.
        const cost = threadCostSplit(tpairs);
        const bumps = costEvents(tpairs, tl.events);
        const events = bumps.length
          ? tl.events.concat(bumps).sort((a, b) => (a.t || 0) - (b.t || 0))
          : tl.events;
        hit = { key, tl, addr, cost, bumps, events };
        ctxTlCache.delete(t.key);
        ctxTlCache.set(t.key, hit);
        while (ctxTlCache.size > CTX_TL_KEEP) ctxTlCache.delete(ctxTlCache.keys().next().value);
      }
      return hit;
    }

    // Cheap per-thread context stat for the thread strip: peak assembled
    // prompt (provider-reported, extractCallInfo memoizes on the pair), the
    // step count, compaction count. No composition walk — the strip must
    // stay affordable for EVERY thread in the trace, not just the selected
    // one.
    const ctxStatCache = new Map();
    function ctxThreadStat(t) {
      const key = t.pairIds.length + ':' + pairs.length;
      const hit = ctxStatCache.get(t.key);
      if (hit && hit.key === key) return hit;
      let peak = 0, steps = 0, lastAt = 0;
      for (const id of t.pairIds) {
        const p = pairOf(id);
        if (!p || !wireDialect(p)) continue;
        steps++;
        if (p.request && p.request.timestamp > lastAt) lastAt = p.request.timestamp;
        if (!p.response || p.response.status >= 400) continue;
        const ci = p._ci || (p._ci = extractCallInfo(p));
        const tot = (ci.input || 0) + (ci.cacheRead || 0) + (ci.cacheWrite || 0);
        if (tot > peak) peak = tot;
      }
      const out = { key, peak, steps, lastAt, cuts: (t.compactions || []).length };
      ctxStatCache.set(t.key, out);
      return out;
    }

    function ctxOrdLbl(addr, pairId) {
      const a = addr && addr[pairId];
      if (!a) return '';
      const o = a.ord + 1 < 10 ? '0' + (a.ord + 1) : '' + (a.ord + 1);
      return 'turn ' + o + (a.step > 1 ? ' \\u00b7 step ' + a.step : '');
    }

    // The thread's context window: models.dev limit.context (modelWindow),
    // 1m when the wire's anthropic-beta header says context-1m. 0 = unknown
    // — occupancy renders without a %, never a made-up denominator.
    function ctxWindowOf(t) {
      const wf = threadWireFacts(t);
      if (wf.ctx1m) return 1000000;
      return modelWindow(t.model);
    }

    function ctxStepTotal(s) { return s.actualIn != null ? s.actualIn : s.est; }

    // The way back into the timeline: a step is a turn's wire request, so
    // the context view links to that turn in the sessions rail (the reverse
    // of the convo pane's \"context \u2192\"). Only for steps the outline
    // could address \u2014 a superseded or unattributed request has no turn
    // to land on, and we do not invent one.
    function ctxTurnLink(s, addr) {
      const a = addr && addr[s.pairId];
      if (!a || a.vi == null || !ctxThreadKey) return '';
      return '<a class="turn-wire" href="' + threadHash(ctxThreadKey) + '"' +
        ' onclick="return ctxJumpTurn(event, this)" data-key="' + escapeHtml(ctxThreadKey) + '" data-vi="' + a.vi + '"' +
        ' title="open this step in the sessions timeline">' + escapeHtml(ctxOrdLbl(addr, s.pairId)) + ' \u2192</a>';
    }
    window.ctxJumpTurn = function(e, el) {
      e.preventDefault();
      setView('session');
      history.replaceState(null, '', threadHash(el.dataset.key));
      showSession(el.dataset.key);
      jumpToTurn(el.dataset.key, +el.dataset.vi);
      return false;
    };

    // Column segments for one step, stacked bottom-up in CTX_CATS order.
    function ctxColSegs(s) {
      if (!s.sums || !s.est) return '<span class="cx-seg-stub" style="height:100%"></span>';
      let h = '';
      for (const c of CTX_CATS) {
        const v = s.sums[c.id];
        if (!v) continue;
        h += '<span class="cx-seg-v" style="height:' + ((v / s.est) * 100).toFixed(2) + '%;background:' + c.color + '"></span>';
      }
      return h;
    }

    function ctxBarTip(s, addr, extra) {
      const bits = [];
      const at = ctxOrdLbl(addr, s.pairId);
      bits.push((at || 'wire request') + (s.model ? ' \\u00b7 ' + shortModel(s.model) : ''));
      if (extra) bits.push(extra);
      if (s.t) bits.push(fmtDateTime(new Date(s.t * 1000)));
      if (s.stub) bits.push('request body folded by cctrace compact \\u2014 composition unknown, usage kept');
      else bits.push('estimated \\u2248' + fmtCompact(s.est));
      if (s.actualIn != null) {
        bits.push('actual prompt ' + fmtCompact(s.actualIn) + ' \\u00b7 output ' + fmtCompact(s.out));
        // Cache behavior is the step's cost story: a healthy step reads
        // most of its prompt from cache; a cold step after a compaction
        // (or an expired TTL) re-bills the whole prefix.
        if (s.cacheRead > 0) bits.push('cache read ' + fmtCompact(s.cacheRead) + ' (' + Math.round((s.cacheRead / s.actualIn) * 100) + '% of prompt)');
        else bits.push('cache read 0 \\u2014 cold: the whole prompt billed at full input price');
      }
      else if (s.failed) bits.push('request FAILED \\u2014 no response; the bar shows what was SENT');
      if (s.mark === 'compact') bits.push('\\u2702 compaction \\u2014 the history above was folded');
      else if (s.mark === 'rewrite') bits.push('\\u2702 full rewrite \\u2014 history replaced by a continuation summary');
      else if (s.mark === 'rewind') bits.push('\\u2702 rewind \\u2014 history stepped back to an earlier point');
      return bits.join('\\n') + '\\n---\\n> hover previews \\u00b7 click pins \\u00b7 drag selects a range';
    }

    function showContext(key, sub) {
      const threads = getThreads();
      if (!threads.length) {
        contextEl.innerHTML = '<div class="empty">No model calls captured yet.</div>';
        return;
      }
      const sel = resolveThreadSel(threads, key, sub);
      sessionSelKey = sel.key;
      renderContextView(sel);
    }

    // ---- the record stream (the "stream" deck) ----
    // The thread as one linear stream of records — trajectoryRecords in
    // src/context.ts. It shipped as its own tab in 0.44 and that was the
    // error this rebuild corrects: it is not a second view of a thread,
    // it is a READING of the same selection the overview owns. So it is a
    // deck beside "window" and "events", scoped by the brushed range, and
    // the thread identity / the time totals it used to carry in its own
    // head now live where they belong (the page head, the margin).
    // The level toggle (archify's MAP/READ/FULL) filters, never summarizes.
    let tjLevel = localStorage.getItem('cctrace-tj-level') || 'full';
    if (tjLevel !== 'full' && tjLevel !== 'read' && tjLevel !== 'map') tjLevel = 'full';
    let tjFilter = 'all';     // 'all' or a record kind
    let tjQuery = '';
    let tjSel = null;         // selected record index (_i), preserved across re-renders
    let tjCurThread = null;
    let tjRecs = [];          // the current thread's full records (each carries _i)
    let tjResults = {};       // tool_use id -> result, for the inspector
    const TJ_KIND_COLOR = { system: '#8957e5', user: '#3fb950', context: '#db61a2', assistant: '#4184e4', tool: '#39c5cf' };
    const TJ_KINDS = ['all', 'user', 'context', 'assistant', 'tool'];

    function tjBadge(r) {
      const k = r.kind;
      const txt = k === 'assistant' ? (r.think ? 'THINK' : 'ASSIST') : k.toUpperCase();
      const c = r.think ? 'var(--text-faint)' : (TJ_KIND_COLOR[k] || 'var(--text-faint)');
      return '<span class="tj-badge" style="--tjc:' + c + '">' + txt + '</span>';
    }

    // The picked record, opened — the inspector's content facet on the
    // stream deck. A tool shows call + result via the detail-panel's own
    // tool renderer; a system record its blocks; anything else its block.
    // The inspector's head names kind, turn.step and weight; the wire and
    // the schema are facets of their own.
    function renderTjDetail(r, results) {
      if (!r) return '<div class="cx-note">pick a record to open it</div>';
      let body = '';
      try {
        if (r.kind === 'system') body = renderSystem((r.block && r.block.blocks) || []);
        else if (r.kind === 'tool') body = renderBlockS(r.block, results, true);
        else body = renderBlock(r.block, r.kind === 'assistant');
      } catch (e) { body = brokenItem('record', r.pairId, e); }
      return body;
    }

    // The stream deck's own controls — level, kind, search — for the deck
    // bar's right side. They belong to this reading, not to the page.
    function renderStreamControls(hidden) {
      const lvlBtn = (v, lbl, tip) => '<button class="tj-lvl' + (tjLevel === v ? ' active' : '') + '" data-tjlvl="' + v + '" title="' + tip + '">' + lbl + '</button>';
      const kindBtn = k => '<button class="tj-kind' + (tjFilter === k ? ' active' : '') + '" data-tjkind="' + k + '"' +
        (k !== 'all' ? ' style="--tjc:' + (TJ_KIND_COLOR[k] || 'var(--text-faint)') + '"' : '') + '>' + k + '</button>';
      return '<span class="tj-toolbar">' +
        (hidden ? '<span class="tj-hidden">' + hidden + ' hidden at this level</span>' : '') +
        '<span class="tj-lvls" title="detail level — the stream is always complete; the level decides what earns a row">' +
          lvlBtn('map', 'map', 'skeleton: the human’s turns and the tool calls') +
          lvlBtn('read', 'read', 'drop the budget banners and bare thinking; keep the substance') +
          lvlBtn('full', 'full', 'every record') + '</span>' +
        '<span class="tj-kinds">' + TJ_KINDS.map(kindBtn).join('') + '</span>' +
        '<input type="text" class="tj-search" id="tj-search" placeholder="find in stream…" value="' + escapeHtml(tjQuery) + '">' +
        '</span>';
    }

    // Build the thread's records once per render. Returns the leveled set
    // (records + how many the level hid), which the deck bar captions.
    let tjCache = { key: '', n: -1 };
    function tjBuild(t) {
      if (!tjCurThread || tjCurThread.key !== t.key) tjSel = null; // an index means nothing in another thread
      tjCurThread = t;
      // The deck bar states the record count in every mode, so this walk
      // runs on every render — memoized on (thread, spine length), which
      // is exactly what a live pair changes.
      const n = (t.turns || []).length;
      if (tjCache.key !== t.key || tjCache.n !== n) {
        tjRecs = trajectoryRecords(t);
        tjRecs.forEach((r, i) => { r._i = i; });
        tjResults = {};
        for (const r of tjRecs) if (r.kind === 'tool' && r.block && r.block.id) tjResults[r.block.id] = r.result;
        tjCache = { key: t.key, n };
      }
      // No default pick: the inspector opens when the reader asks, and a
      // stale index past the end (the thread shrank) names nothing.
      if (tjSel != null && tjSel >= tjRecs.length) tjSel = null;
      return trajectoryAtLevel(tjRecs, tjLevel);
    }

    // The brushed range, in RECORD space. The stream is one contiguous run
    // in spine order, so a range of wire steps is a contiguous SLICE of
    // it: from the first record attributed to the range's first step to
    // the last attributed to its last. It cannot be a pairId membership
    // test — most of a long spine has no wire pair of its own (the
    // history came in on request bodies whose own requests were never
    // captured, or live in a prior trace), and keeping every
    // unattributed record made a 5-of-26 brush drop 47 rows out of 417.
    // Bounds are computed over the FULL record list, so the slice means
    // the same thing at every detail level.
    function tjRangeBounds(ids) {
      if (!ids) return null;
      let lo = -1, hi = -1;
      for (let i = 0; i < tjRecs.length; i++) {
        const id = tjRecs[i].pairId;
        if (id && ids[id]) { if (lo === -1) lo = i; hi = i; }
      }
      return lo === -1 ? { lo: 0, hi: -1 } : { lo, hi };
    }

    // The stream, as HTML, sliced to the brushed range — the same
    // selection the overview shows, so a dragged window and the rows
    // under it can never disagree.
    function renderCtxStream(leveled, bounds) {
      let shown = leveled.records;
      if (bounds) shown = shown.filter(r => r._i >= bounds.lo && r._i <= bounds.hi);
      if (tjFilter !== 'all') shown = shown.filter(r => r.kind === tjFilter);
      const q = tjQuery.trim().toLowerCase();
      if (q) shown = shown.filter(r => (r.label + ' ' + (r.detail || '')).toLowerCase().indexOf(q) !== -1);
      // A pick outside the slice would leave the inspector showing a
      // record the list does not have — drop it. An in-slice pick is the
      // reader's and survives.
      if (bounds && tjSel != null && (tjSel < bounds.lo || tjSel > bounds.hi)) tjSel = null;
      let rows = '';
      let lastOrd = -2;
      for (const r of shown) {
        if (r.ord !== lastOrd && r.ord != null) {
          rows += '<div class="tj-turn">turn ' + (r.ord + 1 < 10 ? '0' + (r.ord + 1) : r.ord + 1) + '</div>';
          lastOrd = r.ord;
        }
        const isTool = r.kind === 'tool';
        rows += '<a class="tj-row tj-k-' + r.kind + (r.think ? ' tj-think' : '') + (r.err ? ' tj-err' : '') +
            (r._i === tjSel ? ' sel' : '') + '" href="#" data-tj="' + r._i + '" style="--tjc:' + (TJ_KIND_COLOR[r.kind] || 'var(--text-faint)') + '">' +
          tjBadge(r) +
          '<span class="tj-label' + (isTool ? ' tj-mono' : '') + '">' + escapeHtml(r.label) + '</span>' +
          (isTool && r.detail ? '<span class="tj-arrow">→</span><span class="tj-result">' + escapeHtml(r.detail) + '</span>' : '') +
          '<span class="tj-gap"></span>' +
          '<span class="tj-tok">≈' + fmtCompact(r.tokens) + '</span>' +
        '</a>';
      }
      if (!shown.length) rows = '<div class="cx-note">no records match this ' + (bounds ? 'range/filter' : 'filter') + '</div>';
      return '<div class="tj-list" id="tj-list">' + rows + '</div>';
    }

    // The stream's own wiring. A row click is a PICK: it opens the record
    // in the inspector in place (no navigation, like the requests list);
    // the level/kind/search controls repaint just the deck, so the
    // overview above never flickers.
    function wireCtxStream(root, repaint) {
      root.querySelectorAll('.tj-row').forEach(a => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          tjSel = +a.dataset.tj;
          ctxInspOpen = true;
          root.querySelectorAll('.tj-row.sel').forEach(x => x.classList.remove('sel'));
          a.classList.add('sel');
          ctxRepaintInsp();
        });
      });
    }

    // ---- the inspector: ONE right panel for every deck ----
    // A pick — an icicle node, a stream record, an event row — opens it;
    // × / Esc closes it and the deck takes the whole width back. Inside,
    // a head that names the picked thing, then a VERTICAL rail of facets
    // beside the facet's body. The facets are the questions the wire can
    // answer about the pick, and only those: content (what it is), schema
    // (a tool's declared schema in the carrying request), origin (when it
    // entered the window and how many requests re-sent it), wire (the
    // request that carried it). A facet that would only say "n/a" is not
    // offered, so the rail never lists a dead tab.

    // What is picked on the current deck, resolved against what that deck
    // drew last. Null = nothing to open. The key names the pick, so a
    // repaint can tell "same thing, live pair" from "a different thing".
    function ctxPick() {
      if (ctxMode === 'window') {
        const path = ctxLastFl && ctxSelKey ? ctxFlameFind(ctxLastFl.root, ctxSelKey) : null;
        const hit = path && path[path.length - 1];
        return hit ? { kind: 'node', key: 'n:' + ctxGraphAt + ':' + hit.key, hit, item: hit.item || null, pairId: ctxGraphAt } : null;
      }
      if (ctxMode === 'stream') {
        const r = tjSel != null ? tjRecs[tjSel] : null;
        return r ? { kind: 'rec', key: 'r:' + (tjCurThread ? tjCurThread.key : '') + ':' + tjSel, r, pairId: r.pairId || null } : null;
      }
      if (ctxMode === 'events' && ctxEvSel) {
        const run = ctxEvRolled.find(x => x.key === ctxEvSel.key && x.ev.pairId === ctxEvSel.pairId);
        return run ? { kind: 'ev', key: 'e:' + run.key + ':' + run.ev.pairId, run, ev: run.ev, pairId: run.ev.pairId || null } : null;
      }
      return null;
    }

    const CX_FACET_TIP = {
      content: 'what it is \\u2014 rendered as in the requests detail panel',
      schema: 'the tool\\u2019s declared schema in the request that carried this call, and what it costs to keep loaded',
      origin: 'when it entered the window, and how many requests have re-sent it since',
      wire: 'the request that carried it \\u2014 model, timing, usage, cost',
    };
    function ctxPickTool(pick) {
      if (pick.kind === 'rec') return pick.r.kind === 'tool' ? pick.r.toolName : '';
      if (pick.kind === 'node') return pick.item && pick.item.kind === 'tool_use' ? pick.item.toolName : '';
      return '';
    }
    function ctxFacetsOf(pick) {
      const out = ['content'];
      if (!pick) return out;
      const carried = !!(pick.pairId && pairOf(pick.pairId));
      if (ctxPickTool(pick) && carried) out.push('schema');
      const hasOrigin = pick.kind === 'rec' ? (pick.r.kind !== 'system' && carried)
        : pick.kind === 'node' ? !!(pick.item && pick.item.ti != null && pick.item.ti >= 0 && carried)
        : false;
      if (hasOrigin) out.push('origin');
      if (carried) out.push('wire');
      return out;
    }

    // The head: what is picked, in the vocabulary of the deck it came from.
    function ctxInspHead(pick) {
      const x = '<button class="cx-insp-x" data-cxinsp="close" title="close the inspector \\u00b7 esc">\\u00d7</button>';
      if (pick.kind === 'node') {
        const h = pick.hit;
        return '<span class="cx-dot" style="--cx:' + (h.color || 'var(--text-faint)') + '"></span>' +
          '<span class="cx-insp-t">' + escapeHtml(h.label) + '</span>' +
          (h.n > 1 ? '<span class="cx-insp-n">' + h.n + ' items</span>' : '') +
          '<span class="cx-insp-tok">\\u2248' + fmtCompact(h.tokens) + ' \\u00b7 ' + ctxPctStr(h.tokens, ctxFlameTotal) + ' of the request</span>' + x;
      }
      if (pick.kind === 'rec') {
        const r = pick.r;
        const addr = r.ord != null ? 'turn ' + (r.ord + 1 < 10 ? '0' + (r.ord + 1) : r.ord + 1) + (r.step > 0 ? ' \\u00b7 step ' + r.step : '') : '';
        return tjBadge(r) + '<span class="cx-insp-t">' + escapeHtml(r.label) + '</span>' +
          (addr ? '<span class="cx-insp-addr">' + addr + '</span>' : '') +
          '<span class="cx-insp-tok">\\u2248' + fmtCompact(r.tokens) + '</span>' + x;
      }
      const ev = pick.ev, run = pick.run;
      const kind = ev.kind === 'compact' && ev.mode === 'rewind' ? 'rewind' : ev.kind;
      const amount = ev.kind === 'cost' ? '\\u2248+' + fmtCost(run.extra)
        : ev.kind !== 'model' && run.tokens ? (run.tokens > 0 ? '+' : '\\u2212') + fmtCompact(Math.abs(run.tokens)) : '';
      return '<span class="cx-ev-kind">' + kind + '</span>' +
        '<span class="cx-insp-t">' + escapeHtml(ctxEvLabel(ev)) + '</span>' +
        (run.n > 1 ? '<span class="cx-insp-n">\\u00d7' + run.n + '</span>' : '') +
        '<span class="cx-insp-tok">' + amount + '</span>' + x;
    }

    let ctxInspChanged = false;
    function renderCtxInsp() {
      const pick = ctxPick();
      const facets = ctxFacetsOf(pick);
      const facet = facets.indexOf(ctxFacet) !== -1 ? ctxFacet : 'content';
      const key = pick ? pick.key + '/' + facet : '';
      ctxInspChanged = key !== ctxInspLastKey;
      ctxInspLastKey = key;
      if (!pick || !ctxInspOpen) return '';
      let rail = '';
      for (const f of facets) {
        rail += '<button class="cx-facet' + (f === facet ? ' active' : '') + '" data-cxfacet="' + f + '" title="' + escapeHtml(CX_FACET_TIP[f]) + '">' + f + '</button>';
      }
      let body = '';
      try {
        if (facet === 'schema') body = ctxSchemaHtml(pick);
        else if (facet === 'origin') body = ctxOriginHtml(pick);
        else if (facet === 'wire') body = ctxWireHtml(pick.pairId);
        // The reader picked this to READ it: a leaf's or a record's own
        // fold opens. (The requests detail folds every tool to one line
        // because nothing there was picked; here the pick already
        // happened.) A group's ranked folds stay closed — fifteen open
        // tool results is a wall, not an answer.
        else if (pick.kind === 'node') body = pick.item ? ctxOpenTopFold(renderCtxPane(ctxLastFl)) : renderCtxPane(ctxLastFl);
        else if (pick.kind === 'rec') body = ctxOpenTopFold(renderTjDetail(pick.r, tjResults));
        else body = ctxEvContentHtml(pick);
      } catch (e) { body = brokenItem('inspector', pick.pairId || '', e); }
      return '<div class="cx-insp-h">' + ctxInspHead(pick) + '</div>' +
        '<div class="cx-insp-cols"><div class="cx-insp-rail">' + rail + '</div>' +
        '<div class="cx-insp-body" id="cx-insp-body">' + body + '</div></div>';
    }

    // Repaint the inspector alone — a pick, a facet switch or a close must
    // not rebuild the overview under the reader's cursor. The body's
    // scroll survives a same-pick repaint (a live pair) and resets when
    // the pick or the facet changed.
    function ctxRepaintInsp() {
      const el = document.getElementById('cx-insp');
      if (!el) return;
      const oldBody = document.getElementById('cx-insp-body');
      const top = oldBody ? oldBody.scrollTop : 0;
      const html = renderCtxInsp();
      if (!html) { el.hidden = true; el.innerHTML = ''; tipDetachedGuard(); return; }
      el.hidden = false;
      el.innerHTML = html;
      const body = document.getElementById('cx-insp-body');
      if (body && !ctxInspChanged) body.scrollTop = top;
      el.querySelectorAll('details[data-raw][open]').forEach(fillRaw);
      wireCtxInsp(el);
      tipDetachedGuard();
    }
    function wireCtxInsp(root) {
      root.querySelectorAll('[data-cxfacet]').forEach(b => b.addEventListener('click', () => {
        ctxFacet = b.dataset.cxfacet;
        ctxRepaintInsp();
      }));
      root.querySelectorAll('[data-cxinsp="close"]').forEach(b => b.addEventListener('click', () => {
        ctxInspOpen = false;
        ctxRepaintInsp();
      }));
      root.querySelectorAll('[data-cxev]').forEach(row => row.addEventListener('click', (e) => {
        // the row's wire link is its own control
        if (e.target && e.target.closest && e.target.closest('a')) return;
        const run = ctxEvRolled[+row.dataset.cxev];
        if (!run) return;
        ctxEvSel = { key: run.key, pairId: run.ev.pairId };
        ctxInspOpen = true;
        root.querySelectorAll('.cx-ev.sel').forEach(x => x.classList.remove('sel'));
        row.classList.add('sel');
        ctxRepaintInsp();
      }));
    }

    const ctxKv = (k, v) => '<div class="cx-kv"><span class="cx-kv-k">' + k + '</span><span class="cx-kv-v">' + v + '</span></div>';
    const ctxNote = (s) => '<div class="cx-insp-note">' + s + '</div>';
    // The first fold in a rendered block is the block's own (a tool call,
    // a result, a thinking block); open it — the inner raw-input folds
    // stay closed.
    const ctxOpenTopFold = (html) => html.replace('<details class="fold ', '<details open class="fold ');
    // A step named as a control: click pins it (the overview and the
    // window deck jump there) — the same chip the pane's provenance uses.
    function ctxStepChip(s) {
      if (!s) return '';
      const lbl = ctxOrdLbl(ctxAddr, s.pairId) || 'wire request';
      return '<span class="cx-since" role="button" tabindex="0" data-cxpin="' + escapeHtml(s.pairId) + '" data-tip="' +
        escapeHtml(lbl + (s.t ? ' \\u00b7 ' + fmtDateTime(new Date(s.t * 1000)) : '') + '\\n> click to pin that step') + '">' + escapeHtml(lbl) + '</span>';
    }

    // SCHEMA: the tool's declaration in the request that carried this call
    // — name, description, input schema — and its standing cost: what it
    // weighs in every request that carries it, ranked among that
    // request's tools. The window deck's tools category is the same data
    // seen by weight; this is the one tool, read.
    function ctxSchemaHtml(pick) {
      const name = ctxPickTool(pick);
      const p = pick.pairId ? pairOf(pick.pairId) : null;
      if (!name || !p) return ctxNote('no carrying request loaded for this call');
      const body = (p.request && p.request.body) || {};
      const dialect = wireDialect(p) || 'anthropic';
      const tools = dialect === 'openai' ? openaiTools(body) : (Array.isArray(body.tools) ? body.tools : []);
      const tname = (t) => (t && (t.name || (t.function && t.function.name) || t.type)) || '';
      const t = tools.find(x => tname(x) === name);
      if (!t) {
        return ctxNote('<b>' + escapeHtml(name) + '</b> is not declared in this request\\u2019s tools \\u2014 a server-side tool, or a schema the harness had not loaded yet');
      }
      let rank = '';
      try {
        const env = ctxEnvelope(body, dialect);
        const ranked = env.tools.slice().sort((a, b) => b.tokens - a.tokens);
        const i = ranked.findIndex(x => x.name === name);
        if (i !== -1) {
          rank = ctxKv('weight', '<b>\\u2248' + fmtCompact(ranked[i].tokens) + '</b> tokens in every request that carries it \\u00b7 #' +
            (i + 1) + ' of ' + ranked.length + ' tools by weight');
        }
      } catch (e) { /* an unparseable envelope costs the line, never the facet */ }
      const desc = String(t.description || (t.function && t.function.description) || '');
      const schema = t.input_schema || t.parameters || (t.function && t.function.parameters) || null;
      return rank +
        (desc ? '<div class="cx-insp-desc">' + escapeHtml(desc.length > 4000 ? desc.slice(0, 4000) + '\\u2026' : desc) + '</div>' : ctxNote('no description declared')) +
        preBlock(formatJson(schema || t));
    }

    // ORIGIN: when the picked thing entered the window, and the CARRY —
    // how many requests have re-sent it since, and what that weighs. For
    // an icicle item the carry is exact: it is in the pinned step's window
    // (content-verified), so it rode every request from its origin to the
    // pin. For a stream record the count runs forward to the next
    // compaction/rewind boundary and says so — the window was rewritten
    // there, and whether the record survived is that step's own reading.
    function ctxOriginHtml(pick) {
      const steps = ctxCurThread ? ctxData(ctxCurThread).tl.steps : [];
      let i0 = -1, tokens = 0, producedBy = null, toPid = null;
      if (pick.kind === 'rec') {
        const r = pick.r;
        tokens = r.tokens;
        const i = steps.findIndex(s => s.pairId === r.pairId);
        if (i === -1) return ctxNote('no captured request carried this record \\u2014 it arrived inside a request body whose own request was not captured, or lives in a prior trace');
        // A reply and the calls it made ARE a step's output; they enter
        // the window with the NEXT request. A prompt, a result, an
        // injection entered with the request the record names.
        if (r.kind === 'assistant' || r.kind === 'tool') { producedBy = steps[i]; i0 = i + 1; }
        else i0 = i;
      } else {
        const o = ctxOriginOf(pick.hit);
        if (!o) return ctxNote('origin not on the wire for this item \\u2014 an envelope row (system prompt, schemas) has no turn, and a turn that matches nothing in the spine is not guessed at');
        tokens = pick.hit.tokens;
        const i = steps.findIndex(s => s.pairId === o.pid);
        if (i === -1) return ctxNote('the carrying request is not in this thread\\u2019s timeline');
        if (o.verb === 'from') { producedBy = steps[i]; i0 = i + 1; } else i0 = i;
        toPid = ctxGraphAt;
      }
      let h = '';
      if (producedBy) h += ctxKv('produced by', ctxStepChip(producedBy) + (producedBy.t ? ' <span class="cx-insp-addr">' + fmtDateTime(new Date(producedBy.t * 1000)) + '</span>' : ''));
      if (i0 >= steps.length) return h + ctxNote('not re-sent yet \\u2014 no request has followed it');
      const span = ctxCarrySpan(steps, steps[i0].pairId, toPid);
      if (!span) return h + ctxNote('the carrying request is not in this thread\\u2019s timeline');
      h += ctxKv('entered', ctxStepChip(span.from) + (span.from.t ? ' <span class="cx-insp-addr">' + fmtDateTime(new Date(span.from.t * 1000)) + '</span>' : ''));
      const n = span.n;
      const until = toPid ? (span.to.pairId === span.from.pairId ? '' : ', through the pinned step')
        : span.boundary ? ', counted up to the \\u2702 at ' + ctxStepChip(span.boundary) + ' \\u2014 the window was ' +
          (span.boundary.mark === 'rewind' ? 'rewound' : span.boundary.mark === 'rewrite' ? 'rewritten' : 'compacted') + ' there; pin that step to see what it kept'
        : ' \\u2014 still in the window at the thread\\u2019s last request';
      h += ctxKv('carried by', '<b>' + n + ' request' + (n === 1 ? '' : 's') + '</b>' + until);
      h += ctxKv('re-sent', '<b>\\u2248' + fmtCompact(tokens * n) + '</b> tokens of prompt over those requests (\\u2248' + fmtCompact(tokens) + ' \\u00d7 ' + n + ')');
      h += ctxNote('a carried prefix is mostly read from cache \\u2014 the per-step cache share is in the margin. What the window holds is exact; the weight is chars/4');
      return h;
    }

    // WIRE: the request that carried the pick, in brief — the figures the
    // request row shows, without leaving the page. The links are the way
    // out: the turn in the sessions rail, the pair in the requests view.
    function ctxWireHtml(pairId) {
      const p = pairId ? pairOf(pairId) : null;
      if (!p) return ctxNote('request not loaded');
      const ci = p._ci || (p._ci = extractCallInfo(p));
      const st = p.response ? p.response.status : 0;
      const failed = !p.response || st >= 400;
      const at = ctxOrdLbl(ctxAddr, pairId);
      let h = '';
      h += ctxKv('request', (at ? '<b>' + escapeHtml(at) + '</b> \\u00b7 ' : '') + (p.request.timestamp ? fmtDateTime(new Date(p.request.timestamp * 1000)) : 'wire request'));
      h += ctxKv('model', '<b>' + escapeHtml(ci.model || (p.request.body && p.request.body.model) || '?') + '</b>');
      h += ctxKv('status', failed
        ? '<span style="color:var(--red)">' + (p.response ? st : 'no response') + '</span>' + (ci.error ? ' \\u00b7 ' + escapeHtml(String(ci.error).slice(0, 200)) : '')
        : st + (ci.stopReason ? ' \\u00b7 stop ' + escapeHtml(ci.stopReason) : '') + (p.response && p.response.truncated ? ' \\u00b7 stream truncated' : ''));
      h += ctxKv('timing', (p.duration ? fmtMs(p.duration) : '\\u2014') +
        (p.response && typeof p.response.firstTokenMs === 'number' ? ' \\u00b7 ttft ' + fmtMs(p.response.firstTokenMs) : ''));
      const tin = (ci.input || 0) + (ci.cacheRead || 0) + (ci.cacheWrite || 0);
      if (tin) {
        h += ctxKv('prompt', '<b>' + fmtCompact(tin) + '</b> = ' + fmtCompact(ci.cacheRead || 0) + ' cache read \\u00b7 ' +
          fmtCompact(ci.cacheWrite || 0) + ' cache write \\u00b7 ' + fmtCompact(ci.input || 0) + ' input' +
          (ci.cachePct != null ? ' \\u00b7 <b>' + ci.cachePct + '%</b> from cache' : ''));
      }
      if (ci.output) h += ctxKv('output', fmtCompact(ci.output) + (ci.thinking ? ' \\u00b7 ' + fmtCompact(ci.thinking) + ' thinking' : ''));
      const sc = stepCost(p);
      if (sc && sc.total > 0) {
        h += ctxKv('\\u2248cost', '<span class="cx-dt" data-tip="' +
          escapeHtml(costTitle(sc) + '\\n---\\n> every dollar is an estimate from catalog rates') + '"><b>' + fmtCost(sc.total) + '</b> this step \\u00b7 hover for the split</span>');
      }
      h += ctxKv('open', ctxTurnLink({ pairId }, ctxAddr) +
        '<a class="turn-wire" href="#/p/' + encodeURIComponent(pairId) + '" title="open the captured pair in the requests view">wire \\u2192</a>');
      return h;
    }

    // An event's content: the injected text itself, a compaction's
    // before → after by category, a bump's cause and counterfactual, an
    // envelope change's from → to. Everything here is the wire's.
    function ctxEvContentHtml(pick) {
      const ev = pick.ev, run = pick.run;
      const p = ev.pairId ? pairOf(ev.pairId) : null;
      const steps = ctxCurThread ? ctxData(ctxCurThread).tl.steps : [];
      const i = steps.findIndex(s => s.pairId === ev.pairId);
      const s = i !== -1 ? steps[i] : null;
      let h = '';
      if (run.n > 1) {
        h += ctxNote(run.n + ' occurrences rolled into this row \\u2014 the most recent is shown' +
          (run.t0 && run.t0 !== ev.t ? ' (' + fmtTime(new Date(run.t0 * 1000)) + ' \\u2192 ' + fmtTime(new Date(ev.t * 1000)) + ')' : ''));
      }
      if (ev.kind === 'inject') {
        // the block: the carrying request's window, searched from its end
        // (the injection rode the turns this request appended)
        const win = p ? ctxWindowTurns(p) : [];
        let blk = null;
        for (let ti = win.length - 1; ti >= 0 && !blk; ti--) {
          const turn = win[ti];
          if (!turn || turn.role === 'assistant') continue;
          for (const b of turn.blocks || []) {
            if (b && b.type === 'text' && ctxTextCat(b.text) === 'inject' && ctxInjectLabel(b.text) === ev.label) { blk = b; break; }
          }
        }
        h += ctxKv('at', ctxStepChip(s) + (ev.t ? ' <span class="cx-insp-addr">' + fmtDateTime(new Date(ev.t * 1000)) + '</span>' : ''));
        h += ctxKv('weight', '<b>\\u2248' + fmtCompact(ev.tokens || 0) + '</b> tokens added to the window');
        h += blk ? renderBlock(blk, false)
          : ctxNote('the injected text is not in this request\\u2019s captured body' + (s && s.stub ? ' \\u2014 folded by cctrace compact' : ''));
        return h;
      }
      if (ev.kind === 'compact') {
        let prev = null;
        for (let j = i - 1; j >= 0 && !prev; j--) if (steps[j].sums) prev = steps[j];
        h += ctxKv('at', ctxStepChip(s) + (ev.t ? ' <span class="cx-insp-addr">' + fmtDateTime(new Date(ev.t * 1000)) + '</span>' : ''));
        h += ctxKv('mode', '<b>' + (ev.mode === 'rewind' ? 'rewind' : ev.mode === 'rewrite' ? 'rewrite (continuation summary)' : 'fold') + '</b>' +
          (ev.fromTurns ? ' \\u00b7 ' + ev.fromTurns + ' \\u2192 ' + ev.toTurns + ' turns' : ''));
        h += ctxKv('prompt', ev.tokens ? '<b>' + (ev.tokens > 0 ? '+' : '\\u2212') + fmtCompact(Math.abs(ev.tokens)) + '</b> provider-reported, previous request \\u2192 this one' : 'delta not anchored (one side reported no usage)');
        if (prev && s && s.sums) {
          h += '<div class="cx-insp-note">by category, estimated (\\u2248 chars/4): before \\u2192 after</div>';
          for (const c of CTX_CATS) {
            const a = prev.sums[c.id] || 0, b = s.sums[c.id] || 0, d = b - a;
            h += '<div class="cx-cmp"><span class="cx-cmp-l"><span class="cx-dot" style="--cx:' + c.color + '"></span>' + c.label + '</span>' +
              '<span class="cx-cmp-n">\\u2248' + fmtCompact(a) + '</span><span class="cx-arrow">\\u2192</span><span class="cx-cmp-n">\\u2248' + fmtCompact(b) + '</span>' +
              '<span class="cx-cmp-d ' + (d < 0 ? 'cx-delta minus' : d > 0 ? 'cx-delta plus' : '') + '">' + (d ? (d > 0 ? '+' : '\\u2212') + fmtCompact(Math.abs(d)) : '\\u00b7') + '</span></div>';
          }
        } else {
          h += ctxNote('composition unavailable on one side of the boundary (a folded stub, or the request failed) \\u2014 the prompt delta above is anchored on the provider\\u2019s counts');
        }
        return h;
      }
      if (ev.kind === 'cost') {
        h += ctxKv('at', ctxStepChip(s) + (ev.t ? ' <span class="cx-insp-addr">' + fmtDateTime(new Date(ev.t * 1000)) + '</span>' : ''));
        h += ctxKv('cause', '<b>' + escapeHtml(ctxBumpLabel(ev)) + '</b>');
        if (ev.cause === 'expired' && ev.gap != null) h += ctxKv('gap', fmtMs(ev.gap * 1000) + ' since the previous request ended \\u00b7 its cache write had a ' + escapeHtml(String(ev.ttl || '')) + ' TTL');
        if (ev.cause === 'retry' && ev.prevStatus) h += ctxKv('previous', 'status ' + escapeHtml(String(ev.prevStatus)) + ' \\u2014 it never banked its write');
        h += ctxKv('re-billed', '<b>' + fmtCompact(ev.tokens || 0) + '</b> tokens at input / cache-write rate that a warm cache would have read');
        h += ctxKv('over warm', '<b>\\u2248' + fmtCost(ev.extra) + '</b> \\u2014 what those tokens would have cost as cache reads, subtracted');
        if (ev.hitPct != null) h += ctxKv('cache hit', ev.hitPct + '% of this prompt came from cache');
        h += ctxNote('the cause is a wire fact; every dollar is an estimate from catalog rates');
        return h;
      }
      h += ctxKv('at', ctxStepChip(s) + (ev.t ? ' <span class="cx-insp-addr">' + fmtDateTime(new Date(ev.t * 1000)) + '</span>' : ''));
      if (ev.kind === 'model') {
        h += ctxKv('from', escapeHtml(ev.from || '?')) + ctxKv('to', escapeHtml(ev.to || '?')) +
          ctxNote('a model change invalidates the whole cached prefix \\u2014 the next step re-bills it');
      } else if (ev.kind === 'tools') {
        h += ctxKv('tools', ev.from + ' \\u2192 ' + ev.to + ' declared') +
          ctxKv('schemas', (ev.tokens > 0 ? '+' : '\\u2212') + fmtCompact(Math.abs(ev.tokens || 0)) + ' tokens (\\u2248) in every request from here on');
      } else if (ev.kind === 'system') {
        h += ctxKv('system', (ev.tokens > 0 ? '+' : '\\u2212') + fmtCompact(Math.abs(ev.tokens || 0)) + ' tokens (\\u2248) \\u2014 the system prompt the harness sends changed');
      }
      return h;
    }

    // Browser fold state survives re-renders: category opens by cat id,
    // item opens by "cat:index" (a live pair appends steps; the browsed
    // step's items are stable for a picked pair).
    const ctxOpenItems = {};
    // Scrubbing the history chart walks a different request body per bar;
    // a one-slot cache re-walked the SAME bodies on every pass back. Small
    // LRU instead — the walk is an index over blocks already in memory, so
    // a handful of them is cheap, and the thrash is gone.
    const ctxGraphCache = new Map();
    const CTX_GRAPH_KEEP = 12;
    let ctxGraphAt = null;   // pairId the graph pane currently shows
    // Provenance for the pane rows: the current thread's spine with its
    // turn sigs (computed once per spine length) and the graph pair's
    // window turns (one slot — the pane renders many rows against one
    // window). ctxCurThread lets the provenance link re-render the view.
    let ctxSince = null;
    let ctxCurThread = null;
    // "since turn 04 · step 2": the request that first carried this row's
    // turn into the window (semantica's provenance trail, cctrace-style:
    // an origin is a wire request). Content-verified against the spine
    // (ctxOriginTurn). A user-role turn — the prompt, a tool result, an
    // injection — entered with the NEXT request, whose reply is the step
    // named ("since"); an assistant turn IS a step's reply ("from").
    // Envelope rows (system, schemas) have no turn and say nothing.
    function ctxSinceHtml(node) {
      const o = ctxOriginOf(node);
      if (!o) return '';
      return '<span class="cx-since" role="button" tabindex="0" data-cxpin="' + escapeHtml(o.pid) + '" data-tip="' +
        escapeHtml((o.verb === 'from' ? 'the reply of ' : 'in the window since ') + o.lbl + ' \\u2014 the request that first carried it') +
        '\\n> click to pin that step">' + o.verb + ' ' + escapeHtml(o.lbl) + '</span>';
    }
    // The resolution behind that chip, shared with the inspector's origin
    // facet: { pid, verb, lbl } — the carrying request, "since" (a turn
    // that entered with it) or "from" (a reply that IS its step), and
    // the turn address — or null when the wire does not say.
    function ctxOriginOf(node) {
      const c = ctxSince;
      if (!c || !ctxGraphAt) return null;
      let n = node;
      while (n && !n.item && n.kids && n.kids.length) n = n.kids[0];
      const it = n && n.item;
      if (!it || it.ti == null || it.ti < 0) return null;
      if (c.winPair !== ctxGraphAt) {
        const p = pairOf(ctxGraphAt);
        c.win = p ? ctxWindowTurns(p) : [];
        c.winPair = ctxGraphAt;
        // Where this request's window ENDS in the spine: the reply it
        // produced (anchors the content match — see ctxOriginTurn).
        let end = c.spine.length;
        for (let i = 0; i < c.spine.length; i++) { const tt = c.spine[i]; if (tt && tt.role === 'assistant' && tt.pairId === ctxGraphAt) { end = i; break; } }
        c.winEnd = end;
      }
      const vi = ctxOriginTurn(c.spine, c.win, it.ti, c.sigs, c.winEnd);
      if (vi < 0) return null;
      const origin = c.spine[vi];
      let pid = null;
      if (origin.role === 'assistant') {
        // A reply is its own step — an unattributed one names nothing
        // rather than borrowing the next step's address.
        if (origin.pairId && c.addr[origin.pairId]) pid = origin.pairId;
      } else {
        for (let i = vi; i < c.spine.length && !pid; i++) {
          const tt = c.spine[i];
          if (tt && tt.role === 'assistant' && tt.pairId && c.addr[tt.pairId]) pid = tt.pairId;
        }
      }
      if (!pid) return null;
      const lbl = ctxOrdLbl(c.addr, pid);
      if (!lbl) return null;
      const verb = c.spine[vi].role === 'assistant' ? 'from' : 'since';
      return { pid, verb, lbl };
    }
    function ctxGraphOf(pairId) {
      let g = ctxGraphCache.get(pairId);
      if (g === undefined) {
        const p = pairOf(pairId);
        g = p ? contextGraph(p) : null;
        ctxGraphCache.set(pairId, g);
        while (ctxGraphCache.size > CTX_GRAPH_KEEP) ctxGraphCache.delete(ctxGraphCache.keys().next().value);
      }
      return g;
    }

    // The step the browser (and the detail strip) shows when nothing is
    // hovered: the pinned bar, else the newest non-failed step.
    function ctxFocusStep(steps) {
      if (ctxPinned) { for (const s of steps) if (s.pairId === ctxPinned) return s; }
      for (let i = steps.length - 1; i >= 0; i--) if (!steps[i].failed) return steps[i];
      return steps[steps.length - 1] || null;
    }

    // ---- the margin: the balance, then the ledger ----
    // The sheet's totals, re-reconciled on every scrub, in a column that
    // never scrolls away. The window this thread is measured against —
    // set by renderContextView, read here so a hover repaint doesn't have
    // to re-resolve it.
    let ctxWin = 0;

    // The reconciliation: what chars/4 is worth against the number the
    // provider actually billed. This is the check the sheet owes — on
    // code-heavy bodies the estimate reads well under, and saying so is
    // the honest form of showing both numbers.
    function ctxReconLine(s) {
      if (!s) return '';
      if (s.stub) return 'request body folded by cctrace <b>compact</b> \\u2014 composition gone, usage kept';
      if (s.actualIn == null) {
        return s.failed ? 'request <b>failed</b> \\u2014 the bar shows what was sent, never answered'
          : 'no usage reported \\u2014 the bar is the estimate alone';
      }
      if (!s.est) return '';
      const d = (s.est - s.actualIn) / s.actualIn * 100;
      const est = '\\u2248' + fmtCompact(s.est) + ' estimated \\u00b7 chars/4 ';
      if (Math.abs(d) < 2) return est + '<b>matches</b> the bill';
      return est + 'reads <b>' + Math.abs(Math.round(d)) + '% ' + (d < 0 ? 'under' : 'over') + '</b>';
    }

    function renderCtxMargin(s, addr) {
      if (!s) return '<div class="cx-note">nothing to reconcile yet</div>';
      const at = ctxOrdLbl(addr, s.pairId);
      const total = ctxStepTotal(s);
      const pctWin = ctxWin ? Math.min(100, (total / ctxWin) * 100) : 0;
      // The headline is the provider's number when the wire reported one;
      // the estimate only when it is all we have, and then it wears the
      // \u2248 that says so.
      const known = s.actualIn != null;
      let h = '<div class="cx-mblock"><div class="cx-bal">' +
        '<span class="cx-bal-n">' + (known ? '' : '\\u2248') + fmtCompact(total) +
        '<span class="cx-bal-u">' + (known ? 'prompt tokens' : 'estimated') + '</span></span>' +
        '<span class="cx-bal-d">' + escapeHtml((at || 'wire request') + (s.model ? ' \\u00b7 ' + shortModel(s.model) : '')) + '</span>';
      // the bar: six segments against the window when we know it, against
      // themselves when we do not — never a made-up denominator
      const segW = ctxWin ? pctWin : 100;
      let segs = '';
      if (s.sums && s.est) {
        for (const c of CTX_CATS) {
          const v = s.sums[c.id];
          if (!v) continue;
          segs += '<span class="cx-seg" style="width:' + ((v / s.est) * segW).toFixed(2) + '%;background:' + c.color + '"></span>';
        }
      } else segs = '<span class="cx-seg" style="width:' + segW.toFixed(2) + '%;background:var(--border)"></span>';
      h += '<div class="cx-bar">' + segs + '</div>' +
        '<div class="cx-bal-foot">' +
        (ctxWin ? '<span class="cx-bal-pct">' + Math.round(pctWin) + '% of context used</span>' : '<span class="cx-bal-pct">window unknown</span>') +
        (ctxWin ? '<span class="cx-bal-win">of ' + fmtCompact(ctxWin) + '</span>' : '') +
        '</div>';
      const recon = ctxReconLine(s);
      if (recon) h += '<div class="cx-recon">' + recon + '</div>';
      h += '</div></div>';

      // ---- the ledger: six lines, each one a zoom into the graph ----
      if (s.sums && s.est) {
        h += '<div class="cx-mblock"><div class="cx-mlabel">composition<span class="cx-mlabel-r">click a line to zoom the graph</span></div>';
        for (const c of CTX_CATS) {
          const v = s.sums[c.id];
          const pct = (v / s.est) * 100;
          const tip = c.label + '\\n\\u2248' + fmtCompact(v) + ' \\u00b7 ' + (pct >= 0.5 ? Math.round(pct) + '%' : '<1%') + ' of this request' +
            '\\n---\\n> click to zoom the graph to this category';
          h += '<a class="cx-crow' + (ctxFocusKey === 'c:' + c.id ? ' sel' : '') + '" href="#"' +
            ' data-cxnode="c:' + c.id + '" data-cxkids="' + (v ? 1 : 0) + '" data-tip="' + escapeHtml(tip) + '">' +
            '<span class="cx-crow-label"><span class="cx-dot" style="--cx:' + c.color + '"></span><span>' + c.label + '</span></span>' +
            '<span class="cx-track"><span class="cx-fill" style="--cx:' + c.color + ';width:' + Math.min(100, pct).toFixed(1) + '%"></span></span>' +
            '<span class="cx-crow-n">\\u2248' + fmtCompact(v) + '</span>' +
            '<span class="cx-crow-pct">' + (pct >= 0.5 ? Math.round(pct) + '%' : v ? '&lt;1%' : '0%') + '</span></a>';
        }
        h += '</div>';
      }

      // ---- this step: the reference line, and the way out to the wire ----
      // What it cost leads, because that is the reading this block gained:
      // the bill and the share of it the cache carried, in one line. The
      // cache share is stated HERE and nowhere else in the block — an
      // unpriced step keeps the bare chip instead.
      const sc = stepCost(pairOf(s.pairId));
      const cachePct = s.cacheRead > 0 && s.actualIn ? Math.round((s.cacheRead / s.actualIn) * 100) : null;
      const costLine = sc && sc.total > 0
        ? '<span class="cx-dt" data-tip="' + escapeHtml(costTitle(sc) + '\\n---\\n> every dollar is an estimate from catalog rates') + '">' +
          '\\u2248' + fmtCost(sc.total) + ' this step' +
          (cachePct != null ? ' \\u00b7 ' + cachePct + '% from cache' : s.actualIn != null ? ' \\u00b7 cold, nothing from cache' : '') +
          '</span>'
        : '';
      h += '<div class="cx-mblock"><div class="cx-mlabel">this step</div>' +
        '<div class="cx-dhead">' + costLine +
        (s.t ? '<span>' + fmtTime(new Date(s.t * 1000)) + '</span>' : '') +
        (s.actualIn != null ? '<span>output ' + fmtCompact(s.out) + '</span>' : '') +
        (costLine ? ''
          : cachePct != null ? '<span class="ok">' + cachePct + '% cached</span>'
          : s.actualIn != null ? '<span class="warn">cold \\u2014 no cache read</span>' : '') +
        ctxTurnLink(s, addr) +
        '<a class="turn-wire" href="#/p/' + encodeURIComponent(s.pairId) + '">wire \\u2192</a>' +
        '</div></div>';

      // top tool schemas: where the tools budget goes, in the margin
      // because it is a standing cost, not an event
      const fp = pairOf(s.pairId);
      if (fp && !s.stub) {
        try {
          const env = ctxEnvelope(fp.request.body || {}, wireDialect(fp) || 'anthropic');
          const ranked = env.tools.slice().sort((a, b) => b.tokens - a.tokens).slice(0, 5);
          if (ranked.length) {
            h += '<div class="cx-mblock"><div class="cx-mlabel">heaviest tool schemas<span class="cx-mlabel-r">of ' + env.tools.length + '</span></div>' +
              '<div class="cx-topt">' + ranked.map(x => escapeHtml(x.name) + ' <b>\\u2248' + fmtCompact(x.tokens) + '</b>').join('<br>') + '</div></div>';
          }
        } catch (e) { /* an unparseable envelope costs the block, never the page */ }
      }
      return h;
    }

    // The events deck's filter chips live in the deck bar, beside the mode
    // buttons — the same place every other deck's controls sit.
    function ctxEventChips(events) {
      const kinds = {};
      for (const ev of events) kinds[ev.kind] = (kinds[ev.kind] || 0) + 1;
      let chips = '<button class="cx-fchip' + (ctxEvFilter === 'all' ? ' active' : '') + '" data-evf="all">all ' + events.length + '</button>';
      for (const k of ['inject', 'compact', 'cost', 'model', 'tools', 'system']) {
        if (!kinds[k]) continue;
        chips += '<button class="cx-fchip' + (ctxEvFilter === k ? ' active' : '') + '" data-evf="' + k + '">' + k + ' ' + kinds[k] + '</button>';
      }
      return chips;
    }

    // An event's glyph and its one-line label — shared by the events rows
    // and the inspector's head, so a picked event is named the same way
    // in both places.
    const CX_EV_GLYPH = { inject: '+', compact: '\\u2702', model: '\\u21c4', tools: '\\u00b1', system: '\\u00b1', cost: '$' };
    function ctxEvLabel(ev) {
      if (ev.kind === 'inject') return ev.label || 'context';
      if (ev.kind === 'compact') {
        return (ev.mode === 'rewind' ? 'history rewound' : ev.mode === 'rewrite' ? 'context rewritten (continuation summary)' : 'context compacted') +
          (ev.fromTurns ? ' \\u00b7 ' + ev.fromTurns + ' \\u2192 ' + ev.toTurns + ' turns' : '');
      }
      if (ev.kind === 'model') return shortModel(ev.from) + ' \\u2192 ' + shortModel(ev.to);
      if (ev.kind === 'tools') return 'tool schemas \\u00b7 ' + ev.from + ' \\u2192 ' + ev.to + ' tools';
      if (ev.kind === 'system') return 'system prompt changed';
      if (ev.kind === 'cost') return ctxBumpLabel(ev);
      return ev.kind;
    }

    function renderCtxEvents(events, addr) {
      const list = events.filter(ev => ctxEvFilter === 'all' || ev.kind === ctxEvFilter);
      // Newest first — the question is "what just changed my window".
      // A recurring injector (the per-step token-budget banner fires on
      // EVERY step) would otherwise bury the events that only happened
      // once. Adjacent runs of the same kind+label collapse into one row:
      // \u00d7N, the summed delta, the span. Chronology survives, because a
      // genuinely different event between two occurrences breaks the run.
      const rolled = [];
      for (let i = list.length - 1; i >= 0; i--) {
        const ev = list[i];
        const key = ev.kind + '|' + (ev.label || '') + '|' + (ev.mode || '') + '|' + (ev.cause || '');
        const top = rolled[rolled.length - 1];
        if (top && top.key === key) {
          top.n++;
          top.tokens += ev.tokens || 0;
          top.extra += ev.extra || 0;
          top.t0 = ev.t;
          continue;
        }
        rolled.push({ key, ev, n: 1, tokens: ev.tokens || 0, extra: ev.extra || 0, t0: ev.t });
      }
      ctxEvRolled = rolled; // the inspector resolves a picked row against this
      let rows = '';
      const CAP = 200;
      for (let n = 0; n < rolled.length && n < CAP; n++) {
        const run = rolled[n];
        const ev = run.ev;
        const glyph = CX_EV_GLYPH[ev.kind] || '+';
        const label = ctxEvLabel(ev);
        // A cost bump: the same row grammar, but the delta slot carries
        // DOLLARS \u2014 what the step paid over a warm cache, which is the
        // thing the reader is hunting. The cause is a wire fact; the
        // amount is an estimate and says so on hover.
        const delta = ev.kind === 'model' || ev.kind === 'cost' ? 0 : run.tokens;
        const at = ctxOrdLbl(addr, ev.pairId);
        const money = ev.kind === 'cost'
          ? '<span class="cx-delta plus">\\u2248+' + fmtCost(run.extra) + '</span>'
          : '';
        const tip = (ev.kind === 'cost'
          ? label + '\\n' + run.tokens.toLocaleString() +
            ' tokens re-billed at input/write rate that a warm cache would have read; \\u2248' +
            fmtCost(run.extra) + ' is the difference' +
            (ev.hitPct != null ? '\\n' + ev.hitPct + '% of this prompt came from cache' : '')
          : label) + (run.n > 1
          ? '\\n' + run.n + ' occurrences, most recent shown' +
            (run.t0 && run.t0 !== ev.t ? '\\n' + fmtTime(new Date(run.t0 * 1000)) + ' \\u2192 ' + fmtTime(new Date(ev.t * 1000)) : '') +
            (run.tokens ? '\\n' + fmtCompact(Math.abs(run.tokens)) + ' tokens in total' : '')
          : '');
        // The delta rides WITH the label: it is what this event did to the
        // window (content), not how it travelled (transport). \u00d7N, the
        // turn address and the clock hold the right edge \u2014 ui.md's row
        // grammar. A delta parked 800px from its own label is a saccade,
        // not a column.
        // The row is a PICK: it opens the event in the inspector (the
        // injected text, a compaction's before/after, a bump's cause).
        const picked = ctxEvSel && ctxEvSel.key === run.key && ctxEvSel.pairId === ev.pairId;
        rows += '<div class="cx-ev' + (picked ? ' sel' : '') + '" data-cxev="' + n + '">' +
          '<span class="cx-ev-glyph">' + glyph + '</span>' +
          '<span class="cx-ev-kind">' + (ev.kind === 'compact' && ev.mode === 'rewind' ? 'rewind' : ev.kind) + '</span>' +
          '<span class="cx-ev-label" data-tip="' + escapeHtml(tip) + '">' + escapeHtml(label) + '</span>' +
          (money ? money
            : delta ? '<span class="cx-delta ' + (delta > 0 ? 'plus' : 'minus') + '">' + (delta > 0 ? '+' : '\\u2212') + fmtCompact(Math.abs(delta)) + '</span>'
            : '<span class="cx-delta"></span>') +
          '<span class="cx-ev-gap"></span>' +
          (run.n > 1 ? '<span class="cx-ev-n">\\u00d7' + run.n + '</span>' : '') +
          '<span class="cx-ev-at"><a href="#/p/' + encodeURIComponent(ev.pairId) + '" title="open the wire request">' + escapeHtml(at || 'wire') + '</a></span>' +
          (ev.t ? '<span class="cx-ev-time">' + fmtTime(new Date(ev.t * 1000)) + '</span>' : '') +
          '</div>';
      }
      if (!rows) rows = '<div class="cx-more">no context events' + (ctxEvFilter !== 'all' ? ' of this kind' : '') + (ctxRange ? ' in this range' : '') + '</div>';
      if (rolled.length > CAP) rows += '<div class="cx-more">+' + (rolled.length - CAP) + ' older rows not shown</div>';
      return rows;
    }

    function ctxItemBody(it) {
      if (it.kind === 'tool') {
        const d = it.b && it.b.description ? '<div class="block-note">' + escapeHtml(String(it.b.description).slice(0, 600)) + '</div>' : '';
        return d + preBlock(formatJson(it.b));
      }
      try { return renderBlock(it.b, false); } catch (e) { return brokenItem('context item', '', e); }
    }

    // ---- the context graph ----
    // The assembled window as a weighted tree: category -> group -> item,
    // every node bar drawn on ONE scale (share of this request), so the
    // nesting sums visually and "what is eating my context" is a scan.
    // (This was the "context browser"; it never browsed anything — it
    // decomposes a single request, and the shape IS the answer.)
    // Returns an HTML fragment, not text: "<1%" written raw would parse
    // as the start of a tag (the fragment checker caught exactly that).
    function ctxPctStr(tokens, est) {
      if (!est) return '';
      const p = (tokens / est) * 100;
      return p >= 0.5 ? Math.round(p) + '%' : tokens ? '&lt;1%' : '0%';
    }

    // Depth tints: each level fades toward the surface, so the hierarchy
    // reads without a second hue. Capped at a TINT (never the raw data
    // color) because these nodes carry text and var(--text) has to stay
    // legible on them in both themes — full saturation stays the
    // composition bar's job, which carries no text. The full-strength hue
    // is still stated, as a 2px left edge on every node.
    const CX_TINT = [62, 62, 44, 28];
    function ctxNodeBg(color, depth) {
      if (!color) return 'var(--bg-surface)';
      return 'color-mix(in srgb, ' + color + ' ' + (CX_TINT[depth] || 28) + '%, var(--bg-surface))';
    }

    function ctxFlameTip(n) {
      const bits = [n.label];
      if (n.tail) {
        bits.push(n.tail + ' nodes too thin to draw \\u2014 \\u2248' + fmtCompact(n.tokens) + ' between them');
        bits.push('they are counted here, never dropped');
        return bits.join('\\n');
      }
      bits.push('\\u2248' + fmtCompact(n.tokens) + ' \\u00b7 ' + ctxPctStr(n.tokens, ctxFlameTotal) + ' of this request');
      if (n.n > 1) bits.push(n.n + ' items');
      if (n.err) bits.push(n.err + ' returned is_error');
      bits.push('---');
      bits.push(n.root ? '> the whole of what you are looking at'
        : n.hasKids ? '> click to zoom in' : '> click to open it in the inspector');
      return bits.join('\\n');
    }

    // ---- the context graph ----
    // An ICICLE: rows top-down, width = tokens, every child inside its
    // parent's span. The flame-graph idiom, because "what is eating my
    // context window" IS a profiling question and this audience reads
    // profiles natively. Row 1 is the six categories in CTX_CATS order —
    // the same six the composition bar above shows, in the same order and
    // the same hues: the graph IS that bar growing downward into its
    // parts, which is why it belongs to this page and not to a chart
    // library. Click a node to zoom, the breadcrumb to come back, a leaf
    // to open its exact bytes underneath.
    let ctxFlameTotal = 0;
    // What the graph pane currently shows, so zoom/select can repaint it
    // in place without going back through the whole view render.
    let ctxLast = { step: null, addr: null };
    function renderCtxGraph(s, addr) {
      ctxGraphAt = s ? s.pairId : null;
      ctxLast = { step: s, addr };
      if (!s) return '<div class="cx-note">nothing to open yet</div>';
      if (s.stub) {
        return '<div class="cx-note">this step\\u2019s request body was folded by cctrace compact \\u2014 its composition is gone (the kept request of the epoch holds the full history)' +
          (s.actualIn != null ? ' \\u00b7 actual prompt ' + fmtCompact(s.actualIn) : '') + '</div>';
      }
      const g = ctxGraphOf(s.pairId);
      if (!g || !g.est) return '<div class="cx-note">request not loaded</div>';
      ctxFlameTotal = g.est;
      // No head here. The margin beside this chart already names the step,
      // its estimate, its billed prompt and both links — a second copy is
      // the third-rendering habit this layout exists to break.
      let h = '';

      const fl = ctxFlameLayout(g, { sort: ctxSort, focus: ctxFocusKey });
      // A focus key that no longer resolves (the picked step changed) fell
      // back to the root — say so by dropping the stale key, so the next
      // click starts from where the reader actually is.
      if (ctxFocusKey && fl.focus.key !== ctxFocusKey) ctxFocusKey = '';
      // Resolve the selection BEFORE drawing, so the selected node wears its
      // outline on the first paint. A key from another step (scrubbing the
      // history chart) falls back to the heaviest group \u2014 the section opens
      // ON the answer instead of asking the reader to go find it.
      if (!ctxSelKey || !ctxFlameFind(fl.root, ctxSelKey)) ctxSelKey = ctxFlameDefault(g);
      // breadcrumb: the zoom's way home, one clickable segment per level
      let crumbs = '';
      for (let i = 0; i < fl.path.length; i++) {
        const p = fl.path[i];
        crumbs += (i ? '<span class="cx-crumb-sep">\\u203a</span>' : '') +
          (i === fl.path.length - 1
            ? '<span class="cx-crumb cur">' + escapeHtml(p.label) + '</span>'
            : '<a class="cx-crumb" href="#" data-cxzoom="' + escapeHtml(p.key) + '">' + escapeHtml(p.label) + '</a>');
      }
      // Only when zoomed: at the root the crumb is one unclickable word
      // that row 0 of the graph already says.
      if (fl.path.length > 1) {
        h += '<div class="cx-crumbs">' + crumbs +
          '<span class="cx-crumb-hint">zoomed \\u2014 percentages stay against the whole request</span></div>';
      }

      let flame = '';
      for (let r = 0; r < fl.rows.length; r++) {
        let cells = '';
        for (const n of fl.rows[r]) {
          const sel = n.key === ctxSelKey;
          cells += '<span class="cx-fn' + (sel ? ' sel' : '') + (n.tail ? ' tailn' : '') + (n.err && !n.hasKids ? ' errn' : '') + '"' +
            ' style="left:' + n.x.toFixed(3) + '%;width:' + n.w.toFixed(3) + '%;' +
            'background:' + ctxNodeBg(n.color, r === 0 ? 1 : r) +
            (n.color ? ';box-shadow:inset 2px 0 0 ' + n.color + ',inset -1px 0 0 var(--bg)' : '') + '"' +
            // Keyboard reaches the nodes that can say what they are; the
            // slivers are reached by zooming their parent, which is what
            // zoom is for. 75 labelled tab stops beats 400 unlabelled ones.
            (n.tail ? '' : ' data-cxnode="' + escapeHtml(n.key) + '" data-cxkids="' + (n.hasKids ? 1 : 0) + '"' +
              (n.lbl ? ' tabindex="0" role="button"' : '')) +
            ' data-tip="' + escapeHtml(ctxFlameTip(r === 0 ? { ...n, root: 1 } : n)) + '">' +
            (n.lbl ? '<span class="cx-fn-l">' + escapeHtml(n.label) + '</span>' +
              // Metrics drop before the label does: a node clipped to "F"
              // says nothing, and the hover carries every number anyway.
              (n.n > 1 && !n.tail && n.w >= 14 ? '<span class="cx-fn-n">\\u00d7' + n.n + '</span>' : '') +
              (n.w >= 10 ? '<span class="cx-fn-t">\\u2248' + fmtCompact(n.tokens) + '</span>' : '') : '') +
            '</span>';
        }
        flame += '<div class="cx-frow" style="z-index:' + (9 - r) + '">' + cells + '</div>';
      }
      h += '<div class="cx-flame">' + flame + '</div>';
      // The picked node opens in the INSPECTOR beside the graph, not under
      // it — the layout is kept so the inspector can resolve the pick.
      ctxLastFl = fl;
      return h;
    }

    // The picked node, opened — the inspector's content facet on the
    // window deck. A leaf gives its exact bytes; a group gives its items
    // as folds; a container gives its children ranked, each one click
    // from a zoom. Selection defaults to the heaviest group, so the panel
    // opens ON the answer instead of asking the reader to go find it.
    // The inspector's head already names the node, its count and its
    // weight, so this is the body alone.
    function renderCtxPane(fl) {
      const path = fl && ctxSelKey ? ctxFlameFind(fl.root, ctxSelKey) : null;
      const hit = path && path[path.length - 1];
      if (!hit) return '<div class="cx-note">pick a node in the graph to open it</div>';
      const head = '';
      // a leaf: its exact bytes, already open — that is what was asked for
      if (hit.item) {
        let body = '';
        try { body = ctxItemBody(hit.item); } catch (e) { body = brokenItem('context item', '', e); }
        return '<div class="cx-pane-body">' + body + '</div>';
      }
      const kids = hit.kids || [];
      if (!kids.length) return '<div class="cx-note">nothing under this node</div>';
      // a group: its items as lazy folds (a category: its groups, ranked)
      if (kids[0].item || !(kids[0].kids || []).length) {
        // The graph is the answer; the pane is the drill-down. Dumping 177
        // rows under a 72px chart would put the flat list back, so: the
        // heaviest handful, said out loud, and every other node is one
        // click away IN the graph.
        const CAP = 15;
        const ranked = kids.slice().sort((a, b) => b.tokens - a.tokens);
        // Shed what the pane head already says: under a group called
        // "Bash", 15 rows of "tool_result | Bash -> ..." is one fact
        // repeated 30 times. The kind column survives only where it
        // VARIES (an assistant turn mixes text/thinking/tool_use).
        const kinds = {};
        for (const k of kids) kinds[(k.item && k.item.kind) || 'item'] = 1;
        const showKind = Object.keys(kinds).length > 1;
        let rows = '';
        for (let i = 0; i < ranked.length && i < CAP; i++) {
          const k = ranked[i];
          const open = ctxOpenItems[k.key];
          const lbl = k.label;
          rows += '<details class="fold cx-item' + (k.err ? ' cx-item-err' : '') + '"' + (open ? ' open' : '') +
            ' data-cxitem="' + escapeHtml(k.key) + '">' +
            '<summary>' + (showKind ? '<span class="fold-title">' + escapeHtml((k.item && k.item.kind) || 'item') + '</span>' : '') +
            '<span class="fold-hint">' + escapeHtml(lbl) + '</span>' +
            '<span class="cx-item-n">\\u2248' + fmtCompact(k.tokens) + '</span>' +
            '<span class="cx-prow-gap"></span>' + ctxSinceHtml(k) +
            '</summary><div class="fold-body" data-cxlazy="1"></div></details>';
        }
        if (ranked.length > CAP) rows += '<div class="cx-more">the ' + CAP + ' heaviest of ' + ranked.length +
          ' \\u2014 pick any node in the graph to open it</div>';
        return head + rows;
      }
      let rows = '';
      const ranked = kids.slice().sort((a, b) => b.tokens - a.tokens);
      for (const k of ranked.slice(0, 40)) {
        rows += '<a class="cx-prow" href="#" data-cxzoom="' + escapeHtml(k.key) + '">' +
          '<span class="cx-prow-l">' + escapeHtml(k.label) + '</span>' +
          (k.n > 1 ? '<span class="cx-fn-n">×' + k.n + '</span>' : '') +
          '<span class="cx-wt"><span class="cx-wf" style="width:' + (hit.tokens ? Math.min(100, (k.tokens / hit.tokens) * 100) : 0).toFixed(2) + '%;background:' + (k.color || 'var(--text-faint)') + '"></span></span>' +
          '<span class="cx-item-n">≈' + fmtCompact(k.tokens) + ' · ' + ctxPctStr(k.tokens, ctxFlameTotal) + '</span>' +
          '<span class="cx-prow-gap"></span>' + ctxSinceHtml(k) + '</a>';
      }
      if (ranked.length > 40) rows += '<div class="cx-more">+' + (ranked.length - 40) + ' more</div>';
      return head + rows;
    }

    // Fill a pane item's body on first expand — one tool-result group can
    // hold a megabyte; only what the reader opens is rendered. Keys are the
    // flame's node keys, stable across steps, so what you opened stays open
    // while you scrub the history chart.
    // The provenance link pins the step it names (a path chip is a focus
    // control, not a picture). Capture phase: the link sits inside a zoom
    // row / a fold summary, and pinning must win over zooming or toggling.
    const ctxPinFromLink = (e) => {
      const a = e.target && e.target.closest ? e.target.closest('[data-cxpin]') : null;
      if (!a || (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      e.stopPropagation();
      if (!ctxCurThread) return;
      ctxPinned = a.dataset.cxpin;
      renderContextView(ctxCurThread);
    };
    contextEl.addEventListener('click', ctxPinFromLink, true);
    contextEl.addEventListener('keydown', ctxPinFromLink, true);
    contextEl.addEventListener('toggle', (e) => {
      const det = e.target;
      if (!det || !det.dataset || !det.dataset.cxitem) return;
      ctxOpenItems[det.dataset.cxitem] = det.open;
      if (!det.open) return;
      const body = det.querySelector(':scope > .fold-body');
      if (!body || body.dataset.filled) return;
      const g = ctxGraphAt ? ctxGraphOf(ctxGraphAt) : null;
      if (!g) return;
      const node = ctxFlameFind(ctxFlameTree(g, ctxSort !== 'order'), det.dataset.cxitem);
      const it = node && node[node.length - 1].item;
      if (!it) return;
      body.dataset.filled = '1';
      try { body.innerHTML = ctxItemBody(it); }
      catch (err) { body.innerHTML = brokenItem('context item', '', err); }
    }, true);

    // Zoom + select. One delegated listener on the section, because the
    // flame re-renders on every hover-scrub and per-node handlers would be
    // rebound hundreds of times a second.
    contextEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const t = e.target && e.target.dataset && e.target.dataset.cxnode != null ? e.target : null;
      if (!t) return;
      e.preventDefault();
      t.click();
    });
    contextEl.addEventListener('click', (e) => {
      const t = e.target && e.target.closest ? e.target.closest('[data-cxzoom],[data-cxnode]') : null;
      if (!t) return;
      e.preventDefault();
      if (t.dataset.cxzoom != null) {
        ctxFocusKey = t.dataset.cxzoom === 'root' ? '' : t.dataset.cxzoom;
      } else {
        // A node with children zooms; a leaf opens. Both select, so the
        // pane always names where you are.
        ctxSelKey = t.dataset.cxnode;
        if (t.dataset.cxkids === '1') ctxFocusKey = t.dataset.cxnode;
      }
      // A ledger line is a control on the GRAPH, and the margin is beside
      // every deck. Clicking one from the stream or the events deck asks
      // to see that category — so it brings the window deck with it.
      if (ctxMode !== 'window' && ctxCurThread) {
        setCtxMode('window');
        renderContextView(ctxCurThread);
        return;
      }
      const gr = document.getElementById('cx-graph');
      if (gr && ctxLast.step) {
        // the margin beside the graph did not move; the inspector repaints
        // for the new pick below (its own scroll resets when the pick
        // changed, and only then)
        const tops = ctxCaptureTops();
        gr.innerHTML = renderCtxGraph(ctxLast.step, ctxLast.addr);
        ctxRestoreTops(tops);
      }
      // a pick opens the inspector — a zoom on a container too, since the
      // panel then lists that container's children ranked
      ctxInspOpen = true;
      ctxRepaintInsp();
      // the ledger row wears the zoom too — margin and chart are one
      // selection, whichever side the click came from
      if (ctxLast.step) ctxRepaintMargin(ctxLast.step, ctxLast.addr);
      tipDetachedGuard(); // the node under the cursor was just replaced
    });

    // ---- threads in this trace (the multi-session picker) ----
    // One trace routinely holds several sessions (a /clear rotates the sid,
    // a resume merges a prior run) and each session several threads (the
    // chat, its subagents, utility probes). The context tab used to show
    // exactly one of them with no way across; this strip is both the
    // switcher and the comparison: peak assembled context per thread, all
    // bars on ONE scale, so "which session is running hot" is a glance.
    // Peaks are provider-reported prompt tokens; the % is against each
    // thread's OWN model window (per-model correct), the bar against the
    // largest peak on show (comparable).
    function renderCtxThreads(threads, sel) {
      const live = threads.filter(x => (x.pairIds || []).length);
      if (live.length < 2) return '';
      const stats = {};
      let scale = 1;
      for (const x of live) {
        const st = ctxThreadStat(x);
        stats[x.key] = st;
        if (st.peak > scale) scale = st.peak;
      }
      const bySid = {};
      const sids = [];
      for (const x of live) {
        const sid = x.sessionId || '';
        if (!bySid[sid]) { bySid[sid] = []; sids.push(sid); }
        bySid[sid].push(x);
      }
      const lastAt = (g) => { let m = 0; for (const x of g) m = Math.max(m, x.lastAt || x.firstAt || 0); return m; };
      sids.sort((a, b) => lastAt(bySid[b]) - lastAt(bySid[a]) || (a < b ? -1 : a > b ? 1 : 0));
      let rows = '';
      for (const sid of sids) {
        const g = bySid[sid].slice().sort((a, b) => (a.firstAt || 0) - (b.firstAt || 0));
        if (sids.length > 1) {
          rows += '<div class="cx-sess"><span class="sess-sid" data-mask="sid">' + escapeHtml(sid ? sid.slice(0, 8) : 'no session id') + '</span>' +
            '<span class="cx-sess-n">' + g.length + ' thread' + (g.length === 1 ? '' : 's') + '</span>' +
            (lastAt(g) ? '<span class="cx-sess-t">' + fmtDateTime(new Date(lastAt(g) * 1000)) + '</span>' : '') + '</div>';
        }
        for (const x of g) {
          const st = stats[x.key];
          const w = ctxWindowOf(x);
          const pct = w && st.peak && st.peak <= w ? Math.round((st.peak / w) * 100) : 0;
          const tip = threadTitle(x) + '\\npeak assembled context ' + fmtCompact(st.peak) +
            (w ? ' \\u00b7 ' + pct + '% of a ' + fmtCompact(w) + ' window' : ' \\u00b7 window unknown') +
            (st.cuts ? '\\n' + st.cuts + ' compaction/rewind boundar' + (st.cuts === 1 ? 'y' : 'ies') : '') +
            '\\n---\\n> click to open this thread\\u2019s context';
          rows += '<a class="cx-th' + (x.key === sel.key ? ' selected' : '') + '" href="' + ctxHash(x.key, ctxMode) + '"' +
            ' data-tip="' + escapeHtml(tip) + '">' +
            '<span class="tkind tkind-' + x.kind + '">' + x.kind + '</span>' +
            '<span class="cx-th-label">' + escapeHtml(x.label) + '</span>' +
            '<span class="cx-th-bar"><span class="cx-th-fill" style="width:' + ((st.peak / scale) * 100).toFixed(1) + '%"></span></span>' +
            '<span class="cx-th-n">' + fmtCompact(st.peak) + '</span>' +
            '<span class="cx-th-pct">' + (pct ? pct + '%' : '\\u00b7') + '</span>' +
            '<span class="cx-th-cut">' + (st.cuts ? '\\u2702' + st.cuts : '') + '</span></a>';
        }
      }
      return '<div class="cx-mblock"><div class="cx-mlabel">other threads<span class="cx-mlabel-r">' +
        sids.length + ' session' + (sids.length === 1 ? '' : 's') + ' \\u00b7 peak, one scale</span></div>' +
        '<div class="cx-thlist">' + rows + '</div></div>';
    }

    // The scroll containers the ledger layout added: the margin itself
    // (it can outrun a short viewport), its thread list, and the graph's
    // pane. One list, so a fourth one is a one-line change and not a
    // fourth forgotten scroll reset.
    const CTX_SCROLLERS = ['cx-margin', 'cx-insp-body'];
    function ctxCaptureTops() {
      const out = {};
      for (const id of CTX_SCROLLERS) {
        const el = document.getElementById(id);
        if (el && el.scrollTop) out[id] = el.scrollTop;
      }
      const th = contextEl.querySelector('.cx-thlist');
      if (th && th.scrollTop) out.thlist = th.scrollTop;
      return out;
    }
    function ctxRestoreTops(tops) {
      if (!tops) return;
      for (const id of CTX_SCROLLERS) {
        const el = tops[id] != null && document.getElementById(id);
        if (el) el.scrollTop = tops[id];
      }
      const th = tops.thlist != null && contextEl.querySelector('.cx-thlist');
      if (th) th.scrollTop = tops.thlist;
    }

    // The margin redraws on every scrub — the balance ticking as you move
    // across the overview IS the form. Its own scroll survives (a long
    // thread list must not jump), and the threads block is left alone:
    // only the balance/ledger/step region depends on the picked step.
    function ctxRepaintMargin(s, addr) {
      const el = document.getElementById('cx-bal');
      if (!el) return;
      const box = document.getElementById('cx-margin');
      const top = box ? box.scrollTop : 0;
      el.innerHTML = renderCtxMargin(s, addr);
      if (box) box.scrollTop = top;
    }

    let ctxThreadKey = null;
    let ctxGraphTimer = 0;
    const CTX_ZOOM_MAX = 32;
    // The time track's hues: the same three the sessions thread header's
    // "time" chip already uses, so model/tools/waiting is one vocabulary —
    // and the same variables the replay strip's lanes paint with.
    const CX_TIME_C = { model: 'var(--lane-model)', tools: 'var(--lane-tools)', waiting: 'var(--lane-waiting)' };
    // The cost track's four billed components, bottom-up: cheap to
    // expensive. One ramp, not six categorical hues — the cost track must
    // never read as a second composition track.
    const CX_COST = [
      { k: 'cacheRead', lbl: 'cache read', c: 'var(--cost-read)' },
      { k: 'cacheWrite', lbl: 'cache write', c: 'var(--cost-write)' },
      { k: 'input', lbl: 'input', c: 'var(--cost-input)' },
      { k: 'output', lbl: 'output', c: 'var(--cost-output)' },
    ];

    // ---- the overview's columns ----
    // One entry per drawn column, each carrying the STEP SPAN it covers
    // (i0..i1 into the flat step list). Step granularity is 1:1; turn
    // granularity folds a working loop's steps into one column via the
    // tested aggregator. The span is what lets the brush, the dimming and
    // the range filter all speak one coordinate system regardless of which
    // granularity is on screen.
    function ctxColumns(steps, addr) {
      if (ctxGran !== 'turn') {
        return steps.map((s, i) => ({ s, i0: i, i1: i, n: 1, mark: s.mark || '', failed: s.failed ? 1 : 0, ord: (addr[s.pairId] || {}).ord, lbl: '' }));
      }
      const turns = ctxAggregateTurns(steps, addr);
      const out = [];
      let at = 0;
      for (const tb of turns) {
        const i0 = at, i1 = at + tb.steps - 1;
        at = i1 + 1;
        const s = tb.mark && !tb.last.mark ? { ...tb.last, mark: tb.mark } : tb.last;
        out.push({
          s, i0, i1, n: tb.steps, mark: tb.mark || s.mark || '', failed: tb.failed, ord: tb.ord,
          lbl: tb.ord != null ? (tb.ord + 1 < 10 ? '0' + (tb.ord + 1) : '' + (tb.ord + 1)) : '',
        });
      }
      return out;
    }

    // Per-step wall-clock, for the time track: the request's own duration
    // (model), then the gap to the next request of the same working loop —
    // tools when the reply made calls, waiting when the harness came back
    // on its own. Every figure is a wire timestamp; nothing is estimated.
    function ctxStepTime(s, split) {
      const p = pairOf(s.pairId);
      const b = (split && split.byPair && split.byPair[s.pairId]) || {};
      return { model: (p && p.duration) || 0, tools: b.tools || 0, waiting: b.waiting || 0 };
    }
    function ctxColTime(col, steps, split) {
      const out = { model: 0, tools: 0, waiting: 0 };
      for (let i = col.i0; i <= col.i1 && i < steps.length; i++) {
        const x = ctxStepTime(steps[i], split);
        out.model += x.model; out.tools += x.tools; out.waiting += x.waiting;
      }
      out.total = out.model + out.tools + out.waiting;
      return out;
    }

    // Per-step cost, for the cost track: the four billed components of one
    // request (stepCost memoizes on the pair). An unpriced model draws
    // nothing at all — never a $0 column.
    function ctxColCost(col, steps, bumpBy) {
      const out = { total: 0, cacheRead: 0, cacheWrite: 0, input: 0, output: 0, priced: 0, bump: null };
      for (let i = col.i0; i <= col.i1 && i < steps.length; i++) {
        const s = steps[i];
        const c = stepCost(pairOf(s.pairId));
        const b = bumpBy && bumpBy[s.pairId];
        // A turn column folds several steps: the bump it wears is the
        // dearest one under it, so the mark can never point at the cheap
        // one and hide the $3.
        if (b && (!out.bump || b.extra > out.bump.extra)) out.bump = b;
        if (!c) continue;
        out.priced++;
        out.total += c.total;
        out.cacheRead += c.cacheRead;
        out.cacheWrite += c.cacheWrite;
        out.input += c.input;
        out.output += c.output;
      }
      return out;
    }

    // What a cost bump reads as, in words: the wire fact first, the
    // counterfactual (what a warm cache would have saved) second. Shared
    // by the overview's tooltip and the events deck, so one bump is one
    // sentence wherever it is stated.
    function ctxBumpLabel(ev) {
      if (ev.cause === 'expired') {
        return 'cache expired \\u00b7 ' + ev.ttl + ' ttl \\u00b7 ' + fmtSpan((ev.gap || 0) * 1000) + ' idle';
      }
      if (ev.cause === 'retry') {
        return 'retry after ' + (ev.prevStatus == null ? 'a failed request'
          : ev.prevStatus >= 400 ? ev.prevStatus : 'an interrupted request');
      }
      const why = ev.causeKind === 'system' ? 'system prompt changed'
        : ev.causeKind === 'tools' ? 'tool schemas changed'
        : ev.causeKind === 'compact' ? 'the history was compacted'
        : ev.causeKind === 'model' ? 'the model changed'
        : 'cause not on the wire';
      return 'prefix changed \\u00b7 ' + why;
    }

    function ctxOut(col) { return !!ctxRange && (col.i1 < ctxRange.i0 || col.i0 > ctxRange.i1); }

    // The brush window, in column space. The range is stored in STEP
    // indices, so a turn-granularity brush covers every column whose span
    // touches it — the drawn edge never cuts a column in half.
    function ctxBrushHtml(cols) {
      if (!ctxRange || !cols.length) return '';
      let c0 = -1, c1 = -1;
      for (let i = 0; i < cols.length; i++) {
        if (cols[i].i1 >= ctxRange.i0 && cols[i].i0 <= ctxRange.i1) { if (c0 === -1) c0 = i; c1 = i; }
      }
      if (c0 === -1) return '';
      const a = (c0 / cols.length) * 100, b = ((c1 + 1) / cols.length) * 100;
      return '<span class="cx-brush-dim" style="left:0;width:' + a.toFixed(3) + '%"></span>' +
        '<span class="cx-brush-dim" style="left:' + b.toFixed(3) + '%;right:0"></span>' +
        '<span class="cx-brush-win" style="left:' + a.toFixed(3) + '%;width:' + (b - a).toFixed(3) + '%">' +
          '<span class="cx-brush-h l" data-edge="l"></span><span class="cx-brush-h r" data-edge="r"></span></span>';
    }

    // What the brush says out loud. A range that is not stated is a range
    // the reader has to infer from a rectangle.
    function ctxRangeCaption(steps, addr) {
      if (!ctxRange) return '';
      const n = ctxRange.i1 - ctxRange.i0 + 1;
      const a = ctxOrdLbl(addr, steps[ctxRange.i0].pairId);
      const b = ctxOrdLbl(addr, steps[Math.min(ctxRange.i1, steps.length - 1)].pairId);
      const span = a && b ? (a === b ? a : a + ' → ' + b) : '';
      // What the span cost — the one number a selected range owes, since
      // the balance deliberately stays with the pinned step.
      let spend = 0;
      for (let i = ctxRange.i0; i <= ctxRange.i1 && i < steps.length; i++) {
        const c = stepCost(pairOf(steps[i].pairId));
        if (c) spend += c.total;
      }
      return n + ' of ' + steps.length + ' selected' + (span ? ' · ' + span : '') +
        (spend > 0 ? ' · \\u2248' + fmtCost(spend) : '') + ' · esc clears';
    }

    function ctxTrackStyle() {
      return 'width:' + (ctxZoom > 1 ? (ctxZoom * 100).toFixed(2) : '100') + '%';
    }

    // ---- the overview ----
    // Three tracks on one x axis under one brush — what the window held,
    // where the wall-clock went, what it cost. It is the page's time
    // axis: the PIN it sets drives the balance and the window deck, the
    // RANGE it brushes scopes the stream and the events.
    function renderCtxOverview(steps, addr, cols, maxT, split, loops, bumpBy) {
      const N = cols.length;
      let maxTime = 0;
      const times = [];
      const hasTime = !!(split && split.steps > 1 && split.wall > 0);
      if (hasTime) {
        for (const c of cols) { const x = ctxColTime(c, steps, split); times.push(x); if (x.total > maxTime) maxTime = x.total; }
      }
      // The third track: what each step cost. Drawn only when the catalog
      // priced at least one step of this thread — a track of empty columns
      // states nothing.
      // The scale is the dearest column that is NOT a bump. A bump is an
      // outlier by definition (one $6.85 step over 262 at ~$0.20), and
      // scaling to it flattens the trend the track exists to show. A bump
      // column clips at full height instead: it already wears the $ mark
      // and its tooltip states the real figure and that it is off scale.
      let maxCost = 0, maxAll = 0;
      const spend = [];
      for (const c of cols) {
        const x = ctxColCost(c, steps, bumpBy);
        spend.push(x);
        if (x.total > maxAll) maxAll = x.total;
        if (!x.bump && x.total > maxCost) maxCost = x.total;
      }
      if (!maxCost) maxCost = maxAll; // every priced column is a bump: nothing to clip against
      const hasCost = maxCost > 0;
      let ctxCols = '', timeCols = '', costCols = '';
      for (let i = 0; i < N; i++) {
        const c = cols[i], s = c.s;
        const total = ctxStepTotal(s);
        const hpct = Math.max(2, (total / maxT) * 100);
        const extra = c.n > 1 ? c.n + ' steps in this turn' + (c.failed ? ' · ' + c.failed + ' failed' : '') : '';
        const out = ctxOut(c) ? ' out' : '';
        ctxCols += '<span class="cx-colw' + (s.pairId === ctxPinned ? ' pinned' : '') + (c.mark ? ' cut' : '') + out +
          '" data-cxbar="' + escapeHtml(s.pairId) + '" data-cxc="' + i + '"' +
          ' data-tip="' + escapeHtml(ctxBarTip(s, addr, extra)) + '">' +
          (c.mark ? '<span class="cx-mark">✂</span>' : '') +
          '<span class="cx-col' + (s.failed ? ' cx-col-failed' : '') + '" style="height:' + hpct.toFixed(2) + '%">' +
          ctxColSegs(s) + '</span>' +
          (c.lbl ? '<span class="cx-tlbl">' + escapeHtml(c.lbl) + '</span>' : '') + '</span>';
        if (hasCost) {
          const cc = spend[i];
          let csegs = '';
          for (const k of CX_COST) {
            if (!cc[k.k]) continue;
            csegs += '<span style="height:' + ((cc[k.k] / cc.total) * 100).toFixed(2) + '%;background:' + k.c + '"></span>';
          }
          const bits = [(ctxOrdLbl(addr, s.pairId) || 'wire request') + (s.model ? ' \\u00b7 ' + shortModel(s.model) : '')];
          if (cc.priced) {
            bits.push('\\u2248' + fmtCost(cc.total) + (c.n > 1 ? ' over ' + c.n + ' steps' : ''));
            bits.push(CX_COST.map(k => k.lbl + ' \\u2248' + fmtCost(cc[k.k])).join(' \\u00b7 '));
          } else bits.push('no catalog price for this model \\u2014 unpriced');
          if (s.cacheRead > 0 && s.actualIn) bits.push(Math.round((s.cacheRead / s.actualIn) * 100) + '% of the prompt came from cache');
          else if (s.actualIn != null) bits.push('cold \\u2014 nothing came from cache');
          if (cc.bump) bits.push(ctxBumpLabel(cc.bump) + ' \\u00b7 \\u2248' + fmtCost(cc.bump.extra) + ' over warm');
          const clipped = cc.total > maxCost;
          if (clipped) bits.push('off scale \\u2014 the track tops out at \\u2248' + fmtCost(maxCost) + ', the dearest step that was not a bump');
          costCols += '<span class="cx-cw' + out + '" data-cxbar="' + escapeHtml(s.pairId) + '" data-cxc="' + i + '"' +
            ' data-tip="' + escapeHtml(bits.join('\\n') + '\\n---\\n> every dollar is an estimate from catalog rates') + '">' +
            (cc.bump ? '<span class="cx-cmark">$</span>' : '') +
            (cc.total
              ? '<span class="cx-cb" style="height:max(2px,' + Math.min(100, (cc.total / maxCost) * 100).toFixed(2) + '%)">' + csegs + '</span>'
              : '') + '</span>';
        }
        if (!hasTime) continue;
        const x = times[i];
        let segs = '';
        for (const k of ['model', 'tools', 'waiting']) {
          if (!x[k]) continue;
          segs += '<span style="height:' + ((x[k] / x.total) * 100).toFixed(2) + '%;background:' + CX_TIME_C[k] + '"></span>';
        }
        const tip = (ctxOrdLbl(addr, s.pairId) || 'wire request') +
          (x.total ? '\\nmodel ' + fmtSpan(x.model) +
            (x.tools ? '\\ntools ' + fmtSpan(x.tools) : '') + (x.waiting ? '\\nwaiting ' + fmtSpan(x.waiting) : '')
            : '\\nno duration on the wire for this step') +
          '\\n---\\n> every figure is a wire timestamp';
        timeCols += '<span class="cx-tw' + out + '" data-cxbar="' + escapeHtml(s.pairId) + '" data-cxc="' + i + '"' +
          ' data-tip="' + escapeHtml(tip) + '">' +
          (x.total && maxTime
            ? '<span class="cx-tb" style="height:max(2px,' + ((x.total / maxTime) * 100).toFixed(2) + '%)">' + segs + '</span>'
            : '') + '</span>';
      }
      const gut = '<div class="cx-ov-gut">' +
        '<div class="cx-ov-gl" style="height:var(--cx-ov-h)"><span>' + fmtCompact(maxT) + '</span><span class="cx-ov-gn">ctx</span></div>' +
        (hasTime ? '<div class="cx-ov-gl" style="height:var(--cx-ov-th)"><span>' + fmtSpan(maxTime) + '</span><span class="cx-ov-gn">time</span></div>' : '') +
        (hasCost ? '<div class="cx-ov-gl" style="height:var(--cx-ov-ch)"><span>\\u2248' + fmtCost(maxCost) + '</span><span class="cx-ov-gn">cost</span></div>' : '') +
        '</div>';
      const tracks = '<div class="cx-ov-tracks" id="cx-tracks" style="' + ctxTrackStyle() + '">' +
        '<div class="cx-chart">' + ctxCols + '</div>' +
        (hasTime ? '<div class="cx-time">' + timeCols + '</div>' : '') +
        (hasCost ? '<div class="cx-cost">' + costCols + '</div>' : '') +
        '<div class="cx-brush" id="cx-brush">' + ctxBrushHtml(cols) + '</div>' +
        '</div>';
      const cap = steps.length + ' wire request' + (steps.length === 1 ? '' : 's') +
        ' · ' + loops + ' working loop' + (loops === 1 ? '' : 's') +
        ' · drag to select · wheel to zoom · click pins';
      const bar = '<div class="cx-ov-bar">' +
        '<span>' + escapeHtml(cap) + '</span>' +
        '<span class="cx-ov-sel" id="cx-ov-sel" data-tip="the brushed range \u2014 it scopes the stream and the events, never the balance\\n---\\n> drag inside it to move it \u00b7 drag an edge to resize \u00b7 esc clears">' +
          escapeHtml(ctxRangeCaption(steps, addr)) + '</span>' +
        '<span class="cx-ov-tools">' +
          '<button class="cx-fchip' + (ctxGran === 'step' ? ' active' : '') + '" data-cxgran="step" title="one column per wire request">step</button>' +
          '<button class="cx-fchip' + (ctxGran === 'turn' ? ' active' : '') + '" data-cxgran="turn" title="one column per working loop — its deepest step is the face">turn</button>' +
          '<button class="cx-fchip" data-cxzoomb="out" title="zoom out">−</button>' +
          '<span class="cx-ov-z" id="cx-ov-z">' + (ctxZoom > 1 ? ctxZoom.toFixed(1) + '×' : 'fit') + '</span>' +
          '<button class="cx-fchip" data-cxzoomb="in" title="zoom in">+</button>' +
          '<button class="cx-fchip" data-cxzoomb="fit" title="fit the whole thread, clear the range">reset</button>' +
        '</span></div>';
      return '<div class="cx-ov" id="cx-ov">' + bar +
        '<div class="cx-ov-body">' + gut + '<div class="cx-ov-scroll" id="cx-ov-scroll">' + tracks + '</div></div></div>';
    }

    // ---- where the thread's wall-clock went (margin block) ----
    // The time track's totals and its legend. It lives in the margin
    // because it is a standing total, not an event — and because a track
    // whose colors are never named is a decoration.
    function renderCtxTimeBlock(split) {
      if (!split || split.steps < 2 || !split.wall) return '';
      const other = Math.max(0, split.wall - split.model - split.tools - split.waiting - split.between);
      const lanes = [
        { k: 'model', v: split.model, c: CX_TIME_C.model },
        { k: 'tools', v: split.tools, c: CX_TIME_C.tools },
        { k: 'waiting', v: split.waiting, c: CX_TIME_C.waiting },
        { k: 'between turns', v: split.between, c: 'var(--border)' },
        { k: 'other', v: other, c: 'var(--border)' },
      ].filter(x => x.v > 0);
      if (!lanes.length) return '';
      const seg = lanes.map(x => '<span class="cx-lane" style="flex:' + x.v + ';background:' + x.c + '" title="' + x.k + ' ' + fmtSpan(x.v) + '"></span>').join('');
      const key = lanes.filter(x => x.k !== 'other').map(x =>
        '<span><i style="background:' + x.c + '"></i>' + x.k + ' ' + fmtSpan(x.v) + '</span>').join('');
      return '<div class="cx-mblock"><div class="cx-mlabel">where the time went<span class="cx-mlabel-r">' + fmtSpan(split.wall) + ' wall</span></div>' +
        '<div class="cx-lanes">' + seg + '</div><div class="cx-lane-key">' + key + '</div></div>';
    }

    // ---- where the thread's money went (margin block) ----
    // The cost track's totals and the legend that names its four hues,
    // then the models it was spent on, then the bumps — the steps that
    // paid twice for a prefix. Every figure is an ESTIMATE from catalog
    // rates; the block says so once, in its right label, and every number
    // wears the ≈.
    function ctxPct(v, total) {
      const p = total > 0 ? (v / total) * 100 : 0;
      return p >= 0.5 ? Math.round(p) + '%' : v > 0 ? '&lt;1%' : '0%';
    }
    function renderCtxCostBlock(cost, bumps) {
      if (!cost || !cost.steps || !(cost.total > 0)) return '';
      const parts = CX_COST.filter(x => cost[x.k] > 0);
      const seg = parts.map(x =>
        '<span class="cx-lane" style="flex:' + cost[x.k] + ';background:' + x.c + '" title="' + x.lbl + ' \\u2248' + fmtCost(cost[x.k]) + '"></span>').join('');
      const key = parts.map(x =>
        '<span><i style="background:' + x.c + '"></i>' + x.lbl + ' \\u2248' + fmtCost(cost[x.k]) + ' ' + ctxPct(cost[x.k], cost.total) + '</span>').join('');
      let h = '<div class="cx-mblock"><div class="cx-mlabel">where the money went' +
        '<span class="cx-mlabel-r">\\u2248' + fmtCost(cost.total) + ' est</span></div>' +
        '<div class="cx-lanes">' + seg + '</div><div class="cx-lane-key">' + key + '</div>';
      const models = Object.keys(cost.byModel).sort((a, b) => cost.byModel[b].total - cost.byModel[a].total);
      if (models.length > 1) {
        for (const m of models) {
          const e = cost.byModel[m];
          h += '<div class="cx-mrow"><span>' + escapeHtml(shortModel(m)) + '</span>' +
            '<span class="cx-mrow-n">\\u2248' + fmtCost(e.total) + ' \\u00b7 ' + ctxPct(e.total, cost.total) + '</span></div>';
        }
      }
      if (bumps && bumps.length) {
        let extra = 0;
        for (const b of bumps) extra += b.extra;
        const tip = 'steps that re-bought a prefix a warm cache would have read \\u2014 expired, changed, or never banked' +
          '\\n\\u2248' + fmtCost(extra) + ' is the difference against reading those tokens from cache' +
          '\\n---\\n> click to list them in the events deck';
        h += '<button class="cx-mrow" data-cxbumps="1" data-tip="' + escapeHtml(tip) + '">' +
          '<span>' + bumps.length + ' cost bump' + (bumps.length === 1 ? '' : 's') + '</span>' +
          '<span class="cx-mrow-n">\\u2248' + fmtCost(extra) + ' over warm</span></button>';
      }
      if (cost.unpriced) {
        h += '<div class="cx-mrow"><span>' + cost.unpriced + ' step' + (cost.unpriced === 1 ? '' : 's') + ' unpriced</span>' +
          '<span class="cx-mrow-n">no catalog rate</span></div>';
      }
      return h + '</div>';
    }

    // ---- quota, as the client polled it (margin block) ----
    // Claude Code asks /api/oauth/usage every ~10 minutes; the answer is
    // the only account-wide budget fact on the wire. It belongs to the
    // TRACE, not the thread, so it sits outside #cx-bal and does not
    // repaint on a scrub. Absolute reset times, never a countdown — a
    // rendered page must not go stale. Clients that never poll (codex,
    // grok, kimi, opencode) render nothing.
    function ctxHhmm(iso) {
      const d = new Date(iso);
      return isFinite(d.getTime()) ? fmtTime(d).slice(0, 5) : '';
    }
    function renderCtxQuotaBlock(polls) {
      if (!polls || !polls.length) return '';
      const last = polls[polls.length - 1];
      const first = polls[0];
      let h = '<div class="cx-mblock"><div class="cx-mlabel">quota' +
        '<span class="cx-mlabel-r">' + polls.length + ' poll' + (polls.length === 1 ? '' : 's') + '</span></div>';
      for (const l of last.limits) {
        const p = Math.max(0, Math.min(100, l.percent));
        const c = (l.severity && l.severity !== 'normal') || p >= 90 ? 'var(--red)' : p >= 75 ? 'var(--amber)' : 'var(--text-muted)';
        const at = l.resetsAt ? ctxHhmm(l.resetsAt) : '';
        h += '<div class="cx-qrow"><span class="cx-qlabel">' + escapeHtml(l.label) + '</span>' +
          '<span class="cx-track"><span class="cx-fill" style="--cx:' + c + ';width:' + p.toFixed(0) + '%"></span></span>' +
          '<span class="cx-qn">' + Math.round(l.percent) + '%</span>' +
          '<span class="cx-qr">' + (at ? 'resets ' + at : '') + '</span></div>';
      }
      if (last.credits) {
        const d = Math.pow(10, last.credits.decimalPlaces);
        h += '<div class="cx-mrow"><span>credits</span><span class="cx-mrow-n" data-mask="usage">' +
          escapeHtml((last.credits.used / d) + '/' + (last.credits.limit / d) + ' ' + last.credits.currency) + '</span></div>';
      }
      if (polls.length > 1) {
        for (const l of last.limits) {
          const f = (first.limits || []).filter(x => x.label === l.label)[0];
          if (!f || Math.round(f.percent) === Math.round(l.percent)) continue;
          h += '<div class="cx-mrow"><span>' + escapeHtml(l.label) + ' ' + Math.round(f.percent) + '% → ' +
            Math.round(l.percent) + '% over this trace</span></div>';
        }
      }
      return h + '<div class="cx-qfoot">as polled by the client at ' + fmtTime(new Date(last.t * 1000)) + '</div></div>';
    }

    // ---- the deck: three readings of one selection ----
    function ctxRangeIds(steps) {
      if (!ctxRange) return null;
      const ids = {};
      for (let i = ctxRange.i0; i <= ctxRange.i1 && i < steps.length; i++) ids[steps[i].pairId] = 1;
      return ids;
    }

    function renderContextView(t) {
      // Switching threads drops the pin, the brush and the zoom — they name
      // pairs and positions of the OLD thread. The deck, the granularity
      // and the lenses are preferences and stay.
      if (ctxThreadKey !== t.key) { ctxThreadKey = t.key; ctxPinned = null; ctxRange = null; ctxZoom = 1; }
      const d = ctxData(t);
      const tl = d.tl;
      const addr = d.addr;
      const steps = tl.steps;
      ctxCurThread = t;
      if (!ctxSince || ctxSince.key !== t.key || ctxSince.n !== t.turns.length) {
        ctxSince = { key: t.key, n: t.turns.length, spine: t.turns, sigs: t.turns.map(x => ctxTurnSig(x && x.blocks)), addr, winPair: null, win: null, winEnd: 0 };
      } else ctxSince.addr = addr;
      if (!steps.length) {
        contextEl.innerHTML = '<div class="empty">No model calls in this thread yet.</div>';
        return;
      }
      // A live capture appends steps under a held brush: clamp, never drop.
      if (ctxRange) {
        ctxRange.i0 = Math.max(0, Math.min(steps.length - 1, ctxRange.i0));
        ctxRange.i1 = Math.max(ctxRange.i0, Math.min(steps.length - 1, ctxRange.i1));
      }
      const focus = ctxFocusStep(steps);
      let win = ctxWindowOf(t);
      const anchor = focus ? ctxStepTotal(focus) : 0;
      // Sanity: a provider-reported prompt LARGER than the resolved window
      // proves the window wrong (stale catalog, an unlisted long-context
      // tier). Show no denominator rather than "100% of context used".
      if (win && anchor > win) win = 0;
      ctxWin = win;

      const split = threadTimeSplit(t, pairOf);
      const cols = ctxColumns(steps, addr);
      const maxT = Math.max(1, tl.maxTotal);
      const inIds = ctxRangeIds(steps);
      const evAll = inIds ? d.events.filter(ev => inIds[ev.pairId]) : d.events;
      // pairId -> the step's cost bump, for the overview's $ marks
      const bumpBy = {};
      for (const b of d.bumps) bumpBy[b.pairId] = b;

      // ---- head ----
      const head = '<div class="cx-head">' +
        '<span class="tkind tkind-' + t.kind + '">' + t.kind + '</span>' +
        '<span class="thread-label">' + escapeHtml(t.label) + '</span>' +
        modelChip(t) +
        (t.sessionId ? '<span class="sess-sid" data-mask="sid">' + escapeHtml(t.sessionId.slice(0, 8)) + '</span>' : '') +
        '<a class="cx-goto" href="' + threadHash(t.key) + '" title="open this thread in the sessions view">sessions →</a>' +
        '</div>';

      // ---- the deck bar + the picked deck ----
      const leveled = tjBuild(t);
      const injN = evAll.filter(ev => ev.kind === 'inject').length;
      const compEvs = evAll.filter(ev => ev.kind === 'compact');
      let reclaimed = 0;
      for (const ev of compEvs) if (ev.tokens < 0) reclaimed += -ev.tokens;
      const modeBtn = (m, n, tip) => '<button class="cx-mode' + (ctxMode === m ? ' active' : '') + '" data-cxmode="' + m + '" title="' + escapeHtml(tip) + '">' + m +
        (n != null ? '<span class="cx-mode-n">' + n + '</span>' : '') + '</button>';
      let right = '', hint = '', deck = '';
      if (ctxMode === 'stream') {
        right = renderStreamControls(leveled.hidden);
        const bounds = tjRangeBounds(inIds);
        hint = 'every record the run produced, in spine order — the harness’s injections <b>inline</b>, at the moment they entered the window' +
          (bounds ? ' · sliced to the brushed range (' + Math.max(0, bounds.hi - bounds.lo + 1) + ' of ' + tjRecs.length + ' records)' : '');
        deck = renderCtxStream(leveled, bounds);
      } else if (ctxMode === 'events') {
        right = '<span class="tj-toolbar">' + ctxEventChips(evAll) + '</span>';
        const bumpEvs = evAll.filter(ev => ev.kind === 'cost');
        let overWarm = 0;
        for (const ev of bumpEvs) overWarm += ev.extra;
        hint = [
          injN ? injN + ' injection' + (injN === 1 ? '' : 's') : '',
          compEvs.length ? compEvs.length + ' compaction' + (compEvs.length === 1 ? '' : 's') : '',
          reclaimed ? fmtCompact(reclaimed) + ' reclaimed' : '',
          bumpEvs.length ? bumpEvs.length + ' cost bump' + (bumpEvs.length === 1 ? '' : 's') + ' · ≈' + fmtCost(overWarm) + ' over warm' : '',
        ].filter(Boolean).join(' · ') || 'when and why the window grew or was reclaimed';
        deck = '<div id="cx-events">' + renderCtxEvents(evAll, addr) + '</div>';
      } else {
        right = '<span class="tj-toolbar">' +
          '<button class="cx-fchip' + (ctxSort === 'size' ? ' active' : '') + '" data-cxsort="size" title="heaviest node first — what is eating the window">by size</button>' +
          '<button class="cx-fchip' + (ctxSort === 'order' ? ' active' : '') + '" data-cxsort="order" title="wire order — how the window was assembled">in order</button>' +
          '</span>';
        hint = 'the pinned step’s window, decomposed from the captured request body — <b>exact, not reconstructed</b> · width is tokens, rows are levels · click to zoom, a leaf opens in the inspector';
        deck = '<div id="cx-graph">' + renderCtxGraph(focus, addr) + '</div>';
      }
      const bar = '<div class="cx-modes">' +
        modeBtn('window', null, 'what the model is carrying at the pinned step, decomposed') +
        modeBtn('stream', tjRecs.length, 'every record the run produced, in order — injections inline') +
        modeBtn('events', evAll.length, 'what grew or reclaimed the window') +
        '<span class="cx-mode-r">' + right + '</span></div>';

      const margin = '<aside class="cx-margin" id="cx-margin">' +
        '<div id="cx-bal">' + renderCtxMargin(focus, addr) + '</div>' +
        renderCtxCostBlock(d.cost, d.bumps) +
        renderCtxTimeBlock(split) +
        renderCtxQuotaBlock(usagePolls(pairs)) +
        renderCtxThreads(getThreads(), t) +
        '</aside>';
      // The inspector renders AFTER the deck: the window deck's pick
      // resolves against the icicle layout it just drew, the events
      // deck's against the rows it just rolled.
      ctxAddr = addr;
      const insp = renderCtxInsp();
      const canvas = '<div class="cx-canvas mode-' + ctxMode + '" id="cx-canvas">' + bar +
        '<div class="cx-deck-hint">' + hint + '</div>' +
        '<div class="cx-deck" id="cx-deck"><div class="cx-deck-main" id="cx-deck-main">' + deck + '</div>' +
        '<aside class="cx-insp" id="cx-insp"' + (insp ? '' : ' hidden') + '>' + insp + '</aside></div></div>';

      // ---- assemble, preserving every position a live pair would steal ----
      // A live capture re-renders this whole view on every pair arrival, so
      // every scroll position in it must survive. Yanking a reader back to
      // the top of a list they were reading is the one thing ui.md's
      // terminal semantics forbid outright.
      const oldOv = document.getElementById('cx-ov-scroll');
      const ovLeft = oldOv ? (oldOv.scrollLeft + oldOv.clientWidth >= oldOv.scrollWidth - 8 ? -1 : oldOv.scrollLeft) : -1;
      const oldMain = document.getElementById('cx-deck-main');
      const mainTop = oldMain ? oldMain.scrollTop : 0;
      const oldList = document.getElementById('tj-list');
      const listTop = oldList ? oldList.scrollTop : 0;
      const oldSearch = document.getElementById('tj-search');
      const searchFocused = !!oldSearch && document.activeElement === oldSearch;
      const caret = searchFocused ? oldSearch.selectionStart : 0;
      const keepTops = ctxCaptureTops();
      // ...except the inspector's, when its PICK changed under it (←/→
      // walking the pin, a thread switch, a facet switch): its old offset
      // points into content that is no longer there. Same pick, live
      // pair: keep it.
      if (ctxInspChanged) delete keepTops['cx-insp-body'];

      contextEl.innerHTML = head +
        renderCtxOverview(steps, addr, cols, maxT, split, loopCountOf(t), bumpBy) +
        '<div class="cx-cols">' + margin + canvas + '</div>';

      ctxRestoreTops(keepTops);
      const mainEl = document.getElementById('cx-deck-main');
      if (mainEl) mainEl.scrollTop = mainTop;
      const listEl = document.getElementById('tj-list');
      if (listEl) listEl.scrollTop = listTop;
      const inspEl = document.getElementById('cx-insp');
      if (inspEl) inspEl.querySelectorAll('details[data-raw][open]').forEach(fillRaw);
      const ov = document.getElementById('cx-ov-scroll');
      // The overview sticks to the newest edge when it was already there —
      // a live run's newest request must not walk off screen.
      if (ov) ov.scrollLeft = ovLeft >= 0 ? ovLeft : ov.scrollWidth;
      const search = document.getElementById('tj-search');
      if (search && searchFocused) { search.focus(); try { search.setSelectionRange(caret, caret); } catch {} }
      if (search) search.addEventListener('input', () => { tjQuery = search.value; repaintDeck(); });
      tipDetachedGuard();

      // Repaint just the deck: the level/kind/search/sort/filter controls
      // change ONE reading, and rebuilding the overview under the reader's
      // cursor to change a filter is the flicker this shell exists to
      // avoid.
      function repaintDeck() { renderContextView(t); }

      if (ctxMode === 'stream') wireCtxStream(contextEl, repaintDeck);
      wireCtxInsp(contextEl);
      contextEl.querySelectorAll('[data-cxmode]').forEach(b => b.addEventListener('click', () => {
        setCtxMode(b.dataset.cxmode);
        history.replaceState(null, '', ctxHash(t.key, ctxMode));
        renderContextView(t);
      }));
      contextEl.querySelectorAll('[data-tjlvl]').forEach(b => b.addEventListener('click', () => {
        tjLevel = b.dataset.tjlvl; localStorage.setItem('cctrace-tj-level', tjLevel); repaintDeck();
      }));
      contextEl.querySelectorAll('[data-tjkind]').forEach(b => b.addEventListener('click', () => {
        tjFilter = b.dataset.tjkind; repaintDeck();
      }));
      contextEl.querySelectorAll('[data-cxsort]').forEach(b => b.addEventListener('click', () => {
        ctxSort = b.dataset.cxsort; localStorage.setItem('cctrace-ctx-sort', ctxSort); repaintDeck();
      }));
      contextEl.querySelectorAll('[data-evf]').forEach(b => b.addEventListener('click', () => {
        ctxEvFilter = b.dataset.evf; repaintDeck();
      }));
      // The margin's bumps line is a control: it opens the events deck
      // already filtered to the cost events it counted.
      contextEl.querySelectorAll('[data-cxbumps]').forEach(b => b.addEventListener('click', () => {
        setCtxMode('events');
        ctxEvFilter = 'cost';
        history.replaceState(null, '', ctxHash(t.key, ctxMode));
        renderContextView(t);
      }));
      contextEl.querySelectorAll('[data-cxgran]').forEach(b => b.addEventListener('click', () => {
        ctxGran = b.dataset.cxgran; localStorage.setItem('cctrace-ctx-gran', ctxGran); renderContextView(t);
      }));

      wireCtxOverview(t, steps, addr, cols);
    }

    // Wheel zoom around the cursor, shared by every horizontal overview
    // (the context overview's tracks, the replay strip's lanes): the
    // point under the pointer stays put while the track's WIDTH grows,
    // so the reader zooms into what they were looking at. shift/ctrl are
    // left to the browser (native horizontal scroll, page zoom).
    function wireWheelZoom(scrollEl, trackEl, o) {
      if (!scrollEl || !trackEl || !scrollEl.addEventListener) return;
      scrollEl.addEventListener('wheel', (e) => {
        if (e.shiftKey || e.ctrlKey || !e.deltaY) return;
        e.preventDefault();
        const r = scrollEl.getBoundingClientRect();
        const x = e.clientX - r.left;
        const before = (scrollEl.scrollLeft + x) / Math.max(1, trackEl.offsetWidth);
        const cur = o.get();
        const next = Math.max(1, Math.min(o.max, cur * (e.deltaY < 0 ? 1.25 : 0.8)));
        if (Math.abs(next - cur) < 0.001) return;
        o.set(next);
        o.apply();
        scrollEl.scrollLeft = before * trackEl.offsetWidth - x;
      }, { passive: false });
    }

    // ---- the overview's interaction (the DevTools part) ----
    // Hover scrubs, click pins, drag brushes a range, the handles resize
    // it, the window pans it, the wheel zooms around the cursor. All of it
    // repaints IN PLACE — a full re-render on every pointer move would
    // rebuild a 400k-token decomposition sixty times a second.
    function wireCtxOverview(t, steps, addr, cols) {
      const tracks = document.getElementById('cx-tracks');
      const scroll = document.getElementById('cx-ov-scroll');
      if (!tracks || !scroll) return;
      const N = cols.length;

      // The detail strip follows the pointer instantly (a dozen rows); the
      // GRAPH is a full decomposition of a possibly-400k-token body, so it
      // lands on a short settle — scrubbing 100 columns must not rebuild
      // 100 trees. Landing on the column you stopped at is what the eye
      // wants anyway.
      const stepById = {};
      for (const s of steps) stepById[s.pairId] = s;
      const preview = (s, now) => {
        if (!s) return;
        ctxRepaintMargin(s, addr);
        clearTimeout(ctxGraphTimer);
        const paint = () => {
          const gr = document.getElementById('cx-graph');
          if (gr) gr.innerHTML = renderCtxGraph(s, addr);
        };
        if (now) paint(); else ctxGraphTimer = setTimeout(paint, 90);
      };
      let hoverAt = null;
      tracks.addEventListener('mouseover', (e) => {
        const el = e.target && e.target.closest ? e.target.closest('[data-cxbar]') : null;
        if (!el || el.dataset.cxbar === hoverAt) return;
        hoverAt = el.dataset.cxbar;
        preview(stepById[hoverAt]);
      });
      scroll.addEventListener('mouseleave', () => { hoverAt = null; preview(ctxFocusStep(steps), true); });

      const colAt = (clientX) => {
        const r = tracks.getBoundingClientRect();
        if (!r.width) return 0;
        return Math.max(0, Math.min(N - 1, Math.floor(((clientX - r.left) / r.width) * N)));
      };
      const paintBrush = () => {
        const br = document.getElementById('cx-brush');
        if (br) br.innerHTML = ctxBrushHtml(cols);
        tracks.querySelectorAll('[data-cxc]').forEach(el => {
          el.classList.toggle('out', ctxOut(cols[+el.dataset.cxc]));
        });
        const cap = document.getElementById('cx-ov-sel');
        if (cap) cap.textContent = ctxRangeCaption(steps, addr);
      };
      const setRange = (a, b) => {
        const lo = cols[Math.min(a, b)], hi = cols[Math.max(a, b)];
        ctxRange = { i0: lo.i0, i1: hi.i1 };
        paintBrush();
      };

      let drag = null;
      tracks.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const handle = e.target && e.target.closest ? e.target.closest('.cx-brush-h') : null;
        const c = colAt(e.clientX);
        // Inside an existing range, a drag PANS it (DevTools' gesture);
        // outside, it brushes a new one. Read off the column, not off an
        // overlay — the overlay would steal hover from the very columns
        // the reader just selected.
        const inside = ctxRange && cols[c].i1 >= ctxRange.i0 && cols[c].i0 <= ctxRange.i1;
        if (handle) drag = { kind: 'resize', edge: handle.dataset.edge, moved: true };
        else if (inside) drag = { kind: 'pan', at: c, base: { i0: ctxRange.i0, i1: ctxRange.i1 }, moved: false };
        else drag = { kind: 'new', anchor: c, moved: false };
        try { tracks.setPointerCapture(e.pointerId); } catch (err) { /* no capture: the move handler still works */ }
        e.preventDefault();
      });
      tracks.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const c = colAt(e.clientX);
        if (drag.kind === 'new') {
          // A click is not a drag: a 1-column wiggle must still pin.
          if (!drag.moved && c === drag.anchor) return;
          drag.moved = true;
          setRange(drag.anchor, c);
        } else if (drag.kind === 'resize') {
          // Resizing from an edge: the OTHER edge is the anchor.
          const anchor = drag.edge === 'l' ? ctxRange.i1 : ctxRange.i0;
          const lo = Math.min(anchor, cols[c][drag.edge === 'l' ? 'i0' : 'i1']);
          const hi = Math.max(anchor, cols[c][drag.edge === 'l' ? 'i0' : 'i1']);
          ctxRange = { i0: lo, i1: hi };
          paintBrush();
        } else if (drag.kind === 'pan') {
          const d = cols[c].i0 - cols[drag.at].i0;
          if (!d) return;
          drag.moved = true;
          const w = drag.base.i1 - drag.base.i0;
          let i0 = Math.max(0, Math.min(steps.length - 1 - w, drag.base.i0 + d));
          ctxRange = { i0, i1: i0 + w };
          paintBrush();
        }
      });
      const endDrag = (e) => {
        if (!drag) return;
        const d = drag;
        drag = null;
        try { tracks.releasePointerCapture(e.pointerId); } catch (err) { /* never captured */ }
        if (!d.moved && (d.kind === 'new' || d.kind === 'pan')) {
          // A plain click PINS the column (and un-pins it on a second
          // click) — the brush is for ranges, the click is for one step.
          // True inside the range too: a click there is still a click.
          const id = cols[d.kind === 'new' ? d.anchor : d.at].s.pairId;
          ctxPinned = ctxPinned === id ? null : id;
          renderContextView(t);
          return;
        }
        // A finished brush changes what the stream/events decks count, so
        // the deck (and only the deck) is rebuilt here.
        renderContextView(t);
      };
      tracks.addEventListener('pointerup', endDrag);
      tracks.addEventListener('pointercancel', endDrag);

      // Wheel zooms around the cursor; shift+wheel is left to the browser
      // (native horizontal scroll). Zoom is a WIDTH change on the track —
      // the columns are flex:1, so nothing re-renders.
      const applyZoom = () => {
        tracks.setAttribute('style', ctxTrackStyle());
        const z = document.getElementById('cx-ov-z');
        if (z) z.textContent = ctxZoom > 1 ? ctxZoom.toFixed(1) + '×' : 'fit';
      };
      wireWheelZoom(scroll, tracks, {
        max: CTX_ZOOM_MAX,
        get: () => ctxZoom,
        set: (z) => { ctxZoom = z; },
        apply: applyZoom,
      });
      contextEl.querySelectorAll('[data-cxzoomb]').forEach(b => b.addEventListener('click', () => {
        const k = b.dataset.cxzoomb;
        if (k === 'fit') { ctxZoom = 1; ctxRange = null; applyZoom(); renderContextView(t); return; }
        ctxZoom = Math.max(1, Math.min(CTX_ZOOM_MAX, ctxZoom * (k === 'in' ? 1.5 : 1 / 1.5)));
        applyZoom();
      }));
    }
    // pairs whose response completed at or before the cursor are visible,
    // everything after doesn't exist yet. Both panes rebuild from the
    // visible subset via the normal buildSession path; playback is a
    // setTimeout ladder over response-end boundaries with idle compression.
    const replay = { active: false, cursor: 0, playing: false, speed: 1, timer: null, sliceA: null, sliceB: null, zoom: 1 };
    // The overview fold (rev 3): lanes collapsed to the clock row, outside
    // replay only. Persisted — an overview the reader folded stays folded.
    let rpCollapsed = false;
    try { rpCollapsed = localStorage.getItem('cctrace-traj-fold') === '1'; } catch {}
    if (rpCollapsed) rpBar.classList.add('rp-collapsed');
    if (rpGut.addEventListener) rpGut.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('.rp-clps') : null;
      if (!b) return;
      rpCollapsed = !rpCollapsed;
      rpBar.classList.toggle('rp-collapsed', rpCollapsed);
      try { localStorage.setItem('cctrace-traj-fold', rpCollapsed ? '1' : '0'); } catch {}
      renderReplayStrip(true); // the chevron redraws with the fold state
    });
    const IDLE_CAP_MS = 2000;
    const RP_ZOOM_MAX = 32;    // 1 = the whole axis fits the frame
    const RP_AGENT_ROWS = 4;   // visible agent rows; deeper ones fold into "+k more"
    const RP_IDLE_MS = 120000; // idle longer than this compresses on the axis
    const RP_BREAK_PX = 28;    // ...to exactly this much track, hatched

    // The slice: a selected range of the timeline (shift+drag on the track).
    // While set, the session rebuilds from the window's pairs only and
    // playback/stepping bound to it; the export artifact IS this window.
    function sliceActive() { return replay.sliceA != null && replay.sliceB != null; }
    function slicePairs(list) {
      return sliceActive() ? sliceWindow(list, replay.sliceA, replay.sliceB) : list;
    }
    function clearSlice() {
      replay.sliceA = null;
      replay.sliceB = null;
      refreshReplay();
      updateReplayHash();
    }
    // The window's edge pairs BY END TIME — the slice's durable address
    // (the deep link and the export both name the window by these two ids,
    // which survive cross-run merges where wall-clock offsets wouldn't).
    function sliceBoundPairs(w) {
      let lo = null, hi = null;
      for (const p of w || []) {
        if (!p.id) continue;
        if (!lo || pairEndMs(p) < pairEndMs(lo)) lo = p;
        if (!hi || pairEndMs(p) > pairEndMs(hi)) hi = p;
      }
      return lo && hi ? { lo, hi } : null;
    }

    function enterReplay(cursor) {
      const span = replaySpan(pairs);
      if (!span) return;
      replay.active = true;
      // A reading page parks on the SELECTED thread's edge, not the tape's:
      // a merged capture used to enter hours past this session's last pair,
      // the whole strip behind one break column. A live page keeps the tape
      // end — entering replay there means tailing.
      const ex = IS_READING && cursor == null
        ? threadExtent(laneData(), (stageThread() || {}).key || '') : null;
      replay.cursor = cursor != null ? cursor : (ex ? Math.min(span.t1, ex.t1) : span.t1);
      document.body.classList.add('replaying');
      tailPill.classList.remove('show');
      if (view !== 'session') { location.hash = '#/session'; }
      renderReplayStrip(true);
      refreshReplay();
      updateReplayHash();
    }

    function exitReplay() {
      pausePlayback();
      replay.active = false;
      replay.sliceA = null;
      replay.sliceB = null;
      replay.zoom = 1;
      document.body.classList.remove('replaying');
      if (view === 'session') {
        showSession(sessionSelKey);
        if (!IS_READING) convoToBottom();
        if (sessionSelKey) history.replaceState(null, '', threadHash(sessionSelKey));
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
      // Play at the end of the tape (or slice) restarts from its top.
      if (!nextBoundary(replayEvents(slicePairs(pairs)), replay.cursor)) {
        replay.cursor = sliceActive() ? Math.min(replay.sliceA, replay.sliceB) - 1 : rpHome() - 1;
        refreshReplay();
      }
      replay.playing = true;
      rpPlay.textContent = '\\u23f8';
      scheduleTick();
    }

    function scheduleTick() {
      const tick = nextTick(replayEvents(slicePairs(pairs)), replay.cursor, replay.speed, IDLE_CAP_MS);
      if (!tick) {
        // The end of the tape. On a live page that is the live EDGE: park
        // there and the tail rule takes over. A reading page just pauses.
        if (!IS_READING && !sliceActive()) {
          const s = replaySpan(pairs);
          if (s && replay.cursor < s.t1) { replay.cursor = s.t1; refreshReplay(); }
        }
        pausePlayback();
        updateReplayHash();
        return;
      }
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
      // The turn stepper steps THIS conversation: ←/→ walk the selected
      // thread's own pairs, so a merged capture's other sessions never eat
      // a keypress (shift+arrow keeps every wire boundary).
      let src = slicePairs(pairs);
      if (turnsOnly) {
        const th = stageThread();
        if (th && th.pairIds && th.pairIds.length) {
          const ids = {};
          for (const id of th.pairIds) ids[id] = 1;
          const own = src.filter(p => ids[p.id]);
          if (own.length) src = own;
        }
      }
      const events = replayEvents(src);
      const b = dir > 0 ? nextBoundary(events, replay.cursor, turnsOnly) : prevBoundary(events, replay.cursor, turnsOnly);
      if (b) { replay.cursor = b.t; refreshReplay(); }
      updateReplayHash();
    }

    function seekReplay(cursor) {
      pausePlayback();
      // A slice bounds the cursor — scrubbing outside the window would
      // show an empty conversation and read as data loss.
      if (sliceActive()) {
        cursor = Math.max(Math.min(replay.sliceA, replay.sliceB),
          Math.min(cursor, Math.max(replay.sliceA, replay.sliceB)));
      }
      replay.cursor = cursor;
      refreshReplay();
    }

    // The end of the tape. On a live page that IS the live edge — the
    // cursor parks there and tails from then on (the ws pair branch).
    // Every caller (⏭, End, the live chip) lives inside the replay bar, so
    // replay is always already active here.
    function seekEnd() {
      // The end of the TAPE, not of the strip's axis: the axis is the
      // selected thread's own time now, and ⏭ still means "the live edge".
      const span = replaySpan(pairs);
      if (!span) return;
      seekReplay(span.t1);
      updateReplayHash();
    }

    // The top of THIS thread's tape: a merged capture's tape t0 can sit an
    // hour inside another session — ⏮ / Home / play-from-the-end restart at
    // the selected thread's own first pair, not there.
    function rpHome() {
      const ex = threadExtent(laneData(), (stageThread() || {}).key || '');
      const span = replaySpan(pairs);
      return ex ? ex.t0 : (span ? span.t0 : 0);
    }

    function fmtClock(ms) {
      const s = Math.max(0, Math.round(ms / 1000));
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
      const mm = (h > 0 && m < 10 ? '0' : '') + m;
      const ss = (sec < 10 ? '0' : '') + sec;
      return (h > 0 ? h + ':' + mm + ':' : mm + ':') + ss;
    }

    // ---- the trajectory strip (#rp-lanes) ----
    // Lanes x wall-clock: the human's prompts, the model's requests, the
    // tool/waiting gaps, the subagents stacked, the harness marks. Every
    // position comes from ONE mapping (rpScale) — the handle, the veil, the
    // ticks, the spans and the pointer handlers all read it, so nothing can
    // drift off the axis.

    // The LANES read the whole capture, never the cursored session:
    // scrubbing must not redraw the trajectory being scrubbed over (the
    // AXIS is the selected thread's — rpSpan). Cached on the capture's
    // length + the slice (buildSession over a long trace is not a per-frame
    // cost).
    // The threads of the WHOLE capture (never the cursored subset): the
    // strip draws the trajectory being scrubbed over, and the stage's
    // chapters have to include the loops still AHEAD of the cursor.
    let fullCache = { key: '', threads: [] };
    function fullThreads() {
      const key = pairs.length + (sliceActive() ? ':' + replay.sliceA + '-' + replay.sliceB : '');
      if (fullCache.key !== key) {
        fullCache = { key, threads: buildSession(slicePairs(pairs), CLIENT_WIRE).threads };
      }
      return fullCache.threads;
    }
    let laneCache = { key: '', lanes: null };
    function laneData() {
      const key = pairs.length + (sliceActive() ? ':' + replay.sliceA + '-' + replay.sliceB : '');
      if (laneCache.key !== key) laneCache = { key, lanes: sessionLanes(fullThreads(), pairOf) };
      return laneCache.lanes;
    }

    // The strip's axis: the SELECTED thread's own extent — its spans, its
    // points, and the children it spawned — not the whole capture. A 1h34m
    // session inside a 10h38m capture used to sit in the left quarter with
    // three quarters of the frame drawing nothing (replay-stage.md, rev 2.2).
    // Stretched to cover a request still in flight when this thread is the
    // one at the tape's edge, and always to cover the CURSOR: the playhead
    // is on the strip by construction. Every stretch is a known time — never
    // Date.now(), which would make a rendered page depend on when it is read.
    // A busy set rides along: the time inside the axis that carries work, so
    // the scale can compress the idle (timeScale).
    function rpSpan() {
      const th = stageThread();
      const ex = threadExtent(laneData(), th ? th.key : '');
      const cap = replaySpan(pairs);
      let t0, t1, busy;
      if (ex) { t0 = ex.t0; t1 = ex.t1; busy = ex.busy; }
      else if (cap) { t0 = cap.t0; t1 = cap.t1; busy = [[t0, t1]]; }
      else return null;
      // Another session's in-flight request is not this thread's time.
      if (!ex || !cap || t1 >= cap.t1 - 0.5) {
        openStarts.forEach((st) => {
          const t = (st && st.ts ? st.ts : 0) * 1000;
          if (!t) return;
          if (t < t0) t0 = t;
          if (t > t1) t1 = t;
        });
      }
      // The cursor can sit outside the selected thread (it follows the tape's
      // edge). The axis takes it in as a POINT, so the stretch between the
      // thread's last activity and the playhead compresses like any other
      // idle instead of flattening the thread into a sliver.
      const c = replay.cursor;
      if (replay.active && isFinite(c) && (c < t0 || c > t1)) {
        busy = busy.concat([[c, c]]);
        if (c < t0) t0 = c; else t1 = c;
      }
      return { t0, t1: Math.max(t0, t1), busy };
    }

    // The strip's frame in CSS pixels (0 until it has been on screen once).
    function rpFrameW() {
      return (rpScroll.getBoundingClientRect ? rpScroll.getBoundingClientRect().width : 0) || 0;
    }
    // ONE mapping from wall-clock to pixels for the whole strip: the spans,
    // the ruler, the veil, the playhead, the slice and every pointer handler
    // go through it. Idle longer than RP_IDLE_MS collapses to a fixed
    // RP_BREAK_PX column, so a lunch break is 28px and the work is the strip.
    // An unmeasured frame still scales proportionally (the zero-width retry
    // re-renders); only the ruler and the span labels wait for a real width.
    function rpScale(span) {
      const s = span || rpSpan();
      if (!s) return null;
      return timeScale(s.busy, s.t0, s.t1, (rpFrameW() || 1000) * replay.zoom, RP_IDLE_MS, RP_BREAK_PX);
    }

    // Reading depth is a function of zoom, not a toggle: shapes, then
    // initials and marks, then names. CSS decides off data-depth.
    function rpDepth() { return replay.zoom < 2 ? 'map' : (replay.zoom < 8 ? 'read' : 'full'); }

    let rpStripKey = '';
    let rpZeroTries = 0;
    function renderReplayStrip(force) {
      const span = rpSpan();
      if (!span) {
        rpGut.innerHTML = ''; rpAxis.innerHTML = ''; rpRules.innerHTML = '';
        rpBody.innerHTML = ''; rpBreaks.innerHTML = ''; rpStripKey = '';
        rpBar.classList.add('rp-empty');
        return;
      }
      rpBar.classList.remove('rp-empty');
      // The thread the rail has selected draws FULL; every other thread's
      // items ghost. Same resolution the stage uses — one selection, two
      // surfaces.
      const selT = stageThread();
      const selKey = selT ? selT.key : '';
      // Label visibility and the clock ruler need the frame's width in
      // PIXELS, so the measurement is part of the KEY: entering replay from
      // the requests tab renders once while #session-view is still hidden
      // (the hash route is async), and that zero-width draw — no ticks, no
      // span labels — must not be the cached answer forever.
      const frameW = (rpScroll.getBoundingClientRect ? rpScroll.getBoundingClientRect().width : 0) || 0;
      // The cursor is NOT in the key — it moves the handle, never the lanes.
      const key = pairs.length + '|' + (sliceActive() ? replay.sliceA + '-' + replay.sliceB : '-') +
        '|' + replay.zoom.toFixed(3) + '|' + openStarts.size + '|' + span.t0 + '|' + span.t1 + '|' + selKey +
        '|' + Math.round(frameW);
      if (rpStripKey === key && !force) return;
      rpStripKey = key;
      // A zero-width draw is a measurement that has not happened yet: ask
      // for one more frame (bounded — a strip that is never on screen must
      // not spin) and let the re-measure repair it.
      if (frameW > 0) rpZeroTries = 0;
      else if (rpZeroTries < 5 && typeof requestAnimationFrame === 'function') {
        rpZeroTries++;
        requestAnimationFrame(() => renderReplayStrip(true));
      }
      const L = laneData();
      // ONE mapping, idle compressed: every x on this strip comes from it.
      const sc = rpScale(span);
      const px = (t) => scaleX(sc, t) / sc.px * 100;
      const pct = (t) => px(t).toFixed(3);
      // An item entirely outside the axis, or buried inside a compressed
      // break, has no honest position — the ghost lanes drop it instead of
      // piling it on a boundary. Anything partly inside draws clipped.
      const hidden = (a, b) => {
        if (b < span.t0 || a > span.t1) return true;
        for (const s of sc.segs) if (s.kind === 'break' && a >= s.t0 && b <= s.t1) return true;
        return false;
      };
      const ord = (n) => (n + 1 < 10 ? '0' : '') + (n + 1);
      const clock = (t) => fmtTime(new Date(t)) + ' \\u00b7 +' + fmtClock(t - span.t0);
      const seekOf = (pairId, fallback) => {
        const p = pairOf(pairId);
        return p ? pairEndMs(p) : fallback;
      };
      const bar = (cls, a, b, seek, tip, li, ln) => {
        const x0 = px(a), x1 = px(b);
        // .w24 gates the labels on REAL pixels: an unmeasured frame says
        // nothing rather than guessing what fits.
        const wide = frameW > 0 && (x1 - x0) / 100 * sc.px >= 24;
        return '<span class="rp-span ' + cls + (wide ? ' w24' : '') +
          '" data-rpt="' + seek + '" style="left:' + x0.toFixed(3) + '%;width:' + Math.max(0, x1 - x0).toFixed(3) + '%"' +
          ' data-tip="' + escapeHtml(tip) + '">' +
          (li ? '<span class="rp-lbl i">' + escapeHtml(li) + '</span>' : '') +
          (ln ? '<span class="rp-lbl n">' + escapeHtml(ln) + '</span>' : '') + '</span>';
      };
      const lane = (name, inner) => '<div class="rp-lane" data-lane="' + name + '">' + inner + '</div>';
      // Ghost everything the selection does not own. An agent span has TWO
      // keys that count as ownership (the parent that spawned it, and the
      // child itself), hence the optional second key.
      const oth = (k, k2) => (selKey && k !== selKey && (k2 == null || k2 !== selKey) ? ' other' : '');

      // The clock row: a ruler in the READER's local zone, exactly like
      // fmtTime — so the axis and the span tips agree. The offset is
      // anchored to the DATA (the span's own start), never to today: a July
      // trace read in January must not be ruled an hour off its own tips.
      // A DST transition INSIDE the span still shifts one side by an hour
      // (docs/design/replay-stage.md, "Not done").
      let axis = '';
      let rules = '';
      let breaks = '';
      // The compressed stretches first: a hatched column across the lanes,
      // and in the clock row how much time it stands for (coarse — a break
      // is minutes and hours, never seconds). The label is ANCHORED inside
      // the track: a break against either edge (the cursor sitting hours
      // past the thread's last pair puts one there) would otherwise centre
      // its label half off screen and read as "\\u29f8\\u29f8 8h 2".
      const skipBoxes = [];
      for (const s of sc.segs) {
        if (s.kind !== 'break') continue;
        const l = s.x0 / sc.px * 100, w = (s.x1 - s.x0) / sc.px * 100;
        const skipped = fmtSpanCoarse(s.t1 - s.t0);
        const lw = ('\\u29f8\\u29f8 ' + skipped).length * 6 + 4;   // 10px monospace
        let cls = '', at = (s.x0 + s.x1) / 2, lo = at - lw / 2;
        if (sc.px - s.x1 <= 40) { cls = ' at-end'; at = s.x1; lo = at - lw; }
        else if (s.x0 <= 40) { cls = ' at-start'; at = s.x0; lo = at; }
        skipBoxes.push([lo, lo + lw]);
        breaks += '<i class="rp-break" style="left:' + l.toFixed(3) + '%;width:' + w.toFixed(3) + '%"></i>';
        axis += '<span class="rp-bk' + cls + '" style="left:' + (at / sc.px * 100).toFixed(3) + '%"' +
          ' data-tip="' + escapeHtml('idle \\u00b7 ' + skipped + '\\n' + clock(s.t0) + ' \\u2013 ' + fmtTime(new Date(s.t1)) +
            '\\n---\\n> nothing on this thread\\u2019s wire \\u2014 the axis skips it') + '">' +
          '\\u29f8\\u29f8 ' + escapeHtml(skipped) + '</span>';
      }
      // The ruler is stepped PER BUSY SEGMENT, over that segment's own time
      // and its own pixels: stepping it over the whole extent would pick the
      // ladder rung for 9h54m and rule an hour of work with two ticks. Busy
      // segments share pixels in proportion to their duration, so they all
      // land on the same step; a short one may take a coarser rung from the
      // 72px floor, which is the floor doing its job. Every tick is inside
      // busy time by construction — no filter needed.
      const tz = new Date(span.t0).getTimezoneOffset();
      for (const s of sc.segs) {
        if (s.kind !== 'busy') continue;
        for (const k of axisTicks(s.t0, s.t1, frameW > 0 ? s.x1 - s.x0 : 0, tz)) {
          const x = scaleX(sc, k.t);
          // A tick label that would collide with a skip label loses its
          // TEXT, never its hairline: two overlapping clocks read as one
          // wrong one.
          let clear = true;
          for (const b of skipBoxes) if (x + 36 > b[0] && x < b[1]) clear = false;
          axis += '<span class="rp-tick' + (k.major ? ' major' : '') +
            '" style="left:' + (x / sc.px * 100).toFixed(3) + '%">' +
            (clear ? escapeHtml(k.label) : '') + '</span>';
          if (k.major) rules += '<i class="rp-rule" style="left:' + (x / sc.px * 100).toFixed(3) + '%"></i>';
        }
      }

      // turns: one BLOCK per working loop, from the instant the prompt hit
      // the wire (the block's accent edge — what the human lane's point
      // was) to the loop's last reply. The minimap's clickable unit (rev
      // 6): the number shows whenever the block can hold it, the prompt's
      // words at full depth, the tally on hover. data-rpj is the jump
      // target outside replay (the prompt's own instant, so the convo
      // lands on the turn's head); data-rpt stays the seek while
      // replaying (where the prompt became visible).
      let turns = '';
      for (const x of L.turns) {
        if (hidden(x.t0, x.t1)) continue;
        const n = ord(x.ord);
        const tally = [
          x.steps + ' step' + (x.steps === 1 ? '' : 's'),
          x.calls ? x.calls + ' call' + (x.calls === 1 ? '' : 's') : '',
          x.agents ? x.agents + ' agent' + (x.agents === 1 ? '' : 's') : '',
        ].filter(Boolean).join(' \\u00b7 ');
        const marks = [
          x.cuts ? '\\u2702 ' + x.cuts + ' compaction' + (x.cuts === 1 ? '' : 's') : '',
          x.failed ? '\\u2717 ' + x.failed + ' failed request' + (x.failed === 1 ? '' : 's') : '',
        ].filter(Boolean).join(' \\u00b7 ');
        const tip = 'turn ' + n + ' \\u00b7 ' + tally +
          (x.injected ? '\\nstarted by the harness \\u00b7 ' + x.injected : '') +
          '\\n' + clock(x.t0) + ' \\u00b7 ' + fmtSpan(x.t1 - x.t0) +
          (x.label ? '\\n' + x.label : '') + (marks ? '\\n' + marks : '') +
          '\\n---\\n> click jumps to this turn \\u2014 the conversation, or the cursor while replaying';
        const x0 = px(x.t0), x1 = px(x.t1);
        const wide = frameW > 0 && (x1 - x0) / 100 * sc.px >= 24;
        turns += '<span class="rp-span rp-turn' + (x.injected ? ' inj' : '') + oth(x.threadKey) + (wide ? ' w24' : '') +
          '" data-rpt="' + seekOf(x.pairId, x.t0) + '" data-rpj="' + x.t0 + '" data-t0="' + x.t0 + '" data-t1="' + x.t1 + '"' +
          ' style="left:' + x0.toFixed(3) + '%;width:' + Math.max(0, x1 - x0).toFixed(3) + '%"' +
          ' data-tip="' + escapeHtml(tip) + '">' +
          '<span class="rp-lbl i">' + n + '</span>' +
          '<span class="rp-lbl n">' + n + (x.label ? ' \\u00b7 ' + escapeHtml(x.label) : '') + '</span></span>';
      }

      // model: the pair itself, [request start, response end]
      let model = '';
      for (const x of L.model) {
        if (hidden(x.t0, x.t1)) continue;
        const tip = 'model \\u00b7 turn ' + ord(x.ord) + ' step ' + x.step + '\\n' + clock(x.t0) +
          '\\n' + fmtSpan(x.t1 - x.t0) + (x.stop ? ' \\u00b7 stop ' + x.stop : '') +
          '\\n---\\n> click jumps there \\u2014 the conversation, or the cursor while replaying';
        model += bar('model' + (x.err ? ' err' : '') + oth(x.threadKey), x.t0, x.t1, x.t1, tip, '', '');
      }
      // a request still in flight: a dashed stub hugging the live edge.
      // Its start is normally the newest known time, so its true extent is
      // zero width — a marker with a floor, never a duration claim (the
      // tip says when it started; nothing here reads the clock).
      openStarts.forEach((st) => {
        const t = (st && st.ts ? st.ts : 0) * 1000;
        if (!t || t > span.t1) return;
        const tip = 'model \\u00b7 in flight\\nstarted ' + clock(t) +
          '\\n---\\n> no response yet \\u2014 the strip ends at the newest known time';
        const w = Math.max(0, 100 - px(t));
        model += '<span class="rp-span model open" data-rpt="' + t + '" style="right:0;width:max(' + w.toFixed(3) + '%,12px)"' +
          ' data-tip="' + escapeHtml(tip) + '"></span>';
      });

      // tools + waiting: the SAME gap lane, classified by whether the
      // reply made calls (threadTimeSplit's own rule); waiting is dimmed.
      let tools = '';
      for (const g of L.tools) {
        if (hidden(g.t0, g.t1)) continue;
        const uniq = [];
        for (const n of g.names || []) if (n && uniq.indexOf(n) === -1) uniq.push(n);
        const tip = 'tools \\u00b7 ' + g.count + ' call' + (g.count === 1 ? '' : 's') + '\\n' + clock(g.t0) +
          '\\n' + fmtSpan(g.t1 - g.t0) + (uniq.length ? '\\n' + uniq.join(', ') : '') +
          '\\n---\\n> one gap covers parallel calls \\u2014 the wire has no per-call time';
        tools += bar('tools' + oth(g.threadKey), g.t0, g.t1, seekOf(g.pairId, g.t0), tip,
          uniq.map(n => n.slice(0, 1)).join(''), uniq.join(' '));
      }
      for (const g of L.waiting) {
        if (hidden(g.t0, g.t1)) continue;
        const tip = 'waiting\\n' + clock(g.t0) + '\\n' + fmtSpan(g.t1 - g.t0) +
          '\\n---\\n> no tool call \\u2014 the harness came back on its own';
        tools += bar('waiting' + oth(g.threadKey), g.t0, g.t1, seekOf(g.pairId, g.t0), tip, '', 'waiting');
      }

      // agents: child threads stacked on the rows sessionLanes assigned,
      // capped — the rest fold into one row rather than growing the frame.
      // A span is in focus when the selected thread spawned it OR IS it, so
      // a child selected in the rail keeps its own span full.
      const arows = [];
      let folded = 0;
      for (const a of L.agents) {
        if (hidden(a.t0, a.t1)) continue;
        const r = a.row < RP_AGENT_ROWS ? a.row : RP_AGENT_ROWS;
        if (r === RP_AGENT_ROWS) folded++;
        const label = a.label || a.agentType || 'subagent';
        const tip = 'agent \\u00b7 ' + label + '\\n' + clock(a.t0) + '\\n' + fmtSpan(a.t1 - a.t0) +
          '\\n---\\n> click jumps to where its work landed';
        arows[r] = (arows[r] || '') + bar('agent' + (r === RP_AGENT_ROWS ? ' more' : '') +
          oth(a.parentKey, a.threadKey), a.t0, a.t1, a.t1, tip, '', label);
      }

      // harness: moments, not spans — a compaction and a failed request.
      let harness = '';
      for (const c of L.cuts) {
        if (hidden(c.t, c.t)) continue;
        const tip = 'compaction' + (c.mode ? ' \\u00b7 ' + c.mode : '') + '\\n' + clock(c.t) +
          '\\n---\\n> the context window collapsed here';
        harness += '<span class="rp-mark cut' + oth(c.threadKey) + '" data-rpt="' + c.t + '" style="left:' + pct(c.t) + '%"' +
          ' data-tip="' + escapeHtml(tip) + '"><span class="rp-mk">\\u2702</span></span>';
      }
      for (const f of L.failed) {
        if (hidden(f.t, f.t)) continue;
        const tip = 'failed request' + (f.status ? ' \\u00b7 ' + f.status : '') + '\\n' + clock(f.t) +
          '\\n---\\n> it produced no turn; the retry is the next request';
        harness += '<span class="rp-mark err' + oth(f.threadKey) + '" data-rpt="' + f.t + '" style="left:' + pct(f.t) + '%"' +
          ' data-tip="' + escapeHtml(tip) + '"><span class="rp-mk">\\u2717</span></span>';
      }

      // Fixed geometry: an empty lane stays, labelled — a client with no
      // spawn tool reads as zero agents, never as a missing row.
      // The clock cell carries the fold chevron (rev 3): outside replay the
      // lanes collapse to the clock row, which stays the reopen target.
      let gut = '<span class="rp-glbl rp-g0"><button class="rp-clps" data-tip="' +
        escapeHtml('fold the trajectory\\nThe lanes collapse to the clock row \\u2014 a thin ruler is still an overview.\\n---\\n> click toggles \\u00b7 replay always unfolds it') +
        '">' + (rpCollapsed ? '\\u25b8' : '\\u25be') + '</button>clock</span><span class="rp-glbl">turns</span>' +
        '<span class="rp-glbl">model</span><span class="rp-glbl">tools</span>';
      let body = lane('turns', turns) + lane('model', model) + lane('tools', tools);
      const nrows = Math.max(1, arows.length);
      for (let i = 0; i < nrows; i++) {
        gut += '<span class="rp-glbl">' +
          (i === 0 ? 'agents' : (i === RP_AGENT_ROWS ? '+' + folded + ' more' : '')) + '</span>';
        body += lane('agents', arows[i] || '');
      }
      gut += '<span class="rp-glbl">harness</span>';
      body += lane('harness', harness);
      rpGut.innerHTML = gut;
      rpAxis.innerHTML = axis;
      rpRules.innerHTML = rules;
      rpBody.innerHTML = body;
      // Above the lanes, below the veil: a span that straddles skipped time
      // draws across it and the hatch covers what was not shown.
      rpBreaks.innerHTML = breaks;
      rpLanes.dataset.depth = rpDepth();
      rpTrack.style.width = (replay.zoom > 1 ? (replay.zoom * 100).toFixed(2) : '100') + '%';
    }

    // The playhead stays reachable during playback, but the strip only
    // scrolls when the handle LEAVES the frame — following it continuously
    // would be constant motion (ui.md 5).
    function rpFollowHandle(frac) {
      if (!rpScroll.getBoundingClientRect) return;
      const frameW = rpScroll.getBoundingClientRect().width || 0;
      const trackW = frameW * replay.zoom;
      if (!frameW || trackW <= frameW + 1) return;
      const x = frac * trackW;
      const at = rpScroll.scrollLeft || 0;
      if (x >= at + 8 && x <= at + frameW - 8) return;
      rpScroll.scrollLeft = Math.max(0, Math.min(trackW - frameW, x - frameW / 2));
    }

    // Live: the capture grew (a pair landed, a request started). Redraw the
    // strip and keep the newest edge in view when the reader was already
    // there — terminal semantics, never yank a strip being read.
    // The strip's label gating (.w24) is measured against the frame at
    // render time, so a resized window re-renders it — debounced, replay
    // only, and a re-render is a still frame (no motion budget spent).
    let rpResizeTimer = null;
    window.addEventListener('resize', () => {
      if (!replay.active && view !== 'session') return;
      clearTimeout(rpResizeTimer);
      rpResizeTimer = setTimeout(() => renderReplayStrip(true), 150);
    });

    function rpLiveRefresh() {
      // The strip is the session view's overview (rev 3): it grows on every
      // landed pair whether or not a replay is running. Replay's own chrome
      // (the bar, the stage) refreshes only while replaying.
      if (!replay.active && view !== 'session') return;
      const frameW = (rpScroll.getBoundingClientRect ? rpScroll.getBoundingClientRect().width : 0) || 0;
      const atEdge = !!frameW && (rpScroll.scrollLeft || 0) + frameW >= frameW * replay.zoom - 2;
      renderReplayStrip(true);
      if (replay.active) {
        renderReplayBar();
        renderStage(); // a start event rebuilds no pane, but it IS the live state
      } else rpQueueSyncRead();
      if (atEdge) rpScroll.scrollLeft = Math.max(0, frameW * replay.zoom - frameW);
    }

    function renderReplayBar() {
      // The strip's axis, not the pairs' — the handle must sit on the same
      // scale as the lanes it points into (an open request stretches both).
      const span = rpSpan();
      if (!span) return;
      const dur = Math.max(1, span.t1 - span.t0);
      // The playhead rides the SCALE, like every mark on the strip — inside a
      // compressed break included, so it never drifts off the lanes it points
      // into. The clock below it stays real time (the ruler compresses; the
      // clock does not lie).
      const sc = rpScale(span);
      const frac = Math.min(1, Math.max(0, scaleX(sc, replay.cursor) / sc.px));
      // the veil covers the FUTURE: from the playhead to the right edge
      rpVeil.style.left = (frac * 100).toFixed(3) + '%';
      rpHandle.style.left = (frac * 100).toFixed(3) + '%';
      // The terminal the human is looking at shows wall-clock: the absolute
      // local time first, the tape offset after it.
      rpTime.textContent = fmtTime(new Date(replay.cursor)) + ' \\u00b7 +' +
        fmtClock(replay.cursor - span.t0) + ' / ' + fmtClock(dur);
      renderLiveChip();
      // The slice band + chip: the selected window, its size, and the two
      // actions it affords (export the artifact, clear the selection).
      if (sliceActive()) {
        const lo = Math.min(replay.sliceA, replay.sliceB);
        const hi = Math.max(replay.sliceA, replay.sliceB);
        const sx0 = scaleX(sc, lo) / sc.px * 100, sx1 = scaleX(sc, hi) / sc.px * 100;
        rpSlice.style.display = 'block';
        rpSlice.style.left = sx0.toFixed(3) + '%';
        rpSlice.style.width = Math.max(0, sx1 - sx0).toFixed(3) + '%';
        const w = slicePairs(pairs);
        rpSliceChip.style.display = 'inline-flex';
        rpSliceChip.innerHTML = 'slice ' + fmtClock(lo - span.t0) + '\\u2013' + fmtClock(hi - span.t0) +
          ' \\u00b7 ' + w.length + ' pair' + (w.length === 1 ? '' : 's') +
          (IS_SNAPSHOT || !w.length ? '' : ' <button class="rp-btn" id="rp-slice-export" title="Download a snapshot .html holding exactly these pairs \\u2014 the shareable artifact">export</button>') +
          ' <button class="rp-btn" id="rp-slice-clear" title="Clear the slice, keep replaying">\\u2715</button>';
        const ex = document.getElementById('rp-slice-export');
        if (ex) ex.onclick = () => {
          const b = sliceBoundPairs(w);
          if (!b) return;
          location.href = '/api/slice.html?from=' + encodeURIComponent(b.lo.id) + '&to=' + encodeURIComponent(b.hi.id);
        };
        const cl = document.getElementById('rp-slice-clear');
        if (cl) cl.onclick = clearSlice;
      } else {
        rpSlice.style.display = 'none';
        rpSliceChip.style.display = 'none';
        rpSliceChip.innerHTML = '';
      }
      renderReplayStrip();
      rpFollowHandle(frac);
    }

    // The live chip: STATE while the cursor sits at the newest landed pair
    // (the page is tailing), a CONTROL when the reader is behind. Never on a
    // reading page — a saved trace has no edge to chase.
    // It renders on EVERY bar update (a playback tick, a landed pair), so it
    // rewrites only when the state actually flips: rebuilding the markup
    // under the reader's pointer would destroy the button mid-hover and can
    // eat the click that was aimed at it.
    let rpLiveState = null;
    function renderLiveChip() {
      if (!rpLive) return;
      const s = IS_READING ? null : replaySpan(pairs);
      const state = IS_READING ? 'reading' : (s && replay.cursor >= s.t1 - 0.5 ? 'edge' : 'behind');
      if (rpLiveState === state) return;
      rpLiveState = state;
      rpLive.innerHTML = state === 'reading' ? ''
        : state === 'edge'
        ? '<span class="at-edge" data-tip="live\\nthe cursor is at the newest landed pair \\u2014 the next one moves it, and the conversation follows">live</span>'
        : '<button class="rp-btn" id="rp-live-btn" data-tip="back to the live edge\\nthe capture has moved on; this snaps the cursor to the newest landed pair\\n---\\n> key: End">\\u2913 live</button>';
      const b = document.getElementById('rp-live-btn');
      if (b) b.onclick = seekEnd;
    }

    // Every cursor change rebuilds the convo as of the cursor, and its
    // BOTTOM is the newest visible turn — the moment. So a seek, a step, a
    // chapter jump and a playback tick all land there, instantly: a rebuilt
    // pane has no scroll position worth animating from, and playback would
    // otherwise be continuous motion (ui.md 5).
    // The tail path passes { follow: false } — it decides by where the
    // reader was (terminal semantics: stick when you're there, never yank).
    function refreshReplay(opts) {
      renderReplayBar();
      if (view === 'session') showSession(sessionSelKey);
      if (view === 'session' && (!opts || opts.follow !== false)) convoToBottom();
    }

    // ---- the stage (#stage): the beat, the tally ----
    // Rendered at the TOP of the threads column while replaying, torn down
    // with replay. Two readings of ONE cursor: WHAT the agent did at this
    // step (the beat, from the selected thread) and WHAT it has called so
    // far (the tally). The moment itself is the strip's cursor — the frame
    // states WHERE, the stage states WHAT.

    // The thread the stage reads: the selection, resolved against the WHOLE
    // capture (the cursored threads lose every loop still ahead).
    function stageThread() {
      const all = fullThreads();
      return all.length ? resolveThreadSel(all, sessionSelKey) : null;
    }

    // The step the beat is showing at the cursor, as an id — the one thing
    // the tail has to compare to know whether a landed pair CHANGED the
    // stage (a telemetry pair or a usage poll does not).
    function stageBeatId() {
      const t = stageThread();
      const b = t ? beatAt(t, replay.cursor, pairOf) : null;
      return b ? b.pairId : '';
    }

    // So far: which tools were called and how often as of the cursor, then
    // the coarse marks. The ONE place the per-tool call count is stated.
    function stageSoFar(L, key) {
      const c = soFar(L, replay.cursor, key);
      if (!c.steps) return '';
      const names = Object.keys(c.tools).sort((a, b) => c.tools[b] - c.tools[a]);
      const parts = [];
      for (const n of names.slice(0, 4)) parts.push(escapeHtml(n) + ' ' + c.tools[n]);
      if (names.length > 4) parts.push('+' + (names.length - 4));
      if (c.agents) parts.push(c.agents + ' agent' + (c.agents === 1 ? '' : 's'));
      if (c.failed) parts.push(c.failed + ' failed');
      if (c.cuts) parts.push(c.cuts + ' \\u2702');
      if (!parts.length) return '';
      return '<div class="st-sofar">so far&#160;&#160;' + parts.join(' \\u00b7 ') + '</div>';
    }

    // Set for the one render that follows a tail advance (see the ws pair
    // branch); every other render is a still frame.
    let stageFade = false;

    function stageBeat(t) {
      const b = t ? beatAt(t, replay.cursor, pairOf) : null;
      if (!b) return '<div class="sb"><div class="sb-none">before the first response</div></div>';
      const ordN = (n) => (n + 1 < 10 ? '0' : '') + (n + 1);
      let cap = '<span class="sb-turn">turn ' + ordN(b.ord) + '</span>';
      if (b.step) cap += ' \\u00b7 step ' + b.step;
      cap += ' \\u00b7 ' + fmtSpan(b.dur);
      if (b.stop) cap += ' \\u00b7 stop ' + escapeHtml(b.stop);
      // The loop's HEAD: the task this step serves. Harness-authored heads
      // are not tasks, so beatAt hands back '' for them and no line renders.
      const head = b.head
        ? '<div class="sb-head" data-rpchap="' + b.ord + '" data-tip="' +
          escapeHtml('the loop this step serves\\n' + b.head + '\\n---\\n> click jumps to this chapter') +
          '">' + escapeHtml(b.head) + '</div>'
        : '';
      let rows = '';
      // One row per call, the fold body reusing the convo pane's own
      // renderer (tool_use fused with its tool_result) — a spawn keeps its
      // purple title and its "open thread" link into the child.
      const results = buildToolResultIndex((t && t.turns) || []);
      let turn = null;
      for (const x of (t && t.turns) || []) if (x && x.role === 'assistant' && x.pairId === b.pairId) turn = x;
      const spawned = {};
      for (const s of b.spawns || []) if (s.id) spawned[s.id] = 1;
      let ci = 0;
      for (const blk of (turn && turn.blocks) || []) {
        if (!blk || (blk.type !== 'tool_use' && blk.type !== 'server_tool_use')) continue;
        const c = b.calls[ci++] || {};
        // ok is a wire fact (the result's is_error) or absent — never a guess
        const mark = c.ok == null ? '<span class="sb-mark" title="no result captured">\\u2014</span>'
          : c.ok ? '<span class="sb-mark ok">ok</span>'
          : '<span class="sb-mark err">err</span>';
        rows += '<div class="sb-row' + (blk.id && spawned[blk.id] ? ' spawn' : '') + '">' +
          renderBlockS(blk, results, true) + mark + '</div>';
      }
      if (b.reply) {
        rows += '<div class="sb-line"><span class="sb-lbl">reply</span>' +
          '<span class="sb-txt">' + escapeHtml(b.reply) + '</span></div>';
      }
      if (b.thinking) {
        rows += '<div class="sb-line sb-think"><span class="sb-lbl">stated reasoning</span>' +
          '<span class="sb-txt">' + escapeHtml(b.thinking) + '</span></div>';
      }
      const tk = b.tokens || {};
      let foot = '';
      if (tk.prompt) {
        let amt = fmtCompact(tk.prompt);
        if (tk.delta) amt += ' (' + (tk.delta > 0 ? '+' : '\\u2212') + fmtCompact(Math.abs(tk.delta)) + ')';
        if (tk.cachePct != null) amt += ' \\u00b7 cache ' + tk.cachePct + '%';
        foot = '<div class="sb-foot"><span class="sb-lbl">window</span>' +
          '<span class="sb-gap"></span><span class="sb-amt">' + escapeHtml(amt) + '</span></div>';
      }
      // A TAIL advance landed a new step: the page's live-arrived fade says
      // so once. A scrub is continuous — it never fades (ui.md 5).
      return '<div class="sb' + (stageFade ? ' arrived' : '') + '"><div class="sb-cap">' + cap + '</div>' +
        head + rows + foot + '</div>';
    }

    function stageInner() {
      const t = stageThread();
      return stageBeat(t) + stageSoFar(laneData(), t ? t.key : '');
    }
    function stageHtml() {
      if (!replay.active) return '';
      try { return '<div id="stage">' + stageInner() + '</div>'; }
      catch (e) { return '<div id="stage">' + brokenItem('stage', '', e) + '</div>'; }
    }
    // Live refresh: a pair landed or a request started, and the threads pane
    // was not rebuilt (a start event carries no pair). Patch it in place.
    function renderStage() {
      const el = document.getElementById('stage');
      if (!el) return;
      try { el.innerHTML = stageInner(); }
      catch (e) { el.innerHTML = brokenItem('stage', '', e); }
    }

    // Chapters: the working-loop heads of the selected thread, as cursor
    // stops. A loop is only readable once its first response landed, so the
    // stop is that pair's END (the boundary visibleAt uses); a loop whose
    // request was never captured has no honest time and is skipped.
    function chapterStops() {
      const t = stageThread();
      const out = [];
      for (const ch of (t ? chaptersOf(t, pairOf) : [])) {
        const p = ch.pairId ? pairOf(ch.pairId) : null;
        if (p && p.request) out.push(pairEndMs(p));
      }
      out.sort((a, b) => a - b);
      return out;
    }
    function seekChapter(dir) {
      const stops = chapterStops();
      let target = null;
      if (dir > 0) { for (const s of stops) if (s > replay.cursor + 0.5) { target = s; break; } }
      else { for (const s of stops) if (s < replay.cursor - 0.5) target = s; }
      if (target == null) return;
      seekReplay(target);
      updateReplayHash();
    }

    // Deep-link anchor: #/session/<key>/@<pair-id> — pair ids survive
    // cross-run history merges where wall-clock offsets wouldn't. Only
    // written when paused (replaceState is rate-limited by browsers).
    function updateReplayHash() {
      if (!replay.active || replay.playing || view !== 'session' || !sessionSelKey) return;
      const base = threadHash(sessionSelKey);
      // A slice deep-links as a RANGE — @a..b, the window's edge pair ids.
      if (sliceActive()) {
        const b = sliceBoundPairs(slicePairs(pairs));
        if (b) { history.replaceState(null, '', base + '/@' + encodeURIComponent(b.lo.id) + '..' + encodeURIComponent(b.hi.id)); return; }
      }
      const a = anchorAt(replayEvents(pairs), replay.cursor);
      history.replaceState(null, '', a ? base + '/@' + encodeURIComponent(a.id) : base);
    }

    // The stage's seek — the beat's head, to that loop's chapter stop.
    // Delegated: #stage is rewritten on every cursor change.
    threadsEl.addEventListener('click', (e) => {
      const el = e.target && e.target.closest ? e.target.closest('[data-rpchap]') : null;
      if (!el) return;
      e.preventDefault();
      const ord = parseInt(el.dataset.rpchap, 10);
      const th = stageThread();
      for (const c of (th ? chaptersOf(th, pairOf) : [])) {
        if (c.ord !== ord || !c.pairId) continue;
        const p = pairOf(c.pairId);
        if (p && p.request) { seekReplay(pairEndMs(p)); updateReplayHash(); }
        return;
      }
    });

    replayToggle.onclick = () => { replay.active ? exitReplay() : enterReplay(); };
    // Exiting is exiting: snapping to the live edge is the transport's job
    // (⏭ / the live chip), never the button that leaves the mode.
    rpExit.textContent = '\\u2715 exit';
    rpExit.title = 'Exit replay (Esc)';
    rpExit.onclick = exitReplay;
    rpRestart.onclick = () => {
      if (!replay.active) enterReplay();
      seekReplay(rpHome());
      updateReplayHash();
    };
    rpEnd.onclick = seekEnd;
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
    let rpSliceDrag = false;
    let rpClickSeek = null;   // a span was pressed: a click jumps, a drag scrubs
    let rpDownX = 0;
    function timeFromPointer(e) {
      const sc = rpScale();
      if (!sc) return null;
      // The track's visual rect already accounts for the strip's own
      // horizontal scroll, so zoomed scrubbing needs no extra math. The
      // fraction goes back through the SCALE — scrubbing across a compressed
      // break is fast, and every other pixel is real time.
      const rect = rpTrack.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / Math.max(1, rect.width)));
      return scaleT(sc, frac * sc.px);
    }
    function seekFromPointer(e) {
      const t = timeFromPointer(e);
      if (t != null) seekReplay(t);
    }
    rpTrack.addEventListener('pointerdown', (e) => {
      // Outside replay the bar is the MINIMAP: a click jumps the convo to
      // the turn at that instant and nothing scrubs (rev 4 — the first cut
      // entered replay on any touch, which made an overview click a mode
      // switch). Replay entry stays on ⏵ / Space / the arrows.
      if (!replay.active) {
        const el = e.target && e.target.closest ? e.target.closest('[data-rpt]') : null;
        // a turn block jumps to its PROMPT (data-rpj), not to where the
        // prompt became visible — the convo lands on the turn's head
        const t = el ? parseFloat(el.dataset.rpj || el.dataset.rpt) : timeFromPointer(e);
        if (t != null && isFinite(t)) rpJumpConvoTo(t, !!(el && el.dataset.rpj));
        return;
      }
      try { rpTrack.setPointerCapture(e.pointerId); } catch {}
      // Shift+drag selects a slice; a plain drag scrubs the cursor.
      if (e.shiftKey) {
        const t = timeFromPointer(e);
        if (t == null) return;
        rpSliceDrag = true;
        pausePlayback();
        replay.sliceA = t;
        replay.sliceB = t;
        renderReplayBar();
        return;
      }
      rpDragging = true;
      rpDownX = e.clientX;
      // A press on a SPAN defers: a click jumps to that pair's end (the
      // boundary where it became visible), a drag from it still scrubs.
      const el = e.target && e.target.closest ? e.target.closest('[data-rpt]') : null;
      const t = el ? parseFloat(el.dataset.rpt) : NaN;
      if (isFinite(t)) { rpClickSeek = t; return; }
      rpClickSeek = null;
      seekFromPointer(e);
    });
    rpTrack.addEventListener('pointermove', (e) => {
      if (rpSliceDrag) {
        const t = timeFromPointer(e);
        if (t != null) { replay.sliceB = t; renderReplayBar(); }
      } else if (rpDragging) {
        if (rpClickSeek != null) {
          if (Math.abs(e.clientX - rpDownX) < 3) return; // a wiggle is still a click
          rpClickSeek = null;
        }
        seekFromPointer(e);
      }
    });
    rpTrack.addEventListener('pointerup', () => {
      if (!replay.active) return; // the minimap click already happened on pointerdown
      if (rpSliceDrag) {
        rpSliceDrag = false;
        // A shift-CLICK (no drag) selects nothing — clear instead of
        // keeping a zero-width band that filters everything out.
        if (!slicePairs(pairs).length) { clearSlice(); return; }
        replay.cursor = Math.max(replay.sliceA, replay.sliceB);
        refreshReplay();
        updateReplayHash();
        return;
      }
      if (rpClickSeek != null) { seekReplay(rpClickSeek); rpClickSeek = null; }
      rpDragging = false;
      updateReplayHash();
    });
    // Wheel zooms the strip around the pointer, 1x fit to 32x. The strip has
    // its own handler instead of wireWheelZoom's fraction math: with idle
    // compressed, a fraction of the track is not a fixed instant across a
    // zoom step (the breaks keep their 28px while the busy time stretches),
    // so the anchor is the TIME under the pointer, mapped back after.
    // Deeper zoom is deeper reading: the width class and data-depth are
    // recomputed on every step.
    if (rpScroll.addEventListener) rpScroll.addEventListener('wheel', (e) => {
      if (e.shiftKey || e.ctrlKey || !e.deltaY) return;
      e.preventDefault();
      const cur = replay.zoom;
      const next = Math.max(1, Math.min(RP_ZOOM_MAX, cur * (e.deltaY < 0 ? 1.25 : 0.8)));
      if (Math.abs(next - cur) < 0.001) return;
      const r = rpScroll.getBoundingClientRect();
      const x = e.clientX - r.left;
      const before = rpScale();
      const at = before ? scaleT(before, (rpScroll.scrollLeft || 0) + x) : 0;
      replay.zoom = next;
      renderReplayStrip(true);
      const after = rpScale();
      if (after) rpScroll.scrollLeft = Math.max(0, scaleX(after, at) - x);
    }, { passive: false });

    // ---- Select-to-purge ----
    // The web face of "cctrace purge", but by hand-picked request: enter
    // selection mode, click rows (or "all shown" with a filter active),
    // purge. The server deletes the pairs from memory AND rewrites the
    // backing .jsonl file(s) — a privacy tool, so it confirms first and
    // reports what could not be rewritten. Snapshots have no server to
    // delete from; the button hides there.
    const selectToggle = document.getElementById('select-toggle');
    const selCount = document.getElementById('sel-count');
    const selShown = document.getElementById('sel-shown');
    const selNone = document.getElementById('sel-none');
    const selPurge = document.getElementById('sel-purge');
    function updateSelBar() {
      if (!selMode) return;
      selCount.textContent = selIds.size + ' selected';
      selPurge.disabled = selIds.size === 0;
      selPurge.textContent = selIds.size ? 'purge ' + selIds.size : 'purge';
    }
    function setSelMode(on) {
      selMode = on;
      if (!on) selIds.clear();
      document.body.classList.toggle('selecting', on);
      selectToggle.classList.toggle('active', on);
      render();
      updateSelBar();
    }
    selectToggle.onclick = () => setSelMode(!selMode);
    selNone.onclick = () => { selIds.clear(); render(); updateSelBar(); };
    selShown.onclick = () => {
      for (const p of visibleList()) selIds.add(p.id);
      render();
      updateSelBar();
    };
    // Row clicks toggle selection instead of navigating (capture phase so
    // the row's anchor never fires).
    pairsEl.addEventListener('click', (e) => {
      if (!selMode) return;
      const row = e.target && e.target.closest ? e.target.closest('.pair') : null;
      if (!row || !row.dataset.id) return;
      e.preventDefault();
      e.stopPropagation();
      if (selIds.has(row.dataset.id)) selIds.delete(row.dataset.id);
      else selIds.add(row.dataset.id);
      row.classList.toggle('sel', selIds.has(row.dataset.id));
      updateSelBar();
    }, true);
    selPurge.onclick = () => {
      const n = selIds.size;
      if (!n) return;
      if (!confirm('Purge ' + n + ' request' + (n === 1 ? '' : 's') + ' from the trace?\\n\\n' +
        'This deletes them from the page AND rewrites the .jsonl trace file(s). There is no undo.')) return;
      fetch('/api/purge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selIds) }),
      }).then(r => r.json().then(res => ({ ok: r.ok, res })))
        .then(({ ok, res }) => {
          if (!ok) { alert('purge failed: ' + (res.error || 'server error')); return; }
          // The 'purged' broadcast removes the rows on every connected page,
          // this one included. Only surface what did NOT fully happen.
          if (res.skippedFiles && res.skippedFiles.length) {
            alert('Purged from the page, but these file(s) could not be rewritten (live writer or archive changed mid-flight):\\n' +
              res.skippedFiles.join('\\n') + '\\n\\nRe-run the purge, or use: cctrace purge');
          }
        })
        .catch(e => alert('purge failed: ' + e));
    };
    if (IS_SNAPSHOT) selectToggle.style.display = 'none';

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

    // ---- The pulse: live eyes on the session ----
    // A completed pair means the model just replied — the agent is now
    // running tools or composing the next request. The strip shows the
    // last reply's work (tool labels), its age (the one ticking surface
    // the live page allows — terminal convention), and the newest
    // request's cache deadline: absolute hold-until while it holds, an
    // amber "expired" once passed. Only the newest deadline is shown —
    // every later hit refreshes the TTL, so older deadlines mean nothing.
    function fmtAgo(ms) {
      const sec = Math.floor(ms / 1000);
      if (sec < 60) return sec + 's ago';
      const m = Math.floor(sec / 60);
      if (m < 60) return m + 'm ' + (sec % 60) + 's ago';
      return Math.floor(m / 60) + 'h ' + (m % 60) + 'm ago';
    }
    function renderPulse() {
      if (IS_READING || !pulseEl) return;
      const p = lastModelPair;
      if (!p) {
        pulseEl.innerHTML = '<span class="p-star">\u273b</span><span class="p-act">waiting for the wire\u2026</span>';
        return;
      }
      const ci = p._ci || (p._ci = extractCallInfo(p));
      const end = pairEndMs(p);
      const age = Math.max(0, Date.now() - end);
      const fresh = age <= 30000;
      pulseEl.classList.toggle('idle', !fresh);
      let act = '';
      try { act = turnToolLabel({ role: 'assistant', blocks: responseBlocks(p) }) || ''; } catch {}
      if (!act) act = ci.stopReason === 'tool_use' ? 'mid-loop \u2014 more work coming' : 'replied';
      const cc = summarizeCache(ci, p.request.body, end);
      let cache = '';
      if (cc && cc.expiresAt) {
        cache = Date.now() > cc.expiresAt
          ? '<span class="p-exp" data-tip="prompt cache expired\\nthe cached prefix passed its TTL \\u2014 the next request re-writes it at write price (1.25x/2x input)\\n---\\n> every hit before expiry would have refreshed the clock">\\u2261 expired</span>'
          : '<span class="p-t" data-tip="' + escapeHtml(cc.title) + '">\u2261 ~' + fmtTime(new Date(cc.expiresAt)).slice(0, 5) + '</span>';
      }
      // While fresh, a rotating verb leads (clocked off wall time, no extra
      // state); a changed action line gets one 160ms fade \u2014 the same motion
      // budget live-arrived rows use, nothing loops.
      const verb = fresh ? '<span class="p-verb">' + VERBS[Math.floor(Date.now() / 2000) % VERBS.length] + '\u2026</span>' : '';
      const actHtml = escapeHtml(shortModel(ci.model || '') || '?') + ' \u00b7 ' + act;
      const changed = pulseEl.dataset.act !== actHtml;
      pulseEl.dataset.act = actHtml;
      pulseEl.innerHTML = '<span class="p-star">\u273b</span>' + verb +
        '<span class="p-act' + (changed ? ' p-fade' : '') + '">' + actHtml + '</span>' +
        '<span class="p-t">' + fmtAgo(age) + '</span>' + cache;
    }
    let expFlipped = false;
    if (!IS_SNAPSHOT && !IS_VIEW) {
      document.body.classList.add('pulse-on');
      renderPulse();
      setInterval(() => {
        renderPulse();
        // When the newest deadline passes, re-render once so the requests
        // list's "\u00b7 expired" marker appears without a reload.
        const p = lastModelPair;
        if (p && p._ci) {
          const cc = summarizeCache(p._ci, p.request.body, pairEndMs(p));
          if (cc && cc.expiresAt) {
            const past = Date.now() > cc.expiresAt;
            if (past && !expFlipped) { expFlipped = true; render(); }
            if (!past) expFlipped = false;
          }
        }
      }, 1000);
    }

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
      if (IS_VIEW) {
        // Reading a finished trace: no auto-tail, the document opens where
        // documents open. The socket still loads the pairs.
        statusEl.textContent = 'view';
        statusEl.className = 'status snapshot';
        autoScroll = false;
        autoScrollBtn.classList.remove('active');
      }
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
