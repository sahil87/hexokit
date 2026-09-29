import { useEffect, useMemo, useRef, useState } from "react";
import { INPUT_FOCUS } from "@/components/controls";
import { useKeybindings } from "@/hooks/use-keybindings";
import { useMacros } from "@/hooks/use-macros";
import { useSessionContext } from "@/contexts/session-context";
import { getKeybindings, type Keybinding } from "@/api/client";
import {
  captureFromEvent,
  claimedKeys,
  comboParts,
  formatCombo,
  keyLabel,
  type BindingPlatform,
  type BindingScope,
  type BindingTier,
  type EffectiveBinding,
} from "@/lib/keybindings";
import {
  isMacroActionId,
  macroCommandPreview,
  type MacroAction,
  type MacroTarget,
} from "@/lib/macros";

/**
 * The keyboard-shortcuts surface (260730-g40a) as the settings dialog's
 * Shortcuts TAB PANEL (260818-bncw — the standalone overlay shell is retired:
 * no own backdrop or focus trap; the settings `Dialog` owns both, and an
 * armed rebind capture's Escape still cancels the capture only — the
 * capture-phase listener `stopPropagation`s before the trap sees it).
 *
 * THE single merged shortcuts surface (260801-sm6g): NO TABS inside the panel
 * — one scroll, one filter spanning app + custom + tmux rows. A sticky
 * JUMP-NAV chip row under the header scroll-anchors to each section; while
 * the filter is active every chip shows a live per-section match count and
 * dims when its section has no hits. The key map (app layers only — tmux
 * prefix chords don't fit the combo model) is FOLDABLE ("collapse map") and
 * auto-hides entirely while a filter is active. Shell-owned locked rows
 * render as a subgroup at the end of GLOBAL. A read-only TMUX section lists
 * the current server's curated bindings from `GET /api/keybindings`, fetched
 * only while the panel is mounted (the settings dialog mounts it only on the
 * active Shortcuts tab); no current server (board/host routes) or an
 * empty/failed fetch shows "No tmux server running".
 *
 * The panel mounts/unmounts with the active tab, which would reset the two
 * session-scoped READING preferences (map fold, modifier layer) the overlay
 * used to keep across closes — those two are hoisted to module scope below so
 * the documented persistence survives; transient state (filter, capture,
 * notices, the add flow) resets with the unmount, matching the old
 * on-close reset effect.
 *
 * CUSTOM section (260730-hbyh): editable macro rows — label, resolved-command
 * preview chip, the same click-to-rebind capture as builtins, a delete
 * affordance, and a `missing preset` error badge when a riff macro's preset
 * is absent from the fetched preset list. The `+ bind a key…` add flow offers
 * riff presets + the mount's palette actions as targets (via the
 * `paletteTargets`/`riffPresetNames` props — `paletteTargets == null` gates
 * the whole add flow off).
 */

const KEY_ROWS: string[][] = [
  ["KeyQ", "KeyW", "KeyE", "KeyR", "KeyT", "KeyY", "KeyU", "KeyI", "KeyO", "KeyP", "BracketLeft", "BracketRight"],
  ["KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK", "KeyL", "Semicolon", "Slash"],
  ["KeyZ", "KeyX", "KeyC", "KeyV", "KeyB", "KeyN", "KeyM", "Digit1", "Digit2", "…", "Digit9", "Digit0"],
];

const GROUPS: { name: string; scope: BindingScope }[] = [
  { name: "GLOBAL", scope: "global" },
  { name: "TERMINAL", scope: "terminal" },
  { name: "BOARD", scope: "board" },
];

/** The one borderless selected treatment (green = state): fill+ink for
 *  segmented-picker options and list rows that carry no border of their own
 *  (bordered shapes use the primitive's bordered latch arm). REST-swap — the selected arm replaces
 *  the hover-carrying rest classes, never stacks on them. */
const SELECTED_FILL = "bg-accent-green/15 text-accent-green";

/** Jump-nav section ids, in document order (260801-sm6g). */
type JumpSectionId = "map" | "global" | "terminal" | "board" | "custom" | "tmux";

/** Session-scoped view prefs — a folded map, a chosen modifier layer, and the
 *  platform display toggle are reading preferences, not transient
 *  filter/capture state, so they survive the panel's unmount (tab switch /
 *  dialog close). `displayPlatform: null` = follow the detected host. */
const viewPrefs = {
  mapFolded: false,
  mapTier: "cmd" as "shifted" | "cmd",
  displayPlatform: null as BindingPlatform | null,
};

/** Test seam: restore the hoisted view prefs (module state otherwise leaks
 *  across tests in one file). */
export function resetShortcutsPanelViewPrefs() {
  viewPrefs.mapFolded = false;
  viewPrefs.mapTier = "cmd";
  viewPrefs.displayPlatform = null;
}

/** A keycap sequence (`<kbd>` run) — the combo rendering unit. */
function Keycaps({ parts }: { parts: string[] }) {
  return (
    <>
      {parts.map((part, i) => (
        <kbd
          key={i}
          className="inline-block min-w-[24px] px-1.5 py-0.5 text-center text-[11px] bg-bg-inset border border-border border-b-2 rounded text-text-primary"
        >
          {part}
        </kbd>
      ))}
    </>
  );
}

/** Scope badge for non-global rows (mock: pill with per-scope color). */
function ScopeBadge({ scope }: { scope: BindingScope }) {
  if (scope === "global" || scope === "sidebar") return null;
  const cls =
    scope === "terminal"
      ? "border-accent-green/50 text-accent-green"
      : "border-accent/60 text-accent-bright";
  return (
    <span className={`flex-none text-[9.5px] tracking-wider uppercase px-2 py-px rounded-full border ${cls}`}>
      {scope}
    </span>
  );
}

/** A read-only locked row (🔒 + non-interactive combo) — the shell-owned-row
 *  idiom, shared by the GLOBAL shell subgroup and the TMUX section
 *  (260801-sm6g). `seq` interleaves keycap runs with "then" separators for
 *  tmux prefix sequences (`Ctrl` `S` then `\`). */
function LockedRow({
  label,
  description,
  seq,
  lockTitle,
  lockAria,
}: {
  label: string;
  description?: string;
  seq: (string[] | "then")[];
  lockTitle: string;
  lockAria: string;
}) {
  return (
    <div className="flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-bg-inset/70">
      <span className="w-1.5 h-1.5 flex-none" />
      <span className="flex-1 min-w-0 truncate">
        {label}
        {description && (
          <span className="text-[11px] text-text-secondary"> — {description}</span>
        )}
      </span>
      <span className="flex gap-1 items-center px-1 py-0.5">
        {seq.map((part, i) =>
          part === "then" ? (
            <span key={`then-${i}`} className="text-[10px] text-text-secondary px-px">
              then
            </span>
          ) : (
            <Keycaps key={i} parts={part} />
          ),
        )}
      </span>
      <span
        className="flex-none text-[11px] text-text-secondary"
        role="img"
        aria-label={lockAria}
        title={lockTitle}
      >
        🔒
      </span>
    </div>
  );
}

/** Bracketed section heading + rule, with an optional right-aligned note. */
function SectionHead({ name, note }: { name: string; note?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-1">
      <h3 className="text-[11.5px] font-bold tracking-wider text-text-secondary select-none">
        <span aria-hidden="true">[ </span>
        <span className="text-text-primary">{name}</span>
        <span aria-hidden="true"> ]</span>
      </h3>
      <span className="flex-1 border-t border-border" aria-hidden="true" />
      {note && <span className="text-[10px] text-text-secondary">{note}</span>}
    </div>
  );
}

/** Uppercase-tracking subgroup head (mock `.subhead`). */
function SubHead({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] tracking-wider uppercase text-text-secondary mt-2 mb-0.5 px-2">
      {children}
    </div>
  );
}

// ── tmux keybinding shaping (absorbed from the retired keyboard-shortcuts.tsx
//    dialog, 260801-sm6g) ─────────────────────────────────────────────────────

/** Format a tmux key name for display (e.g., "S-F3" → "Shift+F3"). */
function formatTmuxKey(key: string): string {
  return key.replace(/^S-/, "Shift+").replace(/^C-/, "Ctrl+");
}

type TmuxRow = { label: string; keys: string[] };

/** Group one tmux key table's bindings by label, merge keys, sort. */
function groupTmuxRows(bindings: Keybinding[], table: string): TmuxRow[] {
  const map = new Map<string, string[]>();
  for (const b of bindings) {
    if (b.table !== table) continue;
    const display = formatTmuxKey(b.key);
    const existing = map.get(b.label);
    if (existing) {
      if (!existing.includes(display)) existing.push(display);
    } else {
      map.set(b.label, [display]);
    }
  }
  return Array.from(map, ([label, keys]) => ({ label, keys: keys.sort() })).sort(
    (a, b) => a.label.localeCompare(b.label),
  );
}

/** Keycap parts for a formatted tmux key ("Shift+F3" → ["⇧","F3"] on the mac
 *  display, ["Shift","F3"] otherwise). Free-form caps — tmux keys are pressed
 *  inside the pane and don't ride the app's tier model. */
function tmuxKeyCaps(key: string, displayPlatform: BindingPlatform): string[] {
  return key
    .split("+")
    .map((part) => (displayPlatform === "mac" && part === "Shift" ? "⇧" : part));
}

/** A palette action offered as a macro target in the add flow. */
export type MacroPaletteTarget = { id: string; label: string };

export function SettingsShortcutsPanel({
  paletteTargets,
  riffPresetNames,
}: {
  /** Palette actions offered as macro targets. Absent = no add flow here. */
  paletteTargets?: readonly MacroPaletteTarget[];
  /** Known riff preset names (best-effort fetch while the tab is visible);
   *  null/undefined = unknown (no missing-preset badges, no riff targets in
   *  the add flow). */
  riffPresetNames?: readonly string[] | null;
}) {
  const { bindings, byAction, overrides, host, setBinding, resetBinding, resetAll } =
    useKeybindings();
  const { macros, addMacro, removeMacro } = useMacros();

  // Display platform for keycap rendering — a VIEW toggle only (capture always
  // reads the physical host platform). Initialized from the detected host,
  // then hoisted session-wide like the fold/layer prefs.
  const [displayPlatform, setDisplayPlatformState] = useState<BindingPlatform>(
    viewPrefs.displayPlatform ?? host.platform,
  );
  const setDisplayPlatform = (p: BindingPlatform) => {
    viewPrefs.displayPlatform = p;
    setDisplayPlatformState(p);
  };
  const [query, setQuery] = useState("");
  const [capturingId, setCapturingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ actionId: string; text: string } | null>(null);
  // Map fold + modifier layer (260801-sm6g / 260801-r8j2): the hoisted
  // session-scoped view prefs (see the header comment).
  const [mapFolded, setMapFoldedState] = useState(viewPrefs.mapFolded);
  const [mapTier, setMapTierState] = useState<"shifted" | "cmd">(viewPrefs.mapTier);
  const setMapFolded = (f: boolean) => {
    viewPrefs.mapFolded = f;
    setMapFoldedState(f);
  };
  const setMapTier = (t: "shifted" | "cmd") => {
    viewPrefs.mapTier = t;
    setMapTierState(t);
  };
  // Add-macro flow state (260730-hbyh).
  const [addOpen, setAddOpen] = useState(false);
  const [addQuery, setAddQuery] = useState("");
  const [addTarget, setAddTarget] = useState<{ label: string; target: MacroTarget } | null>(null);
  const [addName, setAddName] = useState("");

  // Section anchors for the jump-nav chips (260801-sm6g).
  const sectionRefs = useRef<Partial<Record<JumpSectionId, HTMLElement | null>>>({});
  const jumpTo = (id: JumpSectionId) =>
    sectionRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "start" });

  // ── tmux bindings (260801-sm6g — the merged read-only section) ───────────
  // Fetched while the panel is mounted (= the visible Shortcuts tab) for the
  // CURRENT server (route-derived; null on board/host routes). `null` =
  // loading; `[]` = no server / empty / failed fetch → the "No tmux server
  // running" empty state. Unmount cancels via the flag.
  const { currentServer } = useSessionContext();
  const [tmuxBindings, setTmuxBindings] = useState<Keybinding[] | null>(null);
  useEffect(() => {
    if (!currentServer) {
      setTmuxBindings([]);
      return;
    }
    let cancelled = false;
    setTmuxBindings(null);
    getKeybindings(currentServer)
      .then((data) => {
        if (!cancelled) setTmuxBindings(data);
      })
      .catch(() => {
        if (!cancelled) setTmuxBindings([]);
      });
    return () => {
      cancelled = true;
    };
  }, [currentServer]);

  // Rebind capture: a capture-phase window listener while a combo is armed.
  // stopPropagation keeps the chord away from the dialog's focus trap, the
  // global dispatcher, and the legacy listeners; Esc cancels the capture only
  // (the dialog does NOT close).
  useEffect(() => {
    if (!capturingId) return;
    const actionId = capturingId;
    function onCaptureKey(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturingId(null);
        return;
      }
      const combo = captureFromEvent(e, host.platform);
      if (!combo) return; // modifier-only / tier-less press — keep capturing
      const self = byAction.get(actionId);
      const stolenFrom = setBinding(actionId, combo);
      // Tier-aware claim match (260730-n789): the mac ⌘ tier carries its own
      // claimed set (shell menu accelerators / browser-reserved keys).
      const claimed = claimedKeys(host.platform, host.shell).find(
        (c) => c.tier === combo.tier && c.code === combo.code,
      );
      if (stolenFrom) {
        const victim = byAction.get(stolenFrom);
        setNotice({
          actionId,
          text: `⚠ took ${formatCombo(combo, host.platform)} from “${victim?.label ?? stolenFrom}” — it is now unbound (rebind or reset it)`,
        });
      } else if (claimed) {
        setNotice({
          actionId,
          text: `⚠ ${formatCombo(combo, host.platform)} is claimed by ${claimed.owner} (${claimed.label}) — it may never reach ${self?.label ?? "this action"}`,
        });
      } else {
        setNotice(null);
      }
      setCapturingId(null);
    }
    window.addEventListener("keydown", onCaptureKey, { capture: true });
    return () => window.removeEventListener("keydown", onCaptureKey, { capture: true });
  }, [capturingId, host, byAction, setBinding]);

  // Per-tier map key states: keycaps/claims follow the DISPLAY platform, the
  // bound/custom states come from the HOST-effective map (the toggle is a
  // rendering toggle — effective bindings are always the current host's).
  // Claimed wins over bound/custom (a browser-reserved N shows claimed, not
  // bound).
  const tierKeyStates = (tier: BindingTier) => {
    const states = new Map<string, { cls: "bound" | "custom" | "claimed"; label: string }>();
    for (const b of bindings) {
      if (b.tier !== tier || !b.enabled) continue;
      states.set(b.code, { cls: b.isDefault ? "bound" : "custom", label: b.mapLabel ?? b.label });
    }
    for (const claim of claimedKeys(displayPlatform, host.shell)) {
      if (claim.tier !== tier) continue;
      states.set(claim.code, { cls: "claimed", label: claim.label });
    }
    return states;
  };
  // The layer the single grid renders: the picker's selection on the macOS
  // display, always the shifted layer on Win·Linux (the ⌘ option is a
  // mac-display affordance — the win/linux "cmd" tier is plain Ctrl, which
  // belongs to the pane; the ⌘ selection survives and reapplies if the display
  // returns to macOS, 260801-r8j2).
  const activeMapTier: BindingTier = displayPlatform === "mac" ? mapTier : "shifted";
  const keyStates = useMemo(
    () => tierKeyStates(activeMapTier),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bindings, displayPlatform, host.shell, activeMapTier],
  );

  const hasOverride = (actionId: string) =>
    Object.prototype.hasOwnProperty.call(overrides, actionId);

  const trimmedQuery = query.trim().toLowerCase();
  const filtering = trimmedQuery !== "";

  const matchesQuery = (b: EffectiveBinding) => {
    if (!filtering) return true;
    return (
      b.label.toLowerCase().includes(trimmedQuery) ||
      (b.description ?? "").toLowerCase().includes(trimmedQuery)
    );
  };

  /** Registry rows for one scope group (macros render in CUSTOM, not here).
   *  Aliases are excluded — they render as an indented continuation of the
   *  action they alias, not as a second row wearing the same label. */
  const rowsForScope = (scope: BindingScope) =>
    bindings.filter(
      (b) =>
        b.kind !== "macro" && b.scope === scope && b.aliasOf == null && matchesQuery(b),
    );

  /** The ENABLED alias rows belonging to one action, in registry order. An
   *  alias that resolves unbound on this host (the Win/Linux palette alias is
   *  keyless on mac) contributes no row — a host that ships no second chord
   *  shows no second chord. */
  const aliasesOf = (actionId: string) =>
    bindings.filter((b) => b.aliasOf === actionId && b.enabled);

  // Shell-owned locked rows (accelerators live in the desktop shell's menu —
  // the registry only documents them). Rendered as a subgroup at the END of
  // GLOBAL (260801-sm6g — demoted from a top-level section). DevTools is a
  // win/linux accelerator. The switcher diverges from the shared shifted-tier
  // caps on BOTH displays (260731-nv5r): the mac shell tier is ⌥⌘ (⇧⌘3/4/5
  // are macOS screenshot shortcuts), and win/linux binds Alt+1–9 — the SPA's
  // surface tile chords own ⇧Ctrl+1–3 there, and Alt sits outside every
  // registry tier (the mac ⌥⌘ precedent). Locked rows are free-form caps
  // arrays, so no tier machinery is involved.
  const shellRows = useMemo(() => {
    const tierCaps = (key: string) =>
      displayPlatform === "mac" ? ["⇧", "⌘", key] : ["Shift", "Ctrl", key];
    const switcherCaps =
      displayPlatform === "mac" ? ["⌥", "⌘", "1…9"] : ["Alt", "1…9"];
    const rows = [
      { label: "Switch to server 1–9", description: "owned by the shell menu", parts: switcherCaps },
      { label: "Force reload", description: undefined, parts: tierCaps("R") },
    ];
    if (displayPlatform !== "mac") {
      rows.push({ label: "DevTools", description: undefined, parts: tierCaps("I") });
    }
    return rows.filter((r) => !filtering || r.label.toLowerCase().includes(trimmedQuery));
  }, [displayPlatform, filtering, trimmedQuery]);

  // Grouped tmux rows + the query filter (label match, like shellRows).
  const tmuxRoot = useMemo(
    () =>
      groupTmuxRows(tmuxBindings ?? [], "root").filter(
        (r) => !filtering || r.label.toLowerCase().includes(trimmedQuery),
      ),
    [tmuxBindings, filtering, trimmedQuery],
  );
  const tmuxPrefix = useMemo(
    () =>
      groupTmuxRows(tmuxBindings ?? [], "prefix").filter(
        (r) => !filtering || r.label.toLowerCase().includes(trimmedQuery),
      ),
    [tmuxBindings, filtering, trimmedQuery],
  );
  const tmuxEmpty = tmuxBindings !== null && tmuxBindings.length === 0;
  const tmuxLoading = tmuxBindings === null;

  // Add-flow target candidates: riff presets (when known) + the mount's
  // palette actions, macros excluded (no macro→macro chains).
  const macroTargetOptions = useMemo(() => {
    const options: { key: string; label: string; target: MacroTarget }[] = [];
    for (const preset of riffPresetNames ?? []) {
      options.push({
        key: `riff:${preset}`,
        label: `riff: ${preset}`,
        target: { type: "riff", preset },
      });
    }
    for (const action of paletteTargets ?? []) {
      if (isMacroActionId(action.id)) continue;
      options.push({
        key: `palette:${action.id}`,
        label: `palette: ${action.label}`,
        target: { type: "palette", paletteActionId: action.id },
      });
    }
    return options;
  }, [riffPresetNames, paletteTargets]);

  const canAddMacro = paletteTargets != null;

  const visibleMacros = macros.filter((m) => {
    if (!filtering) return true;
    return (
      m.label.toLowerCase().includes(trimmedQuery) ||
      macroCommandPreview(m.target).toLowerCase().includes(trimmedQuery)
    );
  });

  const handleAddMacro = () => {
    if (!addTarget || !addName.trim()) return;
    const actionId = addMacro(addName.trim(), addTarget.target);
    setAddOpen(false);
    setAddQuery("");
    setAddTarget(null);
    setAddName("");
    setNotice(null);
    // Arm capture on the fresh row — "name it, capture a key" in one flow.
    setCapturingId(actionId);
  };

  const handleDeleteMacro = (macro: MacroAction) => {
    removeMacro(macro.actionId); // also drops its hexokit-keybindings diff
    if (capturingId === macro.actionId) setCapturingId(null);
    if (notice?.actionId === macro.actionId) setNotice(null);
  };

  // The header hint advertises the HOST-effective overlay chord (260730-n789):
  // the toggle demotes to ⌘/ on mac hosts and user overrides move it, so the
  // effective map is the only accurate source. Formatted for the physical host
  // (the display toggle restyles keycaps; it never changes what THIS host must
  // press). Hidden when the binding is unbound/disabled — a hint advertising
  // a dead chord would lie.
  const sheetBinding = byAction.get("shortcuts-overlay");
  const sheetChord = sheetBinding?.enabled
    ? formatCombo({ code: sheetBinding.code, tier: sheetBinding.tier }, host.platform)
    : null;

  // Jump-nav model (260801-sm6g): per-section live match counts while the
  // filter is active. The custom section's chip renders only when the section
  // itself does; the key-map chip carries no count (the map hides while
  // filtering) and dims like an empty section then.
  const groupCounts: Record<string, number> = {
    global: rowsForScope("global").length + shellRows.length,
    terminal: rowsForScope("terminal").length,
    board: rowsForScope("board").length,
  };
  const customSectionPresent = macros.length > 0 || canAddMacro;
  const tmuxCount = tmuxRoot.length + tmuxPrefix.length;
  const jumpChips: { id: JumpSectionId; label: string; count: number | null }[] = [
    { id: "map", label: "key map", count: null },
    { id: "global", label: "global", count: groupCounts.global },
    { id: "terminal", label: "terminal", count: groupCounts.terminal },
    { id: "board", label: "board", count: groupCounts.board },
    ...(customSectionPresent
      ? [{ id: "custom" as const, label: "custom", count: visibleMacros.length }]
      : []),
    { id: "tmux", label: "tmux", count: tmuxCount },
  ];
  const totalHits =
    groupCounts.global + groupCounts.terminal + groupCounts.board + visibleMacros.length + tmuxCount;

  const keyCell = (
    states: Map<string, { cls: "bound" | "custom" | "claimed"; label: string }>,
    code: string,
    idx: number,
  ) => {
    if (code === "…") {
      // Decorative digit-run ellipsis cell (stands for Digit3–Digit8) — keyed
      // off Digit3 so mid-run claims render (260731-nv5r): the switcher
      // digits on the win/linux display, the ⇧⌘3/4/5 screenshot claims on the
      // mac shifted map (where Digit1/2/9's own cells are unclaimed).
      const digitClaim = states.get("Digit3");
      return (
        <div
          key={`ellipsis-${idx}`}
          className={`w-9 h-9 sm:w-11 sm:h-10 rounded border flex flex-col items-center justify-center text-xs ${digitClaim?.cls === "claimed" ? "opacity-55 border-border bg-bg-inset text-amber-600" : "border-border bg-bg-inset text-text-secondary"}`}
          aria-hidden="true"
        >
          …
        </div>
      );
    }
    const state = states.get(code);
    const base =
      "w-9 h-9 sm:w-11 sm:h-10 rounded border flex flex-col items-center justify-center text-xs transition-colors";
    const cls =
      state?.cls === "bound"
        ? "border-accent-green/60 bg-accent-green/10 text-text-primary"
        : state?.cls === "custom"
          ? "border-accent/70 bg-accent/10 text-text-primary"
          : state?.cls === "claimed"
            ? "opacity-55 border-border bg-bg-inset text-text-secondary"
            : "border-border bg-bg-inset text-text-secondary";
    const small =
      state?.cls === "bound"
        ? "text-accent-green"
        : state?.cls === "custom"
          ? "text-accent-bright"
          : "text-amber-600";
    return (
      <div key={code} className={`${base} ${cls}`} title={state ? state.label : "free"}>
        {keyLabel(code)}
        {state && (
          <small className={`hidden sm:block text-[7.5px] leading-tight text-center px-0.5 ${small}`}>
            {state.label}
          </small>
        )}
      </div>
    );
  };

  /** One editable registry row (grouped scope lists). */
  const bindingRow = (b: EffectiveBinding) => {
    const modified = hasOverride(b.actionId);
    const combo = { code: b.code, tier: b.tier };
    // An alias continues the row above it: same action, second chord. It keeps
    // its own capture/reset affordances (it is independently rebindable) but
    // drops the repeated label so the pair reads as one action.
    const isAlias = b.aliasOf != null;
    return (
      <div key={b.actionId} data-actionid={b.actionId}>
        <div className="group flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-bg-inset/70">
          <span
            className={`w-1.5 h-1.5 rounded-full flex-none ${modified ? "bg-accent" : "bg-transparent"}`}
            title={modified ? "modified from default" : undefined}
          />
          <span className={`flex-1 min-w-0 truncate ${isAlias ? "pl-4 text-text-secondary" : ""}`}>
            {isAlias ? (
              <span className="text-[11px]">↳ also</span>
            ) : (
              <>
                {b.label}
                {b.description && (
                  <span className="text-[11px] text-text-secondary"> — {b.description}</span>
                )}
              </>
            )}
          </span>
          {!isAlias && <ScopeBadge scope={b.scope} />}
          {b.disabledReason === "user" ? (
            <button
              type="button"
              onClick={() => setCapturingId(b.actionId)}
              className="flex-none text-[11px] px-2 py-0.5 rounded border border-amber-600/50 text-amber-600"
              title="unbound — click to rebind"
            >
              unbound
            </button>
          ) : capturingId === b.actionId ? (
            <span className="flex gap-1 items-center px-1 py-0.5 rounded outline outline-1 outline-accent-green">
              <Keycaps parts={["press keys…"]} />
            </span>
          ) : (
            <button
              type="button"
              onClick={() => {
                setNotice(null);
                setCapturingId(b.actionId);
              }}
              aria-label={`Change binding for ${b.label}`}
              title="click to rebind"
              className={`flex gap-1 items-center px-1 py-0.5 rounded hover:outline hover:outline-1 hover:outline-dashed hover:outline-accent-green/60 ${b.disabledReason === "reserved" ? "opacity-50" : ""}`}
            >
              <Keycaps parts={comboParts(combo, displayPlatform)} />
            </button>
          )}
          {b.disabledReason === "reserved" && !host.shell && (
            <span
              className="flex-none text-[9.5px] tracking-wider uppercase px-2 py-px rounded-full border border-accent/60 text-accent-bright"
              title="reserved by the browser — works in the desktop app; use the command palette here"
            >
              desktop
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              resetBinding(b.actionId);
              setNotice(null);
            }}
            aria-label={`Reset binding for ${b.label}`}
            title="reset to default"
            className={`flex-none text-text-secondary hover:text-amber-600 ${modified ? "visible" : "invisible"}`}
          >
            ↺
          </button>
        </div>
        {notice?.actionId === b.actionId && (
          <div className="mx-2 mb-1 px-2.5 py-1 text-[11px] rounded border border-amber-600/45 bg-amber-600/10 text-amber-600">
            {notice.text}
          </div>
        )}
      </div>
    );
  };

  return (
    <div data-testid="settings-shortcuts-panel">
      {/* ── header: platform display toggle + filter + chord hint ──────────
          The toggle is a VIEW control (capture reads the physical host); the
          chord hint reads the host-effective `shortcuts-overlay` binding. */}
      <div className="flex items-center gap-3 pb-3 border-b border-border flex-wrap">
        <div className="flex flex-none border border-border rounded overflow-hidden" role="group" aria-label="Keycap platform">
          {(["mac", "other"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setDisplayPlatform(p)}
              className={`text-[11px] px-2.5 py-1 ${displayPlatform === p ? SELECTED_FILL : "text-text-secondary hover:text-accent-green"}`}
            >
              {p === "mac" ? "macOS" : "Win · Linux"}
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter all shortcuts — app, custom & tmux…"
          aria-label="Filter shortcuts"
          className={`flex-1 min-w-[120px] text-xs bg-bg-inset border border-border rounded px-2.5 py-1 ${INPUT_FOCUS} text-text-primary placeholder:text-text-secondary`}
        />
        {sheetChord && (
          <span className="hidden md:inline text-[11px] text-text-secondary whitespace-nowrap">
            {sheetChord} toggles this sheet
          </span>
        )}
      </div>

      {/* ── jump nav (260801-sm6g — the tabs alternative) ──────────────
          Plain chips scroll to a section; while the filter is active each
          chip shows its live match count so hits below the fold stay
          visible, and zero-hit chips dim. Sticky within the tab panel's own
          scroll container. */}
      <nav
        aria-label="Shortcut sections"
        data-testid="shortcuts-jump-nav"
        className="sticky top-0 z-10 flex items-center gap-1.5 flex-wrap py-2 border-b border-border bg-bg-primary/95 backdrop-blur-sm"
      >
        <span className="text-[10px] tracking-wider text-text-secondary select-none mr-0.5">
          JUMP:
        </span>
        {jumpChips.map((chip) => {
          const empty = filtering && (chip.count === null || chip.count === 0);
          return (
            <button
              key={chip.id}
              type="button"
              onClick={() => jumpTo(chip.id)}
              className={`text-[10.5px] tracking-wide px-2.5 py-px rounded-full border border-border text-text-secondary hover:text-accent-green hover:border-accent-green ${empty ? "opacity-40" : ""}`}
            >
              {chip.label}
              {filtering && chip.count !== null && (
                <span className={`ml-1.5 text-[9.5px] ${chip.count > 0 ? "text-accent-green" : "text-text-secondary"}`}>
                  {chip.count}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* ── key map (single grid + modifier picker; app layers only; foldable) ──
          Auto-hidden entirely while a filter is active: the map cannot
          answer a text query, and the reclaimed space keeps row hits above
          the fold. */}
      {!filtering && (
        <div
          ref={(el) => {
            sectionRefs.current.map = el;
          }}
          className="pt-4 pb-2 scroll-mt-12"
        >
          <div className="flex justify-between items-center flex-wrap gap-1.5 text-[11px] text-text-secondary">
            {/* The picker IS the map label (260801-r8j2): "Holding" + the
                selected modifier caps. On the Win·Linux display only the
                shifted layer exists, so a static label replaces the
                one-option picker. */}
            <span className="flex items-center gap-1.5">
              Holding
              {displayPlatform === "mac" ? (
                <span
                  className="flex flex-none border border-border rounded overflow-hidden"
                  role="group"
                  aria-label="Keyboard map modifier"
                >
                  {(["cmd", "shifted"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setMapTier(t)}
                      aria-pressed={mapTier === t}
                      className={`text-[10.5px] px-2 py-0.5 ${mapTier === t ? SELECTED_FILL : "text-text-secondary hover:text-accent-green"}`}
                    >
                      {t === "shifted" ? "⇧ ⌘" : "⌘"}
                    </button>
                  ))}
                </span>
              ) : (
                <b className="text-text-primary">Shift Ctrl</b>
              )}
            </span>
            <span>plain Ctrl always reaches the pane</span>
            <button
              type="button"
              onClick={() => setMapFolded(!mapFolded)}
              aria-expanded={!mapFolded}
              className="text-[10.5px] text-text-secondary hover:text-accent-green px-1"
            >
              {mapFolded ? "▸ expand map" : "▾ collapse map"}
            </button>
          </div>
          {!mapFolded && (
            <>
              <div className="flex flex-col items-center gap-1.5 mt-2.5" aria-hidden="true">
                {KEY_ROWS.map((row, i) => (
                  <div key={i} className="flex gap-1.5">
                    {row.map((code, j) => keyCell(keyStates, code, j))}
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-4 mt-3 text-[10.5px] text-text-secondary">
                <span><i className="inline-block w-2 h-2 mr-1 rounded-sm border border-accent-green bg-accent-green/25" />bound</span>
                <span><i className="inline-block w-2 h-2 mr-1 rounded-sm border border-accent bg-accent/25" />custom</span>
                <span><i className="inline-block w-2 h-2 mr-1 rounded-sm border border-amber-600/60 bg-amber-600/20" />claimed — taken by the OS / browser / app menu (the desktop app frees the browser ones)</span>
                <span><i className="inline-block w-2 h-2 mr-1 rounded-sm border border-border" />free</span>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── grouped rows ───────────────────────────────── */}
      <div className="pb-4">
        {GROUPS.map((group) => {
          // Macros render in their own CUSTOM section below, not here.
          const rows = rowsForScope(group.scope);
          // The GLOBAL section also hosts the shell-owned subgroup
          // (260801-sm6g — demoted from a top-level section), so it renders
          // whenever either has rows.
          const isGlobal = group.scope === "global";
          if (rows.length === 0 && !(isGlobal && shellRows.length > 0)) return null;
          return (
            <section
              key={group.name}
              ref={(el) => {
                sectionRefs.current[group.scope as JumpSectionId] = el;
              }}
              className="mt-4 scroll-mt-12"
            >
              <SectionHead name={group.name} />
              {rows.flatMap((row) => [
                bindingRow(row),
                ...aliasesOf(row.actionId).map(bindingRow),
              ])}
              {/* Shell-owned locked rows — accelerators live in the shell
                  menu; a GLOBAL subgroup, not a top-level section. */}
              {isGlobal && shellRows.length > 0 && (
                <>
                  {/* Subheads hide while filtering (mock behavior) — the
                      matched rows carry enough context on their own. */}
                  {!filtering && (
                    <SubHead>Shell-owned — accelerators live in the desktop shell menu</SubHead>
                  )}
                  {shellRows.map((row) => (
                    <LockedRow
                      key={row.label}
                      label={row.label}
                      description={row.description}
                      seq={[row.parts]}
                      lockAria="Locked — bound by the desktop shell menu"
                      lockTitle="bound by the desktop shell menu — edit there"
                    />
                  ))}
                </>
              )}
            </section>
          );
        })}

        {/* CUSTOM — user macros over riff presets / palette actions (260730-hbyh). */}
        {customSectionPresent && (
          <section
            className="mt-4 scroll-mt-12"
            data-testid="macro-section"
            ref={(el) => {
              sectionRefs.current.custom = el;
            }}
          >
            <SectionHead name="CUSTOM" note="macros — riff presets & palette actions" />
            {visibleMacros.map((m) => {
              const b = byAction.get(m.actionId);
              if (!b) return null;
              const combo = { code: b.code, tier: b.tier };
              const missingPreset =
                m.target.type === "riff" &&
                riffPresetNames != null &&
                !riffPresetNames.includes(m.target.preset);
              return (
                <div key={m.actionId} data-actionid={m.actionId}>
                  <div className="group flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-bg-inset/70">
                    <span className="w-1.5 h-1.5 rounded-full flex-none bg-transparent" />
                    <span className="flex-1 min-w-0 truncate">{m.label}</span>
                    <span
                      className="flex-none max-w-[46ch] truncate font-mono text-[11px] text-text-secondary bg-bg-inset border border-border rounded px-2 py-px"
                      title={macroCommandPreview(m.target)}
                    >
                      {macroCommandPreview(m.target)}
                    </span>
                    {missingPreset && (
                      <span
                        className="flex-none text-[9.5px] tracking-wider uppercase px-2 py-px rounded-full border border-red-500/60 text-red-500"
                        title={`preset “${m.target.type === "riff" ? m.target.preset : ""}” is not among this session's riff presets — running the macro will fail with an error toast`}
                      >
                        missing preset
                      </span>
                    )}
                    {capturingId === m.actionId ? (
                      <span className="flex gap-1 items-center px-1 py-0.5 rounded outline outline-1 outline-accent-green">
                        <Keycaps parts={["press keys…"]} />
                      </span>
                    ) : b.disabledReason === "user" ? (
                      <button
                        type="button"
                        onClick={() => setCapturingId(m.actionId)}
                        className="flex-none text-[11px] px-2 py-0.5 rounded border border-amber-600/50 text-amber-600"
                        title="unbound — click to bind"
                      >
                        unbound
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setNotice(null);
                          setCapturingId(m.actionId);
                        }}
                        aria-label={`Change binding for ${m.label}`}
                        title="click to rebind"
                        className={`flex gap-1 items-center px-1 py-0.5 rounded hover:outline hover:outline-1 hover:outline-dashed hover:outline-accent-green/60 ${b.disabledReason === "reserved" ? "opacity-50" : ""}`}
                      >
                        <Keycaps parts={comboParts(combo, displayPlatform)} />
                      </button>
                    )}
                    {b.disabledReason === "reserved" && (
                      <span
                        className="flex-none text-[9.5px] tracking-wider uppercase px-2 py-px rounded-full border border-amber-600/50 text-amber-600"
                        title="browser-reserved — rebind; the desktop shell frees this key"
                      >
                        browser
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => handleDeleteMacro(m)}
                      aria-label={`Delete macro ${m.label}`}
                      title="delete this macro"
                      className="flex-none text-text-secondary hover:text-red-500"
                    >
                      ✕
                    </button>
                  </div>
                  {notice?.actionId === m.actionId && (
                    <div className="mx-2 mb-1 px-2.5 py-1 text-[11px] rounded border border-amber-600/45 bg-amber-600/10 text-amber-600">
                      {notice.text}
                    </div>
                  )}
                </div>
              );
            })}
            {canAddMacro && !addOpen && (
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="w-full text-left mt-1 px-2 py-1.5 text-[11px] text-text-secondary rounded border border-dashed border-border hover:text-accent-green hover:border-accent-green/60"
              >
                + bind a key to a palette action or riff preset…
              </button>
            )}
            {canAddMacro && addOpen && (
              <div className="mt-1 px-2 py-2 rounded border border-dashed border-border flex flex-col gap-1.5">
                <input
                  value={addQuery}
                  onChange={(e) => setAddQuery(e.target.value)}
                  placeholder="search riff presets + palette actions…"
                  aria-label="Search macro targets"
                  autoFocus
                  className={`w-full text-xs bg-bg-inset border border-border rounded px-2.5 py-1 ${INPUT_FOCUS} text-text-primary placeholder:text-text-secondary`}
                />
                <div className="max-h-36 overflow-y-auto flex flex-col">
                  {macroTargetOptions
                    .filter((o) => o.label.toLowerCase().includes(addQuery.trim().toLowerCase()))
                    .map((o) => (
                      <button
                        key={o.key}
                        type="button"
                        onClick={() => {
                          setAddTarget({ label: o.label, target: o.target });
                          setAddName(o.label);
                        }}
                        className={`text-left text-[11px] px-2 py-1 rounded font-mono ${addTarget?.label === o.label ? SELECTED_FILL : "text-text-secondary hover:text-text-primary hover:bg-bg-inset/70"}`}
                      >
                        {o.label}
                      </button>
                    ))}
                  {macroTargetOptions.length === 0 && (
                    <span className="text-[11px] text-text-secondary px-2 py-1">
                      no targets available here
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    value={addName}
                    onChange={(e) => setAddName(e.target.value)}
                    placeholder="macro name"
                    aria-label="Macro name"
                    className={`flex-1 min-w-0 text-xs bg-bg-inset border border-border rounded px-2.5 py-1 ${INPUT_FOCUS} text-text-primary placeholder:text-text-secondary`}
                  />
                  <button
                    type="button"
                    onClick={handleAddMacro}
                    disabled={!addTarget || !addName.trim()}
                    className="rk-glint flex-none text-[11px] px-3 py-1 rounded border border-border text-text-primary disabled:opacity-40 hover:border-accent-green hover:text-accent-green"
                  >
                    add + capture key
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAddOpen(false);
                      setAddQuery("");
                      setAddTarget(null);
                      setAddName("");
                    }}
                    className="flex-none text-[11px] px-2 py-1 text-text-secondary hover:text-text-primary"
                  >
                    cancel
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {/* TMUX (260801-sm6g) — read-only locked rows from the current
            server's curated `GET /api/keybindings` whitelist. tmux keys are
            pressed inside the pane; run-kit only documents them, so the
            rows take the same locked idiom as the shell subgroup. Hidden
            while filtering with zero hits (like every other section). */}
        {!(filtering && tmuxCount === 0) && (
          <section
            className="mt-4 scroll-mt-12"
            data-testid="tmux-section"
            ref={(el) => {
              sectionRefs.current.tmux = el;
            }}
          >
            <SectionHead
              name="TMUX"
              note={
                currentServer && !tmuxEmpty ? (
                  <>
                    read-only — from tmux server{" "}
                    <b className="text-amber-600 font-normal">{currentServer}</b> · pressed
                    inside the pane
                  </>
                ) : undefined
              }
            />
            {tmuxLoading ? (
              <div className="px-2 py-1.5 text-[11px] text-text-secondary">Loading…</div>
            ) : tmuxEmpty ? (
              <div className="px-2 py-1.5 text-[11px] italic text-text-secondary">
                No tmux server running
              </div>
            ) : (
              <>
                {tmuxRoot.length > 0 && !filtering && <SubHead>Direct</SubHead>}
                {tmuxRoot.map((row) => (
                  <LockedRow
                    key={`root-${row.label}`}
                    label={row.label}
                    seq={row.keys.map((k) => tmuxKeyCaps(k, displayPlatform))}
                    lockAria="Locked — a tmux binding, pressed inside the pane"
                    lockTitle="tmux binding — pressed inside the pane"
                  />
                ))}
                {tmuxPrefix.length > 0 && !filtering && (
                  <SubHead>
                    Prefix — <span className="normal-case">Ctrl+S, then key</span>
                  </SubHead>
                )}
                {tmuxPrefix.map((row) => (
                  <LockedRow
                    key={`prefix-${row.label}`}
                    label={row.label}
                    seq={[
                      ["Ctrl", "S"],
                      "then",
                      ...row.keys.map((k) => tmuxKeyCaps(k, displayPlatform)),
                    ]}
                    lockAria="Locked — a tmux binding, pressed inside the pane"
                    lockTitle="tmux binding — pressed inside the pane"
                  />
                ))}
              </>
            )}
          </section>
        )}

        {/* No hits across every section (mock `#no-hits`). */}
        {filtering && totalHits === 0 && (
          <div className="text-center py-5 text-[11px] italic text-text-secondary">
            no shortcuts match — try a shorter term · the filter spans app, custom &amp; tmux keys
          </div>
        )}
      </div>

      {/* ── footer ─────────────────────────────────────── */}
      <div className="flex items-center gap-2.5 py-3 border-t border-border text-[11px] text-text-secondary flex-wrap">
        <span>
          app &amp; custom bindings are stored in this browser{" "}
          <span className="opacity-60">(localStorage · hexokit-keybindings)</span> · tmux keys
          are read live from the server
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => {
            resetAll();
            setNotice(null);
          }}
          className="rk-glint text-[11px] px-3 py-1 rounded border border-border text-text-primary hover:border-red-500 hover:text-red-500"
        >
          reset all
        </button>
      </div>
    </div>
  );
}
