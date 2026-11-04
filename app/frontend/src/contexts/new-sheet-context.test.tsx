import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { NewSheetProvider, useNewSheet } from "./new-sheet-context";

function Probe() {
  const { newSheetOpen, newSheetRequest, openNewSheet, closeNewSheet } = useNewSheet();
  return (
    <div>
      <span data-testid="open">{newSheetOpen ? "open" : "closed"}</span>
      <span data-testid="request">{newSheetRequest ? JSON.stringify(newSheetRequest) : "none"}</span>
      <button onClick={() => openNewSheet({ level: "group", server: "rk", group: "g" })}>open-group</button>
      <button onClick={() => openNewSheet({ level: "workspace" })}>open-workspace</button>
      <button onClick={closeNewSheet}>close</button>
    </div>
  );
}

describe("NewSheetContext", () => {
  afterEach(cleanup);

  it("starts closed and opens with the opener's request", () => {
    render(
      <NewSheetProvider>
        <Probe />
      </NewSheetProvider>,
    );
    expect(screen.getByTestId("open").textContent).toBe("closed");
    expect(screen.getByTestId("request").textContent).toBe("none");
    fireEvent.click(screen.getByText("open-group"));
    expect(screen.getByTestId("open").textContent).toBe("open");
    expect(JSON.parse(screen.getByTestId("request").textContent ?? "")).toEqual({ level: "group", server: "rk", group: "g" });
    fireEvent.click(screen.getByText("close"));
    expect(screen.getByTestId("open").textContent).toBe("closed");
  });

  it("a later open replaces the request (level always comes from the opener)", () => {
    render(
      <NewSheetProvider>
        <Probe />
      </NewSheetProvider>,
    );
    fireEvent.click(screen.getByText("open-group"));
    fireEvent.click(screen.getByText("open-workspace"));
    expect(JSON.parse(screen.getByTestId("request").textContent ?? "")).toEqual({ level: "workspace" });
  });

  it("keeps the triggers referentially stable across state changes", () => {
    const seen: unknown[] = [];
    function Capture() {
      const { openNewSheet, closeNewSheet } = useNewSheet();
      seen.push(openNewSheet, closeNewSheet);
      return <button onClick={() => openNewSheet({ level: "tab" })}>go</button>;
    }
    render(
      <NewSheetProvider>
        <Capture />
      </NewSheetProvider>,
    );
    fireEvent.click(screen.getByText("go"));
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen[0]).toBe(seen[seen.length - 2]);
    expect(seen[1]).toBe(seen[seen.length - 1]);
  });

  it("throws outside a provider", () => {
    expect(() => render(<Probe />)).toThrow(/NewSheetProvider/);
  });
});
