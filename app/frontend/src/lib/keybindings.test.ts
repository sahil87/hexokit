import { describe, it, expect, afterEach } from "vitest";
import {
  DEFAULT_BINDINGS,
  KEYBINDINGS_STORAGE_KEY,
  applyCapture,
  captureFromEvent,
  chordHintFor,
  claimedKeys,
  comboParts,
  defaultComboFor,
  findConflicts,
  findMatches,
  hasReclaimableMatch,
  tiersCollide,
  formatCombo,
  keyLabel,
  matchesCombo,
  parseOverrides,
  readStoredOverrides,
  resolveBindings,
  scopesOverlap,
  shouldRefuseTerminalChord,
  shouldSuppressChord,
  focusIsEngaged,
  withShortcutHints,
  writeStoredOverrides,
  type BindingHost,
  type ChordEvent,
  type EffectiveBinding,
  type KeyBinding,
} from "./keybindings";

const SHELL_MAC: BindingHost = { platform: "mac", shell: true };
const BROWSER_MAC: BindingHost = { platform: "mac", shell: false };
const SHELL_OTHER: BindingHost = { platform: "other", shell: true };
const BROWSER_OTHER: BindingHost = { platform: "other", shell: false };
const ALL_HOSTS = [SHELL_MAC, BROWSER_MAC, SHELL_OTHER, BROWSER_OTHER];

function chord(partial: Partial<ChordEvent> & { code: string }): ChordEvent {
  return { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...partial };
}

function resolved(host: BindingHost = SHELL_OTHER, overrides = {}): EffectiveBinding[] {
  return resolveBindings(DEFAULT_BINDINGS, overrides, host);
}

function byId(bindings: EffectiveBinding[], actionId: string): EffectiveBinding {
  const found = bindings.find((b) => b.actionId === actionId);
  if (!found) throw new Error(`missing binding ${actionId}`);
  return found;
}

describe("DEFAULT_BINDINGS integrity", () => {
  it("has unique actionIds", () => {
    const ids = DEFAULT_BINDINGS.map((b) => b.actionId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("carries the shifted-tier actions on their canonical keys", () => {
    const shifted = Object.fromEntries(
      DEFAULT_BINDINGS.filter((b) => b.tier === "shifted").map((b) => [b.actionId, b.code]),
    );
    expect(shifted).toEqual({
      "command-palette-alt": "KeyK",
      "create-session": "KeyN",
      "create-window": "KeyT",
      "kill-window": "KeyW",
      "reopen-window": "",
      "new-app-window": "",
      "close-app-window": "",
      "compose-toggle": "KeyE",
      "open-last-used": "KeyO",
      "split-horizontal": "Backslash",
      "split-vertical": "Minus",
      "window-prev": "ArrowUp",
      "window-next": "ArrowDown",
      "session-prev": "ArrowLeft",
      "session-next": "ArrowRight",
      "go-back": "BracketLeft",
      "go-forward": "BracketRight",
      "agent-next-waiting": "KeyA",
      "host-menu-open": "KeyH",
      "shortcuts-overlay": "Slash",
      "settings-open": "Comma",
      "sidebar-toggle": "KeyB",
      "quake-terminal": "KeyJ",
      "tty-toggle": "Digit1",
      "code-toggle": "Digit2",
      "web-toggle": "Digit3",
      "gui-toggle": "Digit4",
      "review-toggle": "Digit5",
      "diff-toggle": "Digit6",
      "zen-toggle": "Enter",
      "focus-hop": "Backquote",
      "terminal-find": "KeyF",
      "gui-capture-toggle": "KeyG",
      "web-capture-toggle": "KeyG",
    });
  });

  it("compose-toggle: ⇧Ctrl+E base / ⌘I mac refinement, global, ignoreInputs", () => {
    const def = DEFAULT_BINDINGS.find((b) => b.actionId === "compose-toggle");
    // Full-row equality: the compose row is a do-not-move constraint.
    expect(def).toEqual({
      actionId: "compose-toggle",
      code: "KeyE",
      tier: "shifted",
      macCode: "KeyI",
      macTier: "cmd",
      scope: "global",
      kind: "builtin",
      label: "Compose",
      description: "toggle the compose strip",
      mapLabel: "compose",
      ignoreInputs: true,
    });
    // ⌘I in BOTH mac hosts — one canonical chord per action (unshifted ⌘E
    // is browser find-selection territory on mac, so the demotion rides
    // macCode).
    for (const host of [SHELL_MAC, BROWSER_MAC]) {
      expect(byId(resolved(host), "compose-toggle")).toMatchObject({
        code: "KeyI",
        tier: "cmd",
        enabled: true,
        isDefault: true,
      });
      expect(
        findMatches(chord({ code: "KeyI", metaKey: true }), resolved(host)).map((b) => b.actionId),
      ).toEqual(["compose-toggle"]);
      // ⇧⌘E is gone on mac — the refinement moved the default off KeyE.
      expect(
        findMatches(chord({ code: "KeyE", metaKey: true, shiftKey: true }), resolved(host)),
      ).toEqual([]);
    }
    // Win/Linux unchanged: ⇧Ctrl+E (I is the win/linux devtools claim — the
    // mac refinement is what spends KeyI).
    for (const host of [SHELL_OTHER, BROWSER_OTHER]) {
      expect(byId(resolved(host), "compose-toggle")).toMatchObject({
        code: "KeyE",
        tier: "shifted",
        enabled: true,
        isDefault: true,
      });
    }
  });

  it("open-last-used: ⇧⌘O, terminal scope, no mac demotion (260801-sm6g)", () => {
    const def = DEFAULT_BINDINGS.find((b) => b.actionId === "open-last-used");
    expect(def).toMatchObject({
      code: "KeyO",
      tier: "shifted",
      scope: "terminal",
      kind: "builtin",
    });
    expect(def?.macTier).toBeUndefined();
    for (const host of ALL_HOSTS) {
      expect(byId(resolved(host), "open-last-used")).toMatchObject({
        code: "KeyO",
        tier: "shifted",
        enabled: true,
      });
    }
  });

  it("settings-open: Comma, global, ignoreInputs, canonical mac ⌘, demotion (260801-mqim)", () => {
    const def = DEFAULT_BINDINGS.find((b) => b.actionId === "settings-open");
    expect(def).toMatchObject({
      code: "Comma",
      tier: "shifted",
      macTier: "cmd",
      scope: "global",
      kind: "builtin",
      ignoreInputs: true,
    });
    // ⇧Ctrl+, on win/linux; ⌘, is the canonical mac default on BOTH mac
    // hosts — in a mac BROWSER it resolves reserved (browser Preferences),
    // so settings is palette-only there.
    for (const host of [SHELL_OTHER, BROWSER_OTHER]) {
      expect(byId(resolved(host), "settings-open")).toMatchObject({
        code: "Comma",
        tier: "shifted",
        enabled: true,
      });
    }
    expect(byId(resolved(SHELL_MAC), "settings-open")).toMatchObject({
      code: "Comma",
      tier: "cmd",
      enabled: true,
    });
    expect(byId(resolved(BROWSER_MAC), "settings-open")).toMatchObject({
      code: "Comma",
      tier: "cmd",
      enabled: false,
      disabledReason: "reserved",
    });
  });

  it("a mac-browser ⌘, default resolves reserved; the mac-shell default stays enabled (260801-mqim)", () => {
    // Browser host: ⌘, is the browser's Preferences accelerator — claimed
    // data disables the canonical default rather than firing it.
    expect(byId(resolved(BROWSER_MAC), "settings-open")).toMatchObject({
      enabled: false,
      disabledReason: "reserved",
    });
    // Shell host: the same combo IS the shipped default — enabled and default.
    expect(byId(resolved(SHELL_MAC), "settings-open")).toMatchObject({
      enabled: true,
      isDefault: true,
    });
  });

  it("migrates the surviving legacy chords with combos unchanged", () => {
    expect(byId(resolved(), "command-palette")).toMatchObject({ code: "KeyK", tier: "cmd" });
    expect(byId(resolved(), "layout-cycle")).toMatchObject({ code: "Semicolon", tier: "cmd", scope: "terminal" });
    // The ⌘. lens cycle is retired and `Period` is deliberately unbound on
    // every tier — a reflex-hit Cancel/Stop chord kept landing users in the
    // Chat lens. No default row may occupy the keycap.
    expect(resolved().find((b) => b.actionId === "view-cycle")).toBeUndefined();
    for (const host of ALL_HOSTS) {
      expect(resolved(host).some((b) => b.code === "Period")).toBe(false);
    }
    // 260813-j3jb: the Ctrl+` `layout-zoom` row is removed (it collided with
    // code-server's own Ctrl+`); the zoom ACTION survives via palette + ⛶ verb.
    expect(resolved().find((b) => b.actionId === "layout-zoom")).toBeUndefined();
    expect(resolved().find((b) => b.actionId === "chat-toggle")).toBeUndefined();
    expect(byId(resolved(), "board-cycle-next")).toMatchObject({ code: "BracketRight", tier: "cmd", scope: "board" });
    expect(byId(resolved(), "board-cycle-prev")).toMatchObject({ code: "BracketLeft", tier: "cmd", scope: "board" });
  });

  it("sidebar-toggle: the B keycap — ⌘B on mac in BOTH hosts, ⇧Ctrl+B on Win/Linux", () => {
    const def = DEFAULT_BINDINGS.find((b) => b.actionId === "sidebar-toggle");
    expect(def).toEqual({
      actionId: "sidebar-toggle",
      code: "KeyB",
      tier: "shifted",
      macTier: "cmd",
      scope: "global",
      kind: "builtin",
      label: "Toggle sidebar",
      mapLabel: "sidebar",
      ignoreInputs: true,
    });
    // Both mac hosts: ⌘B is preventDefault-interceptable in a mac browser.
    for (const host of [SHELL_MAC, BROWSER_MAC]) {
      expect(byId(resolved(host), "sidebar-toggle")).toMatchObject({
        code: "KeyB",
        tier: "cmd",
        enabled: true,
        isDefault: true,
      });
      expect(
        findMatches(chord({ code: "KeyB", metaKey: true }), resolved(host)).map((b) => b.actionId),
      ).toEqual(["sidebar-toggle"]);
    }
    for (const host of [SHELL_OTHER, BROWSER_OTHER]) {
      const bindings = resolved(host);
      expect(byId(bindings, "sidebar-toggle")).toMatchObject({
        code: "KeyB",
        tier: "shifted",
        enabled: true,
        isDefault: true,
      });
      expect(
        findMatches(chord({ code: "KeyB", shiftKey: true, ctrlKey: true }), bindings).map(
          (b) => b.actionId,
        ),
      ).toEqual(["sidebar-toggle"]);
      // Plain Ctrl+B matches nothing — readline back-char / nested-tmux
      // prefix stays with the pane.
      expect(findMatches(chord({ code: "KeyB", ctrlKey: true }), bindings)).toEqual([]);
    }
  });

  it("Backslash/cmd is no longer a shipped default in any host (a user override may still bind it)", () => {
    for (const host of ALL_HOSTS) {
      expect(resolved(host).some((b) => b.code === "Backslash" && b.tier === "cmd")).toBe(false);
    }
    const rebound = resolveBindings(
      DEFAULT_BINDINGS,
      { "sidebar-toggle": { code: "Backslash", tier: "cmd" } },
      SHELL_OTHER,
    );
    expect(byId(rebound, "sidebar-toggle")).toMatchObject({
      code: "Backslash",
      tier: "cmd",
      enabled: true,
      isDefault: false,
    });
  });

  it("surface digits: tty/code/web on Digit1/2/3 — ⌘ on mac, ⇧Ctrl on Win/Linux; KeyJ reclaimed by quake-terminal", () => {
    const def = DEFAULT_BINDINGS.find((b) => b.actionId === "code-toggle");
    // Full-row equality: the recoded row keeps its shape, code aside.
    expect(def).toEqual({
      actionId: "code-toggle",
      code: "Digit2",
      tier: "shifted",
      macTier: "cmd",
      scope: "terminal",
      kind: "builtin",
      label: "Toggle code editor",
      description: "open/close the code tile",
      mapLabel: "code",
      ignoreInputs: true,
    });
    // KeyJ belongs to exactly one row — quake-terminal's default (the
    // sidebar-toggle class: ⇧Ctrl+J base, ⌘J mac demotion, global,
    // ignoreInputs).
    expect(DEFAULT_BINDINGS.find((b) => b.actionId === "quake-terminal")).toEqual({
      actionId: "quake-terminal",
      code: "KeyJ",
      tier: "shifted",
      macTier: "cmd",
      scope: "global",
      kind: "builtin",
      label: "Quake terminal",
      description: "toggle the quake terminal (open+focus ⇄ closed)",
      mapLabel: "quake",
      ignoreInputs: true,
    });
    expect(
      DEFAULT_BINDINGS.filter((b) => b.code === "KeyJ" || b.macCode === "KeyJ").map(
        (b) => b.actionId,
      ),
    ).toEqual(["quake-terminal"]);
    for (const [id, code, mapLabel] of [
      ["tty-toggle", "Digit1", "tty"],
      ["web-toggle", "Digit3", "web"],
      ["gui-toggle", "Digit4", "gui"],
      ["review-toggle", "Digit5", "chg"],
      ["diff-toggle", "Digit6", "wrk"],
    ] as const) {
      expect(DEFAULT_BINDINGS.find((b) => b.actionId === id)).toMatchObject({
        actionId: id,
        code,
        tier: "shifted",
        macTier: "cmd",
        scope: "terminal",
        kind: "builtin",
        mapLabel,
        ignoreInputs: true,
      });
    }
    // Mac shell: the ⌘ tier, enabled and default.
    for (const [id, code] of [
      ["tty-toggle", "Digit1"],
      ["code-toggle", "Digit2"],
      ["web-toggle", "Digit3"],
      ["gui-toggle", "Digit4"],
      ["review-toggle", "Digit5"],
      ["diff-toggle", "Digit6"],
    ] as const) {
      expect(byId(resolved(SHELL_MAC), id)).toMatchObject({
        code,
        tier: "cmd",
        enabled: true,
        isDefault: true,
      });
      expect(byId(resolved(SHELL_OTHER), id)).toMatchObject({
        code,
        tier: "shifted",
        enabled: true,
        isDefault: true,
      });
      expect(byId(resolved(BROWSER_OTHER), id)).toMatchObject({
        code,
        tier: "shifted",
        enabled: true,
        isDefault: true,
      });
    }
    // Mac browser: ⌘1–9 are the browser's tab accelerators (the cmd-tier
    // claims) — all four resolve reserved and stay palette-reachable.
    for (const id of ["tty-toggle", "code-toggle", "web-toggle", "gui-toggle", "review-toggle", "diff-toggle"]) {
      expect(byId(resolved(BROWSER_MAC), id)).toMatchObject({
        tier: "cmd",
        enabled: false,
        disabledReason: "reserved",
      });
    }
    // Dispatch: ⇧Ctrl+2 matches ONLY code-toggle on win/linux; ⌘2 the same in
    // the mac shell.
    expect(
      findMatches(chord({ code: "Digit2", shiftKey: true, ctrlKey: true }), resolved(SHELL_OTHER)).map(
        (b) => b.actionId,
      ),
    ).toEqual(["code-toggle"]);
    expect(
      findMatches(chord({ code: "Digit2", metaKey: true }), resolved(SHELL_MAC)).map(
        (b) => b.actionId,
      ),
    ).toEqual(["code-toggle"]);
    // gui-toggle (⌘4/⇧Ctrl+4): the full row, tier exclusivity on both
    // platforms, and no other binding on Digit4 (code or macCode).
    expect(DEFAULT_BINDINGS.find((b) => b.actionId === "gui-toggle")).toEqual({
      actionId: "gui-toggle",
      code: "Digit4",
      tier: "shifted",
      macTier: "cmd",
      scope: "terminal",
      kind: "builtin",
      label: "Toggle GUI",
      description: "open/close the GUI tile",
      mapLabel: "gui",
      ignoreInputs: true,
    });
    expect(
      DEFAULT_BINDINGS.filter((b) => b.code === "Digit4" || b.macCode === "Digit4").map(
        (b) => b.actionId,
      ),
    ).toEqual(["gui-toggle"]);
    expect(
      findMatches(chord({ code: "Digit4", shiftKey: true, ctrlKey: true }), resolved(SHELL_OTHER)).map(
        (b) => b.actionId,
      ),
    ).toEqual(["gui-toggle"]);
    expect(
      findMatches(chord({ code: "Digit4", metaKey: true }), resolved(SHELL_MAC)).map(
        (b) => b.actionId,
      ),
    ).toEqual(["gui-toggle"]);
    // Dispatch: KeyJ resolves to quake-terminal on every host — ⌘J on both
    // mac hosts (the cmd-tier demotion; no browser claim on ⌘J), ⇧Ctrl+J on
    // win/linux, where plain Ctrl+J stays with the pane (readline). On mac the
    // demotion moves the default off the shifted tier, so ⇧⌘J matches nothing.
    for (const host of [SHELL_OTHER, BROWSER_OTHER]) {
      expect(
        findMatches(chord({ code: "KeyJ", shiftKey: true, ctrlKey: true }), resolved(host)).map(
          (b) => b.actionId,
        ),
      ).toEqual(["quake-terminal"]);
      expect(findMatches(chord({ code: "KeyJ", ctrlKey: true }), resolved(host))).toEqual([]);
    }
    for (const host of [SHELL_MAC, BROWSER_MAC]) {
      expect(
        findMatches(chord({ code: "KeyJ", metaKey: true }), resolved(host)).map((b) => b.actionId),
      ).toEqual(["quake-terminal"]);
      expect(
        findMatches(chord({ code: "KeyJ", metaKey: true, shiftKey: true }), resolved(host)),
      ).toEqual([]);
    }
  });

  it("zen-toggle: Enter, shifted on BOTH platforms, terminal scope, ignoreInputs", () => {
    const def = DEFAULT_BINDINGS.find((b) => b.actionId === "zen-toggle");
    expect(def).toEqual({
      actionId: "zen-toggle",
      code: "Enter",
      tier: "shifted",
      scope: "terminal",
      kind: "builtin",
      label: "Toggle zen mode",
      description: "hide top bar + sidebar; expand the focused tile",
      ignoreInputs: true,
    });
    for (const host of ALL_HOSTS) {
      expect(byId(resolved(host), "zen-toggle")).toMatchObject({
        code: "Enter",
        tier: "shifted",
        enabled: true,
        isDefault: true,
      });
    }
    // ⇧⌘⏎ / ⇧Ctrl+Enter match zen-toggle alone — exact-modifier matching
    // keeps the chord disjoint from the classifier-owned ⌘Enter/Ctrl+Enter
    // compose-submit chords (no registry row; they never carry Shift).
    expect(
      findMatches(chord({ code: "Enter", metaKey: true, shiftKey: true }), resolved(SHELL_MAC)).map(
        (b) => b.actionId,
      ),
    ).toEqual(["zen-toggle"]);
    expect(
      findMatches(chord({ code: "Enter", ctrlKey: true, shiftKey: true }), resolved(SHELL_OTHER)).map(
        (b) => b.actionId,
      ),
    ).toEqual(["zen-toggle"]);
    for (const host of ALL_HOSTS) {
      expect(findMatches(chord({ code: "Enter", metaKey: true }), resolved(host))).toEqual([]);
      expect(findMatches(chord({ code: "Enter", ctrlKey: true }), resolved(host))).toEqual([]);
    }
  });

  it("focus-hop: Backquote — the first shipped ctrl-tier default (mac ⌃`), ⇧Ctrl+` on Win/Linux", () => {
    const def = DEFAULT_BINDINGS.find((b) => b.actionId === "focus-hop");
    expect(def).toEqual({
      actionId: "focus-hop",
      code: "Backquote",
      tier: "shifted",
      macTier: "ctrl",
      scope: "terminal",
      kind: "builtin",
      label: "Focus terminal ↔ code",
      description: "hop focus between the tty and code tiles",
    });
    // No mapLabel: Backquote has no keycap cell in the overlay grids.
    for (const host of [SHELL_MAC, BROWSER_MAC]) {
      const bindings = resolved(host);
      expect(byId(bindings, "focus-hop")).toMatchObject({
        code: "Backquote",
        tier: "ctrl",
        enabled: true,
        isDefault: true,
      });
      expect(
        findMatches(chord({ code: "Backquote", ctrlKey: true }), bindings).map((b) => b.actionId),
      ).toEqual(["focus-hop"]);
    }
    for (const host of [SHELL_OTHER, BROWSER_OTHER]) {
      const bindings = resolved(host);
      expect(byId(bindings, "focus-hop")).toMatchObject({
        code: "Backquote",
        tier: "shifted",
        enabled: true,
        isDefault: true,
      });
      // Plain Ctrl+` matches NOTHING off mac — the pane owns plain Ctrl there.
      expect(findMatches(chord({ code: "Backquote", ctrlKey: true }), bindings)).toEqual([]);
      expect(
        findMatches(chord({ code: "Backquote", shiftKey: true, ctrlKey: true }), bindings).map(
          (b) => b.actionId,
        ),
      ).toEqual(["focus-hop"]);
    }
  });

  it("reserves KeyP unbound on every tier and host (a future PR action's keycap)", () => {
    expect(DEFAULT_BINDINGS.some((b) => b.code === "KeyP" || b.macCode === "KeyP")).toBe(false);
    for (const host of ALL_HOSTS) {
      expect(resolved(host).some((b) => b.code === "KeyP")).toBe(false);
    }
  });

  it("terminal-find: KeyF — ⇧Ctrl+F base, ⌘F mac demotion, terminal scope, ttyOnly", () => {
    const def = DEFAULT_BINDINGS.find((b) => b.actionId === "terminal-find");
    // Full-row equality: the tty find row is a do-not-move constraint (plain
    // Ctrl+F stays the pane's readline forward-char on Win/Linux).
    expect(def).toEqual({
      actionId: "terminal-find",
      code: "KeyF",
      tier: "shifted",
      macTier: "cmd",
      scope: "terminal",
      kind: "builtin",
      label: "Find in terminal",
      description: "search the terminal buffer",
      mapLabel: "find",
      ignoreInputs: true,
      ttyOnly: true,
    });
    // Mac hosts: the ⌘F demotion — the same chord web-find claims, disjoint
    // by surface gate (the gates decide which handler is present).
    for (const host of [SHELL_MAC, BROWSER_MAC]) {
      const bindings = resolved(host);
      expect(byId(bindings, "terminal-find")).toMatchObject({
        code: "KeyF",
        tier: "cmd",
        enabled: true,
        isDefault: true,
        ttyOnly: true,
      });
      expect(
        findMatches(chord({ code: "KeyF", metaKey: true }), bindings).map((b) => b.actionId),
      ).toEqual(["web-find", "terminal-find"]);
    }
    // Win/Linux: ⇧Ctrl+F is the find chord; plain Ctrl+F matches ONLY the
    // cmd-tier web-find (whose webOnly gate keeps it inert under tty focus).
    for (const host of [SHELL_OTHER, BROWSER_OTHER]) {
      const bindings = resolved(host);
      expect(byId(bindings, "terminal-find")).toMatchObject({
        code: "KeyF",
        tier: "shifted",
        enabled: true,
        isDefault: true,
      });
      expect(
        findMatches(chord({ code: "KeyF", shiftKey: true, ctrlKey: true }), bindings).map(
          (b) => b.actionId,
        ),
      ).toEqual(["terminal-find"]);
      expect(
        findMatches(chord({ code: "KeyF", ctrlKey: true }), bindings).map((b) => b.actionId),
      ).toEqual(["web-find"]);
    }
  });

  it("host-menu-open: ⇧⌘H/⇧Ctrl+H — shifted KeyH everywhere, global, no mac refinement", () => {
    const def = DEFAULT_BINDINGS.find((b) => b.actionId === "host-menu-open");
    // Full-row equality: the no-refinement shape is a do-not-move constraint —
    // ⌘H is the mac shell's hide accelerator and the mac-browser system
    // hide claim, so the chord must stay on the shifted tier on mac.
    expect(def).toEqual({
      actionId: "host-menu-open",
      code: "KeyH",
      tier: "shifted",
      scope: "global",
      kind: "builtin",
      label: "Host switcher",
      description: "open the hosts menu",
      mapLabel: "hosts",
    });
    // Shifted KeyH carries no claim in any host, so the binding resolves
    // enabled everywhere (the handler-presence gate — the strip's shell-only
    // mount — is what keeps the chord inert in browsers, not a reservation).
    for (const host of ALL_HOSTS) {
      expect(byId(resolved(host), "host-menu-open")).toMatchObject({
        code: "KeyH",
        tier: "shifted",
        enabled: true,
        isDefault: true,
      });
    }
  });

  it("window-prev/window-next: ⇧Ctrl+↑/↓ base with a ⌘↑/⌘↓ mac demotion in BOTH mac hosts", () => {
    const prev = DEFAULT_BINDINGS.find((b) => b.actionId === "window-prev");
    const next = DEFAULT_BINDINGS.find((b) => b.actionId === "window-next");
    // Full-row equality: the macTier demotion applying on BOTH mac hosts is
    // the do-not-move shape — mac-browser ⌘↑/⌘↓ is the page-interceptable
    // scroll-to-top/bottom class, so no claim row and no shell gate.
    expect(prev).toEqual({
      actionId: "window-prev",
      code: "ArrowUp",
      tier: "shifted",
      macTier: "cmd",
      scope: "global",
      kind: "builtin",
      label: "Previous tab",
      mapLabel: "prev tab",
      ignoreInputs: true,
    });
    expect(next).toEqual({
      actionId: "window-next",
      code: "ArrowDown",
      tier: "shifted",
      macTier: "cmd",
      scope: "global",
      kind: "builtin",
      label: "Next tab",
      mapLabel: "next tab",
      ignoreInputs: true,
    });
    for (const host of [SHELL_MAC, BROWSER_MAC]) {
      expect(byId(resolved(host), "window-prev")).toMatchObject({
        code: "ArrowUp",
        tier: "cmd",
        enabled: true,
        isDefault: true,
      });
      expect(byId(resolved(host), "window-next")).toMatchObject({
        code: "ArrowDown",
        tier: "cmd",
        enabled: true,
        isDefault: true,
      });
    }
    for (const host of [SHELL_OTHER, BROWSER_OTHER]) {
      expect(byId(resolved(host), "window-prev")).toMatchObject({
        code: "ArrowUp",
        tier: "shifted",
        enabled: true,
        isDefault: true,
      });
      expect(byId(resolved(host), "window-next")).toMatchObject({
        code: "ArrowDown",
        tier: "shifted",
        enabled: true,
        isDefault: true,
      });
    }
  });

  it("session-prev/session-next: ⇧Ctrl+←/→ base, ⇧⌘↑/⇧⌘↓ on mac via macCode-stays-shifted", () => {
    const prev = DEFAULT_BINDINGS.find((b) => b.actionId === "session-prev");
    const next = DEFAULT_BINDINGS.find((b) => b.actionId === "session-next");
    // macCode refines the code only — the tier STAYS shifted on mac so the
    // pair is tier-disjoint from the window pair's ⌘↑/⌘↓ on the same codes
    // (the split-pair precedent), keeping findConflicts clean.
    expect(prev).toEqual({
      actionId: "session-prev",
      code: "ArrowLeft",
      tier: "shifted",
      macCode: "ArrowUp",
      scope: "global",
      kind: "builtin",
      label: "Previous session",
      description: "jump to the adjacent session's active window",
      mapLabel: "prev session",
      ignoreInputs: true,
    });
    expect(next).toEqual({
      actionId: "session-next",
      code: "ArrowRight",
      tier: "shifted",
      macCode: "ArrowDown",
      scope: "global",
      kind: "builtin",
      label: "Next session",
      description: "jump to the adjacent session's active window",
      mapLabel: "next session",
      ignoreInputs: true,
    });
    for (const host of [SHELL_MAC, BROWSER_MAC]) {
      expect(byId(resolved(host), "session-prev")).toMatchObject({
        code: "ArrowUp",
        tier: "shifted",
        enabled: true,
        isDefault: true,
      });
      expect(byId(resolved(host), "session-next")).toMatchObject({
        code: "ArrowDown",
        tier: "shifted",
        enabled: true,
        isDefault: true,
      });
      // ⇧⌘↑ hits ONLY session-prev; ⌘↑ hits ONLY window-prev (tier-disjoint).
      expect(
        findMatches(chord({ code: "ArrowUp", metaKey: true, shiftKey: true }), resolved(host)).map(
          (b) => b.actionId,
        ),
      ).toEqual(["session-prev"]);
      expect(
        findMatches(chord({ code: "ArrowUp", metaKey: true }), resolved(host)).map(
          (b) => b.actionId,
        ),
      ).toEqual(["window-prev"]);
    }
    for (const host of [SHELL_OTHER, BROWSER_OTHER]) {
      expect(byId(resolved(host), "session-prev")).toMatchObject({
        code: "ArrowLeft",
        tier: "shifted",
        enabled: true,
        isDefault: true,
      });
      expect(byId(resolved(host), "session-next")).toMatchObject({
        code: "ArrowRight",
        tier: "shifted",
        enabled: true,
        isDefault: true,
      });
      expect(
        findMatches(chord({ code: "ArrowLeft", ctrlKey: true, shiftKey: true }), resolved(host)).map(
          (b) => b.actionId,
        ),
      ).toEqual(["session-prev"]);
    }
  });

  it("shifted KeyL and KeyM are unbound on every host after the moves", () => {
    for (const host of ALL_HOSTS) {
      const bindings = resolved(host);
      expect(findMatches(chord({ code: "KeyL", shiftKey: true, ctrlKey: true }), bindings)).toEqual([]);
      expect(findMatches(chord({ code: "KeyL", shiftKey: true, metaKey: true }), bindings)).toEqual([]);
      expect(findMatches(chord({ code: "KeyM", shiftKey: true, ctrlKey: true }), bindings)).toEqual([]);
      expect(findMatches(chord({ code: "KeyM", shiftKey: true, metaKey: true }), bindings)).toEqual([]);
    }
  });

  it("ships layout-cycle on ⌘; (260812-ab5v R9/R11) — the ▦ chip's template cycle", () => {
    expect(byId(resolved(), "layout-cycle")).toMatchObject({
      code: "Semicolon",
      tier: "cmd",
      scope: "terminal",
      enabled: true,
    });
    // A ⌘; keydown matches ONLY layout-cycle (Semicolon is free in every
    // claimed set; the ⌘<punctuation> siblings live on other codes).
    const cmdSemicolon = chord({ code: "Semicolon", metaKey: true });
    expect(findMatches(cmdSemicolon, resolved()).map((b) => b.actionId)).toEqual(["layout-cycle"]);
  });

  it("ships conflict-free defaults in every host", () => {
    for (const host of ALL_HOSTS) {
      expect(findConflicts(resolved(host))).toEqual([]);
    }
  });

  it("keeps ⌘K firing in inputs (ignoreInputs) — byte-identical migration", () => {
    expect(byId(resolved(), "command-palette").ignoreInputs).toBe(true);
  });

  it("the navigation family punches through text inputs (ignoreInputs on all six rows)", () => {
    // The desktop restore router lands first-visit focus in the compose
    // textarea, so a navigation chord's next press targets a TEXTAREA; the set
    // is pinned as a contract so a row edit that drops the flag fails loudly.
    for (const id of ["window-prev", "window-next", "session-prev", "session-next", "go-back", "go-forward"]) {
      for (const host of ALL_HOSTS) {
        expect(byId(resolved(host), id).ignoreInputs, `${id} on ${host.platform}/${host.shell ? "shell" : "browser"}`).toBe(true);
      }
    }
  });
});

describe("palette parity invariant", () => {
  // Palette lists are runtime-built, so this static map mirrors them: every
  // DEFAULT_BINDINGS actionId resolves to palette entry id(s) — either the
  // entry whose id IS the actionId (the `withShortcutHints` join) or a
  // documented equivalence. Equivalences (entry id ≠ actionId):
  //   compose-toggle ⇄ text-input ("Compose: Toggle" — the strip toggle body)
  //                    + compose-focus ("Compose: Focus" — the show+focus arm,
  //                    added with the palette gap-fill phase)
  //   code-toggle    ⇄ tile-show-code / tile-hide-code
  //   tty-toggle     ⇄ tile-show-tty / tile-hide-tty / tile-focus-tty
  //   web-toggle     ⇄ tile-show-web / tile-hide-web / tile-focus-web
  //   zen-toggle     ⇄ view-zen-enter / view-zen-exit ("View: Enter/Exit Zen
  //                    Mode" — the full zen toggle, 260820-o8cr; `Layout:
  //                    Expand`/`Restore` remain as the expand-only verb)
  //   focus-hop      ⇄ tile-focus-tty / tile-focus-code
  // window-prev / window-next resolve to "Tab: Previous" / "Tab: Next",
  // session-prev / session-next to "Session: Previous" / "Session: Next",
  // and sidebar-toggle to "Sidebar: Toggle" (ids = actionIds, so the chord
  // hints attach) + sidebar-focus ("Sidebar: Focus") — all added with the
  // palette gap-fill phase; the map names them ahead of their runtime rows.
  const PALETTE_RESOLUTIONS: Record<string, readonly string[]> = {
    "create-session": ["create-session"], // Session: Create
    "create-window": ["create-window"], // Tab: Create
    "kill-window": ["kill-window"], // Tab: Kill
    "reopen-window": ["reopen-window"], // Tab: Reopen closed (stack-gated)
    "new-app-window": ["new-app-window"], // App: New Window (shell-gated)
    "close-app-window": ["close-app-window"], // App: Close Window (shell-gated)
    "compose-toggle": ["text-input", "compose-focus"],
    "open-last-used": ["open-last-used"], // Open: Last used
    "split-horizontal": ["split-horizontal"], // Window: Split Horizontal
    "split-vertical": ["split-vertical"], // Window: Split Vertical
    "window-prev": ["window-prev"],
    "window-next": ["window-next"],
    "session-prev": ["session-prev"],
    "session-next": ["session-next"],
    "go-back": ["go-back"], // Go: Back
    "go-forward": ["go-forward"], // Go: Forward
    "agent-next-waiting": ["agent-next-waiting"], // Agent: Next waiting
    "host-menu-open": ["host-menu-open"], // Host: Switcher
    "shortcuts-overlay": ["shortcuts-overlay"], // Help: Keyboard Shortcuts
    "settings-open": ["settings-open"], // Settings: Open
    "sidebar-toggle": ["sidebar-toggle", "sidebar-focus"],
    "quake-terminal": ["quake-terminal"], // Operator: Open quake terminal
    "code-toggle": ["tile-show-code", "tile-hide-code"],
    "tty-toggle": ["tile-show-tty", "tile-hide-tty", "tile-focus-tty"],
    "web-toggle": ["tile-show-web", "tile-hide-web", "tile-focus-web"],
    "gui-toggle": ["tile-show-gui", "tile-hide-gui", "tile-focus-gui"],
    "review-toggle": ["tile-show-review", "tile-hide-review", "tile-focus-review"],
    "diff-toggle": ["tile-show-diff", "tile-hide-diff", "tile-focus-diff"],
    "gui-zoom-in": ["gui-zoom-in"], // GUI: Zoom in
    "gui-zoom-out": ["gui-zoom-out"], // GUI: Zoom out
    "gui-zoom-fit": ["gui-zoom-fit"], // GUI: Zoom to fit
    "gui-capture-toggle": ["gui-capture-toggle"], // GUI: Capture/Release keyboard
    "web-capture-toggle": ["web-capture-toggle"], // Web: Capture/Release keyboard
    "zen-toggle": ["view-zen-enter", "view-zen-exit"],
    "focus-hop": ["tile-focus-tty", "tile-focus-code"],
    "web-find": ["web-find"], // Web: Find in page (260819-ie2i)
    "terminal-find": ["terminal-find"], // Terminal: Find
    "web-address": ["web-address"], // Web: Focus address bar (260819-v6y4)
    "layout-cycle": ["layout-cycle"], // Layout: Cycle Template
    "board-cycle-next": ["board-cycle-next"], // Board: pane cycle →
    "board-cycle-prev": ["board-cycle-prev"], // Board: pane cycle ←
  };

  // Documented no-entry cases: a binding whose action cannot live in the
  // palette at all, with the reason.
  const PALETTE_EXEMPT: Record<string, string> = {
    // The palette's own opener — no entry can open the list it lives in; the
    // palette mount reads the bindings itself for its local listener.
    "command-palette": "the palette cannot list its own opener",
    "command-palette-alt":
      "an alias fires the action it aliases — command-palette's own exemption covers it",
  };

  it("every DEFAULT_BINDINGS actionId resolves to a palette entry or a documented equivalence", () => {
    for (const b of DEFAULT_BINDINGS) {
      const entries = PALETTE_RESOLUTIONS[b.actionId];
      const exempt = PALETTE_EXEMPT[b.actionId];
      expect(
        entries ?? exempt,
        `${b.actionId} has no palette entry and no equivalence-map row — add one to PALETTE_RESOLUTIONS or document an exemption`,
      ).toBeDefined();
      if (entries) expect(entries.length, `${b.actionId} maps to no palette entry`).toBeGreaterThan(0);
    }
  });
});

describe("matchesCombo (tier modifier rules)", () => {
  const shifted = { code: "KeyL", tier: "shifted" as const };
  const cmd = { code: "KeyK", tier: "cmd" as const };
  const ctrl = { code: "Backquote", tier: "ctrl" as const };

  it("shifted requires Shift plus Meta OR Ctrl", () => {
    expect(matchesCombo(chord({ code: "KeyL", shiftKey: true, ctrlKey: true }), shifted)).toBe(true);
    expect(matchesCombo(chord({ code: "KeyL", shiftKey: true, metaKey: true }), shifted)).toBe(true);
    expect(matchesCombo(chord({ code: "KeyL", shiftKey: true }), shifted)).toBe(false);
    expect(matchesCombo(chord({ code: "KeyL", ctrlKey: true }), shifted)).toBe(false);
  });

  it("cmd requires Meta OR Ctrl WITHOUT Shift", () => {
    expect(matchesCombo(chord({ code: "KeyK", metaKey: true }), cmd)).toBe(true);
    expect(matchesCombo(chord({ code: "KeyK", ctrlKey: true }), cmd)).toBe(true);
    expect(matchesCombo(chord({ code: "KeyK", metaKey: true, shiftKey: true }), cmd)).toBe(false);
    expect(matchesCombo(chord({ code: "KeyK" }), cmd)).toBe(false);
  });

  it("ctrl requires plain Ctrl (no Meta, no Shift)", () => {
    expect(matchesCombo(chord({ code: "Backquote", ctrlKey: true }), ctrl)).toBe(true);
    expect(matchesCombo(chord({ code: "Backquote", metaKey: true }), ctrl)).toBe(false);
    expect(matchesCombo(chord({ code: "Backquote", ctrlKey: true, shiftKey: true }), ctrl)).toBe(false);
  });

  it("Alt excludes every tier", () => {
    expect(matchesCombo(chord({ code: "KeyL", shiftKey: true, ctrlKey: true, altKey: true }), shifted)).toBe(false);
    expect(matchesCombo(chord({ code: "KeyK", metaKey: true, altKey: true }), cmd)).toBe(false);
    expect(matchesCombo(chord({ code: "Backquote", ctrlKey: true, altKey: true }), ctrl)).toBe(false);
  });

  it("code mismatch never matches", () => {
    expect(matchesCombo(chord({ code: "KeyH", shiftKey: true, ctrlKey: true }), shifted)).toBe(false);
  });
});

describe("findMatches (single-chord resolution)", () => {
  it("returns the enabled binding for a matching chord", () => {
    const matches = findMatches(chord({ code: "ArrowDown", shiftKey: true, ctrlKey: true }), resolved());
    expect(matches.map((b) => b.actionId)).toEqual(["window-next"]);
  });

  it("skips disabled bindings", () => {
    const bindings = resolved(SHELL_OTHER, { "window-next": null });
    expect(findMatches(chord({ code: "ArrowDown", shiftKey: true, ctrlKey: true }), bindings)).toEqual([]);
  });
});

describe("resolveBindings", () => {
  it("applies a combo override and flags it non-default", () => {
    const bindings = resolved(SHELL_OTHER, {
      "window-next": { code: "KeyU", tier: "shifted" as const },
    });
    const next = byId(bindings, "window-next");
    expect(next).toMatchObject({ code: "KeyU", tier: "shifted", enabled: true, isDefault: false });
    // The default combo no longer matches anything.
    expect(findMatches(chord({ code: "ArrowDown", shiftKey: true, ctrlKey: true }), bindings)).toEqual([]);
    // The override combo matches the action.
    expect(findMatches(chord({ code: "KeyU", shiftKey: true, ctrlKey: true }), bindings)[0]?.actionId).toBe("window-next");
  });

  it("null override disables with reason 'user'", () => {
    const bindings = resolved(SHELL_OTHER, { "create-session": null });
    expect(byId(bindings, "create-session")).toMatchObject({
      enabled: false,
      disabledReason: "user",
      isDefault: false,
    });
  });

  it("browser hosts disable the reserved shifted N/T/W defaults, shell hosts do not", () => {
    const browser = resolved(BROWSER_OTHER);
    for (const id of ["create-session", "create-window", "kill-window"]) {
      expect(byId(browser, id)).toMatchObject({ enabled: false, disabledReason: "reserved" });
    }
    for (const id of ["window-prev", "window-next", "go-back", "go-forward", "agent-next-waiting", "shortcuts-overlay"]) {
      expect(byId(browser, id).enabled).toBe(true);
    }
    const shell = resolved(SHELL_OTHER);
    for (const id of ["create-session", "create-window", "kill-window"]) {
      expect(byId(shell, id).enabled).toBe(true);
    }
  });

  it("an override onto a browser-reserved key resolves disabled in a browser host", () => {
    const bindings = resolveBindings(
      DEFAULT_BINDINGS,
      { "window-next": { code: "KeyN", tier: "shifted" } },
      BROWSER_OTHER,
    );
    expect(byId(bindings, "window-next")).toMatchObject({ enabled: false, disabledReason: "reserved" });
  });

  it("an override off a reserved key re-enables the action in a browser host", () => {
    const bindings = resolveBindings(
      DEFAULT_BINDINGS,
      { "create-session": { code: "KeyG", tier: "shifted" } },
      BROWSER_OTHER,
    );
    expect(byId(bindings, "create-session")).toMatchObject({ code: "KeyG", enabled: true });
  });
});

describe("claimedKeys", () => {
  const codes = (platform: "mac" | "other", shell: boolean, tier: "shifted" | "cmd" | "ctrl") =>
    claimedKeys(platform, shell)
      .filter((c) => c.tier === tier)
      .map((c) => c.code);

  it("shifted claims: R everywhere, I/C/V win-linux, Q mac, mac screenshots — NO digit claims on any host", () => {
    // Mac: the switcher lives on ⌥⌘1–9 (outside every tier), so the shifted
    // tier carries NO shell digit claims — only the 3/4/5 screenshot system
    // claims below. Freed ⇧⌘1/2/6–9 are unclaimed future page real estate.
    const mac = codes("mac", true, "shifted");
    for (const n of [1, 2, 6, 7, 8, 9]) {
      expect(mac).not.toContain(`Digit${n}`);
    }
    expect(mac).toEqual(expect.arrayContaining(["Digit3", "Digit4", "Digit5"]));
    expect(mac).toContain("KeyR");
    expect(mac).toContain("KeyQ");
    expect(mac).not.toContain("KeyI");
    expect(mac).not.toContain("KeyC");
    // Win/linux: the switcher moved to Alt+1–9, likewise outside every tier
    // (Alt is no tier — the mac ⌥⌘ precedent), so the shifted digit claims
    // are gone with no replacement rows; the surface digits 1/2/3 now bind.
    const other = codes("other", true, "shifted");
    expect(other).toEqual(expect.arrayContaining(["KeyR", "KeyI", "KeyC", "KeyV"]));
    expect(other.filter((c) => c.startsWith("Digit"))).toEqual([]);
    expect(other).not.toContain("KeyQ");
  });

  it("mac ⇧⌘3/4/5 screenshot claims are system-owned and apply in both hosts; win/linux carries no shifted digit claims", () => {
    for (const shell of [true, false]) {
      const screenshots = claimedKeys("mac", shell).filter(
        (c) => c.tier === "shifted" && c.label === "screenshot",
      );
      expect(screenshots.map((c) => c.code).sort()).toEqual(["Digit3", "Digit4", "Digit5"]);
      expect(screenshots.every((c) => c.owner === "system")).toBe(true);
      const otherDigits = claimedKeys("other", shell).filter(
        (c) => c.tier === "shifted" && c.code.startsWith("Digit"),
      );
      expect(otherDigits).toHaveLength(0);
    }
  });

  it("adds browser-owned shifted N/T/W only outside the shell", () => {
    const inShell = claimedKeys("other", true);
    expect(inShell.some((c) => c.owner === "browser")).toBe(false);
    const inBrowser = claimedKeys("other", false).filter(
      (c) => c.owner === "browser" && c.tier === "shifted",
    );
    expect(inBrowser.map((c) => c.code).sort()).toEqual(["KeyN", "KeyT", "KeyW"]);
  });

  it("mac shell claims the ⌘ menu-accelerator set on the cmd tier plus the system ⌘` row (260730-n789, 260820-lfla)", () => {
    const macShellCmd = claimedKeys("mac", true).filter((c) => c.tier === "cmd");
    expect(macShellCmd.filter((c) => c.owner === "shell").map((c) => c.code).sort()).toEqual(
      ["Digit0", "Equal", "KeyA", "KeyC", "KeyH", "KeyM", "KeyQ", "KeyR", "KeyV", "KeyX", "KeyZ", "Minus"],
    );
    // ⌘` (macOS "Move focus to next window") is a system claim in BOTH mac
    // hosts — display + capture-warning data only; the ctrl-tier focus-hop
    // binding is disjoint.
    for (const shell of [true, false]) {
      const row = claimedKeys("mac", shell).find(
        (c) => c.tier === "cmd" && c.code === "Backquote",
      );
      expect(row).toMatchObject({ owner: "system", platform: "mac" });
    }
    // Win/linux carries no Backquote claim on any tier (focus-hop stays free).
    for (const shell of [true, false]) {
      expect(
        claimedKeys("other", shell).some((c) => c.code === "Backquote"),
      ).toBe(false);
    }
    // The demoted defaults' keys are NOT shell-claimed: guaranteed fall-through.
    for (const code of ["KeyN", "KeyT", "KeyW", "BracketLeft", "BracketRight", "Slash"]) {
      expect(macShellCmd.map((c) => c.code)).not.toContain(code);
    }
  });

  it("mac browser claims ⌘ N/T/W + tab digits as browser-owned, Q/H/M + Backquote as system", () => {
    const macBrowserCmd = claimedKeys("mac", false).filter((c) => c.tier === "cmd");
    const browserOwned = macBrowserCmd.filter((c) => c.owner === "browser").map((c) => c.code);
    expect(browserOwned).toEqual(
      expect.arrayContaining([
        "KeyN", "KeyT", "KeyW",
        // The full ⌘1–9 tab-digit set — this is what resolves the surface
        // digit bindings (tty/code/web) reserved in a mac browser. KeyL is
        // deliberately absent: ⌘L is web-address's page-interceptable chord
        // (260819-v6y4), no longer a browser claim.
        "Digit1", "Digit2", "Digit3", "Digit4", "Digit5",
        "Digit6", "Digit7", "Digit8", "Digit9",
      ]),
    );
    // ⌘L is NOT claimed (260819-v6y4): page-interceptable (the ⌘D/⌘J class),
    // and web-address's webOnly gate preserves the browser address bar
    // everywhere except web-tile focus.
    expect(browserOwned).not.toContain("KeyL");
    const systemOwned = macBrowserCmd.filter((c) => c.owner === "system").map((c) => c.code).sort();
    expect(systemOwned).toEqual(["Backquote", "KeyH", "KeyM", "KeyQ"]);
    // ⌘[/⌘]/⌘/ stay free — that is the whole demotion premise.
    for (const code of ["BracketLeft", "BracketRight", "Slash"]) {
      expect(macBrowserCmd.map((c) => c.code)).not.toContain(code);
    }
  });

  it("win/linux hosts carry NO cmd-tier claims (plain Ctrl is the pane's)", () => {
    expect(codes("other", true, "cmd")).toEqual([]);
    expect(codes("other", false, "cmd")).toEqual([]);
  });

  it("claims nothing on KeyB / KeyJ, and nothing on Backquote OUTSIDE the mac ⌘ tier (the aligned and retired keycaps stay free)", () => {
    for (const platform of ["mac", "other"] as const) {
      for (const shell of [true, false]) {
        const claims = claimedKeys(platform, shell);
        for (const code of ["KeyB", "KeyJ"]) {
          expect(claims.map((c) => c.code)).not.toContain(code);
        }
        // ⌘` is a mac cmd-tier SYSTEM claim (cycle app windows); the shifted
        // and ctrl tiers stay free on every host (focus-hop rides ctrl).
        expect(
          claims.some((c) => c.code === "Backquote" && c.tier !== "cmd"),
        ).toBe(false);
      }
    }
  });

  it("every pre-n789 claim carries tier 'shifted'", () => {
    for (const host of [true, false]) {
      for (const c of claimedKeys("other", host)) {
        expect(c.tier).toBe("shifted");
      }
    }
  });
});

describe("override storage", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("parseOverrides tolerates malformed JSON, non-object roots, and garbage entries", () => {
    expect(parseOverrides(null)).toEqual({});
    expect(parseOverrides("not json {")).toEqual({});
    expect(parseOverrides('"a string"')).toEqual({});
    expect(parseOverrides("[1,2]")).toEqual({});
    expect(
      parseOverrides(
        JSON.stringify({
          good: { code: "KeyU", tier: "shifted" },
          disabled: null,
          badTier: { code: "KeyU", tier: "hyper" },
          badShape: 42,
          emptyCode: { code: "", tier: "cmd" },
        }),
      ),
    ).toEqual({ good: { code: "KeyU", tier: "shifted" }, disabled: null });
  });

  it("parseOverrides maps a stored operator-console entry onto quake-terminal when no quake-terminal entry exists", () => {
    expect(parseOverrides('{"operator-console":null}')).toEqual({ "quake-terminal": null });
    expect(
      parseOverrides('{"operator-console":{"code":"KeyJ","tier":"shifted"}}'),
    ).toEqual({ "quake-terminal": { code: "KeyJ", tier: "shifted" } });
  });

  it("parseOverrides lets the quake-terminal entry win over a stored operator-console entry", () => {
    expect(
      parseOverrides('{"operator-console":{"code":"KeyJ","tier":"cmd"},"quake-terminal":null}'),
    ).toEqual({ "quake-terminal": null });
  });

  it("round-trips diffs and removes the key when the diff empties", () => {
    writeStoredOverrides({ "window-next": { code: "KeyU", tier: "shifted" } });
    expect(readStoredOverrides()).toEqual({ "window-next": { code: "KeyU", tier: "shifted" } });
    writeStoredOverrides({});
    expect(localStorage.getItem(KEYBINDINGS_STORAGE_KEY)).toBeNull();
    expect(readStoredOverrides()).toEqual({});
  });
});

describe("scopesOverlap / findConflicts", () => {
  it("global overlaps everything; terminal and board are disjoint", () => {
    expect(scopesOverlap("global", "board")).toBe(true);
    expect(scopesOverlap("terminal", "global")).toBe(true);
    expect(scopesOverlap("terminal", "terminal")).toBe(true);
    expect(scopesOverlap("terminal", "board")).toBe(false);
  });

  it("flags two enabled bindings on the same tier+code with overlapping scopes", () => {
    const bindings = resolveBindings(
      DEFAULT_BINDINGS,
      { "window-next": { code: "KeyA", tier: "shifted" } },
      SHELL_OTHER,
    );
    const conflicts = findConflicts(bindings);
    expect(conflicts).toHaveLength(1);
    expect([conflicts[0].a, conflicts[0].b].sort()).toEqual(["agent-next-waiting", "window-next"]);
  });

  it("does not flag the board ⌘[/⌘] pair against the global shifted [/] pair", () => {
    expect(findConflicts(resolved())).toEqual([]);
  });

  it("tiersCollide: cmd and ctrl collide (a plain Ctrl chord matches both); shifted is disjoint", () => {
    expect(tiersCollide("cmd", "ctrl")).toBe(true);
    expect(tiersCollide("ctrl", "cmd")).toBe(true);
    expect(tiersCollide("cmd", "cmd")).toBe(true);
    expect(tiersCollide("shifted", "cmd")).toBe(false);
    expect(tiersCollide("shifted", "ctrl")).toBe(false);
  });

  it("flags a cmd-tier binding masking a ctrl-tier one on the same code and scope", () => {
    // focus-hop ships the registry's one ctrl-tier default (mac ⌃`): a
    // layout-cycle override onto ⌘` collides with it — a plain Ctrl chord
    // matches both tiers, and both are terminal-scoped: a real conflict, not
    // a shadow.
    const bindings = resolveBindings(
      DEFAULT_BINDINGS,
      { "layout-cycle": { code: "Backquote", tier: "cmd" } },
      SHELL_MAC,
    );
    const conflicts = findConflicts(bindings);
    expect(conflicts).toHaveLength(1);
    expect([conflicts[0].a, conflicts[0].b].sort()).toEqual(["focus-hop", "layout-cycle"]);
  });

  it("ignores a stored override for an actionId no default carries (a stale `view-cycle` entry)", () => {
    // Per-device overrides outlive the rows they targeted; resolution walks
    // DEFAULT_BINDINGS, so an orphan key must neither throw, add a phantom
    // row, nor take part in conflict detection.
    const overrides = parseOverrides(JSON.stringify({ "view-cycle": { code: "Period", tier: "cmd" } }));
    expect(overrides).toEqual({ "view-cycle": { code: "Period", tier: "cmd" } });
    for (const host of ALL_HOSTS) {
      const bindings = resolveBindings(DEFAULT_BINDINGS, overrides, host);
      expect(bindings).toHaveLength(DEFAULT_BINDINGS.length);
      expect(bindings.find((b) => b.actionId === "view-cycle")).toBeUndefined();
      expect(bindings.some((b) => b.code === "Period")).toBe(false);
      expect(findConflicts(bindings)).toEqual([]);
    }
  });

  it("treats a same-combo global↔scoped pair as a shadow, not a conflict (260730-n789)", () => {
    // sidebar-toggle (global) overridden onto the colliding ⌘` combo against
    // focus-hop's mac ⌃` (terminal): scopes differ with one global → dispatch
    // precedence resolves it, no conflict.
    const bindings = resolveBindings(
      DEFAULT_BINDINGS,
      { "sidebar-toggle": { code: "Backquote", tier: "cmd" } },
      SHELL_MAC,
    );
    expect(findConflicts(bindings)).toEqual([]);
    // The shipped mac default map carries exactly this shape: board ⌘[/⌘]
    // (board scope) shadowing the demoted global back/forward.
    expect(findConflicts(resolved(SHELL_MAC))).toEqual([]);
  });

  it("treats a ttyOnly/webOnly pair sharing a combo as gate-disjoint; same-gate and ungated partners still flag", () => {
    // The shipped mac default: terminal-find (ttyOnly) and web-find (webOnly)
    // both resolve to ⌘F terminal scope — their handlers are never
    // simultaneously present, so the shared combo is coexistence.
    expect(findConflicts(resolved(SHELL_MAC))).toEqual([]);
    // An UNGATED binding overridden onto the same combo collides with BOTH
    // gated rows — gate disjointness never applies to an ungated partner.
    const ungated = resolveBindings(
      DEFAULT_BINDINGS,
      { "layout-cycle": { code: "KeyF", tier: "cmd" } },
      SHELL_MAC,
    );
    const ungatedConflicts = findConflicts(ungated);
    expect(ungatedConflicts).toHaveLength(2);
    expect(ungatedConflicts.flatMap((c) => [c.a, c.b]).sort()).toEqual([
      "layout-cycle",
      "layout-cycle",
      "terminal-find",
      "web-find",
    ]);
    // A SAME-GATE pair (both ttyOnly) genuinely conflicts: the handlers CAN
    // be simultaneously present under tty focus.
    const sameGate = resolveBindings(
      DEFAULT_BINDINGS,
      { "split-vertical": { code: "KeyF", tier: "cmd" } },
      SHELL_MAC,
    );
    const sameGateConflicts = findConflicts(sameGate);
    expect(sameGateConflicts).toHaveLength(1);
    expect([sameGateConflicts[0].a, sameGateConflicts[0].b].sort()).toEqual([
      "split-vertical",
      "terminal-find",
    ]);
  });
});

describe("captureFromEvent", () => {
  it("keeps capturing on modifier-only presses", () => {
    expect(captureFromEvent(chord({ code: "ShiftLeft", shiftKey: true }), "other")).toBeNull();
    expect(captureFromEvent(chord({ code: "ControlLeft", ctrlKey: true }), "other")).toBeNull();
    expect(captureFromEvent(chord({ code: "MetaRight", metaKey: true }), "mac")).toBeNull();
  });

  it("rejects Alt chords and bare keys (no tier models them)", () => {
    expect(captureFromEvent(chord({ code: "KeyU", altKey: true, ctrlKey: true, shiftKey: true }), "other")).toBeNull();
    expect(captureFromEvent(chord({ code: "KeyU" }), "other")).toBeNull();
    expect(captureFromEvent(chord({ code: "KeyU", shiftKey: true }), "other")).toBeNull();
  });

  it("derives the shifted tier from Shift+CmdOrCtrl", () => {
    expect(captureFromEvent(chord({ code: "KeyU", shiftKey: true, ctrlKey: true }), "other")).toEqual({
      code: "KeyU",
      tier: "shifted",
    });
    expect(captureFromEvent(chord({ code: "KeyU", shiftKey: true, metaKey: true }), "mac")).toEqual({
      code: "KeyU",
      tier: "shifted",
    });
  });

  it("reads Ctrl-without-Meta as ctrl on mac, cmd elsewhere (device-local)", () => {
    expect(captureFromEvent(chord({ code: "KeyB", ctrlKey: true }), "mac")).toEqual({
      code: "KeyB",
      tier: "ctrl",
    });
    expect(captureFromEvent(chord({ code: "KeyB", ctrlKey: true }), "other")).toEqual({
      code: "KeyB",
      tier: "cmd",
    });
    expect(captureFromEvent(chord({ code: "KeyB", metaKey: true }), "mac")).toEqual({
      code: "KeyB",
      tier: "cmd",
    });
  });
});

describe("applyCapture (steal-with-warning)", () => {
  it("assigns a free combo without a victim", () => {
    const { overrides, stolenFrom } = applyCapture(
      resolved(),
      {},
      "window-next",
      { code: "KeyU", tier: "shifted" },
      SHELL_OTHER,
    );
    expect(overrides).toEqual({ "window-next": { code: "KeyU", tier: "shifted" } });
    expect(stolenFrom).toBeNull();
  });

  it("steals from the enabled owner and unbinds it (null override)", () => {
    const { overrides, stolenFrom } = applyCapture(
      resolved(),
      {},
      "window-next",
      { code: "KeyA", tier: "shifted" },
      SHELL_OTHER,
    );
    expect(stolenFrom).toBe("agent-next-waiting");
    expect(overrides).toEqual({
      "window-next": { code: "KeyA", tier: "shifted" },
      "agent-next-waiting": null,
    });
  });

  it("steals across the colliding cmd/ctrl tiers on the same code", () => {
    // sidebar-toggle (global) captures ⌘` on a mac host — the chord matches
    // the same keydown as focus-hop's shipped ctrl-tier ⌃` (terminal scope),
    // so that row must be flagged and unbound instead of silently masked at
    // dispatch.
    const { overrides, stolenFrom } = applyCapture(
      resolved(SHELL_MAC),
      {},
      "sidebar-toggle",
      { code: "Backquote", tier: "cmd" },
      SHELL_MAC,
    );
    expect(stolenFrom).toBe("focus-hop");
    expect(overrides).toEqual({
      "sidebar-toggle": { code: "Backquote", tier: "cmd" },
      "focus-hop": null,
    });
  });

  it("does not steal across disjoint scopes", () => {
    // layout-cycle is terminal-scope; board-cycle-next owns cmd+BracketRight
    // in board scope — capturing it for layout-cycle must not unbind the board
    // pair.
    const { stolenFrom } = applyCapture(
      resolved(),
      {},
      "layout-cycle",
      { code: "BracketRight", tier: "cmd" },
      SHELL_OTHER,
    );
    expect(stolenFrom).toBeNull();
  });

  it("re-capturing the action's own default drops its diff entry", () => {
    const prior = { "window-next": { code: "KeyU", tier: "shifted" as const } };
    const { overrides } = applyCapture(
      resolveBindings(DEFAULT_BINDINGS, prior, SHELL_OTHER),
      prior,
      "window-next",
      { code: "ArrowDown", tier: "shifted" },
      SHELL_OTHER,
    );
    expect(overrides).toEqual({});
  });

  it("own-default recapture follows the moved codes: ⌘2/⌘I on mac, ⇧Ctrl+2 on win/linux", () => {
    // code-toggle recoded to Digit2 — re-capturing its new host default drops
    // the diff entry and steals from nobody on both platform families.
    const prior = { "code-toggle": { code: "KeyU", tier: "shifted" as const } };
    const mac = applyCapture(
      resolveBindings(DEFAULT_BINDINGS, prior, SHELL_MAC),
      prior,
      "code-toggle",
      { code: "Digit2", tier: "cmd" },
      SHELL_MAC,
    );
    expect(mac).toEqual({ overrides: {}, stolenFrom: null });
    const other = applyCapture(
      resolveBindings(DEFAULT_BINDINGS, prior, SHELL_OTHER),
      prior,
      "code-toggle",
      { code: "Digit2", tier: "shifted" },
      SHELL_OTHER,
    );
    expect(other).toEqual({ overrides: {}, stolenFrom: null });
    // ⇧Ctrl+J is quake-terminal's win/linux default: rebinding code-toggle
    // onto it stores the diff AND records the steal.
    const oldChord = applyCapture(
      resolveBindings(DEFAULT_BINDINGS, {}, SHELL_OTHER),
      {},
      "code-toggle",
      { code: "KeyJ", tier: "shifted" },
      SHELL_OTHER,
    );
    expect(oldChord.stolenFrom).toBe("quake-terminal");
    // The steal unbinds the victim: the diff carries code-toggle's new chord
    // plus quake-terminal's disablement (null).
    expect(oldChord.overrides).toEqual({
      "code-toggle": { code: "KeyJ", tier: "shifted" },
      "quake-terminal": null,
    });
    // compose-toggle's macCode refinement: ⌘I is its mac own-default; the old
    // ⇧⌘E (its win/linux default) is NOT its mac default — a real diff there.
    const composePrior = { "compose-toggle": { code: "KeyU", tier: "shifted" as const } };
    const composeMac = applyCapture(
      resolveBindings(DEFAULT_BINDINGS, composePrior, SHELL_MAC),
      composePrior,
      "compose-toggle",
      { code: "KeyI", tier: "cmd" },
      SHELL_MAC,
    );
    expect(composeMac).toEqual({ overrides: {}, stolenFrom: null });
    const composeOld = applyCapture(
      resolveBindings(DEFAULT_BINDINGS, {}, SHELL_MAC),
      {},
      "compose-toggle",
      { code: "KeyE", tier: "shifted" },
      SHELL_MAC,
    );
    expect(composeOld.stolenFrom).toBeNull();
    expect(composeOld.overrides).toEqual({ "compose-toggle": { code: "KeyE", tier: "shifted" } });
  });

  it("own-default detection is host-aware: ⌘/ is shortcuts-overlay's mac default (260730-n789)", () => {
    // On a mac host the demoted default is {Slash, cmd}; re-capturing it must
    // drop the diff, not store a "modified" entry.
    const prior = { "shortcuts-overlay": { code: "KeyO", tier: "shifted" as const } };
    const { overrides, stolenFrom } = applyCapture(
      resolveBindings(DEFAULT_BINDINGS, prior, SHELL_MAC),
      prior,
      "shortcuts-overlay",
      { code: "Slash", tier: "cmd" },
      SHELL_MAC,
    );
    expect(overrides).toEqual({});
    expect(stolenFrom).toBeNull();
    // On a win/linux host the same combo is NOT the default → stored as a diff.
    const other = applyCapture(
      resolveBindings(DEFAULT_BINDINGS, {}, SHELL_OTHER),
      {},
      "shortcuts-overlay",
      { code: "Slash", tier: "cmd" },
      SHELL_OTHER,
    );
    expect(other.overrides).toEqual({ "shortcuts-overlay": { code: "Slash", tier: "cmd" } });
  });

  it("re-capturing a shadowed mac default steals nothing from its shadow partner (260730-n789)", () => {
    // On mac hosts go-back/board-cycle-prev share ⌘[ and go-forward/
    // board-cycle-next share ⌘] (global↔board shadow, resolved by dispatch
    // precedence). A no-op re-capture of either partner's own default must
    // not unbind the other — all four directions.
    const pairs = [
      { actionId: "go-back", partner: "board-cycle-prev", code: "BracketLeft" },
      { actionId: "board-cycle-prev", partner: "go-back", code: "BracketLeft" },
      { actionId: "go-forward", partner: "board-cycle-next", code: "BracketRight" },
      { actionId: "board-cycle-next", partner: "go-forward", code: "BracketRight" },
    ] as const;
    for (const { actionId, partner, code } of pairs) {
      const { overrides, stolenFrom } = applyCapture(
        resolved(SHELL_MAC),
        {},
        actionId,
        { code, tier: "cmd" },
        SHELL_MAC,
      );
      expect(overrides, `${actionId} re-capture must write no diff`).toEqual({});
      expect(stolenFrom, `${actionId} re-capture must steal nothing`).toBeNull();
      const after = byId(resolveBindings(DEFAULT_BINDINGS, overrides, SHELL_MAC), partner);
      expect(after.enabled, `${partner} must stay bound`).toBe(true);
      expect({ code: after.code, tier: after.tier }).toEqual({ code, tier: "cmd" });
    }
  });

  it("a genuine capture onto a shadow partner's combo still steals (260730-n789)", () => {
    // ⌘[ is NOT go-forward's own default (⌘] is), so capturing it for
    // go-forward is a real rebind — the enabled owner is stolen from as usual
    // (go-back first in registry order; scopesOverlap global↔board keeps the
    // board partner a steal target too, per the Design Decision).
    const { overrides, stolenFrom } = applyCapture(
      resolved(SHELL_MAC),
      {},
      "go-forward",
      { code: "BracketLeft", tier: "cmd" },
      SHELL_MAC,
    );
    expect(stolenFrom).toBe("go-back");
    expect(overrides).toEqual({
      "go-forward": { code: "BracketLeft", tier: "cmd" },
      "go-back": null,
    });
  });
});

describe("formatting", () => {
  it("keyLabel maps codes to keycaps", () => {
    expect(keyLabel("KeyN")).toBe("N");
    expect(keyLabel("Digit3")).toBe("3");
    expect(keyLabel("BracketLeft")).toBe("[");
    expect(keyLabel("Slash")).toBe("/");
    expect(keyLabel("Backquote")).toBe("`");
    expect(keyLabel("F5")).toBe("F5");
  });

  it("formats per platform, keeping the historical hint spellings", () => {
    expect(formatCombo({ code: "KeyN", tier: "shifted" }, "mac")).toBe("⇧⌘N");
    expect(formatCombo({ code: "KeyN", tier: "shifted" }, "other")).toBe("Shift+Ctrl+N");
    expect(formatCombo({ code: "Period", tier: "cmd" }, "mac")).toBe("⌘.");
    expect(formatCombo({ code: "Period", tier: "cmd" }, "other")).toBe("Ctrl+.");
    expect(formatCombo({ code: "Backquote", tier: "ctrl" }, "mac")).toBe("Ctrl+`");
    expect(formatCombo({ code: "Backquote", tier: "ctrl" }, "other")).toBe("Ctrl+`");
  });

  it("comboParts renders keycap sequences", () => {
    expect(comboParts({ code: "KeyH", tier: "shifted" }, "mac")).toEqual(["⇧", "⌘", "H"]);
    expect(comboParts({ code: "KeyH", tier: "shifted" }, "other")).toEqual(["Shift", "Ctrl", "H"]);
    expect(comboParts({ code: "KeyK", tier: "cmd" }, "other")).toEqual(["Ctrl", "K"]);
  });
});

describe("shouldSuppressChord (shared input gating)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does NOT suppress on a null / non-element target", () => {
    expect(shouldSuppressChord(null)).toBe(false);
    expect(shouldSuppressChord(new EventTarget())).toBe(false);
  });

  it("suppresses on a real (non-xterm) INPUT / TEXTAREA / contenteditable", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    document.body.append(input, textarea, editable);
    expect(shouldSuppressChord(input)).toBe(true);
    expect(shouldSuppressChord(textarea)).toBe(true);
    expect(shouldSuppressChord(editable)).toBe(true);
  });

  it("does NOT suppress inside xterm's helper textarea (the terminal's normal focus)", () => {
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const helper = document.createElement("textarea");
    xterm.appendChild(helper);
    document.body.appendChild(xterm);
    expect(shouldSuppressChord(helper)).toBe(false);
  });

  it("does NOT suppress on a plain non-input element", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    expect(shouldSuppressChord(div)).toBe(false);
  });
});

describe("withShortcutHints", () => {
  const platform = "other" as const;

  it("decorates palette actions whose id has an enabled binding", () => {
    const byAction = new Map(resolved().map((b) => [b.actionId, b]));
    const actions = [
      { id: "create-window", label: "Tab: Create" },
      { id: "unrelated", label: "Something", shortcut: "F5" },
    ];
    const hinted = withShortcutHints(actions, byAction, platform);
    expect(hinted[0].shortcut).toBe("Shift+Ctrl+T");
    expect(hinted[1].shortcut).toBe("F5"); // untouched pass-through
  });

  it("renders no hint for disabled bindings (reserved or user-disabled)", () => {
    const byAction = new Map(resolved(BROWSER_OTHER).map((b) => [b.actionId, b]));
    const [entry] = withShortcutHints([{ id: "create-window", label: "Tab: Create" }], byAction, platform);
    expect(entry.shortcut).toBeUndefined();
  });

  it("reflects overrides", () => {
    const bindings = resolveBindings(
      DEFAULT_BINDINGS,
      { "window-next": { code: "KeyU", tier: "shifted" } },
      SHELL_OTHER,
    );
    const byAction = new Map(bindings.map((b) => [b.actionId, b]));
    const [entry] = withShortcutHints([{ id: "window-next", label: "x" }], byAction, platform);
    expect(entry.shortcut).toBe("Shift+Ctrl+U");
  });
});

describe("keyless (macro) defaults — 260730-hbyh", () => {
  // Macros enter resolution as ordinary defaults with `code: ""` (no shipped
  // combo — see lib/macros.ts `macroToBinding`); their combo lives solely in
  // the override diff map.
  const MACRO: KeyBinding = {
    actionId: "macro:discuss",
    code: "",
    tier: "shifted",
    scope: "global",
    kind: "macro",
    label: "riff: discuss",
  };
  const withMacro = [...DEFAULT_BINDINGS, MACRO];

  it("resolves unbound (disabled, reason 'user') without an override", () => {
    const bindings = resolveBindings(withMacro, {}, SHELL_OTHER);
    expect(byId(bindings, "macro:discuss")).toMatchObject({
      enabled: false,
      isDefault: false,
      disabledReason: "user",
    });
    expect(findMatches(chord({ code: "KeyD", shiftKey: true, ctrlKey: true }), bindings)).toEqual([]);
  });

  it("an override combo makes the macro live and matchable", () => {
    const bindings = resolveBindings(
      withMacro,
      { "macro:discuss": { code: "KeyD", tier: "shifted" } },
      SHELL_OTHER,
    );
    expect(byId(bindings, "macro:discuss")).toMatchObject({
      code: "KeyD",
      enabled: true,
      isDefault: false,
      kind: "macro",
    });
    expect(
      findMatches(chord({ code: "KeyD", shiftKey: true, ctrlKey: true }), bindings)[0]?.actionId,
    ).toBe("macro:discuss");
  });

  it("a macro combo on a browser-reserved key resolves disabled", () => {
    const bindings = resolveBindings(
      withMacro,
      { "macro:discuss": { code: "KeyN", tier: "shifted" } },
      BROWSER_OTHER,
    );
    expect(byId(bindings, "macro:discuss")).toMatchObject({
      enabled: false,
      disabledReason: "reserved",
    });
  });

  it("steals work in both directions between macros and builtins", () => {
    // Builtin captures the macro's combo → macro unbound.
    const macroOwns = { "macro:discuss": { code: "KeyD", tier: "shifted" as const } };
    const stealByBuiltin = applyCapture(
      resolveBindings(withMacro, macroOwns, SHELL_OTHER),
      macroOwns,
      "window-next",
      { code: "KeyD", tier: "shifted" },
      SHELL_OTHER,
      withMacro,
    );
    expect(stealByBuiltin.stolenFrom).toBe("macro:discuss");
    expect(stealByBuiltin.overrides).toEqual({
      "macro:discuss": null,
      "window-next": { code: "KeyD", tier: "shifted" },
    });

    // Macro captures a builtin's default combo → builtin unbound.
    const stealByMacro = applyCapture(
      resolveBindings(withMacro, {}, SHELL_OTHER),
      {},
      "macro:discuss",
      { code: "ArrowDown", tier: "shifted" },
      SHELL_OTHER,
      withMacro,
    );
    expect(stealByMacro.stolenFrom).toBe("window-next");
    expect(stealByMacro.overrides).toEqual({
      "window-next": null,
      "macro:discuss": { code: "ArrowDown", tier: "shifted" },
    });
  });

  it("keyless macro defaults are unaffected by mac hosts (defaultComboFor passthrough)", () => {
    const bindings = resolveBindings(withMacro, {}, SHELL_MAC);
    expect(byId(bindings, "macro:discuss")).toMatchObject({
      enabled: false,
      isDefault: false,
      disabledReason: "user",
    });
  });

  it("withShortcutHints decorates a bound macro and skips an unbound one", () => {
    const bound = resolveBindings(
      withMacro,
      { "macro:discuss": { code: "KeyD", tier: "shifted" } },
      SHELL_OTHER,
    );
    const byActionBound = new Map(bound.map((b) => [b.actionId, b]));
    const [hinted] = withShortcutHints(
      [{ id: "macro:discuss", label: "Macro: riff: discuss" }],
      byActionBound,
      "other",
    );
    expect(hinted.shortcut).toBe("Shift+Ctrl+D");

    const unbound = resolveBindings(withMacro, {}, SHELL_OTHER);
    const byActionUnbound = new Map(unbound.map((b) => [b.actionId, b]));
    const [unhinted] = withShortcutHints(
      [{ id: "macro:discuss", label: "Macro: riff: discuss" }],
      byActionUnbound,
      "other",
    );
    expect(unhinted.shortcut).toBeUndefined();
  });
});

describe("per-platform default tiers — 260730-n789", () => {
  it("mac shell: T/W and [/]// demote to the ⌘ tier along with the window arrows; A and the hosts chord stay shifted", () => {
    const bindings = resolved(SHELL_MAC);
    for (const id of ["create-window", "kill-window", "go-back", "go-forward", "shortcuts-overlay", "window-prev", "window-next"]) {
      expect(byId(bindings, id)).toMatchObject({ tier: "cmd", enabled: true, isDefault: true });
    }
    for (const id of ["agent-next-waiting", "host-menu-open"]) {
      expect(byId(bindings, id)).toMatchObject({ tier: "shifted", enabled: true, isDefault: true });
    }
    // Letters constant — only the modifier tier varies (the macCode rows —
    // reopen-window, the app-window pair, create-session's mac-keyless
    // refinement — are the exceptions, covered below).
    expect(byId(bindings, "go-back").code).toBe("BracketLeft");
  });

  it("mac shell: reopen-window rides ⇧⌘T (macCode); create-session is palette-only (mac-keyless); the app-window pair spends ⌘N/⇧⌘W", () => {
    const bindings = resolved(SHELL_MAC);
    // ⇧⌘T — tier-disjoint from create-window's ⌘T on one code (the
    // split-pair ⌘D/⇧⌘D shape), so findConflicts stays clean.
    expect(byId(bindings, "reopen-window")).toMatchObject({
      code: "KeyT",
      tier: "shifted",
      enabled: true,
      isDefault: true,
    });
    // create-session's mac-keyless refinement (`macCode: ""`) resolves
    // UNBOUND on the mac shell — palette-only; ⇧⌘N fires nothing.
    expect(byId(bindings, "create-session")).toMatchObject({
      enabled: false,
      disabledReason: "user",
    });
    expect(byId(bindings, "create-window")).toMatchObject({
      code: "KeyT",
      tier: "cmd",
      enabled: true,
    });
    // ⌘N / ⇧⌘W — the keyless-base bridge actions, bound in the shell only.
    expect(byId(bindings, "new-app-window")).toMatchObject({
      code: "KeyN",
      tier: "cmd",
      enabled: true,
      isDefault: true,
    });
    expect(byId(bindings, "close-app-window")).toMatchObject({
      code: "KeyW",
      tier: "shifted",
      enabled: true,
      isDefault: true,
    });
    // kill-window is unchanged (⌘W in-shell) and coexists with ⇧⌘W on one
    // code — the exact tier-disjoint shape the split pair ships on KeyD.
    expect(byId(bindings, "kill-window")).toMatchObject({
      code: "KeyW",
      tier: "cmd",
      enabled: true,
      isDefault: true,
    });
    expect(findMatches(chord({ code: "KeyW", metaKey: true }), bindings).map((b) => b.actionId))
      .toEqual(["kill-window"]);
  });

  it("mac browser: [/]// demote; the canonical N/T/W/, + app-window chords resolve browser-reserved", () => {
    const bindings = resolved(BROWSER_MAC);
    for (const id of ["go-back", "go-forward", "shortcuts-overlay"]) {
      expect(byId(bindings, id)).toMatchObject({ tier: "cmd", enabled: true, isDefault: true });
    }
    // The canonical mac chords — ⇧⌘T / ⌘T / ⌘W — are browser-owner claims,
    // so the defaults resolve reserved rather than firing.
    expect(byId(bindings, "reopen-window")).toMatchObject({
      code: "KeyT",
      tier: "shifted",
      enabled: false,
      disabledReason: "reserved",
    });
    expect(byId(bindings, "create-window")).toMatchObject({
      code: "KeyT",
      tier: "cmd",
      enabled: false,
      disabledReason: "reserved",
    });
    expect(byId(bindings, "kill-window")).toMatchObject({
      code: "KeyW",
      tier: "cmd",
      enabled: false,
      disabledReason: "reserved",
    });
    // create-session has NO mac chord (mac-keyless refinement): unbound, not
    // reserved — there is no combo left for a claim to shadow.
    expect(byId(bindings, "create-session")).toMatchObject({
      enabled: false,
      disabledReason: "user",
    });
    for (const id of ["window-prev", "window-next"]) {
      expect(byId(bindings, id)).toMatchObject({ tier: "cmd", enabled: true });
    }
    for (const id of ["session-prev", "session-next", "agent-next-waiting", "host-menu-open"]) {
      expect(byId(bindings, id)).toMatchObject({ tier: "shifted", enabled: true });
    }
    // The app-window pair gains its canonical ⌘N/⇧⌘W here too — reserved,
    // not unbound: the panel can teach the chord + desktop tag.
    expect(byId(bindings, "new-app-window")).toMatchObject({
      code: "KeyN",
      tier: "cmd",
      enabled: false,
      disabledReason: "reserved",
    });
    expect(byId(bindings, "close-app-window")).toMatchObject({
      code: "KeyW",
      tier: "shifted",
      enabled: false,
      disabledReason: "reserved",
    });
  });

  it("win/linux resolution is byte-identical to the uniform shifted tier (both hosts)", () => {
    for (const host of [SHELL_OTHER, BROWSER_OTHER]) {
      const bindings = resolved(host);
      for (const id of [
        "create-session", "create-window", "kill-window", "window-prev", "window-next",
        "go-back", "go-forward", "agent-next-waiting", "shortcuts-overlay",
      ]) {
        expect(byId(bindings, id).tier).toBe("shifted");
      }
    }
    // Browser-host N/T/W reservation unchanged.
    expect(byId(resolved(BROWSER_OTHER), "create-session").enabled).toBe(false);
    expect(byId(resolved(SHELL_OTHER), "create-session").enabled).toBe(true);
    // The keyless-base rows (the app-window pair, reopen-window) ship unbound
    // on every win/linux host (the app-window handler is bridge-gated absent
    // outside the mac shell anyway).
    for (const host of [SHELL_OTHER, BROWSER_OTHER]) {
      for (const id of ["new-app-window", "close-app-window", "reopen-window"]) {
        expect(byId(resolved(host), id)).toMatchObject({
          enabled: false,
          disabledReason: "user",
        });
      }
    }
  });

  it("defaultComboFor: mac refinements apply on every mac host, base tier elsewhere", () => {
    const goBack = DEFAULT_BINDINGS.find((b) => b.actionId === "go-back")!;
    const createSession = DEFAULT_BINDINGS.find((b) => b.actionId === "create-session")!;
    expect(defaultComboFor(goBack, SHELL_MAC)).toEqual({ code: "BracketLeft", tier: "cmd" });
    expect(defaultComboFor(goBack, BROWSER_MAC)).toEqual({ code: "BracketLeft", tier: "cmd" });
    expect(defaultComboFor(goBack, SHELL_OTHER)).toEqual({ code: "BracketLeft", tier: "shifted" });
    // One canonical chord per action: the mac default no longer varies by host.
    // create-session refines to a KEYLESS mac combo (`macCode: ""`) — palette-only
    // on both mac hosts, ⇧Ctrl+N untouched elsewhere.
    expect(defaultComboFor(createSession, SHELL_MAC)).toEqual({ code: "", tier: "shifted" });
    expect(defaultComboFor(createSession, BROWSER_MAC)).toEqual({ code: "", tier: "shifted" });
    expect(defaultComboFor(createSession, BROWSER_OTHER)).toEqual({ code: "KeyN", tier: "shifted" });
    // The app-window pair: keyless base (passthrough off mac), refined combos
    // on BOTH mac hosts.
    const newAppWindow = DEFAULT_BINDINGS.find((b) => b.actionId === "new-app-window")!;
    const closeAppWindow = DEFAULT_BINDINGS.find((b) => b.actionId === "close-app-window")!;
    expect(defaultComboFor(newAppWindow, SHELL_MAC)).toEqual({ code: "KeyN", tier: "cmd" });
    expect(defaultComboFor(newAppWindow, BROWSER_MAC)).toEqual({ code: "KeyN", tier: "cmd" });
    expect(defaultComboFor(newAppWindow, SHELL_OTHER)).toEqual({ code: "", tier: "shifted" });
    expect(defaultComboFor(closeAppWindow, SHELL_MAC)).toEqual({ code: "KeyW", tier: "shifted" });
    expect(defaultComboFor(closeAppWindow, BROWSER_MAC)).toEqual({ code: "KeyW", tier: "shifted" });
  });

  it("defaultComboFor: an empty-string macCode refines to the unbound combo on mac (no base-code fallback)", () => {
    const createSession = DEFAULT_BINDINGS.find((b) => b.actionId === "create-session")!;
    // `macCode: ""` is a REFINEMENT to keyless, not an absent refinement — a
    // truthiness test would fall back to the base KeyN and keep ⇧⌘N live in
    // the mac shell.
    for (const host of [SHELL_MAC, BROWSER_MAC]) {
      expect(defaultComboFor(createSession, host)).toEqual({ code: "", tier: "shifted" });
    }
    // Win/Linux never consults the refinement: ⇧Ctrl+N stands.
    expect(defaultComboFor(createSession, SHELL_OTHER)).toEqual({ code: "KeyN", tier: "shifted" });
  });

  it("stored-override shape is unchanged: a {code,tier} diff applies as-is on mac hosts", () => {
    // A mac user pinning go-back BACK to the shifted tier: plain diff entry.
    const bindings = resolveBindings(
      DEFAULT_BINDINGS,
      { "go-back": { code: "BracketLeft", tier: "shifted" } },
      SHELL_MAC,
    );
    expect(byId(bindings, "go-back")).toMatchObject({
      tier: "shifted",
      enabled: true,
      isDefault: false, // the mac default is the cmd tier
    });
  });

  it("mac-browser ⌘ browser claims disable overrides tier-aware; the mac shell frees them", () => {
    // KeyN stands in as the browser-claimed cmd-tier key (KeyL was unclaimed
    // in 260819-v6y4 — ⌘L is page-interceptable, bound by web-address).
    const overrides = { "window-next": { code: "KeyN", tier: "cmd" as const } };
    expect(byId(resolveBindings(DEFAULT_BINDINGS, overrides, BROWSER_MAC), "window-next")).toMatchObject({
      enabled: false,
      disabledReason: "reserved",
    });
    expect(byId(resolveBindings(DEFAULT_BINDINGS, overrides, SHELL_MAC), "window-next")).toMatchObject({
      enabled: true,
    });
    // Win/linux cmd-tier overrides are untouched by the mac claim set.
    expect(byId(resolveBindings(DEFAULT_BINDINGS, overrides, BROWSER_OTHER), "window-next")).toMatchObject({
      enabled: true,
    });
  });

  it("mac defaults dispatch: ⌘[ matches (board shadow first), ⇧⌘[ matches nothing", () => {
    const bindings = resolved(SHELL_MAC);
    // ⌘[ matches BOTH go-back and the board pane-cycle — scoped-first order
    // (the dispatcher then picks the first with a handler at its mount).
    expect(
      findMatches(chord({ code: "BracketLeft", metaKey: true }), bindings).map((b) => b.actionId),
    ).toEqual(["board-cycle-prev", "go-back"]);
    // ⌘/ is unshared: findMatches resolves the demoted overlay toggle alone.
    expect(
      findMatches(chord({ code: "Slash", metaKey: true }), bindings).map((b) => b.actionId),
    ).toEqual(["shortcuts-overlay"]);
    // The old shifted default no longer matches on mac (go-back moved tiers;
    // board-cycle-prev is cmd-tier and shifted-disjoint).
    expect(
      findMatches(chord({ code: "BracketLeft", metaKey: true, shiftKey: true }), bindings),
    ).toEqual([]);
    // Mac-shell chords: ⌘N matches new-app-window, ⇧⌘T reopen-window, ⇧⌘W
    // close-app-window; a mac browser matches nothing on any of them (the
    // canonical chords are all browser-reserved there).
    expect(
      findMatches(chord({ code: "KeyN", metaKey: true }), bindings)[0]?.actionId,
    ).toBe("new-app-window");
    expect(
      findMatches(chord({ code: "KeyT", metaKey: true, shiftKey: true }), bindings)[0]?.actionId,
    ).toBe("reopen-window");
    expect(
      findMatches(chord({ code: "KeyW", metaKey: true, shiftKey: true }), bindings)[0]?.actionId,
    ).toBe("close-app-window");
    expect(findMatches(chord({ code: "KeyN", metaKey: true }), resolved(BROWSER_MAC))).toEqual([]);
    expect(
      findMatches(chord({ code: "KeyT", metaKey: true, shiftKey: true }), resolved(BROWSER_MAC)),
    ).toEqual([]);
  });
});

describe("findMatches — scoped-beats-global precedence (260730-n789)", () => {
  it("orders a scoped match before the global one sharing the combo (mac ⌘[)", () => {
    const matches = findMatches(chord({ code: "BracketLeft", metaKey: true }), resolved(SHELL_MAC));
    expect(matches.map((b) => b.actionId)).toEqual(["board-cycle-prev", "go-back"]);
  });

  it("returns single matches untouched and [] for no match", () => {
    expect(
      findMatches(chord({ code: "ArrowDown", shiftKey: true, ctrlKey: true }), resolved()).map(
        (b) => b.actionId,
      ),
    ).toEqual(["window-next"]);
    expect(findMatches(chord({ code: "ArrowDown" }), resolved())).toEqual([]);
  });
});

describe("shouldRefuseTerminalChord (260730-n789)", () => {
  it("refuses enabled shifted-tier matches on every platform (the g40a rule)", () => {
    const e = chord({ code: "ArrowDown", shiftKey: true, ctrlKey: true });
    expect(shouldRefuseTerminalChord(e, resolved(SHELL_OTHER), "other")).toBe(true);
    expect(shouldRefuseTerminalChord(e, resolved(SHELL_MAC), "mac")).toBe(true);
  });

  it("the ⇧G capture toggles (webOnly + guiOnly) never refuse — ⇧Ctrl+G / ⇧⌘G stay with the pane", () => {
    const other = resolved(SHELL_OTHER);
    const mac = resolved(SHELL_MAC);
    expect(shouldRefuseTerminalChord(chord({ code: "KeyG", ctrlKey: true, shiftKey: true }), other, "other")).toBe(false);
    expect(shouldRefuseTerminalChord(chord({ code: "KeyG", metaKey: true, shiftKey: true }), mac, "mac")).toBe(false);
  });

  it("arrow chords: mac ⌘↑/⌘↓ refuse via the cmd-tier metaKey rule; shifted arrows refuse everywhere; plain and plain-Shift arrows reach the pane", () => {
    const mac = resolved(SHELL_MAC);
    // The demoted window pair under mac terminal focus (rule 2, loss-free).
    expect(shouldRefuseTerminalChord(chord({ code: "ArrowDown", metaKey: true }), mac, "mac")).toBe(true);
    expect(shouldRefuseTerminalChord(chord({ code: "ArrowUp", metaKey: true }), mac, "mac")).toBe(true);
    // The shifted session pair rides rule 1 on every platform.
    expect(
      shouldRefuseTerminalChord(chord({ code: "ArrowUp", metaKey: true, shiftKey: true }), mac, "mac"),
    ).toBe(true);
    const other = resolved(SHELL_OTHER);
    expect(
      shouldRefuseTerminalChord(chord({ code: "ArrowUp", ctrlKey: true, shiftKey: true }), other, "other"),
    ).toBe(true);
    expect(
      shouldRefuseTerminalChord(chord({ code: "ArrowDown", ctrlKey: true, shiftKey: true }), other, "other"),
    ).toBe(true);
    expect(
      shouldRefuseTerminalChord(chord({ code: "ArrowLeft", ctrlKey: true, shiftKey: true }), other, "other"),
    ).toBe(true);
    expect(
      shouldRefuseTerminalChord(chord({ code: "ArrowRight", ctrlKey: true, shiftKey: true }), other, "other"),
    ).toBe(true);
    // Plain and plain-Shift arrows match no binding on any host — the pane
    // keeps cursor and scroll-modifier keys (the accepted-cost boundary).
    for (const e of [
      chord({ code: "ArrowUp" }),
      chord({ code: "ArrowDown" }),
      chord({ code: "ArrowLeft" }),
      chord({ code: "ArrowRight" }),
      chord({ code: "ArrowUp", shiftKey: true }),
      chord({ code: "ArrowDown", shiftKey: true }),
    ]) {
      expect(shouldRefuseTerminalChord(e, mac, "mac")).toBe(false);
      expect(shouldRefuseTerminalChord(e, other, "other")).toBe(false);
    }
    // mac plain Ctrl+↑/↓ matches the cmd-tier window pair but carries no
    // metaKey → the pane keeps it (rule 2's gate).
    expect(shouldRefuseTerminalChord(chord({ code: "ArrowDown", ctrlKey: true }), mac, "mac")).toBe(false);
  });

  it("mac only: refuses a ⌘ (metaKey) cmd-tier match so demoted chords fire from the pane", () => {
    const bindings = resolved(SHELL_MAC);
    expect(
      shouldRefuseTerminalChord(chord({ code: "BracketLeft", metaKey: true }), bindings, "mac"),
    ).toBe(true);
    expect(
      shouldRefuseTerminalChord(chord({ code: "KeyN", metaKey: true }), bindings, "mac"),
    ).toBe(true);
  });

  it("mac: plain-Ctrl chords matching no ctrl-tier binding pass through (Ctrl+[ is ESC)", () => {
    const bindings = resolved(SHELL_MAC);
    expect(
      shouldRefuseTerminalChord(chord({ code: "BracketLeft", ctrlKey: true }), bindings, "mac"),
    ).toBe(false);
    // Unbound ⌘ keys pass through too (no enabled match).
    expect(
      shouldRefuseTerminalChord(chord({ code: "KeyG", metaKey: true }), bindings, "mac"),
    ).toBe(false);
  });

  it("mac rule 3: an enabled ctrl-tier match pressed with ctrlKey is refused (⌃` focus hop)", () => {
    const bindings = resolved(SHELL_MAC);
    expect(
      shouldRefuseTerminalChord(chord({ code: "Backquote", ctrlKey: true }), bindings, "mac"),
    ).toBe(true);
    // The metaKey exclusion: a ⌘+Ctrl combined press must not double-match
    // (it matches no ctrl-tier combo anyway — matchesCombo requires !metaKey).
    expect(
      shouldRefuseTerminalChord(
        chord({ code: "Backquote", ctrlKey: true, metaKey: true }),
        bindings,
        "mac",
      ),
    ).toBe(false);
    // A user-disabled ctrl-tier binding restores passthrough (⌃` → NUL
    // reaches the pane again).
    const disabled = resolved(SHELL_MAC, { "focus-hop": null });
    expect(
      shouldRefuseTerminalChord(chord({ code: "Backquote", ctrlKey: true }), disabled, "mac"),
    ).toBe(false);
  });

  it("win/linux: no ctrl-tier default resolves there — plain Ctrl+` stays the pane's (byte-identical seam)", () => {
    const bindings = resolved(SHELL_OTHER);
    // ⇧Ctrl+` IS refused (rule 1 — focus-hop's base tier is shifted); plain
    // Ctrl+` matches nothing and reaches the pane unchanged.
    expect(
      shouldRefuseTerminalChord(
        chord({ code: "Backquote", shiftKey: true, ctrlKey: true }),
        bindings,
        "other",
      ),
    ).toBe(true);
    expect(
      shouldRefuseTerminalChord(chord({ code: "Backquote", ctrlKey: true }), bindings, "other"),
    ).toBe(false);
  });

  it("win/linux: cmd-tier matches are never refused (byte-identical seam)", () => {
    const bindings = resolved(SHELL_OTHER);
    // Ctrl+K matches the cmd-tier palette binding but must reach xterm's
    // normal path exactly as before n789.
    expect(
      shouldRefuseTerminalChord(chord({ code: "KeyK", ctrlKey: true }), bindings, "other"),
    ).toBe(false);
    expect(
      shouldRefuseTerminalChord(chord({ code: "BracketLeft", ctrlKey: true }), bindings, "other"),
    ).toBe(false);
  });

  it("disabled bindings never trigger refusal (mac-browser ⌘N passes through)", () => {
    const bindings = resolved(BROWSER_MAC);
    expect(
      shouldRefuseTerminalChord(chord({ code: "KeyN", metaKey: true }), bindings, "mac"),
    ).toBe(false);
  });

  it("split chords: ⇧Ctrl+\\/⇧Ctrl+- and mac ⌘D/⇧⌘D refuse; plain Ctrl+D stays the pane's EOF (260807-rbx5)", () => {
    const other = resolved(SHELL_OTHER);
    expect(
      shouldRefuseTerminalChord(chord({ code: "Backslash", shiftKey: true, ctrlKey: true }), other, "other"),
    ).toBe(true);
    expect(
      shouldRefuseTerminalChord(chord({ code: "Minus", shiftKey: true, ctrlKey: true }), other, "other"),
    ).toBe(true);
    // Win/Linux Ctrl+D — plain or shifted — matches nothing: the D codes live
    // only behind the mac `macCode` refinement, and EOF belongs to the pane.
    expect(shouldRefuseTerminalChord(chord({ code: "KeyD", ctrlKey: true }), other, "other")).toBe(false);
    expect(
      shouldRefuseTerminalChord(chord({ code: "KeyD", shiftKey: true, ctrlKey: true }), other, "other"),
    ).toBe(false);

    const mac = resolved(SHELL_MAC);
    expect(shouldRefuseTerminalChord(chord({ code: "KeyD", metaKey: true }), mac, "mac")).toBe(true);
    expect(
      shouldRefuseTerminalChord(chord({ code: "KeyD", metaKey: true, shiftKey: true }), mac, "mac"),
    ).toBe(true);
    // Mac Ctrl+D matches the cmd tier but carries no metaKey → the pane keeps it.
    expect(shouldRefuseTerminalChord(chord({ code: "KeyD", ctrlKey: true }), mac, "mac")).toBe(false);
  });
});

describe("split chords + the macCode refinement — 260807-rbx5", () => {
  const splitH = DEFAULT_BINDINGS.find((b) => b.actionId === "split-horizontal");
  const splitV = DEFAULT_BINDINGS.find((b) => b.actionId === "split-vertical");

  it("ships divider-mnemonic base codes with a KeyD mac refinement, terminal scope", () => {
    expect(splitH).toMatchObject({
      code: "Backslash",
      tier: "shifted",
      macCode: "KeyD",
      macTier: "cmd",
      scope: "terminal",
      kind: "builtin",
      label: "Split horizontal",
      mapLabel: "split h",
    });
    // Refines in BOTH mac hosts (⌘D is page-interceptable) — no shell gate.

    expect(splitV).toMatchObject({
      code: "Minus",
      tier: "shifted",
      macCode: "KeyD",
      scope: "terminal",
      kind: "builtin",
      label: "Split vertical",
      mapLabel: "split v",
    });
    // Vertical keeps the shifted tier on mac (⇧⌘D) — code refines, tier stays.
    expect(splitV?.macTier).toBeUndefined();
  });

  it("mac hosts resolve ⌘D horizontal and ⇧⌘D vertical (shell and browser alike)", () => {
    for (const host of [SHELL_MAC, BROWSER_MAC]) {
      expect(byId(resolved(host), "split-horizontal")).toMatchObject({
        code: "KeyD",
        tier: "cmd",
        enabled: true,
        isDefault: true,
      });
      expect(byId(resolved(host), "split-vertical")).toMatchObject({
        code: "KeyD",
        tier: "shifted",
        enabled: true,
        isDefault: true,
      });
    }
  });

  it("win/linux hosts resolve ⇧Ctrl+\\ horizontal and ⇧Ctrl+- vertical — both bound", () => {
    for (const host of [SHELL_OTHER, BROWSER_OTHER]) {
      expect(byId(resolved(host), "split-horizontal")).toMatchObject({
        code: "Backslash",
        tier: "shifted",
        enabled: true,
        isDefault: true,
      });
      expect(byId(resolved(host), "split-vertical")).toMatchObject({
        code: "Minus",
        tier: "shifted",
        enabled: true,
        isDefault: true,
      });
    }
  });

  it("dispatch: mac ⌘D/⇧⌘D resolve the pair; win/linux dispatches on the divider codes", () => {
    const mac = resolved(SHELL_MAC);
    expect(findMatches(chord({ code: "KeyD", metaKey: true }), mac).map((b) => b.actionId)).toEqual([
      "split-horizontal",
    ]);
    expect(
      findMatches(chord({ code: "KeyD", metaKey: true, shiftKey: true }), mac).map((b) => b.actionId),
    ).toEqual(["split-vertical"]);

    const other = resolved(SHELL_OTHER);
    expect(
      findMatches(chord({ code: "Backslash", shiftKey: true, ctrlKey: true }), other).map((b) => b.actionId),
    ).toEqual(["split-horizontal"]);
    expect(
      findMatches(chord({ code: "Minus", shiftKey: true, ctrlKey: true }), other).map((b) => b.actionId),
    ).toEqual(["split-vertical"]);
    // No D chord matches anything on win/linux — EOF belongs to the pane.
    expect(findMatches(chord({ code: "KeyD", ctrlKey: true }), other)).toEqual([]);
    expect(findMatches(chord({ code: "KeyD", shiftKey: true, ctrlKey: true }), other)).toEqual([]);
  });

  it("defaultComboFor swaps the code (and tier where set) on mac only", () => {
    if (!splitH || !splitV) throw new Error("missing split defaults");
    expect(defaultComboFor(splitH, SHELL_MAC)).toEqual({ code: "KeyD", tier: "cmd" });
    expect(defaultComboFor(splitH, BROWSER_MAC)).toEqual({ code: "KeyD", tier: "cmd" });
    expect(defaultComboFor(splitH, SHELL_OTHER)).toEqual({ code: "Backslash", tier: "shifted" });
    expect(defaultComboFor(splitV, SHELL_MAC)).toEqual({ code: "KeyD", tier: "shifted" });
    expect(defaultComboFor(splitV, BROWSER_MAC)).toEqual({ code: "KeyD", tier: "shifted" });
    expect(defaultComboFor(splitV, BROWSER_OTHER)).toEqual({ code: "Minus", tier: "shifted" });
  });

  it("the refinement is inert for every binding that sets no macCode", () => {
    for (const host of ALL_HOSTS) {
      for (const def of DEFAULT_BINDINGS.filter((d) => d.macCode == null)) {
        expect(defaultComboFor(def, host).code).toBe(def.code);
      }
    }
  });

  it("re-capturing a macCode binding's own mac default is a no-op that steals from nobody", () => {
    // ⇧⌘D on a mac host IS split-vertical's host default — applyCapture must
    // drop the diff entry (diffs-only store) and leave the ⌘D partner alone.
    const { overrides, stolenFrom } = applyCapture(
      resolved(SHELL_MAC),
      { "split-vertical": { code: "KeyY", tier: "shifted" } },
      "split-vertical",
      { code: "KeyD", tier: "shifted" },
      SHELL_MAC,
    );
    expect(stolenFrom).toBeNull();
    expect(overrides).toEqual({});
  });

  it("an override rebinds either split verbatim on any host", () => {
    const bindings = resolveBindings(
      DEFAULT_BINDINGS,
      { "split-vertical": { code: "KeyY", tier: "shifted" } },
      SHELL_OTHER,
    );
    expect(byId(bindings, "split-vertical")).toMatchObject({
      code: "KeyY",
      tier: "shifted",
      enabled: true,
      isDefault: false,
    });
    expect(
      findMatches(chord({ code: "KeyY", shiftKey: true, ctrlKey: true }), bindings)[0]?.actionId,
    ).toBe("split-vertical");
  });

  it("keeps the shipped defaults conflict-free in every host (the mac D pair is tier-disjoint)", () => {
    for (const host of ALL_HOSTS) {
      expect(findConflicts(resolved(host))).toEqual([]);
    }
    // Why the mac pair is legal on one code in one scope: the tiers are disjoint.
    expect(tiersCollide("cmd", "shifted")).toBe(false);
  });

  it("palette hints render the host pair: ⌘D/⇧⌘D on mac, Shift+Ctrl+\\ and Shift+Ctrl+- elsewhere", () => {
    const actions = [
      { id: "split-horizontal", label: "Window: Split Horizontal" },
      { id: "split-vertical", label: "Window: Split Vertical" },
    ];
    const other = withShortcutHints(
      actions,
      new Map(resolved(BROWSER_OTHER).map((b) => [b.actionId, b])),
      "other",
    );
    expect(other[0].shortcut).toBe("Shift+Ctrl+\\");
    expect(other[1].shortcut).toBe("Shift+Ctrl+-");

    const mac = withShortcutHints(
      actions,
      new Map(resolved(BROWSER_MAC).map((b) => [b.actionId, b])),
      "mac",
    );
    expect(mac[0].shortcut).toBe("⌘D");
    expect(mac[1].shortcut).toBe("⇧⌘D");
  });
});

describe("ttyOnly registry flag — 260812-wfic (R7)", () => {
  it("exactly the split pair and terminal-find carry ttyOnly; no other row does", () => {
    const flagged = DEFAULT_BINDINGS.filter((b) => b.ttyOnly).map((b) => b.actionId);
    expect(flagged).toEqual(["split-horizontal", "split-vertical", "terminal-find"]);
  });

  it("survives resolution onto the effective map in every host", () => {
    for (const host of ALL_HOSTS) {
      const bindings = resolved(host);
      expect(byId(bindings, "split-horizontal").ttyOnly).toBe(true);
      expect(byId(bindings, "split-vertical").ttyOnly).toBe(true);
      expect(byId(bindings, "terminal-find").ttyOnly).toBe(true);
      expect(byId(bindings, "command-palette").ttyOnly).toBeUndefined();
    }
  });
});

describe("hasReclaimableMatch — the lens-iframe reclaim carve-out (260812-wfic R9, kind-aware 260819-ie2i)", () => {
  it("a chord whose only matches are ttyOnly is NOT reclaimed in EITHER iframe kind (⌘D / ⇧Ctrl+\\)", () => {
    // mac ⌘D (split-horizontal's mac refinement) and the win/linux divider
    // chord both match ONLY ttyOnly bindings — code-server keeps them, and no
    // web frame may claim them either.
    expect(hasReclaimableMatch(chord({ code: "KeyD", metaKey: true }), resolved(SHELL_MAC), "code")).toBe(false);
    expect(hasReclaimableMatch(chord({ code: "KeyD", metaKey: true }), resolved(SHELL_MAC), "web")).toBe(false);
    expect(
      hasReclaimableMatch(chord({ code: "Backslash", shiftKey: true, ctrlKey: true }), resolved(SHELL_OTHER), "code"),
    ).toBe(false);
    expect(
      hasReclaimableMatch(chord({ code: "Backslash", shiftKey: true, ctrlKey: true }), resolved(SHELL_OTHER), "web"),
    ).toBe(false);
  });

  it("non-gated registry chords are reclaimed under BOTH kinds (⌘K, ⌘;)", () => {
    const bindings = resolved(SHELL_MAC);
    expect(hasReclaimableMatch(chord({ code: "KeyK", metaKey: true }), bindings, "code")).toBe(true);
    expect(hasReclaimableMatch(chord({ code: "KeyK", metaKey: true }), bindings, "web")).toBe(true);
    expect(hasReclaimableMatch(chord({ code: "Semicolon", metaKey: true }), bindings, "code")).toBe(true);
    expect(hasReclaimableMatch(chord({ code: "Semicolon", metaKey: true }), bindings, "web")).toBe(true);
  });

  it("an unbound chord is NOT reclaimed in either kind (⌘. — the retired lens cycle falls through to the embedded app)", () => {
    const bindings = resolved(SHELL_MAC);
    expect(hasReclaimableMatch(chord({ code: "Period", metaKey: true }), bindings, "code")).toBe(false);
    expect(hasReclaimableMatch(chord({ code: "Period", metaKey: true }), bindings, "web")).toBe(false);
  });

  it("webOnly chords (⌘F web-find) reclaim ONLY inside a web iframe — the code iframe keeps code-server's find", () => {
    const mac = resolved(SHELL_MAC);
    expect(hasReclaimableMatch(chord({ code: "KeyF", metaKey: true }), mac, "web")).toBe(true);
    expect(hasReclaimableMatch(chord({ code: "KeyF", metaKey: true }), mac, "code")).toBe(false);
    const other = resolved(SHELL_OTHER);
    expect(hasReclaimableMatch(chord({ code: "KeyF", ctrlKey: true }), other, "web")).toBe(true);
    expect(hasReclaimableMatch(chord({ code: "KeyF", ctrlKey: true }), other, "code")).toBe(false);
  });

  it("web-address (⌘L) reclaims ONLY inside a web iframe (260819-v6y4 R12) — in-frame ⌘L coverage rides the kind-aware predicate", () => {
    const mac = resolved(BROWSER_MAC);
    expect(hasReclaimableMatch(chord({ code: "KeyL", metaKey: true }), mac, "web")).toBe(true);
    expect(hasReclaimableMatch(chord({ code: "KeyL", metaKey: true }), mac, "code")).toBe(false);
    const other = resolved(SHELL_OTHER);
    expect(hasReclaimableMatch(chord({ code: "KeyL", ctrlKey: true }), other, "web")).toBe(true);
    expect(hasReclaimableMatch(chord({ code: "KeyL", ctrlKey: true }), other, "code")).toBe(false);
  });

  it("the code toggle and focus hop reclaim from inside the code iframe (toggle symmetry / ⌃` preemption)", () => {
    // ⌘2 (code-toggle's mac default) and ⌃` (focus-hop's ctrl tier) match
    // non-gated bindings, so a keydown inside the code-server iframe
    // re-dispatches to the parent — preempting code-server's own ⌃`
    // integrated-terminal toggle. ⇧Ctrl+2 reclaims off mac the same way.
    const mac = resolved(SHELL_MAC);
    expect(hasReclaimableMatch(chord({ code: "Digit2", metaKey: true }), mac, "code")).toBe(true);
    expect(hasReclaimableMatch(chord({ code: "Backquote", ctrlKey: true }), mac, "code")).toBe(true);
    expect(
      hasReclaimableMatch(
        chord({ code: "Digit2", shiftKey: true, ctrlKey: true }),
        resolved(SHELL_OTHER),
        "code",
      ),
    ).toBe(true);
  });

  it("no match at all → false (the embedded app's own chords pass through)", () => {
    expect(hasReclaimableMatch(chord({ code: "KeyQ" }), resolved(SHELL_OTHER), "code")).toBe(false);
    expect(hasReclaimableMatch(chord({ code: "KeyQ" }), resolved(SHELL_OTHER), "web")).toBe(false);
  });

  it("a chord matching BOTH a ttyOnly and a non-gated binding IS reclaimed (.some semantics, A-016)", () => {
    // No such default pair ships today; construct it to pin the semantics: a
    // shared chord keeps its global meaning, so the reclaim must fire.
    const shared: KeyBinding = {
      actionId: "test-global",
      code: "Backslash",
      tier: "shifted",
      scope: "global",
      kind: "builtin",
      label: "test",
    };
    const bindings = resolveBindings([...DEFAULT_BINDINGS, shared], {}, SHELL_OTHER);
    expect(
      hasReclaimableMatch(chord({ code: "Backslash", shiftKey: true, ctrlKey: true }), bindings, "code"),
    ).toBe(true);
  });
});

describe("webOnly — the web-find data flag (260819-ie2i)", () => {
  it("exactly web-find, web-address, and web-capture-toggle carry the flag in the shipped defaults", () => {
    const flagged = DEFAULT_BINDINGS.filter((b) => b.webOnly).map((b) => b.actionId);
    expect(flagged).toEqual(["web-find", "web-address", "web-capture-toggle"]);
  });

  it("web-find ships as ⌘F on mac and Ctrl+F on Win/Linux (cmd tier, no mac refinement)", () => {
    expect(byId(resolved(SHELL_MAC), "web-find")).toMatchObject({ code: "KeyF", tier: "cmd", enabled: true });
    expect(byId(resolved(BROWSER_MAC), "web-find")).toMatchObject({ code: "KeyF", tier: "cmd", enabled: true });
    expect(byId(resolved(SHELL_OTHER), "web-find")).toMatchObject({ code: "KeyF", tier: "cmd", enabled: true });
    expect(byId(resolved(BROWSER_OTHER), "web-find")).toMatchObject({ code: "KeyF", tier: "cmd", enabled: true });
    expect(formatCombo(byId(resolved(SHELL_MAC), "web-find"), "mac")).toBe("⌘F");
    expect(formatCombo(byId(resolved(SHELL_OTHER), "web-find"), "other")).toBe("Ctrl+F");
  });

  it("web-address ships as ⌘L/Ctrl+L (cmd tier, webOnly, ignoreInputs) — enabled in a mac BROWSER since the KeyL claim is removed (260819-v6y4 R12)", () => {
    for (const host of ALL_HOSTS) {
      expect(byId(resolved(host), "web-address")).toMatchObject({
        code: "KeyL",
        tier: "cmd",
        enabled: true,
        ignoreInputs: true,
        webOnly: true,
      });
    }
    expect(formatCombo(byId(resolved(SHELL_MAC), "web-address"), "mac")).toBe("⌘L");
    expect(formatCombo(byId(resolved(SHELL_OTHER), "web-address"), "other")).toBe("Ctrl+L");
  });

  it("survives resolution onto the effective map in every host", () => {
    for (const host of ALL_HOSTS) {
      const bindings = resolved(host);
      expect(byId(bindings, "web-find").webOnly).toBe(true);
      expect(byId(bindings, "command-palette").webOnly).toBeUndefined();
    }
  });
});

describe("guiOnly — the gui-zoom data flag", () => {
  it("exactly the three gui-zoom rows and the capture toggle carry the flag in the shipped defaults", () => {
    const flagged = DEFAULT_BINDINGS.filter((b) => b.guiOnly).map((b) => b.actionId);
    expect(flagged).toEqual(["gui-zoom-in", "gui-zoom-out", "gui-zoom-fit", "gui-capture-toggle"]);
  });

  it("ships the three rows ctrl-tier on Equal/Minus/Digit0, terminal scope, ignoreInputs — no mac refinement", () => {
    // Full-row equality: the ctrl-tier-everywhere shape is the constraint —
    // ⌘=/⌘-/⌘0 are the browser's own zoom chords on mac, so no demotion
    // exists, and the guiOnly gate (not the seam) confines plain Ctrl+=/−/0
    // to gui-tile focus.
    expect(DEFAULT_BINDINGS.find((b) => b.actionId === "gui-zoom-in")).toEqual({
      actionId: "gui-zoom-in",
      code: "Equal",
      tier: "ctrl",
      scope: "terminal",
      kind: "builtin",
      label: "Zoom GUI in",
      mapLabel: "gui +",
      ignoreInputs: true,
      guiOnly: true,
    });
    expect(DEFAULT_BINDINGS.find((b) => b.actionId === "gui-zoom-out")).toEqual({
      actionId: "gui-zoom-out",
      code: "Minus",
      tier: "ctrl",
      scope: "terminal",
      kind: "builtin",
      label: "Zoom GUI out",
      mapLabel: "gui −",
      ignoreInputs: true,
      guiOnly: true,
    });
    expect(DEFAULT_BINDINGS.find((b) => b.actionId === "gui-zoom-fit")).toEqual({
      actionId: "gui-zoom-fit",
      code: "Digit0",
      tier: "ctrl",
      scope: "terminal",
      kind: "builtin",
      label: "Zoom GUI to fit",
      mapLabel: "gui fit",
      ignoreInputs: true,
      guiOnly: true,
    });
    for (const host of ALL_HOSTS) {
      const bindings = resolved(host);
      expect(byId(bindings, "gui-zoom-in")).toMatchObject({ code: "Equal", tier: "ctrl", enabled: true, isDefault: true });
      expect(byId(bindings, "gui-zoom-out")).toMatchObject({ code: "Minus", tier: "ctrl", enabled: true, isDefault: true });
      expect(byId(bindings, "gui-zoom-fit")).toMatchObject({ code: "Digit0", tier: "ctrl", enabled: true, isDefault: true });
      expect(byId(bindings, "command-palette").guiOnly).toBeUndefined();
    }
  });

  it("matches plain Ctrl+=/−/0 on every platform", () => {
    for (const host of ALL_HOSTS) {
      const bindings = resolved(host);
      expect(findMatches(chord({ code: "Equal", ctrlKey: true }), bindings).map((b) => b.actionId)).toEqual(["gui-zoom-in"]);
      expect(findMatches(chord({ code: "Minus", ctrlKey: true }), bindings).map((b) => b.actionId)).toEqual(["gui-zoom-out"]);
      expect(findMatches(chord({ code: "Digit0", ctrlKey: true }), bindings).map((b) => b.actionId)).toEqual(["gui-zoom-fit"]);
    }
  });

  it("hasReclaimableMatch reclaims the chords only for kind 'gui'", () => {
    for (const host of ALL_HOSTS) {
      const bindings = resolved(host);
      for (const code of ["Equal", "Minus", "Digit0"]) {
        const e = chord({ code, ctrlKey: true });
        expect(hasReclaimableMatch(e, bindings, "gui")).toBe(true);
        expect(hasReclaimableMatch(e, bindings, "tty")).toBe(false);
        expect(hasReclaimableMatch(e, bindings, "code")).toBe(false);
        expect(hasReclaimableMatch(e, bindings, "web")).toBe(false);
      }
    }
  });

  it("the terminal seam never refuses the guiOnly chords — plain Ctrl+=/−/0 reach a focused pane on every platform", () => {
    // Regression guard: mac rule 3 (an enabled ctrl-tier match pressed with
    // ctrlKey) would otherwise steal the chords from the pane.
    for (const code of ["Equal", "Minus", "Digit0"]) {
      const e = chord({ code, ctrlKey: true });
      expect(shouldRefuseTerminalChord(e, resolved(SHELL_MAC), "mac")).toBe(false);
      expect(shouldRefuseTerminalChord(e, resolved(BROWSER_MAC), "mac")).toBe(false);
      expect(shouldRefuseTerminalChord(e, resolved(SHELL_OTHER), "other")).toBe(false);
      expect(shouldRefuseTerminalChord(e, resolved(BROWSER_OTHER), "other")).toBe(false);
    }
  });
});

describe("gui-capture-toggle — the chord gate's escape hatch", () => {
  it("ships shifted-tier on KeyG, terminal scope, ignoreInputs, guiOnly", () => {
    expect(DEFAULT_BINDINGS.find((b) => b.actionId === "gui-capture-toggle")).toEqual({
      actionId: "gui-capture-toggle",
      code: "KeyG",
      tier: "shifted",
      scope: "terminal",
      kind: "builtin",
      label: "Keyboard capture",
      description: "hand every chord to the guest desktop",
      mapLabel: "capture",
      ignoreInputs: true,
      guiOnly: true,
    });
  });

  it("resolves enabled on every host — Ctrl+Shift+G off mac, ⌘⇧G on mac", () => {
    for (const host of ALL_HOSTS) {
      expect(byId(resolved(host), "gui-capture-toggle")).toMatchObject({
        code: "KeyG",
        tier: "shifted",
        enabled: true,
        isDefault: true,
      });
    }
    expect(formatCombo(byId(resolved(SHELL_OTHER), "gui-capture-toggle"), "other")).toBe(
      "Shift+Ctrl+G",
    );
    expect(formatCombo(byId(resolved(SHELL_MAC), "gui-capture-toggle"), "mac")).toBe("⇧⌘G");
  });

  it("KeyG is otherwise unclaimed in the shifted tier — no registry or host-claim collision", () => {
    // The ONE sharer is web-capture-toggle — surface-gated (webOnly vs
    // guiOnly), so the two handlers are never simultaneously present.
    expect(
      DEFAULT_BINDINGS.filter(
        (b) =>
          b.code === "KeyG" &&
          b.actionId !== "gui-capture-toggle" &&
          b.actionId !== "web-capture-toggle",
      ),
    ).toEqual([]);
    for (const host of ALL_HOSTS) {
      expect(
        claimedKeys(host.platform, host.shell).filter(
          (c) => c.code === "KeyG" && c.tier === "shifted",
        ),
      ).toEqual([]);
    }
  });

  it("the release chord reclaims for kinds 'gui' and 'web' (each its own toggle), never 'code', captured or not", () => {
    for (const host of ALL_HOSTS) {
      const bindings = resolved(host);
      const e =
        host.platform === "mac"
          ? chord({ code: "KeyG", shiftKey: true, metaKey: true })
          : chord({ code: "KeyG", shiftKey: true, ctrlKey: true });
      expect(hasReclaimableMatch(e, bindings, "gui")).toBe(true);
      expect(hasReclaimableMatch(e, bindings, "code")).toBe(false);
      // web-capture-toggle (webOnly) shares ⌘⇧G — the web tile's release.
      expect(hasReclaimableMatch(e, bindings, "web")).toBe(true);
      expect(hasReclaimableMatch(e, bindings, "gui", true)).toBe(true);
      expect(hasReclaimableMatch(e, bindings, "web", true)).toBe(true);
    }
  });

  it("captured narrows the reclaim to the release binding alone — every other chord passes to the guest", () => {
    const mac = resolved(SHELL_MAC);
    const other = resolved(SHELL_OTHER);
    // The chords that reclaim today all pass once captured: the palette
    // (⌘K), the layout cycle (⌘;), and the guiOnly zoom trio.
    expect(hasReclaimableMatch(chord({ code: "KeyK", metaKey: true }), mac, "gui", true)).toBe(false);
    expect(hasReclaimableMatch(chord({ code: "Semicolon", metaKey: true }), mac, "gui", true)).toBe(false);
    expect(hasReclaimableMatch(chord({ code: "Equal", ctrlKey: true }), mac, "gui", true)).toBe(false);
    expect(hasReclaimableMatch(chord({ code: "KeyK", ctrlKey: true }), other, "gui", true)).toBe(false);
    expect(
      hasReclaimableMatch(chord({ code: "KeyK", shiftKey: true, ctrlKey: true }), other, "gui", true),
    ).toBe(false);
  });

  it("a remapped release binding moves the escape hatch with it", () => {
    const bindings = resolved(SHELL_OTHER, { "gui-capture-toggle": { code: "KeyU", tier: "shifted" } });
    expect(
      hasReclaimableMatch(chord({ code: "KeyU", shiftKey: true, ctrlKey: true }), bindings, "gui", true),
    ).toBe(true);
    expect(
      hasReclaimableMatch(chord({ code: "KeyG", shiftKey: true, ctrlKey: true }), bindings, "gui", true),
    ).toBe(false);
  });

  it("not captured is byte-identical to the pre-capture predicate on every kind", () => {
    // The default parameter and an explicit `false` must agree, for a
    // reclaimable chord, a guiOnly chord, and an unbound chord alike.
    for (const host of ALL_HOSTS) {
      const bindings = resolved(host);
      const cases: ChordEvent[] = [
        host.platform === "mac"
          ? chord({ code: "KeyK", metaKey: true })
          : chord({ code: "KeyK", ctrlKey: true }),
        chord({ code: "Equal", ctrlKey: true }),
        chord({ code: "KeyQ" }),
      ];
      for (const e of cases) {
        for (const kind of ["gui", "code", "web"] as const) {
          expect(hasReclaimableMatch(e, bindings, kind, false)).toBe(
            hasReclaimableMatch(e, bindings, kind),
          );
        }
      }
    }
  });
});

describe("aliasOf — a second chord for one action", () => {
  it("command-palette-alt aliases command-palette and is the only alias shipped", () => {
    const aliases = DEFAULT_BINDINGS.filter((b) => b.aliasOf);
    expect(aliases.map((b) => [b.actionId, b.aliasOf])).toEqual([
      ["command-palette-alt", "command-palette"],
    ]);
  });

  it("resolves as ⇧Ctrl+K on Win/Linux, leaving the unshifted chord in place", () => {
    for (const host of [SHELL_OTHER, BROWSER_OTHER]) {
      expect(byId(resolved(host), "command-palette-alt")).toMatchObject({
        code: "KeyK",
        tier: "shifted",
        enabled: true,
      });
      expect(byId(resolved(host), "command-palette")).toMatchObject({
        code: "KeyK",
        tier: "cmd",
        enabled: true,
      });
    }
    expect(formatCombo(byId(resolved(SHELL_OTHER), "command-palette-alt"), "other")).toBe(
      "Shift+Ctrl+K",
    );
  });

  it("is UNBOUND on mac, so ⌘K stays the only mac palette chord", () => {
    for (const host of [SHELL_MAC, BROWSER_MAC]) {
      const alt = byId(resolved(host), "command-palette-alt");
      expect(alt.enabled).toBe(false);
      expect(alt.disabledReason).toBe("user");
      expect(byId(resolved(host), "command-palette")).toMatchObject({
        code: "KeyK",
        tier: "cmd",
        enabled: true,
      });
    }
  });

  it("both chords match on Win/Linux; neither shifted form matches on mac", () => {
    const other = resolved(SHELL_OTHER);
    const shifted = { code: "KeyK", metaKey: false, ctrlKey: true, shiftKey: true, altKey: false };
    const plain = { code: "KeyK", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false };
    expect(findMatches(shifted, other).map((b) => b.actionId)).toEqual(["command-palette-alt"]);
    expect(findMatches(plain, other).map((b) => b.actionId)).toEqual(["command-palette"]);
    expect(findMatches(shifted, resolved(SHELL_MAC))).toEqual([]);
  });

  it("the alias is refused by the terminal seam on every platform, so it bubbles under terminal focus", () => {
    const shifted = { code: "KeyK", metaKey: false, ctrlKey: true, shiftKey: true, altKey: false };
    expect(shouldRefuseTerminalChord(shifted, resolved(SHELL_OTHER), "other")).toBe(true);
    // The unshifted Win/Linux form stays with the pane — it is readline kill-line.
    const plain = { code: "KeyK", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false };
    expect(shouldRefuseTerminalChord(plain, resolved(SHELL_OTHER), "other")).toBe(false);
  });

  it("never conflicts with the action it aliases", () => {
    for (const host of ALL_HOSTS) {
      const pair = findConflicts(resolved(host)).filter(
        (c) =>
          [c.a, c.b].includes("command-palette") &&
          [c.a, c.b].includes("command-palette-alt"),
      );
      expect(pair).toEqual([]);
    }
  });

  it("carries its own override slot — rebinding the alias leaves the primary alone", () => {
    const overrides = { "command-palette-alt": { code: "KeyJ", tier: "shifted" as const } };
    const map = resolved(SHELL_OTHER, overrides);
    expect(byId(map, "command-palette-alt")).toMatchObject({ code: "KeyJ", tier: "shifted" });
    expect(byId(map, "command-palette")).toMatchObject({ code: "KeyK", tier: "cmd", enabled: true });
  });

  it("unbinding the alias leaves the primary enabled", () => {
    const map = resolved(SHELL_OTHER, { "command-palette-alt": null });
    expect(byId(map, "command-palette-alt").enabled).toBe(false);
    expect(byId(map, "command-palette").enabled).toBe(true);
  });
});

describe("chordHintFor — hint strings for aliased actions", () => {
  it("lists the primary first, then the alias, on Win/Linux", () => {
    expect(chordHintFor("command-palette", resolved(SHELL_OTHER), "other")).toBe(
      "Ctrl+K / Shift+Ctrl+K",
    );
  });

  it("shows only ⌘K on mac, where the alias is unbound", () => {
    expect(chordHintFor("command-palette", resolved(SHELL_MAC), "mac")).toBe("⌘K");
  });

  it("is undefined when the action has no enabled binding", () => {
    const map = resolved(SHELL_OTHER, { "command-palette": null, "command-palette-alt": null });
    expect(chordHintFor("command-palette", map, "other")).toBeUndefined();
  });

  it("returns a single combo for an action with no alias", () => {
    expect(chordHintFor("web-find", resolved(SHELL_OTHER), "other")).toBe("Ctrl+F");
  });
});

describe("focusIsEngaged (the restore router's first-visit guard)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function mount(html: string): HTMLElement {
    document.body.innerHTML = html;
    return document.body.firstElementChild as HTMLElement;
  }

  it("is false for null and for body", () => {
    expect(focusIsEngaged(null)).toBe(false);
    expect(focusIsEngaged(document.body)).toBe(false);
  });

  it("is false for a non-editable chrome control (the sidebar row that navigated)", () => {
    const row = mount('<div><button data-row>row</button></div>').querySelector("button")!;
    expect(focusIsEngaged(row)).toBe(false);
  });

  it("is true inside an xterm, an editable, a dialog, an open menu/listbox, or an iframe", () => {
    const term = mount('<div class="xterm"><div class="xterm-helper-textarea"><textarea></textarea></div></div>').querySelector("textarea")!;
    expect(focusIsEngaged(term)).toBe(true);
    expect(focusIsEngaged(mount('<input type="text" />'))).toBe(true);
    expect(focusIsEngaged(mount("<textarea></textarea>"))).toBe(true);
    const inDialog = mount('<div role="dialog"><button>ok</button></div>').querySelector("button")!;
    expect(focusIsEngaged(inDialog)).toBe(true);
    const inModal = mount('<div aria-modal="true"><span tabindex="0">x</span></div>').querySelector("span")!;
    expect(focusIsEngaged(inModal)).toBe(true);
    const menuRow = mount('<div role="menu"><button role="menuitem">copy</button></div>').querySelector("button")!;
    expect(focusIsEngaged(menuRow)).toBe(true);
    const option = mount('<ul role="listbox"><li role="option" tabindex="0">a</li></ul>').querySelector("li")!;
    expect(focusIsEngaged(option)).toBe(true);
    expect(focusIsEngaged(mount("<iframe></iframe>"))).toBe(true);
    // jsdom implements neither `isContentEditable` nor the `contentEditable`
    // reflection, so set the property the way the shouldSuppressChord tests do.
    const editable = mount("<div></div>");
    editable.contentEditable = "true";
    expect(focusIsEngaged(editable)).toBe(true);
  });
});
