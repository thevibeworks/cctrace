// Minimal DOM stub for executing the inline page script outside a browser.
// Enough surface for boot + route rendering; innerHTML writes are recorded so
// tests can grammar-check every fragment the page generates.
import markedSrc from "../src/vendor/marked.umd.js" with { type: "text" };

export type Listener = (e: unknown) => void;

export interface Fragment {
  id: string;
  html: string;
  route: string;
}

export interface StubSocket {
  url: string;
  onopen: Listener | null;
  onclose: Listener | null;
  onmessage: Listener | null;
  sent: string[];
}

export interface StubPage {
  els: Record<string, StubEl>;
  fragments: Fragment[];
  /** Errors thrown during boot or navigation, tagged with the route. */
  errors: string[];
  /** WebSockets the page opened (live/view boots) — drive onmessage to feed pairs. */
  sockets: StubSocket[];
  goto(hash: string): void;
  fireKey(key: string, opts?: Record<string, unknown>): void;
}

// The stub is duck-typed against what the page script actually touches.
export type StubEl = ReturnType<typeof makeEl>;

function makeEl(id: string, fragments: Fragment[], routeRef: { current: string }) {
  let inner = "";
  const listeners: Record<string, Listener[]> = {};
  const el = {
    id,
    textContent: "",
    title: "",
    value: "",
    style: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    onclick: null as Listener | null,
    oninput: null as Listener | null,
    listeners,
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 500,
    className: "",
    classList: {
      _s: new Set<string>(),
      add(c: string) { this._s.add(c); },
      remove(c: string) { this._s.delete(c); },
      toggle(c: string, v?: boolean) {
        if (v === undefined) v = !this._s.has(c);
        if (v) this._s.add(c); else this._s.delete(c);
        return v;
      },
      contains(c: string) { return this._s.has(c); },
    },
    addEventListener(t: string, f: Listener) { (listeners[t] ||= []).push(f); },
    querySelectorAll() { return [] as unknown[]; },
    querySelector() { return null; },
    appendChild(child: { innerHTML?: string }) {
      // list rows are built on detached divs then appended — capture here too
      if (child && child.innerHTML) fragments.push({ id, html: child.innerHTML, route: routeRef.current });
    },
    setPointerCapture() {},
    getBoundingClientRect() { return { left: 0, width: 100, top: 0, height: 24 }; },
    setAttribute() {},
    removeAttribute() {},
    scrollIntoView() {},
    get innerHTML() { return inner; },
    set innerHTML(v: string) {
      inner = v;
      if (v) fragments.push({ id, html: v, route: routeRef.current });
    },
  };
  return el;
}

export interface BootOpts {
  /**
   * Answer the page's fetch calls (default: a promise that never settles,
   * so pollInstances stays parked). Resolve `/api/instances` here to render
   * the switcher.
   */
  fetch?: (url: string) => Promise<unknown>;
  /** location.hostname the page reads — sibling instance hrefs are built from it. */
  hostname?: string;
}

/**
 * Boot the page script against the stub DOM. Works for both page kinds:
 * a snapshot rides its pairs in via window.__PAIRS__; a live/view page
 * opens a (stubbed) WebSocket — returned in `sockets` so the test can
 * drive `onmessage` with init/pair frames exactly like the server would.
 * The non-snapshot boot path MUST be executed somewhere: IS_SNAPSHOT
 * short-circuits guard it, so snapshot boots alone leave it untested
 * (the 0.25.0 META temporal-dead-zone shipped exactly that way).
 */
export function bootPage(snapshotHtml: string, opts: BootOpts = {}): StubPage {
  const fragments: Fragment[] = [];
  const routeRef = { current: "(boot)" };
  const docListeners: Record<string, Listener[]> = {};
  const winListeners: Record<string, Listener[]> = {};
  const els: Record<string, StubEl> = {};
  const byId = (id: string) => (els[id] ||= makeEl(id, fragments, routeRef));

  const documentStub: Record<string, unknown> = {
    documentElement: makeEl("<html>", fragments, routeRef),
    body: makeEl("<body>", fragments, routeRef),
    getElementById: byId,
    createElement: (tag: string) => makeEl("<" + tag + ">", fragments, routeRef),
    querySelectorAll: () => [],
    addEventListener: (t: string, f: Listener) => { (docListeners[t] ||= []).push(f); },
    title: "",
  };
  const locationStub = { hash: "", hostname: opts.hostname ?? "127.0.0.1" };
  const historyStub = { replaceState: () => {} };
  const windowStub: Record<string, unknown> = {
    addEventListener: (t: string, f: Listener) => { (winListeners[t] ||= []).push(f); },
    CSS: null,
  };
  const localStorageStub = { getItem: () => null, setItem: () => {} };
  const navigatorStub = { clipboard: { writeText: async () => {} } };
  const sockets: StubSocket[] = [];
  class WebSocketStub implements StubSocket {
    url: string;
    onopen: Listener | null = null;
    onclose: Listener | null = null;
    onmessage: Listener | null = null;
    sent: string[] = [];
    constructor(url: string) { this.url = url; sockets.push(this); }
    send(s: string) { this.sent.push(s); }
    close() {}
  }
  // Never resolves: pollInstances stays parked instead of rescheduling
  // itself on a rejection during the test run.
  const fetchStub = opts.fetch ?? (() => new Promise(() => {}));

  // Pull __PAIRS__ out of the snapshot's own embed so the test exercises the
  // real serialization path, then run the page script.
  const pairsMatch = snapshotHtml.match(/<script>window\.__PAIRS__ = (.*?);<\/script>\n<\/head>/s);
  if (pairsMatch) windowStub.__PAIRS__ = JSON.parse(pairsMatch[1]);
  const scriptMatch = snapshotHtml.match(/<script>\n([\s\S]*)\n {2}<\/script>/);
  if (!scriptMatch) throw new Error("page script not found in snapshot html");

  const errors: string[] = [];
  // Eval vendored libraries the page loads in earlier <script> tags (marked.js)
  new Function(markedSrc)();
  const run = new Function(
    "window", "document", "localStorage", "location", "history", "navigator", "WebSocket", "fetch",
    scriptMatch[1],
  );
  try {
    run(windowStub, documentStub, localStorageStub, locationStub, historyStub, navigatorStub, WebSocketStub, fetchStub);
  } catch (e) {
    errors.push(`(boot): ${(e as Error).stack || e}`);
  }

  const fire = (map: Record<string, Listener[]>, type: string, ev: unknown) =>
    (map[type] || []).forEach((f) => f(ev));

  return {
    els,
    fragments,
    errors,
    sockets,
    goto(hash: string) {
      routeRef.current = hash;
      locationStub.hash = hash;
      try {
        fire(winListeners, "hashchange", {});
      } catch (e) {
        errors.push(`${hash}: ${(e as Error).stack || e}`);
      }
    },
    fireKey(key: string, opts: Record<string, unknown> = {}) {
      fire(docListeners, "keydown", { key, preventDefault() {}, target: null, ...opts });
    },
  };
}

/** Historical name — snapshot boots predate live-page boots. Same machinery. */
export const bootSnapshotPage = bootPage;
