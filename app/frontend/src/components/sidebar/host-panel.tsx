import { useState, useRef, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { CollapsiblePanel } from "./collapsible-panel";
import { PaletteIcon } from "./icons";
import { HostMetrics } from "../host-metrics";
import { SwatchPopover } from "@/components/swatch-popover";
import { useHostMetrics, useMetrics } from "@/contexts/session-context";
import { useInstanceAccent } from "@/contexts/instance-accent-context";
import { useInstanceName } from "@/contexts/instance-name-context";

export function HostPanel() {
  // Server-scoped metrics win when present; fall back to the host-global
  // metrics broadcast (available on EVERY route) when they are null — the
  // board route has no `currentServer`, so the server-scoped slice is null by
  // construction there (260720-zx4i). The two arrive on the same tick when a
  // server is attached, so the fallback is harmless on server routes too.
  const serverMetrics = useMetrics();
  const hostMetrics = useHostMetrics();
  const metrics = serverMetrics ?? hostMetrics;

  // Instance accent (1etw): the hostname carries the instance's accent color
  // and the header hosts the accent picker — the HOST panel is the "which
  // run-kit instance is this" surface (server colors own the sidebar rows).
  const { color, isExplicit, stripeHex, setColor } = useInstanceAccent();

  // Instance display name (o7q8): the header line prefers the settings
  // override over the metrics-reported hostname. The accent hash + SSH
  // deeplinks deliberately keep the REAL hostname — this is display-only.
  const { instanceName } = useInstanceName();
  const [showColorPicker, setShowColorPicker] = useState(false);
  const paletteBtnRef = useRef<HTMLButtonElement>(null);
  const [popoverPos, setPopoverPos] = useState<{ top?: number; bottom?: number; left: number } | null>(null);
  // Portal the popover to document.body at fixed coordinates anchored at the
  // palette button (left-aligned since the button now sits beside the title,
  // flip-above heuristic) so it escapes the panel's overflow clip — the x4sf
  // ServerGroup-header precedent. The HOST panel sits at the sidebar's bottom,
  // so the flip-above branch is the norm.
  useLayoutEffect(() => {
    if (!showColorPicker || !paletteBtnRef.current) {
      setPopoverPos(null);
      return;
    }
    const rect = paletteBtnRef.current.getBoundingClientRect();
    const approxPopoverHeight = 110; // color-only grid — used ONLY to pick the branch
    const approxPopoverWidth = 170; // 4 swatch columns + padding
    const below = rect.bottom + 4;
    const fitsBelow = below + approxPopoverHeight <= window.innerHeight;
    const left = Math.max(4, Math.min(rect.left, window.innerWidth - approxPopoverWidth - 4));
    // Below-placement anchors the popover's top under the button (exact).
    // Flip-above anchors its BOTTOM edge just over the button via CSS `bottom`,
    // so the placement is exact regardless of the popover's real height — an
    // estimated `top` would leave a gap whenever the estimate overshoots.
    setPopoverPos(
      fitsBelow
        ? { top: below, left }
        : { bottom: window.innerHeight - rect.top + 4, left },
    );
  }, [showColorPicker]);

  // No connection dot here: the top-bar dot already reflects the same
  // current-server subscription health (session-context wires
  // `setChromeConnected(slice.isConnected)`), and the old "SSE" wording
  // predated the /ws/state socket.
  const hostnameHeader = metrics ? (
    <span
      className={`truncate font-mono ${stripeHex ? "" : "text-text-primary"}`}
      style={stripeHex ? { color: stripeHex } : undefined}
    >
      {instanceName ?? metrics.hostname}
    </span>
  ) : null;

  // Sibling of the header toggle button (the `titleAction` slot, right of the
  // HOST title) — a button nested inside the toggle would be invalid markup.
  // The button-level spelling of the one hover-reveal contract (the
  // status-panel PR-copy cluster is the reference): there is no grouping
  // container of its own in this slot, so the button itself gates
  // reachability — inert at rest on fine pointers (pointer-events-none),
  // restored on panel hover, keyboard focus, and always on coarse; opacity
  // mirrors it. Floored at 24px fine / 40px coarse (the tappable minimums);
  // the negative margins keep the floor layout-neutral — the hit box overhangs
  // the header row instead of stretching it past the text-driven height.
  const paletteAction = (
    <>
      <button
        ref={paletteBtnRef}
        type="button"
        onClick={() => setShowColorPicker((v) => !v)}
        aria-label="Set instance color"
        className="opacity-0 group-hover/panel:opacity-100 coarse:opacity-100 focus-visible:opacity-100 pointer-events-none group-hover/panel:pointer-events-auto coarse:pointer-events-auto focus-visible:pointer-events-auto transition-opacity px-1 min-w-[24px] min-h-[24px] coarse:min-w-[40px] coarse:min-h-[40px] -my-1 coarse:-my-3 flex items-center justify-center hover:text-text-primary"
      >
        <PaletteIcon />
      </button>
      {showColorPicker && popoverPos && createPortal(
        <div
          style={{
            position: "fixed",
            top: popoverPos.top,
            bottom: popoverPos.bottom,
            left: popoverPos.left,
            zIndex: 100,
          }}
        >
          <SwatchPopover
            selectedColor={isExplicit && color != null ? color : undefined}
            // Selection does NOT close (the picker's dismissal contract).
            onSelect={(c) => setColor(c)}
            onClose={() => setShowColorPicker(false)}
          />
        </div>,
        document.body,
      )}
    </>
  );

  return (
    <CollapsiblePanel
      title="Host"
      storageKey="hexokit-panel-host"
      defaultOpen={true}
      headerRight={hostnameHeader}
      titleAction={paletteAction}
    >
      {!metrics ? (
        <div className="text-xs text-text-secondary">No metrics</div>
      ) : (
        <HostMetrics metrics={metrics} />
      )}
    </CollapsiblePanel>
  );
}
