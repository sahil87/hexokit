/**
 * Shared fixture + helpers for shell demo specs (tests/demo/*.demo.ts).
 *
 * A shell demo is a recording, not an assertion. The web lane records
 * per-page Playwright video; the shell lane cannot — the host SPA and each
 * native web-tile guest are separate WebContentsViews in one window, and
 * popouts are separate windows, so per-page video never contains the
 * composited result a reviewer needs to see. The extended `test` below
 * therefore records the private Xvfb DISPLAY the shell renders into with
 * ffmpeg x11grab (argument-array spawn — never a shell string), started after
 * the host page's SPA is up (so the video never opens on a black pre-launch
 * screen) and stopped gracefully in teardown, pass or fail: `q` on stdin
 * finalizes the WebM container, SIGINT is the fallback, SIGKILL only the last
 * resort (it would leave a truncated file). The output path is
 * `${DEMO_OUT_DIR}/${DEMO_NAME}[-${DEMO_VARIANT}]-shell.webm`; the env vars
 * are exported by scripts/demo.sh and the fixture owns the naming contract.
 * When DEMO_OUT_DIR / DEMO_NAME are unset (an ad-hoc run) the recorder does
 * not run — there is no contract to fulfill.
 *
 * `_electron.launch` has no `slowMo` option (verified against the installed
 * playwright-core types), so the web lane's action pacing is supplied here by
 * `pace()` — a named-constant dwell after each user-visible action — while
 * `beat()` paces the narrative, same semantics as the web fixture's.
 *
 * Imports from the frontend are limited to `_tmux`/`_harness` (node builtins
 * only). The frontend's `_ready.ts`/`_demo.ts` must never load here — they
 * import the frontend's own @playwright/test copy, and Playwright refuses two
 * physical copies of itself in one process — so `READY_TIMEOUT` and
 * `openPalette` are mirrored locally (the e2e lane's spec does the same).
 */
import { test as base, expect, type ElectronApplication, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hostOrigins, launchShell, pageByOrigin, seedHosts } from "../e2e/_shell";

/** Readiness gate budget (the frontend convention): wider on CI to absorb
 *  shared-runner latency. */
export const READY_TIMEOUT = process.env.CI ? 20_000 : 10_000;

/** Palette-open attempts and per-attempt wait (the `_ready.ts` shape). */
const PALETTE_ATTEMPTS = 3;
const PALETTE_ATTEMPT_TIMEOUT = 3_000;

/** The Xvfb screen geometry scripts/demo.sh starts the lane with
 *  (`xvfb-run -a -s "-screen 0 1280x800x24"`); the grab must match the screen
 *  or ffmpeg captures the wrong rectangle. */
const XVFB_SCREEN = "1280x800";
const FFMPEG_FRAMERATE = "25";
/** Graceful-stop budget: `q` on stdin normally finalizes within a second;
 *  SIGINT follows at half this window, SIGKILL only at its end. */
const FFMPEG_STOP_WAIT_MS = 10_000;
/** slowMo-equivalent dwell between user-visible actions, matching the web
 *  lane's `launchOptions: { slowMo: 250 }` rhythm. */
export const PACE_MS = 250;

/** Open the command palette with the SHIFTED chord form, which reaches the
 *  palette from every focus context on this rig, retrying with a blur between
 *  attempts; the last attempt asserts. Returns the palette's input. */
export async function openPalette(
  page: Page,
): Promise<ReturnType<Page["getByPlaceholder"]>> {
  const input = page.getByPlaceholder("Type a command");
  for (let attempt = 0; attempt < PALETTE_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    }
    await page.keyboard.press("Shift+Control+k");
    if (attempt === PALETTE_ATTEMPTS - 1) {
      await expect(
        input,
        `command palette did not open after ${PALETTE_ATTEMPTS} chord presses`,
      ).toBeVisible({ timeout: PALETTE_ATTEMPT_TIMEOUT });
      return input;
    }
    const opened = await input
      .waitFor({ state: "visible", timeout: PALETTE_ATTEMPT_TIMEOUT })
      .then(() => true)
      .catch(() => false);
    if (opened) return input;
  }
  return input;
}

/** Deliberate on-screen dwell — a pause long enough for a reviewer to register
 *  what is on screen before the next action. pace() paces actions; beat paces
 *  the narrative. */
export async function beat(page: Page, ms = 1_000): Promise<void> {
  await page.waitForTimeout(ms);
}

/** The slowMo stand-in: call after each user-visible action so the recording
 *  keeps the web lane's rhythm (Electron launch has no slowMo). */
export async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(PACE_MS);
}

/** One ffmpeg x11grab process recording the whole X display. Stopping is
 *  graceful by construction: `q` on stdin lets ffmpeg finalize the WebM
 *  container (SIGKILL would truncate it), with SIGINT then SIGKILL as bounded
 *  fallbacks. `-draw_mouse 0` because Playwright drives input through CDP —
 *  the X cursor never moves and would sit as a stray pointer. */
class DisplayRecorder {
  private ff: ChildProcess;
  private spawnError: Error | null = null;

  constructor(file: string) {
    const display = process.env.DISPLAY;
    if (!display) {
      throw new Error("shell demo recorder: DISPLAY is unset — the lane must run under xvfb-run");
    }
    mkdirSync(dirname(file), { recursive: true });
    this.ff = spawn(
      "ffmpeg",
      [
        "-y",
        "-f",
        "x11grab",
        "-draw_mouse",
        "0",
        "-framerate",
        FFMPEG_FRAMERATE,
        "-video_size",
        XVFB_SCREEN,
        "-i",
        display,
        "-c:v",
        "libvpx-vp9",
        "-b:v",
        "0",
        "-crf",
        "34",
        "-deadline",
        "realtime",
        "-pix_fmt",
        "yuv420p",
        file,
      ],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    this.ff.once("error", (err) => {
      this.spawnError = err;
    });
  }

  /** Stop recording and wait (bounded) for the WebM to be finalized. */
  async stop(): Promise<void> {
    if (this.spawnError) throw this.spawnError;
    if (this.ff.exitCode !== null || this.ff.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const interrupt = setTimeout(() => this.ff.kill("SIGINT"), FFMPEG_STOP_WAIT_MS / 2);
      const kill = setTimeout(() => this.ff.kill("SIGKILL"), FFMPEG_STOP_WAIT_MS);
      interrupt.unref();
      kill.unref();
      this.ff.once("close", () => {
        clearTimeout(interrupt);
        clearTimeout(kill);
        resolve();
      });
      this.ff.stdin?.write("q\n");
      this.ff.stdin?.end();
    });
  }
}

/** The shell output path scripts/demo.sh's post-run walk expects. */
function recordingPath(): string | null {
  const outDir = process.env.DEMO_OUT_DIR;
  const name = process.env.DEMO_NAME;
  if (!outDir || !name) return null;
  const variant = process.env.DEMO_VARIANT;
  return join(outDir, `${name}${variant ? `-${variant}` : ""}-shell.webm`);
}

export const test = base.extend<{
  configHome: string;
  app: ElectronApplication;
  hostPage: Page;
}>({
  // eslint-disable-next-line no-empty-pattern
  configHome: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), "rk-desktop-demo-"));
    seedHosts(dir);
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },
  app: async ({ configHome }, use) => {
    // DEMO_SHELL_APP_DIR (the --before pass) launches the base tree's compiled
    // shell with its own Electron binary; unset, the launch is this tree's,
    // unchanged.
    const appDir = process.env.DEMO_SHELL_APP_DIR;
    const app = await launchShell(configHome, appDir ? { appDir } : {});
    await use(app);
    await app.close();
  },
  hostPage: async ({ app }, use) => {
    const page = await pageByOrigin(app, hostOrigins().a, READY_TIMEOUT);
    await page.waitForLoadState("load");
    const file = recordingPath();
    const recorder = file ? new DisplayRecorder(file) : null;
    await beat(page);
    await use(page);
    // Teardown order matters: the recorder stops first (a failing demo still
    // leaves a finalized partial recording), then the app fixture closes the
    // shell and the config home is removed.
    await recorder?.stop();
  },
});

export { expect };
