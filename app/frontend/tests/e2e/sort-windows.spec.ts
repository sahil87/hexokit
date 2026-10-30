import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { gotoWindow, openPalette, resolveWindow } from "./_ready";
import { TMUX_SERVER, createSession, killSession } from "./_tmux";

/**
 * The `Group: Sort tabs…` command-palette action and its option-picker
 * sub-step — the one-shot session-scoped reorder verb
 * (POST /api/sessions/{session}/sort-windows with an ordered key array).
 * Exercises the full real-tmux loop: palette → sub-step key pick → API →
 * tmux move-window batch → SSE derive tick → sidebar order.
 *
 * Shared setup: real tmux — the _tmux.ts fixture creates a detached session
 * `e2e-sort-<epoch>` on the isolated e2e server with three windows in
 * creation order, torn down in afterAll. One random alphanumeric TAG per run
 * is embedded in every window name (`mid-<tag>`, `zed-<tag>`, `alpha-<tag>`):
 * the sidebar-order readout filters rows by it, so rows from other specs on
 * the shared e2e server can never pollute the assertion — and alphabetical
 * name order differs from creation order, so a name-sorted readout can never
 * pass as created order. No route mocks — the app talks to the real dev
 * server and the real isolated tmux server; assertions poll tmux-side truth
 * (list-windows) AND the sidebar row order. openSortPicker(page) opens the
 * palette via `openPalette`, selects `Group: Sort tabs…`, and waits for the
 * picker sub-step (`Pick sort keys — Space toggle · Enter apply`
 * placeholder). pickSortKeys(page, labels) clicks each named option row
 * (toggles it on in click order = priority order), then presses Enter to
 * apply. setWaiting(name) sets a window's pane option @rk_pane_agent_state
 * to `waiting:<epoch>:<pid>` — the 3-segment form carrying the pane's own
 * live pid (a 2-segment value on a shell pane would be reconciled away);
 * clearAgentState(name) removes it in `finally` so tests stay independent.
 * swapWindows(a, b) scrambles order with `tmux swap-window` on exact-match
 * session-qualified targets (=session:=name). waitForSessionVisible(page)
 * waits until the spec's session renders in the sidebar — the palette
 * entry's current-session gate is the snapshot-derived sessionName, which
 * needs the SSE session list to have landed.
 */

const SESSION = `e2e-sort-${Date.now()}`;
// One random alphanumeric token per run, embedded in every window name: the
// sidebar-order readout filters rows by it, so rows from other specs on the
// shared e2e server can never pollute the assertion.
const TAG = `rk${randomBytes(5).toString("hex")}`;
// Windows are created in this order, so window IDs ascend with creation —
// and alphabetical order of the names differs from it, so a name-sorted
// readout can never pass as created order.
const NAMES = [`mid-${TAG}`, `zed-${TAG}`, `alpha-${TAG}`] as const;

function tmux(args: string[]): string {
  return execFileSync("tmux", ["-L", TMUX_SERVER, ...args]).toString();
}

/** tmux-side window order for this spec's session (index order). */
function tmuxWindowOrder(): string[] {
  const out = tmux([
    "list-windows",
    "-t",
    `=${SESSION}`,
    "-F",
    "#{window_name}",
  ]).trim();
  return out ? out.split("\n") : [];
}

/** Swap two windows by name (exact-match, session-qualified targets). */
function swapWindows(nameA: string, nameB: string): void {
  tmux([
    "swap-window",
    "-s",
    `=${SESSION}:=${nameA}`,
    "-t",
    `=${SESSION}:=${nameB}`,
  ]);
}

/** Mark one window's pane waiting (3-segment value carrying the pane's own
 *  live pid — a 2-segment value on a shell pane is reconciled away). */
function setWaiting(name: string): void {
  const pid = tmux([
    "list-panes",
    "-t",
    `=${SESSION}:=${name}`,
    "-F",
    "#{pane_pid}",
  ]).trim();
  tmux([
    "set-option",
    "-p",
    "-t",
    `=${SESSION}:=${name}`,
    "@rk_pane_agent_state",
    `waiting:${Math.floor(Date.now() / 1000)}:${pid}`,
  ]);
}

/** Clear a window's agent-state option. */
function clearAgentState(name: string): void {
  tmux(["set-option", "-p", "-u", "-t", `=${SESSION}:=${name}`, "@rk_pane_agent_state"]);
}

/** This spec's sidebar window rows, in display order (raw read; callers poll). */
function sidebarWindowOrder(page: Page): Promise<string[]> {
  const sidebar = page.locator("nav[aria-label='Groups']");
  return sidebar.evaluate(
    (el, tag) => {
      const rows = el.querySelectorAll("[data-window-id] button");
      return Array.from(rows)
        .map((b) => (b.textContent ?? "").trim())
        .filter((text) => text.includes(tag));
    },
    TAG,
  );
}

/** Open the palette and select `Group: Sort tabs…` — leaves the picker
 *  sub-step active. */
async function openSortPicker(page: Page): Promise<void> {
  const paletteInput = await openPalette(page);
  await paletteInput.fill("Group: Sort tabs");
  await page.keyboard.press("Enter");
  await expect(
    page.getByPlaceholder("Pick sort keys — Space toggle · Enter apply"),
  ).toBeVisible({ timeout: 5_000 });
}

/** In the picker sub-step: toggle each named option row (Space), then Enter. */
async function pickSortKeys(page: Page, labels: string[]): Promise<void> {
  for (const label of labels) {
    await page.getByRole("option", { name: label }).click();
  }
  await page.keyboard.press("Enter");
}

/** Wait until the app shows this spec's session in the sidebar — the current-
 *  session gate for the palette sort entry is the snapshot-derived
 *  sessionName, which needs the SSE session list to have landed. */
async function waitForSessionVisible(page: Page): Promise<void> {
  const sidebar = page.locator("nav[aria-label='Groups']");
  await expect(sidebar.locator(`text=${TAG}`).first()).toBeVisible({ timeout: 10_000 });
}

async function gotoSessionWindow(page: Page, name: string): Promise<void> {
  const win = await resolveWindow(page, TMUX_SERVER, SESSION, name);
  await gotoWindow(page, TMUX_SERVER, win.windowId);
  await waitForSessionVisible(page);
}

test.describe("Group: Sort windows", () => {
  test.beforeAll(() => {
    createSession(SESSION, { windows: [...NAMES] });
  });

  test.afterAll(() => {
    killSession(SESSION);
  });

  /**
   * Proves: after physically scrambling the window order, picking the
   * `By created` key in the sort sub-step restores the ascending @N
   * (creation) order — in tmux itself and in the sidebar.
   *
   * Steps:
   * 1. Navigate to the first window's terminal route and wait for the
   *    session to render in the sidebar (the current-session gate).
   * 2. swap-window the first and last windows; assert the tmux-side order
   *    reads [alpha, zed, mid] (the scramble landed).
   * 3. Open the sort picker and apply with only `By created` toggled.
   * 4. Poll list-windows until the order returns to creation order
   *    [mid, zed, alpha].
   * 5. Poll the sidebar's window rows (filtered by TAG) until they show the
   *    same creation order (the reorder arrived via SSE).
   */
  test("sort by created restores ascending @N order after a scramble", async ({ page }) => {
    await gotoSessionWindow(page, NAMES[0]);

    // Scramble out of @N order: swap the first and last windows.
    swapWindows(NAMES[0], NAMES[2]);
    expect(tmuxWindowOrder()).toEqual([NAMES[2], NAMES[1], NAMES[0]]);

    await openSortPicker(page);
    await pickSortKeys(page, ["By created"]);

    // The physical reorder flows back through the SSE derive tick.
    await expect.poll(tmuxWindowOrder).toEqual([...NAMES]);
    await expect.poll(() => sidebarWindowOrder(page)).toEqual([...NAMES]);
  });

  /**
   * Proves: a window whose pane carries a live `waiting` agent state
   * outranks plain windows — after applying `By status` it sits at the top
   * of the session, in tmux and in the sidebar.
   *
   * Steps:
   * 1. Mark the last window's pane waiting (3-segment @rk_pane_agent_state
   *    carrying the pane's own live pid).
   * 2. Navigate to the first window's terminal route and wait for the
   *    session to render in the sidebar.
   * 3. Open the sort picker and apply with only `By status` toggled.
   * 4. Poll list-windows until the waiting window is first:
   *    [alpha, mid, zed] (the two plain windows keep their relative order —
   *    stable sort).
   * 5. Poll the sidebar's window rows until they show the same order.
   * 6. Clear the agent-state option (finally — later tests start plain).
   */
  test("sort by status puts a waiting window first", async ({ page }) => {
    setWaiting(NAMES[2]);
    try {
      await gotoSessionWindow(page, NAMES[0]);

      await openSortPicker(page);
      await pickSortKeys(page, ["By status"]);

      // Stable sort: the waiting window lands first; the two plain windows keep
      // their relative order.
      await expect
        .poll(tmuxWindowOrder)
        .toEqual([NAMES[2], NAMES[0], NAMES[1]]);
      await expect
        .poll(() => sidebarWindowOrder(page))
        .toEqual([NAMES[2], NAMES[0], NAMES[1]]);
    } finally {
      clearAgentState(NAMES[2]);
    }
  });

  /**
   * Proves: composite ordering walks the key list — `status` is primary,
   * `name` breaks the tie within equal ranks — and the `name` key is
   * case-insensitive (`alpha` precedes `mid`, not ASCII-ordinal).
   *
   * Steps:
   * 1. Mark the middle window's pane waiting (`zed-<tag>`).
   * 2. Navigate to the first window's terminal route and wait for the
   *    session to render in the sidebar.
   * 3. Open the sort picker and apply with `By status` then `By name`
   *    toggled (selection order = priority).
   * 4. Poll list-windows until the order is [zed, alpha, mid] — the waiting
   *    window first, then the two plain windows ordered by case-insensitive
   *    name.
   * 5. Poll the sidebar's window rows until they show the same order.
   * 6. Clear the agent-state option (finally).
   */
  test("composite status+name orders idle ties case-insensitively", async ({ page }) => {
    setWaiting(NAMES[1]);
    try {
      await gotoSessionWindow(page, NAMES[0]);

      await openSortPicker(page);
      await pickSortKeys(page, ["By status", "By name"]);

      // zed is waiting (rank 0) → first. mid and alpha are both plain (rank 4);
      // the name tie-break is case-insensitive, so alpha precedes mid.
      await expect
        .poll(tmuxWindowOrder)
        .toEqual([NAMES[1], NAMES[2], NAMES[0]]);
      await expect
        .poll(() => sidebarWindowOrder(page))
        .toEqual([NAMES[1], NAMES[2], NAMES[0]]);
    } finally {
      clearAgentState(NAMES[1]);
    }
  });

  /**
   * Proves: bailing out of the sub-step fires no POST and changes nothing —
   * the cancel seam of the picker matches the confirm sub-step's.
   *
   * Steps:
   * 1. Navigate to the first window's terminal route, wait for the session
   *    in the sidebar, and record the current tmux-side window order.
   * 2. Open the sort picker, toggle `By created` on, then press Escape.
   * 3. Assert the palette overlay is gone.
   * 4. Assert the tmux-side order is byte-identical to the recorded order
   *    (no POST, no mutation).
   */
  test("Esc during the picker cancels with no reorder", async ({ page }) => {
    await gotoSessionWindow(page, NAMES[0]);
    const before = tmuxWindowOrder();

    await openSortPicker(page);
    // Toggle a key, then bail: no POST fires and tmux order is untouched.
    await page.getByRole("option", { name: "By created" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("palette-overlay")).not.toBeVisible();

    expect(tmuxWindowOrder()).toEqual(before);
  });
});
