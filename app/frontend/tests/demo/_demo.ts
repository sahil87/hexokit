/**
 * Shared fixture + helpers for demo specs (tests/demo/*.demo.ts).
 *
 * A demo is a recording, not an assertion: the extended `test` below saves the
 * page's video to a stable, human-addressable path after every test —
 * `${DEMO_OUT_DIR}/${DEMO_NAME}[-${DEMO_VARIANT}]-<project>.webm`. The env
 * vars are exported by scripts/demo.sh; Playwright's own output directories
 * are title-hash-named, so scraping them would be fragile — the fixture owns
 * the naming contract instead. One test per demo file: the path carries no
 * test title.
 *
 * `video.saveAs` is only valid after the page's context has closed, so the
 * fixture closes the context itself in teardown; Playwright's own context
 * teardown then runs against an already-closed context (a no-op). The save
 * happens pass or fail — a broken demo still leaves its partial recording.
 *
 * When DEMO_OUT_DIR / DEMO_NAME are unset (an ad-hoc run under the demo config
 * without scripts/demo.sh) the save is skipped — there is no contract to
 * fulfill and the run behaves like a plain Playwright run.
 */
import { test as base, expect, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    await use(page);
    const outDir = process.env.DEMO_OUT_DIR;
    const name = process.env.DEMO_NAME;
    if (!outDir || !name) return;
    const video = page.video();
    await page.context().close();
    if (!video) {
      throw new Error("demo fixture: no video on the page — the demo config must set video: on");
    }
    const variant = process.env.DEMO_VARIANT;
    const file = `${name}${variant ? `-${variant}` : ""}-${testInfo.project.name}.webm`;
    mkdirSync(outDir, { recursive: true });
    await video.saveAs(join(outDir, file));
  },
});

/** Deliberate on-screen dwell — a pause long enough for a reviewer to register
 *  what is on screen before the next action. slowMo paces actions; beat paces
 *  the narrative. */
export async function beat(page: Page, ms = 1_000): Promise<void> {
  await page.waitForTimeout(ms);
}

/** Mark a demo desktop-only: skips in the mobile project, so the default
 *  two-project run does the right thing for surfaces that do not render on
 *  mobile. */
export function desktopOnly(info: TestInfo): void {
  test.skip(info.project.name === "mobile", "demo drives chrome that does not render on mobile");
}

export { expect };
