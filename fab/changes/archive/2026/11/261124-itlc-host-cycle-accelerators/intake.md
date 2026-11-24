# Intake: Cycle hosts with ⌥⌘←/⌥⌘→ (Alt+PageUp/PageDown on Windows/Linux)

**Change**: 261124-itlc-host-cycle-accelerators
**Created**: 2026-11-24

## Origin

> Cycle hosts with ⌥⌘←/⌥⌘→ (Alt+PageUp/PageDown on Windows/Linux).

Conversational: the design was settled in a prior discussion, then handed to a promptless `/fab-proceed`-style dispatch (`{questioning-mode} = promptless-defer`). The user made these decisions in that discussion:

1. **Chords.** macOS: **⌥⌘←** = previous host, **⌥⌘→** = next host. Windows/Linux: **Alt+PageUp** = previous, **Alt+PageDown** = next. Order is the shell's host-list order, which is also the titlebar squares' order and the ⌥⌘1–9 / Alt+1–9 order. Cycling **wraps** at both ends (last → first, first → last), like Chrome's tab cycling.
2. **Mechanism.** Native Hosts-menu items, "Previous Host" and "Next Host", carry those accelerators. They live in the shell tier, the same as ⌥⌘1–9, and drive the existing `switchToHost` seam, so they work wherever focus is, terminals included. The items are present and enabled only when there are ≥2 hosts. menu.ts's exhaustive per-platform accelerator policy comment is updated to match.
3. **Why Alt+PageUp/PageDown on win/linux.** Three alternatives were rejected:
   - **Alt+←/→**: a menu accelerator takes the key from every page and terminal. Alt+←/→ is word-jump in shells, and it is also the focused-square reorder chord (⌥←/→).
   - **Ctrl+Alt+…**: on European layouts Ctrl+Alt is AltGr (menu.ts policy).
   - **macOS-only** (no win/linux chord): rejected.

   Alt+PageUp/PageDown stays in the Alt family of Alt+1–9, and shells don't use it. The mac reorder chord ⌥←/→ (no ⌘) is unchanged and does not conflict.
4. **Constitution V.** Add palette entries (e.g. `Host: Next` / `Host: Previous`), shell-gated like the existing `Host:` palette block, with the chord hints shown.
5. **Discoverability.** The key-hint pill's tip and the Settings → Shortcuts panel's shell switcher caps mention the new chords. The "three shapes" accelerator-knowledge note (menu.ts / settings-shortcuts-panel `switcherCaps` / shell-strip `hostAcceleratorHint`) must stay consistent.
6. **Motion.** Switching uses the existing attach signal, so the strip's light slides from the previous square, as it does for any other switch.
7. **Tests and evidence.**
   - node:test: the menu items and their accelerators per platform, plus the wrap-around order logic (a pure helper).
   - vitest: the palette entries and the pill tip / shortcuts caps.
   - PR evidence: this is a desktop-shell change, so it needs a `just demo` shell-lane recording (Linux: Alt+PageDown cycling). The macOS ⌥⌘ chord is exempt as macOS-only.

**Out of scope:** changing ⌥⌘1–9, the square reorder chord, or browser (non-shell) behaviour.

## Why

**Problem.** PR #1192 (merged, `7fb53092`) gave the desktop shell a titlebar row of host squares in host-list order. ⌥⌘1–9 (mac) / Alt+1–9 (win/linux) jump to the Nth host through native Hosts-menu radio accelerators in `app/desktop/src/menu.ts`. You can only jump to a host by its position. There is no relative step to the next or previous host. To step you have to know the target's index, and hosts past the ninth have no chord at all (`MAX_SWITCHER_ACCELERATORS = 9`). Two-stroke focus (⇧⌘H, then a digit or ←/→ + Enter) works, but it is a mode, not a chord.

**If we don't fix it.** Moving between neighbouring hosts, the common case with 2–4 hosts, means counting squares. Users with more than nine hosts can't reach the tail from the keyboard except through the palette / ⇧⌘H focus mode. Every comparable multi-target app (Chrome tabs, VS Code editors, terminal tabs) offers prev/next cycling, so its absence reads as a gap.

**Why this approach.**
- **Native menu accelerators** are the shell's only sanctioned key-stealing mechanism (menu.ts header: "Electron steals a key from the page only via menu accelerators… DO NOT bind accelerators on keys the page should own"). They are the one path that works no matter which webContents has focus: an xterm, a native web-tile guest, the welcome page.
- **The chosen keys sit outside every SPA chord tier**, so the shell takes nothing the page owns:
  - The registry rejects Alt in every tier except mac `optcmd`. `optcmd` is ⌥⌘ + key, and its only shipped default is ⌥⌘T `create-session`, so ⌥⌘←/→ is unbound in the SPA.
  - Win/linux plain Alt is unbindable in the registry.
- **They reuse the existing `switchToHost` seam.** It already handles the popout refusal, the `strip:attached` slide signal (`attachHostView` sends `{ previousId }`), `trackActiveId`, and `rebuildMenu`, so the new items inherit all of that behaviour.

## What Changes

### 1. Desktop — the pure cycle helper (new electron-free module, node:test covered)

Add a pure, electron-free helper, following the `local-daemon.ts` `daemonMenuModel` / `update-check.ts` `updateMenuItems` precedent of pure models that menu.ts renders. Proposed home: a new `app/desktop/src/host-cycle.ts` with a colocated `host-cycle.test.ts`. Electron-free is required: `menu.ts` imports `electron` and cannot run under plain `node --test`.

```ts
export type CycleDirection = 1 | -1; // 1 = next, -1 = previous

/**
 * The host to switch to when cycling from `currentId` in host-list order,
 * wrapping at both ends. null when fewer than 2 hosts (nothing to cycle to).
 * A currentId absent from the list (window showing the welcome page, or a
 * dangling id) starts from "before the first": next → first, previous → last.
 */
export function adjacentHostId(
  hostIds: readonly string[],
  currentId: string | null,
  direction: CycleDirection,
): string | null;
```

Required cases (node:test):

| hosts | current | dir | result |
|---|---|---|---|
| `[a,b,c]` | `a` | +1 | `b` |
| `[a,b,c]` | `c` | +1 | `a` (wrap) |
| `[a,b,c]` | `a` | −1 | `c` (wrap) |
| `[a,b,c]` | `b` | −1 | `a` |
| `[a,b]` | `a` | ±1 | `b` |
| `[a]` | `a` | ±1 | `null` |
| `[]` | `null` | ±1 | `null` |
| `[a,b,c]` | `null` / unknown | +1 | `a` |
| `[a,b,c]` | `null` / unknown | −1 | `c` |

The same module exports the per-platform menu-item model, so node:test can assert the accelerator strings without Electron:

```ts
export interface HostCycleMenuItem { label: "Previous Host" | "Next Host"; accelerator: string; direction: CycleDirection }

/** [] when hostCount < 2; otherwise Previous then Next. */
export function hostCycleMenuItems(isMac: boolean, hostCount: number): HostCycleMenuItem[];
// isMac:  { "Previous Host", "Alt+Cmd+Left",  -1 }, { "Next Host", "Alt+Cmd+Right", 1 }
// !isMac: { "Previous Host", "Alt+PageUp",    -1 }, { "Next Host", "Alt+PageDown",  1 }
```

Electron accelerator key names: `Left`/`Right` for the arrows and `PageUp`/`PageDown` for the paging keys. Electron also accepts `Option` as an alias of `Alt` on mac. The existing switcher uses `Alt+Cmd+${n}`, so the new strings keep the `Alt+Cmd+` spelling.

### 2. Desktop — `app/desktop/src/menu.ts` (Hosts menu)

- **`hostsMenu`** renders the model's items after the switcher radios. The proposed layout:

  ```
  Hosts
    ◉ host-a        ⌥⌘1
    ○ host-b        ⌥⌘2
    ─────────────
    Previous Host   ⌥⌘←
    Next Host       ⌥⌘→
    ─────────────
    Add Host…
    Remove "host-a"…
    Remove "host-b"…
  ```

  With <2 hosts the cycle group and its separator are **omitted** (the model returns `[]`). The existing `switcherItems.length > 0 ? [separator] : []` convention keeps the 0/1-host layout unchanged.
- **`MenuCallbacks`** gains `onCycleHost: (direction: CycleDirection) => void`. Each item's `click` calls `callbacks.onCycleHost(item.direction)`. Main resolves the target **at click time** rather than baking a target id into the menu at build time. That keeps the menu module free of view state (the `focusedWebContents()` precedent: "the menu module reads no view state"), and it is robust to the known dangling-`activeId` gap, where the radios can render unchecked until the next rebuild.
- **Header comment** (the exhaustive per-platform accelerator policy) is updated:
  - The shell-tier bullet's mac claim becomes "the Hosts switcher (1–9) and host cycling (←/→)". The win/linux claims add "Alt+PageUp/PageDown host cycling" next to the existing note on Alt+digits.
  - In the macOS bound list, append `Hosts cycle ⌥⌘← / ⌥⌘→ (Previous/Next Host — the same shell tier)` after the radios entry.
  - The Windows/Linux "Bound there (exhaustive)" line becomes "Alt+1–9 Hosts switcher, Alt+PageUp/Alt+PageDown host cycling, ⇧Ctrl+R force-reload, ⇧Ctrl+I devtools, F11 fullscreen".
  - Add a short "why Alt+PageUp/PageDown, not Alt+←/→" sentence. Alt+←/→ is word-jump in shells and the focused-square reorder chord (⌥←/→), and an accelerator steals the key from every page and terminal. Ctrl+Alt is AltGr. PageUp/PageDown under Alt is unused by shells and stays in the Alt+1–9 family.
  - The "Hardware-verify caveat" paragraph needs no change (it is about digits). Arrows and PageUp/PageDown are named keys, not character-resolved digits.
- No change to the radios, `MAX_SWITCHER_ACCELERATORS`, `Alt+Cmd+${n}` / `Alt+${n}`, Add/Remove, or any other menu.

### 3. Desktop — `app/desktop/src/main.ts` (`rebuildMenu` callbacks)

Add to the `callbacks` object in `rebuildMenu()`:

```ts
onCycleHost: (direction) => {
  const win = focusedWindow();
  if (!win) return;
  const list = loadHosts(userDataDir());
  const currentId = activeHostForWindow(views, win.id);
  const target = adjacentHostId(list.hosts.map((h) => h.id), currentId, direction);
  if (target) switchToHost(win, target);
},
```

- This goes through the ONE switch seam, `switchToHost(win, id)`. The popout refusal (`popouts.has(win.id)` → `{ ok: false, error: "Popout window" }`) applies unchanged: on a focused popout the chord silently does nothing, exactly like a radio click there.
- `attachHostView` already sends `strip:attached` with `{ previousId }` to the newly attached view. The strip's `onShellAttached` handler re-seats the band light at the previous square and slides it to the new one, so decision 6 (motion) needs **no new code**. A wrap (last → first) slides the light across the whole row, which is expected.
- `switchToHost` already calls `trackActiveId` (focused window) and `rebuildMenu`, so the radio check marks and the `servers:changed` strip refresh follow.

### 4. Frontend — palette entries `Host: Previous` / `Host: Next` (Constitution V)

- **Pure builder** in `app/frontend/src/lib/palette/shell.ts`, beside `buildShellServerActions`, with vitest in the colocated `shell.test.ts`:

  ```ts
  export function buildShellHostCycleActions(
    servers: ShellServer[],
    platform: BindingPlatform,           // "mac" | "other"
    onCycle: (direction: 1 | -1) => void,
  ): PaletteAction[];
  // [] when servers.length < 2; otherwise:
  // { id: "shell-host-prev", label: "Host: Previous", shortcut: mac ? "⌥⌘←" : "Alt+PgUp", onSelect: () => onCycle(-1) }
  // { id: "shell-host-next", label: "Host: Next",     shortcut: mac ? "⌥⌘→" : "Alt+PgDn", onSelect: () => onCycle(1) }
  ```

  The `shortcut` field is a **literal** hint. These chords are shell menu accelerators outside every registry tier, so `withShortcutHints` has no binding for these ids and passes the literal through unchanged. The ids MUST NOT collide with any `DEFAULT_BINDINGS` actionId.
- **SPA-side cycle math.** Add a pure `adjacentShellServer(servers, direction): ShellServer | null` (proposed home: `lib/shell-strip.ts`, next to `isSelfHost`, with vitest). It has the same wrap semantics as the desktop helper. "Current" is `isSelfHost(s)`: the asker-resolved `current` flag, falling back to `active` on older shells. With no current entry, next → first and previous → last. It returns null when there are <2 servers. This duplicates the desktop helper's ~10 lines across the main/renderer boundary on purpose (the "three shapes" rationale: `menu.ts` runs in Electron main and cannot import from the SPA bundle).
- **Wiring** in `app/frontend/src/hooks/use-global-palette-actions.ts`, inside or beside the existing `hostMenuActions` block (`Host: Focus Squares` / `Host: Switcher`). It is gated the same way, on the `useShellServers()` list, with the stricter `≥2` gate inside the builder. `onCycle` fetches a **fresh** list at select time (`listShellServers()`), computes the target with `adjacentShellServer`, and calls `switchShellServer(target.id)`. A failure toasts `"Host switch failed"`, matching `shellServerActions` in `app.tsx`. The fresh fetch matters because `useShellServers` is a mount-time snapshot and the SPA view stays alive across warm switches. Since #1192, squares can be reordered by drag or ⌥←/→, so the snapshot's order can go stale. Using a stale order would step to the wrong neighbour.
- Fold the new actions into the hook's returned list next to `...hostMenuActions`, and add the memo to the dependency array.

### 5. Frontend — key-hint pill tip (`app/frontend/src/lib/shell-strip.ts` `keyHintTip`)

Current:

```ts
platform === "darwin"
  ? "⌥⌘1–9 switches host · ⇧⌘H focuses the squares"
  : "Alt+1–9 switches host · ⇧Ctrl+H focuses the squares";
```

New (proposed copy):

```ts
platform === "darwin"
  ? "⌥⌘1–9 switches host · ⌥⌘←/→ cycles · ⇧⌘H focuses the squares"
  : "Alt+1–9 switches host · Alt+PgUp/PgDn cycles · ⇧Ctrl+H focuses the squares";
```

`key-hint-pill.tsx` itself needs no change, since it renders `keyHintTip(platform)`. `keyHintLabel` (`⌥⌘` / `Alt`) is unchanged: the cycle chords share the pill's modifiers. `isHintChord` is unchanged too, so holding the modifiers still reveals the digits. Update the existing vitest assertions for `keyHintTip`.

### 6. Frontend — Settings → Shortcuts shell rows (`settings-shortcuts-panel.tsx` `shellRows`)

Add two locked rows after "Switch to host 1–9". They are free-form caps arrays, the same idiom as `switcherCaps`:

```ts
const cycleCaps = (dir: "prev" | "next") =>
  displayPlatform === "mac"
    ? ["⌥", "⌘", dir === "prev" ? "←" : "→"]
    : ["Alt", dir === "prev" ? "PgUp" : "PgDn"];
rows: [
  { label: "Switch to host 1–9", description: "owned by the shell menu", parts: switcherCaps },
  { label: "Previous host", description: "owned by the shell menu", parts: cycleCaps("prev") },
  { label: "Next host",     description: "owned by the shell menu", parts: cycleCaps("next") },
  { label: "Force reload", ... },
  ...
]
```

The label filter (`r.label.toLowerCase().includes(trimmedQuery)`) and the GLOBAL jump-chip count (`shellRows.length`) pick the rows up automatically. Add vitest for both displays (mac caps `⌥ ⌘ ←` / `⌥ ⌘ →`; other caps `Alt PgUp` / `Alt PgDn`).

### 7. Frontend — `app/frontend/src/lib/keybindings.ts` (documentation and claims)

- Update the header comment's list of shell ⌥⌘ accelerators that an `optcmd` binding must avoid: "(⌥⌘H hide-others, ⌥⌘I devtools, ⌥⌘1–9, ⌥⌘←/→ host cycling)". Do the same for the `claimedKeys` doc comment, which says both Hosts switchers live outside every tier, so it also mentions mac ⌥⌘←/→ and win/linux Alt+PageUp/PageDown.
- **Capture-warning claims (proposed).** `captureFromEvent` accepts ⌥⌘ + any key on mac, arrows included, as the `optcmd` tier. A user could therefore rebind an SPA action onto ⌥⌘←/→, and the shell menu would then silently steal it. Add two `owner: "shell"`, `tier: "optcmd"`, `platform: "mac"` claims (`ArrowLeft` "prev host", `ArrowRight` "next host") to the shell-host branch of `claimedKeys` (shell only: a mac browser does not bind them). The overlay then renders them claimed, and a capture onto them warns. Win/linux Alt+PageUp/PageDown needs no claim rows, because Alt is uncapturable there.

### 8. PR evidence — shell demo

- Add a new shell-lane demo spec under `app/desktop/tests/demo/` (e.g. `host-cycle-accelerators.demo.ts`). Its file header and per-`test()` JSDoc follow the Test Intent Comments constitution rule.
- The demo registers ≥3 hosts, cycles forward with Alt+PageDown through the wrap (last → first), and cycles back with Alt+PageUp. The squares' ring and the sliding light are visible.
- Record it with `just demo host-cycle-accelerators` (Linux/Xvfb), with `--before` for the base comparison, where the chord does nothing.
- The PR body states `No recording: macOS-only shell behavior not recordable by just demo` for the ⌥⌘←/→ half and documents the verification performed (node:test accelerator strings + the shared seam).
- **Risk:** Playwright's `keyboard.press` dispatches through CDP into the renderer. That may bypass native menu-accelerator matching on Linux. If it does, the demo must inject a real X key event into the Xvfb display (e.g. `xdotool key alt+Next`, if available on the rig) so the recording proves the accelerator rather than a synthetic click.

## Affected Memory

- `run-kit/desktop-shell`: (modify)
  - § Keyboard-Tier Menu Seam: add host cycling to the shell-tier claims bullet; add the Hosts row's Previous/Next Host items (⌥⌘←/⌥⌘→) to the macOS table; add Alt+PageUp/PageDown to the Windows/Linux exhaustive bound set; extend the `MenuCallbacks` list with `onCycleHost`.
  - Package Shape: list the new electron-free `host-cycle.ts`.
  - The "Two renderer-side copies mirror these bindings" paragraph: extend it to the cycle chords.
  - A new Design Decision: "Host cycling is Alt+PageUp/PageDown on win/linux, not Alt+←/→", with the rejected alternatives from Origin.
- `run-kit/ui/top-bar`: (modify)
  - § Desktop-Shell Titlebar Strip: the key-hint pill's tip now names the cycle chords.
  - DD "Host-switcher accelerator knowledge lives in three shapes": extend it to cover the cycle chords (menu.ts `hostCycleMenuItems` / `switcherCaps`-sibling `cycleCaps` / `keyHintTip` + the palette literal hints) and the duplicated wrap math (`adjacentHostId` desktop ↔ `adjacentShellServer` SPA).
- `run-kit/ui/keyboard-and-palette`: (modify)
  - § Command Palette Actions: `Host: Previous` / `Host: Next` (ids `shell-host-prev` / `shell-host-next`, literal chord hints, ≥2-host gate, fresh-list select-time resolution).
  - § Shortcuts panel: the two new shell-owned locked rows.
  - § Claimed keys: the mac `optcmd` ⌥⌘←/→ shell claims.

## Impact

- **Desktop (Electron main)**: `app/desktop/src/menu.ts` (hostsMenu items, `MenuCallbacks.onCycleHost`, header policy comment); `app/desktop/src/main.ts` (`rebuildMenu` callback); new `app/desktop/src/host-cycle.ts` + `host-cycle.test.ts` (node:test, compiled to `dist/**/*.test.js`). No preload/bridge change and no new IPC channel. The SPA reuses the existing `servers:list` / `servers:switch` bridge, so there is no version-skew surface.
- **Frontend (SPA)**: `lib/palette/shell.ts` (+ test), `lib/shell-strip.ts` (`keyHintTip`, `adjacentShellServer`, + tests), `hooks/use-global-palette-actions.ts`, `components/settings-shortcuts-panel.tsx` (+ test), `lib/keybindings.ts` (comments + two mac-shell `optcmd` claims, + test).
- **Keys taken from the page inside the shell**:
  - **mac ⌥⌘←/⌥⌘→.** No SPA registry binding uses them, and they are not text-editing keys in macOS inputs: ⌥← is word and ⌘← is line, but ⌥⌘← is unassigned. **Known consequence**: VS Code's default *View: Open Previous/Next Editor* is ⌥⌘←/⌥⌘→ on macOS, so inside the shell's code tile (code-server) those two chords switch hosts instead of editor tabs. VS Code's other editor-cycling bindings and its own palette remain. Chrome-style ⌥⌘←/→ tab cycling inside native web-tile guests is also shadowed. That is the same semantics, applied one level up.
  - **win/linux Alt+PageUp/Alt+PageDown.** Unused by shells, xterm.js and tmux defaults. Applications that map Alt+PageUp/PageDown (rare; some editors scroll by page) lose them inside the shell.
- **Tests**: node:test (desktop pure helper + menu model), vitest (palette builder, `adjacentShellServer`, `keyHintTip`, shortcuts panel rows, claims). Run through `just test` / `just test-frontend`; desktop tests through the desktop package's `node --test` over `dist`.
- **Evidence**: one new shell demo spec plus the macOS-only exemption statement (Constitution § PR Evidence).

## Open Questions

- The palette shortcut strings and pill-tip copy on win/linux: `Alt+PgUp`/`Alt+PgDn` (compact keycap spelling, chosen) vs `Alt+PageUp`/`Alt+PageDown`. Both are cosmetic and easy to change.
- Does Playwright's CDP keyboard dispatch trigger Electron native menu accelerators on Linux/Xvfb? Apply must determine this when writing the demo. See What Changes § 8.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | mac ⌥⌘← = previous host, ⌥⌘→ = next host; win/linux Alt+PageUp = previous, Alt+PageDown = next | Discussed — user decided the exact chords per platform | S:95 R:80 A:95 D:95 |
| 2 | Certain | Order = shell host-list order (= squares = ⌥⌘1–9 order); cycling wraps at both ends | Discussed — user decided, Chrome tab-cycling semantics | S:95 R:85 A:90 D:95 |
| 3 | Certain | Implemented as native Hosts-menu items "Previous Host"/"Next Host" with accelerators, driving the existing `switchToHost` seam (works under any focus, incl. terminals) | Discussed — user decided the shell-tier mechanism; menu.ts policy names accelerators as the only sanctioned key-steal path | S:95 R:75 A:90 D:90 |
| 4 | Certain | Alt+←/→, Ctrl+Alt, and macOS-only rejected for win/linux; rationale recorded in intake + menu.ts comment + memory DD | Discussed — user decided with the stated rationale | S:95 R:85 A:90 D:95 |
| 5 | Certain | Palette entries `Host: Previous` / `Host: Next`, shell-gated like the existing `Host:` block, chord hints shown | Discussed — user decided (Constitution V parity) | S:90 R:85 A:90 D:85 |
| 6 | Certain | Pill tip + Settings → Shortcuts shell rows mention the new chords; the "three shapes" note stays consistent | Discussed — user decided discoverability surfaces | S:90 R:90 A:90 D:85 |
| 7 | Certain | Strip light-slide motion comes free from `attachHostView`'s existing `strip:attached { previousId }` signal — no new motion code | Discussed — user decided; verified in main.ts (`strip:attached` send) and titlebar-strip.tsx (`onShellAttached`) | S:90 R:90 A:95 D:95 |
| 8 | Certain | Tests: node:test for menu items/accelerators per platform + wrap logic; vitest for palette entries and pill tip / shortcuts caps; `just demo` shell-lane recording on Linux, macOS ⌥⌘ chord exempt | Discussed — user decided; matches Constitution § PR Evidence and code-quality test strategy | S:90 R:85 A:95 D:90 |
| 9 | Confident | The wrap logic and per-platform menu-item model live in a new electron-free `app/desktop/src/host-cycle.ts`, because menu.ts imports electron and can't run under `node --test` | Follows the `daemonMenuModel` / `updateMenuItems` pure-model precedent and the desktop's electron-free-module discipline; the file name is easy to change | S:70 R:85 A:80 D:70 |
| 10 | Confident | With <2 hosts the cycle items and their separator are omitted, not rendered disabled | User said "present/enabled only with ≥2 hosts"; omission matches the existing `switcherItems.length > 0` separator convention; trivially reversible | S:65 R:90 A:70 D:60 |
| 11 | Confident | Menu click resolves the target at click time in main via a new `onCycleHost(direction)` callback, using the focused window's attached host (`activeHostForWindow`), rather than baking target ids into the menu | Keeps menu.ts free of view state (the `focusedWebContents` precedent) and immune to the dangling-`activeId` stale-radio gap | S:60 R:85 A:80 D:70 |
| 12 | Confident | A window with no attached host (welcome page) cycles from "before the first": next → first host, previous → last host | Natural extension of wrap semantics; avoids a dead chord on the welcome page; cheap to change | S:50 R:90 A:65 D:60 |
| 13 | Certain | Focused popout window: the chord silently does nothing (switchToHost's existing popout refusal), same as a radio click | Reuses the one switch seam unchanged; popouts are pinned to their host by design | S:60 R:90 A:85 D:80 |
| 14 | Confident | Palette cycle computes the target SPA-side from a fresh `listShellServers()` at select time + `switchShellServer`, with a duplicated pure `adjacentShellServer` helper; no new IPC channel | Avoids bridge version skew (SPA and shell ship separately); the fresh fetch dodges `useShellServers`' mount-time snapshot going stale after square reorders; duplication across main/renderer follows the "three shapes" DD | S:60 R:80 A:75 D:65 |
| 15 | Confident | Palette action ids `shell-host-prev` / `shell-host-next` with literal `shortcut` hints (`⌥⌘←`/`⌥⌘→`, `Alt+PgUp`/`Alt+PgDn`), wired in `use-global-palette-actions.ts` beside `hostMenuActions` (layout-global) | Registry can't represent the chords (Alt is no tier), so `withShortcutHints` passes the literal through; the global hook is where the existing `Host:` block lives | S:65 R:90 A:75 D:65 |
| 16 | Confident | Settings → Shortcuts gets two separate locked rows ("Previous host", "Next host") rather than one combined row | Mirrors the registry's separate prev/next rows (session-prev/next, window-prev/next); free-form caps arrays need no tier machinery | S:55 R:95 A:75 D:60 |
| 17 | Confident | Accept that mac ⌥⌘←/→ shadows VS Code's Open Previous/Next Editor inside the code tile (and Chrome-style tab cycling in web guests); recorded as a known consequence, not a blocker | User explicitly chose ⌥⌘←/→ by Chrome analogy; reversible by changing two accelerator strings | S:60 R:85 A:45 D:60 |
| 18 | Confident | Add mac-shell `optcmd` claimed-key rows for ⌥⌘←/⌥⌘→ in `claimedKeys` so rebind capture warns; win/linux needs none | `captureFromEvent` admits ⌥⌘+arrow as optcmd, and the desktop-shell rule says mirrors update in the same change — but ⌥⌘H/I/1–9 carry no optcmd claim rows today, so this extends rather than follows precedent | S:40 R:85 A:50 D:45 |
| 19 | Confident | Demo drives Alt+PageDown via Playwright keyboard; if CDP-dispatched keys don't reach native menu accelerators on Linux/Xvfb, fall back to an X-level key injection (e.g. xdotool) | No precedent: the #1192 demo switched hosts by click; behaviour of CDP keys vs Electron menu accelerators must be verified at apply | S:40 R:80 A:40 D:50 |

19 assumptions (9 certain, 10 confident, 0 tentative, 0 unresolved).
