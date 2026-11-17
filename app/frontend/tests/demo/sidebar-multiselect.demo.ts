/**
 * Demo: sidebar multi-select as an extension of single select, recorded for
 * PR evidence.
 *
 * Runs only under `just demo sidebar-multiselect` against the throwaway e2e
 * rig. Desktop only: the Cmd/Ctrl-click and Shift-click gestures are
 * fine-pointer gestures.
 *
 * Shared setup: beforeAll seeds one session with five windows on the rig's
 * isolated tmux server; afterAll kills it. The flow opens `alpha`, Cmd-clicks
 * `bravo` and `delta`, Shift-clicks `echo`, Cmd-clicks the open window out of
 * the set, then clears with Escape. The flow asserts nothing about the
 * selection itself so the same spec records the `--before` base for
 * comparison (where the set is outlined by a ring and excludes the open tab).
 */
import { test, expect, beat, desktopOnly } from "./_demo";
import { gotoWindow, resolveWindow, READY_TIMEOUT } from "../e2e/_ready";
import { TMUX_SERVER, createSession, killSession } from "../e2e/_tmux";

const DEMO_SESSION = "demo-multiselect";
const WINDOWS = ["alpha", "bravo", "charlie", "delta", "echo"];

test.describe("sidebar-multiselect demo", () => {
  test.beforeAll(() => {
    createSession(DEMO_SESSION, { windows: WINDOWS });
  });

  test.afterAll(() => {
    killSession(DEMO_SESSION);
  });

  test("open tab seeds the selection; set shares the single-select look", async ({ page }, info) => {
    desktopOnly(info);
    const ids: Record<string, string> = {};
    await page.goto("/");
    for (const name of WINDOWS) {
      ids[name] = (await resolveWindow(page, TMUX_SERVER, DEMO_SESSION, name)).windowId;
    }
    await gotoWindow(page, TMUX_SERVER, ids.alpha);
    const row = (name: string) =>
      page.locator(`[role="tree"] [data-row-key="${TMUX_SERVER}:${ids[name]}"] button`).first();
    await expect(row("alpha")).toBeVisible({ timeout: READY_TIMEOUT });
    await beat(page, 1_500);

    await row("bravo").click({ modifiers: ["ControlOrMeta"] });
    await beat(page);
    await row("delta").click({ modifiers: ["ControlOrMeta"] });
    await beat(page);
    await row("echo").click({ modifiers: ["Shift"] });
    await beat(page, 1_500);

    // The open window leaves the set.
    await row("alpha").click({ modifiers: ["ControlOrMeta"] });
    await beat(page, 1_500);

    await row("echo").focus();
    await page.keyboard.press("Escape");
    await beat(page, 1_500);
  });
});
