import { useEffect, useMemo, useRef, useState } from "react";
import type { SettingsEntry } from "@/api/client";
import { SwatchPopover } from "@/components/swatch-popover";
import {
  INPUT_FOCUS,
  SWITCH_KNOB_OFF,
  SWITCH_KNOB_ON,
  SWITCH_TRACK_OFF,
  SWITCH_TRACK_ON,
} from "@/components/controls";
import { Tip } from "@/components/tip";
import { copyToClipboard } from "@/lib/clipboard";
import { THEMES, getThemeById } from "@/themes";
import {
  useTextSettingDraft,
  textSettingInputClass,
  TextSettingError,
  ScopeHeading,
} from "@/components/text-setting-core";
import type { SettingsRegistry } from "@/components/settings-registry-seam";
import { GuiWMPicker } from "@/components/gui-wm-picker";

/**
 * The All-settings tab — the registry-driven everything-table: rows generated
 * from GET /api/settings in registry order (only `ui: true` entries), grouped
 * under title-cased category headers on ScopeHeading's underlined rule, with
 * a substring search over key/description/category (the palette haystack
 * precedent) that hides emptied headers. The curated tabs and this table read
 * and write through the dialog's single SettingsRegistry seam — never a
 * second fetch.
 */

/** The fixed config-root path — displayable as a constant because Phase 1
 *  pinned the root (`~/.config/hexokit/`); no API resolves it. */
const CONFIG_YAML_PATH = "~/.config/hexokit/config.yaml";

function titleCase(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function mapEntries(value: unknown): [string, unknown][] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value);
}

function listNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/** Modified-from-default: `value` vs the registry `default` per kind — an
 *  unset scalar (null) compares as empty; maps/lists compare entry counts
 *  against the `{}`/`[]` text defaults. */
function isModified(entry: SettingsEntry): boolean {
  switch (entry.kind) {
    case "bool":
      return (entry.value === true) !== (entry.default === "true");
    case "map":
      return mapEntries(entry.value).length > 0 || entry.default !== "{}";
    case "list":
      return listNames(entry.value).length > 0 || entry.default !== "[]";
    default:
      return stringValue(entry.value) !== entry.default;
  }
}

/** The toggle control for `bool` kinds — commits immediately on flip. Also
 *  the curated General tab's Auto-name row control (one control, one seam). */
export function BoolToggle({ id, label, on, commit }: { id?: string; label: string; on: boolean; commit: (value: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError("");
          commit(!on)
            .catch((err: unknown) =>
              setError(err instanceof Error && err.message ? err.message : "Failed to save"),
            )
            .finally(() => setBusy(false));
        }}
        className={`relative w-8 h-[18px] rounded-full border transition-colors disabled:opacity-50 ${
          on ? SWITCH_TRACK_ON : SWITCH_TRACK_OFF
        }`}
      >
        <span
          aria-hidden="true"
          className={`absolute top-[2px] w-3 h-3 rounded-full transition-all ${
            on ? `left-[16px] ${SWITCH_KNOB_ON}` : `left-[2px] ${SWITCH_KNOB_OFF}`
          }`}
        />
      </button>
      <TextSettingError error={error} />
    </div>
  );
}

/** A closed-set select — used for `enum` kinds (over the entry's `options`)
 *  and the theme_dark/theme_light key overrides (over the client theme list,
 *  filtered to the slot's category so a pick can never land in the wrong
 *  slot). No empty option: every choice is a legal value. */
function ValueSelect({
  entry,
  value,
  options,
  commit,
}: {
  entry: SettingsEntry;
  value: string;
  options: { id: string; label: string }[];
  commit: (value: string | boolean | null) => Promise<void>;
}) {
  const [error, setError] = useState("");
  return (
    <div>
      <select
        id={`setting-${entry.key}`}
        aria-label={entry.key}
        value={value}
        onChange={(e) => {
          setError("");
          commit(e.target.value).catch((err: unknown) =>
            setError(err instanceof Error && err.message ? err.message : "Failed to save"),
          );
        }}
        className={`w-full max-w-[320px] bg-transparent text-text-primary p-2 border border-border rounded ${INPUT_FOCUS}`}
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <TextSettingError error={error} />
    </div>
  );
}

/** The TextSetting contract for `string`/`path` kinds, on the shared core
 *  (`text-setting-core.tsx`): Enter/blur commits, Escape cancels the edit
 *  only, a rejection renders inline (`role="alert"`) and the input keeps the
 *  typed value. Exported for the gui.wm picker's pre-resolution fallback. */
export function TextEntryControl({
  entry,
  value,
  commit,
}: {
  entry: SettingsEntry;
  value: string;
  commit: (trimmed: string) => Promise<void>;
}) {
  const { draft, error, handleCommit, onChange, onKeyDown } = useTextSettingDraft(value, commit);

  return (
    <div>
      <input
        id={`setting-${entry.key}`}
        type="text"
        value={draft}
        onChange={onChange}
        onBlur={handleCommit}
        onKeyDown={onKeyDown}
        placeholder={entry.default || "unset"}
        className={textSettingInputClass}
      />
      <TextSettingError error={error} />
    </div>
  );
}

/** The color kind: the descriptor-model SwatchPopover control (a pick writes
 *  through the seam — the accent-context route repaints the top-bar stripe
 *  optimistically; the popover's Clear row clears). */
function ColorEntryControl({
  entry,
  value,
  commit,
}: {
  entry: SettingsEntry;
  value: string;
  commit: (value: string | boolean | null) => Promise<void>;
}) {
  const [showPicker, setShowPicker] = useState(false);
  return (
    <div className="relative">
      <Tip label={`Set ${entry.key}`}>
        <button
          type="button"
          onClick={() => setShowPicker((v) => !v)}
          aria-label={`Set ${entry.key}`}
          aria-expanded={showPicker}
          className="px-2 py-1 border border-border rounded text-xs text-text-primary hover:border-text-secondary transition-colors"
        >
          {value ? value : "None — choose…"}
        </button>
      </Tip>
      {showPicker && (
        <div className="absolute left-0 top-full mt-1 z-50">
          <SwatchPopover
            selectedColor={value || undefined}
            // Selection does NOT close (the picker's dismissal contract).
            onSelect={(c) => void commit(c)}
            onClose={() => setShowPicker(false)}
          />
        </div>
      )}
    </div>
  );
}

/** map/list kinds are read-only here — their editing UX lives where the
 *  entities live (sidebar color/flair pickers, board sidebar reorder); the
 *  row summarizes the stored value and names that surface. */
function ReadOnlySummary({ entry }: { entry: SettingsEntry }) {
  let summary: string;
  let surface: string;
  if (entry.kind === "map") {
    const count = mapEntries(entry.value).length;
    summary = count === 0 ? "no entries" : `${count} ${count === 1 ? "entry" : "entries"}`;
    surface =
      entry.key === "server_flairs"
        ? "Edited from each server's flair picker in the sidebar"
        : "Edited from each server's color picker in the sidebar";
  } else {
    const names = listNames(entry.value);
    summary = names.length === 0 ? "default order" : names.join(" → ");
    surface = "Reorder boards from the board sidebar";
  }
  return (
    <div className="text-xs">
      <p className="text-text-primary">{summary}</p>
      <p className="text-[10px] text-text-secondary mt-0.5">
        {surface}, or edit config.yaml directly (see below).
      </p>
    </div>
  );
}

/** Kind → control resolution, with the named-key overrides. Discriminated on
 *  `kind` with guards — no casts. */
function EntryControl({ entry, registry }: { entry: SettingsEntry; registry: SettingsRegistry }) {
  const value = registry.settingValue(entry.key);
  const commit = (v: string | boolean | null) => registry.commitSetting(entry.key, v);

  // The desktop picker's named-key override (same precedent as theme_dark
  // below — no registry kind): the select + Other… reveal own the row.
  if (entry.key === "gui.wm") {
    return <GuiWMPicker entry={entry} value={stringValue(value)} commit={commit} />;
  }

  if (entry.key === "theme_dark" || entry.key === "theme_light") {
    const category = entry.key === "theme_dark" ? "dark" : "light";
    const options = THEMES.filter((t) => t.category === category).map((t) => ({
      id: t.id,
      label: t.name,
    }));
    const current = stringValue(value);
    // An out-of-list stored id can't be represented by the closed select;
    // fall back to the entry's registry default (always a valid theme id)
    // WITHOUT committing — the invalid stored value stays until the user
    // deliberately picks.
    const selected =
      getThemeById(current) && getThemeById(current)?.category === category
        ? current
        : entry.default;
    return <ValueSelect entry={entry} value={selected} options={options} commit={commit} />;
  }

  switch (entry.kind) {
    case "bool":
      return <BoolToggle id={`setting-${entry.key}`} label={entry.key} on={value === true} commit={commit} />;
    case "enum": {
      const options = (entry.options ?? []).map((o) => ({ id: o, label: o }));
      const current = stringValue(value);
      // An out-of-list effective value (e.g. theme holding a named theme id —
      // legal for the key) can't be represented by the closed select; fall
      // back to the entry's registry default WITHOUT committing.
      const selected = options.some((o) => o.id === current) ? current : entry.default;
      return <ValueSelect entry={entry} value={selected} options={options} commit={commit} />;
    }
    case "string":
    case "path":
      return <TextEntryControl entry={entry} value={stringValue(value)} commit={commit} />;
    case "color":
      return <ColorEntryControl entry={entry} value={stringValue(value)} commit={commit} />;
    default:
      // map, list, and any future non-scalar kind: read-only.
      return <ReadOnlySummary entry={entry} />;
  }
}

function RegistryRow({ entry, registry }: { entry: SettingsEntry; registry: SettingsRegistry }) {
  const modified = isModified(entry);
  return (
    <div
      data-testid={`setting-row-${entry.key}`}
      className="grid grid-cols-1 min-[480px]:grid-cols-[190px_1fr] gap-x-6 gap-y-1.5 py-2 items-start"
    >
      <div className="min-[480px]:pt-1 flex items-start gap-2">
        <span
          data-testid={`modified-${entry.key}`}
          className={`mt-1 w-1.5 h-1.5 rounded-full flex-none ${modified ? "bg-accent" : "bg-transparent"}`}
          title={modified ? "modified from default" : undefined}
        />
        <div className="min-w-0">
          <p className="text-xs text-text-primary">
            <label htmlFor={`setting-${entry.key}`}>{entry.key}</label>
            {!entry.live && (
              <span
                data-testid={`restart-badge-${entry.key}`}
                className="ml-2 px-1 py-px border border-border rounded text-[9px] uppercase tracking-wide text-text-secondary"
              >
                requires restart
              </span>
            )}
          </p>
          <p className="text-[10px] text-text-secondary mt-0.5 leading-relaxed">
            {entry.description}
          </p>
        </div>
      </div>
      <div className="min-w-0">
        <EntryControl entry={entry} registry={registry} />
      </div>
    </div>
  );
}

/** The escape-hatch footer: the constant config path, a copy button, and a
 *  hint that map/list keys and comments are edited there. */
function ConfigYamlFooter() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <div data-testid="settings-config-path-footer" className="mt-6 border-t border-border pt-3">
      <div className="flex items-center gap-2">
        <code className="text-xs text-text-primary">{CONFIG_YAML_PATH}</code>
        <Tip label="Copy config path">
          <button
            type="button"
            aria-label="Copy config path"
            onClick={() => {
              void copyToClipboard(CONFIG_YAML_PATH).then((ok) => {
                if (!ok) return;
                setCopied(true);
                if (timer.current) clearTimeout(timer.current);
                timer.current = setTimeout(() => setCopied(false), 1500);
              });
            }}
            className="px-2 py-1 border border-border rounded text-xs text-text-secondary hover:border-text-secondary hover:text-text-primary transition-colors"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </Tip>
      </div>
      <p className="text-[10px] text-text-secondary mt-1">
        Map/list keys and comments are edited directly in config.yaml.
      </p>
    </div>
  );
}

export function SettingsAllPanel({ registry }: { registry: SettingsRegistry }) {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const visible = registry.entries.filter((e) => {
      if (!e.ui) return false;
      if (!q) return true;
      return (
        e.key.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q)
      );
    });
    const out: { category: string; entries: SettingsEntry[] }[] = [];
    for (const e of visible) {
      const last = out[out.length - 1];
      if (last && last.category === e.category) last.entries.push(e);
      else out.push({ category: e.category, entries: [e] });
    }
    return out;
  }, [registry.entries, query]);

  return (
    <div data-testid="settings-all-panel">
      <input
        type="search"
        aria-label="Search settings"
        placeholder="Search settings"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className={`w-full max-w-[320px] bg-transparent text-text-primary p-2 mb-3 border border-border rounded ${INPUT_FOCUS} placeholder:text-text-secondary`}
      />
      {groups.length === 0 ? (
        <p className="text-xs text-text-secondary py-2">
          {registry.entries.length === 0 ? "Loading settings…" : `No settings match “${query}”`}
        </p>
      ) : (
        groups.map((g) => (
          // Key on group identity, not the category name: the same category
          // can recur in split groups when the search filter drops the rows
          // between two same-category runs.
          <section
            key={`${g.category}:${g.entries[0]?.key ?? ""}`}
            aria-label={`${titleCase(g.category)} settings`}
          >
            <ScopeHeading label={titleCase(g.category)} hint="" />
            <div className="divide-y divide-border/40">
              {g.entries.map((e) => (
                <RegistryRow key={e.key} entry={e} registry={registry} />
              ))}
            </div>
          </section>
        ))
      )}
      <ConfigYamlFooter />
    </div>
  );
}
