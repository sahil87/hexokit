package tmux

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"rk/internal/validate"
)

// pane_target.go — the pane-level primitives the `rk mux` pane-scoped verbs
// (send/await/capture/kill/process) need: strict target-form parsing,
// single-pane agent-state and fact reads (the same parse + pid-liveness
// reconcile the sessions path applies), pane liveness, raw key-name sends, and
// window→agent-pane resolution. Every subprocess runs under the CALLER's
// context via the tmuxExec* helpers (exec.CommandContext argv slices —
// Constitution §I).

// paneIDPattern matches tmux pane IDs: %N.
var paneIDPattern = regexp.MustCompile(`^%[0-9]+$`)

// ValidPaneID reports whether id is a well-formed tmux pane ID (%N).
func ValidPaneID(id string) bool {
	return paneIDPattern.MatchString(id)
}

// PaneTarget is a parsed mux-verb target: exactly one field is set. PaneID is
// a direct pane target (%N); WindowTarget is a window form (@N or
// =session:window) the caller resolves to the window's agent pane via
// ResolveAgentPane.
type PaneTarget struct {
	PaneID       string
	WindowTarget string
}

// ParsePaneTarget parses a mux-verb target, accepting EXACTLY three forms —
// pane ID (%N), window ID (@N), and exact session:window (=session:window) —
// and rejecting everything else. Bare session:window names are rejected on
// purpose: tmux's target grammar resolves a bare name against window names
// before session names, so a window named like a session hijacks the target
// (the documented ExactSessionTarget footgun) — the `=` prefix forces
// exact-match parsing. The returned WindowTarget for the `=` form is passed to
// tmux verbatim (the leading `=` disables prefix/fnmatch matching).
func ParsePaneTarget(s string) (PaneTarget, error) {
	switch {
	case ValidPaneID(s):
		return PaneTarget{PaneID: s}, nil
	case ValidWindowID(s):
		return PaneTarget{WindowTarget: s}, nil
	case strings.HasPrefix(s, "="):
		rest := s[1:]
		i := strings.IndexByte(rest, ':')
		if i <= 0 || i == len(rest)-1 {
			return PaneTarget{}, badPaneTarget(s)
		}
		session, window := rest[:i], rest[i+1:]
		if errMsg := validate.ValidateName(session, "Session name"); errMsg != "" {
			return PaneTarget{}, badPaneTarget(s)
		}
		// The window part may be a name or a numeric index; a second colon
		// would make the target ambiguous (session:window:pane grammar), so
		// reject it.
		if strings.ContainsAny(window, ": \t") {
			return PaneTarget{}, badPaneTarget(s)
		}
		return PaneTarget{WindowTarget: s}, nil
	default:
		return PaneTarget{}, badPaneTarget(s)
	}
}

func badPaneTarget(s string) error {
	return fmt.Errorf("invalid target %q: want a pane ID (%%N), a window ID (@N), or an exact session:window (=session:window)", s)
}

// PaneAgentState reads ONE pane's reconciled agent-state option on the given
// server: the raw value (dual-read @rk_pane_agent_state then @rk_agent_state)
// is parsed via parseAgentState and then reconciled
// exactly as the sessions path does — a pid-carrying value is
// trusted iff the agent process is alive (kill-0 liveness); a legacy
// two-segment value falls back to the shell-command heuristic (a plain-shell
// pane has no agent). Codex waiting is checked against its runtime and questions.
// Returns "" (unknown) for an absent, unparseable, or
// reconciled-away value — never partial trust. A tmux failure (e.g. the pane
// does not exist) is returned as the error.
func PaneAgentState(ctx context.Context, paneID, server string) (string, error) {
	facts, err := PaneFactsCtx(ctx, paneID, server)
	return facts.AgentState, err
}

// PaneFacts is a single pane's substrate fact bundle, read in one
// display-message round trip by PaneFactsCtx. AgentState/AgentStateEpoch/
// AgentPID carry the reconciled agent-state read (AgentState "" = unknown:
// absent, unparseable, or reconciled away); AgentPID is the live agent pid a
// 3-segment value carried (0 when the value carried none — the pid is never
// reported for a reconciled-away state). Command is the pane's foreground
// command (#{pane_current_command}), populated regardless of the agent-state
// outcome so unknown-state callers can name what is actually running.
type PaneFacts struct {
	CWD             string
	Command         string
	AgentState      string
	AgentStateEpoch int64
	AgentPID        int
	AgentProvider   string
	AgentSessionRef string
}

// PaneFactsCtx reads ONE pane's substrate facts on the given server in a single
// display-message round trip: the pane cwd (#{pane_current_path}), the
// foreground command (#{pane_current_command}), plus the reconciled agent-state
// read (the same parse + pid-liveness/shell-command reconcile the sessions path
// applies — shared with PaneAgentState, which this superset read backs). Both
// option names are requested and the scope-named one wins when non-empty
// (dual-read window). A tmux failure (e.g. the pane does not exist) is returned
// as the error.
func PaneFactsCtx(ctx context.Context, paneID, server string) (PaneFacts, error) {
	raw, err := tmuxExecRawServer(ctx, server, "display-message", "-pt", paneID,
		"#{pane_current_path}\t#{pane_current_command}\t#{"+LegacyAgentStateOption+"}\t#{"+AgentStateOption+"}\t#{"+LegacyAgentSessionOption+"}\t#{"+AgentSessionOption+"}")
	if err != nil {
		return PaneFacts{}, err
	}
	facts := parsePaneFacts(raw)
	panes := []PaneInfo{{AgentState: facts.AgentState, AgentStateEpoch: facts.AgentStateEpoch, AgentProvider: facts.AgentProvider, AgentSessionRef: facts.AgentSessionRef}}
	reconcileCodexWaiting(ctx, panes)
	facts.AgentState = panes[0].AgentState
	facts.AgentStateEpoch = panes[0].AgentStateEpoch
	return facts, nil
}

// parsePaneFacts parses cwd, command, legacy/current state, and legacy/current
// session identity. Each scope-named option wins when non-empty; older reads
// without identity fields remain valid. Only the trailing newline is trimmed
// before the split — TrimSpace on the whole raw string would eat the tabs
// delimiting an empty first or last field and shift the remaining fields into
// the wrong slots; the per-field trim below is safe because it runs after the
// split.
func parsePaneFacts(raw string) PaneFacts {
	var facts PaneFacts
	parts := strings.SplitN(strings.TrimRight(raw, "\r\n"), "\t", 6)
	facts.CWD = parts[0]
	command, stateRaw := "", ""
	if len(parts) >= 2 {
		command = parts[1]
	}
	facts.Command = command
	if len(parts) >= 4 {
		stateRaw = strings.TrimSpace(parts[3])
	}
	if stateRaw == "" && len(parts) >= 3 {
		stateRaw = strings.TrimSpace(parts[2])
	}
	state, epoch, pid := parseAgentState(stateRaw)
	if state == "" {
		return facts
	}
	// The same reconcile the sessions path applies (parsePanes) — one shared
	// decision, never a divergent copy.
	if agentStateStale(pid, command) {
		return facts
	}
	facts.AgentState, facts.AgentStateEpoch, facts.AgentPID = state, epoch, pid
	sessionRaw := ""
	if len(parts) == 6 {
		sessionRaw = strings.TrimSpace(parts[5])
	}
	if sessionRaw == "" && len(parts) >= 5 {
		sessionRaw = strings.TrimSpace(parts[4])
	}
	facts.AgentProvider, facts.AgentSessionRef = parseAgentSessionRef(sessionRaw)
	return facts
}

// PanePIDCtx reads the pane's shell PID (#{pane_pid}) on the given server,
// bounded by the caller's context — the process-tree root `rk mux process`
// walks from.
func PanePIDCtx(ctx context.Context, paneID, server string) (int, error) {
	raw, err := tmuxExecRawServer(ctx, server, "display-message", "-pt", paneID, "#{pane_pid}")
	if err != nil {
		return 0, err
	}
	pid, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return 0, fmt.Errorf("parsing pane_pid %q: %w", strings.TrimSpace(raw), err)
	}
	return pid, nil
}

// PaneSizeCtx reads the pane's current geometry (#{pane_width} x
// #{pane_height}) on the given server, bounded by the caller's context — one
// display-message round trip, the PanePIDCtx pattern. A tmux failure (e.g.
// the pane does not exist) is returned as the error; an unparseable or
// non-positive dimension is an error too (tmux always reports positive sizes
// for a live pane, and a missing pane's display-message succeeds with EMPTY
// output — the parse failure is what surfaces the operational error).
func PaneSizeCtx(ctx context.Context, paneID, server string) (width, height int, err error) {
	raw, err := tmuxExecRawServer(ctx, server, "display-message", "-pt", paneID, "#{pane_width}\t#{pane_height}")
	if err != nil {
		return 0, 0, err
	}
	return parsePaneSize(raw)
}

// parsePaneSize parses the width\theight pair read by PaneSizeCtx — only the
// trailing newline is trimmed, never the delimiting tab (the parsePaneFacts
// rule). A live pane always reports positive dimensions, so zero, negative,
// or unparseable values are errors.
func parsePaneSize(raw string) (int, int, error) {
	trimmed := strings.TrimRight(raw, "\r\n")
	parts := strings.SplitN(trimmed, "\t", 2)
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("parsing pane geometry %q: want WIDTH\\tHEIGHT", trimmed)
	}
	width, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, fmt.Errorf("parsing pane_width %q: %w", parts[0], err)
	}
	height, err := strconv.Atoi(parts[1])
	if err != nil {
		return 0, 0, fmt.Errorf("parsing pane_height %q: %w", parts[1], err)
	}
	if width <= 0 || height <= 0 {
		return 0, 0, fmt.Errorf("parsing pane geometry %q: dimensions must be positive", trimmed)
	}
	return width, height, nil
}

// PaneExists reports whether the given pane ID is live on the server. A tmux
// "can't find pane" diagnostic is the false case; any other failure is a real
// error (dead server, malformed target).
func PaneExists(ctx context.Context, paneID, server string) (bool, error) {
	_, err := tmuxExecRawServer(ctx, server, "display-message", "-pt", paneID, "#{pane_id}")
	if err != nil {
		if strings.Contains(err.Error(), "can't find pane") {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// PaneInModeCtx reports whether the pane is in a tmux mode (copy-mode et al.)
// by reading #{pane_in_mode}. Bounded by the caller's context. A missing pane
// surfaces as an error: tmux's display-message succeeds with EMPTY output for
// one, and the unparseable read is the operational failure.
func PaneInModeCtx(ctx context.Context, paneID, server string) (bool, error) {
	raw, err := tmuxExecRawServer(ctx, server, "display-message", "-pt", paneID, "#{pane_in_mode}")
	if err != nil {
		return false, err
	}
	inMode, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return false, fmt.Errorf("parsing pane_in_mode %q: %w", strings.TrimSpace(raw), err)
	}
	return inMode != 0, nil
}

// CancelPaneModeCtx exits the pane's active tmux mode via `send-keys -X
// cancel`. -X is a send-keys FLAG, not a key name — SendKeysToPane(keys...)
// cannot express it, so this is its own primitive. Bounded by the caller's
// context.
func CancelPaneModeCtx(ctx context.Context, paneID, server string) error {
	_, err := tmuxExecServer(ctx, server, "send-keys", "-t", paneID, "-X", "cancel")
	return err
}

// ClearPaneModeCtx is the single pane-mode guard decision every rk delivery
// path routes through (directly or via the inject.Tmux seam): probe, and
// cancel only when the pane is in a mode — a pane not in a mode issues NO
// send-keys subprocess (a bare cancel against a modeless pane is itself a tmux
// error). One cancel, no re-probe loop: a pane re-entering a mode
// mid-delivery is tmux's inherent race, accepted like the cross-process paste
// race. A probe or cancel failure is returned wrapped — never fail-open into a
// blind delivery.
func ClearPaneModeCtx(ctx context.Context, paneID, server string) error {
	inMode, err := PaneInModeCtx(ctx, paneID, server)
	if err != nil {
		return fmt.Errorf("probe pane mode: %w", err)
	}
	if !inMode {
		return nil
	}
	if err := CancelPaneModeCtx(ctx, paneID, server); err != nil {
		return fmt.Errorf("cancel pane mode: %w", err)
	}
	return nil
}

// SendKeysToPane sends raw tmux KEY NAMES (Enter, Up, C-c, …) to the target
// pane — no literal flag, no bracketed paste: this is the key-name arm for
// callers that mean keys, not text. Bounded by the caller's context.
func SendKeysToPane(ctx context.Context, paneID, server string, keys ...string) error {
	args := append([]string{"send-keys", "-t", paneID}, keys...)
	_, err := tmuxExecServer(ctx, server, args...)
	return err
}

// WindowIDForPane resolves the id of the window a pane belongs to via
// `display-message -p -t <pane> '#{window_id}'`. The pane id is validated
// before the subprocess runs and the returned id before it is handed back —
// both are the closed %N/@N grammars. Bounded to the 5s short-tmux tier on top
// of the caller's context.
func WindowIDForPane(ctx context.Context, paneID, server string) (string, error) {
	if !ValidPaneID(paneID) {
		return "", fmt.Errorf("invalid pane id %q (want %%N)", paneID)
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	raw, err := tmuxExecRawServer(ctx, server, "display-message", "-p", "-t", paneID, "#{window_id}")
	if err != nil {
		return "", err
	}
	id := strings.TrimSpace(raw)
	if !ValidWindowID(id) {
		return "", fmt.Errorf("unexpected window id %q for pane %s", id, paneID)
	}
	return id, nil
}

// ResolveAgentPane resolves a WINDOW target (@N or =session:window) to the
// window's agent pane: the pane carrying a known (post-reconcile)
// @rk_agent_state, preferring the active pane when several qualify and falling
// back to the window's active pane when none does (the sessions.ResolveAgentPane
// precedent — a window target must route to the agent pane, not whatever split
// happens to be active). An unknown window target is a tmux error.
func ResolveAgentPane(ctx context.Context, windowTarget, server string) (string, error) {
	lines, err := tmuxExecServer(ctx, server, "list-panes", "-t", windowTarget, "-F", paneFormat)
	if err != nil {
		return "", err
	}
	var panes []PaneInfo
	for _, p := range parsePanes(lines) {
		panes = p // exactly one window's worth
		break
	}
	if len(panes) == 0 {
		return "", fmt.Errorf("no panes found for window target %q", windowTarget)
	}
	return SelectAgentPane(panes), nil
}

// SelectAgentPane is the pure selection rule behind ResolveAgentPane: the
// active pane when it carries a known agent state, else the first
// state-carrying pane, else the active pane (the agent-pane fallback), else
// the first pane. Returns "" for an empty pane list.
func SelectAgentPane(panes []PaneInfo) string {
	var activeID, firstStateID string
	for _, p := range panes {
		if p.IsActive {
			activeID = p.PaneID
			if p.AgentState != "" {
				return p.PaneID
			}
		}
		if firstStateID == "" && p.AgentState != "" {
			firstStateID = p.PaneID
		}
	}
	if firstStateID != "" {
		return firstStateID
	}
	if activeID != "" {
		return activeID
	}
	return panes[0].PaneID
}
