# HexoKit skill: restore

Depth for one job: **bringing tmux servers and their agent sessions back after an update or restart killed them**. This is a static topic page (`rk skill restore`); the [core bundle](../skill.md) covers when to reach for HexoKit at all. Everything here is byte-identical on every invocation.

Gate first, since HexoKit is optional and may be absent:

```sh
command -v rk >/dev/null 2>&1 || exit 0
```

Restore is **user-initiated only**: run this page when the user asks for it, never from a timer or a hook. A server or window the user killed on purpose stays dead.

## What survives a kill

The daemon snapshots each covered tmux server's layout (sessions, windows, pane cwds, rk window options) under `${XDG_STATE_HOME:-$HOME/.local/state}/hexokit/snapshots/<server>/` on every change. Processes are not kept: a restore gives **fresh shells** at the recorded cwds, and every agent in them has to be resumed. The snapshot records each pane's foreground command **name** (`claude`, `codex`, `doppler`), never its arguments or the agent's conversation id.

Why servers die together:

- **The daemon runs under a systemd unit.** Every tmux server it started lives in the unit's cgroup, and the default `KillMode=control-group` kills them all when the unit stops: `rk daemon stop --force`, `systemctl restart`, an upgrade that restarts it. `KillMode=process` in the unit keeps them alive across restarts.
- **The host rebooted.** Nothing survives.

When the daemon dies **with** its servers, nothing observes the deaths: no `died` tombstone is written and `rk mux snapshot list` still reports `live`. Trust the socket, not the STATE column.

## 1. Find the dead servers

```sh
rk mux snapshot list --json | jq -r '.result[] | select(.audited_kill | not) | .server'   # has a snapshot
rk mux inventory --json | jq -r '.result.servers[].server'                                # alive now
```

Dead = in the first list, missing from the second (`inventory` lists live servers only). Leave out:

- `audited_kill: true` rows: killed through rk on purpose (`rk mux reap`, a UI kill), already filtered above.
- `rk-daemon`: the daemon recreates its own server on `rk daemon start`.
- Anything the user says is retired. When unsure, list the dead servers and ask before restoring.

Already restored from the UI's **Recovery** section? The layout is back and the agents are not: skip to step 4.

## 2. Pick the snapshot

```sh
rk mux snapshot show <server>                     # latest: session → window → pane  cwd  [command]
ls "${XDG_STATE_HOME:-$HOME/.local/state}/hexokit/snapshots/<server>/"   # history: <unix>.json, oldest first
rk mux snapshot show <server> --at <unix>         # one history entry
```

The latest is right when nothing touched the server after it died. If it was brought back once already (panes show `[zsh]` where agents ran), use the last history entry from **before** the kill: its `[claude]` panes are your work list.

History keeps 10 entries per server, and a running daemon snapshots every change, so a restored server's fresh shells push the pre-kill entry out within minutes. Copy that `<unix>.json` somewhere safe before you restore anything.

## 3. Restore the layout

```sh
rk mux snapshot restore <server>                  # add --at <unix> for a history entry
```

It refuses a server that is alive with sessions and touches nothing. The report names each window's former command (`was running: claude`). Restore one server at a time and keep each report.

## 4. Match each agent pane to its conversation

Snapshots carry no conversation id, so derive it. For Claude Code (other agents resume through their own mechanism):

```sh
# conversations a live claude still holds: never resume these twice
for f in ~/.claude/sessions/*.json; do kill -0 "$(basename "$f" .json)" 2>/dev/null && jq -r '"\(.sessionId) \(.cwd)"' "$f"; done
# candidates for one pane: transcripts under its cwd, newest first
cwd=/path/from/snapshot; ls -lt ~/.claude/projects/"$(printf %s "$cwd" | sed 's/[^A-Za-z0-9]/-/g')"/*.jsonl | head -5
# one candidate: first and last timestamp, first prompt
f=/path/to/transcript.jsonl; jq -r '.timestamp // empty' "$f" | sed -n '1p;$p'
jq -r 'select(.type=="user" and (.message.content|type)=="string") | .message.content' "$f" | head -c 300
```

- **One candidate** in that cwd not held by a live process: that is the pane's conversation. A transcript modified within seconds of the kill was open when it happened; an older one may still be an idle agent that was alive.
- **Several agents shared one cwd** (two windows in `$HOME`): match each transcript's first timestamp to the session's `created` time in `snapshot show`, and its first prompt to the window name and role.
- **No transcript**: that agent never received a prompt. There is nothing to resume.
- **Never `claude --continue`** where two agents shared a cwd: it picks the newest transcript there, and two windows end up on one conversation.

`~/.claude/sessions/` and `~/.claude/projects/` are Claude Code's own layout. Check them on the box before relying on them.

## 5. Resume one pane at a time

Get pane ids from `rk mux inventory --json -L <server>`, and skip the `_rk-ctl` session (role `control`; it is rk's own).

```sh
rk mux send -L <server> %N "claude --dangerously-skip-permissions --resume <uuid>"
rk mux await -L <server> --ready %N               # ready | parked (a wall) | narrow
rk mux send -L <server> %N --key Down --key Enter # only after reading a parked wall's snippet
```

- A shell pane has no agent state, so `send` warns `sending ungated` and delivers. That is expected.
- Resume with the launcher the pane ran. rk's default is `claude --dangerously-skip-permissions`; a worker spawned with other flags (model, permission mode, `-n <name>`) gets them back from whoever spawned it.
- A trust prompt for `$HOME` opens on **No, exit**: `Down` then `Enter` accepts. Judge each wall from its snippet; never answer one blind.
- A resumed agent loads its conversation and waits. It does nothing until prompted.

## 6. Before you prompt anyone

- **Read the agent's last turn first.** If its last tool call is what killed the servers (`rk daemon stop`, `daemon restart`, `brew upgrade`, `systemctl restart`, `kill-server`), it may run it again. Its first message from you says when the kill happened, that the daemon is back, and not to stop or restart it.
- **Workers belong to their operator.** Resume the operator or coordinator, tell it its worker panes are back, and let it choose which to resume. Never prompt a worker directly.
- **A window closed after the restore was closed on purpose.** Check `${XDG_STATE_HOME:-$HOME/.local/state}/hexokit/snapshots/<server>.closed/` for records newer than the restore before you recreate anything.
- **Non-agent commands** (`doppler`, tunnels, dev servers): the report names only the binary. Tell the user; never guess the arguments.

## 7. Verify and report

```sh
rk mux inventory --json | jq -r '.result.servers[] | .server as $s | .panes[] | "\($s) \(.session):\(.window_index) \(.command) \(.cwd)"'
```

Tell the user, per server and window: resumed `<uuid>`, left alone (and why), or not resumable (no transcript, non-agent command).

## Over MCP

An MCP client runs the same steps through this server's tools. Pass `server` to every pane tool: the MCP server has no pane of its own.

| Step | Tools |
|------|-------|
| 1. Find | `snapshot_list()` rows missing from `inventory()` |
| 2. Pick | `snapshot_show(server)`, or `snapshot_show(server, at)` for a history entry |
| 3. Restore | `snapshot_restore(server)` or `snapshot_restore(server, at)` |
| 4. Match | `send(server, target, message)` the step-4 commands into a restored shell pane, then `capture(server, target, lines)` |
| 5. Resume | `send(server, target, message)` the launch command, `await(server, target, ready)`, then `answer(server, target, key)` for a wall |
| 6. Read first | `capture(server, target, lines)` the resumed agent's screen before you send it anything |
| 7. Verify | `inventory(server)` |

No tool reads files, so anything in steps 2 and 4 that lists or reads files runs in a restored pane's own shell: `send` types the command, `capture` reads the output. A server that is still dead never needs a history entry (nothing touched it, so its latest is right), and one that is already alive has shell panes to run `ls` in.

## Before a planned update or restart

Record which conversation each pane holds, the one fact snapshots lack. Step 4 then becomes a lookup:

```sh
for s in $(rk mux inventory --json | jq -r '.result.servers[].server'); do
  tmux -L "$s" list-panes -a -F "$s #{pane_id} #{pane_pid}"
done | while read -r s pane pid; do
  [ -n "$pid" ] || continue
  for c in $(pgrep -P "$pid" -x claude); do
    echo "$s $pane $(jq -r '"\(.sessionId) \(.cwd)"' ~/.claude/sessions/"$c".json)"
  done
done > ~/agent-sessions-before-restart.txt
```
