/**
 * node:test suite for the window-registry pure logic (run via
 * `pnpm run test` after compile — the `hosts.test.ts` convention).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { HostList } from "./hosts";
import { WindowRecord, WindowSet } from "./windows";
import {
  captureWindowRecord,
  hostRemovedFallback,
  newWindowTarget,
  orderRecordsForSave,
  restoreTargets,
  routeLeaf,
  windowListItems,
  windowSetForSave,
  windowTitle,
} from "./window-registry";

const PRODUCT = "HexoKit";

function twoHosts(): HostList {
  return {
    version: 1,
    activeId: "host-a",
    hosts: [
      { id: "host-a", name: "studio-mac", url: "http://100.101.2.3:3000", lastPath: "/utils2/rk-dev" },
      { id: "host-b", name: "buildbox", url: "http://127.0.0.1:3100" },
    ],
  };
}

function record(hostId: string | null, route: string): WindowRecord {
  return { hostId, route, bounds: { width: 1280, height: 800 } };
}

// ── routeLeaf / windowTitle ──────────────────────────────────────────────────

test("routeLeaf returns the last non-empty path segment", () => {
  assert.equal(routeLeaf("/utils2/rk-dev"), "rk-dev");
  assert.equal(routeLeaf("/utils2"), "utils2");
  assert.equal(routeLeaf("/utils2/rk-dev?x=1"), "rk-dev");
  assert.equal(routeLeaf("/utils2/"), "utils2");
});

test("routeLeaf is null for a bare origin or empty route", () => {
  assert.equal(routeLeaf(""), null);
  assert.equal(routeLeaf("/"), null);
  assert.equal(routeLeaf("?x=1"), null);
});

test("windowTitle joins host name and route leaf", () => {
  assert.equal(windowTitle(PRODUCT, "studio-mac", "/utils2/rk-dev"), "studio-mac — rk-dev");
  assert.equal(windowTitle(PRODUCT, "studio-mac", "/utils2"), "studio-mac — utils2");
});

test("windowTitle is the bare host name at the origin root", () => {
  assert.equal(windowTitle(PRODUCT, "studio-mac", ""), "studio-mac");
  assert.equal(windowTitle(PRODUCT, "studio-mac", "/"), "studio-mac");
});

test("windowTitle is the plain product name for a welcome window", () => {
  assert.equal(windowTitle(PRODUCT, null, ""), PRODUCT);
});

// ── newWindowTarget (duplicate-of-current) ──────────────────────────────────

test("newWindowTarget duplicates the source window's host and route", () => {
  assert.deepEqual(newWindowTarget({ hostId: "host-a", route: "/utils2/rk-dev" }), {
    hostId: "host-a",
    route: "/utils2/rk-dev",
  });
});

test("newWindowTarget of a welcome window is welcome", () => {
  assert.deepEqual(newWindowTarget({ hostId: null, route: "" }), { hostId: null, route: "" });
});

// ── orderRecordsForSave (focused last) ──────────────────────────────────────

test("orderRecordsForSave moves the focused window's record to the end", () => {
  const captures = [
    { windowId: 1, record: record("host-a", "/a") },
    { windowId: 2, record: record("host-b", "/b") },
    { windowId: 3, record: record(null, "") },
  ];
  const ordered = orderRecordsForSave(captures, 2);
  assert.deepEqual(
    ordered.map((r) => r.route),
    ["/a", "", "/b"],
  );
});

test("orderRecordsForSave leaves order untouched for a null/unknown focused id", () => {
  const captures = [
    { windowId: 1, record: record("host-a", "/a") },
    { windowId: 2, record: record("host-b", "/b") },
  ];
  assert.deepEqual(orderRecordsForSave(captures, null), captures.map((c) => c.record));
  assert.deepEqual(orderRecordsForSave(captures, 99), captures.map((c) => c.record));
});

// ── window-set capture (quit accumulation, close-one drop) ──────────────────

test("quit-time accumulation keeps EVERY window's record in the final save", () => {
  // A-012: a 3-window quit — each window's close adds its own record and
  // saves; windows closed earlier are already gone from the live registry,
  // so without accumulation each save would shrink and the surviving file
  // would hold only the last-closed window. The LAST save must hold the set.
  const creationOrder = [1, 2, 3];
  let captured = new Map<number, WindowRecord>();
  let saved: WindowSet = { version: 1, windows: [] };
  for (const windowId of creationOrder) {
    captured = captureWindowRecord(captured, windowId, record(`host-${windowId}`, `/r${windowId}`));
    saved = windowSetForSave(captured, creationOrder, 2); // window 2 focused
  }
  assert.deepEqual(
    saved.windows.map((r) => r.route),
    ["/r1", "/r3", "/r2"], // creation order, the focused window's record last
  );
});

test("a sentinel window captures null and never persists", () => {
  let captured = new Map<number, WindowRecord>();
  captured = captureWindowRecord(captured, 1, record("host-a", "/a"));
  captured = captureWindowRecord(captured, 2, null); // RK_DESKTOP_URL window
  const saved = windowSetForSave(captured, [1, 2], null);
  assert.deepEqual(
    saved.windows.map((r) => r.hostId),
    ["host-a"],
  );
});

test("closing one of N windows drops exactly that window's record", () => {
  // A-012: the closing window's id is excluded — the other records survive
  // in creation order (no spurious degraded record for the closed window).
  let captured = new Map<number, WindowRecord>();
  captured = captureWindowRecord(captured, 1, record("host-a", "/a"));
  captured = captureWindowRecord(captured, 2, record("host-b", "/b"));
  captured = captureWindowRecord(captured, 3, record(null, ""));
  captured = captureWindowRecord(captured, 2, null); // window 2 closed mid-session
  const saved = windowSetForSave(captured, [1, 2, 3], null);
  assert.deepEqual(
    saved.windows.map((r) => r.route),
    ["/a", ""],
  );
});

test("an empty capture saves an empty set (window-all-closed)", () => {
  assert.deepEqual(windowSetForSave(new Map(), [1, 2], null), {
    version: 1,
    windows: [],
  });
});

// ── restoreTargets ───────────────────────────────────────────────────────────

test("restoreTargets replays each record with its own route and bounds", () => {
  const set: WindowSet = {
    version: 1,
    windows: [record("host-a", "/other/route"), record(null, "")],
  };
  const targets = restoreTargets(set, twoHosts());
  assert.equal(targets.length, 2);
  assert.deepEqual(targets[0], {
    hostId: "host-a",
    route: "/other/route",
    bounds: { width: 1280, height: 800 },
  });
  assert.deepEqual(targets[1], { hostId: null, route: "", bounds: { width: 1280, height: 800 } });
});

test("restoreTargets falls back to the host lastPath when the record route is empty", () => {
  const set: WindowSet = { version: 1, windows: [record("host-a", "")] };
  const targets = restoreTargets(set, twoHosts());
  assert.deepEqual(targets[0], {
    hostId: "host-a",
    route: "/utils2/rk-dev",
    bounds: { width: 1280, height: 800 },
  });
});

test("restoreTargets degrades a record whose host is gone to the fallback", () => {
  const set: WindowSet = { version: 1, windows: [record("host-gone", "/x")] };
  const targets = restoreTargets(set, twoHosts());
  assert.deepEqual(targets[0], {
    hostId: "host-a", // resolveActiveHost — the active entry
    route: "/utils2/rk-dev",
    bounds: { width: 1280, height: 800 },
  });
});

test("restoreTargets on an empty set opens exactly one fallback window", () => {
  const targets = restoreTargets({ version: 1, windows: [] }, twoHosts());
  assert.deepEqual(targets, [{ hostId: "host-a", route: "/utils2/rk-dev", bounds: null }]);
});

test("restoreTargets on an empty set and empty host list opens one welcome window", () => {
  const targets = restoreTargets(
    { version: 1, windows: [] },
    { version: 1, activeId: null, hosts: [] },
  );
  assert.deepEqual(targets, [{ hostId: null, route: "", bounds: null }]);
});

test("restoreTargets degrades to welcome when the host is gone and none remain", () => {
  const set: WindowSet = { version: 1, windows: [record("host-gone", "/x")] };
  const targets = restoreTargets(set, { version: 1, activeId: null, hosts: [] });
  assert.deepEqual(targets, [{ hostId: null, route: "", bounds: { width: 1280, height: 800 } }]);
});

// ── hostRemovedFallback (per window) ─────────────────────────────────────────

test("hostRemovedFallback leaves windows on other hosts unchanged", () => {
  assert.deepEqual(hostRemovedFallback(twoHosts(), "host-a", "host-b"), { kind: "unchanged" });
  assert.deepEqual(hostRemovedFallback(twoHosts(), "host-a", null), { kind: "unchanged" });
});

test("hostRemovedFallback routes a window on the removed host to the first remaining", () => {
  const after: HostList = {
    version: 1,
    activeId: "host-b", // removeHost promotes the first remaining entry
    hosts: [{ id: "host-b", name: "buildbox", url: "http://127.0.0.1:3100" }],
  };
  const fallback = hostRemovedFallback(after, "host-a", "host-a");
  assert.equal(fallback.kind, "host");
  if (fallback.kind === "host") assert.equal(fallback.host.id, "host-b");
});

test("hostRemovedFallback routes to welcome when no hosts remain", () => {
  const after: HostList = { version: 1, activeId: null, hosts: [] };
  assert.deepEqual(hostRemovedFallback(after, "host-a", "host-a"), { kind: "welcome" });
});

// ── windowListItems (mac Window-menu list) ───────────────────────────────────

test("windowListItems maps windows to checked-on-focus menu rows in order", () => {
  const items = windowListItems([
    { windowId: 1, title: "studio-mac — rk-dev", focused: false },
    { windowId: 2, title: "HexoKit", focused: true },
  ]);
  assert.deepEqual(items, [
    { windowId: 1, label: "studio-mac — rk-dev", focused: false },
    { windowId: 2, label: "HexoKit", focused: true },
  ]);
});
