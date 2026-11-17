package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"rk/internal/tmux"
	"rk/internal/validate"

	"github.com/spf13/cobra"
)

// rk role <operator|clear> — set or clear the @rk_win_role window option on the
// CURRENT window (derived from $TMUX_PANE), marking it as the tmux server's
// operator (the orchestrator window the sidebar pins below the SESSIONS
// header) or clearing that marking. "operator" is a server-scoped radio:
// setting it clears @rk_win_role from every other window on the server (the shared
// tmux.ClearWindowRoleExcept helper — the same enforcement the window-options
// POST handler applies; never trusted to clients).
//
// The primary consumer is an agent marking itself (an operator chat skill's
// fail-silent `rk role operator` self-mark) — the fail-silent contract
// belongs to the CALLER, so this command hard-errors
// outside tmux — and equally when $TMUX yields no socket to target: an
// explicitly typed command that no-ops silently, or writes to a guessed server,
// would be confusing (unlike `rk agent hook`, which harness hooks invoke
// unconditionally and which may degrade to the default socket).
//
// Toolkit Principle 9 posture: the confirmation is data on stdout; errors flow
// through RunE to stderr with a non-zero exit.

// roleCmdTimeout bounds every tmux subprocess the command spawns
// (Constitution §I: 5-10s for short-lived tmux helpers).
const roleCmdTimeout = 5 * time.Second

var roleCmd = &cobra.Command{
	Use:   "role <operator|clear>",
	Short: "Mark or unmark the current window as the server's operator",
	Long: "Set or clear the @rk_win_role tmux window option on the current window " +
		"(derived from $TMUX_PANE). `operator` marks the window as the server's " +
		"operator — clearing the role from every other window on the server — " +
		"and the sidebar pins its row below the SESSIONS header. `clear` " +
		"unmarks it. Exits non-zero when not inside a tmux pane.",
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		return runRole(cmd, args[0])
	},
}

// roleRunFn / roleRunOutputFn are package-level seams so runRole can be tested
// without a live tmux server; the defaults delegate to the internal/tmux Run
// core (exec.CommandContext, argv slices — Constitution §I).
var (
	roleRunFn       = func(ctx context.Context, args []string) error { return tmux.Run(ctx, args, tmux.RunOpts{}) }
	roleRunOutputFn = func(ctx context.Context, args []string) ([]byte, error) {
		return tmux.RunOutput(ctx, args, tmux.RunOpts{})
	}
	// roleOriginalTMUXFn is the $TMUX seam: internal/tmux's init() strips $TMUX
	// from the process, so the captured OriginalTMUX is fixed at package-init
	// time and cannot be varied with t.Setenv.
	roleOriginalTMUXFn = func() string { return tmux.OriginalTMUX }
	// roleClearExceptFn is the radio-clear seam (the server-scoped
	// one-operator rule, shared with the window-options POST handler).
	roleClearExceptFn = func(ctx context.Context, prefix []string, keepWindowID string) ([]string, error) {
		return tmux.ClearWindowRoleExcept(ctx, prefix, keepWindowID)
	}
	// roleMoveInFn / roleDemoteFn are the physical-promotion seams, shared with
	// the window-options POST handler: role-set moves the window into the
	// per-server operator session; role-clear moves a member back out.
	roleMoveInFn = func(ctx context.Context, prefix []string, windowID string) error {
		return tmux.MoveWindowIntoOperatorSession(ctx, prefix, windowID)
	}
	roleDemoteFn = func(ctx context.Context, prefix []string, windowID string) error {
		return tmux.DemoteWindowFromOperatorSession(ctx, prefix, windowID)
	}
)

// roleActions maps the CLI token to the @rk_win_role value it writes ("" = unset).
var roleActions = map[string]string{
	"operator": "operator",
	"clear":    "",
}

// runRole is the testable core: guard on $TMUX_PANE, resolve the token to a
// validated role value, then apply it to the current window (with the radio
// clear on set). Every tmux call runs under one bounded context.
func runRole(cmd *cobra.Command, token string) error {
	value, ok := roleActions[token]
	if !ok {
		return fmt.Errorf("unknown role action %q: want operator|clear", token)
	}
	// Validate the value before any tmux call (R1) — by construction here, but
	// the closed set is the single rule every writer routes through.
	if errMsg := validate.ValidateRoleValue(value); errMsg != "" {
		return fmt.Errorf("%s", errMsg)
	}

	pane := os.Getenv("TMUX_PANE")
	if pane == "" {
		return fmt.Errorf("not inside a tmux pane ($TMUX_PANE is unset)")
	}

	parent := cmd.Context()
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, roleCmdTimeout)
	defer cancel()

	// Target the pane's OWN server via -S <socket> derived from the original
	// $TMUX (internal/tmux's init() strips $TMUX from the process — see
	// writeAgentStateImpl for the full rationale), never a bare invocation.
	// agent hook's never-fail contract lets it degrade to the default socket
	// here; this command must NOT: a bare invocation would resolve $TMUX_PANE
	// against — and radio-clear @rk_win_role across — whichever server owns the
	// default socket (spawning one if it is dead). $TMUX_PANE without $TMUX is
	// exactly the `tmux run-shell` shape, so the pane guard above does not cover
	// it; refuse instead of guessing a server.
	prefix := tmuxSocketArgs(roleOriginalTMUXFn())
	if len(prefix) == 0 {
		return fmt.Errorf("cannot derive this pane's tmux server socket from $TMUX (unset or malformed) — refusing to target the default server")
	}

	out, err := roleRunOutputFn(ctx, append(prefix, "display-message", "-pt", pane, "#{window_id}"))
	if err != nil {
		return fmt.Errorf("resolve current window: %w", err)
	}
	windowID := strings.TrimSpace(string(out))
	if errMsg := validate.ValidateWindowID(windowID, "Window ID"); errMsg != "" {
		return fmt.Errorf("resolve current window: %s", errMsg)
	}

	if value != "" {
		if err := stampOperatorRole(ctx, prefix, windowID); err != nil {
			return err
		}
	} else {
		if err := roleRunFn(ctx, append(prefix, "set-option", "-wu", "-t", windowID, tmux.RoleOption)); err != nil {
			return fmt.Errorf("unset %s: %w", tmux.RoleOption, err)
		}
		// Demote: a member of the operator session moves out to its
		// cwd-basename session; a non-member is a plain unset (no-op move).
		if err := roleDemoteFn(ctx, prefix, windowID); err != nil {
			return fmt.Errorf("demote from operator session: %w", err)
		}
	}

	sink := newSink(cmd)
	if value != "" {
		sink.Dataf("%s role=%s\n", windowID, value)
	} else {
		sink.Dataf("%s role cleared\n", windowID)
	}
	return nil
}

// stampOperatorRole applies the full operator write-path to windowID — the
// sequence `rk role operator` and `rk operator`'s create path share:
// server-scoped radio clear (the role is cleared from every other window
// first), the option write, then the physical promotion. Option write before
// the physical moves (option-write-first): a mid-sequence failure degrades to
// the cosmetic-only state (role set, window unmoved) — never a
// moved-but-roleless stray. Demote displaced carriers out of the operator
// session before moving the new operator in — an emptied operator session dies
// with its last window, and ensure-before-move recreates it.
func stampOperatorRole(ctx context.Context, prefix []string, windowID string) error {
	displaced, err := roleClearExceptFn(ctx, prefix, windowID)
	if err != nil {
		return fmt.Errorf("clear prior operator: %w", err)
	}
	if err := roleRunFn(ctx, append(prefix, "set-option", "-w", "-t", windowID, tmux.RoleOption, roleActions["operator"])); err != nil {
		return fmt.Errorf("set %s: %w", tmux.RoleOption, err)
	}
	for _, id := range displaced {
		if err := roleDemoteFn(ctx, prefix, id); err != nil {
			return fmt.Errorf("demote prior operator: %w", err)
		}
	}
	if err := roleMoveInFn(ctx, prefix, windowID); err != nil {
		return fmt.Errorf("move into operator session: %w", err)
	}
	return nil
}
