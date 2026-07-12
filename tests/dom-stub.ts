// Minimal DOM stub for executing the inline page script outside a browser.
// Enough surface for boot + route rendering; innerHTML writes are recorded so
// tests can grammar-check every fragment the page generates.

export type Listener = (e: unknown) => void;

export interface Fragment {
  id: string;
  html: string;
  route: string;
}

export interface StubPage {
  els: Record<string, StubEl>;
  fragments: Fragment[];
  /** Errors thrown during boot or navigation, tagged with the route. */
  errors: string[];
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

/**
 * Boot the page script from a rendered snapshot against the stub DOM.
 * `pairs` ride in via window.__PAIRS__ exactly like a real snapshot.
 */
export function bootSnapshotPage(snapshotHtml: string): StubPage {
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
  const locationStub = { hash: "" };
  const historyStub = { replaceState: () => {} };
  const windowStub: Record<string, unknown> = {
    addEventListener: (t: string, f: Listener) => { (winListeners[t] ||= []).push(f); },
    CSS: null,
  };
  const localStorageStub = { getItem: () => null, setItem: () => {} };
  const navigatorStub = { clipboard: { writeText: async () => {} } };

  // Pull __PAIRS__ out of the snapshot's own embed so the test exercises the
  // real serialization path, then run the page script.
  const pairsMatch = snapshotHtml.match(/<script>window\.__PAIRS__ = (.*?);<\/script>\n<\/head>/s);
  if (pairsMatch) windowStub.__PAIRS__ = JSON.parse(pairsMatch[1]);
  const scriptMatch = snapshotHtml.match(/<script>\n([\s\S]*)\n {2}<\/script>/);
  if (!scriptMatch) throw new Error("page script not found in snapshot html");

  const errors: string[] = [];
  const run = new Function("window", "document", "localStorage", "location", "history", "navigator", scriptMatch[1]);
  try {
    run(windowStub, documentStub, localStorageStub, locationStub, historyStub, navigatorStub);
  } catch (e) {
    errors.push(`(boot): ${(e as Error).stack || e}`);
  }

  const fire = (map: Record<string, Listener[]>, type: string, ev: unknown) =>
    (map[type] || []).forEach((f) => f(ev));

  return {
    els,
    fragments,
    errors,
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
