import { test, expect, type Page } from "@playwright/test";
import { openPalette, seedComposeStrip } from "./_ready";
import { mockStateSocket } from "./_state-socket-mock";

// Keyboard shortcut registry: the `Shift+CmdOrCtrl+<key>` run-kit action tier
// dispatched by the window-level registry dispatcher, the shortcuts surface —
// the settings dialog's Shortcuts tab (the standalone overlay shell is
// retired; ⇧CmdOrCtrl+/ on Win/Linux hosts, demoted to ⌘/ on mac, deep-links
// into the one Settings dialog), click-to-capture rebinding persisted as diffs
// to localStorage["hexokit-keybindings"], palette `shortcut` hints sourced from
// the effective map, and browser-reserved key inertness (Playwright is a plain
// browser host, so the shifted N/T/W defaults resolve disabled while their
// actions stay palette-reachable). Also covers the macOS ⌘-tier demotions via
// a spoofed-platform block (deep mac paths — shell-host N/T/W demotion,
// claimed sets — are unit-tested in lib/keybindings.test.ts; e2e runs on
// Linux), the split-pane chords (the divider pair ⇧Ctrl+\/⇧Ctrl+- splitting
// side-by-side then stacked on this host, ⌘D/⇧⌘D on a spoofed mac — the
// `macCode` refinement, both actions bound and palette-hinted on every host),
// the VS Code-aligned chrome chords (the stateful sidebar-toggle chord on B —
// full focus/hide/reopen arms on ⇧Ctrl+B here plus the ⌘B binding-resolution
// seam on a spoofed mac; the stateful code-toggle chord on 2 — ⇧Ctrl+2 /
// ⌘2 — open+focus / hide+restore on a code-capable window; and focus-hop on
// Backquote — ⇧Ctrl+` here, ⌃` on a spoofed mac via the seam's mac-only
// ctrl-tier refusal rule — open-then-focus on a closed code tile, then the hop
// back to the tty tile), and the tabbed-dialog deep-links (`settings-open`
// ⇧Ctrl+, as the pure opener landing on General, the `shortcuts-overlay`
// three-state toggle, pointer + roving-arrow tab switching, and the
// `Settings: Appearance` palette action).
//
// Shared setup: fully mocked — no tmux, no real backend state. Injected via
// page.route / page.routeWebSocket: `**/api/servers` → a single server
// `default`; `**/api/windows/*/select*` → 200 (trailing `*` so the client's
// appended `?server=` query is still intercepted); `**/api/keybindings*` →
// three curated tmux bindings (two root-table, one prefix-table) for the
// Shortcuts tab's read-only TMUX section; `**/api/windows/*/split*` (via
// mockSplit, per split test) → 200 with each POST body captured for assertion;
// `/ws/state` (via mockStateSocket) → session `dev` with three windows: `@1`
// "win-one" (active), `@2` "win-two", `@3` "win-three" — codeCapablePayload()
// re-stamps the payload with `gitRoot` on `@1` (the code surface's
// availability is the window's derived gitRoot); the terminals mux WebSocket
// (`/ws/terminals`) is stubbed. gotoWindowOne(page) navigates to `/default/1`
// and gates on "win-one" rendering. Chords are pressed as
// `Shift+Control+<code>` — the registry matches on KeyboardEvent.code and
// accepts Ctrl in place of Meta on every platform. Presses land while the
// xterm textarea owns focus, so each dispatch also exercises the terminal seam
// (the custom key handler refuses shifted-tier chords so they bubble to the
// dispatcher instead of reaching the pane). spoofMacPlatform(page) installs an
// init-script getter override on Navigator.prototype.platform ("MacIntel") so
// detectPlatform() resolves `mac` and the per-platform defaults demote to the
// ⌘ tier; those chords are pressed as `Meta+<code>`, exercising the mac
// terminal-seam refusal (metaKey-gated cmd-tier matches).

const SERVER = "default";

function sessionsPayload() {
  const win = (id: number, name: string, active: boolean) => ({
    windowId: `@${id}`,
    index: id - 1,
    name,
    worktreePath: `/tmp/${name}`,
    activity: active ? "active" : "idle",
    isActiveWindow: active,
    activityTimestamp: 0,
    agentState: "idle",
  });
  return JSON.stringify([
    {
      name: "dev",
      windows: [win(1, "win-one", true), win(2, "win-two", false), win(3, "win-three", false)],
    },
  ]);
}

async function mockBackend(page: Page, sessionsJson?: string) {
  await page.routeWebSocket(/\/ws\/terminals/, () => {});
  await page.route("**/api/windows/*/select*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }),
  );
  // Tile chords (⌃`, Ctrl+2…) are shared `@rk_win_layout` writes; the mocked
  // payload never reflects them, so the optimistic overlay is what renders
  // the opened tile — the POST just has to succeed (trailing `*`: the client
  // appends `?server=`).
  await page.route("**/api/windows/*/options*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }),
  );
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ name: SERVER, sessionCount: 1 }]),
    }),
  );
  // Curated tmux keybindings for the overlay's read-only TMUX section
  // (260801-sm6g — the merged shortcuts surface fetches these while open).
  await page.route("**/api/keybindings*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { key: "F2", table: "root", command: "new-window", label: "New tmux window" },
        { key: "S-F7", table: "root", command: "copy-mode", label: "Scroll / copy mode" },
        { key: "\\", table: "prefix", command: "split-window -h", label: "Split horizontally" },
      ]),
    }),
  );
  await mockStateSocket(page, { sessions: sessionsJson ?? sessionsPayload() });
}

/** The default payload with `gitRoot` stamped on window @1 — code-capable
 *  (the code surface's availability is the window's derived gitRoot). */
function codeCapablePayload(): string {
  const payload = JSON.parse(sessionsPayload()) as [
    { windows: Record<string, unknown>[] },
  ];
  payload[0].windows[0].gitRoot = "/tmp/win-one";
  return JSON.stringify(payload);
}

async function gotoWindowOne(page: Page) {
  await page.goto(`/${SERVER}/1`);
  await expect(page.getByText("win-one").first()).toBeVisible();
}

// Every spec here is about CHORDS reaching the window-level dispatcher. The
// compose strip is on by default and a fresh desktop navigation focuses its
// textarea. The navigation family (tab/session/history) punches through that
// textarea via `ignoreInputs`, but this file also exercises chords that do
// NOT (create-window, kill-window, the split pair, macros) and would be
// suppressed there — so it states the explicit opt-out up front; the compose
// surface is not its subject.
test.beforeEach(async ({ page }) => {
  await seedComposeStrip(page, false);
});

test.describe("shifted-tier window cycling", () => {
  /**
   * Proves: the `window-next`/`window-prev` starter bindings step one row
   * over the flattened all-sessions window list in sidebar order, wrapping at
   * both ends.
   *
   * Steps:
   * 1. Mock the backend; open `/default/1`.
   * 2. Press Shift+Ctrl+Down three times → URL walks `/default/2`,
   *    `/default/3`, then wraps to `/default/1`.
   * 3. Press Shift+Ctrl+Up → URL wraps backward to `/default/3`.
   */
  test("Shift+Ctrl+Down / Shift+Ctrl+Up step the flattened all-sessions window list with wraparound", async ({ page }) => {
    await mockBackend(page);
    await gotoWindowOne(page);

    // Next: @1 → @2 → @3, then wrap to @1.
    await page.keyboard.press("Shift+Control+ArrowDown");
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/2(?:$|[/?#])`));
    await page.keyboard.press("Shift+Control+ArrowDown");
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/3(?:$|[/?#])`));
    await page.keyboard.press("Shift+Control+ArrowDown");
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/1(?:$|[/?#])`));

    // Previous wraps backward from @1 to @3.
    await page.keyboard.press("Shift+Control+ArrowUp");
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/3(?:$|[/?#])`));
  });

  /**
   * Proves: the flattened window step crosses a session boundary onto the
   * adjacent session's edge window, and the `session-next`/`session-prev`
   * bindings hop the adjacent session in sidebar order (wraparound), landing
   * on its tmux-active window.
   *
   * Steps:
   * 1. Mock a two-session backend (dev @1–@3, ops @4–@5 with @4 active); open
   *    `/default/1`.
   * 2. Press Shift+Ctrl+Down three times → `/default/2`, `/default/3`, then
   *    crossing the boundary onto `/default/4`.
   * 3. Press Shift+Ctrl+Up → back across the boundary onto dev's last window
   *    `/default/3`.
   * 4. Press Shift+Ctrl+Right → ops's active window `/default/4`.
   * 5. Press Shift+Ctrl+Right again → wraps to dev's active window
   *    `/default/1`.
   * 6. Press Shift+Ctrl+Left → wraps back to ops's active window
   *    `/default/4`.
   */
  test("the cycle crosses a session boundary and Shift+Ctrl+Right jumps the adjacent session's active window", async ({ page }) => {
    // Two sessions in sidebar order: dev (@1, @2, @3) then ops (@4 active, @5).
    const payload = JSON.stringify([
      {
        name: "dev",
        windows: [
          { windowId: "@1", index: 0, name: "win-one", worktreePath: "/tmp/win-one", activity: "active", isActiveWindow: true, activityTimestamp: 0, agentState: "idle" },
          { windowId: "@2", index: 1, name: "win-two", worktreePath: "/tmp/win-two", activity: "idle", isActiveWindow: false, activityTimestamp: 0, agentState: "idle" },
          { windowId: "@3", index: 2, name: "win-three", worktreePath: "/tmp/win-three", activity: "idle", isActiveWindow: false, activityTimestamp: 0, agentState: "idle" },
        ],
      },
      {
        name: "ops",
        windows: [
          { windowId: "@4", index: 0, name: "ops-one", worktreePath: "/tmp/ops-one", activity: "idle", isActiveWindow: true, activityTimestamp: 0, agentState: "idle" },
          { windowId: "@5", index: 1, name: "ops-two", worktreePath: "/tmp/ops-two", activity: "idle", isActiveWindow: false, activityTimestamp: 0, agentState: "idle" },
        ],
      },
    ]);
    await mockBackend(page, payload);
    await gotoWindowOne(page);

    // Next from dev's last window crosses the boundary onto ops's first window.
    await page.keyboard.press("Shift+Control+ArrowDown"); // @1 → @2
    await page.keyboard.press("Shift+Control+ArrowDown"); // @2 → @3
    await page.keyboard.press("Shift+Control+ArrowDown"); // @3 → @4 (boundary)
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/4(?:$|[/?#])`));
    // Previous crosses back onto dev's last window.
    await page.keyboard.press("Shift+Control+ArrowUp");
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/3(?:$|[/?#])`));

    // Session jump: from @3 (dev), next session is ops — lands on its ACTIVE
    // window @4 (first row here); wrapping back lands on dev's active @1.
    await page.keyboard.press("Shift+Control+ArrowRight");
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/4(?:$|[/?#])`));
    await page.keyboard.press("Shift+Control+ArrowRight"); // wrap back to dev
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/1(?:$|[/?#])`));
    // Previous session from @1 wraps to ops's active window.
    await page.keyboard.press("Shift+Control+ArrowLeft");
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/4(?:$|[/?#])`));
  });

  /**
   * Proves: the `go-back`/`go-forward` bindings drive router history — a
   * window switch pushes an entry that the chords retrace.
   *
   * Steps:
   * 1. Open `/default/1`; press Shift+Ctrl+Down → `/default/2` (pushes
   *    history).
   * 2. Press Shift+Ctrl+[ → back to `/default/1`.
   * 3. Press Shift+Ctrl+] → forward to `/default/2`.
   */
  test("Shift+Ctrl+[ / Shift+Ctrl+] retrace history (back / forward)", async ({ page }) => {
    await mockBackend(page);
    await gotoWindowOne(page);

    await page.keyboard.press("Shift+Control+ArrowDown");
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/2(?:$|[/?#])`));

    await page.keyboard.press("Shift+Control+BracketLeft");
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/1(?:$|[/?#])`));

    await page.keyboard.press("Shift+Control+BracketRight");
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/2(?:$|[/?#])`));
  });
});

test.describe("shortcuts overlay", () => {
  // The overlay's body is the settings dialog's Shortcuts tab now
  // (260818-bncw): the chord deep-links into the one dialog, and the panel
  // carries its own testid inside `dialog[name=Settings]`.
  const settingsDialog = (page: Page) => page.getByRole("dialog", { name: "Settings" });
  const shortcutsPanel = (page: Page) => page.getByTestId("settings-shortcuts-panel");

  /**
   * Proves: the shortcuts chord deep-links into the settings dialog's
   * Shortcuts tab and toggles the dialog closed on a second press (including
   * from inside the panel's own filter input — the binding is
   * `ignoreInputs`), the filter narrows rows, and Escape closes the dialog.
   *
   * Steps:
   * 1. Open `/default/1`; press Shift+Ctrl+/ → the `Settings` dialog is
   *    visible with the Shortcuts tab selected (`settings-shortcuts-panel`
   *    testid).
   * 2. Fill the filter with "waiting" → the "Next waiting agent" row remains,
   *    the "New session" row is filtered out.
   * 3. Press Shift+Ctrl+/ again (focus in the filter input) → the dialog
   *    closes.
   * 4. Reopen with the chord; press Escape → the dialog closes.
   */
  test("Shift+CmdOrCtrl+/ toggles the Shortcuts tab; filter narrows; Escape closes", async ({ page }) => {
    await mockBackend(page);
    await gotoWindowOne(page);

    await page.keyboard.press("Shift+Control+Slash");
    const panel = shortcutsPanel(page);
    await expect(panel).toBeVisible();
    // The chord deep-links: the dialog opened ON the Shortcuts tab.
    await expect(settingsDialog(page).getByRole("tab", { name: "Shortcuts" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // Filter narrows rows and hides empty groups.
    await page.getByLabel("Filter shortcuts").fill("waiting");
    await expect(panel.getByText("Next waiting agent")).toBeVisible();
    await expect(panel.getByText("New session")).toHaveCount(0);

    // The chord toggles the dialog closed even from the filter input
    // (`ignoreInputs`), then reopen and close via Escape.
    await page.keyboard.press("Shift+Control+Slash");
    await expect(settingsDialog(page)).toHaveCount(0);
    await page.keyboard.press("Shift+Control+Slash");
    await expect(panel).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settingsDialog(page)).toHaveCount(0);
  });

  /**
   * Proves: the Shortcuts tab is palette-reachable (keyboard-first) via the
   * `shortcuts-overlay` action.
   *
   * Steps:
   * 1. Open the palette (`openPalette`), fill "Help: Keyboard Shortcuts", press
   *    Enter.
   * 2. Assert the settings dialog is visible on the Shortcuts tab
   *    (`settings-shortcuts-panel`).
   */
  test("the Help: Keyboard Shortcuts palette entry opens the Shortcuts tab", async ({ page }) => {
    await mockBackend(page);
    await gotoWindowOne(page);

    const paletteInput = await openPalette(page);
    await paletteInput.fill("Help: Keyboard Shortcuts");
    await page.keyboard.press("Enter");
    await expect(shortcutsPanel(page)).toBeVisible();
  });

  /**
   * Proves: the Shortcuts tab is the single merged shortcuts surface — it
   * renders the sticky jump-nav chip row (key map · global · terminal · board
   * · tmux), folds the current server's curated tmux keybindings in as a
   * read-only locked section (prefix rows as `Ctrl` `S` *then* `\`
   * sequences), and one filter spans app + tmux rows with live per-chip match
   * counts (zero-hit chips dim).
   *
   * Steps:
   * 1. Mock the backend (incl. the keybindings API route glob); open
   *    `/default/1`;
   *    open the Shortcuts tab with Shift+Ctrl+/.
   * 2. Assert every jump chip renders in the nav (`shortcuts-jump-nav`).
   * 3. Assert the TMUX section (`tmux-section`) shows the mocked root rows
   *    and the prefix row's "then" sequence separator.
   * 4. Fill the filter with "split" → the tmux "Split horizontally" row stays
   *    visible; the tmux chip shows count 1 and the global chip shows 0.
   */
  test("the merged surface carries the jump nav and the read-only tmux section (260801-sm6g)", async ({ page }) => {
    await mockBackend(page);
    await gotoWindowOne(page);

    await page.keyboard.press("Shift+Control+Slash");
    await expect(shortcutsPanel(page)).toBeVisible();

    // Sticky jump-nav chips, one per section.
    const nav = page.getByTestId("shortcuts-jump-nav");
    for (const chip of ["key map", "global", "terminal", "board", "tmux"]) {
      await expect(nav.getByText(chip, { exact: true })).toBeVisible();
    }

    // TMUX locked section from the mocked GET /api/keybindings: Direct rows,
    // and a Prefix row rendered as a Ctrl S then \ sequence.
    const tmux = page.getByTestId("tmux-section");
    await expect(tmux.getByText("Scroll / copy mode")).toBeVisible();
    await expect(tmux.getByText("Split horizontally")).toBeVisible();
    // `exact` — the Prefix SUBHEAD also contains "then" ("Ctrl+S, then key").
    await expect(tmux.getByText("then", { exact: true })).toBeVisible();

    // One filter spans app + tmux: the tmux hit stays visible and the chips
    // grow live match counts (global dims at zero).
    await page.getByLabel("Filter shortcuts").fill("split");
    await expect(tmux.getByText("Split horizontally")).toBeVisible();
    await expect(nav.locator("button", { hasText: "tmux" })).toContainText("1");
    await expect(nav.locator("button", { hasText: "global" })).toContainText("0");
  });

  /**
   * Proves: clicking a row's combo arms capture, pressing a chord rebinds the
   * action, the override persists as a diff in
   * `localStorage["hexokit-keybindings"]`, and dispatch honors the override
   * (the new chord fires; the vacated default no longer does).
   *
   * Steps:
   * 1. Open `/default/1`; open the Shortcuts tab with Shift+Ctrl+/.
   * 2. Click the combo button for "Next tab"; press Shift+Ctrl+U.
   * 3. Assert localStorage holds
   *    `{"window-next":{"code":"KeyU","tier":"shifted"}}`.
   * 4. Close the dialog (Escape).
   * 5. Press Shift+Ctrl+Down (the vacated default) → URL stays `/default/1`.
   * 6. Press Shift+Ctrl+U → URL navigates to `/default/2`.
   */
  test("click-to-capture rebinds, persists the diff, and the new chord dispatches", async ({ page }) => {
    await mockBackend(page);
    await gotoWindowOne(page);

    await page.keyboard.press("Shift+Control+Slash");
    await expect(shortcutsPanel(page)).toBeVisible();

    await page.getByLabel("Change binding for Next tab").click();
    await page.keyboard.press("Shift+Control+KeyU");

    // The diff persisted to localStorage["hexokit-keybindings"].
    const stored = await page.evaluate(() => localStorage.getItem("hexokit-keybindings"));
    expect(JSON.parse(stored ?? "{}")).toEqual({
      "window-next": { code: "KeyU", tier: "shifted" },
    });

    await page.keyboard.press("Escape");
    await expect(settingsDialog(page)).toHaveCount(0);

    // The rebound chord dispatches; the vacated default no longer does.
    await page.keyboard.press("Shift+Control+ArrowDown");
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/1(?:$|[/?#])`));
    await page.keyboard.press("Shift+Control+KeyU");
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/2(?:$|[/?#])`));
  });
});

// Tabbed settings dialog (260818-bncw): the two chords' deep-link semantics —
// `settings-open` a pure opener, `shortcuts-overlay` a three-state toggle —
// plus the per-tab palette action and the pointer/arrow tab navigation.
test.describe("tabbed settings dialog deep-links (260818-bncw)", () => {
  const settingsDialog = (page: Page) => page.getByRole("dialog", { name: "Settings" });
  const tab = (page: Page, name: string) =>
    settingsDialog(page).getByRole("tab", { name, exact: true });

  /**
   * Proves: the per-binding deep-link semantics: `settings-open` (⇧Ctrl+,) is
   * a pure opener that lands on General and never closes or yanks the tab on
   * re-fire; `shortcuts-overlay` (⇧Ctrl+/) is a three-state toggle — closed →
   * open on Shortcuts, open on another tab → switch to Shortcuts, open on
   * Shortcuts → close.
   *
   * Steps:
   * 1. Open `/default/1`; press Shift+Ctrl+, → the dialog opens on General
   *    (Instance name visible).
   * 2. Press Shift+Ctrl+/ → the dialog stays open, now on the Shortcuts tab.
   * 3. Press Shift+Ctrl+, → nothing changes (still open on Shortcuts).
   * 4. Press Shift+Ctrl+/ → the dialog closes.
   */
  test("settings-open lands on General; the shortcuts chord switches tabs without closing; re-fire is a no-op", async ({
    page,
  }) => {
    await mockBackend(page);
    await gotoWindowOne(page);

    // ⇧Ctrl+, opens on General (the pure opener).
    await page.keyboard.press("Shift+Control+Comma");
    await expect(settingsDialog(page)).toBeVisible();
    await expect(tab(page, "General")).toHaveAttribute("aria-selected", "true");
    await expect(settingsDialog(page).getByLabel("Instance name")).toBeVisible();

    // ⇧Ctrl+/ while open on General SWITCHES to Shortcuts (no close).
    await page.keyboard.press("Shift+Control+Slash");
    await expect(settingsDialog(page)).toBeVisible();
    await expect(tab(page, "Shortcuts")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("settings-shortcuts-panel")).toBeVisible();

    // ⇧Ctrl+, while open on Shortcuts: no-op — never closes, never yanks.
    await page.keyboard.press("Shift+Control+Comma");
    await expect(settingsDialog(page)).toBeVisible();
    await expect(tab(page, "Shortcuts")).toHaveAttribute("aria-selected", "true");

    // ⇧Ctrl+/ while open on Shortcuts closes (the toggle's second state).
    await page.keyboard.press("Shift+Control+Slash");
    await expect(settingsDialog(page)).toHaveCount(0);
  });

  /**
   * Proves: the tablist switches panels on click and implements
   * roving-tabindex arrow-key navigation with activate-on-focus.
   *
   * Steps:
   * 1. Open the dialog (Shift+Ctrl+,).
   * 2. Click the Appearance tab → it selects and the Theme mode group
   *    renders.
   * 3. Focus the Appearance tab; press ArrowDown → Shortcuts selects and
   *    takes focus.
   * 4. Press ArrowDown again → All settings selects and takes focus (the
   *    registry-table tab is the rail's last entry).
   */
  test("tabs switch by pointer and by roving arrow keys", async ({ page }) => {
    await mockBackend(page);
    await gotoWindowOne(page);

    await page.keyboard.press("Shift+Control+Comma");
    await expect(settingsDialog(page)).toBeVisible();

    // Pointer: Appearance shows the theme controls.
    await tab(page, "Appearance").click();
    await expect(tab(page, "Appearance")).toHaveAttribute("aria-selected", "true");
    await expect(settingsDialog(page).getByRole("group", { name: "Theme mode" })).toBeVisible();

    // Roving arrow keys: ArrowDown from the focused tab activates the next —
    // the rail order ends with the registry table: … Shortcuts, All settings.
    await tab(page, "Appearance").focus();
    await page.keyboard.press("ArrowDown");
    await expect(tab(page, "Shortcuts")).toHaveAttribute("aria-selected", "true");
    await expect(tab(page, "Shortcuts")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(tab(page, "All settings")).toHaveAttribute("aria-selected", "true");
    await expect(tab(page, "All settings")).toBeFocused();
  });

  /**
   * Proves: the per-tab palette entry (id `settings-appearance`) opens the
   * dialog directly on the Appearance tab.
   *
   * Steps:
   * 1. Open the palette (`openPalette`); fill "Settings: Appearance" → the entry
   *    is visible; press Enter.
   * 2. Assert the dialog is open with the Appearance tab selected.
   */
  test("the Settings: Appearance palette action deep-links the Appearance tab", async ({ page }) => {
    await mockBackend(page);
    await gotoWindowOne(page);

    const paletteInput = await openPalette(page);
    await paletteInput.fill("Settings: Appearance");
    await expect(page.getByText("Settings: Appearance")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(settingsDialog(page)).toBeVisible();
    await expect(tab(page, "Appearance")).toHaveAttribute("aria-selected", "true");
  });
});

test.describe("palette hints", () => {
  /**
   * Proves: a registered action's palette entry carries its effective combo
   * as the `shortcut` hint, formatted for the host platform (non-mac →
   * `Shift+Ctrl+A` on `Agent: Next waiting`).
   *
   * Steps:
   * 1. Open `/default/1`; open the palette; fill "Agent: Next waiting".
   * 2. Assert the hint text `Shift+Ctrl+A` is visible.
   */
  test("registered palette entries render effective per-platform combos", async ({ page }) => {
    await mockBackend(page);
    await gotoWindowOne(page);

    const paletteInput = await openPalette(page);
    await paletteInput.fill("Agent: Next waiting");
    // Playwright runs a non-mac browser host → "Shift+Ctrl+A".
    await expect(page.getByText("Shift+Ctrl+A")).toBeVisible();
  });
});

// Spoof macOS platform detection (260730-n789): `detectPlatform()` probes
// `navigator.platform` + userAgent, so an init-script getter override makes
// the SPA resolve the mac per-platform defaults on the Linux CI browser.
// Deep mac behavior (shell-host demotions, claims) is unit-test territory —
// this exercises the resolved wiring end-to-end where the platform is the
// only mac-specific input.
async function spoofMacPlatform(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "platform", {
      get: () => "MacIntel",
      configurable: true,
    });
  });
}

test.describe("macOS per-platform defaults (spoofed platform)", () => {
  /**
   * Proves: on a macOS host (spoofed platform) the `go-back`/`go-forward`
   * defaults demote to the unshifted ⌘ tier — ⌘[/⌘] navigate history while
   * the terminal owns focus (the mac seam refusal bubbles the chord), window
   * cycling demotes with them (⌘↓ steps the flattened list), and the old
   * ⇧CmdOrCtrl+[ combo no longer dispatches.
   *
   * Steps:
   * 1. Spoof the mac platform; mock the backend; open `/default/1`.
   * 2. Press Meta+Down → `/default/2` (the demoted ⌘-tier window cycle).
   * 3. Press Meta+[ → back to `/default/1`; Meta+] → forward to
   *    `/default/2`.
   * 4. Press Shift+Ctrl+[ ; wait 300ms → URL unchanged (`/default/2`).
   */
  test("⌘[ / ⌘] retrace history on a mac host; the shifted default is vacated", async ({ page }) => {
    await spoofMacPlatform(page);
    await mockBackend(page);
    await gotoWindowOne(page);

    // ⌘↓ steps the flattened window list on macOS (the demoted cmd tier);
    // the shifted-tier session pair rides ⇧⌘↑/⇧⌘↓ there.
    await page.keyboard.press("Meta+ArrowDown");
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/2(?:$|[/?#])`));

    // The demoted ⌘ tier drives history (pressed with Meta, while the
    // terminal owns focus — exercising the mac seam refusal).
    await page.keyboard.press("Meta+BracketLeft");
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/1(?:$|[/?#])`));
    await page.keyboard.press("Meta+BracketRight");
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/2(?:$|[/?#])`));

    // The old shifted combo no longer matches on a mac host.
    await page.keyboard.press("Shift+Control+BracketLeft");
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/2(?:$|[/?#])`));
  });

  /**
   * Proves: the `shortcuts-overlay` default demotes to ⌘/ on macOS and
   * toggles the settings dialog's Shortcuts tab; the tab's macOS display
   * (initialized from the detected host) offers the single keyboard map's
   * modifier picker ("Holding ⌘ | ⇧⌘") with ⌘ selected by default and the ⌘
   * layer rendered; selecting ⇧⌘ swaps to the shifted layer.
   *
   * Steps:
   * 1. Spoof the mac platform; mock the backend; open `/default/1`.
   * 2. Press Meta+/ → the dialog opens on the Shortcuts tab.
   * 3. Assert the "Keyboard map modifier" picker group is visible with its ⌘
   *    option selected by default (`aria-pressed="true"`), the ⌘ layer
   *    rendered: the ⌘L cell shows the `web-address` binding's "address"
   *    keycap (⌘L), and no "address bar" cell exists — the old mac-browser ⌘L
   *    claim is removed.
   * 4. Click the ⇧⌘ option → it selects (`aria-pressed="true"`) and the
   *    shifted layer renders: the "address" keycap disappears (shifted KeyL
   *    is deliberately unbound), proving the layer swap.
   * 5. Press Meta+/ again → the dialog closes.
   */
  test("⌘/ toggles the Shortcuts tab on a mac host and the ⌘ map layer is selectable", async ({ page }) => {
    await spoofMacPlatform(page);
    await mockBackend(page);
    await gotoWindowOne(page);

    await page.keyboard.press("Meta+Slash");
    const dialog = page.getByRole("dialog", { name: "Settings" });
    const panel = page.getByTestId("settings-shortcuts-panel");
    await expect(panel).toBeVisible();
    // Display initializes from the detected (spoofed mac) host → the map
    // header offers the ⇧⌘ modifier layer (260801-r8j2), ⌘ selected by
    // default. The ⌘ layer renders: KeyL shows the web-address binding's
    // "address" keycap (⌘L, 260819-v6y4), and the old mac-browser
    // "address bar" claim on ⌘L is removed.
    const picker = panel.getByRole("group", { name: "Keyboard map modifier" });
    await expect(picker).toBeVisible();
    const cmdOption = picker.getByRole("button", { name: "⌘", exact: true });
    await expect(cmdOption).toHaveAttribute("aria-pressed", "true");
    await expect(panel.locator('[title="address"]')).toBeVisible();
    await expect(panel.locator('[title="address bar"]')).toHaveCount(0);
    // Selecting ⇧⌘ swaps to the shifted layer — the KeyL cell reads NOTHING
    // there (shifted KeyL is deliberately unbound), so the "address" keycap
    // disappearing proves the layer swap.
    const shiftedOption = picker.getByRole("button", { name: "⇧ ⌘" });
    await shiftedOption.click();
    await expect(shiftedOption).toHaveAttribute("aria-pressed", "true");
    await expect(panel.locator('[title="address"]')).toHaveCount(0);
    await page.keyboard.press("Meta+Slash");
    await expect(dialog).toHaveCount(0);
  });

  /**
   * Proves: `create-session` spends no chord on any mac host — its mac-keyless
   * default refinement leaves it unbound on both the shell and the browser —
   * so neither ⌘N nor ⇧⌘N dispatches anything; the action stays palette-only.
   *
   * Steps:
   * 1. Spoof the mac platform; mock the backend plus a POST-tracking route on
   *    the sessions API route glob; open `/default/1`.
   * 2. Press Meta+N, then Shift+Meta+N.
   * 3. Wait 300ms; assert no POST fired and the URL is unchanged.
   */
  test("⌘N and ⇧⌘N stay inert in a mac browser host (create-session palette-only)", async ({ page }) => {
    await spoofMacPlatform(page);
    await mockBackend(page);
    let created = false;
    await page.route("**/api/sessions*", (route) => {
      if (route.request().method() === "POST") {
        created = true;
        return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
      }
      return route.fallback();
    });
    await gotoWindowOne(page);

    // create-session spends no chord on any mac host (a mac-keyless default)
    // and reopen-window's ⇧⌘T is browser-reserved here — palette-only both.
    await page.keyboard.press("Meta+KeyN");
    await page.keyboard.press("Shift+Meta+KeyN");
    await page.waitForTimeout(300);
    expect(created).toBe(false);
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/1(?:$|[/?#])`));
  });

  /**
   * Proves: the `sidebar-toggle` `macTier: "cmd"` demotion applies in a mac
   * browser host (⌘B is page-interceptable; no claimed-keys entry on KeyB),
   * so the binding reaches the sidebar action.
   *
   * Steps:
   * 1. Spoof the mac platform; mock the backend; open `/default/1`; the
   *    current window's row carries `aria-current="page"`.
   * 2. Press Meta+B; assert the row takes DOM focus and the sidebar remains
   *    visible.
   */
  test("⌘B resolves to the sidebar action on a mac browser host", async ({ page }) => {
    await spoofMacPlatform(page);
    await mockBackend(page);
    await gotoWindowOne(page);

    const sidebar = page.locator('aside[aria-label="Sidebar"]');
    const currentRow = page
      .locator("nav[aria-label='Sessions']")
      .locator('[data-window-id] [aria-current="page"]');
    await expect(currentRow).toBeVisible();

    await expect(sidebar).toBeVisible();
    await page.keyboard.press("Meta+KeyB");
    await expect(currentRow).toBeFocused();
    await expect(sidebar).toBeVisible();
  });

  /**
   * Proves: on a mac host the `code-toggle` default resolves to ⌘2, but in a
   * mac BROWSER the ⌘1–9 digit layer is the browser's own tab-switching claim
   * set (`MAC_BROWSER_CMD_CLAIMS`), so the chord resolves `reserved` and
   * dispatches nothing — while `focus-hop` keeps its ⌃` default (the
   * registry's first shipped ctrl-tier default), which reaches the dispatcher
   * from under terminal focus via the seam's mac-only ctrl-tier refusal rule
   * (rule 3).
   *
   * Steps:
   * 1. Spoof the mac platform; mock the backend with the code-capable
   *    payload; open `/default/1`.
   * 2. Press Meta+2 → no code tile appears (the chord is browser-reserved
   *    here; it fires in the mac SHELL, covered by the unit per-host
   *    resolution tests).
   * 3. Press Control+` → the code tile opens and takes the
   *    `border-accent-green` focused-tile border.
   * 4. Press Control+` again → the accent border hops back to the tty tile;
   *    the code tile stays open.
   */
  test("⌘2 is inert in a mac BROWSER host (the browser's tab claim); ⌃` hops focus", async ({ page }) => {
    await spoofMacPlatform(page);
    await mockBackend(page, codeCapablePayload());
    await gotoWindowOne(page);

    const codeTile = page.getByTestId("surface-tile-code");
    const ttyTile = page.getByTestId("surface-tile-tty");

    // ⌘1–9 are the mac browser's tab-switching claims (MAC_BROWSER_CMD_CLAIMS),
    // so the ⌘2 tile chord resolves `reserved` (palette-only) here — the press
    // dispatches nothing (260819-qwr7 R2). The chord works in the mac SHELL.
    await expect(codeTile).toHaveCount(0);
    await page.keyboard.press("Meta+Digit2");
    await page.waitForTimeout(300);
    await expect(codeTile).toHaveCount(0);

    // ⌃` (the ctrl-tier refusal rule 3 under terminal focus) opens the
    // tile and hops focus to it; a second ⌃` hops back to the tty.
    await page.keyboard.press("Control+Backquote");
    await expect(codeTile).toBeVisible({ timeout: 10_000 });
    await expect(codeTile).toHaveClass(/border-accent-green/);
    await page.keyboard.press("Control+Backquote");
    await expect(ttyTile).toHaveClass(/border-accent-green/);
    await expect(codeTile).not.toHaveClass(/border-accent-green/);
  });
});

// Split chords (260807-rbx5): the divider pair ⇧Ctrl+\/⇧Ctrl+- on Win/Linux
// and ⌘D / ⇧⌘D on mac (the `macCode` refinement) reuse the
// `Tab: Split Horizontal|Vertical` palette bodies, so the assertion is
// the spawned `POST /api/windows/{id}/split` body. Both bound on every host.
async function mockSplit(page: Page) {
  const bodies: Record<string, unknown>[] = [];
  // Trailing `*` — the client appends `?server=`.
  await page.route("**/api/windows/*/split*", (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: '{"ok":true,"pane_id":"%2"}',
    });
  });
  return bodies;
}

test.describe("split chords (260807-rbx5)", () => {
  /**
   * Proves: the divider-pair chords reuse the
   * `Tab: Split Horizontal|Vertical` palette bodies — each fires one
   * `POST /api/windows/@1/split` carrying its direction and the window's
   * worktree path — while the terminal owns focus (the shifted-tier seam
   * refusal bubbles both chords).
   *
   * Steps:
   * 1. Mock the backend plus a body-capturing route on
   *    the window-split API route glob; open `/default/1`.
   * 2. Press Shift+Ctrl+\ → one POST; press Shift+Ctrl+- → a second POST.
   * 3. Assert the two bodies are `{horizontal: true, cwd: "/tmp/win-one"}`
   *    then `{horizontal: false, cwd: "/tmp/win-one"}`.
   */
  test("Shift+Ctrl+\\ and Shift+Ctrl+- split side-by-side then stacked on the terminal route", async ({ page }) => {
    await mockBackend(page);
    const splits = await mockSplit(page);
    await gotoWindowOne(page);

    await page.keyboard.press("Shift+Control+Backslash");
    await expect.poll(() => splits.length).toBe(1);
    await page.keyboard.press("Shift+Control+Minus");
    await expect.poll(() => splits.length).toBe(2);
    expect(splits).toEqual([
      { horizontal: true, cwd: "/tmp/win-one" },
      { horizontal: false, cwd: "/tmp/win-one" },
    ]);
  });

  /**
   * Proves: the effective map reaches the palette — on a Win/Linux host
   * `Tab: Split Horizontal` advertises `Shift+Ctrl+\` and
   * `Tab: Split Vertical` advertises `Shift+Ctrl+-` (both bound; the mac
   * `macCode` refinement never applies here).
   *
   * Steps:
   * 1. Mock the backend; open `/default/1`; open the palette (`openPalette`).
   * 2. Fill the filter with "Tab: Split" → both split entries render.
   * 3. Assert the texts `Shift+Ctrl+\` and `Shift+Ctrl+-` each appear exactly
   *    once.
   */
  test("the palette hints both splits with the divider-pair chords", async ({ page }) => {
    await mockBackend(page);
    await gotoWindowOne(page);

    const paletteInput = await openPalette(page);
    await paletteInput.fill("Tab: Split");
    await expect(page.getByText("Tab: Split Horizontal")).toBeVisible();
    await expect(page.getByText("Tab: Split Vertical")).toBeVisible();
    // One hint each: horizontal's ⇧Ctrl+\ and vertical's ⇧Ctrl+-.
    await expect(page.getByText("Shift+Ctrl+\\")).toHaveCount(1);
    await expect(page.getByText("Shift+Ctrl+-")).toHaveCount(1);
  });

  /**
   * Proves: on macOS (spoofed platform) both splits refine to the D keycap
   * (`macCode`), with `split-horizontal` also demoting to the unshifted ⌘
   * tier while `split-vertical` keeps the shifted ⇧⌘ tier — so the pair fires
   * from one keycap on different modifiers, ⌘D exercising the mac cmd-tier
   * seam refusal and ⇧⌘D the shifted-tier one.
   *
   * Steps:
   * 1. Spoof the mac platform; mock the backend plus the split-capturing
   *    route; open `/default/1`.
   * 2. Press Meta+D → one POST; press Shift+Meta+D → a second POST.
   * 3. Assert the two bodies are `{horizontal: true, cwd: "/tmp/win-one"}`
   *    then `{horizontal: false, cwd: "/tmp/win-one"}`.
   */
  test("⌘D and ⇧⌘D split horizontally then vertically on a mac host", async ({ page }) => {
    await spoofMacPlatform(page);
    await mockBackend(page);
    const splits = await mockSplit(page);
    await gotoWindowOne(page);

    // Both chords land while the terminal owns focus — ⌘D exercises the mac
    // cmd-tier seam refusal, ⇧⌘D the shifted-tier one.
    await page.keyboard.press("Meta+KeyD");
    await expect.poll(() => splits.length).toBe(1);
    await page.keyboard.press("Shift+Meta+KeyD");
    await expect.poll(() => splits.length).toBe(2);
    expect(splits).toEqual([
      { horizontal: true, cwd: "/tmp/win-one" },
      { horizontal: false, cwd: "/tmp/win-one" },
    ]);
  });
});

test.describe("VS Code-aligned chrome chords (B / 2 / Backquote)", () => {
  const sidebar = (page: Page) => page.locator('aside[aria-label="Sidebar"]');
  const codeTile = (page: Page) => page.getByTestId("surface-tile-code");
  const ttyTile = (page: Page) => page.getByTestId("surface-tile-tty");

  /**
   * Proves: the `sidebar-toggle` binding lives on the B keycap — the shifted
   * tier on Win/Linux — and fires the STATEFUL chord from the component-local
   * shell listener while the terminal owns focus: visible + focus outside →
   * focus the current window's row (the sidebar stays open); focus inside →
   * hide + return; hidden → reopen + refocus.
   *
   * Steps:
   * 1. Mock the backend; open `/default/1`; assert the
   *    `aside[aria-label="Sidebar"]` is visible and the current window's row
   *    carries `aria-current="page"`.
   * 2. Press Shift+Ctrl+B → the row takes DOM focus; the sidebar stays
   *    visible.
   * 3. Press Shift+Ctrl+B again (focus inside the sidebar) → the sidebar
   *    unmounts.
   * 4. Press Shift+Ctrl+B a third time → the sidebar returns and the row is
   *    focused again.
   */
  test("Shift+Ctrl+B runs the stateful sidebar chord: focus the current row, then hide, then reopen+focus", async ({ page }) => {
    await mockBackend(page);
    await gotoWindowOne(page);

    const currentRow = page
      .locator("nav[aria-label='Sessions']")
      .locator('[data-window-id] [aria-current="page"]');
    await expect(currentRow).toBeVisible();

    // First press (visible, focus outside): focus the current window's row —
    // the sidebar stays open (the stateful chord, 260819-qwr7 R5).
    await expect(sidebar(page)).toBeVisible();
    await page.keyboard.press("Shift+Control+KeyB");
    await expect(currentRow).toBeFocused();
    await expect(sidebar(page)).toBeVisible();
    // Second press (focus inside): hide + return. Third (hidden): reopen +
    // refocus the row.
    await page.keyboard.press("Shift+Control+KeyB");
    await expect(sidebar(page)).toHaveCount(0);
    await page.keyboard.press("Shift+Control+KeyB");
    await expect(sidebar(page)).toBeVisible();
    await expect(currentRow).toBeFocused();
  });

  /**
   * Proves: the `code-toggle` binding (⇧Ctrl+2 on Win/Linux) drives the
   * stateful tile chord through the shared layout-mutation path, gated on the
   * window carrying a derived `gitRoot`: hidden → open + focus on landing;
   * focused at arity 2 → hide + restore.
   *
   * Steps:
   * 1. Mock the backend with the code-capable payload (`gitRoot` on `@1`);
   *    open `/default/1`; assert no code tile exists.
   * 2. Press Shift+Ctrl+2 → the `surface-tile-code` tile appears and carries
   *    the `border-accent-green` focused-tile border (the landing focus).
   * 3. Press Shift+Ctrl+2 again → the tile hides (mounted-hidden — the
   *    hide-never-unmount rule).
   */
  test("Shift+Ctrl+2 toggles the code tile on a code-capable window", async ({ page }) => {
    await mockBackend(page, codeCapablePayload());
    await gotoWindowOne(page);

    // The stateful tile chord (260819-qwr7 R4): hidden → open + focus on
    // landing; focused at arity 2 → hide + restore.
    await expect(codeTile(page)).toHaveCount(0);
    await page.keyboard.press("Shift+Control+Digit2");
    await expect(codeTile(page)).toBeVisible({ timeout: 10_000 });
    await expect(codeTile(page)).toHaveClass(/border-accent-green/);
    await page.keyboard.press("Shift+Control+Digit2");
    // Hide-never-unmount: the closed tile stays mounted, hidden.
    await expect(codeTile(page)).toBeHidden({ timeout: 10_000 });
  });

  /**
   * Proves: the `focus-hop` binding implements VS Code's ⌃` gesture: pressed
   * with the code tile closed it OPENS the tile and moves the focused-tile
   * accent border to it (open-then-focus); pressed again it hops focus back
   * to the tty tile without closing anything.
   *
   * Steps:
   * 1. Mock the backend with the code-capable payload; open `/default/1`
   *    (slot A / tty holds the default focus).
   * 2. Press Shift+Ctrl+` → the code tile appears and carries
   *    `border-accent-green`; the tty tile loses it.
   * 3. Press Shift+Ctrl+` again → the tty tile carries the accent border, the
   *    code tile stays open and loses it.
   */
  test("Shift+Ctrl+` opens the closed code tile and hops focus, then hops back to the tty", async ({
    page,
  }) => {
    await mockBackend(page, codeCapablePayload());
    await gotoWindowOne(page);

    // Open-then-focus: the closed code tile opens AND takes the focused-tile
    // accent border (slot A / tty is the default focus).
    await expect(ttyTile(page)).toBeVisible();
    await page.keyboard.press("Shift+Control+Backquote");
    await expect(codeTile(page)).toBeVisible({ timeout: 10_000 });
    await expect(codeTile(page)).toHaveClass(/border-accent-green/);
    await expect(ttyTile(page)).not.toHaveClass(/border-accent-green/);

    // Second press hops focus back to the tty tile (no close — it's a hop).
    await page.keyboard.press("Shift+Control+Backquote");
    await expect(ttyTile(page)).toHaveClass(/border-accent-green/);
    await expect(codeTile(page)).not.toHaveClass(/border-accent-green/);
    await expect(codeTile(page)).toBeVisible();
  });
});

test.describe("browser-reserved keys", () => {
  /**
   * Proves: browser-reserved shifted keys (N/T/W) resolve disabled in a plain
   * browser host — the chord dispatches nothing (no create-session POST, no
   * navigation); the action remains reachable via the palette (asserted by
   * the hint/overlay tests' host-neutral entries).
   *
   * Steps:
   * 1. Mock the backend plus a POST-tracking route on the sessions API route
   *    glob.
   * 2. Open `/default/1`; press Shift+Ctrl+N.
   * 3. Wait 300ms; assert no POST fired and the URL is unchanged.
   */
  test("Shift+Ctrl+N is inert in a browser host (create-session stays palette-only)", async ({ page }) => {
    await mockBackend(page);
    let created = false;
    await page.route("**/api/sessions*", (route) => {
      if (route.request().method() === "POST") {
        created = true;
        return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
      }
      return route.fallback();
    });
    await gotoWindowOne(page);

    await page.keyboard.press("Shift+Control+KeyN");
    // Give a would-be dispatch time to fire the POST, then assert it did not.
    await page.waitForTimeout(300);
    expect(created).toBe(false);
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/1(?:$|[/?#])`));
  });
});


// Reopen-closed-tab chords. The mac-shell test spoofs BOTH host facts —
// navigator.platform (mac, for the macCode refinement) and the
// window.runkitShell bridge marker (shell presence, which drops the
// browser-reserved claims from the resolver). The ring lives server-side, so
// each test mocks `GET /api/windows/closed*` itself; the Win/Linux test rides
// the plain browser host where the shifted N/T defaults are NOT claimed (the
// mac-only "new window"/"reopen tab" claims don't apply), so the chords are
// live there.
const CLOSED_RECORD = {
  id: "1700000000000000001",
  closedAt: "2026-08-29T00:00:00Z",
  server: SERVER,
  session: "dev",
  window: { index: 3, id: "@9", name: "win-closed", panes: [{ id: "%9", index: 0, cwd: "/tmp/win-closed" }] },
};

test.describe("reopen closed tab chord", () => {
  /**
   * Proves: on the mac desktop shell ⇧⌘T is the reopen-closed-tab reflex —
   * with a non-empty recently-closed ring it dispatches `reopen-window`
   * (POST /api/windows/closed/{id}/reopen) and the app navigates to the
   * reopened window.
   *
   * Steps:
   * 1. Spoof the mac SHELL host (platform + runkitShell bridge marker).
   * 2. Mock the backend plus a one-record `GET /api/windows/closed*` listing
   *    and a body-capturing POST route on the reopen glob (trailing `*` — the
   *    client appends `?server=`); open `/default/1`.
   * 3. Press Shift+Meta+T → exactly one reopen POST for the record id, and
   *    the URL moves to the reopened window `/default/5`.
   */
  test("⇧⌘T reopens the top of the ring in the mac shell", async ({ page }) => {
    await spoofMacPlatform(page);
    await page.addInitScript(() => {
      window.runkitShell = { version: "1", platform: "darwin" };
    });
    await mockBackend(page);
    await page.route("**/api/windows/closed*", (route) => {
      const url = route.request().url();
      if (route.request().method() === "GET" && /\/api\/windows\/closed(\?|$)/.test(url)) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ closed: [CLOSED_RECORD] }),
        });
      }
      return route.fallback();
    });
    const reopenPosts: string[] = [];
    await page.route("**/api/windows/closed/*/reopen*", (route) => {
      reopenPosts.push(route.request().url());
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ server: SERVER, session: "dev", window: "win-closed", windowId: "@5" }),
      });
    });
    await gotoWindowOne(page);

    await page.keyboard.press("Shift+Meta+KeyT");
    await expect.poll(() => reopenPosts.length).toBe(1);
    expect(reopenPosts[0]).toContain(`/api/windows/closed/${CLOSED_RECORD.id}/reopen`);
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/5(?:$|[/?#])`));
  });

  /**
   * Proves: ⇧⌘T in the mac shell on an EMPTY ring is inert — the palette
   * entry's stack gating is the chord gating (no entry → no handler), so the
   * press makes no request and changes nothing.
   *
   * Steps:
   * 1. Spoof the mac SHELL host; mock the backend with an empty
   *    `GET /api/windows/closed*` listing and a counting POST route on the
   *    reopen glob; open `/default/1`.
   * 2. Press Shift+Meta+T.
   * 3. Wait 300ms; assert zero reopen POSTs and the URL is unchanged.
   */
  test("⇧⌘T on an empty ring makes no request (entry gated away)", async ({ page }) => {
    await spoofMacPlatform(page);
    await page.addInitScript(() => {
      window.runkitShell = { version: "1", platform: "darwin" };
    });
    await mockBackend(page);
    let reopenPosts = 0;
    await page.route("**/api/windows/closed*", (route) => {
      const url = route.request().url();
      if (route.request().method() === "GET" && /\/api\/windows\/closed(\?|$)/.test(url)) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: '{"closed":[]}',
        });
      }
      if (route.request().method() === "POST" && url.includes("/reopen")) reopenPosts++;
      return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
    });
    await gotoWindowOne(page);

    await page.keyboard.press("Shift+Meta+KeyT");
    await page.waitForTimeout(300);
    expect(reopenPosts).toBe(0);
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/1(?:$|[/?#])`));
  });

  /**
   * Proves: Win/Linux keeps its shifted-tier defaults — ⇧Ctrl+T still creates
   * a window (POST /api/sessions/{session}/windows) and ⇧Ctrl+N still opens
   * the session-name prompt — while `reopen-window` spends no chord there
   * (its keyless base leaves it palette-only). The chords are browser-reserved
   * in a plain browser host (the shifted N/T/W claims), so the test spoofs a
   * non-mac SHELL host (the runkitShell bridge marker, Linux platform) where
   * the defaults resolve live.
   *
   * Steps:
   * 1. Spoof the non-mac shell host; mock the backend (empty closed ring)
   *    plus a body-capturing POST route on the window-create glob (trailing
   *    `*` — the client appends `?server=`); open `/default/1`.
   * 2. Press Shift+Control+T → one create-window POST for session `dev`.
   * 3. Press Shift+Control+N → the session-name prompt dialog opens.
   */
  test("⇧Ctrl+T creates a window and ⇧Ctrl+N opens the session prompt (no regression)", async ({ page }) => {
    await page.addInitScript(() => {
      window.runkitShell = { version: "1", platform: "linux" };
    });
    await mockBackend(page);
    await page.route("**/api/windows/closed*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"closed":[]}' }),
    );
    const creates: string[] = [];
    await page.route("**/api/sessions/*/windows*", (route) => {
      if (route.request().method() === "POST") {
        creates.push(route.request().url());
        return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
      }
      return route.fallback();
    });
    await gotoWindowOne(page);

    await page.keyboard.press("Shift+Control+KeyT");
    await expect.poll(() => creates.length).toBe(1);
    expect(creates[0]).toContain("/api/sessions/dev/windows");

    await page.keyboard.press("Shift+Control+KeyN");
    await expect(page.getByRole("dialog")).toBeVisible();
  });
});
