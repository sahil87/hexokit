# Right Panel — A Second Slot Beside the Terminal

> **Status: SUPERSEDED as a placement (2026-09-04)** — the collapsible
> right-side panel and its icon rail **no longer exist in the UI**.
> [`surface-layout.md`](surface-layout.md) **[current]** generalized the panel
> slot into the surface layout manager — the terminal route's center renders
> 1–3 tiles (`260812-ab5v-surface-layout-core`) — and the rail itself was
> retired by `260815-19me-composed-frame-unification`, which relocated its
> open-tile toggles into the top bar's `surface-toggles` group. Read all
> placement behavior from [`surface-layout.md`](surface-layout.md).
>
> What this spec still owns (**[current]**, consumed by the layout manager):
> the **surface registry** — a surface = a named (substrate, lens) pair
> (`lib/right-panel.ts` keeps `availableSurfaces` + the ratio clamps) — the
> `code` lens with its proxy prerequisites and git-root/reachability
> derivation (`260811-k3vp-right-panel-code-lens`), and P4 attention.
> The **companion window** convention, the `agents` surface, and the amber
> attention dot remain **[target]**.
> The panel-slot mechanics below — the rail, the panel shell
> (resize/per-viewer width/collapse), P6's one-surface rule, and the
> `260811-2r1w` / `260812-nm4p` phases — are **[historical]**, kept for
> design rationale.
> This spec extends [`window-views.md`](window-views.md) — that spec defines
> what lenses *are* and how availability derives.
>
> Companions: [`agent-state.md`](agent-state.md) (the rollup the agents
> surface feeds), [`status-pyramid.md`](status-pyramid.md) (untouched — status
> describes substrates, and companions roll into their owner's substrate).

---

## The Problem

1. **Lenses are exclusive.** The main slot renders one lens at a time — choose
   `web` and the tty is gone. But the highest-value projections are naturally
   *beside* the work, not instead of it: the editor/diff of the pane's
   checkout, the page the pane serves, the tier-2 workers the pane spawned.
2. **Subagents pollute the operator surface.** Tier-2 workers spawned as panes
   in the main window (or as sibling windows) clutter exactly the surface the
   operator is trying to keep readable.

Both needs share one substrate: a collapsed-by-default right panel.

---

## The Model

1. **The terminal route gains a second render slot.** The main slot keeps the
   existing lens model unchanged (window-views R2–R5). The **panel slot**
   renders one additional (substrate, lens) pair — the substrate is the
   current window *or one of its companions*. This is the
   [`window-views.md`](window-views.md) § Boards "(window, view) pair"
   generalization landing on the terminal route first.
2. **The rail is the affordance.** A ~38px icon rail on the right edge,
   rendered on every desktop terminal route and collapsible from the top bar
   (the `Toggle panel` chip — the sidebar toggle's far-right mirror,
   `260812-nm4p`), one button per available surface. Availability is
   derived server-side and rides the SSE window payload (Constitution II/X);
   buttons carry an availability dot and an amber **attention dot** when the
   surface holds a waiting agent. The collapse preference is the
   `runkit-rail-open` localStorage boolean (default open); actual right-area
   visibility is DERIVED — `railOpen || panel open` — so an open panel always
   shows the rail (deep links, the `⇧⌘.` chord, and palette entries are never
   dead), and collapsing with a panel open closes the panel too.
3. **A surface = a named (substrate, lens) pairing** registered below. The
   registry is open-ended the same way the view registry is.
4. **The right column is a full-height Shell grid column** (`260812-nm4p`).
   The terminal route's Shell grid grows an optional third column —
   `"sidebar content rightpanel" / "sidebar bottombar rightpanel"`, columns
   `${sidebarWidth}px 1fr auto` — so the rail and any open panel span both
   rows to the viewport bottom (mirroring the sidebar on the left), while the
   bottom bar + compose strip stay scoped to the content column. Collapse
   hides the column at width/display level — NEVER unmounting it (P3) — so
   the web/code iframes keep their in-memory state. Board/host routes pass no
   right-panel slot and render the two-column grid unchanged.
   (amended 2026-08-14, change `260814-ldbs-shell-stage-status-bar`: the
   right column is no longer a full-height Shell column — the non-sidebar
   region is a nested single-row **stage** grid (`bg-bg-inset p-[6px]
   gap-[6px]`, `1fr auto`) and the rail is a floating CARD in stage row 1 /
   column 2 (6px below the top bar to 6px above the status bar); collapse
   flips the stage template to `1fr`, dropping the `auto` track, while the
   aside stays mounted-hidden — P3 unchanged. The bottom bar is
   pointer-gated: no bar at all on fine pointers, today's content-column
   bar verbatim on coarse; a new full-width **status-bar** row spans ALL
   columns at the shell bottom)

### Surface Registry (initial)

| Surface | Substrate | Lens | Available when |
|---------|-----------|------|----------------|
| `web` | current window | `web` | always — the lens exists on every window (like `tty`); `@rk_win_url` selects the CONTENT (empty/whitespace → the tile's onboarding state, non-empty → the live page, through the tile's engine — window-views.md § Engines), never availability — the `code` row's availability-vs-content split (amended 2026-08-21, change `260821-zqlq`) |
| `code` | current window | `code` (new lens, below) | the window's code folder is **LATCHED, or** a folder is derivable from the active pane's cwd — the git toplevel when inside a repo, else the raw cwd itself (the same "toplevel, else cwd" fallback `rk code`'s CLI resolution uses), so a non-git window stays code-capable (since `260811-a2bo` the code-server endpoint always resolves by convention: preset `RK_CODE_SERVER_PORT`, else `RK_PORT+2`). The latch is what makes availability STABLE: it lives in the `@rk_win_code_root` window option, seeded from the derived folder the first time the code surface renders and moved afterwards only by code-server's own folder navigation, so a window that has ever opened the code surface keeps offering it even after its active pane leaves the repo — the rail button, the switcher segment, and `?view=code`/`?layout=` deep links no longer strobe with the terminal's cwd (see § The `code` lens). **Availability is the STABLE capability signal only** — code-server *reachability* never gates the button/segment (it would strobe the rail); reachability selects the surface's CONTENT instead: live iframe when up, the portless "code-server not running — check rk doctor" empty state when down, carrying a **Restart code-server** button (`POST /api/code-server/restart`: kill the `rk-code-server` session, re-run the ensure ladder so the binary and `RK_BIN` are re-resolved, wait up to 15s for the port; a missing binary spawns the install job; 409 on dev builds) (amended 2026-08-11, change `260811-k3vp`; port dropped by `260811-a2bo`; latch added 2026-08-13, change `260813-if5d`) |
| `agents` | companion window | `tty` | a companion window owned by this window exists |

### The `code` lens (new view-registry row)

`code` joins the [`window-views.md`](window-views.md) View Registry as a
full lens — so it is also reachable in the **main** slot via `?view=code` and
the shared switcher; the panel is merely its natural home.

- **Renderer**: iframe of code-server at `?workspace=<derived file>`,
  same-origin via the stable relative `/code/` route (`260811-a2bo` — the port
  is a server-side implementation detail and never appears in a URL). The
  `?folder=<latched folder>` form survives as the degrade path and as the
  editor's own File > Open Folder navigation (`260909-kji8` — see
  [`code-bridge.md`](code-bridge.md) § Tab identity).
- **Keyed by the resolved folder, not window id** — **[REVERSED 2026-09-09,
  change `260909-kji8-tab-keyed-code-workspace-actions`]** — the code lens is
  now keyed by the **tab** (one derived workspace file per (server, tab, root);
  see [`code-bridge.md`](code-bridge.md)). The rationale for reversing: the
  folder-latch problem this keying addressed was solved separately by
  `@rk_win_code_root` (`260813-if5d`); what remained of folder keying was
  shared editor state across same-folder tabs, which contradicts "the tile
  belongs to the tab" and caused the same-folder hostId collision. The original
  text is kept for design rationale: editor state follows the
  code; agents `cd` constantly. The resolved folder is the git toplevel when
  the cwd sits inside a repo — two windows on one worktree deliberately share
  one editor state — and the raw cwd itself when it doesn't: two non-git
  windows on different cwds get DISTINCT editor state (outside a repo there is
  no shared toplevel to key on), while two windows on the exact same raw cwd
  still share, same as two windows sharing a toplevel. **The folder is LATCHED, not tracked** (`260813-if5d`):
  derivation runs exactly once, the first time the code surface actually renders
  for a window, and seeds a per-window latch; from then on the ONLY thing that
  moves it is the editor's own navigation (File > Open Folder performs a full
  workbench navigation, which the parent reads off the same-origin frame's
  `?folder=` on `load` and writes back to the latch). The terminal never moves
  the editor — not on a pane switch, not on a `cd`, not on tile close/reopen,
  not on reload. That is precisely because agents `cd` constantly: a live
  derivation would take the editor's open tabs, dirty buffers, and undo stack
  with it. An empty derivation seeds nothing (only a window with no resolvable
  cwd at all — zero panes, no worktree path — derives empty), and a mounted
  iframe is never
  re-navigated by the parent — the latch fixes the `src` at MOUNT time only (P3).
  - **Storage**: per-viewer localStorage, keyed per (server, window id) — the
    `runkit-window-view` convention. Per-browser divergence is consistent with
    code-server's own tabs/layout state (Open Question 2); a window id remapped
    by a snapshot restore orphans its key, which simply re-seeds on the next
    open. A tmux window option (`@rk_code_folder`) as a cross-viewer store is a
    deliberately deferred upgrade path.
  - **A stale latch is accepted**: a latch pointing at a deleted worktree renders
    code-server's own "folder does not exist" state; the escape is File > Open
    Folder, which re-latches. No liveness probe, no reset verb, no palette entry.
- **Persistence is split across four stores** (researched 2026-08-11):
  settings/keybindings and hot-exit unsaved buffers live on the **server**
  (user-data-dir — dirty buffers survive reload and even a browser switch);
  open tabs and layout live in **browser IndexedDB keyed by the proxy
  pathname**; the undo stack is in-memory and dies on reload. Consequence:
  **the proxy path is state identity** — the code-server path MUST be stable
  across restarts, or users silently get a blank workspace that reads as data
  loss. The dedicated `/code/` route (`260811-a2bo`) makes the pathname a
  constant — immune to port changes by construction.
- **Topology**: one code-server instance per host, **rk-managed**
  (`260811-a2bo`): the daemon starts it as a sibling tmux session
  (`rk-code-server`) on the rk-daemon socket, bound to the convention port
  (`RK_PORT+2`; a preset `RK_CODE_SERVER_PORT` overrides — e.g. an externally
  managed instance), and `rk daemon stop` deliberately leaves it running.
- **Diff is not a separate surface** — code-server's own git decorations, SCM
  view, and diff editors carry it.
- **The workbench's load-time focus grab is guarded.** On every window switch
  the tile grid remounts, the code iframe reloads, and the workbench calls
  `focus()` once at editor-restore time — a programmatic steal no VS Code /
  code-server setting suppresses (the upstream anti-steal guard is scoped to
  the iframe's own document, so it always passes when embedded). HexoKit
  answers with per-window **focus memory** plus a **steal guard**
  (`src/lib/focus-memory.ts`, wired in `app.tsx`): each window remembers which
  of `tty`/`compose`/`code` the user last focused, and a desktop-only restore
  effect re-focuses it on return (first visit defaults to `tty` —
  keyboard-first). The guard is armed on every switch and disarmed on the
  first genuine interaction (in-frame keydown/pointerdown, or a capture-phase
  parent-document pointer/key event); while armed, an iframe-element focus
  that contradicts the remembered kind is reverted to it. The load-bearing
  asymmetry: `code` is recorded ONLY from genuine in-frame interaction
  (`CodeSurface`'s `onInteract`), never from iframe focusin — so the grab can
  never record itself as the user's choice, and when the remembered kind IS
  `code` the grab passes through: it IS the restore.

---

## Companion Windows

A **companion** is a real tmux window owned by another window in the same
session, hidden from navigation, rendered through its owner's panel.

- **Ownership is a window option**: a user option on the companion carrying
  the owner's immutable `@N` window id (rename-proof in both directions). The companion's
  *name* is sugar for raw-tmux readability (e.g. `<owner-name>-subagents`)
  and is **never parsed** — names belong to users (window-views R1).
- **Annotate, don't omit.** The snapshot/SSE payload keeps companions, tagged
  with their owner. Navigation and aggregation consumers (sidebar, switcher,
  palette, boards, counts) filter them via one shared helper; the terminal
  relay and the panel can still reach them.
- **Rollup**: a companion's agent-state rolls into its **owner's** window
  rollup — a waiting tier-2 worker turns the owner's dot amber. Hidden must
  never mean invisible-when-stuck.
- **Orphans unhide.** If the owner id no longer resolves (owner killed,
  companion moved), the companion loses companion status and appears as a
  normal window. Fail-open — never silently strand a live worker. There is no
  kill-cascade; companions outlive their owner until reaped deliberately.
- **The ownership option joins every `@rk_*` round-trip set** — snapshot
  capture/restore in particular (it round-trips an explicit option list;
  dropping it would resurrect companions as visible orphans on every
  restore). Note: owner window *ids* are not stable across a restore, so
  restore must remap the stored owner reference like any other id.
- **Creation**: `rk riff` grows a spawn shape that targets tier-2 workers
  into the owner's companion window instead of sibling panes/windows.

---

## Rules

### P1 — Panel choice is shared tab state; width stays per-viewer

Mirrors window-views R2: which surface the panel/tile shows is shared tab
state in the `@rk_win_layout` window option — every viewer of the tab renders
the same arrangement, and deep links (a waiting-agent notification) address
the tab's bare route (Constitution IV — no new routes). Panel width is a
per-viewer localStorage value.

### P2 — The panel is additive; the tty stays put

Opening a surface never changes the main slot's lens. On mobile the sheet
*covers* rather than splits (P5), but the tty remains one tap away —
window-views R3's spirit extends to placement.

### P3 — Hide, never unmount

Collapsing the panel or switching surfaces hides the surface's
iframe/terminal (`display`-level), preserving in-memory state (editor
selection, undo stack, scroll). The code surface extends this across
same-server window switches: the tile renderer keeps a bounded LRU of live
code frames keyed by the window's workspace src — the active window's frame
visible, the retained ones display-hidden — capped at 3 frames on desktop and
1 on mobile (the cap counts the active window's frame). Eviction (= unmount,
which lets code-server dispose the workbench) fires on LRU overflow at a
switch, on the frame's window leaving the live set (killed/closed), on a
non-follow code-root change, and on a code-server reachability `true→false`
flip (all frames drop). A follow (the editor's own File > Open Folder)
updates the frame's record in place and never evicts. The bound exists
because each live frame holds a ~250–320 MB extension-host process on the
server plus a browser renderer; the retention exists because a remount is a
full workbench reboot (measured 1.4 s to the workbench chrome, ~2 s to
explorer rows, ~2.9 s to the SCM status item on a warm cache) while a
display-hidden frame re-shows in ~16 ms.

### P4 — Attention must escape the panel

The rail button and the owner's sidebar/board dot both carry the companion
rollup. A collapsed panel may hide *content*, never *state that wants a
human*.

### P5 — Desktop rail, mobile sheet

Below the mobile threshold (`isMobileViewport()` — width OR coarse pointer)
the rail is not rendered; a single bottom-bar chip (with the same attention
dot) opens the panel as a **full-height sheet inside the main area** — the
sidebar-drawer pattern: absolute within main, top bar visible and
dismissing. Surfaces become tabs in the sheet header. Terminal and panel
never share width on mobile.

### P6 — One surface at a time

The panel renders one surface; switching swaps content in place (accordion).
Multiple simultaneous panels are out of scope (Constitution IV — resist
creep); boards remain the "many things at once" answer.

### P7 — Keyboard-first

`⇧⌘.` toggles the last-used surface (`Period` is deliberately unbound on
every tier in the shipped registry, so the shifted tier is free for this);
the palette gains `Panel: Code` / `Panel: Web` /
`Panel: Agents`; rail buttons are focusable. (Constitution V.)

---

## Constitution Mapping

- **II / X** — surface availability, git root, companion links, and rollups
  are all derived server-side from tmux options, cwd, and processes; nothing
  is pushed, nothing stored.
- **IV** — no new routes; one search param; one rail; one surface at a time.
- **V** — P7.
- **VI** — code-server runs under tmux (its own `rk-code-server` session on
  the daemon socket), not the Go server; server restarts never touch it.

---

## Interaction with Existing Plans

- **`260714-t97o-web-view-lens` (drafted)** — unchanged and complementary:
  it moves iframe rendering from window *identity* to a main-slot lens. The
  panel's `web` surface reuses that lens renderer in the panel slot.
  Whichever ships first, the renderer is shared.
- **Synthetic iframe windows** (window-views § Two Species) — the panel does
  **not** replace them and does not change their exit path. A standalone
  full-page surface (e.g. a generated report) is still legitimately a window;
  the panel serves content that belongs *beside* a specific window.
- **Boards (window, view) pins** — the panel introduces the pair model on the
  terminal route; boards adopt it later per window-views § Two Species note.

---

## Open Questions

1. **Keyboard capture** — focus handed to the code-server iframe swallows
   HexoKit shortcuts (and `⌘K` collides). The same-origin proxy provides the
   likely answer: the parent can attach a capture-phase `keydown` listener on
   `iframe.contentDocument` and reclaim rk chords before VS Code's keybinding
   service sees them — possible *only* because of the same-origin design.
   Unproven pattern; spike during phase 2.
2. **Layout state is per-browser** — tabs/layout live in browser IndexedDB
   (settings and dirty buffers follow the server), so a new browser or
   profile opens a blank layout. Decide: surface this to users or accept
   silently.
3. **Mobile in v1?** — recommendation: desktop-only first; the sheet is
   additive.
4. **Companion reaping** — who kills a done companion (riff, fab, the user)?
   Deferred to the agents-surface change.

Resolved 2026-08-11 (two spikes + source research): the proxy path is viable
— WS passthrough proven end-to-end, the Content-Length rewrite bug is fixed,
code-server's relative-base design fits the prefix-stripping proxy exactly,
no frame-blocking headers, auth cookie is deliberately sub-path-scoped. The
feared **service-worker collision is benign**: `Service-Worker-Allowed: /` is
a ceiling, not a claim — the registration requests a base-relative scope
(`./` → `/proxy/{port}/`), so HexoKit's root-scope Web Push worker is not
evicted; registrations at different scopes coexist.

---

## Phasing

| # | Change | Ships |
|---|--------|-------|
| 1 | Rail + panel shell + `web` surface | The layout, resize/refit mechanics, P1–P7; smallest slice, immediate value |
| 2 | `code` lens + surface | Registry row, git-root derivation, code-server embed. Proxy prerequisites (spiked, proven): `SetXForwarded()` in the proxy's Rewrite hook (without it code-server's origin check 403s every WS handshake — loads, then sits disconnected), a `/proxy/{port}` → `/proxy/{port}/` redirect, `allow-downloads` in the iframe sandbox. First-run checks against a live code-server: SW registration scope reads `/proxy/{port}/` in devtools (expected per source), hot-exit round-trip. Open Question 1 (keyboard) spikes here |
| 3 | Companion windows + `agents` surface | The convention, annotate+filter sweep, rollup, riff spawn shape |
