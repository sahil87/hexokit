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
"$SCRIPT_DIR/compile-desktop.sh" "$SCRIPT_DIR/../app/desktop"
RK_E2E_LANE=desktop exec "$SCRIPT_DIR/test-e2e.sh" "$@"
