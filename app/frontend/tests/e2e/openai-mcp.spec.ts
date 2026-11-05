import { test, expect, type Page } from "@playwright/test";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { gotoServerReady, openPalette } from "./_ready";
import { SETTINGS_PATH } from "./_settings";
import { TMUX_SERVER } from "./_tmux";

/**
 * ChatGPT connector: the Settings → General section that runs OpenAI's
 * tunnel-client (docs/specs/openai-mcp.md). These tests prove the contracts
 * unit tests cannot: the section renders inside the real dialog, writes
 * reach the live daemon (settings POST, the write-only key route), the key
 * never comes back over the API, and the status line follows the daemon's
 * `openai-mcp` stream event end to end.
 *
 * Shared setup: the rig's backend runs in the foreground with no rk-daemon
 * tmux session, so a configured connector reports "Not running: rk daemon is
 * not running" and nothing is spawned or downloaded; the tests assert that
 * state instead of a live tunnel (the real-tunnel pass is the PR's external
 * integration evidence). `beforeAll` snapshots the settings file
 * (SETTINGS_PATH, per-run temp under `just test-e2e`, the developer's real
 * config under `just pw`) and the connector key file under XDG_STATE_HOME
 * (the same per-run temp the harness hands the backend); `afterAll` restores
 * both verbatim or deletes what did not exist. The key used is a well-formed
 * fake that never leaves the rig. `afterEach` resets the connector through
 * the API before `afterAll` restores files, so nothing is left switched on.
 *
 * Host guard: the daemon's tmux socket name (`rk-daemon`) is fixed and the rig
 * does not isolate TMUX_TMPDIR, so on a host running a real daemon the
 * connector routes would act on its real sessions (restart a live
 * `rk-openai-mcp` with the fake key). The suite skips there, with the reason.
 */

const FAKE_KEY = "sk-e2e-fake-key-0123456789abcdefghij";
const TUNNEL_ID = "tunnel_e2e0123456789abcdef";

const STATE_HOME = process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.trim() !== ""
  ? process.env.XDG_STATE_HOME
  : join(homedir(), ".local", "state");
const KEY_PATH = join(STATE_HOME, "hexokit", "openai-mcp", "api-key");

/** A real daemon session on this host's fixed `rk-daemon` socket. */
function hostHasLiveDaemon(): boolean {
  try {
    execFileSync("tmux", ["-L", "rk-daemon", "has-session", "-t", "=rk-daemon"], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}
const LIVE_DAEMON = hostHasLiveDaemon();

let settingsSnapshot: Buffer | undefined;
let keySnapshot: Buffer | undefined;

function snapshot(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return undefined;
  }
}

function restore(path: string, data: Buffer | undefined, mode: number) {
  try {
    if (data !== undefined) {
      mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(path, data, { mode });
    } else {
      rmSync(path, { force: true });
    }
  } catch (err) {
    console.warn(`openai-mcp e2e: could not restore ${path}:`, err);
  }
}

async function openGeneralSettings(page: Page) {
  const input = await openPalette(page);
  await input.fill("Settings: Open");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  return dialog;
}

async function pollSetting(page: Page, key: string): Promise<unknown> {
  const res = await page.request.get("/api/settings");
  const body = (await res.json()) as { settings: Array<{ key: string; value: unknown }> };
  return body.settings.find((e) => e.key === key)?.value ?? null;
}

/**
 * Run one palette action by clicking the row whose name is exactly `label`.
 * Exact matters: when no action matches the query and the server has an
 * operator (left by earlier specs in the shard), the palette shows a single
 * `Ask operator: "<query>"` row, which a substring match would click. The
 * real row is missing until the `openai-mcp` status event lands (the verbs
 * are listed by state), which the retry absorbs. Each attempt starts from a
 * closed palette because the palette chord toggles.
 */
async function runPaletteAction(page: Page, label: string) {
  const input = page.getByPlaceholder("Type a command");
  await expect(async () => {
    if (await input.isVisible()) await page.keyboard.press("Escape");
    await expect(input).toBeHidden({ timeout: 2_000 });
    const opened = await openPalette(page);
    await opened.fill(label);
    await page.getByRole("option", { name: label, exact: true }).click({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}

async function resetConnector(page: Page) {
  await page.request.post("/api/settings", {
    data: { "openai_mcp.enabled": false, "openai_mcp.tunnel_id": null },
  });
  await page.request.post("/api/openai-mcp/key", { data: { key: "" } });
}

test.describe("ChatGPT connector", () => {
  test.skip(LIVE_DAEMON, "a real rk-daemon runs on this host; the connector routes would act on its sessions");

  test.beforeAll(() => {
    settingsSnapshot = snapshot(SETTINGS_PATH);
    keySnapshot = snapshot(KEY_PATH);
  });

  test.afterAll(() => {
    restore(SETTINGS_PATH, settingsSnapshot, 0o644);
    restore(KEY_PATH, keySnapshot, 0o600);
  });

  test.beforeEach(async ({ page }) => {
    await resetConnector(page);
  });

  test.afterEach(async ({ page }) => {
    await resetConnector(page);
  });

  /**
   * Proves: the connector section renders in Settings → General, starts Off,
   * and turning it on with nothing configured persists the switch and moves
   * the live status to "Needs setup" with a link to the Platform tunnels page.
   *
   * Steps:
   * 1. Navigate to the rig server and open Settings through the palette.
   * 2. Assert the `ChatGPT connector` switch is off and the status reads Off.
   * 3. Click the switch; poll GET /api/settings until openai_mcp.enabled is true.
   * 4. Assert the status line's data-state becomes `unconfigured` and names
   *    the missing tunnel ID.
   * 5. Assert the `Create a tunnel` link points at the Platform tunnels page.
   */
  test("turning the connector on unconfigured shows Needs setup", async ({ page }) => {
    await gotoServerReady(page, TMUX_SERVER);
    const dialog = await openGeneralSettings(page);

    const toggle = dialog.getByRole("switch", { name: "ChatGPT connector" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    const statusLine = dialog.getByTestId("settings-openai-mcp-status");
    await expect(statusLine).toHaveAttribute("data-state", "off", { timeout: 15_000 });

    await toggle.click();
    await expect.poll(() => pollSetting(page, "openai_mcp.enabled")).toBe(true);
    await expect(statusLine).toHaveAttribute("data-state", "unconfigured", { timeout: 15_000 });
    await expect(statusLine).toContainText("set the tunnel ID");
    await expect(dialog.getByRole("link", { name: "Create a tunnel" })).toHaveAttribute(
      "href",
      "https://platform.openai.com/settings/organization/tunnels",
    );
  });

  /**
   * Proves: a malformed tunnel ID is rejected inline without persisting; a
   * valid one persists; the API key field is a password input whose value is
   * saved write-only (the row flips to "Saved", GET /api/settings never
   * carries it, the file on disk holds it); with both set the status leaves
   * `unconfigured` for the rig's daemon-down state; Clear removes the key and
   * the status returns to asking for it.
   *
   * Steps:
   * 1. POST openai_mcp.enabled: true, then open Settings.
   * 2. Type `nope` into Tunnel ID and blur; assert the inline error and that
   *    the stored tunnel ID stayed null.
   * 3. Type a valid tunnel ID and blur; poll until it is stored.
   * 4. Assert the API key input has type=password and is empty; fill the fake
   *    key and click Save; assert `Saved` replaces the input.
   * 5. Assert GET /api/settings' body does not contain the key and the key
   *    file holds it.
   * 6. Assert the status reaches data-state `stopped` naming the daemon.
   * 7. Click Clear; assert the input returns and the status is `unconfigured`
   *    asking for an API key.
   */
  test("tunnel ID validates inline and the key is write-only", async ({ page }) => {
    await page.request.post("/api/settings", { data: { "openai_mcp.enabled": true } });
    await gotoServerReady(page, TMUX_SERVER);
    const dialog = await openGeneralSettings(page);

    const tunnel = dialog.getByLabel("Tunnel ID");
    await tunnel.fill("nope");
    await tunnel.blur();
    await expect(dialog.getByText(/tunnel ID must look like tunnel_/)).toBeVisible();
    expect(await pollSetting(page, "openai_mcp.tunnel_id")).toBeNull();

    await tunnel.fill(TUNNEL_ID);
    await tunnel.blur();
    await expect.poll(() => pollSetting(page, "openai_mcp.tunnel_id")).toBe(TUNNEL_ID);

    const keyInput = dialog.getByLabel("API key");
    await expect(keyInput).toHaveAttribute("type", "password");
    await expect(keyInput).toHaveValue("");
    await keyInput.fill(FAKE_KEY);
    await dialog.getByRole("button", { name: "Save key" }).click();
    await expect(dialog.getByText("Saved", { exact: true })).toBeVisible();

    const settingsBody = await (await page.request.get("/api/settings")).text();
    expect(settingsBody).not.toContain(FAKE_KEY);
    expect(readFileSync(KEY_PATH, "utf8")).toBe(FAKE_KEY + "\n");

    const statusLine = dialog.getByTestId("settings-openai-mcp-status");
    await expect(statusLine).toHaveAttribute("data-state", "stopped", { timeout: 15_000 });
    await expect(statusLine).toContainText("rk daemon is not running");

    await dialog.getByRole("button", { name: "Clear key" }).click();
    await expect(dialog.getByLabel("API key")).toBeVisible();
    await expect(statusLine).toHaveAttribute("data-state", "unconfigured", { timeout: 15_000 });
    await expect(statusLine).toContainText("save an API key");
  });

  /**
   * Proves: the palette carries the connector verbs by state (Constitution V):
   * `ChatGPT connector: Turn on` while off flips the stored switch on, after
   * which `ChatGPT connector: Turn off` is listed and flips it back off.
   *
   * Steps:
   * 1. Navigate to the rig server.
   * 2. `runPaletteAction("ChatGPT connector: Turn on")`: from a closed
   *    palette, open it, type the label, click the exact row, retrying until
   *    the row is listed (the palette lists nothing before the first
   *    openai-mcp event); poll until openai_mcp.enabled is true.
   * 3. `runPaletteAction("ChatGPT connector: Turn off")` the same way (the
   *    row appears once the status event reports the switch on); poll until
   *    openai_mcp.enabled is false.
   */
  test("palette turns the connector on and off", async ({ page }) => {
    await gotoServerReady(page, TMUX_SERVER);

    await runPaletteAction(page, "ChatGPT connector: Turn on");
    await expect.poll(() => pollSetting(page, "openai_mcp.enabled")).toBe(true);

    await runPaletteAction(page, "ChatGPT connector: Turn off");
    await expect.poll(() => pollSetting(page, "openai_mcp.enabled")).toBe(false);
  });
});
