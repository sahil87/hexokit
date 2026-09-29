import { test, expect, type Page } from "@playwright/test";
import { openPalette } from "./_ready";
import { mockStateSocket } from "./_state-socket-mock";

// Fully mocked (no tmux/wt/gh) — inject the state-socket `sessions` payload,
// the server list, and the riff endpoints via page.route, then drive the
// keyboard.
//
// Macro shortcut bindings over riff presets: the CUSTOM section of the
// settings dialog's Shortcuts tab — add-macro flow, command preview,
// missing-preset badge — macro chords dispatching `POST /api/riff` with the
// PRESET NAME only, success toast + navigation to the spawned window, the
// kind-tagged `Macro:` palette entry with its effective-combo hint, and the
// 400-toast path for a preset gone from fabconfig (no silent fallback).
//
// Route globs carry a trailing `*` — the client appends `?server=` (and the
// presets GET a `?session=`), so a bare glob would silently miss.
// `**/api/servers` → a single server `default`; `**/api/riff/presets*` → one
// preset `discuss` (deck-h, 2 panes), tier `default` — the preflight the
// Shortcuts tab fetches while visible; `**/api/riff?*` → the spawn seam, each
// POST body captured for assertion (200 riff-swift-fox `@9` or a 400 per
// test). The state socket's session `dev` carries windows `@1` "win-one"
// (active), `@2` "win-two", and `@9` "riff-swift-fox" — `@9` is the window
// the mocked spawn "creates", present in the static snapshot from the start
// so post-spawn navigation confirms instead of tripping the switch-confirm
// watchdog. `gotoWindowOne(page)` navigates to `/default/1` gated on
// "win-one"; `seedMacro(page, macro, code)` pre-seeds the `hexokit-macros` /
// `hexokit-keybindings` localStorage stores before page load. Chords are
// pressed as Shift+Control+<code> — the registry matches on
// KeyboardEvent.code and accepts Ctrl in place of Meta on every platform.

const SERVER = "default";

const DISCUSS_MACRO = {
  actionId: "macro:riff-discuss",
  kind: "macro",
  label: "riff: discuss",
  target: { type: "riff", preset: "discuss" },
};

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
      // `@9` is the window the mocked spawn "creates" — present in the state
      // payload from the start so post-spawn navigation confirms (the mock
      // socket replays a static snapshot; a truly-new window would trip the
      // switch-confirm watchdog).
      windows: [
        win(1, "win-one", true),
        win(2, "win-two", false),
        win(9, "riff-swift-fox", false),
      ],
    },
  ]);
}

type SpawnBehavior = { status: number; body: Record<string, unknown> };

const SPAWN_OK: SpawnBehavior = {
  status: 200,
  body: { server: SERVER, session: "dev", window: "riff-swift-fox", windowId: "@9" },
};

async function mockBackend(page: Page, spawn: SpawnBehavior = SPAWN_OK) {
  const spawnBodies: Record<string, unknown>[] = [];
  await page.routeWebSocket(/\/ws\/terminals/, () => {});
  await page.route("**/api/windows/*/select*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }),
  );
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ name: SERVER, sessionCount: 1 }]),
    }),
  );
  // The spawn dialog / overlay preflight: one preset, fab built-in tier.
  await page.route("**/api/riff/presets*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        presets: [{ name: "discuss", layout: "deck-h", paneCount: 2 }],
        tiers: ["default"],
      }),
    }),
  );
  // The spawn seam. `**/api/riff?*` matches only the POST URL (the `?server=`
  // query) — `/api/riff/presets` needs a `/` that the glob `?`/`*` never match.
  await page.route("**/api/riff?*", (route) => {
    spawnBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({
      status: spawn.status,
      contentType: "application/json",
      body: JSON.stringify(spawn.body),
    });
  });
  await mockStateSocket(page, { sessions: sessionsPayload() });
  return spawnBodies;
}

async function gotoWindowOne(page: Page) {
  await page.goto(`/${SERVER}/1`);
  await expect(page.getByText("win-one").first()).toBeVisible();
}

function seedMacro(page: Page, macro: Record<string, unknown>, code: string) {
  return page.addInitScript(
    ([m, c]) => {
      localStorage.setItem("hexokit-macros", JSON.stringify([m]));
      localStorage.setItem(
        "hexokit-keybindings",
        JSON.stringify({ [(m as { actionId: string }).actionId]: { code: c, tier: "shifted" } }),
      );
    },
    [macro, code] as const,
  );
}

test.describe("overlay add-macro flow", () => {
  /**
   * Proves: the whole macro lifecycle works end-to-end from the Shortcuts
   * tab — target picking (riff preset from the fetched preflight), naming,
   * one-flow key capture, persistence into the two localStorage stores, and
   * the chord dispatching a validated riff spawn that toasts and navigates.
   *
   * Steps:
   * 1. Mock the backend; open `/default/1`.
   * 2. Press Shift+Ctrl+/ to open the Shortcuts tab (the settings dialog opens
   *    on it); click `+ bind a key to a palette action or riff preset…`.
   * 3. Search targets for "discuss"; pick `riff: discuss`; the name input
   *    pre-fills with the target label; click `add + capture key`.
   * 4. Capture arms on the fresh row (`press keys…`); press Shift+Ctrl+D.
   * 5. Assert `hexokit-macros` holds the definition (`macro:riff-discuss` →
   *    preset `discuss`) and `hexokit-keybindings` holds
   *    `{code: "KeyD", tier: "shifted"}`; the row shows the preview
   *    `rk riff --preset discuss`.
   * 6. Escape closes the dialog; press Shift+Ctrl+D.
   * 7. Assert exactly one POST with body `{session: "dev", preset: "discuss"}`
   *    (preset name only — no shell text), the `Spawned riff-swift-fox` toast,
   *    and navigation to `/default/9`.
   */
  test("add a riff-preset macro, capture a key, and the chord spawns + navigates", async ({ page }) => {
    const spawnBodies = await mockBackend(page);
    await gotoWindowOne(page);

    // Open the Shortcuts tab (the settings dialog) and start the add flow.
    await page.keyboard.press("Shift+Control+Slash");
    const panel = page.getByTestId("settings-shortcuts-panel");
    await expect(panel).toBeVisible();
    await panel.getByText("+ bind a key to a palette action or riff preset…").click();

    // Target list = riff presets (from the mocked preflight) + palette actions.
    await page.getByLabel("Search macro targets").fill("discuss");
    await page.getByRole("button", { name: "riff: discuss" }).click();
    await expect(page.getByLabel("Macro name")).toHaveValue("riff: discuss");
    await page.getByRole("button", { name: "add + capture key" }).click();

    // Capture armed on the fresh row — land the chord.
    await expect(panel.getByText("press keys…")).toBeVisible();
    await page.keyboard.press("Shift+Control+KeyD");

    // Definition + combo persisted to their two stores.
    const storedMacros = await page.evaluate(() => localStorage.getItem("hexokit-macros"));
    expect(JSON.parse(storedMacros ?? "[]")).toEqual([DISCUSS_MACRO]);
    const storedBindings = await page.evaluate(() => localStorage.getItem("hexokit-keybindings"));
    expect(JSON.parse(storedBindings ?? "{}")).toEqual({
      "macro:riff-discuss": { code: "KeyD", tier: "shifted" },
    });
    // The row renders the resolved-command preview.
    await expect(panel.getByText("rk riff --preset discuss")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);

    // The chord POSTs the preset name only and navigates to the spawned window.
    await page.keyboard.press("Shift+Control+KeyD");
    await expect(page.getByText("Spawned riff-swift-fox")).toBeVisible();
    expect(spawnBodies).toEqual([{ session: "dev", preset: "discuss" }]);
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/9(?:$|[/?#])`));
  });
});

test.describe("palette exposure", () => {
  /**
   * Proves: macros are palette-reachable without their key (Constitution V) —
   * the `Macro: {label}` entry renders the effective combo as its shortcut
   * hint (via the shared `withShortcutHints` join on actionId) and selecting
   * it runs the same execution path as the chord.
   *
   * Steps:
   * 1. Seed the `discuss` macro bound to ⇧Ctrl+D; mock the backend; open
   *    `/default/1`.
   * 2. Open the palette (`openPalette`) and filter for "Macro".
   * 3. Assert `Macro: riff: discuss` is listed with the hint `Shift+Ctrl+D`
   *    (non-mac host formatting).
   * 4. Press Enter to select it; assert the spawn toast and the single POST
   *    body `{session: "dev", preset: "discuss"}`.
   */
  test("a seeded macro appears as a kind-tagged Macro: entry with its hint and executes", async ({ page }) => {
    await seedMacro(page, DISCUSS_MACRO, "KeyD");
    const spawnBodies = await mockBackend(page);
    await gotoWindowOne(page);

    const paletteInput = await openPalette(page);
    await paletteInput.fill("Macro");
    await expect(page.getByText("Macro: riff: discuss")).toBeVisible();
    // The effective combo decorates the entry (non-mac host → Shift+Ctrl+D).
    await expect(page.getByText("Shift+Ctrl+D")).toBeVisible();

    await page.keyboard.press("Enter");
    await expect(page.getByText("Spawned riff-swift-fox")).toBeVisible();
    expect(spawnBodies).toEqual([{ session: "dev", preset: "discuss" }]);
  });
});

test.describe("missing preset — no silent fallback", () => {
  /**
   * Proves: a macro whose preset no longer exists in fabconfig is never a
   * silent no-op — the CUSTOM row shows a `missing preset` badge once the
   * fetched preset list is known, and pressing the chord still POSTs (the
   * backend validates authoritatively) with the 400 error text surfacing as a
   * toast and no navigation.
   *
   * Steps:
   * 1. Seed a macro targeting preset `gone` bound to ⇧Ctrl+G; mock the
   *    backend with the spawn route returning 400 `unknown preset "gone" …`.
   * 2. Open `/default/1`; open the Shortcuts tab (⇧Ctrl+/).
   * 3. Assert the `missing preset` badge renders on the macro row (the mocked
   *    preflight defines only `discuss`); Escape closes the dialog.
   * 4. Press Shift+Ctrl+G; assert the error toast with the backend message,
   *    the single POST body `{session: "dev", preset: "gone"}`, and that the
   *    URL stays `/default/1`.
   */
  test("the overlay flags the row and the chord surfaces the backend 400 as a toast", async ({ page }) => {
    const GONE_MACRO = {
      ...DISCUSS_MACRO,
      actionId: "macro:gone",
      label: "riff: gone",
      target: { type: "riff", preset: "gone" },
    };
    await seedMacro(page, GONE_MACRO, "KeyG");
    const spawnBodies = await mockBackend(page, {
      status: 400,
      body: { error: 'unknown preset "gone" (defined: discuss)' },
    });
    await gotoWindowOne(page);

    // The CUSTOM row carries the error badge once the preset list is known.
    await page.keyboard.press("Shift+Control+Slash");
    const panel = page.getByTestId("settings-shortcuts-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByText("missing preset")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);

    // The chord still POSTs (the backend is authoritative) and the 400
    // surfaces as an error toast; nothing navigates.
    await page.keyboard.press("Shift+Control+KeyG");
    await expect(page.getByText(/unknown preset "gone"/)).toBeVisible();
    expect(spawnBodies).toEqual([{ session: "dev", preset: "gone" }]);
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/1(?:$|[/?#])`));
  });
});
