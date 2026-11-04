import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ServerDialogsProvider, useServerDialogs } from "./server-dialogs-context";

function Probe() {
  const {
    killServerTarget,
    requestKillServer,
    clearKillServerTarget,
  } = useServerDialogs();
  return (
    <div>
      <span data-testid="kill">{killServerTarget ?? "none"}</span>
      <button onClick={() => requestKillServer("rk")}>kill-rk</button>
      <button onClick={clearKillServerTarget}>clear-kill</button>
    </div>
  );
}

describe("ServerDialogsContext", () => {
  afterEach(cleanup);

  it("requestKillServer sets the target; clearKillServerTarget resets it", () => {
    render(
      <ServerDialogsProvider>
        <Probe />
      </ServerDialogsProvider>,
    );
    expect(screen.getByTestId("kill").textContent).toBe("none");
    fireEvent.click(screen.getByText("kill-rk"));
    expect(screen.getByTestId("kill").textContent).toBe("rk");
    fireEvent.click(screen.getByText("clear-kill"));
    expect(screen.getByTestId("kill").textContent).toBe("none");
  });

  it("triggers are referentially stable across state changes", () => {
    const seen: unknown[] = [];
    function StabilityProbe() {
      const { requestAdoptServer, requestKillServer } = useServerDialogs();
      seen.push(requestAdoptServer, requestKillServer);
      return (
        <button onClick={() => {
          requestAdoptServer("rk");
          requestKillServer("rk");
        }}>
          fire
        </button>
      );
    }
    render(
      <ServerDialogsProvider>
        <StabilityProbe />
      </ServerDialogsProvider>,
    );
    fireEvent.click(screen.getByText("fire"));
    expect(seen.length).toBeGreaterThan(2);
    expect(new Set(seen.filter((_, i) => i % 2 === 0)).size).toBe(1);
    expect(new Set(seen.filter((_, i) => i % 2 === 1)).size).toBe(1);
  });

  it("useServerDialogs throws outside the provider", () => {
    // Silence React's error boundary noise for the expected throw.
    const spy = console.error;
    console.error = () => {};
    try {
      expect(() => render(<Probe />)).toThrow(
        "useServerDialogs must be used within ServerDialogsProvider",
      );
    } finally {
      console.error = spy;
    }
  });
});
