/**
 * Demo: the ChatGPT connector section in Settings → General. Before: the
 * General tab ends at the MCP endpoint row; there is no way to put the host's
 * tools in front of ChatGPT. After: the connector rows sit under the MCP
 * endpoint: turning the switch on asks for setup, a pasted tunnel ID and key
 * are saved (the key write-only, "Saved"), and the status line follows the
 * daemon's `openai-mcp` event.
 *
 * Runs only under `just demo openai-mcp` (optionally `--before`), against the
 * throwaway e2e rig, desktop and mobile. The rig's backend runs in the
 * foreground with no rk-daemon tmux session, so the configured end state is
 * "Not running: rk daemon is not running" and nothing is spawned or
 * downloaded; the live-tunnel run is separate PR evidence.
 *
 * Shared setup: real rig backend, no mocks. The connector is reset through
 * the API before and after (switch off, tunnel ID unset, key cleared), so the
 * recording starts from a fresh install's state and leaves none behind. The
 * tunnel ID and key are well-formed fakes.
 */
import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { test, expect, beat } from "./_demo";
import { openPalette } from "../e2e/_ready";

const FAKE_KEY = "sk-demo-fake-key-0123456789abcdefghij";
const TUNNEL_ID = "tunnel_0123456789abcdef0123456789abcdef";

/** A real daemon session on this host's fixed `rk-daemon` socket: the rig
 *  cannot isolate it, so the connector routes would act on its sessions. */
function hostHasLiveDaemon(): boolean {
  try {
    execFileSync("tmux", ["-L", "rk-daemon", "has-session", "-t", "=rk-daemon"], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function resetConnector(page: Page) {
  await page.request.post("/api/settings", { data: { "openai_mcp.enabled": false, "openai_mcp.tunnel_id": null } });
  await page.request.post("/api/openai-mcp/key", { data: { key: "" } });
}

test.describe("openai-mcp demo", () => {
  test.skip(hostHasLiveDaemon(), "a real rk-daemon runs on this host; the connector routes would act on its sessions");

  /**
   * Proves: Settings → General carries the ChatGPT connector rows, and the
   * on → tunnel ID → key flow is saved through the live daemon with the key
   * never shown again.
   *
   * Steps:
   * 1. Reset the connector; open the host page; open Settings via the
   *    palette (both viewports, the agents-settings demo's route); scroll
   *    the MCP endpoint row into view; `beat()`.
   * 2. Base build: `beat()` on the tab as it is, then stop.
   * 3. This build: click the `ChatGPT connector` switch; wait for
   *    data-state `unconfigured`; `beat()`.
   * 4. Type the tunnel ID and press Tab; `beat()`.
   * 5. Type the key, click Save; wait for `Saved` and the daemon-down
   *    `stopped` state; `beat()`.
   * 6. Reset the connector.
   */
  test("ChatGPT connector in Settings → General", async ({ page }) => {
    await resetConnector(page).catch(() => undefined);
    await page.goto("/");
    const input = await openPalette(page);
    await input.fill("Settings: Open");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByTestId("settings-mcp-endpoint").scrollIntoViewIfNeeded();
    await beat(page, 2_000);

    const toggle = dialog.getByRole("switch", { name: "ChatGPT connector" });
    if ((await toggle.count()) === 0) {
      await beat(page, 3_000);
      return;
    }

    const statusLine = dialog.getByTestId("settings-openai-mcp-status");
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click();
    await expect(statusLine).toHaveAttribute("data-state", "unconfigured", { timeout: 15_000 });
    await statusLine.scrollIntoViewIfNeeded();
    await beat(page, 2_000);

    const tunnel = dialog.getByLabel("Tunnel ID");
    await tunnel.pressSequentially(TUNNEL_ID, { delay: 15 });
    await page.keyboard.press("Tab");
    await beat(page, 1_500);

    const key = dialog.getByLabel("API key");
    await key.pressSequentially(FAKE_KEY, { delay: 15 });
    await dialog.getByRole("button", { name: "Save key" }).click();
    await expect(dialog.getByText("Saved", { exact: true })).toBeVisible();
    await expect(statusLine).toHaveAttribute("data-state", "stopped", { timeout: 15_000 });
    await statusLine.scrollIntoViewIfNeeded();
    await beat(page, 3_000);

    await resetConnector(page);
  });
});
