import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteAgentPreset,
  duplicateAgentPreset,
  renameAgentPreset,
  type FabAgentPreset,
  type FabConfigDocument,
  type ServerInfo,
} from "@/api/client";
import { DeleteConfirm, NameForm } from "@/components/settings-agent-preset-forms";
import { PresetEditor, isReadOnlyPreset } from "@/components/settings-agent-preset-editor";
import { SettingsSection, smallButtonClass, stringValue, type Document, type Write } from "@/components/settings-agents-shared";
import {
  duplicateName,
  isBuiltIn,
  presetKey,
  presetUsage,
  usageLabels,
} from "@/lib/agent-presets-editor";
import { onPresetsIntent, takePresetsIntent, type PresetsIntent } from "@/lib/agent-presets-intent";
import type { ProjectSession } from "@/types";

/** The Presets section: the list of every machine-wide preset beside the editor
 *  for the selected one, with the inline name form (New, Duplicate, Rename) and
 *  the delete confirm. Nothing here changes which preset is in use. */

const SECTION_JOB = "Create, edit and delete presets. Nothing here changes which preset is in use.";
const RENAME_IN_USE_NOTE = "they follow the new name. Tabs already running under the old name fall back to the default.";

type FormState = { kind: "new" } | { kind: "duplicate" } | { kind: "rename" } | null;

/** Runs one multi-write request through the panel's write queue; on success the
 *  panel shows the fresh document, on failure it re-reads fab and rethrows. */
export type RunOp = (op: () => Promise<FabConfigDocument>) => Promise<void>;

function presetTag(preset: FabAgentPreset): string {
  if (isBuiltIn(preset)) return "built-in";
  return isReadOnlyPreset(preset) ? "env" : "yours";
}

function PresetList({
  presets,
  selected,
  machineDefault,
  onSelect,
  listRef,
}: {
  presets: FabAgentPreset[];
  selected: string;
  machineDefault: string;
  onSelect: (name: string) => void;
  listRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [active, setActive] = useState(selected);
  useEffect(() => setActive(selected), [selected]);
  const move = (from: number, step: number) => {
    const next = presets[(from + step + presets.length) % presets.length];
    setActive(next.name);
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
    items.find((el) => el.dataset.preset === next.name)?.focus();
  };
  return (
    <div className="border border-border rounded min-w-0">
      <div className="px-2.5 py-2 bg-bg-card border-b border-border text-[11px] uppercase tracking-wider text-text-secondary">
        All presets
      </div>
      <div ref={listRef} role="listbox" aria-label="Presets" className="flex flex-col p-1 gap-0.5">
        {presets.map((p, i) => (
          <button
            key={p.name}
            type="button"
            role="option"
            data-preset={p.name}
            aria-selected={p.name === selected}
            tabIndex={p.name === active ? 0 : -1}
            onClick={() => onSelect(p.name)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                move(i, e.key === "ArrowDown" ? 1 : -1);
              }
            }}
            className={`flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
              p.name === selected ? "border-accent text-text-primary bg-bg-card" : "border-transparent text-text-secondary hover:text-text-primary"
            }`}
          >
            <span className="flex-1 min-w-0 truncate">{p.name}</span>
            {p.name === machineDefault && (
              <span className="px-1 py-px border border-accent rounded text-[9px] uppercase tracking-wide text-accent">default</span>
            )}
            <span className="px-1 py-px border border-border rounded text-[9px] uppercase tracking-wide text-text-secondary">
              {presetTag(p)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function PresetsSection({
  doc,
  presets,
  write,
  runOp,
  servers,
  sessionsByServer,
}: {
  doc: Document;
  presets: FabAgentPreset[];
  write: Write;
  runOp: RunOp;
  servers: readonly ServerInfo[];
  sessionsByServer: ReadonlyMap<string, readonly ProjectSession[]>;
}) {
  const [selected, setSelected] = useState("");
  const [form, setForm] = useState<FormState>(null);
  const [deleting, setDeleting] = useState(false);
  const sectionRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const current = presets.find((p) => p.name === selected) ?? presets[0];
  const names = presets.map((p) => p.name);
  const machineDefault = stringValue(doc.fields["agent.preset"]);
  const usedBy = current ? usageLabels(presetUsage(current.name, machineDefault, servers, sessionsByServer)) : [];

  const choose = (name: string) => {
    setSelected(name);
    setForm(null);
    setDeleting(false);
  };

  const applyIntent = useCallback(
    (intent: PresetsIntent) => {
      sectionRef.current?.scrollIntoView?.({ block: "start" });
      if (intent.action === "focus") {
        listRef.current?.querySelector<HTMLElement>('[role="option"][tabindex="0"]')?.focus();
      } else if (intent.action === "new") {
        setForm({ kind: "new" });
        setDeleting(false);
      } else if (presets.some((p) => p.name === intent.name)) {
        setSelected(intent.name);
        setForm(intent.action === "delete" ? null : { kind: intent.action });
        setDeleting(intent.action === "delete");
      }
    },
    [presets],
  );
  const applyRef = useRef(applyIntent);
  applyRef.current = applyIntent;
  useEffect(() => {
    const take = () => {
      const intent = takePresetsIntent();
      if (intent) applyRef.current(intent);
    };
    take();
    return onPresetsIntent(take);
  }, []);

  if (!current) return null;
  const submitNew = async ({ name, description }: { name: string; description: string }) => {
    await write({ [presetKey(name, "description")]: description });
    choose(name);
  };
  const submitDuplicate = async ({ name, description }: { name: string; description: string }) => {
    await runOp(() => duplicateAgentPreset(current.name, name, description));
    choose(name);
  };
  const submitRename = async ({ name }: { name: string }) => {
    await runOp(() => renameAgentPreset(current.name, name));
    choose(name);
  };
  const confirmDelete = async () => {
    await runOp(() => deleteAgentPreset(current.name));
    choose("");
  };

  return (
    <SettingsSection
        title="Presets"
        job={SECTION_JOB}
        testId="presets-section"
        sectionRef={sectionRef}
        action={
          <button type="button" disabled={form !== null} onClick={() => { setForm({ kind: "new" }); setDeleting(false); }} className={smallButtonClass}>
            + New preset
          </button>
        }
      >
        {form?.kind === "new" && (
          <NameForm title="New preset" verb="Create" initialName="" askDescription takenNames={names} onSubmit={submitNew} onCancel={() => setForm(null)} />
        )}
        {form?.kind === "duplicate" && (
          <NameForm
            title={`Duplicate ${current.name} as`}
            verb="Duplicate"
            initialName={duplicateName(current.name, names)}
            initialDescription={current.description ?? ""}
            askDescription
            takenNames={names}
            onSubmit={submitDuplicate}
            onCancel={() => setForm(null)}
          />
        )}
        {form?.kind === "rename" && (
          <NameForm
            title={`Rename ${current.name} to`}
            verb="Rename"
            initialName={current.name}
            askDescription={false}
            takenNames={names}
            sameName={current.name}
            note={usedBy.length > 0 ? `Used by ${usedBy.join(", ")}; ${RENAME_IN_USE_NOTE}` : undefined}
            onSubmit={submitRename}
            onCancel={() => setForm(null)}
          />
        )}
        <div className="grid grid-cols-1 min-[641px]:grid-cols-[220px_minmax(0,1fr)] gap-2.5">
          <PresetList presets={presets} selected={current.name} machineDefault={machineDefault} onSelect={choose} listRef={listRef} />
          <PresetEditor
            key={current.name}
            doc={doc}
            preset={current}
            usedBy={usedBy}
            write={write}
            onRename={() => { setForm({ kind: "rename" }); setDeleting(false); }}
            onDuplicate={() => { setForm({ kind: "duplicate" }); setDeleting(false); }}
            onDelete={() => { setForm(null); setDeleting(true); }}
            confirm={deleting ? <DeleteConfirm name={current.name} usedBy={usedBy} onConfirm={confirmDelete} onCancel={() => setDeleting(false)} /> : undefined}
          />
        </div>
    </SettingsSection>
  );
}
