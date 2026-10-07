import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, screen, render } from "@testing-library/react";
import { useEffect } from "react";
import { ToastProvider } from "@/components/toast";
import { FocusedTerminalProvider, useFocusedTerminal } from "@/contexts/focused-terminal-context";
import { useSplitPane } from "./use-split-pane";

const splitWindow = vi.fn();
vi.mock("@/api/client", () => ({
  splitWindow: (...args: unknown[]) => splitWindow(...args),
}));

let mobile = false;
vi.mock("./use-is-mobile", () => ({ useIsMobile: () => mobile }));

const focus = vi.fn();

function RegisterTerminal() {
  const { setFocused } = useFocusedTerminal();
  useEffect(() => {
    setFocused({ wsRef: { current: null }, containerRef: { current: null }, server: "srv", session: "s", windowId: "@1", focus });
  }, [setFocused]);
  return null;
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <FocusedTerminalProvider>
        <RegisterTerminal />
        {children}
      </FocusedTerminalProvider>
    </ToastProvider>
  );
}

describe("useSplitPane", () => {
  beforeEach(() => {
    splitWindow.mockReset();
    focus.mockReset();
    mobile = false;
  });

  it("focuses the focused terminal synchronously, before the split request settles", async () => {
    let resolve: () => void = () => {};
    splitWindow.mockReturnValue(new Promise<void>((r) => { resolve = r; }));
    const { result } = renderHook(() => useSplitPane(), { wrapper });

    act(() => result.current.split("srv", "@1", true, "/tmp"));

    expect(focus).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
    expect(splitWindow).toHaveBeenCalledWith("srv", "@1", true, "/tmp");
  });

  it("does not move focus on mobile, but still splits", async () => {
    mobile = true;
    splitWindow.mockResolvedValue({ ok: true, pane_id: "%2" });
    const { result } = renderHook(() => useSplitPane(), { wrapper });

    await act(async () => result.current.split("srv", "@1", false, undefined));

    expect(focus).not.toHaveBeenCalled();
    expect(splitWindow).toHaveBeenCalledWith("srv", "@1", false, undefined);
  });

  it("toasts the server's error when the split fails", async () => {
    splitWindow.mockRejectedValue(new Error("no space for new pane"));
    function Splitter() {
      const { split } = useSplitPane();
      return <button onClick={() => split("srv", "@1", true, undefined)}>split</button>;
    }
    render(<Splitter />, { wrapper });

    await act(async () => screen.getByText("split").click());

    expect(await screen.findByText("no space for new pane")).toBeTruthy();
  });
});
