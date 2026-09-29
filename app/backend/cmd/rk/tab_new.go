package main

// rk tab new — create a window, optionally born with a layout and/or running a
// command: the layout is validated before creation and written in the creation
// ops (no second round trip, no un-laid-out tick). Session resolution is the
// presentViaNewWindow rule, shared via resolveTabNewSession: --session wins
// (=S exact form); outside tmux the target server's current session; inside
// tmux the caller's own session when it classifies role user — an
// infrastructure caller (_rk-*) never lands a window beside itself and instead
// picks a user session through the pickLandingSession ladder (sole user →
// --cwd's main-worktree root match → most attached), failing nowhere-to-spawn
// when the server has no user session. The deciding rung is reported as
// session_rung.
//
// The command form is argv after `--`, never a shell string: every token is
// single-quoted via internal/shellq so the window's shell receives it as one
// literal word, and rk's agent-exit fallback (`; exec "${SHELL:-/bin/sh}"`) is
// appended unless --no-shell-fallback. --json swaps the bare @N datum for the
// {session, session_rung, window_id, pane_id} object inside the standard
// envelope; --ready
// (requires --json and a command) adds the boot-readiness verdict via the
// rk mux await --ready seam.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"rk/internal/gitinfo"
	"rk/internal/layoutspec"
	"rk/internal/shellq"
	"rk/internal/tmux"
	"rk/internal/validate"

	"github.com/spf13/cobra"
)

var (
	tabNewSessionFlag         string
	tabNewCwdFlag             string
	tabNewNameFlag            string
	tabNewLayoutFlag          string
	tabNewJSONFlag            bool
	tabNewReadyFlag           bool
	tabNewTimeoutFlag         int
	tabNewNoShellFallbackFlag bool
)

var tabNewCmd = &cobra.Command{
	Use:   "new [--session =S] [--cwd DIR] [--name N] [--layout L] [--json] [--ready [--timeout SECS]] [--no-shell-fallback] [-- CMD [ARG…]]",
	Short: "Create a window, optionally born with a layout and/or running a command",
	Long: "Create a window and print its id (@N). --layout <shape>:<surface,…> is\n" +
		"validated before creation and written as @rk_win_layout in the creation\n" +
		"call, so the window is born with its layout. --session takes the =S\n" +
		"exact form (no prefix matching); without it the landing session resolves\n" +
		"as described below. --name names the window (tmux's own default\n" +
		"otherwise); --cwd sets its start directory (the caller's cwd otherwise).\n\n" +
		"Default session resolution runs in rungs: outside tmux the target\n" +
		"server's current session; inside tmux the caller's own session — unless\n" +
		"the caller sits in a run-kit infrastructure session (_rk-operator and\n" +
		"friends), which never gains a spawned window beside itself. The pick is\n" +
		"then deterministic over the server's user sessions: the sole user\n" +
		"session, else the one rooted at --cwd's main worktree (linked worktrees\n" +
		"resolve through git's common dir, so <repo>.worktrees/<name> matches a\n" +
		"session started at <repo>), else the most-attached one (ties break to\n" +
		"the rk mux sessions row order). With no user session at all the command\n" +
		"fails \"nowhere to spawn\" and creates nothing — pass --session =S to\n" +
		"name one. The deciding rung is reported as the --json \"session_rung\"\n" +
		"key and, on the human path, as a stderr note.\n\n" +
		"A command for the new window follows `--` as argv — never a shell string:\n" +
		"rk single-quotes every token, so each one reaches the process as one\n" +
		"literal word ($(…), spaces, and quotes survive verbatim). Shell expansion\n" +
		"inside the window is opt-in by naming the shell:\n" +
		"  rk tab new --cwd DIR -- sh -c \"<string>\"\n" +
		"The command gets rk's agent-exit fallback appended\n" +
		"(; exec \"${SHELL:-/bin/sh}\") so the pane drops into an interactive shell\n" +
		"when the command exits; --no-shell-fallback omits the tail and lets the\n" +
		"pane die with the command.\n\n" +
		"--json prints {\"session\", \"session_rung\", \"window_id\", \"pane_id\"}\n" +
		"inside the standard {\"ok\",\"result\"} envelope instead of the bare @N —\n" +
		"session is tmux's own report of where the window landed, session_rung\n" +
		"why it was chosen (explicit|caller|server|sole-user|cwd-root|\n" +
		"most-attached). --ready\n" +
		"(requires --json and a `--` command) also waits for the new pane's boot\n" +
		"readiness — the rk mux await --ready classification — and adds the verdict\n" +
		"as the JSON \"ready\" key: ready|parked|narrow|running (exit 0; the parked\n" +
		"screen snippet or the narrow remedy rides stderr) or gone (exit 1, after\n" +
		"the JSON prints). --timeout SECS bounds the wait (default 300,\n" +
		"0 = indefinite).",
	Args:         tabNewArgs,
	SilenceUsage: true,
	RunE:         runTabNew,
}

func init() {
	tabNewCmd.Flags().StringVar(&tabNewSessionFlag, "session", "",
		"Session to create the window in, in the =S exact form (default: the caller's current session; when the caller sits in a run-kit infrastructure session (_rk-*), the sole user session, else the user session rooted at --cwd's main worktree, else the most-attached user session; outside tmux the server's current session)")
	tabNewCmd.Flags().StringVar(&tabNewCwdFlag, "cwd", "",
		"Start directory for the window (default: the caller's cwd)")
	tabNewCmd.Flags().StringVar(&tabNewNameFlag, "name", "",
		"Window name (default: tmux's own)")
	tabNewCmd.Flags().StringVar(&tabNewLayoutFlag, "layout", "",
		"Layout the window is born with, e.g. h(tty,web) (tree grammar; a legacy split-h:tty,web string still parses; validated before creation)")
	tabNewCmd.Flags().BoolVar(&tabNewJSONFlag, "json", false,
		"Print {session, session_rung, window_id, pane_id} as JSON inside the {\"ok\",\"result\"} envelope instead of the bare @N")
	tabNewCmd.Flags().BoolVar(&tabNewReadyFlag, "ready", false,
		"Wait for the new pane's boot readiness (the rk mux await --ready classification) and add the verdict as the JSON \"ready\" key; requires --json and a `--` command")
	tabNewCmd.Flags().IntVar(&tabNewTimeoutFlag, "timeout", awaitDefaultTimeoutSec,
		"Seconds --ready waits before reporting `running` (0 = indefinite); requires --ready")
	tabNewCmd.Flags().BoolVar(&tabNewNoShellFallbackFlag, "no-shell-fallback", false,
		"Omit the `; exec \"${SHELL:-/bin/sh}\"` tail so the pane dies with the command")
}

// tabNewArgs gates positionals to the post-`--` command form: every positional
// is one argv element of the window's command, so a positional without (or
// before) `--` is a usage error naming the form.
func tabNewArgs(cmd *cobra.Command, args []string) error {
	if len(args) > 0 && cmd.ArgsLenAtDash() != 0 {
		return fmt.Errorf("command must follow --, e.g. rk tab new -- claude --model opus")
	}
	return nil
}

// presentCreateWindowIDFn is the window-creation seam (the present.go
// pattern); tabCreateWindowIDFn is the same seam under the tab family's name —
// `rk present --window` creates through it, and tests stub both.
var presentCreateWindowIDFn = func(session, name, cwd, server string, ops []tmux.WindowOptionOp) (string, error) {
	return tmux.CreateWindowWithOptionsID(session, name, cwd, server, ops)
}

var tabCreateWindowIDFn = presentCreateWindowIDFn

// tabNewCreateWindowFn is `rk tab new`'s creation seam (the
// tabCreateWindowIDFn pattern, widened with the shell-command positional and
// the full WindowBirth triple); tests stub it so the command/JSON/ready
// contract runs tmux-free.
var tabNewCreateWindowFn = func(session, name, cwd, server, shellCmd string, ops []tmux.WindowOptionOp) (tmux.WindowBirth, error) {
	return tmux.CreateWindowWithCommandID(session, name, cwd, server, shellCmd, ops)
}

// tabNewSessionFactsFn is the session-enumeration seam behind the role-aware
// default (the muxSessionsFactsFn pattern); the default delegates to
// internal/tmux, and tests stub it to drive the rung ladder tmux-free.
var tabNewSessionFactsFn = func(ctx context.Context, server string) ([]tmux.SessionFacts, error) {
	return tmux.ListSessionFacts(ctx, server)
}

// tabNewServerAliveFn is the empty-enumeration liveness probe (the
// muxSessionsAliveFn pattern): ListSessionFacts degrades a dead socket to
// (nil, nil), so an empty enumeration is liveness-probed to separate "no
// server" (tmux's diagnostic) from "alive, no user session" (nowhere to
// spawn).
var tabNewServerAliveFn = func(ctx context.Context, server string) error {
	return tmux.ServerAlive(ctx, server)
}

// tabNewMainRootFn resolves a directory's main-worktree root for the
// cwd-root rung; "" means "not inside a git repository" and never matches.
var tabNewMainRootFn = func(ctx context.Context, dir string) string {
	return gitinfo.MainWorktreeRoot(ctx, dir)
}

// Session-rung tokens reported as session_rung in the tab new --json document
// — the closed set of reasons a landing session was chosen (toolkit P2: the
// key set is stable, so the token set is too).
const (
	sessionRungExplicit     = "explicit"
	sessionRungServer       = "server"
	sessionRungCaller       = "caller"
	sessionRungSoleUser     = "sole-user"
	sessionRungCwdRoot      = "cwd-root"
	sessionRungMostAttached = "most-attached"
)

// errNowhereToSpawn is pickLandingSession's zero-candidate result; the
// resolver wraps it with the caller's session, the server, and the --session
// remedy before it becomes the operational (exit 1) error.
var errNowhereToSpawn = errors.New("nowhere to spawn")

// roleAwareRung reports whether the rung came from the infrastructure-caller
// ladder — the only decisions the human path annotates on stderr, since the
// ambient defaults (explicit/caller/server) need no explanation.
func roleAwareRung(rung string) bool {
	switch rung {
	case sessionRungSoleUser, sessionRungCwdRoot, sessionRungMostAttached:
		return true
	}
	return false
}

// pickLandingSession applies the role-aware default rule over user-role
// candidates in enumeration order (the `rk mux sessions` row order): the sole
// candidate wins outright; else the first candidate whose main-worktree root
// equals mainRoot ("" never matches — a non-repo side carries no root, and
// linked worktrees live in the sibling <repo>.worktrees/ directory, so only
// the common-dir resolution rootOf performs can tie them); else the
// most-attached candidate with ties broken to the earliest row. Zero
// candidates yield errNowhereToSpawn.
func pickLandingSession(candidates []tmux.SessionFacts, mainRoot string, rootOf func(path string) string) (session, rung string, err error) {
	if len(candidates) == 0 {
		return "", "", errNowhereToSpawn
	}
	if len(candidates) == 1 {
		return candidates[0].Name, sessionRungSoleUser, nil
	}
	if mainRoot != "" {
		for _, c := range candidates {
			if root := rootOf(c.Path); root != "" && root == mainRoot {
				return c.Name, sessionRungCwdRoot, nil
			}
		}
	}
	best := candidates[0]
	for _, c := range candidates[1:] {
		if c.Attached > best.Attached {
			best = c
		}
	}
	return best.Name, sessionRungMostAttached, nil
}

// resolveTabNewSession decides the session a new window lands in and reports
// the deciding rung: an explicit --session (=S exact form, validated) wins
// (explicit); outside tmux the target server's current session (server;
// serverFlag names the server — the serverFlag/derived/default rule, the rk
// mux order). Inside tmux the caller's own session is classified by
// tmux.SessionRole: a user-role caller keeps its own session (caller, the
// ambient default unchanged); an infrastructure caller enters the
// pickLandingSession ladder over the target server's user sessions. cwd feeds
// the cwd-root rung (the window's own start directory, already resolved by
// the caller).
func resolveTabNewSession(ctx context.Context, serverFlag, cwd string) (session, server, rung string, err error) {
	if tabNewSessionFlag != "" {
		if !strings.HasPrefix(tabNewSessionFlag, "=") {
			return "", "", "", usageError(fmt.Errorf("--session takes the =S exact form (got %q)", tabNewSessionFlag))
		}
		name := tabNewSessionFlag[1:]
		if errMsg := validate.ValidateName(name, "Session name"); errMsg != "" {
			return "", "", "", usageError(fmt.Errorf("--session: %s", errMsg))
		}
		session = name
	}

	server = serverFlag
	if server == "" {
		if _, serverName, ok := callerContext(); ok {
			server = serverName
		} else {
			server = "default"
		}
	}

	if session != "" {
		return session, server, sessionRungExplicit, nil
	}
	if pane := os.Getenv("TMUX_PANE"); pane != "" {
		prefix, _, ok := callerContext()
		if !ok {
			return "", "", "", fmt.Errorf("cannot derive this pane's tmux server socket from $TMUX (unset or malformed)")
		}
		caller, derr := ownTabDisplayValue(ctx, prefix, pane, "#{session_name}")
		if derr != nil {
			return "", "", "", fmt.Errorf("resolve target session: %w", derr)
		}
		if tmux.SessionRole(caller) == tmux.SessionRoleUser {
			return caller, server, sessionRungCaller, nil
		}
		facts, ferr := tabNewSessionFactsFn(ctx, server)
		if ferr != nil {
			return "", "", "", fmt.Errorf("resolve target session: list sessions: %w", ferr)
		}
		if len(facts) == 0 {
			if aerr := tabNewServerAliveFn(ctx, server); aerr != nil {
				return "", "", "", fmt.Errorf("resolve target session: list sessions: %w", aerr)
			}
		}
		var candidates []tmux.SessionFacts
		for _, f := range facts {
			if f.Role == tmux.SessionRoleUser {
				candidates = append(candidates, f)
			}
		}
		session, rung, err = pickLandingSession(candidates, tabNewMainRootFn(ctx, cwd),
			func(path string) string { return tabNewMainRootFn(ctx, path) })
		if err != nil {
			return "", "", "", fmt.Errorf("resolve target session: %w — the caller's session %q is run-kit infrastructure and server %q has no user session; pass --session =S to name one", err, caller, server)
		}
		return session, server, rung, nil
	}
	args := []string{"display-message", "-p", "#{session_name}"}
	if server != "default" {
		args = append([]string{"-L", server}, args...)
	}
	ctx, cancel := context.WithTimeout(ctx, ownTabTimeout)
	defer cancel()
	out, rerr := ownTabRunOutputFn(ctx, args)
	if rerr != nil {
		return "", "", "", fmt.Errorf("resolve target session: %w", rerr)
	}
	session = strings.TrimSpace(string(out))
	if session == "" {
		return "", "", "", fmt.Errorf("resolve target session: empty response from tmux")
	}
	return session, server, sessionRungServer, nil
}

// validateTabNewFlagRules enforces the flag-combination contract before any
// window is created: --ready reports through --json and needs a command to
// boot; --timeout bounds only a --ready wait; --no-shell-fallback only makes
// sense with a command.
func validateTabNewFlagRules(cmd *cobra.Command, hasCommand bool) error {
	if cmd.Flags().Changed("timeout") && !tabNewReadyFlag {
		return usageError(fmt.Errorf("--timeout requires --ready"))
	}
	if tabNewReadyFlag && !tabNewJSONFlag {
		return usageError(fmt.Errorf("--ready reports through --json; add --json or drop --ready"))
	}
	if tabNewReadyFlag && !hasCommand {
		return usageError(fmt.Errorf("--ready needs a command after --"))
	}
	if tabNewNoShellFallbackFlag && !hasCommand {
		return usageError(fmt.Errorf("--no-shell-fallback needs a command after --"))
	}
	if tabNewReadyFlag && tabNewTimeoutFlag < 0 {
		return usageError(fmt.Errorf("--timeout must be >= 0 (0 = indefinite)"))
	}
	return nil
}

// tabNewBirthJSON is the --json envelope; Ready rides only with --ready
// (omitempty — the key set is stable otherwise, the toolkit P2 schema rule).
// SessionRung is always present: session says WHERE the window landed
// (tmux's own report), session_rung WHY that session was chosen.
type tabNewBirthJSON struct {
	Session     string `json:"session"`
	SessionRung string `json:"session_rung"`
	WindowID    string `json:"window_id"`
	PaneID      string `json:"pane_id"`
	Ready       string `json:"ready,omitempty"`
}

func runTabNew(cmd *cobra.Command, args []string) error {
	ctx := tabContext(cmd)

	if err := validateTabNewFlagRules(cmd, len(args) > 0); err != nil {
		return err
	}

	var ops []tmux.WindowOptionOp
	if tabNewLayoutFlag != "" {
		parsed, err := layoutspec.Parse(tabNewLayoutFlag)
		if err != nil {
			return usageError(fmt.Errorf("--layout: %w", err))
		}
		// Writers emit the tree form only: a legacy preset string is stored
		// canonicalized (the rk tab layout rule), never verbatim.
		v := parsed.String()
		ops = append(ops, tmux.WindowOptionOp{Key: tmux.LayoutOption, Value: &v})
	}

	name := tabNewNameFlag
	if name != "" {
		if errMsg := validate.ValidateNewName(name, "Window name"); errMsg != "" {
			return usageError(fmt.Errorf("--name: %s", errMsg))
		}
	}

	// The tmux shell-command positional is composed ONLY from rk-quoted argv
	// tokens plus rk's fixed fallback literal (constitution §I) — the window's
	// shell receives every token as one literal word.
	shellCmd := ""
	if len(args) > 0 {
		shellCmd = shellq.QuoteArgv(args)
		if !tabNewNoShellFallbackFlag {
			shellCmd = shellq.WithShellFallback(shellCmd)
		}
	}

	cwd := tabNewCwdFlag
	if cwd == "" {
		var err error
		cwd, err = os.Getwd()
		if err != nil {
			return fmt.Errorf("resolve working directory: %w", err)
		}
	}

	session, server, rung, err := resolveTabNewSession(ctx, tabServerFlag, cwd)
	if err != nil {
		return err
	}

	birth, err := tabNewCreateWindowFn(session, name, cwd, server, shellCmd, ops)
	if err != nil {
		return fmt.Errorf("create window: %w", err)
	}
	// The wake fires after creation — before any --ready wait — so dashboards
	// repaint while the agent boots.
	tabWakeFn(ctx, server)

	sink := newSink(cmd)
	if !tabNewJSONFlag {
		sink.Dataf("%s\n", birth.WindowID)
		if roleAwareRung(rung) {
			sink.Notef("session: %s (%s)\n", birth.Session, rung)
		}
		return nil
	}

	out := tabNewBirthJSON{Session: birth.Session, SessionRung: rung, WindowID: birth.WindowID, PaneID: birth.PaneID}
	var reportErr error
	if tabNewReadyFlag {
		// The wait rides the command's parent context (never the creation
		// timeout): it may legitimately run for the full --timeout.
		readiness, rerr := muxAwaitReadyFn(ctx, server, birth.PaneID, time.Duration(tabNewTimeoutFlag)*time.Second)
		rep, rerr := mapReadyReport(birth.PaneID, readiness, rerr)
		if rerr != nil {
			return rerr
		}
		if rep.diag != "" {
			fmt.Fprint(cmd.ErrOrStderr(), rep.diag)
		}
		out.Ready = strings.Fields(rep.line)[0]
		reportErr = rep.reportErr
	}
	// gone exits 1, but only after the JSON is printed — the envelope is the
	// caller's record of what was created before the pane died.
	return sink.Envelope(out, reportErr)
}
