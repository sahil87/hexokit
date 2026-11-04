package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rk/internal/tmux"
)

// This opt-in compatibility test uses the installed Codex and the real hook
// registry. It spends one model turn, using a read-only sandbox, a temporary
// CODEX_HOME, and a private tmux server. The only requested mutation is creation
// of probe.txt in the disposable workspace. No user configuration is installed
// or changed. A temporary copy of existing login credentials is removed by the
// test cleanup; credentials and full model output are never printed.
//
// Run: RK_CODEX_RUNTIME_TEST=1 GOFLAGS='-run=^TestCodexRuntimeAutoReview$'
//
//	just test-backend
func TestCodexRuntimeAutoReview(t *testing.T) {
	if os.Getenv("RK_CODEX_RUNTIME_CHILD") == "1" {
		payload, _ := io.ReadAll(io.LimitReader(os.Stdin, hookStdinReadLimit))
		hookStdinFn = func() io.Reader { return bytes.NewReader(payload) }
		rootCmd.SetArgs(flag.Args())
		execute()
		var in struct {
			Event     string `json:"hook_event_name"`
			SessionID string `json:"session_id"`
		}
		_ = json.Unmarshal(payload, &in)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		out, _ := exec.CommandContext(ctx, "tmux", "-S", strings.Split(tmux.OriginalTMUX, ",")[0],
			"show-options", "-pqv", "-t", os.Getenv("TMUX_PANE"), "@rk_pane_agent_state").Output()
		row, _ := json.Marshal(struct {
			Event     string `json:"event"`
			SessionID string `json:"session_id"`
			State     string `json:"state"`
		}{in.Event, in.SessionID, strings.TrimSpace(string(out))})
		if f, err := os.OpenFile(os.Getenv("RK_CODEX_RUNTIME_JOURNAL"), os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0o600); err == nil {
			_, _ = f.Write(append(row, '\n'))
			_ = f.Close()
		}
		os.Exit(0)
	}
	if os.Getenv("RK_CODEX_RUNTIME_TEST") != "1" {
		t.Skip("set RK_CODEX_RUNTIME_TEST=1 to exercise the installed Codex with a temporary home")
	}
	for _, tool := range []string{"codex", "tmux"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Fatalf("runtime test requires %s: %v", tool, err)
		}
	}
	userHome, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	loginHome := os.Getenv("CODEX_HOME")
	if loginHome == "" {
		loginHome = filepath.Join(userHome, ".codex")
	}
	auth, err := os.ReadFile(filepath.Join(loginHome, "auth.json"))
	if err != nil {
		t.Fatal("runtime test requires an existing Codex auth.json login")
	}
	rig := t.TempDir()
	codexHome, workspace := filepath.Join(rig, "codex"), filepath.Join(rig, "workspace")
	for _, dir := range []string{codexHome, workspace} {
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(codexHome, "auth.json"), auth, 0o600); err != nil {
		t.Fatal(err)
	}
	config := "approvals_reviewer = \"auto_review\"\napproval_policy = \"on-request\"\nsandbox_mode = \"read-only\"\n"
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("RK_CODEX_RUNTIME_CHILD", "1")
	journal := filepath.Join(rig, "hooks.jsonl")
	t.Setenv("RK_CODEX_RUNTIME_JOURNAL", journal)
	server := fmt.Sprintf("rk-test-codex-runtime-%d-%d", os.Getpid(), time.Now().UnixNano())
	tmuxRun := func(args ...string) string {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, "tmux", append([]string{"-L", server}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("private tmux command failed: %v: %s", err, out)
		}
		return strings.TrimSpace(string(out))
	}
	tmuxRun("new-session", "-d", "-s", "runtime", "-c", workspace)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = exec.CommandContext(ctx, "tmux", "-L", server, "kill-server").Run()
	})
	tmuxRun("set-option", "-s", "@rk_srv_ephemeral", "1")
	t.Setenv("TMUX", tmuxRun("display-message", "-p", "#{socket_path}")+",1,0")
	t.Setenv("TMUX_PANE", tmuxRun("display-message", "-p", "#{pane_id}"))
	shim := filepath.Join(rig, "hook")
	// Test binary paths and TempDir paths contain no shell syntax. Quote them
	// anyway; the installed wrapper invokes this fixed shim as its executable.
	quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
	body := "#!/bin/sh\nexec " + quote(os.Args[0]) + " -test.run '^TestCodexRuntimeAutoReview$' -- \"$@\"\n"
	if err := os.WriteFile(shim, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, cfg := range agentRegistry(rig) {
		if cfg.provider == "codex" {
			applyYes(t, cfg, shim, false)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	version, err := exec.CommandContext(ctx, "codex", "--version").Output()
	if err != nil {
		t.Fatal(err)
	}
	t.Log(strings.TrimSpace(string(version)))
	prompt := "This is an isolated hook compatibility test. Use the shell tool exactly once to run: printf 'hook-probe' > probe.txt . Request require_escalated permission for that command because the sandbox is read-only. The file belongs to this disposable test workspace. Do not read or modify any other path, and do not use any other tools. After it succeeds, reply DONE."
	cmd := exec.CommandContext(ctx, "codex", "--no-daemon", "-a", "on-request", "exec", "--json",
		"--skip-git-repo-check", "--dangerously-bypass-hook-trust", "--ignore-rules", "-s", "read-only",
		"-c", "model_reasoning_effort=\"low\"", "-C", workspace, prompt)
	var diagnostics bytes.Buffer
	cmd.Stderr = &diagnostics
	// Save output only in the disposable rig for debugging; hook assertions
	// below report lifecycle metadata, never model output or login material.
	out, err := cmd.Output()
	_ = os.WriteFile(filepath.Join(rig, "codex-output.jsonl"), out, 0o600)
	if err != nil {
		t.Logf("Codex diagnostics: %.1000s", diagnostics.String())
		for _, line := range bytes.Split(out, []byte{'\n'}) {
			var event struct {
				Type    string `json:"type"`
				Message string `json:"message"`
			}
			if json.Unmarshal(line, &event) == nil && event.Type != "" {
				if event.Type == "error" {
					t.Logf("Codex error: %.500s", event.Message)
				} else {
					t.Logf("Codex event: %s", event.Type)
				}
			}
		}
		t.Fatalf("Codex runtime failed (%v); no compatibility result claimed", err)
	}
	probe, err := os.ReadFile(filepath.Join(workspace, "probe.txt"))
	if err != nil || string(probe) != "hook-probe" {
		t.Fatalf("Codex did not complete the harmless probe: %v", err)
	}
	data, err := os.ReadFile(journal)
	if err != nil {
		t.Fatalf("Codex emitted no recorded hooks: %v", err)
	}
	permission, stopped := false, false
	for _, line := range bytes.Split(bytes.TrimSpace(data), []byte{'\n'}) {
		var row struct{ Event, State string }
		if err := json.Unmarshal(line, &row); err != nil {
			t.Fatal(err)
		}
		t.Logf("%s → %s", row.Event, row.State)
		if row.Event == "PermissionRequest" {
			permission = true
			if !strings.HasPrefix(row.State, "active:") {
				t.Errorf("automatic approval wrote %q, want active", row.State)
			}
		}
		if row.Event == "Stop" && strings.HasPrefix(row.State, "idle:") {
			stopped = true
		}
	}
	if !permission || !stopped {
		t.Errorf("missing real runtime lifecycle: PermissionRequest=%t, idle Stop=%t", permission, stopped)
	}
}
