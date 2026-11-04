# Intake: Status Bugs — Pane Ordinal + Version Segment

**Change**: 260913-gpi7-status-bugs-ordinal-version
**Created**: 2026-09-14

## Origin

> Implement Change 0 (pane ordinal + version segment, slug: status-bugs-ordinal-version) from fab/plans/sahil/26-09-14-pane-status-bar-density.md — read the full plan file (Standing context, Decisions of record, Sequencing, and the Change 0 section) for exact steps, tests, and memory updates.

One-shot invocation of `/fab-new` against a written plan. The plan (`fab/plans/sahil/26-09-14-pane-status-bar-density.md`, drafted 2026-09-14 against `65653f4d` from the same-day `/fab-discuss` session) is the decision record; its design study `docs/wiki/pane-status-bar-density-studies.html` (Studies A–F) is the contract of record. This is **Change 0 of 4** — the strictly-sequential first rung (`0 → 1 → {2 ∥ 3}`); change 1 (register value diet) starts from merged main after this lands and rewrites the same three source files, so this change deliberately fixes the *arithmetic* under today's `pane n/m` grammar and leaves the grammar switch to change 1.

Key decisions carried in from the plan's *Decisions of record*:

- **`tmx` ordinal is the active pane's position in `win.panes`** (1-based), never `paneIndex + 1`. tmux's `#{pane_index}` already honours `pane-base-index` (this host: `1`), which is why today's panel reads `pane 2/1` for a single pane.
- **The version fragment becomes its own segment.** Today it shares one truncating span with the host name and vanishes by truncation long before its documented `< 700 px` drop — the memory and the DOM disagree. Fixed here within the current CSS ladder; change 2 later gives it a fold priority.
- **The five signal registers stay orthogonal** — nothing here merges, drops, or reorders a register; `tmx` is an identity row (pane metadata), not a register.

## Why

**Bug 1 — the pane ordinal is off by one under `pane-base-index 1`.** Three sites compose the `tmx` value inline as `pane ${paneIndex + 1}/${panes.length}`:

- `app/frontend/src/components/sidebar/status-panel.tsx` — `WindowContent` (`activePaneIndex + 1`, both the copyable and the passive branch)
- `app/frontend/src/components/status-bar.tsx` — `WindowCluster.tmxValue`
- `app/frontend/src/components/status-bar.tsx` — `OverflowMenu`'s `tmxRest`

`paneIndex` is the backend's verbatim `#{pane_index}` (`internal/tmux/tmux.go` `PaneIndex`, format field `#{pane_index}`), and tmux numbers panes from `pane-base-index`. On this host (`tmux show -g pane-base-index` → `1`) a single-pane window therefore renders **`pane 2/1 %107`** in the PANE panel, the status bar, and the bar's `…` overflow row — a value that is both wrong and self-contradictory (ordinal exceeds count). Every desktop viewer with `pane-base-index 1` (the common tmux config, matching `base-index 1`) sees this on every window. If left alone, change 1's grammar switch (`%107 · 2/3`) would carry the same off-by-one into a form where it reads as "pane 2 of 3" with no visible contradiction to flag it.

**Bug 2 — the version fragment truncates instead of dropping.** In `status-bar.tsx`'s right cluster the host name and version render as two `<button>`s inside **one** `min-w-0 truncate` span:

```tsx
{(hostName || version) && (
  <span className="min-w-0 truncate whitespace-nowrap">
    {hostName && <button …>{hostName}</button>}
    {version && <button className={`${VALUE_CLASS} hidden min-[700px]:inline …`}>{hostName ? " " : ""}{version}</button>}
  </span>
)}
```

Because the flexible span truncates as a unit, the *trailing* content — the version — is the first thing the ellipsis eats when the right cluster is squeezed, at widths far above 700 px (the design study measured it gone at 1512 px with long left-cluster values). The documented ladder (`status-signals.md § Status Bar`: "…then `version` (≥700px)") describes a segment that drops at a breakpoint; the DOM delivers a segment that disappears by truncation. The `…` overflow menu's `version` row is gated `min-[700px]:hidden`, so between ~700 px and the truncation width the version is visible **nowhere** — neither in the strip nor in the menu.

**Why this approach.** Both fixes are mechanical and precede the larger plan: change 0 is the plan's "light lane" rung (two arithmetic/markup fixes + tests), scheduled first so that change 1 rewrites correct code and change 2's measured fold inherits a version segment that is already an independent flex item. Moving the `tmx` label into `registers.ts` (beside the register resolvers the panel, flyout card, and bar already share) is what stops the three sites from disagreeing again — the same reason `getFabLine`/`getOutputLine` were extracted there.

## What Changes

### 1. `getTmxLabel(win)` — shared identity-row label in `registers.ts`

New exported pure function in `app/frontend/src/components/sidebar/registers.ts`:

```ts
/** Build the `tmx` identity-row label: `pane <ordinal>/<count>[ <paneId>]`.
 *  The ordinal is the ACTIVE pane's 1-based position in `win.panes` — never
 *  `paneIndex + 1`, because tmux's `#{pane_index}` already honours
 *  `pane-base-index` (a single pane under base-index 1 would read `2/1`).
 *  The id suffix comes ONLY from the active pane (consumers copy
 *  `activePane.paneId`; a label must never show an id nothing copies), so
 *  with no pane marked active the ordinal falls back to 1 and no id is shown
 *  — a window with no panes reads `pane 1/0` (the passive, paneId-less form). */
export function getTmxLabel(win: WindowInfo): string {
  const panes = win.panes ?? [];
  const activeIdx = panes.findIndex((p) => p.isActive);
  const ordinal = (activeIdx >= 0 ? activeIdx : 0) + 1;
  const paneId = activeIdx >= 0 ? panes[activeIdx].paneId : "";
  return `pane ${ordinal}/${panes.length}${paneId ? ` ${paneId}` : ""}`;
}
```

Exact behaviours:

| `win.panes` | Output |
|---|---|
| `[{paneIndex: 1, paneId: "%107", isActive: true}]` | `pane 1/1 %107` |
| three panes, `paneIndex` 1/2/3, third active `%109` | `pane 3/3 %109` |
| `[{paneIndex: 0, paneId: "%1", isActive: true}]` (e2e fixture shape) | `pane 1/1 %1` (unchanged — today's e2e assertions stay valid) |
| one pane, `paneId: ""`, active | `pane 1/1` |
| `[]` / `undefined` | `pane 1/0` (matches today's rendering and the existing `status-bar.test.tsx` "paneId-less tmx" assertion) |
| two panes, neither active | `pane 1/2` — ordinal falls back to 1, no id (the id is the active pane's or nothing, so the panel's passive no-copy branch never shows an id it cannot copy) |

The file-header comment of `registers.ts` gains one sentence noting that the `tmx` identity-row label lives here too so that its three consumers (PANE panel, status-bar strip, status-bar overflow row) render one string — identity rows are pane metadata, not registers, and the header must not imply otherwise.

**Consumers replace their inline composition** (copy value stays `paneId`; the paneId-less passive branches are unchanged):

- `status-panel.tsx` `WindowContent`: delete `paneCount` / `activePaneIndex`; both the `CopyableRow` branch and the passive `<div>` branch render `{getTmxLabel(win)}`. The passive branch is entered exactly when the active pane's `paneId` is empty (or no pane is active), and the label's id comes only from the active pane, so the two agree by construction: no copyable id ⇒ no id in the label.
- `status-bar.tsx` `WindowCluster`: `const tmxValue = getTmxLabel(win);` (drop `paneCount`; `paneId`/`activePane` remain for the copy value and cwd/git).
- `status-bar.tsx` `OverflowMenu`: `const tmxRest = getTmxLabel(win);` feeding the existing `copyRow("tmx", "tmx ", tmxRest, …)` / `textRow("tmx", \`tmx ${tmxRest}\`, …)` pair.

### 2. Version as its own segment in `status-bar.tsx`

The shared `min-w-0 truncate` span becomes a **non-truncating flex wrapper** holding two independent flex items, so the host shortens and the version drops — never the reverse. The right cluster itself is `flex items-center gap-3 min-w-0` (`data-testid="status-bar-host"`); the pair keeps its own tighter `gap-1` so `<host> v<version>` still reads as one fragment (today's single-space spacing), instead of splitting into two `gap-3` cluster items:

```tsx
{(hostName || version) && (
  <span className="flex items-center gap-1 min-w-0 whitespace-nowrap">
    {hostName && (
      <button
        type="button"
        aria-label="Copy host name"
        onClick={() => copy("host", hostName)}
        className="min-w-0 truncate text-text-secondary cursor-pointer bg-transparent border-0 p-0 hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-green"
      >
        {copiedKey === "host" ? "copied ✓" : hostName}
      </button>
    )}
    {version && (
      <button
        type="button"
        aria-label="Copy version"
        onClick={() => copy("version", version)}
        className={`${VALUE_CLASS} shrink-0 hidden min-[700px]:inline cursor-pointer bg-transparent border-0 p-0 hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-green`}
      >
        {copiedKey === "version" ? "copied ✓" : version}
      </button>
    )}
  </span>
)}
```

- Wrapper: `flex items-center gap-1 min-w-0` and **no `truncate`** — it only passes the squeeze down to its children. `min-w-0` on the wrapper is required for the nested host truncation to engage (a flex item's default `min-width: auto` would otherwise refuse to shrink below content width).
- Host: `min-w-0 truncate` — the flexible value that shortens under pressure (the same treatment `<server>` already has).
- Version: `shrink-0 hidden min-[700px]:inline` — never truncates; appears/disappears only at its breakpoint, matching the documented ladder. The overflow `version` row (`min-[700px]:hidden`) is unchanged, so the segment is visible in exactly one place at every width.
- The `{hostName ? " " : ""}` leading-space hack is removed — the wrapper's `gap-1` is the separator.
- The `OVERFLOW` header comment block and the inline "(≥xl) → ld (≥lg) → cpu/mem (≥md) → version (≥700px)" comment stay accurate as written (the ladder is unchanged; only the DOM now honours it). No change-ID citations in any new comment.

### 3. Tests

- **`sidebar/registers.test.ts`** — new `describe("getTmxLabel")`: single pane with `paneIndex: 1` ⇒ `pane 1/1 %107`; three panes `paneIndex` 1/2/3 with the third active ⇒ `pane 3/3 %109`; one active pane with empty `paneId` ⇒ `pane 1/1`; no panes ⇒ `pane 1/0`.
- **`sidebar/status-panel.test.tsx`** — a fixture case with one pane at `paneIndex: 1` asserting the `tmx` row reads `pane 1/1 %5` (the row's accessible name / text), covering the copyable branch; the existing `paneIndex: 0` cases keep asserting `pane 1/1`.
- **`status-bar.test.tsx`** — (a) a `paneIndex: 1` single-pane window case asserting `pane 1/1 %5` in the strip (and in the `…` overflow `tmx` row); (b) the host+version test additionally asserts that the `Copy host name` and `Copy version` buttons are **separate sibling flex items** (`hostBtn.parentElement === versionBtn.parentElement`, and that shared parent does **not** carry `truncate`), that the host button carries `truncate`, and that the version button's class list contains `min-[700px]:inline` and `shrink-0`; (c) the existing `pane 1/0` passive assertion stays.
- **E2e** — `tests/e2e/status-bar.spec.ts` asserts `pane 1/1 %1` at four sites with a `paneIndex: 0` single-pane fixture; ordinal 1 is unchanged, so **no e2e edit is expected**. Run `just test-e2e status-bar.spec` (with the `.spec` suffix — a bare name also matches this worktree's path) to confirm; if any assertion moves, update its JSDoc intent comment in the same commit (Constitution § Test Intent Comments).
- Verification gates: `cd app/frontend && npx tsc --noEmit`; `pnpm vitest run src/components/sidebar/registers.test.ts src/components/sidebar/status-panel.test.tsx src/components/status-bar.test.tsx` (from `app/frontend`); the single e2e spec above. Never the full e2e suite as a gate; one full run per worktree at a time.

### 4. Memory

- **`docs/memory/run-kit/ui/sidebar.md` § WindowPanel** — the identity-row sentence "`tmx` (pane index + ID)" becomes the present-truth rule: `tmx` shows the active pane's **ordinal position in the window's pane list** (1-based, from `getTmxLabel` in `registers.ts`) plus the pane ID — independent of tmux's `pane-base-index`, which `paneIndex` already honours and must therefore never be re-offset. The Copyable rows table (`tmx` → Pane ID, `activePane.paneId`) is unchanged.
- **`docs/memory/run-kit/ui/status-signals.md` § Status Bar** right-cluster bullet — `<host> v<version>` becomes two independently-sized fragments in one `gap-1` pair: `<host>` (the flexible `min-w-0 truncate` value) · `v<version>` (a `shrink-0` segment that **drops at the 700 px ladder step and never truncates**; omitted until the first `version` event). Rewrite the sentence, do not append "was X, now Y" narration. The Overflow bullet's ladder text already lists `version (≥700px)` and stays.
- Resolve relative `](x.md)` links across `docs/memory/run-kit/ui/` before review; regenerate `docs/memory/run-kit/ui/index.md` via `fab docs-index` only if a file description changes (none is expected to).

### Non-goals

- The `tmx` grammar change (`%107` / `%107 · 2/3`) — change 1.
- Any other bar segment, the CSS breakpoint ladder itself, or a measured fold — change 2.
- The PANE-on yield gate and continuation lines — change 3.
- Any backend change: `paneIndex` stays tmux's raw `#{pane_index}` (other consumers — layout restore, board pane ordering — rely on it being verbatim).

## Affected Memory

- `run-kit/ui/sidebar`: (modify) § WindowPanel identity-row sentence — `tmx` is the active pane's 1-based ordinal in `win.panes` + pane ID, robust to `pane-base-index`
- `run-kit/ui/status-signals`: (modify) § Status Bar right-cluster sentence — `<host>` and `v<version>` are two fragments; version is a `shrink-0` segment that drops at 700 px instead of truncating

## Impact

- **Source** (3 files): `app/frontend/src/components/sidebar/registers.ts` (+1 exported function, header note), `app/frontend/src/components/sidebar/status-panel.tsx` (`WindowContent` tmx row, both branches), `app/frontend/src/components/status-bar.tsx` (`WindowCluster.tmxValue`, `OverflowMenu.tmxRest`, the right-cluster host/version markup).
- **Tests** (3 files): `registers.test.ts`, `status-panel.test.tsx`, `status-bar.test.tsx`. E2e `status-bar.spec.ts` run-only.
- **Memory** (2 files): `docs/memory/run-kit/ui/sidebar.md`, `docs/memory/run-kit/ui/status-signals.md`.
- **No API, type, backend, spec, or palette change.** `WindowInfo`/`PaneInfo` types are untouched; copy values (`paneId`, `hostName`, `version`) and their `Copy:` palette parity are untouched (Constitution V holds without new work). No settings, no stored state (Constitution IV).
- **Downstream**: change 1 rewrites `getTmxLabel`'s grammar and the same three consumers — it must branch from main after this merges (the plan's `0 → 1` sequencing).

## Open Questions

- None.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Ordinal = active pane's 1-based position in `win.panes` via `findIndex(isActive) + 1`, never `paneIndex + 1` | Plan § Decisions of record states it verbatim; root cause verified (`paneIndex` is tmux's raw `#{pane_index}`, host `pane-base-index 1`) | S:95 R:85 A:95 D:95 |
| 2 | Certain | `getTmxLabel` keeps today's `pane <ordinal>/<count>[ <paneId>]` grammar; the grammar switch is change 1 | Plan Change 0 non-goals + sequencing table; changing grammar here would collide with change 1's e2e rewrites | S:95 R:80 A:95 D:95 |
| 3 | Certain | No-panes window renders `pane 1/0` (ordinal falls back to 1); empty `paneId` omits the id suffix | Existing `status-bar.test.tsx` asserts `pane 1/0` for the paneId-less case; plan says "fallback: first pane"; Test Integrity keeps the encoded behaviour | S:80 R:90 A:95 D:90 |
| 4 | Certain | `getTmxLabel` lives in `sidebar/registers.ts` beside the register resolvers, with a header note that identity rows are not registers | Plan step 1 names the file and the reason (three sites share one string); mirrors the `getFabLine` extraction precedent | S:90 R:85 A:90 D:90 |
| 5 | Certain | Version becomes a sibling `<button>` with `shrink-0 hidden min-[700px]:inline`; host keeps `min-w-0 truncate`; overflow `version` row unchanged | Plan step 2 gives the exact classes; the documented ladder (`status-signals § Status Bar`) is the contract the DOM now honours | S:95 R:90 A:95 D:95 |
| 6 | Confident | Keep host + version paired inside a `flex items-center gap-1 min-w-0` wrapper (no `truncate`) rather than two loose `gap-3` cluster items; the literal-space separator goes | Verified the cluster is `gap-3` — loose siblings would visibly widen the fragment; the wrapper preserves today's read while letting the children carry the shrink rules; a pure markup choice, trivially reversible | S:75 R:95 A:85 D:75 |
| 7 | Certain | No e2e spec edit expected; `just test-e2e status-bar.spec` is run to confirm the four `pane 1/1 %1` assertions hold | Fixture is `paneIndex: 0`, one pane ⇒ ordinal 1 under both old and new arithmetic; plan step 3 says the same | S:90 R:95 A:95 D:95 |
| 8 | Certain | Memory edits limited to the two sentences named (sidebar § WindowPanel, status-signals § Status Bar right cluster), present-truth style, no index regeneration unless a description changes | Plan step 4 + § Memory hygiene; FKF present-truth rule | S:90 R:95 A:90 D:90 |
| 9 | Certain | Change type is `fix` (two bugs), pinned explicitly so `fab status refresh` cannot re-infer `docs`/`refactor` from the memory mentions | Plan calls Change 0 "(bugs)"; project memory records the re-inference hazard | S:85 R:95 A:95 D:95 |
| 10 | Certain | Light lane (single-spot edits in three files + tests) | Plan § Sequencing lane hint: "0 light" | S:85 R:95 A:90 D:90 |

10 assumptions (9 certain, 1 confident, 0 tentative, 0 unresolved).
