import { test, expect } from "@playwright/test";
import { gotoServerReady, openPalette } from "./_ready";
import { TMUX_SERVER, TMUX_FAMILY, killServer } from "./_tmux";

/**
 * Behavioural contract for the transient "Workspace not found" flash after
 * creating a tmux server: creating a server through the command palette must
 * land on the working server view without ever rendering the "Server not
 * found" error screen, and the not-found screen must still show for a
 * genuinely-unknown server URL.
 *
 * Shared setup: no `beforeAll` session setup — the first test relies only on
 * the always-present e2e tmux server (`E2E_TMUX_SERVER`, the worktree's
 * derived e2e primary) being non-empty so the server list is loaded and
 * non-empty (the precondition under which the old `servers.length > 0` guard
 * misfired). `afterAll` `kill-server`s the server the test created; the name
 * is built from this worktree's `TMUX_FAMILY` anchor with the Playwright
 * `process.pid` as the second-to-last hyphen field, so the family-anchored
 * global teardown also reaps it if `afterAll` is missed. Desktop viewport
 * (1024×768).
 */

// Server created through the UI during the test. Named inside this worktree's
// socket family (TMUX_FAMILY anchor) with the Playwright process.pid as the
// second-to-last hyphen field so the automatic post-sweep can parse it and the
// family-anchored teardown glob reaps it even if afterAll's kill-server is
// missed. The create dialog validates `^[a-zA-Z0-9_-]+$`, so hyphens are safe.
const CREATED_SERVER = `${TMUX_FAMILY}csw-${process.pid}-${Date.now().toString().slice(-6)}`;
const TMUX_SERVER_A = TMUX_SERVER;
const DESKTOP_VIEWPORT = { width: 1024, height: 768 };

test.describe("Create server → waiting → view (no 'Workspace not found' flash)", () => {
  test.afterAll(() => {
    // Best-effort — the teardown glob also reaps this worktree's family.
    killServer(CREATED_SERVER);
  });

  /**
   * Proves: when the user creates a new server via the command palette while at
   * least one server already exists (list loaded and non-empty), the UI
   * navigates to the new server and reaches the connected server view without
   * the "Workspace not found" error screen appearing — the pending-marker +
   * three-way guard suppress the false negative the old binary guard produced.
   *
   * Steps:
   * 1. Navigate to the existing e2e server (`/${TMUX_SERVER_A}`) and wait for
   *    the `Connected` indicator in the status bar (the desktop sidebar footer
   *    is gone, so the status-bar dot is the gate).
   * 2. Open the command palette (`openPalette`), type `Workspace: Create`, press Enter.
   * 3. In the New sheet (Workspace level), clear the folder, open the name
   *    override (Ctrl/⌘+Enter), fill the `Workspace name` field with the
   *    freshly-generated server name and press Enter.
   * 4. Assert the URL navigates to `/${CREATED_SERVER}`.
   * 5. Race two outcomes — whichever appears first wins: the `Connected`
   *    indicator becoming visible vs. the "Workspace not found" text becoming
   *    visible. Each side swallows its own 15s timeout so the loser can't
   *    surface as an unhandled rejection.
   * 6. Assert the race winner is `connected`, not `not-found`. Racing (rather
   *    than asserting `toHaveCount(0)` only after `Connected` settles) is what
   *    catches a *transient* flash: if the error screen renders even briefly
   *    during navigation it wins the race and the test fails.
   */
  test("creating a server lands on the server view, never flashing 'Workspace not found'", async ({
    page,
  }) => {
    test.setTimeout(30_000);

    // Start on a server that already exists, so the server list is non-empty
    // and loaded — this is exactly the condition under which the old binary
    // guard (`servers.length > 0`) wrongly flashed "Workspace not found" for a
    // freshly-created server.
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await gotoServerReady(page, TMUX_SERVER_A);

    // Open the command palette and trigger "Workspace: Create".
    const paletteInput = await openPalette(page);
    await paletteInput.fill("Workspace: Create");
    await page.keyboard.press("Enter");

    // The palette opens the New sheet at Workspace level. Blank the folder
    // (the default is the current tab's folder), open the name override with
    // Ctrl/⌘+Enter, type the freshly-generated name, and submit.
    const folderInput = page.getByRole("combobox", { name: "Folder" });
    await expect(folderInput).toBeVisible({ timeout: 5_000 });
    await folderInput.fill("");
    await folderInput.press("ControlOrMeta+Enter");
    // Role-scoped: the status bar's `Copy workspace name` button shares the
    // "Workspace name" substring, so a bare getByLabel is ambiguous.
    const nameInput = page.getByRole("textbox", { name: "Workspace name" });
    await expect(nameInput).toBeVisible({ timeout: 5_000 });
    await nameInput.fill(CREATED_SERVER);
    await nameInput.press("Enter");

    // The URL navigates to the new server immediately.
    await expect(page).toHaveURL(new RegExp(`/${CREATED_SERVER}(?:$|[/?#])`));

    // The fix's core promise is that we reach the working server view WITHOUT
    // ever rendering the "Workspace not found" error screen — not even for a frame.
    // Asserting `toHaveCount(0)` only after "Connected" settles would miss a
    // transient flash (the screen would have come and gone by then), so instead
    // race the two outcomes: the first of "Connected appears" vs. "Server not
    // found appears" to win decides the test. If the error screen flashes during
    // navigation it wins the race and we fail; reaching "Connected" first proves
    // no flash occurred.
    // Each side swallows its own timeout rejection so the loser (which never
    // appears on the happy path and times out after the winner resolves) can't
    // surface as an unhandled rejection.
    const connected = page
      .getByTestId("status-bar")
      .locator("[aria-label='Connected']")
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => "connected" as const)
      .catch(() => "timeout" as const);
    const notFound = page
      .getByText("Workspace not found")
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => "not-found" as const)
      .catch(() => "timeout" as const);
    const winner = await Promise.race([connected, notFound]);
    expect(winner, "'Workspace not found' flashed before the server view loaded").toBe(
      "connected",
    );
  });

  /**
   * Proves: the not-found screen is preserved for real typos / deleted servers —
   * a name that was never created and is not pending fails fast once the server
   * list has loaded.
   *
   * Steps:
   * 1. Navigate directly to a randomly-generated, never-created server URL.
   * 2. Assert the "Workspace not found" screen becomes visible.
   */
  test("a genuinely-unknown server URL still shows 'Workspace not found'", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    // A name that was never created and is not pending must fail fast once the
    // server list has loaded — the not-found path is preserved for typos.
    const bogus = `${TMUX_FAMILY}nope-${process.pid}-${Date.now().toString().slice(-6)}`;
    await page.goto(`/${bogus}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Workspace not found")).toBeVisible({
      timeout: 15_000,
    });
  });
});
