/**
 * Replays sanitized Codex 0.164.0 lifecycle events through installed rk hooks,
 * real tmux state, the backend, and the sidebar. No API/socket stubs are used.
 * beforeAll builds the current binary and creates only a temporary home and
 * harmless fixture pane on the just harness's isolated socket; afterAll removes
 * them. Each viewport gets its own page and mobile opens the navigation drawer.
 * Motion is enabled to assert the actual attention animation. This verifies
 * recorded event compatibility, not execution of a live Codex/Claude agent.
 */
import { test } from "@playwright/test";
import { HookReplay, replayDot, expectReplayState } from "./_codex-hook-replay";

test.use({ contextOptions: { reducedMotion: "no-preference" } });

for (const viewport of [{ name: "desktop", width: 1280, height: 800 }, { name: "mobile", width: 375, height: 812 }]) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    let replay: HookReplay;
    test.beforeAll(() => { test.setTimeout(60_000); replay = new HookReplay(); });
    test.afterAll(() => { replay?.close(); });

    /**
     * Proves: automated permission review never animates the attention dot;
     * human approval does, and approval/completion clear it at the right time.
     * Steps:
     * 1. Replay a working turn and automatic PermissionRequest; assert solid,
     *    non-pulsing state on the real sidebar.
     * 2. Replay a user-reviewed permission request; assert a pulsing ring.
     * 3. Replay tool completion after approval; assert solid without a pulse.
     * 4. Replay Stop; assert hollow without a pulse.
     */
    test("permission attention follows the effective reviewer", async ({ page }) => {
      test.setTimeout(45_000);
      replay.resetTranscript("auto_review");
      await replay.fire("UserPromptSubmit", "Working");
      const dot = await replayDot(page, replay, viewport.name === "mobile");
      await expectReplayState(dot, "active");
      await replay.fire("PermissionRequest", "Automatic review; no human input", { tool_name: "Bash", tool_input: { command: "printf hi" } });
      await expectReplayState(dot, "active");
      replay.resetTranscript("user");
      await replay.fire("PermissionRequest", "Human approval required", { tool_name: "Bash", tool_input: { command: "printf hi" } });
      await expectReplayState(dot, "waiting");
      await replay.fire("PostToolUse", "Approved; work resumes", { tool_name: "Bash", tool_response: "hi" });
      await expectReplayState(dot, "active");
      await replay.fire("Stop", "Finished");
      await expectReplayState(dot, "idle");
    });

    /**
     * Proves: an accepted asynchronous question keeps the attention pulse while
     * other tools run, and answering it restores active then idle state.
     * Steps:
     * 1. Start a new turn and replay a successful asynchronous question.
     * 2. Assert waiting through a subsequent tool and Stop with question pending.
     * 3. Replay the matching user answer and assert the pulse clears.
     * 4. Replay completion and assert the hollow, non-pulsing idle circle.
     */
    test("pending question remains visible until answered", async ({ page }) => {
      test.setTimeout(45_000);
      replay.resetTranscript("auto_review");
      await replay.fire("UserPromptSubmit", "Working");
      const dot = await replayDot(page, replay, viewport.name === "mobile");
      await replay.askAsync();
      await expectReplayState(dot, "waiting");
      await replay.fire("PreToolUse", "Question still pending; another tool runs", { tool_name: "clock.sleep" });
      await expectReplayState(dot, "waiting");
      await replay.fire("Stop", "Question still pending");
      await expectReplayState(dot, "waiting");
      await replay.answerAsync();
      await expectReplayState(dot, "active");
      await replay.fire("Stop", "Finished");
      await expectReplayState(dot, "idle");
    });
  });
}

test.describe("Claude lifecycle regression", () => {
  let replay: HookReplay;
  test.beforeAll(() => { test.setTimeout(60_000); replay = new HookReplay("claude"); });
  test.afterAll(() => { replay?.close(); });

  /**
   * Proves: Claude's existing permission notification still requests attention
   * and resuming/completing clears the halo through the real sidebar pipeline.
   * Steps:
   * 1. Replay UserPromptSubmit and verify active without a halo.
   * 2. Replay permission_prompt Notification and verify a pulsing ring.
   * 3. Replay PreToolUse then Stop and verify active then idle without a halo.
   */
  test("permission notification retains the existing behavior", async ({ page }) => {
    test.setTimeout(45_000);
    await replay.fire("UserPromptSubmit", "Claude working");
    const dot = await replayDot(page, replay, false);
    await expectReplayState(dot, "active");
    await replay.fire("Notification", "Claude needs permission", { notification_type: "permission_prompt" });
    await expectReplayState(dot, "waiting");
    await replay.fire("PreToolUse", "Claude resumes", { tool_name: "Bash" });
    await expectReplayState(dot, "active");
    await replay.fire("Stop", "Claude finished");
    await expectReplayState(dot, "idle");
  });
});
