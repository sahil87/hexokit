import { test, expect, type Page } from "@playwright/test";
import { openPalette } from "./_ready";
import { stubFabConfig } from "./_fab-config-stub";

/**
 * Settings dialog — the curated Agents tab over fab-kit's machine-wide config.
 * The tab reads and writes only through `/api/fab-config`, so these tests stub
 * that one endpoint at the browser with the stateful `_fab-config-stub` helper,
 * so no run can ever write the developer's real `~/.fab-kit/config.yaml`.
 *
 * Shared setup: every test installs the stub BEFORE navigating to `/` (the
 * Settings dialog is mounted once at AppLayout, so the host page is enough — no
 * tmux session is needed) and opens the dialog through the palette's
 * `Settings: Agents` entry. The phone test runs at 375px.
 */

async function openAgentsTab(page: Page) {
  await page.goto("/");
  const palette = await openPalette(page);
  await palette.fill("Settings: Agents");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("tab", { name: "Agents" })).toHaveAttribute("aria-selected", "true");
}

test.describe("Settings dialog — Agents tab", () => {
  /**
   * Proves: the palette's `Settings: Agents` entry opens the dialog on the new
   * tab, the rail reads General, Appearance, Agents, Shortcuts, All settings,
   * and the tab renders both scope groups plus the per-role table.
   *
   * Steps:
   * 1. Stub `/api/fab-config`, load `/`, open the palette and run
   *    `Settings: Agents`.
   * 2. Assert the dialog is open with Agents selected.
   * 3. Assert the rail's tab order.
   * 4. Assert the Agents and Dispatch groups and the six role rows.
   */
  test("palette deep-links the Agents tab with the documented rail order", async ({ page }) => {
    await stubFabConfig(page);
    await openAgentsTab(page);

    const tabs = page.getByRole("tablist", { name: "Settings sections" }).getByRole("tab");
    await expect(tabs).toHaveText(["General", "Appearance", "Agents", "Shortcuts", "All settings"]);
    await expect(page.getByRole("region", { name: "Agent providers" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Dispatch" })).toBeVisible();
    await expect(page.getByTestId(/^role-row-/)).toHaveCount(6);
  });

  /**
   * Proves: choosing a worker provider writes it through `/api/fab-config`, the
   * row re-renders from the response with a system provenance chip and a reset
   * link, and reset returns it to the default (chip back to `default`, reset
   * link gone).
   *
   * Steps:
   * 1. Open the Agents tab; the worker row shows `default` and no reset link.
   * 2. Click the `codex` chip.
   * 3. Assert the POST body is `{"agent.workers": "codex"}`, `codex` is
   *    latched, the chip reads `system` and a reset link appears.
   * 4. Click reset; assert the POST body is `{"agent.workers": null}` and the
   *    row is back to `default` with `claude` latched.
   */
  test("setting and resetting the worker agent round-trips through the API", async ({ page }) => {
    const posts = await stubFabConfig(page);
    await openAgentsTab(page);

    const row = page.getByTestId("fab-row-agent.workers");
    await expect(row.getByTestId("provenance-chip")).toHaveText("default");
    await expect(row.getByRole("button", { name: "Reset agent.workers" })).toHaveCount(0);

    await row.getByRole("button", { name: "codex" }).click();
    await expect(row.getByRole("button", { name: "codex" })).toHaveAttribute("aria-pressed", "true");
    await expect(row.getByTestId("provenance-chip")).toHaveText("system");
    expect(posts).toEqual([{ "agent.workers": "codex" }]);

    await row.getByRole("button", { name: "Reset agent.workers" }).click();
    await expect(row.getByTestId("provenance-chip")).toHaveText("default");
    await expect(row.getByRole("button", { name: "claude" })).toHaveAttribute("aria-pressed", "true");
    expect(posts[1]).toEqual({ "agent.workers": null });
  });

  /**
   * Proves: a role's inherited cells read as dimmed `↳` values, an override
   * replaces them, and the role's reset clears all three leaves in one request.
   *
   * Steps:
   * 1. Open the Agents tab; assert `doing`'s effort select offers `↳ …` first.
   * 2. Pick `high` for `doing`'s effort; assert the POST and the new value.
   * 3. Click the row's reset; assert one POST nulling provider, model and effort.
   */
  test("per-role override shows inherited cells and resets all three leaves", async ({ page }) => {
    const posts = await stubFabConfig(page);
    await openAgentsTab(page);

    const effort = page.getByLabel("doing effort");
    await expect(effort.locator("option").first()).toHaveText("↳ provider default");

    await effort.selectOption("high");
    await expect(effort).toHaveValue("high");
    expect(posts).toEqual([{ "agent.profiles.doing.effort": "high" }]);

    await page.getByRole("button", { name: "Reset doing overrides" }).click();
    await expect(effort).toHaveValue("");
    expect(posts[1]).toEqual({
      "agent.profiles.doing.provider": null,
      "agent.profiles.doing.model": null,
      "agent.profiles.doing.effort": null,
    });
  });

  /**
   * Proves: with fab absent the tab shows the graceful empty state and nothing
   * else — no controls, no error alert.
   *
   * Steps:
   * 1. Stub the endpoint as `{installed: false}`; open the Agents tab.
   * 2. Assert the empty-state message and that neither the provider controls nor an
   error alert render inside the dialog.
   */
  test("shows the not-installed empty state", async ({ page }) => {
    await stubFabConfig(page, { installed: false });
    await openAgentsTab(page);

    await expect(page.getByTestId("fab-not-installed")).toContainText("fab isn't installed on this host");
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog.getByRole("region", { name: "Agent providers" })).toHaveCount(0);
    await expect(dialog.getByRole("alert")).toHaveCount(0);
  });

  /**
   * Proves: at 375px the tab fits — the dialog's page never scrolls
   * horizontally and the role table scrolls inside its own wrapper.
   *
   * Steps:
   * 1. Set a 375×812 viewport, open the Agents tab.
   * 2. Assert the document has no horizontal overflow.
   * 3. Assert the role table wrapper scrolls horizontally (its scrollWidth
   *    exceeds its clientWidth).
   */
  test("phone width keeps the role table scrolling inside its wrapper", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await stubFabConfig(page);
    await openAgentsTab(page);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const wrap = page.getByTestId("role-table-wrap");
    await wrap.scrollIntoViewIfNeeded();
    const scrolls = await wrap.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(scrolls).toBe(true);
  });
});
