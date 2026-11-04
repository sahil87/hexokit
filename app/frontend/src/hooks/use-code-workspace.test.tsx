import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";

// Client seam: fetchCodeWorkspace is the hook's only I/O; the spy controls
// the resolve shape per test.
const fetchCodeWorkspace = vi.hoisted(() => vi.fn());
vi.mock("@/api/client", () => ({
  fetchCodeWorkspace: (...args: unknown[]) => fetchCodeWorkspace(...args),
}));

import { useCodeWorkspace } from "./use-code-workspace";
import { codeServerSrc, codeServerWorkspaceSrc } from "@/components/code-surface";

const WS_PATH = "/state/hexokit/code/default/@7-3fa1c9.code-workspace";
const WIN = { gitRoot: "/repo", codeRoot: "/repo" };

beforeEach(() => {
  fetchCodeWorkspace.mockReset();
});
afterEach(cleanup);

describe("useCodeWorkspace — mount gating", () => {
  it("stays pending until the GET resolves, then exposes the ?workspace= src", async () => {
    let resolve!: (v: unknown) => void;
    fetchCodeWorkspace.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { result } = renderHook(() => useCodeWorkspace("default", "@7", WIN, true, false));
    // Pending: the fetch is in flight, no src yet.
    expect(result.current.codeSrc).toBeNull();
    expect(fetchCodeWorkspace).toHaveBeenCalledWith("default", "@7");

    resolve({ status: "ok", path: WS_PATH, root: "/repo" });
    await waitFor(() =>
      expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc(WS_PATH)),
    );
  });

  it("does not fetch while the substrate codeRoot is empty (never the gitRoot fallback)", () => {
    const { result } = renderHook(() =>
      useCodeWorkspace("default", "@7", { gitRoot: "/repo", codeRoot: "" }, true, false),
    );
    expect(fetchCodeWorkspace).not.toHaveBeenCalled();
    // Pre-seed renders are pending, not folder-mounted.
    expect(result.current.codeSrc).toBeNull();
  });

  it("does not fetch while the code tile is closed", () => {
    renderHook(() => useCodeWorkspace("default", "@7", WIN, false, false));
    expect(fetchCodeWorkspace).not.toHaveBeenCalled();
  });

  it("happy path unchanged: seed in flight ⇒ pending; the confirmed root arms the workspace mount", async () => {
    fetchCodeWorkspace.mockResolvedValue({ status: "ok", path: WS_PATH, root: "/repo" });
    const { result, rerender } = renderHook(
      ({ win }) => useCodeWorkspace("default", "@7", win, true, false),
      { initialProps: { win: { gitRoot: "/repo", codeRoot: "" } } },
    );
    // Seed POST in flight (or not yet fired): pending, and no derivation GET.
    expect(result.current.codeSrc).toBeNull();
    expect(fetchCodeWorkspace).not.toHaveBeenCalled();
    // The option tick confirms the seed: the payload carries the root.
    rerender({ win: { gitRoot: "/repo", codeRoot: "/repo" } });
    await waitFor(() =>
      expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc(WS_PATH)),
    );
  });

  it("a 409 keeps the pending state and re-fetches on the next payload change", async () => {
    fetchCodeWorkspace.mockResolvedValue({ status: "no-root" });
    const { result, rerender } = renderHook(
      ({ win }) => useCodeWorkspace("default", "@7", win, true, false),
      { initialProps: { win: WIN } },
    );
    await waitFor(() => expect(fetchCodeWorkspace).toHaveBeenCalledTimes(1));
    expect(result.current.codeSrc).toBeNull();

    // The next payload change (a fresh window record) re-drives the effect;
    // the option has landed server-side by then, so the retry resolves.
    fetchCodeWorkspace.mockResolvedValue({ status: "ok", path: WS_PATH, root: "/repo" });
    rerender({ win: { ...WIN } });
    await waitFor(() =>
      expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc(WS_PATH)),
    );
    expect(fetchCodeWorkspace).toHaveBeenCalledTimes(2);
  });

  it("a 500 degrades to the ?folder= src with exactly one console warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchCodeWorkspace.mockRejectedValue(new Error("ensure failed"));
    const { result, rerender } = renderHook(
      ({ win }) => useCodeWorkspace("default", "@7", win, true, false),
      { initialProps: { win: WIN } },
    );
    await waitFor(() =>
      expect(result.current.codeSrc).toBe(codeServerSrc("/repo")),
    );
    expect(warn).toHaveBeenCalledTimes(1);

    // A degraded resolution is final for its (server, window, root): payload
    // ticks do not refetch — and never warn again.
    rerender({ win: { ...WIN } });
    await waitFor(() => expect(fetchCodeWorkspace).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("a root change re-derives for future mounts (the live frame ignores it)", async () => {
    fetchCodeWorkspace.mockResolvedValue({ status: "ok", path: WS_PATH, root: "/repo" });
    const { result, rerender } = renderHook(
      ({ win }) => useCodeWorkspace("default", "@7", win, true, false),
      { initialProps: { win: WIN } },
    );
    await waitFor(() =>
      expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc(WS_PATH)),
    );

    const otherPath = "/state/hexokit/code/default/@7-bbbbbb.code-workspace";
    fetchCodeWorkspace.mockResolvedValue({ status: "ok", path: otherPath, root: "/other" });
    rerender({ win: { gitRoot: "/other", codeRoot: "/other" } });
    await waitFor(() =>
      expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc(otherPath)),
    );
  });
});

describe("useCodeWorkspace — follow rule", () => {
  it("followFolder re-derives the workspace and exposes a nonce-keyed followSrc", async () => {
    fetchCodeWorkspace.mockResolvedValue({ status: "ok", path: WS_PATH, root: "/repo" });
    const { result } = renderHook(() => useCodeWorkspace("default", "@7", WIN, true, false));
    await waitFor(() =>
      expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc(WS_PATH)),
    );

    const newPath = "/state/hexokit/code/default/@7-cccccc.code-workspace";
    fetchCodeWorkspace.mockResolvedValue({ status: "ok", path: newPath, root: "/other" });
    act(() => { void result.current.followFolder("/other"); });
    await waitFor(() =>
      expect(result.current.followSrc).toEqual({
        src: codeServerWorkspaceSrc(newPath),
        nonce: 1,
        root: "/other",
        windowId: "@7",
      }),
    );
    // A second navigation bumps the nonce — each follow is a fresh license.
    fetchCodeWorkspace.mockResolvedValue({ status: "ok", path: WS_PATH, root: "/repo" });
    act(() => { void result.current.followFolder("/repo"); });
    await waitFor(() => expect(result.current.followSrc?.nonce).toBe(2));
  });

  it("a failed follow leaves the editor at its own ?folder= navigation", async () => {
    fetchCodeWorkspace.mockResolvedValue({ status: "ok", path: WS_PATH, root: "/repo" });
    const { result } = renderHook(() => useCodeWorkspace("default", "@7", WIN, true, false));
    await waitFor(() =>
      expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc(WS_PATH)),
    );

    fetchCodeWorkspace.mockRejectedValue(new Error("boom"));
    act(() => { void result.current.followFolder("/other"); });
    await waitFor(() => expect(fetchCodeWorkspace).toHaveBeenCalledTimes(2));
    expect(result.current.followSrc).toBeNull();
  });

  it("a failed follow with degradeToFolder lands the frame on the ?folder= form (one warning)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchCodeWorkspace.mockResolvedValue({ status: "ok", path: WS_PATH, root: "/repo" });
    const { result } = renderHook(() => useCodeWorkspace("default", "@7", WIN, true, false));
    await waitFor(() =>
      expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc(WS_PATH)),
    );

    fetchCodeWorkspace.mockRejectedValue(new Error("boom"));
    act(() => { void result.current.followFolder("/other", { degradeToFolder: true }); });
    await waitFor(() =>
      expect(result.current.followSrc).toEqual({
        src: codeServerSrc("/other"),
        nonce: 1,
        root: "/other",
        windowId: "@7",
      }),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    // The map entry moved too — a future mount generation boots at the follow.
    expect(result.current.codeSrcFor("@7")).toBeNull(); // no windowsById threaded
    warn.mockRestore();
  });

  it("a non-ok follow result with degradeToFolder degrades the same way", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchCodeWorkspace.mockResolvedValue({ status: "ok", path: WS_PATH, root: "/repo" });
    const { result } = renderHook(() => useCodeWorkspace("default", "@7", WIN, true, false));
    await waitFor(() =>
      expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc(WS_PATH)),
    );

    fetchCodeWorkspace.mockResolvedValue({ status: "no-root" });
    act(() => { void result.current.followFolder("/other", { degradeToFolder: true }); });
    await waitFor(() => expect(result.current.followSrc?.src).toBe(codeServerSrc("/other")));
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("a non-ok follow result without degradeToFolder leaves the editor in place", async () => {
    fetchCodeWorkspace.mockResolvedValue({ status: "ok", path: WS_PATH, root: "/repo" });
    const { result } = renderHook(() => useCodeWorkspace("default", "@7", WIN, true, false));
    await waitFor(() =>
      expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc(WS_PATH)),
    );

    fetchCodeWorkspace.mockResolvedValue({ status: "no-root" });
    act(() => { void result.current.followFolder("/other"); });
    await waitFor(() => expect(fetchCodeWorkspace).toHaveBeenCalledTimes(2));
    expect(result.current.followSrc).toBeNull();
  });

  it("followFolder's returned promise settles only when the follow completes", async () => {
    fetchCodeWorkspace.mockResolvedValue({ status: "ok", path: WS_PATH, root: "/repo" });
    const { result } = renderHook(() => useCodeWorkspace("default", "@7", WIN, true, false));
    await waitFor(() =>
      expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc(WS_PATH)),
    );

    const newPath = "/state/hexokit/code/default/@7-dddddd.code-workspace";
    let resolveFollow!: (v: unknown) => void;
    fetchCodeWorkspace.mockReturnValue(new Promise((r) => { resolveFollow = r; }));
    let settled = false;
    act(() => {
      void result.current.followFolder("/other").then(() => { settled = true; });
    });
    await waitFor(() => expect(fetchCodeWorkspace).toHaveBeenCalledTimes(2));
    // The GET is still in flight: the promise (and any in-flight guard a
    // caller hangs off it) must not have released yet.
    expect(settled).toBe(false);

    await act(async () => {
      resolveFollow({ status: "ok", path: newPath, root: "/other" });
    });
    expect(settled).toBe(true);
    expect(result.current.followSrc?.nonce).toBe(1);
  });

  it("a failed degrade-follow overlapping the option tick's derivation warns exactly once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchCodeWorkspace.mockResolvedValue({ status: "ok", path: WS_PATH, root: "/repo" });
    const { result, rerender } = renderHook(
      ({ win }) => useCodeWorkspace("default", "@7", win, true, false),
      { initialProps: { win: WIN } },
    );
    await waitFor(() =>
      expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc(WS_PATH)),
    );

    let rejectFollow!: (e: unknown) => void;
    fetchCodeWorkspace.mockReturnValue(new Promise((_, r) => { rejectFollow = r; }));
    act(() => {
      void result.current.followFolder("/other", { degradeToFolder: true });
    });
    // The option tick lands while the follow's GET is in flight: the mount
    // derivation fires for the new root against the same failing request —
    // both warn sites see the rejection, but the key warns once.
    rerender({ win: { gitRoot: "/other", codeRoot: "/other" } });
    await act(async () => {
      rejectFollow(new Error("boom"));
    });
    await waitFor(() => expect(result.current.followSrc?.src).toBe(codeServerSrc("/other")));
    expect(result.current.codeSrc).toBe(codeServerSrc("/other"));
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("followSrc is scoped to its window (a window switch drops it)", async () => {
    fetchCodeWorkspace.mockResolvedValue({ status: "ok", path: WS_PATH, root: "/repo" });
    const { result, rerender } = renderHook(
      ({ windowId }) =>
        useCodeWorkspace("default", windowId, { gitRoot: "/repo", codeRoot: "/repo" }, true, false),
      { initialProps: { windowId: "@7" } },
    );
    await waitFor(() =>
      expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc(WS_PATH)),
    );
    act(() => { void result.current.followFolder("/other"); });
    await waitFor(() => expect(result.current.followSrc?.nonce).toBe(1));

    rerender({ windowId: "@8" });
    expect(result.current.followSrc).toBeNull();
  });
});


describe("useCodeWorkspace — seed-refusal degrade", () => {
  it("a refused seed POST degrades to the ?folder= src instead of pending forever", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const win = { gitRoot: "/opt/repo", codeRoot: "" };
    const { result, rerender } = renderHook(
      ({ seedRejected }) => useCodeWorkspace("default", "@7", win, true, seedRejected),
      { initialProps: { seedRejected: false } },
    );
    // Seed POST in flight / not yet fired: pending remains correct.
    expect(result.current.codeSrc).toBeNull();

    // The backend refused the seed (e.g. /opt is outside $HOME): the
    // substrate root can never arrive, so the tile mounts the folder form.
    rerender({ seedRejected: true });
    await waitFor(() => expect(result.current.codeSrc).toBe(codeServerSrc("/opt/repo")));
    expect(fetchCodeWorkspace).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);

    // Payload ticks re-run the effect but never re-warn for the same key.
    rerender({ seedRejected: true });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("a later successful seed re-arms the workspace path (it wins over the fallback)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result, rerender } = renderHook(
      ({ win, seedRejected }) => useCodeWorkspace("default", "@7", win, true, seedRejected),
      {
        initialProps: {
          win: { gitRoot: "/opt/repo", codeRoot: "" },
          seedRejected: true,
        },
      },
    );
    await waitFor(() => expect(result.current.codeSrc).toBe(codeServerSrc("/opt/repo")));

    // The retry landed: the payload now carries the substrate root, and the
    // derivation GET resolves the workspace path as usual.
    fetchCodeWorkspace.mockResolvedValue({ status: "ok", path: WS_PATH, root: "/opt/repo" });
    rerender({ win: { gitRoot: "/opt/repo", codeRoot: "/opt/repo" }, seedRejected: false });
    await waitFor(() =>
      expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc(WS_PATH)),
    );
    warn.mockRestore();
  });
});

describe("useCodeWorkspace — per-window map", () => {
  const WIN_A = { gitRoot: "/repo-a", codeRoot: "/repo-a" };
  const WIN_B = { gitRoot: "/repo-b", codeRoot: "/repo-b" };
  const WS_A = "/state/hexokit/code/default/@7-aaaaaa.code-workspace";
  const WS_B = "/state/hexokit/code/default/@8-bbbbbb.code-workspace";
  const windowsById = () =>
    new Map<string, { gitRoot: string; codeRoot: string }>([
      ["@7", WIN_A],
      ["@8", WIN_B],
    ]);

  it("A→B→A yields exactly one fetch for A, and the revisit resolves synchronously (no pending tick)", async () => {
    fetchCodeWorkspace.mockImplementation((_server: string, id: string) =>
      Promise.resolve({
        status: "ok",
        path: id === "@7" ? WS_A : WS_B,
        root: id === "@7" ? "/repo-a" : "/repo-b",
      }),
    );
    const { result, rerender } = renderHook(
      ({ windowId, win }) => useCodeWorkspace("default", windowId, win, true, false),
      { initialProps: { windowId: "@7", win: WIN_A } },
    );
    await waitFor(() =>
      expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc(WS_A)),
    );

    rerender({ windowId: "@8", win: WIN_B });
    await waitFor(() =>
      expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc(WS_B)),
    );

    // The revisit resolves from the map at render time — synchronously, with
    // no effect round-trip and no refetch.
    rerender({ windowId: "@7", win: WIN_A });
    expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc(WS_A));
    expect(fetchCodeWorkspace).toHaveBeenCalledTimes(2);
    expect(
      fetchCodeWorkspace.mock.calls.filter(([, id]) => id === "@7"),
    ).toHaveLength(1);
  });

  it("the per-window lookup exposes the other window's src while A is active", async () => {
    fetchCodeWorkspace.mockImplementation((_server: string, id: string) =>
      Promise.resolve({
        status: "ok",
        path: id === "@7" ? WS_A : WS_B,
        root: id === "@7" ? "/repo-a" : "/repo-b",
      }),
    );
    const options = { windowsById: windowsById() };
    const { result, rerender } = renderHook(
      ({ windowId, win }) => useCodeWorkspace("default", windowId, win, true, false, options),
      { initialProps: { windowId: "@7", win: WIN_A } },
    );
    await waitFor(() =>
      expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc(WS_A)),
    );
    rerender({ windowId: "@8", win: WIN_B });
    await waitFor(() =>
      expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc(WS_B)),
    );
    rerender({ windowId: "@7", win: WIN_A });

    // A is active again; B's resolved src stays readable for its retained frame.
    expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc(WS_A));
    expect(result.current.codeSrcFor("@8")).toBe(codeServerWorkspaceSrc(WS_B));
    expect(result.current.codeSrcFor("@9")).toBeNull();
  });

  it("followFolder updates only its own window's entry", async () => {
    fetchCodeWorkspace.mockImplementation((_server: string, id: string) =>
      Promise.resolve({
        status: "ok",
        path: id === "@7" ? WS_A : WS_B,
        root: id === "@7" ? "/repo-a" : "/repo-b",
      }),
    );
    const { result, rerender } = renderHook(
      ({ windowId, win, options }) =>
        useCodeWorkspace("default", windowId, win, true, false, options),
      {
        initialProps: {
          windowId: "@7",
          win: WIN_A,
          options: { windowsById: windowsById() },
        },
      },
    );
    await waitFor(() =>
      expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc(WS_A)),
    );
    rerender({
      windowId: "@8",
      win: WIN_B,
      options: { windowsById: windowsById() },
    });
    await waitFor(() =>
      expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc(WS_B)),
    );
    rerender({
      windowId: "@7",
      win: WIN_A,
      options: { windowsById: windowsById() },
    });

    const followPath = "/state/hexokit/code/default/@7-cccccc.code-workspace";
    fetchCodeWorkspace.mockResolvedValue({ status: "ok", path: followPath, root: "/other" });
    act(() => { void result.current.followFolder("/other"); });
    await waitFor(() => expect(result.current.followSrc?.nonce).toBe(1));

    // The payload catches up: A's codeRoot is now the followed folder, so the
    // follow's entry is the one the lookup resolves.
    const movedA = { gitRoot: "/other", codeRoot: "/other" };
    rerender({
      windowId: "@7",
      win: movedA,
      options: { windowsById: new Map([["@7", movedA], ["@8", WIN_B]]) },
    });
    expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc(followPath));
    // B's entry is untouched by A's follow.
    expect(result.current.codeSrcFor("@8")).toBe(codeServerWorkspaceSrc(WS_B));
  });

  it("prunes entries for windows that left the live set", async () => {
    fetchCodeWorkspace.mockImplementation((_server: string, id: string) =>
      Promise.resolve({
        status: "ok",
        path: id === "@7" ? WS_A : WS_B,
        root: id === "@7" ? "/repo-a" : "/repo-b",
      }),
    );
    const live = new Set(["@7", "@8"]);
    const { result, rerender } = renderHook(
      ({ windowId, win, options }) =>
        useCodeWorkspace("default", windowId, win, true, false, options),
      {
        initialProps: {
          windowId: "@7",
          win: WIN_A,
          options: { windowsById: windowsById(), liveWindowIds: live },
        },
      },
    );
    await waitFor(() =>
      expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc(WS_A)),
    );
    rerender({
      windowId: "@8",
      win: WIN_B,
      options: { windowsById: windowsById(), liveWindowIds: live },
    });
    await waitFor(() =>
      expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc(WS_B)),
    );

    // @8 is killed (leaves the payload): its entry drops with the frame
    // eviction; the active window's entry survives.
    const afterKill = new Set(["@7"]);
    rerender({
      windowId: "@7",
      win: WIN_A,
      options: { windowsById: windowsById(), liveWindowIds: afterKill },
    });
    expect(result.current.codeSrcFor("@8")).toBeNull();
    expect(result.current.codeSrcFor("@7")).toBe(codeServerWorkspaceSrc(WS_A));
  });

  it("pruning is scoped to the current server — the previous server's entries survive", async () => {
    fetchCodeWorkspace.mockImplementation((server: string, id: string) =>
      Promise.resolve({
        status: "ok",
        path: `/ws/${server}${id}`,
        root: id === "@7" ? "/repo-a" : "/repo-b",
      }),
    );
    const both = new Set(["@7", "@8"]);
    const { result, rerender } = renderHook(
      ({ server, windowId, win, options }) =>
        useCodeWorkspace(server, windowId, win, true, false, options),
      {
        initialProps: {
          server: "other",
          windowId: "@8",
          win: WIN_B,
          options: { windowsById: windowsById(), liveWindowIds: both },
        },
      },
    );
    await waitFor(() =>
      expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc("/ws/other@8")),
    );

    // Switch servers and kill @8 there: the prune must not touch "other"'s
    // entry — its live set describes the CURRENT server only.
    const afterKill = new Set(["@7"]);
    rerender({
      server: "default",
      windowId: "@7",
      win: WIN_A,
      options: { windowsById: windowsById(), liveWindowIds: afterKill },
    });
    await waitFor(() =>
      expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc("/ws/default@7")),
    );

    // Back on "other", @8's entry resolves synchronously from the map — a
    // pruned entry would pend and refetch.
    rerender({
      server: "other",
      windowId: "@8",
      win: WIN_B,
      options: { windowsById: windowsById(), liveWindowIds: both },
    });
    expect(result.current.codeSrc).toBe(codeServerWorkspaceSrc("/ws/other@8"));
    expect(
      fetchCodeWorkspace.mock.calls.filter(([s, id]) => s === "other" && id === "@8"),
    ).toHaveLength(1);
  });
});
