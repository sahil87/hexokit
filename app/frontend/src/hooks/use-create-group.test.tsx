import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { useCreateGroup } from "./use-create-group";
import { OptimisticProvider, useOptimisticContext } from "@/contexts/optimistic-context";
import { ToastProvider } from "@/components/toast";
import * as client from "@/api/client";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, createSession: vi.fn() };
});

const createSession = client.createSession as unknown as ReturnType<typeof vi.fn>;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <OptimisticProvider>{children}</OptimisticProvider>
    </ToastProvider>
  );
}

function setup() {
  return renderHook(() => ({ create: useCreateGroup(), optimistic: useOptimisticContext() }), { wrapper });
}

describe("useCreateGroup", () => {
  beforeEach(() => {
    createSession.mockReset();
  });
  afterEach(cleanup);

  it("adds a ghost group, calls createSession, and leaves the ghost for SSE on success", async () => {
    createSession.mockResolvedValue({ ok: true });
    const { result } = setup();
    let started = false;
    act(() => {
      started = result.current.create.createGroup("rk", "api", "~/code/api");
    });
    expect(started).toBe(true);
    expect(result.current.optimistic.ghosts).toMatchObject([{ type: "session", name: "api", server: "rk" }]);
    await waitFor(() => expect(createSession).toHaveBeenCalledWith("rk", "api", "~/code/api"));
    await waitFor(() => expect(result.current.create.isCreatingGroup()).toBe(false));
    expect(result.current.optimistic.ghosts).toHaveLength(1);
  });

  it("drops the ghost on failure", async () => {
    createSession.mockImplementation(() => Promise.reject(new Error("boom")));
    const { result } = setup();
    act(() => {
      result.current.create.createGroup("rk", "api", undefined);
    });
    await waitFor(() => expect(result.current.optimistic.ghosts).toHaveLength(0));
    expect(result.current.create.isCreatingGroup()).toBe(false);
  });

  it("refuses a second create while one is in flight, so no ghost is stranded", async () => {
    let resolve: (v: unknown) => void = () => {};
    createSession.mockReturnValue(new Promise((r) => (resolve = r)));
    const { result } = setup();
    let second = true;
    act(() => {
      result.current.create.createGroup("rk", "one", undefined);
      second = result.current.create.createGroup("rk", "two", undefined);
    });
    expect(second).toBe(false);
    expect(result.current.create.isCreatingGroup()).toBe(true);
    expect(result.current.optimistic.ghosts.map((g) => g.name)).toEqual(["one"]);
    await act(async () => resolve({ ok: true }));
    await waitFor(() => expect(result.current.create.isCreatingGroup()).toBe(false));
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("returns referentially stable functions", () => {
    const { result, rerender } = setup();
    const first = result.current.create;
    rerender();
    expect(result.current.create.createGroup).toBe(first.createGroup);
    expect(result.current.create.isCreatingGroup).toBe(first.isCreatingGroup);
  });
});
