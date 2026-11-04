# Plan: Palette Search Ranking

**Change**: 260903-s91a-palette-search-ranking
**Intake**: `intake.md`

## Requirements

### Palette Ranking: match-quality ordering

#### R1: Six-tier match ladder
`rankActions` SHALL classify every action that matches the query into exactly one tier, and SHALL order tiers ascending (0 best). The tiers, evaluated against the lowercased label unless stated otherwise, are:

| Tier | Name | Rule |
|------|------|------|
| 0 | Exact | the whole label equals the query, **or** the label carries a `"<Category>: "` prefix whose category equals the query |
| 1 | WholeWord | some word of the label equals the query |
| 2 | WordStart | some word of the label starts with the query and is longer than it |
| 3 | Acronym | the query is a contiguous substring of the label's word-initials string |
| 4 | Incidental | the label contains the query and no higher tier applied — an alphanumeric query is then necessarily strictly inside a word (a word-initial one would have matched tier 1 or 2); a boundary-spanning query (`kit: r`) also lands here, which is what keeps R5's membership superset intact |
| 5 | DescriptionOnly | the label does not contain the query; the lowercased description does |

The first tier whose rule holds wins.

- **GIVEN** the actions `PR: Refresh Status`, `Open: PR #3127`, `Server: Protect default`, `Server: Protect noon`, `Server: Protect runkit`, `Layout: Promote Web` declared in that source order
- **WHEN** the query is `pr`
- **THEN** `PR: Refresh Status` is first (tier 0 — category `PR` equals the query)
- **AND** `Open: PR #3127` is second (tier 1 — the word `PR` equals the query)
- **AND** all four `Protect` / `Promote` rows follow both of them (tier 2 — the query is a strict word prefix)

- **GIVEN** the action `PR: Refresh Status`
- **WHEN** the query is `prs`
- **THEN** it matches at tier 3 (initials `prs`)
- **AND** the query `ps` does not match it at tier 3, because the initials run must be contiguous

#### R2: Tokenization and category extraction
A *word* SHALL be a maximal run of `[a-z0-9]` in the lowercased label; every other character is a boundary. The *category* SHALL be the substring preceding the first `": "` in the label, lowercased, and SHALL be absent when the label contains no `": "`.

- **GIVEN** the label `Open: PR #3127`
- **WHEN** it is tokenized
- **THEN** the words are `["open", "pr", "3127"]` and the category is `open`

- **GIVEN** the label `run-kit: Restart Daemon`
- **WHEN** it is tokenized
- **THEN** the words are `["run", "kit", "restart", "daemon"]` and the category is `run-kit`

- **GIVEN** the label `Reload tmux config` (no `": "`)
- **WHEN** the category is extracted
- **THEN** no category is produced, and tier 0 can only be reached by a whole-label match

#### R3: Within-tier ordering chain
Within one tier, `rankActions` SHALL order by, in strict precedence: (a) **density** `query.length / label.length` descending — computed on the label alone, never including the description; (b) **MRU** — an action whose `id` appears in the supplied MRU list ranks above one that does not, and between two present ids the lower index (more recent) ranks first; (c) **declaration order** — the action's index in the input array, ascending.

- **GIVEN** two tier-2 actions `Server: Protect noon` (20 chars) and `Server: Protect default` (23 chars), neither in the MRU
- **WHEN** the query is `pr`
- **THEN** `Server: Protect noon` ranks first, on density

- **GIVEN** two actions in the same tier with identical label lengths, the second of which has its id in the MRU
- **WHEN** they are ranked
- **THEN** the MRU'd action ranks first, ahead of its declaration position

- **GIVEN** two actions in the same tier with identical label lengths and neither in the MRU
- **WHEN** they are ranked
- **THEN** their relative order equals their order in the input array

#### R4: Empty query
When the query is empty or whitespace-only, `rankActions` SHALL return every action with no filtering and no tiering, ordered MRU-first (by recency) then declaration order.

- **GIVEN** eight registered actions, of which the third and seventh have ids in the MRU (seventh more recent)
- **WHEN** the query is `""`
- **THEN** all eight are returned, the seventh first, the third second, and the remaining six in their declaration order

#### R5: Membership superset and purity
`rankActions` SHALL NOT drop any action the pre-change filter admitted — a case-insensitive `includes` of the query against `label` or `description`. It SHALL additionally admit acronym matches (R1 tier 3), which are a deliberate and unavoidable expansion: an acronym query is by construction not a substring of the label, so the Acronym tier cannot coexist with strict set equality. An action matching no tier SHALL be excluded, and the input array SHALL NOT be mutated.

- **GIVEN** any action list and any non-empty query
- **WHEN** `rankActions` runs
- **THEN** the returned set (ignoring order) is a SUPERSET of `actions.filter(a => a.label.toLowerCase().includes(q) || (a.description?.toLowerCase().includes(q) ?? false))`
- **AND** every element it adds beyond that set matched at tier `Acronym`
- **AND** the input array's contents and order are unchanged

- **GIVEN** the action `New Session` and the query `ns`
- **WHEN** `rankActions` runs
- **THEN** `New Session` IS returned, at tier `Acronym`, even though `"new session".includes("ns")` is `false` — the pre-change filter would have excluded it

### Palette MRU: per-viewer recency memory

#### R6: MRU storage module
`lib/palette/mru.ts` SHALL persist a recency-ordered list of palette action ids in `localStorage` under the key `runkit-palette-mru`, capped at `PALETTE_MRU_LIMIT` (20), most-recent-first. `readPaletteMru()` SHALL return `[]` when the key is absent, the payload is not a JSON array of strings, or `localStorage` is unavailable, and SHALL NOT throw. `recordPaletteUse(id)` SHALL move `id` to the front (removing any earlier occurrence), truncate to the cap, persist best-effort, and return the new list; a persistence failure SHALL NOT throw.

- **GIVEN** a stored list `["b", "a"]`
- **WHEN** `recordPaletteUse("a")` runs
- **THEN** the stored and returned list is `["a", "b"]` — no duplicate `a`

- **GIVEN** a stored list already at 20 entries
- **WHEN** a new id is recorded
- **THEN** the list is 20 entries long, the new id first and the previously-oldest entry dropped

- **GIVEN** `localStorage.getItem` throws, or the stored value is `"{}"` or `"not json"`
- **WHEN** `readPaletteMru()` runs
- **THEN** it returns `[]` without throwing

#### R7: Recording the originating action id
The palette SHALL record the id of the **originating** `PaletteAction` when an action is actually invoked, and SHALL NOT record a synthetic sub-step id (`${id}-confirm`, `${id}-opt-${key}`). It SHALL record nothing for a disabled row, for entering a confirm or option-picker sub-step, or for a cancelled or dismissed palette.

- **GIVEN** an action `kill-server-x` carrying a `confirmLabel`
- **WHEN** the user selects it and then selects the confirmation row
- **THEN** `kill-server-x` is recorded exactly once, and `kill-server-x-confirm` is never recorded

- **GIVEN** an action carrying an `optionPicker`
- **WHEN** the user toggles options and presses Enter to apply
- **THEN** the picker action's own id is recorded, and no `-opt-` id is recorded

- **GIVEN** a `disabled` action
- **WHEN** the user selects it
- **THEN** nothing is recorded and no invocation occurs

### Command palette integration

#### R8: Wiring the ranker into `command-palette.tsx`
`CommandPalette` SHALL replace the plain filter arm of its `filtered` expression with a `useMemo`'d `rankActions(actions, query, mru)` keyed on `[actions, query, mru]`, and SHALL seed its MRU state once from `readPaletteMru()` at mount. The `confirming` and `picking?.optionPicker` branches SHALL be untouched, so sub-step rows are neither filtered nor reordered. No change SHALL be made to the `PaletteAction` type, to the props, to the ARIA wiring, or to which actions any caller registers.

- **GIVEN** the palette is open in an option-picker sub-step
- **WHEN** the rows render
- **THEN** they are the picker's options in the caller's declared order, and `picking.optionPicker.options[selectedIndex]` still addresses the row the user sees

- **GIVEN** a viewer with no stored MRU (or with `localStorage` unavailable)
- **WHEN** the palette opens and a query is typed
- **THEN** results are ordered by tier and density alone, with no error surfaced

### Non-Goals

- Changing which actions exist, or any route/state gate in `lib/palette/*.ts`, `app.tsx`, or `use-global-palette-actions.ts` — this change is a re-sort layered on the existing filter step.
- Changing the filter's membership rule (R5 pins it to today's behavior).
- Adding a fuzzy-matching dependency, a per-action weight/pin field, or any `PaletteAction` schema change.
- Sinking `disabled` rows below enabled ones — `disabled` does not participate in ordering (carried as an open question in `intake.md`).
- Any backend or API surface; MRU is per-viewer localStorage only (Constitution II / IV).
- A new Playwright e2e spec — ordering is pure logic covered by unit tests plus one mounted-component assertion.

### Design Decisions

#### Tier 0 admits the colon-prefix category, not just the whole label

**Decision**: The top tier matches when the query equals the whole label **or** the label's `"<Category>: "` prefix, so `PR: Refresh Status` is a tier-0 hit for query `pr`.
**Why**: The palette's colon prefixes (`Board:`, `Server:`, `Tab:`, `Web:`, `PR:` …) are an advertised command vocabulary — the input placeholder literally teaches `Board: Pin: View: Tab:`. A query that *is* a category is the strongest available statement of intent. It is also what makes the design doc's worked example come out right: under whole-label-only, `PR: Refresh Status` would fall to the whole-word tier alongside `Open: PR #3127` and then lose on density (0.111 vs 0.143), inverting the intended order.
**Rejected**: Whole-label-only exactness — correct in the abstract, but no real palette label is ever typed in full, so tier 0 would be permanently empty and the ladder would start one rung down.
*Introduced by*: 260903-s91a-palette-search-ranking

#### Whole-word outranks word-prefix, so `Protect`/`Promote` sink structurally

**Decision**: The word-start bucket is split in two — WholeWord (the query *is* a word) above WordStart (the query is a strict prefix of a longer word).
**Why**: The originating instruction describes `Server: Protect` and `Layout: Promote` as "incidental mid-word" matches for `pr`, but `Pr` is literally the start of both words; a single word-start bucket therefore ties them with `Open: PR #3127`, which is the exact complaint the change exists to fix. Splitting the bucket makes the required outcome a property of the ladder rather than a coincidence.
**Rejected**: Keeping one word-start bucket and relying on density to separate them. It reproduces this one example, but only by luck — a short label such as `Tab: Promote` (density 0.167) would still outrank `Open: PR #3127` (0.143), reintroducing the defect for any future short label.
*Introduced by*: 260903-s91a-palette-search-ranking

#### Density outranks MRU in the tiebreak chain

**Decision**: Ordering within a tier is density, then MRU, then declaration order.
**Why**: The originating instruction is explicit — density applies "within a bucket" and MRU breaks the "remaining ties" between entries of equal quality. Match quality is a property of the query; recency is a property of the viewer, and letting it outrank a visibly better match would make the list feel unstable.
**Rejected**: MRU before density, which is what the design doc's §3 prose implies (a recently-clicked `Server: Protect runkit` rising above `Server: Protect noon`). The doc is supplementary to the instruction, and the two comparators are adjacent lines if the preference ever reverses.
*Introduced by*: 260903-s91a-palette-search-ranking

## Tasks

### Phase 1: Storage primitive

- [x] T001 [P] Create `app/frontend/src/lib/palette/mru.ts` — export `PALETTE_MRU_KEY = "runkit-palette-mru"`, `PALETTE_MRU_LIMIT = 20`, `readPaletteMru()` and `recordPaletteUse(id)`, following the `lib/last-window-per-server.ts` try/catch-noop read/write shape; a non-array or malformed payload reads as `[]` <!-- R6 -->
- [x] T002 [P] Create `app/frontend/src/lib/palette/mru.test.ts` — round-trip, front-dedupe on repeat, cap eviction at 20, `[]` on absent/malformed/throwing storage, no throw on a failing setter <!-- R6 -->

### Phase 2: Ranking core

- [x] T003 Create `app/frontend/src/lib/palette/rank.ts` — the pure ranking core: word tokenizer and category extraction (R2), `matchTier` implementing the six-tier ladder (R1), and `rankActions` with the density → MRU → declaration comparator chain (R3), the empty-query MRU-first path (R4), and membership parity plus non-mutation (R5). Pure, dependency-free, no React or DOM, per the `lib/palette/shell.ts` / `zen.ts` builder convention <!-- R1 -->
- [x] T004 Create `app/frontend/src/lib/palette/rank.test.ts` — per-tier classification for all six tiers; tokenizer cases (`Open: PR #3127`, `run-kit: Restart Daemon`, `Server: Switch to "work"`); category extraction incl. the no-`": "` label; acronym contiguity (`prs` matches, `ps` does not); density ordering; MRU tiebreak and recency ordering; declaration-order stability; empty-query behavior; non-mutation; membership parity against the pre-change predicate; **and the design-doc regression case** — query `pr` over the six-action fixture yielding `PR: Refresh Status`, `Open: PR #3127`, then the four `Protect`/`Promote` rows <!-- R1 -->

### Phase 3: Integration

- [x] T005 Wire `app/frontend/src/components/command-palette.tsx` — seed MRU state once from `readPaletteMru()`, replace the `actions.filter(...)` arm of `filtered` with a `useMemo`'d `rankActions(actions, query, mru)` keyed on `[actions, query, mru]` (leaving the `confirming` and `picking?.optionPicker` branches untouched), and record the **originating** action id via `recordPaletteUse` on real invocation only — `action.id` for a plain action, `confirming.id` for the confirm row, `picking.id` on the option-picker apply, nothing for disabled rows or cancellation <!-- R8 -->
- [x] T006 Extend `app/frontend/src/components/command-palette.test.tsx` — typing `pr` renders the ranked order; invoking a plain action records its id; a confirm-flow invoke records the base id and never `${id}-confirm`; an option-picker apply records the picker's id; membership parity for a query before/after; sub-step rows keep the caller's order <!-- R7 -->

### Phase 4: Verification

- [x] T007 Run the `fab/project/code-quality.md` gates from the repo root — `cd app/frontend && npx tsc --noEmit`, then `just test` — and fix anything they surface <!-- R8 -->

### Phase 5: Contract correction

- [x] T008 Replace the vacuous membership test in `app/frontend/src/lib/palette/rank.test.ts` — the existing `"preserves the pre-change filter's membership exactly"` case uses a fixture/query (`"new"`) that never reaches the Acronym tier, so it passes without exercising the conflict. Assert the R5 SUPERSET property instead (no legacy match dropped; every extra element matched at tier `Acronym`) and add an explicit expansion case: `rankActions([{ id: "a", label: "New Session" }], "ns", [])` returns the action although the legacy predicate rejects it <!-- R5 -->

## Execution Order

- T001 blocks T002; T003 blocks T004; T001 and T003 are independent of each other
- T005 depends on T001 and T003; T006 depends on T005
- T007 runs last

## Acceptance

### Functional Completeness

- [x] A-001 R1: `matchTier` returns each of the six tiers for a representative label/query pair, and `null` for a non-match
- [x] A-002 R2: The tokenizer splits on every non-alphanumeric character and the category is the text before the first `": "`, absent when the label has none
- [x] A-003 R3: Within a tier, results order by density, then MRU presence and recency, then input index
- [x] A-004 R4: An empty or whitespace-only query returns every action, MRU-first then declaration order
- [x] A-005 R6: `mru.ts` exports the key, the cap, `readPaletteMru` and `recordPaletteUse` with the specified semantics
- [x] A-006 R8: `command-palette.tsx` renders `rankActions` output for the plain arm and seeds MRU state at mount

### Behavioral Correctness

- [x] A-007 R1: For query `pr` over the six-action fixture, `PR: Refresh Status` is first and `Open: PR #3127` second, with every `Protect`/`Promote` row below both — the design-doc regression case
- [x] A-008 R5: No action the pre-change filter admitted is dropped (superset property), every extra admitted action matched at tier `Acronym`, and the input array is not mutated
- [x] A-009 R7: A confirm-flow invocation records the base action id; `${id}-confirm` and `${id}-opt-*` ids are never recorded
- [x] A-010 R8: The `confirming` and `picking?.optionPicker` branches of `filtered` are byte-identical to before, so sub-step rows keep the caller's order and `options[selectedIndex]` still addresses the rendered row

### Scenario Coverage

- [x] A-011 R1: A unit test asserts acronym contiguity — `prs` matches `PR: Refresh Status`, `ps` does not
- [x] A-012 R3: A unit test asserts the MRU tiebreak fires only after density, i.e. a shorter equal-tier label still outranks a recently-used longer one
- [x] A-013 R7: A component test asserts the recorded id for each of the three invocation paths (plain, confirm, option-picker apply)

### Edge Cases & Error Handling

- [x] A-014 R6: Absent, malformed, non-array and throwing `localStorage` all yield `[]` with no throw; a failing setter is swallowed
- [x] A-015 R8: With no stored MRU, ranking still orders by tier and density and the palette renders without error
- [x] A-016 R6: The MRU list never exceeds 20 entries and never contains a duplicate id

### Code Quality

- [x] A-017 Pattern consistency: `rank.ts` and `mru.ts` follow the `lib/palette/*.ts` pure-builder convention — dependency-free, no DOM/React, colocated `.test.ts`, module docblock stating the contract
- [x] A-018 No unnecessary duplication: The existing `last-window-per-server.ts` storage idiom is reused in shape rather than a new storage helper being invented, and no second filter predicate is left behind in `command-palette.tsx`
- [x] A-019 Type narrowing over assertions: The stored-payload parse narrows with runtime guards (`Array.isArray`, per-entry `typeof`) rather than an `as string[]` cast
- [x] A-020 No magic numbers or strings: The storage key and the cap are exported named constants, and the tiers are a named enum rather than bare integers
- [x] A-021 No god functions: `rank.ts` is decomposed into tokenize / category / tier / compare helpers rather than one large function
- [x] A-022 Comment discipline: Comments state contracts and non-obvious "why" (the tier split rationale, the synthetic-id hazard) and do not narrate the next line or cite change IDs
- [x] A-023 Tests accompany behavior: Every new module ships a colocated test, and the changed component behavior is asserted in `command-palette.test.tsx`
- [x] A-024 No polling, no backend state: MRU is localStorage-only, consistent with Constitution II and IV

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant. The one removed block (the inline `actions.filter(...)` arm in `command-palette.tsx`) was the planned replacement target of R8, already deleted by the change itself.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | `matchTier` takes `(label, description, query)` and returns a tier or `null`; `rankActions` is generic over `{ id, label, description? }` rather than importing `PaletteAction` | Keeping the ranker structurally typed avoids a component→lib type dependency and lets the colocated test use plain fixtures; the palette's other pure builders do import `PaletteAction`, but they *construct* actions where this one only reads three fields | S:70 R:95 A:85 D:80 |
| 2 | Certain | Tier constants are a named TS enum/const-object, not bare integers, and are exported for the test | `code-quality.md` names magic numbers an anti-pattern; the test asserts tier identity directly | S:75 R:95 A:90 D:90 |
| 3 | Confident | The comparator decorates each action with `{ tier, density, mruIndex, order }` once and sorts the decorated array, rather than recomputing inside the comparator | An O(n log n) sort recomputing tokenization per comparison would be O(n log n × label length) for no reason; decorate-sort-undecorate is the plain idiom and keeps the comparator readable | S:60 R:95 A:90 D:80 |
| 4 | Confident | Empty-query handling is a distinct early return in `rankActions`, not a degenerate case of the tier path | An empty query has no tier and no density (division by label length with a zero-length query yields 0 for everything), so folding it in would make the comparator lie; a named early return is clearer and directly matches R4 | S:70 R:95 A:85 D:75 |
| 5 | Confident | `readPaletteMru()` validates the parsed payload with `Array.isArray` plus a per-entry `typeof === "string"` filter rather than trusting the JSON shape | `code-quality.md` requires type narrowing over assertions; a hand-edited or version-skewed localStorage value is exactly the case the guard exists for | S:65 R:95 A:90 D:85 |
| 6 | Confident | MRU state lives in `useState` seeded lazily from `readPaletteMru()`, and `recordPaletteUse`'s return value updates that state | Seeding lazily makes the first keystroke correctly ranked with no effect round-trip; threading the returned list back into state keeps the in-memory copy and storage in sync without a re-read | S:65 R:90 A:85 D:80 |
| 7 | Confident | The option-picker apply records `picking.id` in the Enter-applies branch of `handleKeyDown`, beside the existing `closePalette(); onApply(keys)` sequence | That branch is the only place an option-picker actually commits; the sub-step rows' own `onSelect` is a deliberate no-op, so there is no other seam | S:70 R:90 A:85 D:80 |
| 8 | Tentative | The design-doc regression fixture is inlined in `rank.test.ts` as six plain objects rather than imported from any palette builder | It pins the exact scenario the change exists to fix and must not drift when a real builder's labels change; the cost is that the fixture is a copy of labels that live elsewhere <!-- assumed: inline fixture over importing real builder output --> | S:45 R:95 A:55 D:50 |

8 assumptions (2 certain, 5 confident, 1 tentative).
