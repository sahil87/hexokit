// Mobile cron tabs — the operator route's `Terminal | Tasks | Activity | Cron
// List | Cron Log` segmented header, the `?tab=` deep links, the Activity tab
// (rows, expansion, Check now) with the stale banner above it, and the Cron
// List action surfaces (`+ New entry`, the detail sheet's Edit row and
// `Mute for…` presets).
//
// Shared setup: fully mocked (no tmux). The sessions payload rides the
// state-socket mock — a `dev` session with a work window `@1` plus a
// `monitored: true` window `@2` (carrying `monitoredChange`/`monitoredStage`/
// `monitoredRepo` — the Tasks row) and `operatorLastTickAt` stamped,
// plus an operator window `@9` with `role: "operator"` in `_rk-operator` (the
// header's gate reads the role from this payload, so the header can only
// appear after the snapshot lands). A payload variant stamps `operatorStale`
// on the `dev` session for the banner test. `GET /api/cron` is stubbed via
// page.route (trailing `*` — the client appends `?server=` via withServer)
// with one entry and one delivery so both cron tabs have a row.
// `POST /api/cron/mute` and `POST /api/cron/edit` are stubbed separately
// (registered AFTER the general cron route so Playwright's
// last-registered-wins matching picks them) and capture the request bodies
// for the round-trip assertions. `GET /api/operator/activity*` serves two
// loop rows (a `no change` fire with its check record, a transcribed run with
// a brief and log), `GET /api/operator/runs/**` the brief/log text, and
// `POST /api/operator/wake` is captured for the Check now assertion.
// `/ws/terminals` is a no-op socket mock: the
// terminal mounts its xterm frame without stream data, and the mobile arrival
// gate polls the terminal's `__rkTerminals` registration (the mobile specs'
// idiom). Mobile tests run at 375×812; the desktop case (the operator page
// renders the strip on desktop too, minus the mobile tongue's clearance)
// runs at 1024×768. No host-global state is saved or restored.
import { test, expect, type Page } from "@playwright/test";
import { mockStateSocket } from "./_state-socket-mock";

const SERVER = "default";
const MOBILE_VIEWPORT = { width: 375, height: 812 };
const DESKTOP_VIEWPORT = { width: 1024, height: 768 };

const NOW = Math.floor(Date.now() / 1000);

function sessionsPayload(stale: boolean) {
  return JSON.stringify([
    {
      name: "dev",
      operatorLastTickAt: NOW - 60,
      ...(stale ? { operatorStale: true } : {}),
      windows: [
        {
          windowId: "@1",
          index: 0,
          name: "feature-work",
          worktreePath: "/tmp/wt",
          activity: "active",
          isActiveWindow: true,
          activityTimestamp: 0,
          panes: [{ paneId: "%1", paneIndex: 0, cwd: "/tmp/wt", command: "zsh", isActive: true }],
        },
        {
          windowId: "@2",
          index: 1,
          name: "watched-worker",
          worktreePath: "/tmp/wt2",
          activity: "idle",
          isActiveWindow: false,
          activityTimestamp: 0,
          monitored: true,
          monitoredChange: "wuiu",
          monitoredStage: "review",
          monitoredRepo: "/home/user/code/run-kit",
          agentState: "waiting",
          agentIdleDuration: "6m",
          panes: [{ paneId: "%2", paneIndex: 0, cwd: "/tmp/wt2", command: "claude", isActive: true }],
        },
      ],
    },
    {
      name: "_rk-operator",
      operatorLastTickAt: NOW - 60,
      windows: [
        {
          windowId: "@9",
          index: 0,
          name: "operator",
          worktreePath: "/tmp/op",
          activity: "idle",
          isActiveWindow: false,
          activityTimestamp: 0,
          role: "operator",
          panes: [{ paneId: "%9", paneIndex: 0, cwd: "/tmp/op", command: "claude", isActive: true }],
        },
      ],
    },
  ]);
}

const CRON = JSON.stringify({
  entries: [
    {
      id: "a3f9",
      name: "operator tick",
      schedule: { kind: "backoff", min: "60s", max: "30m" },
      target: { kind: "role", role: "operator" },
      payload: "tick",
      lastFired: NOW - 120,
      nextFire: NOW + 300,
    },
  ],
  deliveries: [
    {
      ts: NOW - 120,
      entry: "a3f9",
      name: "operator tick",
      target: "%9",
      reason: "schedule",
      outcome: "delivered",
    },
  ],
});

const RUN_ID = "20261112T101500-ab12";
const ACTIVITY = JSON.stringify({
  server: SERVER,
  in_flight: null,
  rows: [
    {
      ts: NOW - 120,
      entry: "lp01",
      reason: "schedule",
      outcome: "no change",
      rung: 2,
      fire: "20261112T100000-aaaa",
      check: {
        checked_at: "t",
        changed: false,
        changes: [],
        open: [{ kind: "stale", id: "pr-41", age: "3d" }],
        notices: [],
        items: 1,
      },
    },
    {
      ts: NOW - 600,
      entry: "lp01",
      reason: "trigger:manual",
      outcome: "ran · fixed it · 20s",
      rung: 0,
      fire: RUN_ID,
      check: {
        checked_at: "t",
        changed: true,
        changes: [{ kind: "stage-advance", id: "pr-7", from: "apply", to: "review" }],
        open: [],
        notices: [],
        items: 1,
      },
      run: { id: RUN_ID, outcome: "fixed it", duration_s: 20, has_brief: true, has_log: true },
    },
  ],
});

/** Install the mocked backend (state socket + cron + the select seam).
 *  Returns probes holding the captured mute/edit/wake POST bodies. */
async function mockBackend(page: Page, opts: { stale?: boolean } = {}) {
  const mutePosts: Record<string, unknown>[] = [];
  const editPosts: Record<string, unknown>[] = [];
  const wakePosts: Record<string, unknown>[] = [];
  await mockStateSocket(page, { sessions: sessionsPayload(opts.stale === true) });
  await page.routeWebSocket(/\/ws\/terminals/, () => {});
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ name: SERVER, sessionCount: 2 }]),
    }),
  );
  await page.route("**/api/cron*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: CRON }),
  );
  // Registered after the general cron route so they win for their paths.
  await page.route("**/api/cron/mute*", (route) => {
    mutePosts.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
  });
  await page.route("**/api/cron/edit*", (route) => {
    editPosts.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: '{"id":"a3f9"}',
    });
  });
  // Once a wake has posted, the next activity read is held briefly so the
  // button's transient `check queued` state is observable.
  await page.route("**/api/operator/activity*", async (route) => {
    if (wakePosts.length > 0) await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.fulfill({ status: 200, contentType: "application/json", body: ACTIVITY });
  });
  await page.route("**/api/operator/runs/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      body: route.request().url().endsWith("/brief") ? "# the brief" : "the run log",
    }),
  );
  await page.route("**/api/operator/wake", (route) => {
    wakePosts.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ server: SERVER, reason: "manual" }),
    });
  });
  await page.route("**/api/windows/*/select*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }),
  );
  return { mutePosts, editPosts, wakePosts };
}

/** Mobile-pattern arrival: direct goto + a poll on the terminal's
 *  `__rkTerminals` registration. The window id's `@` is dropped in the URL
 *  (the router's segment form). */
async function gotoWindowMobile(page: Page, windowId: string, search = "") {
  await page.goto(`/${SERVER}/${windowId.replace(/^@/, "")}${search}`);
  await expect
    .poll(
      () =>
        page.evaluate(
          (wid) =>
            Boolean(
              (window as unknown as { __rkTerminals?: Record<string, unknown> }).__rkTerminals?.[wid],
            ),
          windowId,
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
}

const tabStrip = (page: Page) => page.getByRole("tablist", { name: "Quake terminal segments" });

test.describe("Mobile cron tabs", () => {
  /**
   * Proves: at 375px the segment strip renders exactly the five segments —
   * `Terminal`, `Tasks`, `Activity`, `Cron List`, `Cron Log` — in that order,
   * and no label wraps or truncates or pushes the strip/page past the 375px
   * width.
   *
   * Steps:
   * 1. Set the 375×812 viewport; mock the backend; land on the operator route
   *    `/default/9`.
   * 2. Assert the five tab labels in exact order, with Terminal selected by
   *    default.
   * 3. Assert every tab is nowrap and untruncated (scrollWidth ≤ clientWidth)
   *    and the strip and page stay within the 375px width.
   */
  test("the five segments render in order at 375px without wrap or truncation", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await mockBackend(page);
    await gotoWindowMobile(page, "@9");

    const tabs = tabStrip(page);
    await expect(tabs).toBeVisible({ timeout: 10_000 });
    const buttons = tabs.getByRole("tab");
    await expect(buttons).toHaveCount(5);
    expect(await buttons.allTextContents()).toEqual([
      "Terminal",
      "Tasks",
      "Activity",
      "Cron List",
      "Cron Log",
    ]);
    await expect(buttons.nth(0)).toHaveAttribute("aria-selected", "true");

    const noTruncation = await tabs.evaluate((el) =>
      Array.from(el.querySelectorAll('[role="tab"]')).every(
        (b) =>
          b.scrollWidth <= b.clientWidth && getComputedStyle(b).whiteSpace === "nowrap",
      ),
    );
    expect(noTruncation).toBe(true);

    const fitsWidth = await tabs.evaluate(
      (el) =>
        el.getBoundingClientRect().right <= window.innerWidth &&
        document.body.scrollWidth <= window.innerWidth,
    );
    expect(fitsWidth).toBe(true);
  });

  /**
   * Proves: the header is role-gated — a mobile non-operator window route
   * renders no segmented header.
   *
   * Steps:
   * 1. Set the 375×812 viewport; mock the backend.
   * 2. Land on the plain work-window route `/default/1`.
   * 3. Assert no `Quake terminal segments` tablist renders.
   */
  test("no segmented header on a non-operator route", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await mockBackend(page);
    await gotoWindowMobile(page, "@1");

    await expect(tabStrip(page)).toHaveCount(0);
  });

  /**
   * Proves: the segmented header is no longer form-factor-gated — the desktop
   * operator route renders the strip too (the operator page), but WITHOUT the
   * mobile tongue's `pt-9` clearance (the tongue never renders on desktop).
   *
   * Steps:
   * 1. Keep the desktop 1024×768 viewport; mock the backend.
   * 2. Land on the operator route `/default/9`.
   * 3. Assert the terminal registered, the `Quake terminal segments` tablist
   *    renders, and its wrapper carries no `pt-9` tongue clearance.
   */
  test("the desktop operator route renders the strip without the mobile tongue clearance", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await mockBackend(page);
    await page.goto(`/${SERVER}/9`);
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean((window as unknown as { __rkTerminals?: Record<string, unknown> }).__rkTerminals?.["@9"]),
        ),
      )
      .toBe(true);

    const tabs = tabStrip(page);
    await expect(tabs).toBeVisible({ timeout: 10_000 });
    await expect(tabs.locator("..")).not.toHaveClass(/pt-9/);
  });

  /**
   * Proves: tapping a cron segment swaps the content in place — the Cron Log
   * body appears, the URL gains `?tab=log`, and the page does NOT reload (an
   * in-page probe survives the tap, and the terminal's relay registration
   * persists — the terminal is hidden, not unmounted).
   *
   * Steps:
   * 1. Set the 375×812 viewport; mock the backend; land on `/default/9`.
   * 2. Stamp `window.__cronProbe` as a reload tripwire.
   * 3. Tap the Cron Log tab.
   * 4. Assert the log renders, the URL carries `tab=log`, the probe is still
   *    set, and `__rkTerminals["@9"]` is still registered.
   */
  test("tapping Cron Log switches content without a full reload", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await mockBackend(page);
    await gotoWindowMobile(page, "@9");
    await page.evaluate(() => {
      (window as unknown as { __cronProbe?: string }).__cronProbe = "alive";
    });

    await page.getByRole("tab", { name: "Cron Log" }).click();

    await expect(page.getByTestId("cron-log")).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(/tab=log/);
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __cronProbe?: string }).__cronProbe ?? null),
      )
      .toBe("alive");
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean((window as unknown as { __rkTerminals?: Record<string, unknown> }).__rkTerminals?.["@9"]),
        ),
      )
      .toBe(true);
  });

  /**
   * Proves: a `?tab=activity` deep link (the `rk notify` deep-link shape)
   * lands directly on the Activity segment with its fire rows, no extra tap.
   *
   * Steps:
   * 1. Set the 375×812 viewport; mock the backend.
   * 2. Navigate straight to `/default/9?tab=activity`.
   * 3. Assert the Activity body renders both rows with their trigger labels
   *    and the Activity tab is selected (the header gate resolves once the
   *    sessions payload lands).
   */
  test("?tab=activity deep link lands on the Activity segment", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await mockBackend(page);
    await page.goto(`/${SERVER}/9?tab=activity`);

    const activity = page.getByTestId("operator-activity");
    await expect(activity).toBeVisible({ timeout: 10_000 });
    await expect(activity.getByTestId("operator-activity-row")).toHaveCount(2);
    await expect(activity.getByText("schedule · rung 2")).toBeVisible();
    await expect(activity.getByText("manual", { exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
  });

  /**
   * Proves: an Activity row expands to its run's brief and log (fetched from
   * the run-file endpoints) and the filter chips narrow the rows.
   *
   * Steps:
   * 1. Set the 375×812 viewport; mock the backend; land on
   *    `/default/9?tab=activity`.
   * 2. Tap the `runs` chip; assert only the transcribed-run row remains.
   * 3. Tap that row; assert its brief and run log text render.
   * 4. Tap the `all` chip; assert both rows are back.
   */
  test("an Activity row expands to the brief and run log, and the chips filter", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await mockBackend(page);
    await page.goto(`/${SERVER}/9?tab=activity`);

    const rows = page.getByTestId("operator-activity-row");
    await expect(rows).toHaveCount(2, { timeout: 10_000 });
    await page.getByTestId("operator-activity-filter-runs").click();
    await expect(rows).toHaveCount(1);
    await rows.first().getByRole("button").click();
    await expect(page.getByTestId("operator-activity-brief")).toContainText("# the brief");
    await expect(page.getByTestId("operator-activity-log")).toContainText("the run log");
    await page.getByTestId("operator-activity-filter-all").click();
    await expect(rows).toHaveCount(2);
  });

  /**
   * Proves: Check now posts the trigger door exactly once with the server and
   * the button reads `check queued` afterwards.
   *
   * Steps:
   * 1. Set the 375×812 viewport; mock the backend (capturing wake POSTs); land
   *    on `/default/9?tab=activity`.
   * 2. Tap `Check now`.
   * 3. Assert one POST with body `{server: "default"}` was captured and the
   *    button reads `check queued` while the held activity read is pending,
   *    then returns to `Check now`.
   */
  test("Check now posts the wake once", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    const { wakePosts } = await mockBackend(page);
    await page.goto(`/${SERVER}/9?tab=activity`);

    const button = page.getByTestId("operator-activity-check-now");
    await expect(button).toHaveText("Check now", { timeout: 10_000 });
    await button.click();
    await expect.poll(() => wakePosts.length).toBe(1);
    expect(wakePosts[0]).toEqual({ server: SERVER });
    await expect(button).toHaveText("check queued");
    await expect(button).toHaveText("Check now", { timeout: 10_000 });
    expect(wakePosts).toHaveLength(1);
  });

  /**
   * Proves: a `?tab=list` deep link lands directly on the Cron List segment
   * with no extra tap.
   *
   * Steps:
   * 1. Set the 375×812 viewport; mock the backend.
   * 2. Navigate straight to `/default/9?tab=list`.
   * 3. Assert the Cron List body renders with its entry row and the Cron List
   *    tab is selected.
   */
  test("?tab=list deep link lands on the Cron List segment", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await mockBackend(page);
    await page.goto(`/${SERVER}/9?tab=list`);

    await expect(page.getByTestId("cron-list")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("cron-list-row-a3f9")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Cron List" })).toHaveAttribute("aria-selected", "true");
  });

  /**
   * Proves: tapping the Tasks segment swaps the content in place —
   * the watchlist (the monitored worker rows) appears, the URL gains
   * `?tab=tasks`, and the page does NOT reload (an in-page probe survives the
   * tap, and the terminal's relay registration persists — the terminal is
   * hidden, not unmounted).
   *
   * Steps:
   * 1. Set the 375×812 viewport; mock the backend (the @2 window carries the
   *    monitored facets); land on `/default/9`.
   * 2. Stamp `window.__tasksProbe` as a reload tripwire.
   * 3. Tap the Tasks tab.
   * 4. Assert the watchlist renders the worker row, the URL carries
   *    `tab=tasks`, the probe is still set, and `__rkTerminals["@9"]` is
   *    still registered.
   */
  test("tapping Tasks swaps the content slot without a full reload", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await mockBackend(page);
    await gotoWindowMobile(page, "@9");
    await page.evaluate(() => {
      (window as unknown as { __tasksProbe?: string }).__tasksProbe = "alive";
    });

    await page.getByRole("tab", { name: "Tasks" }).click();

    const tasks = page.getByTestId("watched-tasks");
    await expect(tasks).toBeVisible({ timeout: 10_000 });
    await expect(tasks.getByTestId("watched-row")).toHaveCount(1);
    await expect(tasks.getByText("watched-worker")).toBeVisible();
    await expect(page).toHaveURL(/tab=tasks/);
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __tasksProbe?: string }).__tasksProbe ?? null),
      )
      .toBe("alive");
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean((window as unknown as { __rkTerminals?: Record<string, unknown> }).__rkTerminals?.["@9"]),
        ),
      )
      .toBe(true);
  });

  /**
   * Proves: a `?tab=tasks` deep link lands directly on the Tasks segment
   * (the watchlist) with no extra tap.
   *
   * Steps:
   * 1. Set the 375×812 viewport; mock the backend.
   * 2. Navigate straight to `/default/9?tab=tasks`.
   * 3. Assert the watchlist renders with the worker row and the Tasks tab is
   *    selected (the header gate resolves once the sessions
   *    payload lands).
   */
  test("?tab=tasks deep link lands on the Tasks segment", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await mockBackend(page);
    await page.goto(`/${SERVER}/9?tab=tasks`);

    const tasks = page.getByTestId("watched-tasks");
    await expect(tasks).toBeVisible({ timeout: 10_000 });
    await expect(tasks.getByText("watched-worker")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Tasks" })).toHaveAttribute("aria-selected", "true");
  });

  /**
   * Proves: the operator-staleness banner pins ABOVE the Activity body when a
   * session reports `operatorStale`, and renders above neither the cron tabs
   * nor the Terminal segment.
   *
   * Steps:
   * 1. Set the 375×812 viewport; mock the backend with a stale operator tick;
   *    land on `/default/9` (the terminal segment).
   * 2. Assert no banner renders.
   * 3. Tap Activity; assert the banner is visible and sits above the activity
   *    body (bounding-box y).
   * 4. Tap Cron Log, then Cron List; assert no banner renders above either.
   * 5. Tap Terminal; assert no banner renders.
   */
  test("the stale banner mounts above Activity only", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await mockBackend(page, { stale: true });
    await gotoWindowMobile(page, "@9");

    await expect(tabStrip(page)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("cron-activity-banner")).toHaveCount(0);

    await page.getByRole("tab", { name: "Activity" }).click();
    const banner = page.getByTestId("cron-activity-banner");
    await expect(banner).toBeVisible({ timeout: 10_000 });
    const bannerBox = await banner.boundingBox();
    const activityBox = await page.getByTestId("operator-activity").boundingBox();
    expect(bannerBox!.y).toBeLessThan(activityBox!.y);

    await page.getByRole("tab", { name: "Cron Log" }).click();
    await expect(page.getByTestId("cron-log")).toBeVisible({ timeout: 10_000 });
    await expect(banner).toHaveCount(0);

    await page.getByRole("tab", { name: "Cron List" }).click();
    await expect(page.getByTestId("cron-list")).toBeVisible({ timeout: 10_000 });
    await expect(banner).toHaveCount(0);

    await page.getByRole("tab", { name: "Terminal" }).click();
    await expect(page.getByTestId("cron-activity-banner")).toHaveCount(0);
  });

  /**
   * Proves: Cron List's `+ New entry` affordance opens the create dialog.
   *
   * Steps:
   * 1. Set the 375×812 viewport; mock the backend; land on `/default/9` and
   *    switch to Cron List.
   * 2. Click `+ New entry`.
   * 3. Assert the `New cron entry` dialog renders.
   */
  test("+ New entry opens the create dialog", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await mockBackend(page);
    await page.goto(`/${SERVER}/9?tab=list`);
    await expect(page.getByTestId("cron-list")).toBeVisible({ timeout: 10_000 });

    await page.getByTestId("cron-list-new").click();

    await expect(page.getByRole("dialog", { name: "New cron entry" })).toBeVisible();
  });

  /**
   * Proves: the entry detail sheet's `Edit` row opens the create dialog in
   * edit mode (`Edit entry` title, `Save` submit), and saving POSTs ONLY the
   * changed fields to `/api/cron/edit`.
   *
   * Steps:
   * 1. Set the 375×812 viewport; mock the backend; land on
   *    `/default/9?tab=list`.
   * 2. Open the entry's detail sheet from its Cron List row.
   * 3. Click the `Edit` row; assert the `Edit entry` dialog renders.
   * 4. Change only the Name field and click Save.
   * 5. Assert exactly one edit POST landed with `{id, name}` (no unchanged
   *    fields) and the dialog closed.
   */
  test("the detail sheet's Edit row opens the edit-mode dialog and saves changed fields only", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    const { editPosts } = await mockBackend(page);
    await page.goto(`/${SERVER}/9?tab=list`);
    await expect(page.getByTestId("cron-list")).toBeVisible({ timeout: 10_000 });

    await page.getByTestId("cron-list-row-a3f9").click();
    const sheet = page.getByTestId("cron-entry-sheet");
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Edit", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Edit entry" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox", { name: "Name" }).fill("renamed tick");
    await dialog.getByRole("button", { name: "Save" }).click();

    await expect.poll(() => editPosts).toEqual([{ id: "a3f9", name: "renamed tick" }]);
    await expect(page.getByRole("dialog", { name: "Edit entry" })).toHaveCount(0);
  });

  /**
   * Proves: the detail sheet's `Mute for…` expander offers the lease presets
   * and picking `2h` POSTs `{id, muted: true, for: "2h"}` to
   * `/api/cron/mute` — the lease rides the existing mute route as an additive
   * field.
   *
   * Steps:
   * 1. Set the 375×812 viewport; mock the backend; land on
   *    `/default/9?tab=list`.
   * 2. Open the entry's detail sheet from its Cron List row.
   * 3. Expand `Mute for…`; assert the four presets render.
   * 4. Click `2h`; assert exactly one mute POST landed with the `for` field.
   */
  test("the Mute for… 2h preset posts the additive lease field", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    const { mutePosts } = await mockBackend(page);
    await page.goto(`/${SERVER}/9?tab=list`);
    await expect(page.getByTestId("cron-list")).toBeVisible({ timeout: 10_000 });

    await page.getByTestId("cron-list-row-a3f9").click();
    const sheet = page.getByTestId("cron-entry-sheet");
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Mute for…" }).click();
    const presets = sheet.getByRole("group", { name: "Mute duration" });
    await expect(presets.getByRole("button")).toHaveText(["30m", "2h", "8h", "until unmuted"]);

    await presets.getByRole("button", { name: "2h", exact: true }).click();

    await expect.poll(() => mutePosts).toEqual([{ id: "a3f9", muted: true, for: "2h" }]);
  });
});
