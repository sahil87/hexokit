/** DOM id of the Agents tab's preset dropdown — the palette's focus target. */
export const AGENT_PRESET_SELECT_ID = "agent-preset-select";

const AGENTS_PANEL_ID = "settings-panel-agents";
const AGENTS_TAB_ID = "settings-tab-agents";
const FOCUSABLE = "button, select, input, [href], textarea";
// The panel fetches fab on mount; past this the wait gives up quietly.
const FOCUS_WAIT_MS = 8000;

/** The Agents panel has finished loading once it renders a section (installed
 *  or not) or its load error. */
function panelSettled(panel: HTMLElement): boolean {
  return panel.querySelector("section, [role='alert']") !== null;
}

/**
 * Focus the preset dropdown as soon as it exists, whether the dialog is
 * already on the Agents tab or is still mounting and fetching. When the panel
 * settles without a dropdown (fab too old, not installed) focus falls back to
 * the tab's content, then the tab itself. Gives up after FOCUS_WAIT_MS.
 */
export function focusAgentPresetSelect(): void {
  const attempt = (): boolean => {
    const select = document.getElementById(AGENT_PRESET_SELECT_ID);
    if (select) {
      select.focus();
      return true;
    }
    const panel = document.getElementById(AGENTS_PANEL_ID);
    if (panel && panelSettled(panel)) {
      const target = panel.querySelector<HTMLElement>(FOCUSABLE) ?? document.getElementById(AGENTS_TAB_ID);
      target?.focus();
      return true;
    }
    return false;
  };
  const finish = () => {
    observer.disconnect();
    window.clearTimeout(giveUp);
  };
  const check = () => {
    if (attempt()) finish();
  };
  const observer = new MutationObserver(check);
  const giveUp = window.setTimeout(finish, FOCUS_WAIT_MS);
  observer.observe(document.body, { childList: true, subtree: true });
  // The palette is still closing when this runs; let its own focus handling
  // settle before the first attempt.
  window.setTimeout(check, 0);
}
