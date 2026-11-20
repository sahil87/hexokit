/**
 * Demo: the Agents tab's per-role model cell — what the model list offers once
 * a model is saved, what a tool change does to a pinned model, and how a pin
 * the tool doesn't list is surfaced.
 *
 * Runs only under `just demo agents-model-list` (playwright.demo.config.ts —
 * testDir ./tests/demo), against the throwaway e2e rig, once per project
 * (desktop 1280x800, mobile 375x812), and records the same spec against the
 * base ref with `--before`. The spec therefore drives either shape of the
 * cell: a text input with a `<datalist>` or a `<select>`.
 *
 * Shared setup: `/api/fab-config` is stubbed in the browser (the stateful
 * `_fab-config-stub` helper) so the recording never touches the developer's
 * real ~/.fab-kit/config.yaml; the stub seeds `review`'s model with
 * `claude-opus-4-1`, a pin claude's list doesn't carry. Native select and
 * datalist popups are drawn outside the page and never reach the recording,
 * so a caption overlay prints what the list offers (for a datalist: the
 * suggestions Chromium keeps for the input's current text) and each POST body
 * the stub received.
 */
import type { Page } from "@playwright/test";
import { test, expect, beat } from "./_demo";
import { openPalette } from "../e2e/_ready";
import { stubFabConfig } from "../e2e/_fab-config-stub";

async function caption(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    let el = document.getElementById("demo-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "demo-caption";
      Object.assign(el.style, {
        position: "fixed",
        left: "8px",
        right: "8px",
        bottom: "8px",
        zIndex: "2147483647",
        background: "rgba(0, 0, 0, 0.85)",
        color: "#fff",
        font: "12px/1.45 monospace",
        padding: "8px 10px",
        borderRadius: "6px",
        whiteSpace: "pre-wrap",
        pointerEvents: "none",
      });
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
}

/** What the role's model list offers right now, in display order. */
async function modelList(page: Page, role: string): Promise<string[]> {
  return page.getByLabel(`${role} model`, { exact: true }).evaluate((el) => {
    if (el instanceof HTMLSelectElement) return Array.from(el.options).map((o) => o.textContent ?? "");
    if (el instanceof HTMLInputElement && el.list) {
      const typed = el.value.toLowerCase();
      return Array.from(el.list.options)
        .map((o) => o.value)
        .filter((v) => v.toLowerCase().includes(typed));
    }
    return [];
  });
}

async function modelValue(page: Page, role: string): Promise<string> {
  return page.getByLabel(`${role} model`, { exact: true }).inputValue();
}

test.describe("agents-model-list demo", () => {
  /**
   * Proves: a reviewer can see that a saved model leaves the model list whole,
   * that switching a role's tool clears a model the new tool doesn't offer,
   * and how an unlisted pin is flagged.
   *
   * Steps:
   * 1. Seed `review`'s model with `claude-opus-4-1`; install the stub; open
   *    Settings → Agents from the palette; `beat()`.
   * 2. Save `claude-sonnet-5-5` as `doing`'s model (pick it from the select,
   *    or type it and press Enter in the input); caption the POST.
   * 3. Switch to General and back so the panel re-reads; caption what
   *    `doing`'s model list offers; `beat()`.
   * 4. Switch `doing`'s tool to `codex`; caption the POST and the model cell's
   *    value; `beat()`.
   * 5. Scroll to `review`; caption its pin and, when a stale-pin note is
   *    shown, click its inherit action and caption that POST; `beat()`.
   */
  test("model list after a save, tool change, and a stale pin", async ({ page }) => {
    const posts = await stubFabConfig(page, {
      systemPath: "/home/demo/.fab-kit/config.yaml",
      system: { "agent.profiles.review.model": "claude-opus-4-1" },
    });

    await page.goto("/");
    const palette = await openPalette(page);
    await palette.fill("Settings: Agents");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tab", { name: "Agents" })).toHaveAttribute("aria-selected", "true");
    await beat(page);

    const doing = page.getByLabel("doing model", { exact: true });
    await doing.scrollIntoViewIfNeeded();
    if ((await doing.evaluate((el) => el.tagName)) === "SELECT") {
      await doing.selectOption("claude-sonnet-5-5");
    } else {
      await doing.fill("claude-sonnet-5-5");
      await doing.press("Enter");
    }
    await expect(doing).toHaveValue("claude-sonnet-5-5");
    await caption(page, `Saved doing's model\nPOST ${JSON.stringify(posts.at(-1))}`);
    await beat(page, 1_500);

    await page.getByRole("tab", { name: "General" }).click();
    await page.getByRole("tab", { name: "Agents" }).click();
    await doing.scrollIntoViewIfNeeded();
    await expect(doing).toHaveValue("claude-sonnet-5-5");
    await caption(
      page,
      `Reopened the tab — doing's model list offers:\n  ${(await modelList(page, "doing")).join("\n  ")}`,
    );
    await beat(page, 2_500);

    const postsBefore = posts.length;
    await page.getByLabel("doing CLI", { exact: true }).selectOption("codex");
    await expect.poll(() => posts.length).toBeGreaterThan(postsBefore);
    await expect(page.getByLabel("doing CLI", { exact: true })).toHaveValue("codex");
    await caption(
      page,
      `Switched doing's tool to codex\nPOST ${JSON.stringify(posts.at(-1))}\ndoing's model is now: ${(await modelValue(page, "doing")) || "(inherit)"}`,
    );
    await beat(page, 2_500);

    const review = page.getByTestId("role-row-review");
    await review.scrollIntoViewIfNeeded();
    const stale = page.getByTestId("stale-model-review");
    if (await stale.count()) {
      await stale.scrollIntoViewIfNeeded();
      await caption(page, `review is pinned to claude-opus-4-1 — claude's list doesn't carry it`);
      await beat(page, 2_000);
      const postsBeforeInherit = posts.length;
      await stale.getByRole("button").click();
      await expect.poll(() => posts.length).toBeGreaterThan(postsBeforeInherit);
      await expect(stale).toHaveCount(0);
      await caption(page, `Clicked the note's inherit action\nPOST ${JSON.stringify(posts.at(-1))}`);
    } else {
      await caption(
        page,
        `review is pinned to claude-opus-4-1 — claude's list doesn't carry it\nmodel list offers: ${(await modelList(page, "review")).join(", ") || "(nothing)"}`,
      );
    }
    await beat(page, 2_500);
  });
});
