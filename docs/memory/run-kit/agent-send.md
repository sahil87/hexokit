---
type: memory
description: "Agent-send backend — internal/transcript registry + transcript.Path (ErrInvalidRef/ErrTranscriptNotFound/ErrNoAdapter; six adapters — claude, codex, gemini, kimi, agy, opencode request-time export; copilot identity-only) for operator actuation, fork/resume, auto-name — plus the pane-typed injection engine (mode guard, sanitized paste, novelty probe, popup guard, gated Enter, recovery) behind POST /api/windows/{id}/send (target:\"agent\") and the operator-request routes."
---
# Agent Send

**Domain**: run-kit

## Overview

`internal/transcript` resolves a window's reconciled `@rk_pane_agent_session =
<provider>:<session-ref>` (from [agent-state](/run-kit/agent-state.md) § Agent
Session Identity) to the conversation it names. Its consumers are
server-side derivations — the operator-request handlers (transcript fact
pre-derivation via `transcript.Path`,
[operator-actuation](/run-kit/operator-actuation.md)), fork/resume,
closed-resume, and auto-name dispatch. The registry routes on the provider
prefix and the transcript read sits behind the optional `TranscriptLocator`
capability; six providers register adapters (`claude`, `codex`, `gemini`,
`kimi`, `agy`, `opencode` — § per-adapter locators below) while `copilot`
carries identity + lifecycle with NO adapter. A second optional capability,
`ConversationChecker`, gives the derive tick a cheap availability probe where
real resolution is request-priced (`opencode`). The operator facts corpus,
auto-name on idle, and agent-targeted send treat any provider whose transcript
resolves exactly like `claude`; fork/resume stays Claude-gated; no
terminal-scrollback fallback exists. Everything derives from disk at request
time (Constitution II). (nnqu, 260904-bf1l-agent-session-identity-rename)

The mutating half — the agent-send path — is the shared `internal/inject`
engine: rk *types into* the pane exactly as a human typist would — the pane
stays the agent's parent process (Constitution VI) — via a sanitized
named-buffer bracketed paste, a novelty echo probe, a composer-popup guard, a
probe-gated Enter, asymmetric post-Enter observation, and evidence-gated
recovery. Two API
surfaces consume the one engine: `POST /api/windows/{windowId}/send`
(`api/send.go` — the compose strip's delivery door, plus the selection
broadcast's `target:"agent"` mode) and the operator-request routes
(`api/operator.go`, via `injectIntoPane`). The cron deliverer
(`internal/cron`'s `EngineDeliverer`) is a third engine client, sending
scheduled fires on its own per-client buffer `rk-cron-send` (see
[cron](/run-kit/cron.md) § EngineDeliverer). The generic
`POST /api/windows/{windowId}/keys` endpoint is a distinct contract, untouched
by the injection path.

## Requirements

### Requirement: Provider registry + `TranscriptLocator` (`adapter.go`)
`adapter.go` SHALL declare one `Adapter` interface — a single `Provider() string`
method (the routing key), with no long-lived per-ref state held between calls —
plus a package-level `map[string]Adapter` registry guarded by a `sync.RWMutex`,
`Register`/`Lookup`, and the `ErrNoAdapter` sentinel. Lookup is by the
`@rk_pane_agent_session` provider prefix; a well-formed but unregistered
provider returns `ErrNoAdapter` (the API layer maps it to a 404-class JSON
error, so presence-gating stays provider-agnostic). Six providers register
adapters, each from its own file's `init()`: `claude`, `codex`, `gemini`,
`kimi`, `agy`, `opencode` (§ per-adapter locators below); `copilot` registers
none — identity + lifecycle only (§ Copilot registers no adapter below). (nnqu)

Beside the core interface, `adapter.go` declares the OPTIONAL `TranscriptLocator`
capability — `TranscriptPath(ref string) (string, error)`, resolving a session
ref to its transcript's absolute on-disk path — plus a package-level
`Path(provider, ref)` convenience that routes through `Lookup` and
type-asserts to the capability, returning `ErrNoAdapter` for an unregistered
provider or one without it. The capability stays OFF the `Adapter` interface so
the interface remains provider-neutral (an identity-only provider — `copilot` —
or a future protocol-based provider has no on-disk transcript), and every
implementing adapter MUST keep its ref-format guard in front of every path
resolution (§ per-adapter locators below). Its consumers are the
operator-request handler's fact pre-derivation
([operator-actuation](/run-kit/operator-actuation.md)), fork/resume,
closed-resume, and auto-name dispatch — the operator facts corpus, auto-name,
and agent-targeted send treat any provider whose transcript resolves exactly
like `claude`, while fork/resume stays Claude-gated and no terminal-scrollback
fallback exists. (260822-fih1, nnqu)

A second OPTIONAL capability, `ConversationChecker` —
`ConversationAvailable(ref string) bool` — answers conversation availability
through a CHEAP probe (no subprocess, no unbounded scan) for the derive tick,
where real resolution is request-priced; `opencode` implements it as
well-formed-native-ref + `opencode` binary on PATH, and every provider without
it resolves for real through its bounded lookups. (nnqu)

#### Scenario: Unregistered provider returns the sentinel
- **GIVEN** an agent session ref with an unregistered provider
- **WHEN** the registry is asked for an adapter
- **THEN** `Lookup` returns `ErrNoAdapter`, not a panic or a generic failure.

### Requirement: Claude adapter — locate by UUID glob with a path-traversal guard (`claude.go`)
The Claude adapter SHALL resolve the transcript root as `$CLAUDE_CONFIG_DIR` if
set, else `~/.claude`, and locate the file by glob `{root}/projects/*/<ref>.jsonl`
(the session UUID *is* the filename — no encoded-cwd derivation, robust to
slug-rule drift). **Before ANY filesystem use** the ref MUST match strict UUID
shape (`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, `uuidRe`)
— this is the path-traversal guard (Constitution I applied to file paths): a value
carrying `/`, `..`, or glob metacharacters can never reach the glob. A non-UUID
ref returns `ErrInvalidRef` before touching disk; a valid UUID with no matching
file returns the distinguishable `ErrTranscriptNotFound`. Multiple matches (a
resumed session copied across cwds) → first match (they name the same session).
The adapter also implements the registry's optional `TranscriptLocator`
capability (§ Provider registry + `TranscriptLocator` above): `TranscriptPath(ref)` delegates to
`locateTranscript`, so the strict UUID guard stays in front of the one path
resolution site reachable through the export (its caller is the
operator-request seam — [operator-actuation](/run-kit/operator-actuation.md)).
(260822-fih1)

#### Scenario: A non-UUID ref is rejected before any filesystem access
- **GIVEN** a ref containing `../`, an absolute path, or glob metacharacters
- **WHEN** the adapter is asked to locate the transcript
- **THEN** it returns `ErrInvalidRef` with no glob/stat/open performed.

### Requirement: Codex adapter — fixed-depth rollout glob, lowercase fold (`codex.go`)
The Codex adapter SHALL resolve the transcript root as `$CODEX_HOME` if set,
else `~/.codex`, guard the ref with a case-insensitive UUID shape check before
any filesystem use, and locate the file by the FIXED-DEPTH glob
`sessions/*/*/*/rollout-*-<ref>.jsonl` with the validated ref folded to
lowercase (Codex writes lowercase-UUID filenames). There is deliberately NO
case-insensitive or whole-history fallback: a miss is bounded and never rescans
all history. (nnqu)

### Requirement: Gemini adapter — prefix-8 glob with full-id verification (`gemini.go`)
The Gemini adapter SHALL use the fixed `~/.gemini` root (no env override), glob
`tmp/*/chats/session-*-<ref[:8]>.jsonl` (the chat filename carries only the
first 8 hex chars of the session id), then verify the full session id against
the candidate file's first record (its `sessionId` field, read under a 1 MiB
bound). A prefix collision without a full-id match returns
`ErrTranscriptNotFound` — never a wrong transcript. (nnqu)

#### Scenario: An 8-char prefix collision never resolves the wrong transcript
- **GIVEN** a candidate chat file whose name matches the ref's first 8 hex
  chars but whose first record carries a different full `sessionId`
- **WHEN** the adapter is asked to locate the transcript
- **THEN** it returns `ErrTranscriptNotFound`.

### Requirement: Kimi adapter — session index honored only under the root (`kimi.go`)
The Kimi adapter SHALL resolve the root as `$KIMI_CODE_HOME` if set, else
`~/.kimi-code`, guard the ref to safe tokens (alphanumerics, `-`, `_` — admits
`session_<uuid>`), and scan `session_index.jsonl` (1 MiB bound) for the ref's
`sessionDir`, honoring that directory ONLY when it sits under the root's own
`sessions/` tree — a client-influenced path outside the root is never trusted.
The fallback is the bounded glob `sessions/*/<ref>/agents/main/wire.jsonl`.
(nnqu)

### Requirement: agy adapter — deterministic brain-path stat (`agy.go`)
The agy adapter SHALL resolve the deterministic path
`~/.gemini/antigravity-cli/brain/<lowercased-uuid>/.system_generated/logs/transcript.jsonl`
by stat — no scan (verified on the installed 1.1.11). (nnqu)

### Requirement: OpenCode adapter — request-time native export materialization (`opencode.go`)
OpenCode keeps NO on-disk transcript; the adapter SHALL resolve a ref by
running the native `opencode export --sanitize -- <sessionID>` (verified
1.18.25) and materializing the JSON AT REQUEST TIME ONLY — never on the derive
tick. The ref guard `^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$` matches the native
mixed-case id shape, and argv carries the `--` end-of-options separator.
Artifacts land in the user-private `opencode-export/` dir under the `internal/apphome`-resolved state home (`${XDG_STATE_HOME:-~/.local/state}/hexokit/opencode-export/`; dual-read with the legacy `run-kit` home for one release, cold-started by the home migration)
directory (0700; a symlink or foreign-owned dir is refused; too-open perms are
tightened; writes are CreateTemp O_EXCL 0600 siblings committed by atomic
rename — a preplaced symlink target is replaced, never followed; 32 MiB stdout
cap; 15s timeout). Retention is consumer-aware: every returned path stays
valid for a 1-hour grace (exceeding the operator queue's 30-minute TTL, so a
queued request never dangles); past-grace artifacts are pruned on write; and at
the 16-artifact in-grace cap a new materialization is REFUSED with
`errExportCapacity` rather than evicting a path already handed out — the
capacity check counts every in-grace artifact INCLUDING one for the ref being
resolved, so re-resolving an already-exported ref at full capacity is refused
until its grace expires (accepted corner: 16+ distinct sessions within one
hour). The prune-check-write critical section is mutex-serialized. An unknown
session (non-zero export exit or empty output) returns `ErrTranscriptNotFound`;
an oversized export, unsafe directory, or unstartable binary returns a plain
500-class error. The operator facts builder degrades a refusal by omission, so
a rendered prompt never embeds a dangling path. (nnqu)

#### Scenario: A full in-grace cap refuses instead of evicting
- **GIVEN** 16 in-grace export artifacts in `opencode-export/`
- **WHEN** a resolution is requested — including a re-resolution of a ref whose
  artifact is among the 16
- **THEN** it is refused with `errExportCapacity`; no handed-out path is
  evicted, and the facts builder omits the transcript fact.

### Requirement: Copilot registers no adapter — identity + lifecycle only
`copilot` SHALL have no transcript adapter: a session's identity does not
determine a conversation file — `transcriptPath` rides only the
agentStop/preCompact/subagent payloads (none hooked), and
`~/.copilot/session-state/<id>/` holds workspace metadata with no per-session
transcript file (observed evidence on the verified 1.0.78 install). `Lookup`
therefore returns `ErrNoAdapter` for `copilot`, and every presence gate treats
it as identity-only. (nnqu)

## Send Path

The mutating half of the subsystem: one shared injection engine
(`internal/inject`) that types a message into a window's resolved pane, consumed
by two API surfaces over the same `agentSendEngine` + `agentSendTmux` adapter pair
(`api/send.go`). The compose strip's `POST /api/windows/{windowId}/send`
(`handleWindowSend`) names an INTENT (`mode`) and resolves the target pane
server-side per request — the client supplies only a windowID + text, never a
pane or session ref. By default the target is the window's **active** pane with
no agent-session requirement; the optional `target:"agent"` body field (the
selection broadcast's and the quake terminal's mode) instead resolves
the window's **agent** pane via the
shared `sessions.ResolveAgentPane` rollup (active-pane-first among
`@rk_pane_agent_session` carriers, else the first carrier) and fails CLOSED with
a `404` ("no agent session for this window") when no pane carries an agent
session — the text is never pasted into a non-agent shell. An unknown `target`
value is a `400`. All four modes use the
engine: `submit`/`insert-line` call `Engine.Send`, `raw` calls `Engine.SendRaw`,
`enter` calls `Engine.PressEnter` — so every send enters the same per-pane
serialization domain and runs the pane-mode guard first (a copy-mode pane would
eat the paste), while probed modes retain the sanitize → paste → probe →
optional Enter → observation/recovery contract and machine-readable 409 mapping
([api-and-sockets](/run-kit/api-and-sockets.md);
[ui/compose-and-bottom-bar](/run-kit/ui/compose-and-bottom-bar.md)) (260830-s7wp,
260904-39bp, 260904-bf1l-agent-session-identity-rename). The operator-request
handlers (`api/operator.go`) deliver rendered
prompts through the SAME engine (`submit:true`) via the shared `injectIntoPane`
adapter into the OPERATOR window's resolved pane — same per-(server,paneID) lock,
shared deadline, sanitize, novelty probe, observation, and recovery — after their
own session resolution and busy gate
([operator-actuation](/run-kit/operator-actuation.md); that endpoint's busy
policy is REJECT, unlike this path's Allow + probe below) (260822-fih1). The
engine's tmux primitives are the pane-targeted `internal/tmux` wrappers (§
Pane-targeted tmux primitives and the injection interface).

**Selection broadcast = a client-side fan-out over `/send`.** The sidebar
selection's bulk prompt broadcast (`Selection: Send prompt to N agents` →
`executeBulkSend` — [ui/sidebar](/run-kit/ui/sidebar.md) § Window-Row
Multi-Select) sends one `sendToWindow(server, windowId, text, "submit", "agent")`
per selected window, **N-sequentially** and continue-on-error, each request
carrying its own `?server=` (a selection may span tmux servers). There is **no
batch endpoint and no batch body**, and every per-request semantic is untouched:
the whole-sequence lock, the shared injection deadline, sanitize pass, novelty
probe, post-Enter observation, and evidence-gated recovery all run per window. A
window with no agent pane returns the fail-closed `404`, which the batch records
as that recipient's failure and steps past rather than aborting the remaining
sends — never a paste+Enter into the window's active shell pane. A probe failure
or submit-unverified outcome surfaces as that window's structured `409` (§
Injection 409 outcomes), recorded the same way. The broadcast's own `200` count
is what the frontend calls **delivered**, and it drives whether the composed
prompt is cleared or retained for a retry. (260808-ebgs, 260904-39bp)

**The quake terminal is the other `target:"agent"` consumer**
([ui/quake-terminal](/run-kit/ui/quake-terminal.md)). Its compose strip
delivers via `sendToWindow(server, operatorWindowId, text, "submit", "agent")`
— one POST per Enter, an in-flight guard against re-send, and a whitespace-trim
floor. Busy semantics are this path's Allow + probe: no client-side busy gate
and no operator-queue interaction (a quake terminal message is a human steer —
[operator-actuation](/run-kit/operator-actuation.md)). The quake terminal's error
contract differs from the broadcast's per-recipient accounting: a structured
`409` (probe failure, `staged_send_failure`, submit-unverified — the thrown
`ApiError` messages) surfaces INLINE in the quake terminal as an error line between
terminal and compose, never as a toast, and the composed text is preserved in
the input for retry or edit. (260904-qa85-operator-chat-console)

### Requirement: Send endpoint `POST /api/windows/{windowId}/send`
The backend SHALL expose `POST /api/windows/{windowId}/send?server={server}`
(mutation ⇒ POST, Constitution IX), implemented as `handleWindowSend`
(`api/send.go`). The JSON body is `{"text": "<message>", "mode":
"submit"|"insert-line"|"raw"|"enter", "target"?: "agent"}`
(`windowSendRequest`). The client names an INTENT, never a mechanism: `mode`
selects the injection strategy (`submit` = paste + probed Enter; `insert-line` =
insert-without-submit — the text is pasted into the pane's input box but the
final gated Enter is skipped, § Pane-targeted injection sequence; `raw` = raw
paste; `enter` = a bare Enter) and the handler picks the tmux mechanics, so a
caller cannot make verification depend on the shape of the text it sends.
Validation order: `parseWindowID` (`400`) → JSON decode (`400`) → mode allow-list
(`400`) → target allow-list (absent or `"agent"`; anything else `400`) →
`inject.Sanitize(text)` → emptiness check (`400`; `enter` is exempt — it carries
no text). The target pane is then re-resolved server-side (§ Server-resolved
pane) before injecting. Success is `200 {"ok":true}` for every mode. The existing
generic `POST /api/windows/{windowId}/keys` endpoint SHALL be left untouched
(different contract, possible external callers).

#### Scenario: Malformed id or empty text is rejected before any injection
- **GIVEN** a request with a malformed `{windowId}`, an undecodable body, an
  unknown `mode` or `target`, OR a `text` that is empty/whitespace-only (any
  non-`enter` mode)
- **WHEN** `handleWindowSend` runs
- **THEN** it returns `400` with a `writeError` JSON body and performs no tmux
  injection.
- **AND GIVEN** a body carrying no `target` field, **THEN** the default path
  resolves the window's active pane and behavior is mode-for-mode unchanged by
  the field's absence; **AND GIVEN** `target:"agent"` on a window whose panes
  carry no `@rk_pane_agent_session`, **THEN** the response is `404` ("no agent
  session for this window") with zero tmux injection calls.

### Requirement: Send-text sanitization at the handler boundary
`handleWindowSend` SHALL sanitize `body.Text` via the exported pure helper
`inject.Sanitize` (`internal/inject`) immediately after the JSON decode and BEFORE the
whitespace-only emptiness check. `inject.Sanitize` normalizes `\r\n` and lone `\r`
to `\n`, then drops every control rune per `unicode.IsControl` — C0 (U+0000–U+001F),
DEL (U+007F), and the C1 range (U+0080–U+009F, including the single-byte CSI
U+009B) — EXCEPT `\n` and `\t`, which are legitimate message content (multiline
messages and indented code). Ordinary text, non-ASCII runes (accents, emoji), `\n`,
and `\t` pass through unchanged. Because the sanitize runs before the emptiness
check, a message that is entirely control bytes collapses to the empty string and
takes the existing `400` path without touching tmux. Because it runs before pane
resolution and injection, every downstream consumer (`inject.Needle`, the
collapsible-paste detection via `strings.Contains(text, "\n")`, the engine's
set→paste critical section, the echo
probe) operates on the already-sanitized text. The sanitize is caller-side policy
only — the `internal/tmux` wrappers stay byte-faithful (Constitution I).

#### Scenario: ESC and other control bytes stripped; all-control text 400s
- **GIVEN** a send whose text embeds an ESC (`0x1B`) that would form the
  bracketed-paste-end sequence `\x1b[201~`
- **WHEN** `handleWindowSend` sanitizes it
- **THEN** the ESC is stripped (leaving the inert literal `[201~`), so the text
  recorded at `set-buffer` cannot terminate the paste early to inject live
  keystrokes; C0/DEL/C1 controls are likewise removed while `\n`/`\t`/accents/emoji
  survive and `\r\n`/`\r` become `\n`.
- **AND GIVEN** a send whose text is entirely control bytes, **THEN** it collapses
  to empty and the handler returns `400` ("Text cannot be empty") with no
  tmux injection.

### Requirement: Server-resolved pane (never trust a client ref)
The handler SHALL derive the target **pane** server-side from one request-scoped
`FetchSessions` snapshot, per the body's `target`: the default (absent `target`)
resolves the window's ACTIVE pane (`resolveWindowActivePane` via `activePaneID`);
`target:"agent"` resolves the window's AGENT pane (`resolveWindowAgentPane`) via
the shared `sessions.ResolveAgentPane(panes) (provider, ref, paneID)` rollup —
active-pane-first among `@rk_pane_agent_session` carriers, else the first
carrier — the same helper the window-level agent-session-identity rollup
(`rollupAgentSession`) delegates to. Injection targets that `paneID`, NEVER the
window id in the agent case: a window `-t` target routes to the session's
*active* pane, which in a split may not be the agent pane. The client supplies
neither a pane nor a session ref. A `FetchSessions` failure maps to `500`; an
absent window maps to `404` ("window not found") on the default path, and an
absent window OR a window with no agent-session-carrying pane maps to `404`
("no agent session for this window") on the agent path — fail-closed, so a
selection broadcast never lands in a non-agent shell. (260904-39bp,
260904-bf1l-agent-session-identity-rename)

#### Scenario: Injection targets the resolved pane, not the window
- **GIVEN** a window `@N` whose resolved agent pane is `%2` while `%1` is active
- **WHEN** a `target:"agent"` send resolves its target
- **THEN** every injection subprocess targets `%2` (the resolved `PaneID`), never
  `@N`; **AND GIVEN** `FetchSessions` errors → `500`; **AND GIVEN** no
  agent-session-carrying pane → `404` with no injection.

### Requirement: Pane-targeted injection sequence via argv slices
On a resolved pane the handler SHALL inject the message through the shared
`internal/inject` engine — reached via the thin adapter seam
(`injectIntoPane`, `api/send.go`, delegating to the package-level
`agentSendEngine = inject.NewEngine(tmux.AgentSendBuffer)`) — running this exact
ordered sequence,
every subprocess an argv slice (Constitution I) targeting the `paneID`, each
spawned through the shared runner core with `TMUX`/`TMUX_PANE` stripped from the
child env ([tmux-runner](/run-kit/architecture/tmux-runner.md) § tmux Runner Core):
1. **Pane-mode guard** — `ClearPaneMode` (the `inject.Tmux` method delegating to
   the single decision site `tmux.ClearPaneModeCtx`: probe `#{pane_in_mode}`,
   one `send-keys -X cancel` only when in a mode, no re-probe). It is the FIRST
   pane-touching step, taken inside the per-pane lock and BEFORE the baseline
   capture — a mode cancel repaints the frame, so a pre-cancel baseline would be
   the copy-mode screen, poisoning the probe floor and recovery's
   baseline-equality check. A guard failure aborts pre-paste with the plain
   wrapped error → `500` (nothing was delivered; retrying is safe).
2. **Baseline capture** — `CapturePane` the pane tail BEFORE mutating anything (the
   probe floor, § Novelty echo probe).
3. `set-buffer -b rk-agent-send -- <text>` — text as one discrete argv element (no
   shell string, no stdin — `tmuxExecServer` has no stdin plumbing). The **`--`
   option terminator is load-bearing**: without it a message that starts with a
   dash (`--force is broken`) is parsed as `set-buffer` flags and hard-fails; with
   it, leading-dash text stores verbatim (verified tmux 3.6a). A **named** buffer
   (`tmux.AgentSendBuffer = "rk-agent-send"`) avoids clobbering the user's anonymous
   buffer stack.
4. `paste-buffer -d -p -b rk-agent-send -t <paneID>` — `-p` bracketed paste (the
   Claude Code TUI enables bracketed paste, so multiline + special characters land
   as one literal block, no per-line submission); `-d` deletes the buffer after
   pasting so the buffer set stays clean.
5. **Probe** (§ Novelty echo probe) — only on success:
6. **Composer-popup guard** (`consumePopup`) — submit-only, evidence-gated on
   the two frames already in hand: when a `composerPopupMarkers` entry (one
   today — codex's skill-autocomplete footer `Press enter to insert`, opened by
   pasting a bare skill token like `$fab-operator`) NEWLY appears in the probe's
   winning capture vs the pre-paste baseline (strict increase through the one
   `stripForProbe` normalization — a stale marker copy in scrollback is a floor
   to beat, the novelty probe's discipline), send one Enter to consume the popup
   (the TUI processes it as popup-insert, not submit), wait one `ProbeSettle`,
   and re-capture a fresh pre-Enter frame so the observation baselines on the
   post-popup frame — the popup *closing* would otherwise satisfy the
   changed-frame no-claim branch and mask a non-submission as success. The pty
   processes the popup Enter before the submit Enter, so ordering — not the
   re-capture — carries correctness; a false positive is benign (the extra Enter
   submits the staged text, the submit Enter no-ops on the emptied composer). No
   new marker ⇒ zero added calls, captures, or waits. Guard failures classify as
   `StagedSendFailure` (post-paste, pre-submit). (q7mj)
7. `send-keys -t <paneID> Enter` — the literal `Enter` key, sent ONLY after a
   successful probe **AND** when `submit` is true.
8. **Post-Enter observation** — sleep then capture over `SubmitBackoff`
   (`40/80/160/320/640ms`), exiting on the first normalized frame change. A
   changed frame makes no claim about submission and returns success. Only a
   frame unchanged through every step with the established paste echo still
   present is evidence of non-submission.
9. **Evidence-gated recovery** — only on that non-submission verdict, send
   pane-scoped `C-u` up to `ClearAttempts = 4` until the normalized frame equals
   the pre-paste baseline (the shared `clearToBaseline` C-u/capture/baseline-compare
   discipline — the readiness sentinel probe in `ready.go` clears through the same
   helper), then re-paste, re-probe, re-run the composer-popup guard against the
   cleared frame as its floor (the re-paste can reopen the popup), send Enter,
   and observe over the first `SubmitRetryBackoffSteps = 3` ladder steps.
   `SubmitRetries = 1`.

`injectIntoPane(ctx, server, paneID, text, submit bool)` is the thin adapter
that forwards the resolved boolean to `inject.Engine.Send` (the `/send` route's
`submit` mode passes `true`, `insert-line` passes `false`; the operator-request
routes always pass `true`). **`submit:false`
(insert-without-submit) skips steps 6–9** — the pane-mode guard, baseline
capture, handler-boundary sanitize, named-buffer set/paste, novelty echo probe (a
probe failure still returns the structured `409`, Enter irrelevant but the text left
recoverable in the composer), the engine's per-`(server,paneID)` whole-sequence lock
and set→paste critical-section mutex, and the handler's single
`agentSendTotalBudget` deadline still apply.
The insert-only path still requires a passing probe (the paste must have echoed); it
just leaves the text staged in the pane's input box without pressing Enter, so a
human — or a later submit — completes it.

There SHALL be NO `agentState` gate and NO server-side queue (busy policy =
Allow + probe, Constitution II). The text reaching `set-buffer` is the
handler-sanitized string (§ Send-text sanitization) — control bytes stripped,
CR/CRLF normalized to `\n`; from that point delivery to tmux is verbatim. Newlines,
tmux key names (`Enter`, `C-c`), and leading dashes in the sanitized text are all
delivered literally — never interpreted as keys/flags nor submitted per-line.
There SHALL be NO pre-Enter quiescence gate on either the initial or recovery
path — the composer-popup guard is not one: it waits for nothing on the
no-popup path (zero added captures, sends, or sleeps; it reads two frames
already in hand) and acts only on marker-novelty evidence.

#### Scenario: Key-name / leading-dash text is delivered literally
- **GIVEN** a resolved pane and text `"--force is broken\necho Enter"`
- **WHEN** injection runs
- **THEN** the order is pane-mode guard → baseline → set-buffer (`--`-terminated)
  → paste-buffer →
  probe → composer-popup guard (a no-op here — no marker newly appears) →
  send-keys → observation, the text is one literal argv element (never
  parsed as flags/keys), and Enter is a separate step gated on the probe.
- **AND GIVEN** `submit:false` with a passing probe, **THEN** set-buffer/paste/probe
  all run against the resolved pane and `SendEnterToPane` is NEVER called (response
  still `200 {"ok":true}`); **AND GIVEN** `submit:false` with a failing probe,
  **THEN** the response is `409` and no Enter is sent.

### Requirement: NOVELTY echo probe (fail-closed), settle + bounded retry
Before Enter the handler SHALL verify the pasted text ECHOED into the pane's live
input buffer, using **novelty**, not mere presence: it counts a probe **needle**
(and, when the paste is *collapsible*, the paste-collapse placeholder; and, when
the paste is *imageish*, the image-chip placeholder) in the
pre-paste **baseline** capture, then requires that count to strictly INCREASE in a
post-paste capture. The needle is derived from the LAST non-empty line of the text,
whitespace-stripped (needle and capture share the ONE `stripForProbe`
normalization — ANSI escapes, all whitespace, and every box-drawing /
block-element rune in U+2500–U+259F dropped — so an ~80-col TUI wrap, or a
bordered composer that reflows its own frame around the wrapped text, cannot
split the fragment) and capped to the last
`inject.NeedleMaxLen = 40` runes. `stripForProbe` is the single normalization
site for `Needle`, `CountOccurrences`, `verifySubmit`'s frame comparison,
`clearToBaseline`, and the readiness probe (`ready.go`), so every needle and
every capture stay under one rule. A paste is **collapsible** when it is multiline
OR a single line of at least `inject.CollapseMinRunes = 200` runes — the Claude
Code TUI collapses such a paste into a chip, so the chip is a valid fresh-echo
signal. `pasteCollapseRe` matches BOTH chip forms whitespace-stripped:
`[Pasted text #N +M lines]` (multiline collapse) and the suffix-less
`[Pasted text #N]` (long-single-line collapse), with the `+M lines` suffix optional.
The chip counts as a successful echo ONLY when the paste is collapsible and ONLY as
a *fresh* occurrence vs baseline; a short single-line send keeps exact-needle-only
matching. A paste is **imageish** when the text, whitespace-trimmed, is a single
line ending in an image extension (case-insensitive `.png`/`.jpg`/`.jpeg`/`.gif`/
`.webp` — `isBareImagePath`): the Claude Code TUI renders exactly that paste shape
as an `[Image #N]` chip instead of echoing the path (empirical, CC 2.1.260 — chips
at every length for EXISTING files, beating the paste-collapse chip; `.svg`/`.bmp`,
nonexistent paths, mixed text+path, and multiple newline-separated paths stay raw
text). `imageCollapseRe` matches the whitespace-stripped `[Image #N]` chip, counted
ONLY when the paste is imageish and only as a fresh occurrence vs baseline. The
imageish arm is EITHER-signal — chip-vs-raw depends on filesystem state the engine
cannot see, so a fresh raw-needle echo of an image path also passes; the
attachment-only dashboard send (a bare uploaded-path line) rides this arm.
A short settle (`inject.ProbeSettle = 80ms`)
precedes the first capture, then up to `inject.ProbeAttempts = 8` captures with an
`inject.ProbeGap = 80ms` gap (settle/gap are package **vars** solely so tests can
shrink them). The wall-clock probe ceiling is about 640ms (`80 + 7*80`), shared
with the post-Enter observation tail and bounded recovery under the caller's 4s
deadline; the first successful capture still returns after one settle. The probe
**fails closed**: an empty needle (a last line that strips to empty — e.g. a
pure frame row like `└────┘` — is skipped for the previous non-empty line; a
message that is ALL frame glyphs yields an empty needle and `Engine.Send`'s
empty-needle guard refuses before touching the buffer), a pane that scrolls
between baseline and probe, or a count that never rises → `inject.ProbeFailure` → no
Enter, `409`. This is the guard against a blind Enter into e.g. a permission
dialog. A probe `CapturePane` subprocess error or context failure is NOT a clean
miss — the paste already landed, so it surfaces as `inject.StagedSendFailure` →
`409` (§ Injection 409 outcomes), the staged-text recoverable state. (Pre-paste
failures — pane-mode guard, baseline capture, set-buffer, paste-buffer — keep the plain
wrapped-error → `500` path: nothing was delivered.)
(260830-s7wp)

#### Scenario: A stale chip / common needle already in-frame does not false-pass
- **GIVEN** a baseline capture that ALREADY contains the needle or a paste-collapse
  chip (e.g. a prior send's 409 left its text in the composer, or a short needle
  like `ok`)
- **WHEN** the paste does not add a fresh occurrence (or the pane scrolls)
- **THEN** the count does not strictly increase, so no Enter is sent and the
  response is `409` — the stale occurrence is a floor to beat, not a false positive.
- **AND GIVEN** the text (or, for a collapsible paste, its paste-collapse chip in
  either form) newly appears within the retry budget, **THEN** Enter is sent and the
  response is `200 {"ok":true}`.

### Requirement: Composer-popup guard consumes a paste-opened popup before the submit Enter
On the submit path — initial and recovery — the engine SHALL detect a composer
popup that the paste itself opened and consume it before the submit Enter.
Detection is `popupNewlyOpen(frame, floor)`: any `composerPopupMarkers` entry
(stripped through the one `stripForProbe` site, exact-substring arm of
`CountOccurrences`) whose count in the probe's winning capture strictly exceeds
its count in the floor frame (the pre-paste baseline initially; the cleared
frame on recovery). On detection, `consumePopup` sends one Enter, waits one
`ProbeSettle`, and re-captures the pre-Enter frame at `ProbeCaptureLines`, and
the observation compares against that fresh frame. The guard SHALL NOT run when
`submit` is false (the popup stays open for the human alongside the staged
text). Guard-internal failures (refused Enter, failed re-capture, ctx
cancellation in the settle) classify as `StagedSendFailure` — post-paste,
pre-submit. The marker table carries empirical TUI strings (the
`CollapseMinRunes`/`imageCollapseRe` class); the sole entry is codex's
skill-autocomplete footer, which opens when the composer holds exactly a bare
skill token — token-plus-arguments does not trigger it — and consumes Enter as
*insert* (verified codex 0.153.4). (q7mj)

#### Scenario: Bare skill token into a codex pane submits
- **GIVEN** a codex pane and the typed-delivery text `$fab-operator`, whose
  paste opens the skill-autocomplete popup in the probe frame
- **WHEN** the submit path proceeds past the successful probe
- **THEN** exactly one popup-consuming Enter precedes the submit Enter, a fresh
  frame is captured between them, and the message submits (Enter #1 =
  popup-insert, Enter #2 = submit — pty ordering)
- **AND GIVEN** a marker occurrence already present in the baseline (stale
  scrollback copy) with no new occurrence, **THEN** the guard does not fire and
  the call sequence is byte-identical to the guardless engine

### Requirement: Post-Enter observation detects non-submission only
After each Enter the engine SHALL compare `stripForProbe`-normalized whole-pane
captures with the echo probe's winning capture. The first changed frame SHALL
return success immediately without claiming that submission occurred. Only a
frame unchanged through every `SubmitBackoff` step with the paste echo still
present under `CountOccurrences(capture, needle, collapsible, imageish)` SHALL
authorize recovery. Any unchanged frame without that echo SHALL return
`inject.SubmitUnverified` without recovery. Context cancellation and capture
errors during observation SHALL surface as `inject.SubmitUnverified` wrapping the
cause — Enter was already sent, so submit-unconfirmed is the honest state.

Recovery SHALL re-paste only after a post-`C-u` capture is normalized-equal to
the pre-paste baseline. It SHALL make at most `SubmitRetries = 1` retry, use the
first three observation steps after that retry, and return
`inject.SubmitUnverified` when the clear cannot be established or the retry
still has no changed frame. Within a retry, a failure after the re-paste but
before the retry's Enter classifies staged (`inject.StagedSendFailure`); a
failure after the retry's Enter is submit-unverified. A frame change caused by a spinner, streaming output,
a status line, or a submit follows the same no-claim success branch.

#### Scenario: Changed frames never authorize recovery
- **GIVEN** a pane whose frame changes at any observation step
- **WHEN** the engine observes it after Enter
- **THEN** the request succeeds with no `C-u` or re-paste and with no assertion
  that submission was confirmed.
- **AND GIVEN** a frame byte-identical through every step with the paste echo
  still present, **THEN** recovery runs only after a baseline-equal clear.

### Requirement: Injection 409 outcomes remain distinguishable
On probe failure the handler SHALL send no Enter and return `409` with a structured
message that names the recoverable state and steers away from a duplicating retry:
`"agent input not ready — message pasted but not echoed; Enter withheld. The text
remains in the agent's input — check the terminal view before retrying, as a
resend would duplicate it."` The pasted text legitimately remains in the TUI input
box (visible, recoverable) — strictly better than a blind Enter. The failure is
surfaced, never silent. The retry hint matters because the paste (not the Enter)
already landed, so an identical resend would paste a SECOND copy and submit doubled
text.

On `inject.StagedSendFailure` — an infrastructure failure AFTER the paste landed
but BEFORE Enter was sent (a probe capture error, a context failure mid-probe,
or a refused `send-keys Enter`) — the handler SHALL return `409` with code
`staged_send_failure` and the sentinel's staged-text message: the text IS staged
in the pane, a resend would duplicate it, and the recovery is pressing Enter in
the pane.

On `inject.SubmitUnverified` the handler SHALL return `409` with the sentinel's
distinct submit-unconfirmed message, wrapping the underlying cause when one
exists (post-Enter capture/deadline faults surface here). Enter has been sent in
this case, so the message SHALL state that the payload may or may not have
landed and direct the caller to capture the pane before resending.
`ProbeFailure`, `StagedSendFailure`, and `SubmitUnverified` SHALL remain
distinct error types because they give different resend guidance.

#### Scenario: Probe failure leaves the paste visible and withholds Enter
- **GIVEN** a paste whose echo cannot be verified across all retries
- **WHEN** the probe exhausts
- **THEN** no Enter is sent, the response is `409` with the retry-hinted message,
  and the pasted text stays in the agent's composer.
- **AND GIVEN** a post-paste, pre-Enter infrastructure failure (e.g. a refused
  `send-keys Enter`), **THEN** the response is `409` with code
  `staged_send_failure` and the staged text stays in the agent's composer.
- **AND GIVEN** post-Enter non-submission whose bounded recovery does not produce
  a changed frame, **THEN** the response is `409` with the submit-unconfirmed
  message.

### Requirement: Per-(server,paneID) whole-sequence lock + shared-buffer mutex
Concurrent injections SHALL be serialized so no two cross texts or double-submit. The
`internal/inject` engine holds a **per-(server,paneID) mutex** (a guarded, never-evicted
`map[string]*sync.Mutex`, keyed `server\x00paneID`) across the WHOLE sequence
(pane-mode guard → baseline → set → paste → probe → Enter → observation/recovery
→ return) so a
second send to the SAME pane only
begins after the first fully finishes — closing the same-pane double-paste window
(two sends racing one composer both pasting before either probes → merged
submission). `Engine.SendRaw` holds that lock across guard → set-buffer → raw
paste, and
`Engine.PressEnter` holds it across guard → Enter, so neither primitive can interleave
with a probed sequence on the same pane. DISTINCT panes stay fully concurrent
(each takes its own lock). Because
the named tmux buffer (`rk-agent-send`) is a single server-wide resource with rk as
its sole writer, the set → paste critical section is ADDITIONALLY guarded by a small
per-engine mutex (the engine's `setPasteMu`) **nested inside** the per-pane lock — held
only for those two fast subprocesses, including `SendRaw` — so cross-pane sends cannot interleave as
A-set / B-set / A-paste (pane A would receive B's text; B's own `-d` paste would
500 on the already-deleted buffer). (260830-s7wp)

#### Scenario: Same-pane sends serialize; distinct panes stay concurrent
- **GIVEN** two concurrent sends to the same `(server,paneID)`
- **WHEN** both run
- **THEN** the second observes the first's completed sequence (never an in-flight
  paste), so no doubled submission and no crossed text; **AND GIVEN** two sends to
  DIFFERENT panes, **THEN** they run concurrently (only the brief shared set→paste
  window serializes across panes).

### Requirement: One shared injection deadline (route stays under 5s)
The whole injection sequence — every tmux subprocess plus the probe and submit
backoffs — SHALL run under ONE shared context deadline (`agentSendTotalBudget`,
default `4s`, a package var only so tests can shrink it), derived from the request
context (a client disconnect also cancels the subprocesses). The individual tmux
primitives are the caller's-context `*Ctx` variants that do NOT each impose their
own timeout, keeping the route under the code-review 5s route-blocking rule. The
full observation ladder exits early on a changed frame; recovery uses only its
first three steps. `muxCmdTimeout` remains 5s on the CLI path.

#### Scenario: A stalled tmux cannot block the route past the budget
- **GIVEN** a tmux subprocess that stalls
- **WHEN** the shared deadline elapses
- **THEN** the sequence aborts (the ctx cancels every remaining subprocess) rather
  than blocking the route for multiples of 5s.

### Requirement: Pane-targeted tmux primitives and the injection interface
`internal/tmux` SHALL carry the pane-targeted primitives the injection needs:
`SetAgentSendBufferCtx`, bracketed `PasteAgentSendBufferCtx`, raw
`PasteAgentSendBufferRawCtx`, `SendEnterToPaneCtx`, and the `AgentSendBuffer` name
constant (see [tmux-sessions](/run-kit/tmux-sessions.md)), plus the pane-mode
guard trio: `PaneInModeCtx` (reads `#{pane_in_mode}` via `display-message -pt`),
`CancelPaneModeCtx` (`send-keys -t <pane> -X cancel` — `-X` is a send-keys FLAG,
not a key name, so `SendKeysToPane(keys...)` cannot express it and the cancel is
its own primitive), and `ClearPaneModeCtx` — the SINGLE probe-then-cancel
decision site every rk delivery path routes through (a modeless pane issues no
cancel subprocess; one cancel, no re-probe; probe/cancel failures return
wrapped, never fail-open). The generic raw primitive
is `PasteBufferRawCtx(ctx, name, paneID, server)`, issuing
`paste-buffer -d -r -b <name> -t <pane>`: `-r` preserves LF bytes and the absence
of `-p` avoids bracketed-paste markers. `inject.Tmux` SHALL expose the matching
`PasteBufferRaw` method beside `PasteBuffer`, and exactly ONE guard method,
`ClearPaneMode`, which `Engine.Send`, `Engine.SendRaw`, and `Engine.PressEnter`
each invoke as their first pane-touching step. The interface also carries
`PaneSize(ctx, paneID, server)` — a readiness-only geometry read (the readiness
path's once-per-settle floor check, backed by `tmux.PaneSizeCtx`); the engine
never calls it.

`api/router.go`'s `TmuxOps` interface (with `prodTmuxOps` + the test `mockTmuxOps`)
SHALL surface these as `ClearPaneMode` / `SetAgentSendBuffer` / `PasteAgentSendBuffer` /
`PasteAgentSendBufferRaw` / `SendEnterToPane` / `SendKeysToPane` / `CapturePane` so
the handlers are fully testable against the fake. `SendKeysToPane` is context-bound
and sends recovery's `C-u` to the resolved pane. `SendKeys` remains the separate
window-targeted `/keys` helper. (260830-s7wp)

#### Scenario: The status matrix is exercisable against a fake tmux
- **GIVEN** the handler driven by `mockTmuxOps`
- **WHEN** the test injects capture results / errors per primitive
- **THEN** the full 400/404/409/500/200 matrix, injection order (the pane-mode
  guard ahead of the baseline capture), and
  no-Enter-on-probe-failure are exercisable with no live agent pane.

### Requirement: `ReadyOpts.WaitThroughWalls` — opt-in wall ride-out
`inject.ReadyOpts` SHALL carry `WaitThroughWalls bool` (default false — every
consumer keeps the fail-fast first-parked classification). When true, a parked
classification in `AwaitReady` is not a verdict: the wait remembers the parked
frame and keeps polling, re-probing only after the screen has changed from that
frame and re-settled (a static wall is never re-pasted; every probe still cleans
up after itself, so a wall that eats the paste sees nothing), returning ready on
echo/state, `ErrGone` promptly when the pane dies, and `NarrowError` as today;
at deadline expiry the error is the LAST classification — the most recent
`ParkedError` (with its snippet) when the pane is still on the parked frame,
else `ErrNotReady` — so the caller still learns why delivery never happened.
The one consumer setting it is `rk operator -L` (server mode — the daemon/Start-button/cron-respawn launch, where nobody is watching the pane), paired with its 60 s server-mode deadline; the interactive `rk operator`, `rk tutorial`, `rk mux await --ready`, and the cron session respawn all keep fail-fast. (t7vy)

## Design Decisions

### Transcript location is the package's whole surface
**Decision**: `internal/transcript` exposes exactly the provider registry (the
`Provider()`-only `Adapter` interface, `Register`/`Lookup`, `ErrNoAdapter`), the
optional `TranscriptLocator` capability with the package-level
`Path(provider, ref)`, the `ErrInvalidRef`/`ErrTranscriptNotFound`
sentinels, and the registered adapters' ref guards + bounded locator lookups —
no event schema, conversation type, backfill, or offset tail.
**Why**: the schema/parser/backfill/tail machinery's only consumers were the
chat backfill endpoint and the state-socket chat subscription, both retired with
the chat lens; zero production references remained, and dead code invites drift
while misleading readers of the transcript-resolution path.
**Rejected**: keeping the read machinery against a possible future transcript UI
(unreferenced code misleads; git history preserves it if the need returns).
*Introduced by*: 260904-0mrk-chat-lens-residual-code-trim

### Transcript paths derived, never hook-carried
**Decision**: adapters resolve transcripts from the session ref via bounded
filesystem lookups; codex/gemini hook payloads carry `transcript_path` but the
hook writer ignores it.
**Why**: Constitution X — hooks carry only the underivable; trusting a
client-supplied path is the forbidden direction.
**Rejected**: stamping `transcript_path` into a pane option (contract change;
unavailable on the copilot events hooked).
*Introduced by*: 260908-nnqu-fix-agent-neutral-detection

### OpenCode export refusal over eviction
**Decision**: at the 16-artifact in-grace cap a new materialization is refused
(`errExportCapacity`, degraded by omission in the facts builder) rather than
evicting a path already embedded in a rendered prompt.
**Why**: a handed-out path must stay valid for its full grace (1h > the
operator queue's 30-min TTL).
**Rejected**: newest-N eviction (invalidates handed-out paths); an
authoritative export cache (Constitution II).
*Introduced by*: 260908-nnqu-fix-agent-neutral-detection

### Trim before rename
**Decision**: the Chat Lens residual sweep split into a delete-only trim change
and a separate pure-rename change (the `internal/transcript` package name, the
agent-send cluster, the `"broadcast"` compose surface).
**Why**: each PR stays reviewable against exactly one question — "is everything
deleted consumer-free, and does every stored-layout path still heal?" for the
trim; "is this a pure rename — no behavior change anywhere?" for the renames —
and the renames then operate on the already-shrunken surface.
**Rejected**: one combined trim+rename change (same files, two review questions,
larger diff).
*Introduced by*: 260904-0mrk-chat-lens-residual-code-trim

### Package named for what it resolves; `transcript.Path` de-stutters
**Decision**: the transcript locator lives at `internal/transcript`; the
package-level resolver is `transcript.Path(provider, ref)` while the
`TranscriptLocator` interface keeps its `TranscriptPath(ref)` method.
**Why**: post-trim the package's whole job is "resolve `provider:ref` → the
transcript's on-disk path", and a `chat`-named package kept sending readers to a
removed subsystem; `transcript.TranscriptPath` would stutter (Go naming idiom),
while the interface method reads fine unqualified at its call sites.
**Rejected**: keeping the `chat` package name (names a retired lens);
`TranscriptPath` at package level (stutter); renaming the interface method to
`Path` (`loc.Path(ref)` loses the "transcript path" reading, churns the adapter
for no clarity gain).
*Introduced by*: 260904-owue-chat-lens-residual-renames

### The injection cluster is named agent-send
**Decision**: the injection binding is agent-send end to end —
`tmux.AgentSendBuffer = "rk-agent-send"` with the `*AgentSendBuffer*Ctx`
primitives, the `TmuxOps` seam's `SetAgentSendBuffer`/`PasteAgentSendBuffer`/
`PasteAgentSendBufferRaw`, and `api/send.go`'s `agentSendEngine`/
`agentSendTmux`/`agentSendTotalBudget`.
**Why**: the cluster serves `POST /send`'s `target:"agent"` vocabulary and the
operator-request routes — "chat" described a removed UI, not these mechanics;
the buffer value is transient tmux runtime state (nothing persists it; the CLI
uses per-invocation `rk-send-<pid>` names), so renaming it is contract-free.
**Rejected**: `compose-send` (the operator routes consume the same cluster — it
is not compose-specific); keeping the `rk-chat-send` buffer value under renamed
identifiers (leaves the greppable residue the sweep exists to remove).
*Introduced by*: 260904-owue-chat-lens-residual-renames

### Window-keyed routes, server-resolved ref
**Decision**: The agent-send routes key on `{windowId}` (mirroring every
`/api/windows/{windowId}/*` route, `?server=` query); the backend re-resolves the
reconciled `@rk_pane_agent_session` rollup server-side per request.
**Why**: URLs carry no session UUIDs, and the backend never trusts a
client-supplied ref over the reconciler — the same reconciliation `FetchSessions`
applies.
**Rejected**: Ref-in-URL (stale/spoofable).
*Introduced by*: `260714-pmfh-chat-read-backend`

### Tmux keystroke injection, not an agent SDK/API send
**Decision**: Send types the message *into the resolved pane* — a named-buffer
bracketed paste (`set-buffer -b rk-agent-send -- <text>` → `paste-buffer -d -p`)
plus a probed `send-keys Enter` — rather than hosting the agent's session or
calling a provider send API.
**Why**: The pane stays the agent's parent process (Constitution VI); rk sends
keystrokes exactly as a human typist would — no SDK hosting, no session ownership,
no queue state (Constitution II). Mechanically provider-agnostic (it types into any
TUI), so the injection lives in the shared `internal/inject` engine behind the
`injectIntoPane` adapter seam (`api/send.go`) that a later
protocol-based send (Codex JSON-RPC) can branch on without reshaping the callers;
v1 makes NO provider branch. `set-buffer` (text as a discrete argv element) beats
`load-buffer -` because `tmuxExecServer` has no stdin plumbing; the `--` terminator
is load-bearing for leading-dash text; a NAMED buffer avoids clobbering the user's
anonymous buffer stack; `-p` matches the TUI's bracketed-paste support so multiline
lands as one literal block.
**Rejected**: an agent SDK/protocol send in v1 (session ownership, dependency creep
— deferred to a later change behind the seam); reusing `POST /keys` (window-target
routes to the active pane, key-name interpretation of message text, unconditional
Enter — the stale-prompt trap); `load-buffer -` (no stdin).
*Introduced by*: `260714-jdyg-chat-send`

### Control-byte sanitize at the handler boundary, sanitize-not-reject
**Decision**: Strip terminal control bytes from `body.Text` in `handleWindowSend` via
the exported pure `inject.Sanitize` helper (`internal/inject` — normalize CR/CRLF to
`\n`, then drop every
`unicode.IsControl` rune — C0 + DEL + C1 — except `\n`/`\t`), applied right after the
JSON decode and before the emptiness check — sanitize, never reject-with-400 for the
mere presence of control bytes.
**Why**: Bracketed paste makes ordinary text inert, but control bytes ride through
verbatim; ESC is the sharpest vector — it can embed the bracketed-paste-end sequence
`ESC[201~`, terminating paste mode early so the message tail is interpreted as live
keystrokes (the paste-injection break-out that would sidestep the echo-probe +
withheld-Enter guard). Sanitizing at the handler makes every downstream consumer
(needle, multiline detection, paste, probe) automatically consistent and keeps the
tmux layer byte-faithful (Constitution I — the wrappers store argv verbatim; policy
belongs to the caller). Running before the emptiness check makes an all-control
message collapse to empty and take the existing `400` path. Stripping is strictly
friendlier than rejecting legitimate copy-paste content that merely carries stray
escapes, and CR-normalization (rather than bare stripping) keeps a CRLF-origin
multiline message's line structure so it still counts as multiline.
**Rejected**: sanitizing inside `SetAgentSendBufferCtx` (wrong layer — the tmux
package is a mechanism-only wrapper; future callers may legitimately need raw bytes);
rejecting control-byte requests with a `400` (hostile to legitimate paste content).
*Introduced by*: `260719-t9uk-chat-send-control-byte-sanitize`

### NOVELTY echo probe before Enter, fail-closed
**Decision**: Never send Enter blindly. Capture the pane tail BEFORE the paste, then
require a probe needle's (or, for a collapsible paste, the paste-collapse chip's in
either form) occurrence count to strictly INCREASE after the paste; on failure
withhold Enter and return `409` with the text left recoverable in the composer.
**Why**: A visible `❯ <text>` line in a capture can be STALE printed output, not the
live input buffer (a recorded operator lesson) — a mere-presence check would false
pass on a stale chip (this very handler's 409 path leaves pasted text in-frame) or a
short/common needle (`ok`), and Enter into e.g. a permission dialog is the exact
hazard. Novelty (baseline count → strict increase) makes a stale occurrence a floor
to beat rather than a false positive, and if the pane scrolls between baseline and
probe the count cannot rise, so it fails CLOSED. Leaving the pasted text on failure
is visible recoverable state, strictly better than a blind Enter; the 409 message
names it and warns that a resend would duplicate (the paste, not the Enter, already
landed).
**Cost / accepted races**: the capture→Enter gap is inherently TOCTOU-racy (accepted
worst case, matches operator practice); and because busy sends are ALLOWED, agent
output could coincidentally add a needle occurrence between baseline and probe — a
reachable but low-consequence false-positive.
**Rejected**: mere-presence matching (stale/short-needle false positives);
reject-while-busy (superseded — Claude Code queues typed input natively, and the
probe already guards the unsafe cases).
*Introduced by*: `260714-jdyg-chat-send`

### Changed frames make no submission claim
**Decision**: Post-Enter observation is asymmetric. A normalized frame change at
any backoff step returns success without interpreting the cause; only a frame
unchanged through the full ladder can support a non-submission verdict. Neither
the initial Enter nor a recovery Enter has a pre-Enter quiescence gate.
**Why**: A repaint can be a submit, spinner, streaming transcript, or ticking
status line. The daemon routes deliberately accept mid-turn panes with no
`agentState` gate, so treating change as confirmation or failure would make the
shared engine unsound for routine traffic. The unchanged full-ladder case is the
only observation that identifies the printed-prompt trap when the established
paste echo also remains present.
**Rejected**: A sampled quiescence gate (a slow spinner can outlive the sample,
while a ladder-length gate adds about 1.2s to every send); treating any change as
confirmed submission; treating a churning pane as `SubmitUnverified`.
*Introduced by*: 260830-nyvm-mux-send-submit-verification

### Composer popups are consumed by an evidence-gated extra Enter, not avoided at composition
**Decision**: A popup the paste itself opens (codex's skill-autocomplete on a
bare skill token) is consumed inside the engine's submit path: strict-increase
marker novelty in the probe frame vs the pre-paste floor triggers one extra
Enter, one `ProbeSettle`, and a fresh pre-Enter capture; the submit Enter and
observation then run unchanged. Recovery re-runs the guard against its cleared
frame — the re-paste can reopen the popup.
**Why**: The popup consumes Enter as *insert* and its closing is a frame change,
so the asymmetric observation's no-claim branch reports success over a
non-submission — a silent false success no recovery can catch. The engine is the
single seam every typed send crosses (riff typed delivery, operator/tutorial
kickoffs, cron respawner, agent-send routes), detection reads two frames already
in hand (the no-popup path adds zero calls), a false positive is benign (the
extra Enter submits; the follow-up no-ops on the emptied composer — verified
live), and a false negative degrades to the prior behavior.
**Rejected**: Appending a trailing space to bare-skill-shaped tasks at
composition (verified to suppress the popup) — replicates per kickoff call site,
misses operator→codex sends through the agent-send route, and touches
composition where the claude byte-identity pins live.
*Introduced by*: 260909-q7mj-codex-popup-enter-guard

### Composer clear requires equality with the pre-paste baseline
**Decision**: Recovery permits a re-paste only when `stripForProbe` makes the
post-`C-u` capture equal to the pre-paste baseline capture.
**Why**: Equality identifies the complete pane state and covers every staged line.
It also fails closed when a submitted message appears in the transcript: that
frame cannot equal the baseline, so recovery cannot re-send it.
**Rejected**: Needle occurrence thresholds (a reflow can remove a stale occurrence
while the live echo remains); count-drain logic (the needle is only the last
non-empty line, so earlier lines can remain staged after its count bottoms out).
*Introduced by*: 260830-nyvm-mux-send-submit-verification

### Recovery requires positive non-submission evidence
**Decision**: Recovery runs only when every observation frame is unchanged and
the paste echo remains present. An unchanged frame without the echo returns
`SubmitUnverified` without modifying the pane; a changed frame returns success
with no claim and no recovery.
**Why**: `C-u` can remove staged input but cannot undo a submitted message.
Positive evidence plus a baseline-equal clear makes a duplicate re-paste
structurally unavailable.
**Rejected**: An unconditional bounded retry for any unverified Enter (a false
negative posts the message twice even with a retry limit).
*Introduced by*: 260830-nyvm-mux-send-submit-verification

### Non-submission evidence reuses the echo probe predicate
**Decision**: The unchanged-frame evidence arm checks the echo with
`CountOccurrences(capture, needle, collapsible, imageish)`, including the gated
chip terms (paste-collapse and image); the changed-frame no-claim arm remains
pure whole-frame comparison.
**Why**: The evidence question must use the same predicate that established the
echo. A chip-rendering TUI replaces a collapsed paste's raw text with a chip, while
the chip terms match nothing on TUIs that do not render one.
**Rejected**: Raw-needle-only evidence (classifies collapsed long or multi-line
pastes as echo-absent and withholds recovery); using chip recognition in the
changed-frame comparison (adds provider shape where none is needed).
*Introduced by*: 260830-nyvm-mux-send-submit-verification

### Collapse-chip gate at 200 runes, a conservative lower bound
**Decision**: Count the paste-collapse chip whenever the paste is *collapsible* —
multiline OR a single line of at least `inject.CollapseMinRunes = 200` runes — and
make the `+M lines` suffix optional in `pasteCollapseRe` so both the multiline chip
(`[Pasted text #N +M lines]`) and the suffix-less long-single-line chip
(`[Pasted text #N]`) match.
**Why**: Claude Code collapses a single-line paste over 800 chars into a suffix-less
chip (empirical, CC 2.1.215, width-independent, observed threshold 801), so its raw
needle never echoes and the probe would 409 for a paste that demonstrably reached
the buffer. Gating chip-counting on `collapsible` (not merely on the presence of a
newline) is what makes the long-single-line chip a valid echo signal. The NOVELTY
strict-increase-over-baseline design is
unchanged and is what keeps chip-counting sound: a stale chip is in the pre-paste
floor, so only THIS paste's fresh occurrence can satisfy the probe — soundness is
independent of whether the text is multiline. 200 is a deliberate conservative lower
bound (vs the observed 801) so an upstream threshold reduction cannot silently
rebreak long-single-line sends, while short interactive sends keep exact-needle-only
matching.
**Rejected**: keying the gate to the exact observed 801 (brittle — an upstream
Claude Code release can lower it silently); counting the chip unconditionally for
ALL sends (needlessly widens the concurrent-fresh-chip false-positive window to
short interactive sends that never collapse).
*Introduced by*: `260719-yxi0-chat-send-single-line-collapse-probe`

### Image chip is a gated third echo signal, either-signal with the raw needle
**Decision**: Count `[Image #N]` chips (`imageCollapseRe`, whitespace-stripped
form) as fresh echo only when the paste is *imageish* — a bare single-line image
path, trimmed, case-insensitive `.png`/`.jpg`/`.jpeg`/`.gif`/`.webp`
(`isBareImagePath`) — and accept EITHER a fresh chip OR a fresh raw-needle echo
for such pastes, under the unchanged strict-increase-over-baseline rule.
**Why**: Claude Code chips only a paste that is exactly one existing image path
(verified CC 2.1.260 — mixed text, multi-path, `.svg`/`.bmp`, and nonexistent
paths all stay raw text; the image chip renders at every paste length, beating
the paste-collapse chip, so the collapsible arm can never catch it), and
chip-vs-raw depends on filesystem state the engine cannot see. Gating mirrors
the collapsible-gate stance: keep the concurrent-fresh-chip false-positive
window off ordinary sends. Without this arm, every attachment-only dashboard
send (a bare uploaded-path line) failed the probe and 409'd despite the paste
demonstrably landing as a chip.
**Rejected**: counting the image chip unconditionally (widens the false-positive
window for all sends); matching Claude Code's exact chip-eligibility rule via
file existence/media sniffing (unknowable from text; either-signal makes it
unnecessary); a frontend workaround wrapping the path in text (changes what the
agent receives).
*Introduced by*: `260904-svfv-inject-image-chip-probe`

### Allow + probe busy policy — no server-side gate, no queue
**Decision**: There is NO `agentState` gate on send and NO server-side queue. A busy
(`active`) agent receives the paste into its TUI input box; the novelty probe is
the sole pre-Enter guard, and post-Enter observation makes no claim when the busy
pane repaints.
**Why**: Claude Code's TUI natively queues messages typed while the agent works
(steering). Probe-before-Enter blocks unsafe blind submission, while the
asymmetric observation contract lets routine mid-turn repainting return success.
A server-side queue is forbidden by Constitution II (no persistent state store).
**Rejected**: reject-while-busy (unnecessary given native steering); a server-side
send queue (Constitution II).
*Introduced by*: `260714-jdyg-chat-send`

### Per-(server,paneID) whole-sequence lock + nested shared-buffer mutex
**Decision**: Serialize the whole injection sequence per `(server, paneID)` with a
never-evicted mutex map, and nest a small engine mutex around just the set → paste
critical section (which uses the one server-wide named buffer). Raw injection and
bare Enter take the same per-pane lock; raw injection also takes the buffer mutex.
**Why**: Two sends to the SAME pane racing one composer could each paste before
either completes probing, Enter, observation, and recovery, merging into one
doubled submission — the per-pane whole-sequence lock closes that window while
keeping DISTINCT panes concurrent. The
named buffer `rk-agent-send` is a single server-wide resource with rk as sole writer,
so without the nested set→paste mutex two cross-pane sends could interleave as
A-set / B-set / A-paste (wrong text into pane A; B's `-d` paste 500s on the deleted
buffer). Division of labour: per-pane lock = same-pane sequence ordering; global
mutex = shared-buffer atomicity across panes. Both are held briefly relative to the
slow probe captures, so cross-pane throughput stays high.
**Rejected**: a global set→paste-only lock (leaves the same-pane double-paste window
open); a per-request unique buffer name (works but the whole-sequence lock is needed
anyway for the same-pane merge, and a shared named buffer is simpler); evicting map
entries (reintroduces a drop-last-reference race between two same-pane sends).
*Introduced by*: `260714-jdyg-chat-send`

### One shared injection deadline threads all subprocesses
**Decision**: The handler derives ONE `context.WithTimeout(r.Context(),
agentSendTotalBudget)` (default 4s) and threads it through every step via the `*Ctx`
tmux variants, including observation captures, `C-u`, and re-paste operations.
**Why**: The code-review 5s route-blocking rule requires one bounded deadline for
the entire operation. Deriving from the request context also cancels the tmux
subprocesses and backoff sleeps on client disconnect.
**Rejected**: independent per-primitive timeouts (unbounded route block).
*Introduced by*: `260714-jdyg-chat-send`

### Insert-without-submit is a `mode`, not a parallel state machine
**Decision**: Insert-without-submit is the `insert-line` value of `/send`'s
closed-set `mode` field, mapping to `Engine.Send(…, submit:false)` — it skips
Enter, post-Enter observation, and recovery; baseline/set/paste/probe/lock/budget
still apply, and a failing probe still 409s. The default body stays exactly
`{ text, mode }` — the optional `target` field is serialized only when set.
**Why**: A closed-set `mode` keeps the caller naming intent while the server owns
mechanism, and reusing the hardened paste path ensures staged text demonstrably
echoed before it is left for a human or a later submit, without running any
submission-only work.
**Rejected**: a separate insert endpoint (a new POST route for a one-step
delta — Constitution IV/IX prefer the additive body field); a parallel
insert-mode state machine on the client (a second lock/clear/error path is the
cross-surface divergence the shared classifier forbids).
*Introduced by*: 260719-mxvw-pointer-aware-enter-insert-mode

### Agent-pane targeting is an explicit `target:"agent"` mode that fails closed
**Decision**: `POST /api/windows/{windowId}/send` carries an optional `target`
body field: absent means the window's ACTIVE pane (the compose strip's default);
`"agent"` (the selection broadcast's and the quake terminal's mode)
resolves the agent pane via the
shared `sessions.ResolveAgentPane` rollup — active-pane-first among
`@rk_pane_agent_session` carriers, else the first carrier — and returns `404`
("no agent session for this window") when no pane carries an agent session,
performing zero injection. An unknown
`target` value is a `400`.
**Why**: A broadcast aimed at a window with no agent pane must fail loudly and be
counted as that recipient's failure — the alternative (falling back to the active
pane) pastes the prompt into a non-agent shell and presses Enter there,
*executing* it. Sharing `sessions.ResolveAgentPane` keeps one rollup rule
across the window-level agent-session identity, fork, operator actuation, and
agent-targeted sends.
**Rejected**: silently falling back to the active pane (a shell-execution
footgun); a separate broadcast endpoint (Constitution IV/IX — the additive body
field on the existing intent-shaped route).
*Introduced by*: 260904-39bp-remove-chat-lens

### Failure taxonomy splits on the Enter boundary
**Decision**: Post-paste failures classify by whether Enter was sent. Before
Enter (a probe capture error, a context failure mid-probe, or a refused
`send-keys Enter`) → `StagedSendFailure` (`staged_send_failure` 409 — staged
text, a resend duplicates, recovery is a human Enter). After Enter (observation
capture/context faults, recovery failures) → `SubmitUnverified` wrapping the
cause (`submit_unverified` 409). Pre-paste failures keep the plain wrapped-error
→ 500 path, where "nothing was delivered; retrying is safe" is true. A clean
echo miss remains `ProbeFailure`.
**Why**: The two post-paste states demand opposite resend advice — staged text
wants a recovery Enter and warns that a resend duplicates; a sent Enter may
already have submitted, so a recovery Enter could double-submit. One sentinel
per failure class keeps the handler mapping mechanical and the client toasts
honest about what was delivered.
**Rejected**: One catch-all staged code for everything post-paste (gives "press
Enter in pane" advice after Enter already ran); reusing `probe_failure` for
infrastructure errors (conflates a clean echo miss with a tmux fault — the
memory contract keeps them distinct 409s).
*Introduced by*: 260902-8jco-tmux-pane-env-scrub-send-failures

### One guard interface method backed by one tmux decision site
**Decision**: `inject.Tmux` grows exactly one method for the pane-mode guard
(`ClearPaneMode`); the probe-then-cancel decision lives once in
`tmux.ClearPaneModeCtx`, which every implementation (the CLI adapter, the
daemon's `TmuxOps` chain, riff's adapter, and the CLI `--key` branch's seam)
delegates to.
**Why**: the guard is one decision — "is the pane in a mode? then cancel" — and
the single-engine invariant demands no divergent copies; a one-method seam
keeps every adapter a one-liner and gives the sentinel probe's typing path the
same consumable step.
**Rejected**: two primitive methods (probe + cancel) on `inject.Tmux` with the
decision in the engine — widens the interface and forces every mock/adapter to
carry two passthroughs for no added testability; per-call-site probe+cancel
copies — the drift hazard the invariant exists to prevent.
*Introduced by*: 260904-kppn-mux-send-delivery-hardening

### The pane-mode guard runs inside the per-pane lock, before the baseline capture
**Decision**: the guard is the first step of each engine sequence, after taking
the pane lock and before the baseline `CapturePane`.
**Why**: cancelling copy-mode repaints the pane — a baseline captured first
would be the scrolled copy-mode frame, poisoning the novelty floor and
recovery's baseline-equality check; inside the lock, a concurrent send cannot
interleave between cancel and paste.
**Rejected**: guarding outside the lock in each caller (reintroduces the
interleave window and per-caller copies); guarding after the baseline (wrong
frame).
*Introduced by*: 260904-kppn-mux-send-delivery-hardening

### Guard failure fails the send; the cancel is unconditional-once
**Decision**: a probe/cancel tmux failure aborts the delivery as a pre-paste
operational error; an in-mode pane gets exactly one cancel, with no re-probe
loop.
**Why**: consistent with every other pre-paste failure (nothing was delivered,
retry is safe); fail-open would silently restore the eaten-keys hazard the
guard exists to close, and a pane re-entering a mode mid-delivery is tmux's
inherent race, accepted like the cross-process paste race.
**Rejected**: warn-and-proceed on probe failure (silent hazard); cancel-verify
loops (the mode re-entry race cannot be closed from outside tmux).
*Introduced by*: 260904-kppn-mux-send-delivery-hardening

### `PaneSize` lives on the `Tmux` interface, not an optional reader
**Decision**: `inject.Tmux` gains `PaneSize`; every adapter implements it
(`cliInjectTmux`, `awaitReadyTmux`, `riffInjectTmux`, `agentSendTmux`, and the
test fake).
**Why**: fail-closed by construction — an optional `ReadyOpts` reader that a
consumer forgets to wire would silently fall open to probing (and
mis-classifying) a below-floor pane.
**Rejected**: `ReadyOpts.Size func(...)` (the `State`/`IsGone` pattern) — those
are optional by design; the readiness floor is not.
*Introduced by*: 260906-dm30-await-ready-narrow-pane-verdict

### The daemon adapter calls `tmux.PaneSizeCtx` directly
**Decision**: `agentSendTmux.PaneSize` calls `tmux.PaneSizeCtx` rather than a
`TmuxOps.PaneSize` seam method.
**Why**: the daemon never reaches `AwaitReady`; the method exists for interface
satisfaction only. A seam method would touch `router.go`, the `TmuxOps`
interface, and every api test fake for a path no daemon route executes.
**Rejected**: `TmuxOps.PaneSize` — seam consistency for dead code is not worth
the churn; if a daemon route ever awaits readiness, lift it to the seam then.

### Wait through walls only where nobody is watching
**Decision**: the wall ride-out is an opt-in on `ReadyOpts` (`WaitThroughWalls`);
only `rk operator -L` sets it, paired with the 60 s `operatorServerDeliverDeadline`.
**Why**: `rk mux await --ready` and the cron session respawn are classifiers that
must fail fast; the daemon launch has no human at the pane yet, so the wait
should ride out a wall the user clears from the drawer. 60 s + 10 s stays under
both 90 s caller bounds (`operatorStartProcessTimeout`, `cron.DefaultRespawnTimeout`).
**Rejected**: re-probing every poll while walled (noisy paste/clear into a
dialog); a separate `AwaitReadyThroughWalls` function (duplicated loop).
*Introduced by*: 260913-t7vy-operator-daemon-launch-root-kickoff
*Introduced by*: 260906-dm30-await-ready-narrow-pane-verdict
