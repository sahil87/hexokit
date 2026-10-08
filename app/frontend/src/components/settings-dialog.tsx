import { useState, useEffect, useMemo, useRef } from "react";
import { useMatches } from "@tanstack/react-router";
import { Dialog } from "@/components/dialog";
import { Tip, TipGroup } from "@/components/tip";
import { SwatchPopover } from "@/components/swatch-popover";
import {
  SettingsShortcutsPanel,
  type MacroPaletteTarget,
} from "@/components/settings-shortcuts-panel";
import { useSettingsDialog, type SettingsTab } from "@/contexts/settings-dialog-context";
import { useGuiOffRequest } from "@/contexts/gui-off-context";
import { useInstanceName } from "@/contexts/instance-name-context";
import { useInstanceAccent } from "@/contexts/instance-accent-context";
import { useSessionContext } from "@/contexts/session-context";
import { usePaletteActions } from "@/contexts/palette-actions-context";
import { useChromeState, useChromeDispatch, TERMINAL_FONT_BOUNDS } from "@/contexts/chrome-context";
import { useTheme, useThemeActions } from "@/contexts/theme-context";
import { usePushSubscription } from "@/hooks/use-push-subscription";
import { NOTIFICATIONS_HELP_URL } from "@/components/global-chrome";
import { ThemePickerList } from "@/components/theme-picker-list";
import { getRiffPresets } from "@/api/client";
import {
  QUAKE_OPACITY_MAX,
  QUAKE_OPACITY_MIN,
  useQuakeOpacity,
} from "@/lib/quake-terminal";
import { isMacroActionId } from "@/lib/macros";
import { isShell } from "@/lib/shell";
import { useSettingsRegistry, type SettingsRegistry } from "@/components/settings-registry-seam";
import { SettingsAllPanel, BoolToggle, CopyValueButton } from "@/components/settings-all-panel";
import { mcpEndpointUrl } from "@/lib/mcp-endpoint";
import { controlClass } from "@/components/control";
import {
  useTextSettingDraft,
  textSettingInputClass,
  TextSettingError,
  ScopeHeading,
} from "@/components/text-setting-core";

/**
 * VS Code-style settings dialog (260723-o7q8; desktop preference-pane layout
 * 260724-6j1v; TABBED in 260818-bncw), rendered ONCE in `AppLayout` so it
 * exists on every page — server routes, terminals, boards, and the host page.
 *
 * Three topic tabs — **General** (instance name, SSH host, MCP endpoint, notifications),
 * **Appearance** (theme pair, accent color, terminal font size), **Shortcuts**
 * (the ported shortcuts-overlay body, `SettingsShortcutsPanel`) — each keeping
 * the persistence-scope `ScopeHeading` groups inside the tab (both General and
 * Appearance mix This host / This device). The tab list is ONE
 * `role="tablist"` markup with roving-tabindex arrow-key nav: a vertical left
 * rail at ≥480px, a horizontal scrollable strip under the title below (the
 * `min-[480px]:` variant — ONE code path, no mobile fork). The dialog rides
 * the fixed-height `size="xl"` Dialog variant so the rail never jumps between
 * the short General tab and the tall Shortcuts tab; each tab panel owns its
 * own internal scroll.
 *
 * Controls REUSE the existing models rather than rebuilding them: the accent
 * picker is the HOST-panel `SwatchPopover` + descriptor model, the theme pair
 * drives the existing `setTheme()` wiring, the font stepper is the shared
 * `ChromeContext` control, and the Notifications block is
 * `usePushSubscription`. Open/close/tab state lives in
 * `SettingsDialogContext` (`openSettings(tab?)` deep-links — the
 * `settings-open` chord lands General, the `shortcuts-overlay` chord toggles
 * the Shortcuts tab).
 */

/** Scope heading — a full-width underlined rule: uppercase scope name left,
 *  storage hint right-aligned on the same line (6j1v). The definition lives in
 *  `text-setting-core.tsx` (shared with the All-settings panel); re-exported
 *  here for the dialog's historical import sites. */
export { ScopeHeading } from "@/components/text-setting-core";

/**
 * One preference row (6j1v): label column left (label + optional small
 * sublabel hint underneath), control column right. `min-[480px]:` gates the
 * two-column grid — below it the row stacks label-above-control (today's
 * phone layout) from the same markup. `htmlFor` renders the label as a real
 * `<label>` bound to the row's input; rows whose control has its own labeled
 * elements (theme selects, steppers) pass none.
 */
function PreferenceRow({
  label,
  sublabel,
  htmlFor,
  children,
}: {
  label: string;
  sublabel?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 min-[480px]:grid-cols-[190px_1fr] gap-x-6 gap-y-1.5 py-2.5 items-start">
      <div className="min-[480px]:pt-1">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="block text-xs text-text-primary">
            {label}
          </label>
        ) : (
          <p className="text-xs text-text-primary">{label}</p>
        )}
        {sublabel && (
          <p className="text-[10px] text-text-secondary mt-0.5 leading-relaxed">{sublabel}</p>
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * A labeled text setting committed on Enter/blur (the window-rename
 * vocabulary: Enter/blur commit, Escape cancels the edit without closing the
 * dialog). `commit` receives the trimmed value ("" = clear) and may reject —
 * the rejection message renders inline and the input keeps the typed value.
 * The former below-input hint is the row's SUBLABEL now (6j1v).
 */
function TextSetting({
  id,
  label,
  value,
  placeholder,
  hint,
  commit,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  hint?: string;
  commit: (trimmed: string) => Promise<void>;
}) {
  const { draft, error, handleCommit, onChange, onKeyDown } = useTextSettingDraft(value, commit);

  return (
    <PreferenceRow label={label} sublabel={hint} htmlFor={id}>
      <input
        id={id}
        type="text"
        value={draft}
        onChange={onChange}
        onBlur={handleCommit}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className={textSettingInputClass}
      />
      <TextSettingError error={error} />
    </PreferenceRow>
  );
}

/** Theme surface: mode buttons + the shared searchable picker rendered inline
 *  (the same `ThemePickerList` core the top-bar modal uses), all driving the
 *  existing `setTheme()` wiring. Both preferred slots stay visible at once —
 *  the DARK group checks `themeDark`, the LIGHT group checks `themeLight`. */
function ThemePairControl() {
  const { preference, resolved, theme, themeDark, themeLight } = useTheme();
  const { setTheme } = useThemeActions();
  const mode = preference === "system" ? "system" : resolved;

  const modeButton = (m: "system" | "light" | "dark", label: string, onPick: () => void) => (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={mode === m}
      className={controlClass({
        variant: "toggle",
        base: "px-2 py-1 border rounded text-xs transition-colors",
        pressed: mode === m,
      })}
    >
      {label}
    </button>
  );

  return (
    <PreferenceRow label="Theme" sublabel="Mode plus the theme each mode resolves to">
      <div className="flex gap-1.5 mb-2" role="group" aria-label="Theme mode">
        {modeButton("system", "System", () => setTheme("system"))}
        {modeButton("light", "Light", () => setTheme(themeLight))}
        {modeButton("dark", "Dark", () => setTheme(themeDark))}
      </div>
      <div className="max-w-[420px]">
        <ThemePickerList
          checkedIds={[themeDark, themeLight]}
          initialSelectedId={theme.id}
          onConfirm={(t) => setTheme(t.id)}
          // Eat the Escape only when it just reverted a preview or closed the
          // list — an idle Escape must still bubble to the dialog's focus
          // trap and close it.
          onEscape={(e, consumed) => {
            if (consumed) e.stopPropagation();
          }}
          cancelOnLeave
          collapsible
        />
      </div>
    </PreferenceRow>
  );
}

/** Instance accent color: the HOST-panel picker's descriptor model on a
 *  dialog-local anchor. Color-only `SwatchPopover` (its Clear row clears). */
function AccentColorControl() {
  const { color, isExplicit, stripeHex, setColor } = useInstanceAccent();
  const [showPicker, setShowPicker] = useState(false);

  return (
    <PreferenceRow label="Accent color">
      <div className="relative">
        <Tip label="Set instance color">
          <button
            type="button"
            onClick={() => setShowPicker((v) => !v)}
            aria-label="Set instance color"
            aria-expanded={showPicker}
            className="flex items-center gap-2 px-2 py-1 border border-border rounded text-xs text-text-primary hover:border-text-secondary transition-colors"
          >
            <span
              aria-hidden="true"
              className="inline-block w-3.5 h-3.5 rounded-sm border border-border"
              style={stripeHex ? { backgroundColor: stripeHex } : undefined}
            />
            {stripeHex ? "Change…" : "None — choose…"}
          </button>
        </Tip>
        {showPicker && (
          <div className="absolute left-0 top-full mt-1 z-50">
            <SwatchPopover
              selectedColor={isExplicit && color != null ? color : undefined}
              // Selection does NOT close (the picker's dismissal contract).
              onSelect={(c) => setColor(c)}
              onClose={() => setShowPicker(false)}
            />
          </div>
        )}
      </div>
    </PreferenceRow>
  );
}

/** Quake terminal opacity: the desktop drawer's glass background. A
 *  per-viewer localStorage resident like the terminal font — NOT a registry
 *  key (the registry is per-instance daemon config; glass is per-eye). The
 *  slider honors the 0.5–1.0 clamp; 100% disables the backdrop blur
 *  entirely. The open quake terminal reflects changes live via the store's pub/sub. */
function QuakeOpacityControl() {
  const [opacity, setOpacity] = useQuakeOpacity();
  return (
    <PreferenceRow
      label="Quake terminal opacity"
      sublabel="Desktop quake terminal background; 100% turns off the blur"
      htmlFor="settings-quake-opacity"
    >
      <div className="flex items-center gap-2">
        <input
          id="settings-quake-opacity"
          type="range"
          min={QUAKE_OPACITY_MIN}
          max={QUAKE_OPACITY_MAX}
          step={0.05}
          value={opacity}
          onChange={(e) => setOpacity(Number(e.target.value))}
          className="w-40 accent-accent-green"
        />
        <span className="text-xs text-text-primary min-w-[4ch] text-center" aria-live="polite">
          {Math.round(opacity * 100)}%
        </span>
      </div>
    </PreferenceRow>
  );
}

/** Terminal font size: the shared ChromeContext stepper (This device). */
function TerminalFontControl() {
  const { terminalFontSize } = useChromeState();
  const { increaseTerminalFont, decreaseTerminalFont, resetTerminalFont } = useChromeDispatch();
  const stepBtn =
    "min-w-[24px] min-h-[24px] coarse:min-w-[30px] coarse:min-h-[30px] border border-border rounded text-text-secondary hover:border-text-secondary hover:text-text-primary transition-colors flex items-center justify-center";

  return (
    <PreferenceRow
      label="Terminal font size"
      sublabel={`${TERMINAL_FONT_BOUNDS.min}–${TERMINAL_FONT_BOUNDS.max}px, stored in this browser only`}
    >
      <div className="flex items-center gap-1.5">
        <Tip label="Decrease terminal font">
          <button
            type="button"
            onClick={decreaseTerminalFont}
            aria-label="Decrease terminal font"
            className={stepBtn}
          >
            −
          </button>
        </Tip>
        <span className="text-xs text-text-primary min-w-[4ch] text-center" aria-live="polite">
          {terminalFontSize}px
        </span>
        <Tip label="Increase terminal font">
          <button
            type="button"
            onClick={increaseTerminalFont}
            aria-label="Increase terminal font"
            className={stepBtn}
          >
            +
          </button>
        </Tip>
        <button
          type="button"
          onClick={resetTerminalFont}
          className="ml-2 px-2 py-1 border border-border rounded text-xs text-text-secondary hover:border-text-secondary hover:text-text-primary transition-colors"
        >
          Reset
        </button>
      </div>
    </PreferenceRow>
  );
}

/**
 * Notifications row (260724-6j1v — moved here from the retired top-bar bell).
 * Maps 1:1 from the bell popover's `usePushSubscription` model: subscription
 * status line, Enable action, subscribed-gated test send, the denied re-allow
 * note, and the setup-guide link. Unlike the bell (which rendered NOTHING
 * where push can't work), a settings pane explains absence: the unsupported
 * state keeps the row with a "Not supported in this browser" note.
 */
function NotificationsControl() {
  const { state, enable, sendTest } = usePushSubscription();
  const shell = isShell();
  const subscribed = state === "subscribed";
  const denied = state === "denied";

  const actionBtn =
    "px-2 py-1 border border-border rounded text-xs text-text-secondary hover:border-text-secondary hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-border disabled:hover:text-text-secondary";

  return (
    <PreferenceRow
      label="Notifications"
      sublabel={shell ? "OS notifications from this app" : "Web Push to this browser"}
    >
      {state === "unsupported" && !shell ? (
        // Push needs a secure context + service-worker support. The bell chip
        // hid itself here; a settings pane explains the absence instead.
        <p className="text-xs text-text-secondary pt-1">Not supported in this browser</p>
      ) : (
        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-2 text-xs text-text-primary" role="status">
            <span
              aria-hidden="true"
              className={`inline-block w-1.5 h-1.5 rounded-full ${
                subscribed ? "bg-accent-green" : "bg-text-secondary"
              }`}
            />
            {subscribed
              ? shell
                ? "Enabled on this device"
                : "Subscribed on this device"
              : denied && !shell
                ? "Blocked in browser settings"
                : shell
                  ? "Not enabled"
                  : "Not subscribed"}
          </span>
          <div className="flex items-center gap-1.5 flex-wrap">
            {!subscribed && (
              <button type="button" onClick={() => void enable()} className={actionBtn}>
                Enable notifications
              </button>
            )}
            <Tip label={subscribed ? "Send a local test notification" : "Enable notifications first"}>
              <button
                type="button"
                onClick={() => void sendTest()}
                disabled={!subscribed}
                className={actionBtn}
              >
                Send test notification
              </button>
            </Tip>
          </div>
          {denied && !shell && (
            <p className="text-[10px] text-text-secondary">
              Re-allow notifications for this site in your browser/OS settings.
            </p>
          )}
          {!shell && (
            <a
              href={NOTIFICATIONS_HELP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-accent hover:underline w-fit"
            >
              Setup &amp; troubleshooting guide ↗
            </a>
          )}
        </div>
      )}
    </PreferenceRow>
  );
}

const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "all", label: "All settings" },
];

/** The tab rail (260818-bncw) — ONE `role="tablist"` markup: a vertical left
 *  rail at ≥480px, a horizontal scrollable strip under the dialog title below
 *  (the same `min-[480px]:` single-breakpoint idiom the preference rows use).
 *  Roving tabindex: the active tab is the list's one Tab stop; arrow keys
 *  (both axes, both layouts) move focus and activate on focus. */
function SettingsTabList({
  activeTab,
  onSelect,
}: {
  activeTab: SettingsTab;
  onSelect: (tab: SettingsTab) => void;
}) {
  const tabRefs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({});

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const delta =
      e.key === "ArrowDown" || e.key === "ArrowRight"
        ? 1
        : e.key === "ArrowUp" || e.key === "ArrowLeft"
          ? -1
          : 0;
    if (delta === 0) return;
    e.preventDefault();
    const idx = SETTINGS_TABS.findIndex((t) => t.id === activeTab);
    const next = SETTINGS_TABS[(idx + delta + SETTINGS_TABS.length) % SETTINGS_TABS.length];
    onSelect(next.id);
    tabRefs.current[next.id]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Settings sections"
      onKeyDown={onKeyDown}
      className="flex gap-1 overflow-x-auto border-b border-border pb-2 min-[480px]:flex-col min-[480px]:w-32 min-[480px]:shrink-0 min-[480px]:overflow-visible min-[480px]:border-b-0 min-[480px]:border-r min-[480px]:pb-0 min-[480px]:pr-3"
    >
      {SETTINGS_TABS.map((t) => {
        const active = t.id === activeTab;
        return (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`settings-tab-${t.id}`}
            aria-selected={active}
            aria-controls={`settings-panel-${t.id}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(t.id)}
            className={`text-left whitespace-nowrap text-xs px-2.5 py-1.5 rounded transition-colors ${
              active
                ? "bg-accent-green/15 text-text-primary"
                : "text-text-secondary hover:text-text-primary hover:bg-bg-inset/70"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export function SettingsDialog() {
  const { isOpen, closeSettings } = useSettingsDialog();
  if (!isOpen) return null;
  return <SettingsDialogBody onClose={closeSettings} />;
}

/** The dialog body — mounted only while open, so per-open fetches (the
 *  registry list behind every settings row, the Shortcuts tab's riff presets)
 *  run on mount without any reopen-staleness bookkeeping. */
function SettingsDialogBody({ onClose }: { onClose: () => void }) {
  const { activeTab, setActiveTab } = useSettingsDialog();
  const { hostname, instanceName } = useInstanceName();

  // The ONE registry seam: every settings row in every tab (curated and
  // All-settings table alike) reads/writes through it, so two presentations
  // of the same key cannot disagree within an open dialog. The GUI off-confirm
  // request reaches the AppLayout-owned dialog through its context.
  const registry = useSettingsRegistry({ requestGuiOff: useGuiOffRequest()?.request });

  return (
    <Dialog title="Settings" onClose={onClose} size="xl">
      <TipGroup>
        <div className="flex flex-col min-[480px]:flex-row gap-3 flex-1 min-h-0">
          <SettingsTabList activeTab={activeTab} onSelect={setActiveTab} />
          {/* One stable tabpanel per tab so every tab's `aria-controls` target
              exists; inactive panels are `hidden`, content stays mount-gated. */}
          {SETTINGS_TABS.map((t) => {
            const active = t.id === activeTab;
            return (
              <div
                key={t.id}
                role="tabpanel"
                id={`settings-panel-${t.id}`}
                aria-labelledby={`settings-tab-${t.id}`}
                hidden={!active}
                className="flex-1 min-w-0 min-h-0 overflow-y-auto"
              >
                {active && t.id === "general" && (
                  <GeneralPanel
                    hostname={hostname}
                    instanceName={instanceName}
                    registry={registry}
                  />
                )}
                {active && t.id === "appearance" && <AppearancePanel />}
                {active && t.id === "all" && <SettingsAllPanel registry={registry} />}
                {active && t.id === "shortcuts" && <ShortcutsTabPanel />}
              </div>
            );
          })}
        </div>
      </TipGroup>
    </Dialog>
  );
}

/** Read-only: the MCP streamable-HTTP endpoint as this browser reaches the
 *  daemon (display-only — no registry key behind it). */
function McpEndpointRow() {
  const url = mcpEndpointUrl();
  return (
    <PreferenceRow
      label="MCP endpoint"
      sublabel="For MCP clients on your tailnet (Claude Code). Claude Desktop uses ssh <host> rk mcp instead."
    >
      <div className="flex items-start gap-2 min-[480px]:pt-0.5">
        <code data-testid="settings-mcp-endpoint" className="min-w-0 break-all text-xs text-text-primary pt-1">
          {url}
        </code>
        <CopyValueButton value={url} label="Copy MCP endpoint" />
      </div>
    </PreferenceRow>
  );
}

function GeneralPanel({
  hostname,
  instanceName,
  registry,
}: {
  hostname: string;
  instanceName: string | null;
  registry: SettingsRegistry;
}) {
  const sshHostValue = registry.settingValue("ssh_host");
  const sshHost = typeof sshHostValue === "string" ? sshHostValue : "";
  const autoNameEntry = registry.entries.find((e) => e.key === "auto_name");
  const easterEggsEntry = registry.entries.find((e) => e.key === "easter_eggs");
  return (
    <>
      <section aria-label="This host settings">
        <ScopeHeading label="This host" hint="stored on this instance, shared by every device" />
        {/* Hairline separators between rows — a low-opacity border (6j1v). */}
        <div className="divide-y divide-border/40">
          <TextSetting
            id="settings-instance-name"
            label="Instance name"
            value={instanceName ?? ""}
            placeholder={hostname || "hostname"}
            hint="Display name for this instance; empty uses the hostname"
            commit={(trimmed) => registry.commitSetting("instance_name", trimmed === "" ? null : trimmed)}
          />
          <TextSetting
            id="settings-ssh-host"
            label="SSH host"
            value={sshHost}
            placeholder="alias or user@host"
            hint="Used verbatim in editor deeplinks; empty derives user@hostname"
            commit={(trimmed) => registry.commitSetting("ssh_host", trimmed === "" ? null : trimmed)}
          />
          <McpEndpointRow />
          <PreferenceRow
            label="Auto-name tabs"
            sublabel={autoNameEntry?.description}
            htmlFor="settings-auto-name"
          >
            <BoolToggle
              id="settings-auto-name"
              label="Auto-name tabs"
              on={registry.settingValue("auto_name") === true}
              commit={(on) => registry.commitSetting("auto_name", on)}
            />
          </PreferenceRow>
          <PreferenceRow
            label="Easter eggs"
            sublabel={easterEggsEntry?.description}
            htmlFor="settings-easter-eggs"
          >
            {/* `!== false` reads ON before the fetch resolves and when the key
                is absent — the registry default is on. */}
            <BoolToggle
              id="settings-easter-eggs"
              label="Easter eggs"
              on={registry.settingValue("easter_eggs") !== false}
              commit={(on) => registry.commitSetting("easter_eggs", on)}
            />
          </PreferenceRow>
        </div>
      </section>

      <section aria-label="This device settings" className="mt-4">
        <ScopeHeading label="This device" hint="stored in this browser only" />
        <div className="divide-y divide-border/40">
          <NotificationsControl />
        </div>
      </section>
    </>
  );
}

function AppearancePanel() {
  return (
    <>
      <section aria-label="This host settings">
        <ScopeHeading label="This host" hint="stored on this instance, shared by every device" />
        <div className="divide-y divide-border/40">
          <ThemePairControl />
          <AccentColorControl />
        </div>
      </section>

      <section aria-label="This device settings" className="mt-4">
        <ScopeHeading label="This device" hint="stored in this browser only" />
        <div className="divide-y divide-border/40">
          <TerminalFontControl />
          <QuakeOpacityControl />
        </div>
      </section>
    </>
  );
}

/** The Shortcuts tab — the retired shortcuts-overlay's body plus the per-open
 *  data plumbing the old layout mount owned (260811-239r's
 *  `LayoutShortcutsOverlay`): the macro add-flow's palette-target candidates
 *  (every merged palette action except the macro entries themselves) and the
 *  best-effort riff-preset fetch. Both stay gated on a route with a server +
 *  session (the same deepest-first route-param walk + SSE snapshot), and the
 *  fetch runs only while the Shortcuts tab is the visible panel (this
 *  component mounts only then) — a board/host route keeps the CUSTOM rows
 *  read/rebind/delete-only, exactly as before. */
function ShortcutsTabPanel() {
  const ctx = useSessionContext();
  const matches = useMatches();
  const allActions = usePaletteActions();

  let serverParam: string | undefined;
  let windowParam: string | undefined;
  for (let i = matches.length - 1; i >= 0; i--) {
    const p = (matches[i]?.params ?? {}) as { server?: string; window?: string };
    if (serverParam === undefined && typeof p.server === "string") serverParam = p.server;
    if (windowParam === undefined && typeof p.window === "string") windowParam = p.window;
  }
  const server = ctx.currentServer ?? serverParam ?? "";
  // The session of the URL's window, derived from the streamed sessions.
  const sessionName = useMemo(() => {
    if (!windowParam || !server) return undefined;
    return (ctx.sessionsByServer.get(server) ?? []).find((s) =>
      s.windows.some((w) => w.windowId === windowParam),
    )?.name;
  }, [ctx.sessionsByServer, server, windowParam]);

  const macroPaletteTargets = useMemo<MacroPaletteTarget[] | undefined>(
    () =>
      server
        ? allActions
            .filter((a) => !isMacroActionId(a.id))
            .map((a) => ({ id: a.id, label: a.label }))
        : undefined,
    [server, allActions],
  );

  // Best-effort riff-preset names for the CUSTOM section (add-flow targets +
  // missing-preset badges); GET /api/riff/presets derives the repo from the
  // session's active pane — the same preflight seam the spawn dialog uses.
  // null = unknown: no badges, palette targets only. Mount-gated: the effect
  // runs only while the Shortcuts tab is visible, cancel-flagged on
  // unmount/server change.
  const [riffPresetNames, setRiffPresetNames] = useState<string[] | null>(null);
  useEffect(() => {
    if (!sessionName) {
      setRiffPresetNames(null);
      return;
    }
    let cancelled = false;
    getRiffPresets(server, sessionName)
      .then((data) => {
        if (!cancelled) setRiffPresetNames(data.presets.map((p) => p.name));
      })
      .catch(() => {
        if (!cancelled) setRiffPresetNames(null);
      });
    return () => {
      cancelled = true;
    };
  }, [server, sessionName]);

  return (
    <SettingsShortcutsPanel
      paletteTargets={macroPaletteTargets}
      riffPresetNames={riffPresetNames}
    />
  );
}
