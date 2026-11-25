import { useCallback, useEffect, useRef, useState } from "react";
import {
  getFabConfig,
  postFabConfig,
  type FabAgentPreset,
  type FabConfigDocument,
  type FabField,
  type ServerInfo,
} from "@/api/client";
import { AGENT_PRESET_SELECT_ID } from "@/lib/agent-preset-focus";
import { invalidateMachineAgentPresets } from "@/lib/agent-presets";
import { controlClass } from "@/components/control";
import { INPUT_FOCUS } from "@/components/controls";
import { BoolToggle, CopyValueButton } from "@/components/settings-all-panel";
import { LeftoverSettings } from "@/components/settings-agent-leftovers";
import { PresetsSection, type RunOp } from "@/components/settings-agent-presets";
import { RoleTable, machineRoleKey } from "@/components/settings-agent-roles";
import {
  ProvenanceChip,
  ResetLink,
  SettingsSection,
  errorMessage,
  roleSelectBase,
  stringValue,
  useRowWrite,
  type Document,
  type Patch,
  type Write,
} from "@/components/settings-agents-shared";
import {
  PreferenceRow,
  ScopeHeading,
  TextSettingError,
  useTextSettingDraft,
} from "@/components/text-setting-core";
import type { ProjectSession } from "@/types";

/**
 * The Agents tab — a curated surface over fab-kit's machine-wide config
 * (`~/.fab-kit/config.yaml`), read and written exclusively through the daemon's
 * `/api/fab-config` wrapper of the `fab config` CLI. It never holds a cache:
 * the document is fetched on every mount (opening the dialog on Agents, or
 * switching to the tab) and replaced by whatever each POST returns, so an
 * external edit (the user's shell, `fab config upgrade`) always wins.
 *
 * With presets available the tab is four boxed sections: Leftover settings
 * (only while loose machine-wide values exist), Use a preset (the machine
 * default), Presets (list + editor) and Dispatch. A fab that cannot list
 * presets keeps the plain CLI knobs and role table.
 */

const KEY_PRESET = "agent.preset";
const KEY_SESSION = "agent.session";
const KEY_WORKERS = "agent.workers";
const KEY_MODE = "dispatch.mode";
const KEY_COLUMN_WIDTH = "dispatch.column_width";
const KEY_MIN_COLS = "dispatch.min_cols";
const KEY_MIN_ROWS = "dispatch.min_rows";
const KEY_REAP_DONE = "dispatch.reap_done";
const DISPATCH_MODES = ["pane", "native", "headless"];
// fab's reserved preset name: select no preset, even one a project defines.
const PRESET_NONE = "none";
const PRESET_NONE_OPTION_LABEL = "none (opts out of project presets)";
const PRESET_UNSET_LABEL = "None — fab's defaults";
const SYSTEM_CONFIG_FALLBACK_PATH = "~/.fab-kit/config.yaml";

const NOT_INSTALLED_MESSAGE =
  "fab isn't installed on this host. Install fab-kit to manage agent defaults here.";

/** A preset-supplied value is inherited from the preset, never an override. */
function hasSystemOverride(field: FabField | undefined): boolean {
  return (
    field !== undefined &&
    field.preset === undefined &&
    (field.origin === "system" || field.systemValue !== undefined)
  );
}

function ModifiedDot({ modified }: { modified: boolean }) {
  return (
    <span
      data-testid="modified-dot"
      aria-hidden={!modified}
      title={modified ? "set in the system config" : undefined}
      className={`w-1.5 h-1.5 rounded-full flex-none ${modified ? "bg-accent" : "bg-transparent"}`}
    />
  );
}

/** Amber inline warning for an env-shadowed key: the saved system value is
 *  written but does not take effect until the variable is unset. */
function EnvShadowWarning({ detail, systemValue }: { detail?: string; systemValue?: FabField["systemValue"] }) {
  const variable = detail ? `$${detail}` : "An environment variable";
  return (
    <p data-testid="env-shadow-warning" className="text-[10px] text-signal-yellow mt-1.5 leading-relaxed">
      ⚠ {variable} sets this for the daemon
      {systemValue !== undefined && systemValue !== null ? `, so the system value (${String(systemValue)}) is shadowed` : ""}.
      Changes here are saved but don&apos;t take effect until that variable is unset.
    </p>
  );
}

/** Latched segmented chips — one pressed at a time, committing on click. */
function ChipGroup({
  label,
  options,
  value,
  disabled,
  onPick,
}: {
  label: string;
  options: string[];
  value: string;
  disabled: boolean;
  onPick: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o}
          type="button"
          aria-pressed={value === o}
          disabled={disabled}
          onClick={() => onPick(o)}
          className={controlClass({
            variant: "toggle",
            base: "px-2 py-1 border rounded text-xs transition-colors",
            pressed: value === o,
            disabled,
          })}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

/** Everything a scalar-key row shares: label, control slot, provenance chip,
 *  modified dot, reset link (only with a system override), env warning, and
 *  the inline write error. */
function FabRow({
  fieldKey,
  label,
  sublabel,
  field,
  busy,
  error,
  onReset,
  children,
}: {
  fieldKey: string;
  label: string;
  sublabel: string;
  field: FabField | undefined;
  busy: boolean;
  error: string;
  onReset: () => void;
  children: React.ReactNode;
}) {
  const modified = hasSystemOverride(field);
  return (
    <div data-testid={`fab-row-${fieldKey}`}>
      <PreferenceRow label={label} sublabel={sublabel} meta={fieldKey}>
        <div className="flex flex-wrap items-center gap-2">
          {children}
          {field && <ProvenanceChip origin={field.origin} detail={field.originDetail} preset={field.preset} />}
          <ModifiedDot modified={modified} />
          {modified && <ResetLink label={`Reset ${fieldKey}`} onReset={onReset} busy={busy} />}
        </div>
        {field?.origin === "env" && field.preset === undefined && (
          <EnvShadowWarning detail={field.originDetail} systemValue={field.systemValue} />
        )}
        <TextSettingError error={error} />
      </PreferenceRow>
    </div>
  );
}

function ChipRow({
  fieldKey,
  label,
  sublabel,
  options,
  field,
  write,
}: {
  fieldKey: string;
  label: string;
  sublabel: string;
  options: string[];
  field: FabField | undefined;
  write: Write;
}) {
  const { error, busy, run } = useRowWrite(write);
  return (
    <FabRow
      fieldKey={fieldKey}
      label={label}
      sublabel={sublabel}
      field={field}
      busy={busy}
      error={error}
      onReset={() => void run({ [fieldKey]: null })}
    >
      <ChipGroup
        label={label}
        options={options}
        value={stringValue(field)}
        disabled={busy}
        onPick={(v) => void run({ [fieldKey]: v })}
      />
    </FabRow>
  );
}

/** A whole-number input on the shared draft core: Enter/blur commit, Escape
 *  reverts, a server rejection renders inline and keeps the typed value. */
function NumberInput({
  id,
  label,
  value,
  commit,
}: {
  id: string;
  label: string;
  value: number | null;
  commit: (n: number) => Promise<void>;
}) {
  const { draft, error, handleCommit, onChange, onKeyDown } = useTextSettingDraft(
    value === null ? "" : String(value),
    async (trimmed) => {
      if (!/^\d+$/.test(trimmed)) throw new Error("Enter a whole number");
      await commit(Number(trimmed));
    },
  );
  return (
    <span className="inline-flex flex-col">
      <input
        id={id}
        type="text"
        inputMode="numeric"
        aria-label={label}
        value={draft}
        onChange={onChange}
        onBlur={handleCommit}
        onKeyDown={onKeyDown}
        className={`w-16 bg-transparent text-text-primary p-1.5 border border-border rounded text-xs ${INPUT_FOCUS}`}
      />
      <TextSettingError error={error} />
    </span>
  );
}

function numberValue(field: FabField | undefined): number | null {
  return typeof field?.value === "number" ? field.value : null;
}

function ColumnWidthRow({ field, write }: { field: FabField | undefined; write: Write }) {
  const { busy, error, run } = useRowWrite(write);
  return (
    <FabRow
      fieldKey={KEY_COLUMN_WIDTH}
      label="Worker column width"
      sublabel="Pane-worker column, % of window"
      field={field}
      busy={busy}
      error={error}
      onReset={() => void run({ [KEY_COLUMN_WIDTH]: null })}
    >
      <span className="inline-flex items-start gap-1.5 text-xs text-text-secondary">
        <NumberInput
          id="fab-column-width"
          label="Worker column width percent"
          value={numberValue(field)}
          commit={(n) => write({ [KEY_COLUMN_WIDTH]: n })}
        />
        <span className="pt-1.5">%</span>
      </span>
    </FabRow>
  );
}

function SplitFloorRow({
  colsField,
  rowsField,
  write,
}: {
  colsField: FabField | undefined;
  rowsField: FabField | undefined;
  write: Write;
}) {
  const { busy, error, run } = useRowWrite(write);
  const modified = hasSystemOverride(colsField) || hasSystemOverride(rowsField);
  const envField = [colsField, rowsField].find((f) => f?.origin === "env");
  return (
    <div data-testid="fab-row-dispatch.split-floor">
      <PreferenceRow
        label="Split floor"
        sublabel="Below this, the worker opens in its own window"
        meta={`${KEY_MIN_COLS} / ${KEY_MIN_ROWS}`}
      >
        <div className="flex flex-wrap items-start gap-2 text-xs text-text-secondary">
          <NumberInput
            id="fab-min-cols"
            label="Split floor columns"
            value={numberValue(colsField)}
            commit={(n) => write({ [KEY_MIN_COLS]: n })}
          />
          <span className="pt-1.5">cols</span>
          {colsField && <span className="pt-1"><ProvenanceChip origin={colsField.origin} detail={colsField.originDetail} /></span>}
          <span className="pt-1.5">×</span>
          <NumberInput
            id="fab-min-rows"
            label="Split floor rows"
            value={numberValue(rowsField)}
            commit={(n) => write({ [KEY_MIN_ROWS]: n })}
          />
          <span className="pt-1.5">rows</span>
          {rowsField && <span className="pt-1"><ProvenanceChip origin={rowsField.origin} detail={rowsField.originDetail} /></span>}
          <span className="pt-1.5">
            <ModifiedDot modified={modified} />
          </span>
          {modified && (
            <span className="pt-0.5">
              <ResetLink
                label="Reset split floor"
                busy={busy}
                onReset={() => void run({ [KEY_MIN_COLS]: null, [KEY_MIN_ROWS]: null })}
              />
            </span>
          )}
        </div>
        {envField && <EnvShadowWarning detail={envField.originDetail} />}
        <TextSettingError error={error} />
      </PreferenceRow>
    </div>
  );
}

function ReapDoneRow({ field, write }: { field: FabField | undefined; write: Write }) {
  const { busy, error, run } = useRowWrite(write);
  return (
    <FabRow
      fieldKey={KEY_REAP_DONE}
      label="Reap finished panes"
      sublabel="Close a worker's pane when its stage is done"
      field={field}
      busy={busy}
      error={error}
      onReset={() => void run({ [KEY_REAP_DONE]: null })}
    >
      <BoolToggle
        label="Reap finished panes"
        on={field?.value === true}
        commit={(on) => write({ [KEY_REAP_DONE]: on })}
      />
    </FabRow>
  );
}

/** The machine default dropdown. None unsets `agent.preset`; a `none` set from a
 *  shell and a name fab no longer lists stay visible so they remain clearable. */
function AgentPresetRow({
  field,
  presets,
  write,
}: {
  field: FabField | undefined;
  presets: FabAgentPreset[];
  write: Write;
}) {
  const { busy, error, run } = useRowWrite(write);
  const current = stringValue(field);
  const listed = presets.some((p) => p.name === current);
  return (
    <FabRow
      fieldKey={KEY_PRESET}
      label="Machine default"
      sublabel="used when a workspace or group does not pick its own"
      field={field}
      busy={busy}
      error={error}
      onReset={() => void run({ [KEY_PRESET]: null })}
    >
      <select
        id={AGENT_PRESET_SELECT_ID}
        data-testid="agent-preset-select"
        aria-label="Agent preset"
        value={current}
        disabled={busy}
        onChange={(e) => void run({ [KEY_PRESET]: e.target.value === "" ? null : e.target.value })}
        className={`${roleSelectBase} max-w-[16rem] ${current === "" ? "text-text-secondary" : ""}`}
      >
        <option value="">{PRESET_UNSET_LABEL}</option>
        {current === PRESET_NONE && <option value={PRESET_NONE}>{PRESET_NONE_OPTION_LABEL}</option>}
        {current !== "" && current !== PRESET_NONE && !listed && (
          <option value={current}>{current} (unknown)</option>
        )}
        {presets.map((p) => (
          <option key={p.name} value={p.name}>
            {p.description ? `${p.name} — ${p.description}` : p.name}
          </option>
        ))}
      </select>
    </FabRow>
  );
}

type Context = {
  servers: readonly ServerInfo[];
  sessionsByServer: ReadonlyMap<string, readonly ProjectSession[]>;
};

/** The CLI knobs and role table over the loose machine-wide keys — kept only
 *  for a fab that cannot list presets, where there is no preset to move them
 *  into. */
function PlainKnobs({ doc, write }: { doc: Document; write: Write }) {
  const f = doc.fields;
  return (
    <div className="divide-y divide-border/40">
      <ChipRow
        fieldKey={KEY_SESSION}
        label="Session CLI"
        sublabel="What you talk to: fab agent, operator, batch"
        options={doc.tools}
        field={f[KEY_SESSION]}
        write={write}
      />
      <ChipRow
        fieldKey={KEY_WORKERS}
        label="Worker CLI"
        sublabel="What pipeline stages dispatch to"
        options={doc.tools}
        field={f[KEY_WORKERS]}
        write={write}
      />
      <RoleTable
        doc={doc}
        roles={doc.roles}
        write={write}
        keyOf={machineRoleKey}
        title="Per-role overrides"
        hint={
          <>
            Optional. Change one role without moving the whole tier.{" "}
            <span className="font-mono text-text-secondary/70">agent.profiles.&lt;role&gt;</span>
          </>
        }
      />
    </div>
  );
}

function DispatchSection({ doc, write }: { doc: Document; write: Write }) {
  const f = doc.fields;
  return (
    <SettingsSection title="Dispatch" job="How worker stages are launched." testId="dispatch-section">
      <div className="divide-y divide-border/40">
        <ChipRow
          fieldKey={KEY_MODE}
          label="Dispatch mode"
          sublabel="Preference ceiling: pane → native → headless"
          options={DISPATCH_MODES}
          field={f[KEY_MODE]}
          write={write}
        />
        <ColumnWidthRow field={f[KEY_COLUMN_WIDTH]} write={write} />
        <SplitFloorRow colsField={f[KEY_MIN_COLS]} rowsField={f[KEY_MIN_ROWS]} write={write} />
        <ReapDoneRow field={f[KEY_REAP_DONE]} write={write} />
      </div>
    </SettingsSection>
  );
}

function AgentsContent({
  doc,
  write,
  runOp,
  warnings,
  context,
}: {
  doc: Document;
  write: Write;
  runOp: RunOp;
  warnings: string[];
  context: Context;
}) {
  const presets = doc.agent_presets;
  return (
    <>
      <ScopeHeading
        label="Agents"
        hint={`${doc.systemPath || SYSTEM_CONFIG_FALLBACK_PATH} · machine-wide, outranks project files`}
      />
      <div className="flex flex-col gap-3 mt-2">
        {presets ? (
          <>
            <LeftoverSettings doc={doc} presets={presets} runOp={runOp} {...context} />
            <SettingsSection
              title="Use a preset"
              job="Pick which preset this machine uses. Nothing here changes what a preset contains."
              testId="use-preset-section"
            >
              <AgentPresetRow field={doc.fields[KEY_PRESET]} presets={presets} write={write} />
              <p className="text-[10px] text-text-secondary leading-relaxed">
                Workspaces and groups pick theirs from their sidebar card. A single new tab can pick one in the spawn dialog.
              </p>
            </SettingsSection>
            <PresetsSection doc={doc} presets={presets} write={write} runOp={runOp} {...context} />
          </>
        ) : (
          <section aria-label="Agent CLIs">
            <PlainKnobs doc={doc} write={write} />
          </section>
        )}
        <DispatchSection doc={doc} write={write} />
      </div>

      {warnings.length > 0 && (
        <div data-testid="fab-warnings" role="status" className="mt-3 text-[10px] text-signal-yellow space-y-0.5">
          {warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      )}

      <footer className="mt-4 pt-2 border-t border-border/40 text-[10px] text-text-secondary space-y-1">
        <p>
          The CLI table (<code>providers:</code> / <code>clis:</code>) and other list/map keys can&apos;t be set
          from the command line.
        </p>
        <p className="flex items-center gap-2 flex-wrap">
          <span>Edit them in</span>
          <code data-testid="fab-system-path" className="text-text-primary break-all">
            {doc.systemPath || SYSTEM_CONFIG_FALLBACK_PATH}
          </code>
          <CopyValueButton value={doc.systemPath || SYSTEM_CONFIG_FALLBACK_PATH} label="Copy fab system config path" />
        </p>
        <p>Project-only keys (fab/project/config.yaml) aren&apos;t shown here.</p>
      </footer>
    </>
  );
}

const NO_SERVERS: readonly ServerInfo[] = [];
const NO_SESSIONS: ReadonlyMap<string, readonly ProjectSession[]> = new Map();

/** `servers` and `sessionsByServer` are the streamed state the usage notes and
 *  the leftover disclosure read; without them (a bare mount) no preset shows as
 *  used by a group or workspace. */
export function SettingsAgentsPanel({
  servers = NO_SERVERS,
  sessionsByServer = NO_SESSIONS,
}: {
  servers?: readonly ServerInfo[];
  sessionsByServer?: ReadonlyMap<string, readonly ProjectSession[]>;
}) {
  const [doc, setDoc] = useState<FabConfigDocument | null>(null);
  const [loadError, setLoadError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);

  // Every document — GET or POST — carries the warnings to show with it, and
  // makes the cached machine preset list (card choosers, palette) stale.
  const show = useCallback((d: FabConfigDocument) => {
    invalidateMachineAgentPresets();
    setDoc(d);
    setWarnings(d.installed ? (d.warnings ?? []) : []);
  }, []);

  // Fetched on every mount — the panel only mounts while the tab is visible,
  // so each visit re-reads fab.
  useEffect(() => {
    let cancelled = false;
    getFabConfig()
      .then((d) => {
        if (!cancelled) show(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [show]);

  // Rejects on failure (the calling row shows the message); on success the
  // whole panel re-renders from the fresh document the request returns.
  const apply = useCallback(async (op: () => Promise<FabConfigDocument>) => {
    setWarnings([]);
    let next: FabConfigDocument;
    try {
      next = await op();
    } catch (err) {
      // A multi-key or multi-step write can fail after earlier steps landed,
      // so re-read fab instead of keeping the pre-write document.
      await getFabConfig()
        .then(show)
        .catch(() => {});
      throw err;
    }
    show(next);
  }, [show]);

  // Writes run one at a time: every response is a whole document, so an
  // overlapping older response could otherwise land after a newer one.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const runOp = useCallback<RunOp>(
    (op) => {
      const run = queue.current.then(() => apply(op));
      queue.current = run.catch(() => {});
      return run;
    },
    [apply],
  );
  const write = useCallback<Write>((patch: Patch) => runOp(() => postFabConfig(patch)), [runOp]);

  if (loadError) {
    return (
      <p role="alert" className="text-xs text-signal-red">
        {loadError}
      </p>
    );
  }
  if (doc === null) {
    return <p className="text-xs text-text-secondary">Loading…</p>;
  }
  if (!doc.installed) {
    return (
      <section aria-label="fab-kit">
        <ScopeHeading label="fab-kit · this machine" hint={SYSTEM_CONFIG_FALLBACK_PATH} />
        <p data-testid="fab-not-installed" className="text-xs text-text-secondary py-2.5">
          {NOT_INSTALLED_MESSAGE}
        </p>
      </section>
    );
  }
  return (
    <AgentsContent doc={doc} write={write} runOp={runOp} warnings={warnings} context={{ servers, sessionsByServer }} />
  );
}
