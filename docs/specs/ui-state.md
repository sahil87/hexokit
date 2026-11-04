# UI State — Every Addressable Thing Is a tmux Option

> **Status**: § Layout in tmux, § Code Surface + Code Bridge, § Web
> Tabs (incl. the `rk present` paragraph), and § `rk tab` are **[current]**.
> Decided 2026-08-28: zoom is per-viewer (not tmux);
> navigation is not tmux state in v1; `?layout=` dies after one release of
> link translation. Assumes
> `fab/plans/sahil/26-08-28-tmux-option-scope-naming.md` has shipped: every
> option below uses the `@rk_<scope>_<name>` scheme and the plan's target map
> is the starting inventory.
>
> **Supersedes / amends**: [`window-views.md`](window-views.md) R2 + R7 (choice
> is shared, not per-viewer), [`surface-layout.md`](surface-layout.md) § State,
> [`right-panel.md`](right-panel.md)
> § Companion Windows (unshipped; folded into § Open Questions) — the layout
> and code-root amendments are applied in place in those files. Terminology
> stays: rows are substrates, views are lenses.

## Contents

- Goal
- The Layer Stack
- The One Rule — Tab State vs Viewer Preferences
- Addressing Grammar
- The Option Inventory
- Layout in tmux
- Web Tabs
- Code Surface + Code Bridge
- Viewer Behaviour — What Follows, What Doesn't
- `rk tab` — The CLI Surface
- What Dies, What Stays
- Migration
- Open Questions

---

## Goal

An agent (or the operator at a shell) can **fully address and drive the
HexoKit UI with tmux commands alone** — open a tab, choose its layout, add a
web tab, point the code surface at a folder, collapse it to one surface — and every
viewer looking at that tab sees the result. HexoKit's frontend becomes a
faithful *renderer of tmux state*, not a second store that must be nudged.

Corollary: `rk present`, the layout verbs, the surface toggles, the code
bridge's host resolution, and the `?layout=` deep links all become **sugar
over `set-option`**.

---

## The Layer Stack

Two axes. The first is tmux's and needs nothing new; the second is HexoKit's
and this spec defines it.

```
axis 1 — tmux substrate                     axis 2 — HexoKit lenses over a tab
host ─ server (-L) ─ session ─ window ─ pane         tab ─ surface ─ [web tab]
                              └─ "tab" ─────────────► @N
```

| Noun | Is | Address | Notes |
|---|---|---|---|
| **host** | a machine running `rk serve` | implicit (local daemon / `$TMUX` socket) | cross-host goes through `rk remote` tunnels; **not** in the address string (v1) |
| **server** | a tmux server | `-L <name>` | as `rk mux` today |
| **session** | tmux session | `=<name>:` | exact-match form, never fuzzy |
| **tab** | a tmux **window** | `@N` | immutable id; window *name* belongs to the user and is never parsed |
| **pane** | tmux pane | `%N` | substrate only — lenses render over the tab, not a pane |
| **surface** | a lens kind over the tab | `@N/<surface>` | `tty` · `web` · `code` · `gui` · `agents` (open registry, window-views.md) |
| **web tab** | one page inside the `web` surface | `@N/web/<n>` | 1-based index; the only surface with sub-addresses (v1) |

The **tab is not the terminal**. `tty` is a lens over the window's panes and
is the one surface that can never be closed (R3), but it is a surface like
the others. `rk tab …` never means "the tty".

---

## The One Rule — Tab State vs Viewer Preferences

> **Anything addressable as `@N/…` is a tmux option. Anything about the
> viewer's device is not.**

| Class | Lives in | Agent-writable? | Examples |
|---|---|---|---|
| **Tab state** — what the tab shows | tmux window options `@rk_win_*` | **yes** | layout tree, web tab set + active, code folder, note, color, marker |
| **Substrate facts** — derived from processes | pane/window options written by hooks or derived by the daemon | by hooks | agent state, chat identity, git root, ports |
| **Viewer preferences** — how this device renders | browser storage or component-local state | no | theme, terminal font size, sidebar width/open, keybindings, macros, compose drafts, web-tab drafts, web zoom, **tile zoom / mobile single-tile choice**, divider sizes |
| **Navigation** — which tab this viewer is on | the URL route | *by intent only* (§ Viewer Behaviour) | `/$server/@N` |

Today's leak is class 1 living in class 3: `rk-layout:*`, `runkit-window-view:*`,
`runkit-window-panel:*`, `runkit-code-folder:*` are all per-browser keys
holding tab state (ratios and zoom stay local — they are reading postures). They move to `@rk_win_*` and the
localStorage keys die.

Why shared is *correct*, not a compromise: tmux already shares pane layout,
active pane, and window order across every attached client. Two people
attached to the same tmux window see the same panes. HexoKit's per-viewer
layout was the deviation from the substrate it renders; this spec removes
the deviation. Mobile is handled by a **degradation rule**, not by separate
state (§ Layout in tmux).

---

## Addressing Grammar

One string, most-specific-wins, extending tmux's own:

```
[-L <server>] [=<session>:]@N[/<surface>[/<n>]]

@12              the tab
@12/web          the web surface of the tab
@12/web/2        web tab 2 inside it
@12/code         the code surface
-L fabKit1 =fabKit:@3/web/1
```

Rules:

- `@N` is mandatory when addressing a tab from outside it. Inside a pane,
  every verb defaults to **the caller's own tab** (`$TMUX_PANE` → `@N`, the
  `rk present` resolution) — the common agent case needs no address at all.
- Session/server qualifiers are exactly `rk mux`'s grammar (strict `%N/@N/=session:`);
  nothing fuzzy, no name-based window targets (a window name is a user label).
- Surfaces are addressed by *kind*, not by tile position. Position is a
  property of the layout (`@rk_win_layout`), so "slot A" is a layout
  question, never an address.
- A **layout tile** uses this grammar: a bare kind names this tab's surface,
  `@N/<kind>` another tab's (surface-layout.md § Tiles from other tabs).
  Layout leaves are same-server only — no `-L`/`=session:` qualifiers — and
  the `/<n>` suffix is grammar-only: it parses, and validation rejects it.
- Web tabs are **indexed, not named** — fewer round trips on the command line
  (`rk tab web rm 2`, not `rk tab web rm --name docs`). Titles are derived
  from the page and are display-only.

---

## The Option Inventory

Starting point: the scope-naming plan's target map (22 options → 21 after
`@rk_ctl_keepalive` deletes). This spec **adds** the rows marked *new*,
**renames** two, and **retires** one.

### Server (`@rk_srv_*`) — unchanged

`@rk_srv_session_order` · `@rk_srv_rank` · `@rk_srv_origin` · `@rk_srv_managed` · `@rk_srv_ephemeral` · `@rk_srv_protected`

### Session (`@rk_ses_*`) — unchanged

`@rk_ses_color` · `@rk_ses_flair` · `@rk_ses_pin_board` · `@rk_ses_pin_home` · `@rk_ses_pin_order`

### Window = tab (`@rk_win_*`)

| Option | Value | Writer | Status |
|---|---|---|---|
| `@rk_win_color` | color token | UI, agents | plan |
| `@rk_win_marker` / `@rk_win_flair` | marker/flair tokens | UI, agents | plan |
| `@rk_win_note` | `<epoch>:<text>` | agents, operator | plan |
| `@rk_win_role` | `operator` … | `rk role` | plan |
| **`@rk_win_layout`** | canonical split tree, e.g. `h(tty,v(code,web))`; the legacy `<shape>:<surface>[,<surface>…]` preset strings parse permanently | UI verbs, `rk tab layout`, agents | **new** — replaces `rk-layout:*` localStorage, `?layout=`, `?view=`, `?panel=` |
| **`@rk_win_web_<n>`** | URL (relative `/proxy/…`, `/present/{server}/{roothash}/…`, or absolute) | `rk tab web add`, UI address bar, `rk present` (sugar) | **new** — indexed set, `n ≥ 1`, dense (rm renumbers); present URLs are content-keyed (server + 12-hex sha256 of the root), the legacy `/present/{windowId}/{n}/…` slot form rides one release |
| **`@rk_win_web_<n>_root`** | absolute dir | `rk tab web add <file|dir>` | **new** — replaces `@rk_win_present_root`, now per web tab |
| **`@rk_win_web_active`** | `n` | UI tab strip, `rk tab web select` | **new** |
| **`@rk_win_code_root`** | absolute folder | first code-surface open (seed), code-server folder navigation, `rk tab code set` | **new** — replaces the `runkit-code-folder:*` localStorage latch |
| `@rk_win_url` | — | — | **retired** → `@rk_win_web_1` (migration row) |
| `@rk_win_present_root` | — | — | **retired** → `@rk_win_web_1_root` |
| `@rk_win_lens` (ex `@rk_type`) | — | — | **retired** — the "default view hint" (R5) is subsumed by `@rk_win_layout`; `rk present --window` writes `@rk_win_layout=web` instead |

### Pane (`@rk_pane_*`) — unchanged

`@rk_pane_agent_state` · `@rk_pane_agent_session`

### Option-value conventions

- Absent and empty read alike as "unset" (the `hasWebUrl` trim rule, generalized).
- Values are plain strings; **no JSON**. Multi-valued state is either an
  indexed family (`_web_<n>`) or a `:`/`,`-delimited scalar with a fixed
  grammar (`@rk_win_layout`). Every value must be writable by hand with one
  `tmux set-option -w` and readable with one `#{@…}` format.
- Every `@rk_win_*` row joins the **snapshot round-trip set** (`internal/snapshot`
  capture + restore); indexed families are captured by enumeration.
- Invalid values degrade, never error: an unknown kind, a non-canonical tree,
  or an unavailable surface in `@rk_win_layout` degrades leaf-by-leaf toward
  the bare `tty` leaf at render time (the R2 fallback spirit) — the option is
  left as written so the author can see their mistake with `show-options`.

---

## Layout in tmux **[current]**

`@rk_win_layout` carries the layout as a **canonical split tree**: a leaf is a
surface kind (`tty`, `code`, `web`, `gui`) or a foreign address `@N/<kind>`
naming another tab's surface on the same server, a split is `h(children…)`
(left→right) or `v(children…)` (top→bottom) with ≥2 children, and directions
alternate by depth — one encoding per arrangement, bare non-`tty` kinds never
repeat, and leaf count is bounded by the per-viewer size floor rather than a
fixed cap (surface-layout.md § The canonical tree). A foreign leaf whose home
window no longer exists is pruned at read time, with the bare-`tty` fallback
when the tree empties. Writers always
emit the tree form; the retired `<shape>:<order>` preset strings
(`split-h:tty,web` → `h(tty,web)`, `main-left:tty,code,web` →
`h(tty,v(code,web))`, …) parse into their trees **permanently**, so
hand-written and pre-upgrade values keep rendering identically.

What moves into tmux, what does not:

| Layout value | Home | Why |
|---|---|---|
| tree (structure + which leaf is which surface) | `@rk_win_layout` | agent-controllable, viewport-independent |
| **zoom** (full-center one tile) | **per-viewer, localStorage** (`rk-layout-zoom:{server}:{@N}`) | decided 2026-08-28: zoom is a *reading posture*, like sizes — a phone zooming `web` must not zoom the desktop. An agent wanting one surface writes the bare leaf (`web`) as the layout instead |
| **sizes** (divider positions) | **per-viewer, localStorage** (`rk-layout-sizes:{server}:{@N}:{structure-sig}` — one fraction array per split, in pre-order, keyed by structure signature so a swap keeps sizes with positions; the retired `rk-layout-ratios:*` keys are ignored, not migrated) | viewport-dependent — a 40/60 split means different things at 1440px and 390px; tmux itself re-flows pane sizes per client width |

Every existing verb (Add, Promote, Swap, Cycle template, Close, rail toggles)
becomes a **write to `@rk_win_layout`** through `POST /api/windows/{id}/options`,
exactly like color and note today; borrow and send-home are the two-tab
variants through `POST /api/layout/borrow` and `POST /api/layout/return`,
which recompute the other tab's tree server-side and write both in one
chained tmux invocation. The frontend holds no layout state of its
own; it renders the option and repaints on the SSE/`/ws/state` option tick.
The row-color safety-poll latency lesson applies: the POST handler must wake
the hub so a viewer's own click repaints immediately.

**Default.** Unset `@rk_win_layout` renders the bare `tty` leaf. The bare URL
is the deep link to the tab; there is nothing else to encode.

**Mobile degradation rule.** A coarse-pointer/narrow viewer renders **one
tile**: the viewer's local zoom if set, else slot A of the shared layout.
The mobile "switch-to-tile" verb writes the local zoom key only — it never
touches `@rk_win_layout`, so a phone user reading `web` leaves the desktop
viewer's arrangement alone. The *set* of tiles available to switch among is
the shared layout's order; adding a surface that is not in the layout goes
through the shared `--add` mutation like everywhere else.

**Deep links.** `?layout=` is **retired**. For one release the existing
route-entry shim translates old `?view=`/`?panel=`/`?layout=` links into a
one-shot write of `@rk_win_layout` (only when the option is unset; otherwise
the param is dropped and the shared layout wins). After that release the
param is ignored. The URL is always the bare route `/$server/@N`; "look at my
arrangement" is expressed as `rk tab layout @N …`, not as a link.

---

## Web Tabs **[current]**

**One `web` surface per tab; N web tabs inside it.** Chosen over "N web
surfaces per tab" because:

1. surface-layout v1 fixed *one tile per surface kind* and named the reason
   two web tiles were punted — distinct page addresses would have to become
   per-viewer state. With the address set in tmux the objection is gone, but
   the *layout encoding* still names kinds; web tabs keep it that way.
2. Two webviews in one tab would need a second arrangement model nested
   inside the first. Web tabs are a strip, not a layout.
3. Boards (surface-layout phase 4) tile surfaces across tabs; `@N/web/2` is
   addressable by a board tile for free.

State: `@rk_win_web_<n>` (URL), `@rk_win_web_<n>_root` (present root, file/dir
kinds only), `@rk_win_web_active`. **`n ≤ 16`** — the daemon reads window
options through `ListWindows`' fixed tmux format string (one call per server
per tick) and a format string cannot enumerate a family, so the URL slots are
spelled out `#{@rk_win_web_1}`…`#{@rk_win_web_16}`; roots stay out of the tick
(the `/present/{server}/{roothash}/*` handler reads the server's declared
roots at request time — one `list-windows -a` call over the sixteen
`_<n>_root` slots, sha256-prefix-matched — and the LEGACY
`/present/{windowId}/{n}/*` arm still reads `_<n>_root` directly with the
slot-1 `@rk_win_present_root` dual-read, one release). `web add` on a full
strip exits 1. The set is **dense and 1-based**. Removing tab 2 of 3
renumbers 3→2 and fixes up `_active`. Moving `n → m` permutes the URL and
`_root` companion as one pair; the intervening slots shift, and `_active`
follows the same tab identity to its new index. Renumbering is acceptable
because addresses are for commands, not for durable references — the same
trade tmux makes with window indices.

**Present URLs are content-keyed (decided 2026-09-01).** `rk present`
composes the `(server, roothash, path)` form — the tmux server name, a
12-hex sha256 prefix of the ABSOLUTE root directory, and the file's basename
(directory targets carry an empty path and serve the root's `index.html`):
`/present/{server}/{roothash}/{path}`. Resolution is derivation-only per
request (one `list-windows -a` over the 16 declared roots, unique
prefix-match against the URL's 8–64 hex segment, zero or more than one →
404); the declaration check is the anti-scanning property — an undeclared
root 404s with no file touched. The stored `@rk_win_web_<n>` value adopts
the same form (stored, iframe src, and copyable forms become one string
modulo origin and `?v=`). The legacy slot form
`/present/{windowId}/{n}/{path}?server=` serves unchanged for one release
(one handler, sniffed on the first segment's `^@[0-9]+$` shape); a stored
legacy URL is upgraded in place on re-present (WebAdd rewrites the slot to
the incoming new-form URL instead of `BumpVersion`-ing the legacy value).

Rendering: the tab strip always renders with the web tile — at an empty
family it is just the `+` (plus any viewer-local drafts), so the draft entry
points stay reachable from the empty state. Onboarding (no declared tabs) is
the empty-family CONTENT below the strip, not a stripless chrome variant.
Each declared web tab keeps its own iframe mounted (P3 — hide,
never unmount) so switching and reordering do not reload a dev server page.
Address-bar edits write `@rk_win_web_<active>`. Same-origin in-page
navigation updates the *display* only (as today) — the stored URL is the
tab's home, not its current location.

**Draft tabs are viewer-local.** The strip's new-tab affordances append an
ephemeral address-entry tab after the declared family. A draft has no URL and
therefore no `@N/web/<n>` address or tmux option; multiple viewers can hold
different drafts without changing shared state. Enter materializes the selected
draft through `web add` and selects the returned slot (including an existing
slot returned by idempotent add); Escape or the draft's close control discards
it. Drafts disappear when their window view unmounts.

**Identity is the URL, not the index (decided 2026-08-28).** `web add` is
idempotent on an identical resolved URL: it returns the existing index
instead of appending, and for file/dir kinds bumps that entry's `?v=`
cache-buster — which is exactly `rk present`'s re-present-is-refresh
contract, now falling out of the add verb. An agent that needs "my" web tab
back simply re-adds the same target; no durable ids, indices stay dense.

**Declared only (decided 2026-08-28).** Every member of the family is written
by someone. Ports detected on the tab's panes (`internal/ports`) are *not*
auto-materialised as web tabs — a derived member coming and going would
renumber declared ones under an agent's feet. Instead the strip offers a
detected port as a one-click **"+ add as web tab"** affordance (deferred —
needs per-window port attribution; tracked in `fab/backlog.md`), which is an
ordinary declared write.

**`rk present` is absorbed [current].** Its five target kinds and the `ProbePort`
step live on unchanged in `internal/present`; the verb becomes sugar:

```
rk present <target>               ≡  rk tab web add <target> --show
rk present --window[=name] <t>    ≡  rk tab new [--name] && rk tab web add <t> --layout web
```

`--show` = ensure `web` is in `@rk_win_layout` (grow through the ordinary
add verb) and set `_active` to the new index. The L3 "transient
auto-open carve-out" dies — auto-open is now just the layout write every
viewer renders.

---

## Code Surface + Code Bridge **[current]**

`@rk_win_code_root` replaces the per-browser latch. Seed rule unchanged:
written once, the first time the code surface renders for the tab, from the
derived git root; afterwards only code-server's own folder navigation (the
`load`-event seam) or an explicit `rk tab code set <folder>` moves it. The
terminal never moves it.

The option also drives the tile's URL. `GET /api/windows/{windowId}/code-workspace`
reads the live root and derives one `.code-workspace` file per (server, tab,
root) — `$XDG_STATE_HOME/hexokit/code/<server>/<@N>-<hash6>.code-workspace`,
its `settings` carrying `rk.tab`/`rk.server` — and the code tile mounts its
iframe at `/code/?workspace=<file>`. The `?folder=<root>` form survives only
as the degrade path (GET failure) and as the editor's own File > Open Folder
navigation, which re-latches and re-derives.

The code bridge registers each host with its tab and server (read from the
workspace file's settings) alongside the folder in `cb/hosts/<hostId>.json`,
so `rk code exec` resolves a tab **directly**:

```
rk code exec [--tab @N] <command> [args…]     # host = the one registered with tab @N on this server
```

Default `--tab` is the caller's own tab, so an agent in a pane says
`rk code exec workbench.action.files.openFile $uri` and hits *its* editor.
Folder matching (the tab's `@rk_win_code_root`, then the cwd toplevel) remains
the fallback for hosts registered without a tab.
The bridge is thus the code surface's command channel exactly as
`set-option` is every other surface's — it is the one surface whose interior
(open files, cursor) is not tmux state and never will be.

---

## Viewer Behaviour — What Follows, What Doesn't

With tab state in tmux, "does the agent control the UI?" reduces to one
question: **which tab is the viewer on?**

| Agent action | Viewer on that tab | Viewer on another tab |
|---|---|---|
| any `@rk_win_*` write (layout, web add, code root, color…) | repaints on the next option tick | nothing visible beyond sidebar signals (color, marker, dot) |
| `rk tab new` | — | new row appears in the sidebar |
| "look at this" (`--notify`) | already looking | Web Push with a deep link, as `rk present --notify` today |

Navigation is deliberately **not** tmux state in v1. tmux's own "active
window" is per-session-per-client and HexoKit's route is the analogue; an
agent that could yank every viewer's route would make the dashboard
unusable with two people or two agents. The nudge channel is push
notification + sidebar attention (right-panel P4: hidden must never mean
invisible-when-stuck).

Clicking a sidebar row is plain navigation to the tab's route, with no
special-casing: when one of the tab's surfaces is borrowed into another tab,
the layout renders that surface's placeholder on arrival (surface-layout.md §
Tiles from other tabs).

**Popout is a per-viewer posture, never tab state.** Popping a tile out
writes only the viewer's localStorage (`rk-layout-popped:{server}:{@N}`); the
opener renders the layout reduced by the popped leaf ids, and other viewers
and agents reading `@rk_win_layout` are unaffected. The popout window itself
is the terminal route carrying `?pop=<leaf-id>` — the one live terminal-route
search param beside `from`/`tab` (never translated away at route entry) —
rendering that one surface chrome-less, keyed to its window for life (it
never follows the opener's navigation, never aligns tmux, and renders an
ended "Window closed" state when the surface's window dies). Opener and
popout coordinate over a same-origin `BroadcastChannel` (opened/alive/closed/
pop-in/ping; a silent popout's mark is swept after 6s).

Opt-in **follow mode** — a viewer toggles "follow session X" and their route
tracks the session's tmux active window (`select-window` from a pane then
navigates the follower) — is the natural v2 and needs no new option: it
reads a tmux fact that already exists.

---

## `rk tab` — The CLI Surface **[current]**

All verbs are thin: resolve address → one or two `set-option` (or
`new-window`) calls → print the resulting address on stdout (data), diagnostics
on stderr. They **work with `rk serve` down** (the `rk mux`/`rk present`
pattern — tmux is the store, the daemon is a renderer).

```
rk tab new [--session =S] [--cwd DIR] [--name N] [--layout L]      → prints @N
           [--json] [--ready [--timeout S]] [--no-shell-fallback] [-- CMD [ARG…]]
           # --json prints {session, session_rung, window_id, pane_id[, ready]} instead;
           # CMD after -- is argv (rk-quoted, one literal word per token) with
           # the `; exec "${SHELL:-/bin/sh}"` fallback unless --no-shell-fallback
rk tab layout [@N] <tree|legacy-shape:surface,…> [--json]            # set (prints the tree form)
rk tab layout [@N] --add <surface> | --rm <surface> | --promote <surface> | --cycle [--json]
rk tab web add    [@N] <target> [--show] [--json]                  → prints @N/web/<n>
rk tab web rm     [@N/web/<n>] [--json]
rk tab web select [@N/web/<n>] [--json]
rk tab web mv     [@N/web/<n>] <m> [--json]                        → prints @N/web/<m>
rk tab web ls     [@N]
rk tab code set   [@N] <folder> [--json]
rk tab show       [@N]                                             # dump every @rk_win_* of the tab
```

`rk tab new`'s default session (no `--session`) is role-aware: outside tmux it
is the target server's current session; inside tmux it is the caller's own
session — **unless the caller sits in a run-kit infrastructure session**
(`_rk-operator`, `_rk-ctl`, `_rk-pin-*`, reserved — the `tmux.SessionRole`
derivation behind `rk mux sessions`), which never gains a spawned window
beside itself. The pick is then deterministic over the server's `role: user`
sessions in `rk mux sessions` row order: (1) the sole user session; (2) else
the first whose main-worktree root equals `--cwd`'s main-worktree root (both
sides resolved via `git rev-parse --git-common-dir`, so a linked worktree
under the sibling `<repo>.worktrees/<name>` directory matches a session
started at `<repo>` — a prefix match cannot); (3) else the most-attached,
ties broken to the earliest row; (4) zero user sessions → exit 1,
`nowhere to spawn`, no window created (the remedy: `--session =S`). The
deciding rung rides the `--json` document as the always-present
`session_rung` key (`explicit` · `caller` · `server` · `sole-user` ·
`cwd-root` · `most-attached`) and, on the human path, a stderr note
(`session: <name> (<rung>)`, suppressed by `--quiet`) when a role-aware rung
decided — stdout stays the bare `@N`. `rk present --window` inherits the rule
through the shared resolver.

`--add/--rm/--promote/--cycle` are the same three layout mutations the UI
verbs perform (surface-layout § Verbs), so agent and human go through one
growth/collapse table. Address arguments accept the full grammar; omitted
`@N` means the caller's tab.

For `web mv`, the source accepts a bare index (`2`), a surface-relative
address (`web/2`), or the full tab address (`@N/web/2`). The destination is
always a bare 1-based index within the same window.

Placement (cli-layering.md): `rk tab` is substrate — it manipulates tmux
options and windows and knows nothing about pipelines. fab's `fab pane`
migration map may route "open the worker's tab with code on the right"
through it later.

---

## What Dies, What Stays

| Dies | Replaced by |
|---|---|
| `rk-layout:{server}:{@N}` localStorage | `@rk_win_layout` |
| `runkit-window-view:*`, `runkit-window-panel:*` (legacy of `?view=`/`?panel=`) | `@rk_win_layout` |
| `runkit-code-folder:*` latch | `@rk_win_code_root` |
| `?layout=`, `?view=`, `?panel=`; L1–L4 ladder | `@rk_win_layout`; one release of link translation, then bare routes only |
| `@rk_win_lens` / R5 default-view hint | `@rk_win_layout` |
| `@rk_win_url` + `@rk_win_present_root` | `@rk_win_web_1` + `@rk_win_web_1_root` |
| L3 present auto-open carve-out | `--show` writes the layout |
| `rk present` as a first-class verb | kept as sugar over `rk tab web add` |

| Stays |
|---|
| per-viewer layout sizes (`rk-layout-sizes:*`, keyed by structure signature; the retired `rk-layout-ratios:*` keys are ignored) + the per-viewer zoom key |
| every viewer preference key (theme, fonts, sidebar, keybindings, macros, drafts, web zoom) |
| the template set, the verb table, the rail-as-toggle semantics |
| window-views R1 (availability derived), R3 (tty always reachable), R4 (one switcher), R6 (dot = current lens health) |

---

## Migration

Rides the scope-naming plan's `MigrateLegacyOptions` table (managed-conf
apply path, once per server per daemon lifetime, idempotent):

- `@rk_win_url` → `@rk_win_web_1`; `@rk_win_present_root` → `@rk_win_web_1_root`; set `_active=1` when `_web_1` exists.
- `@rk_win_lens=iframe` → `@rk_win_layout=web` (only when `_layout` unset), then unset `_lens`.
- localStorage → tmux is **client-side, one-shot, on route entry**: if the tab has no `@rk_win_layout` and this browser holds `rk-layout:{server}:{@N}`, POST it once, then delete the key. Same for the code-folder latch. Last browser to arrive wins on a never-visited tab — acceptable; it is the viewer's own last layout either way.
- Snapshot restore: the new rows enter the explicit option list; window ids remap as today.

---

## Open Questions

**Decided (2026-08-28)** — recorded so the reasoning survives:

- *Zoom is per-viewer.* Zoom and the mobile single-tile choice are reading
  postures, not tab state; they live in localStorage beside ratios. An
  agent that wants one surface writes `single:<surface>` to the layout.
- *Navigation is not tmux state (v1).* Agents nudge (push + sidebar
  attention), never move a viewer's route. Follow-mode is the v2 candidate.
- *`?layout=` dies.* One release of translation into a one-shot option
  write, then the URL is always the bare route.
- *Web-tab identity is the URL.* `web add` is idempotent on an identical
  URL (returns the index, bumps `?v=`); no ids (§ Web Tabs).
- *Web tabs are declared, never derived.* Detected ports become a one-click
  add affordance, not auto-members (§ Web Tabs).

**OQ1 — Ratios in tmux?** Percent ratios *could* be shared (`@rk_win_ratios`)
so an agent can say "code gets 70%". Deferred: viewport-dependence is real
and tmux's own model re-flows per client. Revisit when an agent actually
asks for it.

**OQ2 — Companions (`@rk_owner`).** Never shipped (no code references at
`67f4a553`). If revived it is one more `@rk_win_*` row (`@rk_win_owner`) and
`rk tab` must decide whether `@N` of a companion is a valid target. Keep the
right-panel.md section as a target note; nothing here depends on it.

**OQ3 — Boards.** A board is a layout of surfaces across tabs. With tab
state in tmux, does a board become `@rk_ses_pin_*` referencing `@N/<surface>`
addresses? Likely yes, and it would retire settings.yaml boards — out of
scope here, noted so nobody designs against it.
