import { describeAgentPreset } from "@/lib/agent-presets";
import { useAgentPresetList } from "@/hooks/use-agent-preset-list";
import { CloseIcon } from "./icons";
import { CardActionRow } from "./row-flyout-card";

/** The card's `agent preset: <name>` facts line. The name reads `<name>
 *  (unknown)` when the preset list the UI holds for the scope lacks it, and
 *  `none (no preset)` for the reserved opt-out. `server`/`session` select the
 *  group's repo-scoped list when its spawn dialog loaded one; omit both for a
 *  workspace (machine-wide list). Mounted only while the card is open. */
export function AgentPresetFact({ name, server, session }: { name: string; server?: string; session?: string }) {
  const list = useAgentPresetList(server, session);
  const { label } = describeAgentPreset(name, list);
  return (
    <span data-testid="row-flyout-agent-preset" className="text-text-secondary break-words">
      {`agent preset: ${label}`}
    </span>
  );
}

/** The `Clear agent preset` action row, offered only for a name the known list
 *  lacks (a stale or hand-set value — a valid preset is changed from the
 *  palette). Renders nothing otherwise. */
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
