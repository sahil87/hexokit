/**
 * Shared helpers for the real-agent injection demos (agent-injection*.demo.ts).
 *
 * These demos deliver prompts to REAL agent CLI TUIs running in windows on the
 * rig's isolated tmux server, through the rig backend's production surfaces —
 * `POST /api/windows/{id}/send` and the daemon cron ticker
 * (`POST /api/cron/create`, pane target, `deliver: immediate`) — and verify the
 * agent's actual turn in the pane scrollback: the unique acknowledgement token
 * must appear where it was not before, the busy indicator must clear back to
 * the idle composer, and no collapsed-paste chip may stay staged. A pasted
 * prompt alone never counts as delivery.
 *
 * Agent launch readiness is empirical: each CLI shows its own composer (and,
 * in an untrusted cwd, its own folder-trust dialog), so AGENTS carries the
 * observed readiness pattern and trust-dialog answer per provider. Agents run
 * with their real user config (authentication is inherited; nothing is
 * installed or modified) and with the repository root as cwd so folder trust
 * already granted to the checkout applies.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "@playwright/test";
import {
  TMUX_SERVER,
  capturePane,
  createSession,
  killSession,
  listWindows,
  newWindow,
  paneIdForWindow,
  sendKeysToPane,
  setWindowOption,
} from "../e2e/_tmux";

/** The repository root — agent cwd, so already-granted folder trust applies. */
export const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");

/** One supported agent CLI's launch/readiness contract (observed, not guessed). */
export interface AgentSpec {
  /** Provider key from the backend agent registry. */
  name: string;
  binary: string;
  /** Present in the visible pane once the interactive composer is usable. */
  ready: RegExp;
  /** Folder-trust dialog text, answered with `trustKeys` when seen. */
  trustPrompt?: RegExp;
  trustKeys?: string[];
  /** Transient dialog to dismiss with Escape (e.g. opencode's update notice). */
  dismiss?: RegExp;
}

/** The seven registry agents. Patterns are from observed 2026-10-26 launches:
 *  claude 2.1.310, codex 0.164.0, copilot 1.0.78, kimi 2.3.2, opencode
 *  1.18.25, agy 1.4.7; gemini was not on PATH. */
export const AGENTS: AgentSpec[] = [
  {
    name: "claude",
    binary: "claude",
    ready: /⏵⏵|Try "/,
    trustPrompt: /Yes, I trust this folder/,
    trustKeys: ["Down", "Enter"], // "No, exit" is preselected; move to "Yes"
  },
  { name: "codex", binary: "codex", ready: /Ask Codex to do anything/ },
  { name: "gemini", binary: "gemini", ready: /Type your message/ },
  {
    name: "copilot",
    binary: "copilot",
    ready: /Interactive ·/,
    trustPrompt: /remember this folder for future sessions/,
    trustKeys: ["Enter"], // option 1 "Yes" (session-only) is preselected
  },
  {
    name: "kimi",
    binary: "kimi",
    ready: /context: \d+%/,
    trustPrompt: /Trust and continue/,
    trustKeys: ["Enter"],
  },
  {
    name: "opencode",
    binary: "opencode",
    ready: /Ask anything/,
    dismiss: /Update Available/,
  },
  {
    name: "agy",
    binary: "agy",
    ready: /for shortcuts/,
    trustPrompt: /Yes, I trust this folder/,
    trustKeys: ["Enter"], // "Yes, I trust this folder" is preselected
  },
];

/** True when the agent's binary resolves on PATH. */
export function binaryOnPath(binary: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, binary))) return true;
  }
  return false;
}

/** A launched agent window's tmux identity. */
export interface AgentWindow {
  windowId: string;
  paneId: string;
}

/** Launch `agent` as a named window of `session` on the rig server and wait
 *  for its interactive composer, answering the folder-trust dialog when the
 *  CLI shows one. Throws with the last pane tail when the CLI never becomes
 *  ready (login wall, crash) — the caller records that as unverified. */
export async function launchAgent(
  session: string,
  agent: AgentSpec,
  timeoutMs = 60_000,
): Promise<AgentWindow> {
  newWindow(session, agent.name, { cwd: REPO_ROOT, command: agent.binary });
  const win = listWindows(session).find((w) => w.name === agent.name);
  if (!win) throw new Error(`${agent.name}: window did not appear`);
  const paneId = paneIdForWindow(win.windowId);
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = capturePane(paneId);
    if (agent.dismiss?.test(last)) sendKeysToPane(paneId, ["Escape"]);
    if (agent.trustPrompt?.test(last) && agent.trustKeys) {
      sendKeysToPane(paneId, agent.trustKeys);
    }
    if (agent.ready.test(last)) return { windowId: win.windowId, paneId };
    await delay(500);
  }
  throw new Error(
    `${agent.name}: composer not ready within ${timeoutMs}ms — last pane tail:\n${tail(last, 12)}`,
  );
}

/** Count REPLY lines for a token: a line that carries the token with nothing
 *  but composer-border/bullet decoration around it — including a trailing
 *  scrollbar gutter (copilot renders a block-element scroll indicator at the
 *  right edge of transcript rows). The prompt echo can never match — its line
 *  always carries the full instruction sentence — so this distinguishes the
 *  agent's bare-token reply ("• ACK-…", "⏺ ACK-…", "● ACK-… █") from the
 *  submitted prompt echo, which a plain substring count cannot. */
export function countReplies(capture: string, token: string): number {
  const re = new RegExp(
    `^[\\s│┃╭╰╮╯>›»]*[•⏺●▸∙·*\\-]?\\s*${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\u2580-\\u259F]*$`,
    "gm",
  );
  return capture.match(re)?.length ?? 0;
}

/** The collapsed-paste chip forms the engine recognizes (display forms, as
 *  rendered by the TUIs — not whitespace-stripped). Used to assert the
 *  composer holds no STAGED chip after a turn completes. */
export const CHIP_PATTERNS = [
  /\[Pasted Content \d+ chars?\](?: #\d+)?/g, // codex
  /\[Pasted text #\d+(?: \+\d+ lines?| \d+ chars?)?\]/g, // claude + agy
  /\[paste #\d+ \d+ chars?\]/g, // kimi
  /\[Pasted ~\d+ lines?\]/g, // opencode
  /\[Pasted Text: \d+ (?:chars?|lines?)(?: #\d+)?\]/g, // gemini
];

/** Total collapsed-paste chips visible in a capture, across all known forms. */
export function countChips(capture: string): number {
  let n = 0;
  for (const re of CHIP_PATTERNS) {
    n += capture.match(re)?.length ?? 0;
  }
  return n;
}

/** Build a single-line prompt of exactly `len` chars whose requested
 *  acknowledgement is `token` (1433 reproduces the reported collapse shape). */
export function makeLongPrompt(token: string, len = 1433): string {
  const head = acknowledgementPrompt(token) + " ";
  const body = head + "padding-".repeat(Math.ceil(len / 8));
  return body.slice(0, len);
}

/** A short single-line prompt (echoes raw in every TUI). */
export function makeShortPrompt(token: string): string {
  return acknowledgementPrompt(token);
}

/** Keep the expected reply absent from the prompt, including wrapped echoes. */
function acknowledgementPrompt(token: string): string {
  const split = token.lastIndexOf("-") + 1;
  return `Reply only with the concatenation of '${token.slice(0, split)}' and '${token.slice(split)}'. No tools or file reads.`;
}

/** A multiline prompt (may collapse independently of total length). */
export function makeMultilinePrompt(token: string): string {
  return [
    "This is a multiline delivery for a paste-submission check.",
    "It carries several lines so the TUI may collapse it into a chip.",
    "Line three keeps the payload plainly harmless.",
    acknowledgementPrompt(token),
  ].join("\n");
}

/** Busy/working indicators observed across the TUIs. Kimi's static footer
 *  ("Fast thinking: high") is deliberately NOT a busy signal. */
const BUSY_RES = [/working/i, /esc to interrupt/i, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/];

/** Environmental nag dialogs that eat the next Enter (account/rate-limit
 *  nags, model-switch prompts, update notices). When one is visible the wait
 *  dismisses it with Escape — NEVER Enter, which would accept the dialog's
 *  preselected action (e.g. switching Codex's model, confirming an upgrade).
 *  Escape on a dialogless composer is never sent: dismissal is gated on the
 *  dialog pattern itself. */
const NAG_DIALOG_RES = [
  /enter select · esc back/i, // codex rate-limit/model nag
  /enter to select · esc to dismiss/i,
  /Update Available/i, // opencode upgrade modal ("esc" to dismiss)
];

function dismissNagDialog(paneId: string, visible: string): void {
  if (NAG_DIALOG_RES.some((re) => re.test(visible))) {
    sendKeysToPane(paneId, ["Escape"]);
  }
}

/** Dismiss any environmental nag dialog currently open in the pane (Escape
 *  only), then settle. Called before each delivery: a modal holds keyboard
 *  focus, so a paste while one is open never reaches the composer and the
 *  probe correctly fails closed — the nag is environmental, not the subject
 *  under test. */
export async function dismissNagDialogs(paneId: string): Promise<void> {
  dismissNagDialog(paneId, capturePane(paneId));
  await delay(500);
}

export interface TurnObservation {
  /** Token occurrences in the full scrollback after the wait. */
  tokens: number;
  /** Chips visible in the composer-area capture after the wait. */
  chips: number;
  /** Whether a busy indicator appeared and cleared during the wait. */
  busySeen: boolean;
  busyCleared: boolean;
  /** Scrollback tail at the end of the wait (evidence excerpt). */
  tailText: string;
}

/** Await a reply line and an idle, chip-free composer. Yield between captures
 *  so Playwright records the actual transitions instead of only the last frame.
 *  Callers use unique reply tokens and sample their baseline before delivery. */
export async function waitForTurn(
  paneId: string,
  token: string,
  baseline: number,
  minNew: number,
  timeoutMs = 90_000,
): Promise<TurnObservation> {
  const deadline = Date.now() + timeoutMs;
  let busySeen = false;
  let busyCleared = false;
  let obs: TurnObservation = { tokens: 0, chips: 0, busySeen, busyCleared, tailText: "" };
  while (Date.now() < deadline) {
    const full = capturePane(paneId, { scrollback: true });
    const visible = capturePane(paneId);
    dismissNagDialog(paneId, visible);
    const tokens = countReplies(full, token);
    const chips = countChips(visible);
    const busy = BUSY_RES.some((re) => re.test(visible));
    busySeen ||= busy;
    busyCleared = busySeen && !busy;
    obs = { tokens, chips, busySeen, busyCleared, tailText: tail(full, 16) };
    if (tokens >= baseline + minNew && chips === 0 && !busy) return obs;
    await delay(500);
  }
  return obs;
}

/** POST a prompt through the production send endpoint (mode submit). Returns
 *  the HTTP status; 409 carries the engine's probe/staged/unverified body. */
export async function deliverViaSend(
  page: Page,
  server: string,
  windowId: string,
  text: string,
): Promise<{ status: number; body: string }> {
  const res = await page.request.post(
    `/api/windows/${encodeURIComponent(windowId)}/send?server=${encodeURIComponent(server)}`,
    { data: { text, mode: "submit" } },
  );
  return { status: res.status(), body: await res.text() };
}

/** Create a pane-targeted, immediate-delivery cron entry on the rig daemon.
 *  `every: 1s` makes the entry due at once; the 30s tick cadence paces
 *  successive firings. Returns the assigned entry id. */
export async function cronCreate(
  page: Page,
  server: string,
  name: string,
  paneId: string,
  payload: string,
): Promise<string> {
  const res = await page.request.post(
    `/api/cron/create?server=${encodeURIComponent(server)}`,
    {
      data: {
        name,
        schedule: { kind: "every", interval: "1s" },
        target: { kind: "pane", pane: paneId },
        payload,
        deliver: "immediate",
      },
    },
  );
  if (res.status() !== 201) {
    throw new Error(`cron create: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string };
  return body.id;
}

/** Delete a cron entry (cleanup so a leftover entry cannot keep firing). */
export async function cronDelete(page: Page, server: string, id: string): Promise<void> {
  await page.request.post(`/api/cron/delete?server=${encodeURIComponent(server)}`, {
    data: { id },
  });
}

/** The daemon's logged delivery outcomes for one entry (supporting
 *  diagnostics — never the submission proof). */
export async function cronOutcomes(
  page: Page,
  server: string,
  entryId: string,
): Promise<string[]> {
  const res = await page.request.get(`/api/cron?server=${encodeURIComponent(server)}`);
  if (!res.ok()) return [];
  const body = (await res.json()) as {
    deliveries?: Array<{ entry: string; outcome: string }>;
  };
  return (body.deliveries ?? []).filter((d) => d.entry === entryId).map((d) => d.outcome);
}

/** Browser-side truth: the token is present in the window's xterm buffer (the
 *  WebGL canvas has no readable DOM, so read the buffer model directly). */
export async function terminalSees(page: Page, windowId: string, token: string): Promise<boolean> {
  return page.evaluate(
    ({ windowId, token }) => {
      const term = (
        window as unknown as { __rkTerminals?: Record<string, { buffer: { active: unknown } }> }
      ).__rkTerminals?.[windowId];
      if (!term) return false;
      const buf = term.buffer.active as {
        length: number;
        getLine(y: number): { translateToString(trimRight: boolean): string } | undefined;
      };
      for (let y = 0; y < buf.length; y++) {
        if ((buf.getLine(y)?.translateToString(true) ?? "").includes(token)) return true;
      }
      return false;
    },
    { windowId, token },
  );
}

/** Mark a window as the server's operator tab (role stamp only — no operator
 *  workflow is launched), for role-independence comparisons. */
export function stampOperatorRole(windowId: string): void {
  setWindowOption(windowId, "@rk_win_role", "operator");
}

/** Append one agent's verification record to the untracked evidence dir
 *  (.demo/, gitignored — the change's verification.md links these). */
export function recordMatrixResult(name: string, record: unknown): void {
  const outDir = process.env.DEMO_OUT_DIR ?? join(REPO_ROOT, ".demo");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `agent-injection-matrix-${name}.json`), JSON.stringify(record, null, 2));
}

export { TMUX_SERVER, createSession, killSession, capturePane };

function tail(text: string, lines: number): string {
  const rows = text.split("\n").filter((r) => r.trim() !== "");
  return rows.slice(-lines).join("\n");
}
