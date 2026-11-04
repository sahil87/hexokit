# Agent Messaging — The Communication Standard

> Decided 2026-09-04 (discussion session). This spec fixes the **target shape** of
> pane-to-pane and operator-to-pane communication: one delivery engine, one safety
> convention, one CLI surface, with policy kept caller-side. The memory file
> [`docs/memory/run-kit/agent-messaging.md`](../memory/run-kit/agent-messaging.md)
> records what has shipped; this spec records where it converges. Companion:
> [`cli-layering.md`](cli-layering.md) (which tool owns which layer — its
> decisions are inputs here, not reopened).

## The model — four layers

| Layer | Owner | Content |
|-------|-------|---------|
| **Mechanism** | `internal/inject` | The one typing engine: sanitize → named-buffer bracketed paste → novelty echo probe → probe-gated Enter → post-Enter observation → evidence-gated recovery. Every rk-owned code path that types into a pane goes through it — **no exceptions** (the single-engine invariant). |
| **Safety convention** | `@rk_pane_agent_state` + gates | The three-state lifecycle (`active`/`waiting`/`idle` + unknown), the send/kill gate matrices, probe-fail-closed delivery, toolkit exit codes, first-token report words. |
| **Surface** | `rk mux` (pane-scoped verbs) | `send` / `await` / `capture` / `kill` / `process` / `panes` — the de-facto cross-agent CLI. The daemon routes (`/send`, operator actuation, selection broadcast) are HTTP doors onto the same engine, not a second standard. The MCP `send` / `answer` / `await` tools ([mcp.md](mcp.md)) are a **fourth door** — `rk mux send --json` executed as argv — onto the same engine; the `--json` receipt is the frozen report word plus the engine's evidence, never a new lane. |
| **Policy** | Callers (fab-operator, skills, humans) | Who to message, when, what a trust wall wants, retry budgets, escalation. Never encoded in the binary. |

**Terminals vs agents are one standard, not two.** Whether the target pane runs
zsh or an agent TUI is a *property read from the pane* (agent-state presence,
foreground command), never a caller declaration. An uninstrumented shell reads
`unknown` (warn + send) and its cooked-mode echo satisfies the same probe; an
instrumented agent gets the full gate matrix. Same verb, same flags, same report
words.

## The channel matrix

| Need | Channel | Why this channel |
|------|---------|------------------|
| **Write** (message, answer, keystroke) | `rk mux send` (plain / `--answer` / `--force` / `--no-enter` / `--key` / stdin `-`) | Gated, probe-verified, engine-backed |
| **Read: screen** | `rk mux capture` | The painted frame + reconciled state; the *only* screen truth for alt-screen TUIs |
| **Read: state** | `rk mux await`, `rk mux panes`, `rk mux process` | Lifecycle without scraping |
| **Read: results** | **Artifact files** the worker is told to write (`{stage}-result.yaml`, `await --file`) | Unambiguous, survives scrollback, readable without the pane. Agent TUIs run alt-screen with zero scrollback, so transcript-shaped reads from the screen are structurally impossible — artifact-first is a consequence, not a preference |
| **Wait** | `rk mux await` (`--until` / `--any` / `--file` / `--ready`), composed `send --await` | Event-shaped, first-sweep-before-sleep, fleet wake |
| **Conversation** (multi-turn cross-provider) | Outbound MCP bridge (e.g. `codex mcp-server`) | Tool-mediated dialogue is not pane-driving; see `_cli-agents` § Codex MCP Bridge. The *inbound* direction — a chat client with no shell driving HexoKit — is `rk mcp` ([mcp.md](mcp.md)), a door onto these same channels |

## Messaging the operator — three lanes

Every lane delivers through the one injection engine (HTTP doors onto the same
engine, per the single-engine invariant); the lanes differ in **who composes
the prompt** and **what a busy operator means**. The razor: **chat is a human
steer from a user watching the pane** — the message must land now (allow +
probe, no queue); **a request is work handed over** — a busy operator queues it
(202, drain on idle). Shipped state lives in
[`docs/memory/run-kit/operator-actuation.md`](../memory/run-kit/operator-actuation.md).

| Lane | Route | Prompt composition | Busy posture |
|------|-------|--------------------|--------------|
| **Operator chat, direct** | `POST /api/windows/{operatorWindowId}/send` (`target:"agent"`) | The user's raw text, verbatim | Allow + probe — no busy gate, no queue |
| **Operator chat, templated** *(target)* | window-scoped `POST /api/windows/{windowId}/operator-request`, a chat template (e.g. `user-message`) | Server-derived **source envelope** (addressee header) + the user's text fenced | Allow + probe — the registry entry declares `chatDelivery: true`, which skips the busy gate and the queue |
| **Operator request** | the two `/operator-request` routes, closed template registry | Fully server-rendered work item (Constitution X facts; optional delimited client text) | Busy ⇒ enqueue (`202 {"queued":true}`), in-memory per-server queue drained on idle |

`rk operator request` ([mcp.md](mcp.md) § New verb families) is a **CLI door onto the
request lane** — same closed registry, same busy ⇒ 202 posture for non-`chatDelivery`
templates, surfaced in its `--json` receipt as `queued:true` — not a fourth lane. The
lane count stays three.

The templated chat lane is the quake terminal's context-carrying send. When the
quake terminal (⌘J) is opened on a terminal route, the message rides the chat
template with the **route window as subject**, and the rendered prompt opens
with a one-line **addressee header** — `[user → operator] The user is speaking
to you from window @N ("name", worktree …[; fab change … at stage …]). Act on
it exactly as if typed into this pane.` — naming the operator as the recipient
and folding the server-derived facts (subject `@N`, current window name,
worktree path, fab change + stage when present) into the parenthetical. No
transcript line is rendered. Facts are derived server-side from the handler's
one FetchSessions pass, never client-composed (Constitution X); a subject
without an agent session renders the same header, never an error. The user's
text follows in a bare dynamic fence (`fenceUserText`) with no treat-as-data
framing — in this lane the user is the principal and the text is the
instruction. The envelope frames a **conversation, not a work item**: it does
not use the `[hexokit request]` prefix and carries no action bounds — the
operator acts on it and may reply.

Quake terminal behavior: the compose strip shows the attached context as a visible,
dismissable chip (`from: @5 "name" ✕`) — the IDE-chat pattern (Cursor/Copilot
attach the active file the same way); implicit context the user cannot see
erodes trust in what the operator was told. Chip dismissed, or a route with no
subject window (board/host/server routes) ⇒ the direct lane, unchanged.
`chatDelivery` composes with the existing registry lanes: it requires
`acceptsText` and is incompatible with `requiresAgentSessionRef` (the
transcript line is best-effort, never a precondition).

## Spawn and trust walls — the readiness standard

The spawn-then-deliver composite is **open bare → classify → answer → verified
deliver**, with a strict split of labor:

1. **Classification is mechanical and rk-owned.** `rk mux await --ready` is the
   readiness gate. Target semantics:
   - **State-present** (preferred, touch-nothing): a reconciled agent state
     exists → `ready %N (state)`.
   - **Sentinel classification** (the capture-settle upgrade): when no state
     appears and the screen settles, the gate runs the sentinel echo probe —
     type a harmless sentinel, check the echo, `C-u` clear. Echo at an input
     box → `ready %N (echo)`. No echo on a settled non-blank screen →
     **`parked %N`** (exit 0), with the screen snippet on stderr. This replaces
     today's false-fire hazard (a settled trust dialog reporting
     `ready (settled)`) with an honest classification.
   - **Geometry floor**: the probe is gated on geometry — below the 80×20
     readiness floor (either dimension) a bordered composer reflows or is not
     drawn at all, so the pane reports **`narrow %N (WxH)`** (exit 0) instead
     of being probed, with the geometry and the resize/relocate remedy on
     stderr.
   - `booting` never returns — the await blocks through boot churn and returns
     only on `ready`, `parked`, `narrow`, `gone`, or timeout (`running`). A
     `parked` or `narrow` verdict returns immediately: it is wake-worthy, the
     caller must act.
   - **Scope rule**: the sentinel is typed only into pre-delivery panes (no
     agent state, nothing yet delivered) — the same carve-out fab's dispatch
     gate uses. Against a live delivered worker, readiness verbs are illegal;
     use `await --until` / `capture`.
2. **Judgment is caller-side.** What a `parked` wall wants — trust prompt,
   survey, theme picker — is decided by the calling agent from the snippet, and
   answered with the standard write channel (`rk mux send --key Enter`,
   `--key Down`, …). Login/credential walls escalate to a human, never
   answered. rk never auto-answers a wall.
3. **The safety net is the probe.** Even a mis-classified pane cannot receive a
   blind submit: the echo probe fails closed (no Enter, text staged, exit 1) on
   any screen that does not echo the paste — a permission dialog, a mid-boot
   TUI, a dead pane.

The documented hook-less composition stays
`rk mux await --ready %5 && rk mux send --force %5 '<prompt>'` — `send` gains no
new gate mode; `--force` is the pairing for panes that will never carry state.

## Delivery hardening — target invariants

- **Pane-mode guard everywhere.** Every rk delivery path — text paste, `--key`
  sends, the sentinel probe — first probes `#{pane_in_mode}` and cancels an
  active mode (`send-keys -X cancel`) before touching the pane. A scrolled
  (copy-mode) pane silently eats keys; fab's Go seam already carries this guard
  and rk's surface must match it, closing the last gap where fab's internal
  senders are safer than the public standard.
- **Unknown-state warnings name the foreground.** A plain send to an
  uninstrumented pane whose `pane_current_command` is not a shell warns with
  the command name ("foreground process `htop` running") — same warn-and-send
  behavior, better information. No new gate state: a non-shell foreground may
  be a hook-less agent, which is exactly the `--force` composition's case.
- **Report-word contract is frozen.** One line on stdout, report word first
  (`delivered` / `staged` / `sent` / `unverified` / `ready` / `parked` /
  `narrow` / `idle` / `waiting` / `file` / `running` / `gone` / `killed` /
  `created` / `adopted`), diagnostics on stderr, toolkit exit codes (0 success /
  1 operational / 2 usage). Agent-friendliness lives in this contract, not in
  command names. `--json` ([mcp.md](mcp.md) § Envelope) wraps the report word in the
  toolkit envelope — `{"ok":true,"result":{"report":"delivered",…}}` — while the
  word itself and the exit code are unchanged. Failure reasons reuse the `/send`
  route's 409 codes (`probe_failure`, `staged_send_failure`, `submit_unverified`):
  one engine, one evidence vocabulary.

## Surface and naming — settled

- **`rk mux` stays the umbrella.** The pane conversation verbs, substrate
  twins, and operator members share one target grammar, one `-L` resolution,
  one state convention, and one report contract — a family split (a dedicated
  "communication" family, or reserving `mux` for lifecycle) would duplicate or
  fracture that shared contract, and would be the third address change in a
  year against cli-layering rule 3's permanent-alias tax. **Rejected**: a new
  `rk msg`-style family; elevating `send`/`await` to root.
- **Discoverability is a help problem, not a naming problem.** `rk mux -h`
  presents the family in three groups — *messaging* (`send`, `await`),
  *pane mechanics* (`capture`, `kill`, `process`, `panes`), *server ops*
  (`new`, `reap`, `snapshot`, `init-conf`, `adopt`, `guard`) — and the
  `rk skill` bundle carries a messaging topic page teaching the channel matrix
  above.
- **No third binary** (reaffirming cli-layering): the substrate verbs are only
  valuable with rk's conventions present.
- **fab consumes, never reimplements.** fab-kit guidance points at the rk
  verbs (`command -v rk`-gated, fail-open to raw tmux); fab's own pane copies
  are dispatch-internal for the rk-less arm only. Once `await --ready`
  classifies `parked`, fab's dispatch gate delegates its classification half
  to rk and keeps only the judgment rounds.

## Deferred — named, not designed

- **`rk mux transcript`** (CLI transcript read resolving `@rk_pane_chat`):
  deferred, and further away since the chat-lens removal — `internal/transcript`
  is now locator-only (provider registry + `transcript.Path`); the event-stream
  parser was deliberately deleted with the lens, so a transcript read would
  re-add a parse layer, not just a verb. Revisit only when a second provider
  adapter exists AND a concrete consumer outgrows artifact-first. If it lands
  it is a read-only sibling of `capture`, same target grammar.
- **Protocol-based sends** (Codex JSON-RPC and kin): the engine's adapter seam
  (`injectIntoPane`) is where a provider branch would live; v-current makes no
  provider branch, and typing-into-the-pane remains the universal transport
  (the pane stays the agent's parent process — Constitution VI).

## Gaps from current state

The delta between shipped and this spec, in priority order (the follow-up plan
keys off these numbers):

1. **Pane-mode guard in `rk mux send`** (and the `--key` path) — probe
   `#{pane_in_mode}`, cancel, then deliver.
2. **`parked` classification in `rk mux await --ready`** — the sentinel echo
   upgrade over capture-settle, snippet on stderr, immediate return.
3. **Help grouping + `rk skill` messaging topic page** for the `mux` family.
4. **Foreground-naming warning** on unknown-state sends (small, rides 1).
5. **fab delegation of the dispatch gate's classification half** to
   `rk mux await --ready` (fab-kit change; keeps judgment rounds and the
   rk-less fallback).

## Execution plan

Each part is one fab change, sized for a single pipeline run. *(released)*
gates on the dependency being shipped in a release (brew-installable), not
merely merged. Run-kit parts touching the CLI surface intrinsically include
the standards audit (`shll standards`), the help-dump test, and `rk skill`
topic-page updates.

| # | Part | Repo | Delivers | Depends on |
|---|------|------|----------|------------|
| A | send hardening | run-kit | Gaps 1 + 4 — pane-mode guard (`#{pane_in_mode}` probe + cancel) on every delivery path, foreground-naming warning on unknown-state sends | — |
| B | parked classification | run-kit | Gap 2 — sentinel classifier in `inject.AwaitReady`, `parked %N` report + stderr snippet in `rk mux await --ready` | — (parallel-safe with A; shared `internal/inject` + help-dump adjacency — sequence or rebase) |
| C | discoverability | run-kit | Gap 3 — `rk mux -h` command groups (messaging / pane mechanics / server ops) + `rk skill` messaging topic page teaching the channel matrix | B (the topic page documents `parked`) |
| D | gate delegation | fab-kit | Gap 5 — the dispatch gate's classification half delegates to `rk mux await --ready` (judgment rounds and the rk-less fallback stay fab-side) | B *(released)* |

Sequencing summary: **A ∥ B → C; D after B releases.**

## Non-goals

- No server-side send queue, no delivery daemon, no message bus — sends are
  synchronous, state derives from tmux at request time (Constitution II).
- No auto-answering of walls of any kind; no credential handling ever.
- No caller-declared "this is a terminal" / "this is an agent" mode.
- No renames of shipped `rk mux` members.
