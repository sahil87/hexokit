import { useState, useCallback, useRef, useEffect, useSyncExternalStore } from "react";
import { useModifierState, type ModifierSnapshot } from "@/hooks/use-modifier-state";
import { useFocusedTerminal } from "@/contexts/focused-terminal-context";
import { useChromeState, useChromeDispatch } from "@/contexts/chrome-context";
import { controlClass } from "@/components/control";
import { POPOVER_SHELL } from "@/components/controls";
import { Tip, TipGroup } from "@/components/tip";
import {
  focusComposeStrip,
  isComposeStripFocused,
  subscribeComposeStripFocus,
} from "@/lib/compose-strip-events";
import { chordHintFor } from "@/lib/keybindings";
import { useKeybindings } from "@/hooks/use-keybindings";
import { useOccludes } from "@/hooks/use-occludes";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";

type BottomBarProps = {
  onOpenCompose?: () => void;
  onFocusTerminal?: () => void;
};

/** xterm modifier parameter: 1 + (alt?2:0) + (ctrl?4:0) */
function modParam(mods: ModifierSnapshot): number {
  let p = 1;
  if (mods.alt) p += 2;
  if (mods.ctrl) p += 4;
  return p;
}

function hasModifiers(mods: ModifierSnapshot): boolean {
  return mods.ctrl || mods.alt;
}

const FN_KEYS = [
  { label: "F1", plain: "\x1bOP", mod: (p: number) => `\x1b[1;${p}P` },
  { label: "F2", plain: "\x1bOQ", mod: (p: number) => `\x1b[1;${p}Q` },
  { label: "F3", plain: "\x1bOR", mod: (p: number) => `\x1b[1;${p}R` },
  { label: "F4", plain: "\x1bOS", mod: (p: number) => `\x1b[1;${p}S` },
  { label: "F5", plain: "\x1b[15~", mod: (p: number) => `\x1b[15;${p}~` },
  { label: "F6", plain: "\x1b[17~", mod: (p: number) => `\x1b[17;${p}~` },
  { label: "F7", plain: "\x1b[18~", mod: (p: number) => `\x1b[18;${p}~` },
  { label: "F8", plain: "\x1b[19~", mod: (p: number) => `\x1b[19;${p}~` },
  { label: "F9", plain: "\x1b[20~", mod: (p: number) => `\x1b[20;${p}~` },
  { label: "F10", plain: "\x1b[21~", mod: (p: number) => `\x1b[21;${p}~` },
  { label: "F11", plain: "\x1b[23~", mod: (p: number) => `\x1b[23;${p}~` },
  { label: "F12", plain: "\x1b[24~", mod: (p: number) => `\x1b[24;${p}~` },
] as const;

const EXT_KEYS = [
  { label: "PgUp", plain: "\x1b[5~", mod: (p: number) => `\x1b[5;${p}~` },
  { label: "PgDn", plain: "\x1b[6~", mod: (p: number) => `\x1b[6;${p}~` },
  { label: "Home", plain: "\x1b[H", mod: (p: number) => `\x1b[1;${p}H` },
  { label: "End", plain: "\x1b[F", mod: (p: number) => `\x1b[1;${p}F` },
  { label: "Ins", plain: "\x1b[2~", mod: (p: number) => `\x1b[2;${p}~` },
  { label: "Del", plain: "\x1b[3~", mod: (p: number) => `\x1b[3;${p}~` },
] as const;

/** Long-press duration (ms) to toggle scroll-lock. */
const LONG_PRESS_MS = 500;

/** Touch move distance (px) that cancels a long-press. */
const LONG_PRESS_MOVE_THRESHOLD = 10;

const MODIFIER_LABELS: Record<string, string> = {
  ctrl: "Control",
  alt: "Option",
};

/** Tier-1 tip copy for the modifier latch chips: plain key names in terminal
 *  vocabulary ("Ctrl"/"Alt" — what the chip SENDS), while the aria-labels
 *  above keep the mac key names matching the glyphs. The one-shot latch
 *  behavior isn't spelled out — the pressed/latched state teaches it on first
 *  tap, and every other chip tip likewise just names its key. */
const MODIFIER_TIP_LABELS: Record<string, string> = {
  ctrl: "Ctrl",
  alt: "Alt",
};

/** Prevent mousedown from stealing focus away from the terminal. */
const preventFocusSteal = (e: React.MouseEvent) => e.preventDefault();

export function BottomBar({ onOpenCompose, onFocusTerminal }: BottomBarProps) {
  const { focused } = useFocusedTerminal();
  // Scroll-lock is a persisted chrome preference (ChromeContext,
  // `hexokit-scroll-lock`) so it survives remounts, route changes, and mobile
  // tab reloads — a per-mount useState here silently reset the lock on every
  // one of those, which is how the keyboard kept coming back mid-read.
  const { composeStripEnabled, scrollLocked } = useChromeState();
  const { setScrollLocked } = useChromeDispatch();
  const wsRef = focused?.wsRef;
  const mods = useModifierState();
  const [fnOpen, setFnOpen] = useState(false);
  const fnRef = useRef<HTMLDivElement>(null);
  // Menus register `transient` (overlay-presence): while open, a native guest
  // composited above the DOM hides so the menu never paints underneath it.
  useOccludes("transient", fnOpen);
  // HOST-effective chords for the chip tips' kbd slots (the settings-gear
  // chord pattern, 260801-mqim): reflect overrides, omitted when
  // unbound/disabled (a tip advertising a dead chord would lie).
  const { bindings: keybindings, host: keybindingHost } = useKeybindings();
  const chordFor = (actionId: string) =>
    chordHintFor(actionId, keybindings, keybindingHost.platform);
  const composeChord = chordFor("compose-toggle");
  const paletteChord = chordFor("command-palette");
  // Pointer gate for the compose hint (260811-0f3d): chords are noise on
  // touch — the § Education micro-copy coarse-pointer rule.
  const coarse = useCoarsePointer();
  // Compose-focus signal (260814-ink6): the strip publishes its textarea's
  // focus state to a module store so this sibling can self-gate — both
  // footer mounts (app.tsx / board-page.tsx) inherit the hide with no wiring.
  const composeFocused = useSyncExternalStore(
    subscribeComposeStripFocus,
    isComposeStripFocused,
  );

  useEffect(() => {
    if (!fnOpen) return;
    function handleClick(e: MouseEvent) {
      if (fnRef.current && !fnRef.current.contains(e.target as Node)) {
        setFnOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [fnOpen]);

  useEffect(() => {
    if (!fnOpen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") { setFnOpen(false); }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [fnOpen]);

  useEffect(() => {
    // Detach on fine pointers (260814-ldbs — the bar never renders there, so
    // its capture-phase interceptor must not either) and while the compose
    // textarea owns focus on a coarse pointer (260814-ink6): the render-time
    // `return null` below hides the bar's UI but does NOT unmount this
    // component or tear down its effects, so this interceptor self-gates on
    // the same predicate — an armed modifier must never eat keystrokes typed
    // into the compose textarea (or intercepted on a desktop that shows no
    // modifier chips at all).
    if (!coarse || composeFocused) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (!mods.isArmed()) return;
      if (["Control", "Alt", "Meta", "Shift", "CapsLock"].includes(e.key)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const snapshot = mods.consume();
      const key = e.key;
      let seq = "";

      if (snapshot.ctrl && key.length === 1 && /[a-zA-Z]/.test(key)) {
        const ctrlChar = String.fromCharCode(key.toUpperCase().charCodeAt(0) - 64);
        seq = (snapshot.alt ? "\x1b" : "") + ctrlChar;
      } else if (snapshot.ctrl && key.length === 1) {
        const c = key.charCodeAt(0);
        if (c >= 0x40 && c <= 0x7f) {
          seq = (snapshot.alt ? "\x1b" : "") + String.fromCharCode(c & 0x1f);
        } else {
          seq = (snapshot.alt ? "\x1b" : "") + key;
        }
      } else if (snapshot.alt) {
        seq = "\x1b" + key;
      }

      if (seq) {
        e.preventDefault();
        e.stopPropagation();
        if (wsRef?.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(seq);
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => document.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [mods, wsRef, coarse, composeFocused]);

  const [termFocused, setTermFocused] = useState(false);

  useEffect(() => {
    // Coarse-only, for the same reason the capture-phase interceptor above is
    // (260814-ldbs): `termFocused` drives only the coarse-gated ⌨/🔒 chip, so
    // on a fine pointer these document listeners would attach — and re-render
    // this component on every terminal focus change — to feed a chip that
    // never renders. The render-time `return null` below does NOT unmount the
    // component or its effects, so the gate has to live here.
    if (!coarse) return;
    function onFocusIn(e: FocusEvent) {
      if (e.target instanceof HTMLElement && e.target.closest(".xterm")) {
        setTermFocused(true);
      }
    }
    function onFocusOut(e: FocusEvent) {
      if (e.target instanceof HTMLElement && e.target.closest(".xterm")) {
        setTermFocused(false);
      }
    }
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [coarse]);

  // Long-press detection state for keyboard toggle button
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTouchStartRef = useRef<{ x: number; y: number } | null>(null);
  const didLongPressRef = useRef(false);

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressTouchStartRef.current = null;
  }, []);

  const handleKbdTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const t = e.touches[0];
      longPressTouchStartRef.current = { x: t.clientX, y: t.clientY };
      didLongPressRef.current = false;
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null;
        didLongPressRef.current = true;
        const next = !scrollLocked;
        // Auto-dismiss keyboard before locking, but only if focus is within the terminal
        const activeEl = document.activeElement;
        if (next && activeEl instanceof HTMLElement && activeEl.closest(".xterm")) {
          activeEl.blur();
        }
        setScrollLocked(next);
        navigator.vibrate?.(50);
      }, LONG_PRESS_MS);
    },
    [scrollLocked, setScrollLocked],
  );

  const handleKbdTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!longPressTouchStartRef.current) return;
      const t = e.touches[0];
      const dx = t.clientX - longPressTouchStartRef.current.x;
      const dy = t.clientY - longPressTouchStartRef.current.y;
      if (Math.sqrt(dx * dx + dy * dy) > LONG_PRESS_MOVE_THRESHOLD) {
        cancelLongPress();
      }
    },
    [cancelLongPress],
  );

  const handleKbdTouchEnd = useCallback(() => {
    cancelLongPress();
  }, [cancelLongPress]);

  // Summon the keyboard: when the compose strip is on, focus the strip's
  // textarea (its real DOM input is the IME surface xterm's canvas lacks; the
  // strip disables autocorrect) via the strip's module-level focus registry —
  // NOT a test-id DOM query (test ids are test-only in this repo). Falls back
  // to the terminal if the strip is off, unmounted, or declines (its "no
  // target" disabled state).
  const focusInput = useCallback(() => {
    if (composeStripEnabled && focusComposeStrip()) return;
    onFocusTerminal?.();
  }, [composeStripEnabled, onFocusTerminal]);

  const handleKbdClick = useCallback(() => {
    if (didLongPressRef.current) {
      didLongPressRef.current = false;
      return;
    }
    if (scrollLocked) {
      // Tap in locked mode: unlock ONLY — never summon the keyboard. The tap
      // usually means "stop being locked", not "type now"; summoning here put
      // the keyboard up for users trying to reinforce the lock. The next tap
      // of the now-⌨ chip shows the keyboard as usual.
      setScrollLocked(false);
      return;
    }
    if (termFocused && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    } else {
      focusInput();
    }
  }, [scrollLocked, termFocused, setScrollLocked, focusInput]);

  const send = useCallback(
    (data: string) => {
      if (wsRef?.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(data);
      }
    },
    [wsRef],
  );

  const sendWithMods = useCallback(
    (plain: string, modified: (p: number) => string) => {
      const snapshot = mods.consume();
      send(hasModifiers(snapshot) ? modified(modParam(snapshot)) : plain);
    },
    [mods, send],
  );

  const sendArrow = useCallback(
    (code: string) => {
      sendWithMods(`\x1b[${code}`, (p) => `\x1b[1;${p}${code}`);
    },
    [sendWithMods],
  );

  const sendSpecial = useCallback(
    (char: string) => {
      const snapshot = mods.consume();
      const prefix = snapshot.alt ? "\x1b" : "";
      if (snapshot.ctrl) mods.arm("ctrl");
      send(prefix + char);
    },
    [mods, send],
  );

  // Pointer gate (260814-ldbs): on FINE pointers the bar does not exist — its
  // key chips (Tab/Ctrl/F▴) are key-SIMULATION affordances for
  // keyboardless devices, and a desktop has a hardware keyboard. The gate is
  // the shared coarse-pointer seam (`useCoarsePointer` — pointer TYPE,
  // deliberately not viewport width: an iPad at desktop width keeps its bar,
  // the iPad seam). Coarse = the mobile experience everywhere (`useIsMobile`
  // is width-OR-coarse): a coarse desktop-width device gets the mobile grid,
  // this bar, and NO status bar — the status bar exists only where the
  // desktop grids exist (`!isMobile`).
  //
  // Hide while the compose strip's textarea owns focus on a coarse pointer
  // (260814-ink6): the bar's keys send to the terminal and are dead weight
  // mid-compose — the strip has its own input. Returning null hides the UI
  // (unmounting the chip subtree) but NOT this component's own effects — the
  // armed-modifier capture-phase keydown effect above therefore self-gates
  // on the same predicate so it cannot intercept keystrokes typed into the
  // compose textarea. Blur — or the strip unmounting — restores the bar.
  if (!coarse || composeFocused) return null;

  return (
    // The bar's frame (3px seam + min-48px content-growing row) lives HERE,
    // not at the footer call sites, so the coarse compose-focus early-return
    // above removes the reserved height too — a caller-side wrapper would keep
    // a 48px hole below the compose strip while the bar is hidden (260814).
    // min-h, never a fixed h: the row below is taller than 48px on coarse
    // pointers (36px chips + the raised safe floor = 58px), and a fixed frame
    // clips that floor against the app-shell's overflow:hidden — the chips end
    // up ~3px from the physical screen edge, under the iPhone corner arc.
    // TipGroup: the chip row is one warm-tip cluster (260723-fm08). Living
    // inside BottomBar itself, it covers BOTH render sites (app shell and the
    // board twin) with a single provider. Tips go only on the symbol-glyph
    // chips (tier-1 names controls lacking visible names) — the F▴ menu's
    // entries (the ⌥ latch row, arrow keypad, and key rows) show text labels
    // or sit in a labelled group, and the coarse-only ⌨/🔒 chip could never
    // render a tip (Tip self-suppresses under pointer: coarse).
    <div className="border-t-[3px] border-border px-1.5 min-h-[48px]">
    <TipGroup>
    {/* pb = --bottom-bar-pad, owned by globals.css: max(--bottom-bar-floor,
        env(safe-area-inset-bottom)) while the keyboard is collapsed, floor-only
        under html.kb-open. The whole expression lives there — not inline here —
        so the keyboard gate covers the env() arm too: in standalone PWA mode
        env() keeps reporting the 34pt home-indicator inset while the keyboard
        covers that zone, and an inline max() would hold the full pad above the
        keyboard. The keyboard-open signal is explicit JS — useVisualViewport
        toggles html.kb-open (do NOT rely on env() or
        interactive-widget=resizes-content collapsing on iOS).
        (260805-fi9m, 260816-4v2o) */}
    <div className="flex items-center gap-1.5 coarse:gap-1 pt-1.5 pb-[var(--bottom-bar-pad,0.375rem)] flex-wrap" role="toolbar" aria-label="Terminal keys">
      <Tip label="Tab" placement="top">
        <button aria-label="Tab" className={controlClass({ variant: "chip", className: "text-text-secondary" })} onMouseDown={preventFocusSteal} onClick={() => sendSpecial("\t")}>
          <kbd aria-hidden="true">{"\u21E5"}</kbd>
        </button>
      </Tip>

      <Tip label={MODIFIER_TIP_LABELS.ctrl} placement="top">
        <button
          aria-label={MODIFIER_LABELS.ctrl}
          aria-pressed={mods.ctrl}
          className={controlClass({ variant: "chip", pressed: mods.ctrl, className: mods.ctrl ? undefined : "text-text-secondary" })}
          onMouseDown={preventFocusSteal}
          onClick={() => mods.toggle("ctrl")}
        >
          <kbd aria-hidden="true">^</kbd>
        </button>
      </Tip>

      <div ref={fnRef} className="relative">
        <Tip label="Function keys" placement="top">
          {/* Open-menu latch: while the menu is up the trigger carries the
              latch arm (state, not hover) \u2014 the chip's rest arm is
              swapped out so no hover utility competes with the latch. */}
          <button
            aria-label="Function keys"
            aria-haspopup="true"
            aria-expanded={fnOpen}
            className={controlClass({ variant: "chip", pressed: fnOpen, className: fnOpen ? undefined : "text-text-secondary" })}
            onMouseDown={preventFocusSteal}
            onClick={() => setFnOpen((v) => !v)}
          >
            <kbd aria-hidden="true">F&#x25B4;</kbd>
          </button>
        </Tip>
        {fnOpen && (
          <div
            role="menu"
            aria-label="Function and navigation keys"
            // Height budget: the menu opens upward from a bar that sits just
            // above the software keyboard, so the room it has is the VISUAL
            // viewport (--app-height, keyboard-aware via useVisualViewport —
            // 100vh lies on iOS while the keyboard is up) minus the top bar +
            // this bar (~130px). Without the cap the app-shell's
            // overflow:hidden silently clips the menu's TOP rows (the ⌥ latch
            // was unreachable on phones); overflow-y-auto is the backstop for
            // viewports smaller than the compact grid.
            className={`absolute bottom-full left-0 mb-1 ${POPOVER_SHELL} min-w-[176px] max-h-[calc(var(--app-height,100vh)-130px)] overflow-y-auto`}
          >
            {/* \u2325 latch + arrow keypad share one row \u2014 the menu opens above a
                bar that sits on top of the software keyboard, so vertical
                space is the scarce axis (a stacked \u2325 row pushed the menu past
                the visual viewport and the app-shell clipped its top rows).
                \u2325 is a glyph cell like the bar's ^ chip (same one-shot latch
                semantics, green state arm); both it and the arrows
                send-and-stay \u2014 closing per press would make a latch-then-
                arrow sequence or repeated TUI navigation useless. */}
            <div className="flex items-center justify-center gap-0.5 px-1">
              <button
                role="menuitemcheckbox"
                aria-checked={mods.alt}
                aria-label={MODIFIER_LABELS.alt}
                className={controlClass({ variant: "chip", ringed: true, pressed: mods.alt })}
                onMouseDown={preventFocusSteal}
                onClick={() => mods.toggle("alt")}
              >
                <kbd aria-hidden="true">{"\u2325"}</kbd>
              </button>
              <div className="w-px h-6 bg-border mx-1" aria-hidden="true" />
              <div className="flex gap-0.5" role="group" aria-label="Arrow keys">
                {([["Up arrow", "A", "\u2191"], ["Left arrow", "D", "\u2190"], ["Down arrow", "B", "\u2193"], ["Right arrow", "C", "\u2192"]] as const).map(([label, code, glyph]) => (
                  <button
                    key={code}
                    aria-label={label}
                    className={controlClass({ variant: "chip", ringed: true })}
                    onMouseDown={preventFocusSteal}
                    onClick={() => sendArrow(code)}
                  >
                    {glyph}
                  </button>
                ))}
              </div>
            </div>
            <div className="border-t border-border my-1" />
            <div className="grid grid-cols-4 gap-0.5">
              {FN_KEYS.map((fk) => (
                <button
                  key={fk.label}
                  role="menuitem"
                  aria-label={fk.label}
                  className={controlClass({ variant: "chip", ringed: true })}
                  onMouseDown={preventFocusSteal}
                  onClick={() => { sendWithMods(fk.plain, fk.mod); setFnOpen(false); }}
                >
                  {fk.label}
                </button>
              ))}
            </div>
            <div className="border-t border-border my-1" />
            <div className="grid grid-cols-4 gap-0.5">
              <button
                role="menuitem"
                aria-label="Escape"
                className={controlClass({ variant: "chip", ringed: true })}
                onMouseDown={preventFocusSteal}
                onClick={() => { sendSpecial("\x1b"); setFnOpen(false); }}
              >
                Esc
              </button>
              {EXT_KEYS.map((ek) => (
                <button
                  key={ek.label}
                  role="menuitem"
                  aria-label={ek.label}
                  className={controlClass({ variant: "chip", ringed: true })}
                  onMouseDown={preventFocusSteal}
                  onClick={() => { sendWithMods(ek.plain, ek.mod); setFnOpen(false); }}
                >
                  {ek.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="w-px h-5 bg-border mx-0.5" aria-hidden="true" />

      {/* kbd slot: the registry-resolved command-palette chord (⌘K on mac,
          Ctrl+K elsewhere) — reflects rebinds; omitted when disabled
          (260801-mqim). The chip's FACE keeps the ⌘K brand glyph everywhere.
          Order (260811-0f3d): palette FIRST, compose LAST — compose is the
          higher-touch control and takes the end-of-run position. */}
      <Tip label="Command palette" kbd={paletteChord} placement="top">
        <button
          aria-label="Open command palette"
          className={controlClass({ variant: "chip", className: "text-text-secondary" })}
          onClick={() => document.dispatchEvent(new CustomEvent("palette:open"))}
        >
          <kbd aria-hidden="true">{"\u2318K"}</kbd>
        </button>
      </Tip>
      {onOpenCompose && (
        <Tip label="Compose" kbd={composeChord} placement="top">
          <button
            type="button"
            onMouseDown={preventFocusSteal}
            onClick={onOpenCompose}
            aria-label="Compose"
            aria-pressed={composeStripEnabled}
            className={controlClass({ variant: "chip", pressed: composeStripEnabled, className: composeStripEnabled ? undefined : "text-text-secondary" })}
          >
            a<span className={composeStripEnabled ? "rk-compose-caret" : undefined}>{"▏"}</span>
          </button>
        </Tip>
      )}
      {/* The compose education hint (260811-0f3d) was FINE-pointer-only — with
          the bar itself now pointer-gated to coarse (260814-ldbs) it could
          never render, so it was removed; the hint's educate-toward role moved
          to the status bar's `a` compose segment. */}

      <div className="ml-auto flex items-center gap-1.5 coarse:gap-1">
        {/* Keyboard toggle — visible only on touch devices; long-press for scroll-lock */}
        <button
          type="button"
          aria-label={scrollLocked ? "Scroll lock on \u2014 tap to unlock" : termFocused ? "Hide keyboard" : "Show keyboard"}
          aria-pressed={scrollLocked || termFocused}
          className={controlClass({ variant: "chip", pressed: scrollLocked, className: scrollLocked ? "hidden coarse:inline-flex" : "hidden coarse:inline-flex text-text-secondary" })}
          onMouseDown={preventFocusSteal}
          onTouchStart={handleKbdTouchStart}
          onTouchMove={handleKbdTouchMove}
          onTouchEnd={handleKbdTouchEnd}
          onClick={handleKbdClick}
        >
          <kbd aria-hidden="true">{scrollLocked ? "\uD83D\uDD12" : "\u2328"}</kbd>
        </button>
      </div>
    </div>
    </TipGroup>
    </div>
  );
}
