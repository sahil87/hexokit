import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getRiffPresets, type FabAgentPreset } from "@/api/client";
import { loadMachineAgentPresetInfo, loadMachineAgentPresets, resetAgentPresetCache } from "@/lib/agent-presets";
import { AgentPresetChooser } from "./agent-preset-chooser";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, getRiffPresets: vi.fn() };
});

vi.mock("@/lib/agent-presets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent-presets")>();
  return {
    ...actual,
    loadMachineAgentPresets: vi.fn(),
    loadMachineAgentPresetInfo: vi.fn(),
  };
});

const PRESETS: FabAgentPreset[] = [
  { name: "claude", description: "All roles on Claude", source: "built-in" },
  { name: "codex-review", description: "Only review on Codex", source: "built-in" },
  { name: "codex-workers", description: "Workers on Codex", source: "built-in" },
];

function renderChooser(overrides: {
  own?: string;
  workspace?: string;
  session?: string;
  onPick?: (value: string | null) => void;
  onClose?: () => void;
} = {}) {
  const anchorRef = { current: document.createElement("button") };
  return render(
    <AgentPresetChooser
      kind={overrides.session ? "Group" : "Workspace"}
      entityName="proj"
      own={overrides.own}
      workspace={overrides.workspace}
      server="srv"
      session={overrides.session}
      anchorRef={anchorRef}
      onPick={overrides.onPick ?? vi.fn()}
      onClose={overrides.onClose ?? vi.fn()}
    />,
  );
}

beforeEach(() => {
  resetAgentPresetCache();
  vi.mocked(loadMachineAgentPresets).mockResolvedValue(PRESETS);
  vi.mocked(loadMachineAgentPresetInfo).mockResolvedValue({ presets: PRESETS, machineDefault: "claude" });
  vi.mocked(getRiffPresets).mockResolvedValue({ riffPresets: [], tiers: [], agentPresets: PRESETS });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgentPresetChooser", () => {
  it("lists inherit, presets and none with inherited source text", async () => {
    renderChooser({ workspace: "codex-workers", session: "proj" });
    const group = await screen.findByRole("radiogroup", { name: "Agent preset for proj" });
    await waitFor(() => expect(group.querySelectorAll('[role="radio"]')).toHaveLength(5));
    expect(screen.getByText("uses codex-workers (from workspace)")).toBeInTheDocument();
    expect(screen.getByText("Only review on Codex")).toBeInTheDocument();
    expect(screen.getByText("no preset, even the machine default")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /inherit/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Applies to tabs created from now on. Running tabs keep theirs.")).toBeInTheDocument();
  });

  it("focuses the current choice and wraps arrow navigation before Enter picks", async () => {
    const onPick = vi.fn();
    renderChooser({ own: "codex-review", onPick });
    const current = await screen.findByRole("radio", { name: /codex-review/ });
    await waitFor(() => expect(current).toHaveFocus());

    fireEvent.keyDown(current, { key: "ArrowDown" });
    const next = screen.getByRole("radio", { name: /codex-workers/ });
    expect(next).toHaveFocus();
    fireEvent.keyDown(next, { key: "ArrowUp" });
    fireEvent.keyDown(current, { key: "ArrowUp" });
    expect(screen.getByRole("radio", { name: /^claude/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("claude");
  });

  it("falls back to inherit focus for an unknown own value", async () => {
    renderChooser({ own: "old-preset" });
    const inherit = await screen.findByRole("radio", { name: /inherit/ });
    await waitFor(() => expect(inherit).toHaveFocus());
    expect(screen.queryByRole("radio", { checked: true })).toBeNull();
  });

  it("sends null for inherit and the reserved value for none", async () => {
    const onPick = vi.fn();
    renderChooser({ own: "claude", onPick });
    fireEvent.click(await screen.findByRole("radio", { name: /inherit/ }));
    expect(onPick).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByRole("radio", { name: /none/ }));
    expect(onPick).toHaveBeenLastCalledWith("none");
  });

  it("closes on Escape and outside press without picking", async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    renderChooser({ onPick, onClose });
    await screen.findByRole("radiogroup");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
    expect(onPick).not.toHaveBeenCalled();
  });

  it("loads and remembers a group's repo-scoped list", async () => {
    const repoList = [{ name: "team", description: "Project preset", source: "project" }];
    vi.mocked(getRiffPresets).mockResolvedValue({ riffPresets: [], tiers: [], agentPresets: repoList });
    renderChooser({ session: "proj" });
    expect(await screen.findByRole("radio", { name: /team/ })).toBeInTheDocument();
    expect(getRiffPresets).toHaveBeenCalledWith("srv", "proj");
  });
});
