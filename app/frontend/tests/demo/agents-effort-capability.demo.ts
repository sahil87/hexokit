/**
 * Demo: the Agents tab's effort select for a tool whose commands carry no
 * `{effort}` — what the select offers on such a role, and what a tool change
 * onto such a tool does to a saved effort.
 *
 * Runs only under `just demo agents-effort-capability`
 * (playwright.demo.config.ts — testDir ./tests/demo), against the throwaway
 * e2e rig, once per project (desktop 1280x800, mobile 375x812), and records
 * the same spec against the base ref with `--before`.
 *
 * Shared setup: `/api/fab-config` is stubbed in the browser (the stateful
 * `_fab-config-stub` helper) so the recording never touches the developer's
 * real ~/.fab-kit/config.yaml; the stub seeds `review` on `kimi` with a saved
 * effort of `high`, and `doing` on `codex` with `high`. Native select popups
 * are drawn outside the page and never reach the recording, so a caption
 * overlay prints each select's state and each POST body the stub received.
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

/** One line describing a role's effort select: value, enabled state, title. */
async function effortState(page: Page, role: string): Promise<string> {
  return page.getByLabel(`${role} effort`, { exact: true }).evaluate((el) => {
    if (!(el instanceof HTMLSelectElement)) return "(not a select)";
    const value = el.value || "(inherit)";
    const state = el.disabled ? "disabled" : "enabled";
    return `${value} · ${state}${el.title ? ` · title "${el.title}"` : ""}`;
  });
}

test.describe("agents-effort-capability demo", () => {
  /**
   * Proves: a reviewer can see whether the effort select is offered on a
   * role whose tool takes no effort, and what a tool change onto such a tool
   * sends for a saved effort.
   *
   * Steps:
   * 1. Seed `review` on kimi with effort `high` and `doing` on codex with
   *    effort `high`; install the stub; open Settings → Agents; `beat()`.
   * 2. Scroll to `review`; caption its effort select state; `beat()`.
   * 3. Switch `doing`'s tool to `agy`; caption the POST and `doing`'s effort
   *    select state; `beat()`.
   */
  test("effort select on tools without {effort}", async ({ page }) => {
    const posts = await stubFabConfig(page, {
      systemPath: "/home/demo/.fab-kit/config.yaml",
      system: {
        "agent.profiles.review.provider": "kimi",
        "agent.profiles.review.effort": "high",
        "agent.profiles.doing.provider": "codex",
        "agent.profiles.doing.effort": "high",
      },
    });

    await page.goto("/");
    const palette = await openPalette(page);
    await palette.fill("Settings: Agents");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tab", { name: "Agents" })).toHaveAttribute("aria-selected", "true");
    await beat(page);

    await page.getByTestId("role-row-review").scrollIntoViewIfNeeded();
    await caption(page, `review runs on kimi (its commands carry no {effort})\neffort select: ${await effortState(page, "review")}`);
    await beat(page, 2_500);

    await page.getByTestId("role-row-doing").scrollIntoViewIfNeeded();
    const postsBefore = posts.length;
    await page.getByLabel("doing provider", { exact: true }).selectOption("agy");
    await expect.poll(() => posts.length).toBeGreaterThan(postsBefore);
    await expect(page.getByLabel("doing provider", { exact: true })).toHaveValue("agy");
    await caption(
      page,
      `Switched doing from codex (effort high) to agy\nPOST ${JSON.stringify(posts.at(-1))}\neffort select: ${await effortState(page, "doing")}`,
    );
    await beat(page, 2_500);
  });
});
