import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { NewSheet } from "./new-sheet";
import * as client from "@/api/client";
import type { NewLevel } from "@/lib/new-sheet";
import type { ProjectSession, WindowInfo } from "@/types";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, getDirectories: vi.fn(), getWorktrees: vi.fn() };
});

const getDirectories = client.getDirectories as unknown as ReturnType<typeof vi.fn>;
const getWorktrees = client.getWorktrees as unknown as ReturnType<typeof vi.fn>;

function win(id: string, path: string, active = false): WindowInfo {
  return {
    windowId: id,
    index: 0,
    name: id,
    worktreePath: path,
    activity: "idle",
    isActiveWindow: active,
    activityTimestamp: 0,
  } as WindowInfo;
}

const sessions = [
  { name: "hexokit", windows: [win("@1", "/home/u/code/hexokit", true), win("@2", "/home/u/code/hexokit")] },
  { name: "other", windows: [win("@3", "/home/u/code/other", true)] },
] as ProjectSession[];

type Overrides = Partial<React.ComponentProps<typeof NewSheet>>;

function setup(overrides: Overrides = {}) {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  render(
    <NewSheet
      initialLevel="group"
      availableLevels={["tab", "group", "workspace"]}
      server="rk-dev"
      group="hexokit"
      sessions={sessions}
      workspaceNames={["rk-dev", "api"]}
      contextFolder="/home/u/code/hexokit"
      contextBranch="main"
      onSubmit={onSubmit}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onSubmit, onClose, folder: screen.getByRole("combobox", { name: "Folder" }) as HTMLInputElement };
}

function levelButton(name: string) {
  return screen.getByRole("button", { name: new RegExp(`^${name}`) });
}

describe("NewSheet", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    getDirectories.mockReset();
    getDirectories.mockResolvedValue([]);
    getWorktrees.mockReset();
    getWorktrees.mockResolvedValue({ repo: "", worktrees: [] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("prefills the folder with the context folder, focused and selected", () => {
    const { folder } = setup();
    expect(folder.value).toBe("~/code/hexokit");
    expect(folder).toHaveFocus();
    expect(folder.selectionStart).toBe(0);
    expect(folder.selectionEnd).toBe(folder.value.length);
  });

  it("starts at the opener's level and switches via the level buttons (aria-pressed)", () => {
    setup({ initialLevel: "group" });
    expect(levelButton("Group")).toHaveAttribute("aria-pressed", "true");
    expect(levelButton("Tab")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(levelButton("Tab"));
    expect(levelButton("Tab")).toHaveAttribute("aria-pressed", "true");
    expect(levelButton("Group")).toHaveAttribute("aria-pressed", "false");
  });

  it("disables unavailable levels and coerces to the first available one", () => {
    setup({ initialLevel: "tab", availableLevels: ["workspace"], server: "", group: "", sessions: [] });
    expect(levelButton("Tab")).toBeDisabled();
    expect(levelButton("Group")).toBeDisabled();
    expect(levelButton("Workspace")).toHaveAttribute("aria-pressed", "true");
  });

  it("previews each level in Workspace/Group/Tab vocabulary and tracks the primary label", () => {
    setup({ initialLevel: "tab" });
    const preview = () => screen.getByLabelText("Preview").textContent ?? "";
    expect(preview()).toContain("New tab in rk-dev › hexokit at ~/code/hexokit");
    expect(screen.getByRole("button", { name: /Create tab/ })).toBeInTheDocument();

    fireEvent.click(levelButton("Group"));
    expect(preview()).toContain("New group hexokit-2 in rk-dev, first tab at ~/code/hexokit");
    expect(screen.getByRole("button", { name: /Create group/ })).toBeInTheDocument();

    fireEvent.click(levelButton("Workspace"));
    expect(preview()).toContain("New workspace hexokit (tmux -L hexokit), first group and tab at ~/code/hexokit");
    expect(screen.getByRole("button", { name: /Create workspace/ })).toBeInTheDocument();
  });

  it("lists Current, Worktrees · repo and Open elsewhere without repeating folders", async () => {
    getWorktrees.mockResolvedValue({
      repo: "hexokit",
      worktrees: [
        { path: "/home/u/code/hexokit", branch: "main" },
        { path: "/home/u/code/hexokit.wt/feat", branch: "feat" },
      ],
    });
    setup();
    await act(async () => {});
    const groups = screen.getAllByRole("group").filter((g) => ["Current", "Worktrees · hexokit", "Open elsewhere"].includes(g.getAttribute("aria-label") ?? ""));
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Current", "Worktrees · hexokit", "Open elsewhere"]);
    const rows = screen.getAllByRole("option").map((o) => o.textContent);
    expect(rows).toEqual([
      "~/code/hexokitmainactive tab",
      "~/code/hexokit.wt/featfeat",
      "~/code/other1 tab open",
    ]);
  });

  it("Enter creates with the folder and derived name; the Group call carries both", () => {
    const { onSubmit, folder } = setup({ initialLevel: "group", contextFolder: "/home/u/code/new-thing" });
    fireEvent.keyDown(folder, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith({ level: "group", folder: "~/code/new-thing", name: "new_thing" });
  });

  it("the Tab level submits no name; the Workspace level submits a server-safe name", () => {
    const tab = setup({ initialLevel: "tab" });
    fireEvent.keyDown(tab.folder, { key: "Enter" });
    expect(tab.onSubmit).toHaveBeenCalledWith({ level: "tab", folder: "~/code/hexokit", name: undefined });
    cleanup();

    const ws = setup({ initialLevel: "workspace", contextFolder: "/home/u/code/billing-api" });
    fireEvent.keyDown(ws.folder, { key: "Enter" });
    expect(ws.onSubmit).toHaveBeenCalledWith({ level: "workspace", folder: "~/code/billing-api", name: "billing_api" });
  });

  it("a blank folder submits an undefined folder", () => {
    const { onSubmit, folder } = setup({ initialLevel: "tab", contextFolder: "" });
    expect(folder.value).toBe("");
    fireEvent.keyDown(folder, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith({ level: "tab", folder: undefined, name: undefined });
  });

  it("Tab / Shift+Tab in the folder field cycle the level (and are claimed)", () => {
    const { folder } = setup({ initialLevel: "group" });
    fireEvent.keyDown(folder, { key: "Tab" });
    expect(levelButton("Workspace")).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(folder, { key: "Tab", shiftKey: true });
    expect(levelButton("Group")).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(folder, { key: "Tab", shiftKey: true });
    expect(levelButton("Tab")).toHaveAttribute("aria-pressed", "true");
  });

  it("↑/↓ move through the folder list, setting the field", () => {
    const { folder } = setup();
    fireEvent.keyDown(folder, { key: "ArrowDown" });
    expect(folder.value).toBe("~/code/other");
    fireEvent.keyDown(folder, { key: "ArrowDown" });
    expect(folder.value).toBe("~/code/hexokit");
    fireEvent.keyDown(folder, { key: "ArrowUp" });
    expect(folder.value).toBe("~/code/other");
  });

  it("Ctrl+Enter opens the name override, prefilled and selected; Enter creates with the typed name", () => {
    const { onSubmit, folder } = setup({ initialLevel: "group", contextFolder: "/home/u/code/api" });
    fireEvent.keyDown(folder, { key: "Enter", ctrlKey: true });
    const name = screen.getByRole("textbox", { name: "Group name" }) as HTMLInputElement;
    expect(name.value).toBe("api");
    expect(name).toHaveFocus();
    expect(name.selectionEnd).toBe(3);
    fireEvent.change(name, { target: { value: "my group" } });
    expect(name.value).toBe("my_group");
    fireEvent.keyDown(name, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith({ level: "group", folder: "~/code/api", name: "my_group" });
  });

  it("⌘Enter is a no-op on the Tab level (tabs stay unnamed)", () => {
    const { folder } = setup({ initialLevel: "tab" });
    fireEvent.keyDown(folder, { key: "Enter", metaKey: true });
    expect(screen.queryByRole("textbox", { name: /name/i })).not.toBeInTheDocument();
  });

  it("an already-live workspace name disables Create with the exists hint", () => {
    const { onSubmit, folder } = setup({ initialLevel: "workspace" });
    fireEvent.keyDown(folder, { key: "Enter", ctrlKey: true });
    const name = screen.getByRole("textbox", { name: "Workspace name" });
    fireEvent.change(name, { target: { value: "api" } });
    expect(screen.getByText("A workspace named api already exists")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create workspace/ })).toBeDisabled();
    fireEvent.keyDown(name, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("switching level drops a name override", () => {
    const { folder } = setup({ initialLevel: "group" });
    fireEvent.keyDown(folder, { key: "Enter", ctrlKey: true });
    expect(screen.getByRole("textbox", { name: "Group name" })).toBeInTheDocument();
    fireEvent.click(levelButton("Workspace"));
    expect(screen.queryByRole("textbox", { name: "Group name" })).not.toBeInTheDocument();
  });

  it("typed text replaces the list with directory autocomplete; Enter on a highlighted row fills, not creates", async () => {
    vi.useFakeTimers();
    getDirectories.mockResolvedValue(["~/code/hexo/", "~/code/hexo2/"]);
    const { onSubmit, folder } = setup({ initialLevel: "tab" });
    fireEvent.change(folder, { target: { value: "~/code/he" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(getDirectories).toHaveBeenCalledWith("~/code/he");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["~/code/hexo/", "~/code/hexo2/"]);

    fireEvent.keyDown(folder, { key: "ArrowDown" });
    fireEvent.keyDown(folder, { key: "Enter" });
    expect(folder.value).toBe("~/code/hexo/");
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(folder, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith({ level: "tab", folder: "~/code/hexo/", name: undefined });
  });

  it("clicking a list row sets the folder", () => {
    const { folder } = setup();
    fireEvent.click(screen.getByRole("option", { name: /~\/code\/other/ }));
    expect(folder.value).toBe("~/code/other");
  });

  it("the primary button creates", () => {
    const { onSubmit } = setup({ initialLevel: "tab" });
    fireEvent.click(screen.getByRole("button", { name: /Create tab/ }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("Escape closes", () => {
    const { onClose } = setup();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each<[NewLevel, string]>([
    ["tab", "Create tab"],
    ["group", "Create group"],
    ["workspace", "Create workspace"],
  ])("labels the primary button for the %s level", (level, label) => {
    setup({ initialLevel: level });
    expect(screen.getByRole("button", { name: new RegExp(label) })).toBeInTheDocument();
  });
});
