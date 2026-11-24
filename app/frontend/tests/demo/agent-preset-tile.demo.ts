/**
 * Demo: a Workspaces tile for a workspace that is protected, external, and has
 * its own agent preset — the narrowest case for the tile's preset chip, since
 * the shield and external glyphs already share the name line with the name.
 *
 * Runs under `just demo agent-preset-tile` on desktop and mobile. Everything is
 * stubbed in the browser: `/api/servers` carries the protected, unmanaged
 * workspace with own `codex-review`, `/api/fab-config` the machine preset list,
 * and the state socket one group. Besides the video, the demo saves a
 * close-up PNG of the tile next to it (`<name>[-<variant>]-<project>-tile.png`)
 * because the tile is too small to read in a full-viewport recording.
 */
import { join } from "node:path";
import { test, expect, beat } from "./_demo";
import { mockStateSocket } from "../e2e/_state-socket-mock";

const SERVER = "default";
const PRESETS = [
  { name: "claude", description: "All roles on Claude (today's defaults)", source: "built-in" },
  { name: "codex-review", description: "Only the review role on Codex", source: "built-in" },
];

const sessionsJson = JSON.stringify([
  {
    name: "dev",
    windows: [
      {
        windowId: "@1",
        index: 0,
        name: "main",
        worktreePath: "/tmp/repo",
        activity: "active",
        isActiveWindow: true,
        activityTimestamp: 0,
      },
    ],
  },
]);

test.describe("agent-preset-tile demo", () => {
  /**
   * Proves: the protected + external workspace tile shows its own-preset chip
   * alongside the shield, external glyph and name.
   *
   * Steps:
   * 1. Serve a protected, unmanaged workspace with own codex-review.
   * 2. Open the page (and the drawer on mobile) and dwell on the Workspaces tile.
   * 3. Save a close-up screenshot of the tile.
   */
  test("protected external workspace tile shows its preset chip", async ({ page }, testInfo) => {
    const mobile = testInfo.project.name === "mobile";
    await page.routeWebSocket(/\/ws\/terminals/, () => {});
    await page.route("**/api/boards", (route) => route.fulfill({ json: [] }));
    await page.route("**/api/servers", (route) =>
      route.fulfill({
        json: [{ name: SERVER, sessionCount: 1, protected: true, managed: false, agent_preset: "codex-review" }],
      }),
    );
    await page.route("**/api/fab-config", (route) =>
      route.fulfill({
        json: {
          installed: true,
          agent_presets: PRESETS,
          fields: { "agent.preset": { value: "claude", origin: "system" } },
        },
      }),
    );
    await mockStateSocket(page, { sessions: sessionsJson });

    await page.goto(`/${SERVER}/1`);
    await expect(page.getByRole("button", { name: "Rename tab main" })).toBeVisible({ timeout: 10_000 });
    if (mobile) await page.getByRole("button", { name: "Toggle navigation" }).tap();
    const tile = page.getByRole("listbox", { name: "Workspaces" }).getByRole("option", { name: /default/ });
    await expect(tile.getByTestId(`shield-${SERVER}`)).toBeVisible();
    await beat(page, 2_000);

    const outDir = process.env.DEMO_OUT_DIR;
    const name = process.env.DEMO_NAME;
    if (outDir && name) {
      const variant = process.env.DEMO_VARIANT;
      const file = `${name}${variant ? `-${variant}` : ""}-${testInfo.project.name}-tile.png`;
      await tile.screenshot({ path: join(outDir, file), scale: "device" });
    }
  });
});
