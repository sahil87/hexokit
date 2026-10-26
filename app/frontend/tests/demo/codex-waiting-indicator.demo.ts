/**
 * Codex 0.164.0 event replay recorded on the just demo throwaway rig. The real
 * rk binary/installer/backend/UI come from RK_E2E_APP_ROOT for Before and the
 * working tree for After. HookReplay owns a temporary home and harmless pane;
 * teardown removes both. No route/socket mocks or live agent configuration.
 * The recording is explicitly captioned as replay, with scenario and viewport.
 * Desktop shows the sidebar; mobile keeps its navigation drawer open. Motion
 * remains enabled. External live-Codex verification is recorded separately.
 */
import { test, beat, expect } from "./_demo";
import { HookReplay, replayDot, expectReplayState } from "../e2e/_codex-hook-replay";

let replay: HookReplay;
test.beforeAll(() => { test.setTimeout(60_000); replay = new HookReplay(); });
test.afterAll(() => { replay?.close(); });

/**
 * Proves: comparable Before/After recordings show automatic review, human
 * permission, asynchronous question, answer, and completion attention states.
 * Steps:
 * 1. Open the replay pane's sidebar status dot and caption the evidence.
 * 2. Replay automatic review and show the base false pulse / corrected solid.
 * 3. Replay a human permission request, approval, and completion.
 * 4. Replay an asynchronous question and subsequent tool while still pending.
 * 5. Replay the answer and completion, showing the pulse clear.
 */
test("Codex attention lifecycle", async ({ page }, info) => {
  const before = process.env.DEMO_VARIANT === "before";
  const variant = before ? "Before" : "After";
  replay.resetTranscript("auto_review");
  await replay.fire("UserPromptSubmit", "Working");
  const dot = await replayDot(page, replay, info.project.name === "mobile");
  const setCaption = async (scenario: string) => {
    await page.evaluate((text) => {
      let label = document.getElementById("replay-evidence-caption");
      if (!label) {
        label = document.createElement("div");
        label.id = "replay-evidence-caption";
        Object.assign(label.style, { position: "fixed", left: "8px", right: "8px", bottom: "8px", zIndex: "2147483647", padding: "12px", background: "#12151e", color: "#fff", border: "1px solid #7e899c", font: "13px/1.5 monospace", whiteSpace: "pre-line", pointerEvents: "none" });
        document.body.appendChild(label);
      }
      label.textContent = text;
    }, `${variant} · ${info.project.name}\nCodex 0.164.0 event replay\n${scenario}`);
  };
  const caption = async (scenario: string) => {
    await setCaption(scenario);
    await beat(page, 2_500);
  };
  // A hook and the rendered SSE update are separate moments. Keep the caption
  // neutral between them so a transitional frame never claims a settled state.
  const transition = () => setCaption("Applying next lifecycle event…");
  await expectReplayState(dot, "active");
  await caption("Working: solid, no attention pulse");
  await transition();
  await replay.fire("PermissionRequest", "Automatic review; no human input", { tool_name: "Bash", tool_input: { command: "printf hi" } });
  await expectReplayState(dot, before ? "waiting" : "active");
  await caption(before ? "Automatic review: false attention pulse" : "Automatic review: solid, no pulse");
  await transition();
  replay.resetTranscript("user");
  await replay.fire("PermissionRequest", "Human approval required", { tool_name: "Bash", tool_input: { command: "printf hi" } });
  await expectReplayState(dot, "waiting");
  await caption("Human approval required: attention pulse");
  await transition();
  await replay.fire("PostToolUse", "Approved; work resumes", { tool_name: "Bash", tool_response: "hi" });
  await expectReplayState(dot, before ? "waiting" : "active");
  await caption(before ? "Approved: pulse persists until next hook" : "Approved: work resumes, pulse clears");
  await transition();
  await replay.fire("Stop", "Finished");
  await expectReplayState(dot, "idle");
  await caption("Finished: hollow circle, no pulse");
  await transition();
  replay.resetTranscript("auto_review");
  await replay.fire("UserPromptSubmit", "Working");
  await replay.askAsync();
  await replay.fire("PreToolUse", "Another tool; question still pending", { tool_name: "clock.sleep" });
  await expectReplayState(dot, before ? "active" : "waiting");
  await caption(before ? "Question pending: missing attention pulse" : "Question pending: attention pulse stays");
  await transition();
  await replay.answerAsync();
  await expectReplayState(dot, "active");
  await caption("Question answered: working without a pulse");
  await transition();
  await replay.fire("Stop", "Finished");
  await expectReplayState(dot, "idle");
  await caption("Finished: hollow circle, no pulse");
  await expect(dot).toBeVisible();
});
