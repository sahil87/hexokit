/**
 * Demo: real-agent paste-submission matrix — every supported agent CLI that
 * can launch on this box receives the four ordinary-tab scenarios through the
 * production send endpoint, and each scenario is proven by the agent's actual
 * reply token in the pane scrollback, never by the paste alone.
 *
 * Runs only under `just demo agent-injection-matrix [--desktop-only]` against
 * the throwaway e2e rig. `DEMO_AGENTS=codex,claude` narrows the agent set
 * (default: every registry agent whose binary is on PATH); a per-agent run
 * keeps each recording concise. Results — version, outcomes, and unverified
 * reasons — are written to
 * .demo/agent-injection-matrix-<agent>.json for verification.md.
 *
 * Shared setup: no session preseed — each agent's scenario launches its own
 * window of session `demo-agent-matrix` on the rig's isolated tmux server
 * (cwd the repository root, real user config for authentication; nothing
 * installed or modified), answers the folder-trust dialog when the CLI shows
 * one, and waits for the interactive composer. The browser follows along on
 * the window's terminal route so the recording shows the real pane.
 *
 * Every case uses one production submit request, with no additional Enter
 * from the fixture. The expected reply is absent from the prompt, so neither
 * a staged paste nor a submitted echo can satisfy the assertion.
 * Claude and Codex additionally get an operator-role comparison:
 * the window is stamped `@rk_win_role operator` (no operator workflow is
 * launched) and the long case is repeated to show the role does not change
 * the mechanism.
 */
import { test, expect, beat } from "./_demo";
import { gotoWindow } from "../e2e/_ready";
import {
  AGENTS,
  TMUX_SERVER,
  binaryOnPath,
  countReplies,
  createSession,
  killSession,
  launchAgent,
  makeLongPrompt,
  makeMultilinePrompt,
  makeShortPrompt,
  recordMatrixResult,
  stampOperatorRole,
  terminalSees,
  waitForTurn,
  capturePane,
  deliverViaSend,
  dismissNagDialogs,
  type AgentWindow,
} from "./_agent-injection";
import { execFileSync } from "node:child_process";

const SESSION = "demo-agent-matrix";

function agentVersion(binary: string): string {
  try {
    return execFileSync(binary, ["--version"], { timeout: 10_000 }).toString().trim();
  } catch {
    return "unknown (--version failed)";
  }
}

interface ScenarioRecord {
  scenario: string;
  sendStatus: number;
  replied: boolean;
  tokens: number;
  chipsAfter: number;
  note?: string;
}

test.describe("agent-injection matrix demo", () => {
  // Cold CLI boots, real model turns, and (for claude/codex) the role
  // comparison: generous ceiling for a multi-agent serial run.
  test.setTimeout(1_800_000);

  test.beforeAll(() => {
    createSession(SESSION);
  });

  test.afterAll(() => {
    killSession(SESSION);
  });

  /**
   * Proves: every runnable supported agent submits injected prompts — short,
   * 1433-char single-line, multiline, and a successive second delivery — each
   * producing exactly one real turn with the requested acknowledgement and an
   * emptied composer; Claude and Codex additionally submit identically from
   * an operator-stamped tab. Unavailable agents record an explicit unverified
   * result instead of a pass.
   *
   * Steps (per agent):
   * 1. Launch the CLI in its own window, answer trust dialogs, navigate the
   *    browser to the terminal.
   * 2. Short single-line prompt via POST /send (submit) → 200, reply token.
   * 3. 1433-char single-line via submit → real reply token.
   * 4. Multiline prompt via submit → real reply token.
   * 5. A second short prompt immediately after → its own reply token (no
   *    accumulation, one turn per delivery).
   * 6. claude/codex only: stamp the operator role and repeat the 1433-char
   *    case → reply token.
   * 7. Write .demo/agent-injection-matrix-<agent>.json with versions,
   *    reply counts and outcomes.
   */
  test("supported agents submit injected prompts", async ({ page }) => {
    const selected = (process.env.DEMO_AGENTS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const agents = AGENTS.filter((a) => selected.length === 0 || selected.includes(a.name));

    for (const agent of agents) {
      const record: {
        agent: string;
        binary: string;
        version: string;
        available: boolean;
        unverified?: string;
        scenarios: ScenarioRecord[];
      } = { agent: agent.name, binary: agent.binary, version: "", available: false, scenarios: [] };

      if (!binaryOnPath(agent.binary)) {
        record.unverified = `binary '${agent.binary}' not on PATH`;
        recordMatrixResult(agent.name, record);
        continue;
      }
      record.version = agentVersion(agent.binary);

      let win: AgentWindow;
      try {
        win = await launchAgent(SESSION, agent);
      } catch (err) {
        record.unverified = `launch/readiness failed: ${String(err).slice(0, 800)}`;
        recordMatrixResult(agent.name, record);
        continue;
      }
      record.available = true;
      await gotoWindow(page, TMUX_SERVER, win.windowId);
      await beat(page);

      const run = async (
        scenario: string,
        text: string,
        token: string,
      ): Promise<ScenarioRecord> => {
        await dismissNagDialogs(win.paneId);
        // Baseline BEFORE delivery, counting only bare-token reply lines: the
        // prompt echo can never match, so a fast reply can never be absorbed
        // into the baseline and a staged echo can never satisfy the wait.
        const base = countReplies(capturePane(win.paneId, { scrollback: true }), token);
        const sendStatus = (await deliverViaSend(page, TMUX_SERVER, win.windowId, text)).status;
        // Slow provider turns (a throttled Codex account was observed working
        // past 90s on a trivial acknowledgement) get a wide ceiling; the wait
        // still returns the moment the reply lands.
        const obs = await waitForTurn(win.paneId, token, base, 1, 240_000);
        const replied = obs.tokens >= base + 1;
        const rec: ScenarioRecord = {
          scenario,
          sendStatus,
          replied,
          tokens: obs.tokens,
          chipsAfter: obs.chips,
        };
        if (!replied) rec.note = obs.tailText.slice(-600);
        record.scenarios.push(rec);
        recordMatrixResult(agent.name, record);
        expect(
          rec.replied && rec.chipsAfter === 0 && rec.sendStatus === 200,
          `${agent.name} ${rec.scenario}: ${JSON.stringify(rec)}`,
        ).toBe(true);
        // Check while this reply is visible; a later long turn can redraw it.
        await expect
          .poll(() => terminalSees(page, win.windowId, token), { timeout: 15_000 })
          .toBe(true);
        await beat(page);
        return rec;
      };

      await run("short single-line (submit)", makeShortPrompt(`ACK-${agent.name}-S1`), `ACK-${agent.name}-S1`);
      await run("1433-char single-line (submit)", makeLongPrompt(`ACK-${agent.name}-L1`), `ACK-${agent.name}-L1`);
      await run("multiline (submit)", makeMultilinePrompt(`ACK-${agent.name}-M1`), `ACK-${agent.name}-M1`);
      await run("successive short (submit)", makeShortPrompt(`ACK-${agent.name}-S2`), `ACK-${agent.name}-S2`);
      if (agent.name === "claude" || agent.name === "codex") {
        stampOperatorRole(win.windowId);
        await run("1433-char operator-stamped tab (submit)", makeLongPrompt(`ACK-${agent.name}-OP`), `ACK-${agent.name}-OP`);
      }

      recordMatrixResult(agent.name, record);
    }
  });
});
