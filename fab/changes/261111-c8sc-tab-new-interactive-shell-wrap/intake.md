# Intake: rk tab new launches its command through the user's interactive shell

**Change**: 261111-c8sc-tab-new-interactive-shell-wrap
**Created**: 2026-11-11

## Origin

Promptless dispatch (`{questioning-mode} = promptless-defer`) from a conversation on 2026-11-11. The synthesized description:

> Title idea: `rk tab new` launches its command through the user's interactive shell by default.
>
> Problem (observed 2026-11-11): when the user starts an agent with `rk riff`, Claude works. When the operator spawned agents with `rk tab new --cwd … -- claude …` (argv form), both panes showed "Not logged in". Cause: CLAUDE_CODE_OAUTH_TOKEN is exported only by the interactive shell profile (~/.zshrc). `rk tab new` composes `shellq.QuoteArgv(args)` + `shellq.WithShellFallback` and passes it as a single shell-command string to tmux new-window, which tmux runs as `$default-shell -c '…'` — NON-interactive, so .zshrc is never sourced and the pane only inherits the tmux server's global env. […] The operator worked around it by relaunching through `zsh -ic`.
>
> By contrast `rk riff`, `rk operator`, and `rk tutorial` all compose through `riff.SkillPaneCommand` / `buildSkillShellString` […] which wraps as `${SHELL:-/bin/sh} -i -c '<layer1>'; exec "${SHELL:-/bin/sh}"` — so they work. fab-kit fixed the same bug for `fab dispatch` pane workers (backlog [sca2], sahil87/fab-kit#698; hexokit #1122 then removed the per-repo interactive_command wrap). `rk tab new` is the remaining rk spawner without the wrap.

Decisions agreed in the conversation (carried verbatim into What Changes): (1) extract the interactive wrap into `internal/shellq` and have riff call it; (2) `rk tab new -- CMD…` wraps by default; (3) add an opt-out flag (`--no-shell-profile`, name to be finalized against toolkit standards); (4) update help text, tests, docs, specs, memory; (5) a separable follow-up — classify a Claude "Not logged in" boot screen as `parked` under `--ready`. Two alternatives were explicitly rejected (tmux-server env fix; `~/.zshenv`). Guiding rule from the conversation: **"a pane rk launches sees the same environment as a pane you'd type into"**.

**Clarified with the user (2026-11-11):** the opt-out flag is `--no-shell-profile` (`--no-interactive` would clash with toolkit principle №1's "non-interactive = no prompts"); the login-wall classification (§8) ships in this change, not as a backlog item; PR evidence is `No recording:` plus tests.

**Hotfix already shipped — PR #1125 (`fix/tab-new-interactive-shell`).** To unblock operator-spawned agents, §1–§7 below landed first as a standalone PR (no review/hydrate): `shellq.Interactive`, riff delegation, the `rk tab new` default wrap, `--no-shell-profile`, help text, the skill-bundle pair, the `docs/specs/ui-state.md` synopsis, and tests (including a hermetic tab test fixture: `SHELL=/bin/sh` + `ENV=<test rc file>`). This change's branch is stacked on that commit. **Remaining scope for this change:** verify §1–§7 as shipped (review), implement §8, and hydrate memory for the whole fix (Affected Memory).

## Why

**The problem.** `rk tab new -- CMD…` runs CMD with only the tmux server's global environment. tmux executes the window's shell-command as `$default-shell -c '<string>'` — a non-interactive shell — so the user's interactive profile (`~/.zshrc`, `~/.bashrc`) never runs. Anything exported only there is missing from the pane. The concrete failure on 2026-11-11: `CLAUDE_CODE_OAUTH_TOKEN` lives in `~/.zshrc`, so two operator-spawned Claude panes (`rk tab new --cwd … -- claude …`) both booted to "Not logged in", while `rk riff`-spawned Claude panes on the same box worked.

**Why it will get worse.** The pane's env equals the tmux server's env at server start. A server started from an interactive terminal happens to carry the token; a server started by a non-interactive process (the rk daemon, systemd, launchd) does not. The daemon-autostart work (spike `261111-q5yn-daemon-autostart-spike`) makes the non-interactive case the common one. fab's operator spawns workers through `rk tab new` (fab-kit `fab-operator.md` §6; backlog [wzve]), so every operator-spawned agent is exposed.

**Why this approach.** Every other rk spawner already does this: `rk riff`, `rk operator`, and `rk tutorial` compose through `riff.SkillPaneCommand`/`buildSkillShellString`, which wraps as `${SHELL:-/bin/sh} -i -c '<cmd>'; exec "${SHELL:-/bin/sh}"`. fab-kit made the same fix for `fab dispatch` pane workers (backlog [sca2], sahil87/fab-kit#698), and hexokit #1122 then dropped the per-repo `interactive_command` workaround. `rk tab new` is the one spawner left. Wrapping each launch re-reads the profile every time, so a rotated token is picked up on the next spawn.

**Rejected alternatives** (from the conversation):
- *Fix the tmux server's environment* (start the server through a login/interactive shell, or `tmux set-environment -g`). This would also cover raw `tmux new-window`, but it captures env once at server start: a rotated token goes stale, and it is fragile under systemd/launchd autostart. Per-launch wrapping re-reads the profile each time.
- *Move the export to `~/.zshenv`* (which `zsh -c` sources). That is a zsh-only fix on the user's side, not a generic rk fix.

**If we don't fix it**, operator-spawned and script-spawned agents keep booting unauthenticated whenever the tmux server wasn't started from an interactive terminal. Nothing reports the failure: `--ready` currently classifies the "Not logged in" screen as `ready`, so the caller delivers a prompt into an agent that cannot act on it.

## What Changes

### 1. `internal/shellq`: one shared interactive-wrap composition

Add a pure function to `app/backend/internal/shellq/shellq.go`:

```go
// Interactive wraps cmd for execution by the user's interactive shell:
// `${SHELL:-/bin/sh} -i -c <Quote(cmd)>`. The interactive flag makes the
// shell source its rc file (.zshrc/.bashrc), so the launched process sees the
// same environment as a pane the user types into. cmd is re-quoted as ONE
// word for -c — Quote is total, so cmd's own quoting survives verbatim. Pure.
func Interactive(cmd string) string {
	return `${SHELL:-/bin/sh} -i -c ` + Quote(cmd)
}
```

The name `shellq.Interactive(cmd string) string` comes from the conversation (an "e.g."). The output MUST be byte-identical to the `interactive` value riff builds today: `fmt.Sprintf("${SHELL:-/bin/sh} -i -c %s", shellq.Quote(layer1))`.

Update the package doc comment, which currently says it owns "the single POSIX shell-quoting implementation and the agent-exit shell-fallback tail", so it also names the interactive wrap.

Add tests to `app/backend/internal/shellq/shellq_test.go`, in the style of the existing `Quote`/`QuoteArgv`/`WithShellFallback` tests:
- `Interactive("claude")` → `${SHELL:-/bin/sh} -i -c 'claude'`
- `Interactive(QuoteArgv([]string{"claude", "--model", "opus"}))` → `${SHELL:-/bin/sh} -i -c ''\''claude'\'' '\''--model'\'' '\''opus'\'''`
- An embedded single quote, `$(…)`, a newline, and spaces each stay one literal word. Prefer asserting this by running the composed string through `/bin/sh -c` in a test with `SHELL=/bin/sh` and checking the argv the inner process receives, not only by string comparison.
- Composes with `WithShellFallback`: `WithShellFallback(Interactive(x))` ends in `; exec "${SHELL:-/bin/sh}"`.

### 2. `internal/riff`: `buildSkillShellString` delegates to `shellq.Interactive`

In `app/backend/internal/riff/shell.go`, layer 2 of `buildSkillShellString` becomes:

```go
interactive := shellq.Interactive(layer1)
return shellq.WithShellFallback(interactive)
```

The output stays byte-identical, so existing riff/operator/tutorial tests must pass unchanged. That proves the refactor leaves exactly one implementation of the composition. Update the layer-2 doc comment to point at `shellq.Interactive`. `buildCmdShellString` (riff's cmd-type panes) is NOT changed; see Non-goals.

### 3. `rk tab new -- CMD…` wraps through the interactive shell by default

In `runTabNew` (`app/backend/cmd/rk/tab_new.go`, the composition block around line 370):

```go
// today
shellCmd = shellq.QuoteArgv(args)
if !tabNewNoShellFallbackFlag {
	shellCmd = shellq.WithShellFallback(shellCmd)
}

// after
shellCmd = shellq.QuoteArgv(args)
if !tabNewNoShellProfileFlag {
	shellCmd = shellq.Interactive(shellCmd)
}
if !tabNewNoShellFallbackFlag {
	shellCmd = shellq.WithShellFallback(shellCmd)
}
```

The four resulting forms for `rk tab new -- claude --model opus`:

| Flags | tmux shell-command positional |
|-------|-------------------------------|
| (default) | `${SHELL:-/bin/sh} -i -c ''\''claude'\'' '\''--model'\'' '\''opus'\'''; exec "${SHELL:-/bin/sh}"` |
| `--no-shell-fallback` | `${SHELL:-/bin/sh} -i -c ''\''claude'\'' '\''--model'\'' '\''opus'\'''` |
| `--no-shell-profile` | `'claude' '--model' 'opus'; exec "${SHELL:-/bin/sh}"` (today's default, byte-identical) |
| `--no-shell-profile --no-shell-fallback` | `'claude' '--model' 'opus'` |

**The argv-literal guarantee (Constitution I) is preserved.** `QuoteArgv` still quotes every token, and `Quote` then re-quotes the whole inner string as the single `-c` word. Because `Quote` is total, the interactive shell receives exactly the `QuoteArgv` string and parses it into the original tokens: `$(…)`, quotes, spaces, and newlines reach the process as literal words. The tmux shell-command positional is still built only from rk-quoted tokens plus rk's fixed literals (`${SHELL:-/bin/sh} -i -c `, `; exec "${SHELL:-/bin/sh}"`). Note that quoted words are not alias-expanded: the wrap delivers env and profile, not aliases. The help text says so explicitly.

Update the inline comment above the composition ("The tmux shell-command positional is composed ONLY from rk-quoted argv tokens plus rk's fixed fallback literal…") and the file-header comment block (lines 14–18) to name the interactive wrap and its opt-out.

The bare-window path does not change: with no `--` command, `shellCmd` stays `""` and tmux spawns its default shell as an interactive shell.

### 4. Opt-out flag: `--no-shell-profile`

```go
tabNewCmd.Flags().BoolVar(&tabNewNoShellProfileFlag, "no-shell-profile", false,
	"Run the command directly under tmux's non-interactive shell instead of through ${SHELL:-/bin/sh} -i -c (skips rc-file startup cost and side effects; the pane gets only the tmux server's environment)")
```

- Name settled with the user: `--no-shell-profile` names what is skipped (the interactive shell profile) and pairs with the existing `--no-shell-fallback`; `--no-interactive` was rejected because toolkit principle №1 uses "non-interactive" to mean "no prompts".
- `validateTabNewFlagRules` gains a usage error (exit 2) that mirrors the `--no-shell-fallback` rule: `--no-shell-profile needs a command after --`.
- The flag is orthogonal to `--no-shell-fallback`; all four combinations are legal (table above).
- Reset `tabNewNoShellProfileFlag` in the test reset helper (`tab_test.go` ~line 149, beside `tabNewNoShellFallbackFlag`).
- Add the flag to the `Use:` synopsis: `… [--no-shell-fallback] [--no-shell-profile] [-- CMD [ARG…]]`.
- Advertising it in `--help` is also the capability probe for toolkit callers (principle №4, "advertised flags, probed not assumed"). A fab-kit operator can detect the new behavior by finding `--no-shell-profile` in `rk tab new --help`.

### 5. `rk tab new` help text (`Long`)

Rewrite the command paragraph, which currently reads "Shell expansion inside the window is opt-in by naming the shell: rk tab new --cwd DIR -- sh -c "<string>"" plus the fallback sentence. It should say:
- A command after `--` is argv, never a shell string. Every token is single-quoted and reaches the process as one literal word.
- By default the command runs through the user's interactive shell (`${SHELL:-/bin/sh} -i -c '…'`), so it sees the same environment as a pane you type into: variables exported by `.zshrc`/`.bashrc`, such as auth tokens, are present even when the tmux server was started non-interactively. This carries the profile's environment, not aliases: the quoted command word is not alias-expanded.
- `--no-shell-profile` skips the wrap (no rc-file cost or side effects; the pane gets only the tmux server's environment).
- Shell expansion is still opt-in by naming a shell: `rk tab new --cwd DIR -- sh -c "<string>"`.
- The agent-exit fallback (`; exec "${SHELL:-/bin/sh}"`) and `--no-shell-fallback` stay as they are.

Check the help text against `shll standards principles` (№2 layered help: summary, flags, examples) and confirm `help-dump` still walks cleanly (Constitution: Toolkit Standards). `TestTabNewHelpDocumentsTheRule` (`tab_new_test.go` ~line 434) is the precedent for asserting help content. Add or extend a test asserting the help names `--no-shell-profile` and the interactive-shell default.

### 6. Tests (`app/backend/cmd/rk/tab_test.go`, `tab_new_test.go`)

- **Composition unit test** (tmux-free, through the `tabNewCreateWindowFn` seam): capture the `shellCmd` passed for each of the four flag combinations and assert it byte-for-byte against the table in §3.
- **Integration, existing tests**: `TestTabNewCommandRunsArgvVerbatim` (the `$(echo pwned)` literal-token test), `TestTabNewShellFallbackKeepsPaneAlive`, and `TestTabNewNoShellFallbackPaneDies` must keep passing with the wrap on by default. Under the wrap, `--no-shell-fallback` makes `$SHELL -i -c '…'` exit with the command, so the pane still dies.
- **Integration, new**: prove the default path sources the interactive rc file, and that `--no-shell-profile` does not. Use a hermetic shell: set `SHELL` (in the test tmux server's environment) to a shell whose interactive startup file is under the test's control, e.g. `bash` with `HOME`=tempdir and a `.bashrc` that exports a marker, or `sh` with `ENV=<file>`, which POSIX `sh -i` sources. The command writes `$MARKER` to a file: the default path sees the marker, `--no-shell-profile` sees it unset. Never let the developer's real `~/.zshrc` run in tests.
- **Usage error**: `--no-shell-profile` without a command exits 2 with `--no-shell-profile needs a command after --`.
- **riff**: the existing `buildSkillShellString` / `SkillPaneCommand` golden tests stay byte-identical (no edits needed; if any break, the refactor is wrong).

### 7. Docs, specs, skill bundle, memory

- `docs/site/skill.md` and `app/backend/cmd/rk/skill/skill.md`. These are byte-identical today and must stay that way; the embedded copy mirrors the site copy. Update the `rk tab new` capability line (line 43): add the interactive-shell default and `--no-shell-profile`, and keep the argv rule, the `-- sh -c "…"` recipe, and the fallback note. The usage line becomes `rk tab new [--layout L] [--name N] [--json] [--ready] [--no-shell-profile] [-- CMD…]`.
- `docs/specs/ui-state.md` § `rk tab` (lines ~422–426): add `[--no-shell-profile]` to the synopsis and update the comment, e.g. `# CMD after -- is argv (rk-quoted, one literal word per token), run through ${SHELL:-/bin/sh} -i -c unless --no-shell-profile, with the ; exec "${SHELL:-/bin/sh}" fallback unless --no-shell-fallback`.
- `docs/specs/mcp.md` line 266 (`new_window` → `tab new [--session =S] [--cwd] [--name] [--layout]`): no change needed, since MCP exposes no command form. Verify only.
- `docs/specs/cli-layering.md`: no `tab new` command-form reference was found. Verify only.
- Memory: see Affected Memory.

### 8. Login-wall classification under `--ready` (in scope — user decision)

`rk tab new --ready` (and `rk mux await --ready`; both go through `muxAwaitReadyFn` → `inject.AwaitReady` and the shared `mapReadyReport`) should report a Claude **"Not logged in"** boot screen as `parked` (a login wall), not `ready`. The caller then sees the failure at spawn instead of delivering into an unauthenticated agent.

Today `inject.AwaitReady` (`app/backend/internal/inject/ready.go`) returns `ReadyByState` as soon as an agent state appears, which happens once hooks fire. Otherwise it returns `ReadyByEcho` when the sentinel echoes into a composer. An unauthenticated Claude TUI likely satisfies one of these, because the composer still renders. A login-wall check therefore has to inspect the captured screen for the login-wall signature before returning ready. That means a `ParkedError` carrying the snippet, so the existing parked/stderr-snippet contract applies unchanged.

**Signature, verified 2026-11-11** by reproduction (Claude Code v2.1.311 launched under `env -i HOME PATH TERM USER` in a throwaway tmux server): the TUI boots fully — banner, the `❯` composer, the `⏵⏵ bypass permissions on` footer — and prints **`Not logged in · Run /login`** right-aligned on the line above the composer's top rule. Because the composer renders, today's echo path (and any hook-driven state) reports `ready`. With the token unset but other credentials present, the same TUI shows `API Usage Billing` and no login line — so the check must match the literal `Not logged in · Run /login` text, not the absence of a subscription label.

Placement: the shared `inject.AwaitReady` classifier, so every `--ready` consumer benefits — `rk tab new --ready`, `rk mux await --ready`, and through it `fab dispatch ready` (the [sca2] note asked for exactly this) plus operator kickoff and riff typed delivery. Before returning any ready verdict (`ReadyByState` or `ReadyByEcho`), capture the pane and, when the login-wall line is present, return the existing `ParkedError` carrying the snippet, so the parked/stderr-snippet contract applies unchanged. Match on the screen text only (a pure, unit-tested matcher over captured lines); no agent-specific branching beyond the signature string. Codex and other agents are unaffected (no match).

### Non-goals

- **riff cmd-type panes** (`buildCmdShellString`) stay unwrapped. The existing decision in `rk-riff.md` keeps user commands like `just dev` out of `sh -i -c`. The same env gap applies to them in principle; this change does not revisit that.
- **No tmux-server env changes** (`set-environment -g`, a login-shell server start). Rejected; see Why.
- **No MCP surface change**: `new_window` exposes no command form, so neither the wrap nor `--no-shell-profile` reaches MCP.
- **No fab-kit change**: fab's operator spawns through `rk tab new` and picks up the fix automatically.

## Affected Memory

- `run-kit/architecture/backend-packages`: (modify) the `internal/shellq` row gains `Interactive` (the shared `${SHELL:-/bin/sh} -i -c` wrap) beside `Quote`/`QuoteArgv`/`WithShellFallback`
- `run-kit/architecture/cli`: (modify) the `tab` family / `rk tab new` notes: command composition is now interactive-wrapped by default, with the `--no-shell-profile` opt-out; add a Design Decision entry (per-launch wrap over the tmux-server env fix and `~/.zshenv`, with rationale)
- `run-kit/rk-riff`: (modify) skill-pane layer 2 now composes via `shellq.Interactive`; the `internal/shellq` file entry and the "One POSIX shell-quoting implementation" decision name the interactive wrap and its second consumer (`rk tab new`)
- `run-kit/tmux-sessions`: (modify) the "Pane shell strings" bullet (~line 542) names the shared `shellq.Interactive` composition and `rk tab new`'s default wrap
- `run-kit/toolkit-standards`: (modify) the `rk tab new` exit-code list adds `--no-shell-profile` without a command (usage, exit 2); the skill-bundle capability-line description adds the interactive default and `--no-shell-profile`
- `run-kit/agent-messaging`: (modify, only if §8 ships) the `--ready` readiness vocabulary notes the login-wall → `parked` classification

## Impact

- **Code**: `app/backend/internal/shellq/shellq.go` (+`Interactive`), `shellq_test.go`; `app/backend/internal/riff/shell.go` (delegate, byte-identical); `app/backend/cmd/rk/tab_new.go` (composition, new flag, flag rule, `Use`/`Long`, comments); `tab_test.go` / `tab_new_test.go`. If §8 ships: `app/backend/internal/inject/ready.go` (+`ready_test.go`), possibly `cmd/rk/mux_await.go` help text.
- **Unchanged callers**: `riff.SkillPaneCommand` consumers `cmd/rk/operator.go:595` and `cmd/rk/tutorial.go:178` produce byte-identical output. `rk present --window` creates through `tabCreateWindowIDFn` with no command and is unaffected. MCP `new_window` (`internal/mcp/policy.go:495`) exposes no command and is unaffected; the policy test's banned-flag list needs no change.
- **Docs**: `docs/site/skill.md` + `app/backend/cmd/rk/skill/skill.md` (keep byte-identical), `docs/specs/ui-state.md`; memory per Affected Memory.
- **Behavior contract**: every `rk tab new -- CMD` now runs the user's rc file before CMD. Expect slower boot by the rc cost, plus any rc side effects (prompt frameworks, motd, `exec`-ing rc files). `--no-shell-profile` restores the old behavior. Callers include fab's operator (worker spawns) and the hexokit tutorial (`rk tab new --name tour-worker`, no command, so unaffected).
- **Shells**: the literal-token guarantee holds for POSIX-family `$SHELL` (sh, dash, bash, zsh). For a non-POSIX `$SHELL` (fish, nushell) the inner re-parse can differ (e.g. fish collapses `\\` inside single quotes). riff skill panes already have the same exposure, and tmux's `default-shell` already parses the outer layer.
- **Verification**: `just test-backend` (Go tests via `just`, never `go test` directly). PR evidence: see Assumptions #14.

## Open Questions

All resolved 2026-11-11 (see Assumptions #4, #13, #14).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Add `shellq.Interactive(cmd string) string` returning `${SHELL:-/bin/sh} -i -c <shellq.Quote(cmd)>` in `internal/shellq`; `riff.buildSkillShellString` calls it with byte-identical output | Discussed: agreed decision 1 (one implementation of the composition); the existing riff code is the exact reference string | S:95 R:90 A:95 D:90 |
| 2 | Certain | `rk tab new -- CMD…` composes `shellq.Interactive(shellq.QuoteArgv(args))` by default, then `WithShellFallback` unless `--no-shell-fallback` | Discussed: agreed decision 2; it mirrors riff/operator/tutorial and the fab dispatch fix [sca2] | S:95 R:80 A:90 D:90 |
| 3 | Certain | The argv-literal guarantee (Constitution I) is preserved by double quoting: QuoteArgv per token, then Quote over the whole inner string for `-c`; quoted words are not alias-expanded (env/profile only) | Discussed: stated in decision 2; Quote is total, so the inner parse yields the original tokens | S:90 R:85 A:90 D:90 |
| 4 | Certain | Opt-out flag named `--no-shell-profile` | Clarified — user chose it over `--raw`/`--bare`; `--no-interactive` rejected (clashes with toolkit principle №1's "non-interactive = no prompts"); shipped in #1125 | S:95 R:80 A:90 D:95 |
| 5 | Certain | `--no-shell-profile` composes the current raw form (QuoteArgv + optional fallback), is orthogonal to `--no-shell-fallback` (all four combinations legal), and without a `--` command is a usage error (exit 2), mirroring `--no-shell-fallback` | Discussed: decision 3 ("composes the current raw form"); the flag rule follows the existing `validateTabNewFlagRules` pattern | S:80 R:85 A:85 D:80 |
| 6 | Certain | A bare `rk tab new` (no command) is unchanged: there is no shell-command to wrap, and tmux's default shell already starts interactive | Code: `shellCmd` stays `""` when `len(args)==0` | S:85 R:90 A:95 D:95 |
| 7 | Certain | No MCP policy/schema change: `new_window` exposes no command form, and `--no-shell-profile` stays unexposed | Code: `internal/mcp/policy.go:495` row has no `--`/command args; the description says "no command form over MCP" | S:80 R:90 A:95 D:90 |
| 8 | Certain | Rejected: fixing the tmux server env (`set-environment -g` / login-shell server start) and moving exports to `~/.zshenv` | Discussed: env captured once at server start goes stale on token rotation and is fragile under systemd/launchd; `.zshenv` is a zsh-only user-side workaround | S:95 R:75 A:85 D:90 |
| 9 | Confident | riff cmd-type panes (`buildCmdShellString`) stay unwrapped (non-goal), keeping the existing rk-riff decision; `tab new` is "the remaining rk spawner without the wrap" | The conversation scoped the fix to tab new; rk-riff memory records the deliberate no-wrap for cmd panes; revisiting it is a separate change | S:55 R:80 A:70 D:60 |
| 10 | Confident | Integration tests run hermetically: set the test tmux server's `SHELL` to a controlled shell (bash + temp `HOME`/.bashrc, or `sh` + `ENV=`) so the developer's real rc files never run; a marker variable proves default = sourced and `--no-shell-profile` = not sourced | Constitution Test Integrity plus the code-quality rule that bug fixes include tests; the exact fixture shape is an apply-time choice | S:50 R:90 A:75 D:70 |
| 11 | Confident | The literal-token guarantee is claimed for POSIX-family `$SHELL` (sh/dash/bash/zsh); a non-POSIX `$SHELL` (fish/nushell) is documented as a known edge, not engineered around | riff skill panes already carry the same exposure, and tmux's default-shell already parses the outer layer; no evidence of non-POSIX users | S:40 R:75 A:65 D:60 |
| 12 | Certain | Update the `rk tab new` `Use`/`Long` help, the file-header and inline comments, `docs/site/skill.md` + embedded `cmd/rk/skill/skill.md` (byte-identical pair), the `docs/specs/ui-state.md` synopsis, and the memory files listed; mcp.md and cli-layering.md need verification only | Discussed: decision 4; a grep located every reference to the command form | S:85 R:90 A:85 D:80 |
| 13 | Confident | Login-wall classification ships in this change: the shared `inject.AwaitReady` classifier screen-gates both ready verdicts on the literal `Not logged in · Run /login` line (verified by reproduction, Claude Code v2.1.311) and returns the existing `ParkedError` with the snippet; a pure matcher over captured lines is unit-tested | Clarified — user chose "include it" over backlog; signature reproduced in a throwaway tmux server; shared placement is what [sca2] asked for (`fab dispatch ready` reports parked) and reuses the parked contract unchanged | S:80 R:70 A:75 D:70 |
| 14 | Certain | PR evidence: `No recording: <reason>` plus Go tests and the built-binary env check (minimal-env tmux server: default → token present, `--no-shell-profile` → missing) | Clarified — user chose "No recording + tests"; the throwaway rig cannot carry a live Claude login | S:95 R:85 A:90 D:95 |
| 15 | Confident | No fab-kit change is needed: fab's operator spawns workers through `rk tab new` (backlog [wzve]) and inherits the fix; `--no-shell-profile` in `--help` serves as the capability probe (principle №4) | Backlog [wzve]/[xga4] show the operator delegating spawns to `rk tab new`; fab dispatch pane workers were already fixed in fab-kit#698 | S:65 R:80 A:70 D:75 |
| 16 | Confident | Match riff's form exactly: no inner `exec` prefix inside `-c` | Keeps one composition (decision 1); zsh/bash already exec the last simple command of `-c`, so the process tree matches riff panes | S:55 R:85 A:70 D:70 |

16 assumptions (10 certain, 6 confident, 0 tentative, 0 unresolved).
