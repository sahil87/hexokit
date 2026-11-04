import { defineConfig } from "@playwright/test";

// The desktop shell recording lane (RK_E2E_LANE=shell-demo, scripts/demo.sh):
// demos under tests/demo/*.demo.ts launch the shell via _electron.launch
// (tests/demo/_demo.ts) against the rig the harness (scripts/test-e2e.sh)
// already started — no webServer block, no baseURL; specs build URLs from
// E2E_PORT (the frontend harness helper's fail-closed sentinel fallback
// applies to bare runs). Recording is fixture-owned: the fixture grabs the
// Xvfb display with ffmpeg x11grab and saves it to .demo/ itself — the
// composited native guests and popout windows are display-level content a
// per-page Playwright video never contains.
// One worker, no retries: a demo is a serial, human-paced recording, and a
// failing demo is reported, not rerun. Same constraint as the e2e lane: the
// frontend's own @playwright/test copy must never load in this process.
export default defineConfig({
  testDir: "./tests/demo",
  testMatch: "*.demo.ts",
  // Per-test timeout covers an Electron launch plus rig navigation and beats.
  timeout: 120_000,
  retries: 0,
  fullyParallel: false,
  workers: 1,
  outputDir: "test-results-demo",
  globalTeardown: "../frontend/tests/e2e/global-teardown.ts",
  projects: [{ name: "shell" }],
});
