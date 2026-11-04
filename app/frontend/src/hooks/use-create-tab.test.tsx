import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { useCreateTab } from "./use-create-tab";
import { ToastProvider } from "@/components/toast";
import { useWindowStore } from "@/store/window-store";
import * as client from "@/api/client";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, createWindow: vi.fn() };
});

const createWindow = client.createWindow as unknown as ReturnType<typeof vi.fn>;

function wrapper({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}

describe("useCreateTab", () => {
  beforeEach(() => {
    createWindow.mockReset();
    useWindowStore.setState({ ghosts: [] });
  });
  afterEach(cleanup);

  it("adds a raw-basename ghost and creates an unnamed tab at the cwd", async () => {
    createWindow.mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useCreateTab(), { wrapper });
    act(() => result.current("rk", "hexokit", "~/code/my-repo/"));
    expect(useWindowStore.getState().ghosts.map((g) => [g.server, g.session, g.name])).toEqual([["rk", "hexokit", "my-repo"]]);
    await waitFor(() => expect(createWindow).toHaveBeenCalledWith("rk", "hexokit", undefined, "~/code/my-repo/"));
    expect(useWindowStore.getState().ghosts).toHaveLength(1);
  });

  it("drops only the failed call's ghost; rapid creates each own theirs", async () => {
    createWindow.mockResolvedValueOnce({ ok: true }).mockImplementationOnce(() => Promise.reject(new Error("nope")));
    const { result } = renderHook(() => useCreateTab(), { wrapper });
    act(() => {
      result.current("rk", "g", "~/a");
      result.current("rk", "g", "~/b");
    });
    expect(useWindowStore.getState().ghosts).toHaveLength(2);
    await waitFor(() => expect(useWindowStore.getState().ghosts.map((g) => g.name)).toEqual(["a"]));
  });

  it("labels a cwd-less tab 'window' and is referentially stable", () => {
    createWindow.mockResolvedValue({ ok: true });
    const { result, rerender } = renderHook(() => useCreateTab(), { wrapper });
    const first = result.current;
    act(() => result.current("rk", "g", undefined));
    expect(useWindowStore.getState().ghosts[0].name).toBe("window");
    rerender();
    expect(result.current).toBe(first);
  });
});
