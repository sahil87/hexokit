package riff

import (
	"fmt"
	"path"
	"regexp"
	"strings"

	"rk/internal/shellq"
	"rk/internal/tmux"
)

// buildSkillShellString composes the shell string for a skill-type pane in
// three layers:
//  1. launcher-with-cmd-arg: `<launcher> '<escaped-cmdArg>'` OR just `<launcher>`
//     when cmdArg is empty (bare launcher: no positional).
//  2. interactive wrap: `${SHELL:-/bin/sh} -i -c '<escaped-layer-1>'` so
//     .zshrc/.bashrc aliases reach the launcher.
//  3. shellq.WithShellFallback suffix: `; exec "${SHELL:-/bin/sh}"` so the pane
//     stays interactive.
//
// Callers deciding BETWEEN positional and post-boot typed delivery go through
// taskPaneShellString; this function is the positional composition itself.
func buildSkillShellString(launcher, cmdArg string) string {
	var layer1 string
	if cmdArg == "" {
		layer1 = launcher
	} else {
		layer1 = fmt.Sprintf("%s %s", launcher, shellq.Quote(cmdArg))
	}
	interactive := fmt.Sprintf(`${SHELL:-/bin/sh} -i -c %s`, shellq.Quote(layer1))
	return shellq.WithShellFallback(interactive)
}

// SkillPaneCommand exposes the skill-pane shell composition to cmd/rk (rk
// tutorial launches its kickoff prompt through the same task-injection seam).
// Pure delegate of buildSkillShellString — byte-identical output, so the
// composition has exactly one implementation.
func SkillPaneCommand(launcher, prompt string) string {
	return buildSkillShellString(launcher, prompt)
}

// sessionUUIDRe matches the strict Claude session-UUID shape — the SAME rule as
// internal/transcript's uuidRe. Duplicated here (rather than imported) deliberately:
// this is a defense-in-depth gate at the seam where the ref enters the
// deliberately-unescaped launcher string, and internal/riff must not depend on
// internal/transcript to hold the security property (constitution §I). The API layer
// validates the ref before the engine is ever called; this re-check is what
// makes the property local to the composition.
var sessionUUIDRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// forkLauncherCommand is the launcher supporting Claude resume flags.
const forkLauncherCommand = "claude"

// resumeForkLauncher composes Claude fork/resume flags or Codex's fork
// subcommand into the launcher, never into the quoted prompt argument.
// Plain resume remains Claude-only. Empty or malformed refs leave the launcher
// unchanged so shell-significant input cannot enter the command string.
// Spawn additionally validates explicit fork providers and their session UUIDs.
func resumeForkLauncher(launcher, ref string, plain bool) (string, error) {
	if ref == "" || !sessionUUIDRe.MatchString(ref) {
		return launcher, nil
	}
	if launcherCommandName(launcher) == "codex" && !plain {
		return fmt.Sprintf("%s fork %s", launcher, ref), nil
	}
	if cmd := launcherCommandName(launcher); cmd != forkLauncherCommand {
		return "", ValidationErr("run-kit riff: cannot resume a conversation with launcher %q — --resume modes (plain and --fork-session) require %s", launcher, forkLauncherCommand)
	}
	if plain {
		return fmt.Sprintf("%s --resume %s", launcher, ref), nil
	}
	return fmt.Sprintf("%s --resume %s --fork-session", launcher, ref), nil
}

// skillRefRe matches a slash-led skill invocation: `/` + a skill-name head +
// an optional argument tail (everything after the first space, verbatim).
// Anything else — free prose, an already-`$`-prefixed invocation, a path like
// `/tmp/x` (the second `/` is outside the name charset and is not a space) —
// is free text, not an invocation.
var skillRefRe = regexp.MustCompile(`^/[a-z0-9][a-z0-9_-]*( .*)?$`)

// RenderSkillRef re-renders a skill invocation for the receiving provider: a
// value matching the skill-invocation shape gets its leading "/" swapped for
// prefix (arguments preserved verbatim); any other value passes through
// unchanged. An empty prefix behaves as "/" — the identity for slash values,
// so a spec that never set SkillPrefix renders byte-identical. Constants and
// preset/flag values stay written in canonical slash form; this renderer owns
// the translation. Pure.
func RenderSkillRef(prefix, value string) string {
	if prefix == "" {
		prefix = "/"
	}
	if !skillRefRe.MatchString(value) {
		return value
	}
	return prefix + value[1:]
}

// launcherCommandName returns the basename of a launcher string's first
// whitespace-separated word — `claude` for both `claude --foo` and
// `/opt/homebrew/bin/claude --foo`. An empty launcher yields "". Pure.
//
// A word-level split is deliberately naive about shell grammar (a launcher
// prefixed with `env FOO=1` reads as `env`): it is a gate, not a parser, so it
// errs toward rejecting a launcher it cannot positively identify as claude.
func launcherCommandName(launcher string) string {
	fields := strings.Fields(launcher)
	if len(fields) == 0 {
		return ""
	}
	return path.Base(fields[0])
}

// buildCmdShellString composes the shell string for a cmd-type pane. cmd panes
// get NO interactive `sh -i -c` wrap (the user's command is self-sufficient and
// wrapping would alter argv semantics). shellq.WithShellFallback appends the
// `; exec $SHELL` tail. Empty value → the bare-shell path (just
// `exec "${SHELL:-/bin/sh}"`).
func buildCmdShellString(value string) string {
	return shellq.WithShellFallback(value)
}

// paneShellString dispatches between skill and cmd composition by pane kind.
func paneShellString(launcher string, pane PaneSpec) string {
	if pane.Kind == PaneKindSkill {
		return buildSkillShellString(launcher, pane.Value)
	}
	return buildCmdShellString(pane.Value)
}

// taskPaneShellString composes pane 0 — the task pane. A claude launcher keeps
// the positional composition (instant, race-free; byte-identical to the plain
// paneShellString output); any other launcher with a non-empty skill value
// composes BARE — the value is the task, typed into the booted agent after the
// window spawns (deliver.go), because a positional argument is claude-only.
func taskPaneShellString(launcher string, pane PaneSpec) string {
	if pane.Kind == PaneKindSkill && taskDeliveryMode(launcher, pane.Value) == deliveryTyped {
		return buildSkillShellString(launcher, "")
	}
	return paneShellString(launcher, pane)
}

// sessionTarget returns the `new-window -t` target that creates the window IN
// spec.Session — the exact-match session form `=<session>:` (tmux.
// ExactSessionTarget) — or "" when Session is empty (CLI path — unscoped, so
// the ambient/attached session is used, byte-identical to pre-session
// behavior). The exact form is required because new-window's -t is a *window*
// target: a bare session name is matched against the attached session's window
// names first, so a window named like the target session would hijack the
// spawn into the wrong session (the same collision internal/tmux guards its
// own CreateWindow against).
func sessionTarget(spec EffectiveSpec) string {
	if spec.Session == "" {
		return ""
	}
	return tmux.ExactSessionTarget(spec.Session)
}

// windowTarget returns the tmux target for a NAMED window inside spec.Session:
// `=<session>:<name>` on the daemon path (exact-match session part, so
// split-window/select-layout operate on the correct session's window) or just
// `<name>` on the CLI path (empty Session → unscoped, byte-identical to
// pre-session behavior).
func windowTarget(spec EffectiveSpec, name string) string {
	if spec.Session == "" {
		return name
	}
	return tmux.ExactSessionTarget(spec.Session) + name
}

// buildSpawnArgvs returns the ordered tmux argvs (server prefix NOT included —
// tmuxArgv adds it at exec time) for a (worktreePath, resolvedName, spec) triple:
//
//	[0]: new-window (creates the window with pane 0 — the task pane, so its
//	     composition goes through taskPaneShellString)
//	[1..N-1]: split-window (one per additional pane)
//	[-1]: select-layout (skipped when spec.Layout == "")
//
// On the daemon path (spec.Session != "") new-window carries `-t =<session>:`
// (exact-match session form) so the window lands in the requested session, and
// split-window/select-layout target `=<session>:<name>`; on the CLI path
// (empty Session) all targets are unscoped (byte-identical to pre-session
// behavior).
//
// The trailing select-pane step is NOT in this slice — the pane id is a runtime
// value; the orchestrator constructs that argv from the captured pane id. Pure.
func buildSpawnArgvs(worktreePath, resolvedName string, spec EffectiveSpec) [][]string {
	argvs := make([][]string, 0, len(spec.Panes)+1)
	if len(spec.Panes) == 0 {
		return argvs
	}
	newWindow := []string{"new-window"}
	if t := sessionTarget(spec); t != "" {
		newWindow = append(newWindow, "-t", t)
	}
	newWindow = append(newWindow,
		"-n", resolvedName,
		"-c", worktreePath,
		taskPaneShellString(spec.Launcher, spec.Panes[0]),
	)
	argvs = append(argvs, newWindow)
	for _, pane := range spec.Panes[1:] {
		argvs = append(argvs, []string{
			"split-window",
			"-h",
			"-t", windowTarget(spec, resolvedName),
			"-c", worktreePath,
			paneShellString(spec.Launcher, pane),
		})
	}
	if spec.Layout != "" {
		argvs = append(argvs, []string{"select-layout", "-t", windowTarget(spec, resolvedName), spec.Layout})
	}
	return argvs
}

// buildNewWindowCaptureArgs returns the argv for
// `tmux new-window -P -F '#{pane_id}' …` for the first pane. The `-P -F` capture
// prints the new pane id (e.g. `%87`) so the orchestrator can target the final
// select-pane by pane id rather than a hardcoded `.0` index. On the daemon path
// it carries `-t =<session>:` (exact-match session form) so the window is
// created in the requested session; on the CLI path (empty Session) the target
// is unscoped. Pure.
func buildNewWindowCaptureArgs(worktreePath, resolvedName string, spec EffectiveSpec) []string {
	argv := []string{
		"new-window",
		"-P",
		"-F", "#{pane_id}",
	}
	if t := sessionTarget(spec); t != "" {
		argv = append(argv, "-t", t)
	}
	argv = append(argv,
		"-n", resolvedName,
		"-c", worktreePath,
		taskPaneShellString(spec.Launcher, spec.Panes[0]),
	)
	return argv
}

// parsePaneID parses the stdout of `tmux new-window -P -F '#{pane_id}'` (a single
// line with the new pane id). Returns the trimmed id or an error on
// empty/whitespace-only input. Pure.
func parsePaneID(stdout string) (string, error) {
	id := strings.TrimSpace(stdout)
	if id == "" {
		return "", fmt.Errorf("empty pane id from tmux new-window -P")
	}
	return id, nil
}
