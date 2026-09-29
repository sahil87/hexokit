# run-kit task runner
# Usage: just <recipe>    List all: just --list

# This is automatically done by direnv
set dotenv-load := false

# ─── Doctor ──────────────────────────────────────────────────

# Check that all required tools and dependencies are installed
doctor:
    scripts/doctor.sh

# ─── Setup & Development ──────────────────────────────────────────────

# Ensure tmux.conf exists for Go embed (canonical source: configs/tmux/default.conf)
_ensure-tmux-conf:
    cp configs/tmux/default.conf app/backend/build/tmux.conf

# Copy default config files for local development
setup: _ensure-tmux-conf
    cd app/frontend && pnpm install
    cd app/code-bridge && pnpm install
    [ -f .env.local ] || cp .env .env.local
    cd app/frontend && pnpm exec playwright install --with-deps chromium

# Start Go backend (live-reload) + Vite dev server concurrently (just dev --port 4000)
# Backend runs at Frontend port + 1; code-server (when installed) at Frontend
# port + 2 with RK_CODE_SERVER_PORT exported — enables the `code` lens.
# Default: the worktree's derived e2e port (scripts/e2e-env.sh)
dev *args:
    scripts/dev.sh {{args}}

# Run any rk CLI command from source (just dev-rk serve -d)
# Port default comes from ports.env (the one source of truth).
dev-rk *args:
    . app/backend/internal/portpolicy/ports.env && cd app/backend && RK_PORT=$(( ${RK_PORT:-$PORTPOLICY_DAEMON_DEFAULT} + 1 )) go run ./cmd/rk {{args}}

# Start only the Go backend with live-reload (port RK_PORT+1, default 6124)
dev-backend:
    . app/backend/internal/portpolicy/ports.env && cd app/backend && LOG_LEVEL=debug RK_PORT=$(( ${RK_PORT:-$PORTPOLICY_DAEMON_DEFAULT} + 1 )) air

# Start only the Vite dev server (port RK_PORT, default 6123)
dev-frontend:
    . app/backend/internal/portpolicy/ports.env && cd app/frontend && pnpm dev --port "${RK_PORT:-$PORTPOLICY_DAEMON_DEFAULT}"

# ─── Prod & Daemon mode ────────────────────────────────────────────────────

# Build Go binary + frontend for production (embedded assets + ldflags)
build:
    scripts/build.sh

# Bump version, commit, tag, and push (CI handles the rest)
release bump="patch":
    scripts/release.sh {{bump}}

# Build and run production binary
prod:
    just build
    ./dist/rk

# Start rk daemon in background tmux session
up:
    just build
    ./dist/rk serve -d

# Stop rk daemon
down:
    ./dist/rk serve --stop

# Restart rk daemon
restart:
    just build
    ./dist/rk serve --restart

# ─── Desktop shell ───────────────────────────────────────────

# Compile + launch the Electron desktop shell (RK_DESKTOP_URL=http://… loads a URL directly)
dev-desktop:
    scripts/dev-desktop.sh

# Build desktop packages into app/desktop/release/ (just build-desktop [mac|win|linux], default: host platform)
build-desktop *args:
    scripts/build-desktop.sh {{args}}

# ─── Test ────────────────────────────────────────────────────

# Run all tests (backend + frontend + e2e) with phase banners + per-run log
test:
    @scripts/test-all.sh

# Run Go tests
test-backend: _ensure-tmux-conf
    cd app/backend && go test ./...

# Run Go tests for the api package under the race detector
test-backend-race: _ensure-tmux-conf
    cd app/backend && go test -race ./api/...

# Run Vitest unit tests
test-frontend:
    cd app/frontend && pnpm test

# Run Playwright e2e tests on this worktree's derived port triple (rig block
# 21000–21299, app/backend/internal/portpolicy/ports.env; see
# scripts/e2e-env.sh) with an isolated per-worktree tmux server,
# serialized per worktree by a flock (a second run in the same worktree waits)
test-e2e *args:
    scripts/test-e2e.sh {{args}}

# Run the desktop shell's Playwright Electron e2e lane against this worktree's derived rig (xvfb-run when headless)
test-desktop-e2e *args:
    scripts/test-desktop-e2e.sh {{args}}

# Run ad-hoc Playwright commands (just pw test, just pw test mobile-layout, just pw test --ui)
# Targets this worktree's derived rig — the same identity `just dev` and
# `just test-e2e` use here, so the externally-managed dev server is found
# deterministically. RK_E2E_PORT / E2E_TMUX_SERVER override.
pw *args:
    scripts/pw.sh {{args}}

# Idle-CPU probe against a LIVE daemon (just perf-idle-cpu /runKit 30, just perf-idle-cpu /runKit/@99 --reduced-motion)
# Loads one rk route, idles N seconds, prints per-process CPU %, renderer
# main-thread breakdown, running animations, per-socket msg/s + kB/s by event
# type, and the top JS self-time entries. Base URL from `rk url` (--url
# overrides). Not a test — it asserts nothing; one instance at a time.
perf-idle-cpu *args:
    scripts/perf-idle-cpu.sh {{args}}

# ─── Assets ──────────────────────────────────────────────────

# Generate icon variants from canonical icon.svg
icons:
    scripts/generate-icons.sh

# ─── Quality ─────────────────────────────────────────────────

# Type-check frontend without emitting
check:
    cd app/frontend && pnpm exec tsc --noEmit

# Full verification: type-check, test, build
verify: check test build
