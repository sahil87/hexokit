#!/usr/bin/env bash
# Record a demo spec on this worktree's throwaway e2e rig and hand the
# recording off for a PR body. The spec's location selects the lane:
# app/frontend/tests/demo/<name>.demo.ts is the web lane (Chromium per-page
# video, desktop + mobile projects); app/desktop/tests/demo/<name>.demo.ts is
# the shell lane (the Electron shell on a private Xvfb display, grabbed with
# ffmpeg x11grab by the desktop demo fixture — per-page video never contains
# the composited native guests, popout windows, or native menus). A name
# present in BOTH records both lanes in one invocation — web first, then
# shell — with one combined Markdown block and one attach line.
#
# Usage: scripts/demo.sh <name> [--before [<ref>]] [--desktop-only|--mobile-only] [--mp4]
#
# Every pass runs through scripts/test-e2e.sh (RK_E2E_LANE=demo / shell-demo)
# — the rig (derived ports, the isolated rk-test-e2e-<token>-* tmux socket
# family, per-run temp state, the per-worktree lock, EXIT cleanup) is reused,
# never re-implemented, so a demo can never land on a live rk serve or the
# user's tmux server.
#
# The shell pass ALWAYS runs under its own private Xvfb
# (`xvfb-run -a -s "-screen 0 1280x800x24"`), even when DISPLAY is set:
# x11grab on a real display would record the developer's desktop (privacy,
# nondeterminism). Shell recording is Linux/Xvfb-only in v1 and fails fast,
# before any rig starts, when the OS is not Linux or xvfb-run / Xvfb /
# ffmpeg-with-x11grab is missing.
#
# --before [<ref>] records the same spec twice: once against a temporary
# detached worktree at <ref> (served via RK_E2E_APP_ROOT while the CURRENT
# tree's harness and demo spec run — the base ref has no demo lane of its
# own; a shell before pass additionally installs+compiles the base tree's
# app/desktop and launches THAT shell via DEMO_SHELL_APP_DIR — the old
# Electron build is part of "before"), then once against the working tree.
# Default <ref>: the merge-base of HEAD with the active change's base branch
# (fab status get-base-branch), falling back to origin/main, then main. The
# temp worktree is removed on EXIT, failure included. A failing before pass
# is reported, never fatal — only the after pass's status is this script's
# exit code. A web-only --before never pays for an Electron install.
#
# Shell-recording floor (advisory, never blocks): when this invocation
# records no shell lane but the diff against the resolved base touches
# desktop-shell paths (SHELL_PATHS below), a WARNING names the touched paths
# on stderr — Constitution § PR Evidence requires a shell recording for them.
# There is no reverse warning: the rule sets only a shell floor.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEMO_DIR="$REPO_ROOT/app/frontend/tests/demo"
SHELL_DEMO_DIR="$REPO_ROOT/app/desktop/tests/demo"
OUT_DIR="$REPO_ROOT/.demo"

# Desktop-shell paths whose diff REQUIRES a shell recording (Constitution §
# PR Evidence). Directory entries end in `/` and match as prefixes; entries
# containing `*` match as glob patterns; everything else matches exactly.
# `*.test.ts(x)` hits are excluded (a test-only diff has nothing to record).
# One named constant, matched in warn_shell_paths — never scattered literals.
SHELL_PATHS=(
  app/desktop/src/
  app/frontend/src/lib/shell.ts
  app/frontend/src/lib/shell-*.ts
  app/frontend/src/hooks/use-shell-servers.ts
  app/frontend/src/components/desktop-shell/
  app/frontend/src/components/web-frame-native.tsx
  app/frontend/src/lib/popout.ts
  app/frontend/src/hooks/use-popout.ts
  app/frontend/src/components/popout-states.tsx
)

usage() {
  cat >&2 <<'EOF'
usage: just demo <name> [--before [<ref>]] [--desktop-only | --mobile-only] [--mp4]

  <name>          a spec at app/frontend/tests/demo/<name>.demo.ts (web lane)
                  or app/desktop/tests/demo/<name>.demo.ts (shell lane — the
                  Electron shell on a private Xvfb display, Linux/Xvfb only);
                  a name in BOTH records both lanes in one invocation
  --before [ref]  also record against <ref> (default: merge-base with the
                  change's base branch, else origin/main, else main); a shell
                  before pass compiles the base tree's app/desktop and runs
                  the base tree's shell
  --desktop-only  record only the web lane's desktop project (1280x800);
                  narrows only the web lane — an error on a shell-only demo
  --mobile-only   record only the web lane's mobile project (375x812); ditto
  --mp4           additionally convert each WebM to MP4 via ffmpeg and print
                  the MP4 paths instead
EOF
}

name=""
before=""
before_ref=""
mp4=""
pw_project_args=()
proj_names=(desktop mobile)
while [[ $# -gt 0 ]]; do
  case "$1" in
    --before)
      before=1
      if [[ $# -ge 2 && "$2" != --* ]]; then before_ref="$2"; shift; fi
      ;;
    --desktop-only)
      [[ " ${proj_names[*]} " == *" mobile "* && ${#proj_names[@]} -eq 1 ]] && { echo "ERROR: --desktop-only and --mobile-only are mutually exclusive" >&2; exit 2; }
      pw_project_args=(--project desktop); proj_names=(desktop)
      ;;
    --mobile-only)
      [[ " ${proj_names[*]} " == *" desktop "* && ${#proj_names[@]} -eq 1 ]] && { echo "ERROR: --desktop-only and --mobile-only are mutually exclusive" >&2; exit 2; }
      pw_project_args=(--project mobile); proj_names=(mobile)
      ;;
    --mp4) mp4=1 ;;
    --help|-h) usage; exit 0 ;;
    --*) echo "ERROR: unknown flag: $1" >&2; usage; exit 2 ;;
    *)
      if [[ -z "$name" ]]; then name="$1"; else echo "ERROR: unexpected extra argument: $1" >&2; usage; exit 2; fi
      ;;
  esac
  shift
done

if [[ -z "$name" ]]; then
  echo "ERROR: a demo name is required" >&2
  usage
  exit 2
fi

# The name becomes a filename segment and lands unquoted in the printed attach
# line and the Markdown image references, so it must be a shell- and
# Markdown-safe basename: letters, digits, '.', '_', '-', never a leading dash
# (a dash-prefixed name would reach commands as an option, not an operand).
if [[ ! "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "ERROR: invalid demo name: $name (letters, digits, '.', '_', '-'; no leading '-')" >&2
  exit 2
fi

# A dash-prefixed ref would reach git as an option, not a revision.
if [[ -n "$before_ref" && "$before_ref" == -* ]]; then
  echo "ERROR: --before ref must not start with '-': $before_ref" >&2
  exit 2
fi

# Fail fast, before any rig starts, when the spec exists in NEITHER demo
# directory; the lane is the spec's location, never a flag.
lanes=()
[[ -f "$DEMO_DIR/$name.demo.ts" ]] && lanes+=(web)
[[ -f "$SHELL_DEMO_DIR/$name.demo.ts" ]] && lanes+=(shell)
has_lane() { [[ " ${lanes[*]} " == *" $1 "* ]]; }
if [[ ${#lanes[@]} -eq 0 ]]; then
  echo "ERROR: unknown demo '$name' — no $DEMO_DIR/$name.demo.ts or $SHELL_DEMO_DIR/$name.demo.ts" >&2
  echo "available demos:" >&2
  found=""
  for f in "$DEMO_DIR"/*.demo.ts; do
    [[ -e "$f" ]] || continue
    found=1
    echo "  $(basename "$f" .demo.ts) (web)" >&2
  done
  for f in "$SHELL_DEMO_DIR"/*.demo.ts; do
    [[ -e "$f" ]] || continue
    found=1
    echo "  $(basename "$f" .demo.ts) (shell)" >&2
  done
  [[ -n "$found" ]] || echo "  (none — add app/frontend/tests/demo/<name>.demo.ts or app/desktop/tests/demo/<name>.demo.ts)" >&2
  exit 1
fi

# The viewport flags narrow the web lane's project set only; a shell-only
# demo has nothing to narrow, so the flags are an error there.
if [[ ${#pw_project_args[@]} -gt 0 ]] && ! has_lane web; then
  echo "ERROR: --desktop-only/--mobile-only narrow only the web lane — '$name' is a shell-only demo (app/desktop/tests/demo/$name.demo.ts)" >&2
  exit 2
fi

# The shell lane's platform guard, before any rig starts: x11grab needs a
# private Xvfb display, which only the Linux stack provides in v1.
if has_lane shell; then
  missing=()
  [[ "$(uname -s)" == "Linux" ]] || missing+=("Linux (uname -s reports $(uname -s))")
  command -v xvfb-run >/dev/null 2>&1 || missing+=("xvfb-run")
  command -v Xvfb >/dev/null 2>&1 || missing+=("Xvfb")
  command -v ffmpeg >/dev/null 2>&1 || missing+=("ffmpeg")
  if command -v ffmpeg >/dev/null 2>&1 && ! ffmpeg -hide_banner -h indev=x11grab >/dev/null 2>&1; then
    missing+=("ffmpeg's x11grab input device")
  fi
  if [[ ${#missing[@]} -gt 0 ]]; then
    printf 'ERROR: shell recording is Linux/Xvfb-only in v1 — missing: %s\n' "${missing[*]}" >&2
    exit 1
  fi
fi

# The --before ref / warning base: an explicit argument wins; otherwise the
# merge-base of HEAD with the active change's base branch, falling back to
# origin/main, then main. Shared by the --before pass and the shell-path
# warning so both diff against the same base.
resolve_before_ref() {
  if [[ -n "$before_ref" ]]; then printf '%s\n' "$before_ref"; return 0; fi
  local candidates=() change base c mb
  change="$(sed -n 's/^id: *//p' "$REPO_ROOT/.fab-status.yaml" 2>/dev/null | head -1)"
  if [[ -n "$change" ]]; then
    base="$(fab status get-base-branch "$change" 2>/dev/null || true)"
    [[ -n "$base" ]] && candidates+=("$base")
  fi
  candidates+=(origin/main main)
  for c in "${candidates[@]}"; do
    if mb="$(git -C "$REPO_ROOT" merge-base HEAD "$c" 2>/dev/null)"; then
      printf '%s\n' "$mb"
      return 0
    fi
  done
  echo "ERROR: could not resolve a --before ref (tried merge-base with the base branch, origin/main, main)" >&2
  return 1
}

# Advisory shell-floor warning: a web-only invocation over a diff that touches
# SHELL_PATHS means a required shell recording is being skipped. The diff runs
# against the resolved merge-base WITHOUT a tree filter, so uncommitted edits
# count (demos are usually recorded before the commit); untracked files are
# listed separately because `git diff` never shows them. Unresolvable base →
# skip silently; the warning never changes the exit status.
warn_shell_paths() {
  local mb
  mb="$(resolve_before_ref 2>/dev/null)" || return 0
  local f p
  local touched=()
  while IFS= read -r f; do
    case "$f" in *.test.ts | *.test.tsx) continue ;; esac
    for p in "${SHELL_PATHS[@]}"; do
      # Three entry forms: trailing-/ directories match as prefixes, entries
      # containing * match as glob patterns (unquoted RHS — quoting would make
      # the * literal), everything else matches exactly.
      case "$p" in
        */) [[ "$f" == "$p"* ]] || continue ;;
        *"*"*) [[ "$f" == $p ]] || continue ;;
        *) [[ "$f" == "$p" ]] || continue ;;
      esac
      touched+=("$f")
      break
    done
  done < <(
    git -C "$REPO_ROOT" diff --name-only "$mb" 2>/dev/null
    git -C "$REPO_ROOT" ls-files --others --exclude-standard 2>/dev/null
  )
  [[ ${#touched[@]} -eq 0 ]] && return 0
  echo "WARNING: this diff touches desktop-shell paths but only a web demo is being recorded." >&2
  echo "         Constitution § PR Evidence requires a shell recording too — add" >&2
  echo "         app/desktop/tests/demo/<name>.demo.ts (or a same-named one to record both)." >&2
  echo "         Shell paths touched:" >&2
  printf '           %s\n' "${touched[@]}" >&2
}

# One web demo pass on the throwaway rig. $1: variant ("" | before | after),
# $2: app root ("" = this tree; a temp worktree path for the before pass).
run_pass() {
  local variant="$1" app_root="${2:-}"
  local -a env_args=(
    "DEMO_OUT_DIR=$OUT_DIR"
    "DEMO_NAME=$name"
    "RK_E2E_LANE=demo"
  )
  [[ -n "$variant" ]] && env_args+=("DEMO_VARIANT=$variant")
  [[ -n "$app_root" ]] && env_args+=("RK_E2E_APP_ROOT=$app_root")
  env "${env_args[@]}" "$SCRIPT_DIR/test-e2e.sh" "$name.demo.ts" ${pw_project_args[@]+"${pw_project_args[@]}"}
}

# One shell demo pass: the current tree's spec drives the Electron shell
# under a private Xvfb (ALWAYS — even with a real DISPLAY set, so the grab
# can never capture a developer's desktop). $2 is the --before temp worktree:
# RK_E2E_APP_ROOT serves its SPA/backend and DEMO_SHELL_APP_DIR makes the
# fixture launch ITS compiled shell with ITS Electron binary.
run_shell_pass() {
  local variant="$1" app_root="${2:-}"
  local -a env_args=(
    "DEMO_OUT_DIR=$OUT_DIR"
    "DEMO_NAME=$name"
    "RK_E2E_LANE=shell-demo"
  )
  [[ -n "$variant" ]] && env_args+=("DEMO_VARIANT=$variant")
  if [[ -n "$app_root" ]]; then
    env_args+=("RK_E2E_APP_ROOT=$app_root" "DEMO_SHELL_APP_DIR=$app_root/app/desktop")
  fi
  xvfb-run -a -s "-screen 0 1280x800x24" env "${env_args[@]}" "$SCRIPT_DIR/test-e2e.sh" "$name.demo.ts"
}

before_wt=""
cleanup() {
  if [[ -n "$before_wt" ]]; then
    git -C "$REPO_ROOT" worktree remove --force "$before_wt" 2>/dev/null \
      || git -C "$REPO_ROOT" worktree prune 2>/dev/null \
      || true
  fi
}
trap cleanup EXIT

mkdir -p "$OUT_DIR"

# Clear this name's prior outputs BEFORE recording: a failed pass must never
# surface a stale video from an earlier run as this run's. The sweep is
# scoped to EXACTLY the lanes × variants × projects this invocation records,
# as explicit paths — never a `<name>-*` glob, which would let a web-only run
# delete a sibling shell recording (or vice versa) for a same-named demo, or
# pick up a same-prefix demo's files.
lanes_projects=()
has_lane web && lanes_projects+=("${proj_names[@]}")
has_lane shell && lanes_projects+=(shell)
sweep_variants=("")
[[ -n "$before" ]] && sweep_variants=(before after)
for v in "${sweep_variants[@]}"; do
  for p in "${lanes_projects[@]}"; do
    rm -f "$OUT_DIR/$name${v:+-$v}-$p.webm" "$OUT_DIR/$name${v:+-$v}-$p.mp4"
  done
done

has_lane shell || warn_shell_paths

before_failed=""
if [[ -n "$before" ]]; then
  ref="$(resolve_before_ref)"
  echo "before: recording '$name' against $ref"
  before_wt="$(mktemp -d /tmp/rk-demo-before-XXXXXX)"
  git -C "$REPO_ROOT" worktree add --detach "$before_wt" -- "$ref"
  # The temp tree serves its own Vite dev server, so it needs its own
  # node_modules; the shared pnpm store keeps this cheap. A base too old for
  # the current pnpm (e.g. ignored-builds policy) is a before failure like any
  # other: report it, skip the before pass, still record the after pass.
  if ( cd "$before_wt/app/frontend" && pnpm install --frozen-lockfile --prefer-offline ); then
    if has_lane web; then
      if run_pass before "$before_wt"; then
        echo "before: web pass complete"
      else
        before_failed=1
        echo "before: demo failed against $ref — continuing with the after pass" >&2
      fi
    fi
    if has_lane shell; then
      # The old Electron build is part of "before". A base without
      # app/desktop, or one that cannot install/compile, is a before failure
      # like any other: reported, the shell before pass skipped, the after
      # pass still recorded.
      if "$SCRIPT_DIR/compile-desktop.sh" "$before_wt/app/desktop" frozen; then
        if run_shell_pass before "$before_wt"; then
          echo "before: shell pass complete"
        else
          before_failed=1
          echo "before: shell demo failed against $ref — continuing with the after pass" >&2
        fi
      else
        before_failed=1
        echo "before: desktop install/compile failed in the temp worktree at $ref — skipping the shell before pass, continuing with the after pass" >&2
      fi
    fi
  else
    before_failed=1
    echo "before: dependency install failed in the temp worktree at $ref — skipping the before pass, continuing with the after pass" >&2
  fi
fi

after_variant=""
[[ -n "$before" ]] && after_variant=after
after_status=0
if has_lane web; then
  run_pass "$after_variant" "" || after_status=$?
fi
if has_lane shell; then
  # The current tree's compile failing fails the run (unlike the before
  # tree's), but the summary below still prints so a web lane recorded in the
  # same invocation keeps its hand-off.
  if "$SCRIPT_DIR/compile-desktop.sh" "$REPO_ROOT/app/desktop"; then
    run_shell_pass "$after_variant" "" || after_status=$?
  else
    after_status=$?
    echo "ERROR: desktop compile failed — no shell recording" >&2
  fi
fi

# This run's recordings: the variant × project matrix (per lane), filtered to
# files that actually exist (a failed before pass leaves a gap). Built by
# walking the expected paths — never a .demo/ glob, which could pick up a
# same-prefix demo's files. --mp4 converts exactly these files; a failed
# conversion keeps the WebM rather than aborting the hand-off. The Markdown
# rows come from the same walk, so the list, the block, and the attach line
# can never disagree.
variants=("")
[[ -n "$before" ]] && variants=(before after)
recorded=()
md_rows=()
for v in "${variants[@]}"; do
  group=()
  for p in "${lanes_projects[@]}"; do
    f="$OUT_DIR/$name${v:+-$v}-$p.webm"
    [[ -f "$f" ]] || continue
    if [[ -n "$mp4" ]]; then
      mp4_out="${f%.webm}.mp4"
      if ffmpeg -y -i "$f" -c:v libx264 -pix_fmt yuv420p -an -movflags +faststart "$mp4_out" >/dev/null 2>&1; then
        f="$mp4_out"
      else
        echo "WARNING: ffmpeg conversion failed for $(basename "$f") — keeping the WebM" >&2
      fi
    fi
    recorded+=("$f")
    label="Desktop"
    [[ "$p" == mobile ]] && label="Mobile"
    [[ "$p" == shell ]] && label="Desktop shell"
    base="$(basename "$f")"
    group+=("**$label**" "" "![](.demo/$base)" "")
  done
  if [[ ${#group[@]} -gt 0 && -n "$before" ]]; then
    if [[ "$v" == before ]]; then md_rows+=("### Before" ""); else md_rows+=("### After" ""); fi
  fi
  [[ ${#group[@]} -gt 0 ]] && md_rows+=("${group[@]}")
done

echo
echo "Recorded:"
if [[ ${#recorded[@]} -eq 0 ]]; then
  echo "  (no recordings produced)"
else
  for f in "${recorded[@]}"; do
    printf '  %s (%s)\n' ".demo/$(basename "$f")" "$(du -h "$f" | cut -f1)"
  done
fi
[[ -n "$before_failed" ]] && echo "  NOTE: the before pass failed against $ref — the before recording may be missing or partial; state why in the PR body."

echo
echo "Markdown for the PR body:"
echo
[[ ${#md_rows[@]} -gt 0 ]] && printf '%s\n' "${md_rows[@]}"

echo "Attach:"
attach="gh pr edit"
for f in ${recorded[@]+"${recorded[@]}"}; do
  attach="$attach --attach .demo/$(basename "$f")"
done
[[ ${#recorded[@]} -gt 0 ]] && echo "  $attach" || echo "  (nothing to attach)"

exit "$after_status"
