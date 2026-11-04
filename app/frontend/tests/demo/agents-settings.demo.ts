/**
 * Demo: the Settings dialog's Agents tab — fab-kit's machine-wide config
 * (default session/worker agent, per-role overrides, dispatch knobs) edited
 * from the dashboard. The recording opens the tab from the command palette,
 * switches the worker agent (provenance chip flips default → system, reset
 * link appears), overrides one role's effort and resets it, and changes the
 * dispatch mode.
 *
 * Runs only under `just demo agents-settings` (playwright.demo.config.ts —
 * testDir ./tests/demo), against the throwaway e2e rig, once per project
 * (desktop 1280x800, mobile 375x812).
 *
 * Shared setup: `/api/fab-config` is stubbed in the browser (the stateful
 * `_fab-config-stub` helper) so the recording never touches the developer's
 * real ~/.fab-kit/config.yaml; the daemon's fab wrapper is covered by its Go
 * tests and a real-fab pass against an isolated HOME. Both projects open the
 * dialog with the palette chord (`Settings: Agents`).
 */
import { test, expect, beat } from "./_demo";
import { openPalette } from "../e2e/_ready";
import { stubFabConfig } from "../e2e/_fab-config-stub";

test.describe("agents-settings demo", () => {
  /**
   * Proves: a reviewer can see the Agents tab edit fab's machine-wide config —
   * worker agent switch with provenance + reset, a per-role override, and the
   * dispatch mode.
   *
   * Steps:
   * 1. Install the stateful `/api/fab-config` stub; load `/`.
   * 2. Open Settings → Agents (palette on desktop, overflow menu on mobile);
   *    `beat()`.
   * 3. Click the `codex` worker chip; assert the system chip + reset link;
   *    `beat()`; reset it; `beat()`.
   * 4. Set `doing`'s effort to `high`, then reset the row; `beat()`.
   * 5. Pick `pane` dispatch mode; `beat()`.
   */
  test("agents tab edits the worker agent, a role override and dispatch mode", async ({ page }) => {
    await stubFabConfig(page, { systemPath: "/home/demo/.fab-kit/config.yaml" });

    await page.goto("/");
    const palette = await openPalette(page);
    await palette.fill("Settings: Agents");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tab", { name: "Agents" })).toHaveAttribute("aria-selected", "true");
    await beat(page);

    const workers = page.getByTestId("fab-row-agent.workers");
    await workers.getByRole("button", { name: "codex" }).click();
    await expect(workers.getByTestId("provenance-chip")).toHaveText("system");
    await expect(workers.getByRole("button", { name: "Reset agent.workers" })).toBeVisible();
    await beat(page);
    await workers.getByRole("button", { name: "Reset agent.workers" }).click();
    await expect(workers.getByTestId("provenance-chip")).toHaveText("default");
    await beat(page);

    const effort = page.getByLabel("doing effort");
    await effort.scrollIntoViewIfNeeded();
    await effort.selectOption("high");
    await expect(effort).toHaveValue("high");
    await beat(page);
    await page.getByRole("button", { name: "Reset doing overrides" }).click();
    await expect(effort).toHaveValue("");
    await beat(page);

    const mode = page.getByTestId("fab-row-dispatch.mode");
    await mode.scrollIntoViewIfNeeded();
    await mode.getByRole("button", { name: "pane" }).click();
    await expect(mode.getByRole("button", { name: "pane" })).toHaveAttribute("aria-pressed", "true");
    await beat(page, 1_500);
  });
});
