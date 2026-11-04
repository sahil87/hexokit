# Window Views — Rows Are Substrates, Views Are Lenses

> The model for every "parallel view" of a tmux window HexoKit renders: what a
> window row *is*, what a view *is*, how view availability is derived, and how
> view choice is expressed. This spec unified three features that grew up with
> three unrelated mechanisms — iframe windows (`@rk_win_lens=iframe`), desktop
> streaming (PR #71), and the agent chat view (since removed — see the removal
> note below; historically
> [`fab/plans/sahil/26-07-13-agent-chat-view.md`](../../fab/plans/sahil/26-07-13-agent-chat-view.md)).
> Sections marked **[current]** describe shipped behavior; **[target]** is the
> design intent this spec commits to.
>
> **Removal note (2026-09-04)**: the agent chat **view is removed** — PR #817
> (`260904-39bp-remove-chat-lens`) deleted the `?view=chat` lens, the `chat`
> surface kind, and the chat backfill/stream backend; chat-send merged into
> `POST /api/windows/{id}/send` (`target:"agent"`). The identity option survives
> as `@rk_pane_agent_session` ([`agent-state.md`](agent-state.md)). Chat
> mentions below are historical, kept where the taxonomy's history still
> teaches.
>
> Companions: [`agent-state.md`](agent-state.md) defines `@rk_pane_agent_session`
> (agent-session identity — consumed by operator actuation, fork/resume,
> closed-resume, auto-name); [`status-pyramid.md`](status-pyramid.md) is
> untouched by this model — status signals describe the substrate, never the
> lens.
>
> **Succession note (2026-08-12)**: [`surface-layout.md`](surface-layout.md)
> **[target]** generalizes *placement* — the exclusive main slot becomes a
> multi-tile surface layout, and R4's switcher retires in its phase 3. R1–R3
> and R5–R7 (availability derivation, per-viewer choice, tty reachability,
> default hints, dot semantics, substrate/view split) carry over unchanged.
>
> **Succession note (2026-09-09)**: the `desktop` lens is renamed `gui` per
> the 26-09-09 GUI-surface plan's decision D1 and specified in
> [`gui.md`](gui.md); PR #71 and
> [`fab/plans/sahil/26-07-14-desktop-view.md`](../../fab/plans/sahil/26-07-14-desktop-view.md)
> are superseded by
> [`fab/plans/sahil/26-09-09-gui-surface.md`](../../fab/plans/sahil/26-09-09-gui-surface.md).
> Historical `desktop` mentions below (the header origin above, § The
> Problem's pre-model row, the migration map's From cell) stay verbatim.

---

## The Problem [current]

Three features each render "a second output of the same underlying thing", and
each invented its own typing and view-state machinery:

| Feature | Availability signal | View choice | Who sees a flip |
|---------|--------------------|-------------|-----------------|
| iframe window | `@rk_win_lens=iframe` + `@rk_win_url` window options | server-side mutation — the `>_` button POSTs `@rk_win_lens: null` | everyone; the window's identity changes globally |
| desktop (PR #71, unmerged) | `desktop:` window-name prefix + `@rk_vnc_port` | fixed at creation — the relay sniffs the type and branches, so the tty is unreachable | everyone, permanently |
| chat (shipped, then removed — PR #817) | `@rk_pane_chat` pane option | client-side `?view=chat` + localStorage, per-viewer | just you |

Three conventions for "what kind of thing is this window", three for "which
view am I in". Left alone, every future projection (log viewer, diff viewer,
…) would invent a fourth.

---

## The Model [target]

Separate **what runs** from **what you can look at**:

1. **A window row is a substrate** — a supervised process in a tmux pane.
   Rows never exist purely to display something; if there is no process worth
   supervising, it should not be a window (see § Two Species).
2. **A view is a lens** — a renderer over one derivable output of that
   process. The tty is a lens. An iframe of the HTTP service the pane serves
   is a lens. The parsed agent transcript is a lens. The VNC framebuffer is a
   lens.
3. **Availability is derived; choice is per-viewer.** Which lenses a window
   offers is a *capability set* computed from pane/window options and
   derivable facts (Constitution II/X). Which lens *you* are looking through
   is client-side view state — never a server-side mutation, never part of
   the window's identity.

### The View Registry

| View | Available when | Renderer | Status |
|------|---------------|----------|--------|
| `tty` | always | xterm.js `TerminalClient` | **[current]** |
| `web` | always (the lens exists on every window, like `tty`); `@rk_win_url` selects the renderer's CONTENT — empty/whitespace renders the onboarding state (a reduced live URL bar + fill-path instructions), non-empty renders the live page through the tile's engine (§ Engines) — mirroring the `code` row's availability-vs-content split | `IframeWindow` chrome over an engine: `iframe` (browsers, PWAs, phones) or native `WebContentsView` (the desktop shell) — § Engines | **[current]** as a lens — change `260714-t97o-web-view-lens`; always-available + onboarding `260821-zqlq-web-tile-always-tileable-onboarding` |
| `chat` | — | — | **[removed]** — shipped per [`agent-chat-view.md`](../../fab/plans/sahil/26-07-13-agent-chat-view.md), removed by PR #817 (`260904-39bp-remove-chat-lens`); the identity option survives as `@rk_pane_agent_session` ([`agent-state.md`](agent-state.md)) |
| `code` | the window's code folder is LATCHED, or a git root is derivable from the active pane's cwd — derivation seeds the latch once, at first open, and the terminal never moves it afterwards (right-panel.md § The `code` lens); the code-server endpoint always resolves by convention, so it gates nothing, and reachability governs the renderer's CONTENT (live iframe vs not-running empty state), never availability | `CodeSurface` (lean proxy iframe, no URL bar) | **[current]** — change `260811-k3vp-right-panel-code-lens`, endpoint by convention `260811-a2bo`, folder latched `260813-if5d`; also the right panel's CODE surface (right-panel.md § Surface Registry) |
| `gui` | `gui.enabled` is on (settings registry bool, default `false` — a user choice, never a probe result; a host with Xvnc installed but the switch off shows no button); like `code`, availability is per-HOST not per-window, so the lens is offered on every tab. Reachability (the GUI socket answers) governs the tile's CONTENT — live canvas vs the enabled-but-not-running empty state — never availability ([`gui.md`](gui.md)) | noVNC canvas (`GuiSurface`, RFB over rk's `/ws/gui/{id}` WebSocket relay) | **[current]** — change `260909-o2sp-gui-surface-tile`; spec [`gui.md`](gui.md); plan [`fab/plans/sahil/26-09-09-gui-surface.md`](../../fab/plans/sahil/26-09-09-gui-surface.md) |

The registry is open-ended: a new projection adds a row here, a capability
signal, and a renderer — it does not add a window type, a name convention, or
a route.

### Engines [current]

The `web` tile is one chrome (`IframeWindow`) over two interchangeable engines
behind the `WebFrameEngine` contract: the `iframe` engine (an in-DOM proxied
`<iframe>` — browsers, PWAs, phones) and the native engine (a `WebContentsView`
composited over the tile by the desktop shell). The chrome renders per the
engine's reported `supports.*` capabilities, so a capability gap degrades a
control rather than the tile. Engine selection is per viewer: the native
engine when the desktop shell's `web` bridge is present, the `iframe` engine
otherwise — with a per-viewer opt-out back to `iframe`. The engine contract
and the layering model are specified by the study
[`docs/wiki/web-tile-native-browser-studies.html`](../wiki/web-tile-native-browser-studies.html)
(§3 engine contract, §5 layering); the working notes live in memory —
[`docs/memory/run-kit/ui/lenses-and-layout.md`](../memory/run-kit/ui/lenses-and-layout.md)
§ Web Tile and
[`docs/memory/run-kit/desktop-shell.md`](../memory/run-kit/desktop-shell.md)
§ Web Views.

The native engine's URL loading is per-host, in one of three modes the desktop
shell reports over the `runkitShell.web` bridge (`web.mode()`, additive — an
absent invoker reads as `legacy`):

- **`direct`** — the host is this machine's daemon: the engine loads literal
  URLs (`http://localhost:6000/…`) with no proxy.
- **`proxy`** — a remote host whose capability probe passed: the engine loads
  literal URLs, and ALL guest traffic — DNS included — resolves on the rk host
  through a WebSocket tunnel ([`api.md`](api.md) § Tunnel). Each host
  runs in its own `persist:rk-web:<host.id>` session partition whose
  `session.setProxy` `{ fixed_servers, proxyBypassRules: "<-loopback>" }`
  points at a desktop-local loopback proxy (`http://127.0.0.1:<ephemeral>`,
  one listener per host); the local proxy terminates Chromium's proxy protocol
  and rides each connection over a WebSocket to the host's `/ws/tunnel`, which
  dials `host:port` from the rk host and pipes bytes. Because only WebSocket
  upgrades need to traverse the path, remote-native mode works behind ANY
  front end that passes WebSockets (Tailscale Serve, nginx, Cloudflare Tunnel
  — origin-form reverse proxies that reject CONNECT) with no raw-port or
  tailnet special case. Accepted cons: all web-tile egress leaves from the remote host
  (its IP and latency), and the viewer's own localhost, LAN, and VPN are
  unreachable from the native tile in this mode — the iframe-engine opt-out
  remains the viewer-local escape hatch.
- **`legacy`** — the fallback: today's same-origin `/proxy/{port}` path.

Stored `@rk_win_web_<n>` slot values stay in `/proxy/N/…` form; in `direct` and
`proxy` modes the native engine maps them back to literal loopback URLs at load
time, so the same tab stays portable to browser viewers' iframe engines.

---

## Rules

### R1 — Availability is derived, never declared as identity

A lens's capability signal is a pane/window option or a request-time
derivation. `@rk_win_lens` as a *mutable identity* is retired; it survives only as
a creation-time **default-view hint** (§ Migration). No window-name prefixes
(`desktop:`) — names belong to users.

Web availability carries no signal at all: the `web` lens is **always
available** (like `tty`). `@rk_win_url` is its *content selector*, never its
availability gate — an empty/whitespace value renders the tile's onboarding
state (whose live address bar is itself the initialization path), a non-empty
value renders the live page through the tile's engine (§ Engines). This is
the `code` row's model: a stable
capability signal gates presence; a fluctuating condition governs content.

### R2 — Lens choice is shared tab state

Which lenses a tab shows is shared tab state: the `@rk_win_layout` window
option carries shape and order, and every viewer of the tab renders the same
arrangement ([`ui-state.md`](ui-state.md) § Layout in tmux). Unknown shapes or
unavailable surfaces degrade tile-by-tile toward `tty`; the option itself is
left as written. Deep links (push notifications, Host tiles) address the tab's
bare route. The only per-viewer part of lens choice is the viewer's zoom /
mobile single-tile choice, held in the `rk-layout-zoom:{server}:{@N}`
localStorage key (a surface kind; absent = no zoom).

### R3 — The tty is always reachable

Every window offers `tty`, whatever else it offers. For a **host-singleton
lens** (`gui` — one GUI session per host, no window row of its own) the
always-reachable tty is the supervisor's pane in the `rk-gui` sibling session
on the `rk-daemon` server; the tile's empty state and the palette carry a
`GUI: Open supervisor logs` action that navigates there
([`gui.md`](gui.md)). No relay sniffing, no window-name typing, no
`@rk_vnc_port`-style per-window option. A headless codex-server pane's tty
shows the server logs. Watching the raw process is the HexoKit ethos — no
lens may hide it, and no relay may sniff-and-branch it away.

The `web` lens is likewise always *reachable* (always tileable): a `?view=web`
(or `?layout=…web…`) deep link on a URL-less window keeps its tile and renders
the onboarding content state — it never degrades away to `tty`. The
`defaultView` hint is unaffected: a URL-less window still defaults to `tty`
unless the viewer chose otherwise.

### R4 — One switcher UX, shared by all lenses

A segmented chip in the top-bar right cluster's **L1 tier** (terminal-route
tier), rendered only when the capability set exceeds `{tty}`: two states
render `[tty|web]`-style, more render as a compact segmented group. Active
segment inverse-video. Palette parity (`View: Terminal` / `View: Web` / …)
and a keyboard shortcut are mandatory (Constitution V). The chip
**participates in the right-cluster overflow registry** (change
`260717-6anu-mobile-view-switcher-overflow`; the `260715-h1ck` priority+
registry): it is the **first candidate — so the first to yield** when the
cluster is squeezed (before any L1 split), and when it overflows it is
represented in the "More controls" chevron menu as **per-view rows** (`View:
Terminal` / `View: Web` / `View: Code`, the active row marked). This is
space-driven, not a mobile breakpoint gate — the pill stays inline whenever
there is room (on any viewport) and yields precisely when the heading needs the
space (the common phone case). The center page
heading does **not** follow the lens — it reads a static `Window: <window>` in
every lens (reversed by change `260714-uco1-topbar-heading-anchor-nav`; it
formerly read `Terminal:`/`Web:`/`Chat:`/`Desktop:` per the active lens). The
heading identifies the *substrate* (the tmux window); which *lens* you look
through is shown by this switcher, not the heading — so the switcher is the
sole lens indicator (**while collapsed into the menu, the marked menu row plus
the view content itself carry lens identity; deliberately no new inline lens
indicator is added to the bar**), and the heading's left anchor no longer jumps
on a lens switch. The generalized switcher shipped with `web-view-lens`
(change `260714-t97o`).

### R5 — retired

R5 — retired: the default-view hint is subsumed by an explicit `single:web`
layout ([`ui-state.md`](ui-state.md)).

### R6 — The connection dot reports the current lens's health

"Dot-everywhere = per-page live-data health" extends per-lens: tty → relay WS,
web → n/a (falls back to SSE health), gui → VNC WS (the RFB WebSocket relay;
noVNC `connect`/`disconnect` events).

### R7 — Content address and lens choice are substrate state; postures stay local

Mutating the *content address* of a lens (`@rk_win_web_<n>`, edited in the web
view's URL bar) and choosing *which lenses the tab shows* (`@rk_win_layout`)
are both substrate state — shared tmux window options, POSTed, visible to
every viewer and agent. Only render postures stay local to the viewer: tile
zoom (`rk-layout-zoom:*`), divider ratios (`rk-layout-ratios:*`), and focus.

### R8 — The native engine retains guests across tile unmounts

When the web tile unmounts — window/route switch, layout change dropping the
tile, host switch within the desktop window — the native engine's guest is
**parked, not destroyed**: the desktop shell hides it (`setVisible(false)`,
off the visible z-stack per the existing detach discipline) and holds it in
the Electron main process under a **stable retention identity** — the desktop
window, the host, the tmux server, the tmux window id (`@N`), and the web-tab
slot URL. The guest renderer keeps running: page state, JS state, and
WebSocket connections survive. A guest's own in-page navigation (tracked
location drifting from the slot URL) never changes the identity.

A frame mounting with an identity matching a parked guest **adopts** it
instead of creating a new one: re-bind it to the new frame, re-show it,
re-apply bounds, re-send the chord table and zoom factor, and re-report the
current title / favicon / tracked URL / loading state so the chrome shows the
right values without waiting for a navigation event.

At most **4** parked views (a named constant, not a setting — Constitution
IV); parking a fifth evicts (destroys) the least-recently-parked one, and
mounted views never count toward the cap. A guest is destroyed immediately —
never parked — when its tab is closed or removed from the window's web-tab
family, its URL slot changes, its host is removed, its desktop window closes,
its host's SPA reloads, or it is LRU-evicted. A killed tmux window's parked
guests receive no signal and simply age out through the LRU cap.
Existing hide rules (overlay hiding per R10, `tileError`, drag-hide, host
detach/attach) apply unchanged to an adopted view; parked views of a detached
host stay hidden when that host re-attaches — only mounted views re-show.

Retention is **native-engine only**: the iframe engine is unchanged —
retaining iframes across tile unmounts would need the code tile's
DOM-retention machinery, which a hidden `WebContentsView` never needs.

### R9 — A selected draft tab shows no frame

While a draft ("+") tab is selected, **no frame is active**: every engine
hides its frame (the native guest hides; iframe frames hide — per P3, never
unmount), and the content area renders a minimal blank new-tab panel in the
empty-tile onboarding visual language instead of the previous page.
Re-selecting a real tab (click, keyboard, or submitting a URL that lands in
an existing slot) re-activates its frame **without a reload**; submitting the
draft materializes a tab and activates the new frame.

### R10 — Click-opened menus hide the native view

The native guest is composited above the SPA's DOM, so any overlay that can
overlap a tile must hide it. Click-opened menus, dropdowns, popovers, and
context menus register with the overlay-presence registry under the
**`transient`** kind, and the native view hides while a modal **or** transient
overlay is open — the modal rule extended to one more kind. Tooltips and
hover-opened flyout cards are **excluded**: hiding on hover would flicker the
page.

---

## Two Species (and the residual case)

**Pane-coupled projections** — `web` on the row that actually serves the
port: the pane's process genuinely has multiple outputs. This is the model's
home turf. (`code` and `gui` are **host-service lenses** instead — the
substrate is a host-level service, not one pane's process, so availability
derives from host state and the lens rides every row.)

**Row-less surfaces wearing a window costume** [current] — an iframe window
created from the Host SERVICES zone has an inert shell pane; the tmux
window exists only to give a URL identity, a sidebar seat, and
board-pinnability. Two-step exit path:

1. **[target, near]** Derive port → owning pane (listening-services collector
   already probes; `rk agent hook` already walks pid ancestry) and surface the
   `web` lens on the *owning* row. Host "Open in window" deep-links to
   `/$server/$window?view=web` when an owner derives; synthetic-window
   creation remains the fallback for non-derivable services.
2. **[target, far]** External URLs (staging sites, other hosts) are the honest
   residual — no pane can own them. If demand persists, they become board-level
   **URL tiles** persisted like `board_order` in settings.yaml, and synthetic
   iframe windows retire entirely. Until then, the synthetic window stays as
   the compat shim.

Boards, later: a board pin generalizes from *window* to *(window, view)* pair
— "pin the same window twice, tty and web side by side". Out of scope for
every current change; noted so nobody designs against it.

---

## Migration Map

| Feature | From [current] | To [target] | Vehicle |
|---------|---------------|-------------|---------|
| iframe | `@rk_win_lens` mutation flips the view for everyone; render gate `rkType === "iframe" && rkUrl` | `web` lens: `?view=web`, chip, no type mutation; `@rk_win_lens=iframe` demoted to default-view hint; `@rk_win_url` stays global substrate state | change `260714-t97o-web-view-lens` (drafted) |
| desktop | PR #71: name-prefix typing, relay sniffing, tty unreachable, bitrotted against current main | **superseded by `gui` per the 26-09-09 plan** — `gui` lens in [`gui.md`](gui.md): host-singleton substrate, `gui.enabled` switch, RFB over `/ws/gui/{id}`; PR #71 closed, salvage list in the plan § C2 | [`fab/plans/sahil/26-09-09-gui-surface.md`](../../fab/plans/sahil/26-09-09-gui-surface.md) C1–C5 |
| chat | shipped as `?view=chat` (chat plan changes 1–3) | **removed** — the lens, `chat` surface kind, and backfill/stream backend deleted; `?view=chat` is now a dropped legacy param (heals to the stored layout); chat-send merged into `POST /send` (`target:"agent"`) | PR #817 (`260904-39bp-remove-chat-lens`) |
| Host "Open in window" | creates a synthetic iframe window | deep-link to owning row's `?view=web` when derivable; synthetic fallback | follow-up after `web-view-lens` |
