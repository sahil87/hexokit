/**
 * Demo: the Operator Tasks segment reading rk's own operator state file and
 * showing each tracked item's notes, recorded for PR evidence. Every row's
 * note cell carries the item's latest note (author, age, `+N` for older
 * notes) and expands in place to the whole list, fetched on demand from
 * `GET /api/operator/notes`; a worker row prefers its item note over the
 * window's tab note.
 *
 * Runs only under `just demo operator-notes` (playwright.demo.config.ts —
 * testDir ./tests/demo), against the throwaway e2e rig, once per project
 * (desktop 1280x800 → the quake drawer's Operator Tasks segment; mobile
 * 375x812 → the operator route's `?tab=tasks`). The `--before` pass runs the
 * same steps against the base ref, whose backend reads only fab's file: the
 * rows then show fab's frozen ledger (the legacy note text, no run notes), so
 * the pair shows the post-adopt state the drawer now surfaces.
 *
 * Shared setup: beforeAll seeds two detached sessions — one holding a worker
 * window, one holding a window stamped with the operator role — and writes
 * BOTH operator state files under the rig's own per-run XDG_STATE_HOME (the
 * harness exports it; the spec refuses to run without it, so it can never
 * touch a real state home): rk's `hexokit/operator/<slug>.yaml` with notes,
 * and fab's `fab/operator/<slug>.yaml` as it looked before adopt. The slug is
 * the rig server's socket path slugified the way rk and fab both do. afterAll
 * kills both sessions; the rig's EXIT trap removes the state home.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, beat } from "./_demo";
import { READY_TIMEOUT, openPalette, resolveWindow } from "../e2e/_ready";
import {
  TMUX_SERVER,
  createSession,
  killSession,
  paneIdForWindow,
  setWindowOption,
} from "../e2e/_tmux";

const WORKER_SESSION = `demo-opnotes-work-${process.pid}`;
const OPERATOR_SESSION = `demo-opnotes-op-${process.pid}`;

/** The operator state file stem: the server's socket path with `-` escaped
 *  to `--` first, the leading `/` stripped, and every `/` replaced by `-` —
 *  the rule rk (cron.FabOperatorSlug) and fab share. */
function operatorSlug(socketPath: string): string {
  const slug = socketPath.replaceAll("-", "--").replace(/^\//, "").replaceAll("/", "-");
  return slug === "" ? "default" : slug;
}

function stateHome(): string {
  const home = process.env.XDG_STATE_HOME;
  if (!home || home.trim() === "") {
    throw new Error("operator-notes demo: XDG_STATE_HOME is unset — run it through `just demo`, never against a real state home");
  }
  return home;
}

const iso = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString().replace(/\.\d+Z$/, "Z");

function rkState(pane: string): string {
  return `tracked:
  - id: pa9n
    kind: pane
    probe: {mode: pane}
    check_every: null
    done_when: null
    then: null
    depends_on: []
    scope: {pane: "${pane}", change: pa9n, repo: /home/demo/hexokit, session: ${WORKER_SESSION}, stage: review, agent: idle, branch: 261111-pa9n-demo}
    last: {}
    notes:
      - {at: "${iso(7200)}", by: user, text: "Drive to ship; stop at review if the diff touches the daemon."}
      - {at: "${iso(900)}", by: run, text: "Review passed. Waiting on CI before hydrate."}
    checked_at: null
    unchanged: 0
    failures: 0
    paused: false
    done_at: null
    added_at: "${iso(7200)}"
    updated_at: "${iso(900)}"
  - id: n3
    kind: note
    probe: {mode: none}
    check_every: null
    done_when: null
    then: null
    depends_on: []
    scope: {refs: [bf1l]}
    last: {}
    notes:
      - {at: "${iso(86400)}", by: user, text: "Daemon reliability plan — archive once PR #834 merges."}
      - {at: "${iso(7200)}", by: run, text: "PR #834 still open, awaiting user merge."}
      - {at: "${iso(600)}", by: chat, text: "User merged #834 — archive the plan now."}
    checked_at: null
    unchanged: 0
    failures: 0
    paused: false
    done_at: null
    added_at: "${iso(86400)}"
    updated_at: "${iso(600)}"
branch_map: {}
`;
}

function fabState(pane: string): string {
  return `last_tick_at: ${Math.floor(Date.now() / 1000) - 60}
tracked:
  - id: pa9n
    kind: fab-change
    scope: {pane: "${pane}", repo: /home/demo/hexokit, session: ${WORKER_SESSION}, stage: apply, agent: busy, branch: 261111-pa9n-demo}
    paused: false
    done_at: null
    added_at: "${iso(7200)}"
    updated_at: "${iso(7200)}"
  - id: n3
    kind: note
    text: "Daemon reliability plan — archive once PR #834 merges."
    scope: {refs: [bf1l]}
    paused: false
    done_at: null
    added_at: "${iso(86400)}"
    updated_at: "${iso(86400)}"
`;
}

test.describe("operator-notes demo", () => {
  test.beforeAll(async () => {
    createSession(WORKER_SESSION, { windows: ["worker"] });
    createSession(OPERATOR_SESSION, { windows: ["operator"] });
  });

  test.afterAll(() => {
    killSession(WORKER_SESSION);
    killSession(OPERATOR_SESSION);
  });

  /**
   * Proves: with rk's operator state file present, the Operator Tasks
   * segment lists rk's items (not fab's) with each item's latest note —
   * author, age and a `+N` hint — and expanding a note lists every note on
   * the item, oldest first; the worker row shows its item note rather than
   * the window's tab note. Same on mobile via `?tab=tasks`.
   *
   * Steps:
   * 1. Stamp the operator window's role, give the worker window a tab note,
   *    and write rk's and fab's operator state files (the worker item keyed
   *    to the worker window's pane) under the rig's XDG_STATE_HOME.
   * 2. Desktop: open the worker window's terminal route, open the palette and
   *    run `Operator: Show tasks`; `beat()` on the rows.
   *    Mobile: open the operator window's route with `?tab=tasks`; `beat()`.
   * 3. Expand the n3 note row's note cell (all three notes render); `beat()`;
   *    collapse it.
   * 4. Expand the worker row's note cell (both notes render); `beat()`.
   *    (Base ref: the rows show fab's ledger; the expand toggles reveal the
   *    one legacy text, and the worker row shows the tab note.)
   */
  test("Operator Tasks shows each item's latest note and expands to all notes", async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === "mobile";
    const op = await resolveWindow(page, TMUX_SERVER, OPERATOR_SESSION, "operator");
    setWindowOption(op.windowId, "@rk_win_role", "operator");
    const worker = await resolveWindow(page, TMUX_SERVER, WORKER_SESSION, "worker");
    setWindowOption(worker.windowId, "@rk_win_note", `${Math.floor(Date.now() / 1000) - 3600}:tab note — reviewing`);
    const pane = paneIdForWindow(worker.windowId);

    const socketPath = execFileSync("tmux", ["-L", TMUX_SERVER, "display-message", "-p", "#{socket_path}"], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    const slug = operatorSlug(socketPath);
    const home = stateHome();
    mkdirSync(join(home, "hexokit", "operator"), { recursive: true });
    mkdirSync(join(home, "fab", "operator"), { recursive: true });
    writeFileSync(join(home, "hexokit", "operator", `${slug}.yaml`), rkState(pane), { mode: 0o600 });
    writeFileSync(join(home, "fab", "operator", `${slug}.yaml`), fabState(pane), { mode: 0o600 });

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
    const noteRow = tasks.getByTestId("tracked-item-row").filter({ hasText: "n3" });
    await expect(noteRow).toBeVisible({ timeout: READY_TIMEOUT });
    await beat(page, 2_000);

    await noteRow.getByTestId("tracked-item-expand").click();
    await beat(page, 2_500);
    await noteRow.getByTestId("tracked-item-expand").first().click();
    await beat(page);

    const workerRow = tasks.getByTestId("watched-row");
    if ((await workerRow.count()) > 0) {
      const expand = workerRow.first().getByTestId("tracked-item-expand");
      if ((await expand.count()) > 0) {
        await expand.first().click();
        await beat(page, 2_500);
      }
    }
    await beat(page);
  });
});
