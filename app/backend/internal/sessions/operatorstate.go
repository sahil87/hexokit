package sessions

import (
	"context"
	"os"

	"rk/internal/cron"
	"rk/internal/operator"
)

// operatorstate.go — which operator state file the display reads use. rk's own
// file (operator.StatePath) is the source as soon as it exists on disk, even
// when empty or corrupt; fab's file (cron.FabOperatorStatePath) is read only
// while no rk file exists. Existence alone is the switch: after adopt, rk's
// file is the ledger, so a corrupt or empty one must never fall back to fab's
// frozen copy. Read-only — nothing here creates, locks, converts or writes
// either file. internal/cron cannot hold this because internal/operator
// imports it.

// resolveOperatorStatePath picks the file for one server's socket path ("" =
// the socket-path query failed; both candidates then use the "default" slug).
// ok is false when neither path resolves.
func resolveOperatorStatePath(socketPath string) (path string, ok bool) {
	if rkPath, err := operator.StatePath(socketPath); err == nil {
		if _, statErr := os.Stat(rkPath); statErr == nil {
			return rkPath, true
		}
	}
	fabPath, err := cron.FabOperatorStatePath(cron.FabOperatorSlug(socketPath))
	if err != nil {
		return "", false
	}
	return fabPath, true
}

// ReadOperatorState is the one tolerant read behind the sessions payload and
// the notes route: absent or corrupt ⇒ (zero, false).
func ReadOperatorState(socketPath string) (cron.OperatorState, bool) {
	path, ok := resolveOperatorStatePath(socketPath)
	if !ok {
		return cron.OperatorState{}, false
	}
	return cron.ReadOperatorState(path)
}

// ReadOperatorStateForServer reads the operator state of the named tmux
// server through the same source selection FetchSessions uses.
func ReadOperatorStateForServer(ctx context.Context, server string) (cron.OperatorState, bool) {
	sock, err := socketPathFn(ctx, server)
	if err != nil {
		sock = ""
	}
	return ReadOperatorState(sock)
}
