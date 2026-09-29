import { test, expect, type Page } from "@playwright/test";
import { gotoWindow as gotoWindowRaw, openPalette, resolveWindow as resolveWindowRaw } from "./_ready";
import { TMUX_SERVER, createSession, killSession, newWindow, stampWebTab, windowOption } from "./_tmux";
import { reserveDeadPort, type DeadPort } from "./_ports";
import { stubProxyPorts } from "./_web-tile";

// Regression proof for the top-bar overflow chevron menu and for the fix
// that the measured right cell must FILL its `1fr` grid track (not be
// content-sized). On the old content-sized cell the fit budget went negative
// and `visibleCount` deadlocked at 0 — NOTHING rendered in-bar at any width;
// the wide-width in-bar assertions here fail on that code and pass on the
// fixed code.
//
// Covers the width sweep (1280 → 1024 → 800 → 700 → 640 → 500 → 375): (a) no
// top-bar bounding-box overlap; (b) L1 drops before L2 before L3; (c) the
// chevron menu contains the dropped + menuOnly rows + the version row,
// grouped under Tiles / View / Tab / App section labels (Tiles is desktop
// widths only — at mobile the surface-toggles entry forks to the pinned
// switch group with no menu rows); (d) the version row copies to the
// clipboard; (e) the exempt chevron is always visible (no connection dot in
// the bar — it lives in the desktop status bar / mobile drawer footer);
// (f) menu actions work from the menu; (g) the demoted controls
// (fixed-width, Aa, close-pane, the merged split control in terminal mode,
// plus the Help / Keyboard chrome rows — all `menuOnly`) render in-bar
// NOWHERE at any width while their rows are ALWAYS in the menu; (h) the
// Settings gear is a real fit candidate — the LAST one (Refresh drops before
// it) — rendering in-bar between Refresh and the chevron at desktop widths.
// The terminal fit tiers: L1 = the ▦ Layout chip (the surface-toggle group
// sits leftmost but is `dropLast` — the last fit candidate to overflow ON
// DESKTOP, asserted as its own LAST set below)
// (overflowed, it renders one `Layout: …` radio row per arity-valid shape);
// L2 = empty; L3 = Refresh + Settings gear — the in-bar end state is
// [toggles] · ▦Layout · Refresh · Gear · chevron, with the chevron the SOLE
// element of the trailing exempt block.
//
// Shared setup: `beforeEach` route-stubs the derived dead port's
// `/proxy/<port>/**` with a static 200 page (stubProxyPorts from
// _web-tile.ts, port from reserveDeadPort — the dead-port error state hides
// the iframe when nothing listens on the stamped URL, and these tests assert
// tile chrome, never frame content). Real isolated tmux server: `beforeAll`
// creates a dedicated session with an extra named window (`overflow-win-<ts>`)
// so the terminal route renders the right cluster; the second describe adds a
// SECOND, web-capable long-named window (`overflow-view-long-worktree-<ts>`
// with a stamped web tab ⇒ `[tty|web]`; the repo-cwd pane also
// derives a `gitRoot` ⇒ `code`, so its toggle group shows Terminal/Web/Code)
// so the palette's `View: Web` action actually renders (the palette gates on
// a multi-view window). `resolveWindow`/`gotoWindow` (from `_ready.ts`)
// resolve the window id and navigate to `/${server}/${id}`. In-bar control
// visibility is measured via accessible-name ROLE queries scoped to the
// banner landmark, which exclude the always-present off-screen `inert` +
// `aria-hidden` measurement-probe copy — a match means the control is in-bar
// (the surface-toggle group is detected via its `Terminal tile` button —
// `getByTestId("surface-toggles")` is AMBIGUOUS, the probe carries a second
// copy when the group is in-bar; banner-scoping avoids the tty tile header's
// own `Close pane` button). The ViewSwitcher is RETIRED, so its absence is
// checked two ways: no accessible `role="group"` named `Window view` AND no
// `view-toggle` testid anywhere in the DOM (the probe carries no pill copy
// either — fit candidates only). `intersects()` is the standard rect-overlap
// helper (shared shape with top-bar-overlap.spec.ts).

const TEST_SESSION = `e2e-overflow-${Date.now().toString().slice(-6)}`;
const WINDOW_NAME = `overflow-win-${Date.now().toString().slice(-6)}`;

// The width sweep from the intake (§8): fits-everything → mobile leaf.
const WIDTHS = [1280, 1024, 800, 700, 640, 500, 375];

const resolveWindow = async (page: Page, windowName: string) =>
  (await resolveWindowRaw(page, TMUX_SERVER, TEST_SESSION, windowName)).windowId;
const gotoWindow = (page: Page, windowId: string) =>
  gotoWindowRaw(page, TMUX_SERVER, windowId);

/** True when two DOM rects overlap (share any area). */
function intersects(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

// Right-cluster controls in pyramid order (L1 → L2 → L3), by accessible name.
// Terminal route: the surface-toggle group (`data-testid="surface-toggles"` —
// ONE bordered sub-group of per-surface tile toggles, leftmost in the bar;
// detected via its "Terminal tile" button — tty is always an available
// surface) is the cluster's `dropLast` entry ON DESKTOP: leftmost in the bar
// yet at the TAIL of the fit order, so it overflows only after every pyramid
// tier is gone (the LAST set below). The pyramid's L1 is the ▦ Layout chip
// (overflowed, it renders `Layout: …` radio rows in the menu) — the merged
// split control left the
// terminal bar in 260813-w1lf (pane verbs moved to the tty tile header's pane
// segment; the `split` entry is `menuOnly` in terminal mode now, its rows
// ALWAYS in the chevron menu — see MENU_ONLY below). On MOBILE (<640px) the
// same entry forks to SWITCH mode (radio semantics) and is PINNED in-bar —
// exempt from the fit pipeline, never overflowed, no Tiles menu rows — so the
// pyramid/fit assertions below count only the FIT candidates there (the
// pinned "Terminal tile" button is excluded from L1 at mobile widths and
// asserted present separately). L2 is empty (fixed-width, Aa, and ✕ are
// `menuOnly`), L3 is Refresh + the Settings gear (relocated from the sidebar
// footer, 260812-d1at; the LAST fit candidate, so Refresh drops before it).
// The update chip is context-gated and omitted from the ordering assertion.
// Help/Keyboard/Theme are menuOnly App-section rows (never in-bar); the bell
// and dot stay out of the bar (settings dialog / desktop status bar). The
// rail-toggle chip (aria-label "Toggle panel", 260812-nm4p) is REMOVED with
// the rail — the trailing exempt block is the chevron ALONE.
// The IN-BAR detection uses accessible-name ROLE queries (getByRole/getByLabel):
// the always-present measurement probe is `aria-hidden`, so its duplicate
// controls are OUTSIDE the accessibility tree and never matched — this is what
// distinguishes "in-bar" from "overflowed/probe" (a `:visible` CSS filter does
// NOT work: the probe sits off-screen at -9999px but Playwright still considers
// a sized off-screen element "visible"; `getByTestId("surface-toggles")` is
// likewise AMBIGUOUS — two copies when the group is in-bar).
type NameMatcher = string | RegExp;
const L1: NameMatcher[] = ["Layout"];
const L2: NameMatcher[] = [];
const L3: NameMatcher[] = ["Refresh page", "Open settings"];
// The surface-toggle group is the cluster's `dropLast` entry ON DESKTOP: it
// keeps its leftmost slot but sits at the TAIL of the fit order, so it is the
// last fit candidate to overflow — it must still be in-bar while ANY pyramid
// tier member is. Below the mobile breakpoint the same group forks to PINNED
// switch mode — in-bar by exemption, not by fit — so it is asserted visible
// there and never counted as a fit candidate.
const LAST: NameMatcher[] = ["Terminal tile"];
const L1_MOBILE: NameMatcher[] = [...L1];
// The demoted controls (260731-oiho + the terminal split in 260813-w1lf, the
// n2n4 menuOnly mechanism): their bar forms render NOWHERE at ANY width; their
// rows are ALWAYS in the menu.
const MENU_ONLY: NameMatcher[] = [
  "Split horizontally",
  "Toggle fixed terminal width",
  "Terminal font size",
  "Close pane",
];

/** Locate a control by accessible name across button OR link roles. `getByRole`
 *  excludes the aria-hidden measurement probe subtree, so a match means the
 *  control is rendered IN-BAR (Help is a link; the rest are buttons). String
 *  names match EXACTLY — a substring "Layout" would also hit sidebar window
 *  rows whose names carry the worktree slug ("…surface-layout-core"). Scoped
 *  to the top bar (the banner landmark): the tty tile header's pane segment
 *  (260813-w1lf) carries a `Close pane` button a page-wide query would
 *  false-positive on. */
function byRoleName(page: Page, name: NameMatcher) {
  const opts = typeof name === "string" ? { name, exact: true } : { name };
  const bar = page.getByRole("banner");
  return bar.getByRole("button", opts).or(bar.getByRole("link", opts));
}

/** How many of the given controls are currently rendered IN-BAR (found in the
 *  accessibility tree; the aria-hidden probe copies are excluded). */
async function inBarCount(page: Page, names: NameMatcher[]): Promise<number> {
  let n = 0;
  for (const name of names) {
    if ((await byRoleName(page, name).count()) > 0) n += 1;
  }
  return n;
}

/** Read the (L1, L2, L3) in-bar counts, SETTLED. The three tier reads are not
 *  atomic — the ResizeObserver-driven overflow recompute can re-render between
 *  them, producing an inconsistent split (seen flaky: L3 already overflowed
 *  while L2 still read as in-bar mid-cascade after a resize). Re-read until two
 *  consecutive snapshots agree (bounded), so invariants are asserted on a
 *  stable layout, not a transient frame. `desktop=false` counts only the FIT
 *  candidates (the pinned mobile switch group is excluded from L1). */
async function settledTierCounts(page: Page, desktop = true): Promise<[number, number, number]> {
  const l1 = desktop ? L1 : L1_MOBILE;
  const read = async (): Promise<[number, number, number]> => [
    await inBarCount(page, l1),
    await inBarCount(page, L2),
    await inBarCount(page, L3),
  ];
  let prev = await read();
  for (let i = 0; i < 20; i++) {
    const next = await read();
    if (next[0] === prev[0] && next[1] === prev[1] && next[2] === prev[2]) return next;
    prev = next;
  }
  return prev;
}

// The dead-port error state (260819-v6y4 R8) hides the iframe when nothing
// listens on the stamped port — these tests assert tile chrome, never frame
// content, so the proxy path is route-stubbed live (see _web-tile.ts). The
// port is a reserved-then-released ephemeral (dead by construction).
let DEAD: DeadPort;

test.beforeAll(async () => {
  DEAD = await reserveDeadPort();
});

test.beforeEach(async ({ page }) => {
  await stubProxyPorts(page, DEAD.port);
});

test.beforeAll(() => {
  createSession(TEST_SESSION);
  try {
    newWindow(TEST_SESSION, WINDOW_NAME);
  } catch {
    // Best effort — matches the prior copied pattern.
  }
});

test.afterAll(() => {
  killSession(TEST_SESSION);
});

test.describe("Top-bar overflow chevron menu (260715-h1ck)", () => {
  /**
   * Proves: the exempt chevron renders at every width while the bar carries
   * NO `role="status"` connection dot (the dot lives in the desktop status
   * bar / mobile drawer footer), the right cluster never overlaps the
   * center heading or the breadcrumb nav with no horizontal page overflow,
   * and the demoted menuOnly controls render in-bar NOWHERE at any width.
   *
   * Steps:
   * 1. Navigate to the long-named terminal window.
   * 2. For each width in the sweep: assert the `More controls` chevron is
   *    visible AND genuinely hit-testable (`elementFromPoint` at its center
   *    resolves inside it — a narrow `1fr` track could otherwise clip it);
   *    assert the right cell contains zero `role="status"` elements; assert
   *    the in-bar count of the `MENU_ONLY` controls (split / fixed-width /
   *    Aa / close-pane) is 0; assert the right cell's box does not
   *    intersect the heading box nor the nav box; assert
   *    `document.body.scrollWidth ≤ width`.
   */
  test("the chevron is always visible (no bar dot) and the top bar never overlaps across the width sweep", async ({
    page,
  }) => {
    const id = await resolveWindow(page, WINDOW_NAME);
    await gotoWindow(page, id);

    const cluster = page.getByTestId("top-bar-right");
    const chevron = page.getByRole("button", { name: "More controls" });
    const nav = page.getByRole("navigation", { name: "Breadcrumb" });
    const heading = page.getByRole("button", { name: `Rename tab ${WINDOW_NAME}` });

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await expect(heading).toBeVisible({ timeout: 10_000 });

      // (e) The exempt chevron is always visible at every width; the
      // connection dot is GONE from the bar (260724-6j1v — it lives in the
      // desktop status bar / mobile drawer footer now).
      await expect(chevron, `chevron visible at ${width}px`).toBeVisible();
      await expect(cluster.locator('[role="status"]'), `no bar dot at ${width}px`).toHaveCount(0);

      // (g) The demoted menuOnly controls (260731-oiho + the terminal split,
      // 260813-w1lf) render in-bar NOWHERE — not even at the widest width where
      // the cluster has room.
      expect(
        await inBarCount(page, MENU_ONLY),
        `no in-bar split/fixed-width/Aa/✕ at ${width}px`,
      ).toBe(0);

      // (a) No overlap: the right cell must not intersect the center heading nor
      // the breadcrumb nav (the overflow is what keeps the cluster within its
      // squeezable track — the M1 deadlock would have collapsed it, but a
      // content-sized cell could also paint over the center).
      const clusterBox = (await cluster.boundingBox())!;
      const headingBox = (await heading.boundingBox())!;
      expect(clusterBox, `cluster has a box at ${width}px`).toBeTruthy();
      expect(
        intersects(clusterBox, headingBox),
        `right cluster overlaps heading at ${width}px`,
      ).toBe(false);
      const navBox = await nav.boundingBox();
      if (navBox) {
        expect(
          intersects(clusterBox, navBox),
          `right cluster overlaps nav at ${width}px`,
        ).toBe(false);
      }
      // No horizontal page overflow.
      const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
      expect(bodyWidth, `page overflow at ${width}px`).toBeLessThanOrEqual(width);

      // (e) The exempt chevron must be genuinely HIT-TESTABLE (not merely
      // painted) at every width — at tight widths with a long center heading
      // the narrow `1fr` track could otherwise clip it. `elementFromPoint` at
      // the chevron center must resolve inside the chevron.
      const chevronHittable = await chevron.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return hit != null && el.contains(hit);
      });
      expect(chevronHittable, `chevron hit-testable at ${width}px`).toBe(true);
    }
  });

  /**
   * Proves: the M1 fix (in-bar controls exist at wide widths) AND the
   * pyramid drop order — overflow consumes from the front, so L1 (the ▦
   * Layout chip) empties before L3 (Refresh · Settings gear) starts dropping
   * (L2 is empty), while the surface-toggle group — the `dropLast` entry,
   * leftmost in the bar yet last in the fit order — stays in-bar as one unit
   * until every pyramid tier is gone; each tier's in-bar count is monotonic
   * non-increasing as width shrinks WITHIN each viewport regime — below
   * 640px the surface-toggle group forks to SWITCH mode and becomes PINNED
   * in-bar (exempt from the fit), freeing width, so the monotonic baseline
   * resets once at the desktop→mobile crossing and the mobile tier counts
   * exclude the pinned group's `Terminal tile` button (asserted separately
   * to be in-bar at every mobile width on this code-capable window); at
   * 375px the pyramid's front is gone while the L3 tail survives — the
   * ORDER (not an all-gone cliff) is the contract.
   *
   * Steps:
   * 1. At 1280px assert at least some L3 controls render in-bar (the direct
   *    M1 regression assertion — pre-fix this is 0).
   * 2. Sweep the widths; at each, count in-bar members of L1 / L2 / L3
   *    (accessible-name role queries with EXACT string matching — a
   *    substring "Layout" would false-positive on sidebar window rows
   *    carrying the worktree slug; the probe is excluded), re-reading until
   *    two consecutive (L1, L2, L3) snapshots agree — the tier reads are
   *    not atomic and the ResizeObserver-driven re-fit can re-render
   *    between them, so invariants are asserted on a settled layout. Assert
   *    L1 and L2 counts are non-increasing (re-baselining once when the
   *    sweep crosses the 640px mobile boundary and once when the sidebar
   *    head yields and the bar regains its width; the mobile L1 count
   *    excludes the pinned `Terminal tile` button); assert L2 is full while
   *    any L1 is in-bar and L3 is full while any L2 is in-bar; on desktop
   *    assert the `dropLast` surface-toggle group is in-bar while any
   *    pyramid member is, and non-increasing. At mobile widths, assert the
   *    pinned `Terminal tile` button IS in-bar.
   * 3. At 375px assert the L1 FIT-candidate count is 0 (the layout chip
   *    overflowed; the pinned switch group is exempt from the count;
   *    Refresh survives — the ORDER, not an all-gone cliff, is the
   *    contract).
   */
  test("controls overflow in pyramid order (L1 before L2 before L3) as width shrinks", async ({
    page,
  }) => {
    const id = await resolveWindow(page, WINDOW_NAME);
    await gotoWindow(page, id);
    const heading = page.getByRole("button", { name: `Rename tab ${WINDOW_NAME}` });

    // At the WIDEST width some in-bar controls must be present — this is the
    // direct M1 regression assertion (pre-fix: 0 in-bar at every width).
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(heading).toBeVisible({ timeout: 10_000 });
    const wideL3 = await inBarCount(page, L3);
    expect(wideL3, "at 1280px at least some L3 controls render in-bar (M1)").toBeGreaterThan(0);

    // Sweep narrower and record how many of each tier remain in-bar. The
    // invariant: an L2 control never survives while an L1 control is still
    // in-bar dropped after it, etc. Concretely — L1 must reach 0 before L2
    // starts dropping, and L2 must reach 0 before L3 starts dropping (overflow
    // consumes from the FRONT of the pyramid).
    let prevL1 = L1.length;
    let prevL2 = L2.length;
    let prevLast = LAST.length;
    let prevWasDesktop = true;
    // The sidebar head (desktop, sidebar open) takes its track out of the bar
    // and yields once the bar would keep less than HEAD_MIN_BAR_PX beside it;
    // when it yields the bar regains that width, so the monotonic baseline
    // resets once at that crossing too (a regime change, like the mobile
    // boundary). The head is the header's absolutely positioned child.
    const headShown = async () => (await page.locator("header > div.absolute").count()) > 0;
    let prevHead = await headShown();
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await expect(heading).toBeVisible({ timeout: 10_000 });
      // The candidate set changes at the mobile boundary: below 640px
      // (MOBILE_BREAKPOINT_PX) the surface-toggle group forks to SWITCH mode
      // and becomes PINNED (exempt from the fit, always in-bar), dropping an
      // L1 fit candidate and freeing width that can legitimately re-admit an
      // already-dropped candidate. Monotonicity therefore holds WITHIN each
      // viewport regime (desktop ≥640 / mobile <640) — re-baseline once at the
      // crossing. The per-width pyramid-order assertions below are
      // regime-independent and still run at every width; the mobile tier
      // counts exclude the pinned group's button.
      const isDesktopWidth = width >= 640;
      if (prevWasDesktop && !isDesktopWidth) {
        prevL1 = L1_MOBILE.length;
        prevL2 = L2.length;
      }
      prevWasDesktop = isDesktopWidth;
      const headNow = await headShown();
      if (prevHead && !headNow) {
        prevL1 = isDesktopWidth ? L1.length : L1_MOBILE.length;
        prevL2 = L2.length;
        prevLast = LAST.length;
      }
      prevHead = headNow;
      const [l1, l2, l3] = await settledTierCounts(page, isDesktopWidth);
      // The pinned switch group is ALWAYS in-bar at mobile widths on this
      // code-capable window ([tty, code] ≥ 2 shown surfaces) — the primary
      // mobile affordance never overflows.
      if (!isDesktopWidth) {
        await expect(
          byRoleName(page, "Terminal tile"),
          `pinned switch group in-bar at ${width}px`,
        ).toBeVisible({ timeout: 10_000 });
      }

      // Monotonic non-increasing as width shrinks (each tier only loses members).
      expect(l1, `L1 in-bar non-increasing at ${width}px`).toBeLessThanOrEqual(prevL1);
      expect(l2, `L2 in-bar non-increasing at ${width}px`).toBeLessThanOrEqual(prevL2);

      // The `dropLast` group (desktop only — pinned at mobile): in-bar while
      // ANY pyramid member is, and non-increasing.
      if (isDesktopWidth) {
        const last = await inBarCount(page, LAST);
        expect(last, `dropLast group non-increasing at ${width}px`).toBeLessThanOrEqual(prevLast);
        if (l1 + l2 + l3 > 0) {
          expect(last, `dropLast group intact while the pyramid has members at ${width}px`).toBe(LAST.length);
        }
        prevLast = last;
      }

      // Pyramid consumed from the LEFT: L2 stays full until L1 is fully gone;
      // L3 stays full until L2 is fully gone.
      if (l1 > 0) {
        expect(l2, `L2 intact while L1 present at ${width}px`).toBe(L2.length);
        expect(l3, `L3 intact while L1 present at ${width}px`).toBe(L3.length);
      }
      if (l2 > 0) {
        expect(l3, `L3 intact while L2 present at ${width}px`).toBe(L3.length);
      }
      prevL1 = l1;
      prevL2 = l2;
    }
    // At the narrowest width the pyramid's FRONT has been fully consumed: the
    // ▦ Layout chip has overflowed (the pinned mobile switch group is exempt —
    // asserted in-bar above, not counted here). The L3 tail
    // (Refresh · Settings gear — the gear last, 260812-d1at) deliberately
    // survives at the mobile leaf — the pyramid ORDER, not an all-gone cliff,
    // is the contract. (Exact-name matching matters here: a substring
    // "Layout" would false-positive on sidebar window rows whose names carry
    // the worktree slug.)
    expect(await inBarCount(page, L1_MOBILE), "L1 fit candidates (▦ layout chip) gone at 375px").toBe(0);
  });

  /**
   * Proves: at 375px the menu lists the menuOnly split rows (two one-action
   * rows, horizontal first), the overflowed ▦ Layout chip's
   * `Layout: Single` radio row (one row per arity-valid shape; this 1-tile
   * window has just the one), the menuOnly trio's rows, and the relocated
   * App-section chrome rows (Help — HexoKit docs, Keyboard shortcuts; the
   * Theme… row is gone — theme switching lives in the settings dialog and
   * the palette), plus the always-present version row — grouped under the
   * View / Tab / App uppercase section labels. The TILES section is ABSENT
   * at this mobile width: the surface-toggles entry is in SWITCH mode there
   * — pinned in-bar and registering NO menu rows. Whichever L3 controls
   * still fit at 375px stay in-bar (the suffix rule), so no Refresh /
   * Settings row is asserted either way.
   *
   * Steps:
   * 1. At 375px open the `More controls` menu.
   * 2. Assert the Split horizontal / Split vertical / `Layout: Single`
   *    (radio) / Fixed width (checkbox) / Terminal font (stepper group) /
   *    Close pane rows are present, plus a `HexoKit` version row; assert NO
   *    `Tiles` section label and NO `Terminal tile` checkbox row (the
   *    mobile switch mode registers no menu rows); assert the View / Tab /
   *    App section labels render; assert the Help / Keyboard shortcuts rows
   *    are PRESENT, the Theme… row is ABSENT, and the notification row is
   *    ABSENT (the bell lives in the settings dialog).
   */
  test("the chevron menu contains the overflowed + menuOnly rows plus the version row, grouped under section labels", async ({
    page,
  }) => {
    const id = await resolveWindow(page, WINDOW_NAME);
    await gotoWindow(page, id);
    const heading = page.getByRole("button", { name: `Rename tab ${WINDOW_NAME}` });

    // At 375px everything overflows — the menu should carry every mapped row.
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(heading).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "More controls" }).click();
    const menu = page.getByRole("menu", { name: "More controls" });
    await expect(menu).toBeVisible();

    // The menuOnly split rows (260813-w1lf — horizontal first, the
    // 260806-2x2h default), the overflowed ▦ Layout chip (260812-ab5v)'s
    // `Layout: …` radio rows (one per arity-valid shape — this 1-tile window
    // has just `Layout: Single`), the menuOnly rows
    // (fixed-width / terminal-font stepper / close-pane), and the
    // version row is present (last). Whichever L3 controls still fit at 375px
    // stay in-bar (the pyramid's suffix rule), so no Refresh/Settings row is
    // asserted here — an in-bar entry contributes no menu row.
    await expect(menu.getByRole("menuitem", { name: "Split horizontal" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Split vertical" })).toBeVisible();
    await expect(
      menu.getByRole("menuitemradio", { name: "Layout: Single" }),
    ).toBeVisible();
    await expect(menu.getByRole("menuitemcheckbox", { name: /Fixed width/ })).toBeVisible();
    await expect(menu.getByRole("group", { name: "Terminal font size" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Close pane" })).toBeVisible();
    // Density + grouping (260731-oiho): thin uppercase section labels group the
    // rows in the fixed Tiles → View → Window → App order. TILES IS ABSENT
    // here: at this mobile width the surface-toggles entry is in SWITCH mode —
    // PINNED in-bar and registering NO menu rows — so it contributes no
    // section.
    await expect(menu.getByText("Tiles", { exact: true })).toHaveCount(0);
    await expect(
      menu.getByRole("menuitemcheckbox", { name: "Terminal tile" }),
    ).toHaveCount(0);
    await expect(menu.getByText("View", { exact: true })).toBeVisible();
    await expect(menu.getByText("Tab", { exact: true })).toBeVisible();
    await expect(menu.getByText("App", { exact: true })).toBeVisible();
    // The relocated chrome rows (260812-d1at) are menuOnly — ALWAYS in the App
    // section, above the fixed version row. Notifications stay gone (they live
    // in the settings dialog, 260724-6j1v), and so does Theme… — theme
    // switching lives in the settings dialog's inline picker and the palette
    // (260819-qkow).
    await expect(menu.getByRole("menuitem", { name: /Help — HexoKit docs/ })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Keyboard shortcuts" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /Theme…/ })).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: /notification/i })).toHaveCount(0);
    // The fixed version row is always present (plain `HexoKit` or `HexoKit v…`).
    await expect(menu.getByRole("menuitem", { name: /HexoKit/ })).toBeVisible();
  });

  /**
   * Proves: the demotion is menu-ONLY, not space-driven — at 1280px the bar
   * has room (the surface-toggle group AND the ▦ Layout chip are in-bar,
   * group leftmost — the in-bar order [toggles] · ▦Layout · Refresh · Gear
   * · chevron) yet the demoted set AND the menuOnly chrome rows render only
   * as menu rows; the Settings gear is a real fit candidate, rendering
   * in-bar between Refresh and the chevron; and an in-bar entry's rows are
   * NOT duplicated into the menu.
   *
   * Steps:
   * 1. Navigate to the terminal window; set 1280×800; gate on the in-bar
   *    `Terminal tile` toggle button AND the ▦ `Layout` chip; assert the
   *    toggle button's box is LEFT of the Layout chip's (registry order —
   *    the group is the L1 head).
   * 2. Assert the in-bar count of the `MENU_ONLY` set (split included) and
   *    of the Help / Keyboard shortcuts rows is 0; assert the
   *    `Open settings` gear is visible in-bar with a bounding box between
   *    Refresh's and the chevron's.
   * 3. Open the menu; assert the Fixed width checkbox row, the Terminal
   *    font stepper group, the Close pane row, and the two chrome rows are
   *    present; assert the Split horizontal / Split vertical rows ARE
   *    present (menuOnly — always in the menu, wide width included) and NO
   *    `Settings` row (the gear is in-bar, so it contributes no menu row).
   */
  test("the menuOnly rows (split / fixed-width / Aa / close-pane / Help / Keyboard) are in the menu even at a WIDE width", async ({
    page,
  }) => {
    // The distinguishing case: the bar has room at 1440px (with the sidebar
    // head taking its 232px, 1280px no longer keeps the ▦ Layout chip — the
    // pyramid's first member to yield — in-bar) — the in-bar end state is
    // [surface-toggles group] · ▦Layout · Refresh · Gear ·
    // chevron (the split chip demoted to menuOnly in terminal mode,
    // 260813-w1lf; the rail-toggle chip REMOVED, 260815-19me) — yet the
    // demoted controls still live ONLY in the menu (menu-only, not
    // space-driven overflow). The 260812-d1at chrome rows share that
    // placement: Help / Keyboard are `menuOnly` App-section rows.
    const id = await resolveWindow(page, WINDOW_NAME);
    await gotoWindow(page, id);
    const heading = page.getByRole("button", { name: `Rename tab ${WINDOW_NAME}` });
    await page.setViewportSize({ width: 1440, height: 800 });
    await expect(heading).toBeVisible({ timeout: 10_000 });
    // The bar carries the surface-toggle group (the `dropLast` entry — its
    // "Terminal tile" button; tty is always an available surface) AND the ▦
    // Layout chip, group LEFTMOST (registry order)…
    const tileToggle = byRoleName(page, "Terminal tile");
    await expect(tileToggle).toBeVisible({ timeout: 10_000 });
    await expect(byRoleName(page, "Layout")).toBeVisible({ timeout: 10_000 });
    const tileBox = (await tileToggle.boundingBox())!;
    const layoutBox = (await byRoleName(page, "Layout").boundingBox())!;
    expect(tileBox.x, "toggle group left of the ▦ Layout chip").toBeLessThan(layoutBox.x);
    // …but never the demoted set (split included) nor the chrome rows.
    expect(await inBarCount(page, MENU_ONLY)).toBe(0);
    expect(await inBarCount(page, ["Help — HexoKit docs", "Keyboard shortcuts"])).toBe(0);
    // The Settings gear IS in-bar (a real fit candidate), immediately left of
    // the chevron (Refresh · Gear · chevron order).
    const gear = byRoleName(page, "Open settings");
    await expect(gear).toBeVisible();
    const gearBox = (await gear.boundingBox())!;
    const refreshBox = (await byRoleName(page, "Refresh page").boundingBox())!;
    const chevronBox = (await page.getByRole("button", { name: "More controls" }).boundingBox())!;
    expect(gearBox.x).toBeGreaterThan(refreshBox.x);
    expect(gearBox.x).toBeLessThan(chevronBox.x);

    await page.getByRole("button", { name: "More controls" }).click();
    const menu = page.getByRole("menu", { name: "More controls" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitemcheckbox", { name: /Fixed width/ })).toBeVisible();
    await expect(menu.getByRole("group", { name: "Terminal font size" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Close pane" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /Help — HexoKit docs/ })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Keyboard shortcuts" })).toBeVisible();
    // The split rows are menuOnly in terminal mode (260813-w1lf) — ALWAYS in
    // the menu, wide width included (the mobile path + muscle-memory fallback).
    await expect(menu.getByRole("menuitem", { name: "Split horizontal" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Split vertical" })).toBeVisible();
    // The in-bar gear contributes no menu row while in-bar.
    await expect(menu.getByRole("menuitem", { name: "Settings" })).toHaveCount(0);
  });

  /**
   * Proves: the relocated chrome rows are functional, not just present —
   * Help is a safe external link, and Keyboard shortcuts deep-links into
   * the settings dialog's Shortcuts tab (the standalone overlay and its
   * `shortcuts-overlay:open` event seam are retired).
   *
   * Steps:
   * 1. Navigate to the terminal window; set 375×800; open the
   *    `More controls` menu.
   * 2. Assert the Help row's `href` / `target="_blank"` /
   *    `rel="noopener…"`.
   * 3. Click `Keyboard shortcuts`; assert the `Settings` dialog is visible
   *    with the `settings-shortcuts-panel` testid inside; Escape-close it.
   */
  test("the App-section chrome rows work: Help links out, Keyboard opens the overlay", async ({
    page,
  }) => {
    const id = await resolveWindow(page, WINDOW_NAME);
    await gotoWindow(page, id);
    const heading = page.getByRole("button", { name: `Rename tab ${WINDOW_NAME}` });
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(heading).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "More controls" }).click();
    const menu = page.getByRole("menu", { name: "More controls" });
    await expect(menu).toBeVisible();

    // Help — an external-link row (never unloads the live dashboard).
    const help = menu.getByRole("menuitem", { name: /Help — HexoKit docs/ });
    await expect(help).toHaveAttribute("href", "https://hexokit.com/docs/");
    await expect(help).toHaveAttribute("target", "_blank");
    await expect(help).toHaveAttribute("rel", /noopener/);

    // Keyboard shortcuts — deep-links into the settings dialog's Shortcuts
    // tab directly via the settings context (the `shortcuts-overlay:open`
    // event seam is retired, 260818-bncw; menu closes on the menuitem click).
    await menu.getByRole("menuitem", { name: "Keyboard shortcuts" }).click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await expect(page.getByTestId("settings-shortcuts-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
  });

  /**
   * Proves: clicking the version row copies the displayed version form.
   *
   * Steps:
   * 1. Grant clipboard permissions; open the menu at 375px.
   * 2. Read the version row's text; click it.
   * 3. If the row shows `HexoKit v…` (a version was reported), assert the
   *    clipboard holds the `v…` form; if it is the plain `HexoKit` (no
   *    version yet), the copy is a no-op and the clipboard assertion is
   *    skipped.
   */
  test("the version row copies the version to the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const id = await resolveWindow(page, WINDOW_NAME);
    await gotoWindow(page, id);
    const heading = page.getByRole("button", { name: `Rename tab ${WINDOW_NAME}` });
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(heading).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "More controls" }).click();
    const menu = page.getByRole("menu", { name: "More controls" });
    const versionRow = menu.getByRole("menuitem", { name: /HexoKit/ });
    await expect(versionRow).toBeVisible();
    const rowText = (await versionRow.textContent())?.trim() ?? "";
    await versionRow.click();

    // If the daemon reported a version (`HexoKit v…`), the clipboard holds the
    // displayed `v…` form. If it is the plain `HexoKit` (no version yet), the row
    // is a no-op copy — skip the clipboard assertion in that case.
    if (/^HexoKit v/.test(rowText)) {
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toMatch(/^v?\d/);
    }
  });

  /**
   * Proves: a menu action mutates app state from within the menu. The
   * fixed-width checkbox row is the representative stateful menu action
   * (the one-shot chrome rows — Keyboard — have their own coverage above).
   *
   * Steps:
   * 1. Open the menu at 375px; read the `Fixed width` row's `aria-checked`.
   * 2. Click the row (the checkbox activation closes the menu).
   * 3. Reopen the menu and assert the `aria-checked` state flipped; click
   *    once more to restore the default full-width preference for later
   *    specs.
   */
  test("a menu action (fixed-width toggle) works from the menu", async ({ page }) => {
    // The fixed-width checkbox row is the representative stateful menu action
    // (the one-shot chrome rows — Keyboard — have their own event coverage
    // above).
    const id = await resolveWindow(page, WINDOW_NAME);
    await gotoWindow(page, id);
    const heading = page.getByRole("button", { name: `Rename tab ${WINDOW_NAME}` });
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(heading).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "More controls" }).click();
    const menu = page.getByRole("menu", { name: "More controls" });
    const row = menu.getByRole("menuitemcheckbox", { name: /Fixed width/ });
    const before = await row.getAttribute("aria-checked");
    await row.click();

    // The checkbox toggle closes the menu (role-keyed close); reopen and
    // confirm the checked state flipped.
    await page.getByRole("button", { name: "More controls" }).click();
    const menu2 = page.getByRole("menu", { name: "More controls" });
    const row2 = menu2.getByRole("menuitemcheckbox", { name: /Fixed width/ });
    const after = await row2.getAttribute("aria-checked");
    expect(after, `fixed-width toggled from "${before}"`).not.toBe(before);
    // Restore the preference so later specs see the default full-width state.
    await row2.click();
  });
});

// The ViewSwitcher is RETIRED (260812-0c6o) — lens switching is palette-only
// (plus the top bar's surface-toggle group, 260815-19me — the rail that used
// to carry the open-tile toggles is REMOVED). This block uses a web-capable
// window (a stamped web tab ⇒ `[tty|web]`; the repo-cwd pane also derives
// a gitRoot ⇒ `code`) with a long name to prove palette activation still
// switches the lens at a wide width and the fit pyramid over the remaining
// candidates is intact with the surface-toggle group as
// terminal's first-to-yield fit candidate (the ▦ Layout chip next; the split
// control left the terminal bar in 260813-w1lf — `menuOnly`, never a fit
// candidate there).
const VIEW_WINDOW_NAME = `overflow-view-long-worktree-${Date.now().toString().slice(-6)}`;

test.describe("Top-bar overflow: the view-switcher is retired (260812-0c6o)", () => {
  test.beforeAll(() => {
    try {
      newWindow(TEST_SESSION, VIEW_WINDOW_NAME);
    } catch {
      // Session/window may already exist.
    }
  });

  async function gotoViewWindow(page: Page): Promise<string> {
    const id = await resolveWindow(page, VIEW_WINDOW_NAME);
    // Stamp the slot-1 web tab (the derived dead URL) so the window offers the
    // `web` lens (`[tty|web]` → the multi-view gate passes and the palette's
    // `View: Web` action renders). Set before navigating so the first snapshot
    // carries it.
    stampWebTab(id, DEAD.url);
    await gotoWindow(page, id);
    return id;
  }

  /**
   * Proves: with the right rail removed (its open-tile toggles relocated
   * into the top bar as ONE bordered group) and the split control menuOnly
   * in terminal mode, the surface-toggle group is terminal's FIRST fit
   * candidate (the L1 head) — on DESKTOP, whenever its `Terminal tile`
   * button is still in-bar, nothing has dropped yet, so every L1/L2/L3
   * control is also in-bar (the surviving set is a suffix of the fit
   * order). On MOBILE (<640px) the same entry forks to SWITCH mode and is
   * PINNED: it stays in-bar at every mobile width (never overflowed, no
   * Tiles menu rows) while other candidates drop around it.
   *
   * Steps:
   * 1. Navigate to the web-capable window.
   * 2. Sweep 1440 → … → 375, gating on the renamable heading each
   *    iteration; at 1440px gate on a RETRYING `Terminal tile` visibility
   *    expect (post-resize re-fit settle). At each DESKTOP width, if any
   *    pyramid candidate (L1/L2/L3) is in-bar assert the group is in-bar
   *    too (it is `dropLast`), and if the group is gone assert every
   *    pyramid candidate is gone; at each MOBILE width (<640px) assert the
   *    `Terminal tile` button IS in-bar (the pinned switch group never
   *    overflows).
   * 3. Assert the group was seen in-bar at some wide width (the desktop
   *    side of the contract).
   */
  test("the surface-toggle group is the LAST fit candidate to yield on desktop (dropLast); on mobile it is PINNED in-bar", async ({
    page,
  }) => {
    await gotoViewWindow(page);
    const heading = page.getByRole("button", { name: `Rename tab ${VIEW_WINDOW_NAME}` });

    // The surface-toggle group — located via its "Terminal tile" button (tty
    // is always available; the aria-hidden probe copy is excluded by the role
    // query) — is the cluster's `dropLast` entry: leftmost in the bar but at
    // the TAIL of the fit order. The DESKTOP invariant across the sweep:
    // whenever any pyramid candidate (L1/L2/L3) is still in-bar the group
    // must be too, and once the group is gone every pyramid candidate is
    // gone (the surviving set is a suffix of the fit order, and the group is
    // its last element). On MOBILE the group forks to switch mode and is
    // PINNED (exempt from the fit): it stays in-bar at every mobile width
    // while other candidates overflow around it.
    const groupToggle = () => byRoleName(page, "Terminal tile");
    const allCandidates = [...L1, ...L2, ...L3];
    let sawInBar = false;
    for (const width of [1440, ...WIDTHS]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(heading).toBeVisible({ timeout: 10_000 });
      // At the widest width the whole cluster MUST fit — gate on a RETRYING
      // visibility expect so the post-resize re-fit (ResizeObserver → layout
      // effect) has settled before the plain `count()` reads below.
      if (width === 1440) {
        await expect(groupToggle()).toBeVisible({ timeout: 10_000 });
      }
      if (width < 640) {
        // Mobile: the pinned switch group is ALWAYS in-bar (this window shows
        // [tty, web, code] — ≥2 surfaces), quite apart from the fit outcome.
        await expect(
          groupToggle(),
          `pinned switch group in-bar at ${width}px`,
        ).toBeVisible({ timeout: 10_000 });
        continue;
      }
      const inBar = (await groupToggle().count()) > 0;
      if (inBar) {
        sawInBar = true;
      } else {
        // RETRYING: right after a resize the ResizeObserver-driven re-fit can
        // still be mid-cascade. Once the dropLast group is SETTLED out of the
        // bar, the suffix fit guarantees every pyramid candidate is out too.
        await expect
          .poll(() => inBarCount(page, allCandidates), { timeout: 10_000 })
          .toBe(0);
      }
      // And whenever any pyramid candidate is in-bar, the group must be.
      if ((await inBarCount(page, allCandidates)) > 0) {
        await expect(groupToggle(), `dropLast group in-bar at ${width}px`).toBeVisible({ timeout: 10_000 });
      }
    }
    // The sweep genuinely exercised both sides: in-bar at some wide width
    // (gated above), and pinned in-bar at the mobile leaf (asserted in the
    // loop — the switch fork never overflows there).
    expect(sawInBar, "the surface-toggle group was in-bar at some (wide) width").toBe(true);
  });

  /**
   * Proves: when the group overflows at a DESKTOP width (below 640px the
   * entry switches to the pinned in-bar switch group with NO menu rows),
   * the chevron menu gains a Tiles section as its FIRST section (its label
   * sits above View's), holding one `menuitemcheckbox` row per shown
   * surface named `<Label> tile` with `aria-checked` = tile open.
   *
   * Steps:
   * 1. Navigate to the web-capable window (offers `[tty|web|code]`).
   * 2. Step the viewport down from 800px in 20px increments (staying above
   *    the 640px mobile boundary), gating on the renamable heading each
   *    step, until a bounded RETRYING expect confirms the in-bar
   *    `Terminal tile` button is gone (the group is `dropLast` — the last
   *    fit candidate to overflow — and the sidebar head yields before the
   *    bar gets that narrow, so the group may never overflow on desktop:
   *    then the test SKIPS, and the Tiles section stays covered by the unit
   *    suite where jsdom overflows everything).
   * 3. Open the `More controls` menu; assert the `Tiles` and `View` section
   *    labels are both visible and the Tiles label's box sits ABOVE View's.
   * 4. Assert the `Terminal tile` checkbox row is visible with
   *    `aria-checked="true"` (the tty tile is open) and the `Web tile` /
   *    `Code tile` rows are visible with `aria-checked="false"`.
   */
  test("the overflowed surface-toggle group renders a Tiles menu section FIRST (before View)", async ({
    page,
  }) => {
    await gotoViewWindow(page);
    const heading = page.getByRole("button", { name: `Rename tab ${VIEW_WINDOW_NAME}` });

    // The group's MENU form is desktop-only (below 640px the entry switches to
    // the pinned in-bar switch group with NO menu rows — the main block's
    // 375px menu test proves that absence), so it appears only at a DESKTOP
    // width narrow enough to overflow it. Step down from 800px until the
    // in-bar `Terminal tile` button is gone. The group is `dropLast` (the last
    // fit candidate to overflow) and the sidebar head yields before the bar
    // gets that narrow, so on this window the group may stay in-bar at every
    // desktop width — then there is nothing to assert here and the test
    // skips; the unit suite (`top-bar.test.tsx`, "overflows into a Tiles menu
    // section…") covers the section's rendering in jsdom, where everything
    // overflows. Each probe is a bounded RETRYING expect so a mid-cascade
    // re-fit frame can't fake the drop.
    // The sweep is expected to come up empty on this window (see above), so
    // each step's probe is short and the steps are 20px — 8 bounded probes
    // instead of 16 long ones; `test.slow()` triples the budget for the case
    // where the group does drop and the menu assertions follow.
    test.slow();
    let menuWidth = 0;
    for (let w = 800; w > 640; w -= 20) {
      await page.setViewportSize({ width: w, height: 800 });
      await expect(heading).toBeVisible({ timeout: 10_000 });
      try {
        await expect(byRoleName(page, "Terminal tile")).toHaveCount(0, { timeout: 1_000 });
        menuWidth = w;
        break;
      } catch {
        // Still in-bar at this width — keep shrinking.
      }
    }
    test.skip(
      menuWidth === 0,
      "the dropLast surface-toggle group stayed in-bar at every desktop width (641–800px); the Tiles section is unit-tested",
    );

    await page.getByRole("button", { name: "More controls" }).click();
    const menu = page.getByRole("menu", { name: "More controls" });
    await expect(menu).toBeVisible();

    // Tiles is the menu's FIRST section — its label sits above View's.
    const tilesLabel = menu.getByText("Tiles", { exact: true });
    const viewLabel = menu.getByText("View", { exact: true });
    await expect(tilesLabel).toBeVisible();
    await expect(viewLabel).toBeVisible();
    const tilesBox = (await tilesLabel.boundingBox())!;
    const viewBox = (await viewLabel.boundingBox())!;
    expect(tilesBox.y, "Tiles section precedes View").toBeLessThan(viewBox.y);

    // One `menuitemcheckbox` row per shown surface, aria-checked = tile open.
    // This window offers
    // [tty|web|code] (a stamped web tab ⇒ web; the repo-cwd pane derives a gitRoot ⇒
    // code) and only the tty tile is open.
    const ttyRow = menu.getByRole("menuitemcheckbox", { name: "Terminal tile" });
    await expect(ttyRow).toBeVisible();
    await expect(ttyRow).toHaveAttribute("aria-checked", "true");
    const webRow = menu.getByRole("menuitemcheckbox", { name: "Web tile" });
    await expect(webRow).toBeVisible();
    await expect(webRow).toHaveAttribute("aria-checked", "false");
    const codeRow = menu.getByRole("menuitemcheckbox", { name: "Code tile" });
    await expect(codeRow).toBeVisible();
    await expect(codeRow).toHaveAttribute("aria-checked", "false");
  });

  /**
   * Proves: the palette is a fully functional lens switcher at a WIDE width
   * — the distinguishing case (the bar has room, yet the menu holds no
   * `View:` rows): running the palette's `View: Web` action switches the
   * lens (the selection becomes a single-tile `web` layout through the shared
   * mutation path, POSTed to the window's `@rk_win_layout` option — the URL
   * stays bare).
   *
   * Steps:
   * 1. Navigate to the web-capable window; set 1440×800; gate on the
   *    renamable heading.
   * 2. Open the palette (`openPalette`); fill `View: Web`; click the `View: Web` option.
   * 3. Assert the window's `@rk_win_layout` option reads `web` (the tree form) and
   *    the proxied iframe (`title="Proxied content"`) renders.
   */
  test("a palette `View:` action switches the lens — even at a wide width", async ({
    page,
  }) => {
    const viewWindowId = await gotoViewWindow(page);
    const heading = page.getByRole("button", { name: `Rename tab ${VIEW_WINDOW_NAME}` });
    // A wide width is the distinguishing case: the bar has room, yet lens
    // switching is palette-only (260812-0c6o) — the menu holds no `View:` rows.
    await page.setViewportSize({ width: 1440, height: 800 });
    await expect(heading).toBeVisible({ timeout: 10_000 });

    // The command palette's `View: Web` action switches the lens: the selection
    // becomes a single-tile `web` layout POSTed to the shared option (the URL never
    // carries it).
    const paletteInput = await openPalette(page);
    await paletteInput.fill("View: Web");
    const webOption = page.getByRole("option", { name: "View: Web" });
    await expect(webOption).toBeVisible();
    await webOption.click();
    await expect
      .poll(() => windowOption(viewWindowId, "@rk_win_layout"), { timeout: 10_000 })
      .toBe("web");
    expect(new URL(page.url()).search).toBe("");
    await expect(page.getByTitle("Proxied content")).toBeVisible({ timeout: 10_000 });
  });
});
