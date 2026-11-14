package tmux

import (
	"os"
	"slices"
	"strings"
	"testing"
)

func TestChildEnvRestoresTMUX(t *testing.T) {
	const restored = "TMUX=/tmp/tmux-1000/loom,123,0"
	if env := ChildEnv("/tmp/tmux-1000/loom,123,0"); !slices.Contains(env, restored) {
		t.Errorf("env lacks %q", restored)
	}

	t.Setenv("TMUX", "")
	if err := os.Unsetenv("TMUX"); err != nil {
		t.Fatal(err)
	}
	for _, kv := range ChildEnv("") {
		if strings.HasPrefix(kv, "TMUX=") {
			t.Errorf("an empty original TMUX added %q", kv)
		}
	}
}
