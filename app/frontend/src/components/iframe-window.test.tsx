import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, render, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { IframeWindow } from "./iframe-window";
import { TIP_OPEN_DELAY_MS } from "./tip";
import { StandaloneSessionContextProvider } from "@/contexts/session-context";

// Mock the API client. The engine mounted under `IframeWindow` probes
// external URLs through `checkFrame` (default embeddable so existing tests
// render the iframe) and the real `ApiError` class (the submit ladder's
// 400-fallback narrows with instanceof, so the class identity must be the
// real one); the URL bar's Enter-commit goes through the
// `onWriteUrl`/`onAddTab` props (per-test spies — the caller owns the POSTs).
vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ApiError: actual.ApiError,
    checkFrame: vi.fn().mockResolvedValue({ reachable: true, embeddable: true, status: 200, reason: "" }),
    listServers: vi.fn().mockResolvedValue([]),
  };
});

import { ApiError, checkFrame } from "@/api/client";

function iframeElement(
  props: React.ComponentProps<typeof IframeWindow>,
  server = "runkit",
) {
  // Bypass SSE by using StandaloneSessionContextProvider; only `currentServer`
  // matters — IframeWindow reads it directly from useSessionContext.
  return (
    <StandaloneSessionContextProvider
      value={{
        sessionsByServer: new Map([[server, []]]),
        sessionOrderByServer: new Map([[server, []]]),
        isConnectedByServer: new Map([[server, false]]),
        metricsByServer: new Map(),
        currentServer: server,
        servers: [{ name: server, sessionCount: 0 }],
        refreshServers: vi.fn(),
      }}
    >
      <IframeWindow {...props} />
    </StandaloneSessionContextProvider>
  );
}

const onWriteUrl = vi.fn().mockResolvedValue({ ok: true });

function renderIframe(
  props: Parameters<typeof iframeElement>[0],
  server = "runkit",
) {
  return render(iframeElement({ onWriteUrl, ...props }, server));
}

afterEach(cleanup);

describe("IframeWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders iframe with proxied URL", () => {
    renderIframe({
      tabs: ["http://localhost:8080/docs"],
    });

    const iframe = screen.getByTitle("Proxied content") as HTMLIFrameElement;
    expect(iframe).toBeTruthy();
    expect(iframe.src).toContain("/proxy/8080/docs");
  });

  it("rest shows the display form; focus reveals the raw value (260819-v6y4 R7)", () => {
    renderIframe({
      tabs: ["http://localhost:8080/docs"],
    });

    const input = screen.getByLabelText("URL") as HTMLInputElement;
    // At rest the proxied display form — the http://localhost plumbing hidden.
    expect(input.value).toBe("localhost:8080/docs");
    // Focus enters edit mode with the raw stored value.
    fireEvent.focus(input);
    expect(input.value).toBe("http://localhost:8080/docs");
    // Blur (unchanged) returns to the display form.
    fireEvent.blur(input);
    expect(input.value).toBe("localhost:8080/docs");
  });

  it("calls onWriteUrl on Enter with the normalized address", () => {
    renderIframe(
      {
        tabs: ["http://localhost:8080/docs"],
      },
      "server-B",
    );

    const input = screen.getByLabelText("URL") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "http://localhost:8080/api" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onWriteUrl).toHaveBeenCalledWith("http://localhost:8080/api");
  });

  it("renders refresh button", () => {
    renderIframe({
      tabs: ["http://localhost:8080/docs"],
    });

    const refreshBtn = screen.getByLabelText("Refresh");
    expect(refreshBtn).toBeTruthy();
  });

  it("passes through non-localhost URLs unchanged", () => {
    renderIframe({
      tabs: ["https://example.com/docs"],
    });

    const iframe = screen.getByTitle("Proxied content") as HTMLIFrameElement;
    expect(iframe.src).toContain("https://example.com/docs");
  });

  // The `>_` switch-to-terminal button is removed (260819-v6y4 R13): the
  // top-bar surface toggles own view switching, and its R7 zero-POST concern
  // is covered by the surface-toggle path web-view-lens.spec.ts asserts.
  it("no switch-to-terminal button renders in the URL bar", () => {
    renderIframe({
      tabs: ["http://localhost:8080/docs"],
    });
    expect(screen.queryByLabelText("Switch to terminal")).toBeNull();
  });

  // The keyboard-capture verb lives in the tile header (SurfaceLayout), not
  // the URL bar.
  it("renders no capture button in the URL bar", () => {
    renderIframe({ tabs: ["http://localhost:8080/docs"], webCapture: true });
    expect(screen.queryByTestId("web-capture-toggle")).toBeNull();
  });

  // Find bar (260819-ie2i R5/R7/R8): open seams, counter/navigation, the
  // cross-origin disabled state, and reset-on-load.
  describe("find bar", () => {
    const getIframe = () =>
      screen.getByTitle("Proxied content") as HTMLIFrameElement;

    /** Swap in a fresh same-origin frame document carrying `html` and fire
     *  `load` — the attach seam's re-attach path (jsdom's initial frame
     *  document is bare, so we shadow the whole contentDocument, the
     *  existing seam tests' pattern). */
    function seedFrameDocument(html: string) {
      const doc = document.implementation.createHTMLDocument();
      doc.body.innerHTML = html;
      Object.defineProperty(getIframe(), "contentDocument", {
        value: doc,
        configurable: true,
      });
      fireEvent.load(getIframe());
    }

    function openBarViaEvent() {
      // fireEvent (not a raw dispatchEvent) so the state update lands inside act().
      fireEvent(document, new CustomEvent("web-find:open"));
    }

    it("opens via the web-find:open CustomEvent with the input focused, and via the ⌕ button", () => {
      renderIframe({ tabs: ["http://localhost:8080/docs"] });
      expect(screen.queryByTestId("web-find-bar")).toBeNull();
      openBarViaEvent();
      const input = screen.getByLabelText("Find query") as HTMLInputElement;
      expect(input).toHaveFocus();
      fireEvent.click(screen.getByLabelText("Close find bar"));
      expect(screen.queryByTestId("web-find-bar")).toBeNull();
      fireEvent.click(screen.getByLabelText("Find in page"));
      expect(screen.getByTestId("web-find-bar")).toBeTruthy();
    });

    it("counts matches, Enter/Shift+Enter cycle with wrap, Escape closes", () => {
      renderIframe({ tabs: ["http://localhost:8080/docs"] });
      seedFrameDocument("<p>version one</p><p>the version floor</p><p>Version</p>");
      openBarViaEvent();
      const input = screen.getByLabelText("Find query");
      const counter = () => screen.getByLabelText("Match count").textContent;

      fireEvent.change(input, { target: { value: "version" } });
      expect(counter()).toBe("1/3");

      fireEvent.keyDown(input, { key: "Enter" });
      expect(counter()).toBe("2/3");
      fireEvent.keyDown(input, { key: "Enter" });
      expect(counter()).toBe("3/3");
      // Wraps forward past the last and backward before the first.
      fireEvent.keyDown(input, { key: "Enter" });
      expect(counter()).toBe("1/3");
      fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
      expect(counter()).toBe("3/3");

      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByTestId("web-find-bar")).toBeNull();
    });

    it("a query with no matches reads 0/0 and navigation is a no-op; clearing the query clears the count", () => {
      renderIframe({ tabs: ["http://localhost:8080/docs"] });
      seedFrameDocument("<p>nothing here</p>");
      openBarViaEvent();
      const input = screen.getByLabelText("Find query");
      const counter = () => screen.getByLabelText("Match count").textContent;

      fireEvent.change(input, { target: { value: "absent" } });
      expect(counter()).toBe("0/0");
      fireEvent.keyDown(input, { key: "Enter" });
      expect(counter()).toBe("0/0");
      fireEvent.change(input, { target: { value: "" } });
      expect(counter()).toBe("0/0");
    });

    it("a cross-origin frame renders the bar disabled with the hint (R7)", () => {
      renderIframe({ tabs: ["https://example.com/docs"] });
      const iframe = getIframe();
      // Simulate cross-origin: contentDocument/contentWindow access throws.
      Object.defineProperty(iframe, "contentDocument", {
        get() {
          throw new Error("cross-origin");
        },
        configurable: true,
      });
      Object.defineProperty(iframe, "contentWindow", {
        get() {
          throw new Error("cross-origin");
        },
        configurable: true,
      });
      fireEvent.load(iframe);

      fireEvent.click(screen.getByLabelText("Find in page"));
      expect(
        screen.getByText("page is cross-origin — find unavailable"),
      ).toBeTruthy();
      expect((screen.getByLabelText("Find query") as HTMLInputElement).disabled).toBe(true);
      expect((screen.getByLabelText("Next match") as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByLabelText("Previous match") as HTMLButtonElement).disabled).toBe(true);
      expect(screen.queryByLabelText("Match count")).toBeNull();
    });

    it("a frame navigation resets matches and the query (R8)", () => {
      renderIframe({ tabs: ["http://localhost:8080/docs"] });
      seedFrameDocument("<p>version one</p>");
      openBarViaEvent();
      const input = screen.getByLabelText("Find query") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "version" } });
      expect(screen.getByLabelText("Match count").textContent).toBe("1/1");

      // A navigation replaces the document — the seed helper IS that path.
      seedFrameDocument("<p>version version</p>");

      // The term does not persist across navigations (assumption 7).
      expect(input.value).toBe("");
      expect(screen.getByLabelText("Match count").textContent).toBe("0/0");
    });
  });

  // ── 260819-v6y4: browser chrome, display/edit address bar, error states ──

  describe("address bar display/edit split (R7) + submit normalization (R4)", () => {
    it("Enter normalizes bare loopback input and POSTs the proxy path", () => {
      renderIframe({ tabs: ["/proxy/8080/docs"] }, "server-B");
      const input = screen.getByLabelText("URL") as HTMLInputElement;
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "localhost:5173" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onWriteUrl).toHaveBeenCalledWith("/proxy/5173/");
    });

    it("Escape reverts the edit to the rest display form without a POST", () => {
      renderIframe({ tabs: ["/proxy/8080/docs"] });
      const input = screen.getByLabelText("URL") as HTMLInputElement;
      fireEvent.focus(input);
      expect(input.value).toBe("/proxy/8080/docs");
      fireEvent.change(input, { target: { value: "example.com" } });
      fireEvent.keyDown(input, { key: "Escape" });
      expect(onWriteUrl).not.toHaveBeenCalled();
      expect(input.value).toBe("localhost:8080/docs");
    });

    it("an invalid scheme surfaces inline feedback and fires NO POST", () => {
      renderIframe({ tabs: ["/proxy/8080/docs"] });
      const input = screen.getByLabelText("URL") as HTMLInputElement;
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "javascript:alert(1)" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onWriteUrl).not.toHaveBeenCalled();
      expect(screen.getByRole("alert").textContent).toContain("http");
      // The next keystroke clears the inline rejection.
      fireEvent.change(input, { target: { value: "javascript:alert(2)" } });
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("a repo-relative path submits through the add verb and selects the returned index — never a slot write", async () => {
      const onAddTab = vi.fn().mockResolvedValue({ index: 2, existed: false });
      const onSelectTab = vi.fn().mockResolvedValue({ ok: true });
      renderIframe({ tabs: ["/proxy/8080/docs"], onAddTab, onSelectTab });
      const input = screen.getByLabelText("URL") as HTMLInputElement;
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "docs/report.html" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(onSelectTab).toHaveBeenCalledWith(2));
      expect(onAddTab).toHaveBeenCalledWith("docs/report.html");
      expect(onWriteUrl).not.toHaveBeenCalled();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("a dotted single name that EXISTS lands as an add — the README.md fork's present arm", async () => {
      const onAddTab = vi.fn().mockResolvedValue({ index: 2, existed: false });
      const onSelectTab = vi.fn().mockResolvedValue({ ok: true });
      renderIframe({ tabs: ["/proxy/8080/docs"], onAddTab, onSelectTab });
      const input = screen.getByLabelText("URL") as HTMLInputElement;
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "README.md" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(onSelectTab).toHaveBeenCalledWith(2));
      expect(onAddTab).toHaveBeenCalledWith("README.md");
      expect(onWriteUrl).not.toHaveBeenCalled();
    });

    it("a dotted single name that does NOT exist (ApiError 400) falls back to the https:// slot write with no error", async () => {
      const onAddTab = vi
        .fn()
        .mockRejectedValue(new ApiError('target "example.com" does not exist', 400));
      renderIframe({ tabs: ["/proxy/8080/docs"], onAddTab });
      const input = screen.getByLabelText("URL") as HTMLInputElement;
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "example.com" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(onWriteUrl).toHaveBeenCalledWith("https://example.com"));
      expect(onAddTab).toHaveBeenCalledWith("example.com");
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("a path the backend cannot stat surfaces the 400 body inline — no fallback without one", async () => {
      const onAddTab = vi
        .fn()
        .mockRejectedValue(new ApiError('target "docs/nope.html" does not exist', 400));
      renderIframe({ tabs: ["/proxy/8080/docs"], onAddTab });
      const input = screen.getByLabelText("URL") as HTMLInputElement;
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "docs/nope.html" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toContain(
          'target "docs/nope.html" does not exist',
        ),
      );
      expect(onWriteUrl).not.toHaveBeenCalled();
    });

    it("blank Enter is a silent no-op — no POST, no inline error (today's behavior preserved)", () => {
      const onAddTab = vi.fn();
      renderIframe({ tabs: ["/proxy/8080/docs"], onAddTab });
      const input = screen.getByLabelText("URL") as HTMLInputElement;
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "   " } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onWriteUrl).not.toHaveBeenCalled();
      expect(onAddTab).not.toHaveBeenCalled();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("same-origin in-frame navigation tracks the display form only — the stored web tab option untouched", () => {
      renderIframe({ tabs: ["/proxy/8080/docs"] });
      const iframe = screen.getByTitle("Proxied content") as HTMLIFrameElement;
      const realWin = iframe.contentWindow!;
      Object.defineProperty(iframe, "contentWindow", {
        value: new Proxy(realWin, {
          get: (t, p) =>
            p === "location"
              ? { origin: window.location.origin, pathname: "/proxy/8080/next", search: "?x=1", hash: "" }
              : Reflect.get(t, p),
        }),
        configurable: true,
      });
      fireEvent.load(iframe);
      const input = screen.getByLabelText("URL") as HTMLInputElement;
      expect(input.value).toBe("localhost:8080/next?x=1");
      expect(onWriteUrl).not.toHaveBeenCalled();
    });
  });

  describe("back/forward + open-in-browser chrome (R5/R9)", () => {
    it("renders back/forward/refresh/find/open with their register data-icon SVGs on a same-origin tile", () => {
      renderIframe({ tabs: ["/proxy/8080/docs"] });
      // Glyph identity via the ControlGlyph data-icon seam (the pjqd
      // precedent) — the buttons render register SVGs, not unicode spans.
      const glyphs: Array<[string, string]> = [
        ["Back", "web-back"],
        ["Forward", "web-forward"],
        ["Refresh", "refresh"],
        ["Find in page", "find"],
        ["Open in browser", "open-external"],
      ];
      for (const [label, icon] of glyphs) {
        const button = screen.getByLabelText(label);
        expect(button.querySelector(`svg[data-icon="${icon}"]`)).toBeTruthy();
      }
    });

    it("hides back/forward on a cross-origin frame", () => {
      renderIframe({ tabs: ["https://example.com/docs"] });
      const iframe = screen.getByTitle("Proxied content") as HTMLIFrameElement;
      Object.defineProperty(iframe, "contentDocument", {
        get() {
          throw new Error("cross-origin");
        },
        configurable: true,
      });
      Object.defineProperty(iframe, "contentWindow", {
        get() {
          throw new Error("cross-origin");
        },
        configurable: true,
      });
      fireEvent.load(iframe);
      expect(screen.queryByLabelText("Back")).toBeNull();
      expect(screen.queryByLabelText("Forward")).toBeNull();
      // Reload and ↗ stay — the bounce fallback and the escape hatch.
      expect(screen.getByLabelText("Refresh")).toBeTruthy();
      expect(screen.getByLabelText("Open in browser")).toBeTruthy();
    });

    it("↗ opens the current address in a new tab without touching the stored web tab option", () => {
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      renderIframe({ tabs: ["/present/@320/file.html?server=runKit"] });
      fireEvent.click(screen.getByLabelText("Open in browser"));
      expect(open).toHaveBeenCalledWith("/present/@320/file.html?server=runKit", "_blank", "noopener");
      expect(onWriteUrl).not.toHaveBeenCalled();
      open.mockRestore();
    });

    it("the web-open-external CustomEvent opens the current address (palette seam)", () => {
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      renderIframe({ tabs: ["/proxy/8080/docs"] });
      fireEvent(document, new CustomEvent("web-open-external"));
      expect(open).toHaveBeenCalledWith("/proxy/8080/docs", "_blank", "noopener");
      open.mockRestore();
    });
  });

  describe("page meta + address focus seams (R10/R12)", () => {
    it("reports the same-origin document title on load; null cross-origin", () => {
      const onPageMeta = vi.fn();
      renderIframe({ tabs: ["/proxy/8080/docs"], onPageMeta });
      const iframe = screen.getByTitle("Proxied content") as HTMLIFrameElement;
      const doc = document.implementation.createHTMLDocument("tmux Version Floor");
      Object.defineProperty(iframe, "contentDocument", { value: doc, configurable: true });
      fireEvent.load(iframe);
      expect(onPageMeta).toHaveBeenLastCalledWith({ title: "tmux Version Floor" });

      Object.defineProperty(iframe, "contentDocument", {
        get() {
          throw new Error("cross-origin");
        },
        configurable: true,
      });
      Object.defineProperty(iframe, "contentWindow", {
        get() {
          throw new Error("cross-origin");
        },
        configurable: true,
      });
      fireEvent.load(iframe);
      expect(onPageMeta).toHaveBeenLastCalledWith({ title: null });
    });

    it("the web-address:focus CustomEvent focuses the input in edit mode, selected (⌘L)", () => {
      renderIframe({ tabs: ["/proxy/8080/docs"] });
      const input = screen.getByLabelText("URL") as HTMLInputElement;
      fireEvent(document, new CustomEvent("web-address:focus"));
      expect(input).toHaveFocus();
      expect(input.value).toBe("/proxy/8080/docs");
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe(input.value.length);
    });
  });

  describe("load progress line (R11)", () => {
    it("renders from mount/src-change until the frame's load event clears it", () => {
      renderIframe({ tabs: ["/proxy/8080/docs"] });
      // src is set at mount → loading until the first load event.
      expect(screen.getByTestId("web-load-progress")).toBeTruthy();
      fireEvent.load(screen.getByTitle("Proxied content"));
      expect(screen.queryByTestId("web-load-progress")).toBeNull();

      // An external src change re-arms it until the next load.
      const { rerender } = renderIframe({ tabs: ["/proxy/8080/docs"] });
      fireEvent.load(screen.getAllByTitle("Proxied content")[1]);
      expect(screen.queryAllByTestId("web-load-progress")).toHaveLength(0);
      rerender(iframeElement({ tabs: ["/proxy/9000/other"] }));
      expect(screen.getByTestId("web-load-progress")).toBeTruthy();
      // A replaced URL remounts its frame (identity is the URL) — re-query.
      fireEvent.load(screen.getAllByTitle("Proxied content")[1]);
      expect(screen.queryByTestId("web-load-progress")).toBeNull();
    });
  });

  // ── 260821-zqlq: the onboarding content state (empty/whitespace the stored web tab option) ──

  describe("onboarding state (260821-zqlq)", () => {
    it("renders the onboarding panel with heading, subhead, three rows, and footer — no iframe, no probes", () => {
      renderIframe({ tabs: [] });
      const box = screen.getByTestId("web-tile-onboarding");
      expect(box.textContent).toContain("Nothing to show yet");
      expect(box.textContent).toContain("this tile follows the window's active web tab (@rk_win_web_N)");
      expect(box.textContent).toContain("Ask your agent to show something.");
      expect(box.textContent).toContain("rk present ./report.html");
      expect(box.textContent).toContain("Preview a dev server.");
      expect(box.textContent).toContain("Open any URL.");
      expect(box.textContent).toContain("the tile goes live automatically when an address lands");
      expect(screen.queryByTitle("Proxied content")).toBeNull();
      // No frame-check / dead-port probing with no address.
      expect(checkFrame).not.toHaveBeenCalled();
      expect(screen.queryByTestId("web-tile-error")).toBeNull();
      expect(screen.queryByTestId("web-load-progress")).toBeNull();
    });

    it("renders the reduced URL bar — refresh + live address input with placeholder; back/forward/find/↗ hidden", () => {
      renderIframe({ tabs: [] });
      expect(screen.getByLabelText("Refresh")).toBeTruthy();
      const input = screen.getByLabelText("URL") as HTMLInputElement;
      expect(input.placeholder).toBe("localhost:3000 · /present/… · https://…");
      expect(screen.queryByLabelText("Back")).toBeNull();
      expect(screen.queryByLabelText("Forward")).toBeNull();
      expect(screen.queryByLabelText("Find in page")).toBeNull();
      expect(screen.queryByLabelText("Open in browser")).toBeNull();
      expect(screen.queryByTestId("web-find-bar")).toBeNull();
    });

    it("a whitespace-only tab address renders LIVE, not onboarding (onboarding keys on the empty family)", () => {
      renderIframe({ tabs: ["  \t "] });
      expect(screen.queryByTestId("web-tile-onboarding")).toBeNull();
      expect(screen.getByTitle("Proxied content")).toBeTruthy();
    });

    it("the address input is fully live — Enter submits through the existing pipeline and boots the tile", () => {
      renderIframe({ tabs: [] }, "server-B");
      const input = screen.getByLabelText("URL") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "localhost:3000" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onWriteUrl).toHaveBeenCalledWith("/proxy/3000/");
    });

    it("an invalid address surfaces the inline alert with NO POST", () => {
      renderIframe({ tabs: [] });
      const input = screen.getByLabelText("URL") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "javascript:alert(1)" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onWriteUrl).not.toHaveBeenCalled();
      expect(screen.getByRole("alert").textContent).toContain("http");
    });

    it("the web-find:open event no-ops on an onboarding tile (no bar, no throw)", () => {
      renderIframe({ tabs: [] });
      expect(() => fireEvent(document, new CustomEvent("web-find:open"))).not.toThrow();
      expect(screen.queryByTestId("web-find-bar")).toBeNull();
    });

    it("flips onboarding → live iframe when url becomes non-empty, and back on empty", () => {
      const { rerender } = renderIframe({ tabs: [] });
      expect(screen.getByTestId("web-tile-onboarding")).toBeTruthy();

      rerender(iframeElement({ tabs: ["/proxy/3000/"] }));
      expect(screen.queryByTestId("web-tile-onboarding")).toBeNull();
      const iframe = screen.getByTitle("Proxied content") as HTMLIFrameElement;
      expect(iframe.src).toContain("/proxy/3000/");
      // The full URL bar returns with the live tile.
      expect(screen.getByLabelText("Find in page")).toBeTruthy();
      expect(screen.getByLabelText("Open in browser")).toBeTruthy();

      rerender(iframeElement({ tabs: [] }));
      expect(screen.getByTestId("web-tile-onboarding")).toBeTruthy();
      expect(screen.queryByTitle("Proxied content")).toBeNull();
    });

    it("the attach seam survives a flip: interaction reports after the iframe mounts late", () => {
      const onInteract = vi.fn();
      const { rerender } = renderIframe({ tabs: [], onInteract });
      rerender(iframeElement({ tabs: ["/proxy/3000/"], onInteract }));
      const iframe = screen.getByTitle("Proxied content") as HTMLIFrameElement;
      // The mount-time attach races jsdom's async frame navigation; the
      // frame's load event re-attaches against the settled document (the same
      // re-attach every real navigation exercises).
      fireEvent.load(iframe);
      iframe.contentDocument!.dispatchEvent(new Event("pointerdown"));
      expect(onInteract).toHaveBeenCalledTimes(1);
    });
  });

  // ── the web tab strip: family props, N mounted frames, verbs, roving ────

  describe("web tab strip", () => {
    const TABS = ["/proxy/3001/", "/proxy/3002/", "https://docs.example.com/a/b"];

    it("strip renders at onboarding (0 tabs, no drafts): only `+`, no tabs, panel below", () => {
      renderIframe({ tabs: [], onAddTab: vi.fn() });
      const empty = screen.getByTestId("web-tab-strip");
      // The empty family keeps its draft entry point: `+` renders, no tab
      // (declared or draft) does, and the onboarding panel stays the content.
      expect(screen.getByTestId("web-tab-add")).toBeTruthy();
      expect(screen.queryAllByTestId("web-tab")).toHaveLength(0);
      expect(screen.queryAllByTestId("web-tab-draft")).toHaveLength(0);
      expect(screen.getByText("Nothing to show yet")).toBeTruthy();
      // The strip is the outer wrapper's FIRST child even at 0 tabs.
      expect(empty.parentElement!.firstElementChild).toBe(empty);
      cleanup();

      const one = renderIframe({ tabs: ["/proxy/3001/"] });
      const strip = screen.queryByTestId("web-tab-strip");
      expect(strip).toBeTruthy();
      // The strip is the outer wrapper's FIRST child at 1 tab now.
      expect(screen.getByTestId("web-zoom-frame-wrapper").parentElement!.firstElementChild).toBe(strip);
      one.unmount();
    });

    it("renders tablist semantics, fallback labels, display titles, and load spinners", () => {
      renderIframe({ tabs: TABS, active: 2 });
      const strip = screen.getByTestId("web-tab-strip");
      expect(strip.getAttribute("role")).toBe("tablist");
      // The strip sits ABOVE the URL-bar row.
      expect(screen.getByTestId("web-zoom-frame-wrapper").parentElement!.firstElementChild).toBe(strip);
      const tabs = screen.getAllByTestId("web-tab");
      expect(tabs).toHaveLength(3);
      expect(tabs.map((t) => t.getAttribute("data-index"))).toEqual(["1", "2", "3"]);
      expect(tabs.map((t) => t.getAttribute("role"))).toEqual(["tab", "tab", "tab"]);
      expect(tabs.filter((t) => t.getAttribute("aria-selected") === "true")).toEqual([tabs[1]]);
      expect(tabs[0].textContent).toContain("localhost:3001/");
      expect(tabs[2].textContent).toContain("docs.example.com");
      expect(tabs[0].getAttribute("title")).toBe("localhost:3001/");
      expect(tabs[2].getAttribute("title")).toBe("docs.example.com/a/b");
      // The classifyAddress kind dot occupies the icon slot once a frame's
      // document settles (spinner during load); proxy → yellow, external →
      // blue. Both tabs here show a spinner because the initial mount's
      // loading state is true until a `load` event clears it.
      expect(tabs[0].querySelector("[data-testid='web-tab-spinner']")).not.toBeNull();
      expect(tabs[2].querySelector("[data-testid='web-tab-spinner']")).not.toBeNull();
    });

    it("uses a same-origin page title and favicon, then falls back to the kind dot on icon failure", () => {
      renderIframe({ tabs: ["/proxy/3001/docs"], active: 1 });
      const iframe = screen.getByTitle("Proxied content");
      if (!(iframe instanceof HTMLIFrameElement)) throw new Error("expected iframe");
      const doc = iframe.contentDocument;
      if (!doc) throw new Error("expected frame document");
      const html = doc.documentElement ?? doc.appendChild(doc.createElement("html"));
      const head = doc.head ?? doc.createElement("head");
      if (!doc.head) html.prepend(head);
      doc.title = "Project docs";
      const icon = doc.createElement("link");
      icon.rel = "icon";
      icon.href = `${window.location.origin}/assets/project-icon.svg`;
      head.append(icon);
      const location = {
        href: `${window.location.origin}/proxy/3001/docs`,
        origin: window.location.origin,
        pathname: "/proxy/3001/docs",
        search: "",
        hash: "",
      };
      Object.defineProperty(iframe, "contentWindow", {
        value: { location },
        configurable: true,
      });

      fireEvent.load(iframe);
      const tab = screen.getByTestId("web-tab");
      expect(tab.textContent).toContain("Project docs");
      const favicon = tab.querySelector("img");
      expect(favicon?.getAttribute("src")).toBe(
        `${window.location.origin}/assets/project-icon.svg`,
      );

      if (!favicon) throw new Error("expected favicon");
      fireEvent.error(favicon);
      expect(tab.querySelector("img")).toBeNull();
      expect(tab.querySelector("[aria-hidden='true']")?.className).toContain(
        "bg-signal-yellow",
      );
    });

    it("clears a prior same-origin title and favicon after a cross-origin navigation", () => {
      renderIframe({ tabs: ["/proxy/3001/docs"], active: 1 });
      const iframe = screen.getByTitle("Proxied content");
      if (!(iframe instanceof HTMLIFrameElement)) throw new Error("expected iframe");
      const doc = iframe.contentDocument;
      if (!doc) throw new Error("expected frame document");
      const html = doc.documentElement ?? doc.appendChild(doc.createElement("html"));
      const head = doc.head ?? doc.createElement("head");
      if (!doc.head) html.prepend(head);
      doc.title = "Private project";
      const icon = doc.createElement("link");
      icon.rel = "icon";
      icon.href = `${window.location.origin}/assets/private.svg`;
      head.append(icon);
      Object.defineProperty(iframe, "contentWindow", {
        value: {
          location: {
            href: `${window.location.origin}/proxy/3001/docs`,
            origin: window.location.origin,
            pathname: "/proxy/3001/docs",
            search: "",
            hash: "",
          },
        },
        configurable: true,
      });

      fireEvent.load(iframe);
      const tab = screen.getByTestId("web-tab");
      expect(tab.textContent).toContain("Private project");
      expect(tab.querySelector("img")?.getAttribute("src")).toBe(
        `${window.location.origin}/assets/private.svg`,
      );

      Object.defineProperty(iframe, "contentDocument", {
        get() {
          throw new Error("cross-origin");
        },
        configurable: true,
      });
      Object.defineProperty(iframe, "contentWindow", {
        get() {
          throw new Error("cross-origin");
        },
        configurable: true,
      });
      fireEvent.load(iframe);

      expect(tab.textContent).toContain("localhost:3001/docs");
      expect(tab.textContent).not.toContain("Private project");
      expect(tab.querySelector("img")).toBeNull();
      expect(tab.querySelector("[aria-hidden='true']")?.className).toContain(
        "bg-signal-yellow",
      );
    });

    it("reports an already-loaded inactive tab's title when it becomes active", () => {
      const urls = ["/proxy/3001/", "/proxy/3002/"];
      const onPageMeta = vi.fn();
      const { rerender } = renderIframe({ tabs: urls, active: 1, onPageMeta });
      const frames = screen.getAllByTitle("Proxied content");

      frames.forEach((frame, index) => {
        if (!(frame instanceof HTMLIFrameElement)) throw new Error("expected iframe");
        const doc = frame.contentDocument;
        if (!doc) throw new Error("expected frame document");
        const html = doc.documentElement ?? doc.appendChild(doc.createElement("html"));
        const head = doc.head ?? doc.createElement("head");
        if (!doc.head) html.prepend(head);
        doc.title = index === 0 ? "First project" : "Second project";
        const icon = doc.createElement("link");
        icon.rel = "icon";
        icon.href = `${window.location.origin}/assets/project-${index + 1}.svg`;
        head.append(icon);
        Object.defineProperty(frame, "contentWindow", {
          value: {
            location: {
              href: `${window.location.origin}${urls[index]}`,
              origin: window.location.origin,
              pathname: urls[index],
              search: "",
              hash: "",
            },
          },
          configurable: true,
        });
        fireEvent.load(frame);
      });
      expect(onPageMeta).toHaveBeenLastCalledWith({ title: "First project" });

      onPageMeta.mockClear();
      rerender(iframeElement({ tabs: urls, active: 2, onPageMeta }));
      expect(onPageMeta).toHaveBeenCalledTimes(1);
      expect(onPageMeta).toHaveBeenLastCalledWith({ title: "Second project" });
    });

    it("the address bar and visible frame follow the active slot; an out-of-range active clamps, never onboarding", () => {
      renderIframe({ tabs: ["/proxy/3001/", "/proxy/3002/"], active: 2 });
      expect((screen.getByLabelText("URL") as HTMLInputElement).value).toBe("localhost:3002/");
      const frames = screen.getAllByTitle("Proxied content") as HTMLIFrameElement[];
      expect(frames[1].hasAttribute("hidden")).toBe(false);
      expect(frames[1].src).toContain("/proxy/3002/");
      cleanup();

      renderIframe({ tabs: ["/proxy/3001/", "/proxy/3002/"], active: 9 });
      expect((screen.getByLabelText("URL") as HTMLInputElement).value).toBe("localhost:3002/");
      expect(screen.queryByTestId("web-tile-onboarding")).toBeNull();
    });

    it("mounts one iframe per tab — selection flips `hidden` with stable src and element identity (P3)", () => {
      const { rerender } = renderIframe({ tabs: TABS, active: 1 });
      const frames = screen.getAllByTitle("Proxied content") as HTMLIFrameElement[];
      expect(frames).toHaveLength(3);
      expect(frames.map((f) => f.hasAttribute("hidden"))).toEqual([false, true, true]);
      const srcs = frames.map((f) => f.src);

      rerender(iframeElement({ tabs: TABS, active: 3 }));
      const after = screen.getAllByTitle("Proxied content") as HTMLIFrameElement[];
      expect(after.map((f) => f.hasAttribute("hidden"))).toEqual([true, true, false]);
      expect(after[0]).toBe(frames[0]);
      expect(after.map((f) => f.src)).toEqual(srcs);
    });

    it("clicking a tab selects it; × closes without selecting", () => {
      const onSelectTab = vi.fn().mockResolvedValue({ ok: true });
      const onCloseTab = vi.fn().mockResolvedValue({ ok: true });
      const onMoveTab = vi.fn().mockResolvedValue({ ok: true });
      renderIframe({ tabs: TABS, active: 1, onSelectTab, onCloseTab, onMoveTab });
      fireEvent.click(screen.getAllByTestId("web-tab")[2]);
      expect(onSelectTab).toHaveBeenCalledWith(3);
      onSelectTab.mockClear();

      const close = screen.getAllByTestId("web-tab-close")[1];
      const capture = vi.fn();
      Object.defineProperty(screen.getAllByTestId("web-tab")[1], "setPointerCapture", {
        value: capture,
        configurable: true,
      });
      fireEvent.pointerDown(close, { button: 0, pointerId: 4 });
      expect(capture).not.toHaveBeenCalled();
      fireEvent.click(close);
      expect(onCloseTab).toHaveBeenCalledWith(2);
      expect(onSelectTab).not.toHaveBeenCalled();
      expect(onMoveTab).not.toHaveBeenCalled();
    });

    it("draft tabs render after all real tabs, dashed; a draft Enter materializes the add and selects the resolved index", async () => {
      const onAddTab = vi.fn().mockResolvedValue({ index: 3, existed: false });
      const onSelectTab = vi.fn().mockResolvedValue({ ok: true });
      renderIframe({ tabs: ["/proxy/3001/", "/proxy/3002/"], active: 1, onAddTab, onSelectTab });
      const input = screen.getByLabelText("URL") as HTMLInputElement;

      // At rest no draft: open the `+` path, then type and Enter.
      fireEvent.click(screen.getByTestId("web-tab-add"));
      fireEvent.change(input, { target: { value: "localhost:3003" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(onSelectTab).toHaveBeenCalledWith(3));
      expect(onAddTab).toHaveBeenCalledWith("/proxy/3003/");
      expect(onAddTab.mock.invocationCallOrder[0]).toBeLessThan(
        onSelectTab.mock.invocationCallOrder[0],
      );
      expect(onWriteUrl).not.toHaveBeenCalled();
    });

    it("the `+` selects only the draft and focuses a blank address bar with draft guidance", async () => {
      renderIframe({ tabs: ["/proxy/3001/", "/proxy/3002/"], active: 1, onAddTab: vi.fn() });
      fireEvent.click(screen.getByTestId("web-tab-add"));

      const input = screen.getByLabelText("URL") as HTMLInputElement;
      await waitFor(() => expect(document.activeElement).toBe(input));
      expect(input.value).toBe("");
      expect(input.placeholder).toBe("type an address — Enter opens the tab, Esc discards");
      const selected = screen
        .getAllByRole("tab")
        .filter((tab) => tab.getAttribute("aria-selected") === "true");
      expect(selected).toEqual([screen.getByTestId("web-tab-draft")]);
    });

    it("a draft's own × discards it", () => {
      renderIframe({ tabs: ["/proxy/3001/", "/proxy/3002/"], active: 1, onAddTab: vi.fn() });
      fireEvent.click(screen.getByTestId("web-tab-add"));
      fireEvent.click(screen.getByTestId("web-tab-draft-close"));
      expect(screen.queryByTestId("web-tab-draft")).toBeNull();
    });

    it("a selected draft deactivates EVERY frame and shows the blank new-tab panel", () => {
      renderIframe({ tabs: ["/proxy/3001/", "/proxy/3002/"], active: 1, onAddTab: vi.fn() });
      const frames = screen.getAllByTitle("Proxied content") as HTMLIFrameElement[];
      expect(frames.map((f) => f.hasAttribute("hidden"))).toEqual([false, true]);
      expect(screen.queryByTestId("web-draft-panel")).toBeNull();

      fireEvent.click(screen.getByTestId("web-tab-add"));

      // No frame is active: both stay MOUNTED (P3), hidden.
      const during = screen.getAllByTitle("Proxied content") as HTMLIFrameElement[];
      expect(during.map((f) => f.hasAttribute("hidden"))).toEqual([true, true]);
      expect(screen.getByTestId("web-draft-panel")).toBeTruthy();
    });

    it("re-selecting a real tab re-activates the SAME frame node — no remount, no reload", () => {
      const onSelectTab = vi.fn().mockResolvedValue({ ok: true });
      renderIframe({ tabs: ["/proxy/3001/", "/proxy/3002/"], active: 1, onAddTab: vi.fn(), onSelectTab });
      const before = screen.getAllByTitle("Proxied content") as HTMLIFrameElement[];

      fireEvent.click(screen.getByTestId("web-tab-add"));
      expect(screen.getByTestId("web-draft-panel")).toBeTruthy();

      // The draft's address input holds focus; clicking a real tab deselects
      // the draft and the previously active frame re-activates in place.
      fireEvent.click(screen.getAllByTestId("web-tab")[0]);
      const after = screen.getAllByTitle("Proxied content") as HTMLIFrameElement[];
      expect(after[0]).toBe(before[0]);
      expect(after[1]).toBe(before[1]);
      expect(after.map((f) => f.hasAttribute("hidden"))).toEqual([false, true]);
      expect(screen.queryByTestId("web-draft-panel")).toBeNull();
      expect(onSelectTab).toHaveBeenCalledWith(1);
    });

    it("keyboard-selecting a tab (Enter) also deselects the draft and re-activates its frame", () => {
      const onSelectTab = vi.fn().mockResolvedValue({ ok: true });
      renderIframe({ tabs: ["/proxy/3001/", "/proxy/3002/"], active: 1, onAddTab: vi.fn(), onSelectTab });
      const before = screen.getAllByTitle("Proxied content") as HTMLIFrameElement[];
      fireEvent.click(screen.getByTestId("web-tab-add"));
      expect(screen.getByTestId("web-draft-panel")).toBeTruthy();

      const tab = screen.getAllByTestId("web-tab")[0];
      fireEvent.focus(tab);
      fireEvent.keyDown(tab, { key: "Enter" });
      const after = screen.getAllByTitle("Proxied content") as HTMLIFrameElement[];
      expect(after[0]).toBe(before[0]);
      expect(after[0].hasAttribute("hidden")).toBe(false);
      expect(screen.queryByTestId("web-draft-panel")).toBeNull();
      expect(onSelectTab).toHaveBeenCalledWith(1);
    });

    it("dragging a tab past a sibling commits one exact move", () => {
      const onMoveTab = vi.fn().mockResolvedValue({ ok: true });
      const onSelectTab = vi.fn().mockResolvedValue({ ok: true });
      renderIframe({ tabs: ["/proxy/3001/", "/proxy/3002/", "/proxy/3003/"], active: 1, onMoveTab, onSelectTab });
      const tabs = screen.getAllByTestId("web-tab");

      fireEvent.pointerDown(tabs[0], { button: 0, clientX: 0 });
      fireEvent.pointerMove(tabs[1], { clientX: 20 });
      fireEvent.pointerUp(tabs[1], { clientX: 20 });
      expect(onMoveTab).toHaveBeenCalledTimes(1);
      expect(onSelectTab).not.toHaveBeenCalled();
      expect(onMoveTab).toHaveBeenCalledWith(1, 2);
    });

    it("pointercancel and release outside clear drag state without a stale move", () => {
      const onMoveTab = vi.fn().mockResolvedValue({ ok: true });
      renderIframe({ tabs: ["/proxy/3001/", "/proxy/3002/"], active: 1, onMoveTab });
      const tabs = screen.getAllByTestId("web-tab");

      fireEvent.pointerDown(tabs[0], { button: 0, clientX: 0, pointerId: 7 });
      fireEvent.pointerMove(tabs[1], { clientX: 20, pointerId: 7 });
      expect(screen.getByTestId("web-tab-drop-indicator")).toBeTruthy();
      fireEvent.pointerCancel(window, { pointerId: 7 });
      expect(screen.queryByTestId("web-tab-drop-indicator")).toBeNull();
      expect(onMoveTab).not.toHaveBeenCalled();

      fireEvent.pointerDown(tabs[0], { button: 0, clientX: 0, pointerId: 8 });
      fireEvent.pointerMove(tabs[1], { clientX: 20, pointerId: 8 });
      fireEvent.pointerLeave(tabs[1], { pointerId: 8 });
      fireEvent.pointerUp(window, { pointerId: 8 });
      fireEvent.pointerUp(tabs[1], { pointerId: 8 });
      expect(screen.queryByTestId("web-tab-drop-indicator")).toBeNull();
      expect(onMoveTab).not.toHaveBeenCalled();
    });

    it("a sub-threshold drag stays a click (select)", () => {
      const onMoveTab = vi.fn().mockResolvedValue({ ok: true });
      const onSelectTab = vi.fn().mockResolvedValue({ ok: true });
      renderIframe({ tabs: ["/proxy/3001/", "/proxy/3002/"], active: 1, onMoveTab, onSelectTab });
      const tabs = screen.getAllByTestId("web-tab");

      fireEvent.pointerDown(tabs[0], { button: 0, clientX: 100 });
      fireEvent.pointerUp(tabs[0], { clientX: 102 }); // within the 6px threshold
      expect(onMoveTab).not.toHaveBeenCalled();
    });

    it("⌥⇧←/⌥⇧→ reorder the active tab; a boundary press is a silent no-op", () => {
      const onMoveTab = vi.fn().mockResolvedValue({ ok: true });
      renderIframe({ tabs: ["/proxy/3001/", "/proxy/3002/", "/proxy/3003/"], active: 1, onMoveTab });
      const tabs = screen.getAllByTestId("web-tab");

      fireEvent.focus(tabs[0]);
      fireEvent.keyDown(tabs[0], { key: "ArrowRight", altKey: true, shiftKey: true });
      expect(onMoveTab).toHaveBeenCalledWith(1, 2);
      onMoveTab.mockClear();

      // A boundary press (active at slot 1, pressing left) is a no-op.
      fireEvent.keyDown(tabs[0], { key: "ArrowLeft", altKey: true, shiftKey: true });
      expect(onMoveTab).not.toHaveBeenCalled();
    });

    it("middle-click on a tab closes it through onCloseTab", () => {
      const onCloseTab = vi.fn().mockResolvedValue({ ok: true });
      const onSelectTab = vi.fn().mockResolvedValue({ ok: true });
      renderIframe({ tabs: ["/proxy/3001/", "/proxy/3002/", "/proxy/3003/"], active: 1, onCloseTab, onSelectTab });
      const tabs = screen.getAllByTestId("web-tab");
      fireEvent(tabs[1], new MouseEvent("auxclick", { bubbles: true, button: 1 }));
      expect(onCloseTab).toHaveBeenCalledWith(2);
      expect(onSelectTab).not.toHaveBeenCalled();
    });

    it("double-click on empty strip space opens a draft (same path as `+`)", () => {
      renderIframe({ tabs: ["/proxy/3001/"], active: 1, onAddTab: vi.fn() });
      const strip = screen.getByTestId("web-tab-strip");
      fireEvent.doubleClick(strip);
      const drafts = screen.getAllByTestId("web-tab-draft");
      expect(drafts).toHaveLength(1);
      expect(drafts[0].textContent).toContain("new tab");
    });

    it("a draft renders dashed after the real tabs", () => {
      renderIframe({ tabs: ["/proxy/3001/", "/proxy/3002/"], active: 1, onAddTab: vi.fn() });
      fireEvent.click(screen.getByTestId("web-tab-add"));
      const drafts = screen.getAllByTestId("web-tab-draft");
      expect(drafts).toHaveLength(1);
      expect(drafts[0].textContent).toContain("new tab");
      // The draft renders after the real tabs in the strip.
      const strip = screen.getByTestId("web-tab-strip");
      const allTabs = strip.querySelectorAll('[data-testid="web-tab"], [data-testid="web-tab-draft"]');
      expect(allTabs[2].textContent).toContain("new tab");
      expect(drafts[0].className).toContain("border-dashed");
    });

    it("multiple concurrent drafts are allowed; each own × discards only itself", () => {
      renderIframe({ tabs: ["/proxy/3001/", "/proxy/3002/"], active: 1, onAddTab: vi.fn() });
      fireEvent.click(screen.getByTestId("web-tab-add"));
      fireEvent.click(screen.getByTestId("web-tab-add"));
      const drafts = screen.getAllByTestId("web-tab-draft");
      expect(drafts).toHaveLength(2);
      fireEvent.click(screen.getAllByTestId("web-tab-draft-close")[0]);
      expect(screen.getAllByTestId("web-tab-draft")).toHaveLength(1);
    });

    it("Escape discards a draft before POST and restores replace behavior", () => {
      const onAddTab = vi.fn();
      renderIframe({ tabs: ["/proxy/3001/", "/proxy/3002/"], active: 1, onAddTab });
      fireEvent.click(screen.getByTestId("web-tab-add"));
      const input = screen.getByLabelText("URL") as HTMLInputElement;
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByTestId("web-tab-draft")).toBeNull();
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "localhost:9009" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onWriteUrl).toHaveBeenCalledWith("/proxy/9009/");
      expect(onAddTab).not.toHaveBeenCalled();
    });

    it("Enter on the bar replaces the active slot and never adds; a same-URL submit is a no-op", () => {
      const onAddTab = vi.fn();
      renderIframe({ tabs: ["/proxy/3001/", "/proxy/3002/"], active: 2, onAddTab });
      const input = screen.getByLabelText("URL") as HTMLInputElement;
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "localhost:9000" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onWriteUrl).toHaveBeenCalledWith("/proxy/9000/");
      expect(onAddTab).not.toHaveBeenCalled();
      onWriteUrl.mockClear();

      // Re-focus reveals the raw active URL; Enter without an edit POSTs nothing.
      fireEvent.focus(input);
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onWriteUrl).not.toHaveBeenCalled();
    });

    it("roving tablist: arrows/Home/End move focus without writing; Enter selects; Delete closes", () => {
      const onSelectTab = vi.fn().mockResolvedValue({ ok: true });
      const onCloseTab = vi.fn().mockResolvedValue({ ok: true });
      renderIframe({ tabs: TABS, active: 1, onSelectTab, onCloseTab });
      const tabs = screen.getAllByTestId("web-tab") as HTMLElement[];
      // Only the ACTIVE tab is in the tab order.
      expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);

      fireEvent.focus(tabs[0]);
      fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
      expect(document.activeElement).toBe(tabs[1]);
      expect(onSelectTab).not.toHaveBeenCalled();
      fireEvent.keyDown(tabs[1], { key: "End" });
      expect(document.activeElement).toBe(tabs[2]);
      fireEvent.keyDown(tabs[2], { key: "Home" });
      expect(document.activeElement).toBe(tabs[0]);
      fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
      expect(document.activeElement).toBe(tabs[0]); // clamped at the edge

      fireEvent.keyDown(tabs[0], { key: "Enter" });
      expect(onSelectTab).toHaveBeenCalledWith(1);
      fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
      fireEvent.keyDown(tabs[1], { key: "Delete" });
      expect(onCloseTab).toHaveBeenCalledWith(2);
      expect(onSelectTab).toHaveBeenCalledTimes(1);
    });

    it("+ is enabled below the 16-tab family cap (15 tabs)", () => {
      const tabs = Array.from({ length: 15 }, (_, i) => `/proxy/${3000 + i}/`);
      renderIframe({ tabs, active: 1, onAddTab: vi.fn() });
      expect((screen.getByTestId("web-tab-add") as HTMLButtonElement).disabled).toBe(false);
    });

    it("+ is disabled at the 16-tab family cap, tipped `web tabs full (16)`", () => {
      vi.useFakeTimers();
      try {
        const tabs = Array.from({ length: 16 }, (_, i) => `/proxy/${3000 + i}/`);
        renderIframe({ tabs, active: 1, onAddTab: vi.fn() });
        const add = screen.getByTestId("web-tab-add") as HTMLButtonElement;
        expect(add.disabled).toBe(true);
        act(() => {
          fireEvent.mouseEnter(add);
          vi.advanceTimersByTime(TIP_OPEN_DELAY_MS);
        });
        expect(screen.getByRole("tooltip")).toHaveTextContent("web tabs full (16)");
      } finally {
        vi.useRealTimers();
      }
    });

    it("an onAddTab rejection surfaces the server error text in the inline alert slot", async () => {
      const onAddTab = vi.fn().mockRejectedValue(new Error("web tabs full (16)"));
      renderIframe({ tabs: ["/proxy/3001/", "/proxy/3002/"], active: 1, onAddTab });
      const input = screen.getByLabelText("URL") as HTMLInputElement;
      fireEvent.click(screen.getByTestId("web-tab-add"));
      fireEvent.change(input, { target: { value: "localhost:3003" } });
      fireEvent.keyDown(input, { key: "Enter" });
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe("web tabs full (16)");
      expect(screen.getByTestId("web-tab-draft")).toBeTruthy();
    });

    it("registers exactly one web-find:open listener for the whole tile, opening the bar against the active frame", () => {
      const addSpy = vi.spyOn(document, "addEventListener");
      try {
        renderIframe({ tabs: TABS, active: 1 });
        expect(
          addSpy.mock.calls.filter(([type]) => type === "web-find:open"),
        ).toHaveLength(1);
      } finally {
        addSpy.mockRestore();
      }
      fireEvent(document, new CustomEvent("web-find:open"));
      expect(screen.getByTestId("web-find-bar")).toBeTruthy();
    });

    it("chrome binds to the ACTIVE frame: switching cross-origin → same-origin shows back/forward", () => {
      const urls = ["https://example.com/docs", "/proxy/3001/"];
      const { rerender } = renderIframe({ tabs: urls, active: 1 });
      const frames = screen.getAllByTitle("Proxied content") as HTMLIFrameElement[];
      // Tab 1 is cross-origin: contentDocument/contentWindow access throws.
      Object.defineProperty(frames[0], "contentDocument", {
        get() {
          throw new Error("cross-origin");
        },
        configurable: true,
      });
      Object.defineProperty(frames[0], "contentWindow", {
        get() {
          throw new Error("cross-origin");
        },
        configurable: true,
      });
      fireEvent.load(frames[0]);
      expect(screen.queryByLabelText("Back")).toBeNull();

      // Tab 2 is same-origin (jsdom's default frame document).
      fireEvent.load(frames[1]);
      rerender(iframeElement({ tabs: urls, active: 2 }));
      expect(screen.getByLabelText("Back")).toBeTruthy();
      expect(screen.getByLabelText("Forward")).toBeTruthy();
    });
  });
});

describe("IframeWindow content zoom (260823-cwvv R2–R5, R8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  const zoomControl = () => screen.getByTestId("web-zoom-control");
  const readout = () => screen.getByLabelText("Reset zoom");

  it("renders the zoom control at 100% with no transform on the frame", () => {
    renderIframe({ tabs: ["/proxy/3000/"] });
    expect(readout().textContent).toBe("100%");
    const iframe = screen.getByTitle("Proxied content") as HTMLIFrameElement;
    expect(iframe.style.transform).toBe("");
    expect(iframe.style.width).toBe("100%");
  });

  it("the onboarding state renders NO zoom control", () => {
    renderIframe({ tabs: [] });
    expect(screen.queryByTestId("web-zoom-control")).toBeNull();
  });

  it("+ steps the readout 100 → 110 → 125 and scales the frame", () => {
    renderIframe({ tabs: ["/proxy/3000/"] });
    fireEvent.click(screen.getByLabelText("Zoom in"));
    expect(readout().textContent).toBe("110%");
    fireEvent.click(screen.getByLabelText("Zoom in"));
    expect(readout().textContent).toBe("125%");
    const iframe = screen.getByTitle("Proxied content") as HTMLIFrameElement;
    expect(iframe.style.transform).toBe("scale(1.25)");
    expect(iframe.style.width).toBe(`${100 / 1.25}%`);
    expect(iframe.style.height).toBe(`${100 / 1.25}%`);
  });

  it("− steps down and reset returns to 100%", () => {
    renderIframe({ tabs: ["/proxy/3000/"] });
    fireEvent.click(screen.getByLabelText("Zoom out"));
    expect(readout().textContent).toBe("90%");
    fireEvent.click(readout());
    expect(readout().textContent).toBe("100%");
    const iframe = screen.getByTitle("Proxied content") as HTMLIFrameElement;
    expect(iframe.style.transform).toBe("");
  });

  it("persists per bucket and re-seeds from storage", () => {
    const first = renderIframe({ tabs: ["/proxy/3000/"] });
    fireEvent.click(screen.getByLabelText("Zoom in"));
    fireEvent.click(screen.getByLabelText("Zoom in"));
    expect(localStorage.getItem("hexokit-web-zoom")).toBe('{"proxy:3000":1.25}');
    first.unmount();
    renderIframe({ tabs: ["http://localhost:3000/app"] });
    expect(readout().textContent).toBe("125%");
    // A different bucket (another port) starts at 100%.
    cleanup();
    renderIframe({ tabs: ["/proxy/4000/"] });
    expect(readout().textContent).toBe("100%");
  });

  it("re-seeds when the bucket changes on the same mounted tile", () => {
    const { rerender } = renderIframe({ tabs: ["/proxy/3000/"] });
    fireEvent.click(screen.getByLabelText("Zoom in"));
    expect(readout().textContent).toBe("110%");
    rerender(iframeElement({ tabs: ["/proxy/4000/"] }));
    expect(readout().textContent).toBe("100%");
    rerender(iframeElement({ tabs: ["/proxy/3000/"] }));
    expect(readout().textContent).toBe("110%");
  });

  it("reset at 100% writes nothing; returning to 100% removes the entry", () => {
    renderIframe({ tabs: ["/proxy/3000/"] });
    expect(localStorage.getItem("hexokit-web-zoom")).toBeNull();
    fireEvent.click(screen.getByLabelText("Zoom in"));
    expect(localStorage.getItem("hexokit-web-zoom")).toBe('{"proxy:3000":1.1}');
    fireEvent.click(readout());
    expect(localStorage.getItem("hexokit-web-zoom")).toBe("{}");
  });

  it("the web-zoom document event steps and resets the tile", () => {
    renderIframe({ tabs: ["/proxy/3000/"] });
    fireEvent(document, new CustomEvent("web-zoom", { detail: { direction: "in" } }));
    expect(readout().textContent).toBe("110%");
    fireEvent(document, new CustomEvent("web-zoom", { detail: { direction: "out" } }));
    expect(readout().textContent).toBe("100%");
    fireEvent(document, new CustomEvent("web-zoom", { detail: { direction: "reset" } }));
    expect(readout().textContent).toBe("100%");
  });

  it("the web-zoom event no-ops on an onboarding tile", () => {
    renderIframe({ tabs: [] });
    expect(() =>
      fireEvent(document, new CustomEvent("web-zoom", { detail: { direction: "in" } })),
    ).not.toThrow();
    expect(localStorage.getItem("hexokit-web-zoom")).toBeNull();
  });

  it("ctrl-wheel on the wrapper zooms CONTINUOUSLY and is prevented; plain wheel passes through (260824-iafo R3)", () => {
    renderIframe({ tabs: ["/proxy/3000/"] });
    const wrapper = screen.getByTestId("web-zoom-frame-wrapper").parentElement as HTMLElement;
    const ctrlWheel = new WheelEvent("wheel", { deltaY: -60, ctrlKey: true, bubbles: true, cancelable: true });
    const preventSpy = vi.spyOn(ctrlWheel, "preventDefault");
    fireEvent(wrapper, ctrlWheel);
    expect(preventSpy).toHaveBeenCalled();
    // Continuous exponential mapping: 1 * exp(0.6) ≈ 1.822 — an off-ladder value.
    expect(readout().textContent).toBe("182%");
    // Unmodified wheel: no zoom change, no preventDefault.
    const plainWheel = new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true });
    const plainSpy = vi.spyOn(plainWheel, "preventDefault");
    fireEvent(wrapper, plainWheel);
    expect(plainSpy).not.toHaveBeenCalled();
    expect(readout().textContent).toBe("182%");
  });

  it("ctrl-wheel inside the same-origin frame document zooms continuously per event", () => {
    renderIframe({ tabs: ["/proxy/3000/"] });
    const iframe = screen.getByTitle("Proxied content") as HTMLIFrameElement;
    fireEvent.load(iframe);
    const doc = iframe.contentDocument!;
    fireEvent(doc, new WheelEvent("wheel", { deltaY: -60, ctrlKey: true, bubbles: true, cancelable: true }));
    expect(readout().textContent).toBe("182%");
    // Every event compounds — no threshold, no ladder click.
    fireEvent(doc, new WheelEvent("wheel", { deltaY: -10, ctrlKey: true, bubbles: true, cancelable: true }));
    expect(readout().textContent).toBe("201%");
  });

  it("Safari gesturechange scales from the gesturestart base (260824-iafo R3)", () => {
    renderIframe({ tabs: ["/proxy/3000/"] });
    const wrapper = screen.getByTestId("web-zoom-frame-wrapper").parentElement as HTMLElement;
    const gesture = (type: string, scale?: number) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      if (scale !== undefined) Object.assign(e, { scale });
      fireEvent(wrapper, e);
    };
    gesture("gesturestart");
    gesture("gesturechange", 1.5);
    expect(readout().textContent).toBe("150%");
    // Scale is cumulative from gesturestart — base stays the pinch-start value.
    gesture("gesturechange", 2.2);
    expect(readout().textContent).toBe("220%");
    // A new pinch re-bases at the current zoom: 2.2 * 0.5 = 1.1.
    gesture("gesturestart");
    gesture("gesturechange", 0.5);
    expect(readout().textContent).toBe("110%");
  });

  it("a bucket change flushes the pending gesture write to the OLD bucket (260824-iafo R4)", () => {
    vi.useFakeTimers();
    try {
      const view = renderIframe({ tabs: ["/proxy/3000/"] });
      const wrapper = screen.getByTestId("web-zoom-frame-wrapper").parentElement as HTMLElement;
      fireEvent(
        wrapper,
        new WheelEvent("wheel", { deltaY: -60, ctrlKey: true, bubbles: true, cancelable: true }),
      );
      expect(localStorage.getItem("hexokit-web-zoom")).toBeNull();
      // The address moves to a different bucket while the write is pending —
      // the flush belongs to the OLD bucket, and the new bucket seeds fresh.
      view.rerender(iframeElement({ tabs: ["/proxy/4000/"] }, "runkit"));
      expect(JSON.parse(localStorage.getItem("hexokit-web-zoom")!)).toEqual({ "proxy:3000": 1.82 });
      expect(readout().textContent).toBe("100%");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gesture persistence is debounced-trailing and flushes on unmount (260824-iafo R4)", () => {
    vi.useFakeTimers();
    try {
      const view = renderIframe({ tabs: ["/proxy/3000/"] });
      const wrapper = screen.getByTestId("web-zoom-frame-wrapper").parentElement as HTMLElement;
      const wheel = () =>
        fireEvent(
          wrapper,
          new WheelEvent("wheel", { deltaY: -30, ctrlKey: true, bubbles: true, cancelable: true }),
        );
      wheel();
      wheel();
      // Mid-gesture: nothing persisted yet.
      expect(localStorage.getItem("hexokit-web-zoom")).toBeNull();
      vi.advanceTimersByTime(300);
      // One trailing write with the final compounded value: exp(0.6) ≈ 1.82.
      expect(JSON.parse(localStorage.getItem("hexokit-web-zoom")!)).toEqual({ "proxy:3000": 1.82 });
      // A pending write flushes (not drops) on unmount.
      wheel();
      view.unmount();
      expect(JSON.parse(localStorage.getItem("hexokit-web-zoom")!)).toEqual({ "proxy:3000": 2.46 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a + click from a gesture-set float snaps to the ladder and steps (260824-iafo R3)", () => {
    renderIframe({ tabs: ["/proxy/3000/"] });
    const wrapper = screen.getByTestId("web-zoom-frame-wrapper").parentElement as HTMLElement;
    fireEvent(
      wrapper,
      new WheelEvent("wheel", { deltaY: -60, ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(readout().textContent).toBe("182%");
    // 1.822 snaps to 1.75 (nearest), then steps in → 2.
    fireEvent.click(screen.getByLabelText("Zoom in"));
    expect(readout().textContent).toBe("200%");
  });
});
