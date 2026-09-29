import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { CodeSurface, codeServerSrc, codeServerWorkspaceSrc } from "./code-surface";
import { CODE_BOOT_RESCUE_RECHECK_MS, CODE_BOOT_RESCUE_WAIT_MS } from "@/lib/code-boot-rescue";
import type { CodeBridgeResult } from "@/api/client";

afterEach(cleanup);

describe("codeServerSrc", () => {
  it("builds the stable relative /code/?folder=<root> URL (260811-a2bo)", () => {
    expect(codeServerSrc("/home/user/repo")).toBe(
      "/code/?folder=%2Fhome%2Fuser%2Frepo",
    );
  });

  it("never composes an absolute origin and never carries the port", () => {
    expect(codeServerSrc("/repo").startsWith("/code/")).toBe(true);
    expect(codeServerSrc("/repo")).not.toMatch(/^https?:/);
    expect(codeServerSrc("/repo")).not.toMatch(/\d{2,5}/);
  });
});

describe("codeServerWorkspaceSrc", () => {
  it("builds the stable relative /code/?workspace=<path> URL", () => {
    const path = "/home/u/.local/state/hexokit/code/default/@7-3fa1c9.code-workspace";
    expect(codeServerWorkspaceSrc(path)).toBe(`/code/?workspace=${encodeURIComponent(path)}`);
  });

  it("never composes an absolute origin and never carries a port", () => {
    // The path itself carries digits (@7, the hash), so the port check is
    // structural: no scheme, no `//` authority, and the pathname is exactly
    // /code/ — a port could only live in an authority component.
    const src = codeServerWorkspaceSrc("/state/code/default/@7-3fa1c9.code-workspace");
    expect(src.startsWith("/code/")).toBe(true);
    expect(src).not.toMatch(/^https?:/);
    expect(src).not.toContain("//");
    expect(src.split("?")[0]).toBe("/code/");
  });

  it("differs per workspace path", () => {
    expect(codeServerWorkspaceSrc("/state/@7-aaaaaa.code-workspace")).not.toBe(
      codeServerWorkspaceSrc("/state/@7-bbbbbb.code-workspace"),
    );
  });
});

describe("CodeSurface", () => {
  /** Stub the frame's contentWindow with a reload spy — jsdom never
   *  navigates an iframe, so the reload target is injected (the same
   *  configurable-property pattern as the folder seam's stub). */
  const stubReload = (el: HTMLElement) => {
    const reload = vi.fn();
    Object.defineProperty(el, "contentWindow", {
      configurable: true,
      value: { location: { reload, search: "?workspace=x" } },
    });
    return reload;
  };

  it("renders the iframe at the workspace src when reachable and resolved", () => {
    const { getByTitle } = render(
      <CodeSurface gitRoot="/repo" workspaceSrc={codeServerSrc("/repo")} reachable={true} />,
    );
    const iframe = getByTitle("Code editor");
    // jsdom resolves the relative src against the document base — assert the
    // path+query shape, which is what the component controls.
    expect(iframe.getAttribute("src")).toBe("/code/?folder=%2Frepo");
  });

  it("carries allow-downloads in the sandbox (VS Code file downloads)", () => {
    const { getByTitle } = render(
      <CodeSurface gitRoot="/repo" workspaceSrc={codeServerSrc("/repo")} reachable={true} />,
    );
    expect(getByTitle("Code editor").getAttribute("sandbox")).toContain("allow-downloads");
  });

  it("renders the not-running empty state (no iframe) when unreachable", () => {
    const { getByTestId, queryByTitle } = render(
      <CodeSurface gitRoot="/repo" workspaceSrc={codeServerSrc("/repo")} reachable={false} />,
    );
    expect(getByTestId("code-surface-empty")).toHaveTextContent(
      "code-server not running — check rk doctor",
    );
    expect(queryByTitle("Code editor")).toBeNull();
  });

  it("the not-running state's Restart button calls onRestart and surfaces a failure", async () => {
    const onRestart = vi.fn().mockRejectedValue(new Error("code-server did not come up"));
    const { getByRole, findByTestId } = render(
      <CodeSurface gitRoot="/repo" workspaceSrc={null} reachable={false} onRestart={onRestart} />,
    );
    fireEvent.click(getByRole("button", { name: "Restart code-server" }));
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(await findByTestId("code-surface-restart-note")).toHaveTextContent(
      "code-server did not come up",
    );
    expect(getByRole("button", { name: "Restart code-server" })).not.toBeDisabled();
  });

  it("renders the pending state (no iframe) while the workspace src is unresolved", () => {
    const { getByTestId, queryByTitle } = render(
      <CodeSurface gitRoot="/repo" workspaceSrc={null} reachable={true} />,
    );
    expect(getByTestId("code-surface-pending")).toHaveTextContent("opening…");
    expect(queryByTitle("Code editor")).toBeNull();
  });

  it("keeps precedence: unreachable renders the empty state, never pending", () => {
    const { getByTestId, queryByTestId } = render(
      <CodeSurface gitRoot="/repo" workspaceSrc={null} reachable={false} />,
    );
    expect(getByTestId("code-surface-empty")).toBeTruthy();
    expect(queryByTestId("code-surface-pending")).toBeNull();
  });

  it("mounts the iframe once the workspace src resolves (pending → resolved)", () => {
    const wsSrc = codeServerWorkspaceSrc("/state/code/default/@7-3fa1c9.code-workspace");
    const { rerender, getByTestId, getByTitle, queryByTestId } = render(
      <CodeSurface gitRoot="/repo" workspaceSrc={null} reachable={true} />,
    );
    expect(getByTestId("code-surface-pending")).toBeTruthy();
    rerender(<CodeSurface gitRoot="/repo" workspaceSrc={wsSrc} reachable={true} />);
    expect(queryByTestId("code-surface-pending")).toBeNull();
    expect(getByTitle("Code editor").getAttribute("src")).toBe(wsSrc);
  });

  // Latched folder (260813-if5d R3): the `src` is per iframe MOUNT GENERATION.
  // A src change on a LIVE frame must not touch the attribute — re-setting
  // `src` re-navigates the frame and takes the editor state with it (P3).
  it("never changes a mounted iframe's src when the workspace src prop changes", () => {
    const { rerender, getByTitle } = render(
      <CodeSurface gitRoot="/repo" workspaceSrc={codeServerSrc("/repo")} reachable={true} />,
    );
    const iframe = getByTitle("Code editor");
    expect(iframe.getAttribute("src")).toBe("/code/?folder=%2Frepo");
    rerender(
      <CodeSurface
        gitRoot="/other"
        workspaceSrc={codeServerWorkspaceSrc("/state/@7-bbbbbb.code-workspace")}
        reachable={true}
      />,
    );
    expect(getByTitle("Code editor").getAttribute("src")).toBe("/code/?folder=%2Frepo");
  });

  it("picks up the current src when the iframe genuinely remounts (reachability flip)", () => {
    const { rerender, getByTitle } = render(
      <CodeSurface gitRoot="/repo" workspaceSrc={codeServerSrc("/repo")} reachable={true} />,
    );
    const otherSrc = codeServerWorkspaceSrc("/state/@7-bbbbbb.code-workspace");
    rerender(<CodeSurface gitRoot="/other" workspaceSrc={otherSrc} reachable={false} />);
    rerender(<CodeSurface gitRoot="/other" workspaceSrc={otherSrc} reachable={true} />);
    // A fresh workbench boots at where the editor last was, not the seed.
    expect(getByTitle("Code editor").getAttribute("src")).toBe(otherSrc);
  });

  // The follow rule's re-navigation gate: a fresh follow nonce lands the frame
  // on the re-derived workspace URL (the editor already navigated itself);
  // anything else — a repeated nonce, an ordinary payload tick — never
  // re-navigates a live frame.
  describe("followSrc (the one sanctioned parent re-navigation)", () => {
    it("a fresh follow nonce re-navigates the live frame to the new workspace URL", () => {
      const first = codeServerWorkspaceSrc("/state/@7-aaaaaa.code-workspace");
      const second = codeServerWorkspaceSrc("/state/@7-bbbbbb.code-workspace");
      const { rerender, getByTitle } = render(
        <CodeSurface gitRoot="/repo" workspaceSrc={first} reachable={true} />,
      );
      expect(getByTitle("Code editor").getAttribute("src")).toBe(first);
      rerender(
        <CodeSurface
          gitRoot="/other"
          workspaceSrc={first}
          followSrc={{ src: second, nonce: 1 }}
          reachable={true}
        />,
      );
      expect(getByTitle("Code editor").getAttribute("src")).toBe(second);
    });

    it("an already-seen nonce never re-navigates the frame again", () => {
      const first = codeServerWorkspaceSrc("/state/@7-aaaaaa.code-workspace");
      const second = codeServerWorkspaceSrc("/state/@7-bbbbbb.code-workspace");
      const { rerender, getByTitle } = render(
        <CodeSurface gitRoot="/repo" workspaceSrc={first} reachable={true} />,
      );
      rerender(
        <CodeSurface
          gitRoot="/other"
          workspaceSrc={first}
          followSrc={{ src: second, nonce: 1 }}
          reachable={true}
        />,
      );
      expect(getByTitle("Code editor").getAttribute("src")).toBe(second);
      // The follow prop lingers across ordinary payload ticks — its nonce is
      // spent, so the frame stays put even as the mount src prop moves on.
      rerender(
        <CodeSurface
          gitRoot="/other"
          workspaceSrc={second}
          followSrc={{ src: second, nonce: 1 }}
          reachable={true}
        />,
      );
      expect(getByTitle("Code editor").getAttribute("src")).toBe(second);
    });
  });

  // Follow rule (if5d R3): the load seam reports where the EDITOR navigated
  // itself (File > Open Folder → /code/?folder=<new>), which the parent latches.
  describe("onFolderNavigated (follow-the-editor seam)", () => {
    /** Stub the frame's location — jsdom never navigates an iframe, so the
     *  post-navigation state is injected. `configurable` lets each test replace
     *  it (contentWindow is a prototype getter). */
    const stubFrameSearch = (el: HTMLElement, search: string) => {
      Object.defineProperty(el, "contentWindow", {
        configurable: true,
        value: { location: { search } },
      });
    };
    const WS_SRC = codeServerWorkspaceSrc("/state/@7-3fa1c9.code-workspace");

    it("reports a different folder from the frame's ?folder= on load (decoded)", () => {
      const onFolderNavigated = vi.fn();
      const { getByTitle } = render(
        <CodeSurface gitRoot="/repo" workspaceSrc={WS_SRC} reachable={true} onFolderNavigated={onFolderNavigated} />,
      );
      const iframe = getByTitle("Code editor");
      stubFrameSearch(iframe, "?folder=%2Fhome%2Fuser%2Fother");
      fireEvent.load(iframe);
      expect(onFolderNavigated).toHaveBeenCalledWith("/home/user/other");
    });

    it("stays silent when the frame is already at the current folder", () => {
      const onFolderNavigated = vi.fn();
      const { getByTitle } = render(
        <CodeSurface gitRoot="/repo" workspaceSrc={WS_SRC} reachable={true} onFolderNavigated={onFolderNavigated} />,
      );
      const iframe = getByTitle("Code editor");
      stubFrameSearch(iframe, "?folder=%2Frepo");
      fireEvent.load(iframe);
      expect(onFolderNavigated).not.toHaveBeenCalled();
    });

    it("stays silent when the frame carries no folder param", () => {
      const onFolderNavigated = vi.fn();
      const { getByTitle } = render(
        <CodeSurface gitRoot="/repo" workspaceSrc={WS_SRC} reachable={true} onFolderNavigated={onFolderNavigated} />,
      );
      const iframe = getByTitle("Code editor");
      stubFrameSearch(iframe, "?other=1");
      fireEvent.load(iframe);
      expect(onFolderNavigated).not.toHaveBeenCalled();
    });

    it("stays silent for a frame at ?workspace= (no folder param to follow)", () => {
      const onFolderNavigated = vi.fn();
      const { getByTitle } = render(
        <CodeSurface gitRoot="/repo" workspaceSrc={WS_SRC} reachable={true} onFolderNavigated={onFolderNavigated} />,
      );
      const iframe = getByTitle("Code editor");
      stubFrameSearch(iframe, "?workspace=%2Fstate%2F%407-3fa1c9.code-workspace");
      fireEvent.load(iframe);
      expect(onFolderNavigated).not.toHaveBeenCalled();
    });

    it("skips a cross-origin frame silently (no throw, no report)", () => {
      const onFolderNavigated = vi.fn();
      const { getByTitle } = render(
        <CodeSurface gitRoot="/repo" workspaceSrc={WS_SRC} reachable={true} onFolderNavigated={onFolderNavigated} />,
      );
      const iframe = getByTitle("Code editor");
      Object.defineProperty(iframe, "contentWindow", {
        configurable: true,
        get() {
          throw new Error("SecurityError: cross-origin");
        },
      });
      expect(() => fireEvent.load(iframe)).not.toThrow();
      expect(onFolderNavigated).not.toHaveBeenCalled();
    });

    it("does not re-navigate the mounted frame after reporting a new folder", () => {
      // The parent latches the reported folder and re-renders with it; the
      // attribute must stay put (P3 — that is the whole hazard this guards).
      const onFolderNavigated = vi.fn();
      const { rerender, getByTitle } = render(
        <CodeSurface gitRoot="/repo" workspaceSrc={WS_SRC} reachable={true} onFolderNavigated={onFolderNavigated} />,
      );
      const iframe = getByTitle("Code editor");
      stubFrameSearch(iframe, "?folder=%2Fother");
      fireEvent.load(iframe);
      rerender(
        <CodeSurface gitRoot="/other" workspaceSrc={WS_SRC} reachable={true} onFolderNavigated={onFolderNavigated} />,
      );
      expect(getByTitle("Code editor").getAttribute("src")).toBe(WS_SRC);
      // …and the frame's own location is now the baseline: no repeat report.
      onFolderNavigated.mockClear();
      fireEvent.load(getByTitle("Code editor"));
      expect(onFolderNavigated).not.toHaveBeenCalled();
    });
  });

  // Chord-reclaim effect coverage (review rework): the listener must attach
  // when the iframe mounts AND re-attach after a reachability flip remounts
  // it — the []-deps version silently lost reclaim on false→true.
  it("reclaims matching chords from inside the iframe, across a reachability flip", () => {
    const iframeDoc = (el: HTMLElement): Document => {
      if (!(el instanceof HTMLIFrameElement)) throw new Error("expected an iframe");
      return el.contentDocument!;
    };
    const parentSpy = vi.fn();
    document.addEventListener("keydown", parentSpy);
    const reclaimAll = () => true;
    const WS_SRC = codeServerWorkspaceSrc("/state/@7-3fa1c9.code-workspace");

    const { rerender, getByTitle, unmount } = render(
      <CodeSurface gitRoot="/repo" workspaceSrc={WS_SRC} reachable={true} shouldReclaimChord={reclaimAll} />,
    );
    const doc1 = iframeDoc(getByTitle("Code editor"));
    doc1.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true }));
    expect(parentSpy).toHaveBeenCalledTimes(1);

    // Flip down (iframe unmounts) then back up (fresh iframe) — the effect is
    // keyed on `reachable` and `src`, so the NEW iframe's document gets the
    // listener.
    rerender(<CodeSurface gitRoot="/repo" workspaceSrc={WS_SRC} reachable={false} shouldReclaimChord={reclaimAll} />);
    rerender(<CodeSurface gitRoot="/repo" workspaceSrc={WS_SRC} reachable={true} shouldReclaimChord={reclaimAll} />);
    const doc2 = iframeDoc(getByTitle("Code editor"));
    doc2.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true }));
    expect(parentSpy).toHaveBeenCalledTimes(2);

    // Cleanup removes the listener: after unmount, a dispatch on the stale
    // document must not reach the parent.
    unmount();
    doc2.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true }));
    expect(parentSpy).toHaveBeenCalledTimes(2);
    document.removeEventListener("keydown", parentSpy);
  });

  // Reload editor verb (the second sanctioned re-navigation mechanism): an
  // unseen `reloadNonce` reloads the live frame once via
  // contentWindow.location.reload() — never a src write; mount-time and
  // already-seen nonces are inert.
  describe("reloadNonce (the Reload editor seam)", () => {
    const WS_SRC = codeServerWorkspaceSrc("/state/@7-3fa1c9.code-workspace");

    it("a fresh nonce reloads the live frame exactly once, src untouched", () => {
      const { rerender, getByTitle } = render(
        <CodeSurface gitRoot="/repo" workspaceSrc={WS_SRC} reachable={true} />,
      );
      const iframe = getByTitle("Code editor");
      const reload = stubReload(iframe);
      rerender(
        <CodeSurface gitRoot="/repo" workspaceSrc={WS_SRC} reachable={true} reloadNonce={1} />,
      );
      expect(reload).toHaveBeenCalledTimes(1);
      expect(getByTitle("Code editor").getAttribute("src")).toBe(WS_SRC);
    });

    it("an already-seen nonce re-rendered never reloads again", () => {
      const { rerender, getByTitle } = render(
        <CodeSurface gitRoot="/repo" workspaceSrc={WS_SRC} reachable={true} reloadNonce={1} />,
      );
      const reload = stubReload(getByTitle("Code editor"));
      // Ordinary payload ticks re-render with the same nonce — inert.
      rerender(
        <CodeSurface gitRoot="/other" workspaceSrc={WS_SRC} reachable={true} reloadNonce={1} />,
      );
      expect(reload).not.toHaveBeenCalled();
      // The NEXT unseen nonce fires.
      rerender(
        <CodeSurface gitRoot="/other" workspaceSrc={WS_SRC} reachable={true} reloadNonce={2} />,
      );
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("a nonce present at mount is pre-seen — no reload (a mount IS a fresh boot)", () => {
      const { getByTitle } = render(
        <CodeSurface gitRoot="/repo" workspaceSrc={WS_SRC} reachable={true} reloadNonce={3} />,
      );
      const reload = stubReload(getByTitle("Code editor"));
      expect(reload).not.toHaveBeenCalled();
    });

    it("a nonce arriving while unreachable is recorded and is a silent no-op", () => {
      const { rerender, queryByTitle, getByTitle } = render(
        <CodeSurface gitRoot="/repo" workspaceSrc={WS_SRC} reachable={false} />,
      );
      expect(queryByTitle("Code editor")).toBeNull();
      expect(() =>
        rerender(
          <CodeSurface gitRoot="/repo" workspaceSrc={WS_SRC} reachable={false} reloadNonce={1} />,
        ),
      ).not.toThrow();
      // The nonce is spent: the recovery mount boots fresh and never replays it.
      rerender(
        <CodeSurface gitRoot="/repo" workspaceSrc={WS_SRC} reachable={true} reloadNonce={1} />,
      );
      const reload = stubReload(getByTitle("Code editor"));
      expect(reload).not.toHaveBeenCalled();
    });
  });

  // First-boot rescue: at most three status reads per mount generation
  // (baseline at src adoption, verdict at the wait's expiry, one re-check
  // when neither stamp moved) and at most one reload — and only a newer
  // empty-boot MARKER reloads; a newer host record settles the generation
  // early, and an unavailable read or a ?folder= mount never reloads.
  describe("first-boot rescue (fetchBridgeStatus)", () => {
    const WS_SRC = codeServerWorkspaceSrc("/state/@7-3fa1c9.code-workspace");
    const MARKER = "2026-09-10T02:45:41.100Z";
    const RECORD = "2026-09-10T02:45:42.200Z";

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    const ok = (startedAt: string, emptyBootAt = "", installed = true): CodeBridgeResult => ({
      status: "ok",
      installed,
      startedAt,
      emptyBootAt,
    });
    const flushBaseline = () => act(async () => {});
    const expireWait = (ms = CODE_BOOT_RESCUE_WAIT_MS) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });

    it("a newer host record at the first verdict settles early: no re-check, no reload", async () => {
      // Baseline: nothing yet; verdict: the boot registered its host record.
      const fetcher = vi
        .fn<() => Promise<CodeBridgeResult>>()
        .mockResolvedValueOnce(ok(""))
        .mockResolvedValue(ok(RECORD));
      const { getByTitle } = render(
        <CodeSurface gitRoot="/repo" workspaceSrc={WS_SRC} reachable={true} fetchBridgeStatus={fetcher} />,
      );
      const iframe = getByTitle("Code editor");
      const reload = stubReload(iframe);
      await flushBaseline();
      fireEvent.load(iframe);
      await expireWait();
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(reload).not.toHaveBeenCalled();
      // Settled: no re-check timer, and a later load re-arms nothing.
      await expireWait(CODE_BOOT_RESCUE_WAIT_MS + CODE_BOOT_RESCUE_RECHECK_MS);
      fireEvent.load(iframe);
      await expireWait(CODE_BOOT_RESCUE_WAIT_MS * 2);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(reload).not.toHaveBeenCalled();
    });

    it("no marker and no record never reloads: verdict, one re-check, settled", async () => {
      const fetcher = vi.fn<() => Promise<CodeBridgeResult>>().mockResolvedValue(ok(""));
      const { getByTitle } = render(
        <CodeSurface gitRoot="/repo" workspaceSrc={WS_SRC} reachable={true} fetchBridgeStatus={fetcher} />,
      );
      const iframe = getByTitle("Code editor");
      const reload = stubReload(iframe);
      await flushBaseline();
      fireEvent.load(iframe);
      await expireWait();
      expect(fetcher).toHaveBeenCalledTimes(2); // baseline + first verdict
      await expireWait(CODE_BOOT_RESCUE_RECHECK_MS);
      expect(fetcher).toHaveBeenCalledTimes(3); // the one re-check
      expect(reload).not.toHaveBeenCalled();
      // Settled: a later load (any cause) re-arms nothing and re-reads nothing.
      fireEvent.load(iframe);
      await expireWait(CODE_BOOT_RESCUE_WAIT_MS * 2);
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(reload).not.toHaveBeenCalled();
    });

    it("a marker newer than its baseline at the re-check reloads exactly once", async () => {
      const fetcher = vi
        .fn<() => Promise<CodeBridgeResult>>()
        .mockResolvedValueOnce(ok("")) // baseline: no marker yet
        .mockResolvedValueOnce(ok("")) // first verdict: still nothing
        .mockResolvedValue(ok("", MARKER)); // re-check: the extension reported the empty boot
      const { getByTitle } = render(
        <CodeSurface gitRoot="/repo" workspaceSrc={WS_SRC} reachable={true} fetchBridgeStatus={fetcher} />,
      );
      const iframe = getByTitle("Code editor");
      const reload = stubReload(iframe);
      await flushBaseline();
      fireEvent.load(iframe);
      await expireWait();
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(reload).not.toHaveBeenCalled();
      await expireWait(CODE_BOOT_RESCUE_RECHECK_MS);
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(reload).toHaveBeenCalledTimes(1);
      // The reload's own load event arrives on a settled generation.
      fireEvent.load(iframe);
      await expireWait(CODE_BOOT_RESCUE_WAIT_MS * 2);
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("a marker newer than its baseline at the first verdict reloads with no re-check", async () => {
      const fetcher = vi
        .fn<() => Promise<CodeBridgeResult>>()
        .mockResolvedValueOnce(ok(""))
        .mockResolvedValue(ok("", MARKER));
      const { getByTitle } = render(
        <CodeSurface gitRoot="/repo" workspaceSrc={WS_SRC} reachable={true} fetchBridgeStatus={fetcher} />,
      );
      const iframe = getByTitle("Code editor");
      const reload = stubReload(iframe);
      await flushBaseline();
      fireEvent.load(iframe);
      await expireWait();
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(reload).toHaveBeenCalledTimes(1);
      await expireWait(CODE_BOOT_RESCUE_WAIT_MS + CODE_BOOT_RESCUE_RECHECK_MS);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("a newer record OUTRANKS a newer marker at the same read (late folder): no reload", async () => {
      const fetcher = vi
        .fn<() => Promise<CodeBridgeResult>>()
        .mockResolvedValueOnce(ok(""))
        .mockResolvedValue(ok(RECORD, MARKER));
      const { getByTitle } = render(
        <CodeSurface gitRoot="/repo" workspaceSrc={WS_SRC} reachable={true} fetchBridgeStatus={fetcher} />,
      );
      const iframe = getByTitle("Code editor");
      const reload = stubReload(iframe);
      await flushBaseline();
      fireEvent.load(iframe);
      await expireWait();
      expect(reload).not.toHaveBeenCalled();
      await expireWait(CODE_BOOT_RESCUE_RECHECK_MS);
      expect(fetcher).toHaveBeenCalledTimes(2); // settled early — no re-check
    });

    it("an unavailable verdict fetch performs no reload and warns exactly once", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetcher = vi.fn<() => Promise<CodeBridgeResult>>().mockResolvedValue({ status: "unavailable" });
      const { getByTitle } = render(
        <CodeSurface gitRoot="/repo" workspaceSrc={WS_SRC} reachable={true} fetchBridgeStatus={fetcher} />,
      );
      const iframe = getByTitle("Code editor");
      const reload = stubReload(iframe);
      await flushBaseline();
      fireEvent.load(iframe);
      await expireWait();
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(reload).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("rk code-server install");
      // Settled: no re-check, and a later load neither re-fetches nor re-warns.
      fireEvent.load(iframe);
      await expireWait(CODE_BOOT_RESCUE_WAIT_MS + CODE_BOOT_RESCUE_RECHECK_MS);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("a load during the in-flight verdict fetch never arms a parallel timer", async () => {
      let resolveVerdict: (r: CodeBridgeResult) => void = () => {};
      const fetcher = vi
        .fn<() => Promise<CodeBridgeResult>>()
        .mockResolvedValueOnce(ok("")) // baseline
        .mockImplementationOnce(
          () => new Promise<CodeBridgeResult>((res) => (resolveVerdict = res)),
        ) // first verdict GET hangs
        .mockResolvedValue(ok("", MARKER)); // re-check
      const { getByTitle } = render(
        <CodeSurface gitRoot="/repo" workspaceSrc={WS_SRC} reachable={true} fetchBridgeStatus={fetcher} />,
      );
      const iframe = getByTitle("Code editor");
      const reload = stubReload(iframe);
      await flushBaseline();
      fireEvent.load(iframe);
      await expireWait();
      expect(fetcher).toHaveBeenCalledTimes(2); // verdict fetch in flight
      // A second load while the verdict GET is still pending must not re-arm.
      fireEvent.load(iframe);
      await expireWait(CODE_BOOT_RESCUE_WAIT_MS * 2);
      expect(fetcher).toHaveBeenCalledTimes(2);
      // The hung verdict resolves signal-less: exactly one re-check arms.
      resolveVerdict(ok(""));
      await act(async () => {});
      await expireWait(CODE_BOOT_RESCUE_RECHECK_MS);
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("a reachability-flip remount starts a fresh generation: new baseline read, budget restored", async () => {
      const fetcher = vi.fn<() => Promise<CodeBridgeResult>>().mockResolvedValue(ok(""));
      const { rerender, getByTitle } = render(
        <CodeSurface gitRoot="/repo" workspaceSrc={WS_SRC} reachable={true} fetchBridgeStatus={fetcher} />,
      );
      let reload = stubReload(getByTitle("Code editor"));
      await flushBaseline();
      fireEvent.load(getByTitle("Code editor"));
      await expireWait();
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(reload).not.toHaveBeenCalled();
      await expireWait(CODE_BOOT_RESCUE_RECHECK_MS);
      expect(fetcher).toHaveBeenCalledTimes(3); // first generation spent

      // The new generation's baseline is marker-free; its verdict then sees a
      // marker newer than that baseline.
      fetcher.mockResolvedValueOnce(ok("")).mockResolvedValue(ok("", MARKER));
      rerender(
        <CodeSurface gitRoot="/repo" workspaceSrc={WS_SRC} reachable={false} fetchBridgeStatus={fetcher} />,
      );
      rerender(
        <CodeSurface gitRoot="/repo" workspaceSrc={WS_SRC} reachable={true} fetchBridgeStatus={fetcher} />,
      );
      const remounted = getByTitle("Code editor");
      reload = stubReload(remounted);
      await flushBaseline();
      expect(fetcher).toHaveBeenCalledTimes(4); // the fresh generation's baseline
      fireEvent.load(remounted);
      await expireWait();
      expect(fetcher).toHaveBeenCalledTimes(5);
      expect(reload).toHaveBeenCalledTimes(1); // the new generation's own one-shot
    });

    it("without the fetcher prop the generation is inert — no timer, no warn, no reload", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { getByTitle } = render(
        <CodeSurface gitRoot="/repo" workspaceSrc={WS_SRC} reachable={true} />,
      );
      const iframe = getByTitle("Code editor");
      const reload = stubReload(iframe);
      fireEvent.load(iframe);
      await expireWait(CODE_BOOT_RESCUE_WAIT_MS + CODE_BOOT_RESCUE_RECHECK_MS);
      expect(reload).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it("a ?folder= mount is never rescued — no fetch, no timer, no reload", async () => {
      const fetcher = vi.fn<() => Promise<CodeBridgeResult>>().mockResolvedValue(ok(""));
      const { getByTitle } = render(
        <CodeSurface
          gitRoot="/repo"
          workspaceSrc={codeServerSrc("/repo")}
          reachable={true}
          fetchBridgeStatus={fetcher}
        />,
      );
      const iframe = getByTitle("Code editor");
      const reload = stubReload(iframe);
      fireEvent.load(iframe);
      await expireWait(CODE_BOOT_RESCUE_WAIT_MS + CODE_BOOT_RESCUE_RECHECK_MS);
      expect(fetcher).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    });
  });
});
