/**
 * Demo: a scheduled cron prompt delivered into an ordinary Codex tab must
 * actually SUBMIT — the shared injection engine must recognize Codex's
 * collapsed-paste chip ("[Pasted Content N chars]") as fresh echo evidence so
 * the probe-gated Enter fires, instead of staging chip after chip in the
 * composer. Recorded for PR evidence: the before pass (base tree) shows the
 * probe withholding Enter while identical chips accumulate; the after pass
 * shows two successive firings each producing a real agent turn with the
 * composer emptied.
 *
 * Runs only under `just demo agent-injection [--before <ref>]`
 * (playwright.demo.config.ts), against the throwaway e2e rig. slowMo paces
 * browser actions; the agent itself runs at full speed in its tmux pane.
 *
 * Shared setup: beforeAll launches the real `codex` CLI (authentication
 * inherited from the user config; nothing installed or modified) as window
 * "codex" of session `demo-agent-inject` on the rig's isolated tmux server,
 * cwd the repository root, and waits for the interactive composer; afterAll
 * deletes the cron entry and kills the session (the rig's EXIT trap reaps the
 * server). The demo runs once per project (desktop 1280x800, mobile
 * 375x812); the video is saved by the `_demo.ts` fixture to
 * .demo/agent-injection[-<variant>]-<project>.webm.
 *
 * The unchanged cron payload requests an acknowledgement with an increasing
 * suffix. Observe each reply as it arrives: narrow TUIs can redraw away older
 * turns, so two replies need not coexist in scrollback. Expected reply tokens
 * are absent from the prompt; delivery logs are supporting evidence only.
 */
import { test, expect, beat } from "./_demo";
import { gotoWindow } from "../e2e/_ready";
import {
  AGENTS,
  TMUX_SERVER,
  createSession,
  cronCreate,
  cronDelete,
  cronOutcomes,
  killSession,
  launchAgent,
  terminalSees,
  waitForTurn,
} from "./_agent-injection";

const SESSION = "demo-agent-inject";
const TOKEN = "ACK-EJAM-CRON";
const FIRST_REPLY = `${TOKEN}-1`;
const SECOND_REPLY = `${TOKEN}-2`;
const INSTRUCTION = "Without tools or file reads, reply only with the concatenation of 'ACK-EJAM-' and 'CRON-' followed by the number of copies of this exact message you have received in this conversation: 1 for the first copy, 2 for the second, and so on. Ignore the padding. ";
const PROMPT = (INSTRUCTION + "padding-".repeat(200)).slice(0, 1433);
const codex = AGENTS.find((a) => a.name === "codex")!;

test.describe("agent-injection demo", () => {
  // Two cron firings paced by the daemon's 30s tick, plus a cold CLI boot and
  // two real agent turns: well past the demo config's 120s default.
  test.setTimeout(420_000);

  test.beforeAll(() => {
    createSession(SESSION);
  });

  test.afterAll(async () => {
    killSession(SESSION);
  });

  /**
   * Proves: a cron-fired 1433-character single-line prompt (the reported
   * collapse shape) delivered into an ordinary Codex tab is submitted by the
   * shared engine — the agent answers with the requested token, the composer
   * empties, and a second firing submits as its own turn without accumulating
   * chips. On the base tree the probe never recognizes the Codex chip, Enter
   * is withheld, and the assertion fails with the accumulated chips on screen.
   *
   * Steps:
   * 1. Launch Codex in its own window and navigate the browser to it
   *    (desktop gates on the Connected dot; mobile goes straight to the
   *    window route and gates on the mounted terminal).
   * 2. Create a pane-targeted cron entry (every 1s, deliver immediate) whose
   *    payload is the 1433-char prompt; the daemon ticker fires it.
   * 3. Await the first numbered acknowledgement and an idle, empty composer.
   *    On the base tree two failed deliveries accumulate chips during this
   *    wait; retain that visible failure before the assertion fails.
   * 4. Await the second numbered acknowledgement from the identical payload,
   *    without requiring the first reply to remain visible in the narrow TUI.
   * 5. Delete the cron entry.
   */
  test("cron prompt submits in an ordinary codex tab", async ({ page }, testInfo) => {
    const agent = await launchAgent(SESSION, codex);
    const isMobile = testInfo.project.name === "mobile";
    if (!isMobile) {
      await gotoWindow(page, TMUX_SERVER, agent.windowId);
    } else {
      await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(agent.windowId)}`);
      await expect(page.locator(".xterm").first()).toBeVisible({ timeout: 20_000 });
    }
    await beat(page);

    const entryId = await cronCreate(page, TMUX_SERVER, "ejam codex paste check", agent.paneId, PROMPT);
    try {
      const turn1 = await waitForTurn(agent.paneId, FIRST_REPLY, 0, 1, 75_000);
      if (turn1.tokens === 0) {
        const outcomes = await cronOutcomes(page, TMUX_SERVER, entryId);
        expect(outcomes.filter((o) => o.startsWith("failed")).length).toBeGreaterThanOrEqual(2);
        await expect.poll(() => terminalSees(page, agent.windowId, "Pasted Content")).toBe(true);
      }
      await beat(page, 2_000);
      expect(
        turn1.tokens,
        `first cron firing produced no turn — replies=${turn1.tokens} chips=${turn1.chips}\n${turn1.tailText}`,
      ).toBeGreaterThanOrEqual(1);
      expect(turn1.chips, "composer still holds a staged chip after the first turn").toBe(0);
      await beat(page);

      const turn2 = await waitForTurn(agent.paneId, SECOND_REPLY, 0, 1, 75_000);
      const outcomesSoFar = await cronOutcomes(page, TMUX_SERVER, entryId);
      expect(
        turn2.tokens,
        `second cron firing produced no turn — replies=${turn2.tokens} cron=${JSON.stringify(outcomesSoFar)}\n${turn2.tailText}`,
      ).toBeGreaterThanOrEqual(1);
      expect(turn2.chips, "composer still holds a staged chip after the second turn").toBe(0);

      await expect
        .poll(() => terminalSees(page, agent.windowId, SECOND_REPLY), { timeout: 20_000 })
        .toBe(true);
      await beat(page, 2_000);

      const outcomes = await cronOutcomes(page, TMUX_SERVER, entryId);
      expect(outcomes.filter((o) => o === "delivered").length).toBeGreaterThanOrEqual(2);
    } finally {
      await cronDelete(page, TMUX_SERVER, entryId);
    }
  });
});
