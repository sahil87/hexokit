# Plan: `easter_eggs` setting — a registry switch to turn the screen-break Easter eggs off

**Change**: 260916-hn6s-easter-eggs-setting
**Intake**: `intake.md`

## Requirements

### Settings registry: the `easter_eggs` key

#### R1: One bool registry entry, default on, modelled on `cron_ticker`
`app/backend/internal/settings/settings.go` MUST add `EasterEggs bool` to `Settings`, set it `true` in `Default()`, and add a registry entry `key: "easter_eggs", kind: "bool", def: "true", category: "behavior", ui: true, live: true` with the description `Shows the screen-break Easter eggs: the fist when the viewed tab's PR merges, the eye when an update is available. Off hides the automatic ones; the palette's Easter egg entries still work.` — inserted directly after `cron_ticker` and before `gui.enabled`. Parse MUST be tolerant (`strconv.ParseBool` on the quote-trimmed value; anything else keeps the default on); serialize MUST be omit-when-default (`easter_eggs: false\n` only when off); `read` returns the bool; `apply` is `boolValue(…, true)` so JSON `null` resets to on. `POST /api/settings` MUST gain no side effect for the key.

- **GIVEN** a `config.yaml` without the key
- **WHEN** settings load
- **THEN** `EasterEggs` is `true`, `GET /api/settings` lists `easter_eggs` right after `cron_ticker` with `kind: "bool"`, `default: "true"`, `value: true`, no `options`
- **GIVEN** `easter_eggs: false` in the file
- **WHEN** it loads and is serialized again
- **THEN** the value round-trips and the emitted line is exactly `easter_eggs: false`
- **GIVEN** `easter_eggs: yes-please`
- **THEN** the value stays `true`

### Frontend: the store gate

#### R2: Automatic fires are gated; palette fires are not
`app/frontend/src/lib/screen-break-store.ts` MUST export `setEasterEggsEnabled(v: boolean)` and `easterEggsEnabled(): boolean` over module state defaulting to `true`. `fire()` MUST return `false` with no side effects — in particular no identity write — when the store is disabled and `opts.force` is not set; the check sits after the reduced-motion, viewport, and in-flight gates and before the identity block. `_resetForTests()` MUST reset the flag to `true`. A flight already in progress when the flag flips off is not cancelled.

- **GIVEN** `setEasterEggsEnabled(false)`
- **WHEN** `fire("smash", { identity: "1" })` runs
- **THEN** it returns `false` and `localStorage["runkit-egg-smash"]` is unset
- **WHEN** `fire("smash", { force: true })` runs instead
- **THEN** it returns `true` and writes nothing
- **GIVEN** the flag is set back to `true`
- **WHEN** `fire("smash", { identity: "1" })` runs
- **THEN** it returns `true` and writes the identity

### Frontend: feeding the value

#### R3: One mount fetch seeds the store; a failed or missing read keeps it on
`ScreenBreakController` in `app/frontend/src/components/screen-break.tsx` MUST call `getSettingsEntries()` once in a mount effect and set the store from the `easter_eggs` entry (`entry === undefined || entry.value !== false` ⇒ enabled), ignoring a rejected fetch and a stale resolution after unmount. No polling, no SSE change.

- **GIVEN** the API returns `[{ key: "easter_eggs", value: false, … }]`
- **WHEN** the controller mounts
- **THEN** `easterEggsEnabled()` is `false`
- **GIVEN** the API returns `[]` or rejects
- **THEN** `easterEggsEnabled()` stays `true`

#### R4: Same-browser flips apply immediately through the seam
`commitSetting` in `app/frontend/src/components/settings-registry-seam.ts` MUST handle `easter_eggs` in a key-specific case beside `gui.enabled`: `await postSettings({ easter_eggs: value })`, `updateEntryValue("easter_eggs", value)`, then `setEasterEggsEnabled(value !== false)`. A rejected POST MUST leave the store untouched. The read path (`entriesWithMirrors`) is not changed.

- **GIVEN** an open Settings dialog
- **WHEN** `commitSetting("easter_eggs", false)` resolves
- **THEN** the POST body was `{ easter_eggs: false }`, `settingValue("easter_eggs")` is `false`, and the store setter was called with `false`
- **WHEN** `commitSetting("easter_eggs", null)` resolves
- **THEN** the store setter was called with `true`

### Settings dialog

#### R5: A General → This host row
`GeneralPanel` in `app/frontend/src/components/settings-dialog.tsx` MUST render a `PreferenceRow` labelled `Easter eggs` with the registry description as sublabel and a `BoolToggle` (`id="settings-easter-eggs"`) directly after `Auto-name tabs`, reading `registry.settingValue("easter_eggs") !== false` and committing `registry.commitSetting("easter_eggs", on)`. The All-settings table renders the key generically (`setting-row-easter_eggs`, group Behavior) and MUST need no edit.

- **GIVEN** the entries resolve with `easter_eggs: true`
- **WHEN** General renders
- **THEN** a checked switch named `Easter eggs` shows the registry description; clicking it posts `{ easter_eggs: false }`
- **GIVEN** the entry is absent
- **THEN** the switch renders checked

### Layer: click-to-dismiss (added in flight at the user's request, after review)

#### R7: A click on the creature dismisses the flight with a fast heal
The store MUST export `dismiss(): boolean` stamping `dismissedAt` on the live flight once (no-op without a flight or when stamped). The creature sprite MUST be the layer's only click target — `.rk-sb-sprite svg * { pointer-events: visiblePainted; cursor: pointer }` while both groups stay `pointer-events: none` — and the inactive creature slot MUST be `visibility: hidden` per frame so it cannot be hit. After a dismiss the frame loop MUST run `t = clamp(v0 + (raw − td)·3)` with `v0 = dismissOrigin(td)` resuming on the retreat curve at the same emerge amount (`td ≥ 0.64 → td`; `0.44 ≤ td < 0.64 → 0.64`; else `0.64 + 0.12·(1 − clamp((td − 0.3)/0.14))`), so the heal takes ~1.4 s and nothing cuts.

- **GIVEN** a `smash` flight at t = 0.5 (fist released)
- **WHEN** a painted shape of the above slot is clicked
- **THEN** `dismissedAt` is stamped, and 1.5 s later the layer has unmounted with the glass clean

### Tests and gates

#### R6: Coverage and gates
Go: `registry_test.go` (`wantKeys`, metadata checks, default cases), `settings_test.go` (round-trip fixture, a `TestEasterEggs` mirroring `TestCronTicker`, exact-output fixtures gain `EasterEggs: true`), `api/settings_test.go` (`wantKeys` + entry shape). Vitest: the store, controller, dialog, and seam cases in R2–R5. e2e: one new `settings-dialog.spec.ts` test (General toggle → `expect.poll` on `GET /api/settings` reading `false` → toggle back → `true`, restored in `finally`) with a Proves/Steps JSDoc; `screen-break.spec.ts` unchanged and still green. Gates: `env -u TMUX -u TMUX_PANE just test-backend`, `just test-frontend` (full), `just test-e2e settings-dialog.spec`, `just test-e2e screen-break.spec`.

- **GIVEN** the finished worktree
- **WHEN** the four gates run
- **THEN** all report passed

### Non-Goals

- Any change to the eggs' geometry, timeline, trigger transition logic, or sprites
- An env form for the key (Constitution IV — preference keys have none)
- An SSE broadcast for the key; a per-viewer localStorage override
- Cancelling an in-flight flight when the setting flips off

### Design Decisions

#### A per-instance registry key, not a per-viewer preference
**Decision**: `easter_eggs` lives in the `internal/settings` registry and `config.yaml`.
**Why**: "Someone finds it distracting" is a property of the box, and Constitution IV allows exactly one registry-driven settings surface — only registry keys get a row there.
**Rejected**: A localStorage toggle — invisible in Settings and per browser.
*Introduced by*: 260916-hn6s-easter-eggs-setting

#### Palette fires bypass the gate
**Decision**: Only automatic occasions are gated; `Easter egg: Smash`/`Peek` keep firing because they already pass `force: true`.
**Why**: Typing "Easter egg" into the palette is explicit intent; the user asked for exactly this.
**Rejected**: Hiding the palette entries when off — changes the palette registry and its e2e counts for no benefit.
*Introduced by*: 260916-hn6s-easter-eggs-setting

#### Disabled fires write no identity
**Decision**: A gated non-force fire returns `false` before the identity block.
**Why**: Triggers fire only on observed previous→next transitions, so nothing needs consuming; re-enabling later cannot replay an old merge or update.
**Rejected**: Recording the identity anyway — it would silently eat a future automatic occasion that never showed.
*Introduced by*: 260916-hn6s-easter-eggs-setting

#### One mount GET plus a write-side seam hook, no SSE
**Decision**: The controller seeds the store with one `getSettingsEntries()` at mount; the seam mirrors a committed value into the store; other browsers pick the flip up on reload.
**Why**: Mirrors the theme context's posture; an SSE event for a rarely flipped cosmetic key is surface without payoff; no polling.
**Rejected**: A `setInterval` re-read (code-quality anti-pattern); a `POST /api/settings` side effect broadcasting the key.
*Introduced by*: 260916-hn6s-easter-eggs-setting

## Tasks

### Phase 1: Setup

- [x] T001 Add `EasterEggs bool` to `Settings`, `EasterEggs: true` in `Default()`, and the `easter_eggs` registry entry (after `cron_ticker`, before `gui.enabled`) in `app/backend/internal/settings/settings.go`; update the `boolValue` doc comment if it enumerates keys <!-- R1 -->

### Phase 2: Core Implementation

- [x] T002 [P] Go tests: `internal/settings/registry_test.go` (`wantKeys`, metadata `checks`, default-value cases), `internal/settings/settings_test.go` (round-trip fixture, `TestEasterEggs` mirroring `TestCronTicker`, `EasterEggs: true` added to exact-output struct fixtures), `api/settings_test.go` (`wantKeys` + entry shape); run `cd app/backend && env -u TMUX -u TMUX_PANE go test ./internal/settings/ ./api/` <!-- R1 R6 -->
- [x] T003 [P] Store gate in `app/frontend/src/lib/screen-break-store.ts` (`setEasterEggsEnabled`, `easterEggsEnabled`, the `fire` check, `_resetForTests` reset, doc comments) plus the four cases in `screen-break-store.test.ts` <!-- R2 R6 -->
- [x] T004 Controller mount fetch in `app/frontend/src/components/screen-break.tsx` (`getSettingsEntries` once, cancelled flag, catch keeps enabled) plus a `ScreenBreakController` block in `screen-break.test.tsx` (value false → disabled; `[]` → enabled; reject → enabled) reusing the trigger-hook mocks from `use-screen-break-triggers.test.tsx` <!-- R3 R6 -->
- [x] T005 [P] Seam case in `app/frontend/src/components/settings-registry-seam.ts` (`easter_eggs`: POST → `updateEntryValue` → `setEasterEggsEnabled(value !== false)`) plus the two cases in `settings-registry-seam.test.tsx` with `@/lib/screen-break-store` mocked <!-- R4 R6 -->
- [x] T006 [P] General → This host row in `app/frontend/src/components/settings-dialog.tsx` after `Auto-name tabs` plus the dialog cases in `settings-dialog.test.tsx`; confirm by reading that `settings-all-panel.tsx` renders the key generically <!-- R5 R6 -->

### Phase 3: Integration & Edge Cases

- [x] T007 Add the General-toggle persistence e2e test to `app/frontend/tests/e2e/settings-dialog.spec.ts` (click `#settings-easter-eggs`, `expect.poll` GET `/api/settings` → `false`, click again → `true`, restore in `finally`, Proves/Steps JSDoc, no PR numbers or change IDs) <!-- R6 -->
- [x] T008 Run the gates from the repo root: `env -u TMUX -u TMUX_PANE just test-backend`, `just test-frontend` (full Vitest), `just test-e2e settings-dialog.spec`, `just test-e2e screen-break.spec`; fix and re-run until all are green <!-- R6 -->
- [x] T009 Click-to-dismiss (post-review addition): `dismiss()` in `screen-break-store.ts`, `dismissOrigin` + `DISMISS_SPEED` remap and per-frame slot `visibility` in `screen-break.tsx`, `.rk-sb-sprite svg *` pointer rule in `globals.css`, store + component tests, the e2e "clicking the fist heals the screen early" test; memory § The 12 s timeline → Dismiss and a Design Decisions entry; gates re-run (`just test-frontend`, `just test-e2e screen-break.spec`) <!-- R7 -->

## Execution Order

- T001 blocks T002; T003 blocks T004 and T005 (they import the new exports); T006 is independent of T003–T005 apart from the shared `settings-dialog.test.tsx` mocks; T001–T007 block T008

## Acceptance

### Functional Completeness

- [x] A-001 R1: the registry has an `easter_eggs` bool entry after `cron_ticker`, default on, tolerant parse, omit-when-default serialize, `boolValue` apply; `Settings.EasterEggs` defaults to true; no handler side effect
- [x] A-002 R2: the store exports the two functions, `fire` returns false with no identity write when disabled and not forced, and `_resetForTests` restores enabled
- [x] A-003 R3: the controller seeds the store from one mount fetch and keeps enabled on a missing key or a rejected fetch
- [x] A-004 R4: `commitSetting("easter_eggs", …)` posts, updates the fetched list, and mirrors into the store; a rejected POST leaves the store untouched
- [x] A-005 R5: the General panel shows the `Easter eggs` row after `Auto-name tabs` with the registry description, default-on read, and commit; the All-settings table needed no edit

### Behavioral Correctness

- [x] A-006 R2: with the setting off, the automatic smash/peek triggers never start a flight; `Easter egg: Smash` from the palette still mounts the layer
- [x] A-007 R1: an unchanged `config.yaml` serializes byte-identically (no `easter_eggs` line appears when on)

### Scenario Coverage

- [x] A-008 R6: Go tests cover default, round-trip, garbage-keeps-true, GET key order and entry shape; `env -u TMUX -u TMUX_PANE just test-backend` passes
- [x] A-009 R6: Vitest covers the store, controller, seam, and dialog scenarios; `just test-frontend` passes in full
- [x] A-010 R6: the new e2e test persists the flip through `GET /api/settings` and restores it; `just test-e2e settings-dialog.spec` and `just test-e2e screen-break.spec` pass

### Edge Cases & Error Handling

- [x] A-011 R2: a flight already running when the setting flips off completes normally (no cancellation path added)
- [x] A-012 R3: a controller unmount before the fetch resolves does not touch the store (cancelled flag)
- [x] A-013 R4: `commitSetting("easter_eggs", null)` re-enables the store (registry default)
- [x] A-020 R7: only the visible creature slot is hit-testable (inactive slot `visibility: hidden`; groups stay `pointer-events: none`); a click on a painted shape stamps `dismissedAt` once
- [x] A-021 R7: the compressed heal resumes at the sprite's current emerge amount and unmounts the layer within ~1.5 s with the glass clean (unit + e2e)

### Code Quality

- [x] A-014 Pattern consistency: the registry entry mirrors `cron_ticker` line for line; the seam case mirrors `gui.enabled`'s shape; the dialog row mirrors `Auto-name tabs`
- [x] A-015 No unnecessary duplication: `boolValue` is reused; the description string lives only in the registry entry (the dialog reads it from the entry)
- [x] A-016 Type narrowing over assertions: `entry.value !== false` and `value !== false` guards, no new `as` casts
- [x] A-017 No client polling: exactly one `getSettingsEntries()` per controller mount, no timers
- [x] A-018 Tests accompany the change; the new e2e `test()` carries an accurate `Proves:`/`Steps:` block
- [x] A-019 Comment discipline: comments state constraints (why disabled fires write no identity; why the seam mirrors into the store), never narration or PR/change ids

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`
- **Post-review addition (R7/T009/A-020–021)**: click-to-dismiss was requested by the user after the review and review-pr stages passed and was added as a further commit on the same PR; it is covered by its own unit and e2e tests and re-gated with `just test-frontend` and `just test-e2e screen-break.spec`.

## Deletion Candidates

None — this change adds new functionality without making existing code redundant.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | The Go gate runs as `env -u TMUX -u TMUX_PANE just test-backend` to mirror CI | Every shell here runs inside tmux and CI does not; a precondition-guarded test that passes only with `$TMUX` set has failed CI before | S:85 R:95 A:95 D:95 |
| 2 | Confident | The controller test reuses the trigger hook's context mocks rather than extracting a shared fixture | One new test block; a shared fixture is a refactor outside this change's scope | S:60 R:90 A:80 D:75 |

2 assumptions (1 certain, 1 confident, 0 tentative).
