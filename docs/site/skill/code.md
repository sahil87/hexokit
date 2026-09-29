# HexoKit skill: code

Depth for one job: **acting inside the `code` lens editor** — running any VS Code palette command (and the 171 `pr.*` commands of the GitHub Pull Requests extension, plus everything else in the open window) from the shell. This is a static topic page (`rk skill code`); the [core bundle](../skill.md) covers when to reach for HexoKit at all. Everything here is byte-identical on every invocation.

The bridge is an agent-reachable `executeCommand`: the `rk-code-bridge` extension (installed by `rk code-server install`/`update`) opens one same-user Unix socket per open folder and serves one-request-per-connection NDJSON; `rk code exec` is the shell side. It exists because code-server exposes no command channel — its CLI only opens files, and a URL's `payload=` only supports `openFile`. Reach for it when the job is a palette command: refresh a PR list, focus a sidebar, open a diff.

Gate first, as always — HexoKit is optional and the bridge may have no live host:

```sh
command -v rk >/dev/null 2>&1 || exit 0
[ -n "$(rk code hosts 2>/dev/null)" ] || exit 0
```

If either check fails, skip every bridge step silently — describe the output in text instead.

## `rk code hosts` — what is listening

```sh
rk code hosts                 # aligned rows: ID FOLDER TAB SERVER PID AGE EXT
rk code hosts --json          # the host records as an array inside {"ok":true,"result":[…]}
```

A host is one open code-server window with the bridge extension active. Hosts opened from an rk-derived workspace file register their tab and server (`TAB`/`SERVER` columns, `-` when absent); tab-less hosts (user-opened windows, the `?folder=` degrade path) match by folder only. Host records live under the HexoKit state dir, but liveness is re-derived on every call: a record counts only if its pid is alive AND its socket answers a ping; records failing either check are pruned as a side effect. Zero hosts prints nothing (`"result": []` under `--json`) and still exits 0 — gate on empty output, not on the exit code.

## `rk code commands` — the palette, grep-able

```sh
rk code commands                            # one command id per line, sorted
rk code commands --folder /path/to/repo
```

Resolves a host exactly like `exec` does, sends the bridge-internal `__commands`, and prints the full `vscode.commands.getCommands(true)` list — every palette command plus every extension command that the open window can execute. Pipe to `grep '^pr\.'` before you guess at ids.

## `rk code exec` — run a command

```sh
rk code exec pr.refreshList                                   # no args
rk code exec pr.checkoutByNumber 2908                         # a number arg (JSON literal)
rk code exec vscode.open '{"$uri":"file:///tmp/a.ts"}'        # object args pass verbatim
rk code exec workbench.action.focusFirstEditorGroup --json    # the bridge envelope nested in rk's (see Output)
```

**Arg rules** — each positional after the command id is parsed as a JSON literal:

- `2908` → the number `2908`, not a string; `{"a":1}` / `[1,2]` pass through verbatim.
- Anything that is NOT valid JSON (a bare word like `main`) is sent as a string instead.
- A literal `--` ends flag parsing, so negative numbers and `-`-prefixed strings pass as args.

**`$uri` sugar** — an object exactly of shape `{"$uri":"<string>"}` at any nesting depth in the args is rewritten to `vscode.Uri.parse(...)` by the extension. No other coercion happens; plain path-like strings are NOT auto-converted. `vscode.open` and `vscode.diff` want Uris:

```sh
rk code exec vscode.diff '{"$uri":"file:///…/a.ts"}' '{"$uri":"file:///…/b.ts"}' "review: a.ts"
```

**Output**: on success stdout carries the result JSON (`null` prints `null`); `--json` prints the bridge's response envelope nested verbatim inside rk's standard envelope — `{"ok":true,"result":{"ok":…,"result":…}}`, where the outer `ok` mirrors rk's exit code and the inner `ok` is the bridge's. Failures print `error: <kind>: <message>` on stderr; `kind` ∈ `unknown-command` · `threw` · `timeout` (default 30s, tune with `--timeout`) · `bad-request`. A dial/read failure prints `error: <message>` with no kind.

### Host resolution

- `--host <id>` wins (ids come from `rk code hosts`).
- Else `--tab [@N]` matches a host by its registered tab+server **directly** (bare `--tab` = your own tab); the folder match — the tab's `@rk_win_code_root` (written by `rk tab code set`), then the cwd default — remains the fallback for hosts registered without a tab.
- With no flags, a caller inside tmux tries its **own tab** first (skipped silently outside tmux), then the folder ladder below; an explicit `--folder` skips the own-tab step.
- Else the target folder — `--folder <path>`, or by default the git toplevel of the cwd — is matched against each host's folder: exact match first, then longest-prefix (path-component aware, so a worktree under a registered repo resolves to the repo's host instead of matching nothing).
- No match and exactly one live host → it is used, with a `using host <id> (<folder>)` note on stderr. Several → exit 1 listing them. None → exit 1 with the open-the-lens hint.
- `--all` fans out to every live host (ignoring `--tab`): one `<hostId>\t<result JSON>` row per host on stdout (`--json` → `{"ok":true,"result":[{hostId, folder, response}]}`); exit is 1 when any host errored, else 0 (under `--json` that failure reads `ok:false` with the per-host array still carried in `result`).

`--host`, `--tab`, and `--folder` are mutually exclusive (usage error). `rk code commands` takes the same three flags.

### Exit codes

- `0` ok · `1` operational (no host, dial failure, `timeout`/`threw`/`unknown-command`/`bad-request`) · `2` usage (missing command id, `--host` with `--folder`, unknown flag, stray arg).
- `unknown-command` exits 1 and appends a `did you mean:` list of the five closest command ids (fetched from the host's `__commands`) on stderr.

## Recipe: prepare a PR for review

The motivating case. The PR extension already detects the PR of the checked-out branch — the bridge's job is the last mile (refresh, focus, open the right diffs), not the checkout:

```sh
gh pr checkout 2908                                        # in the folder the code lens latched
rk code exec pr.refreshList                                # pick up the branch's PR
rk code exec workbench.view.extension.github-pull-requests # focus the PR sidebar
rk code exec vscode.diff '{"$uri":"file:///…/a.ts"}' '{"$uri":"file:///…/b.ts"}' "review: a.ts"
rk notify "PR ready in the code tile" --title review
```

## Gotchas

- The code surface's folder is the tab's `@rk_win_code_root` tmux option — set it with `rk tab code set [@N] <folder>` (prints the absolute path); the tile opens a derived `.code-workspace` file (`?workspace=`) whose settings carry the tab identity into the editor.
- The editor-side context-menu/palette actions (Open in Web Tile, Send to Agent, Copy Reference, Open Port) exist for **humans** — they shell out to `rk tab web add`/`rk mux send` from the extension host. Agents keep `rk code exec`.
- Resolution never caches: a stale record that fails the pid+ping check is pruned on every call, and the next call re-enumerates from the sockets (the registry is a discovery hint only).
- Security posture is **same-user-only**: file sockets (0600, dir 0700) under the user's state dir, never TCP — anything the caller does through the bridge it could already do as the same user. A page in the user's browser cannot reach the socket; a same-user process can.
- The off switch is the managed profile's VS Code setting `rk.bridge.enabled` (seeded true at install). A host running an extension older than the bundled one draws a version-skew warning on stderr suggesting `rk code-server update`.
- `rk code exec` inherits `workbench.action.terminal.sendSequence` reachability — equivalent to typing in the terminal, which the calling shell can already do; keep it same-user.
- `rk doctor` carries a `code bridge` row (installed extension + live host count) — check it when resolution reports no host.
