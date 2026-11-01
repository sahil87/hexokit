/**
 * Demo: the tab-cycle chord pressed while the pending-switch spinner mask is
 * up. Before: the mask's keyboard swallow drops ⇧⌃↓ and the tab stays put.
 * After: the chord passes through and the next tab opens.
 *
 * Runs only under `just demo mask-chords` (optionally `--before`), against the
 * throwaway e2e rig. Desktop only — the shifted-tier chords are a hardware
 * keyboard affordance with no mobile surface.
 *
 * Shared setup: fully mocked, mirroring `tests/e2e/shortcut-registry.spec.ts`
 * — one server `default`, session `dev` with tabs `@1`–`@3` over the stubbed
 * `/ws/state`, `select` POSTs answered 200, and a `/ws/terminals` stub that
 * never delivers bytes, so every switch stays unconfirmed and the spinner mask
 * arms at its ~300ms grace threshold — the exact window the chord must
 * survive.
 */
import type { Page } from "@playwright/test";
import { test, expect, beat, desktopOnly } from "./_demo";
import { seedComposeStrip } from "../e2e/_ready";
import { mockStateSocket } from "../e2e/_state-socket-mock";

const SERVER = "default";

function sessionsPayload(): string {
  const win = (id: number, name: string, active: boolean) => ({
    windowId: `@${id}`,
    index: id - 1,
    name,
    worktreePath: `/tmp/${name}`,
    activity: active ? "active" : "idle",
    isActiveWindow: active,
    activityTimestamp: 0,
    agentState: "idle",
  });
  return JSON.stringify([
    { name: "dev", windows: [win(1, "win-one", true), win(2, "win-two", false), win(3, "win-three", false)] },
  ]);
}

async function mockBackend(page: Page): Promise<void> {
  await page.routeWebSocket(/\/ws\/terminals/, () => {});
  await page.route("**/api/windows/*/select*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }),
  );
  await page.route("**/api/windows/*/options*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }),
  );
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ name: SERVER, sessionCount: 1 }]),
    }),
  );
  await mockStateSocket(page, { sessions: sessionsPayload() });
}

test.describe("mask-chords demo", () => {
  /**
   * Proves: ⇧⌃↓ pressed while the pending-switch mask is showing still steps
   * to the next tab.
   *
   * Steps:
   * 1. Mock the backend; open `/default/1`; `beat()`.
   * 2. Press Shift+Ctrl+Down → `/default/2`; wait for the spinner mask;
   *    `beat()` so the mask is on screen.
   * 3. Press Shift+Ctrl+Down again; `beat()` — the base build stays on
   *    win-two, the fix lands on win-three.
   */
  test("tab-cycle chord during the pending-switch mask", async ({ page }, info) => {
    desktopOnly(info);
    await seedComposeStrip(page, false);
    await mockBackend(page);
    await page.goto(`/${SERVER}/1`);
    await expect(page.getByText("win-one").first()).toBeVisible();
    await beat(page, 1_500);

    await page.keyboard.press("Shift+Control+ArrowDown");
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/2(?:$|[/?#])`));
    await expect(page.locator(".rk-window-switch-mask")).toBeVisible();
    await beat(page, 1_500);

    await page.keyboard.press("Shift+Control+ArrowDown");
    await beat(page, 2_500);
  });
});
