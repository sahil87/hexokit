# Project Context

<!-- Free-form project context: tech stack, conventions, architecture.
     This is the primary way skills understand your codebase without reading every file.
     Write naturally in markdown — no YAML constraints.

     Tips:
       - Be specific about languages, frameworks, and patterns
       - For monorepos, use labeled sections so skills scope to the relevant part:

         ## packages/frontend
         React, TypeScript, Next.js, Tailwind CSS

         ## packages/backend
         Python, FastAPI, SQLAlchemy, PostgreSQL
-->

## Repository Layout

```
app/
  backend/     # Go HTTP server (chi router)
  frontend/    # Vite + React SPA
```

Task runner: `just` (see `justfile`). Frontend deps managed by pnpm (in `app/frontend/`).

## Backend — `app/backend/`

- **Language**: Go 1.22
- **Router**: chi/v5
- **WebSocket**: gorilla/websocket — terminal relay to tmux panes via creack/pty
- **SSE**: custom handler for real-time session state
- **Config**: environment variables (`RK_PORT`, `RK_HOST`) loaded via `.env` / `.env.local`; the daemon port also has a durable `port` key in `~/.config/hexokit/config.yaml` (the `internal/settings` registry), below `RK_PORT` in precedence
- **Structure**: `cmd/rk/` (entrypoint), `api/` (HTTP handlers), `internal/` (config, fab, sessions, tmux, validate)
- **Testing**: `go test ./...`
- **Build**: `go build -o ../../bin/rk ./cmd/rk`

## Frontend — `app/frontend/`

- **Language**: TypeScript 7 (native Go compiler)
- **Framework**: Vite 8 + React 19 (SPA, no SSR)
- **Routing**: TanStack Router — routes: `/` (redirect), `/$session/$window`
- **UI**: Tailwind CSS 4
- **Terminal**: xterm.js 6 (`@xterm/xterm`) with FitAddon and WebLinks addon
- **API client**: `src/api/client.ts`
- **Testing**: Vitest 4, Testing Library (React + jest-dom), jsdom, Playwright (e2e)
- **Build**: `tsc --noEmit && vite build`
- **Package manager**: pnpm

## Conventions

- State derived from tmux + filesystem at request time — no database, no in-memory caches
- All Go subprocess calls use `exec.CommandContext` with timeouts — never shell strings
- Three-mode theme (system/light/dark), monospace everywhere
- Hover-animation vocabulary: one treatment per element category — glitch=brand (the logo ring rides it with a JS-driven white glow detach-orbit-land sweep over the border segments — useBrandLogoSweep in logo-spinner.tsx), boot-sweep=top-bar page heading (one inverse-video cursor sweeps the `PageType: name` string: TypedLabel-style typed cursor over the prefix flowing into a decode glyph-churn over the instance name, ~28ms/cell; reuses the `rk-typed-*` cell classes + DECODE_* constants), brackets+caret=section headings (SectionHeading — the label keeps its typed-sweep inside the brackets), typed-sweep=section labels (TypedLabel — an inverse-video cursor types the label out in ~350ms), CRT glint=buttons (green sweep + the hovered chip's border/glyph flip green) — animated elements turn accent-green; `rk-*` utility classes in `globals.css`; under `prefers-reduced-motion` animations are zeroed and JS treatments skip themselves (classes and static hover colors remain)
- Keyboard-first — command palette (`Cmd+K`) is primary discovery mechanism
- SSE for real-time session state, WebSocket for terminal I/O
- tmux user options are named `@rk_<scope>_<name>`, scope ∈ `srv` (`set -s`) · `ses` (bare `-t <session>:`) · `win` (`-w`) · `pane` (`-p`) — every key sits in the `@rk_` namespace and carries its scope in its name, and a name is never reused at another scope. Why: tmux format expansion resolves `#{@foo}` by walking pane → window → session → global, so a same-named option at an outer scope leaks into every inner read and the inner-scope clear (`-wu`) removes nothing (the `fabKit` session's legacy `@color slate` colored every window in it, 2026-08-28). Rules: a new key gets the prefixed form from day one and a row in the registry (`docs/memory/run-kit/tmux-sessions.md` § Server-Scoped User Options); a rename or retirement adds a row to the `MigrateLegacyOptions` table (copy old→new, unset old at its scope, unset the legacy name wherever it appears at a wrong scope) instead of relying on new writes; keys written by anything outside the `rk` binary (agent hooks from `rk agent setup`, test scripts, fab-kit) are dual-read for a release before the old name is dropped. The legacy → prefixed rollout is `fab/plans/sahil/26-08-28-tmux-option-scope-naming.md`; until it ships, treat un-prefixed keys (`@color`, `@session_color`, `@rk_role`, …) as legacy names, not a pattern to copy
- Dev workflow: `just dev` (runs Go backend with air live-reload + Vite dev server concurrently)

## Testing

Run `just setup` once before attempting to run test cases — it installs frontend deps, playwright browsers, copies `.env.local`, and stages the tmux config for Go embed. Re-run when pulling dependency changes.

A fresh worktree has no `app/frontend/node_modules`, so Playwright and its Chromium are absent until `just setup` runs there — do not go looking for an install in sibling worktrees. `just setup` is also the way to get a headless browser for anything beyond e2e tests, e.g. a one-off screenshot of a local HTML file (a design study, an artifact preview): after setup, from `app/frontend`, `pnpm exec playwright screenshot --full-page file:///abs/path.html /tmp/out.png` or a short node script that `require("playwright")`s. This is outside the `just pw` rig (no dev server needed), so it is the one Playwright use that does not go through a `just` recipe.

Always run tests through `just` recipes — never invoke `go test`, `pnpm test`, or `playwright test` directly. The `just test-e2e` recipe (via `scripts/test-e2e.sh`, deriving from `scripts/e2e-env.sh`) starts a dev server on this worktree's derived port triple (rig block 21000–21299, from the port policy in `app/backend/internal/portpolicy/ports.env`: Vite / Go backend / code-server stub) with an isolated per-worktree tmux socket family (`rk-test-e2e-<token>-*`) and a per-run temp `XDG_STATE_HOME`, so e2e runs never collide with a running `rk serve` instance or a sibling worktree's run. A per-worktree exclusive flock (`/tmp/rk-e2e-wt-<uid>-<token>.lock`, taken before the stale-kill and held to exit) serializes `just test-e2e` runs started in the SAME worktree — the second waits, up to 30 m, and never kills the first — and a flock throttle (`RK_E2E_SLOTS`, default 2; 1 = strict series) bounds concurrent Playwright phases across worktrees; `just dev` warns (never blocks) when a run owns the rig. Running Playwright directly would fall back to the policy's sentinel port 21999 and connect to nothing (fail-closed).

- `just test` — all tests (backend + frontend + e2e)
- `just test-backend` — Go tests only
- `just test-frontend` — Vitest unit tests only
- `just test-e2e` — Playwright e2e tests (derived per-worktree ports + socket family)
- `just pw` — ad-hoc Playwright commands against the worktree's derived rig (e.g., `just pw test mobile-layout`)

The Playwright fallback port is the policy's fail-closed sentinel 21999 (not 3000) — Playwright reads its base port from `E2E_PORT`, a variable only the harness scripts set, so a direct Playwright run fails to connect rather than hitting a live `rk serve` instance; the ambient `RK_PORT` (direnv-exported on this box) is never consulted by Playwright. Explicit `RK_E2E_PORT` / `E2E_TMUX_SERVER` env vars override the derivation.

## Playwright-Driven Development

When making UI changes — especially mobile/responsive work — use Playwright MCP as the primary verification tool:

1. Start the worktree's dev rig: `just dev` — it serves this worktree's derived e2e port triple (the same identity `just pw` and `just test-e2e` derive)
2. Set viewport size to simulate the target device (e.g., 375×812 for iPhone)
3. Navigate, click, and screenshot to verify layout changes visually
4. Test interactive elements: popups, drawers, toggles — confirm they render within bounds and aren't clipped
5. Resize viewport to verify desktop layout isn't broken
6. Run individual tests with `just pw test <name>` — it derives the same per-worktree identity, so it finds the rig automatically (pass `RK_E2E_PORT` explicitly only against a stepped-forward or overridden rig)

Never run `npx playwright test` directly — always use `just test-e2e` or `just pw` to get the derived per-worktree port/socket identity. This workflow catches overflow issues, clipping, and layout regressions that unit tests miss. Always verify both mobile (375px) and desktop (1024px+) viewports after responsive changes.

## Mobile Responsive Design

- Touch targets use the `coarse:` custom Tailwind variant (`@media (pointer: coarse)`) for touch devices
- Touch targets: bottom-bar chips are 33×35px with a 6px gap on fine pointers and the full `coarse:min-h-[36px] coarse:min-w-[36px]` + 4px gap on touch (375px single-row budget unchanged); top-bar button controls use the shared FIXED-size token (`TOP_BAR_BUTTON*` in `top-bar-overflow-menu.tsx`) — 28×28px on fine pointers, 30×30px on coarse — applied uniformly across the sidebar toggle, history arrows, and the whole right-side cluster so rendered sizes can no longer drift with content (the old `min-*` 24px floors let boxes stretch). Content-width chips/segments (UpdateChip, Open/Split segments) share the same height axis (`TOP_BAR_BUTTON_H`). The centered window heading also carries `coarse:min-h-[30px]` (it is the mobile leaf and the primary rename affordance there)
- Bottom bar toolbar fits all buttons in a single row at 375px — no wrapping, no horizontal scroll
- Top bar is a single-line 3-column grid (`grid-cols-[1fr_auto_1fr]` at `sm+`; below `sm` it is `auto auto minmax(0,1fr)` — the heading left-aligns beside the hamburger and the leftover width goes to the right cluster, since every crumb is breakpoint-hidden there): sidebar toggle + history ◀ ▶ arrows + a breadcrumb ending at the PARENT (left; the arrows sit right of the toggle, macOS-style — before the brand crumb on Host — and hide below `lg` per the cluster's degradation ladder) · a universal `PageType: name` center page heading on EVERY mode (center — `Tab: <window>` editable + ▾ window switcher, `Board: <board>` display + ▾ board switcher, `tmux Server: <server>` display, solo `Host`) · button cluster (right — terminal end state: Open · Split(▾, merged split-button) · Refresh · overflow chevron; fixed-width, terminal-font (Aa), and close-pane/Kill are `menuOnly` chevron-menu rows grouped under View / Window / App section labels). Move-don't-copy: the current-page leaf is the centered heading, never duplicated in the breadcrumb — the root server leaf and board name/▾ live in the center, the left breadcrumb ends at its parent (board mode keeps only the pane/server counts + cycle hint; the `Board ▸` home button is gone). The page-type prefix is a static sibling span (hidden below `sm`; solo `Host` visible at all breakpoints). Session creation lives in the session crumb's `+ New Session`, window creation in the `▾` switcher's `+ New Window`. Window rename is the heading name itself — click for inline edit (Enter/blur commit, Escape cancels) or the palette's `Window: Rename`; there is no rename dialog (board/server/host names are display-only)
- Mobile sidebar drawer is `absolute` inside the main area (not `fixed inset-0`) so the top bar stays visible and the logo toggle can close the drawer
- The `.app-shell` and terminal column have `overflow: hidden` to prevent horizontal page overflow from xterm.js canvas
- Terminal font: device default is 11px on mobile / 13px on desktop, set in JS via xterm `options.fontSize` (no CSS media query). Users can override via the terminal-font control (`ChromeContext.terminalFontSize`, persisted to `hexokit-terminal-font-size`); the device default applies only when no preference is stored. The mobile/desktop split uses the shared narrow-width-OR-coarse-pointer rule (`isMobileViewport()`), not a width-only query
- tmux has a hard minimum width (~80 cols) that exceeds most phone screens — horizontal overflow in the terminal area is expected and acceptable
