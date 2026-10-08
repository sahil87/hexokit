# Plan: Navigation Chords Fire from the Compose Textarea

**Change**: 260914-88is-compose-strip-nav-chords
**Intake**: `intake.md`

## Requirements

### Keyboard registry: navigation chords punch through text inputs

#### R1: The six navigation bindings carry `ignoreInputs`
The `DEFAULT_BINDINGS` rows `window-prev`, `window-next`, `session-prev`, `session-next`, `go-back`, and `go-forward` in `app/frontend/src/lib/keybindings.ts` MUST carry `ignoreInputs: true`. No other field on those rows (code, tier, `macTier`/`macCode` refinement, scope, kind, label, description, `mapLabel`) SHALL change, and no other binding SHALL gain or lose the flag.

- **GIVEN** the shipped `DEFAULT_BINDINGS`
- **WHEN** each of the six actionIds is resolved for any host
- **THEN** its `ignoreInputs` is `true`
- **AND** the row's other fields are byte-identical to the pre-change row (the existing full-row equality tests pass once extended with the flag)

#### R2: Navigation chords dispatch while a real text input owns focus
With a `<textarea>` (the compose strip's) focused, a navigation chord MUST reach its handler through `useKeybindingDispatch` and be `preventDefault`ed, so repeated presses walk the window list from the compose textarea on the desktop terminal route with the strip on.

- **GIVEN** a focused `<textarea>` and `useKeybindingDispatch({ "window-next": handler })` mounted
- **WHEN** `Shift+Ctrl+ArrowDown` (the base face; jsdom is a non-mac host) is dispatched on the textarea
- **THEN** the handler runs exactly once and the event is `defaultPrevented`

- **GIVEN** the desktop terminal route, no stored compose preference (strip on), and a fresh navigation that landed focus in the compose textarea
- **WHEN** the user presses `Shift+Control+ArrowDown`
- **THEN** the route's window changes
- **AND** focus lands in the new window's compose textarea again
- **AND** a second `Shift+Control+ArrowDown` changes the window again (the regression under test — one press already worked)

#### R3: Registry inline documentation states the constraint truthfully
The arrow/history block comment in `keybindings.ts` MUST state why the six rows carry `ignoreInputs` (the desktop restore router lands first-visit focus in the compose textarea, so a navigation chord's next press targets a TEXTAREA and would otherwise die after one step; navigation chords have no editing meaning worth preserving in a compose draft). The `ignoreInputs?: boolean` field JSDoc and the `shouldSuppressChord` JSDoc MUST stop reading as an exhaustive "⌘K + the overlay" list. Per `fab/project/code-quality.md`, no comment SHALL cite a change ID or PR number.

- **GIVEN** the edited `keybindings.ts`
- **WHEN** a reader looks at the six rows' block comment, the field JSDoc, and the predicate JSDoc
- **THEN** each names the `ignoreInputs` family as a class (chrome toggles + navigation), not an enumeration of two members, and none carries a PR/change citation

#### R4: The e2e opt-out comment in `shortcut-registry.spec.ts` no longer cites navigation chords as suppressed
The file-level comment above `shortcut-registry.spec.ts`'s `seedComposeStrip(page, false)` MUST be reworded so it does not claim only `ignoreInputs` chords fire from the textarea *as the reason navigation chords need the opt-out* — the opt-out remains for the non-punch-through chords that file also exercises (`create-window`, `kill-window`, the split pair, macros).

- **GIVEN** the reworded header comment
- **WHEN** read after this change
- **THEN** it explains the seed as pinning the non-punch-through chords' precondition, consistent with navigation chords now firing from the strip

### Non-Goals

- `useKeybindingDispatch`, `shouldSuppressChord`, `focusIsEngaged`, `compose-strip.tsx`, and the `app.tsx` restore router are not modified — the fix is data on six rows.
- No palette change: no new action, so Constitution V parity already holds.
- `board-cycle-prev`/`board-cycle-next` and every other non-`ignoreInputs` binding are untouched; the mac board-route consequence (⌘[/⌘] from a focused compose textarea now runs history) is recorded in memory at hydrate, not special-cased in code.
- Memory edits (`keyboard-and-palette.md`, `compose-and-bottom-bar.md`, `focus-ownership.md`) are hydrate's work per intake § 5, not apply tasks.

### Design Decisions

#### Navigation chords punch through inputs via per-binding `ignoreInputs`, not a compose carve-out
**Decision**: the six navigation rows opt in with `ignoreInputs: true`, the registry's existing per-binding punch-through mechanism already carried by the chrome-toggle family.
**Why**: keeps the blast radius to navigation chords (modifier combos with no editing meaning worth preserving in a short compose draft), and leaves `shouldSuppressChord` intact — `focusIsEngaged` reuses it, so the restore router keeps treating a focused strip as an engaged surface it must not steal from.
**Rejected**: adding the compose textarea to the `.xterm`-style carve-out inside `shouldSuppressChord` — every non-`ignoreInputs` global chord would then fire inside the strip, and `focusIsEngaged` would stop recognizing the strip as engaged.
*Introduced by*: 260914-88is-compose-strip-nav-chords

## Tasks

### Phase 2: Core Implementation

- [x] T001 Add `ignoreInputs: true` to the six rows (`window-prev`, `window-next`, `session-prev`, `session-next`, `go-back`, `go-forward`) in `app/frontend/src/lib/keybindings.ts`; extend the arrow/history block comment with the constraint; reword the `ignoreInputs?: boolean` field JSDoc and the `shouldSuppressChord` JSDoc so they name the family as a class (no PR/change IDs in any comment) <!-- R1, R3 -->
- [x] T002 [P] In `app/frontend/src/lib/keybindings.test.ts`, add `ignoreInputs: true` to the two full-row `toEqual` blocks (window pair, session pair) and add one set-level assertion that iterates the six actionIds and asserts `ignoreInputs` is `true` on each resolved binding <!-- R1 -->
- [x] T003 [P] In `app/frontend/src/hooks/use-keybinding-dispatch.test.ts`, add a case mounting the six navigation handlers, focusing a `<textarea>`, dispatching the base-face chords on it (`ArrowUp`/`ArrowDown`/`ArrowLeft`/`ArrowRight`/`BracketLeft`/`BracketRight` with `shiftKey`+`ctrlKey`), and asserting each handler ran once and the event was `defaultPrevented` <!-- R2 -->

### Phase 3: Integration & Edge Cases

- [x] T004 Add one Playwright test in `app/frontend/tests/e2e/compose-strip.spec.ts`'s `"on by default"` describe: navigate to `cs-alpha`, assert the compose textarea is active, press `Shift+Control+ArrowDown`, assert the URL leaves the starting window, assert the textarea is active again, press the chord a second time and assert the URL changes again (Proves/Steps JSDoc; file-header clause); reword the `shortcut-registry.spec.ts` file-level opt-out comment; run `just test-frontend` and `just test-e2e compose-strip.spec` (plus `shortcut-registry.spec`) <!-- R2, R4 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: Each of the six navigation bindings resolves with `ignoreInputs: true` on every host, and no other field on those rows changed — flag on `keybindings.ts:285-290`; set-level test iterates the six ids across `ALL_HOSTS`; the two full-row `toEqual` blocks pin every other field
- [x] A-002 R2: `useKeybindingDispatch` fires a navigation handler and `preventDefault`s the event when the chord target is a focused `<textarea>` — new case in `use-keybinding-dispatch.test.ts` presses all six base-face chords on a focused textarea; handler called once, `defaultPrevented` true
- [x] A-003 R3: The block comment, the field JSDoc, and the predicate JSDoc describe the `ignoreInputs` family as a class and carry no PR/change IDs — `keybindings.ts:99-102`, `278-284`, `1033-1037` name "chrome toggles and navigation chords" as the class; no citations
- [x] A-004 R4: `shortcut-registry.spec.ts`'s header comment no longer attributes the compose opt-out to navigation chords being suppressed — reworded at lines 124-130 to name the non-punch-through chords (create-window, kill-window, splits, macros) as the reason

### Behavioral Correctness

- [x] A-005 R2: On the desktop terminal route with the strip on, two consecutive `Shift+Control+ArrowDown` presses from the compose textarea change the window twice (e2e) — new test in `compose-strip.spec.ts` ("on by default" describe); `just test-e2e compose-strip.spec` → 25 passed
- [x] A-006 R1: No binding other than the six gained or lost `ignoreInputs` (the existing `ignoreInputs` unit assertions and the conflict-free-defaults test still pass) — exactly six `ignoreInputs: true` additions in the diff; 169 scoped vitest tests pass

### Scenario Coverage

- [x] A-007 R2: The new e2e test carries a Proves/Steps JSDoc and the compose-strip spec file header mentions the nav-chord coverage — JSDoc above the new `test()`; file header gained the "tab-walk chords still stepping windows from the focused textarea" clause
- [x] A-008 R1: `just test-frontend` passes (keybindings + dispatch unit lanes green) — re-ran scoped lanes: `keybindings.test.ts` (155) + `use-keybinding-dispatch.test.ts` (14) = 169 passed; orchestrator ran the full 4831 green

### Edge Cases & Error Handling

- [x] A-009 R2: `just test-e2e shortcut-registry.spec` still passes — the strip-off fixture there is unaffected by the new flags — re-ran: 26 passed

### Code Quality

- [x] A-010 Pattern consistency: `ignoreInputs: true` is placed on each row in the same position as sibling rows (trailing field), and the new tests follow the existing `press`/`byId` helper style — matches `sidebar-toggle`/`compose-toggle` placement; tests reuse `press`, `byId`, `resolved`, `ALL_HOSTS`
- [x] A-011 No unnecessary duplication: no new helper or predicate is introduced; the fix is data on existing rows — confirmed: no new exported or local function in the diff
- [x] A-012 Comment narration: new comments state constraints (why the family punches through), never narrate the next line or cite change IDs / PR numbers — all new comments state the restore-router/focus constraint; no citations
- [x] A-013 Tests cover the changed behavior: unit (registry rows, dispatch-in-textarea) and e2e (repeated chord from the strip) — all three lanes present and green

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds `ignoreInputs: true` to six existing rows and rewords comments/tests; no existing symbol, file, or branch was made redundant. The `shortcut-registry.spec.ts` strip-off seed stays by design (the file's non-punch-through chords still need it).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | The e2e test lives in `compose-strip.spec.ts`'s "on by default" describe using the two-window `BOARD_SESSION` fixture (`cs-alpha` → next), asserting the URL leaves the starting window rather than naming a fixed target | Intake assumption #6; the fixture already lands first-visit focus in the textarea against the real backend; the flattened list has ≥ 3 rows so a next target always exists | S:70 R:90 A:85 D:70 |
| 2 | Certain | The `shortcut-registry.spec.ts` opt-out seed stays; only its header comment is reworded | That file also exercises non-punch-through chords (`create-window`, `kill-window`, splits, macros) that still need the strip off; removing the seed would break those | S:80 R:95 A:90 D:90 |
| 3 | Certain | The dispatch-hook unit case covers all six chords in one loop (the tile-digit test's style) rather than one test per binding | Matches the sibling test at `use-keybinding-dispatch.test.ts` ("the tile toggles … fire from the compose textarea"); one loop pins the set as a contract | S:75 R:95 A:95 D:90 |

3 assumptions (2 certain, 1 confident, 0 tentative).
