---
type: memory
description: "The `rk mux` family — 13 tmux-substrate verbs: messaging (`send`/`await`), pane mechanics (`capture`/`kill`/`process`, `panes`/`sessions`), server ops (`new`/`adopt`/`reap`/`snapshot`/`init-conf`/`guard`). Pane-scoped members share the strict %N/@N/=session:window grammar and consume inherited `-L` (server ops reject it); `await --any` wakes on the first of N panes, `--ready` classifies boot-readiness (`ready`/`parked`/`narrow`), `capture --classify` a pending prompt from screen text."
---
# Agent-to-Agent Messaging (`rk mux`)

**Domain**: run-kit

## Overview

`rk mux` is the tmux-substrate CLI family (per `docs/specs/cli-layering.md`):
operations that talk to tmux directly from the caller's context with **no daemon
dependency** (the `rk present` pattern), so they work while `rk serve` is down.
The family has thirteen members. The messaging pair is the conversation loop's
halves: `rk mux send` delivers a message into another agent's pane — the
agent→agent counterpart of `rk present`'s agent→user attach — and `rk mux await`
blocks until a peer's state (or a file signal) fires — under `--any`, until the
FIRST of several panes fires, and under `--ready` (a distinct, combinable-with-nothing
condition), until a freshly spawned pane is **boot-ready** — safe to type into. The substrate twins are
the generic pane-mechanics verbs: `rk mux capture` (scrollback capture with
substrate-only enrichment), `rk mux kill` (pane removal gated on agent state and server protection), and
`rk mux process` (the pane's process tree with agent classification). `rk mux
panes` and `rk mux sessions` are the server-scoped enumeration queries (no
target argument), substrate facts only (no change/stage; choreography
enrichment stays the fab layer's): one row per pane across all sessions, and
one row per session with its name-derived role. The
operator tier groups the create verb, the janitor/recovery/scaffold verbs, the
provenance verb, and
the guard: `rk mux new` (detached server creation on a named socket — the
family's create verb; `--ephemeral` marks the new server `@rk_srv_ephemeral`
before return), `rk mux reap` (test-socket and scratch-server cleanup — a prefix sweep,
unioned with every live `@rk_srv_ephemeral`-marked server under `--ephemeral`;
full contract in [tmux-sessions](/run-kit/tmux-sessions.md) § `rk mux reap`), `rk mux snapshot list|show|restore`
(layout recovery, [layout-snapshots](/run-kit/layout-snapshots.md)),
`rk mux init-conf` (scaffolds the rk-managed tmux.conf and the
`tmux.d/user.conf` override starter under `~/.config/hexokit/`), `rk mux adopt` (converts an
external tmux server to rk-managed — stamps `@rk_srv_managed` then sources the
managed conf, rolling the stamp back on a failed reload; idempotent, and the
bulk-migration path for rk-born servers that predate the stamp), and `rk mux guard` (fronts the real
tmux binary, refusing a bare `kill-server` — the verb the installed PATH shim
execs; full contract in [tmux-guard-shim](/run-kit/tmux-guard-shim.md)). The
pane-scoped verbs (send/await/capture/kill/process) are first-party readers of
the `@rk_pane_agent_state` convention ([agent-state](/run-kit/agent-state.md)) and
share the pane-level primitives in `internal/tmux/pane_target.go`. Delivery
reuses the hardened injection engine the daemon's compose-send route also drives
— the
shared `internal/inject` package ([agent-send](/run-kit/agent-send.md) § Send Path) — so the
daemon route and the CLI verb run ONE implementation. The MCP `send`/`answer` tools are argv
doors onto the same engine — one invocation of `rk mux send <target> -` with
the body on stdin for `send`, the `--answer`/`--key` forms for `answer` —
served by the `rk mcp` stdio server alongside the `await` tool
([mcp](/run-kit/mcp.md)); the tools' receipts are the verbs' `--json` envelope
documents (see the report-contract requirements). (260910-nuf6-rk-mcp-stdio)
(260911-i2vm-cli-send-await-receipts)

The family parent (`muxCmd`, `cmd/rk/mux.go`) presents the thirteen members in
three cobra command groups — *Messaging* (`send`, `await`), *Pane mechanics*
(`capture`, `kill`, `process`, `panes`, `sessions`), *Server ops* (`new`, `adopt`, `reap`,
`snapshot`, `init-conf`, `guard`) — registered in its `init()` with `GroupID`
stamped on the family instances only (see Design Decisions), so `rk mux -h`
renders no "Additional Commands" bucket (`TestMuxHelpPresentsThreeGroups` pins
the headings and the membership) (fvpu). Agent-facing docs split by altitude:
the `rk skill messaging` topic page teaches the channel matrix and the
readiness standard (concepts — which channel for write/read/wait, the
spawn-then-deliver composite, the `parked` scope rule), while `rk skill mux`
carries the verb-reference depth; the two pages cross-link rather than
duplicate. The family parent also carries the shared persistent
`-L/--server` flag (the `fab pane` pattern). Server resolution: `-L` wins, else
the caller's own server derived from the original `$TMUX` socket basename, else
`default`. Only the pane-scoped verbs and the `panes`/`sessions` enumerations consume it —
the operator members reject
an explicitly-set `-L` (see Requirements), **except `guard`**: its
`DisableFlagParsing` means nothing is parsed and `-L`/`-S` flow verbatim into
the tmux argv, where they are genuinely tmux's socket flags. The old root forms
(`rk reaper`, `rk snapshot …`, `rk init-conf`) survive as hidden deprecation
aliases that run byte-identically while printing cobra's deprecation pointer;
`rk tmux-guard` survives as a PERMANENT hidden root alias (never warns, never
removed — installed shims exec the literal name).

The four `--json` read verbs — `sessions`, `panes`, `capture`, `process` — emit
the standard rk JSON envelope (convention in [cli](/run-kit/architecture/cli.md)):
`{"ok":true,"result":<document>}` on success, with the verb's document nested
byte-for-byte under `result` (no key renames or reordering), and
`{"ok":false,"error":{"code":"usage"|"operational","message":…}}` on failure.
`ok` mirrors the exit code; exit codes are unchanged. Machine consumers read
`.result` (jq `.result[]`, not `.[]`). (260911-ehm2-cli-json-read-verbs)

## Requirements

### Requirement: Strict target grammar and agent-pane resolution
The pane-scoped verbs (send/await/capture/kill/process) SHALL accept exactly
three `<target>` forms — pane ID (`%N`), window
ID (`@N`), and exact session:window (`=session:window`) — rejecting everything
else as a usage error (exit 2) naming the accepted forms
(`tmux.ParsePaneTarget`). Bare `session:window` names are rejected: tmux's
target grammar resolves a bare name against window names before session names,
so a window named like a session would hijack the target (the `=` prefix forces
exact-match parsing). Window forms resolve server-side to the window's **agent
pane** (`tmux.ResolveAgentPane` / the pure `SelectAgentPane`): the pane carrying
a known post-reconcile `@rk_pane_agent_state` — preferring the active pane when
several qualify — falling back to the window's active pane (the
`sessions.ResolveAgentPane` precedent: a window target must route to the agent pane, not
whatever split happens to be active).

#### Scenario: Window target routes to the agent pane
- **GIVEN** `rk mux send mysession:win "hi"` (a bare name)
- **WHEN** the target parses
- **THEN** it is a usage error (exit 2) naming `%N`, `@N`, and
  `=session:window`; **AND GIVEN** `@3` whose pane `%7` carries
  `@rk_pane_agent_state`, **THEN** delivery targets `%7`.

### Requirement: `rk mux send` payload forms (XOR)
`rk mux send` SHALL take exactly one payload kind — a positional `<message>`,
the literal `-` (read the message from stdin, the `fab dispatch start`
precedent; bracketed paste delivers multi-line text as one block), or
one-or-more repeatable `--key <name>` flags (tmux key names: `Enter`, `Up`,
`C-c`, …). Zero payloads or mixed kinds is a usage error (exit 2). Text payloads
are sanitized at the CLI boundary via `inject.Sanitize` — the same helper the
daemon's compose-send handler runs — and an all-whitespace post-sanitize message is a usage
error. `--key` sends are post-gate raw `send-keys` key names — no paste, no
probe (key names have no echo to probe) — closing the raw-tmux carve-out that
key input otherwise forces on callers. They run the same pane-mode guard as
text sends (below) before the key send, through the same
`tmux.ClearPaneModeCtx` decision site — never a divergent copy.

#### Scenario: Multi-line stdin arrives as one paste
- **GIVEN** `rk mux send %5 -` with a multi-line heredoc on stdin
- **WHEN** the send runs
- **THEN** the full text lands as one bracketed paste; **AND GIVEN** both a
  positional message and `--key`, **THEN** usage error.

### Requirement: The agent-state gate
Before any delivery `rk mux send` SHALL read the target pane's facts via the
superset `tmux.PaneFactsCtx` — requesting both agent-state option names and
preferring the scope-named `@rk_pane_agent_state`, with the same parse +
pid-liveness reconcile the sessions path applies (a legacy two-segment or
dead-pid value reads as unknown, never partial trust); the one round trip also
carries the pane's foreground command (`PaneFacts.Command`) — and apply
fab-kit's `idleGate` matrix verbatim:

| State | plain | `--answer` |
|-------|-------|------------|
| unknown (absent/unparseable/reconciled-away) | warn to stderr + send | warn + send |
| `idle` | send | send |
| `waiting` | refuse | send (this send IS the answer it waits for) |
| `active` | refuse | refuse (never interrupt a working agent unattended) |

The unknown row's warning names the pane's foreground command when it is not a
plain shell (`tmux.IsShellCommand` — the ONE exported predicate over the shared
`shellCommands` set, never a duplicated list):

```
warning: pane %5 has no readable agent state — foreground process `htop` running; sending ungated
```

A shell foreground (or an empty/unparseable command) keeps the plain
`— sending ungated` warning verbatim. The behavior stays warn-and-send — no new
gate state: a non-shell foreground may be a hook-less agent, exactly the
documented `await --ready && send --force` composition's case. Refusals SHALL
name the state, print to stderr, and exit 1. `--force` skips the gate — no
state read, no warning — but still validates target existence, and its delivery
still runs the pane-mode guard (a delivery property, not a gate property).
`--answer` and `--force` are mutually
exclusive via cobra `MarkFlagsMutuallyExclusive` — a usage error (exit 2), not
silent force-wins precedence.

#### Scenario: Refusal names the state
- **GIVEN** a pane with `@rk_pane_agent_state=active:…`
- **WHEN** `rk mux send %5 "x" --answer` runs
- **THEN** it refuses naming `active`, exits 1, and performs no tmux mutation.

#### Scenario: Unknown state names a non-shell foreground
- **GIVEN** an uninstrumented pane whose foreground command is `htop`
- **WHEN** a plain `rk mux send %5 "x"` runs
- **THEN** stderr carries the foreground-naming warning and the send proceeds;
  **AND GIVEN** an uninstrumented `zsh` pane, **THEN** the warning is the plain
  no-state text with no foreground clause; **AND GIVEN** `--force`, **THEN** no
  state read and no warning at all.

### Requirement: Delivery through the shared injection engine
Text payloads SHALL be delivered through `internal/inject` — the engine the
compose-send HTTP handler also consumes ([agent-send](/run-kit/agent-send.md) § Send Path):
baseline capture → named-buffer `set-buffer -b <name> -- <text>` → bracketed
`paste-buffer -d -p` → NOVELTY echo probe → probe-gated Enter → post-Enter
observation. The CLI drives it through the six-method `inject.Tmux` interface
over `internal/tmux`'s
name-parameterized buffer primitives (`SetBufferCtx`/`PasteBufferCtx`/
`CapturePaneCtx`/`SendEnterToPaneCtx`/`SendKeysToPane`), with a **per-invocation buffer name**
`rk-send-<pid>` so a CLI send can never clobber a concurrent daemon send's
`rk-agent-send` buffer. `--no-enter` skips only the Enter — the probed text stays
staged in the composer. A probe failure (`inject.ProbeFailure`) sends no Enter,
prints the recoverable-state message (the text remains staged; a resend would
duplicate it) to stderr, and exits 1 — the compose-send 409's CLI analog.

Every delivery — text paste, `--key` sends, and `--force` sends alike — first
runs the **pane-mode guard**: probe `#{pane_in_mode}` and cancel an active mode
with one `send-keys -X cancel` (a scrolled pane's copy-mode would otherwise eat
the bytes or bind the keys). The probe-then-cancel decision lives in ONE site,
`tmux.ClearPaneModeCtx`; the engine consumes it as `inject.Tmux.ClearPaneMode`
(the first pane-touching step, inside the per-pane lock, BEFORE the baseline
capture — a mode cancel repaints the frame, so the baseline must follow it),
and the engine-bypassing `--key` branch calls it directly. A pane not in a mode
issues no cancel subprocess; one cancel, no re-probe loop. A probe or cancel
failure is a pre-delivery operational error (wrapped, exit 1 — nothing was
delivered), never fail-open.

After Enter, `SubmitBackoff` observes the pane at `40/80/160/320/640ms` with
early exit. A changed normalized frame makes no claim about submission and the
send succeeds. Only a frame unchanged through every step with the paste echo
still present is evidence of non-submission. That evidence permits one bounded
recovery cycle: send `C-u` up to four times until the normalized pane equals the
pre-paste baseline, re-paste, re-probe, send Enter, and observe over the first
three backoff steps. Recovery that cannot establish a baseline-equal clear or
cannot produce a changed frame returns `inject.SubmitUnverified`; the CLI prints
`unverified %N`, directs the caller to capture the pane before resending, and
exits 1. A successful recovery prints the ordinary `delivered %N` report.

#### Scenario: Permission-dialog pane fails closed
- **GIVEN** a pane showing a permission dialog (the paste never echoes)
- **WHEN** the probe exhausts
- **THEN** no Enter is sent, stderr carries the staged-text warning, and the
  exit is 1.

#### Scenario: A copy-mode pane is cleared before delivery
- **GIVEN** a pane scrolled into copy-mode (`pane_in_mode` = 1)
- **WHEN** `rk mux send %5 "x"` (or `--key Enter`) runs
- **THEN** the mode is cancelled before the baseline capture / key send and the
  delivery reaches the live composer; **AND GIVEN** a guard tmux failure,
  **THEN** the command exits 1 with the wrapped error and nothing is delivered.

#### Scenario: A trapped Enter is recovered only from positive evidence
- **GIVEN** a pane whose frame remains unchanged through every observation step
  with the paste echo still present
- **WHEN** the first Enter has no visible effect
- **THEN** recovery re-pastes only after `C-u` restores the pre-paste frame;
  **AND GIVEN** any observed frame change, **THEN** no recovery runs and the
  command reports `delivered` without claiming that submission was confirmed.

### Requirement: One-line stdout report contract; toolkit exit codes
`rk mux send` SHALL print exactly one report line to stdout: `delivered %N`
(no non-submission detected, including a changed-frame no-claim outcome or a
successful recovery), `unverified %N` (non-submission detected and bounded
recovery did not establish a safe successful outcome), `staged %N`
(`--no-enter`), `sent %N` (`--key` sends), or the await report word as the final
line when `--await` is used. `unverified` exits 1 and does not enter the await
phase. Diagnostics and warnings go to stderr (chatter honors `--quiet` via the
`outputSink` convention; the report line is data). Exit codes follow the toolkit
convention: **0** success, **1** operational failure (gate refusal, probe
failure, unverified submit, missing target, tmux failure), **2** usage — never
fab's pane-family 2/3 scheme. The same code convention binds the substrate
twins: a missing pane is operational (1), a bad target or flag combination is
usage (2).

Under `--json` stdout carries exactly one envelope document instead of the
report line (the `unverified %N` line is suppressed — the fact travels as the
error's `reason`): success is
`{"ok":true,"result":{"report":<word>,"target":"%N","server":"<name>","enter":<bool>}}`
with `enter` true only for `delivered` (a `--key` send is not the engine's
probe-gated Enter, even when the key is Enter); failure is
`{"ok":false,"error":{"code","message","hint"?,"reason"?}}` where `code` is
`usage` for the usage-error class (exit 2) and `operational` otherwise (exit
1), `message` is the same text stderr carries, and the three engine sentinels
reuse the `/send` route's 409 codes as `reason` with a machine-neutral `hint`:
`probe_failure` (`check the pane before resending; a resend would duplicate
the staged text`), `staged_send_failure` (`press Enter in the pane to
submit`), `submit_unverified` (`capture the pane before resending`); a
`waiting` gate refusal carries the hint `use --answer if this send is the
reply the agent waits for`. The error is still returned, so exit codes and
stderr are byte-identical to the text mode — `ok` mirrors the exit code by
construction. (260911-i2vm-cli-send-await-receipts)

### Requirement: `rk mux await` observer
`rk mux await [--any] <target>... [--until <state>[,<state>]] [--file <path>]
[--after-active] [--ready] [--timeout <secs>] [--notify[=msg]]` SHALL block until any
waitable signal fires, then print a one-line report and exit. Without `--any`
exactly one target is required; with `--any` one-or-more targets are accepted —
each uses the strict grammar and is resolved to a pane ID up front via
`resolvePaneTarget`, before the wait begins, all on the one resolved `-L`
server — and two targets resolving to the same pane ID are a usage error (exit
2). The observer wakes on the FIRST signal:

- a state in the `--until` set (default `idle`) was reached → report that state,
  exit 0 (`waiting` in the set reports `waiting` — the conversational wake);
  under `--any` the firing pane is appended (`waiting %5`)
- the `--file` path appeared (OR-composed) → `file`, exit 0 (bare — no pane)
- `--timeout` (default 300s; 0 = indefinite) expired → `running`, exit 0 — the
  timeout bounds the OBSERVER, never the pane (bare — no pane)
- the pane died mid-wait → `gone` on stdout, **exit 1** (toolkit
  operational-failure convention); under `--any` the FIRST dead target is named
  (`gone %N`) and wakes the whole wait — armed panes get immediate death
  detection

The report word stays the first stdout token in both modes, so first-token
parsers keep working. Contract details: the first check runs before any sleep
(an already-fired signal returns immediately); the file signal is checked before
the state reads so a fired signal wins over a mid-sweep pane death; the internal
poll tick is ~2s (not configurable); under `--any` each sweep reads the target
panes in listed order and the first `--until` match wins, while a death is
recorded but the sweep continues — a state signal found later in the same sweep
is reported instead of the death; an uninstrumented pane (no agent-state option — `@rk_pane_agent_state` or its legacy name — set)
with no `--file` errors immediately — nothing observable to wait on — under
`--any` failing the whole arm on the first sweep, naming the offending pane;
`--after-active` requires observing `active` at least once before an `--until`
state counts (the composable fix for the stale-state race when awaiting a pane
that was just sent to outside `rk mux send --await`) and is tracked PER PANE
under `--any` — one pane's activity never unlocks another's; `--notify[=msg]`
sends a fail-silent Web Push via the existing `rk notify` path when a signal
fires (default message `agent <target> is <report>`; under `--any`,
`agent %N is <state>` when a pane fired — including `agent %N is gone` — and
`await --any is <report>` for `file`/`running`). The observer loop rides the
caller's parent context with only per-read timeouts (`awaitCmdTimeout` 5s) on
individual tmux reads, so a wait can outlive any single read by minutes.

Under `--json` the report travels as exactly one envelope document instead of
the line: success is
`{"ok":true,"result":{"report":<word>,"target":"%N"?,"elapsed_ms":<int>,"detail":"…"?,"hint":"…"?}}`
— `target` omitted for the bare words `file`/`running` (under `--any` it is
the firing pane), `elapsed_ms` the observe-phase wall time measured after
target resolution, `detail` only for `ready` (`state`/`echo`) and `narrow`
(`WxH`) — and `running` stays a success (`ok:true`, exit 0) carrying
`hint:"call again"`. `gone` is
`{"ok":false,"error":{"code":"operational","reason":"gone",…}}` with exit 1
(the pane is named in the message, never the error object); an uninstrumented
pane with no `--file` is operational without a reason; in-`RunE` usage errors
are `code:"usage"`, exit 2. `--notify` composes unchanged, and the text mode
is byte-identical without the flag. (260911-i2vm-cli-send-await-receipts)

**`--ready` is the boot-readiness condition** — a single-pane wait (no `--any`)
for the moment a freshly spawned agent is safe to type into, driven by
`inject.AwaitReady` ([agent-state](/run-kit/agent-state.md) § Boot-Ready Signal).
**State-present** is checked first every poll: the reconciled
`@rk_pane_agent_state` exists (hooks fired, so the TUI is up) → `ready %N
(state)`, exit 0 — the sentinel is therefore only ever typed into a pane with
no reconciled agent state. For hook-less agents a **settled screen is the probe
trigger, not a verdict**: when no state appears and the capture is non-blank
and byte-identical across two consecutive polls, the settle first reads the
pane geometry once (`inject.Tmux.PaneSize` → one `display-message -pt` of
`#{pane_width}`/`#{pane_height}`) — below the readiness floor
(`inject.ReadyMinCols`/`inject.ReadyMinRows`, 80×20, either dimension) a
bordered composer reflows or is not drawn at all, so an echo miss would carry
no information and the pane classifies **`narrow %N (WxH)`, exit 0** instead of
probing, returned immediately (narrow is wake-worthy like parked) with the
geometry and the resize/relocate remedy on stderr; a geometry read failure is
"not yet" (no probe that settle; an `IsGone` match ends the wait as `gone`,
exit 1). At/above the floor a sentinel echo probe
classifies the pane — the probe is a delivery path, so it first runs the
pane-mode guard (`inject.Tmux.ClearPaneMode`; a scrolled copy-mode pane shows a
static frame that settles, then eats the paste — reading as parked without the
guard) and re-checks the frame against the settled baseline, re-entering
polling on a repaint (the cancel invalidated the baseline); then the fixed
comment-safe sentinel `#rk-ready-probe` is
pasted through the named-buffer primitives (`SetBuffer`/`PasteBuffer`,
bracketed paste, never submitted — no Enter anywhere on the path), an echo is
detected by **novelty counting** (occurrence count strictly above the pre-probe
baseline, so a stale same-text occurrence on screen cannot satisfy the probe),
and the composer is cleared with `C-u` verified against the settled baseline —
settle, probe, and clear captures all share the one `readyCaptureLines` depth
(`clearToBaseline`). Echo → `ready %N (echo)`, exit 0. No echo on a screen
still settled and non-blank → **`parked %N`, exit 0**, returned immediately
(parked is wake-worthy — the caller must act, so it does not spin to the
deadline) with the screen snippet on stderr so the caller can judge what the
wall wants; classification is rk's, judgment stays caller-side. A pane death
mid-wait (a capture error matching the injected gone predicate — the CLI wires
the "can't find pane" mapping) → `gone`, exit 1. Boot churn, blank screens, and
probe infrastructure errors never classify — they re-enter polling bounded by
the deadline. `--ready` is **mutually exclusive with `--until`/`--file`/
`--after-active`/`--any`** (usage error, exit 2 — mixing conditions has no
coherent semantics). The family's timeout contract holds: `--timeout` expiry
reports `running`, exit 0 — with one refinement, a `--timeout 0` (indefinite)
wait **re-arms** the primitive's internal 25s deadline after each `ErrNotReady`
pass only — `parked`, `narrow`, and `gone` break the loop. `--notify` fires on every
report including `parked`, `narrow`, and `gone`, fail-silent (default `agent %N is <first
report token>`). **Scope rule**: the sentinel is typed only into pre-delivery
panes (no agent state yet, nothing delivered) — rk enforces the state-absence
half mechanically (state is checked before every probe); the nothing-delivered
half is documented caller policy, and against a live delivered worker readiness
verbs are illegal — use `await --until` / `capture`. The readiness wait is the CLI surface of the
spawn-then-deliver composite; for hook-less agents the documented composition is
`rk mux await --ready %5 && rk mux send --force %5 '<prompt>'` — plain `send`
stays gated on agent state, which a hook-less pane never has, so `--force` is
the pairing (no new send gate mode). `parked` and `narrow` also exit 0, so `&&`-composers
must branch on the report word.

The readiness→report mapping itself is one shared helper (`mapReadyReport` in
`cmd/rk/mux_await.go` — word + pane form, the ungated stderr diagnostic for
the parked/narrow verdicts, the exit-classifying error for `gone`) consumed by
both `rk mux await --ready` and `rk tab new --ready` (wzve): the word
vocabulary and this verb's stdout/stderr/exit contract are the single mapping;
`rk tab new --ready` carries the word as the `ready` key of its `--json`
envelope instead of a bare stdout line, and its probe is legal by construction
(the pane was created by that very call — nothing has been delivered to it).

The fleet-wake protocol monitoring agents build on (rk guarantee vs caller
obligation): (a) the CALLER arms only against not-currently-waiting panes — rk
does not filter already-waiting targets; an already-fired `--until` state
returns immediately by design, so a level-triggered re-arm against a
still-waiting pane would busy-loop; (b) the first-sweep-before-sleep property
closes the arm gap — a state that changed between the caller's last read and
the arm fires immediately (rk guarantee); (c) the CALLER re-arms after
resume/`/clear` — awaits are foreground children of the caller; (d) the CALLER
kills and re-arms when the target set changes — the `gone %N` wake plus
duplicate-target rejection make stale sets self-announcing; (e) the CALLER
debounces re-arms against waiting↔active flap — one invocation wakes once, so
inter-wake spacing is the re-armer's property.

#### Scenario: Already-fired signal returns immediately
- **GIVEN** an already-idle instrumented pane
- **WHEN** `rk mux await %5` runs
- **THEN** `idle` prints with no sleep; **AND GIVEN** `--after-active` on that
  same pane, **THEN** the observer keeps waiting until an active→idle
  round-trip is seen.

#### Scenario: Any-of wake names the firing pane
- **GIVEN** `rk mux await --any %1 %5 --until waiting,idle` with `%1` active
  and `%5` already idle
- **WHEN** the first sweep runs
- **THEN** `idle %5` prints with no sleep, exit 0; **AND GIVEN** `%1` dies
  mid-wait with no signal firing that sweep, **THEN** `gone %1`, exit 1;
  **AND GIVEN** two targets resolving to the same pane ID, **THEN** usage
  error, exit 2.

#### Scenario: Boot-ready wait reports the classification
- **GIVEN** a freshly spawned pane whose hooks stamp agent state during boot
- **WHEN** `rk mux await --ready %5` runs
- **THEN** `ready %5 (state)` prints, exit 0; **AND GIVEN** a hook-less agent
  whose screen settles at a live input box, **THEN** the sentinel echoes and
  `ready %5 (echo)` prints, exit 0; **AND GIVEN** a hook-less agent settled
  behind a wall that never echoes (a trust dialog, survey, or login wall),
  **THEN** `parked %5` prints with the screen snippet on stderr, exit 0;
  **AND GIVEN** a settled hook-less pane below the 80×20 readiness floor in
  either dimension, **THEN** `narrow %5 (54x14)` prints with the geometry and
  remedy on stderr, exit 0, and no probe runs;
  **AND GIVEN** the pane dies mid-wait, **THEN** `gone` prints, exit 1; **AND
  GIVEN** `--ready --until idle`, **THEN** usage error, exit 2.

### Requirement: Composed ask-and-wait (`rk mux send --await`)
`--await[=<states>]` (default `idle,waiting`) SHALL, after a successful submit,
first watch for the pane's state to flip to `active` under a bounded grace
(`sendAwaitActiveGrace`, ~10s) and only then run the await observer with the
requested state set, printing the await report word as stdout's single final
line. The grace watch closes the stale-state race — a bare await fired
immediately after a send would otherwise return instantly on the peer's
*pre-send* `idle`. Two grace outcomes fall through to the await rather than
ending the composition: grace expiry (`running` — hooks may lag, or the peer
finished within the grace) and the uninstrumented verdict (the pane carries no
agent-state option — `@rk_pane_agent_state` or its legacy name — set; the
delivery already happened, and the await phase re-applies
the uninstrumented rule itself in case state appeared in the meantime). A `gone`
verdict propagates as the final report (stdout) with exit 1. `--await` with
`--no-enter` is a usage error (nothing was submitted to wait on). `--timeout`
bounds the await phase (observer only); the one-shot delivery phase runs under
its own 5s `muxCmdTimeout` while the await rides the parent context, so the
full `--timeout` is reachable.

Under `--json --await` the delivery receipt keeps its `report` and nests the
await phase's receipt under `result.await` (its `elapsed_ms` measures the
whole await phase — grace watch plus observer). A `gone` after a successful
delivery is `ok:false` with `reason:"gone"` and the hint `the message was
delivered before the pane died`, exit 1; an await that cannot start (e.g. an
uninstrumented pane) is `ok:false` with the await error as the message and the
hint `delivered; the wait could not start`, exit 1.
(260911-i2vm-cli-send-await-receipts)

#### Scenario: Ask-and-wait in one call
- **GIVEN** `rk mux send %5 "question" --await --timeout 120`
- **WHEN** the peer answers within budget
- **THEN** stdout ends with `waiting %5` or `idle %5`; **WHEN** not, **THEN**
  `running %5`, exit 0.

### Requirement: `rk mux capture` — plain scrollback with substrate-only enrichment
`rk mux capture <target> [-l/--lines <N>] [--json | --raw] [--classify]` SHALL
capture the last N lines of the resolved pane's scrollback as **plain text — no
`-e` ANSI escapes** — via `tmux.CapturePanePlainCtx` (the `-e` `CapturePaneCtx` variant
stays untouched for the chat echo probe), never trimming the content. `--lines`
defaults to 50; `< 1` is a usage error. `--json` and `--raw` are mutually
exclusive via `MarkFlagsMutuallyExclusive`; `--raw` prints the captured text
only, byte-identical to tmux's output. The default human output is the header
block `--- pane %5 ---` / context line / `---` / content; the context line joins
only the parts that resolved (` | `-separated) and is omitted entirely when
empty. Enrichment is **substrate-only**: the pane's cwd (`#{pane_current_path}`)
and the **reconciled** agent state, both read in one `display-message` round
trip by `tmux.PaneFactsCtx` (the parse + pid-liveness reconcile shared with
`PaneAgentState`; a legacy or dead-pid value reads as unknown) — fab's
change/stage fields are NOT carried (choreography facts, fab's layer). The
duration shows for any known state with epoch > 0 — `idle`, `waiting`, **and**
`active` (the age of a live `active` is the only downstream staleness signal for
a lost write),
formatted floor `Ns`/`Nm`/`Nh` via `sessions.FormatAgentDuration` (the
`rollupAgentState` semantics). Under `--json` the envelope's `result` document
carries (two-space-indented):
`{"pane", "lines", "content", "cwd", "agent_state", "agent_state_duration"}`
with the agent fields `null` when the pane is uninstrumented. A missing pane or
tmux failure is operational (exit 1) carrying tmux's stderr diagnostic.

**`--classify`** adds a pending-prompt classification of the captured text via
`promptscan.Scan` (`internal/promptscan` — pure text, no tmux/exec): guards
first (blank content → `blank_capture`; a bare `^\s*>\s*$` Claude turn-boundary
prompt in the last two lines → `turn_boundary`), then a bottom-most-first walk
of the non-empty lines testing class `question_mark` (last line only: ends in
`?`, `< 120` chars, no `#`/`//`/`*`/`>` opener, no leading timestamp) and, on
every line in order, `yes_no` (`[y/n]`/`(y/n)`/`(yes/no)`, case-insensitive),
`action_word` (`\b(Allow|Approve|Confirm|Proceed)\?`), `imperative_question`
(`Do you want to`/`Should I`/`Would you like`), `colon_prompt` (trailing `:`),
`enumerated_options` (`[1-9]\)`), `press_key` (`Press.*key`/`press.*enter`/
`hit.*enter`); the first matching line wins and is the snippet verbatim; no
match → `none`/`no_indicator`. Class and reason identifiers are the cross-tool
contract shared verbatim with fab-kit's `fab pane questions`. The verb applies
**no agent-state gate** — any resolvable pane classifies, `active` and
uninstrumented included — and never answers what it finds; `none` is a report,
so exit stays 0. It scans exactly the captured `--lines` window (fab passes
`--lines 20`). `--classify` and `--raw` are mutually exclusive (usage, exit 2)
— raw output is byte-identical by contract. Human output gains exactly one
header line after the context line (or directly after `--- pane %N ---` when
that line is omitted): `question: {indicator} — {snippet}` or `question: none
({reason})`. Under `--json` the `result` document gains a `questions` object as the trailing key — present
**only** under `--classify`, so the six-key shape is otherwise byte-identical —
with fixed keys `indicator` (class name or `none`), `snippet` (`""` when none),
`reason` (`null` when matched, else the reason).

#### Scenario: Reconciled state with duration, no choreography fields
- **GIVEN** a pane whose `@rk_pane_agent_state` is `waiting:<epoch 2m ago>:<live-pid>`
- **WHEN** `rk mux capture %5` runs
- **THEN** the context line contains `agent: waiting (2m)` and no
  `change:`/`stage:` parts; **AND GIVEN** a dead-pid value, **THEN** no
  `agent:` part appears (reconciled to unknown).

#### Scenario: Classify reports a pending prompt on a hook-less pane
- **GIVEN** an uninstrumented pane whose last screen line is `Overwrite file [y/N]`
- **WHEN** `rk mux capture %5 --lines 20 --classify --json` runs
- **THEN** the `result` document ends with `"questions": {"indicator": "yes_no", "snippet":
  "Overwrite file [y/N]", "reason": null}` and exit is 0; **AND GIVEN** the last
  two lines are `done` / `>`, **THEN** `questions` is `{"indicator": "none",
  "snippet": "", "reason": "turn_boundary"}`; **AND WHEN** `--classify --raw` is
  passed, **THEN** exit is 2 and nothing is captured.

### Requirement: `rk mux kill` — gated pane removal
`rk mux kill <target> [--force]` SHALL refuse through two gates before killing,
both evaluated against the resolved `-L` server scope and both skipped by
`--force` (target existence is still validated via `tmux.PaneExists`):

1. **Protected-server gate** (checked first): a pane residing on a protected
   server — the derived daemon server `rk-daemon`, or any server marked
   `@rk_srv_protected` — is refused. The predicate is `tmux.IsGuardedServer` (the
   daemon name short-circuits before any tmux read), reached through the
   `muxKillGuardedServerFn` seam; a failure reading the protection state is
   operational (`read server protection: …`).
2. **Agent-state gate**: the resolved pane's reconciled `@rk_pane_agent_state`
   (through the same new-wins dual-read as the send gate):

| State | plain | `--force` |
|-------|-------|-----------|
| `active` | refuse | kill |
| `waiting` | refuse (a pending human question lives there) | kill |
| `idle` | kill | kill |
| unknown (absent/unparseable/reconciled-away) | kill | kill |

Refusals SHALL name the reason — the protected server or the agent state —
print to stderr, exit 1, and perform no tmux mutation. The kill runs through
`tmux.KillPaneCtx` (`kill-pane -t
%N`) — unlike the best-effort `KillActivePane`, a tmux failure IS returned so
the verb can surface tmux's stderr. On success stdout carries exactly one
report line — `killed %N` — or, under `--json`, exactly one envelope document
`{"ok":true,"result":{"report":"killed","target":"%N"}}` (the family's `--json`
opt-in changes only what stdout carries; the gates, exit codes, and stderr are
unchanged, and a failing RunE gets its `{"ok":false}` envelope from `execute()`'s central writer —
see [mcp](/run-kit/mcp.md) § Design Decisions). A missing pane or tmux kill
failure is operational (exit 1). (260911-fr5t-cli-spawn-and-steer-receipts)

#### Scenario: Refusal names the state and touches nothing
- **GIVEN** a pane with `@rk_pane_agent_state=active:<epoch>:<live-pid>`
- **WHEN** `rk mux kill %5` runs
- **THEN** it refuses naming `active`, exits 1, and the pane survives; **AND
  WHEN** `rk mux kill %5 --force` runs, **THEN** the pane is killed and stdout
  is `killed %5`.

#### Scenario: Protected-server refusal names the server
- **GIVEN** a pane on a server marked `@rk_srv_protected`
- **WHEN** `rk mux kill %5` runs
- **THEN** it refuses naming the protected server, exits 1, and the pane
  survives; **AND WHEN** `rk mux kill %5 --force` runs, **THEN** both gates
  are skipped and stdout is `killed %5`.

### Requirement: `rk mux process` — process tree with agent-state pid cross-check
`rk mux process <target> [--json]` SHALL resolve the pane's shell PID
(`#{pane_pid}` via `tmux.PanePIDCtx`) and discover its process tree — **linux**:
a `/proc` walk (`comm`, NUL-joined `cmdline`, children via
`/proc/<pid>/task/<tid>/children`, unreadable children skipped); **darwin**: a
two-pass `ps` (one `pid,ppid,comm -ax` enumeration plus one `pid=,args=` cmdline
pass joined by PID — TOCTOU-free; a PID missing from the cmdline pass degrades
to `""`), with the pure `parsePSCmdlines` parser in an un-tagged file so it
unit-tests on every platform. Classification (`classifyProcess(comm, cmdline)`):
`agent` when the comm basename — or the basename of either of the **first two**
cmdline tokens (a bounded fallback that catches node-hosted CLIs such as
`gemini`; a third token never counts, so prompt text in argv is never liveness
evidence) — is in the agent name set, which is **derived from the agent setup
registry** (`agentRuntimes()`: every runtime's `binary` and `comm` literal —
`claude`, `codex`, `gemini`, `copilot`, `kimi`/`kimi-code`, `opencode`, `agy` —
plus `claude-code`, minus `node`, so a bare `node` stays `node`); `node` for
`node`; `git` for `git`/`gh`; else `other`. Additionally, when the pane's reconciled
`@rk_pane_agent_state` carries a live pid (3-segment value), the tree node with that
PID SHALL be classified `agent` regardless of comm — the instrumentation is
authoritative, comm heuristics are fallback; a failed state read degrades to
comm-only with a stderr warning. `has_agent` is true iff any node classifies
`agent` by either route. The discover → pid-cross-check → `hasAgentInTree` core
is the single helper `paneHasAgent(ctx, pid, agentPID)` (discovery through the
`muxProcessDiscoverFn` seam), shared with the `rk mux panes` row field below —
`process` prints the tree it returns, `panes` consumes only the bool. Human
output: `Pane %5 (PID 1234)` plus indented
`PID comm [class]` lines (the tag omitted for `other`) plus a trailing
`Agent process detected.` when `has_agent`. Under `--json` the envelope's
`result` document is (two-space-indented):
`{"pane", "pane_pid", "processes": [{pid, ppid, comm, cmdline, classification,
children}], "has_agent"}`.

#### Scenario: Instrumented agent behind a wrapper comm
- **GIVEN** an agent launched through a wrapper whose comm is `my-wrapper`, with
  `@rk_pane_agent_state=active:<epoch>:<that-pid>` (or the legacy name — the dual-read accepts either)
- **WHEN** `rk mux process %5` runs
- **THEN** that node is tagged `[agent]` and `Agent process detected.` prints.

### Requirement: `rk mux panes` — whole-server enumeration, substrate facts only
`rk mux panes [--json]` SHALL enumerate every pane of every session on the
resolved server — one row per pane, with **no positional target** (an
enumeration query, not a pane-scoped verb; a stray argument is usage, exit 2).
It consumes the family's inherited `-L/--server` with the standard resolution
order (`-L` wins → the caller's `$TMUX` socket basename → `default`) and, being
a query against a server, does NOT call `muxRejectInheritedServerFlag`.
Enumeration reuses `tmux.ListSessions` + `tmux.ListWindows` (whose panes already
carry the reconciled agent-state value via the `paneFormat` new-wins dual-read —
see [agent-state](/run-kit/agent-state.md)) through the `parseSessions` chokepoint,
so `_rk-pin-*` pin-sessions, `_rk-iso-*` isolated relay sessions and the `_rk-ctl`
anchor contribute no rows and a pinned or isolated window lists exactly once, via its home
session. Rows carry **substrate
facts only** — no change/stage/display-state keys (choreography enrichment is
the fab layer's job, per cli-layering Part 8). The default output is an aligned
one-pane-per-row table (session, window `index:name`, pane ID, active markers,
agent state + duration, command, cwd) on stdout; diagnostics go to stderr.
Under `--json` the envelope's `result` is a two-space-indented array, one
object per pane, with exactly
`session`, `session_id`, `window_index`, `window_id`, `window_name`,
`window_active`, `pane`, `pane_index`, `pane_active`, `command`, `cwd`,
`agent_state`, `agent_state_duration`, `has_agent` — in that order, `has_agent`
last so the preceding key set is byte-stable for prefix decoders (fab's
`rkPaneRow`); the agent fields are `null` when the pane
is uninstrumented or the reconciler rejects the value (the `mux capture --json`
semantics), and the duration appears for any known state with epoch > 0 —
`active` included, so the fab operator can apply an "active for Nm with no
stage/PR delta" staleness rule — formatted via `sessions.FormatAgentDuration`. **`has_agent` is
liveness, not instrumentation** — a tri-state `*bool` computed lazily by the
`paneHasAgent` walk (the `rk mux process` walk above, comm/cmdline classification
plus the agent-state pid cross-check): the walk runs only for rows whose
foreground `command` is a shell (`tmux.IsShellCommand` — `sh bash zsh fish dash
ksh tcsh csh nu`) AND whose `PanePID` is non-zero, yielding `true` when the tree
holds an `agent` node, else `false`; a shell row whose walk failed (`PanePID`
0, discovery error) is `null`; every non-shell row is `null` — "not evaluated",
never "no agent". The walk root and cross-check pid ride the enumeration's
existing `list-panes` call (`paneFormat` field 11 `#{pane_pid}` →
`PaneInfo.PanePID`; the reconciled agent pid → `PaneInfo.AgentPID`; both
`json:"-"`, so the dashboard `/ws/state` payload is unchanged) — no per-row
tmux round trip. A failed walk never fails the enumeration and writes nothing
to stderr; the consumer's exited predicate is `IsShellCommand(command) &&
has_agent == false`, and a `null` on a shell row is missing evidence for the
consumer to judge. The default table has no `has_agent` column. This row
schema is the primary declaration of the pane identity-key contract fab's
`fab pane map` re-emits (`pane` + `server` context and `window_id` are the
identity keys; `session`/`window_index` are display columns). Exit codes follow
the toolkit convention: **0** success — including an alive server with nothing
to list (`"result": []` under `--json`; an empty enumeration is liveness-probed via
`tmux.ServerAlive` to separate "alive, empty" from "no server"); **1**
operational (no server on the resolved socket, tmux failure) carrying tmux's
diagnostic on stderr; **2** usage.

#### Scenario: Empty enumeration succeeds; a dead socket is operational
- **GIVEN** an alive server with no sessions
- **WHEN** `rk mux panes --json` runs
- **THEN** the envelope's `result` is `[]` and exit is 0; **AND GIVEN** no server on socket
  `nope`, **WHEN** `rk mux panes -L nope` runs, **THEN** exit is 1 with tmux's
  diagnostic on stderr; **AND GIVEN** a stray positional argument, **THEN**
  exit 2.

#### Scenario: `has_agent` answers only where a shell owns the tty
- **GIVEN** a `zsh`-foreground pane whose tree holds a `claude` child, a
  `zsh`-foreground pane whose tree holds only `git`, a `node`-foreground pane,
  and a `fish`-foreground pane whose `/proc` walk fails
- **WHEN** `rk mux panes --json` runs
- **THEN** the rows read `has_agent` `true`, `false`, `null`, `null`
  respectively, exit is 0, and stderr is empty.

### Requirement: `rk mux sessions` — session enumeration with derived roles
`rk mux sessions [--json] [--all]` SHALL enumerate the sessions of the resolved
server — one row per session, no positional target (an enumeration query like
`panes`; a stray argument is usage, exit 2), consuming the family's inherited
`-L/--server` without `muxRejectInheritedServerFlag`. Each row carries `name`,
`role`, `attached`, `windows`, `path`, `grouped` — substrate facts only. The
role derives from the session NAME at request time via `tmux.SessionRole`
(never a stamped option): `user`, or the infrastructure kinds `pin`
(`_rk-pin-*`), `iso` (`_rk-iso-*`), `control` (`_rk-ctl`), `operator` (`_rk-operator`), and
`reserved` (any other `_rk-*` name — see
[tmux-sessions](/run-kit/tmux-sessions.md) § Session Role Taxonomy). The
default listing is `role: user` rows only — the spawn-candidate set an external
orchestrator (fab's operator) consumes, and the same rows drive `rk tab new`'s
default-session resolution in-process: an infrastructure-session caller's
landing session is picked from them in this enumeration order (see
[tmux-sessions](/run-kit/tmux-sessions.md) § Session Role Taxonomy) (xga4);
`--all` includes infrastructure rows
labeled with their roles. Enumeration (`tmux.ListSessionFacts` →
`buildSessionFacts`) reads raw `list-sessions` on the shared
`sessionListFormat` fields: user rows follow `parseSessions`' keep decision
exactly (group copies fold onto the leader, `grouped: true`), pin/iso/control rows
are re-included from their raw lines, and `attached` counts size-arbitrating
human clients via the `ListClients` group-key join (control-mode/ignore-size
attaches excluded, group-copy viewers credited to the leader). Output and exit
codes are the `panes` conventions: aligned table
(`NAME ROLE ATTACHED WINDOWS PATH`) on stdout / diagnostics on stderr, `--json`
the envelope with `result` a two-space-indented array; **0** success including
alive-but-empty (`result` `[]`,
`ServerAlive`-probed), **1** operational, **2** usage.

#### Scenario: Default lists the spawn-candidate set; --all labels infrastructure
- **GIVEN** a server holding `_rk-ctl`, `_rk-operator`, and `fabKit`
- **WHEN** `rk mux sessions --json` runs
- **THEN** the `result` array carries exactly the `fabKit` row (`role: user`)
- **AND WHEN** `rk mux sessions --all --json` runs
- **THEN** all three rows appear with roles `control`, `operator`, `user`

### Requirement: `rk mux new` — validated detached server creation
`rk mux new <name> [--ephemeral]` SHALL create a detached tmux server on
socket `<name>` with a single session named `<name>`, reusing
`tmux.CreateSession(name, "", name)` — the same server-birth path the
create-server API flow uses (env sanitization via `CleanEnvForServer`, CWD
anchored to `ServerBirthDir`; [tmux-sessions](/run-kit/tmux-sessions.md)).
`<name>` SHALL be validated via `validate.ValidateServerName` before any
subprocess; an invalid name is a usage error (exit 2) naming the allowed
character set. The socket SHALL be probed first (`tmux.ServerAlive`): a live
server refuses with exit 1 (operational) stating the server is already
running, performing no tmux mutation; a dead/stale socket proceeds —
`new-session` starts a fresh server over it. On success stdout carries
exactly one report line — `created <name>` — or, under `--json`, the envelope
receipt `{"ok":true,"result":{"report":"created","server":"<name>","ephemeral":<bool>}}`
(the flag echo, so the receipt says what was created — the family's `--json`
opt-in changes only what stdout carries); diagnostics ride stderr. (260911-fr5t-cli-spawn-and-steer-receipts) `new` is
an operator-tier member — the socket name is its positional argument — so it
rejects an explicitly-set inherited `-L/--server` via
`muxRejectInheritedServerFlag` (usage error, exit 2), takes exactly one
positional (stray/missing args are usage errors), and follows the toolkit
exit-code convention (0 success / 1 operational / 2 usage).

`--ephemeral` SHALL set `@rk_srv_ephemeral 1` (const `tmux.EphemeralOption`)
server-scoped on the new server via `tmux.MarkServerEphemeral` (mirroring
`SetServerOrigin`: `set-option -s` under the `TmuxTimeout` bound) immediately
after creation, before the command returns. If the mark fails after a
successful create, the command SHALL best-effort `tmux.KillServer` the
just-created server and exit 1 — a `--ephemeral` invocation never leaves an
unmarked server behind.

#### Scenario: Collision refusal touches nothing; `--ephemeral` reads back
- **GIVEN** a live server on socket `busy`
- **WHEN** `rk mux new busy` runs
- **THEN** it exits 1 naming `busy` as already running, and the existing
  server is untouched; **AND GIVEN** `rk mux new scratch --ephemeral`,
  **THEN** `tmux.IsEphemeralServer(ctx, "scratch")` reads `true` after
  return, and a failed mark kills the fresh server with exit 1.

### Requirement: `rk mux adopt` — convert an external server to managed
`rk mux adopt <server>` (`cmd/rk/mux_adopt.go`, `mux_new.go` as the template)
SHALL convert an external (unmarked) tmux server into an rk-managed one
(stamping `@rk_srv_managed`, const `tmux.ManagedOption`; the full class contract is
[tmux-sessions](/run-kit/tmux-sessions.md) § Server-Scoped User Options).
`<server>` SHALL be validated via `validate.ValidateServerName` before any
subprocess (usage error, exit 2); as an operator-tier member it rejects an
explicitly-set inherited `-L/--server` via `muxRejectInheritedServerFlag`
(usage error, exit 2) and takes exactly one positional. The socket SHALL be
probed live first (`tmux.ServerAlive`) — a dead/absent socket is operational
(exit 1) because `set-option -s` and `source-file` both need a running tmux
process. Semantics: an already-managed target — including `rk-daemon` by
derivation — SHALL print `already managed <name>` and exit 0 with no mutation
(idempotent by contract: the bulk-migration role requires it); otherwise the
verb SHALL **stamp first, then reload** (`tmux.MarkServerManaged` then
`tmux.ReloadConfig`), and a failed reload SHALL best-effort
`tmux.UnmarkServerManaged` (under a fresh timeout context — a slow probe must
not hand the rollback an exhausted deadline) and exit 1, so a stamped server
whose conf never applied is never left behind. The verb is **non-interactive**
— invocation is consent — and never assigns a server color; there is no
un-adopt verb. On success stdout carries exactly one report line:
`adopted <name>`; diagnostics ride stderr; exit codes follow the toolkit
convention (0/1/2). The same stamp→reload-with-rollback semantics back the
HTTP twin `POST /api/servers/adopt` ([tmux-sessions](/run-kit/tmux-sessions.md)
§ API Server Parameter).

#### Scenario: Adopt twice mutates once; a dead socket is operational
- **GIVEN** a live unmarked server `ext`
- **WHEN** `rk mux adopt ext` runs
- **THEN** stdout is `adopted ext`, exit 0, and `IsManagedServer` reads true;
  **AND WHEN** it runs again, **THEN** stdout is `already managed ext`, exit 0,
  no mutation; **AND GIVEN** no live server on the socket, **THEN** exit 1

### Requirement: `rk mux init-conf` — managed tmux.conf scaffold
`rk mux init-conf [--force]` SHALL write the rk-managed tmux.conf to
`~/.config/hexokit/tmux.conf` through the shared managed write path
(`tmux.ForceWriteConfig` — the hash-stamped header + embed body; see
[configuration](/run-kit/configuration.md) § Managed tmux.conf), ensure the
`tmux.d/` drop-in dir, and scaffold `tmux.d/user.conf` as a commented starter
when absent — an existing `user.conf` is never overwritten, including under
`--force`. Without `--force`, an existing managed file is an error carrying
the recipe (put overrides in `tmux.d/user.conf`, or use `--force` to refresh
the managed file); `--force` is scoped to the managed file — tmux.d contents
are untouched. Success output names the managed path (rk-managed, do not
edit) and `user.conf` as the override home. Both cobra instances (the family
member and the hidden root alias) ride the same RunE core and the shared
write path; `POST /api/tmux/init-conf` rides the same `ForceWriteConfig`.

#### Scenario: --force refreshes the managed file only
- **GIVEN** an existing managed tmux.conf and a customized `tmux.d/user.conf`
- **WHEN** `rk mux init-conf --force` runs
- **THEN** the managed file is rewritten with the current embed and
  `user.conf` is byte-identical to before; **AND GIVEN** no `--force` with an
  existing managed file, **THEN** the error names `tmux.d/user.conf` for
  overrides and `--force` for refreshing the managed file.

### Requirement: No daemon dependency; bounded subprocesses
The pane-scoped verbs SHALL address tmux directly from the caller's context
(`-L <server>`
or the `$TMUX`-derived socket basename — the `rk present` pattern), so
agent-to-agent messaging works while `rk serve` is down. Every subprocess is an
`exec.CommandContext` argv slice under a bounded context (5s per tmux operation,
Constitution §I); the verbs hold no state beyond the invocation (Constitution
§II).

### Requirement: Operator members reject an explicit inherited `-L`; old root forms are deprecation aliases
The operator members (`new`, `reap`, `snapshot list|show|restore`, `init-conf`, `adopt`) do not
consume the mux parent's persistent `-L/--server` flag; each SHALL return a usage
error (exit 2) naming `--server` when the inherited flag was explicitly set
(e.g. `rk mux -L foo reap`), rather than silently ignoring it. **`guard` is
exempt**: `DisableFlagParsing` means no flag is ever parsed on it, so `-L` flows
verbatim into the tmux argv (it is genuinely tmux's socket flag there) and
`muxRejectInheritedServerFlag` is never called — the pinned invariant is no
silent retarget. The old root forms
`rk reaper`, `rk snapshot …`, and `rk init-conf` SHALL remain functional as
hidden deprecation aliases — each carries `Hidden: true` plus a cobra
`Deprecated` pointer (on the alias's executed command, including the snapshot
alias's children), prints the pointer to stderr, and runs with identical flags,
output, and exit codes. Unlike `agent-hook`/`tmux-guard`, these aliases are NOT
permanent: they are human-typed verbs, so they are removable in a future release
(cli-layering.md delegation rule 3 does not apply).

#### Scenario: An explicit `-L` on an operator member is refused
- **GIVEN** `rk mux -L foo reap`
- **WHEN** the command runs
- **THEN** it exits 2 with a usage error naming `--server`, and nothing is
  reaped; **AND GIVEN** `rk reaper --yes`, **THEN** it reaps exactly as before
  with a deprecation pointer on stderr

## Design Decisions

### Help GroupIDs stamped on family instances, never in the two-instance constructors
**Decision**: The three `cobra.Group`s and all thirteen `GroupID` assignments live
in `mux.go`'s `init()` on the family-member instances; the shared constructors
(`newReapCmd` and kin) are untouched.
**Why**: The constructors also build the hidden root aliases, parented to
`rootCmd`, which registers none of these groups — cobra panics at Execute on a
`GroupID` not defined on the command's parent. Stamping at the family seam also
keeps the whole presentation decision in one file.
**Rejected**: `GroupID` inside each constructor (panics the root aliases);
per-file stamping at each command literal (scatters one presentation decision
across nine files).
*Introduced by*: 260904-fvpu-mux-help-groups-messaging-topic

### Messaging topic page carries concepts; mux page keeps verb depth
**Decision**: `docs/site/skill/messaging.md` teaches the channel matrix,
readiness standard, scope rule, and judgment split, and cross-links
`rk skill mux` for flags, gate matrices, report words, and gotchas.
**Why**: Both pages are bounded at ≤150 lines and the mux page sits at its cap;
duplicated verb reference would drift, and the two altitudes serve different
moments (choosing a channel vs. driving a verb).
**Rejected**: folding the matrix into the mux page (over budget); restating the
verb reference in messaging.md (two copies to keep honest).
*Introduced by*: 260904-fvpu-mux-help-groups-messaging-topic

### Engine package named `internal/inject`
**Decision**: The shared pane-injection engine lives in `internal/inject` behind a
six-method `Tmux` interface (pane-mode clear / capture / set-buffer /
paste-buffer / send-Enter /
pane-scoped send-keys, context-bound), with the buffer name as an engine
parameter — the daemon passes `rk-agent-send`, the CLI its per-invocation
`rk-send-<pid>`.
**Why**: mechanics-named like `internal/present`; "chat" does not describe an
engine the CLI consumes alongside the daemon route, and the interface keeps both
consumers testable without a live tmux. The same reasoning names the daemon's
consumer cluster agent-send ([agent-send](/run-kit/agent-send.md) § The
injection cluster is named agent-send).
**Rejected**: `internal/agentsend` (couples the name to one consumer).
*Introduced by*: `260815-a5vf-rk-send-await-agent-messaging`

### Submit observation and recovery stay in the shared engine
**Decision**: Post-Enter observation, `SubmitUnverified`, and bounded recovery
belong to `internal/inject.Engine.Send`, behind the pane-scoped context-bound
`Tmux` interface, so `rk mux send` and all daemon injection routes inherit the
same behavior.
**Why**: Delivery safety is an engine property. Keeping the choreography at the
shared seam gives every consumer the same evidence threshold, retry bound,
deadline propagation, and duplicate-prevention rule.
**Rejected**: Implementing verification only in `cmd/rk/mux_send.go` (leaves the
four daemon routes vulnerable and duplicates the choreography); implementing it
independently in each HTTP handler (five contracts that can drift).
*Introduced by*: 260830-nyvm-mux-send-submit-verification

### CLI probe failure = staged text + stderr + exit 1
**Decision**: A failed echo probe on the CLI path sends no Enter, leaves the
text staged in the composer, prints the retry-hinted message (a resend would
duplicate) to stderr, and exits 1 — the compose-send 409's CLI analog.
**Why**: strictly better than a blind Enter; the failure must be visible to
scripts, and the message steers away from a duplicating resend.
**Rejected**: exit 0 with a `staged` report (hides the failure from scripts).
*Introduced by*: `260815-a5vf-rk-send-await-agent-messaging`

### `--await` grace expiry falls through to the await
**Decision**: When the post-submit active-flip watch expires without observing
`active` (or the pane proves uninstrumented), the composition falls through to
the await observer rather than erroring.
**Why**: hooks may lag or the peer may finish within the grace window; erroring
would flake. The grace closes the stale-state race as well as it can, then the
await's own contract takes over.
**Rejected**: hard error on no active flip.
*Introduced by*: `260815-a5vf-rk-send-await-agent-messaging`

### Strict target grammar — no bare `session:window`
**Decision**: Only `%N`, `@N`, and `=session:window` are accepted; bare
`session:window` names are a usage error.
**Why**: tmux's target grammar resolves bare names against window names before
session names, so a window named like a session hijacks the target — a
documented footgun the `=` prefix (exact-match parsing) eliminates.
**Rejected**: accepting bare names with tmux's default resolution (silent
mis-targeting in exactly the multi-session setups the verbs serve).
*Introduced by*: `260815-a5vf-rk-send-await-agent-messaging`

### Toolkit exit codes and one-word report words, not fab's pane-family scheme
**Decision**: The pane-scoped verbs use the toolkit convention (0 success, 1
operational,
2 usage); `await`'s `gone` reports on stdout with exit 1, and the report word —
not the exit code — discriminates await outcomes.
**Why**: toolkit standards bind rk's CLI surface; one-word stdout reports keep
agent parsing simple, and no fab-kit consumer branches on the old verbs' 2/3
codes.
**Rejected**: fab's pane-family 2/3 exit scheme (diverges from every other rk
verb).
*Introduced by*: `260815-a5vf-rk-send-await-agent-messaging`

### Per-invocation CLI buffer name (`rk-send-<pid>`)
**Decision**: The CLI sends through a per-invocation named buffer while the
daemon keeps its single shared `rk-agent-send` buffer plus its in-process
per-pane locks.
**Why**: a CLI send must never clobber a concurrent daemon send's buffer —
distinct buffer owners need no cross-process guard; the same-pane cross-process
paste race that remains is inherent to tmux and rare.
**Rejected**: sharing `rk-agent-send` from the CLI (the single-writer assumption
breaks across processes).
*Introduced by*: `260815-a5vf-rk-send-await-agent-messaging`

### Two-instance constructor per moved command
**Decision**: Each command moved under `mux` is built by a
`newXxxCmd(use string, deprecated bool)`-style constructor producing both the
family member and the hidden root alias, with flag vars closure-bound per
instance.
**Why**: cobra commands have exactly one parent; the pattern is proven in this
package by `newAgentSetupCmd`; package-level flag vars would silently share
state across instances.
**Rejected**: cobra `Aliases` field (same-parent only); a delegating stub RunE
(duplicates flag definitions anyway, loses help parity).
*Introduced by*: `260815-lsgf-mux-consolidation-low-risk`

### Reject explicitly-set `-L` on operator members
**Decision**: new/reap/snapshot/init-conf under `mux` error (usage, exit 2) when the
inherited `--server` flag was explicitly set; the five pane-scoped verbs
(send/await/capture/kill/process) and the `panes`/`sessions` enumerations consume it. The
`guard` member is exempt —
`DisableFlagParsing` means `-L` is never parsed and flows verbatim into the tmux
argv, so there is nothing to reject (see
[tmux-guard-shim](/run-kit/tmux-guard-shim.md) § Design Decisions).
**Why**: toolkit Principle 1/9 posture — `rk mux -L foo reap` silently ignoring
`-L` is a success-looking misinterpretation (user believes the reap is
server-scoped).
**Rejected**: silently ignoring the flag (footgun); plumbing `-L` semantics into
the moved commands (new behavior, out of scope of the consolidation).
*Introduced by*: `260815-lsgf-mux-consolidation-low-risk`

### Kill gate refuses active AND waiting
**Decision**: `rk mux kill` refuses `active` and `waiting` panes without
`--force`; `idle`/unknown kill.
**Why**: the send gate's never-interrupt posture applied to destruction — a
waiting pane holds a pending human question; killing it silently loses that.
`--force` keeps the operator path one flag away.
**Rejected**: fab's ungated twin (rk owns the state convention — its verbs
should be first-party readers); gating only `active` (waiting loss is the
subtler footgun).
*Introduced by*: `260815-82w7-mux-substrate-twins`

### Protected-server gate joins the kill refusal set
**Decision**: `rk mux kill` refuses panes on protected servers (the derived
daemon server `rk-daemon`, or any server marked `@rk_srv_protected`) under the
same refusal shape as the agent-state gate — naming the protected server on
stderr, exit 1, no tmux mutation; the existing `--force` flag skips both
gates, with target existence still validated.
**Why**: the CLI is the agent-facing kill path — a pane kill on a protected
server is the same accident class the API 409 and the UI typed-confirm close;
one override flag keeps the refusal surface single.
**Rejected**: a separate override flag per gate — two ways to say "I mean it"
for one verb.
*Introduced by*: 260824-xaw2-protected-server-class

### Capture enrichment is substrate-only
**Decision**: capture carries cwd + reconciled agent state/duration; fab's
change/stage fields are dropped. The decision governs the **CLI substrate
verbs** — the cross-tool substrate surface — and stands. It does not bar the
SERVER's own fab-tier read: the dashboard's L2 register derivation
(`.fab-status.yaml` → `.status.yaml`; see
[tmux-sessions](/run-kit/tmux-sessions.md) § Fab-Tier Derivation) is the
sanctioned Constitution II request-time derivation — a different consumer with
a different contract.
**Why**: cli-layering delegation rule 1 — change/stage come from
`.fab-status.yaml`, fab's layer; rk's CLI must not reimplement the read for its
substrate output. The two consumers differ: CLI verbs are the cross-tool
substrate surface, while the server's dashboard registers are constitutionally
derived from the filesystem.
**Rejected**: shelling out to `fab pane capture` for the join (inverts the
dependency); porting the `.fab-status.yaml` parse into the CLI verbs
(reimplements fab's layer); reading this decision as banning any rk read of fab
artifacts (contradicts Constitution II and status-pyramid.md).
*Introduced by*: `260815-82w7-mux-substrate-twins`; scope pinned by
`260820-hol4-mux-panes-native-pane-map`

### `panes` enumerates the `parseSessions`-filtered view
**Decision**: `rk mux panes` lists the same filtered view the dashboard shows —
`_rk-pin-*` pin-sessions, `_rk-iso-*` isolated relay sessions and the `_rk-ctl`
anchor are skipped, and a dual-membership (pinned/isolated) window appears once, via its home session.
**Why**: matches the dashboard's user-facing truth and avoids duplicate rows
for pinned windows; an enrichment consumer wants one row per real pane.
**Rejected**: raw unfiltered enumeration (duplicates pinned windows, leaks
internal sessions).
*Introduced by*: `260820-hol4-mux-panes-native-pane-map`

### `panes` carries liveness as a lazy, tri-state `has_agent`
**Decision**: `rk mux panes --json` rows end with `has_agent`; the process-tree
walk runs only for shell-foreground rows (yielding `true`/`false`) and every
other row — non-shell foreground, or a failed walk — is `null`.
**Why**: `agent_state` is instrumentation and can outlive its agent (a legacy
two-segment value has no pid to reconcile), so a consumer asking "did the agent
exit?" needs process evidence; that question is open only when a shell owns the
tty (an agent TUI in the foreground is not a candidate), so the walk cost is
bounded to those rows, and `null` states honestly that rk has no evidence
rather than guessing. Putting the bit on the enumeration lets fab's operator
tick drop its own duplicate tree walker (cli-layering: rk owns the substrate
fact).
**Rejected**: walking every row (pays the darwin `ps` cost on rows nobody
consults); deriving liveness from `agent_state` alone (the stale-value problem
is the reason the walk exists); a bulk `rk mux process --all` verb (a second
enumeration surface).
*Introduced by*: `260910-7pek-mux-panes-has-agent`

### Agent classification derives from the agent setup registry
**Decision**: `classifyProcess`'s agent name set is the union of every
`agentRuntimes()` entry's `binary` and `comm` (minus `node`) plus `claude-code`,
matched on the comm basename or on either of the first two cmdline token
basenames.
**Why**: for an uninstrumented agent (no agent-state pid to cross-check) the
comm table is the only liveness defense, so it must cover every harness `rk
agent setup` knows — the registry is that single source; the two-token cmdline
fallback catches node-hosted CLIs (gemini) without letting prompt text in argv
count as evidence.
**Rejected**: a second hand-written comm table (drifts from the registry);
matching the whole cmdline (argv prompt text becomes liveness evidence).
*Introduced by*: `260910-7pek-mux-panes-has-agent`

### `#{pane_pid}` and the agent pid ride `paneFormat`, unserialized
**Decision**: `paneFormat` carries `#{pane_pid}` (field 11) and `parsePanes`
stores it as `PaneInfo.PanePID` alongside the reconciled `PaneInfo.AgentPID`,
both tagged `json:"-"`.
**Why**: the `panes` liveness walk needs a walk root and a cross-check pid per
row without a per-pane `display-message` round trip; the dashboard pre-renders
and fans out `PaneInfo`, so the new fields must not reach `/ws/state`.
**Rejected**: per-row `PanePIDCtx`/`PaneFactsCtx` reads (N extra subprocesses
on every enumeration — right for the target-scoped `process` verb, wrong for an
enumeration).
*Introduced by*: `260910-7pek-mux-panes-has-agent`

### Duration semantics follow rk's sessions rollup, not fab's idle-only
**Decision**: the capture/panes duration shows for any known state with
epoch > 0 (JSON field `agent_state_duration`) — `active` included — not fab's
idle-only `agent_idle_duration`.
**Why**: rk's own reader semantics (`rollupAgentState` — "how long the human has
been the blocker / how long at rest", and for `active` the age is the only
staleness signal for a lost write on a live agent); one convention inside rk
beats byte-parity with a copy being demoted to dispatch-internal.
**Rejected**: fab's idle-only field (would make rk's CLI disagree with rk's
dashboard on what waiting duration means, and would hide the stale-`active`
case entirely).
*Introduced by*: `260815-82w7-mux-substrate-twins` (`active` age: 260916-la8z-hook-launcher-upgrade-window)

### Plain capture is a new primitive, not a flag change
**Decision**: the no-`-e` capture lives in `CapturePanePlainCtx` alongside
`CapturePaneCtx` instead of parameterizing or changing it.
**Why**: the `-e` variant is load-bearing for the chat echo probe (SGR-aware
novelty detection); a boolean parameter would put the distinction at every call
site (the SendLiteralArgs/SendKeyArgs lesson).
**Rejected**: stripping escapes downstream (fragile, and `--raw` must stay
byte-identical to tmux output).
*Introduced by*: `260815-82w7-mux-substrate-twins`

### Prompt classification is substrate, prompt policy is fab's
**Decision**: `rk mux capture --classify` classifies any resolvable pane's
screen text on request and reports `{indicator, snippet}` or `none` + reason;
which panes to sweep, what to answer, and when to escalate stay in
fab-operator. The classifier is the pure package `internal/promptscan`, and its
class/reason identifiers match `fab pane questions` verbatim.
**Why**: cli-layering rule 1 — rk owns pane reads (capture, reconciled state,
readiness); fab owns choreography. A hook-less pane never flips
`@rk_pane_agent_state` to `waiting`, so the pending-question fact for it is a
request-time derivation from the screen (Constitution X's derivation side), and
it belongs beside the other pane readers. A state gate in rk would bake operator
policy into a substrate verb; identical identifiers make fab's rk-first
delegation a structural pass-through; a pure package is unit-testable without
tmux fakes and reusable by future rk consumers.
**Rejected**: filtering to `waiting`/`idle` inside rk (duplicates fab's
candidate policy and blocks classifying an `active` hook-less pane); a separate
`rk mux questions` verb (a second capture with its own flags for one extra
field); always emitting `questions` under `--json` (silent shape change for
every caller); placing the scanner in `internal/tmux` or `internal/inject`
(neither is about text classification); rk-native class names (forces a
translation table in fab).
*Introduced by*: `260910-a7g2-capture-classify-pending-prompts`

### Server-create collision probe is `ServerAlive`, refusal is operational
**Decision**: `rk mux new` probes `tmux.ServerAlive` before creating; a live
server refuses with exit 1 (operational), a dead/stale socket proceeds.
**Why**: creating over an existing live socket must fail clearly, not attach;
`ServerAlive` is the diagnostic-carrying liveness probe built for exactly this
CLI distinction, and a stale socket must not block creation (tmux restarts
over it).
**Rejected**: treating collision as usage (exit 2) — the name is well-formed;
the failure is environmental. Attaching/adopting the live server.
*Introduced by*: 260821-hbmh-ephemeral-creation-adoption

### Mark failure kills the fresh server
**Decision**: when `--ephemeral`'s option write fails after a successful
create, `rk mux new` best-effort `KillServer`s the new socket and exits 1.
**Why**: the verb exists to prevent unmarked scratch servers; returning
success-shaped debris on a failed mark would recreate the exact leak it fixes.
The server is milliseconds old and owned by this invocation — killing it is
safe.
**Rejected**: leaving the server and warning (unmarked survivor — the failure
mode the verb eliminates); retry loops (a failing `set-option` on a server
that just booted signals something structurally wrong).
*Introduced by*: 260821-hbmh-ephemeral-creation-adoption

### Adopt rolls back its stamp on a failed reload
**Decision**: `rk mux adopt` (and the `POST /api/servers/adopt` endpoint) stamp `@rk_srv_managed` first, then source the managed conf; a failed reload best-effort unmarks and fails the verb.
**Why**: the mark means "the managed conf applied" — a stamped server whose conf never applied would be a lying provenance record; the rollback keeps the stamp truthful. Ordering stamp-first guarantees the rollback target exists.
**Rejected**: reload-then-stamp (a crash between the two leaves a confed-but-external server — the inverse lie); leaving the stamp on reload failure (silently opts the server into future conf reloads it never received).
*Introduced by*: 260826-lv87-external-server-provenance-adopt

### Fleet-wake MUSTs split between rk guarantee and caller protocol
**Decision**: rk implements no exclusion filtering, no re-arm logic, and no
debounce for `--any` fleet waits; it guarantees the first sweep runs before any
sleep and documents the five-point fleet-wake protocol in the skill page.
**Why**: re-arming after resume and re-arming on target-set change are
inherently caller-side (awaits are foreground children of the caller); rk-side
at-arm baselining would reopen the exact edge-trigger gap the
first-sweep-before-sleep guarantee exists to close; a single invocation wakes
once, so inter-wake spacing is inherently the re-armer's property.
**Rejected**: at-arm state baselining (loses wakes that fired between the
caller's last read and the arm); a `--settle`/`--debounce` flag (suppresses
legitimate wakes).
*Introduced by*: 260823-tqkt-mux-await-any-multi-target

### Report word stays the first stdout token; firing pane appended
**Decision**: `--any` reports `<state> %N` / `gone %N`, with `file`/`running`
bare; single-target output is unchanged.
**Why**: callers need pane identity; keeping the report word first preserves
the family's one-word-parse habit (the first token discriminates the outcome in
both modes).
**Rejected**: `%N <state>` ordering (breaks first-token parsing); JSON output
(heavier than the family's one-line report contract).
*Introduced by*: 260823-tqkt-mux-await-any-multi-target

### First dead target wakes the await; no drop-and-continue
**Decision**: a gone member reports `gone %N` (exit 1) rather than being
dropped from the watched set.
**Why**: consistent with single-target `gone`; pane death is wake-worthy for
the fleet caller (armed panes get immediate death detection), and the caller
re-arms minus the dead pane per the fleet-wake protocol.
**Rejected**: drop-and-continue with gone-only-when-empty (silently narrows the
watched set; the caller's set model drifts from reality).
*Introduced by*: 260823-tqkt-mux-await-any-multi-target

### Boot readiness is a derived signal; hook-less composition is `await --ready && send --force`
**Decision**: `--ready` waits on a derived readiness verdict
(`inject.AwaitReady`) rather than a new agent-state value: state-present is the
preferred signal (hooks fired, so the TUI is up); for hook-less panes a settled
screen is the trigger for a sentinel echo probe whose outcome reports
`ready %N (state)` / `ready %N (echo)` / `parked %N` / `narrow %N (WxH)`. `--ready` is mutually
exclusive with every other await condition including `--any`. `rk mux send`
gains NO new gate mode: the documented hook-less composition is `await --ready`
followed by `send --force`.
**Why**: presence of a reconciled state already proves hooks fired (the TUI is
up) — a `ready`/`boot` state would be schema churn every reader must learn; a
settle-only verdict cannot distinguish a live input box from a settled wall
(a trust dialog, survey, theme picker, or login wall is non-blank and
byte-identical across polls while eating any delivery), and the sentinel echo
probe closes that gap with machinery the engine already trusts; `--ready` is
defined for the single target pane, so a multi-target boot-wait
has no coherent report shape in the family; `--force` already exists with
exactly the skip-the-gate meaning the hook-less path needs, and Go callers use
the `inject.DeliverWhenReady` composite directly.
**Rejected**: a new `ready` agent-state value (schema churn, every reader must
learn it); reporting ready on capture-settle alone (the settle predicate is
satisfied by exactly the parked walls it must distinguish from a live input
box); teaching rk to recognize wall types (judgment of what the wall wants is
caller policy — the spec's layering keeps policy out of the binary); a
`send --when-ready` gate mode (minimal CLI surface — the shell
composition covers it); `--ready` combinable with `--until`/`--file` (mixing
conditions has no coherent semantics).
*Introduced by*: 260903-4czh-boot-ready-spawn-inject; sentinel classification 260904-r7uk-await-ready-parked-classification; narrow classification 260906-dm30-await-ready-narrow-pane-verdict

### Parked is a typed error, not a Readiness value
**Decision**: `AwaitReady` surfaces parked as a typed sentinel error carrying
the snippet (`ParkedError` wrapping `ErrParked`, alongside `ErrNotReady`),
never as a `Readiness` value.
**Why**: `Readiness` means "safe to type into"; every consumer
(`DeliverWhenReady`, kickoff, riff) branches on error-vs-nil, so an error is
the shape that fails closed everywhere with zero signature churn.
**Rejected**: a `Parked` Readiness value (a naive consumer would deliver into
the wall); a third return value (churns every call site).
*Introduced by*: 260904-r7uk-await-ready-parked-classification

### Sentinel is a fixed comment-safe constant pasted via the buffer primitives
**Decision**: the sentinel is the fixed constant `#rk-ready-probe` (a `#`
prefix), pasted through `SetBuffer`/`PasteBuffer` under a caller-supplied
buffer name in `ReadyOpts` (the CLI passes a per-invocation `rk-ready-<pid>`
name; `rk-ready` is the default), never submitted (no Enter anywhere on the
path).
**Why**: `#` makes even a worst-case accidental submit into a cooked-mode shell
a no-op comment; novelty counting (not entropy) provides collision soundness;
the buffer-name parameter mirrors the engine's per-invocation-name lesson so a
probe can never clobber a concurrent daemon/CLI send buffer.
**Rejected**: random per-probe sentinel (novelty counting already handles
stale text; randomness only complicates test assertions); `send-keys -l`
literal typing (a second typing path outside the paste discipline).
*Introduced by*: 260904-r7uk-await-ready-parked-classification

### Unverified sentinel clear fails closed
**Decision**: when `C-u` cannot restore the settled baseline within bounded
attempts after an echo, `AwaitReady` returns an operational error (not ready,
not parked).
**Why**: reporting ready over a composer still holding the sentinel corrupts
the very next delivery (`#rk-ready-probe<prompt>`); at a genuine live input box
the clear virtually always verifies, so the fail-closed branch is a
should-never-happen guard, matching the engine's `errComposerNotCleared`
posture.
**Rejected**: ready-with-stderr-warning (an automated composer like
`DeliverWhenReady` never reads the warning).
*Introduced by*: 260904-r7uk-await-ready-parked-classification

### Narrow is a geometry verdict, not a wall
**Decision**: a settled below-floor pane returns `NarrowError`/`ErrNarrow` — a
third typed verdict beside `ParkedError`/`ErrParked` — and the CLI prints a
distinct first token `narrow %N (WxH)` (exit 0, geometry and remedy on stderr).
**Why**: the probe cannot be trusted at that geometry (a bordered composer
reflows or is not drawn), so "no echo" carries no information about walls. A
caller branching on `parked` would answer a wall that does not exist; the true
remedy (resize or relocate) is only actionable if named.
**Rejected**: folding the geometry into the `parked` snippet — the frozen
first-token contract is what scripts branch on, and `parked` already means
"judge the wall".
*Introduced by*: 260906-dm30-await-ready-narrow-pane-verdict

### The readiness floor is a fixed constant gating only the probe arm
**Decision**: `ReadyMinCols`/`ReadyMinRows` are exported Go constants (80×20),
checked only at the settle-triggered probe entry; the state signal is
unaffected.
**Why**: 80×20 is the conventional minimum agent TUIs assume; hooks firing
prove the TUI is up regardless of size; constitution IV/settings-home forbids a
new env var and a settings key would be a knob nobody should turn.
**Rejected**: a `ReadyOpts` field or config key — surface area with no caller.
*Introduced by*: 260906-dm30-await-ready-narrow-pane-verdict
