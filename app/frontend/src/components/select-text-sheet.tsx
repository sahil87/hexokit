import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useOccludes } from "@/hooks/use-occludes";
import { controlClass } from "@/components/control";

/** Monospace advance per em of the app's mono stack (MonaspiceNe measures
 *  0.62; the generic fallbacks are ~0.6, so they only fit more loosely). */
const MONO_CHAR_EM = 0.62;

/**
 * The mobile select-text sheet: the window's scrollback (or screen) as plain
 * text that native selection can work on. Touch devices cannot select inside
 * the terminal (swipes scroll tmux and the long-press is suppressed).
 *
 * A bottom-anchored sheet (the CronEntryDetailSheet shell), portaled to
 * `document.body` — SurfaceLayout sits in a stacking context below the top
 * bar and the key bar, so an in-tree modal's backdrop leaves both undimmed and
 * clickable.
 *
 * The text wraps, so a phone never scrolls sideways, and the font is sized so
 * `cols` columns fill the sheet width (`cqw` of the sheet; `1rem` is the pre's
 * padding; one spare column absorbs sub-pixel rounding) — TUIs (Claude Code)
 * break their own lines at the terminal width, so a smaller column count here
 * would break every long row a second time. Clamped to stay readable; a wider
 * row still wraps.
 */
export function SelectTextSheet({
  text,
  cols,
  ready,
  onTouchText,
  onCopyAll,
  onClose,
}: {
  text: string;
  cols: number;
  /** false while the screen is still the keyboard-squeezed frame — the text
   *  area shows a loading line instead, so the cropped text never flashes. */
  ready: boolean;
  /** First touch on the text — the caller stops live updates so a selection
   *  never shifts under the finger. */
  onTouchText: () => void;
  onCopyAll: () => void;
  onClose: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  useFocusTrap(sheetRef, true, onClose);
  useOccludes("modal", true);

  // Keep the bottom in view — the end of the history is what was on screen,
  // and a live screen re-render must not jump back to the top.
  const preRef = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const pre = preRef.current;
    if (pre) pre.scrollTop = pre.scrollHeight;
  }, [text, ready]);

  return createPortal(
    <div className="fixed inset-0 z-40" data-testid="select-text-sheet">
      <div className="fixed inset-0 bg-black/50" aria-hidden="true" onClick={onClose} />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Select text"
        className="absolute bottom-0 left-0 right-0 flex flex-col [container-type:inline-size] h-[85dvh] rounded-t-lg border border-b-0 border-border bg-bg-primary p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-[11px] shadow-2xl"
      >
        <h2 className="text-xs font-medium mb-1">Select text</h2>
        <p className="text-text-secondary mb-2.5">Long-press to select, or copy everything.</p>
        <pre
          ref={preRef}
          data-testid="select-text"
          aria-busy={!ready}
          onPointerDown={onTouchText}
          className="flex-1 min-h-0 overflow-auto select-text whitespace-pre-wrap break-words font-mono leading-snug bg-bg-inset rounded p-2"
          style={{
            fontSize: `clamp(9px, calc((100cqw - 1rem) / ${(cols + 1) * MONO_CHAR_EM}), 13px)`,
          }}
        >
          {ready ? text : <span className="text-text-secondary">Loading…</span>}
        </pre>
        <div className="flex gap-2 pt-2.5">
          <button
            type="button"
            className={`flex-1 ${controlClass({ variant: "confirm" })}`}
            disabled={!ready}
            onClick={onCopyAll}
          >
            Copy all
          </button>
          <button
            type="button"
            className={`flex-1 ${controlClass({ variant: "confirm" })}`}
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
