import { test, expect } from "@playwright/test";
import { resolveWindow as resolveWindowRaw, gotoWindow as gotoWindowRaw } from "./_ready";
import { TMUX_SERVER, createSession, killSession, newWindow } from "./_tmux";

// Top-bar overlap fixes e2e — in the mid-width band between the `sm`
// breakpoint (640px) and ~900px, the left breadcrumb crumbs compress to an
// ellipsis and clip inside the nav box instead of overflowing and painting
// over the centered `Tab: <name>` heading. Proves the degradation ladder —
// long crumbs truncate (the `min-w-0` chain unblocks the existing `truncate
// max-w-[16ch]`), the breadcrumb `<nav>` clips residual overflow
// (`overflow-hidden` + an explicit `min-w-[46px] sm:min-w-[150px]` floor),
// the server crumb hides below `md` and reappears at `md+` (below `md` the
// ancestor navigation paths are the palette's `Go: Workspace` / `Go:
// Host`), and the center heading is never compressed into overlap (the
// center grid track's `min-w-0` was removed so the `auto` column holds its
// content floor, with the `sm:min-w-[28ch]` inner anchor kept at `sm:`). The
// 375px mobile leaf and 1024px+ desktop layouts are re-verified for no
// regression.
//
// Shared setup: file-level `beforeAll` creates a dedicated tmux session on
// the isolated test server with a deliberately LONG session name
// (`e2e-overlap-longsessionname-<ts>`, ~35 chars, well over the crumb's 16ch
// cap) and a window with a deliberately LONG name
// (`overlap-verylongwindowname-<ts>`), so both the session crumb and the
// centered heading are under genuine truncation pressure in the overlap band;
// `afterAll` kills the session. `resolveWindow`/`gotoWindow` are thin
// file-local wrappers over the shared helpers in `_ready.ts` (the server +
// session are bound here so call sites keep their two-arg shape).
// `intersects(a, b)` is a rect-overlap helper (AABB test) used to assert the
// nav box and heading box share no area. Viewports: MOBILE 375×812, MID
// 700×800 (heart of the pre-fix overlap band), DESKTOP 1024×800 (>= `md`).

// A deliberately LONG session name so the session crumb is under real
// truncation pressure in the 640-900px band (the overlap regression band).
const TEST_SESSION = `e2e-overlap-longsessionname-${Date.now().toString().slice(-6)}`;
// A deliberately LONG window name so the centered heading is wide too.
const LONG_WINDOW = `overlap-verylongwindowname-${Date.now().toString().slice(-6)}`;

const MOBILE_VIEWPORT = { width: 375, height: 812 };
// ~700px is the heart of the pre-fix overlap band (between `sm` 640 and ~900).
const MID_VIEWPORT = { width: 700, height: 800 };
const DESKTOP_VIEWPORT = { width: 1024, height: 800 };

// Shared readiness helpers (hoisted to `_ready.ts`) bound to this file's server
// + session so existing call sites keep their two-arg shape.
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

test.beforeAll(() => {
  createSession(TEST_SESSION);
  // Create an ADDITIONAL window with the long name (the session's default
  // first window keeps its auto-name) so the terminal route carries a wide
  // centered heading. The test navigates to this long-named window by id.
  try {
    newWindow(TEST_SESSION, LONG_WINDOW);
  } catch {
    // Best effort — matches the prior copied pattern.
  }
});

test.afterAll(() => {
  killSession(TEST_SESSION);
});

test.describe("Top-bar overlap fixes (260715-q8ey)", () => {
  // The navigation + resize-sweep tests ride the rig's 10s default budget on
  // a loaded box; the sibling sweep/navigate specs set explicit budgets.
  test.setTimeout(30_000);
  /**
   * Proves: the core regression is fixed — at 700px on a terminal route
   * with a long window name and a long session name, the left breadcrumb
   * nav's bounding box and the centered heading's bounding box do not
   * intersect, and the long session crumb either is truncated (ellipsis)
   * and clipped inside the nav box or has collapsed into the `… ▾` rung —
   * never overflowing across the heading. No horizontal page overflow is
   * introduced at this width.
   *
   * Steps:
   * 1. Resolve the long-named window's id; set a 700×800 viewport; navigate
   *    to it.
   * 2. Assert the `Breadcrumb` nav and the `Rename tab <long>` heading are
   *    visible.
   * 3. Compute both bounding boxes and assert they do NOT intersect (the
   *    overlap regression assertion).
   * 4. If the min-useful-width collapse rung engaged (the `… ▾`
   *    `Switch location` trigger visible), that IS the no-fragment outcome —
   *    skip to step 5. Otherwise locate the session crumb — a
   *    NON-interactive static chip (a plain span carrying `truncate
   *    max-w-[16ch]` and the session name; the `Switch session` dropdown is
   *    gone), scoped to the `max-w-[16ch]` span so the off-screen collapse
   *    probe's `max-w-[6ch]` text twin can never answer the query — and
   *    assert `scrollWidth > clientWidth` on that chip (the name is
   *    truncated to an ellipsis) while its text content is still the full
   *    session name (the ellipsis is visual only).
   * 5. Assert the nav's computed `overflow-x` is `hidden` — the clip
   *    backstop is active, so content past the nav floor is clipped at the
   *    nav edge rather than painted over the heading (a clipped child
   *    legitimately keeps a layout box wider than its clipping parent, so
   *    the meaningful proof is the computed style + the no-overlap
   *    assertion in step 3, not a layout-box comparison).
   * 6. Assert `document.body.scrollWidth ≤ 700` (no horizontal page
   *    overflow).
   */
  test("at ~700px with long names the breadcrumb nav and center heading do NOT overlap; crumbs clip/ellipsis (no visible overflow)", async ({
    page,
  }) => {
    const id = await resolveWindow(page, LONG_WINDOW);
    await page.setViewportSize(MID_VIEWPORT);
    await gotoWindow(page, id);

    const nav = page.getByRole("navigation", { name: "Breadcrumb" });
    const heading = page.getByRole("button", {
      name: `Rename tab ${LONG_WINDOW}`,
    });
    await expect(nav).toBeVisible();
    await expect(heading).toBeVisible({ timeout: 10_000 });

    // The core regression assertion: the nav box and the heading box must not
    // intersect. Before the fix, the un-shrinkable crumbs overflowed the nav
    // box and painted straight over the centered heading (garbled overlap).
    const navBox = (await nav.boundingBox())!;
    const headingBox = (await heading.boundingBox())!;
    expect(navBox, "nav has a box").toBeTruthy();
    expect(headingBox, "heading has a box").toBeTruthy();
    expect(
      intersects(navBox, headingBox),
      `nav box ${JSON.stringify(navBox)} intersects heading box ${JSON.stringify(headingBox)}`,
    ).toBe(false);

    // Overflow is CLIPPED, not painted: the session crumb's NAME text is
    // truncated (ellipsis) yet its rendered box stays INSIDE the nav's box —
    // the `overflow-hidden` + `min-w-0`/`truncate` chain converted pressure
    // into clipping. The session crumb is `sm:flex` so it is present at 700px.
    // 260813-kvk7: the crumb is now a NON-interactive static chip (the session
    // dropdown is gone) — the chip span itself carries `truncate max-w-[16ch]`
    // and the session name as its text, so measure `scrollWidth > clientWidth`
    // directly on the chip (it sizes exactly to its capped content, so clipping
    // shows up as scroll overflow there). The query is scoped to the visible
    // `max-w-[16ch]` span: the collapse probe's off-screen `max-w-[6ch]` twin
    // (data-testid="crumb-collapse-probe", aria-hidden + inert) duplicates the
    // crumb text for measurement and must never satisfy — or trip — it.
    // If the min-useful-width collapse rung engaged at 700px instead (long
    // names can push 700px past the measured threshold), the collapsed `… ▾`
    // trigger replaces the chip — itself the no-fragment outcome.
    const sessionChip = nav.locator("span.max-w-\\[16ch\\]", { hasText: TEST_SESSION });
    const collapseTrigger = nav.getByRole("button", { name: "Switch location" });
    if (await collapseTrigger.isVisible()) {
      // Collapse rung engaged: no crumb fragment renders at all — the two
      // levels live in the trigger's menu (proven in crumb-collapse.spec.ts).
    } else {
      await expect(sessionChip).toBeVisible();
      const truncated = await sessionChip.evaluate(
        (el) => el.scrollWidth > el.clientWidth,
      );
      expect(
        truncated,
        "the long session crumb name is truncated (ellipsis), not shown at full width",
      ).toBe(true);
      // The full session name is still the text content (ellipsis is visual only).
      await expect(sessionChip).toHaveText(TEST_SESSION);
    }

    // The clip backstop is active: the nav carries `overflow: hidden`, so any
    // content whose LAYOUT box extends past the nav's floor is visually
    // clipped at the nav's edge rather than painted over the center heading.
    // (A clipped child legitimately keeps a layout box wider than its clipping
    // parent, so the meaningful proof is the computed style + the no-overlap
    // assertion above, not a layout-box comparison.)
    const navOverflow = await nav.evaluate(
      (el) => getComputedStyle(el).overflowX,
    );
    expect(navOverflow).toBe("hidden");

    // No horizontal PAGE overflow at 700px (the grid does not push the shell).
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(MID_VIEWPORT.width);
  });

  /**
   * Proves: the tunable-floor sweep — the explicit nav floor
   * (`min-w-[46px] sm:min-w-[150px]`) plus `overflow-hidden` holds the
   * no-overlap invariant across the entire responsive band, not just at
   * 700px, and no width in the band introduces horizontal page overflow.
   * This is the harness that would surface a bad floor value (overlap →
   * floor too small; page overflow at a benign width → floor too large).
   *
   * Steps:
   * 1. Resolve the long-named window's id; navigate to it.
   * 2. For each width in [375, 640, 700, 768, 1024], set a `<width>×800`
   *    viewport, wait for the heading, and assert: (a) if the nav has a
   *    box, it does NOT intersect the heading box; (b)
   *    `document.body.scrollWidth ≤ width` (no horizontal page overflow).
   */
  test("across the 375/640/700/768/1024 sweep the nav never overlaps the heading and the page never overflows horizontally", async ({
    page,
  }) => {
    // The intake's tunable-floor sweep (assumption #6): the explicit nav floor
    // (`min-w-[46px] sm:min-w-[150px]`) + `overflow-hidden` must hold the
    // no-overlap invariant across the whole band, not just at 700px. This is
    // the harness that would surface a bad floor value (overlap → too small;
    // page overflow at a benign width → too large).
    const id = await resolveWindow(page, LONG_WINDOW);
    await gotoWindow(page, id);

    const nav = page.getByRole("navigation", { name: "Breadcrumb" });
    const heading = page.getByRole("button", {
      name: `Rename tab ${LONG_WINDOW}`,
    });

    for (const width of [375, 640, 700, 768, 1024]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(heading).toBeVisible({ timeout: 10_000 });
      const navBox = await nav.boundingBox();
      const headingBox = (await heading.boundingBox())!;
      // The nav is present (and visible) at sm+; at 375 it may be a bare
      // brand sliver (the hamburger sits outside the nav, 260720-ap63), but
      // it must still never overlap the heading.
      if (navBox) {
        expect(
          intersects(navBox, headingBox),
          `overlap at ${width}px: nav ${JSON.stringify(navBox)} vs heading ${JSON.stringify(headingBox)}`,
        ).toBe(false);
      }
      const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
      expect(bodyWidth, `horizontal page overflow at ${width}px`).toBeLessThanOrEqual(
        width,
      );
    }
  });

  /**
   * Proves: the server-link crumb was demoted from `sm:` to `md:` — it is
   * hidden in the 640–768px band (where it is the redundant first-to-give
   * element) — and at `md+` the server level stays reachable: either as the
   * visible crumb link, or, when the min-useful-width collapse rung has
   * engaged under crumb-name pressure, inside the collapsed `… ▾` crumb (the
   * rung between truncation and the breakpoint hide).
   *
   * Steps:
   * 1. Resolve the long-named window's id. Locate the server crumb by its
   *    `href="/${server}"` scoped to the breadcrumb nav (its accessible
   *    name is the server text, so href disambiguates it from the brand
   *    link `/`); the collapsed crumb's trigger is the `Switch location`
   *    button.
   * 2. Set a 700px viewport; navigate; assert the nav is visible and the
   *    server crumb link is hidden (CSS-hidden via `hidden md:flex` when
   *    expanded, or replaced by the collapsed crumb — `toBeHidden` covers
   *    both).
   * 3. Set a 1024px viewport; assert the server crumb link OR the collapse
   *    trigger is visible (this rig's long server + session names can
   *    legitimately engage the collapse rung at 1024px).
   */
  test("the server crumb is hidden below `md` and the server level stays reachable at `md+`", async ({
    page,
  }) => {
    const id = await resolveWindow(page, LONG_WINDOW);
    // The server-link crumb is the left-nav <a href="/${server}"> (title
    // "Workspace"). Its accessible name is its text (the server name), so
    // target it by href scoped to the breadcrumb nav — that disambiguates it
    // from the brand link (href "/").
    const nav = page.getByRole("navigation", { name: "Breadcrumb" });
    const serverHref = `/${encodeURIComponent(TMUX_SERVER)}`;
    const serverCrumb = nav.locator(`a[href="${serverHref}"]`);
    const collapseTrigger = nav.getByRole("button", { name: "Switch location" });

    // Below `md` (700px, in the `sm`..`md` band): the crumb element is
    // CSS-hidden (`hidden md:flex`) when expanded, or absent when the
    // collapse rung replaced it — either way, not visible.
    await page.setViewportSize(MID_VIEWPORT);
    await gotoWindow(page, id);
    await expect(nav).toBeVisible();
    await expect(serverCrumb).toBeHidden();

    // At `md+` (1024px): the server level is reachable again — the crumb link
    // renders expanded, or the collapsed `… ▾` crumb carries it (this rig's
    // long names put 1024px right at the measured threshold).
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await expect(
      serverCrumb.or(collapseTrigger),
      "neither the server crumb link nor the collapsed … ▾ crumb rendered at md+",
    ).toBeVisible();
  });

  /**
   * Proves: the change does not regress the 375px mobile leaf — both crumbs
   * hide below `sm` (session `sm:flex`, server `md:flex`), leaving only the
   * brand + centered heading; the top bar stays a single line with no
   * horizontal page overflow (the layout the mobile budget already relied
   * on).
   *
   * Steps:
   * 1. Resolve the long-named window's id; set a 375×812 viewport; navigate
   *    (gating readiness on the heading, since the connection dot is
   *    `hidden sm:inline`).
   * 2. Assert the heading is visible.
   * 3. Assert the server crumb (`a[href="/${server}"]` in the nav), the
   *    session crumb (the static chip's VISIBLE `max-w-[16ch]` span — the
   *    collapse probe's off-screen text twin is excluded), and the
   *    collapsed `… ▾` trigger (`hidden sm:contents`-gated) are all hidden.
   * 4. Assert `document.body.scrollWidth ≤ 375` (no horizontal overflow).
   * 5. Assert the header's rendered height is under 56px (a wrap would
   *    roughly double the ~39px single-line chrome).
   */
  test("375px mobile leaf layout is unchanged (single line, no horizontal overflow, crumbs hidden)", async ({
    page,
  }) => {
    const id = await resolveWindow(page, LONG_WINDOW);
    await page.setViewportSize(MOBILE_VIEWPORT);
    // Gate readiness on the heading (the connection dot is `hidden sm:inline`).
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(id)}`);
    const heading = page.getByRole("button", {
      name: `Rename tab ${LONG_WINDOW}`,
    });
    await expect(heading).toBeVisible({ timeout: 10_000 });

    // Both crumbs hide below `sm` (session `sm:flex`, server `md:flex`), so the
    // mobile leaf is just brand + centered heading — the layout the mobile
    // budget already relied on, unchanged by this change. (260813-kvk7: the
    // session crumb is now a static chip — a plain span, no `Switch session`
    // button — but it rides the same `hidden sm:flex` wrapper.) The session
    // query is scoped to the visible `max-w-[16ch]` chip span: the collapse
    // probe's off-screen `max-w-[6ch]` twin duplicates the crumb text and
    // would otherwise trip strict mode. The collapsed `… ▾` trigger is
    // `hidden sm:contents`-gated, so it never renders here either.
    const nav = page.getByRole("navigation", { name: "Breadcrumb" });
    const serverHref = `/${encodeURIComponent(TMUX_SERVER)}`;
    await expect(nav.locator(`a[href="${serverHref}"]`)).toBeHidden();
    await expect(
      nav.locator("span.max-w-\\[16ch\\]", { hasText: TEST_SESSION }),
    ).toBeHidden();
    await expect(
      nav.getByRole("button", { name: "Switch location" }),
    ).toBeHidden();

    // No horizontal page overflow, and the header stays a single line (a wrap
    // would roughly double the ~39px chrome height).
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
    const box = await page.locator("header").first().boundingBox();
    expect(box).toBeTruthy();
    expect(box!.height).toBeLessThan(56);
  });

  /**
   * Proves: at desktop width the fix introduces no regression — the nav and
   * heading boxes still do not intersect, and the `sm:min-w-[28ch]` center
   * anchor was NOT demoted to `md:` (it still reserves its width, so the
   * heading's left edge stays anchored).
   *
   * Steps:
   * 1. Resolve the long-named window's id; set a 1024×800 viewport;
   *    navigate.
   * 2. Assert the nav and heading are visible; assert their boxes do NOT
   *    intersect (desktop sanity, no regression while solving the mid-width
   *    band).
   * 3. Query the anchored inner center box (the `div.sm:min-w-[28ch]`
   *    element) and assert its rendered width exceeds a conservative slack
   *    floor (>180px) — proving the `sm:` anchor is present and reserving
   *    width (not dropped to `md:`).
   */
  test("1024px+ has no regression: nav and heading do not overlap and the `sm:min-w-[28ch]` center anchor is intact", async ({
    page,
  }) => {
    const id = await resolveWindow(page, LONG_WINDOW);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await gotoWindow(page, id);

    const nav = page.getByRole("navigation", { name: "Breadcrumb" });
    const heading = page.getByRole("button", {
      name: `Rename tab ${LONG_WINDOW}`,
    });
    await expect(nav).toBeVisible();
    await expect(heading).toBeVisible({ timeout: 10_000 });

    // No overlap at desktop either (sanity: the fix does not introduce a
    // desktop regression while solving the mid-width band).
    const navBox = (await nav.boundingBox())!;
    const headingBox = (await heading.boundingBox())!;
    expect(intersects(navBox, headingBox)).toBe(false);

    // The center anchor stays at `sm:` (NOT demoted to `md:`): the inner center
    // box still reserves >= 28ch, so the heading's rendered width clears a
    // conservative 28ch floor (28ch ~ 224px at a 8px/ch monospace baseline; use
    // a slack floor to avoid font-metric brittleness while still proving the
    // anchor was not dropped).
    const anchorWidth = await page
      .locator("header")
      .first()
      .evaluate((headerEl) => {
        // The anchored inner box is the flex container reserving sm:min-w-[28ch].
        const box = headerEl.querySelector<HTMLElement>(
          "div.sm\\:min-w-\\[28ch\\]",
        );
        return box ? box.getBoundingClientRect().width : 0;
      });
    expect(
      anchorWidth,
      "the sm:min-w-[28ch] center anchor is present and reserves width at desktop",
    ).toBeGreaterThan(180);
  });

  // (The R2a session-switcher dropdown guard that used to live here was removed
  // with the dropdown itself in 260813-kvk7 — the session crumb is now a static
  // chip, so the nav's clip context has no open menu left to swallow.)
});
