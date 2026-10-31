import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { useState } from "react";
import { FolderPathInput, projectRoots } from "./folder-path-input";
import * as client from "@/api/client";
import type { ProjectSession } from "@/types";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, getDirectories: vi.fn() };
});

const getDirectories = client.getDirectories as unknown as ReturnType<typeof vi.fn>;

function Harness({ quickPicks = [], onSubmit }: { quickPicks?: string[]; onSubmit?: () => void }) {
  const [value, setValue] = useState("");
  return <FolderPathInput value={value} onChange={setValue} onSubmit={onSubmit} quickPicks={quickPicks} />;
}

describe("FolderPathInput", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom has no scrollIntoView; the highlighted-option effect calls it.
    Element.prototype.scrollIntoView = vi.fn();
    getDirectories.mockReset();
    getDirectories.mockResolvedValue([]);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows quick-picks when empty and selects one", () => {
    render(<Harness quickPicks={["~/code/a", "~/code/b"]} />);
    const input = screen.getByRole("combobox") as HTMLInputElement;
    fireEvent.focus(input);
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["~/code/a", "~/code/b"]);
    fireEvent.mouseDown(options[1]);
    expect(input.value).toBe("~/code/b");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("debounces directory autocomplete while typing", async () => {
    getDirectories.mockResolvedValue(["~/code/hexokit", "~/code/hexo2"]);
    render(<Harness />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "~/code/he" } });
    expect(getDirectories).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(getDirectories).toHaveBeenCalledWith("~/code/he");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["~/code/hexokit", "~/code/hexo2"]);
  });

  it("navigates with arrow keys, picks with Enter, closes with Escape", () => {
    render(<Harness quickPicks={["~/code/a", "~/code/b"]} />);
    const input = screen.getByRole("combobox") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("~/code/b");

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.focus(input);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("calls onSubmit on Enter when nothing is highlighted", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("projectRoots", () => {
  it("returns distinct, sorted first-tab worktree paths", () => {
    const sessions = [
      { name: "a", windows: [{ worktreePath: "~/code/b" }] },
      { name: "b", windows: [{ worktreePath: "~/code/a" }] },
      { name: "c", windows: [{ worktreePath: "~/code/b" }] },
      { name: "d", windows: [] },
    ] as unknown as ProjectSession[];
    expect(projectRoots(sessions)).toEqual(["~/code/a", "~/code/b"]);
  });
});
