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
};
