// Package gui owns the pure host-GUI backend logic: state paths, display
// selection, backend/WM resolution and argv, the RFB probe, the running-apps
// scan, and the shared status document. Nothing here touches tmux or imports
// internal/daemon — the session lifecycle lives in internal/daemon/gui.go,
// which imports this package (the only cycle-free direction, since the daemon
// boot hook must call ensure).
package gui

import (
	"fmt"
	"path/filepath"

	"rk/internal/apphome"
)

// maxSocketPathBytes caps the unix socket path length: struct sockaddr_un's
// sun_path holds 108 bytes on Linux (including the NUL terminator), so a
// socket path beyond this bound can never be bound.
const maxSocketPathBytes = 100

// StateDir resolves the GUI state root: <state home>/gui, where the state
// home is apphome.StateDir ($XDG_STATE_HOME when set, else ~/.local/state,
// with the hexokit/run-kit dual-read rule). Mirrors codebridge.StateDir's
// rule for its own tenant.
func StateDir() (string, error) {
	root, err := apphome.StateDir()
	if err != nil {
		return "", fmt.Errorf("resolving gui state dir: %w", err)
	}
	return filepath.Join(root, "gui"), nil
}

// SocketPath is the RFB unix socket for one GUI id: <StateDir>/<id>.sock.
func SocketPath(id string) (string, error) {
	dir, err := StateDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, id+".sock"), nil
}

// ValidateSocketPath rejects a socket path longer than maxSocketPathBytes —
// the unix sun_path cap makes such a path unbindable.
func ValidateSocketPath(path string) error {
	if len(path) > maxSocketPathBytes {
		return fmt.Errorf("socket path %q exceeds %d bytes (unix sun_path cap)", path, maxSocketPathBytes)
	}
	return nil
}
