import { test, expect, type Page } from "@playwright/test";
import { mockStateSocket, emitSessions } from "./_state-socket-mock";

// The Tasks segment's "Needs you" band and its note composer, on the desktop
// operator route (`?tab=tasks` is the page's segment state; the mobile mount is
// the same component).
//
// Shared setup: fully mocked (no tmux, no state file on disk). The sessions
// payload rides the state-socket mock — a work window `@1` and an operator
// window `@9` (`role: "operator"` in `_rk-operator`) — with the operator's
// tracked list carried on `dev`: `pr-41` whose newest note is the engine's
// `by: run` `escalated:` note, and a quiet `n3`. `emitSessions` flips the
// payload mid-test to the post-write shape (the escalation answered by a
// newer `by: user` note), the SSE-equivalent of the next sessions tick.
// `POST /api/operator/notes` and `POST /api/operator/wake` are stubbed via
// page.route and record their bodies; `GET /api/operator/notes*` serves the
// item's notes for the table's expand. `/ws/terminals` is a no-op socket mock.
// No host-global state is saved or restored.

const SERVER = "default";
const OPERATOR_PATH = `/${SERVER}/9`;
const NOW = Math.floor(Date.now() / 1000);

const ESCALATION = { at: NOW - 300, by: "run", text: "escalated: spawn interrupted: no pane" };
const ANSWER = { at: NOW, by: "user", text: "retry from the queue" };

function sessionsPayload(prLatest: typeof ESCALATION) {
  const tracked = [
    {
      id: "pr-41",
      kind: "github-pr",
      updatedAt: prLatest.at,
      latestNote: prLatest,
      noteCount: prLatest === ESCALATION ? 1 : 2,
    },
    { id: "n3", kind: "note", updatedAt: NOW - 3600 },
  ];
  return JSON.stringify([
    {
      name: "dev",
      operatorLastTickAt: NOW - 60,
      operatorTracked: tracked,
      windows: [
        {
          windowId: "@1",
          index: 0,
          name: "feature-work",
          worktreePath: "/tmp/wt",
          activity: "active",
          isActiveWindow: true,
          activityTimestamp: 0,
          panes: [{ paneId: "%1", paneIndex: 0, cwd: "/tmp/wt", command: "zsh", isActive: true }],
        },
      ],
    },
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
          panes: [{ paneId: "%9", paneIndex: 0, cwd: "/tmp/op", command: "claude", isActive: true }],
        },
      ],
    },
  ]);
}

/** Install the mocked backend; returns the captured note and wake bodies. */
async function mockBackend(page: Page, opts: { noteStatus?: number; noteError?: string } = {}) {
  const noteBodies: Record<string, unknown>[] = [];
  const wakeBodies: Record<string, unknown>[] = [];
  await mockStateSocket(page, { sessions: sessionsPayload(ESCALATION) });
  await page.routeWebSocket(/\/ws\/terminals/, () => {});
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ name: SERVER, sessionCount: 2 }]),
    }),
  );
  await page.route("**/api/cron*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ entries: [], deliveries: [] }),
    }),
  );
  await page.route("**/api/operator/notes*", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "pr-41", notes: [ESCALATION, ANSWER] }),
      });
    }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    noteBodies.push(body);
    if (opts.noteStatus !== undefined && opts.noteStatus >= 400) {
      return route.fulfill({
        status: opts.noteStatus,
        contentType: "application/json",
        body: JSON.stringify({ error: opts.noteError ?? "rejected" }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: body.id, note: { at: NOW, by: "user", text: body.text } }),
    });
  });
  await page.route("**/api/operator/wake", (route) => {
    wakeBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ server: SERVER, reason: "note:pr-41" }),
    });
  });
  return { noteBodies, wakeBodies };
}

test.describe("operator Tasks — Needs you band", () => {
  /**
   * Proves: an open escalation shows as one `Needs you` row with the item id
   * and the wanted action; writing a note from the row's composer posts the
   * note, wakes the loop with `note:<id>`, and — once the next sessions
   * payload carries the answer — the band disappears.
   *
   * Steps:
   * 1. Mock the backend with `pr-41` carrying an `escalated:` run note as its
   *    newest note; land on the operator route's Tasks segment.
   * 2. Assert the band reads `Needs you · 1` with a `pr-41` row showing the
   *    reason after the `escalated:` prefix, and no `open pane` (no live
   *    window).
   * 3. Click `note…`, type a note and press Enter.
   * 4. Assert one note POST (`{server, id: pr-41, text}`) then one wake POST
   *    with reason `note:pr-41`, the composer closed and `note saved · check
   *    queued` shown.
   * 5. Push the post-write payload (a newer `by: user` note); assert the
   *    band is gone.
   */
  test("an escalation row takes a note, wakes the loop, and clears on the next payload", async ({
    page,
  }) => {
    const { noteBodies, wakeBodies } = await mockBackend(page);
    await page.goto(`${OPERATOR_PATH}?tab=tasks`);

    const band = page.getByTestId("needs-you-band");
    await expect(band).toBeVisible({ timeout: 10_000 });
    await expect(band).toContainText("Needs you · 1");
    const row = band.getByTestId("needs-you-row");
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-item-id", "pr-41");
    await expect(row).toContainText("spawn interrupted: no pane");
    await expect(row.getByTestId("needs-you-open-pane")).toHaveCount(0);

    await row.getByTestId("needs-you-note").click();
    const input = row.getByTestId("operator-note-input");
    await expect(input).toBeFocused();
    await input.fill("retry from the queue");
    await input.press("Enter");

    await expect(page.getByTestId("needs-you-status")).toHaveText("note saved · check queued");
    expect(noteBodies).toEqual([{ server: SERVER, id: "pr-41", text: "retry from the queue" }]);
    expect(wakeBodies).toEqual([{ server: SERVER, reason: "note:pr-41" }]);
    await expect(row.getByTestId("operator-note-composer")).toHaveCount(0);

    emitSessions(SERVER, sessionsPayload(ANSWER));
    await expect(page.getByTestId("needs-you-band")).toHaveCount(0);
  });

  /**
   * Proves: a rejected write keeps the composer open with the draft and the
   * server's message, and does not wake the loop.
   *
   * Steps:
   * 1. Mock the backend so `POST /api/operator/notes` answers 400 with a
   *    validation message; land on the Tasks segment.
   * 2. Open `note…` on the `pr-41` row and submit a note.
   * 3. Assert the alert shows the server's message, the draft is intact, and
   *    no wake POST was made.
   */
  test("a rejected note keeps the composer open with the message and never wakes", async ({
    page,
  }) => {
    const { wakeBodies } = await mockBackend(page, {
      noteStatus: 400,
      noteError: "note text is 1100 characters, over the 1000-character cap",
    });
    await page.goto(`${OPERATOR_PATH}?tab=tasks`);

    const row = page.getByTestId("needs-you-row");
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.getByTestId("needs-you-note").click();
    const input = row.getByTestId("operator-note-input");
    await input.fill("too long");
    await input.press("Enter");

    await expect(row.getByRole("alert")).toContainText("over the 1000-character cap");
    await expect(input).toHaveValue("too long");
    expect(wakeBodies).toEqual([]);
  });

  /**
   * Proves: a Tasks segment with nothing needing the user renders no band.
   *
   * Steps:
   * 1. Mock the backend and land on the Tasks segment; assert the band shows
   *    for the open escalation.
   * 2. Push a payload whose newest note is the user's answer.
   * 3. Assert no `needs-you-band` exists and the ledger table still renders.
   */
  test("no band renders when nothing needs the user", async ({ page }) => {
    await mockBackend(page);
    await page.goto(`${OPERATOR_PATH}?tab=tasks`);
    await expect(page.getByTestId("needs-you-band")).toBeVisible({ timeout: 10_000 });

    emitSessions(SERVER, sessionsPayload(ANSWER));

    await expect(page.getByTestId("needs-you-band")).toHaveCount(0);
    await expect(page.getByTestId("watched-table")).toBeVisible();
  });
});
