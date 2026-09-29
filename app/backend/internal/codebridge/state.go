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

// discoveryDirs returns the dirs one cb registry (the hosts or boots leaf) is
// read from, most authoritative first: the resolved state dir's leaf, plus
// the legacy run-kit cb leaf when the resolved home is not already the legacy
// one. For one release after the rename an old code-bridge VSIX keeps writing
// the legacy dir until `rk code-server install/update` reinstalls it, so
// discovery dual-reads both. Records under the resolved dir win on a hostId
// collision; a legacy record's absolute socket path keeps its host reachable.
func discoveryDirs(leaf string) ([]string, error) {
	resolved, err := StateDir()
	if err != nil {
		return nil, err
	}
	dirs := []string{filepath.Join(resolved, leaf)}
	legacyRoot, err := apphome.LegacyStateDir()
	if err != nil {
		return dirs, nil
	}
	if legacyCb := filepath.Join(legacyRoot, "cb"); legacyCb != resolved {
		dirs = append(dirs, filepath.Join(legacyCb, leaf))
	}
	return dirs, nil
}
