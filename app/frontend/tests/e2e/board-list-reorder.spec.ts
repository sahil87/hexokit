import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { apiBase, pinWindow } from "./_boards";
import { SETTINGS_PATH } from "./_settings";
import { TMUX_SERVER, createSession, killSession, listWindows } from "./_tmux";

// Behavioural contract for the board-list-reorder backend surface: the
// `board_order` key on POST /api/settings (persists the full ordered
// board-name list to ~/.config/hexokit/config.yaml via partial merge), the
// API-layer rank-aware sort on GET /api/boards (stored order first by index,
// then unranked boards alphabetically). Native HTML5 drag is
// unreliable to simulate in Playwright, so the drag affordances,
// derive-over-store override, render-time reconcile, MIME discrimination,
// self-target snap-back, debounce/flush, and palette Move actions are covered
// by Vitest unit tests (use-board-list-reorder.test.ts, palette/move.test.ts,
// boards.test.ts, boards-section.test.tsx, host-overview-page.test.tsx); this
// spec exercises the deterministic backend surface end-to-end.
//
// SETTINGS_PATH (from ./_settings) derives from RK_CONFIG_DIR when set:
// under `just test-e2e` the harness points backend and specs at a per-run
// temp config root, so this suite's POST /api/settings writes never touch
// the developer's real ~/.config/hexokit/config.yaml. The snapshot/restore
// pattern is KEPT as the fallback for the interactive `just pw` lane (a
// `just dev` rig with no RK_CONFIG_DIR — SETTINGS_PATH is then the real
// file and still needs protecting; under the harness the same pattern is a
// harmless no-op on the temp file). beforeAll snapshots its raw bytes
// (recording whether the file existed at all); afterAll restores those
// exact bytes — or deletes the file when none existed — so any curated
// board order round-trips byte-identically and no test residue persists
// (best-effort, so a teardown error never masks a test failure). beforeAll
// also creates one tmux session (`e2e-board-reorder-<ts>` with windows
// win-a/win-b) on E2E_TMUX_SERVER (default `rk-test-e2e`); afterAll kills
// it. apiBase() resolves the backend origin; windowIds() reads win-a/win-b's
// stable tmux window ids so pins are created deterministically via the API
// (not the hover popover).
// `undefined` = the file did not exist before the suite (restore = delete it);
// a Buffer = its exact original bytes (restore = write them back verbatim).
let settingsSnapshot: Buffer | undefined;
let settingsExisted = false;

const TEST_SESSION = `e2e-board-reorder-${Date.now()}`;
// Board names are constrained to alphanumeric/-/_. Fresh, sortable-distinct
// names per run: `zzz…` sorts AFTER `aaa…` alphabetically, so a stored order of
// [zzz, aaa] proves the reorder overrides the default alphabetical sort.
const BOARD_A = `aaa${Date.now().toString().slice(-6)}`;
const BOARD_Z = `zzz${Date.now().toString().slice(-6)}`;

test.describe("Board list reorder — order endpoint + rank-aware sort", () => {
  test.beforeAll(() => {
    // Snapshot the settings file at SETTINGS_PATH (raw bytes) before this
    // suite mutates it via POST /api/settings (board_order key). Restored
    // verbatim in afterAll so any curated board order survives
    // byte-identically. Under `just test-e2e` this is the harness's per-run
    // temp file; under `just pw` it is the developer's REAL config, where
    // residue would otherwise persist.
    try {
      settingsSnapshot = readFileSync(SETTINGS_PATH);
      settingsExisted = true;
    } catch (err) {
      // Only ENOENT means "no file to restore" (afterAll then deletes any
      // residue). Any other read error (EACCES/EIO) means the file EXISTS but
      // couldn't be snapshotted — rethrow so afterAll never rmSync-deletes the
      // developer's real settings on a failed snapshot.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      settingsSnapshot = undefined;
      settingsExisted = false;
    }

    // Two windows so we can pin one to each of two boards (a board exists only
    // while ≥1 pin carries its name).
    createSession(TEST_SESSION, { windows: ["win-a", "win-b"] });
  });

  test.afterAll(() => {
    // Restore the settings snapshot even if tests failed (afterAll always runs).
    // Write the ORIGINAL bytes back — or delete the file if none existed — so the
    // board order is byte-identical to before the suite ran.
    try {
      if (settingsExisted && settingsSnapshot !== undefined) {
        writeFileSync(SETTINGS_PATH, settingsSnapshot);
      } else {
        rmSync(SETTINGS_PATH, { force: true });
      }
    } catch {
      // Best-effort — never mask a test failure with a teardown error.
    }

    killSession(TEST_SESSION);
  });

  function windowIds(): { winA: string; winB: string } {
    const wins = listWindows(TEST_SESSION);
    const winA = wins.find((w) => w.name === "win-a")?.windowId ?? "";
    const winB = wins.find((w) => w.name === "win-b")?.windowId ?? "";
    return { winA, winB };
  }

  /**
   * Proves: after pinning win-a → BOARD_A and win-b → BOARD_Z, the board list
   * defaults to alphabetical ([BOARD_A, BOARD_Z]); a POST /api/settings patch
   * of {board_order: [BOARD_Z, BOARD_A]} returns {status: "ok"} and
   * GET /api/boards then returns [BOARD_Z, BOARD_A] — the API-layer
   * rank-aware sort applies the stored order.
   *
   * Steps:
   * 1. Read win-a/win-b window ids.
   * 2. POST /api/boards/<BOARD_A>/pin (win-a) and
   *    POST /api/boards/<BOARD_Z>/pin (win-b); assert each is ok.
   * 3. GET /api/boards; filter to the two test boards; assert the alphabetical
   *    baseline [BOARD_A, BOARD_Z].
   * 4. POST /api/settings with {board_order: [BOARD_Z, BOARD_A]}; assert ok +
   *    {status: "ok"}.
   * 5. GET /api/boards; filter to the two test boards; assert
   *    [BOARD_Z, BOARD_A] (stored order overrides alphabetical).
   */
  test("reorder POST persists and GET /api/boards reflects the stored order first, then alphabetical", async ({
    request,
    baseURL,
  }) => {
    const base = apiBase(baseURL);
    const { winA, winB } = windowIds();
    expect(winA, "win-a id").toBeTruthy();
    expect(winB, "win-b id").toBeTruthy();

    // Pin win-a → BOARD_A (aaa…) and win-b → BOARD_Z (zzz…). Default board list
    // sort is alphabetical, so without a stored order aaa… precedes zzz….
    for (const [board, winId] of [
      [BOARD_A, winA],
      [BOARD_Z, winB],
    ] as const) {
      await pinWindow(request, board, TMUX_SERVER, winId);
    }

    // Baseline: alphabetical (aaa… before zzz…).
    const baseline = (await (await request.get(`${base}/api/boards`)).json()) as Array<{
      name: string;
    }>;
    const baseNames = baseline.map((b) => b.name).filter((n) => n === BOARD_A || n === BOARD_Z);
    expect(baseNames).toEqual([BOARD_A, BOARD_Z]);

    // POST a reorder putting zzz… FIRST — overriding the alphabetical default.
    // The order rides POST /api/settings as the board_order key (partial merge
    // per Constitution IX).
    const post = await request.post(`${base}/api/settings`, {
      headers: { "Content-Type": "application/json" },
      data: { board_order: [BOARD_Z, BOARD_A] },
    });
    expect(post.ok(), `POST /api/settings → ${post.status()}`).toBeTruthy();
    expect(await post.json()).toEqual({ status: "ok" });

    // GET now returns the stored order first (zzz…, aaa…), proving the API-layer
    // rank-aware sort applies.
    const after = (await (await request.get(`${base}/api/boards`)).json()) as Array<{
      name: string;
    }>;
    const afterNames = after.map((b) => b.name).filter((n) => n === BOARD_A || n === BOARD_Z);
    expect(afterNames).toEqual([BOARD_Z, BOARD_A]);
  });

});
