import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";

import type { WorkingSnapshot } from "@/lib/working";

const fetchWorkingDiffMock = vi.fn();
const fetchWorkingDiffFileMock = vi.fn();
const fetchWorkingDiffDigestMock = vi.fn();

vi.mock("@/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/api/client")>("@/api/client");
  return {
    ...actual,
    fetchWorkingDiff: (...args: unknown[]) => fetchWorkingDiffMock(...args),
    fetchWorkingDiffFile: (...args: unknown[]) => fetchWorkingDiffFileMock(...args),
    fetchWorkingDiffDigest: (...args: unknown[]) => fetchWorkingDiffDigestMock(...args),
  };
});

import { WorkingSurface } from "@/components/working-surface";

const dirty: WorkingSnapshot = {
  digest: "d1",
  root: "/repo",
  readAt: "2026-09-29T12:00:00Z",
  clean: false,
  files: [
    {
      path: "app/a.go",
      status: "modified",
      staged: true,
      additions: 1,
      deletions: 1,
      hasPatch: true,
      rowCount: 3,
      rows: [
        { kind: "hunk", header: "@@ -1,2 +1,2 @@" },
        { kind: "del", side: "L", l: 1, left: 1, at: 1, spans: [{ t: "old" }] },
        { kind: "add", side: "R", l: 1, right: 1, at: 1, spans: [{ t: "new" }] },
      ],
    },
    {
      path: "fresh.txt",
      status: "untracked",
      staged: false,
      additions: 900,
      deletions: 0,
      hasPatch: true,
      rowCount: 900,
      collapsed: "large",
    },
  ],
};

function renderSurface() {
  return render(<WorkingSurface server="default" windowId="@1" gitRoot="/repo" />);
}

/** The file list's row for a path. The TREE names every file too, so an
 *  unscoped text query is ambiguous by construction. */
function fileRow(path: string): HTMLElement {
  const row = document
    .querySelector(`[data-testid="working-surface"] [id="wd-file-${path}"]`)
    ?.querySelector("button");
  if (!row) throw new Error(`no file row for ${path}`);
  return row as HTMLElement;
}

beforeEach(() => {
  fetchWorkingDiffDigestMock.mockReset().mockResolvedValue("d1");
  fetchWorkingDiffMock.mockReset().mockResolvedValue(dirty);
  fetchWorkingDiffFileMock.mockReset().mockResolvedValue({
    path: "fresh.txt",
    rows: [{ kind: "add", side: "R", l: 1, right: 1, at: 1, spans: [{ t: "fresh" }] }],
    refine: false,
    totalLines: 1,
    headSha: "",
    baseSha: "",
    highlighted: true,
  });
});
afterEach(cleanup);

describe("WorkingSurface", () => {
  it("lists the changed files with their git status letter and staged mark", async () => {
    renderSurface();
    await waitFor(() => expect(screen.getByTestId("working-surface")).toBeTruthy());

    expect(fileRow("app/a.go").textContent).toContain("app/a.go");
    expect(fileRow("fresh.txt").textContent).toContain("fresh.txt");
    // The letters are git's own, so the surface reads the way `git status` does.
    const letters = screen.getAllByTestId("working-status").map((el) => el.textContent);
    expect(letters).toEqual(["M", "?"]);
    // Staged-ness is a per-file badge, not a second view.
    expect(screen.getAllByTestId("working-staged")).toHaveLength(1);
  });

  // READ-ONLY. A working-tree line has no GitHub address, so a comment
  // affordance would be a button that cannot work. Clicking a row must open no
  // composer.
  it("offers no comment composer", async () => {
    renderSurface();
    await waitFor(() => expect(screen.getByTestId("working-surface")).toBeTruthy());
    fireEvent.click(fileRow("app/a.go"));
    expect(screen.queryByPlaceholderText(/comment/i)).toBeNull();
    expect(screen.queryByText(/Start a review/i)).toBeNull();
  });

  // A clean tree is a STATE. The lens exists whenever the window has a repo;
  // emptiness selects the content, never the tile's presence.
  it("renders an empty state on a clean tree rather than disappearing", async () => {
    fetchWorkingDiffMock.mockResolvedValue({ ...dirty, files: [], clean: true });
    renderSurface();
    await waitFor(() => expect(screen.getByTestId("working-empty")).toBeTruthy());
    expect(screen.getByTestId("working-empty").textContent).toMatch(/clean/i);
  });

  it("surfaces a read failure as a message, not a blank tile", async () => {
    fetchWorkingDiffMock.mockRejectedValue(new Error("git is unavailable"));
    renderSurface();
    await waitFor(() => expect(screen.getByTestId("working-error")).toBeTruthy());
    expect(screen.getByTestId("working-error").textContent).toContain("git is unavailable");
  });

  it("toggles the file tree", async () => {
    renderSurface();
    await waitFor(() => expect(screen.getByTestId("working-surface")).toBeTruthy());
    expect(screen.getByTestId("working-tree")).toBeTruthy();
    fireEvent.click(screen.getByTestId("working-tree-toggle"));
    expect(screen.queryByTestId("working-tree")).toBeNull();
  });

  // A file the eager budget declined fetches its body on demand — the same
  // list/body split the PR surface uses, for the same reason.
  it("a budget-declined file costs nothing until asked for", async () => {
    renderSurface();
    await waitFor(() => expect(screen.getByTestId("working-surface")).toBeTruthy());
    // Mounting must not fetch it: the file is large, which is precisely why the
    // server declined to expand it.
    expect(fetchWorkingDiffFileMock).not.toHaveBeenCalled();
    const load = screen.getByRole("button", { name: /Load diff/i });
    expect(load.textContent).toContain("900");
    fireEvent.click(load);
    await waitFor(() => expect(fetchWorkingDiffFileMock).toHaveBeenCalled());
    expect(fetchWorkingDiffFileMock.mock.calls[0]).toContain("fresh.txt");
  });

  // Refresh must not collapse what the reader opened: their expand state is
  // theirs, not the server's.
  it("a refresh does not re-seed the open set", async () => {
    renderSurface();
    await waitFor(() => expect(screen.getByTestId("working-surface")).toBeTruthy());
    fireEvent.click(fileRow("app/a.go")); // close it
    fireEvent.click(screen.getByTestId("working-refresh"));
    await waitFor(() => expect(fetchWorkingDiffMock).toHaveBeenCalledTimes(2));
    expect(fileRow("app/a.go").getAttribute("aria-expanded")).toBe("false");
  });
});

describe("WorkingSurface freshness", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // The whole point: no reload button press, no SSE event — the tile notices on
  // its own. It polls the DIGEST, and only re-reads the document when it moves.
  it("re-reads the tree when the digest moves, and not before", async () => {
    fetchWorkingDiffDigestMock.mockResolvedValue("d1");
    renderSurface();
    await waitFor(() => expect(screen.getByTestId("working-surface")).toBeTruthy());
    expect(fetchWorkingDiffMock).toHaveBeenCalledTimes(1);

    // An unchanged tree: polled, but never re-read.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(fetchWorkingDiffDigestMock.mock.calls.length).toBeGreaterThan(1);
    expect(fetchWorkingDiffMock).toHaveBeenCalledTimes(1);

    // Someone saves a file.
    fetchWorkingDiffDigestMock.mockResolvedValue("d2");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    await waitFor(() => expect(fetchWorkingDiffMock).toHaveBeenCalledTimes(2));
  });

  // A backgrounded tab has no reader to serve. Waking every two seconds to ask
  // git about a tree nobody is looking at is pure waste.
  it("pauses while the page is hidden and re-checks on return", async () => {
    fetchWorkingDiffDigestMock.mockResolvedValue("d1");
    renderSurface();
    await waitFor(() => expect(screen.getByTestId("working-surface")).toBeTruthy());

    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fetchWorkingDiffDigestMock.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(fetchWorkingDiffDigestMock).not.toHaveBeenCalled();

    // Coming back re-checks at once rather than waiting out a tick.
    hidden.mockReturnValue(false);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(fetchWorkingDiffDigestMock).toHaveBeenCalled());
    hidden.mockRestore();
  });

  // A poll that fails is not a failure the reader needs to see: the document on
  // screen is still the last good one, and the next tick retries.
  it("a failed poll leaves the document alone and does not paint an error", async () => {
    fetchWorkingDiffDigestMock.mockRejectedValue(new Error("git exploded"));
    renderSurface();
    await waitFor(() => expect(screen.getByTestId("working-surface")).toBeTruthy());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(screen.queryByTestId("working-error")).toBeNull();
    expect(screen.getByTestId("working-surface")).toBeTruthy();
    expect(fetchWorkingDiffMock).toHaveBeenCalledTimes(1);
  });
});
