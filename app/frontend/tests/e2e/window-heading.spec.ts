/**
 * Window heading e2e: the universal, centered top-bar page heading — the
 * current tmux window name is the prominent centered identity on the Terminal
 * route (prefixed by the static `Tab:`), renaming happens in place (click →
 * inline input, Enter/blur commit, Escape cancel), the command-palette rename
 * path enters the same inline edit, the 375px bar stays single-line, the
 * hover-animation vocabulary classes are present and CSS-gated under
 * `prefers-reduced-motion`, and the same centered heading fills the tmux
 * Server (`Workspace: <server>`, display-only), the Board (`Board: <name>`
 * + relocated ▾ switcher, display-only) and the Host (solo `Host`) routes.
 *
 * Shared setup: a FILE-LEVEL `beforeAll` creates a dedicated tmux session
 * (`e2e-heading-<ts>`) on the isolated test server so this file never
 * collides with other specs; file-level `afterAll` kills it. The hooks sit
 * OUTSIDE the describe blocks because the file has two motion postures: the
 * default block inherits the global `reducedMotion: "reduce"` emulation from
 * `playwright.config.ts`, and the animated-path block opts back into motion
 * with `test.use({ contextOptions: { reducedMotion: "no-preference" } })`.
 * `resolveWindow(page, name)` polls `GET /api/sessions` until the CLI-created
 * window surfaces in the backend snapshot, returning its stable `@N` id (the
 * handle for the terminal route and the `Rename tab <name>` heading label);
 * `gotoWindow(page, id)` navigates to `/${server}/${encodedId}` and waits for
 * the `Connected` indicator. Both are thin file-local wrappers over the
 * shared, parameterized helpers in `tests/e2e/_ready.ts`. The centered
 * heading is a `<button aria-label="Rename tab <name>">`; its inline editor
 * is an `<input aria-label="Tab name">`.
 */
import { test, expect } from "@playwright/test";
import { gotoServerReady, resolveWindow as resolveWindowRaw, gotoWindow as gotoWindowRaw } from "./_ready";
import { TMUX_SERVER, createSession, killSession, newWindow } from "./_tmux";

// Own session so this file never collides with other specs (fullyParallel off).
const TEST_SESSION = `e2e-heading-${Date.now()}`;
// Board name for the board-mode centered-heading test (alphanumeric only).
const BOARD_NAME = `head${Date.now().toString().slice(-6)}`;
const MOBILE_VIEWPORT = { width: 375, height: 812 };

// Shared readiness helpers (hoisted to `_ready.ts`) bound to this file's server
// + session so existing call sites keep their two-arg shape.
const resolveWindow = async (page: Parameters<typeof resolveWindowRaw>[0], windowName: string) =>
  (await resolveWindowRaw(page, TMUX_SERVER, TEST_SESSION, windowName)).windowId;
const gotoWindow = (page: Parameters<typeof gotoWindowRaw>[0], windowId: string) =>
  gotoWindowRaw(page, TMUX_SERVER, windowId);

// File-level session lifecycle: shared by BOTH describe blocks below (the
// reduced-motion default block and the animated-path opt-in block), so the
// teardown must not run between them.
test.beforeAll(() => {
  createSession(TEST_SESSION);
});

test.afterAll(() => {
  killSession(TEST_SESSION);
});

test.describe("Window heading (centered, editable) + hover vocabulary", () => {
  /**
   * Proves: on a Terminal route the window name renders once, as the centered
   * click-to-rename heading — NOT as a trailing breadcrumb crumb (the
   * breadcrumb ends at the session) — at BOTH desktop rungs: md–lg carries
   * the full heading with the static `Tab:` prefix visible as a sibling span;
   * ≥ lg carries the compact heading (prefix hidden) beside the standing
   * quake launcher, with rename intact.
   *
   * Steps:
   * 1. Create a window with a known name; resolve its `@N` id.
   * 2. At an md–lg viewport (900px), navigate to it; assert the `Rename tab
   *    <name>` button is visible and its text equals the window name, the
   *    `Breadcrumb` nav does NOT contain the name, and the static `Tab:`
   *    prefix is visible as a contiguous run NOT contained inside the rename
   *    button — it is a sibling span, so clicking it never starts an edit.
   * 3. Click the heading; assert the inline editor opens; cancel with Escape.
   * 4. Resize to ≥ lg (1280px); assert the prefix is hidden, the standing
   *    quake launcher renders, and the rename click + Escape still work.
   */
  test("renders the current window name as the centered click-to-rename heading", async ({
    page,
  }) => {
    const name = `head-render-${Date.now()}`;
    newWindow(TEST_SESSION, name);
    const id = await resolveWindow(page, name);

    // md–lg rung (explicit viewport below lg): the full heading — the static
    // `Tab:` page-type prefix (260714-uco1 — replaced the retired
    // lens-following `Terminal:`/`Web:`/`Chat:` prefix) renders as a static
    // sibling OUTSIDE the rename button (clicking it must not edit). The
    // hierarchy ▾ that used to split the prefix is GONE (260813-kvk7) — the
    // colon is contiguous to the word (`Tab:`), so the whole prefix run is
    // the stable locator.
    await page.setViewportSize({ width: 900, height: 800 });
    await gotoWindow(page, id);

    const heading = page.getByRole("button", { name: `Rename tab ${name}` });
    await expect(heading).toBeVisible({ timeout: 10_000 });
    await expect(heading).toHaveText(name);
    // The window name is NOT duplicated as a breadcrumb crumb.
    const nav = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(nav).not.toContainText(name);
    const prefix = page.getByText("Tab:", { exact: true });
    await expect(prefix).toBeVisible();
    const prefixInButton = await heading.evaluate(
      (btn, pfx) => btn.contains(pfx),
      await prefix.elementHandle(),
    );
    expect(prefixInButton).toBe(false);
    // Rename entry is alive at this rung: click → inline editor; Escape cancels.
    await heading.click();
    await expect(page.getByRole("textbox", { name: "Tab name" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(heading).toBeVisible();

    // ≥ lg rung: the compact heading — the prefix span hides and the standing
    // quake launcher renders beside `{name} ▾`; the rename click is untouched.
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(prefix).toBeHidden();
    await expect(page.getByTestId("quake-launcher-input")).toBeVisible();
    await expect(heading).toBeVisible();
    await expect(heading).toHaveText(name);
    await heading.click();
    await expect(page.getByRole("textbox", { name: "Tab name" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(heading).toBeVisible();
  });

  /**
   * Proves: the centered heading is never hidden by the quake machine —
   * opening the quake terminal (⇧Ctrl+J here) leaves the `Tab: <name>`
   * heading visible at BOTH desktop rungs (the launcher collapses to its
   * glyph + chord control instead of taking the heading's cell; the ≥lg
   * prefix compaction is unchanged).
   *
   * Steps:
   * 1. Create a window with a known name; resolve its `@N` id.
   * 2. At an md–lg viewport (900px), navigate to it; press the quake chord;
   *    assert the drawer is visible and both the `Tab:` prefix and the
   *    `Rename tab <name>` heading stay visible.
   * 3. Close with the chord; resize to ≥ lg (1280px); press the chord again;
   *    assert the drawer is visible, the collapsed launcher renders, the
   *    heading stays visible, and the `Tab:` prefix stays hidden (the ≥lg
   *    compaction, same as at rest).
   */
  test("the heading stays visible with the quake terminal open at both desktop rungs", async ({
    page,
  }) => {
    const name = `head-quake-${Date.now()}`;
    newWindow(TEST_SESSION, name);
    const id = await resolveWindow(page, name);

    // md–lg rung: the full heading (prefix included) beside the collapsed
    // launcher while the drawer is open.
    await page.setViewportSize({ width: 900, height: 800 });
    await gotoWindow(page, id);
    const heading = page.getByRole("button", { name: `Rename tab ${name}` });
    await expect(heading).toBeVisible({ timeout: 10_000 });

    await page.keyboard.press("Shift+Control+j");
    await expect(page.getByTestId("quake-terminal")).toBeVisible();
    await expect(page.getByTestId("quake-launcher-collapsed")).toBeVisible();
    await expect(page.getByText("Tab:", { exact: true })).toBeVisible();
    await expect(heading).toBeVisible();

    // ≥ lg rung: the compact heading (prefix hidden, as at rest) beside the
    // collapsed launcher while the drawer is open.
    await page.keyboard.press("Shift+Control+j");
    await expect(page.getByTestId("quake-terminal")).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.keyboard.press("Shift+Control+j");
    await expect(page.getByTestId("quake-terminal")).toBeVisible();
    await expect(page.getByTestId("quake-launcher-collapsed")).toBeVisible();
    await expect(page.getByText("Tab:", { exact: true })).toBeHidden();
    await expect(heading).toBeVisible();
  });

  /**
   * Proves: move-don't-copy — on the Workspace page (`/$server`, no window)
   * the server name is the CENTERED `Workspace: <server>` heading,
   * display-only (no rename), and is NOT duplicated as a left breadcrumb leaf
   * crumb — the left breadcrumb ends at its parent. The page also carries an
   * in-page long-form `Workspace Overview` `<h2>` SectionHeading above its
   * "Sessions" section.
   *
   * Steps:
   * 1. Navigate to `/${server}`.
   * 2. Assert the `Workspace <server>` heading (its accessible name carries
   *    the type prefix) is visible.
   * 3. Assert there is no `Rename tab …` button (the server name is
   *    display-only).
   * 4. Assert the in-page `Workspace Overview` `<h2>` heading is visible.
   * 5. Assert the `Breadcrumb` nav does NOT contain the server name.
   */
  test("server route (/$server) shows the centered `Workspace: <server>` heading + the `Workspace Overview` in-page heading (not a left leaf crumb)", async ({
    page,
  }) => {
    await page.goto(`/${TMUX_SERVER}`);
    // The server name is the CENTERED heading leaf (move-don't-copy) — its
    // accessible name carries the `Workspace` type prefix.
    const heading = page.getByLabel(`Workspace ${TMUX_SERVER}`);
    await expect(heading).toBeVisible({ timeout: 10_000 });
    // It is display-only — no rename button on the Workspace page.
    await expect(
      page.getByRole("button", { name: /Rename tab/ }),
    ).toHaveCount(0);
    // The in-page page-level heading (260715-zs1y) — a SectionHeading <h2>
    // above the "Sessions" section.
    await expect(
      page.getByRole("heading", { level: 2, name: "Workspace Overview" }),
    ).toBeVisible();
    // The name is not duplicated as a left breadcrumb crumb.
    const nav = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(nav).not.toContainText(TMUX_SERVER);
  });

  /**
   * Proves: the Host `/` carries the solo `Host` center heading (no prefix,
   * no instance name) in the top bar; the old in-page PageHeading `<h1>` row
   * is gone; the page carries an in-page long-form `Host Overview` `<h2>`
   * SectionHeading above the HOST HEALTH zone; and the bracket idiom lives on
   * the zone `<h2>` section headings (brackets `[`/`]` + reserved `▊` caret
   * cell around a TypedLabel).
   *
   * Steps:
   * 1. Navigate to `/`.
   * 2. Assert the solo `Host` heading is visible.
   * 3. Assert there is no `<h1>` on the page (the PageHeading row was
   *    removed).
   * 4. Assert the in-page `Host Overview` `<h2>` heading is visible.
   * 5. Locate the `Host Health` `<h2>` section heading; assert its enclosing
   *    `.rk-bracket-group` carries the `[`/`]` bracket spans, a reserved
   *    `.rk-bracket-caret` cell, and a `.rk-typed-label` whose text is the
   *    label.
   */
  test("host route (/) shows the solo `Host` center heading, the `Host Overview` in-page heading, and bracket section headings", async ({
    page,
  }) => {
    await page.goto("/");
    // Solo type word — no prefix, no instance name. `exact` scopes to the
    // top-bar heading (aria-label "Host") and not the `Host health` section
    // region or the `Host Overview`/`Host Health` headings (substring matches).
    await expect(page.getByLabel("Host", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    // The in-page PageHeading `<h1>` row is gone; page identity is the top bar.
    await expect(page.locator("h1")).toHaveCount(0);
    // The in-page page-level heading (260715-zs1y) — a SectionHeading <h2>
    // above the HOST HEALTH zone.
    await expect(
      page.getByRole("heading", { level: 2, name: "Host Overview" }),
    ).toBeVisible();
    // The four zone labels render as bracket section headings (<h2>), each with
    // the reserved caret cell and brackets around a TypedLabel.
    const hostHealth = page.getByRole("heading", { level: 2, name: "Host Health" });
    await expect(hostHealth).toBeVisible();
    // The bracket idiom: `[`/`]` + reserved `▊` caret sit around the label.
    const group = page
      .locator(".rk-bracket-group", { has: hostHealth })
      .first();
    await expect(group.locator(".rk-bracket-open")).toHaveText("[");
    await expect(group.locator(".rk-bracket-close")).toHaveText("]");
    await expect(group.locator(".rk-bracket-caret")).toBeAttached();
    await expect(group.locator(".rk-typed-label")).toHaveText("Host Health");
  });

  /**
   * Proves: move-don't-copy — on a board route (`/board/$name`) the board
   * name is the CENTERED `Board: <name>` heading with the ▾ board switcher
   * relocated beside it (moved out of the left breadcrumb), display-only (no
   * rename — boards have no rename API), and neither the board name nor the
   * old left `Board ▸` home button appears in the left breadcrumb.
   *
   * Steps:
   * 1. Create a window, pin it to a board via `POST /api/boards/<board>/pin`
   *    (the deterministic API seam), then navigate to `/board/<board>`.
   * 2. Assert the `Board <name>` heading (its accessible name carries the
   *    type prefix) is visible.
   * 3. Assert the relocated ▾ board switcher (`Switch board`) is visible
   *    beside it.
   * 4. Assert there is no `Rename tab …` button (the board name is
   *    display-only).
   * 5. Assert the `Breadcrumb` nav does NOT contain the board name and does
   *    NOT contain the old left `Board ▸` home button (move-don't-copy).
   * 6. Cleanup: unpin the window via `POST /api/boards/<board>/unpin` so the
   *    empty board disappears and the shared server stays clean (`finally`).
   */
  test("board route shows the centered `Board: <name>` heading + relocated ▾ switcher (name display-only, no left `Board ▸`)", async ({
    page,
  }) => {
    // A board needs a pinned window. Create one, pin it via the API (the same
    // deterministic seam boards-pin-flow.spec.ts uses), then navigate.
    const name = `head-board-${Date.now()}`;
    newWindow(TEST_SESSION, name);
    const winId = await resolveWindow(page, name);

    const pinRes = await page.request.post(`/api/boards/${BOARD_NAME}/pin`, {
      data: { server: TMUX_SERVER, windowId: winId },
    });
    expect(pinRes.ok()).toBeTruthy();

    try {
      await page.goto(`/board/${BOARD_NAME}`, { waitUntil: "domcontentloaded" });

      // The board name is the CENTERED heading leaf (move-don't-copy) — its
      // accessible name carries the `Board` type prefix.
      const heading = page.getByLabel(`Board ${BOARD_NAME}`);
      await expect(heading).toBeVisible({ timeout: 10_000 });
      // The ▾ board switcher relocated from the left breadcrumb to the center,
      // beside the board name.
      await expect(page.getByLabel("Switch board")).toBeVisible();
      // Display-only — boards have no rename API, so no rename button.
      await expect(
        page.getByRole("button", { name: /Rename tab/ }),
      ).toHaveCount(0);
      // Move-don't-copy: the board name is not duplicated as a left breadcrumb
      // crumb, and the old left `Board ▸` home button is gone.
      const nav = page.getByRole("navigation", { name: "Breadcrumb" });
      await expect(nav).not.toContainText(BOARD_NAME);
      await expect(nav).not.toContainText("Board ▸");
    } finally {
      // Unpin so the (empty) board disappears — keep the shared server clean.
      await page.request.post(`/api/boards/${BOARD_NAME}/unpin`, {
        data: { server: TMUX_SERVER, windowId: winId },
      });
    }
  });

  /**
   * Proves: clicking the heading opens an inline input; typing a new name and
   * pressing Enter commits via the rename API, and both the sidebar and the
   * heading reflect the new name.
   *
   * Steps:
   * 1. Create + navigate to a window.
   * 2. Click the heading; assert the `Tab name` input appears.
   * 3. Fill a new name and press Enter.
   * 4. Assert the sidebar shows the new name (rename API + SSE round-trip).
   * 5. Assert the heading button now carries the new name.
   */
  test("click name → inline input → type + Enter commits the rename", async ({
    page,
  }) => {
    const name = `head-edit-${Date.now()}`;
    const renamed = `head-renamed-${Date.now()}`;
    newWindow(TEST_SESSION, name);
    const id = await resolveWindow(page, name);
    await gotoWindow(page, id);

    await page.getByRole("button", { name: `Rename tab ${name}` }).click();
    const input = page.getByRole("textbox", { name: "Tab name" });
    await expect(input).toBeVisible();
    await input.fill(renamed);
    await input.press("Enter");

    // Sidebar reflects the committed name (via the rename API + SSE). The name
    // can appear in more than one place (window row + pane-panel echo), so
    // assert the first match rather than the whole set.
    const sidebar = page.locator("nav[aria-label='Groups']");
    await expect(sidebar.locator(`text=${renamed}`).first()).toBeVisible({
      timeout: 10_000,
    });
    // Heading shows the new name (decode may briefly scramble, so poll).
    await expect(
      page.getByRole("button", { name: `Rename tab ${renamed}` }),
    ).toBeVisible({ timeout: 10_000 });
  });

  /**
   * Proves: the live safe-name conversion — the inline window-name input
   * converts unsafe characters AS THE USER TYPES (a pressed space appears as
   * `_`; hyphens kept) — so the input is WYSIWYG and the committed name is
   * exactly the displayed one.
   *
   * Steps:
   * 1. Create + navigate to a window; click the heading to open the inline
   *    edit.
   * 2. Clear the input, then type `my problem` character-by-character
   *    (`pressSequentially` — real keystrokes, so each `onChange` runs the
   *    live transform).
   * 3. Assert the input value is `my_problem` (the space never appears).
   * 4. Press Enter; assert the sidebar shows `my_problem` (rename API + SSE
   *    round-trip) and the heading button carries the converted name.
   */
  test("typing a space live-converts to underscore and commits the safe name", async ({
    page,
  }) => {
    const name = `head-safe-${Date.now()}`;
    newWindow(TEST_SESSION, name);
    const id = await resolveWindow(page, name);
    await gotoWindow(page, id);

    await page.getByRole("button", { name: `Rename tab ${name}` }).click();
    const input = page.getByRole("textbox", { name: "Tab name" });
    await expect(input).toBeVisible();
    // Type character-by-character: the live safe-name transform (260722-ln4n)
    // converts the pressed space to "_" as it lands — WYSIWYG, the input never
    // shows a space.
    await input.fill("");
    await input.pressSequentially("my problem");
    await expect(input).toHaveValue("my_problem");
    await input.press("Enter");

    // The committed name is exactly the displayed (converted) name.
    const sidebar = page.locator("nav[aria-label='Groups']");
    await expect(sidebar.locator("text=my_problem").first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole("button", { name: "Rename tab my_problem" }),
    ).toBeVisible({ timeout: 10_000 });
  });

  /**
   * Proves: Escape abandons the edit — no rename call, original name
   * restored.
   *
   * Steps:
   * 1. Create + navigate to a window; open the inline edit.
   * 2. Type a throwaway value and press Escape.
   * 3. Assert the input is gone and the original-name heading is back.
   * 4. Re-resolve the window by its original name and assert its id is
   *    unchanged (proving no rename happened).
   */
  test("Escape cancels the edit and restores the original name", async ({
    page,
  }) => {
    const name = `head-escape-${Date.now()}`;
    newWindow(TEST_SESSION, name);
    const id = await resolveWindow(page, name);
    await gotoWindow(page, id);

    await page.getByRole("button", { name: `Rename tab ${name}` }).click();
    const input = page.getByRole("textbox", { name: "Tab name" });
    await input.fill("discard-me");
    await input.press("Escape");

    await expect(input).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: `Rename tab ${name}` }),
    ).toBeVisible();
    // No rename happened — the window keeps its name in the snapshot.
    const stillNamed = await resolveWindow(page, name);
    expect(stillNamed).toBe(id);
  });

  /**
   * Proves: the keyboard/command-palette rename path (Constitution V) enters
   * the SAME inline edit. The palette action dispatches a
   * `window-heading:rename` CustomEvent; asserting that event wiring is the
   * stable seam (palette-item selection itself is covered by command-palette
   * unit tests).
   *
   * Steps:
   * 1. Create + navigate to a window; confirm the heading is visible.
   * 2. `page.evaluate` dispatches `new CustomEvent("window-heading:rename")`.
   * 3. Assert the `Tab name` input appears (inline edit engaged).
   */
  test("command-palette rename path enters inline edit (CustomEvent wiring)", async ({
    page,
  }) => {
    const name = `head-palette-${Date.now()}`;
    newWindow(TEST_SESSION, name);
    const id = await resolveWindow(page, name);
    await gotoWindow(page, id);
    await expect(
      page.getByRole("button", { name: `Rename tab ${name}` }),
    ).toBeVisible({ timeout: 10_000 });

    // The palette action dispatches this exact event (app.tsx); asserting the
    // event wiring is the stable seam (palette-item selection is covered by
    // command-palette unit tests).
    await page.evaluate(() =>
      document.dispatchEvent(new CustomEvent("window-heading:rename")),
    );
    await expect(page.getByRole("textbox", { name: "Tab name" })).toBeVisible();
  });

  /**
   * Proves: with the centered heading present and a long window name, the
   * 375px top bar stays single-line and introduces no horizontal page
   * overflow (the name truncates in the center cell).
   *
   * Steps:
   * 1. Create a window with a deliberately long name; resolve its id.
   * 2. Set a 375×812 viewport; navigate to the window.
   * 3. Assert the heading is visible.
   * 4. Assert `document.body.scrollWidth ≤ 375` (no horizontal overflow).
   * 5. Assert the header's rendered height is under one-and-a-half lines of
   *    chrome (a wrap would roughly double it).
   * 6. Assert truncation is left-anchored, not center-clipped: the name lives
   *    in an inner `truncate` span whose bounding box fits inside the
   *    button's box (with `truncate` on the flex button itself, the text box
   *    overhung both ends, cutting the head of the name with no ellipsis),
   *    and the span still carries the full name as text (the ellipsis is
   *    visual only).
   */
  test("375px top bar stays single-line with the heading (no horizontal overflow)", async ({
    page,
  }) => {
    const name = `head-verylongwindownamethatwouldwrap-${Date.now()}`;
    newWindow(TEST_SESSION, name);
    const id = await resolveWindow(page, name);
    await page.setViewportSize(MOBILE_VIEWPORT);
    // Gate readiness on the heading itself: the connection dot is `hidden
    // sm:inline`, so it is invisible at 375px and can't be the readiness signal.
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(id)}`);

    const heading = page.getByRole("button", { name: `Rename tab ${name}` });
    await expect(heading).toBeVisible({ timeout: 10_000 });

    // No horizontal page overflow.
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);

    // The header row is a single line: its rendered height stays close to one
    // line of chrome (~39px: py-2 + one text line + 3px bottom border). A wrap
    // would roughly double it, so a sub-56px height proves no wrap.
    const header = page.locator("header").first();
    const box = await header.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.height).toBeLessThan(56);

    // Truncation is left-anchored, not center-clipped: the name lives in an
    // inner `truncate` span whose box must fit INSIDE the button. Under the
    // old center-clip bug (truncate on the flex button itself), the text box
    // was wider than the button and overhung BOTH ends — the head of the name
    // was cut and no ellipsis rendered (riff-blustery-whale → "iff-…-whal").
    const nameSpan = heading.locator("span").first();
    const headingBox = (await heading.boundingBox())!;
    const spanBox = (await nameSpan.boundingBox())!;
    expect(spanBox.x).toBeGreaterThanOrEqual(headingBox.x - 1);
    expect(spanBox.x + spanBox.width).toBeLessThanOrEqual(
      headingBox.x + headingBox.width + 1,
    );
    // The full name is still the accessible text (ellipsis is visual only).
    await expect(nameSpan).toHaveText(name);
  });

  /**
   * Proves: the hover-animation vocabulary is wired via shared classes
   * (`rk-brand-glitch`, `rk-glint`, …) — class presence is the stable seam
   * for CSS animations (no pixel assertions). The `prefers-reduced-motion`
   * gate is a CSS `@media` rule that zeroes the animation, so the
   * elements/classes are unchanged under reduced motion; and the decode is
   * skipped in JS so the rename input never shows scrambled text.
   *
   * Steps:
   * 1. Create + navigate to a window; confirm the heading is visible.
   * 2. Assert `.rk-brand-glitch` and `.rk-glint` elements are attached.
   * 3. Open a second context with `reducedMotion: "reduce"`, navigate to the
   *    same window, and assert `.rk-glint` is still attached.
   * 4. In the reduced-motion context, click the heading and assert the inline
   *    input value equals the real window name (no scrambled text leaks into
   *    edit).
   * 5. Still in the reduced context, dispatch `pointerover` on a sidebar
   *    section label (a dispatched event makes this a TRUE negative — the
   *    handler ran and declined) and wait longer than one full sweep
   *    (~450ms): assert no `.rk-typed-cursor` cell appears and the label
   *    never gains `rk-typed-done` — the typed sweep is JS-gated on the same
   *    media query, and the rest state IS the reduced-motion state.
   */
  test("hover treatments carry their classes; a reduced-motion context still renders them (gate is CSS-only)", async ({
    page,
    browser,
  }) => {
    const name = `head-motion-${Date.now()}`;
    newWindow(TEST_SESSION, name);
    const id = await resolveWindow(page, name);
    await gotoWindow(page, id);
    await expect(
      page.getByRole("button", { name: `Rename tab ${name}` }),
    ).toBeVisible({ timeout: 10_000 });

    // Vocabulary classes are present in the DOM (class-presence is the stable
    // seam for CSS animations — no pixel assertions).
    await expect(page.locator(".rk-brand-glitch").first()).toBeAttached();
    await expect(page.locator(".rk-glint").first()).toBeAttached();

    // Under prefers-reduced-motion the classes stay (the gate is a CSS
    // @media rule that zeroes the animation — the elements are unchanged).
    const reducedCtx = await browser.newContext({ reducedMotion: "reduce" });
    const reducedPage = await reducedCtx.newPage();
    await gotoWindow(reducedPage, id);
    await expect(reducedPage.locator(".rk-glint").first()).toBeAttached();
    // The heading input never leaks scrambled text: opening edit shows the
    // real name even in reduced-motion (decode is skipped in JS).
    await reducedPage
      .getByRole("button", { name: `Rename tab ${name}` })
      .click();
    await expect(
      reducedPage.getByRole("textbox", { name: "Tab name" }),
    ).toHaveValue(name);

    // The typed-label sweep is JS-gated on the same media query: hovering a
    // section label in the reduced context must never start a sweep (no
    // cursor cell, no bright done state) — the rest state IS the reduced
    // state.
    const reducedLabel = reducedPage
      .locator("nav[aria-label='Groups'] .rk-typed-label", {
        hasText: /^Groups$/,
      })
      .first();
    // Dispatched event (not real hover) — same churn-proof seam as the
    // animated-path test; a dispatched enter makes this a TRUE negative
    // (the handler ran and declined) rather than a possibly-missed hover.
    await reducedLabel.dispatchEvent("pointerover");
    await reducedPage.waitForTimeout(450); // longer than one full ~350ms pass
    await expect(reducedLabel.locator(".rk-typed-cursor")).not.toBeAttached();
    await expect(reducedLabel).not.toHaveClass(/rk-typed-done/);

    await reducedCtx.close();
  });
});

/**
 * Top-bar heading anchor + nav block (260714-uco1). Covers the center-heading
 * sub-features: (1) the stable left anchor (min-width, left content) so the
 * heading's left edge does not drift with name length; (2) the static `Window:`
 * prefix persisting across a lens switch — contiguous since 260813-kvk7 removed
 * the ancestor hierarchy dropdown that used to split it (ancestor navigation
 * survives only in the command palette's `Go: Workspace` / `Go: Host` and the
 * left breadcrumb's server crumb); (3) the browser-history ◀ ▶ arrows — which
 * moved to the LEFT cluster (right of the sidebar toggle, `lg+` viewports —
 * below `lg` they hide with the cluster's degradation ladder) in 260731-oiho;
 * their BEHAVIOR (browser history, `Go back`/`Go forward` accessible names) is
 * unchanged, and the anchor no longer carries any arrow furniture (the old
 * `mr-2.5`/`-mr-1` width-compensation hack is gone). The arrows tests run at
 * the default 1280px viewport (≥ lg). Uses the file-level session lifecycle
 * above.
 */
test.describe("Top-bar heading — anchor + history arrows (260714-uco1)", () => {
  /**
   * Proves: the stable left anchor — the center heading's inner container
   * carries a `sm:`-gated min-width (~28ch) with left-aligned content, so for
   * names WITHIN that reserved band the heading's left edge stays put as the
   * name grows/shrinks (it no longer recenters with name length). Names
   * longer than the band grow rightward and the centered box drifts — an
   * accepted tradeoff — so the test deliberately exercises the band, not
   * arbitrarily long names. Measured at the md–lg rung: at ≥ lg the prefix
   * span hides (the compact heading + standing quake launcher take over), so the
   * prefix-left-edge probe only exists below lg.
   *
   * Steps:
   * 1. Create two windows in the same session with different (band-fitting)
   *    name lengths.
   * 2. Set an md–lg viewport (900px) so the `sm:` min-width anchor is active
   *    AND the prefix span still renders (it hides at ≥ lg).
   * 3. Navigate to the shorter-named window; record the `Tab:` prefix run's
   *    left x (the leftmost prefix text — the anchor under test).
   * 4. Navigate to the longer-named window; record the prefix run's left x.
   * 5. Assert the two x values differ by ≤2px (the anchor held; no drift).
   */
  test("the heading's left edge does not drift as the window name length changes within the anchor band (sm+)", async ({
    page,
  }) => {
    // Two windows whose `Window: <name>` fits WITHIN the reserved min-width
    // band (~28ch incl. the 8ch `Window: ` prefix), differing in name length.
    // The heading is left-anchored (sm:min-w + left content), so within the
    // band the prefix's left edge stays put — it no longer recenters with the
    // name. (Names LONGER than the band grow rightward and the centered box
    // drifts — an accepted tradeoff, intake #1 — so this asserts the band, not
    // arbitrarily long names.)
    const shortName = `hx-a${Date.now().toString().slice(-3)}`; // ~7 chars
    const midName = `hx-bcd-${Date.now().toString().slice(-4)}`; // ~11 chars
    newWindow(TEST_SESSION, shortName);
    newWindow(TEST_SESSION, midName);
    const shortId = await resolveWindow(page, shortName);
    const midId = await resolveWindow(page, midName);

    // md–lg viewport: the sm:min-width anchor is active AND the prefix span
    // still renders (at ≥ lg the compact heading hides it, so the probe is
    // re-anchored to this rung's geometry).
    await page.setViewportSize({ width: 900, height: 800 });

    // The prefix run ("Window:" — contiguous since the hierarchy ▾ was removed
    // in 260813-kvk7) is the heading's leftmost text; its left edge is the
    // anchor under test.
    await gotoWindow(page, shortId);
    const shortPrefix = page.getByText("Tab:", { exact: true });
    await expect(shortPrefix).toBeVisible({ timeout: 10_000 });
    const shortX = (await shortPrefix.boundingBox())!.x;

    await gotoWindow(page, midId);
    const midPrefix = page.getByText("Tab:", { exact: true });
    await expect(midPrefix).toBeVisible({ timeout: 10_000 });
    const midX = (await midPrefix.boundingBox())!.x;

    // The prefix's left edge is pinned by the min-width container — within the
    // band it must not jump as the name grows (allow a small sub-pixel margin).
    expect(Math.abs(midX - shortX)).toBeLessThanOrEqual(2);
  });

  /**
   * Proves: the terminal-route heading prefix is a static, contiguous `Tab:`
   * run — never the retired lens-following `Terminal:`/`Web:`/`Chat:` prefix —
   * visible at the md–lg rung and hidden at ≥ lg (the compact heading +
   * standing quake launcher render there) — and the hierarchy dropdown that used to
   * split the prefix is gone, leaving the window switcher as the heading's
   * single ▾ at BOTH rungs.
   *
   * Steps:
   * 1. Create a plain window; navigate to it at an md–lg viewport (900px).
   * 2. Assert the contiguous `Tab:` prefix run is visible (the hierarchy ▾ no
   *    longer splits it) and that no `Terminal:`/`Web:`/`Chat:` text is
   *    present.
   * 3. Assert no `Switch hierarchy` trigger exists; click the `Switch tab` ▾
   *    and assert its menu lists the current window (the session's windows,
   *    not the ancestor chain); close with Escape.
   * 4. Resize to ≥ lg (1280px); assert the prefix is hidden and the standing
   *    quake launcher renders; open the `Switch tab` ▾ again and assert the menu
   *    still lists the current window.
   */
  test("the heading prefix is a static `Window:` on the terminal route (all lenses), with a single ▾ window switcher", async ({
    page,
  }) => {
    const name = `hx-prefix-${Date.now()}`;
    newWindow(TEST_SESSION, name);
    const id = await resolveWindow(page, name);

    // md–lg rung (explicit viewport below lg): the full heading with the
    // static prefix. Static `Tab:` — never the retired
    // `Terminal:`/`Web:`/`Chat:` lens prefix. (This plain window offers only
    // the tty lens, so no ViewSwitcher; web lens-switch coverage lives in the
    // web-view-lens spec, which asserts `Tab:` in every lens.) The hierarchy
    // ▾ that used to split the prefix is GONE (260813-kvk7): the colon is
    // contiguous to the word, so assert the whole `Window:` run.
    await page.setViewportSize({ width: 900, height: 800 });
    await gotoWindow(page, id);
    await expect(page.getByText("Tab:", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Terminal:|Web:|Chat:/)).toHaveCount(0);

    // The removed hierarchy dropdown is really absent — no `Switch hierarchy`
    // trigger anywhere in the bar. The single ▾ next to the name is the window
    // switcher (accessible name "Switch tab"); opening it lists the
    // session's windows (NOT the ancestor chain).
    await expect(page.getByLabel("Switch hierarchy")).toHaveCount(0);
    await page.getByLabel("Switch tab").click();
    await expect(page.getByRole("menuitem", { name })).toBeVisible();
    await page.keyboard.press("Escape");

    // ≥ lg rung: the compact heading hides the prefix and the standing
    // quake launcher renders beside `{name} ▾` — the ▾ switcher is untouched.
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByText("Tab:", { exact: true })).toBeHidden();
    await expect(page.getByTestId("quake-launcher-input")).toBeVisible();
    await page.getByLabel("Switch tab").click();
    await expect(page.getByRole("menuitem", { name })).toBeVisible();
    await page.keyboard.press("Escape");
  });

  /**
   * Proves: the ◀ ▶ arrows drive BROWSER HISTORY (`router.history.back()` /
   * `.forward()`), NOT sibling-window cycling — and the pair renders in the
   * LEFT cluster (right of the sidebar toggle, left of the center heading;
   * `lg+` viewports — below `lg` the pair hides with the cluster's
   * degradation ladder), not inside the anchored heading box.
   *
   * Steps:
   * 1. Create two windows; build a real history stack by visiting the first
   *    then the second.
   * 2. Assert the `Go back` arrow's box sits right of the sidebar toggle and
   *    left of the heading (left-cluster placement).
   * 3. Click `Go back`; assert the URL and heading return to the FIRST
   *    window.
   * 4. Click `Go forward`; assert the URL and heading return to the SECOND
   *    window.
   */
  test("the ◀ ▶ arrows drive browser history (back returns to the prior window)", async ({
    page,
  }) => {
    // Two window creations + resolves + three navigations + the placement
    // boundingBox reads (260731-oiho) outgrow the 10s local budget — use the
    // board-spec 30s convention.
    test.setTimeout(30_000);
    const first = `hx-hist-a-${Date.now().toString().slice(-5)}`;
    const second = `hx-hist-b-${Date.now().toString().slice(-5)}`;
    newWindow(TEST_SESSION, first);
    newWindow(TEST_SESSION, second);
    const firstId = await resolveWindow(page, first);
    const secondId = await resolveWindow(page, second);

    // Build a real history stack: visit the first window, then the second.
    await gotoWindow(page, firstId);
    await expect(page.getByRole("button", { name: `Rename tab ${first}` })).toBeVisible({ timeout: 10_000 });
    await gotoWindow(page, secondId);
    await expect(page.getByRole("button", { name: `Rename tab ${second}` })).toBeVisible({ timeout: 10_000 });

    // The arrows live in the LEFT cluster (260731-oiho): while the sidebar
    // head shows (desktop, sidebar open) they LEAD that cluster and the
    // toggle sits in the head over the bar's left end — still left of the
    // arrows; neither is inside the anchored heading box.
    const back = page.getByLabel("Go back");
    const toggleBox = (await page.getByLabel("Toggle navigation").boundingBox())!;
    const backBox = (await back.boundingBox())!;
    const headingBox = (await page
      .getByRole("button", { name: `Rename tab ${second}` })
      .boundingBox())!;
    expect(backBox.x).toBeGreaterThan(toggleBox.x);
    expect(backBox.x + backBox.width).toBeLessThan(headingBox.x);

    // ◀ (browser back) returns to the first window's URL — NOT sibling cycling.
    await back.click();
    await expect(page).toHaveURL(new RegExp(`/${TMUX_SERVER}/${encodeURIComponent(firstId)}$`));
    await expect(page.getByRole("button", { name: `Rename tab ${first}` })).toBeVisible({ timeout: 10_000 });

    // ▶ (browser forward) returns to the second window.
    await page.getByLabel("Go forward").click();
    await expect(page).toHaveURL(new RegExp(`/${TMUX_SERVER}/${encodeURIComponent(secondId)}$`));
    await expect(page.getByRole("button", { name: `Rename tab ${second}` })).toBeVisible({ timeout: 10_000 });
  });

  /**
   * Proves: `navigateToWindow`'s `runSwitch` navigates with PUSH (not
   * `replace: true`), so IN-APP window switches (sidebar click / ▾ / palette /
   * shortcut) each create a distinct browser-history entry. Complements the
   * arrows test above, which builds its stack with `page.goto` (full
   * navigations always push) and so never exercised the in-app path where a
   * `replace: true` navigation would eat every within-server hop. Also proves
   * the NO-dedup requirement (revisiting a window still pushes) and that the
   * deep-link intent effect aligns tmux on each Back/Forward landing (the
   * landed heading renders with no new alignment code).
   *
   * Steps:
   * 1. Create two windows (`a`, `b`) in the shared session; resolve their
   *    `@N` ids.
   * 2. Navigate to the server root (so the first in-app click is
   *    unambiguous) and wait for `Connected`.
   * 3. Build the history stack ENTIRELY via in-app sidebar-row clicks —
   *    `a → b → a` (the no-dedup shape) — using a `switchTo` helper that
   *    clicks the row (`nav[aria-label='Groups'] [data-window-id="@N"]
   *    button`, a real client-side switch through `navigateToWindow`), then
   *    settles on `aria-current="page"`, the window-id URL, and the `Rename
   *    tab <name>` heading (tmux aligned + terminal rendered). URL assertions
   *    use the router's NUMERIC id segment (`windowId.slice(1)`, `@5` → `5`)
   *    — the form `navigateToWindow` writes — not the `%40N`
   *    `encodeURIComponent` form the arrows test's `page.goto` stack produces.
   * 4. `page.goBack()` (equivalent to the ◀ arrow): assert the URL + heading
   *    return to `b` — the a→b switch pushed an entry, it was not replaced.
   * 5. `page.goBack()` again: assert the URL + heading return to the FIRST
   *    `a` entry — the b→a revisit did NOT dedup against the earlier `a`.
   * 6. `page.goForward()`: assert the URL + heading return to `b` (history
   *    intact in both directions).
   */
  test("in-app window switches push history entries (Back/Forward retrace within-server hops, no dedup)", async ({
    page,
  }) => {
    // The fix (260715-m4xy): `navigateToWindow`'s `runSwitch` used to navigate
    // with `replace: true`, so IN-APP window switches (sidebar click, ▾,
    // palette, shortcut) REPLACED the current history entry — every
    // within-server hop was eaten, and Back skipped straight past them. The
    // arrows test above builds its stack with `page.goto` (full navigations
    // always push), so it never exercised this path. This test drives the
    // in-app switch path and asserts push semantics: three switches → three
    // retraceable entries, no dedup.
    const a = `hx-push-a-${Date.now().toString().slice(-5)}`;
    const b = `hx-push-b-${Date.now().toString().slice(-5)}`;
    newWindow(TEST_SESSION, a);
    newWindow(TEST_SESSION, b);
    const aId = await resolveWindow(page, a);
    const bId = await resolveWindow(page, b);

    const sidebar = page.locator("nav[aria-label='Groups']");
    // The in-app switch (`navigateToWindow`) writes the URL via the router,
    // whose param serialization carries the window id's NUMERIC part (`@5` →
    // `5`), NOT the `encodeURIComponent("@5")` = `%405` form a `page.goto`
    // produces. So assert on `windowId.slice(1)` (the segment the router
    // carries; parse restores `@N`) — unlike the arrows test above, whose
    // `%40N` stack was built with `page.goto`.
    const urlFor = (id: string): RegExp =>
      new RegExp(`/${TMUX_SERVER}/${id.slice(1)}(?:$|[/?#])`);
    // Click a sidebar window row — a REAL client-side switch through
    // `navigateToWindow` (the path the fix touches), settling on
    // `aria-current="page"` (selection accepted) then its heading (tmux
    // aligned + terminal rendered). Distinct from `page.goto`, which the
    // arrows test uses and which always pushes.
    const switchTo = async (id: string, name: string): Promise<void> => {
      const row = sidebar.locator(`[data-window-id="${id}"]`).getByRole("button").first();
      await expect(row).toBeVisible({ timeout: 10_000 });
      await row.click();
      await expect(row).toHaveAttribute("aria-current", "page", { timeout: 10_000 });
      await expect(page).toHaveURL(urlFor(id));
      await expect(page.getByRole("button", { name: `Rename tab ${name}` })).toBeVisible({ timeout: 10_000 });
    };

    // Land on the server root so the first in-app click is unambiguous, then
    // build the stack ENTIRELY via in-app switches: a → b → a (the no-dedup
    // shape — revisiting `a` still pushes a third entry).
    await gotoServerReady(page, TMUX_SERVER);
    await switchTo(aId, a);
    await switchTo(bId, b);
    await switchTo(aId, a);

    // Back (browser history — equivalent to the ◀ arrow) retraces to `b`: proof
    // the a→b switch pushed an entry rather than replacing it.
    await page.goBack();
    await expect(page).toHaveURL(urlFor(bId));
    await expect(page.getByRole("button", { name: `Rename tab ${b}` })).toBeVisible({ timeout: 10_000 });

    // A further Back retraces to the FIRST `a` entry — the b→a revisit did NOT
    // dedup against the earlier `a`; every hop is retained.
    await page.goBack();
    await expect(page).toHaveURL(urlFor(aId));
    await expect(page.getByRole("button", { name: `Rename tab ${a}` })).toBeVisible({ timeout: 10_000 });

    // Forward returns to `b` (history intact in both directions).
    await page.goForward();
    await expect(page).toHaveURL(urlFor(bId));
    await expect(page.getByRole("button", { name: `Rename tab ${b}` })).toBeVisible({ timeout: 10_000 });
  });
});

/**
 * Animated-path block. `playwright.config.ts` emulates `reducedMotion:
 * "reduce"` globally (window-switch transition stabilization) and the
 * heading boot sweep honors that gate by never starting — so asserting the
 * sweep needs real motion. Opt back in per the convention
 * `window-switch-transition.spec.ts` documents: `contextOptions` is the only
 * seam that reaches the browser context in this Playwright version.
 */
test.describe("Window heading — animated path (motion opted back in)", () => {
  test.use({ contextOptions: { reducedMotion: "no-preference" } });

  /**
   * Proves: the universal top-bar page heading actually runs its combined
   * boot sweep on hover: an inverse-video accent-green cursor cell
   * (`.rk-typed-cursor`) attaches inside the top-bar header while the sweep
   * runs, then the sweep resolves back to plain text (cursor cell gone) with
   * the accessible name intact. All assertions are DOM-observable frame
   * states — no pixel diffs (honoring the "NO pixel assertions" e2e
   * constraint). The sweep is driven by a DISPATCHED `mouseover`/`mouseout`
   * pair (React derives the button's `onMouseEnter`/`onMouseLeave` from
   * delegated `mouseover`/`mouseout`), the same churn-proof seam the
   * typed-sweep test uses, avoiding real hit-testing flake.
   *
   * Steps:
   * 1. Create + navigate to a window; confirm the `Rename tab <name>` heading
   *    is visible.
   * 2. Wait ~1200ms for the mount-replay sweep (which auto-plays once on
   *    navigation) to settle, then assert no `.rk-typed-cursor` remains
   *    inside the header (a clean rest baseline before the hover pass).
   * 3. Dispatch `mouseover` on the heading; assert an `.rk-typed-cursor` cell
   *    attaches inside `header` (the sweep started — scoped to the header so
   *    the sidebar TypedLabels aren't mistaken for it; `playDeferred` waits
   *    the 140ms hover-intent before the first frame).
   * 4. Dispatch `mouseout`; assert no `.rk-typed-cursor` cell remains inside
   *    the header (the sweep resolved to rest) and the heading text still
   *    equals the window name (the accessible name never churned).
   */
  test("terminal page heading runs the boot sweep on hover: cursor cell attaches, then resolves to rest", async ({
    page,
  }) => {
    const name = `head-sweep-${Date.now()}`;
    newWindow(TEST_SESSION, name);
    const id = await resolveWindow(page, name);
    await gotoWindow(page, id);

    const heading = page.getByRole("button", { name: `Rename tab ${name}` });
    await expect(heading).toBeVisible({ timeout: 10_000 });
    // Let any mount-replay sweep settle before driving a fresh hover pass (the
    // mount leg auto-plays once on navigation; DECODE_HOVER_INTENT_MS + a full
    // ~28ms/cell pass is well under this wait).
    await page.waitForTimeout(1_200);

    // The boot sweep's cursor/churn cells live inside the top-bar header (the
    // prefix sibling + the name button). Scope cursor assertions to the header
    // so the sidebar TypedLabels (not hovered here) can't be mistaken for them.
    const headerCursor = page.locator("header .rk-typed-cursor");
    await expect(headerCursor).toHaveCount(0);

    // Drive the sweep via a dispatched `mouseover` (React derives the button's
    // onMouseEnter from mouseover/mouseout) — the same churn-proof seam the
    // typed-sweep test uses, avoiding real hit-testing flake. playDeferred waits
    // DECODE_HOVER_INTENT_MS (140ms) before the first frame.
    await heading.dispatchEvent("mouseover");
    // An inverse-video cursor cell appears inside the header during the sweep.
    await expect(headerCursor.first()).toBeAttached({ timeout: 2_000 });

    // Pass completes (or mouseout cancels): cells collapse back to plain text,
    // no cursor cell remains, and the accessible name is intact.
    await heading.dispatchEvent("mouseout");
    await expect(page.locator("header .rk-typed-cursor")).toHaveCount(0, {
      timeout: 2_000,
    });
    await expect(heading).toHaveText(name);
  });
});
