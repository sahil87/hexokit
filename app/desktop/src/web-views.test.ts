/**
 * node:test suite for the web-tile guest registry pure logic (run via
 * `pnpm run test` after compile — the `views.test.ts` convention).
 *
 * The handle is a plain string here — the module is generic over it, which is
 * exactly what keeps it electron-free.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  addWebView,
  adoptParkedWebView,
  emptyWebViews,
  findWebViewByContents,
  findWebViewBySender,
  getWebView,
  hostAttachPlan,
  hostDetachPlan,
  isGuestContents,
  moveWebViewToWindow,
  PARKED_WEB_VIEW_CAP,
  parkWebView,
  parkWindowWebViewsInto,
  removeHostWebViews,
  removeHostWebViewsEverywhere,
  removeWebView,
  removeWindowWebViews,
  setWebViewBounds,
  setWebViewChords,
  setWebViewVisible,
  setWebViewZoomFactor,
  WebViewsState,
} from "./web-views";

const WIN1 = 1;
const WIN2 = 2;

/** (win 1, host-a, host contents 11, guest contents 101) + a host-b sibling. */
function seeded(): WebViewsState<string> {
  let state = emptyWebViews<string>();
  state = addWebView(state, {
    windowId: WIN1,
    hostId: "host-a",
    hostContentsId: 11,
    tabKey: "t1",
    webContentsId: 101,
    handle: "guest-a1",
  });
  state = addWebView(state, {
    windowId: WIN1,
    hostId: "host-b",
    hostContentsId: 12,
    tabKey: "t1",
    webContentsId: 102,
    handle: "guest-b1",
  });
  return state;
}

// ── add / get (create-once per (hostContentsId, tabKey)) ─────────────────────

test("empty registry has no entries", () => {
  const state = emptyWebViews<string>();
  assert.equal(state.entries.length, 0);
  assert.equal(getWebView(state, 11, "t1"), null);
});

test("addWebView registers a fresh entry visible with zero bounds", () => {
  const state = addWebView(emptyWebViews<string>(), {
    windowId: WIN1,
    hostId: "host-a",
    hostContentsId: 11,
    tabKey: "t1",
    webContentsId: 101,
    handle: "guest-a1",
  });
  const entry = getWebView(state, 11, "t1");
  assert.ok(entry);
  assert.equal(entry.visible, true);
  assert.deepEqual(entry.bounds, { x: 0, y: 0, width: 0, height: 0 });
  assert.equal(entry.handle, "guest-a1");
});

test("addWebView for an existing (hostContentsId, tabKey) is a no-op (create-once)", () => {
  let state = addWebView(emptyWebViews<string>(), {
    windowId: WIN1,
    hostId: "host-a",
    hostContentsId: 11,
    tabKey: "t1",
    webContentsId: 101,
    handle: "guest-a1",
  });
  state = setWebViewVisible(state, 11, "t1", false);
  const next = addWebView(state, {
    windowId: WIN1,
    hostId: "host-a",
    hostContentsId: 11,
    tabKey: "t1",
    webContentsId: 999,
    handle: "guest-a1-replacement",
  });
  assert.equal(next, state); // unchanged — the caller destroys + recreates on collision
  assert.equal(getWebView(next, 11, "t1")?.handle, "guest-a1");
  assert.equal(getWebView(next, 11, "t1")?.visible, false);
});

// ── sender resolution / membership ───────────────────────────────────────────

test("findWebViewBySender isolates two host webContents sharing a tabKey", () => {
  let state = emptyWebViews<string>();
  state = addWebView(state, {
    windowId: WIN1,
    hostId: "host-a",
    hostContentsId: 11,
    tabKey: "t1",
    webContentsId: 101,
    handle: "guest-a1",
  });
  // The same host shown in a SECOND window is a second host webContents.
  state = addWebView(state, {
    windowId: WIN2,
    hostId: "host-a",
    hostContentsId: 22,
    tabKey: "t1",
    webContentsId: 102,
    handle: "guest-a2",
  });
  assert.equal(findWebViewBySender(state, 11, "t1")?.webContentsId, 101);
  assert.equal(findWebViewBySender(state, 22, "t1")?.webContentsId, 102);
  assert.equal(findWebViewBySender(state, 33, "t1"), null);
});

test("isGuestContents is true only for registered guest webContents ids", () => {
  const state = seeded();
  assert.equal(isGuestContents(state, 101), true);
  assert.equal(isGuestContents(state, 102), true);
  assert.equal(isGuestContents(state, 11), false); // the owning host's webContents
  assert.equal(isGuestContents(state, 999), false);
});

// ── visible / bounds records ─────────────────────────────────────────────────

test("setWebViewVisible and setWebViewBounds record the SPA-requested values", () => {
  let state = seeded();
  state = setWebViewVisible(state, 11, "t1", false);
  state = setWebViewBounds(state, 11, "t1", { x: 300, y: 100, width: 600, height: 400 });
  const entry = getWebView(state, 11, "t1");
  assert.ok(entry);
  assert.equal(entry.visible, false);
  assert.deepEqual(entry.bounds, { x: 300, y: 100, width: 600, height: 400 });
  // Siblings are untouched.
  assert.equal(getWebView(state, 12, "t1")?.visible, true);
});

test("mutators no-op on an unknown key", () => {
  const state = seeded();
  assert.equal(setWebViewVisible(state, 99, "t1", false), state);
  assert.equal(setWebViewBounds(state, 11, "nope", { x: 1, y: 2, width: 3, height: 4 }), state);
  const { state: afterRemove, removed } = removeWebView(state, 99, "t1");
  assert.equal(afterRemove, state);
  assert.equal(removed, null);
});

// ── scoped removals ──────────────────────────────────────────────────────────

test("removeWebView removes exactly one guest and returns it", () => {
  const state = seeded();
  const { state: next, removed } = removeWebView(state, 11, "t1");
  assert.equal(removed?.handle, "guest-a1");
  assert.equal(next.entries.length, 1);
  assert.ok(getWebView(next, 12, "t1")); // the host-b sibling survives
});

test("removeHostWebViews removes every guest of one host webContents", () => {
  let state = seeded();
  state = addWebView(state, {
    windowId: WIN1,
    hostId: "host-a",
    hostContentsId: 11,
    tabKey: "t2",
    webContentsId: 103,
    handle: "guest-a2",
  });
  const { state: next, removed } = removeHostWebViews(state, 11);
  assert.deepEqual(
    removed.map((e) => e.handle),
    ["guest-a1", "guest-a2"],
  );
  assert.equal(next.entries.length, 1);
  assert.ok(getWebView(next, 12, "t1"));
});

test("removeWindowWebViews removes every guest of one window", () => {
  let state = emptyWebViews<string>();
  state = addWebView(state, {
    windowId: WIN1,
    hostId: "host-a",
    hostContentsId: 11,
    tabKey: "t1",
    webContentsId: 101,
    handle: "guest-a1",
  });
  state = addWebView(state, {
    windowId: WIN1,
    hostId: "host-b",
    hostContentsId: 12,
    tabKey: "t1",
    webContentsId: 102,
    handle: "guest-b1",
  });
  state = addWebView(state, {
    windowId: WIN2,
    hostId: "host-a",
    hostContentsId: 21,
    tabKey: "t1",
    webContentsId: 201,
    handle: "guest-a-win2",
  });
  const { state: next, removed } = removeWindowWebViews(state, WIN1);
  assert.deepEqual(
    removed.map((e) => e.handle),
    ["guest-a1", "guest-b1"],
  );
  assert.equal(next.entries.length, 1);
  assert.ok(getWebView(next, 21, "t1"));
});

test("removeHostWebViewsEverywhere removes a host's guests across windows", () => {
  let state = emptyWebViews<string>();
  state = addWebView(state, {
    windowId: WIN1,
    hostId: "host-a",
    hostContentsId: 11,
    tabKey: "t1",
    webContentsId: 101,
    handle: "guest-a-win1",
  });
  state = addWebView(state, {
    windowId: WIN1,
    hostId: "host-b",
    hostContentsId: 12,
    tabKey: "t1",
    webContentsId: 102,
    handle: "guest-b1",
  });
  state = addWebView(state, {
    windowId: WIN2,
    hostId: "host-a",
    hostContentsId: 21,
    tabKey: "t1",
    webContentsId: 201,
    handle: "guest-a-win2",
  });
  const { state: next, removed } = removeHostWebViewsEverywhere(state, "host-a");
  assert.deepEqual(
    removed.map((e) => e.handle),
    ["guest-a-win1", "guest-a-win2"],
  );
  assert.equal(next.entries.length, 1);
  assert.ok(getWebView(next, 12, "t1"));
});

// ── attach / detach plans (the z-order authority) ────────────────────────────

test("hostDetachPlan lists every guest of the (window, host) regardless of visible", () => {
  let state = seeded(); // guest-a1 under (WIN1, host-a), guest-b1 under (WIN1, host-b)
  state = setWebViewVisible(state, 11, "t1", false);
  const plan = hostDetachPlan(state, WIN1, "host-a");
  assert.deepEqual(plan, ["guest-a1"]);
  // Pure query — the entry and its visible flag are untouched.
  assert.equal(getWebView(state, 11, "t1")?.visible, false);
  assert.equal(hostDetachPlan(state, WIN1, "host-c").length, 0);
  assert.equal(hostDetachPlan(state, WIN2, "host-a").length, 0);
});

test("hostAttachPlan preserves entries order and carries each entry's visible/bounds", () => {
  let state = emptyWebViews<string>();
  state = addWebView(state, {
    windowId: WIN1,
    hostId: "host-a",
    hostContentsId: 11,
    tabKey: "t1",
    webContentsId: 101,
    handle: "guest-a1",
  });
  state = addWebView(state, {
    windowId: WIN1,
    hostId: "host-a",
    hostContentsId: 11,
    tabKey: "t2",
    webContentsId: 102,
    handle: "guest-a2",
  });
  state = setWebViewBounds(state, 11, "t1", { x: 300, y: 100, width: 600, height: 400 });
  state = setWebViewVisible(state, 11, "t2", false);
  const plan = hostAttachPlan(state, WIN1, "host-a");
  assert.equal(plan.length, 2);
  assert.equal(plan[0]?.handle, "guest-a1");
  assert.equal(plan[0]?.visible, true);
  assert.deepEqual(plan[0]?.bounds, { x: 300, y: 100, width: 600, height: 400 });
  assert.equal(plan[1]?.handle, "guest-a2");
  assert.equal(plan[1]?.visible, false);
  // Pure query — the state is unchanged.
  assert.equal(getWebView(state, 11, "t1")?.visible, true);
});

test("z-order sequence: create under host-1 → switch away hides it → switch back re-raises with parked state", () => {
  // Create A (visible, parked bounds) and B (SPA-hidden) under host-1.
  let state = emptyWebViews<string>();
  state = addWebView(state, {
    windowId: WIN1,
    hostId: "host-1",
    hostContentsId: 11,
    tabKey: "a",
    webContentsId: 101,
    handle: "guest-A",
  });
  state = setWebViewBounds(state, 11, "a", { x: 300, y: 100, width: 600, height: 400 });
  state = addWebView(state, {
    windowId: WIN1,
    hostId: "host-1",
    hostContentsId: 11,
    tabKey: "b",
    webContentsId: 102,
    handle: "guest-B",
  });
  state = setWebViewVisible(state, 11, "b", false);

  // Switch to host-2: the detach plan hides BOTH guests (visible flag kept).
  const hidden = hostDetachPlan(state, WIN1, "host-1");
  assert.deepEqual(hidden, ["guest-A", "guest-B"]);
  assert.equal(getWebView(state, 11, "a")?.visible, true); // record untouched

  // Switch back: the attach plan re-raises A with its parked bounds and
  // visible flag, and B stays hidden.
  const plan = hostAttachPlan(state, WIN1, "host-1");
  assert.deepEqual(
    plan.map((p) => [p.handle, p.visible] as const),
    [
      ["guest-A", true],
      ["guest-B", false],
    ],
  );
  assert.deepEqual(plan[0]?.bounds, { x: 300, y: 100, width: 600, height: 400 });
});

// ── chords (the SPA-uploaded per-guest reclaim table) ───────────────────────

test("addWebView seeds an empty chord table", () => {
  const state = seeded();
  assert.deepEqual(getWebView(state, 11, "t1")?.chords, []);
});

test("setWebViewChords records the table; an unknown key is a no-op", () => {
  let state = seeded();
  const chords = [
    { code: "KeyK", ctrl: true, meta: false, shift: false, alt: false },
    { code: "Escape", ctrl: false, meta: false, shift: false, alt: false },
  ];
  state = setWebViewChords(state, 11, "t1", chords);
  assert.deepEqual(getWebView(state, 11, "t1")?.chords, chords);
  // The host-b sibling under the same tabKey is untouched.
  assert.deepEqual(getWebView(state, 12, "t1")?.chords, []);

  const before = state;
  assert.equal(setWebViewChords(state, 99, "t1", chords), before);
  assert.equal(setWebViewChords(state, 11, "nope", chords), before);
});

// ── zoom factor record ──────────────────────────────────────────────────────

test("addWebView seeds zoomFactor 1; setWebViewZoomFactor records it and no-ops on an unknown key", () => {
  let state = seeded();
  assert.equal(getWebView(state, 11, "t1")?.zoomFactor, 1);
  state = setWebViewZoomFactor(state, 11, "t1", 1.5);
  assert.equal(getWebView(state, 11, "t1")?.zoomFactor, 1.5);
  assert.equal(getWebView(state, 12, "t1")?.zoomFactor, 1); // sibling untouched
  assert.equal(setWebViewZoomFactor(state, 99, "t1", 2), state);
});

// ── park / adopt / LRU (the retention set) ──────────────────────────────────

/** A mounted entry WITH a retention identity under (WIN1, host-a, contents 11). */
function seededIdentified(identity = "id-1", tabKey = "t1", webContentsId = 101): WebViewsState<string> {
  let state = emptyWebViews<string>();
  state = addWebView(state, {
    windowId: WIN1,
    hostId: "host-a",
    hostContentsId: 11,
    tabKey,
    webContentsId,
    handle: `guest-${tabKey}`,
    identity,
  });
  return state;
}

test("parkWebView moves the entry to the parked set; an unknown key or an identity-less entry is a no-op", () => {
  let state = seededIdentified();
  state = setWebViewBounds(state, 11, "t1", { x: 10, y: 20, width: 300, height: 200 });
  state = setWebViewZoomFactor(state, 11, "t1", 1.25);
  const { state: parkedState, parked, evicted } = parkWebView(state, 11, "t1");
  assert.ok(parked);
  assert.equal(parked.identity, "id-1");
  assert.equal(parked.tabKey, "t1");
  assert.deepEqual(evicted, []);
  assert.equal(getWebView(parkedState, 11, "t1"), null);
  assert.equal(parkedState.entries.length, 0);
  assert.equal(parkedState.parked.length, 1);
  // The retained record survives whole — bounds, zoom, visible flag included.
  assert.deepEqual(parkedState.parked[0]?.bounds, { x: 10, y: 20, width: 300, height: 200 });
  assert.equal(parkedState.parked[0]?.zoomFactor, 1.25);
  assert.equal(parkedState.parked[0]?.visible, true);

  assert.deepEqual(parkWebView(state, 99, "t1"), { state, parked: null, evicted: [] });
  // No identity → cannot park (the caller takes the destroy path).
  assert.deepEqual(parkWebView(seeded(), 11, "t1"), {
    state: seeded(),
    parked: null,
    evicted: [],
  });
});

test("adoptParkedWebView rebinds an identity match to the new tabKey/hostContentsId", () => {
  let state = seededIdentified();
  state = setWebViewBounds(state, 11, "t1", { x: 10, y: 20, width: 300, height: 200 });
  state = setWebViewChords(state, 11, "t1", [
    { code: "KeyK", ctrl: true, meta: false, shift: false, alt: false },
  ]);
  state = setWebViewZoomFactor(state, 11, "t1", 0.8);
  state = setWebViewVisible(state, 11, "t1", false);
  state = parkWebView(state, 11, "t1").state;

  const { state: adoptedState, adopted } = adoptParkedWebView(
    state,
    WIN1,
    "host-a",
    "id-1",
    33, // a new host webContents
    "t2", // a fresh per-mount tabKey
  );
  assert.ok(adopted);
  assert.equal(adopted.tabKey, "t2");
  assert.equal(adopted.hostContentsId, 33);
  assert.equal(adopted.webContentsId, 101); // the same guest, never recreated
  assert.equal(adopted.identity, "id-1"); // kept — a later re-park needs it
  assert.deepEqual(adopted.bounds, { x: 10, y: 20, width: 300, height: 200 });
  assert.equal(adopted.chords.length, 1);
  assert.equal(adopted.zoomFactor, 0.8);
  assert.equal(adopted.visible, false); // the SPA-requested flag survives parking
  assert.equal(adoptedState.parked.length, 0);
  assert.ok(getWebView(adoptedState, 33, "t2"));
  assert.equal(getWebView(adoptedState, 11, "t1"), null);
  // findWebViewByContents resolves the adopted entry by its stable guest id.
  assert.equal(findWebViewByContents(adoptedState, 101)?.tabKey, "t2");
});

test("adoptParkedWebView on no match is a no-op returning null", () => {
  const state = parkWebView(seededIdentified(), 11, "t1").state;
  for (const [windowId, hostId, identity] of [
    [WIN1, "host-a", "id-other"], // identity mismatch
    [WIN2, "host-a", "id-1"], // the same identity in ANOTHER window
    [WIN1, "host-b", "id-1"], // the same identity under ANOTHER host
  ] as const) {
    const { state: next, adopted } = adoptParkedWebView(state, windowId, hostId, identity, 11, "t2");
    assert.equal(adopted, null);
    assert.equal(next, state);
  }
});

test("the parked set is scoped per (window, host): the same identity parks once per scope", () => {
  let state = emptyWebViews<string>();
  for (const [windowId, hostId, hostContentsId, webContentsId] of [
    [WIN1, "host-a", 11, 101],
    [WIN2, "host-a", 21, 201],
  ] as const) {
    state = addWebView(state, {
      windowId,
      hostId,
      hostContentsId,
      tabKey: "t1",
      webContentsId,
      handle: `guest-${webContentsId}`,
      identity: "id-shared",
    });
    state = parkWebView(state, hostContentsId, "t1").state;
  }
  assert.equal(state.parked.length, 2); // no cross-scope collision
  // Adopting in WIN2 leaves the WIN1 parked entry alone.
  const { state: next, adopted } = adoptParkedWebView(state, WIN2, "host-a", "id-shared", 22, "t9");
  assert.equal(adopted?.webContentsId, 201);
  assert.equal(next.parked.length, 1);
  assert.equal(next.parked[0]?.webContentsId, 101);
});

test("parking a second entry under an already-parked key evicts (replaces) the stale one", () => {
  let state = seededIdentified("id-1", "t1", 101);
  state = parkWebView(state, 11, "t1").state;
  // A second guest with the SAME identity mounted alongside (never adopted
  // because the first was still parked when it created) then parks too.
  state = addWebView(state, {
    windowId: WIN1,
    hostId: "host-a",
    hostContentsId: 11,
    tabKey: "t2",
    webContentsId: 102,
    handle: "guest-t2",
    identity: "id-1",
  });
  const { state: next, parked, evicted } = parkWebView(state, 11, "t2");
  assert.equal(parked?.webContentsId, 102);
  assert.deepEqual(
    evicted.map((e) => e.webContentsId),
    [101],
  );
  assert.equal(next.parked.length, 1);
  assert.equal(next.parked[0]?.webContentsId, 102);
});

test("LRU: parking past PARKED_WEB_VIEW_CAP evicts the least-recently-parked; mounted views never count", () => {
  assert.equal(PARKED_WEB_VIEW_CAP, 4);
  let state = emptyWebViews<string>();
  // Four MOUNTED entries parked one by one, plus one mounted entry that never
  // parks — it must not count toward the cap.
  state = addWebView(state, {
    windowId: WIN1,
    hostId: "host-a",
    hostContentsId: 11,
    tabKey: "mounted",
    webContentsId: 900,
    handle: "guest-mounted",
    identity: "id-mounted",
  });
  for (let n = 1; n <= PARKED_WEB_VIEW_CAP; n += 1) {
    state = addWebView(state, {
      windowId: WIN1,
      hostId: "host-a",
      hostContentsId: 11,
      tabKey: `t${n}`,
      webContentsId: n,
      handle: `guest-${n}`,
      identity: `id-${n}`,
    });
    const result = parkWebView(state, 11, `t${n}`);
    assert.deepEqual(result.evicted, []); // at or under the cap — no eviction
    state = result.state;
  }
  assert.equal(state.parked.length, PARKED_WEB_VIEW_CAP);
  // The fifth park evicts the least-recently-parked (id-1).
  state = addWebView(state, {
    windowId: WIN1,
    hostId: "host-a",
    hostContentsId: 11,
    tabKey: "t5",
    webContentsId: 5,
    handle: "guest-5",
    identity: "id-5",
  });
  const { state: capped, evicted } = parkWebView(state, 11, "t5");
  assert.deepEqual(
    evicted.map((e) => e.identity),
    ["id-1"],
  );
  assert.deepEqual(
    capped.parked.map((e) => e.identity),
    ["id-2", "id-3", "id-4", "id-5"],
  );
  assert.ok(getWebView(capped, 11, "mounted")); // the mounted entry is untouched
});

test("LRU: an adopt + re-park makes the entry the most-recently-parked", () => {
  let state = emptyWebViews<string>();
  for (let n = 1; n <= PARKED_WEB_VIEW_CAP; n += 1) {
    state = addWebView(state, {
      windowId: WIN1,
      hostId: "host-a",
      hostContentsId: 11,
      tabKey: `t${n}`,
      webContentsId: n,
      handle: `guest-${n}`,
      identity: `id-${n}`,
    });
    state = parkWebView(state, 11, `t${n}`).state;
  }
  // Adopt id-1 (the LRU head) and re-park it under a new tabKey — it moves to
  // the recency tail, so id-2 is now the eviction victim.
  state = adoptParkedWebView(state, WIN1, "host-a", "id-1", 11, "t1b").state;
  state = parkWebView(state, 11, "t1b").state;
  state = addWebView(state, {
    windowId: WIN1,
    hostId: "host-a",
    hostContentsId: 11,
    tabKey: "t5",
    webContentsId: 5,
    handle: "guest-5",
    identity: "id-5",
  });
  const { evicted } = parkWebView(state, 11, "t5");
  assert.deepEqual(
    evicted.map((e) => e.identity),
    ["id-2"],
  );
});

test("scoped removals return parked entries alongside mounted ones", () => {
  let state = seededIdentified("id-1", "t1", 101);
  state = parkWebView(state, 11, "t1").state; // parked under contents 11
  state = addWebView(state, {
    windowId: WIN1,
    hostId: "host-a",
    hostContentsId: 11,
    tabKey: "t2",
    webContentsId: 102,
    handle: "guest-102",
    identity: "id-2",
  });
  // The host-SPA reload seam: one host webContents loses both.
  const byHost = removeHostWebViews(state, 11);
  assert.deepEqual(
    byHost.removed.map((e) => e.webContentsId),
    [102, 101],
  );
  assert.equal(byHost.state.entries.length, 0);
  assert.equal(byHost.state.parked.length, 0);

  // The window-close seam.
  let winState = seededIdentified("id-1", "t1", 101);
  winState = parkWebView(winState, 11, "t1").state;
  const byWindow = removeWindowWebViews(winState, WIN1);
  assert.deepEqual(
    byWindow.removed.map((e) => e.webContentsId),
    [101],
  );
  assert.equal(byWindow.state.parked.length, 0);

  // The host-removal seam spans windows, parked entries included.
  let everywhere = emptyWebViews<string>();
  everywhere = addWebView(everywhere, {
    windowId: WIN2,
    hostId: "host-a",
    hostContentsId: 21,
    tabKey: "t1",
    webContentsId: 201,
    handle: "guest-201",
    identity: "id-1",
  });
  everywhere = parkWebView(everywhere, 21, "t1").state;
  const byHostEverywhere = removeHostWebViewsEverywhere(everywhere, "host-a");
  assert.deepEqual(
    byHostEverywhere.removed.map((e) => e.webContentsId),
    [201],
  );
  assert.equal(byHostEverywhere.state.parked.length, 0);
});

test("isGuestContents covers parked guests; the attach/detach plans do not", () => {
  let state = seededIdentified();
  state = parkWebView(state, 11, "t1").state;
  assert.equal(isGuestContents(state, 101), true); // still browses as a guest
  // A parked view must never paint: neither plan lists it.
  assert.deepEqual(hostDetachPlan(state, WIN1, "host-a"), []);
  assert.deepEqual(hostAttachPlan(state, WIN1, "host-a"), []);
});

// ── window-scope moves (the popout guest move) ───────────────────────────────

test("moveWebViewToWindow moves a PARKED entry into the target window's parked set", () => {
  let state = seededIdentified("id-1", "t1", 101);
  state = setWebViewBounds(state, 11, "t1", { x: 10, y: 20, width: 300, height: 200 });
  state = parkWebView(state, 11, "t1").state;

  const { state: next, moved, evicted } = moveWebViewToWindow(state, WIN1, WIN2, "host-a", "id-1");
  assert.ok(moved);
  assert.equal(moved.windowId, WIN2);
  assert.equal(moved.webContentsId, 101);
  assert.deepEqual(moved.bounds, { x: 10, y: 20, width: 300, height: 200 });
  assert.deepEqual(evicted, []);
  assert.equal(next.parked.length, 1);
  assert.equal(next.parked[0]?.windowId, WIN2);
  // The target window's ordinary adopt path now matches.
  const { adopted } = adoptParkedWebView(next, WIN2, "host-a", "id-1", 22, "t9");
  assert.equal(adopted?.webContentsId, 101);
  // The source window's plans no longer know the guest.
  assert.deepEqual(hostAttachPlan(next, WIN1, "host-a"), []);
  assert.deepEqual(hostDetachPlan(next, WIN1, "host-a"), []);
});

test("moveWebViewToWindow moves a still-MOUNTED entry (the create outran the park)", () => {
  const state = seededIdentified("id-1", "t1", 101);
  const { state: next, moved } = moveWebViewToWindow(state, WIN1, WIN2, "host-a", "id-1");
  assert.ok(moved);
  // Off the opener's mounted set, parked under the target window.
  assert.equal(next.entries.length, 0);
  assert.equal(next.parked.length, 1);
  assert.equal(next.parked[0]?.windowId, WIN2);
  assert.equal(getWebView(next, 11, "t1"), null);
  // The opener's late web:park finds nothing under its key.
  assert.deepEqual(parkWebView(next, 11, "t1"), { state: next, parked: null, evicted: [] });
});

test("moveWebViewToWindow rejects a wrong host, window, or identity (no-op null)", () => {
  let state = seededIdentified("id-1", "t1", 101);
  state = parkWebView(state, 11, "t1").state;
  for (const [from, to, hostId, identity] of [
    [WIN1, WIN2, "host-b", "id-1"], // another host's guest never moves
    [WIN2, WIN1, "host-a", "id-1"], // not parked under the source window
    [WIN1, WIN2, "host-a", "id-other"], // identity mismatch
  ] as const) {
    const { state: next, moved, evicted } = moveWebViewToWindow(state, from, to, hostId, identity);
    assert.equal(moved, null);
    assert.deepEqual(evicted, []);
    assert.equal(next, state);
  }
});

test("a move over the cap evicts the least-recently-parked OTHER entries, never the moved one", () => {
  let state = emptyWebViews<string>();
  // Fill the target window's parked set to the cap.
  for (let n = 0; n < PARKED_WEB_VIEW_CAP; n++) {
    state = addWebView(state, {
      windowId: WIN2,
      hostId: "host-a",
      hostContentsId: 21,
      tabKey: `t${n}`,
      webContentsId: 200 + n,
      handle: `guest-t${n}`,
      identity: `id-t${n}`,
    });
    state = parkWebView(state, 21, `t${n}`).state;
  }
  state = addWebView(state, {
    windowId: WIN1,
    hostId: "host-a",
    hostContentsId: 11,
    tabKey: "pop",
    webContentsId: 101,
    handle: "guest-pop",
    identity: "id-pop",
  });
  const { state: next, moved, evicted } = moveWebViewToWindow(state, WIN1, WIN2, "host-a", "id-pop");
  assert.equal(moved?.webContentsId, 101);
  assert.equal(next.parked.length, PARKED_WEB_VIEW_CAP);
  // The LRU victim is the oldest OTHER parked entry; the moved one stays.
  assert.deepEqual(evicted.map((e) => e.webContentsId), [200]);
  assert.ok(next.parked.some((p) => p.webContentsId === 101));
});

test("a move onto an already-parked key evicts the stale target entry", () => {
  let state = seededIdentified("id-1", "t1", 101);
  state = parkWebView(state, 11, "t1").state;
  // A stale entry already parked under the TARGET scope's same key.
  state = addWebView(state, {
    windowId: WIN2,
    hostId: "host-a",
    hostContentsId: 21,
    tabKey: "old",
    webContentsId: 201,
    handle: "guest-old",
    identity: "id-1",
  });
  state = parkWebView(state, 21, "old").state;
  const { state: next, moved, evicted } = moveWebViewToWindow(state, WIN1, WIN2, "host-a", "id-1");
  assert.equal(moved?.webContentsId, 101);
  assert.deepEqual(evicted.map((e) => e.webContentsId), [201]);
  assert.equal(next.parked.length, 1);
  assert.equal(next.parked[0]?.webContentsId, 101);
});

test("parkWindowWebViewsInto moves a closing window's mounted + parked guests of one host", () => {
  let state = emptyWebViews<string>();
  // The popout window (WIN2): one mounted guest of host-a, one parked of
  // host-a, one mounted identity-less, one mounted guest of ANOTHER host.
  state = addWebView(state, {
    windowId: WIN2,
    hostId: "host-a",
    hostContentsId: 21,
    tabKey: "m1",
    webContentsId: 201,
    handle: "guest-201",
    identity: "id-a1",
  });
  state = addWebView(state, {
    windowId: WIN2,
    hostId: "host-a",
    hostContentsId: 21,
    tabKey: "p1",
    webContentsId: 202,
    handle: "guest-202",
    identity: "id-a2",
  });
  state = parkWebView(state, 21, "p1").state;
  state = addWebView(state, {
    windowId: WIN2,
    hostId: "host-a",
    hostContentsId: 21,
    tabKey: "noid",
    webContentsId: 203,
    handle: "guest-203",
  });
  state = addWebView(state, {
    windowId: WIN2,
    hostId: "host-b",
    hostContentsId: 22,
    tabKey: "b1",
    webContentsId: 204,
    handle: "guest-204",
    identity: "id-b1",
  });
  const { state: next, moved, evicted } = parkWindowWebViewsInto(state, WIN2, WIN1, "host-a");
  assert.deepEqual(moved.map((e) => e.webContentsId), [201, 202]);
  assert.deepEqual(evicted, []);
  assert.ok(moved.every((e) => e.windowId === WIN1));
  assert.equal(next.entries.length, 2); // the identity-less + the other host's stay
  assert.deepEqual(
    next.entries.map((e) => e.webContentsId),
    [203, 204],
  );
  assert.equal(next.parked.length, 2);
  // The opener's ordinary adopt path matches a returned guest.
  const { adopted } = adoptParkedWebView(next, WIN1, "host-a", "id-a1", 11, "t1");
  assert.equal(adopted?.webContentsId, 201);
});

test("parkWindowWebViewsInto with nothing eligible is a no-op", () => {
  const state = seededIdentified("id-1", "t1", 101);
  assert.deepEqual(parkWindowWebViewsInto(state, WIN2, WIN1, "host-a"), {
    state,
    moved: [],
    evicted: [],
  });
});
