# HexoKit Reimplementation Plan

> Step-by-step plan for reimplementing HexoKit with a clean API, robust testing,
> and an `app/backend` + `app/frontend` structure. Each phase is independently
> verifiable before moving to the next.

---

## Phase 1: Scaffold

Create the new folder structure with placeholders. No functional code — just enough to
confirm the build toolchain works (Go compiles, Vite builds, tests run and find zero tests).

**Deliverables:**

1. Create `app/backend/` Go module:
   - `go.mod` (module name, Go version)
   - `cmd/run-kit/main.go` — minimal `main()` that prints "run-kit" and exits
   - `api/` — empty handler files with package declaration (`router.go`, `sessions.go`, `windows.go`, `directories.go`, `upload.go`, `sse.go`, `relay.go`, `health.go`, `spa.go`)
   - `internal/tmux/`, `internal/sessions/`, `internal/fab/`, `internal/config/`, `internal/validate/` — empty packages with a single exported placeholder each
   - Each `internal/` package gets an empty `_test.go`

2. Create `app/frontend/` Vite project:
   - `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`
   - `src/main.tsx` — minimal React entry
   - `src/app.tsx` — single-view layout skeleton (top bar + sidebar + terminal + bottom bar)
   - `src/router.tsx` — TanStack Router with one route: `/:session/:window`
   - `src/api/client.ts` — type stubs matching the API spec (functions that throw "not implemented")
   - `src/types.ts` — `ProjectSession`, `WindowInfo` types from the API spec
   - `tests/msw/handlers.ts` — MSW handler stubs for API + SSE mocking
   - `tests/e2e/` — Playwright config + one smoke test placeholder

3. Update `justfile`:
   - `just dev` — run Go backend + Vite dev server concurrently
   - `just build` — build Go binary + Vite production bundle
   - `just test` — run Go tests + Vitest + Playwright
   - `just test-backend` — Go tests only
   - `just test-frontend` — Vitest only
   - `just test-e2e` — Playwright only
   - `just check` — TypeScript type-check
   - `just verify` — `check` + `test` + `build`
   - Keep `up`, `bg`, `logs`, `down` recipes (update paths)
   - Keep `https`, `trust` recipes

4. Update `supervisor.sh` paths to `app/backend/` and `app/frontend/dist/`

5. `playwright.config.ts` lives at `app/frontend/playwright.config.ts`

**Verification gate:** `just build` succeeds. `just test-backend` runs zero tests, exits 0. `just test-frontend` runs zero tests, exits 0.

---

## Phase 2: Backend

Implement the Go backend from [api.md](api.md), test-first. Each endpoint is a unit of work:
write handler tests, then implement the handler to pass them. Internal packages can be
ported from the old implementation where the logic is unchanged.

**Order of implementation** (dependencies flow downward):

1. **`internal/validate`** — port from old implementation verbatim (logic is identical, already tested)
2. **`internal/config`** — port from old implementation verbatim
3. **`internal/tmux`** — port from old implementation verbatim
4. **`internal/fab`** — **rewrite** (not port). Reads `.fab-status.yaml` at project root. No subprocess calls, no `fab/current`, no `statusman.sh`. Pure YAML parse.
5. **`internal/sessions`** — port from old implementation verbatim
6. **`api/router.go`** — chi setup, middleware stack, route registration
7. **`api/health.go`** — `GET /api/health` (trivial, validates the router works)
8. **`api/sessions.go`** — `GET /api/sessions`, `POST /api/sessions`, `POST /api/sessions/:s/kill`
9. **`api/windows.go`** — `POST` create, `POST` kill, `POST` rename, `POST` keys
10. **`api/directories.go`** — `GET /api/directories`
11. **`api/upload.go`** — `POST /api/sessions/:session/upload`
12. **`api/sse.go`** — `GET /api/sessions/stream`
13. **`api/relay.go`** — `WS /relay/:session/:window`
14. **`api/spa.go`** — static file serving + SPA fallback
15. **`cmd/run-kit/main.go`** — server startup, config loading, signal handling

**Testing approach:**

- Internal packages: table-driven unit tests (ported from old, extended where gaps exist)
- Handlers: `httptest.NewRecorder` + chi router integration tests
  - Test request/response shapes, status codes, validation error messages
  - Mock `internal/` interfaces for isolation (e.g., mock tmux commands)
  - SSE: test hub fan-out, deduplication, client lifecycle
  - WebSocket relay: test connection upgrade, message routing, cleanup

**Verification gate:** `just test-backend` passes. `go vet ./...` clean. Manual smoke test: `just dev` starts the backend on the worktree's derived rig port (Go backend on `RK_PORT+1`, where `RK_PORT` defaults to the `scripts/e2e-env.sh` derived port) — `curl localhost:<backend-port>/api/health` returns `{"status":"ok"}`, `curl localhost:<backend-port>/api/sessions` returns sessions from tmux.

---

## Phase 3: Frontend

Implement the Vite/React SPA against the new API. The backend from Phase 2 is the dev server.
Port UI components from the old implementation — the visual design and interaction patterns
are unchanged, only the API client layer changes.

**Order of implementation:**

1. **API client** (`src/api/client.ts`) — typed fetch wrappers for every endpoint in [api.md](api.md). All mutations use `POST` with path-based intent.
2. **Types** (`src/types.ts`) — finalize shared types
3. **Contexts** — `ChromeProvider` (session:window selection, sidebar/drawer state), `SessionProvider` (SSE connection)
4. **Single-view layout** (`src/app.tsx`) — top bar + sidebar + terminal + bottom bar. One route: `/:session/:window`.
5. **Sidebar** — session/window tree, collapsible sessions, fab stage inline, `[+ New Session]`
6. **Top bar** — breadcrumb dropdowns (tappable session/window switcher), `☰` hamburger, `⌘K`/`⋯`
7. **Terminal** — xterm.js + WebSocket relay
8. **Bottom bar** — modifier toggles, arrow pad, Fn dropdown, compose buffer
9. **Command palette** — keyboard shortcuts, mobile `⋯` trigger
10. **Mobile** — drawer overlay, iOS keyboard (`useVisualViewport`), touch targets, responsive collapse

**Testing approach:**

- Vitest + MSW: mock API + SSE, test UI behavior in isolation (sidebar nav, drawer, breadcrumbs, keyboard, modifiers, touch targets, viewport)
- Playwright E2E (`app/frontend/tests/e2e/`): thin suite (3-5 tests) for API round-trips (create/kill session, SSE stream). Self-managed tmux sessions in test hooks.

**Verification gate:** `just test-frontend` passes. `just test-e2e` passes. `just verify` passes (full pipeline: check + test + build).

---

## Phase 4: Cleanup

Remove old implementation. The new code is the only code.

1. Delete `packages/` directory (old Go backend + old Vite frontend)
2. Delete `e2e/` directory (old Playwright tests — now at `app/frontend/tests/e2e/`)
3. Delete `dev.sh` (replaced by `just dev`)
4. Update `pnpm-workspace.yaml` to `["app/frontend"]`
5. Clean up root `package.json` if it exists (remove old scripts)
6. Delete old `playwright.config.ts` from repo root
7. Update `docs/memory/run-kit/architecture/repo-layout.md` to reflect new paths
8. Update `docs/specs/architecture.md` if any structural decisions changed during implementation
9. Run `just verify` one final time

**Verification gate:** `just verify` passes. `git status` shows no references to `packages/` or old `e2e/`. The repo is clean.

---

## Principles Across All Phases

- **Test-first for new code** — write the test, watch it fail, implement, watch it pass
- **Port don't rewrite internal packages** — `internal/` logic is proven, copy it
- **API spec is the contract** — frontend and backend both conform to [api.md](api.md)
- **Each phase is independently shippable** — Phase 1 commits compile, Phase 2 has a working API, Phase 3 has a working UI
- **Old code is reference, not dependency** — never import from `packages/`, only read it for guidance
