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
   * and the tab renders both scope groups plus the per-role table, with the
   * tool controls labelled "CLI".
   *
   * Steps:
   * 1. Stub `/api/fab-config`, load `/`, open the palette and run
   *    `Settings: Agents`.
   * 2. Assert the dialog is open with Agents selected.
   * 3. Assert the rail's tab order.
   * 4. Assert the Agents and Dispatch groups and the six role rows.
   * 5. Assert the "Session CLI" / "Worker CLI" knobs and the role table's
   *    "CLI" column.
   */
  test("palette deep-links the Agents tab with the documented rail order", async ({ page }) => {
    await stubFabConfig(page);
    await openAgentsTab(page);

    const tabs = page.getByRole("tablist", { name: "Settings sections" }).getByRole("tab");
    await expect(tabs).toHaveText(["General", "Appearance", "Agents", "Shortcuts", "All settings"]);
    await expect(page.getByRole("region", { name: "Agent CLIs" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Dispatch" })).toBeVisible();
    await expect(page.getByTestId(/^role-row-/)).toHaveCount(6);
    await expect(page.getByRole("group", { name: "Session CLI" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Worker CLI" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "CLI" })).toBeVisible();
  });

  /**
   * Proves: choosing a worker CLI writes it through `/api/fab-config`, the
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
  test("setting and resetting the worker CLI round-trips through the API", async ({ page }) => {
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
   * 3. Click the row's reset; assert one POST nulling tool, model and effort.
   */
  test("per-role override shows inherited cells and resets all three leaves", async ({ page }) => {
    const posts = await stubFabConfig(page);
    await openAgentsTab(page);

    const effort = page.getByLabel("doing effort");
    await expect(effort.locator("option").first()).toHaveText("↳ tool default");

    await effort.selectOption("high");
    await expect(effort).toHaveValue("high");
    expect(posts).toEqual([{ "agent.profiles.doing.effort": "high" }]);

    await page.getByRole("button", { name: "Reset doing overrides" }).click();
    await expect(effort).toHaveValue("");
    expect(posts[1]).toEqual({
      "agent.profiles.doing.tool": null,
      "agent.profiles.doing.model": null,
      "agent.profiles.doing.effort": null,
    });
  });

  /**
   * Proves: a saved model never narrows the role's model list — coming back to
   * the tab still offers inherit, every suggestion for the tool, and free
   * entry, with the saved model selected.
   *
   * Steps:
   * 1. Open the Agents tab; pick `claude-sonnet-5-5` in `doing`'s model list.
   * 2. Assert the POST body and the selected value.
   * 3. Switch to the General tab and back, so the panel re-mounts and re-reads
   *    the stub's document.
   * 4. Assert `claude-sonnet-5-5` is still selected and the list reads inherit,
   *    the tool default, both claude suggestions (the labelled default as
   *    `label · id · tool default`), then `Custom…`.
   */
  test("a saved model still lists every suggestion when the tab is reopened", async ({ page }) => {
    const posts = await stubFabConfig(page);
    await openAgentsTab(page);

    const model = page.getByLabel("doing model", { exact: true });
    await model.selectOption("claude-sonnet-5-5");
    await expect(model).toHaveValue("claude-sonnet-5-5");
    expect(posts).toEqual([{ "agent.profiles.doing.model": "claude-sonnet-5-5" }]);

    await page.getByRole("tab", { name: "General" }).click();
    await page.getByRole("tab", { name: "Agents" }).click();

    await expect(model).toHaveValue("claude-sonnet-5-5");
    await expect(model.locator("option")).toHaveText([
      "↳ inherit (tool default)",
      "↳ tool default (claude-sonnet-5-5)",
      "claude-opus-5-5",
      "Claude Sonnet 5.5 · claude-sonnet-5-5 · tool default",
      "Custom…",
    ]);
  });

  /**
   * Proves: a tool with more than 30 models gets a searchable list that opens
   * unfiltered even with a model saved, narrows by label or id while keeping
   * inherit, the tool default and `Custom…`, and commits the filtered pick as
   * that model's id.
   *
   * Steps:
   * 1. Open the Agents tab; switch `doing` to `kimi` (40+ suggestions).
   * 2. Assert the model control is a button, not a native select.
   * 3. Pick a kimi alias from the list so a model is saved, then re-open the
   *    list and assert the filter is empty and every suggestion is listed.
   * 4. Type `k3.1`; assert only the matching suggestion remains beside inherit,
   *    the tool default and `Custom…`, and Enter commits it.
   * 5. Assert the POST sets `agent.profiles.doing.model` to its id.
   */
  test("a tool with many models gets a searchable list that opens unfiltered", async ({ page }) => {
    const posts = await stubFabConfig(page);
    await openAgentsTab(page);

    await page.getByLabel("doing CLI").selectOption("kimi");
    const trigger = page.getByRole("button", { name: "doing model" });
    await expect(trigger).toBeVisible();
    await expect(page.getByLabel("doing model", { exact: true })).toHaveJSProperty("tagName", "BUTTON");

    await trigger.click();
    await page.getByRole("option", { name: "kimi-alias-7" }).click();
    await expect(trigger).toHaveText(/kimi-alias-7/);

    await trigger.click();
    const filter = page.getByRole("combobox", { name: "Search doing models" });
    await expect(filter).toHaveValue("");
    const options = page.getByRole("listbox", { name: "doing models" }).getByRole("option");
    await expect(options).toHaveCount(41 + 3);

    await filter.fill("k3.1");
    await expect(options).toHaveCount(4);
    await expect(options.first()).toContainText("↳ inherit");
    await expect(options.nth(1)).toContainText("↳ tool default");
    await expect(options.nth(2)).toContainText("Kimi K3.1 Pro");
    await expect(options.last()).toHaveText("Custom…");

    await filter.press("Enter");
    await expect(trigger).toHaveText(/Kimi K3\.1 Pro/);
    expect(posts.at(-1)).toEqual({ "agent.profiles.doing.model": "openrouter/moonshotai/kimi-k3.1-pro" });
  });

  /**
   * Proves: a role can ask for its CLI's own default model — the second entry
   * of the model list, labelled with the discovered default — and a row
   * holding that value reads as the tool default after the tab re-reads, with
   * no stale-pin note and the default model's efforts on offer.
   *
   * Steps:
   * 1. Open the Agents tab; switch `review` to `codex`.
   * 2. Assert the model list's second entry is `↳ tool default (gpt-6.1-sol)`
   *    and pick it; assert the POST writes fab's `tool-default` value.
   * 3. Switch to the General tab and back, so the panel re-reads the stub.
   * 4. Assert the model control still shows `↳ tool default (gpt-6.1-sol)`,
   *    no stale-pin note is shown, and the effort list offers `ultra`.
   */
  test("a role can use its CLI's own default model", async ({ page }) => {
    const posts = await stubFabConfig(page);
    await openAgentsTab(page);

    await page.getByLabel("review CLI").selectOption("codex");
    const model = page.getByLabel("review model", { exact: true });
    await expect(model.locator("option").nth(1)).toHaveText("↳ tool default (gpt-6.1-sol)");
    await model.selectOption({ label: "↳ tool default (gpt-6.1-sol)" });
    await expect.poll(() => posts.at(-1)).toEqual({ "agent.profiles.review.model": "tool-default" });

    await page.getByRole("tab", { name: "General" }).click();
    await page.getByRole("tab", { name: "Agents" }).click();

    await expect(model.locator("option:checked")).toHaveText("↳ tool default (gpt-6.1-sol)");
    await expect(page.getByTestId("stale-model-review")).toHaveCount(0);
    await expect(page.getByLabel("review effort").locator("option")).toContainText(["ultra"]);
  });

  /**
   * Proves: switching a role to a tool whose commands carry no `{effort}`
   * clears its effort override in the same request and disables the effort
   * select with an explanatory title; switching back re-enables it.
   *
   * Steps:
   * 1. Open the Agents tab; pick `high` for `review`'s effort.
   * 2. Pick `kimi` as `review`'s tool; assert one POST setting the tool and
   *    nulling model and effort.
   * 3. Assert the effort select is disabled, titled "this tool takes no effort
   *    setting", and back on inherit.
   * 4. Pick `codex`; assert the effort select is enabled again.
   */
  test("a tool without {effort} disables the role's effort select", async ({ page }) => {
    const posts = await stubFabConfig(page);
    await openAgentsTab(page);

    const effort = page.getByLabel("review effort");
    await effort.selectOption("high");
    await expect(effort).toHaveValue("high");

    await page.getByLabel("review CLI").selectOption("kimi");
    await expect(effort).toBeDisabled();
    await expect(effort).toHaveAttribute("title", "this tool takes no effort setting");
    await expect(effort).toHaveValue("");
    expect(posts[1]).toEqual({
      "agent.profiles.review.tool": "kimi",
      "agent.profiles.review.model": null,
      "agent.profiles.review.effort": null,
    });

    await page.getByLabel("review CLI").selectOption("codex");
    await expect(effort).toBeEnabled();
  });

  /**
   * Proves: with fab absent the tab shows the graceful empty state and nothing
   * else — no controls, no error alert.
   *
   * Steps:
   * 1. Stub the endpoint as `{installed: false}`; open the Agents tab.
   * 2. Assert the empty-state message and that neither the CLI controls nor an
   error alert render inside the dialog.
   */
  test("shows the not-installed empty state", async ({ page }) => {
    await stubFabConfig(page, { installed: false });
    await openAgentsTab(page);

    await expect(page.getByTestId("fab-not-installed")).toContainText("fab isn't installed on this host");
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog.getByRole("region", { name: "Agent CLIs" })).toHaveCount(0);
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

test.describe("Settings dialog — Agents tab, agent presets", () => {
  /**
   * Proves: with a fab that lists presets, choosing one through the dropdown
   * writes `agent.preset`, the Customize grid then shows the preset's values
   * as supplied by the preset (a `preset` chip, inherited selects, no reset
   * link), and None clears it again.
   *
   * Steps:
   * 1. Stub `/api/fab-config` with presets (the stub's system tier always
   *    sets the session CLI); open the Agents tab.
   * 2. Assert the Agent preset select reads None and Customize is expanded at
   *    `1 set explicitly` (the session CLI).
   * 3. Choose `codex-workers`; assert the POST body `{"agent.preset":
   *    "codex-workers"}` and the select value.
   * 4. Assert Worker CLI latches `codex` with a `preset` chip titled `preset
   *    codex-workers` and no reset link, a worker role's CLI select reads `↳
   *    codex`, and the count is still 1 (preset-supplied values never count).
   * 5. Choose None; assert the POST body `{"agent.preset": null}` and the
   *    Worker CLI row is back to `default` with `claude` latched.
   */
  test("choosing a preset fills the Customize grid from it and None clears it", async ({ page }) => {
    const posts = await stubFabConfig(page, { presets: true });
    await openAgentsTab(page);

    const preset = page.getByTestId("agent-preset-select");
    const customize = page.getByTestId("agent-customize-toggle");
    await expect(preset).toHaveValue("");
    await expect(customize).toHaveText(/Customize · 1 set explicitly/);
    await expect(customize).toHaveAttribute("aria-expanded", "true");

    await preset.selectOption("codex-workers");
    await expect(preset).toHaveValue("codex-workers");
    expect(posts).toEqual([{ "agent.preset": "codex-workers" }]);

    const workers = page.getByTestId("fab-row-agent.workers");
    await expect(workers.getByRole("button", { name: "codex" })).toHaveAttribute("aria-pressed", "true");
    await expect(workers.getByTestId("provenance-chip")).toHaveText("preset");
    await expect(workers.getByTestId("provenance-chip")).toHaveAttribute("title", "preset codex-workers");
    await expect(workers.getByRole("button", { name: "Reset agent.workers" })).toHaveCount(0);
    await expect(page.getByLabel("doing CLI").locator("option").first()).toHaveText("↳ codex");
    await expect(customize).toHaveText(/Customize · 1 set explicitly/);

    await preset.selectOption("");
    await expect(preset).toHaveValue("");
    expect(posts[1]).toEqual({ "agent.preset": null });
    await expect(workers.getByTestId("provenance-chip")).toHaveText("default");
    await expect(workers.getByRole("button", { name: "claude" })).toHaveAttribute("aria-pressed", "true");
  });

  /**
   * Proves: an explicit per-role value sitting on a key the chosen preset also
   * sets is called out by a note that offers no clearing action, and its own
   * reset link keeps working.
   *
   * Steps:
   * 1. Stub with presets and a system override of the review role's CLI; open
   *    the Agents tab.
   * 2. Assert Customize is expanded at `2 set explicitly` (the session CLI the
   *    stub always sets, plus the review role) and no note shows.
   * 3. Choose `codex-review`; assert the note reads `1 explicit field
   *    overrides parts of this preset — see Customize` and holds no button.
   * 4. Click the review row's reset; assert the note is gone.
   */
  test("an explicit override of a preset's key is noted, never cleared for you", async ({ page }) => {
    const posts = await stubFabConfig(page, { presets: true, system: { "agent.profiles.review.tool": "claude" } });
    await openAgentsTab(page);

    await expect(page.getByTestId("agent-customize-toggle")).toHaveText(/Customize · 2 set explicitly/);
    await expect(page.getByTestId("agent-customize-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("agent-preset-override-note")).toHaveCount(0);

    await page.getByTestId("agent-preset-select").selectOption("codex-review");
    const note = page.getByTestId("agent-preset-override-note");
    await expect(note).toHaveText("1 explicit field overrides parts of this preset — see Customize");
    await expect(note.getByRole("button")).toHaveCount(0);
    expect(posts).toEqual([{ "agent.preset": "codex-review" }]);

    await page.getByRole("button", { name: "Reset review overrides" }).click();
    await expect(note).toHaveCount(0);
    await expect(page.getByLabel("review CLI").locator("option").first()).toHaveText("↳ codex");
  });

  /**
   * Proves: the palette's `Settings: Agent preset…` entry opens the dialog on
   * the Agents tab and leaves the preset dropdown focused once the panel has
   * loaded.
   *
   * Steps:
   * 1. Stub with presets; load `/`; open the palette and run `Settings: Agent
   *    preset…`.
   * 2. Assert the dialog is open on the Agents tab.
   * 3. Assert the Agent preset select is visible and focused.
   */
  test("the palette action opens Agents with the preset dropdown focused", async ({ page }) => {
    await stubFabConfig(page, { presets: true });
    await page.goto("/");
    const palette = await openPalette(page);
    await palette.fill("Settings: Agent preset");
    await page.keyboard.press("Enter");

    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("tab", { name: "Agents" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("agent-preset-select")).toBeFocused();
  });

  /**
   * Proves: against a fab that cannot list presets the tab renders exactly as
   * before — no preset dropdown, no Customize disclosure — and the palette
   * entry still opens the Agents tab.
   *
   * Steps:
   * 1. Stub without presets; load `/`; run `Settings: Agent preset…`.
   * 2. Assert the Agents tab is open, the knobs and role rows are visible, and
   *    neither the select nor the disclosure exists.
   */
  test("without preset support the tab is unchanged and the palette entry still opens it", async ({ page }) => {
    await stubFabConfig(page);
    await page.goto("/");
    const palette = await openPalette(page);
    await palette.fill("Settings: Agent preset");
    await page.keyboard.press("Enter");

    await expect(page.getByRole("tab", { name: "Agents" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("group", { name: "Session CLI" })).toBeVisible();
    await expect(page.getByTestId(/^role-row-/)).toHaveCount(6);
    await expect(page.getByTestId("agent-preset-select")).toHaveCount(0);
    await expect(page.getByTestId("agent-customize")).toHaveCount(0);
  });
});
