// Breadcrumb min-useful-width collapse e2e — the degradation ladder's middle
// rung: when the server+session crumbs would truncate below ~6ch of useful
// content each, BOTH collapse into a single `… ▾` crumb (one dropdown
// carrying the server + session levels) instead of rendering fragments like
// `ru…` or a hard-clipped `runKi` with no ellipsis. The collapse is
// measurement-driven (ResizeObserver + a hidden min-useful probe row,
// data-testid="crumb-collapse-probe"), so this spec sweeps real viewport
// widths rather than asserting a fixed breakpoint.
//
// Shared setup: file-level `beforeAll` creates a dedicated tmux session on
// the isolated test server with a deliberately LONG session name
// (`e2e-crumbcollapse-longsession-<ts>`) plus a long-named window, so both
// crumbs are under genuine truncation pressure across the sweep; `afterAll`
// kills the session. `resolveWindow`/`gotoWindow` are thin file-local
// wrappers over the shared helpers in `_ready.ts`. `intersects(a, b)` is a
// rect-overlap helper (AABB test) used to assert the nav box and the heading
// box share no area. The collapse width is located DYNAMICALLY (a stepped
// sweep) because the exact engagement point depends on real font metrics,
// not on a hardcoded pixel.
import { test, expect } from "@playwright/test";
import { resolveWindow as resolveWindowRaw, gotoWindow as gotoWindowRaw } from "./_ready";
import { TMUX_SERVER, createSession, killSession, newWindow } from "./_tmux";

// Deliberately LONG names so both crumbs sit under real truncation pressure
// through the whole responsive band (well over the 16ch crumb cap).
const TEST_SESSION = `e2e-crumbcollapse-longsession-${Date.now().toString().slice(-6)}`;
const LONG_WINDOW = `crumbcollapse-verylongwindowname-${Date.now().toString().slice(-6)}`;

const WIDE_VIEWPORT = { width: 1280, height: 800 };

// Shared readiness helpers (hoisted to `_ready.ts`) bound to this file's
// server + session so call sites keep their two-arg shape.
const resolveWindow = async (page: Parameters<typeof resolveWindowRaw>[0], windowName: string) =>
  (await resolveWindowRaw(page, TMUX_SERVER, TEST_SESSION, windowName)).windowId;
const gotoWindow = (page: Parameters<typeof gotoWindowRaw>[0], windowId: string) =>
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

/** The collapsed crumb's trigger (one BreadcrumbDropdown labeled "location"). */
const collapseTrigger = (page: Parameters<typeof gotoWindowRaw>[0]) =>
  page.getByRole("button", { name: "Switch location" });

/**
 * Step the viewport width down from `from` to `to` until the collapse trigger
 * renders; returns the engaging width, or null when the rung never engaged.
 */
async function findCollapseWidth(
  page: Parameters<typeof gotoWindowRaw>[0],
  from: number,
  to: number,
): Promise<number | null> {
  for (let w = from; w >= to; w -= 16) {
    await page.setViewportSize({ width: w, height: 800 });
    // The ResizeObserver-driven re-measure is not atomic with the resize —
    // give it a frame before probing.
    await page.waitForTimeout(150);
    if (await collapseTrigger(page).isVisible()) return w;
  }
  return null;
}

test.beforeAll(() => {
  createSession(TEST_SESSION);
  try {
    newWindow(TEST_SESSION, LONG_WINDOW);
  } catch {
    // Best effort — matches the overlap spec's pattern.
  }
});

test.afterAll(() => {
  killSession(TEST_SESSION);
});

test.describe("Breadcrumb min-useful-width collapse", () => {
  // Both tests structurally exceed the rig's 10s default per-test budget:
  // test 1 sweeps widths + navigates twice from the collapsed menu, test 2
  // runs a 13-width sweep with per-width in-page assertions (sibling pattern:
  // touch-focus-gate / board-autofit set explicit budgets).
  test.setTimeout(60_000);
  /**
   * Proves: below the crumbs' minimum useful width, the server and session
   * crumbs collapse into ONE `… ▾` crumb whose dropdown carries BOTH levels —
   * the server item navigates to the Workspace route and the session item
   * (marked current) navigates to the current window's route — so both
   * destinations stay one tap away at widths where separate crumbs would
   * render as fragments.
   *
   * Steps:
   * 1. Resolve the long-named window; navigate to it at 1280px and assert
   *    the EXPANDED baseline: the server crumb link and session chip are
   *    visible and no collapse trigger renders.
   * 2. Sweep the width down from 1000px until the `Switch location` trigger
   *    appears; assert it engages before the `sm` breakpoint hide (640px) —
   *    with long names the measured threshold sits well above it.
   * 3. At the collapsed width, assert the separate server link is gone.
   * 4. Open the trigger; assert the menu lists both levels (server name +
   *    session name).
   * 5. Click the server item; assert the URL lands on `/$server`.
   * 6. Return to the window (fresh load re-collapses at the same width),
   *    reopen the trigger, click the session item; assert the URL is the
   *    two-segment window route (the session level's destination).
   */
  test("below the useful-width floor the crumbs collapse into one … ▾ menu that navigates to both levels", async ({
    page,
  }) => {
    const id = await resolveWindow(page, LONG_WINDOW);

    // 1. Expanded baseline at a wide viewport.
    await page.setViewportSize(WIDE_VIEWPORT);
    await gotoWindow(page, id);
    const nav = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(
      nav.getByRole("link", { name: TMUX_SERVER }),
      "server crumb link renders expanded at 1280px",
    ).toBeVisible({ timeout: 10_000 });
    // The visible chip's text span carries `max-w-[16ch]`; the collapse
    // probe's min-useful twin carries `max-w-[6ch]` — the class scopes the
    // query to the visible crumb (strict-mode safe).
    await expect(
      nav.locator("span.max-w-\\[16ch\\]", { hasText: TEST_SESSION }),
    ).toBeVisible();
    await expect(collapseTrigger(page)).toHaveCount(0);

    // 2. Locate the collapse engagement width dynamically (font-metric
    // dependent — never a hardcoded pixel).
    const collapseWidth = await findCollapseWidth(page, 1000, 640);
    expect(
      collapseWidth,
      "the collapse rung never engaged between 1000px and the sm breakpoint",
    ).not.toBeNull();

    // 3. The separate crumbs are replaced by the single trigger.
    await expect(
      nav.getByRole("link", { name: TMUX_SERVER }),
      "the server crumb link is replaced by the collapsed crumb",
    ).toHaveCount(0);

    // 4-5. The collapsed menu carries the server level and navigates to it.
    await collapseTrigger(page).click();
    const menu = page.getByRole("menu", { name: "Switch location" });
    await expect(menu).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: TMUX_SERVER }),
      "server level survives inside the collapsed menu",
    ).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: TEST_SESSION }),
      "session level survives inside the collapsed menu",
    ).toBeVisible();
    await menu.getByRole("menuitem", { name: TMUX_SERVER }).click();
    await expect(page).toHaveURL(new RegExp(`/${TMUX_SERVER}$`));

    // 6. The session level points at the current window's route.
    await gotoWindow(page, id);
    await expect(collapseTrigger(page)).toBeVisible({ timeout: 10_000 });
    await collapseTrigger(page).click();
    await page
      .getByRole("menu", { name: "Switch location" })
      .getByRole("menuitem", { name: TEST_SESSION })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/${TMUX_SERVER}/${encodeURIComponent(id)}$`),
    );
  });

  /**
   * Proves: across the whole responsive band the breadcrumb never renders a
   * crumb below its 6ch useful floor (no `ru…`-style fragments, and a
   * truncating crumb always keeps its ellipsis reserve — the crumb box is
   * floored at 6ch + chrome), the collapse rung never reintroduces the
   * nav/heading overlap, and no width overflows the page horizontally.
   *
   * Steps:
   * 1. Resolve the long-named window; navigate to it at 1280px.
   * 2. For each width in [1280, 1024, 940, 860, 800, 768, 720, 700, 660,
   *    640, 600, 500, 375]: set the viewport, wait a frame for the
   *    ResizeObserver re-measure, then assert (a) the nav box and the
   *    heading box do not intersect; (b) `document.body.scrollWidth ≤
   *    width`; (c) when the collapse trigger is absent, every visible
   *    crumb's box is at least as wide as its min-useful twin in the probe
   *    (display:none crumbs — breakpoint-hidden — read 0 on both sides and
   *    pass trivially); (d) below `sm` (<640px) the collapse trigger is
   *    HIDDEN even though the sweep engaged it at sm+ widths — a collapse
   *    carried into mobile by the stateful derivation must never render
   *    (the breakpoint hides are the unconditional outer rungs; the trigger
   *    is gated `hidden sm:contents`).
   */
  test("width sweep: no crumb renders below the 6ch useful floor, no nav/heading overlap, no page overflow", async ({
    page,
  }) => {
    const id = await resolveWindow(page, LONG_WINDOW);
    await page.setViewportSize(WIDE_VIEWPORT);
    await gotoWindow(page, id);
    const heading = page.getByRole("button", { name: `Rename tab ${LONG_WINDOW}` });
    await expect(heading).toBeVisible({ timeout: 10_000 });

    for (const width of [1280, 1024, 940, 860, 800, 768, 720, 700, 660, 640, 600, 500, 375]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(150);

      // (a) The collapse rung spends the LEFT cell only — the centered
      // heading's box is never encroached (the q8ey no-overlap contract).
      const nav = page.getByRole("navigation", { name: "Breadcrumb" });
      const navBox = await nav.boundingBox();
      const headingBox = await heading.boundingBox();
      expect(navBox, `nav has a box at ${width}px`).toBeTruthy();
      expect(headingBox, `heading has a box at ${width}px`).toBeTruthy();
      expect(
        intersects(navBox!, headingBox!),
        `nav overlaps heading at ${width}px`,
      ).toBe(false);

      // (b) No horizontal page overflow at any width.
      const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
      expect(bodyWidth, `page overflows at ${width}px`).toBeLessThanOrEqual(width);

      // (c) The fragment invariant, proven against the probe's min-useful
      // twins: an expanded crumb's box is floored at 6ch + chrome, so a
      // truncating crumb always retains its ellipsis reserve.
      const floors = await page.evaluate(() => {
        const navEl = document.querySelector('nav[aria-label="Breadcrumb"]');
        if (!navEl) return { collapsed: false, pairs: [] as { visible: number; floor: number }[] };
        if (navEl.querySelector('[aria-label="Switch location"]')) {
          return { collapsed: true, pairs: [] as { visible: number; floor: number }[] };
        }
        const probe = navEl.querySelector('[data-testid="crumb-collapse-probe"]');
        const section = probe?.parentElement;
        if (!probe || !section) return { collapsed: false, pairs: [] as { visible: number; floor: number }[] };
        const boxWidth = (span: Element) =>
          (span.parentElement as HTMLElement).offsetWidth;
        const floorBoxes = Array.from(probe.querySelectorAll(".truncate")).map(boxWidth);
        const visibleBoxes = Array.from(
          section.querySelectorAll(":scope > span:not([data-testid='crumb-collapse-probe']) .truncate"),
        ).map(boxWidth);
        return {
          collapsed: false,
          pairs: visibleBoxes.map((visible, i) => ({ visible, floor: floorBoxes[i] ?? 0 })),
        };
      });
      if (!floors.collapsed) {
        for (const { visible, floor } of floors.pairs) {
          // 1px of slack for subpixel rounding.
          expect(
            visible,
            `a crumb rendered at ${visible}px, below its ${floor}px useful floor (viewport ${width}px)`,
          ).toBeGreaterThanOrEqual(floor - 1);
        }
      }

      // (d) Resize-into-mobile pin: the sweep engaged the collapse well
      // before 640px (long names), so the trigger exists in the DOM below
      // sm — it must be CSS-hidden there, never rendered.
      if (width < 640) {
        await expect(
          collapseTrigger(page),
          `collapse trigger rendered below the sm breakpoint at ${width}px`,
        ).toBeHidden();
      }
    }
  });
});
