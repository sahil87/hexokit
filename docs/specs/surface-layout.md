# Surface Layout — The Center Is a Layout of Surfaces

> The terminal route's center becomes a **layout manager**: one or more tiles
> (bounded by a per-viewport size floor, not a fixed cap), each rendering a
> **surface** (a (substrate, lens) pair per
> [`right-panel.md`](right-panel.md)), arranged as a **canonical split tree**
> with per-viewer **sizes**. This spec is **[current]** —
> shipped by `260812-ab5v-surface-layout-core` and follow-ons (toggles
> relocated to the top bar: `260815-19me`; mobile switch group: `260816-ox16`;
> option-driven shared layout state `@rk_win_layout`: `260828-iip5` — see
> [`ui-state.md`](ui-state.md)). It generalizes
> [`window-views.md`](window-views.md)'s exclusive
> main slot and subsumes [`right-panel.md`](right-panel.md)'s panel slot. It
> was designed in a `/fab-discuss` session on 2026-08-12; the execution plan
> lives at [`fab/plans/sahil/26-08-12-surface-layout.md`](../../fab/plans/sahil/26-08-12-surface-layout.md).
> Where this spec says "rail buttons"/"rail toggles", read the top bar's
> `surface-toggles` group — the right rail was retired by `260815-19me`, which
> relocated the open-tile toggles into the top bar.
>
> Companions: [`window-views.md`](window-views.md) (lenses, availability
> derivation — R1–R3 and R5–R7 carry over (R1 and R3 amended by
> `260821-zqlq`: web is unconditionally available and `@rk_win_url` selects its
> content; R4's switcher is retired
> here), [`right-panel.md`](right-panel.md) (surfaces, companions —
> P6 and the panel-slot mechanics are superseded here; availability,
> companions, and P4 carry forward; the rail did NOT survive —
> `260815-19me` moved its toggles into the top bar),
> [`pr-review.md`](pr-review.md) (the `review` kind — it owns that surface's
> availability, rendering and listener; the tile model and the surface registry
> stay here), [`agent-state.md`](agent-state.md),
> [`status-pyramid.md`](status-pyramid.md) (untouched — status describes
> substrates, never tiles).

---

## The Problem

1. **Lenses are exclusive; the panel is one fixed split.** The main slot
   renders one lens; the right panel adds exactly one more surface in one
   hardcoded position. The highest-value arrangements — agent big-left with
   editor and served page stacked beside it — are unreachable, and the center
   can end up burning half the screen on the inert shell pane of an iframe
   window while the content the user wants sits squeezed in the panel.
2. **View exclusivity confuses.** `View: Terminal / Code / Chat` menu rows
   read as "pick where you are" when the honest question is "pick what to
   show." Same-folder twin windows (a real window plus an `@rk_win_lens=iframe`
   sibling whose only job is to hold a different renderer) exist purely to
   work around the one-lens-at-a-time model.

---

## The Model

A **layout** is fully determined by two values:

| Value | What | Ownership |
|-------|------|-----------|
| **tree** | the canonical split tree of surface leaves (below) | shared tab state (`@rk_win_layout`) |
| **sizes** | divider positions (per-split fractions) | per-viewer, localStorage only (like panel width today) |

Tiles render surfaces of the **route window** or of another tab on the same
server (a foreign `@N/<surface>` leaf — § Tiles from other tabs; the
`agents` surface joins once it lands). The tty is itself a surface — `(current window,
tty)`, always available — so "the terminal" holds no privileged slot; it is
simply the default single-tile layout.

### The canonical tree (templates as generators)

A layout is a **canonical split tree**: a leaf is a surface kind, a split is a
direction (`h` = children left→right, `v` = top→bottom) with ≥2 children, and
a child split never has its parent's direction — so every arrangement has
exactly one encoding. The serialized grammar (in `@rk_win_layout`) is
`node = leaf | dir "(" node "," node {"," node} ")"` with no whitespace, e.g.
`h(tty,v(code,web))`. The tree is still constrained, never free: bare
non-`tty` kinds never repeat, leaf count is bounded by the 150×100 px
per-tile size floor (the floor gates offers — add, drop, template — never a
stored tree), and anything non-canonical fails the parse (the renderer falls
back to the bare `tty` leaf without rewriting the option).

The named arrangements survive as **templates** — generators that build a
tree for any N from a slot order (main fraction 0.58), not as the model. The
legacy `<shape>:<a>,<b>[,<c>]` preset strings parse into their trees
permanently and losslessly (`split-h:a,b` → `h(a,b)`, `main-left:a,b,c` →
`h(a,v(b,c))`, `main-right:a,b,c` → `h(v(b,c),a)`, `main-top:a,b,c` →
`v(a,h(b,c))`, `row` → flat `h`, `col` → flat `v`, `single:X` → `X`);
`main-bottom` (`v(h(b,c),a)`) exists only as a template. Every writer emits
the tree form.

```
 1 tile   2 tiles                3 tiles
┌──────┐ ┌───┬───┐ ┌───────┐   row        col        main-left   main-right  main-top   main-bottom
│  A   │ │ A │ B │ │   A   │ ┌──┬──┬──┐ ┌────────┐ ┌─────┬───┐ ┌───┬─────┐ ┌─────────┐ ┌────┬────┐
│      │ │   │   │ ├───────┤ │ A│ B│ C│ │   A    │ │     │ B │ │ B │     │ │    A    │ │ B  │ C  │
└──────┘ └───┴───┘ │   B   │ │  │  │  │ ├────────┤ │  A  ├───┤ ├───┤  A  │ ├────┬────┤ ├────┴────┤
          (row)    └───────┘ │  │  │  │ │   B    │ │     ├───┤ ├───┤     │ │ B  │ C  │ │    A    │
                   (col)     └──┴──┴──┘ ├────────┤ │     │ C │ │ C │     │ │    │    │ └─────────┘
                                        │   C    │ └─────┴───┘ └───┴─────┘ └────┴────┘
                                        └────────┘
```

Slot A is the **main** slot in `main-*` templates. Four tiles and beyond are
permitted when the size floor allows — the floor, not a tile count, is the
constraint (Constitution IV). A board remains the answer when the goal is
many tabs at once (§ Boards convergence).

### Tiles from other tabs

A leaf names either a bare surface *kind* of this tab (`tty`, `code`, `web`,
`gui`, `agents`, `review`) or a **foreign address** `@N/<surface>` — another tab's
surface on the same server. Server/session qualifiers (`-L`, `=session:`) are
not permitted, the `/<n>` web-tab suffix is grammar-only (it parses;
validation rejects it), foreign `gui` is never permitted (one desktop per
host), and a repeated foreign address, a repeated non-`tty` bare kind, or a
foreign address naming the layout's own tab fails validation. Content rides
the substrate's content signal (`@rk_win_url` etc. —
for `web` a content *selector*, not an availability gate: the `web` surface
is always tileable like `tty`, and an empty/whitespace `@rk_win_url` renders
the tile's onboarding content state while a non-empty one renders the live
page through the web tile's engine (iframe or native — window-views.md §
Engines; § The View Registry).
`gui` has no content selector in v1 — the tile shows the host's screen; a
per-session display option becomes the selector only if per-session GUIs ever
land ([`gui.md`](gui.md)). `review` is the one kind with a content signal that
is also its AVAILABILITY gate: it is PR-backed only, so the window's
branch-derived `prUrl` both selects the pull request and decides whether the
tile exists at all ([`pr-review.md`](pr-review.md) § R1–R2); a foreign
`@N/review` tile reads its home tab's PR. Two `web` tiles of one tab with different pages
would push content addresses into per-viewer state, crossing R7 — punted.

A surface is **live in exactly one place**. Borrowing moves it: drag another
tab's sidebar row onto a tile edge (or palette `Tile: Bring <window>
<Surface> here`) to insert `@N/<surface>` in this tab's layout, and the
surface unmounts at home. While it is away, the home slot renders a
**placeholder** — "in tab `<B>`" message, **bring back**, **go to `<B>`**,
the surface's status dot, and **✕** (which dismisses the slot; the top-bar
toggle re-adds it, placeholder again while away). A borrow of a surface
another tab already holds moves it through `POST /api/layout/borrow`, which
writes both tabs in one chained tmux invocation; a plain layout write naming
an already-held foreign leaf is rejected. Away state is **derived
server-side** as `WindowInfo.awayIn` (surface kind → holder window id) from
every tab's stored layout — nothing is stored. A foreign leaf whose home
window no longer exists is pruned at read time.

---

## State

The tree is shared tab state in the `@rk_win_layout` window option —
see [`ui-state.md`](ui-state.md) § Layout in tmux for the encoding, the
degradation rule, and deep-link handling. Unset renders the bare `tty` leaf;
the URL is always the bare route.

Three values stay per-viewer localStorage, as reading postures: divider
sizes (`rk-layout-sizes:{server}:{@N}:{structure-sig}` — one fraction array
per split, keyed by structure so a swap keeps sizes with positions; the
retired `rk-layout-ratios:*` keys are ignored, not migrated), tile zoom
(`rk-layout-zoom:*`), and the popped set
(`rk-layout-popped:{server}:{@N}` — a JSON array of leaf ids this viewer has
popped out; the opener renders the tree reduced by those ids, and the shared
`@rk_win_layout` is never written by pop-out or pop-in). There is no present
auto-open carve-out: showing a surface is an ordinary `@rk_win_layout` write
every viewer renders. History entries are bare routes — layout changes never
touch the URL, and back/forward shows whatever the tab's shared layout holds.

---

## Verbs

Dragging a tile's header is the mouse path for rearrangement; every drag
outcome also has a keyboard route, so every arrangement is reachable without
drag-drop — a guarantee that rides the **palette** (`Layout: Promote
<Surface>` + `Tile: Swap <Dir>` for placement, the generic add/close verbs
for growth and pruning). Growth is bounded by the size floor, not a template
list: beyond three tiles, off-template trees are ordinary states, reached by
drag and by the same generic verbs. Zoom, ↩ (foreign tiles), and close live as boxed, rest-visible buttons in
each tile's surface header; every verb also exists as a palette entry; the template-cycle chord
is bound directly (Constitution V — buttons are the mouse mirror, not the
mechanism). *Amended at phase-2 ship (`260812-ab5v`): per-verb chords (zoom /
promote / directional swap / close) shipped palette-reachable rather than
direct-bound — one cycle chord plus palette rows covers keyboard-first with
far less chord-surface; direct per-verb bindings remain open to a later phase
if palette latency proves irritating. Amended at `260812-wfic`: the verb
buttons shipped as fixed-size boxed buttons visible at rest (the hover-reveal
cluster was retired).*

| Verb | Effect on the tree |
|------|--------------------------|
| **Drag** (header, mouse) | Drag a tile by its header background: dropping on another tile's **center** swaps the two leaves; on its **edge band** (clamp(25 % of the axis, 28, 110) px; corners go to the deepest edge) splits beside it; on the **layout's outer 18 px edge** spans that side at 50 % of the axis. The overlay previews the *result* tree at this viewer's sizes (the dragged tile's destination filled); a drop that rebuilds the same arrangement reads "no change", one that would leave a tile under 150×100 px reads "too small" and is not offered. Escape cancels; a commit is exactly one `@rk_win_layout` write plus the viewer's sizes under the new structure signature. Disabled on coarse pointers, zoomed renders, and single-leaf layouts |
| **⛶ Zoom** | Tile goes full-center, others hidden (not closed); toggle back. No state change — a transient, like tmux `resize-pane -Z` |
| **Add** (open-tile toggle) | Split the **focused tile** along its longer axis (tie → horizontal), the new leaf landing after it — at landscape this reproduces the old 1→2 `split-h`, 2→3 `main-left` growth exactly; if the result breaks the 150×100 px per-tile size floor in this viewer's measured box, split the largest tile instead, and refuse only when no split fits (callers without measured rects use the nominal box). Refused on a repeated non-`tty` kind |
| **◧ Promote** (palette) | Swap this leaf with slot A (the template's main tile, or the first leaf in reading order for a custom tree) — palette `Layout: Promote <Surface>`; a center drop onto slot A is the drag equivalent |
| **⇄ Swap** (palette) | Directional swap (palette `Tile: Swap Left/Right/Up/Down`): swap the focused leaf with the geometric neighbour across that edge — the nearest leaf whose rect overlaps on the perpendicular axis; a no-op without one |
| **▦ Cycle template** | Next template for the current tile count (`row → col → main-left → …` at 3 tiles), rebuilt from the current slot order — one chip on the layout (top-bar right cluster), not per-tile; its popover shows the template mini-glyphs for direct jump (lossy for a custom tree) |
| **✕ Close** | The leaf drops out (remove + normalise); its neighbours absorb its size and the remaining **structure is kept** — closing one tile of a column leaves a column. The last tile never closes |
| **↩ Send home** | Foreign tiles only: the leaf drops out of this layout (remove + normalise, bare-`tty` fallback if it empties) and returns to its home tab, re-adding the home slot by the generic add rule when it was dismissed — one server-recomputed write through `POST /api/layout/return`. Disabled when the home window is dead; palette `Tile: Send Back to <home window>` |
| **Bring back** (placeholder) | The return started from the home tab's placeholder — the same send-home effect as ↩ |
| **Pop out** | The tile opens in its own window (the terminal route with `?pop=<leaf-id>`, chrome-less; in a desktop shell carrying the `windows.popout` channel the shell opens a same-host popout window, otherwise a browser window); the opener hides the leaf for this viewer only (`rk-layout-popped:*`) and reflows — no `@rk_win_layout` write, other viewers unaffected. A popped-out terminal attaches an isolated `_rk-iso-*` session, so it never fights the home tab's current window; a popped code tile evicts the opener's retained frame (one extension host, not two). Offered at any tile count, on fine pointers, never on mobile, and only where the popout channel exists (every browser; a desktop shell only when it carries `windows.popout`) — for live tiles (never the away placeholder or a dead-home foreign tile). Header button + palette `Tile: Pop Out <Surface>` (foreign leaves disambiguate with the home window's name). While any leaf is popped, header drag, the row-drag borrow, and the ▦ template cycle are disabled for this viewer (a drop or template resolved on the reduced render would drop the popped leaf from the shared layout); palette verbs address leaves by id and keep operating on the full tree. When every leaf is popped the opener renders a popped-out placeholder (a layout never renders empty). A viewer can reveal a popped leaf's slot as a **popped placeholder** ("<Surface> is popped out" with bring back / go to window, ✕ only above one rendered tile) through the surface toggle: toggling a surface whose close-target leaf is popped never writes the shared layout — it reveals the placeholder (toggle pressed), and toggling again hides it; the toggle carries a popped marker while the surface is live in the popout |
| **Pop back in** | The popout closes (its `closed` message or window close clears the mark) and the tile reflows back. Runs from the popout's own header verb, the opener's palette (`Tile: Pop Back In <Surface>`), the popped placeholder's **bring back** button, or the popped-out placeholder's button — closing the popout window by any means is equivalent. The popped placeholder's **go to window** button instead focuses the live popout (shell dedupe or the named browser window) without reloading it. A mark whose popout stops heartbeating (6s) is swept and the tile returns |
| **Switch-to-tile** (mobile-primary) | Swaps WHICH surface the mobile single slot renders: a target already open in the layout writes only the viewer's zoom key (`rk-layout-zoom:*` — no tmux write); an available-but-not-open target grows the shared layout through the shared `--add` mutation (`addSurface` → `@rk_win_layout` write) plus the zoom key; when growth is impossible (no split fits the size floor) the button is disabled. Lives in the top-bar switch group (§ Mobile) and the `Tile: Switch to <Surface>` palette entries that supersede `View:` at mobile width |

**Rail semantics change**: rail buttons become **open-tile toggles** — lit for
every open tile; clicking an unlit icon adds that surface to the next slot,
clicking a lit one closes its tile. The rail stays the availability +
attention surface (right-panel P4 unchanged — a collapsed/absent tile may hide
content, never state that wants a human).

Drag-drop is **sugar over the same generic tree edits** (drop-on-tile = swap,
drop-on-edge = wrap → remove → normalise, drag-divider = sizes) — nothing in
the verb model is throwaway.

---

## What dies, what stays

The R7 test sorts every mechanism: **substrate state** (shared fact about the
process, must outlive any browser) stays; **view state** (one viewer's choice)
moves into the layout.

| Mechanism | Verdict |
|-----------|---------|
| `@rk_win_lens=iframe` as identity | **Dies.** Demoted to a default-layout hint (ladder rung 3) during migration, then removable. Snapshot round-trip option set updates accordingly |
| The `>_` button's `POST @rk_win_lens: null` | **Dies** — the R7 conflation |
| The `ViewSwitcher` pill + `View:` chevron-menu rows (R4) | **Dies** — replaced by rail toggles + the ▦ chip. "Which view am I in" stops being a question because views stop being exclusive |
| `?view=` and `?panel=` params | **Retired** behind the permanent translation shim |
| Same-folder twin windows | **Collapse** — one window, `web`/`code` tiles in its layout |
| `@rk_win_url` | **Stays** — the web tile's content selector *and* shared content address (edit it and every viewer sees the new page, rendered through the tile's engine — iframe or native; empty/whitespace renders the tile's onboarding state). Never was view state |
| `@rk_pane_agent_session`, `@rk_pane_agent_state` | **Stay** — capability, status |
| Synthetic iframe windows for **external URLs** (no owning pane) | **Stay** as the compat shim — the honest residual (window-views § Two Species step 2); a web tile's content needs a substrate signal |

---

## Mobile (P5 carried forward)

Below `isMobileViewport()` the layout manager does not render multi-tile:
mobile keeps a single tile (slot A) plus the top-bar **switch group** — the
`surface-toggles` cluster entry forked to switch mode: one button per
available surface (the rail-hidden set still filters at render), rendered
only when ≥2 surfaces are available, with radio semantics
(the visible tile pressed; tapping the pressed button is a no-op). The group
is pinned in-bar at mobile — it never drops into the overflow chevron (other
chips yield first) and registers no overflow-menu rows — and carries the same
availability dots as the desktop toggles. Terminal and panel never share width
on a phone. A phone arriving at a tab with a 3-tile shared layout shows slot A and
offers the rest via the switch group.

The buttons run the **switch-to-tile** verb (§ Verbs): an already-open target
writes only the viewer's zoom key (no tmux write); an available-but-not-open
target grows the shared layout via the shared `--add` mutation (`addSurface` →
`@rk_win_layout` write) plus the zoom key, and renders disabled when growth is
impossible (no split fits the size floor under the nominal box). The palette mirrors the group with
`Tile: Switch to <Surface>` entries
(Constitution V), which supersede the `View:` lens entries at mobile width.

The `gui` tile gets one more rule on coarse pointers **[current]**: it scales
the shared desktop client-side (fit, or 1:1 clip+pan) and **never drives a
SetDesktopSize resize** — the desktop follows the last-focused *fine-pointer*
viewer's tile size; phones are readers of the shared screen, not its geometry
authority ([`gui.md`](gui.md) § Resize policy).

---

## Performance note

A 3-tile layout on a plaintext (HTTP/1.1) origin is SSE + up to 2 relay WS +
2 iframes' subresource fetches — the 6-slot connection-pool starvation class
from the board-route postmortem. Prod over h2 is immune; dev/e2e origins are
where it bites. Implementation carries the bounded-WS discipline from that
fix, and e2e specs budget tiles against the pool.

---

## Constitution Mapping

- **II / X** — nothing new is stored server-side; availability, content
  addresses, and rollups stay derived. Layout is client state (URL +
  localStorage); shared named layouts ride settings.yaml with boards (phase
  4). The popped set is per-viewer localStorage — a viewer posture, never a
  shared `@rk_win_layout` write; popout liveness is derived from the
  BroadcastChannel heartbeat, not stored.
- **IV** — no new routes; `?layout=` *replaces* two params; a canonical tree
  (constrained, templates as generators), not free trees; a per-viewer
  150×100 px size floor gates growth, not a tile cap. The popout is a viewer
  param (`?pop=`) on the existing terminal route, not a route.
- **V** — every verb is palette + chord reachable; the header drag's outcomes
  are all palette-reachable too (Promote + directional Swap cover placement at
  any tile count; past three tiles the size floor bounds growth, and
  off-template trees stay reachable via the generic verbs).
- **VI** — untouched; tiles are renderers over the same relay/proxy seams.

---

## Boards convergence (phase 4, noted so nobody designs against it)

A board is a **saved, named layout** whose tiles all point at other tabs —
every leaf a foreign `@N/<surface>` address landing on the same renderer (the
window-views § Boards generalization). Terminal-route layouts are anonymous;
board layouts are shared and named (settings.yaml, like `board_order`). "Save
this layout as a board" is the bridge verb. A creation-time
`@rk_default_layout` hint (for `rk riff` spawn shapes) is deferred to the same
phase.

---

## Phasing

Execution detail, per-change scope, and pickup notes live in the plan:
[`fab/plans/sahil/26-08-12-surface-layout.md`](../../fab/plans/sahil/26-08-12-surface-layout.md).

| # | Change | Ships |
|---|--------|-------|
| 1 | Spec (this file) + plan | Authored in the 2026-08-12 discussion session; lands with phase 2's PR |
| 2 | **Layout core** | The tile renderer replacing main slot + panel: presets, ladder, verbs, ▦ chip, rail toggles, translation shim |
| 3 | **Retirement sweep** | `@rk_win_lens` identity → hint, `>_` POST, ViewSwitcher, `View:` rows, snapshot option-set update |
| 4 | **Boards + extras** | Boards adopt the renderer; `@rk_default_layout` (the drag-drop sugar shipped with the header drag) |
