import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { FabAgentPreset } from "@/api/client";
import { useAgentPresetList } from "@/hooks/use-agent-preset-list";
import { useMachineAgentPresetInfo } from "@/hooks/use-machine-agent-preset-info";
import { useOccludes } from "@/hooks/use-occludes";
import {
  buildAgentPresetChoices,
  loadGroupAgentPresets,
  resolveAgentPreset,
  type AgentPresetChoice,
} from "@/lib/agent-presets";
import { useAnchoredPopoverPos } from "./server-card";

// Must match the container's `w-[min(320px,calc(100vw-8px))]` class.
const CHOOSER_MAX_WIDTH = 320;
const VIEWPORT_MARGIN = 4;

/**
 * The fixed `right` offset that keeps the chooser's left edge on screen. The
 * anchor resolver right-aligns to the anchor, which suits a popover narrower
 * than its anchor; the chooser is wider than a sidebar row, so an anchor near
 * the left viewport edge would push it off screen.
 */
export function fitChooserRight(anchoredRight: number, viewportWidth: number): number {
  const width = Math.min(CHOOSER_MAX_WIDTH, viewportWidth - 2 * VIEWPORT_MARGIN);
  return Math.max(VIEWPORT_MARGIN, Math.min(anchoredRight, viewportWidth - width - VIEWPORT_MARGIN));
}

type AgentPresetChooserProps = {
  kind: "Group" | "Workspace";
  entityName: string;
  own?: string;
  workspace?: string;
  server: string;
  session?: string;
  anchorRef: RefObject<HTMLElement | null>;
  onPick: (value: string | null) => void;
  onClose: () => void;
  maxHeight?: number;
  onHeightChange?: (height: number) => void;
};

const choiceKey = (choice: AgentPresetChoice) => choice.value ?? "\u0000inherit";

export function AgentPresetChooser({
  kind,
  entityName,
  own,
  workspace,
  server,
  session,
  anchorRef,
  onPick,
  onClose,
  maxHeight,
  onHeightChange,
}: AgentPresetChooserProps) {
  useOccludes("transient", true);
  const heldList = useAgentPresetList(server, session);
  const machine = useMachineAgentPresetInfo();
  const [presets, setPresets] = useState<FabAgentPreset[] | undefined>(heldList);
  const [initialListSettled, setInitialListSettled] = useState(heldList !== undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const choiceRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const didInitialFocusRef = useRef(false);
  const hadFocusRef = useRef(false);
  const focusedKeyRef = useRef<string | undefined>(undefined);

  const close = () => {
    const anchor = anchorRef.current;
    const focusTarget = anchor?.matches("button, [tabindex]")
      ? anchor
      : anchor?.querySelector<HTMLElement>("button, [tabindex]");
    focusTarget?.focus({ preventScroll: true });
    onClose();
  };

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element || !onHeightChange) return;
    const measure = () => onHeightChange(element.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [onHeightChange]);

  useEffect(() => {
    if (heldList) {
      setPresets(heldList);
      setInitialListSettled(true);
    }
  }, [heldList]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void loadGroupAgentPresets(server, session).then((list) => {
      if (!cancelled) {
        setPresets(list);
        setInitialListSettled(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [server, session]);

  const inherited = resolveAgentPreset({ workspace, machineDefault: machine?.machineDefault });
  const choices = useMemo(
    () => buildAgentPresetChoices({ presets, own, inherited }),
    [presets, own, inherited.name, inherited.source],
  );
  const checkedIndex = choices.findIndex((choice) => choice.checked);
  const initialIndex = checkedIndex >= 0 ? checkedIndex : 0;
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const choiceSignature = choices.map((choice) => `${choiceKey(choice)}:${choice.checked}`).join("|");

  useEffect(() => {
    if (own && own !== "none" && !initialListSettled) return;
    if (didInitialFocusRef.current) {
      if (!hadFocusRef.current) return;
      const focusedIndex = choices.findIndex((choice) => choiceKey(choice) === focusedKeyRef.current);
      if (focusedIndex >= 0) {
        setActiveIndex(focusedIndex);
        return;
      }
    }
    const next = choices.findIndex((choice) => choice.checked);
    const index = next >= 0 ? next : 0;
    setActiveIndex(index);
    const timer = setTimeout(() => {
      choiceRefs.current[index]?.focus({ preventScroll: true });
      didInitialFocusRef.current = true;
    }, 0);
    return () => clearTimeout(timer);
    // Focus follows the opening choice, and a later list update only replaces
    // focus when its entry disappeared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choiceSignature, initialListSettled]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const handleOutside = (event: MouseEvent) => {
        if (event.target instanceof Node && !containerRef.current?.contains(event.target)) close();
      };
      document.addEventListener("mousedown", handleOutside);
      outsideCleanup = () => document.removeEventListener("mousedown", handleOutside);
    }, 0);
    let outsideCleanup: (() => void) | undefined;
    return () => {
      clearTimeout(timer);
      outsideCleanup?.();
    };
  }, [onClose]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener("keydown", handleEscape, true);
    return () => document.removeEventListener("keydown", handleEscape, true);
  }, [onClose]);

  const pick = (index: number) => {
    const choice = choices[index];
    if (!choice) return;
    onPick(choice.value);
    close();
  };

  return (
    <div
      ref={containerRef}
      className="z-50 w-[min(320px,calc(100vw-8px))] overflow-y-auto border border-border bg-bg-primary text-xs shadow-[3px_3px_0_rgba(0,0,0,.35)]"
      style={{ maxHeight }}
    >
      <div className="border-b border-border px-2 py-1.5 font-medium">
        <span className="text-text-secondary">Agent preset · {kind} </span>
        {entityName}
      </div>
      <div
        role="radiogroup"
        aria-label={`Agent preset for ${entityName}`}
        onKeyDown={(event) => {
          const focusedIndex = choiceRefs.current.findIndex((node) => node === document.activeElement);
          const currentIndex = focusedIndex >= 0 ? focusedIndex : activeIndex;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            event.stopPropagation();
            const delta = event.key === "ArrowDown" ? 1 : choices.length - 1;
            const next = (currentIndex + delta) % choices.length;
            setActiveIndex(next);
            choiceRefs.current[next]?.focus();
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            pick(currentIndex);
          }
        }}
        onBlur={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
            hadFocusRef.current = false;
          }
        }}
        className="divide-y divide-border bg-bg-inset"
      >
        {choices.map((choice, index) => (
          <button
            key={choiceKey(choice)}
            ref={(node) => {
              choiceRefs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={choice.checked}
            tabIndex={index === activeIndex ? 0 : -1}
            onFocus={() => {
              hadFocusRef.current = true;
              focusedKeyRef.current = choiceKey(choice);
              setActiveIndex(index);
            }}
            onClick={() => pick(index)}
            className="grid min-h-[32px] w-full grid-cols-[2ch_minmax(0,1fr)] gap-x-1.5 border-l-2 border-l-transparent px-2 py-1.5 text-left text-text-primary hover:bg-[color-mix(in_srgb,var(--color-text-primary)_8%,transparent)] hover:border-l-accent-green focus:border-l-accent-green focus:outline-none coarse:min-h-[36px]"
          >
            <span aria-hidden="true" className={choice.checked ? "text-accent-green" : "text-text-secondary"}>
              {choice.checked ? "●" : "○"}
            </span>
            <span className="min-w-0 break-words">{choice.label}</span>
            {choice.description && (
              <span className="col-start-2 min-w-0 break-words text-[11px] text-text-secondary">
                {choice.description}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="px-2 py-1.5 text-[11px] text-text-secondary">
        Applies to tabs created from now on. Running tabs keep theirs.
      </div>
    </div>
  );
}

export function AnchoredAgentPresetChooser({
  open,
  ...props
}: AgentPresetChooserProps & { open: boolean }) {
  const [measuredHeight, setMeasuredHeight] = useState<number>();
  const pos = useAnchoredPopoverPos(open, props.anchorRef, measuredHeight ?? 380);

  useEffect(() => {
    if (!open) setMeasuredHeight(undefined);
  }, [open]);

  if (!open || !pos) return null;
  const maxHeight = Math.max(80, window.innerHeight - pos.top - 4);
  return createPortal(
    <div
      style={{
        position: "fixed",
        top: pos.top,
        right: fitChooserRight(pos.right, window.innerWidth),
        zIndex: 100,
      }}
    >
      <AgentPresetChooser {...props} maxHeight={maxHeight} onHeightChange={setMeasuredHeight} />
    </div>,
    document.body,
  );
}
