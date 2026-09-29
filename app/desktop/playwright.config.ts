import { defineConfig } from "@playwright/test";

// The desktop Electron lane: specs launch the shell themselves via
// _electron.launch (tests/e2e/_shell.ts) against the rig the harness
// (scripts/test-e2e.sh, RK_E2E_LANE=desktop) already started — so there is
// no webServer block and no baseURL here; specs build URLs from E2E_PORT
// (the frontend harness helper's fail-closed sentinel fallback applies to
// bare runs).
// workers is 1 because the lane is single-rig by construction: one tmux
// server, one seeded two-host hosts.json, one shell instance per test.
// The specs import the frontend's `_tmux`/`_harness` fixtures only (node
// builtins) — never `_ready.ts`, which imports `@playwright/test`: Playwright
// refuses two physical copies of itself in one process, so a second copy (the
// frontend's own install) must never load here.
export default defineConfig({
  testDir: "./tests/e2e",
  // Per-test timeout covers an Electron launch plus a rig navigation.
  timeout: process.env.CI ? 60_000 : 30_000,
  retries: 1,
  fullyParallel: false,
  workers: 1,
  globalTeardown: "../frontend/tests/e2e/global-teardown.ts",
  use: { trace: "on-first-retry" },
});
