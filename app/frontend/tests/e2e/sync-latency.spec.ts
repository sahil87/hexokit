/**
 * Sync-latency audit — measures time from user action to UI reflection.
 *
 * Actions with optimistic updates should reflect in <500ms.
 * Actions relying solely on SSE will take up to 2500ms (the poll interval).
 *
 * Threshold: 500ms. Anything above suggests the action is waiting for SSE
 * rather than using an optimistic update.
 *
 * This `@perf` suite is excluded from default e2e runs. Run it on demand with
 * `just pw test sync-latency --list` (omit `--list` to execute the audit).
 *
 * Shared setup: `beforeAll` creates sessions `e2e-lat-a-<ts>` and
 * `e2e-lat-b-<ts>` so the tests have distinct targets for rename, drag, and
 * cross-session move; the per-test timeout is bumped (20s, 45s on CI) since
 * some drag interactions legitimately exceed Playwright's default 10s.
 * `setup(page)` navigates to `/${TMUX_SERVER}`, waits for `Connected`, then
 * gates on ANY session row being rendered (`aria-label^='Navigate to '`) —
 * name-agnostic on purpose: test 2 renames the shared SESSION_A via the UI,
 * so a gate hard-wired to a specific name would strand every later
 * `setup()` once the rename lands, time out, and trigger a Playwright
 * worker restart (which re-seeds a fresh, un-renamed SESSION_A and breaks
 * tests assuming the rename). `afterAll` best-effort kills both sessions,
 * the renamed variant, the kill-session scratch, the instant-create
 * defaults (`session`, `session-2`…`session-11`), and any live
 * `e2e-lat-xtgt-<ts>` cross-drag targets (enumerated by prefix), then
 * prints a summary table of all timings, flagging any action that exceeded
 * the 500ms threshold.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import { READY_TIMEOUT, gotoServerReady } from "./_ready";
import { TMUX_SERVER, createSession, killSession, newWindow } from "./_tmux";

const SESSION_A = `e2e-lat-a-${Date.now()}`;
const SESSION_B = `e2e-lat-b-${Date.now()}`;

const OPTIMISTIC_THRESHOLD_MS = 500;

interface TimingResult {
  action: string;
  ms: number;
  optimistic: boolean;
}

const results: TimingResult[] = [];

function record(action: string, ms: number) {
  const optimistic = ms < OPTIMISTIC_THRESHOLD_MS;
  results.push({ action, ms, optimistic });
  console.log(
    `  [${optimistic ? "FAST" : "SLOW"}] ${action}: ${ms}ms${optimistic ? "" : " ← SSE-dependent"}`,
  );
}

/**
 * Navigate to the tmux server dashboard and wait until the sidebar is usable.
 * `Connected` (SSE socket open) is necessary but not sufficient: the first
 * session payload lands a beat later, so a test that acts the instant
 * `Connected` shows would hit an empty sidebar. Gate on *any* session row
 * being rendered so every test starts from a populated sidebar regardless of
 * runner speed.
 *
 * The gate is name-agnostic (`Navigate to ` prefix via `aria-label^=`) on
 * purpose: test 2 renames the shared SESSION_A via the UI, so a gate
 * hard-wired to `Navigate to ${SESSION_A}` would strand every subsequent
 * `setup()` once the rename lands, time out, and trigger a Playwright worker
 * restart — which re-seeds a fresh, un-renamed SESSION_A and breaks later
 * tests that assumed the rename. Matching any session row keeps the gate
 * stable across the file's mutations (SESSION_B is always present, but we
 * don't depend on a specific name).
 */
async function setup(page: import("@playwright/test").Page) {
  const sidebar = await gotoServerReady(page, TMUX_SERVER);
  await expect(sidebar.locator(`button[aria-label^='Navigate to ']`).first()).toBeVisible({
    timeout: READY_TIMEOUT,
  });
  return sidebar;
}

/**
 * Hover a session row until ITS flyout card is the open one, then enter the
 * card at the row's own band and return the card locator. Two pointer
 * realities make this a loop: (1) while SSE is still settling on a freshly
 * loaded page, a row layout-shift under the stationary pointer fires a
 * sibling row's hover intent (a mouseover with no mousemove) and opens THAT
 * row's card; (2) entering the card must ride the reference row's band — a
 * diagonal sweep to a bottom action row crosses the sibling sidebar row and
 * hover-intent retargets the card mid-transit.
 */
async function openSessionCard(
  page: import("@playwright/test").Page,
  sidebar: ReturnType<import("@playwright/test").Page["locator"]>,
  session: string,
) {
  const sessionRow = sidebar.locator(`[data-session-row="${TMUX_SERVER}:${session}"]`);
  const card = page.getByTestId("row-flyout-card");
  await expect(async () => {
    await page.mouse.move(700, 500);
    await sessionRow.hover();
    await expect(card).toContainText(`Group ${session}`, { timeout: 3_000 });
  }).toPass({ timeout: 15_000 });
  const rowBox = (await sessionRow.boundingBox())!;
  const cardBox = (await card.boundingBox())!;
  await page.mouse.move(cardBox.x + 16, rowBox.y + rowBox.height / 2);
  return card;
}

test.describe("@perf Sync Latency Audit", () => {
  // Each test pays a readiness gate (up to READY_TIMEOUT) before its measured
  // action; give CI headroom so the gate can't exhaust the per-test budget.
  test.setTimeout(process.env.CI ? 45_000 : 20_000);

  test.beforeAll(() => {
    createSession(SESSION_A);
    createSession(SESSION_B);
  });

  test.afterAll(() => {
    // Best-effort cleanup. Instant-create sessions land on auto-derived names
    // ("session", "session-2", etc.) so we also sweep those here.
    const names = [
      SESSION_A,
      SESSION_B,
      // Test 2's UI rename commits the underscored form (the session-kind
      // live transform converts hyphens — 260722-ln4n).
      `${SESSION_A}-renamed`.replace(/-/g, "_"),
      `e2e-kill-${SESSION_A}`,
      "session",
    ];
    for (let i = 2; i <= 11; i++) names.push(`session-${i}`);
    // Test 7 creates dedicated cross-drag target sessions named
    // `e2e-lat-xtgt-<ts>`; sweep any that are live (a worker restart can leave
    // more than one). Enumerate by prefix since the timestamp is test-scoped.
    try {
      const live = execSync(`tmux -L ${TMUX_SERVER} list-sessions -F "#{session_name}"`)
        .toString()
        .trim()
        .split("\n")
        .filter((n) => n.startsWith("e2e-lat-xtgt-"));
      names.push(...live);
    } catch { /* ok — no server or no sessions */ }
    for (const s of names) killSession(s);

    console.log("\n=== SYNC LATENCY SUMMARY ===");
    console.log(`Threshold: ${OPTIMISTIC_THRESHOLD_MS}ms\n`);
    for (const r of results) {
      console.log(`  [${r.optimistic ? "FAST" : "SLOW"}] ${r.action}: ${r.ms}ms`);
    }
    const slow = results.filter(r => !r.optimistic);
    if (slow.length > 0) {
      console.log(`\n${slow.length} action(s) appear SSE-dependent (>${OPTIMISTIC_THRESHOLD_MS}ms):`);
      for (const r of slow) console.log(`  - ${r.action} (${r.ms}ms)`);
    } else {
      console.log("\nAll actions appear to have optimistic updates.");
    }
    console.log("=== END SUMMARY ===\n");
  });

  /**
   * Proves: clicking the Dashboard's `+ New group` card creates a session
   * instantly (no dialog, auto-derived name) and a ghost entry renders in
   * the sidebar in ≤500ms.
   *
   * Steps:
   * 1. `setup(page)` — navigate, wait for `Connected`, return the sidebar
   *    locator.
   * 2. Count existing `button[aria-label^='Navigate to ']` rows.
   * 3. Start the timer.
   * 4. Click `button:has-text('+ New group')`.
   * 5. Poll until the count increases (timeout 8s).
   * 6. `record("Create session (UI)", elapsed)`.
   */
  test("1. Create session via UI", async ({ page }) => {
    const sidebar = await setup(page);

    // "+ New group" performs instant creation with an auto-derived name
    // (no dialog, no input). Measure the time for the new session row to
    // appear — a ghost entry should show up optimistically well under 500ms.
    const beforeCount = await sidebar.locator("button[aria-label^='Navigate to ']").count();

    const t0 = Date.now();
    await page.click("button:has-text('+ New group')");

    await expect
      .poll(
        () => sidebar.locator("button[aria-label^='Navigate to ']").count(),
        { timeout: 8_000 },
      )
      .toBeGreaterThan(beforeCount);
    record("Create session (UI)", Date.now() - t0);
  });

  /**
   * Proves: double-clicking a session name opens an inline input; pressing
   * Enter commits an optimistic rename and the new name renders in ≤500ms.
   * The input applies the live session-kind safe-name transform (hyphens
   * convert to `_`), so the committed name is the underscored form of what
   * was filled.
   *
   * Steps:
   * 1. `setup`.
   * 2. Wait for the `Navigate to ${SESSION_A}` button (this test runs
   *    before any rename, so SESSION_A's original name is still present).
   * 3. Double-click the session name to enter edit mode.
   * 4. Clear and fill the input with `${SESSION_A}-renamed`; assert the
   *    input value is its underscored form (the live transform converted
   *    the hyphens).
   * 5. Start timer, press Enter.
   * 6. Wait for the new (underscored) name text to appear; `record`. (The
   *    `afterAll` sweep kills the underscored name.)
   */
  test("2. Rename group via UI (double-click)", async ({ page }) => {
    const sidebar = await setup(page);

    const sessionNav = sidebar.locator(`button[aria-label='Navigate to ${SESSION_A}']`);
    await expect(sessionNav).toBeVisible({ timeout: 8_000 });

    // Double-click session name to enter edit mode
    await sidebar.locator(`text=${SESSION_A}`).first().dblclick();

    const input = sidebar.locator("input[type='text']").first();
    await expect(input).toBeVisible({ timeout: 2_000 });
    await input.clear();
    // The session rename input live-converts unsafe/steered chars as they land
    // (260722-ln4n): the session-kind transform converts hyphens to "_", so
    // filling the hyphenated string commits its underscored form.
    await input.fill(`${SESSION_A}-renamed`);
    const newName = `${SESSION_A}-renamed`.replace(/-/g, "_");
    await expect(input).toHaveValue(newName);

    const t0 = Date.now();
    await input.press("Enter");

    await expect(
      sidebar.locator(`text=${newName}`).first(),
    ).toBeVisible({ timeout: 8_000 });
    record("Rename group (UI double-click)", Date.now() - t0);
  });

  /**
   * Proves: the session flyout card's `New tab` action row creates a window
   * optimistically — a ghost window row appears under SESSION_B in ≤500ms,
   * without waiting for the SSE poll. This is an audit: it records the real
   * appearance latency and the summary flags it `[SLOW] ← SSE-dependent`
   * (rather than hard-failing the suite) if the create path ever regresses
   * to SSE-dependent (>500ms). Tolerant if the session row isn't visible
   * (session not rendered).
   *
   * Steps:
   * 1. `setup`.
   * 2. Assert session B is visible.
   * 3. If SESSION_B's session row is visible: scope to SESSION_B's window
   *    rows via the wrapper's stable `data-session-group="${SESSION_B}"`
   *    handle and count its `[data-window-id]` rows; open SESSION_B's flyout
   *    card via `openSessionCard` (re-hover until THIS session's card is the
   *    open one — a row layout-shift under the stationary pointer can fire a
   *    sibling's hover intent while SSE settles — then enter the card at the
   *    row's own band, since a diagonal sweep to a bottom action row crosses
   *    the sibling sidebar row and retargets the card mid-transit); start the
   *    timer, click the card's `New tab` action row (no dialog on the
   *    current-server create path — the dialog guard is a tolerant no-op);
   *    poll (bounded 8s) until the window-row count exceeds the pre-click
   *    count and `record` the elapsed latency. The name is auto-derived, so
   *    detection is by count increase (mirroring test 1), not by name.
   * 4. Otherwise log SKIP.
   */
  test("3. Create window via sidebar card row", async ({ page }) => {
    const sidebar = await setup(page);

    // Expand session B to see its windows
    await expect(sidebar.locator(`text=${SESSION_B}`).first()).toBeVisible({ timeout: 8_000 });

    // The new-tab seam is the session flyout card's create action row.
    const sessionRow = sidebar.locator(`[data-session-row="${TMUX_SERVER}:${SESSION_B}"]`);

    if (await sessionRow.isVisible().catch(() => false)) {
      // Scope to SESSION_B's window rows via the wrapper's stable
      // `data-session-group` handle (sidebar/index.tsx) — keyed by session
      // name, so it selects exactly SESSION_B's wrapper with no relational
      // `.filter({ has })` anchoring.
      // `[data-window-id]` is the canonical, stable window-row handle (real
      // windows = tmux `@N`, ghost rows = `ghost-<optimisticId>`) — the same
      // one sidebar-window-sync.spec.ts selects by. The auto-derived window
      // name is unpredictable, so we detect "a new row appeared" by a count
      // increase rather than by name, mirroring test 1's session-level
      // row-count poll.
      const sessionBGroup = sidebar.locator(`[data-session-group="${SESSION_B}"]`);
      const winRows = sessionBGroup.locator("[data-window-id]");
      const beforeCount = await winRows.count();

      // Open the card BEFORE the timer starts (hover opens on a delay) so the
      // recorded value is the true time-to-first-ghost-appearance — the
      // bounded poll timeout below only bounds the failure case, it does not
      // inflate the measurement the way the old fixed `waitForTimeout(3_000)`
      // did.
      const card = await openSessionCard(page, sidebar, SESSION_B);

      const t0 = Date.now();
      await card.getByTestId("row-flyout-create-action").click();

      // The sidebar create path on the current server is instant (no
      // dialog) — an optimistic ghost row lands immediately. The dialog guard
      // is a tolerant no-op for any path that does surface one.
      const dialog = page.locator("[role='dialog']");
      if (await dialog.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await dialog.locator("button:has-text('Create')").click();
      }

      // Wait for a NEW window row to appear under SESSION_B and record the
      // real elapsed latency (FAST <500ms when the optimistic ghost appears;
      // SLOW only if create regresses to SSE-dependent).
      await expect
        .poll(() => winRows.count(), { timeout: 8_000 })
        .toBeGreaterThan(beforeCount);
      record("Create window (UI, card New tab row)", Date.now() - t0);
    } else {
      console.log("  [SKIP] No session row found — session may not have rendered");
    }
  });

  /**
   * Proves: double-click rename on a window runs optimistically — the new
   * name renders in ≤500ms.
   *
   * Steps:
   * 1. Create a `rename-me` window in session B via the tmux helper.
   * 2. `setup`; assert `rename-me` is visible.
   * 3. Double-click the window name to enter edit mode; clear and fill
   *    `renamed-win`.
   * 4. Start timer, press Enter, wait for the new name, `record`.
   */
  test("4. Rename window via UI (double-click)", async ({ page }) => {
    newWindow(SESSION_B, "rename-me");

    const sidebar = await setup(page);

    await expect(sidebar.locator("text=rename-me").first()).toBeVisible({ timeout: 8_000 });

    // Double-click window name to enter edit mode
    await sidebar.locator("text=rename-me").first().dblclick();

    const input = sidebar.locator("input[type='text']").first();
    await expect(input).toBeVisible({ timeout: 2_000 });
    await input.clear();
    await input.fill("renamed-win");

    const t0 = Date.now();
    await input.press("Enter");

    await expect(
      sidebar.locator("text=renamed-win").first(),
    ).toBeVisible({ timeout: 8_000 });
    record("Rename window (UI double-click)", Date.now() - t0);
  });

  /**
   * Proves: Ctrl+click on the window's kill button performs an instant kill
   * with no confirm dialog; the row disappears in ≤500ms.
   *
   * Steps:
   * 1. Create a `kill-me` window in session B via the tmux helper.
   * 2. `setup`; assert `kill-me` is visible.
   * 3. Hover the `kill-me` row — the icon cluster is `pointer-events-none`
   *    at rest (stray-click hardening), so group-hover must restore
   *    interactivity before the kill button can receive the click.
   * 4. Start timer, `click({ modifiers: ['Control'] })` on the kill button.
   * 5. Wait for `kill-me` to disappear, `record`.
   */
  test("5. Kill window via Ctrl+click (instant)", async ({ page }) => {
    newWindow(SESSION_B, "kill-me");

    const sidebar = await setup(page);
    await expect(sidebar.locator("text=kill-me").first()).toBeVisible({ timeout: 8_000 });

    const killBtn = sidebar.locator("button[aria-label='Kill tab kill-me']");

    // The icon cluster is pointer-events-none at rest (stray-click hardening);
    // hover the row first so group-hover restores interactivity, mirroring how
    // a real cursor reaches the kill button.
    await sidebar.locator("text=kill-me").first().hover();

    const t0 = Date.now();
    await killBtn.click({ modifiers: ["Control"] });

    await expect(sidebar.locator("text=kill-me")).not.toBeVisible({ timeout: 8_000 });
    record("Kill window (Ctrl+click)", Date.now() - t0);
  });

  /**
   * Proves: dragging a window over another within the same session reorders
   * them optimistically.
   *
   * Steps:
   * 1. Create `dnd-first` and `dnd-second` in session B.
   * 2. `setup`.
   * 3. Read bounding boxes of both rows.
   * 4. Timer, perform mouse `move → down → move → up` from second onto
   *    first.
   * 5. Poll up to 5s (50 × 100ms) for the order to flip (second above first
   *    by `y`).
   * 6. `record` either success or "order did not change".
   */
  test("6. Move window within session (drag-drop reorder)", async ({ page }) => {
    newWindow(SESSION_B, "dnd-first");
    newWindow(SESSION_B, "dnd-second");

    const sidebar = await setup(page);

    const first = sidebar.locator("text=dnd-first").first();
    const second = sidebar.locator("text=dnd-second").first();
    await expect(first).toBeVisible({ timeout: 8_000 });
    await expect(second).toBeVisible({ timeout: 8_000 });

    // Record positions before drag
    const firstBB = await first.boundingBox();
    const secondBB = await second.boundingBox();

    if (firstBB && secondBB) {
      // Drag second onto first position
      const t0 = Date.now();
      await page.mouse.move(secondBB.x + secondBB.width / 2, secondBB.y + secondBB.height / 2);
      await page.mouse.down();
      await page.mouse.move(firstBB.x + firstBB.width / 2, firstBB.y + firstBB.height / 2, { steps: 10 });
      await page.mouse.up();

      // Check if the order changed — poll every 100ms up to 5s
      let reordered = false;
      for (let i = 0; i < 50; i++) {
        const newFirstBB = await sidebar.locator("text=dnd-second").first().boundingBox();
        const newSecondBB = await sidebar.locator("text=dnd-first").first().boundingBox();
        if (newFirstBB && newSecondBB && newFirstBB.y < newSecondBB.y) {
          reordered = true;
          break;
        }
        await page.waitForTimeout(100);
      }

      const elapsed = Date.now() - t0;
      if (reordered) {
        record("Move window within session (drag-drop)", elapsed);
      } else {
        record("Move window within session (drag-drop) — order did not change", elapsed);
      }
    } else {
      console.log("  [SKIP] Could not get bounding boxes");
    }
  });

  /**
   * Proves: dragging a window onto a different session row moves it across
   * sessions. Self-contained: the test creates its own dedicated target
   * session `e2e-lat-xtgt-<ts>` rather than relying on test 2 having
   * renamed the shared SESSION_A — that coupling broke on any Playwright
   * worker restart (the re-seeded SESSION_A is never renamed).
   *
   * Steps:
   * 1. Create a dedicated target session `e2e-lat-xtgt-<ts>` via the tmux
   *    helper.
   * 2. Create `cross-mv` window in session B.
   * 3. `setup`; assert both `cross-mv` and the target session are visible.
   * 4. Read bounding boxes.
   * 5. Timer, drag-drop source over target.
   * 6. Poll up to 5s for the source row to disappear from under session B.
   * 7. `record` either "moved" or "may not have moved".
   */
  test("7. Move window to another session (cross-session drag)", async ({ page }) => {
    // Self-contained: create both the source window and a dedicated target
    // session this test owns. Earlier this dragged onto `${SESSION_A}-renamed`,
    // relying on test 2 having renamed the shared SESSION_A in the same worker
    // — a coupling that breaks on any worker restart (the re-seeded SESSION_A
    // is never renamed). Owning the target removes the ordering dependency.
    const crossTarget = `e2e-lat-xtgt-${Date.now()}`;
    createSession(crossTarget);
    newWindow(SESSION_B, "cross-mv");

    const sidebar = await setup(page);

    await expect(sidebar.locator("text=cross-mv").first()).toBeVisible({ timeout: 8_000 });
    await expect(sidebar.locator(`text=${crossTarget}`).first()).toBeVisible({ timeout: 8_000 });

    const source = sidebar.locator("text=cross-mv").first();
    const target = sidebar.locator(`text=${crossTarget}`).first();
    const sourceBB = await source.boundingBox();
    const targetBB = await target.boundingBox();

    if (sourceBB && targetBB) {
      const t0 = Date.now();
      await page.mouse.move(sourceBB.x + sourceBB.width / 2, sourceBB.y + sourceBB.height / 2);
      await page.mouse.down();
      await page.mouse.move(targetBB.x + targetBB.width / 2, targetBB.y + targetBB.height / 2, { steps: 10 });
      await page.mouse.up();

      // Check if the window disappeared from session B's area (moved to session A)
      let moved = false;
      for (let i = 0; i < 50; i++) {
        // Window should no longer be under session B
        const stillVisible = await sidebar.locator("text=cross-mv").isVisible().catch(() => false);
        if (!stillVisible) {
          moved = true;
          break;
        }
        await page.waitForTimeout(100);
      }

      const elapsed = Date.now() - t0;
      if (moved) {
        record("Move window to another session (cross-drag)", elapsed);
      } else {
        record("Move window cross-session (drag-drop) — may not have moved", elapsed);
      }
    } else {
      console.log("  [SKIP] Could not get bounding boxes");
    }
  });

  /**
   * Proves: baseline — external tmux mutations (no optimistic path) must
   * take at least one SSE poll interval (~2.5s) to show up. A faster time
   * here would imply an unintended optimistic path.
   *
   * Steps:
   * 1. `setup`.
   * 2. Timer, run `tmux new-window -t ${SESSION_B} -n ext-<ts>`.
   * 3. Wait for the window to appear, `record`. Expected to be [SLOW].
   */
  test("8. External tmux change (SSE baseline)", async ({ page }) => {
    const sidebar = await setup(page);
    const winName = `ext-${Date.now()}`;

    const t0 = Date.now();
    newWindow(SESSION_B, winName);

    await expect(sidebar.locator(`text=${winName}`)).toBeVisible({ timeout: 8_000 });
    record("External tmux new-window (SSE baseline)", Date.now() - t0);
  });

  /**
   * Proves: the kill-session confirm dialog is dismissed and the session
   * row disappears in ≤500ms after confirming.
   *
   * Steps:
   * 1. Create `e2e-kill-${SESSION_A}` via the tmux helper.
   * 2. `setup`; assert the session row is visible.
   * 3. Open the session's flyout card via `openSessionCard` (re-hover until
   *    THIS session's card is open, then enter at the row's own band — see
   *    test 3's notes); timer, click the card's `Kill group` action row.
   * 4. Wait for `[role='dialog']` to appear.
   * 5. Click `button:has-text('Kill')` inside the dialog (with
   *    `{ force: true }` to bypass occasional overlay pointer
   *    interception).
   * 6. Wait for the row to disappear, `record`.
   */
  test("9. Kill group via UI (with dialog)", async ({ page }) => {
    const killVictim = `e2e-kill-${SESSION_A}`;
    createSession(killVictim);

    const sidebar = await setup(page);
    await expect(sidebar.locator(`text=${killVictim}`).first()).toBeVisible({ timeout: 8_000 });

    // The kill seam is the session flyout card's kill action row — open the
    // card before the timed click (see openSessionCard for the re-hover loop
    // and band entry).
    const card = await openSessionCard(page, sidebar, killVictim);

    const t0 = Date.now();
    await card.getByTestId("row-flyout-kill-action").click();

    // Wait for the kill dialog to appear, then click the Kill confirm button inside it
    const dialog = page.locator("[role='dialog']");
    await expect(dialog).toBeVisible({ timeout: 3_000 });
    // Click the red Kill button inside the dialog (force to bypass any overlay issues)
    await dialog.locator("button:has-text('Kill')").click({ force: true });

    await expect(
      sidebar.locator(`text=${killVictim}`),
    ).not.toBeVisible({ timeout: 8_000 });
    record("Kill group (UI, confirm dialog)", Date.now() - t0);
  });
});
