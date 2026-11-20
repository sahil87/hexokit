import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/react";
import { postOperatorNote, postOperatorWake } from "@/api/client";
import type { NeedsYouRow } from "@/components/server-watched-zone/model";
import { NeedsYouBand } from "./needs-you-band";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, postOperatorNote: vi.fn(), postOperatorWake: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const WAITING: NeedsYouRow = {
  kind: "waiting",
  id: "w1",
  action: "answer the prompt in builder",
  windowId: "@2",
  updatedAt: 1,
};
const ESCALATION: NeedsYouRow = {
  kind: "escalation",
  id: "pr-41",
  action: "spawn interrupted: x",
  updatedAt: 2,
};

function renderBand(rows: NeedsYouRow[], server = "work") {
  const onNavigate = vi.fn();
  const onSaved = vi.fn();
  render(<NeedsYouBand rows={rows} server={server} onNavigate={onNavigate} onSaved={onSaved} />);
  return { onNavigate, onSaved };
}

describe("NeedsYouBand", () => {
  it("renders nothing with zero needs", () => {
    renderBand([]);
    expect(screen.queryByTestId("needs-you-band")).toBeNull();
  });

  it("headers the count and renders one row per need with its id and action", () => {
    renderBand([WAITING, ESCALATION]);
    expect(screen.getByTestId("needs-you-band")).toHaveTextContent("Needs you · 2");
    const rows = screen.getAllByTestId("needs-you-row");
    expect(rows.map((r) => r.getAttribute("data-item-id"))).toEqual(["w1", "pr-41"]);
    expect(rows[0]).toHaveTextContent("answer the prompt in builder");
    expect(rows[1]).toHaveTextContent("spawn interrupted: x");
  });

  it("open pane appears only on rows with a window and navigates to it", () => {
    const { onNavigate } = renderBand([WAITING, ESCALATION]);
    const [waiting, escalation] = screen.getAllByTestId("needs-you-row");
    expect(within(escalation).queryByTestId("needs-you-open-pane")).toBeNull();
    fireEvent.click(within(waiting).getByTestId("needs-you-open-pane"));
    expect(onNavigate).toHaveBeenCalledWith("@2");
  });

  it("note… opens the composer in place under that row only", () => {
    renderBand([WAITING, ESCALATION]);
    const [waiting, escalation] = screen.getAllByTestId("needs-you-row");
    fireEvent.click(within(escalation).getByTestId("needs-you-note"));
    expect(within(escalation).getByTestId("operator-note-composer")).toBeInTheDocument();
    expect(within(waiting).queryByTestId("operator-note-composer")).toBeNull();
  });

  it("a saved note closes the composer and hands the status to the host", async () => {
    vi.mocked(postOperatorNote).mockResolvedValue({ at: 1, by: "user", text: "ok" });
    vi.mocked(postOperatorWake).mockResolvedValue(undefined);
    const { onSaved } = renderBand([ESCALATION]);
    fireEvent.click(screen.getByTestId("needs-you-note"));
    fireEvent.change(screen.getByTestId("operator-note-input"), { target: { value: "ok" } });
    fireEvent.click(screen.getByTestId("operator-note-save"));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("note saved · check queued"));
    expect(screen.queryByTestId("operator-note-composer")).toBeNull();
    expect(postOperatorWake).toHaveBeenCalledWith("work", "note:pr-41");
  });

  it("offers no note… without a server", () => {
    renderBand([ESCALATION], "");
    expect(screen.queryByTestId("needs-you-note")).toBeNull();
  });
});
