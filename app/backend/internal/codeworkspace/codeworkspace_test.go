package codeworkspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStateDirXDGRule(t *testing.T) {
	state := t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	dir, err := StateDir()
	if err != nil {
		t.Fatalf("StateDir: %v", err)
	}
	if want := filepath.Join(state, "hexokit", "code"); dir != want {
		t.Errorf("StateDir = %q, want %q", dir, want)
	}
}

func TestStateDirDefault(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", "")
	dir, err := StateDir()
	if err != nil {
		t.Fatalf("StateDir: %v", err)
	}
	if want := filepath.Join(home, ".local", "state", "hexokit", "code"); dir != want {
		t.Errorf("StateDir = %q, want %q", dir, want)
	}
}

func TestPathHashStability(t *testing.T) {
	root := "/home/u/code/x"
	p1 := Path("/state", "default", "@7", root)
	p2 := Path("/state", "default", "@7", root)
	if p1 != p2 {
		t.Errorf("same root produced different paths: %q vs %q", p1, p2)
	}
	base := filepath.Base(p1)
	if !strings.HasPrefix(base, "@7-") || !strings.HasSuffix(base, ".code-workspace") {
		t.Errorf("filename shape = %q, want @7-<hash6>.code-workspace", base)
	}
	hash := strings.TrimSuffix(strings.TrimPrefix(base, "@7-"), ".code-workspace")
	if len(hash) != 6 {
		t.Errorf("hash length = %d, want 6 (%q)", len(hash), hash)
	}
	for _, c := range hash {
		if !strings.ContainsRune("0123456789abcdef", c) {
			t.Errorf("hash %q contains non-lowercase-hex %q", hash, c)
		}
	}
}

func TestPathDistinctRootsDistinctNames(t *testing.T) {
	p1 := Path("/state", "default", "@7", "/home/u/code/x")
	p2 := Path("/state", "default", "@7", "/home/u/code/y")
	if p1 == p2 {
		t.Errorf("distinct roots produced the same path %q", p1)
	}
}

func TestPathServerAndTabSegments(t *testing.T) {
	p := Path("/state", "dev", "@12", "/home/u/code/x")
	if filepath.Dir(p) != filepath.Join("/state", "dev") {
		t.Errorf("dir = %q, want /state/dev", filepath.Dir(p))
	}
	if !strings.HasPrefix(filepath.Base(p), "@12-") {
		t.Errorf("filename = %q, want @12- prefix", filepath.Base(p))
	}
}

func TestContentExactShape(t *testing.T) {
	got := Content("/home/u/code/x", "@7", "default")
	want := "{\n" +
		"  \"folders\": [\n" +
		"    {\n" +
		"      \"path\": \"/home/u/code/x\"\n" +
		"    }\n" +
		"  ],\n" +
		"  \"settings\": {\n" +
		"    \"rk.tab\": \"@7\",\n" +
		"    \"rk.server\": \"default\"\n" +
		"  }\n" +
		"}\n"
	if string(got) != want {
		t.Errorf("Content = %q, want %q", got, want)
	}
}

func TestEnsureWritesFileWithMode(t *testing.T) {
	stateDir := t.TempDir()
	root := "/home/u/code/x"

	path, err := Ensure(stateDir, "default", "@7", root)
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if want := Path(stateDir, "default", "@7", root); path != want {
		t.Errorf("path = %q, want %q", path, want)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(content) != string(Content(root, "@7", "default")) {
		t.Errorf("file content = %q, want %q", content, Content(root, "@7", "default"))
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if info.Mode().Perm() != 0600 {
		t.Errorf("file mode = %o, want 600", info.Mode().Perm())
	}
	dirInfo, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatalf("Stat dir: %v", err)
	}
	if dirInfo.Mode().Perm() != 0700 {
		t.Errorf("server dir mode = %o, want 700", dirInfo.Mode().Perm())
	}
}

func TestEnsureIdempotent(t *testing.T) {
	stateDir := t.TempDir()
	root := "/home/u/code/x"

	path, err := Ensure(stateDir, "default", "@7", root)
	if err != nil {
		t.Fatalf("first Ensure: %v", err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	// Pin an unmistakable mtime so a rewrite is detectable regardless of
	// filesystem timestamp granularity.
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatalf("Chtimes: %v", err)
	}
	before, err = os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}

	path2, err := Ensure(stateDir, "default", "@7", root)
	if err != nil {
		t.Fatalf("second Ensure: %v", err)
	}
	if path2 != path {
		t.Errorf("second path = %q, want %q", path2, path)
	}
	after, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if !after.ModTime().Equal(before.ModTime()) {
		t.Errorf("second Ensure rewrote the file: mtime %v → %v", before.ModTime(), after.ModTime())
	}
}

func TestEnsureRegeneratesAfterDeletion(t *testing.T) {
	stateDir := t.TempDir()
	root := "/home/u/code/x"

	path, err := Ensure(stateDir, "default", "@7", root)
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	path2, err := Ensure(stateDir, "default", "@7", root)
	if err != nil {
		t.Fatalf("second Ensure: %v", err)
	}
	if path2 != path {
		t.Errorf("path = %q, want %q", path2, path)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(content) != string(Content(root, "@7", "default")) {
		t.Errorf("regenerated content = %q, want %q", content, Content(root, "@7", "default"))
	}
}

func TestEnsureRefreshesStaleContent(t *testing.T) {
	stateDir := t.TempDir()
	root := "/home/u/code/x"

	path, err := Ensure(stateDir, "default", "@7", root)
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if err := os.WriteFile(path, []byte("stale"), 0600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if _, err := Ensure(stateDir, "default", "@7", root); err != nil {
		t.Fatalf("second Ensure: %v", err)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(content) != string(Content(root, "@7", "default")) {
		t.Errorf("content after refresh = %q, want %q", content, Content(root, "@7", "default"))
	}
}

func TestEnsureRootChangeWritesNewName(t *testing.T) {
	stateDir := t.TempDir()

	p1, err := Ensure(stateDir, "default", "@7", "/home/u/code/x")
	if err != nil {
		t.Fatalf("Ensure x: %v", err)
	}
	p2, err := Ensure(stateDir, "default", "@7", "/home/u/code/y")
	if err != nil {
		t.Fatalf("Ensure y: %v", err)
	}
	if p1 == p2 {
		t.Fatalf("distinct roots produced the same path %q", p1)
	}
	content, err := os.ReadFile(p2)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(content) != string(Content("/home/u/code/y", "@7", "default")) {
		t.Errorf("content = %q, want the /home/u/code/y document", content)
	}
}

func TestEnsureRejectsInvalidInputs(t *testing.T) {
	stateDir := t.TempDir()

	tests := []struct {
		name     string
		server   string
		windowID string
	}{
		{"window id without @", "default", "7"},
		{"window id with letters", "default", "@x"},
		{"empty window id", "default", ""},
		{"server with traversal", "../etc", "@7"},
		{"server with slash", "a/b", "@7"},
		{"empty server", "", "@7"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			path, err := Ensure(stateDir, tc.server, tc.windowID, "/home/u/code/x")
			if err == nil {
				t.Fatalf("Ensure(%q, %q) succeeded, want error", tc.server, tc.windowID)
			}
			if path != "" {
				t.Errorf("path = %q, want empty on error", path)
			}
		})
	}
	entries, err := os.ReadDir(stateDir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("state dir is not empty after rejected calls: %v", entries)
	}
}
