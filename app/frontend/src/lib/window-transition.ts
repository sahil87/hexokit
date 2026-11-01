/**
 * Pure helpers for the window-switch slide transition (260703-l4nf).
 *
 * A same-server window switch animates as a vertical slide via the browser's
 * View Transitions API, keyed off the two windows' positions in the flattened
 * sidebar order. Everything DOM-facing (feature detection, the actual
 * `document.startViewTransition` call, the root data attribute) is driven from
 * `app.tsx`; the decision logic lives here as pure functions so it is unit-
 * testable without a DOM — the same pure-function pattern as `resolveServerView`
 * and `computeKillRedirect`.
 */

import { shouldRefuseTerminalChord, type BindingPlatform, type ChordEvent, type EffectiveBinding } from "./keybindings";

// The View Transitions API (`document.startViewTransition`, `ViewTransition`)
// is provided by the TS `dom` lib (TS 5.7+), so no ambient augmentation is
// needed. Feature detection (`viewTransitionSupported`) guards every call at
// runtime for browsers that lack it — type narrowing, not an `as` cast
// (code-quality principle).

/** Slide direction, or `null` when no transition should run. */
type WindowSwitchDirection = "up" | "down";

/**
 * Compute the slide direction from the two windows' positions in the flattened
 * (SSE-derived) window order.
 *
 * - target below current (higher index) → `"up"` (new content enters from below)
 * - target above current (lower index)  → `"down"`
 * - either id missing from the order, or the two ids equal → `null` (skip)
 *
 * Pure: no DOM, no side effects. `order` is the flattened list of window ids in
 * sidebar order (e.g. `flatWindows.map((fw) => fw.window.windowId)`).
 */
export function windowSwitchDirection(
  order: string[],
  currentId: string,
  targetId: string,
): WindowSwitchDirection | null {
  if (currentId === targetId) return null;
  const currentIndex = order.indexOf(currentId);
  const targetIndex = order.indexOf(targetId);
  if (currentIndex === -1 || targetIndex === -1) return null;
  return targetIndex > currentIndex ? "up" : "down";
}

/**
 * Runtime feature detection for the View Transitions API. Returns a plain
 * boolean (not a type predicate) via a `typeof` check on
 * `document.startViewTransition` — no `as` cast, honoring the type-narrowing-
 * over-assertions code-quality principle.
 */
export function viewTransitionSupported(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof document.startViewTransition === "function"
  );
}

/**
 * Decide whether a window switch should animate. All conditions must hold:
 * View Transitions support, motion not reduced, an outgoing window is in view,
 * and a slide direction resolved. Any failure falls through to the instant
 * switch (progressive enhancement). Pure — the caller supplies the ambient
 * facts (support, media query, param presence, computed direction).
 */
export function shouldAnimateWindowSwitch(opts: {
  hasVTSupport: boolean;
  reducedMotion: boolean;
  hasOutgoingWindow: boolean;
  direction: WindowSwitchDirection | null;
}): boolean {
  return (
    opts.hasVTSupport &&
    !opts.reducedMotion &&
    opts.hasOutgoingWindow &&
    opts.direction !== null
  );
}

/** How long the wrapper waits for the incoming window's first paint (ms). */
const FIRST_WRITE_TIMEOUT_MS = 300;

/**
 * How the first-write gate settled — the "earned signal" discriminator
 * (260715-38kg). The wrapper branches on this to decide the honest feedback:
 *
 * - `"first-write"` — the incoming window's bytes arrived within the budget →
 *   the slide plays (confirmed-fast arrival).
 * - `"timeout"` — the budget elapsed with no incoming bytes → the wrapper calls
 *   `skipTransition()` (no motion) and the pending spinner mask arms.
 * - `"superseded"` — a newer `beginWindowSwitchGate` fired this gate → the
 *   superseded switch owns NO feedback (neither slide nor mask); the newer
 *   switch's gate owns it all.
 */
export type GateSettleReason = "first-write" | "timeout" | "superseded";

/**
 * First-inbound-bytes gate for the polished capture (260703-l4nf).
 *
 * The transition wrapper in `app.tsx` opens a gate (`beginWindowSwitchGate`)
 * before navigating, then `await`s `waitForFirstWrite()` inside
 * `startViewTransition`'s async callback so the new-state snapshot is captured
 * only once the incoming window has received its first bytes. `TerminalClient`
 * calls `notifyFirstWrite()` at message-receipt time (inside `ws.onmessage`,
 * before the write/coalesce decision), which releases the gate. Receipt time,
 * not write time: `startViewTransition` suppresses rendering while its callback
 * runs and rAF callbacks do not fire during suppression, so a release keyed off
 * the (rAF-scheduled) coalesced flush would never fire during the transition.
 *
 * The gate handles three concurrency subtleties:
 *
 * 1. **Rapid switching does not serialize.** Per the View Transitions spec, a
 *    second `startViewTransition` started while one is in flight queues its
 *    update callback BEHIND the first callback's returned promise. The first
 *    callback holds that promise open for up to the timeout (it `await`s the
 *    gate), so a second switch's navigation would stall behind the first's full
 *    timeout. `beginWindowSwitchGate` therefore FIRES (resolves) any still-
 *    pending prior gate immediately on supersession, so the first callback
 *    returns at once and the browser runs the queued second callback without
 *    delay.
 *
 * 2. **Only the INCOMING window's bytes release the gate.** A same-session
 *    switch rides the existing WebSocket with no reconnect, so a busy OUTGOING
 *    window can still be streaming bytes when the switch fires; those would
 *    release the gate before tmux has even run `select-window`. The gate stays
 *    closed to `notify` until `openForNotify()` is called, which the wrapper
 *    does only after the `selectWindow` POST resolves — so a byte only counts
 *    once tmux has been told to switch. The wrapper does NOT `await` the POST
 *    before starting the wait: it CHAINS `openForNotify` off the POST
 *    (`posted.then(() => gate.openForNotify())`) and awaits only
 *    `waitForFirstWrite()`, whose timeout clock starts at the wait (callback
 *    entry), not after the POST. So the callback's total duration is hard-capped
 *    at the timeout regardless of the POST's fate — a stalled `selectWindow`
 *    (no client-side fetch timeout) cannot freeze the document past the ~300ms
 *    budget, and a rapid second switch never queues behind a stalled POST.
 *    Bytes that arrive before the POST resolves are ignored, so if the POST is
 *    slow the gate simply times out ungated (today's behavior plus motion)
 *    rather than releasing on a stale outgoing byte.
 *
 * 3. **A stale timer does not clobber a newer gate.** Each gate is a distinct
 *    token; `settleGate` clears the module slot only when it still points at its
 *    own token, so a late timeout from a superseded gate can neither resolve
 *    nor disarm the current one.
 *
 * A single module-level slot is sufficient: at any moment there is exactly one
 * focused terminal and at most one gate the wrapper is awaiting (a superseding
 * `beginWindowSwitchGate` fires the previous one). `notify` is a cheap no-op
 * when no gate is open for it, so terminal receipts outside a transition are
 * free.
 */
interface SwitchGate {
  /**
   * Resolves the awaiting `waitForFirstWrite` with the settle reason, once. Null
   * once settled.
   */
  resolve: ((reason: GateSettleReason) => void) | null;
  /** Timer that resolves the gate on timeout. */
  timer: ReturnType<typeof setTimeout> | null;
  /**
   * Whether a terminal write should release the gate yet. False until the
   * wrapper calls `openForNotify()` (after the selectWindow POST resolves), so
   * a busy outgoing window's in-flight bytes can't release it early.
   */
  acceptingNotify: boolean;
  /**
   * Whether this switch targets a gated (tty) window. Drives the pending-mask
   * signal (260715-38kg): only a gated switch's `"timeout"` settle arms the
   * mask — a non-tty (web/code) target never masks. Held on the gate so the
   * arm decision lives in `settleGate` (one signal source), not the wrapper.
   */
  gated: boolean;
}

let currentGate: SwitchGate | null = null;

/** A live view-transition first-write gate. Returned by `beginWindowSwitchGate`. */
interface WindowSwitchGate {
  /**
   * Start accepting `notifyFirstWrite` releases. The wrapper calls this after
   * the `selectWindow` POST has resolved, so only writes that arrive once tmux
   * has been told to switch count as the incoming window's first paint.
   */
  openForNotify(): void;
  /**
   * Resolve with the settle reason when the incoming window's first write
   * arrives (`notifyFirstWrite`, once `openForNotify` was called), after the
   * timeout, or on supersession — whichever is first.
   */
  waitForFirstWrite(timeoutMs?: number): Promise<GateSettleReason>;
}

/**
 * Open a new first-write gate for a window-switch transition. FIRES any prior
 * still-pending gate immediately (supersession — so a queued
 * `startViewTransition` callback runs at once rather than stalling behind the
 * prior gate's timeout). Call before navigating; then `openForNotify()` after
 * the selectWindow POST resolves and `await waitForFirstWrite()` in the
 * transition callback.
 *
 * `opts.gated` marks whether the target renders a terminal (tty) — only a gated
 * switch's `"timeout"` arms the pending mask (260715-38kg). Defaults to `true`
 * (the common terminal path); the wrapper passes `false` for web/code targets.
 */
export function beginWindowSwitchGate(opts?: { gated?: boolean }): WindowSwitchGate {
  // Supersede: resolve (do not silently discard) any prior pending gate so the
  // View-Transition callback awaiting it returns immediately. A pending prior
  // gate settles `"superseded"` (which clears any mask it armed). But a prior
  // switch may have ALREADY timed out and armed the mask (its gate settled, so
  // `currentGate` is null) — a fresh switch beginning still owns all feedback,
  // so clear any leftover mask/grace timer unconditionally here. The new gate
  // (or grace timer) will re-arm its own mask if IT times out (assumption 13).
  if (currentGate) {
    const prior = currentGate;
    settleGate(prior, "superseded");
  }
  tearDownMask();

  // This switch is now the current one: mint its epoch and close mask-lift
  // acceptance until ITS selectWindow POST resolves (see openForNotify).
  const epoch = ++switchEpoch;
  liftAccepting = false;
  bytesCounted = false;

  const gate: SwitchGate = {
    resolve: null,
    timer: null,
    acceptingNotify: false,
    gated: opts?.gated ?? true,
  };
  currentGate = gate;

  return {
    openForNotify() {
      gate.acceptingNotify = true;
      // The switch's POST resolved: incoming bytes may now also LIFT the mask
      // this switch arms on timeout (the same post-POST filter the gate release
      // uses — an OUTGOING window's still-streaming bytes must not un-mask
      // stale content; rework F3). Epoch-guarded so a STALE switch's late POST
      // resolution can't enable lifts for a newer switch's mask.
      if (epoch === switchEpoch) {
        liftAccepting = true;
        // Count a receipt that landed while THIS switch's POST was in flight
        // (CI 260716): on the shared per-session socket, tmux's redraw races
        // the HTTP response, and losing that race must not cost the release —
        // the successful resolution proves tmux switched, so the recorded
        // receipt is the incoming window's paint.
        if (inFlightNotifyEpoch === epoch) {
          bytesCounted = true;
          if (currentGate === gate) {
            // Gate still pending: settle as first-write — the slide plays and
            // the timeout (with its mask) is cancelled.
            settleGate(gate, "first-write");
          } else {
            // Gate already timed out (mask armed): lift it now.
            tearDownMask();
          }
        }
      }
    },
    waitForFirstWrite(timeoutMs: number = FIRST_WRITE_TIMEOUT_MS): Promise<GateSettleReason> {
      return new Promise<GateSettleReason>((resolve) => {
        // If this gate was already superseded before the wrapper got here,
        // resolve immediately — never leave the callback hanging.
        if (currentGate !== gate) {
          resolve("superseded");
          return;
        }
        gate.resolve = resolve;
        gate.timer = setTimeout(() => settleGate(gate, "timeout"), timeoutMs);
      });
    },
  };
}

/**
 * Release the current gate iff it is open for notify. Called from
 * `TerminalClient`'s `ws.onmessage` at message-receipt time; a cheap no-op when
 * no gate is awaiting a write (unarmed, already settled, or not yet
 * `openForNotify`'d).
 *
 * This is the ONE signal that drives everything (260715-38kg, assumption 3):
 * the same receipt that releases the gate ALSO lifts the pending mask when the
 * incoming window's bytes arrive late (after a `"timeout"` settle already armed
 * it) — and cancels a pending grace timer so an early arrival never masks.
 *
 * The lift is FILTERED exactly like the gate release (rework F3): a byte only
 * counts once the switch's `selectWindow` POST has resolved (`liftAccepting`,
 * set by `openForNotify`/`openForLift`). On a same-session switch the OUTGOING
 * window's still-streaming bytes ride the same socket — without the filter they
 * would lift the mask (or cancel the grace timer) before tmux ever switched,
 * un-masking stale content in exactly the busy-old-window hazard case.
 */
export function notifyFirstWrite(): void {
  if (currentGate && currentGate.acceptingNotify) {
    bytesCounted = true;
    settleGate(currentGate, "first-write");
    return;
  }
  // Filtered late-arrival mask lift: even after the gate timed out and settled
  // (`currentGate` null), the incoming window's first COUNTABLE byte (post-POST)
  // is the signal that the switch DID arrive — lift the mask as a cut, and
  // cancel any pending grace timer.
  if (liftAccepting) {
    bytesCounted = true;
    tearDownMask();
    return;
  }
  // Could not act — either no switch is in flight (idle terminal receipts, the
  // overwhelmingly common case) or the switch's POST has not resolved yet.
  // RECORD the receipt tagged with the current epoch (CI 260716): if this IS a
  // switch's in-flight redraw, the POST's resolution will count it; if it is an
  // idle or outgoing receipt, the tag either predates the next switch's epoch
  // mint or is never consumed (a rejected POST runs no resolution chain).
  inFlightNotifyEpoch = switchEpoch;
}

/**
 * Settle a gate with its reason: resolve its pending promise (if any), clear
 * its timer, arm/clear the pending mask, and clear the module slot ONLY when it
 * still points at this gate. The still-points-at-itself guard means a late
 * timeout from a superseded gate can neither resolve a newer gate, null out the
 * current slot, nor touch the mask.
 */
function settleGate(gate: SwitchGate, reason: GateSettleReason): void {
  if (gate.timer !== null) {
    clearTimeout(gate.timer);
    gate.timer = null;
  }
  const resolve = gate.resolve;
  gate.resolve = null;
  // Stale-timer guard: only relinquish the module slot (and touch the mask) if
  // it is still ours. A superseded gate's late timeout must not disturb the
  // newer gate's mask.
  if (currentGate === gate) {
    currentGate = null;
    // Mask signal (260715-38kg): a gated switch that timed out arms the mask
    // (stale bytes hidden, "don't type"); a fast first-write or a supersession
    // ensures no mask is shown for this switch.
    if (reason === "timeout" && gate.gated) {
      setMaskState("masked");
    } else {
      setMaskState("idle");
    }
  }
  if (resolve) resolve(reason);
}

// ── Pending-switch mask signal (260715-38kg) ────────────────────────────────
//
// A pure, unit-testable state machine that expresses the pending-switch mask:
// ARMED at gate timeout (a gated/tty switch whose incoming bytes did not arrive
// within the ~300ms budget), LIFTED on the late first write (the same
// `notifyFirstWrite` receipt that would have released the gate), and TORN DOWN
// on supersession and on failure/bounce. It carries NO DOM and NO React — the
// app subscribes via `useSyncExternalStore(subscribeMaskState, getMaskState)`
// and renders the LogoSpinner overlay. Keeping arm/lift/teardown here (driven by
// the same seams as the gate) is what guarantees the mask and gate never drift.

/** Whether the pending-switch spinner mask is showing. */
export type MaskState = "idle" | "masked";

let maskState: MaskState = "idle";
const maskListeners = new Set<() => void>();

/**
 * Switch epoch: minted by every `beginWindowSwitchGate` / `armGraceMask` (one
 * per switch — the two never run for the same switch). Mask-lift acceptance is
 * per-epoch: `openForNotify`/`openForLift` enable the lift only while their
 * switch is still the current one, so a STALE switch's late POST resolution can
 * never enable lifts (and thus premature un-masking) for a newer switch's mask.
 * Mirrors the gate's still-points-at-itself guard, at switch granularity.
 */
let switchEpoch = 0;

/**
 * Whether an incoming byte may lift the mask / cancel the grace timer. False
 * from switch start until the switch's `selectWindow` POST resolves (rework F3
 * — the same post-POST filter as the gate's `acceptingNotify`): a busy OUTGOING
 * window's bytes ride the same socket and must not un-mask stale content.
 */
let liftAccepting = false;

/**
 * The switch epoch whose receipt arrived while its `selectWindow` POST was
 * still IN FLIGHT (CI regression, 260716). On a same-session switch the relay
 * socket is shared ((server, session)-keyed — no reconnect), and tmux executes
 * `select-window` + redraws the attached client BEFORE the POST's HTTP response
 * resolves in the browser — so the one-and-only redraw receipt can land inside
 * the [POST-sent, POST-resolved) window while `acceptingNotify`/`liftAccepting`
 * are still closed. DROPPING that receipt is a permanent loss: tmux is idle
 * after the redraw, no further receipt ever comes, and the gate times out into
 * a mask whose receipt-time lift path is dead (locally the response reliably
 * wins the race; on a loaded CI runner the redraw does — deterministically).
 *
 * Instead the receipt is RECORDED here, tagged with the current switch epoch,
 * and COUNTED when the POST resolves (`openForNotify` / `openForLift`): the 200
 * proves tmux executed select-window — exactly the fact the acceptance filter
 * was waiting to establish — so the recorded receipt IS the incoming window's
 * paint. The outgoing-straggler hazard stays guarded: a REJECTED POST never
 * runs the resolution chains (nothing is counted for a failed switch), and
 * receipts from before the switch epoch minted never match.
 */
let inFlightNotifyEpoch: number | null = null;

/**
 * Whether a byte has been counted as the INCOMING window's for the current
 * switch epoch. Cleared wherever a new switch mints its epoch
 * (`beginWindowSwitchGate`, `armGraceMask`) and set at every point a byte is
 * accepted as the incoming window's: the `acceptingNotify` gate release and
 * the `liftAccepting` mask lift in `notifyFirstWrite`, and the in-flight
 * receipt counted at `openForNotify`/`openForLift`. This is what byte-gates
 * `confirmSwitchArrived`: SSE confirms INTENT (the URL/heading may stand)
 * before any pixel of the new window exists, so paint feedback must stay
 * byte-driven — an SSE confirmation with no counted byte leaves the gate to
 * its timeout (arming the mask) and the late first write to lift it.
 */
let bytesCounted = false;

/** Pure query for `bytesCounted` — tests assert the counting paths. */
export function hasCountedIncomingBytes(): boolean {
  return bytesCounted;
}

/** Snapshot for `useSyncExternalStore`. Stable identity while unchanged. */
export function getMaskState(): MaskState {
  return maskState;
}

/**
 * Subscribe to mask-state changes (the `useSyncExternalStore` contract).
 * Returns an unsubscribe function. Listeners fire only on an actual transition.
 */
export function subscribeMaskState(listener: () => void): () => void {
  maskListeners.add(listener);
  return () => {
    maskListeners.delete(listener);
  };
}

/** Set the mask state and notify subscribers only when it actually changes. */
function setMaskState(next: MaskState): void {
  if (maskState === next) return;
  maskState = next;
  for (const listener of maskListeners) listener();
}

/**
 * Tear the mask down: cancel any pending grace timer and clear the mask. THE
 * single mask-clearing primitive (rework F5 — the former `notifyMaskLift` alias
 * was byte-identical and is folded in): called by `notifyFirstWrite`'s filtered
 * late lift, by `confirmSwitchArrived` (byte-gated) / `forceSwitchArrived`
 * (unconditional) / `abandonSwitchFeedback`, and at every
 * fresh switch start (a new switch owns all feedback). Idempotent no-op when
 * already idle and no timer pending.
 *
 * NOTE (cycle-3 N1, per the plan's Deletion Candidates narrowing note): the
 * abandonment/arrival callers were folded away — app.tsx's former direct callers
 * (failure/bounce, route-leave/unmount) were replaced by `abandonSwitchFeedback()`
 * in the G2 rework, which additionally settles a still-pending gate. For those
 * intents production callers reach for `abandonSwitchFeedback` (abandonment),
 * `confirmSwitchArrived` (byte-gated confirmed arrival), or
 * `forceSwitchArrived` (the unconditional confirmation-timer rescue), all of
 * which delegate here. The
 * ONE sanctioned direct production caller of the bare primitive is
 * `beginPendingSwitch`'s fresh-switch teardown (260719-h0x4): it must clear a
 * leftover mask WITHOUT settling a gate, because on the animated path it runs
 * while the switch's own just-opened gate is current — settling it would skip the
 * earned slide, which is exactly why the abandonment wrapper is wrong there.
 */
export function tearDownMask(): void {
  cancelGraceTimer();
  setMaskState("idle");
}

/**
 * The switch is confirmed ARRIVED by an out-of-band authority — the SSE snapshot
 * reporting the target window active — and at least one byte has
 * already been counted as the incoming window's. BYTE-GATED: when no byte has
 * been counted for the current switch epoch this is a NO-OP on the gate and the
 * mask. SSE fires as soon as `select-window` lands — before any byte has reached
 * the terminal — so an ungated settle would animate the slide into a surface
 * that has not painted yet and suppress the spinner mask the design promises for
 * that case. With no counted byte the gate's 300ms timeout arms the mask and the
 * later first write lifts it (the designed late-arrival cut). With a counted
 * byte the gate has already settled `"first-write"` (the counting path IS the
 * settle), so acting here only tears down any leftover mask/grace timer.
 * The unconditional form — for the confirmation-timer rescue, where a mask with
 * no lift path must never stay up — is `forceSwitchArrived()`.
 */
export function confirmSwitchArrived(): void {
  if (!bytesCounted) return;
  if (currentGate) {
    settleGate(currentGate, "first-write");
  }
  tearDownMask();
}

/**
 * The UNCONDITIONAL arrival teardown (the 5 s confirmation-timer rescue in
 * `app.tsx`'s `bouncePendingSwitch`): settle any still-pending gate as
 * `"first-write"` and tear down any mask/grace timer, regardless of byte
 * counting. After the confirmation window has elapsed with SSE reporting the
 * target active, a mask whose byte-driven lift path never fired must not stay
 * up — a stuck input-blocking mask is the worst outcome the design forbids.
 */
export function forceSwitchArrived(): void {
  if (currentGate) {
    settleGate(currentGate, "first-write");
  }
  tearDownMask();
}

/**
 * Abandon the current switch's feedback machinery entirely (rework G2): settle
 * a still-pending gate as `"superseded"` — so its timer can never fire a later
 * `"timeout"` that RE-ARMS the mask — and tear down any mask/grace timer
 * already showing.
 *
 * The failure/bounce and route-leave/unmount paths call this instead of a bare
 * `tearDownMask()`. Tearing down only the mask leaves the pending gate armed:
 * a `selectWindow` POST that rejects INSIDE the 300ms budget bounces first,
 * then the gate's timer fires `settleGate(gate, "timeout")` and arms a mask
 * over the bounced-back window with NO lift path (`liftAccepting` stays false
 * after a rejected POST, and `confirmSwitchArrived` is only reachable while
 * `pendingClickRef` is set) — a permanently stuck input-blocking mask. Same
 * for leaving/unmounting the route within the 300ms window: the gate would
 * re-mask up to 300ms later, leaking masked state into the next mount.
 * Idempotent no-op when nothing is pending or showing.
 */
export function abandonSwitchFeedback(): void {
  if (currentGate) {
    settleGate(currentGate, "superseded");
  }
  tearDownMask();
}

// ── Non-VT / reduced-motion grace mask (260715-38kg, R3) ────────────────────

let graceTimer: ReturnType<typeof setTimeout> | null = null;

/** Clear any pending grace timer (shared by the lift, teardown, and re-arm). */
function cancelGraceTimer(): void {
  if (graceTimer !== null) {
    clearTimeout(graceTimer);
    graceTimer = null;
  }
}

/** Handle for a grace-timer mask arm. Returned by `armGraceMask`. */
export interface GraceMaskHandle {
  /**
   * Start accepting mask lifts / grace cancellation from incoming bytes. The
   * caller invokes this once the switch's `selectWindow` POST has resolved —
   * the exact analog of the gate's `openForNotify` (rework F3): until then an
   * OUTGOING window's still-streaming bytes must neither cancel the grace timer
   * (suppressing a deserved mask) nor lift an armed mask (un-masking stale
   * content). Epoch-guarded: a stale switch's late POST resolution is ignored.
   */
  openForLift(): void;
  /** Disarm the pending grace timer (switch confirmed/superseded/bounced). */
  cancel(): void;
}

/**
 * Arm the pending mask via a ~300ms grace timer for the instant-switch path
 * (browsers without View Transitions, or `prefers-reduced-motion: reduce`),
 * which has no render-freeze phase and so no gate to time out. Shows the mask
 * only if the incoming window's first countable write has NOT arrived by the
 * threshold — same threshold as the gate, different mechanism, same
 * lift/teardown semantics (`notifyFirstWrite`'s filtered lift; `tearDownMask`
 * on failure/bounce).
 *
 * One switch's feedback machinery at a time: arming supersedes any prior grace
 * timer AND any still-pending gate (a rapid animated→instant switch sequence
 * must not let the stale gate's later timeout mask the newer switch), and
 * clears any leftover mask a prior timed-out switch left showing.
 */
export function armGraceMask(timeoutMs: number = FIRST_WRITE_TIMEOUT_MS): GraceMaskHandle {
  // Supersede a still-pending gate (mirrors beginWindowSwitchGate superseding —
  // its VT callback resolves "superseded" and its timeout can no longer fire).
  if (currentGate) {
    const prior = currentGate;
    settleGate(prior, "superseded");
  }
  // Supersede any prior grace timer + clear leftover mask — one signal at a time.
  tearDownMask();

  // This switch is now the current one (same epoch discipline as the gate).
  const epoch = ++switchEpoch;
  liftAccepting = false;
  bytesCounted = false;

  const timer = setTimeout(() => {
    graceTimer = null;
    setMaskState("masked");
  }, timeoutMs);
  graceTimer = timer;
  return {
    openForLift() {
      if (epoch === switchEpoch) {
        liftAccepting = true;
        // Count an in-flight receipt at resolution (CI 260716) — same rule as
        // the gate's openForNotify: cancels a pending grace timer (the switch
        // arrived, never mask) or lifts a mask the timer already armed.
        if (inFlightNotifyEpoch === epoch) {
          bytesCounted = true;
          tearDownMask();
        }
      }
    },
    cancel() {
      if (graceTimer === timer) {
        clearTimeout(timer);
        graceTimer = null;
      }
    },
  };
}

/**
 * Global-chord exemption for the pending-mask keyboard swallow (rework F2).
 *
 * While the mask is up, `app.tsx` swallows keydowns at the terminal surface
 * (capture phase) so keystrokes can't reach the OLD window's pty. But the
 * swallow's job is input safety for TERMINAL-BOUND input only — the app's
 * global chords are document/window bubble listeners that a capture-phase
 * `stopPropagation` would kill for up to the 5s confirmation window, and
 * constitution V names Cmd+K the primary discovery mechanism. Exempt:
 *
 * - `Escape` — palette/dialog dismiss.
 * - Cmd (meta) chords — xterm does not forward meta-modified keys to the pty,
 *   so these are never terminal input (covers Cmd+K palette, Cmd+; layout
 *   cycle, Cmd+B sidebar toggle on macOS wholesale) — EXCEPT Cmd+V (rework SF6):
 *   the browser's default paste action lands in xterm's focused textarea and
 *   thus the OLD pty, so the paste chord stays swallowed.
 * - The specific Ctrl-bound global chords: Ctrl+K (palette) and Shift+Ctrl+B
 *   (sidebar toggle on Win/Linux) — shift is REQUIRED on the B chord because
 *   plain Ctrl+B is pty input (readline back-char) —
 *   all with `!altKey` required (rework NTH9): AltGr on Windows/Linux layouts
 *   reports `ctrlKey: true`, and AltGr+char is typed INPUT, never a chord (the
 *   same modifier discipline the retired `use-chat-view-shortcut.ts` used).
 * - Every app-owned registry chord the terminal refuses
 *   (`shouldRefuseTerminalChord` against the effective bindings — the whole
 *   shifted tier on every platform: ⇧⌃↑/↓ tab cycle, ⇧⌃←/→ group jump,
 *   history, splits, …). xterm never transmits a refused key, so it cannot
 *   reach the OLD pty — the hazard the mask blocks — and swallowing it would
 *   silently drop the user's navigation for the whole confirmation window.
 *   Deriving this from the registry keeps a rebound or newly added chord
 *   exempt without touching this list.
 *
 * Everything else — plain typing, terminal control bytes like Ctrl+C, and the
 * paste chords — stays swallowed: those are exactly the typed-into-the-OLD-
 * window hazards the mask exists to block. Structurally typed (not
 * `KeyboardEvent`) so the predicate is DOM-free and unit-testable.
 */
export function isMaskExemptKey(
  e: ChordEvent & { key: string },
  bindings: readonly EffectiveBinding[],
  platform: BindingPlatform,
): boolean {
  if (e.key === "Escape") return true;
  if (shouldRefuseTerminalChord(e, bindings, platform)) return true;
  if (e.metaKey) return e.key.toLowerCase() !== "v";
  if (e.ctrlKey && !e.altKey) {
    const key = e.key.toLowerCase();
    if (key === "k") return true;
    return e.shiftKey && key === "b";
  }
  return false;
}

/**
 * A switch click that cannot change anything (rework G3): the target is BOTH
 * the URL's window AND tmux's active window. tmux `select-window` on the
 * already-active window emits no bytes, and the SSE snapshot is event-driven —
 * no change means no confirming event — so arming the pending-switch machinery
 * for such a click guarantees a spurious spinner mask at the 300ms threshold
 * and a false "didn't confirm" failure toast at the confirmation window, over
 * the very terminal the user is looking at. `navigateToWindow` early-outs on
 * this predicate (keeping only the ergonomic mobile-drawer close), matching the
 * pre-change behavior where such a click was inert. Pure and unit-testable;
 * `undefined` inputs (no URL window in view / no SSE snapshot yet) are never
 * redundant — a real navigation is then required.
 */
export function isRedundantSwitch(
  targetId: string,
  urlWindowId: string | undefined,
  activeWindowId: string | undefined,
): boolean {
  return targetId === urlWindowId && targetId === activeWindowId;
}

/**
 * The server-scoped identity of a pending window switch (rework H1, cycle 3).
 *
 * tmux window ids (`@N`) are only unique PER SERVER, and AppShell persists
 * across `$server` route changes without remounting — so every consumer of the
 * pending-switch intent MUST compare BOTH fields. Matching on `windowId` alone
 * false-positives when two servers carry a colliding id (serverA/@5 vs
 * serverB/@5): the alignment skip would suppress serverB's tmux alignment, the
 * writeback's `urlMatchesPending`/`sseConfirmed` would keep stale tracking
 * alive, and the stale serverA bounce would later yank the user cross-server
 * with a false failure toast.
 */
export interface PendingSwitchTarget {
  server: string;
  windowId: string;
}

/**
 * True iff `pending` records exactly this `{server, windowId}` pair. `null`
 * pending, an `undefined` windowId (no window in the URL), or a mismatch on
 * EITHER field is not a match — the cross-server id collision (same `@N`
 * string, different server) is precisely what the server field disambiguates.
 * Pure and unit-testable; app.tsx uses it at the alignment skip, the
 * writeback's `urlMatchesPending`/`sseConfirmed` checks, and the bounce guard.
 */
export function isSamePendingTarget(
  pending: PendingSwitchTarget | null,
  server: string,
  windowId: string | undefined,
): boolean {
  return (
    pending !== null &&
    windowId !== undefined &&
    pending.server === server &&
    pending.windowId === windowId
  );
}

/**
 * Latest-wins guard for the `data-window-switch-direction` root attribute.
 *
 * The attribute is set by the wrapper immediately before `startViewTransition`
 * and cleared in the transition's `finished.finally()`. But `finished` FULFILLS
 * when a transition is SKIPPED (superseded by a rapid second switch) — NOT
 * rejects — so a superseded transition's `finally()` would otherwise delete the
 * attribute that its successor already set, dropping the successor slide's
 * direction CSS. Mirror the gate's still-points-at-itself pattern: each switch
 * captures a monotonic token at set time via `nextDirectionToken()`, and its
 * cleanup deletes the attribute only when `isLatestDirectionToken(token)` — i.e.
 * only the LATEST switch's `finally()` may clear it. Pure module state, no DOM.
 */
let latestDirectionToken = 0;

/** Mint the next direction token and record it as the latest. */
export function nextDirectionToken(): number {
  latestDirectionToken += 1;
  return latestDirectionToken;
}

/** True only if `token` is still the latest minted direction token. */
export function isLatestDirectionToken(token: number): boolean {
  return token === latestDirectionToken;
}

// ── Confirmation-on-200 and the freshness-gated bounce (260823-ke9i) ────────

/** The settlement-shape of a `selectWindow` POST, from the caller's side. */
export type SwitchPostOutcome =
  | { kind: "resolved"; resp: { ok: boolean; activeWindow?: string } }
  | { kind: "rejected" };

/**
 * What a settled `selectWindow` POST does to the tracked pending switch
 * (260823-ke9i).
 */
export type SwitchPostEffect = "confirm" | "contradiction" | "none";

/**
 * Decide how a settled `selectWindow` POST affects the pending switch's
 * failure detector. Pure — the caller supplies the ambient identity facts (the
 * still-points-at-itself tracked-entry guard, and whether the intent still
 * records this `{server, windowId}`).
 *
 * - `"confirm"` — the 200 is synchronous proof tmux executed the select:
 *   cancel the bounce timer only (never the intent or the gate/mask — paint
 *   feedback stays byte-driven).
 * - `"contradiction"` — fresh post-click evidence: an explicit rejection
 *   (rejection IS fresh evidence — it post-dates the click, so the
 *   freshness-gated verdict can bounce immediately instead of re-arming into
 *   the SF8 limbo) or a mismatched `activeWindow` (an external switch won).
 * - `"none"` — a superseded switch's late settlement, or an intent that has
 *   moved on: a no-op; the newer switch's tracking is untouched.
 */
export function resolvePendingSwitchPost(opts: {
  outcome: SwitchPostOutcome;
  targetWindowId: string;
  isCurrent: boolean;
  intentMatches: boolean;
}): SwitchPostEffect {
  if (!opts.isCurrent || !opts.intentMatches) return "none";
  if (opts.outcome.kind === "rejected") return "contradiction";
  return postConfirmsSwitch(opts.outcome.resp, opts.targetWindowId)
    ? "confirm"
    : "contradiction";
}

/**
 * True iff a resolved `selectWindow` POST response confirms the pending switch
 * to `targetWindowId`. The 200 alone proves tmux executed the select (the
 * handler runs it synchronously), so an absent `activeWindow` field (older
 * daemon) counts as confirming; a mismatched `activeWindow` is fresh evidence
 * of a contradiction (an external switch won the race), not a confirmation.
 */
export function postConfirmsSwitch(
  resp: { ok: boolean; activeWindow?: string },
  targetWindowId: string,
): boolean {
  return resp.ok && (resp.activeWindow === undefined || resp.activeWindow === targetWindowId);
}

/**
 * The expiry decision for a pending switch's confirmation timer
 * (260823-ke9i): the verdict is freshness-gated so a failure is never rendered
 * from evidence older than the click.
 *
 * - `"confirm"` — post-click evidence shows the target active (the silent-clear
 *   rescue).
 * - `"bounce"` — fresh post-click evidence shows a DIFFERENT window active
 *   (either a mismatched POST `activeWindow`, or a post-click snapshot
 *   contradicting the target).
 * - `"rearm"` — no fresh evidence (disconnected socket, or no receipt since
 *   the click): the verdict must not fire on a frozen pre-click snapshot, so
 *   the timer re-arms and waits for evidence (extend-until-evidence).
 *
 * Pure — the caller supplies the ambient facts; `activeWindowId` is only
 * consulted when it is post-click evidence (a receipt tick newer than the one
 * recorded at the click, or the POST contradiction flag).
 */
export function resolvePendingSwitchVerdict(opts: {
  isConnected: boolean;
  tickAtClick: number;
  currentTick: number;
  postContradiction: boolean;
  activeWindowId: string | undefined;
  targetWindowId: string;
}): "confirm" | "bounce" | "rearm" {
  const hasFreshEvidence =
    opts.postContradiction || opts.currentTick > opts.tickAtClick;
  if (!opts.isConnected || !hasFreshEvidence) return "rearm";
  return opts.activeWindowId === opts.targetWindowId ? "confirm" : "bounce";
}
