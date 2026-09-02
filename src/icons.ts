// Per-client icon glyphs — ONE source for every surface that labels a CLI
// (trace view header, dashboard rows, future pickers), so the mark a user
// learns in one place is the mark they see everywhere. Geometric strokes,
// currentColor, no fill: they inherit the text color of wherever they sit.
// Sizing is the embedding page's job (a CSS rule on `svg` in context) —
// the glyphs carry no class of their own.
export const CLIENT_ICONS: Record<string, string> = {
  claude: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 3v18M3 12h18M5.8 5.8l12.4 12.4M18.2 5.8L5.8 18.2"/></svg>',
  codex: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.6l8.2 4.7v9.4L12 21.4l-8.2-4.7V7.3z"/></svg>',
  grok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M7 21L17 3M17 21l-4.6-8.3"/></svg>',
  kimi: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3v18M6 12l9-9M6 12l9 9"/></svg>',
  opencode: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 6l6 6-6 6M14 18h5"/></svg>',
};

// The PRODUCT mark, redrawn in CDS geometry (0.48): two round-capped clay
// arcs — the cc — with the trace running out of them in ink to the clay
// terminal dot. Clay is identity here, which is the only place clay is
// spent besides a screen's one primary action. The arcs and the dot take
// currentColor (set to the brand ink by the embedding page); the trace
// line reads --text so it stays ink in both themes.
export const CCTRACE_MARK_PATHS =
  '<path stroke="currentColor" stroke-width="30" d="M270.75 175.6A125 125 0 1 0 270.75 336.4"/>' +
  '<path stroke="currentColor" stroke-width="30" d="M395.75 175.6A125 125 0 1 0 395.75 336.4"/>' +
  '<line stroke="var(--text)" stroke-width="12" x1="258" y1="256" x2="448" y2="256"/>' +
  '<circle fill="currentColor" stroke="none" cx="448" cy="256" r="20"/>';

/** The mark as a standalone svg, sized by the embedding page's CSS. */
export const CCTRACE_MARK =
  `<svg class="logo" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
  `<g fill="none" stroke-linecap="round">${CCTRACE_MARK_PATHS}</g></svg>`;
