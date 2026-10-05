/** The landing page's three screenshots, from the published sample.
 *
 *   python3 -m http.server 8795            # from the repo root
 *   bun run docs/demo/shoot.ts             # writes docs/assets/{session,context,requests}.png
 *
 * Same session, same UI, one size (1440x850, dark) — the tabs on the landing
 * page are three ways into one recording, so they must be one recording.
 */
import { chromium } from "playwright";

const BASE = process.env.DEMO_BASE || "http://127.0.0.1:8795/docs/demo/sample.html";
const OUT = new URL("../assets/", import.meta.url).pathname;
const PAIR = process.env.DEMO_PAIR || "";

const shots: { name: string; route: string; settle?: number }[] = [
  { name: "session", route: "#/session" },
  { name: "context", route: "#/context" },
  { name: "requests", route: PAIR ? `#/p/${PAIR}` : "#/requests" },
];

// CHROME_PATH lets the shot use a chromium the machine already has (the deva
// image ships one under /opt/ms-playwright) instead of a second download.
const browser = await chromium.launch({
  args: ["--force-color-profile=srgb"],
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 850 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
for (const shot of shots) {
  await page.goto(BASE + shot.route, { waitUntil: "networkidle" });
  // The page paints a skeleton first and fills it once the payload parses.
  await page.waitForTimeout(shot.settle ?? 2500);
  await page.screenshot({ path: OUT + shot.name + ".png" });
  console.log("wrote", OUT + shot.name + ".png");
}
await browser.close();
