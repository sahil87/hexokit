import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { NewSheetHost } from "./new-sheet-host";
import { NewSheetProvider, useNewSheet } from "@/contexts/new-sheet-context";
import { StandaloneSessionContextProvider } from "@/contexts/session-context";
import { OptimisticProvider } from "@/contexts/optimistic-context";
import { ToastProvider } from "@/components/toast";
import { useWindowStore } from "@/store/window-store";
import * as client from "@/api/client";
import type { NewSheetRequest } from "@/lib/new-sheet";
import type { ProjectSession, WindowInfo } from "@/types";

const mockNavigate = vi.fn();
let mockMatches: Array<{ params: Record<string, string> }> = [];

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockNavigate,
  useMatches: () => mockMatches,
}));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    createServer: vi.fn(),
    createSession: vi.fn(),
    createWindow: vi.fn(),
    getWorktrees: vi.fn(),
    getDirectories: vi.fn(),
  };
});

const createServer = client.createServer as unknown as ReturnType<typeof vi.fn>;
const createSession = client.createSession as unknown as ReturnType<typeof vi.fn>;
const createWindow = client.createWindow as unknown as ReturnType<typeof vi.fn>;
const getWorktrees = client.getWorktrees as unknown as ReturnType<typeof vi.fn>;
const getDirectories = client.getDirectories as unknown as ReturnType<typeof vi.fn>;

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
  { name: "hexokit", windows: [win("@1", "/home/u/code/hexokit", true)] },
  { name: "docs", windows: [win("@2", "/home/u/code/docs", true)] },
] as ProjectSession[];

function Opener({ request }: { request: NewSheetRequest }) {
  const { openNewSheet } = useNewSheet();
  return <button onClick={() => openNewSheet(request)}>open</button>;
}

function renderHost(request: NewSheetRequest, opts?: { currentServer?: string | null; sessionsByServer?: Map<string, ProjectSession[]>; markServerPending?: (n: string) => void }) {
  const { rerender } = render(hostTree(request, opts));
  fireEvent.click(screen.getByText("open"));
  return { rerender: (next: typeof opts) => rerender(hostTree(request, next)) };
}

function hostTree(request: NewSheetRequest, opts?: { currentServer?: string | null; sessionsByServer?: Map<string, ProjectSession[]>; markServerPending?: (n: string) => void }) {
  return (
    <ToastProvider>
      <StandaloneSessionContextProvider
        value={{
          currentServer: opts?.currentServer === undefined ? "rk-dev" : opts.currentServer,
          sessionsByServer: opts?.sessionsByServer ?? new Map([["rk-dev", sessions]]),
          servers: [{ name: "rk-dev" } as client.ServerInfo, { name: "api" } as client.ServerInfo],
          markServerPending: opts?.markServerPending ?? vi.fn(),
          refreshServers: vi.fn(),
        }}
      >
        <OptimisticProvider>
          <NewSheetProvider>
            <Opener request={request} />
            <NewSheetHost />
          </NewSheetProvider>
        </OptimisticProvider>
      </StandaloneSessionContextProvider>
    </ToastProvider>
  );
}

async function folderField() {
  return (await screen.findByRole("combobox", { name: "Folder" })) as HTMLInputElement;
}

describe("NewSheetHost", () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockMatches = [];
    createServer.mockReset().mockResolvedValue({ ok: true });
    createSession.mockReset().mockResolvedValue({ ok: true });
    createWindow.mockReset().mockResolvedValue({ ok: true });
    getWorktrees.mockReset().mockResolvedValue({ repo: "", worktrees: [] });
    getDirectories.mockReset().mockResolvedValue([]);
    Element.prototype.scrollIntoView = vi.fn();
    useWindowStore.setState({ ghosts: [] });
  });
  afterEach(cleanup);

  it("renders nothing until opened", () => {
    render(
      <ToastProvider>
        <StandaloneSessionContextProvider value={{}}>
          <OptimisticProvider>
            <NewSheetProvider>
              <NewSheetHost />
            </NewSheetProvider>
          </OptimisticProvider>
        </StandaloneSessionContextProvider>
      </ToastProvider>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Tab level: createWindow(server, group, undefined, cwd) with a raw-basename ghost", async () => {
    mockMatches = [{ params: { window: "@1" } }];
    renderHost({ level: "tab" });
    const folder = await folderField();
    expect(folder.value).toBe("~/code/hexokit");
    fireEvent.change(folder, { target: { value: "~/code/other-repo" } });
    fireEvent.keyDown(folder, { key: "Enter" });

    await waitFor(() => expect(createWindow).toHaveBeenCalledWith("rk-dev", "hexokit", undefined, "~/code/other-repo"));
    expect(useWindowStore.getState().ghosts.map((g) => [g.server, g.session, g.name])).toEqual([["rk-dev", "hexokit", "other-repo"]]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Group level: createSession(server, derivedName, cwd), deduped against live groups", async () => {
    mockMatches = [{ params: { window: "@1" } }];
    renderHost({ level: "group" });
    const folder = await folderField();
    fireEvent.keyDown(folder, { key: "Enter" });

    // `hexokit` is already a live group, so the derived name is deduped.
    await waitFor(() => expect(createSession).toHaveBeenCalledWith("rk-dev", "hexokit-2", "~/code/hexokit"));
    expect(createWindow).not.toHaveBeenCalled();
  });

  it("Group level: dedupes against groups created while the sheet is open", async () => {
    mockMatches = [{ params: { window: "@1" } }];
    const { rerender } = renderHost({ level: "group" });
    const folder = await folderField();
    // Another client creates `hexokit-2` after the sheet opened.
    rerender({ sessionsByServer: new Map([["rk-dev", [...sessions, { name: "hexokit-2", windows: [] } as ProjectSession]]]) });
    fireEvent.keyDown(folder, { key: "Enter" });

    await waitFor(() => expect(createSession).toHaveBeenCalledWith("rk-dev", "hexokit-3", "~/code/hexokit"));
  });

  it("Workspace level: createServer(name, cwd), marks pending and navigates to /$server", async () => {
    const markServerPending = vi.fn();
    mockMatches = [{ params: { window: "@1" } }];
    renderHost({ level: "workspace" }, { markServerPending });
    const folder = await folderField();
    fireEvent.change(folder, { target: { value: "~/code/billing" } });
    fireEvent.keyDown(folder, { key: "Enter" });

    await waitFor(() => expect(createServer).toHaveBeenCalledWith("billing", "~/code/billing"));
    expect(markServerPending).toHaveBeenCalledWith("billing");
    expect(mockNavigate).toHaveBeenCalledWith({ to: "/$server", params: { server: "billing" } });
  });

  it("a refused group submit (another create in flight) keeps the sheet open", async () => {
    let resolve: (v: unknown) => void = () => {};
    createSession.mockReturnValue(new Promise((r) => (resolve = r)));
    mockMatches = [{ params: { window: "@1" } }];
    renderHost({ level: "group" });
    const first = await folderField();
    fireEvent.keyDown(first, { key: "Enter" });
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("open"));
    const second = await folderField();
    fireEvent.keyDown(second, { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "New" })).toBeInTheDocument();
    expect(createSession).toHaveBeenCalledTimes(1);

    resolve({ ok: true });
    await waitFor(() => expect(screen.getByRole("dialog", { name: "New" })).toBeInTheDocument());
    fireEvent.keyDown(second, { key: "Enter" });
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(2));
  });

  it("an explicit group in the request pins the target and its active tab's folder", async () => {
    mockMatches = [{ params: { window: "@1" } }];
    renderHost({ level: "tab", server: "rk-dev", group: "docs" });
    const folder = await folderField();
    expect(folder.value).toBe("~/code/docs");
    fireEvent.keyDown(folder, { key: "Enter" });
    await waitFor(() => expect(createWindow).toHaveBeenCalledWith("rk-dev", "docs", undefined, "~/code/docs"));
  });

  it("falls back to the first group's folder on a workspace page (no tab route)", async () => {
    renderHost({ level: "tab" });
    const folder = await folderField();
    expect(folder.value).toBe("~/code/hexokit");
  });

  it("on the host page only the Workspace level is available, with an empty folder", async () => {
    renderHost({ level: "tab" }, { currentServer: null, sessionsByServer: new Map() });
    const folder = await folderField();
    expect(folder.value).toBe("");
    expect(screen.getByRole("button", { name: /^Tab/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Group/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Workspace/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("an existing workspace name from the live server list blocks Create", async () => {
    renderHost({ level: "workspace" });
    const folder = await folderField();
    fireEvent.change(folder, { target: { value: "~/code/api" } });
    // The derived name dedupes (api → api-2), so a collision only blocks an override.
    expect(screen.getByLabelText("Preview").textContent).toContain("New workspace api-2");
    fireEvent.keyDown(folder, { key: "Enter", ctrlKey: true });
    fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), { target: { value: "api" } });
    expect(screen.getByText("A workspace named api already exists")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create workspace/ })).toBeDisabled();
  });
});
