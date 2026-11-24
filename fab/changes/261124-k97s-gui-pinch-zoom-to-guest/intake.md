# Intake: Forward trackpad pinch to the GUI guest under keyboard capture

**Change**: 261124-k97s-gui-pinch-zoom-to-guest
**Created**: 2026-11-24

## Origin

Conversational. After a `/fab-discuss` deep dive into how keyboard events travel from a Mac viewer to the Linux GUI guest, the user asked:

> Currently I think keyboard events are sent but from a Mac there are mouse events as well, wherein I can pinch in to zoom in or zoom out, right? … currently it's not happening so I'm not able to zoom in or zoom out from my Mac to Linux. Can you add that as well? … Can you have a look at it, at how that is possible?

The agent traced the path and proposed three routings for the pinch (A: to the guest only while keyboard capture is latched; B: always to the guest; C: a new per-viewer toggle), recommending A. The user then ran `/fab-new` without further comment, read as acceptance of A.

## Why

**Problem.** On a fine-pointer viewer (a Mac browser or the Electron desktop shell), a trackpad pinch never reaches the Linux guest. Chromium reports a pinch as a `wheel` event with a synthetic `ctrlKey: true` (no real Control keydown). The gui tile's capture-phase non-passive wheel listener (`gui-surface.tsx`, the "Ctrl+wheel zoom" effect) swallows EVERY ctrl-wheel (`preventDefault` + `stopPropagation`) and steps the viewer's own `rk-gui-zoom` ladder. So noVNC never sees the event and the guest gets nothing.

**How the guest could zoom.** RFB has no gesture message: client→server input is KeyEvent and PointerEvent (buttons 1–8; scroll = buttons 4/5/6/7). The Linux convention is Ctrl+scroll = zoom (Chromium/Firefox, image viewers, editors, LibreOffice), and noVNC already uses it for touch pinch (`core/rfb.js` `_handleGesture` 'pinch': `XK_Control_L` down, button 4/5 clicks, `XK_Control_L` up). A fine-pointer pinch can't use that path: the synthetic `ctrlKey` never produced a Control keydown, so even a passed-through wheel would reach the guest as a plain scroll.

**If not fixed.** Mac users cannot zoom web pages, images or documents in the guest with the gesture they use everywhere else. The only workaround is typing Ctrl+= in each app (under capture), which many apps (image viewers, maps) don't bind.

**Why this approach (A).** Keyboard capture (`rk-gui-capture`, ⌘⇧G / Ctrl+Shift+G) already means "my input goes to Linux, not to rk". Routing the pinch by the same latch keeps one mental model and needs no new posture key, palette row or setting. With capture off, the pinch keeps today's viewer-zoom behavior, so the zoom ladder loses nothing.

## What Changes

### Pinch routing in the gui tile's wheel listener (`app/frontend/src/components/gui-surface.tsx`)

The existing capture-phase wheel effect gains a capture branch:

- **Capture released** (today's behavior, unchanged): a ctrl-wheel is swallowed and steps the `rk-gui-zoom` ladder via `createWheelAccumulator` + `stepGuiZoom`. A wheel without Ctrl passes to noVNC untouched.
- **Capture latched**: a ctrl-wheel is NOT swallowed by rk. It continues to noVNC's canvas `wheel` handler, which already accumulates deltas (WHEEL_STEP 50) and sends button 4/5 (or 6/7) press+release PointerEvents at the pointer position, and which itself calls `preventDefault`, so browser page zoom never fires. Before letting it through, rk presses `Control_L` in the guest (`rfb.sendKey(KEYSYM_CONTROL_L, "ControlLeft", true)`) when the guest does not already have Control held, then releases it after the gesture goes idle: a debounce timer (~150 ms after the last ctrl-wheel event) sends `Control_L` up. The guest therefore receives Control_L down, scroll clicks, Control_L up: Ctrl+scroll, the same sequence noVNC emits for a touch pinch.

The held Control joins the existing `heldRef` map (`HeldKeys`, code → keysym), so the release paths that exist for a captured ⌘ cover it with no new code: `onBlur` (focus leaves the wrapper), the `[capture]` effect (unlatch), and teardown all call `releaseHeld`. The debounce timer is cleared on those paths and on unmount.

**Skip the wrap when Control is already down in the guest:**
- A captured ⌘ on a Mac is already held as `Control_L` (`heldRef.has("ControlLeft")`). A ⌘+scroll already reaches the guest as Ctrl+scroll today (the wheel carries `metaKey`, not `ctrlKey`, so the zoom listener ignores it). No change is needed there.
- A physical Control key held by the user (any platform) was already forwarded by noVNC as a keydown. rk tracks physical `ControlLeft`/`ControlRight` keydown/keyup in the wrapper's existing `onKeyDownCapture`/`onKeyUpCapture` and wraps only when no physical Control is down, so it never sends a Control_L up while the user still holds Control.

### Unchanged

- The coarse-pointer paths (`touch` mode already forwards pinch as Ctrl+wheel through noVNC's gesture handler; `trackpad` mode's pinch steps the ladder). This change is fine-pointer wheel only.
- The zoom chords Ctrl+= / Ctrl+- / Ctrl+0 and the `GUI: Zoom …` palette rows. Under capture these chords already pass to the guest (only the release chord is reclaimed); the palette rows and the zoom control in the tile header still step the viewer zoom under capture.
- The backend relay: on the unix (Linux) backend `gui_filter.go` runs in observe mode and forwards every byte. On the macOS screen-sharing mirror it drops PointerEvent/KeyEvent, so a captured pinch there is inert, like every other captured input.
- Safari: it reports a pinch as `gesturestart`/`gesturechange` (a scale ratio), not ctrl-wheel, and the gui tile has no gesture listener. Out of scope.

### Spec (`docs/specs/gui.md` § Zoom, pointer modes, and the key bar)

Amend the "Ctrl+wheel (a mac trackpad pinch arrives as Ctrl+wheel and rides the same path) — step the ladder" sentence: while keyboard capture is latched, a fine-pointer Ctrl+wheel/pinch is forwarded to the guest as Control_L + scroll buttons (the guest app zooms), and the viewer zoom stays reachable through the palette rows and the header control.

### Tests

- **Unit** (`app/frontend/src/components/gui-surface.test.tsx`): with capture released, a ctrl-wheel steps the zoom (existing coverage stays green). With capture latched, a ctrl-wheel does not call `onZoomChange`, is not stopped by the wrapper, and produces `sendKey(Control_L, "ControlLeft", true)` once per gesture, then one `false` after the idle timeout (fake timers). No wrap while `heldRef` holds ControlLeft or while a physical Control is down. Blur mid-gesture releases Control.
- **e2e** (`app/frontend/tests/e2e/gui-keyboard-capture.spec.ts`, the mocked rig): with capture latched, a ctrl-wheel on the canvas reaches the noVNC canvas probe and the zoom badge does not appear; with capture released, the badge appears (viewer zoom). Each new `test()` carries the Proves/Steps intent block (Constitution § Test Intent Comments).
- **PR evidence**: a `just demo` recording (web lane, desktop viewport; the pinch path is fine-pointer only, so mobile is exempt with a stated reason). A real-Xvnc demo that pinches over a guest browser page with capture on shows the page zooming; before/after via `--before`. The shell lane uses the same SPA code path (no `app/desktop/src/` change), so a web-lane recording suffices unless the shell is observed to deliver pinch differently.

## Affected Memory

- `run-kit/ui/lenses-and-layout`: (modify) the "Pan, and the zoom chords" / Ctrl+wheel paragraph — the capture-latched pinch forward (Control_L wrap, idle release, skip-when-held) and its release paths
- `run-kit/gui`: (modify) the "Keyboard capture hands the gui chords to the guest" requirement — add the pinch-forward scenario under the latch

## Impact

- `app/frontend/src/components/gui-surface.tsx`: the wheel effect (~15–25 lines), the key capture handlers (physical-Ctrl tracking), the timer cleanup.
- `app/frontend/src/components/gui-surface.test.tsx`, `app/frontend/tests/e2e/gui-keyboard-capture.spec.ts`, a new or extended `app/frontend/tests/demo/` spec.
- `docs/specs/gui.md` (one paragraph).
- No backend, desktop-shell, API, or settings change. No new posture key.

## Open Questions

- None blocking. If later wanted, a pinch-to-guest toggle independent of capture (option C) can layer on without reworking this.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Route the pinch to the guest only while keyboard capture (`rk-gui-capture`) is latched; released keeps viewer zoom (option A) | Discussed — agent recommended A over B (always to guest) and C (new toggle); user invoked /fab-new right after, read as acceptance | S:70 R:80 A:60 D:55 |
| 2 | Certain | Express the pinch to the guest as Control_L held + scroll buttons 4/5 | RFB has no gesture message; noVNC's own touch-pinch uses exactly this; Ctrl+scroll is the Linux zoom convention | S:80 R:85 A:95 D:90 |
| 3 | Confident | Let the wheel continue to noVNC's `_handleWheel` for the scroll clicks instead of sending PointerEvents from rk | noVNC already accumulates deltas and sends buttons at the pointer position, and prevents the default; RFB exposes no public pointer-send API | S:60 R:85 A:85 D:75 |
| 4 | Confident | Release Control_L on a ~150 ms idle debounce after the last ctrl-wheel, plus the existing blur/unlatch/teardown `releaseHeld` paths | noVNC stops propagation, so no post-handler hook exists in the same dispatch; a per-event down/up would flood the wire; the debounce matches gesture end | S:55 R:90 A:75 D:65 |
| 5 | Confident | Skip the wrap when Control is already down in the guest: a captured ⌘ (`heldRef` ControlLeft) or a physical Control tracked via the wrapper's key capture handlers | Avoids releasing a Control the user still holds; noVNC's key-down list is private | S:45 R:85 A:60 D:50 |
| 6 | Certain | Fine-pointer wheel only; coarse touch/trackpad modes, backend relay, and the desktop shell are unchanged; Safari gesture events are out of scope | Touch mode already forwards pinch via noVNC; the relay forwards on Linux and drops on the mirror; the shell runs the same SPA code | S:75 R:90 A:90 D:85 |
| 7 | Confident | PR evidence: web-lane `just demo` on desktop with real Xvnc (before/after); mobile exempt because the path is fine-pointer only | Constitution § PR Evidence; no `app/desktop/src/` diff | S:60 R:85 A:80 D:70 |

7 assumptions (2 certain, 5 confident, 0 tentative, 0 unresolved).
