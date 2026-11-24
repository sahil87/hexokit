/**
 * Animated window-switch (View Transitions) coverage.
 *
 * Every OTHER e2e spec runs under the config-wide reduced-motion emulation, so
 * they exercise the product's instant-switch fallback and never touch the slide
 * transition. This spec is the ONE place that opts back into motion
 * (`test.use({ contextOptions: { reducedMotion: "no-preference" } })`) and
 * drives the real animated path end-to-end.
 *
 * It guards against a systematic gate-timeout freeze: the polished capture gates
 * the new-state snapshot on the incoming window's first inbound bytes, released
 * at message-receipt time inside `ws.onmessage`. A regression that
 * makes that release unreachable (e.g. moving it back to a write seam that never
 * fires during View-Transition render suppression, or a UA group animation
 * holding `transition.finished` open) would make an animated switch hang instead
 * of completing. The assertion — the incoming window's content becomes visible
 * within a sane latency bound (well under 1s) — fails loudly on such a hang.
 *
 * Confirmation-gated motion: the slide is an EARNED signal —
 * it plays ONLY when the incoming bytes confirm within the ~300ms budget; a
 * timeout SKIPS the slide and shows a LogoSpinner "pending" mask instead, and a
 * rejected switch returns the URL to tmux truth. Those timing-sensitive
 * branches (mask arm-at-timeout / lift-on-late-write / rejected switch) cannot be
 * forced deterministically against a live relay on localhost, so they are
 * UNIT-covered in `src/lib/window-transition.test.ts` and `src/lib/switch-overlay.test.ts`. What this spec adds for
 * the new behavior is the deterministic fast-path invariant: a confirmed-fast
 * switch plays the slide and leaves NO pending mask stuck once it settles. A
 * brief legitimate mask flash is allowed (localhost timing can push the first
 * confirmed write past the ~300ms budget); the assertion only rules out a mask
 * left STUCK — it polls `.rk-window-switch-mask` to count 0 within the budget,
 * not an instant absence.
 *
 * Shared setup: `test.use({ contextOptions: { reducedMotion: "no-preference"
 * } })` opts this file's tests into motion, overriding the config-wide
 * reduced-motion emulation. `reducedMotion` is not a top-level `use` fixture
 * in this Playwright version; it only reaches the browser context via
 * `contextOptions`, so both the config and this override set it there —
 * without it the wrapper short-circuits to an instant switch and the
 * transition never runs. `beforeAll` creates `e2e-switch-transition-<ts>`;
 * `afterAll` kills it. `resolveWindowId(page, name)` polls `GET /api/sessions`
 * until the window surfaces, returning its stable `@N` id (the handle for
 * both URL navigation and buffer reads). `markerVisible(page, id, marker)`
 * reads the live xterm `Terminal` from `window.__rkTerminals[id]` (populated
 * only in dev/e2e builds) and scans its buffer for the marker text — the
 * WebGL canvas is not DOM-readable, so the parsed buffer is the honest
 * "content painted" signal. `SWITCH_COMPLETE_BUDGET_MS` (1s) is deliberately
 * loose against the gate's own ~300ms budget so it fails only on a genuine
 * hang, not on ordinary localhost jitter.
 *
 * The second test covers the persistent-terminal invariants on the same rig:
 * the tile grid is keyed by server (a same-server switch re-renders the
 * mounted grid rather than remounting it), so the `.xterm` DOM node must be
 * identical across a same-session sidebar switch, and the same-session ride's
 * deferred buffer clear must never present an empty surface — the old
 * window's content stays on screen until the incoming redraw paints in the
 * same frame. Emptiness is sampled from the xterm BUFFER via
 * `window.__rkTerminals` (~50ms poll across the switch; WebGL paints no DOM
 * text layer, so the buffer is the only honest read), counting a violation
 * only on two CONSECUTIVE blank samples so the one-macrotask gap between the
 * clear and the deferred write's parse can never false-positive.
 */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { gotoServerReady, resolveWindow, READY_TIMEOUT } from "./_ready";
import { TMUX_SERVER, createSession, killSession, newWindow } from "./_tmux";

const TEST_SESSION = `e2e-switch-transition-${Date.now()}`;

// The animated switch must complete (incoming content painted) comfortably
// under this bound. The gate's own budget is ~300ms; a healthy receipt-time
// release lands the redraw well inside that. This bound is deliberately loose
// so it fails only on a genuine hang (a systematic freeze), not on ordinary
// localhost timing jitter.
const SWITCH_COMPLETE_BUDGET_MS = 1_000;

/**
 * Resolve a window's stable tmux id (`@N`) from the backend snapshot by its
 * (transient) display name. The terminal route is keyed by window id, and the
 * test-only `window.__rkTerminals` registry (dev/e2e builds only) is keyed by
 * it too. Delegates to the shared `_ready.resolveWindow` poll.
 */
async function resolveWindowId(page: Page, windowName: string): Promise<string> {
  return (await resolveWindow(page, TMUX_SERVER, TEST_SESSION, windowName)).windowId;
}

/** True once the incoming window's marker text is present in its xterm buffer. */
async function markerVisible(
  page: Page,
  windowId: string,
  marker: string,
): Promise<boolean> {
  return page.evaluate(
    ({ windowId, marker }) => {
      const term = window.__rkTerminals?.[windowId];
      if (!term) return false;
      const buf = term.buffer.active;
      // Scan the whole viewport — the marker was echoed before the switch, so
      // the incoming redraw repaints it somewhere on screen.
      for (let y = 0; y < buf.length; y++) {
        if ((buf.getLine(y)?.translateToString(true) ?? "").includes(marker)) {
          return true;
        }
      }
      return false;
    },
    { windowId, marker },
  );
}

test.describe("Window-switch slide transition (animated path)", () => {
  // Opt this file back into motion — the config-wide default disables the
  // transition, so only here do we exercise the real
  // `document.startViewTransition` path. `reducedMotion` is not a top-level
  // `use` fixture in this Playwright version (it only reaches the browser
  // context via `contextOptions`, which is spread into the context options),
  // so set it there — the type-valid channel.
  test.use({ contextOptions: { reducedMotion: "no-preference" } });

  test.beforeAll(() => {
    createSession(TEST_SESSION);
  });

  test.afterAll(() => {
    killSession(TEST_SESSION);
  });

  /**
   * Proves: a same-session window switch driven through the sidebar (the
   * `navigateToWindow` seam that wraps the body in
   * `document.startViewTransition`) completes — the incoming window's content
   * becomes visible and the transition tears down — well under 1s. A gate
   * that never releases, or a UA group animation that holds
   * `transition.finished` open past the slide, would freeze the switch and
   * blow past the bound. It also proves the confirmation-gated-motion
   * anti-stuck-mask invariant: the pending `LogoSpinner` mask is never left
   * stuck once the switch settles — SSE confirmation and any late incoming
   * write lift it.
   *
   * Steps:
   * 1. Create two windows `xa-<ts>` and `xb-<ts>` in the shared session and
   *    `send-keys "echo <marker>" Enter` a distinct letter-only marker into
   *    each, so each pane carries unambiguous content that the incoming
   *    redraw repaints.
   * 2. Navigate to `/${TMUX_SERVER}` (`gotoServerReady`) so the sidebar is
   *    populated; `resolveWindowId` both windows to their `@id`s.
   * 3. Deep-link into window A's terminal (`/${TMUX_SERVER}/<idA>`) so there
   *    is an OUTGOING window in view — the gate requires one (a first switch
   *    with no outgoing window is an instant switch, not the animated path
   *    under test).
   * 4. Wait for `.xterm-screen` visible, A's terminal registered, and A's
   *    marker painted — the switch must start from a real, populated outgoing
   *    terminal.
   * 5. Assert `document.startViewTransition` is a function (View Transitions
   *    support). Playwright's Desktop Chrome has it; asserting makes a runner
   *    that silently lacks it fail loudly rather than pass on the instant
   *    fallback.
   * 6. Click window B's sidebar row button (the `navigateToWindow` seam) and
   *    start a wall clock.
   * 7. Assert B's row becomes `aria-current="page"` — the switch was
   *    accepted.
   * 8. Assert B's marker becomes visible in `__rkTerminals[idB]`'s buffer
   *    within `SWITCH_COMPLETE_BUDGET_MS`, and that the measured elapsed time
   *    is under the budget — the core anti-freeze guard.
   * 9. Assert the `data-window-switch-direction` attribute the wrapper set on
   *    `<html>` is cleared within the budget — the transition's lifetime
   *    (pointer-dead window, `transition.finished`) settles on the slide's
   *    timeline.
   * 10. Poll `.rk-window-switch-mask` to count 0 within the budget — the
   *     pending mask is NOT stuck once the switch settles. On a healthy
   *     switch the gate releases fast and the mask never arms; if localhost
   *     timing pushes the first confirmed write past the ~300ms budget the
   *     mask may briefly arm, but SSE confirmation (the `aria-current` in
   *     step 7) and any late incoming write MUST lift it. A regression that
   *     never lifts the mask (the stuck-mask class of bug) leaves it present
   *     and fails.
   */
  test("a same-session animated switch completes within a sane latency bound", async ({
    page,
  }) => {
    const ts = Date.now();
    const winA = `xa-${ts}`;
    const winB = `xb-${ts}`;
    // Distinct, letter-only markers so each window's content is unambiguous in
    // the xterm buffer. `echo`ing them leaves the text on each pane, so the
    // incoming redraw repaints the target's marker after the switch.
    const markerA = `MARKERAAA${ts}`;
    const markerB = `MARKERBBB${ts}`;

    // Two named windows in the shared session, each carrying its own marker.
    newWindow(TEST_SESSION, winA);
    execFileSync(
      "tmux",
      ["-L", TMUX_SERVER, "send-keys", "-t", `${TEST_SESSION}:${winA}`, `echo ${markerA}`, "Enter"],
      { stdio: "ignore" },
    );
    newWindow(TEST_SESSION, winB);
    execFileSync(
      "tmux",
      ["-L", TMUX_SERVER, "send-keys", "-t", `${TEST_SESSION}:${winB}`, `echo ${markerB}`, "Enter"],
      { stdio: "ignore" },
    );

    // Land on the server root so the sidebar is populated, then resolve both
    // windows' stable ids.
    const sidebar = await gotoServerReady(page, TMUX_SERVER);
    const idA = await resolveWindowId(page, winA);
    const idB = await resolveWindowId(page, winB);

    // Deep-link into window A's terminal so there IS an outgoing window in view
    // — the R2 gate requires one (a first switch with no outgoing window is an
    // instant switch, which is not the path under test).
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(idA)}`);
    await expect(page.locator(".xterm-screen")).toBeVisible({
      timeout: READY_TIMEOUT,
    });
    // Wait until A's terminal is registered and its marker has painted, so the
    // switch below starts from a real, populated outgoing terminal.
    await expect
      .poll(() => markerVisible(page, idA, markerA), { timeout: READY_TIMEOUT })
      .toBe(true);

    // The animated path only runs when the browser supports View Transitions.
    // Playwright's Desktop Chrome does; assert it so a runner that silently
    // lacks it fails loudly rather than passing on the instant fallback (which
    // this spec is NOT meant to cover).
    const vtSupported = await page.evaluate(
      () => typeof document.startViewTransition === "function",
    );
    expect(
      vtSupported,
      "expected View Transitions support — this spec covers the animated path",
    ).toBe(true);

    // The B row's button is the same-server switch seam that routes through
    // `navigateToWindow` (the wrapper that runs the transition), identical to a
    // real sidebar click.
    const buttonB = sidebar
      .locator(`[data-window-id="${idB}"]`)
      .getByRole("button")
      .first();
    await expect(buttonB).toBeVisible({ timeout: READY_TIMEOUT });

    // Fire the switch and clock it until B's content is painted in B's terminal.
    const t0 = Date.now();
    await buttonB.click();

    // Selection settles on B — the switch was accepted.
    await expect(buttonB).toHaveAttribute("aria-current", "page", {
      timeout: READY_TIMEOUT,
    });

    // The core assertion: B's marker becomes visible (the incoming content
    // painted) within the sane bound. A gate that never releases would freeze
    // the transition and blow past this.
    await expect
      .poll(() => markerVisible(page, idB, markerB), {
        timeout: SWITCH_COMPLETE_BUDGET_MS,
      })
      .toBe(true);
    const elapsed = Date.now() - t0;
    expect(
      elapsed,
      `animated switch took ${elapsed}ms (budget ${SWITCH_COMPLETE_BUDGET_MS}ms) — a systematic gate-timeout freeze regression`,
    ).toBeLessThan(SWITCH_COMPLETE_BUDGET_MS);

    // And the transition tears down: the direction attribute the wrapper set on
    // <html> is cleared once the (latest) transition finishes. If a UA group
    // animation held `transition.finished` open past the slide, this would lag;
    // asserting it clears within the bound guards the transition's LIFETIME
    // (not just its visuals) — the T007 group-animation neutralization.
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.documentElement.dataset.windowSwitchDirection ?? null,
          ),
        { timeout: SWITCH_COMPLETE_BUDGET_MS },
      )
      .toBeNull();

    // Confirmation-gated motion (260715-38kg): the pending LogoSpinner mask
    // (`.rk-window-switch-mask`) must NOT be stuck once the switch has settled.
    // On a healthy switch the gate releases fast and the mask never arms; if
    // localhost timing pushes the first confirmed write past the ~300ms budget
    // the mask may briefly arm, but SSE confirmation (the `aria-current` above)
    // — and any late incoming write — MUST lift it. A regression that never
    // lifts the mask (the stuck-mask class of bug) would leave it present here.
    // Poll (not an instant assert) so a brief legitimate flash isn't flaky.
    await expect(page.locator(".rk-window-switch-mask")).toHaveCount(0, {
      timeout: SWITCH_COMPLETE_BUDGET_MS,
    });
  });

  /**
   * Proves: a same-session sidebar switch keeps the terminal MOUNTED — the
   * `.xterm` element is the SAME DOM node before and after (the server-keyed
   * grid re-renders instead of remounting, so the relay's same-session ride
   * applies and no fresh attach blanks the pane) — and the terminal surface
   * is never empty during the switch: the old window's content persists until
   * the incoming window's redraw paints, which lands well under 1s.
   *
   * Steps:
   * 1. Create two windows `persist-a-<ts>` / `persist-b-<ts>` in the shared
   *    session and `send-keys "echo <marker>" Enter` a distinct marker into
   *    each, so each pane carries unambiguous content.
   * 2. Navigate to `/${TMUX_SERVER}` (`gotoServerReady`) so the sidebar is
   *    populated; `resolveWindowId` both windows to their `@id`s.
   * 3. Deep-link into window A's terminal and wait for A's marker to paint,
   *    so the switch starts from a real, populated outgoing terminal.
   * 4. Capture the `.xterm` element handle (the outgoing terminal's node).
   * 5. Arm an in-page requestAnimationFrame probe of the xterm buffer's
   *    viewport text (via `window.__rkTerminals`, whichever of the two ids
   *    the persisted terminal is currently keyed under — WebGL paints no DOM
   *    text layer) that records the longest run of consecutive blank frames,
   *    then click window B's sidebar row.
   * 6. Wait for B's marker in `__rkTerminals[idB]`'s buffer within
   *    `SWITCH_COMPLETE_BUDGET_MS` — the incoming content painted.
   * 7. Stop the probe and assert at most ONE blank frame was ever observed —
   *    the deferred clear wipes and the first chunk repaints within a task,
   *    so two consecutive blank frames would be a visible flicker.
   * 8. Assert the `.xterm` handle after the switch IS the pre-switch node —
   *    the terminal (xterm instance, stream, scrollback) survived.
   */
  test("a same-session switch keeps the .xterm node and never shows an empty surface", async ({
    page,
  }) => {
    // Two full preamble passes (deep-link paint + switch) don't fit the
    // config's 10s local default; 30s is the established per-test override.
    test.setTimeout(30_000);
    const ts = Date.now();
    const winA = `persist-a-${ts}`;
    const winB = `persist-b-${ts}`;
    const markerA = `PERSISTAAA${ts}`;
    const markerB = `PERSISTBBB${ts}`;

    newWindow(TEST_SESSION, winA);
    execFileSync(
      "tmux",
      ["-L", TMUX_SERVER, "send-keys", "-t", `${TEST_SESSION}:${winA}`, `echo ${markerA}`, "Enter"],
      { stdio: "ignore" },
    );
    newWindow(TEST_SESSION, winB);
    execFileSync(
      "tmux",
      ["-L", TMUX_SERVER, "send-keys", "-t", `${TEST_SESSION}:${winB}`, `echo ${markerB}`, "Enter"],
      { stdio: "ignore" },
    );

    const sidebar = await gotoServerReady(page, TMUX_SERVER);
    const idA = await resolveWindowId(page, winA);
    const idB = await resolveWindowId(page, winB);

    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(idA)}`);
    await expect(page.locator(".xterm-screen")).toBeVisible({
      timeout: READY_TIMEOUT,
    });
    await expect
      .poll(() => markerVisible(page, idA, markerA), { timeout: READY_TIMEOUT })
      .toBe(true);

    // The outgoing terminal's DOM node — the identity under test.
    const xtermBefore = await page.locator(".xterm").elementHandle();
    if (!xtermBefore) throw new Error("expected a mounted .xterm before the switch");

    // Sample the terminal on EVERY animation frame across the switch, in-page
    // (a requestAnimationFrame loop — no cross-process poll interval to hide a
    // frame in). The probe reads the xterm buffer of whichever id currently
    // keys the persisted terminal (the registry re-keys A → B on the ride); a
    // missing terminal counts as blank. It records the longest run of
    // consecutive blank frames and resolves when the test dispatches the stop
    // event. The deferred clear wipes the buffer synchronously and the first
    // post-switch chunk parses in the same or the next task, so the invariant
    // under test allows at most ONE blank frame; two consecutive blank frames
    // is a visible flicker.
    const surfaceProbe = page.evaluate(
      (ids) =>
        new Promise<{ maxBlankStreak: number; frames: number }>((resolve) => {
          let streak = 0;
          let maxBlankStreak = 0;
          let frames = 0;
          let running = true;
          const isBlank = () => {
            const reg = window.__rkTerminals ?? {};
            const term = ids.map((id) => reg[id]).find((t) => t !== undefined);
            if (!term) return true;
            const buf = term.buffer.active;
            for (let y = buf.viewportY; y < buf.viewportY + term.rows; y++) {
              const line = buf.getLine(y)?.translateToString(true) ?? "";
              if (line.trim().length > 0) return false;
            }
            return true;
          };
          const tick = () => {
            if (!running) return;
            frames += 1;
            streak = isBlank() ? streak + 1 : 0;
            if (streak > maxBlankStreak) maxBlankStreak = streak;
            requestAnimationFrame(tick);
          };
          window.addEventListener(
            "rk-e2e:surface-probe-stop",
            () => {
              running = false;
              resolve({ maxBlankStreak, frames });
            },
            { once: true },
          );
          requestAnimationFrame(tick);
        }),
      [idA, idB],
    );

    const buttonB = sidebar
      .locator(`[data-window-id="${idB}"]`)
      .getByRole("button")
      .first();
    await expect(buttonB).toBeVisible({ timeout: READY_TIMEOUT });
    await buttonB.click();
    await expect(buttonB).toHaveAttribute("aria-current", "page", {
      timeout: READY_TIMEOUT,
    });

    // The incoming window's content paints well under the budget.
    await expect
      .poll(() => markerVisible(page, idB, markerB), {
        timeout: SWITCH_COMPLETE_BUDGET_MS,
      })
      .toBe(true);

    await page.evaluate(() => {
      window.dispatchEvent(new Event("rk-e2e:surface-probe-stop"));
    });
    const probe = await surfaceProbe;
    expect(probe.frames, "the frame probe never ran").toBeGreaterThan(0);
    expect(
      probe.maxBlankStreak,
      "the terminal surface was blank for two or more consecutive frames during the switch — the persistent-terminal invariant is broken",
    ).toBeLessThanOrEqual(1);

    // The terminal node survived the switch (no remount).
    const xtermAfter = await page.locator(".xterm").elementHandle();
    if (!xtermAfter) throw new Error("expected a mounted .xterm after the switch");
    const sameNode = await page.evaluate(
      ({ a, b }) => a === b,
      { a: xtermBefore, b: xtermAfter },
    );
    expect(
      sameNode,
      "the .xterm element was remounted by a same-session switch — the grid must key on the server, not the window",
    ).toBe(true);
  });
});
