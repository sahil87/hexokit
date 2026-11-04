import { defineConfig, devices } from "@playwright/test";
import { harnessPort } from "./tests/e2e/_harness";

// The demo lane is single-rig by construction (scripts/test-e2e.sh forces one
// worker for RK_E2E_LANE=demo), so there is no per-worker rig remap here —
// the port read is the same harness-contract read the e2e config makes.
const port = harnessPort();

// Demos are recordings a reviewer watches, not assertions a runner flakes on:
// motion stays ON (the e2e config emulates reduced motion), slowMo paces every
// action, and there are no retries — a failing demo is reported, not rerun.
// One worker: a demo drives one rig's one tmux server serially.
export default defineConfig({
  testDir: "./tests/demo",
  testMatch: "*.demo.ts",
  timeout: 120_000,
  retries: 0,
  fullyParallel: false,
  workers: 1,
  globalTeardown: "./tests/e2e/global-teardown.ts",
  outputDir: "test-results-demo",
  use: {
    baseURL: `http://localhost:${port}`,
    // `reducedMotion` is not a top-level `use` fixture in this Playwright
    // version — it only reaches the browser context via `contextOptions`.
    contextOptions: { reducedMotion: "no-preference" },
    launchOptions: { slowMo: 250 },
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        // Video at exactly the viewport size, so the recording is what the
        // reviewer would see; tests/demo/_demo.ts saves it to .demo/.
        video: { mode: "on", size: { width: 1280, height: 800 } },
      },
    },
    {
      name: "mobile",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 375, height: 812 },
        isMobile: true,
        hasTouch: true,
        video: { mode: "on", size: { width: 375, height: 812 } },
      },
    },
  ],
  webServer: {
    command: `echo "webServer managed externally"`,
    port,
    reuseExistingServer: true,
    timeout: 20_000,
  },
});
