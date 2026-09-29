/**
 * Shared readiness helpers for e2e specs.
 *
 * The app is SSE-driven: navigating to `/$server` opens an SSE connection, and
 * the session list arrives in a follow-up payload. Tests must wait for the data
 * to render, not merely for the connection ("Connected") to open. On a dev box
 * the payload is near-instant; on a 2-vCPU CI runner (where air, Vite, Chromium
 * and tmux all contend) it can take seconds, so readiness timeouts are widened
 * under CI rather than masking the slowness with blanket retries.
 */
import { expect, type Locator, type Page } from "@playwright/test";

/** Generous readiness timeout for "wait for SSE data to render" gates. Wider on
 *  CI to absorb shared-runner latency; tight locally to keep feedback fast. */
export const READY_TIMEOUT = process.env.CI ? 20_000 : 10_000;

/**
 * Navigate to a server route and wait until the status bar is connected AND
 * the sidebar populated. Returns the Sessions nav locator. Pass `expectSession`
 * to also gate on a specific session row being rendered (the strongest signal
 * that the SSE payload has actually landed).
 *
 * PRECONDITION: the gate is the full-width status bar's `Connected` dot
 * (desktop-only chrome — the dot's old sidebar-footer home is mobile-only now,
 * so specs using this gate must run at a desktop viewport). For
 * mobile-viewport tests, gate on an always-mounted element (heading, chevron,
 * iframe) instead.
 */
export async function gotoServerReady(
  page: Page,
  server: string,
  expectSession?: string,
): Promise<ReturnType<Page["locator"]>> {
  await page.goto(`/${server}`);
  await expect(
    page.getByTestId("status-bar").locator("[aria-label='Connected']"),
  ).toBeVisible({ timeout: READY_TIMEOUT });
  const sidebar = page.locator("nav[aria-label='Sessions']");
  if (expectSession) {
    await expect(
      sidebar.locator(`button[aria-label='Navigate to ${expectSession}']`),
    ).toBeVisible({ timeout: READY_TIMEOUT });
  }
  return sidebar;
}

/** Attempts before `openPalette` gives up, and how long each one waits. */
const PALETTE_ATTEMPTS = 3;
const PALETTE_ATTEMPT_TIMEOUT = 3_000;

/**
 * Open the command palette and return its input, ready to `.fill()`.
 *
 * Presses the SHIFTED palette chord, which reaches the palette from every
 * focus context on this Linux rig: the terminal seam refuses shifted-tier
 * matches on every platform, so the event bubbles to the window dispatcher
 * even while xterm owns focus. The unshifted form does not — there the cmd
 * tier resolves to plain Ctrl+K, which xterm handles and `preventDefault`s,
 * and the dispatcher drops on its opening `if (e.defaultPrevented) return`.
 *
 * The blur-and-retry below is a fallback for a chord lost some other way, not
 * the mechanism. The first attempt leaves focus alone so specs that assert
 * focus-dependent behavior are unaffected.
 */
export async function openPalette(page: Page): Promise<Locator> {
  const input = page.getByPlaceholder("Type a command");
  for (let attempt = 0; attempt < PALETTE_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    }
    await page.keyboard.press("Shift+Control+k");
    // The last attempt asserts rather than probes, so exhaustion costs the same
    // three waits as success and the failure still names the palette — never a
    // fourth timeout, and never a downstream locator taking the blame.
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

/** A window as it appears in the `GET /api/sessions` snapshot. */
export interface SnapshotWindow {
  windowId: string;
  index: number;
  name: string;
  marker?: string;
  color?: string;
}

/**
 * Resolve a window from the backend snapshot by its display name, scoped to a
 * given server + session — or the session's FIRST window when `windowName` is
 * omitted. Returns the full snapshot window (`windowId`, `index`, `name`,
 * `marker?`, `color?`); callers project the field(s) they need. Polls because
 * a CLI-created window surfaces asynchronously in `GET /api/sessions`.
 */
export async function resolveWindow(
  page: Page,
  server: string,
  session: string,
  windowName?: string,
): Promise<SnapshotWindow> {
  const deadline = Date.now() + 5_000;
  let win: SnapshotWindow | null = null;
  while (Date.now() < deadline) {
    const res = await page.request.get(
      `/api/sessions?server=${encodeURIComponent(server)}`,
    );
    if (res.ok()) {
      const sessions = (await res.json()) as Array<{
        name: string;
        windows: SnapshotWindow[];
      }>;
      const windows = sessions.find((s) => s.name === session)?.windows;
      const found =
        windowName === undefined
          ? windows?.[0]
          : windows?.find((w) => w.name === windowName);
      if (found) {
        win = found;
        break;
      }
    }
    await page.waitForTimeout(200);
  }
  expect(
    win,
    windowName === undefined
      ? `first window of "${session}" not found in snapshot`
      : `window "${windowName}" not found in snapshot`,
  ).not.toBeNull();
  return win!;
}

/** Navigate to a specific window's terminal route and wait for connection.
 *  Same desktop-viewport precondition as `gotoServerReady` (the gate is the
 *  status bar's `Connected` dot — desktop-only chrome). */
export async function gotoWindow(
  page: Page,
  server: string,
  windowId: string,
): Promise<void> {
  await page.goto(`/${server}/${encodeURIComponent(windowId)}`);
  await expect(
    page.getByTestId("status-bar").locator("[aria-label='Connected']"),
  ).toBeVisible({
    timeout: READY_TIMEOUT,
  });
}

/**
 * Seed the compose-strip preference before the first navigation. The strip is
 * ON by default (an absent key reads on), so a spec whose subject is xterm
 * input or non-punch-through app chords — anything that types or presses keys
 * right after `goto` without clicking the terminal — states its precondition
 * explicitly with `seedComposeStrip(page, false)` instead of relying on a
 * default. `true` pins the opposite for tests that want the expanded strip
 * regardless of any future default change. Must run before `page.goto`.
 */
/**
 * Poll `document.activeElement` until it is the named surface: inside an
 * `.xterm`, the compose strip's textarea, or the code tile's iframe. Shared by
 * the focus-restore and compose-strip specs (one activeElement predicate).
 */
export async function expectActiveElement(
  page: Page,
  target: "xterm" | "compose" | "code-iframe",
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((kind) => {
          const el = document.activeElement;
          if (!el) return false;
          if (kind === "xterm") return el.closest(".xterm") !== null;
          if (kind === "compose") {
            return el.getAttribute("data-testid") === "compose-strip-input";
          }
          return el.tagName === "IFRAME" && el.getAttribute("title") === "Code editor";
        }, target),
      { timeout: READY_TIMEOUT },
    )
    .toBe(true);
}

/** Switch windows through the sidebar row — the ONLY switch path usable by
 *  specs covering in-memory per-window state (focus memory, the code-frame
 *  LRU): a `page.goto` reload would wipe the state under test. The row's
 *  button routes through `navigateToWindow`, identical to a real sidebar
 *  click. Shared by the focus-restore and code-surface specs. */
export async function switchToWindow(page: Page, windowId: string): Promise<void> {
  const row = page
    .locator("nav[aria-label='Sessions']")
    .locator(`[data-window-id="${windowId}"]`)
    .getByRole("button")
    .first();
  await expect(row).toBeVisible({ timeout: READY_TIMEOUT });
  await row.click();
  await expect(row).toHaveAttribute("aria-current", "page", {
    timeout: READY_TIMEOUT,
  });
}

export async function seedComposeStrip(page: Page, on: boolean): Promise<void> {
  // Init scripts re-run on every navigation, reload included — so the seed
  // writes only when the key is ABSENT (the fresh-context case). A value the
  // test itself stored (a chip click, a palette toggle) survives a reload,
  // which is exactly what a persistence assertion needs to observe.
  await page.addInitScript((value) => {
    if (localStorage.getItem("hexokit-compose-strip") === null) {
      localStorage.setItem("hexokit-compose-strip", value);
    }
  }, on ? "true" : "false");
}
