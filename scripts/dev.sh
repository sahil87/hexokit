#!/usr/bin/env bash
# Start Go backend (live-reload) + Vite dev server concurrently.
# Usage: ./scripts/dev.sh [--port PORT] [--host HOST]
cleanup() {
  kill 0 2>/dev/null
  sleep 0.5
  # Force-kill any stragglers (air, vite, go backend)
  kill -9 0 2>/dev/null
}
trap cleanup EXIT

# Parse --port flag (overrides RK_PORT)
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) export RK_PORT="$2"; shift 2 ;;
    --host) export RK_HOST="$2"; shift 2 ;;
    *) shift ;;
  esac
done

export LOG_LEVEL=debug
# Default to this worktree's derived e2e port (one rig per worktree: `just dev`
# and `just test-e2e` share the derived triple, and test-e2e's self-scoped
# stale-kill reclaims it). Explicit --port / preset RK_PORT still win.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/e2e-env.sh"
export RK_PORT="${RK_PORT:-$E2E_PORT}"
export RK_HOST="${RK_HOST:-127.0.0.1}"

# An in-flight `just test-e2e` owns this worktree's rig (it holds the
# per-worktree lock from before its stale-kill until exit); its kill_triple
# would take this dev server down, and this dev server would collide with its
# ports. Warn — never block or exit: `just dev` is the interactive lane.
# E2E_HARNESS is set only by test-e2e.sh on its own dev-server launch, where
# the lock holder is the caller and the warning would be noise. The probe is
# also gated on the EFFECTIVE port being the derived one: `--port` / a preset
# RK_PORT put this server on another triple, which the harness's stale-kill
# never touches, so a warning there would be false.
if [[ -z "${E2E_HARNESS:-}" && "$RK_PORT" == "$E2E_PORT" ]] && command -v flock >/dev/null 2>&1; then
  _wt_lock_file="/tmp/rk-e2e-wt-$(id -u)-${E2E_TOKEN}.lock"
  if [[ -e "$_wt_lock_file" ]] && ! flock -n "$_wt_lock_file" -c true 2>/dev/null; then
    echo "WARNING: a just test-e2e run owns this worktree's rig (lock: $_wt_lock_file) — its stale-kill will stop this dev server; wait for it or use another worktree." >&2
  fi
fi

# Ensure cwd is repo root (supports invocation from any directory)
cd "$(dirname "$0")/.." || exit 1

# Ensure tmux.conf exists for Go embed (canonical source: configs/tmux/default.conf)
cp "$PWD/configs/tmux/default.conf" "$PWD/app/backend/build/tmux.conf"

# Dev mode: Vite serves on RK_PORT, Go backend on RK_PORT+1, code-server on RK_PORT+2.
command -v air &>/dev/null || { echo "error: air not found (go install github.com/air-verse/air@latest)"; exit 1; }

# code-server — the `code` lens upstream (change 260811-k3vp): deterministic
# port RK_PORT+2, loopback-only, auth off (the rk origin is the trust boundary;
# the embed rides the same-origin /proxy/{port}/ path). code-server is a
# required dependency (Homebrew formula dependency) and always starts — with
# ONE carve-out: a PRESET RK_CODE_SERVER_PORT means the port is externally
# managed and nothing is started here. scripts/test-e2e.sh DEPENDS on this
# (it presets the port and the e2e spec binds a stub HTTP server there — an
# unconditional export/start would clobber the harness port and probe a port
# nobody serves on CI). The deterministic +2 port is load-bearing: code-server
# keys browser-side workspace state by the proxy pathname, so a stable port is
# what keeps tabs/layout across dev restarts. Output goes to a port-suffixed
# log (never /dev/null) so a silent startup death is diagnosable.
if [[ -n "${RK_CODE_SERVER_PORT:-}" ]]; then
  echo "code-server: externally managed on :${RK_CODE_SERVER_PORT} (not started here)"
else
  export RK_CODE_SERVER_PORT=$(( RK_PORT + 2 ))
  CODE_SERVER_LOG="/tmp/rk-dev-code-server-${RK_CODE_SERVER_PORT}.log"
  # `env -u VSCODE_IPC_HOOK_CLI`: inside a VS Code integrated terminal that var
  # makes code-server act as the `code` CLI ("open in existing instance") and
  # exit with "Please specify at least one file or folder" instead of serving.
  env -u VSCODE_IPC_HOOK_CLI code-server --bind-addr "127.0.0.1:${RK_CODE_SERVER_PORT}" --auth none > "$CODE_SERVER_LOG" 2>&1 &
  echo "code-server: 127.0.0.1:${RK_CODE_SERVER_PORT} (log: ${CODE_SERVER_LOG})"
fi

(cd app/backend && RK_PORT=$(( RK_PORT + 1 )) air) &

(cd app/frontend && pnpm dev --port "$RK_PORT") &
wait
