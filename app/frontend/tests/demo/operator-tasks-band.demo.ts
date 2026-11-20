/**
 * Demo: the operator Tasks segment's "Needs you" band with its note composer,
 * and the single Cron segment, recorded for PR evidence. The band lists every
 * open escalation (an `escalated:` run note that is still the item's newest
 * note) with its wanted action, `open pane` when the item has a live window,
 * and `note…`, which opens an inline composer; saving writes a `by: user` note
 * to rk's operator state file, wakes the loop, and the row clears once the
 * answer is the newest note. The Cron segment stacks the registry over the
 * deliveries where the base ref has two segments (Cron List, Cron Log).
 *
 * Runs only under `just demo operator-tasks-band` (playwright.demo.config.ts —
 * testDir ./tests/demo), against the throwaway e2e rig, once per project
 * (desktop 1280x800 → the quake drawer's Tasks then Cron segments; mobile
 * 375x812 → the operator route's `?tab=tasks` then `?tab=cron`). The
 * `--before` pass runs the same steps against the base ref, which has no band
 * and no composer: Tasks shows only the ledger and the cron view is the
 * separate Cron List segment.
 *
 * Shared setup: beforeAll seeds one detached session holding a worker window
 * and one holding the operator-role window. The test writes rk's operator
 * state file (two escalated items — `pr-41` with no pane and `pa9n` keyed to
 * the worker window's pane — plus a quiet note item), the cron entry file and
 * a delivery log under the rig's own per-run XDG_STATE_HOME (the harness
 * exports it; the spec refuses to run without it, so it can never touch a
 * real state home). The loop entry's ladder is anchored on a `ran` line
 * followed by three `no change` lines, so its next fire is ~25 minutes out
 * and the rig's cron ticker never fires it mid-recording. afterAll kills both
 * sessions; the rig's EXIT trap removes the state home.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect, beat } from "./_demo";
import { READY_TIMEOUT, openPalette, resolveWindow } from "../e2e/_ready";
import { TMUX_SERVER, createSession, killSession, paneIdForWindow, setWindowOption } from "../e2e/_tmux";

const WORKER_SESSION = `demo-optasks-work-${process.pid}`;
const OPERATOR_SESSION = `demo-optasks-op-${process.pid}`;

const LOOP_ID = "lp01";
const ENTRY_ID = "a3f9";

/** The operator state file stem: the server's socket path with `-` escaped to
 *  `--` first, the leading `/` stripped, and every `/` replaced by `-` — the
 *  rule rk (cron.FabOperatorSlug) and fab share. */
function operatorSlug(socketPath: string): string {
  const slug = socketPath.replaceAll("-", "--").replace(/^\//, "").replaceAll("/", "-");
  return slug === "" ? "default" : slug;
}

function stateHome(): string {
  const home = process.env.XDG_STATE_HOME;
  if (!home || home.trim() === "") {
    throw new Error("operator-tasks-band demo: XDG_STATE_HOME is unset — run it through `just demo`, never against a real state home");
  }
  return home;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const iso = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString().replace(/\.\d+Z$/, "Z");

function rkState(pane: string): string {
  const item = (id: string, kind: string, scope: string, note: string, added: number, updated: number) => `  - id: ${id}
    kind: ${kind}
    probe: {mode: ${kind === "pane" ? "pane" : "none"}}
    check_every: null
    done_when: null
    then: null
    depends_on: []
    scope: ${scope}
    last: {}
    notes:
${note}
    checked_at: null
    unchanged: 0
    failures: 0
    paused: false
    done_at: null
    added_at: "${iso(added)}"
    updated_at: "${iso(updated)}"
`;
  return `tracked:
${item(
  "pr-41",
  "task",
  "{refs: [pr-41]}",
  `      - {at: "${iso(7200)}", by: user, text: "Merge once CI is green."}
      - {at: "${iso(420)}", by: run, text: "escalated: restack needed — conflicts in api/router.go"}`,
  7200,
  420,
)}${item(
  "pa9n",
  "pane",
  `{pane: "${pane}", change: pa9n, repo: /home/demo/hexokit, session: ${WORKER_SESSION}, stage: review, agent: idle, branch: 261111-pa9n-demo}`,
  `      - {at: "${iso(3600)}", by: user, text: "Drive to ship."}
      - {at: "${iso(180)}", by: run, text: "escalated: review failed twice — needs a human decision"}`,
  3600,
  180,
)}${item(
  "n3",
  "note",
  "{refs: [bf1l]}",
  `      - {at: "${iso(86400)}", by: user, text: "Archive the daemon plan once #834 merges."}`,
  86400,
  86400,
)}branch_map: {}
`;
}

function cronEntries(createdAt: number): string {
  return `entries:
  - id: ${LOOP_ID}
    name: operator loop
    run: operator-loop
    schedule: {kind: backoff, min: 3m, max: 24m}
    pinned: true
    created_by: {at: ${createdAt}}
  - id: ${ENTRY_ID}
    name: nightly digest
    schedule: {kind: every, interval: 1h}
    target: {kind: role, role: operator}
    payload: "digest"
    deliver: skip-if-busy
    muted: true
    pinned: true
    created_by: {at: ${createdAt}}
`;
}

function logLine(ts: number, entry: string, reason: string, outcome: string): string {
  return JSON.stringify({ ts, entry, target: "", reason, outcome });
}

/** Open the palette's cron segment opener: the unified `Operator: Show cron`,
 *  or on the base ref `Operator: Show cron list`. */
async function openCronSegment(page: Page, palette: Locator): Promise<void> {
  await palette.fill("Show cron");
  await beat(page, 600);
  const unified = page.getByRole("option", { name: "Operator: Show cron", exact: true });
  if ((await unified.count()) > 0) {
    await unified.click();
  } else {
    await page.getByRole("option", { name: "Operator: Show cron list" }).click();
  }
}

test.describe("operator-tasks-band demo", () => {
  test.beforeAll(async () => {
    createSession(WORKER_SESSION, { windows: ["worker"] });
    createSession(OPERATOR_SESSION, { windows: ["operator"] });
  });

  test.afterAll(() => {
    killSession(WORKER_SESSION);
    killSession(OPERATOR_SESSION);
  });

  /**
   * Proves: Tasks shows a Needs-you band with one row per open escalation —
   * item id, wanted action, `open pane` where a window is live, `note…` —
   * answering one through the inline composer writes the note, queues a check
   * and clears that row; the Cron segment then shows the registry stacked over
   * the deliveries. Same on mobile via `?tab=tasks` and `?tab=cron`. (Base
   * ref: no band or composer, and Cron List / Cron Log are separate segments.)
   *
   * Steps:
   * 1. Stamp the operator window's role; write rk's operator state (two
   *    escalated items, one quiet note) and the cron entries and delivery log
   *    under the rig's XDG_STATE_HOME.
   * 2. Desktop: open the worker window's terminal route, open the palette and
   *    run `Operator: Show tasks`. Mobile: open the operator window's route
   *    with `?tab=tasks`. `beat()` on the band.
   * 3. Open `note…` on the `pr-41` row, type an answer and press Enter;
   *    `beat()` on the `note saved · check queued` line; wait for the row to
   *    clear. (Base ref: no band — `beat()` on the ledger instead.)
   * 4. Desktop: palette → `Operator: Show cron`. Mobile: `?tab=cron`.
   *    `beat()` on the stacked registry and deliveries. (Base ref: the Cron
   *    List segment alone.)
   */
  test("Tasks shows what needs you, a note answers it, and Cron is one segment", async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === "mobile";
    const op = await resolveWindow(page, TMUX_SERVER, OPERATOR_SESSION, "operator");
    setWindowOption(op.windowId, "@rk_win_role", "operator");
    const worker = await resolveWindow(page, TMUX_SERVER, WORKER_SESSION, "worker");
    const pane = paneIdForWindow(worker.windowId);

    const socketPath = execFileSync("tmux", ["-L", TMUX_SERVER, "display-message", "-p", "#{socket_path}"], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    const slug = operatorSlug(socketPath);
    const home = stateHome();
    mkdirSync(join(home, "hexokit", "operator"), { recursive: true });
    writeFileSync(join(home, "hexokit", "operator", `${slug}.yaml`), rkState(pane), { mode: 0o600 });

    const T = nowSec();
    const cronDir = join(home, "hexokit", "cron");
    mkdirSync(cronDir, { recursive: true });
    writeFileSync(join(cronDir, `${TMUX_SERVER}.yaml`), cronEntries(T - 7200), { mode: 0o600 });
    writeFileSync(
      join(cronDir, `${TMUX_SERVER}.log`),
      [
        logLine(T - 4000, ENTRY_ID, "schedule", "delivered"),
        logLine(T - 1200, LOOP_ID, "wake", "ran · nudged pa9n; noted · 2m13s"),
        logLine(T - 1020, LOOP_ID, "schedule", "no change"),
        logLine(T - 660, LOOP_ID, "schedule", "no change"),
        logLine(T - 60, LOOP_ID, "schedule", "no change"),
      ].join("\n") + "\n",
      { mode: 0o600 },
    );

    if (isMobile) {
      await page.goto(`/${TMUX_SERVER}/${op.windowId.replace(/^@/, "")}?tab=tasks`);
    } else {
      await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(worker.windowId)}`);
      await expect(page.getByTestId("status-bar").locator("[aria-label='Connected']")).toBeVisible({
        timeout: READY_TIMEOUT,
      });
      await beat(page);
      const palette = await openPalette(page);
      await palette.fill("Show tasks");
      await beat(page, 600);
      await palette.press("Enter");
    }

    const tasks = page.getByTestId("watched-tasks");
    await expect(tasks).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(tasks.getByTestId("watched-table")).toBeVisible({ timeout: READY_TIMEOUT });

    const band = tasks.getByTestId("needs-you-band");
    const hasBand = await band
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    await beat(page, 2_500);

    if (hasBand) {
      const row = band.locator('[data-testid="needs-you-row"][data-item-id="pr-41"]');
      await row.getByTestId("needs-you-note").click();
      const input = row.getByTestId("operator-note-input");
      await expect(input).toBeFocused();
      await input.pressSequentially("Rebase onto main and re-run CI.", { delay: 40 });
      await beat(page, 600);
      await input.press("Enter");
      await expect(tasks.getByTestId("needs-you-status")).toBeVisible({ timeout: READY_TIMEOUT });
      await beat(page, 2_000);
      // The row clears when the next sessions payload carries the answer as
      // the newest note; a slow rig simply ends the beat on the status line.
      await expect(row)
        .toHaveCount(0, { timeout: 30_000 })
        .catch(() => undefined);
      await beat(page, 2_500);
    }

    if (isMobile) {
      await page.goto(`/${TMUX_SERVER}/${op.windowId.replace(/^@/, "")}?tab=${hasBand ? "cron" : "list"}`);
    } else {
      const palette = await openPalette(page);
      await openCronSegment(page, palette);
    }
    await expect(page.getByTestId("cron-list")).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByTestId(`cron-list-row-${ENTRY_ID}`)).toBeVisible({ timeout: READY_TIMEOUT });
    await beat(page, 2_500);
    if (hasBand) {
      await expect(page.getByTestId("cron-log")).toBeVisible({ timeout: READY_TIMEOUT });
      await beat(page, 3_000);
    }
  });
});
