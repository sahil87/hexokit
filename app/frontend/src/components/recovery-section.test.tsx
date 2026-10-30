import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import type { RecoveryOffer } from "@/api/client";
import { ThemeProvider } from "@/contexts/theme-context";
import { stubMatchMedia } from "@/test-utils/match-media";

// --- API client mock. Partial (importActual) so the ThemeProvider's real
// theme-preference helpers stay available; only the recovery calls are stubbed.
vi.mock("@/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/api/client")>("@/api/client");
  return {
    ...actual,
    getRecoveryOffers: vi.fn().mockResolvedValue([]),
    restoreRecoveryServer: vi.fn().mockResolvedValue({}),
    dismissRecoveryServer: vi.fn().mockResolvedValue({ ok: true }),
  };
});

// --- Toast mock. ---
const addToastMock = vi.fn();
vi.mock("@/components/toast", () => ({
  useToast: () => ({ addToast: addToastMock }),
}));

// --- SessionContext mock: the hook refreshes the live server list after a
// successful restore (the create-server flow's precedent). ---
const refreshServersMock = vi.fn();
vi.mock("@/contexts/session-context", () => ({
  useSessionContext: () => ({ refreshServers: refreshServersMock }),
}));

import { getRecoveryOffers, restoreRecoveryServer, dismissRecoveryServer } from "@/api/client";
import { RecoverySection, useRecoveryOffers } from "./recovery-section";

function makeOffer(server: string, overrides: Partial<RecoveryOffer> = {}): RecoveryOffer {
  return {
    server,
    takenAt: new Date(Date.now() - 3600_000).toISOString(),
    sessionCount: 1,
    windowCount: 2,
    sessions: [
      {
        name: "dev",
        color: "4",
        windows: [
          { index: 0, name: "shell", paneCount: 1, commands: ["zsh"], resumable: false },
          { index: 1, name: "agent", paneCount: 2, commands: ["zsh", "claude -c"], resumable: true },
        ],
      },
    ],
    ...overrides,
  };
}

/** The page-shape harness: one hook instance feeding the section (the page
 *  additionally feeds the same state to the palette registration). */
function Harness() {
  const recovery = useRecoveryOffers();
  return <RecoverySection recovery={recovery} />;
}

function renderSection() {
  return render(
    <ThemeProvider>
      <Harness />
    </ThemeProvider>,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRecoveryOffers).mockResolvedValue([]);
  vi.mocked(restoreRecoveryServer).mockResolvedValue({});
  vi.mocked(dismissRecoveryServer).mockResolvedValue({ ok: true });
  stubMatchMedia((query) => !query.includes("pointer: coarse"));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RecoverySection", () => {
  it("renders zero footprint when there are no offers (no heading, no section, no reserved space)", async () => {
    const { container } = renderSection();
    // Wait for the mount fetch to settle before asserting absence.
    await waitFor(() => expect(getRecoveryOffers).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("region", { name: "Recovery" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Recovery" })).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("stays hidden when the offers fetch fails (old/unreachable daemon)", async () => {
    vi.mocked(getRecoveryOffers).mockRejectedValue(new Error("boom"));
    renderSection();
    await waitFor(() => expect(getRecoveryOffers).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Recovery" })).not.toBeInTheDocument(),
    );
  });

  it("renders one row per offer with hollow dot, name, meta line, Restore, ×, and chevron", async () => {
    vi.mocked(getRecoveryOffers).mockResolvedValue([makeOffer("kit")]);
    renderSection();

    await screen.findByRole("region", { name: "Recovery" });
    expect(screen.getByRole("heading", { name: "Recovery" })).toBeInTheDocument();
    const row = screen.getByTestId("recovery-row-kit");
    expect(row).toHaveTextContent("kit");
    expect(within(row).getByRole("img", { name: "not running" })).toBeInTheDocument();
    expect(row).toHaveTextContent("1 group · 2 tabs · last seen 1h ago · system restart");
    expect(within(row).getByRole("button", { name: "Restore kit" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Dismiss recovery for kit" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Show layout for kit" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    // The bulk buttons ride the heading only when MORE THAN ONE offer exists.
    expect(screen.queryByRole("button", { name: /Restore all/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss all" })).not.toBeInTheDocument();
  });

  it("shows Restore all (N) and Dismiss all in the heading side slot when more than one offer exists", async () => {
    vi.mocked(getRecoveryOffers).mockResolvedValue([makeOffer("kit"), makeOffer("work")]);
    renderSection();
    expect(
      await screen.findByRole("button", { name: "Restore all (2)" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss all" })).toBeInTheDocument();
  });

  it("expands the chevron to the read-only session tree (swatch, windows, commands, resumable tag)", async () => {
    vi.mocked(getRecoveryOffers).mockResolvedValue([makeOffer("kit")]);
    renderSection();

    const toggle = await screen.findByRole("button", { name: "Show layout for kit" });
    expect(screen.queryByText("resumable")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const tree = screen.getByTestId("recovery-session-dev");
    expect(tree).toHaveTextContent("dev");
    expect(tree).toHaveTextContent("0: shell · 1 pane");
    expect(tree).toHaveTextContent("1: agent · 2 panes");
    expect(tree).toHaveTextContent("zsh, claude -c");
    // Only the agent window is tagged; the tag is display-only (no affordance).
    expect(within(tree).getByText("resumable")).toBeInTheDocument();
    expect(within(tree).queryByRole("button")).toBeNull();

    fireEvent.click(toggle);
    expect(screen.queryByText("resumable")).not.toBeInTheDocument();
  });

  it("restore: shows restoring… in flight, then removes the row, refetches offers, and refreshes the live server list", async () => {
    // Mount fetch returns the offer; the post-restore refetch returns none
    // (the backend drops the offer once its server is restored).
    vi.mocked(getRecoveryOffers)
      .mockResolvedValueOnce([makeOffer("kit")])
      .mockResolvedValue([]);
    const restoreCall = deferred<Record<string, unknown>>();
    vi.mocked(restoreRecoveryServer).mockReturnValue(restoreCall.promise);
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Restore kit" }));
    expect(restoreRecoveryServer).toHaveBeenCalledWith("kit");
    // Indeterminate per-row state while the POST is in flight.
    expect(await screen.findByText("restoring…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore kit" })).not.toBeInTheDocument();
    expect(screen.getByTestId("recovery-row-kit")).toBeInTheDocument();

    restoreCall.resolve({});
    await waitFor(() =>
      expect(screen.queryByTestId("recovery-row-kit")).not.toBeInTheDocument(),
    );
    // The section collapses to zero footprint with the last row gone.
    expect(screen.queryByRole("region", { name: "Recovery" })).not.toBeInTheDocument();
    // Mount fetch + post-mutation refetch.
    await waitFor(() => expect(getRecoveryOffers).toHaveBeenCalledTimes(2));
    expect(refreshServersMock).toHaveBeenCalledTimes(1);
  });

  it("restore failure: the row returns to rest and the error surfaces via toast", async () => {
    vi.mocked(getRecoveryOffers).mockResolvedValue([makeOffer("kit")]);
    const restoreCall = deferred<Record<string, unknown>>();
    vi.mocked(restoreRecoveryServer).mockReturnValue(restoreCall.promise);
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Restore kit" }));
    expect(await screen.findByText("restoring…")).toBeInTheDocument();

    restoreCall.reject(new Error("server already alive"));
    // Back at rest: the buttons return and the row stays.
    expect(await screen.findByRole("button", { name: "Restore kit" })).toBeInTheDocument();
    expect(screen.getByTestId("recovery-row-kit")).toBeInTheDocument();
    expect(addToastMock).toHaveBeenCalledWith("server already alive");
    expect(refreshServersMock).not.toHaveBeenCalled();
  });

  it("dismiss: POSTs and removes the row on success", async () => {
    // The post-dismiss refetch returns the remaining offer.
    vi.mocked(getRecoveryOffers)
      .mockResolvedValueOnce([makeOffer("kit"), makeOffer("work")])
      .mockResolvedValue([makeOffer("work")]);
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Dismiss recovery for kit" }));
    expect(dismissRecoveryServer).toHaveBeenCalledWith("kit");
    await waitFor(() =>
      expect(screen.queryByTestId("recovery-row-kit")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("recovery-row-work")).toBeInTheDocument();
    await waitFor(() => expect(getRecoveryOffers).toHaveBeenCalledTimes(2));
  });

  it("dismiss failure keeps the row and toasts", async () => {
    vi.mocked(getRecoveryOffers).mockResolvedValue([makeOffer("kit")]);
    vi.mocked(dismissRecoveryServer).mockRejectedValue(new Error("nope"));
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Dismiss recovery for kit" }));
    await waitFor(() => expect(addToastMock).toHaveBeenCalledWith("nope"));
    expect(screen.getByTestId("recovery-row-kit")).toBeInTheDocument();
  });

  it("Restore all runs SEQUENTIAL per-server restores (no bulk endpoint)", async () => {
    // Mount fetch returns both offers; post-restore refetches return none.
    vi.mocked(getRecoveryOffers)
      .mockResolvedValueOnce([makeOffer("kit"), makeOffer("work")])
      .mockResolvedValue([]);
    const first = deferred<Record<string, unknown>>();
    const order: string[] = [];
    vi.mocked(restoreRecoveryServer).mockImplementation((server) => {
      order.push(server);
      return order.length === 1 ? first.promise : Promise.resolve({});
    });
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Restore all (2)" }));
    // Only the first restore is in flight — the second has NOT started.
    await waitFor(() => expect(order).toEqual(["kit"]));
    expect(await screen.findByText("restoring…")).toBeInTheDocument();
    expect(screen.getByTestId("recovery-row-work")).toBeInTheDocument();

    first.resolve({});
    await waitFor(() => expect(order).toEqual(["kit", "work"]));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Recovery" })).not.toBeInTheDocument(),
    );
    expect(refreshServersMock).toHaveBeenCalledTimes(2);
  });

  it("Dismiss all runs SEQUENTIAL per-server dismisses (no bulk endpoint)", async () => {
    // Mount fetch returns both offers; post-dismiss refetches return none.
    vi.mocked(getRecoveryOffers)
      .mockResolvedValueOnce([makeOffer("kit"), makeOffer("work")])
      .mockResolvedValue([]);
    const first = deferred<{ ok: boolean }>();
    const order: string[] = [];
    vi.mocked(dismissRecoveryServer).mockImplementation((server) => {
      order.push(server);
      return order.length === 1 ? first.promise : Promise.resolve({ ok: true });
    });
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Dismiss all" }));
    // Only the first dismiss is in flight — the second has NOT started.
    await waitFor(() => expect(order).toEqual(["kit"]));
    expect(screen.getByTestId("recovery-row-work")).toBeInTheDocument();

    first.resolve({ ok: true });
    await waitFor(() => expect(order).toEqual(["kit", "work"]));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Recovery" })).not.toBeInTheDocument(),
    );
    expect(refreshServersMock).not.toHaveBeenCalled();
  });

  it("Dismiss all continues past a mid-loop failure: the failed server toasts, the rest still dismiss", async () => {
    // The failed server (`work`) survives — the refetch still offers it.
    vi.mocked(getRecoveryOffers)
      .mockResolvedValueOnce([makeOffer("kit"), makeOffer("work"), makeOffer("ops")])
      .mockResolvedValue([makeOffer("work")]);
    const order: string[] = [];
    vi.mocked(dismissRecoveryServer).mockImplementation((server) => {
      order.push(server);
      return server === "work"
        ? Promise.reject(new Error("nope"))
        : Promise.resolve({ ok: true });
    });
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Dismiss all" }));
    // The failure on `work` toasts but does NOT block `ops`.
    await waitFor(() => expect(order).toEqual(["kit", "work", "ops"]));
    await waitFor(() => expect(addToastMock).toHaveBeenCalledWith("nope"));
    await waitFor(() =>
      expect(screen.queryByTestId("recovery-row-kit")).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId("recovery-row-ops")).not.toBeInTheDocument();
    expect(screen.getByTestId("recovery-row-work")).toBeInTheDocument();
  });
});
