import { useState } from "react";
import { clearLeftoverSettings, moveLeftoverSettings, type FabAgentPreset, type ServerInfo } from "@/api/client";
import { ConfirmBar, NameForm } from "@/components/settings-agent-preset-forms";
import type { RunOp } from "@/components/settings-agent-presets";
import {
  SettingsSection,
  smallButtonClass,
  type Document,
} from "@/components/settings-agents-shared";
import {
  MOVE_DEFAULT_DESCRIPTION,
  MOVE_DEFAULT_NAME,
  inheritanceLosses,
  looseValues,
  uniqueName,
  type InheritanceLoss,
} from "@/lib/agent-presets-editor";
import type { ProjectSession } from "@/types";

/** The Leftover settings box: explicit machine-wide values that belong to no
 *  preset. It offers to move them into a new preset or clear them, and
 *  disappears once none remain. Loose values override
 *  the machine default and fill in whatever a group's or workspace's preset
 *  leaves unset, so a move or clear names the groups and workspaces that would
 *  stop inheriting them. */

const SECTION_JOB = "From the old Customize grid. This box goes away once they are moved or cleared.";
const PRECEDENCE_NOTE = "They override the machine default, and fill in anything a group's or workspace's preset leaves unset.";

function disclosure(losses: InheritanceLoss[]): string | undefined {
  if (losses.length === 0) return undefined;
  const parts = losses.map((l) => `${l.entity}: ${l.losses.join(", ")}`);
  return `These have their own preset and will stop inheriting the loose values — ${parts.join("; ")}.`;
}

export function LeftoverSettings({
  doc,
  presets,
  runOp,
  servers,
  sessionsByServer,
}: {
  doc: Document;
  presets: FabAgentPreset[];
  runOp: RunOp;
  servers: readonly ServerInfo[];
  sessionsByServer: ReadonlyMap<string, readonly ProjectSession[]>;
}) {
  const [mode, setMode] = useState<"move" | "clear" | null>(null);
  const loose = looseValues(doc);
  if (loose.length === 0) return null;
  const names = presets.map((p) => p.name);
  const note = disclosure(inheritanceLosses(loose, presets, servers, sessionsByServer));
  const count = loose.length;
  return (
    <SettingsSection title="Leftover settings" job={SECTION_JOB} testId="leftover-settings" tone="notice">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="flex-1 basis-[260px] min-w-0">
          <p data-testid="leftover-summary" className="text-xs text-text-primary">
            {count} {count === 1 ? "setting is" : "settings are"} set outside any preset: {loose.map((l) => l.label).join(", ")}.
          </p>
          <p className="text-[10px] text-text-secondary mt-0.5 leading-relaxed">{PRECEDENCE_NOTE}</p>
        </div>
        <span className="flex flex-wrap gap-1.5">
          <button type="button" disabled={mode === "move"} onClick={() => setMode("move")} className={smallButtonClass}>
            Move into a new preset
          </button>
          <button type="button" disabled={mode === "clear"} onClick={() => setMode("clear")} className={smallButtonClass}>
            Clear them
          </button>
        </span>
      </div>
      {mode === "move" && (
        <NameForm
          title="Move into a new preset"
          verb="Move"
          initialName={uniqueName(MOVE_DEFAULT_NAME, names)}
          initialDescription={MOVE_DEFAULT_DESCRIPTION}
          askDescription
          takenNames={names}
          note={note}
          onSubmit={async ({ name, description }) => {
            await runOp(() => moveLeftoverSettings(name, description));
          }}
          onCancel={() => setMode(null)}
        />
      )}
      {mode === "clear" && (
        <ConfirmBar
          label="Clear leftover settings"
          verb="Clear"
          message={`Clear ${count === 1 ? "this setting" : `these ${count} settings`}? Nothing is moved into a preset.${note ? ` ${note}` : ""}`}
          onConfirm={async () => {
            await runOp(() => clearLeftoverSettings());
          }}
          onCancel={() => setMode(null)}
        />
      )}
    </SettingsSection>
  );
}
