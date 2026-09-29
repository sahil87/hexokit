import { useEffect, useRef, useState } from "react";
import { openInApp } from "@/api/client";
import { OpenTargetIcon } from "@/components/open-app-icons";
import { useToast } from "@/components/toast";
import { controlClass } from "@/components/control";
import {
  POPOVER_SECTION_LABEL,
  POPOVER_SHELL,
} from "@/components/controls";
import {
  readLastUsedOpenTarget,
  resolveLastUsedTarget,
  writeLastUsedOpenTarget,
  type OpenTarget,
} from "@/lib/open-in-app";
import { Tip } from "@/components/tip";
import { useKeybindings } from "@/hooks/use-keybindings";
import { useOccludes } from "@/hooks/use-occludes";
import { formatCombo } from "@/lib/keybindings";

/**
 * OpenButton — the Conductor-style "Open in app" split-button for the top-bar
 * right cluster (260722-6d0f), Terminal route only. Presentational by
 * contract: it takes the prebuilt target list (from `buildOpenTargets` — the
 * local/remote branch and section-visibility rules live in
 * `lib/open-in-app.ts`) plus the launch coordinates, and owns only the
 * split-button interaction:
 *
 *  - PRIMARY segment: re-runs the last-used target (localStorage
 *    `hexokit-open-last-used`) and leads with that target's glyph (260723-l317
 *    — `aria-hidden` decoration next to the kept "Open" text, so the segment
 *    shows WHICH app a primary click launches); with no stored — or no longer
 *    available — preference it opens the menu instead and carries no glyph.
 *  - CHEVRON segment: always opens the full menu.
 *  - Deeplink targets navigate via a plain `window.location.href` user-gesture
 *    assignment — the browser shows its own "Open <app>?" confirm; a dead
 *    scheme no-ops. Host targets POST /api/open (toast on failure).
 *
 * On a REMOTE client the menu labels the server-exec entries under an
 * "on host" section header (the escape hatch stays clearly host-side); local
 * clients see a flat list (server exec is the only mechanism there).
 *
 * The caller hides the whole control when `targets` is empty (zero sections
 * ⇒ nothing to open with) — mirroring how the ViewSwitcher entry hides on
 * single-view windows.
 */
export function OpenButton({
  targets,
  server,
  path,
}: {
  targets: OpenTarget[];
  server: string;
  path: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { runTarget } = useRunOpenTarget(server, path);

  // Outside-click + Escape close (the BreadcrumbDropdown popover pattern).
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey, { capture: true });
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey, { capture: true });
    };
  }, [open]);

  // Menus register `transient` (overlay-presence): while open, a native guest
  // composited above the DOM hides so the menu never paints underneath it.
  useOccludes("transient", open);

  if (targets.length === 0) return null;

  const lastUsed = resolveLastUsedTarget(targets, readLastUsedOpenTarget());

  const run = (target: OpenTarget) => {
    setOpen(false);
    runTarget(target);
  };

  const handlePrimary = () => {
    if (lastUsed) {
      run(lastUsed);
    } else {
      setOpen((v) => !v);
    }
  };

  const primaryLabel = lastUsed ? `Open in ${lastUsed.label}` : "Open in app";
  // Effective `open-last-used` chord (default ⇧O) for the primary tip's kbd
  // slot (260811-ke2s) — derived from the registry, never hardcoded, and
  // omitted when the binding is unbound/disabled (a tip advertising a dead
  // chord would lie).
  const { byAction: keybindingsByAction, host: keybindingHost } = useKeybindings();
  const openLastUsedBinding = keybindingsByAction.get("open-last-used");
  const openLastUsedChord = openLastUsedBinding?.enabled
    ? formatCombo({ code: openLastUsedBinding.code, tier: openLastUsedBinding.tier }, keybindingHost.platform)
    : undefined;
  const deeplinks = targets.filter((t) => t.kind === "deeplink");
  const hostTargets = targets.filter((t) => t.kind === "host");
  // The "on host" section header renders only when the menu carries BOTH
  // sections — i.e. a remote client with deeplinks — so the escape hatch is
  // clearly labeled; a flat single-mechanism list needs no header.
  const showHostHeader = deeplinks.length > 0 && hostTargets.length > 0;

  return (
    <div ref={containerRef} className="relative inline-flex items-center">
      {/* Split button: primary + chevron share one bordered chip (the
          ViewSwitcher segment-group treatment) so the pair reads as ONE
          control at cluster scale. */}
      <span className="inline-flex items-stretch rounded border border-border overflow-hidden">
        <Tip label={primaryLabel} kbd={openLastUsedChord}>
          <button
            ref={triggerRef}
            type="button"
            onClick={handlePrimary}
            aria-label={primaryLabel}
            className={`rk-glint px-1.5 text-[11px] font-mono flex items-center justify-center gap-1 transition-colors ${controlClass({ variant: "segment", rest: "text-text-secondary hover:text-text-primary" })}`}
          >
            {/* Last-used glyph (260723-l317): `currentColor` decoration —
                rides the segment's secondary→primary hover flip and stays
                out of the accessible name. Absent when no last-used target
                resolves (the primary click opens the menu then). */}
            {lastUsed && <OpenTargetIcon target={lastUsed} />}
            Open
          </button>
        </Tip>
        {/* Tip suppressed while the menu is open (trigger convention). */}
        <Tip label={open ? undefined : "Open in… (choose app)"}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Open in… (choose app)"
          className={`rk-glint px-1 border-l flex items-center justify-center transition-colors ${controlClass({ variant: "segment", open })}`}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="2,3.5 5,6.5 8,3.5" />
          </svg>
        </button>
        </Tip>
      </span>
      {open && (
        <div
          role="menu"
          aria-label="Open in app"
          className={`absolute top-full right-0 mt-1 min-w-[160px] ${POPOVER_SHELL}`}
        >
          {deeplinks.map((t) => (
            <OpenTargetRow key={t.id} target={t} onRun={run} />
          ))}
          {showHostHeader && (
            <div
              aria-hidden="true"
              className={POPOVER_SECTION_LABEL}
            >
              on host
            </div>
          )}
          {hostTargets.map((t) => (
            <OpenTargetRow key={t.id} target={t} onRun={run} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One target row in the split-button's own dropdown menu. The leading glyph
 *  (260722-fc3b) is `currentColor` decoration — it rides the row's
 *  secondary→primary hover flip and stays out of the accessible name. */
function OpenTargetRow({
  target,
  onRun,
}: {
  target: OpenTarget;
  onRun: (target: OpenTarget) => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => onRun(target)}
      className={controlClass({ variant: "menu-row" })}
    >
      <OpenTargetIcon target={target} />
      {target.label}
    </button>
  );
}

/**
 * OpenMenuRows — the overflow-menu representation of the Open control
 * (the ViewSwitcherMenuRows precedent): when the `open` registry entry
 * collapses into the top-bar "More controls" chevron menu, each target
 * renders as one `Open: <label>` menuitem row (host targets suffixed
 * `(on host)` when the menu also carries deeplink rows — the collapsed
 * equivalent of the popover's "on host" section header). `tabIndex={-1}`
 * per the menu's roving-focus model.
 */
export function OpenMenuRows({
  targets,
  server,
  path,
}: {
  targets: OpenTarget[];
  server: string;
  path: string;
}) {
  const { runTarget } = useRunOpenTarget(server, path);
  if (targets.length === 0) return null;
  const hasBothKinds =
    targets.some((t) => t.kind === "deeplink") && targets.some((t) => t.kind === "host");
  return (
    <>
      {targets.map((t) => (
        <button
          key={t.id}
          type="button"
          role="menuitem"
          tabIndex={-1}
          onClick={() => runTarget(t)}
          className={controlClass({ variant: "menu-row" })}
        >
          <OpenTargetIcon target={t} />
          {t.kind === "host" && hasBothKinds ? `Open: ${t.label} (on host)` : `Open: ${t.label}`}
        </button>
      ))}
    </>
  );
}

/**
 * Shared run-a-target behavior for the split-button, its overflow rows, and
 * the palette wiring: persist the last-used preference, then either navigate
 * (deeplink — the browser handles the confirm; a dead scheme no-ops) or POST
 * /api/open (host — toast on failure, matching the Split/Close error
 * vocabulary).
 */
export function useRunOpenTarget(server: string, path: string) {
  const { addToast } = useToast();
  const runTarget = (target: OpenTarget) => {
    writeLastUsedOpenTarget(target.id);
    if (target.kind === "deeplink") {
      window.location.href = target.url;
      return;
    }
    openInApp(server, path, target.appId).catch((err: Error) => {
      addToast(err.message || `Failed to open in ${target.label}`);
    });
  };
  return { runTarget };
}
