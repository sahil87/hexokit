import { describeAgentPreset, displayAgentPresetName, resolveAgentPreset } from "@/lib/agent-presets";
import { useAgentPresetList } from "@/hooks/use-agent-preset-list";
import { useMachineAgentPresetInfo } from "@/hooks/use-machine-agent-preset-info";
import { CloseIcon, GearIcon } from "./icons";
import { CardActionRow } from "./row-flyout-card";

function useCardAgentPreset(own?: string, workspace?: string, server?: string, session?: string) {
  const list = useAgentPresetList(server, session);
  const machine = useMachineAgentPresetInfo();
  const effective = resolveAgentPreset({ own, workspace, machineDefault: machine?.machineDefault });
  return {
    list,
    effective,
    displayName: displayAgentPresetName(effective.name, list),
    available: (list?.length ?? 0) > 0,
  };
}

export function AgentPresetLine({
  own,
  workspace,
  server,
  session,
}: {
  own?: string;
  workspace?: string;
  server?: string;
  session?: string;
}) {
  const { effective, displayName, available } = useCardAgentPreset(own, workspace, server, session);
  if (!available) return null;
  return (
    <span data-testid="row-flyout-agent-preset" className="text-text-secondary break-words">
      {`agent preset: ${displayName} · ${effective.source}`}
    </span>
  );
}

export function AgentPresetActionRow({
  own,
  workspace,
  server,
  session,
  onAction,
}: {
  own?: string;
  workspace?: string;
  server?: string;
  session?: string;
  onAction?: () => void;
}) {
  const { displayName, available } = useCardAgentPreset(own, workspace, server, session);
  if (!available || !onAction) return null;
  return (
    <CardActionRow
      icon={<GearIcon />}
      label="Agent preset…"
      hint={displayName}
      testid="row-flyout-agent-preset-action"
      onClick={onAction}
    />
  );
}

export function AgentPresetMarker({ name, tile = false }: { name?: string; tile?: boolean }) {
  if (!name) return null;
  // The tile chip shares the tile's 14px count row, so it shrinks with its own
  // ellipsis and drops to 1px vertical padding to fit that row's height.
  const sizing = tile ? "min-w-[3ch] shrink py-px" : "min-w-0 max-w-[14ch] shrink-0 py-0.5";
  return (
    <span
      data-testid="agent-preset-marker"
      aria-label={`agent preset: ${name}`}
      title={`agent preset: ${name}`}
      className={`${sizing} overflow-hidden text-ellipsis whitespace-nowrap rounded-sm border border-border px-1 text-[10px] font-normal normal-case leading-none tracking-normal text-text-secondary`}
    >
      {name}
    </span>
  );
}

/** The `Clear agent preset` action row, offered only for a name the known list
 *  lacks (a stale or hand-set value). Renders nothing otherwise. */
export function AgentPresetClearRow({
  name,
  server,
  session,
  onClear,
}: {
  name: string;
  server?: string;
  session?: string;
  onClear: () => void;
}) {
  const list = useAgentPresetList(server, session);
  if (!describeAgentPreset(name, list).unknown) return null;
  return (
    <CardActionRow
      icon={<CloseIcon />}
      label="Clear agent preset"
      testid="row-flyout-clear-agent-preset-action"
      onClick={onClear}
    />
  );
}
