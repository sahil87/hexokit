package riff

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"rk/internal/testutil"
)

func TestPickAgentPreset(t *testing.T) {
	cases := []struct {
		name                      string
		explicit, session, server string
		wantName, wantFrom        string
	}{
		{"explicit beats both options", "claude", "codex-review", "codex-workers", "claude", agentPresetFromExplicit},
		{"explicit none is still explicit", "none", "codex-review", "", "none", agentPresetFromExplicit},
		{"group beats workspace", "", "codex-review", "claude", "codex-review", AgentPresetFromGroup},
		{"workspace when the group has none", "", "", "claude", "claude", AgentPresetFromWorkspace},
		{"nothing set", "", "", "", "", ""},
		{"garbage group option is skipped, ladder continues", "", "a;b", "claude", "claude", AgentPresetFromWorkspace},
		{"leading-hyphen group option is skipped", "", "--evil", "", "", ""},
		{"garbage workspace option is skipped", "", "", "x y", "", ""},
		{"stale but well-formed name is kept (no membership check)", "", "removed-preset", "", "removed-preset", AgentPresetFromGroup},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			name, from := PickAgentPreset(tc.explicit, tc.session, tc.server)
			if name != tc.wantName || from != tc.wantFrom {
				t.Errorf("PickAgentPreset(%q, %q, %q) = (%q, %q), want (%q, %q)", tc.explicit, tc.session, tc.server, name, from, tc.wantName, tc.wantFrom)
			}
		})
	}
}

func stubPresetOptions(t *testing.T, sess, srv string, calls *int) {
	t.Helper()
	orig := readAgentPresetOptions
	readAgentPresetOptions = func(_ context.Context, server, session, callerTMUX string) (string, string) {
		*calls++
		return sess, srv
	}
	t.Cleanup(func() { readAgentPresetOptions = orig })
}

func TestResolveAgentPreset_skipsReadsForAnExplicitPick(t *testing.T) {
	var calls int
	stubPresetOptions(t, "codex-review", "claude", &calls)
	if got := ResolveAgentPreset(context.Background(), "none", "s", "g", ""); got != "none" || calls != 0 {
		t.Errorf("explicit: got %q after %d reads, want none after 0", got, calls)
	}
	if got := ResolveAgentPreset(context.Background(), "", "s", "g", ""); got != "codex-review" || calls != 1 {
		t.Errorf("ladder: got %q after %d reads, want codex-review after 1", got, calls)
	}
}

func TestSpawnAgentPreset(t *testing.T) {
	var calls int
	stubPresetOptions(t, "codex-review", "", &calls)
	ctx := context.Background()

	// A resume/fork spawn runs no ladder and passes nothing, even with an
	// explicit pick or a group option set.
	for _, o := range []Options{
		{ResumeSessionRef: "0b9f3a64-1f3d-4d4e-8c3a-9b1f2a3c4d5e"},
		{ResumeSessionRef: "0b9f3a64-1f3d-4d4e-8c3a-9b1f2a3c4d5e", AgentPreset: "claude"},
	} {
		if got, err := spawnAgentPreset(ctx, o); got != "" || err != nil || calls != 0 {
			t.Errorf("resume spawn: got (%q, %v) after %d reads, want empty and no reads", got, err, calls)
		}
	}

	if got, err := spawnAgentPreset(ctx, Options{Server: "s", Session: "g"}); got != "codex-review" || err != nil {
		t.Errorf("fresh spawn: got (%q, %v), want the group option", got, err)
	}
	if got, err := spawnAgentPreset(ctx, Options{Server: "s", Session: "g", AgentPreset: "claude"}); got != "claude" || err != nil {
		t.Errorf("explicit pick: got (%q, %v), want claude", got, err)
	}
	if _, err := spawnAgentPreset(ctx, Options{AgentPreset: "--x"}); err == nil {
		t.Error("an explicit pick failing the allowlist must be a validation error")
	}
}

// With no name the fab exec inherits the environment untouched (cmd.Env nil);
// with one, FAB_AGENT_PRESET is appended last so it beats an ambient value.
func TestFabAgentCmd_env(t *testing.T) {
	ctx := context.Background()
	if cmd := fabAgentCmd(ctx, "/repo", []string{"agent", "-o", "yaml"}, ""); cmd.Env != nil {
		t.Errorf("no preset: cmd.Env = %v, want nil (inherit)", cmd.Env)
	}
	t.Setenv("FAB_AGENT_PRESET", "ambient")
	cmd := fabAgentCmd(ctx, "/repo", []string{"agent", "-o", "yaml"}, "codex-workers")
	if last := cmd.Env[len(cmd.Env)-1]; last != "FAB_AGENT_PRESET=codex-workers" {
		t.Errorf("last env entry = %q, want FAB_AGENT_PRESET=codex-workers", last)
	}
	if cmd.Dir != "/repo" || !reflect.DeepEqual(cmd.Args[1:], []string{"agent", "-o", "yaml"}) {
		t.Errorf("cmd = dir %q args %v, want the unchanged argv in /repo", cmd.Dir, cmd.Args)
	}
}

// End to end through the real exec: the preset reaches interactive resolution
// (and its legacy --print retry) and headless resolution as FAB_AGENT_PRESET.
func TestResolve_presetReachesFabEnv(t *testing.T) {
	_ = os.Unsetenv("FAB_AGENT_PRESET")
	dir := stubFab(t, "#!/bin/sh\n"+
		"case \"$*\" in\n"+
		"  *-o\\ yaml*) printf 'command: l-%s\\n' \"${FAB_AGENT_PRESET:-none-set}\";;\n"+
		"  *--print*) printf 'p-%s\\n' \"${FAB_AGENT_PRESET:-none-set}\";;\n"+
		"esac\n")
	t.Setenv("PATH", dir)
	ctx := context.Background()

	if got := ResolveAgent(ctx, "", "", "codex-review").Launcher; got != "l-codex-review" {
		t.Errorf("ResolveAgent with a preset = %q", got)
	}
	if got := ResolveAgent(ctx, "", "", "").Launcher; got != "l-none-set" {
		t.Errorf("ResolveAgent without a preset = %q, want the env untouched", got)
	}
	if got := ResolveHeadlessAgent(ctx, "", "operator", "codex-review"); got != "l-codex-review" {
		t.Errorf("ResolveHeadlessAgent with a preset = %q", got)
	}

	legacy := stubFab(t, "#!/bin/sh\n"+
		"case \"$*\" in\n"+
		"  *-o*) exit 2;;\n"+
		"  *--print*) printf 'p-%s\\n' \"${FAB_AGENT_PRESET:-none-set}\";;\n"+
		"esac\n")
	t.Setenv("PATH", legacy)
	if got := ResolveAgent(ctx, "", "", "claude").Launcher; !strings.HasPrefix(got, "p-claude") {
		t.Errorf("legacy --print retry launcher = %q, want the preset in its env", got)
	}
}

// TestSpawn_AgentPresetEndToEnd drives Spawn through stub fab/tmux binaries and
// pins the handoff for the three cases that matter: a group option reaches both
// the fab exec and the window; an explicit pick beats it; and a resume/fork
// spawn (ResumeSessionRef) ignores the option and the pick entirely, while a
// spawn with nothing set shows neither.
func TestSpawn_AgentPresetEndToEnd(t *testing.T) {
	_ = os.Unsetenv("FAB_AGENT_PRESET")
	const ref = "0b9f3a64-1f3d-4d4e-8c3a-9b1f2a3c4d5e"
	cases := []struct {
		name       string
		opts       Options
		wantFabEnv string // "" = FAB_AGENT_PRESET absent from fab's env
		wantWindow string // "" = no -e on new-window
	}{
		{"group option", Options{}, "codex-review", "FAB_AGENT_PRESET=codex-review"},
		{"explicit pick beats the option", Options{AgentPreset: "claude"}, "claude", "FAB_AGENT_PRESET=claude"},
		{"resume ignores option and pick", Options{ResumeSessionRef: ref, AgentPreset: "claude"}, "", ""},
		{"fork ignores the option", Options{ResumeSessionRef: ref, ForkProvider: "claude"}, "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			newWindowLog := filepath.Join(dir, "new-window.log")
			fabEnvLog := filepath.Join(dir, "fab-env.log")
			testutil.WriteStub(t, dir, "tmux", stubTmuxScript(newWindowLog))
			testutil.WriteStub(t, dir, "fab", "#!/bin/sh\nprintf '%s\\n' \"${FAB_AGENT_PRESET-}\" >> "+fabEnvLog+"\n"+
				"printf 'command: claude\\nskill_prefix: /\\n'\n")
			t.Setenv("PATH", dir)

			var calls int
			stubPresetOptions(t, "codex-review", "", &calls)

			opts := tc.opts
			opts.RepoRoot = t.TempDir()
			opts.Where = "checkout"
			if _, err := Spawn(context.Background(), opts); err != nil {
				t.Fatalf("Spawn: %v", err)
			}

			fabEnv, _ := os.ReadFile(fabEnvLog)
			for _, line := range strings.Split(strings.TrimSpace(string(fabEnv)), "\n") {
				if line != tc.wantFabEnv {
					t.Errorf("fab saw FAB_AGENT_PRESET=%q, want %q", line, tc.wantFabEnv)
				}
			}
			window, _ := os.ReadFile(newWindowLog)
			if tc.wantWindow == "" {
				if strings.Contains(string(window), "FAB_AGENT_PRESET") || strings.Contains(string(window), " -e ") {
					t.Errorf("new-window carries an env it must not: %q", window)
				}
			} else if !strings.Contains(string(window), tc.wantWindow) {
				t.Errorf("new-window %q lacks %q", window, tc.wantWindow)
			}
			if tc.opts.ResumeSessionRef != "" && calls != 0 {
				t.Errorf("a resume/fork spawn read the preset options %d times, want 0", calls)
			}
		})
	}
}

// With neither an option nor a pick, the whole spawn is as it was before
// presets existed: no env on fab, no -e on the window.
func TestSpawn_NoAgentPresetLeavesTheSpawnUnchanged(t *testing.T) {
	_ = os.Unsetenv("FAB_AGENT_PRESET")
	dir := t.TempDir()
	newWindowLog := filepath.Join(dir, "new-window.log")
	fabEnvLog := filepath.Join(dir, "fab-env.log")
	testutil.WriteStub(t, dir, "tmux", stubTmuxScript(newWindowLog))
	testutil.WriteStub(t, dir, "fab", "#!/bin/sh\nprintf '%s\\n' \"${FAB_AGENT_PRESET-unset}\" >> "+fabEnvLog+"\n"+
		"printf 'command: claude\\nskill_prefix: /\\n'\n")
	t.Setenv("PATH", dir)
	var calls int
	stubPresetOptions(t, "", "", &calls)

	if _, err := Spawn(context.Background(), Options{RepoRoot: t.TempDir(), Where: "checkout"}); err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if fabEnv, _ := os.ReadFile(fabEnvLog); strings.TrimSpace(string(fabEnv)) != "unset" {
		t.Errorf("fab env = %q, want FAB_AGENT_PRESET untouched", fabEnv)
	}
	if window, _ := os.ReadFile(newWindowLog); strings.Contains(string(window), "FAB_AGENT_PRESET") || strings.Contains(string(window), " -e ") {
		t.Errorf("new-window = %q, want no env", window)
	}
	if calls != 1 {
		t.Errorf("option reads = %d, want 1 (the ladder runs once per spawn)", calls)
	}
}
