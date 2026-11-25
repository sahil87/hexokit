import { useEffect, useId, useRef, useState } from "react";
import type { FabModelSuggestion, FabRole, FabRoleCell } from "@/api/client";
import { TextSettingError, textSettingInputClass, useTextSettingDraft } from "@/components/text-setting-core";
import {
  ResetLink,
  roleSelectBase,
  stringValue,
  useRowWrite,
  type Document,
  type Patch,
  type Write,
} from "@/components/settings-agents-shared";

/**
 * The per-role table — role · tier · CLI · model · effort — with its model
 * lists, effort rules, tool-change behavior and stale-pin note. The table
 * writes whatever keys `RoleKeyOf` names, so one table edits either the loose
 * machine-wide `agent.profiles.<role>.*` leaves (a fab that cannot list
 * presets) or one preset's `agent_presets.<name>.profiles.<role>.*` leaves.
 */

const INHERIT_FALLBACK = "tool default";
const NO_EFFORT_TITLE = "this tool takes no effort setting";
const MODEL_TEXT_SEPARATOR = " · ";
const DEFAULT_MODEL_MARKER = "tool default";
// Above this many suggestions (kimi lists hundreds) the model cell is a
// searchable list instead of a native select.
const SEARCHABLE_MODEL_THRESHOLD = 30;

type RoleLeaf = "tool" | "model" | "effort";

/** The config key a role's leaf is written under. The tool leaf is neutral: the
 *  backend writes it in the installed fab's spelling for the machine-wide keys,
 *  and a preset spells it `cli`. */
export type RoleKeyOf = (role: string, leaf: RoleLeaf) => string;

export const machineRoleKey: RoleKeyOf = (role, leaf) => `agent.profiles.${role}.${leaf}`;

export function presetRoleKey(preset: string): RoleKeyOf {
  return (role, leaf) => `agent_presets.${preset}.profiles.${role}.${leaf === "tool" ? "cli" : leaf}`;
}

const roleSelectClass = `${roleSelectBase} max-w-[9rem]`;
const modelSelectClass = `${roleSelectBase} max-w-[12rem]`;

/** Whether a model value is the tool's reserved "use the tool's own default"
 *  value. Only fab names it, so a tool without one recognises nothing. */
function isToolDefault(value: string, toolDefault: FabModelSuggestion | undefined): boolean {
  return toolDefault !== undefined && value === toolDefault.id;
}

/** What a leaf's inherit option stands for — what is in effect now, or while
 *  an override is set, what clearing it would restore. A model leaf's reserved
 *  tool-default value reads like an empty one: the tool's own default applies. */
function inheritedValue(cell: FabRoleCell, toolDefault?: FabModelSuggestion): string {
  const value = cell.override === null ? cell.effective : cell.inherited;
  return isToolDefault(value, toolDefault) ? INHERIT_FALLBACK : value || INHERIT_FALLBACK;
}

function inheritedLabel(cell: FabRoleCell, toolDefault?: FabModelSuggestion): string {
  return `↳ ${inheritedValue(cell, toolDefault)}`;
}

/** A closed-set select whose first option is "inherit" (→ null). */
export function RoleSelect({
  label,
  cell,
  options,
  disabled,
  title,
  onChange,
}: {
  label: string;
  cell: FabRoleCell;
  options: string[];
  disabled: boolean;
  title?: string;
  onChange: (value: string | null) => void;
}) {
  const withOverride = cell.override !== null && !options.includes(cell.override) ? [...options, cell.override] : options;
  return (
    <select
      aria-label={label}
      value={cell.override ?? ""}
      disabled={disabled}
      title={title}
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

// The model list's sentinel values. Inherit is "" (an empty model is never a
// pin — the daemon treats it as unset); custom carries a NUL, which no model
// id can, so neither collides with a real model.
const MODEL_INHERIT = "";
const MODEL_CUSTOM = "\u0000custom";
const CUSTOM_LABEL = "Custom…";
// Claude Code accepts any full model id, so an unlisted claude pin is stale
// (it stops tracking newer models), not invalid.
const CLAUDE_TOOL = "claude";

/** The model list in its fixed order — inherit, the tool's own default, the
 *  tool's suggestions, the saved override when the tool doesn't offer it, then
 *  free text. Renderers map over this, so the order and what each kind commits
 *  stay put when the control changes shape. A suggestion's `value` is its id,
 *  `name` its display name, and `label` the one-line text a native option
 *  shows. */
type ModelOption =
  | { kind: "inherit"; value: typeof MODEL_INHERIT; label: string }
  | { kind: "toolDefault"; value: string; label: string }
  | { kind: "suggestion"; value: string; name: string; label: string; isDefault: boolean }
  | { kind: "stale"; value: string; label: string }
  | { kind: "custom"; value: typeof MODEL_CUSTOM; label: string };

function suggestionOption(s: FabModelSuggestion): ModelOption {
  const name = s.label || s.id;
  const isDefault = s.default === true;
  const text = name === s.id ? s.id : `${name}${MODEL_TEXT_SEPARATOR}${s.id}`;
  return {
    kind: "suggestion",
    value: s.id,
    name,
    label: isDefault ? `${text}${MODEL_TEXT_SEPARATOR}${DEFAULT_MODEL_MARKER}` : text,
    isDefault,
  };
}

function offersModel(suggestions: FabModelSuggestion[], id: string): boolean {
  return suggestions.some((s) => s.id === id);
}

function modelOptions(
  cell: FabRoleCell,
  suggestions: FabModelSuggestion[],
  toolDefault: FabModelSuggestion | undefined,
): ModelOption[] {
  const options: ModelOption[] = [
    { kind: "inherit", value: MODEL_INHERIT, label: `↳ inherit (${inheritedValue(cell, toolDefault)})` },
  ];
  if (toolDefault) {
    options.push({ kind: "toolDefault", value: toolDefault.id, label: `↳ ${toolDefault.label || toolDefault.id}` });
  }
  options.push(...suggestions.map(suggestionOption));
  if (cell.override !== null && !offersModel(suggestions, cell.override) && !isToolDefault(cell.override, toolDefault)) {
    // An empty list says nothing about what the tool offers.
    const label = suggestions.length > 0 ? `${cell.override} (not offered)` : cell.override;
    options.push({ kind: "stale", value: cell.override, label });
  }
  options.push({ kind: "custom", value: MODEL_CUSTOM, label: CUSTOM_LABEL });
  return options;
}

/** A pin the tool doesn't offer: the override is not an id in the list fab
 *  discovered for the role's tool (the kit's fills when discovery is
 *  unavailable), nor the tool's reserved default value. An empty list flags
 *  nothing. */
function isStalePin(
  cell: FabRoleCell,
  suggestions: FabModelSuggestion[],
  toolDefault: FabModelSuggestion | undefined,
): boolean {
  return (
    cell.override !== null &&
    suggestions.length > 0 &&
    !offersModel(suggestions, cell.override) &&
    !isToolDefault(cell.override, toolDefault)
  );
}

/** The closed searchable control's text: a suggestion's display name, else the
 *  option's own label. */
function optionName(o: ModelOption): string {
  return o.kind === "suggestion" ? o.name : o.label;
}

/** Whether an option survives the filter. Inherit, the tool default and
 *  Custom… always do — they are the commit paths a filter must never strand. */
function matchesModelFilter(o: ModelOption, query: string): boolean {
  if (o.kind === "inherit" || o.kind === "toolDefault" || o.kind === "custom") return true;
  const q = query.trim().toLowerCase();
  return o.value.toLowerCase().includes(q) || optionName(o).toLowerCase().includes(q);
}

/** Free-text model entry: Enter/blur commit (blank unsets), and the cell goes
 *  back to the list on a successful commit, an unchanged draft, or Escape. A
 *  failed commit keeps the draft and shows fab's message. */
function CustomModelInput({
  role,
  cell,
  toolDefault,
  commit,
  onDone,
}: {
  role: string;
  cell: FabRoleCell;
  toolDefault: FabModelSuggestion | undefined;
  commit: (value: string | null) => Promise<void>;
  onDone: () => void;
}) {
  const value = cell.override ?? "";
  const inputRef = useRef<HTMLInputElement>(null);
  // Unmounting a focused input can fire blur; once leaving, that blur must not
  // commit the discarded draft.
  const leaving = useRef(false);
  const leave = () => {
    leaving.current = true;
    onDone();
  };
  const { draft, error, handleCommit, onChange } = useTextSettingDraft(value, async (trimmed) => {
    await commit(trimmed === "" ? null : trimmed);
    leave();
  });
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const finish = () => {
    if (leaving.current) return;
    if (draft.trim() === value.trim()) leave();
    else handleCommit();
  };
  return (
    <span className="inline-flex flex-col">
      <input
        ref={inputRef}
        type="text"
        aria-label={`${role} model`}
        value={draft}
        placeholder={inheritedLabel(cell, toolDefault)}
        onChange={onChange}
        onBlur={finish}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            finish();
          } else if (e.key === "Escape") {
            // Back to the list, not out of the dialog.
            e.stopPropagation();
            leave();
          }
        }}
        className={`${textSettingInputClass} max-w-[12rem] p-1 text-xs`}
      />
      <TextSettingError error={error} />
    </span>
  );
}

/** The over-threshold model list: a trigger that opens a filter field above the
 *  same options the native select lists. It opens unfiltered whatever is saved
 *  (a pre-filled filter would hide the rest of the list), and renders inline
 *  rather than as a popover so the table's scroll wrapper cannot clip it. */
function SearchableModelList({
  role,
  cell,
  options,
  busy,
  onChoose,
}: {
  role: string;
  cell: FabRoleCell;
  options: ModelOption[];
  busy: boolean;
  onChoose: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const refocusTrigger = useRef(false);
  const listId = useId();

  const current = options.find((o) => o.value === (cell.override ?? MODEL_INHERIT));
  const visible = options.filter((o) => matchesModelFilter(o, query));
  const optionId = (i: number) => `${listId}-option-${i}`;

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else if (refocusTrigger.current) {
      refocusTrigger.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector('[aria-selected="true"]');
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const openList = () => {
    setQuery("");
    setActive(Math.max(0, options.indexOf(current ?? options[0])));
    setOpen(true);
  };
  const closeList = (refocus: boolean) => {
    refocusTrigger.current = refocus;
    setOpen(false);
  };
  const choose = (o: ModelOption | undefined) => {
    if (!o) return;
    closeList(true);
    onChoose(o.value);
  };
  const changeQuery = (value: string) => {
    setQuery(value);
    // Enter after typing should land on a match, not on the always-present inherit.
    const next = options.filter((o) => matchesModelFilter(o, value));
    setActive(Math.max(0, next.findIndex((o) => o.kind === "suggestion" || o.kind === "stale")));
  };

  if (!open) {
    return (
      <button
        ref={triggerRef}
        type="button"
        aria-label={`${role} model`}
        aria-haspopup="listbox"
        aria-expanded={false}
        disabled={busy}
        onClick={openList}
        className={`${modelSelectClass} inline-flex items-center gap-1 text-left disabled:opacity-40 ${
          cell.override === null ? "text-text-secondary" : ""
        }`}
      >
        <span className="flex-1 min-w-0 truncate">{current ? optionName(current) : (cell.override ?? "")}</span>
        <span aria-hidden="true">▾</span>
      </button>
    );
  }
  return (
    <div
      className="flex flex-col max-w-[16rem]"
      onBlur={(e) => {
        if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) closeList(false);
      }}
    >
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label={`Search ${role} models`}
        aria-autocomplete="list"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={visible.length > 0 ? optionId(Math.min(active, visible.length - 1)) : undefined}
        value={query}
        onChange={(e) => changeQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            // Close the list, not the dialog.
            e.preventDefault();
            e.stopPropagation();
            closeList(true);
          } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (visible.length === 0) return;
            const step = e.key === "ArrowDown" ? 1 : -1;
            setActive((i) => (Math.min(i, visible.length - 1) + step + visible.length) % visible.length);
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(visible[Math.min(active, visible.length - 1)]);
          }
        }}
        placeholder="Search models…"
        className={`${textSettingInputClass} p-1 text-xs`}
      />
      <div
        id={listId}
        ref={listRef}
        role="listbox"
        aria-label={`${role} models`}
        // Keep focus in the filter while clicking, or the blur would close the
        // list before the click lands.
        onMouseDown={(e) => e.preventDefault()}
        className="max-h-48 overflow-y-auto border border-border rounded mt-1 py-0.5"
      >
        {visible.map((o, i) => (
          <div
            key={`${o.kind}:${o.value}`}
            id={optionId(i)}
            role="option"
            aria-selected={i === Math.min(active, visible.length - 1)}
            onClick={() => choose(o)}
            onMouseEnter={() => setActive(i)}
            className={`px-1.5 py-1 text-xs cursor-pointer flex items-baseline gap-1.5 ${
              i === Math.min(active, visible.length - 1) ? "bg-bg-card text-text-primary" : "text-text-secondary"
            }`}
          >
            <span className="truncate">{optionName(o)}</span>
            {o.kind === "suggestion" && o.name !== o.value && (
              <span className="text-[10px] text-text-secondary/70 truncate">{o.value}</span>
            )}
            {o.kind === "suggestion" && o.isDefault && (
              <span className="text-[10px] text-text-secondary/70 flex-none">{DEFAULT_MODEL_MARKER}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function RoleModelCell({
  role,
  cell,
  suggestions,
  toolDefault,
  busy,
  pick,
  commit,
}: {
  role: string;
  cell: FabRoleCell;
  suggestions: FabModelSuggestion[];
  toolDefault: FabModelSuggestion | undefined;
  busy: boolean;
  /** List pick — goes through the row's write state. */
  pick: (value: string | null) => void;
  /** Free-text commit — rejects so the input keeps the draft and the error. */
  commit: (value: string | null) => Promise<void>;
}) {
  const [custom, setCustom] = useState(false);
  if (custom) {
    return (
      <CustomModelInput
        role={role}
        cell={cell}
        toolDefault={toolDefault}
        commit={commit}
        onDone={() => setCustom(false)}
      />
    );
  }
  const options = modelOptions(cell, suggestions, toolDefault);
  const choose = (v: string) => {
    if (v === MODEL_CUSTOM) setCustom(true);
    else pick(v === MODEL_INHERIT ? null : v);
  };
  if (suggestions.length > SEARCHABLE_MODEL_THRESHOLD) {
    return <SearchableModelList role={role} cell={cell} options={options} busy={busy} onChoose={choose} />;
  }
  // A native select lists every option whatever is selected — unlike a
  // datalist, which filters by the input's saved text.
  return (
    <select
      aria-label={`${role} model`}
      value={cell.override ?? MODEL_INHERIT}
      disabled={busy}
      onChange={(e) => choose(e.target.value)}
      className={`${modelSelectClass} ${cell.override === null ? "text-text-secondary" : ""}`}
    >
      {options.map((o) => (
        <option key={`${o.kind}:${o.value}`} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** A pin the role's tool doesn't offer (per the list fab discovered, not the
 *  kit's fills), with a one-click way back to inheriting. */
function StaleModelNote({
  role,
  tool,
  cell,
  toolDefault,
  busy,
  onInherit,
}: {
  role: string;
  tool: string;
  cell: FabRoleCell;
  toolDefault: FabModelSuggestion | undefined;
  busy: boolean;
  onInherit: () => void;
}) {
  const inherited = inheritedValue(cell, toolDefault);
  const action = (
    <button
      type="button"
      aria-label={`Inherit ${inherited} for ${role} model`}
      disabled={busy}
      onClick={onInherit}
      className="text-accent hover:underline disabled:opacity-40"
    >
      inherit <code>{inherited}</code>
    </button>
  );
  return (
    <p data-testid={`stale-model-${role}`} className="text-[10px] text-signal-yellow leading-relaxed">
      pinned to <code>{cell.override}</code>
      {tool === CLAUDE_TOOL ? (
        <>, not in the list — {action} to track the latest</>
      ) : (
        <>
          , which <code>{tool}</code> doesn&apos;t offer — {action} instead?
        </>
      )}
    </p>
  );
}

/** Whether a tool's command carries {effort}. A tool the daemon didn't
 *  classify counts as capable, so missing data never locks the select. */
function takesEffort(effortCapable: Record<string, boolean> | undefined, tool: string): boolean {
  return effortCapable?.[tool] !== false;
}

/** The efforts a tool's models take: the union across its suggestions in
 *  first-seen order. Empty when no suggestion reports any. */
function toolEfforts(suggestions: FabModelSuggestion[]): string[] {
  return [...new Set(suggestions.flatMap((s) => s.efforts ?? []))];
}

/** A row's effort options: the effective model's own efforts when known (the
 *  tool's default model when none is set or the tool default is), else the
 *  tool's set, else the global list. */
function modelEfforts(
  role: FabRole,
  suggestions: FabModelSuggestion[],
  toolDefault: FabModelSuggestion | undefined,
  fallback: string[],
): string[] {
  const effective = role.model.effective;
  const usesToolDefault = effective === "" || isToolDefault(effective, toolDefault);
  if (usesToolDefault && toolDefault?.efforts && toolDefault.efforts.length > 0) return toolDefault.efforts;
  const model = usesToolDefault
    ? suggestions.find((s) => s.default === true)
    : suggestions.find((s) => s.id === effective);
  if (model?.efforts && model.efforts.length > 0) return model.efforts;
  const tool = toolEfforts(suggestions);
  return tool.length > 0 ? tool : fallback;
}

/** One POST for a tool change: a model or effort override the new tool doesn't
 *  offer is unset with it, so no cross-tool pair (`claude --model gpt-…`) is
 *  ever left behind. A write that keeps the same effective tool touches only
 *  the tool key — the overrides were already chosen for that tool. */
export function toolChangePatch(
  role: FabRole,
  next: string | null,
  depthTool: string,
  modelSuggestions: Record<string, FabModelSuggestion[]>,
  toolDefaults: Record<string, FabModelSuggestion> | undefined,
  fallbackEfforts: string[],
  effortCapable: Record<string, boolean> | undefined,
  keyOf: RoleKeyOf,
): Patch {
  const patch: Patch = { [keyOf(role.role, "tool")]: next };
  const nextTool = next ?? depthTool;
  if (nextTool === role.tool.effective) return patch;
  const suggestions = modelSuggestions[nextTool] ?? [];
  const toolDefault = toolDefaults?.[nextTool];
  const model = role.model.override;
  if (model === null || !(offersModel(suggestions, model) || isToolDefault(model, toolDefault))) {
    patch[keyOf(role.role, "model")] = null;
  }
  const nextEfforts = [...new Set([...toolEfforts(suggestions), ...(toolDefault?.efforts ?? [])])];
  const efforts = nextEfforts.length > 0 ? nextEfforts : fallbackEfforts;
  const effort = role.effort.override;
  if (effort === null || !efforts.includes(effort) || !takesEffort(effortCapable, nextTool)) {
    patch[keyOf(role.role, "effort")] = null;
  }
  return patch;
}

function RoleRow({
  role,
  tools,
  depthTool,
  modelSuggestions,
  toolDefaults,
  efforts,
  effortCapable,
  write,
  keyOf,
  readOnly,
}: {
  role: FabRole;
  tools: string[];
  /** The depth knob's tool — what the row resolves to with no tool override. */
  depthTool: string;
  modelSuggestions: Record<string, FabModelSuggestion[]>;
  toolDefaults: Record<string, FabModelSuggestion> | undefined;
  efforts: string[];
  effortCapable: Record<string, boolean> | undefined;
  write: Write;
  keyOf: RoleKeyOf;
  /** Every control disabled, no reset link: a built-in preset. */
  readOnly: boolean;
}) {
  const { error, run, busy: writing } = useRowWrite(write);
  const busy = writing || readOnly;
  const suggestions = modelSuggestions[role.tool.effective] ?? [];
  const toolDefault = toolDefaults?.[role.tool.effective];
  const effortOK = takesEffort(effortCapable, role.tool.effective);
  const inheritModel = () => void run({ [keyOf(role.role, "model")]: null });
  // A saved value shadowed by an env var still counts: reset is the only way
  // to clear it from here.
  const overridden = [role.tool, role.model, role.effort].some(
    (cell) => cell.override !== null || cell.systemValue !== undefined,
  );
  return (
    <>
      <tr data-testid={`role-row-${role.role}`} className="border-b border-border/40 align-top">
        <td className="py-1.5 pr-2 text-text-primary">{role.role}</td>
        <td className="py-1.5 pr-2 text-text-secondary">{role.depth}</td>
        <td className="py-1.5 pr-2">
          <span className="inline-flex items-center gap-1">
            <RoleSelect
              label={`${role.role} CLI`}
              cell={role.tool}
              options={tools}
              disabled={busy}
              onChange={(v) => void run(toolChangePatch(role, v, depthTool, modelSuggestions, toolDefaults, efforts, effortCapable, keyOf))}
            />
            {role.tool.origin === "env" && (
              <span
                role="img"
                aria-label="CLI set by an environment variable"
                title={`${role.tool.originDetail ?? "An environment variable"} sets this CLI — changes here won't take effect until it is unset`}
                className="text-signal-yellow"
              >
                ⚠
              </span>
            )}
          </span>
        </td>
        <td className="py-1.5 pr-2">
          <span className="inline-flex items-center gap-1">
            <RoleModelCell
              role={role.role}
              cell={role.model}
              suggestions={suggestions}
              toolDefault={toolDefault}
              busy={busy}
              pick={(v) => void run({ [keyOf(role.role, "model")]: v })}
              commit={(v) => write({ [keyOf(role.role, "model")]: v })}
            />
          </span>
        </td>
        <td className="py-1.5 pr-2">
          <span className="inline-flex items-center gap-1">
            <RoleSelect
              label={`${role.role} effort`}
              cell={role.effort}
              options={modelEfforts(role, suggestions, toolDefault, efforts)}
              disabled={busy || !effortOK}
              title={effortOK ? undefined : NO_EFFORT_TITLE}
              onChange={(v) => void run({ [keyOf(role.role, "effort")]: v })}
            />
          </span>
        </td>
        <td className="py-1.5">
          {overridden && !readOnly && (
            <ResetLink
              label={`Reset ${role.role} overrides`}
              busy={busy}
              onReset={() =>
                void run({
                  [keyOf(role.role, "tool")]: null,
                  [keyOf(role.role, "model")]: null,
                  [keyOf(role.role, "effort")]: null,
                })
              }
            />
          )}
        </td>
      </tr>
      {isStalePin(role.model, suggestions, toolDefault) && (
        <tr>
          <td colSpan={6} className="pb-1.5">
            <StaleModelNote
              role={role.role}
              tool={role.tool.effective}
              cell={role.model}
              toolDefault={toolDefault}
              busy={busy}
              onInherit={inheritModel}
            />
          </td>
        </tr>
      )}
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

export function RoleTable({
  doc,
  roles,
  write,
  keyOf,
  readOnly = false,
  title,
  hint,
}: {
  doc: Document;
  roles: FabRole[];
  write: Write;
  keyOf: RoleKeyOf;
  readOnly?: boolean;
  title: string;
  hint: React.ReactNode;
}) {
  return (
    <div className="py-2.5">
      <p className="text-xs text-text-primary">{title}</p>
      <p className="text-[10px] text-text-secondary mt-0.5 mb-1.5">{hint}</p>
      {/* The wrapper owns horizontal scroll so the table never widens the page. */}
      <div className="overflow-x-auto" data-testid="role-table-wrap">
        <table className="min-w-[620px] w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-text-secondary border-b border-border">
              <th className="py-1 pr-2 font-medium">Role</th>
              <th className="py-1 pr-2 font-medium">Tier</th>
              <th className="py-1 pr-2 font-medium">CLI</th>
              <th className="py-1 pr-2 font-medium">Model</th>
              <th className="py-1 pr-2 font-medium">Effort</th>
              <th className="py-1 font-medium">
                <span className="sr-only">Reset</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {roles.map((role) => (
              <RoleRow
                key={role.role}
                role={role}
                tools={doc.tools}
                depthTool={role.tool.inherited || stringValue(doc.fields[`agent.${role.depth}`])}
                modelSuggestions={doc.modelSuggestions}
                toolDefaults={doc.toolDefaults}
                efforts={doc.effortSuggestions}
                effortCapable={doc.effortCapable}
                write={write}
                keyOf={keyOf}
                readOnly={readOnly}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
