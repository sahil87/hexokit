import { useCallback, useEffect, useState } from "react";
import {
  getFabConfig,
  postFabConfig,
  type FabConfigDocument,
  type FabField,
  type FabOrigin,
  type FabRole,
  type FabRoleCell,
} from "@/api/client";
import { controlClass } from "@/components/control";
import { INPUT_FOCUS } from "@/components/controls";
import { BoolToggle, CopyValueButton } from "@/components/settings-all-panel";
import {
  PreferenceRow,
  ScopeHeading,
  TextSettingError,
  textSettingInputClass,
  useTextSettingDraft,
} from "@/components/text-setting-core";

/**
 * The Agents tab — a curated surface over fab-kit's machine-wide config
 * (`~/.fab-kit/config.yaml`), read and written exclusively through the daemon's
 * `/api/fab-config` wrapper of the `fab config` CLI. It never holds a cache:
 * the document is fetched on every mount (opening the dialog on Agents, or
 * switching to the tab) and replaced by whatever each POST returns, so an
 * external edit (the user's shell, `fab config upgrade`) always wins.
 */

type Document = Extract<FabConfigDocument, { installed: true }>;
type Patch = Record<string, string | number | boolean | null>;
type Write = (patch: Patch) => Promise<void>;

const KEY_SESSION = "agent.session";
const KEY_WORKERS = "agent.workers";
const KEY_MODE = "dispatch.mode";
const KEY_COLUMN_WIDTH = "dispatch.column_width";
const KEY_MIN_COLS = "dispatch.min_cols";
const KEY_MIN_ROWS = "dispatch.min_rows";
const KEY_REAP_DONE = "dispatch.reap_done";
const DISPATCH_MODES = ["pane", "native", "headless"];
const SYSTEM_CONFIG_FALLBACK_PATH = "~/.fab-kit/config.yaml";
const INHERIT_FALLBACK = "provider default";

const NOT_INSTALLED_MESSAGE =
  "fab isn't installed on this host. Install fab-kit to manage agent defaults here.";

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "Failed to save";
}

function hasSystemOverride(field: FabField | undefined): boolean {
  return field !== undefined && (field.origin === "system" || field.systemValue !== undefined);
}

function profileKey(role: string, leaf: "provider" | "model" | "effort"): string {
  return `agent.profiles.${role}.${leaf}`;
}

/** Provenance chip: which tier the effective value comes from. `env` renders
 *  amber (it shadows the saved value); `project` is read-only informational. */
function ProvenanceChip({ origin, detail }: { origin: FabOrigin | ""; detail?: string }) {
  if (origin === "") return null;
  const tone = origin === "env" ? "text-signal-yellow border-signal-yellow" : "text-text-secondary border-border";
  return (
    <span
      data-testid="provenance-chip"
      title={detail || undefined}
      className={`px-1 py-px border rounded text-[9px] uppercase tracking-wide ${tone}`}
    >
      {origin}
    </span>
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

function ResetLink({ label, onReset, busy }: { label: string; onReset: () => void; busy: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={busy}
      onClick={onReset}
      className="text-[10px] text-accent hover:underline disabled:opacity-40"
    >
      reset
    </button>
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

/** Row-scoped write state: a failed write shows fab's message on THAT row and
 *  leaves the previous value (the panel re-renders only from a good POST). */
function useRowWrite(write: Write) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (patch: Patch) => {
      setBusy(true);
      setError("");
      try {
        await write(patch);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [write],
  );
  return { error, busy, run };
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
          {field && <ProvenanceChip origin={field.origin} detail={field.originDetail} />}
          <ModifiedDot modified={modified} />
          {modified && <ResetLink label={`Reset ${fieldKey}`} onReset={onReset} busy={busy} />}
        </div>
        {field?.origin === "env" && (
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
        value={typeof field?.value === "string" ? field.value : ""}
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
  const shown = colsField ?? rowsField;
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
          <span className="pt-1.5">cols ×</span>
          <NumberInput
            id="fab-min-rows"
            label="Split floor rows"
            value={numberValue(rowsField)}
            commit={(n) => write({ [KEY_MIN_ROWS]: n })}
          />
          <span className="pt-1.5">rows</span>
          {shown && <span className="pt-1"><ProvenanceChip origin={envField?.origin ?? shown.origin} detail={(envField ?? shown).originDetail} /></span>}
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

const roleSelectClass = `bg-transparent text-text-primary p-1 border border-border rounded text-xs max-w-[9rem] ${INPUT_FOCUS}`;

/** Cell text for the inherited (no-override) option: `↳ <effective>`. */
function inheritedLabel(cell: FabRoleCell): string {
  return `↳ ${cell.effective || INHERIT_FALLBACK}`;
}

/** A closed-set select whose first option is "inherit" (→ null). */
function RoleSelect({
  label,
  cell,
  options,
  disabled,
  onChange,
}: {
  label: string;
  cell: FabRoleCell;
  options: string[];
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  const withOverride = cell.override !== null && !options.includes(cell.override) ? [...options, cell.override] : options;
  return (
    <select
      aria-label={label}
      value={cell.override ?? ""}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      className={`${roleSelectClass} ${cell.override === null ? "text-text-secondary" : ""}`}
    >
      <option value="">{inheritedLabel(cell)}</option>
      {withOverride.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

function RoleModelInput({
  role,
  cell,
  suggestions,
  commit,
}: {
  role: string;
  cell: FabRoleCell;
  suggestions: string[];
  commit: (value: string | null) => Promise<void>;
}) {
  const { draft, error, handleCommit, onChange, onKeyDown } = useTextSettingDraft(
    cell.override ?? "",
    (trimmed) => commit(trimmed === "" ? null : trimmed),
  );
  const listId = `fab-models-${role}`;
  const mismatch =
    cell.override !== null && suggestions.length > 0 && !suggestions.includes(cell.override);
  return (
    <span className="inline-flex flex-col">
      <span className="inline-flex items-center gap-1">
        <input
          type="text"
          list={listId}
          aria-label={`${role} model`}
          value={draft}
          placeholder={inheritedLabel(cell)}
          onChange={onChange}
          onBlur={handleCommit}
          onKeyDown={onKeyDown}
          className={`${textSettingInputClass} max-w-[12rem] p-1 text-xs`}
        />
        {mismatch && (
          <span
            role="img"
            aria-label="model not in the provider's suggestions"
            title="This model isn't in the resolved provider's suggestion list — fab doesn't validate provider × model pairs"
            className="text-signal-yellow"
          >
            ⚠
          </span>
        )}
      </span>
      <datalist id={listId}>
        {suggestions.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <TextSettingError error={error} />
    </span>
  );
}

function RoleRow({
  role,
  providers,
  suggestions,
  efforts,
  write,
}: {
  role: FabRole;
  providers: string[];
  suggestions: string[];
  efforts: string[];
  write: Write;
}) {
  const { busy, error, run } = useRowWrite(write);
  const overridden =
    role.provider.override !== null || role.model.override !== null || role.effort.override !== null;
  return (
    <>
      <tr data-testid={`role-row-${role.role}`} className="border-b border-border/40 align-top">
        <td className="py-1.5 pr-2 text-text-primary">{role.role}</td>
        <td className="py-1.5 pr-2 text-text-secondary">{role.depth}</td>
        <td className="py-1.5 pr-2">
          <span className="inline-flex items-center gap-1">
            <RoleSelect
              label={`${role.role} provider`}
              cell={role.provider}
              options={providers}
              disabled={busy}
              onChange={(v) => void run({ [profileKey(role.role, "provider")]: v })}
            />
            {role.provider.origin === "env" && (
              <span
                role="img"
                aria-label="provider set by an environment variable"
                title={`${role.provider.originDetail ?? "An environment variable"} sets this provider — changes here won't take effect until it is unset`}
                className="text-signal-yellow"
              >
                ⚠
              </span>
            )}
          </span>
        </td>
        <td className="py-1.5 pr-2">
          <RoleModelInput
            role={role.role}
            cell={role.model}
            suggestions={suggestions}
            commit={(v) => write({ [profileKey(role.role, "model")]: v })}
          />
        </td>
        <td className="py-1.5 pr-2">
          <RoleSelect
            label={`${role.role} effort`}
            cell={role.effort}
            options={efforts}
            disabled={busy}
            onChange={(v) => void run({ [profileKey(role.role, "effort")]: v })}
          />
        </td>
        <td className="py-1.5">
          {overridden && (
            <ResetLink
              label={`Reset ${role.role} overrides`}
              busy={busy}
              onReset={() =>
                void run({
                  [profileKey(role.role, "provider")]: null,
                  [profileKey(role.role, "model")]: null,
                  [profileKey(role.role, "effort")]: null,
                })
              }
            />
          )}
        </td>
      </tr>
      {error && (
        <tr>
          <td colSpan={6}>
            <TextSettingError error={error} />
          </td>
        </tr>
      )}
    </>
  );
}

function RoleTable({ doc, write }: { doc: Document; write: Write }) {
  return (
    <div className="py-2.5">
      <p className="text-xs text-text-primary">Per-role overrides</p>
      <p className="text-[10px] text-text-secondary mt-0.5 mb-1.5">
        Optional. Change one role without moving the whole tier.{" "}
        <span className="font-mono text-text-secondary/70">agent.profiles.&lt;role&gt;</span>
      </p>
      {/* The wrapper owns horizontal scroll so the table never widens the page. */}
      <div className="overflow-x-auto" data-testid="role-table-wrap">
        <table className="min-w-[620px] w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-text-secondary border-b border-border">
              <th className="py-1 pr-2 font-medium">Role</th>
              <th className="py-1 pr-2 font-medium">Tier</th>
              <th className="py-1 pr-2 font-medium">Provider</th>
              <th className="py-1 pr-2 font-medium">Model</th>
              <th className="py-1 pr-2 font-medium">Effort</th>
              <th className="py-1 font-medium">
                <span className="sr-only">Reset</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {doc.roles.map((role) => (
              <RoleRow
                key={role.role}
                role={role}
                providers={doc.providers}
                suggestions={doc.modelSuggestions[role.provider.effective] ?? []}
                efforts={doc.effortSuggestions}
                write={write}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AgentsContent({
  doc,
  write,
  warnings,
}: {
  doc: Document;
  write: Write;
  warnings: string[];
}) {
  const f = doc.fields;
  return (
    <>
      <section aria-label="Agent providers">
        <ScopeHeading
          label="Agents"
          hint={`${doc.systemPath || SYSTEM_CONFIG_FALLBACK_PATH} · machine-wide, outranks project files`}
        />
        <div className="divide-y divide-border/40">
          <ChipRow
            fieldKey={KEY_SESSION}
            label="Session agent"
            sublabel="What you talk to: fab agent, operator, batch"
            options={doc.providers}
            field={f[KEY_SESSION]}
            write={write}
          />
          <ChipRow
            fieldKey={KEY_WORKERS}
            label="Worker agent"
            sublabel="What pipeline stages dispatch to"
            options={doc.providers}
            field={f[KEY_WORKERS]}
            write={write}
          />
          <RoleTable doc={doc} write={write} />
        </div>
      </section>

      <section aria-label="Dispatch" className="mt-4">
        <ScopeHeading label="Dispatch" hint="how worker stages are launched" />
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
      </section>

      {warnings.length > 0 && (
        <div data-testid="fab-warnings" role="status" className="mt-3 text-[10px] text-signal-yellow space-y-0.5">
          {warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      )}

      <footer className="mt-4 pt-2 border-t border-border/40 text-[10px] text-text-secondary space-y-1">
        <p>The providers table and other list/map keys can&apos;t be set from the CLI.</p>
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

export function SettingsAgentsPanel() {
  const [doc, setDoc] = useState<FabConfigDocument | null>(null);
  const [loadError, setLoadError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);

  // Fetched on every mount — the panel only mounts while the tab is visible,
  // so each visit re-reads fab.
  useEffect(() => {
    let cancelled = false;
    getFabConfig()
      .then((d) => {
        if (!cancelled) setDoc(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Rejects on failure (the calling row shows the message); on success the
  // whole panel re-renders from the fresh document the POST returns.
  const write = useCallback<Write>(async (patch) => {
    setWarnings([]);
    const next = await postFabConfig(patch);
    setDoc(next);
    if (next.installed) setWarnings(next.warnings ?? []);
  }, []);

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
  return <AgentsContent doc={doc} write={write} warnings={warnings} />;
}
