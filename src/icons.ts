import { readFileSync } from "node:fs";
import claudeAsset from "../assets/agents/claude.png" with { type: "file" };
import codexAsset from "../assets/agents/codex.png" with { type: "file" };
import grokAsset from "../assets/agents/grok.png" with { type: "file" };
import kimiAsset from "../assets/agents/kimi.png" with { type: "file" };
import opencodeAsset from "../assets/agents/opencode.png" with { type: "file" };

// Official site assets, embedded so live pages and offline snapshots use
// the same marks without making third-party requests. Sources: assets/agents/README.md.
export const CLIENT_ICONS: Record<string, string> = Object.fromEntries(
  Object.entries({ claude: claudeAsset, codex: codexAsset, grok: grokAsset, kimi: kimiAsset, opencode: opencodeAsset }).map(([name, asset]) => {
    const data = readFileSync(asset).toString("base64");
    return [name, `<svg viewBox="0 0 24 24" aria-hidden="true"><image width="24" height="24" href="data:image/png;base64,${data}"/></svg>`];
  }),
);

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
