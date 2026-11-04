import { test, expect } from "@playwright/test";
import { apiBase } from "./_boards";
import { TMUX_SERVER } from "./_tmux";

/**
 * Behavioural contract for the server-reorder backend surface: the
 * `POST /api/servers/order` endpoint (writes each server's `@rk_srv_rank`),
 * and the nullable `rank` field on `GET /api/servers` (array stays alphabetical).
 *
 * Why this slice (not a drag simulation): server drag-reorder needs ≥2
 * regular (non-infra) servers, but the isolated e2e harness only provides
 * `rk-test-*` sockets (which `isInfraServer` treats as non-draggable infra)
 * and cannot create genuinely-regular servers without leaking sockets outside
 * the `rk-test-e2e*` teardown glob. Native HTML5 drag is also unreliable to
 * simulate in Playwright, and `page.reload()` does not commit under the SPA's
 * long-lived state socket. So this spec exercises the load-bearing surface —
 * the order endpoint end-to-end against the live backend, which is
 * deterministic. The comparator, context re-sort, drag
 * handlers, and palette Move actions are covered by Vitest unit tests.
 *
 * Shared setup: uses `E2E_TMUX_SERVER` (the worktree's derived
 * `rk-test-e2e-<token>-0` primary) as the live server; no extra sessions are
 * created — the endpoint operates on the server socket itself.
 * `apiBase(baseURL)` (`_boards.ts`) resolves the backend origin from the
 * harness-seeded `E2E_PORT`, falling back to the policy's fail-closed
 * sentinel (`_harness.ts`).
 * Persisted rank is harmless leftover state; no teardown reset is needed (the
 * option has no HTTP "unset" and ranks don't affect the alphabetical
 * `/api/servers` array).
 */
test.describe("Server reorder — order endpoint", () => {
  /**
   * Proves: posting `{order: [rk-test-e2e]}` returns `{ok: true}`, writes
   * rank 0 to that server, and `GET /api/servers` then reports `rank: 0` on
   * its entry while the array remains alphabetical.
   *
   * Steps:
   * 1. `POST /api/servers/order` with `{order: [TMUX_SERVER]}`; assert `ok` +
   *    `{ok: true}` body.
   * 2. `GET /api/servers`; assert the `name` array equals its own
   *    alphabetical sort (order contract preserved).
   * 3. Find the `TMUX_SERVER` entry; assert `rank === 0`.
   */
  test("POST /api/servers/order persists rank and returns ok", async ({ request, baseURL }) => {
    const base = apiBase(baseURL);

    // POST an order containing the live e2e server. The endpoint writes rank i
    // to the i-th server best-effort; a single-element order writes rank 0.
    const postResp = await request.post(`${base}/api/servers/order`, {
      headers: { "Content-Type": "application/json" },
      data: { order: [TMUX_SERVER] },
    });
    expect(postResp.ok(), `POST /api/servers/order → ${postResp.status()}`).toBeTruthy();
    expect(await postResp.json()).toEqual({ ok: true });

    // GET /api/servers now carries the persisted rank on that server's entry,
    // while the array stays alphabetical (asserted contract).
    const listResp = await request.get(`${base}/api/servers`);
    expect(listResp.ok()).toBeTruthy();
    const servers = (await listResp.json()) as Array<{ name: string; rank: number | null }>;
    const names = servers.map((s) => s.name);
    const sortedNames = [...names].sort();
    expect(names).toEqual(sortedNames); // alphabetical contract preserved

    const entry = servers.find((s) => s.name === TMUX_SERVER);
    expect(entry, `entry for ${TMUX_SERVER}`).toBeTruthy();
    expect(entry!.rank).toBe(0);
  });

});
