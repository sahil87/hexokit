import { describe, it, expect, vi, afterEach } from "vitest";
import { DEFAULT_BINDINGS, resolveBindings, type EffectiveBinding } from "./keybindings";
import {
  windowSwitchDirection,
  shouldAnimateWindowSwitch,
  viewTransitionSupported,
  beginWindowSwitchGate,
  notifyFirstWrite,
  tearDownMask,
  confirmSwitchArrived,
  forceSwitchArrived,
  hasCountedIncomingBytes,
  abandonSwitchFeedback,
  armGraceMask,
  getMaskState,
  subscribeMaskState,
  isMaskExemptKey,
  isRedundantSwitch,
  isSamePendingTarget,
  nextDirectionToken,
  isLatestDirectionToken,
  postConfirmsSwitch,
  resolvePendingSwitchPost,
  resolvePendingSwitchVerdict,
} from "./window-transition";

describe("windowSwitchDirection", () => {
  const order = ["@0", "@1", "@2", "@3"];

  it("returns 'up' when the target sits below the current (higher index)", () => {
    expect(windowSwitchDirection(order, "@1", "@3")).toBe("up");
  });

  it("returns 'down' when the target sits above the current (lower index)", () => {
    expect(windowSwitchDirection(order, "@3", "@1")).toBe("down");
  });

  it("returns null when the current window is missing from the order", () => {
    expect(windowSwitchDirection(order, "@9", "@1")).toBeNull();
  });

  it("returns null when the target window is missing from the order", () => {
    expect(windowSwitchDirection(order, "@1", "@9")).toBeNull();
  });

  it("returns null when current and target are equal", () => {
    expect(windowSwitchDirection(order, "@2", "@2")).toBeNull();
  });

  it("returns null on an empty order", () => {
    expect(windowSwitchDirection([], "@0", "@1")).toBeNull();
  });
});

describe("shouldAnimateWindowSwitch", () => {
  const pass = {
    hasVTSupport: true,
    reducedMotion: false,
    hasOutgoingWindow: true,
    direction: "up" as const,
  };

  it("returns true when all gate conditions hold", () => {
    expect(shouldAnimateWindowSwitch(pass)).toBe(true);
  });

  it("returns false without View Transitions support", () => {
    expect(shouldAnimateWindowSwitch({ ...pass, hasVTSupport: false })).toBe(false);
  });

  it("returns false when reduced motion is set", () => {
    expect(shouldAnimateWindowSwitch({ ...pass, reducedMotion: true })).toBe(false);
  });

  it("returns false when there is no outgoing window", () => {
    expect(shouldAnimateWindowSwitch({ ...pass, hasOutgoingWindow: false })).toBe(false);
  });

  it("returns false when no direction resolved", () => {
    expect(shouldAnimateWindowSwitch({ ...pass, direction: null })).toBe(false);
  });
});

describe("viewTransitionSupported", () => {
  afterEach(() => {
    // Clean up any stub we set on document.
    delete (document as { startViewTransition?: unknown }).startViewTransition;
  });

  it("is false when document.startViewTransition is absent", () => {
    expect(viewTransitionSupported()).toBe(false);
  });

  it("is true when document.startViewTransition is a function", () => {
    (document as { startViewTransition?: unknown }).startViewTransition = () => {};
    expect(viewTransitionSupported()).toBe(true);
  });
});

describe("first-write gate (beginWindowSwitchGate / notifyFirstWrite)", () => {
  // The gate is released at message-RECEIPT time — TerminalClient calls
  // notifyFirstWrite() inside ws.onmessage, before the write/coalesce decision.
  // These tests drive notifyFirstWrite() directly, so they are agnostic to the
  // (former write-time vs. current receipt-time) caller; "write" below is
  // shorthand for "an incoming-byte notify".
  afterEach(() => {
    vi.useRealTimers();
    // Settle any lingering gate (so a leaked resolver can't dangle across
    // tests) and reset the shared mask signal in one authoritative call. The
    // UNCONDITIONAL form — confirmSwitchArrived is byte-gated and would not
    // clean up a byte-less switch.
    forceSwitchArrived();
  });

  it("resolves 'first-write' when a notify arrives after openForNotify, before the timeout", async () => {
    const gate = beginWindowSwitchGate();
    gate.openForNotify();
    const wait = gate.waitForFirstWrite(1000);
    notifyFirstWrite();
    await expect(wait).resolves.toBe("first-write");
  });

  it("resolves 'timeout' when no notify arrives", async () => {
    vi.useFakeTimers();
    const gate = beginWindowSwitchGate();
    gate.openForNotify();
    const wait = gate.waitForFirstWrite(300);
    vi.advanceTimersByTime(300);
    await expect(wait).resolves.toBe("timeout");
  });

  it("ignores notifies that arrive before openForNotify (post-selectWindow gating)", async () => {
    vi.useFakeTimers();
    const gate = beginWindowSwitchGate();
    const wait = gate.waitForFirstWrite(300);
    // A busy OUTGOING window's stray receipt before the POST resolves must NOT
    // release the gate — the gate is not yet accepting notifies.
    notifyFirstWrite();
    let resolved = false;
    void wait.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    // Only after openForNotify does a write count.
    gate.openForNotify();
    notifyFirstWrite();
    await expect(wait).resolves.toBe("first-write");
  });

  it("notifyFirstWrite is a no-op when no gate is open", () => {
    expect(() => notifyFirstWrite()).not.toThrow();
  });

  it("supersession fires the pending gate immediately with 'superseded' (no serialization)", async () => {
    vi.useFakeTimers();
    // First switch: gate opened and awaiting the first write.
    const first = beginWindowSwitchGate();
    first.openForNotify();
    const firstWait = first.waitForFirstWrite(300);
    let firstReason: string | undefined;
    void firstWait.then((r) => {
      firstReason = r;
    });
    // A second switch begins <300ms later. It must FIRE the first gate at once
    // (not wait out the first's 300ms timeout) so a queued VT callback runs.
    beginWindowSwitchGate();
    await Promise.resolve();
    expect(firstReason).toBe("superseded");
    // Crucially, no timers needed to advance — the resolution was synchronous.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a superseded gate's stale timer cannot clobber a newer gate's wait", async () => {
    vi.useFakeTimers();
    // First gate armed with a short timeout.
    const first = beginWindowSwitchGate();
    first.openForNotify();
    void first.waitForFirstWrite(100);
    // Second gate supersedes (fires + clears the first's timer) with a longer
    // timeout still pending.
    const second = beginWindowSwitchGate();
    second.openForNotify();
    const secondWait = second.waitForFirstWrite(300);
    let secondResolved = false;
    void secondWait.then(() => {
      secondResolved = true;
    });
    // Advancing past the FIRST gate's timeout must not resolve the second.
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    expect(secondResolved).toBe(false);
    // The second gate resolves on its own timeout.
    vi.advanceTimersByTime(200);
    await expect(secondWait).resolves.toBe("timeout");
  });

  it("waitForFirstWrite on an already-superseded gate resolves 'superseded' immediately", async () => {
    vi.useFakeTimers();
    const first = beginWindowSwitchGate();
    first.openForNotify();
    // Supersede before the first ever awaited.
    beginWindowSwitchGate();
    // The stale gate's wait must not hang — it resolves at once.
    const staleWait = first.waitForFirstWrite(300);
    await expect(staleWait).resolves.toBe("superseded");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a stray notify after settle does not resolve a fresh gate early", async () => {
    vi.useFakeTimers();
    const first = beginWindowSwitchGate();
    first.openForNotify();
    const firstWait = first.waitForFirstWrite(100);
    vi.advanceTimersByTime(100); // first settles via timeout, clears the slot
    await firstWait;
    // A stray write now (no gate open) is a harmless no-op.
    notifyFirstWrite();
    // A fresh gate is unaffected: it waits for ITS own write/timeout.
    const second = beginWindowSwitchGate();
    second.openForNotify();
    const secondWait = second.waitForFirstWrite(100);
    notifyFirstWrite(); // this SHOULD resolve `second` — the fresh open gate
    await expect(secondWait).resolves.toBe("first-write");
  });

  it("resolves within its budget when the chained POST never settles (stalled selectWindow)", async () => {
    // Regression for the bounded-callback must-fix: the wrapper CHAINS
    // openForNotify off the selectWindow POST and awaits only the gate wait, so
    // the budget clock starts at the wait — NOT after the POST. A POST that
    // never settles (stalled `selectWindow`, no client fetch timeout) must not
    // extend the wait past its budget.
    vi.useFakeTimers();
    const gate = beginWindowSwitchGate();
    // A promise that never resolves models the stalled POST; openForNotify is
    // chained off it and therefore never runs.
    const stalledPost = new Promise<void>(() => {});
    void stalledPost.then(() => gate.openForNotify());
    const wait = gate.waitForFirstWrite(300);
    // The whole budget elapses with the POST still pending.
    vi.advanceTimersByTime(300);
    await expect(wait).resolves.toBe("timeout");
  });

  it("openForNotify chained via .then still ignores notifies before the POST resolves", async () => {
    // Models the wrapper's real shape: openForNotify runs only inside the POST's
    // .then, so a receipt before the POST resolves must be ignored, and only a
    // receipt after the .then has run releases the gate.
    vi.useFakeTimers();
    const gate = beginWindowSwitchGate();
    const wait = gate.waitForFirstWrite(300);
    let posted!: () => void;
    const post = new Promise<void>((r) => {
      posted = r;
    });
    void post.then(() => gate.openForNotify());
    // Outgoing window's stray receipt before the POST resolves: ignored.
    notifyFirstWrite();
    let resolved = false;
    void wait.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    // POST resolves → the chained openForNotify runs on the microtask.
    posted();
    await Promise.resolve();
    // Now an incoming byte's receipt counts and releases the gate.
    notifyFirstWrite();
    await expect(wait).resolves.toBe("first-write");
  });
});

describe("pending-switch mask signal (260715-38kg)", () => {
  afterEach(() => {
    vi.useRealTimers();
    // Settle any lingering gate + reset the shared mask state between tests
    // (unconditional — the byte-gated confirmSwitchArrived cannot do this).
    forceSwitchArrived();
  });

  it("starts idle", () => {
    expect(getMaskState()).toBe("idle");
  });

  it("arms on a gated switch's timeout settle", async () => {
    vi.useFakeTimers();
    const gate = beginWindowSwitchGate({ gated: true });
    gate.openForNotify();
    const wait = gate.waitForFirstWrite(300);
    vi.advanceTimersByTime(300);
    await wait;
    expect(getMaskState()).toBe("masked");
  });

  it("does NOT arm on a NON-gated (web/code) switch's timeout", async () => {
    vi.useFakeTimers();
    const gate = beginWindowSwitchGate({ gated: false });
    gate.openForNotify();
    const wait = gate.waitForFirstWrite(300);
    vi.advanceTimersByTime(300);
    await wait;
    expect(getMaskState()).toBe("idle");
  });

  it("does NOT arm on a fast first-write settle", async () => {
    const gate = beginWindowSwitchGate({ gated: true });
    gate.openForNotify();
    const wait = gate.waitForFirstWrite(1000);
    notifyFirstWrite();
    await wait;
    expect(getMaskState()).toBe("idle");
  });

  it("lifts on the incoming window's LATE first write (one signal drives everything)", async () => {
    vi.useFakeTimers();
    const gate = beginWindowSwitchGate({ gated: true });
    // openForNotify models the selectWindow POST having resolved — which also
    // opens the (filtered) mask lift for this switch (rework F3).
    gate.openForNotify();
    const wait = gate.waitForFirstWrite(300);
    vi.advanceTimersByTime(300);
    await wait;
    expect(getMaskState()).toBe("masked");
    // The SAME notifyFirstWrite receipt that would have released the gate lifts
    // the mask when the incoming bytes arrive late.
    notifyFirstWrite();
    expect(getMaskState()).toBe("idle");
  });

  it("does NOT lift on OUTGOING-window bytes — the lift is filtered on the POST having resolved (rework F3)", async () => {
    // The busy-old-window hazard: on a same-session switch the OUTGOING window's
    // still-streaming bytes ride the same socket. Until the switch's
    // selectWindow POST resolves (openForNotify), a receipt must NOT lift the
    // mask — it would un-mask stale content, exactly what the mask exists to
    // hide.
    vi.useFakeTimers();
    const gate = beginWindowSwitchGate({ gated: true });
    // POST unresolved: openForNotify NOT called.
    const wait = gate.waitForFirstWrite(300);
    vi.advanceTimersByTime(300);
    await wait; // times out (bytes were never countable) → masked
    expect(getMaskState()).toBe("masked");
    // Outgoing bytes keep streaming: they must not lift the mask.
    notifyFirstWrite();
    expect(getMaskState()).toBe("masked");
    // The POST finally resolves (late, on the already-settled gate) — from now
    // on a receipt IS the incoming window's first countable byte, and lifts.
    gate.openForNotify();
    notifyFirstWrite();
    expect(getMaskState()).toBe("idle");
  });

  it("a STALE switch's late POST resolution cannot enable lifts for a newer switch's mask", async () => {
    vi.useFakeTimers();
    // First switch: gate pending, POST never resolves in time.
    const first = beginWindowSwitchGate({ gated: true });
    void first.waitForFirstWrite(300);
    // A newer switch supersedes and times out → ITS mask arms.
    const second = beginWindowSwitchGate({ gated: true });
    const secondWait = second.waitForFirstWrite(300);
    vi.advanceTimersByTime(300);
    await secondWait;
    expect(getMaskState()).toBe("masked");
    // The FIRST (stale) switch's POST now resolves. Its openForNotify must NOT
    // open the lift for the second switch's mask (epoch guard).
    first.openForNotify();
    notifyFirstWrite();
    expect(getMaskState()).toBe("masked");
    // The second switch's own POST resolving does open the lift.
    second.openForNotify();
    notifyFirstWrite();
    expect(getMaskState()).toBe("idle");
  });

  it("tears down on supersession — a superseded switch owns no mask", async () => {
    vi.useFakeTimers();
    const first = beginWindowSwitchGate({ gated: true });
    first.openForNotify();
    const firstWait = first.waitForFirstWrite(300);
    vi.advanceTimersByTime(300);
    await firstWait; // first times out → masked
    expect(getMaskState()).toBe("masked");
    // A newer switch supersedes: the mask tears down (the newer gate owns
    // feedback). It has not itself timed out yet, so state returns to idle.
    beginWindowSwitchGate({ gated: true });
    expect(getMaskState()).toBe("idle");
  });

  it("a stale (superseded) gate's late timeout cannot arm a mask for the newer gate", async () => {
    vi.useFakeTimers();
    const first = beginWindowSwitchGate({ gated: true });
    first.openForNotify();
    void first.waitForFirstWrite(100);
    // Newer gate supersedes with a longer timeout still pending.
    const second = beginWindowSwitchGate({ gated: true });
    second.openForNotify();
    void second.waitForFirstWrite(300);
    // Advancing past the FIRST gate's timeout must not arm a mask.
    vi.advanceTimersByTime(100);
    expect(getMaskState()).toBe("idle");
    // The second gate's own timeout arms it.
    vi.advanceTimersByTime(200);
    expect(getMaskState()).toBe("masked");
  });

  it("tearDownMask clears an armed mask (failure/bounce path)", async () => {
    vi.useFakeTimers();
    const gate = beginWindowSwitchGate({ gated: true });
    gate.openForNotify();
    const wait = gate.waitForFirstWrite(300);
    vi.advanceTimersByTime(300);
    await wait;
    expect(getMaskState()).toBe("masked");
    tearDownMask();
    expect(getMaskState()).toBe("idle");
  });

  it("tearDownMask from the masked state is idempotent (fresh-switch teardown — 260719-h0x4)", async () => {
    // beginPendingSwitch calls the bare tearDownMask() at every fresh switch
    // start to clear a leftover mask a prior timed-out switch left showing. It
    // must clear a masked state AND be a harmless no-op on a second bare call
    // (the gated paths reach it after already tearing down).
    vi.useFakeTimers();
    const gate = beginWindowSwitchGate({ gated: true });
    gate.openForNotify();
    const wait = gate.waitForFirstWrite(300);
    vi.advanceTimersByTime(300);
    await wait; // times out → masked
    expect(getMaskState()).toBe("masked");
    tearDownMask(); // masked → idle
    expect(getMaskState()).toBe("idle");
    tearDownMask(); // idle → idle: harmless no-op
    expect(getMaskState()).toBe("idle");
  });

  it("bare tearDownMask does NOT settle a still-pending gate (260719-h0x4 R2)", async () => {
    // The animated path reaches beginPendingSwitch's fresh-switch tearDownMask
    // while its OWN just-opened gate is current. The bare teardown must leave
    // that gate pending so its first-write settle still plays the earned slide
    // — the contrast with abandonSwitchFeedback (which settles "superseded").
    // If tearDownMask ever grew gate-settling, every animated switch would
    // silently lose its slide.
    vi.useFakeTimers();
    const gate = beginWindowSwitchGate({ gated: true });
    gate.openForNotify();
    const wait = gate.waitForFirstWrite(300);
    tearDownMask(); // the fresh-switch teardown, gate still pending
    notifyFirstWrite();
    await expect(wait).resolves.toBe("first-write");
    expect(getMaskState()).toBe("idle");
  });

  it("confirmSwitchArrived before any counted byte is a no-op: the gate times out, the mask arms, a later byte lifts it", async () => {
    // Byte-gated SSE confirmation: SSE reports the target active as soon as
    // `select-window` lands — before any byte of the new window exists — so the
    // confirmation must NOT settle the gate or lift the mask. The gate's 300ms
    // timeout arms the mask and the late first write lifts it.
    vi.useFakeTimers();
    const gate = beginWindowSwitchGate({ gated: true });
    gate.openForNotify();
    const wait = gate.waitForFirstWrite(300);
    // SSE confirms BEFORE the timeout and before any byte: no-op.
    vi.advanceTimersByTime(150);
    confirmSwitchArrived();
    let settled: string | undefined;
    void wait.then((r) => {
      settled = r;
    });
    await Promise.resolve();
    expect(settled).toBeUndefined();
    // The gate rides out its timeout and the mask arms.
    vi.advanceTimersByTime(150);
    await expect(wait).resolves.toBe("timeout");
    expect(getMaskState()).toBe("masked");
    // The incoming window's late first write lifts the mask (the designed cut).
    notifyFirstWrite();
    expect(getMaskState()).toBe("idle");
    expect(hasCountedIncomingBytes()).toBe(true);
  });

  it("confirmSwitchArrived after a counted byte settles/tears down (gate already first-write, no mask)", async () => {
    // The counted byte IS the settle: once a byte counted, the gate resolved
    // "first-write" and no mask can be armed — the confirmation only tears down
    // any leftover mask/grace state.
    vi.useFakeTimers();
    const gate = beginWindowSwitchGate({ gated: true });
    gate.openForNotify();
    const wait = gate.waitForFirstWrite(300);
    notifyFirstWrite();
    await expect(wait).resolves.toBe("first-write");
    expect(hasCountedIncomingBytes()).toBe(true);
    confirmSwitchArrived();
    vi.advanceTimersByTime(300);
    expect(getMaskState()).toBe("idle");
  });

  it("confirmSwitchArrived does NOT lift an armed mask while no byte has been counted", async () => {
    vi.useFakeTimers();
    const gate = beginWindowSwitchGate({ gated: true });
    gate.openForNotify();
    const wait = gate.waitForFirstWrite(300);
    vi.advanceTimersByTime(300);
    await wait; // times out → masked
    expect(getMaskState()).toBe("masked");
    // SSE confirms with the mask up but no byte counted: the mask stays.
    confirmSwitchArrived();
    expect(getMaskState()).toBe("masked");
    // The byte-driven lift still works.
    notifyFirstWrite();
    expect(getMaskState()).toBe("idle");
  });

  it("forceSwitchArrived settles a still-pending gate as first-write regardless of bytes (the 5s rescue)", async () => {
    // The confirmation-timer rescue is unconditional: after the confirmation
    // window elapses with the target active, a mask with no lift path must
    // never stay up.
    vi.useFakeTimers();
    const gate = beginWindowSwitchGate({ gated: true });
    gate.openForNotify();
    const wait = gate.waitForFirstWrite(300);
    vi.advanceTimersByTime(150);
    expect(hasCountedIncomingBytes()).toBe(false);
    forceSwitchArrived();
    await expect(wait).resolves.toBe("first-write");
    vi.advanceTimersByTime(300);
    expect(getMaskState()).toBe("idle");
  });

  it("forceSwitchArrived tears down an armed mask with no counted byte", async () => {
    vi.useFakeTimers();
    const gate = beginWindowSwitchGate({ gated: true });
    gate.openForNotify();
    const wait = gate.waitForFirstWrite(300);
    vi.advanceTimersByTime(300);
    await wait;
    expect(getMaskState()).toBe("masked");
    forceSwitchArrived();
    expect(getMaskState()).toBe("idle");
  });

  it("notifies subscribers only on an actual change, and stops after unsubscribe", async () => {
    vi.useFakeTimers();
    let count = 0;
    const unsubscribe = subscribeMaskState(() => {
      count += 1;
    });
    const gate = beginWindowSwitchGate({ gated: true });
    gate.openForNotify();
    const wait = gate.waitForFirstWrite(300);
    vi.advanceTimersByTime(300);
    await wait; // idle → masked: one notification
    expect(count).toBe(1);
    tearDownMask(); // masked → idle: second notification
    expect(count).toBe(2);
    tearDownMask(); // idle → idle: a no-op transition must NOT notify
    expect(count).toBe(2);
    unsubscribe();
    // After unsubscribe, further changes are not delivered to this listener.
    const gate2 = beginWindowSwitchGate({ gated: true });
    gate2.openForNotify();
    const wait2 = gate2.waitForFirstWrite(300);
    vi.advanceTimersByTime(300);
    await wait2;
    expect(count).toBe(2);
  });
});

describe("non-VT / reduced-motion grace mask (260715-38kg, R3)", () => {
  afterEach(() => {
    vi.useRealTimers();
    forceSwitchArrived();
  });

  it("arms the mask after the threshold when no countable write arrives", () => {
    vi.useFakeTimers();
    armGraceMask(300);
    expect(getMaskState()).toBe("idle");
    vi.advanceTimersByTime(300);
    expect(getMaskState()).toBe("masked");
  });

  it("an EARLY write (post-POST) cancels the grace timer — never masks at all", () => {
    vi.useFakeTimers();
    const grace = armGraceMask(300);
    // The switch's selectWindow POST resolves, then incoming bytes arrive
    // before the threshold.
    grace.openForLift();
    vi.advanceTimersByTime(100);
    notifyFirstWrite();
    // Advancing past the original threshold must NOT mask — the timer was cancelled.
    vi.advanceTimersByTime(300);
    expect(getMaskState()).toBe("idle");
  });

  it("a LATE write (post-POST) lifts the grace mask", () => {
    vi.useFakeTimers();
    const grace = armGraceMask(300);
    grace.openForLift();
    vi.advanceTimersByTime(300);
    expect(getMaskState()).toBe("masked");
    notifyFirstWrite();
    expect(getMaskState()).toBe("idle");
  });

  it("OUTGOING bytes (POST unresolved) neither cancel the grace timer nor lift the mask (rework F3)", () => {
    vi.useFakeTimers();
    const grace = armGraceMask(300);
    // Outgoing-window bytes stream in before the POST resolves: they must not
    // cancel the grace timer (that would suppress a deserved mask)...
    notifyFirstWrite();
    vi.advanceTimersByTime(300);
    expect(getMaskState()).toBe("masked");
    // ...nor lift the armed mask.
    notifyFirstWrite();
    expect(getMaskState()).toBe("masked");
    // Once the POST resolves, the next receipt is countable and lifts.
    grace.openForLift();
    notifyFirstWrite();
    expect(getMaskState()).toBe("idle");
  });

  it("a STALE grace handle's late openForLift cannot enable lifts for a newer switch", () => {
    vi.useFakeTimers();
    const first = armGraceMask(300);
    // A newer instant switch supersedes; its grace timer arms the mask.
    armGraceMask(300);
    vi.advanceTimersByTime(300);
    expect(getMaskState()).toBe("masked");
    // The stale switch's POST resolves late — must not open the newer mask's lift.
    first.openForLift();
    notifyFirstWrite();
    expect(getMaskState()).toBe("masked");
  });

  it("the handle's cancel disarms a pending grace timer", () => {
    vi.useFakeTimers();
    const grace = armGraceMask(300);
    grace.cancel();
    vi.advanceTimersByTime(300);
    expect(getMaskState()).toBe("idle");
  });

  it("a re-arm supersedes the prior grace timer (one signal at a time)", () => {
    vi.useFakeTimers();
    armGraceMask(300);
    vi.advanceTimersByTime(200);
    // Re-arm: the first timer is cleared; only the second (fresh 300ms) counts.
    armGraceMask(300);
    vi.advanceTimersByTime(200); // 400ms since first arm, 200ms since second
    expect(getMaskState()).toBe("idle"); // second timer hasn't fired yet
    vi.advanceTimersByTime(100);
    expect(getMaskState()).toBe("masked");
  });

  it("arming the grace mask supersedes a still-pending gate (animated→instant rapid sequence)", async () => {
    vi.useFakeTimers();
    // An animated switch's gate is pending...
    const gate = beginWindowSwitchGate({ gated: true });
    const gateWait = gate.waitForFirstWrite(300);
    // ...when an instant switch begins. The gate must settle "superseded" (its
    // VT callback unblocks) and its stale timeout must never mask the newer
    // switch.
    armGraceMask(300);
    await expect(gateWait).resolves.toBe("superseded");
    vi.advanceTimersByTime(300);
    // The mask now showing belongs to the GRACE switch's own timeout, and the
    // stale gate's cleared timer contributed nothing.
    expect(getMaskState()).toBe("masked");
  });

  it("tearDownMask cancels a pending grace timer (failure/bounce before threshold)", () => {
    vi.useFakeTimers();
    armGraceMask(300);
    tearDownMask();
    vi.advanceTimersByTime(300);
    expect(getMaskState()).toBe("idle");
  });
});

describe("in-flight receipt — redraw bytes racing the select POST's resolution (CI 260716)", () => {
  // The CI interleaving (window-switch-transition.spec.ts, PR #372): on a
  // same-session switch the relay socket is SHARED ((server, session)-keyed —
  // no reconnect), and tmux executes select-window + redraws the attached
  // client BEFORE the POST's HTTP response resolves in the browser. The
  // one-and-only redraw receipt can land inside the [POST-sent, POST-resolved)
  // window while the acceptance filters are still closed. Dropping it is a
  // permanent loss: tmux is idle after the redraw, no further receipt ever
  // comes, the gate times out into a mask whose receipt-time lift path is dead.
  // The fix records the in-flight receipt (epoch-tagged) and counts it at the
  // POST's successful resolution — the 200 proves tmux switched, which is
  // exactly the fact the filter was waiting to establish.
  afterEach(() => {
    vi.useRealTimers();
    forceSwitchArrived();
  });

  it("a receipt DURING the POST's flight releases the gate at resolution (no mask ever)", async () => {
    vi.useFakeTimers();
    const gate = beginWindowSwitchGate({ gated: true });
    const wait = gate.waitForFirstWrite(300);
    // Redraw bytes arrive while the POST is still in flight…
    notifyFirstWrite();
    // …then the POST resolves (the wrapper's chained openForNotify runs).
    gate.openForNotify();
    await expect(wait).resolves.toBe("first-write");
    // No mask now, and none later — the settle cancelled the timeout.
    vi.advanceTimersByTime(300);
    expect(getMaskState()).toBe("idle");
  });

  it("a receipt during flight lifts an already-armed mask when the POST resolves late", async () => {
    vi.useFakeTimers();
    const gate = beginWindowSwitchGate({ gated: true });
    const wait = gate.waitForFirstWrite(300);
    notifyFirstWrite(); // in-flight receipt (recorded)
    vi.advanceTimersByTime(300); // POST still unresolved → gate times out → mask
    await wait;
    expect(getMaskState()).toBe("masked");
    gate.openForNotify(); // POST finally resolves — the recorded receipt counts
    expect(getMaskState()).toBe("idle");
  });

  it("grace path: an in-flight receipt cancels the grace timer at openForLift (never masks)", () => {
    vi.useFakeTimers();
    const grace = armGraceMask(300);
    notifyFirstWrite(); // in-flight receipt
    grace.openForLift(); // POST resolves before the threshold
    vi.advanceTimersByTime(300);
    expect(getMaskState()).toBe("idle");
  });

  it("grace path: an in-flight receipt lifts an armed grace mask at a late openForLift", () => {
    vi.useFakeTimers();
    const grace = armGraceMask(300);
    notifyFirstWrite(); // in-flight receipt
    vi.advanceTimersByTime(300); // POST still unresolved → masked
    expect(getMaskState()).toBe("masked");
    grace.openForLift();
    expect(getMaskState()).toBe("idle");
  });

  it("bytes received BEFORE the switch started do not count at resolution", async () => {
    vi.useFakeTimers();
    notifyFirstWrite(); // idle receipt — no switch of ours in flight
    const gate = beginWindowSwitchGate({ gated: true });
    const wait = gate.waitForFirstWrite(300);
    gate.openForNotify(); // POST resolves; the stale pre-switch record must not settle
    let settled = false;
    void wait.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(300);
    await expect(wait).resolves.toBe("timeout");
  });

  it("a STALE switch's in-flight receipt cannot satisfy a newer switch", async () => {
    vi.useFakeTimers();
    const first = beginWindowSwitchGate({ gated: true });
    void first.waitForFirstWrite(300);
    notifyFirstWrite(); // recorded for the FIRST switch's epoch
    // A newer switch supersedes before the first's POST resolved.
    const second = beginWindowSwitchGate({ gated: true });
    const secondWait = second.waitForFirstWrite(300);
    // The FIRST switch's POST now resolves — its recorded receipt must not
    // settle the second gate or lift the second switch's (future) mask.
    first.openForNotify();
    let settled = false;
    void secondWait.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(300);
    await expect(secondWait).resolves.toBe("timeout");
    expect(getMaskState()).toBe("masked"); // the second switch's own honest timeout
  });
});

describe("incoming-byte counting (hasCountedIncomingBytes)", () => {
  afterEach(() => {
    vi.useRealTimers();
    forceSwitchArrived();
  });

  it("starts false and is cleared when a new switch mints its epoch", async () => {
    const first = beginWindowSwitchGate({ gated: true });
    first.openForNotify();
    const wait = first.waitForFirstWrite(300);
    notifyFirstWrite();
    await wait;
    expect(hasCountedIncomingBytes()).toBe(true);
    // A fresh gate mints a new epoch — the flag re-arms for THAT switch.
    beginWindowSwitchGate({ gated: true });
    expect(hasCountedIncomingBytes()).toBe(false);
    // Same for the grace-mask (instant path) epoch mint.
    const grace = armGraceMask(300);
    grace.openForLift();
    notifyFirstWrite();
    expect(hasCountedIncomingBytes()).toBe(true);
    armGraceMask(300);
    expect(hasCountedIncomingBytes()).toBe(false);
  });

  it("counts on the acceptingNotify gate release (first-write settle)", async () => {
    const gate = beginWindowSwitchGate({ gated: true });
    gate.openForNotify();
    expect(hasCountedIncomingBytes()).toBe(false);
    const wait = gate.waitForFirstWrite(300);
    notifyFirstWrite();
    await expect(wait).resolves.toBe("first-write");
    expect(hasCountedIncomingBytes()).toBe(true);
  });

  it("counts on the liftAccepting mask lift (late byte after a timeout)", async () => {
    vi.useFakeTimers();
    const gate = beginWindowSwitchGate({ gated: true });
    gate.openForNotify();
    const wait = gate.waitForFirstWrite(300);
    vi.advanceTimersByTime(300);
    await wait;
    expect(getMaskState()).toBe("masked");
    expect(hasCountedIncomingBytes()).toBe(false);
    notifyFirstWrite();
    expect(getMaskState()).toBe("idle");
    expect(hasCountedIncomingBytes()).toBe(true);
  });

  it("counts an in-flight receipt at openForNotify (gate path)", async () => {
    const gate = beginWindowSwitchGate({ gated: true });
    const wait = gate.waitForFirstWrite(300);
    notifyFirstWrite(); // recorded while the POST is in flight — not yet counted
    expect(hasCountedIncomingBytes()).toBe(false);
    gate.openForNotify(); // the POST's resolution counts the recorded receipt
    await expect(wait).resolves.toBe("first-write");
    expect(hasCountedIncomingBytes()).toBe(true);
  });

  it("counts an in-flight receipt at openForLift (grace path)", () => {
    vi.useFakeTimers();
    const grace = armGraceMask(300);
    notifyFirstWrite(); // in-flight receipt
    expect(hasCountedIncomingBytes()).toBe(false);
    grace.openForLift();
    expect(hasCountedIncomingBytes()).toBe(true);
    vi.advanceTimersByTime(300);
    expect(getMaskState()).toBe("idle");
  });

  it("does NOT count outgoing-window bytes that arrive before the POST resolves", () => {
    vi.useFakeTimers();
    const gate = beginWindowSwitchGate({ gated: true });
    void gate.waitForFirstWrite(300);
    notifyFirstWrite(); // outgoing straggler — filtered, merely recorded
    expect(hasCountedIncomingBytes()).toBe(false);
  });
});

describe("isMaskExemptKey (rework F2 — global chords survive the masked swallow)", () => {
  // The hand-listed rules are checked against an EMPTY registry so they stand
  // on their own; the registry-derived exemption has its own case below.
  const NO_BINDINGS: EffectiveBinding[] = [];
  const key = (
    k: string,
    mods: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean } = {},
    code = "",
  ) => ({
    key: k,
    code,
    metaKey: mods.metaKey ?? false,
    ctrlKey: mods.ctrlKey ?? false,
    altKey: mods.altKey ?? false,
    shiftKey: mods.shiftKey ?? false,
  });

  it("exempts Escape (palette/dialog dismiss)", () => {
    expect(isMaskExemptKey(key("Escape"), NO_BINDINGS, "other")).toBe(true);
  });

  it("exempts Cmd (meta) chords — never terminal input", () => {
    expect(isMaskExemptKey(key("k", { metaKey: true }), NO_BINDINGS, "other")).toBe(true);
    expect(isMaskExemptKey(key(".", { metaKey: true }), NO_BINDINGS, "other")).toBe(true);
    expect(isMaskExemptKey(key("\\", { metaKey: true }), NO_BINDINGS, "other")).toBe(true);
    // Even an unbound meta chord is exempt: xterm never forwards it to the pty.
    expect(isMaskExemptKey(key("x", { metaKey: true }), NO_BINDINGS, "other")).toBe(true);
  });

  it("does NOT exempt Cmd+V — the default paste lands in the old pty (rework SF6)", () => {
    expect(isMaskExemptKey(key("v", { metaKey: true }), NO_BINDINGS, "other")).toBe(false);
    expect(isMaskExemptKey(key("V", { metaKey: true }), NO_BINDINGS, "other")).toBe(false);
  });

  it("exempts the Ctrl-bound global chords: Ctrl+K, Shift+Ctrl+B", () => {
    expect(isMaskExemptKey(key("k", { ctrlKey: true }), NO_BINDINGS, "other")).toBe(true);
    expect(isMaskExemptKey(key("B", { ctrlKey: true, shiftKey: true }), NO_BINDINGS, "other")).toBe(true);
    // Ctrl+. is no shipped binding (the lens cycle is retired and `Period` is
    // deliberately unbound), so it is pty-bound input and stays swallowed.
    expect(isMaskExemptKey(key(".", { ctrlKey: true }), NO_BINDINGS, "other")).toBe(false);
    // Plain Ctrl+B is pty input (readline back-char) — shift is what marks
    // the sidebar chord; Ctrl+\ is no longer any shipped binding.
    expect(isMaskExemptKey(key("b", { ctrlKey: true }), NO_BINDINGS, "other")).toBe(false);
    expect(isMaskExemptKey(key("\\", { ctrlKey: true }), NO_BINDINGS, "other")).toBe(false);
    // Ctrl+` (mac focus-hop) stays swallowed during a transition: on
    // Win/Linux plain Ctrl+` is pty input, and a mid-transition focus hop
    // can simply be retried once the mask drops.
    expect(isMaskExemptKey(key("`", { ctrlKey: true }), NO_BINDINGS, "other")).toBe(false);
  });

  it("does NOT exempt AltGr combos — ctrlKey+altKey is typed input, not a chord (rework NTH9)", () => {
    expect(isMaskExemptKey(key("k", { ctrlKey: true, altKey: true }), NO_BINDINGS, "other")).toBe(false);
    expect(isMaskExemptKey(key("\\", { ctrlKey: true, altKey: true }), NO_BINDINGS, "other")).toBe(false);
  });

  it("swallows plain typing", () => {
    expect(isMaskExemptKey(key("a"), NO_BINDINGS, "other")).toBe(false);
    expect(isMaskExemptKey(key("Enter"), NO_BINDINGS, "other")).toBe(false);
  });

  it("swallows terminal control bytes — Ctrl+C stays blocked (the old-window hazard)", () => {
    expect(isMaskExemptKey(key("c", { ctrlKey: true }), NO_BINDINGS, "other")).toBe(false);
    expect(isMaskExemptKey(key("d", { ctrlKey: true }), NO_BINDINGS, "other")).toBe(false);
    // Ctrl+V (paste on Windows/Linux) is not in the exempt set either.
    expect(isMaskExemptKey(key("v", { ctrlKey: true }), NO_BINDINGS, "other")).toBe(false);
  });

  it("exempts every registry chord the terminal refuses — the shifted-tier nav chords survive the mask", () => {
    const bindings = resolveBindings(DEFAULT_BINDINGS, {}, { platform: "other", shell: false });
    const shifted = (k: string, code: string) => key(k, { ctrlKey: true, shiftKey: true }, code);
    expect(isMaskExemptKey(shifted("ArrowDown", "ArrowDown"), bindings, "other")).toBe(true);
    expect(isMaskExemptKey(shifted("ArrowUp", "ArrowUp"), bindings, "other")).toBe(true);
    expect(isMaskExemptKey(shifted("ArrowRight", "ArrowRight"), bindings, "other")).toBe(true);
    // The same chord with no registry binding is pty-bound input → swallowed.
    expect(isMaskExemptKey(shifted("ArrowDown", "ArrowDown"), NO_BINDINGS, "other")).toBe(false);
    // Plain Ctrl+C is never refused by the terminal, registry or not.
    expect(isMaskExemptKey(key("c", { ctrlKey: true }, "KeyC"), bindings, "other")).toBe(false);
  });
});

describe("abandonSwitchFeedback (rework G2 — bounce/teardown can never be re-masked)", () => {
  afterEach(() => {
    vi.useRealTimers();
    forceSwitchArrived();
  });

  it("settles a still-pending gate as 'superseded' so its timer can never re-mask", async () => {
    // The fast-rejection bounce: a selectWindow rejection INSIDE the 300ms
    // budget bounces while the gate is still pending. A bare tearDownMask would
    // let the gate's timer fire moments later and arm a mask with NO lift path
    // (liftAccepting stays false after a rejected POST) — permanently stuck.
    vi.useFakeTimers();
    const gate = beginWindowSwitchGate({ gated: true });
    const wait = gate.waitForFirstWrite(300);
    // The bounce fires at t=50ms, well inside the budget.
    vi.advanceTimersByTime(50);
    abandonSwitchFeedback();
    await expect(wait).resolves.toBe("superseded");
    // Advancing past the original timeout must NOT arm a mask — the gate was
    // settled, not just unmasked.
    vi.advanceTimersByTime(300);
    expect(getMaskState()).toBe("idle");
  });

  it("clears a mask already armed by a gate timeout", async () => {
    vi.useFakeTimers();
    const gate = beginWindowSwitchGate({ gated: true });
    const wait = gate.waitForFirstWrite(300);
    vi.advanceTimersByTime(300);
    await wait;
    expect(getMaskState()).toBe("masked");
    abandonSwitchFeedback();
    expect(getMaskState()).toBe("idle");
  });

  it("cancels a pending grace timer (route-leave inside the 300ms window)", () => {
    vi.useFakeTimers();
    armGraceMask(300);
    abandonSwitchFeedback();
    vi.advanceTimersByTime(300);
    expect(getMaskState()).toBe("idle");
  });

  it("is an idempotent no-op when nothing is pending or showing", () => {
    expect(() => {
      abandonSwitchFeedback();
      abandonSwitchFeedback();
    }).not.toThrow();
    expect(getMaskState()).toBe("idle");
  });
});

describe("isRedundantSwitch (rework G3 — same-window click arms nothing)", () => {
  it("is redundant when the target is BOTH the URL window and tmux-active", () => {
    expect(isRedundantSwitch("@2", "@2", "@2")).toBe(true);
  });

  it("is NOT redundant when tmux's active window differs (re-anchoring click)", () => {
    expect(isRedundantSwitch("@2", "@2", "@1")).toBe(false);
  });

  it("is NOT redundant when the URL shows a different window", () => {
    expect(isRedundantSwitch("@2", "@1", "@2")).toBe(false);
  });

  it("is NOT redundant with no URL window in view (SessionTiles click)", () => {
    expect(isRedundantSwitch("@2", undefined, "@2")).toBe(false);
  });

  it("is NOT redundant with no SSE snapshot yet", () => {
    expect(isRedundantSwitch("@2", "@2", undefined)).toBe(false);
  });
});

describe("isSamePendingTarget (rework H1 — server-scoped pending-switch identity)", () => {
  const pending = { server: "serverA", windowId: "@5" };

  it("matches only the exact {server, windowId} pair", () => {
    expect(isSamePendingTarget(pending, "serverA", "@5")).toBe(true);
  });

  it("does NOT match a colliding window id on a DIFFERENT server (the H1 hazard)", () => {
    // `@5` on serverB is a different window — window ids are only unique per
    // server. An id-only match would suppress serverB's tmux alignment, keep
    // serverA's stale tracking alive through the writeback, and let serverA's
    // 5s bounce yank the user cross-server with a false failure toast.
    expect(isSamePendingTarget(pending, "serverB", "@5")).toBe(false);
  });

  it("does NOT match a different window on the same server", () => {
    expect(isSamePendingTarget(pending, "serverA", "@6")).toBe(false);
  });

  it("does NOT match when no intent is pending", () => {
    expect(isSamePendingTarget(null, "serverA", "@5")).toBe(false);
  });

  it("does NOT match an undefined window id (no window in the URL)", () => {
    expect(isSamePendingTarget(pending, "serverA", undefined)).toBe(false);
  });
});

describe("direction-attribute latest-wins guard (nextDirectionToken / isLatestDirectionToken)", () => {
  it("the freshly minted token is the latest", () => {
    const token = nextDirectionToken();
    expect(isLatestDirectionToken(token)).toBe(true);
  });

  it("a superseded (earlier) token is no longer the latest", () => {
    const first = nextDirectionToken();
    const second = nextDirectionToken();
    // A rapid second switch minted `second`, so the first switch's cleanup must
    // NOT clear the attribute the successor set.
    expect(isLatestDirectionToken(first)).toBe(false);
    expect(isLatestDirectionToken(second)).toBe(true);
  });

  it("tokens are monotonically increasing", () => {
    const a = nextDirectionToken();
    const b = nextDirectionToken();
    expect(b).toBeGreaterThan(a);
  });
});

describe("postConfirmsSwitch (260823-ke9i)", () => {
  it("confirms when activeWindow matches the target", () => {
    expect(postConfirmsSwitch({ ok: true, activeWindow: "@2" }, "@2")).toBe(true);
  });

  it("confirms when activeWindow is absent (older daemon)", () => {
    expect(postConfirmsSwitch({ ok: true }, "@2")).toBe(true);
  });

  it("does NOT confirm a mismatched activeWindow (external switch won)", () => {
    expect(postConfirmsSwitch({ ok: true, activeWindow: "@5" }, "@2")).toBe(false);
  });

  it("does NOT confirm when ok is false", () => {
    expect(postConfirmsSwitch({ ok: false, activeWindow: "@2" }, "@2")).toBe(false);
  });
});

describe("resolvePendingSwitchVerdict (freshness-gated bounce, 260823-ke9i)", () => {
  const base = {
    isConnected: true,
    tickAtClick: 3,
    currentTick: 3,
    postContradiction: false,
    activeWindowId: "@1" as string | undefined,
    targetWindowId: "@2",
  };

  it("sleep/wake: frozen pre-click snapshot + disconnected socket ⇒ rearm (no bounce)", () => {
    expect(
      resolvePendingSwitchVerdict({ ...base, isConnected: false }),
    ).toBe("rearm");
  });

  it("no post-click evidence (connected but no receipt since the click) ⇒ rearm", () => {
    // activeWindowId is the frozen pre-click snapshot showing the OLD window —
    // without a post-click tick it must not render a failure verdict.
    expect(resolvePendingSwitchVerdict({ ...base })).toBe("rearm");
  });

  it("a post-click snapshot showing the target active ⇒ confirm", () => {
    expect(
      resolvePendingSwitchVerdict({
        ...base,
        currentTick: 4,
        activeWindowId: "@2",
      }),
    ).toBe("confirm");
  });

  it("a post-click snapshot showing a DIFFERENT window active ⇒ bounce", () => {
    expect(
      resolvePendingSwitchVerdict({
        ...base,
        currentTick: 4,
        activeWindowId: "@5",
      }),
    ).toBe("bounce");
  });

  it("a mismatched POST activeWindow counts as fresh evidence ⇒ bounce", () => {
    expect(
      resolvePendingSwitchVerdict({
        ...base,
        postContradiction: true,
        activeWindowId: "@5",
      }),
    ).toBe("bounce");
  });

  it("postContradiction with the target active ⇒ confirm", () => {
    expect(
      resolvePendingSwitchVerdict({
        ...base,
        postContradiction: true,
        activeWindowId: "@2",
      }),
    ).toBe("confirm");
  });

  it("a rearm fires even with post-click evidence when the socket dropped again", () => {
    expect(
      resolvePendingSwitchVerdict({
        ...base,
        isConnected: false,
        currentTick: 4,
        activeWindowId: "@5",
      }),
    ).toBe("rearm");
  });

  it("rejection-as-fresh-evidence: postContradiction with the stale pre-click active window ⇒ bounce", () => {
    // An explicit POST rejection sets postContradiction at the call site (the
    // rejection post-dates the click, so it IS fresh evidence). The stale
    // snapshot still shows the pre-click window — the verdict bounces rather
    // than re-arming into the failure limbo (SF8).
    expect(
      resolvePendingSwitchVerdict({
        ...base,
        postContradiction: true,
        activeWindowId: "@1",
      }),
    ).toBe("bounce");
  });
});

describe("resolvePendingSwitchPost (POST-settlement seam, 260823-ke9i)", () => {
  const base = {
    targetWindowId: "@2",
    isCurrent: true,
    intentMatches: true,
  };

  it("a matching 200 confirms (cancel the bounce timer)", () => {
    expect(
      resolvePendingSwitchPost({
        ...base,
        outcome: { kind: "resolved", resp: { ok: true, activeWindow: "@2" } },
      }),
    ).toBe("confirm");
  });

  it("a 200 with an absent activeWindow confirms (older daemon)", () => {
    expect(
      resolvePendingSwitchPost({
        ...base,
        outcome: { kind: "resolved", resp: { ok: true } },
      }),
    ).toBe("confirm");
  });

  it("a mismatched 200 is a contradiction (external switch won)", () => {
    expect(
      resolvePendingSwitchPost({
        ...base,
        outcome: { kind: "resolved", resp: { ok: true, activeWindow: "@5" } },
      }),
    ).toBe("contradiction");
  });

  it("an explicit rejection is fresh post-click evidence (bounce immediately)", () => {
    expect(
      resolvePendingSwitchPost({
        ...base,
        outcome: { kind: "rejected" },
      }),
    ).toBe("contradiction");
  });

  it("a superseded switch's late 200 is a no-op (tracked entry no longer current)", () => {
    expect(
      resolvePendingSwitchPost({
        ...base,
        isCurrent: false,
        outcome: { kind: "resolved", resp: { ok: true, activeWindow: "@2" } },
      }),
    ).toBe("none");
  });

  it("a settlement whose intent moved on is a no-op (identity mismatch)", () => {
    expect(
      resolvePendingSwitchPost({
        ...base,
        intentMatches: false,
        outcome: { kind: "resolved", resp: { ok: true, activeWindow: "@2" } },
      }),
    ).toBe("none");
  });

  it("a superseded switch's late rejection is a no-op (SF8: never bounce the successor)", () => {
    expect(
      resolvePendingSwitchPost({
        ...base,
        isCurrent: false,
        outcome: { kind: "rejected" },
      }),
    ).toBe("none");
  });
});
