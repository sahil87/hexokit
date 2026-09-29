# HexoKit skill: mux

Depth for one job: **driving panes from the substrate** — creating scratch tmux servers, delivering a message into another agent's tmux pane, waiting for its response, inspecting what a pane is showing, checking what runs in it, and removing it — from inside a tmux pane HexoKit manages. This is a static topic page (`rk skill mux`); the [core bundle](../skill.md) covers when to reach for HexoKit at all. Everything here is byte-identical on every invocation.

Gate first, as always — HexoKit is optional and may be absent:

```sh
command -v rk >/dev/null 2>&1 && [ -n "$TMUX_PANE" ] || exit 0
```

## `rk mux new` — create a scratch tmux server

```sh
rk mux new scratch1                    # detached server on socket scratch1
rk mux new scratch2 --ephemeral        # … and mark it @rk_srv_ephemeral 1
```

Creates a detached tmux server listening on socket `<name>` with one session named `<name>`, through HexoKit's server-birth path (sanitized environment, home-anchored CWD). This is the sanctioned way to create a scratch server — never improvise with raw `tmux -L <name> new-session`. `--ephemeral` marks the new server `@rk_srv_ephemeral 1` before the command returns: the server opts out of layout-snapshot coverage and into the `rk mux reap --ephemeral` bulk-cleanup sweep (the create/reap convention — scratch servers are created with `rk mux new <name> --ephemeral` and bulk-cleaned with `rk mux reap --ephemeral`). If the mark fails, the just-created server is killed — a `--ephemeral` invocation never leaves an unmarked server behind.

**Collision**: a live server already answering on `<name>` refuses (exit 1, nothing touched); a dead or stale socket proceeds. stdout carries exactly one report line: `created <name>`. Exit codes: 0 success, 1 operational (collision, tmux failure, mark failure), 2 usage. `--json` prints the receipt `{"report":"created","server","ephemeral"}` inside the standard envelope instead. The per-server layout-snapshot store behind the recovery flow is inspectable with `rk mux snapshot list [<server>] [--json]` — disk-derived, zero tmux probes; under `--json` the rows ride the envelope as `{"ok":true,"result":[{server, taken_at, died_at, audited_kill, sessions, windows, history_count}]}`, newest-first with `died_at: null` on the live latest and `[]` when the store is empty; the 10-row cap and `--all` are display-only, and `-L` is rejected (usage, exit 2) — the positional filter is the only server input.

## `rk mux send` — deliver a message to an agent

```sh
rk mux send %5 "summarize the diff and report back"   # pane target, literal message
rk mux send %5 - < prompt.md                          # multi-line payload via stdin
rk mux send @3 "hi"                                   # window target → its agent pane
rk mux send =work:editor "hi"                         # exact session:window
rk mux send %5 "yes, go ahead" --answer               # answer a WAITING agent's question
rk mux send %5 --key Enter                            # raw tmux key names (no paste/probe)
```

**Targets**: `%N` (pane), `@N` (window — resolves to the pane carrying `@rk_pane_agent_state`, falling back to the active pane), `=session:window` (exact). Bare `session:window` names are rejected (tmux resolves bare names against windows first — a window named like a session would hijack the target). `-L <server>` targets another tmux server (default: your own, from `$TMUX`).

**The gate** (reads the target's `@rk_pane_agent_state`):

| state | plain | `--answer` |
|-------|-------|------------|
| unknown (no/unparseable state) | warn + send — the warning names a non-shell foreground (… foreground process `htop` running; sending ungated) | warn + send (same naming) |
| `idle` | send | send |
| `waiting` | refuse | send — this send IS the answer |
| `active` | refuse | refuse — never interrupt a working agent |

`--force` skips the gate (existence still checked). Refusals name the state on stderr, exit 1. Every delivery — text paste and `--key` sends alike, including `--force` — first clears an active pane mode (probes `#{pane_in_mode}`, one `send-keys -X cancel`; a scrolled pane's copy-mode would otherwise eat the bytes — no manual `copy-mode -q` needed); a guard failure aborts before anything is delivered (exit 1).

**Delivery** is paste-probed: the text is pasted via a named buffer (bracketed paste — multi-line lands as one block), then Enter is sent ONLY after the paste provably echoed into the live input buffer. If that probe fails (e.g. a permission dialog swallowed the paste), no Enter is sent, the text stays staged in the composer, and the command exits 1 — **check the terminal before retrying; a resend would duplicate the staged text**. After Enter, the engine watches for a pane change. A frame that changes at any backoff step makes no claim either way and reports `delivered` (including a busy pane repainting for its own reasons); only a byte-identical frame through every step with the paste echo still present triggers bounded clear/retype/resubmit recovery. A recovered send also reports `delivered`. `unverified %N` means the engine detected non-submission and bounded recovery did not fix it; it exits 1 — **capture the pane before resending, because the message may or may not have landed and a resend may duplicate it**. `--no-enter` stages without submitting (report: `staged %N`).

**stdout is one report line**: `delivered %N` (a changed frame made no submit claim, or recovery re-delivered), `unverified %N` (detected non-submission remained after bounded recovery; exit 1), `staged %N` (`--no-enter`), `sent %N` (`--key`), or the await report word under `--await`. Diagnostics go to stderr. With `--json`, stdout instead carries exactly one envelope document: `{"ok":true,"result":{"report","target","server","enter","await"?}}` on success — the same report word inside `result`, `enter` true only for `delivered`, the `await` phase's receipt nested under `--await` — and `{"ok":false,"error":{"code","message","hint"?,"reason"?}}` on failure, with `reason` reusing the injection-outcome tokens (`probe_failure`, `staged_send_failure`, `submit_unverified`); the `unverified %N` line is suppressed (the fact travels as the reason) and exit codes are unchanged. Exit codes: 0 success, 1 operational failure (refusal, paste-probe failure, unverified submit, missing target), 2 usage.

## `rk mux await` — wait for an agent's state

```sh
rk mux await %5                          # block until the pane's agent is idle
rk mux await %5 --until idle,waiting     # wake on finish OR a question back
rk mux await %5 --file /tmp/result.json  # OR-compose a file-appearance signal
rk mux await %5 --ready                  # wait for BOOT: `ready %5 (state)`, `ready %5 (echo)`, `parked %5`, or `narrow %5 (54x14)`
rk mux await %5 --timeout 120            # give up waiting after 120s
rk mux await %5 --notify                 # Web Push yourself/the human on wake
```

**stdout is one report word**: the reached `--until` state (default `idle`), `file`, `running` (timeout expired — exit 0; the timeout bounds YOU, never the pane), or `gone` (the pane died — exit 1). With `--json`, stdout instead carries exactly one envelope document: `{"ok":true,"result":{"report","target"?,"elapsed_ms","detail"?,"hint"?}}` — the same word inside `result`, `target` omitted for the bare words `file`/`running`, `detail` only for `ready` (`state`/`echo`) and `narrow` (`WxH`), `hint:"call again"` on `running`; `gone` is `{"ok":false,"error":{"code":"operational","reason":"gone",…}}`, still exit 1. The first check runs before any sleep, so an already-fired signal returns immediately. An uninstrumented pane (no `@rk_pane_agent_state`) with no `--file` errors immediately — there is nothing to wait on.

`--after-active` requires observing `active` before an `--until` state counts — use it when awaiting a pane you just sent to OUTSIDE `rk mux send --await`, so the peer's pre-send `idle` doesn't end your wait instantly. `--ready` instead waits for a freshly spawned agent to finish BOOTING: the pane's agent state is present (its hooks fired — the TUI is up) or, for hook-less agents, a settled screen is classified by a sentinel echo probe — a harmless sentinel is pasted into the pane; an echo means a live input box (`ready %N (echo)`), and no echo on a settled non-blank screen means the pane is PARKED behind a wall — a trust dialog, survey, theme picker, or login wall that would eat a delivery. `parked %N` returns immediately (exit 0 — classification succeeded; it is a report, not a failure) with the screen snippet on stderr so YOU can judge what the wall wants and answer it with the standard write channel (`rk mux send --key Enter`, `--key Down`, …); rk never auto-answers a wall. The probe is gated on geometry: below the 80×20 readiness floor (either dimension — a bordered composer reflows or is not drawn at all) the pane classifies `narrow %N (WxH)` instead of probing — exit 0 with the geometry and remedy on stderr; resize or relocate the pane and re-run. Boot churn never returns: the wait blocks through it and ends only on `ready`, `parked`, `narrow`, `gone` (the pane died — exit 1), or timeout. `--ready` keeps the `running`/exit-0 timeout contract and is mutually exclusive with `--until`/`--file`/`--after-active`/`--any` (exit 2). The sentinel is typed only into PRE-DELIVERY panes (no agent state yet, nothing delivered) — against a live delivered worker readiness verbs are illegal; use `--until` / `capture`. Spawn-then-deliver for hook-less agents: `rk mux await --ready %5 && rk mux send --force %5 '<prompt>'` — plain `send` stays gated on agent state, which a hook-less pane never has, so `--force` is the documented pairing after a `--ready` wait; note `parked` and `narrow` also exit 0, so `&&`-composers must branch on the report word.

### Any-of fleet wait (`--any`)

```sh
rk mux await --any %1 %5 %9 --until waiting,idle --timeout 600
rk mux await --any %1 @3 =work:editor --until idle   # full target grammar per pane
rk mux await --any %1 %5 --file /tmp/result.json     # OR-composed, unchanged
```

With `--any` the observer watches one-or-more panes on the one resolved server and wakes on the FIRST to fire — block until any of several agents needs attention instead of polling each in turn. All flags compose unchanged. stdout stays ONE line with the report word first: `waiting %5`/`idle %2`/`active %9` (exit 0), bare `file` or `running` (exit 0), `gone %5` (exit 1). Two targets resolving to the same pane are a usage error (exit 2). Without `--any` exactly one target is required and the report stays the bare single word.

**Fleet-wake protocol** — what `--any` guarantees and what the caller (e.g. a monitoring agent) must do:
1. **Arm only against not-currently-waiting panes** (caller). rk does NOT filter already-waiting targets — an already-fired `--until` state returns immediately by design, so excluding them is the caller's job; a level-triggered re-arm against a still-waiting pane would busy-loop.
2. **The arm-gap is closed** (rk guarantee). The first sweep runs before any sleep, so a state that changed between your last read and the arm fires immediately.
3. **Re-arm after resume/`/clear`** (caller). Awaits are foreground children of the caller; a resumed session loses them and must re-arm.
4. **Kill + re-arm on target-set changes** (caller). The `gone %N` wake plus duplicate-target rejection make stale sets self-announcing.
5. **Debounce re-arms against waiting↔active flap** (caller). One invocation wakes once; wait a minimum interval before re-arming.

## Ask-and-wait in one call

```sh
rk mux send %5 "review this plan" --await                  # deliver, then block for idle|waiting
rk mux send %5 "review this plan" --await=idle --timeout 600
```

After the probe-gated Enter, the verb first watches for the peer to flip to `active` (bounded ~10s grace — closing the stale-state race), then awaits the state set (default `idle,waiting`). The final stdout line is the await report word. Each CLI call is a tool-use round trip — prefer this composed form over a separate `send` + `await`.

## `rk mux capture` — read a pane's screen

```sh
rk mux capture %5                 # last 50 lines, header + content
rk mux capture @3 --lines 200     # window target → its agent pane
rk mux capture %5 --raw           # captured text only, byte-identical
rk mux capture %5 --json          # JSON with metadata
```

Captures the last N lines of scrollback (`-l/--lines`, default 50) as **plain text — no ANSI escapes**; content is never trimmed. The default output is a header block:

```
--- pane %5 ---
cwd: /home/x/code/repo | agent: idle (5m)
---
<content>
```

The context line carries only substrate facts — the pane's cwd and its **reconciled** `@rk_pane_agent_state` (a stale or dead-pid value reads as absent) with a duration for every known state, `active` included (an aged `active` is how a lost idle write shows up); empty parts are omitted, and the line disappears when nothing resolved. `--json` emits `{"ok":true,"result":{"pane", "lines", "content", "cwd", "agent_state", "agent_state_duration"}}` (`agent_*` are `null` when uninstrumented). `--json` and `--raw` are mutually exclusive. A missing pane or tmux failure is exit 1 with tmux's diagnostic; bad targets/flags are exit 2. **`--classify`** (`rk mux capture %5 --lines 20 --classify --json`) answers "is this pane sitting on a prompt?" from the screen text alone — the fallback for a **hook-less pane**, whose `@rk_pane_agent_state` never flips to `waiting` when the agent asks something. It scans exactly the captured window (pass `--lines 20` for a tight tail), bottom-most line first, for seven mechanical indicator classes — `question_mark` (last line ends in `?`), `yes_no` (`[y/N]`, `(yes/no)`), `action_word` (`Allow?`/`Approve?`/`Confirm?`/`Proceed?`), `imperative_question` (`Do you want to…`/`Should I…`/`Would you like…`), `colon_prompt` (line ends in `:`), `enumerated_options` (`1) … 2) …`), `press_key` (`Press any key`/`hit enter`) — after two guards: a blank screen and a bare `>` turn-boundary prompt in the last two lines both mean "no question". The human output gains one `question:` header line — `question: yes_no — Proceed? [Y/n]` or `question: none (turn_boundary|blank_capture|no_indicator)`; `--json` gains a fixed-shape `"questions": {"indicator", "snippet", "reason"}` object inside `result` (`snippet` is `""` and `reason` non-null exactly when `indicator` is `none`; the key is absent without the flag). Any pane classifies regardless of agent state — candidate selection is the caller's policy — and **rk never answers what it finds**: a match is detection input, exit 0 either way. To respond, re-capture first (the screen may have moved), then use the write channel: `rk mux send %5 'y' --answer` for text, `rk mux send %5 --key Enter` / `--key Down` for keys. `--classify` and `--raw` are mutually exclusive (exit 2) — raw output is byte-identical to tmux by contract and carries no annotation.

## `rk mux kill` — remove a pane, gated

```sh
rk mux kill %12
rk mux kill %12 --force        # skip both gates (agent-state + protected server)
rk mux kill @3                 # window target → its agent pane
```

**Two gates**, both skipped by `--force` (target existence still validated). **Agent-state** (reads the target's reconciled `@rk_pane_agent_state`): `active` and `waiting` **refuse** — the refusal names the state on stderr, exits 1, and touches nothing (never kill a working agent, never drop a pane holding a pending human question); `idle` and uninstrumented panes are killed. **Protected server**: a pane on a protected server (`rk-daemon` by derivation, or any server marked `@rk_srv_protected 1`) is refused the same way — the refusal names the protected server on stderr. Success prints exactly one stdout line: `killed %N` (`--json` prints the receipt `{"report":"killed","target":"%N"}`). A missing pane or tmux failure is exit 1. `--force` is CLI-only — it is not exposed over the MCP `kill` tool.

## `rk mux process` — what runs in a pane

```sh
rk mux process %5
rk mux process %5 --json
```

Discovers the pane's process tree (the shell's `#{pane_pid}` and its descendants) and prints it as indented `PID comm [class]` lines under a `Pane %5 (PID 1234)` header, with a trailing `Agent process detected.` when an agent is present. Classification: `agent` when the comm basename — or the basename of either of the first two command-line tokens (the bounded fallback that catches node-hosted CLIs such as `gemini`; a third token never counts, so prompt text in argv is not evidence) — names an agent runtime: every `rk agent setup` registry binary and comm literal (`claude`, `codex`, `gemini`, `copilot`, `kimi`/`kimi-code`, `opencode`, `agy`) plus `claude-code`; `node`; `git` (`git`, `gh`); else `other` (tag omitted). **Agent-state cross-check**: when the pane's `@rk_pane_agent_state` carries a live pid, that tree node is `agent` regardless of comm (e.g. an agent behind a wrapper) — instrumentation beats heuristics. `--json` emits `{"ok":true,"result":{"pane", "pane_pid", "processes": [{pid, ppid, comm, cmdline, classification, children}], "has_agent"}}`.

## `rk mux panes` / `rk mux sessions` — server-wide enumeration

```sh
rk mux panes                 # one row per pane (aligned table; --json wraps the array: {"ok":true,"result":[…]})
rk mux sessions --all        # one row per session; default lists user-facing only, --all adds labeled infrastructure
```

The enumeration queries — no target argument; the two mux members that are not pane-scoped. `panes` lists every pane of every session exactly once; HexoKit's internal sessions (`_rk-pin-*` pin-sessions, `_rk-iso-*` iso sessions, the `_rk-ctl` anchor) are excluded, so a pinned or isolated window appears via its home session only. Rows carry **substrate facts only**: `session`, `session_id`, `window_index`, `window_id`, `window_name`, `window_active`, `pane`, `pane_index`, `pane_active`, `command`, `cwd`, `agent_state`, `agent_state_duration`, `has_agent` — in that order, `has_agent` last — and no change/stage fields (choreography enrichment is fab's layer). `agent_state`/`agent_state_duration` are `null` for uninstrumented panes; the duration is populated for every known state, `active` included — an `active` that keeps ageing with no stage or PR delta is the lost-write signal (the SPA renders it only for the two rest states). **`has_agent` is liveness, not instrumentation** — `agent_state` can hold a value after its agent exits (a legacy two-segment value has no pid to reconcile), so "is an agent process still in this pane?" is answered by `has_agent`, from the same pane-pid process-tree walk as `rk mux process` (comm/cmdline classification plus the agent-state pid cross-check). It is tri-state and lazy: when the foreground `command` is a shell (`sh` `bash` `zsh` `fish` `dash` `ksh` `tcsh` `csh` `nu`) the walk runs and yields `true` (an agent node in the tree) or `false`; a shell row whose walk failed (no pane pid, unreadable tree) is `null`; any other foreground (`node`, `claude`, `htop`, …) is skipped and `null` — not evaluated, not "no agent". Only a shell foreground leaves the question open (an agent TUI owning the tty is not a candidate for "exited"; a shell may be a wrapper over a live agent or what an exited agent left behind), so the walk cost is bounded to those rows. The consumer's exited predicate is `command is a shell && has_agent == false`; a `null` on a shell row is missing evidence and the consumer decides how to fail. The walk never fails the enumeration and writes nothing to stderr; `has_agent` is `--json`-only — the table's columns are unchanged. This row schema is the primary declaration of the pane identity-key contract fab's `fab pane map` re-emits (`pane` + `server` context and `window_id` are the identity keys; `session`/`window_index` are display columns).
`sessions` rows carry `name`, `role`, `attached`, `windows`, `path`, `grouped`. The role derives from the session **name** at request time — `user` for ordinary sessions; `pin` (`_rk-pin-*`), `iso` (`_rk-iso-*`), `control` (`_rk-ctl`), `operator` (`_rk-operator`), or `reserved` (any other `_rk-*` name — the prefix is HexoKit's reserved namespace, so filtering on `role != "user"` stays correct when new infrastructure kinds appear). By default only `user` sessions list — the candidate set an orchestrator picking a spawn target wants; `--all` shows everything labeled. Session-group copies fold onto their leader (one row, `grouped: true`), and `attached` counts real sized viewers credited to the leader — the dashboard's own control-mode attaches never inflate it. Both consume `-L <server>` (default: yours, from `$TMUX`); an alive server with nothing to list exits 0 (`"result": []` under `--json`); no server on the socket is exit 1 with tmux's diagnostic; a stray argument is exit 2.

## Gotchas

- All five pane-scoped verbs share the same target grammar — `%N`, `@N`, `=session:window` (bare `session:window` rejected) — and the same `-L <server>` flag (default: your own server, from `$TMUX`).
- Scratch-server convention: create with `rk mux new <name> --ephemeral`, bulk-clean with `rk mux reap --ephemeral`; never bare `tmux kill-server` — a bare `tmux kill-server` (no `-L`/`-S`) is refused machine-wide by the rk tmux guard shim — use `tmux -L <name> kill-server` for scratch servers (`rk mux guard` is the verb the shim execs). Protected servers (`rk-daemon` always; any server marked `@rk_srv_protected 1`) are skipped by `rk mux reap` unconditionally — even under `--ephemeral` or a prefix match (protected beats ephemeral) — and refuse `rk mux kill` without `--force`.
- `--answer` and `--force` are mutually exclusive on `send`, and `--await` cannot combine with `--no-enter` (nothing was submitted to wait on) — usage error, exit 2; say what you mean.
- `--key` sends key names raw (no paste, no probe — keys have no echo to verify).
- `send --await` on an UNINSTRUMENTED pane (no `@rk_pane_agent_state`): the message still delivers and `delivered %N` prints; the wait then applies its own rule — if the pane still has no state, the command errors "nothing observable to wait on" (exit 1). The delivery is never rolled back or hidden by a failed wait.
- `await --notify` fires on EVERY report — including `running` (timeout) and `gone` (pane died), not just a reached state. That is deliberate: you asked to be woken when the wait ends, however it ends.
- `await --any`: `gone %N` names the dead pane and exits 1 (armed panes get immediate death detection; re-arm minus the dead pane); a fired signal in the same sweep beats a death; an uninstrumented member fails the whole arm on the first sweep, exit 1; all targets share one `-L` server, and two targets resolving to the same pane are exit 2.
- The verbs talk to tmux directly from your context — no daemon dependency, so they work while `rk serve` is down.
- Waits are bounded by `--timeout` (default 300s, 0 = indefinite), never by an internal command budget — individual tmux reads carry their own short timeouts, the loop itself does not.
