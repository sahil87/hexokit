/**
 * Demo: command-palette search ranking, recorded for PR evidence. Results are
 * ordered by match quality (exact category → whole word → word start →
 * acronym → incidental → description-only) instead of registry declaration
 * order; a contiguous-initials query (`tsv`) reaches `Tab: Split Vertical`;
 * and an empty query lists the viewer's most-recently-used actions first.
 *
 * Runs only under `just demo palette-ranking` (playwright.demo.config.ts —
 * testDir ./tests/demo), against the throwaway e2e rig, once per project
 * (desktop 1280x800, mobile 375x812). The `--before` pass runs the same
 * script against the base ref, where results render in declaration order,
 * `tsv` matches nothing, and the empty query is unordered by use — the
 * before/after pair shows exactly those three differences.
 *
 * Shared setup: beforeAll seeds one detached session the page is viewed
 * from (so the Tab: family is registered); afterAll kills it. The MRU
 * segment selects `Theme: Light` and later `Theme: System`, leaving the
 * rig's theme where it started.
 */
import { test, expect, beat } from "./_demo";
import { READY_TIMEOUT, openPalette, resolveWindow } from "../e2e/_ready";
import { TMUX_SERVER, createSession, killSession } from "../e2e/_tmux";

const VIEW_SESSION = `demo-palrank-${process.pid}`;

/** Queries typed one character at a time so the re-ranking is visible. */
const RANKED_QUERIES = ["tab", "kill", "split"];
const ACRONYM_QUERY = "tsv";
const MRU_ACTION = "Theme: Light";
const RESTORE_ACTION = "Theme: System";

test.describe("palette-ranking demo", () => {
  test.beforeAll(() => {
    createSession(VIEW_SESSION);
  });

  test.afterAll(() => {
    killSession(VIEW_SESSION);
  });

  /**
   * Proves: a reviewer can see the palette lead with the strongest match for
   * ordinary queries, admit an initials query, and float recently used
   * actions to the top of the empty list.
   *
   * Steps:
   * 1. Open the session's window and wait for the app; `beat()`.
   * 2. For each of `tab`, `kill`, `split`: open the palette, type the query
   *    character by character, dwell on the result list, Esc.
   * 3. Type `tsv`; dwell (after: `Tab: Split Vertical` leads; before: no
   *    match).
   * 4. Select `Theme: Light`, reopen with an empty query and dwell (after:
   *    it heads the list); then select `Theme: System` to restore.
   */
  test("ranked results, acronym match and MRU-first empty list", async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === "mobile";
    const viewId = (await resolveWindow(page, TMUX_SERVER, VIEW_SESSION, undefined)).windowId;
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(viewId)}`);
    if (isMobile) {
      await expect(page.getByRole("button", { name: "Toggle navigation" })).toBeVisible({ timeout: READY_TIMEOUT });
    } else {
      await expect(page.getByTestId("status-bar").locator("[aria-label='Connected']")).toBeVisible({
        timeout: READY_TIMEOUT,
      });
    }
    await beat(page);

    const list = page.getByRole("listbox", { name: "Commands" });

    for (const query of RANKED_QUERIES) {
      const input = await openPalette(page);
      await input.pressSequentially(query, { delay: 180 });
      await beat(page, 2_200);
      await page.keyboard.press("Escape");
      await beat(page, 400);
    }

    const acronymInput = await openPalette(page);
    await acronymInput.pressSequentially(ACRONYM_QUERY, { delay: 220 });
    await beat(page, 2_200);
    await page.keyboard.press("Escape");
    await beat(page, 400);

    const themeInput = await openPalette(page);
    await themeInput.fill(MRU_ACTION);
    await list.getByRole("option", { name: new RegExp(`^${MRU_ACTION}`) }).click();
    await beat(page, 1_200);
    await openPalette(page);
    await beat(page, 2_500);
    const restoreInput = page.getByPlaceholder("Type a command");
    await restoreInput.fill(RESTORE_ACTION);
    await list.getByRole("option", { name: new RegExp(`^${RESTORE_ACTION}`) }).click();
    await beat(page, 800);
  });
});
