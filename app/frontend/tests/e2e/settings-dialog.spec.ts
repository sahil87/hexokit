import { test, expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { gotoServerReady, openPalette } from "./_ready";
import { SETTINGS_PATH } from "./_settings";
import { TMUX_SERVER, createSession, killSession, listWindows } from "./_tmux";

/**
 * Settings dialog — the VS Code-style tabbed preference pane (General /
 * Appearance / Shortcuts, one `role="tablist"`: a left rail ≥480px, a
 * horizontal strip under the title below; riding the fixed-height `size="xl"`
 * Dialog variant), mounted once at AppLayout so it opens on every route
 * (server routes AND `/board/$name`, which renders no AppShell), triggered
 * from the command palette and the top-bar gear, with a visible
 * This-host/This-device persistence-scope split INSIDE each tab, and
 * host-scoped edits persisting through `/api/settings`. These tests prove the
 * intake-level behaviors:
 *   1. palette-open on a server route — General by default (name/SSH/
 *      notifications), Appearance carrying theme/accent/font,
 *   2. palette-open on /board/$name (the AppLayout mount's whole point —
 *      the board route renders no AppShell),
 *   3. top-bar gear open (the gear lives in the top-bar right cluster),
 *   4. a host-scoped edit (instance name) persists through the API.
 *   5. 375px: the horizontal tab strip fits, and the tall Shortcuts panel
 *      scrolls INSIDE the fixed-height xl dialog.
 *
 * Shared setup: SETTINGS_PATH (from ./_settings) derives from RK_CONFIG_DIR
 * when set — under `just test-e2e` the harness points backend and specs at
 * a per-run temp config root, so the instance-name/auto_name writes through
 * the live API never touch the developer's real file. The `beforeAll`
 * snapshot / `afterAll` verbatim-restore (or delete-if-absent) pattern is
 * KEPT as the fallback for the interactive `just pw` lane, which runs
 * against a `just dev` rig with no RK_CONFIG_DIR — there SETTINGS_PATH is
 * the REAL ~/.config/hexokit/config.yaml and the snapshot still protects
 * it; under the harness the same snapshot/restore is a harmless no-op on
 * the temp file — the board-list-reorder.spec.ts pattern. `beforeAll` also
 * creates an `e2e-settings-<timestamp>` tmux session on `rk-test-e2e` with
 * one named window (`win-a`); `afterAll` kills it. A unique board name and
 * instance name are generated per run so reruns
 * don't collide. `openPaletteSettings` opens the palette through the shared
 * `openPalette` helper, which gates on the palette and retries — a chord
 * reaching a focused xterm is consumed, not merely delayed, so a single long
 * wait on the palette input could never recover. Control-level behavior
 * (input commit/cancel semantics, inline errors, theme selects, font stepper,
 * accent popover, roving-tabindex arrow nav) is exercised by unit tests
 * (`settings-dialog.test.tsx`, `settings-dialog-context.test.tsx`,
 * `instance-name-context.test.tsx`); these e2e tests focus on the mount-point,
 * trigger, layout, and persistence contracts that unit tests can't cover.
 */

let settingsSnapshot: Buffer | undefined;
let settingsExisted = false;

const TEST_SESSION = `e2e-settings-${Date.now()}`;
// Board names are constrained to alphanumeric/-/_ — fresh per run.
const BOARD_NAME = `set${Date.now().toString().slice(-6)}`;
const TEST_INSTANCE_NAME = `e2e-name-${Date.now().toString().slice(-6)}`;

async function openPaletteSettings(page: Page) {
  const paletteInput = await openPalette(page);
  await paletteInput.fill("Settings: Open");
  await page.keyboard.press("Enter");
}

function expectDialogOpen(page: Page) {
  return expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible({
    timeout: 10_000,
  });
}

// Read one stored setting from the registry-driven GET /api/settings (null
// when unset).
async function pollSetting(page: Page, key: string): Promise<unknown> {
  const res = await page.request.get("/api/settings");
  const body = (await res.json()) as { settings: Array<{ key: string; value: unknown }> };
  return body.settings.find((e) => e.key === key)?.value ?? null;
}

// Read the stored instance_name from the registry-driven GET /api/settings
// (null when unset).
async function pollInstanceName(page: Page): Promise<string | null> {
  const value = await pollSetting(page, "instance_name");
  return typeof value === "string" ? value : null;
}

test.describe("Settings dialog", () => {
  test.beforeAll(() => {
    // Snapshot the settings file at SETTINGS_PATH before the suite mutates it
    // via POST /api/settings (instance_name key); restored verbatim after.
    // Under `just test-e2e` this is the harness's per-run temp file (no-op
    // protection); under `just pw` it is the developer's REAL config.
    try {
      settingsSnapshot = readFileSync(SETTINGS_PATH);
      settingsExisted = true;
    } catch (err) {
      // Only ENOENT means "no file to restore". Any other read error means
      // the file EXISTS but couldn't be snapshotted — rethrow so afterAll
      // never deletes the developer's real settings on a failed snapshot.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      settingsSnapshot = undefined;
      settingsExisted = false;
    }

    createSession(TEST_SESSION, { windows: ["win-a"] });
  });

  test.afterAll(() => {
    // Restore the settings snapshot even if tests failed.
    try {
      if (settingsExisted && settingsSnapshot !== undefined) {
        writeFileSync(SETTINGS_PATH, settingsSnapshot);
      } else {
        rmSync(SETTINGS_PATH, { force: true });
      }
    } catch {
      // Best-effort
    }
    killSession(TEST_SESSION);
  });

  /**
   * Proves: the "Settings: Open" palette action opens the single
   * AppLayout-mounted dialog on a server route ON THE GENERAL TAB (the
   * default), the General tab shows its scope-split controls (instance name,
   * SSH host, notifications), clicking the Appearance tab reveals its
   * controls (accent color, the inline theme picker — a trigger naming the
   * active theme that opens a search-field popover listing themes with both
   * preferred slots checked — and terminal font), and Escape is layered: with
   * the theme popover open it closes only the popover; a second Escape closes
   * the dialog (keyboard-first contract).
   *
   * Steps:
   * 1. Navigate to `/rk-test-e2e` and wait for the Connected indicator.
   * 2. `openPalette` → type `Settings: Open` → Enter.
   * 3. Assert the `Settings` dialog is visible with the General tab
   *    `aria-selected`.
   * 4. Assert "This host" and "This device" section labels render, plus the
   *    Instance name input, SSH host input, and the `Notifications` label.
   * 5. Click the Appearance tab; assert the `Set instance color` button and
   *    the theme trigger render while the Themes listbox stays hidden
   *    (collapsed at rest); click the trigger and assert the search combobox
   *    and listbox open with exactly two `Current theme` checks (the dark and
   *    light preferred slots); assert the `Increase terminal font` button
   *    renders.
   * 6. Press Escape; assert the theme popover closed while the dialog stayed
   *    open; press Escape again and assert the dialog is gone.
   */
  test("palette opens the dialog on the General tab; the Appearance tab carries the rest (260818-bncw)", async ({ page }) => {
    await gotoServerReady(page, TMUX_SERVER);

    await openPaletteSettings(page);
    await expectDialogOpen(page);

    // General (the tab-less default): instance name + SSH host under This
    // host, notifications under This device. Scope to the dialog: the
    // sidebar HOST panel carries its own accent-picker button with the same
    // accessible name.
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog.getByRole("tab", { name: "General" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(dialog.getByText("This host")).toBeVisible();
    await expect(dialog.getByText("This device")).toBeVisible();
    await expect(dialog.getByLabel("Instance name")).toBeVisible();
    await expect(dialog.getByLabel("SSH host")).toBeVisible();
    await expect(dialog.getByText("Notifications", { exact: true })).toBeVisible();

    // The Appearance tab keeps its own scope split. The theme control is the
    // shared searchable picker (260819-qkow): at rest a trigger names the
    // ACTIVE theme; clicking it opens the search field with the list in a
    // popover, where both preferred slots (dark + light) carry a check.
    await dialog.getByRole("tab", { name: "Appearance" }).click();
    await expect(dialog.getByRole("button", { name: "Set instance color" })).toBeVisible();
    const themeTrigger = dialog.getByTestId("theme-picker-trigger");
    await expect(themeTrigger).toBeVisible();
    await expect(dialog.getByRole("listbox", { name: "Themes" })).not.toBeVisible();
    await themeTrigger.click();
    await expect(dialog.getByRole("combobox", { name: "Search themes" })).toBeVisible();
    await expect(dialog.getByRole("listbox", { name: "Themes" })).toBeVisible();
    await expect(dialog.getByLabel("Current theme")).toHaveCount(2);
    await expect(dialog.getByRole("button", { name: "Increase terminal font" })).toBeVisible();

    // Escape is layered: with the theme popover open it closes the POPOVER
    // and the dialog stays; a second Escape closes the dialog (keyboard-first
    // contract).
    await page.keyboard.press("Escape");
    await expect(dialog.getByRole("listbox", { name: "Themes" })).not.toBeVisible();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Settings" })).not.toBeVisible();
  });

  /**
   * Proves: the dialog uses the `xl` Dialog variant (`max-w-4xl` + fixed
   * height, not the phone-card `max-w-sm`); the ONE tablist markup renders
   * with roving tabindex (the active tab is the list's only Tab stop); each
   * setting is a preference row — a `min-[480px]:grid-cols-[190px_1fr]` grid
   * (label column left, control column right); and the Notifications row
   * (moved from the retired top-bar bell) renders under This device on the
   * General tab with its test-send button and setup-guide link. Status text
   * varies by browser permission state, so only state-independent contents
   * are asserted here (state-by-state behavior is unit-tested).
   *
   * Steps:
   * 1. Navigate to `/rk-test-e2e` and wait for the Connected indicator.
   * 2. Open the dialog via the palette (`Settings: Open`).
   * 3. Assert the dialog panel's class carries `max-w-4xl` and not `max-w-sm`.
   * 4. Assert the tablist (`Settings sections`) renders and the General tab
   *    has `tabindex="0"` while Appearance has `tabindex="-1"`.
   * 5. Resolve the Instance-name input's closest `.grid` ancestor and assert
   *    its class contains `min-[480px]:grid-cols-[190px_1fr]`.
   * 6. Assert the `Notifications` label, the `Send test notification` button,
   *    and the `Setup & troubleshooting guide` link (notifications doc, new
   *    tab) are visible.
   * 7. Press Escape; assert the dialog is gone.
   */
  test("tabbed preference-pane layout with the Notifications row (260724-6j1v, 260818-bncw)", async ({ page }) => {
    await gotoServerReady(page, TMUX_SERVER);

    await openPaletteSettings(page);
    await expectDialogOpen(page);
    const dialog = page.getByRole("dialog", { name: "Settings" });

    // The xl Dialog variant (max-w-4xl + fixed height) — wider than the old
    // lg pane so the left rail + panel fit side by side.
    await expect(dialog).toHaveClass(/max-w-4xl/);
    await expect(dialog).not.toHaveClass(/max-w-sm/);

    // One tablist markup — the desktop left rail (a vertical tablist at this
    // viewport) with roving tabindex (the active tab is the one Tab stop).
    const tablist = dialog.getByRole("tablist", { name: "Settings sections" });
    await expect(tablist).toBeVisible();
    await expect(tablist.getByRole("tab", { name: "General" })).toHaveAttribute("tabindex", "0");
    await expect(tablist.getByRole("tab", { name: "Appearance" })).toHaveAttribute(
      "tabindex",
      "-1",
    );

    // Preference-row grid: each setting is a `190px 1fr` two-column grid at
    // desktop width (label column left, control column right — one vertical
    // rule). Checked on a representative row (Instance name).
    const rowClass = await dialog
      .locator("#settings-instance-name")
      .evaluate((el) => el.closest(".grid")?.className ?? "");
    expect(rowClass).toContain("min-[480px]:grid-cols-[190px_1fr]");

    // Notifications row (moved from the retired top-bar bell) lives under the
    // This-device scope on the General tab: label, subscribed-gated test
    // button, and the setup guide link. Status text varies by browser
    // permission state, so only the state-independent contents are asserted.
    await expect(dialog.getByText("Notifications", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Send test notification" })).toBeVisible();
    const guide = dialog.getByRole("link", { name: /Setup & troubleshooting guide/ });
    await expect(guide).toBeVisible();
    await expect(guide).toHaveAttribute("href", /docs\/site\/notifications\.md/);
    await expect(guide).toHaveAttribute("target", "_blank");

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  });

  /**
   * Proves: on a short mobile viewport the fixed-height xl dialog does not
   * clip: the panel's border box fits entirely inside the viewport; the SAME
   * tablist markup renders as the horizontal strip under the title with all
   * three tabs reachable; the page gains no horizontal overflow; and the tall
   * Shortcuts tab's PANEL (not the dialog) is the scroll container
   * (`scrollHeight > clientHeight` on the tabpanel), with its last element
   * (the reset-all footer) reachable by scrolling within it. The `Connected`
   * readiness gate is deliberately not used — at a mobile viewport the
   * sidebar (which hosts the dot) is an unmounted drawer, so the top-bar
   * chevron is the readiness signal.
   *
   * Steps:
   * 1. Set the viewport to 375×667 and navigate to `/rk-test-e2e`; wait for
   *    the top-bar `More controls` chevron.
   * 2. Open the dialog via the palette (`Settings: Open`).
   * 3. Assert the dialog `boundingBox()` lies fully within
   *    `[0,0]–[375,667]`.
   * 4. Assert all three tabs (General / Appearance / Shortcuts) are visible
   *    in the strip, and `document.documentElement` has no horizontal
   *    overflow.
   * 5. Click the Shortcuts tab; assert `settings-shortcuts-panel` is visible
   *    and the tabpanel's `scrollHeight > clientHeight`.
   * 6. `scrollIntoViewIfNeeded()` the `reset all` button; assert it is
   *    visible and its box sits inside the viewport.
   */
  test("short viewport (375x667): the tab strip fits and the tall Shortcuts panel scrolls internally (260724-6j1v, 260818-bncw)", async ({ page }) => {
    // The xl dialog pins a fixed height with panel-level `overflow-hidden` —
    // each tab panel owns its own scroll, so a tall tab must scroll inside
    // the dialog instead of clipping off-screen with no scroll path.
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(`/${TMUX_SERVER}`);
    // No [aria-label='Connected'] gate here: the dot lives in the sidebar
    // footer, and at a mobile viewport the drawer (and dot) is unmounted.
    // The top-bar chevron is the readiness signal instead.
    await expect(page.getByRole("button", { name: "More controls" })).toBeVisible({
      timeout: 10_000,
    });

    await openPaletteSettings(page);
    await expectDialogOpen(page);
    const dialog = page.getByRole("dialog", { name: "Settings" });

    // Geometry: the panel's border box fits entirely inside the viewport.
    const box = await dialog.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    expect(box!.y + box!.height).toBeLessThanOrEqual(667);

    // The same tablist markup is the horizontal strip under the title at
    // <480px — all three tabs reachable.
    for (const label of ["General", "Appearance", "Shortcuts"]) {
      await expect(dialog.getByRole("tab", { name: label })).toBeVisible();
    }
    // … and the page itself never gains horizontal overflow.
    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(pageOverflow).toBe(false);

    // The Shortcuts tab is the tall panel: its TAB PANEL (not the dialog)
    // overflows and scrolls, and its last element (the reset-all footer) is
    // reachable by scrolling within it.
    await dialog.getByRole("tab", { name: "Shortcuts" }).click();
    await expect(page.getByTestId("settings-shortcuts-panel")).toBeVisible();
    const tabpanel = dialog.getByRole("tabpanel");
    const overflows = await tabpanel.evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(overflows).toBe(true);
    const resetAll = dialog.getByRole("button", { name: "reset all" });
    await resetAll.scrollIntoViewIfNeeded();
    await expect(resetAll).toBeVisible();
    const resetBox = await resetAll.boundingBox();
    expect(resetBox).toBeTruthy();
    expect(resetBox!.y).toBeGreaterThanOrEqual(0);
    expect(resetBox!.y + resetBox!.height).toBeLessThanOrEqual(667);
  });

  /**
   * Proves: the dialog is reachable on the board route — the whole point of
   * the AppLayout mount, since `/board/$name` does not render AppShell and
   * mounts its own palette (`boardRouteActions`) — and the BOARD shell's
   * `shortcuts-overlay` chord handler resolves the same layout-global entry:
   * ⇧Ctrl+/ switches the open dialog to the Shortcuts tab and re-firing
   * closes it. On the sessionless board route the macro add flow stays gated
   * off and the TMUX section renders its "No tmux server running" empty
   * state.
   *
   * Steps:
   * 1. Read `win-a`'s `#{window_id}` via `tmux list-windows -F` and
   *    `POST /api/boards/<name>/pin` so the board exists.
   * 2. Navigate to `/board/<name>` (`domcontentloaded`); wait for the `win-a`
   *    pane header.
   * 3. `openPalette` → type `Settings: Open` → Enter.
   * 4. Assert the `Settings` dialog is visible with both scope sections.
   * 5. Press Shift+Ctrl+/ → the dialog stays open on the Shortcuts tab
   *    (`settings-shortcuts-panel` visible); assert the add-flow button is
   *    absent and the TMUX empty state renders.
   * 6. Press Shift+Ctrl+/ again → the dialog closes.
   * 7. Finally: `POST /api/boards/<name>/unpin` so the board does not outlive
   *    the run.
   */
  test("palette opens the same dialog on /board/$name (no AppShell there)", async ({ page }) => {
    test.setTimeout(30_000);
    // Pin win-a via the API so the board exists (the deterministic path the
    // boards-pin-flow spec established).
    const winId = listWindows(TEST_SESSION).find((w) => w.name === "win-a")?.windowId;
    expect(winId).toBeTruthy();
    const pinRes = await page.request.post(`/api/boards/${BOARD_NAME}/pin`, {
      data: { server: TMUX_SERVER, windowId: winId },
    });
    expect(pinRes.ok()).toBeTruthy();

    try {
      await page.goto(`/board/${BOARD_NAME}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByText("win-a").first()).toBeVisible({ timeout: 10_000 });

      await openPaletteSettings(page);
      await expectDialogOpen(page);
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await expect(dialog.getByText("This host")).toBeVisible();
      await expect(dialog.getByText("This device")).toBeVisible();

      // The board shell's `shortcuts-overlay` chord handler resolves the same
      // global entry: ⇧Ctrl+/ switches the open dialog to the Shortcuts tab
      // here too, and re-firing closes (260818-bncw three-state toggle).
      await page.keyboard.press("Shift+Control+Slash");
      await expect(dialog.getByRole("tab", { name: "Shortcuts" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(page.getByTestId("settings-shortcuts-panel")).toBeVisible();
      // Board route: no session context — the add flow stays gated off and
      // the TMUX section renders its empty state, not a crash/spinner.
      await expect(
        page.getByText("+ bind a key to a palette action or riff preset…"),
      ).toHaveCount(0);
      await expect(page.getByTestId("tmux-section").getByText("No tmux server running")).toBeVisible();
      await page.keyboard.press("Shift+Control+Slash");
      await expect(dialog).toHaveCount(0);
    } finally {
      // Unpin so the board (and its _rk-pin-* session) does not outlive the run.
      await page.request
        .post(`/api/boards/${BOARD_NAME}/unpin`, {
          data: { server: TMUX_SERVER, windowId: winId },
        })
        .catch(() => {});
    }
  });

  /**
   * Proves: the top-bar right-cluster gear is a working trigger on server
   * routes, named by `aria-label` + the tier-1 `Tip` system — it carries NO
   * native `title=` attribute.
   *
   * Steps:
   * 1. Navigate to `/rk-test-e2e` and wait for the Connected indicator.
   * 2. Locate the `Open settings` button (the in-bar top-bar gear); assert it
   *    is visible and has no `title` attribute.
   * 3. Click it; assert the `Settings` dialog is visible.
   */
  test("top-bar gear opens the dialog (Tip-named, no native title)", async ({ page }) => {
    await gotoServerReady(page, TMUX_SERVER);

    // The gear is a top-bar right-cluster chip since 260812-d1at (in-bar at
    // the default desktop viewport; the aria-hidden fit probe copy is excluded
    // from role queries, so this resolves the in-bar chip).
    const gear = page.getByRole("button", { name: "Open settings" });
    await expect(gear).toBeVisible({ timeout: 10_000 });
    // Tip system: no native title attribute on the gear.
    await expect(gear).not.toHaveAttribute("title");

    await gear.click();
    await expectDialogOpen(page);
  });

  /**
   * Proves: a This-host edit round-trips through the live backend: committing
   * the Instance name input POSTs `/api/settings` (the `instance_name` key),
   * the stored setting reflects the value, the status bar's host segment
   * prefers the override live (no reload — the desktop home for the hostname
   * now that the HOST panel is drawer-only), and clearing the field clears
   * the setting.
   *
   * Steps:
   * 1. Navigate to `/rk-test-e2e`; open the dialog via the top-bar gear.
   * 2. Fill the Instance name input with the unique test name; press Enter.
   * 3. Poll `GET /api/settings` until its `instance_name` entry carries the
   *    test name.
   * 4. Assert the status bar's host segment (`status-bar-host`) shows the
   *    test name.
   * 5. Clear the input; press Enter.
   * 6. Poll `GET /api/settings` until its `instance_name` entry returns
   *    `null`.
   */
  test("editing the instance name persists a host-scoped value (and clears)", async ({ page }) => {
    await gotoServerReady(page, TMUX_SERVER);

    await page.getByRole("button", { name: "Open settings" }).click();
    await expectDialogOpen(page);

    const nameInput = page.getByLabel("Instance name");
    await nameInput.fill(TEST_INSTANCE_NAME);
    await nameInput.press("Enter");

    // The commit POSTs to the host — the stored setting is the contract.
    await expect
      .poll(
        async () => {
          const name = await pollInstanceName(page);
          return name;
        },
        { timeout: 5_000 },
      )
      .toBe(TEST_INSTANCE_NAME);

    // The status bar's host segment prefers the override, live (no reload) —
    // the desktop home for the hostname since the HOST panel went drawer-only
    // (260814-ldbs; the drawer panel keeps the same live behavior on mobile).
    await expect(
      page.getByTestId("status-bar-host").getByText(TEST_INSTANCE_NAME),
    ).toBeVisible({ timeout: 5_000 });

    // Clearing the field clears the setting.
    await nameInput.fill("");
    await nameInput.press("Enter");
    await expect
      .poll(
        async () => {
          const name = await pollInstanceName(page);
          return name;
        },
        { timeout: 5_000 },
      )
      .toBeNull();
  });

  /**
   * Proves: the fourth tab is the registry-driven everything-table,
   * palette-reachable via the `Settings: All` deep-link: its search is a
   * substring filter that hides emptied category headers; the
   * `requires restart` badge is driven by the GET payload's `live` flag
   * (visible on `log_level`, absent on `auto_name` now that it is live); and
   * a table write — toggling `auto_name` — persists through
   * `POST /api/settings`, verified by polling `GET /api/settings` both
   * directions. `$HOME` is not isolated in e2e, so the write lands in the
   * developer's real config.yaml — the suite's beforeAll/afterAll
   * snapshot/restore covers it byte-identically.
   *
   * Steps:
   * 1. Navigate to `/rk-test-e2e` and wait for the Connected indicator.
   * 2. `openPalette` → type `Settings: All` → Enter; assert the dialog opens with
   *    the All settings tab `aria-selected` and `settings-all-panel` visible.
   * 3. Fill the search field with `log`; assert `setting-row-log_level` stays
   *    visible, `setting-row-auto_name` is gone, and the emptied `Behavior`
   *    category header hides.
   * 4. Assert `restart-badge-log_level` is visible while
   *    `restart-badge-auto_name` does not exist.
   * 5. Search `auto_name`; read the row switch's `aria-checked` as the
   *    initial value, click it, and poll `GET /api/settings` until the stored
   *    `auto_name` equals the negation.
   * 6. Click the switch back and poll `GET /api/settings` until the stored
   *    value round-trips to the initial one (afterAll restores the raw config
   *    bytes regardless).
   */
  test("the All-settings tab toggles auto_name through the live API, with live-driven restart badges (260823-5r41)", async ({ page }) => {
    await gotoServerReady(page, TMUX_SERVER);

    // The All-settings tab is the registry-driven table: open it via the
    // "Settings: All" palette deep-link (openSettings("all")).
    const paletteInput = await openPalette(page);
    await paletteInput.fill("Settings: All");
    await page.keyboard.press("Enter");
    await expectDialogOpen(page);
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog.getByRole("tab", { name: "All settings" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const panel = page.getByTestId("settings-all-panel");
    await expect(panel).toBeVisible();

    // Search is a substring filter over key/description/category; emptied
    // category headers hide (Advanced keeps only log_level).
    await panel.getByRole("searchbox", { name: "Search settings" }).fill("log");
    await expect(panel.getByTestId("setting-row-log_level")).toBeVisible();
    await expect(panel.getByTestId("setting-row-auto_name")).toHaveCount(0);
    await expect(panel.getByText("Behavior", { exact: true })).toHaveCount(0);

    // The "requires restart" badge rides the GET payload's live flag:
    // log_level (live:false) carries it, auto_name (live:true since this
    // change) does not.
    await expect(panel.getByTestId("restart-badge-log_level")).toBeVisible();
    await expect(panel.getByTestId("restart-badge-auto_name")).toHaveCount(0);

    // Toggle auto_name in the table and assert persistence through GET.
    await panel.getByRole("searchbox", { name: "Search settings" }).fill("auto_name");
    const toggle = panel.getByTestId("setting-row-auto_name").getByRole("switch", {
      name: "auto_name",
    });
    const initial = (await toggle.getAttribute("aria-checked")) === "true";
    await toggle.click();
    await expect
      .poll(() => pollSetting(page, "auto_name"), { timeout: 5_000 })
      .toBe(!initial);

    // Restore the prior value so a failed-after-this-point run leaves
    // config.yaml with only a committed toggle for the afterAll snapshot
    // restore to cover (it restores the raw bytes verbatim regardless).
    await toggle.click();
    await expect
      .poll(() => pollSetting(page, "auto_name"), { timeout: 5_000 })
      .toBe(initial);
  });

  /**
   * Proves: the General tab's curated `Easter eggs` switch (This host,
   * directly after Auto-name tabs) persists through the live API: clicking it
   * POSTs the negation of its current value which `GET /api/settings` then
   * serves back, and clicking again round-trips to the initial value. The
   * initial `aria-checked` is read, not assumed — interactive `just pw` runs
   * against the developer's real config, which may already carry
   * `easter_eggs: false`. The restore runs in a `finally` so the per-run
   * config root is left as found even on failure.
   *
   * Steps:
   * 1. Navigate to `/rk-test-e2e` and wait for the Connected indicator.
   * 2. Open the dialog via the top-bar gear; assert the General tab is
   *    selected and read the `Easter eggs` switch's `aria-checked` as the
   *    initial value.
   * 3. Click the switch; poll `GET /api/settings` until its `easter_eggs`
   *    entry reads the negation.
   * 4. Finally: if the switch moved, click it back and poll
   *    `GET /api/settings` until the entry reads the initial value again.
   */
  test("the General tab's Easter eggs switch persists through the live API (and restores)", async ({ page }) => {
    await gotoServerReady(page, TMUX_SERVER);

    await page.getByRole("button", { name: "Open settings" }).click();
    await expectDialogOpen(page);
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog.getByRole("tab", { name: "General" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    const toggle = dialog.locator("#settings-easter-eggs");
    const initial = (await toggle.getAttribute("aria-checked")) === "true";

    try {
      await toggle.click();
      await expect
        .poll(() => pollSetting(page, "easter_eggs"), { timeout: 5_000 })
        .toBe(!initial);
    } finally {
      // Restore the prior value so the run leaves the config root as found.
      if ((await toggle.getAttribute("aria-checked")) === (initial ? "false" : "true")) {
        await toggle.click();
        await expect
          .poll(() => pollSetting(page, "easter_eggs"), { timeout: 5_000 })
          .toBe(initial);
      }
    }
  });
});
