# Plan: Forward trackpad pinch to the GUI guest under keyboard capture

**Change**: 261124-k97s-gui-pinch-zoom-to-guest
**Intake**: `intake.md`

## Requirements

### GUI tile: pinch routing under keyboard capture

#### R1: A captured ctrl-wheel reaches the guest as Ctrl+scroll
While the `rk-gui-capture` latch is set, the gui tile's capture-phase wheel listener (`app/frontend/src/components/gui-surface.tsx`) MUST NOT stop the propagation of a wheel event carrying `ctrlKey`, and MUST NOT step the `rk-gui-zoom` ladder for it. The event SHALL continue to noVNC's canvas wheel handler, which sends the scroll buttons. The tile MUST still call `preventDefault` on it: noVNC prevents the browser's page zoom only while connected, not view-only, and with the pointer over the canvas, and its handler ignores `defaultPrevented`. <!-- rework: page-zoom regression over letterbox/overlays/connecting/mirror --> Before letting it through, the tile SHALL press `Control_L` in the guest (`rfb.sendKey(KEYSYM_CONTROL_L, "ControlLeft", true)`) unless Control is already down in the guest (R3), so the guest receives Control_L down, scroll buttons, Control_L up.

- **GIVEN** a Mac viewer, the gui tile focused, capture latched
- **WHEN** the user pinches on the trackpad (Chromium: `wheel` events with `ctrlKey: true`)
- **THEN** `onZoomChange` is not called, the event reaches the noVNC canvas subtree with `defaultPrevented` set, and `sendKey(0xffe3, "ControlLeft", true)` is sent once for the gesture

#### R2: The pinch's Control_L is released when the gesture ends or the tile lets go
The Control_L pressed for a pinch SHALL be released (`sendKey(KEYSYM_CONTROL_L, "ControlLeft", false)`) `PINCH_CTRL_RELEASE_MS` (150 ms) after the last ctrl-wheel event of the gesture; each further ctrl-wheel restarts the timer. It SHALL also be released, with the timer cleared, on every path that already releases a captured ⌘: the wrapper losing focus, the capture latch turning off, and teardown/unmount. It is tracked in the existing `heldRef` map, so `releaseHeld` covers those paths.

- **GIVEN** a pinch in progress under capture (Control_L held by rk)
- **WHEN** 150 ms pass with no further ctrl-wheel
- **THEN** exactly one `sendKey(0xffe3, "ControlLeft", false)` is sent
- **AND** if focus leaves the wrapper or capture turns off before then, Control_L is released at that moment and the timer sends nothing later

#### R3: No Control press or release when Control is already down in the guest
The pinch wrap SHALL be skipped (the event still passes through to noVNC, with no `sendKey` from rk) when Control is already down in the guest: a captured ⌘ on a Mac (`heldRef` holds `ControlLeft`), or a physical `ControlLeft`/`ControlRight` the user is holding (tracked from the wrapper's `onKeyDownCapture`/`onKeyUpCapture`, and cleared on blur).

- **GIVEN** capture latched and the user holding ⌘ (Mac) or a physical Ctrl key
- **WHEN** they scroll or pinch
- **THEN** the wheel reaches noVNC and rk sends no Control_L down or up for it

#### R4: Capture released keeps viewer zoom unchanged
With capture released, a ctrl-wheel SHALL behave exactly as before: swallowed in the capture phase and stepping the `rk-gui-zoom` ladder. A wheel without Ctrl SHALL pass to noVNC untouched in both postures.

- **GIVEN** capture released
- **WHEN** the user pinches
- **THEN** the viewer zoom steps and the event never reaches the noVNC subtree

#### R5: Spec records the capture-latched pinch
`docs/specs/gui.md` § Zoom, pointer modes, and the key bar SHALL state that while keyboard capture is latched, a fine-pointer Ctrl+wheel (trackpad pinch) is forwarded to the guest as Control_L + scroll buttons, and the viewer zoom stays reachable through the `GUI: Zoom …` palette rows and the tile header's zoom control.

- **GIVEN** a reader of the spec's zoom paragraph
- **WHEN** they look up what a pinch does
- **THEN** both postures (released → viewer zoom; latched → guest Ctrl+scroll) are described

#### R6: A key pressed mid-pinch releases the pinch's Control first
While the pinch owns its Control_L (within the 150 ms window), any keydown on the wrapper other than ⌘ (which takes the Control_L over, R3) SHALL first release it (`sendKey(KEYSYM_CONTROL_L, "ControlLeft", false)`) and drop it from `heldRef`, before noVNC forwards the key. Then a physical Control (left or right) re-presses it through noVNC, an ordinary key never lands as Ctrl+key, and the ⌘V clipboard and ⌘-Shift paths never read the pinch's Control as a held ⌘. <!-- rework: stuck Control_L on ControlRight / unseen Control; shared heldRef key -->

- **GIVEN** a pinch under capture whose Control_L rk still holds
- **WHEN** the user presses ControlRight, ControlLeft, V, or any other non-⌘ key
- **THEN** rk sends Control_L up before the key reaches noVNC, and the timer sends nothing later

### Non-Goals

- Safari `gesturestart`/`gesturechange` pinch: the gui tile has no gesture listener; Safari support is a separate change.
- Coarse-pointer `touch`/`trackpad` modes: `touch` already forwards pinch through noVNC's gesture handler, and `trackpad`'s pinch steps the ladder by design.
- A pinch-to-guest toggle independent of capture (intake option C).
- Backend relay or desktop-shell changes: the unix relay forwards bytes verbatim; the shell runs the same SPA path.

### Design Decisions

#### Pinch-to-guest rides the keyboard-capture latch
**Decision**: a fine-pointer ctrl-wheel goes to the guest only while `rk-gui-capture` is latched; released, it steps the viewer zoom.
**Why**: capture already means "my input goes to the guest, not rk"; reusing it adds no posture key, palette row or setting, and the viewer zoom keeps its gesture when capture is off.
**Rejected**: always forwarding the pinch (the viewer zoom would lose its gesture); a separate per-viewer toggle (more surface for the same effect).
*Introduced by*: 261124-k97s-gui-pinch-zoom-to-guest

#### Control_L wrap with an idle-debounced release; noVNC sends the scroll
**Decision**: rk sends only Control_L down (first ctrl-wheel of a gesture) and Control_L up (150 ms idle, or blur/unlatch/teardown); the scroll buttons come from noVNC's own `_handleWheel`.
**Why**: RFB has no gesture message, and Ctrl+scroll is the Linux zoom convention (noVNC's touch pinch emits the same sequence). noVNC stops the wheel's propagation, so nothing runs after it in the same dispatch; a per-event down/up would flood the wire. noVNC exposes no public pointer-send API.
**Rejected**: sending PointerEvents from rk (private API, duplicate accumulation); a Control down/up per wheel event.
*Introduced by*: 261124-k97s-gui-pinch-zoom-to-guest

## Tasks

### Phase 2: Core Implementation

- [x] T001 In `app/frontend/src/components/gui-surface.tsx`, branch the Ctrl+wheel effect on `captureRef.current`: latched → no swallow and no zoom step; press Control_L into `heldRef` when neither `heldRef` holds `ControlLeft` nor a physical Control is down, and (re)arm a `PINCH_CTRL_RELEASE_MS = 150` timer that releases it. Update the file-header "Zoom badge + wheel" / "Chord gate" bullets <!-- R1 -->
- [x] T002 In `app/frontend/src/components/gui-surface.tsx`, add physical-Control tracking (a ref set of `ControlLeft`/`ControlRight` codes) in `onKeyDownCapture`/`onKeyUpCapture`, cleared on blur. Clear the pinch timer wherever `releaseHeld` runs (blur, the `[capture]` effect, teardown) and on unmount <!-- R2 -->

### Phase 3: Integration & Edge Cases

- [x] T003 Add unit tests in `app/frontend/src/components/gui-surface.test.tsx` (`describe("GuiSurface — pinch under capture")`): latched ctrl-wheel passes to the subtree with no zoom change and one Control_L down; release after 150 ms (fake timers); a continuing gesture sends no second down; no wrap while ⌘ is held (Mac) or a physical Ctrl is down; blur and capture-off release early with no later timer send; released posture unchanged <!-- R3 -->
- [x] T004 Add an e2e case to `app/frontend/tests/e2e/gui-keyboard-capture.spec.ts` (Proves/Steps intent block): with capture latched, a ctrl-wheel on the canvas reaches the canvas probe and no zoom badge appears; released, the badge appears <!-- R4 --> <!-- not run: this box has no Go toolchain, so the e2e rig (air + go backend) cannot start -->

- [x] T006 In `app/frontend/src/components/gui-surface.tsx`, call `preventDefault` in the captured wheel branch and, in `onKeyDownCapture`, release the pinch-owned Control_L (send up + drop from `heldRef`) on any non-⌘ keydown; update the unit tests (prevented pinch, ControlRight/ControlLeft/ordinary key mid-pinch release once), the spec sentence order, and the e2e file header + intent steps <!-- R6 -->

### Phase 4: Polish

- [x] T005 Amend `docs/specs/gui.md` § Zoom, pointer modes, and the key bar with the capture-latched pinch sentence <!-- R5 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: Under capture a ctrl-wheel is default-prevented but not stopped by the wrapper, `onZoomChange` is not called, and one `sendKey(0xffe3, "ControlLeft", true)` is sent per gesture
- [x] A-002 R2: Control_L up is sent exactly once, 150 ms after the last ctrl-wheel, or immediately on blur/capture-off/unmount, never twice
- [x] A-003 R3: No rk `sendKey` for a pinch while `heldRef` holds ControlLeft or a physical Control is down
- [x] A-004 R4: With capture released, the existing Ctrl+wheel zoom tests pass unchanged
- [x] A-005 R5: `docs/specs/gui.md` describes both pinch postures

### Scenario Coverage

- [x] A-006 R1: The unit suite covers the latched pass-through, single press, and debounced release
- [x] A-007 R4: The e2e suite shows latched → no zoom badge (event reaches the canvas) and released → zoom badge <!-- verified by inspection only: not executed, this machine has no Go toolchain so the e2e rig cannot start -->

### Edge Cases & Error Handling

- [x] A-015 R6: A non-⌘ keydown while the pinch owns Control_L sends exactly one Control_L up before the key, and the timer then sends nothing

- [x] A-008 R2: A pinch with no live RFB sends nothing and does not throw; the timer never fires after unmount
- [x] A-009 R3: Releasing ⌘ mid-pinch does not leave Control_L stuck (the ⌘ keyup path or the timer releases it)

### Code Quality

- [x] A-010 Pattern consistency: the pinch hold reuses `heldRef`/`releaseHeld` and the existing capture-phase listener rather than a parallel mechanism
- [x] A-011 No unnecessary duplication: keysyms come from `lib/gui-keysyms.ts`; no new posture key or setting
- [x] A-012 No magic numbers: the 150 ms release is a named constant
- [x] A-013 Comments state constraints only (why noVNC needs the Ctrl wrap, why the debounce), with no narration or change IDs
- [x] A-014 New Playwright `test()` blocks carry the Proves/Steps intent comment

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Release delay 150 ms after the last ctrl-wheel | Chromium pinch events arrive every ~16 ms; 150 ms spans frame gaps without making Ctrl linger after the gesture | S:55 R:90 A:75 D:65 |
| 2 | Confident | Track the pinch's Control in the existing `heldRef` under `ControlLeft` | Reuses every existing release path; the ⌘ hold uses the same key, and the R3 skip guarantees the two never overlap | S:60 R:85 A:80 D:70 |
| 3 | Confident | Track physical Ctrl from the wrapper's capture-phase key handlers | noVNC's key-down list is private; the wrapper already sees every key before noVNC | S:55 R:85 A:70 D:60 |
| 4 | Confident | e2e asserts on the mocked rig (canvas probe + zoom badge), not a live Xvnc | The capture spec is fully mocked by design; guest-side zoom is shown by the `just demo` recording | S:60 R:85 A:75 D:70 |

4 assumptions (0 certain, 4 confident, 0 tentative).
