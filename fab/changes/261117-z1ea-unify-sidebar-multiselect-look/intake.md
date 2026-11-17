# Intake: Unify Sidebar Multi-Select Look with Single Select

**Change**: 261117-z1ea-unify-sidebar-multiselect-look
**Created**: 2026-11-17

## Origin

Conversational — a `/fab-discuss` session. The user's raw input:

> I wanted to fix the way multi-select happens on the left panel. Right now, when you select multiple items, what you see is a border. We shouldn't be doing that. It should just be an extension of a single select UI behaviour. And on top of that, if I just drag a multi-selected list, it should move together instead of me having to press Command K and choosing move 10 items from there.

The discussion split this into TWO sequential changes. **This change is change 1** (look + selection semantics). **Change 2** (drag a multi-selected set — onto group rows, board rows, and as a block between rows, with a backend block-move) is a separate follow-up change stacked on this one and is OUT of scope here.

Decisions reached in the discussion:

- The 2px inset accent ring on bulk-selected rows goes away; bulk-selected rows look exactly like the single (URL-selected) row.
- The user was asked: "When you Cmd-click another tab, should the tab you're currently viewing be included in the selection?" with (a) Finder-style — yes, viewing A and Cmd-clicking B selects {A, B}; vs (b) today's behavior — only B. **User chose (a).**
- Accepted consequence (explicitly surfaced to the user): once the open tab is in the set, bulk actions such as `Selection: Close N windows` include it.

## Why

1. **Pain point**: the sidebar has two visually unrelated "selected" treatments. The URL-selected (open) row uses tint depth + `font-medium` + `text-text-primary`; a bulk-selected row instead gets a `box-shadow: inset 0 0 0 2px var(--color-accent)` ring (`app/frontend/src/components/sidebar/window-row.tsx` ~line 808). Multi-select reads as a different, foreign mode rather than "more of the same selection", and the ring is the only bordered selection cue left in a sidebar whose design rule is "selection and board-pin cues are borderless" (`docs/memory/run-kit/ui/sidebar.md` § Row Anatomy).
2. **Semantic mismatch**: today the open tab is never part of the bulk set unless explicitly Cmd-clicked, and Shift-click with no anchor degrades to a toggle. Every mainstream list (Finder, VS Code explorer, Gmail) treats single select as a selection of one that modifier-clicks extend — Shift-click from the current item selects the range. Once both treatments look identical (point 1), keeping the old semantics would be actively misleading: two rows would look selected while the set holds only one.
3. **Why this approach**: unify the visual AND the model in one change, because the visual unification is only coherent with the seeded model. The original ring rationale ("reads as member of a set without competing with the URL selection's tint-depth + bold") is superseded by the user's direction that multi-select should be an extension of single select.
4. **If not fixed**: multi-select stays a hidden power-user mode; change 2 (drag the set) would drag a set whose membership the user can't read at a glance.

## What Changes

### 1. One "highlighted" rule for window rows (`window-row.tsx`)

Today `isSelected` (URL-derived, from `currentWindowId`) drives `buttonStyle` (tint.selected / `uncoloredSelectedTint`), `buttonClass` (`text-text-primary font-medium`), `railStyle` (coarse rail band via `railRestBand(selected)` / held band), and the operator HeadsetIcon ink; `isBulkSelected` drives only `aria-selected` + the ring.

New rule — a single derived **highlighted** flag replaces `isSelected` for every VISUAL channel:

```ts
// selectionActive: the bulk store is non-empty (passed down as a prop, or derived)
const highlighted = selectionActive ? isBulkSelected : isSelected;
```

- Store EMPTY (at rest): exactly today — only the URL-selected row is highlighted. No indicator strip.
- Store NON-EMPTY: exactly the rows in the set are highlighted, using the identical treatment (tint.selected or the gray sentinel's deeper tint, `text-text-primary font-medium`, coarse rail selected band). The open tab is highlighted iff it is in the set — if the user Cmd-clicks the open tab OUT of a set, it un-highlights even though it is still the open tab.
- `uncoloredSelectedTint` (currently computed only when `isSelected` and uncolored, ~line 480) must key on `highlighted`.
- The bulk ring branch in the row `style` is removed. The drag-over indicator (`isDragOver` → `boxShadow: "0 -2px 0 0 var(--color-accent)"`) is unchanged and still the only box-shadow.
- `aria-current="page"` stays bound to the URL selection (`isSelected`) — it is semantic "this is the open page", not visual. `aria-selected` stays bound to `isBulkSelected` (emitted only when `onRowClick` is wired, as today).
- The operator pinned row (`sidebar/index.tsx` ~line 2959 passes `isBulkSelected`) follows the same rule.

Render-performance constraint (`sidebar.md` § Render Performance): rows are `memo`'d with stable identity-arg props. `selectionActive` is a boolean that flips only on empty↔non-empty transitions, so passing it as a prop re-renders rows only at those edges — acceptable. Do NOT pass the whole `selected` Set to rows.

### 2. Seed the selection from the open tab (`sidebar/index.tsx` click handler + `x`)

The modifier-aware `onRowClick(server, session, windowId, {meta, ctrl, shift})` (sidebar/index.tsx ~line 1376 onward, with `toggleWindowSelection` and `extendSelectionTo` ~lines 1349–1375) gains a seeding step:

When the store is EMPTY and a selection gesture fires, first seed the store with the **open tab's key** (`${currentServer}:${currentWindowId}`, the URL-selection identity already computed ~line 1278) — only if that key is a live, real (non-ghost) window known to the tree (`getLiveWindowKeys()` / the data-key registry) — and make it the anchor. Then apply the gesture:

| Gesture (store empty, viewing A) | Result |
|---|---|
| Cmd/Ctrl-click B | {A, B}, anchor B (toggle moves anchor, as today) |
| Shift-click B | range A..B in visible-row order, anchor stays A |
| Cmd/Ctrl-click A (the open tab itself) | no-op (consumed, no navigation) — a selection of one cannot be emptied by toggling its only member; store stays empty, A stays highlighted |
| `x` on focused row B | {A, B} — same seeding as Cmd-click (keyboard parity) |
| `x` on focused row A | no-op, same as Cmd-click A |
| Plain click anywhere | unchanged: navigates + clears the selection |

When there is no open tab (Host page `/`, server page `/$server`, or the open window not present in the tree), there is nothing to seed: gestures behave exactly as today (Cmd-click toggles, Shift-click without anchor degrades to toggle).

When the store is NON-EMPTY, all gestures behave exactly as today (no re-seeding). In particular Cmd-clicking the open tab while it is in a larger set removes it (and it un-highlights per § 1).

Seeding must be a single store write (e.g. `select([openKey])` setting the anchor, or a new store action) followed by the gesture's own write — or one combined write; implementer's choice, but keep the store's "no standalone setAnchor" stance (sidebar.md § Design Decisions; `store/selection-store.ts` header comment) — prefer extending `toggle`/a new `seedAndToggle`-style action or computing the final set and calling `selectOnly` with the anchor landing correctly. `selectOnly` puts the anchor on the LAST key; for Shift-click the anchor must remain A, so ordering matters.

Seeding is cross-server-agnostic: viewing a window on server X and Cmd-clicking a row on server Y yields a cross-server set (close/send work; move's existing `singleSelectedServer` gate omits move — unchanged).

`Selection: Select all merged` (palette, `selectOnly`) is unaffected — it replaces wholesale.

### 3. Selection indicator copy

`SelectionIndicator` (file-private in `sidebar/index.tsx`) is unchanged in structure. It still renders only when the store is non-empty, so at rest nothing appears. With seeding, the first Cmd-click shows `2 selected` — correct.

### 4. Tests

- Unit (`window-row` / `sidebar/index.test.tsx`): highlighted rule — store empty → only URL row painted selected; store non-empty → only set members painted; open tab not in set → not painted; no `inset 0 0 0 2px` box-shadow ever rendered for selection.
- Unit (selection logic / store): seeding on first Cmd-click, Shift-click range from open tab with anchor retained, Cmd-click on open tab with empty store is a no-op, no seeding when no open tab, no seeding when the store is non-empty.
- E2E `app/frontend/tests/e2e/sidebar-multiselect.spec.ts`: update existing cmd/shift-click expectations for the seeded model (e.g. a Cmd-click while viewing a window now yields `2 selected`), assert the ring is gone and the tint/weight treatment is applied, and that bulk close of a seeded set includes the open window. Use the existing isolated e2e tmux server.

### 5. PR evidence

User-visible UI change → `just demo <name>` web-lane recording (desktop + mobile) per Constitution § PR Evidence, with `--before` to show the ring vs the unified treatment. No desktop-shell paths touched, so no shell lane.

## Affected Memory

- `run-kit/ui/sidebar`: (modify) § Window-Row Multi-Select — row treatment (ring removed; highlighted rule: store-empty → URL row, store-non-empty → set members), gestures (open-tab seeding, Cmd-click-open-tab no-op, `x` parity, no-open-tab fallback); § Row Anatomy (selection treatment now shared by bulk members); add a Design Decision recording "bulk selection shares the single-select treatment; single select is a selection of one" superseding the ring rationale.

## Impact

- `app/frontend/src/components/sidebar/window-row.tsx` — visual flag, ring removal, `uncoloredSelectedTint` keying, rail style, HeadsetIcon ink.
- `app/frontend/src/components/sidebar/index.tsx` — `selectionActive` prop threading to `WindowRow` (both the session-tree rows ~line 3178 and the operator row ~line 2959), seeding inside `onRowClick` / `extendSelectionTo` / the `x` case of `handleTreeKeyDown`.
- `app/frontend/src/store/selection-store.ts` and/or `app/frontend/src/lib/selection.ts` — possibly a seeding helper/action (pure logic in `lib/selection.ts` per its dependency-free discipline).
- Tests: `sidebar/index.test.tsx`, `lib/selection.test.ts`, `store/selection-store.test.ts`, e2e `sidebar-multiselect.spec.ts`; a new demo spec under `app/frontend/tests/demo/`.
- No backend change. No API change. Command palette `Selection:` actions unchanged in code (behaviorally they now may include the open tab).

## Open Questions

- None blocking. (Shift-click range semantics and keyboard `x` parity are recorded as assumptions below.)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Remove the 2px inset accent ring; bulk-selected rows use the exact single-select treatment (tint.selected / gray sentinel, font-medium, text-primary, coarse rail band) | Discussed — user: "We shouldn't be doing that. It should just be an extension of a single select UI behaviour." | S:95 R:85 A:90 D:90 |
| 2 | Certain | Finder model: the open tab seeds the selection on the first modifier gesture (Cmd-click B while viewing A → {A,B}) | Discussed — user chose option (a) over today's behavior | S:95 R:75 A:85 D:90 |
| 3 | Certain | Bulk actions (close/send/move) include the open tab when it is in the set | Discussed — consequence surfaced to user before they chose (a) | S:85 R:80 A:85 D:90 |
| 4 | Confident | Visual rule: store non-empty → highlight = set membership; store empty → highlight = URL selection. Open tab removed from a set un-highlights | Only coherent reading of "identical treatment" + Finder semantics; avoids a highlighted row that isn't in the set | S:70 R:85 A:80 D:75 |
| 5 | Certain | Shift-click with an empty store selects the range from the open tab, anchor stays on the open tab | Standard list semantics; follows from seeding the anchor | S:70 R:90 A:85 D:85 |
| 6 | Confident | Cmd-click (or `x`) on the open tab with an empty store is a consumed no-op | A selection of one can't be emptied by toggling; navigating would be wrong for a modifier click | S:55 R:90 A:75 D:70 |
| 7 | Certain | No open tab (Host/server pages, or open window absent from the tree) → no seeding; gestures behave as today | Nothing to seed; preserves current behavior | S:60 R:90 A:85 D:85 |
| 8 | Confident | Keyboard `x` seeds the same way Cmd-click does | Keyboard-parity (Constitution V) and "selection of one" consistency; not explicitly discussed | S:40 R:90 A:65 D:60 |
| 9 | Confident | `aria-current` stays bound to the URL selection; `aria-selected` stays bound to set membership | Semantic attributes describe different things (open page vs set); only the visual unifies | S:55 R:90 A:85 D:80 |
| 10 | Certain | Change 2 (drag the set incl. block reorder + backend endpoint) is out of scope; separate stacked change | Discussed — user agreed to two sequential changes/PRs | S:90 R:85 A:90 D:90 |
| 11 | Certain | PR evidence: web-lane `just demo` with `--before`; no shell lane | Constitution § PR Evidence; diff touches no `app/desktop/src/` or shell-only SPA paths | S:80 R:90 A:95 D:90 |

11 assumptions (7 certain, 4 confident, 0 tentative, 0 unresolved).
