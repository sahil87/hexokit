#!/usr/bin/env bash
# Per-worktree e2e identity derivation. SOURCE this script; do not execute it.
#
# Sets (without exporting — consumers pass the values into child envs
# explicitly): E2E_TOKEN, E2E_PORT, E2E_CODE_SERVER_PORT, E2E_TMUX_FAMILY,
# E2E_TMUX_SERVER, plus the rig-block bounds E2E_RIG_START / E2E_RIG_END /
# E2E_RIG_TRIPLES for test-e2e.sh's rig arithmetic.
#
# Pure derivation: probes no ports, starts nothing, touches no files. Repeated
# sourcing in the same worktree yields the same identity, so a later `just pw`
# rediscovers the rig `just test-e2e` started. The identity is keyed on THIS
# script's own checkout (git -C on the script dir), never on the caller's cwd,
# so it is stable regardless of where the sourcing command runs.
#
# The ambient RK_PORT is deliberately NOT an override input: direnv exports
# RK_PORT into every shell on this box, so consulting it would mean the
# derivation never applies. Overrides are dedicated: RK_E2E_PORT (port-triple
# base), preset E2E_TMUX_SERVER / E2E_TMUX_FAMILY (socket family), and preset
# RK_CODE_SERVER_PORT (read as an override but NEVER assigned here — the
# derived code-server/stub port is exposed as E2E_CODE_SERVER_PORT so sourcing
# cannot masquerade as the "externally managed" preset dev.sh keys on).

_e2e_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_e2e_toplevel="$(git -C "$_e2e_script_dir" rev-parse --show-toplevel 2>/dev/null || true)"
# Outside a git checkout the token falls back to the repo-root basename.
[ -n "$_e2e_toplevel" ] || _e2e_toplevel="$(cd "$_e2e_script_dir/.." && pwd)"

# Token: lowercase alphanumerics from the worktree basename (hyphens stripped)
# plus a 2-char hash tail of the absolute toplevel path, so two same-named
# checkouts still diverge. Hyphen-free is load-bearing: every socket matcher
# (cleanup glob, global-teardown scan, RK_SERVER_ALLOWLIST) anchors on
# "rk-test-e2e-<token>-" WITH the trailing hyphen, so `familyA` can prefix a
# `familyB` socket name only when the tokens are equal — cross-worktree
# matching is impossible by construction under glob and HasPrefix alike.
_e2e_wt="$(basename "$_e2e_toplevel" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
_e2e_path_hash="$(printf '%s' "$_e2e_toplevel" | cksum | awk '{print $1}')"
E2E_TOKEN="$(printf '%s%02x' "$_e2e_wt" "$(( _e2e_path_hash % 256 ))")"
# An all-digits token would put a numeric second-to-last hyphen field into the
# primary socket name, satisfying parseTestSocketPID and exposing the family
# to the Go post-sweep — prefix it out of that shape.
[[ "$E2E_TOKEN" =~ ^[0-9]+$ ]] && E2E_TOKEN="wt$E2E_TOKEN"

# Port triple: deterministic cksum hash of the token into the e2e rig block
# defined by the port policy — app/backend/internal/portpolicy/ports.env is
# the single source of truth for every reserved/default port. The block holds
# PORTPOLICY_RIG_START..PORTPOLICY_RIG_END as triples of (Vite, Go backend,
# code-server stub): Vite on E2E_PORT, Go backend on E2E_PORT+1 (the justfile
# dev convention), code-server/stub on E2E_PORT+2. The stub port is
# E2E_CODE_SERVER_PORT — assigning RK_CODE_SERVER_PORT here would read as a
# genuine preset to dev.sh's externally-managed carve-out. The policy
# variables are temporaries; the derived bounds stay (unexported) for
# test-e2e.sh's wrap/alignment arithmetic.
source "$_e2e_script_dir/../app/backend/internal/portpolicy/ports.env"
E2E_RIG_START="$PORTPOLICY_RIG_START"
E2E_RIG_END="$PORTPOLICY_RIG_END"
E2E_RIG_TRIPLES=$(( (PORTPOLICY_RIG_END - PORTPOLICY_RIG_START + 1) / 3 ))
_e2e_hash="$(printf '%s' "$E2E_TOKEN" | cksum | awk '{print $1}')"
E2E_PORT="${RK_E2E_PORT:-$(( PORTPOLICY_RIG_START + (_e2e_hash % E2E_RIG_TRIPLES) * 3 ))}"
E2E_CODE_SERVER_PORT="${RK_CODE_SERVER_PORT:-$(( E2E_PORT + 2 ))}"

# Socket family: every member carries a role segment after the token — the
# primary is "${E2E_TMUX_FAMILY}0", spec secondaries append "<role>-<pid>-<epoch>".
# The rk-test- umbrella is load-bearing (supervisor resurrection guard,
# `rk mux reap --prefix rk-test` default, IsTestServerName). A preset server
# with no preset family implies family = the server name AS-IS (no appended
# hyphen) so prefix matching admits the primary itself — `HasPrefix "<server>-"`
# would exclude `<server>` from the allowlist and the `<server>-*` trap glob
# would leak it.
if [ -z "${E2E_TMUX_FAMILY:-}" ]; then
  if [ -n "${E2E_TMUX_SERVER:-}" ]; then
    E2E_TMUX_FAMILY="$E2E_TMUX_SERVER"
  else
    E2E_TMUX_FAMILY="rk-test-e2e-${E2E_TOKEN}-"
  fi
fi
E2E_TMUX_SERVER="${E2E_TMUX_SERVER:-${E2E_TMUX_FAMILY}0}"

unset _e2e_script_dir _e2e_toplevel _e2e_wt _e2e_path_hash _e2e_hash \
  PORTPOLICY_DAEMON_DEFAULT PORTPOLICY_DAEMON_LEGACY PORTPOLICY_RIG_START PORTPOLICY_RIG_END \
  PORTPOLICY_TUNNEL_START PORTPOLICY_TUNNEL_END PORTPOLICY_SENTINEL
