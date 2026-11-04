import { defineConfig, devices } from "@playwright/test";
import { harnessPort } from "./tests/e2e/_harness";
import { applyWorkerRig, rigCount } from "./tests/e2e/_rig";

// Multi-rig lane: inside a worker process this re-points the harness env
// vars at the worker's own rig. It MUST run before the first env read below
// (and before any spec module loads) — see _rig.ts for the ordering contract.
applyWorkerRig();

// The harness-port read lives in _harness.ts (harness-set E2E_PORT, else the
// policy's fail-closed sentinel; never the ambient RK_PORT) and MUST be
// called after applyWorkerRig() so the worker's rewrite is already applied.
const port = harnessPort();

// Worker pool size = the number of rigs the harness actually started
// (E2E_RIGS rows), never RK_E2E_WORKERS by itself: a worker with no rig of
// its own would share rig 0 and reintroduce the SSE cross-talk race. No rig
// table (bare `playwright test`, `just pw`) means one worker.
const workers = Math.max(1, rigCount());

export default defineConfig({
  testDir: "./tests/e2e",
  grepInvert: process.env.RK_E2E_PERF === "1" ? undefined : /@perf/,
  // Per-test timeout. Wider on CI: the SSE-driven UI updates that most specs
  // assert on are noticeably slower on a 4-vCPU shared runner where two rigs'
  // Go, Vite, Chromium and tmux all contend for the box. Specs gate on real readiness
  // signals (see _ready.ts); this is the outer budget those gates live within.
  timeout: process.env.CI ? 30_000 : 10_000,
  retries: 1,
  // Serial within a rig: every spec targets its rig's one tmux server (the
  // worktree's derived e2e primary, rk-test-e2e-<token>-0, in the single-rig
  // lane) and one dev server, and the SSE stream broadcasts session changes to
  // ALL connected clients. Two workers on ONE rig would therefore see each
  // other's sessions in their sidebars — a correctness race, not just load —
  // so the pool is only ever as wide as the number of rigs the harness
  // started (RK_E2E_WORKERS, one rig per worker; default one). Tests inside a
  // file stay serial either way (fullyParallel off): a file's beforeAll seeds
  // tmux state the file's tests share. CI adds sharding across runners on top,
  // see .github/workflows/ci.yml.
  fullyParallel: false,
  workers,
  globalTeardown: "./tests/e2e/global-teardown.ts",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "on-first-retry",
    // Emulate reduced motion so the window-switch slide transition
    // (260703-l4nf) is disabled via its own progressive-enhancement fallback.
    // Animations are a known Playwright flake source; the product honors
    // `prefers-reduced-motion: reduce` by short-circuiting to an instant
    // switch, so existing window-switch specs run against instant switches.
    // `reducedMotion` is not a top-level `use` fixture in this Playwright
    // version — it only reaches the browser context via `contextOptions`
    // (spread into the context options at creation), so set it there. The one
    // spec that exercises the animated path opts back in with
    // `test.use({ contextOptions: { reducedMotion: "no-preference" } })`.
    contextOptions: { reducedMotion: "reduce" },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `echo "webServer managed externally"`,
    port,
    reuseExistingServer: true,
    timeout: 20_000,
  },
});
