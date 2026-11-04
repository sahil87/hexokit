# HexoKit skill: cron

Depth for one job: **scheduling a prompt for later or on a cadence** — durable, per-tmux-server cron entries whose fire types the prompt into a target agent's chat. This is a static topic page (`rk skill cron`); the [core bundle](../skill.md) covers when to reach for HexoKit at all. Everything here is byte-identical on every invocation.

Gate first — HexoKit is optional and may be absent:

```sh
command -v rk >/dev/null 2>&1 || exit 0
```

## What a cron entry is

An entry is **a prompt plus a schedule**, stored in the resolved server's intent file (`$XDG_STATE_HOME/hexokit/cron/<server>.yaml`). This is not a system cron: **nothing is ever executed**. At fire time rk types the prompt into the target agent's chat through the injection engine and presses Enter, exactly as if a person had typed it — to run a command, ask the agent to run it in the prompt text. A daemon ticker evaluates the entries; an occurrence the daemon was down for is logged `missed`, never fired late — except a `--cron` entry with `--catch-up once`, which fires once late after a gap.

Reach for it for **periodic checks** ("check on PR #123 every 30 minutes"), **idle nudges** ("if the build session has been quiet for 5m, ask it for a status"), **wall-clock reminders** ("remind me at 9am"), and wake-on-state work — the operator tick (the operator entry fab seeds on every tmux server) fires on a backoff keyed to the agents' idle epochs, so the operator reviews when agents finish instead of polling.

## `rk cron add` — one prompt, one schedule

```sh
rk cron add "check PRs" --every 1h
rk cron add "wake up" --idle-every 3m
rk cron add "tick" --backoff --min 2m --max 30m
rk cron add "standup" --cron "0 9 * * *" --catch-up once
rk cron add "operator tick" --backoff --min 3m --max 24m --wake-on agent-state-change --deliver skip-if-busy --role operator --if-absent respawn --respawn rk --respawn operator --respawn -L --respawn '{server}' --pinned
```

Exactly one schedule flag per entry:

- `--every <dur>` — a fixed interval (positive Go duration: `90s`, `1h`, `30m`).
- `--idle-every <dur>` — fire every `<dur>` of agent quiet: a flat backoff ladder whose count restarts on genuine activity (the clock's own deliveries never restart it).
- `--backoff [--min <dur>] [--max <dur>]` — a backoff ladder keyed on the target pane's idle epoch — resets on genuine activity, continues otherwise; `60s`→`30m` by default.
- `--cron "<expr>"` — a 5-field cron expression in the daemon's local time, validated at add time; `--catch-up once` opts into one late fire after a gap.

The wake flags add the reactive channel, OR'd with the schedule:

- `--wake-on agent-state-change` — the entry also fires on an actionable agent-state edge: a pane in scope going `waiting`/`idle` or vanishing (a pane going `active` never fires — an agent starting work needs nobody).
- `--wake-scope server` — the fingerprint scope (today only `server`).
- `--wake-debounce <dur>` (default `60s`) — hold the fire this long after the entry's own newest delivery; a burst coalesces into one fire. The knobs are a usage error without `--wake-on`. On `edit`, `--wake-on <event>` replaces the whole block and `--wake-on none` clears it.

`--name` defaults to a prompt prefix. Success prints `<id> <name> [<schedule> -> <target>]`; `--json` prints the receipt `{"id","name","schedule","target"}` (the same four fields, as the same strings).

## Targets: auto-capture down the ladder

Run inside a tmux pane, the target defaults down a ladder — your window's role when it carries any `@rk_win_role`, else your pane's agent session, else your own pane — and the creator is auto-captured (`$TMUX_PANE` + now). Explicit flags override (mutually exclusive):

- `--role <role>` — a server role (the `@rk_win_role` value, e.g. `operator`)
- `--session <ref>` — an agent session ref
- `--pane %N` — a pane id

**Outside tmux an explicit target flag is required** — a typed command must not guess a target.

## Delivery and absent-target policies

- `--deliver immediate|when-idle|skip-if-busy` (default `immediate`): `when-idle` holds the fire while the target pane's agent reads busy; `skip-if-busy` reads the state once at due time and drops a busy-pane fire (logged `skipped-busy`).
- `--if-absent skip|notify|respawn` (default `skip`): the disposition of a due fire whose target doesn't resolve. With `respawn`, repeat `--respawn <arg>` to give the command that brings the target back — one argv element per occurrence; the exact text `{server}` in any element is replaced with the entry's stamped server name at fire time. An argv is required for role and pane targets, optional for session targets (which default to resuming the closed session).

## Managing entries

```sh
rk cron list [--json]              # one row per entry: id, name, schedule, target, deliver, flags, last-fired
rk cron mute a3f9                  # indefinite mute (the evaluator skips its fires)
rk cron mute a3f9 --for 2h         # lease: muted until now+2h, resumes on its own
rk cron mute a3f9 --off            # unmute (clears flag and lease)
rk cron pin a3f9                   # exempt from orphan expiry; --off unpins
rk cron edit a3f9 --idle-every 3m  # replace one field in place, keeping id + history
rk cron rm a3f9                    # remove by id
```

`list` is disk-derived — zero tmux probes, so listing never resurrects a dead server; `--json` emits the same records as a JSON array inside the standard envelope (`{"ok":true,"result":[…]}`). `rm --json` prints `{"id","removed":true}` and `mute --json` prints `{"id","muted","until"?}` inside the same envelope — `until` (RFC 3339) only on a `--for` lease, `muted:false` on `--off`. `edit` REPLACES each field passed and keeps the rest; a bare `edit <id>` is a usage error. **Target and creator are immutable** — to retarget, `rm` + `add`. A schedule or deliver change logs a `rescheduled` line and resets the schedule's anchor; `--wake-on <event>` replaces the whole wake block and `--wake-on none` clears it, and either form logs no `rescheduled` line (wake_on carries no schedule anchor).

Every entry-file verb resolves one server via `-L/--server` — else your own server (from `$TMUX`), else `default`. `rk cron tick` runs one flock-guarded evaluation sweep across every live server (the debug invoker — the daemon ticks on its own, so `tick` rejects `-L`).

## Worked examples

```sh
# Check on PR #123 every 30 minutes and tell me if CI fails (targets this pane by auto-capture):
rk cron add "check on PR #123 with gh and tell me if CI fails" --every 30m

# Idle nudge to a specific session:
rk cron add "post a status line on where you are" --idle-every 5m --session 4fe2abc-1c3b-4f7e-9a2d-8b5c4e1f0a37

# A 9am wall-clock reminder, catching up once if the daemon was down:
rk cron add "morning standup soon — summarize what I have open" --cron "0 9 * * *" --catch-up once --role operator

# Mute the operator tick for 2h (the lease lapses on its own):
rk cron mute "$(rk cron list --json | jq -r '.result[] | select(.name == "operator tick") | .id')" --for 2h

# Move an entry to a new cadence:
rk cron edit a3f9 --every 2h
```

## Gotchas

- **A mute lease beats an indefinite mute** — `--for` writes `muted_until` and clears the flag; when the lease lapses the entry resumes with no write needed. An in-session loop that renews the lease each tick holds the entry back while it is alive.
- A plain `mute` clears any lease (indefinite wins); `mute --off` clears both.
- An entry whose target has vanished fires its `--if-absent` disposition and, unpinned, accrues an orphan streak toward expiry — `pin` the entries that must survive a closed session.
- Unparsable schedules fail at add time, not fire time; a `--cron` entry without `--catch-up` logs missed occurrences and waits for the next one.
