# Intake: Palette Search Ranking

**Change**: 260903-s91a-palette-search-ranking
**Created**: 2026-09-03

## Origin

One-shot `/fab-new` invocation with a written design doc attached (`search-ranking-plan.html`, uncommitted in this worktree — a no-code ideas writeup with a `query = "pr"` before/after example).

> Rank command palette search results by match quality instead of insertion order. Bucket matches: exact label match, then word-start match (label start or start of a word after a colon-prefix or a space), then acronym match (query letters align with first letters of words), then incidental mid-word substring match (lowest priority — e.g. query `pr` should not rank `Server: Protect` or `Layout: Promote` above `PR: Refresh Status` or `Open: PR #N`). Within a bucket, prefer the label where the query is a larger fraction of total length. Break remaining ties with a small client-side MRU (most-recently-used action ids) so a recently-used or frequently-used action rises above an equal-quality, untouched one. Empty query keeps MRU-first then existing declaration order as fallback. This changes only the ranking/sort layered on top of the existing `command-palette.tsx` filter step — it does not change which actions exist or how they are gated in/out by route or state. See the design doc at `search-ranking-plan.html` in this worktree for the full writeup and a `query=pr` before/after example.

Two authorities exist for this change and they diverge in two places; both divergences are resolved below and recorded as graded assumptions (rows 3 and 8):

| Authority | Status |
|-----------|--------|
| The invocation text above | **Primary** — the direct instruction |
| `search-ranking-plan.html` §§ 1–4 | Supplementary — supplies the motivation, the four ranking principles, and the load-bearing `query="pr"` worked example |

No prior conversation preceded this invocation; there is nothing to mine beyond the two documents.

## Why

**The problem.** `command-palette.tsx` filters with a plain `.includes(query)` over `label` + `description` and then renders the survivors in whatever order they arrived in. The order is the concatenation order of the builder outputs (`[...routeActions, ...globalActions]`, and within those the order the `lib/palette/*.ts` builders were spread together in `app.tsx` / `use-global-palette-actions.ts`). It is a **filter with no sort** — an accident of source layout, not a statement about relevance.

The observed symptom, from the design doc's screenshot, is `query = "pr"` returning six rows in this order:

```
1  Open: PR #3127            ← "pr" is the point of the row
2  PR: Refresh Status        ← "pr" is the point of the row
3  Server: Protect default   ← "pr" only because "Protect" starts with "Pr"
4  Server: Protect noon      ← same
5  Server: Protect runkit    ← same
6  Layout: Promote Web       ← same
```

Four of the six top-six slots are consumed by rows that have nothing to do with pull requests. Under Constitution V the palette is not a convenience — it is **the** discovery mechanism and the mandatory fallback for every action, including the ones whose chords a surface reserves. A registry that has grown to hundreds of entries (session/window/board/selection/view/open/theme/config/status-refresh/server/shell-server/push/window-switch/agent/spawn groups, plus per-server, per-board, per-macro and per-tab dynamic entries) makes an unranked list actively hostile: the more actions ship, the worse the primary discovery surface gets. Every future palette entry currently makes the problem worse, which is why this is worth fixing now rather than absorbing.

**Consequence of not fixing.** Users fall back to chords (which do not exist for most actions) or to scrolling a 60-row list. The keyboard-first principle degrades exactly as the registry grows — the opposite of the intended direction.

**Why this approach.** Bucketed string matching over a fuzzy-match dependency: buckets 1–5 below are computable with `indexOf`, a word-boundary test, and a first-letter walk. No new dependency, no scoring-weight tuning, no index build, and — critically — the whole thing is a **pure function over `(actions, query, mru)`** that drops into the existing `lib/palette/*.ts` pure-builder convention with a colocated vitest, so it is unit-testable without mounting the shell. A fuzzy library (fuse.js, fzf-style) would add a dependency, a tuning surface, and opaque ordering for a list this small (a few hundred entries re-ranked per keystroke — trivially fast in plain JS).

## What Changes

### 1. New module — `app/frontend/src/lib/palette/rank.ts` (pure)

The ranking core. Pure, dependency-free, no DOM, no React — the `lib/palette/shell.ts` / `lib/palette/zen.ts` / `lib/palette/server-protect.ts` convention. Colocated `rank.test.ts`.

Exported surface (names indicative, shape binding):

```ts
/** Ranking tiers, lower = better. Exported for the colocated test. */
export const enum MatchTier {
  Exact = 0,        // query === whole label, or query === the label's colon-prefix category
  WholeWord = 1,    // query equals a complete word of the label
  WordStart = 2,    // query is a prefix of a word of the label (but not the whole word)
  Acronym = 3,      // query letters align with the first letters of a consecutive run of words
  Incidental = 4,   // query appears mid-word only
  DescriptionOnly = 5, // label does not contain the query at all; description does
}

/** The tier for one label+description against a lowercased query. `null` = no match. */
export function matchTier(
  label: string,
  description: string | undefined,
  query: string,
): MatchTier | null;

/** Filter + rank. Returns a NEW array; never mutates `actions`. */
export function rankActions<T extends { id: string; label: string; description?: string }>(
  actions: T[],
  query: string,
  mru: readonly string[],
): T[];
```

**Tier definitions** (all comparisons on `toLowerCase()`ed strings; the raw label is never mutated):

| Tier | Rule | `query = "pr"` examples |
|------|------|-------------------------|
| 0 Exact | `label === query`, **or** the label has a `"<Category>: "` prefix and `category === query` | `PR: Refresh Status` (category `PR`) |
| 1 WholeWord | some word of the label equals the query exactly | `Open: PR #3127` (word `PR`) |
| 2 WordStart | some word of the label starts with the query but is longer than it | `Server: Protect noon`, `Layout: Promote Web` |
| 3 Acronym | the query's letters equal the first letters of a **consecutive run** of words | `prs` → `PR: Refresh Status`; `pw` → `Layout: Promote Web` |
| 4 Incidental | the label contains the query and no higher tier applied — an alphanumeric query is then necessarily strictly inside a word; a boundary-spanning query also lands here | `pr` → `Web: Reprint` (hypothetical); `kit: r` → `run-kit: Restart Daemon` |
| 5 DescriptionOnly | the label does not contain the query; the description does | any entry matching only on its `description` |

**Word tokenization**: a *word* is a maximal run of `[a-z0-9]` after lowercasing. Boundaries are therefore every non-alphanumeric character — `" "`, `":"`, `"#"`, `"("`, `"-"`, `"/"`, `"…"`, quotes. This is a generalization of the invocation text's "start of a word after a colon-prefix or a space", chosen so that labels like `Open: PR #3127`, `Server: Switch to "work"`, `Tile: Show <Surface>` and `run-kit: Restart Daemon` tokenize the way a reader would expect. `Open: PR #3127` → `["open", "pr", "3127"]`.

**Category prefix**: the substring before the first `": "` in the label, when one exists (`PR: Refresh Status` → `pr`; `Server: Protect noon` → `server`). The palette's namespace prefixes (`Board:`, `Pin:`, `View:`, `Tab:`, `Tile:`, `Layout:`, `Web:`, `Server:`, `Session:`, `Panel:`, `Selection:`, `Terminal:`, `Compose:`, `Notifications:`, `Help:`, `Macro:`) are already an established, placeholder-advertised command vocabulary, so an exact category hit is the strongest possible signal of intent.

**Acronym rule**: build the initials string from the label's words (`PR: Refresh Status` → `"prs"`, `Layout: Promote Web` → `"lpw"`), then test `initials.includes(query)`. A *contiguous run* is required — `"ps"` does not match `"lpw"`. The tier is only reached when tiers 0–2 do not apply.

**Within-tier ordering** — applied in this order, each a tiebreak for the previous:

1. **Tier** ascending (0 best).
2. **Density** descending — `query.length / label.length`. Explicitly label length, not `label + description` length: the description is secondary text and would otherwise punish well-described actions. `Open: PR #3127` (2/14 = 0.143) outranks `Server: Protect noon` (2/20 = 0.100) *within a tier*.
3. **MRU** — an action whose id appears in the MRU list beats one that does not; between two listed ids, the more recent (lower index) wins.
4. **Declaration order** — the incoming array index. Guaranteed by using a stable sort (`Array.prototype.sort` is stable per spec) over an index-decorated array, so the existing concatenation order survives as the terminal fallback exactly as it does today.

**Empty query** (`query.trim() === ""`): no filtering and no tiering — order is MRU-first (by recency), then declaration order. Every currently-registered action still renders, in a stable order.

**Non-mutation**: `rankActions` returns a new array. `actions` arrives from a React memo upstream; mutating it would corrupt the caller's memoized value.

### 2. New module — `app/frontend/src/lib/palette/mru.ts` (storage)

Per-viewer recency memory for palette action ids. Constitution II keeps this off the backend and Constitution IV puts per-viewer state in localStorage; the module follows the `lib/last-window-per-server.ts` shape exactly — a named key constant, `try/catch`-noop reads and writes so private mode / quota / SSR never throw, and a colocated `mru.test.ts`.

```ts
/** localStorage key, in the established `runkit-*` family. */
export const PALETTE_MRU_KEY = "runkit-palette-mru";

/** Cap — most-recent-first, oldest evicted. */
export const PALETTE_MRU_LIMIT = 20;

/** Read the id list, most-recent-first. `[]` when absent, unparseable, or unavailable. */
export function readPaletteMru(): string[];

/** Push `id` to the front (deduping any earlier occurrence), truncate to the cap, persist. Returns the new list. */
export function recordPaletteUse(id: string): string[];
```

Stored value is a JSON array of strings. A non-array or malformed payload reads as `[]` rather than throwing — the same defensive posture as the other `runkit-*` readers. There is no eviction of ids for actions that no longer exist: an id absent from the current action list simply never matches, and the cap bounds the list.

### 3. `app/frontend/src/components/command-palette.tsx` — wire it up

Three edits; the component's structure, props, ARIA wiring, sub-step machinery, keyboard handling and rendering are otherwise untouched.

**(a) Replace the filter with the rank.** The `confirming` and `picking?.optionPicker` branches of the `filtered` ternary are unchanged — sub-step rows are a fixed display list and must never be re-sorted. Only the final `actions.filter(...)` arm changes:

```tsx
// before
: actions.filter((a) => {
    const q = query.toLowerCase();
    return (
      a.label.toLowerCase().includes(q) ||
      (a.description?.toLowerCase().includes(q) ?? false)
    );
  });

// after
: rankedActions;   // useMemo(() => rankActions(actions, query, mru), [actions, query, mru])
```

`rankActions` subsumes the filter: an action with `matchTier(...) === null` is dropped, so **membership is bit-for-bit identical to today** — same case-insensitive `includes` over `label` and `description`, same actions in, same actions out. Only the order changes. This preserves every existing gating decision made by the `lib/palette/*.ts` builders and by the route/state guards in `app.tsx`.

**(b) MRU state.** Read once on mount (`useState(() => readPaletteMru())`) so the ranking is available on the first keystroke without an effect round-trip, and hold it in state so a recorded use is reflected on the next open without a page reload.

**(c) Record on invoke.** Record the id of the **originating** `PaletteAction` — never a synthetic sub-step id. The sub-step rows carry rewritten ids (`${confirming.id}-confirm`, `${picking.id}-opt-${o.key}`) which would poison the MRU with ids no real action ever has. Concretely:

| Path | Id recorded | Where |
|------|-------------|-------|
| Plain action | `action.id` | `handleSelect`, immediately before `action.onSelect()` |
| Confirm flow | `confirming.id` (the base action, not the `-confirm` row) | the confirm row's selection |
| Option-picker apply | `picking.id` | the Enter-applies branch in `handleKeyDown` |
| Disabled row | *(nothing)* | `handleSelect` already returns early |
| Cancel / Escape / backdrop | *(nothing)* | no invocation happened |

Recording writes localStorage and updates the state list, so the effect is visible the next time the palette opens.

### 4. Tests

| File | Adds |
|------|------|
| `lib/palette/rank.test.ts` (new) | Per-tier classification for each of the six tiers; the tokenizer on `Open: PR #3127`, `Server: Switch to "work"`, `run-kit: Restart Daemon`; category-prefix extraction; the acronym contiguity rule (`prs` matches, `ps` does not); density ordering; MRU tiebreak; declaration-order stability; empty-query MRU-first behavior; non-mutation of the input array; **and a regression test reproducing the design doc's `query="pr"` example end-to-end** — `PR: Refresh Status` first, `Open: PR #3127` second, the three `Server: Protect *` rows and `Layout: Promote Web` all below both |
| `lib/palette/mru.test.ts` (new) | Round-trip; front-dedupe on repeat use; cap eviction at 20; `[]` on absent / malformed / unavailable storage; no throw when `localStorage` getter throws |
| `components/command-palette.test.tsx` (modify) | Typing `pr` renders the ranked order; invoking an action records its id (asserted through the exported key); a confirm-flow invoke records the **base** id, not `${id}-confirm`; membership parity — the same action set survives a query as before |

No new Playwright spec: the ordering is pure logic fully covered at unit level and asserted once through the mounted component, and the e2e rig would only re-verify the same comparator at a much higher cost. (Recorded as assumption 10.)

### 5. Explicit non-goals

- **No change to which actions exist**, or to any route/state gate. The `lib/palette/*.ts` builders and their call-site guards in `app.tsx` / `use-global-palette-actions.ts` are untouched.
- **No change to the filter's membership rule.** Same `label`/`description` case-insensitive `includes`. An action that matches today matches after this change.
- **No `PaletteAction` schema change.** Ranking reads `id`, `label`, `description` — all existing fields. No per-action weight, pin, or priority field is introduced.
- **No new dependency.**
- **`disabled` does not affect rank.** A disabled row keeps its match-quality position (see Open Questions).
- **No backend persistence** of MRU (Constitution II).
- **Sub-step rows (confirm, option-picker) are not ranked** — they are a fixed, caller-ordered display list.

## Affected Memory

- `run-kit/ui/keyboard-and-palette.md`: (modify) Add a **§ Palette search ranking** subsection beside § Command Palette Actions documenting the six-tier ladder, the tokenizer and category-prefix rules, the density → MRU → declaration-order tiebreak chain, the empty-query behavior, the `runkit-palette-mru` key and its 20-entry cap, and the base-id (not synthetic sub-step id) recording rule. Add two **Design Decisions** entries in the file's existing four-field shape: *Exact includes the colon-prefix category, not just the whole label*, and *Whole-word outranks word-prefix, so `Protect`/`Promote` sink structurally rather than by density accident*.

## Impact

**Code** (all frontend; no backend, no API, no Go):

| Path | Change |
|------|--------|
| `app/frontend/src/lib/palette/rank.ts` | new — pure ranking core |
| `app/frontend/src/lib/palette/rank.test.ts` | new — colocated vitest |
| `app/frontend/src/lib/palette/mru.ts` | new — localStorage MRU |
| `app/frontend/src/lib/palette/mru.test.ts` | new — colocated vitest |
| `app/frontend/src/components/command-palette.tsx` | modify — swap the filter arm for the ranked memo; MRU state; record on invoke |
| `app/frontend/src/components/command-palette.test.tsx` | modify — ordering + MRU assertions |

**Not touched**: `app/backend/` entirely; `src/lib/palette/*.ts` builders; `app.tsx`; `hooks/use-global-palette-actions.ts`; `PaletteAction`'s type; the keybinding registry; `package.json`.

**Surfaces affected**: every palette consumer, since there is exactly one mount (`LayoutCommandPalette` in `app.tsx`) shared by the terminal route, Board page and Host Overview. The change is therefore global by construction — no per-route opt-in exists or is wanted.

**Storage**: one new localStorage key, `runkit-palette-mru`, joining the existing `runkit-*` family. Bounded at 20 short strings.

**Risk**: low and contained. The membership rule is unchanged, so no action can disappear; the worst credible failure is a suboptimal order, and the ranking is a single pure function with a colocated test. `localStorage` failure degrades to an empty MRU (pure match-quality ordering), never to a throw.

**Verification gates** (`fab/project/code-quality.md`): `cd app/frontend && npx tsc --noEmit`, then `just test`.

## Open Questions

- Should a `disabled` row sink below enabled rows of the same match quality? Not specified by either authority. Deferred to a follow-up — the current change deliberately leaves `disabled` out of the comparator (non-goal above), since disabled rows are rare by policy ("prefer omitting the row when the action is simply unavailable") and sinking them would couple the pure ranker to a presentation concern.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Ranking lives in `lib/palette/rank.ts` as a pure, dependency-free function with a colocated `rank.test.ts`; MRU storage in `lib/palette/mru.ts` likewise | The established convention for every palette helper (`shell.ts`, `zen.ts`, `server-protect.ts`, `web-tabs.ts`, `sort.ts` — each pure + colocated vitest); `code-quality.md` names duplicating existing utilities an anti-pattern and the palette lib is where this belongs | S:90 R:90 A:95 D:90 |
| 2 | Confident | Tier 0 "exact" means query equals the whole label **or** the label's `"<Category>: "` prefix — not whole-label only | The design doc's §3 worked example badges `PR: Refresh Status` as exact with the note `category = "PR"`, and that row must land at #1. Under whole-label-only it would tie with `Open: PR #3127` in a lower tier and lose on density (0.111 vs 0.143), inverting the doc's stated result. The colon prefixes are an advertised command vocabulary (the palette's own placeholder teaches `Board: Pin: View: Tab:`), so an exact category hit is the strongest available intent signal | S:80 R:85 A:75 D:70 |
| 3 | Confident | The invocation's four buckets are refined to six: whole-word is split out **above** word-prefix, and description-only is added **below** incidental | The invocation's own example contradicts its bucket labels — it places `Server: Protect` / `Layout: Promote` in the "incidental mid-word" bucket, but `Pr` is literally the *start* of `Protect` and `Promote`, so a word-start rule as written puts them in the same tier as `Open: PR #3127`. The stated **intent** (twice: the invocation text and doc §3) is unambiguous — those rows must sink below both PR rows. Splitting whole-word above word-prefix delivers that structurally. Ordering them by density alone would also reproduce this one example, but only by accident: a short label like `Tab: Promote` (density 0.167) would still outrank `Open: PR #3127` (0.143), which is exactly the complaint | S:70 R:90 A:80 D:70 |
| 4 | Confident | Description-only matches form the lowest tier rather than being dropped or folded into incidental | Neither authority mentions the description, but the existing filter matches it and dropping it would change membership — explicitly out of scope. Ranking it last keeps secondary text from outranking any label signal, with one obvious interpretation | S:55 R:90 A:80 D:75 |
| 5 | Confident | Acronym matching requires the query to be a **contiguous** run of the label's word initials (`prs` matches `PR: Refresh Status`; `ps` does not) | "query letters align with first letters of words" reads as consecutive alignment; a non-contiguous subsequence would make the acronym tier fire on almost every short query and swamp the incidental tier it is meant to sit above | S:60 R:90 A:80 D:70 |
| 6 | Certain | Word boundaries are every non-alphanumeric character (generalizing "colon-prefix or a space") | The instruction names the two boundaries that occur in its examples; real labels also carry `#`, `-`, `/`, `<>` and quotes (`Open: PR #3127`, `run-kit: Restart Daemon`, `Server: Switch to "work"`). The general rule is a strict superset that tokenizes those the way a reader would, and no label exists where the narrow rule is preferable | S:75 R:90 A:90 D:85 |
| 7 | Certain | Density is `query.length / label.length` — label only, excluding `description` | Stated directly in the invocation ("a larger fraction of total length", about the label); including the description would penalize well-described actions for being well described | S:85 R:90 A:85 D:85 |
| 8 | Confident | Tiebreak order is tier → density → MRU → declaration order, i.e. **density outranks MRU** | Stated explicitly in the invocation: density is "within a bucket", MRU breaks "remaining ties" between entries of "equal quality". This **diverges from doc §3's prose**, which suggests a recently-clicked `Server: Protect runkit` would rise above `Server: Protect noon` (it will not — `noon` is the shorter label and wins on density first). The invocation is the primary authority and its wording is unambiguous; the divergence is recorded here rather than silently resolved. Reversing the two comparators later is a one-line change | S:65 R:90 A:40 D:60 |
| 9 | Certain | MRU is a capped, recency-ordered list of action ids in `localStorage` under `runkit-palette-mru`, read/written with the `try/catch`-noop pattern | Constitution II forbids backend state; Constitution IV puts per-viewer state in localStorage; `lib/last-window-per-server.ts` is the named precedent for the key family and the defensive read/write shape | S:80 R:85 A:95 D:90 |
| 10 | Confident | Tests are unit (`rank.test.ts`, `mru.test.ts`) plus component assertions in `command-palette.test.tsx`; **no new Playwright spec** | `code-quality.md` requires tests for changed behavior (met) and says UI changes *SHOULD* include e2e "where possible". Result ordering is pure logic with no layout, timing or tmux dependency — the unit tests are the authoritative check and the component test proves the wiring; an e2e run would re-assert the same comparator at rig cost. Reversible: adding a spec later costs nothing already built | S:70 R:95 A:70 D:65 |
| 11 | Certain | MRU records the **originating** action's id — `confirming.id` / `picking.id`, never the synthetic `${id}-confirm` or `${id}-opt-${key}` row ids | Those ids are constructed inside the component for display only and match no registered action, so recording them would write permanently-dead entries into a capped list, silently shrinking its useful size | S:80 R:90 A:95 D:90 |
| 12 | Certain | `rankActions` subsumes the filter and preserves membership exactly (same case-insensitive `includes` over label + description); sub-step rows bypass ranking entirely | Stated directly in the invocation ("does not change which actions exist or how they are gated"); the confirm/option-picker branches are a fixed caller-ordered display list whose index the picker's badge and Space-toggle logic depend on (`picking.optionPicker.options[selectedIndex]`), so re-sorting them would break the sub-step | S:90 R:85 A:90 D:90 |
| 13 | Certain | Empty query renders every action, MRU-first then declaration order — no tiering, no filtering | Stated directly in the invocation | S:90 R:90 A:90 D:90 |
| 14 | Certain | `rankActions` runs inside a `useMemo` keyed on `[actions, query, mru]` and returns a new array without mutating its input | A few hundred entries re-ranked per keystroke is trivially fast, but the memo matches the component's existing reactive shape and avoids re-sorting on unrelated re-renders; non-mutation is required because `actions` is an upstream memoized value | S:65 R:95 A:85 D:80 |
| 15 | Confident | `disabled` does not participate in ordering | Neither authority mentions it. Disabled rows are rare by the component's own documented policy (prefer omitting the row), and coupling the pure ranker to a presentation state is the kind of thing worth deciding deliberately rather than by default — carried as an Open Question | S:35 R:90 A:45 D:45 |
| 16 | Confident | MRU cap is 20 ids | The invocation says "a small client-side MRU" without a number. 20 comfortably covers a working set of frequently-used actions while staying a trivially-scanned array and a tiny storage payload; a named constant makes it a one-token change | S:50 R:95 A:70 D:70 |

16 assumptions (8 certain, 8 confident, 0 tentative, 0 unresolved).
