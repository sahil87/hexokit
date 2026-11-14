package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"rk/internal/config"
	"rk/internal/inject"
	"rk/internal/riff"
	"rk/internal/tmux"

	"github.com/spf13/cobra"
)

// rk tutorial — the human-typable entry to the guided tour (`rk skill
// tutorial`). Opens a window named 'tutorial' in the CURRENT tmux session
// running the --tier-resolved launcher BARE, then TYPES the kickoff prompt
// into the booted agent and submits it. The kickoff is typed — never a
// launcher positional argument — because the launcher string is
// provider-opaque: only claude's CLI accepts a positional prompt (kimi parses
// one as a subcommand and exits), so typed keys are the only provider-agnostic
// delivery. Re-running selects the existing window rather than stacking a
// duplicate — a tour belongs to the project session it started in, so the
// singleton is session-scoped (not operator's server-wide probe) and no
// `tutorial-2` suffixing.
//
// The command composes its own tmux calls (list-windows probe +
// new-window/select-window) directly — riff.Run's worktree/collision/layout
// machinery is the wrong shape for select-or-create in the current session.
// Every tmux call is an argv-slice exec with a bounded context via the
// internal/tmux Run core (constitution §I); launcher resolution is
// riff.ResolveLauncher's own bounded exec of `fab`; the launcher string stays
// riff's one documented shell-expansion exception. The kickoff delivery goes
// through the shared inject composite (inject.DeliverWhenReady — boot-readiness
// wait, then the engine's named-buffer bracketed paste + echo probe +
// probe-gated Enter) with the CLI's per-invocation buffer; the typed text never
// passes through a shell.

const (
	// tutorialKickoffPrompt is the exact kickoff typed into the tour agent
	// after it boots.
	tutorialKickoffPrompt = "Run rk skill tutorial and follow it exactly"
	// tutorialWindowName is the exact window name the singleton probe
	// matches — no prefix/substring.
	tutorialWindowName = "tutorial"
	// tutorialCmdTimeout bounds every individual subprocess the command spawns
	// (constitution §I: 5-10s for short-lived tmux helpers) — each tmux call,
	// and launcher resolution as the parent of riff.FabTimeout.
	tutorialCmdTimeout = 10 * time.Second
)

// tutorialDeliverDeadline is the wall-clock budget for the boot-readiness wait
// inside the kickoff delivery (inject.AwaitReady's deadline); past it the
// command degrades to a paste-it-yourself note (never a non-zero exit — the
// window and agent exist either way). A var (not a const) so tests can shrink
// it; the default tolerates a slow agent boot.
var tutorialDeliverDeadline = 25 * time.Second

var tutorialTierFlag string

var tutorialCmd = &cobra.Command{
	Use:   "tutorial [--tier <role>]",
	Short: "Open the guided tour — an agent-run tutorial tab in this session",
	Long: `Open the run-kit guided tour: a window named 'tutorial' in the current
tmux session, running an agent that walks you through run-kit chapter by chapter.

The agent launcher is resolved for the --tier fab role via 'fab agent <tier>
--print'; when fab is absent or resolution fails, the plain default launcher
(claude --dangerously-skip-permissions) is used. The default fast tier keeps
the tour's short narration beats snappy. Once the agent has booted, the
kickoff prompt is typed into it and submitted; if that delivery cannot be
verified (an unusually slow boot, a first-run dialog), the command says
exactly what to paste instead.

Re-running 'rk tutorial' when a window named 'tutorial' already exists in the
current session switches to it instead of opening a duplicate. The pane drops
to an interactive shell when the agent exits.

Prerequisites:
  - You must be inside a tmux session ($TMUX set). Not inside one? Open the
    run-kit dashboard, create a session/window, and run this inside it.

Examples:
  run-kit tutorial              # open (or return to) the tour on the fast tier
  run-kit tutorial --tier doing # run the tour on another fab role

Exit codes:
  0  success (including a window opened with an undeliverable kickoff)
  1  precondition failure ($TMUX unset)
  3  subprocess failure (tmux non-zero exit, timeout)`,
	Args: cobra.NoArgs,
	RunE: runTutorialWithExitCode,
}

func init() {
	tutorialCmd.Flags().StringVar(&tutorialTierFlag, "tier", "fast", "fab role tier the tour agent's launcher resolves from")
}

// tutorial*Fn are package-level seams so runTutorial can be tested without a
// live tmux server or fab (the role.go pattern); the defaults delegate to
// internal/tmux / internal/riff. tutorialOriginalTMUXFn is the $TMUX seam:
// internal/tmux's init() strips $TMUX from the process, so the captured
// OriginalTMUX is fixed at package-init time and cannot be varied with
// t.Setenv.
var (
	tutorialOriginalTMUXFn = func() string { return tmux.OriginalTMUX }
	tutorialRunFn          = func(ctx context.Context, args, env []string) error {
		return tmux.Run(ctx, args, tmux.RunOpts{Env: env})
	}
	tutorialRunOutputFn = func(ctx context.Context, args, env []string) ([]byte, error) {
		return tmux.RunOutput(ctx, args, tmux.RunOpts{Env: env})
	}
	tutorialResolveLauncherFn = riff.ResolveLauncher
)

// runTutorialWithExitCode is the cobra RunE. The riff ExitCodeError discipline
// applies (same as runRiffWithExitCode): the message prints bare to stderr and
// the process exits with the carried code; any other error returns to
// main.execute() as a generic exit-1 error.
func runTutorialWithExitCode(cmd *cobra.Command, _ []string) error {
	err := runTutorial(cmd)
	if err == nil {
		return nil
	}
	var ece *riff.ExitCodeError
	if errors.As(err, &ece) {
		fmt.Fprintln(cmd.ErrOrStderr(), ece.Msg)
		exitRecorded(err, ece.Code)
	}
	return err
}

// runTutorial is the testable core: precondition ($TMUX) → session-scoped
// singleton probe → resolve launcher → open bare-launcher window → typed
// kickoff delivery. No tmux subprocess runs before the precondition passes.
func runTutorial(cmd *cobra.Command) error {
	if tutorialOriginalTMUXFn() == "" {
		return &riff.ExitCodeError{Code: riff.ExitPrecondition, Msg: "run-kit tutorial: not inside a tmux session ($TMUX unset) — open the run-kit dashboard, create a session/window for this directory, then run `rk tutorial` inside it"}
	}

	parent := cmd.Context()
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, tutorialCmdTimeout)
	defer cancel()

	env := tmux.ChildEnv(tutorialOriginalTMUXFn())

	// Singleton probe: list-windows with $TMUX restored enumerates only the
	// current session's windows. The @N id is the select target — window-id
	// targeting is exempt from tmux's prefix/glob name resolution.
	out, err := tutorialRunOutputFn(ctx, []string{"list-windows", "-F", "#{window_id}\t#{window_name}"}, env)
	if err != nil {
		return &riff.ExitCodeError{Code: riff.ExitSubprocess, Msg: fmt.Sprintf("run-kit tutorial: tmux list-windows failed: %v", err)}
	}
	if id := findTutorialWindowID(string(out)); id != "" {
		if err := tutorialRunFn(ctx, []string{"select-window", "-t", id}, env); err != nil {
			return &riff.ExitCodeError{Code: riff.ExitSubprocess, Msg: fmt.Sprintf("run-kit tutorial: tmux select-window failed: %v", err)}
		}
		fmt.Fprintln(cmd.OutOrStdout(), "Switched to existing tutorial tab.")
		return nil
	}

	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("run-kit tutorial: resolve working directory: %w", err)
	}

	// Launcher resolution never errors — any failure (fab absent, non-zero,
	// timeout, malformed output) degrades silently to riff.DefaultLauncher.
	launcher := tutorialResolveLauncherFn(ctx, config.FindGitRoot(cwd), tutorialTierFlag)
	// Bare launcher (empty prompt): the kickoff is typed after boot, below.
	shellCmd := riff.SkillPaneCommand(launcher, "")

	// -P -F captures the new pane's id — the typed delivery's send/capture
	// target (pane-id targeting, like window-id, is exempt from name
	// resolution).
	paneOut, err := tutorialRunOutputFn(ctx, []string{"new-window", "-P", "-F", "#{pane_id}", "-c", cwd, "-n", tutorialWindowName, shellCmd}, env)
	if err != nil {
		return &riff.ExitCodeError{Code: riff.ExitSubprocess, Msg: fmt.Sprintf("run-kit tutorial: tmux new-window failed: %v", err)}
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Opened tutorial tab (window %q, tier %q).\n", tutorialWindowName, tutorialTierFlag)

	// Typed-kickoff delivery is best-effort: the window and its agent exist
	// either way, so a delivery miss degrades to telling the user exactly what
	// to paste — never a non-zero exit.
	deliverErr := errors.New("tmux new-window printed no pane id")
	if paneID := strings.TrimSpace(string(paneOut)); paneID != "" {
		deliverErr = deliverAgentKickoff(parent, tutorialDeliverFn, cliServerLabel(tutorialOriginalTMUXFn()), paneID, tutorialKickoffPrompt, inject.ReadyOpts{Deadline: tutorialDeliverDeadline}, tutorialCmdTimeout)
	}
	if deliverErr != nil {
		fmt.Fprintf(cmd.ErrOrStderr(), "run-kit tutorial: could not deliver the kickoff prompt (%v) — paste this into the tour agent yourself:\n  %s\n", deliverErr, tutorialKickoffPrompt)
	}
	return nil
}

// tutorialDeliverFn is the delivery seam (the tutorialRunFn pattern):
// production drives inject.DeliverWhenReady with the reconciled state reader;
// tests substitute a recorder so the command path runs tmux-free.
var tutorialDeliverFn = func(ctx context.Context, engine *inject.Engine, t inject.Tmux, server, paneID, text string, opts inject.ReadyOpts) (inject.Readiness, error) {
	opts.State = boundedPaneAgentState
	return inject.DeliverWhenReady(ctx, t, server, paneID, inject.Sanitize(text), true, engine, opts)
}

// findTutorialWindowID scans `tmux list-windows -F '#{window_id}\t#{window_name}'`
// output for a window named exactly 'tutorial' and returns its @N id ("" when
// absent). The name is everything after the FIRST tab — the last field of the
// format string — so tab-containing names stay intact and can never exact-match.
// Pure.
func findTutorialWindowID(listOutput string) string {
	for _, line := range strings.Split(listOutput, "\n") {
		id, name, found := strings.Cut(line, "\t")
		if found && name == tutorialWindowName {
			return id
		}
	}
	return ""
}
