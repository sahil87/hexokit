import {
  FloatingFocusManager,
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  size,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from "@floating-ui/react";
import { useOccludes } from "@/hooks/use-occludes";

/**
 * Sent-history is portalled with fixed positioning so the bottom-docked card
 * cannot widen the page on narrow viewports. Rows only load drafts; sending
 * remains an explicit action in the compose strip.
 */
export function ComposeHistoryFlyout({
  anchor,
  entries,
  onSelect,
  onClose,
}: {
  anchor: HTMLElement | null;
  entries: readonly string[];
  onSelect: (entry: string) => void;
  onClose: () => void;
}) {
  // Mounts only while open, so the registration is unconditional — popovers
  // hold `transient` (overlay-presence) so a native guest composited above
  // the DOM hides and the flyout never paints underneath it.
  useOccludes("transient", true);
  const { refs, floatingStyles, context } = useFloating({
    open: true,
    onOpenChange: (open) => {
      if (!open) onClose();
    },
    elements: { reference: anchor },
    placement: "top-start",
    strategy: "fixed",
    middleware: [
      offset(6),
      flip({ fallbackPlacements: ["bottom-start"] }),
      shift({ padding: 8 }),
      size({
        apply({ availableWidth, availableHeight, elements }) {
          elements.floating.style.maxWidth = `${Math.max(availableWidth, 0)}px`;
          elements.floating.style.maxHeight = `${Math.max(availableHeight, 0)}px`;
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "dialog" });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  return (
    <FloatingPortal>
      <FloatingFocusManager
        context={context}
        modal={false}
        initialFocus={-1}
        returnFocus={false}
        order={["reference", "content"]}
      >
        <div
          ref={refs.setFloating}
          style={floatingStyles}
          {...getFloatingProps()}
          data-testid="compose-history-flyout"
          id="compose-history-list"
          aria-label="Sent text history"
          className="z-50 w-[min(24rem,calc(100vw-1rem))] overflow-y-auto rounded-md border border-border bg-bg-card p-1 rk-popup-elev"
        >
          <ul className="flex flex-col gap-0.5">
            {entries.map((entry, index) => (
              <li key={`${index}:${entry}`}>
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onSelect(entry)}
                  data-testid="compose-history-entry"
                  className="w-full rounded px-2 py-1.5 text-left font-mono text-xs text-text-primary whitespace-pre-wrap line-clamp-2 transition-colors hover:bg-bg-inset focus-visible:bg-bg-inset focus-visible:outline-none coarse:min-h-[36px]"
                >
                  {entry}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </FloatingFocusManager>
    </FloatingPortal>
  );
}
