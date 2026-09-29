#!/usr/bin/env bash
# Compile and launch the Electron desktop shell (dev mode).
# Usage: ./scripts/dev-desktop.sh
#   RK_DESKTOP_URL=http://localhost:6123 just dev-desktop
#     — load a URL directly without persisting it (pleasant against `just dev`)
set -euo pipefail

cd "$(dirname "$0")/../app/desktop"

[ -d node_modules ] || pnpm install
pnpm run compile
exec pnpm exec electron .
