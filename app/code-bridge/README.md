# rk-code-bridge

VS Code extension that lets the HexoKit CLI (`rk code exec`) run palette commands inside the
editor's extension host from a same-user shell.

On activation it opens a Unix socket at
`$XDG_STATE_HOME/hexokit/cb/<hostId>.sock` (default `~/.local/state/hexokit/cb/`), writes a host
record to `cb/hosts/<hostId>.json`, and serves newline-delimited JSON requests: one request per
connection, one response, then the connection closes.

Security boundary: Unix socket only (never TCP), `cb/` is `0700`, sockets are `0600`, and the
extension refuses to start when an existing `cb/` has looser permissions. Disable with the
`rk.bridge.enabled` setting.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `rk.bridge.enabled` | `true` | Off switch for the bridge. |
| `rk.tab` | `""` | The HexoKit tab (`@N`) this window belongs to — written by rk into the derived workspace file, not user-set. |
| `rk.server` | `""` | The tmux server of that tab — same provenance. |
| `rk.bridge.rkPath` | `""` | Absolute path of the `rk` binary; empty resolves `$RK_BIN`, then `rk` on PATH. |

## Actions

When the window carries a tab identity, every contributed command is gated on the `rk.hasTab`
context key — a tab-less host shows nothing. All actions shell out to existing `rk` verbs via
`execFile` argv arrays with timeouts:

- **Open in Web Tile** — explorer + editor-title context menus (files) and the palette:
  `rk tab web add @N <file> --show -L <server>`.
- **Open Folder in Web Tile** — explorer context menu on folders: the same verb on a directory.
- **Open in Web Tile and Notify** — the add, then `rk notify "presenting <basename>" --title HexoKit`.
- **Send to Agent** — editor context menu on a selection: stages `path:N[-M]` plus the selected text
  via `rk mux send @N - --no-enter -L <server>`; a gate refusal offers **Force** (`--force`).
- **Copy Reference for Agent** — editor context menu on a selection: copies the `path:N[-M]`
  reference to the clipboard.
- **Open Port in Web Tile** — palette only: prompts for a local port (1–65535), then
  `rk tab web add @N :<port> --show -L <server>`.

## Development

```sh
pnpm install
pnpm run build       # esbuild bundle → dist/extension.js
pnpm test            # tsc + node --test over a real Unix socket (no VS Code host)
pnpm run typecheck
pnpm run package     # vsce package --no-dependencies [-- <version>]
```
