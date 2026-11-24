import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { ShellNameplateReporter } from "./nameplate-reporter";
import { SessionContext } from "@/contexts/session-context";
import type { SessionContextType } from "@/contexts/session-context";
import { makeSession, makeWindow } from "@/test-utils/fixtures";

vi.mock("@/api/client", () => ({
  getHealth: vi.fn(),
}));
import { getHealth } from "@/api/client";

function bridge(): ReturnType<typeof vi.fn> {
  const set = vi.fn().mockResolvedValue({ ok: true });
  window.runkitShell = { version: "1.2.3", platform: "linux", nameplate: { set } };
  return set;
}

afterEach(() => {
  cleanup();
  delete window.runkitShell;
  vi.mocked(getHealth).mockReset();
});

describe("ShellNameplateReporter", () => {
  it("reports machine (user@hostname) and os from /api/health once", async () => {
    vi.mocked(getHealth).mockResolvedValue({ status: "ok", hostname: "ws-01", sshUser: "sahil", os: "linux" });
    const set = bridge();
    const { rerender } = render(<ShellNameplateReporter />);
    await waitFor(() => expect(set).toHaveBeenCalledWith({ machine: "sahil@ws-01", os: "linux" }));
    rerender(<ShellNameplateReporter />);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("omits the user@ prefix without an sshUser and the os on an older daemon", async () => {
    vi.mocked(getHealth).mockResolvedValue({ status: "ok", hostname: "ws-01" });
    const set = bridge();
    render(<ShellNameplateReporter />);
    await waitFor(() => expect(set).toHaveBeenCalledWith({ machine: "ws-01" }));
  });

  it("omits an empty machine so the shell never drops the whole report", async () => {
    vi.mocked(getHealth).mockResolvedValue({ status: "ok", hostname: "", sshUser: "sahil", os: "linux" });
    const set = bridge();
    render(<ShellNameplateReporter />);
    await waitFor(() => expect(set).toHaveBeenCalledWith({ os: "linux" }));
  });

  it("adds the agent count derived from the session stream and re-reports on change", async () => {
    vi.mocked(getHealth).mockResolvedValue({ status: "ok", hostname: "ws-01", os: "linux" });
    const set = bridge();
    const value = (windows: ReturnType<typeof makeWindow>[]): SessionContextType =>
      ({ sessionsByServer: new Map([["s", [makeSession({ windows })]]]) }) as unknown as SessionContextType;
    const { rerender } = render(
      <SessionContext.Provider value={value([makeWindow({ agentState: "idle" }), makeWindow({})])}>
        <ShellNameplateReporter />
      </SessionContext.Provider>,
    );
    await waitFor(() => expect(set).toHaveBeenCalledWith({ machine: "ws-01", os: "linux", agents: 1 }));
    rerender(
      <SessionContext.Provider value={value([makeWindow({ agentState: "idle" }), makeWindow({ agentState: "waiting" })])}>
        <ShellNameplateReporter />
      </SessionContext.Provider>,
    );
    await waitFor(() => expect(set).toHaveBeenLastCalledWith({ machine: "ws-01", os: "linux", agents: 2 }));
  });

  it("reports nothing when health fails and no sessions are available, and never throws on an older shell", async () => {
    vi.mocked(getHealth).mockRejectedValue(new Error("down"));
    const set = bridge();
    render(<ShellNameplateReporter />);
    await Promise.resolve();
    expect(set).not.toHaveBeenCalled();
    cleanup();
    delete window.runkitShell;
    vi.mocked(getHealth).mockResolvedValue({ status: "ok", hostname: "ws-01" });
    expect(() => render(<ShellNameplateReporter />)).not.toThrow();
  });
});
