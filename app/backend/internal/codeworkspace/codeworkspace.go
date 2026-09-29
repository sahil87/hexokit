// Package codeworkspace derives the per-tab .code-workspace file that carries
// the tab identity (rk.tab / rk.server settings) into the code-server
// extension host. The file is a pure derived artifact of
// (server, window id, code root): it is regenerated on demand and never read
// as a source of truth (Constitution II), and deleting it changes nothing but
// a regeneration. The ONLY writer is the GET
// /api/windows/{windowId}/code-workspace handler.
package codeworkspace

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"rk/internal/apphome"
	"rk/internal/validate"
)

// StateDir resolves the code-workspace state root: <state home>/code, where
// the state home is apphome.StateDir ($XDG_STATE_HOME when set, else
// ~/.local/state). It MUST mirror codebridge.StateDir and snapshot.DefaultDir
// — one apphome rule, one leaf per consumer; every package resolves through
// apphome, so the rules can never drift apart.
func StateDir() (string, error) {
	root, err := apphome.StateDir()
	if err != nil {
		return "", fmt.Errorf("resolving code-workspace state dir: %w", err)
	}
	return filepath.Join(root, "code"), nil
}

// Path composes <stateDir>/<server>/<windowID>-<hash6>.code-workspace, where
// hash6 is the first 6 lowercase hex chars of sha256(root) — the same
// sha256-of-absolute-root rule as present.RootHash, truncated shorter: the
// windowID segment already keys the tab, so the hash only separates a root
// change on the same tab. root must be absolute; it is hashed verbatim.
func Path(stateDir, server, windowID, root string) string {
	sum := sha256.Sum256([]byte(root))
	hash6 := hex.EncodeToString(sum[:])[:6]
	return filepath.Join(stateDir, server, windowID+"-"+hash6+".code-workspace")
}

// workspaceDocument is the on-disk shape — exactly
// {"folders":[{"path":<root>}],"settings":{"rk.tab":<windowID>,"rk.server":<server>}}.
// The rk.tab/rk.server settings are the only channel code-server hands an
// extension host per-window key/value data; no other keys may appear.
type workspaceDocument struct {
	Folders  []workspaceFolder `json:"folders"`
	Settings workspaceSettings `json:"settings"`
}

type workspaceFolder struct {
	Path string `json:"path"`
}

type workspaceSettings struct {
	Tab    string `json:"rk.tab"`
	Server string `json:"rk.server"`
}

// Content renders the workspace document via json.MarshalIndent plus a
// trailing newline. The struct field order pins the key order.
func Content(root, windowID, server string) []byte {
	b, err := json.MarshalIndent(workspaceDocument{
		Folders:  []workspaceFolder{{Path: root}},
		Settings: workspaceSettings{Tab: windowID, Server: server},
	}, "", "  ")
	if err != nil {
		// Unreachable for this fixed shape; keep the signature error-free.
		return nil
	}
	return append(b, '\n')
}

// Ensure writes the workspace file when absent or stale and returns its path.
// server and windowID are validated BEFORE any path composition (Constitution
// I). The server dir is created 0700; the file is written 0600 via temp +
// rename, and only when the existing content differs byte-for-byte — a
// byte-equal file is left untouched, so repeated calls are idempotent (mtime
// unchanged). A deleted or corrupted file is regenerated.
func Ensure(stateDir, server, windowID, root string) (string, error) {
	if msg := validate.ValidateServerName(server); msg != "" {
		return "", fmt.Errorf("invalid server: %s", msg)
	}
	if msg := validate.ValidateWindowID(windowID, "Window ID"); msg != "" {
		return "", fmt.Errorf("invalid window id: %s", msg)
	}

	path := Path(stateDir, server, windowID, root)
	content := Content(root, windowID, server)
	if existing, err := os.ReadFile(path); err == nil && bytes.Equal(existing, content) {
		return path, nil
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", fmt.Errorf("creating workspace state dir: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".workspace-*")
	if err != nil {
		return "", fmt.Errorf("creating workspace temp file: %w", err)
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(content); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return "", fmt.Errorf("writing workspace temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return "", fmt.Errorf("closing workspace temp file: %w", err)
	}
	// CreateTemp already creates the file 0600; the explicit chmod pins the
	// mode against a restrictive umask change in CreateTemp semantics.
	if err := os.Chmod(tmpName, 0600); err != nil {
		os.Remove(tmpName)
		return "", fmt.Errorf("setting workspace file mode: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		return "", fmt.Errorf("installing workspace file: %w", err)
	}
	return path, nil
}
