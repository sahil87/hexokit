import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import { apiBase } from "./_boards";
import { READY_TIMEOUT, gotoServerReady } from "./_ready";
import { TMUX_SERVER, createSession, killSession } from "./_tmux";

/**
 * End-to-end coverage for the server-persisted sidebar session order.
 * Verifies the backend → tmux user-option → SSE → frontend render path lines
 * up, and that the persisted order survives a page reload (the order lives in
 * tmux, not the browser). Drag simulation is intentionally NOT used —
 * Playwright's HTML5 DnD simulation is fragile, and the contract under test
 * is "whatever the server has, the sidebar shows," not the drag mechanics
 * themselves.
 *
 * Shared setup: spawns three named tmux sessions on the e2e tmux server
 * (`rk-test-e2e` by default, overridable via `E2E_TMUX_SERVER`):
 * `reorder-alpha-{ts}`, `reorder-bravo-{ts}`, `reorder-charlie-{ts}`.
 * `afterAll` kills the sessions and unsets `@rk_srv_session_order` to leave
 * the server clean for the next run.
 */

const TIMESTAMP = Date.now();
const SESSIONS = [
  `reorder-alpha-${TIMESTAMP}`,
  `reorder-bravo-${TIMESTAMP}`,
  `reorder-charlie-${TIMESTAMP}`,
];

test.describe("Sidebar session reorder persistence", () => {
  test.beforeAll(() => {
    for (const name of SESSIONS) createSession(name);
  });

  test.afterAll(() => {
    for (const name of SESSIONS) killSession(name);
    // Reset the user-option so the next run starts clean.
    try {
      execSync(`tmux -L ${TMUX_SERVER} set-option -us @rk_srv_session_order`, {
        stdio: "ignore",
      });
    } catch {
      // best effort
    }
  });

  // FIXME: this test has never passed. Two compounding problems:
  //   1. It drove persistence with `request.put`, but the endpoint is POST-only
  //      (constitution IX) — it only ever got a 405. Fixed below to POST.
  //   2. Even with the verb fixed, the `page.reload()` step cannot commit: the
  //      app holds a long-lived SSE connection (and Vite's HMR socket) open, so
  //      the reload navigation never reaches commit/domcontentloaded and times
  //      out. Re-`goto` to the same route hits the same wall.
  // Verifying "persisted order survives a reload" needs a reload-free approach
  // (e.g. assert in a fresh browser context instead of reloading the page).
  // Kept as fixme rather than deleted so the intent and the POST contract are
  // preserved for whoever revisits it. Not counted as a CI failure.
  /**
   * Proves: an order persisted via `POST /api/sessions/order` is delivered to
   * the sidebar via the eager SSE `session-order` broadcast and survives a
   * page reload (re-delivered on connect via the cached snapshot). This
   * exercises the full production path — the same one the drag UI uses.
   *
   * Steps:
   * 1. Build the desired custom order: `[charlie, alpha, bravo]`.
   * 2. Send `POST /api/sessions/order?server={TMUX_SERVER}` with body
   *    `{"order": [charlie, alpha, bravo]}`. Assert the response is OK.
   * 3. Navigate to `/{TMUX_SERVER}` and wait for "Connected" (the status
   *    bar's `Connected` dot — the desktop sidebar footer is gone).
   * 4. Wait for all three test sessions to render in the sidebar.
   * 5. Use `expect.poll` to read the rendered order (collected from each
   *    session row's `aria-label='Navigate to {name}'` button, in DOM order,
   *    filtered to the three test sessions). Assert it matches
   *    `[charlie, alpha, bravo]`. `expect.poll` covers the SSE→React-state
   *    propagation lag without committing to a fixed sleep.
   * 6. Reload the page and wait for "Connected" + all sessions visible.
   * 7. Re-poll the order and assert it still matches `[charlie, alpha, bravo]`
   *    — reload does not affect the persisted order.
   */
  test.fixme("server-persisted order survives a page reload via SSE", async ({
    page,
    request,
    baseURL,
  }) => {
    const customOrder = [SESSIONS[2], SESSIONS[0], SESSIONS[1]];

    // Drive persistence through the API — this matches the production path
    // (frontend POST → backend → tmux user-option → SSE broadcast) and avoids
    // the timing dependency on the hub's first-poll bootstrap. All mutating
    // endpoints are POST per constitution principle IX (no PUT/PATCH/DELETE);
    // this previously used PUT and only ever got a 405.
    const url = `${apiBase(baseURL)}/api/sessions/order?server=${TMUX_SERVER}`;
    const postResp = await request.post(url, {
      headers: { "Content-Type": "application/json" },
      data: { order: customOrder },
    });
    if (!postResp.ok()) {
      const body = await postResp.text();
      throw new Error(`POST ${url} → ${postResp.status()}: ${body}`);
    }

    await gotoServerReady(page, TMUX_SERVER);

    const sidebar = page.locator("nav[aria-label='Sessions']");
    for (const name of SESSIONS) {
      await expect(sidebar.locator(`text=${name}`)).toBeVisible({
        timeout: 5_000,
      });
    }

    // expect.poll covers the SSE → React state propagation lag without
    // committing to a fixed wait.
    await expect
      .poll(
        async () =>
          await sidebar.evaluate((el, sessionNames: string[]) => {
            const buttons = el.querySelectorAll("button[aria-label^='Navigate to ']");
            const order: string[] = [];
            buttons.forEach((b) => {
              const label = b.getAttribute("aria-label") ?? "";
              const m = label.match(/^Navigate to (.+)$/);
              if (m) order.push(m[1]);
            });
            return order.filter((n) => sessionNames.includes(n));
          }, SESSIONS),
        { timeout: 5_000 },
      )
      .toEqual(customOrder);

    // Reload — order MUST survive because it lives in tmux, not the browser.
    // NOTE (see the test.fixme above): this reload does not commit against the
    // SSE-held SPA under Vite and times out. Left in place to document intent;
    // the test is skipped until a reload-free verification is written.
    await page.reload();
    await expect(page.getByTestId("status-bar").locator("[aria-label='Connected']")).toBeVisible({
      timeout: READY_TIMEOUT,
    });
    for (const name of SESSIONS) {
      await expect(sidebar.locator(`text=${name}`)).toBeVisible({
        timeout: 5_000,
      });
    }

    await expect
      .poll(
        async () =>
          await sidebar.evaluate((el, sessionNames: string[]) => {
            const buttons = el.querySelectorAll("button[aria-label^='Navigate to ']");
            const order: string[] = [];
            buttons.forEach((b) => {
              const label = b.getAttribute("aria-label") ?? "";
              const m = label.match(/^Navigate to (.+)$/);
              if (m) order.push(m[1]);
            });
            return order.filter((n) => sessionNames.includes(n));
          }, SESSIONS),
        { timeout: 5_000 },
      )
      .toEqual(customOrder);
  });
});
