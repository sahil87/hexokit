/**
 * node:test suite for the popout-window pure logic (run via `pnpm run test`
 * after compile — the `window-open.test.ts` convention).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  findPopoutWindow,
  parsePopoutPayload,
  POPOUT_FALLBACK_HEIGHT,
  POPOUT_FALLBACK_WIDTH,
  POPOUT_MIN_HEIGHT,
  POPOUT_MIN_WIDTH,
  POPOUT_ROUTE_MAX_LENGTH,
  stripPopParam,
  type PopoutRecord,
} from "./popout";

const HOST = "http://localhost:3000";
const MAX = { width: 1920, height: 1080 };

test("a valid payload parses, with sizes rounded", () => {
  assert.deepEqual(
    parsePopoutPayload({ route: "/rk-dev/@12?pop=web", width: 640.4, height: 480 }, HOST, MAX),
    { route: "/rk-dev/@12?pop=web", width: 640, height: 480 },
  );
});

test("absent sizes fall back to 1200x800", () => {
  assert.deepEqual(parsePopoutPayload({ route: "/rk-dev/@12?pop=tty" }, HOST, MAX), {
    route: "/rk-dev/@12?pop=tty",
    width: POPOUT_FALLBACK_WIDTH,
    height: POPOUT_FALLBACK_HEIGHT,
  });
});

test("invalid-but-optional sizes fall back rather than failing", () => {
  const badValues: unknown[] = [-5, 0, Number.NaN, Number.POSITIVE_INFINITY, "big", null];
  for (const bad of badValues) {
    const parsed = parsePopoutPayload({ route: "/a/b?pop=x", width: bad, height: bad }, HOST, MAX);
    assert.equal(parsed?.width, POPOUT_FALLBACK_WIDTH);
    assert.equal(parsed?.height, POPOUT_FALLBACK_HEIGHT);
  }
});

test("sizes clamp to the min and the display ceiling", () => {
  const parsed = parsePopoutPayload(
    { route: "/a/b?pop=x", width: 10, height: 99_999 },
    HOST,
    MAX,
  );
  assert.equal(parsed?.width, POPOUT_MIN_WIDTH);
  assert.equal(parsed?.height, MAX.height);
  const tiny = parsePopoutPayload(
    { route: "/a/b?pop=x", height: 10 },
    HOST,
    { width: 100, height: 100 },
  );
  // A display smaller than the floor: the floor wins (never below min).
  assert.equal(tiny?.width, POPOUT_FALLBACK_WIDTH);
  assert.equal(tiny?.height, POPOUT_MIN_HEIGHT);
});

test("extra search params survive alongside pop", () => {
  const parsed = parsePopoutPayload({ route: "/a/b?pop=web&x=1" }, HOST, MAX);
  assert.equal(parsed?.route, "/a/b?pop=web&x=1");
});

test("a protocol-relative route is rejected", () => {
  assert.equal(parsePopoutPayload({ route: "//evil.com/a/b?pop=x" }, HOST, MAX), null);
});

test("an absolute URL is rejected", () => {
  assert.equal(parsePopoutPayload({ route: "https://evil.com/a/b?pop=x" }, HOST, MAX), null);
});

test("a route without pop is rejected", () => {
  assert.equal(parsePopoutPayload({ route: "/a/b" }, HOST, MAX), null);
});

test("an empty pop param is rejected", () => {
  assert.equal(parsePopoutPayload({ route: "/a/b?pop=" }, HOST, MAX), null);
});

test("a one-segment route is rejected", () => {
  assert.equal(parsePopoutPayload({ route: "/a?pop=x" }, HOST, MAX), null);
});

test("a three-segment route is rejected", () => {
  assert.equal(parsePopoutPayload({ route: "/a/b/c?pop=x" }, HOST, MAX), null);
});

test("a route with a NUL is rejected", () => {
  const nulRoute = "/a" + String.fromCharCode(0) + "/b?pop=x";
  assert.equal(parsePopoutPayload({ route: nulRoute }, HOST, MAX), null);
});

test("a route with a backslash is rejected (WHATWG folds it into a slash)", () => {
  assert.equal(parsePopoutPayload({ route: "/\\evil.com/b?pop=x" }, HOST, MAX), null);
  assert.equal(parsePopoutPayload({ route: "/a\\b/c?pop=x" }, HOST, MAX), null);
});

test("a route over the length cap is rejected", () => {
  const route = `/a/${"x".repeat(POPOUT_ROUTE_MAX_LENGTH)}?pop=x`;
  assert.equal(parsePopoutPayload({ route }, HOST, MAX), null);
  const atCap = `/a/${"x".repeat(POPOUT_ROUTE_MAX_LENGTH - "/a/".length - "?pop=x".length)}?pop=x`;
  assert.equal(atCap.length, POPOUT_ROUTE_MAX_LENGTH);
  assert.notEqual(parsePopoutPayload({ route: atCap }, HOST, MAX), null);
});

test("a non-string route is rejected", () => {
  assert.equal(parsePopoutPayload({ route: 42 }, HOST, MAX), null);
  assert.equal(parsePopoutPayload({ route: null }, HOST, MAX), null);
  assert.equal(parsePopoutPayload({}, HOST, MAX), null);
});

test("a non-object payload is rejected", () => {
  assert.equal(parsePopoutPayload("/a/b?pop=x", HOST, MAX), null);
  assert.equal(parsePopoutPayload(null, HOST, MAX), null);
  assert.equal(parsePopoutPayload(undefined, HOST, MAX), null);
});

test("empty path segments are rejected (no silent collapse)", () => {
  assert.equal(parsePopoutPayload({ route: "/a//b?pop=x" }, HOST, MAX), null);
  assert.equal(parsePopoutPayload({ route: "/a/b/?pop=x" }, HOST, MAX), null);
});

test("dot segments normalize away and are rejected when they break the shape", () => {
  // /a/../b?pop=x normalizes to /b — one segment, rejected.
  assert.equal(parsePopoutPayload({ route: "/a/../b?pop=x" }, HOST, MAX), null);
});

test("findPopoutWindow matches on (openerWindowId, hostId, route)", () => {
  const registry = new Map<number, PopoutRecord>([
    [7, { openerWindowId: 1, hostId: "e2e-a", route: "/rk-dev/@12?pop=tty" }],
    [9, { openerWindowId: 2, hostId: "e2e-b", route: "/rk-dev/@12?pop=tty" }],
  ]);
  assert.equal(findPopoutWindow(registry, 1, "e2e-a", "/rk-dev/@12?pop=tty"), 7);
  assert.equal(findPopoutWindow(registry, 2, "e2e-b", "/rk-dev/@12?pop=tty"), 9);
  // Same route on another host is no match.
  assert.equal(findPopoutWindow(registry, 1, "e2e-c", "/rk-dev/@12?pop=tty"), null);
  // Same host, different route is no match.
  assert.equal(findPopoutWindow(registry, 1, "e2e-a", "/rk-dev/@12?pop=web"), null);
  assert.equal(findPopoutWindow(new Map(), 1, "e2e-a", "/rk-dev/@12?pop=tty"), null);
});

test("findPopoutWindow: a different opener on the same host+route is a miss", () => {
  const registry = new Map<number, PopoutRecord>([
    [7, { openerWindowId: 1, hostId: "e2e-a", route: "/rk-dev/@12?pop=tty" }],
  ]);
  // The same opener hits; a second opener window gets its own popout.
  assert.equal(findPopoutWindow(registry, 1, "e2e-a", "/rk-dev/@12?pop=tty"), 7);
  assert.equal(findPopoutWindow(registry, 2, "e2e-a", "/rk-dev/@12?pop=tty"), null);
});

test("stripPopParam removes pop and keeps the rest", () => {
  assert.equal(stripPopParam("/rk-dev/@12?pop=tty"), "/rk-dev/@12");
  assert.equal(stripPopParam("/rk-dev/@12?pop=tty&x=1"), "/rk-dev/@12?x=1");
  assert.equal(stripPopParam("/rk-dev/@12?x=1&pop=web"), "/rk-dev/@12?x=1");
  assert.equal(stripPopParam("/rk-dev/@12"), "/rk-dev/@12");
  assert.equal(stripPopParam("/rk-dev/@12?x=1"), "/rk-dev/@12?x=1");
});
