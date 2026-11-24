/**
 * Desktop titlebar strip e2e: the host squares and the nameplate never move.
 * The key-hint pill's space is always reserved and digits render inside the
 * fixed 18px squares, so revealing the hints (band hover, the held chord, the
 * pill's own hover) and hovering a square change no geometry.
 *
 * Shared setup: `beforeEach` launches a FRESH shell per test over a fresh
 * `mkdtemp` XDG_CONFIG_HOME seeded with the two-host hosts.json (e2e-a
 * `127.0.0.1`, e2e-b `localhost`, both on the rig's port — cold start opens
 * exactly one window on e2e-a), so the developer's real config and any
 * running shell are untouched; `afterEach` closes the app and removes the
 * temp dir even on mid-test failure. The host page is the real SPA served by
 * the rig inside the shell, so the strip under test is the shipped one; the
 * two squares are the two seeded hosts. Layout is measured with
 * `getBoundingClientRect` on the live elements (jsdom has no layout, so this
 * lane is where the no-shift requirement is provable). The chord is Alt: the
 * rig runs on Linux, where the switch chord is Alt+digit and the pill reads
 * `Alt`. No state outside the shell's temp config home is written.
 */
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostOrigins, launchShell, pageByOrigin, seedHosts } from "./_shell";

/** Readiness gate budget (the frontend convention): wider on CI to absorb
 *  shared-runner latency. `_ready.ts` is NOT imported (two physical copies of
 *  Playwright in one process are refused), so the value is mirrored here. */
const READY_TIMEOUT = process.env.CI ? 20_000 : 10_000;

/** Sub-pixel layout rounding only — a real shift is at least a whole pixel. */
const EPSILON_PX = 0.01;

let app: ElectronApplication;
let configHome: string;
let page: Page;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Bounding boxes of every host square (list order) and of the nameplate. */
async function strip(): Promise<{ squares: Box[]; nameplate: Box }> {
  return page.evaluate(() => {
    const box = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const squares = [...document.querySelectorAll('[data-testid="shell-host-square"]')].map(box);
    const nameplate = document.querySelector('[data-testid="shell-nameplate"]');
    if (!nameplate) throw new Error("no nameplate");
    return { squares, nameplate: box(nameplate) };
  });
}

function expectSameLayout(actual: { squares: Box[]; nameplate: Box }, expected: { squares: Box[]; nameplate: Box }) {
  expect(actual.squares).toHaveLength(expected.squares.length);
  const flat = (s: { squares: Box[]; nameplate: Box }) =>
    [...s.squares, s.nameplate].flatMap((b) => [b.x, b.y, b.width, b.height]);
  const a = flat(actual);
  const e = flat(expected);
  a.forEach((v, i) => expect(Math.abs(v - e[i])).toBeLessThanOrEqual(EPSILON_PX));
}

async function digitsVisible(): Promise<boolean> {
  return page.evaluate(() => {
    const digits = [...document.querySelectorAll(".rk-strip-digit")];
    return digits.length > 0 && digits.every((d) => getComputedStyle(d).visibility === "visible");
  });
}

test.beforeEach(async () => {
  configHome = mkdtempSync(join(tmpdir(), "rk-desktop-strip-"));
  seedHosts(configHome);
  app = await launchShell(configHome);
  page = await pageByOrigin(app, hostOrigins().a, READY_TIMEOUT);
  await page.waitForLoadState("load");
  await expect(page.getByTestId("shell-host-square")).toHaveCount(2, { timeout: READY_TIMEOUT });
});

test.afterEach(async () => {
  await app.close();
  rmSync(configHome, { recursive: true, force: true });
});

/**
 * Proves: showing the key hints — hovering a square, holding the switch chord,
 * hovering the pill — leaves every square and the nameplate exactly where they
 * were at rest, while the digits appear inside the squares and the pill becomes
 * visible in its already-reserved space.
 *
 * Steps:
 * 1. Wait for the two seeded host squares; record the squares' and nameplate's
 *    bounding boxes at rest and assert the digits are hidden.
 * 2. Hover the first square; assert the boxes are unchanged.
 * 3. Park the pointer away, hold Alt; assert digits are visible and the boxes
 *    are unchanged; release Alt and assert the digits hide again.
 * 4. Hover a square (revealing the pill), then the pill itself; assert the digits are
 *    visible and the boxes are unchanged.
 * 5. Move the pointer off the strip; assert the boxes still equal the rest layout.
 */
test("square and nameplate positions are identical at rest, on hover, with the chord held, and on pill hover", async () => {
  const rest = await strip();
  expect(await digitsVisible()).toBe(false);

  await page.getByTestId("shell-host-square").first().hover();
  expectSameLayout(await strip(), rest);

  await page.mouse.move(400, 400);
  await page.keyboard.down("Alt");
  await expect.poll(digitsVisible).toBe(true);
  expectSameLayout(await strip(), rest);
  await page.keyboard.up("Alt");
  await expect.poll(digitsVisible).toBe(false);

  // The pill is hidden at rest and revealed by hovering the band, so reach it
  // the way a user does: over a square first, then onto the pill.
  await page.getByTestId("shell-host-square").first().hover();
  await page.getByTestId("shell-key-hint-pill").hover();
  await expect.poll(digitsVisible).toBe(true);
  expectSameLayout(await strip(), rest);

  await page.mouse.move(400, 400);
  expectSameLayout(await strip(), rest);
});

/**
 * Proves: the squares are fixed 18×18 — a ring marks the active host, never a
 * larger size — and the pill's space is reserved (it is hidden, not absent,
 * at rest).
 *
 * Steps:
 * 1. Read each square's size and aria-current; assert every square is 18×18
 *    and exactly one is current.
 * 2. Assert the pill is in the layout (non-zero size) while `visibility` is hidden.
 */
test("squares are fixed 18px, the active one is a ring, and the pill space is reserved", async () => {
  const squares = page.getByTestId("shell-host-square");
  const sizes = await squares.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, current: el.getAttribute("aria-current") === "true" };
    }),
  );
  expect(sizes.every((s) => Math.abs(s.w - 18) <= EPSILON_PX && Math.abs(s.h - 18) <= EPSILON_PX)).toBe(true);
  expect(sizes.filter((s) => s.current)).toHaveLength(1);

  const pill = await page.getByTestId("shell-key-hint-pill").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { w: r.width, visibility: getComputedStyle(el).visibility };
  });
  expect(pill.w).toBeGreaterThan(0);
  expect(pill.visibility).toBe("hidden");
});
