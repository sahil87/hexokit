package tmux

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"
)

// EnsureIsoSession returns the name of the window's single-window isolated
// relay session `_rk-iso-<id>`, creating it when absent. An `open` op with
// `isolate: true` attaches through this session so the stream gets an
// active-window pointer independent of the home session's (two streams showing
// sibling windows of one session would otherwise fight over home's single
// pointer). Creation follows Pin's shape (board.go) minus the board stamps:
// detached new-session anchored at ServerBirthDir, the placeholder window
// captured by id (never assumed index 0), the target LINKED in (it stays a
// member of its home session — dual membership), the placeholder killed.
//
// Idempotent: when the iso session already exists its name is returned
// unchanged — a second isolated viewer of the same window SHARES the session
// (the name is keyed by window id). A `duplicate session` failure from
// new-session means a concurrent ensure won the race and is treated as success
// once the target window re-probes as linked into the session.
//
// Existence is not completion: both race paths above can observe the winner's
// placeholder-only session between its new-session and link-window, so both
// wait (bounded by the ensure's ctx) for the target window to link before
// returning, and fail closed when it never does.
//
// destroy-unattached is deliberately NOT set here: on tmux 3.7c setting it on
// a never-attached session destroys the session immediately. The relay's
// attach argv chains it instead (api/terminals_ws.go), so tmux reaps the
// session when its last client leaves.
//
// Security (Constitution §I): windowID is validated before any subprocess;
// every tmux call is ctx+timeout-scoped via the package exec helpers with
// explicit argument slices (no shell strings).
func EnsureIsoSession(ctx context.Context, server, windowID string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()
	if !ValidWindowID(windowID) {
		return "", fmt.Errorf("invalid window id")
	}
	isoSession, ok := IsoSessionName(windowID)
	if !ok {
		return "", fmt.Errorf("invalid window id")
	}

	// Idempotent reuse: the iso session already exists → return it once the
	// target window provably belongs to it (a concurrent ensure may still be
	// between its new-session and link-window; waitIsoWindowLinked rides out
	// that window).
	if _, err := tmuxExecRawServer(ctx, server, "has-session", "-t", ExactSessionTarget(isoSession)); err == nil {
		if waitIsoWindowLinked(ctx, server, isoSession, windowID) {
			return isoSession, nil
		}
		return "", fmt.Errorf("iso session %q exists but window %q is not linked", isoSession, windowID)
	}

	// Create the iso session (starts with one placeholder window). `-c
	// ServerBirthDir()` anchors session_path to the operator's home (fallback
	// "/") so it never dangles — the same hygiene as Pin.
	if _, err := tmuxExecServer(ctx, server, "new-session", "-d", "-s", isoSession, "-c", ServerBirthDir()); err != nil {
		// A concurrent ensure can win the race between the has-session probe
		// above and this new-session; tmux then reports "duplicate session".
		// That race outcome is success once the winner has linked the target
		// window in — returning on presence alone could hand the relay a
		// placeholder-only session.
		if strings.Contains(err.Error(), "duplicate session") {
			if waitIsoWindowLinked(ctx, server, isoSession, windowID) {
				return isoSession, nil
			}
		}
		return "", fmt.Errorf("create iso session: %w", err)
	}

	// Capture the placeholder window's id so it can be killed after the link,
	// leaving the linked window as the session's sole window. Capturing the id
	// (rather than assuming index 0) is robust to base-index config and to the
	// linked window's landing index.
	placeholderLines, err := tmuxExecServer(ctx, server, "list-windows", "-t", ExactSessionTarget(isoSession), "-F", "#{window_id}")
	if err != nil || len(placeholderLines) == 0 {
		// Roll back the empty iso session. Root the teardown in
		// context.Background(): the caller's ctx may already be at/near its
		// deadline, and KillSessionCtx wraps the passed ctx with WithTimeout —
		// a cancelled parent would make the kill a no-op and orphan the
		// session (Pin's rollback pattern).
		_ = KillSessionCtx(context.Background(), server, isoSession)
		if err != nil {
			return "", fmt.Errorf("read iso placeholder window: %w", err)
		}
		return "", fmt.Errorf("read iso placeholder window: iso session %q reported no windows", isoSession)
	}
	placeholderID := strings.TrimSpace(placeholderLines[0])

	// Link the window in. A link failure strands nothing (the window stays
	// home) — roll back the windowless iso session. A missing window maps to
	// ResolveWindowSession's `window %q not found` contract so the relay can
	// tell 4004 (window gone) from 4001 (attach-class failure).
	if err := LinkWindowToSession(windowID, isoSession, server); err != nil {
		_ = KillSessionCtx(context.Background(), server, isoSession)
		if isMissingWindowErr(err) {
			return "", fmt.Errorf("window %q not found", windowID)
		}
		return "", fmt.Errorf("link window into iso session: %w", err)
	}
	if _, err := tmuxExecServer(ctx, server, "kill-window", "-t", placeholderID); err != nil {
		// Non-fatal: a stray placeholder is cosmetic — the iso session is
		// already valid (window linked). Logged loudly, as Pin does.
		slog.Warn("iso: placeholder kill failed", "server", server, "iso", isoSession, "placeholder", placeholderID, "err", err)
	}
	return isoSession, nil
}

// SessionClientCount returns how many clients are currently attached to the
// named session. The relay's iso attach-failure rollback uses it to kill a
// freshly ensured iso session ONLY when no other isolated viewer has attached
// to it — a shared session must never be killed out from under another
// stream. Unlike ListClients (which feeds size arbitration and drops unsized
// or control-mode clients), this counts every attached client: the rollback
// question is "does ANY viewer hold this session", not "who arbitrates size".
// A missing session reports zero clients (the rollback target may already be
// gone — kill-session on it is then a tolerated no-op at the caller).
func SessionClientCount(ctx context.Context, server, session string) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	lines, err := tmuxExecServer(ctx, server, "list-clients", "-t", ExactSessionTarget(session), "-F", "#{client_pid}")
	if err != nil {
		// list-clients on a dead/absent session errors ("can't find session");
		// that is zero attached clients for rollback purposes, not a failure.
		if strings.Contains(err.Error(), "can't find session") {
			return 0, nil
		}
		return 0, err
	}
	return len(lines), nil
}

// isoLinkPollInterval paces the link probes while a concurrent ensure finishes
// linking the target window into a freshly created placeholder-only session.
const isoLinkPollInterval = 20 * time.Millisecond

// isoWindowLinked reports whether windowID is currently a member of the iso
// session — the completion marker for an in-flight concurrent ensure.
func isoWindowLinked(ctx context.Context, server, isoSession, windowID string) bool {
	lines, err := tmuxExecServer(ctx, server, "list-windows", "-t", ExactSessionTarget(isoSession), "-F", "#{window_id}")
	if err != nil {
		return false
	}
	for _, line := range lines {
		if strings.TrimSpace(line) == windowID {
			return true
		}
	}
	return false
}

// waitIsoWindowLinked polls until the target window is linked into the iso
// session or ctx expires (the ensure's TmuxTimeout bounds the wait). False
// means no concurrent winner completed — the caller fails closed.
func waitIsoWindowLinked(ctx context.Context, server, isoSession, windowID string) bool {
	for {
		if isoWindowLinked(ctx, server, isoSession, windowID) {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(isoLinkPollInterval):
		}
	}
}
