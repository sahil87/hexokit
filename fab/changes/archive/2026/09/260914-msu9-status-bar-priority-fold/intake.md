# Intake: Status Bar Measured Priority Fold

**Change**: 260914-msu9-status-bar-priority-fold
**Created**: 2026-09-14

## Origin

> Implement Change 2 (status bar measured fold, slug: status-bar-priority-fold) from fab/plans/sahil/26-09-14-pane-status-bar-density.md — Changes 0 and 1 are merged to main. Read the full plan file (Standing context, Decisions of record, Sequencing, and the Change 2 section) for exact steps, tests, and memory updates. IMPORTANT: use the full frontend test suite (just test-frontend) as the unit-test gate, not a scoped file list — memory note from Change 1 flags that a scoped 4-file gate missed a real regression in a shared-component test elsewhere in the tree.

One-shot `/fab-new` invocation against a pre-written plan. The plan (`fab/plans/sahil/26-09-14-pane-status-bar-density.md`, drafted 2026-09-14 from the `/fab-discuss` session on the congested PANE section + status bar) is the design authority; its contract of record is `docs/wiki/pane-status-bar-density-studies.html` (Study D2 is the live fold mock, E the five-width filmstrip, F the recommendation table). Changes 0 (`#974` — pane ordinal + version segment) and 1 (`#978` — register value diet) are merged to `main` at `1a876994`; this change starts from that main. Change 3 (`pane-panel-yield-continuation`) runs in parallel from its own worktree and is file-disjoint except for one sentence in `status-signals.md § Status Bar` (the left-cluster gate) — whichever lands second rebases that sentence.

Key decisions carried from the plan verbatim (§ Decisions of record):

- **The status bar's CSS breakpoint ladder is replaced by a measured priority fold.** Overflow is caused by *value* length (30-char branches, 48-char fab lines), not viewport width; at 1512 px nothing has dropped yet and six segments truncate proportionally. The fold is the fourth instance of the shipped measured-overflow idiom (`lib/top-bar-overflow.ts` `computeVisibleCount`, `lib/crumb-collapse.ts`, `lib/gui-toolbar-fold.ts`): every segment renders at natural width or folds into the `…` menu; truncation is reserved for the single lowest-priority survivor when the never-fold set alone does not fit. **One ladder across both clusters**, so the two sides stop competing.
- **The version fragment is its own segment** (fixed in change 0); this change gives it a fold priority.
- **Rejected**: a settings surface for which bar segments show (Constitution IV — one registry-driven settings surface; VII — the fold *is* the convention); horizontal scroll or a two-row bar; collapsing the registers into one line.
- **Non-goals**: mobile (renders no bar); adding or removing segments (the set is fixed — `server` folds, it does not disappear); the flyout content; the PANE-on gate (change 3).

## Why

**The pain.** The bar's overflow is a 3-stage CSS-breakpoint ladder (`hidden md:flex` / `lg:flex` / `xl:flex` / `min-[700px]:inline` on segments, the inverse classes on `…` menu rows, the chevron itself `xl:hidden` unconditionally). Breakpoints answer the wrong question: the bar overflows because of *value* length — a `260913-png4-compose-default-on` branch, a `ldbs shell-stage-status-bar · apply` fab line, a long host name — not because the viewport is narrow. At 1512 px (a common laptop width) nothing has dropped yet and six segments carry `min-w-0 truncate`, so the bar shows six ellipses and no complete value; at 1280 px the `…` chevron is *always* visible even when everything fits. Meanwhile the two clusters degrade independently on opposite sides of the `ml-auto` spring, so a long left cluster squeezes the right cluster's `host` into an ellipsis while the left keeps a `cwd` it could have folded.

**The consequence of not fixing it.** Change 1 dieted the register values, which helps the PANE panel (fixed 220 px) but does not fix the bar: the bar's failure mode is proportional truncation, and shorter strings only move the width at which it starts. The design study's five-width filmstrip (Study E) shows the ladder producing ellipses at every width from 1024 to 1512, and a bar whose values cannot be read is a bar nobody consults — the PANE panel opt-in becomes the only usable register surface, defeating the reason the desktop panel was retired.

**Why a measured fold over alternatives.** Three shipped modules already do this: the top bar's right cluster (`computeVisibleCount`), the breadcrumb collapse (`deriveCrumbsCollapsed`), and the gui tile header (`computeGuiToolbarFold`) all measure real widths through a hidden probe row and decide in a pure module the component consumes. The idiom is proven, unit-testable without layout (jsdom has no layout engine — the pure module carries the tests), and its rules (two-pass reserve for the chevron, one-sided 24 px expand hysteresis, collapse-first render from a null initial state, unmeasured ⇒ keep previous) are documented and understood. A *priority* fold (any position folds, by importance) rather than the gui module's *suffix* fold (the tail folds) is what the bar needs — `cwd` and `tmx` sit in the middle-left, `ld` in the middle-right, and the never-fold items (`pr`, `fab`, `zen ✕`, stale `◷`, the connection dot) are scattered — so the new module is a sibling, not a generalisation. Horizontal scroll and a second row were rejected in the study (a scrolling bar hides what it exists to show; a two-row bar is a card, not a strip). A settings surface for segment visibility would be a second settings surface (Constitution IV).

## What Changes

### 1. `lib/status-bar-fold.ts` — the pure fit module (new)

A new pure, dependency-free module beside the three precedents; its header comment names all three (`top-bar-overflow.ts` `computeVisibleCount`, `crumb-collapse.ts`, `gui-toolbar-fold.ts`) and states that this is a **priority** fold (any position), not the gui module's suffix fold, hence a sibling. No React, no DOM.

```ts
export const STATUS_BAR_FOLD_HYSTERESIS_PX = 24;   // one-sided, EXPAND edge (the crumb-collapse / gui port)
/** Per-cluster fixed charges: horizontal padding (px-2 ×2), the connection dot, and its gap. */
export const STATUS_BAR_FOLD_PAD_PX = 16;
export const STATUS_BAR_FOLD_DOT_PX = 8;
export const STATUS_BAR_FOLD_GAP_PX = 12;           // the bar's `gap-3`, charged BETWEEN rendered items of one cluster

export interface StatusBarFoldItem {
  id: string;
  /** Probed natural width (0 = unmeasured). */
  widthPx: number;
  /** Fold priority — LOWER dies first; `null` = never folds. */
  prio: number | null;
  /** Which side of the `ml-auto` spring the item renders on — gaps are charged per cluster. */
  cluster: "left" | "right";
  /** Eligible for the last-survivor truncation (text-bearing never-fold items: `pr`, `fab`). */
  truncatable?: boolean;
}

export interface StatusBarFold {
  /** Ids folded into the `…` menu, in DISPLAY order. */
  folded: string[];
  /** Set only when the never-fold set alone overflows: the one survivor that gets `min-w-0 truncate`. */
  truncateId: string | null;
}

export function computeStatusBarFold(
  items: readonly StatusBarFoldItem[],   // display order, both clusters (left then right)
  availablePx: number,                   // the bar's clientWidth
  chevronPx: number,                     // the `…` button's probed width (reserved only once something folds)
  prev: StatusBarFold | null,
  hysteresisPx: number = STATUS_BAR_FOLD_HYSTERESIS_PX,
): StatusBarFold;
```

**Fit rule.** Budget = `availablePx − PAD − DOT − GAP` (the dot is the right cluster's terminator and is never an item). Rendered width = Σ item widths + `GAP × (renderedInCluster − 1)` for each cluster (n items ⇒ n−1 gaps, matching a flex row's `gap`; no gap is charged across the `ml-auto` spring). While the rendered width exceeds the budget, fold the item with the **lowest `prio`**; ties fold the **rightmost in display order first**. Items with `prio: null` never fold.

**Two-pass reserve** (the gui module's rule, verbatim): fit once with no chevron reserve; if nothing folds, return `{ folded: [], truncateId: null }` and the chevron does not render; if anything folds, re-fit with `chevronPx` (plus one gap) reserved on the right cluster. The reserve never causes the fold that justifies it.

**Last-survivor truncation.** If, after every foldable item has folded, the never-fold set still overflows, return `truncateId` = the **rightmost `truncatable` never-fold item** in display order (`fab` sits right of `pr` in the left cluster, so `fab` truncates before `pr`; `zen ✕`, the stale `◷` chip, and the dot are never truncatable). At most one item ever truncates. When nothing truncatable exists, `truncateId` stays null and the bar's `overflow-hidden` clips (the existing container rule).

**Hysteresis.** One-sided on the EXPAND edge: collapsing (more folded, or truncation turning on) is immediate; a result that is *more expanded* than `prev` (fewer folded ids, or truncation turning off) must re-prove against `availablePx − hysteresisPx`, else `prev` is returned. Expansion rank = `(items.length − folded.length) × 2 + (truncateId ? 0 : 1)`.

**Degenerate inputs.** `items.length === 0` or every `widthPx <= 0` (jsdom, pre-mount, hidden probe) ⇒ return `prev ?? { folded: [], truncateId: null }` — the cold default is **fully expanded** (the safe cold answer; the collapse-first render is the component's job, below).

### 2. Priority table — display order stays branch-first (decided)

| Cluster | Segment id | Display order | `prio` |
|---|---|---|---|
| left | `git` (`⑂`) | 1 | 9 |
| left | `pr` | 2 | never |
| left | `fab` | 3 | never (truncatable) |
| left | `agt` | 4 | 8 |
| left | `tmx` | 5 | 3 |
| left | `cwd` | 6 | 2 |
| right | `zen` (`zen ✕`, zen only) | 7 | never |
| right | `metrics` (`cpu N% · mem N%`) | 8 | 6 |
| right | `ld` (`ld N%`) | 9 | 0 |
| right | `clock` (`◷ in …` / `◷ due`) | 10 | 4 |
| right | `clock` (`◷ stale …`) | 10 | never |
| right | `server` | 11 | 5 |
| right | `host` | 12 | 10 |
| right | `version` | 13 | 7 |
| right | `palette` (`⌘K`) | 14 | 1 |
| right | `compose` (`a▏`) | 15 | 1 |
| right | `…` chevron | 16 | (reserve — not an item) |
| right | connection dot | 17 | never (not an item — the fixed DOT charge) |

Lower dies first: `ld` → `a▏` (rightmost of the prio-1 tie) → `⌘K` → `cwd` → `tmx` → `◷ next` → `server` → `cpu · mem` → `version` → `agt` → `⑂` → `host`. `pr` / `fab` are truncatable if the wall is reached; the `fab` segment also *keeps* its `truncatable` flag on the no-copy `Segment` fork (no `fabChange` parse) so the rule does not depend on the copy affordance. Absent segments (no `gitBranch`, no `prNumber`, omitted clock, no version yet, no `onOpenCompose`, no `server`) are simply not in `items`.

### 3. Component — `status-bar.tsx` rewrite of the overflow machinery

- **One `ResizeObserver`** on the bar root plus a **hidden probe row** (the top-bar / gui idiom: `aria-hidden="true" inert`, `absolute -left-[9999px] pointer-events-none`, every candidate segment rendered at natural width with a `data-fold="<id>"` wrapper and `tabIndex={-1}` on its control; the probe renders **no `Tip`** — measurement only). The probe also renders the `…` chevron (`data-fold="chevron"`) so its reserve is measured, not hardcoded. Measure in a `useLayoutEffect` (**pre-paint**) on mount; the observer observes the root AND the probe (an item's width can change — a new branch, a longer host name — without the bar resizing); the effect's dependency is a serialized **candidate key** (the set of present segment ids + the clock kind + `zenActive`), so a segment appearing or vanishing re-runs it, while value-only changes re-fit through the observed probe.
- **Collapse-first**: fold state starts `null`; until the pre-paint measure sets it, the bar renders **no foldable segment** (only the never-fold set), so no wide-then-snap frame is ever painted (the gui rule). In jsdom every probe width reads 0, so the first measure lands on the cold default (fully expanded, no chevron) — existing unit tests that never open the menu keep working unchanged.
- **Segments drop every `min-w-0 truncate`, `hidden md:flex` / `lg:flex` / `xl:flex` / `min-[700px]:inline` class**; rendered segments are `shrink-0 whitespace-nowrap`. The one exception is the `truncateId` survivor, which receives `min-w-0 truncate` (value span) for that render. `Segment` / `CopySegment` gain a `truncate?: boolean` prop replacing today's always-on truncation; the `className` breakpoint plumbing goes.
- **Metrics get fixed-width numerals**: the `cpu` and `mem` value spans carry `tabular-nums` and an inline `min-w-[4ch]` reserve (`100%` is the four-character worst case) with `text-right`, and `ld`'s value the same, so the ~2.5 s metrics tick cannot change a probed width and therefore cannot re-fold the bar.
- **`…` chevron renders iff `fold.folded.length > 0`** (today `xl:hidden` unconditionally). Its `data-testid="status-bar-overflow"` and `aria-*` stay.
- The `host` / `version` pair keeps its `flex gap-1` visual wrapper but the two are separate fold items (the wrapper renders whichever survive; when both fold, the wrapper is omitted).
- The `WindowCluster` / `OverflowMenu` / `ClockChip` function split may change shape (a shared `SEGMENTS` render map keyed by id feeding the strip, the probe, and the menu is the natural form — one render function per id, three call sites — so strip, probe, and menu row cannot disagree). The `useCopyFeedback` keys, aria-labels, `data-testid`s, the open-first `pr` anchor, `FAB_STATE_COLORS`, `splitDatePrefix` dimming, and the `useClockChipState` single derivation are all preserved.
- **Header comment**: the `OVERFLOW` block is rewritten to describe the fold (priority table, two-pass reserve, last-survivor rule, fixed-width numerals, collapse-first); the `MIRROR` / `COPY AFFORDANCES` blocks stay. No change-ID citations in new comments (code-quality rule).

### 4. Metrics diet — `cpu N% · mem N%`, `ld` its own segment

- The metrics segment reads `cpu <n>% · mem <n>%` — `mem` as a **percentage** (`Math.round(used / max(total,1) × 100)`), coloured by `gaugeColor(percent)` exactly as today's absolute form was. `formatMemory` leaves this file (the `MetricsFlyout` → shared `HostMetrics` keeps the absolute values and graphs — that component is unchanged).
- `ld <n>%` becomes its **own segment** (own fold item, prio 0) rendered after the metrics segment; it is passive (no copy, no flyout — the flyout stays on the `cpu · mem` segment only).
- Overflow rows: `cpu N% · mem N%` (one informational span) and `ld N%` (one informational span), each present only while its segment is folded.

### 5. `…` menu — folded ids in strip order

- Rows are exactly `fold.folded` in display order, one row per folded id, same row kinds as today: **copy-action buttons** for `git` / `tmx` (when a `paneId` exists) / `cwd` / `version` / `server` / `host` (the right-cluster copy fragments gain rows because they can now fold; today they never dropped), **informational spans** for `metrics` / `ld` / `agt` / a paneId-less `tmx`, **action rows** for `palette` (`⌘K Command palette`) / `compose` (`a▏ Compose`) / `clock` (`◷ Cron List`, next-fire state only — the stale chip never folds). `pr` / `fab` never fold so never need a row.
- Keyboard contract unchanged (`top-bar-overflow-menu.tsx`'s): focus enters the panel on open (rAF), ArrowUp/ArrowDown rove with wrap, Escape closes and refocuses the chevron, outside `mousedown` closes; copy rows keep the menu open, action rows close it. **Drop the `checkVisibility` filter** in `rows_()` — no hidden rows remain (every rendered row is a folded segment).
- `useCopyFeedback` key union in the menu widens to `"git" | "tmx" | "cwd" | "version" | "server" | "host"`.

### 6. Clock chip

`hidden xl:flex` goes. `ClockChip` renders `flex` in both states; its fold item is `{ id: "clock", prio: 4 }` when `kind === "next"` and `{ prio: null }` when `kind === "stale"` (the connection-dot alarm precedent: an alarm must be visible at every width). The overflow `clk` row renders iff `"clock"` is folded.

### 7. Tests

**`lib/status-bar-fold.test.ts`** (new) — round-number widths, the gui module's fixture style:
- everything fits ⇒ `folded: []`, `truncateId: null`, no reserve consulted;
- ladder order: shrinking the budget folds `ld` → `compose` → `palette` → `cwd` → `tmx` → `clock` → `server` → `metrics` → `version` → `agt` → `git` → `host`, one at a time;
- ties fold rightmost first (`compose` before `palette`);
- never-fold items (`pr`, `fab`, `zen`, stale `clock`) survive at any budget;
- two-pass reserve: a budget that fits everything without the chevron folds nothing; a budget one px short re-fits with the chevron reserved and may fold one more item than the unreserved pass;
- last-survivor truncation: with only never-fold items left and still over budget, `truncateId === "fab"` (rightmost truncatable), never `pr` while `fab` is present, `null` when no truncatable item is present;
- gaps are charged per cluster (n−1 per side), none across the spring;
- hysteresis: collapse is immediate at the threshold; expanding needs `+24` px; an expand the shrunk budget cannot hold returns `prev`; truncation turning off counts as an expand;
- degenerate: all-zero widths ⇒ `prev`; cold (`prev === null`) ⇒ fully expanded; empty items ⇒ empty fold.

**`status-bar.test.tsx`** — the six breakpoint-class assertions (`xl:flex` on cwd, `xl:hidden` on the chevron wrapper and rows, `min-[700px]:inline` on version, `hidden xl:flex` on the next-fire chip, the `flex`/`hidden` stale chip check, the `xl:hidden` palette row) are replaced with fold-state assertions driven by the gui-toolbar harness: a `mockWidths(available, widths)` helper spying `HTMLElement.prototype.offsetWidth` (per `data-fold` key) and `clientWidth` (the `status-bar` root), mounted fresh per width case (the ResizeObserver stub never fires — measure-once-at-mount). New cases: wide budget ⇒ every segment in the strip and **no chevron**; a budget short by ~one `ld` ⇒ `ld` folds first and the chevron appears with exactly one row; a narrow budget ⇒ `tmx`/`cwd`/hints/`ld` fold and the menu lists them in strip order with `tmx`/`cwd` as copy buttons; a never-fold-only overflow ⇒ the `fab` value span carries `truncate` and nothing else does; stale `◷` survives a budget that folds the next-fire chip; the `cpu`/`mem` value spans carry `tabular-nums`; `mem` reads `41%` (24G/59G) not `24G/59G`; `ld` is its own segment. **Every existing test that opens the `…` menu** (the `tmx` strip/row agreement, the dim-prefix row check, the `clk` row cases, the copy-row cases, the arrow-nav rove) first drives a fold through the harness with a narrow `available` — without it the cold default renders no chevron. Kept as-is: copy/raw-value, selection guard, flyout, click seams, coalesced-hooks rerender, passive-segment, route-split cases.

**E2e `tests/e2e/status-bar.spec.ts`** — the width-sweep test (`narrow desktop width: …`) is rewritten: the fixture's short values (`wt`, `%1`, `main`) fit at 800 px, so the sweep goes narrower — **720 px** (above the 640 px mobile predicate) — where the natural width (~1000 px with the 48-char fab line and the full right cluster) forces `ld`, `a▏`, `⌘K`, `cwd`, `tmx` to fold; assert at 1440 px every segment is visible and the chevron is **absent** (`toHaveCount(0)`, no longer `toBeHidden`), at 720 px `wt` and `%1` are hidden, `main` / `waiting 3m` / the fab line / the PR anchor visible, `scrollWidth ≤ clientWidth`, the menu lists `tmx` and `cwd` (copy rows) and no `out` row, focus lands on the first row, ArrowDown/ArrowUp rove, ArrowUp off the first row wraps to the last row, Escape closes. The keyboard case (`overflow copy rows activate via keyboard`) re-points its viewport to the same 720 px and asserts focus lands on the **first folded row** (the `ld` informational span — `ld` is prio 0) and that ArrowDown reaches `Copy tmux pane id`, then Enter copies `%1` with the menu kept open. The first test's `hostCluster … "17%"` assertion stays; add `"41%"` (mem as percent). File-header comment and every touched `test()` JSDoc updated in the same commit (Constitution → Test Intent Comments).

**Gates** (in order): `cd app/frontend && npx tsc --noEmit`; **`just test-frontend` — the FULL Vitest suite** (the user's explicit instruction, overriding the plan's affected-files list: a scoped 4-file gate on change 1 missed a cross-file `getByText` regression in a shared-component test); `just test-e2e status-bar.spec` (pass the `.spec` suffix — a bare name also matches this worktree's path); `just test-e2e pane-register-panel.spec` and `just test-e2e tooltips.spec` as a regression check since they share the register resolvers. Never the full e2e suite as a gate; one full e2e run per worktree.

### 8. Memory + comments

- `docs/memory/run-kit/ui/status-signals.md § Status Bar (Shell-Level Strip)` — present-truth rewrite (no "was X, now Y"): the **Overflow** bullet (ladder → measured priority fold: the priority table, two-pass reserve, last-survivor truncation, fixed-width numerals, collapse-first, unmeasured ⇒ prev, one ladder across both clusters, the chevron iff folded, rows = folded ids in strip order, `checkVisibility` gone); the **Right cluster** text (`cpu N% · mem N%` with `gaugeColor` on the percent, `ld N%` its own passive segment; server/host/version each a fold item with a copy row; the host/version wrapper sentence loses `hidden min-[700px]:inline` and `min-w-0 truncate`); the **clock chip** sentence (`hidden xl:flex` → prio 4 / never); the **Copy affordances** sentence ("breakpoint/truncation classes ride the button unchanged, so the ladder is untouched" → the fold decides visibility; copy rows for server/host added); the **Coverage** bullet (`lib/status-bar-fold.test.ts` added; "ladder thresholds" → fold-state cases; the e2e sweep description).
- `status-signals.md § Design Decisions` — rewrite three: *Status-bar left cluster is branch-first descending relevance* (display order stays; survival order is now the priority table, not display order — drop "display order equals survival order" / "rightmost dies first"); *The `out` register leaves the status bar* (rationale unchanged; drop the "rides the bar to 640px" phrasing); *Stale clock chip survives the ladder; the next-fire chip does not* → *Stale clock chip never folds; the next-fire chip folds at priority 4* (drop the class-name framing); *Host and version are independent flex items* (keep — the reason still holds; drop the `min-[700px]:inline` class citation). Add one: *A measured priority fold replaces the breakpoint ladder* (four-field shape: Decision / Why — value-length, not viewport width, causes overflow; one ladder across both clusters / Rejected — breakpoints, horizontal scroll, two rows, a segment-visibility setting (Constitution IV) / Introduced by).
- `docs/memory/run-kit/ui/sidebar.md` — no change expected (its status-bar mentions are the panel-vs-bar ownership sentences, unaffected); verify with a grep for `ladder` before hydrate finishes.
- Resolve relative `](x.md)` links over the whole `docs/memory/run-kit/ui/` folder before review; regenerate `docs/memory/run-kit/ui/index.md` via `fab docs-index` only if `status-signals.md`'s frontmatter description changes ("degradation ladder" → "measured fold" is a one-word description change — regenerate).
- `architecture/repo-layout.md` does not enumerate `lib/` modules (verified by grep) — no change. `lenses-and-layout.md` / `gui.md` cite `gui-toolbar-fold` as the third instance — still true; untouched.
- `status-bar.tsx` header comment: the `OVERFLOW` block rewritten (see § 3).

## Affected Memory

- `run-kit/ui/status-signals`: (modify) § Status Bar — Overflow bullet rewritten for the measured priority fold (priority table, two-pass reserve, last-survivor truncation, fixed-width numerals, collapse-first, chevron iff folded); Right-cluster text (`cpu N% · mem N%`, `ld` own segment, server/host/version copy rows); clock-chip fold sentence; Copy-affordances sentence; Coverage bullet. § Design Decisions — three entries rewritten (branch-first, `out` leaves the bar, stale clock chip), one added (*A measured priority fold replaces the breakpoint ladder*). Frontmatter description updated if it names the ladder.
- `run-kit/ui/index`: (modify) regenerated by `fab docs-index` if `status-signals.md`'s description changes.

## Impact

**Frontend only** (`app/frontend/`); no backend, API, or tmux change; no new dependency.

- **New**: `src/lib/status-bar-fold.ts`, `src/lib/status-bar-fold.test.ts`.
- **Rewritten**: `src/components/status-bar.tsx` (the overflow machinery — `Segment` / `CopySegment` truncation prop, `WindowCluster`, `OverflowMenu`, `ClockChip` class, `StatusBar` root: probe row + `ResizeObserver` + `useLayoutEffect` measure; metrics diet), `src/components/status-bar.test.tsx` (fold harness; breakpoint assertions replaced), `tests/e2e/status-bar.spec.ts` (the width sweep and the keyboard case re-pointed; header + intent comments).
- **Unchanged consumers**: the three `StatusBar` mounts (`app.tsx:5285`, `board-page.tsx:995`, `host-overview-page.tsx:613`) — `StatusBarProps` is unchanged; `sidebar/registers.ts`; `pr-status-model.ts`; `host-metrics.tsx` (`HostMetrics`, `normalizeLoadPercent`); `lib/gauge.ts` (`gaugeColor` reused as-is; `formatMemory` loses its status-bar caller but keeps `HostMetrics`); `hooks/use-copy-feedback.ts`; the `Copy:` palette family (palette parity for every foldable copy segment already exists — Constitution V).
- **Behavioral contract**: every segment renders complete or folds; at most one truncation ever; the `…` chevron appears only when something is folded; `mem` reads as a percent on the strip (absolute values remain in the flyout); the clusters share one ladder. Mobile is unaffected (no bar).
- **Risk**: the collapse-first first frame renders only never-fold segments until the pre-paint `useLayoutEffect` — same as the gui toolbar, invisible in practice; a `ResizeObserver` on a 24 px strip fires on every window resize (the top bar already pays this cost). E2e width assertions depend on real Chromium text metrics — the intake pins a viewport (720 px) with ~280 px of slack rather than a boundary width.

## Open Questions

None blocking. Apply-time judgment calls (record in the plan's Design Decisions, not as clarifications):

- Whether the strip / probe / menu share one `SEGMENTS` render map keyed by id (recommended — the plan does not mandate the component's internal shape).
- Exact `min-w-[4ch]` vs `min-w-[3.5ch]` for the numeral reserve — verify `100%` fits at 10.5 px mono in Chromium; `4ch` is the safe default.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Implement the plan's Change 2 as written — priority table, fit charges (`PAD 16 + dot 8 + gap 12`), two-pass reserve, last-survivor truncation, 24 px expand hysteresis, cold fully-expanded, collapse-first | Plan § Change 2 items 1–8 state every value; Decisions of record fix the design | S:95 R:70 A:95 D:95 |
| 2 | Certain | Full `just test-frontend` is the unit gate, not the plan's affected-files list | User's explicit instruction; project memory records the change-1 miss | S:100 R:95 A:100 D:100 |
| 3 | Confident | `lib/status-bar-fold.ts` is a **sibling** of `gui-toolbar-fold.ts`, not a generalisation; no shared extraction of hysteresis / two-pass | Plan leaves extraction optional; both precedents deliberately keep an own constant to stay dependency-free (`gui-toolbar-fold.ts` header); a priority fold and a suffix fold share little beyond two constants | S:65 R:85 A:85 D:75 |
| 4 | Confident | Last-survivor truncation targets the **rightmost `truncatable` never-fold item** (`fab` before `pr`); `zen`, stale `◷`, the dot are never truncatable | Never-fold items share `prio: null`, so the plan's "lowest-priority survivor" needs a tiebreak; display order is the only one available, and `fab` carries the longer value | S:55 R:85 A:80 D:65 |
| 5 | Certain | Measure on mount in `useLayoutEffect`; `ResizeObserver` observes the bar root AND the probe; the effect re-runs on a serialized candidate-set key (present ids + clock kind + zen) | Direct port of `gui-toolbar.tsx`'s wiring; value-only width changes reach the fit through the observed probe, which is what makes the fixed-width numerals sufficient to stop metrics-tick re-folds | S:70 R:90 A:90 D:80 |
| 6 | Certain | Numeral reserve is `tabular-nums` + `min-w-[4ch] text-right` on the `cpu`, `mem`, `ld` value spans | `100%` is the four-character worst case; the plan names the mechanism, not N | S:65 R:95 A:90 D:85 |
| 7 | Confident | E2e sweep narrows to **720 px** with the fixture branch left as `main`, rather than lengthening the branch | Three other tests assert `main`; the fab line stays 48 chars because `main` is off-branch; 720 px sits well above the 640 px mobile predicate and ~280 px under the natural width | S:65 R:90 A:80 D:70 |
| 8 | Certain | `…` menu gains copy rows for `server` and `host` | They become foldable fold items; Constitution V requires the copy action to remain reachable while folded (the same rule that gave `git`/`tmx`/`cwd`/`version` rows) | S:70 R:90 A:95 D:90 |
| 9 | Certain | `sidebar.md` and `architecture/repo-layout.md` need no edit; only `status-signals.md` (+ regenerated `ui/index.md`) hydrates | Grep: sidebar.md's bar mentions are ownership sentences with no ladder detail; repo-layout does not list `lib/` modules | S:80 R:95 A:90 D:90 |
| 10 | Confident | Unit tests that open the `…` menu each drive a fold via a `mockWidths` harness with a narrow `available`, one mount per width case | Under the fold the chevron renders only when something folds, and jsdom's zero widths land on the fully-expanded cold default; the gui harness pattern is measure-once-at-mount, so per-case mounts are required — apply may find a lighter shared helper | S:60 R:90 A:75 D:55 |

10 assumptions (6 certain, 4 confident, 0 tentative, 0 unresolved). Run /fab-clarify to review.
