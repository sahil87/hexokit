import { test, expect, type Page } from "@playwright/test";
import { openPalette } from "./_ready";
import { mockStateSocket } from "./_state-socket-mock";

// Operator compose — spawn routing & semantic search: the two palette verbs,
// the shared dialog, the per-verb toasts, the structured-failure toast, and
// the no-operator gating. Fully mocked (no tmux): the sessions payload rides
// the state-socket mock — a work window `@1` plus, when the test wants one,
// an operator window `@9` with `role: "operator"` in `_rk-operator` — and the
// server-scoped operator-request endpoint is stubbed via page.route. The
// route mock carries a trailing `*` — the client appends `?server=`
// (withServer), so a bare glob would silently miss. Each spec lands on the
// `@1` terminal route before driving the palette.

const SERVER = "default";

function sessionsPayload(withOperator: boolean) {
  const work = {
    windowId: "@1",
    index: 0,
    name: "feature-work",
    worktreePath: "/tmp/wt",
    activity: "active",
    isActiveWindow: true,
    activityTimestamp: 0,
    agentState: "idle",
    panes: [
      { paneId: "%1", paneIndex: 0, cwd: "/tmp/wt", command: "zsh", isActive: true },
    ],
  };
  return JSON.stringify([
    { name: "dev", windows: [work] },
    ...(withOperator
      ? [
          {
            name: "_rk-operator",
            windows: [
              {
                windowId: "@9",
                index: 0,
                name: "operator",
                worktreePath: "/tmp/op",
                activity: "idle",
                isActiveWindow: false,
                activityTimestamp: 0,
                role: "operator",
                agentState: "idle",
                panes: [
                  { paneId: "%9", paneIndex: 0, cwd: "/tmp/op", command: "claude", isActive: true },
                ],
              },
            ],
          },
        ]
      : []),
  ]);
}

type OpBehavior = { status: number; body: Record<string, unknown> };

const OP_OK: OpBehavior = { status: 200, body: { ok: true } };

/** Install the fully-mocked backend; returns the recorded request bodies. */
async function mockBackend(page: Page, withOperator: boolean, behavior: OpBehavior = OP_OK) {
  const opBodies: Record<string, unknown>[] = [];
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
  // The server-scoped operator-request seam — trailing `*` required
  // (withServer appends `?server=`).
  await page.route("**/api/operator-request*", (route) => {
    opBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({
      status: behavior.status,
      contentType: "application/json",
      body: JSON.stringify(behavior.body),
    });
  });
  await mockStateSocket(page, { sessions: sessionsPayload(withOperator) });
  return opBodies;
}

const WINDOW_URL = `/${SERVER}/%401`;

async function gotoWindow(page: Page) {
  await page.goto(WINDOW_URL);
  await expect(page.getByText("feature-work").first()).toBeVisible({ timeout: 10_000 });
}

async function openPaletteWith(page: Page, query: string) {
  const paletteInput = await openPalette(page);
  await paletteInput.fill(query);
}

test.describe("Operator compose (260822-wyn3)", () => {
  /**
   * Proves: the palette verb opens the compose dialog with the spawn mode
   * active and the input focused, and submitting POSTs
   * `{template: "spawn-task", text}` to the server-scoped endpoint, closing
   * the dialog and toasting "Sent to operator — it will spawn the agent".
   *
   * Steps:
   * 1. Mock the backend with an operator window and a 200 operator-request
   *    stub.
   * 2. Open the palette, filter to `Operator:`, select
   *    `Operator: Spawn task…`.
   * 3. Assert the dialog shows with the "Spawn task" segment `aria-pressed`
   *    and the input focused.
   * 4. Type "fix the flaky test", press Enter.
   * 5. Assert exactly one POST body
   *    `{template: "spawn-task", text: "fix the flaky test"}`, the dialog
   *    closed, and the spawn-wording toast visible.
   */
  test("palette 'Operator: Spawn task…' opens the dialog pre-selected to spawn; Enter submits the body and toasts the spawn wording", async ({
    page,
  }) => {
    const opBodies = await mockBackend(page, true);
    await gotoWindow(page);

    await openPaletteWith(page, "Operator:");
    await page.getByRole("option", { name: "Operator: Spawn task…" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Spawn task" })).toHaveAttribute("aria-pressed", "true");
    const input = dialog.getByRole("textbox", { name: "Spawn task" });
    await expect(input).toBeFocused();
    await input.fill("fix the flaky test");
    await input.press("Enter");

    await expect.poll(() => opBodies).toEqual([{ template: "spawn-task", text: "fix the flaky test" }]);
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText("Sent to operator — it will spawn the agent")).toBeVisible();
  });

  /**
   * Proves: the find verb mirrors the spawn verb — pre-selected find mode,
   * `{template: "find-discussion", text}` POST, and the "…answer appears in
   * the operator tab" toast.
   *
   * Steps:
   * 1. Mock the backend with an operator window and a 200 operator-request
   *    stub.
   * 2. Open the palette, filter to `Operator:`, select
   *    `Operator: Find discussion…`.
   * 3. Assert the "Find discussion" segment is `aria-pressed`.
   * 4. Type "where did we discuss the fence length", press Enter.
   * 5. Assert the POST body `{template: "find-discussion", text: …}` and the
   *    find-wording toast.
   */
  test("palette 'Operator: Find discussion…' opens the dialog pre-selected to find; Enter submits the query and toasts the find wording", async ({
    page,
  }) => {
    const opBodies = await mockBackend(page, true);
    await gotoWindow(page);

    await openPaletteWith(page, "Operator:");
    await page.getByRole("option", { name: "Operator: Find discussion…" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Find discussion" })).toHaveAttribute("aria-pressed", "true");
    const input = dialog.getByRole("textbox", { name: "Find discussion" });
    await input.fill("where did we discuss the fence length");
    await input.press("Enter");

    await expect
      .poll(() => opBodies)
      .toEqual([{ template: "find-discussion", text: "where did we discuss the fence length" }]);
    await expect(page.getByText("Sent to operator — the answer appears in the operator tab")).toBeVisible();
  });

  /**
   * Proves: the busy-operator 409's structured `error` message reaches the
   * user as the error toast (the `throwOnError` seam), not a generic failure.
   *
   * Steps:
   * 1. Mock the backend with an operator window and a 409 stub carrying the
   *    busy message.
   * 2. Open the dialog via `Operator: Spawn task…`, type a task, press Enter.
   * 3. Assert the POST fired and the toast carries the server's
   *    "operator is busy (active) …" message.
   */
  test("a structured backend 409 surfaces as the failure toast", async ({ page }) => {
    const opBodies = await mockBackend(page, true, {
      status: 409,
      body: { error: "operator is busy (active) — request not delivered; try again when it is idle" },
    });
    await gotoWindow(page);

    await openPaletteWith(page, "Operator:");
    await page.getByRole("option", { name: "Operator: Spawn task…" }).click();
    const dialog = page.getByRole("dialog");
    const input = dialog.getByRole("textbox", { name: "Spawn task" });
    await input.fill("fix the flaky test");
    await input.press("Enter");

    await expect.poll(() => opBodies).toHaveLength(1);
    await expect(page.getByText(/operator is busy \(active\)/)).toBeVisible();
  });

  /**
   * Proves: the degrade-to-absent gate — with no `role: "operator"` window in
   * the sessions payload, both compose-dialog `Operator:` palette entries are
   * omitted (not disabled). The six quake terminal entries — the openers
   * `Operator: Open quake terminal`, `Operator: Show tasks`, `Operator: Show
   * activity`, `Operator: Show cron`,
   * `Operator: Check now` (the loop is server-wide) and the geometry reset
   * `Operator: Reset quake terminal size` — are deliberately ungated: the
   * quake terminal itself opens and shows the no-operator body (and the cron
   * clock is server-wide, operator or not; the reset is a per-viewer store
   * write). The inverse gate lists `Operator: Start operator` exactly here —
   * it exists only while the server has no operator — so seven `Operator:`
   * entries are the complete operator-less set.
   *
   * Steps:
   * 1. Mock the backend WITHOUT an operator window.
   * 2. Open the palette, filter to `Operator:`.
   * 3. Assert both compose entries are absent, the six quake terminal
   *    entries plus `Operator: Start operator` are the only seven listed.
   */
  test("compose palette entries are omitted when the server has no operator window", async ({ page }) => {
    await mockBackend(page, false);
    await gotoWindow(page);

    await openPaletteWith(page, "Operator:");
    await expect(page.getByRole("option", { name: "Operator: Spawn task…" })).toHaveCount(0);
    await expect(page.getByRole("option", { name: "Operator: Find discussion…" })).toHaveCount(0);
    await expect(page.getByRole("option", { name: /^Operator:/ })).toHaveCount(7);
    await expect(page.getByRole("option", { name: "Operator: Start operator" })).toHaveCount(1);
    await expect(page.getByRole("option", { name: "Operator: Open quake terminal" })).toHaveCount(1);
    await expect(page.getByRole("option", { name: "Operator: Show tasks" })).toHaveCount(1);
    await expect(page.getByRole("option", { name: "Operator: Show activity" })).toHaveCount(1);
    await expect(page.getByRole("option", { name: "Operator: Check now" })).toHaveCount(1);
    await expect(page.getByRole("option", { name: "Operator: Show cron", exact: true })).toHaveCount(1);
    await expect(page.getByRole("option", { name: "Operator: Reset quake terminal size" })).toHaveCount(1);
  });
});
