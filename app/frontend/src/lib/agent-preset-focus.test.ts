import { describe, it, expect, afterEach, vi } from "vitest";
import { AGENT_PRESET_SELECT_ID, focusAgentPresetSelect } from "./agent-preset-focus";

function mountPanel(inner: string): HTMLElement {
  document.body.innerHTML = `<button id="settings-tab-agents">Agents</button><div role="tabpanel" id="settings-panel-agents">${inner}</div>`;
  return document.getElementById("settings-panel-agents") as HTMLElement;
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("focusAgentPresetSelect", () => {
  it("focuses the dropdown once the panel renders it", async () => {
    vi.useFakeTimers();
    const panel = mountPanel("<p>Loading…</p>");
    focusAgentPresetSelect();
    await vi.advanceTimersByTimeAsync(10);
    expect(document.activeElement).toBe(document.body);

    panel.innerHTML = `<section aria-label="Agent CLIs"><select id="${AGENT_PRESET_SELECT_ID}"></select></section>`;
    await vi.advanceTimersByTimeAsync(10);
    expect(document.activeElement).toBe(document.getElementById(AGENT_PRESET_SELECT_ID));
  });

  it("focuses an already-rendered dropdown", async () => {
    vi.useFakeTimers();
    mountPanel(`<section><select id="${AGENT_PRESET_SELECT_ID}"></select></section>`);
    focusAgentPresetSelect();
    await vi.advanceTimersByTimeAsync(10);
    expect(document.activeElement).toBe(document.getElementById(AGENT_PRESET_SELECT_ID));
  });

  it("falls back to the tab content when the panel settles without a dropdown", async () => {
    vi.useFakeTimers();
    const panel = mountPanel("<p>Loading…</p>");
    focusAgentPresetSelect();
    panel.innerHTML = `<section aria-label="Agent CLIs"><button id="first-control">x</button></section>`;
    await vi.advanceTimersByTimeAsync(10);
    expect(document.activeElement).toBe(document.getElementById("first-control"));
  });

  it("falls back to the tab itself when the panel has nothing focusable", async () => {
    vi.useFakeTimers();
    mountPanel(`<section><p>fab isn't installed</p></section>`);
    focusAgentPresetSelect();
    await vi.advanceTimersByTimeAsync(10);
    expect(document.activeElement).toBe(document.getElementById("settings-tab-agents"));
  });

  it("gives up quietly when the panel never settles", async () => {
    vi.useFakeTimers();
    const panel = mountPanel("<p>Loading…</p>");
    focusAgentPresetSelect();
    await vi.advanceTimersByTimeAsync(9000);
    panel.innerHTML = `<section><select id="${AGENT_PRESET_SELECT_ID}"></select></section>`;
    await vi.advanceTimersByTimeAsync(10);
    expect(document.activeElement).toBe(document.body);
  });
});
