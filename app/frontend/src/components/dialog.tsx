import { useRef, useId } from "react";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useOccludes } from "@/hooks/use-occludes";

type DialogProps = {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Width variant (260724-6j1v): `sm` (default) keeps the phone-card
   *  `max-w-sm` every existing dialog uses; `lg` is the desktop preference-pane
   *  width (`max-w-2xl`, ≈672px). `xl` (`max-w-4xl`) additionally pins a FIXED
   *  panel height with `overflow-hidden` — the tabbed settings dialog's
   *  variant, so a tab rail never jumps between short and tall panels (each
   *  tab panel owns its own internal scroll instead). `sheet` is the New
   *  sheet's variant: ≈520px centered from `sm` up, a full-width bottom sheet
   *  below it. */
  size?: "sm" | "lg" | "xl" | "sheet";
};

export function Dialog({ title, onClose, children, size = "sm" }: DialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  // Dialog only mounts while open, so the trap is unconditionally active.
  // The hook owns focus-first-on-mount, Escape → onClose, and Tab wrap.
  useFocusTrap(dialogRef, true, onClose);
  // One registration here covers every consumer that renders through the
  // primitive (a bespoke modal that does not must register itself).
  useOccludes("modal", true);

  // max-h + overflow-y keep tall dialogs (the lg settings pane) scrollable
  // inside short viewports instead of clipping off-screen; the calc offset
  // matches the container's p-4 so the panel never touches the edges. xl
  // inverts that: a fixed height with the scroll pushed into the tab panels.
  const sizing =
    size === "xl"
      ? "max-w-4xl h-[min(40rem,calc(100vh-2rem))] overflow-hidden flex flex-col"
      : size === "sheet"
        ? "max-w-none sm:max-w-[520px] max-h-[calc(100vh-2rem)] overflow-y-auto rounded-b-none sm:rounded-b-lg"
        : `${size === "lg" ? "max-w-2xl" : "max-w-sm"} max-h-[calc(100vh-2rem)] overflow-y-auto`;
  // The sheet hugs the bottom edge below `sm` (no side/bottom gutter); every
  // other size keeps the centered p-4 gutter.
  const placement = size === "sheet" ? "items-end p-0 sm:items-center sm:p-4" : "items-center p-4";

  return (
    <div
      className={`fixed inset-0 z-40 flex justify-center ${placement}`}
      onClick={onClose}
    >
      <div className="fixed inset-0 bg-black/50" aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`relative bg-bg-primary border border-border rounded-lg p-3 w-full ${sizing} shadow-2xl text-[11px]`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="text-xs font-medium mb-2.5">{title}</h2>
        {children}
      </div>
    </div>
  );
}
