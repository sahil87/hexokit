import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { WindowRow } from "./window-row";
import { resetMarkerPadRegistry } from "./marker-pad";
import { FLYOUT_OPEN_DELAY_MS, resetFlyoutWarmState } from "./row-flyout-card";
import { ToastProvider } from "@/components/toast";
import { ThemeProvider } from "@/contexts/theme-context";
import * as optimisticContext from "@/contexts/optimistic-context";
import { computeRowTints, computeRowBorders, deriveUIColors, DEFAULT_DARK_THEME } from "@/themes";
import type { WindowInfo } from "@/types";
import type { MergedWindow } from "@/store/window-store";
import { makeWindow } from "@/test-utils/fixtures";

afterEach(() => {
  cleanup();
  resetMarkerPadRegistry();
});

/** The Label picker (SwatchPopover) uses `useTheme()`, which throws without a
 *  matchMedia shim + ThemeProvider. Query-aware: ONLY the color-scheme query
 *  matches — an always-true stub would also flip `(pointer: coarse)` and gate
 *  off the fine-pointer-only pin/kill cluster. */
function mockMatchMedia() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((q: string) => ({
      matches: q === "(prefers-color-scheme: dark)",
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
    })),
  );
}

/** Coarse-pointer stub: only `(pointer: coarse)` matches (the e2e
 *  mockCoarsePointer idiom). jsdom has no real pointer media feature. */
function mockCoarsePointer() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((q: string) => ({
      matches: ["(pointer: coarse)", "(any-pointer: coarse)"].includes(q),
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
    })),
  );
}

const noop = () => {};
const noopDrag = (e: React.DragEvent) => { e.preventDefault(); };

function renderRow(win: WindowInfo) {
  return render(
    <WindowRow
      win={win}
      session="alpha"
      isSelected={false}
      isDragOver={false}
      editingWindow={null}
      editingName=""
      inputRef={{ current: null }}
      onSelectWindow={noop}
      onStartEditing={noop}
      onWindowNameChange={noop}
      onRenameKeyDown={noop as React.KeyboardEventHandler<HTMLInputElement>}
      onRenameBlur={noop}
      onKillClick={noop}
      onDragStart={noopDrag}
      onDragOver={noopDrag}
      onDrop={noopDrag}
      onDragEnd={noop}
    />,
  );
}

/** Render with `server` and `onColorChange` wired so the right-cluster action
 *  icons (pin / kill) exist in the DOM. */
function renderRowWithIcons(win: WindowInfo) {
  return render(
    <WindowRow
      win={win}
      session="alpha"
      isSelected={false}
      isDragOver={false}
      editingWindow={null}
      editingName=""
      inputRef={{ current: null }}
      onSelectWindow={noop}
      onStartEditing={noop}
      onWindowNameChange={noop}
      onRenameKeyDown={noop as React.KeyboardEventHandler<HTMLInputElement>}
      onRenameBlur={noop}
      onKillClick={noop}
      onDragStart={noopDrag}
      onDragOver={noopDrag}
      onDrop={noopDrag}
      onDragEnd={noop}
      onColorChange={noop}
      server="srv"
    />,
  );
}

function makeGhostWindow(overrides: Partial<MergedWindow> = {}): MergedWindow {
  return {
    name: "ghost-win",
    worktreePath: "",
    activity: "idle",
    isActiveWindow: false,
    activityTimestamp: 0,
    index: -1,
    windowId: "",
    optimistic: true,
    optimisticId: "ghost-1",
    ...overrides,
  };
}

function renderGhostRow(win: MergedWindow) {
  return render(
    <WindowRow
      win={win}
      session="alpha"
      isSelected={false}
      isDragOver={false}
      editingWindow={null}
      editingName=""
      inputRef={{ current: null }}
      onSelectWindow={noop}
      onStartEditing={noop}
      onWindowNameChange={noop}
      onRenameKeyDown={noop as React.KeyboardEventHandler<HTMLInputElement>}
      onRenameBlur={noop}
      onKillClick={noop}
      onDragStart={noopDrag}
      onDragOver={noopDrag}
      onDrop={noopDrag}
      onDragEnd={noop}
    />,
  );
}

describe("WindowRow", () => {
  it("renders window name", () => {
    const win = makeWindow({ windowId: "@0", index: 0, name: "my-shell" });
    renderRow(win);
    expect(screen.getByText("my-shell")).toBeInTheDocument();
  });

  it("renders an operator headset between the status dot and window name", () => {
    const win = makeWindow({
      windowId: "@0",
      index: 0,
      name: "coordinator",
      role: "operator",
    });
    renderRow(win);

    const icon = screen.getByTestId("operator-headset-icon");
    const iconSlot = icon.parentElement;
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(iconSlot).toHaveClass(
      "text-text-secondary",
      "group-hover:text-text-primary",
    );
    expect(iconSlot?.previousElementSibling).toBe(
      screen.getByTestId("status-dot-tap"),
    );
    expect(iconSlot?.nextElementSibling).toBe(screen.getByText("coordinator"));
  });

  it.each([undefined, "worker"])(
    "renders no operator headset when role is %s",
    (role) => {
      renderRow(makeWindow({ windowId: "@0", index: 0, role }));
      expect(screen.queryByTestId("operator-headset-icon")).not.toBeInTheDocument();
    },
  );

  // One icon system (260724-2bmy): the kill ✕ is a stroke SVG (CloseIcon), not
  // a text glyph, so it reads at the same ink weight as the sibling pin icon.
  it("renders the kill button as a stroke SVG icon, not a text glyph", () => {
    const win = makeWindow({ windowId: "@0", index: 0, name: "my-shell" });
    renderRow(win);
    const kill = screen.getByLabelText("Kill tab my-shell");
    expect(kill.querySelector("svg")).not.toBeNull();
    expect(kill.textContent).toBe("");
  });

  it("does not render tooltip (removed in favor of status panel)", () => {
    const win = makeWindow({ windowId: "@0", index: 0 });
    const { container } = renderRow(win);
    const tooltip = container.querySelector(".top-full.opacity-0.group-hover\\:opacity-100");
    expect(tooltip).toBeNull();
  });

  it("renders ghost window with reduced opacity", () => {
    const win = makeGhostWindow();
    const { container } = renderGhostRow(win);
    expect(container.querySelector(".opacity-50.animate-pulse")).not.toBeNull();
  });

  // PR status is no longer rendered in the sidebar window row — it moved to the
  // Pane panel (see status-panel.test.tsx). The former dashboard PrStatusLine
  // component was retired (260715-jykd) — the PR L3 register in the Pane panel is
  // now the sole PR text surface.
  it("does not render a PR status line even for a change-bound window with a PR", () => {
    const win = makeWindow({
      windowId: "@0",
      index: 0,
      fabChange: "260610-596o-x",
      prNumber: 386,
      prUrl: "https://github.com/o/r/pull/386",
      prState: "open",
      prChecks: "pass",
    });
    renderRow(win);
    expect(screen.queryByTestId("pr-status-line")).toBeNull();
  });

  // Flair overlay (decoration-only channel): an always-on ambient CSS-only
  // animation mounted whenever the window carries a flair value — gated on
  // `win.flair` alone, in every row state.
  describe("flair overlay", () => {
    it("mounts the rk-flair overlay span when the window carries a flair", () => {
      const win = makeWindow({ windowId: "@0", index: 0, flair: "onepiece" });
      const { container } = renderRow(win);
      const overlay = container.querySelector(".rk-flair-onepiece");
      expect(overlay).not.toBeNull();
      expect(overlay!.getAttribute("aria-hidden")).toBe("true");
    });

    it("mounts NO flair overlay when the window has no flair", () => {
      const win = makeWindow({ windowId: "@0", index: 0 });
      const { container } = renderRow(win);
      expect(container.querySelector("[class*='rk-flair-']")).toBeNull();
    });

    it("hides the flair overlay while the row is the drag source (drag-ghost guard)", () => {
      const win = makeWindow({ windowId: "@0", index: 0, flair: "cube" });
      const { container, rerender } = render(
        <WindowRow
          win={win}
          session="alpha"
          isSelected={false}
          isDragOver={false}
          isDragSource={true}
          editingWindow={null}
          editingName=""
          inputRef={{ current: null }}
          onSelectWindow={noop}
          onStartEditing={noop}
          onWindowNameChange={noop}
          onRenameKeyDown={noop as React.KeyboardEventHandler<HTMLInputElement>}
          onRenameBlur={noop}
          onKillClick={noop}
          onDragStart={noopDrag}
          onDragOver={noopDrag}
          onDrop={noopDrag}
          onDragEnd={noop}
        />,
      );
      expect(container.querySelector("[class*='rk-flair-']")).toBeNull();
      // At rest the cube markup contract renders (wrappers + 6 faces).
      rerender(
        <WindowRow
          win={win}
          session="alpha"
          isSelected={false}
          isDragOver={false}
          isDragSource={false}
          editingWindow={null}
          editingName=""
          inputRef={{ current: null }}
          onSelectWindow={noop}
          onStartEditing={noop}
          onWindowNameChange={noop}
          onRenameKeyDown={noop as React.KeyboardEventHandler<HTMLInputElement>}
          onRenameBlur={noop}
          onKillClick={noop}
          onDragStart={noopDrag}
          onDragOver={noopDrag}
          onDrop={noopDrag}
          onDragEnd={noop}
        />,
      );
      const cube = container.querySelector(".rk-flair-cube .rk-cube-x .rk-cube-y .rk-cube");
      expect(cube).not.toBeNull();
      expect(cube!.querySelectorAll(".rk-cube-face")).toHaveLength(6);
    });
  });

  // Row Minimalism (260706-y1ar; status-pyramid.md § Row Minimalism): the
  // trailing status cluster is REMOVED — the row renders NO stage word and NO
  // duration text. The leading StatusDot is the row's only externally visible
  // status signal; the exact stage word + durations live in the row flyout card
  // and the PANE panel's register view.
  describe("Row Minimalism — no stage word, no duration in the row", () => {
    it("renders no stage word for an active fab stage", () => {
      const win = makeWindow({
        windowId: "@0",
        index: 0,
        fabChange: "260612-epqk-x",
        fabStage: "review-pr",
        fabDisplayState: "active",
      });
      renderRow(win);
      // The stage word never appears as row text — only the leading dot + name.
      expect(screen.queryByText("review-pr")).toBeNull();
      expect(screen.getByText("zsh")).toBeInTheDocument();
    });

    it("renders no duration text (e.g. agent idle duration is not in the row)", () => {
      const win = makeWindow({
        windowId: "@0",
        index: 0,
        fabChange: "260612-epqk-x",
        fabStage: "review-pr",
        fabDisplayState: "done",
        agentState: "idle",
        agentIdleDuration: "2m",
      });
      renderRow(win);
      expect(screen.queryByText("2m")).toBeNull();
    });

    it("renders no stage word even for a failed stage (no red row text)", () => {
      const win = makeWindow({
        windowId: "@0",
        index: 0,
        fabChange: "260613-o20f-x",
        fabStage: "review",
        fabDisplayState: "failed",
      });
      renderRow(win);
      expect(screen.queryByText("review")).toBeNull();
    });
  });

  // The DOT carries the LOCAL status only (hue=phase, shape=status, additive
  // halo=waiting) — compositional vocabulary (aqo6): PR state never owns the
  // dot; the rest-state glyph is the row's only PR channel.
  describe("dot status signals", () => {

    it("renders an additive yellow halo on a waiting window (core hue kept)", () => {
      const win = makeWindow({
        windowId: "@0",
        index: 0,
        fabChange: "260613-o20f-x",
        fabStage: "intake",
        fabDisplayState: "active",
        agentState: "waiting",
      });
      renderRow(win);
      const dot = screen.getByLabelText("building — at rest — agent waiting");
      expect(dot.className).toContain("text-signal-blue"); // core hue kept
      expect(dot.className).toContain("rk-waiting-halo"); // additive overlay
    });


    it("PR eviction: a merged PR never turns the dot purple — the fab tier renders (glyph carries merged)", () => {
      const win = makeWindow({
        windowId: "@0",
        index: 0,
        fabChange: "260613-o20f-x",
        fabStage: "review-pr",
        fabDisplayState: "done",
        prNumber: 386,
        prState: "merged",
        prChecks: "fail", // historical — irrelevant to the dot either way
      });
      renderRow(win);
      expect(screen.queryByLabelText("PR — merged")).toBeNull();
      const dot = screen.getByLabelText("PR-ready — at rest");
      expect(dot.className).toContain("text-accent-green");
      expect(dot.className).not.toContain("text-signal-purple");
      expect(dot.className).not.toContain("rounded-none"); // the square is retired
    });





  });

  // Rest-state PR glyph (93dy — user-approved partial Row-Minimalism
  // reversal): a window with an OWNED PR shows a git-pull-request stroke glyph
  // at rest in the trailing cluster's last slot; on hover it display-swaps
  // for the pin+✕ actions. jsdom evaluates neither :hover nor pointer media,
  // so the swap/coarse/focus gating is asserted as class strings.
  describe("rest-state PR glyph (93dy)", () => {
    it.each([
      { label: "passing", prState: "open", prChecks: "pass", color: "text-accent-green" },
      { label: "merged", prState: "merged", prChecks: undefined, color: "text-signal-purple" },
      { label: "pending", prState: "open", prChecks: "pending", color: "text-signal-yellow" },
      { label: "failing", prState: "open", prChecks: "fail", color: "text-signal-red" },
    ] as const)("applies prGlyphColor's class for a $label PR", ({ prState, prChecks, color }) => {
      const win = makeWindow({ windowId: "@0", index: 0, prNumber: 386, prState, prChecks });
      renderRowWithIcons(win);
      const glyph = screen.getByTestId("row-pr-glyph");
      expect(glyph).toHaveAttribute("aria-hidden", "true");
      expect(glyph.className).toContain(color);
      expect(glyph.querySelector("svg")).not.toBeNull();
      expect(glyph.textContent).toBe("");
    });


    // e30p → aqo6: draft is glyph-only by construction — the dot never renders
    // PR state at all, so every PR fact (draft included) lives on the glyph.
    it("renders the glyph gray for an open draft PR", () => {
      const win = makeWindow({
        windowId: "@0",
        index: 0,
        prNumber: 386,
        prState: "open",
        prIsDraft: true,
        prChecks: "pass",
      });
      renderRowWithIcons(win);
      const glyph = screen.getByTestId("row-pr-glyph");
      expect(glyph.className).toContain("text-text-secondary");
      expect(glyph.className).not.toContain("text-accent-green");
      // Draft owns its own shape: the dotted merge rail replaces the arc.
      expect(glyph.querySelector('path[d="M18 6V5"]')).not.toBeNull();
      expect(glyph.querySelector('path[d="M18 11v-1"]')).not.toBeNull();
      expect(glyph.querySelector('path[d="M13 6h3a2 2 0 0 1 2 2v7"]')).toBeNull();
      expect(glyph.querySelector('path[d="m21 3-6 6"]')).toBeNull();
    });

    it("keeps the draft shape but turns red for a failing draft (fail wins the color, draft keeps the shape)", () => {
      const win = makeWindow({
        windowId: "@0",
        index: 0,
        prNumber: 386,
        prState: "open",
        prIsDraft: true,
        prChecks: "fail",
      });
      renderRowWithIcons(win);
      const glyph = screen.getByTestId("row-pr-glyph");
      expect(glyph.className).toContain("text-signal-red");
      expect(glyph.querySelector('path[d="M18 6V5"]')).not.toBeNull();
      expect(glyph.querySelector('path[d="M13 6h3a2 2 0 0 1 2 2v7"]')).toBeNull();
    });



    // Closed earns the glyph — GitHub red with the distinct ✕ closed icon.
    // Shape separates closed from failing (both red); color separates closed
    // from draft (gray).
    it("renders the glyph red with the closed ✕ icon for a closed-unmerged PR", () => {
      const win = makeWindow({ windowId: "@0", index: 0, prNumber: 386, prState: "closed" });
      renderRowWithIcons(win);
      const glyph = screen.getByTestId("row-pr-glyph");
      expect(glyph.className).toContain("text-signal-red");
      expect(glyph.className).not.toContain("text-text-secondary");
      // The closed ✕ mark (m21 3-6 6) replaces the merge arc of the normal icon.
      expect(glyph.querySelector('path[d="m21 3-6 6"]')).not.toBeNull();
      expect(glyph.querySelector('path[d="M13 6h3a2 2 0 0 1 2 2v7"]')).toBeNull();
    });

    it("a closed draft reads closed (✕, red) — closed wins over the draft shape", () => {
      const win = makeWindow({ windowId: "@0", index: 0, prNumber: 386, prState: "closed", prIsDraft: true });
      renderRowWithIcons(win);
      const glyph = screen.getByTestId("row-pr-glyph");
      expect(glyph.className).toContain("text-signal-red");
      expect(glyph.querySelector('path[d="m21 3-6 6"]')).not.toBeNull();
      expect(glyph.querySelector('path[d="M18 6V5"]')).toBeNull();
    });

    it("keeps the normal PR icon for open and merged PRs (state-picked icon)", () => {
      for (const prState of ["open", "merged"] as const) {
        const win = makeWindow({ windowId: "@0", index: 0, prNumber: 386, prState });
        const { unmount } = renderRowWithIcons(win);
        const glyph = screen.getByTestId("row-pr-glyph");
        expect(glyph.querySelector('path[d="m21 3-6 6"]')).toBeNull();
        expect(glyph.querySelector('path[d="M18 6V5"]')).toBeNull();
        expect(glyph.querySelector('path[d="M13 6h3a2 2 0 0 1 2 2v7"]')).not.toBeNull();
        unmount();
      }
    });

    it("renders NO glyph without a prNumber", () => {
      const win = makeWindow({ windowId: "@0", index: 0 });
      renderRowWithIcons(win);
      expect(screen.queryByTestId("row-pr-glyph")).toBeNull();
    });

    it("renders NO glyph on ghost rows", () => {
      renderGhostRow(makeGhostWindow());
      expect(screen.queryByTestId("row-pr-glyph")).toBeNull();
    });

    it("slot discipline: the glyph is a right-edge overlay in the ✕ slot that display-swaps away on hover/cluster-focus", () => {
      const win = makeWindow({ windowId: "@0", index: 0, name: "my-shell", prNumber: 386, prState: "open" });
      const { container } = renderRowWithIcons(win);
      const glyph = screen.getByTestId("row-pr-glyph");
      // Inside the named action cluster, absolutely anchored at its right edge
      // with the buttons' 24px box — so its right edge == the hover ✕'s.
      const cluster = container.querySelector("div.absolute.right-2")!;
      expect(cluster.className).toContain("group/icons");
      expect(cluster.contains(glyph)).toBe(true);
      expect(glyph.className).toContain("absolute");
      expect(glyph.className).toContain("right-0");
      expect(glyph.className).toContain("min-w-[24px]");
      expect(glyph.className).toContain("min-h-[24px]");
      // Display swap (not an opacity fade) on fine-pointer hover and while
      // keyboard focus is inside the cluster; never a pointer target. COARSE
      // pointers keep the glyph at rest (the action cluster is fine-pointer-
      // only, so the glyph is the row's only at-rest PR channel on touch).
      expect(glyph.className).toContain("group-hover:hidden");
      expect(glyph.className).not.toContain("coarse:hidden");
      expect(glyph.className).toContain("group-has-[:focus-visible]/icons:hidden");
      expect(glyph.className).toContain("pointer-events-none");
      expect(glyph.className).not.toContain("opacity-");
      // The pin + kill actions keep their slots (pin holds its slot; only the
      // last slot swaps): both buttons still render in the cluster.
      expect(screen.getByLabelText("Pin my-shell to a board")).toBeInTheDocument();
      expect(screen.getByLabelText("Kill tab my-shell")).toBeInTheDocument();
    });

    it("pinned rest state `[pin][PR]`: the persistent pin glyph coexists with the rest PR glyph", () => {
      const win = makeWindow({ windowId: "@0", index: 0, name: "my-shell", prNumber: 386, prState: "open" });
      render(
        <WindowRow
          win={win}
          session="alpha"
          isSelected={false}
          isDragOver={false}
          editingWindow={null}
          editingName=""
          inputRef={{ current: null }}
          onSelectWindow={noop}
          onStartEditing={noop}
          onWindowNameChange={noop}
          onRenameKeyDown={noop as React.KeyboardEventHandler<HTMLInputElement>}
          onRenameBlur={noop}
          onKillClick={noop}
          server="srv"
          isPinnedToAny={true}
        />,
      );
      const pin = screen.getByLabelText("Pin my-shell to a board");
      expect(pin.className).toContain("opacity-100"); // persistent pin, its own slot
      expect(screen.getByTestId("row-pr-glyph")).toBeInTheDocument(); // PR in the last slot
    });
  });

  // jsdom does not evaluate :hover / @media (pointer: coarse) / :has() as
  // computed styles, so the hardening contract is asserted as class strings.
  describe("hover-icon cluster hardening", () => {
    it("icon container is inert at rest and restores interactivity on hover and focus within (fine-pointer-only cluster)", () => {
      const win = makeWindow({ windowId: "@0", index: 0 });
      const { container } = renderRowWithIcons(win);
      const cluster = container.querySelector("div.absolute.right-2");
      expect(cluster).not.toBeNull();
      expect(cluster!.className).toContain("pointer-events-none");
      expect(cluster!.className).toContain("group-hover:pointer-events-auto");
      // The cluster still mounts on coarse (it anchors the PR glyph overlay)
      // but no longer restores interactivity there — its buttons are
      // render-gated off (pin/kill live on the flyout card's action rows).
      expect(cluster!.className).not.toContain("coarse:pointer-events-auto");
      expect(cluster!.className).toContain("has-[:focus-visible]:pointer-events-auto");
    });

    it("hover-revealed buttons reveal themselves on keyboard focus", () => {
      const win = makeWindow({ windowId: "@0", index: 0, name: "my-shell" });
      renderRowWithIcons(win);
      const pin = screen.getByLabelText("Pin my-shell to a board");
      const kill = screen.getByLabelText("Kill tab my-shell");
      // The color button moved to the left label zone (hwtr) — the right cluster
      // is actions-only now (pin + kill).
      expect(screen.queryByLabelText("Set color for my-shell")).toBeNull();
      for (const btn of [pin, kill]) {
        expect(btn.className).toContain("opacity-0");
        expect(btn.className).toContain("focus-visible:opacity-100");
      }
    });

    it("pinned pin button stays permanently visible (no geometry/visibility change)", () => {
      const win = makeWindow({ windowId: "@0", index: 0, name: "my-shell" });
      render(
        <WindowRow
          win={win}
          session="alpha"
          isSelected={false}
          isDragOver={false}
          editingWindow={null}
          editingName=""
          inputRef={{ current: null }}
          onSelectWindow={noop}
          onStartEditing={noop}
          onWindowNameChange={noop}
          onRenameKeyDown={noop as React.KeyboardEventHandler<HTMLInputElement>}
          onRenameBlur={noop}
          onKillClick={noop}
          server="srv"
          isPinnedToAny={true}
        />,
      );
      const pin = screen.getByLabelText("Pin my-shell to a board");
      expect(pin.className).toContain("opacity-100");
      expect(pin.className).not.toContain("opacity-0 ");
    });
  });

  // Pinned-row → board navigation (co9z): a pinned window's pin popover offers a
  // "Go to {board}" row that navigates to the owning board.
  describe("pinned-row board navigation (co9z)", () => {
    it("offers a 'Go to {board}' row in the pin popover that calls onNavigateToBoard", async () => {
      const win = makeWindow({ windowId: "@0", index: 0, name: "my-shell" });
      const onNavigateToBoard = vi.fn();
      render(
        <ToastProvider>
          <WindowRow
            win={win}
            session="alpha"
            isSelected={false}
            isDragOver={false}
            editingWindow={null}
            editingName=""
            inputRef={{ current: null }}
            onSelectWindow={noop}
            onStartEditing={noop}
            onWindowNameChange={noop}
            onRenameKeyDown={noop as React.KeyboardEventHandler<HTMLInputElement>}
            onRenameBlur={noop}
            onKillClick={noop}
            server="srv"
            isPinnedToAny={true}
            pinnedBoard="work"
            onNavigateToBoard={onNavigateToBoard}
          />
        </ToastProvider>,
      );
      // Open the pin popover via the pin button.
      await act(async () => {
        screen.getByLabelText("Pin my-shell to a board").click();
      });
      const goto = screen.getByRole("button", { name: /Go to work/ });
      expect(goto).toBeInTheDocument();
      await act(async () => {
        goto.click();
      });
      expect(onNavigateToBoard).toHaveBeenCalledWith("work");
    });

    it("does not offer the 'Go to' row when the window is not pinned to a board", async () => {
      const win = makeWindow({ windowId: "@0", index: 0, name: "my-shell" });
      render(
        <ToastProvider>
          <WindowRow
            win={win}
            session="alpha"
            isSelected={false}
            isDragOver={false}
            editingWindow={null}
            editingName=""
            inputRef={{ current: null }}
            onSelectWindow={noop}
            onStartEditing={noop}
            onWindowNameChange={noop}
            onRenameKeyDown={noop as React.KeyboardEventHandler<HTMLInputElement>}
            onRenameBlur={noop}
            onKillClick={noop}
            server="srv"
            onNavigateToBoard={noop}
          />
        </ToastProvider>,
      );
      await act(async () => {
        screen.getByLabelText("Pin my-shell to a board").click();
      });
      expect(screen.queryByRole("button", { name: /Go to/ })).not.toBeInTheDocument();
    });
  });

  // W3C-APG tree leaf semantics (Wave 3 sidebar-keyboard-nav). The window row
  // wrapper is the treeitem; the roving model in index.tsx threads tabIndex +
  // level/set/pos metadata. Level-2 leaves carry NO aria-expanded.
  describe("tree ARIA + roving tabindex", () => {
    function row(el: HTMLElement): HTMLElement {
      // The treeitem is the [data-window-id] wrapper carrying role="treeitem".
      const item = el.querySelector<HTMLElement>('[role="treeitem"][data-window-id]');
      expect(item).not.toBeNull();
      return item!;
    }

    it("renders role=treeitem at aria-level 2 with no aria-expanded", () => {
      const win = makeWindow({ windowId: "@3", index: 0, name: "edit" });
      const { container } = render(
        <WindowRow
          win={win}
          session="alpha"
          isSelected={false}
          isDragOver={false}
          editingWindow={null}
          editingName=""
          inputRef={{ current: null }}
          onSelectWindow={noop}
          onStartEditing={noop}
          onWindowNameChange={noop}
          onRenameKeyDown={noop as React.KeyboardEventHandler<HTMLInputElement>}
          onRenameBlur={noop}
          onKillClick={noop}
          ariaLevel={2}
          ariaSetSize={1}
          ariaPosInSet={1}
          tabIndex={-1}
        />,
      );
      const item = row(container);
      expect(item).toHaveAttribute("role", "treeitem");
      expect(item).toHaveAttribute("aria-level", "2");
      expect(item).not.toHaveAttribute("aria-expanded");
    });

    it("reflects aria-setsize / aria-posinset when passed", () => {
      const win = makeWindow({ windowId: "@3", index: 1, name: "test" });
      const { container } = render(
        <WindowRow
          win={win}
          session="alpha"
          isSelected={false}
          isDragOver={false}
          editingWindow={null}
          editingName=""
          inputRef={{ current: null }}
          onSelectWindow={noop}
          onStartEditing={noop}
          onWindowNameChange={noop}
          onRenameKeyDown={noop as React.KeyboardEventHandler<HTMLInputElement>}
          onRenameBlur={noop}
          onKillClick={noop}
          ariaLevel={2}
          ariaSetSize={2}
          ariaPosInSet={2}
          tabIndex={0}
        />,
      );
      const item = row(container);
      expect(item).toHaveAttribute("aria-setsize", "2");
      expect(item).toHaveAttribute("aria-posinset", "2");
    });

    it("defaults tabIndex to -1 and reflects an explicit roving tabIndex of 0", () => {
      const win = makeWindow({ windowId: "@3", index: 0 });
      const { container: a } = renderRow(win);
      expect(row(a)).toHaveAttribute("tabindex", "-1");

      const { container: b } = render(
        <WindowRow
          win={win}
          session="alpha"
          isSelected={false}
          isDragOver={false}
          editingWindow={null}
          editingName=""
          inputRef={{ current: null }}
          onSelectWindow={noop}
          onStartEditing={noop}
          onWindowNameChange={noop}
          onRenameKeyDown={noop as React.KeyboardEventHandler<HTMLInputElement>}
          onRenameBlur={noop}
          onKillClick={noop}
          tabIndex={0}
        />,
      );
      expect(row(b)).toHaveAttribute("tabindex", "0");
    });
  });

  // React.memo only pays off when the parent passes referentially-stable props.
  // This proves the memo'd WindowRow does NOT re-render its body when its PARENT
  // re-renders with an identical prop set — the property the whole change depends
  // on (an unrelated SSE tick re-renders Sidebar but must not churn the row).
  //
  // We count the row's OWN render-body executions via a spy on `isGhostWindow`,
  // which `WindowRowInner` calls at the very top of every render (`const ghost =
  // isGhostWindow(win)`). The parent (`Harness`) creates a FRESH <WindowRow>
  // element each render from a hoisted, stable props object, defeating React's
  // element-identity bailout — so only `React.memo` can stop the body from
  // re-running. An un-memoized WindowRow would call `isGhostWindow` again and
  // fail. (A Profiler-commit count would be confounded: a Profiler fires on its
  // parent's commit even when its memo'd child bails.)
  describe("React.memo", () => {
    it("does not re-render the row body when the parent re-renders with stable props", () => {
      const win = makeWindow({ windowId: "@0", index: 0, name: "stable" });
      const ghostSpy = vi.spyOn(optimisticContext, "isGhostWindow");

      // Hoisted once — every Harness render passes these identical references.
      const stableProps = {
        win,
        session: "alpha",
        isSelected: false,
        isDragOver: false,
        editingWindow: null,
        editingName: "",
        inputRef: { current: null },
        onSelectWindow: noop,
        onStartEditing: noop,
        onWindowNameChange: noop,
        onRenameKeyDown: noop as React.KeyboardEventHandler<HTMLInputElement>,
        onRenameBlur: noop,
        onKillClick: noop,
        onDragStart: noopDrag,
        onDragOver: noopDrag,
        onDrop: noopDrag,
        onDragEnd: noop,
      };

      let forceParent: () => void = () => {};
      function Harness() {
        const [, setTick] = useState(0);
        forceParent = () => setTick((n) => n + 1);
        // Fresh element each render, but identical prop references.
        return <WindowRow {...stableProps} />;
      }

      render(<Harness />);
      const afterMount = ghostSpy.mock.calls.length;
      expect(afterMount).toBeGreaterThan(0);

      // Force a parent re-render (the SSE-tick analogue). A NEW <WindowRow>
      // element is created, but its props are the same references, so memo skips
      // the row body — `isGhostWindow` is not called again.
      act(() => { forceParent(); });
      expect(ghostSpy.mock.calls.length).toBe(afterMount);

      ghostSpy.mockRestore();
    });
  });

  // Selection remains tint + typography, while markers occupy a fixed,
  // display-only well at the physical left edge.
  describe("axis split + display-only marker well", () => {
    const rowTints = computeRowTints(DEFAULT_DARK_THEME.palette, deriveUIColors(DEFAULT_DARK_THEME.palette, "dark").bgChrome);
    const rowBorders = computeRowBorders(DEFAULT_DARK_THEME.palette, DEFAULT_DARK_THEME.category);

    beforeEach(() => {
      mockMatchMedia();
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** Render with the label props wired. The row reads `color` and
     *  `marker` as props, mirroring the real sidebar call site. */
    function renderAxis(win: WindowInfo, extra: Partial<React.ComponentProps<typeof WindowRow>> = {}) {
      return render(
        <ThemeProvider>
          <WindowRow
            win={win}
            session="alpha"
            isSelected={false}
            isDragOver={false}
            color={win.color}
            marker={win.marker}
            editingWindow={null}
            editingName=""
            inputRef={{ current: null }}
            onSelectWindow={noop}
            onStartEditing={noop}
            onWindowNameChange={noop}
            onRenameKeyDown={noop as React.KeyboardEventHandler<HTMLInputElement>}
            onRenameBlur={noop}
            onKillClick={noop}
            onColorChange={noop}
            onMarkerChange={noop}
            onFlairChange={noop}
            rowTints={rowTints}
            rowBorders={rowBorders}
            server="srv"
            {...extra}
          />
        </ThemeProvider>,
      );
    }

    it("selected row carries NO left border and gets the deep 40% tint + bold", () => {
      const win = makeWindow({ windowId: "@0", index: 0, name: "sel", color: "orange" });
      const { container } = renderAxis(win, { isSelected: true });
      const button = container.querySelector('button[aria-current="page"]') as HTMLElement;
      expect(button).toBeTruthy();
      // No borderLeft on the button (selection border removed).
      expect(button.style.borderLeft).toBe("");
      // Selection uses tint.selected (the 40% blend) as the background.
      expect(button.style.backgroundColor).not.toBe("");
      // Bold + brightened text.
      expect(button.className).toContain("font-medium");
      expect(button.className).toContain("text-text-primary");
    });

    it("a bulk-selected row paints exactly like the open row while a selection is live", () => {
      const win = makeWindow({ windowId: "@1", index: 1, name: "member", color: "orange" });
      const onRowClick = () => false;
      const open = renderAxis(win, { isSelected: true, onRowClick });
      const openButton = open.container.querySelector("button[aria-current]") as HTMLElement;
      const openTreatment = { bg: openButton.style.backgroundColor, cls: openButton.className };
      open.unmount();

      const { container } = renderAxis(win, { isBulkSelected: true, selectionActive: true, onRowClick });
      const item = container.querySelector('[role="treeitem"]') as HTMLElement;
      const button = item.querySelector("button") as HTMLElement;
      expect(item).toHaveAttribute("aria-selected", "true");
      expect(button.style.backgroundColor).toBe(openTreatment.bg);
      expect(button.className).toBe(openTreatment.cls);
      expect(item.style.boxShadow).toBe("");
      // Not the open page — only the visual is shared.
      expect(button).not.toHaveAttribute("aria-current");
    });

    it("the open row drops its treatment while a selection it is not part of is live", () => {
      const win = makeWindow({ windowId: "@0", index: 0, name: "open", color: "orange" });
      const { container } = renderAxis(win, {
        isSelected: true,
        isBulkSelected: false,
        selectionActive: true,
        onRowClick: () => false,
      });
      const button = container.querySelector('button[aria-current="page"]') as HTMLElement;
      expect(button.className).not.toContain("font-medium");
    });

    it("an unselected colored row shows no left border either", () => {
      const win = makeWindow({ windowId: "@0", index: 0, color: "blue" });
      const { container } = renderAxis(win);
      const button = container.querySelector("button") as HTMLElement;
      expect(button.style.borderLeft).toBe("");
    });

    it("pin glyph turns green when pinned to the active board", () => {
      const win = makeWindow({ windowId: "@0", index: 0, name: "pinned" });
      renderAxis(win, { isPinnedToAny: true, isPinnedToActiveBoard: true });
      const pin = screen.getByLabelText("Pin pinned to a board");
      expect(pin.className).toContain("text-accent-green");
      expect(pin.className).toContain("opacity-100");
    });

    it("pin glyph stays monochrome when pinned to a NON-active board", () => {
      const win = makeWindow({ windowId: "@0", index: 0, name: "pinned" });
      renderAxis(win, { isPinnedToAny: true, isPinnedToActiveBoard: false });
      const pin = screen.getByLabelText("Pin pinned to a board");
      expect(pin.className).not.toContain("text-accent-green");
      expect(pin.className).toContain("text-text-secondary");
    });

    it("renders the marker track on every row and gates fills on parsed markers", () => {
      const cases = [
        { marker: "manual:1", width: "7px", fill: "solid", paths: 0 },
        { marker: "manual:2", width: "15px", fill: "solid", paths: 0 },
        { marker: "manual:3", width: "22px", fill: "solid", paths: 0 },
        { marker: "blocked:1", width: "7px", fill: "hatch", paths: 0 },
        { marker: "blocked:2", width: "15px", fill: "hatch", paths: 0 },
        { marker: "blocked:3", width: "22px", fill: "hatch", paths: 0 },
        { marker: "auto:1", width: "", fill: "chevrons", paths: 1 },
        { marker: "auto:2", width: "", fill: "chevrons", paths: 2 },
        { marker: "auto:3", width: "", fill: "chevrons", paths: 3 },
      ];
      for (const { marker, width, fill, paths } of cases) {
        const { unmount } = renderAxis(makeWindow({ windowId: "@0", index: 0, marker }));
        const well = screen.getByTestId("marker-well");
        expect(well.className).toContain("left-0");
        expect(well.className).toContain("pointer-events-none");
        expect(well.style.width).toBe("22px");
        expect(well.style.background).toContain("var(--color-marker-ink) 12%");
        expect(well.style.borderRight).toContain("var(--color-marker-ink) 30%");
        const renderedFill = screen.getByTestId("marker-fill");
        if (fill === "chevrons") {
          expect(well.querySelectorAll("path")).toHaveLength(paths);
        } else {
          expect(renderedFill?.style.width).toBe(width);
          if (fill === "solid") expect(renderedFill?.style.background).toBe("var(--color-marker-ink)");
          if (fill === "hatch") expect(renderedFill?.style.backgroundImage).toContain("linear-gradient(45deg");
        }
        unmount();
      }

      renderAxis(makeWindow({ windowId: "@1", index: 1 }));
      const emptyWell = screen.getByTestId("marker-well");
      expect(emptyWell.style.width).toBe("22px");
      expect(emptyWell.style.background).toContain("var(--color-marker-ink) 12%");
      expect(emptyWell.style.borderRight).toContain("var(--color-marker-ink) 30%");
      expect(screen.queryByTestId("marker-fill")).toBeNull();
      expect(screen.getByRole("treeitem").querySelector(".rk-hazard")).toBeNull();
    });

    it("commits horizontal, vertical, and clamped fine-pointer drags", () => {
      const cases = [
        { x: 30, y: 10, expected: "manual:2" },
        { x: 4, y: 36, expected: "auto:1" },
        { x: 404, y: 10, expected: "manual:3" },
      ];
      for (const { x, y, expected } of cases) {
        const onMarkerChange = vi.fn();
        const { unmount } = renderAxis(makeWindow({ marker: "manual:1" }), {
          onMarkerChange,
        });
        const strip = screen.getByTestId("marker-strip");
        fireEvent.pointerDown(strip, { pointerId: 1, clientX: 4, clientY: 10 });
        fireEvent.pointerMove(strip, { pointerId: 1, clientX: x, clientY: y });
        fireEvent.pointerUp(strip, { pointerId: 1, clientX: x, clientY: y });
        expect(onMarkerChange).toHaveBeenCalledWith("srv", "alpha", "@0", expected);
        expect(screen.queryByTestId("marker-pad")).toBeNull();
        unmount();
        resetMarkerPadRegistry();
      }
    });

    it("leaves the pad open and writes nothing after a no-move release", () => {
      const onMarkerChange = vi.fn();
      renderAxis(makeWindow({ marker: "manual:1" }), { onMarkerChange });
      const strip = screen.getByTestId("marker-strip");
      fireEvent.pointerDown(strip, { pointerId: 1, clientX: 4, clientY: 10 });
      fireEvent.pointerUp(strip, { pointerId: 1, clientX: 4, clientY: 10 });
      expect(onMarkerChange).not.toHaveBeenCalled();
      expect(screen.getByTestId("marker-pad")).toBeInTheDocument();
    });

    it("closes the pad on a second no-move strip click", () => {
      const onMarkerChange = vi.fn();
      renderAxis(makeWindow({ marker: "manual:1" }), { onMarkerChange });
      const strip = screen.getByTestId("marker-strip");
      fireEvent.pointerDown(strip, { pointerId: 1, clientX: 4, clientY: 10 });
      fireEvent.pointerUp(strip, { pointerId: 1, clientX: 4, clientY: 10 });
      expect(screen.getByTestId("marker-pad")).toBeInTheDocument();
      fireEvent.pointerDown(strip, { pointerId: 2, clientX: 4, clientY: 10 });
      fireEvent.pointerUp(strip, { pointerId: 2, clientX: 4, clientY: 10 });
      expect(screen.queryByTestId("marker-pad")).toBeNull();
      expect(onMarkerChange).not.toHaveBeenCalled();
    });

    it("still commits a drag that starts from an already-open pad", () => {
      const onMarkerChange = vi.fn();
      renderAxis(makeWindow({ marker: "manual:1" }), { onMarkerChange });
      const strip = screen.getByTestId("marker-strip");
      fireEvent.pointerDown(strip, { pointerId: 1, clientX: 4, clientY: 10 });
      fireEvent.pointerUp(strip, { pointerId: 1, clientX: 4, clientY: 10 });
      expect(screen.getByTestId("marker-pad")).toBeInTheDocument();
      fireEvent.pointerDown(strip, { pointerId: 2, clientX: 4, clientY: 10 });
      fireEvent.pointerMove(strip, { pointerId: 2, clientX: 30, clientY: 10 });
      fireEvent.pointerUp(strip, { pointerId: 2, clientX: 30, clientY: 10 });
      expect(onMarkerChange).toHaveBeenCalledWith("srv", "alpha", "@0", "manual:2");
      expect(screen.queryByTestId("marker-pad")).toBeNull();
    });

    it("keeps strip presses out of row selection and HTML drag", () => {
      const onSelectWindow = vi.fn();
      const onDragStart = vi.fn();
      renderAxis(makeWindow({ marker: "manual:1" }), {
        draggable: true,
        onSelectWindow,
        onDragStart,
      });
      const strip = screen.getByTestId("marker-strip");
      fireEvent.pointerDown(strip, { pointerId: 1, clientX: 4, clientY: 10 });
      fireEvent.click(strip);
      const drag = new Event("dragstart", { bubbles: true, cancelable: true });
      screen.getByRole("treeitem").dispatchEvent(drag);
      expect(onSelectWindow).not.toHaveBeenCalled();
      expect(onDragStart).not.toHaveBeenCalled();
      expect(drag.defaultPrevented).toBe(true);
    });

    it("keeps exactly one pad open when a second row strip is pressed", () => {
      render(
        <ThemeProvider>
          <div>
            {[
              makeWindow({ windowId: "@0", index: 0, marker: "manual:1" }),
              makeWindow({ windowId: "@1", index: 1, marker: "auto:2" }),
            ].map((win) => (
              <WindowRow
                key={win.windowId}
                win={win}
                session="alpha"
                isSelected={false}
                isDragOver={false}
                marker={win.marker}
                editingWindow={null}
                editingName=""
                inputRef={{ current: null }}
                onSelectWindow={noop}
                onStartEditing={noop}
                onWindowNameChange={noop}
                onRenameKeyDown={noop as React.KeyboardEventHandler<HTMLInputElement>}
                onRenameBlur={noop}
                onKillClick={noop}
                onMarkerChange={noop}
                server="srv"
              />
            ))}
          </div>
        </ThemeProvider>,
      );
      const strips = screen.getAllByTestId("marker-strip");
      fireEvent.pointerDown(strips[0], { pointerId: 1, clientX: 4, clientY: 10 });
      expect(screen.getAllByTestId("marker-pad")).toHaveLength(1);
      fireEvent.pointerDown(strips[1], { pointerId: 2, clientX: 4, clientY: 46 });
      const pads = screen.getAllByTestId("marker-pad");
      expect(pads).toHaveLength(1);
      expect(pads[0].closest('[data-window-id="@1"]')).not.toBeNull();
    });

    it("steps marked rows with a non-passive wheel listener only for non-zero deltaY", () => {
      const onMarkerChange = vi.fn();
      renderAxis(makeWindow({ marker: "auto:2" }), { onMarkerChange });
      const strip = screen.getByTestId("marker-strip");
      const step = new WheelEvent("wheel", {
        deltaY: 1,
        bubbles: true,
        cancelable: true,
      });
      strip.dispatchEvent(step);
      expect(step.defaultPrevented).toBe(true);
      expect(onMarkerChange).toHaveBeenCalledWith("srv", "alpha", "@0", "auto:3");

      onMarkerChange.mockClear();
      const zero = new WheelEvent("wheel", {
        deltaY: 0,
        bubbles: true,
        cancelable: true,
      });
      strip.dispatchEvent(zero);
      expect(zero.defaultPrevented).toBe(false);
      expect(onMarkerChange).not.toHaveBeenCalled();

      cleanup();
      resetMarkerPadRegistry();
      const onUnmarkedChange = vi.fn();
      renderAxis(makeWindow({ marker: "" }), { onMarkerChange: onUnmarkedChange });
      for (const deltaY of [1, 0]) {
        const event = new WheelEvent("wheel", {
          deltaY,
          bubbles: true,
          cancelable: true,
        });
        screen.getByTestId("marker-strip").dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
      }
      expect(onUnmarkedChange).not.toHaveBeenCalled();
    });

    it("opens only the matching row from marker-pad:open", () => {
      renderAxis(makeWindow({ windowId: "@0", marker: "auto:1" }));
      act(() => {
        document.dispatchEvent(
          new CustomEvent("marker-pad:open", {
            detail: { server: "srv", windowId: "@1" },
          }),
        );
      });
      expect(screen.queryByTestId("marker-pad")).toBeNull();
      act(() => {
        document.dispatchEvent(
          new CustomEvent("marker-pad:open", {
            detail: { server: "srv", windowId: "@0" },
          }),
        );
      });
      expect(screen.getByTestId("marker-pad-cell-auto-1")).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });

    it("renders no strip without a marker write seam", () => {
      renderAxis(makeWindow({ marker: "manual:1" }), {
        onMarkerChange: undefined,
      });
      expect(screen.queryByTestId("marker-strip")).toBeNull();
    });

    it("flair animation remains independent from the marker axis", () => {
      const win = makeWindow({ windowId: "@0", index: 0, color: "green", marker: "manual:1", flair: "rain" });
      const { container } = renderAxis(win);
      const overlay = container.querySelector(".rk-flair-rain") as HTMLElement;
      expect(overlay).toBeTruthy();
      expect(overlay.className).toContain("overflow-hidden");
      expect(overlay.className).toContain("pointer-events-none");
      // The tinted flair reads the row's guarded family color.
      expect(overlay.style.getPropertyValue("--rk-flair-color")).not.toBe("");
    });

    it("blocked markers alone get the static hazard wedge in fixed marker ink", () => {
      const win = makeWindow({ windowId: "@0", index: 0, color: "green", marker: "blocked:2" });
      const { container } = renderAxis(win);
      const row = container.querySelector('[data-window-id="@0"]') as HTMLElement;
      expect(row.className).not.toContain("rk-hazard");
      expect(row.className).not.toContain("overflow-hidden");
      const overlay = row.querySelector(".rk-hazard") as HTMLElement;
      expect(overlay).toBeTruthy();
      expect(overlay.className).toContain("overflow-hidden");
      expect(overlay.className).toContain("pointer-events-none");
      expect(row.style.getPropertyValue("--rk-marker-color")).toBe("var(--color-marker-ink)");

      cleanup();
      for (const marker of [undefined, "manual:2", "auto:2"]) {
        const { container: next, unmount } = renderAxis(makeWindow({ windowId: "@1", index: 1, marker }));
        expect(next.querySelector(".rk-hazard")).toBeNull();
        expect((next.querySelector('[data-window-id="@1"]') as HTMLElement).style.getPropertyValue("--rk-marker-color")).toBe("");
        unmount();
      }
    });

    it("the hazard wedge is STATIC in every state — no animation class even when selected", () => {
      const win = makeWindow({ windowId: "@0", index: 0, color: "green", marker: "blocked:3" });
      const { container } = renderAxis(win, { isSelected: true });
      const overlay = container.querySelector(".rk-hazard") as HTMLElement;
      expect(overlay).toBeTruthy();
      expect(overlay.className).not.toContain("crawl");
    });

    it("the Window: Label palette action (label-popover:open) opens this row's picker", () => {
      const win = makeWindow({ windowId: "@0", index: 0, color: "orange" });
      renderAxis(win);
      expect(screen.queryByRole("listbox", { name: "Label picker" })).toBeNull();
      act(() => {
        document.dispatchEvent(
          new CustomEvent("label-popover:open", {
            detail: { server: "srv", windowId: "@0" },
          }),
        );
      });
      expect(screen.getByRole("listbox", { name: "Label picker" })).toBeInTheDocument();
    });

    it("omits the label-zone affordance on a marked row", () => {
      const win = makeWindow({ windowId: "@0", index: 0, marker: "manual:2", color: "orange" });
      const { container } = renderAxis(win);
      expect(screen.queryByLabelText("Set tab label")).toBeNull();
      expect(container.querySelectorAll('[data-testid="marker-well"]')).toHaveLength(1);
    });

    it("hover leaves a colored row's background tint unchanged", () => {
      const { container } = renderAxis(makeWindow({ windowId: "@0", index: 0, color: "orange" }));
      const row = container.querySelector('[data-window-id="@0"]') as HTMLElement;
      const button = row.querySelector("button") as HTMLElement;
      const before = button.style.backgroundColor;
      act(() => fireEvent.mouseEnter(row));
      expect(button.style.backgroundColor).toBe(before);
      act(() => fireEvent.mouseLeave(row));
      expect(button.style.backgroundColor).toBe(before);
    });
  });
});

describe("held-row continuity while the flyout is open (E1)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetFlyoutWarmState();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetFlyoutWarmState();
  });

  it("the row button HOLDS the hover shade + bright text while its card is open", () => {
    renderRow(makeWindow({ name: "held-win" }));
    const root = screen.getByRole("treeitem");
    const button = root.querySelector("button")!;
    // At rest the shade/brightening exist only as hover: variants — no bare
    // tokens (the regexes reject the `hover:`-prefixed copies via the
    // preceding-space requirement).
    expect(button.className).not.toMatch(/(?:^| )bg-bg-chrome-raised/);
    expect(button.className).not.toMatch(/(?:^| )text-text-primary/);

    act(() => {
      fireEvent.pointerEnter(root, { pointerType: "mouse" });
      fireEvent.mouseEnter(root);
      vi.advanceTimersByTime(FLYOUT_OPEN_DELAY_MS + 50);
    });
    expect(screen.getByTestId("row-flyout-card")).toBeInTheDocument();
    // Open card ⇒ the held-row cue: the shade + brightening become
    // UNCONDITIONAL classes, so they survive the pointer traveling onto the
    // card (where CSS :hover on the row is lost).
    expect(button.className).toMatch(/(?:^| )bg-bg-chrome-raised/);
    expect(button.className).toMatch(/(?:^| )text-text-primary/);
  });
});

// On coarse pointers the status rail remains the sole card target. The status
// dot is a plain row descendant, so clicking it follows normal row selection.
describe("coarse pointer: rest glyph, rail target, and plain status dot", () => {
  beforeEach(() => {
    resetFlyoutWarmState();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetFlyoutWarmState();
  });

  function renderCoarseRow(win: WindowInfo, extra: Partial<React.ComponentProps<typeof WindowRow>> = {}) {
    mockCoarsePointer();
    return render(
      <WindowRow
        win={win}
        session="alpha"
        isSelected={false}
        isDragOver={false}
        editingWindow={null}
        editingName=""
        inputRef={{ current: null }}
        onSelectWindow={noop}
        onStartEditing={noop}
        onWindowNameChange={noop}
        onRenameKeyDown={noop as React.KeyboardEventHandler<HTMLInputElement>}
        onRenameBlur={noop}
        onKillClick={noop}
        onDragStart={noopDrag}
        onDragOver={noopDrag}
        onDrop={noopDrag}
        onDragEnd={noop}
        server="srv"
        {...extra}
      />,
    );
  }

  it("renders the rest-state PR glyph in the rail's 16px slot under coarse and render-gates the pin/kill cluster out of the DOM", () => {
    const win = makeWindow({ windowId: "@0", index: 0, name: "my-shell", prNumber: 386, prState: "open", prChecks: "pass" });
    const { container } = renderCoarseRow(win);
    const glyph = screen.getByTestId("row-pr-glyph");
    expect(glyph.className).not.toContain("coarse:hidden");
    expect(glyph.className).toContain("text-accent-green");
    // The glyph's coarse home is the rail's fixed slot — NOT the fine-pointer
    // last-slot overlay (no absolute right-0 geometry).
    const rail = screen.getByTestId("status-rail");
    expect(rail.contains(glyph)).toBe(true);
    expect(glyph.className).not.toContain("absolute");
    // Render-gated, not CSS-hidden: no invisible focusable buttons on touch.
    expect(screen.queryByLabelText("Pin my-shell to a board")).toBeNull();
    expect(screen.queryByLabelText("Kill tab my-shell")).toBeNull();
    // The whole fine-pointer cluster is gone on coarse — the rail owns the
    // row's right edge (an empty hover-armed container would swallow touches).
    expect(container.querySelector("div.absolute.right-2")).toBeNull();
  });

  it("keeps the pin/kill buttons in the DOM under a fine pointer (desktop unchanged)", () => {
    const win = makeWindow({ windowId: "@0", index: 0, name: "my-shell" });
    renderRowWithIcons(win);
    expect(screen.getByLabelText("Pin my-shell to a board")).toBeInTheDocument();
    expect(screen.getByLabelText("Kill tab my-shell")).toBeInTheDocument();
  });

  it("keeps the status dot a plain glyph on coarse pointers", () => {
    renderCoarseRow(makeWindow({ windowId: "@0", index: 0 }));
    const zone = screen.getByTestId("status-dot-tap");
    expect(zone.className).toBe("flex items-center shrink-0");
    expect(zone.className).not.toContain("touch-none");
  });

  it("clicking the status dot selects the row and never opens the coarse card", () => {
    const onSelectWindow = vi.fn();
    renderCoarseRow(makeWindow({ windowId: "@0", index: 0, name: "my-shell" }), { onSelectWindow });
    const zone = screen.getByTestId("status-dot-tap");
    act(() => {
      fireEvent.click(zone);
    });
    expect(onSelectWindow).toHaveBeenCalledWith("srv", "alpha", "@0");
    expect(screen.queryByTestId("row-flyout-card")).toBeNull();
  });

  it("ghost rows wire no scrub — pointerdown on the zone opens nothing", () => {
    mockCoarsePointer();
    renderGhostRow(makeGhostWindow());
    const zone = screen.getByTestId("status-dot-tap");
    act(() => {
      fireEvent.pointerDown(zone, { pointerId: 1, pointerType: "touch" });
    });
    expect(screen.queryByTestId("row-flyout-card")).toBeNull();
  });

  // Right-edge status rail (b8eu, widened + three-tiered in 260817-ve5m): the
  // flyout gesture's visible home on coarse
  // pointers — a 56px inset band with two fixed slots (16px PR glyph + 12px
  // chevron hint), the PRIMARY tap/scrub target sharing the dot zone's
  // handlers. jsdom evaluates no media queries, so geometry/presence is
  // asserted as class strings + inline styles.
  describe("status rail", () => {
    it("renders on every coarse non-ghost row: 56px inset band, seam border, touch-none, both fixed slots", () => {
      const win = makeWindow({ windowId: "@0", index: 0, name: "my-shell" });
      renderCoarseRow(win);
      const rail = screen.getByTestId("status-rail");
      expect(rail.style.width).toBe("56px");
      expect(rail.className).toContain("bg-bg-inset");
      expect(rail.className).toContain("border-l");
      expect(rail.className).toContain("border-border");
      expect(rail.className).toContain("touch-none");
      // The chevron hint renders on EVERY rail (a consistent rail is a
      // learnable rail) — including this PR-less row: muted, ~55% opacity,
      // aria-hidden decoration, in the fixed 12px slot.
      const chevron = Array.from(rail.querySelectorAll("span")).find((s) => s.textContent === "›")!;
      expect(chevron).toBeTruthy();
      expect(chevron.className).toContain("w-3");
      expect(chevron.className).toContain("opacity-55");
      expect(chevron.getAttribute("aria-hidden")).toBe("true");
      // The 16px glyph slot holds an empty span when the row owns no PR, so
      // the chevron column never shifts sideways.
      const glyphSlot = chevron.previousElementSibling as HTMLElement;
      expect(glyphSlot.className).toContain("w-4");
      expect(glyphSlot.children).toHaveLength(0);
      expect(screen.queryByTestId("row-pr-glyph")).toBeNull();
    });

    it("does not render on fine pointers or on ghost rows", () => {
      renderRowWithIcons(makeWindow({ windowId: "@0", index: 0 }));
      expect(screen.queryByTestId("status-rail")).toBeNull();
      cleanup();
      mockCoarsePointer();
      renderGhostRow(makeGhostWindow());
      expect(screen.queryByTestId("status-rail")).toBeNull();
    });

    it("deepens to the selected-tint variant on the selected row (derived from the tint system, no new token)", () => {
      mockCoarsePointer();
      const rowTints = computeRowTints(DEFAULT_DARK_THEME.palette, deriveUIColors(DEFAULT_DARK_THEME.palette, "dark").bgChrome);
      const win = makeWindow({ windowId: "@0", index: 0, name: "sel", color: "orange" });
      const props = {
        win,
        session: "alpha",
        isDragOver: false,
        color: "orange",
        rowTints,
        editingWindow: null,
        editingName: "",
        inputRef: { current: null },
        onSelectWindow: noop,
        onStartEditing: noop,
        onWindowNameChange: noop,
        onRenameKeyDown: noop as React.KeyboardEventHandler<HTMLInputElement>,
        onRenameBlur: noop,
        onKillClick: noop,
        server: "srv",
      };
      const { unmount } = render(<WindowRow {...props} isSelected={true} />);
      // Selected: the inset base mixed with the row's own selected tint.
      expect(screen.getByTestId("status-rail").style.backgroundColor).toContain(
        "color-mix(in srgb, var(--color-bg-inset)",
      );
      unmount();
      // Unselected: the plain bg-inset band (class only, no inline mix).
      render(<WindowRow {...props} isSelected={false} />);
      const rail = screen.getByTestId("status-rail");
      expect(rail.style.backgroundColor).toBe("");
      expect(rail.className).toContain("bg-bg-inset");
    });

    it("reserves coarse right padding on the row button so the name truncates before the rail (ghost rows excepted)", () => {
      const win = makeWindow({ windowId: "@0", index: 0, name: "my-shell" });
      renderCoarseRow(win);
      const button = screen.getByRole("treeitem").querySelector("button")!;
      expect(button.className).toContain("coarse:pr-[56px]");
      cleanup();
      mockCoarsePointer();
      const { container } = renderGhostRow(makeGhostWindow());
      const ghostButton = container.querySelector("button")!;
      expect(ghostButton.className).not.toContain("coarse:pr-[56px]");
    });

    it("pointerdown on the rail opens the card (primary target); the tap never selects the row and release keeps the card", () => {
      const onSelectWindow = vi.fn();
      renderCoarseRow(makeWindow({ windowId: "@0", index: 0, name: "my-shell" }), { onSelectWindow });
      const rail = screen.getByTestId("status-rail");
      act(() => {
        fireEvent.pointerDown(rail, { pointerId: 1, pointerType: "touch" });
      });
      expect(screen.getByTestId("row-flyout-card")).toBeInTheDocument();
      expect(onSelectWindow).not.toHaveBeenCalled();
      act(() => {
        fireEvent.pointerUp(rail, { pointerId: 1, pointerType: "touch" });
        fireEvent.click(rail);
      });
      expect(onSelectWindow).not.toHaveBeenCalled();
      expect(screen.getByTestId("row-flyout-card")).toBeInTheDocument();
    });

    it("a scrub started on the rail retargets the single-open card across rows (shared handlers/registry)", () => {
      mockCoarsePointer();
      const rowProps = {
        session: "alpha",
        isSelected: false,
        isDragOver: false,
        editingWindow: null,
        editingName: "",
        inputRef: { current: null },
        onSelectWindow: noop,
        onStartEditing: noop,
        onWindowNameChange: noop,
        onRenameKeyDown: noop as React.KeyboardEventHandler<HTMLInputElement>,
        onRenameBlur: noop,
        onKillClick: noop,
        server: "srv",
      };
      render(
        <>
          <WindowRow {...rowProps} win={makeWindow({ windowId: "@1", index: 0, name: "win-a" })} />
          <WindowRow {...rowProps} win={makeWindow({ windowId: "@2", index: 1, name: "win-b" })} />
        </>,
      );
      const rows = screen.getAllByRole("treeitem");
      const railA = rows[0].querySelector('[data-testid="status-rail"]')!;
      act(() => {
        fireEvent.pointerDown(railA, { pointerId: 1, pointerType: "touch" });
      });
      expect(screen.getByTestId("row-flyout-card")).toHaveTextContent("Tab @1");

      // jsdom has no elementFromPoint — stub the scrub's hit-test seam.
      const elFromPoint = vi.fn();
      (document as Document & { elementFromPoint?: unknown }).elementFromPoint = elFromPoint;
      try {
        elFromPoint.mockReturnValue(rows[1].querySelector("button"));
        act(() => {
          fireEvent.pointerMove(railA, { pointerId: 1, clientX: 5, clientY: 5 });
        });
        expect(screen.getAllByTestId("row-flyout-card")).toHaveLength(1);
        expect(screen.getByTestId("row-flyout-card")).toHaveTextContent("Tab @2");
        act(() => {
          fireEvent.pointerUp(railA, { pointerId: 1, pointerType: "touch" });
        });
        expect(screen.getByTestId("row-flyout-card")).toHaveTextContent("Tab @2");
      } finally {
        delete (document as { elementFromPoint?: unknown }).elementFromPoint;
      }
    });

    it("both scrub ends resolve rows via the shared '[data-rail-row]' selector (260817-ve5m)", () => {
      const closestSpy = vi.spyOn(Element.prototype, "closest");
      try {
        renderCoarseRow(makeWindow({ windowId: "@0", index: 0, name: "my-shell" }));
        act(() => {
          fireEvent.pointerDown(screen.getByTestId("status-rail"), { pointerId: 1, pointerType: "touch" });
        });
        // The start handler resolves via the ONE shared attribute selector —
        // identical to `scrubTargetAt`'s — covering all three tier DOM shapes
        // (window treeitem, session treeitem, non-treeitem server header).
        expect(closestSpy).toHaveBeenCalledWith("[data-rail-row]");
        const calls = closestSpy.mock.calls.filter(
          ([sel]) => typeof sel === "string" && sel.includes("rail-row"),
        );
        for (const [sel] of calls) {
          expect(sel).toBe("[data-rail-row]");
        }
        // The row root carries the attribute (ghost rows don't — they have no
        // rail and a suppressed flyout).
        expect(screen.getByRole("treeitem")).toHaveAttribute("data-rail-row");
      } finally {
        closestSpy.mockRestore();
      }
    });

    // Held-rail highlight (260817-ve5m R8): while the row's card is open its
    // rail lightens (band a shade up + brightened seam); at rest the plain
    // band. Keyed on the row-local flyout open state.
    it("lightens the rail (band + seam) only while the row's card is open", () => {
      renderCoarseRow(makeWindow({ windowId: "@0", index: 0, name: "my-shell" }));
      const rail = screen.getByTestId("status-rail");
      // At rest: the plain bg-inset band (class only, no inline mix/seam).
      expect(rail.style.backgroundColor).toBe("");
      expect(rail.style.borderColor).toBe("");
      act(() => {
        fireEvent.pointerDown(rail, { pointerId: 1, pointerType: "touch" });
      });
      expect(screen.getByTestId("row-flyout-card")).toBeInTheDocument();
      // Held: one shade up (a deeper mix share of the hover shade) + a
      // brightened seam — derived from existing tokens, no new ones.
      expect(rail.style.backgroundColor).toContain("color-mix(in srgb, var(--color-bg-inset) 40%");
      expect(rail.style.borderColor).toBe("var(--color-text-secondary)");
      // Release keeps the card open (and thus the held rail); dismissal via
      // Escape returns the rail to rest.
      act(() => {
        fireEvent.pointerUp(rail, { pointerId: 1, pointerType: "touch" });
      });
      expect(rail.style.backgroundColor).toContain("color-mix");
      act(() => {
        fireEvent.keyDown(document, { key: "Escape" });
      });
      expect(screen.queryByTestId("row-flyout-card")).toBeNull();
      expect(rail.style.backgroundColor).toBe("");
      expect(rail.style.borderColor).toBe("");
    });
  });

  // The display-only marker track scales on coarse pointers; the rail remains
  // the only coarse card target.
  describe("coarse marker well and card handoff", () => {
    /** Coarse + dark-scheme stub — the Label picker (SwatchPopover → useTheme)
     *  needs the color-scheme query answered too. */
    function mockCoarseDark() {
      vi.stubGlobal(
        "matchMedia",
        vi.fn().mockImplementation((q: string) => ({
          matches: ["(pointer: coarse)", "(any-pointer: coarse)"].includes(q) || q === "(prefers-color-scheme: dark)",
          media: q,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          onchange: null,
        })),
      );
    }

    function renderCoarseAxis(win: WindowInfo, extra: Partial<React.ComponentProps<typeof WindowRow>> = {}) {
      mockCoarseDark();
      return render(
        <ThemeProvider>
          <WindowRow
            win={win}
            session="alpha"
            isSelected={false}
            isDragOver={false}
            color={win.color}
            marker={win.marker}
            editingWindow={null}
            editingName=""
            inputRef={{ current: null }}
            onSelectWindow={noop}
            onStartEditing={noop}
            onWindowNameChange={noop}
            onRenameKeyDown={noop as React.KeyboardEventHandler<HTMLInputElement>}
            onRenameBlur={noop}
            onKillClick={noop}
            onColorChange={noop}
            onMarkerChange={noop}
            onFlairChange={noop}
            rowTints={computeRowTints(DEFAULT_DARK_THEME.palette, deriveUIColors(DEFAULT_DARK_THEME.palette, "dark").bgChrome)}
            rowBorders={computeRowBorders(DEFAULT_DARK_THEME.palette, DEFAULT_DARK_THEME.category)}
            server="srv"
            {...extra}
          />
        </ThemeProvider>,
      );
    }

    it("scales marker track, fill, strip, and content geometry on coarse pointers", () => {
      const win = makeWindow({ windowId: "@0", index: 0, name: "my-shell", marker: "blocked:2", color: "orange" });
      renderCoarseAxis(win);
      expect(screen.queryByLabelText("Set tab label")).toBeNull();
      const row = screen.getByRole("treeitem");
      const well = screen.getByTestId("marker-well");
      expect(well.className).toContain("left-0");
      expect(well.style.width).toBe("36px");
      expect(screen.getByTestId("marker-fill").style.width).toBe("24px");
      expect(screen.getByTestId("marker-strip").style.width).toBe("36px");
      expect(row.querySelector(".rk-hazard")).toBeTruthy();
      const button = row.querySelector("button")!;
      expect(button.className).toContain("pl-[30px]");
      expect(button.className).toContain("coarse:pl-[44px]");
      expect(screen.getByTestId("status-dot-tap").className).toBe("flex items-center shrink-0");
    });

    it("scales stage-three chevrons with the coarse track", () => {
      renderCoarseAxis(makeWindow({ marker: "auto:3" }));
      const fill = screen.getByTestId("marker-fill");
      expect(fill.style.width).toBe("36px");
      const svg = fill.querySelector("svg")!;
      expect(Number(svg.getAttribute("width"))).toBeGreaterThan(22);
      expect(fill.querySelectorAll("path")).toHaveLength(3);
    });

    it("closes the pad on a second coarse tap", () => {
      const onMarkerChange = vi.fn();
      renderCoarseAxis(makeWindow({ marker: "manual:1" }), { onMarkerChange });
      const strip = screen.getByTestId("marker-strip");
      fireEvent.pointerDown(strip, {
        pointerId: 1,
        pointerType: "touch",
        clientX: 4,
        clientY: 10,
      });
      expect(screen.getByTestId("marker-pad")).toBeInTheDocument();
      fireEvent.pointerDown(strip, {
        pointerId: 2,
        pointerType: "touch",
        clientX: 4,
        clientY: 10,
      });
      expect(screen.queryByTestId("marker-pad")).toBeNull();
      expect(onMarkerChange).not.toHaveBeenCalled();
    });

    it("opens click-menu mode on coarse without capture or drag preview", () => {
      const onMarkerChange = vi.fn();
      renderCoarseAxis(makeWindow({ marker: "manual:1" }), { onMarkerChange });
      const strip = screen.getByTestId("marker-strip");
      const setPointerCapture = vi.fn();
      strip.setPointerCapture = setPointerCapture;
      fireEvent.pointerDown(strip, {
        pointerId: 1,
        pointerType: "touch",
        clientX: 4,
        clientY: 10,
      });
      expect(screen.getByTestId("marker-pad-mode-label-manual").style.color).toBe(
        "var(--color-marker-ink)",
      );
      expect(screen.getByTestId("marker-pad-stage-heading-1").style.color).toBe(
        "var(--color-marker-ink)",
      );
      fireEvent.pointerMove(strip, {
        pointerId: 1,
        pointerType: "touch",
        clientX: 100,
        clientY: 100,
      });
      expect(screen.getByTestId("marker-pad-cell-manual-1")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(setPointerCapture).not.toHaveBeenCalled();
      expect(onMarkerChange).not.toHaveBeenCalled();
    });

    it("the window card's FIRST action row is Change color…, closing the card and opening the label picker (never selecting the row)", () => {
      const onSelectWindow = vi.fn();
      renderCoarseAxis(makeWindow({ windowId: "@0", index: 0, name: "my-shell" }), { onSelectWindow });
      act(() => {
        fireEvent.pointerDown(screen.getByTestId("status-rail"), { pointerId: 1, pointerType: "touch" });
      });
      const card = screen.getByTestId("row-flyout-card");
      // Row order: Change color… → Pin → Kill (no fork — no agent provider).
      const color = screen.getByTestId("row-flyout-color-action");
      expect(color).toHaveTextContent("Change color…");
      const pin = screen.getByTestId("row-flyout-pin-action");
      const kill = screen.getByTestId("row-flyout-kill-action");
      expect(card.querySelector('[data-testid="row-flyout-actions"]')).toContainElement(color);
      expect(color.compareDocumentPosition(pin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(pin.compareDocumentPosition(kill) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // Close-then-open handoff: the card closes, the row's combined Label
      // picker opens, and the row was never selected.
      act(() => {
        fireEvent.click(color);
      });
      expect(screen.queryByTestId("row-flyout-card")).toBeNull();
      expect(screen.getByRole("listbox", { name: "Label picker" })).toBeInTheDocument();
      expect(onSelectWindow).not.toHaveBeenCalled();
      // Popover-over-card precedence: while the picker is open the card's
      // suppressed gate inhibits re-opening.
      act(() => {
        fireEvent.pointerDown(screen.getByTestId("status-rail"), { pointerId: 2, pointerType: "touch" });
      });
      expect(screen.queryByTestId("row-flyout-card")).toBeNull();
    });
  });
});

describe("Watched underbar (the dot carries the flag)", () => {
  // Watched-by-operator renders as the StatusDot's additive underbar overlay:
  // rendered only for non-ghost windows on the operator's watchlist, dimmed
  // AND dashed while the owning session's operator loop is stale.
  beforeEach(() => {
    mockMatchMedia();
  });

  function renderRowWithStaleness(win: WindowInfo, operatorStale?: boolean) {
    return render(
      <WindowRow
        win={win}
        session="alpha"
        operatorStale={operatorStale}
        isSelected={false}
        isDragOver={false}
        editingWindow={null}
        editingName=""
        inputRef={{ current: null }}
        onSelectWindow={noop}
        onStartEditing={noop}
        onWindowNameChange={noop}
        onRenameKeyDown={noop as React.KeyboardEventHandler<HTMLInputElement>}
        onRenameBlur={noop}
        onKillClick={noop}
        onDragStart={noopDrag}
        onDragOver={noopDrag}
        onDrop={noopDrag}
        onDragEnd={noop}
      />,
    );
  }

  function dotInRow(): HTMLElement {
    return screen.getByTestId("status-dot-tap").querySelector("[role='img']")!;
  }

  it("renders the underbar on the StatusDot when win.monitored is true, and the label ends with '— watched'", () => {
    renderRowWithStaleness(makeWindow({ monitored: true, monitoredStage: "apply" }));
    expect(screen.getByTestId("status-dot-watched-bar")).toBeInTheDocument();
    expect(dotInRow().getAttribute("aria-label")).toMatch(/— watched$/);
    // The retired glyph surface is gone.
    expect(screen.queryByTestId("row-watched-indicator")).toBeNull();
  });

  it("renders no bar (zero extra DOM) when win.monitored is false or absent, and the label is unchanged", () => {
    renderRowWithStaleness(makeWindow({}));
    expect(screen.queryByTestId("status-dot-watched-bar")).toBeNull();
    expect(dotInRow().getAttribute("aria-label")).not.toContain("watched");

    cleanup();
    renderRowWithStaleness(makeWindow({ monitored: false }));
    expect(screen.queryByTestId("status-dot-watched-bar")).toBeNull();
  });

  it("renders no bar for an owner-only window — owner carries no dot semantics", () => {
    renderRowWithStaleness(makeWindow({ owner: "operator" }), true);
    expect(screen.queryByTestId("status-dot-watched-bar")).toBeNull();
    expect(dotInRow().getAttribute("aria-label")).not.toContain("watched");
  });

  it("renders no bar on ghost rows even when monitored is set", () => {
    renderGhostRow(makeGhostWindow({ monitored: true }));
    expect(screen.queryByTestId("status-dot-watched-bar")).toBeNull();
  });

  it("stale prop ⇒ dashed + dimmed bar with data-stale, and the label ends with '— watched (operator stale)'", () => {
    renderRowWithStaleness(makeWindow({ monitored: true }), true);
    const bar = screen.getByTestId("status-dot-watched-bar");
    expect(bar.className).toContain("rk-watched-underbar-stale");
    expect(bar.className).toContain("opacity-50");
    expect(bar.getAttribute("data-stale")).toBe("true");
    expect(dotInRow().getAttribute("aria-label")).toMatch(/— watched \(operator stale\)$/);

    cleanup();
    renderRowWithStaleness(makeWindow({ monitored: true }), false);
    expect(screen.getByTestId("status-dot-watched-bar").className).not.toContain("opacity-50");
  });
});
