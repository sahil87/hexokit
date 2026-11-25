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
 *
 * The preset-editor describe below stubs a fab that lists presets
 * (`stubFabConfig(page, { presets: true })`); its stub keeps the user-preset
 * table and answers the duplicate / rename / delete / leftover routes, so every
 * flow round-trips through the real SPA and no run touches a real fab or the
 * developer's config. The one test that needs a workspace with its own preset
 * also stubs `/api/servers`.
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

test.describe("Settings dialog — Agents tab, presets", () => {
  const editor = (page: Page) => page.getByTestId("preset-editor");
  // The machine default's native <option>s share the role, so scope to the list.
  const option = (page: Page, name: string) =>
    page.getByRole("listbox", { name: "Presets" }).getByRole("option", { name: new RegExp(`^${name}`) });
  const nameForm = (page: Page) => page.getByTestId("preset-name-form");
  const NIGHT_SHIFT = { description: "Overnight runs", workers: "codex" };

  /**
   * Proves: with a fab that lists presets the tab is Use a preset, Presets and
   * Dispatch (no Customize), the Use a preset box holds only the Machine
   * default dropdown, choosing a preset there writes `agent.preset` and tags
   * that preset `default` in the list, and None clears it.
   *
   * Steps:
   * 1. Stub with presets; open the Agents tab.
   * 2. Assert the section headings read Use a preset, Presets, Dispatch, no
   *    Customize text, and the Machine default select reads None.
   * 3. Choose `codex-workers`; assert the POST `{"agent.preset":
   *    "codex-workers"}` and that the list tags it `default`.
   * 4. Choose None; assert the POST `{"agent.preset": null}` and no `default`
   *    tag remains.
   */
  test("the tab is boxed sections and the machine default only selects", async ({ page }) => {
    const posts = await stubFabConfig(page, { presets: true });
    await openAgentsTab(page);

    await expect(page.getByRole("heading", { level: 3 })).toHaveText(["Use a preset", "Presets", "Dispatch"]);
    await expect(page.getByText("Customize")).toHaveCount(0);
    const preset = page.getByTestId("agent-preset-select");
    await expect(preset).toHaveValue("");
    await expect(preset.locator("option").first()).toHaveText("None — fab's defaults");

    await preset.selectOption("codex-workers");
    await expect(preset).toHaveValue("codex-workers");
    expect(posts).toEqual([{ "agent.preset": "codex-workers" }]);
    await expect(option(page, "codex-workers")).toContainText("default");

    await preset.selectOption("");
    await expect.poll(() => posts.length).toBe(2);
    expect(posts[1]).toEqual({ "agent.preset": null });
    await expect(page.getByRole("listbox", { name: "Presets" }).getByText("default", { exact: true })).toHaveCount(0);
  });

  for (const viewport of [
    { name: "desktop", size: { width: 1280, height: 800 } },
    { name: "phone", size: { width: 375, height: 812 } },
  ]) {
    /**
     * Proves: a preset can be created, edited, duplicated, renamed and deleted
     * from the Presets section, each step one request (a leaf write, or one
     * duplicate / rename / delete operation), with the editor following the
     * result.
     *
     * The flow runs at a desktop (1280x800) and a phone (375x812) viewport.
     *
     * Steps:
     * 1. Stub with presets; set the viewport; open the Agents tab; click
     *    `+ New preset`.
     * 2. Type `night-shift` and a description; press Enter. Assert the single
     *    description write and that the editor now reads `Editing night-shift`
     *    tagged `yours`.
     * 3. Set the review CLI to codex; assert the write targets
     *    `agent_presets.night-shift.profiles.review.cli` (never an
     *    `agent.profiles` key).
     * 4. Click Duplicate and press Enter on the prefilled `night-shift-copy`;
     *    assert the duplicate request and that the copy keeps the review CLI.
     * 5. Click Rename, type `late-shift`, press Enter; assert the rename request
     *    and the list.
     * 6. Click Delete, confirm; assert the delete request, that `late-shift` is
     *    gone and the first preset is open.
     */
    test(`creates, edits, duplicates, renames and deletes a preset (${viewport.name})`, async ({ page }) => {
      const posts = await stubFabConfig(page, { presets: true });
      await page.setViewportSize(viewport.size);
      await openAgentsTab(page);

      await page.getByRole("button", { name: "+ New preset" }).click();
      await expect(page.getByLabel("Preset name")).toBeFocused();
      await page.getByLabel("Preset name").fill("night-shift");
      await page.getByLabel("Preset description").fill("Overnight runs");
      await page.keyboard.press("Enter");
      await expect(editor(page)).toContainText("Editing night-shift");
      await expect(editor(page)).toContainText("yours");
      expect(posts).toEqual([{ "agent_presets.night-shift.description": "Overnight runs" }]);

      await editor(page).getByLabel("review CLI").selectOption("codex");
      await expect(editor(page).getByLabel("review CLI")).toHaveValue("codex");
      const write = posts.at(-1) as Record<string, unknown>;
      expect(write["agent_presets.night-shift.profiles.review.cli"]).toBe("codex");
      expect(Object.keys(write).filter((k) => k.startsWith("agent.profiles"))).toEqual([]);

      await editor(page).getByRole("button", { name: "Duplicate" }).click();
      await expect(page.getByLabel("Preset name")).toHaveValue("night-shift-copy");
      await page.keyboard.press("Enter");
      await expect(editor(page)).toContainText("Editing night-shift-copy");
      await expect(editor(page).getByLabel("review CLI")).toHaveValue("codex");
      expect(posts.ops[0]).toEqual({
        path: "presets/duplicate",
        body: { from: "night-shift", to: "night-shift-copy", description: "Overnight runs" },
      });

      await editor(page).getByRole("button", { name: "Rename" }).click();
      await page.getByLabel("Preset name").fill("late-shift");
      await page.keyboard.press("Enter");
      await expect(editor(page)).toContainText("Editing late-shift");
      expect(posts.ops[1]).toEqual({ path: "presets/rename", body: { from: "night-shift-copy", to: "late-shift" } });
      await expect(page.getByRole("listbox", { name: "Presets" }).getByRole("option")).toHaveCount(5);

      await editor(page).getByRole("button", { name: "Delete" }).click();
      await page.getByRole("alertdialog", { name: "Delete preset" }).getByRole("button", { name: "Delete" }).click();
      await expect.poll(() => posts.ops.length).toBe(3);
      expect(posts.ops[2]).toEqual({ path: "presets/delete", body: { name: "late-shift" } });
      await expect(option(page, "late-shift")).toHaveCount(0);
      await expect(editor(page)).toContainText("Editing claude");
    });
  }

  /**
   * Proves: a built-in preset renders read-only with only Duplicate enabled,
   * and Duplicate is the way to change one: the copy is editable and keeps the
   * built-in's fields.
   *
   * Steps:
   * 1. Stub with presets; open the Agents tab; open `codex-review`.
   * 2. Assert the read-only tag and note, the disabled description and role
   *    controls, and disabled Rename / Delete.
   * 3. Click Duplicate, press Enter on the prefilled name; assert the
   *    duplicate request carries the built-in's description.
   * 4. Assert the copy is `yours`, its description is editable and its review
   *    CLI reads codex.
   */
  test("a built-in is read-only until it is duplicated", async ({ page }) => {
    const posts = await stubFabConfig(page, { presets: true });
    await openAgentsTab(page);

    await option(page, "codex-review").click();
    await expect(editor(page)).toContainText("built-in · read-only");
    await expect(editor(page).getByText("Built-in presets are read-only. Duplicate this one to change it.")).toBeVisible();
    await expect(editor(page).getByLabel("Description")).toBeDisabled();
    await expect(editor(page).getByLabel("review CLI")).toBeDisabled();
    await expect(editor(page).getByRole("button", { name: "Rename" })).toBeDisabled();
    await expect(editor(page).getByRole("button", { name: "Delete" })).toBeDisabled();

    await editor(page).getByRole("button", { name: "Duplicate" }).click();
    await expect(page.getByLabel("Preset name")).toHaveValue("codex-review-copy");
    await page.keyboard.press("Enter");
    await expect(editor(page)).toContainText("Editing codex-review-copy");
    expect(posts.ops[0].body).toEqual({
      from: "codex-review",
      to: "codex-review-copy",
      description: "Only the review role on Codex",
    });
    await expect(editor(page)).toContainText("yours");
    await expect(editor(page).getByLabel("Description")).toBeEnabled();
    await expect(editor(page).getByLabel("review CLI")).toHaveValue("codex");
  });

  /**
   * Proves: the name form refuses a bad name, a reserved or taken one and an
   * empty description inline without sending anything, and Escape closes it.
   *
   * Steps:
   * 1. Stub with presets; open the Agents tab; click `+ New preset`.
   * 2. Submit `night shift`, `none` and `claude` (each with a description);
   *    assert each message.
   * 3. Submit a valid name with no description; assert the description
   *    message.
   * 4. Press Escape; assert the form is gone and nothing was POSTed.
   */
  test("the name form refuses bad input inline and Escape closes it", async ({ page }) => {
    const posts = await stubFabConfig(page, { presets: true });
    await openAgentsTab(page);

    await page.getByRole("button", { name: "+ New preset" }).click();
    await page.getByLabel("Preset description").fill("A description");
    for (const [name, message] of [
      ["night shift", "Use letters, digits, - and _ only; no spaces."],
      ["none", '"none" is reserved; it means no preset.'],
      ["claude", "A preset named claude already exists."],
    ]) {
      await page.getByLabel("Preset name").fill(name);
      await page.keyboard.press("Enter");
      await expect(nameForm(page).getByRole("alert")).toHaveText(message);
    }
    await page.getByLabel("Preset name").fill("late-shift");
    await page.getByLabel("Preset description").fill("");
    await page.keyboard.press("Enter");
    await expect(nameForm(page).getByRole("alert")).toHaveText(
      "Add a one-line description; it is shown wherever the preset is picked.",
    );

    await page.keyboard.press("Escape");
    await expect(nameForm(page)).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    expect(posts).toEqual([]);
    expect(posts.ops).toEqual([]);
  });

  /**
   * Proves: loose machine-wide values show in a Leftover settings box, and
   * Move into a new preset turns them into a preset that becomes the machine
   * default, after which the box is gone.
   *
   * Steps:
   * 1. Stub with presets and two loose system values (worker CLI codex, review
   *    effort low); open the Agents tab.
   * 2. Assert the box leads the tab and lists both in plain words.
   * 3. Click Move into a new preset; assert the prefilled `my-overrides` and
   *    description; click Move.
   * 4. Assert the move request, that the box is gone, the Machine default now
   *    reads `my-overrides`, and the new preset carries the moved values.
   */
  test("leftover settings move into a new preset that becomes the machine default", async ({ page }) => {
    const posts = await stubFabConfig(page, {
      presets: true,
      system: { "agent.workers": "codex", "agent.profiles.review.effort": "low" },
    });
    await openAgentsTab(page);

    const box = page.getByTestId("leftover-settings");
    await expect(page.getByRole("heading", { level: 3 })).toHaveText(["Leftover settings", "Use a preset", "Presets", "Dispatch"]);
    await expect(box.getByTestId("leftover-summary")).toHaveText(
      "2 settings are set outside any preset: worker CLI = codex, review effort = low.",
    );

    await box.getByRole("button", { name: "Move into a new preset" }).click();
    await expect(page.getByLabel("Preset name")).toHaveValue("my-overrides");
    await expect(page.getByLabel("Preset description")).toHaveValue("Moved from loose machine-wide settings");
    await box.getByRole("button", { name: "Move", exact: true }).click();

    await expect(page.getByTestId("leftover-settings")).toHaveCount(0);
    expect(posts.ops).toEqual([
      { path: "leftovers/move", body: { name: "my-overrides", description: "Moved from loose machine-wide settings" } },
    ]);
    await expect(page.getByTestId("agent-preset-select")).toHaveValue("my-overrides");
    await option(page, "my-overrides").click();
    await expect(editor(page).getByLabel("Worker CLI")).toHaveValue("codex");
    await expect(editor(page).getByLabel("review effort")).toHaveValue("low");
  });

  /**
   * Proves: Clear them asks before it unsets the loose values, and the box
   * goes away after.
   *
   * Steps:
   * 1. Stub with presets and one loose value; open the Agents tab.
   * 2. Click Clear them; assert the confirm shows and nothing was sent.
   * 3. Click Clear; assert the clear request and that the box is gone.
   */
  test("clearing leftover settings asks first", async ({ page }) => {
    const posts = await stubFabConfig(page, { presets: true, system: { "agent.workers": "codex" } });
    await openAgentsTab(page);

    const box = page.getByTestId("leftover-settings");
    await expect(box.getByTestId("leftover-summary")).toHaveText("1 setting is set outside any preset: worker CLI = codex.");
    await box.getByRole("button", { name: "Clear them" }).click();
    await expect(page.getByRole("alertdialog", { name: "Clear leftover settings" })).toBeVisible();
    expect(posts.ops).toEqual([]);

    await page.getByRole("alertdialog").getByRole("button", { name: "Clear", exact: true }).click();
    await expect(page.getByTestId("leftover-settings")).toHaveCount(0);
    expect(posts.ops).toEqual([{ path: "leftovers/clear", body: {} }]);
  });

  /**
   * Proves: when a workspace has its own preset, Move names it and the loose
   * value it would stop inheriting (a value its preset leaves unset).
   *
   * Steps:
   * 1. Stub with presets and a loose review effort; stub `/api/servers` with
   *    a workspace on `codex-review` (which sets only the review CLI).
   * 2. Open the Agents tab; click Move into a new preset.
   * 3. Assert the form's note names the workspace and `review effort = low`.
   */
  test("moving leftovers names the workspace that would stop inheriting them", async ({ page }) => {
    await stubFabConfig(page, { presets: true, system: { "agent.profiles.review.effort": "low" } });
    await page.route("**/api/servers", (route) =>
      route.fulfill({ json: [{ name: "default", sessionCount: 0, agent_preset: "codex-review" }] }),
    );
    await openAgentsTab(page);

    await page.getByTestId("leftover-settings").getByRole("button", { name: "Move into a new preset" }).click();
    await expect(
      nameForm(page).getByText(
        "These have their own preset and will stop inheriting the loose values — workspace default: review effort = low.",
      ),
    ).toBeVisible();
  });

  /**
   * Proves: the list sits beside the editor on a desktop viewport and stacks
   * above it on a phone, with no horizontal page scroll.
   *
   * Steps:
   * 1. Stub with presets; open the Agents tab at 1280px.
   * 2. Assert the editor starts to the right of the list.
   * 3. Resize to 375px; assert the editor sits below the list, at the list's
   *    left edge, and the page has no horizontal overflow.
   */
  test("the list stacks above the editor on a phone", async ({ page }) => {
    await stubFabConfig(page, { presets: true });
    await page.setViewportSize({ width: 1280, height: 800 });
    await openAgentsTab(page);

    const list = page.getByRole("listbox", { name: "Presets" });
    const side = async () => ({ list: (await list.boundingBox())!, editor: (await editor(page).boundingBox())! });
    const wide = await side();
    expect(wide.editor.x).toBeGreaterThan(wide.list.x + wide.list.width - 1);

    await page.setViewportSize({ width: 375, height: 812 });
    const narrow = await side();
    expect(narrow.editor.y).toBeGreaterThan(narrow.list.y + narrow.list.height - 1);
    expect(Math.abs(narrow.editor.x - narrow.list.x)).toBeLessThanOrEqual(12);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  /**
   * Proves: the palette reaches the Presets section: `Settings: New agent
   * preset…` opens the New form focused, and `Settings: Rename agent preset…`
   * offers only your presets and opens Rename for the one picked.
   *
   * Steps:
   * 1. Stub with presets and one user preset; load `/`; run `Settings: New
   *    agent preset…`.
   * 2. Assert the dialog is on Agents and the name input is focused.
   * 3. Close the dialog; run `Settings: Rename agent preset…`.
   * 4. Assert the sub-step lists `night-shift` but no built-in; pick it.
   * 5. Assert the Rename form opens for it and nothing was written.
   */
  test("palette entries open the New form and a preset's Rename form", async ({ page }) => {
    const posts = await stubFabConfig(page, { presets: true, userPresets: { "night-shift": NIGHT_SHIFT } });
    await page.goto("/");
    let palette = await openPalette(page);
    await palette.fill("Settings: New agent preset");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tab", { name: "Agents" })).toHaveAttribute("aria-selected", "true", { timeout: 10_000 });
    await expect(page.getByLabel("Preset name")).toBeFocused();

    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);

    palette = await openPalette(page);
    await palette.fill("Settings: Rename agent preset");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("option", { name: /^night-shift/ })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("option", { name: /^claude/ })).toHaveCount(0);
    await page.getByRole("option", { name: /^night-shift/ }).click();
    await expect(page.getByText("Rename night-shift to")).toBeVisible({ timeout: 10_000 });
    expect(posts).toEqual([]);
    expect(posts.ops).toEqual([]);
  });

  /**
   * Proves: the palette action opens Agents with the Machine default dropdown
   * focused once the panel has loaded.
   *
   * Steps:
   * 1. Stub with presets; load `/`; run `Settings: Agent preset…`.
   * 2. Assert the dialog is open on the Agents tab.
   * 3. Assert the Machine default select is visible and focused.
   */
  test("the palette action opens Agents with the machine default focused", async ({ page }) => {
    await stubFabConfig(page, { presets: true });
    await page.goto("/");
    const palette = await openPalette(page);
    await palette.fill("Settings: Agent preset…");
    await page.keyboard.press("Enter");

    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("tab", { name: "Agents" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("agent-preset-select")).toBeFocused();
  });

  /**
   * Proves: against a fab that cannot list presets the tab keeps the plain CLI
   * knobs and role table — no preset sections — and the palette entry still
   * opens the Agents tab.
   *
   * Steps:
   * 1. Stub without presets; load `/`; run `Settings: Agent preset…`.
   * 2. Assert the Agents tab is open, the knobs and role rows are visible, and
   *    neither the select nor the Presets section exists.
   */
  test("without preset support the tab keeps the plain knobs and the palette entry still opens it", async ({ page }) => {
    await stubFabConfig(page);
    await page.goto("/");
    const palette = await openPalette(page);
    await palette.fill("Settings: Agent preset…");
    await page.keyboard.press("Enter");

    await expect(page.getByRole("tab", { name: "Agents" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("group", { name: "Session CLI" })).toBeVisible();
    await expect(page.getByTestId(/^role-row-/)).toHaveCount(6);
    await expect(page.getByTestId("agent-preset-select")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Presets" })).toHaveCount(0);
  });
});
