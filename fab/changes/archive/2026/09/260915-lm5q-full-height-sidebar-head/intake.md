# Intake: Full-Height Sidebar — the sidebar column owns the top-left band

**Change**: 260915-lm5q-full-height-sidebar-head
**Created**: 2026-09-16

## Origin

Conversational, then a live preview. The design study `docs/wiki/sidebar-material-studies.html` (§ C filmstrip, § F recommendation row 3) parked the "full-height sidebar" variant on 2026-09-15 as "a layout change, not a color change; revisit only if #2 lands and the empty left cell of the top bar bothers". On 2026-09-16, after PR #984 (chrome material with the flush stage seam: sidebar, top bar, status bar and the Shell stage ground all paint `--color-bg-chrome`; only content tiles float) merged, the user asked for a live preview of the full-height variant with one explicit requirement — **the top bar's 3px bottom border must read as one continuous line from the left edge to the right edge**. They previewed it on their watch rig, said "this is much better", and asked for the change and a PR.

**A working preview exists UNCOMMITTED in the working tree** — `git diff app/frontend/src/components/top-bar.tsx app/frontend/src/components/sidebar/index.tsx`. Apply MUST build on it (harden, name, test, document), not re-derive it. The working tree also carries the archive move of change `260915-zeid-chrome-material-surface` (folders under `fab/changes/archive/` + `fab/changes/archive/index.md`); it rides this change's ship commit untouched.

**Follow-on commits on PR #986 (2026-09-16, user-directed, outside the plan's tasks):** (1) the tile header and web tab strip paint the tile's `bg-bg-primary` surface instead of `bg-bg-card` so header, content and compose strip read as one well; (2) chrome tuning after Tokyo Night read washed out — `CHROME_L_DELTA` 0.06 → 0.045, `CHROME_CHROMA_KEEP` 0.35 → 0.6, and `textSecondary` floored at 4.5:1 against the chrome via the existing OKLab-L contrast nudge; (3) scrollbars reveal only while the pointer or focus is inside a vertical scroller, by toggling its overflow with `scrollbar-gutter: stable` so the 6px gutter stays reserved and the bar is created/destroyed (a real repaint) rather than tinted; the track is transparent; (4) the surface-toggle group is `dropLast` in the top bar's overflow fit — it keeps its leftmost slot but is the last fit candidate to overflow, since the sidebar head narrows the bar and the group was the first to go; (5) the head yields below 600px of remaining bar (`HEAD_MIN_BAR_PX`) and the breadcrumb nav drops its `sm:min-w-[150px]` floor while the head shows so the crumb collapse absorbs the squeeze — the head-inset bar had let the breadcrumb spill into the centered heading at 640–1024px (caught by `top-bar-overlap.spec`). Each is recorded in the memory it touches.

This intake was created by `/fab-proceed`'s promptless dispatch from the synthesized description below; every decision in it was taken in the conversation and is encoded as a Certain/Confident assumption. No question was asked.

> **Title:** Full-Height Sidebar — the sidebar column owns the top-left band
>
> **What the user sees.** At the top-left of the window the sidebar column has a head as tall as the top bar: the brand (logo + RunKit wordmark) on the left and the sidebar toggle at the right end, aligned over the sidebar. The top bar's own controls — history ◀ ▶, breadcrumb, center page heading, right cluster — start at the content column. The 3px bottom border runs unbroken under both the head and the bar. Below, the flat chrome sidebar continues straight down from the head; only the terminal tile floats.
>
> **Mechanism (decided — the "head in the bar").** The DOM is NOT restructured. `TopBar` renders, when `!isMobile && hasSidebar && sidebarOpen`, an absolutely positioned sidebar head over its left end, `width = sidebarWidth + STAGE_PADDING_PX + STAGE_COLUMN_GAP_PX` (6 + 6 — the content column's left edge in the Shell stage), containing the brand anchor and the sidebar toggle. The `<header>` becomes `relative` and gets inline `paddingLeft: inset + 12` so the 3-column grid lays out over the content column. The `border-b-[3px] border-border` stays on the full-width header — that IS the continuous line. When the inset is 0 (sidebar closed, mobile, or the Host page) the bar is exactly today's.
>
> **Rejected alternative.** Moving the sidebar out of Shell into the root grid as a real column spanning the top bar row — the literal macOS layout but a large refactor; since #984 made bar, head, stage ground and sidebar one material, painting the head over the bar's left end is visually identical.
>
> **Out of scope.** Moving the quake-terminal launcher chip; restructuring the root grid; mobile layout changes; any color/token change.

**Intake-time verification of the brief's pointers** (read, not guessed):

- `shell.tsx` lives at `app/frontend/src/components/shell/shell.tsx` (not `components/shell.tsx`). Its `stageStyle` (lines 260–271) is `columnGap: sidebarVisible ? "6px" : "0"`, `padding: "6px"`, grid columns `${sidebarWidth}px 1fr` when visible else `0 1fr`, with a 150ms ease-out transition on both. Its colocated test is `app/frontend/src/components/shell/shell.test.tsx`, which already asserts `stage().style.padding === "6px"` and `columnGap === "6px"` when open.
- The TopBar's `sidebarOpen` prop comes from the top-bar slot context (`app.tsx:691` — `sidebarOpen={slot?.sidebarOpen ?? false}`); `sidebarWidth` comes from `useChromeState()` (already imported in `top-bar.tsx`). Zen mode hides the WHOLE bar (`app.tsx:484` — `hideTopBar = zenActive && zenWindowParam !== undefined`), so a zen-hidden sidebar with the preference still `open` never draws a stray head.
- `SIDEBAR_MIN_WIDTH = 160`, `SIDEBAR_MAX_WIDTH = 400` (`contexts/chrome-context.tsx:29–30`). At the minimum the head is 172px wide with 148px of content room; brand (20px logo + 8px gap + ~42px wordmark) + 8px gap + 28px toggle ≈ 106px — it fits without truncation.
- The instance-accent wash is the `shrink-0 bg-bg-chrome` wrapper above the header in `app.tsx:517` (inline `backgroundColor: washHex`). The header is its child, so the head is washed with the rest of the bar — no change.
- The palette's sidebar toggle is the `sidebar-toggle` builtin (`lib/keybindings.ts:314` — `KeyB`, label "Toggle sidebar") composed in `hooks/use-global-palette-actions.ts`; Shell also registers `useSidebarKeyboardToggle` (Cmd+\ / Ctrl+\). Neither is touched.
- E2e selectors in play: `getByLabel("RunKit home")` (`top-bar-persistence.spec.ts:137`, Host + reload hops), `getByRole("link", { name: "RunKit home" })` (`tooltips.spec.ts:79` — Tabs to the brand on `/$server` at the DEFAULT DESKTOP viewport and expects a `role="tooltip"` reading "Host"), `getByRole("button", { name: "Toggle navigation" })` in a dozen specs (mostly mobile drawers; `pane-register-panel.spec.ts:143,374` and `status-bar.spec.ts:400` click it on desktop). Exactly one toggle renders at a time, so name queries stay unique.
- `chrome-material.spec.ts` probes `document.querySelector("header")`'s wrapper paint, not the header's children; the wrapper is unchanged.
- The existing memory Design Decision **"Hamburger statically rendered at TopBar.left"** (`docs/memory/run-kit/ui/top-bar.md:573`, introduced by `260509-17m3`) explicitly REJECTS state-conditional hamburger placement. This change supersedes it (the toggle is still rendered by `TopBar`, but conditionally in the head vs the cluster) — hydrate MUST amend that entry, not leave it contradicting the code.
- `docs/memory/run-kit/ui/sidebar.md` does not document the brand row at all today (no "brand" hit); `visual-design.md` § Design Decisions → "Chrome material over lifted card / recessed / full-height" lists full-height under Rejected — hydrate reconciles both.
- `docs/specs/surface-layout.md` and `docs/specs/gui.md` mention the top bar only as the home of the surface toggles / switch group (right cluster). Neither states a left-cluster contract — **no spec amendment is needed**.

## Why

1. **The pain point.** After #984 the sidebar, top bar and status bar share one gray material, but the top bar's left cell still belongs to the bar: hamburger, brand crumb and arrows sit above the sidebar column on the same gray, with a 6px stage padding between the bar's bottom border and the sidebar's top. The empty-looking left cell reads as a gap in the macOS "sidebar + toolbar" shape the material change was reaching for — exactly the case the study named for revisiting the parked variant. The user previewed the full-height variant live and judged it "much better".

2. **The consequence of not doing it.** The chrome reads as two stacked bands (bar over sidebar) rather than a window frame around the content well. Every later chrome refinement (status bar, quake launcher, host switcher) would keep inheriting a left cell that visually belongs to nothing.

3. **Why this approach.** The user's one hard requirement is the continuous 3px seam. Restructuring the root grid (sidebar as a real column spanning the bar row) is the literal layout but a large refactor: `Shell` owns the aside per route, `TopBar` is root-mounted above `Shell`, and the drag-resize handle, zen override and mobile drawer all hang off `Shell`'s stage. Because bar, head, stage ground and sidebar are ONE material since #984, painting a head over the bar's left end is visually identical to a real column — and it keeps the 3px border on a single element, which is the simplest possible proof of "one continuous line". The dependency runs the other way too: the head-in-bar contract only holds while those surfaces share `bg-bg-chrome`, so the component comment must state it.

## What Changes

### 1. `TopBar` — the `SidebarHead` (`app/frontend/src/components/top-bar.tsx`)

Extract the preview's inline block into a named component in `top-bar.tsx`:

```tsx
/** The sidebar column's head, painted OVER the top bar's left end. ... */
function SidebarHead({
  width,
  onToggleSidebar,
  hamburgerOpen,
  brandSweep,
}: {
  width: number;
  onToggleSidebar: () => void;
  hamburgerOpen: boolean;
  brandSweep: ReturnType<typeof useBrandLogoSweep>;
}) {
  return (
    <div className="absolute inset-y-0 left-0 flex items-center gap-2 pl-3 pr-3" style={{ width }}>
      <Tip label="Host">
        <a
          href="/"
          aria-label="RunKit home"
          className="rk-brand-glitch flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors"
          onMouseEnter={brandSweep.onMouseEnter}
        >
          <LogoSpinner size={20} loading={false} svgRef={brandSweep.svgRef} />
          <span className="text-xs font-bold tracking-wide">RunKit</span>
        </a>
      </Tip>
      <button
        onClick={onToggleSidebar}
        aria-label="Toggle navigation"
        className={`ml-auto ${controlClass({ variant: "icon", rest: "border-border hover:border-text-secondary text-text-primary" })}`}
      >
        <HamburgerIcon isOpen={hamburgerOpen} />
      </button>
    </div>
  );
}
```

- The `Tip label="Host"` wrapper is the one addition over the preview: the cluster's brand crumb carries it, and `tooltips.spec.ts` Tabs to the `RunKit home` link on `/$server` at the desktop viewport (where the head now owns that link) and asserts a tooltip reading "Host" (Assumption 7).
- `brandSweep` is the existing `useBrandLogoSweep()` instance already in `TopBar` (it drives the crumb's logo today); pass it down rather than calling the hook twice.
- The inset is computed in `TopBar`:

```tsx
const { sidebarWidth } = useChromeState();
// The head covers the stage's sidebar track plus the padding and gap that put
// the content column's left edge at sidebarWidth + STAGE_PADDING_PX + STAGE_COLUMN_GAP_PX.
const sidebarHeadWidth =
  !isMobile && hasSidebar && sidebarOpen ? sidebarWidth + STAGE_PADDING_PX + STAGE_COLUMN_GAP_PX : 0;
const headShown = sidebarHeadWidth > 0;
```

- The `<header>` becomes `relative` and, when `headShown`, takes inline `style={{ paddingLeft: sidebarHeadWidth + 12 }}` (12 = the `px-3` it otherwise carries, so the bar's grid starts 12px right of the content column's left edge, exactly as it started 12px right of the window edge before). When not shown: no inline style at all (`undefined`), so today's `px-3` is untouched. The `border-b-[3px] border-border` stays on the header and is never split.
- Remove the `PREVIEW` comments and the `previewSidebarWidth` name. Replace with contract comments only: what the head is (the sidebar column's head, painted over the bar's left end), why it paints over the bar rather than being a real grid column (the root grid stays; `TopBar` is root-mounted above `Shell`), the shared-material dependency (the illusion holds only while header wash, head, stage ground and sidebar all paint `bg-bg-chrome` — the flush stage from `visual-design.md` § Two-family chrome vocabulary), and the inset's lockstep with the stage geometry via the imported constants. No narration, no change IDs, no PR numbers.

### 2. Stage geometry constants (`app/frontend/src/components/shell/shell.tsx`)

Export the two numbers `stageStyle` uses, and use them in `stageStyle` itself so they cannot drift:

```ts
/** The stage ground's padding on every side; the content column's left edge
 *  is STAGE_PADDING_PX + sidebarWidth + STAGE_COLUMN_GAP_PX when the sidebar is open. */
export const STAGE_PADDING_PX = 6;
/** The gap between the sidebar track and the content column while the sidebar is open. */
export const STAGE_COLUMN_GAP_PX = 6;

const stageStyle: React.CSSProperties = {
  ...
  columnGap: sidebarVisible ? `${STAGE_COLUMN_GAP_PX}px` : "0",
  padding: `${STAGE_PADDING_PX}px`,
  ...
};
```

`top-bar.tsx` imports them from `@/components/shell/shell` (check the module's existing import path convention — `app.tsx` and `board-page` already import `Shell` from there). Also re-point the `p-[6px]`-style wording in `shell.tsx`'s header comment only where it would otherwise contradict the constants (the comment may keep saying "6px"; the code must not carry a second literal).

### 3. Left cluster + breadcrumb gating while the head shows (`top-bar.tsx`)

- **Hamburger**: `{hasSidebar && !headShown && <button …>}` — the cluster hamburger renders only when the head does not.
- **Brand root crumb**: the `hidden sm:contents` wrapper around the `Tip label="Host"` / `aria-label="RunKit home"` anchor renders only when `!headShown`. `aria-label="RunKit home"` therefore stays unique on desktop (e2e selects by label).
- **Leading separator**: the breadcrumb's leading `›` drops when the brand crumb is absent. The preview gated five `<BreadcrumbSeparator />` sites by hand; express it ONCE:

```ts
// The `›` before the first crumb belongs to the brand root crumb; with the
// brand in the sidebar head the nav's first crumb has nothing to its left.
const rootSeparator = !headShown;
// The session crumb follows the server crumb when there is one, else it is the first crumb.
const sessionSeparator = showServerCrumb || rootSeparator;
```

and use `rootSeparator` before the collapsed `… ▾` rung and before the server crumb (both branches), `sessionSeparator` before the session crumb (both the terminal-route branch and the second mode branch). Board mode's `BoardModeInfo` never had a leading `›` and is untouched.

- **History ◀ ▶ arrows** become the cluster's first element while the head shows — no code change, but the cluster comment that says "hamburger first" must be rewritten to the conditional.

### 4. Sidebar brand row (`app/frontend/src/components/sidebar/index.tsx`)

- Render site: `{isMobile && <SidebarBrand />}` (the preview's line). The head replaces it on desktop.
- Rewrite the render-site comment (currently: "On phones this is the brand's ONLY surface … on desktop it is a second, deliberate appearance beside the top-bar crumb") to the new contract: on phones the brand row is the brand's only surface and the sole pointer home affordance; on desktop the brand lives in the top bar's sidebar head, so the row is not rendered and the section rail is the sidebar's first row. Keep the note that its accessible name is the wordmark text, deliberately NOT `RunKit home`.
- Update `SidebarBrand`'s JSDoc ("see the render-site comment for the phone-vs-desktop role split") to match.

### 5. Keyboard reachability — verify, do not add

- The toggle is a real `<button>` in both positions (head and cluster); the head's brand anchor is a real `<a>`. Both are Tab stops.
- `Sidebar: Toggle` palette entry (`sidebar-toggle`, `KeyB`) and Shell's Cmd+\ chord are unchanged — assert they still exist, add nothing.
- Known trade-off, recorded not built: activating the head's toggle unmounts the head, so focus falls to `<body>` until the user Tabs again (today's static hamburger kept focus). The palette entry and the chords remain the keyboard path; a follow-up may focus the relocated toggle after a toggle-initiated relocation. Listed under Open Questions.

### 6. Tests

**Unit (Vitest — the gate is the full `just test-frontend`, not a scoped run):**

- `app/frontend/src/components/top-bar.test.tsx` (uses `renderTopBar({ sidebarOpen })` inside `ChromeProvider`; `stubMatchMedia` at line 136 is fine-pointer desktop — a mobile case stubs `max-width` / `pointer: coarse` as `sidebar/index.test.tsx`'s `makeMatchMedia(true)` does):
  - desktop + `sidebarOpen: true` (terminal mode): the head renders (a container holding the `RunKit home` link AND the `Toggle navigation` button), the left cluster has no hamburger, `nav[aria-label="Breadcrumb"]` contains no `RunKit home` link and its first rendered child is not a `›` separator, the header's inline `paddingLeft` equals `sidebarWidth + 24` pixels (default `sidebarWidth` from `ChromeProvider`; assert against the same value `useChromeState` reports).
  - `sidebarOpen: false`: hamburger is back as the cluster's first element, brand crumb is back as the nav's first child with its leading role, no head, `header.style.paddingLeft === ""`.
  - `mode: "host"`: no head even with `sidebarOpen: true`.
  - mobile (matchMedia stub) + `sidebarOpen: true`: no head.
  - separator gating: terminal route with server crumb → server crumb has no leading `›` while the head shows, session crumb still has one; server route (no server crumb) → session crumb has no leading `›` while the head shows.
  - Existing tests to re-check, not rewrite: "renders the hamburger as the first left-cluster element" (line 438, default `sidebarOpen=false` — unchanged), "renders the brand as the left-most root crumb" (420 — unchanged), "fills the sidebar-slot pictogram when the sidebar is open" (699 — queries by label; the head's toggle carries the same pictogram, so it passes as-is).
- `app/frontend/src/components/sidebar/index.test.tsx`: `SidebarBrand` (the `RunKit` wordmark anchor with `href="/"` at the nav's top) present with `makeMatchMedia(true)`, absent on the default desktop stub.
- `app/frontend/src/components/shell/shell.test.tsx`: `STAGE_PADDING_PX` / `STAGE_COLUMN_GAP_PX` equal the `stageStyle` padding / column-gap actually rendered (extend the existing `padding === "6px"` / `columnGap === "6px"` assertions to compare against the exported constants).

**Type check:** `cd app/frontend && npx tsc --noEmit`.

**E2e (single specs only — `just test-e2e <name>.spec`; never the full run from a dispatched worker):**

- Grep `app/frontend/tests/e2e/*.spec.ts` for `RunKit home`, `Toggle navigation`, `Toggle sidebar`, brand-crumb / hamburger position assumptions and update comments and assertions that state "brand crumb" or "hamburger first" on desktop. Expected touch points: `tooltips.spec.ts` (Tab-to-brand wording: the link is now the head's), `top-bar-persistence.spec.ts` (Host page — no head; the `/$server` hop's brand is now the head's link; behaviour identical), `pane-register-panel.spec.ts` (desktop toggle click — the button is in the head; same name).
- `just test-e2e chrome-material.spec` must still pass (the wrapper is still the chrome).
- Add one desktop case in a new `app/frontend/tests/e2e/full-height-sidebar.spec.ts` on the `chrome-material.spec.ts` mocked-backend idiom (state-socket mock, `/ws/terminals` stub, 1440×900, terminal route `/<server>/1`), with the constitution's file header and a Proves/Steps JSDoc: the head's bounding box lies within `x < sidebarWidth + 12` (read `sidebarWidth` from the `aside[aria-label="Sidebar"]` box), the `Toggle navigation` button inside the head sits left of the sidebar's right edge, the `header`'s computed `border-bottom-width` is `3px` and the header is ONE element spanning the full viewport width (the border is not split across two elements), and the breadcrumb nav's first child is not a separator.

### 7. Docs (hydrate)

- `docs/memory/run-kit/ui/top-bar.md`: § Left cluster / § Hamburger / § Brand root crumb — hamburger and brand crumb are conditional on the head (`!headShown`); add a `SidebarHead` subsection (what it is, the inset formula and its `shell.tsx` constants, the header's inline `paddingLeft`, the continuous `border-b-[3px]`, the shared-material dependency); amend Design Decision "Hamburger statically rendered at TopBar.left" (superseded: the toggle is still `TopBar`-rendered but lives in the head while the sidebar is open on desktop; record why the original concern — focus management — is accepted as a follow-up); add the Design Decision "Head painted over the bar, not a root-grid column" with the rejected root-grid restructure.
- `docs/memory/run-kit/ui/sidebar.md`: brand row is mobile-only; the desktop brand lives in the bar's head; the section rail is the first desktop row.
- `docs/memory/run-kit/ui/routes-and-shell.md` § Shell Grid Layout: the exported `STAGE_PADDING_PX` / `STAGE_COLUMN_GAP_PX`; the head painting over the bar's left end with the same numbers.
- `docs/memory/run-kit/ui/visual-design.md` § Two-family chrome vocabulary: the top band's left segment belongs to the sidebar column (the head), the 3px seam stays one continuous line on the header; § Design Decisions → "Chrome material over lifted card / recessed / full-height": full-height moves from Rejected to "deferred then built as a layout change once the material was shared".
- `docs/wiki/sidebar-material-studies.html` § F row 3: verdict `park` → built 2026-09-16 (reuse the existing `.tag.rec` class with text "built"), Why → "built as the head-in-bar mechanism: the head paints over the bar's left end; the bar's 3px bottom border stays one continuous line". Also the filmstrip label array (`['fullh','hair','Full-height sidebar','tag park','park']`, line ~399) → `built`.
- `docs/specs/index.md` Wiki row for Sidebar Material Studies: "full-height parked" → "full-height built (head-in-bar)".
- No `docs/specs/*.md` amendment (verified above).

## Affected Memory

- `run-kit/ui/top-bar`: (modify) left cluster hamburger + brand crumb conditional on the head; new `SidebarHead` subsection (inset formula, header `paddingLeft`, continuous 3px border, shared-material dependency); amend DD "Hamburger statically rendered at TopBar.left"; add DD "Head painted over the bar, not a root-grid column"
- `run-kit/ui/sidebar`: (modify) brand row (`SidebarBrand`) is mobile-only; desktop brand lives in the top bar's head; section rail is the first desktop row
- `run-kit/ui/routes-and-shell`: (modify) § Shell Grid Layout — exported `STAGE_PADDING_PX` / `STAGE_COLUMN_GAP_PX`, the head's lockstep with the stage geometry
- `run-kit/ui/visual-design`: (modify) § Two-family chrome vocabulary — the top band's left segment belongs to the sidebar column; the continuous seam; DD "Chrome material over lifted card / recessed / full-height" — full-height built, not rejected

## Impact

**Frontend source** (`app/frontend/src/`):
- `components/top-bar.tsx` — `SidebarHead` component, inset computation, header `relative` + inline `paddingLeft`, hamburger / brand crumb / separator gating, comment rewrites
- `components/shell/shell.tsx` — export `STAGE_PADDING_PX`, `STAGE_COLUMN_GAP_PX`; `stageStyle` uses them
- `components/sidebar/index.tsx` — `{isMobile && <SidebarBrand />}`, render-site + JSDoc comment rewrites

**Tests**: `components/top-bar.test.tsx`, `components/sidebar/index.test.tsx`, `components/shell/shell.test.tsx`; new `tests/e2e/full-height-sidebar.spec.ts`; touch-ups in `tests/e2e/tooltips.spec.ts`, `top-bar-persistence.spec.ts`, `pane-register-panel.spec.ts` as the grep dictates.

**Docs**: four memory files above, `docs/wiki/sidebar-material-studies.html`, `docs/specs/index.md`.

**Untouched**: backend, API, routes (Constitution IV), tokens/colors (#984 stays), palette registry, mobile layout, quake launcher, root grid, `app.tsx` wash wrapper. The archive move of `260915-zeid-chrome-material-surface` already in the working tree rides the ship commit unchanged.

**Scale**: ~3 source files, ~3 unit-test files, 1 new + ~3 touched e2e specs, 6 doc files.

## Open Questions

- Focus continuity after a toggle from the head: the head unmounts on close and the cluster hamburger mounts, so keyboard focus falls to `<body>`. Not built here (user: "verify, do not add"); a follow-up could focus the relocated toggle when the relocation was toggle-initiated.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Mechanism is the head-in-bar: `TopBar` renders an absolutely positioned `SidebarHead` over its left end; the DOM and root grid are not restructured | Discussed — user chose it after a live preview; the rejected root-grid column is recorded as a Design Decision | S:95 R:70 A:90 D:95 |
| 2 | Certain | The continuous 3px seam is the header's own `border-b-[3px] border-border`, never split; the head carries no bottom border | User's one explicit requirement; a single element is the simplest proof | S:100 R:90 A:95 D:100 |
| 3 | Certain | Head width = `sidebarWidth + STAGE_PADDING_PX + STAGE_COLUMN_GAP_PX`; header inline `paddingLeft = width + 12`; both constants exported from `components/shell/shell.tsx` and consumed by `stageStyle` | Verified against `stageStyle` (padding 6, column-gap 6); the 12 restores the `px-3` offset relative to the content edge | S:95 R:85 A:95 D:95 |
| 4 | Certain | Head shows iff `!isMobile && hasSidebar && sidebarOpen`; zen never draws a stray head because `app.tsx` hides the whole bar in zen | Verified `hideTopBar` at `app.tsx:484`; Host has no sidebar; mobile uses the drawer | S:90 R:85 A:95 D:90 |
| 5 | Certain | `SidebarBrand` renders on mobile only (`{isMobile && <SidebarBrand />}`); the section rail is the first desktop row | User decision; the preview already does it | S:95 R:90 A:95 D:95 |
| 6 | Certain | Leading-separator gating is expressed once (`rootSeparator = !headShown`; `sessionSeparator` = `showServerCrumb` or `rootSeparator`) and applied at the five sites | User asked for one expression over the preview's per-line conditions; exact names are the agent's | S:70 R:90 A:85 D:70 |
| 7 | Confident | The head's brand anchor is wrapped in the crumb's `Tip label="Host"` | Parity with the crumb it replaces; `tooltips.spec.ts` Tabs to `RunKit home` on `/$server` at desktop and asserts a "Host" tooltip — without the Tip that spec fails | S:55 R:90 A:85 D:80 |
| 8 | Confident | No focus management is added when the toggle relocates between head and cluster; palette entry + chords remain the keyboard path; recorded as an Open Question | User: "verify, do not add"; Constitution V reachability holds; the superseded DD's focus concern is acknowledged, not solved here | S:35 R:85 A:55 D:50 |
| 9 | Confident | No transition on the head (conditional mount, instant) while the stage column animates 150ms | The preview behaves this way and the user approved it live; a width transition on a mounting element has nothing to animate from | S:40 R:90 A:70 D:65 |
| 10 | Certain | The new e2e case lives in a new `tests/e2e/full-height-sidebar.spec.ts` on the `chrome-material.spec.ts` mocked-backend idiom at 1440×900 on the terminal route | User offered new spec or existing; the mocked idiom already provides desktop chrome + sidebar and needs no rig state | S:70 R:95 A:85 D:75 |
| 11 | Certain | The `SidebarBrand` mobile/desktop unit test goes in `sidebar/index.test.tsx` using its existing `makeMatchMedia(true)` helper | The helper already forces `useIsMobile()` true; colocated per code-quality | S:60 R:95 A:90 D:80 |
| 12 | Certain | Memory DD "Hamburger statically rendered at TopBar.left" is superseded and amended at hydrate (not deleted); a new DD records head-over-bar vs root-grid column | The existing DD rejects exactly what the user chose; leaving it would contradict the code | S:80 R:85 A:95 D:90 |
| 13 | Certain | Study § F row 3 and the filmstrip label flip `park` → built 2026-09-16 (reusing `.tag.rec`); `docs/specs/index.md` row says "full-height built (head-in-bar)"; no spec body changes | User asked for the study/index update; `surface-layout.md` / `gui.md` state no left-cluster contract (verified) | S:85 R:95 A:90 D:85 |
| 14 | Certain | The head fits at the sidebar's minimum width without truncation | `SIDEBAR_MIN_WIDTH = 160` → 148px content room vs ≈106px brand + gap + toggle | S:70 R:90 A:95 D:90 |
| 15 | Certain | Head geometry/classes follow the preview: `absolute inset-y-0 left-0 flex items-center gap-2 pl-3 pr-3`, `LogoSpinner size={20}`, wordmark `text-xs font-bold tracking-wide`, toggle `ml-auto` on the icon `controlClass` with the cluster hamburger's rest colors | The user approved these exact values live | S:75 R:95 A:80 D:80 |
| 16 | Certain | Existing top-bar tests at lines 420/438/699 keep passing (default `sidebarOpen=false`; the open case queries the toggle by label) — re-check, do not rewrite | Read the tests; the name `Toggle navigation` is unique in either position | S:60 R:95 A:85 D:85 |
| 17 | Certain | `change_type` is `feat`; the archive move already in the working tree rides the ship commit untouched | User-stated; a new user-visible layout capability | S:100 R:100 A:100 D:100 |

17 assumptions (14 certain, 3 confident, 0 tentative, 0 unresolved).
