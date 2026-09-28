---
description: "The `@rk_pane_agent_state` pane-option convention: three-state schema, dual-read/dual-write over the retired unscoped name, shell reconciler, window rollup (duration emitted for `active` too). Covers the seven-harness runtime registry, the `rk agent setup` installer (four artifact families: launcher pointer, per-agent hooks, tmux guard shim, gui display block) with the two-path hook wrapper, `rk agent hook` binary indirection, the SessionStart boot stamp, and `@rk_pane_agent_session` identity."
type: memory
---
# Agent-State Tier (`@rk_pane_agent_state`)

The generic agent-lifecycle tier: a tmux **pane** user option that any agent
harness writes and run-kit reads natively. (260705-dmex) The cross-repo
contract lives in [`docs/specs/agent-state.md`](../../specs/agent-state.md) (this
memory file records what run-kit actually implemented).

## Two-Tier Ownership Model

Agent status splits into two tiers with distinct owners:

- **Tier 1 — fab pipeline state** (change / stage / display-state): owned by the
  fab pipeline, derived natively per pane from `.fab-status.yaml` →
  `.status.yaml` (`internal/sessions/fabstate.go` — see
  [tmux-sessions](/run-kit/tmux-sessions.md) § Fab-Tier Derivation). Stays
  fab's.
- **Tier 2 — generic agent-lifecycle state** (`active` / `waiting` / `idle`):
  owned by run-kit, carried in the `@rk_pane_agent_state` tmux pane user option,
  written by agent-harness hooks for **any** agent (Claude, codex, copilot,
  gemini, opencode, …) in **any** directory under **any** workflow.

Per constitution **Principle X — Hooks Carry Only the Underivable**, hooks push
only ephemeral in-flight lifecycle state; everything derivable (PR links,
branches, worktrees) is derived server-side — which is why PR links use branch→PR
derivation (see [architecture](/run-kit/architecture.md)
§ Backend Libraries → `internal/prstatus`, § Branch→PR Derivation). (260705-dmex)

## The Convention

| Property | Value |
|----------|-------|
| Option | `@rk_pane_agent_state` (const `tmux.AgentStateOption`) |
| Scope | tmux **pane** user option (`set-option -p`) — a new scope class alongside window (`-w`), server (`-s`), and session-scoped options |
| Value | `"<state>:<epoch_seconds>"` |
| States | `active` (`tmux.AgentStateActive`) \| `waiting` (`tmux.AgentStateWaiting`) \| `idle` (`tmux.AgentStateIdle`) |
| Example | `waiting:1751790000` |

The epoch suffix is **mandatory** — readers compute the state's age from it
(idle/waiting rest durations, and `active`'s age as the downstream staleness
signal for a lost write). Values MAY carry a third `:<pid>` segment (the agent process's pid, for the
PID-liveness reconciler); the schema is `<state>:<epoch>[:<pid>]`, formatted by
the pure `formatAgentStateValue(state, epoch, pid)` in `cmd/rk/agent_hook.go`. The
option name and the three
state tokens are declared **once** in `app/backend/internal/tmux/tmux.go`
(constants `AgentStateOption`, `AgentStateActive`/`Waiting`/`Idle`);
`cmd/rk/agent_setup.go` **and** `cmd/rk/agent_hook.go` alias them rather than
re-declaring the convention strings (one source of truth per binary, A-021).

**State semantics**: `active` = a turn is in progress; `waiting` = blocked on a
**human** (permission prompt, elicitation/question dialog) — the highest-urgency,
most notification-worthy state; `idle` = turn complete, at rest. `idle` is also
semantically true of a freshly started session, which is what the SessionStart
boot stamp exploits (see § Boot-Ready Signal).

## Backend Native Read (`internal/tmux`)

`#{@rk_pane_agent_state}` is field 8 (0-indexed) of the **12-field** `paneFormat`
`list-panes` format string (`window_id`, `pane_id`, `pane_index`,
`pane_current_path`, `pane_current_command`, `pane_active`, `#{@rk_agent_state}`,
`alternate_on`, `#{@rk_pane_agent_state}`, `#{@rk_pane_chat}`,
`#{@rk_pane_agent_session}`, `pane_pid`) —
**dual-read** with the retired unscoped name at field 6: `parsePanes` resolves
`agentStateRaw` as field 8 when non-empty else field 6 (lines with fewer than 12
fields are skipped). Field 11 (`pane_pid`) is the `rk mux panes` liveness-walk
root (`PaneInfo.PanePID`, `json:"-"`; see
[agent-messaging](/run-kit/agent-messaging.md)). It costs **zero extra subprocess** — it rides the existing
`list-panes` call `ListWindows` already issues per session. The same dual-read
applies to the agent-session fields: `agentSessionRaw` = field 10
(`#{@rk_pane_agent_session}`) when non-empty else field 9 (`#{@rk_pane_chat}`,
the fallback name carried for one release). (260904-bf1l-agent-session-identity-rename)

`PaneInfo` carries two serialized agent-state fields: `AgentState string`
(`json:"agentState,omitempty"`, `active|waiting|idle`, empty = unknown) and
`AgentStateEpoch int64` (`json:"agentStateEpoch,omitempty"`, 0 = unknown), plus
the unserialized `AgentPID int` (`json:"-"` — the reconciled pid segment, 0 when
absent or stale, zeroed together with `AgentState`; the `rk mux panes`
liveness-walk cross-check pid). All are parsed and reconciled in `parsePanes`
(which skips a line with fewer than 12 fields):

- **`parseAgentState(raw string) (string, int64)`** — pure helper. Trims, splits
  on the **last** `:` (defensive; state tokens never contain a colon so it equals
  a first-colon split for valid input), validates the state via `isAgentState`
  and the epoch via `strconv.ParseInt(base 10, 64)`. An empty value, a value
  lacking the colon, an unknown state token, or a non-integer epoch all yield
  `("", 0)` — degrades to unknown, never panics.
- **Shell-command reconciler** — applied in `parsePanes` right after parse: if
  `tmux.IsShellCommand(command)` (the pane's `#{pane_current_command}` is one of
  the set `shellCommands = {sh, bash, zsh, fish, dash, ksh, tcsh, csh, nu}`,
  matched case-sensitively — the ONE shell predicate, also read by the `rk mux
  send` unknown-state warning and as the `rk mux panes` liveness-walk trigger;
  see [agent-messaging](/run-kit/agent-messaging.md)),
  **both** `AgentState` and `AgentStateEpoch` are zeroed regardless of a leftover
  option value. This auto-clears a stranded `active` left by an Esc-interrupted or
  killed agent (the guppi lesson) — a real agent command like `claude` keeps its
  state. The reconcile decision itself lives in the shared
  **`agentStateStale(pid, command)`** helper: a pid-carrying value is trusted iff
  the agent process is alive (kill-0 liveness), and a legacy two-segment value
  falls back to the shell-command heuristic.

**Single-pane read for the `rk mux` verbs** — `PaneAgentState(ctx, paneID,
server)` (`internal/tmux/pane_target.go`) reads ONE pane's
`#{pane_current_command}` + `#{@rk_agent_state}` + `#{@rk_pane_agent_state}` via
`display-message -pt` (requesting both names), prefers the new name when
non-empty (`parsePaneFacts` field 4 over field 3 — the same new-wins rule
`parsePanes` applies to fields 9/6), parses via `parseAgentState`, and reconciles
through the SAME `agentStateStale` helper `parsePanes` applies — one reconcile
decision, never a divergent copy. An
absent, unparseable, or reconciled-away value reads as `""` (unknown, never
partial trust); a tmux failure (e.g. a dead pane) is the error return. It backs
the two first-party CLI readers of the convention: the **`rk mux send`
agent-state gate** and the **`rk mux await` observer** (both in
[agent-messaging](/run-kit/agent-messaging.md)).

## Window Rollup + Duration (`internal/sessions`)

`WindowInfo.AgentState` / `AgentIdleDuration` (JSON `agentState` /
`agentIdleDuration`) are a window-level rollup over the window's panes
(post-reconciler) computed rk-side in `FetchSessions`.

- **`rollupAgentState(panes []tmux.PaneInfo, nowUnix int64) (state, duration string)`**
  — pure helper (mirrors the `parseWindows`/`parsePanes`/`applyActiveWindow`
  split). Precedence `waiting > active > idle` via `agentStatePrecedence`
  (`waiting`=3, `active`=2, `idle`=1, unknown/empty=0) — the highest-ranked pane
  wins, so a split window with one `waiting` pane is a `waiting` window. Panes
  with no agent contribute nothing.
- **Duration** is computed from the winning pane's `AgentStateEpoch` for **any
  known state** with `epoch > 0` — `active` carries its age too, because a lost
  `idle` write on a live agent reads as a fresh `active` indefinitely (the
  pid-liveness reconciler trusts a live pid, so nothing else ever flags it);
  unknown produces `""`. The SPA renders the duration only for the two rest
  states (`waiting`/`idle`) — the machine surfaces (`rk mux panes`, `rk mux
  capture` — see [agent-messaging](/run-kit/agent-messaging.md)) carry it for
  `active` as well.
- **`formatAgentDuration(elapsedSeconds int64) string`** — the `Ns`/`Nm`/`Nh`
  floor-division style (`<60s`→`Ns`, `<3600s`→`Nm`, else `Nh`;
  non-positive → `""`), byte-compatible with fab's duration-string format so the
  frontend surface is unchanged.

`FetchSessions` calls the rollup per window inside the enrichment loop
(`nowUnix := time.Now().Unix()` captured once for the whole loop).

## `rk agent hook` — Hook Logic in the Binary (`cmd/rk/agent_hook.go`)

The hook body installed into harness settings is a stable
*interface* (`agentStateHookCommand` above) and **all logic lives in this Go
subcommand** — so a hook fix reaches every running agent on `brew upgrade rk`
with no settings churn and no session restarts. (260707-qfps) The canonical
invocation is `rk agent hook --agent <name> <state>` — the `hook` member of the
`agent` family (`agent.go`); the old root form `rk agent-hook <state>` is a
**permanent hidden alias** (never deprecated, never warns — installed
settings.json hook lines carry that literal frozen at install time, so it must
resolve silently forever; cli-layering delegation rule 3). Both instances are
factory-built (`newAgentHookCmd`) off the one `runAgentHook` core with the
`--agent` flag bound per-instance, and both carry the complete never-fail
machinery below. (260815-r2wp-agent-family) `<state>` ∈ `active | waiting |
idle`, `--agent` selects the harness
whose runtime descriptor drives pid resolution and payload parsing (default
`claude`; the flag help lists all seven providers). (nnqu)

**Never-fail contract — always exit 0.** Claude Code treats hook exit code 2 as
blocking and other non-zero exits as warnings, copilot's preToolUse command hooks
are fail-closed on non-zero exit (the wrapper's guaranteed exit 0 is what makes
the active mapping safe there) (nnqu), and `main`'s `execute()`
`os.Exit(1)`s on any error `rootCmd.Execute()` returns — so the command must
swallow **every** cobra parse-error class ITSELF, before it can propagate. Cobra
surfaces four distinct classes before `RunE`, each needing its own neutralizer:

- `RunE` always returns `nil` (arg-count is re-checked inside it → silent no-op).
- `Args: cobra.ArbitraryArgs` disables cobra's arg-count validation.
- `FParseErrWhitelist{UnknownFlags: true}` absorbs unknown flags.
- `SetFlagErrorFunc(… → nil)` (in `init()`) swallows KNOWN-flag parse errors
  (e.g. `--agent` present with its value missing) — the one class the other three
  miss.

Plus `SilenceErrors`/`SilenceUsage` so cobra prints nothing on any of these
paths. (Locked in by `TestAgentHookCmdNeverErrorsOnMalformedInvocation`.)

**Runtime registry** (`cmd/rk/agent_registry.go`, shared by the hook writer, the
installer, and `rk doctor`): one `agentRuntime` descriptor per provider —
claude, codex, gemini, copilot, kimi, opencode, agy — carrying `provider` (the
canonical wire token: the `@rk_pane_agent_session` prefix and the transcript
registry key), `binary` (the installer's PATH gate), `comm` (the process-name
literal for the ancestor walk), `sessionIDField`, `compactSource`,
`needsJSONOutput`, and `idleRequiresFullyIdle`. The comm literal is
per-provider: gemini's is **`node`** (the CLI runs as a bundled node script) and
kimi's is **`kimi-code`** (binary `kimi`, process `kimi-code`); the rest equal
the provider token. The payload's session-identity field is likewise
per-provider: `session_id` for claude/codex/gemini/kimi/opencode, camelCase
`sessionId` for copilot, protojson `conversationId` for agy (the descriptor's
`sessionIDField` picks the authoritative field). `agentRuntimeForName` resolves
a name by provider token OR comm literal; an unknown `--agent` is a silent
no-op (exit 0, writes nothing). Runtime handling and installation are
orthogonal axes: a provider resolves in the runtime registry with **no**
installer entry. (nnqu)

**Flow** (`runAgentHook`, the testable core): (1) `$TMUX_PANE` guard — unset →
exit 0 with no subprocess (defense in depth; the wrapper also short-circuits on
it); (2) validate `<state>` via the aliased `isAgentState` (unknown → no write);
(3) resolve the agent's runtime descriptor from the shared runtime registry via
`agentRuntimeForName(agent)` — by provider token or comm literal (unknown
`--agent` → no write); (4) read the stdin payload once (`readHookInput`) and
apply the per-provider gates (the agy `idleRequiresFullyIdle` gate and the stamp
token's `compactSource` gate — see § Agent Session Identity → Writer); (5)
resolve the pid via the ancestor walk; (6) write the pane option. Every failure
path is
silent and returns without error.

**Comm-validated ancestor walk** (`resolveAgentPID(ctx, startPPID, comm)`, bound
**5**): walks up from `os.Getppid()` comparing each ancestor's comm against the
registry literal, returning the first match's pid or **0** (→ pid segment omitted,
never a wrong pid). The bound is **5** because the delegation adds a wrapper layer
(`claude → hook shell → sh -c → rk`, and `sh` may
or may not exec the final `rk`). Raw `$PPID` is wrong here — harnesses spawn hooks
through an *ephemeral* shell that exits when the hook finishes, so `$PPID` records
that dead wrapper (the reader's PID-liveness check would then suppress every
value). The process-inspection primitives:

- **comm** (`processCommImpl`) **delegates to `resolveCommand`** in
  `daemon_portowner.go` (same package — Linux reads `/proc/<pid>/comm` with no
  subprocess, else shells to `ps -o comm=`), reused rather than re-implemented so
  the two comm-resolution sites can't drift.
- **ppid** (`processPPIDImpl`): Linux reads the `PPid:` line of
  `/proc/<pid>/status` (line-keyed, so the `/proc/<pid>/stat` comm-with-parens
  field-indexing hazard does NOT apply — via the pure `parseProcStatusPPID`);
  elsewhere `ps -o ppid= -p` via `exec.CommandContext` with `agentHookCmdTimeout`
  (5s). The `/proc` fast paths avoid ~4 subprocess spawns per hook fire on the
  common Linux host.
- Both are indirected through package-level func-var seams (`processCommFn` /
  `processPPIDFn`) so the walk is unit-testable without a real ancestor chain
  (mirrors `agentProcessAlive` / `findPortOwner`).

**Write** (`writeAgentStateImpl`): **one** `tmux [-S <socket>]` exec carrying two
`;`-chained `set-option` commands as discrete argv elements —
`set-option -pt <pane> @rk_pane_agent_state <value> ; set-option -pt <pane>
@rk_agent_state <value>` (tmux command chaining, no shell — Constitution §I) —
via `exec.CommandContext` with a 5s timeout — value formatted by the pure
`formatAgentStateValue`. The dual-write exists because fab-kit reads only the
retired unscoped pane name until its new-then-old read ships; the
`writeAgentSessionImpl` stamp dual-writes its two option names through the same
shape. The
server is targeted via `-S <socket>` derived from **`tmux.OriginalTMUX`, NOT
`os.Getenv("TMUX")`**: `internal/tmux`'s `init()` strips `$TMUX` from the process
(so the daemon's bare tmux calls hit the default socket), and importing that
package here triggers that strip; `OriginalTMUX` captures the caller's real socket
in a var initializer that runs before `init()`. This is the established seam —
same one `riff.go` / `context.go` use. Deriving `-S` from it (rather than relying
on the child re-exporting `$TMUX`) also survives hook contexts like
`tmux run-shell` that set `$TMUX_PANE` but not `$TMUX`. `tmuxSocketArgs` splits
the `<socket>,<pid>,<session>` `$TMUX` value on the first comma; empty/malformed →
bare invocation (default socket, best effort — the wrapper's `|| true` holds).

**Known gap — the tmux exec has the same upgrade-window class.** `rk agent hook`
execs `tmux` via PATH (through the tmux guard shim → brew symlink), so a **tmux**
upgrade re-opens the same dangling-binary window for the write itself that the
two-path wrapper closes for the rk binary. Not addressed — recorded as the
residual gap.

## `rk agent setup` — Hook Installer (`cmd/rk/agent_setup.go`)

`rk agent setup` (the `setup` member of the `agent` family in `agent.go`) is
the explicit opt-in
installer that writes into an agent harness's **user-global** config so any
session of that agent, anywhere, reports state. The old root form
`rk agent-setup` survives as a **hidden deprecation alias** — a second
factory-built instance (`newAgentSetupCmd`) sharing the `runAgentSetup` core,
`Hidden` + cobra `Deprecated`, printing a one-line stderr pointer naming the new
form while running identically with the same flags and exit codes.
(260815-r2wp-agent-family) Modeled on guppi's explicit
`agent-setup` command rather than a silent sync ("explicit feels honest").

**Consent flags** (toolkit Principle 1/5): because it mutates user-global
harness config (`~/.claude/settings.json`, `$CODEX_HOME/hooks.json`, and the
other registry targets), the confirmation is
gated through a `consent` struct (`yes` / `dryRun` / `stdinIsTTY`) resolved once
per run in the `RunE` and threaded through `runAgentSetup` → `applyAgentConfig`
→ `applyAgentHooks` / `removeLegacySkill`. The single decision point is
`consent.authorizeWrite(out, reader, dryRunNote, promptSuffix) (bool, error)`:
(260717-c424)

- **`--dry-run`** → print the dry-run note, write nothing, return `(false, nil)`.
  Needs no consent, and **wins over `--yes`** (a preview must never mutate).
- **`--yes` / `-y`** → return `(true, nil)` without prompting (non-interactive consent).
- **neither, stdin is a TTY** → print `promptSuffix` and defer to the interactive
  `confirm()` `[y/N]` read.
- **neither, stdin is NOT a TTY** → **refuse**: return
  `(false, errNonInteractiveConsent)`, an error naming `--yes`, nothing written
  (a success-looking silent no-op is the exact agent trap Principle 1 targets;
  reference impl: `shll uninstall`).

The `promptSuffix` (`"Write these changes? [y/N] "` / `"Remove … directory? [y/N] "`)
is emitted **only** on the interactive path — the auto-answered `--yes`/`--dry-run`
paths never read it, so printing `[y/N] ` there would read as a hang in an agent's
transcript. The consent-context renderers (`renderHooksSummary` /
`renderArtifactDiff`) never append the suffix for this reason — only
`authorizeWrite` emits it.

**TTY detection uses `term.IsTerminal`, NOT a bare `os.ModeCharDevice` check**
(`isTerminal(r io.Reader)`): a char-device test alone classifies `/dev/null`
(`rk agent setup </dev/null` — the exact non-interactive shape an agent uses) as a
terminal, which would make the refusal silently not fire. A non-`*os.File` reader
(a test's `strings.Reader` or a pipe) is not a TTY, so tests default to the
non-interactive path unless they set `stdinIsTTY` explicitly. Pinned by
`TestIsTerminalRejectsNonTTYFiles`.

**It installs FOUR artifact families**: the **rk-owned launcher pointer** — the
per-machine symlink `~/.local/share/rk/bin/run-kit` whose target is the resolved
Cellar binary, written FIRST (ahead of the per-agent hooks that exec it), with
`launcher:`-prefixed messages — then the **per-agent hook/plugin install**
(three installer kinds, described below), the **user-global tmux guard shim** — a shim script plus a
marker-owned `PATH` block that puts `rk mux guard` in front of every
PATH-resolved `tmux` invocation, so `tmux kill-server` without an explicit
`-L`/`-S` socket is refused — and the **user-global gui display artifact** — a
host-independent marker-owned shell-startup block that evals
`rk gui env` through that launcher pointer inside tmux panes, so `DISPLAY`/`RK_GUI_SOCKET`
reach new shells once the user turns the GUI on (full semantics in
[gui](/run-kit/gui.md) § Agent verbs). (bbv1) (r7v8)
The shim script is in its **second generation** —
`rk agent setup` writes `exec "<abs-rk>" mux guard "$@"`; first-generation
installs exec'ing the literal `tmux-guard` keep working
through the permanent hidden root alias and roll over only on the next re-run
(260815-mi5s-mux-guard-move). Its install/uninstall contract, decision rule, and
doctor check live in [tmux-guard-shim](/run-kit/tmux-guard-shim.md); the shim
reuses this installer's `consent`/`authorizeWrite` machinery, its
summary-on-consent / full-diff-on-`--dry-run` rendering split, and its
`resolveRkPath`/`validateHookPath` path discipline.
(260805-blyf-tmux-guard-path-shim)

The command surface is `rk agent setup` / `rk agent setup --uninstall`, and
`--uninstall` reverses all three families. The
visual-display context-injection role belongs to the **`rk skill` bundle** (served
by the `skill` subcommand, aggregated by the coming `shll agent-setup`), described
in [cli](/run-kit/architecture/cli.md) § CLI Subcommands; the only skill trace
in `rk agent setup` is a **one-release legacy cleanup** that removes a stale
`rk-display` copy left by an older run-kit (see § Legacy `rk-display` Cleanup).
(260717-agst)

**Per-agent installer registry** (`agentRegistry(home) []agentConfig`): one entry
per supported harness — **Claude Code** (`~/.claude/settings.json`), **Codex**
(`$CODEX_HOME/hooks.json`, default `~/.codex`), **Gemini CLI**
(`~/.gemini/settings.json`), **GitHub Copilot CLI**
(`$COPILOT_HOME/hooks/run-kit.json`, default `~/.copilot`), **Kimi Code**
(`$KIMI_CODE_HOME/config.toml`, default `~/.kimi-code`), **OpenCode**
(`~/.config/opencode/plugins/run-kit.js`), and **Antigravity CLI** (`agy`,
`~/.gemini/config/hooks.json`). Each `agentConfig`
carries a display `name`, the registry provider token, an **installer kind**
with its target path(s), the agent binary's `comm` (process
name — threaded into both the installed wrapper's `--agent` value
and `agent_hook.go`'s pid-resolution walk), an ordered
`[]agentHook` (event + optional matcher + fixed state token), and a
`postInstallNote` naming the harness-side activation step (below). Installs are
**PATH-gated** (a harness whose binary is not on PATH — the `binary` field of its
runtime descriptor, probed through the `agentBinaryOnPathFn` seam — is skipped
with a note); uninstalls are **ungated** so removal still works after the harness
itself is gone. The command's Long help (`agentSetupLong`) names every supported
harness and its config target (kept honest by
`TestAgentSetupLongListsEveryProvider`). (nnqu)

**Three installer kinds** (`installerKind`) share the one consent/diff/dry-run/
uninstall machinery: (nnqu)

- **jsonHooksMerge** — a nested
  `hooks → <Event> → [{matcher?, hooks:[{type:"command", command}]}]` merge
  preserving everything non-rk: claude, codex, gemini. The agy variant
  (`namedHooksDoc`, targeting `~/.gemini/config/hooks.json`) handles a document
  whose top level is named hooks: rk owns exactly the `run-kit` key, holding
  flat PreInvocation/Stop handler arrays.
- **markerFile** — a whole marker-owned file, the native one-file-per-source
  shape: copilot's hooks file (mode **0600**, flat camelCase entries, matcher on
  the entry) and opencode's JS plugin (mode **0644** — over opencode's event
  stream, the only hook surface; the plugin pipes each event payload to
  `rk agent hook` itself). Ownership is **every-entry**
  (`markerFileOwned`, `cmd/rk/agent_setup_markers.go`): a managed-by comment
  marker means rk-authored outright; a JSON hooks file is rk-owned only when it
  parses AND every hook entry's command carries an rk marker. A mixed user+rk
  file is never overwritten or removed — install and uninstall both leave it
  byte-exact with a narrated skip.
- **markerBlock** — kimi's `$KIMI_CODE_HOME/config.toml`: a marker-owned
  `[[hooks]]` block upserted/removed via the shared
  `upsertMarkerBlock`/`markerBlockBounds` machinery (no TOML parser; only the
  four documented fields `event`/`matcher`/`command`/`timeout` are emitted —
  unknown fields fail the whole config load; surrounding content is preserved
  byte-exactly). Dry-run previews render **only the managed block region**,
  never unrelated config values (credentials never printed).

The Claude event→state mapping:

| Event | Matcher | State |
|-------|---------|-------|
| `UserPromptSubmit` | — | `active` |
| `PreToolUse` | — | `active` (heartbeat; also covers subagent tool churn) |
| `Notification` | `permission_prompt\|elicitation_dialog\|agent_needs_input` | `waiting` |
| `Notification` | `idle_prompt` | `idle` (backstop — `Stop` doesn't fire on every turn-end path, e.g. Esc-interrupt) |
| `Stop` | — | `idle` |

The other six harnesses (the verified per-harness capability matrix — versions,
mechanisms, install targets, identity fields, transcript support, activation —
lives in [`docs/site/agent-hooks.md`](../../site/agent-hooks.md)): (nnqu)

- **codex**: UserPromptSubmit/PreToolUse→active, PermissionRequest→waiting,
  Stop/SessionEnd→idle, SessionStart→stamp (sources
  startup\|resume\|clear\|compact).
- **gemini**: BeforeAgent/BeforeTool→active, Notification(ToolPermission)→waiting
  (**observability-only** — Gemini permission prompts cannot be answered by hooks,
  but the event fires before the prompt), AfterAgent/SessionEnd→idle,
  SessionStart→stamp (sources startup\|resume\|clear only — no mid-turn compact
  source).
- **copilot** (camelCase event names): sessionStart→stamp,
  userPromptSubmitted/preToolUse→active, permissionRequest and
  notification(permission_prompt\|elicitation_dialog)→waiting,
  notification(agent_idle)/agentStop→idle. Identity + lifecycle **only** — no
  transcript adapter (a session's identity does not determine a conversation
  file), so transcript-backed actions stay gated off; see
  [agent-send](/run-kit/agent-send.md).
- **kimi**: SessionStart→stamp, TurnStarted/PreToolUse→active,
  PermissionRequest→waiting, Stop→idle.
- **opencode**: session.created→stamp, session.status busy→active,
  permission.updated→waiting, session.idle→idle — via the installed JS plugin,
  which resolves every event's session through the SDK (`client.session.get`)
  and ignores any with a `parentID` (child/subagent sessions never reach rk;
  resumed roots work with no new session.created). The plugin no-ops outside
  tmux (`TMUX_PANE` unset) and swallows every error.
- **agy**: PreInvocation→active + identity stamp, Stop→idle (fullyIdle-gated).
  There is **no waiting signal** (PreToolUse/PostToolUse are deliberately not
  hooked — their contract answers permission decisions, and telemetry must never
  emit allow/deny) and **no SessionStart event** (identity lands on the first
  model invocation).

Subagent/child harness events (Codex SubagentStart/Stop, Kimi
SubagentStart/Stop, Copilot subagentStart/Stop) are registered by **no**
installer — enforced by a registry-wide assertion test — so a child event can
never replace the root pane's identity or complete its turn. (nnqu)

**Post-install activation** (`postInstallNote`, printed on install whenever the
harness has a step rk cannot perform): the native activation steps stay **user
actions** — Codex skips non-managed hooks until trusted (the user runs `codex`,
opens `/hooks`, and trusts the run-kit entries; until then the hooks are
installed but **INACTIVE**); Gemini, Kimi, and agy read hook config at session
start (restart or new session); Copilot loads hook config at CLI start; OpenCode
loads plugins at startup. (nnqu)

**Doctor aggregation**: `rk doctor`'s `agent hooks` row (`agentHooksCheck`)
aggregates across **every** registry agent — per-agent generation
classification including marker-file/marker-block presence and staleness —
instead of returning after the first entry. (nnqu) The path check is
**multi-path**: `hookRkPaths` extracts every double-quoted token immediately
before each ` agent hook ` occurrence (a two-path wrapper carries two), and the
opencode plugin is parsed for both of its consts via `extractRkHookCommands`.
The row **fails only when every embedded path dangles**; a dangling launcher
with a live stable path (the expected state between brew cleanup and the next
daemon start) or a dangling stable path with a live launcher passes with an
advisory note (`launcher <path> dangling — re-run rk agent setup`), and a
single-path wrapper passes with the note `single-path wrapper — re-run rk agent
setup to add the launcher fallback`. `classifyHookGeneration` stays at three
generations — the two-path shape carries the same ` agent hook ` family marker.

**Hook command** (`agentStateHookCommand(launcherPath, stablePath, state, provider)`): a **stable
delegating wrapper** that keeps all logic in the rk binary (see § `rk agent hook`
above) —

```sh
/bin/sh -c '[ -n "$TMUX_PANE" ] || exit 0; "<launcher>" agent hook --agent claude <state> 2>/dev/null || "<stable>" agent hook --agent claude <state> 2>/dev/null || true'
```

Two machine-derived absolute paths, each covering the other's upgrade hole:
**`<launcher>`** is the rk-owned launcher symlink (`selfpath.LauncherFor(home)` =
`~/.local/share/rk/bin/run-kit`), whose target is the resolved Cellar binary —
live through Homebrew's unlink→install→link window, in which the brew-prefix
symlink dangles (see [build-and-release](/run-kit/build-and-release.md)
§ Homebrew Distribution). **`<stable>`** is the `resolveRkPath()` result (the
brew-prefix stable symlink), re-linked in Homebrew's `finish` — it covers the
gap between the old keg's cleanup and the daemon's next re-point of the
launcher. The `||` chain advances **only on exec failure** (127/126): `rk agent
hook` itself always exits 0, so a binary that runs is never retried on the
second path. Both paths are validated by `validateHookPath` before any file is
written, and both sit double-quoted inside the single-quoted `sh -c` body. The
brew daemon re-points the launcher at every `rk serve` start — see
[daemon-lifecycle](/run-kit/daemon-lifecycle.md) § `rk serve` Wiring.

This is still the **third-generation** form by marker (` agent hook `); the
two-path shape adds a second invocation under the same family marker, so
`isRkEntry` replaces single-path installs in place on the next `rk agent setup`
re-run and `--uninstall` strips every generation. Installs written earlier
carry the single-path third-generation form (or the second-generation
`agent-hook` literal / first-generation inlined one-liner) and keep working
unmodified through the permanent hidden alias and the wrapper's second path —
they gain the launcher fallback only on the next re-run, plus an agent-session
restart (harnesses snapshot hook config at session start; `rk doctor` notes the
single-path shape). (260815-r2wp-agent-family)

The interpreter is absolute like both rk paths: hooks fire under the
harness's environment, and a bare `sh` fails on sessions whose PATH lacks /bin.

The `$TMUX_PANE` guard stays in the wrapper as a cheap short-circuit (no binary
spawn outside tmux); `|| true` preserves the never-fail contract even if both
binaries are missing or moved (silent no-op is acceptable — the PID-liveness
reconciler clears stranded values, and `active`'s exposed age flags the
live-idle-agent case). state and provider are fixed registry literals;
the only machine-derived interpolations are the two paths, closed by
`validateHookPath` (below). Delegating to the binary means hook *logic* changes
ship with the binary on `brew upgrade rk`, no settings churn, no session
restarts. (260707-qfps) Every installer kind carries the same two-path fallback
in its own syntax: the JSON hooks merge and copilot's marker-owned file embed
the shell wrapper verbatim, kimi's TOML block embeds it through
`tomlBasicString`, and the opencode plugin declares `const RK` (launcher) plus
`const RK_FALLBACK` (stable) and retries **only on a spawn-level exec failure**
(the child `error` event — the exact equivalent of the shell's 127, since a
spawned process's non-zero exit never retries).

**agy wrapper variant** (`agentStateHookCommandJSON`): agy's hooks.json handler
contract parses stdout as a JSON result object, so this variant runs the
identical two-path report (braced `{ … || …; }` group) and then echoes `{}` — a
well-formed **no-decision** result (an empty object carries no allow/deny/continue field,
so native permission and termination behavior is preserved exactly). It always
exits 0 — the trailing echo is the last command. (nnqu)

**Install-time path resolution** (`resolveRkPath()`): the `<stable>` path
embedded in the wrapper is resolved once per `runAgentSetup` invocation. It prefers
`exec.LookPath("run-kit")` (a long alias the formula installs), then falls back to
`exec.LookPath("rk")`, then `os.Executable()`. Either LookPath hit yields the
STABLE Homebrew symlink (`/home/linuxbrew/.linuxbrew/bin/{run-kit,rk}` or
`/opt/homebrew/bin/{run-kit,rk}`, NOT the version-pinned Cellar path) — both
stable symlinks resolve to the same binary, so the order is functionally
equivalent, and the `resolveRkPath` test is order-agnostic (asserts only
non-empty + absolute). The `os.Executable()` fallback runs **without**
`filepath.EvalSymlinks` (resolution would pin the Cellar version and re-freeze the
hook's stable path). **Installed hooks embedding `…/bin/rk` remain valid indefinitely**: `rk`
stays a real on-PATH symlink (per the canonical-swap invariants — see
[build-and-release](/run-kit/build-and-release.md) § Homebrew Distribution), so a hook
resolved to `/opt/homebrew/bin/rk` keeps working. (260709-gidk) Before any merge
BOTH paths — the `<stable>` result and the home-derived `<launcher>` path — are
run through `validateHookPath`: a path containing any of `' " $ ` backslash (all
shell-active inside the wrapper's double-in-single quoting) **fails the install
with a clear error** — reject-don't-escape (escaping would have to survive three
nested quoting layers; such paths never occur under Homebrew/conventional
layouts, so the error is essentially unreachable in practice and a caller — human
at a TTY or agent passing `--yes` — sees it and acts).

The **launcher's own target** is resolved separately from the path embedded in
the wrapper: `filepath.EvalSymlinks(rkPath)` of the validated PATH-found stable
symlink — the resolved Cellar binary — falling back to `rkPath` unchanged when
it does not resolve. The running setup binary's own location is deliberately
not trusted: a dev-worktree `bin/rk agent setup` still points the machine's
launcher at the installed Homebrew binary (the same posture `resolveRkPath`
takes). The serve-time re-point, which runs from the installed daemon, uses
`selfpath.Resolve()` instead.

**jsonHooksMerge install** (`mergeHooks`/`unmergeHooks`, pure functions over
`map[string]any` so tests skip the filesystem/prompt):

- Merges under the nested shape
  `hooks → <Event> → [ { matcher?, hooks: [ { type:"command", command } ] } ]`
  (the claude/codex/gemini targets). The agy `namedHooksDoc` variant merges into
  a document whose top level is named hooks: rk owns exactly the `run-kit` key,
  holding flat PreInvocation/Stop handler arrays. (nnqu)
- **Idempotent**: for each touched event array it **first** strips every existing
  rk-owned entry (once per event — an event may carry multiple rk hooks, e.g.
  `Notification` maps to both `waiting` and `idle`), **then** appends the fresh
  entries — so a re-run replaces in place and never duplicates.
- rk-owned entries are identified by `isRkEntry`, which
  matches **all three generations** of the command string: the LEGACY marker
  `rkHookMarker` (**bound to `tmux.LegacyAgentStateOption`, `@rk_agent_state` — the
  first-generation inlined one-liner carries the retired unscoped option name,
  so the recogniser tracks the legacy constant**), the second-generation const
  `rkHookMarkerAgentHook` (`" agent-hook "`, spaces included so it can't match an
  unrelated token), and the third-generation `rkHookMarkerAgentHookFamily`
  (`" agent hook "` — the family form the installer writes today). Matching all
  three lets a re-run strip
  old-generation entries and replace them **in place** (no duplication), and lets
  `--uninstall` remove **every** generation. Non-rk hooks carry no marker and
  are preserved untouched. (`260707-qfps`; third generation `260815-r2wp-agent-family`)
- `--uninstall` runs `unmergeHooks`, removing exactly the rk-owned entries; an
  event array that empties is deleted, and a `hooks` object that empties is
  deleted.
- **Consent context + confirm before write**: `applyAgentHooks` (the hooks step
  `applyAgentConfig` runs — see § Installer Structure) renders a **semantic
  per-entry summary** on the interactive and `--yes` paths (`renderHooksSummary`:
  one `+ {event} ({matcher}) → {state}` line per registry row — the SessionStart
  row displays as `session stamp + idle (boot-ready)` — plus a preservation note and a replace/remove
  count computed by `countRkEntries` over the CURRENT settings, never hardcoded;
  the uninstall form is a single `- removes N rk-owned hook entries` line). The
  **full** `current` vs `proposed` sorted-indented-JSON bodies render only under
  `--dry-run` (the shared `renderArtifactDiff` helper — the explicitly-requested
  preview data). A no-op (identical) is reported and skipped without prompting;
  otherwise the write decision routes through `consent.authorizeWrite` (see the
  § `rk agent setup` consent flags above) — `--dry-run` skips the write,
  `--yes`/`-y` writes without prompting, an interactive TTY reads a `[y/N]` answer
  (`confirm`, default No) from the injected `io.Reader` (testable without a TTY),
  and a non-TTY invocation with neither flag **refuses** (error naming `--yes`,
  nothing written). On confirm, `writeSettings` writes mode **0600** (matching
  user-config sensitivity), creating `~/.claude/` via `MkdirAll` if absent. The
  legacy-skill cleanup (`removeLegacySkill`) is gated through the same
  `authorizeWrite` seam, so `--yes` authorizes the `os.RemoveAll` of the legacy
  `rk-display/` directory and `--dry-run` leaves it in place.

**Tolerant read** (`readSettings`): a missing, empty, or all-whitespace settings
file is treated as an empty object (never an error — install must work on a fresh
machine). A genuinely malformed (non-empty, non-JSON) file **surfaces an error
without writing** — anti-clobber: silently treating it as empty would overwrite
user config.

## Installer Structure — Per-Agent Loop, then the User-Global Blocks (`runAgentSetup`)

`runAgentSetup` resolves the home dir, `$ZDOTDIR`, the absolute rk path, and
the launcher path once at its boundary (both paths `validateHookPath`-validated
before anything is written, so everything below stays pure over injected
paths), then runs:

1. **The launcher pointer step** (`installLauncherPointer`, its own consent
   prompt, `launcher:`-prefixed messages) — links `~/.local/share/rk/bin/run-kit`
   → `filepath.EvalSymlinks(rkPath)` (the resolved Cellar binary; falls back to
   `rkPath` unchanged when it does not resolve). It runs FIRST, ahead of every
   per-agent hook install, the shim, and the gui block (artifact before the
   things that exec it — the tmux-shim ordering precedent), because the
   installed hook wrappers exec it first. A declined or foreign pointer never
   blocks the hooks — the wrapper's second path covers a missing launcher. The
   flow is the pointer flow the gui display artifact established: probe →
   consent → `MkdirAll` after consent → re-probe → atomic replace via
   `selfpath.ReplaceSymlink` (temp symlink + rename, stale-temp sweep); an
   already-current symlink is a no-op; a symlink with any other target (a moved
   install, a dangling brew-rename leftover, an older install's stable-path
   target) is relinked on consent; a non-symlink is foreign and left untouched.
   Its verdict (`guiPointerState`: InPlace / Foreign / Declined) is threaded
   into step 4. Skipped entirely on uninstall.
2. **The per-agent loop** — `applyAgentConfig` for each registry row.
3. **`applyTmuxShim`** — the user-global tmux guard shim (one shim, one PATH
   block, not per agent), applied once **after** the loop. See
   [tmux-guard-shim](/run-kit/tmux-guard-shim.md) § `rk agent setup`
   install/uninstall contract. (260805-blyf-tmux-guard-path-shim)
4. **`applyGuiDisplayBlocks`** — the user-global gui display artifact: the
   marker-owned `# >>> rk gui display >>>` block, applied
   once **after** `applyTmuxShim` into the same startup-file set
   (`tmuxGuardStartupFiles(home, zdotdir)`) with the same
   consent/diff/dry-run/uninstall machinery. It is **independent of the shim's
   outcome** (a declined shim write does not skip it) but **gated on the
   launcher step's verdict** (consumed, not re-run): the block is written only
   when the pointer is in place (fresh,
   current, or a dry-run preview), and a foreign non-symlink at the pointer
   path strips any existing block, so a startup file never execs a non-rk file.
   The block body is a `$HOME`-relative constant — byte-identical on every
   host — and the validated rk path lives only in the pointer, so dotfile-synced
   startup files converge. On uninstall it strips the blocks first, then removes
   the pointer LAST (`removeLauncherPointer`, after the hooks and the gui block
   that reference it), running with `rkPath=""` (removal
   needs no path). See [gui](/run-kit/gui.md) § Agent verbs. (bbv1) (r7v8)

`applyAgentConfig` is the thin per-agent wrapper, running in order:

1. **The installer-kind dispatch** — `applyAgentHooks` (jsonHooksMerge),
   `applyAgentMarkerFile` (markerFile), or `applyAgentMarkerBlock` (markerBlock),
   as described above. Always runs. On install, the agent's `postInstallNote` is
   printed (chatter) whenever the harness has an activation step rk cannot
   perform. (nnqu)
2. **`removeLegacySkill`** — the one-release cleanup of the legacy `rk-display`
   skill (below). Runs only when the agent's `skillsDir` is non-empty.

Each step runs **independently** — its own tolerant read, diff/prompt, and no-op
report — so declining or no-op-ing one does not skip the others. `agentConfig`
carries a `skillsDir string` field; the Claude Code registry row sets it to
`filepath.Join(home, ".claude", "skills")`, and an **empty `skillsDir` means "no
legacy skill to clean for that agent"** — only the hooks install runs (every
non-claude row leaves it empty). `skillsDir` exists
**solely to locate the legacy skill for cleanup**.

### Legacy `rk-display` Cleanup (`removeLegacySkill`, one release only)

`removeLegacySkill` is a **cleanup-only** flow that removes a stale
user-global Claude Code skill at `{skillsDir}/rk-display/SKILL.md` (so
`~/.claude/skills/rk-display/SKILL.md` for Claude Code) left by an older run-kit
that once installed it. The visual-display context-injection role belongs to the
**`rk skill` bundle**, aggregated by the coming `shll agent-setup`. (260717-agst)

- **Runs on BOTH the install and uninstall passes.** `removeLegacySkill` is called
  from `applyAgentConfig` regardless of `--uninstall`. Rationale: re-running plain
  `rk agent setup` is the documented upgrade action (`docs/site/install.md`), so
  most machines only ever reach the install path — a cleanup gated on `--uninstall`
  would never fire for them, stranding the file forever.
- **Uniform behavior across both passes** (keyed on the file's state, not the mode):
  - **Absent** file → **silent** in both modes. A fresh machine produces zero
    rk-display output.
  - **Marker-less** (user-rewritten) file → **left untouched with a skip note** (rk
    only removes files it owns).
  - **Marker-owned** file → **offer removal** (confirm prompt), then `os.RemoveAll`
    the whole `rk-display/` directory. Confirmed first because it deletes the entire
    directory, including any user-added files within it.
- **Recognition machinery**: the marker constants `rkDisplaySkillDir`/`rkDisplaySkillFile`/
  `skillManagedByMarker`, the tolerant `readSkill` (missing → empty, never an
  error), and the whole-file `skillHasMarker` predicate (the whole-file analogue of
  `isRkEntry` — rk owns the entire file, so a `managed-by: rk agent-setup`
  frontmatter-marker presence check gates the destructive removal). No content
  literal exists — the cleanup only LOCATEs and RECOGNIZEs, never writes.

## Lifecycle

Pane options die with the pane — **no GC, no state file, no cross-pane
ambiguity**. An option lives on exactly one pane of exactly one tmux server;
killing the pane (or the server) removes it. This is why the shell-command
reconciler is the only cleanup needed: a killed agent's pane either dies (option
gone) or reverts to a shell (reconciler zeros it).

## Migration — Clean Swap, No Dual-Source Fallback

The fab tier carries only fab pipeline state: the native derivation yields
`change`/`stage`/`display_state` (not `agent_state`, `agent_idle_duration`,
`pr_url`, or `pr_number`), and the window rollup priority is change-bound >
first-seen.
See [backend-packages](/run-kit/architecture/backend-packages.md) § `internal/sessions`.

There is **no dual-source fallback**: until `rk agent setup` has been run on a
machine, agent columns read unknown (`—`). Accepted for a single-operator
deployment — rollout is "deploy rk, run `rk agent setup` once per machine"
(fallback code would contradict minimal-surface §IV and would linger). fab-kit
keeps writing `.fab-runtime.yaml` `_agents` until its own reader-side change
(fab-kit backlog `[ioku]`) lands — harmless coexistence, run-kit simply stops
reading the old sink.

## UI Surfacing

The `agentState` three-state value is a first-class UI input across every surface
(design authority `docs/specs/status-pyramid.md`, palette v3). (260706-y1ar) What consumes it:

- **`StatusDot` (two-family ladder)**: a fresh `agentState` on a
  non-fab window drives the **warm ad-hoc-agent family** — yellow
  (vs the cool fab family blue/green, vs the gray floor). Shape is liveness:
  `agentState === "active"` is solid (mid-turn); `idle` and `waiting` are
  rings (at rest). A `waiting` window of ANY tier gets an **additive
  signal-yellow pulsing halo** over that ring base (core hue +
  shape untouched — never a hue-flip). See
  [ui/status-signals](/run-kit/ui/status-signals.md) § Status Dot. (18ot)
- **Row Minimalism**: the sidebar window row carries no trailing stage-word +
  duration cluster — its status signals are the `StatusDot` plus an owned-PR
  rest glyph (§ Window rows).
- **L1 `agt` register**: the five-register view (out/agt/fab/PR/opr) renders
  `waiting <dur>` on its own line, never muted by flowing output (the pierce
  rule), on BOTH register surfaces — the PANE panel and the row-hover flyout
  card (§ Pane panel five-register view, § Row-hover register flyout card).
- **Attention rollups + nav**: `waiting` counts propagate as `WaitingBadge` chips
  (session row, Host-page server tile, board header, and — since
  `260708-4li7-sidebar-server-tile-waiting-badge` — the sidebar SERVER-panel
  server tile, the fourth badge surface), a pulsing board-pane seam, and the
  `Agent: Next waiting` command-palette navigation (§ Attention Surfacing). See
  [ui/status-signals](/run-kit/ui/status-signals.md) § Attention Surfacing for the surface
  list and the sidebar tile's inline-flex placement (distinct from the Host-page
  tile's absolute top-right, to avoid the sidebar tile's hover-action cluster).
- **Web Push on sustained waiting**: the SSE hub fires one push per sustained
  (≥15s) waiting episode — see [architecture](/run-kit/architecture.md)
  § Web Push on Sustained Waiting.

These surfaces consume the window-level rollup + `waiting > active > idle`
precedence + the `formatAgentDuration` value documented above. The rollup
populates the duration for `active` too; the SPA renders it only for the two
rest states (every consumer gates on `agentState === "waiting" || "idle"`, so
rendered output is unchanged), while the machine surfaces carry it for `active`
as the staleness signal.

## Boot-Ready Signal

"Safe to type into a freshly spawned agent" is a **derived readiness signal, not
a new state**. A pane is **boot-ready** when:

- **State-present** (preferred): its reconciled `@rk_pane_agent_state` is
  present (any of `idle`/`waiting`/`active`) — presence means the agent's hooks
  fired, so its TUI finished booting. The SessionStart registry row's `idle`
  stamp (see § Installer: SessionStart registry row) is what makes this true at
  boot for registry agents, with no new state value and no schema change (agy,
  which has no session-start event, reaches state-presence on its first
  PreInvocation `active` fire). (nnqu)
- **Capture-settle** (fallback for agents without installed hooks): the pane's
  captured screen is non-blank and byte-identical
  across two consecutive polls (~600ms apart, bounded by a ~25s deadline).

The primitive lives in `internal/inject` (`AwaitReady` polls both signals,
first hit wins; `DeliverWhenReady` is the spawn-then-deliver composite —
readiness wait, then the engine's verified send) and is exposed on the CLI as
`rk mux await --ready` — see [agent-messaging](/run-kit/agent-messaging.md)
§ `rk mux await` observer and [architecture](/run-kit/architecture.md)
§ Backend Libraries → `internal/inject`. Between the state signal and the
sentinel probe sits a geometry floor: a settled pane below 80×20
(`inject.ReadyMinCols`×`inject.ReadyMinRows`) in either dimension classifies
`narrow` — the probe cannot be trusted at that size — instead of being probed. For hook-less agents the documented
composition is `rk mux await --ready %5 && rk mux send --force %5 '<prompt>'`
(`send` stays gated on agent state, which a hook-less pane never has; `--force`
is the documented pairing). Caveat: a settled **first-run dialog** can
false-fire the settle signal — the delivery engine's echo probe catches it
(`ProbeFailure` → the caller degrades), so readiness is a heuristic, not a
proof.

## Agent Session Identity (`@rk_pane_agent_session`)

A **second** pane user option, written by the **same** `rk agent hook` binary on
the same hook fires, ties a pane to the **live** agent session running in
it. It keys every agent-session-identity consumer: the operator-request seam's
`TranscriptPath` fact derivation, fork/resume's session-ref resolution,
auto-name dispatch, the agent-pane rollup (`sessions.ResolveAgentPane`) behind
`/send`'s `target:"agent"` mode, and the operator feature gates. The scope here
is backend + hooks + spec. The
cross-repo contract is in [`docs/specs/agent-state.md`](../../specs/agent-state.md)
§ Agent Session Identity; this section records what run-kit actually implemented.
(260713-nh86)

**Why a hook, not derivation.** Claude Code sessions are disk-owned — each
persists to `~/.claude/projects/<cwd-slug>/<session-id>.jsonl` and any process in
the cwd can resume by id — but *multiple transcripts share a cwd*, so "which
session is live in this pane" is underivable from disk/tmux/git. It exists only
in the hook input JSON, exactly the class of fact **Principle X** reserves for
hooks.

### The Convention

| Property | Value |
|----------|-------|
| Option | `@rk_pane_agent_session` (const `tmux.AgentSessionOption`) |
| Scope | tmux **pane** user option (`set-option -p`) |
| Value | `"<provider>:<session-ref>"` |
| Example | `claude:6f0d9e2a-1c3b-4f7e-9a2d-8b5c4e1f0a37` |

- **`<provider>`** — a lowercase token (`[a-z][a-z0-9_-]*`) equal to the runtime
  registry's canonical provider token — one of `claude`, `codex`, `gemini`,
  `copilot`, `kimi`, `opencode`, `agy` (`cmd/rk/agent_registry.go`).
  The backend routes on this prefix; the frontend gates on presence. (nnqu)
- **`<session-ref>`** — a provider-defined opaque reference. For `claude` it is
  the **session UUID only** — NOT the transcript path (the path is derivable from
  the UUID by glob, so Principle X says carry only the UUID; a colon-free value
  also keeps parsing trivial). Other providers carry their native session
  identifier (copilot's camelCase `sessionId`, agy's protojson `conversationId`,
  opencode's `ses_…` id) — the writer stamps whatever the payload's per-provider
  `sessionIDField` yields; per-provider transcript/conversation resolution is
  documented in [agent-send](/run-kit/agent-send.md). (nnqu) The value is split on the **first** colon
  (providers never contain a colon; a ref might in principle, so the tail is the
  ref verbatim).
- `tmux.AgentSessionOption = "@rk_pane_agent_session"` is declared **once** in
  `internal/tmux/tmux.go`; `cmd/rk/agent_hook.go` aliases it
  (`agentSessionOption = tmux.AgentSessionOption`) rather than
  re-declaring — one source of truth per binary (A-021), same discipline as
  `AgentStateOption`. The retired previous name survives as
  `tmux.LegacyAgentSessionOption = "@rk_pane_chat"` — the dual-read fallback and
  dual-write second name for one release. (260904-bf1l-agent-session-identity-rename)

### Reader: parse + reconcile (`internal/tmux`)

- **`paneFormat` carries the agent-session field `#{@rk_pane_agent_session}` as field 10**,
  dual-read with the fallback `#{@rk_pane_chat}` at field 9 — new wins;
  `parsePanes`'s skip-guard is `< 12` (field 11 is `pane_pid`). Zero extra
  subprocess — it rides the existing per-session `list-panes` call.
- **`PaneInfo` carries `AgentProvider string`** (`json:"agentProvider,omitempty"`)
  **and `AgentSessionRef string`** (`json:"agentSessionRef,omitempty"`), parsed once
  in Go so no consumer re-splits the raw value.
- **`parseAgentSessionRef(raw) (provider, ref string)`** — pure helper: trims,
  splits on the first colon, validates the provider via `isAgentProvider`
  (`[a-z][a-z0-9_-]*`, non-empty) and the ref via `isAgentSessionRef` (non-empty,
  no whitespace/control). Any
  violation ⇒ `("", "")` (wholly unknown, mirroring `parseAgentState` tolerance).
  A well-formed **unregistered** provider (e.g. `codex:…`) is NOT rejected —
  presence-gating is provider-agnostic; adapters are additive.
- **Agent-session reconciliation shares agent-state's per-pane liveness decision.**
  `@rk_pane_agent_session` carries **no pid of its own** (the two-segment schema is fixed), so
  liveness comes from the **same pane's agent-state option** (either name —
  the new-wins-resolved raw value), written by the same
  binary on the same fires. The `parsePanes` reconciler uses a single shared
  `stale` boolean:
  - agent-state carries a pid (3-segment): `stale = !agentProcessAlive(pid)`.
  - otherwise (no agent-state yet, or a legacy 2-segment value):
    `stale = isShellCommand(command)`.
  - when `stale`, **both** the agent-state fields **and** the agent-session
    fields are zeroed. A dead pid zeroes both; a plain-shell/htop pane never
    surfaces an agent session.
  Accepted **false-negative class** (mirrors the agent-state legacy fallback): a
  *wrapped* launch (`pane_current_command` = `bash` with claude inside) that
  `SessionStart` stamped but which has no pid-bearing agent-state yet suppresses
  the session identity until the first state write lands a pid — it self-heals
  at the first prompt. A live pid-bearing agent under a `bash` wrapper keeps its
  session identity (liveness wins over the shell heuristic).
  (260904-bf1l-agent-session-identity-rename)
- **No disk validation** — the reconciler does NOT stat
  `~/.claude/projects/**/<ref>.jsonl`. Per-pane-per-poll filesystem I/O guarding a
  pathological case; a live agent's transcript exists by construction, and the
  transcript-reading consumers (operator actuation, fork, closed-resume,
  auto-name) surface a missing transcript naturally as a read error.

### Writer: `rk agent hook` stdin-JSON seam + session stamp (`cmd/rk/agent_hook.go`)

The hook reads the session identity from the harness's hook JSON on stdin (the
field varies per provider — the runtime descriptor's `sessionIDField` picks the
authoritative one), scoped to
session identity only — state still comes from the positional arg and pid from the
process tree, and state derivation stays in the installed hook/plugin event
mappings. The stdin seam:

- **`readHookInput(r io.Reader) (hookInput, bool)`** — the conservative stdin parse:
  - **TTY guard** — if `r` is an `*os.File` in char-device mode
    (`os.ModeCharDevice`), it is NOT read, so a manual `rk agent hook` invocation
    in a terminal never blocks on stdin.
  - **Bounded** — reads through `io.LimitReader(r, hookStdinReadLimit)` where
    `hookStdinReadLimit = 1 << 20` (~1 MiB), so a hung/pathological producer can't
    stall the agent's turn.
  - **Single object** — `json.Decoder.Decode` into `hookInput` (fields
    `session_id` / `sessionId` / `conversationId` / `source` / `fullyIdle`)
    returns after ONE complete JSON object, with no dependence
    on stdin EOF (which the harness docs don't guarantee). Unknown JSON keys are
    tolerated. The provider's runtime descriptor picks the authoritative
    session-identity field (`rt.hookSessionID(in)`). (nnqu)
  - **Validated** — `isValidSessionID` (non-empty, no whitespace/control) mirrors
    the reader's `isAgentSessionRef` so a value the reader would reject is never
    stamped.
    (The rule is duplicated in the hook binary because the reader's
    `isAgentSessionRef` is unexported — small and stable, deliberate.)
  - Injected via the `hookStdinFn` package-var seam (`func() io.Reader { return
    os.Stdin }`) so tests supply an in-memory reader.
  - Every failure path returns a zero `hookInput` with `false` (no stamp, no boot
    write) — never an error.
- **`writeAgentSession` / `writeAgentSessionImpl`** (behind the
  `writeAgentSessionFn` seam, mirroring
  `writeAgentStateFn`): **one** `tmux [-S <socket>]` exec carrying two
  `;`-chained `set-option` commands as discrete argv elements —
  `set-option -pt <pane> @rk_pane_agent_session <provider>:<sessionID> ;
  set-option -pt
  <pane> @rk_pane_chat <provider>:<sessionID>` (tmux command chaining, no shell;
  the same dual-write-as-one-exec shape as the agent-state write, via the shared
  `dualWritePaneOption` helper) —
  via `exec.CommandContext` + `agentHookCmdTimeout` (5s),
  socket derived from **`tmux.OriginalTMUX`** (not `os.Getenv("TMUX")`, same
  reason as the agent-state write — see § Target the pane's server). `provider` is
  the runtime registry's canonical provider token (never the comm literal —
  kimi's comm is `kimi-code` but its provider token is `kimi`) and `sessionID` a
  pre-validated discrete argv
  element — nothing user-derived is interpolated into a shell string
  (Constitution I). Errors are swallowed (never-fail).
- **Token dispatch** — `runAgentHook` takes a **token** param.
  `writeState := isAgentState(token)`; a token that is neither a canonical
  state nor `agentHookStampToken` is a silent no-op. Ordering:
  1. `active|waiting|idle` → resolve pid via the ancestor walk, `writeAgentState`,
     **then** stamp `@rk_pane_agent_session` (dual-written with `@rk_pane_chat`)
     if stdin yielded a session id. The session stamp is
     **ordered after** the agent-state write, so the reader always has the pid it
     needs to judge agent-session liveness.
  2. **stamp token** (`agentHookStampToken = "stamp"`) → stamp
     `@rk_pane_agent_session`
     (`@rk_pane_chat`), **and** — when the parsed stdin payload's `source` does
     NOT equal the provider's **`compactSource`** — write
     `@rk_pane_agent_state idle:<epoch>[:<pid>]` (the
     boot-ready write: claude's SessionStart fires on
     `startup`/`resume`/`clear`/`compact`,
     and `compact` fires **mid-turn**, where an `idle` write would clobber a live
     `active`; providers with no mid-turn source never trip the gate). An
     unparseable payload withholds both writes: the idle write
     (fail-safe against the mid-turn clobber) and the session stamp (no session id
     can be decoded). This is the token the
     SessionStart row uses; the idle write doubles as a **stale-state clear**,
     overwriting a `waiting`/`active` left in the pane by a previous agent.
  3. anything else → no-op.
- **agy payload gates** — an `idle` write lands only when the Stop payload
  carries `fullyIdle: true` (`idleRequiresFullyIdle`: agy's loop termination can
  leave background tasks running, so anything less stays unknown rather than
  manufacturing an at-rest signal); the identity stamp still proceeds. (nnqu)
- **Stamp on EVERY fire that yields a session id** (states and the stamp token
  alike), not SessionStart-only, because **session ids rotate on `/clear` and
  `/compact`** (a one-time stamp goes stale mid-pane-lifetime); every-fire refresh
  also stamps already-running agents on `brew upgrade rk` with zero settings churn
  (the `260707-qfps` indirection dividend — the installed wrappers already pipe
  stdin through to the binary).
- The never-fail/always-exit-0 contract
  (`TestAgentHookCmdNeverErrorsOnMalformedInvocation`) holds — the stdin
  seam adds no new error path.

### Installer: SessionStart registry row (`cmd/rk/agent_setup.go`)

Every harness with a session-start event carries a stamp row in its installer
entry (claude/codex/gemini/kimi `SessionStart`, copilot `sessionStart`, opencode
`session.created` via the plugin; **agy has no session-start event** — its
identity lands on the first PreInvocation `active` fire). (nnqu) The claude row:

| Event | Matcher | Writes |
|-------|---------|--------|
| `SessionStart` | — | `@rk_pane_agent_session`/`@rk_pane_chat` stamp **plus** `@rk_pane_agent_state idle:<epoch>[:<pid>]` (token `stamp`; the idle write is withheld when `source` equals the provider's `compactSource`) |

- The installed command uses the standard `agentStateHookCommand(launcherPath, stablePath, state, provider)`
  wrapper — the positional-token `state` parameter carries the
  `stamp` literal from `h.state = agentHookStampToken`, producing
  `/bin/sh -c '[ -n "$TMUX_PANE" ] || exit 0; "<launcher>" agent hook --agent claude stamp 2>/dev/null || "<stable>" agent hook --agent claude stamp 2>/dev/null || true'`.
  The third-generation `isRkEntry` marker
  (`" agent hook "`) matches it, so idempotent re-run replacement and
  `--uninstall` need no marker changes.
- **SessionStart's idle write is the boot-ready signal** (see § Boot-Ready
  Signal): `idle` is semantically true of a freshly started/resumed session, and
  the stamp lands within seconds of session start — **before any prompt is
  submitted** (the acceptance bar) — and re-stamps on every session-id rotation.
  It also **clears a stale `waiting`/`active`** left in the pane by a previous
  agent. The write is gated on the hook payload's `source` against the provider's
  `compactSource` because a mid-turn compaction source (claude/codex `compact`)
  fires **mid-turn** — an `idle` write there would clobber a
  live `active` state; the other sources (`startup`/`resume`/`clear`) all
  stamp it. The idle write ships inside the `rk agent hook` binary, so it reaches
  running fleets on `brew upgrade rk` with no settings churn (the § Migration
  binary-vs-settings split).
- **No `SessionEnd` registration** — writer-side clearing is rejected. Reader-side
  reconciliation must exist anyway for crash/kill paths, so a `SessionEnd` clear
  would add a settings entry without removing any reader logic.

### Surfacing: window rollup (`internal/sessions`)

- **`WindowInfo` carries `AgentProvider`/`AgentSessionRef`** (JSON tags
  `agentProvider`/`agentSessionRef`), filled
  in `FetchSessions` beside the `rollupAgentState` call by the pure
  **`rollupAgentSession(panes) (provider, ref string)`** helper, which delegates
  to **`ResolveAgentPane(panes) (provider, ref, paneID string)`** so the rule
  lives in one place: the **active pane's**
  reconciled agent session if set, else the **first pane** (in tmux pane order)
  carrying one; `("", "")` when none. `ResolveAgentPane` also returns the agent
  pane's id — the correct injection target for agent-send (a window target routes
  to the active pane, which in a split may not be the agent pane). Deterministic
  — the common case is one agent pane per
  window; a later change can revisit the multi-pane rule without a backend
  contract break because **per-pane truth also ships** on
  `PaneInfo.AgentProvider/AgentSessionRef`. (260904-bf1l-agent-session-identity-rename)
- Both `GET /api/sessions` and the SSE `event: sessions` payload carry these
  fields via the existing `ProjectSession` marshal — **per window
  and per pane** — with no new endpoint and no new SSE event type. See
  [api-and-sockets](/run-kit/api-and-sockets.md) § API Layer.

### Lifecycle

Same as the agent-state tier: pane options die with the pane — **no GC, no state
file**. Reader-side reconciliation is the only clearing path (there is
deliberately no writer-side clear and no `SessionEnd` row, per above).

### Deprecation Ledger

The retired unscoped agent-state name `@rk_agent_state` is dual-read
(`paneFormat` field 6, `PaneFactsCtx`'s legacy field, preferring
the scope-named field new-wins) and dual-written (`rk agent hook`'s `;`-chained
second `set-option`), and the migration table holds its pane row as `CopyOnly`
until the follow-up removal change lands. The agent-session key's generations
sit one step further along: the unscoped `@rk_chat` generation is closed for
this key — it is neither written nor read — and `@rk_pane_chat`
(`tmux.LegacyAgentSessionOption`) is the dual-read fallback (`paneFormat` field
9, under field 10 new-wins) and the dual-write second name for one release. The
migration table carries the key's two `CopyOnly` pane rows in chain order —
`@rk_chat` → `@rk_pane_chat`, then `@rk_pane_chat` → `@rk_pane_agent_session` —
so a pane holding only `@rk_chat` chains forward transitively in ONE sweep pass
(each row re-reads the carrier); the sweep is idempotent and the chained copy is
pinned by a test. The hook writer and the daemon reader upgrade atomically per
host (the gen-3 hook text names no option — it calls `rk agent hook`), which is
what makes the `@rk_chat` close-out safe; no `rk doctor` migration row.
(260904-bf1l-agent-session-identity-rename) The agent-state removal change is
gated on fab-kit shipping
its new-then-old pane read (the daemon cannot dictate when other machines' fab-kit
reads the new name) with a fleet-clean `rk doctor` `agent hooks` row for about a
week of updates; it removes the exported `LegacyAgentStateOption`/
`LegacyAgentSessionOption`
constants, the legacy format fields and parser fallbacks, the dual-write second
`set-option`, the `CopyOnly` rows (unset-only for one further release, then
deleted), and `rk agent setup`'s gen-1 recogniser `rkHookMarker` (bound to
`tmux.LegacyAgentStateOption`). The run-kit checklist lives in
[tmux-sessions](/run-kit/tmux-sessions.md) § Deprecation Ledger; the cross-repo
contract + gate is reproduced in
[`docs/specs/agent-state.md`](../../specs/agent-state.md) § Naming / Deprecation
window.

### Migration — two independent seams

Mirrors the agent-state binary-vs-settings split:

- **Every-fire stamping is binary-only** — it ships in `rk agent hook` and reaches
  already-running agents on `brew upgrade rk` with **no settings churn and no
  session restarts** (the installed wrappers already pipe stdin through).
- **The `SessionStart` registry row is an event-mapping change** and follows the
  established rule: **one `rk agent setup` re-run + session restarts** (harnesses
  snapshot hook config at session start). Until that re-run lands, running agents
  still get `@rk_pane_agent_session` (dual-written with `@rk_pane_chat`) from the
  every-fire stamping on their existing
  `active`/`waiting`/`idle` hooks; the SessionStart row only advances *when* the
  first stamp lands (within seconds of start, before any prompt).

## Daemon-Derived Pane Options (`@rk_pane_git_*`)

A third group of `@rk_pane_*` options carries **git info for the tmux pane
border**, and unlike the agent-state/agent-session tiers it is **written by the
run-kit daemon, not by an agent harness hook**:

| Option | Const | Value |
|--------|-------|-------|
| `@rk_pane_git_branch` | `tmux.PaneGitBranchOption` | the pane cwd's git branch (or the grace/detached last-known branch, or empty) |
| `@rk_pane_git_worktree` | `tmux.PaneGitWorktreeOption` | the worktree badge glyph string (`tmux.PaneGitWorktreeBadge`) when the pane's git root lies under a `worktrees`/`.worktrees` dir, else empty |
| `@rk_pane_pathtail` | `tmux.PanePathTailOption` | the last two segments of the pane cwd |

- **Writer**: the snapshotter (`internal/snapshot`) stamps these every tick for
  every covered server via `tmux.SetPaneOption` (`set-option -p`), **only-on-change**
  (a per-server→per-pane last-stamped cache; a value equal to the last stamp
  issues no write; entries are pruned when a pane closes or a server drops out of
  coverage; a `set-option` error is logged and never aborts the tick, and the
  last-stamped cache is committed **per option only after that write succeeds**,
  so a failed stamp is re-attempted next tick rather than recorded as done).
  Stamping
  is on the snapshotter tick, not the SSE poll, so it is **subscriber-independent**
  — a native-terminal-only pane with no browser watching still gets its border
  populated.
- **Derivation**: branch/worktree come from the shared `internal/gitinfo`
  resolver (the same TTL-cached, subprocess-free `.git/HEAD` reader the web
  sidebar uses via `gitinfo.ResolveBranches`), so the **border matches the
  sidebar**; `gitinfo.PathTail` and `gitinfo.IsWorktree` supply the other two.
- **Reader**: the managed `pane-border-format` reads them directly as
  `#{@rk_pane_git_branch}` / `#{@rk_pane_git_worktree}` / `#{@rk_pane_pathtail}`;
  see [configuration](/run-kit/configuration.md) § the embedded conf's
  `pane-border-format`. There is no backend native-read parse of these — they
  exist solely to feed the border, replacing per-draw `#()` shell jobs. (s9fw)

## Design Decisions

### Reconciler at `parsePanes` time (`internal/tmux`), rollup at `internal/sessions`
**Decision**: parse + shell-command reconcile the option in the pure `parsePanes`
helper (which already has both the pane command and the option value on one line);
compute the window-level rollup + duration in `internal/sessions` pure helpers.
**Why**: keeps each rule colocated with its data and unit-testable, mirroring the
existing `parseWindows`/`parsePanes` / sessions-enrichment split. `AgentState`/
`AgentIdleDuration` are already window-level JSON fields consumed by the frontend,
and the sessions package already owns the per-window pane enrichment loop.
**Rejected**: reconciling in `internal/sessions` (would duplicate the shell-name
set and split the rule from its data); computing the rollup in `internal/tmux`
(window-level rollup is enrichment, not raw tmux parsing).
*Introduced by*: `260705-dmex-generic-agent-state-tier`

### Explicit `rk agent setup` opt-in, not silent sync
**Decision**: an explicit installer command that shows a diff and asks for
confirmation before mutating user-global config, with `--uninstall`. Every artifact
— the per-agent hooks merge and the cleanup-only `removeLegacySkill` under
`applyAgentConfig`, the user-global tmux guard shim under `applyTmuxShim`, and
the user-global gui display pointer and block under `applyGuiDisplayBlocks` —
runs its own diff-and-confirm through the shared `consent`/`authorizeWrite` seam,
so declining or no-op-ing one does not skip the others.
**Why**: it mutates user-global state (`~/.claude/settings.json`, the shims dir,
shell startup files) — the user chose "explicit feels honest" over agentdock's
silent sync. A marker-keyed idempotent merge (JSON entries for hooks, a
marker-delimited region for the PATH block) is the only way "update rk-owned
content in place, never touch anything else" is satisfiable.
**Rejected**: silent background sync (surprising for a user-config mutation);
per-project install (defeats the "any session anywhere" goal — the whole point is
user-global registration).
*Introduced by*: `260705-dmex-generic-agent-state-tier`

### Non-interactive consent: `--yes`/`--dry-run` + non-TTY refusal (not a silent decline)
**Decision**: gate every `rk agent setup` write through a `consent` struct
(`yes`/`dryRun`/`stdinIsTTY`) and one `authorizeWrite` decision point:
`--dry-run` shows the diff and writes nothing (and **wins over `--yes`**),
`--yes`/`-y` writes without prompting, a TTY with neither flag reads `[y/N]`, and
a **non-TTY with neither flag REFUSES** with an error naming `--yes` (nothing
written). Detect the TTY with `term.IsTerminal`, not a bare `os.ModeCharDevice`
check.
**Why**: toolkit Principle 1 requires a warranted confirmation be satisfiable
by a flag AND a non-TTY invocation refuse rather than hang or silently succeed —
the prior behavior (a non-TTY invocation hit EOF on the `[y/N]` read and silently
declined, exiting 0) is a success-looking no-op, the exact agent trap the
principle targets (an agent "installs" the hooks, gets exit 0, and nothing
happened). Principle 5 requires a destructive write support `--dry-run`, and a
dry-run that could still write would break its accurate-preview promise, so
dry-run wins under contradictory intent. `term.IsTerminal` (a real ioctl) is
required because `os.ModeCharDevice` classifies `/dev/null` — the exact
`rk agent setup </dev/null` shape an agent uses — as a terminal, which would make the
refusal silently not fire. The `[y/N]` prompt suffix is emitted only on the
interactive path so the auto-answered paths don't dangle an unread prompt that
reads as a hang in a transcript.
**Rejected**: keeping the silent EOF-decline (the agent trap); a `--dry-run` that
still writes when combined with `--yes` (violates the preview promise); a bare
`os.ModeCharDevice` TTY check (false-classifies `/dev/null`, refusal never fires).
*Introduced by*: `260717-c424-toolkit-standards-conformance`

### Consent context is a semantic summary; full bodies are `--dry-run`-only
**Decision**: on the interactive and `--yes` paths every `rk agent setup` pending
write renders a semantic summary — the per-entry hooks list with computed
replace/remove counts, a one-line tmux-shim summary, the exact 3-line PATH block
plus placement — and the full current+proposed bodies render only under
`--dry-run`. Each render site branches locally on `cons.dryRun`; the writer stays
`cons.diffWriter(sink)`, so channel routing and the `--yes --quiet` silent-success
net effect are untouched. Counts derive from the actual current settings
(`countRkEntries`) and the rendered script, never literals.
**Why**: a fresh run printed ~230 lines before the first `[y/N]` prompt, drowning
the consent question the output exists to support (and `shll agent-setup`
aggregates runs per tool, multiplying the noise). The full dump protected
nothing: rk never overwrites marker-less files, so the diff only ever showed
rk-owned or fresh content — and for user-authored startup files the honest unit
of change is the owned block, not the user's file echoed back.
**Rejected**: a unified-diff rendering (needs new diff machinery contra
Constitution III for less legibility than the semantic form); a new `--verbose`
flag (extra surface for what `--dry-run` already provides); hardcoded entry
counts (drift the moment the registry grows).
*Introduced by*: `260812-7a58-condense-agent-setup-consent-output`

### Whole-file skill ownership by frontmatter marker; thin pointer, not embedded recipe
**Decision**: the legacy `rk-display` skill is a whole file rk owns outright (no
merge), recognized by the `managed-by: rk agent-setup` frontmatter marker checked
by `skillHasMarker`. `removeLegacySkill` uses that marker to gate the destructive
directory removal (`os.RemoveAll` on `rk-display/`).
**Why**: the marker is the whole-file analogue of `isRkEntry` — it gates the
destructive removal so a user rewrite that drops the marker is left untouched,
without any out-of-band ownership manifest (Constitution §II — no persistent state
store). The visual-display capability content ships in the binary via the `rk skill`
bundle / `rk context` rather than a frozen skill file (the **same anti-freeze
principle as `rk agent hook`**): capability content reaches agents on
`brew upgrade rk` with no skill-file churn.
**Rejected**: tracking ownership in a manifest/state file (Constitution §II);
embedding the recipe/server-URL/pane-identity in a skill body (re-freezes the exact
content `rk context` exists to keep current); a SessionStart hook / CLAUDE.md
pointer / launch-time `--append-system-prompt` injection / MCP `display_html` tool
(all rejected in intake — compaction cost, passivity, missing hand-launched agents,
and Constitution §IV minimal surface respectively).
*Introduced by*: `260714-popk-rk-display-skill-agent-setup` (marker-recognition
repurposed for cleanup by `260717-agst`)

### One source of truth per binary for the convention strings
**Decision**: `cmd/rk/agent_setup.go` aliases `tmux.LegacyAgentStateOption` /
`tmux.AgentStateOption` +
`tmux.AgentState*` rather than re-declaring `"@rk_agent_state"` and the state
literals locally; `cmd/rk/agent_hook.go` (the writer) likewise aliases the same
`tmux.AgentState*` constants and resolves providers through the shared runtime
registry (`agent_registry.go`), so writer and reader have
one source per binary. (260707-qfps)
**Why**: the option name and states are the cross-repo contract; a second copy in
the installer would let the writer and the reader drift (A-021, resolved at
rework cycle 1 after review flagged the local re-declaration).
*Introduced by*: `260705-dmex-generic-agent-state-tier`

### Stable interface in settings, logic in the binary (`rk agent hook`)
**Decision**: install a thin, never-changing wrapper into harness settings that
delegates to the `rk agent hook` subcommand (also permanently invocable as the
hidden root alias `agent-hook`); put ALL logic (comm-validated
ancestor walk, value formatting, `tmux set-option` write) in the Go binary.
**Why**: a hook logic fix reaches every running agent on `brew upgrade rk`, with
no settings churn and no session restarts. An inlined one-liner would be frozen
twice (in `~/.claude/settings.json` at install time and in the harness's
session-start snapshot), letting a binary-updated reconciler and a settings-frozen
writer skew and suppress agent state fleet-wide.
**Rejected**: keep raw one-liners + drift detection (a doctor check / UI
surfacing — mitigates *discovery* of the skew, not the fleet-wide migration
itself); dual-path hook (binary-if-present + pure-tmux fallback inline — the
fallback string IS the frozen logic being removed, and doubles the surface; the
shipped two-path form is launcher-vs-stable — two SPELLINGS of the same binary
delegation, not an inline-logic fallback). No
pure-tmux fallback when the binary is missing: silence is acceptable because the
PID-liveness reconciler already clears state from dead agents and a stranded
value clears when the agent/pane dies; the residual live-idle-agent case (a lost
write on a still-running agent) is surfaced instead by `active`'s exposed age on
the machine surfaces.
*Migration*: *logic* changes need no re-setup or restart. Matcher / event-mapping
changes still need re-setup + restart (that mapping lives in the settings matchers).
*Introduced by*: `260707-qfps-rk-agent-hook-indirection`

### Event→state mapping stays in settings; state-literal args + `--agent` flag
**Decision**: the event→state mapping (which harness event installs which
state, including the two `Notification` matchers) lives in the settings matchers;
the wrapper passes a fixed state literal + `--agent <provider>`. The binary reads the
harness's hook JSON on stdin **only** to extract the session-identity field for
the `@rk_pane_agent_session`
stamp — NOT to derive state, which stays driven by the settings matchers + the
positional token (see § Agent Session Identity → Writer). (260713-nh86)
**Why**: the mapping churns far less than the logic, and matcher changes require a
settings write regardless; stdin-JSON parsing does not change the installed
command shape, so state derivation via stdin gains nothing over the matchers.
*Introduced by*: `260707-qfps-rk-agent-hook-indirection`

### Reject (don't escape) shell-unsafe rk paths; the wrapper's stable path never Cellar-pins
**Decision**: resolve the wrapper's `<stable>` path via `LookPath("run-kit")` →
`LookPath("rk")` →
`os.Executable()` without `EvalSymlinks`, and `validateHookPath`-reject any path
containing `' " $ ` backslash with a clear install-time error rather than escaping
it or silently falling back to bare `rk`. The `<launcher>` path is the deliberate
complement: it DOES resolve to the Cellar binary, via `EvalSymlinks(rkPath)` —
see § Design Decisions → Two paths in the wrapper, each covering the other's hole.
**Why**: hook-env PATH is untrustworthy, so the absolute path must be embedded;
`EvalSymlinks` on the stable path would pin the version-locked Cellar path and
re-freeze the hook
(defeating the whole change); escaping would have to survive three nested quoting
layers (shell-in-shell-in-JSON — fragile to write and review); a bare-`rk`
fallback reintroduces the PATH dependency the absolute path exists to remove. Such
paths never occur under Homebrew/conventional layouts, so the install-time error is
essentially unreachable, and whatever caller triggered the install — a human at a
TTY or an agent passing `--yes` — sees the error and can act.
*Introduced by*: `260707-qfps-rk-agent-hook-indirection`

### Two paths in the wrapper, each covering the other's hole
**Decision**: the hook wrapper execs the rk-owned launcher (Cellar-targeted)
first and the brew stable symlink second; the `||` chain advances only on exec
failure because `rk agent hook` always exits 0.
**Why**: Homebrew unlinks the stable symlink before the network-bound install
phase and relinks in `finish`, but deletes the old keg only in cleanup after
link; the launcher is live exactly when the stable symlink is not, and the
stable symlink covers the moment after cleanup before the daemon re-points.
Exposing `active`'s age on the machine surfaces is the defense in depth against
any lost write that still slips through.
**Rejected**: inline `tmux set-option` fallback (re-freezes option name/format
into settings.json); retry-with-sleep (covers seconds, not the multi-minute
network-dependent window); Cellar path pinned as the wrapper's only path at
install (re-freezes the hook).
*Introduced by*: 260916-la8z-hook-launcher-upgrade-window

### The launcher's install-time target resolves the PATH-found stable symlink
**Decision**: the launcher's target at install time is
`filepath.EvalSymlinks(rkPath)` (fallback: `rkPath` unchanged), not the running
setup binary's `selfpath.Resolve()`; the serve-time re-point (which runs from
the installed daemon) uses `selfpath.Resolve()`.
**Why**: `bin/rk agent setup` from a dev worktree is routine here, and
`resolveRkPath` deliberately does not trust the running binary's location — the
machine's launcher must point at the installed Homebrew binary regardless of
which build ran the installer.
**Rejected**: `selfpath.Resolve()` of the setup binary (points the machine's
hooks at a dev build that will vanish).
*Introduced by*: 260916-la8z-hook-launcher-upgrade-window

### Session-ref = the session UUID only (not the transcript path)
**Decision**: `@rk_pane_agent_session`'s `<session-ref>` for `claude` is the session UUID
alone, not the transcript path and not both.
**Why**: the UUID is the official identity for the SDK read APIs, and the
transcript path is **derivable** from the UUID (the filename IS the UUID —
`~/.claude/projects/<cwd-slug>/<uuid>.jsonl`, findable by glob), so **Principle X**
("hooks carry only the underivable") says carry only the UUID. A colon-free value
also keeps the first-colon split trivial.
**Rejected**: stamping the full path (redundant with the UUID, and path is
derivable); stamping both (schema bloat, two sources to keep in sync).
*Introduced by*: `260713-nh86-chat-session-identity`

### Liveness borrowed from the same pane's agent-state option (no pid on `@rk_pane_agent_session`)
**Decision**: `@rk_pane_agent_session` carries no pid segment; the agent-session
reconciler reuses the
same pane's agent-state pid/shell reconciler outcome (a single shared `stale`
boolean in `parsePanes`) rather than adding a second liveness source.
**Why**: one liveness signal per pane, written by the same binary on the same
fires — a dead agent must zero BOTH agent-state and agent-session fields, and it
does so from one
decision. The reconciler restructure (`agentPID > 0 ? !alive : isShellCommand`
→ `stale`, then zero both field-sets when `stale`) keeps the two tiers provably in
lockstep.
**Rejected**: adding a `:<pid>` segment to `@rk_pane_agent_session` (schema bloat + a duplicate,
potentially-skewing liveness source); a separate agent-session-only liveness heuristic.
*Introduced by*: `260713-nh86-chat-session-identity`

### Every-fire stamp; SessionStart dual-stamps session + `idle`; no `SessionEnd`
**Decision**: stamp `@rk_pane_agent_session` (dual-written with `@rk_pane_chat`) on **every** hook fire that yields a `session_id`
(the binary reads stdin JSON), and let the SessionStart registry row (token
`stamp`) **additionally write `@rk_pane_agent_state idle:<epoch>[:<pid>]`** for
every SessionStart source except `compact`. Clearing is
**reader-side reconciliation only** — no writer-side clear, no `SessionEnd` row.
**Why**: session ids rotate on `/clear` and `/compact` (re-verified 2026-07-13),
so a one-time stamp goes stale mid-pane-lifetime — every-fire refresh fixes that
AND reaches already-running agents on `brew upgrade rk` with zero settings churn
(binary-only). SessionStart's `idle` write is the boot-ready signal — `idle` is
semantically true at session start, so a valid state exists within seconds of
boot with no new state value or reader change — and it clears stale
`waiting`/`active` from a pane's previous agent. The `compact` source is excluded
because it fires mid-turn, where an `idle` write would clobber a live `active`
(an unparseable payload withholds the write for the same fail-safe reason).
Reader reconciliation is mandatory anyway for
crash/kill paths, so a `SessionEnd` clear adds a settings entry without removing
any reader logic (mirrors agent-state's no-GC lifecycle).
**Rejected**: SessionStart-only stamping (goes stale on id rotation); a
SessionStart idle write on the `compact` source (clobbers a live `active`
mid-turn); a new `ready`/`boot` state value or a separate `@rk_pane_boot` option
(schema churn, every reader must learn it); a
`SessionEnd` writer-side clear (redundant with mandatory reconciliation).
*Introduced by*: `260713-nh86-chat-session-identity`; boot-stamp extension `260903-4czh-boot-ready-spawn-inject`

### Bounded, TTY-guarded, single-object stdin parse; validated before write
**Decision**: `readHookInput` is TTY-guarded (`os.ModeCharDevice` — a manual
terminal invocation is never read), bounded (`io.LimitReader`, ~1 MiB), decodes a
**single** JSON object (`json.Decoder.Decode`, no EOF dependence), and validates
the payload's session-identity field
with the same rule the reader applies to a ref before stamping.
Every failure is silent — no stamp — and the agent-state write still proceeds.
**Why**: the harness docs don't guarantee stdin EOF semantics, so a single-object
Decode (not `io.ReadAll`) is the correct primitive; the TTY guard keeps a manual
`rk agent hook` from blocking; the bound guards a hung producer; validating before
write keeps a value the reader would reject from ever being stamped (writer/reader
symmetry). This preserves the tested never-fail contract with no new error path.
**Rejected**: `io.ReadAll` to EOF (can block indefinitely — no EOF guarantee);
stamping the raw `session_id` unvalidated (a whitespace/control value the
reconciler would silently drop).
*Introduced by*: `260713-nh86-chat-session-identity`

### Subagent (Task-tool) fires carry the ROOT session id — no event restriction
**Decision**: stamp `@rk_pane_agent_session` (dual-written with `@rk_pane_chat`) on **all** registered events (no restriction to
`UserPromptSubmit`/`SessionStart`/`Stop`); the stdin `session_id` on subagent /
`PreToolUse` fires is treated as the pane's ROOT session, not a sidechain id.
**Why**: this was the change's one open question (intake Assumption 10, Tentative —
the harness docs are silent on subagent hook payloads). **Resolved empirically at
apply**: across **1489** subagent (Task-tool) transcript files on this host, every
sidechain line carried `sessionId` = the PARENT/root session UUID (subagent
transcripts nest under `<root-uuid>/subagents/agent-*.jsonl`); **zero** carried a
distinct id. Root-session identity is exactly what stamping needs, so no event
restriction is required — upgraded Tentative → Confident.
**Rejected (as unneeded)**: restricting stamping to
`UserPromptSubmit`/`SessionStart`/`Stop` — the worst case it guarded against (a
transiently-wrong sidechain ref that the next main-session fire corrects) does not
occur.
*Introduced by*: `260713-nh86-chat-session-identity`

### Window rollup: active pane first, else first set; per-pane truth also ships
**Decision**: `ResolveAgentPane(panes)` returns the active pane's agent session
(provider, ref, and pane id) if set, else the
first pane (in tmux order) carrying one; `rollupAgentSession(panes)` delegates to
it, discarding the pane id. The per-pane `AgentProvider`/
`AgentSessionRef` are serialized alongside the window rollup.
**Why**: additive JSON with consumers not yet built (cheap to revise later), the
common case is one agent pane per window, and shipping per-pane truth means a
later multi-pane rule change needs no backend contract break. Mirrors
`rollupAgentState`'s active-first precedence and pure-helper shape.
**Rejected**: a window-only rollup with no per-pane fields (would force a contract
break to revisit the multi-pane rule).
*Introduced by*: `260713-nh86-chat-session-identity`

### No disk validation of the referenced transcript
**Decision**: the reconciler does NOT stat `~/.claude/projects/**/<ref>.jsonl`.
**Why**: it would add per-pane-per-poll filesystem I/O to guard a pathological
case; a live agent's transcript exists by construction, and the transcript-reading
consumers (operator actuation, fork, closed-resume, auto-name) surface a missing
transcript naturally as a read error. Keeps agent-session
identity derived purely from tmux pane options at request time (Constitution II).
**Rejected**: stat-on-reconcile (I/O cost with no correctness gain for the live
case).
*Introduced by*: `260713-nh86-chat-session-identity`

### Target the pane's server via `tmux.OriginalTMUX`, not `$TMUX`
**Decision**: derive the `-S <socket>` server-targeting prefix from
`tmux.OriginalTMUX`, not `os.Getenv("TMUX")`.
**Why**: `internal/tmux`'s `init()` unsets `$TMUX` on import (so the daemon's bare
tmux calls hit the default socket); `OriginalTMUX` captures the caller's real
socket in a var initializer that runs before that `init()`. It is the established
seam (same as `riff.go` / `context.go`). Deriving `-S` from it also survives hook
contexts like `tmux run-shell` that set `$TMUX_PANE` but not `$TMUX`.
*Introduced by*: `260707-qfps-rk-agent-hook-indirection`

### Factory-built command instances for both agent verbs
**Decision**: the `setup` and `hook` commands are built by factory functions
(`newAgentSetupCmd` / `newAgentHookCmd`) returning fresh `*cobra.Command`
instances — one family member under `agentCmd`, one root alias each — with flag
variables bound per-instance; the shared logic stays in the `runAgentSetup` /
`runAgentHook` cores.
**Why**: a cobra command object cannot have two parents; two hand-declared
near-identical literals would drift (especially the hook's four-part never-fail
machinery, which must be provably identical on both forms).
**Rejected**: cobra `Aliases` (only aliases a name at the same tree level,
cannot span root↔family); a root alias that shells out or re-dispatches to the
family member (needless indirection, breaks flag passthrough).
*Introduced by*: `260815-r2wp-agent-family`

### Deprecation alias hidden; permanent alias silent
**Decision**: the `agent-setup` root alias is `Hidden: true` + cobra
`Deprecated` (a one-line stderr pointer naming `rk agent setup`, then runs
normally with identical flags and exit codes); the `agent-hook` root alias is
`Hidden: true` with NO `Deprecated` and no warning of any kind, comment-marked
permanent so no future cleanup sweep removes it.
**Why**: the cli-layering spec's root-count target and § Hidden plumbing hide
aliases; cobra's `Deprecated` gives the standard warn-and-run behavior for the
human-typed form; the machine-invoked form must stay byte-silent — the
never-fail contract means a deprecation line on stderr would leak into hook
contexts that don't redirect stderr.
**Rejected**: a visible deprecated twin (defeats the grouping); any warning on
`agent-hook` (contract violation — installed hook lines carry the literal
forever).
*Introduced by*: `260815-r2wp-agent-family`

### Dual-write both pane names in one chained exec
**Decision**: `rk agent hook` writes both `@rk_pane_agent_state`/`@rk_agent_state`
(and both agent-session names, `@rk_pane_agent_session`/`@rk_pane_chat`) in one
`;`-chained tmux exec (the shared `dualWritePaneOption` helper) — discrete argv
elements, no shell.
**Why**: fab-kit reads only the legacy unscoped agent-state name until its
new-then-old read
ships; the migration copies old→new, never new→old, so a write-side switch would
blind fab's pane map. The agent-session pair keeps the fallback name readable by
pre-upgrade daemon binaries during the window.
**Rejected**: switch writers to the new name only (breaks fab-kit until its
new-then-old read ships); keep legacy-only writes (defers the whole scope-rename
window another release's worth of stragglers).
*Introduced by*: 260828-5jlp-tmux-option-dual-read-external-keys

### Agent-session identifier spellings
**Decision**: Go fields `AgentProvider`/`AgentSessionRef` (JSON
`agentProvider`/`agentSessionRef`), resolver `ResolveAgentPane`, operator
template flag `requiresAgentSessionRef`, frontend fork gate
`FORKABLE_AGENT_PROVIDER`.
**Why**: the shortest spellings that keep the provider/ref pair visually
parallel to the option name `@rk_pane_agent_session`.
**Rejected**: `AgentSessionProvider`/`sessionProvider` — longer without
disambiguating (exactly one provider/ref pair per pane).
*Introduced by*: `260904-bf1l-agent-session-identity-rename`

### Runtime registry split from installer shape
**Decision**: one runtime descriptor per provider in `cmd/rk/agent_registry.go`
referenced by the hook writer; installer entries add config placement/format on
top; a provider can exist in the runtime registry without an installer.
**Why**: hook firing must not depend on whether the harness was installed through
`rk agent setup` — runtime handling and installation are orthogonal axes, and
coupling writer resolution to installer entries would reject any provider lacking
a Claude-shaped config target.
**Rejected**: a new `internal/harness` package (hook, setup, and doctor all live
in `cmd/rk`; extraction removes no concrete coupling).
*Introduced by*: 260908-nnqu-fix-agent-neutral-detection

### Three installer kinds over one Claude-shaped merge
**Decision**: jsonHooksMerge / markerFile / markerBlock, all sharing the existing
consent/diff/ownership machinery.
**Why**: the verified native formats fall into exactly these three shapes.
**Rejected**: a TOML parser dependency for kimi (only documented fields are
emitted; marker blocks preserve user content byte-exactly) and JSON-merging into
a foreign copilot file (its hooks dir is one-file-per-source — whole-file
ownership is the native shape).
*Introduced by*: 260908-nnqu-fix-agent-neutral-detection

### agy telemetry never answers decisions
**Decision**: agy's PreToolUse/PostToolUse are not hooked and Stop's idle write
requires `fullyIdle`; the wrapper emits `{}` (no-decision JSON).
**Why**: agy's tool-permission hooks are decision contracts; emitting allow/deny
for telemetry would hijack user permissions, and a stop with background tasks
running is not at rest.
**Rejected**: mapping a permission event to `waiting` (no honest signal exists);
treating every Stop as idle.
*Introduced by*: 260908-nnqu-fix-agent-neutral-detection
