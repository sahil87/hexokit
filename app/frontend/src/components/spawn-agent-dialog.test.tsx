import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { SpawnAgentDialog } from "./spawn-agent-dialog";
import * as client from "@/api/client";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    getRiffPresets: vi.fn(),
    spawnRiff: vi.fn(),
  };
});

const getRiffPresets = client.getRiffPresets as unknown as ReturnType<typeof vi.fn>;
const spawnRiff = client.spawnRiff as unknown as ReturnType<typeof vi.fn>;

const BUILTIN_TIERS = ["default", "doing", "fast", "operator", "review"];

// The dialog takes an explicit `server` prop (no SessionContext read since gsmu),
// so tests supply the target server directly — this is also what enables the
// cross-server-spawn assertion below.
function renderDialog(overrides?: { server?: string; onSpawned?: () => void; onClose?: () => void }) {
  const server = overrides?.server ?? "work";
  const onSpawned = overrides?.onSpawned ?? vi.fn();
  const onClose = overrides?.onClose ?? vi.fn();
  render(
    <SpawnAgentDialog server={server} session="mysess" onSpawned={onSpawned} onClose={onClose} />,
  );
  return { onSpawned, onClose };
}

describe("SpawnAgentDialog", () => {
  beforeEach(() => {
    getRiffPresets.mockReset();
    spawnRiff.mockReset();
    getRiffPresets.mockResolvedValue({ riffPresets: [], tiers: BUILTIN_TIERS });
    spawnRiff.mockResolvedValue({ server: "work", session: "mysess", window: "riff-x", windowId: "@9" });
  });
  afterEach(cleanup);

  it("titles the dialog with the target session and fetches the preflight on open", async () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: "Spawn agent in mysess" })).toBeInTheDocument();
    expect(screen.getByLabelText("Task")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /spawn/i })).toBeInTheDocument();
    await waitFor(() => expect(getRiffPresets).toHaveBeenCalledWith("work", "mysess"));
  });

  it("renders the Where radio (new worktree default), the Worktree field, and the Agent dropdown", async () => {
    renderDialog();
    // Where radio — new worktree is the default selection.
    const newWorktree = screen.getByRole("radio", { name: /new worktree/i });
    const thisCheckout = screen.getByRole("radio", { name: /this checkout/i });
    expect(newWorktree).toBeChecked();
    expect(thisCheckout).not.toBeChecked();
    // Worktree field visible in worktree mode.
    expect(screen.getByLabelText("Worktree name")).toBeInTheDocument();
    // Agent dropdown defaults to "default" once the tiers arrive.
    await waitFor(() => expect((screen.getByLabelText("Agent tier") as HTMLSelectElement).value).toBe("default"));
  });

  it("hides the Worktree field when 'this checkout' is selected", async () => {
    renderDialog();
    expect(screen.getByLabelText("Worktree name")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /this checkout/i }));
    expect(screen.queryByLabelText("Worktree name")).not.toBeInTheDocument();
  });

  it("shows the RIFF PRESET dropdown only when riff presets are defined", async () => {
    getRiffPresets.mockResolvedValue({ riffPresets: [{ name: "ship", layout: "deck-h", paneCount: 2 }], tiers: BUILTIN_TIERS });
    renderDialog();
    await waitFor(() => expect(screen.getByLabelText("Riff preset")).toBeInTheDocument());
    expect(screen.getByRole("option", { name: /ship/i })).toBeInTheDocument();
  });

  it("does not render the RIFF PRESET dropdown when there are no riff presets", async () => {
    getRiffPresets.mockResolvedValue({ riffPresets: [], tiers: BUILTIN_TIERS });
    renderDialog();
    await waitFor(() => expect(getRiffPresets).toHaveBeenCalled());
    expect(screen.queryByLabelText("Riff preset")).not.toBeInTheDocument();
  });

  it("Enter from the task field submits with the trimmed task and worktree defaults", async () => {
    const { onSpawned, onClose } = renderDialog();
    const task = screen.getByLabelText("Task");
    fireEvent.change(task, { target: { value: "  fix the bug  " } });
    fireEvent.keyDown(task, { key: "Enter" });
    await waitFor(() =>
      expect(spawnRiff).toHaveBeenCalledWith("work", "mysess", {
        task: "fix the bug",
        riffPreset: undefined,
        where: "worktree",
        worktreeName: undefined,
        tier: "default",
      }),
    );
    await waitFor(() => expect(onSpawned).toHaveBeenCalledWith("@9"));
    expect(onClose).toHaveBeenCalled();
  });

  it("submits checkout + a chosen tier, dropping the worktree name", async () => {
    renderDialog();
    await waitFor(() => expect((screen.getByLabelText("Agent tier") as HTMLSelectElement).value).toBe("default"));
    fireEvent.click(screen.getByRole("radio", { name: /this checkout/i }));
    fireEvent.change(screen.getByLabelText("Agent tier"), { target: { value: "doing" } });
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "explore" } });
    fireEvent.click(screen.getByRole("button", { name: /^spawn$/i }));
    await waitFor(() =>
      expect(spawnRiff).toHaveBeenCalledWith("work", "mysess", {
        task: "explore",
        riffPreset: undefined,
        where: "checkout",
        worktreeName: undefined,
        tier: "doing",
      }),
    );
  });

  it("forwards a typed worktree name in worktree mode", async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("Worktree name"), { target: { value: "my-agent" } });
    fireEvent.click(screen.getByRole("button", { name: /^spawn$/i }));
    await waitFor(() =>
      expect(spawnRiff).toHaveBeenCalledWith("work", "mysess", {
        task: undefined,
        riffPreset: undefined,
        where: "worktree",
        worktreeName: "my-agent",
        tier: "default",
      }),
    );
  });

  it("empty task submits as a blank session (task arg undefined)", async () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /^spawn$/i }));
    await waitFor(() =>
      expect(spawnRiff).toHaveBeenCalledWith("work", "mysess", expect.objectContaining({ task: undefined })),
    );
  });

  it("shows a busy pipeline label and disables the submit while spawning", async () => {
    let resolve!: (v: unknown) => void;
    spawnRiff.mockReturnValue(new Promise((r) => { resolve = r; }));
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /^spawn$/i }));
    await waitFor(() => expect(screen.getByText(/worktree → tab → agent/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /spawning/i })).toBeDisabled();
    resolve({ server: "work", session: "mysess", window: "riff-x", windowId: "@9" });
  });

  it("closes without navigating when the returned windowId is empty (best-effort backend)", async () => {
    // The backend windowId is best-effort — "" on a display-message resolve
    // failure. An empty id must NOT navigate (would hit a junk /$server/@ URL);
    // the dialog closes and the SSE stream surfaces the new row.
    spawnRiff.mockResolvedValue({ server: "work", session: "mysess", window: "riff-x", windowId: "" });
    const { onSpawned, onClose } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /^spawn$/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSpawned).not.toHaveBeenCalled();
  });

  it("renders a 400/500 error in-dialog and keeps the dialog open", async () => {
    spawnRiff.mockRejectedValue(new Error("The session's working directory is not inside a git repository"));
    const { onClose, onSpawned } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /^spawn$/i }));
    await waitFor(() =>
      expect(screen.getByText(/not inside a git repository/i)).toBeInTheDocument(),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(onSpawned).not.toHaveBeenCalled();
    // Submit is re-enabled for correction.
    expect(screen.getByRole("button", { name: /^spawn$/i })).not.toBeDisabled();
  });

  it("falls back to the built-in default tier when the preflight fetch fails", async () => {
    getRiffPresets.mockRejectedValue(new Error("non-repo cwd"));
    renderDialog();
    // Agent dropdown still has a usable "default" option and no preset dropdown.
    await waitFor(() => expect(getRiffPresets).toHaveBeenCalled());
    expect((screen.getByLabelText("Agent tier") as HTMLSelectElement).value).toBe("default");
    expect(screen.queryByLabelText("Riff preset")).not.toBeInTheDocument();
  });

  // gsmu: the tier is fab-gated at the backend — a non-fab repo returns
  // `tiers: []`, which hides the Agent Tier field entirely and omits `tier` from
  // the POST body (a tier is inert in a non-fab repo).
  it("hides the Agent Tier field when the fetched tiers are empty (non-fab repo)", async () => {
    getRiffPresets.mockResolvedValue({ riffPresets: [], tiers: [] });
    renderDialog();
    await waitFor(() => expect(getRiffPresets).toHaveBeenCalled());
    // The field is absent entirely — no label, no control.
    await waitFor(() => expect(screen.queryByLabelText("Agent tier")).not.toBeInTheDocument());
    // Task-only spawn still works (the field's absence doesn't block it).
    expect(screen.getByLabelText("Task")).toBeInTheDocument();
  });

  it("omits tier from the POST body when the Agent Tier field is hidden", async () => {
    getRiffPresets.mockResolvedValue({ riffPresets: [], tiers: [] });
    renderDialog();
    await waitFor(() => expect(screen.queryByLabelText("Agent tier")).not.toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "do it" } });
    fireEvent.click(screen.getByRole("button", { name: /^spawn$/i }));
    await waitFor(() =>
      expect(spawnRiff).toHaveBeenCalledWith("work", "mysess", {
        task: "do it",
        riffPreset: undefined,
        where: "worktree",
        worktreeName: undefined,
        tier: undefined,
      }),
    );
  });

  // gsmu: the dialog runs preflight + spawn against the passed `server` prop
  // (not the current route server), which is what makes cross-server spawn from
  // the sidebar work.
  it("uses the passed target server for preflight and spawn (cross-server)", async () => {
    renderDialog({ server: "otherbox" });
    await waitFor(() => expect(getRiffPresets).toHaveBeenCalledWith("otherbox", "mysess"));
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "cross" } });
    fireEvent.click(screen.getByRole("button", { name: /^spawn$/i }));
    await waitFor(() =>
      expect(spawnRiff).toHaveBeenCalledWith("otherbox", "mysess", expect.objectContaining({ task: "cross" })),
    );
  });
});
