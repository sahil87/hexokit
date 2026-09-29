import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { ServerDialogs } from "./server-dialogs";
import { ServerDialogsProvider, useServerDialogs } from "@/contexts/server-dialogs-context";
import { StandaloneSessionContextProvider } from "@/contexts/session-context";
import { OptimisticProvider } from "@/contexts/optimistic-context";
import { ToastProvider } from "@/components/toast";
import * as client from "@/api/client";

/**
 * Tests for the single layout-mounted server dialogs (260811-239r) — the
 * AppShell-derived superset now shared by every route: input sanitization on
 * change + finalize on submit, post-create pending marker + `/$server`
 * navigation, the `DAEMON_SERVER` warning on the kill confirm (previously
 * missing on board routes — drift), and post-kill navigation to `/` ONLY when
 * the killed server is SessionContext's `currentServer` (null on board routes,
 * so a board kill never navigates).
 */

const mockNavigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    createServer: vi.fn(),
    killServer: vi.fn(),
    adoptServer: vi.fn(),
  };
});

const createServer = client.createServer as unknown as ReturnType<typeof vi.fn>;
const killServer = client.killServer as unknown as ReturnType<typeof vi.fn>;
const adoptServer = client.adoptServer as unknown as ReturnType<typeof vi.fn>;

/** Test-side trigger panel standing in for the sidebar/palette call sites. */
function Triggers() {
  const { openCreateServer, requestKillServer, requestAdoptServer } = useServerDialogs();
  return (
    <div>
      <button onClick={openCreateServer}>open-create</button>
      <button onClick={() => requestKillServer("alpha")}>kill-alpha</button>
      <button onClick={() => requestKillServer("vault")}>kill-vault</button>
      <button onClick={() => requestKillServer(client.DAEMON_SERVER)}>kill-daemon</button>
      <button onClick={() => requestAdoptServer("alpha")}>adopt-alpha</button>
    </div>
  );
}

function renderDialogs(opts?: {
  currentServer?: string | null;
  markServerPending?: (name: string) => void;
  refreshServers?: () => void;
  restartNow?: () => Promise<{ status: string }>;
  servers?: client.ServerInfo[];
  sessionsByServer?: Map<string, client.ProjectSession[]>;
}) {
  render(
    <ToastProvider>
      <StandaloneSessionContextProvider
        value={{
          currentServer: opts?.currentServer ?? null,
          markServerPending: opts?.markServerPending ?? vi.fn(),
          refreshServers: opts?.refreshServers ?? vi.fn(),
          restartNow: opts?.restartNow,
          servers: opts?.servers,
          sessionsByServer: opts?.sessionsByServer,
        }}
      >
        <OptimisticProvider>
          <ServerDialogsProvider>
            <Triggers />
            <ServerDialogs />
          </ServerDialogsProvider>
        </OptimisticProvider>
      </StandaloneSessionContextProvider>
    </ToastProvider>,
  );
}

describe("ServerDialogs", () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    createServer.mockReset();
    killServer.mockReset();
    adoptServer.mockReset();
    createServer.mockResolvedValue({ name: "x" });
    killServer.mockResolvedValue(undefined);
    adoptServer.mockResolvedValue({ status: "ok" });
  });
  afterEach(cleanup);

  it("opens the create dialog via the context trigger and sanitizes input on change", () => {
    renderDialogs();
    fireEvent.click(screen.getByText("open-create"));
    const input = screen.getByLabelText("Server name");
    // Unsafe chars convert live (toSafeServerName) — the board twin previously
    // stored the raw value (drift fixed by the single implementation).
    fireEvent.change(input, { target: { value: "my server!" } });
    expect((input as HTMLInputElement).value).toBe("my_server_");
  });

  it("submits the finalized name, marks it pending, navigates to /$server, and closes", async () => {
    const markServerPending = vi.fn();
    const refreshServers = vi.fn();
    renderDialogs({ markServerPending, refreshServers });
    fireEvent.click(screen.getByText("open-create"));
    const input = screen.getByLabelText("Server name");
    // Trailing separator stays visible while typing; finalizeSafeName trims it
    // at commit.
    fireEvent.change(input, { target: { value: "my server " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(markServerPending).toHaveBeenCalledWith("my_server");
    expect(mockNavigate).toHaveBeenCalledWith({ to: "/$server", params: { server: "my_server" } });
    expect(screen.queryByLabelText("Server name")).not.toBeInTheDocument();
    // The POST itself is deferred a microtask inside useOptimisticAction; the
    // post-create server-list refresh rides onAlwaysSettled after it resolves.
    await waitFor(() => expect(createServer).toHaveBeenCalledWith("my_server"));
    await waitFor(() => expect(refreshServers).toHaveBeenCalled());
  });

  it("daemon target renders the protected fork by name derivation even when the server list is stale", () => {
    // The daemon entry is absent from ctx.servers (stale/empty list) — the
    // fork must still render for rk-daemon (derived from DAEMON_SERVER, never
    // from the payload alone), so the typed-name guard cannot be bypassed.
    renderDialogs({ servers: [{ name: "alpha", sessionCount: 1, protected: false }] });
    fireEvent.click(screen.getByText("kill-daemon"));
    expect(screen.getByText("Restart HexoKit")).toBeInTheDocument();
    expect(screen.getByText("Force kill")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Cancel"));

    fireEvent.click(screen.getByText("kill-alpha"));
    expect(screen.getByText(/Kill server/)).toBeInTheDocument();
    expect(screen.queryByText("Force kill")).not.toBeInTheDocument();
  });

  it("navigates to / after killing the current server (terminal-route rule)", async () => {
    renderDialogs({ currentServer: "alpha" });
    fireEvent.click(screen.getByText("kill-alpha"));
    fireEvent.click(screen.getByText("Kill"));
    // The POST is deferred a microtask inside useOptimisticAction.
    await waitFor(() => expect(killServer).toHaveBeenCalledWith("alpha", false));
    expect(mockNavigate).toHaveBeenCalledWith({ to: "/" });
    await waitFor(() => expect(screen.queryByText(/Kill server/)).not.toBeInTheDocument());
  });

  it("does NOT navigate after a kill when currentServer is null (board route)", async () => {
    renderDialogs({ currentServer: null });
    fireEvent.click(screen.getByText("kill-alpha"));
    fireEvent.click(screen.getByText("Kill"));
    await waitFor(() => expect(killServer).toHaveBeenCalledWith("alpha", false));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("does NOT navigate after killing a non-current server", async () => {
    renderDialogs({ currentServer: "beta" });
    fireEvent.click(screen.getByText("kill-alpha"));
    fireEvent.click(screen.getByText("Kill"));
    await waitFor(() => expect(killServer).toHaveBeenCalledWith("alpha", false));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("non-protected servers keep the plain two-button confirm (zero drift)", async () => {
    renderDialogs({ servers: [{ name: "alpha", sessionCount: 1, protected: false }] });
    fireEvent.click(screen.getByText("kill-alpha"));
    expect(screen.getByText("Kill server", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Kill")).toBeInTheDocument();
    expect(screen.queryByText("Force kill")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Type the server name/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Kill"));
    await waitFor(() => expect(killServer).toHaveBeenCalledWith("alpha", false));
  });

  it("protected non-daemon server: typed-name unlock, no Restart primary", async () => {
    renderDialogs({ servers: [{ name: "vault", sessionCount: 2, protected: true }] });
    fireEvent.click(screen.getByText("kill-vault"));

    const forceKill = screen.getByText("Force kill");
    expect(forceKill).toBeDisabled();
    expect(screen.queryByText("Restart HexoKit")).not.toBeInTheDocument();

    // Wrong name keeps the button locked.
    const input = screen.getByLabelText(/Type the server name/);
    fireEvent.change(input, { target: { value: "vaul" } });
    expect(forceKill).toBeDisabled();

    // Exact match unlocks; Enter submits the force kill.
    fireEvent.change(input, { target: { value: "vault" } });
    expect(forceKill).not.toBeDisabled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(killServer).toHaveBeenCalledWith("vault", true));
  });

  it("protected dialog: Esc cancels without killing", async () => {
    renderDialogs({ servers: [{ name: "vault", sessionCount: 1, protected: true }] });
    fireEvent.click(screen.getByText("kill-vault"));
    const input = screen.getByLabelText(/Type the server name/);
    fireEvent.change(input, { target: { value: "vault" } });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("Force kill")).not.toBeInTheDocument());
    expect(killServer).not.toHaveBeenCalled();
  });

  it("daemon target: Restart primary fires restartNow; typed name unlocks Force kill", async () => {
    const restartNow = vi.fn().mockResolvedValue({ status: "spawned" });
    renderDialogs({
      restartNow,
      servers: [{ name: client.DAEMON_SERVER, sessionCount: 3, protected: true }],
      sessionsByServer: new Map<string, client.ProjectSession[]>([
        [client.DAEMON_SERVER, [
          { name: "rk-jobs", windows: [{ windowId: "@1", index: 0, name: "update", worktreePath: "", activity: "active", activityTimestamp: 0, isActiveWindow: true, panes: [] }] },
          { name: "rk-code-server", windows: [] },
          { name: "rk-remotes", windows: [
            { windowId: "@2", index: 0, name: "a", worktreePath: "", activity: "idle", activityTimestamp: 0, isActiveWindow: true, panes: [] },
            { windowId: "@3", index: 1, name: "b", worktreePath: "", activity: "idle", activityTimestamp: 0, isActiveWindow: false, panes: [] },
          ] },
        ]],
      ]),
    });
    fireEvent.click(screen.getByText("kill-daemon"));

    // Live blast-radius copy derived from the session data.
    expect(screen.getByText(/kills the dashboard, 1 running job, code-server, 2 remote tunnels/)).toBeInTheDocument();

    // Restart primary fires restartNow and closes — no kill.
    fireEvent.click(screen.getByText("Restart HexoKit"));
    await waitFor(() => expect(restartNow).toHaveBeenCalled());
    expect(killServer).not.toHaveBeenCalled();

    // Reopen: typed exact name unlocks the force kill.
    fireEvent.click(screen.getByText("kill-daemon"));
    const input = screen.getByLabelText(/Type the server name/);
    fireEvent.change(input, { target: { value: client.DAEMON_SERVER } });
    fireEvent.click(screen.getByText("Force kill"));
    await waitFor(() => expect(killServer).toHaveBeenCalledWith(client.DAEMON_SERVER, true));
  });

  it("opens the adopt dialog via the context trigger and states the semi-irreversibility", () => {
    renderDialogs();
    fireEvent.click(screen.getByText("adopt-alpha"));
    expect(screen.getByText("Adopt server into HexoKit?")).toBeInTheDocument();
    // The copy must state that HexoKit's tmux config applies now and the
    // user's own config returns only on server restart.
    expect(screen.getByText(/your own config returns only when the server restarts/)).toBeInTheDocument();
    expect(screen.getByText("Adopt")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("confirm fires adoptServer and refreshes the server list", async () => {
    const refreshServers = vi.fn();
    renderDialogs({ refreshServers });
    fireEvent.click(screen.getByText("adopt-alpha"));
    fireEvent.click(screen.getByText("Adopt"));
    expect(screen.queryByText("Adopt server into HexoKit?")).not.toBeInTheDocument();
    await waitFor(() => expect(adoptServer).toHaveBeenCalledWith("alpha"));
    await waitFor(() => expect(refreshServers).toHaveBeenCalled());
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("cancel closes the adopt dialog without adopting", async () => {
    renderDialogs();
    fireEvent.click(screen.getByText("adopt-alpha"));
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(screen.queryByText("Adopt server into HexoKit?")).not.toBeInTheDocument());
    expect(adoptServer).not.toHaveBeenCalled();
  });

  it("a failed adopt toasts the error and does not refresh", async () => {
    const refreshServers = vi.fn();
    adoptServer.mockRejectedValue(new Error("reload failed"));
    renderDialogs({ refreshServers });
    fireEvent.click(screen.getByText("adopt-alpha"));
    fireEvent.click(screen.getByText("Adopt"));
    await waitFor(() => expect(screen.getByText("reload failed")).toBeInTheDocument());
    expect(refreshServers).not.toHaveBeenCalled();
  });
});
