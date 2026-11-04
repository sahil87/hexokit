package codebridge

import (
	"fmt"
	"path/filepath"

	"rk/internal/apphome"
)

// StateDir resolves the code-bridge state root: <state home>/cb, where the
// state home is apphome.StateDir ($XDG_STATE_HOME when set, else
// ~/.local/state). It MUST mirror snapshot.DefaultDir — both the extension
// and the CLI resolve this path independently, so the rules may never drift
// apart.
func StateDir() (string, error) {
	root, err := apphome.StateDir()
	if err != nil {
		return "", fmt.Errorf("resolving code-bridge state dir: %w", err)
	}
	return filepath.Join(root, "cb"), nil
}

// HostsDir is the host-record registry dir, <state dir>/hosts.
func HostsDir() (string, error) {
	dir, err := StateDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "hosts"), nil
}

// BootsDir is the empty-boot marker dir, <state dir>/boots.
func BootsDir() (string, error) {
	dir, err := StateDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "boots"), nil
}
