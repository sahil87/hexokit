import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useEffect, useRef, StrictMode } from "react";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { ComposeStrip } from "./compose-strip";
import {
  FocusedTerminalProvider,
  useFocusedTerminal,
  type FocusedTerminal,
} from "@/contexts/focused-terminal-context";
import { ChromeProvider, useChromeDispatch } from "@/contexts/chrome-context";
import { useWindowStore, entryKey } from "@/store/window-store";
import type { UploadedFile } from "@/hooks/use-file-upload";
import { stubMatchMedia } from "@/test-utils/match-media";
import {
  getComposeDraft,
  getComposeSentHistory,
  hydrateComposeDrafts,
  hydrateComposeSentHistory,
  pushComposeSentHistory,
  setComposeAttachments,
} from "@/lib/compose-draft-store";
import {
  consumeComposeStripFocusOnOpen,
  dispatchComposeStripAttach,
  focusComposeStrip,
  isComposeStripFocused,
  openComposeRecall,
  setComposeStripFocused,
} from "@/lib/compose-strip-events";
import { useKeybindings } from "@/hooks/use-keybindings";
import { chordHintFor } from "@/lib/keybindings";
import { BottomBar } from "./bottom-bar";
import { ApiError, type WindowSendMode } from "@/api/client";
import { dismissOperatorChatChip, setOperatorChatSubject } from "@/lib/quake-terminal";

// The strip's only router use is the context chip's back-navigation; no
// RouterProvider is mounted in these tests.
const navigateMock = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

// Mock useFileUpload so tests never hit the network. The mock records calls,
// returns deterministic paths so attachment path lines can be asserted, and
// exposes a mutable `uploading` flag so the chip's busy state can be tested.
const uploadFilesMock = vi.fn<(files: FileList | File[]) => Promise<UploadedFile[]>>();
const uploadState = { uploading: false };
vi.mock("@/hooks/use-file-upload", async (orig) => {
  const actual = await orig<typeof import("@/hooks/use-file-upload")>();
  return {
    ...actual,
    useFileUpload: () => ({ uploadFiles: uploadFilesMock, uploading: uploadState.uploading }),
  };
});

const sendToWindowMock = vi.fn<
  (server: string, windowId: string, text: string, mode: WindowSendMode, target?: "agent") => Promise<{ ok: boolean }>
>();
const operatorRequestMock = vi.fn<
  (server: string, windowId: string, template: string, text?: string) => Promise<{ outcome: string }>
>();
vi.mock("@/api/client", async (orig) => {
  const actual = await orig<typeof import("@/api/client")>();
  return {
    ...actual,
    sendToWindow: (...args: Parameters<typeof actual.sendToWindow>) => sendToWindowMock(...args),
    sendOperatorRequest: (...args: Parameters<typeof actual.sendOperatorRequest>) =>
      operatorRequestMock(...args),
  };
});

const addToastMock = vi.fn<
  (message: string, variant?: "error" | "info", action?: { label: string; onSelect: () => void }) => void
>();
vi.mock("@/components/toast", async (orig) => {
  const actual = await orig<typeof import("@/components/toast")>();
  return {
    ...actual,
    useToast: () => ({ addToast: addToastMock }),
  };
});

/** Fake WebSocket-shaped adapter that records sends. */
function makeWs(open = true) {
  const sent: string[] = [];
  const ws = {
    readyState: open ? WebSocket.OPEN : WebSocket.CLOSED,
    send: (data: string) => sent.push(data),
    close: vi.fn(),
  } as unknown as WebSocket;
  return { ref: { current: ws } as React.RefObject<WebSocket | null>, sent };
}

/** Test harness: renders ComposeStrip plus a button that sets the focused
 * terminal to a supplied value, so tests can drive focus changes. */
function Harness({ focus }: { focus: FocusedTerminal }) {
  return (
    <ChromeProvider>
      <FocusedTerminalProvider>
        <FocusSetter focus={focus} />
        <ComposeStrip />
      </FocusedTerminalProvider>
    </ChromeProvider>
  );
}

function FocusSetter({ focus }: { focus: FocusedTerminal }) {
  const { setFocused } = useFocusedTerminal();
  return (
    <button data-testid="set-focus" onClick={() => setFocused(focus)}>
      set-focus
    </button>
  );
}

function seedWindow(server: string, windowId: string, name: string) {
  useWindowStore.setState((s) => {
    const entries = new Map(s.entries);
    entries.set(entryKey(server, windowId), {
      server,
      session: "sess",
      windowId,
      index: 0,
      name,
      killed: false,
      createdAt: 0,
      panes: [],
    });
    return { entries };
  });
}

const input = () => screen.getByTestId("compose-strip-input") as HTMLTextAreaElement;
const sendBtn = () => screen.getByTestId("compose-strip-send") as HTMLButtonElement;
const insertBtn = () => screen.getByTestId("compose-strip-insert") as HTMLButtonElement;

/** Re-stub matchMedia so `(pointer: coarse)` matches (or not) — used to prove
 * the Enter policy and `enterkeyhint` are pointer-INDEPENDENT (260802-lj98:
 * Enter is insert-line in the strip on every pointer type). Must run BEFORE
 * render (the hook reads the initial value at mount). */
function stubPointer(coarse: boolean) {
  stubMatchMedia((query) => coarse && ["(pointer: coarse)", "(any-pointer: coarse)"].includes(query));
}

/** A frozen cross-server recipient set, and the draft key it derives (sorted
 * keys — the strip's `selectionDraftKey`), for the broadcast-mode tests. */
const SELECTION_KEYS = ["srv:@1", "other:@2"];
const SELECTION_DRAFT_KEY = 'selection:["other:@2","srv:@1"]';

/** Render the strip in selection-broadcast mode with no focused terminal. */
function renderSelection(onSend: (text: string) => Promise<number>) {
  return render(
    <ChromeProvider>
      <FocusedTerminalProvider>
        <ComposeStrip selectionTarget={{ keys: SELECTION_KEYS, onSend }} />
      </FocusedTerminalProvider>
    </ChromeProvider>,
  );
}

describe("ComposeStrip", () => {
  beforeEach(() => {
    useWindowStore.setState({ entries: new Map(), ghosts: [] });
    // Drafts live in a per-target module store shared across the whole test
    // module and persisted to localStorage — wipe the storage and re-run the
    // real hydration so a leftover draft from a prior test never bleeds in.
    localStorage.clear();
    hydrateComposeDrafts();
    // The surface always mounts; the preference picks expanded vs. tongue.
    // These tests exercise the expanded body, so seed the preference ON after
    // the clear (ChromeProvider reads it at mount).
    localStorage.setItem("hexokit-compose-strip", "true");
    // Same for the sibling sent-history store — a leftover history would make
    // an ↑ recall in a fresh test see a prior test's sends.
    hydrateComposeSentHistory();
    // And for the operator chat-subject store (module state) — a leftover
    // subject would reroute the strip's plain submits onto the templated lane.
    setOperatorChatSubject(null);
    // Drain the module-level focus-on-open flag so a prior test's toggle can
    // never leak focus behavior into the next one.
    consumeComposeStripFocusOnOpen();
    // Same for the module-level compose-focus flag (260814-ink6) — a stuck
    // `true` would hide the bottom bar in a later test.
    setComposeStripFocused(false);
    uploadFilesMock.mockReset();
    uploadState.uploading = false;
    sendToWindowMock.mockReset();
    sendToWindowMock.mockResolvedValue({ ok: true });
    addToastMock.mockReset();
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: false,
        media: "",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("renders the inert no-target tongue when nothing is focused (preference on)", () => {
    render(<Harness focus={null} />);
    const tongue = screen.getByTestId("compose-tongue");
    expect(tongue).toHaveAttribute("data-state", "no-target");
    expect(tongue).toHaveAttribute("role", "status");
    expect(tongue).toHaveTextContent("No focused terminal — click a pane to target it");
    // Inert: no button, no chord hint, and none of the dead controls the old
    // disabled card carried.
    expect(tongue.tagName).not.toBe("BUTTON");
    expect(tongue.querySelector("kbd")).toBeNull();
    expect(screen.queryByTestId("compose-strip-input")).toBeNull();
    expect(screen.queryByTestId("compose-strip-target")).toBeNull();
    expect(screen.queryByRole("button", { name: "Upload file" })).toBeNull();
    // The root still carries the strip test id + production marker.
    expect(screen.getByTestId("compose-strip")).toHaveAttribute("data-compose-strip");
  });

  it("renders a text-only selection target with the frozen recipient count", () => {
    renderSelection(vi.fn().mockResolvedValue(2));

    expect(screen.getByTestId("compose-strip-target")).toHaveTextContent(
      "2 selected",
    );
    expect(input()).toBeEnabled();
    expect(input()).toHaveAttribute(
      "aria-label",
      "Compose prompt to send to selection",
    );
    // Broadcast Enter is a local newline, so the mobile action key must not
    // promise a send (the terminal-target strip keeps enterkeyhint="send").
    expect(input()).toHaveAttribute("enterkeyhint", "enter");
    expect(insertBtn()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Upload file" })).toBeDisabled();
    expect(sendBtn()).toBeDisabled();
  });

  it("submits a non-empty selection prompt once and ignores insert modes", async () => {
    const onSend = vi.fn().mockResolvedValue(2);
    renderSelection(onSend);

    fireEvent.change(input(), { target: { value: "run tests\nand report" } });
    fireEvent.keyDown(input(), { key: "Enter", code: "Enter", altKey: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(input()).toHaveValue("run tests\nand report");

    await act(async () => {
      fireEvent.click(sendBtn());
      await Promise.resolve();
    });

    expect(onSend).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledWith("run tests\nand report");
    expect(input()).toHaveValue("");
  });

  // The broadcast has no visible pane composer to stage a line into, so it
  // takes the broadcast surface's Enter policy. Plain Enter must not be swallowed
  // into a dead key (consumed by the strip's insert-line branch, then dropped
  // by the submit-only guard) — it stays a native newline.
  it("plain Enter in broadcast mode is a native newline, never a dead key or a send", async () => {
    const onSend = vi.fn().mockResolvedValue(1);
    renderSelection(onSend);

    fireEvent.change(input(), { target: { value: "first line" } });
    // fireEvent returns false when preventDefault() was called.
    let notPrevented = false;
    act(() => {
      notPrevented = fireEvent.keyDown(input(), { key: "Enter", code: "Enter" });
    });
    expect(notPrevented).toBe(true); // fell through to the textarea
    expect(onSend).not.toHaveBeenCalled();
    expect(input()).toHaveValue("first line");

    // Cmd/Ctrl+Enter remains the sole submit chord in broadcast mode.
    await act(async () => {
      fireEvent.keyDown(input(), { key: "Enter", code: "Enter", metaKey: true });
      await Promise.resolve();
    });
    expect(onSend).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledWith("first line");
  });

  it("keeps the composed prompt when the broadcast reached NO recipient (0 of N)", async () => {
    const onSend = vi.fn().mockResolvedValue(0);
    renderSelection(onSend);

    fireEvent.change(input(), { target: { value: "retry me" } });
    await act(async () => {
      fireEvent.click(sendBtn());
      await Promise.resolve();
    });

    expect(onSend).toHaveBeenCalledOnce();
    // Nothing was delivered, so the text stays composed for the retry — and it
    // is NOT recorded as sent history (nothing was sent).
    expect(input()).toHaveValue("retry me");
    expect(sendBtn()).toBeEnabled();
    expect(getComposeSentHistory(SELECTION_DRAFT_KEY)).toEqual([]);
  });

  it("clears the prompt on a PARTIAL delivery (some recipients got it)", async () => {
    const onSend = vi.fn().mockResolvedValue(1);
    renderSelection(onSend);

    fireEvent.change(input(), { target: { value: "partly through" } });
    await act(async () => {
      fireEvent.click(sendBtn());
      await Promise.resolve();
    });

    expect(input()).toHaveValue("");
    expect(getComposeSentHistory(SELECTION_DRAFT_KEY)).toEqual([
      "partly through",
    ]);
  });

  it("uses a recipient-set draft instead of the focused terminal's draft", () => {
    const ws = makeWs();
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter
            focus={{
              wsRef: ws.ref,
              containerRef: { current: null },
              server: "srv",
              session: "sess",
              windowId: "@1",
            }}
          />
          <ComposeStrip
            selectionTarget={{
              keys: SELECTION_KEYS,
              onSend: vi.fn().mockResolvedValue(2),
            }}
          />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    fireEvent.change(input(), { target: { value: "broadcast draft" } });

    expect(screen.getByTestId("compose-strip-target")).toHaveTextContent(
      "2 selected",
    );
    expect(ws.sent).toEqual([]);
  });

  // Card/compact model: with no draft the strip is a single compact row; the
  // first character morphs it into the card — full-width transparent textarea
  // with the chip row along the card's bottom (no flanking chips).
  it("fine compact: one row — 📎, a|, textarea, Send — no header fold change, no Insert, rows={1}", () => {
    stubPointer(false);
    render(<Harness focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />);
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    expect(screen.queryByTestId("compose-strip-card")).toBeNull();
    expect(input()).toHaveAttribute("rows", "1");
    // Insert is hidden in the compact state (it would be disabled while empty).
    expect(screen.queryByTestId("compose-strip-insert")).toBeNull();
    expect(screen.queryByTestId("compose-strip-newline")).toBeNull();
    // All four controls share the ONE row (the strip body is their parent).
    const row = input().parentElement;
    expect(screen.getByRole("button", { name: "Upload file" }).parentElement).toBe(row);
    expect(screen.getByTestId("compose-strip-a-close").parentElement).toBe(row);
    expect(sendBtn().parentElement).toBe(row);
  });

  it("fine card: the first character morphs to the card — full-width textarea above the chip row with Insert", () => {
    stubPointer(false);
    render(<Harness focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />);
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    act(() => fireEvent.change(input(), { target: { value: "x" } }));
    const card = screen.getByTestId("compose-strip-card");
    expect(input()).toHaveAttribute("rows", "1");
    // No flanking chips: the textarea and the chips are in separate rows.
    expect(sendBtn().parentElement).toBe(card);
    expect(input().parentElement).toBe(card);
    // Insert + Send sit on the card's chip row alongside the textarea.
    expect(insertBtn().parentElement).toBe(card);
    expect(screen.queryByTestId("compose-strip-newline")).toBeNull();
  });

  // Placeholder education (260811-ke2s): the placeholder teaches the strip's
  // Enter policy — mode-aware (terminal vs selection broadcast), pointer-aware
  // (chord hints never render on coarse pointers), and the sole surfacing of
  // ↑ sent-history recall. jsdom's platform resolves "other" (no mac UA), so
  // the submit keycap is `Ctrl+Enter` here.
  it("educates via placeholder on a terminal target (fine pointer): Enter inserts · keycap sends · ↑ history", () => {
    stubPointer(false);
    render(<Harness focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />);
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    expect(input().placeholder).toBe(
      "Compose text — Enter inserts · Ctrl+Enter sends · ↑ history · Esc → terminal",
    );
  });

  it("educates via placeholder in selection broadcast (fine pointer): keycap sends to all selected", () => {
    stubPointer(false);
    renderSelection(vi.fn().mockResolvedValue(2));
    expect(input().placeholder).toBe(
      "Compose prompt — Ctrl+Enter sends to all selected",
    );
  });

  it("folds the target into the placeholder on a coarse pointer (260814-ink6 — the header row is folded away)", () => {
    stubPointer(true);
    render(<Harness focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />);
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    // No store seed → the label layering falls back to the raw windowId.
    expect(input().placeholder).toBe("→ @1…");
  });

  it("names the recovery action in the no-target placeholder (forced-expanded body)", () => {
    // The body's target-less form is reachable only under `forceExpanded`
    // (the operator page); its placeholder shares the tongue's copy constant.
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <ComposeStrip forceExpanded />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    expect(input().placeholder).toBe("No focused terminal — click a pane to target it");
  });

  it("shows the focused window name as the target label", () => {
    seedWindow("srv", "@1", "my-window");
    render(<Harness focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />);
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    expect(screen.getByTestId("compose-strip-target").textContent).toBe("my-window");
  });

  it("falls back to the windowId as the label when the store has no name", () => {
    // No seedWindow — the store has no entry for this target, so the label uses
    // the raw windowId.
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@7" }} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    expect(screen.getByTestId("compose-strip-target").textContent).toBe("@7");
  });

  it("falls back to the registered windowName when the store has no entry", () => {
    // No seedWindow — board panes from servers the sidebar hasn't delivered
    // sessions for have no store entry; the registration-time name covers them.
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter
            focus={{
              wsRef: makeWs().ref,
              containerRef: { current: null },
              server: "srv",
              session: "sess",
              windowId: "@7",
              windowName: "board-win",
            }}
          />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    expect(screen.getByTestId("compose-strip-target").textContent).toBe("board-win");
  });

  it("prefers the live store name over the registered windowName", () => {
    // The store tracks renames; a registration-time name may be stale.
    seedWindow("srv", "@1", "renamed-win");
    render(
      <Harness
        focus={{
          wsRef: makeWs().ref,
          containerRef: { current: null },
          server: "srv",
          session: "sess",
          windowId: "@1",
          windowName: "stale-name",
        }}
      />,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    expect(screen.getByTestId("compose-strip-target").textContent).toBe("renamed-win");
  });

  it("plain Enter sends insert-line intent and clears the draft on any pointer type", async () => {
    for (const coarse of [false, true]) {
      stubPointer(coarse);
      const { ref, sent } = makeWs();
      const view = render(
        <ChromeProvider>
          <FocusedTerminalProvider>
            <FocusSetter focus={{ wsRef: ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
            <ComposeStrip />
          </FocusedTerminalProvider>
        </ChromeProvider>,
      );
      act(() => fireEvent.click(screen.getByTestId("set-focus")));
      act(() => fireEvent.change(input(), { target: { value: "stage this line" } }));
      await act(async () => fireEvent.keyDown(input(), { key: "Enter" }));
      expect(sendToWindowMock).toHaveBeenLastCalledWith("srv", "@1", "stage this line", "insert-line");
      expect(sent).toEqual([]);
      expect(input().value).toBe("");
      view.unmount();
    }
  });

  it("plain Enter on an EMPTY textarea is a FULL no-op: consumed, nothing sent, no local newline", () => {
    const { ref, sent } = makeWs();
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    // fireEvent returns false when preventDefault() was called — the keydown
    // is consumed, so the textarea never inserts a local newline.
    let notPrevented = true;
    act(() => {
      notPrevented = fireEvent.keyDown(input(), { key: "Enter" });
    });
    expect(notPrevented).toBe(false);
    expect(sent).toEqual([]); // nothing transmitted
    expect(input().value).toBe(""); // no draft change

    // Whitespace-only counts as empty for insert-line too: consumed, no send.
    act(() => fireEvent.change(input(), { target: { value: "   " } }));
    act(() => fireEvent.keyDown(input(), { key: "Enter" }));
    expect(sent).toEqual([]);
  });

  it("Shift+Enter does NOT send (inserts a newline via default behavior)", () => {
    const { ref, sent } = makeWs();
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    act(() => fireEvent.change(input(), { target: { value: "line1" } }));
    act(() => fireEvent.keyDown(input(), { key: "Enter", shiftKey: true }));
    expect(sent).toEqual([]);
  });

  it("Shift+Cmd/Ctrl+Enter is NOT consumed — nothing sent, the keydown bubbles to the global zen chord", () => {
    const { ref, sent } = makeWs();
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    act(() => fireEvent.change(input(), { target: { value: "draft" } }));
    for (const mod of [{ metaKey: true }, { ctrlKey: true }]) {
      let notPrevented = false;
      act(() => {
        notPrevented = fireEvent.keyDown(input(), { key: "Enter", shiftKey: true, ...mod });
      });
      expect(notPrevented).toBe(true); // not defaultPrevented — free to reach global chords
    }
    expect(sent).toEqual([]);
    expect(input().value).toBe("draft"); // no submit fired, draft intact
  });

  it("empty Cmd/Ctrl+Enter sends enter intent", async () => {
    const { ref, sent } = makeWs();
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    await act(async () => fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true }));
    expect(sendToWindowMock).toHaveBeenCalledWith("srv", "@1", "", "enter");
    expect(sent).toEqual([]);
  });

  it("whitespace-only Cmd/Ctrl+Enter sends enter intent and discards whitespace", async () => {
    const { ref, sent } = makeWs();
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    act(() => fireEvent.change(input(), { target: { value: "   " } }));
    await act(async () => fireEvent.keyDown(input(), { key: "Enter", metaKey: true }));
    expect(sendToWindowMock).toHaveBeenCalledWith("srv", "@1", "", "enter");
    expect(sent).toEqual([]);
    expect(input().value).toBe("");
  });

  it("Cmd/Ctrl+Enter during IME composition does not send", () => {
    const { ref, sent } = makeWs();
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    act(() => fireEvent.change(input(), { target: { value: "hi" } }));
    // isComposing rides the native event; fireEvent.keyDown forwards it.
    act(() => fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true, isComposing: true }));
    expect(sent).toEqual([]);
  });

  // ── Enter=insert-line matrix (260802-lj98, revising 260801-hsxm) ───────────

  it("Cmd/Ctrl+Enter sends submit intent on both pointer types", async () => {
    for (const coarse of [false, true]) {
      for (const mod of [{ metaKey: true }, { ctrlKey: true }]) {
        stubPointer(coarse);
        const { ref, sent } = makeWs();
        const view = render(
          <ChromeProvider>
            <FocusedTerminalProvider>
              <FocusSetter focus={{ wsRef: ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
              <ComposeStrip />
            </FocusedTerminalProvider>
          </ChromeProvider>,
        );
        act(() => fireEvent.click(screen.getByTestId("set-focus")));
        act(() => fireEvent.change(input(), { target: { value: "chord" } }));
        await act(async () => fireEvent.keyDown(input(), { key: "Enter", ...mod }));
        expect(sendToWindowMock).toHaveBeenLastCalledWith("srv", "@1", "chord", "submit");
        expect(sent).toEqual([]);
        expect(input().value).toBe("");
        view.unmount();
      }
    }
  });

  it("Alt+Enter sends raw intent and clears the draft", async () => {
    const { ref, sent } = makeWs();
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    act(() => fireEvent.change(input(), { target: { value: "stage me" } }));
    await act(async () => fireEvent.keyDown(input(), { key: "Enter", altKey: true }));
    expect(sendToWindowMock).toHaveBeenCalledWith("srv", "@1", "stage me", "raw");
    expect(sent).toEqual([]);
    expect(input().value).toBe("");
  });

  it("the Insert button sends insert-line intent and clears", async () => {
    const { ref, sent } = makeWs();
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    // Empty draft: the compact row omits Insert entirely (it follows Enter's
    // empty no-op) — but Send stays enabled: its chord's empty case is the
    // bare-\r "Enter in the pane".
    expect(screen.queryByTestId("compose-strip-insert")).toBeNull();
    expect(sendBtn().disabled).toBe(false);
    // With text the strip is in card form and Insert renders, enabled.
    act(() => fireEvent.change(input(), { target: { value: "via button" } }));
    expect(insertBtn().disabled).toBe(false);
    await act(async () => fireEvent.click(insertBtn()));
    expect(sendToWindowMock).toHaveBeenCalledWith("srv", "@1", "via button", "insert-line");
    expect(sent).toEqual([]);
    expect(input().value).toBe("");
  });

  it("the Send button sends submit intent, then enter intent when empty", async () => {
    const { ref, sent } = makeWs();
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    // Empty draft: Send stays enabled (target exists) but wears the neutral
    // secondary face, not the lit accent fill (260814 revision of kvk7 —
    // touch devices have no Cmd/Ctrl+Enter chord, so the button is the only
    // bare-Enter path there).
    expect(sendBtn().disabled).toBe(false);
    expect(sendBtn().className).toContain("border-border");
    expect(sendBtn().className).not.toContain("rk-latch-well");
    // Whitespace-only counts as empty too — enabled, still secondary.
    act(() => fireEvent.change(input(), { target: { value: "   " } }));
    expect(sendBtn().disabled).toBe(false);
    expect(sendBtn().className).toContain("border-border");
    expect(insertBtn().disabled).toBe(true);
    // With text the latch well returns and Send transmits text + trailing \r.
    act(() => fireEvent.change(input(), { target: { value: "via send" } }));
    expect(sendBtn().className).toContain("rk-latch-well");
    expect(sendBtn().className).toContain("border-border-pressed");
    expect(insertBtn().disabled).toBe(false);
    await act(async () => fireEvent.click(sendBtn()));
    expect(sendToWindowMock).toHaveBeenLastCalledWith("srv", "@1", "via send", "submit");
    expect(sent).toEqual([]);
    expect(input().value).toBe("");
    await act(async () => fireEvent.click(sendBtn()));
    expect(sendToWindowMock).toHaveBeenLastCalledWith("srv", "@1", "", "enter");
    expect(sent).toEqual([]);
  });

  it("a closed relay stream does not block raw compose delivery", async () => {
    const { ref, sent } = makeWs(false); // CLOSED
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    act(() => fireEvent.change(input(), { target: { value: "keep insert" } }));
    await act(async () => fireEvent.keyDown(input(), { key: "Enter", altKey: true }));
    expect(sent).toEqual([]);
    expect(sendToWindowMock).toHaveBeenCalledWith("srv", "@1", "keep insert", "raw");
    expect(input().value).toBe("");
  });

  it("enterkeyhint states the truth: 'send' on every pointer type (Enter transmits the line)", () => {
    for (const coarse of [false, true]) {
      stubPointer(coarse);
      const view = render(
        <ChromeProvider>
          <FocusedTerminalProvider>
            <FocusSetter focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
            <ComposeStrip />
          </FocusedTerminalProvider>
        </ChromeProvider>,
      );
      act(() => fireEvent.click(screen.getByTestId("set-focus")));
      expect(input().getAttribute("enterkeyhint")).toBe("send");
      view.unmount();
    }
  });

  // ── Readline editing layer (260801-hsxm) ───────────────────────────────────

  it("Ctrl+U kills to line start through React state (shared readline layer)", () => {
    const { ref, sent } = makeWs();
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    act(() => fireEvent.change(input(), { target: { value: "kill this line" } }));
    act(() => input().setSelectionRange(9, 9)); // cursor after "kill this"
    act(() => fireEvent.keyDown(input(), { key: "u", code: "KeyU", ctrlKey: true }));
    // The deletion flows through the bubbled input event → onChange → module
    // store, so the controlled value reflects the kill.
    expect(input().value).toBe(" line");
    expect(sent).toEqual([]); // an editing chord never sends
  });

  it("Alt+B moves the caret a word back without editing (readline motion)", () => {
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    act(() => fireEvent.change(input(), { target: { value: "one two" } }));
    act(() => input().setSelectionRange(7, 7));
    // macOS composes ∫ into `key` for Alt+B — matching is on `code`.
    act(() => fireEvent.keyDown(input(), { key: "∫", code: "KeyB", altKey: true }));
    expect(input().value).toBe("one two");
    expect(input().selectionStart).toBe(4);
  });

  it("does not steal focus on a plain (re)mount — no open transition, no flag", () => {
    // A route remount with the strip already enabled never goes through
    // `toggleComposeStrip`, so no focus-on-open flag exists (260801-sm6g keeps
    // the 260718-dhdj no-steal rule for everything but the open transition).
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    // The body mounts once a target exists; its textarea must not be the
    // active element on that plain mount.
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    expect(document.activeElement).not.toBe(input());
  });

  // Focus-on-open (260801-sm6g): the off→on toggle marks the module flag;
  // the expanded body's mount effect consumes it and focuses the textarea.
  // The surface itself is always mounted (as in app.tsx / board-page.tsx);
  // the toggle swaps the collapsed tongue for the expanded body.
  function ToggleHarness({ focus }: { focus: FocusedTerminal }) {
    return (
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={focus} />
          <ToggleGatedStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>
    );
  }
  // NOTE: distinct from the ×-close `GatedStrip` harness below — this one also
  // exposes the toggle itself, to drive the off→on open transition.
  function ToggleGatedStrip() {
    const { toggleComposeStrip } = useChromeDispatch();
    return (
      <>
        <button data-testid="toggle-strip" onClick={toggleComposeStrip}>
          toggle
        </button>
        <ComposeStrip />
      </>
    );
  }

  it("focuses the textarea on the open transition (toggle off→on)", () => {
    localStorage.setItem("hexokit-compose-strip", "false");
    render(<ToggleHarness focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />);
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    expect(screen.queryByTestId("compose-strip-input")).toBeNull();
    act(() => fireEvent.click(screen.getByTestId("toggle-strip")));
    expect(document.activeElement).toBe(input());
  });

  it("open in the no-target state takes no focus and clears the flag (no stale steal later)", () => {
    localStorage.setItem("hexokit-compose-strip", "false");
    render(<ToggleHarness focus={null} />);
    // Open with no focused terminal: the no-target tongue shows, no textarea.
    act(() => fireEvent.click(screen.getByTestId("toggle-strip")));
    expect(screen.queryByTestId("compose-strip-input")).toBeNull();
    expect(screen.getByTestId("compose-tongue")).toHaveAttribute("data-state", "no-target");
    // The tongue consumed the flag even though there was nothing to focus.
    expect(consumeComposeStripFocusOnOpen()).toBe(false);
  });

  it("Escape blurs the textarea (does not remove the strip)", () => {
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    act(() => input().focus());
    expect(document.activeElement).toBe(input());
    act(() => fireEvent.keyDown(input(), { key: "Escape" }));
    expect(document.activeElement).not.toBe(input());
    expect(screen.getByTestId("compose-strip")).toBeInTheDocument();
  });

  // ── Per-target drafts (260801-cyth) ─────────────────────────────────────────

  /** Two focusable targets sharing one strip — drives target switches. Each
   * target keeps a stable ws so sends can be asserted per target. */
  const wsA = makeWs();
  const wsB = makeWs();
  function TwoTargets() {
    const { setFocused } = useFocusedTerminal();
    return (
      <>
        <button data-testid="focus-a" onClick={() => setFocused({ wsRef: wsA.ref, containerRef: { current: null }, server: "srv", session: "sa", windowId: "@a" })}>a</button>
        <button data-testid="focus-b" onClick={() => setFocused({ wsRef: wsB.ref, containerRef: { current: null }, server: "srv", session: "sb", windowId: "@b" })}>b</button>
        <ComposeStrip />
      </>
    );
  }
  function renderTwoTargets() {
    wsA.sent.length = 0;
    wsB.sent.length = 0;
    return render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <TwoTargets />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
  }

  it("switching the focused target swaps the visible draft (drafts do not travel)", () => {
    renderTwoTargets();
    act(() => fireEvent.click(screen.getByTestId("focus-a")));
    act(() => fireEvent.change(input(), { target: { value: "for A" } }));

    // B starts empty — A's draft did not travel with the focus change.
    act(() => fireEvent.click(screen.getByTestId("focus-b")));
    expect(input().value).toBe("");
    act(() => fireEvent.change(input(), { target: { value: "for B" } }));

    // Back on A: its own draft is recalled; B's is intact behind it.
    act(() => fireEvent.click(screen.getByTestId("focus-a")));
    expect(input().value).toBe("for A");
    act(() => fireEvent.click(screen.getByTestId("focus-b")));
    expect(input().value).toBe("for B");
  });

  it("a delivered send clears only the focused target's draft", async () => {
    renderTwoTargets();
    act(() => fireEvent.click(screen.getByTestId("focus-a")));
    act(() => fireEvent.change(input(), { target: { value: "keep A" } }));

    act(() => fireEvent.click(screen.getByTestId("focus-b")));
    act(() => fireEvent.change(input(), { target: { value: "send B" } }));
    await act(async () => fireEvent.click(sendBtn()));
    expect(sendToWindowMock).toHaveBeenCalledWith("srv", "@b", "send B", "submit");
    expect(wsB.sent).toEqual([]);
    expect(input().value).toBe(""); // B's draft cleared after delivery

    // A's draft was NOT collateral damage of B's send.
    act(() => fireEvent.click(screen.getByTestId("focus-a")));
    expect(input().value).toBe("keep A");
    expect(wsA.sent).toEqual([]);
  });

  it("attachments stay with their target — no re-upload, no path rewrite on focus change", async () => {
    // One upload only (the attach). A focus change must NOT trigger another.
    uploadFilesMock.mockResolvedValueOnce([
      { path: "/wt-a/.uploads/x.png", file: new File(["x"], "x.png", { type: "image/png" }) },
    ]);
    renderTwoTargets();

    // Focus A, then attach a file via the hidden input.
    act(() => fireEvent.click(screen.getByTestId("focus-a")));
    const file = new File(["x"], "x.png", { type: "image/png" });
    const hiddenInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(hiddenInput, { target: { files: [file] } });
    });
    expect(input().value).toContain("/wt-a/.uploads/x.png");
    expect(screen.getByTestId("compose-strip-previews")).toBeInTheDocument();

    // Focus B: no re-home fires — B simply shows ITS (empty) draft.
    await act(async () => {
      fireEvent.click(screen.getByTestId("focus-b"));
    });
    expect(uploadFilesMock).toHaveBeenCalledTimes(1);
    expect(input().value).toBe("");
    expect(screen.queryByTestId("compose-strip-previews")).toBeNull();

    // Back on A: the attachment (path line + preview) is right where it was.
    act(() => fireEvent.click(screen.getByTestId("focus-a")));
    expect(input().value).toContain("/wt-a/.uploads/x.png");
    expect(screen.getByTestId("compose-strip-previews")).toBeInTheDocument();
  });

  it("reclaims a departed target's preview URLs while the strip stays mounted", async () => {
    // Deterministic blob URLs so create/revoke pairs can be asserted exactly.
    let urlSeq = 0;
    const createSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation(() => `blob:mock-${++urlSeq}`);
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    try {
      uploadFilesMock.mockResolvedValueOnce([
        { path: "/wt-a/.uploads/x.png", file: new File(["x"], "x.png", { type: "image/png" }) },
      ]);
      renderTwoTargets();

      // Attach on A: rendering the preview mints one URL.
      act(() => fireEvent.click(screen.getByTestId("focus-a")));
      const hiddenInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await act(async () => {
        fireEvent.change(hiddenInput, {
          target: { files: [new File(["x"], "x.png", { type: "image/png" })] },
        });
      });
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(revokeSpy).not.toHaveBeenCalled();

      // Abandon A without sending (switch to B): the sweep revokes A's URL —
      // it must not sit in the per-mount map for the life of the strip.
      act(() => fireEvent.click(screen.getByTestId("focus-b")));
      expect(revokeSpy).toHaveBeenCalledWith("blob:mock-1");

      // Back on A: the preview URL is recreated lazily from the retained File.
      act(() => fireEvent.click(screen.getByTestId("focus-a")));
      expect(screen.getByTestId("compose-strip-previews")).toBeInTheDocument();
      expect(createSpy).toHaveBeenCalledTimes(2);
    } finally {
      createSpy.mockRestore();
      revokeSpy.mockRestore();
    }
  });

  it("hydration restores a persisted draft's text for its target (refresh survival)", () => {
    renderTwoTargets();
    act(() => fireEvent.click(screen.getByTestId("focus-a")));
    act(() => fireEvent.change(input(), { target: { value: "survives reload" } }));

    // Simulate a page reload: the module store re-hydrates from localStorage.
    act(() => hydrateComposeDrafts());
    expect(input().value).toBe("survives reload");
  });

  // ── Rework coverage (260718-dhdj): module-store draft persistence ──────────

  it("preserves the unsent draft across a toggle-off/on (unmount → remount)", () => {
    // Simulates the compose preference toggling off (strip unmounts) then back
    // on (strip remounts). The draft lives in the module store, so an unmount
    // must NOT destroy it.
    const { unmount } = render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    act(() => fireEvent.change(input(), { target: { value: "half-typed" } }));

    // Toggle off: the strip unmounts.
    unmount();
    expect(screen.queryByTestId("compose-strip")).toBeNull();

    // Toggle on: a FRESH strip mounts (new component instance / different
    // footer) and — once the SAME target is focused again — must show that
    // target's retained draft (drafts are keyed by target, 260801-cyth).
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    expect(input().value).toBe("half-typed");
  });

  it("preserves the draft across a route change (two separate strip mounts)", () => {
    // The terminal route and the board route mount the strip in SEPARATE
    // footers — a route change unmounts one and mounts the other. Modeled here
    // as two independent renders sharing the module store.
    const { unmount } = render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    act(() => fireEvent.change(input(), { target: { value: "route-draft" } }));
    unmount();

    // The "board route" mounts its own strip instance; focusing the SAME
    // window there (same entryKey) recalls the same draft.
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    expect(input().value).toBe("route-draft");
  });

  it("a per-target draft survives the broadcast dock flip (in-tile ⇄ footer, 260813-j3jb)", () => {
    // The two docks are distinct subtrees (inside the first tty tile vs the
    // shell footer), so a broadcast on/off flip UNMOUNTS the strip from one
    // dock and mounts it at the other. The module store carries both drafts:
    // the broadcast draft keys on the recipient set, so the per-target draft
    // is untouched and returns when the flip restores single-send.
    const focus = {
      wsRef: makeWs().ref,
      containerRef: { current: null },
      server: "srv",
      session: "sess",
      windowId: "@1",
    };
    // In-tile dock (single-send): type a per-target draft.
    const { unmount: unmountTile } = render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={focus} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    act(() => fireEvent.change(input(), { target: { value: "in-tile draft" } }));
    unmountTile();

    // Broadcast ON — the strip remounts at the footer dock in selection mode:
    // the recipient-set draft is a SEPARATE (empty) draft.
    const { unmount: unmountFooter } = render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={focus} />
          <ComposeStrip
            selectionTarget={{ keys: SELECTION_KEYS, onSend: vi.fn().mockResolvedValue(2) }}
          />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    expect(screen.getByTestId("compose-strip-target")).toHaveTextContent("2 selected");
    expect(input().value).toBe("");
    unmountFooter();

    // Broadcast OFF — back at the in-tile dock, the per-target draft is intact.
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={focus} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    expect(screen.getByTestId("compose-strip-target")).not.toHaveTextContent("selected");
    expect(input().value).toBe("in-tile draft");
  });

  it("a closed relay stream does not block submit delivery", async () => {
    const { ref, sent } = makeWs(false); // CLOSED
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    act(() => fireEvent.change(input(), { target: { value: "keep-me" } }));
    await act(async () => fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true }));
    expect(sent).toEqual([]);
    expect(sendToWindowMock).toHaveBeenCalledWith("srv", "@1", "keep-me", "submit");
    expect(input().value).toBe("");
  });

  it("clears the draft only after a delivered send", async () => {
    const { ref, sent } = makeWs(true); // OPEN
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    act(() => fireEvent.change(input(), { target: { value: "deliver" } }));
    await act(async () => fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true }));
    expect(sendToWindowMock).toHaveBeenCalledWith("srv", "@1", "deliver", "submit");
    expect(sent).toEqual([]);
    expect(input().value).toBe("");
  });

  it("clears the focused terminal on board-pane unmount (stale-target guard)", () => {
    // Models BoardPane's unmount cleanup: a component that registers itself as
    // the focused terminal on mount and clears it on unmount iff still the
    // registered one (mirrors BoardPane / terminal-client.tsx:139). After
    // unmount the strip must fall back to the disabled "no target" state.
    const wsRef = { current: null } as React.RefObject<WebSocket | null>;
    const containerRef = { current: null } as React.RefObject<HTMLElement | null>;
    function FakeBoardPane() {
      const { focused, setFocused } = useFocusedTerminal();
      const focusedRef = useRef(focused);
      focusedRef.current = focused;
      useEffect(() => {
        setFocused({ wsRef, containerRef, server: "srv", session: "sess", windowId: "@board" });
        return () => {
          if (focusedRef.current?.wsRef === wsRef) setFocused(null);
        };
      }, [setFocused]);
      return null;
    }

    seedWindow("srv", "@board", "board-win");
    // The pane's presence is toggled WITHOUT remounting the provider or the
    // strip — exactly the "leave the board, stay on the same provider" case the
    // cleanup guards. If the pane did not clear on unmount, the strip would keep
    // the stale "board-win" target.
    function Tree({ paneMounted }: { paneMounted: boolean }) {
      return (
        <ChromeProvider>
          <FocusedTerminalProvider>
            {paneMounted && <FakeBoardPane />}
            <ComposeStrip />
          </FocusedTerminalProvider>
        </ChromeProvider>
      );
    }
    const { rerender } = render(<Tree paneMounted />);
    // While the pane is mounted the strip is targeted (enabled).
    expect(screen.getByTestId("compose-strip-target").textContent).toBe("board-win");
    expect(input().disabled).toBe(false);

    // Unmount only the pane (leave the board) — the provider + strip stay. The
    // strip must revert to the disabled "no target" state.
    rerender(<Tree paneMounted={false} />);
    // Target gone ⇒ the wrapper swaps the body for the inert no-target tongue.
    expect(screen.getByTestId("compose-tongue")).toHaveAttribute("data-state", "no-target");
    expect(screen.queryByTestId("compose-strip-input")).toBeNull();
  });

  // ── On-strip × close button (260722-d5q7) ──────────────────────────────────

  /** Mirrors the production mount (an unconditional `<ComposeStrip />` in
   * app.tsx / board-page.tsx): the surface stays mounted and the module forks
   * on the chrome preference, so clicking the header-row × (which fires the
   * real `toggleComposeStrip` from the real ChromeProvider) swaps the
   * expanded body for the collapsed tongue. */
  function GatedStrip() {
    return <ComposeStrip />;
  }

  function GatedHarness({ focus }: { focus: FocusedTerminal }) {
    return (
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={focus} />
          <GatedStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>
    );
  }

  it("the header-row × closes the strip via toggleComposeStrip; the draft survives close→reopen", () => {
    // Seed the preference ON so the gated strip mounts (readComposeStrip reads
    // localStorage at provider mount).
    localStorage.setItem("hexokit-compose-strip", "true");
    const first = render(<GatedHarness focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />);
    act(() => fireEvent.click(screen.getByTestId("set-focus")));

    // The × renders in the strip with its accessible name.
    const close = screen.getByTestId("compose-strip-close");
    expect(close).toBe(screen.getByRole("button", { name: "Close compose strip" }));

    // Type a draft, then close via the ×: the body collapses to the tongue
    // (preference off)…
    act(() => fireEvent.change(input(), { target: { value: "before-close" } }));
    act(() => fireEvent.click(close));
    expect(screen.queryByTestId("compose-strip-input")).toBeNull();
    expect(screen.getByTestId("compose-tongue")).toHaveTextContent("Compose");
    expect(localStorage.getItem("hexokit-compose-strip")).toBe("false");

    // …and reopening (same toggle, e.g. the `>_` chip) restores the strip with
    // the same target's draft intact — closing is lossless, no confirmation
    // needed (drafts are keyed by target, so the same focus recalls it).
    first.unmount();
    localStorage.setItem("hexokit-compose-strip", "true");
    render(<GatedHarness focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />);
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    expect(input().value).toBe("before-close");
  });

  it("the `a|` chip beside attach closes the strip via the same toggle path (260814-ldbs R7)", () => {
    // The opener/closer family: with the fine-pointer bottom bar gone, the
    // status bar's `a` hint opens the strip and this in-strip `a|` closes it.
    localStorage.setItem("hexokit-compose-strip", "true");
    render(<GatedHarness focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />);
    act(() => fireEvent.click(screen.getByTestId("set-focus")));

    const aClose = screen.getByTestId("compose-strip-a-close");
    expect(aClose).toHaveTextContent("a|");
    // It sits immediately after the attach chip (same visual family).
    const attach = screen.getByRole("button", { name: "Upload file" });
    expect(
      attach.compareDocumentPosition(aClose) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    act(() => fireEvent.click(aClose));
    expect(screen.queryByTestId("compose-strip-input")).toBeNull();
    expect(screen.getByTestId("compose-tongue")).toHaveTextContent("Compose");
    expect(localStorage.getItem("hexokit-compose-strip")).toBe("false");
  });

  it("the × does not steal focus (mousedown is default-prevented)", () => {
    render(<Harness focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />);
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    // fireEvent returns false when preventDefault() was called — the strip's
    // no-focus-steal invariant (same contract as 📎 / Insert / Send).
    let notPrevented = true;
    act(() => {
      notPrevented = fireEvent.mouseDown(screen.getByTestId("compose-strip-close"));
    });
    expect(notPrevented).toBe(false);
  });

  it("focusComposeStrip focuses the mounted textarea and declines when no target", () => {
    // The touch ⌨ button focuses the strip via the module focus registry, not a
    // DOM test-id query. A mounted-with-target strip focuses and returns true.
    const { unmount } = render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    let took = false;
    act(() => {
      took = focusComposeStrip();
    });
    expect(took).toBe(true);
    expect(document.activeElement).toBe(input());

    unmount();
    // No strip mounted → the registry declines so the caller falls back to the
    // terminal.
    expect(focusComposeStrip()).toBe(false);
  });

  // ── Sent history + ↑/↓ recall (260806-kadm) ────────────────────────────────

  /** Single-target strip with an OPEN stream, focused and ready to type. */
  function renderFocused(open = true) {
    const { ref, sent } = makeWs(open);
    const view = render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    return { view, sent };
  }

  const KEY = entryKey("srv", "@1");

  /** Type into the textarea (a real user edit — ends any recall walk). */
  function type(value: string) {
    act(() => fireEvent.change(input(), { target: { value } }));
  }

  /** Press an arrow; returns true when the keydown was NOT prevented (i.e. the
   * strip left it to native cursor movement). */
  function arrow(key: "ArrowUp" | "ArrowDown"): boolean {
    let notPrevented = true;
    act(() => {
      notPrevented = fireEvent.keyDown(input(), { key });
    });
    return notPrevented;
  }

  it.each([
    ["fine", false],
    ["coarse", true],
  ])("shows the history chip after a send on a %s pointer and keeps it enabled with a draft", async (_label, coarse) => {
    stubPointer(coarse);
    const { sent } = renderFocused();
    expect(screen.queryByTestId("compose-strip-history")).toBeNull();

    act(() => input().focus());
    type("recoverable text");
    expect(screen.queryByTestId("compose-strip-history")).toBeNull();
    await act(async () => fireEvent.keyDown(input(), { key: "Enter" }));

    expect(sendToWindowMock).toHaveBeenCalledWith("srv", "@1", "recoverable text", "insert-line");
    expect(sent).toEqual([]);
    expect(screen.getByTestId("compose-strip-history")).toBeEnabled();
    type("draft typed after the send");
    expect(screen.getByTestId("compose-strip-history")).toBeEnabled();
  });

  it("lists sent entries newest-first and loads a row without transmitting or changing history", () => {
    pushComposeSentHistory(KEY, "older\nentry");
    pushComposeSentHistory(KEY, "newest entry");
    const { sent } = renderFocused();
    sendToWindowMock.mockClear();
    type("draft already in progress");
    act(() => input().focus());
    const before = [...getComposeSentHistory(KEY)];

    act(() => fireEvent.click(screen.getByTestId("compose-strip-history")));
    const rows = screen.getAllByTestId("compose-history-entry");
    expect(rows.map((row) => row.textContent)).toEqual(["newest entry", "older\nentry"]);
    expect(rows[1]).toHaveClass("font-mono", "whitespace-pre-wrap", "line-clamp-2");
    expect(fireEvent.mouseDown(rows[1])).toBe(false);
    act(() => fireEvent.click(rows[1]));

    expect(input()).toHaveValue("older\nentry");
    expect(document.activeElement).toBe(input());
    expect(screen.queryByTestId("compose-history-flyout")).toBeNull();
    expect(sent).toEqual([]);
    expect(sendToWindowMock).not.toHaveBeenCalled();
    expect(getComposeSentHistory(KEY)).toEqual(before);
  });

  it("dismisses the flyout on Escape, outside press, and target switch without changing a draft", () => {
    const keyA = entryKey("srv", "@a");
    pushComposeSentHistory(keyA, "A sent");
    renderTwoTargets();
    act(() => fireEvent.click(screen.getByTestId("focus-a")));
    type("A draft");

    act(() => fireEvent.click(screen.getByTestId("compose-strip-history")));
    expect(screen.getByTestId("compose-history-flyout")).toBeInTheDocument();
    act(() => fireEvent.keyDown(input(), { key: "Escape" }));
    expect(screen.queryByTestId("compose-history-flyout")).toBeNull();
    expect(input()).toHaveValue("A draft");

    act(() => fireEvent.click(screen.getByTestId("compose-strip-history")));
    act(() => fireEvent.pointerDown(document.body));
    expect(screen.queryByTestId("compose-history-flyout")).toBeNull();
    expect(input()).toHaveValue("A draft");

    act(() => fireEvent.click(screen.getByTestId("compose-strip-history")));
    act(() => fireEvent.click(screen.getByTestId("focus-b")));
    expect(screen.queryByTestId("compose-history-flyout")).toBeNull();
    expect(input()).toHaveValue("");
  });

  it("loading from the flyout tears down an active arrow-key walk", () => {
    pushComposeSentHistory(KEY, "older");
    pushComposeSentHistory(KEY, "newest");
    renderFocused();
    arrow("ArrowUp");
    arrow("ArrowUp");
    expect(input()).toHaveValue("older");

    act(() => fireEvent.click(screen.getByTestId("compose-strip-history")));
    act(() => fireEvent.click(screen.getAllByTestId("compose-history-entry")[1]));
    expect(input()).toHaveValue("older");
    expect(arrow("ArrowUp")).toBe(true);

    type("");
    expect(arrow("ArrowUp")).toBe(false);
    expect(input()).toHaveValue("newest");
  });

  it("openComposeRecall opens through the mounted strip and declines without history or a target", () => {
    const empty = renderFocused();
    expect(openComposeRecall()).toBe(false);
    empty.view.unmount();

    pushComposeSentHistory(KEY, "from palette");
    const withHistory = renderFocused();
    let opened = false;
    act(() => {
      opened = openComposeRecall();
    });
    expect(opened).toBe(true);
    expect(screen.getByTestId("compose-history-flyout")).toBeInTheDocument();
    withHistory.view.unmount();

    render(<Harness focus={null} />);
    expect(openComposeRecall()).toBe(false);
  });

  it.each([
    ["insert-line (plain Enter)", { key: "Enter" }, "insert-line"],
    ["insert (Alt+Enter)", { key: "Enter", altKey: true }, "raw"],
    ["submit (Cmd/Ctrl+Enter)", { key: "Enter", ctrlKey: true }, "submit"],
  ] as const)("records history on a delivered %s send, before the clear", async (_label, chord, mode) => {
    const { sent } = renderFocused();
    type("sent text");
    await act(async () => fireEvent.keyDown(input(), chord));
    expect(sendToWindowMock).toHaveBeenCalledWith("srv", "@1", "sent text", mode);
    expect(sent).toEqual([]);
    expect(input().value).toBe("");
    expect(getComposeSentHistory(KEY)).toEqual(["sent text"]);
  });

  it("an empty submit's enter intent records nothing", async () => {
    const { sent } = renderFocused();
    await act(async () => fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true }));
    expect(sendToWindowMock).toHaveBeenCalledWith("srv", "@1", "", "enter");
    expect(sent).toEqual([]);
    expect(getComposeSentHistory(KEY)).toEqual([]);
  });

  it("a closed relay stream still records a delivered insert-line", async () => {
    const { sent } = renderFocused(false);
    type("delivered through API");
    await act(async () => fireEvent.keyDown(input(), { key: "Enter" }));
    expect(sent).toEqual([]);
    expect(sendToWindowMock).toHaveBeenCalledWith("srv", "@1", "delivered through API", "insert-line");
    expect(input().value).toBe("");
    expect(getComposeSentHistory(KEY)).toEqual(["delivered through API"]);
  });

  it("↑ on an empty textarea recalls the newest sent text", () => {
    pushComposeSentHistory(KEY, "older");
    pushComposeSentHistory(KEY, "newest");
    renderFocused();
    expect(arrow("ArrowUp")).toBe(false); // consumed
    expect(input().value).toBe("newest");
  });

  it("repeated ↑ walks older and pins at the oldest entry (no wrap)", () => {
    for (const t of ["a", "b", "c"]) pushComposeSentHistory(KEY, t);
    renderFocused();
    arrow("ArrowUp");
    expect(input().value).toBe("c");
    arrow("ArrowUp");
    expect(input().value).toBe("b");
    arrow("ArrowUp");
    expect(input().value).toBe("a");
    arrow("ArrowUp"); // past the oldest — pins, never wraps to "c"
    expect(input().value).toBe("a");
  });

  it("↓ walks back toward newer and, past the newest, restores the stash and ends the walk", () => {
    for (const t of ["a", "b", "c"]) pushComposeSentHistory(KEY, t);
    renderFocused();
    arrow("ArrowUp");
    arrow("ArrowUp");
    arrow("ArrowUp");
    expect(input().value).toBe("a");

    expect(arrow("ArrowDown")).toBe(false); // consumed
    expect(input().value).toBe("b");
    arrow("ArrowDown");
    expect(input().value).toBe("c");
    arrow("ArrowDown"); // past the newest → the pre-walk stash (empty)
    expect(input().value).toBe("");
    // Walk over: a further ↓ is native again.
    expect(arrow("ArrowDown")).toBe(true);
  });

  it("↓ outside a walk is never intercepted", () => {
    pushComposeSentHistory(KEY, "available");
    renderFocused();
    expect(arrow("ArrowDown")).toBe(true);
    expect(input().value).toBe("");
  });

  it("↑ on a NON-empty textarea outside a walk keeps native cursor movement", () => {
    pushComposeSentHistory(KEY, "recallable");
    renderFocused();
    type("line one\nline two");
    expect(arrow("ArrowUp")).toBe(true); // not consumed — the caret moves
    expect(input().value).toBe("line one\nline two"); // draft untouched
  });

  it("↑ with no history for the target does nothing and starts no walk", () => {
    renderFocused();
    expect(arrow("ArrowUp")).toBe(true); // nothing to recall — stays native
    expect(input().value).toBe("");
    // No walk started, so ↓ is still native too.
    expect(arrow("ArrowDown")).toBe(true);
  });

  it("editing ends the walk — a later ↑ on the edited text is not intercepted", () => {
    pushComposeSentHistory(KEY, "recalled");
    renderFocused();
    arrow("ArrowUp");
    expect(input().value).toBe("recalled");
    type("recalled and edited"); // user edit → walk over
    expect(arrow("ArrowUp")).toBe(true); // non-empty, no walk → native
    expect(input().value).toBe("recalled and edited");
  });

  it("sending ends the walk — the next ↑ starts fresh from the newest entry", async () => {
    pushComposeSentHistory(KEY, "old one");
    const { sent } = renderFocused();
    arrow("ArrowUp");
    expect(input().value).toBe("old one");
    // Re-sending the recalled text: adjacent-dedupe means it does not burn a
    // second slot, and the walk ends.
    await act(async () => fireEvent.keyDown(input(), { key: "Enter" }));
    expect(sendToWindowMock).toHaveBeenCalledWith("srv", "@1", "old one", "insert-line");
    expect(sent).toEqual([]);
    expect(getComposeSentHistory(KEY)).toEqual(["old one"]);
    arrow("ArrowUp");
    expect(input().value).toBe("old one"); // fresh walk from the newest
  });

  it("a walk does not survive a target switch — each target walks its own history", () => {
    const keyA = entryKey("srv", "@a");
    const keyB = entryKey("srv", "@b");
    pushComposeSentHistory(keyA, "A older");
    pushComposeSentHistory(keyA, "A newest");
    pushComposeSentHistory(keyB, "B only");
    renderTwoTargets();

    act(() => fireEvent.click(screen.getByTestId("focus-a")));
    arrow("ArrowUp");
    arrow("ArrowUp");
    expect(input().value).toBe("A older"); // mid-walk, two steps back

    // Switch to B: A's walk (and its stash) must not carry over.
    act(() => fireEvent.click(screen.getByTestId("focus-b")));
    expect(input().value).toBe(""); // B's draft, untouched by A's walk
    arrow("ArrowUp");
    expect(input().value).toBe("B only"); // B's own newest, not A's index

    // Back on A: its draft still holds the recalled text (recall persists as a
    // draft — it behaves exactly like typing), and a fresh walk starts over.
    act(() => fireEvent.click(screen.getByTestId("focus-a")));
    expect(input().value).toBe("A older");
  });

  // The switch must end the walk EAGERLY (on the `draftKey` change), not lazily
  // at the next keydown. The test above cannot see the difference because it
  // presses ↑ on B, which tears a lazily-checked walk down as a side effect —
  // these two round-trip through B WITHOUT any arrow there.
  it("an A→B→A round-trip with no arrow on B starts a fresh walk from A's newest", () => {
    const keyA = entryKey("srv", "@a");
    pushComposeSentHistory(keyA, "A older");
    pushComposeSentHistory(keyA, "A newest");
    renderTwoTargets();

    // Walk A back two steps, then leave and come straight back — no arrow on B.
    act(() => fireEvent.click(screen.getByTestId("focus-a")));
    arrow("ArrowUp");
    arrow("ArrowUp");
    expect(input().value).toBe("A older");
    act(() => fireEvent.click(screen.getByTestId("focus-b")));
    act(() => fireEvent.click(screen.getByTestId("focus-a")));

    // A's draft still shows the recalled text, but the WALK is gone. Because
    // the textarea is non-empty and no walk is in progress, ↑ is now native
    // cursor movement — it must not resume A's stale index (which would step
    // past "A older" and pin, silently continuing a walk the user abandoned).
    expect(input().value).toBe("A older");
    expect(arrow("ArrowUp")).toBe(true); // not consumed
    expect(input().value).toBe("A older");

    // Clearing the draft re-opens recall, and it starts from the NEWEST entry.
    type("");
    arrow("ArrowUp");
    expect(input().value).toBe("A newest");
  });

  it("an upload mid-walk ends the walk — the path line survives the next arrow", async () => {
    uploadFilesMock.mockResolvedValueOnce([
      { path: "/wt/.uploads/a.png", file: new File(["a"], "a.png", { type: "image/png" }) },
    ]);
    pushComposeSentHistory(KEY, "older sent");
    pushComposeSentHistory(KEY, "newest sent");
    renderFocused();

    // Walk to the newest entry, then attach a file mid-walk.
    arrow("ArrowUp");
    expect(input().value).toBe("newest sent");
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(picker, {
        target: { files: [new File(["a"], "a.png", { type: "image/png" })] },
      });
    });
    expect(input().value).toBe("newest sent\n/wt/.uploads/a.png");
    expect(screen.getByTestId("compose-strip-previews")).toBeInTheDocument();

    // The upload ended the walk, so ↑ is native on the now-non-empty text. A
    // still-armed walk would overwrite the text with "older sent", dropping the
    // path line while the File and its preview chip stayed mounted — an
    // attachment the agent could never resolve.
    expect(arrow("ArrowUp")).toBe(true); // not consumed
    expect(input().value).toBe("newest sent\n/wt/.uploads/a.png");
    expect(screen.getByTestId("compose-strip-previews")).toBeInTheDocument();
  });

  it("removing an attachment mid-walk ends the walk", async () => {
    uploadFilesMock.mockResolvedValueOnce([
      { path: "/wt/.uploads/b.png", file: new File(["b"], "b.png", { type: "image/png" }) },
    ]);
    pushComposeSentHistory(KEY, "older sent");
    pushComposeSentHistory(KEY, "newest sent");
    renderFocused();

    // Attach first (this ends the initial walk), then start a NEW walk — the
    // non-empty text means ↑ is native, so clear it to re-open recall.
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(picker, {
        target: { files: [new File(["b"], "b.png", { type: "image/png" })] },
      });
    });
    type("/wt/.uploads/b.png");
    // Remove the attachment while no walk is running is uninteresting; start
    // one by clearing and recalling, which keeps the preview mounted.
    type("");
    arrow("ArrowUp");
    expect(input().value).toBe("newest sent");
    expect(screen.getByTestId("compose-strip-previews")).toBeInTheDocument();

    // Remove the (now text-less) attachment mid-walk: the splice is a text
    // mutation, so it ends the walk.
    act(() => fireEvent.click(screen.getByLabelText("Remove b.png")));
    expect(screen.queryByTestId("compose-strip-previews")).not.toBeInTheDocument();
    expect(arrow("ArrowUp")).toBe(true); // walk over → native
    expect(input().value).toBe("newest sent");
  });

  it("an IME-composing arrow is never intercepted (candidate-list navigation)", () => {
    pushComposeSentHistory(KEY, "recallable");
    renderFocused();
    // ↑/↓ move through the IME candidate list while composing — swallowing them
    // would break the very surface the strip exists to provide (xterm.js has no
    // IME). Both neighbouring layers guard on isComposing the same way.
    let notPrevented = true;
    act(() => {
      notPrevented = fireEvent.keyDown(input(), { key: "ArrowUp", isComposing: true });
    });
    expect(notPrevented).toBe(true);
    expect(input().value).toBe(""); // nothing recalled
  });

  it.each([
    ["Shift (selection extension)", { shiftKey: true }],
    ["Alt (paragraph jump)", { altKey: true }],
    ["Meta (document jump)", { metaKey: true }],
    ["Ctrl", { ctrlKey: true }],
  ])("a modified ↑ (%s) stays native and recalls nothing", (_label, modifier) => {
    pushComposeSentHistory(KEY, "recallable");
    renderFocused();
    let notPrevented = true;
    act(() => {
      notPrevented = fireEvent.keyDown(input(), { key: "ArrowUp", ...modifier });
    });
    expect(notPrevented).toBe(true);
    expect(input().value).toBe("");
  });

  it("a modified ↓ mid-walk stays native and does not step the walk", () => {
    for (const t of ["a", "b"]) pushComposeSentHistory(KEY, t);
    renderFocused();
    arrow("ArrowUp");
    arrow("ArrowUp");
    expect(input().value).toBe("a");
    // Shift+↓ extends the selection — it must not walk forward to "b".
    let notPrevented = true;
    act(() => {
      notPrevented = fireEvent.keyDown(input(), { key: "ArrowDown", shiftKey: true });
    });
    expect(notPrevented).toBe(true);
    expect(input().value).toBe("a");
    // The walk itself is untouched: a bare ↓ still steps forward.
    arrow("ArrowDown");
    expect(input().value).toBe("b");
  });

  /** Place a collapsed caret at `pos` without firing onChange (caret motion
   * is not an edit, so it must not end the walk). */
  function caret(pos: number, end = pos) {
    act(() => input().setSelectionRange(pos, end));
  }

  it("arrows inside a multi-line recall move the caret natively — the walk steps only from the boundary rows", () => {
    pushComposeSentHistory(KEY, "old");
    pushComposeSentHistory(KEY, "line1\nline2");
    renderFocused();
    arrow("ArrowUp");
    expect(input().value).toBe("line1\nline2");

    // Caret inside line2 (not the first line): ↑ is native cursor movement —
    // it must NOT nuke the recalled text by jumping to the older entry.
    caret(8);
    expect(arrow("ArrowUp")).toBe(true);
    expect(input().value).toBe("line1\nline2");
    // Caret on line1 (not the last line): ↓ is native cursor movement.
    caret(2);
    expect(arrow("ArrowDown")).toBe(true);
    expect(input().value).toBe("line1\nline2");

    // The walk survived the native motions (caret motion is not an edit):
    // ↑ from the FIRST line steps to the older entry…
    caret(2);
    expect(arrow("ArrowUp")).toBe(false);
    expect(input().value).toBe("old");
    // …and ↓ (single-line entry — every caret is the last line) steps back.
    caret(3);
    expect(arrow("ArrowDown")).toBe(false);
    expect(input().value).toBe("line1\nline2");
    // ↓ from the LAST line steps past the newest and restores the stash.
    caret(11);
    expect(arrow("ArrowDown")).toBe(false);
    expect(input().value).toBe("");
  });

  it("a selection inside a recalled entry keeps arrows native (bare arrow = collapse motion)", () => {
    for (const t of ["a", "recalled"] as const) pushComposeSentHistory(KEY, t);
    renderFocused();
    arrow("ArrowUp");
    expect(input().value).toBe("recalled");

    caret(1, 4); // non-collapsed selection
    expect(arrow("ArrowUp")).toBe(true);
    expect(arrow("ArrowDown")).toBe(true);
    expect(input().value).toBe("recalled");

    // Collapsing the selection re-arms the walk.
    caret(0);
    expect(arrow("ArrowUp")).toBe(false);
    expect(input().value).toBe("a");
  });

  it("recall restores text only — no attachment is resurrected", async () => {
    uploadFilesMock.mockResolvedValueOnce([
      { path: "/wt/.uploads/x.png", file: new File(["x"], "x.png", { type: "image/png" }) },
    ]);
    const { sent } = renderFocused();
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(picker, {
        target: { files: [new File(["x"], "x.png", { type: "image/png" })] },
      });
    });
    expect(screen.getByTestId("compose-strip-previews")).toBeInTheDocument();

    await act(async () => fireEvent.keyDown(input(), { key: "Enter" }));
    expect(sendToWindowMock).toHaveBeenCalledWith("srv", "@1", "/wt/.uploads/x.png", "insert-line");
    expect(sent).toEqual([]);
    expect(screen.queryByTestId("compose-strip-previews")).not.toBeInTheDocument();

    arrow("ArrowUp");
    // The path LINE comes back (it is part of the text) — the File object,
    // and therefore the preview, does not.
    expect(input().value).toBe("/wt/.uploads/x.png");
    expect(screen.queryByTestId("compose-strip-previews")).not.toBeInTheDocument();
  });

  // ── Coarse-pointer collapse + ⏎ newline chip (260814-ink6) ───────────────

  const newlineBtn = () => screen.getByTestId("compose-strip-newline") as HTMLButtonElement;

  it("coarse normal mode folds the header row away and moves the target into the placeholder", () => {
    stubPointer(true);
    seedWindow("srv", "@1", "grainy-magpie");
    render(<Harness focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />);
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    expect(screen.queryByTestId("compose-strip-target")).toBeNull();
    expect(screen.queryByTestId("compose-strip-close")).toBeNull();
    expect(input().placeholder).toBe("→ grainy-magpie…");
  });

  it("fine pointers fold the header only at the in-tile dock; the footer dock and broadcast keep it", () => {
    stubPointer(false);
    // Footer dock (no dockedInTile prop): the header renders — no tile frame
    // names the target there (board route, no-tty fallback).
    const footer = render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    expect(screen.getByTestId("compose-strip-target")).toBeInTheDocument();
    expect(screen.getByTestId("compose-strip-close")).toBeInTheDocument();
    footer.unmount();

    // In-tile dock (dockedInTile): the tile frame names the target, so the
    // header folds — the `a|` chip is the on-strip closer there.
    const inTile = render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
          <ComposeStrip dockedInTile />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    expect(screen.queryByTestId("compose-strip-target")).toBeNull();
    expect(screen.queryByTestId("compose-strip-close")).toBeNull();
    expect(screen.getByTestId("compose-strip-a-close")).toBeInTheDocument();
    inTile.unmount();

    // Selection broadcast overrides the fold even at the in-tile dock:
    // `→ N selected` is real signal.
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <ComposeStrip dockedInTile selectionTarget={{ keys: SELECTION_KEYS, onSend: vi.fn().mockResolvedValue(2) }} />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    expect(screen.getByTestId("compose-strip-target")).toHaveTextContent("2 selected");
  });

  it("the header returns on coarse in selection-broadcast mode — and the ⏎ chip hides there", () => {
    stubPointer(true);
    renderSelection(vi.fn().mockResolvedValue(2));
    // `→ N selected` is real signal, so the header row renders as on fine…
    expect(screen.getByTestId("compose-strip-target")).toHaveTextContent("2 selected");
    // …but broadcast's plain Enter is already a local newline, so the chip
    // would duplicate the return key.
    expect(screen.queryByTestId("compose-strip-newline")).toBeNull();
  });

  it("the header returns on coarse in the disabled no-target state (forced-expanded body); the ⏎ chip stays hidden while empty", () => {
    stubPointer(true);
    // Target-less body only under `forceExpanded` (the operator page).
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <ComposeStrip forceExpanded />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    expect(screen.getByTestId("compose-strip-target")).toHaveTextContent("no target");
    expect(input()).toBeDisabled();
    // The no-target state is exempt from the compact morph (it keeps the
    // card's stacked form), but the ⏎ chip hides while the composer is empty.
    expect(screen.getByTestId("compose-strip-card")).toBeInTheDocument();
    expect(screen.queryByTestId("compose-strip-newline")).toBeNull();
  });

  it("coarse compact: a single row — 📎, textarea, Send — with no Insert, no ⏎, no a|, rows={1}", () => {
    stubPointer(true);
    render(<Harness focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />);
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    // Blurred + empty + no attachments → compact (focus drives the card).
    expect(screen.queryByTestId("compose-strip-card")).toBeNull();
    expect(input()).toHaveAttribute("rows", "1");
    // The mobile return key already performs insert-line, so Insert is dropped…
    expect(screen.queryByTestId("compose-strip-insert")).toBeNull();
    // …the ⏎ chip hides while the composer is empty…
    expect(screen.queryByTestId("compose-strip-newline")).toBeNull();
    // …and the a| closer is dropped entirely on coarse.
    expect(screen.queryByTestId("compose-strip-a-close")).toBeNull();
    // All three controls share the ONE row.
    const row = input().parentElement;
    expect(screen.getByRole("button", { name: "Upload file" }).parentElement).toBe(row);
    expect(sendBtn().parentElement).toBe(row);
  });

  it("coarse card: the chip row is 📎 · ⏎ · spacer · Send once the composer has text", () => {
    stubPointer(true);
    renderFocused();
    act(() => input().focus()); // focus morphs coarse to the card
    act(() => fireEvent.change(input(), { target: { value: "draft" } }));
    const card = screen.getByTestId("compose-strip-card");
    expect(newlineBtn().parentElement).toBe(card);
    expect(sendBtn().parentElement).toBe(card);
    expect(screen.getByRole("button", { name: "Upload file" }).parentElement).toBe(card);
    expect(screen.queryByTestId("compose-strip-insert")).toBeNull();
    expect(screen.queryByTestId("compose-strip-a-close")).toBeNull();
  });

  it("coarse card chip order is 📎 · ⏎ · ↺ and the history glyph is ↺", () => {
    stubPointer(true);
    renderFocused();
    act(() => pushComposeSentHistory(entryKey("srv", "@1"), "earlier send"));
    act(() => input().focus());
    act(() => fireEvent.change(input(), { target: { value: "draft" } }));
    const attach = screen.getByRole("button", { name: "Upload file" });
    const history = screen.getByTestId("compose-strip-history");
    expect(history).toHaveTextContent("↺");
    // DOM order carries the visual order: 📎 before ⏎ before ↺.
    expect(attach.compareDocumentPosition(newlineBtn()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(newlineBtn().compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("fine card row is 📎 · a| · spacer · Insert · Send with no ⏎ chip", () => {
    stubPointer(false);
    render(<Harness focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />);
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    act(() => fireEvent.change(input(), { target: { value: "x" } }));
    expect(input()).toHaveAttribute("rows", "1");
    const card = screen.getByTestId("compose-strip-card");
    expect(screen.getByRole("button", { name: "Upload file" }).parentElement).toBe(card);
    expect(screen.getByTestId("compose-strip-a-close").parentElement).toBe(card);
    expect(insertBtn().parentElement).toBe(card);
    expect(sendBtn().parentElement).toBe(card);
    expect(screen.queryByTestId("compose-strip-newline")).toBeNull();
  });

  it("⏎ inserts a newline at the caret, keeps focus, and persists through the draft store", () => {
    stubPointer(true);
    renderFocused();
    type("abc");
    const el = input();
    act(() => {
      el.focus();
      el.setSelectionRange(2, 2); // caret after "b"
    });
    // mousedown is default-prevented — the on-screen keyboard must not dismiss.
    let notPrevented = true;
    act(() => {
      notPrevented = fireEvent.mouseDown(newlineBtn());
    });
    expect(notPrevented).toBe(false);
    act(() => fireEvent.click(newlineBtn()));
    expect(input().value).toBe("ab\nc");
    expect(input().selectionStart).toBe(3); // caret after the inserted newline
    expect(document.activeElement).toBe(input());
  });

  it("⏎ is hidden while the composer is empty and appears once the draft has text", () => {
    stubPointer(true);
    renderFocused();
    // Focused (card form) but empty: the chip stays hidden — a bare newline
    // on an empty composer would transmit nothing.
    act(() => input().focus());
    expect(screen.getByTestId("compose-strip-card")).toBeInTheDocument();
    expect(screen.queryByTestId("compose-strip-newline")).toBeNull();
    type("x");
    expect(newlineBtn()).toBeInTheDocument();
  });

  it("⏎ ends an in-progress recall walk (a text mutation like typing)", () => {
    stubPointer(true);
    pushComposeSentHistory(KEY, "older");
    pushComposeSentHistory(KEY, "newest");
    renderFocused();
    arrow("ArrowUp");
    expect(input().value).toBe("newest");
    // Focus morphs coarse to the card, where the ⏎ chip lives.
    act(() => input().focus());

    act(() => fireEvent.click(newlineBtn()));
    expect(input().value).toBe("newest\n");

    // The walk ended: ↑ on the now non-empty composition is native cursor
    // movement — a still-armed walk would overwrite the text with "older".
    expect(arrow("ArrowUp")).toBe(true);
    expect(input().value).toBe("newest\n");
  });

  it("⏎ prefers the undo-safe execCommand path when the browser offers it", () => {
    stubPointer(true);
    const exec = vi.fn().mockReturnValue(true);
    const original = document.execCommand;
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      writable: true,
      value: exec,
    });
    try {
      renderFocused();
      type("abc");
      act(() => {
        input().focus(); // coarse card: the ⏎ chip lives in the card form
        input().setSelectionRange(2, 2);
      });
      act(() => fireEvent.click(newlineBtn()));
      expect(exec).toHaveBeenCalledWith("insertText", false, "\n");
    } finally {
      Object.defineProperty(document, "execCommand", {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });

  // ── Card/compact morph triggers + the fine hysteresis latch ─────────────

  it("fine: focus alone NEVER morphs — the compact row stays put (no xterm refit on stray clicks)", () => {
    stubPointer(false);
    renderFocused();
    act(() => input().focus());
    expect(document.activeElement).toBe(input());
    expect(screen.queryByTestId("compose-strip-card")).toBeNull();
    expect(screen.queryByTestId("compose-strip-insert")).toBeNull();
    act(() => input().blur());
    expect(screen.queryByTestId("compose-strip-card")).toBeNull();
  });

  it("fine latch: type → card, erase-all → still card, blur-while-empty → compact", () => {
    stubPointer(false);
    renderFocused();
    act(() => input().focus());
    type("x");
    expect(screen.getByTestId("compose-strip-card")).toBeInTheDocument();
    // Backspacing the draft away must NOT snap mid-edit (the latch holds).
    type("");
    expect(screen.getByTestId("compose-strip-card")).toBeInTheDocument();
    // Only blur-while-empty releases the latch.
    act(() => input().blur());
    expect(screen.queryByTestId("compose-strip-card")).toBeNull();
    // And re-focusing the empty composer does not re-enter the card.
    act(() => input().focus());
    expect(screen.queryByTestId("compose-strip-card")).toBeNull();
  });

  it("fine latch: removing the last attachment while blurred holds the card until the next blur-while-empty", async () => {
    stubPointer(false);
    uploadFilesMock.mockResolvedValueOnce([
      { path: "/wt/.uploads/x.png", file: new File(["x"], "x.png", { type: "image/png" }) },
    ]);
    renderFocused();
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(picker, { target: { files: [new File(["x"], "x.png", { type: "image/png" })] } });
    });
    expect(screen.getByTestId("compose-strip-card")).toBeInTheDocument();

    // Remove the attachment (this also splices its path line out of the
    // text): with no focus and nothing left, the latch still holds the card.
    act(() => fireEvent.click(screen.getByLabelText("Remove x.png")));
    expect(input().value).toBe("");
    expect(screen.getByTestId("compose-strip-card")).toBeInTheDocument();

    // The release needs an actual blur-while-empty.
    act(() => input().focus());
    act(() => input().blur());
    expect(screen.queryByTestId("compose-strip-card")).toBeNull();
  });

  it("coarse: focus morphs to the card; blur while empty returns compact", () => {
    stubPointer(true);
    renderFocused();
    expect(screen.queryByTestId("compose-strip-card")).toBeNull();
    act(() => input().focus());
    expect(screen.getByTestId("compose-strip-card")).toBeInTheDocument();
    act(() => input().blur());
    expect(screen.queryByTestId("compose-strip-card")).toBeNull();
  });

  it("coarse: a multi-line draft holds the card without focus; a single-line draft compacts", () => {
    stubPointer(true);
    renderFocused();
    // jsdom never wraps (scrollHeight probe reads 0), so the explicit-\n
    // branch carries this test.
    type("line one\nline two");
    expect(screen.getByTestId("compose-strip-card")).toBeInTheDocument();
    type("single line");
    expect(screen.queryByTestId("compose-strip-card")).toBeNull();
  });

  it("coarse: blur with a draft that wraps only in the compact row re-enters the card (layout-aware wrap probe)", () => {
    stubPointer(true);
    renderFocused();
    // jsdom has no layout, so emulate the width-dependent wrap: long text
    // reads one line in the full-width card box (`w-full`) but two lines in
    // the narrower compact box (`flex-1`, chips flanking); short text fits
    // both. The morph re-measures under the new layout, so the probe must
    // read the box it actually renders in.
    const el = input();
    Object.defineProperty(el, "offsetHeight", { configurable: true, get: () => 20 });
    Object.defineProperty(el, "scrollHeight", {
      configurable: true,
      get: () => (el.className.includes("flex-1") && el.value.length > 40 ? 40 : 20),
    });
    act(() => el.focus());
    type("a long single-line draft that fits the wide card but wraps compact");
    expect(screen.getByTestId("compose-strip-card")).toBeInTheDocument();
    // Blur: focus no longer holds the card, but the compact re-measure finds
    // the text wrapping — the multiline trigger holds the card open (and the
    // card's unwrapped reading must NOT release it: no oscillation).
    act(() => el.blur());
    expect(screen.getByTestId("compose-strip-card")).toBeInTheDocument();
    // A text edit re-measures fresh: shortened to fit the compact row, the
    // strip compacts.
    type("ok");
    expect(screen.queryByTestId("compose-strip-card")).toBeNull();
  });

  it("coarse: attachments morph to the card (previews render inside it, above the textarea)", async () => {
    stubPointer(true);
    uploadFilesMock.mockResolvedValueOnce([
      { path: "/wt/.uploads/a.png", file: new File(["a"], "a.png", { type: "image/png" }) },
    ]);
    renderFocused();
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(picker, { target: { files: [new File(["a"], "a.png", { type: "image/png" })] } });
    });
    const card = screen.getByTestId("compose-strip-card");
    const previews = screen.getByTestId("compose-strip-previews");
    // The preview row is the card's FIRST child, above the textarea.
    expect(previews.parentElement).toBe(card);
    expect(
      previews.compareDocumentPosition(input()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("coarse: the a| closer is gone in EVERY state (compact, card, broadcast)", () => {
    stubPointer(true);
    const view = render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    expect(screen.queryByTestId("compose-strip-a-close")).toBeNull();
    // Card form via focus — still no a|.
    act(() => input().focus());
    expect(screen.getByTestId("compose-strip-card")).toBeInTheDocument();
    expect(screen.queryByTestId("compose-strip-a-close")).toBeNull();
    view.unmount();
    // Selection broadcast — still no a|.
    renderSelection(vi.fn().mockResolvedValue(2));
    expect(screen.queryByTestId("compose-strip-a-close")).toBeNull();
  });

  it("while uploading, the busy state lives ON the 📎 chip — disabled, aria-busy, role=status within it", () => {
    uploadState.uploading = true;
    render(<Harness focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />);
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    const chip = screen.getByRole("button", { name: "Upload file" });
    expect(chip).toBeDisabled();
    expect(chip).toHaveAttribute("aria-busy", "true");
    // The live status is attached to the chip itself — no standalone
    // `Uploading…` text in the header row or inline in the strip body.
    const status = screen.getByTestId("compose-strip-uploading");
    expect(status).toHaveAttribute("role", "status");
    expect(status.closest("button")).toBe(chip);
  });

  it("publishes textarea focus to the module store and clears it on blur and unmount", () => {
    const { view } = renderFocused();
    expect(isComposeStripFocused()).toBe(false);
    act(() => {
      input().focus();
    });
    expect(isComposeStripFocused()).toBe(true);
    act(() => {
      input().blur();
    });
    expect(isComposeStripFocused()).toBe(false);
    // A strip toggled off while focused must not stick the bar hidden.
    act(() => {
      input().focus();
    });
    act(() => view.unmount());
    expect(isComposeStripFocused()).toBe(false);
  });

  it("the bottom bar hides while the textarea is focused on a coarse pointer, and returns on blur", () => {
    stubPointer(true);
    // Strip + BottomBar as siblings — the same mount topology as the two
    // shell footers (app.tsx / board-page.tsx), wired only through the
    // module-store focus signal.
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
          <ComposeStrip />
          <BottomBar onOpenCompose={vi.fn()} />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    expect(screen.getByRole("toolbar")).toBeInTheDocument();
    act(() => {
      input().focus();
    });
    expect(screen.queryByRole("toolbar")).toBeNull();
    // Blur (Escape's contract) restores the bar.
    act(() => {
      input().blur();
    });
    expect(screen.getByRole("toolbar")).toBeInTheDocument();
  });

  it("StrictMode's effect replay cannot strand the focus flag while the textarea holds focus", () => {
    // e2e/dev run under <StrictMode>: the replay runs the mount cleanup after
    // focus-on-open already focused the textarea, and no new focus event fires
    // for the still-focused element — the mount-time sync from
    // document.activeElement is what re-publishes the flag.
    localStorage.setItem("hexokit-compose-strip", "false");
    render(
      <StrictMode>
        <ToggleHarness focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
      </StrictMode>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    act(() => fireEvent.click(screen.getByTestId("toggle-strip")));
    expect(document.activeElement).toBe(input());
    expect(isComposeStripFocused()).toBe(true);
  });

  it("the bottom bar never renders on a fine pointer (260814-ldbs) — composing is unaffected either way", () => {
    // The fine-pointer bar is GONE now (the pointer gate), superseding ink6's
    // "never hides on fine" rule: the strip owns the fine-pointer desktop's
    // compose UX alone. The strip itself must stay put while focused.
    stubPointer(false);
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={{ wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />
          <ComposeStrip />
          <BottomBar onOpenCompose={vi.fn()} />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    act(() => {
      input().focus();
    });
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    expect(input()).toBeInTheDocument();
  });
});

describe("ComposeStrip window send path", () => {
  beforeEach(() => {
    useWindowStore.setState({ entries: new Map(), ghosts: [] });
    localStorage.clear();
    hydrateComposeDrafts();
    // The surface always mounts; the preference picks expanded vs. tongue.
    // These tests exercise the expanded body, so seed the preference ON after
    // the clear (ChromeProvider reads it at mount).
    localStorage.setItem("hexokit-compose-strip", "true");
    hydrateComposeSentHistory();
    stubPointer(false);
    sendToWindowMock.mockReset();
    sendToWindowMock.mockResolvedValue({ ok: true });
    addToastMock.mockReset();
    setOperatorChatSubject(null);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  function mountFocused() {
    const ws = makeWs();
    render(<Harness focus={{ wsRef: ws.ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />);
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    return ws;
  }

  it("multi-line + Ctrl/Cmd+Enter sends submit intent and records history", async () => {
    const ws = mountFocused();
    act(() => fireEvent.change(input(), { target: { value: "one\ntwo" } }));
    await act(async () => {
      fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
    });
    expect(sendToWindowMock).toHaveBeenCalledTimes(1);
    expect(sendToWindowMock).toHaveBeenCalledWith("srv", "@1", "one\ntwo", "submit");
    expect(ws.sent).toEqual([]);
    expect(input().value).toBe("");
    expect(getComposeSentHistory(entryKey("srv", "@1"))).toEqual(["one\ntwo"]);
  });

  it("multi-line + plain Enter sends insert-line intent", async () => {
    const ws = mountFocused();
    act(() => fireEvent.change(input(), { target: { value: "one\ntwo" } }));
    await act(async () => {
      fireEvent.keyDown(input(), { key: "Enter" });
    });
    expect(sendToWindowMock).toHaveBeenCalledWith("srv", "@1", "one\ntwo", "insert-line");
    expect(ws.sent).toEqual([]);
    expect(input().value).toBe("");
  });

  it("multi-line + Alt+Enter sends raw intent without touching the websocket", async () => {
    const ws = mountFocused();
    act(() => fireEvent.change(input(), { target: { value: "one\ntwo" } }));
    await act(async () => {
      fireEvent.keyDown(input(), { key: "Enter", altKey: true });
    });
    expect(sendToWindowMock).toHaveBeenCalledWith("srv", "@1", "one\ntwo", "raw");
    expect(ws.sent).toEqual([]);
  });

  it("single-line + Ctrl+Enter sends submit intent without touching the websocket", async () => {
    const ws = mountFocused();
    act(() => fireEvent.change(input(), { target: { value: "one" } }));
    await act(async () => {
      fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
    });
    expect(sendToWindowMock).toHaveBeenCalledWith("srv", "@1", "one", "submit");
    expect(ws.sent).toEqual([]);
  });

  it("a newline-only submit sends enter intent and records no history", async () => {
    const ws = mountFocused();
    act(() => fireEvent.change(input(), { target: { value: "\n" } }));
    await act(async () => {
      fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
    });
    expect(sendToWindowMock).toHaveBeenCalledWith("srv", "@1", "", "enter");
    expect(ws.sent).toEqual([]);
    expect(input().value).toBe("");
    expect(getComposeSentHistory(entryKey("srv", "@1"))).toEqual([]);
  });

  it("locks both send controls while a request is in flight", async () => {
    let resolveSend: (value: { ok: boolean }) => void = () => undefined;
    sendToWindowMock.mockImplementation(
      () => new Promise<{ ok: boolean }>((resolve) => { resolveSend = resolve; }),
    );
    mountFocused();
    act(() => fireEvent.change(input(), { target: { value: "hello" } }));
    act(() => fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true }));
    expect(screen.getByTestId("compose-strip-send")).toHaveTextContent("Sending…");
    expect(screen.getByTestId("compose-strip-send")).toBeDisabled();
    act(() => fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true }));
    expect(sendToWindowMock).toHaveBeenCalledTimes(1);
    await act(async () => resolveSend({ ok: true }));
    expect(screen.getByTestId("compose-strip-send")).toHaveTextContent("Send");
  });

  it("probe failure shows staged-text recovery and keeps the draft", async () => {
    sendToWindowMock.mockRejectedValue(
      new ApiError("probe failed", 409, "probe_failure"),
    );
    mountFocused();
    act(() => fireEvent.change(input(), { target: { value: "hello" } }));
    await act(async () => {
      fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
    });
    expect(addToastMock).toHaveBeenCalledTimes(1);
    expect(addToastMock.mock.calls[0]?.[0]).toContain("staged in the pane");
    const action = addToastMock.mock.calls[0]?.[2];
    expect(action?.label).toBe("Press Enter in pane");
    expect(input().value).toBe("hello");
    expect(getComposeSentHistory(entryKey("srv", "@1"))).toEqual([]);

    sendToWindowMock.mockResolvedValue({ ok: true });
    await act(async () => action?.onSelect());
    expect(sendToWindowMock).toHaveBeenLastCalledWith("srv", "@1", "", "enter");
  });

  it("staged send failure shows staged-text recovery and keeps the draft", async () => {
    sendToWindowMock.mockRejectedValue(
      new ApiError("send failed after paste", 409, "staged_send_failure"),
    );
    mountFocused();
    act(() => fireEvent.change(input(), { target: { value: "hello" } }));
    await act(async () => {
      fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
    });

    expect(addToastMock).toHaveBeenCalledTimes(1);
    expect(addToastMock.mock.calls[0]?.[0]).toContain("staged in the pane");
    expect(addToastMock.mock.calls[0]?.[2]?.label).toBe("Press Enter in pane");
    expect(input().value).toBe("hello");
    expect(getComposeSentHistory(entryKey("srv", "@1"))).toEqual([]);
  });

  it("locks both send controls while the recovery Enter is in flight", async () => {
    sendToWindowMock.mockRejectedValue(
      new ApiError("probe failed", 409, "probe_failure"),
    );
    mountFocused();
    act(() => fireEvent.change(input(), { target: { value: "hello" } }));
    await act(async () => {
      fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
    });
    const action = addToastMock.mock.calls[0]?.[2];
    expect(screen.getByTestId("compose-strip-send")).not.toBeDisabled();

    let resolveEnter: (value: { ok: boolean }) => void = () => undefined;
    sendToWindowMock.mockImplementation(
      () => new Promise<{ ok: boolean }>((resolve) => { resolveEnter = resolve; }),
    );
    act(() => action?.onSelect());
    expect(screen.getByTestId("compose-strip-send")).toHaveTextContent("Sending…");
    expect(screen.getByTestId("compose-strip-send")).toBeDisabled();
    act(() => fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true }));
    expect(sendToWindowMock).toHaveBeenCalledTimes(2);
    await act(async () => resolveEnter({ ok: true }));
    expect(screen.getByTestId("compose-strip-send")).toHaveTextContent("Send");
  });

  it("submit-unverified failure warns that Enter was sent and offers no action", async () => {
    sendToWindowMock.mockRejectedValue(
      new ApiError("submit unknown", 409, "submit_unverified"),
    );
    mountFocused();
    act(() => fireEvent.change(input(), { target: { value: "hello" } }));
    await act(async () => {
      fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
    });
    expect(addToastMock.mock.calls[0]?.[0]).toContain("Enter was sent");
    expect(addToastMock.mock.calls[0]?.[2]).toBeUndefined();
    expect(input().value).toBe("hello");
    expect(getComposeSentHistory(entryKey("srv", "@1"))).toEqual([]);
  });

  it("ordinary failure says nothing was delivered and keeps the draft", async () => {
    sendToWindowMock.mockRejectedValue(new Error("network down"));
    mountFocused();
    act(() => fireEvent.change(input(), { target: { value: "hello" } }));
    await act(async () => {
      fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
    });
    expect(addToastMock.mock.calls[0]?.[0]).toContain("nothing was delivered");
    expect(addToastMock.mock.calls[0]?.[2]).toBeUndefined();
    expect(input().value).toBe("hello");
    expect(getComposeSentHistory(entryKey("srv", "@1"))).toEqual([]);
  });

  it("a changed draft survives asynchronous delivery", async () => {
    let resolveSend: (value: { ok: boolean }) => void = () => undefined;
    sendToWindowMock.mockImplementation(
      () => new Promise<{ ok: boolean }>((resolve) => { resolveSend = resolve; }),
    );
    mountFocused();
    act(() => fireEvent.change(input(), { target: { value: "one\ntwo" } }));
    act(() => fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true }));
    act(() => fireEvent.change(input(), { target: { value: "one\ntwo\nthree" } }));
    await act(async () => resolveSend({ ok: true }));
    expect(input().value).toBe("one\ntwo\nthree");
    expect(getComposeSentHistory(entryKey("srv", "@1"))).toEqual(["one\ntwo"]);
  });

  it("an attachment added during delivery survives", async () => {
    let resolveSend: (value: { ok: boolean }) => void = () => undefined;
    sendToWindowMock.mockImplementation(
      () => new Promise<{ ok: boolean }>((resolve) => { resolveSend = resolve; }),
    );
    mountFocused();
    act(() => fireEvent.change(input(), { target: { value: "one\ntwo" } }));
    act(() => fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true }));
    const attachment = { path: "/tmp/late.png", file: new File(["x"], "late.png") };
    act(() => setComposeAttachments(entryKey("srv", "@1"), [attachment]));
    await act(async () => resolveSend({ ok: true }));
    expect(input().value).toBe("one\ntwo");
    expect(getComposeDraft(entryKey("srv", "@1")).attachments).toEqual([attachment]);
    expect(getComposeSentHistory(entryKey("srv", "@1"))).toEqual(["one\ntwo"]);
  });
});

describe("ComposeStrip operator chat lane", () => {
  beforeEach(() => {
    useWindowStore.setState({ entries: new Map(), ghosts: [] });
    localStorage.clear();
    hydrateComposeDrafts();
    // The surface always mounts; the preference picks expanded vs. tongue.
    // These tests exercise the expanded body, so seed the preference ON after
    // the clear (ChromeProvider reads it at mount).
    localStorage.setItem("hexokit-compose-strip", "true");
    hydrateComposeSentHistory();
    stubPointer(false);
    setOperatorChatSubject(null);
    sendToWindowMock.mockReset();
    sendToWindowMock.mockResolvedValue({ ok: true });
    operatorRequestMock.mockReset();
    operatorRequestMock.mockResolvedValue({ outcome: "delivered" });
    addToastMock.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  /** The strip focused on the operator window (@9) — the operator route's
   *  mount — with the `?from=` origin subject stamped by the quake terminal. */
  function mountOperatorRoute() {
    const ws = makeWs();
    render(<Harness focus={{ wsRef: ws.ref, containerRef: { current: null }, server: "srv", session: "_rk-operator", windowId: "@9" }} />);
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    act(() => setOperatorChatSubject({ server: "srv", windowId: "@5", name: "origin" }));
    return ws;
  }

  it("a plain submit rides the templated chat lane at the subject window and clears the draft", async () => {
    mountOperatorRoute();

    expect(screen.getByTestId("quake-terminal-context")).toHaveTextContent('from: @5 "origin"');
    act(() => fireEvent.change(input(), { target: { value: "check the deploy" } }));
    await act(async () => {
      fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
    });

    expect(operatorRequestMock).toHaveBeenCalledTimes(1);
    expect(operatorRequestMock).toHaveBeenCalledWith("srv", "@5", "user-message", "check the deploy");
    expect(sendToWindowMock).not.toHaveBeenCalled();
    expect(input().value).toBe("");
  });

  it("a dismissed chip returns the plain submit to the direct lane at the operator window", async () => {
    mountOperatorRoute();
    act(() => dismissOperatorChatChip());
    expect(screen.queryByTestId("quake-terminal-context")).toBeNull();

    act(() => fireEvent.change(input(), { target: { value: "plain message" } }));
    await act(async () => {
      fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
    });

    expect(sendToWindowMock).toHaveBeenCalledWith("srv", "@9", "plain message", "submit");
    expect(operatorRequestMock).not.toHaveBeenCalled();
  });

  it("a subject that IS the focused window does not fork (the ordinary terminal route)", async () => {
    const ws = makeWs();
    render(<Harness focus={{ wsRef: ws.ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" }} />);
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    act(() => setOperatorChatSubject({ server: "srv", windowId: "@1", name: "win" }));

    expect(screen.queryByTestId("quake-terminal-context")).toBeNull();
    act(() => fireEvent.change(input(), { target: { value: "one" } }));
    await act(async () => {
      fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
    });

    expect(sendToWindowMock).toHaveBeenCalledWith("srv", "@1", "one", "submit");
    expect(operatorRequestMock).not.toHaveBeenCalled();
  });

  it("insert-line and raw sends stay direct even with a subject attached", async () => {
    mountOperatorRoute();

    act(() => fireEvent.change(input(), { target: { value: "staged line" } }));
    await act(async () => {
      fireEvent.keyDown(input(), { key: "Enter" });
    });
    expect(sendToWindowMock).toHaveBeenLastCalledWith("srv", "@9", "staged line", "insert-line");

    act(() => fireEvent.change(input(), { target: { value: "raw bytes" } }));
    await act(async () => {
      fireEvent.keyDown(input(), { key: "Enter", altKey: true });
    });
    expect(sendToWindowMock).toHaveBeenLastCalledWith("srv", "@9", "raw bytes", "raw");
    expect(operatorRequestMock).not.toHaveBeenCalled();
  });

  it("the chip label navigates back to the origin window without dismissing the chip", () => {
    mountOperatorRoute();
    navigateMock.mockReset();

    fireEvent.click(screen.getByRole("button", { name: 'Back to @5 "origin"' }));

    expect(navigateMock).toHaveBeenCalledWith({
      to: "/$server/$window",
      params: { server: "srv", window: "@5" },
      search: {},
    });
    expect(screen.getByTestId("quake-terminal-context")).toBeInTheDocument();
  });

  it("a failed templated send rides the strip's error surface and keeps the draft", async () => {
    operatorRequestMock.mockRejectedValue(new Error("operator unavailable"));
    mountOperatorRoute();

    act(() => fireEvent.change(input(), { target: { value: "retry me" } }));
    await act(async () => {
      fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
    });

    expect(addToastMock).toHaveBeenCalledTimes(1);
    expect(input().value).toBe("retry me");
    expect(sendToWindowMock).not.toHaveBeenCalled();
  });
});

// ── Collapsed tongue (the preference-off / no-target forms) ─────────────────

describe("ComposeStrip collapsed tongue", () => {
  const FOCUS: FocusedTerminal = { wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" };

  beforeEach(() => {
    uploadFilesMock.mockReset();
    uploadState.uploading = false;
    addToastMock.mockReset();
    stubPointer(false);
    // The preference is ON by default; the tongue is the explicit opt-out.
    localStorage.setItem("hexokit-compose-strip", "false");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  /** Exposes the registry-resolved chord the tongue must show, through the
   *  same seam the status-bar / bottom-bar chips use. */
  function ChordProbe() {
    const { bindings, host } = useKeybindings();
    return <span data-testid="chord-probe">{chordHintFor("compose-toggle", bindings, host.platform)}</span>;
  }

  function TongueHarness({ focus, forceExpanded }: { focus: FocusedTerminal; forceExpanded?: boolean }) {
    return (
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={focus} />
          <ChordProbe />
          <ComposeStrip forceExpanded={forceExpanded} />
        </FocusedTerminalProvider>
      </ChromeProvider>
    );
  }

  it("preference off + focused target ⇒ the interactive Compose tongue with the chord on a fine pointer", () => {
    render(<TongueHarness focus={FOCUS} />);
    act(() => fireEvent.click(screen.getByTestId("set-focus")));

    const tongue = screen.getByTestId("compose-tongue");
    expect(tongue).toBe(screen.getByRole("button", { name: "Show compose strip" }));
    expect(tongue).toHaveAttribute("aria-expanded", "false");
    expect(tongue).toHaveTextContent("a▏");
    expect(tongue).toHaveTextContent("Compose");
    // Static glyph: the caret blink means "on".
    expect(tongue.querySelector(".rk-compose-caret")).toBeNull();
    // The chord rides a trailing <kbd>, resolved through the registry seam.
    const expected = screen.getByTestId("chord-probe").textContent;
    expect(expected).not.toBe("");
    expect(tongue.querySelector("kbd")?.textContent).toBe(expected);
    // No expanded-body controls.
    expect(screen.queryByTestId("compose-strip-input")).toBeNull();
    expect(screen.queryByRole("button", { name: "Upload file" })).toBeNull();
    // Root keeps the strip test id + production marker.
    expect(screen.getByTestId("compose-strip")).toHaveAttribute("data-compose-strip");
  });

  it("the tongue hides the chord on a coarse pointer", () => {
    stubPointer(true);
    render(<TongueHarness focus={FOCUS} />);
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    const tongue = screen.getByTestId("compose-tongue");
    expect(tongue).toHaveTextContent("Compose");
    expect(tongue.querySelector("kbd")).toBeNull();
  });

  it("clicking the tongue enables the strip, mounts the body, and focuses the textarea", () => {
    render(<TongueHarness focus={FOCUS} />);
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    const tongue = screen.getByTestId("compose-tongue");
    // Mousedown is default-prevented so the button never takes focus first.
    let notPrevented = true;
    act(() => {
      notPrevented = fireEvent.mouseDown(tongue);
    });
    expect(notPrevented).toBe(false);
    act(() => fireEvent.click(tongue));
    expect(localStorage.getItem("hexokit-compose-strip")).toBe("true");
    expect(screen.queryByTestId("compose-tongue")).toBeNull();
    expect(document.activeElement).toBe(input());
  });

  it("off wins over no-target: with no focused terminal the tongue still reads Compose", () => {
    render(<TongueHarness focus={null} />);
    const tongue = screen.getByTestId("compose-tongue");
    expect(tongue).toHaveTextContent("Compose");
    expect(tongue).not.toHaveAttribute("data-state", "no-target");
    expect(tongue.tagName).toBe("BUTTON");
  });

  it("forceExpanded renders the expanded body regardless of the preference and target", () => {
    render(<TongueHarness focus={null} forceExpanded />);
    expect(screen.queryByTestId("compose-tongue")).toBeNull();
    // The body's own disabled no-target form (the operator page under a
    // non-terminal tab) stays reachable through the override.
    expect(input().disabled).toBe(true);
    expect(screen.getByTestId("compose-strip-target").textContent).toBe("no target");
  });

  it("preference on + selection target renders the broadcast card (a target)", () => {
    localStorage.setItem("hexokit-compose-strip", "true");
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <ComposeStrip selectionTarget={{ keys: ["a:@1", "b:@2"], onSend: vi.fn().mockResolvedValue(2) }} />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    expect(screen.queryByTestId("compose-tongue")).toBeNull();
    expect(screen.getByTestId("compose-strip-target")).toHaveTextContent("2 selected");
  });

  it("focusComposeStrip() declines while the tongue shows (callers fall back)", () => {
    render(<TongueHarness focus={FOCUS} />);
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    expect(focusComposeStrip()).toBe(false);
  });

  it("the draft survives collapse → expand through the tongue", () => {
    localStorage.setItem("hexokit-compose-strip", "true");
    render(<TongueHarness focus={FOCUS} />);
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    act(() => fireEvent.change(input(), { target: { value: "half-typed" } }));
    act(() => fireEvent.click(screen.getByTestId("compose-strip-a-close")));
    expect(screen.getByTestId("compose-tongue")).toHaveTextContent("Compose");
    act(() => fireEvent.click(screen.getByTestId("compose-tongue")));
    expect(input().value).toBe("half-typed");
  });

  it("an attachment queued while collapsed is uploaded when the body mounts", async () => {
    uploadFilesMock.mockResolvedValueOnce([
      { path: "/wt/.uploads/x.png", file: new File(["x"], "x.png", { type: "image/png" }) },
    ]);
    render(<TongueHarness focus={FOCUS} />);
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    // terminal-client's attachToStrip order: toggle on, then dispatch. With the
    // tongue mounted nobody listens, so the files sit in the module queue.
    const file = new File(["x"], "x.png", { type: "image/png" });
    act(() => {
      dispatchComposeStripAttach([file]);
    });
    expect(uploadFilesMock).not.toHaveBeenCalled();
    act(() => fireEvent.click(screen.getByTestId("compose-tongue")));
    // The body's mount-time drain picks the queue up.
    expect(uploadFilesMock).toHaveBeenCalledTimes(1);
    expect(uploadFilesMock.mock.calls[0][0]).toEqual([file]);
    await act(async () => {
      await Promise.resolve();
    });
    expect(input().value).toContain("/wt/.uploads/x.png");
  });
});

// ── The one-time "on by default" notice ─────────────────────────────────────

describe("ComposeStrip default-on notice", () => {
  const FOCUS: FocusedTerminal = { wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" };

  beforeEach(() => {
    addToastMock.mockReset();
    stubPointer(false);
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  function Harness({ forceExpanded }: { forceExpanded?: boolean }) {
    return (
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={FOCUS} />
          <ComposeStrip forceExpanded={forceExpanded} />
        </FocusedTerminalProvider>
      </ChromeProvider>
    );
  }

  it("fires exactly one info toast when the default put the strip on screen, and writes the sentinel first", () => {
    render(<Harness />);
    // No stored preference ⇒ on by default; the body mounts once a target exists.
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    expect(addToastMock).toHaveBeenCalledTimes(1);
    const [message, variant] = addToastMock.mock.calls[0];
    expect(variant).toBe("info");
    expect(message).toMatch(/^Compose is on by default — .+ hides it$/);
    expect(localStorage.getItem("hexokit-compose-default-notice")).toBe("1");
  });

  it("names the platform chord through the registry seam", () => {
    let expected = "";
    function Probe() {
      const { bindings, host } = useKeybindings();
      expected = chordHintFor("compose-toggle", bindings, host.platform) ?? "";
      return null;
    }
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <Probe />
          <FocusSetter focus={FOCUS} />
          <ComposeStrip />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    expect(expected).not.toBe("");
    expect(addToastMock.mock.calls[0][0]).toBe(`Compose is on by default — ${expected} hides it`);
  });

  it("is silent once the sentinel exists", () => {
    localStorage.setItem("hexokit-compose-default-notice", "1");
    render(<Harness />);
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    expect(addToastMock).not.toHaveBeenCalled();
  });

  it("is silent for a stored preference, on or off", () => {
    localStorage.setItem("hexokit-compose-strip", "true");
    render(<Harness />);
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    expect(addToastMock).not.toHaveBeenCalled();
    expect(localStorage.getItem("hexokit-compose-default-notice")).toBeNull();
    cleanup();
    localStorage.setItem("hexokit-compose-strip", "false");
    render(<Harness />);
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    expect(addToastMock).not.toHaveBeenCalled();
  });

  it("is silent on the operator page's forced mount", () => {
    render(<Harness forceExpanded />);
    expect(addToastMock).not.toHaveBeenCalled();
    expect(localStorage.getItem("hexokit-compose-default-notice")).toBeNull();
  });

  it("StrictMode's effect replay shows it once", () => {
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    expect(addToastMock).toHaveBeenCalledTimes(1);
  });
});

describe("ComposeStrip Escape hand-off", () => {
  const FOCUS: FocusedTerminal = { wsRef: makeWs().ref, containerRef: { current: null }, server: "srv", session: "sess", windowId: "@1" };

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("Escape blurs the textarea, keeps the strip, and calls the mount's terminal focuser", () => {
    localStorage.setItem("hexokit-compose-strip", "true");
    const onEscapeToTerminal = vi.fn();
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FocusSetter focus={FOCUS} />
          <ComposeStrip onEscapeToTerminal={onEscapeToTerminal} />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    act(() => fireEvent.click(screen.getByTestId("set-focus")));
    act(() => input().focus());
    expect(document.activeElement).toBe(input());
    act(() => fireEvent.keyDown(input(), { key: "Escape" }));
    expect(document.activeElement).not.toBe(input());
    expect(onEscapeToTerminal).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("compose-strip-input")).toBeInTheDocument();
  });
});
