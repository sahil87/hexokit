import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { CronEntryDetailSheet } from "./cron-entry-detail-sheet";
import type { CronDelivery, CronEntry } from "@/api/client";
import { _resetForTests as resetOverlayPresence, count as overlayCount } from "@/lib/overlay-presence";

const ENTRY: CronEntry = {
  id: "a3f9",
  name: "operator tick",
  schedule: { kind: "backoff", min: "60s", max: "30m" },
  target: { kind: "role", role: "operator" },
  payload: "tick",
  lastFired: 0,
  muted: false,
  pinned: false,
};

type RecordedCall = { url: string; body: Record<string, unknown> };

function installFetch() {
  const calls: RecordedCall[] = [];
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", stub);
  return { stub, calls };
}

function renderSheet(entry: CronEntry = ENTRY, onClose = vi.fn()) {
  render(<CronEntryDetailSheet server="srv" entry={entry} onClose={onClose} />);
  return onClose;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LOOP_ENTRY: CronEntry = {
  id: "lp01",
  name: "operator loop",
  run: "operator-loop",
  schedule: { kind: "backoff", min: "3m", max: "24m" },
  target: { kind: "" },
  payload: "",
  lastFired: 0,
  pinned: true,
};

const RAN: CronDelivery = {
  ts: 1_800_000_000,
  entry: "lp01",
  name: "operator loop",
  target: "",
  reason: "schedule",
  outcome: "ran · nudged pr-41, noted · 2m13s",
  run: "20261112T101500-ab12",
  runLog: "/state/hexokit/operator/runs/s/20261112T101500-ab12.log",
  transcript: "/state/transcripts/ab12.jsonl",
};

describe("CronEntryDetailSheet run fields", () => {
  it("shows run id, outcome, run log and transcript as copyable text for a run delivery", async () => {
    installFetch();
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<CronEntryDetailSheet server="srv" entry={LOOP_ENTRY} delivery={RAN} onClose={vi.fn()} />);
    expect(screen.getByTestId("cron-entry-run-id")).toHaveTextContent("20261112T101500-ab12");
    expect(screen.getByTestId("cron-entry-run-outcome")).toHaveTextContent("ran · nudged pr-41, noted · 2m13s");
    expect(screen.getByTestId("cron-entry-run-log")).toHaveTextContent("/state/hexokit/operator/runs/s/20261112T101500-ab12.log");
    expect(screen.getByTestId("cron-entry-run-transcript")).toHaveTextContent("/state/transcripts/ab12.jsonl");
    // Copyable: selectable text plus a Copy button writing the value.
    expect(screen.getByTestId("cron-entry-run-log")).toHaveClass("select-all");
    fireEvent.click(screen.getByRole("button", { name: "Copy run log" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(RAN.runLog));
  });

  it("omits the transcript row when the run has none and the whole block without a run", () => {
    installFetch();
    const { runLog, ...rest } = RAN;
    render(
      <CronEntryDetailSheet
        server="srv"
        entry={LOOP_ENTRY}
        delivery={{ ...rest, transcript: undefined, runLog }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("cron-entry-run-log")).toBeInTheDocument();
    expect(screen.queryByTestId("cron-entry-run-transcript")).toBeNull();
    cleanup();
    render(
      <CronEntryDetailSheet
        server="srv"
        entry={LOOP_ENTRY}
        delivery={{ ...RAN, run: undefined, outcome: "no change" }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("cron-entry-run")).toBeNull();
  });

  it("describes the loop entry's schedule in loop words", () => {
    installFetch();
    renderSheet(LOOP_ENTRY);
    expect(
      screen.getByText("checks tracked items, backing off from 3 minutes up to 24 minutes while nothing changes"),
    ).toBeInTheDocument();
  });
});

describe("CronEntryDetailSheet", () => {
  it("renders the alarm-app anatomy: name, plain-words schedule, never/unknown last/next", () => {
    installFetch();
    renderSheet();
    expect(screen.getByRole("dialog", { name: "Cron entry operator tick" })).toBeInTheDocument();
    expect(screen.getByText("backs off from 1 minute up to 30 minutes since last activity")).toBeInTheDocument();
    expect(screen.getByTestId("cron-entry-last-fired")).toHaveTextContent("never");
    expect(screen.getByTestId("cron-entry-next-fire")).toHaveTextContent("unknown");
  });

  it("renders the Deliver fact row as the describeDeliver sentence", () => {
    installFetch();
    renderSheet({ ...ENTRY, deliver: "when-idle" });
    expect(screen.getByTestId("cron-entry-deliver")).toHaveTextContent(
      "held until the agent is idle (up to 2h)",
    );
    cleanup();
    renderSheet();
    expect(screen.getByTestId("cron-entry-deliver")).toHaveTextContent("delivered immediately");
  });

  it("mute toggle POSTs the flipped value and reflects it optimistically", async () => {
    const { calls } = installFetch();
    renderSheet();
    const toggle = screen.getByRole("switch", { name: "Mute entry" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    // Optimistic: the switch reflects the new state before the POST resolves.
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await waitFor(() =>
      expect(calls).toEqual([
        { url: "/api/cron/mute?server=srv", body: { id: "a3f9", muted: true } },
      ]),
    );
  });

  it("pin row POSTs {id, pinned: true} and reflects it optimistically", async () => {
    const { calls } = installFetch();
    renderSheet();
    const toggle = screen.getByRole("switch", { name: "Pin entry" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await waitFor(() =>
      expect(calls).toEqual([
        { url: "/api/cron/pin?server=srv", body: { id: "a3f9", pinned: true } },
      ]),
    );
  });

  it("delete requires the confirm step, POSTs {id}, then closes", async () => {
    const { calls } = installFetch();
    const onClose = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Delete entry" }));
    // The confirm step replaces the plain row; nothing has fired yet.
    expect(screen.getByText("Delete this entry?")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(calls).toEqual([{ url: "/api/cron/delete?server=srv", body: { id: "a3f9" } }]),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("delete Cancel backs out without firing", () => {
    const { calls } = installFetch();
    renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Delete entry" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Delete entry" })).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("a failed mute reverts the optimistic toggle and shows the error inline", async () => {
    const stub = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "unknown entry" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", stub);
    renderSheet();
    const toggle = screen.getByRole("switch", { name: "Mute entry" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
    expect(screen.getByRole("alert")).toHaveTextContent("unknown entry");
  });

  it("the default variant is modal: fixed backdrop, aria-modal, and the ✕ close control", () => {
    installFetch();
    const { container } = render(
      <CronEntryDetailSheet server="srv" entry={ENTRY} onClose={vi.fn()} />,
    );

    const sheet = screen.getByTestId("cron-entry-sheet");
    expect(sheet.className).toContain("fixed inset-0");
    // The full-viewport backdrop sibling.
    expect(container.querySelector(".bg-black\\/50")).not.toBeNull();
    expect(screen.getByRole("dialog", { name: "Cron entry operator tick" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
    expect(screen.getByRole("button", { name: "Close entry details" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("the modal variant registers as a modal overlay while mounted; the inline variant does not", () => {
    installFetch();
    resetOverlayPresence();
    const modal = render(<CronEntryDetailSheet server="srv" entry={ENTRY} onClose={vi.fn()} />);
    expect(overlayCount("modal")).toBe(1);
    modal.unmount();
    expect(overlayCount("modal")).toBe(0);

    render(<CronEntryDetailSheet server="srv" entry={ENTRY} onClose={vi.fn()} inline />);
    expect(overlayCount("modal")).toBe(0);
  });

  it("the inline variant drops the modal shell: no backdrop, no aria-modal, absolute inset-0 panel", () => {
    installFetch();
    const { container } = render(
      <CronEntryDetailSheet server="srv" entry={ENTRY} onClose={vi.fn()} inline />,
    );

    const sheet = screen.getByTestId("cron-entry-sheet");
    expect(sheet.className).toContain("absolute inset-0");
    expect(container.querySelector(".fixed")).toBeNull();
    const dialog = screen.getByRole("dialog", { name: "Cron entry operator tick" });
    expect(dialog).not.toHaveAttribute("aria-modal");
    // The ✕ close control is replaced by the back control.
    expect(screen.queryByRole("button", { name: "Close entry details" })).toBeNull();
  });

  it("the inline ‹ Back control calls onClose", () => {
    installFetch();
    const onClose = vi.fn();
    render(<CronEntryDetailSheet server="srv" entry={ENTRY} onClose={onClose} inline />);

    const back = screen.getByRole("button", { name: "Back" });
    expect(back).toHaveTextContent("‹ Back");
    fireEvent.click(back);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape inside the inline panel closes the sheet and claims the key (defaultPrevented)", () => {
    installFetch();
    const onClose = vi.fn();
    render(<CronEntryDetailSheet server="srv" entry={ENTRY} onClose={onClose} inline />);

    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("the Edit row opens the create dialog in edit mode", async () => {
    installFetch();
    renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(await screen.findByRole("dialog", { name: "Edit entry" })).toBeInTheDocument();
    // Edit mode: read-only payload, prefilled name.
    expect(screen.getByTestId("cron-edit-payload")).toHaveTextContent("tick");
    expect(screen.getByLabelText("Name")).toHaveValue("operator tick");
  });

  it("Mute for… presets POST mute with the additive `for` lease field", async () => {
    const { calls } = installFetch();
    renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Mute for…" }));
    fireEvent.click(screen.getByRole("button", { name: "2h" }));
    // Optimistic: the switch reflects muted before the POST resolves.
    expect(screen.getByRole("switch", { name: "Mute entry" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await waitFor(() =>
      expect(calls).toEqual([
        { url: "/api/cron/mute?server=srv", body: { id: "a3f9", muted: true, for: "2h" } },
      ]),
    );
  });

  it("`until unmuted` and unmute send NO `for` field", async () => {
    const { calls } = installFetch();
    renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Mute for…" }));
    fireEvent.click(screen.getByRole("button", { name: "until unmuted" }));
    await waitFor(() =>
      expect(calls).toEqual([
        { url: "/api/cron/mute?server=srv", body: { id: "a3f9", muted: true } },
      ]),
    );
    cleanup();

    // Unmute (switch off from a muted entry) carries no `for` either.
    renderSheet({ ...ENTRY, muted: true });
    fireEvent.click(screen.getByRole("switch", { name: "Mute entry" }));
    await waitFor(() =>
      expect(calls).toEqual([
        { url: "/api/cron/mute?server=srv", body: { id: "a3f9", muted: true } },
        { url: "/api/cron/mute?server=srv", body: { id: "a3f9", muted: false } },
      ]),
    );
  });

  it("the Mute for… row is hidden while muted (the switch is the unmute path)", () => {
    installFetch();
    renderSheet({ ...ENTRY, muted: true });
    expect(screen.queryByRole("button", { name: "Mute for…" })).toBeNull();
  });
});
