import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { gotoServerReady, openPalette } from "./_ready";
import { TMUX_SERVER, createSession, killSession } from "./_tmux";

/**
 * Covers the save-as-style session name prompt behind the palette's
 * `Group: Create` action (one flow, two entry points — the `create-session`
 * chord resolves through the same palette body, but the chord is
 * browser-reserved in a non-shell host, so e2e exercises the palette entry
 * point).
 *
 * Shared setup: `beforeAll` seeds one detached session (`e2e-prompt-<ts>`) on
 * the isolated `rk-test-e2e` tmux server so the `/$server` route has stable
 * content; `afterAll` kills the seed session plus (best-effort) the sessions
 * the tests create: the prefill-accepted `session` and the typed
 * `e2e_named_<ts>`.
 */

const SEED_SESSION = `e2e-prompt-${Date.now()}`;
const TYPED_NAME = `e2e_named_${Date.now()}`;

/** True when a session with exactly `name` exists on the e2e tmux server. */
function tmuxHasSession(name: string): boolean {
  try {
    execFileSync("tmux", ["-L", TMUX_SERVER, "has-session", "-t", `=${name}`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** Open the palette, select `Group: Create`, and return the prompt's name
 *  input. The option's accessible name is `label — description`, so the
 *  anchored regex tolerates the descriptor while staying unambiguous (a
 *  sibling like `Group: Create at Folder` continues with ` at`, not ` —`). */
async function openPrompt(page: Page) {
  const paletteInput = await openPalette(page);
  await paletteInput.fill("Group: Create");
  const option = page.getByRole("option", { name: /^Group: Create( —|$)/ });
  await expect(option).toBeVisible({ timeout: 10_000 });
  await option.click();
  const dialog = page.getByRole("dialog", { name: "New group" });
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  return { dialog, input: dialog.getByRole("textbox", { name: "Group name" }) };
}

test.describe("Group name prompt (Group: Create)", () => {
  test.beforeAll(() => {
    createSession(SEED_SESSION);
  });

  test.afterAll(() => {
    killSession(SEED_SESSION);
    // Best-effort teardown of sessions the tests create.
    killSession("session");
    killSession(TYPED_NAME);
  });

  /**
   * Proves: Escape closes the prompt without creating a session — the cancel
   * path is a true no-op.
   *
   * Steps:
   * 1. Go to `/$server` (ready-gated).
   * 2. Open the prompt via the palette; read the prefilled value and assert
   *    it matches the no-current-window fallback shape `session(-N)`.
   * 3. Press Escape; assert the dialog unmounts.
   * 4. Assert via `tmux has-session` on the isolated server that no session
   *    with the prefilled name exists.
   */
  test("Escape cancels — prompt closes, nothing is created", async ({ page }) => {
    await gotoServerReady(page, TMUX_SERVER);
    const { dialog, input } = await openPrompt(page);

    // On /$server there is no current window, so the prefill is the bare
    // fallback base (deduped only if taken).
    const prefill = await input.inputValue();
    expect(prefill).toMatch(/^session(-\d+)?$/);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(tmuxHasSession(prefill)).toBe(false);
  });

  /**
   * Proves: the prompt opens pre-filled with the auto-derived name instant
   * create would have used, and a bare Enter creates exactly that session.
   *
   * Steps:
   * 1. Go to `/$server`; open the prompt via the palette.
   * 2. Assert the input is prefilled with the derived fallback name
   *    (`session(-N)` — no current window on the density route).
   * 3. Press Enter in the input; assert the dialog closes.
   * 4. Assert the session tile for the prefilled name appears on the density
   *    view (SSE-driven, 10s timeout).
   */
  test("Enter accepts the prefilled default — today's behavior plus one keystroke", async ({
    page,
  }) => {
    await gotoServerReady(page, TMUX_SERVER);
    const { dialog, input } = await openPrompt(page);

    const prefill = await input.inputValue();
    expect(prefill).toMatch(/^session(-\d+)?$/);
    await input.press("Enter");

    await expect(dialog).toHaveCount(0);
    // The created session surfaces as a tile on the /$server density view.
    await expect(page.getByTestId(`session-tile-${prefill}`)).toBeVisible({
      timeout: 10_000,
    });
  });

  /**
   * Proves: the prefill is select-all'd on open, so typing replaces it in one
   * gesture and Enter creates the typed name instead.
   *
   * Steps:
   * 1. Go to `/$server`; open the prompt via the palette.
   * 2. Type a unique name (`e2e_named_<ts>`) — no manual clearing — and
   *    assert the input value equals exactly the typed name (selection
   *    replaced).
   * 3. Press Enter; assert the dialog closes.
   * 4. Assert the session tile for the typed name appears.
   */
  test("typing overrides the default — the typed name is created", async ({ page }) => {
    await gotoServerReady(page, TMUX_SERVER);
    const { dialog, input } = await openPrompt(page);

    // The prefill is select-all'd on open, so typing replaces it outright.
    await page.keyboard.type(TYPED_NAME);
    await expect(input).toHaveValue(TYPED_NAME);
    await input.press("Enter");

    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId(`session-tile-${TYPED_NAME}`)).toBeVisible({
      timeout: 10_000,
    });
  });
});
