/**
 * Demo: the operator Activity tab — one row per loop fire with its trigger,
 * check summary and run summary, a row expanding to the changed/open lists,
 * the brief and the run log, the `runs · triggers · all` chips, and Check now,
 * recorded for PR evidence. The `--before` pass shows what the same
 * workflow looked like without the tab: the Cron Log, where the loop's
 * heartbeats arrive as bare `no change` rows with no check summary, no brief
 * and no way to ask for a check.
 *
 * Runs only under `just demo operator-activity` (playwright.demo.config.ts —
 * testDir ./tests/demo), against the throwaway e2e rig, once per project
 * (desktop 1280x800 → the quake drawer's Activity segment; mobile 375x812 →
 * the operator route's `?tab=activity`).
 *
 * Shared setup: beforeAll seeds one detached session holding a worker window
 * and one holding the operator-role window. The test writes the cron entry
 * file, the delivery log (a finished run and three `no change` fires), each
 * fire's check record, and the run's record, brief and log under the rig's
 * own per-run XDG_STATE_HOME (the harness exports it; the spec refuses to run
 * without it, so it can never touch a real state home). The ladder is
 * anchored on a `ran` line followed by three `no change` lines, so the loop's
 * next scheduled fire is ~24 minutes out and never fires mid-recording; Check
 * now writes the trigger marker, and with no tracked items the check the next
 * tick runs finds nothing and launches no run. afterAll kills both sessions;
 * the rig's EXIT trap removes the state home.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, beat } from "./_demo";
import { READY_TIMEOUT, openPalette, resolveWindow } from "../e2e/_ready";
import { TMUX_SERVER, createSession, killSession, setWindowOption } from "../e2e/_tmux";

const WORKER_SESSION = `demo-opact-work-${process.pid}`;
const OPERATOR_SESSION = `demo-opact-op-${process.pid}`;

const LOOP_ID = "lp01";

/** The operator state file stem: the server's socket path with `-` escaped to
 *  `--` first, the leading `/` stripped, and every `/` replaced by `-` — the
 *  rule rk (cron.FabOperatorSlug) and fab share. The run files live under the
 *  same slug. */
function operatorSlug(socketPath: string): string {
  const slug = socketPath.replaceAll("-", "--").replace(/^\//, "").replaceAll("/", "-");
  return slug === "" ? "default" : slug;
}

function stateHome(): string {
  const home = process.env.XDG_STATE_HOME;
  if (!home || home.trim() === "") {
    throw new Error("operator-activity demo: XDG_STATE_HOME is unset — run it through `just demo`, never against a real state home");
  }
  return home;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const iso = (ts: number) => new Date(ts * 1000).toISOString().replace(/\.\d+Z$/, "Z");

/** `YYYYMMDDTHHMMSS-xxxx` for a unix-seconds time — the run id grammar. */
function runId(ts: number, suffix: string): string {
  return `${iso(ts).replace(/[-:]/g, "").replace("Z", "")}-${suffix}`;
}

function cronEntries(createdAt: number): string {
  return `entries:
  - id: ${LOOP_ID}
    name: operator loop
    run: operator-loop
    schedule: {kind: backoff, min: 3m, max: 24m}
    pinned: true
    created_by: {at: ${createdAt}}
`;
}

function logLine(ts: number, reason: string, outcome: string, ids: { fire?: string; run?: string } = {}): string {
  return JSON.stringify({
    ts,
    entry: LOOP_ID,
    target: "",
    reason,
    outcome,
    ...(ids.fire ? { fire: ids.fire } : {}),
    ...(ids.run ? { run: ids.run } : {}),
  });
}

interface CheckFile {
  ts: number;
  reason: string;
  changed: boolean;
  changes: unknown[];
  open: unknown[];
  notices?: unknown[];
  run?: string;
}

function checkRecord(c: CheckFile): string {
  return JSON.stringify({
    fired_at: iso(c.ts),
    reason: c.reason,
    checked_at: iso(c.ts + 1),
    changed: c.changed,
    changes: c.changes,
    open: c.open,
    notices: c.notices ?? [],
    ...(c.run ? { run: c.run } : {}),
  });
}

test.describe("operator-activity demo", () => {
  test.beforeAll(async () => {
    createSession(WORKER_SESSION, { windows: ["worker"] });
    createSession(OPERATOR_SESSION, { windows: ["operator"] });
  });

  test.afterAll(() => {
    killSession(WORKER_SESSION);
    killSession(OPERATOR_SESSION);
  });

  /**
   * Proves: the Activity tab lists each loop fire with its trigger label,
   * check summary and run summary; the chips narrow the rows; expanding the
   * run's row shows the changed items, the brief and the run log; and Check
   * now queues a check. Same on mobile via `?tab=activity`. (Base ref: the
   * loop's heartbeats are bare `no change` rows in the Cron Log.)
   *
   * Steps:
   * 1. Stamp the operator window's role; write the cron entries, the delivery
   *    log, the fires' check records and the run's record/brief/log under the
   *    rig's XDG_STATE_HOME.
   * 2. Desktop: open the worker window's terminal route, open the palette and
   *    run `Operator: Show activity`. Mobile: open the operator window's
   *    route with `?tab=activity`. `beat()` on the rows.
   * 3. Pick the `runs` chip, then `triggers`, then `all`; `beat()` between.
   * 4. Expand the run's row; `beat()` on the lists, brief and run log;
   *    collapse it.
   * 5. Click Check now; wait for the next cron tick's new `manual` row and
   *    `beat()` on it.
   *    (Base ref: no Activity segment — open the Cron Log and `beat()` on the
   *    loop rows instead.)
   */
  test("Activity lists each fire, expands to its brief and log, and Check now queues a check", async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === "mobile";
    const op = await resolveWindow(page, TMUX_SERVER, OPERATOR_SESSION, "operator");
    setWindowOption(op.windowId, "@rk_win_role", "operator");
    const worker = await resolveWindow(page, TMUX_SERVER, WORKER_SESSION, "worker");

    const socketPath = execFileSync("tmux", ["-L", TMUX_SERVER, "display-message", "-p", "#{socket_path}"], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    const slug = operatorSlug(socketPath);
    const home = stateHome();

    const T = nowSec();
    const ranAt = T - 1200;
    const ranFire = runId(ranAt - 133, "ab12");
    const fireA = runId(T - 1020, "cd34");
    const fireB = runId(T - 600, "ef56");
    const fireC = runId(T - 60, "gh78");
    const cronDir = join(home, "hexokit", "cron");
    const runsDir = join(home, "hexokit", "operator", "runs", slug);
    mkdirSync(cronDir, { recursive: true });
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(cronDir, `${TMUX_SERVER}.yaml`), cronEntries(T - 7200), { mode: 0o600 });
    writeFileSync(
      join(cronDir, `${TMUX_SERVER}.log`),
      [
        logLine(T - 5000, "schedule", "no change"),
        logLine(ranAt, "wake", "ran · nudged pa9n at review; noted · 2m13s", { run: ranFire }),
        logLine(T - 1020, "schedule", "no change", { fire: fireA }),
        logLine(T - 600, "trigger:manual", "no change", { fire: fireB }),
        logLine(T - 60, "schedule", "no change", { fire: fireC }),
      ].join("\n") + "\n",
      { mode: 0o600 },
    );

    const stale = { kind: "stale", id: "pr-41", age: "3d" };
    const due = { kind: "due", id: "n3", age: "1h", instruction: "archive the plan" };
    const writeCheck = (id: string, c: CheckFile) =>
      writeFileSync(join(runsDir, `${id}.check.json`), checkRecord(c), { mode: 0o600 });
    writeCheck(ranFire, {
      ts: ranAt - 133,
      reason: "wake",
      changed: true,
      changes: [{ kind: "agent-state", id: "pa9n", pane: "%3", from: "busy", to: "waiting", duration: "6m" }],
      open: [stale],
      run: ranFire,
    });
    writeCheck(fireA, { ts: T - 1020, reason: "schedule", changed: false, changes: [], open: [stale] });
    writeCheck(fireB, { ts: T - 600, reason: "trigger:manual", changed: false, changes: [], open: [stale, due] });
    writeCheck(fireC, {
      ts: T - 60,
      reason: "schedule",
      changed: false,
      changes: [],
      open: [stale, due],
      notices: [{ id: "pa9n", kind: "paused", error: "probe failed", failures: 2 }],
    });
    writeFileSync(
      join(runsDir, `${ranFire}.json`),
      JSON.stringify({
        id: ranFire,
        server: TMUX_SERVER,
        entry: LOOP_ID,
        fired_at: iso(ranAt - 133),
        reason: "wake",
        changed: ["pa9n"],
        pass: { actions: 1, escalations: [] },
        window: "run-ab12",
        started_at: iso(ranAt - 131),
        ended_at: iso(ranAt),
        exit_code: 0,
        outcome: "nudged pa9n at review; noted",
        logged: true,
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(runsDir, `${ranFire}.brief.md`),
      "# Operator run\n\nChanged: pa9n — agent busy→waiting (6m)\n\nOpen: pr-41 stale 3d\n",
      { mode: 0o600 },
    );
    writeFileSync(join(runsDir, `${ranFire}.log`), "nudged pa9n at review\noutcome: nudged pa9n at review; noted\n", {
      mode: 0o600,
    });

    if (isMobile) {
      await page.goto(`/${TMUX_SERVER}/${op.windowId.replace(/^@/, "")}?tab=activity`);
    } else {
      await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(worker.windowId)}`);
      await expect(page.getByTestId("status-bar").locator("[aria-label='Connected']")).toBeVisible({
        timeout: READY_TIMEOUT,
      });
      await beat(page);
      const palette = await openPalette(page);
      await palette.fill("Show activity");
      await beat(page, 600);
      await palette.press("Enter");
    }

    const activity = page.getByTestId("operator-activity");
    const hasActivity = await activity
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!hasActivity) {
      // Base ref: the loop's heartbeats live in the Cron Log.
      if (isMobile) {
        await page.goto(`/${TMUX_SERVER}/${op.windowId.replace(/^@/, "")}?tab=log`);
      } else {
        const palette = await openPalette(page);
        await palette.fill("Show cron log");
        await beat(page, 600);
        await palette.press("Enter");
      }
      await expect(page.getByTestId("cron-log")).toBeVisible({ timeout: READY_TIMEOUT });
      await expect(page.getByTestId(`cron-delivery-row-${LOOP_ID}`).first()).toBeVisible({ timeout: READY_TIMEOUT });
      await beat(page, 4_000);
      return;
    }

    const rows = activity.getByTestId("operator-activity-row");
    await expect(rows).toHaveCount(5, { timeout: READY_TIMEOUT });
    await beat(page, 2_500);

    for (const chip of ["runs", "triggers", "all"]) {
      await activity.getByTestId(`operator-activity-filter-${chip}`).click();
      await beat(page, 1_200);
    }

    const runRow = rows.filter({ hasText: "trigger · agent" });
    await runRow.getByRole("button").first().click();
    await expect(runRow.getByTestId("operator-activity-brief")).toContainText("Operator run", { timeout: READY_TIMEOUT });
    await expect(runRow.getByTestId("operator-activity-log")).toContainText("outcome:", { timeout: READY_TIMEOUT });
    await beat(page, 3_500);
    await runRow.getByRole("button").first().click();
    await beat(page);

    await activity.getByTestId("operator-activity-check-now").click();
    await beat(page, 1_500);
    // The marker is consumed by the next cron tick (≤30s); the new `manual`
    // row is the visible result. A rig whose ticker is idle simply ends the
    // recording on the queued state.
    await rows
      .nth(5)
      .waitFor({ state: "visible", timeout: 45_000 })
      .catch(() => undefined);
    await beat(page, 3_000);
  });
});
