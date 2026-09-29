# HexoKit Architecture Specification

> Target architecture for HexoKit. This document describes the system as it should be built,
> not as it currently exists. Implementation conforms to this spec.

---

## System Overview

Two independent processes in production, three in development:

1. **Go backend** (single binary, default `:6123`) — API, SSE, WebSocket terminal relay, SPA static serving
2. **Bash supervisor** (`supervisor.sh`) — builds Go + frontend, manages the server process, health checks, rollback
3. **Vite dev server** (dev only, `:5173`) — HMR, proxies `/api/*` and `/relay/*` to Go

The tmux server is an external dependency — never started or stopped by HexoKit.

---

## Repository Structure

```
run-kit/
├── app/
│   ├── backend/                       # Go module — stable backend
│   │   ├── cmd/run-kit/
│   │   │   └── main.go               # Entry point: config → router → server → signal handling
│   │   ├── api/                       # HTTP layer (handlers only, no business logic)
│   │   │   ├── router.go             # Route registration + middleware stack
│   │   │   ├── sessions.go           # GET/POST /api/sessions, POST /api/sessions/:s/kill
│   │   │   ├── windows.go            # POST create/kill/rename windows, POST keys
│   │   │   ├── directories.go        # GET /api/directories
│   │   │   ├── upload.go             # POST /api/sessions/:session/upload
│   │   │   ├── sse.go                # GET /api/sessions/stream (hub + fan-out)
│   │   │   ├── relay.go              # WS /relay/:session/:window
│   │   │   ├── health.go             # GET /api/health
│   │   │   └── spa.go                # Static file serving + SPA fallback
│   │   ├── internal/                  # Business logic (no HTTP concerns)
│   │   │   ├── tmux/
│   │   │   │   ├── tmux.go           # All tmux operations via execFile
│   │   │   │   └── tmux_test.go      # Table-driven tests (parse output, filtering)
│   │   │   ├── sessions/
│   │   │   │   ├── sessions.go       # FetchSessions: tmux → enrich → fab → response
│   │   │   │   └── sessions_test.go  # Enrichment logic, fab detection, parallel fetch
│   │   │   ├── fab/
│   │   │   │   ├── fab.go            # Read .fab-status.yaml: active change, stage, progress
│   │   │   │   └── fab_test.go
│   │   │   ├── config/
│   │   │   │   ├── config.go         # CLI > YAML > defaults resolution
│   │   │   │   └── config_test.go
│   │   │   └── validate/
│   │   │       ├── validate.go       # Name, path, tilde expansion, filename sanitization
│   │   │       └── validate_test.go
│   │   ├── go.mod
│   │   └── go.sum
│   │
│   └── frontend/                      # Vite + React SPA — disposable frontend
│       ├── src/
│       │   ├── api/
│       │   │   └── client.ts          # Typed fetch wrappers for all endpoints
│       │   ├── components/
│       │   │   ├── sidebar.tsx         # Session/window tree (desktop sidebar + mobile drawer)
│       │   │   ├── top-bar.tsx         # Breadcrumbs + status (line 1 + line 2)
│       │   │   ├── breadcrumb-dropdown.tsx  # Tappable session/window switcher
│       │   │   ├── bottom-bar.tsx      # Modifier keys, arrows, Fn, compose toggle
│       │   │   ├── compose-buffer.tsx  # Native textarea overlay for burst input
│       │   │   ├── command-palette.tsx  # Cmd+K / ⋯ trigger
│       │   │   ├── terminal-client.tsx # xterm.js + WebSocket relay
│       │   │   ├── dialog.tsx          # Create session/window dialogs
│       │   │   └── arrow-pad.tsx       # Arrow key group for bottom bar
│       │   ├── contexts/
│       │   │   ├── chrome-context.tsx  # Current session:window selection, sidebar/drawer state
│       │   │   └── session-context.tsx # SSE connection, shared session data
│       │   ├── hooks/
│       │   │   ├── use-sessions.ts
│       │   │   ├── use-keyboard-nav.ts
│       │   │   ├── use-visual-viewport.ts
│       │   │   └── use-modifier-state.ts
│       │   ├── app.tsx                # Single-view layout: top bar + sidebar + terminal + bottom bar
│       │   ├── router.tsx             # TanStack Router — one route: /:session/:window
│       │   ├── types.ts               # Shared TypeScript types
│       │   └── test-setup.ts
│       ├── tests/
│       │   ├── msw/                   # MSW handlers for mocking API + SSE
│       │   │   └── handlers.ts
│       │   └── e2e/                   # Playwright E2E tests (thin — API round-trips only)
│       │       ├── helpers.ts
│       │       └── api-integration.spec.ts
│       ├── playwright.config.ts
│       ├── vite.config.ts
│       ├── vitest.config.ts
│       └── tsconfig.json
│
├── justfile                           # Task runner (dev, build, test, daemon lifecycle)
├── pnpm-workspace.yaml                # ["app/frontend"]
├── fab/                               # Fab-kit project config + changes
└── docs/                              # Specs + memory
    ├── specs/
    │   ├── api.md                     # API specification (this companion doc)
    │   ├── architecture.md            # This document
    │   ├── project-plan.md            # Reimplementation plan
    │   ├── design.md                  # UI design philosophy
    │   └── short-term-goal.md         # MVP priorities
    └── memory/
        └── run-kit/
```

---

## Key Structural Decisions

### `app/` over `packages/` or `src/`

`packages/` implies a publishable monorepo (npm workspaces, independently versioned modules). `src/` is ambiguous in a polyglot repo (Go's `src/` carries legacy GOPATH connotations). `app/` communicates what this is: a single application with two build targets that are tightly coupled via the API spec.

### Handler files split by resource, not by HTTP feature

The current codebase has `routes.go` as a single file containing all route handlers. The new structure splits handlers by resource domain:

| File | Routes |
|------|--------|
| `router.go` | Route registration, middleware stack, chi setup |
| `health.go` | `GET /api/health` |
| `sessions.go` | `GET /api/sessions`, `POST /api/sessions`, `POST /api/sessions/:s/kill` |
| `windows.go` | `POST` create/kill/rename windows, `POST` send keys |
| `directories.go` | `GET /api/directories` |
| `upload.go` | `POST /api/sessions/:session/upload` |
| `sse.go` | `GET /api/sessions/stream` |
| `relay.go` | `WS /relay/:session/:window` |
| `spa.go` | `GET /*` catch-all |

Each handler file contains only HTTP concerns: parse request, call internal package, write response. No business logic in handlers.

### POST-only mutations

All mutating endpoints use `POST`. Intent is communicated by the URL path (e.g., `/api/sessions/:session/kill` not `DELETE /api/sessions/:session`). This simplifies the frontend client (every mutation is `fetch(url, { method: "POST", body })`), avoids CORS preflight complexity with non-simple methods, and matches the reality that these are RPC-style commands against tmux, not CRUD operations on a database.

### Go tests co-located with source

Go convention: `_test.go` files live next to the code they test. No separate `tests/` directory for the backend. Run via `go test ./...` from `app/backend/`.

### Frontend E2E tests under `app/frontend/tests/e2e/`

Playwright tests live inside the frontend package. Config at `app/frontend/playwright.config.ts`. Vitest unit tests use co-located `.test.{ts,tsx}` files (same as current).

### Removed: `internal/worktree/`

The worktree package wraps fab-kit's `wt-*` scripts but is **not exposed through any API endpoint**. Worktree management is done through tmux sessions (creating windows with CWD pointing to worktrees). The `wt-*` scripts are called directly by the orchestrator agent, not by HexoKit's API. Removing this package eliminates dead code.

### Removed: `dev.sh`

Development is launched via `just dev`, which runs Go backend + Vite dev server concurrently. No separate shell script needed.

### `internal/fab` rewritten — `.fab-status.yaml` replaces subprocess calls

The old `internal/fab` shelled out to `statusman.sh` and read `fab/current`. Both are deprecated. The new implementation reads `.fab-status.yaml` at the project root — a single YAML file that contains the active change name, progress map, confidence score, and PRs. No subprocess calls, no `fab/current`. Pure file read + YAML parse.

Enrichment is per-session (not per-window): `.fab-status.yaml` is read once from window 0's project root. All windows in a session share the same fab state.

### Other `internal/` packages ported verbatim

`tmux`, `sessions`, `config`, `validate` are well-factored with existing tests. The refactor is limited to the `api/` layer and `internal/fab`.

---

## Data Flow

```
Browser                    Go Backend                      tmux server
  │                           │                                │
  ├──GET /api/sessions───────►│                                │
  │                           ├──tmux list-sessions───────────►│
  │                           ├──tmux list-windows (parallel)─►│
  │                           ├──read .fab-status.yaml (per session)
  │◄──────────────────────────┤                                │
  │                           │                                │
  ├──GET /api/sessions/stream►│                                │
  │  (SSE, long-lived)        ├──poll every 2.5s──────────────►│
  │◄──event: sessions─────────┤  (only when clients connected) │
  │                           │                                │
  ├──WS /relay/s/w───────────►│                                │
  │  (WebSocket, long-lived)  ├──tmux split-window────────────►│
  │                           ├──PTY: tmux attach-session      │
  │◄──terminal output─────────┤◄──────pty read────────────────►│
  │──terminal input──────────►│──────pty write────────────────►│
```

---

## Security Model

| Layer | Mechanism |
|-------|-----------|
| Subprocess execution | `os/exec.CommandContext` with argument slices — never `sh -c` or string interpolation |
| Timeouts | 10s for tmux operations, no timeout for relay attach (cancelled on disconnect) |
| Input validation | All user input passes through `internal/validate` before reaching tmux |
| Path security | All paths must resolve under `$HOME` — rejects `..` traversal, `~user`, absolute paths outside home |
| Upload safety | 50 MB limit via `http.MaxBytesReader`, filename sanitized, written via `os.Create` (not subprocess) |
| CORS | Permissive (`*` origin) — HexoKit is a local dev tool, not a public service |

---

## Testing Strategy

### Go Unit Tests

Table-driven tests co-located with source (`_test.go`). Run via `go test ./...` from `app/backend/`.

| Package | What's tested |
|---------|---------------|
| `internal/validate` | Name rules, path rules, tilde expansion edge cases, filename sanitization |
| `internal/config` | CLI arg parsing, YAML parsing, override precedence, defaults |
| `internal/tmux` | Output parsing (list-sessions, list-windows), byobu filtering, activity computation |
| `internal/sessions` | Project root derivation, parallel enrichment |
| `internal/fab` | `.fab-status.yaml` parsing, active stage derivation, missing file handling |
| `api/` | Handler integration tests — request/response shapes, validation errors, status codes |

**Handler tests** are the new addition. Each handler file gets a corresponding `_test.go` that tests HTTP behavior: correct status codes, error shapes, content types, URL param parsing. These use `httptest.NewRecorder` with the chi router, mocking `internal/` interfaces where needed.

### Frontend Unit Tests (MSW-backed)

Vitest + jsdom + MSW (Mock Service Worker). Co-located `.test.{ts,tsx}` files. Run via `just test-frontend` from repo root.

MSW mocks the API and SSE stream, enabling frontend tests to run without a Go backend. Tests cover: sidebar navigation, drawer open/close, breadcrumb dropdowns, keyboard shortcuts, modifier state, touch targets, `visualViewport` behavior, command palette.

### Playwright E2E Tests (thin)

3-5 browser-level integration tests for API round-trips: create session, kill session, SSE stream delivers data. Run via `just test-e2e` from repo root. Config at `app/frontend/playwright.config.ts`. Self-manages tmux sessions in test hooks.

---

## Build & Deploy

### Development

```bash
just dev
# Starts concurrently:
#   1. Go backend (air live-reload) on RK_PORT + 1
#   2. Vite dev server on RK_PORT (default: the worktree's derived rig port — see scripts/e2e-env.sh), proxying /api/* and /relay/* to the backend
# Browser connects to the Vite port
```

### Production

```bash
./supervisor.sh
# 1. go build -o bin/run-kit ./cmd/run-kit      (Go binary, from app/backend/)
# 2. pnpm build                                  (frontend → app/frontend/dist/)
# 3. Start Go binary (serves API + SPA on one port)
# 4. Health check: GET /api/health (10s timeout)
# 5. Poll for .restart-requested file
# 6. On failure: git revert HEAD → rebuild → restart
```

### Optional: TLS via Tailscale Serve

TLS termination is handled by Tailscale Serve. Not required for local dev. See [Tailscale guide](../wiki/tailscale.md).
