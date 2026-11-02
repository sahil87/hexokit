/**
 * Demo: the web tile's address bar shows an `rk present`-ed file's path
 * relative to its git repo, recorded for PR evidence — `docs/wiki/note.html`
 * at rest instead of the bare basename, a `loom:` label when the file lives in
 * a different repo than the window, and the raw `/present/…` URL while the
 * field is focused.
 *
 * Runs only under `just demo present-repo-path` (playwright.demo.config.ts —
 * testDir ./tests/demo), against the throwaway e2e rig, once per project
 * (desktop 1280x800, mobile 375x812 — both render the address field). slowMo
 * paces the actions and `beat()` pauses let a reviewer read the field.
 *
 * Shared setup: beforeAll creates one session on the rig's isolated tmux
 * server and two scratch git repos under one temp dir — `hexokit` (the
 * window's pane cwd, holding `docs/wiki/note.html`) and `loom` (holding
 * `docs/wiki/x.html`); afterAll kills the session and removes the temp dir.
 * The window's two slots are content-keyed `/present/<server>/<roothash>/…`
 * addresses whose serve roots are declared via `@rk_win_web_<n>_root`, the
 * state `rk present` leaves behind. The new-form expectations are soft: the
 * same spec records the base tree, where the field shows the basename, and the
 * recording must run to its end either way.
 */
import { test, expect, beat } from "./_demo";
import { resolveWindow, READY_TIMEOUT } from "../e2e/_ready";
import {
  TMUX_SERVER,
  createSession,
  killSession,
  newWindow,
  setWindowOption,
  stampWebTabs,
} from "../e2e/_tmux";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEMO_SESSION = "demo-present-repo-path";
const SOFT_TIMEOUT = 3_000;

let scratchDir: string;
let hexokitRepo: string;
let wikiDir: string;
let loomWikiDir: string;

/** The sha256(path).slice(0, 12) segment `rk present` composes for a root. */
function presentHash(abs: string): string {
  return createHash("sha256").update(abs).digest("hex").slice(0, 12);
}

/** A scratch git repo at `dir` holding `docs/wiki/<file>`; returns the wiki dir. */
function seedRepo(dir: string, file: string): string {
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  const wiki = join(dir, "docs", "wiki");
  mkdirSync(wiki, { recursive: true });
  writeFileSync(
    join(wiki, file),
    `<!doctype html><html><head><title>${file}</title></head><body><h1>${file}</h1></body></html>`,
  );
  return wiki;
}

test.describe("present-repo-path demo", () => {
  test.beforeAll(() => {
    createSession(DEMO_SESSION);
    scratchDir = mkdtempSync(join(tmpdir(), "rk-demo-repo-path-"));
    hexokitRepo = join(scratchDir, "hexokit");
    wikiDir = seedRepo(hexokitRepo, "note.html");
    loomWikiDir = seedRepo(join(scratchDir, "loom"), "x.html");
  });

  test.afterAll(() => {
    killSession(DEMO_SESSION);
    rmSync(scratchDir, { recursive: true, force: true });
  });

  /**
   * Proves: a file presented from inside a git repo reads as its
   * repo-relative path in the address bar at rest, a file from another repo
   * carries that repo's name as a `loom:` label, and focusing the field
   * swaps in the raw `/present/…` URL (restored on blur).
   *
   * Steps:
   * 1. Seed a window whose pane cwd is the `hexokit` repo with two present
   *    slots — `docs/wiki/note.html` (same repo) and `docs/wiki/x.html` in the
   *    `loom` repo — plus `@rk_win_layout single:web`; navigate and wait for
   *    the address field; `beat()` on the at-rest value.
   * 2. Assert slot 1 reads `docs/wiki/note.html` while the tab label stays
   *    the basename `note.html`.
   * 3. Focus the field — the raw `/present/…` URL shows; `beat()`; blur — the
   *    repo-relative form returns; `beat()`.
   * 4. Select tab 2; assert the field reads `loom:docs/wiki/x.html`; `beat()`.
   */
  test("repo-relative address at rest, loom: label, raw URL on focus", async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === "mobile";
    const server = TMUX_SERVER;

    newWindow(DEMO_SESSION, "wiki", { cwd: hexokitRepo });
    const id = (await resolveWindow(page, TMUX_SERVER, DEMO_SESSION, "wiki")).windowId;
    stampWebTabs(
      id,
      [
        `/present/${server}/${presentHash(wikiDir)}/note.html`,
        `/present/${server}/${presentHash(loomWikiDir)}/x.html`,
      ],
      1,
    );
    setWindowOption(id, "@rk_win_web_1_root", wikiDir);
    setWindowOption(id, "@rk_win_web_2_root", loomWikiDir);
    setWindowOption(id, "@rk_win_layout", "single:web");
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(id)}`);

    const urlBar = page.getByTestId("surface-tile-web").getByLabel("URL");
    if (isMobile) {
      await expect(page.getByRole("button", { name: "Toggle navigation" })).toBeVisible({
        timeout: READY_TIMEOUT,
      });
    }
    await expect(urlBar).not.toHaveValue("", { timeout: READY_TIMEOUT });
    await beat(page, 3_000);

    await expect.soft(urlBar).toHaveValue("docs/wiki/note.html", { timeout: SOFT_TIMEOUT });
    await expect(page.getByTestId("web-tab").first()).toContainText("note.html");

    // Focus swaps in the raw present address; blur restores the rest form.
    await urlBar.focus();
    await expect(urlBar).toHaveValue(/^\/present\//);
    await beat(page, 3_000);
    await urlBar.blur();
    await expect.soft(urlBar).toHaveValue("docs/wiki/note.html", { timeout: SOFT_TIMEOUT });
    await beat(page, 2_000);

    // A file in a different repo than the window's carries that repo's label.
    await page.locator('[data-testid="web-tab"][data-index="2"]').click();
    await expect(urlBar).not.toHaveValue("");
    await expect.soft(urlBar).toHaveValue("loom:docs/wiki/x.html", { timeout: SOFT_TIMEOUT });
    await beat(page, 3_000);
  });
});
