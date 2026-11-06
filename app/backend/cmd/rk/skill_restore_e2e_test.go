package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rk/internal/snapshot"
)

// skill_restore_e2e_test.go is the black-box proof that the `rk skill restore`
// page's procedure works as written. A REAL rk binary is built and driven
// against a REAL tmux server through the page's steps, in the page's order:
//
//  1. a snapshot whose server has no socket and no tombstone (the signature of
//     a daemon that died together with its servers) lists as `live` with
//     audited_kill false, and inventory does not list the server;
//  2. `rk mux snapshot restore` recreates it, naming the former command;
//  3. a second restore refuses the now-live server;
//  4. `rk mux send -L` types a command into the restored fresh shell, which
//     warns `sending ungated` and runs it at the recorded cwd;
//  5. `rk mux inventory --json -L` shows the restored pane.
//
// Hermetic by construction: HOME and XDG_STATE_HOME are t.TempDir() roots, so
// the snapshot store and config homes land in the sandbox. The server is named
// rk-test-restoreskill-<pid>-<ns>: the rk-test- prefix keeps the machine's
// real daemon from ever snapshotting it, and RK_SERVER_ALLOWLIST scopes the
// inventory to it. The restored shell is bash with no rc files (SHELL points
// at it), so no interactive first-run wizard can eat the typed command.
//
// Skips when go, tmux, or bash is absent.

func TestSkillRestoreProcedureE2E(t *testing.T) {
	for _, tool := range []string{"go", "tmux", "bash"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s not available: %v", tool, err)
		}
	}
	bash, _ := exec.LookPath("bash")

	bin := filepath.Join(t.TempDir(), "rk")
	buildCtx, buildCancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer buildCancel()
	if out, err := exec.CommandContext(buildCtx, "go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, string(out))
	}

	root := t.TempDir()
	home := filepath.Join(root, "home")
	stateHome := filepath.Join(root, "state")
	workDir := filepath.Join(root, "work")
	for _, dir := range []string{home, stateHome, workDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	server := fmt.Sprintf("rk-test-restoreskill-%d-%d", os.Getpid(), time.Now().UnixNano())
	t.Cleanup(func() {
		killCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = exec.CommandContext(killCtx, "tmux", "-L", server, "kill-server").Run()
	})
	env := hmChildEnv(home, stateHome, "RK_SERVER_ALLOWLIST="+server, "SHELL="+bash)

	// The page's own binary prints the page byte-identical to the canonical.
	canonical, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "site", "skill", "restore.md"))
	if err != nil {
		t.Fatalf("read canonical restore page: %v", err)
	}
	if got := hmRun(t, bin, env, "skill", "restore"); got != string(canonical) {
		t.Fatalf("built binary's `skill restore` differs from docs/site/skill/restore.md (%d vs %d bytes)", len(got), len(canonical))
	}

	// A live-latest snapshot with no socket and no tombstone: what the store
	// holds after the daemon died together with the server.
	store := snapshot.NewStore(filepath.Join(stateHome, "hexokit", "snapshots"))
	if written, err := store.Write(&snapshot.Snapshot{
		Server:  server,
		TakenAt: time.Now().UTC(),
		Sessions: []snapshot.Session{{
			Name: "work",
			Windows: []snapshot.Window{{
				Index: 1, ID: "@1", Name: "agent", Active: true,
				Panes: []snapshot.Pane{{ID: "%1", Index: 1, Cwd: workDir, Command: "claude", Active: true}},
			}},
		}},
	}); err != nil || !written {
		t.Fatalf("seed snapshot: written=%v err=%v", written, err)
	}

	// Step 1: the snapshot says live; the socket says dead.
	var list struct {
		Result []struct {
			Server      string  `json:"server"`
			DiedAt      *string `json:"died_at"`
			AuditedKill bool    `json:"audited_kill"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(hmRun(t, bin, env, "mux", "snapshot", "list", "--json")), &list); err != nil {
		t.Fatalf("parse snapshot list --json: %v", err)
	}
	found := false
	for _, row := range list.Result {
		if row.Server != server {
			continue
		}
		found = true
		if row.DiedAt != nil || row.AuditedKill {
			t.Errorf("snapshot row = died_at %v audited_kill %v, want a live-latest row (nil, false)", row.DiedAt, row.AuditedKill)
		}
	}
	if !found {
		t.Fatalf("snapshot list --json has no row for %s", server)
	}
	if servers := restoreSkillInventoryServers(t, bin, env); len(servers) != 0 {
		t.Fatalf("inventory before restore lists %v, want no live server", servers)
	}

	// Step 3 of the page: restore the layout.
	report := hmRun(t, bin, env, "mux", "snapshot", "restore", server)
	for _, want := range []string{"was running: claude", "fresh shells"} {
		if !strings.Contains(report, want) {
			t.Errorf("restore report lacks %q:\n%s", want, report)
		}
	}

	// A live server is refused, and nothing is touched.
	refuseCtx, refuseCancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer refuseCancel()
	again := exec.CommandContext(refuseCtx, bin, "mux", "snapshot", "restore", server)
	again.Env = env
	out, err := again.CombinedOutput()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || !strings.Contains(string(out), "refusing to restore") {
		t.Errorf("second restore: err=%v output=%q, want a non-zero refusal naming `refusing to restore`", err, out)
	}

	pane := restoreSkillPaneAt(t, server, "work", workDir)

	// Step 5 of the page: type the launch command into the fresh shell. A
	// harmless marker command stands in for `claude --resume <uuid>`; the
	// delivery path is the same.
	marker := filepath.Join(workDir, "resumed")
	sendCtx, sendCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer sendCancel()
	send := exec.CommandContext(sendCtx, bin, "mux", "send", "-L", server, pane, "printf ok > resumed")
	send.Env = env
	var sendErr strings.Builder
	send.Stderr = &sendErr
	sendOut, err := send.Output()
	if err != nil {
		t.Fatalf("mux send: %v\nstdout: %s\nstderr: %s", err, sendOut, sendErr.String())
	}
	if got := strings.TrimSpace(string(sendOut)); got != "delivered "+pane {
		t.Errorf("mux send stdout = %q, want %q", got, "delivered "+pane)
	}
	if !strings.Contains(sendErr.String(), "sending ungated") {
		t.Errorf("mux send stderr = %q, want the ungated warning the page calls expected", sendErr.String())
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		b, err := os.ReadFile(marker)
		if err == nil && string(b) == "ok" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("command typed into the restored pane never ran at its cwd (marker %s: %v)", marker, err)
		}
		time.Sleep(100 * time.Millisecond)
	}

	// Step 7 of the page: inventory shows the restored pane at its cwd.
	if servers := restoreSkillInventoryServers(t, bin, env); len(servers) != 1 || servers[0] != server {
		t.Errorf("inventory after restore lists %v, want [%s]", servers, server)
	}
	var inv struct {
		Result struct {
			Servers []struct {
				Panes []struct {
					Pane    string `json:"pane"`
					Session string `json:"session"`
					Cwd     string `json:"cwd"`
				} `json:"panes"`
			} `json:"servers"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(hmRun(t, bin, env, "mux", "inventory", "--json", "-L", server)), &inv); err != nil {
		t.Fatalf("parse inventory --json -L: %v", err)
	}
	seen := false
	for _, s := range inv.Result.Servers {
		for _, p := range s.Panes {
			if p.Pane == pane && p.Session == "work" && p.Cwd == workDir {
				seen = true
			}
		}
	}
	if !seen {
		t.Errorf("inventory -L %s has no pane %s in session work at %s: %+v", server, pane, workDir, inv.Result.Servers)
	}
}

// restoreSkillInventoryServers returns the live server names `rk mux inventory
// --json` reports under the test's allowlisted env.
func restoreSkillInventoryServers(t *testing.T, bin string, env []string) []string {
	t.Helper()
	var inv struct {
		Result struct {
			Servers []struct {
				Server string `json:"server"`
			} `json:"servers"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(hmRun(t, bin, env, "mux", "inventory", "--json")), &inv); err != nil {
		t.Fatalf("parse inventory --json: %v", err)
	}
	var names []string
	for _, s := range inv.Result.Servers {
		names = append(names, s.Server)
	}
	return names
}

// restoreSkillPaneAt returns the id of the restored pane in session at cwd,
// read straight from tmux so the assertion does not lean on rk's own view.
func restoreSkillPaneAt(t *testing.T, server, session, cwd string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "tmux", "-L", server, "list-panes", "-a",
		"-F", "#{session_name}\t#{pane_id}\t#{pane_current_path}").Output()
	if err != nil {
		t.Fatalf("tmux list-panes: %v", err)
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.Split(line, "\t")
		if len(parts) == 3 && parts[0] == session && parts[2] == cwd {
			return parts[1]
		}
	}
	t.Fatalf("no pane in session %s at %s; tmux reports:\n%s", session, cwd, out)
	return ""
}
