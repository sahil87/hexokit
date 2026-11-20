/**
 * Demo: the Agents tab's "use the CLI's own default model" value — how a role
 * already holding fab's reserved `tool-default` value reads, and whether the
 * model list offers it.
 *
 * Runs only under `just demo agents-tool-default` (playwright.demo.config.ts —
 * testDir ./tests/demo), against the throwaway e2e rig, once per project
 * (desktop 1280x800, mobile 375x812), and records the same spec against an
 * earlier ref with `--before`; every step therefore tolerates a list without
 * the tool-default entry.
 *
 * Shared setup: `/api/fab-config` is stubbed in the browser (the stateful
 * `_fab-config-stub` helper) so the recording never touches the developer's
 * real ~/.fab-kit/config.yaml; the stub seeds `review` on codex holding
 * `tool-default`. Native select popups are drawn outside the page and never
 * reach the recording, so a caption overlay prints what a list offers and
 * each POST body the stub received.
 */
import type { Page } from "@playwright/test";
import { test, expect, beat } from "./_demo";
import { openPalette } from "../e2e/_ready";
import { stubFabConfig } from "../e2e/_fab-config-stub";

const TOOL_DEFAULT_OPTION = /^↳ tool default/;

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

async function selectOptions(page: Page, label: string): Promise<string[]> {
  return page
    .getByLabel(label, { exact: true })
    .evaluate((el) => (el instanceof HTMLSelectElement ? Array.from(el.options).map((o) => o.textContent ?? "") : []));
}

async function selectedText(page: Page, label: string): Promise<string> {
  return page
    .getByLabel(label, { exact: true })
    .evaluate((el) => (el instanceof HTMLSelectElement ? (el.selectedOptions[0]?.textContent ?? "") : ""));
}

test.describe("agents-tool-default demo", () => {
  /**
   * Proves: a reviewer can see how a role holding the tool-default value
   * reads (as the CLI's default, or as a stale pin), and that the model list
   * offers the value as its second entry and writes it on pick.
   *
   * Steps:
   * 1. Seed `review` on codex holding `tool-default`; install the stub; open
   *    Settings → Agents from the palette; `beat()`.
   * 2. Scroll to `review`; caption what its model cell shows, whether a
   *    stale-pin note is shown, and its effort options; `beat()`.
   * 3. Caption what `doing`'s model list offers; when it has a tool-default
   *    entry, pick it and caption the POST; `beat()`.
   */
  test("tool-default value in the role model list", async ({ page }) => {
    const posts = await stubFabConfig(page, {
      systemPath: "/home/demo/.fab-kit/config.yaml",
      system: { "agent.profiles.review.tool": "codex", "agent.profiles.review.model": "tool-default" },
    });

    await page.goto("/");
    const palette = await openPalette(page);
    await palette.fill("Settings: Agents");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tab", { name: "Agents" })).toHaveAttribute("aria-selected", "true");
    await beat(page);

    const review = page.getByTestId("role-row-review");
    await review.scrollIntoViewIfNeeded();
    const stale = page.getByTestId("stale-model-review");
    if (await stale.count()) await stale.scrollIntoViewIfNeeded();
    await caption(
      page,
      [
        "review (codex) holds fab's reserved value tool-default",
        `model cell shows: ${await selectedText(page, "review model")}`,
        `stale-pin note: ${(await stale.count()) ? `"${(await stale.textContent())?.trim()}"` : "none"}`,
        `effort options: ${(await selectOptions(page, "review effort")).slice(1).join(", ")}`,
      ].join("\n"),
    );
    await beat(page, 3_000);

    const doing = page.getByLabel("doing model", { exact: true });
    await doing.scrollIntoViewIfNeeded();
    const offered = await selectOptions(page, "doing model");
    await caption(page, `doing's model list offers:\n  ${offered.join("\n  ")}`);
    await beat(page, 2_500);

    const toolDefault = offered.find((o) => TOOL_DEFAULT_OPTION.test(o));
    if (toolDefault) {
      const postsBefore = posts.length;
      await doing.selectOption({ label: toolDefault });
      await expect.poll(() => posts.length).toBeGreaterThan(postsBefore);
      await caption(page, `Picked "${toolDefault}"\nPOST ${JSON.stringify(posts.at(-1))}`);
    } else {
      await caption(page, "No way to pick the CLI's own default model from the list");
    }
    await beat(page, 2_500);
  });
});
