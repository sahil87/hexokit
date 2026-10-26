/**
 * Sanitized Codex 0.164.0 hook/rollout replay against the real rk binary and
 * throwaway tmux rig. This is deterministic integration evidence, not a live
 * Codex invocation. A harmless executable named codex/claude owns each pane,
 * giving the production hook a real, live, comm-validated parent process.
 * No state option is set by the fixture: only rk's installed hook mappings
 * write lifecycle state. All agent configuration lives under a fresh temp dir.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { TMUX_SERVER, killSession } from "./_tmux";
import { READY_TIMEOUT } from "./_ready";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const TURN_ID = "22222222-2222-4222-8222-222222222222";
const QUESTION_CALL = "call_color_preference";
const QUESTIONS = [{ title: "Do you prefer red or blue?", options: ["Red", "Blue"] }];

const runnerSource = `package main
import (
  "bytes"
  "context"
  "encoding/json"
  "fmt"
  "os"
  "os/exec"
  "path/filepath"
  "time"
)
type request struct { Sequence int; Token string; Payload json.RawMessage; Label string }
func main() {
  dir, binary, agent := os.Args[1], os.Args[2], os.Args[3]
  for {
    data, err := os.ReadFile(filepath.Join(dir, "request.json"))
    if err != nil { time.Sleep(20*time.Millisecond); continue }
    var r request
    if json.Unmarshal(data, &r) != nil { panic("invalid fixture request") }
    if err := os.Remove(filepath.Join(dir, "request.json")); err != nil { panic(err) }
    fmt.Printf("\\033[2J\\033[HHook event replay (not a live agent)\\n\\n%s\\n", r.Label)
    result := "ok"
    if r.Token != "" {
      ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
      cmd := exec.CommandContext(ctx, binary, "agent", "hook", "--agent", agent, r.Token)
      cmd.Stdin = bytes.NewReader(r.Payload)
      out, err := cmd.CombinedOutput()
      cancel()
      if err != nil || len(out) != 0 { result = fmt.Sprintf("hook: %v %s", err, out) }
    }
    if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("done-%d", r.Sequence)), []byte(result), 0600); err != nil { panic(err) }
  }
}
`;

type HookRow = { matcher?: string; hooks: Array<{ command?: string }> };
type HookConfig = { hooks: Record<string, HookRow[]> };
type State = "active" | "waiting" | "idle";

function tmux(args: string[]): string {
  return execFileSync("tmux", ["-L", TMUX_SERVER, ...args], { encoding: "utf8", timeout: 5_000 }).trim();
}

export class HookReplay {
  readonly directory = mkdtempSync(join(tmpdir(), "rk-codex-replay-"));
  readonly session: string;
  readonly transcript: string;
  readonly windowId: string;
  private sequence = 0;
  private readonly mappings: HookConfig;

  constructor(readonly agent: "codex" | "claude" = "codex") {
    if (!TMUX_SERVER.startsWith("rk-test-")) throw new Error("hook replay requires an isolated rk-test-* socket");
    this.session = `hook-replay-${agent}`;
    const root = process.env.RK_E2E_APP_ROOT ?? resolve(process.cwd(), "../..");
    const bin = join(this.directory, "bin");
    const home = join(this.directory, "home");
    mkdirSync(bin);
    mkdirSync(home);
    this.transcript = join(this.directory, "rollout.jsonl");
    const binary = join(bin, "rk");
    execFileSync("go", ["build", "-o", binary, "./cmd/rk"], { cwd: join(root, "app/backend"), timeout: 30_000 });
    const source = join(this.directory, "fixture.go");
    writeFileSync(source, runnerSource);
    execFileSync("go", ["build", "-o", join(bin, "codex"), source], { timeout: 30_000 });
    copyFileSync(join(bin, "codex"), join(bin, "claude"));
    // Setup is intentionally confined to this new home, including all optional
    // provider and shell-startup overrides inherited from the developer shell.
    const env = {
      ...process.env, HOME: home, ZDOTDIR: home,
      CODEX_HOME: join(home, ".codex"), COPILOT_HOME: join(home, ".copilot"),
      KIMI_CODE_HOME: join(home, ".kimi"), CLAUDE_CONFIG_DIR: join(home, ".claude"),
      XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"), PATH: `${bin}:/usr/bin:/bin`,
    };
    execFileSync(binary, ["agent", "setup", "--yes"], { env, timeout: 30_000, stdio: "pipe" });
    const config = agent === "codex" ? join(home, ".codex/hooks.json") : join(home, ".claude/settings.json");
    this.mappings = JSON.parse(readFileSync(config, "utf8"));
    killSession(this.session);
    // Multiple command arguments use tmux's direct-exec form, not sh -c.
    this.windowId = tmux(["new-session", "-d", "-P", "-F", "#{window_id}", "-s", this.session,
      "-n", `${agent}-replay`, "-c", this.directory, "-x", "100", "-y", "28",
      join(bin, agent), this.directory, binary, agent]);
    this.resetTranscript("auto_review");
  }

  close(): void {
    killSession(this.session);
    rmSync(this.directory, { recursive: true, force: true });
  }

  record(type: string, payload: Record<string, unknown>): void {
    appendFileSync(this.transcript, `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`);
  }

  resetTranscript(reviewer: "user" | "auto_review"): void {
    writeFileSync(this.transcript, "");
    this.record("session_meta", { id: SESSION_ID, source: "cli", cli_version: "0.164.0", cwd: this.directory });
    this.record("turn_context", { turn_id: TURN_ID, approvals_reviewer: reviewer, approval_policy: "on-request", collaboration_mode: { mode: "default" } });
  }

  async fire(event: string, label: string, extra: Record<string, unknown> = {}): Promise<void> {
    const row = this.mappings.hooks[event]?.find((entry) => !entry.matcher ||
      entry.matcher.split("|").includes(String(extra.notification_type ?? extra.tool_name ?? "")));
    const command = row?.hooks[0]?.command;
    const token = command?.match(/agent hook --agent (?:codex|claude) (active|waiting|idle|stamp)/)?.[1] ?? "";
    if (command && !token) throw new Error(`unrecognized installed hook: ${event}`);
    const sequence = ++this.sequence;
    const payload = {
      session_id: SESSION_ID, turn_id: TURN_ID, transcript_path: this.transcript,
      cwd: this.directory, hook_event_name: event, permission_mode: "default", ...extra,
    };
    const pending = join(this.directory, "pending.json");
    writeFileSync(pending, JSON.stringify({ Sequence: sequence, Token: token, Payload: payload, Label: label }));
    renameSync(pending, join(this.directory, "request.json"));
    const done = join(this.directory, `done-${sequence}`);
    await expect.poll(() => existsSync(done), { timeout: 12_000 }).toBe(true);
    expect(readFileSync(done, "utf8")).toBe("ok");
  }

  async askAsync(): Promise<void> {
    this.record("response_item", { type: "function_call", name: "request_user_input_async", call_id: QUESTION_CALL, arguments: JSON.stringify({ questions: QUESTIONS }) });
    await this.fire("PreToolUse", "Submitting a question", { tool_name: "request_user_input_async", tool_use_id: QUESTION_CALL, tool_input: { questions: QUESTIONS } });
    this.record("event_msg", { type: "item_completed", turn_id: TURN_ID, item: { type: "AgentMessage", id: QUESTION_CALL, delivery: "async", questions: QUESTIONS } });
    this.record("response_item", { type: "function_call_output", call_id: QUESTION_CALL, output: '{"accepted":true}' });
    await this.fire("PostToolUse", "Question pending: red or blue?", { tool_name: "request_user_input_async", tool_use_id: QUESTION_CALL, tool_input: { questions: QUESTIONS }, tool_response: '{"accepted":true}' });
  }

  async answerAsync(): Promise<void> {
    const prompt = `<send_user_message_question_reply>\n${JSON.stringify([{ answer: "Red", question: QUESTIONS[0].title, questionItemId: JSON.stringify(["request_user_input_async", QUESTION_CALL, 0]) }])}\n</send_user_message_question_reply>`;
    this.record("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] });
    await this.fire("UserPromptSubmit", "Question answered; work resumes", { prompt });
  }
}

/** Open the real session's sidebar row on desktop or in the mobile drawer. */
export async function replayDot(page: Page, replay: HookReplay, mobile: boolean): Promise<Locator> {
  await page.goto(`/${TMUX_SERVER}/${replay.windowId.slice(1)}`);
  await expect(page.getByRole("button", { name: "Toggle navigation" })).toBeVisible({ timeout: READY_TIMEOUT });
  if (mobile) await page.getByRole("button", { name: "Toggle navigation" }).click();
  const nav = page.getByRole("navigation", { name: "Sessions" });
  const dot = nav.locator(`[data-window-id="${replay.windowId}"] [role="img"]`).first();
  await expect(dot).toBeVisible({ timeout: READY_TIMEOUT });
  return dot;
}

/** Checks the real SSE-rendered shape, attention class, and CSS animation. */
export async function expectReplayState(dot: Locator, state: State): Promise<void> {
  const waiting = state === "waiting";
  if (waiting) await expect(dot).toHaveClass(/rk-waiting-halo/, { timeout: READY_TIMEOUT });
  else await expect(dot).not.toHaveClass(/rk-waiting-halo/, { timeout: READY_TIMEOUT });
  await expect.poll(() => dot.evaluate((element) => {
    const style = getComputedStyle(element);
    return style.backgroundColor !== "rgba(0, 0, 0, 0)";
  }), { timeout: READY_TIMEOUT }).toBe(state === "active");
  await expect.poll(() => dot.evaluate((element) => getComputedStyle(element, "::after").animationName),
    { timeout: READY_TIMEOUT }).toBe(waiting ? "rk-waiting-halo" : "none");
}
