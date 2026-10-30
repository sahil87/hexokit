import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SessionTiles } from "./session-tiles";
import { StandaloneSessionContextProvider } from "@/contexts/session-context";
import { ThemeProvider } from "@/contexts/theme-context";
import type { ProjectSession } from "@/types";

const nowSeconds = Math.floor(Date.now() / 1000);

const sessions: ProjectSession[] = [
  {
    name: "run-kit",
    windows: [
      {
        index: 0,
        windowId: "@0",
        name: "main",
        worktreePath: "~/code/run-kit",
        activity: "active",
        isActiveWindow: true,
        paneCommand: "claude",
        activityTimestamp: nowSeconds - 5,
        fabChange: "260313-txna-rich-sidebar-window-status",
        fabStage: "apply",
      },
    ],
  },
  {
    name: "ao-server",
    windows: [
      {
        index: 0,
        windowId: "@2",
        name: "dev",
        worktreePath: "~/code/ao-server",
        activity: "idle",
        isActiveWindow: true,
        paneCommand: "zsh",
        activityTimestamp: nowSeconds - 3600,
      },
    ],
  },
];

const SERVER = "test-server";

function renderTiles(opts: {
  onNavigate?: () => void;
  onCreateSession?: () => void;
  onCreateWindow?: (s: string) => void;
  setPreviewScope?: (server: string, expanded: string[]) => void;
  previews?: Record<string, string>;
  footer?: React.ReactNode;
} = {}) {
  const previewsByServer = new Map<string, Record<string, string>>();
  previewsByServer.set(SERVER, opts.previews ?? {});
  // ThemeProvider: the window-tile preview renders ANSI color via AnsiText,
  // which reads the active theme's palette through useTheme().
  return render(
    <ThemeProvider>
      <StandaloneSessionContextProvider
        value={{
          previewsByServer,
          setPreviewScope: opts.setPreviewScope ?? vi.fn(),
        }}
      >
        <SessionTiles
          server={SERVER}
          sessions={sessions}
          onNavigate={opts.onNavigate ?? vi.fn()}
          onCreateSession={opts.onCreateSession ?? vi.fn()}
          onCreateWindow={opts.onCreateWindow ?? vi.fn()}
          footer={opts.footer}
        />
      </StandaloneSessionContextProvider>
    </ThemeProvider>,
  );
}

describe("SessionTiles", () => {
  beforeEach(() => {
    // ThemeProvider reads prefers-color-scheme on mount.
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        media: "(prefers-color-scheme: dark)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    );
  });
  afterEach(cleanup);

  it("renders one tile per session with the stats line", () => {
    renderTiles();
    expect(screen.getByTestId("session-tile-run-kit")).toBeInTheDocument();
    expect(screen.getByTestId("session-tile-ao-server")).toBeInTheDocument();
    expect(screen.getByText(/2 groups, 2 tabs/)).toBeInTheDocument();
  });

  it("hides window tiles until the session is expanded, then reveals them", () => {
    renderTiles();
    expect(
      screen.queryByTestId("window-tile-run-kit-0"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Expand run-kit"));
    expect(screen.getByTestId("window-tile-run-kit-0")).toBeInTheDocument();
  });

  it("shows the pane text preview as static text (no xterm/relay)", () => {
    renderTiles({ previews: { "@0": "line one\nline two\n$ claude" } });
    fireEvent.click(screen.getByLabelText("Expand run-kit"));

    const preview = screen.getByTestId("window-tile-preview-@0");
    expect(preview).toHaveTextContent("line one");
    expect(preview).toHaveTextContent("$ claude");
    // Static text container, not a terminal canvas.
    expect(preview.tagName).toBe("DIV");
    // No xterm instance is mounted anywhere in the tiles view.
    expect(document.querySelector(".xterm")).toBeNull();
    expect(document.querySelector("canvas")).toBeNull();
  });

  it("renders ANSI color in the preview as styled spans (not raw escapes)", () => {
    // A red word wrapped in SGR codes, as `capture-pane -e` delivers it.
    const RED = "\x1b[31mERROR\x1b[0m ok";
    renderTiles({ previews: { "@0": RED } });
    fireEvent.click(screen.getByLabelText("Expand run-kit"));

    const preview = screen.getByTestId("window-tile-preview-@0");
    // The visible text is the content, with escape bytes stripped.
    expect(preview).toHaveTextContent("ERROR ok");
    expect(preview.textContent).not.toContain("\x1b");
    expect(preview.textContent).not.toContain("[31m");
    // The colored run is a span carrying an inline color (from the palette).
    const colored = Array.from(preview.querySelectorAll("span")).find(
      (s) => s.textContent === "ERROR",
    );
    expect(colored).toBeDefined();
    expect(colored?.style.color).not.toBe("");
  });

  it("navigates to the live terminal when a window tile is clicked", () => {
    const onNavigate = vi.fn();
    renderTiles({ onNavigate });
    fireEvent.click(screen.getByLabelText("Expand run-kit"));
    fireEvent.click(screen.getByTestId("window-tile-run-kit-0"));
    expect(onNavigate).toHaveBeenCalledWith("@0");
  });

  it("declares the expanded session set to the backend on expand and collapse", () => {
    const setPreviewScope = vi.fn();
    renderTiles({ setPreviewScope });

    // Initial mount declares the empty set (nothing expanded).
    expect(setPreviewScope).toHaveBeenLastCalledWith(SERVER, []);

    fireEvent.click(screen.getByLabelText("Expand run-kit"));
    expect(setPreviewScope).toHaveBeenLastCalledWith(SERVER, ["run-kit"]);

    fireEvent.click(screen.getByLabelText("Expand ao-server"));
    expect(setPreviewScope).toHaveBeenLastCalledWith(
      SERVER,
      ["ao-server", "run-kit"],
    );

    fireEvent.click(screen.getByLabelText("Collapse run-kit"));
    expect(setPreviewScope).toHaveBeenLastCalledWith(SERVER, ["ao-server"]);
  });

  // Rest-state PR glyph (aqo6) — the window tile's only PR channel, mirroring
  // the sidebar row's glyph: prOwnsGlyph gate, shared prGlyphColor vocabulary,
  // aria-hidden decoration.
  describe("tile PR glyph", () => {
    function renderWithPr(pr: Partial<ProjectSession["windows"][number]>) {
      const withPr: ProjectSession[] = [
        {
          name: "run-kit",
          windows: [{ ...sessions[0].windows[0], ...pr }],
        },
      ];
      const previewsByServer = new Map<string, Record<string, string>>();
      previewsByServer.set(SERVER, {});
      return render(
        <ThemeProvider>
          <StandaloneSessionContextProvider
            value={{ previewsByServer, setPreviewScope: vi.fn() }}
          >
            <SessionTiles
              server={SERVER}
              sessions={withPr}
              onNavigate={vi.fn()}
              onCreateSession={vi.fn()}
              onCreateWindow={vi.fn()}
            />
          </StandaloneSessionContextProvider>
        </ThemeProvider>,
      );
    }

    it("renders the glyph for an owned open PR (green, aria-hidden)", () => {
      renderWithPr({ prNumber: 386, prState: "open", prChecks: "pass" });
      fireEvent.click(screen.getByLabelText("Expand run-kit"));
      const glyph = screen.getByTestId("tile-pr-glyph");
      expect(glyph).toHaveAttribute("aria-hidden", "true");
      expect(glyph.className).toContain("text-accent-green");
      expect(glyph.querySelector("svg")).not.toBeNull();
    });

    it("renders the glyph yellow for checks running and purple for merged", () => {
      renderWithPr({ prNumber: 386, prState: "open", prChecks: "pending" });
      fireEvent.click(screen.getByLabelText("Expand run-kit"));
      expect(screen.getByTestId("tile-pr-glyph").className).toContain("text-signal-yellow");
      cleanup();
      renderWithPr({ prNumber: 386, prState: "merged" });
      fireEvent.click(screen.getByLabelText("Expand run-kit"));
      expect(screen.getByTestId("tile-pr-glyph").className).toContain("text-signal-purple");
    });

    // Closed earns the glyph — red with the distinct ✕ closed icon (same
    // state-picked icon as the sidebar row). No glyph only without a prNumber.
    it("renders the glyph red with the closed ✕ icon for a closed-unmerged PR", () => {
      renderWithPr({ prNumber: 386, prState: "closed" });
      fireEvent.click(screen.getByLabelText("Expand run-kit"));
      const glyph = screen.getByTestId("tile-pr-glyph");
      expect(glyph.className).toContain("text-signal-red");
      expect(glyph.querySelector('path[d="m21 3-6 6"]')).not.toBeNull();
      expect(glyph.querySelector('path[d="M13 6h3a2 2 0 0 1 2 2v7"]')).toBeNull();
      cleanup();
      renderWithPr({});
      fireEvent.click(screen.getByLabelText("Expand run-kit"));
      expect(screen.queryByTestId("tile-pr-glyph")).toBeNull();
    });

    it("keeps the normal PR icon for open PRs (state-picked icon)", () => {
      renderWithPr({ prNumber: 386, prState: "open", prChecks: "pass" });
      fireEvent.click(screen.getByLabelText("Expand run-kit"));
      const glyph = screen.getByTestId("tile-pr-glyph");
      expect(glyph.querySelector('path[d="m21 3-6 6"]')).toBeNull();
      expect(glyph.querySelector('path[d="M18 6V5"]')).toBeNull();
      expect(glyph.querySelector('path[d="M13 6h3a2 2 0 0 1 2 2v7"]')).not.toBeNull();
    });

    it("renders the dotted-rail draft icon in gray for an open draft, and ✕ red for a closed draft", () => {
      renderWithPr({ prNumber: 386, prState: "open", prIsDraft: true, prChecks: "pass" });
      fireEvent.click(screen.getByLabelText("Expand run-kit"));
      let glyph = screen.getByTestId("tile-pr-glyph");
      expect(glyph.className).toContain("text-text-secondary");
      expect(glyph.querySelector('path[d="M18 6V5"]')).not.toBeNull();
      expect(glyph.querySelector('path[d="M18 11v-1"]')).not.toBeNull();
      expect(glyph.querySelector('path[d="M13 6h3a2 2 0 0 1 2 2v7"]')).toBeNull();
      cleanup();
      renderWithPr({ prNumber: 386, prState: "closed", prIsDraft: true });
      fireEvent.click(screen.getByLabelText("Expand run-kit"));
      glyph = screen.getByTestId("tile-pr-glyph");
      expect(glyph.className).toContain("text-signal-red");
      expect(glyph.querySelector('path[d="m21 3-6 6"]')).not.toBeNull();
      expect(glyph.querySelector('path[d="M18 6V5"]')).toBeNull();
    });
  });

  // Tile note body (8n6k) — a window carrying a @rk_win_note renders the note
  // (+ relative age) as the tile body INSTEAD of the capture preview; no note
  // → the preview renders exactly as before. Staleness dimming rides the
  // shared NOTE_STALE_SECONDS; epoch-0 notes render text-only.
  describe("tile note body", () => {
    function renderWithNote(
      note: Partial<ProjectSession["windows"][number]>,
      previews: Record<string, string> = { "@0": "preview line" },
    ) {
      const withNote: ProjectSession[] = [
        {
          name: "run-kit",
          windows: [{ ...sessions[0].windows[0], ...note }],
        },
      ];
      const previewsByServer = new Map<string, Record<string, string>>();
      previewsByServer.set(SERVER, previews);
      return render(
        <ThemeProvider>
          <StandaloneSessionContextProvider
            value={{ previewsByServer, setPreviewScope: vi.fn() }}
          >
            <SessionTiles
              server={SERVER}
              sessions={withNote}
              onNavigate={vi.fn()}
              onCreateSession={vi.fn()}
              onCreateWindow={vi.fn()}
            />
          </StandaloneSessionContextProvider>
        </ThemeProvider>,
      );
    }

    it("renders the note + age instead of the preview when a note exists", () => {
      renderWithNote({
        note: "blocked on flaky e2e",
        noteEpoch: nowSeconds - 2 * 3600,
      });
      fireEvent.click(screen.getByLabelText("Expand run-kit"));

      const note = screen.getByTestId("window-tile-note-@0");
      expect(note).toHaveTextContent("blocked on flaky e2e");
      expect(note).toHaveTextContent("ago");
      expect(screen.queryByTestId("window-tile-preview-@0")).toBeNull();
      expect(note.className).not.toContain("opacity-50");
    });

    it("renders the preview unchanged when the window has no note", () => {
      renderWithNote({});
      fireEvent.click(screen.getByLabelText("Expand run-kit"));

      expect(screen.getByTestId("window-tile-preview-@0")).toBeInTheDocument();
      expect(screen.queryByTestId("window-tile-note-@0")).toBeNull();
    });

    it("dims a stale (>24h) note, still legible", () => {
      renderWithNote({
        note: "blocked on flaky e2e",
        noteEpoch: nowSeconds - 3 * 24 * 3600,
      });
      fireEvent.click(screen.getByLabelText("Expand run-kit"));

      const note = screen.getByTestId("window-tile-note-@0");
      expect(note.className).toContain("opacity-50");
      expect(note).toHaveTextContent("blocked on flaky e2e");
    });

    it("renders an epoch-0 note text-only (no age, undimmed)", () => {
      renderWithNote({ note: "blocked on flaky e2e" });
      fireEvent.click(screen.getByLabelText("Expand run-kit"));

      const note = screen.getByTestId("window-tile-note-@0");
      expect(note).toHaveTextContent("blocked on flaky e2e");
      expect(note).not.toHaveTextContent("ago");
      expect(note.className).not.toContain("opacity-50");
    });
  });

  it("renders the footer slot after the grid inside the scroll container", () => {
    renderTiles({ footer: <div data-testid="tiles-footer">zone content</div> });

    const footer = screen.getByTestId("tiles-footer");
    expect(footer).toHaveTextContent("zone content");
    // Same scroll container as the grid (the one-scroll rule), after it.
    const scrollArea = document.querySelector(".overflow-y-auto");
    expect(scrollArea).not.toBeNull();
    expect(scrollArea?.contains(footer)).toBe(true);
    const grid = scrollArea?.querySelector(".grid");
    expect(grid).not.toBeNull();
    expect(
      grid!.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("wires the New group and New Tab actions", () => {
    const onCreateSession = vi.fn();
    const onCreateWindow = vi.fn();
    renderTiles({ onCreateSession, onCreateWindow });

    fireEvent.click(screen.getByText("+ New group"));
    expect(onCreateSession).toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("Expand run-kit"));
    fireEvent.click(screen.getByText("+ New Tab"));
    expect(onCreateWindow).toHaveBeenCalledWith("run-kit");
  });
});
