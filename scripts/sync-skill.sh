#!/usr/bin/env bash
# Copy the canonical skill bundle + topic pages into the cmd/rk package so they
# can be embedded via //go:embed. The Go module root is app/backend/ and
# docs/site/ sits above it, so embed cannot reach the canonical files directly —
# this copy step bridges the gap (Constitution VIII: thin justfile, logic in
# scripts/). The committed copies are what a clean `go build ./...` (which does
# not run this script) compiles; the drift-guard tests (TestSkillEmbedMatchesCanonical,
# TestSkillDisplayEmbedMatchesCanonical) keep them byte-honest against the
# canonical docs/site/ sources on every `go test`.
set -euo pipefail

# Run from the repo root regardless of caller CWD.
cd "$(dirname "$0")/.."

DEST_DIR="app/backend/cmd/rk/skill"
mkdir -p "$DEST_DIR"

# core bundle + each topic page under docs/site/skill/. Add a row per topic page.
sync() {
	local src="$1" dest="$2"
	cp -f "$src" "$dest"
	echo "synced skill bundle: $src -> $dest"
}

sync "docs/site/skill.md" "$DEST_DIR/skill.md"
sync "docs/site/skill/change.md" "$DEST_DIR/change.md"
sync "docs/site/skill/code.md" "$DEST_DIR/code.md"
sync "docs/site/skill/cron.md" "$DEST_DIR/cron.md"
sync "docs/site/skill/display.md" "$DEST_DIR/display.md"
sync "docs/site/skill/gui.md" "$DEST_DIR/gui.md"
sync "docs/site/skill/messaging.md" "$DEST_DIR/messaging.md"
sync "docs/site/skill/mux.md" "$DEST_DIR/mux.md"
sync "docs/site/skill/tutorial.md" "$DEST_DIR/tutorial.md"
