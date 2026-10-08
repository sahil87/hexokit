# Plan: GUI Keyboard Capture — Hand rk's Chords to the Guest Desktop

**Change**: 260912-31eg-gui-keyboard-capture
**Intake**: `intake.md`

## Requirements

### GUI Surface: Capture mode and the chord gate

#### R1: Capture-mode narrowing of the reclaim predicate
`hasReclaimableMatch` (`app/frontend/src/lib/keybindings.ts`) SHALL gain an optional fourth `captured` parameter (default `false`). When `captured` is `true` the predicate MUST narrow to the single `gui-capture-toggle` actionId — every other chord returns `false` and therefore falls through the gui canvas's capture-phase gate to noVNC and onto the RFB wire. When `captured` is absent/`false` the predicate MUST be byte-identical to today's behavior for every kind (`gui`, `code`, `web`). Nothing else in the pipeline changes: the capture-phase interceptor body, the synthetic re-dispatch, `shouldRefuseTerminalChord`, `shouldSuppressChord`, the handler map shape, and noVNC's canvas handler are all untouched.

- **GIVEN** the gui tile owns focus and keyboard capture is latched
- **WHEN** any chord other than the release binding is pressed (e.g. ⌘K, ⌘1–4, the `guiOnly` Ctrl+=/−/0 zoom trio)
- **THEN** `hasReclaimableMatch(e, bindings, "gui", true)` returns `false` and the key reaches the guest
- **AND** when capture is not latched the same chords reclaim exactly as before

#### R2: The `gui-capture-toggle` registry binding
The default binding table in `app/frontend/src/lib/keybindings.ts` SHALL gain a `gui-capture-toggle` entry beside the `guiOnly` zoom trio: `code: "KeyG"`, `tier: "shifted"` (Ctrl+Shift+G on Win/Linux, ⌘⇧G on mac — the tier derivation at `captureFromEvent`), `scope: "terminal"`, `kind: "builtin"`, `label: "Keyboard capture"`, `description: "hand every chord to the guest desktop"`, `mapLabel: "capture"`, `ignoreInputs: true`, `guiOnly: true`. Being a registry binding buys remapping (a user remap moves the escape hatch), a cheatsheet row, `withShortcutHints` decoration, and the tooltip keycap. `KeyG` is verified free in the shifted tier (no registry entry, absent from `claimedKeys`).

- **GIVEN** the default registry with no user overrides
- **WHEN** the effective bindings are resolved for either host platform
- **THEN** `gui-capture-toggle` resolves enabled on the shifted tier at `KeyG` on both platforms
- **AND** a user override onto a different chord moves both the escape hatch and every hint derived from the registry

### GUI Surface: Viewer state and dispatch wiring

#### R3: The `rk-gui-capture` posture
`app/frontend/src/lib/gui-posture.ts` SHALL gain a `rk-gui-capture` key (`"1"` = captured, absent/other = released) with `readGuiCapture()`/`writeGuiCapture(on)` following the file's validated-read / try-catch-noop-write discipline, and the header docblock MUST describe the new key like every sibling. The key is viewer-global like its siblings: latching in one browser window latches in every window for that viewer, and the latch survives a reload.

- **GIVEN** a viewer with no `rk-gui-capture` key
- **WHEN** capture is latched via any of the three activation paths
- **THEN** the key reads `"1"` and a full page reload comes back captured
- **AND** writing `false` removes the key (absent = off), and a throwing `localStorage` degrades to `false`/noop

#### R4: app.tsx state, reclaim threading, and the gated handler
`app/frontend/src/app.tsx` SHALL own a `guiCapture` state seeded from `readGuiCapture()` with a `handleGuiCaptureChange` write-through setter (the sibling-posture grammar). The captured flag MUST join `reclaimChordForKind`'s dependency array and reach the predicate only for kind `"gui"` (`kind === "gui" && guiCapture` at the call site) so the `code`/`web` reclaim paths are structurally inert. The handler map SHALL gain `"gui-capture-toggle": guiGated("gui-capture-toggle", () => handleGuiCaptureChange(!guiCapture))` beside the zoom trio, so the release chord works exactly while the gui tile owns focus.

- **GIVEN** capture latched and the gui tile focused
- **WHEN** the release chord (Ctrl+Shift+G / ⌘⇧G) is pressed
- **THEN** the narrowed predicate reclaims it, the `guiGated` handler fires, and capture releases
- **AND** with any other tile focused the handler is absent and the chord falls through untouched

### GUI Surface: Header control and indicator

#### R5: The `KeyboardGlyph`
`app/frontend/src/components/top-bar-icons.tsx` SHALL gain a `KeyboardGlyph` following the `ControlGlyph` conventions with all wrapper defaults (14px, `0 0 24 24` viewBox, strokeWidth 2, `fill="none"`, `stroke="currentColor"`, round caps/joins, `aria-hidden`, `shrink-0`, `data-icon="keyboard"`). Geometry is the intake's candidate "A6": a rounded-rect case, a 4-dot row (y=8), a 3-dot row (y=12), and a dot · spacebar · dot bottom row symmetric about x=12.

- **GIVEN** the glyph register
- **WHEN** `KeyboardGlyph` renders
- **THEN** the SVG carries `data-icon="keyboard"` and the A6 path set, with no new wrapper parameters

#### R6: The capture verb in the pinned block
`app/frontend/src/components/gui-toolbar.tsx` SHALL render the capture verb in the header fold cluster's pinned block (beside `⚙`, between the adaptive cluster and the frame verbs) whenever the `gui-capture-toggle` palette row exists — i.e. on fine pointers with a gui tile open. The verb MUST never fold at any width: the pinned block becomes permanent on fine pointers, so the fold call MUST reserve the capture block's measured width unconditionally (subtracted from `availableWidth`) while the `⚙` keeps its conditional two-pass reserve via `pinnedWidth`; `lib/gui-toolbar-fold.ts`'s API stays unchanged. The latched treatment MUST be the shipped `LATCHED_ARM_RINGED` recipe via `controlClass({ variant: "toggle", base: HEADER_VERB_BASE, rest: "hover:bg-bg-inset hover:text-text-primary", ringed: true, pressed: captured })` (the ⌕ find-toggle / stats-toggle call), with `aria-pressed`. The verb's `onClick` MUST be the palette row's `onSelect` (the by-id mirror rule — no parallel handler). The verb MUST carry a `Tip` labelled "Keyboard capture" whose keycap reads the live registry binding (`kbdFor("gui-capture-toggle")`), inside the cluster's single `TipGroup`; `aria-label` stays for coarse pointers. On coarse pointers the verb is omitted, never disabled.

- **GIVEN** a fine-pointer desktop with the gui tile open
- **WHEN** the header is measured at any width, folded or not
- **THEN** the capture verb renders in the pinned block and is never clipped or folded
- **AND** latching paints the green wash + inset ring + green ink without shifting the pinned block's measured width

#### R7: The `keys → desktop` meta chip
The gui tile header's meta chip (`tileMeta`, `app/frontend/src/components/surface-layout.tsx` — the `wm · display` chip the dependency landed, degrading to the display alone on a bare WM) SHALL swap its content to `keys → desktop` while capture is latched, taking `bg-accent-green/15` + `text-accent-green` and NO ring (it is a label, not a control). The swap renders even when the normal meta would be `null` (both `wm` and `display` empty). On release the chip returns to its normal content.

- **GIVEN** capture latched on a gui tile whose signal carries `wm: "icewm-session"`, `display: ":10"`
- **WHEN** the header renders
- **THEN** the meta chip reads `keys → desktop` in the green wash+ink treatment without a ring
- **AND** releasing capture restores `icewm-session · :10`

### Palette: The capture row

#### R8: One state-labelled `gui-capture-toggle` row, fine-pointer only
`app/frontend/src/lib/palette/gui.ts` SHALL expose ONE row with the stable id `gui-capture-toggle` whose label depends on state — `GUI: Capture keyboard` when released, `GUI: Release keyboard` when latched — inside the existing `tileOpen && !coarsePointer` block (beside the lock pair). One id keeps the `withShortcutHints` keycap (it matches `action.id === binding.actionId`); a destination-only pair would silently drop it. The row is omitted on coarse pointers, never disabled. `GuiPaletteInput` gains `capture: boolean` and `onCaptureChange: (on: boolean) => void`, and the builder docblock gains the row's entry.

- **GIVEN** a fine pointer and an open gui tile
- **WHEN** the palette lists `GUI:` rows
- **THEN** a `gui-capture-toggle` row reads `GUI: Capture keyboard` when released and `GUI: Release keyboard` when latched, decorated with the live chord hint
- **AND** on a coarse pointer the row is absent

### Tests

#### R9: Unit coverage
New behavior MUST be covered by colocated unit tests: the narrowed predicate (captured ⇒ only `gui-capture-toggle` reclaims; not-captured ⇒ byte-identical for every existing case and kind) and the new binding's per-platform resolution (`lib/keybindings.test.ts`); the `rk-gui-capture` read/write, absent/invalid default, and throwing-`localStorage` path (`lib/gui-posture.test.ts`); the palette row's fine-only presence, state-flipping label, and stable id (`lib/palette/gui.test.ts`); `data-icon="keyboard"` (the glyph register's test seam); and the capture verb's permanence in the pinned block plus its coarse omission (`components/gui-toolbar.test.tsx`).

- **GIVEN** the new code
- **WHEN** `just test-frontend` runs
- **THEN** all of the above assertions pass alongside the existing suites

#### R10: Playwright chord-routing coverage
A new `app/frontend/tests/e2e/gui-keyboard-capture.spec.ts` (alongside `gui-surface.spec.ts`, on the ungated `_gui-mock.ts` scaffolding) MUST prove: with capture off, the palette chord (Ctrl+K) reclaims through the gui canvas gate and opens the palette; with capture on, it does not and the key reaches the canvas; the release chord (Ctrl+Shift+G) releases; clicking the pinned icon toggles and releases; the latch survives a reload (`rk-gui-capture`). Every `test()` carries the constitution's `Proves:`/`Steps:` JSDoc and the file opens with a shared-setup header.

- **GIVEN** the mocked gui backend with a reachable icewm entry
- **WHEN** the spec runs under `just test-e2e gui-keyboard-capture`
- **THEN** every routing assertion passes against the real key pipeline

### Non-Goals

- `keyboard.lock()` and everything around `guiFullscreen` — already shipped, untouched (C11).
- Auto-engaging capture on fullscreen entry/exit — fullscreen and capture stay orthogonal (C10).
- A coarse-pointer/mobile capture control or any `gui-keybar.tsx` change (C9).
- Any change to the capture-phase interceptor body, the synthetic re-dispatch, or noVNC's handler (C1).
- A fullscreen-pill hide-timer carve-out or a pill-chip variant of the control — both moot since the dependency deleted the pill (C12).
- A two-id destination-only palette pair (`gui-capture-on`/`gui-capture-off`) — it would drop the `withShortcutHints` keycap.

### Design Decisions

#### Capture narrowing rides a fourth parameter on the one predicate
**Decision**: `hasReclaimableMatch(e, bindings, kind, captured = false)` — an optional boolean appended to the existing signature.
**Why**: keeps every existing call site compiling, keeps the one-predicate framing literal (C1), and keeps the capture unit tests beside the predicate's existing cases instead of split across two exports.
**Rejected**: a sibling `hasReclaimableMatchCaptured` predicate (splits the unit tests and the framing); a wrapper at the app.tsx callback (the narrowing would live outside the unit-testable predicate).
*Introduced by*: 260912-31eg-gui-keyboard-capture

#### One state-labelled palette row, not a destination-only pair
**Decision**: a single `gui-capture-toggle` row whose label flips `GUI: Capture keyboard` ⇄ `GUI: Release keyboard`.
**Why**: `withShortcutHints` matches `action.id === binding.actionId`; a `show`/`hide`-shaped pair would leave both rows without the keycap that the registry binding (C2) and the tooltip (C13) depend on.
**Rejected**: the `gui-keybar-show`/`gui-keybar-hide` pair shape (silently loses the keycap).
*Introduced by*: 260912-31eg-gui-keyboard-capture

#### A permanent pinned member reserves unconditionally; the `⚙` keeps the two-pass reserve
**Decision**: when the capture row exists (fine pointer), the pinned block renders permanently and the component subtracts the probed capture-block width (divider + verb) from `availableWidth` before calling `computeGuiToolbarFold`, passing the probed `⚙`-block width as `pinnedWidth` exactly as today.
**Why**: C12 requires the capture verb permanently visible at every width, while the dependency's D3 keeps `⚙` conditional on an actual fold and D4 keeps its reserve from causing the fold that justifies it. Subtracting the permanent member's width up front preserves both rules without touching `gui-toolbar-fold.ts`'s API or its unit tests.
**Rejected**: growing the two-pass `pinnedWidth` and leaving the block conditional (the capture verb would vanish at full width, breaking C4's mouse guarantee); making the whole block unconditional with a single reserve (would re-introduce the D3×D4 circularity for `⚙`).
*Introduced by*: 260912-31eg-gui-keyboard-capture

## Tasks

### Phase 1: Primitives

- [x] T001 [P] `app/frontend/src/lib/gui-posture.ts`: add `GUI_CAPTURE_KEY = "rk-gui-capture"`, `readGuiCapture()`/`writeGuiCapture(on)` in the `rk-gui-lock` shape, and extend the header docblock; add read/write/default/throwing-storage cases to `app/frontend/src/lib/gui-posture.test.ts` <!-- R3 -->
- [x] T002 [P] `app/frontend/src/components/top-bar-icons.tsx`: add `KeyboardGlyph` (A6 geometry, all `ControlGlyph` defaults, `data-icon="keyboard"`); add the glyph to the register's existing test seam (or create `top-bar-icons.test.tsx` if none exists) <!-- R5 -->
- [x] T003 `app/frontend/src/lib/keybindings.ts`: add the `gui-capture-toggle` default binding beside the zoom trio and the optional `captured` parameter on `hasReclaimableMatch` with its docblock update; add narrowing + per-platform resolution + not-captured byte-identical cases to `app/frontend/src/lib/keybindings.test.ts` <!-- R1, R2 -->

### Phase 2: Core Implementation

- [x] T004 `app/frontend/src/lib/palette/gui.ts`: add `capture`/`onCaptureChange` to `GuiPaletteInput`, push the state-labelled `gui-capture-toggle` row in the `tileOpen && !coarsePointer` block, extend the builder docblock; update `app/frontend/src/lib/palette/gui.test.ts` (input factory gains the fields; new fine-only/label-flip/stable-id cases) <!-- R8 -->
- [x] T005 `app/frontend/src/app.tsx`: add `guiCapture` state + `handleGuiCaptureChange`, thread `kind === "gui" && guiCapture` through `reclaimChordForKind`, add the `guiGated("gui-capture-toggle", …)` handler beside the zoom trio, pass `capture`/`onCaptureChange` into `buildGuiActions`, and thread `guiCapture` to `SurfaceLayout` <!-- R3, R4 -->

### Phase 3: Integration & Edge Cases

- [x] T006 `app/frontend/src/components/surface-layout.tsx`: add the `guiCapture` prop, swap the gui meta chip to `keys → desktop` (green wash + ink, no ring) while latched, and pass `capture` into `GuiToolbar` <!-- R7 -->
- [x] T007 `app/frontend/src/components/gui-toolbar.tsx`: add the `capture` prop, render the capture verb in the pinned block (permanent on fine pointers, `LATCHED_ARM_RINGED` via `controlClass`, Tip "Keyboard capture" with the live `kbdFor("gui-capture-toggle")` keycap, onClick = the palette row's `onSelect`), extend the measurement probe with a `data-fold="capture"` block and subtract its width from `availableWidth` in the fold call; extend `app/frontend/src/components/gui-toolbar.test.tsx` (verb present at every fold state on fine, absent on coarse) <!-- R6 -->
- [x] T008 `app/frontend/tests/e2e/gui-keyboard-capture.spec.ts`: new spec on the `_gui-mock.ts` scaffolding proving the off-state reclaim, the captured pass-through (key reaches the canvas, palette stays closed), release via chord, release via icon click, and reload persistence — with the shared-setup file header and `Proves:`/`Steps:` JSDoc per test <!-- R10 -->

### Phase 4: Gates

- [x] T009 Run the gates in order: `cd app/frontend && npx tsc --noEmit`, `just test-frontend`, `just test-e2e gui-keyboard-capture` plus the adjacent specs (`gui-surface`, `gui-toolbar-fold`, `macro-riff-bindings`, `shortcut-registry` — the new shifted-tier `KeyG` default must not disturb them), `just test-backend`, `just build` <!-- R9, R10 -->

## Execution Order

- T003 (predicate + binding) blocks T005 (wiring) and T008 (e2e).
- T004 (palette row) blocks T005 and T007 (the verb mirrors the row).
- T005 (app.tsx threading) blocks T006/T007 (the `guiCapture`/`capture` props).
- T001/T002 are independent; T006/T007 are independent of each other once T005 lands.

## Acceptance

### Functional Completeness

- [x] A-001 R1: With `captured: true`, `hasReclaimableMatch` returns `true` only for chords matching `gui-capture-toggle`; with it absent/false the predicate is byte-identical to the pre-change behavior for kinds `gui`, `code`, and `web`.
- [x] A-002 R2: The default registry contains `gui-capture-toggle` (`KeyG`, shifted tier, `guiOnly`, `ignoreInputs`); it resolves enabled on both host platforms, appears in the Shortcuts overlay, and a user remap moves the escape hatch and every derived hint.
- [x] A-003 R3: `readGuiCapture`/`writeGuiCapture` round-trip `"1"`/absent, default to `false` on absent or invalid values, and degrade safely on a throwing `localStorage`; the latch survives a reload.
- [x] A-004 R4: The release chord toggles capture exactly while the gui tile owns focus; elsewhere the chord falls through untouched (no handler mounted).
- [x] A-005 R5: `KeyboardGlyph` renders with `data-icon="keyboard"` and the A6 geometry under the `ControlGlyph` defaults.
- [x] A-006 R6: The capture verb renders in the pinned block at every width (never folds, never clipped) on fine pointers, latches with the `LATCHED_ARM_RINGED` recipe without a layout shift, fires the palette row's `onSelect`, shows a `Tip` with the live registry keycap, and is omitted (not disabled) on coarse pointers.
- [x] A-007 R7: The gui meta chip reads `keys → desktop` in green wash+ink without a ring while latched and returns to `wm · display` (or its bare-WM degradation) on release.
- [x] A-008 R8: The palette carries one `gui-capture-toggle` row labelled `GUI: Capture keyboard`/`GUI: Release keyboard` by state, present on fine and absent on coarse, decorated by `withShortcutHints`.

### Behavioral Correctness

- [x] A-009 R1: While captured, ⌘K (the original complaint) reaches the guest — proven by the e2e: the palette does not open and the keydown reaches the canvas wrapper.
- [x] A-010 R4: The three exits all work — release chord, pinned-icon click, and the pointer-reachable palette row.
- [x] A-011 R3: The latch persists across a full page reload (e2e-proven).

### Scenario Coverage

- [x] A-012 R9: Unit suites cover the narrowing both ways, the posture key's four paths, the palette row's presence/label/id, the glyph seam, and the verb's permanence/coarse-omission.
- [x] A-013 R10: The new e2e spec passes under `just test-e2e gui-keyboard-capture`, and the adjacent `gui-surface`, `gui-toolbar-fold`, `macro-riff-bindings`, and `shortcut-registry` specs stay green.

### Edge Cases & Error Handling

- [x] A-014 R1: Kinds `code` and `web` never see the narrowing — their reclaim behavior is byte-identical whether or not capture is latched (the flag is threaded only for kind `"gui"`).
- [x] A-015 R6: At the narrowest widths the fold can only cost one more ladder item; the capture control itself can never be folded or clipped (safety assertion, not cosmetic).
- [x] A-016 R2: A macro bound to ⇧Ctrl+G still fires when the gui tile does not own focus (the dispatcher's first-match-with-handler rule yields past the absent `guiGated` handler) — the `macro-riff-bindings` spec stays green.

### Code Quality

- [x] A-017 Pattern consistency: New code follows naming and structural patterns of surrounding code (the `rk-gui-lock` posture shape, the ⌕ find-toggle `controlClass` call, the by-id palette mirror).
- [x] A-018 No unnecessary duplication: Existing utilities reused (`controlClass`, `Tip`/`TipGroup`, `kbdFor`/`chordHintFor` registry hints, `pickGuiActions` mirror, the `_gui-mock.ts` scaffolding).
- [x] A-019 Type narrowing over type assertions: the frontend changes introduce no `as` casts.
- [x] A-020 New behavior carries tests: every added/changed behavior above has unit or e2e coverage (test-alongside).
- [x] A-021 Comment discipline: new comments state constraints and cross-file contracts only — no narration, no change-ID citations.

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | The capture narrowing rides a 4th optional `captured` parameter on `hasReclaimableMatch` (intake assumption 14 confirmed) | C1 fixes the behavior, not the signature; an optional param keeps every call site compiling and the unit tests in one place. Cheap to reverse: one signature, one call site | S:65 R:85 A:85 D:70 |
| 2 | Certain | One state-labelled palette row keyed `gui-capture-toggle` (intake assumption 15 confirmed) | `withShortcutHints` matches `action.id === binding.actionId` (`keybindings.ts:1048`) — verified against the landed tree; a destination-only pair would drop the keycap C2/C13 depend on | S:60 R:90 A:90 D:75 |
| 3 | Certain | The gui meta chip already exists — the landed dependency's D14 added `wm · display` to `tileMeta` (`surface-layout.tsx:579`) with the bare-WM degradation. This change only swaps its content while latched (intake assumptions 17/18 resolved by the landed tree, not by this plan) | Verified in the merged tree: `tileMeta` handles `gui` with the `[wm, display].filter(nonEmpty).join(" · ")` shape. No chip construction needed here | S:90 R:95 A:90 D:90 |
| 4 | Confident | The pinned block gains a PERMANENT member: the capture verb renders whenever its palette row exists, and the fold call subtracts the probed capture-block width from `availableWidth` while `pinnedWidth` keeps covering the conditional `⚙` alone. `gui-toolbar-fold.ts`'s API and tests are untouched | The intake's "adding one more pinned control can only fold one more cluster item" assumes the two-pass reserve, but the landed D3 renders `⚙` only when folded — an unmodified join would hide the capture verb at full width, violating C12/C4. The up-front subtraction preserves D3×D4 for `⚙` and C12 for capture. Reversible: one probe span + one subtraction in gui-toolbar.tsx | S:70 R:85 A:80 D:65 |
| 5 | Confident | C12's "hairline either side" reads against the dependency's D11 flush idiom: ONE leading divider inside the pinned block; the rail divider before the fullscreen verb (`surface-layout.tsx`, the existing header rule) is the other side; capture sits flush beside `⚙` like sibling verbs | D11 fixes items flush at gap 0 with dividers carrying all separation; two hairlines inside the block would double-rule against the existing rail divider. Presentational and trivially reversible | S:55 R:90 A:75 D:60 |
| 6 | Confident | The captured flag reaches the predicate only for kind `"gui"` (`kind === "gui" && guiCapture` at the `reclaimChordForKind` call site), making the `code`/`web` reclaim paths structurally inert | The predicate's narrowing is literal per C1; the kind guard lives at the single call site so a future non-gui caller cannot accidentally narrow. One line, fully reversible | S:70 R:85 A:80 D:70 |
| 7 | Confident | The e2e "key reaches the canvas" assertion uses a bubble-phase `keydown` listener installed on the `gui-surface-canvas` wrapper via `page.evaluate` — reclaimed chords never bubble there (the gate stops propagation), captured ones do | The mocked `/ws/gui/` socket never completes the RFB handshake, so noVNC's own handler cannot be the witness; the wrapper's bubble phase is exactly what the gate's `stopPropagation` gates. Uses the shipped `_gui-mock.ts` scaffolding unchanged | S:75 R:85 A:80 D:75 |

7 assumptions (2 certain, 5 confident, 0 tentative).
