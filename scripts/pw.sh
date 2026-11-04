#!/usr/bin/env bash
# Ad-hoc Playwright lane (just pw ...) against THIS worktree's derived e2e rig.
# Sources the same per-worktree derivation as scripts/test-e2e.sh so `just pw`
# rediscovers the externally-managed server started by `just dev` here —
# deterministic by construction (e2e-env.sh probes nothing). Ambient RK_PORT
# is not consulted; RK_E2E_PORT / preset E2E_TMUX_SERVER override. Playwright
# reads the base port from E2E_PORT (a variable only the harness sets, so a
# bare `playwright test` falls back to the connect-to-nothing :21999 sentinel); RK_PORT
# is still exported for any non-Playwright reader in the child env.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/e2e-env.sh"

cd "$SCRIPT_DIR/../app/frontend"
exec env RK_PORT="$E2E_PORT" E2E_PORT="$E2E_PORT" E2E_TMUX_SERVER="$E2E_TMUX_SERVER" E2E_TMUX_FAMILY="$E2E_TMUX_FAMILY" RK_CODE_SERVER_PORT="$E2E_CODE_SERVER_PORT" RK_E2E_PERF=1 pnpm exec playwright "$@"
