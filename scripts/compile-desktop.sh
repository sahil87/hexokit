#!/usr/bin/env bash
# Compile an Electron shell checkout (install deps first, then
# `pnpm run compile`). scripts/test-desktop-e2e.sh and scripts/demo.sh share
# this so the shell e2e and demo lanes compile identically. `frozen` is the
# demo lane's --before temp worktree: a lockfile-faithful, offline-first
# install (the temp tree always lacks node_modules, and a base too old for
# the current pnpm fails as a before failure, not a corrupt store write).
set -euo pipefail
dir="${1:?usage: compile-desktop.sh <app-desktop-dir> [frozen]}"
if [[ "${2:-}" == "frozen" ]]; then
  ( cd "$dir" && pnpm install --frozen-lockfile --prefer-offline && pnpm run compile )
else
  ( cd "$dir" && { [ -d node_modules ] || pnpm install; } && pnpm run compile )
fi
