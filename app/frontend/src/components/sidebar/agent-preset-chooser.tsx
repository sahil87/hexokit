import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { getRiffPresets, type FabAgentPreset } from "@/api/client";
import { useAgentPresetList } from "@/hooks/use-agent-preset-list";
import { useMachineAgentPresetInfo } from "@/hooks/use-machine-agent-preset-info";
import { useOccludes } from "@/hooks/use-occludes";
import {
  buildAgentPresetChoices,
  loadMachineAgentPresetInfo,
  rememberRepoAgentPresets,
  resolveAgentPreset,
} from "@/lib/agent-presets";

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
}: {
  kind: "Group" | "Workspace";
  entityName: string;
  own?: string;
  workspace?: string;
  server: string;
  session?: string;
  anchorRef: RefObject<HTMLElement | null>;
  onPick: (value: string | null) => void;
  onClose: () => void;
}) {
  useOccludes("transient", true);
  const heldList = useAgentPresetList(server, session);
  const machine = useMachineAgentPresetInfo();
  const [presets, setPresets] = useState<FabAgentPreset[] | undefined>(heldList);
  const containerRef = useRef<HTMLDivElement>(null);
  const choiceRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const close = () => {
    const anchor = anchorRef.current;
    const focusTarget = anchor?.matches("button, [tabindex]")
      ? anchor
      : anchor?.querySelector<HTMLElement>("button, [tabindex]");
    focusTarget?.focus({ preventScroll: true });
    onClose();
  };

  useEffect(() => {
    if (heldList) setPresets(heldList);
  }, [heldList]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void getRiffPresets(server, session)
      .then(async (flight) => {
        rememberRepoAgentPresets(server, session, flight.agentPresets);
        if (flight.agentPresets) return flight.agentPresets;
        return (await loadMachineAgentPresetInfo()).presets;
      })
      .catch(async () => (await loadMachineAgentPresetInfo()).presets)
      .then((list) => {
        if (!cancelled) setPresets(list);
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
  const choiceSignature = choices.map((choice) => `${choice.label}:${choice.checked}`).join("|");

  useEffect(() => {
    const next = choices.findIndex((choice) => choice.checked);
    const index = next >= 0 ? next : 0;
    setActiveIndex(index);
    const timer = setTimeout(() => choiceRefs.current[index]?.focus({ preventScroll: true }), 0);
    return () => clearTimeout(timer);
    // Focus follows the opening choice, including when the repo list arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choiceSignature]);

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
      className="z-50 max-h-[calc(100vh-8px)] w-[min(320px,calc(100vw-8px))] overflow-y-auto border border-border bg-bg-primary text-xs shadow-[3px_3px_0_rgba(0,0,0,.35)]"
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
        className="divide-y divide-border bg-bg-inset"
      >
        {choices.map((choice, index) => (
          <button
            key={choice.label}
            ref={(node) => {
              choiceRefs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={choice.checked}
            tabIndex={index === activeIndex ? 0 : -1}
            onFocus={() => setActiveIndex(index)}
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
