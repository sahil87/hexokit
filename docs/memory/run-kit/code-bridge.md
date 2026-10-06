---
type: memory
description: "The rk-code-bridge code-server extension + the `rk code` CLI family — a same-user Unix-socket channel into the extension host. Covers the <state>/hexokit/cb/ socket + host registry (Go reads the apphome-resolved cb dir; the extension always resolves hexokit/cb), tab-keyed identity via the derived .code-workspace file, six editor actions, NDJSON protocol, exec/hosts/commands, tab-direct resolution + liveness, boot signals, pid-guarded cleanup, VSIX distribution, doctor row, security stance."
---
# Code Bridge

**Domain**: run-kit

## Overview

The code bridge is the channel *into* the editor behind the dashboard's `code` lens: the `rk-code-bridge` code-server extension serves `vscode.commands.executeCommand` over a same-user Unix socket, and the `rk code` CLI family is the shell side. It exists because code-server exposes no command channel — its CLI only opens files, the URL `payload=` parameter only supports `openFile`, and the GitHub Pull Requests extension's URI handler is auth-only — so the only place palette commands are callable is inside the extension host. The bridge is peer-to-peer between a shell and an extension host: the daemon, the `/code/` route, and the per-viewer folder latch are not involved. The authoritative design record is [docs/specs/code-bridge.md](../../specs/code-bridge.md). (83jz)

## Shape

```
agent shell / tmux pane          unix socket (0600)                      code-server extension host
rk code exec pr.refreshList ──▶ $XDG_STATE_HOME/hexokit/cb/<hostId>.sock ──▶ rk-code-bridge extension
        │                                                                     net.createServer → executeCommand
        │  looks up host by tab (+server) or folder                           one per open workbench window
        └──────────────▶ $XDG_STATE_HOME/hexokit/cb/hosts/<hostId>.json ◀─── registers on activate
                         {hostId, folder, pid, sock, extVersion, startedAt[, tab, server]}
```

Two pieces, one contract:

1. **`rk-code-bridge`** — a VS Code extension at `app/code-bridge/` (TypeScript, pnpm; esbuild bundle → `dist/extension.js`; `vsce package --no-dependencies` → `rk-code-bridge-<version>.vsix`). The runtime dependency set is empty — only the `vscode` API and Node builtins (`net`/`fs`/`crypto`/`os`/`path`/`child_process`). `activationEvents: ["*"]` (deliberately eager — being reachable before any user action is the point), `engines.vscode: ^1.90.0`, in-tree version `0.0.0-dev` (the release workflow passes the tag version to the package step).
2. **`rk code`** — a cobra command group in `app/backend/cmd/rk/code.go` over the Go client library `internal/codebridge`. The VSIX is embedded in the binary and installed by `rk code-server install` / `update` (§ Distribution).

## Socket and registry contract

- **State dir**: `$XDG_STATE_HOME/hexokit/cb/` (default `~/.local/state/hexokit/cb/`) — runtime state, not config. The two sides resolve it independently: the extension's `src/state-dir.ts` (`stateDir()`, vscode-free and node-tested) returns `<state base>/hexokit/cb` unconditionally, and the Go side resolves `codebridge.StateDir()` through `internal/apphome`'s dual-read home rule (the hexokit state home when it exists, else the legacy `run-kit` one on the skip-release path, else hexokit), mirroring `snapshot.DefaultDir()`'s XDG base exactly — the two resolutions may never drift apart, and agree in every migrated install. `cb/` cold-starts across the home migration — the migration does not copy it, and a live host re-registers on its next activation. Go discovery reads the one resolved dir only (`ReadRecords` / `ReadBootMarkers` / `LiveHosts` over `codebridge.HostsDir()` / `BootsDir()`). An installed VSIX is updated on `rk code-server install`/`update` and at the daemon-start `~/.rk` tenant move (§ Distribution), which reinstalls the bundled VSIX against the managed binary at its new state-home path — best-effort, skipped when no managed binary or bundled VSIX exists, a failure logged and retried at the next install/update — so registrations move off the legacy leaf. An old-VSIX host still registering under `<state>/run-kit/cb` stays reachable in the unmigrated window (the resolved dir IS the legacy one there, and a socket is dialed at its host record's own absolute path); in a migrated install discovery never reads the legacy record, and the daemon-start legacy-home deletion keeps the legacy state home's `cb/` — and nothing else — only while a live host is registered there ([configuration](/run-kit/configuration.md) § Legacy-Home Deletion).
- **Permissions**: `cb/` is created `0700`; the extension refuses to start (logs to its output channel, never throws) when an existing `cb/` has group/other access. The socket is `chmod 0600` after listen.
- **`hostId`**: the first 12 hex chars of `sha1(<identityPath> + "\n" + vscode.env.machineId)` — deterministic, so a reloaded window reuses its socket path and record instead of leaking one per reload. `identityPath` is the workspace file's `fsPath` (`vscode.workspace.workspaceFile`) when the window carries a validated tab identity (§ Tab identity and the run-kit editor actions), else the first workspace folder's `fsPath` — two tabs opened on the same folder register distinct hosts, and a tab-less window (a user-opened code-server window, or a `?folder=` degrade frame) keeps folder-keyed identity.
- **Socket**: `cb/<hostId>.sock`; a stale socket file is unlinked on activate (liveness is re-derived by the client per call, so a leftover socket is always stale).
- **Record**: `cb/hosts/<hostId>.json` = `{hostId, folder, pid, sock, extVersion, startedAt}` (RFC 3339) plus optional `tab` (`"@7"`) and `server` (`"default"`), present exactly when the host carries a tab identity. Written atomically (temp + rename) so a concurrent reader never sees a partial record. The six long-standing field names are the extension's JSON contract and must not change; `tab`/`server` are `omitempty` additions.
- **Boot marker**: `cb/boots/<hostId>.json` = `{hostId, workspaceFile, tab, server, pid, extVersion, startedAt}` (RFC 3339) — the positive empty-boot signal the code tile's first-boot rescue consumes. Written on a zero-folder activation when `vscode.workspace.workspaceFile` is a `file:` URI whose on-disk top-level `settings` yield a validated tab identity (`identityFromWorkspaceFile` feeding the shared `readTabIdentity` — on the broken boot VS Code boots from its empty cached configuration, so the live configuration carries no identity and the daemon-written workspace file is the only place it exists); any defect (no workspace file, a non-`file:` scheme, an unreadable/unparseable file, missing or invalid settings) writes nothing. The `boots/` dir is `0700` (`ensurePrivateDir` + `mkdirSync`), the file `0600` via `writeAtomic`; the marker's `hostId` is the same `computeHostId(workspaceFile.fsPath)` the good-boot record uses, so marker and record for one tab share a key. The marker is removed pid-guarded on deactivate and when a folder arrives LATE — the `onDidChangeWorkspaceFolders` subscription then runs the normal bridge startup for that folder exactly once (the startup body is factored out of `activate()` into `startBridgeForFolder`; one bridge per window). Stale markers a dead host left behind are neutralized by the pid-alive filter on the read path (§ Host resolution and liveness).
- **Deactivate**: closes the server unconditionally and removes the record, its socket, and the boot marker only when the on-disk file parses to an object whose numeric `pid` equals `process.pid` (the pure `ownsFile` predicate) — a file a NEWER host rewrote carries its pid and survives this host's exit; a missing, unreadable, or unparseable file is never guessed and left alone. The socket follows the record's ownership.
- **Activation gates**: `rk.bridge.enabled` `false` (a `contributes.configuration` boolean, default `true`) → activation returns with no side effects; a window with no workspace folder writes ONLY the empty-boot marker, and only when its `file:` workspace file yields a validated tab identity.

## Protocol

Newline-delimited JSON over the socket, **one request per connection** — the bridge stays stateless and the socket ends after one response.

```jsonc
→ {"id":"k3f9","command":"pr.checkoutByNumber","args":[2908],"timeoutMs":30000}
← {"id":"k3f9","ok":true,"result":null,"ms":812}

→ {"id":"q1","command":"nope.doesNotExist","args":[]}
← {"id":"q1","ok":false,"error":{"kind":"unknown-command","message":"command 'nope.doesNotExist' not found"}}
```

- **Error kinds**: `unknown-command` (not in `getCommands(true)`) · `threw` (executor rejection; message = error message) · `timeout` (exceeding `timeoutMs`, default 30000) · `bad-request` (non-JSON or shape-invalid line; the `id` is echoed when parseable, else `null`).
- **Internals**: `__ping` → `{folder, pid, version}` plus optional `tab`/`server` when the host carries a tab identity (additive protocol); `__commands` → the full `vscode.commands.getCommands(true)` array.
- **`$uri` sugar**: an object exactly of shape `{"$uri":"<string>"}` at any nesting depth in `args` is rewritten to `vscode.Uri.parse(...)` — `vscode.open` / `vscode.diff` want Uris. No other coercion; plain path-like strings are NOT auto-converted.
- **Serialisation**: results cross as `JSON.stringify`; a value that fails (cycle/BigInt) degrades to `{"$nonSerializable":true,"type":"<typeof or constructor name>"}` — serialisation never throws.
- The protocol/server core (`src/bridge.ts` + `src/protocol.ts`) is **`vscode`-free** — it takes injected deps `{executeCommand, getCommands, parseUri, info}` so it is unit-tested with `node --test` over a real Unix socket; the tab-identity, rk-runner, and action-builder modules (`src/tab.ts`, `src/rk.ts`, `src/actions.ts`) are likewise pure and `node --test`-tested; `src/extension.ts` is the vscode glue.

## Tab identity and the run-kit editor actions

A code-server window learns which run-kit tab embeds it from a **derived `.code-workspace` file** — the one channel that carries arbitrary per-window key/value data into the extension host (its `settings` block, read through the ordinary configuration API). rk derives one file per (server, tab, code root) via `internal/codeworkspace`; the frontend mount flow lives in [ui/lenses-and-layout](/run-kit/ui/lenses-and-layout.md) § Code Surface, and the GET that writes the file in [api-and-sockets](/run-kit/api-and-sockets.md) § API Layer:

- **Path**: `$XDG_STATE_HOME/hexokit/code/<server>/<windowID>-<hash6>.code-workspace` (`codeworkspace.Path`) — `hash6` is the first 6 lowercase hex chars of `sha256(<absolute root>)` (the `present.RootHash` rule, truncated); the hash separates a root change on a recycled `@N`, and `server`/`windowID` are validated before path composition.
- **Content**: exactly `{"folders":[{"path":<root>}],"settings":{"rk.tab":"<@N>","rk.server":"<server>"}}` (indented, trailing newline, no other keys); `folders` is single-element by design.
- **Derived, not stored** (Constitution II's carve-out shape): the GET handler is the only writer (`rk tab code set` never writes one), byte-compares and rewrites only on difference (temp + rename, file `0600`, server dir `0700`); deleting the file changes nothing but a regeneration; there is no GC.

**Settings** (`contributes.configuration`, beside `rk.bridge.enabled`): `rk.tab` and `rk.server` (strings, default `""` — written into the derived workspace file by rk, not user-set) and `rk.bridge.rkPath` (string, default `""` — absolute path of the rk binary; empty resolves `$RK_BIN`, then `rk` on PATH).

**Identity gate**: `readTabIdentity` (`src/tab.ts`, pure) accepts `rk.tab` only when it matches `^@\d+$` and `rk.server` only when it matches the tmux server-name charset `^[A-Za-z0-9_.-]+$`; either failing ⇒ no identity. On activate the extension sets the `rk.hasTab` context key (`setContext`), re-evaluated on `onDidChangeConfiguration` for the `rk` section. Every run-kit menu and palette entry carries a `rk.hasTab`-gated `when` clause, so a host without a tab shows nothing and never errors.

**The `rk` resolution ladder** (`src/rk.ts`): `rk.bridge.rkPath` (non-empty, absolute) → `process.env.RK_BIN` (set by the daemon's code-server spawn to the rk-owned launcher symlink `~/.local/share/rk/bin/run-kit`, whose target is the resolved Cellar binary — live through the `brew upgrade` window in which the brew-prefix stable symlink dangles, since Homebrew deletes the old keg only in post-link cleanup; the brew daemon re-points it at every `rk serve` start — see [daemon-lifecycle](/run-kit/daemon-lifecycle.md)) → the bare name `rk` (PATH search by `execFile`). `runRk(argv, {timeoutMs, stdin?})` runs `child_process.execFile(rkPath, argv, {timeout, maxBuffer})` with argv arrays only — never a shell string — piping `stdin` when given and resolving `{code, stdout, stderr, error?}` (a non-zero exit is a result, not a throw); a spawn `ENOENT` resolves as a distinguishable result and surfaces exactly `HexoKit: rk not found — set rk.bridge.rkPath`.

**The six actions** (all `"category": "HexoKit"` — the palette renders `HexoKit: <Title>`; context-menu titles are unprefixed VS Code-style verbs; the user-facing noun is "Web Tile"):

| Command | Title | Menus (`when`) | Effect |
|---|---|---|---|
| `rk.openInWebTile` | Open in Web Tile | `explorer/context` (`rk.hasTab && !explorerResourceIsFolder`), `editor/title/context` (`rk.hasTab`) | `rk tab web add <@N> <file fsPath> --show -L <server>` |
| `rk.openFolderInWebTile` | Open Folder in Web Tile | `explorer/context` (`rk.hasTab && explorerResourceIsFolder`) | `rk tab web add <@N> <dir fsPath> --show -L <server>` (index.html default) |
| `rk.openInWebTileAndNotify` | Open in Web Tile and Notify | same as `rk.openInWebTile` | the add, then on exit 0 `rk notify "presenting <basename>" --title HexoKit` (two invocations — `rk tab web add` has no `--notify`) |
| `rk.sendToAgent` | Send to Agent | `editor/context` (`rk.hasTab && editorHasSelection`) | `rk mux send <@N> - --no-enter -L <server>` with the payload on stdin — staged, never submitted |
| `rk.copyReferenceForAgent` | Copy Reference for Agent | `editor/context` (`rk.hasTab && editorHasSelection`) | `vscode.env.clipboard.writeText(<reference>)` + a 3 s status-bar `Copied <ref>` |
| `rk.openPortInWebTile` | Open Port in Web Tile | `commandPalette` only (`rk.hasTab`) | `showInputBox` (prompt "Local port", validated `1–65535`) → `rk tab web add <@N> :<port> --show -L <server>` |

Details: resource resolution takes the context-menu `vscode.Uri` (a multi-select invocation acts on the first resource), palette invocations fall back to the active editor's document, and non-`file:` schemes warn `Only local files can be shown in the Web Tile`; paths pass as absolute `fsPath`. The **reference** is `vscode.workspace.asRelativePath(uri, false)` (workspace-relative, forward slashes) with 1-based lines — `path:N` for a single line, `path:N-M` for a range, an end at column 0 of a later line trimmed to the previous line; the send payload is the reference line, a newline, then the selected text verbatim (no fences). A palette Send/Copy with an empty selection uses the cursor line and no text. **Send to Agent** stages the payload (`--no-enter` — the user adds the instruction and presses Enter in the tty): exit 0 ⇒ a 3 s status-bar `Staged in tab <@N>`; exit 1 with a gate refusal ⇒ `showWarningMessage(<stderr first line>, "Force")`, Force re-running the same argv plus `--force`; any other failure ⇒ `showErrorMessage` with stderr's first line. Timeouts: 15 s for web-add and notify, 20 s for send. Web-tile successes are silent — the tile appearing is the feedback.

## The `rk code` family

```
rk code exec <command> [json-arg…]  [--folder <path>] [--host <id>] [--tab [@N]] [--all] [--timeout 30s] [--json]
rk code hosts [--json]
rk code commands [--folder <path>] [--host <id>] [--tab [@N]]
```

- **`exec`** runs any palette command id on the resolved host. Each positional after the command is parsed as a JSON literal (numbers stay numbers, objects pass verbatim — including the `$uri` marker the extension rewrites); anything not valid JSON is sent as a string, so bare words work. A literal `--` ends flag parsing, so negative numbers and `-`-prefixed strings pass as args. `--host`, `--tab`, and `--folder` are pairwise mutually exclusive. The request carries a fresh random `id` and `timeoutMs` = `--timeout` (default 30s); the Go dial+read deadline adds 2s so the extension's own `timeout` error wins while a hung host stays bounded.
- **Output contract** (toolkit Principle 9): the result JSON is stdout data (`null` prints `null`); `--json` emits the standard rk JSON envelope — `{"ok":true,"result":<doc>}` on success, `{"ok":false,"error":{"code":"usage"|"operational","message":…}}` on failure (the shared convention — `outputSink.Envelope`, the central failure writer, the pre-RunE boundary — lives in [architecture/cli](/run-kit/architecture/cli.md)) (260911-ehm2-cli-json-read-verbs). Single-host `exec --json` nests the bridge `Response` verbatim under `result`, so the document reads `{"ok":true,"result":{"ok":true,"result":…}}` — the outer `ok` is rk's, the inner the bridge's; a bridge failure (`!resp.OK`) returns before any stdout write and surfaces as an `ok:false` error envelope via the central writer in `execute()`. Every verb routes through `newSink(cmd)` — results are `Dataf` (survive `--quiet`); the `using host …` fallback note, prune notices, and the version-skew warning are `Notef` (stderr); error lines are ungated `error: <kind>: <message>` on stderr (a dial/read failure prints `error: <message>` with no kind).
- **Exit codes** (Principle 4): `0` ok; `1` operational (no host, dial failure, `timeout`/`threw`/`unknown-command`/`bad-request`, `--tab` outside tmux without an explicit `@N`); `2` usage (missing command, `--tab`/`--host`/`--folder` flag conflicts, unknown flag, stray arg) — the children re-wrap their `Args` validators with `usageArgs` in `init()`. On `unknown-command` the five closest command ids (prefix, then substring, then edit distance over a best-effort `__commands` fetch) print as a `did you mean:` list on stderr.
- **`hosts`** prints live hosts as aligned `ID  FOLDER  TAB  SERVER  PID  AGE  EXT` rows (`TAB`/`SERVER` render `-` on tab-less hosts; age humanised from `startedAt`; a malformed timestamp renders `unknown`), pruning dead records as a side effect. `--json` emits the record array under `result` in the envelope (carrying the optional `tab`/`server` fields). Zero hosts prints nothing (`{"ok":true,"result":[]}` under `--json`) and exits 0.
- **`commands`** resolves a host like `exec`, sends `__commands`, and prints one command id per line, sorted — a grep-able view of what the palette can do.
- **Version skew**: when a chosen host's `extVersion` is older than the embedded extension version (`codebridge.OlderThan` — numeric component compare, non-numeric tails like `0.0.0-dev` degrade to their numeric prefix), the CLI prints `code bridge extension v<a> is older than the bundled v<b> — run rk code-server update` on stderr, at most once per invocation. A dev build without an embedded VSIX skips silently. The protocol is additive-only, so skew degrades, never breaks.
- **Registration**: the parent and all three children register unconditionally on `rootCmd` with `Long:` blocks (help-dump platform-stability); the help-dump test pins the `code` subtree at exactly `exec`/`hosts`/`commands`.

## Host resolution and liveness

The registry is a **discovery hint only** — liveness is re-derived on every call, never cached (Constitution II). `codebridge.LiveHosts` sweeps the resolved cb hosts dir (§ Socket and registry contract) and treats a record as live only if `kill -0` on its pid succeeds (or returns `EPERM` — the process exists, just not signal-able; false-pruning a live host is worse than keeping it) **and** a `__ping` over its socket answers within 2s. A record failing either check is removed (prune notice on stderr) and excluded.

**Second consumer — the daemon's status GET**: `GET /api/windows/{windowId}/code-bridge` ([api-and-sockets](/run-kit/api-and-sockets.md) § API Layer) reads the resolved cb registry at request time (no cache) and derives two tab-keyed stamps: `startedAt` via `codebridge.TabStartedAt` over `ReadRecords(HostsDir())` — the newest RFC 3339 `startedAt` among host records whose `tab` AND `server` match and whose pid is alive (`kill -0` only) — and `emptyBootAt` via `codebridge.TabEmptyBootAt` over `ReadBootMarkers(BootsDir())`, the same rules applied to empty-boot markers. Both functions ride ONE newest-wins walk (the unexported generic `newestTabStamp` over the `tabStamped` interface `HostRecord` and `BootMarker` both implement) and one enumeration loop (`readJSONDir`, shared by `ReadRecords` and `ReadBootMarkers`: a missing dir is an empty list, unreadable/undecodable files are skipped, entries sorted by host id). This consumer does NO `__ping` and prunes nothing — `LiveHosts` stays the CLI's verb (§ Design Decisions → Request-path liveness is `kill -0` only). The two stamps are the code tile's first-boot rescue signals ([ui/lenses-and-layout](/run-kit/ui/lenses-and-layout.md) § Code Surface → First-boot rescue): the marker is the POSITIVE oracle — only an extension host that activated with zero folders writes one, so a live marker newer than the mount baseline proves THIS boot is the broken one — while a live tab-keyed record is the good-boot confirmation that settles a generation early and never triggers a reload. Two documented limitations: two viewers opening the same fresh tab within the rescue window — when the second boot succeeds (the first warmed VS Code's workspace cache), its newer record outranks the first viewer's newer marker at that viewer's verdict read, so the first viewer's still-broken frame settles without a reload and is remounted by hand; and `rk.bridge.enabled=false` is undetectable without reading VS Code settings files (a rejected coupling), so that configuration sees no rescue at all — fail-closed (260910-74q0-code-tile-first-boot-rescue-reload, 260910-oa3c-code-rescue-positive-signal-record-ownership).

Resolution order for a single-host verb (`codebridge.Resolve`):

1. `--host <id>` — exact match on `hostId`; an unmatched explicit `--host` is an error, never a fallback.
2. **Tab+server direct** — when the selector carries both `Tab` and `Server` (set by `--tab`, or by the own-tab default below), a host whose record carries exactly that pair wins; hosts without a tab identity never match this step, and a miss falls through, never errors.
3. The target folder — `--folder`, `--tab`'s `@rk_win_code_root` read, or by default the git toplevel of the cwd (`git rev-parse --show-toplevel` via `exec.CommandContext` with a 5s timeout, falling back to the cwd itself outside a repo) — matched against record `folder` by exact path first (**unique only**: several exact-folder matches yield `ErrAmbiguous` carrying the colliding hosts), then the record whose `folder` is the longest **path-component-aware** prefix of the target (`/repo` matches `/repo/x`, not `/repository`).
4. No match: exactly one live host → use it with a `using host <id> (<folder>)` note on stderr; several → exit 1 listing them (`id  folder  tab` rows); none → exit 1 with `no code-bridge host — open the code lens on <folder> (or check ` + "`rk doctor`" + `)`.

**`--tab [@N]`** sets the selector's `Tab`/`Server` directly AND still reads the tab's `@rk_win_code_root` into `Folder` (`tmux.GetWindowOption`), so a host registered without a tab (a user-opened window on that folder, or a `?folder=` degrade frame) is still found by the folder fallback. Bare `--tab` resolves the caller's own tab via the shared own-tab resolver (`$TMUX_PANE` → `@N`; outside tmux with no `@N` is exit 1), `@N`/`=session:window` names another tab. An EMPTY code root falls through to the cwd default with a `tab @N has no @rk_win_code_root — falling back to the cwd` note. `--all` ignores `--tab` (the fan-out resolves no tab).

**Own tab is the default target inside tmux**: with no `--host`/`--tab`/`--folder`, a caller inside a tmux pane resolves its own window best-effort (`ownWindowID` in `owntab.go` — `$TMUX_PANE` + the `$TMUX` socket prefix; outside tmux or with a malformed `$TMUX` the step is skipped silently) and tries the tab-direct match first, then falls through to the cwd-toplevel folder ladder. An explicit `--folder` skips the own-tab step. This removes the ambiguity two same-folder tabbed hosts would otherwise create — a folder-only default would pick one arbitrarily.

`--all` fans out to every live host: default output prints one `<hostId>\t<result JSON>` row per successful host; `--json` emits the array of `{hostId, folder, response}` under `result` in the envelope (a host that failed at the transport layer carries a synthesized not-ok response, so the array always has one entry per live host). The `--all --json` envelope is verdict-bearing: any host failure yields `{"ok":false,"result":[<per-host array>],"error":{"code":"operational","message":"at least one host failed"}}` — the per-host array still prints, and `ok` mirrors the exit code. Exit is `1` when any host errored, else `0`.

## Distribution

- **Build**: `scripts/build.sh` and the release workflow's build job run the extension build (`pnpm install --frozen-lockfile && pnpm run build && pnpm run package -- <version>` in `app/code-bridge/`; `<version>` is the release tag, `0.0.0-dev` locally) and copy the VSIX + a `VERSION` sidecar into `app/backend/build/codebridge/` **before** `go build`. `just setup` installs the extension's deps. CI (`.github/workflows/ci.yml`) runs a `Code bridge (tsc + node --test)` job (`tsc --noEmit` + `node --test` over the compiled tests) wired into the ci-gate's required-jobs list. `.gitignore` covers `app/code-bridge/{dist,*.vsix,node_modules}` and `app/backend/build/codebridge/*` (except `.gitkeep`).
- **Embed**: `//go:embed all:codebridge` → `build.CodeBridge` in `app/backend/build/embed.go`, beside `Frontend`. `codebridge.Embedded() (vsix, version, ok)` reads `rk-code-bridge.vsix` + `VERSION`; an absent VSIX (a dev build without the extension step — the embed dir holds only `.gitkeep`) is `ok=false`, a state not an error — callers skip with a `Notef` and never fail.
- **Install**: `rk code-server install` and `update` (the shared `codeServerInstallToLatest` path), after the binary step succeeds, call `codeserver.InstallBridgeExtension(ctx, home, vsix, version)`. The installed version is read by scanning `<extensionsDir>/run-kit.rk-code-bridge-<v>/package.json` — code-server's stable on-disk layout, pure filesystem, no subprocess (`codeserver.ExtensionsDir(home)` is the one resolution shared by the daemon's spawn flags, the install step, and the doctor row). Equal versions skip with a note; otherwise the VSIX is staged in a private temp dir (0700, removed after) and installed via `<managed code-server binary> --install-extension <vsix> --extensions-dir <dir> --force` under a 2-minute `exec.CommandContext`, printing `Installed code bridge extension v<v>.` A failure of the extension step is a warning, never the verb's exit code — the binary install already succeeded. The daemon-start `~/.rk` tenant move (`homemigrate.MoveRKTenants`) runs the same idempotent `InstallBridgeExtension` against the managed binary at its new state-home path after stopping the `rk-code-server` session — skipped when no managed binary or bundled VSIX exists, a failure logged and non-fatal — so the extension comes up on a build that resolves the hexokit state home; the move does not respawn code-server (the normal daemon-start `ensureCodeServer` does, from the new paths), and a failed move-step install is retried by the next `rk code-server install`/`update`. (3ht0)
- **Respawn rule**: `update` restarts the `rk-code-server` session when `binaryChanged || extensionChanged` — a newly installed extension only loads on a code-server restart, so a bridge-only update still respawns. `install` keeps its migration-only respawn rule. The `rk update` code-server leg inherits both behaviors via `runCodeServerUpdateFlow`.
- **Setting seed**: the daemon's `codeServerSeedSettings` carries `"rk.bridge.enabled": true` (write-once seed; user edits win).
- **Empty-boot marker rollout**: the `cb/boots/` marker is written only by the updated extension, so the code tile's first-boot rescue goes live with it — after an rk upgrade, `rk code-server update` (or `rk update`) installs the embedded VSIX and respawns code-server under the `binaryChanged || extensionChanged` rule above. Until then the status route reports `emptyBootAt: ""` and the rescue never fires — fail-closed, which by itself ends the false reloads. `rk doctor`'s code-bridge row already surfaces the installed-vs-embedded version mismatch (§ Doctor row and skill topic).

## Doctor row and skill topic

`rk doctor` carries a `code bridge` row after the `code-server` row, always OK-shaped (the bridge is optional tooling, never a dependency failure): `not installed — run rk code-server install` when no `run-kit.rk-code-bridge-*` dir exists in the extensions dir; otherwise `installed v<v>; <N> live host(s)` (N from the same liveness-pruning enumeration `rk code hosts` performs), appending `; bundled v<b> is newer — run rk code-server update` when the embedded version is newer. The check is pure over injected `(extensionsDir, embeddedVersion, listHosts)` inputs so tests never touch the real state dir, and it appears in `--json` like every other check.

`rk skill code` is the agent-facing topic page — canonical at `docs/site/skill/code.md` (≤150 lines, static-only), synced by `scripts/sync-skill.sh` into `cmd/rk/skill/code.md`, embedded and registered in `skillTopics`, drift-guarded like `display`/`mux`. It teaches the gate (`command -v rk` + a live host via `rk code hosts`), the three verbs, the arg rules and `$uri` sugar, the prepare-a-PR-for-review recipe, exit codes, and the gotchas. `docs/site/skill.md` carries the topic-index line and one capability row; the README command table carries the `run-kit code` row.

## Security stance

The bridge is a same-user, local-only RCE into the editor — that is the feature, and the design keeps it at exactly that privilege level and no wider.

- **Unix socket, not TCP** — a localhost port is reachable by any page in the user's browser (a form POST to `127.0.0.1` is not blocked by CORS); a filesystem socket is reachable only by processes that can open a path under the user's state dir.
- `cb/` is `0700`, sockets `0600`; the extension refuses to start on a looser dir. The bridge never binds TCP and never spawns processes.
- **No privilege gained** — anything a caller can do through the bridge it could already do as the same user (edit the extensions dir, edit settings, kill the process), so no `rk.bridge.deny` allowlist ships (theatre against a threat already inside the account). `workbench.action.terminal.sendSequence` is reachable through the bridge — equivalent to typing in the user's terminal, which the calling shell already can.

## Non-goals

- **`rk code open`** — deferred: the code surface's folder is the shared `@rk_win_code_root` tmux option (seeded from the derived git root, moved by the editor's own navigation or `rk tab code set`), so a bridge-level open verb would duplicate the tab verb's write. Until then: `rk tab code set <folder>`, or File > Open Folder in the editor.
- **Remote exec over `rk remote` tunnels** — local-only; a thin daemon proxy can be added later if cross-machine exec is needed.
- **A `rk.bridge.deny` allowlist** — see § Security stance.
- **Marketplace publishing** — distribution is the embedded VSIX only.

## Requirements

### Requirement: Private same-user socket root
The bridge state root SHALL be `$XDG_STATE_HOME/hexokit/cb/` (default `~/.local/state/hexokit/cb/`), resolved by the extension as `<state base>/hexokit/cb` unconditionally and by Go through the apphome dual-read home rule (the hexokit state home when it exists, else the legacy `run-kit` one on the skip-release path, else hexokit), created `0700`; the extension MUST refuse to start (log, no throw) when an existing `cb/` has group/other access, and sockets MUST be `0600`. Go discovery SHALL read only the resolved cb dir (`ReadRecords`/`ReadBootMarkers`/`LiveHosts` over `HostsDir()`/`BootsDir()`).

#### Scenario: Loose dir refuses to start
- **GIVEN** an existing `cb/` with mode `0755`
- **WHEN** the extension activates
- **THEN** it logs the refusal to its output channel and opens no socket, writes no record, and throws nothing

#### Scenario: A legacy-only host record is not seen once migrated
- **GIVEN** a migrated state home and a host record only under `<state>/run-kit/cb/hosts/`
- **WHEN** Go lists bridge hosts
- **THEN** the legacy record is not seen; **AND GIVEN** an unmigrated install (resolved == legacy), **THEN** the record IS read from the resolved dir and its socket is dialed at the record's own absolute path

### Requirement: Deterministic host identity and clean lifecycle
`hostId` SHALL be the first 12 hex chars of `sha1(<identityPath> + "\n" + machineId)`, where `<identityPath>` is the workspace file's `fsPath` when the window carries a validated tab identity and the first workspace folder's `fsPath` otherwise; activation SHALL unlink a stale socket, listen on `cb/<hostId>.sock`, and write `cb/hosts/<hostId>.json` atomically (gaining `tab`/`server` exactly when an identity is present); deactivation MUST remove only the files whose on-disk `pid` is its own — the record, its socket, and the boot marker — leaving files a newer host rewrote in place, and MUST close the server unconditionally. A disabled `rk.bridge.enabled` MUST produce no side effects; a zero-folder activation's only side effect is the empty-boot marker, written only when a `file:` workspace file's on-disk `settings` yield a validated tab identity.

#### Scenario: Window reload reuses the host identity
- **GIVEN** code-server reloaded a window on folder `/home/u/code/x`
- **WHEN** the extension host activates again
- **THEN** the same `hostId` reuses the same socket path and record — no second record leaks

### Requirement: One request per connection, four error kinds
The bridge SHALL speak NDJSON with exactly one request and one response per connection; failures MUST classify as `unknown-command` | `threw` | `timeout` | `bad-request`; result serialisation MUST never throw (a non-serialisable value degrades to the `$nonSerializable` marker).

#### Scenario: Malformed line echoes a null id
- **GIVEN** a running bridge and `printf 'not json\n' | nc -U cb/<id>.sock`
- **WHEN** the line arrives
- **THEN** exactly one `{"id":null,"ok":false,"error":{"kind":"bad-request",…}}` line returns and the socket closes

### Requirement: Live-verified host resolution
The CLI MUST treat a registry record as live only when `kill -0` (or `EPERM`) and a 2s `__ping` both succeed, pruning failing records; resolution SHALL be `--host` exact → tab+server exact (when both are selected) → folder exact (unique only — several exact matches are ambiguous, listing the colliding hosts with their tabs) → longest path-component-aware prefix → single-live-host fallback with a stderr note → exit 1 (the open-the-lens hint when none). `--tab` SHALL set `Tab`/`Server` directly and still feed the tab's `@rk_win_code_root` into the folder fallback, SHALL fall through to the cwd default with a note when the tab's code root is empty, and MUST be mutually exclusive with `--host` and `--folder`. A flag-less invocation inside tmux SHALL try the caller's own tab first (best-effort, skipped silently outside tmux), and an explicit `--folder` MUST skip the own-tab step.

#### Scenario: Worktree resolves to its own host
- **GIVEN** live records A (`/repo`), B (`/repo/.worktrees/x`), C (`/other`), cwd `/repo/.worktrees/x/sub`
- **WHEN** `rk code exec __ping` runs
- **THEN** B is chosen (git toplevel `/repo/.worktrees/x`, exact match); **AND GIVEN** cwd `/repo/deep/x` with no exact record, **THEN** A wins as the longest component-aware prefix

#### Scenario: Own tab beats a same-folder sibling host
- **GIVEN** two live hosts on the same folder `/wt` with tabs `@3` and `@5`, and the caller's pane in window `@5`
- **WHEN** `rk code exec __ping` runs with no flags
- **THEN** the `@5` host is chosen by the own-tab direct step, with no `using host` note

### Requirement: Gated editor actions over a validated tab identity
The extension SHALL read its tab identity from the workspace settings `rk.tab` (`^@\d+$`) and `rk.server` (`^[A-Za-z0-9_.-]+$`), set the `rk.hasTab` context key from it (re-evaluated on configuration change), and gate every run-kit menu/palette entry on it — a host without a valid identity MUST show no entries and never error. Every action SHALL shell out to an existing rk verb via `execFile` with an argv array and a timeout (15 s web-add/notify, 20 s send); the rk binary SHALL resolve `rk.bridge.rkPath` → `$RK_BIN` → `rk` on PATH, and an unresolvable binary MUST surface exactly `HexoKit: rk not found — set rk.bridge.rkPath`.

#### Scenario: Tab-less host hides the actions
- **GIVEN** a code-server window opened on a bare folder (no workspace file)
- **WHEN** the extension activates
- **THEN** `rk.hasTab` is false, no run-kit entries appear in any menu, and no command errors

#### Scenario: A gate refusal offers Force
- **GIVEN** Send to Agent with `rk mux send` exiting 1 on stderr `refused: agent active (%3)`
- **WHEN** the refusal surfaces
- **THEN** a warning shows that line with a **Force** button that re-runs the same argv plus `--force`

### Requirement: Best-effort extension install
`rk code-server install`/`update` SHALL install the embedded VSIX when the installed version differs (scan of `<extensionsDir>/run-kit.rk-code-bridge-*/package.json`), skip when equal, skip with a note when the build carries no VSIX, and MUST NOT fail the verb on an extension-step error; `update` MUST respawn the `rk-code-server` session when only the extension changed. The daemon-start `~/.rk` tenant move SHALL likewise run the idempotent install against the managed binary at its new state-home path after stopping the `rk-code-server` session, skipping when no managed binary or bundled VSIX exists and logging a failure without failing the daemon start.

#### Scenario: Dev build skips honestly
- **GIVEN** a dev build whose embed dir holds only `.gitkeep`
- **WHEN** `rk code-server install` runs
- **THEN** the extension step is skipped with a note and the exit code is 0

## Design Decisions

### VSIX rides the `build/` embed dir, not a committed binary
**Decision**: The packaged VSIX and its `VERSION` sidecar land in the gitignored `app/backend/build/codebridge/` (committed `.gitkeep`), embedded as an `embed.FS`; an empty dir means "not bundled" and every consumer skips.
**Why**: Identical to how the frontend `dist/` reaches the binary; keeps binaries out of git; a clean `go build ./...` still compiles; dev builds stay honest ("not bundled") instead of shipping a stale VSIX.
**Rejected**: Committing `rk-code-bridge.vsix` under `internal/…` — binary churn in every release diff and a guaranteed drift between source and artifact.
*Introduced by*: 260826-83jz-code-bridge-extension

### Installed-extension inventory is read from the extensions dir, not `code-server --list-extensions`
**Decision**: Both the install skip check and the doctor row scan `<extensionsDir>/run-kit.rk-code-bridge-<v>/package.json` (numerically greatest version wins when a partial upgrade left several dirs).
**Why**: Pure filesystem, no subprocess, testable with a temp dir, and works when code-server is not running; the directory naming `<publisher>.<name>-<version>` is code-server's stable on-disk layout.
**Rejected**: Spawning `code-server --list-extensions --show-versions` — a ~1s Node boot per doctor run and a subprocess dependency in a read-only check.
*Introduced by*: 260826-83jz-code-bridge-extension

### Host registry is a discovery hint verified live on every call
**Decision**: `cb/hosts/*.json` is written by the extension and consulted by the CLI, but a record counts only after `kill -0` **and** `__ping` succeed in the same call; failures prune it.
**Why**: Constitution II — no request-time read treats a file as the source of truth; the live socket is.
**Rejected**: Scanning `cb/*.sock` alone (no folder metadata without a round-trip to every socket).
*Introduced by*: 260826-83jz-code-bridge-extension

### Request-path liveness is `kill -0` only
**Decision**: the code-bridge status GET filters host records and boot markers with `PIDAlive` (`kill -0`; `EPERM` counts as alive) and never calls `LiveHosts`.
**Why**: `LiveHosts` dials every record's socket with a 2 s timeout serially and prunes the registry as a side effect — neither belongs on a UI request path; the rescue's newer-than-baseline compare already neutralises stale records and markers, so a ping adds nothing for this signal.
**Rejected**: reusing `LiveHosts` on the request path (latency and file deletion on a read).
*Introduced by*: 260910-74q0-code-tile-first-boot-rescue-reload; extended to boot markers: 260910-oa3c-code-rescue-positive-signal-record-ownership

### Cleanup removes only files the exiting host still owns
**Decision**: `deactivate()` unlinks the host record, socket, and boot marker only when the on-disk file's `pid` is its own.
**Why**: `hostId` hashes the workspace path with VS Code's per-browser `machineId`, so successive boots of one tab in one browser share a record and socket path; VS Code keeps the previous extension host alive ~5 minutes after its client leaves, and an unconditional unlink was deleting the live host's files.
**Rejected**: re-keying `hostId` per boot (breaks the deterministic identity `rk code exec --tab` and the newest-wins rule rely on); leaving cleanup unconditional and tolerating the loss (kills the bridge for the tab five minutes after every remount).
*Introduced by*: 260910-oa3c-code-rescue-positive-signal-record-ownership

### `vscode`-free bridge core
**Decision**: `src/bridge.ts` + `src/protocol.ts` implement socket serving, framing, timeouts, `$uri` rewriting, and result serialisation over an injected executor; `src/extension.ts` is only the vscode glue.
**Why**: The `vscode` module exists only inside an extension host, so the codec/server is tested with plain `node --test` over a real Unix socket.
**Rejected**: `@vscode/test-electron` integration tests — downloads VS Code in CI for a small extension.
*Introduced by*: 260826-83jz-code-bridge-extension

### Nested subcommands re-wrap their own `Args` validators
**Decision**: The `code` children wrap their `Args` validators with `usageArgs` in their own `init()` loop rather than relying on root's central wrap.
**Why**: Root's wrap loop covers only `rootCmd`'s direct children, so nested subcommands would otherwise leak arg-count violations out of the usage class (exit 2); the one-place idiom mirrors `code_server.go`.
**Rejected**: Extending root's loop to walk the whole tree (churns a shared mechanism for one group); per-command ad-hoc arg checks (scatters the convention).
*Introduced by*: 260826-83jz-code-bridge-extension

### The Go deadline adds slack to the extension-enforced timeout
**Decision**: The request's `timeoutMs` is `--timeout` (extension-enforced); the Go dial+read deadline is `--timeout` + 2s.
**Why**: The extension's own `timeout` error — a classified, actionable kind — wins the race, while a hung host (dead socket, no response) stays bounded on the client side.
**Rejected**: A single deadline on both sides (a client-side win surfaces as an unclassified transport error); relying on the extension alone (a wedged extension host blocks the CLI indefinitely).
*Introduced by*: 260826-83jz-code-bridge-extension

### `--tab` is a direct tab+server selector with a folder fallback
**Decision**: `--tab` sets `Selector.Tab`/`Selector.Server` and `Resolve` matches a host's recorded `tab`/`server` exactly before any folder step; the tab's `@rk_win_code_root` is still read into `Selector.Folder` so tab-less hosts on that folder stay reachable. A flag-less invocation inside tmux tries the caller's own tab first; an explicit `--folder` skips the own-tab step. The tab is resolved through the shared `cmd/rk/owntab.go` resolver (bare `--tab` = own tab via `NoOptDefVal`).
**Why**: host identity is the tab once tab keying exists, so the tab needs a first-class selector; the folder read remains as the fallback for hosts registered without an identity. The own-tab default is what makes same-folder tabbed hosts unambiguous — a folder-only default would pick one arbitrarily — and an empty root degrades to the ordinary cwd default rather than failing.
**Rejected**: exact-folder-first-wins matching (silently picks an arbitrary host among same-folder tabbed hosts — several exact matches yield `ErrAmbiguous` instead); failing on an empty code root (the tab simply never had `rk tab code set` run).
*Introduced by*: 260909-kji8-tab-keyed-code-workspace-actions

### The workspace file is the tab-identity carrier
**Decision**: rk derives one `.code-workspace` file per (server, tab, code root) whose `settings` block carries `rk.tab`/`rk.server`; the code tile opens `/code/?workspace=<file>`.
**Why**: it is the only channel code-server hands an extension host arbitrary per-window key/value data; the frontend already controls the iframe `src`; no protocol change, no daemon dependency for the actions (every action is `rk tab …`/`rk mux …`/`rk notify`, all of which work with `rk serve` down).
**Rejected**: a per-tab symlink dir as the `?folder=` carrier (fsPath leaks the symlink everywhere, breaks folder matching and git tooling); `?payload=` (workbench-only, `openFile`); a reverse editor→daemon protocol (unneeded once identity is in settings); a multi-window ambiguity ladder (superseded by exact tab keying).
*Introduced by*: 260909-kji8-tab-keyed-code-workspace-actions

### The code lens is keyed by tab, not by folder
**Decision**: host identity and editor state (IndexedDB, keyed by workspace identity) follow the tab; two tabs on one worktree get separate editors and distinct bridge hosts.
**Why**: folder keying addressed the folder-latch problem, which `@rk_win_code_root` solves separately; what remained of it was shared editor state across same-folder tabs, which contradicts "the tile belongs to the tab" and caused the same-folder hostId collision (the second host unlinked the first's socket and overwrote its record).
**Rejected**: keeping folder keying with a tab hint on the side (still collides on hostId; still cannot target from the editor).
*Introduced by*: 260909-kji8-tab-keyed-code-workspace-actions

### One GET writes the file at "editor about to open"
**Decision**: `GET /api/windows/{windowId}/code-workspace` ensures the file and returns its path; the frontend fetches it at code-tile mount; the handler is the only daemon-side writer.
**Why**: a browser cannot write to the state dir; the SSE derivation tick is a read path and must not gain a write side effect; shipping paths in every window payload would write files for editors never opened; letting `rk tab code set` write it would make the CLI a second writer. One read-shaped GET satisfies Constitution IV/IX.
**Rejected**: writing inside the SSE tick; embedding the path in the window payload; `rk tab code set` pre-warming the file.
*Introduced by*: 260909-kji8-tab-keyed-code-workspace-actions

### `RK_BIN` is env-carried; tab identity is not
**Decision**: the daemon's code-server spawn passes `RK_BIN=<launcher>` (`selfpath.Launcher`: the rk-owned symlink `~/.local/share/rk/bin/run-kit` targeting the resolved Cellar binary, re-pointed by the brew daemon at every `rk serve` start); the extension resolves `rk.bridge.rkPath` → `$RK_BIN` → `rk` on PATH.
**Why**: the binary path is per-process (one code-server), so env is the right carrier; tab identity is per-window, so it is not. PATH inheritance alone works only by accident of how `rk serve -d` was launched. The launcher (not the brew-prefix stable symlink) because the extension execs `$RK_BIN` per editor action and the stable symlink dangles for the whole unlink→install→link phase of a `brew upgrade`, while the Cellar target survives until post-link cleanup — by which time the daemon restart has re-pointed the launcher (the hook wrapper's two-path design, see [agent-state](/run-kit/agent-state.md) § `rk agent setup`).
**Rejected**: relying on PATH inheritance alone; a directly Cellar-pinned `RK_BIN` (dies at keg cleanup with nothing to re-point it); the brew-prefix stable symlink (dangles for the whole install phase — every bridge action fails mid-upgrade); an ENOENT fall-through to `rk` on PATH inside the extension (symptom treatment — PATH inheritance by accident again, and it leaves the install-job chain and the rk-gui spawn broken).
*Introduced by*: 260909-kji8-tab-keyed-code-workspace-actions (launcher retarget: 260916-la8z-hook-launcher-upgrade-window)

### State-dir resolution in two runtimes
**Decision**: `codebridge.StateDir()` resolves `<state home>/cb` through `internal/apphome`'s dual-read rule (mirroring `snapshot.DefaultDir()`'s XDG base), and the extension resolves `<state base>/hexokit/cb` unconditionally in the vscode-free `src/state-dir.ts` — the two agree in every migrated install.
**Why**: The extension (Node) and the CLI (Go) resolve `cb/` independently with no shared process — if the rules drift, hosts register where the CLI never looks. The extension side is its own module because `extension.ts` imports `vscode` and is untestable under the plain-node runner.
**Rejected**: A config key or env override for the bridge dir (new config surface for a path that should follow the state root convention); a per-side inline re-implementation (the rule would drift between `extension.ts` and Go unnoticed).
*Introduced by*: 260826-83jz-code-bridge-extension (Go dual-read: 260926-qm4d-hexokit-home-migration; unconditional extension resolution: 261006-lwt6-delete-stale-runkit-homes)

### Go cb discovery reads the one resolved dir
**Decision**: `codebridge.StateDir` keeps the apphome-resolved state home and Go discovery reads that one dir only — the callers (`rk code hosts`/`exec`, the tab code-state GET, doctor's host count) resolve `HostsDir()`/`BootsDir()` and call the single-dir `ReadRecords`/`ReadBootMarkers`/`LiveHosts`. The home migration does not copy `cb/` — it cold-starts, and a live host re-registers on activation.
**Why**: in the narrow unmigrated window an old VSIX still writes the resolved legacy `cb/`, and the resolved rule keeps it reachable (its socket is dialed at its record's own absolute path); in every migrated install resolved == hexokit, matching the extension. The daemon-start VSIX reinstall (§ Distribution) moves every install's registrations off the legacy leaf, and the daemon-start legacy-home deletion keeps a live host's legacy `cb/` — and nothing else — until no live host is registered there ([configuration](/run-kit/configuration.md) § Legacy-Home Deletion), so a merged second read dir has no window left to cover. `cb/` is pure runtime discovery state — the pid-alive filter neutralizes stale records — so copying it buys nothing.
**Rejected**: pinning Go to `apphome.NewStateDir()` (breaks the old-VSIX case in the unmigrated window without fixing any migrated case); keeping the merged dual-read (covers a window the VSIX reinstall and the guarded deletion already close); copying `cb/` in the home migration (carries dead records and sockets the pid filter must then sweep, and double-registers live hosts).
*Introduced by*: 261006-lwt6-delete-stale-runkit-homes

### The `~/.rk` move step reinstalls the bundled VSIX
**Decision**: the daemon-start tenant move runs the idempotent `codeserver.InstallBridgeExtension` against the managed binary at its new state-home path after stopping the `rk-code-server` session — skipped when no managed binary or bundled VSIX exists, a failure logged and non-fatal, retried by the next `rk code-server install`/`update`. The move does not respawn code-server; the normal daemon-start `ensureCodeServer` respawns it from the new paths.
**Why**: an extension installed before the state-home migration resolves `<state>/run-kit/cb`; reinstalling during the move brings the host up on a build that resolves the hexokit state home, so only hosts whose reinstall never happened keep registering under the legacy leaf — the daemon-start legacy-home deletion keeps their `cb/` while a live host is registered there.
**Rejected**: waiting for the user's next `rk code-server install`/`update` (every host stays on the legacy leaf until then, registering under a home the migration otherwise leaves behind); respawning code-server from the move step (the daemon-start `ensureCodeServer` already owns the respawn).
*Introduced by*: 261006-3ht0-consolidate-two-homes

### Code-bridge extension ID kept across the brand sweep
**Decision**: Only the extension's display strings changed (`displayName` and configuration title `HexoKit Code Bridge`, command category `HexoKit`, output channel, toasts, notify title, descriptions); `publisher: run-kit` and `name: rk-code-bridge` are kept.
**Why**: The publisher+name pair is the installed extension ID `run-kit.rk-code-bridge`; rk installs the private `.vsix` per user and `internal/codeserver/extension.go` globs that ID on disk, so renaming it would install a second extension beside the old one.
**Rejected**: A full ID rename — needs a real migration (uninstall old, install new, settings carry) that only pays off if the extension is ever published.
*Introduced by*: 260929-y8ib-hexokit-brand-string-sweep

See [cli](/run-kit/architecture/cli.md) § CLI Subcommands (`code` row) and § Backend Libraries (`internal/codebridge`), [configuration](/run-kit/configuration.md) § Boundaries for the state-dir tenant, and [toolkit-standards](/run-kit/toolkit-standards.md) for the new-surface conformance check.
