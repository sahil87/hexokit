# Plan: PANE-on Yields the Bar; Continuation Lines

**Change**: 260914-msji-pane-panel-yield-continuation
**Intake**: `intake.md`

## Requirements

### Status bar: the window cluster yields to a visible PANE panel

#### R1: The terminal-route status bar passes `window={null}` while the PANE panel is on screen
The terminal-route `StatusBar` mount in `AppShell` (`app/frontend/src/app.tsx`) MUST render the window cluster iff the PANE panel is NOT on screen. The panel is on screen when the `pane` sidebar section is visible (`useSidebarSectionVisible("pane")`) AND the sidebar is open (`ChromeState.sidebarOpen`) AND zen mode is not active (`zenOn`). When all three hold the mount SHALL pass `window={null}`; otherwise it SHALL pass `currentWindow ?? null` as today. The host cluster (`status-bar-host`) MUST render in every state. `StatusBar`, `WindowCluster`, `StatusBarProps`, the board mount, the Host mount, and the mobile branch MUST NOT change.

- **GIVEN** a desktop terminal route with the `pane` section off (the default)
- **WHEN** the shell renders
- **THEN** `status-bar-window` is present

- **GIVEN** the `pane` section on, the sidebar open, zen off
- **WHEN** the shell renders
- **THEN** `status-bar-window` is absent and `status-bar-host` is present

- **GIVEN** the `pane` section on and the sidebar collapsed (or zen active)
- **WHEN** the shell renders
- **THEN** `status-bar-window` is present (the panel is not on screen, so the bar is again the only register view)

- **GIVEN** the bar is showing the window cluster
- **WHEN** the user runs `Panel: Toggle Pane` (palette) or clicks the rail's `Toggle Pane section`
- **THEN** the cluster disappears without a remount or reload (the hooks are the existing localStorage pub/sub)

### Register resolvers: the PR identity/health split is shared

#### R2: `getPrParts` splits the L3 register into identity and health
`sidebar/registers.ts` MUST export `getPrParts(win): { identity: PrSegment[]; health: PrSegment[] } | null` — `null` without `prNumber`; `identity` = the `#<n>` segment plus the state segment (incl. ` (draft)`) when `prState` is present; `health` = the `checks <c>` and `review: <r>` segments, present only while the PR is open (no state or `open`) and the value is not `none`. `getPrSegments(win)` MUST become the pure formatter `[...identity, ...health]` with byte-identical output to today (existing `registers.test.ts` pins stay green).

- **GIVEN** an open PR #241 with `prChecks: pass`, `prReview: approved`
- **WHEN** `getPrParts` runs
- **THEN** `identity` is `[#241, open]` and `health` is `[checks pass, review: approved]`, and `getPrSegments` equals their concatenation

- **GIVEN** a merged PR
- **WHEN** `getPrParts` runs
- **THEN** `health` is empty

### PANE panel: `pr` and `fab` rows use continuation lines

#### R3: The `pr` row renders identity on the key line and health on a continuation line
In `status-panel.tsx` the `pr` row MUST render a key line — prefix, icon, `data-testid="pr-line"` containing the identity segments, and (URL branch) the always-visible `↗` — and, only when `health` is non-empty, a continuation line `data-testid="pr-line-cont"` with the health segments (each keeping its `PR_CHECKS_COLORS` / `PR_REVIEW_COLORS` class, ` · ` separators in `text-text-secondary`), styled `pl-[6ch] text-text-secondary min-w-0 truncate`. In the URL branch the `<a>` MUST contain both lines (open-first covers the block); the hover copy icon MUST stay vertically centred on the key line. The no-URL branch MUST render the same two-line body inside its `CopyableRow` button, copying the joined full text as today. Both branches MUST compose from one shared identity/health JSX source. A merged or closed PR renders one line.

- **GIVEN** an open PR with checks + review
- **WHEN** the panel renders
- **THEN** `pr-line` reads `#<n> · open` and `pr-line-cont` reads `checks <c> · review: <r>`, both inside the anchor

- **GIVEN** a merged PR
- **WHEN** the panel renders
- **THEN** `pr-line` reads `#<n> · merged` and `pr-line-cont` is absent

#### R4: The `fab` row renders the slug on a continuation line only when the branch does not carry it
The `fab` row's key line MUST read `<id> · <stage>[ · <displayState>]` (state token in `FAB_STATE_COLORS`), never containing the slug. When `getFabParts(win, gitBranch).slug` is defined the row MUST render a continuation line `data-testid="fab-line-cont"` with the slug (`pl-[6ch] text-text-secondary min-w-0 truncate`); when undefined no continuation line renders. The whole block stays inside the `CopyableRow` button; the copy value stays the 4-char id.

- **GIVEN** a pane whose branch is `260805-93dy-row-flyout` on change `260805-93dy-row-flyout`
- **WHEN** the panel renders
- **THEN** the fab row reads `93dy · apply` and `fab-line-cont` is absent

- **GIVEN** the same change on branch `main`
- **WHEN** the panel renders
- **THEN** the key line reads `93dy · apply` and `fab-line-cont` reads `row-flyout`

#### R5: Two lines maximum; other rows unchanged
No panel row renders more than two lines; a continuation line renders only with content. `tmx`, `cwd`, `git`, `out`, `agt`, `opr` are unchanged.

### Tests

#### R6: Coverage
Unit: `registers.test.ts` (R2), `status-panel.test.tsx` (R3–R5), `app.test.tsx` (R1 via the existing terminal-route harness). E2E `tests/e2e/pane-register-panel.spec.ts`: a desktop `describe` proving R1's four scenarios through the palette and the sidebar toggle, plus continuation assertions on the mobile `full-stack` window (`pr-line` = `#386 · open`, `pr-line-cont` contains `checks fail`, `fab-line-cont` count 0). Every new/changed `test()` carries a Proves/Steps JSDoc; the file header covers the desktop setup. `status-bar.spec.ts` is not edited.

- **GIVEN** the full gates (`tsc --noEmit`, `just test-frontend`, `just test-e2e pane-register-panel.spec`, `just test-e2e status-bar.spec`, `just test-e2e sidebar-section-rail.spec`)
- **WHEN** run in order
- **THEN** all pass

### Memory

#### R7: Memory reflects present truth
`docs/memory/run-kit/ui/sidebar.md` (§ Collapsible Panels, § WindowPanel) and `docs/memory/run-kit/ui/status-signals.md` (§ Status Bar left-cluster gate sentence, § Pane panel five-register view, § `PR` (L3) register, § Register resolvers `getPrParts`, § Row-hover register flyout card's stale "split pr" claim, two new Design Decisions) are rewritten in present-truth style per the intake's Affected Memory; `ui/index.md` regenerated if a description changes; `fab status set-summary` authored.

### Non-Goals
- Keeping `pr` in the bar while yielding — a follow-up on top of Change 2 (deviation recorded in the intake).
- Continuation lines for `out`/`agt`/`opr`; the mobile drawer panel; any `status-bar.tsx` change.
- A shared fab-composition component lifted from the flyout card.

### Design Decisions

#### PANE-on yields the bar's window cluster
**Decision**: When the PANE section is visible, the sidebar open, and zen off, the terminal-route `StatusBar` receives `window={null}` and keeps only its host cluster.
**Why**: The register view has one desktop home at a time; the bar's window cluster exists because the desktop panel was retired, so an opted-in panel makes it a redundant copy 30 px away. The gate is at the mount (`window={null}` is already the board mount's contract), so no `StatusBar` or `WindowCluster` change is needed and the change stays file-disjoint from the fold rewrite. Zen hides the sidebar without touching the preference, so the `!zenOn` term keeps a register view on screen in zen.
**Rejected**: keeping `pr` in the bar (needs a `StatusBar` prop + `WindowCluster` branch on the file the fold rewrites; the panel shows `pr` open-first); yielding whenever the sidebar is open (the default desktop has the sidebar open and the panel off); a settings surface (Constitution IV).
*Introduced by*: 260914-msji-pane-panel-yield-continuation

#### The panel adopts the card's continuation rule
**Decision**: The `pr` and `fab` rows split into a key line of decisive tokens and a dim `pl-[6ch]` continuation line for the expendable tail (PR health; the off-branch slug), two lines maximum, the continuation rendered only with content; the identity/health split is the shared `getPrParts` resolver.
**Why**: Truncation is unavoidable at the 220 px default, so the layout chooses what gets cut — the same reasoning as the flyout card's decision. `6ch` is the panel's value column (4-advance key + 2-advance icon cell); the card's `4ch` is the same rule on a surface with no icon. A resolver split keeps the rule shared across surfaces (Constitution X) and makes the already-documented `getPrParts` real.
**Rejected**: truncating the tail (cuts the health facts and the off-branch signal first); three-line rows; slicing `prSegments` inline in the panel (a per-surface rule).
*Introduced by*: 260914-msji-pane-panel-yield-continuation

## Tasks

### Phase 2: Core Implementation

- [x] T001 Add `getPrParts(win)` to `app/frontend/src/components/sidebar/registers.ts` (identity + health `PrSegment[]`, null without `prNumber`) and rewrite `getPrSegments` as `[...identity, ...health]`; update the header/doc comments; add `getPrParts` cases to `registers.test.ts` and pin `getPrSegments` equality. <!-- R2 -->
- [x] T002 Rewrite the `pr` and `fab` rows in `app/frontend/src/components/sidebar/status-panel.tsx` as key line + continuation line (`pr-line-cont` from `getPrParts().health`, `fab-line-cont` from `getFabParts().slug`), the anchor spanning both `pr` lines with the copy icon on the key line, the no-URL branch and the fab row inside their `CopyableRow` buttons, `pl-[6ch] text-text-secondary min-w-0 truncate` continuation styling; update the header comments; extend `status-panel.test.tsx` (pr split open/merged, anchor spans both lines, no-URL split, fab slug carried/not carried, continuation classes) and re-point existing full-string `pr-line` assertions. <!-- R3 R4 R5 -->
- [x] T003 Gate the terminal-route `StatusBar` mount in `app/frontend/src/app.tsx` with `useSidebarSectionVisible("pane")`, `sidebarOpen`, and `!zenOn` (`window={paneRegistersVisible ? null : currentWindow ?? null}`), comment stating the constraint; add an `app.test.tsx` describe on the terminal-route harness covering default present / section on ⇒ absent + host present / section on + sidebar closed ⇒ present / runtime toggle flips live. <!-- R1 -->

### Phase 3: Integration & Edge Cases

- [x] T004 Add a desktop `test.describe` to `app/frontend/tests/e2e/pane-register-panel.spec.ts` (default viewport, no `hasTouch`, section not seeded): palette `Panel: Toggle Pane` hides `status-bar-window` and shows the PANE header while `status-bar-host` stays; toggle back restores; section on + sidebar collapsed restores. Extend the mobile `full-stack` test with `pr-line` = `#386 · open`, `pr-line-cont` contains `checks fail`, `fab-line-cont` count 0. Update the file header and every touched `test()` JSDoc. Run `cd app/frontend && npx tsc --noEmit`, `just test-frontend`, `just test-e2e pane-register-panel.spec`, then `just test-e2e status-bar.spec` and `just test-e2e sidebar-section-rail.spec`. <!-- R6 -->

### Phase 4: Polish

- [x] T005 Update `docs/memory/run-kit/ui/sidebar.md` and `docs/memory/run-kit/ui/status-signals.md` per the intake's Affected Memory (present-truth rewrites, two Design Decisions, the `getPrParts` reconciliation, the corrected flyout-card `pr` one-line claim, the left-cluster gate sentence); run `fab docs-index docs/memory`; `fab status set-summary`. <!-- R7 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: The terminal-route mount passes `window={null}` exactly when `pane` section visible ∧ `sidebarOpen` ∧ `!zenOn`; `status-bar.tsx` and its props are untouched (`git diff --stat` shows no `status-bar.tsx`)
- [x] A-002 R2: `getPrParts` exists with the identity/health split; `getPrSegments` is its concatenation and the pre-existing `registers.test.ts` pins pass unchanged
- [x] A-003 R3: The `pr` row renders `pr-line` (identity) + `pr-line-cont` (health) in both URL and no-URL branches from one shared JSX source
- [x] A-004 R4: The `fab` row renders the slug only on `fab-line-cont` and only when `getFabParts(win, gitBranch).slug` is defined
- [x] A-005 R7: Both memory files describe the gate, the two-line rows, the real `getPrParts`, and the card's one-line `pr`; indexes regenerated; summary set

### Behavioral Correctness

- [x] A-006 R1: Collapsing the sidebar or entering zen with the section on brings `status-bar-window` back; toggling the section flips the bar live without remount
- [x] A-007 R3: A merged/closed PR renders one line (no `pr-line-cont`); the anchor's `hover:bg-bg-inset` block and open-first cover both lines; the copy icon sits on the key line
- [x] A-008 R5: No panel row exceeds two lines; `tmx`/`cwd`/`git`/`out`/`agt`/`opr` render exactly as before

### Scenario Coverage

- [x] A-009 R6: `status-panel.test.tsx`, `registers.test.ts`, `app.test.tsx` cover the scenarios above; `just test-frontend` (full suite) passes; `tsc --noEmit` clean
- [x] A-010 R6: `just test-e2e pane-register-panel.spec` passes with the new desktop describe + continuation assertions; `status-bar.spec` and `sidebar-section-rail.spec` pass unedited; every touched `test()` has a Proves/Steps JSDoc

### Edge Cases & Error Handling

- [x] A-011 R3: A PR with `prChecks: none` / `prReview: none` or missing state renders no empty continuation line
- [x] A-012 R4: A fab change with no slug (unparseable slug) or a paneless window renders no empty `fab-line-cont`

### Code Quality

- [x] A-013 Pattern consistency: New code follows the panel's `CopyableRow`/`PrLinkRow` structure, the resolvers' pure-function style, and the e2e file's mocked-socket idiom
- [x] A-014 No unnecessary duplication: identity/health JSX built once per row; no second copy of the split rule outside `registers.ts`
- [x] A-015 Comment narration: comments state constraints (why the copy icon anchors to the key line, why `6ch`), no change-ID citations, no history
- [x] A-016 Type narrowing over assertions in new TS; no `as` casts introduced
- [x] A-017 Tests included for every added/changed behavior (code-quality.md principle)

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

None — this change adds new functionality (the mount gate, the `getPrParts` split, the continuation lines) without making existing code redundant. The replaced pieces (the inline slug in the `fab` key line, the one-line `getPrSegments` body) were rewritten in place, leaving no dead code. (`getFabLine`'s test-only consumer status predates this change.)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | The copy icon in the two-line `pr` anchor is anchored to the key line by wrapping the key line in its own `relative` row (icon `top-1/2` of that row), rather than a computed offset on the block | Keeps the existing icon markup; the wrapper is the only structural change | S:60 R:90 A:85 D:75 |
| 2 | Confident | `CopyableRow` gains an opt-in `block` form (no `truncate` on the button; children are two truncating lines) rather than a new component | Smallest diff consistent with the existing `flex` prop precedent | S:60 R:90 A:85 D:75 |
| 3 | Confident | The `app.test.tsx` gate test seeds `localStorage` before render and toggles at runtime through the hook's pub/sub via a `window.dispatchEvent(new StorageEvent…)` or the palette action, whichever the harness exposes cleanly | The hook is `useLocalStorageBoolean`; both seams are documented pub/sub entries | S:55 R:90 A:75 D:65 |

3 assumptions (0 certain, 3 confident, 0 tentative).
