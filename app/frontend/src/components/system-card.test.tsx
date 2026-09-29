import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { ProjectSession } from "@/types";
import type { SessionContextType } from "@/contexts/session-context";
import { StandaloneSessionContextProvider } from "@/contexts/session-context";
import { ToastProvider } from "@/components/toast";

// --- Router mock: capture navigate calls. ---
const navigateMock = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

import { SystemCard } from "./system-card";

function daemonWindow(windowId: string, name: string, isActiveWindow = false) {
  return {
    windowId,
    index: 0,
    name,
    worktreePath: "/tmp",
    activity: "idle" as const,
    isActiveWindow,
    activityTimestamp: 0,
  };
}

function renderCard(overrides: Partial<SessionContextType> = {}) {
  return render(
    <ToastProvider>
      <StandaloneSessionContextProvider
        value={{
          daemonVersion: "3.9.1",
          daemonStarted: Math.floor(Date.now() / 1000) - 90000, // 1d 1h ago
          daemonPort: 3000,
          sessionsByServer: new Map(),
          ...overrides,
        }}
      >
        <SystemCard />
      </StandaloneSessionContextProvider>
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("SystemCard — daemon line", () => {
  it("renders version, uptime, and port from the context fields", () => {
    renderCard();
    const card = screen.getByLabelText("HexoKit system");
    expect(card).toHaveTextContent("v3.9.1");
    expect(card).toHaveTextContent("up 1d 1h");
    expect(card).toHaveTextContent(":3000");
  });

  it("omits the uptime and port segments when the fields are null (older daemon) — no NaN/0 garbage", () => {
    renderCard({ daemonStarted: null, daemonPort: null });
    const card = screen.getByLabelText("HexoKit system");
    expect(card).toHaveTextContent("v3.9.1");
    expect(card).not.toHaveTextContent("up");
    expect(card).not.toHaveTextContent(":3000");
    expect(card).not.toHaveTextContent("NaN");
  });

  it("Restart invokes the context's restartNow()", () => {
    const restartNow = vi.fn().mockResolvedValue({ status: "ok" });
    renderCard({ restartNow });
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(restartNow).toHaveBeenCalledTimes(1);
  });

  it("a rejected restartNow surfaces a toast (not an unhandled rejection)", async () => {
    const restartNow = vi.fn().mockRejectedValue(new Error("409 dev build"));
    renderCard({ restartNow });
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(restartNow).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("409 dev build")).toBeInTheDocument();
  });
});

describe("SystemCard — service rows", () => {
  it("derives running statuses + View links from the daemon server's sessions", () => {
    const sessions: ProjectSession[] = [
      { name: "rk-jobs", windows: [daemonWindow("@7", "job-a", true)] },
      { name: "rk-code-server", windows: [daemonWindow("@9", "code")] },
      {
        name: "rk-remotes",
        windows: [daemonWindow("@11", "box-1"), daemonWindow("@12", "box-2", true)],
      },
    ];
    renderCard({ sessionsByServer: new Map([["rk-daemon", sessions]]) });

    expect(screen.getByText("jobs")).toBeInTheDocument();
    expect(screen.getByText("1 job")).toBeInTheDocument();
    expect(screen.getByText("up")).toBeInTheDocument();
    expect(screen.getByText("2 tunnels")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "View" })).toHaveLength(3);
  });

  it("View deep-links to the session's active window on the rk-daemon terminal route", () => {
    const sessions: ProjectSession[] = [
      { name: "rk-jobs", windows: [daemonWindow("@7", "job-a"), daemonWindow("@8", "job-b", true)] },
    ];
    renderCard({ sessionsByServer: new Map([["rk-daemon", sessions]]) });

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/$server/$window",
      params: { server: "rk-daemon", window: "8" },
      search: {},
    });
  });

  it("falls back to the first window when none is active", () => {
    const sessions: ProjectSession[] = [
      { name: "rk-jobs", windows: [daemonWindow("@7", "job-a"), daemonWindow("@8", "job-b")] },
    ];
    renderCard({ sessionsByServer: new Map([["rk-daemon", sessions]]) });

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/$server/$window",
      params: { server: "rk-daemon", window: "7" },
      search: {},
    });
  });

  it("renders absent sibling sessions as not-running with no View link", () => {
    renderCard({ sessionsByServer: new Map([["rk-daemon", []]]) });

    expect(screen.getAllByText("not running")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "View" })).not.toBeInTheDocument();
  });

  it("renders all rows not-running when the daemon server is unattached (no session data)", () => {
    renderCard({ sessionsByServer: new Map() });

    expect(screen.getAllByText("not running")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "View" })).not.toBeInTheDocument();
  });

  it("mixes running and not-running rows independently", () => {
    const sessions: ProjectSession[] = [
      { name: "rk-jobs", windows: [daemonWindow("@7", "job-a", true)] },
    ];
    renderCard({ sessionsByServer: new Map([["rk-daemon", sessions]]) });

    expect(screen.getByText("1 job")).toBeInTheDocument();
    expect(screen.getAllByText("not running")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "View" })).toHaveLength(1);
  });
});
