# Intake: Desktop-shell titlebar host strip — colour squares, host nameplate, and a lit band

**Change**: 261124-gwem-shell-strip-host-squares
**Created**: 2026-11-24

## Origin

> Desktop-shell titlebar host strip — colour squares, host nameplate, and a lit band.
> (Option C of the design study `docs/wiki/top-bar-host-studies.html`, user-approved in the 261124 design review.)

Promptless dispatch (`/fab-proceed` create-new, `{questioning-mode} = promptless-defer`): the description was
synthesized by the dispatcher from a prior design discussion. No questions were asked; every decision the
intake agent would have asked about is recorded below as an Unresolved row (`Deferred — promptless dispatch`)
or as a Tentative row with a concrete proposal.

Design source: `docs/wiki/top-bar-host-studies.html` — §5 "Option C: colour squares + host nameplate (review
direction)" (live mock `#m-c`, the Settings → Appearance mock, the band-treatment gallery) and §9
"Recommendation" (decision table). The study is uncommitted in this worktree (`?? docs/wiki/top-bar-host-studies.html`,
with a matching pending row in `docs/specs/index.md` whose description still says "recommendation (A …)" — the
study's own §9 was updated to "Updated after the review: Option C"). Where the study's §9 table and the
dispatcher description differ, the description wins (it records the later user decisions):

| Study §9 item | Study status | Resolution carried by this intake |
|---|---|---|
| 1 squares + nameplate replace the centred label | proposed | **in scope** (decided) |
| 2 click/hover/drag/⌥←→/menu from `+` or right-click | proposed | **in scope** (decided) |
| 3 lit band, `strip.effect` / `strip.motion` in Settings → Appearance → This app, defaults Glow + Light slides | decided | **in scope** |
| 3b `⌥⌘` / `Alt` key-hint pill | proposed | **in scope** (decided) |
| 4 remove top-bar wash + stripe (keep dock icon / favicon / PWA titlebar) | proposed | **in scope, shell only** — browser keeps wash/stripe in this change |
| 5 host colour host-owned only, spaced hues, used-hue label + advisory warning | decided | **in scope** |
| 5b no monogram letters in squares | decided | **in scope** |
| 6 nameplate fields + projection fields | proposed | **in scope** (decided) |
| 7 strip height 28 vs 32px | open | **decided: keep 28px** (`STRIP_HEIGHT_PX` unchanged) |
| 8 crumb dedupe + Refresh to overflow | proposed | **out of scope** (separate change) |
| 9 browser placement of squares | open | **out of scope** |
| 10 A fallback, B rejected | not chosen | recorded under Rejected alternatives |

Key decisions from the discussion (verbatim intent):

- Scope is the desktop shell only (`isShell()`); the 28px strip stays and is still shared with the Windows/Linux `titleBarOverlay`.
- Squares are fixed 18×18px, plain fill, active marked by a **ring**, not by size; **no monogram letters**.
- The key-hint pill's space is **always reserved**; hard requirement: square and nameplate positions are identical at rest, on title-bar hover, and while the chord is held.
- Light effect default is **Glow** ("what users see after upgrading"); motion default **Light slides**; `prefers-reduced-motion` forces **Cut**.
- Strip settings live in the **desktop shell's own store** (Electron main) — NOT localStorage (per-origin = per-host in the shell) and NOT host `config.yaml`.
- Host colour stays **host-owned only** (`instance_color`, This host scope) — no per-device or per-app override.

Rejected alternatives (from the discussion and the study):

| Rejected | Why |
|---|---|
| **Option A** — merge the strip into the top bar, host as root crumb | Kept only as the fallback if reclaiming vertical space ever beats colour; full-name host chips rarely fit beside the centred page heading, so chips fold to monograms/`●N` and lose the one-click switch |
| **Option B** — browser-style host tabs in the titlebar | Reads as a browser (tab shapes, per-host titles, active tab joining the bar below) |
| Monogram letters in the squares | Explicitly rejected — squares are plain colour; digits appear only while hints show |
| Per-device / per-app (local) host colours | A host's colour is part of its identity; every device must see the same colour |
| `localStorage` for the strip settings | In the shell each host is a separate origin, so the choice would not follow host switches |
| Host `config.yaml` for the strip settings | The effect is a property of the desktop app, not of any one host |
| Flat tint as the default | Loud, and does not point at which square is active (Flat survives as an opt-in treatment) |
| Growing squares on hover | Causes layout shift; the active square is a ring, hover changes no geometry |

## Why

**The pain.** In the HexoKit desktop (Electron) shell the native titlebar is hidden and the SPA draws a 28px
titlebar strip above its top bar (`components/desktop-shell/titlebar-strip.tsx`). Today that strip:

1. **Wastes the row** — it holds exactly one control, a centred `<host-name> ▾` switcher trigger; the rest is a flat
   35% accent blend (`titlebarHex`).
2. **Puts host identity far from navigation** — the host name sits centred, away from the left-side breadcrumb
   where the eye starts.
3. **Hides background hosts' waiting agents** — the amber `● N` chip exists only inside the dropdown, so a
   waiting agent on another host is invisible until the menu is opened.
4. **Says nothing beyond "a colour"** — the flat tint does not point at anything, and with today's accents
   several hosts blur together (study §2: ws-01, mac-mini, loom-box).
5. **Takes two clicks to switch** (open the menu, pick a row).

**If we don't fix it**, multi-host users keep paying two clicks per switch, keep missing background waits, and
the identity signal stays colour-only (weak under colour-vision deficiency, per study §2's CVD filters).

**Why Option C.** It keeps colour (the user asked to keep it) but never makes colour work alone: the nameplate
always names the active host. One click always switches (every host is a square), hover previews without
switching, background waits show as an amber dot on the square, and the drag surface is still the whole band
minus small squares. It is the cheapest build of the three options (replaces the strip's label; the light effect
is CSS; additive fields on `servers:list`). See Origin for the rejected alternatives.

## What Changes

### 1. Strip layout (desktop shell only)

`ShellTitlebarStrip` (`app/frontend/src/components/desktop-shell/titlebar-strip.tsx`) keeps its mount gate
(`isShell()`, mounted from `AppLayout` in `app.tsx` as a sibling above the top-bar wrapper), its `rk-shell-strip`
`<html>` marker class, and its height (`SHELL_STRIP_HEIGHT_PX = 28` in `lib/shell-strip.ts`, mirroring
`STRIP_HEIGHT_PX = 28` in `app/desktop/src/strip.ts`, still the Windows/Linux `titleBarOverlay` height).

The centred label / `<host-name> ▾` trigger is **replaced** by a left-aligned row:

```
[traffic-light inset ~80px (darwin)] [key-hint pill] [sq][sq][sq]…[+] [nameplate ……………………] [win/linux controls overlay inset]
```

- **Left inset**: 80px on darwin (traffic lights). Elsewhere the existing `env(titlebar-area-x, 0px)` expression
  (plus a small ~12px gutter, the study's `padL = 12`). The old symmetric 80px right inset on darwin is no
  longer needed for centring; right inset on darwin is a small gutter. Windows/Linux right inset stays the
  `titlebar-area-*` env expression from `stripInsets()` so nothing slides under the `─ ▢ ✕` overlay.
  `stripInsets()` changes accordingly (it currently returns `{left:"80px", right:"80px"}` on darwin).
- Study geometry (reference CSS `.crow`, `.blocks`, `.blk` in the study): row `display:flex; align-items:center;
  gap:16px`; squares container `gap:7px`; squares `18×18px`, `border-radius:4px`, digit font `10.5px` bold,
  digit colour `rgba(0,0,0,.72)`.
- **Popout windows** (the `title` prop path — `popoutChromeless`) are unchanged: static centred popout title,
  no squares, no nameplate (a host switcher has no meaning in a window pinned to one surface).
- **Below the switch gate** (`stripSwitcherEnabled(servers)` false — older shell without the `servers` group,
  denial, empty list): no squares and no pill; the nameplate shows the static name (`activeShellHostName(servers) ??
  location.hostname`) and the band still renders and drags (§ Shell chrome mounts on `isShell()`).

### 2. Host squares

- One square per shell-registered host, in **shell host-list order** — the same order as the ⌥⌘1–9 / Alt+1–9
  accelerators (`menu.ts` `MAX_SWITCHER_ACCELERATORS = 9`) and the native Hosts menu.
- Fixed **18×18px** (big enough for one digit). Plain fill in the host's instance colour: the full-strength
  `accentColor` from the `servers:list` projection, hex-validated by the existing `HOST_ACCENT_HEX` gate in
  `shellHostMenuRows`. **This view's own host** uses its live `useInstanceAccent().stripeHex` (so a pick in
  Settings repaints immediately). **Neutral fallback** when a host has no colour (e.g. a
  `color-mix(text-secondary 35%, transparent)` fill).
- **Active square = a ring** (`box-shadow: 0 0 0 2px <band bg>, 0 0 0 3.5px <text-primary>` per the study's
  `.blk.on`), never a larger size. **No hover scale** (the study mock's `.blk:hover { transform: scale(1.18) }`
  is NOT carried over — growing squares were rejected).
- **Waiting dot**: a background host whose `waiting` count is positive gets an amber corner dot (study `.bw`:
  7×7px circle at `top:-3px; right:-3px`, amber signal token, `box-shadow: 0 0 0 1.5px <band bg>`). Existing
  semantics: background hosts only (`shellHostMenuRows` already nulls `waiting` on the active row).
- **No monogram letters.** Digits `1`–`9` render inside squares only while hints show (§5) or while dragging (§4);
  squares past the ninth never show a digit (no accelerator).
- The squares are each a `-webkit-app-region: no-drag` island (`.rk-shell-no-drag`); the rest of the band —
  including the nameplate and the pill's gutter — stays `.rk-shell-drag`. This **supersedes** the recorded
  decision "The strip's switcher trigger is the band's only no-drag island" (top-bar.md) and the matching
  "exactly one no-drag island" prose in desktop-shell.md § Hidden Titlebar & Accent Strip.
- A trailing **`+` square** (study `.blk.add`: transparent fill, `inset 0 0 0 1px` text-secondary 70% ring, `+`
  glyph) — also a no-drag island — opens the existing host menu (§6).
- Accessibility (Tentative): squares container `role="toolbar"` `aria-label="Hosts"`; each square a `<button>`
  with `aria-label="<name>"` (+ `", N waiting"` when the dot shows) and `aria-current="true"` on the active one.

### 3. Click, hover preview

- **Click** a square → `switchShellServer(id)` (the existing `servers.switch` → main `switchToHost` seam; no
  optimistic UI; `false` → the existing `"Host switch failed"` error toast). Clicking the active square is a
  harmless no-op (same as today's menu/palette/native radios).
- **Hover** a square → the nameplate **previews** that host without switching: dimmed (`opacity: .62`), the name
  prefixed `→ ` (study `.cdet.peek`). Leaving the squares restores the active host's nameplate. The light does
  not move on hover.

### 4. Drag to reorder (pointer) and keyboard reorder

Gated on `canReorderShellHosts()` (the existing optional `reorder` invoker); without it, squares do not drag and
click still switches.

- Pointer-events drag with pointer capture (the study's implementation, not the dropdown's HTML5 DnD — the
  band is a no-drag island per square, and HTML5 DnD inside a titlebar is unnecessary). Movement threshold
  **4px**: below it the gesture is a click (switch); above it the gesture is a drag and the trailing click is
  suppressed.
- While dragging: the band gets a `dragging` state; **every square shows its digit**, and digits **renumber
  live** as the drop slot changes (the shortcut being assigned is visible); the dragged square follows the pointer
  (clamped to the row, `translateX`, lifted shadow); siblings slide aside by one slot (`18 + 7 = 25px`).
- **Drop commits exactly one** `reorderShellHosts(id, toIndex)` when `toIndex !== fromIndex`; local order updates
  optimistically; on `false` → `"Shell host reorder failed"` error toast + refetch (existing precedent,
  `titlebar-strip.tsx` line ~275).
- **Keyboard**: with a square focused, `⌥←` / `⌥→` (Alt+ArrowLeft/Right on all platforms — arrows compose no
  characters) moves it one slot per keypress with the same optimistic reorder + single commit per keypress;
  focus follows the moved square; no wrap (edge move is a swallowed no-op, the dropdown's ⌥↑/⌥↓ precedent).

### 5. Key-hint pill and digit reveal

- A small pill left of the squares: `⌥⌘` on darwin, `Alt` elsewhere (study `.kpill`: `height:18px; padding:0 6px;
  border-radius:9px; font-size:10.5px; letter-spacing:.05em`, `border: 1px solid text-secondary 55%`).
- Its space is **ALWAYS reserved**: `visibility: hidden` at rest, `visible` while the title bar (band) is hovered,
  while the chord is held, or while dragging. **No layout shift** — never `display:none`/conditional render.
- **Holding the chord** (`⌥⌘` = `altKey && metaKey` on darwin; `altKey` elsewhere) or **hovering the pill**
  shows digits 1–9 inside the squares. Hold state clears on keyup and on window `blur`.
- **Hard requirement — no shift**: square and nameplate bounding boxes are identical (same x, y, width, height)
  at rest, on band hover, while the chord is held, and while the pill is hovered. Digits render inside the fixed
  18px box; nothing resizes.
- Pill tooltip (`Tip`, not native `title=`): mentions the switch chord and the focus chord, e.g.
  `⌥⌘1–9 switches host · ⇧⌘H focuses the squares` (darwin) / `Alt+1–9 switches host · ⇧Ctrl+H focuses the squares`.
- The pill is a `.rk-shell-no-drag` island (the study mock marks it `kpill nd`) so its own hover can reveal the
  digits; whether the *band-hover* reveal works over `-webkit-app-region: drag` areas is an Open Question.

### 6. Host menu, focus chord, palette

- The existing host-switcher dropdown (rows with ✓ marker, name, dimmed origin, accelerator hint, accent bar,
  waiting chip, edit/remove/grip cluster, `+ Add Host…` footer, Remove confirm, `HostFormDialog` edit/add modes,
  plain-digit selection, Delete/F2/⌥↑↓) is **kept** and re-anchored: it opens from the **`+` square** or a
  **right-click on a square** (anchored under that square). Right-click opens with that host's row focused; `+`
  opens with the `+ Add Host…` footer focused when an add path exists, else the active row.
- **⇧⌘H / ⇧Ctrl+H** (shifted `KeyH`, today `host-menu-open`) **moves focus to the squares** (roving focus on the
  active square): `←`/`→` move focus (Home/End to ends), `Enter`/`Space` switch, `⌥←`/`⌥→` reorder, digits `1`–`9`
  switch to the Nth host (keeps the `⇧⌘H, 3` two-stroke muscle memory), `Shift+F10` / `ContextMenu` opens the host
  menu at the focused square (right-click parity), `Escape` or a second ⇧⌘H releases focus back to where it was.
  Registry shape: a new action (e.g. `host-strip-focus`, label "Focus host squares") takes the ⇧⌘H/⇧Ctrl+H
  default; `host-menu-open` keeps its palette entry `Host: Switcher` (and the `HOST_MENU_OPEN_EVENT` seam) with no
  default chord. Both component-local listeners, reading the binding via `byAction` and matching with
  `matchesCombo` + `shouldSuppressChord` (the existing pattern). See Assumptions #22.
  <!-- assumed: ⇧⌘H moves to a new focus action; host-menu-open keeps its palette entry with no default chord -->
- **Palette (Constitution V)**: the new focus action is palette-registered (layout-global, gated on a non-empty
  `useShellServers()` list like `Host: Switcher`); strip effect / motion changes are reachable via the existing
  `Settings: Appearance` palette entry (`settings-appearance`). Shortcut-overlay / Shortcuts-panel rows update
  for the re-targeted chord.

### 7. Nameplate

Right of the squares; `flex:1; min-width:0; overflow:hidden; white-space:nowrap; font-size:11.5px`. Fields,
separated by `·` (study `.cdet`):

| Field | Source | Example |
|---|---|---|
| **name** (bold, 12px) | shell display name (`servers:list` `name`) | `ws-01` |
| **user@machine** | `${sshUser}@${hostname}` from `/api/health` (`sshUser` + `hostname` — the os hostname, which is what the study's data shows; `location.hostname` would read `127.0.0.1` on tunnels). Prefix omitted when `sshUser` is absent | `sahil@ws-01` |
| **OS + kind glyph** | kind glyph (derived, below) + OS label | `[glyph] linux` / `[glyph] macOS` |
| **link** | derived from the host origin (below) | `tailscale` / `lan` / `ssh tunnel :3100` / `local` |
| **agents** | agent count (`N agents`) | `11 agents` |

**Kind** (Constitution VII — derived from the origin, no config; mirrors the study's `kindOf`):

```ts
// url = the shell entry's origin
const u = new URL(url);
const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
const port = Number(u.port);
kind = loopback && port >= 3100 && port <= 3199 ? "tunnel"   // rk remote SSH tunnel (PORTPOLICY_TUNNEL_START/END)
     : loopback ? "local"                                      // this machine
     : "net";                                                  // network host
```

**Link**: `tunnel` → `ssh tunnel :<port>`; `local` → `local`; `net` → `tailscale` when the hostname ends with
`.ts.net`, else `lan`. Kind glyphs are monochrome `currentColor` inline SVGs (study `ICON.local` / `ICON.net` /
`ICON.tunnel`; the open-row-icon precedent), with a label for AT (`this machine` / `network host (Tailscale /
LAN)` / `rk remote · SSH tunnel`).

**Fold rule**: fields fold **right-to-left** as width shrinks — agents first, then link, then OS+kind, then
user@machine; the **name never folds** (it truncates with ellipsis as a last resort). Fold is measurement-driven
(ResizeObserver on the band) and MUST NOT move the squares.

**Data for the active host** comes from this SPA (health + live SSE). **Background hosts' data** (for hover
preview) comes from each host's own SPA reporting to the shell, exactly as `accent:set` does today: a new
additive report channel (e.g. `nameplate:set` with `{ machine, os, agents }`, strictly validated main-side,
`isHostsSender`-gated, view-resolved via `findViewByWebContentsId`) whose values join the `servers:list`
projection as **additive optional fields** (e.g. `machine?: string`, `os?: string`, `agents?: number`),
validated strict-when-present by `isShellServer`. Older shells omit them → preview shows the **name only**. The
shell keeps them on the view-registry entry in memory (the `badgeCount` → `waiting` join precedent); never-visited
hosts have none.

- **OS source**: `/api/health` has no OS field today (`HealthResponse` in `api/client.ts`: status, hostname,
  sshHost, sshUser, instanceName, tunnel). Add an additive `os` field derived server-side from `runtime.GOOS`
  (Constitution X — derivable, not configured), displayed `macOS` for `darwin`, `linux`, `windows`. Older daemons
  omit it → the OS field folds away.
- **Agent count**: see Assumptions #19 (definition) — derived from SSE session data already in the client
  (no polling), in `lib/waiting.ts` beside `countWaitingAcrossServers`.

### 8. Band light effect

The band background becomes **neutral chrome** (`bgChrome`, the same base the top bar uses) and a treatment layer
"lights up" from the active square. Treatments are CSS in `globals.css` (the `rk-*` utility vocabulary) keyed
on three `@property`-registered custom properties:

```css
@property --ax  { syntax: "<length>"; inherits: true; initial-value: 0px; }     /* active square centre x */
@property --dx  { syntax: "<length>"; inherits: true; initial-value: 0px; }     /* nameplate end x (+22px) */
@property --acc { syntax: "<color>";  inherits: true; initial-value: #888888; } /* active host colour */
.strip { transition: --ax .6s cubic-bezier(.2,.8,.2,1), --dx .6s cubic-bezier(.2,.8,.2,1), --acc .6s ease; }
```

`--ax = activeSquare.offsetLeft + width/2`; `--dx = lastVisibleNameplateField.right + 22` (or `--ax + 40` when the
nameplate is empty); `--acc` = this host's `stripeHex`. Recomputed on mount, resize, fold change, reorder, and
switch.

Treatments (reference CSS verbatim in the study: `.tr-glow`, `.tr-livery`, `.tr-halftone`, `.tr-hex`, `.tr-scan`,
`.tr-edge`, `.tr-flat`, plus `.csweep`; the treatment layer and its `::before`/`::after` are `position:absolute;
inset:0; pointer-events:none` under the row):

| Key | Label | Look (study copy) | Core CSS |
|---|---|---|---|
| `glow` **(default)** | Glow | Radial light centred on the active square, fading across the band; far end neutral | `radial-gradient(ellipse 320px 72px at var(--ax) 50%, acc 62%, acc 20% 42%, transparent 78%)` |
| `livery` | Livery | Colour panel behind squares + nameplate ending in a slanted cut with two pinstripes | `linear-gradient(100deg, acc 40% 0, acc 24% var(--dx), transparent var(--dx), …stripes at dx+6..10 (80%) and dx+15..17 (45%))` |
| `halftone` | Halftone | Two dot grids, dense at the square, thinning outwards | glow 18% + `::before` 6px dot grid (1.5px) masked by an ellipse at `--ax` + `::after` offset 0.8px grid with a wider mask |
| `hex` | Hex mesh | Brand hexagon honeycomb fading from the square over a faint glow | glow 24% + `::before` acc fill masked by a 24×13.86 hex SVG tile intersected with an ellipse at `--ax` |
| `scan` | Scanlines | CRT scanlines in host colour, solid to the square, fading across | `repeating-linear-gradient(180deg, acc 60% 0 1px, transparent 1px 3px)` masked `linear-gradient(90deg, #000 0, #000 calc(--ax + 30px), transparent calc(--ax + 540px))` + `::before` 22% left wash |
| `edge` | Edge light | Neutral band; light rises from the bottom edge under the square + a 2px rule fading both ways | `radial-gradient(ellipse 230px 42px at var(--ax) 100%, acc 38%, transparent 80%)` + `::after` 2px bottom rule `transparent → acc at --ax → transparent (±440px)` |
| `flat` | Flat (today) | 35% fill across the whole band | `color-mix(in srgb, var(--acc) 35%, transparent)` — equals today's `titlebarHex` look |

- **Text legibility**: on textured treatments (`halftone`, `hex`, `scan`) the nameplate gets a halo
  (`text-shadow: 0 0 2px bg, 0 0 5px bg, 0 0 9px bg, 0 0 14px bg`, bg = band base). Nameplate text colour derives
  from the neutral base (`stripLabelColor(bgChrome)` or the theme's `text-primary`), secondary fields at 72%.
- **On-switch motion** (`strip.motion`): `slide` **(default)** — the `@property` transition slides the light from
  the previous square to the new one; `sweep` — slide plus a one-shot `.csweep` highlight (180px linear-gradient,
  `.9s cubic-bezier(.2,.7,.3,1)`, screen blend in dark / normal in light, starting at `--from = ax`); `cut` — no
  transition. **`prefers-reduced-motion: reduce` forces `cut`** (`lib/motion.ts` already reads the media query).
- **Cross-view slide**: a host switch in the shell is a detach/attach flip between per-host renderer views — the
  view being shown is a *different* SPA instance whose strip already marks its own host. To slide "from the
  previous square", the newly attached view needs the previous host's id; see Assumptions #16 for the proposed
  shell signal (fallback: cut).
  <!-- assumed: shell signals the previous host id to the newly attached view; absent signal degrades to cut -->
- **No accent** on the active host → no light (band stays neutral chrome).

### 9. Settings → Appearance: "This app" scope group

`AppearancePanel` in `app/frontend/src/components/settings-dialog.tsx` gains a **third `ScopeHeading` group
between This host and This device**, rendered only in the shell and only when the shell carries the prefs
invokers (older shell → the whole group is hidden and the defaults apply):

```
THIS HOST     stored on this instance, shared by every device
  Theme …
  Host colour   (was: instance accent colour — §10)
THIS APP      stored in HexoKit Desktop · applies to every host you open in it
  Host strip effect   How the titlebar lights up for the active host.     strip.effect   [7 preview cards]
  On switch           Reduced motion always uses Cut.                     strip.motion   [Light slides][Slide + sweep][Cut]
THIS DEVICE   stored in this browser only
  Terminal font size …
  Quake terminal opacity …
```

- Rows use `PreferenceRow` (label + sublabel + `meta` line carrying the key, as the Agents panel does).
- **Host strip effect**: single-select **preview cards** drawn with the real effect (a mini strip rendering the
  same treatment CSS with this host's colour and a few squares), keyboard reachable (roving focus / arrow keys,
  Enter/Space selects), `aria-pressed` (or radio semantics). Cards grid: `repeat(auto-fill, minmax(150px, 1fr))`,
  `max-width: 600px`.
- **On switch**: three chips using the Control primitive's latch (`controlClass({ variant: "toggle", pressed })`,
  the `ThemePairControl` precedent).
- **Storage**: the desktop shell's own store in Electron main, beside the host list/order/colours: keys
  `strip.effect` (`glow` | `livery` | `halftone` | `hex` | `scan` | `edge` | `flat`, default `glow`) and
  `strip.motion` (`slide` | `sweep` | `cut`, default `slide`). Proposed file `<userData>/prefs.json` (the
  `windows.json`-is-a-separate-file precedent), atomic tmp+rename write, corrupt/unknown value → default, an
  electron-free module `app/desktop/src/prefs.ts` with a `node:test` suite.
- **Bridge** (new optional `prefs` group, `app/desktop/src/preload.ts` ↔ `app/frontend/src/lib/shell.ts`,
  following the optional-invoker pattern exactly — structural narrowing, `false`/`null` on absence or rejection,
  **never throws**): `prefs.get()` → `{ ok: true, prefs: { strip: { effect, motion } } }`; `prefs.set(key, value)`
  validated main-side against the closed sets (`isHostsSender`-gated like `servers:*`); `prefs.onChange(handler)`
  subscription returning an unsubscribe (the `web.onEvent` precedent) — main **broadcasts a change event to every
  host view in every window** so all hosts' strips update live.
- **NOT** localStorage (per-origin = per-host inside the shell — a choice made while viewing ws-01 would vanish on
  switching to mac-mini) and **NOT** host `config.yaml` (Constitution IV: the single settings surface is still the
  Settings dialog's Appearance tab; this adds rows, not a surface).

### 10. Host colour (host-owned only)

- Still `instance_color` in the host's `~/.config/hexokit/config.yaml` (This host scope) via
  `useInstanceAccent().setColor(descriptor | null)` — a host has the same colour on every device. **No per-device or
  per-app override.**
- The Appearance row (`AccentColorControl`, today a `SwatchPopover` over the 30 `PICKER_COLOR_VALUES`) is
  presented as **Host colour** (sublabel per study: "This host's square and strip light, seen from every device.
  Spaced hues only. A hue another connected host already uses is labelled with that host's monogram.", meta
  `instance_color`) and offers a **set of well-separated hues** as an inline swatch row.
- The colour model is **descriptor-based** (`"4"`, `"1+3"`, family names, `-light`/`-dark`), not free RGB. The Host
  colour set is **9 hues** (user-decided 2026-11-24), written through `familyToLegacy`: purple `1+4`, **violet**
  `4+5` (new — see below), blue `4`, red `1`, green `2`, teal `6`, magenta `5`, slate `3+4`, amber `3` (amber kept
  despite the amber waiting dot — user decision). Orange (`1+3`) and olive (`1+2`) are not offered.
- **Violet is a new owned hue family**: `HUE_FAMILIES` in `app/frontend/src/themes.ts` gains
  `{ name: "violet", hue: 270, legacy: "4+5" }` between blue (250) and purple (290), making 11 families. This is a
  shared-palette change — the sidebar/server/window `SwatchPopover` family grid and any count-sensitive layout or
  test over `HUE_FAMILIES` pick it up (Assumptions #30).
- **Out-of-set stored values snap to nearest** for display: a host whose stored `instance_color` is not one of the 9
  (e.g. `1+3`, a `-light`/`-dark` shade, a legacy blend) renders its square, strip light, and picker selection as the
  nearest set member by hue; the stored value is **not rewritten** until the user picks again.
- **Clear (no colour) is kept**: a colourless host renders a neutral outlined square and the strip shows no light
  (today's fresh-host behaviour).
- **The HOST-panel swatch picker narrows to the same 9-hue set** (one set, both pickers), plus Clear.
- **In the shell only**: a swatch whose hue another connected host already uses is labelled with that host's
  **monogram** (study `mono()`: split the name on `[-_.]`; multi-token → first letter of the first token + the last
  token's number if numeric, else its first letter; single token → first two chars; uppercased — e.g. `ws-01` →
  `W1`, `mac-mini` → `MM`, `laptop` → `LA`), with an **advisory** warning when the current pick clashes ("Same colour
  as <names>. Pick another so the squares stay distinct."). Advisory only — never blocks the pick. "Used by" is
  computed from the other hosts' projected `accentColor` hexes (classification approach: Assumptions #26).
- Browser: the row renders with the same spaced set but no used-hue labels (no host list).

### 11. Top-bar wash + stripe removed in the shell

In `AppLayout` (`app/frontend/src/app.tsx` ~line 539), the 6.5% `washHex` background and the 2px `stripeHex`
stripe render only when `!isShell()` — in-shell, the strip is the identity surface. **Browser behaviour unchanged**:
wash/stripe, PWA titlebar `theme-color` tint, dock icon / favicon tint all stay. The HOST panel hostname tint is
unchanged in both.

### 12. Windows/Linux overlay colour under a lit band

With any treatment other than `flat`, the band's right end is neutral chrome, but the native `─ ▢ ✕`
`titleBarOverlay` today paints the `theme-color` meta (the 35% `titlebarHex` blend). Proposed: in-shell, the
single theme-color writer emits the neutral `bgChrome` when the effect is not `flat` (Assumptions #17).
<!-- assumed: in-shell theme-color goes neutral under non-flat effects so the overlay matches the band's right end -->

### 13. Live projection updates

The squares are always visible, so their colours, order, names, and waiting dots need to stay current without
polling (code-quality anti-pattern). Proposed: an additive main → renderer `servers:changed` event broadcast to
every host view whenever the store (add/remove/rename/reorder/set-url/accent) or a view-registry join input
(`badge:set` count, nameplate report) changes; the strip refetches `servers:list` on the event (the existing
`listSeqRef` monotonic guard still applies). Older shells: refetch on mount, on window focus, and after own
mutations (Assumptions #15).
<!-- assumed: additive servers:changed broadcast drives refetch; older shells refetch on mount/focus/own mutation -->

### 14. Tests and PR evidence

- **Vitest (pure helpers)** in `lib/shell-strip.test.ts`: kind/link derivation (loopback 3100–3199 → tunnel;
  other loopback → local; `*.ts.net` → tailscale; else lan), monogram, key-hint pill label, nameplate field
  model + fold order, used-hue classification, reorder index math, light-geometry pure parts, prefs value
  parsing/validation; `lib/shell.test.ts` for the new optional invokers (absent → false/null, rejection → false,
  malformed → null, never throws) and the additive projection fields (strict-when-present).
- **Vitest (component)** `desktop-shell/titlebar-strip.test.tsx`: squares in list order, ring on active, waiting dot
  background-only, click → `switchShellServer`, hover preview, drag commits one `reorder` (and click without
  movement switches), ⌥←/⌥→, ⇧⌘H focus + roving keys + digits + Escape, `+`/right-click open the menu, older-shell
  degradation (no squares/pill/prefs), popout unchanged. The existing dropdown suites keep passing (menu
  re-anchored, not removed). `settings-dialog` tests for the This app group (shell + invokers only).
- **Desktop node:test**: `prefs.ts` store (defaults, round-trip, corrupt → defaults, closed-set validation),
  projection join of the nameplate fields.
- **No-shift requirement MUST be covered by tests**: jsdom has no layout, so the measurement lives in the shell e2e
  lane (`app/desktop/tests/e2e/*.spec.ts`, Electron under Playwright): bounding boxes of every square and the
  nameplate are equal at rest, on band hover, with the chord held, and with the pill hovered. Each `test()` carries
  the Constitution's JSDoc intent block (**Proves:** / **Steps:**) and the file a setup header.
- **PR evidence** (Constitution § PR Evidence): a shell recording — `just demo <name>` with a spec under
  `app/desktop/tests/demo/` (e.g. `shell-strip-host-squares.demo.ts`): squares, hover preview, Alt pill + digits,
  click switch with the light sliding, drag reorder, Settings → Appearance → This app effect switching. Before/after
  via `--before`. The browser lane is unaffected (browser behaviour unchanged). macOS-only behaviour (⌥⌘ pill,
  traffic-light inset) is exempt: `No recording: macOS-only shell behavior not recordable by just demo`.

## Affected Memory

- `run-kit/ui/top-bar`: (modify) rewrite § Desktop-Shell Titlebar Strip (squares, pill, nameplate, lit band, menu
  re-anchoring, ⇧⌘H focus, popout/older-shell branches, test coverage); supersede DD "The strip's switcher trigger is
  the band's only no-drag island" (now N square islands + `+`); update DD "Drag regions are a CSS utility class"
  (no longer "the strip's single interactive island") and DD "Shell chrome mounts on `isShell()`" (switch gate now
  gates squares, not a trigger); add DDs for: fixed-size squares with ring-not-size active marker and reserved pill
  space (no-shift), host-list-order squares, CSS `@property` light effect, cross-view slide signal.
- `run-kit/desktop-shell`: (modify) § Hidden Titlebar & Accent Strip (drop "exactly one no-drag island"; overlay
  colour under non-flat treatments); § Host-List Store / IPC projection (additive `machine`/`os`/`agents` fields and
  their join); new prefs store section (`prefs.json`, electron-free module); § `window.runkitShell` Bridge (`prefs`
  group, nameplate report channel, `servers:changed` event, any switch-origin signal); supersede the one-island
  wording in § Design Decisions → The titlebar is colored by a page-drawn strip.
- `run-kit/ui/visual-design`: (modify) § Instance Accent — in-shell the top-bar wash/stripe are not rendered and the
  strip no longer paints `titlebarHex` (neutral base + treatment over `stripeHex`); spaced Host colour set; theme-color
  meta in-shell under non-flat effects; DD "`titlebarHex` is exposed…" consumer list update.
- `run-kit/ui/dialogs-and-state`: (modify) § Settings Dialog — Appearance tab table row and scope groups gain **This
  app**; Host colour row replaces the instance-accent row description; new controls (effect cards, motion chips).
- `run-kit/ui/keyboard-and-palette`: (modify) ⇧⌘H/⇧Ctrl+H re-targeted to focusing the host squares (new action),
  `host-menu-open` palette-only; component-local listener list; default binding table.
- `run-kit/api-and-sockets`: (modify) `/api/health` gains the additive `os` field.

## Impact

- **Frontend**: `components/desktop-shell/titlebar-strip.tsx` (major rewrite of the band; dropdown kept and
  re-anchored — likely split into a `host-squares` / `nameplate` / `host-menu` set of components to avoid a god
  component), `lib/shell-strip.ts` (+ tests), `lib/shell.ts` (prefs group, new projection fields, nameplate report,
  change subscription; + tests), `components/settings-dialog.tsx` (This app group, Host colour row),
  `app.tsx` (`AppLayout` wash/stripe shell gate), `globals.css` (`@property` registrations + `rk-strip-fx-*`
  treatments + halo + sweep keyframes), `instance-accent.ts` (in-shell theme-color under non-flat effect),
  `contexts/instance-accent-context.tsx` (possibly), `lib/waiting.ts` (agent count), `lib/keybindings.ts`
  (new focus action / re-targeted default), `use-global-palette-actions.ts` (palette entry),
  `components/settings-shortcuts-panel.tsx` (shortcut rows), a new nameplate reporter beside
  `ShellAccentReporter`/`ShellBadgeReporter`, `api/client.ts` (`HealthResponse.os`).
- **Desktop shell** (`app/desktop/src/`): `preload.ts` (prefs group, nameplate report, event subscriptions),
  `main.ts` (prefs IPC handlers + broadcast, nameplate handler + view-registry fields, `servers:list` join,
  `servers:changed` broadcast, overlay colour), `views.ts` (registry entry fields), `hosts.ts` (`HostInfo` optional
  fields), new `prefs.ts` (+ `prefs.test.ts`), `strip.ts` (unchanged height; possibly no change).
- **Backend** (`app/backend/`): `/api/health` additive `os` (`runtime.GOOS`), + Go test.
- **Tests**: vitest suites above, desktop node:test, a new desktop e2e spec for no-shift, a new shell demo spec.
- **Compatibility / version skew**: every new bridge member is optional and additive (older shell → squares still
  work from `servers:list`; no prefs rows, Glow + Light slides defaults; no hover-preview details; no live
  push → focus/mount refetch). Older SPA under a newer shell → unchanged behaviour (the shell's fallback strip CSS is
  untouched). No `hosts.json` schema bump.
- **Constitution**: IV (no new surface — rows in the Appearance tab), V (⇧⌘H focus + palette entries; every square
  action keyboard-reachable), VII (kind/link derived from origin), X (OS/user derived server-side), Test Integrity,
  Test Intent Comments, PR Evidence (shell lane).

## Open Questions

- On Windows/Linux, does pressing and releasing bare Alt (to reveal digits) focus or reveal the native
  `File | View | Hosts` menu bar under `titleBarStyle: "hidden"`? If so, should the reveal be keydown-only and
  accept the menu-bar side effect, or key on Alt held for a minimum duration?
- Hover on a `-webkit-app-region: drag` region does not deliver pointer events in Chromium on some platforms —
  does "visible on title-bar hover" for the pill need a hover-capable (no-drag) sensor, or a different trigger
  (e.g. reveal on `pointerenter` of the squares/pill islands only)?
- Today an accent-less host's view still reports its `theme-color` (plain chrome) into the shell's older-SPA
  fallback persistence; a square for such a host would show a near-background colour rather than the neutral
  fallback. Should the projection distinguish "no accent" from a chrome-coloured fallback?
- Many hosts (e.g. 15+): squares never shrink; does the nameplate folding to the name suffice, or should squares
  overflow into the `+` menu past some count?

## Clarifications

### Session 2026-11-24

| # | Question | Answer |
|---|----------|--------|
| 30 | Violet: add as an 11th shared hue family (hue 270), shown in sidebar pickers too? (User first asked whether host colours borrow the theme palette or are independent hues — explained: owned hue families with fixed hue angles, lightness/chroma toned to the active theme, shared with tab/workspace colours.) | Yes — 11th shared family |
| 22 | ⇧⌘H: focus the host squares instead of opening the host menu? | Yes — focus the squares (menu via `+`, right-click, palette) |
| 19 | Nameplate agent count: what does it count? | Tabs with an agent (busy, waiting or idle) on attached workspaces |
| 17 | Windows/Linux native controls colour under non-Flat effects? | Neutral unless Flat |
| 16 | Shell passes the previous host to the newly attached view so the light can slide? | Yes — older shells fall back to Cut |

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Desktop shell only (`isShell()`); browser behaviour (wash/stripe, PWA titlebar tint, dock icon/favicon) unchanged | Discussed — explicit scope in the description | S:95 R:85 A:90 D:95 |
| 2 | Certain | Strip stays 28px (`STRIP_HEIGHT_PX`/`SHELL_STRIP_HEIGHT_PX` unchanged, still the overlay height); study §9 item 7 (32px) resolved to 28 | Discussed — "keep the 28px strip" | S:95 R:80 A:90 D:95 |
| 3 | Certain | Squares: one per host in shell list order (= ⌥⌘1–9/Alt+1–9 and native Hosts menu order), fixed 18×18px, plain fill from projection `accentColor`, active = ring (box-shadow) not size, amber corner dot for waiting background hosts, no monogram letters | Discussed — user-approved Option C details, study §9 rows 1, 5b | S:95 R:75 A:90 D:90 |
| 4 | Certain | Click → `switchShellServer(id)`; hover → nameplate preview (dimmed, `→` prefix) without switching | Discussed — description §3 | S:95 R:85 A:90 D:95 |
| 5 | Certain | Drag reorder: siblings slide, live digit renumbering, exactly one `reorderShellHosts(id,toIndex)` per drop, click-without-move still switches, failure → toast + refetch; ⌥←/⌥→ on a focused square | Discussed — description §4; existing invoker and toast precedent | S:90 R:80 A:85 D:85 |
| 6 | Certain | Squares (and `+`) are no-drag islands, superseding the recorded one-island decision; rest of band (incl. nameplate) drags | Discussed — description §4 states the supersession explicitly | S:95 R:75 A:90 D:90 |
| 7 | Certain | Key-hint pill `⌥⌘` (darwin) / `Alt` (else): space always reserved (`visibility:hidden` at rest), visible on band hover; chord-held or pill-hover shows digits 1–9; zero layout shift at rest / hover / chord (hard requirement, test-covered) | Discussed — description §5 "hard requirement" | S:95 R:75 A:85 D:90 |
| 8 | Certain | Nameplate fields name · user@machine · OS + kind glyph · link · agents, folding right-to-left, name never folds; kind from origin (loopback 3100–3199 = tunnel, other loopback = local, else net); link tailscale/lan/ssh tunnel :port/local | Discussed — description §6; port range matches `PORTPOLICY_TUNNEL_START/END` | S:90 R:80 A:85 D:85 |
| 9 | Certain | Seven treatments (Glow default, Livery, Halftone, Hex mesh, Scanlines, Edge light, Flat) via `@property` `--ax`/`--dx`/`--acc`; motion Light slides (default) / Slide + sweep / Cut; reduced motion forces Cut; halo on textured treatments; reference CSS from the study | Discussed — description §7, study §9 row 3 "decided" | S:95 R:75 A:90 D:90 |
| 10 | Certain | Settings: Appearance gains "This app" group (between This host and This device, shell only) with Host strip effect (preview cards) and On switch (chips); stored as `strip.effect`/`strip.motion` in the shell's own store over optional bridge invokers + change broadcast; not localStorage, not config.yaml; older shell hides rows, defaults apply | Discussed — description §8, study §5 "This app" rationale | S:95 R:70 A:85 D:90 |
| 11 | Certain | Host colour stays host-owned only (`instance_color`, This host) — no per-device/per-app override; row presented as Host colour with spaced hues; in-shell used-hue labels with monogram + advisory warning | Discussed — description §9, study §9 row 5 "decided" | S:90 R:70 A:85 D:90 |
| 12 | Certain | In-shell the top-bar 6.5% wash and 2px stripe are not rendered; HOST-panel hostname tint unchanged | Discussed — description §10 (HOST panel not mentioned → unchanged) | S:85 R:85 A:85 D:85 |
| 13 | Confident | Existing host dropdown kept intact and re-anchored: opens from `+` (Add Host footer focused when an add path exists) or right-click on a square (that row focused); `Shift+F10`/`ContextMenu` on a focused square is the keyboard parity | Description: edit/remove/add "stay in the existing host menu, opened from the `+` square or a right-click"; focus targets inferred | S:70 R:80 A:70 D:60 |
| 14 | Confident | Background hosts' nameplate data via a new additive report channel (accent:set shape) joined into `servers:list` as optional `machine`/`os`/`agents` fields, held in memory on the view-registry entry (the `waiting` join precedent), not persisted to hosts.json | Description: "reporting to the shell like `accent:set` does → additive optional fields"; in-memory mirrors the waiting join; previews only need live views | S:70 R:75 A:70 D:60 |
| 15 | Tentative | Live updates via an additive main→renderer `servers:changed` broadcast (store mutations, badge/nameplate reports) triggering a `servers:list` refetch; older shells refetch on mount/focus/own mutation | Always-visible squares need fresh waiting dots/colours; polling is a code-quality anti-pattern; the open-time-only refetch no longer suffices | S:30 R:60 A:45 D:40 |
| 16 | Confident | Cross-view "light slides": the shell signals the newly attached view with the previous host id (e.g. an additive attach event `{previousId}` or projection field); the view sets `--ax` at that square without transition, then transitions to its own; absent signal → cut | Clarified — user confirmed | S:95 R:65 A:50 D:40 |
| 17 | Confident | Windows/Linux `titleBarOverlay` colour: in-shell, the single theme-color writer emits neutral `bgChrome` when `strip.effect` ≠ `flat` (overlay matches the neutral right end); Flat keeps `titlebarHex` | Clarified — user confirmed | S:95 R:60 A:55 D:45 |
| 18 | Tentative | "This view's host" (the self/active square) is resolved from the sender's own view, not the cosmetic store `activeId` (e.g. an additive `current?: boolean` in the projection, falling back to `active` on older shells) | `activeId` records the last-focused window's host; in multi-window it can differ from the host this view shows | S:30 R:60 A:50 D:50 |
| 19 | Confident | Agent count = number of windows whose rolled-up `agentState` is set (any agent present) across attached servers, derived from SSE in `lib/waiting.ts`; nameplate shows `N agents` | Clarified — user confirmed | S:95 R:70 A:35 D:30 |
| 20 | Confident | `user@machine` = `${sshUser}@${health.hostname}` (os hostname), not `${sshUser}@${location.hostname}` | Description says "the derived sshUser@hostname used for deeplinks", but on tunnels `location.hostname` is `127.0.0.1`; the study's data shows machine hostnames | S:45 R:85 A:60 D:50 |
| 21 | Confident | OS comes from a new additive `/api/health` `os` field (`runtime.GOOS`, displayed macOS/linux/windows); older daemons omit it and the field folds away | Health has no OS today; Constitution X — derived server-side, no config | S:40 R:80 A:65 D:55 |
| 22 | Confident | ⇧⌘H/⇧Ctrl+H moves to a new action (e.g. `host-strip-focus`, "Focus host squares", palette-registered); `host-menu-open` keeps its `Host: Switcher` palette entry and event seam with no default chord; focused squares: ←/→ roving, Home/End, Enter/Space switch, digits 1–9 switch, ⌥←/→ reorder, Escape or repeat ⇧⌘H releases | Clarified — user confirmed | S:95 R:60 A:40 D:35 |
| 23 | Confident | Strip prefs persist in a separate `<userData>/prefs.json` via an electron-free `app/desktop/src/prefs.ts` (atomic write, corrupt → defaults, node:test); tokens `glow/livery/halftone/hex/scan/edge/flat` and `slide/sweep/cut` | `windows.json`-is-a-separate-file precedent over a hosts.json schema change; study uses `none` for Cut — `cut` chosen to match the label | S:45 R:70 A:65 D:50 |
| 24 | Confident | Popout windows keep today's static centred title (no squares, no nameplate) and a flat band | No active square to light from; a switcher has no meaning in a window pinned to one surface (existing rationale) | S:35 R:85 A:65 D:55 |
| 25 | Certain | Host colour set = 9 hues: purple `1+4`, violet `4+5`, blue `4`, red `1`, green `2`, teal `6`, magenta `5`, slate `3+4`, amber `3` (amber kept); out-of-set stored values snap to nearest for display without rewriting; Clear kept (neutral outlined square, no light); HOST-panel picker narrows to the same set | User decided in discussion (2026-11-24 answers: "All 8, keep amber", "Snap to nearest", "Keep Clear", "Same set"; follow-up "Also add purple, violet") | S:95 R:70 A:90 D:95 |
| 26 | Tentative | "Hue already used" classification maps each other host's projected `accentColor` hex to its nearest owned family by OKLCH hue angle (low chroma → slate) rather than adding a descriptor field to the projection | Projection carries theme-derived hexes, not descriptors; avoids a new channel | S:30 R:75 A:45 D:30 |
| 27 | Confident | UI copy uses US spelling ("Host color") to match existing UI strings ("Set Color", "Clear color"); the study/description's "colour" is discussion spelling | Codebase UI copy convention | S:30 R:90 A:55 D:45 |
| 28 | Confident | No Tip on squares (the nameplate preview is the hover feedback; aria-label carries the name); the pill carries a `Tip` (not native `title=`) naming ⌥⌘1–9 and ⇧⌘H | Tip-not-title rule; avoids a tooltip covering the nameplate preview | S:40 R:90 A:60 D:50 |
| 29 | Confident | No-shift coverage lives in the shell e2e lane (`app/desktop/tests/e2e/`) measuring bounding boxes; pure helpers in vitest; prefs store in node:test; PR evidence = `just demo` shell-lane spec under `app/desktop/tests/demo/`, macOS-only parts exempt | jsdom has no layout; Constitution § PR Evidence and Test Intent Comments; description constraints | S:75 R:80 A:80 D:70 |
| 30 | Confident | Violet is added as an 11th owned hue family `{ name: "violet", hue: 270, legacy: "4+5" }` in `HUE_FAMILIES` (no existing family or shade is violet; purple is 290, blue 250), which also surfaces in the shared sidebar/server/window swatch grid; blue/violet/purple sit 20° apart, so the used-hue labelling matters more | Clarified — user confirmed after explanation (11th shared family; host and sidebar colours stay one system) | S:95 R:55 A:70 D:65 |

29 assumptions (12 certain, 9 confident, 7 tentative, 1 unresolved).
