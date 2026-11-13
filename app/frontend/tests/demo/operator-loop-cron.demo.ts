/**
 * Demo: the operator loop's Cron List row and Cron Log detail sheet, recorded
 * for PR evidence. The loop is a target-less cron entry (`run: operator-loop`):
 * the Cron List shows it with the `operator loop` chip instead of a role or
 * session target, and a Cron Log row for a finished run opens a detail sheet
 * that carries the run's id, outcome line and run log path as copyable text.
 *
 * Runs only under `just demo operator-loop-cron` (playwright.demo.config.ts —
 * testDir ./tests/demo), against the throwaway e2e rig, once per project
 * (desktop 1280x800 → the quake drawer's cron segments; mobile 375x812 → the
 * operator route's `?tab=list` / `?tab=log`). The `--before` pass runs the same
 * steps against the base ref, whose backend neither knows the `run` key (the
 * loop entry is skipped as invalid, so the list shows only the typed entry)
 * nor joins run fields into deliveries (the sheet shows no run block) — the
 * pair shows the capability appearing.
 *
 * Shared setup: beforeAll seeds one detached session holding a worker window
 * and one holding the operator-role window. The test then writes the cron
 * entry file, the delivery log, and one finished run record plus its log under
 * the rig's own per-run XDG_STATE_HOME (the harness exports it; the spec
 * refuses to run without it, so it can never touch a real state home). The loop
 * entry's ladder is anchored on a `ran` line followed by three `no change`
 * lines, so its next fire is ~25 minutes out and the rig's cron ticker never
 * fires it mid-recording. afterAll kills both sessions; the rig's EXIT trap
 * removes the state home.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, beat } from "./_demo";
import { READY_TIMEOUT, openPalette, resolveWindow } from "../e2e/_ready";
import { TMUX_SERVER, createSession, killSession, setWindowOption } from "../e2e/_tmux";

const WORKER_SESSION = `demo-oploop-work-${process.pid}`;
const OPERATOR_SESSION = `demo-oploop-op-${process.pid}`;

const LOOP_ID = "lp01";
const LEGACY_ID = "a3f9";
const OUTCOME = "nudged pa9n at review; noted";

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
    throw new Error("operator-loop-cron demo: XDG_STATE_HOME is unset — run it through `just demo`, never against a real state home");
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
  - id: ${LEGACY_ID}
    name: operator tick
    schedule: {kind: backoff, min: 3m, max: 24m}
    target: {kind: role, role: operator}
    payload: "operator tick"
    deliver: skip-if-busy
    muted: true
    pinned: true
    created_by: {at: ${createdAt}}
`;
}

function logLine(ts: number, outcome: string, run?: string): string {
  return JSON.stringify({ ts, entry: LOOP_ID, target: "", reason: "schedule", outcome, ...(run ? { run } : {}) });
}

test.describe("operator-loop-cron demo", () => {
  test.beforeAll(async () => {
    createSession(WORKER_SESSION, { windows: ["worker"] });
    createSession(OPERATOR_SESSION, { windows: ["operator"] });
  });

  test.afterAll(() => {
    killSession(WORKER_SESSION);
    killSession(OPERATOR_SESSION);
  });

  /**
   * Proves: the Cron List shows the operator loop as a target-less entry (the
   * `operator loop` chip, no role/session target) beside the muted legacy
   * tick, and opening a Cron Log row for a finished run shows its run id,
   * outcome line and run log path as copyable text. Same on mobile via the
   * operator route's `?tab=list` and `?tab=log`.
   *
   * Steps:
   * 1. Stamp the operator window's role and write the cron entry file, the
   *    delivery log and one finished run's record + log under the rig's
   *    XDG_STATE_HOME.
   * 2. Desktop: open the worker window's terminal route, open the palette and
   *    run `Operator: Show cron list`; `beat()` on the rows.
   *    Mobile: open the operator window's route with `?tab=list`; `beat()`.
   * 3. Desktop: palette → `Operator: Show cron log`. Mobile: `?tab=log`.
   *    `beat()` on the delivery rows.
   * 4. Open the `ran` delivery's row; `beat()` on the sheet's run fields;
   *    click Copy on the run log row. (Base ref: the row opens a sheet with no
   *    run block — the backend predates the fields.)
   */
  test("Cron List shows the operator loop; a run's Cron Log sheet shows its run log", async ({ page }, testInfo) => {
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
    const id = runId(ranAt - 133, "ab12");
    const cronDir = join(home, "hexokit", "cron");
    const runsDir = join(home, "hexokit", "operator", "runs", slug);
    mkdirSync(cronDir, { recursive: true });
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(cronDir, `${TMUX_SERVER}.yaml`), cronEntries(T - 7200), { mode: 0o600 });
    writeFileSync(
      join(cronDir, `${TMUX_SERVER}.log`),
      [
        logLine(T - 5000, "run-failed: exit 1 · 4s", runId(T - 5004, "cd34")),
        logLine(ranAt, `ran · ${OUTCOME} · 2m13s`, id),
        logLine(T - 1020, "no change"),
        logLine(T - 660, "no change"),
        logLine(T - 60, "no change"),
      ].join("\n") + "\n",
      { mode: 0o600 },
    );
    writeFileSync(
      join(runsDir, `${id}.json`),
      JSON.stringify({
        id,
        server: TMUX_SERVER,
        entry: LOOP_ID,
        fired_at: iso(ranAt - 133),
        changed: ["pa9n"],
        window: "run-ab12",
        started_at: iso(ranAt - 131),
        ended_at: iso(ranAt),
        exit_code: 0,
        outcome: OUTCOME,
        logged: true,
      }),
      { mode: 0o600 },
    );
    writeFileSync(join(runsDir, `${id}.log`), `acted on pa9n\noutcome: ${OUTCOME}\n`, { mode: 0o600 });

    if (isMobile) {
      await page.goto(`/${TMUX_SERVER}/${op.windowId.replace(/^@/, "")}?tab=list`);
    } else {
      await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(worker.windowId)}`);
      await expect(page.getByTestId("status-bar").locator("[aria-label='Connected']")).toBeVisible({
        timeout: READY_TIMEOUT,
      });
      await beat(page);
      const palette = await openPalette(page);
      await palette.fill("Show cron list");
      await beat(page, 600);
      await palette.press("Enter");
    }

    const list = page.getByTestId("cron-list");
    await expect(list).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByTestId(`cron-list-row-${LEGACY_ID}`)).toBeVisible({ timeout: READY_TIMEOUT });
    await beat(page, 2_500);

    if (isMobile) {
      await page.goto(`/${TMUX_SERVER}/${op.windowId.replace(/^@/, "")}?tab=log`);
    } else {
      const palette = await openPalette(page);
      await palette.fill("Show cron log");
      await beat(page, 600);
      await palette.press("Enter");
    }

    const log = page.getByTestId("cron-log");
    await expect(log).toBeVisible({ timeout: READY_TIMEOUT });
    const rows = log.getByTestId(`cron-delivery-row-${LOOP_ID}`);
    await expect(rows.first()).toBeVisible({ timeout: READY_TIMEOUT });
    await beat(page, 2_000);

    await rows.filter({ hasText: "ran ·" }).first().click();
    await expect(page.getByTestId("cron-entry-sheet")).toBeVisible({ timeout: READY_TIMEOUT });
    await beat(page, 2_500);

    const copy = page.getByRole("button", { name: "Copy run log" });
    if ((await copy.count()) > 0) {
      await copy.click();
      await beat(page, 1_500);
    }
  });
});
