package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"rk/internal/config"
	"rk/internal/inject"
	"rk/internal/riff"
	"rk/internal/tmux"
	"rk/internal/validate"

	"github.com/spf13/cobra"
)

// rk operator — open (or switch to) the server's operator: a per-tmux-server
// singleton window named 'operator' running the operator-tier launcher BARE,
// with the operator kickoff TYPED into the booted agent. The launcher and the
// provider's skill-invocation prefix are resolved by fab when it is installed
// (`fab agent operator -o yaml`) — rk never parses fab config (constitution
// §III) — and degrade to the default launcher when it is not. The kickoff is
// the rk-placed /operator skill (rendered through riff.RenderSkillRef with the
// resolved prefix, so a codex operator gets `$operator`) when the copy the
// agent's harness reads is rk-owned, else the plain instruction to load `rk
// skill operator` (operatorKickoff). It is typed, never a positional argument,
// because the launcher string is provider-opaque: only claude's CLI accepts a
// positional prompt (the tutorial.go rationale). Creation is atomic with the
// role mark: the new window is immediately stamped @rk_win_role=operator via
// the full rk role write-path (stampOperatorRole), so no window can exist
// unmarked.
//
// The one precondition is HARD (exit 1): inside tmux unless -L/--server names
// the server explicitly (the daemon-invocable form: no $TMUX, every tmux call
// addressed with -L <name>, and a singleton hit reported without any
// switch-client — there is no client to switch). The window's
// directory is deterministic: an explicit --dir wins in both modes; server
// mode without --dir reuses the server's last operator launch directory
// (@rk_srv_operator_root, stamped on every successful create) and falls back
// to $HOME when none is recorded or the recorded directory is gone; the
// interactive path keeps the git-root-of-cwd rule. No tmux subprocess runs
// before the precondition passes.
//
// The singleton probe is server-WIDE (unlike tutorial's session scope):
// `list-windows -a` on the current server, matching @rk_win_role=operator first
// (rk's identity convention) and falling back to the exact window name
// 'operator' (fab operator's legacy convention). Every tmux call is an
// argv-slice exec with a bounded context via the internal/tmux Run core
// (constitution §I); the launcher string stays riff's one documented
// shell-expansion exception, and the --workers value is charset-gated before
// it may enter that shell string. The kickoff delivery goes through the shared
// inject composite (inject.DeliverWhenReady) with the CLI's per-invocation
// buffer; the typed text never passes through a shell.

const (
	// operatorKickoffPrompt is the kickoff typed into the operator agent after
	// it boots when the rk-placed /operator skill is there — slash form;
	// riff.RenderSkillRef translates it for the resolved provider before
	// delivery.
	operatorKickoffPrompt = "/" + operatorSkillName
	// operatorKickoffFallback is typed instead when that skill is absent or
	// not rk-owned: the instruction the placed skill itself carries.
	operatorKickoffFallback = "Run `rk skill operator` and follow its output as your operator skill for this session."
	// operatorWindowName is the created window's name and the exact-name
	// singleton fallback — no prefix/substring.
	operatorWindowName = "operator"
	// operatorRoleValue is the @rk_win_role value the singleton probe matches
	// first and the create path stamps.
	operatorRoleValue = "operator"
	// operatorTier is the fab role tier the launcher resolves from.
	operatorTier = "operator"
	// operatorListFormat is the list-windows format the singleton probe parses:
	// window id, role option, window name (the name LAST so tab-containing
	// names stay intact and can never exact-match).
	operatorListFormat = "#{window_id}\t#{" + tmux.RoleOption + "}\t#{window_name}"
	// operatorCmdTimeout bounds every individual subprocess the command spawns
	// (constitution §I: 5-10s for short-lived tmux helpers) — each tmux call,
	// and launcher resolution as the parent of riff.FabTimeout.
	operatorCmdTimeout = 10 * time.Second
)

// operatorDeliverDeadline is the wall-clock budget for the boot-readiness wait
// inside the kickoff delivery (inject.AwaitReady's deadline); past it the
// command degrades to a paste-it-yourself note (never a non-zero exit — the
// window and agent exist either way). A var (not a const) so tests can shrink
// it; the default tolerates a slow agent boot.
var operatorDeliverDeadline = 25 * time.Second

// operatorServerDeliverDeadline is the server-mode (-L/--server) delivery
// budget, paired with WaitThroughWalls: with nobody watching the pane the wait
// rides out a wall the user clears from the drawer. 60s + operatorCmdTimeout
// (10s) stays under both callers' 90s bounds (operatorStartProcessTimeout and
// cron.DefaultRespawnTimeout). A var, the operatorDeliverDeadline precedent.
var operatorServerDeliverDeadline = 60 * time.Second

// operatorWorkersRe is the charset gate for --workers: the value enters the
// deliberately-unescaped launcher shell string (constitution §I), so only this
// alphabet may pass — anything else is a usage error before any subprocess.
var operatorWorkersRe = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

var operatorWorkersFlag string
var operatorServerFlag string
var operatorDirFlag string
var operatorJSONFlag bool

// dirRung* are the closed set of dir_rung tokens the --json created receipt
// reports — the reason the operator window's directory was chosen (the
// sessionRung* precedent: the key set is stable, so the token set is too).
const (
	dirRungExplicit = "explicit"
	dirRungStored   = "stored"
	dirRungHome     = "home"
)

// operatorReceipt is the --json success document: the window id, the server
// label (the -L value in server mode, else the caller's socket basename), and
// created:false on both singleton hits — the verb is idempotent. Dir/DirRung
// name the chosen window directory and why; they are set only when a
// directory decision was made (server mode or --dir), so a singleton hit and
// the interactive default omit both.
type operatorReceipt struct {
	Window  string `json:"window"`
	Server  string `json:"server"`
	Created bool   `json:"created"`
	Dir     string `json:"dir,omitempty"`
	DirRung string `json:"dir_rung,omitempty"`
}

var operatorCmd = &cobra.Command{
	Use:   "operator [--workers <provider>] [-L <server>] [--dir <path>]",
	Short: "Open the operator — the server-wide orchestrator agent tab (singleton)",
	Long: `Open (or switch to) the run-kit operator: a per-tmux-server singleton
window named 'operator' running the operator-tier agent, role-marked so the
dashboard pins it as the server's orchestrator.

The operator is SERVER-wide: re-running from any session on the same tmux
server switches to the existing operator window instead of opening a
duplicate. A window carrying the @rk_win_role=operator marker wins over one
merely named 'operator'.

The agent launcher is resolved via 'fab agent operator -o yaml' when fab is
installed; without fab, or when resolution fails, the plain default launcher is
used. Once the agent has booted, the kickoff is typed into it and submitted —
never passed as a positional argument, so any provider's CLI works. The kickoff
is /operator (re-prefixed for the resolved provider) when 'rk agent setup' has
placed the operator skill the agent's harness reads, else an instruction to
run 'rk skill operator' and follow it. If that delivery cannot be verified, the
command says exactly what to paste instead. A newly
created window is marked @rk_win_role=operator and promoted into the server's
operator session atomically — the same end state 'rk role operator' produces.
The pane drops to an interactive shell when the agent exits.

--workers <provider> sets FAB_AGENT_WORKERS for the launched agent. The value
is restricted to letters, digits, '_' and '-' (it enters the launch shell
string), and an invalid value is a usage error before anything runs.

-L/--server <name> addresses a NAMED tmux server instead of the caller's own:
the inside-tmux precondition is waived (this is how the cron daemon invokes
it), every tmux call runs against -L <name>, and an already-present operator
tab is reported without switching any client. Without --dir the window's
working directory is the one recorded by the server's last operator launch
(the server-scoped @rk_srv_operator_root option, stamped on every successful
create); when none is recorded — or the recorded directory no longer exists —
the window opens in your home directory.

--dir <path> pins the window's working directory outright (both modes): the
value must be an absolute path to an existing directory, and its git root
drives agent resolution. The recorded-directory lookup above does not run when
--dir is given. Every created operator records its directory for later
respawns.

To hand the operator a templated work item (fix-tab-name, brief-me,
spawn-task, …) from the shell, use 'rk operator request' — see
'rk operator request --help'.

Prerequisite (hard — the command refuses without it):
  - You must be inside a tmux session ($TMUX set), unless -L/--server is given.

Examples:
  run-kit operator                  # open (or return to) the server operator
  run-kit operator --workers kimi   # run its stage workers on another provider
  run-kit operator -L runKit        # ensure the operator on server runKit

Exit codes:
  0  success (including a window opened with an undeliverable kickoff)
  1  precondition failure ($TMUX unset without -L)
  2  usage error (invalid --workers or --dir value)
  3  subprocess failure (tmux non-zero exit, timeout)`,
	Args: cobra.NoArgs,
	RunE: runOperatorWithExitCode,
}

func init() {
	operatorCmd.Flags().StringVar(&operatorWorkersFlag, "workers", "",
		"set FAB_AGENT_WORKERS for the launched operator agent (letters, digits, '_' and '-' only)")
	operatorCmd.Flags().StringVarP(&operatorServerFlag, "server", "L", "",
		"address the named tmux server (no $TMUX required; without --dir the window opens in the server's last recorded operator directory, else the home directory; an existing operator tab is reported, not switched to)")
	operatorCmd.Flags().StringVar(&operatorDirFlag, "dir", "",
		"pin the operator window's working directory (absolute path to an existing directory; also drives agent resolution)")
	operatorCmd.Flags().BoolVar(&operatorJSONFlag, "json", false,
		"emit the machine-readable envelope (exactly one JSON document on stdout)")
	operatorCmd.AddCommand(operatorRequestCmd)
}

// operator*Fn are package-level seams so runOperator can be tested without a
// live tmux server or fab (the tutorial.go pattern); the defaults delegate to
// internal/tmux / internal/riff. operatorOriginalTMUXFn is the $TMUX seam:
// internal/tmux's init() strips $TMUX from the process, so the captured
// OriginalTMUX is fixed at package-init time and cannot be varied with
// t.Setenv. The role-stamp steps route through role.go's own seams
// (roleClearExceptFn / roleRunFn / roleDemoteFn / roleMoveInFn) — one
// implementation of the write path.
// operatorRunFunc / operatorRunOutputFunc are the tmux-calling shapes the
// create-and-mark helper is parameterized on, so the interactive path
// ($TMUX-restored env, bare args) and the -L/--server path (nil env,
// -L-addressed args) share one implementation.
type operatorRunFunc func(ctx context.Context, args, env []string) error
type operatorRunOutputFunc func(ctx context.Context, args, env []string) ([]byte, error)

var (
	operatorOriginalTMUXFn = func() string { return tmux.OriginalTMUX }
	operatorRunFn          = operatorRunFunc(func(ctx context.Context, args, env []string) error {
		return tmux.Run(ctx, args, tmux.RunOpts{Env: env})
	})
	operatorRunOutputFn = operatorRunOutputFunc(func(ctx context.Context, args, env []string) ([]byte, error) {
		return tmux.RunOutput(ctx, args, tmux.RunOpts{Env: env})
	})
	operatorResolveAgentFn = riff.ResolveAgent
	// operatorResolvePresetFn runs the agent-preset ladder for the chat window.
	operatorResolvePresetFn = riff.ResolveAgentPreset
	// operatorGetRootFn reads the server's recorded operator launch directory
	// (@rk_srv_operator_root) for the -L path's stored rung; tests stub it to
	// drive the stored/home rungs tmux-free. An unset option or a read error
	// degrades to the home fallback — the window is still worth opening.
	operatorGetRootFn = func(ctx context.Context, server string) (string, error) {
		return tmux.GetOperatorRoot(ctx, server)
	}
	// operatorStampRootFn records a created window's directory as the server's
	// operator root for later -L launches. server is the -L value in server
	// mode and the caller's socket-basename label interactively (the
	// cliServerLabel derivation the kickoff delivery already targets). Tests
	// stub it.
	operatorStampRootFn = func(ctx context.Context, server, dir string) error {
		return tmux.SetOperatorRoot(ctx, server, dir)
	}
)

// runOperatorWithExitCode is the cobra RunE (execute()'s central writer covers plain --json errors; the
// plain-error envelope). The riff ExitCodeError discipline applies (same as
// runTutorialWithExitCode): the message prints bare to stderr and the process
// exits with the carried code — under --json the error envelope is written
// first, because no outer wrapper runs after an os.Exit; any other error
// returns to main.execute() as a generic exit-1 error (usageError-wrapped ones
// carry their exit 2 through exitCode's classification).
func runOperatorWithExitCode(cmd *cobra.Command, _ []string) error {
	err := runOperator(cmd)
	if err == nil {
		return nil
	}
	var ece *riff.ExitCodeError
	if errors.As(err, &ece) {
		if operatorJSONFlag {
			code := envelopeCodeOperational
			if ece.Code == riff.ExitValidation {
				code = envelopeCodeUsage
			}
			newSink(cmd).JSONError(envelopeError{Code: code, Message: ece.Msg})
		}
		fmt.Fprintln(cmd.ErrOrStderr(), ece.Msg)
		exitRecorded(err, ece.Code)
	}
	return err
}

// runOperator is the testable core: --workers validation → hard precondition
// ($TMUX unless -L/--server names the server) →
// server-wide singleton probe → create-and-mark → typed kickoff delivery. No
// subprocess runs before the precondition passes.
func runOperator(cmd *cobra.Command) error {
	// The charset gate is pure validation — it runs before ANY subprocess, so a
	// rejected value never reaches a shell string (constitution §I). An empty
	// value is the unset case: byte-identical bare composition.
	if operatorWorkersFlag != "" && !operatorWorkersRe.MatchString(operatorWorkersFlag) {
		return usageError(fmt.Errorf("invalid --workers value %q: must match %s", operatorWorkersFlag, operatorWorkersRe))
	}
	// --dir validation is likewise pure (absolute, exists, is a directory) and
	// runs before ANY subprocess: the value becomes the window's -c argument
	// and the agent-resolution root, so a rejected value never reaches tmux.
	// An explicitly supplied empty value (--dir= / --dir "") is rejected too,
	// never silently treated as unset.
	if operatorDirFlag != "" || cmd.Flags().Changed("dir") {
		if err := validateOperatorDir(operatorDirFlag); err != nil {
			return usageError(err)
		}
	}
	// -L/--server is the daemon-invocable form: it addresses a named server
	// outright, so the inside-tmux precondition is waived and no client is
	// ever switched.
	serverMode := operatorServerFlag != ""
	originalTMUX := operatorOriginalTMUXFn()
	if !serverMode && originalTMUX == "" {
		return &riff.ExitCodeError{Code: riff.ExitPrecondition, Msg: "run-kit operator: not inside a tmux session ($TMUX unset) — open the run-kit dashboard, create a session/window for this directory, then run `rk operator` inside it (or pass -L <server> to address a server by name)"}
	}

	// The server label keys the kickoff delivery's tmux addressing and the
	// --json receipt's server field: the -L value in server mode, else the
	// caller's socket basename.
	serverLabel := operatorServerFlag
	if !serverMode {
		serverLabel = cliServerLabel(originalTMUX)
	}

	parent := cmd.Context()
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, operatorCmdTimeout)
	defer cancel()

	// Server mode prefixes every tmux call with -L <name> and runs with the
	// process env as-is (there is no $TMUX to restore); the interactive path
	// restores the caller's $TMUX and lets bare calls find the current server.
	var env, serverPrefix []string
	if serverMode {
		serverPrefix = operatorServerPrefix(operatorServerFlag)
	} else {
		env = tmux.ChildEnv(originalTMUX)
	}

	// Server-wide singleton probe: list-windows -a enumerates every session's
	// windows on the server. The @N id is the select target — window-id
	// targeting is exempt from tmux's prefix/glob name resolution.
	out, err := operatorRunOutputFn(ctx, append(serverPrefix, "list-windows", "-a", "-F", operatorListFormat), env)
	if err != nil {
		return &riff.ExitCodeError{Code: riff.ExitSubprocess, Msg: fmt.Sprintf("run-kit operator: tmux list-windows failed: %v", err)}
	}
	if id := findOperatorWindowID(string(out)); id != "" {
		sink := newSink(cmd)
		if serverMode {
			// There is no client to switch — the hit alone satisfies the
			// command (the message must not claim one happened).
			if operatorJSONFlag {
				sink.JSONResult(operatorReceipt{Window: id, Server: serverLabel, Created: false})
				return nil
			}
			fmt.Fprintln(cmd.OutOrStdout(), "Operator tab already present.")
			return nil
		}
		if err := operatorRunFn(ctx, []string{"select-window", "-t", id}, env); err != nil {
			return &riff.ExitCodeError{Code: riff.ExitSubprocess, Msg: fmt.Sprintf("run-kit operator: tmux select-window failed: %v", err)}
		}
		// Best-effort: the window may live in another session, so move the
		// user's client there — a failure is ignored (the singleton invariant
		// is already preserved).
		_ = operatorRunFn(ctx, []string{"switch-client", "-t", id}, env)
		if operatorJSONFlag {
			sink.JSONResult(operatorReceipt{Window: id, Server: serverLabel, Created: false})
			return nil
		}
		fmt.Fprintln(cmd.OutOrStdout(), "Switched to existing operator tab.")
		return nil
	}

	// Directory selection is deterministic: an explicit --dir wins in both
	// modes (used verbatim; its git root — falling back to the path itself —
	// drives agent resolution). Server mode without --dir reuses the server's
	// recorded operator root (@rk_srv_operator_root) when it still validates;
	// nothing recorded (or an unreadable/gone record) falls back to the home
	// directory, rung home, with the agent root left empty. The interactive
	// default keeps the git-root-of-cwd rule.
	var windowDir, root, rung string
	switch {
	case operatorDirFlag != "":
		windowDir = operatorDirFlag
		rung = dirRungExplicit
		root = config.FindGitRoot(operatorDirFlag)
		if root == "" {
			root = operatorDirFlag
		}
	case serverMode:
		stored, serr := operatorGetRootFn(ctx, operatorServerFlag)
		if serr == nil && stored != "" && validateOperatorDir(stored) == nil {
			windowDir = stored
			rung = dirRungStored
			root = config.FindGitRoot(stored)
			if root == "" {
				root = stored
			}
		} else {
			home, err := os.UserHomeDir()
			if err != nil {
				return fmt.Errorf("run-kit operator: resolve home directory: %w", err)
			}
			windowDir, rung = home, dirRungHome
		}
	default:
		cwd, err := os.Getwd()
		if err != nil {
			return fmt.Errorf("run-kit operator: resolve working directory: %w", err)
		}
		root = config.FindGitRoot(cwd)
		windowDir = root
		if windowDir == "" {
			windowDir = cwd
		}
	}

	// Agent resolution never errors — any failure (fab absent, non-zero,
	// timeout, malformed output) degrades silently to the default launcher
	// with the claude-syntax prefix.
	// The agent preset follows the same ladder as any spawn, aimed at the hidden
	// operator session (in practice the workspace's option); the name reaches
	// the fab exec and the window's env.
	agentPreset := operatorResolvePresetFn(ctx, "", operatorServerFlag, tmux.OperatorSessionName, originalTMUX)
	agent := operatorResolveAgentFn(ctx, root, operatorTier, agentPreset)
	// Bare launcher (empty prompt): the kickoff is typed after boot, below.
	shellCmd := operatorShellCommand(agent.Launcher, operatorWorkersFlag)

	socketPrefix := serverPrefix
	if !serverMode {
		socketPrefix = tmuxSocketArgs(originalTMUX)
	}
	// Server mode addresses the create-and-mark helper's tmux calls at the
	// named server too (createMarkedOperatorWindow applies the prefix itself
	// only to the role stamp).
	runOutput := operatorRunOutputFn
	if serverMode {
		runOutput = func(ctx context.Context, args, env []string) ([]byte, error) {
			return operatorRunOutputFn(ctx, append(serverPrefix, args...), env)
		}
	}
	var windowEnv []string
	if agentPreset != "" {
		windowEnv = []string{riff.AgentPresetEnvEntry(agentPreset)}
	}
	paneID, err := createMarkedOperatorWindow(ctx, runOutput, env, socketPrefix, windowDir, shellCmd, windowEnv)
	if err != nil {
		return &riff.ExitCodeError{Code: riff.ExitSubprocess, Msg: "run-kit operator: " + err.Error()}
	}

	// Record the launch directory on the server for later -L respawns (the
	// cron argv carries no --dir). Best-effort: the window and agent already
	// exist, so a failed stamp is a stderr note — never an exit-code or
	// receipt change. Singleton hits returned above and never stamp. The
	// interactive path addresses its server by the same socket-basename label
	// the kickoff delivery uses (cliServerLabel).
	stampServer := operatorServerFlag
	if !serverMode {
		stampServer = cliServerLabel(originalTMUX)
	}
	if err := operatorStampRootFn(ctx, stampServer, windowDir); err != nil {
		fmt.Fprintf(cmd.ErrOrStderr(), "run-kit operator: could not record the launch directory on the server (%v)\n", err)
	}

	if operatorJSONFlag {
		// The receipt names the created window's @N, resolved from the new pane
		// through the same (server-prefixed in server mode) seam. dir/dir_rung
		// ride along only when a directory decision was made (server mode or
		// --dir) — the interactive default leaves both empty (omitempty).
		winOut, werr := runOutput(ctx, []string{"display-message", "-p", "-t", paneID, "#{window_id}"}, env)
		if werr != nil {
			return fmt.Errorf("run-kit operator: resolve new window id: %w", werr)
		}
		receipt := operatorReceipt{Window: strings.TrimSpace(string(winOut)), Server: serverLabel, Created: true}
		if rung != "" {
			receipt.Dir = windowDir
			receipt.DirRung = rung
		}
		newSink(cmd).JSONResult(receipt)
	} else {
		fmt.Fprintf(cmd.OutOrStdout(), "Opened operator tab (window %q).\n", operatorWindowName)
	}

	kickoff := operatorKickoff(agent)

	// Typed-kickoff delivery is best-effort: the window and its agent exist
	// either way, so a delivery miss degrades to telling the user exactly what
	// to paste — never a non-zero exit. Server mode waits through walls (the
	// invoker is not watching the pane; a trust dialog the user clears from the
	// drawer should not end the wait) under the longer deadline; the
	// interactive path stays fail-fast — the human is looking at the pane.
	// IsGone lets a pane that dies mid-wait end the wait promptly instead of
	// riding out the full deadline as a stale parked/timeout result.
	deliverOpts := inject.ReadyOpts{Deadline: operatorDeliverDeadline, IsGone: isPaneGoneErr}
	if serverMode {
		deliverOpts = inject.ReadyOpts{Deadline: operatorServerDeliverDeadline, WaitThroughWalls: true, IsGone: isPaneGoneErr}
	}
	if deliverErr := deliverAgentKickoff(parent, operatorDeliverFn, serverLabel, paneID, kickoff, deliverOpts, operatorCmdTimeout); deliverErr != nil {
		fmt.Fprintf(cmd.ErrOrStderr(), "run-kit operator: could not deliver the kickoff prompt (%v) — paste this into the operator agent yourself:\n  %s\n", deliverErr, kickoff)
		// The machine-readable form of the miss is one stderr kickoff: line in
		// EVERY mode — the cron respawn argv carries no --json and reads it
		// from the combined-output tail, and the daemon's post-receipt log
		// parses the --json run's stderr; stdout stays exactly one JSON
		// document under --json. prompt and dir are Go-quoted (%q) so a
		// path or prompt containing spaces or " dir=" stays one field.
		fmt.Fprintf(cmd.ErrOrStderr(), "kickoff: undelivered reason=%s prompt=%q dir=%q\n", kickoffReason(deliverErr), kickoff, windowDir)
	}
	return nil
}

// operatorKickoff picks the text typed into the booted operator agent. When
// the operator skill copy the agent's harness reads is rk-owned (the claude
// copy for a claude launcher, the harness-neutral ~/.agents copy otherwise),
// it is the /operator invocation in the provider's syntax — a codex operator
// gets `$operator`. Otherwise (never set up, a user's own `operator` skill at
// that path, or no home directory) it is operatorKickoffFallback, which loads
// the same chat skill without the placed file.
func operatorKickoff(agent riff.ResolvedAgent) string {
	home, err := os.UserHomeDir()
	if err != nil {
		return operatorKickoffFallback
	}
	if !operatorSkillOwned(operatorSkillPath(home, riff.LauncherCommandName(agent.Launcher) == "claude")) {
		return operatorKickoffFallback
	}
	return riff.RenderSkillRef(agent.SkillPrefix, operatorKickoffPrompt)
}

// operatorServerPrefix addresses tmux calls at a named server: bare for
// ""/"default", else -L <server> — never "current server" (the -L/--server
// path's invoker, the cron daemon, has none; internal/tmux's init scrubbed
// TMUX from the process).
func operatorServerPrefix(server string) []string {
	if server == "" || server == "default" {
		return nil
	}
	return []string{"-L", server}
}

// createMarkedOperatorWindow is the create-and-mark half of the operator
// launch, shared by the interactive path (CLI env: $TMUX restored, bare tmux
// args, -S socket prefix for the stamp) and the -L/--server path (nil env,
// -L-addressed args): new-window running shellCmd in windowDir → resolve the
// new window id → atomically stamp the operator role via the full rk role
// write-path (socketPrefix addresses the stamp's tmux calls), so no window
// exists unmarked. Returns the new pane's id — the kickoff delivery's target.
// Error texts are caller-prefixed ("run-kit operator: "), so they carry no
// command name of their own.
func createMarkedOperatorWindow(ctx context.Context, runOutput operatorRunOutputFunc, env, socketPrefix []string, windowDir, shellCmd string, windowEnv []string) (string, error) {
	// -P -F captures the new pane's id — the typed delivery's send/capture
	// target (pane-id targeting, like window-id, is exempt from name
	// resolution). windowEnv entries become `-e KEY=VALUE` before the shell
	// command; none leaves the argv exactly as it always was.
	newWindow := []string{"new-window", "-P", "-F", "#{pane_id}", "-c", windowDir, "-n", operatorWindowName}
	newWindow = append(newWindow, tmux.NewWindowEnvArgs(windowEnv)...)
	paneOut, err := runOutput(ctx, append(newWindow, shellCmd), env)
	if err != nil {
		return "", fmt.Errorf("tmux new-window failed: %w", err)
	}
	paneID := strings.TrimSpace(string(paneOut))
	if paneID == "" {
		return "", errors.New("tmux new-window output parse failed: empty pane id")
	}

	winOut, err := runOutput(ctx, []string{"display-message", "-p", "-t", paneID, "#{window_id}"}, env)
	if err != nil {
		return "", fmt.Errorf("resolve new window id failed: %w", err)
	}
	// Validate before stamping (the role.go pattern): an empty or malformed id
	// reaching stampOperatorRole would radio-clear @rk_win_role from every
	// window (ClearWindowRoleExcept keeps nothing when keepWindowID is "").
	winID := strings.TrimSpace(string(winOut))
	if errMsg := validate.ValidateWindowID(winID, "Window ID"); errMsg != "" {
		return "", fmt.Errorf("resolve new window id failed: %s", errMsg)
	}
	if err := stampOperatorRole(ctx, socketPrefix, winID); err != nil {
		return "", fmt.Errorf("mark operator role: %w", err)
	}
	return paneID, nil
}

// operatorDeliverFn is the delivery seam (the tutorialDeliverFn pattern):
// production drives inject.DeliverWhenReady with the reconciled state reader
// merged into the caller's opts (deadline and wall posture are the caller's
// decision); tests substitute a recorder so the command path runs tmux-free.
var operatorDeliverFn = func(ctx context.Context, engine *inject.Engine, t inject.Tmux, server, paneID, text string, opts inject.ReadyOpts) (inject.Readiness, error) {
	opts.State = boundedPaneAgentState
	return inject.DeliverWhenReady(ctx, t, server, paneID, inject.Sanitize(text), true, engine, opts)
}

// findOperatorWindowID scans `tmux list-windows -a -F '<id>\t<role>\t<name>'`
// output for the server-wide operator singleton and returns its @N id (""
// when absent). A window whose role option equals 'operator' wins over a
// name-only match REGARDLESS of order; the name fallback exact-matches the
// LAST field (everything after the second tab), so tab-containing names stay
// intact and can never exact-match, and prefix/substring never match. Pure.
func findOperatorWindowID(listOutput string) string {
	nameHit := ""
	for _, line := range strings.Split(listOutput, "\n") {
		id, rest, found := strings.Cut(line, "\t")
		if !found {
			continue
		}
		role, name, found := strings.Cut(rest, "\t")
		if !found {
			continue
		}
		if role == operatorRoleValue {
			return id
		}
		if nameHit == "" && name == operatorWindowName {
			nameHit = id
		}
	}
	return nameHit
}

// operatorShellCommand composes the pane's shell string: the bare launcher
// (the kickoff is typed after boot, never positional), with the
// charset-validated FAB_AGENT_WORKERS prefix scoped to the AGENT COMMAND ONLY
// when --workers is set — layer 1 of the composition, before the interactive
// wrap and the exec-shell tail. An empty workers value yields the
// byte-identical bare composition. Pure.
func operatorShellCommand(launcher, workers string) string {
	if workers != "" {
		launcher = "FAB_AGENT_WORKERS=" + workers + " " + launcher
	}
	return riff.SkillPaneCommand(launcher, "")
}

// validateOperatorDir gates --dir before any subprocess: the value must be an
// absolute path to an existing directory, and the error names the failed
// check. Pure.
func validateOperatorDir(dir string) error {
	if !filepath.IsAbs(dir) {
		return fmt.Errorf("invalid --dir value %q: must be an absolute path", dir)
	}
	st, err := os.Stat(dir)
	if err != nil {
		return fmt.Errorf("invalid --dir value %q: path does not exist: %v", dir, err)
	}
	if !st.IsDir() {
		return fmt.Errorf("invalid --dir value %q: not a directory", dir)
	}
	return nil
}

// kickoffReason maps a kickoff delivery failure to the closed reason token
// the kickoff: stderr line carries; both deadline-shaped errors (the wait
// expiring and the delivery context timing out) read as timeout, and anything
// unrecognized is a send error. Pure.
func kickoffReason(err error) string {
	switch {
	case errors.Is(err, inject.ErrParked):
		return "parked"
	case errors.Is(err, inject.ErrNarrow):
		return "narrow"
	case errors.Is(err, inject.ErrGone):
		return "gone"
	case errors.Is(err, inject.ErrNotReady), errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	default:
		return "send-error"
	}
}
