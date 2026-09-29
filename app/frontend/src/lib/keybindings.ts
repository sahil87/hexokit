/**
 * Declarative keyboard-binding registry (260730-g40a).
 *
 * One module owns every app chord as DATA: the run-kit action tier
 * (`Shift+CmdOrCtrl+<key>` on Windows/Linux; on macOS several actions demote
 * to the unshifted ⌘ tier — see `macTier`/`defaultComboFor`, 260730-n789),
 * the migrated legacy chords (⌘K palette, board ⌘[/⌘] pane cycle — combos
 * unchanged), the
 * claimed-key map (shell menu accelerators, OS keys, browser-reserved keys —
 * per tier), the per-device override layer
 * (`localStorage["hexokit-keybindings"]`, diffs
 * only), conflict detection, chord capture, and per-platform formatting.
 *
 * Everything here is pure and DOM-light (the localStorage read/write are thin
 * try/catch wrappers; `shouldSuppressChord` inspects an event target) — the
 * same pure-helper + colocated-unit-test pattern as `window-view.ts` /
 * `palette-*.ts`. React integration lives in `hooks/use-keybindings.ts`
 * (reactive store) and `hooks/use-keybinding-dispatch.ts` (the one window
 * -level keydown listener per route shell).
 *
 * Matching is on `KeyboardEvent.code` — layout-independent, and it sidesteps
 * the shifted-accelerator character-resolution flakiness the desktop shell
 * docs flag (`app/desktop/src/menu.ts`). Alt chords are never matched: Alt is
 * not part of any tier (macOS uses it for character composition) — which is
 * also why the mac desktop shell parks its Hosts-switcher accelerators on
 * ⌥⌘1–9 (260731-nv5r): territory this registry can never claim.
 */

import type { ViewName } from "./window-view";

/**
 * The three chord tiers:
 * - `shifted` — `Shift+CmdOrCtrl` (the run-kit action tier; uniform per intake
 *   decision (B): letter consistency over chord weight).
 * - `cmd` — unshifted `CmdOrCtrl` (legacy punctuation chords: ⌘K ⌘; ⌘[⌘]).
 *   Matches Meta OR Ctrl, preserving each legacy listener's exact predicate.
 * - `ctrl` — plain Ctrl on BOTH platforms. Shipped defaults: `focus-hop`
 *   (mac only, via `macTier` — plain Ctrl belongs to the pane on Win/Linux,
 *   so the base tier there is shifted) and the gui-zoom trio (every platform:
 *   ⌘=/⌘-/⌘0 are the browser's zoom chords on mac, and the `guiOnly` gate
 *   keeps plain Ctrl with the pane under terminal focus); the tier otherwise
 *   keeps a mac chord capture reading plain Ctrl distinct from ⌘ (macOS
 *   window/system territory the page must not claim).
 */
export type BindingTier = "shifted" | "cmd" | "ctrl";

/** Where a binding applies. Descriptive (overlay badges + conflict scoping);
 *  actual applicability is handler presence at each dispatcher mount. The
 *  `sidebar` value is schema-reserved (no v1 binding uses it). */
export type BindingScope = "global" | "terminal" | "board" | "sidebar";

/** `builtin` = the shipped registry actions; `macro` = user-defined macro
 *  bindings over riff presets / palette actions (260730-hbyh — model in
 *  `lib/macros.ts`, executor in `app.tsx`). */
export type BindingKind = "builtin" | "macro";

/** Keycap rendering platform. `other` = Windows/Linux. */
export type BindingPlatform = "mac" | "other";

/** Host facts the resolver needs: keycap platform + desktop-shell presence. */
export type BindingHost = { platform: BindingPlatform; shell: boolean };

/** A concrete chord: layout-independent key code + modifier tier. */
export type BindingCombo = { code: string; tier: BindingTier };

export type KeyBinding = {
  /** Stable id; doubles as the palette action id where one exists. */
  actionId: string;
  /** `KeyboardEvent.code` — layout-independent ("KeyN", "BracketLeft"). */
  code: string;
  /** Base (Windows/Linux) default tier. */
  tier: BindingTier;
  /** macOS default-tier refinement (260730-n789): the tier this binding's
   *  DEFAULT combo uses on mac hosts (the key code stays constant unless a
   *  `macCode` refinement accompanies it). Absent = the base tier everywhere.
   *  Only the DEFAULT is refined — the stored override shape
   *  `{ code, tier } | null` is untouched (overrides are per-device, so
   *  per-platform is inherent). */
  macTier?: BindingTier;
  /** macOS default-CODE refinement (260807-rbx5): the key code this binding's
   *  DEFAULT combo uses on mac hosts, replacing `code`. The deliberate
   *  exception to 260730-n789's letters-constant rule, for chords whose mac
   *  convention has no legal cross-platform letter: the split pair wants
   *  iTerm2's ⌘D/⇧⌘D on mac, but both rows on `KeyD` would collide on the
   *  Win/Linux shifted tier and plain Ctrl+D is the pane's EOF — so Win/Linux
   *  keeps its own divider-mnemonic codes and mac refines to `KeyD`. An empty
   *  string refines to a KEYLESS mac default (palette-only on mac —
   *  create-session). Composes
   *  with `macTier`; only the DEFAULT is refined, same as `macTier`. */
  macCode?: string;
  scope: BindingScope;
  kind: BindingKind;
  /** Human label for overlay rows + tier-map keycaps. */
  label: string;
  /** Optional overlay row description. */
  description?: string;
  /** Short tier-map keycap annotation (defaults to nothing rendered). */
  mapLabel?: string;
  /** Fire even when a real text input has focus — the punch-through class:
   *  chrome toggles and navigation chords (modifier combos that never insert
   *  text), plus ⌘K's historical everywhere-behavior (Constitution V primary
   *  discovery). Every other binding goes through `shouldSuppressChord`. */
  ignoreInputs?: boolean;
  /** This chord targets the tmux pane; only meaningful when the tty tile owns
   *  focus (260812-wfic). Gate sites (the app.tsx dispatcher handler map, the
   *  code-iframe reclaim predicate) consult this DATA flag rather than
   *  hardcoding actionId lists: a `ttyOnly` binding's handler is treated as
   *  absent when the focused tile is not tty, and the reclaim predicate never
   *  intercepts a keydown whose only matches are `ttyOnly` (a keydown inside
   *  the code-server iframe means the code tile owns focus). */
  ttyOnly?: boolean;
  /** The `ttyOnly` mirror for the web tile (260819-ie2i): this chord is only
   *  meaningful when the web tile owns focus. The dispatcher handler map
   *  treats a `webOnly` binding's handler as absent unless the focused tile is
   *  web, and the reclaim predicate intercepts it only when the keydown
   *  arrived inside a WEB lens iframe — inside the code iframe ⌘F stays with
   *  code-server's own find. */
  webOnly?: boolean;
  /** The `webOnly` mirror for the gui tile: this chord is only meaningful
   *  when the gui tile owns focus. The dispatcher handler map treats a
   *  `guiOnly` binding's handler as absent unless the focused tile is gui,
   *  the reclaim predicate intercepts it only for kind `"gui"`, and the
   *  terminal seam never refuses it — plain Ctrl+=/−/0 belong to the pane
   *  under terminal focus on every platform. */
  guiOnly?: boolean;
  /** This binding fires ANOTHER action's handler — the named `actionId` — so
   *  one action can answer to a second chord. The dispatcher resolves the
   *  handler through this; nothing is registered under the alias's own id.
   *  Needed because `actionId` doubles as the palette action id, so a
   *  free-standing second id would be a phantom action. An alias keeps its
   *  own override slot (independently rebindable) and never conflicts with
   *  the action it aliases. */
  aliasOf?: string;
};

/** A resolved binding after the override layer + host reservations applied. */
export type EffectiveBinding = KeyBinding & {
  /** False when user-disabled (override `null`) or browser-reserved. */
  enabled: boolean;
  /** True when the effective combo equals the shipped default. */
  isDefault: boolean;
  disabledReason?: "user" | "reserved";
};

/** Override diff: combo replacement, or `null` = disabled/unbound. */
export type BindingOverride = BindingCombo | null;
/** The persisted shape: diffs only, keyed by actionId. */
export type BindingOverrides = Record<string, BindingOverride>;

export const KEYBINDINGS_STORAGE_KEY = "hexokit-keybindings";

/**
 * The default registry. Order is display order within each overlay group.
 *
 * Shifted tier — the starter actions (canonical letters):
 * N/T/W new-session/new-tab/close-tab (plus the keyless-base mac-only trio
 * new/close-app-window and reopen-window), ↑/↓ prev/next tab and ←/→ prev/next session,
 * [/] back/forward, A next-waiting-agent, / the cheatsheet — joined by E
 * compose-strip
 * toggle and O open-last-used (260801-sm6g), , settings (260801-mqim), and the
 * split pair (260807-rbx5: \/− on Win/Linux, ⌘D/⇧⌘D on mac via `macCode`).
 * Global scope (O and the split pair are terminal-scoped): dispatch mounts
 * decide per-route applicability by handler presence.
 *
 * macOS demotions (260730-n789 — letters constant, modifier varies; the split
 * pair's, compose-toggle's, and the keyless-base trio's `macCode`s are the
 * deliberate code exceptions):
 * [/]// and the VS Code-aligned ⌘B sidebar keycap default to the unshifted ⌘
 * tier on every mac host (interceptable in browsers — ⌘B bold is
 * the same class as the shipped ⌘[/⌘]/⌘/ and ⌘D interceptions, not
 * reserved like ⌘N/T/W); the window-cycle arrows (⌘↑/⌘↓), the positional
 * surface digits (⌘1 tty / ⌘2 code / ⌘3 web / ⌘4 gui / ⌘5 changes), and ⌘I compose demote the same
 * way. T/W and , demote on every mac host, and the tab-model letters also
 * refine their CODES (`macCode`): reopen-window rides ⇧⌘T, the two
 * keyless-base app-window actions spend ⌘N/⇧⌘W, and settings rides ⌘,.
 * create-session refines the other way — a KEYLESS mac code (`macCode: ""`),
 * palette-only on every mac host. One canonical
 * chord per action — in a mac browser the canonical combos are
 * browser-reserved (claims data below), so they resolve disabled there
 * and stay palette-only. A stays
 * shifted everywhere (⌘A is select-all/Edit-role — immovable), the session
 * pair stays shifted via its `macCode` (⇧⌘↑/⇧⌘↓ — tier-disjoint from the
 * window pair's ⌘↑/⌘↓), and the hosts chord stays shifted on H (cmd-tier ⌘H
 * is macOS Hide). Win/Linux is unchanged (plain Ctrl
 * belongs to the pane — so `focus-hop`'s ⌃` is mac-only and its base tier is
 * shifted, the first shipped `ctrl`-tier default).
 *
 * Legacy migrations (combos unchanged — established, browser-safe
 * punctuation): ⌘K palette (ignoreInputs preserves its fire-everywhere
 * behavior), board ⌘[/⌘].
 *
 * `KeyP` is deliberately unbound on EVERY tier — reserved for a future
 * create/open-PR action (the Conductor ⇧⌘P convention). Do not spend it.
 * `Period` (⌘. / Ctrl+.) is likewise deliberately unbound on EVERY tier: ⌘.
 * is the macOS Cancel/Stop chord (dialog Cancel, Safari/Xcode Stop) and is
 * reflex-hit, so anything bound to it fires by accident — the lens cycle that
 * once lived there kept landing users in the Chat lens. `settings-open` stays
 * on the OS-conventional ⌘, and must not migrate here. Do not spend it.
 * The ⇧⌘digit layer is likewise reserved on mac for future positional tile
 * jumps (the ⇧⌘P precedent) — partial there: ⇧⌘3/4/5 stay macOS system
 * screenshot claims (MAC_SCREENSHOT_CLAIMS below).
 */
export const DEFAULT_BINDINGS: readonly KeyBinding[] = [
  // — run-kit shifted tier (global) —
  // The mac N/T/W map follows the universal tab-model convention
  // (Chrome/Safari/iTerm2): ⌘T new tab (create-window, unchanged), ⇧⌘T
  // reopen closed tab (reopen-window's `macCode` — the split-pair precedent:
  // tier-disjoint from create-window on one code), ⌘W close tab (kill-window,
  // unchanged), with the app-window pair beside them (⌘N new / ⇧⌘W close —
  // the two keyless-base bridge actions below). create-session spends NO mac
  // chord: its mac-keyless refinement keeps it palette-only on both mac
  // hosts, so ⇧⌘N (a chord no other mac host gives this app) never fires.
  // Win/Linux keeps ⇧Ctrl+N/T/W untouched (plain Ctrl belongs to the pane).
  { actionId: "create-session", code: "KeyN", tier: "shifted", macCode: "", scope: "global", kind: "builtin", label: "New session", description: "a new group of tabs", mapLabel: "new session" },
  { actionId: "create-window", code: "KeyT", tier: "shifted", macTier: "cmd", scope: "global", kind: "builtin", label: "New tab", description: "in the current session", mapLabel: "new tab" },
  { actionId: "kill-window", code: "KeyW", tier: "shifted", macTier: "cmd", scope: "global", kind: "builtin", label: "Close tab", description: "confirm flow", mapLabel: "close tab" },
  // ⇧⌘T reopen closed tab — the universal browser/VS Code/iTerm2 reflex.
  // Keyless base (the app-window pair precedent): no Win/Linux shifted-tier
  // chord is free (T is create-window, N is create-session), so it stays
  // palette-only there. In a mac BROWSER the shifted KeyT is browser-owned
  // (the "reopen tab" claim already in claimedKeys) and resolves reserved —
  // palette-only there too, exactly like create-window's ⌘T.
  { actionId: "reopen-window", code: "", tier: "shifted", macCode: "KeyT", scope: "global", kind: "builtin", label: "Reopen closed tab", description: "fresh shell — same session, name, folder, layout and web tabs", mapLabel: "reopen tab" },
  // The app-window pair (260820-lfla) — SPA bindings over the shell's
  // `shell:new-window` / `shell:close-window` bridge channels, NEVER shell
  // menu accelerators (menu.ts's unshifted-⌘ fall-through rule is
  // inviolable; both menu items stay accelerator-less). Keyless base (the
  // macro precedent): unbound on Win/Linux (New Window stays menu-only
  // there); on mac the `macCode` refinement spends the canonical ⌘N/⇧⌘W,
  // which resolves browser-reserved in a mac browser (the handler is
  // bridge-gated absent everywhere outside the shell).
  { actionId: "new-app-window", code: "", tier: "shifted", macCode: "KeyN", macTier: "cmd", scope: "global", kind: "builtin", label: "New app window", description: "duplicate this desktop window", mapLabel: "new app" },
  { actionId: "close-app-window", code: "", tier: "shifted", macCode: "KeyW", scope: "global", kind: "builtin", label: "Close app window", description: "close this desktop window", mapLabel: "close app" },
  // ⇧Ctrl+E compose base / ⌘I mac refinement (macCode + macTier — the
  // split-pair precedent, one host gate refining code and tier together). E
  // stays the win/linux keycap: C is the terminal-copy claim, T is
  // create-window, I is the devtools claim. Unshifted ⌘E is browser "use
  // selection for find" territory on mac, so the demotion rides a different
  // letter. ignoreInputs lets the chord CLOSE the strip while its own
  // textarea has focus.
  { actionId: "compose-toggle", code: "KeyE", tier: "shifted", macCode: "KeyI", macTier: "cmd", scope: "global", kind: "builtin", label: "Compose", description: "toggle the compose strip", mapLabel: "compose", ignoreInputs: true },
  // ⇧⌘O open-last-used (260801-sm6g): re-runs the Open split-button's primary
  // (last-used) target. Terminal scope — the Open control is
  // terminal-route-only; the board/server routes mount no handler.
  { actionId: "open-last-used", code: "KeyO", tier: "shifted", scope: "terminal", kind: "builtin", label: "Open in last-used app", description: "re-run the last Open target", mapLabel: "open" },
  // Split pane (260807-rbx5) — per-platform pairs, reusing the
  // `Tab: Split Horizontal|Vertical` palette bodies. Direction semantics
  // follow the top-bar chip (260806-2x2h): horizontal = side-by-side
  // (tmux `-h`), the primary/default split. Terminal scope (the layout-cycle
  // precedent — the palette bodies exist only on window routes).
  //
  // Mac refines both rows to `KeyD` (`macCode`) for the iTerm2/Warp/Ghostty
  // pair: ⌘D side-by-side (`macTier` demotion — browser bookmark is
  // page-interceptable like the demoted ⌘[/⌘]/⌘/, so no
  // browser-owner claim) and ⇧⌘D stacked. The pair is tier-disjoint on one
  // code, so `findConflicts` stays clean.
  //
  // Win/Linux cannot host that pair — plain Ctrl+D is the pane's EOF and two
  // rows cannot share ⇧Ctrl+D (equal scope → `findConflicts`, a test-enforced
  // invariant) — so it keeps keycap-as-divider mnemonics instead: ⇧Ctrl+\
  // (shift+\ types `|`, the divider a side-by-side split creates) and ⇧Ctrl+-
  // (the stacked divider). Both bound on every host; both rebindable.
  { actionId: "split-horizontal", code: "Backslash", tier: "shifted", macCode: "KeyD", macTier: "cmd", scope: "terminal", kind: "builtin", label: "Split horizontal", description: "split the pane side-by-side", mapLabel: "split h", ttyOnly: true },
  { actionId: "split-vertical", code: "Minus", tier: "shifted", macCode: "KeyD", scope: "terminal", kind: "builtin", label: "Split vertical", description: "split the pane stacked", mapLabel: "split v", ttyOnly: true },
  // Arrow-key navigation — the sidebar's vertical stacking encoded spatially:
  // ↑/↓ step one window across ALL sessions (the cross-session flatten,
  // lib/window-cycle.ts), ←/→ hop a whole session. The window pair demotes to
  // ⌘↑/⌘↓ on mac via `macTier` — ⌘↑/⌘↓ is the mac browser's page-interceptable
  // scroll-to-top/bottom (the ⌘D/⌘[ accelerator class), so no
  // browser-owner claim row. The session pair rides the
  // `macCode`-stays-shifted refinement (⇧⌘↑/⇧⌘↓ — tier-disjoint from the
  // window pair on the same codes, the split-pair precedent): mac's coarse
  // hop needs the axis the cmd-tier window pair leaves free. Win/Linux splits
  // by AXIS instead — plain Ctrl belongs to the pane, so both pairs live on
  // the shifted tier there and sessions take the horizontal codes. The
  // mapLabels are carried for parity but unrendered: arrow codes have no
  // keycap cell in the panel's KEY_ROWS grids (the Comma/Backquote no-cell
  // precedent). All six navigation rows (the two arrow pairs and the ⌘[/⌘]
  // history pair below) carry ignoreInputs: the desktop restore router lands
  // first-visit focus in the compose strip's textarea, so a navigation
  // chord's natural NEXT press targets a TEXTAREA — without the flag the walk
  // would die after one step. Navigation chords have no editing meaning worth
  // preserving inside a compose draft (⌘↑/⌘↓ caret-to-document-edge is the one
  // native motion lost there — the same trade xterm's carve-out already makes).
  { actionId: "window-prev", code: "ArrowUp", tier: "shifted", macTier: "cmd", scope: "global", kind: "builtin", label: "Previous tab", mapLabel: "prev tab", ignoreInputs: true },
  { actionId: "window-next", code: "ArrowDown", tier: "shifted", macTier: "cmd", scope: "global", kind: "builtin", label: "Next tab", mapLabel: "next tab", ignoreInputs: true },
  { actionId: "session-prev", code: "ArrowLeft", tier: "shifted", macCode: "ArrowUp", scope: "global", kind: "builtin", label: "Previous session", description: "jump to the adjacent session's active window", mapLabel: "prev session", ignoreInputs: true },
  { actionId: "session-next", code: "ArrowRight", tier: "shifted", macCode: "ArrowDown", scope: "global", kind: "builtin", label: "Next session", description: "jump to the adjacent session's active window", mapLabel: "next session", ignoreInputs: true },
  { actionId: "go-back", code: "BracketLeft", tier: "shifted", macTier: "cmd", scope: "global", kind: "builtin", label: "Back", description: "history", mapLabel: "back", ignoreInputs: true },
  { actionId: "go-forward", code: "BracketRight", tier: "shifted", macTier: "cmd", scope: "global", kind: "builtin", label: "Forward", description: "history", mapLabel: "fwd", ignoreInputs: true },
  { actionId: "agent-next-waiting", code: "KeyA", tier: "shifted", scope: "global", kind: "builtin", label: "Next waiting agent", description: "jump to an agent blocked on input", mapLabel: "agent" },
  // ⇧⌘H/⇧Ctrl+H host switcher — opens the shell titlebar strip's hosts menu
  // (plain digits select a host while it is open). NO mac demotion: the
  // cmd-tier ⌘H is the shell's hide accelerator and the mac-browser system
  // hide claim, so the shifted tier is the chord everywhere. Global scope, but
  // the handler is component-local to ShellTitlebarStrip (shell-only mount), so
  // in a browser host the chord resolves to no handler and falls through.
  { actionId: "host-menu-open", code: "KeyH", tier: "shifted", scope: "global", kind: "builtin", label: "Host switcher", description: "open the hosts menu", mapLabel: "hosts" },
  { actionId: "shortcuts-overlay", code: "Slash", tier: "shifted", macTier: "cmd", scope: "global", kind: "builtin", label: "Keyboard shortcuts", description: "toggle this cheatsheet", mapLabel: "cheatsheet", ignoreInputs: true },
  // ⌘,/⇧Ctrl+, settings (260801-mqim): the mac default is the OS-conventional
  // ⌘, via `macTier`; ⌘, unshifted is browser Preferences (claimed data
  // below), so in a mac browser it resolves reserved and settings is
  // palette-only there. ignoreInputs mirrors
  // shortcuts-overlay/compose-toggle: a chrome-level opener fires from inputs.
  { actionId: "settings-open", code: "Comma", tier: "shifted", macTier: "cmd", scope: "global", kind: "builtin", label: "Settings", description: "open the settings dialog", mapLabel: "settings", ignoreInputs: true },
  // ⌘B/⇧Ctrl+B sidebar toggle — the VS Code primary-sidebar keycap. ⌘B is
  // page-interceptable in a mac browser (no claimed-keys entry on KeyB in any
  // tier), so the demotion applies in BOTH mac hosts. On
  // Win/Linux the shifted tier keeps plain Ctrl+B with the pane (readline
  // back-char / nested-tmux prefix).
  // ignoreInputs: the chrome toggles (sidebar + the surface digits below)
  // stay live inside real text inputs — the compose strip is the motivating
  // focus home; the chords are modifier combos that never insert text.
  { actionId: "sidebar-toggle", code: "KeyB", tier: "shifted", macTier: "cmd", scope: "global", kind: "builtin", label: "Toggle sidebar", mapLabel: "sidebar", ignoreInputs: true },
  // ⌘J/⇧Ctrl+J quake terminal — a chrome-level opener in the ⌘B
  // sidebar-toggle class. KeyJ carries no claim in any tier on either host:
  // ⌘J is page-interceptable in a mac browser (the ⌘L/⌘D class, per the
  // claims data below) and absent from the shell's menu accelerator map; on
  // Win/Linux the shifted tier keeps plain Ctrl+J (readline accept-line) with
  // the pane. On desktop the chord TOGGLES the two-state machine (rest ⇄
  // open+focused — focus and drawer linked), so ignoreInputs lets it release
  // while the quake launcher input has focus; on mobile it plain-toggles the
  // sheet. The palette action is the guaranteed fallback where a browser eats
  // the chord.
  { actionId: "quake-terminal", code: "KeyJ", tier: "shifted", macTier: "cmd", scope: "global", kind: "builtin", label: "Quake terminal", description: "toggle the quake terminal (open+focus ⇄ closed)", mapLabel: "quake", ignoreInputs: true },
  // Positional surface digits — ⌘1–5 on mac, ⇧Ctrl+1–5 on win/linux —
  // toggle the tty/code/web/gui/review tiles in tile order. Same demotion class as ⌘B
  // (page-interceptable). In a mac BROWSER the cmd-tier
  // Digit1–9 tab claims (MAC_BROWSER_CMD_CLAIMS below) resolve all five
  // reserved — palette-reachable only there. The win/linux digits were freed
  // by the shell switcher's move to Alt+1–9, outside every tier (the mac ⌥⌘
  // precedent — Alt is no tier). Terminal scope: the tiles exist only on
  // window routes (handler presence gates).
  { actionId: "tty-toggle", code: "Digit1", tier: "shifted", macTier: "cmd", scope: "terminal", kind: "builtin", label: "Toggle terminal", description: "open/close the tty tile", mapLabel: "tty", ignoreInputs: true },
  { actionId: "code-toggle", code: "Digit2", tier: "shifted", macTier: "cmd", scope: "terminal", kind: "builtin", label: "Toggle code editor", description: "open/close the code tile", mapLabel: "code", ignoreInputs: true },
  { actionId: "web-toggle", code: "Digit3", tier: "shifted", macTier: "cmd", scope: "terminal", kind: "builtin", label: "Toggle web view", description: "open/close the web tile", mapLabel: "web", ignoreInputs: true },
  { actionId: "gui-toggle", code: "Digit4", tier: "shifted", macTier: "cmd", scope: "terminal", kind: "builtin", label: "Toggle GUI", description: "open/close the GUI tile", mapLabel: "gui", ignoreInputs: true },
  { actionId: "review-toggle", code: "Digit5", tier: "shifted", macTier: "cmd", scope: "terminal", kind: "builtin", label: "Toggle changes", description: "open/close the PR review tile", mapLabel: "chg", ignoreInputs: true },
  // ⇧⌘⏎/⇧Ctrl+Enter zen toggle — shifted on BOTH platforms (no macTier):
  // exact-modifier matching keeps the chord disjoint from the
  // classifier-owned ⌘Enter/Ctrl+Enter compose-submit chords, which never
  // carry Shift. Enter is free in every claim set. ignoreInputs: the chord
  // must fire from the compose textarea. No mapLabel — Enter has no keycap
  // cell in the overlay grids (the Backquote precedent).
  { actionId: "zen-toggle", code: "Enter", tier: "shifted", scope: "terminal", kind: "builtin", label: "Toggle zen mode", description: "hide top bar + sidebar; expand the focused tile", ignoreInputs: true },
  // ⌃`/⇧Ctrl+` tty↔code focus hop — VS Code's ⌃` gesture. The FIRST shipped
  // ctrl-tier default (mac only: plain Ctrl belongs to the pane on Win/Linux,
  // so the base tier there is shifted and `macTier` does the demotion; the
  // mac terminal seam refuses it via refusal rule 3). No mapLabel: Backquote
  // has no keycap cell in the overlay grids (the Backslash/Comma no-cell
  // precedent).
  { actionId: "focus-hop", code: "Backquote", tier: "shifted", macTier: "ctrl", scope: "terminal", kind: "builtin", label: "Focus terminal ↔ code", description: "hop focus between the tty and code tiles" },
  // — legacy chords, migrated with combos unchanged —
  { actionId: "command-palette", code: "KeyK", tier: "cmd", scope: "global", kind: "builtin", label: "Command palette", ignoreInputs: true },
  // Win/Linux second palette chord. The cmd tier resolves to plain Ctrl+K
  // there, which is the pane's own kill-line (0x0B) — the terminal seam
  // deliberately never refuses unmatched plain-Ctrl chords, so ⌘K's Win/Linux
  // form cannot reach the palette while the terminal owns focus. The shifted
  // tier can: rule 1 refuses every shifted-tier match on every platform, and
  // Ctrl+Shift+letter encodes to the same control byte, so the pane loses
  // nothing. Keyless on mac (`macCode: ""`, the create-session idiom) — ⌘K
  // already bubbles there via the seam's mac cmd-tier rule.
  { actionId: "command-palette-alt", aliasOf: "command-palette", code: "KeyK", macCode: "", tier: "shifted", scope: "global", kind: "builtin", label: "Command palette (alternate)", ignoreInputs: true },
  // ⌘; layout-template cycle (260812-ab5v-surface-layout-core R9/R11): the ▦
  // chip's chord — the NEXT template at the current tile count, slot order kept
  // (tmux `next-layout` muscle memory). It joins the legacy `⌘<punctuation>`
  // family beside ⌘K
  // and ⌘[/⌘]: Semicolon is free in every claimed set and ⌘; is not
  // browser-reserved on either platform (⌘, is the browser's Preferences
  // claim; ⌘/ is the cheatsheet). Terminal scope like its siblings — the
  // palette body (`Layout: Cycle Template`) exists only on window routes, so
  // elsewhere the chord falls through untouched.
  { actionId: "layout-cycle", code: "Semicolon", tier: "cmd", scope: "terminal", kind: "builtin", label: "Cycle layout template", description: "next template at this tile count", mapLabel: "layout" },
  // ⌘F/Ctrl+F web-tile find-in-page (260819-ie2i) — the cmd tier yields the
  // browser's own find chord on every platform, reclaimed only while the web
  // tile owns focus (the `webOnly` gate: handler absent elsewhere, so the
  // chord falls through to native find — and to the pane's Ctrl+F on
  // Win/Linux terminal focus, where the cmd-tier seam rule is mac-only).
  // `ignoreInputs`: a chrome-level opener, it fires from the URL bar and the
  // find input itself (the ⌘K/settings-open class).
  { actionId: "web-find", code: "KeyF", tier: "cmd", scope: "terminal", kind: "builtin", label: "Find in page", description: "search the web tile's page", mapLabel: "find", ignoreInputs: true, webOnly: true },
  // Tty-tile find — the terminal-native mirror of web-find. The base tier is
  // SHIFTED (⇧Ctrl+F on Win/Linux — the GNOME Terminal/Konsole/Windows
  // Terminal find convention): plain Ctrl+F is the pane's readline
  // forward-char there and the terminal seam deliberately never refuses
  // unmatched plain-Ctrl chords, so only the shifted tier can reach the
  // dispatcher under terminal focus. On mac `macTier` demotes to ⌘F — the
  // same chord web-find claims, disjoint by surface gate (ttyOnly vs webOnly:
  // the handlers are never simultaneously present). The seam's existing rules
  // 1–2 refuse both chords under terminal focus, so no xterm-handler change
  // is needed.
  { actionId: "terminal-find", code: "KeyF", tier: "shifted", macTier: "cmd", scope: "terminal", kind: "builtin", label: "Find in terminal", description: "search the terminal buffer", mapLabel: "find", ignoreInputs: true, ttyOnly: true },
  // ⌘L/Ctrl+L focus the web tile's address bar (260819-v6y4 R12) — the
  // browser's own address-bar chord, reclaimed only while the web tile owns
  // focus (the webOnly gate: handler absent elsewhere, so the chord falls
  // through to the browser's address bar on mac — ⌘L is page-interceptable,
  // the ⌘D/⌘J class, so the mac-browser claimed-keys row was REMOVED — and to
  // readline's clear-screen under Win/Linux terminal focus). `ignoreInputs`:
  // a chrome-level opener, it fires from inside the address input itself.
  { actionId: "web-address", code: "KeyL", tier: "cmd", scope: "terminal", kind: "builtin", label: "Focus address bar", description: "focus the web tile's address bar", mapLabel: "address", ignoreInputs: true, webOnly: true },
  // Ctrl+= / Ctrl+- / Ctrl+0 gui zoom — the ctrl tier on EVERY platform:
  // ⌘=/⌘-/⌘0 are the browser's (and the mac shell menu's) own zoom
  // accelerators, so no mac demotion exists, and plain Ctrl+=/−/0 belongs to
  // the pane under terminal focus, so the `guiOnly` gate confines the chords
  // to gui-tile focus (handler presence + the reclaim predicate) and the
  // terminal seam never refuses them.
  { actionId: "gui-zoom-in", code: "Equal", tier: "ctrl", scope: "terminal", kind: "builtin", label: "Zoom GUI in", mapLabel: "gui +", ignoreInputs: true, guiOnly: true },
  { actionId: "gui-zoom-out", code: "Minus", tier: "ctrl", scope: "terminal", kind: "builtin", label: "Zoom GUI out", mapLabel: "gui −", ignoreInputs: true, guiOnly: true },
  { actionId: "gui-zoom-fit", code: "Digit0", tier: "ctrl", scope: "terminal", kind: "builtin", label: "Zoom GUI to fit", mapLabel: "gui fit", ignoreInputs: true, guiOnly: true },
  // ⌘⇧G/Ctrl+Shift+G keyboard capture (the gui chord gate's escape hatch):
  // while capture is latched the reclaim predicate narrows to THIS actionId
  // alone, so every other chord falls through the gui canvas's capture-phase
  // gate to the guest desktop. `guiOnly` confines the chord to gui-tile focus
  // (handler presence + the reclaim predicate) and the terminal seam never
  // refuses it; KeyG is unclaimed in the shifted tier on every host.
  { actionId: "gui-capture-toggle", code: "KeyG", tier: "shifted", scope: "terminal", kind: "builtin", label: "Keyboard capture", description: "hand every chord to the guest desktop", mapLabel: "capture", ignoreInputs: true, guiOnly: true },
  // ⌘⇧G/Ctrl+Shift+G web keyboard capture — the gui toggle's web-tile mirror,
  // sharing its chord: the two are surface-gated (webOnly vs guiOnly), so only
  // the focused tile's handler is ever present (disjoint gates, never a
  // conflict — see `findConflicts`). While latched it is the ONE chord the web
  // tile still reclaims, so it is the keyboard route back.
  { actionId: "web-capture-toggle", code: "KeyG", tier: "shifted", scope: "terminal", kind: "builtin", label: "Keyboard capture", description: "hand every chord to the web page", mapLabel: "capture", ignoreInputs: true, webOnly: true },
  { actionId: "board-cycle-next", code: "BracketRight", tier: "cmd", scope: "board", kind: "builtin", label: "Cycle pane focus →" },
  { actionId: "board-cycle-prev", code: "BracketLeft", tier: "cmd", scope: "board", kind: "builtin", label: "Cycle pane focus ←" },
];

// ── claimed keys ────────────────────────────────────────────────────────────

/** A key+tier the registry treats as spoken-for. `owner` drives the overlay
 *  presentation (shell rows render locked; browser/system rows render claimed
 *  on the tier map). Only `browser`-owned claims disable a binding —
 *  shell/system claims are display + capture-warning data (in the shell the
 *  menu accelerator consumes the key before the page sees it anyway). */
export type ClaimedKey = {
  code: string;
  /** The chord tier the claim occupies (260730-n789: the mac ⌘ page tier has
   *  its own claimed set alongside the shifted tier). */
  tier: BindingTier;
  label: string;
  owner: "shell" | "system" | "browser";
  /** Restrict to one keycap platform; absent = both. */
  platform?: BindingPlatform;
};

/** macOS system-wide screenshot shortcuts ⇧⌘3/4/5 — like the ⇧⌘Q logout row,
 *  they apply on both shell and browser hosts (screenshots are system-wide).
 *  The freed mac ⇧⌘1/2/6–9 digits carry NO claims: unclaimed future page real
 *  estate (260731-nv5r). */
const MAC_SCREENSHOT_CLAIMS: ClaimedKey[] = [3, 4, 5].map((n) => ({
  code: `Digit${n}`,
  tier: "shifted" as const,
  label: "screenshot",
  owner: "system" as const,
  platform: "mac" as const,
}));

/** Mac desktop-shell ⌘-tier menu accelerators (`app/desktop/src/menu.ts` —
 *  the exhaustive mac bound set): App ⌘Q/⌘H, Window ⌘M, View ⌘R + zoom
 *  ⌘0/⌘+/⌘−, Edit roles ⌘Z/X/C/V/A. Hand-maintained mirror — update in the
 *  same change as any shell accelerator change (desktop-shell memory rule). */
const MAC_SHELL_CMD_CLAIMS: ClaimedKey[] = [
  { code: "KeyQ", tier: "cmd", label: "quit", owner: "shell", platform: "mac" },
  { code: "KeyH", tier: "cmd", label: "hide", owner: "shell", platform: "mac" },
  { code: "KeyM", tier: "cmd", label: "minimize", owner: "shell", platform: "mac" },
  { code: "KeyR", tier: "cmd", label: "reload", owner: "shell", platform: "mac" },
  { code: "KeyZ", tier: "cmd", label: "undo", owner: "shell", platform: "mac" },
  { code: "KeyX", tier: "cmd", label: "cut", owner: "shell", platform: "mac" },
  { code: "KeyC", tier: "cmd", label: "copy", owner: "shell", platform: "mac" },
  { code: "KeyV", tier: "cmd", label: "paste", owner: "shell", platform: "mac" },
  { code: "KeyA", tier: "cmd", label: "select all", owner: "shell", platform: "mac" },
  { code: "Digit0", tier: "cmd", label: "zoom", owner: "shell", platform: "mac" },
  { code: "Equal", tier: "cmd", label: "zoom", owner: "shell", platform: "mac" },
  { code: "Minus", tier: "cmd", label: "zoom", owner: "shell", platform: "mac" },
];

/** Mac BROWSER ⌘-tier reserved keys: browser-owned N/T/W + tab digits are
 *  uninterceptable (they disable resolution, like the shifted browser set);
 *  Q/H/M are OS-level (display-only, owner `system`). ⌘L is deliberately NOT
 *  claimed (260819-v6y4): it is page-interceptable (the ⌘D/⌘J class —
 *  vscode.dev intercepts it), and the `web-address` binding's webOnly gate
 *  preserves the browser's own address-bar behavior everywhere except
 *  web-tile focus, which is exactly what the retired claim protected. */
const MAC_BROWSER_CMD_CLAIMS: ClaimedKey[] = [
  { code: "KeyN", tier: "cmd", label: "new window", owner: "browser", platform: "mac" },
  { code: "KeyT", tier: "cmd", label: "new tab", owner: "browser", platform: "mac" },
  { code: "KeyW", tier: "cmd", label: "close tab", owner: "browser", platform: "mac" },
  // ⌘, is the browser's own Preferences accelerator on macOS (the reason
  // `settings-open`'s browser default stays shifted, 260801-mqim) — claimed so
  // an override onto it resolves reserved instead of advertising a dead chord.
  { code: "Comma", tier: "cmd", label: "preferences", owner: "browser", platform: "mac" },
  ...Array.from({ length: 9 }, (_, i) => ({
    code: `Digit${i + 1}`,
    tier: "cmd" as const,
    label: "tab",
    owner: "browser" as const,
    platform: "mac" as const,
  })),
  { code: "KeyQ", tier: "cmd", label: "quit", owner: "system", platform: "mac" },
  { code: "KeyH", tier: "cmd", label: "hide", owner: "system", platform: "mac" },
  { code: "KeyM", tier: "cmd", label: "minimize", owner: "system", platform: "mac" },
];

/**
 * The claimed keys for a host, per tier. Shifted tier: shell claims (menu
 * accelerators: ⇧Ctrl+I devtools on win/linux ONLY —
 * ⇧CmdOrCtrl+R force reload everywhere; both Hosts switchers — mac ⌥⌘1–9,
 * win/linux Alt+1–9 — live outside every tier, Alt being no tier (the mac
 * ⌥⌘ precedent, 260731-nv5r)) and system claims (⇧⌘Q macOS
 * logout; ⇧⌘3/4/5 macOS screenshots; ⇧Ctrl+C/V terminal copy/paste
 * convention on win/linux) apply in both hosts; browser claims (N/T/W —
 * incognito / reopen-tab / close-window) apply only outside the desktop
 * shell, where those actions stay palette-reachable. Mac ⌘ (cmd) tier
 * (260730-n789): the shell's menu accelerators inside the shell, the
 * browser-reserved set outside. Win/Linux claim sets are unchanged — the
 * unshifted Ctrl tier belongs to the pane, not to claims data.
 */
export function claimedKeys(platform: BindingPlatform, shell: boolean): ClaimedKey[] {
  const claims: ClaimedKey[] = [
    ...MAC_SCREENSHOT_CLAIMS,
    // ⌘` — macOS "Move focus to next window" (system-wide, so both hosts; the
    // MAC_SCREENSHOT_CLAIMS precedent). Display + capture-warning only —
    // `focus-hop`'s ⌃` is the ctrl tier, disjoint.
    { code: "Backquote", tier: "cmd", label: "cycle app windows", owner: "system", platform: "mac" },
    { code: "KeyR", tier: "shifted", label: "reload", owner: "shell" },
    { code: "KeyI", tier: "shifted", label: "devtools", owner: "shell", platform: "other" },
    { code: "KeyQ", tier: "shifted", label: "logout", owner: "system", platform: "mac" },
    { code: "KeyC", tier: "shifted", label: "copy", owner: "system", platform: "other" },
    { code: "KeyV", tier: "shifted", label: "paste", owner: "system", platform: "other" },
    ...(shell ? MAC_SHELL_CMD_CLAIMS : MAC_BROWSER_CMD_CLAIMS),
  ];
  if (!shell) {
    claims.push(
      { code: "KeyN", tier: "shifted", label: "incognito", owner: "browser" },
      { code: "KeyT", tier: "shifted", label: "reopen tab", owner: "browser" },
      { code: "KeyW", tier: "shifted", label: "close window", owner: "browser" },
    );
  }
  return claims.filter((c) => !c.platform || c.platform === platform);
}

// ── host detection ──────────────────────────────────────────────────────────

/** Keycap platform from the runtime UA. `other` when undetectable (jsdom). */
export function detectPlatform(): BindingPlatform {
  if (typeof navigator === "undefined") return "other";
  const probe = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
  return /mac|iphone|ipad|ipod/i.test(probe) ? "mac" : "other";
}

// ── matching ────────────────────────────────────────────────────────────────

/** The minimal event shape the matcher needs (assignable from KeyboardEvent). */
export type ChordEvent = {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

/**
 * Whether a keydown matches a combo. Alt excluded in every tier (not part of
 * any tier; macOS composes characters with it). The `cmd` tier accepts Meta OR
 * Ctrl without Shift — byte-identical to the legacy listeners' predicates.
 */
export function matchesCombo(e: ChordEvent, combo: BindingCombo): boolean {
  if (e.altKey || e.code !== combo.code) return false;
  switch (combo.tier) {
    case "shifted":
      return e.shiftKey && (e.metaKey || e.ctrlKey);
    case "cmd":
      return !e.shiftKey && (e.metaKey || e.ctrlKey);
    case "ctrl":
      return e.ctrlKey && !e.metaKey && !e.shiftKey;
  }
}

/**
 * Every enabled binding matching the event, SCOPED-BEATS-GLOBAL ordered
 * (260730-n789): non-global scopes first, registry order within each class.
 * On macOS the board pane-cycle pair and the global back/forward share the
 * ⌘[/⌘] combos by design — the dispatcher walks this list and fires the
 * first match that has a handler at its mount, so the board route keeps
 * pane-cycle while every other route gets history navigation. A scoped/global
 * shadow is precedence, not a conflict (see `findConflicts`).
 */
export function findMatches(
  e: ChordEvent,
  bindings: readonly EffectiveBinding[],
): EffectiveBinding[] {
  const matches = bindings.filter((b) => b.enabled && matchesCombo(e, b));
  if (matches.length < 2) return matches;
  return [
    ...matches.filter((b) => b.scope !== "global"),
    ...matches.filter((b) => b.scope === "global"),
  ];
}

/**
 * The lens-iframe reclaim predicate (260812-wfic R9, kind-aware since
 * 260819-ie2i): whether a keydown inside a same-origin lens iframe should be
 * reclaimed and re-dispatched to the parent document. `kind` is the kind of
 * the iframe the keydown arrived in — the surface that owns focus. A chord
 * whose only registry matches are `ttyOnly` (the split pair — tmux
 * pane-targeting) is never reclaimed: it belongs to the embedded app's own
 * keybinding service (code-server's ⌘D add-selection-to-next-match). A
 * `webOnly` match (⌘F web find) is reclaimable only inside a WEB iframe — in
 * the code iframe ⌘F stays with code-server's own find. A `guiOnly` match
 * (the Ctrl+=/−/0 zoom chords) is reclaimable only for kind `"gui"` — the
 * gui tile's capture-phase gate then wins over noVNC's canvas handler. A
 * chord matching BOTH
 * a gated and an ungated binding is still reclaimed (`.some` semantics) — the
 * ungated match has a global meaning. For `"code"` the result is
 * byte-identical to the pre-kind-aware predicate on every pre-ie2i binding.
 *
 * `captured` is the focused tile's keyboard-capture latch (gui:
 * `rk-gui-capture`, web: `rk-web-capture`): when set, the predicate narrows to
 * that kind's single release actionId (`gui-capture-toggle` /
 * `web-capture-toggle`) — every other chord returns `false` and falls through
 * to the guest (the gui canvas's gate → the desktop; the web frame → the
 * page), so the release chord is the only keyboard route back. Callers pass it
 * only for kinds `"gui"` and `"web"`; with it unset (the default) the
 * predicate is byte-identical to the pre-capture behavior on every kind.
 */
export function hasReclaimableMatch(
  e: ChordEvent,
  bindings: readonly EffectiveBinding[],
  kind: ViewName,
  captured = false,
): boolean {
  if (captured) {
    const release = kind === "web" ? "web-capture-toggle" : "gui-capture-toggle";
    return findMatches(e, bindings).some((b) => b.actionId === release);
  }
  return findMatches(e, bindings).some((b) => {
    if (b.ttyOnly) return false;
    if (b.webOnly) return kind === "web";
    if (b.guiOnly) return kind === "gui";
    return true;
  });
}

/**
 * Whether the terminal's custom key handler must REFUSE this keydown so it
 * bubbles to the window dispatcher instead of reaching the pane
 * (`terminal-client.tsx`). `guiOnly` and `webOnly` matches are filtered out
 * first: their handlers are absent under terminal focus, so their chords
 * belong to the pane (e.g. ⇧Ctrl+G, which `web-capture-toggle` would
 * otherwise steal through rule 1). Three rules:
 *
 * 1. Any enabled SHIFTED-tier match, on every platform (260730-g40a): legacy
 *    TTY encoding cannot distinguish Ctrl+Shift+letter from Ctrl+letter, so
 *    xterm would emit the Ctrl-char; refusing costs the pane nothing.
 * 2. On macOS ONLY (260730-n789): an enabled CMD-tier match pressed with
 *    METAKEY — ⌘ chords never reach the pane as control bytes, so refusal is
 *    loss-free and lets the demoted ⌘[/⌘]/⌘/ (and shell-host ⌘T/⌘W/⌘N) fire
 *    while the terminal owns focus. The metaKey gate is load-bearing:
 *    `matchesCombo`'s cmd tier also accepts plain Ctrl, and mac Ctrl+[ is ESC
 *    — plain-Ctrl chords matching no enabled ctrl-tier binding must ALWAYS
 *    pass through to the pane. On Win/Linux this rule never applies (cmd-tier
 *    combos ARE plain-Ctrl chords there), keeping the seam byte-identical to
 *    the pre-n789 behavior.
 * 3. On macOS ONLY: an enabled CTRL-tier match pressed with CTRLKEY (and
 *    without metaKey — a ⌘+Ctrl combined press must not double-match; the
 *    inverse of rule 2's gate) — lets ⌃` (focus-hop) bubble to the
 *    dispatcher under terminal focus. This steals NUL (the byte Ctrl+`
 *    encodes to) from the pane: near-zero cost, the same trade VS Code makes
 *    for its own ⌃`. Win/Linux stays byte-identical — no ctrl-tier default
 *    resolves there (focus-hop's base tier is shifted), and the rule is
 *    platform-gated to mac. The `guiOnly` filter above is load-bearing here:
 *    the gui-zoom trio is ctrl-tier on every platform, and without the
 *    filter this rule would steal plain Ctrl+=/−/0 from a focused pane.
 */
export function shouldRefuseTerminalChord(
  e: ChordEvent,
  bindings: readonly EffectiveBinding[],
  platform: BindingPlatform,
): boolean {
  const matches = findMatches(e, bindings).filter((b) => !b.guiOnly && !b.webOnly);
  if (matches.some((b) => b.tier === "shifted")) return true;
  if (platform === "mac" && e.metaKey && matches.some((b) => b.tier === "cmd")) return true;
  return platform === "mac" && e.ctrlKey && !e.metaKey && matches.some((b) => b.tier === "ctrl");
}

// ── override storage ────────────────────────────────────────────────────────

const TIERS: readonly BindingTier[] = ["shifted", "cmd", "ctrl"];

function isCombo(value: unknown): value is BindingCombo {
  if (typeof value !== "object" || value === null) return false;
  if (!("code" in value) || !("tier" in value)) return false;
  return (
    typeof value.code === "string" &&
    value.code.length > 0 &&
    typeof value.tier === "string" &&
    (TIERS as readonly string[]).includes(value.tier)
  );
}

/** Tolerant parse of the stored diff blob: malformed JSON, a non-object root,
 *  or garbage entries all degrade to "no override" rather than throwing.
 *  A stored `operator-console` entry (the ⌘J action's retired id) maps onto
 *  `quake-terminal` when the blob carries no `quake-terminal` entry — the
 *  new-id entry always wins, and the retired id never survives into the
 *  returned overrides, so the next write drops it. */
export function parseOverrides(raw: string | null): BindingOverrides {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const overrides: BindingOverrides = {};
  for (const [actionId, value] of Object.entries(parsed)) {
    if (value === null) overrides[actionId] = null;
    else if (isCombo(value)) overrides[actionId] = { code: value.code, tier: value.tier };
  }
  if ("operator-console" in overrides && !("quake-terminal" in overrides)) {
    overrides["quake-terminal"] = overrides["operator-console"];
  }
  delete overrides["operator-console"];
  return overrides;
}

/** Read the persisted diffs; `{}` when absent or localStorage is unavailable. */
export function readStoredOverrides(): BindingOverrides {
  try {
    return parseOverrides(localStorage.getItem(KEYBINDINGS_STORAGE_KEY));
  } catch {
    return {};
  }
}

/** Persist the diffs (best-effort; an empty diff removes the key). */
export function writeStoredOverrides(overrides: BindingOverrides): void {
  try {
    if (Object.keys(overrides).length === 0) {
      localStorage.removeItem(KEYBINDINGS_STORAGE_KEY);
    } else {
      localStorage.setItem(KEYBINDINGS_STORAGE_KEY, JSON.stringify(overrides));
    }
  } catch {
    /* noop — best-effort persistence */
  }
}

// ── resolution ──────────────────────────────────────────────────────────────

/**
 * The host-effective DEFAULT combo for a binding (260730-n789): on mac hosts
 * a `macTier` and/or `macCode` refinement (260807-rbx5) replaces the base
 * tier/code — one canonical chord per action on every mac host. An
 * empty-string `macCode` is a refinement to KEYLESS (unbound on mac), not a
 * missing refinement — the `!== undefined` tests keep it from falling back
 * to the base code. This is
 * the single seam where platform is consulted for defaults; both
 * `resolveBindings` (fallback + `isDefault`) and `applyCapture` (own-default
 * detection) read defaults through it, so a `macCode` binding's own-default
 * re-capture and conflict detection come for free.
 */
export function defaultComboFor(def: KeyBinding, host: BindingHost): BindingCombo {
  if (host.platform === "mac" && (def.macTier !== undefined || def.macCode !== undefined)) {
    return { code: def.macCode ?? def.code, tier: def.macTier ?? def.tier };
  }
  return { code: def.code, tier: def.tier };
}

/**
 * Merge defaults + overrides into the effective map for a host. Defaults are
 * host-resolved through `defaultComboFor` (mac tier demotions). `null`
 * overrides disable (`reason: "user"` — the steal-with-warning victim state,
 * flagged in the overlay until rebound or reset). A combo that is
 * browser-reserved in this host — tier-aware: shifted N/T/W outside the
 * shell on every platform, plus the mac-browser ⌘ set — resolves disabled
 * (`reason: "reserved"`) — the action stays palette-reachable.
 *
 * KEYLESS defaults (`code: ""` — macro bindings, which ship no default combo;
 * see `lib/macros.ts` `macroToBinding`) resolve UNBOUND unless an override
 * supplies a combo: `enabled: false, disabledReason: "user"` — the same state
 * a steal victim lands in, so the overlay's unbound affordance covers both.
 * Builtins always carry a code and are unaffected.
 */
export function resolveBindings(
  defaults: readonly KeyBinding[],
  overrides: BindingOverrides,
  host: BindingHost,
): EffectiveBinding[] {
  const reserved = new Set(
    claimedKeys(host.platform, host.shell)
      .filter((c) => c.owner === "browser")
      .map((c) => `${c.tier}:${c.code}`),
  );
  return defaults.map((def) => {
    const override = Object.prototype.hasOwnProperty.call(overrides, def.actionId)
      ? overrides[def.actionId]
      : undefined;
    if (override === null) {
      return { ...def, enabled: false, isDefault: false, disabledReason: "user" as const };
    }
    const base = defaultComboFor(def, host);
    const combo: BindingCombo = override ?? base;
    if (combo.code === "") {
      return { ...def, enabled: false, isDefault: false, disabledReason: "user" as const };
    }
    const isDefault = combo.code === base.code && combo.tier === base.tier;
    const isReserved = reserved.has(`${combo.tier}:${combo.code}`);
    return {
      ...def,
      code: combo.code,
      tier: combo.tier,
      enabled: !isReserved,
      isDefault,
      ...(isReserved ? { disabledReason: "reserved" as const } : {}),
    };
  });
}

// ── conflicts ───────────────────────────────────────────────────────────────

/** Whether two binding scopes can be live at the same time. `global` overlaps
 *  everything; equal scopes overlap; `terminal`/`board` routes never co-mount. */
export function scopesOverlap(a: BindingScope, b: BindingScope): boolean {
  return a === b || a === "global" || b === "global";
}

export type BindingConflict = {
  a: string;
  b: string;
  code: string;
  tier: BindingTier;
};

/**
 * Whether two tiers can fire on the same keydown (per `matchesCombo`): `cmd`
 * accepts Meta OR Ctrl without Shift and `ctrl` accepts Ctrl-only without
 * Shift, so a plain Ctrl chord matches BOTH — same-code `cmd`/`ctrl` bindings
 * mask each other on every platform (and on non-mac hosts capture always
 * reads Ctrl chords as `cmd`, so the pair is routine there). `shifted`
 * requires Shift and is disjoint from both.
 */
export function tiersCollide(a: BindingTier, b: BindingTier): boolean {
  return a === b || (a !== "shifted" && b !== "shifted");
}

/** The single surface a binding's handler is gated to, or null when ungated. */
function surfaceGate(b: EffectiveBinding): "tty" | "web" | "gui" | null {
  if (b.ttyOnly) return "tty";
  if (b.webOnly) return "web";
  if (b.guiOnly) return "gui";
  return null;
}

/**
 * Pure conflict detection over an effective map: two ENABLED bindings conflict
 * when their codes are equal, their tiers collide (equal, or the overlapping
 * `cmd`/`ctrl` pair — see `tiersCollide`), and their scopes are EQUAL. A
 * same-combo global↔scoped pair is a SHADOW, not a conflict (260730-n789):
 * dispatch is scoped-beats-global (`findMatches`), so both stay functional —
 * the scoped one wins on its route, the global one everywhere else (the mac
 * default map ships exactly this shape: board ⌘[/⌘] shadowing back/forward).
 * Consumed by tests asserting the defaults are clean (the capture UI's steal
 * warning does its own single-victim overlap check in `applyCapture`).
 */
export function findConflicts(bindings: readonly EffectiveBinding[]): BindingConflict[] {
  const conflicts: BindingConflict[] = [];
  for (let i = 0; i < bindings.length; i++) {
    const a = bindings[i];
    if (!a.enabled) continue;
    for (let j = i + 1; j < bindings.length; j++) {
      const b = bindings[j];
      if (!b.enabled) continue;
      // Surface-gate disjointness: two bindings gated to DIFFERENT surfaces
      // (`ttyOnly` / `webOnly` / `guiOnly`) never have their handlers
      // simultaneously present (each gate renders the handler absent off its
      // surface), so a shared combo between them is coexistence, not a
      // conflict — the mac ⌘F that terminal-find and web-find both claim, and
      // the ⌘⇧G that gui-capture-toggle and web-capture-toggle both claim.
      const gateA = surfaceGate(a);
      const gateB = surfaceGate(b);
      const gatesDisjoint = gateA !== null && gateB !== null && gateA !== gateB;
      // An alias and the action it aliases fire the SAME handler, so a shared
      // combo between them is redundancy, not a conflict — there is no
      // ambiguity for the dispatcher to resolve. Stated as an invariant
      // rather than left to the shipped pair's tiers happening not to collide.
      const sameAction =
        (a.aliasOf ?? a.actionId) === (b.aliasOf ?? b.actionId);
      if (
        a.code === b.code &&
        tiersCollide(a.tier, b.tier) &&
        a.scope === b.scope &&
        !gatesDisjoint &&
        !sameAction
      ) {
        conflicts.push({ a: a.actionId, b: b.actionId, code: a.code, tier: a.tier });
      }
    }
  }
  return conflicts;
}

// ── capture ─────────────────────────────────────────────────────────────────

const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "MetaLeft",
  "MetaRight",
  "AltLeft",
  "AltRight",
  "CapsLock",
  "Fn",
  "FnLock",
]);

/**
 * Derive a combo from a capture keydown, or `null` while the chord is not yet
 * a valid binding (modifier-only presses keep capturing; Alt chords and bare
 * keys are rejected — no tier models them). Ctrl-without-Meta reads as the
 * `ctrl` tier on macOS (where it is distinct from ⌘) and as the `cmd` tier
 * elsewhere (where Ctrl IS CmdOrCtrl) — overrides are per-device, so the
 * device-local reading is the correct one.
 */
export function captureFromEvent(
  e: ChordEvent,
  platform: BindingPlatform,
): BindingCombo | null {
  if (MODIFIER_CODES.has(e.code)) return null;
  if (e.altKey) return null;
  if (e.shiftKey && (e.metaKey || e.ctrlKey)) return { code: e.code, tier: "shifted" };
  if (e.metaKey) return { code: e.code, tier: "cmd" };
  if (e.ctrlKey && !e.shiftKey) {
    return { code: e.code, tier: platform === "mac" ? "ctrl" : "cmd" };
  }
  return null;
}

/**
 * Apply a captured combo to an action's override diff. Steal-with-warning:
 * when another ENABLED binding with an overlapping scope already owns the
 * combo — same code and a COLLIDING tier (`tiersCollide`: a plain Ctrl chord
 * matches both the `cmd` and `ctrl` tiers, so a cross-tier owner would be
 * silently masked at dispatch) — it becomes unbound (override `null`) and is
 * reported as `stolenFrom` so the overlay can flag it. Re-capturing an
 * action's own HOST default (`defaultComboFor` — e.g. ⌘[ for go-back on a
 * mac) is a NO-OP: it drops the diff entry (the stored blob stays diffs-only)
 * and steals from nobody — the check runs BEFORE the victim search so the mac
 * shadow pairs (global ⌘[/⌘] shared with the board cycle bindings) survive a
 * re-capture of either partner's default. Stealing otherwise
 * deliberately stays `scopesOverlap`-wide even though `findConflicts` treats
 * global↔scoped shadows as precedence: four bindings dispatch through
 * component-local listeners that never see `findMatches` precedence, so a
 * cross-scope capture onto their combos would double-fire if left unstolen.
 */
export function applyCapture(
  bindings: readonly EffectiveBinding[],
  overrides: BindingOverrides,
  actionId: string,
  combo: BindingCombo,
  host: BindingHost,
  defaults: readonly KeyBinding[] = DEFAULT_BINDINGS,
): { overrides: BindingOverrides; stolenFrom: string | null } {
  const next: BindingOverrides = { ...overrides };
  const def = defaults.find((d) => d.actionId === actionId);
  const base = def ? defaultComboFor(def, host) : null;
  if (base && base.code === combo.code && base.tier === combo.tier) {
    // Own host default — a no-op re-capture. Short-circuit BEFORE the victim
    // search: the shipped defaults may share this combo across scopes (the
    // mac ⌘[/⌘] global↔board shadow pairs), and re-affirming a default must
    // never unbind its shadow partner.
    delete next[actionId];
    return { overrides: next, stolenFrom: null };
  }
  const self = bindings.find((b) => b.actionId === actionId);
  const scope = self?.scope ?? "global";
  const victim =
    bindings.find(
      (b) =>
        b.actionId !== actionId &&
        b.enabled &&
        b.code === combo.code &&
        tiersCollide(b.tier, combo.tier) &&
        scopesOverlap(scope, b.scope),
    ) ?? null;
  if (victim) next[victim.actionId] = null;
  next[actionId] = combo;
  return { overrides: next, stolenFrom: victim?.actionId ?? null };
}

// ── formatting ──────────────────────────────────────────────────────────────

const CODE_LABELS: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Slash: "/",
  Backslash: "\\",
  Period: ".",
  Comma: ",",
  Backquote: "`",
  Semicolon: ";",
  Quote: "'",
  Minus: "-",
  Equal: "=",
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
};

/** Human keycap for a `KeyboardEvent.code` ("KeyN" → "N", "Slash" → "/"). */
export function keyLabel(code: string): string {
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  return CODE_LABELS[code] ?? code;
}

/** Keycap parts for rendering (["⇧", "⌘", "N"] / ["Shift", "Ctrl", "N"]). */
export function comboParts(combo: BindingCombo, platform: BindingPlatform): string[] {
  const key = keyLabel(combo.code);
  if (platform === "mac") {
    switch (combo.tier) {
      case "shifted":
        return ["⇧", "⌘", key];
      case "cmd":
        return ["⌘", key];
      case "ctrl":
        return ["Ctrl", key];
    }
  }
  switch (combo.tier) {
    case "shifted":
      return ["Shift", "Ctrl", key];
    default:
      return ["Ctrl", key];
  }
}

/**
 * One-string combo for palette hints ("⇧⌘N" / "Shift+Ctrl+N"). Mac symbol
 * tiers join bare; the `ctrl` tier keeps the "Ctrl+key" spelling on both
 * platforms (byte-identical to the pre-registry palette hints).
 */
export function formatCombo(combo: BindingCombo, platform: BindingPlatform): string {
  const parts = comboParts(combo, platform);
  return platform === "mac" && combo.tier !== "ctrl" ? parts.join("") : parts.join("+");
}

// ── suppression ─────────────────────────────────────────────────────────────

/**
 * The single shared input-gating predicate (supersedes window-view.ts's
 * `shouldSuppressViewChord`): suppress a chord only when a "real" text input
 * has focus. Carve-out preserved from the legacy listeners: xterm's hidden
 * helper textarea is the terminal's NORMAL focus state — chords fire
 * there. Returns `true` when the chord SHOULD be suppressed. Bindings with
 * `ignoreInputs` — the chrome-toggle and navigation families, ⌘K — skip this
 * predicate entirely.
 */
export function shouldSuppressChord(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".xterm") != null) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  // `isContentEditable` is the browser truth; fall back to the attribute value
  // (`"true"` / `""`) since jsdom does not implement the getter.
  return target.isContentEditable || target.contentEditable === "true";
}

/**
 * Whether moving focus away from `active` would INTERRUPT the user — an
 * xterm, any editable (`shouldSuppressChord`'s truth — the palette input
 * included), an iframe (the code/web tiles), a dialog's contents, or an open
 * popup's contents (a `role="menu"` / `role="listbox"` — a roving-focus row the
 * user is stepping through). A plain chrome control — the sidebar row that
 * just navigated, a top-bar button at rest — is not engaged, and `body`/`null`
 * never is. The restore router's first-visit compose arm consults this before
 * every attempt, because its retry can arm AFTER the user has started on
 * something else (a late session payload under load), and a fresh navigation
 * must land in the strip without ever stealing.
 */
export function focusIsEngaged(active: Element | null): boolean {
  if (!(active instanceof HTMLElement)) return false;
  if (active === document.body) return false;
  if (active.tagName === "IFRAME") return true;
  if (active.closest(".xterm") != null) return true;
  if (active.closest('[role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"]') != null) return true;
  return shouldSuppressChord(active);
}

/**
 * The hint string for an action's chord(s) — the primary first, then any
 * enabled aliases, joined with `/`. `undefined` when nothing is bound, so a
 * tip never advertises a dead chord.
 *
 * The primary always leads: an alias alone would point a user at a chord that
 * may be browser-reserved on their host, having replaced one that works.
 */
export function chordHintFor(
  actionId: string,
  bindings: readonly EffectiveBinding[],
  platform: BindingPlatform,
): string | undefined {
  const combos = bindings
    .filter((b) => b.enabled && (b.actionId === actionId || b.aliasOf === actionId))
    .sort((a, b) => Number(a.aliasOf != null) - Number(b.aliasOf != null))
    .map((b) => formatCombo({ code: b.code, tier: b.tier }, platform));
  return combos.length > 0 ? combos.join(" / ") : undefined;
}

// ── palette hints ───────────────────────────────────────────────────────────

/**
 * Decorate palette actions with effective-combo `shortcut` hints (actionId
 * doubles as the palette id). Disabled bindings (user-disabled or
 * browser-reserved) contribute NO hint — a hint advertising a dead chord
 * would lie; the entry itself stays reachable. Actions without a registered
 * binding pass through untouched (their hand-set hints, if any, survive).
 */
export function withShortcutHints<T extends { id: string; shortcut?: string }>(
  actions: readonly T[],
  byAction: ReadonlyMap<string, EffectiveBinding>,
  platform: BindingPlatform,
): (T & { shortcut?: string })[] {
  return actions.map((action) => {
    const binding = byAction.get(action.id);
    if (!binding || !binding.enabled) return action;
    return {
      ...action,
      shortcut: formatCombo({ code: binding.code, tier: binding.tier }, platform),
    };
  });
}
