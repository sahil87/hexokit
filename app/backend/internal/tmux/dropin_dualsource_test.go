package tmux

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestManagedConfDualSourcesDropInDir proves the managed conf's if-shell
// directive mirrors the config-home resolution rule at tmux config-load time:
// an UNMIGRATED install (only ~/.config/run-kit/ exists) whose conf was
// rewritten with the new embed — a dev/e2e rig's EnsureConfig, a manual
// `rk mux init-conf --force` — still sources its legacy tmux.d drop-ins, and
// once ~/.config/hexokit exists, ONLY the hexokit dir is sourced (no
// double-source post-migration).
//
// Each scenario runs a throwaway tmux server on a private -S socket under
// t.TempDir() with HOME pointed at a temp home — never the user's servers.
// The drop-ins set distinct marker options per dir so a stray double-source
// shows up as a set option from the wrong dir.
func TestManagedConfDualSourcesDropInDir(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not on PATH")
	}
	home := t.TempDir()
	conf := filepath.Join(t.TempDir(), "tmux.conf")
	if err := os.WriteFile(conf, DefaultConfigBytes(), 0o644); err != nil {
		t.Fatalf("write conf: %v", err)
	}

	writeDropIn := func(dir, marker string, extra string) {
		t.Helper()
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		body := "set -g @rk_dropin_marker " + marker + "\n" + extra
		if err := os.WriteFile(filepath.Join(dir, "user.conf"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	legacyDropIns := filepath.Join(home, ".config", "run-kit", "tmux.d")
	newDropIns := filepath.Join(home, ".config", "hexokit", "tmux.d")

	run := func(sock string, args ...string) (string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "tmux", append([]string{"-S", sock}, args...)...)
		// A test must never depend on running inside tmux, and the server's
		// $HOME is what the if-shell condition expands.
		env := []string{"HOME=" + home}
		for _, kv := range os.Environ() {
			if k, _, _ := strings.Cut(kv, "="); k == "TMUX" || k == "TMUX_PANE" || k == "HOME" {
				continue
			}
			env = append(env, kv)
		}
		cmd.Env = env
		out, err := cmd.CombinedOutput()
		return strings.TrimSpace(string(out)), err
	}

	// startServer boots a throwaway server against the managed conf and
	// returns the value of @rk_dropin_marker plus whether the per-dir
	// provenance options are set.
	startServer := func(name string) (marker string, legacySet, newSet bool) {
		t.Helper()
		sock := filepath.Join(t.TempDir(), name+".sock")
		if out, err := run(sock, "-f", conf, "new-session", "-d", "-s", "s", "sleep", "300"); err != nil {
			t.Skipf("could not start isolated tmux server %q: %v\n%s", sock, err, out)
		}
		pidOut, err := run(sock, "display", "-p", "#{pid}")
		if err != nil {
			t.Fatalf("read server pid: %v %s", err, pidOut)
		}
		serverPID, _ := strconv.Atoi(pidOut)
		t.Cleanup(func() {
			_, _ = run(sock, "kill-server")
			if serverPID > 0 {
				_ = syscall.Kill(serverPID, syscall.SIGKILL)
			}
		})

		marker, err = run(sock, "show-options", "-gv", "@rk_dropin_marker")
		if err != nil {
			t.Fatalf("marker option unset — no drop-in dir was sourced at all")
		}
		_, legacyErr := run(sock, "show-options", "-gv", "@rk_dropin_legacy")
		_, newErr := run(sock, "show-options", "-gv", "@rk_dropin_new")
		return marker, legacyErr == nil, newErr == nil
	}

	// Legacy-only home: the legacy drop-in must be sourced even though the
	// conf is the new embed.
	writeDropIn(legacyDropIns, "legacy", "set -g @rk_dropin_legacy 1\n")
	marker, legacySet, newSet := startServer("legacy")
	if marker != "legacy" || !legacySet || newSet {
		t.Errorf("legacy-only home: marker=%q legacySet=%v newSet=%v — want the legacy tmux.d sourced", marker, legacySet, newSet)
	}

	// Both homes exist (post-migration): only the hexokit dir is sourced.
	writeDropIn(newDropIns, "hexokit", "set -g @rk_dropin_new 1\n")
	marker, legacySet, newSet = startServer("migrated")
	if marker != "hexokit" || legacySet || !newSet {
		t.Errorf("both homes: marker=%q legacySet=%v newSet=%v — want only the hexokit tmux.d sourced", marker, legacySet, newSet)
	}
}
