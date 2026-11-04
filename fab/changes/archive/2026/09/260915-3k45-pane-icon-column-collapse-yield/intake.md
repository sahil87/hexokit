# Intake: PANE Panel Icon Column + Collapse Yields the Status Bar

**Change**: 260915-3k45-pane-icon-column-collapse-yield
**Created**: 2026-09-15

## Origin

Interactive `/fab-new` with a follow-up message mid-intake. Two user inputs:

> Fix an alignment bug in the sidebar PANE panel (components/sidebar/status-panel.tsx, WindowPanel/WindowContent): the register rows (tmx, cwd, git, out — each with a leading icon) don't have their icons vertically aligned into a clean column; icon indentation/spacing is inconsistent row to row. Screenshot for reference: /home/sahil/.uploads/260915080729-image.png. Note: this panel was recently touched by the pane-status-bar-density plan (Changes 0/1/3, PRs #974/#978/#979), so check whether this is a regression from that work or pre-existing.

> While you are at it, add one more change here: The collapse of the pane should have the same impact that removing the pane has on the status panel. Right now the status bar only shows stuff if the "PANE" itself is hidden from the left panel. Which makes sense but the same thing should happen even if the pane is collapsed not just hidden.

Investigation during intake (decisions the downstream agent inherits):

- **Item 1 is a regression from PR #978** (`1a876994`, change `260914-pnfe-register-value-diet`, "Basename-First cwd"). That PR switched the `cwd` row to `CopyableRow`'s new `flex` mode so the parent path and basename could carry separate shrink contracts. In a flex container the prefix span's trailing collapsible space in `` `${prefix} ` `` is trimmed, so the key renders as `cwd` (3 advances) instead of `cwd ` (4), and the icon sits one monospace advance left of the `tmx`/`git`/`out` icons. The screenshot confirms only the `cwd` row is off; the other rows (inline `truncate` mode, `{" "}` text nodes) are aligned. Before #978 the `cwd` row used the inline mode and was aligned. The very same flex pitfall is already documented and solved for `PrLinkRow` (NBSPs inside the prefix/icon spans, since 2026-07-03) and in `docs/memory/run-kit/ui/status-signals.md` § `PR` (L3) register.
- **Item 2's current rule** lives in `app/frontend/src/app.tsx` (~line 1381): `paneRegistersVisible = paneSectionVisible && sidebarOpen && !zenOn`, where `paneSectionVisible` is `useSidebarSectionVisible("pane")` (localStorage key `runkit-sidebar-section-pane`). The PANE panel's collapsed/expanded state is a *different* boolean: `CollapsiblePanel` in `status-panel.tsx` with `storageKey="runkit-panel-window"`, `defaultOpen={true}`, backed by the same `useLocalStorageBoolean` hook (in-module pub/sub across sibling subscribers). The yield rule never reads it, so a collapsed PANE header (section on, sidebar open) leaves the status bar's window cluster yielded with no register view on screen.

## Why

**Problem 1 — the icon column is broken on one row.** The PANE panel's register view is a monospace grid: a fixed 4-advance key column (`tmx `/`cwd `/`git `/`out `…, `pr` + 2×NBSP), a 2-advance icon cell, then the value column (`ContinuationLine` indents to `pl-[6ch]` on exactly this assumption). After #978 the `cwd` row's key is 3 advances wide, so its icon and value both sit one advance left of every other row. It reads as sloppy and it breaks the column the continuation-line indent is calibrated against. If left, every future flex-mode `CopyableRow` inherits the same defect.

**Problem 2 — a collapsed PANE panel leaves the registers homeless.** The register view has one desktop home at a time: while the PANE panel is on screen the status bar yields its window cluster (git/pr/fab/agt/tmx/cwd segments) to avoid a redundant copy 30px away. "On screen" is currently derived from the section toggle, the sidebar being open, and zen being off — but not from the panel's own collapse chevron. Collapsing the panel hides all of its content while the status bar still thinks the panel shows it, so the user sees *neither* surface. The user's expectation is exact: collapse must have the same effect on the status bar as hiding the section.

**Why these approaches.** Both fixes reuse existing idioms rather than adding mechanisms: item 1 adopts the NBSP-inside-the-span idiom `PrLinkRow` already uses for the same flex trimming; item 2 ANDs one more existing persisted boolean (the panel's own open state, same key, same pub/sub hook) into the yield rule — "no new state", the rule's own stated design. Rejected for item 1: `whitespace-pre` on the prefix span (works, but departs from the documented idiom and leaves a collapsible space that other containers would trim again). Rejected for item 2: lifting the panel's open state into `ChromeContext` or a new prop chain (the boolean already lives in a shared pub/sub store keyed by `runkit-panel-window`; subscribing by key is exactly how `paneSectionVisible` already works).

## What Changes

### 1. `CopyableRow` flex mode: the key→icon gap is an NBSP

File: `app/frontend/src/components/sidebar/status-panel.tsx`, `CopyableRow`.

Today:

```tsx
const prefixSpan = (
  <Tip label={tipLabel} placement="right">
    <span className={flex ? "text-text-secondary shrink-0" : "text-text-secondary"}>{copied ? "copied ✓ " : `${prefix} `}</span>
  </Tip>
);
```

After — in flex mode the gap character is ` ` (NBSP) so the flex container cannot trim it; inline mode is unchanged (a normal space inside inline text is not trimmed and the existing `{" "}` icon/value gaps stay as they are):

```tsx
// A flex container trims a flex item's trailing collapsible space, so the
// 4-advance key column must end in an NBSP there (the PrLinkRow contract);
// inline mode keeps the plain space.
const gap = flex ? " " : " ";
const prefixSpan = (
  <Tip label={tipLabel} placement="right">
    <span className={flex ? "text-text-secondary shrink-0" : "text-text-secondary"}>
      {copied ? `copied ✓${gap}` : `${prefix}${gap}`}
    </span>
  </Tip>
);
```

Both the at-rest key (`cwd` + NBSP = 4 advances) and the `copied ✓` feedback (9 advances, matching `PrLinkRow`'s `copied ✓`+NBSP) keep the icon in the column. The `cwd` row's and `PrLinkRow`'s icon→value NBSP moves out of the 14px icon span into a sibling NBSP text node (an NBSP-only text node survives flex whitespace dropping): inside the icon span it measured a 14px advance and left the value 2px right of the inline rows' 12px `{" "}` gap. The key fix lives in the shared component, so any future flex row is correct by construction.

Result: the four icons in the screenshot (`tmx` , `cwd` , `git` , `out` ⣾) share one x-coordinate, and the values share the next column.

### 2. A collapsed PANE panel hands the window cluster back to the status bar

**2a. Named constants for the panel's persisted open state** — `app/frontend/src/components/sidebar/status-panel.tsx`:

```ts
/** localStorage key + default of the PANE panel's collapsed/expanded state
 *  (CollapsiblePanel's `storageKey`). Exported because the status bar's yield
 *  rule subscribes to the same boolean — the panel is "on screen" only while
 *  expanded. */
export const PANE_PANEL_OPEN_STORAGE_KEY = "runkit-panel-window";
export const PANE_PANEL_DEFAULT_OPEN = true;
```

used by the existing mount:

```tsx
<CollapsiblePanel
  title="Pane"
  storageKey={PANE_PANEL_OPEN_STORAGE_KEY}
  defaultOpen={PANE_PANEL_DEFAULT_OPEN}
  …
```

The key string and default do not change, so persisted user state is untouched.

**2b. The yield rule gains the expanded term** — `app/frontend/src/app.tsx` (the block commented "The register view has ONE desktop home at a time", ~line 1374):

```ts
const [paneSectionVisible] = useSidebarSectionVisible("pane");
const [panePanelOpen] = useLocalStorageBoolean(PANE_PANEL_OPEN_STORAGE_KEY, PANE_PANEL_DEFAULT_OPEN);
const paneRegistersVisible = paneSectionVisible && panePanelOpen && sidebarOpen && !zenOn;
```

`useLocalStorageBoolean` (`hooks/use-local-storage-boolean.ts`) notifies every subscriber of the same key from its setter, so clicking the PANE header chevron flips `panePanelOpen` in `app.tsx` synchronously — the same live pub/sub the rail toggle already rides. Update the block comment to name all four terms (section on, panel expanded, sidebar open, zen off). The `StatusBar` mount (`window={paneRegistersVisible ? null : currentWindow ?? null}`) is unchanged.

Behavior matrix (desktop, terminal route, zen off, sidebar open):

| PANE section | PANE panel | Status bar window cluster |
|---|---|---|
| off | — (unmounted) | shown (unchanged) |
| on | expanded | yielded (unchanged) |
| on | **collapsed** | **shown (new)** |

Mobile is untouched: the status bar never renders there. The `fold`/priority logic inside `StatusBar` is untouched — the cluster simply receives a window again.

### 3. Tests

- **Unit — `status-panel.test.tsx`**: pin the flex-mode prefix codepoints: the `cwd` button's prefix span text is exactly `"cwd "` (and `"copied ✓ "` after a click), and a non-flex row (`tmx`) keeps `"tmx "`. Same pinning idiom the flyout card uses for its `pr` NBSP prefixes.
- **Unit — `app.test.tsx`** § "status bar window cluster yields to an on-screen PANE panel": add "keeps the window cluster when the PANE section is on but the panel is collapsed" — seed `runkit-sidebar-section-pane = "true"` and `runkit-panel-window = "false"`, expect `status-bar-window` present; and a live-flip case if the existing cases toggle via UI (collapse → cluster appears, expand → cluster yields).
- **E2E — `tests/e2e/pane-register-panel.spec.ts`** (desktop): (a) icon column — the `tmx`, `cwd`, `git`, `out` icon spans' `boundingBox().x` are equal (±0.5px) and so are their value spans'; (b) in the existing "PANE-on yields the status bar's window cluster" describe, a test that clicks the PANE header toggle to collapse → `status-bar-window` becomes visible; click again → it detaches. Each `test()` carries the Proves/Steps JSDoc the constitution requires. Run as single specs (`just test-e2e pane-register-panel.spec`).

## Affected Memory

- `run-kit/ui/status-signals`: (modify) § Pane panel five-register view — the 4-advance key column rule now states that a flex-mode `CopyableRow` ends its key (and `copied ✓`) with an NBSP, like `PrLinkRow`, because flex trims a trailing collapsible space; § Status Bar left cluster and the Design Decision "PANE-on yields the bar's window cluster" — the yield rule gains the fourth term (panel expanded, `runkit-panel-window` via `useLocalStorageBoolean`), and the "THREE surfaces" paragraph's "(section on, sidebar open, zen off)" becomes four conditions.
- `run-kit/ui/sidebar`: (modify) § WindowPanel — the storage key/default are the exported `PANE_PANEL_OPEN_STORAGE_KEY` / `PANE_PANEL_DEFAULT_OPEN`, consumed by both the panel and the status-bar yield rule.

## Impact

- `app/frontend/src/components/sidebar/status-panel.tsx` — `CopyableRow` prefix gap (flex mode); two exported constants; the `CollapsiblePanel` mount reads them.
- `app/frontend/src/app.tsx` — one extra `useLocalStorageBoolean` subscription and one extra term in `paneRegistersVisible`; comment update.
- `app/frontend/src/components/sidebar/status-panel.test.tsx`, `app/frontend/src/app.test.tsx`, `app/frontend/tests/e2e/pane-register-panel.spec.ts` — new cases.
- No backend, API, storage-key, or palette changes. No change to `StatusBar`, `CollapsiblePanel`, `useLocalStorageBoolean`, or `registers.ts`.
- Gates: `just test-frontend` (full Vitest, not scoped), `just test-e2e pane-register-panel.spec`, `tsc --noEmit` via the build.

## Open Questions

- none

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Item 1's root cause is the flex-mode `CopyableRow` prefix's trailing space being trimmed; it is a regression from PR #978, not pre-existing | Verified: `git log -S` places the `flex` prefix span in `1a876994` (#978); before it the cwd row used inline mode; the screenshot shows only the cwd row off; `PrLinkRow` documents the identical flex pitfall | S:90 R:90 A:95 D:95 |
| 2 | Certain | Fix item 1 with an NBSP gap inside the prefix span in flex mode (the `PrLinkRow` idiom), not `whitespace-pre` | Memory § `PR` (L3) register documents NBSP-inside-the-span as the flex-row contract; the fix lives in the shared component so future flex rows are correct by construction | S:70 R:90 A:85 D:75 |
| 3 | Certain | Item 2 = AND the panel's own persisted open boolean (`runkit-panel-window`, default true) into `paneRegistersVisible`; no new state or prop chain | The rule's own comment says "no new state"; `useLocalStorageBoolean` already gives live cross-subscriber pub/sub by key, exactly how `paneSectionVisible` works | S:80 R:90 A:90 D:85 |
| 4 | Certain | Export the key/default as named constants from `status-panel.tsx` and consume them in both the panel mount and `app.tsx` | code-quality.md forbids magic strings; the key string itself does not change so persisted state is preserved | S:60 R:95 A:85 D:80 |
| 5 | Confident | Tests: unit codepoint pin (status-panel.test), unit yield case (app.test), plus two desktop e2e cases in pane-register-panel.spec (icon x-alignment; collapse ↔ cluster) | code-quality.md requires tests for fixes and prefers e2e for UI; the spec file already hosts the yield tests; exact e2e assertions left to apply | S:65 R:90 A:80 D:70 |
| 6 | Confident | Both items ship as one change | User: "add one more change here"; same panel, same memory file, both small | S:75 R:70 A:70 D:80 |
| 7 | Certain | Mobile behavior is untouched | The status bar is desktop-only (Shell renders it never on mobile); the collapse chevron on mobile changes nothing else | S:70 R:95 A:90 D:90 |

7 assumptions (5 certain, 2 confident, 0 tentative, 0 unresolved).
