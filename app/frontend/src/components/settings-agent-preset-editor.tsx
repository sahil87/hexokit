import { useEffect, useState } from "react";
import { resolveAgentPreset, type FabAgentPreset, type FabRoleCell } from "@/api/client";
import { RoleSelect, RoleTable, presetRoleKey } from "@/components/settings-agent-roles";
import {
  dangerButtonClass,
  smallButtonClass,
  useRowWrite,
  type Document,
  type Write,
} from "@/components/settings-agents-shared";
import { TextSettingError, textSettingInputClass, useTextSettingDraft } from "@/components/text-setting-core";
import {
  MSG_LAST_FIELD,
  depthKnobApplies,
  emptiesPreset,
  isBuiltIn,
  presetKey,
  presetRoleRows,
  type ResolvedRoles,
} from "@/lib/agent-presets-editor";

/** The editor pane of the Presets section: one preset's description, Session
 *  and Worker CLI, and role table. Every change is one write to
 *  `agent_presets.<name>.*`; unset fields show what applies, dimmed with ↳. A
 *  built-in (or environment-defined) preset renders every control disabled. */

const BUILT_IN_NOTE = "Built-in presets are read-only. Duplicate this one to change it.";
const ENV_NOTE = "Presets defined in the environment are read-only. Duplicate this one to change it.";
const EDITABLE_NOTE = "↳ means the field is not set and the value shown is what applies. Each change is saved as you make it.";
const APPLIES_NOTE = "A change applies to the next stage dispatched in every tab launched with this preset.";

export const isReadOnlyPreset = (preset: FabAgentPreset) => preset.source !== "system";

/** fab's per-role resolution of the preset, fetched for the preset on screen and
 *  again whenever the document changes (an edit anywhere can move what applies).
 *  A failed read leaves the dimmed values blank — it never breaks the editor. */
function useResolvedRoles(name: string, doc: Document): ResolvedRoles | undefined {
  const [state, setState] = useState<{ name: string; roles: ResolvedRoles } | null>(null);
  useEffect(() => {
    let cancelled = false;
    resolveAgentPreset(name)
      .then((roles) => {
        if (!cancelled) setState({ name, roles });
      })
      .catch(() => {
        if (!cancelled) setState({ name, roles: {} });
      });
    return () => {
      cancelled = true;
    };
  }, [name, doc]);
  return state?.name === name ? state.roles : undefined;
}

function PaneRow({ label, sublabel, children }: { label: string; sublabel: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-1 py-1.5">
      <div className="basis-[150px] shrink-0 min-[480px]:pt-1">
        <p className="text-xs text-text-primary">{label}</p>
        <p className="text-[10px] text-text-secondary mt-0.5 leading-relaxed">{sublabel}</p>
      </div>
      <div className="flex-1 basis-[200px] min-w-0">{children}</div>
    </div>
  );
}

function DescriptionRow({ preset, readOnly, write }: { preset: FabAgentPreset; readOnly: boolean; write: Write }) {
  const { draft, error, handleCommit, onChange, onKeyDown } = useTextSettingDraft(preset.description ?? "", async (trimmed) => {
    await write({ [presetKey(preset.name, "description")]: trimmed === "" ? null : trimmed });
  });
  return (
    <PaneRow label="Description" sublabel="shown wherever a preset is picked">
      <input
        type="text"
        aria-label="Description"
        value={draft}
        disabled={readOnly}
        onChange={onChange}
        onBlur={handleCommit}
        onKeyDown={onKeyDown}
        className={`${textSettingInputClass} max-w-none p-1.5 text-xs`}
      />
      <TextSettingError error={error} />
    </PaneRow>
  );
}

function DepthRow({
  depth,
  label,
  sublabel,
  doc,
  preset,
  readOnly,
  write,
}: {
  depth: "session" | "workers";
  label: string;
  sublabel: string;
  doc: Document;
  preset: FabAgentPreset;
  readOnly: boolean;
  write: Write;
}) {
  const { error, busy, run } = useRowWrite(write);
  const applies = depthKnobApplies(doc, depth);
  const own = preset[depth] ?? null;
  const cell: FabRoleCell = { override: own, effective: own ?? applies, source: "", origin: "", inherited: applies };
  return (
    <PaneRow label={label} sublabel={sublabel}>
      <RoleSelect
        label={label}
        cell={cell}
        options={doc.tools}
        disabled={busy || readOnly}
        onChange={(v) => void run({ [presetKey(preset.name, depth)]: v })}
      />
      <TextSettingError error={error} />
    </PaneRow>
  );
}

export function PresetEditor({
  doc,
  preset,
  usedBy,
  write,
  onRename,
  onDuplicate,
  onDelete,
  confirm,
}: {
  doc: Document;
  preset: FabAgentPreset;
  /** Where the preset is used, in words ("the machine default", "group hexokit"). */
  usedBy: string[];
  write: Write;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  /** The delete confirm, shown at the top of the pane while open. */
  confirm?: React.ReactNode;
}) {
  const readOnly = isReadOnlyPreset(preset);
  const resolved = useResolvedRoles(preset.name, doc);
  const guardedWrite: Write = async (patch) => {
    if (emptiesPreset(preset, patch)) throw new Error(MSG_LAST_FIELD);
    await write(patch);
  };
  const tag = isBuiltIn(preset) ? "built-in · read-only" : readOnly ? "environment · read-only" : "yours";
  return (
    <div data-testid="preset-editor" className="border border-border rounded min-w-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-2.5 py-2 bg-bg-card border-b border-border">
        <span className="text-xs text-text-primary">
          Editing <b>{preset.name}</b>
        </span>
        <span className="px-1 py-px border border-border rounded text-[9px] uppercase tracking-wide text-text-secondary">{tag}</span>
        <span className="ml-auto flex flex-wrap gap-1.5">
          <button type="button" disabled={readOnly} onClick={onRename} className={smallButtonClass}>
            Rename
          </button>
          <button type="button" onClick={onDuplicate} className={smallButtonClass}>
            Duplicate
          </button>
          <button type="button" disabled={readOnly} onClick={onDelete} className={dangerButtonClass}>
            Delete
          </button>
        </span>
      </div>
      <div className="px-2.5 py-2 flex flex-col gap-1">
        {confirm}
        <DescriptionRow preset={preset} readOnly={readOnly} write={guardedWrite} />
        <DepthRow depth="session" label="Session CLI" sublabel="what you talk to" doc={doc} preset={preset} readOnly={readOnly} write={guardedWrite} />
        <DepthRow depth="workers" label="Worker CLI" sublabel="what pipeline stages dispatch to" doc={doc} preset={preset} readOnly={readOnly} write={guardedWrite} />
        <RoleTable
          doc={doc}
          roles={presetRoleRows(doc, preset, resolved)}
          write={guardedWrite}
          keyOf={presetRoleKey(preset.name)}
          readOnly={readOnly}
          title="Roles"
          hint="CLI, model and effort per role. Leave a field unset to use what applies."
        />
        <p data-testid="preset-editor-note" className="text-[10px] text-text-secondary leading-relaxed">
          {isBuiltIn(preset) ? BUILT_IN_NOTE : readOnly ? ENV_NOTE : EDITABLE_NOTE}
        </p>
        <p data-testid="preset-usage-note" className="text-[10px] text-text-secondary leading-relaxed">
          {usedBy.length > 0 ? `Used by ${usedBy.join(", ")}.` : "Not used anywhere yet."} {APPLIES_NOTE}
        </p>
      </div>
    </div>
  );
}
