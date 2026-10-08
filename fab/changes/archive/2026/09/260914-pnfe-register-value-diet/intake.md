# Intake: Register Value Diet

**Change**: 260914-pnfe-register-value-diet
**Created**: 2026-09-14

## Origin

One-shot `/fab-new` invocation pointing at a pre-agreed plan:

> Implement Change 1 (register value diet, slug: register-value-diet) from fab/plans/sahil/26-09-14-pane-status-bar-density.md — Change 0 (status-bugs-ordinal-version, PR #974) is merged to main. Read the full plan file (Standing context, Decisions of record, Sequencing, and the Change 1 section) for exact steps, tests, and memory updates.

The plan (`fab/plans/sahil/26-09-14-pane-status-bar-density.md`, drafted 2026-09-14 from a `/fab-discuss` session) is the decision record; its design study is `docs/wiki/pane-status-bar-density-studies.html` (Studies A–F). This change is the second of four (`0 → 1 → {2 ∥ 3}`): change 0 (PR #974, merged at `332d4fee`) added `getTmxLabel` with correct ordinal arithmetic and split the bar's version fragment into its own segment. Changes 2 (status-bar measured fold) and 3 (PANE-on yields the bar + continuation lines) both start from main after this change merges and consume the resolvers this change rewrites — so the resolver signatures fixed here (`getFabParts(win, branch?)`, the `%id · n/m` grammar) are a contract for those changes, not a private detail.

The branch `register-value-diet` already exists as this worktree's branch (a hand-named worktree branch, not yet tracking origin); `/fab-new` renames it to the change folder name.

## Why

The desktop PANE panel at its 220 px default sidebar width has a ~22-character value budget per row (study § C). Today the highest-value rows blow it:

- `fab  260913-png4-compose-default-on · apply · active` — the change **slug is written four times** on screen (window name, `git` row, `fab` row, bar `⑂` + `fab` segments) and the `fab` row truncates before its decisive tokens (`stage · state`) appear.
- `tmx  pane 1/1 %107` spends eight characters on `pane 1/1` for a one-pane window, which is the overwhelming case; the id is the copyable value and the thing an operator types into `tmux`.
- `cwd  …/run-kit.worktrees/compose-default-on` truncates at the **tail** — the worktree basename, which is the answer — because `shortenPath` keeps the last two segments and the row's `truncate` eats from the right.
- `out  claude — idle 4s since last output` narrates what the tier-1 tip already says; the register fits nothing else.
- `git  260913-png4-compose-default-on` — the six-digit date prefix is the least scannable part of the branch yet renders at full weight.

If nothing changes, change 3's continuation lines and change 2's measured fold both work from bloated strings, so the fold folds more and the continuation wraps more than necessary; and the three register surfaces (panel, row flyout card, bar) each carry their own local trim, which is exactly the drift the shared resolver module was extracted to prevent.

Why this approach: **the five registers stay orthogonal** (spec § Row Minimalism, decided) — nothing merges, drops, or reorders a register. Every edit acts on the *value* a register renders or on the identity rows, and every value rule lives in `sidebar/registers.ts` so the panel, the flyout card, and the status bar change together (Constitution X — mirror, never re-derive: the resolvers gain a `branch` *parameter*, no new derivation). Rejected in the study § F: collapsing registers into one line; a settings surface for which segments show (Constitution IV); dropping the `git` row when it equals the change (the most-copied row); renaming the L1 agent vocabulary (`active`/`waiting`/`idle` is written by harness hooks and read cross-repo — `agent-state.md` — not ours).

## What Changes

All frontend, under `app/frontend/src/`. Wire values (`WindowInfo.activity`, `agentState`, `fabDisplayState`, …) are untouched — this is render-only.

### 1. `getFabParts(win, branch?)` / `getFabLine(win, branch?)` — the slug is written once (`components/sidebar/registers.ts`)

Both resolvers gain an optional second argument `branch?: string` (the active pane's git branch).

- When `branch` is given **and** `branch.endsWith(`${id}-${slug}`)`: `parts.slug` is `undefined` and the line is `<id> · <stage>[ · <displayState>]`.
- Otherwise (no `branch`, `main`, a hand-named `t7vy-launch`): unchanged — `<id> <slug> · <stage>[ · <displayState>]`. The slug's presence beside a branch row is then the signal that the pane is *off* its change branch (the situation the `git-pr` branch guard trips on).

`FabParts.slug` becomes `slug?: string`. Type example:

```ts
export type FabParts = { id: string; slug?: string; stage: string; displayState?: string };
export function getFabParts(win: WindowInfo, branch?: string): FabParts | null
export function getFabLine(win: WindowInfo, branch?: string): string | null
```

Callers pass the active pane's `gitBranch` (`win.panes?.find(p => p.isActive)?.gitBranch`):

- `components/sidebar/status-panel.tsx` `WindowContent` — already computes `gitBranch`; pass it to `getFabLine`/`getFabParts`.
- `components/sidebar/row-flyout-card.tsx` (line ~703 `getFabParts(win)`) — pass the branch; its `row-flyout-fab-slug` `ContinuationLine` already renders only `{fabParts.slug && …}`, so it disappears when the branch carries the slug with no further change.
- `components/status-bar.tsx` `WindowCluster` (line ~335 `getFabLine(win)`) — pass `gitBranch` (already computed at line ~333).

Copy value stays the 4-char id on every surface.

**State colour**: surfaces compose from `getFabParts` and render `displayState` in the fab hue vocabulary; `getFabLine` stays the plain-text form (copy/aria/`title`). Add a `FAB_STATE_COLORS` map beside `PR_STATE_COLORS` in `components/pr-status-model.ts` (the shared status-vocabulary home). `PHASE_HUE` does **not** map cleanly (it is keyed by dot phase — blue `building` / green `prReady` — not by display state), so a new map is needed. The backend display-state vocabulary is `active | ready | pending | done | failed` (`api/sortwindows.go`):

```ts
/** fab displayState → hue token. Green = running or landed, yellow = waiting
 *  on a gate, red = a stage failed. Same signal tokens the PR vocabulary uses. */
export const FAB_STATE_COLORS: Record<string, string> = {
  active: "text-accent-green",
  done: "text-accent-green",
  ready: "text-signal-yellow",
  pending: "text-signal-yellow",
  failed: "text-signal-red",
};
```

Unknown states fall back to the row's default text colour (`FAB_STATE_COLORS[state] ?? ""`). The panel's `fab` row, the flyout card's `row-flyout-fab` line, and the bar's `fab` segment all render `<id>[ <slug>] · <stage>` in their existing colour and ` · <state>` in the mapped hue; `group-hover:text-accent` still applies on the copyable surfaces.

### 2. `getTmxLabel` grammar — the pane id leads, the ordinal only disambiguates (`registers.ts`)

Replace the `pane <ordinal>/<count>[ <paneId>]` grammar (change 0's arithmetic stays):

| Shape | Renders |
|-------|---------|
| one pane, id `%107` | `%107` |
| three panes, active third, id `%109` | `%109 · 3/3` |
| multi-pane, no active pane / empty `paneId` (thin window) | `2/3` (ordinal falls back to 1 ⇒ `1/3`) |
| one pane, no `paneId` | `` (empty) — the panel's passive `tmx` branch renders the row with an empty value; the bar's `Segment` fork likewise |

Rule: `panes.length <= 1` ⇒ id only; otherwise `<id> · <ordinal>/<count>`, with the id segment omitted when empty. The three consumers from change 0 (`status-panel.tsx` `tmxLabel`, `status-bar.tsx` `WindowCluster.tmxValue` and `OverflowMenu.tmxRest`) need no code change beyond the resolver — they already render `getTmxLabel(win)`. Copy value stays `activePane.paneId`.

### 3. `getOutputLine` — L0 says `flowing`, no narration (`registers.ts`)

| Input | Renders |
|-------|---------|
| `activity: "active"`, command `claude` | `claude · flowing` |
| `activity: "active"`, no command | `flowing` |
| idle, command `zsh`, `activityTimestamp` 4 m ago | `zsh · idle 4m` |
| idle, no command, timestamp | `idle 4m` |
| idle, command, no timestamp (or elapsed ≤ 0) | `zsh` |
| idle, no command, no timestamp | `idle` |

"flowing" is the spec's own L0 word (§ Duration-Text Ladder: *L0 reads "flowing"*). The "since last output" narration moves nowhere — the tier-1 `Output activity` tip carries the meaning. The per-second `useNow()` tick stays in `WindowContent`. The L1 `agt` vocabulary is **not** touched (`getAgentLine` unchanged).

### 4. `cwd` row — basename-first, the parent yields (`status-panel.tsx`)

Delete `shortenPath` (and its `describe("shortenPath")` block at `status-panel.test.tsx:179`, plus the helper comment at line ~31). The `cwd` value becomes two spans inside the `CopyableRow`:

```tsx
// parent: `abbreviateHomePath(dirname)` incl. trailing "/", dim, head-truncating
<span className="min-w-0 truncate text-text-secondary" dir="rtl"><bdi dir="ltr">{parent}</bdi></span>
// basename: never truncates
<span className="shrink-0 text-text-primary group-hover:text-accent">{basename}</span>
```

- The row's value container becomes a `flex min-w-0` so the parent span can shrink while the basename holds. `CopyableRow` is a `<button>` with `truncate`; the children need a flex wrapper span (the `PrLinkRow` anchor is already the flex precedent).
- Head truncation: `direction: rtl` on the truncating span with the text isolated in `<bdi dir="ltr">` so glyph order is unchanged and only the ellipsis moves to the head. **Verify in Chromium** (a jsdom unit test cannot); if the ellipsis renders wrong, fall back to a JS middle-ellipsis on measured width.
- `dirname`/`basename` split on the last `/` of the **abbreviated** path (`~/code/sahil87/run-kit.worktrees/` + `register-value-diet`); a root-level or single-segment path renders the whole value as basename with no parent span.
- The `(deleted)` marker and `text-signal-red` follow the **whole** value (both spans red when `cwdMissing`); `title` (full path, `(no longer exists)` suffix) and the copy value (full unabbreviated path) are unchanged.
- The status bar's `cwd` segment keeps its basename-only form (decision of record).

### 5. `git` row + bar `⑂` segment — dim date prefix

Wrap a leading `^\d{6}-` in `<span className="text-text-secondary">`; the rest stays `text-text-primary`. Applies to the panel `git` row (`status-panel.tsx`) and the bar's `⑂` `CopySegment` (`status-bar.tsx` ~line 349). The bar's overflow `⑂` row (`OverflowMenu` `copyRow("git", …)`) is a menu item and stays plain. Copy value unchanged (full branch). Branches without the prefix (`main`) render as today. A tiny shared helper (e.g. `splitDatePrefix(branch): { prefix: string; rest: string }` in `registers.ts`) keeps the two sites on one regex.

### 6. Tests

Unit (Vitest, colocated):

- `registers.test.ts` — `getFabParts`/`getFabLine`: slug carried by branch (omitted), branch not carrying (kept), `main` (kept), no branch arg (kept); `getTmxLabel`: the three shapes above; `getOutputLine`: the six shapes above (the existing `active · claude` / `since last output` expectations are rewritten); `splitDatePrefix` if added.
- `status-panel.test.tsx` — `cwd` two spans (parent dim + `bdi`, basename primary), root/single-segment path, `(deleted)` case colours both spans; `git` dim prefix present (`260913-…`) / absent (`main`); `out` strings; `fab` state span carries the `FAB_STATE_COLORS` class; `tmx` renders `%5` alone for one pane. Remove the `shortenPath` describe.
- `row-flyout-card.test.tsx` — the existing "slug continuation" case (line ~257, fixture branch not carrying the slug) keeps asserting `row-flyout-fab-slug`; add a case with the active pane's `gitBranch` = `260xxx-93dy-<slug>` asserting the continuation is absent and the state token is coloured.
- `status-bar.test.tsx` — `pane 1/1 %5` → `%5` (lines ~104–122, the overflow row `tmx %5`), fab string with/without slug, `⑂` dim prefix span.

E2e (`just test-e2e <name>.spec`, single specs; intent JSDoc updated in the same commit — Constitution Test Intent Comments):

- `tests/e2e/status-bar.spec.ts` — `pane 1/1 %1` → `%1` at ~128/200/209 and the `Proves`/`Steps` text at ~114–115, ~302–310. The fab assertion at ~132 (`/ldbs shell-stage-status-bar · apply/`) **stays valid**: the fixture branch is `main`, so the slug is kept — note this in the intent comment as the off-branch case.
- `tests/e2e/pane-register-panel.spec.ts` — give the @1 fixture's active pane `gitBranch: "260706-y1ar-status-pyramid-ui-surfacing"` (it has none today) and assert the fab register reads `y1ar · review · failed` without the slug; keep the `waiting 3m` L1 assertion and `register-output` contains `out`.
- `tests/e2e/tooltips.spec.ts` — unchanged (hovers the `tmx` key label, which does not move).

Gates: `cd app/frontend && npx tsc --noEmit`; `pnpm vitest run` on the four test files by path; the two e2e specs above. Never the full e2e suite as a gate; one full `just test-e2e` per worktree at most.

### 7. Spec + memory

**Spec** `docs/specs/status-pyramid.md` § Row Minimalism example block: `out  claude · flowing` (was `active · 4s since last output`), `fab  dmex · review · failed` (id form — the example was already slug-less); add one sentence: *the slug is written once — the branch carries it*.

**Memory** (present-truth style — rewrite the sentences, no "was X, now Y" narration; resolve relative `](x.md)` links across `docs/memory/run-kit/ui/` before review; `fab docs-index` only if a frontmatter description changes):

- `docs/memory/run-kit/ui/status-signals.md` § Pane panel five-register view — the grammar block (`out` / `fab` lines), the L0 and L2 bullets, the "identity rows" sentence (`tmx` grammar, `cwd` basename-first with yielding parent, dim date prefix); § Register resolvers — the `branch` parameter, `FabParts.slug` optional, `getTmxLabel` grammar, `getOutputLine` vocabulary; § Row-hover register flyout card — the slug continuation is gated on the branch; § Status Bar — the left-cluster strings (`fab` id-form, `tmx` id-first, `⑂` dim prefix); § Shared PR vocabulary — `FAB_STATE_COLORS` joins the file. Design Decisions to add (four-field shape): *The slug is written once — the branch carries it*; *`tmx` shows the pane id; the ordinal only disambiguates*; *`cwd` is basename-first; the parent yields*; *L0 says flowing, L1 says active*.
- `docs/memory/run-kit/ui/sidebar.md` § Collapsible Panels → WindowPanel (`tmx` row description) and the Copyable rows table (copy values unchanged; the display column changes — `%5` alone, two-span `cwd`, dim `git` prefix); the `cwd` deleted-directory marker paragraph (no longer "shortened stale path").

## Affected Memory

- `run-kit/ui/status-signals`: (modify) five-register view grammar + L0/L2 bullets, register resolvers (`branch` param, `getTmxLabel`, `getOutputLine`), flyout-card slug gate, status-bar left-cluster strings, `FAB_STATE_COLORS` in the shared vocabulary, four new Design Decisions
- `run-kit/ui/sidebar`: (modify) WindowPanel `tmx`/`cwd`/`git` row descriptions and the Copyable rows display column; `cwd` deleted marker paragraph

## Impact

- **Source**: `app/frontend/src/components/sidebar/registers.ts` (rewritten resolvers), `components/sidebar/status-panel.tsx` (rows; `shortenPath` deleted), `components/sidebar/row-flyout-card.tsx` (branch arg + state colour), `components/status-bar.tsx` (fab/tmx/`⑂` strings — no ladder or layout change; change 2 rewrites the file after this merges), `components/pr-status-model.ts` (`FAB_STATE_COLORS`).
- **Tests**: `registers.test.ts`, `status-panel.test.tsx`, `row-flyout-card.test.tsx`, `status-bar.test.tsx`; e2e `status-bar.spec.ts`, `pane-register-panel.spec.ts`.
- **Docs**: `docs/specs/status-pyramid.md`, `docs/memory/run-kit/ui/status-signals.md`, `docs/memory/run-kit/ui/sidebar.md`.
- **Downstream contract**: changes 2 and 3 consume `getFabParts(win, branch)` and the dieted strings; the mobile status rail / tier cards render the same resolvers and pick the diet up with no change.
- **No backend, API, or wire change.** No new settings, no stored state (Constitution IV). Every copy action keeps `useCopyFeedback` and its palette parity (Constitution V).

## Open Questions

- None blocking. The rtl+`bdi` head-truncation idiom is verified at apply time in Chromium (Playwright screenshot or `just dev`); the plan names the JS middle-ellipsis fallback if it fails.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Registers stay orthogonal; this change edits only values and identity rows | Spec § Row Minimalism decided + plan Decisions of record | S:95 R:90 A:95 D:95 |
| 2 | Certain | `getFabParts`/`getFabLine` take an optional `branch` and omit the slug iff `branch.endsWith(`${id}-${slug}`)`; callers pass the active pane's `gitBranch` | Plan § Change 1 step 1 verbatim; the rule lives in the shared resolver (Constitution X) | S:95 R:85 A:95 D:95 |
| 3 | Certain | `tmx` grammar: `%107` single-pane, `%107 · 2/3` multi-pane, `2/3` when paneId-less; ordinal = position in `win.panes` | Plan step 2 + decision of record; change 0 fixed the arithmetic | S:95 R:90 A:95 D:95 |
| 4 | Certain | `out` reads `<cmd> · flowing` / `<cmd> · idle Xm` / `<cmd>` / `idle`; `agt` vocabulary untouched | Plan step 3; "flowing" is the spec's L0 word; L1 is cross-repo hook-written | S:95 R:90 A:95 D:95 |
| 5 | Certain | `cwd` panel row is two spans (dim head-truncating parent + `shrink-0` primary basename); `shortenPath` deleted; bar `cwd` stays basename-only | Plan step 4 + decision of record | S:90 R:85 A:90 D:90 |
| 6 | Confident | Head truncation via `direction: rtl` on the parent span with `<bdi dir="ltr">` text; verified in Chromium at apply, JS middle-ellipsis fallback if wrong | Plan specifies the idiom and the fallback; jsdom cannot verify rendering | S:80 R:80 A:60 D:70 |
| 7 | Certain | Leading `^\d{6}-` on `git` row and bar `⑂` segment renders `text-text-secondary`; copy unchanged; overflow-menu row stays plain | Plan step 5; the overflow row is a menu item, not a strip segment | S:90 R:90 A:90 D:90 |
| 8 | Confident | `FAB_STATE_COLORS` is a new map in `pr-status-model.ts` (not `PHASE_HUE`): active/done green, ready yellow, failed red; `pending` yellow; unknown ⇒ no class | Plan offers either home; `PHASE_HUE` is keyed by dot phase and does not map; `pending` is in the backend vocabulary but not the plan — grouped with `ready` as "waiting on a gate" | S:65 R:90 A:75 D:65 |
| 9 | Certain | Fixture updates: `status-bar.spec.ts` `pane 1/1 %1` → `%1` (branch `main` keeps the fab slug — the existing fab assertion stays valid); `pane-register-panel.spec.ts` @1 pane gains `gitBranch` carrying `y1ar` and asserts the slug-less fab line | Plan step 6 + fixture inspection (`gitBranch: "main"` at status-bar.spec:47; no `gitBranch` at pane-register-panel.spec:53) | S:90 R:95 A:90 D:90 |
| 10 | Certain | Spec § Row Minimalism example + status-signals/sidebar memory updated per plan step 7; four Design Decisions added; present-truth style | Plan step 7 + Standing context memory hygiene | S:90 R:90 A:90 D:90 |
| 11 | Certain | Gates: `tsc --noEmit`, four Vitest files by path, `just test-e2e status-bar.spec` + `pane-register-panel.spec`; no full-suite gate | Standing context § Verification per change | S:95 R:95 A:95 D:95 |
| 12 | Confident | A small shared `splitDatePrefix` helper in `registers.ts` keeps the panel and bar on one regex | Two sites, one rule — the module's stated purpose; cheap to inline instead if review prefers | S:70 R:95 A:85 D:75 |

12 assumptions (9 certain, 3 confident, 0 tentative, 0 unresolved).
