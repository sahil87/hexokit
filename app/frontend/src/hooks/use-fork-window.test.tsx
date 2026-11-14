import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup, screen, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { useForkWindow } from "./use-fork-window";
import { ToastProvider } from "@/components/toast";
import { useWindowStore } from "@/store/window-store";
import * as client from "@/api/client";
import type { WindowInfo } from "@/types";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, forkWindow: vi.fn() };
});

const forkWindow = client.forkWindow as unknown as ReturnType<typeof vi.fn>;

function wrapper({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}

/** Seed the store with the source tab `login-agent` (@2) of group `demo`. */
function seedSource() {
  useWindowStore.setState({ entries: new Map(), ghosts: [] });
  useWindowStore
    .getState()
    .setWindowsForSession("rk", "demo", [{ windowId: "@2", index: 0, name: "login-agent" } as WindowInfo]);
}

describe("useForkWindow", () => {
  beforeEach(() => {
    forkWindow.mockReset();
    seedSource();
  });
  afterEach(cleanup);

  it("shows a `<name>-fork` placeholder under the source's group while the fork is in flight, then navigates", async () => {
    let resolve: (v: { ok: true; windowId: string }) => void = () => {};
    forkWindow.mockImplementation(() => new Promise((r) => (resolve = r)));
    const navigate = vi.fn();
    const { result } = renderHook(() => useForkWindow(navigate), { wrapper });

    let settled: Promise<void> = Promise.resolve();
    act(() => {
      settled = result.current("rk", "@2", "worktree");
    });
    expect(forkWindow).toHaveBeenCalledWith("rk", "@2", "worktree");
    expect(useWindowStore.getState().ghosts.map((g) => [g.server, g.session, g.name])).toEqual([
      ["rk", "demo", "login-agent-fork"],
    ]);

    await act(async () => {
      resolve({ ok: true, windowId: "@3" });
      await settled;
    });
    expect(navigate).toHaveBeenCalledWith("rk", "@3");
    // The real window arriving over SSE claims the placeholder.
    act(() => {
      useWindowStore.getState().setWindowsForSession("rk", "demo", [
        { windowId: "@2", index: 0, name: "login-agent" } as WindowInfo,
        { windowId: "@3", index: 1, name: "login-agent-fork" } as WindowInfo,
      ]);
    });
    expect(useWindowStore.getState().ghosts).toEqual([]);
  });

  it("drops the placeholder and toasts when the fork fails; the promise still resolves", async () => {
    forkWindow.mockImplementation(() => Promise.reject(new Error("wt create failed")));
    const navigate = vi.fn();
    function Harness() {
      const fork = useForkWindow(navigate);
      return (
        <button type="button" onClick={() => void fork("rk", "@2", "worktree")}>
          fork
        </button>
      );
    }
    render(<Harness />, { wrapper });
    act(() => {
      screen.getByText("fork").click();
    });
    expect(useWindowStore.getState().ghosts).toHaveLength(1);
    await waitFor(() => expect(useWindowStore.getState().ghosts).toEqual([]));
    expect(await screen.findByText("wt create failed")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("adds no placeholder for a window the store does not know, and still forks", async () => {
    forkWindow.mockResolvedValue({ ok: true, windowId: "" });
    const navigate = vi.fn();
    const { result } = renderHook(() => useForkWindow(navigate), { wrapper });
    await act(async () => {
      await result.current("rk", "@99");
    });
    expect(forkWindow).toHaveBeenCalledWith("rk", "@99", undefined);
    expect(useWindowStore.getState().ghosts).toEqual([]);
    // Empty windowId: no navigation, SSE surfaces the row.
    expect(navigate).not.toHaveBeenCalled();
  });
});
