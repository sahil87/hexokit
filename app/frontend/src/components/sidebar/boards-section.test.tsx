import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

// Router mock: capture navigate + drive useActiveBoardName off a fixed pathname.
const mockNavigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockNavigate,
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/board/review" } }),
}));

// useBoards seam: the real hook needs the SessionContext SSE pool; mock at the
// hook boundary. useBoardListReorder (the drag hook under test for wiring) stays
// REAL — it only touches @/api/boards on drag, which is mocked below.
let mockBoards: { name: string; pinCount: number }[] = [];
vi.mock("@/hooks/use-boards", () => ({
  useBoards: () => ({ boards: mockBoards, isLoading: false, error: null }),
}));

// API seam: pinWindow (drag-to-pin drop) and setBoardOrder (reorder write) are
// the two observable mutation calls the drop handlers dispatch between.
vi.mock("@/api/boards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/boards")>();
  return {
    ...actual,
    pinWindow: vi.fn().mockResolvedValue(undefined),
    setBoardOrder: vi.fn().mockResolvedValue(undefined),
  };
});
import { pinWindow, setBoardOrder } from "@/api/boards";
const pinWindowMock = vi.mocked(pinWindow);
const setBoardOrderMock = vi.mocked(setBoardOrder);

// Toast seam: BoardsSection wires useToast().addToast into useBoardListReorder as
// the reorder-POST onError handler (and usePinActions surfaces pin feedback
// through it). Mock at the hook boundary (mirrors the Host host-overview-page
// test) so no ToastProvider tree is needed here.
const addToastMock = vi.fn();
vi.mock("@/components/toast", () => ({
  useToast: () => ({ addToast: addToastMock }),
}));

import { BoardsSection } from "./boards-section";

/** A minimal mutable dataTransfer bag, mirroring index.test.tsx's
 *  makeDataTransfer. */
function makeDataTransfer(types: string[] = []) {
  const store = new Map<string, string>();
  const t = [...types];
  return {
    setData: (type: string, data: string) => {
      store.set(type, data);
      if (!t.includes(type)) t.push(type);
    },
    getData: (type: string) => store.get(type) ?? "",
    get types() {
      return t;
    },
    dropEffect: "none",
    effectAllowed: "none",
  };
}

const WINDOW_DRAG_MIME = "application/x-window-drag";
const BOARD_LIST_REORDER_MIME = "application/x-board-list-reorder";

afterEach(() => {
  cleanup();
  mockBoards = [];
  mockNavigate.mockClear();
  pinWindowMock.mockClear();
  setBoardOrderMock.mockClear();
  addToastMock.mockClear();
  localStorage.clear();
});

describe("BoardsSection — reorder wiring", () => {
  it("renders board rows as draggable buttons (useBoardListReorder wiring)", () => {
    mockBoards = [
      { name: "deploys", pinCount: 2 },
      { name: "review", pinCount: 1 },
    ];
    render(<BoardsSection />);

    const deploys = screen.getByText("deploys").closest("button");
    expect(deploys).not.toBeNull();
    expect(deploys).toHaveAttribute("draggable", "true");
    const review = screen.getByText("review").closest("button");
    expect(review).toHaveAttribute("draggable", "true");
  });

  it("marks the active board's row with aria-current=page", () => {
    mockBoards = [
      { name: "deploys", pinCount: 2 },
      { name: "review", pinCount: 1 },
    ];
    render(<BoardsSection />);
    // Router pathname mock → /board/review, so "review" is active.
    const review = screen.getByText("review").closest("button");
    expect(review).toHaveAttribute("aria-current", "page");
    const deploys = screen.getByText("deploys").closest("button");
    expect(deploys).not.toHaveAttribute("aria-current");
  });

  it("shows the pin-to-start hint (no draggable rows) when no boards exist", () => {
    render(<BoardsSection />);
    expect(screen.getByText("Pin a window to start a board")).toBeInTheDocument();
  });
});

describe("BoardsSection — default-open + header PinIcon", () => {
  it("defaults open when boards exist (no stored preference)", () => {
    mockBoards = [{ name: "deploys", pinCount: 2 }];
    render(<BoardsSection />);
    // The CollapsiblePanel toggle exposes aria-expanded; boards present → open.
    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument();
  });

  it("defaults closed when no boards exist (no stored preference)", () => {
    render(<BoardsSection />);
    expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument();
  });

  it("respects a stored collapse preference over the board-count default", () => {
    // User explicitly collapsed → stored 'false' wins even with boards present.
    localStorage.setItem("hexokit-panel-boards", "false");
    mockBoards = [{ name: "deploys", pinCount: 2 }];
    render(<BoardsSection />);
    expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument();
  });

  it("renders the shared PinIcon in the header with boards present", () => {
    mockBoards = [{ name: "deploys", pinCount: 2 }];
    const { container } = render(<BoardsSection />);
    // PinIcon is a 16-viewBox inline SVG (aria-hidden); assert one is present.
    expect(container.querySelector('svg[viewBox="0 0 16 16"]')).not.toBeNull();
    // Count still rendered alongside the icon.
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("renders the header PinIcon even in zero-board hint mode", () => {
    const { container } = render(<BoardsSection />);
    expect(container.querySelector('svg[viewBox="0 0 16 16"]')).not.toBeNull();
  });
});

describe("BoardsSection — window drag-to-pin (g0t1)", () => {
  const TWO_BOARDS = [
    { name: "deploys", pinCount: 2 },
    { name: "review", pinCount: 1 },
  ];

  function boardRow(name: string): HTMLElement {
    const row = screen.getByText(name).closest("button");
    expect(row).not.toBeNull();
    return row!;
  }

  it("accepts a window-drag dragover: preventDefault, copy cursor, drop-target ring", () => {
    mockBoards = TWO_BOARDS;
    render(<BoardsSection />);
    const row = boardRow("deploys");

    const dataTransfer = makeDataTransfer([WINDOW_DRAG_MIME]);
    // fireEvent returns false when the handler preventDefault()ed.
    const accepted = fireEvent.dragOver(row, { dataTransfer }) === false;
    expect(accepted).toBe(true);
    expect(dataTransfer.dropEffect).toBe("copy");
    // Drop-target ring mirrors session-row.tsx's isSessionDropTarget styling.
    expect(row.getAttribute("style")).toContain("box-shadow");
  });

  it("clears the drop-target ring on dragleave", () => {
    mockBoards = TWO_BOARDS;
    render(<BoardsSection />);
    const row = boardRow("deploys");

    const dataTransfer = makeDataTransfer([WINDOW_DRAG_MIME]);
    fireEvent.dragOver(row, { dataTransfer });
    expect(row.getAttribute("style")).toContain("box-shadow");

    fireEvent.dragLeave(row);
    expect(row.getAttribute("style") ?? "").not.toContain("box-shadow");
  });

  it("drop parses the JSON payload and pins (server, windowId, board) with no reorder", async () => {
    mockBoards = TWO_BOARDS;
    render(<BoardsSection />);
    const row = boardRow("review");

    const dataTransfer = makeDataTransfer([WINDOW_DRAG_MIME]);
    dataTransfer.setData(
      "application/json",
      JSON.stringify({ server: "primary", session: "main", index: 0, windowId: "@5", name: "editor" }),
    );
    fireEvent.dragOver(row, { dataTransfer });
    fireEvent.drop(row, { dataTransfer });

    await waitFor(() =>
      expect(pinWindowMock).toHaveBeenCalledWith("primary", "@5", "review"),
    );
    // Pin success feedback rides the shared usePinActions toast.
    await waitFor(() =>
      expect(addToastMock).toHaveBeenCalledWith(
        "Pinned to review",
        "info",
        expect.objectContaining({ label: "View board" }),
      ),
    );
    // A window drop never disturbs board order.
    expect(setBoardOrderMock).not.toHaveBeenCalled();
    // Ring cleared on drop.
    expect(row.getAttribute("style") ?? "").not.toContain("box-shadow");
  });

  it("ignores a drop whose JSON payload is malformed (no pin, no throw)", () => {
    mockBoards = TWO_BOARDS;
    render(<BoardsSection />);
    const row = boardRow("review");

    const dataTransfer = makeDataTransfer([WINDOW_DRAG_MIME]);
    dataTransfer.setData("application/json", "{not json");
    fireEvent.drop(row, { dataTransfer });

    expect(pinWindowMock).not.toHaveBeenCalled();
  });

  it("a board-list-reorder drag still reorders and never pins", () => {
    mockBoards = TWO_BOARDS;
    render(<BoardsSection />);
    const deploys = boardRow("deploys");
    const review = boardRow("review");

    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(deploys, { dataTransfer });
    expect(dataTransfer.types).toContain(BOARD_LIST_REORDER_MIME);

    fireEvent.dragOver(review, { dataTransfer });
    fireEvent.drop(review, { dataTransfer });

    // Reorder flushed on drop: insert-before semantics → ["review", "deploys"].
    expect(setBoardOrderMock).toHaveBeenCalledWith(["review", "deploys"]);
    expect(pinWindowMock).not.toHaveBeenCalled();
  });
});
