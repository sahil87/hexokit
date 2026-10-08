# Intake: Desktop E2E Lane + Web Tile Docs

**Change**: 260917-m3a9-desktop-e2e-lane-web-docs
**Created**: 2026-09-17

## Origin

One-shot `/fab-new` invocation, change 5 of 6 (the final change) in the plan `fab/plans/sahil/26-09-16-web-tile-native-browser.md` (§ Change 5 — desktop e2e lane + docs, items 1–4; § Standing context; § Decisions of record; § Spike verdict → "Adjustments to changes 1–5" → Change 5). The user asked for the full lane (CI + docs) and for the pipeline to run through `/fab-fff` to a PR.

> A Playwright Electron lane proves the native engine end to end against the e2e rig, runs in CI, and the specs and memory describe the web tile as two engines behind one chrome.
>
> Full context lives in fab/plans/sahil/26-09-16-web-tile-native-browser.md — read the whole file before starting, especially "## Change 5 — desktop e2e lane + docs" (the numbered items 1-4), "## Standing context" and "## Decisions of record", and the "## Spike verdict" section — the verdict's "Adjustments to changes 1-5" bullet for "Change 5" says: smoke test (e) becomes two z-order assertions instead of one hide check (after switching away, the outgoing host's guest reports getVisible()===false; after switching back, the guest's index in win.contentView.children is above its host view and getVisible()===true), add assertion (g) that a web:bounds call while hidden leaves getVisible()===false, and add one macOS manual check of the sibling layering before the CI lane is declared representative (the child-view finding from the spike was Linux-observed only). Changes 3d, 3f, and 4 (all merged) are the code this lane tests — read app/desktop/src/web-views.ts, components/web-frame-native.tsx, and main.ts's web:* handlers before writing specs. There's also a manual desktop verification matrix still owed from changes 3f and 4 (RK_DESKTOP_URL=... just dev-desktop) — if you have a way to run the Electron shell headless on this VM (check project memory for an existing recipe), consider running through that matrix yourself and reporting results, though the e2e lane is the primary deliverable. This is change 5 of 6 in the plan — full lane (CI + docs), the final change. After intake, proceed through the full pipeline yourself (fab-fff) to implementation, review, hydrate, ship, and PR.

**Key inputs carried from the plan** (decisions of record, binding here):

- Two engines behind one chrome; the `iframe` engine is never removed; the chrome renders per `supports.*` flags. The docs written here describe that as present truth, never as "was X, now Y".
- Guests are **siblings of the host view on `win.contentView`** (the spike's structural amendment), and the registry (`app/desktop/src/web-views.ts`) is the z-order authority: `attachHostView` re-adds the incoming host's guests after `addChildView(host)` (raising them) and restores their SPA-requested visibility; the detach seams `setVisible(false)` the outgoing host's guests. The e2e lane asserts exactly this ordering from the outside.
- Bounds park while a guest is hidden (`setBounds` on a hidden view re-shows it on Electron 43 / Linux); `web:visible {true}` applies the parked rect before `setVisible(true)`.
- Modal-class overlays (the palette is one) hide the guest through the overlay-presence registry; the placeholder keeps the card.
- Chord reclaim: the SPA uploads its chord table (`web:chords`); main matches `before-input-event`, `preventDefault`s, hops focus to the host webContents, relays `chord`; the engine re-dispatches on `document`. ⌘K from inside the guest opens the palette.
- The spike's child-view finding is **Linux-observed only** — a macOS manual check of the sibling layering is owed before the CI lane is declared representative of every platform. It cannot run on this Linux VM and ships as a PR-body checklist item for the user.
- Verification per change (§ Standing context): `cd app/frontend && npx tsc --noEmit`; `just test-frontend`; scoped e2e via `just test-e2e <name>.spec`; `cd app/desktop && pnpm run compile && pnpm test`; **one full e2e run per worktree at a time**.

**Code under test (merged — 3d `260916-crb3` PR #1000, 3f `260916-q2xk` PR #1015, 4 `260917-w0k7` PR #1017, relay fix PR #1014)**, read before writing specs:

- `app/desktop/src/web-views.ts` — `WebViewEntry` (`windowId`, `hostId`, `hostContentsId`, `tabKey`, `webContentsId`, `handle`, `chords`, `visible`, `bounds`), `hostDetachPlan`, `hostAttachPlan`.
- `app/desktop/src/main.ts` — `createWebView` (sibling `addChildView` on `win.contentView`, initial `setVisible(activeHost === host)`), `attachHostView` (detach-hide → `removeChildView(current)` → `addChildView(incoming)` → attach plan re-add + restore), `destroyWindowViews` (guests die with the window), the `web:*` handlers (`web:bounds` parks when hidden or host detached; `web:visible` applies parked bounds then shows), `wireGuestRelay` (`title`/`url`/`chord`/… on `web:event`), `restoreOrOpenInitial` (no `windows.json` + `hosts.json` with an `activeId` ⇒ one window on that host; `RK_DESKTOP_URL` ⇒ the never-persisted dev sentinel), `userDataDir()` = `app.getPath("userData")`.
- `app/frontend/src/components/web-frame-native.tsx` — placeholder `data-testid="web-native-placeholder"` `data-tab-key="web-<n>"`, `measure()` → `web:bounds` (rounded `getBoundingClientRect`, identity-mapped to host-view coordinates), `wantVisible = active && !modalOpen && rectNonZero && tileError === null`, `web:chords` upload on mount.
- `app/desktop/src/preload.ts` — `runkitShell.servers.switch(id)`, `runkitShell.web.{create,destroy,bounds,visible,…}`; `app/frontend/src/lib/web-engine-pref.ts` — native is the default when the bridge is present.

## Why

The native engine shipped across three changes with **no automated end-to-end coverage**: `web-views.test.ts` proves the registry's pure transitions under `node --test`, `web-frame-native.test.tsx` proves the engine against a mocked bridge, and the 100+ Playwright specs in `app/frontend/tests/e2e/` all drive the **iframe** engine (no shell exists in a browser context). The load-bearing behaviors — a guest paints exactly over the tile rect, hides under the palette, survives a host switch in the right z-order, parks its bounds while hidden, dies with its window, relays titles, and forwards ⌘K — were verified only by the change-0 spike (throwaway, never merged) and by manual `RK_DESKTOP_URL=… just dev-desktop` runs, of which the change-3f/4 matrix is still owed. The spike found two of these behaviors are **exactly where Electron surprises** (a child of the host view never paints; `setBounds` re-shows a hidden view), so a regression here would be silent until a user notices a blank tile or a guest painted over the wrong host.

If this lane does not land, every later shell or engine change re-runs the manual matrix by hand or ships blind; the 3d attach/detach ordering in particular has no guard outside `main.ts`'s comments. `ci.yml` today has Backend, Frontend, Code bridge and E2E ×4 shards — the desktop package's own `node --test` suite is not even run in CI.

The docs half closes the plan: `docs/specs/window-views.md`'s web row still reads "`IframeWindow` (proxy iframe + URL bar …)", `surface-layout.md` and `right-panel.md` § Surface Registry still say "the live iframe", and `docs/memory/run-kit/architecture/testing.md` has no desktop lane. After this change the spec rows, the memory, and the constitution's test-intent rule describe two engines behind one chrome and the lane that proves it.

Why this shape: the lane **reuses** the e2e rig and harness the web specs already have (the per-worktree derived port triple + tmux socket family from `scripts/e2e-env.sh`, the lock/stale-kill/seed/cleanup choreography in `scripts/test-e2e.sh`) rather than growing a second rig starter; it reads z-order and visibility **from Electron itself** (`win.contentView.children`, `View.getVisible()`, `View.getBounds()`) through `electronApp.evaluate`, so no test-only hook enters `main.ts`; and it isolates the shell's `userData` through Linux's `XDG_CONFIG_HOME` so a seeded two-host `hosts.json` drives the host-switch assertion without touching the developer's real `~/.config/run-kit-desktop/` or fighting the single-instance lock.

## What Changes

### 1. The Electron Playwright lane — `app/desktop/tests/e2e/`

**Package (`app/desktop/package.json`)**: `@playwright/test` joins `devDependencies` at the frontend's pin (`^1.59.1`); a `"test:e2e": "playwright test"` script (mirrors the frontend). `pnpm-lock.yaml` updates. The Electron lane downloads no browser — `_electron.launch` runs the package's own `electron` binary — so `playwright install` is not needed for this package. `tsconfig.json` keeps `include: ["src"]`; Playwright compiles the spec TypeScript itself.

**Config (`app/desktop/playwright.config.ts`)**:

```ts
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: process.env.CI ? 60_000 : 30_000,   // an Electron launch + rig navigation per test
  retries: 1,
  fullyParallel: false,
  workers: 1,                                  // one shell, one rig; the multi-rig lane never applies here
  globalTeardown: "../frontend/tests/e2e/global-teardown.ts",  // the same family-anchored socket sweep
  use: { trace: "on-first-retry" },
});
```

No `webServer` block and no `baseURL`: the harness manages the rig, and specs build URLs from `E2E_PORT` with the same fail-closed `3333` fallback the frontend config uses (a bare `playwright test` connects to nothing).

**Launch (`tests/e2e/_shell.ts`, the lane's fixture module)**:

```ts
export async function launchShell(configHome: string) {
  return _electron.launch({
    args: [".", "--no-sandbox"],          // "." → package.json main = dist/main.js; --no-sandbox for xvfb/CI (userns-restricted runners)
    cwd: DESKTOP_DIR,                     // app/desktop
    env: { ...process.env, XDG_CONFIG_HOME: configHome },
  });
}
```

`configHome` is a per-test `mkdtemp` directory. On Linux Electron derives `appData` from `XDG_CONFIG_HOME`, so `app.getPath("userData")` becomes `<configHome>/run-kit-desktop/` (the package `name`), and the fixture seeds `<configHome>/run-kit-desktop/hosts.json` before launch:

```json
{ "version": 1, "activeId": "e2e-a",
  "hosts": [ { "id": "e2e-a", "name": "e2e A", "url": "http://localhost:<E2E_PORT>" },
             { "id": "e2e-b", "name": "e2e B", "url": "http://127.0.0.1:<E2E_PORT>" } ] }
```

Two distinct origins over ONE rig (the memory recipe's trick) give a real host switch against one dev server. With no `windows.json`, `restoreOrOpenInitial` → `restoreTargets` opens one window on `e2e-a`. The isolated `userData` also keeps `requestSingleInstanceLock` from colliding with a developer's running shell. `RK_DESKTOP_URL` is **not** used by the lane (the sentinel is single-host).

**Pages**: the host view's webContents surfaces as a Playwright `Page` (`electronApp.waitForEvent("window")` / `electronApp.windows()`, selected by `page.url()` origin). The fixture exposes `hostPage(app, origin)` and `guestPage(app, origin)`. Every host-side assertion (placeholder rect, palette input, tab strip title) runs on the host Page with ordinary locators; the guest Page carries the (d) keypress. **Apply-time verification**: if Playwright does not surface `WebContentsView` webContents as Pages, the fallback is `electronApp.evaluate` over `webContents.fromId(id)` with `executeJavaScript` for reads and `sendInputEvent({type:"keyDown", keyCode:"k", modifiers:["control"]})` + the matching `keyUp` for (d) — the spec shape is identical either way.

**Reading the shell's view tree** — no test hook in `main.ts`; the lane reads Electron's own objects:

```ts
export function viewTree(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return win.contentView.children.map((view) => {
      const wc = "webContents" in view ? (view as Electron.WebContentsView).webContents : null;
      return { id: wc?.id ?? null, url: wc?.getURL() ?? "", visible: view.getVisible(), bounds: view.getBounds() };
    });
  });
}
```

A child is classified by URL origin: the host view for `e2e-a` is the child at `http://localhost:<port>`, `e2e-b`'s at `http://127.0.0.1:<port>`, and the guest is the child at the stub origin (§ Guest content). Z-order = array index (`contentView.children` is bottom → top).

**Guest content**: the spec starts a `node:http` server on an ephemeral port (`listen(0, "127.0.0.1")`) serving `<!doctype html><title>rk e2e guest</title><body><p>guest</p></body>`, and stamps the web tab with its absolute URL (`http://127.0.0.1:<stubport>/` — a `proxy`-kind address, so the SPA loads it through `/proxy/<stubport>/` on the host origin exactly as the iframe engine would, and the rig's Go backend proxies it). Guest requests originate in the `persist:rk-web` partition, never the host page, so `page.route` stubs cannot serve them — a real listener is required. The server closes in `afterAll`.

**tmux seeding**: imported from the frontend fixtures by relative path — `../../../frontend/tests/e2e/_tmux` (`TMUX_SERVER`, `createSession`, `killSession`, `newWindow`, `stampWebTab`, `setWindowOption`) and `_ready` (`READY_TIMEOUT`, `resolveWindow`) — no copies. `beforeAll` creates `e2e-desktop-<ts>`; each test creates one window, stamps `@rk_win_web_1` + `@rk_win_web_active 1` and `@rk_win_layout single:web`, and `hostPage.goto("http://localhost:<port>/<TMUX_SERVER>/<windowId>")` (a same-origin navigation the host guard allows; it fires the host `did-navigate` seam with zero guests, a no-op). The lane's rig is the same seeded primary the web specs use.

**Per-test lifecycle**: `beforeEach` launches a fresh shell (fresh `configHome`, fresh window); `afterEach` `electronApp.close()`s it and removes the temp dir. ~2–4 s per launch is accepted for hermeticity (a test that closes the window — (f) — cannot share an app with its neighbours).

**Test Intent Comments**: every `test()` carries the constitution's `/** Proves: … Steps: … */` block; the file opens with the shared-setup header (rig env, `XDG_CONFIG_HOME` seeding, the stub server, viewport/window size, per-test launch). No change IDs in comments.

### 2. The smoke set — `tests/e2e/web-native.spec.ts`

Window content size is fixed at launch through `BrowserWindow`'s default (the shell's `createWindow` size) — the specs read whatever it is; nothing is asserted about absolute geometry.

| | Proves | Mechanism / assertion |
|---|---|---|
| (a) | Opening a web tab creates exactly one guest whose bounds match the tile content rect | After the placeholder is visible: `viewTree()` has exactly one child at the stub origin; `placeholder.boundingBox()` (CSS px in the host page = host-view DIPs — the host view fills the window content area and the SPA draws its own titlebar strip) vs `guest.bounds`: each of x/y/width/height within **1 px**; `visible === true` |
| (b) | Opening the palette hides the guest; closing it shows it again | `hostPage.keyboard.press("Shift+Control+k")` (the `openPalette` chord form — the alias that survives terminal focus); palette input visible ⇒ `expect.poll(guestVisible).toBe(false)`; `Escape` ⇒ `true` |
| (c) | A guest `page-title-updated` reaches the tab strip | The stub's `<title>rk e2e guest</title>` appears in the strip's `[data-testid="web-tab"]` text (the `title` relay → engine state → chrome) |
| (d) | ⌘K pressed **inside the guest** opens the SPA's palette | `guestPage.keyboard.press("Control+k")` (up to 3 presses on the `openPalette` retry shape — the chord table is uploaded shortly after mount) ⇒ palette input visible on the host page. Proves `web:chords` + `before-input-event` + focus hop + `chord` relay + re-dispatch end to end |
| (e) | Host switch hides the outgoing host's guest; switching back re-raises it above its host view and shows it | `hostPage.evaluate(() => window.runkitShell.servers.switch("e2e-b"))` ⇒ poll: the `e2e-b` host child is present and the guest's `visible === false`; then `switch("e2e-a")` ⇒ poll: guest `visible === true` **and** `indexOf(guest) > indexOf(hostA)` in `contentView.children` (two assertions, per the spike verdict) |
| (f) | Closing the window destroys its guest | Keep the app alive with a bare `new BrowserWindow({ show: false })` (so `window-all-closed` does not quit on Linux), then `win.close()` on the shell window ⇒ poll: `webContents.getAllWebContents()` no longer contains the guest's id (and `BrowserWindow.getAllWindows()` no longer contains the shell window) |
| (g) | A `web:bounds` call while hidden parks the rect and leaves the guest hidden | With the palette open (guest hidden): `tabKey = placeholder.getAttribute("data-tab-key")`; `hostPage.evaluate((k) => window.runkitShell.web.bounds(k, …))` with a distinct rect ⇒ `guest.visible === false` and `guest.bounds` unchanged from the pre-call read. Optional follow-on: `Escape` ⇒ visible and `bounds` equal the parked rect (park-then-apply-on-show) — kept only if the SPA's own re-measure on show does not overwrite it (apply observes and decides) |

(a)–(d) and (g) each run in their own launched shell; (e) and (f) too. A `test.describe.configure({ mode: "serial" })` is not needed — tests are independent.

### 3. Harness — `scripts/test-desktop-e2e.sh` + `scripts/test-e2e.sh` lane switch + `just test-desktop-e2e`

**`scripts/test-e2e.sh`** gains one knob, `RK_E2E_LANE` (`web`, the default, or `desktop`), consulted in exactly two places:

1. Right after `E2E_WORKERS` is derived: `[ "${RK_E2E_LANE:-web}" = desktop ] && E2E_WORKERS=1` — the desktop lane is single-rig by construction (one shell, one host switch pair).
2. In `run_playwright`: `cd app/frontend` becomes `cd "$PLAYWRIGHT_DIR"` where `PLAYWRIGHT_DIR=app/frontend` for `web` and `app/desktop` for `desktop`. Every exported variable (`E2E_PORT`, `E2E_TMUX_SERVER`, `E2E_TMUX_FAMILY`, `RK_CODE_SERVER_PORT`, `XDG_STATE_HOME`, `RK_CONFIG_DIR`, `E2E_RIGS`, `RK_E2E_WORKERS`) is passed unchanged.

Everything else — the per-worktree `flock`, the self-scoped stale-kill, `seed_tmux_server`, the process-group `just dev` launch, `wait_ready`, the slot throttle, the EXIT-trap cleanup — is inherited verbatim. The web and desktop lanes in one worktree therefore serialize on the same lock (correct: they share the rig).

**`scripts/test-desktop-e2e.sh`** (new, the plan's item 1 script):

```bash
#!/usr/bin/env bash
# Desktop Electron e2e lane: compile the shell, then run app/desktop's
# Playwright project against this worktree's derived e2e rig (the same
# identity, lock and cleanup as scripts/test-e2e.sh — RK_E2E_LANE=desktop
# only redirects its Playwright phase). Headless boxes: when DISPLAY is
# unset and xvfb-run exists, the run re-executes under `xvfb-run -a`.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "${DISPLAY:-}" ] && command -v xvfb-run >/dev/null 2>&1; then
  exec xvfb-run -a "$0" "$@"
fi
( cd "$SCRIPT_DIR/../app/desktop" && { [ -d node_modules ] || pnpm install; } && pnpm run compile )
RK_E2E_LANE=desktop exec "$SCRIPT_DIR/test-e2e.sh" "$@"
```

**`justfile`** (Constitution VIII one-liner, under `# ─── Test ───`):

```
# Run the desktop shell's Playwright Electron e2e lane against this worktree's derived rig (xvfb-run when headless)
test-desktop-e2e *args:
    scripts/test-desktop-e2e.sh {{args}}
```

`just test` (`scripts/test-all.sh`) is **not** extended — its three phases stay backend/frontend/e2e; the desktop lane needs an Electron binary and a display and is its own recipe and CI job.

### 4. CI — `.github/workflows/ci.yml`

A new job:

```yaml
  desktop:
    name: Desktop (node --test + electron e2e)
    runs-on: ubuntu-latest
    steps:
      - checkout · setup-go (go.mod) · pnpm/action-setup (package_json_file: app/desktop/package.json)
      - setup-node 20 (cache: pnpm, cache-dependency-path: app/desktop/pnpm-lock.yaml)
      - setup-just · Install tmux (the e2e job's bounded apt block, verbatim)
      - Cache air / Install air / Add go bin dir to PATH (the e2e job's three steps, verbatim — the single-rig lane runs `just dev`)
      - Cache Playwright browsers + `just setup` (the rig's Vite needs the frontend deps; the browser cache keeps `just setup` fast)
      - Install desktop dependencies: cd app/desktop && pnpm install --frozen-lockfile
      - Compile + unit tests: cd app/desktop && pnpm run compile && pnpm test     # node --test — not in CI today
      - Run desktop e2e: xvfb-run -a just test-desktop-e2e                          # DISPLAY set ⇒ no self-wrap
      - Upload Playwright report on failure: app/desktop/playwright-report/ + app/desktop/test-results/ (retention 7 days)
```

`ci-gate` gains `desktop` in `needs` and a fifth `!= "success"` check + echo line; the comment block's "Hard gates = backend + frontend + e2e + code-bridge" sentence lists five. The Electron sandbox note: the lane passes `--no-sandbox` at launch because `ubuntu-latest` (24.04) restricts unprivileged user namespaces, which breaks Chromium's SUID-less sandbox; this is test-only and never reaches `scripts/dev-desktop.sh` or packaging.

### 5. Specs — engine-blind web rows

- **`docs/specs/window-views.md`** — § The View Registry `web` row, Renderer cell → "`IframeWindow` chrome over an engine: `iframe` (browsers, PWAs, phones) or native `WebContentsView` (the desktop shell) — § Engines"; a short **`### Engines [current]`** note after the registry: the chrome renders per capability, two engines behind one `WebFrameEngine` contract, selection = shell bridge present × per-viewer opt-out, pointing at the study `docs/wiki/web-tile-native-browser-studies.html` (§3 engine contract, §5 layering) and the memory (`docs/memory/run-kit/ui/lenses-and-layout.md` § Web Tile, `docs/memory/run-kit/desktop-shell.md` § Web Views). Availability semantics ("always"; `@rk_win_url` selects content) are untouched.
- **`docs/specs/surface-layout.md`** — the two "renders the live iframe" phrasings (§ One tile per surface kind and the `@rk_win_url` row of the retirement map) → "renders the live page through the web tile's engine (iframe or native)".
- **`docs/specs/right-panel.md`** — § Surface Registry `web` row: "non-empty → the live iframe" → "non-empty → the live page (through the tile's engine — window-views.md § Engines)".
- `docs/specs/index.md` — the window-views row description gains "two engines behind one chrome" if the row is touched; otherwise unchanged.

### 6. Memory — final hydration pass

- `run-kit/ui/lenses-and-layout` § Web Tile: a `### e2e — desktop lane` line in the existing `### e2e — …` idiom naming `app/desktop/tests/e2e/web-native.spec.ts` and what (a)–(g) prove; a sweep of iframe-only wording in engine-neutral paragraphs (the chrome, address model, tab strip) so only the engine paragraphs and the parity table speak per engine.
- `run-kit/desktop-shell` § Package Shape (tree gains `tests/e2e/`, `playwright.config.ts`, the `@playwright/test` dev dep), § Web Views gains a **Testing** paragraph (the lane, the `XDG_CONFIG_HOME` isolation, the two-origin `hosts.json`, `--no-sandbox`, reading `contentView.children` for z-order, the seven assertions), § Dev & Build Entrypoints gains `just test-desktop-e2e`, and two Design Decisions: *The desktop lane reads z-order from Electron, not from a test seam* (why: `contentView.children` + `getVisible()` are the truth the registry claims to control; a `main.ts` hook would test the hook) and *The lane isolates userData through XDG_CONFIG_HOME* (why: hermetic `hosts.json`, no single-instance-lock collision, no production env knob; Linux-only by design — the lane runs on Linux).
- `run-kit/architecture/testing` — new `### Desktop Electron E2E (app/desktop/tests/e2e/)` subsection (config, harness reuse via `RK_E2E_LANE`, the CI job, the display rule) and Design Decisions *The desktop lane rides the web harness through one lane knob* (why: one rig identity, one lock, one cleanup) and *The desktop lane is not a `just test` phase*; the `just test` recipe-chain sentence stays accurate.
- `fab/project/constitution.md` § Test Intent Comments — the rule's path reads "`app/frontend/tests/e2e/*.spec.ts` and `app/desktop/tests/e2e/*.spec.ts`"; **Version** 1.12.0 → 1.12.1, **Last Amended** 2026-09-17.
- `fab docs-index` regenerated; relative `](x.md)` links across `docs/memory/run-kit/`, `ui/`, `architecture/` checked before review.

### 7. Reports, not gates

- **macOS sibling-layering check** — cannot run on this Linux VM. Listed in the PR body as an owed manual item: on a Mac, `RK_DESKTOP_URL=… just dev-desktop`, open a web tab, switch hosts away and back, confirm the guest paints above its host view and hides under the palette. The CI lane is Linux-representative until this is ticked.
- **The 3f/4 manual matrix** (four address kinds × back/forward, find, zoom, ⌘K from inside, Escape, dead port, unreachable) — attempted on this VM after the lane is green, using the project-memory headless recipe (`xvfb-run`/`:60`, `--no-sandbox`, a throwaway `XDG_CONFIG_HOME`); results reported in the PR body. Not a pipeline gate.

### Non-goals

Popup-to-tab; direct-localhost for local hosts; the `code` lens on the native engine; `capturePage` verbs (each already an `idea` entry or out of plan); macOS/Windows CI runners for the lane; a multi-rig desktop lane; adding the lane to `just test`; any change to `app/desktop/src/main.ts`, the engine, or the bridge — this change adds tests and docs only (a `main.ts` edit would mean the lane found a bug, which becomes its own change).

## Affected Memory

- `run-kit/ui/lenses-and-layout`: (modify) § Web Tile — `### e2e — desktop lane` coverage line; engine-neutral wording sweep.
- `run-kit/desktop-shell`: (modify) § Package Shape, § Web Views (Testing paragraph), § Dev & Build Entrypoints; Design Decisions *The desktop lane reads z-order from Electron, not from a test seam*, *The lane isolates userData through XDG_CONFIG_HOME*.
- `run-kit/architecture/testing`: (modify) new § Desktop Electron E2E; Design Decisions *The desktop lane rides the web harness through one lane knob*, *The desktop lane is not a `just test` phase*.

## Impact

- **Desktop** (`app/desktop/`): `package.json` (+ dev dep, script), `pnpm-lock.yaml`, `playwright.config.ts` (new), `tests/e2e/_shell.ts` (new), `tests/e2e/web-native.spec.ts` (new). No `src/` change.
- **Scripts / just**: `scripts/test-desktop-e2e.sh` (new), `scripts/test-e2e.sh` (the `RK_E2E_LANE` knob — two sites), `justfile` (one recipe).
- **CI**: `.github/workflows/ci.yml` (one job; `ci-gate` needs + check).
- **Specs**: `docs/specs/window-views.md`, `surface-layout.md`, `right-panel.md` (wording; possibly `index.md`).
- **Memory + constitution**: the three memory files above, `docs/memory/**/index.md` regen, `fab/project/constitution.md` (path + version).
- **Frontend / backend**: none. The frontend e2e fixtures (`_tmux.ts`, `_ready.ts`) are imported, not modified.
- **Runtime cost**: one more CI job (~4–6 min: rig start ≈ 1 min, seven Electron launches ≈ 2–3 min); locally `just test-desktop-e2e` ≈ 2 min.
- **Security**: no new subprocess, route, IPC channel, or settings surface (Constitution I, IV); `--no-sandbox` is confined to the test launcher.

## Open Questions

- None blocking. The macOS layering check is owed to the user (§ 7) and cannot be answered from this VM.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Follow the plan's Change 5 items 1–4 with the spike verdict's amendments: (e) as two z-order assertions, (g) parked bounds while hidden, macOS manual check owed before the lane is representative | Written decisions of record; the user's prompt restates them | S:95 R:80 A:95 D:95 |
| 2 | Certain | Registry facts (z-order, visibility, bounds, ownership) are read from Electron through `electronApp.evaluate` over `win.contentView.children`, `View.getVisible()`, `View.getBounds()`, `webContents.getURL()`; no test hook is added to `main.ts` | The registry's claims ARE about Electron's view tree; a hook would test the hook; `main.ts` stays untouched | S:75 R:85 A:85 D:75 |
| 3 | Certain | Spec rows in window-views, surface-layout and right-panel move to engine-blind wording with a § Engines note pointing at the study and memory; availability semantics unchanged | Plan item 3 spells the renderer text out; the study is the contract of record | S:85 R:90 A:80 D:80 |
| 4 | Certain | Guest content is a spec-owned `node:http` stub on an ephemeral loopback port serving a titled page, stamped as its absolute URL; no `page.route` | Guest requests originate in the `persist:rk-web` partition, not the host page — a route stub cannot serve them; the frontend's `startCodeStub`/`reserveDeadPort` precedent | S:70 R:90 A:85 D:75 |
| 5 | Confident | The lane lives in `app/desktop/tests/e2e/` with its own `playwright.config.ts`; `@playwright/test` joins the desktop dev deps at the frontend's pin | Plan item 1 names the directory; Electron launch needs the package's own `electron` resolvable from cwd | S:85 R:85 A:85 D:80 |
| 6 | Confident | `scripts/test-desktop-e2e.sh` compiles the shell and delegates to `scripts/test-e2e.sh` under `RK_E2E_LANE=desktop` (Playwright dir switch + workers forced to 1) instead of a second rig starter | One rig identity, one lock, one cleanup; duplicating ~150 lines of choreography is the code-quality anti-pattern | S:70 R:80 A:85 D:70 |
| 7 | Confident | `userData` is isolated per test through `XDG_CONFIG_HOME` (Linux `appData`), seeded with a two-host `hosts.json` (`localhost` and `127.0.0.1` on the rig port); `RK_DESKTOP_URL` is not used | The memory recipe's two-origin trick; no production env knob; the sentinel is single-host so (e) needs real hosts | S:70 R:85 A:80 D:70 |
| 8 | Confident | The host switch in (e) is driven through `runkitShell.servers.switch(id)` from the host page | The exact seam the SPA's host switcher uses; the sender is a registered host so the gate passes; no menu automation | S:65 R:90 A:80 D:65 |
| 9 | Confident | Playwright surfaces the host and guest `WebContentsView` webContents as Pages (locators + `keyboard` work on them); fallback `executeJavaScript` / `sendInputEvent` via `electronApp.evaluate` if not | Playwright attaches every CDP page target in the Electron context, foreign partitions included; the fallback keeps the spec shape | S:50 R:80 A:45 D:55 |
| 10 | Confident | One CI job `Desktop (node --test + electron e2e)` runs compile + `pnpm test` + `xvfb-run -a just test-desktop-e2e`, uploads the report on failure, and joins `ci-gate` as a hard gate; the launcher passes `--no-sandbox` | Plan item 2; the repo's posture that e2e gates block with admin bypass as the escape; Ubuntu 24.04 userns restriction | S:70 R:80 A:70 D:60 |
| 11 | Confident | Each test launches its own shell (fresh `XDG_CONFIG_HOME`, fresh window) rather than sharing one app | (f) closes the window; hermetic host state per test; ~3 s per launch is acceptable for seven tests | S:45 R:90 A:60 D:50 |
| 12 | Confident | `just test-desktop-e2e` is NOT added to `just test`'s phase list | The lane needs an Electron binary and a display; CI runs it as its own job | S:50 R:90 A:75 D:65 |
| 13 | Confident | The constitution's Test Intent Comments rule is extended to `app/desktop/tests/e2e/*.spec.ts` (1.12.0 → 1.12.1) | The rule's path list is the only thing that excludes the new lane; plan item 1 requires the comments | S:60 R:90 A:70 D:70 |
| 14 | Confident | The desktop script self-wraps in `xvfb-run -a` when `DISPLAY` is unset and `xvfb-run` exists | Headless VM and CI both lack a display; an explicit `DISPLAY` (a developer's desktop, CI's own xvfb-run) is respected | S:60 R:90 A:80 D:70 |
| 15 | Confident | tmux seeding reuses the frontend fixtures (`_tmux.ts`, `_ready.ts`) by relative import; nothing is copied | The rig and its env vars are identical; duplicating fixtures is the anti-pattern the shared modules exist to prevent | S:60 R:85 A:80 D:60 |
| 16 | Confident | The macOS layering check and the 3f/4 manual matrix are reports (PR-body checklist + a VM run after the lane is green), never gates | The VM is Linux; the plan calls the macOS check manual | S:80 R:95 A:60 D:80 |

16 assumptions (4 certain, 12 confident, 0 tentative, 0 unresolved).
