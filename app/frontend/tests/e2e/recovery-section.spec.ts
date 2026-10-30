import { test, expect, type Page } from "@playwright/test";

// Recovery section on the Host Overview (`/`) — the zone for
// reboot-orphaned tmux servers whose layout snapshots survived on disk. It
// renders ONLY when GET /api/recovery returns a non-empty offers list (zero
// footprint otherwise), slotted between the WORKSPACES and SERVICES zones
// with a SectionHeading labelled "Recovery". Each offer renders one row: a
// hollow (non-live) dot, the server name, a meta line, a Restore button, an ×
// dismiss button, and a chevron that expands a read-only session tree.
// Restore all (N) and Dismiss all ride the heading's side slot when more than
// one offer exists and run sequential per-server restore/dismiss POSTs (no
// bulk endpoint). The offer list and both mutating POSTs are route-mocked
// (the mutating routes carry the trailing `*` glob — the mutating-route
// idiom from the withServer era, kept so a query string can never slip past
// the mock). Everything else (state socket, boards, metrics) rides the real
// e2e backend.
//
// Shared setup: **/api/recovery (GET) → {"offers": [...]} from a MUTABLE list
// the mutation tests shrink before the component's post-mutation refetch,
// plus a call counter that proves mount-fetch + refetch;
// **/api/recovery/restore* (POST) → 200 with a report body, request body
// captured; **/api/recovery/dismiss* (POST) → 200 {"ok":true}, body captured.
// **/api/servers (GET) → a single server `dev`, so the WORKSPACES zone is
// deterministic (the section under test sits directly below it, and a restore
// success refetches this list). Two offer fixtures: `kit` (one session `dev`
// with color 4, a 1-pane zsh window and a 2-pane `zsh, claude -c` tab flagged
// resumable, takenAt one hour old) and `work` (two sessions, three tabs,
// takenAt two minutes old). Readiness signal: the `WORKSPACES` zone heading
// is visible. Rows are located by data-testid="recovery-row-<server>"; the
// expanded tree by data-testid="recovery-session-<name>"; controls by their
// accessible names.

const OFFER_KIT = {
  server: "kit",
  takenAt: new Date(Date.now() - 3600_000).toISOString(),
  sessionCount: 1,
  windowCount: 2,
  sessions: [
    {
      name: "dev",
      color: "4",
      windows: [
        { index: 0, name: "shell", paneCount: 1, commands: ["zsh"], resumable: false },
        { index: 1, name: "agent", paneCount: 2, commands: ["zsh", "claude -c"], resumable: true },
      ],
    },
  ],
};

const OFFER_WORK = {
  server: "work",
  takenAt: new Date(Date.now() - 120_000).toISOString(),
  sessionCount: 2,
  windowCount: 3,
  sessions: [
    {
      name: "ops",
      windows: [
        { index: 0, name: "logs", paneCount: 1, commands: ["htop"], resumable: false },
      ],
    },
  ],
};

/** Route-mock the recovery endpoints. `offers` is mutable so a mutation test
 *  can shrink the list the refetch then returns. Returns request loggers. */
async function mockRecovery(page: Page, offers: object[]) {
  const state = { offers };
  const getCount = { n: 0 };
  const restoreBodies: unknown[] = [];
  const dismissBodies: unknown[] = [];

  // Mutating routes first (trailing `*` — a `?server=` suffix must never miss
  // the mock); the plain GET glob matches `/api/recovery` exactly, never the
  // POST subpaths.
  await page.route("**/api/recovery/restore*", async (route) => {
    restoreBodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessionsCreated: 1 }),
    });
  });
  await page.route("**/api/recovery/dismiss*", async (route) => {
    dismissBodies.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
  });
  await page.route("**/api/recovery", async (route) => {
    getCount.n += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ offers: state.offers }),
    });
  });

  return { state, getCount, restoreBodies, dismissBodies };
}

/** Deterministic WORKSPACES zone — the section under test sits between it
 *  and SERVICES, and a restore success refetches this list. */
async function mockServers(page: Page) {
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ name: "dev", sessionCount: 1 }]),
    }),
  );
}

async function gotoHost(page: Page) {
  await page.goto("/");
  // Readiness: the WORKSPACES zone has rendered its (mocked) tile grid.
  await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible({
    timeout: 15_000,
  });
}

test.describe("Recovery section", () => {
  /**
   * Proves: with an empty offers list the section leaves no heading, no
   * region landmark, and no reserved space — the surrounding zones render
   * normally.
   *
   * Steps:
   * 1. Mock /api/recovery with an empty offers list; load `/`.
   * 2. Assert no `region` or `heading` named "Recovery" exists.
   * 3. Assert the neighbouring `Services` zone heading renders.
   */
  test("empty offers render NO Recovery section — zero footprint between WORKSPACES and SERVICES", async ({
    page,
  }) => {
    await mockRecovery(page, []);
    await mockServers(page);
    await gotoHost(page);

    await expect(page.getByRole("region", { name: "Recovery" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Recovery" })).toHaveCount(0);
    // The surrounding zones render normally — nothing reserved the space.
    await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();
  });

  /**
   * Proves: the section anatomy — heading, one row per offer (hollow dot,
   * meta line, Restore + dismiss buttons), and the Restore-all control in the
   * heading's side slot gated on more than one offer.
   *
   * Steps:
   * 1. Mock two offers (`kit`, `work`); load `/`.
   * 2. Assert the `Recovery` region and heading are visible, plus the
   *    `Restore all (2)` button.
   * 3. On the `kit` row assert the hollow dot (`not running`), the meta line
   *    `1 session · 2 tabs · last seen 1h ago · system restart`, and the
   *    `Restore kit` / `Dismiss recovery for kit` buttons; assert the `work`
   *    row exists.
   */
  test("populated offers render the heading, one row per offer, and Restore all (2)", async ({
    page,
  }) => {
    await mockRecovery(page, [OFFER_KIT, OFFER_WORK]);
    await mockServers(page);
    await gotoHost(page);

    const region = page.getByRole("region", { name: "Recovery" });
    await expect(region).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recovery" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Restore all (2)" })).toBeVisible();

    const kitRow = page.getByTestId("recovery-row-kit");
    await expect(kitRow).toBeVisible();
    await expect(kitRow.getByRole("img", { name: "not running" })).toBeVisible();
    await expect(kitRow).toContainText("1 session · 2 tabs · last seen 1h ago · system restart");
    await expect(kitRow.getByRole("button", { name: "Restore kit" })).toBeVisible();
    await expect(kitRow.getByRole("button", { name: "Dismiss recovery for kit" })).toBeVisible();
    await expect(page.getByTestId("recovery-row-work")).toBeVisible();
  });

  /**
   * Proves: the row's expand affordance reveals the offer payload's inline
   * layout tree — no second request — with tabs, pane counts, former
   * commands, and the display-only resumable tag.
   *
   * Steps:
   * 1. Mock one offer (`kit`); load `/`.
   * 2. Assert the toggle starts aria-expanded="false" and no `resumable` tag
   *    is in the DOM.
   * 3. Click `Show layout for kit`; assert the toggle flips to `Hide layout
   *    for kit` with aria-expanded="true" and the tree carries the session
   *    name, both tab lines (`0: shell · 1 pane`, `1: agent · 2 panes`), the
   *    joined former commands (`zsh, claude -c`), and the `resumable` tag.
   * 4. Assert the tree contains no buttons (read-only — no resume
   *    affordance).
   */
  test("the chevron expands the read-only session tree (swatch, tabs, commands, resumable tag)", async ({
    page,
  }) => {
    await mockRecovery(page, [OFFER_KIT]);
    await mockServers(page);
    await gotoHost(page);

    const toggle = page.getByRole("button", { name: "Show layout for kit" });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("resumable")).toHaveCount(0);

    await toggle.click();
    // The toggle's accessible name flips Show → Hide with the state.
    const expandedToggle = page.getByRole("button", { name: "Hide layout for kit" });
    await expect(expandedToggle).toHaveAttribute("aria-expanded", "true");
    const tree = page.getByTestId("recovery-session-dev");
    await expect(tree).toBeVisible();
    await expect(tree).toContainText("dev");
    await expect(tree).toContainText("0: shell · 1 pane");
    await expect(tree).toContainText("1: agent · 2 panes");
    await expect(tree).toContainText("zsh, claude -c");
    await expect(tree.getByText("resumable")).toBeVisible();

    // Read-only: the tree carries no buttons (no resume affordance).
    await expect(tree.getByRole("button")).toHaveCount(0);
  });

  /**
   * Proves: the restore flow's success path — body-addressed POST, row
   * removal, and the mount-fetch + post-mutation refetch cadence.
   *
   * Steps:
   * 1. Mock two offers; load `/`; assert the `kit` row and exactly one GET so
   *    far.
   * 2. Shrink the mocked offers to `work` only (what the backend returns
   *    after the restore), then click `Restore kit`.
   * 3. Assert one restore POST with body {"server": "kit"}.
   * 4. Assert the `kit` row is gone, `work` remains, and the GET counter
   *    reaches 2 (mount fetch + post-mutation refetch).
   */
  test("restore POSTs the server name, removes the row, and refetches the offers", async ({
    page,
  }) => {
    const { state, getCount, restoreBodies } = await mockRecovery(page, [OFFER_KIT, OFFER_WORK]);
    await mockServers(page);
    await gotoHost(page);
    await expect(page.getByTestId("recovery-row-kit")).toBeVisible();
    expect(getCount.n).toBe(1);

    // The backend drops the offer once restored — the refetch returns less.
    state.offers = [OFFER_WORK];
    await page.getByRole("button", { name: "Restore kit" }).click();

    await expect.poll(() => restoreBodies.length).toBe(1);
    expect(restoreBodies[0]).toEqual({ server: "kit" });
    await expect(page.getByTestId("recovery-row-kit")).toHaveCount(0);
    await expect(page.getByTestId("recovery-row-work")).toBeVisible();
    // Mount fetch + the post-mutation refetch.
    await expect.poll(() => getCount.n).toBe(2);
  });

  /**
   * Proves: the dismiss flow — POST, then the row leaves the offer list.
   *
   * Steps:
   * 1. Mock two offers; load `/`.
   * 2. Shrink the mocked offers to `work` only, then click
   *    `Dismiss recovery for kit`.
   * 3. Assert one dismiss POST with body {"server": "kit"}.
   * 4. Assert the `kit` row is gone and `work` remains.
   */
  test("dismiss POSTs the server name and removes the row", async ({ page }) => {
    const { state, dismissBodies } = await mockRecovery(page, [OFFER_KIT, OFFER_WORK]);
    await mockServers(page);
    await gotoHost(page);
    await expect(page.getByTestId("recovery-row-kit")).toBeVisible();

    state.offers = [OFFER_WORK];
    await page.getByRole("button", { name: "Dismiss recovery for kit" }).click();

    await expect.poll(() => dismissBodies.length).toBe(1);
    expect(dismissBodies[0]).toEqual({ server: "kit" });
    await expect(page.getByTestId("recovery-row-kit")).toHaveCount(0);
    await expect(page.getByTestId("recovery-row-work")).toBeVisible();
  });

  /**
   * Proves: the heading's Dismiss-all control drives the same sequential
   * per-server dismiss flow as the per-row × (one POST per offer, no bulk
   * endpoint), and with every offer dismissed the Recovery region disappears
   * entirely — zero footprint.
   *
   * Steps:
   * 1. Mock two offers (`kit`, `work`); load `/`; assert the `Dismiss all`
   *    button is visible in the heading's side slot.
   * 2. Empty the mocked offers list (what the backend returns once everything
   *    is dismissed), then click `Dismiss all`.
   * 3. Assert two dismiss POSTs land, in offer order: {"server": "kit"} then
   *    {"server": "work"}.
   * 4. Assert the `Recovery` region has left the DOM.
   */
  test("Dismiss all POSTs one dismiss per server and the section leaves the DOM", async ({
    page,
  }) => {
    const { state, dismissBodies } = await mockRecovery(page, [OFFER_KIT, OFFER_WORK]);
    await mockServers(page);
    await gotoHost(page);
    await expect(page.getByRole("button", { name: "Dismiss all" })).toBeVisible();

    // The backend drops each offer once dismissed — the refetches return less,
    // then nothing.
    state.offers = [];
    await page.getByRole("button", { name: "Dismiss all" }).click();

    await expect.poll(() => dismissBodies.length).toBe(2);
    expect(dismissBodies).toEqual([{ server: "kit" }, { server: "work" }]);
    await expect(page.getByRole("region", { name: "Recovery" })).toHaveCount(0);
  });
});
