import {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  useId,
  type ReactNode,
} from "react";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useOccludes } from "@/hooks/use-occludes";
import { INPUT_FOCUS } from "@/components/controls";
import { useKeybindings } from "@/hooks/use-keybindings";
import { matchesCombo, type EffectiveBinding } from "@/lib/keybindings";
import { shouldShowAskOperatorRow } from "@/lib/quake-terminal";
import { rankActions } from "@/lib/palette/rank";
import { readPaletteMru, recordPaletteUse } from "@/lib/palette/mru";

export type PaletteOptionPicker = {
  options: { key: string; label: string }[];
  /** Instructional placeholder shown while the sub-step is active. */
  placeholder?: string;
  /** Called with the selected keys in selection order (= priority). */
  onApply: (orderedKeys: string[]) => void;
};

export type PaletteSubList = {
  /** Instructional placeholder shown while the sub-step is active. */
  placeholder?: string;
  /** Eager rows, or a loader fired once on sub-step entry (pending renders a
   *  non-selectable `Loading…` row, a rejection `Couldn't load choices`). */
  rows: PaletteAction[] | (() => Promise<PaletteAction[]>);
};

export type PaletteAction = {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Optional secondary text after the label (the shortcuts panel's
   *  `label — description` idiom); joins the filter haystack. */
  description?: string;
  shortcut?: string;
  /** When set, first selection enters a one-row confirmation step. */
  confirmLabel?: string;
  /** When set, first selection enters a multi-toggle option sub-step:
   * Space/click toggles options (order badges = selection order), Enter
   * applies, Esc/backdrop/⌘K cancel. */
  optionPicker?: PaletteOptionPicker;
  /** When set, first selection enters a single-select sub-step listing the
   *  rows (eager or lazy) as plain display rows — a row's own
   *  confirmLabel/optionPicker/subList are dropped, so a sub-step can never
   *  recurse. Enter/click on a row closes the palette and fires that row's
   *  onSelect; Esc/backdrop/⌘K cancel. */
  subList?: PaletteSubList;
  /** Renders the row dimmed and inert (selecting it is a no-op) — the
   *  palette's disabled affordance (e.g. a switch target whose growth is
   *  disallowed). Prefer omitting the row when the action is simply
   *  unavailable. */
  disabled?: boolean;
  onSelect: () => void;
};

type CommandPaletteProps = {
  actions: PaletteAction[];
  /** The Ask-operator free-text on-ramp: when the query matches NO action and
   *  the resolved server has an operator window, a standing last row offers
   *  `Ask operator: "{query}"`; selecting it closes the palette and hands the
   *  query to the quake terminal (open + immediate send). Omitted entirely
   *  (never disabled) when the gate fails. */
  askOperator?: { hasOperator: boolean; onAsk: (query: string) => void };
};

export function CommandPalette({ actions, askOperator }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [confirming, setConfirming] = useState<PaletteAction | null>(null);
  const [picking, setPicking] = useState<PaletteAction | null>(null);
  const [pickedKeys, setPickedKeys] = useState<string[]>([]);
  const [subListing, setSubListing] = useState<PaletteAction | null>(null);
  // null = the lazy loader is still in flight.
  const [subRows, setSubRows] = useState<PaletteAction[] | null>(null);
  const [subError, setSubError] = useState(false);
  // Bumped on every sub-list entry/exit so a loader resolving after a cancel
  // (or after a second entry) can never resurrect stale rows.
  const subListGenRef = useRef(0);
  // Seeded lazily so the first keystroke is already ranked; a recorded use
  // threads the returned list back into state without a re-read.
  const [mru, setMru] = useState<string[]>(() => readPaletteMru());
  const paletteRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const closePalette = useCallback(() => {
    subListGenRef.current += 1;
    setOpen(false);
    setConfirming(null);
    setPicking(null);
    setPickedKeys([]);
    setSubListing(null);
    setSubRows(null);
    setSubError(false);
  }, []);

  // The hook owns Escape (document-level, so it fires regardless of which
  // element inside the palette has focus), Tab containment, and initial focus
  // (the input is the container's first — and only — focusable element).
  useFocusTrap(paletteRef, open, closePalette);
  useOccludes("modal", open);

  // Rows are non-focusable divs: a mouse click on one blurs the input to
  // <body>, which would eat the next Space/Enter of a mixed mouse+keyboard
  // sub-step flow. Refocus the input whenever a sub-step activates or a row
  // is click-toggled.
  useEffect(() => {
    if (confirming || picking || subListing) inputRef.current?.focus();
  }, [confirming, picking, pickedKeys, subListing]);

  const rankedActions = useMemo(
    () => rankActions(actions, query, mru),
    [actions, query, mru],
  );

  const baseFiltered = confirming
    ? [
        {
          ...confirming,
          id: `${confirming.id}-confirm`,
          label: confirming.confirmLabel ?? confirming.label,
          confirmLabel: undefined,
        },
      ]
    : picking?.optionPicker
      ? // Sub-step rows are plain display rows: no confirmLabel/optionPicker,
        // so a sub-step can never recurse.
        picking.optionPicker.options.map((o): PaletteAction => ({
          id: `${picking.id}-opt-${o.key}`,
          label: o.label,
          onSelect: () => {},
        }))
      : subListing
        ? subError
          ? [
              {
                id: `${subListing.id}-load-error`,
                label: "Couldn't load choices",
                disabled: true,
                onSelect: () => {},
              },
            ]
          : subRows === null
            ? [
                {
                  id: `${subListing.id}-loading`,
                  label: "Loading…",
                  disabled: true,
                  onSelect: () => {},
                },
              ]
            : // Display rows by construction: only id/label/description/
              // disabled/onSelect survive, so a sub-step can never recurse.
              subRows.map((row): PaletteAction => ({
                id: `${subListing.id}-sub-${row.id}`,
                label: row.label,
                description: row.description,
                disabled: row.disabled,
                onSelect: row.onSelect,
              }))
        : rankedActions;

  // The Ask-operator fallback row rides the ordinary row machinery (selection,
  // Enter, scroll-into-view) as a synthesized last row — present ONLY at zero
  // action matches on an operator-bearing server with a floor-length query,
  // so it never crowds a real result list.
  const showAskRow =
    confirming === null &&
    picking === null &&
    subListing === null &&
    askOperator !== undefined &&
    shouldShowAskOperatorRow(query, baseFiltered.length, askOperator.hasOperator);
  const filtered: PaletteAction[] = showAskRow
    ? [
        {
          id: "ask-operator",
          label: `Ask operator: "${query.trim()}"`,
          onSelect: () => askOperator.onAsk(query.trim()),
        },
      ]
    : baseFiltered;

  // The toggle chords come from the keybinding registry: ⌘K on mac, and on
  // Win/Linux both Ctrl+K and the shifted alias. `ignoreInputs` semantics are
  // inherent here — this listener runs on `document` and consults no
  // suppression predicate, so the chords keep firing inside text inputs. A
  // per-device override rebinds either. Held in a ref so the listener effect
  // registers once — override changes swap the ref, not the listener.
  const { bindings } = useKeybindings();
  // Every enabled chord that opens the palette: the `command-palette` binding
  // plus any binding aliasing it (Win/Linux ships a shifted-tier alias, the
  // only form that survives terminal focus). This listener — not the window
  // dispatcher — is the palette's opener, so an alias reaches the palette
  // only by being matched here.
  const toggleBindingsRef = useRef<EffectiveBinding[]>([]);
  toggleBindingsRef.current = bindings.filter(
    (b) =>
      b.enabled && (b.actionId === "command-palette" || b.aliasOf === "command-palette"),
  );

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (toggleBindingsRef.current.some((b) => matchesCombo(e, b))) {
        e.preventDefault();
        subListGenRef.current += 1;
        setConfirming(null);
        setPicking(null);
        setPickedKeys([]);
        setSubListing(null);
        setSubRows(null);
        setSubError(false);
        setOpen((prev) => !prev);
        setQuery("");
        setSelectedIndex(0);
      }
    }
    function handlePaletteOpen() {
      subListGenRef.current += 1;
      setOpen(true);
      setConfirming(null);
      setPicking(null);
      setPickedKeys([]);
      setSubListing(null);
      setSubRows(null);
      setSubError(false);
      setQuery("");
      setSelectedIndex(0);
    }
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("palette:open", handlePaletteOpen);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("palette:open", handlePaletteOpen);
    };
  }, []);

  // Scroll selected item into view
  useEffect(() => {
    if (!open || !listRef.current) return;
    const selected = listRef.current.querySelector('[aria-selected="true"]');
    if (selected && typeof selected.scrollIntoView === "function") {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, open]);

  // Records only real invocations: entering a sub-step, picking a disabled
  // row, or cancelling records nothing. The confirm row carries a synthetic
  // `${id}-confirm` id that matches no registered action, so the ORIGINATING
  // action's id is recorded — never the row's.
  const recordUse = useCallback((id: string) => {
    setMru(recordPaletteUse(id));
  }, []);

  const handleSelect = useCallback(
    (action: PaletteAction) => {
      if (action.disabled) return;
      if (action.subList) {
        subListGenRef.current += 1;
        const gen = subListGenRef.current;
        setSubListing(action);
        setSubError(false);
        setQuery("");
        setSelectedIndex(0);
        const rows = action.subList.rows;
        if (typeof rows === "function") {
          setSubRows(null);
          rows().then(
            (resolved) => {
              if (subListGenRef.current === gen) setSubRows(resolved);
            },
            () => {
              if (subListGenRef.current === gen) setSubError(true);
            },
          );
        } else {
          setSubRows(rows);
        }
        return;
      }
      if (action.optionPicker) {
        setPicking(action);
        setPickedKeys([]);
        setQuery("");
        setSelectedIndex(0);
        return;
      }
      if (action.confirmLabel) {
        setConfirming(action);
        setQuery("");
        setSelectedIndex(0);
        return;
      }
      closePalette();
      // Sub-step and fallback rows carry ids that match no registered action
      // (`${id}-confirm`, `${id}-sub-${row}`, `ask-operator`), so the MRU takes
      // the ORIGINATING action's id — and nothing when there is no such action.
      const originatingId =
        confirming?.id ?? subListing?.id ?? (showAskRow ? null : action.id);
      if (originatingId) recordUse(originatingId);
      action.onSelect();
    },
    [closePalette, confirming, subListing, showAskRow, recordUse],
  );

  const togglePick = useCallback((key: string) => {
    setPickedKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === " " && picking?.optionPicker) {
      e.preventDefault();
      const opt = picking.optionPicker.options[selectedIndex];
      if (opt) togglePick(opt.key);
    } else if (e.key === "Enter" && filtered[selectedIndex]) {
      e.preventDefault();
      if (picking?.optionPicker) {
        // Zero selected is a no-op, not a dismiss: an accidental Enter must
        // not fire an empty apply or eat the picker state.
        if (pickedKeys.length === 0) return;
        const { onApply } = picking.optionPicker;
        const keys = pickedKeys;
        recordUse(picking.id);
        closePalette();
        onApply(keys);
        return;
      }
      handleSelect(filtered[selectedIndex]);
    }
  }

  if (!open) return null;

  // 1-based badge position per picked key (selection order = priority).
  const pickedPos = new Map(pickedKeys.map((k, idx) => [k, idx + 1]));

  const activeDescendant = filtered[selectedIndex]
    ? `${listId}-option-${filtered[selectedIndex].id}`
    : undefined;

  return (
    <div
      data-testid="palette-overlay"
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
      onClick={closePalette}
    >
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50" aria-hidden="true" />

      {/* Modal */}
      <div
        ref={paletteRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative w-full max-w-lg bg-bg-primary border border-border rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            if (confirming || picking || subListing) return;
            setQuery(e.target.value);
            setSelectedIndex(0);
          }}
          onKeyDown={handleKeyDown}
          readOnly={confirming !== null || picking !== null || subListing !== null}
          // Placeholder education (260811-ke2s): the prefix namespaces
          // (Board:/Pin:/View:/Window:) are an entire hidden command system with
          // no other always-visible surface. Typed prefixes, not chords — so no
          // coarse-pointer branch.
          placeholder={
            subListing
              ? (subListing.subList?.placeholder ?? "Pick one — Enter select · Esc cancel")
              : picking?.optionPicker
                ? (picking.optionPicker.placeholder ?? "Pick options — Space toggle · Enter apply")
                : confirming
                  ? "Confirm action..."
                  : "Type a command — try Board: Pin: View: Tab:"
          }
          aria-label="Search commands"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={activeDescendant}
          role="combobox"
          aria-expanded="true"
          className={`w-full bg-transparent text-text-primary text-[11px] p-2.5 border-b border-border ${INPUT_FOCUS} placeholder:text-text-secondary`}
        />
        <div
          id={listId}
          ref={listRef}
          role="listbox"
          aria-label="Commands"
          className="max-h-64 overflow-y-auto py-1"
        >
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-xs text-text-secondary">
              No results — try a prefix: Board:, Pin:, View:, Tab:
            </div>
          ) : (
            filtered.map((action, i) => {
              const optKey = picking?.optionPicker?.options[i]?.key;
              const badge = optKey !== undefined ? pickedPos.get(optKey) : undefined;
              return (
                <div
                  key={action.id}
                  id={`${listId}-option-${action.id}`}
                  role="option"
                  aria-selected={i === selectedIndex}
                  aria-disabled={action.disabled || undefined}
                  onClick={() =>
                    optKey !== undefined ? togglePick(optKey) : handleSelect(action)
                  }
                  className={`w-full text-left px-2.5 py-1.5 text-[11px] flex items-center justify-between ${
                    action.disabled
                      ? "opacity-40 cursor-not-allowed text-text-secondary"
                      : `cursor-pointer ${
                          i === selectedIndex
                            ? "bg-bg-card text-text-primary"
                            : "text-text-secondary hover:text-text-primary hover:bg-bg-card/50"
                        }`
                  }`}
                >
                  {action.icon ? (
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="shrink-0">{action.icon}</span>
                      <span className="min-w-0 truncate">
                        {action.label}
                        {action.description && (
                          <span className="text-text-secondary"> — {action.description}</span>
                        )}
                      </span>
                    </span>
                  ) : (
                    <span>
                      {action.label}
                      {action.description && (
                        <span className="text-text-secondary"> — {action.description}</span>
                      )}
                    </span>
                  )}
                  {badge !== undefined && (
                    <kbd className="text-xs text-text-secondary bg-bg-card px-1.5 py-0.5 rounded border border-border">
                      {badge}
                    </kbd>
                  )}
                  {action.shortcut && (
                    <kbd className="text-xs text-text-secondary bg-bg-card px-1.5 py-0.5 rounded border border-border">
                      {action.shortcut}
                    </kbd>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
