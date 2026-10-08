#!/usr/bin/env bash
# Record a demo spec (app/frontend/tests/demo/<name>.demo.ts) on this
# worktree's throwaway e2e rig and hand the recording off for a PR body.
#
# Usage: scripts/demo.sh <name> [--before [<ref>]] [--desktop-only|--mobile-only] [--mp4]
#
# Every pass runs through scripts/test-e2e.sh with RK_E2E_LANE=demo — the rig
# (derived ports, the isolated rk-test-e2e-<token>-* tmux socket family,
# per-run temp state, the per-worktree lock, EXIT cleanup) is reused, never
# re-implemented, so a demo can never land on a live rk serve or the user's
# tmux server.
#
# --before [<ref>] records the same spec twice: once against a temporary
# detached worktree at <ref> (served via RK_E2E_APP_ROOT while the CURRENT
# tree's harness and demo spec run — the base ref has no demo lane of its
# own), then once against the working tree. Default <ref>: the merge-base of
# HEAD with the active change's base branch (fab status get-base-branch),
# falling back to origin/main, then main. The temp worktree is removed on
# EXIT, failure included. A failing before pass is reported, never fatal —
# only the after pass's status is this script's exit code.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEMO_DIR="$REPO_ROOT/app/frontend/tests/demo"
OUT_DIR="$REPO_ROOT/.demo"

usage() {
  cat >&2 <<'EOF'
usage: just demo <name> [--before [<ref>]] [--desktop-only | --mobile-only] [--mp4]

  <name>          a spec at app/frontend/tests/demo/<name>.demo.ts
  --before [ref]  also record against <ref> (default: merge-base with the
                  change's base branch, else origin/main, else main)
  --desktop-only  record only the desktop project (1280x800)
  --mobile-only   record only the mobile project (375x812)
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

# Fail fast, before any rig starts, when the spec does not exist.
if [[ ! -f "$DEMO_DIR/$name.demo.ts" ]]; then
  echo "ERROR: unknown demo '$name' — no $DEMO_DIR/$name.demo.ts" >&2
  echo "available demos:" >&2
  found=""
  for f in "$DEMO_DIR"/*.demo.ts; do
    [[ -e "$f" ]] || continue
    found=1
    echo "  $(basename "$f" .demo.ts)" >&2
  done
  [[ -n "$found" ]] || echo "  (none — add app/frontend/tests/demo/<name>.demo.ts)" >&2
  exit 1
fi

# The --before ref: an explicit argument wins; otherwise the merge-base of HEAD
# with the active change's base branch, falling back to origin/main, then main.
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

# One demo pass on the throwaway rig. $1: variant ("" | before | after),
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
# surface a stale video from an earlier run as this run's. The hyphen anchor
# keeps a same-prefix demo's files (a `name2` demo) out of the sweep; `rm -f`
# on the unmatched glob literals is a no-op.
rm -f "$OUT_DIR/$name"-*.webm "$OUT_DIR/$name"-*.mp4

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
    if run_pass before "$before_wt"; then
      echo "before: pass complete"
    else
      before_failed=1
      echo "before: demo failed against $ref — continuing with the after pass" >&2
    fi
  else
    before_failed=1
    echo "before: dependency install failed in the temp worktree at $ref — skipping the before pass, continuing with the after pass" >&2
  fi
fi

after_status=0
if [[ -n "$before" ]]; then
  run_pass after "" || after_status=$?
else
  run_pass "" "" || after_status=$?
fi

# This run's recordings: the variant × project matrix, filtered to files that
# actually exist (a failed before pass leaves a gap). Built by walking the
# expected paths — never a .demo/ glob, which could pick up a same-prefix
# demo's files. --mp4 converts exactly these files; a failed conversion keeps
# the WebM rather than aborting the hand-off. The Markdown rows come from the
# same walk, so the list, the block, and the attach line can never disagree.
variants=("")
[[ -n "$before" ]] && variants=(before after)
recorded=()
md_rows=()
for v in "${variants[@]}"; do
  group=()
  for p in "${proj_names[@]}"; do
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
