# HexoKit skill: messaging

Depth for one job: **choosing the right channel when agents talk to agents** — which verb answers which need, and how to spawn-then-deliver safely past boot screens and trust walls. This is the concept page; verb-reference depth (flags, gate matrices, report words, gotchas) lives in [`rk skill mux`](mux.md). Everything here is static and byte-identical on every invocation.

Gate first, as always — HexoKit is optional and may be absent:

```sh
command -v rk >/dev/null 2>&1 && [ -n "$TMUX_PANE" ] || exit 0
```

## The channel matrix

One standard, not two: whether the target pane runs a shell or an agent TUI is a property read from the pane (agent-state presence, foreground command), never something you declare. Pick the channel by the need:

| Need | Channel | Why this channel |
|------|---------|------------------|
| **Write** (message, answer, keystroke) | `rk mux send` (plain / `--answer` / `--force` / `--no-enter` / `--key` / stdin `-`) | Gated on the peer's agent state, paste-probed before Enter, non-submission detected after |
| **Read: screen** | `rk mux capture` | The painted frame + reconciled state — the *only* screen truth for alt-screen TUIs |
| **Read: state** | `rk mux await`, `rk mux panes`, `rk mux process` | Lifecycle without scraping |
| **Read: results** | **Artifact files** you tell the worker to write (a result file at an agreed path, awaited with `await --file`) | Agent TUIs run alt-screen with zero scrollback, so reading a transcript off the screen is structurally impossible — artifact-first is a consequence, not a preference |
| **Wait** | `rk mux await` (`--until` / `--any` / `--file` / `--ready`), composed `rk mux send --await` | Event-shaped: first sweep runs before any sleep, one wake per invocation, fleet wake under `--any` |
| **Conversation** (multi-turn, cross-provider) | An MCP bridge (e.g. `codex mcp-server`) | Tool-mediated dialogue is not pane-driving |

Two habits fall out of the matrix: tell a worker **where to write its result** and wait on the file (never scrape the screen for output), and use `capture` to *judge* a screen, not to *parse* one.

## Spawn and trust walls — the readiness standard

A freshly spawned agent TUI is not necessarily safe to type into: it may still be booting, or parked behind a first-run wall — a trust dialog, survey, theme picker, or login screen — that eats or misroutes anything delivered. The composite is **open bare → classify → answer → verified deliver**, with a strict split of labor.

**Classification is mechanical and rk-owned.** `rk mux await --ready %N` is the readiness gate. It reports one of:

| Report | Meaning | Your move |
|--------|---------|-----------|
| `ready %N (state)` | A reconciled agent state exists — hooks fired, the TUI is up. Nothing was typed into the pane | Deliver |
| `ready %N (echo)` | No state (hook-less agent), but the screen settled and a harmless sentinel echoed at a live input box (typed, checked, cleared with `C-u`) | Deliver (`send --force` — see the pairing below) |
| `parked %N` | The screen settled non-blank and the sentinel did **not** echo: the pane is behind a wall. Also reported, ahead of both ready signals, when Claude Code's `Not logged in · Run /login` notice is on screen (snippet: the notice) — its composer echoes and hooks may fire, but the agent cannot act; the notice paints 2–20 s after boot, so an earlier verdict cannot see it. Exit 0 — classification succeeded; the screen snippet is on stderr | Judge the wall (below) |
| `narrow %N (WxH)` | The pane is below the 80×20 readiness floor (either dimension), so the probe cannot be trusted; nothing was typed. Exit 0 — classification succeeded; the geometry and remedy are on stderr | Resize or relocate the pane (a bigger window or column), then re-run `await --ready` |
| `running` | `--timeout` expired — the timeout bounds YOU, never the pane | Re-arm or escalate |
| `gone` | The pane died (exit 1) | Respawn or report |

`booting` never returns: the wait blocks through boot churn and ends only on `ready`, `parked`, `narrow`, `gone`, or timeout.

**The scope rule.** The sentinel probe is typed only into **pre-delivery** panes — no agent state yet, nothing yet delivered. Against a live delivered worker, readiness verbs are illegal: a sentinel typed into a working agent's composer corrupts its next input. Once you have delivered, switch channels — wait with `await --until` / `await --file`, look with `capture`.

**Judgment is caller-side.** rk classifies; it never auto-answers a wall. What a `parked` wall wants — trust prompt, survey, theme picker — you decide from the stderr snippet, and answer with the standard write channel:

```sh
rk mux await --ready %5            # → parked %5 (snippet on stderr)
rk mux capture %5                  # look closer if the snippet isn't enough
rk mux send %5 --key Enter         # accept a trust prompt
rk mux send %5 --key Down          # move a picker selection
```

**Login and credential walls escalate to a human — never answer them.**

**The hook-less pairing.** An agent without hooks never carries agent state, so plain `send` (which gates on it) is not the follow-up — `--force` is:

```sh
rk mux await --ready %5 && rk mux send --force %5 '<prompt>'
```

Branch on the report word, not just the exit code: `parked` and `narrow` also exit 0 (they are classifications, not failures), so a bare `&&` would deliver into the wall or a too-small pane. The safety net if you get this wrong: `send`'s echo probe fails closed on any screen that does not echo the paste — no Enter, text staged, exit 1.

## Ask-and-wait, fleets, and answers

- **One round trip**: `rk mux send %5 "review this plan" --await` delivers, then blocks until the peer goes `idle` or `waiting` (asks back). Prefer it over separate `send` + `await`.
- **Structured receipts**: both verbs take `--json` — `send` returns `{"report","target","server","enter"}` (a nested `await` receipt under `--await`), `await` returns `{"report","target"?,"elapsed_ms","detail"?,"hint"?}` — the same report words as machine fields, so scripts branch without parsing a line (`running` is a success carrying `hint:"call again"`; `gone` is `ok:false` with `reason:"gone"`).
- **Fleet wake**: `rk mux await --any %1 %5 %9 --until waiting,idle` wakes on the FIRST pane needing attention — block on many agents instead of polling each.
- **Answering a question**: a `waiting` agent refuses plain sends; `rk mux send %5 "yes, go ahead" --answer` is the reply channel (the send IS the answer).
- **Never interrupt `active`**: the gate refuses plain and `--answer` sends to a working agent; that refusal is the convention, not an obstacle.

## Handing the operator a request

To hand the server's operator agent a work item — not to chat with a pane — use `rk operator request <template>`, the CLI door onto the operator-request lane (the same closed registry the dashboard's operator actions use):

```sh
rk operator request --list                       # the registry: ids, scope, declared flags
rk operator request brief-me                     # server-scoped: a standup digest of every tab
rk operator request fix-tab-name --window @7     # window-scoped: work about a subject tab
rk operator request spawn-task --text "add retry to the flaky poll"
```

Window-scoped templates (`fix-tab-name`, `annotate-tab`, `user-message`) require `--window @N`; the rest are server-scoped and reject it. `--text` is accepted only by `spawn-task`, `find-discussion`, and `user-message`; `--session` only by `update-annotations`. A **busy** operator is not a failure: the request queues and the verb reports `queued <template>` (exit 0) — with `--json` the receipt is `{"ok":true,"result":{"template":"…","queued":true}}` — and it drains when the operator goes idle. `user-message` (the chat template) skips the busy gate and is never queued.

Prefer this over `rk mux send` to the operator pane whenever a template fits: the daemon renders the prompt from facts it derives itself (Constitution X), the closed registry bounds what can be asked, and the busy gate protects a working operator. Raw `send` to the operator pane remains for free-text steering the registry does not cover.

## Where the depth lives

- [`rk skill mux`](mux.md) — every verb's flags, the send/kill gate matrices, delivery verification and recovery, `--any` fleet-wake protocol, report words, exit codes, gotchas.
- `rk mux -h` — the family grouped as messaging / pane mechanics / server ops.
- Results discipline and the readiness standard are cross-tool convention: any agent on this machine can follow this page against your panes, and you against theirs.
