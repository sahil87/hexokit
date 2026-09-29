# Code Bridge — run VS Code commands in the `code` lens from the shell

> Design record for `rk code exec` and the `rk-code-bridge` code-server extension. Baseline: HexoKit
> v3.18.1, code-server 4.112. Companion to [`right-panel.md`](right-panel.md) § The `code` lens, which
> owns the code-server topology (`/code/` route, `RK_PORT+2`, the per-window folder latch); this spec
> adds the one thing that lens lacks — a channel *into* the extension host.

## Problem

Agents in HexoKit panes can open windows, present web content (`rk present`), and the `code` lens
renders code-server on a latched folder. But nothing can act *inside* the editor: code-server exposes no
command channel — its CLI only opens files, the URL `payload=` parameter only supports `openFile`, and
the GitHub Pull Requests extension's URI handler is for auth callbacks. That extension's 171 `pr.*`
commands — and every other palette command — are reachable only from inside the extension host.

Motivating case: "prepare PR #N for review". The agent can `gh pr checkout`, and the `code` lens shows
the folder, but it cannot refresh the PR view, focus the PR sidebar, or open the diffs the reviewer
should start with. The last mile stays manual.

The gap is exactly one thing: a process inside the extension host that calls
`vscode.commands.executeCommand()` on behalf of a same-user shell.

## Shape

```
agent shell / tmux pane          unix socket (0600)                      code-server extension host
rk code exec pr.refreshList ──▶ $XDG_STATE_HOME/hexokit/cb/<hostId>.sock ──▶ rk-code-bridge extension
        │                                                                     net.createServer → executeCommand
        │  looks up host by tab, then folder                                  one per open folder/window
        └──────────────▶ $XDG_STATE_HOME/hexokit/cb/hosts/<hostId>.json ◀─── registers on activate
                         {hostId, folder, pid, sock, extVersion, startedAt, tab?, server?}
```

Two pieces, one contract:

1. **`rk-code-bridge`** — a ~60-line VS Code extension (TypeScript; deps: `vscode` API + Node `net`),
   source at `app/code-bridge/`. On activate it opens a Unix socket, writes a host record, and serves
   `executeCommand` requests. On deactivate it removes both.
2. **`rk code`** — a new cobra command group. `exec` resolves the right host, sends the request, prints
   the result. `hosts` lists live hosts. The VSIX is `go:embed`ded and installed by the existing
   `rk code-server install` / `update`.

The daemon is not involved. The bridge is peer-to-peer between a shell and an extension host; the
`/code/` route, the latch, and reachability handling in `right-panel.md` are untouched.

## Protocol

Newline-delimited JSON over the socket. One request per connection (keeps the extension stateless).

```jsonc
→ {"id":"k3f9","command":"pr.checkoutByNumber","args":[2908],"timeoutMs":30000}
← {"id":"k3f9","ok":true,"result":null,"ms":812}

→ {"id":"q1","command":"nope.doesNotExist","args":[]}
← {"id":"q1","ok":false,"error":{"kind":"unknown-command","message":"command 'nope.doesNotExist' not found"}}

→ {"id":"p2","command":"__ping"}
← {"id":"p2","ok":true,"result":{"folder":"/Users/sahil/code/sahil87/run-kit","pid":81784,"version":"0.1.0"}}
```

| Field | Notes |
|-------|-------|
| `command` | Any registered command id. `__ping` and `__commands` (returns `vscode.commands.getCommands(true)`) are bridge-internal. |
| `args` | JSON array, passed positionally. Path-like strings are **not** auto-converted; the one piece of sugar is the `{"$uri":"file:///…"}` marker, rewritten to `vscode.Uri.parse` — `vscode.open` / `vscode.diff` want Uris. |
| `result` | Serialised via `JSON.stringify`; non-serialisable results become `{"$nonSerializable":true,"type":"…"}`. Never throws on serialisation. |
| `error.kind` | `unknown-command` · `threw` · `timeout` · `bad-request`. Maps to CLI exit codes below. |

## CLI surface

```
rk code exec <command> [json-arg…]      # run a command; args are JSON literals (bare words → strings)
      --folder <path>                     # target host by workspace folder (default: git toplevel of cwd)
      --host <id>                         # target by host id from `rk code hosts`
      --all                               # fan out to every live host
      --timeout 30s
      --json                              # raw response envelope on stdout (default prints result only)
rk code hosts [--json]                    # live hosts: id, tab, server, folder, pid, age; prunes records whose pid is dead
rk code commands [--folder]               # `__commands` — grep-able list of what the palette can do
```

Output contract follows the toolkit standard (`toolkit-standards`): stdout is data (the result JSON),
stderr is diagnostics; exit `0` ok, `1` operational (no host, timeout, command threw), `2` usage (bad
JSON arg, unknown flag). `unknown-command` exits 1 with the closest matches on stderr. `--quiet`
suppresses chatter only (Principle 9).

### Host resolution

1. `--host` wins (exact host-id match).
2. `--tab [@N]` sets a (tab, server) selector matched **directly** against each record's `tab`+`server`;
   the tab's `@rk_win_code_root` is still read into the folder selector, so a host registered without a
   tab on that folder (a user-opened window, or the `?folder=` degrade frame) is still found by the
   folder fallback.
3. With no `--host`/`--tab`/`--folder`, a caller inside a tmux pane first tries its **own tab**
   (best-effort; outside tmux or with a malformed `$TMUX` the step is skipped silently), then falls
   through to the folder ladder. An explicit `--folder` skips the own-tab step.
4. The folder — `--folder <path>` or the git toplevel of cwd — is matched against each record's
   `folder`: exact first, then longest-prefix (a worktree under a multi-root workspace still resolves).
5. No match and exactly one live host → use it, with a stderr note. Several → exit 1 listing them (the
   listing includes the tab). None → exit 1 with the hint to open the `code` lens on that folder.

`rk code hosts` renders `TAB` and `SERVER` columns (`-` when a host registered without a tab); `--json`
carries the fields.

### No `rk code open` (yet)

An earlier draft had `rk code open <folder>` as sugar over `rk present`. That is wrong for HexoKit: the
`code` lens's folder is a **per-viewer latch** in localStorage (`right-panel.md`), seeded once from the
active pane's git root and moved only by the editor's own navigation. A CLI cannot set it today. The
right hook is the deferred `@rk_code_folder` tmux-option upgrade path named in `right-panel.md`; when
that lands, `rk code open` becomes a one-line wrapper over it. Until then the agent's recipe is: be in
the repo when the user first opens the code surface, or ask the user to File > Open Folder.

## Extension lifecycle

- `activationEvents: ["*"]` — deliberately eager; being reachable before any user action is the point,
  and it costs one socket. Fallback to `onStartupFinished` if startup cost ever shows.
- `hostId` = `sha1(<identityPath>\n<machineId>)[:12]`, where `identityPath` is the workspace file's
  `fsPath` when the window was opened from a `.code-workspace` carrying a tab identity (see
  § Tab identity) — two tabs on one folder get distinct hosts — and the first folder's `fsPath`
  otherwise. Deterministic, so a reloaded window reuses its record and socket path instead of leaking
  one per reload.
- Socket at `$XDG_STATE_HOME/hexokit/cb/<hostId>.sock` (default `~/.local/state/hexokit/cb/`) — the
  same state root `layout-snapshots` uses. Not `~/.config/hexokit` (config is user-authored; this is
  runtime state) and not the legacy `~/.rk`. ~50 bytes, under the 104-byte macOS `sun_path` cap.
  Stale socket files are unlinked on activate.
- Registry record `$XDG_STATE_HOME/hexokit/cb/hosts/<hostId>.json`:
  `{hostId, folder, pid, sock, extVersion, startedAt}` plus optional `tab`/`server` (present only when
  the window carries a tab identity; the six existing names unchanged). The CLI treats a record as live
  only if `kill -0 pid` succeeds **and** `__ping` answers; otherwise it removes it. `__ping`'s `info`
  gains the same two optional fields (additive protocol).
- VS Code setting `rk.bridge.enabled` (default `true`) as the off switch, written into the managed
  profile's `settings.json` alongside the existing `chat.disableAIFeatures` etc. No allowlist in v1
  (see Security).

## Tab identity — one derived workspace file per tab

The code lens is keyed by **tab**. rk derives one `.code-workspace` file per (server, tab, code root)
at `$XDG_STATE_HOME/hexokit/code/<server>/<@N>-<hash6>.code-workspace`, where `hash6` is the first 6
lowercase hex chars of `sha256(<absolute root>)`. Its `settings` block carries `rk.tab` and `rk.server`
— the one channel code-server hands an extension host arbitrary per-window key/value data, readable
through the normal configuration API. The code tile opens `/code/?workspace=<file>` (the primary form,
replacing `?folder=`, which survives as the degrade path when the workspace GET fails). The file is a
**derived artifact**, ensured on demand by `GET /api/windows/{windowId}/code-workspace` from the live
`@rk_win_code_root` — never a state store; deleting it changes nothing but a regeneration.

The extension reads `rk.tab` (`^@\d+$`) and `rk.server` (tmux server-name charset); either failing
validation means no identity. With an identity present it sets the `rk.hasTab` context key (re-evaluated
on configuration change), hashes `hostId` from the workspace file (§ Extension lifecycle), and writes
`tab`/`server` into the host record and `__ping` info. Without one, everything degrades to the
folder-keyed behavior above and every menu/palette entry below is hidden — a tab-less host shows
nothing and never errors.

## Editor-side actions

Six commands (all `"category": "run-kit"`), each gated on the `rk.hasTab` context key and each shelling
out to an existing rk verb via `execFile` argv arrays with a timeout — no shell strings, no new Go
resolution logic:

| Command | Appears in | Effect |
|---------|------------|--------|
| Open in Web Tile | explorer + editor-title context menus (files), palette | `rk tab web add @N <file> --show -L <server>` (15 s timeout) |
| Open Folder in Web Tile | explorer context menu (folders) | the same verb on a directory target |
| Open in Web Tile and Notify | with Open in Web Tile | the add, then on exit 0 `rk notify "presenting <basename>" --title run-kit` |
| Send to Agent | editor context menu (selection), palette | stages `<path>:<N>[-<M>]` plus the selected text via `rk mux send @N - --no-enter -L <server>` (20 s timeout, payload on stdin); a gate refusal warns with a **Force** button that re-runs with `--force` |
| Copy Reference for Agent | editor context menu (selection), palette | the `path:N[-M]` reference to the clipboard |
| Open Port in Web Tile | palette only | an InputBox (validates 1–65535), then `rk tab web add @N :<port> --show -L <server>` |

The `rk` binary resolves on a ladder: the `rk.bridge.rkPath` setting (non-empty, absolute) → `$RK_BIN`
(the daemon's code-server spawn sets it from its own binary path) → `rk` on PATH. An unresolvable
binary surfaces exactly `run-kit: rk not found — set rk.bridge.rkPath`; other non-zero exits surface
the first stderr line. Web-tile successes are silent; copy/send confirm on the status bar for 3 s.

## Security

This is a same-user, local-only RCE into the editor. That is the feature; the design keeps it at exactly
that privilege level and no wider.

- **Unix socket, not TCP.** A localhost port is reachable by any page in the user's browser (a form POST
  to `127.0.0.1:port` is not blocked by CORS). A filesystem socket is reachable only by processes that
  can open a path under the user's state dir.
- `cb/` is 0700, sockets 0600. The extension refuses to start if the dir has looser permissions.
- No privilege gained: anything a caller can do through the bridge it could already do as the same user
  (edit the extensions dir, edit settings, kill the process). An allowlist would be theatre against a
  threat already inside the account. Revisit if code-server is ever bound beyond loopback or run as a
  different user — the `rk remote` path keeps it loopback + SSH, so that holds there too.
- The bridge never spawns processes itself. `workbench.action.terminal.sendSequence` is reachable
  through it — equivalent to typing in the user's terminal, which the shell already can.

## Distribution

1. Extension source at `app/code-bridge/` (package.json, `src/extension.ts`, esbuild bundle), built
   with `vsce package` in the release workflow → `rk-code-bridge-<v>.vsix`. Version pinned to the rk
   release version.
2. Go side `//go:embed`s the VSIX (`internal/installers`, next to the code-server installer).
   `rk code-server install` / `update` gain a step:
   `code-server --install-extension <tmp.vsix> --extensions-dir ~/.local/share/code-server/extensions`
   when installed ≠ embedded version. The daemon's `rk-code-server` sibling session is restarted on
   update as today.
3. Version skew: the record carries `extVersion`; the CLI warns on stderr when it is older than its
   embedded version and suggests `rk code-server update`. Protocol is additive-only, so mismatch
   degrades, never breaks.
4. `rk doctor` gains a line: bridge installed / live hosts.
5. `rk skill code` topic page so agents discover the surface; `rk help-dump` picks up the group
   automatically (toolkit-standards new-surface check).

## Motivating use case, end to end

```sh
# prepare PR #2908 for review in its own worktree + editor tile
rk riff pr-2908 …                                          # worktree + window (or wt create + new-window)
gh pr checkout 2908
# user opens the code surface once → latch seeds to this worktree; bridge host registers within ~1s
rk code exec pr.refreshList                                # GitHub PR extension picks up the branch's PR
rk code exec vscode.diff '{"$uri":"…/a.ts"}' '{"$uri":"…/b.ts"}' "review: a.ts"
rk code exec workbench.view.extension.github-pull-requests # focus the PR sidebar
rk notify "PR 2908 ready in the code tile" --title review
```

The PR extension already detects the PR of the checked-out branch, so the bridge's job is the last
mile — refresh, focus, open the diffs the reviewer should start with — not the checkout itself.

## Alternatives considered

| Option | Why not |
|--------|---------|
| File spool (drop `.json`, extension `fs.watch`es) | No response channel without a second file; ordering is racy; macOS `fs.watch` coalesces events. A socket is barely more code and gives request/response for free. |
| HTTP on a localhost port | Reachable from browser JS (see Security); port allocation; would need a token. Strictly worse than a socket for a same-machine caller. |
| Route through the daemon (`/api/code/exec`) | Adds a hop and puts editor RCE behind the web server's auth surface. Nothing in the daemon needs to know; keep it peer-to-peer. A thin proxy can be added later if `rk remote` hosts need cross-machine exec. |
| Keystroke injection into the browser / code-server `payload=` | Neither can express "execute command X with args". |
| Fork code-server to add a CLI | Maintenance burden for a 60-line problem. |

## Phasing

| Phase | Deliverable | Proves |
|-------|-------------|--------|
| P1 (spike, ~½ day) | Extension + hand-installed VSIX; throwaway `nc -U` script | Socket path length, eager activation, that `executeCommand` from a socket callback behaves on the ext-host event loop |
| P2 | `rk code exec / hosts / commands`; host resolution; embed + install step; `rk doctor` line | Distribution and version-skew story |
| P3 | `rk skill code` topic page; `rk code open` once `@rk_code_folder` exists | Agent-facing ergonomics |

## Follow-on work (after this change ships)

The bridge is a capability; nothing invokes it until the agent side is wired. In order:

1. **Agent discovery — `rk skill code` + consumer skills.** P3's topic page covers the rk side. Each
   consuming repo's toolkit skill (e.g. loom's `.claude/skills/shll-toolkit`) needs a matching pointer
   so an agent asked to "prep PR #N" reaches for `rk code exec` instead of describing clicks.
2. **A "prepare PR for review" recipe as a consumer-side skill** (e.g. `/review-prep <pr>`): worktree +
   `gh pr checkout`, wait for the host to register (`rk code hosts`), then `pr.refreshList`, focus the
   PR sidebar, open the first diffs, `rk notify`. This is the motivating use case — without it the bridge
   is unused.
3. **Close the latch gap — `@rk_code_folder` + `rk code open`.** The recipe above keeps one human step
   (open the code surface once so the folder latches). Landing the deferred `@rk_code_folder`
   tmux-option store from `right-panel.md` and wrapping it as `rk code open <folder>` removes the only
   manual step in the loop. Own HexoKit change, not this one.
4. **Fold into existing review skills.** Consumer `git-pr-review`-style skills that review via `gh` in
   the terminal can additionally stage the review visually in the code tile — an amendment, not a new
   skill.

Item 2 is the one that makes the feature visible day to day; 1 is its prerequisite, 3 its polish.

## Open questions

1. **Command group name**: `rk code exec` (lean — `code-server` is install management, `code` is the
   running editor) vs folding into the existing `rk code-server` group.
2. **Remote hosts**: should P2 make exec reachable over `rk remote` tunnels (needs the daemon proxy),
   or stay local-only? Lean: defer.
3. **Deny-list**: ship a `rk.bridge.deny` setting anyway as belt-and-braces? Lean: no (see Security).
4. **Does P3's `rk code open` pull the `@rk_code_folder` upgrade forward**, or wait for its own change?
