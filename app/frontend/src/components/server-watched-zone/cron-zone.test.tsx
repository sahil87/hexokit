import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { StandaloneSessionContextProvider } from "@/contexts/session-context";
import { makeSession } from "@/test-utils/fixtures";
import type { CronEntry, CronDelivery } from "@/api/client";
import type { ProjectSession } from "@/types";
import { CronZone, cronZoneSide } from "./cron-zone";

const NOW = 1_700_000_000;

// The router location the section reads its hash from (TanStack strips the
// `#`); the cron fetch is mocked to a controllable shape so no request fires.
const mockLocation = vi.hoisted(() => ({ hash: "" }));
vi.mock("@tanstack/react-router", () => ({
  useLocation: (opts?: { select?: (l: { hash: string }) => unknown }) =>
    opts?.select ? opts.select(mockLocation) : mockLocation,
  useNavigate: () => vi.fn(),
}));

const mockCronData = vi.hoisted(() => ({
  current: { entries: [] as CronEntry[], deliveries: [] as CronDelivery[] },
}));
vi.mock("@/hooks/use-cron", () => ({
  useCronData: () => mockCronData.current,
}));

function entry(overrides: Partial<CronEntry> & { id: string }): CronEntry {
  return {
    name: overrides.id,
    schedule: { kind: "every", interval: "5m" },
    target: { kind: "role", role: "operator" },
    payload: "ping",
    lastFired: 0,
    ...overrides,
  };
}

function renderZone(sessions: ProjectSession[] = [makeSession()]) {
  return render(
    <StandaloneSessionContextProvider
      value={{
        servers: [{ name: "srv1", sessionCount: sessions.length }],
        serversLoaded: true,
        sessionsByServer: new Map([["srv1", sessions]]),
      }}
    >
      <CronZone server="srv1" />
    </StandaloneSessionContextProvider>,
  );
}

describe("cronZoneSide", () => {
  it("reads `no entries` for an empty registry", () => {
    expect(cronZoneSide([], NOW)).toBe("no entries");
  });

  it("counts entries and names the soonest next fire", () => {
    const entries = [
      entry({ id: "a", nextFire: NOW + 300 }),
      entry({ id: "b" }),
      entry({ id: "c", nextFire: NOW + 60 }),
    ];
    expect(cronZoneSide(entries, NOW)).toBe("3 entries · next in 1m");
  });

  it("reads `next due` for a past-due soonest fire and singular `entry` for one", () => {
    expect(cronZoneSide([entry({ id: "a", nextFire: NOW - 5 })], NOW)).toBe("1 entry · next due");
  });

  it("drops the suffix when no entry carries a next fire", () => {
    expect(cronZoneSide([entry({ id: "a" }), entry({ id: "b" })], NOW)).toBe("2 entries");
  });
});

describe("CronZone", () => {
  // jsdom implements no scrollIntoView; the stub records the mount effect's call.
  const scrollIntoView = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    scrollIntoView.mockClear();
    Element.prototype.scrollIntoView = scrollIntoView;
    mockLocation.hash = "";
    mockCronData.current = { entries: [], deliveries: [] };
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the Cron heading, the side slot, and the registry without the inline variant", () => {
    mockCronData.current = {
      entries: [entry({ id: "a3f9", name: "nightly", nextFire: NOW + 300 }), entry({ id: "b2", name: "later" })],
      deliveries: [],
    };
    renderZone();

    const root = screen.getByTestId("clock-zone-cron");
    expect(root.id).toBe("cron");
    expect(root).toHaveTextContent("Cron");
    expect(root).toHaveTextContent("2 entries · next in 5m");
    expect(screen.getByTestId("cron-list")).toBeInTheDocument();
    expect(screen.getByTestId("cron-list-row-a3f9")).toBeInTheDocument();
    expect(screen.getByTestId("cron-list-new")).toBeInTheDocument();
    // No `inline`: the list root is not the sheet's relative anchor.
    expect(screen.getByTestId("cron-list")).not.toHaveClass("relative");
    expect(screen.queryByTestId("cron-activity-banner")).toBeNull();
  });

  it("renders `no entries` and the list's own empty hint for an empty registry", () => {
    renderZone();
    expect(screen.getByTestId("clock-zone-cron")).toHaveTextContent("no entries");
    expect(screen.getByText("Agents can schedule prompts too — rk cron add.")).toBeInTheDocument();
  });

  it("mounts the staleness banner above the list when a session reports operatorStale", () => {
    renderZone([makeSession({ operatorStale: true, operatorLastTickAt: NOW - 1200 })]);
    const banner = screen.getByTestId("cron-activity-banner");
    expect(banner).toHaveTextContent("operator loop — last check 20m ago");
    const list = screen.getByTestId("cron-list");
    expect(banner.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("scrolls itself into view once on mount only when the location hash is `cron`", () => {
    mockLocation.hash = "cron";
    const { rerender } = renderZone();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });

    rerender(
      <StandaloneSessionContextProvider
        value={{
          servers: [{ name: "srv1", sessionCount: 1 }],
          serversLoaded: true,
          sessionsByServer: new Map([["srv1", [makeSession()]]]),
        }}
      >
        <CronZone server="srv1" />
      </StandaloneSessionContextProvider>,
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("does not scroll without the hash", () => {
    renderZone();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("scrolls again when the server changes under the same hash (the page stays mounted across /one#cron → /two#cron)", () => {
    mockLocation.hash = "cron";
    const tree = (server: string) => (
      <StandaloneSessionContextProvider
        value={{
          servers: [{ name: server, sessionCount: 1 }],
          serversLoaded: true,
          sessionsByServer: new Map([[server, [makeSession()]]]),
        }}
      >
        <CronZone server={server} />
      </StandaloneSessionContextProvider>
    );
    const { rerender } = render(tree("one"));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    rerender(tree("two"));
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    rerender(tree("two"));
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });
});
