import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { useMemo } from "react";
import {
  TopBarSlotProvider,
  useTopBarSlot,
  useTopBarNotFound,
  useRegisterTopBarSlot,
  useSignalTopBarNotFound,
  type TopBarSlot,
} from "./top-bar-slot-context";

/** Read-side probe — renders the registered slot's identifying fields. */
function SlotView() {
  const slot = useTopBarSlot();
  return (
    <span data-testid="slot">
      {slot ? `${slot.server}:${slot.sessionName}:${slot.sidebarOpen}` : "null"}
    </span>
  );
}

/** A minimal registering page. Publishes a memoized slot on mount, clears on
 *  unmount (via the hook's effect cleanup). */
function Registrant({ server, sidebarOpen }: { server: string; sidebarOpen: boolean }) {
  const slot = useMemo<NonNullable<TopBarSlot>>(
    () => ({
      sessions: [],
      currentSession: null,
      currentWindow: null,
      sessionName: "",
      windowName: "",
      sidebarOpen,
      server,
      onNavigate: () => {},
      onToggleSidebar: () => {},
      onCreateWindow: () => {},
    }),
    [server, sidebarOpen],
  );
  useRegisterTopBarSlot(slot);
  return null;
}

describe("TopBarSlotContext", () => {
  afterEach(cleanup);

  it("defaults to null when no page has registered", () => {
    render(
      <TopBarSlotProvider>
        <SlotView />
      </TopBarSlotProvider>,
    );
    expect(screen.getByTestId("slot").textContent).toBe("null");
  });

  it("useRegisterTopBarSlot publishes the page's props into the read hook", () => {
    render(
      <TopBarSlotProvider>
        <Registrant server="rk" sidebarOpen={true} />
        <SlotView />
      </TopBarSlotProvider>,
    );
    expect(screen.getByTestId("slot").textContent).toBe("rk::true");
  });

  it("clears the slot back to null when the registering page unmounts", () => {
    const { rerender } = render(
      <TopBarSlotProvider>
        <Registrant server="rk" sidebarOpen={false} />
        <SlotView />
      </TopBarSlotProvider>,
    );
    expect(screen.getByTestId("slot").textContent).toBe("rk::false");
    act(() => {
      rerender(
        <TopBarSlotProvider>
          <SlotView />
        </TopBarSlotProvider>,
      );
    });
    expect(screen.getByTestId("slot").textContent).toBe("null");
  });

  it("is last-writer-wins — a re-registered slot overwrites the prior value", () => {
    const { rerender } = render(
      <TopBarSlotProvider>
        <Registrant server="alpha" sidebarOpen={true} />
        <SlotView />
      </TopBarSlotProvider>,
    );
    expect(screen.getByTestId("slot").textContent).toBe("alpha::true");
    act(() => {
      rerender(
        <TopBarSlotProvider>
          <Registrant server="beta" sidebarOpen={false} />
          <SlotView />
        </TopBarSlotProvider>,
      );
    });
    expect(screen.getByTestId("slot").textContent).toBe("beta::false");
  });

  it("carries the surface-toggle group fields (available + open + onToggle) through the slot", () => {
    const onToggle = vi.fn();
    const TogglesRegistrant = () => {
      const slot = useMemo<NonNullable<TopBarSlot>>(
        () => ({
          sessions: [],
          currentSession: null,
          currentWindow: null,
          sessionName: "",
          windowName: "",
          sidebarOpen: true,
          server: "rk",
          onNavigate: () => {},
          onToggleSidebar: () => {},
          onCreateWindow: () => {},
          surfaceToggles: { mode: "toggle", available: ["tty", "web"], open: ["tty"], onToggle, canAdd: true },
        }),
        [],
      );
      useRegisterTopBarSlot(slot);
      return null;
    };
    const TogglesView = () => {
      const slot = useTopBarSlot();
      return (
        <span data-testid="toggles-slot">
          {slot?.surfaceToggles?.mode === "toggle"
            ? `${slot.surfaceToggles.available.join(",")}|${slot.surfaceToggles.open.join(",")}|${typeof slot.surfaceToggles.onToggle}`
            : "null"}
        </span>
      );
    };
    render(
      <TopBarSlotProvider>
        <TogglesRegistrant />
        <TogglesView />
      </TopBarSlotProvider>,
    );
    expect(screen.getByTestId("toggles-slot").textContent).toBe("tty,web|tty|function");
  });

  it("useTopBarSlot throws outside the provider", () => {
    const Bad = () => {
      useTopBarSlot();
      return null;
    };
    expect(() => render(<Bad />)).toThrow(/TopBarSlotProvider/);
  });

  it("useSignalTopBarNotFound flips the notFound flag on mount and clears on unmount", () => {
    const NotFoundView = () => {
      const notFound = useTopBarNotFound();
      return <span data-testid="nf">{notFound ? "true" : "false"}</span>;
    };
    const NotFoundSignaller = () => {
      useSignalTopBarNotFound();
      return null;
    };
    const { rerender } = render(
      <TopBarSlotProvider>
        <NotFoundSignaller />
        <NotFoundView />
      </TopBarSlotProvider>,
    );
    expect(screen.getByTestId("nf").textContent).toBe("true");
    act(() => {
      rerender(
        <TopBarSlotProvider>
          <NotFoundView />
        </TopBarSlotProvider>,
      );
    });
    expect(screen.getByTestId("nf").textContent).toBe("false");
  });

  it("notFound defaults to false when nothing has signalled", () => {
    const NotFoundView = () => {
      const notFound = useTopBarNotFound();
      return <span data-testid="nf">{notFound ? "true" : "false"}</span>;
    };
    render(
      <TopBarSlotProvider>
        <NotFoundView />
      </TopBarSlotProvider>,
    );
    expect(screen.getByTestId("nf").textContent).toBe("false");
  });

  it("useSignalTopBarNotFound / useTopBarNotFound throw outside the provider", () => {
    const BadSignal = () => {
      useSignalTopBarNotFound();
      return null;
    };
    const BadRead = () => {
      useTopBarNotFound();
      return null;
    };
    expect(() => render(<BadSignal />)).toThrow(/TopBarSlotProvider/);
    expect(() => render(<BadRead />)).toThrow(/TopBarSlotProvider/);
  });

  it("useRegisterTopBarSlot throws outside the provider", () => {
    const Bad = () => {
      useRegisterTopBarSlot({
        sessions: [],
        currentSession: null,
        currentWindow: null,
        sessionName: "",
        windowName: "",
        sidebarOpen: false,
        server: "",
        onNavigate: () => {},
        onToggleSidebar: () => {},
        onCreateWindow: () => {},
      });
      return null;
    };
    expect(() => render(<Bad />)).toThrow(/TopBarSlotProvider/);
  });
});
