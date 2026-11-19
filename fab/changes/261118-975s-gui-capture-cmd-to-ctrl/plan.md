# Plan: GUI Keyboard Capture Sends Mac Cmd as Ctrl

**Change**: 261118-975s-gui-capture-cmd-to-ctrl
**Intake**: `intake.md`

## Requirements

### GUI Surface: Keyboard capture on macOS

#### R1: Cmd is delivered to the guest as Control_L while captured on a Mac
While the `rk-gui-capture` latch is set AND `detectPlatform()` reports `mac`, the gui canvas wrapper SHALL intercept `keydown`/`keyup` of `MetaLeft`/`MetaRight` in the capture phase (noVNC never sees them) and SHALL send `Control_L` (`KEYSYM_CONTROL_L`, code `ControlLeft`) down/up through `rfb.sendKey` instead. Every other key MUST flow to noVNC unchanged, so noVNC's macOS meta-held press+release path delivers ⌘+key as Ctrl+key. The chord-gate reclaim check MUST run before the remap and is unchanged. Auto-repeat keydowns of Meta MUST NOT send additional Control_L presses. Uncaptured, non-Mac, and the Option/Alt key MUST keep today's behaviour (noVNC's own remap).

- **GIVEN** a Mac viewer with the gui canvas focused and capture latched
- **WHEN** the user presses ⌘, then C, then releases ⌘
- **THEN** the guest receives Control_L down, C press+release (noVNC), Control_L up — i.e. Ctrl+C
- **AND** noVNC never receives the Meta keydown/keyup

- **GIVEN** capture is NOT latched (or the platform is not mac)
- **WHEN** the user presses ⌘
- **THEN** the Meta keydown reaches noVNC unchanged (noVNC maps it to Alt_L as today)

- **GIVEN** capture latched on a Mac
- **WHEN** the user presses ⌘⇧G
- **THEN** the G keydown is still reclaimed and re-dispatched to rk (capture releases)

#### R2: An injected Control_L is never left held in the guest
When rk has sent Control_L down for a Meta press, it SHALL send the matching Control_L up when ANY of these happens before the Meta keyup reaches the wrapper: focus leaves the canvas wrapper (window blur via ⌘Tab, tab switch, click elsewhere — the focused element's `focusout`), the capture latch turns off, or the RFB is torn down (unmount / wanted-connection drop / re-dial). An RFB `disconnect` event clears the held flag without sending.

- **GIVEN** capture latched on a Mac and ⌘ held (Control_L down sent)
- **WHEN** focus leaves the canvas wrapper (e.g. ⌘Tab blurs the window)
- **THEN** Control_L up is sent exactly once and a later Meta keyup sends nothing more

- **GIVEN** ⌘ held under capture
- **WHEN** the capture latch turns off
- **THEN** Control_L up is sent

#### R3: The pinned capture verb never takes keyboard focus on click
The gui header's pinned capture verb (`data-testid="gui-capture-toggle"`) SHALL suppress the default of `mousedown` so a pointer click toggles the latch without moving DOM focus off the noVNC canvas. Keyboard activation (Tab + Enter/Space) MUST still work. No programmatic `rfb.focus()` is added.

- **GIVEN** the noVNC canvas has focus
- **WHEN** the user clicks the pinned capture verb
- **THEN** the latch toggles AND the mousedown default is prevented (focus stays on the canvas)

### Non-Goals

- Clipboard text transport between the local machine and the guest — a separate follow-up change (needs secure-context / Safari paste-event work).
- Translating Cmd while capture is off — the user chose capture-gated only.
- Remapping Option/Alt or any non-Meta modifier.
- Delivering browser-reserved chords (⌘W/⌘T/⌘N/⌘Q) — unchanged; fullscreen `keyboard.lock()` remains the only path.

### Design Decisions

#### Modifier-level Cmd→Ctrl remap under capture
**Decision**: on a Mac while captured, the canvas wrapper swaps the Meta modifier itself for Control_L via `rfb.sendKey` and leaves every other key to noVNC, whose macOS meta-held branch sends an immediate press+release — so every ⌘+key lands as Ctrl+key.
**Why**: noVNC 1.7 maps Cmd to Alt_L on macOS, so Mac copy/paste muscle memory produced Alt+letter in Linux apps even with capture on; capture is the explicit "the desktop owns the keyboard" mode, so translating there leaves the uncaptured ⌘→rk-chord arrangement untouched. Remapping the modifier reuses noVNC's existing meta-held path instead of a per-letter table.
**Rejected**: always-on translation (changes uncaptured behaviour the user did not ask to change); rewriting individual ⌘+letter chords (a table to maintain, and every unlisted chord still arrives as Alt); patching noVNC (vendored dependency).
*Introduced by*: 261118-975s-gui-capture-cmd-to-ctrl

#### Capture verb suppresses mousedown focus
**Decision**: the pinned capture verb prevents `mousedown`'s default rather than refocusing the canvas programmatically.
**Why**: keeps the "noVNC grabs focus only on click, never programmatically" invariant while ensuring the keystroke after a click on the verb still reaches the guest.
**Rejected**: calling `rfb.focus()` after toggling (a programmatic focus grab, and wrong when focus was elsewhere before the click).
*Introduced by*: 261118-975s-gui-capture-cmd-to-ctrl

## Tasks

### Phase 1: Setup

- [x] T001 Add an optional `capture?: boolean` prop to `GuiSurface` (`app/frontend/src/components/gui-surface.tsx`) and pass `capture={guiCapture}` from the `<GuiSurface>` render site in `app/frontend/src/components/surface-layout.tsx` <!-- R1 -->

### Phase 2: Core Implementation

- [x] T002 In `app/frontend/src/components/gui-surface.tsx`, add the Meta→Control_L remap to the canvas wrapper's `onKeyDownCapture` (after the reclaim branch) and a new `onKeyUpCapture`, gated on capture + `detectPlatform() === "mac"`, using `KEYSYM_CONTROL_L` from `@/lib/gui-keysyms` and a held ref; ignore `e.repeat` <!-- R1 -->
- [x] T003 In `app/frontend/src/components/gui-surface.tsx`, release a held Control_L on wrapper focusout (focus leaving the wrapper), on capture turning off, and in the RFB effect cleanup before `disconnect()`; clear the flag on the RFB `disconnect` event <!-- R2 -->
- [x] T004 [P] In `app/frontend/src/components/gui-toolbar.tsx`, add `onMouseDown={(e) => e.preventDefault()}` to the pinned capture verb <!-- R3 -->

### Phase 3: Integration & Edge Cases

- [x] T005 Tests: extend `app/frontend/src/components/gui-surface.test.tsx` (mac+capture Meta down/up → sendKey Control_L and noVNC subtree never sees Meta; repeat ignored; ⌘+C keydown still reaches the subtree; focusout and capture-off release; teardown release; uncaptured and non-mac pass Meta through; reclaim still wins) and `app/frontend/src/components/gui-toolbar.test.tsx` (capture verb mousedown is defaultPrevented); run via `just` recipes <!-- R1 R2 R3 -->

## Acceptance

### Functional Completeness

- [ ] A-001 R1: On mac + capture, Meta keydown/keyup on the canvas wrapper are stopped before the noVNC subtree and produce `sendKey(KEYSYM_CONTROL_L, "ControlLeft", true|false)`
- [ ] A-002 R2: A held Control_L is released on wrapper focusout, on capture-off, and on RFB teardown; the flag clears on RFB disconnect
- [ ] A-003 R3: The pinned capture verb prevents mousedown default and still toggles on click

### Behavioral Correctness

- [ ] A-004 R1: With capture off or a non-mac platform, Meta keydown reaches the noVNC subtree unchanged
- [ ] A-005 R1: The reclaim check still runs first — a reclaimed chord under capture is re-dispatched and never remapped

### Scenario Coverage

- [ ] A-006 R1: Unit tests cover the ⌘ press / letter passthrough / ⌘ release sequence and the uncaptured + non-mac passthrough
- [ ] A-007 R2: Unit tests cover focusout, capture-off and teardown releases, and no double release after a later Meta keyup
- [ ] A-008 R3: A gui-toolbar unit test asserts the capture verb's mousedown is defaultPrevented

### Edge Cases & Error Handling

- [ ] A-009 R1: Auto-repeat Meta keydowns send no further Control_L presses
- [ ] A-010 R2: A Meta keyup arriving after a release (or with nothing held) sends nothing and is not remapped

### Code Quality

- [ ] A-011 Pattern consistency: new code follows the surrounding gui-surface ref/effect patterns (latest-value refs, effect cleanups) and the existing `onMouseDown` preventDefault precedent
- [ ] A-012 No unnecessary duplication: reuses `detectPlatform` and `KEYSYM_CONTROL_L`; no new keysym or platform probe
- [ ] A-013 Type narrowing over assertions: no new `as` casts in production code
- [ ] A-014 Comment discipline: comments state only non-obvious constraints, with no change IDs or narration
- [ ] A-015 Tests: the changed behaviour is covered by unit tests; PR evidence follows Constitution § PR Evidence (the on-wire Mac behaviour is not recordable by `just demo` on this Linux rig — stated in the PR)

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Release on wrapper focusout instead of separate window `blur` + `visibilitychange` listeners | Window blur and tab hide both blur the focused element, firing focusout on the wrapper; also covers clicking elsewhere while ⌘ is held (same approach noVNC uses for its own key release) | S:60 R:85 A:75 D:65 |
| 2 | Certain | Reuse `KEYSYM_CONTROL_L` from lib/gui-keysyms.ts and `detectPlatform()` from lib/keybindings.ts | Existing constants/helpers; noVNC's keysym modules are unimportable | S:80 R:90 A:95 D:90 |
| 3 | Confident | `capture` is an optional prop defaulting to false | Mirrors the surface-layout `guiCapture = false` default; keeps existing test fixtures valid | S:70 R:90 A:85 D:80 |
| 4 | Confident | Release the held Control_L in the RFB effect cleanup before `disconnect()`, and only clear the flag on a `disconnect` event | sendKey on a disconnected RFB is a no-op; cleanup runs while the RFB is still live | S:60 R:85 A:80 D:75 |

4 assumptions (1 certain, 3 confident, 0 tentative).
