/**
 * node:test suite for the per-window view registry pure logic (run via
 * `pnpm run test` after compile — the `hosts.test.ts` convention).
 *
 * The handle is a plain string here — the module is generic over it, which is
 * exactly what keeps it electron-free.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  activateView,
  activeHostForWindow,
  activeView,
  addView,
  aggregateBadge,
  deactivateViews,
  emptyViews,
  ERR_ABORTED,
  findViewByWebContentsId,
  getView,
  hostNameplate,
  nextLoadFailed,
  parseNameplateReport,
  removeHostViews,
  removeView,
  removeWindowViews,
  setViewBadge,
  setViewNameplate,
  setViewThemeColor,
  switchPaint,
  ViewsState,
} from "./views";

const WIN1 = 1;
const WIN2 = 2;

function seeded(): ViewsState<string> {
  let state = emptyViews<string>();
  state = addView(state, WIN1, "host-a", "view-a", 11);
  state = addView(state, WIN1, "host-b", "view-b", 22);
  return state;
}

// ── add / get (lazy creation, one view per (window, host) pair) ──────────────

test("empty registry has no entries and no active view", () => {
  const state = emptyViews<string>();
  assert.equal(state.entries.length, 0);
  assert.equal(state.active.length, 0);
  assert.equal(getView(state, WIN1, "host-a"), null);
  assert.equal(activeView(state, WIN1), null);
  assert.equal(activeHostForWindow(state, WIN1), null);
});

test("addView registers a fresh view with clean caches", () => {
  const state = addView(emptyViews<string>(), WIN1, "host-a", "view-a", 11);
  const entry = getView(state, WIN1, "host-a");
  assert.ok(entry);
  assert.equal(entry.windowId, WIN1);
  assert.equal(entry.handle, "view-a");
  assert.equal(entry.webContentsId, 11);
  assert.equal(entry.badgeCount, 0);
  assert.equal(entry.themeColor, null);
});

test("addView for an existing (window, host) pair is a no-op (create-once)", () => {
  let state = addView(emptyViews<string>(), WIN1, "host-a", "view-a", 11);
  state = setViewBadge(state, WIN1, "host-a", 3);
  const next = addView(state, WIN1, "host-a", "view-a2", 99);
  assert.equal(next, state); // unchanged — caller must reuse the existing view
  assert.equal(getView(next, WIN1, "host-a")?.handle, "view-a");
  assert.equal(getView(next, WIN1, "host-a")?.badgeCount, 3);
});

test("the same host in TWO windows gets two independent views", () => {
  let state = seeded();
  state = addView(state, WIN2, "host-a", "view-a2", 33);
  assert.equal(state.entries.length, 3);
  assert.equal(getView(state, WIN1, "host-a")?.handle, "view-a");
  assert.equal(getView(state, WIN2, "host-a")?.handle, "view-a2");
  // Caches are per (window, host): one window's reports never touch the other's.
  state = setViewBadge(state, WIN1, "host-a", 2);
  state = setViewBadge(state, WIN2, "host-a", 7);
  assert.equal(getView(state, WIN1, "host-a")?.badgeCount, 2);
  assert.equal(getView(state, WIN2, "host-a")?.badgeCount, 7);
});

test("entries preserve first-visit order", () => {
  const state = seeded();
  assert.deepEqual(
    state.entries.map((e) => e.hostId),
    ["host-a", "host-b"],
  );
});

// ── activate / deactivate (per window) ───────────────────────────────────────

test("activateView sets the attached host; deactivateViews clears it", () => {
  let state = activateView(seeded(), WIN1, "host-a");
  assert.equal(activeHostForWindow(state, WIN1), "host-a");
  assert.equal(activeView(state, WIN1)?.handle, "view-a");
  state = activateView(state, WIN1, "host-b");
  assert.equal(activeView(state, WIN1)?.handle, "view-b");
  state = deactivateViews(state, WIN1);
  assert.equal(activeHostForWindow(state, WIN1), null);
  assert.equal(activeView(state, WIN1), null);
});

test("activateView with an unknown (window, host) pair is a no-op", () => {
  const before = seeded();
  assert.equal(activateView(before, WIN1, "nope"), before);
  assert.equal(activateView(before, WIN2, "host-a"), before);
});

test("active pointers are per window — two windows show different hosts", () => {
  let state = seeded();
  state = addView(state, WIN2, "host-a", "view-a2", 33);
  state = activateView(state, WIN1, "host-a");
  state = activateView(state, WIN2, "host-a");
  assert.equal(activeHostForWindow(state, WIN1), "host-a");
  assert.equal(activeHostForWindow(state, WIN2), "host-a");
  state = activateView(state, WIN1, "host-b");
  assert.equal(activeHostForWindow(state, WIN1), "host-b");
  assert.equal(activeHostForWindow(state, WIN2), "host-a"); // window 2 untouched
});

test("deactivateViews keeps the per-view caches (welcome does not wipe them)", () => {
  let state = activateView(seeded(), WIN1, "host-a");
  state = setViewBadge(state, WIN1, "host-a", 4);
  state = deactivateViews(state, WIN1);
  assert.equal(getView(state, WIN1, "host-a")?.badgeCount, 4);
});

// ── remove ───────────────────────────────────────────────────────────────────

test("removeView returns the removed entry and clears an active pointer at it", () => {
  const before = activateView(seeded(), WIN1, "host-b");
  const { state, removed } = removeView(before, WIN1, "host-b");
  assert.equal(removed?.handle, "view-b");
  assert.equal(activeHostForWindow(state, WIN1), null);
  assert.equal(getView(state, WIN1, "host-b"), null);
  assert.ok(getView(state, WIN1, "host-a")); // the other view survives
});

test("removeView of a non-active pair keeps the active pointer", () => {
  const before = activateView(seeded(), WIN1, "host-a");
  const { state } = removeView(before, WIN1, "host-b");
  assert.equal(activeHostForWindow(state, WIN1), "host-a");
});

test("removeView of an unknown pair is a no-op with removed null", () => {
  const before = seeded();
  const { state, removed } = removeView(before, WIN1, "nope");
  assert.equal(removed, null);
  assert.equal(state, before);
});

test("removeWindowViews drops every view of that window only", () => {
  let state = seeded();
  state = addView(state, WIN2, "host-a", "view-a2", 33);
  state = activateView(state, WIN1, "host-a");
  state = activateView(state, WIN2, "host-a");
  const { state: next, removed } = removeWindowViews(state, WIN1);
  assert.deepEqual(
    removed.map((e) => e.handle).sort(),
    ["view-a", "view-b"],
  );
  assert.equal(getView(next, WIN1, "host-a"), null);
  assert.equal(activeHostForWindow(next, WIN1), null);
  assert.ok(getView(next, WIN2, "host-a")); // window 2 survives intact
  assert.equal(activeHostForWindow(next, WIN2), "host-a");
});

test("removeHostViews drops the host across ALL windows", () => {
  let state = seeded();
  state = addView(state, WIN2, "host-a", "view-a2", 33);
  state = activateView(state, WIN1, "host-a");
  state = activateView(state, WIN2, "host-a");
  const { state: next, removed } = removeHostViews(state, "host-a");
  assert.deepEqual(
    removed.map((e) => e.handle).sort(),
    ["view-a", "view-a2"],
  );
  assert.equal(getView(next, WIN1, "host-a"), null);
  assert.equal(getView(next, WIN2, "host-a"), null);
  assert.equal(activeHostForWindow(next, WIN1), null);
  assert.equal(activeHostForWindow(next, WIN2), null);
  assert.ok(getView(next, WIN1, "host-b")); // other hosts survive
});

// ── badge cache (per view, webContents-id keyed sender resolution) ──────────

test("badge counts are cached per view — shared origins stay distinct", () => {
  // Two host ENTRIES can share one origin (addHost never dedupes); the caches
  // key on (window, host) / webContents id, never on origin.
  let state = seeded();
  state = setViewBadge(state, WIN1, "host-a", 2);
  state = setViewBadge(state, WIN1, "host-b", 5);
  assert.equal(getView(state, WIN1, "host-a")?.badgeCount, 2);
  assert.equal(getView(state, WIN1, "host-b")?.badgeCount, 5);
});

test("setViewBadge for an unknown pair is a no-op", () => {
  const before = seeded();
  const state = setViewBadge(before, WIN1, "nope", 7);
  assert.equal(state, before);
});

test("findViewByWebContentsId resolves an IPC sender to its view", () => {
  const state = seeded();
  assert.equal(findViewByWebContentsId(state, 22)?.hostId, "host-b");
  assert.equal(findViewByWebContentsId(state, 99), null);
});

// ── aggregateBadge (sum across distinct displayed hosts) ────────────────────

test("aggregateBadge sums the waiting counts of distinct displayed hosts", () => {
  let state = seeded();
  state = addView(state, WIN2, "host-b", "view-b2", 33);
  state = setViewBadge(state, WIN1, "host-a", 3);
  state = setViewBadge(state, WIN2, "host-b", 2);
  state = setViewBadge(state, WIN1, "host-b", 9); // background view — not displayed
  state = activateView(state, WIN1, "host-a");
  state = activateView(state, WIN2, "host-b");
  assert.equal(aggregateBadge(state), 5);
});

test("a host displayed by two windows counts ONCE", () => {
  let state = seeded();
  state = addView(state, WIN2, "host-a", "view-a2", 33);
  state = setViewBadge(state, WIN1, "host-a", 3);
  state = setViewBadge(state, WIN2, "host-a", 4);
  state = activateView(state, WIN1, "host-a");
  state = activateView(state, WIN2, "host-a");
  assert.equal(aggregateBadge(state), 3); // the first-created window's cache wins
});

test("the duplicate dedupe keys on CREATION order, not activation order", () => {
  // Plan decision "Duplicate-host badge dedupe takes the first window's
  // cache": window ids increment with creation, so WIN1's cache supplies the
  // count even when WIN2 activated the host FIRST.
  let state = seeded();
  state = addView(state, WIN2, "host-a", "view-a2", 33);
  state = setViewBadge(state, WIN1, "host-a", 3);
  state = setViewBadge(state, WIN2, "host-a", 4);
  state = activateView(state, WIN2, "host-a"); // WIN2 activates first
  state = activateView(state, WIN1, "host-a");
  assert.equal(aggregateBadge(state), 3);
});

test("aggregateBadge is 0 with no attached views (all windows on welcome)", () => {
  let state = seeded();
  state = setViewBadge(state, WIN1, "host-a", 3); // cached but not displayed
  assert.equal(aggregateBadge(state), 0);
  state = deactivateViews(state, WIN1);
  assert.equal(aggregateBadge(state), 0);
});

// ── theme-color cache ────────────────────────────────────────────────────────

test("theme colors are cached per view", () => {
  let state = seeded();
  state = setViewThemeColor(state, WIN1, "host-a", "#112233");
  state = setViewThemeColor(state, WIN1, "host-b", "#445566");
  assert.equal(getView(state, WIN1, "host-a")?.themeColor, "#112233");
  assert.equal(getView(state, WIN1, "host-b")?.themeColor, "#445566");
});

test("setViewThemeColor accepts null (page without a theme-color meta)", () => {
  let state = setViewThemeColor(seeded(), WIN1, "host-a", "#112233");
  state = setViewThemeColor(state, WIN1, "host-a", null);
  assert.equal(getView(state, WIN1, "host-a")?.themeColor, null);
});

test("setViewThemeColor for an unknown pair is a no-op", () => {
  const before = seeded();
  assert.equal(setViewThemeColor(before, WIN1, "nope", "#112233"), before);
});

// ── switchPaint (the incoming-view repaint decision) ─────────────────────────

test("switchPaint on a fresh view clears the badge and defaults the color", () => {
  assert.deepEqual(switchPaint(seeded(), WIN1, "host-a"), {
    badgeCount: 0,
    themeColor: null,
  });
});

test("switchPaint on an unknown pair clears the badge and defaults the color", () => {
  assert.deepEqual(switchPaint(seeded(), WIN1, "nope"), {
    badgeCount: 0,
    themeColor: null,
  });
});

test("switchPaint returns the INCOMING view's caches, never the outgoing one's", () => {
  let state = activateView(seeded(), WIN1, "host-a");
  state = setViewBadge(state, WIN1, "host-a", 2);
  state = setViewThemeColor(state, WIN1, "host-a", "#112233");
  state = setViewBadge(state, WIN1, "host-b", 5); // background report — cached silently
  state = setViewThemeColor(state, WIN1, "host-b", "#445566");
  assert.deepEqual(switchPaint(state, WIN1, "host-b"), {
    badgeCount: 5,
    themeColor: "#445566",
  });
  // and switching back repaints A's own caches
  assert.deepEqual(switchPaint(state, WIN1, "host-a"), {
    badgeCount: 2,
    themeColor: "#112233",
  });
});

// ── load-failure flag (the remote-tunnel heal's reload gate) ─────────────────

test("the error page's did-finish-load does NOT clear a set failure flag", () => {
  // Regression: Chromium fires did-finish-load for its own error page right
  // after did-fail-load. Clearing there wiped the flag before the background
  // connect heal completed, so the reload gate never fired and a dead-tunnel
  // view stayed stuck on ERR_CONNECTION_REFUSED.
  let failed = nextLoadFailed(false, {
    kind: "did-fail-load",
    isMainFrame: true,
    errorCode: -102, // ERR_CONNECTION_REFUSED
  });
  assert.equal(failed, true);
  failed = nextLoadFailed(failed, { kind: "did-finish-load" });
  assert.equal(failed, true); // the heal's reload gate still fires
});

test("only a host did-navigate commit clears the flag; finish then keeps it clear", () => {
  // The successful-load sequence: did-navigate (real response committed —
  // never fired for an error page) then did-finish-load.
  let failed = nextLoadFailed(true, { kind: "did-navigate", isInterstitial: false });
  assert.equal(failed, false);
  failed = nextLoadFailed(failed, { kind: "did-finish-load" });
  assert.equal(failed, false);
});

test("an interstitial did-navigate commit preserves a set failure flag", () => {
  assert.equal(
    nextLoadFailed(true, { kind: "did-navigate", isInterstitial: true }),
    true,
  );
});

test("ERR_ABORTED and subframe failures neither set nor clear the flag", () => {
  const aborted = { kind: "did-fail-load", isMainFrame: true, errorCode: ERR_ABORTED } as const;
  const subframe = { kind: "did-fail-load", isMainFrame: false, errorCode: -102 } as const;
  assert.equal(nextLoadFailed(false, aborted), false);
  assert.equal(nextLoadFailed(false, subframe), false);
  assert.equal(nextLoadFailed(true, aborted), true);
  assert.equal(nextLoadFailed(true, subframe), true);
});

test("a heal-retry that fails again keeps the flag through the full event cycle", () => {
  // fail → finish (error page) → reload while the tunnel is STILL down:
  // fail → finish again — the flag must survive every step until a real
  // did-navigate commit lands.
  const fail = { kind: "did-fail-load", isMainFrame: true, errorCode: -102 } as const;
  let failed = false;
  for (const event of [fail, { kind: "did-finish-load" } as const, fail, { kind: "did-finish-load" } as const]) {
    failed = nextLoadFailed(failed, event);
    assert.equal(failed, true);
  }
  failed = nextLoadFailed(failed, { kind: "did-navigate", isInterstitial: false });
  assert.equal(failed, false);
});

// ── nameplate report (strip hover preview) ───────────────────────────────────

test("a fresh view has no nameplate report", () => {
  assert.equal(getView(seeded(), WIN1, "host-a")?.nameplate, null);
  assert.equal(hostNameplate(seeded(), "host-a"), null);
});

test("setViewNameplate caches the report on its view only", () => {
  const state = setViewNameplate(seeded(), WIN1, "host-a", { machine: "sahil@ws-01", agents: 3 });
  assert.deepEqual(hostNameplate(state, "host-a"), { machine: "sahil@ws-01", agents: 3 });
  assert.equal(hostNameplate(state, "host-b"), null);
});

test("setViewNameplate for an unknown pair is a no-op", () => {
  const before = seeded();
  assert.equal(setViewNameplate(before, WIN1, "nope", { agents: 1 }), before);
});

test("hostNameplate reads the first live view of the host that has reported", () => {
  let state = addView(seeded(), 2, "host-a", "view-a2", 33);
  state = setViewNameplate(state, 2, "host-a", { agents: 7 });
  assert.deepEqual(hostNameplate(state, "host-a"), { agents: 7 });
  state = setViewNameplate(state, WIN1, "host-a", { agents: 2 });
  assert.deepEqual(hostNameplate(state, "host-a"), { agents: 2 });
});

test("parseNameplateReport accepts any non-empty combination of the three fields", () => {
  assert.deepEqual(parseNameplateReport({ machine: "sahil@ws-01", os: "linux", agents: 11 }), {
    machine: "sahil@ws-01",
    os: "linux",
    agents: 11,
  });
  assert.deepEqual(parseNameplateReport({ agents: 0 }), { agents: 0 });
  assert.deepEqual(parseNameplateReport({ os: "darwin" }), { os: "darwin" });
});

test("parseNameplateReport rejects the whole payload on any malformed field", () => {
  const bad: unknown[] = [
    null,
    "x",
    [],
    {},
    { extra: 1 },
    { machine: "" },
    { machine: "a".repeat(257) },
    { machine: "bad\u0007bell" },
    { machine: 7 },
    { os: "lin ux" },
    { os: "a".repeat(33) },
    { os: 3 },
    { agents: -1 },
    { agents: 1.5 },
    { agents: "3" },
    { agents: 100_001 },
    { machine: "ok", agents: -1 },
    { machine: "ok", extra: true },
  ];
  for (const payload of bad) {
    assert.equal(parseNameplateReport(payload), null, JSON.stringify(payload));
  }
});
