import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { SurfaceLayout } from "./surface-layout";
import { ToastProvider } from "@/components/toast";
import { StandaloneSessionContextProvider } from "@/contexts/session-context";
import { stubMatchMedia } from "@/test-utils/match-media";

stubMatchMedia(() => false);

vi.mock("@/components/terminal-client", () => ({
  TerminalClient: () => <div data-testid="mock-terminal" />,
}));
vi.mock("@/api/client", () => ({
  setWindowOptions: vi.fn().mockResolvedValue({ ok: true }),
  addWebTab: vi.fn(),
  removeWebTab: vi.fn(),
  selectWebTab: vi.fn(),
  checkFrame: vi.fn().mockResolvedValue({ reachable: true, embeddable: true, status: 200, reason: "" }),
  listServers: vi.fn().mockResolvedValue([]),
}));

afterEach(cleanup);

describe("integration: SurfaceLayout + real IframeWindow", () => {
  it("renders a 2-tab window without an update-depth loop", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <StandaloneSessionContextProvider
        value={{
          sessionsByServer: new Map([["srv", []]]),
          sessionOrderByServer: new Map([["srv", []]]),
          isConnectedByServer: new Map([["srv", false]]),
          metricsByServer: new Map(),
          currentServer: "srv",
          servers: [{ name: "srv", sessionCount: 0 }],
          refreshServers: vi.fn(),
        }}
      >
      <ToastProvider>
      <SurfaceLayout
        layout={{ dir: "h", children: [{ leaf: "tty" }, { leaf: "web" }] }}
        server="srv"
        windowId="@1"
        sessionName="sess"
        window={{ webTabs: ["/proxy/8080/docs", "/proxy/8081/api"], webActive: 2 }}
        isMobile={false}
        wsRef={{ current: null }}
        focusRef={{ current: null }}
        scrollLocked={false}
        onSessionNotFound={vi.fn()}
        codeReachable
        onClose={vi.fn()}
        onApplyLayout={vi.fn()}
      />
      </ToastProvider>
      </StandaloneSessionContextProvider>,
    );
    await new Promise((r) => setTimeout(r, 300));
    // Simulate each frame's load event (the presented-page path) — the e2e
    // rig showed a Maximum-update-depth loop when real same-origin content
    // loaded; guard the seam here. A 2-tab family mounts one iframe per tab.
    const { fireEvent } = await import("@testing-library/react");
    const frames = document.querySelectorAll("iframe");
    expect(frames.length).toBe(2);
    for (const frame of frames) fireEvent.load(frame);
    await new Promise((r) => setTimeout(r, 300));
    const depthErrors = errSpy.mock.calls.filter((c) =>
      String(c[0]).includes("Maximum update depth"),
    );
    errSpy.mockRestore();
    expect(depthErrors).toHaveLength(0);
  });
});
