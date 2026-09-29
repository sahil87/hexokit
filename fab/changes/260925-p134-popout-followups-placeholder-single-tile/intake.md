# Intake: Popout Follow-ups — Popped Placeholder, Full-Width Popout, Single-Tile Pop Out

**Change**: 260925-p134-popout-followups-placeholder-single-tile
**Created**: 2026-09-25

## Origin

> Check the recent change of being able to "pop out" windows. First, check for flaws in this yourself. Then a few obvious ones that I was able to see when you pop out a tile. The left part of it remains empty as if there's a space left for the left panel. What I would have expected is for the tile to just take the full space available in the pop-up shell. Also, let's say I pop out the terminal. I would expect that in the original tab, if I press the terminal button, I see a placeholder there which says "bring back the original terminal". […] Also, this feature is very asymmetric. Only if I have two tiles on the same tab will I be able to pop one out. Why not be able to pop out even if I have one tile on the tab? Why not just have pop out as an ubiquitous feature so it gets easier to test and use?

This change follows a `/fab-discuss` review of the popout feature: #1045 (surface popout, browser) and #1048 (`8349dd80`, desktop shell popout windows, change `260925-inm3-desktop-popout-windows`). The review turned up five items, and the user said "yes, proceed" to bundling all five into one change. Findings come from reading the code; none was reproduced live. Finding #1 in particular was traced through `app.tsx` and never clicked through, so apply MUST confirm it with a failing test before fixing it.

Relevant background from the plan `fab/plans/sahil/26-09-24-surface-drag-and-popout.md`:
- The "bring back" placeholder the user remembers comes from **Change 4 (tiles from other tabs / borrow)**: "Terminal is in tab B · bring back · go to B · status dot · ✕", rendered by `components/surface-placeholder.tsx` `SurfacePlaceholder`.
- The popout spec (Change 5) says only: "the opener hides the popped leaf locally and reflows".
- So the placeholder was never dropped from popout; it was never specified for it. This change adds it on purpose, reusing the borrow vocabulary.

## Why

1. **A destructive shared write from a viewer-only gesture.** Popout is per-viewer by design (spec `docs/specs/surface-layout.md` § Verbs → Pop out: "no `@rk_win_layout` write, other viewers unaffected"). The top-bar surface toggle breaks that promise:
   - `app.tsx` `togglePanel` (~2107) calls `toggleSurface(layout, …)` over the full shared tree.
   - The toggle group's `open: openTileKinds(layout)` (~5840) ignores the viewer's popped set.
   - So a popped terminal still reads "on". Clicking it writes a shared layout close: every viewer loses the terminal tile.
   - The mark is then pruned by `usePoppedSet`'s tree-key effect, and the popout window keeps running with nothing to return to.
   - What the user expects from that click is "show me the terminal".
2. **The popout wastes its window.** The popout posture passes `sidebarChildren={null}` (`app.tsx` ~5976), but `components/shell/shell.tsx:230` computes `sidebarVisible = sidebarOpen && !zenActive` without looking at children. The stage grid therefore keeps `${sidebarWidth}px 1fr` plus the 6px column gap (`:280`): an empty left column the width of the opener's sidebar.
   - Affects browser popouts (since #1045) and shell popouts (#1048) alike, because both render through the same `Shell`.
   - Because `sidebarOpen` is shared localStorage (`runkit-sidebar-open`), the column appears whenever the viewer's sidebar is open in the main window.
3. **Shell popout dedupe ignores which window opened it.** `main.ts` `shell:popout` dedupes by `findPopoutWindow(popouts, hostId, route)`. A second opener window on the same host that pops the same leaf is handed the FIRST opener's popout, focused.
   - The record's `openerWindowId` still names window A, so the native web guest move (`moveWebViewToWindow(webViews, popout.openerWindowId, …)`) never moves window B's guest.
   - Pop back in returns the guest to A, not B.
   - Minor, but it breaks change 6's guest-move invariant.
4. **Popped surfaces are invisible in the opener's chrome.** Beyond the all-popped placeholder, the opener has no affordance showing that a surface is popped, and no one-click way to bring it back or go to its window. The palette `Tile: Pop Back In` row is the only route.
5. **Pop out is gated on arity > 1.**
   - `surface-layout.tsx` `canPopOutTile` (~3154) requires `showVerbs`, which requires `arity > 1`.
   - `lib/palette/layout.ts` (~452) requires `renderedArity > 1`.
   - The stated rationale ("a single remaining tile gains nothing — the tab's own URL is the answer") is browser-era and already inconsistent: popping both tiles of a 2-tile layout reaches zero rendered tiles, and `PoppedOutPlaceholder` (`components/popout-states.tsx`) already handles that case.
   - The user wants Pop out to be ubiquitous, for easier use and testing.

If we don't fix it: #1 silently destroys other viewers' layouts; #2 makes every popout look broken; #5 keeps the feature unreachable on the common single-tile tab.

## What Changes

### 1 + 4. Popped placeholder: the toggle reveals it and never closes a popped leaf

The opener gains a per-viewer **revealed** set: popped leaf ids whose slot should render as a placeholder instead of being hidden.

- **State**: ephemeral React state in `AppShell`, keyed per `(server, @N)`, holding leaf ids. No localStorage, no tmux write: a reload returns to the reflowed default. An id leaves the revealed set when its popped mark clears (pop-in, `closed`, stale sweep, prune), so the set is always a subset of `popped`.
- **Render reduction**: the opener renders `reducePopped(layout, popped − revealed)`. A revealed popped leaf stays in the rendered tree and renders a **popped placeholder** in its slot instead of its surface.
  - The mount is gated the same way the away placeholder gates it (`awayHolderId` in `surface-layout.tsx` ~3056), so a revealed tty opens no relay stream and a revealed code leaf mounts no frame.
  - The hidden-tile retention rules (`hiddenTiles` ~3007: popped code, and shell-popped web, render no hidden tile) are unchanged for popped-and-not-revealed leaves.
  - For a revealed leaf, the popout still owns the live surface: a shell web guest MUST NOT be re-created in the opener.
- **Placeholder content**: reuse `components/surface-placeholder.tsx` rather than forking it. Generalise `SurfacePlaceholder` with a variant/message prop so the popout form reads:

  ```
  [status dot (tty)] ⌗ Terminal is popped out
  [ bring back ]  [ go to window ]                       ✕
  ```

  - **bring back** → `popIn(leafId)`, the existing opener path: posts `pop-in`, clears the mark, and the popout closes through `closeThisWindow()`.
  - **go to window** → focus the live popout:
    - Shell (`canShellPopout()`): call `shellPopout(popoutUrl(server, windowId, leafId))` again. Main's dedupe focuses the existing popout, restoring it if minimised, and returns `{ok:true}`. No new window.
    - Browser: `const w = window.open("", popoutWindowName(server, windowId, leafId))`. This returns the named popout without navigating it, and `w.focus()` works under the click's user activation. If no popout by that name exists, the call opens `about:blank`; detect that (`w.location.href === "about:blank"`) and navigate it to `popoutUrl(...)` (re-opening the popout).
    - Never call `window.open(popoutUrl, name)` directly: an existing named window would reload, which re-attaches the terminal and loses web state.
  - **✕** → remove the leaf from the revealed set only (per viewer, back to reflowed). Never a layout close. Shown only when the rendered tree has more than one leaf (the `showClose={arity > 1}` precedent). At arity 1 the placeholder is the only thing on screen, and ✕ would just swap it for the all-popped placeholder.
- **Top-bar toggle semantics** (`togglePanel` + the `surfaceToggles` slot, `app.tsx` ~2107 / ~5836):
  - The toggle's close target is the kind's first bare leaf (`closeSurface` semantics). When that leaf is **popped**, the toggle NEVER writes the layout:
    - Popped and not revealed → click **reveals** the placeholder.
    - Popped and revealed → click **hides** it again.
  - `open` for a popped kind reads true only while revealed.
  - The toggle carries a **popped marker**, the same visual channel as the existing `away` marker (`surfaceAway`, ~5794). Extend the slot's `away` callback, or add a sibling `popped` callback, so the top bar shows the surface is live elsewhere.
  - Non-popped kinds keep today's semantics.
- **Every path through `togglePanel` gets the same guard**, not just the top-bar button: palette surface-toggle rows, focus-hop "open-then-focus", and tile chords.
- `Tile: Pop Back In <Surface>` palette rows, the popout's own header verb, and `PoppedOutPlaceholder` are unchanged.
- **All-popped interplay**: the opener shows `PoppedOutPlaceholder` only when the rendered tree (`popped − revealed` removed) is empty. Revealing a leaf of an all-popped layout replaces the all-popped placeholder with that leaf's popped placeholder.

### 2. Popout fills its window: no sidebar column without sidebar content

- `components/shell/shell.tsx`: `const sidebarVisible = sidebarOpen && !zenActive && sidebarChildren != null;`. The desktop stage columns, the column gap, the aside mount (`:310`) and the resize-handle mount (`:325`) all follow from it. The popout posture then renders `0 1fr` with no gap.
- `useSidebarKeyboardToggle` (shell.tsx ~46): when the Shell has no sidebar children, ⌘B / ⇧Ctrl+B MUST be a no-op. Today it calls `setSidebarOpen`, which writes `runkit-sidebar-open` into the localStorage the popout shares with the opener, silently flipping the opener's sidebar preference (read on the opener's next mount; `chrome-context.tsx` has no `storage` listener). Thread a `disabled`/`hasSidebar` flag into the hook.
- The mobile drawer already gates on `!!sidebarChildren` (`:241`, `:372`). No change there.
- Verify the shell popout's drag strip still renders (intake #1048 § 1 "Drag surface"). This change only narrows the grid, so it should be unaffected.

### 3. Shell popout dedupe is per opener window

- `app/desktop/src/popout.ts` `findPopoutWindow(popouts, hostId, route)` → `findPopoutWindow(popouts, openerWindowId, hostId, route)`. Match all three.
- `main.ts` `shell:popout` passes `opener.id`. Each opener window gets its own popout of a leaf, so each popout's `openerWindowId` is correct for the guest move and for Pop back in.
- In practice this matches the browser: a named `window.open` from two independently opened tabs lands in separate browsing-context groups.
- Two tty popouts of one leaf each attach their own `_rk-iso-*` stream, the same as two browser tabs.
- Update `popout.test.ts` (`node --test`): dedupe hit for the same opener, miss for a different opener on the same host and route.
- Rejected: retargeting `openerWindowId` on a dedupe hit. Window B's own guest is parked under B while the popout holds A's moved guest, so pop back in would land a second guest under B's identity, where B already has one parked.

### 5. Pop out everywhere: drop the arity > 1 gates

- `components/surface-layout.tsx` (~3143–3159): decouple `canPopOutTile` from `showVerbs`. New gate:

  ```ts
  const canPopOutTile =
    !popoutTile &&
    !mobile &&
    tile.visible &&
    !(kind === "gui" && guiTileFullscreen) &&
    !coarsePointer &&
    onPopOut !== undefined &&
    !(leafHome !== undefined && homeWindow === null);
  ```

  - Render the Pop out button outside the `showVerbs && !popoutTile` block, so a single-tile header (desktop headers already render at arity 1: `!mobile && awayHolderId === undefined`, ~3260) shows Pop out alone.
  - The hairline separator renders only when the layout-verb cluster follows.
  - A revealed popped placeholder renders no header, so no Pop out appears on it.
- `lib/palette/layout.ts` (~443–452): drop the `renderedArity > 1` condition on `Tile: Pop Out <Surface>` rows. Keep the per-leaf not-popped, live and dead-home filters. Update the header comment (~68–75).
- Keep these gates: mobile/coarse pointer, and a desktop shell without the `windows.popout` channel (`!isShell() || canShellPopout()` at `app.tsx` ~4621 / ~6218).
- After popping the only tile, the opener renders `PoppedOutPlaceholder`, which already exists; now it is reachable from a 1-tile tab.
- Update the code comments that state the arity rationale (~3145 "a single remaining tile gains nothing…").

### Tests

- **Vitest** (`just test-frontend`, full suite, the project's unit gate):
  - `components/shell/shell.test.tsx`: stage columns `0 1fr` with no gap when `sidebarOpen` is true but `sidebarChildren` is null; ⌘B with no children leaves the persisted `runkit-sidebar-open` untouched.
  - A test (in `surface-layout.test.tsx` or an app-level harness, whichever reaches `togglePanel`) that first **fails on current main**: toggling a popped tty never calls `applyLayout` / writes the layout, and reveals the placeholder instead; a second toggle hides it.
  - Placeholder buttons: bring back → `popIn`; go to window → shell path calls `shellPopout`; browser path calls `window.open("", name)` and never `window.open(popoutUrl, name)`.
  - `lib/palette/layout.test.ts`: `Tile: Pop Out` offered at arity 1.
  - `surface-layout.test.tsx`: the Pop out button renders on a single-tile desktop header, and not on coarse pointers or mobile.
- **Desktop** `node --test` (`cd app/desktop && pnpm run compile && pnpm test`): `findPopoutWindow` opener scoping.
- **Frontend e2e** `app/frontend/tests/e2e/surface-popout.spec.ts` (`just test-e2e surface-popout.spec`; check with `--list` first per the worktree-name filter gotcha):
  - Pop out from a single-tile tab → the opener shows the all-popped placeholder.
  - With 2 tiles, pop the terminal out → click the top-bar terminal toggle → the popped placeholder appears, and the shared layout (`@rk_win_layout`) is unchanged.
  - Bring back → the popout closes and the terminal returns.
  - The popout tile's left edge is at the stage padding: no sidebar-width offset.
  - Test Intent Comments required.
- **Desktop e2e** `app/desktop/tests/e2e/popout.spec.ts` (`just test-desktop-e2e`): add an assertion that the popout window's tile starts at the stage padding (no sidebar column) if cheap; otherwise leave it to the frontend e2e, since the Shell is shared.

### Specs / memory

- `docs/specs/surface-layout.md` § Verbs table:
  - Pop out row (~190): drop "Offered only above one rendered tile" and the stale "outside the desktop shell"; the shell is now eligible when it carries the channel, since #1048.
  - Add the popped placeholder and the toggle's reveal semantics.
  - Pop back in row (~191): add the placeholder's bring back button.
  - Specs are human-curated: keep the edit minimal and factual.
- `docs/memory/run-kit/ui/lenses-and-layout.md` § Surface popout: eligibility at any arity; the revealed set and placeholder; toggle never closes a popped leaf; go-to-window mechanics per engine.
- `docs/memory/run-kit/desktop-shell.md` § Popout windows: dedupe key includes the opener window.
- Shell grid rule: the stage reserves a sidebar column only when sidebar content exists. Record it in `run-kit/ui/routes-and-shell.md`, the file that documents the Shell stage grid.

## Affected Memory

- `run-kit/ui/lenses-and-layout`: (modify) § Surface popout — single-tile eligibility, per-viewer revealed set + popped placeholder, toggle-on-popped semantics, go-to-window per engine
- `run-kit/desktop-shell`: (modify) § Popout windows — dedupe keyed by (opener window, host, route)
- `run-kit/ui/routes-and-shell`: (modify) Shell stage grid — sidebar column reserved only when sidebar children exist; sidebar chord inert without a sidebar

## Impact

- **Frontend**: `app/frontend/src/app.tsx` (revealed state, `togglePanel` guard, toggle slot `open`/marker, placeholder wiring, reduction input); `components/surface-layout.tsx` (revealed placeholder mount gate, Pop out gate/placement); `components/surface-placeholder.tsx` (popout variant); `components/shell/shell.tsx` (grid + chord gate); `lib/palette/layout.ts`; the top-bar toggle group component (popped marker); `hooks/use-popout.ts` (a `focusPopout(leafId)` helper beside `popOut`/`popIn` is the natural home); `lib/shell.ts` unchanged. Colocated tests.
- **Desktop**: `app/desktop/src/popout.ts` (+ test), `main.ts` (one call site).
- **Backend**: none.
- **Constitution**: II (revealed set is ephemeral viewer state; nothing new persisted, no tmux write); IV (no new route); V (palette parity: Pop Out rows at arity 1; toggle rows share `togglePanel`'s guard); Test Intent Comments on touched e2e tests.
- **Palette count**: `operator-compose.spec.ts` counts `Operator:` entries only. Unaffected unless the e2e rig's single-tile default now exposes a `Tile: Pop Out` row in a counted assertion. Run `just test-e2e operator-compose.spec` in the gate to be sure.
- **Verification**: `cd app/frontend && npx tsc --noEmit`; `just test-frontend`; `just test-e2e surface-popout.spec`; `cd app/desktop && pnpm run compile && pnpm test`; `just test-desktop-e2e` if the desktop spec is touched.

## Open Questions

- Browser go to window: does `window.open("", name)` reliably return and focus an existing popout opened by a *previous* page load of the opener? A reload drops the opener relationship, but named lookup within the browsing-context group should still find it. Apply verifies in Chromium. If it fails, the fallback is to post a `focus` request on the `rk-popout` channel and have the popout call `window.focus()`, accepting that browsers may ignore focus without activation.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Bundle all five review items into one change | Discussed — user said "yes, proceed" to the bundled change | S:95 R:85 A:90 D:95 |
| 2 | Certain | Toggle on a popped surface never writes the shared layout; it reveals/hides a per-viewer popped placeholder | Discussed — user expects a "bring back" placeholder on pressing the terminal button; popout is per-viewer by spec | S:90 R:80 A:85 D:85 |
| 3 | Certain | Reuse the borrow placeholder vocabulary (`SurfacePlaceholder`: bring back · go to · status dot · ✕) for the popped placeholder | Discussed — recommended reusing the borrow design over a new one; user proceeded | S:85 R:85 A:85 D:85 |
| 4 | Confident | Revealed set is ephemeral React state (not localStorage), always a subset of `popped` | Constitution II favours not persisting viewer postures beyond need; reload returning to reflowed default is harmless | S:60 R:85 A:75 D:70 |
| 5 | Confident | Placeholder ✕ hides the placeholder (per viewer), never closes the leaf; hidden at arity 1 | Popped leaf is live elsewhere; a shared close would reintroduce bug #1; `showClose={arity > 1}` precedent | S:60 R:85 A:80 D:75 |
| 6 | Confident | Go to window: shell re-calls `shellPopout` (main dedupe focuses); browser uses `window.open("", name)` and re-navigates only an `about:blank` result | `window.open(url, name)` on an existing name navigates/reloads it; shell dedupe already focuses and restores | S:55 R:85 A:65 D:65 |
| 7 | Certain | Shell stage reserves the sidebar column only when `sidebarChildren` is non-null | Root cause at shell.tsx:230/280; the mobile branch already gates on children | S:90 R:90 A:95 D:90 |
| 8 | Confident | Sidebar chord is a no-op when the Shell has no sidebar children | It writes shared `runkit-sidebar-open`, flipping the opener's preference from inside a popout | S:60 R:90 A:80 D:80 |
| 9 | Confident | Shell popout dedupe keys on (opener window, host, route); retargeting the opener on a hit is rejected | Keeps the guest-move invariant; retargeting would double-park a guest under the second opener's identity | S:55 R:80 A:75 D:65 |
| 10 | Certain | Pop out is offered at any arity (header + palette); mobile/coarse and shell-without-channel gates stay | Discussed — user asked for pop out to be ubiquitous; the all-popped placeholder already covers zero rendered tiles | S:90 R:85 A:85 D:90 |
| 11 | Certain | At arity 1 the header shows Pop out alone (no zoom/✕), outside the layout-verb cluster | Desktop headers already render at arity 1 with no layout verbs; Pop out is a content-verb family member | S:65 R:90 A:80 D:80 |
| 12 | Certain | Every `togglePanel` path (top bar, palette rows, focus-hop, chords) gets the popped guard | One shared mutation seam; guarding only the button would leave the destructive write reachable | S:65 R:85 A:85 D:85 |
| 13 | Certain | Update the human-curated spec row in `docs/specs/surface-layout.md` § Verbs (Pop out / Pop back in) | The row now states wrong eligibility ("above one rendered tile", "outside the desktop shell"); the prior popout changes edited this spec too | S:80 R:90 A:85 D:85 |

13 assumptions (8 certain, 5 confident, 0 tentative, 0 unresolved).
