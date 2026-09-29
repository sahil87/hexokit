import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Shell } from "./shell";
import { ChromeProvider } from "@/contexts/chrome-context";
import { stubMatchMedia } from "@/test-utils/match-media";
import { focusSidebarCurrentRow, restoreWindowFocus } from "@/lib/sidebar-events";

/**
 * The stateful sidebar chord (260819-qwr7 R5) — ⌘B on mac, ⇧Ctrl+B on
 * Win/Linux. jsdom's UA detects as platform `other`, so the registry default
 * resolves to the base shifted tier: Shift+Ctrl+KeyB.
 *
 * The shell→sidebar/route seams (`lib/sidebar-events.ts` module registries)
 * are mocked here — their CONTRACT (which row takes focus, roving sync, the
 * restorer resolution) is covered in `components/sidebar/index.test.tsx`; this
 * suite proves branch SELECTION only.
 */
vi.mock("@/lib/sidebar-events", () => ({
  focusSidebarCurrentRow: vi.fn(() => true),
  restoreWindowFocus: vi.fn(() => true),
}));

const mockFocusRow = vi.mocked(focusSidebarCurrentRow);
const mockRestore = vi.mocked(restoreWindowFocus);

/** Shift+Ctrl+KeyB — the resolved default on the jsdom ("other") host. */
function pressSidebarChord(target: Element | Window | Document = document.body) {
  fireEvent.keyDown(target, { key: "B", code: "KeyB", ctrlKey: true, shiftKey: true });
}

function renderShell(opts: { open?: boolean; mobile?: boolean } = {}) {
  const { open = true, mobile = false } = opts;
  // Pin the chrome preference explicitly — the unset default is
  // viewport-dependent (the shell.test.tsx pattern).
  localStorage.setItem("hexokit-sidebar-open", open ? "true" : "false");
  stubMatchMedia((q) => (mobile ? q.includes("max-width") : false));
  return render(
    <ChromeProvider>
      <Shell
        sidebarChildren={
          <div data-testid="sidebar">
            <button type="button" data-testid="row">row</button>
          </div>
        }
      >
        <main style={{ gridArea: "content" }} data-testid="content">
          <button type="button" data-testid="content-button">content</button>
        </main>
      </Shell>
    </ChromeProvider>,
  );
}

const sidebarAside = () => screen.queryByRole("complementary", { name: "Sidebar" });

describe("Shell — stateful sidebar chord (⌘B / ⇧Ctrl+B, 260819-qwr7 R5)", () => {
  beforeEach(() => {
    localStorage.clear();
    mockFocusRow.mockClear().mockReturnValue(true);
    mockRestore.mockClear().mockReturnValue(true);
    // Run the hidden-branch's deferred row focus synchronously instead of
    // waiting a real frame (the sidebar index.test.tsx pattern).
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("hidden → opens the sidebar and focuses the current row (deferred past the mount commit)", () => {
    renderShell({ open: false });
    expect(sidebarAside()).not.toBeInTheDocument();

    pressSidebarChord();

    expect(sidebarAside()).toBeInTheDocument();
    expect(mockFocusRow).toHaveBeenCalledTimes(1);
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it("visible + focus outside the sidebar → focuses the current row, sidebar stays open", () => {
    renderShell({ open: true });
    screen.getByTestId("content-button").focus();

    pressSidebarChord();

    expect(mockFocusRow).toHaveBeenCalledTimes(1);
    expect(sidebarAside()).toBeInTheDocument();
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it("visible + focus INSIDE the sidebar → hides and returns focus via the registered restorer", () => {
    renderShell({ open: true });
    screen.getByTestId("row").focus();

    pressSidebarChord();

    expect(sidebarAside()).not.toBeInTheDocument();
    expect(mockRestore).toHaveBeenCalledTimes(1);
    expect(mockFocusRow).not.toHaveBeenCalled();
  });

  it("hide branch blurs when no restorer is registered (board/host routes register none)", () => {
    mockRestore.mockReturnValue(false);
    renderShell({ open: true });
    const row = screen.getByTestId("row");
    row.focus();
    expect(document.activeElement).toBe(row);

    pressSidebarChord();

    expect(sidebarAside()).not.toBeInTheDocument();
    expect(mockRestore).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(document.body);
  });

  it("mobile keeps the plain visibility toggle — no row focus, no restorer", () => {
    renderShell({ open: false, mobile: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    pressSidebarChord();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(mockFocusRow).not.toHaveBeenCalled();

    pressSidebarChord();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it("fires from a real text input — the binding's ignoreInputs skips the suppression gate", () => {
    // The compose strip's textarea is the motivating focus home: the chord is
    // a modifier combo that never inserts text, so drafting must not swallow
    // it. Focus outside the sidebar → the show-focus branch runs.
    renderShell({ open: true });
    const input = document.createElement("input");
    screen.getByTestId("content").appendChild(input);
    input.focus();

    pressSidebarChord(input);

    expect(mockFocusRow).toHaveBeenCalledTimes(1);
    expect(sidebarAside()).toBeInTheDocument();
    expect(mockRestore).not.toHaveBeenCalled();
  });
});
