#!/usr/bin/env bash
set -euo pipefail

# Per-worktree derived identity (E2E_PORT / E2E_TMUX_FAMILY / E2E_TMUX_SERVER /
# E2E_CODE_SERVER_PORT) — see scripts/e2e-env.sh. Ambient RK_PORT is not an
# input; RK_E2E_PORT / preset E2E_TMUX_SERVER override. The derived stub port
# is promoted to the RK_CODE_SERVER_PORT preset dev.sh keys on (the harness's
# externally-managed carve-out). The run holds the per-worktree lock
# /tmp/rk-e2e-wt-<uid>-<token>.lock from before the stale-kill until exit, so
# sibling runs started in the SAME worktree queue instead of colliding.
#
# RK_E2E_LANE selects which Playwright project runs against the rig: `web`
# (default) is app/frontend's suite; `desktop` (via scripts/test-desktop-e2e.sh)
# is app/desktop's Electron lane — one rig, one lock, one cleanup for both.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/e2e-env.sh"
RK_CODE_SERVER_PORT="$E2E_CODE_SERVER_PORT"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Rig count. 1 (the default) is the single-rig lane: one tmux server + one
# `just dev` shared by a serial Playwright run — what developers run locally.
# RK_E2E_WORKERS=N (N>1) is the multi-rig lane: N complete rigs on this box
# (tmux server, Go backend, Vite, code-server stub port, state home), one per
# Playwright worker, so N spec files run at once. Every rig gets its own
# socket SUB-family (${E2E_TMUX_FAMILY}w<i>-) and its backend's allowlist is
# that sub-family, so rig A's server list never shows rig B's sessions — the
# SSE cross-talk that forces the single-rig lane serial. The extra rigs take
# the next port triples (+3 per rig) inside the rig block (E2E_RIG_START –
# E2E_RIG_END); those
# triples belong to OTHER worktrees' derivations on a shared dev box, which
# is why this lane is meant for CI (one worktree per VM).
E2E_WORKERS="${RK_E2E_WORKERS:-1}"
# `10#` forces decimal so a leading zero ("08") is neither an arithmetic error
# nor octal.
{ [[ "$E2E_WORKERS" =~ ^[0-9]+$ ]] && [ $(( 10#$E2E_WORKERS )) -ge 1 ]; } && E2E_WORKERS=$(( 10#$E2E_WORKERS )) || E2E_WORKERS=1
# The desktop lane (RK_E2E_LANE=desktop, scripts/test-desktop-e2e.sh) is
# single-rig by construction — one shell over one rig's two-origin host pair —
# so it always runs one worker against app/desktop's Playwright project. The
# web lane is unchanged.
if [ "${RK_E2E_LANE:-web}" = desktop ]; then
  E2E_WORKERS=1
  PLAYWRIGHT_DIR="app/desktop"
else
  PLAYWRIGHT_DIR="app/frontend"
fi
# The rig table wraps inside the rig block's triples (see the rig loop
# below), so more rigs than triples would alias a rig onto rig 0's ports
# undetected.
if [ "$E2E_WORKERS" -gt "$E2E_RIG_TRIPLES" ]; then
  echo "ERROR: RK_E2E_WORKERS=$E2E_WORKERS exceeds the $E2E_RIG_TRIPLES port triples of the e2e block ($E2E_RIG_START-$E2E_RIG_END); one rig per triple." >&2
  exit 1
fi

# Per-worktree exclusive lock — the rig identity (port triple + socket
# family) derives from E2E_TOKEN, so one lock per token is one lock per rig.
# Taken BEFORE kill_triple: the stale-kill below reclaims "this worktree's
# own leftover", and without this lock a concurrent sibling run in the same
# worktree IS that leftover — the second run kills the first run's dev server
# and both then fight over one rig. flock(2) releases when the holder's last
# descriptor closes, so a crashed or SIGKILLed run leaves no stale lock — no
# PID file, no cleanup step — PROVIDED no long-lived child inherits the fd
# (see without_lock_fd below).
#
# Ordering with the slot semaphore further down: worktree lock → stale-kill +
# server start → slot → Playwright. No deadlock is possible: worktree locks
# are independent of each other (a run holds exactly one, its own token's),
# and every slot holder finishes and releases regardless of any worktree
# lock, so a run waiting on a slot while holding its worktree lock waits on
# something that always completes. The harness never kills a sibling run —
# the older run may be the user's — so contention waits, bounded.
_wt_lock_fd=""
if command -v flock >/dev/null 2>&1; then
  _wt_lock_file="/tmp/rk-e2e-wt-$(id -u)-${E2E_TOKEN}.lock"
  # Grouped so the 2>/dev/null scopes to the open: a bare `exec {fd}>>f
  # 2>/dev/null` redirects the SHELL's stderr permanently.
  if { exec {_wt_lock_fd}>>"$_wt_lock_file"; } 2>/dev/null; then
    if ! flock -n "$_wt_lock_fd"; then
      echo "e2e lock: another run holds this worktree's rig — waiting (up to 30m)" >&2
      if ! flock -w 1800 "$_wt_lock_fd"; then
        echo "ERROR: e2e lock: timed out after 30m waiting for $_wt_lock_file — another just test-e2e in this worktree is still running (or a process it started is holding the lock); this run did not touch the rig." >&2
        exit 1
      fi
    fi
  else
    echo "e2e lock: cannot open $_wt_lock_file — running unlocked" >&2
    _wt_lock_fd=""
  fi
else
  # Stock macOS has no flock(1) — degrade to unlocked (mirrors the slot throttle).
  echo "e2e lock: flock(1) not found — running unlocked" >&2
fi

# The lock belongs to THIS process alone. A tmux server daemonizes with
# inherited descriptors and outlives a SIGKILLed harness; the dev server runs
# in its own process group for the same reason; Playwright workers spawn
# secondary tmux servers. Any of them holding the fd would pin the lock for
# the next run's 30-minute wait, so every long-lived child launch closes it.
# `{var}>&-` with an EMPTY variable is a bash error, hence the two arms.
without_lock_fd() {
  if [ -n "$_wt_lock_fd" ]; then "$@" {_wt_lock_fd}>&-; else "$@"; fi
}

# Hermetic per-run state: the backend's disk carve-outs (layout snapshots, the
# PR-status seed cache) land under this temp dir instead of the developer's
# real $XDG_STATE_HOME/hexokit, and the EXIT trap removes it. The config root
# is isolated too: RK_CONFIG_DIR (exported to the backend launch and the
# playwright run below) points settings reads/writes at the per-run
# $E2E_STATE_HOME/config instead of the developer's real
# ~/.config/hexokit/config.yaml, so parallel worktree runs cannot race on it.
# Specs that touch the file keep their snapshot/restore pattern as the
# fallback for the interactive `just pw` lane, which sets no RK_CONFIG_DIR.
E2E_STATE_HOME="$(mktemp -d)"

# Lay out one rig's state home: the settings config dir plus a data home
# carrying a fixture code-bridge extension manifest. The manifest gives the
# code-bridge status route a deterministic `installed: true`: the backend
# derives it from codeserver.ExtensionsDir, the rig's ONLY reader of
# XDG_DATA_HOME (code-server is stubbed, and a spawn would respect the
# externally-managed port preset), so a per-run data home makes the answer
# independent of the box's real extensions dir. The data home is forwarded
# ONLY to the backend launch, never to the Playwright run.
make_state_home() {
  local root="$1"
  local ext_dir="$root/data/code-server/extensions/run-kit.rk-code-bridge-0.0.0-e2e"
  mkdir -p "$root/config" "$ext_dir"
  printf '%s' '{"name":"rk-code-bridge","publisher":"run-kit","version":"0.0.0-e2e"}' \
    > "$ext_dir/package.json"
}
make_state_home "$E2E_STATE_HOME"
RK_CONFIG_DIR="$E2E_STATE_HOME/config"
E2E_DATA_HOME="$E2E_STATE_HOME/data"

# DEV_PGIDS holds the process-group IDs of the detached server launches (one
# `just dev` group in the single-rig lane; a backend group and a Vite group
# per rig in the multi-rig lane). Empty until launch so cleanup running early
# is a no-op for the group kill.
DEV_PGIDS=()

cleanup() {
  # Kill ONLY the dev server's own process group — never `kill 0`.
  #
  # `kill 0` signals every process in THIS script's group. Because the script
  # is not detached, that group is the CALLER's group: when this runs inside an
  # interactive session (or a subagent that launched it inline), `kill 0`
  # SIGTERMs the caller's tmux servers / `-CC` control clients sharing the
  # group — silently destroying live, unrelated tmux sessions (observed:
  # kit/abbb/runWork dying mid-session with no tmux kill-server command). The
  # dev server is launched into its OWN process group below (via `set -m` job
  # control), so we target that group by negative PGID and leave the caller's
  # group untouched.
  # `${arr[@]+"${arr[@]}"}`: an empty array under `set -u` is an unbound
  # variable on bash 3.2 (stock macOS), and cleanup can fire before any launch.
  local pgid
  for pgid in ${DEV_PGIDS[@]+"${DEV_PGIDS[@]}"}; do
    kill -- "-$pgid" 2>/dev/null || true
  done
  # Kill this worktree's own socket family: the primary (…-0) AND any
  # secondary servers tests spun up (…-multi-*, …-scope-*, …). The glob
  # anchors on E2E_TMUX_FAMILY (trailing hyphen included); because tokens are
  # hyphen-free, it can only ever match THIS worktree's family — never a
  # sibling worktree's. The trap fires on EXIT regardless of cause (normal
  # completion, set -e error, SIGINT/SIGTERM from Ctrl-C), so this reaps
  # secondaries even when a spec's afterAll never ran. Best-effort: a socket
  # may already be gone.
  #
  # A token-less anchor is refused: it is a strict prefix of EVERY derived
  # family, so the glob would reach sibling worktrees' in-flight servers. It
  # arises when E2E_TMUX_SERVER is preset to a bare default with no family —
  # e2e-env.sh then sets the family to the server name as-is. The primary is
  # still reaped by its exact name (never a prefix).
  # tmux does not unlink a killed server's socket file, so each kill below is
  # paired with an rm of the exact file just targeted — leaked files pile up in
  # /tmp/tmux-<uid>/ and /api/servers probes every one of them per request. The
  # glob loop also visits family sockets whose servers are ALREADY dead (a dead
  # socket still passes -S): the kill fails best-effort and the rm then clears
  # the residue file (e.g. secondaries a spec's afterAll killed mid-run).
  case "$E2E_TMUX_FAMILY" in
    rk-test-e2e | rk-test-e2e-)
      echo "WARNING: refusing the family socket sweep — anchor '$E2E_TMUX_FAMILY' is a bare default that prefixes every worktree's family. Reaping only the primary '$E2E_TMUX_SERVER'." >&2
      tmux -L "$E2E_TMUX_SERVER" kill-server 2>/dev/null || true
      rm -f "/tmp/tmux-$(id -u)/$E2E_TMUX_SERVER" 2>/dev/null || true
      ;;
    *)
      for sock in "/tmp/tmux-$(id -u)/${E2E_TMUX_FAMILY}"*; do
        [ -S "$sock" ] || continue
        tmux -L "$(basename "$sock")" kill-server 2>/dev/null || true
        rm -f "$sock" 2>/dev/null || true
      done
      ;;
  esac
  rm -rf "$E2E_STATE_HOME"
}
trap cleanup EXIT

# Self-scoped stale-kill: probe ONLY the derived port triple. Nobody else can
# own these ports — they are this worktree's by construction — so this claims
# them from this worktree's own leftover `just dev`/previous run without the
# old machine-wide 3020/3021 kill hazard.
kill_triple() {
  local base="${1:-$E2E_PORT}"
  lsof -iTCP:"$base" -iTCP:$(( base + 1 )) -iTCP:$(( base + 2 )) -sTCP:LISTEN -t 2>/dev/null | xargs kill 2>/dev/null || true
}
triple_busy() {
  local base="${1:-$E2E_PORT}"
  # String capture, not a grep -q pipe: grep's early exit SIGPIPEs lsof and
  # pipefail would report the busy triple as free.
  [ -n "$(lsof -iTCP:"$base" -iTCP:$(( base + 1 )) -iTCP:$(( base + 2 )) -sTCP:LISTEN -t 2>/dev/null)" ]
}
kill_triple
sleep 1
_steps=0
# Step forward by 3 only when a derived port is STILL busy after the kill —
# an unkillable foreign owner (e.g. another user's process); a port this
# worktree owns dies to the kill above. Bounded to the rig block.
while triple_busy; do
  if [ $(( E2E_PORT + 3 + 2 )) -gt "$E2E_RIG_END" ] || [ "$_steps" -ge 20 ]; then
    echo "ERROR: no free port triple in the e2e block ($E2E_RIG_START-$E2E_RIG_END); set RK_E2E_PORT explicitly." >&2
    exit 1
  fi
  E2E_PORT=$(( E2E_PORT + 3 ))
  RK_CODE_SERVER_PORT=$(( E2E_PORT + 2 ))
  _steps=$(( _steps + 1 ))
  kill_triple
  sleep 1
done
if [ "$_steps" -gt 0 ]; then
  echo "NOTE: derived ports busy with an unkillable owner; stepped forward to :$E2E_PORT."
  echo "      A stepped-forward rig is not derivable by 'just pw' — pass RK_E2E_PORT=$E2E_PORT to it."
fi

# Rig table, indexed by Playwright parallel index. The single-rig lane is one
# row holding the derived identity unchanged. The multi-rig lane gives every
# rig (rig 0 included) a socket sub-family so no rig's allowlist prefixes
# another's servers; the family anchor E2E_TMUX_FAMILY still prefixes them
# all, so the cleanup trap and global teardown reap every rig unchanged.
RIG_PORT=()
RIG_CODE_PORT=()
RIG_SERVER=()
RIG_FAMILY=()
RIG_STATE=()
if [ "$E2E_WORKERS" -eq 1 ]; then
  RIG_PORT+=("$E2E_PORT")
  # The single rig's stub port is the derived +2 OR a preset RK_CODE_SERVER_PORT
  # (e2e-env.sh honors the preset); the row carries whichever applies so the
  # worker-side remap never re-derives it and discards the preset.
  RIG_CODE_PORT+=("$RK_CODE_SERVER_PORT")
  RIG_SERVER+=("$E2E_TMUX_SERVER")
  RIG_FAMILY+=("$E2E_TMUX_FAMILY")
  RIG_STATE+=("$E2E_STATE_HOME")
else
  for (( i=0; i<E2E_WORKERS; i++ )); do
    # Rig i takes the i-th triple after the derived one, WRAPPING inside the
    # rig block so a worktree that hashes to the last triple still gets a
    # valid rig 1 (last triple → block start), rather than falling off the
    # end. A preset RK_E2E_PORT outside (or misaligned inside) the block is
    # the caller's range: plain +3 per rig there.
    if [ "$i" -eq 0 ]; then
      _rig_port="$E2E_PORT"
    elif [ "$E2E_PORT" -ge "$E2E_RIG_START" ] && [ "$E2E_PORT" -le $(( E2E_RIG_END - 2 )) ] && [ $(( (E2E_PORT - E2E_RIG_START) % 3 )) -eq 0 ]; then
      _rig_port=$(( E2E_RIG_START + ( ( (E2E_PORT - E2E_RIG_START) / 3 + i ) % E2E_RIG_TRIPLES ) * 3 ))
    else
      _rig_port=$(( E2E_PORT + 3 * i ))
    fi
    if [ "$i" -gt 0 ]; then
      # Rig 0's triple was reclaimed above because it is this worktree's by
      # construction. The extra triples are NOT: in the rig block they
      # are other worktrees' derived triples, so nothing here may kill a
      # listener on them — a busy extra triple is a foreign owner (or a
      # sibling's live rig) and the run fails loud instead. On CI (one
      # worktree per VM) they are always free.
      if triple_busy "$_rig_port"; then
        echo "ERROR: rig $i's port triple (:$_rig_port) is already in use; the multi-rig lane needs RK_E2E_WORKERS consecutive free triples and never kills a listener outside its own derived triple. Use RK_E2E_WORKERS=1 on a shared dev box." >&2
        exit 1
      fi
    fi
    RIG_PORT+=("$_rig_port")
    RIG_CODE_PORT+=("$(( _rig_port + 2 ))")
    RIG_SERVER+=("${E2E_TMUX_FAMILY}w${i}-0")
    RIG_FAMILY+=("${E2E_TMUX_FAMILY}w${i}-")
    RIG_STATE+=("$E2E_STATE_HOME/rig$i")
    make_state_home "$E2E_STATE_HOME/rig$i"
  done
  # Rig 0 is what the harness-level vars describe from here on: the Playwright
  # main process (reporter, webServer probe, global teardown's primary) and
  # any worker whose rig lookup finds no row use these; workers re-point the
  # same vars at their own row (tests/e2e/_rig.ts).
  E2E_PORT="${RIG_PORT[0]}"
  RK_CODE_SERVER_PORT="${RIG_CODE_PORT[0]}"
  E2E_TMUX_SERVER="${RIG_SERVER[0]}"
  RK_CONFIG_DIR="${RIG_STATE[0]}/config"
  echo "multi-rig lane: $E2E_WORKERS rigs — ports ${RIG_PORT[*]} — servers ${RIG_SERVER[*]}"
fi

# Start a dedicated tmux server for e2e tests and seed it. Each rig's primary
# is seeded identically so every worker sees the same starting state.
seed_tmux_server() {
  local server="$1"
  without_lock_fd tmux -L "$server" new-session -d -s e2e-init -x 80 -y 24
  # Convention: test servers carry the @rk_srv_ephemeral creator opt-out mark (belt-and-braces alongside the rk-test-* name umbrella).
  tmux -L "$server" set-option -s @rk_srv_ephemeral 1
  # The rig's servers are rk's own substrate: mark them @rk_srv_managed so the
  # WS-attach conf reload fires (specs rely on rk's tmux.conf — e.g.
  # allow-passthrough for wrapped OSC — reaching the server on first view;
  # an unmarked server is external and rk no longer pushes conf into it).
  tmux -L "$server" set-option -s @rk_srv_managed 1

  # Pre-seed LEGACY option names so the daemon's once-per-server migration sweep
  # converges them to @rk_srv_*/@rk_win_* on attach (the WS-attach/reload-config
  # sweep hook). Removed when the legacy-name deprecation window closes. The
  # e2e-init first window carries window-scope legacy role/url/note; the legacy
  # sweep spec asserts the convergence.
  local init_win_id
  init_win_id="$(tmux -L "$server" display-message -p -t e2e-init '#{window_id}')"
  tmux -L "$server" set-option -s @rk_origin e2e-legacy
  tmux -L "$server" set-option -s @rk_session_order '["e2e-init"]'
  tmux -L "$server" set-option -w -t "$init_win_id" @rk_role operator
  tmux -L "$server" set-option -w -t "$init_win_id" @rk_url /about:blank
  tmux -L "$server" set-option -w -t "$init_win_id" @rk_note '1:e2e-legacy-note'
}
for _server in "${RIG_SERVER[@]}"; do
  seed_tmux_server "$_server"
done

# Start the dev server in its OWN process group, so cleanup can kill the whole
# dev subtree (just -> air/vite/node children) by PGID without ever signalling
# the caller's group (the `kill 0` grenade this replaced killed live operator
# tmux servers — see the cleanup() comment above).
#
# `set -m` enables job control, which makes each `&` background job a process-
# group leader (its PGID == its PID). This is portable: it needs no external
# binary, so it works on macOS (which has no `setsid` — that's util-linux, not
# BSD) as well as Linux/CI. We scope monitor mode to just this launch and turn
# it back off immediately (after capturing the PGID) so the rest of the script
# keeps its normal job behavior.
#
# RK_SERVER_ALLOWLIST scopes the backend's READ path: tmux.ListServers (and
# every consumer rooted at it — /api/servers, board enumeration) returns only
# this worktree's e2e family, so board routes open one SSE per test server
# instead of one per live operator server on a busy box. It is anchored on
# E2E_TMUX_FAMILY (trailing hyphen) so the primary (…-0) and every secondary
# are admitted. This is distinct from E2E_TMUX_SERVER, which scopes the WRITE
# socket the tests target.
#
# RK_CODE_SERVER_PORT (260811-k3vp) configures the code lens/surface for the
# code-surface spec — the spec binds a stub HTTP server on this port and
# toggles it to drive the reachable/not-running states. The value is the
# derived triple's +2 (e2e-env.sh; a preset env var still wins), so parallel
# worktrees never collide on the stub. The same value is exported to the
# playwright run below so the spec and the backend agree on the port.
# The child closes the worktree lock fd before exec (it must not pin the lock
# past this harness — see without_lock_fd), and carries E2E_HARNESS=1 so
# dev.sh's lock probe stays quiet for the holder's own dev server.
_close_lock="${_wt_lock_fd:+exec $_wt_lock_fd>&-;}"
SELF_PGID=$(ps -o pgid= -p "$$" 2>/dev/null | tr -d ' ')

# Launch a long-lived server command in its OWN process group and record the
# group in DEV_PGIDS. The argument is a bash -c string; the lock fd is closed
# ahead of it.
#
# Verify job control actually put the child in its OWN process group before we
# trust the PGID for the negative-PGID kill in cleanup(). `set -m` normally
# makes a background job a group leader (PGID == PID), but if it silently did
# NOT (an unexpected shell/environment), the PGID would equal THIS script's
# PGID — and `kill -- -$PGID` would grenade the caller's whole group (the
# exact disaster this design prevents). Read the child's real PGID via `ps` and
# abort if it matches our own; the group is not recorded on abort, so the EXIT
# trap's group-kill skips it. (Per PR #220 review.)
spawn_group() {
  local cmd="$1" pid pgid
  set -m
  bash -c "$_close_lock $cmd" &
  pid=$!
  set +m
  pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
  if [ -z "$pgid" ]; then
    echo "ERROR: could not read server PGID (pid $pid); aborting before the EXIT trap can mis-target." >&2
    exit 1
  fi
  if [ "$pgid" = "$SELF_PGID" ]; then
    echo "ERROR: server shares this script's process group ($pgid) — job control did not isolate it. Aborting so cleanup never signals the caller's group." >&2
    exit 1
  fi
  DEV_PGIDS+=("$pgid")
}

if [ "$E2E_WORKERS" -eq 1 ]; then
  spawn_group "RK_PORT=$E2E_PORT RK_SERVER_ALLOWLIST=$E2E_TMUX_FAMILY E2E_TMUX_FAMILY=$E2E_TMUX_FAMILY RK_CODE_SERVER_PORT=$RK_CODE_SERVER_PORT XDG_STATE_HOME=$E2E_STATE_HOME XDG_DATA_HOME=$E2E_DATA_HOME RK_CONFIG_DIR=$RK_CONFIG_DIR E2E_HARNESS=1 exec just dev"
else
  # Multi-rig lane: `just dev` cannot run twice in one worktree — every air
  # instance builds to the same app/backend/tmp/rk — so the backend is built
  # ONCE into the run's state home and each rig runs that binary directly
  # (no live-reload; the suite never edits Go sources mid-run). Vite runs once
  # per rig on the rig's own port with its own dep-optimizer cache dir, since
  # two instances pre-bundling into one node_modules/.vite would race. The
  # env mirrors what dev.sh gives `just dev` (RK_HOST, LOG_LEVEL, the +1
  # backend port) so the rigs behave like the single-rig one.
  cp "$REPO_ROOT/configs/tmux/default.conf" "$REPO_ROOT/app/backend/build/tmux.conf"
  echo "multi-rig lane: building the backend once..."
  (cd "$REPO_ROOT/app/backend" && go build -o "$E2E_STATE_HOME/rk" ./cmd/rk)
  for (( i=0; i<E2E_WORKERS; i++ )); do
    _p="${RIG_PORT[$i]}"; _f="${RIG_FAMILY[$i]}"; _s="${RIG_STATE[$i]}"
    spawn_group "cd $REPO_ROOT/app/backend && RK_PORT=$(( _p + 1 )) RK_HOST=127.0.0.1 LOG_LEVEL=debug RK_SERVER_ALLOWLIST=$_f E2E_TMUX_FAMILY=$_f RK_CODE_SERVER_PORT=${RIG_CODE_PORT[$i]} XDG_STATE_HOME=$_s XDG_DATA_HOME=$_s/data RK_CONFIG_DIR=$_s/config exec $E2E_STATE_HOME/rk"
    spawn_group "cd $REPO_ROOT/app/frontend && RK_PORT=$_p RK_HOST=127.0.0.1 VITE_CACHE_DIR=$_s/vite exec pnpm dev --port $_p"
  done
fi

# Wait for BOTH servers of every rig to be ready. The frontend (Vite, the
# rig's port) comes up almost instantly, but the Go backend (port+1) lags it:
# in the single-rig lane air compiles it from scratch on a cold runner (a 15s+
# compile in CI), and in the multi-rig lane the prebuilt binary still has to
# bind and probe the socket dir. Waiting only on Vite (the old behavior) let
# Playwright start while every /api call still got ECONNREFUSED, so sessions
# never rendered and tests timed out. Gate on the backend's /api/health
# endpoint, which only answers once the process is serving.
wait_ready() {
  local port="$1" backend_port=$(( $1 + 1 )) i
  echo "waiting for frontend (:$port) and backend (:$backend_port/api/health)..."
  for i in $(seq 1 90); do
    if curl -sf "http://localhost:$port" >/dev/null 2>&1 \
      && curl -sf "http://localhost:$backend_port/api/health" >/dev/null 2>&1; then
      echo "both servers ready after ${i}s"
      return 0
    fi
    if [ "$i" -eq 90 ]; then
      echo "ERROR: servers not ready after 90s (frontend and/or backend on :$port never came up)" >&2
      exit 1
    fi
    sleep 1
  done
}
for _p in "${RIG_PORT[@]}"; do
  wait_ready "$_p"
done

# Rig table for the Playwright run (tests/e2e/_rig.ts): one JSON object per
# worker parallel index. Values are harness-made — numeric ports, socket names
# from the hyphen-free token, mktemp paths — so no JSON escaping is needed.
E2E_RIGS="["
for (( i=0; i<${#RIG_PORT[@]}; i++ )); do
  [ "$i" -gt 0 ] && E2E_RIGS+=","
  E2E_RIGS+="{\"port\":${RIG_PORT[$i]},\"codeServerPort\":${RIG_CODE_PORT[$i]},\"tmuxServer\":\"${RIG_SERVER[$i]}\",\"tmuxFamily\":\"${RIG_FAMILY[$i]}\",\"stateHome\":\"${RIG_STATE[$i]}\"}"
done
E2E_RIGS+="]"

# Run tests — pass server/family names so specs can target the right tmux
# server and name secondaries inside this worktree's family. Forward any extra
# args ("$@") to playwright so callers can scope the run (e.g. `just test-e2e
# mobile-layout`) against the same seeded test server. Playwright reads the
# base port from E2E_PORT — a variable only the harness sets (ambient direnv
# exports RK_PORT, so a spec-side RK_PORT read would defeat the :21999
# fail-closed sentinel on a bare `playwright test`); RK_PORT is still passed
# for any non-Playwright reader in the child env. XDG_STATE_HOME is forwarded
# so a spec can write into the SAME per-run state home the backend reads
# (e.g. a fake code-bridge host record under run-kit/cb/hosts/).
#
# E2E_RIGS + RK_E2E_WORKERS drive the multi-rig lane on the Playwright side:
# the config sizes its worker pool from RK_E2E_WORKERS and each worker
# re-points the harness vars above at its own rig row (tests/e2e/_rig.ts).
# E2E_TMUX_FAMILY stays the worktree-level anchor so global teardown sweeps
# every rig's sub-family; the other vars describe rig 0.
run_playwright() {
  cd "$PLAYWRIGHT_DIR" && RK_PORT=$E2E_PORT E2E_PORT=$E2E_PORT E2E_TMUX_SERVER="$E2E_TMUX_SERVER" E2E_TMUX_FAMILY="$E2E_TMUX_FAMILY" RK_CODE_SERVER_PORT="$RK_CODE_SERVER_PORT" XDG_STATE_HOME="${RIG_STATE[0]}" RK_CONFIG_DIR="$RK_CONFIG_DIR" E2E_RIGS="$E2E_RIGS" RK_E2E_WORKERS="$E2E_WORKERS" without_lock_fd pnpm exec playwright test "$@"
}

# Concurrency throttle (load, not correctness — the derived identity already
# isolates across worktrees, and the per-worktree lock above is the
# correctness lock within one; ordering and the no-deadlock argument live in
# that block's comment): a flock counting semaphore over RK_E2E_SLOTS slot files
# (/tmp/rk-e2e-slot-<uid>-{0..N-1}, default N=2, 1 = strict series) shared by
# every worktree on this box. The suite is timing-sensitive under parallel
# Playwright+Vite+Go CPU load, so cross-worktree runs queue for a slot before
# entering the Playwright phase. Server startup above is NOT throttled (cheap
# and port-isolated); `just pw` stays unthrottled (interactive lane). The uid
# suffix keeps slots per-user — opening another user's slot file (or inheriting
# their lock holder) must not abort this run under `set -e`.
if command -v flock >/dev/null 2>&1; then
  E2E_SLOTS="${RK_E2E_SLOTS:-2}"
  [[ "$E2E_SLOTS" =~ ^[0-9]+$ ]] || E2E_SLOTS=2
  [ "$E2E_SLOTS" -ge 1 ] || E2E_SLOTS=1
  # Slot-file opens are guarded and GROUPED — the `{ …; } 2>/dev/null` scopes the
  # redirect to the open (unscoped, it would silence the script's own stderr
  # for good), and the guard matters because an `exec {fd}>>` on an unopenable path
  # (unexpected /tmp perms, fd exhaustion) exits the script under set -e, so
  # every open sits in an `if` — an unopenable slot is skipped, and if even
  # slot 0 cannot be opened the throttle degrades to unthrottled rather than
  # failing the run over throttle plumbing.
  _e2e_lock_fd=""
  for (( i=0; i<E2E_SLOTS; i++ )); do
    if ! { exec {fd}>>"/tmp/rk-e2e-slot-$(id -u)-$i"; } 2>/dev/null; then continue; fi
    if flock -n "$fd"; then _e2e_lock_fd=$fd; break; fi
    exec {fd}>&-
  done
  if [ -z "$_e2e_lock_fd" ]; then
    if { exec {fd}>>"/tmp/rk-e2e-slot-$(id -u)-0"; } 2>/dev/null; then
      echo "e2e throttle: all $E2E_SLOTS slot(s) busy — blocking on slot 0 (tune via RK_E2E_SLOTS)"
      flock "$fd"
      _e2e_lock_fd=$fd
    else
      echo "e2e throttle: cannot open slot files — running unthrottled" >&2
    fi
  fi
  if run_playwright "$@"; then _pw_status=0; else _pw_status=$?; fi
  [ -n "$_e2e_lock_fd" ] && flock -u "$_e2e_lock_fd" 2>/dev/null || true
  exit "$_pw_status"
else
  # Stock macOS has no flock(1) — degrade to unthrottled (isolation holds).
  echo "e2e throttle: flock(1) not found — running unthrottled" >&2
  run_playwright "$@"
fi
