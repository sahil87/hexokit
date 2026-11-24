import { describe, it, expect } from "vitest";
import {
  CONFIRMATION_WINDOW_MS,
  onDeadline,
  onPostSettled,
  onSnapshot,
  overlayTargets,
  startOverlay,
} from "./switch-overlay";

const TOKEN_HELD = { snapshot: "held at settle" };
const TOKEN_NEWER = { snapshot: "newer" };

function settledOk(windowId = "@B", seq = 1) {
  const started = startOverlay("srv", windowId, seq);
  const settled = onPostSettled(
    started,
    seq,
    { kind: "resolved", resp: { ok: true, activeWindow: windowId } },
    TOKEN_HELD,
  );
  if (settled.overlay === null) throw new Error("overlay ended at settle");
  return settled.overlay;
}

describe("startOverlay", () => {
  it("starts pending with the server-scoped identity and seq", () => {
    expect(startOverlay("srv", "@B", 3)).toMatchObject({
      server: "srv",
      windowId: "@B",
      seq: 3,
      post: "pending",
    });
  });

  it("deadline is the 5s confirmation window", () => {
    expect(CONFIRMATION_WINDOW_MS).toBe(5000);
  });
});

describe("onSnapshot — confirm", () => {
  it("ends when a snapshot reports the overlay window active", () => {
    const overlay = startOverlay("srv", "@B", 1);
    const t = onSnapshot(overlay, { server: "srv", activeWindowId: "@B", token: TOKEN_HELD });
    expect(t).toEqual({ overlay: null, ended: "confirm" });
  });

  it("holds while the snapshot still reports the previous window and no POST settled", () => {
    const overlay = startOverlay("srv", "@B", 1);
    const t = onSnapshot(overlay, { server: "srv", activeWindowId: "@A", token: TOKEN_NEWER });
    expect(t).toEqual({ overlay, ended: null });
  });

  it("never confirms on a colliding window id from another server", () => {
    const overlay = startOverlay("srvA", "@5", 1);
    const t = onSnapshot(overlay, { server: "srvB", activeWindowId: "@5", token: TOKEN_NEWER });
    expect(t).toEqual({ overlay, ended: null });
  });

  it("does not end a settled overlay on another server's newer snapshot", () => {
    const overlay = settledOk("@5");
    const t = onSnapshot(overlay, { server: "other", activeWindowId: "@9", token: TOKEN_NEWER });
    expect(t.ended).toBeNull();
  });
});

describe("onPostSettled", () => {
  it("a 200 before the snapshot keeps the overlay and records the held snapshot", () => {
    const overlay = startOverlay("srv", "@B", 1);
    const t = onPostSettled(
      overlay,
      1,
      { kind: "resolved", resp: { ok: true, activeWindow: "@B" } },
      TOKEN_HELD,
    );
    expect(t.ended).toBeNull();
    expect(t.overlay).toMatchObject({ post: "ok", snapshotAtSettle: TOKEN_HELD });
  });

  it("does not bounce on the stale snapshot still held at settle", () => {
    const settled = settledOk("@B");
    const t = onSnapshot(settled, { server: "srv", activeWindowId: "@A", token: TOKEN_HELD });
    expect(t).toEqual({ overlay: settled, ended: null });
  });

  it("a 200 without activeWindow (older daemon) keeps waiting for the snapshot", () => {
    const overlay = startOverlay("srv", "@B", 1);
    const t = onPostSettled(overlay, 1, { kind: "resolved", resp: { ok: true } }, TOKEN_HELD);
    expect(t.ended).toBeNull();
    expect(t.overlay?.post).toBe("ok");
  });

  it("a 200 reporting a different active window ends immediately", () => {
    const overlay = startOverlay("srv", "@B", 1);
    const t = onPostSettled(
      overlay,
      1,
      { kind: "resolved", resp: { ok: true, activeWindow: "@C" } },
      TOKEN_HELD,
    );
    expect(t).toEqual({ overlay: null, ended: "post-mismatch" });
  });

  it("a rejected POST ends as rejected", () => {
    const overlay = startOverlay("srv", "@B", 1);
    expect(onPostSettled(overlay, 1, { kind: "rejected" }, TOKEN_HELD)).toEqual({
      overlay: null,
      ended: "rejected",
    });
  });

  it("a non-2xx result ends as rejected", () => {
    const overlay = startOverlay("srv", "@B", 1);
    expect(
      onPostSettled(overlay, 1, { kind: "resolved", resp: { ok: false } }, TOKEN_HELD),
    ).toEqual({ overlay: null, ended: "rejected" });
  });

  it("a settlement for a superseded seq is a no-op", () => {
    const current = startOverlay("srv", "@C", 2);
    expect(onPostSettled(current, 1, { kind: "rejected" }, TOKEN_HELD)).toEqual({
      overlay: current,
      ended: null,
    });
    expect(
      onPostSettled(
        current,
        1,
        { kind: "resolved", resp: { ok: true, activeWindow: "@B" } },
        TOKEN_HELD,
      ),
    ).toEqual({ overlay: current, ended: null });
  });
});

describe("onSnapshot — post-settle snapshot", () => {
  it("a newer snapshot reporting a third window ends the settled overlay", () => {
    const settled = settledOk("@B");
    const t = onSnapshot(settled, { server: "srv", activeWindowId: "@C", token: TOKEN_NEWER });
    expect(t).toEqual({ overlay: null, ended: "post-settle-snapshot" });
  });

  it("a newer snapshot reporting the overlay window is a confirm, not a post-settle end", () => {
    const settled = settledOk("@B");
    const t = onSnapshot(settled, { server: "srv", activeWindowId: "@B", token: TOKEN_NEWER });
    expect(t.ended).toBe("confirm");
  });

  it("a newer snapshot before the POST settles does not end a pending overlay", () => {
    const overlay = startOverlay("srv", "@B", 1);
    const t = onSnapshot(overlay, { server: "srv", activeWindowId: "@C", token: TOKEN_NEWER });
    expect(t.ended).toBeNull();
  });
});

describe("onDeadline", () => {
  it("ends the live overlay", () => {
    const overlay = startOverlay("srv", "@B", 1);
    expect(onDeadline(overlay, 1)).toEqual({ overlay: null, ended: "deadline" });
  });

  it("ends a settled overlay too", () => {
    expect(onDeadline(settledOk(), 1)).toEqual({ overlay: null, ended: "deadline" });
  });

  it("a superseded seq's deadline is a no-op", () => {
    const current = startOverlay("srv", "@C", 2);
    expect(onDeadline(current, 1)).toEqual({ overlay: current, ended: null });
  });
});

describe("overlayTargets", () => {
  const overlay = startOverlay("srvA", "@5", 1);

  it("matches only the exact {server, windowId} pair", () => {
    expect(overlayTargets(overlay, "srvA", "@5")).toBe(true);
  });

  it("does not match a colliding window id on another server", () => {
    expect(overlayTargets(overlay, "srvB", "@5")).toBe(false);
  });

  it("does not match a different window, no overlay, or no window in the URL", () => {
    expect(overlayTargets(overlay, "srvA", "@6")).toBe(false);
    expect(overlayTargets(null, "srvA", "@5")).toBe(false);
    expect(overlayTargets(overlay, "srvA", undefined)).toBe(false);
  });
});
