# Intake: Web tab strip redesign — folder tabs, width ladder, kind chip, URL-row diet

**Change**: 261026-akdh-web-tab-strip-redesign
**Created**: 2026-10-26

## Origin

Conversational design discussion started from a user screenshot of the web tile (a `rk present` family of four pages in the browser-like `web` surface). The discussion produced a self-contained HTML design study, `docs/wiki/web-tab-strip-studies.html` (already written, currently untracked in the worktree, and part of this change), and the user chose among its variants. This intake was created by a promptless dispatch (`{questioning-mode} = promptless-defer`): no questions were asked, and every decision that would have been a question is recorded below as a deferred Unresolved row.

Synthesized description handed to intake:

> **Web tab strip redesign — folder tabs, width ladder, kind chip, URL-row diet.** The web tile's tab strip needs serious design work. Ship variant B (fixed strip, three rows: tile header · tab strip · URL row) from `docs/wiki/web-tab-strip-studies.html` as one fab change: a "folder" active-tab treatment, a tab-width ladder (200 max · even shrink · active floor 110 · icon-only 34 under 72 · scroll last), the kind badge moved into the address field as a leading chip with neutral page-glyph tab icons, and a URL-row diet (11.5px unbordered address, zoom + Inspect behind a `⋯` overflow menu, a zoom chip only when zoom ≠ 100%). The tile header drops its web kind badge. Variant C (tabs merged into the tile header) is rejected.

User's decision, verbatim: *"Option B - fixed strip design looks good. So no need of the merged header."*

**Design authority**: `docs/wiki/web-tab-strip-studies.html` (§1 annotated today, §2 live mock A/B/C with folder/underbar/well treatments, §3 width ladder, §4 kind signalling, §5 URL row, §6 mobile, §7 parked merge constraints, §8 recommendation table). Where this intake and the study disagree, this intake wins — specifically: the study's §5 bullet moving the `keys → page` capture chip into the URL row applied only to rejected variant C (the chip STAYS in the header). The study's `sizeTabs` mock is authoritative for the width ladder, including the icon-only rung (Assumption 5).

## Why

Six problems, each verified against code:

1. **The active tab is indistinguishable.** `app/frontend/src/components/iframe-window.tsx` (strip ~L980–1186) gives the active tab `bg-bg-primary` — the same colour as the strip's own `bg-bg-primary` background. Only `text-text-primary` vs `text-text-secondary` and the always-visible `×` mark selection.
2. **Kind dots are noise.** A family of `rk present` pages (which rarely ship favicons, so the dot fallback is the common case) shows identical green dots (`KIND_DOT_CLASS`, iframe-window.tsx ~L1542) on every tab.
3. **Tab width is unbounded.** Labels are `<span className="whitespace-nowrap">` with no max width; one long `<title>` eats a third of the strip, and a full family (cap 16, `WEB_TAB_FAMILY_CAP`) scrolls instead of shrinking.
4. **Type hierarchy is inverted.** The address input is `text-sm` (14px) in a bordered `h-[28px]` field (`bg-bg-card … border border-border`, ~L1259) while the tabs that choose what it shows are `text-[11px]`.
5. **Controls are scattered.** The 35px URL row carries zoom as four slots (`−` · `100%` · `+`, `data-testid="web-zoom-control"`, ~L1285) plus Inspect (`supports.devtools` only) for rarely-used controls.
6. **The tile header duplicates the active tab.** `app/frontend/src/components/surface-layout.tsx` builds `webBadge` (~L3205–3237) and renders `data-testid="web-kind-badge"` + the page title (~L3384–3395) — the active tab's kind and title again, one row up.

If not fixed, the web tile keeps reading as an unfinished browser: the user cannot tell which tab the URL row belongs to, large families degrade into a scrolling strip, and the chrome spends its pixels on the wrong controls.

**Why this approach**: the study compared three layouts and three active-tab treatments live. Variant B keeps the three-row structure, so none of the header-merge costs listed in study §7 (drag-to-snap grip reservation, Tip placement against the native guest rect, home-chip relocation) apply. The **folder** treatment is the only one that answers "which tab does the URL row belong to?" without a legend — the active tab and the URL row share one raised surface and the rule under the tab is broken. **Underbar** was rejected because a green bar is already this app's focus/latch signal (focused-tile frame, toggle latches), so a selected tab in an unfocused tile would borrow focus semantics. **Well** was rejected because it reads as a pressed toggle and carries the light-theme ΔL problem recorded in `docs/wiki/toggle-depth-studies.html`. **Variant C** (merge tabs into the tile header) was rejected by the user: with the folder treatment and ladder in place, saving one row isn't worth the grip/Tip/home-chip work.

## What Changes

### 1. Strip row — inset ground + folder active tab (`iframe-window.tsx`)

- The `role="tablist"` strip (`data-testid="web-tab-strip"`) sits on an **inset ground**: `bg-bg-inset`, ~30px tall, ~4px top padding (tabs ~26px tall, bottom-aligned), keeping its `border-b border-border` bottom rule. Study CSS reference (`.strip1`): `height: 30px; padding: 4px 4px 0; background: var(--bg-inset); border-bottom: 1px solid var(--border);`.
- **Active tab = folder**: a raised surface shared with the URL row directly below it, 6px rounded top corners, a 1px dimmed card-border on top/left/right (the `.rk-card-border` 55% mix of `--color-border`, `globals.css` ~L2594), **no bottom border**, `margin-bottom: -1px` so it overlaps the strip's bottom rule and visibly joins the URL row, stacked above siblings (`z-index`). Study CSS (`.t-folder .tab.on`): `background: var(--bg-raise); color: var(--text-primary); border: 1px solid var(--card-border); border-bottom: none; border-radius: 6px 6px 0 0; z-index: 2;` plus `.t-folder .strip1 .tab.on { margin-bottom: -1px; }`.
- **Raised surface token**: the mock's `--bg-raise` maps to the existing **`bg-bg-card`** token (light mock `--bg-raise: #ffffff` = `--color-bg-card: #ffffff`; dark mock `#1b202b` ≈ `--color-bg-card: #171b24`, on inset `#0a0c12`). No new theme token unless per-theme verification fails (Assumption 3). The URL row's background becomes the same token so tab and row read as one surface.
- **Inactive tabs**: `text-text-secondary`, no fill, `hover:text-text-primary`; **hairline separators** between adjacent inactive tabs, hidden on either side of the active tab.
- Drop the old `gap-px` + active `bg-bg-primary` styling. The trailing `+` (`data-testid="web-tab-add"`), its disabled `web tabs full (16)` Tip, and double-click-on-empty-strip → draft are unchanged.

### 2. Width ladder — a pure, unit-tested sizing function

New pure module (suggested `app/frontend/src/lib/web-tab-ladder.ts`, colocated `web-tab-ladder.test.ts`, the `web-url.ts`/`web-zoom.ts` DOM-free module shape) with named constants (no magic numbers):

```ts
export const WEB_TAB_MAX_W = 200;          // even-share ceiling
export const WEB_TAB_ACTIVE_FLOOR_W = 110; // active tab never shrinks below this
export const WEB_TAB_ICON_THRESHOLD_W = 72; // an inactive share below this goes icon-only
export const WEB_TAB_ICON_W = 34;          // icon-only tab floor (icon-only tabs take their share width)

export function sizeWebTabs(
  count: number,          // declared tabs + drafts, in strip order
  available: number,      // measured strip width minus padding and the `+` button
  activeIndex: number,    // 0-based index of the selected entry (active tab or selected draft)
): { widths: number[]; iconOnly: boolean[]; scroll: boolean };
```

Rules (agreed values):
1. Share `w = available / count`. If `w >= 200` → every tab 200px (spare strip space stays empty — still the double-click → draft target).
2. Else if `w >= 110` → every tab `floor(w)` (even shrink, active included).
3. Else the **active tab keeps 110px**; inactive share `s = (available − 110) / (count − 1)`. If `s >= 72` → each inactive tab `floor(s)` with its label.
4. If `s < 72` → inactive tabs go **icon-only at their share width `max(floor(s), 34)`** — the study's `sizeTabs` rung (Assumption 5): 34px is the floor, not a fixed width, so the strip never leaves an empty run while tabs are icon-only.
5. The strip **scrolls only when** `110 + 34·(count − 1) > available`, with a **fade mask on the trailing edge** (CSS `mask-image` linear gradient) while scrolled content overflows.

Reference implementation from the study (`sizeTabs` — authoritative for every rung, including icon-only at the share width):

```js
function sizeTabs(n, avail, ai) {
  const MAX = 200, ACT = 110, ICONW = 34;
  if (n === 0) return { ws: [], scroll: false };
  const w = avail / n;
  if (w >= MAX) return { ws: Array(n).fill(MAX), scroll: false };
  if (w >= ACT) return { ws: Array(n).fill(Math.floor(w)), scroll: false };
  const rest = n > 1 ? (avail - ACT) / (n - 1) : 0;
  const o = Math.max(Math.floor(rest), ICONW);
  return { ws: Array.from({ length: n }, (_, i) => (i === ai ? ACT : o)), scroll: ACT + o * (n - 1) > avail };
}
```

Worked examples (agreed reading): 4 tabs @ 760px → 4×190; 8 @ 760 → 8×95; 9 @ 760 → active 110 + 8×81 labelled; 12 @ 760 → active 110 + 11×59 icon-only (share width, strip filled); 16 @ 400 → 110 + 15×34 = 620 > 400 → scroll + fade.

Wiring: `IframeWindow` measures the strip with a `ResizeObserver` (no polling), feeds `sizeWebTabs`, and applies the widths inline. Labels truncate with ellipsis (`min-w-0 truncate` on the label span) — `whitespace-nowrap` without a bound is removed. When the strip scrolls, the selected tab is scrolled into view on selection.

Close affordance under the ladder: the active tab always shows `×`; inactive labelled tabs keep today's rule (hover/focus-within reveal on fine pointers, always on coarse); **inactive tabs under 72px (icon-only) hide `×` even on coarse pointers** — middle-click (`auxclick` button 1) and the roving-focus Delete/Backspace still close them. Icon-only tabs keep their label in the DOM visually hidden so the `role="tab"` accessible name survives (Assumption 25).

**Drafts participate in the ladder** (counted in `count`, in strip order after declared tabs). A selected draft is the ladder's active entry (110 floor) and takes the folder surface while **keeping its dashed treatment** (dashed top/left/right border in place of the solid card border — study `.tab.draft { border: 1px dashed var(--border); border-bottom: none; }`). `data-testid="web-tab-draft"` / `web-tab-draft-close` unchanged.

### 3. Kind signalling — address chip + neutral tab glyph

- **Address field leading chip**: the kind badge moves from the tile header to the address field's leading edge, like a browser's site-identity chip. Same text and classes the header badge uses today:
  - `present` → `text-accent-green border-accent-green/40 bg-accent-green/10`, text `present`
  - `proxy` → `text-signal-yellow border-signal-yellow/40 bg-signal-yellow/10`, text `:${proxyPortOf(url) ?? "?"} proxy`
  - `external` → `text-signal-blue border-signal-blue/40 bg-signal-blue/10`, text `external`
  - `relative` → no chip
  
  Chip shape: `shrink-0 rounded border px-1.5 text-[10px]` (today's header badge). Extract the derivation (`classifyAddress` + `proxyPortOf` → `{ text, cls } | null`) into one shared helper (e.g. beside `classifyAddress` in `lib/web-url.ts`) instead of duplicating it — the header no longer needs it after § 4.
- **Tab icon ladder** (per tab): loading spinner (`data-testid="web-tab-spinner"`, unchanged) → favicon (unchanged sources and `failedFavicons` fallback) → otherwise a **neutral page glyph** (`text-text-secondary`), **hued by kind only when the declared family mixes kinds** (more than one distinct `classifyAddress` kind among the declared tabs) — using the same hues (`text-accent-green` / `text-signal-yellow` / `text-signal-blue`). The `KIND_DOT_CLASS` dot is retired. Four present pages read as four documents; a proxy tab among them stands out. Study CSS: `.pageic { color: var(--text-secondary); } .pageic.present { color: var(--accent-green); } .pageic.proxy { color: var(--signal-yellow); } .pageic.external { color: var(--signal-blue); }`, glyph 13×13.
- The page glyph is a new register glyph in `app/frontend/src/components/top-bar-icons.tsx` (the register `FindGlyph`/`InspectGlyph`/`WebBackGlyph` live in), with a `data-icon`.

### 4. Tile header (`surface-layout.tsx`)

- Remove the web kind badge (`webBadge`, `data-testid="web-kind-badge"`) — the address chip carries it.
- Keep: the `://` surface glyph (green when focused), the page title (`webPageTitles.get(tileWinId) ?? meta` fallback), the foreign-tile home chip, and the `keys → page` capture chip (`data-testid="web-capture-chip"`) — the capture chip stays in the header (the study's move-to-URL-row bullet was variant-C-only).
- The onboarding `://  Web` header (empty/whitespace active web tab) is unchanged.
- With the badge gone, every content-bearing web tile renders the title branch (title + meta fallback) — including `relative`-kind addresses, which today fall into the label + meta-chip branch because `webBadge` is null for them.
  <!-- assumed: relative-kind web header uses the title branch — the badge no longer gates the branch; alternative is keeping relative on the label branch -->
- Update `surface-layout.test.tsx` § "web tile header badge + title" (asserts `web-kind-badge` at ~L443/456/468): the badge assertions move to `IframeWindow`'s chip tests; the title/meta-fallback assertions stay.

### 5. URL row diet (`iframe-window.tsx`, ~L1189–1338)

- Row: ~33px, background = the folder raised surface (`bg-bg-card`), `border-b` card-border; buttons keep the `w-7 h-7 rounded` vocabulary (study `.url1`: `height: 33px; gap: 2px; padding: 0 6px;`).
- **Order: `◀ ▶ ↻ [address] ⌕ ↗ ⋯`** — back/forward still render iff `supports.history`; Find and Open-in-browser unchanged in behavior.
- **Address field**: ~11.5px text (matching the tabs), **unbordered inset field ~24px tall** (`bg-bg-inset`, transparent border, rounded 4px), keeping the existing `INPUT_FOCUS` focus-ring style. The field is a wrapper holding `[kind chip][input]`; the input keeps `aria-label="URL"`, the display/edit split, the submit ladder, drafts' placeholder, and the inline `role="alert"` submit-error slot. Study CSS (`.addr1`): `height: 24px; margin: 0 4px; gap: 6px; padding: 0 3px; background: var(--bg-inset); border: 1px solid transparent; border-radius: 4px; font-size: 11.5px;`.
- **Zoom chip**: appears beside the address (after the field, before `⌕`, per the mock) **only when zoom ≠ 100%**, reading e.g. `125%`; clicking it resets zoom (`applyZoom("reset")`). Study CSS (`.zchip`): `font-size: 10px; padding: 0 5px; border-radius: 3px; background: var(--bg-card); border: 1px solid var(--border);`.
- **`⋯` overflow menu**: Zoom (`−` `%` `+`) and Inspect move behind `⋯`. Their palette rows (`Web: Zoom in` / `Web: Zoom out` / `Web: Reset zoom` / `Web: Inspect page`) stay registered unchanged (Constitution V); the `⋯` button and its rows are keyboard reachable (focus moves into the menu on open, ↑/↓ rove, Enter/Space activate, Escape/Tab close and return focus to `⋯` — the `GuiToolbarMenu` idiom in `components/gui-toolbar-menu.tsx`). The menu is a click-opened overlay and therefore registers `useOccludes("transient", open)` (overlay-presence rule) — see Assumption 17 for the native-engine consequence. Menu contents (study mock): a **Zoom row** with an inline `−  125%  +` stepper that keeps the menu open while stepping, and an **Inspect page** row rendered only when `supports.devtools`. The zoom stepper keeps `data-testid="web-zoom-control"` and the `Zoom out` / `Reset zoom` / `Zoom in` aria-labels.
- `⋯` is not rendered in the onboarding state (the reduced URL bar stays refresh + address only, as today).
- New register glyph for `⋯` in `top-bar-icons.tsx` if none fits.
- All Tips in the strip and URL row keep `placement="top"` (native guest clipping rule — unaffected because there is no header merge).

### 6. Mobile

Mobile renders no tile header (`!mobile` gates in `surface-layout.tsx`), and `IframeWindow` has no mobile branch today (verified: no `mobile`/`isMobileViewport` reference in `iframe-window.tsx`), so today's mobile URL row equals desktop's — the study's "approximate" today-frame is accurate. Changes:
- The strip gets the same folder treatment and width ladder.
- The URL row keeps `↻ [address] ⋯`; **back, forward, find and open-in-browser move into `⋯`** (mobile menu rows: Back · Forward · Find in page · Open in browser · Zoom stepper · Inspect page when supported). `IframeWindow` receives a `mobile` prop from `SurfaceLayout` (which already owns the `mobile` decision).
- Coarse-pointer `×` rules per § 2.

### 7. Preserve (full contract: `docs/memory/run-kit/ui/lenses-and-layout.md` § Web Tile → Web tab strip)

Roving-focus tablist semantics and keys (←/→/Home/End move focus, Enter/Space select, Delete/Backspace close, component-local ⌥⇧←/⌥⇧→ move); pointer-drag reorder with the 6px threshold and the green drop-side indicator (`web-tab-drop-indicator`); middle-click close; drafts (dashed, multiple, Enter materializes, Esc discards, blank `web-draft-panel`); the 16-tab cap and `+` disabled Tip; double-click empty strip space → draft; per-tab engines mounted eagerly and never re-`src`d (`key={`${engineKind}:${tabUrl}`}`); both engines — the native guest's bounds follow the placeholder rect, so the strip/URL-row height changes (~30px + ~33px vs today's ~27px + 35px) move it and must re-measure correctly; the document CustomEvents; and every e2e `data-testid` (`web-tab-strip`, `web-tab`, `web-tab-close`, `web-tab-add`, `web-tab-draft`, `web-tab-draft-close`, `web-tab-spinner`, `web-tab-drop-indicator`, `web-zoom-control`, `web-zoom-frame-wrapper`, `web-draft-panel`, `web-tile-onboarding`, `web-find-bar`, `web-capture-chip`, …).

### 8. Docs

- Commit `docs/wiki/web-tab-strip-studies.html` (currently untracked).
- Add a row to the `## Wiki` table in `docs/specs/index.md`, following the existing rows' style (title link `../wiki/web-tab-strip-studies.html`, description naming the discussion date 261026, the sections, the decision — variant B + folder, variant C rejected — and "Self-contained; open in a browser"). Suggested title: `Web Tab Strip Studies`.

### 9. Tests and evidence

- **Unit**: `web-tab-ladder.test.ts` covering every rung (≥200, even shrink, active floor, labelled inactive ≥72, icon-only <72, scroll threshold, count 0/1, draft as active index). `iframe-window` unit tests for the address chip per kind (incl. relative → none), neutral vs hued glyph (uniform vs mixed family), the `⋯` menu contents (desktop vs mobile, Inspect only with `supports.devtools`), zoom chip only at ≠100% and click-reset. `surface-layout.test.tsx` updated per § 4.
- **Playwright** (each touched `test()` keeps/updates its Constitution § Test Intent Comments JSDoc; file headers updated): `web-tabs.spec.ts` (strip, folder active tab, ladder shrink/icon-only/scroll, × rules), `web-tile-chrome.spec.ts` (URL row order, address chip, back/forward), `web-tile-zoom.spec.ts` (zoom now opened through `⋯`; zoom chip appears ≠100% and resets; onboarding has no `⋯`/zoom control; palette stepping unchanged), plus any spec asserting the header `web-kind-badge` (only `surface-layout.test.tsx` references it today) and `web-view-lens.spec.ts`'s onboarding URL-row assertions (still valid; verify). `app/desktop/tests/e2e/web-native.spec.ts` if it touches the URL row.
- **PR evidence** (Constitution § PR Evidence): `just demo` before/after recordings on **desktop and mobile** web viewports (a new `app/frontend/tests/demo/<name>.demo.ts`), and a **shell recording** (Assumption 22) via a spec under `app/desktop/tests/demo/` (e.g. alongside `web-tile-native.demo.ts`). Verification on a throwaway rig via `just` recipes only.

## Affected Memory

- `run-kit/ui/lenses-and-layout`: (modify) § Web Tile — Layout (strip/URL-row heights), Web tab strip (inset ground, folder active tab, width ladder, icon ladder, × rules, drafts in the ladder), URL Bar (new order, unbordered 11.5px address, kind chip, zoom chip, `⋯` menu, mobile `↻ [address] ⋯`), Content zoom § Triggers (the control now lives in `⋯`; zoom chip as reset), per-engine parity table's devtools row (Inspect is a `⋯` row), Keyboard capture (chip stays in header — unchanged, verify wording); § Surface Layout → Tile renderer / Design Decisions → "Page title crosses the component seam via a callback, kind stays derived" (header no longer shows the kind badge); new Design Decisions for folder treatment, the width ladder, kind-in-address-chip, and the `⋯` diet.
- `run-kit/ui/keyboard-and-palette`: (modify) `Web: Inspect page` entry wording — "the palette is the keyboard path for the URL bar's `Inspect page` button" becomes the `⋯` menu row; zoom palette rows' description of the URL-bar control.
- `run-kit/ui/top-bar`: (modify) glyph register gains the web page glyph and the `⋯` glyph (only if new glyphs are added).

## Impact

- **Frontend source**: `app/frontend/src/components/iframe-window.tsx` (strip, URL row, new menu, `mobile` prop), `app/frontend/src/components/surface-layout.tsx` (header badge removal, pass `mobile` to `IframeWindow`), new `app/frontend/src/lib/web-tab-ladder.ts`, `app/frontend/src/lib/web-url.ts` (shared kind-chip helper), `app/frontend/src/components/top-bar-icons.tsx` (glyphs), `app/frontend/src/globals.css` (folder/separator/fade-mask utilities if not expressible in Tailwind), possibly a generalized menu primitive derived from `components/gui-toolbar-menu.tsx`. `app/frontend/src/lib/palette/web-tabs.ts` — no behavior change expected (palette tab verbs are unaffected); listed as a source file to confirm.
- **Engines**: no engine-contract change; the native guest's bounds track the placeholder rect, which moves with the chrome's new heights. The `⋯` menu's `transient` occlusion hides the native guest while open (desktop shell only).
- **Tests**: unit tests above; Playwright `web-tabs`, `web-tile-chrome`, `web-tile-zoom`, possibly `web-view-lens`; desktop `web-native` if affected.
- **Docs**: `docs/wiki/web-tab-strip-studies.html` (new), `docs/specs/index.md` (Wiki row).
- No backend, API, tmux-option, or CLI change. Constitution IV (no new pages) and V (palette parity) satisfied.

## Open Questions

- Does `bg-bg-card` on `bg-bg-inset` give a visible folder surface across all derived themes (light themes especially, per the Toggle Depth study's ΔL finding), or is a derived `--color-bg-raise` needed?

## Clarifications

### Session 2026-10-27 (bulk confirm)

| # | Action | Detail |
|---|--------|--------|
| 3 | Confirmed | — |
| 7 | Confirmed | — |
| 9 | Confirmed | — |
| 11 | Confirmed | — |
| 13 | Confirmed | User chose: show page title |
| 16 | Confirmed | — |
| 17 | Confirmed | — |
| 19 | Confirmed | — |
| 22 | Confirmed | — |
| 24 | Confirmed | — |
| 25 | Confirmed | — |
| 26 | Confirmed | — |

## Assumptions

<!-- STATE TRANSFER: This table is the sole continuity mechanism between the intake-stage
     agent and the apply-entry agent (which co-generates plan.md). -->

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Ship variant B — three rows (tile header · tab strip · URL row) — as one fab change; variant C (tabs merged into the tile header) is rejected. | Discussed — user: "Option B - fixed strip design looks good. So no need of the merged header." Study §8 records the decision. | S:100 R:85 A:95 D:100 |
| 2 | Certain | Active tab uses the folder treatment: inset strip ground (~30px, ~4px top pad), raised active surface shared with the URL row, 6px top radius, 1px dimmed card-border top/left/right, no bottom border, overlapping the strip rule by 1px; inactive tabs text-secondary/no fill/hover text-primary with hairline separators hidden next to the active tab. Underbar and well rejected. | Discussed — user chose folder; underbar collides with the green focus/latch signal; well reads as a pressed toggle with the light-theme ΔL issue. Values from the study CSS. | S:95 R:85 A:90 D:95 |
| 3 | Confident | The mock's `--bg-raise` maps to the existing `bg-bg-card` token (no new token); verify per-theme contrast against `bg-bg-inset` and only then consider deriving a `--color-bg-raise`. | User delegated ("pick an existing theme token such as `bg-bg-card` or derive one — record the choice"); light mock raise equals bg-card exactly, dark is within a few L. Verification risk noted in Open Questions. Confirmed by user (bulk confirm, 2026-10-27). | S:95 R:80 A:55 D:50 |
| 4 | Certain | Width ladder values: 200px max even share; active floor 110px; inactive share < 72px → icon-only at 34px; scroll only when icon-only tabs no longer fit, with a trailing-edge fade mask; labels ellipsis-truncate; implemented as a pure, unit-tested sizing function with named constants. | Discussed — explicit values and the unit-tested pure function are in the agreed description and study §3/§8. | S:95 R:80 A:90 D:85 |
| 5 | Certain | Icon-only inactive tabs take their even share width with a 34px floor (`max(floor(s), 34)`), exactly as the study's `sizeTabs` mock renders — no empty run is left at the icon-only rung. | Resolved by the session agent before handoff: "icon-only at 34px" in the dispatched description was a paraphrase of the study, and the study (the design authority the user approved) defines the share-width rung. Reversibility re-scored: a constant in a pure sizing function. | S:95 R:85 A:85 D:80 |
| 6 | Certain | Inactive tabs under 72px hide `×` even on coarse pointers; middle-click and roving Delete/Backspace still close them; the active tab always shows `×`; labelled inactive tabs keep today's hover/coarse rule. | Discussed — explicit in the agreed description; current coarse rule read from iframe-window.tsx. | S:100 R:90 A:95 D:100 |
| 7 | Confident | Drafts are counted in the ladder in strip order; a selected draft is the ladder's active entry (110 floor) and takes the folder surface with a dashed top/left/right border instead of the solid card border. | Description says drafts participate and keep the dashed treatment; the study renders a selected draft as `tab on draft` with `border: 1px dashed; border-bottom: none` and `ai = draft index`. Confirmed by user (bulk confirm, 2026-10-27). | S:95 R:85 A:70 D:65 |
| 8 | Certain | The kind badge moves to the address field's leading chip with the header badge's exact text/classes (`present` green · `:<port> proxy` amber · `external` blue; `relative` → no chip); the derivation is extracted into one shared helper rather than duplicated. | Discussed — explicit; classes read from surface-layout.tsx `webBadge`; code-quality forbids duplicated utilities. | S:95 R:85 A:90 D:90 |
| 9 | Confident | The address chip derives from the active declared tab's stored slot URL (as the header badge does today), stays visible while the address is being edited, and is absent while a draft is selected and in onboarding; new testid `web-kind-chip`. | Header badge today keys off the stored slot (`activeWebUrl`); a draft/onboarding has no address kind. Testid name is an implementation choice. Confirmed by user (bulk confirm, 2026-10-27). | S:95 R:85 A:45 D:40 |
| 10 | Certain | Tab icon ladder: spinner (unchanged) → favicon → neutral page glyph (text-secondary), hued by kind only when the declared family has more than one distinct kind; the kind dot is retired. | Discussed — explicit in description and study §4. | S:95 R:90 A:85 D:85 |
| 11 | Confident | "Mixed family" counts distinct `classifyAddress` kinds over declared tabs only (drafts excluded); `relative` counts toward mixing but its glyph stays neutral (no relative hue exists). | Follows the study's `mixedFamily = new Set(list.map(x => x.k)).size > 1` over declared tabs and `KIND_DOT_CLASS.relative = ""`. Confirmed by user (bulk confirm, 2026-10-27). | S:95 R:90 A:65 D:55 |
| 12 | Certain | The tile header drops `web-kind-badge`; keeps the `://` glyph, the page title with its meta fallback, the home chip, and the `keys → page` capture chip; the onboarding `://  Web` header is unchanged. | Discussed — explicit; the study's capture-chip move applied only to rejected variant C. | S:100 R:90 A:90 D:95 |
| 13 | Confident | With the badge gone, every content-bearing web tile header renders the title branch (title + meta fallback), including `relative`-kind addresses that today fall into the label + meta-chip branch. | Unifies the header now that the badge no longer gates the branch. User chose the title branch over keeping the label branch. Confirmed by user (bulk confirm, 2026-10-27). | S:95 R:80 A:40 D:30 |
| 14 | Certain | URL row: `◀ ▶ ↻ [address] ⌕ ↗ ⋯`; address ~11.5px in an unbordered inset field ~24px tall keeping the existing `INPUT_FOCUS` ring; row background is the folder raised surface. | Discussed — explicit; study §5 and `.url1`/`.addr1` CSS. | S:100 R:85 A:90 D:90 |
| 15 | Certain | Zoom (− % +) and Inspect move into the `⋯` menu; their command-palette rows stay; the `⋯` menu is keyboard reachable. | Discussed — explicit; Constitution V requires palette parity and keyboard reachability. | S:100 R:85 A:95 D:95 |
| 16 | Confident | `⋯` menu shape: `role="menu"` with GuiToolbarMenu keyboard idioms, registers `useOccludes("transient")`; a Zoom row with an inline `− % +` stepper that keeps the menu open (keeping `data-testid="web-zoom-control"` and the Zoom in/out/Reset aria-labels); an Inspect row only when `supports.devtools`; `⋯` absent in onboarding; kbd hints only from effective keybindings (the mock's ⌥⌘I/⌥← are illustrative). | Study mock's menu keeps open on zoom steps; overlay-presence rule requires transient registration for click-opened menus; onboarding already omits zoom. Confirmed by user (bulk confirm, 2026-10-27). | S:95 R:75 A:65 D:60 |
| 17 | Confident | Accept that the open `⋯` menu hides the native guest (overlay-presence transient rule), so zoom stepped inside the menu has no live preview on the desktop shell; no inline zoom affordance outside the menu. The zoom chip shows the result once the menu closes, and the palette's zoom rows give live stepping. | Session-agent default, stated to the user before handoff: low-stakes and reversible (an inline native-only stepper can be added later without touching the rest); keeps one URL-row shape across engines. Confirmed by user (bulk confirm, 2026-10-27). | S:95 R:80 A:60 D:55 |
| 18 | Certain | A zoom chip (e.g. `125%`) renders beside the address (after the field, before `⌕`) only when zoom ≠ 100%; clicking it resets zoom. | Discussed — explicit; placement from the study mock. | S:95 R:90 A:85 D:85 |
| 19 | Certain | Mobile: same folder strip and ladder; URL row `↻ [address] ⋯` with back/forward/find/open-in-browser moved into `⋯`; `IframeWindow` gets a `mobile` prop from `SurfaceLayout`. Verified today's mobile URL row equals desktop's (no mobile branch in iframe-window.tsx). | Discussed — explicit; the "verify current mobile URL row" instruction was satisfied by reading the code. Confirmed by user (bulk confirm, 2026-10-27). | S:95 R:80 A:75 D:75 |
| 20 | Certain | Strip and URL-row Tips keep `placement="top"` (native-engine guest clipping rule). | Discussed — explicit; existing code comment documents the rule. | S:100 R:95 A:95 D:100 |
| 21 | Certain | Preserve the full current web-strip contract: roving-focus keys, drag reorder (6px threshold, green drop indicator), middle-click close, drafts, 16-tab cap Tip, double-click → draft, eager never-re-`src`d engines, both engines with native bounds following the placeholder, and all e2e testids. | Discussed — explicit constraint list; contract in lenses-and-layout.md § Web tab strip. | S:100 R:90 A:95 D:100 |
| 22 | Certain | A shell recording is owed alongside desktop + mobile web before/after recordings: the `⋯` Inspect row is native-only and the menu occludes the native guest, so the change behaves differently across engines. | Constitution § PR Evidence: a change that behaves differently across engines MUST carry both web and shell recordings; precedent `app/desktop/tests/demo/web-tile-native.demo.ts`. Confirmed by user (bulk confirm, 2026-10-27). | S:95 R:85 A:80 D:70 |
| 23 | Certain | Commit the study and add a `## Wiki` row for it in `docs/specs/index.md` in the existing rows' style; no other spec files change. | Discussed — explicit; specs are human-curated, only the index row was requested. | S:100 R:95 A:95 D:95 |
| 24 | Certain | New register glyphs (neutral page, `⋯`) go in `components/top-bar-icons.tsx` with `data-icon`s. | Existing URL-bar glyphs (Find/Inspect/Back/Forward) live in that register; no page or ellipsis glyph exists there today. Confirmed by user (bulk confirm, 2026-10-27). | S:95 R:90 A:70 D:65 |
| 25 | Certain | Icon-only tabs keep their label in the DOM visually hidden (accessible name for `role="tab"` and e2e text matching) and keep a `title` tooltip. | Accessibility and test stability; not discussed but one obvious approach. Confirmed by user (bulk confirm, 2026-10-27). | S:95 R:90 A:70 D:65 |
| 26 | Certain | The ladder is fed by a `ResizeObserver` on the strip (no polling) and applied as inline widths; when the strip scrolls, the selected tab scrolls into view on selection. | Code-quality forbids client polling; scroll-into-view keeps the active tab visible in an overflowing strip. Confirmed by user (bulk confirm, 2026-10-27). | S:95 R:85 A:75 D:70 |

26 assumptions (19 certain, 7 confident, 0 tentative, 0 unresolved).
