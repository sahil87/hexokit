# Plan: Register Value Diet

**Change**: 260914-pnfe-register-value-diet
**Intake**: `intake.md`

## Requirements

All paths are under `app/frontend/` unless stated. Wire values (`WindowInfo.activity`, `agentState`, `fabDisplayState`, `panes[].gitBranch`, …) are untouched — every requirement is render-only. The five signal registers stay orthogonal: nothing merges, drops, or reorders a register.

### Registers: branch-aware fab resolvers

#### R1: The slug is written once — the branch carries it
`getFabParts(win, branch?)` and `getFabLine(win, branch?)` in `src/components/sidebar/registers.ts` SHALL accept an optional second argument `branch?: string`. When `branch` is provided and `branch.endsWith(`${id}-${slug}`)` is true, `FabParts.slug` SHALL be `undefined` and the line SHALL read `<id> · <stage>[ · <displayState>]`. Otherwise both SHALL behave as today (`<id> <slug> · <stage>[ · <displayState>]`). `FabParts.slug` becomes optional (`slug?: string`). All three consumers (`status-panel.tsx` `WindowContent`, `row-flyout-card.tsx` window card, `status-bar.tsx` `WindowCluster`) SHALL pass the active pane's `gitBranch` (`win.panes?.find(p => p.isActive)?.gitBranch`). The copy value on every surface stays the 4-char id.

- **GIVEN** `fabChange: "260913-png4-compose-default-on"`, `fabStage: "apply"`, `fabDisplayState: "active"` and the active pane's `gitBranch` is `260913-png4-compose-default-on`
- **WHEN** `getFabLine(win, gitBranch)` is called
- **THEN** it returns `png4 · apply · active` and `getFabParts(win, gitBranch).slug` is `undefined`

- **GIVEN** the same window with `gitBranch: "main"`, or with no `branch` argument
- **WHEN** the resolvers are called
- **THEN** they return `png4 compose-default-on · apply · active` and `slug` is `"compose-default-on"`

- **GIVEN** the row flyout card renders a window whose active pane branch carries the change
- **WHEN** the card body renders
- **THEN** `row-flyout-fab-slug` is absent; when the branch does not carry it, the continuation line renders the slug as today

#### R2: fab displayState renders in the fab hue vocabulary
`src/components/pr-status-model.ts` SHALL export `FAB_STATE_COLORS: Record<string, string>` mapping `active` and `done` → `text-accent-green`, `ready` and `pending` → `text-signal-yellow`, `failed` → `text-signal-red`. The panel `fab` row, the flyout `row-flyout-fab` line, and the bar `fab` segment SHALL compose from `getFabParts` and render the ` · <displayState>` token in a span carrying `FAB_STATE_COLORS[displayState] ?? ""` (unknown or absent state ⇒ no extra class, token still rendered when present). `getFabLine` stays the plain-text form used for copy/aria/`title`. On copyable surfaces the existing `group-hover:text-accent` hover treatment continues to apply to the whole value.

- **GIVEN** `fabDisplayState: "failed"`
- **WHEN** the PANE panel `fab` row renders
- **THEN** the `failed` token is inside a span whose class includes `text-signal-red`, and the row's copy value is the 4-char id

- **GIVEN** `fabDisplayState: "ready"`
- **WHEN** the flyout card `row-flyout-fab` line renders
- **THEN** its text is `fab <id> · <stage> · ready` and the `ready` token's span includes `text-signal-yellow`

### Registers: identity-row and L0 grammar

#### R3: `tmx` shows the pane id; the ordinal only disambiguates
`getTmxLabel(win)` SHALL return the active pane's id alone when `panes.length <= 1` (`%107`), and `<id> · <ordinal>/<count>` when `panes.length > 1` (`%109 · 3/3`), where ordinal is the active pane's 1-based position in `win.panes` (fallback 1 when no pane is active, as today). When the active pane id is empty, the ` · ` and id are omitted (`3/3` for multi-pane; `""` for a single pane). The three consumers already render `getTmxLabel(win)` and need no change beyond the resolver. Copy value stays `activePane.paneId`.

- **GIVEN** one pane `{ paneId: "%107", paneIndex: 1, isActive: true }`
- **WHEN** `getTmxLabel` is called
- **THEN** it returns `%107`

- **GIVEN** three panes with the third active (`%109`)
- **WHEN** `getTmxLabel` is called
- **THEN** it returns `%109 · 3/3`

- **GIVEN** three panes, none marked active or the active id empty
- **WHEN** `getTmxLabel` is called
- **THEN** it returns `1/3`

#### R4: L0 says `flowing`; no narration
`getOutputLine(win, nowSeconds)` SHALL return: `activity === "active"` ⇒ `<cmd> · flowing` (or `flowing` with no command); otherwise, with a positive elapsed from `activityTimestamp` ⇒ `<cmd> · idle <dur>` (or `idle <dur>`); with no usable timestamp ⇒ `<cmd>` (or `idle`). The strings `active · ` and ` since last output` SHALL no longer appear. `getAgentLine` (L1 vocabulary) is unchanged. The per-second `useNow()` tick stays in `WindowContent`.

- **GIVEN** `activity: "active"`, active pane command `claude`
- **WHEN** `getOutputLine` is called
- **THEN** it returns `claude · flowing`

- **GIVEN** idle, command `zsh`, `activityTimestamp` 240 s before `nowSeconds`
- **WHEN** `getOutputLine` is called
- **THEN** it returns `zsh · idle 4m`

- **GIVEN** idle, no command, no timestamp
- **WHEN** `getOutputLine` is called
- **THEN** it returns `idle`

### Pane panel: `cwd` and `git` rows

#### R5: `cwd` is basename-first; the parent yields
In `src/components/sidebar/status-panel.tsx` the `cwd` row value SHALL render as two spans inside a `flex min-w-0` wrapper: the parent (`abbreviateHomePath(dirname)` including its trailing `/`) in `text-text-secondary min-w-0 truncate` with head-truncation (`dir="rtl"` on the span, the text isolated in `<bdi dir="ltr">`), and the basename in `shrink-0 text-text-primary` (with `group-hover:text-accent`). `shortenPath` and its `describe("shortenPath")` unit block SHALL be deleted. A single-segment or root path renders the whole value as basename with no parent span. When `cwdMissing`, both spans are `text-signal-red` and the `(deleted)` marker (`data-testid="cwd-deleted"`) follows the basename. `title` (full path, `(no longer exists)` suffix when missing) and the copy value (full unabbreviated path) are unchanged. The status bar's `cwd` segment stays basename-only. The rtl+`bdi` idiom SHALL be verified in Chromium (e2e: the basename is never clipped when the parent is long); if the ellipsis renders at the wrong end, fall back to a measured JS middle-ellipsis and record the switch in `## Assumptions`.

- **GIVEN** active pane cwd `/home/sahil/code/sahil87/run-kit.worktrees/register-value-diet`
- **WHEN** the `cwd` row renders
- **THEN** the parent span text is `~/code/sahil87/run-kit.worktrees/` (dim, `dir="rtl"`, containing a `<bdi dir="ltr">`), the basename span text is `register-value-diet` (`shrink-0`), and the row `title` is the full path

- **GIVEN** the same cwd with `cwdMissing: true`
- **WHEN** the row renders
- **THEN** both spans carry `text-signal-red` and `cwd-deleted` is present

- **GIVEN** a 220 px-wide sidebar and a long parent path (e2e)
- **WHEN** the panel renders
- **THEN** the basename element's bounding box lies fully inside the row (not clipped) and the parent span is present

#### R6: The date prefix dims on the `git` row and the bar `⑂` segment
A shared helper `splitDatePrefix(branch: string): { prefix: string; rest: string }` in `registers.ts` SHALL split a leading `^\d{6}-` from the branch (`prefix` empty when absent). The PANE `git` row and the status-bar `⑂` `CopySegment` SHALL render `prefix` in `text-text-secondary` and `rest` in `text-text-primary` (hover treatment unchanged). The overflow-menu `⑂` row stays plain. Copy values are unchanged (full branch).

- **GIVEN** `gitBranch: "260913-png4-compose-default-on"`
- **WHEN** the `git` row and the bar `⑂` segment render
- **THEN** `260913-` is in a `text-text-secondary` span and `png4-compose-default-on` in `text-text-primary`; clicking either copies the full branch

- **GIVEN** `gitBranch: "main"`
- **WHEN** they render
- **THEN** no dim prefix span is rendered and the value reads `main`

### Tests and spec

#### R7: Unit and e2e coverage follows the new grammar
Unit tests (`registers.test.ts`, `status-panel.test.tsx`, `row-flyout-card.test.tsx`, `status-bar.test.tsx`) SHALL cover every GIVEN/WHEN/THEN above and the existing `pane 1/1 %5`, `active · `, `since last output` expectations SHALL be rewritten. E2e: `tests/e2e/status-bar.spec.ts` SHALL assert `%1` where it asserted `pane 1/1 %1` (~lines 128, 200, 209) and its JSDoc `Proves`/`Steps` text updated (~114–115, ~302–310); the fab assertion `/ldbs shell-stage-status-bar · apply/` (~132) stays valid because the fixture branch is `main` (state that in the intent comment). `tests/e2e/pane-register-panel.spec.ts` @1 fixture SHALL gain `gitBranch: "260706-y1ar-status-pyramid-ui-surfacing"` and a long `cwd`, and the spec SHALL assert the fab register reads `y1ar · review · failed` (no slug) plus the R5 basename-not-clipped scenario, keeping the `waiting 3m` and `register-output` assertions. Every touched `test()` JSDoc MUST be updated in the same commit (Constitution Test Intent Comments). `tooltips.spec.ts` is unchanged.

- **GIVEN** the four Vitest files and the two e2e specs
- **WHEN** `cd app/frontend && npx tsc --noEmit`, `pnpm vitest run <the four files>`, `just test-e2e status-bar.spec`, `just test-e2e pane-register-panel.spec` run
- **THEN** all pass

#### R8: Spec example block reflects the diet
`docs/specs/status-pyramid.md` § Row Minimalism example block SHALL read `out  claude · flowing` (replacing the `active · 4s since last output` form) and keep the id-form `fab  dmex · review · failed`; one sentence SHALL be added after the block: *the slug is written once — the branch carries it.* Memory files (`docs/memory/run-kit/ui/status-signals.md`, `sidebar.md`) are hydrate's, not apply's.

- **GIVEN** the spec file
- **WHEN** § Row Minimalism is read
- **THEN** the `out` example uses `flowing`, no `since last output` remains, and the slug-once sentence is present

### Non-Goals

- The `agt` vocabulary, `getAgentLine`, or the `StatusDot` — L1 is hook-written and cross-repo
- Any breakpoint/ladder or fold change in `status-bar.tsx` (change 2 rewrites the file)
- Two-line / continuation rows in the panel (change 3)
- The status-bar `cwd` segment's form (stays basename-only)
- Memory updates (hydrate stage)

### Design Decisions

#### The slug is written once — the branch carries it
**Decision**: `getFabParts`/`getFabLine` take the active pane's branch and omit the slug when the branch ends with `<id>-<slug>`.
**Why**: A fab pane's branch is the change folder name, so the `git` row already shows id + slug; a slug beside a `main` or hand-named branch is itself the signal that the pane is off its change branch.
**Rejected**: Dropping the `git` row when it equals the change — it is the most-copied row. Trimming per surface — the shared resolver exists so the three surfaces cannot disagree.
*Introduced by*: 260914-pnfe-register-value-diet

#### `tmx` shows the pane id; the ordinal only disambiguates
**Decision**: `%107` for a one-pane window, `%107 · 2/3` for multi-pane.
**Why**: The id is the copyable value and what an operator types into tmux; `pane 1/1` spends eight characters saying nothing for the common case.
**Rejected**: Keeping `pane n/m` and dropping the id — the id is the row's reason to exist.
*Introduced by*: 260914-pnfe-register-value-diet

#### `cwd` is basename-first; the parent yields
**Decision**: Two spans — a dim head-truncating parent and a `shrink-0` primary basename.
**Why**: The worktree basename is the answer and must never be the part that truncates; the parent is context.
**Rejected**: `shortenPath`'s keep-last-two-segments plus tail `truncate` — truncates the basename first at the 220 px default.
*Introduced by*: 260914-pnfe-register-value-diet

#### L0 says `flowing`, L1 says `active`
**Decision**: `out` reads `<cmd> · flowing` / `<cmd> · idle Xm`; the "since last output" narration is gone.
**Why**: "flowing" is the spec's own L0 word (§ Duration-Text Ladder), keeping L0 (bytes) lexically distinct from L1 (`active` agent state), and the tier-1 tip already carries the narration.
**Rejected**: Renaming the L1 vocabulary — written by harness hooks, read cross-repo (`agent-state.md`).
*Introduced by*: 260914-pnfe-register-value-diet

#### fab state hue is its own map, not `PHASE_HUE`
**Decision**: `FAB_STATE_COLORS` in `pr-status-model.ts`, keyed by `fabDisplayState`.
**Why**: `PHASE_HUE` is keyed by dot phase (building / prReady), not by display state; the state token needs green-running / yellow-gated / red-failed, the same signal tokens the PR vocabulary uses.
**Rejected**: Reusing `PHASE_HUE` — `ready` and `failed` have no phase key.
*Introduced by*: 260914-pnfe-register-value-diet

## Tasks

### Phase 1: Setup

- [x] T001 Add `FAB_STATE_COLORS` (active/done green, ready/pending yellow, failed red) beside `PR_STATE_COLORS` in `src/components/pr-status-model.ts` with a constraint-stating doc comment (no change-id citations) <!-- R2 -->

### Phase 2: Core Implementation

- [x] T002 `src/components/sidebar/registers.ts`: make `FabParts.slug` optional; add `branch?: string` to `getFabParts`/`getFabLine`; omit the slug iff `branch.endsWith(`${id}-${slug}`)`; rewrite the module and function doc comments (three surfaces, branch rule) <!-- R1 -->
- [x] T003 `registers.ts`: rewrite `getTmxLabel` to the `%id` / `%id · n/m` grammar (empty-id and no-active fallbacks per R3) and its doc comment <!-- R3 -->
- [x] T004 `registers.ts`: rewrite `getOutputLine` to `<cmd> · flowing` / `<cmd> · idle <dur>` / `<cmd>` / `idle` and its doc comment <!-- R4 -->
- [x] T005 `registers.ts`: add `splitDatePrefix(branch)` returning `{ prefix, rest }` on `^\d{6}-` <!-- R6 -->
- [x] T006 `src/components/sidebar/registers.test.ts`: cover R1 (slug carried / not carried / `main` / no arg), R3 (three shapes), R4 (six shapes), `splitDatePrefix` (prefix present / absent); rewrite the existing `active · ` / `since last output` / `pane 1/1` expectations <!-- R7 -->
- [x] T007 `src/components/sidebar/status-panel.tsx`: pass `gitBranch` to `getFabParts`/`getFabLine`; render the `fab` row from parts with the state token in `FAB_STATE_COLORS`; replace `shortenPath` with the two-span `cwd` value (flex wrapper, rtl+`bdi` parent, `shrink-0` basename, deleted-marker and title rules per R5) and delete `shortenPath`; render the `git` row via `splitDatePrefix`; update the file's header/row comments <!-- R1 R2 R5 R6 -->
- [x] T008 `src/components/sidebar/status-panel.test.tsx`: delete the `shortenPath` describe and helper comment; add cwd two-span, single-segment, and deleted cases; `git` dim prefix present/absent; `out` strings; `fab` state colour class; `tmx` single-pane `%5` <!-- R7 -->
- [x] T009 [P] `src/components/sidebar/row-flyout-card.tsx`: pass the active pane's `gitBranch` to `getFabParts`; render the state token with `FAB_STATE_COLORS`; `row-flyout-card.test.tsx`: keep the existing slug-continuation case and add a branch-carries-slug case (continuation absent) plus the coloured state token <!-- R1 R2 R7 -->
- [x] T010 [P] `src/components/status-bar.tsx`: pass `gitBranch` to `getFabLine`/`getFabParts` and render the `fab` segment's state token with `FAB_STATE_COLORS`; render the `⑂` `CopySegment` via `splitDatePrefix` (overflow row unchanged); update the header comment's value examples; `status-bar.test.tsx`: `pane 1/1 %5` → `%5` (strip + overflow row), fab string with/without slug, `⑂` dim prefix span <!-- R1 R2 R3 R6 R7 -->

### Phase 3: Integration & Edge Cases

- [x] T011 [P] `tests/e2e/status-bar.spec.ts`: `pane 1/1 %1` → `%1` at every site; update the `Proves`/`Steps` JSDoc and the file header; note in the fab assertion's intent comment that the `main` fixture branch keeps the slug <!-- R7 -->
- [x] T012 [P] `tests/e2e/pane-register-panel.spec.ts`: give @1's active pane `gitBranch: "260706-y1ar-status-pyramid-ui-surfacing"` and a long `cwd` (e.g. `/home/sahil/code/sahil87/run-kit.worktrees/status-pyramid-ui-surfacing`); assert the fab register text is `y1ar · review · failed` and does not contain `status-pyramid-ui-surfacing`; assert the `cwd` basename element is fully within the row's bounding box and the parent span is present; update JSDoc + header <!-- R5 R7 -->
- [x] T013 Run `cd app/frontend && npx tsc --noEmit`, `pnpm vitest run src/components/sidebar/registers.test.ts src/components/sidebar/status-panel.test.tsx src/components/sidebar/row-flyout-card.test.tsx src/components/status-bar.test.tsx`, then `just test-e2e status-bar.spec` and `just test-e2e pane-register-panel.spec` (single specs only, run from the repo root); fix failures <!-- R7 -->

### Phase 4: Polish

- [x] T014 `docs/specs/status-pyramid.md` § Row Minimalism: `out  claude · flowing` in the example block, keep the id-form `fab` example, add the slug-once sentence after the block <!-- R8 -->

## Execution Order

- T001–T005 before T007/T009/T010 (consumers depend on the resolver signatures and the colour map)
- T006 and T008 alongside their source tasks; T013 after all of T006–T012

## Acceptance

### Functional Completeness

- [x] A-001 R1: `getFabParts`/`getFabLine` accept `branch?` and omit the slug exactly when `branch.endsWith(id-slug)`; `FabParts.slug` is optional; all three consumers pass the active pane's `gitBranch`
- [x] A-002 R2: `FAB_STATE_COLORS` exists in `pr-status-model.ts` with the five keys and the three surfaces colour the state token from it
- [x] A-003 R3: `getTmxLabel` returns `%id` single-pane and `%id · n/m` multi-pane with the empty-id fallbacks
- [x] A-004 R4: `getOutputLine` returns the six R4 shapes; `active · ` and `since last output` no longer appear anywhere in `src/`
- [x] A-005 R5: the `cwd` row renders the two-span value with rtl+`bdi` head truncation and a `shrink-0` basename; `shortenPath` is gone
- [x] A-006 R6: `splitDatePrefix` exists and the `git` row plus bar `⑂` segment dim the date prefix; the overflow row and copy values are unchanged
- [x] A-007 R8: the spec example block and slug-once sentence are updated

### Behavioral Correctness

- [x] A-008 R1: with `gitBranch: "main"` (or no branch) the slug still renders on all three surfaces — the off-branch signal is preserved
- [x] A-009 R2: `getFabLine` output (copy/aria/title) contains no colour markup and is unchanged in form
- [x] A-010 R5: `cwdMissing` colours both spans red and keeps `cwd-deleted`; `title` and copy value are the full path
- [x] A-011 R3: the panel copy value stays `paneId` and the bar's paneId-less `tmx` fork stays passive

### Removal Verification

- [x] A-012 R5: no reference to `shortenPath` remains in `src/` or tests — the function and its `describe` block are deleted; the stale doc-comment mention at `app/frontend/src/lib/format.ts:29` was dropped after review (should-fix #1)

### Scenario Coverage

- [x] A-013 R7: `registers.test.ts` covers R1/R3/R4/R6 scenarios; `status-panel.test.tsx` covers R5/R6/R2; `row-flyout-card.test.tsx` covers the branch-gated continuation; `status-bar.test.tsx` covers `%5`, fab with/without slug, `⑂` prefix
- [x] A-014 R7: `status-bar.spec.ts` asserts `%1` and its intent comments match the test bodies; `pane-register-panel.spec.ts` asserts the slug-less fab line and the unclipped basename with updated intent comments
- [x] A-015 R7: `tsc --noEmit`, the four Vitest files, and the two single e2e specs pass

### Edge Cases & Error Handling

- [x] A-016 R5: a single-segment or root cwd renders as basename only with no parent span
- [x] A-017 R2: an unknown `fabDisplayState` renders the token with no colour class; an absent state renders no token
- [x] A-018 R3: a multi-pane window with no active pane renders `1/<count>`

### Code Quality

- [x] A-019 Pattern consistency: new spans/wrappers follow the file's existing Tailwind token vocabulary (`text-text-secondary`/`text-text-primary`/`text-signal-*`, `group-hover:text-accent`) and the flex-wrapper idiom `PrLinkRow` already uses
- [x] A-020 No unnecessary duplication: the branch rule, tmx grammar, and date-prefix split live only in `registers.ts`; no surface re-derives them
- [x] A-021 Type narrowing over assertions: no new `as` casts or `!` non-null assertions introduced (production code clean; the two new test-file `!` follow the established in-file idiom, e.g. `status-panel.test.tsx:952`)
- [x] A-022 Comment rule: new or rewritten comments state constraints, never narrate history or cite change IDs / PR numbers (one nice-to-have: the rewritten `registers.ts` module header keeps the pre-existing `(93dy)` citation)
- [x] A-023 Tests included: every changed behaviour has a unit test; the two UI changes visible at the e2e layer have e2e coverage

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`
- Hydrate: `docs/memory/run-kit/ui/status-signals.md` (five-register grammar block + L0/L2 bullets, identity-rows sentence, § Register resolvers `branch` param / `getTmxLabel` / `getOutputLine` / `splitDatePrefix`, § Row-hover flyout card slug gate, § Status Bar left-cluster strings, § Shared PR vocabulary `FAB_STATE_COLORS`) and `sidebar.md` (WindowPanel `tmx`/`cwd`/`git` descriptions, Copyable rows display column, `cwd` deleted-marker paragraph); lift the five Design Decisions above. Present-truth style; resolve relative `](x.md)` links across `docs/memory/run-kit/ui/`.
- Worker constraints: this worktree runs e2e as single specs only (`just test-e2e <name>.spec`) — never the full suite. Run `just` recipes from the repo root.

## Deletion Candidates

- `app/frontend/src/components/sidebar/registers.ts:107` `getFabLine` — this change moved its last two production consumers (the PANE panel and the status bar) to `getFabParts` composition; the export now has zero production call sites (only `registers.test.ts` exercises it), and the plan's "plain-text form for copy/aria/title" role has no consumer. Kept here as a thin wrapper over `getFabParts`; remove it (and its describe block) if changes 2/3 do not adopt it.
- `app/frontend/src/components/status-bar.tsx:423-429` — the non-copy `Segment` fork of the fab segment is unreachable: `fabParts` non-null implies `parseFabChange` non-null (same gate), so the `fabChange ?` branch always wins. Pre-existing dead branch, but this change rewrote both arms without noticing.
- `app/frontend/src/lib/format.ts:29` — doc comment names "the PANE panel's shortenPath" as an `abbreviateHomePath` consumer; `shortenPath` was deleted by this change. Drop the mention (comment-only).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | `pending` shares `ready`'s yellow in `FAB_STATE_COLORS` | Backend groups active/ready/pending as in-progress; only `ready` is named in the plan | S:65 R:90 A:75 D:65 |
| 2 | Confident | Head truncation via `dir="rtl"` + `<bdi dir="ltr">`; e2e asserts the basename is unclipped rather than the ellipsis position | jsdom cannot render; bounding-box check is the testable half of the requirement | S:80 R:80 A:60 D:70 |
| 3 | Confident | `splitDatePrefix` lives in `registers.ts` (not `lib/format.ts`) | It is a register-surface rendering rule shared by two surfaces — the module's purpose | S:70 R:95 A:85 D:75 |
| 4 | Certain | Spec § Row Minimalism edit is an apply task; memory edits are hydrate's | Plan step 7 lists both; pipeline stage ownership splits them | S:90 R:95 A:95 D:95 |
| 5 | Confident | The bar's overflow-menu `⑂` row stays plain (no dim prefix) | It is a menu item; the intake scopes the dim prefix to the strip segment and the panel row | S:75 R:95 A:85 D:80 |

5 assumptions (1 certain, 4 confident, 0 tentative).
