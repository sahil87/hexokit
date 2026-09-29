package riff

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"rk/internal/settings"
	"rk/internal/testutil"
)

func TestParseWorktreePath(t *testing.T) {
	cases := []struct {
		name   string
		output string
		want   string
	}{
		{
			name:   "simple happy path",
			output: "Path: /tmp/myrepo.worktrees/alpha\n",
			want:   "/tmp/myrepo.worktrees/alpha",
		},
		{
			name:   "whitespace trimmed",
			output: "   Path:    /tmp/myrepo.worktrees/alpha   \n",
			want:   "/tmp/myrepo.worktrees/alpha",
		},
		{
			name: "Path line among other lines",
			output: "Created worktree\n" +
				"Branch: feature/foo\n" +
				"Path: /tmp/myrepo.worktrees/beta\n" +
				"Done.\n",
			want: "/tmp/myrepo.worktrees/beta",
		},
		{
			name:   "no Path line",
			output: "wt: something went wrong\nhave a nice day\n",
			want:   "",
		},
		{
			name:   "Path with empty value",
			output: "Path: \n",
			want:   "",
		},
		{
			name:   "empty output",
			output: "",
			want:   "",
		},
		{
			name: "first Path line wins",
			output: "Path: /a\n" +
				"Path: /b\n",
			want: "/a",
		},
		{
			name:   "path containing spaces preserved",
			output: "Path: /tmp/has spaces/alpha\n",
			want:   "/tmp/has spaces/alpha",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseWorktreePath(tc.output)
			if got != tc.want {
				t.Errorf("parseWorktreePath(%q) = %q, want %q", tc.output, got, tc.want)
			}
		})
	}
}

// TestBuildSkillShellString asserts the three-layer skill-pane shell string
// composition (the task-injection seam the HTTP endpoint reuses). Pure — no
// tmux/exec. Replaces the old cmd/rk TestBuildNewWindowArgs, which asserted the
// same shell string wrapped in a new-window argv (buildNewWindowArgs was a
// back-compat argv seam not carried into the engine; buildSpawnArgvs /
// buildNewWindowCaptureArgs are the live argv builders and have their own tests).
func TestBuildSkillShellString(t *testing.T) {
	cases := []struct {
		name     string
		launcher string
		cmdArg   string
		want     string
	}{
		{
			name:     "launcher with skill arg",
			launcher: "claude --dangerously-skip-permissions",
			cmdArg:   "/fab-discuss",
			want:     `${SHELL:-/bin/sh} -i -c 'claude --dangerously-skip-permissions '\''/fab-discuss'\'''; exec "${SHELL:-/bin/sh}"`,
		},
		{
			name:     "cmdArg with single quote",
			launcher: "claude",
			cmdArg:   "it's a test",
			want:     `${SHELL:-/bin/sh} -i -c 'claude '\''it'\''\'\'''\''s a test'\'''; exec "${SHELL:-/bin/sh}"`,
		},
		{
			name:     "empty launcher tolerated",
			launcher: "",
			cmdArg:   "/x",
			want:     `${SHELL:-/bin/sh} -i -c ' '\''/x'\'''; exec "${SHELL:-/bin/sh}"`,
		},
		{
			name:     "bare skill (empty cmdArg) — no quoted positional",
			launcher: "claude",
			cmdArg:   "",
			want:     `${SHELL:-/bin/sh} -i -c 'claude'; exec "${SHELL:-/bin/sh}"`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := buildSkillShellString(tc.launcher, tc.cmdArg)
			if got != tc.want {
				t.Errorf("buildSkillShellString(%q, %q) =\n  %q\nwant\n  %q", tc.launcher, tc.cmdArg, got, tc.want)
			}
		})
	}
}

// TestSkillPaneCommand pins the exported seam as a byte-identical delegate of
// buildSkillShellString — cmd/rk (rk tutorial) composes its pane command
// through it, so a drift here silently splits the task-injection composition.
func TestSkillPaneCommand(t *testing.T) {
	cases := []struct {
		launcher string
		prompt   string
	}{
		{"claude --dangerously-skip-permissions", "Run rk skill tutorial and follow it exactly"},
		{"claude", "it's quoted"},
		{"claude", ""},
		{"", "/x"},
	}
	for _, tc := range cases {
		got := SkillPaneCommand(tc.launcher, tc.prompt)
		want := buildSkillShellString(tc.launcher, tc.prompt)
		if got != want {
			t.Errorf("SkillPaneCommand(%q, %q) =\n  %q\nwant byte-identical to buildSkillShellString\n  %q", tc.launcher, tc.prompt, got, want)
		}
	}
}

// TestRenderSkillRef covers the provider-prefix renderer: slash-led
// skill-shaped values get the prefix swapped (arguments verbatim); everything
// else — prose, empty, already-$, paths — passes through unchanged; an empty
// or "/" prefix is the identity.
func TestRenderSkillRef(t *testing.T) {
	cases := []struct {
		name   string
		prefix string
		value  string
		want   string
	}{
		{"swap on a bare invocation", "$", "/fab-discuss", "$fab-discuss"},
		{"arguments preserved verbatim", "$", "/fab-clarify resolve the auth question", "$fab-clarify resolve the auth question"},
		{"argument whitespace preserved", "$", "/fab-x  double  space", "$fab-x  double  space"},
		{"underscore is name charset", "$", "/fab_discuss", "$fab_discuss"},
		{"prose task passes through", "$", "fix the flaky test in internal/tmux", "fix the flaky test in internal/tmux"},
		{"empty value passes through", "$", "", ""},
		{"already-$-prefixed passes through", "$", "$fab-discuss", "$fab-discuss"},
		{"a path is not an invocation", "$", "/tmp/x", "/tmp/x"},
		{"uppercase fails the name charset", "$", "/Fab-Discuss", "/Fab-Discuss"},
		{"slash-only is not an invocation", "$", "/", "/"},
		{"slash prefix is the identity", "/", "/fab-discuss", "/fab-discuss"},
		{"slash prefix leaves prose untouched", "/", "fix the bug", "fix the bug"},
		{"empty prefix behaves as slash", "", "/fab-discuss", "/fab-discuss"},
		{"empty prefix leaves prose untouched", "", "fix the bug", "fix the bug"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := RenderSkillRef(tc.prefix, tc.value); got != tc.want {
				t.Errorf("RenderSkillRef(%q, %q) = %q, want %q", tc.prefix, tc.value, got, tc.want)
			}
		})
	}
}

func TestResolveWindowName(t *testing.T) {
	cases := []struct {
		name     string
		existing []string
		base     string
		want     string
	}{
		{
			name:     "no collision returns base",
			existing: []string{"other-window", "unrelated"},
			base:     "riff-alpha",
			want:     "riff-alpha",
		},
		{
			name:     "one collision returns base-2",
			existing: []string{"riff-alpha"},
			base:     "riff-alpha",
			want:     "riff-alpha-2",
		},
		{
			name:     "three collisions return base-4",
			existing: []string{"riff-alpha", "riff-alpha-2", "riff-alpha-3"},
			base:     "riff-alpha",
			want:     "riff-alpha-4",
		},
		{
			name:     "empty existing-list returns base",
			existing: nil,
			base:     "riff-alpha",
			want:     "riff-alpha",
		},
		{
			name:     "gap at base-2 filled before base-3",
			existing: []string{"riff-alpha", "riff-alpha-3"},
			base:     "riff-alpha",
			want:     "riff-alpha-2",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := resolveWindowName(tc.existing, tc.base)
			if got != tc.want {
				t.Errorf("resolveWindowName(%v, %q) = %q, want %q", tc.existing, tc.base, got, tc.want)
			}
		})
	}
}

// TestParseFabAgentOutput covers the pure post-processing seam for the legacy
// `fab agent --print` retry inside ResolveAgent's fallback ladder. Pure — no
// subprocess. A trimmed multi-line result is malformed (a valid session command
// is one line).
func TestParseFabAgentOutput(t *testing.T) {
	cases := []struct {
		name   string
		stdout string
		err    error
		want   string
		wantOK bool
	}{
		{
			name:   "single line returns launcher",
			stdout: "claude --dangerously-skip-permissions --effort xhigh\n",
			err:    nil,
			want:   "claude --dangerously-skip-permissions --effort xhigh",
			wantOK: true,
		},
		{
			name:   "leading and trailing whitespace trimmed",
			stdout: "   claude --model x   \n\n",
			err:    nil,
			want:   "claude --model x",
			wantOK: true,
		},
		{
			name:   "shell substitution preserved",
			stdout: "claude --dangerously-skip-permissions -n \"$(basename \"$(pwd)\")\"\n",
			err:    nil,
			want:   `claude --dangerously-skip-permissions -n "$(basename "$(pwd)")"`,
			wantOK: true,
		},
		{
			name:   "exec error falls back",
			stdout: "some output",
			err:    errTestFail,
			want:   "",
			wantOK: false,
		},
		{
			name:   "empty stdout falls back",
			stdout: "",
			err:    nil,
			want:   "",
			wantOK: false,
		},
		{
			name:   "whitespace-only stdout falls back",
			stdout: "   \n\t\n",
			err:    nil,
			want:   "",
			wantOK: false,
		},
		{
			name:   "multi-line stdout is malformed and falls back",
			stdout: "claude --flag\nextra noise line\n",
			err:    nil,
			want:   "",
			wantOK: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := parseFabAgentOutput(tc.stdout, tc.err)
			if ok != tc.wantOK {
				t.Fatalf("parseFabAgentOutput(%q, %v) ok = %v, want %v", tc.stdout, tc.err, ok, tc.wantOK)
			}
			if got != tc.want {
				t.Errorf("parseFabAgentOutput(%q, %v) = %q, want %q", tc.stdout, tc.err, got, tc.want)
			}
		})
	}
}

// TestFabAgentArgs covers the pure argv seam: an empty tier drops the positional
// (today's default-tier path), a named tier inserts it before --print.
func TestFabAgentArgs(t *testing.T) {
	cases := []struct {
		name string
		tier string
		want []string
	}{
		{name: "empty tier → no positional", tier: "", want: []string{"agent", "--print"}},
		{name: "named tier → positional", tier: "doing", want: []string{"agent", "doing", "--print"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := fabAgentArgs(tc.tier); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("fabAgentArgs(%q) = %#v, want %#v", tc.tier, got, tc.want)
			}
		})
	}
}

// TestFabAgentYAMLArgs covers the `-o yaml` argv seam: same positional-tier
// rule as fabAgentArgs, with the output-format flag pair appended.
func TestFabAgentYAMLArgs(t *testing.T) {
	cases := []struct {
		name string
		tier string
		want []string
	}{
		{name: "empty tier → no positional", tier: "", want: []string{"agent", "-o", "yaml"}},
		{name: "named tier → positional", tier: "doing", want: []string{"agent", "doing", "-o", "yaml"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := fabAgentYAMLArgs(tc.tier); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("fabAgentYAMLArgs(%q) = %#v, want %#v", tc.tier, got, tc.want)
			}
		})
	}
}

// TestParseFabAgentYAML covers the pure post-processing seam for ResolveAgent's
// `fab agent -o yaml` call: top-level `command`/`skill_prefix` extraction with
// nested keys ignored and the missing-prefix → "/" default. Pure — no
// subprocess.
func TestParseFabAgentYAML(t *testing.T) {
	cases := []struct {
		name   string
		stdout string
		err    error
		want   ResolvedAgent
		wantOK bool
	}{
		{
			name:   "command and skill_prefix parse",
			stdout: "selector: default\nprovider: codex\ncommand: codex --yolo\nskill_prefix: $\n",
			want:   ResolvedAgent{Launcher: "codex --yolo", SkillPrefix: "$"},
			wantOK: true,
		},
		{
			name:   "skill_prefix absent reads as slash (older fab)",
			stdout: "provider: claude\ncommand: claude --model x\n",
			want:   ResolvedAgent{Launcher: "claude --model x", SkillPrefix: "/"},
			wantOK: true,
		},
		{
			name:   "command value is verbatim — quotes and substitution preserved",
			stdout: `command: claude -n "$(basename "$(pwd)")" --model x --effort high` + "\nskill_prefix: /\n",
			want:   ResolvedAgent{Launcher: `claude -n "$(basename "$(pwd)")" --model x --effort high`, SkillPrefix: "/"},
			wantOK: true,
		},
		{
			name: "nested keys are ignored (dispatch.command cannot shadow the top level)",
			stdout: "command: claude --model x\n" +
				"dispatch:\n" +
				"    rung: pane\n" +
				"    command: nested-must-not-win\n" +
				"skill_prefix: /\n",
			want:   ResolvedAgent{Launcher: "claude --model x", SkillPrefix: "/"},
			wantOK: true,
		},
		{
			name:   "exec error falls back",
			stdout: "command: claude\n",
			err:    errTestFail,
			wantOK: false,
		},
		{
			name:   "empty stdout falls back",
			stdout: "",
			wantOK: false,
		},
		{
			name:   "no command key falls back",
			stdout: "provider: claude\nskill_prefix: /\n",
			wantOK: false,
		},
		{
			name:   "empty command value falls back",
			stdout: "command: \nskill_prefix: /\n",
			wantOK: false,
		},
		{
			name:   "key without a value separator is not a match",
			stdout: "command:\nskill_prefix: /\n",
			wantOK: false,
		},
		{
			name:   "empty skill_prefix value keeps the slash default",
			stdout: "command: claude\nskill_prefix: \n",
			want:   ResolvedAgent{Launcher: "claude", SkillPrefix: "/"},
			wantOK: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := parseFabAgentYAML(tc.stdout, tc.err)
			if ok != tc.wantOK {
				t.Fatalf("parseFabAgentYAML(%q, %v) ok = %v, want %v", tc.stdout, tc.err, ok, tc.wantOK)
			}
			if got != tc.want {
				t.Errorf("parseFabAgentYAML(%q, %v) = %+v, want %+v", tc.stdout, tc.err, got, tc.want)
			}
		})
	}
}

// TestResolveLauncher_StubFab exercises ResolveAgent/ResolveLauncher end-to-end
// by staging a stub `fab` executable on a temp-dir PATH. Covers the `-o yaml`
// success path (default AND named tier, with and without skill_prefix), the
// legacy `--print` retry for a fab that rejects `-o`, the non-zero exit
// fallback, and the fab-absent fallback. repoRoot is passed as "" so no Dir is
// set (the stub ignores cwd).
func TestResolveLauncher_StubFab(t *testing.T) {
	t.Run("stub fab prints YAML (default tier)", func(t *testing.T) {
		dir := stubFab(t, "#!/bin/sh\nprintf 'command: %s\\nskill_prefix: %s\\n' 'stub-launcher --effort xhigh' '/'\n")
		t.Setenv("PATH", dir)
		want := ResolvedAgent{Launcher: "stub-launcher --effort xhigh", SkillPrefix: "/"}
		if got := ResolveAgent(context.Background(), "", ""); got != want {
			t.Errorf("ResolveAgent() = %+v, want %+v", got, want)
		}
		if got := ResolveLauncher(context.Background(), "", ""); got != want.Launcher {
			t.Errorf("ResolveLauncher() = %q, want %q", got, want.Launcher)
		}
	})

	t.Run("codex YAML carries the $ skill prefix", func(t *testing.T) {
		dir := stubFab(t, "#!/bin/sh\nprintf 'command: %s\\nskill_prefix: %s\\n' 'codex --yolo' '$'\n")
		t.Setenv("PATH", dir)
		want := ResolvedAgent{Launcher: "codex --yolo", SkillPrefix: "$"}
		if got := ResolveAgent(context.Background(), "", ""); got != want {
			t.Errorf("ResolveAgent() = %+v, want %+v", got, want)
		}
	})

	t.Run("YAML without skill_prefix reads as slash", func(t *testing.T) {
		dir := stubFab(t, "#!/bin/sh\nprintf 'command: %s\\n' 'claude --model x'\n")
		t.Setenv("PATH", dir)
		want := ResolvedAgent{Launcher: "claude --model x", SkillPrefix: "/"}
		if got := ResolveAgent(context.Background(), "", ""); got != want {
			t.Errorf("ResolveAgent() = %+v, want %+v", got, want)
		}
	})

	t.Run("named tier passes the positional to fab", func(t *testing.T) {
		// The stub echoes its args as the YAML command so we can assert the tier
		// positional reaches fab as `agent <tier> -o yaml`.
		dir := stubFab(t, "#!/bin/sh\nprintf 'command: args: %s\\nskill_prefix: /\\n' \"$*\"\n")
		t.Setenv("PATH", dir)
		got := ResolveAgent(context.Background(), "", "doing")
		if want := "args: agent doing -o yaml"; got.Launcher != want {
			t.Errorf("ResolveAgent(tier=doing).Launcher = %q, want %q", got.Launcher, want)
		}
	})

	t.Run("legacy fab rejecting -o retries --print", func(t *testing.T) {
		// A fab predating `-o yaml`: non-zero on any -o argv, the resolved
		// launcher on --print. The ladder must retry --print and keep the
		// configured launcher rather than degrading to DefaultLauncher.
		dir := stubFab(t, "#!/bin/sh\nfor a in \"$@\"; do if [ \"$a\" = \"-o\" ]; then exit 1; fi; done\nprintf '%s\\n' 'legacy-launcher --print'\n")
		t.Setenv("PATH", dir)
		want := ResolvedAgent{Launcher: "legacy-launcher --print", SkillPrefix: "/"}
		if got := ResolveAgent(context.Background(), "", "doing"); got != want {
			t.Errorf("ResolveAgent() = %+v, want %+v", got, want)
		}
	})

	t.Run("stub fab exits non-zero falls back", func(t *testing.T) {
		dir := stubFab(t, "#!/bin/sh\necho boom >&2\nexit 1\n")
		t.Setenv("PATH", dir)
		if got := ResolveAgent(context.Background(), "", ""); got != defaultResolvedAgent {
			t.Errorf("ResolveAgent() = %+v, want %+v (fallback)", got, defaultResolvedAgent)
		}
	})

	t.Run("fab absent from PATH falls back", func(t *testing.T) {
		t.Setenv("PATH", t.TempDir())
		if got := ResolveAgent(context.Background(), "", "doing"); got != defaultResolvedAgent {
			t.Errorf("ResolveAgent() = %+v, want %+v (fallback)", got, defaultResolvedAgent)
		}
		if got := ResolveLauncher(context.Background(), "", "doing"); got != DefaultLauncher {
			t.Errorf("ResolveLauncher() = %q, want %q (fallback)", got, DefaultLauncher)
		}
	})
}

// TestBuildWtCreateArgs covers the mockup-v2 --worktree-name passthrough: an
// empty name is byte-identical to the pre-feature argv; a name in worktree mode
// prepends `--worktree-name <name>`; a name in checkout mode is defensively
// ignored (checkout never reaches wt, and the name is rejected at the API).
func TestBuildWtCreateArgs(t *testing.T) {
	cases := []struct {
		name        string
		where       string
		wtName      string
		passthrough []string
		want        []string
	}{
		{
			name: "no name → byte-identical pre-feature argv",
			want: []string{"create", "--non-interactive", "--worktree-open", "skip"},
		},
		{
			name:   "worktree mode with name",
			where:  "worktree",
			wtName: "my-agent",
			want:   []string{"create", "--worktree-name", "my-agent", "--non-interactive", "--worktree-open", "skip"},
		},
		{
			name:        "name + passthrough",
			where:       "worktree",
			wtName:      "my-agent",
			passthrough: []string{"--base", "main"},
			want:        []string{"create", "--worktree-name", "my-agent", "--non-interactive", "--worktree-open", "skip", "--base", "main"},
		},
		{
			name:   "checkout mode ignores name",
			where:  "checkout",
			wtName: "ignored",
			want:   []string{"create", "--non-interactive", "--worktree-open", "skip"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			spec := EffectiveSpec{Where: tc.where, WorktreeName: tc.wtName}
			got := buildWtCreateArgs(spec, tc.passthrough)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("buildWtCreateArgs() = %#v\nwant %#v", got, tc.want)
			}
		})
	}
}

// stubFab writes an executable `fab` script into a fresh temp dir and returns
// that dir (suitable as a PATH override).
func stubFab(t *testing.T, script string) string {
	t.Helper()
	dir := t.TempDir()
	testutil.WriteStub(t, dir, "fab", script)
	return dir
}

// TestSpawn_WhereModes exercises the Spawn isolation branch end-to-end against
// stub `wt`/`tmux`/`fab` executables on a temp-dir PATH. It asserts the two facts
// the checkout branch (T003/T010) is responsible for:
//
//   - checkout mode issues NO `wt` call (the stub wt fails the test if invoked)
//     and roots the window at opts.RepoRoot with base `riff-<repoRoot-basename>`;
//   - worktree mode DOES invoke `wt create` and roots the window at the
//     wt-reported Path with base `riff-<worktree-basename>`.
//
// The stub tmux logs its `new-window` argv so the test reads back the `-n <name>`
// (base) and `-c <root>` (working dir) the engine chose. Server is "" so tmux
// argv carries no `-L` prefix; a single bare skill pane means only new-window +
// select-pane + display-message run (no split/select-layout).
func TestSpawn_WhereModes(t *testing.T) {
	t.Run("checkout mode skips wt and roots at repoRoot", func(t *testing.T) {
		dir := t.TempDir()
		repoRoot := filepath.Join(t.TempDir(), "my-checkout")
		if err := os.MkdirAll(repoRoot, 0o755); err != nil {
			t.Fatalf("mkdir repoRoot: %v", err)
		}
		newWindowLog := filepath.Join(dir, "new-window.log")

		// wt MUST NOT be invoked in checkout mode — if it is, mark a sentinel the
		// test asserts against (a non-zero exit alone would surface as a spawn
		// error, but the explicit marker names the violation clearly). The marker
		// is written via shell redirection, not `touch` — PATH is restricted to
		// the stub dir, so external commands are unavailable inside the stubs.
		wtCalled := filepath.Join(dir, "wt-called")
		testutil.WriteStub(t, dir, "wt", "#!/bin/sh\n: > "+wtCalled+"\necho 'wt should not be called in checkout mode' >&2\nexit 1\n")
		testutil.WriteStub(t, dir, "tmux", stubTmuxScript(newWindowLog))
		// fab resolves the launcher; a plain single-line print keeps ResolveLauncher happy.
		testutil.WriteStub(t, dir, "fab", "#!/bin/sh\necho 'claude'\n")
		t.Setenv("PATH", dir)

		res, err := Spawn(context.Background(), Options{
			Server:   "", // CLI-style targeting so tmux argv has no -L prefix
			Session:  "",
			RepoRoot: repoRoot,
			Where:    "checkout",
		})
		if err != nil {
			t.Fatalf("Spawn(checkout) error: %v", err)
		}
		if _, statErr := os.Stat(wtCalled); statErr == nil {
			t.Error("checkout mode invoked wt create; it must skip wt entirely")
		}
		gotName, gotRoot := readNewWindowArgs(t, newWindowLog)
		if want := "riff-my-checkout"; gotName != want {
			t.Errorf("checkout window name (base) = %q, want %q", gotName, want)
		}
		if gotRoot != repoRoot {
			t.Errorf("checkout window root (-c) = %q, want repoRoot %q", gotRoot, repoRoot)
		}
		if res.WindowName != "riff-my-checkout" {
			t.Errorf("Result.WindowName = %q, want riff-my-checkout", res.WindowName)
		}
	})

	t.Run("worktree mode invokes wt and roots at the wt path", func(t *testing.T) {
		dir := t.TempDir()
		repoRoot := t.TempDir()
		worktree := filepath.Join(t.TempDir(), "swift-fox")
		if err := os.MkdirAll(worktree, 0o755); err != nil {
			t.Fatalf("mkdir worktree: %v", err)
		}
		newWindowLog := filepath.Join(dir, "new-window.log")
		wtCalled := filepath.Join(dir, "wt-called")

		// wt create prints the `Path:` line the engine parses for the window root.
		// The marker uses shell redirection (not `touch`) — PATH is stub-only.
		testutil.WriteStub(t, dir, "wt", "#!/bin/sh\n: > "+wtCalled+"\nprintf 'Path: %s\\n' '"+worktree+"'\n")
		testutil.WriteStub(t, dir, "tmux", stubTmuxScript(newWindowLog))
		testutil.WriteStub(t, dir, "fab", "#!/bin/sh\necho 'claude'\n")
		t.Setenv("PATH", dir)

		res, err := Spawn(context.Background(), Options{
			RepoRoot: repoRoot,
			Where:    "worktree",
		})
		if err != nil {
			t.Fatalf("Spawn(worktree) error: %v", err)
		}
		if _, statErr := os.Stat(wtCalled); statErr != nil {
			t.Error("worktree mode did not invoke wt create")
		}
		gotName, gotRoot := readNewWindowArgs(t, newWindowLog)
		if want := "riff-swift-fox"; gotName != want {
			t.Errorf("worktree window name (base) = %q, want %q", gotName, want)
		}
		if gotRoot != worktree {
			t.Errorf("worktree window root (-c) = %q, want the wt path %q", gotRoot, worktree)
		}
		if res.WindowName != "riff-swift-fox" {
			t.Errorf("Result.WindowName = %q, want riff-swift-fox", res.WindowName)
		}
	})
}

// TestResumeForkLauncher covers the conversation-fork launcher suffix
// (260806-s4av): a valid uuid appends `--resume <uuid> --fork-session` to the
// LAUNCHER half of a claude launcher; every non-uuid input (empty, malformed,
// shell-significant) leaves the launcher untouched — the shape check is the guard
// keeping such input out of the deliberately-unescaped launcher string
// (constitution §I) — and a valid uuid with a NON-claude launcher is a
// ValidationErr rather than either silent alternative. The plain=true rows lock
// the plain-resume form (`--resume <uuid>` alone) under the SAME gates; the
// plain=false rows are the byte-identical fork-form regression lock.
func TestResumeForkLauncher(t *testing.T) {
	const validRef = "5d80479e-8f25-46cd-a0d4-e51435508a37"
	cases := []struct {
		name     string
		launcher string
		ref      string
		plain    bool
		want     string
		wantErr  bool
	}{
		{
			name:     "valid uuid appends both flags",
			launcher: "claude --dangerously-skip-permissions",
			ref:      validRef,
			want:     "claude --dangerously-skip-permissions --resume " + validRef + " --fork-session",
		},
		{
			name:     "an absolute claude path is still claude",
			launcher: "/opt/homebrew/bin/claude --dangerously-skip-permissions",
			ref:      validRef,
			want:     "/opt/homebrew/bin/claude --dangerously-skip-permissions --resume " + validRef + " --fork-session",
		},
		{
			name:     "plain mode composes --resume without --fork-session",
			launcher: "claude --dangerously-skip-permissions",
			ref:      validRef,
			plain:    true,
			want:     "claude --dangerously-skip-permissions --resume " + validRef,
		},
		{
			name:     "plain mode on an absolute claude path",
			launcher: "/opt/homebrew/bin/claude --dangerously-skip-permissions",
			ref:      validRef,
			plain:    true,
			want:     "/opt/homebrew/bin/claude --dangerously-skip-permissions --resume " + validRef,
		},
		{
			name:     "plain mode keeps the empty-ref no-op",
			launcher: "claude --dangerously-skip-permissions",
			ref:      "",
			plain:    true,
			want:     "claude --dangerously-skip-permissions",
		},
		{
			name:     "plain mode keeps the malformed-ref degrade",
			launcher: "claude",
			ref:      "foo; rm -rf /",
			plain:    true,
			want:     "claude",
		},
		{
			name:     "plain mode keeps the claude-only gate",
			launcher: "codex --yolo",
			ref:      validRef,
			plain:    true,
			wantErr:  true,
		},
		{
			name:     "empty ref leaves the launcher byte-identical",
			launcher: "claude --dangerously-skip-permissions",
			ref:      "",
			want:     "claude --dangerously-skip-permissions",
		},
		{
			// The gate only fires for a fork: an ordinary spawn on a non-claude
			// launcher is untouched, which is what keeps every existing path
			// byte-identical.
			name:     "empty ref on a NON-claude launcher spawns normally",
			launcher: "codex --yolo",
			ref:      "",
			want:     "codex --yolo",
		},
		{
			name:     "shell-injection attempt is rejected by the shape check",
			launcher: "claude",
			ref:      "foo; rm -rf /",
			want:     "claude",
		},
		{
			name:     "path traversal is rejected by the shape check",
			launcher: "claude",
			ref:      "../../etc/passwd",
			want:     "claude",
		},
		{
			name:     "uppercase hex is rejected (strict lowercase shape)",
			launcher: "claude",
			ref:      "5D80479E-8F25-46CD-A0D4-E51435508A37",
			want:     "claude",
		},
		{
			name:     "truncated uuid is rejected",
			launcher: "claude",
			ref:      "5d80479e-8f25-46cd-a0d4",
			want:     "claude",
		},
		{
			name:     "trailing content after a valid uuid is rejected (anchored)",
			launcher: "claude",
			ref:      validRef + " --dangerously-skip-permissions",
			want:     "claude",
		},
		{
			// A mixed-provider repo whose DEFAULT tier is not claude: the source
			// window's provider gate says nothing about the destination launcher.
			name:     "codex launcher forks with its subcommand",
			launcher: "codex --yolo",
			ref:      validRef,
			want:     "codex --yolo fork " + validRef,
		},
		{
			name:     "gemini launcher + valid ref is a ValidationErr",
			launcher: "gemini",
			ref:      validRef,
			wantErr:  true,
		},
		{
			// A launcher rk cannot positively identify as claude is rejected too —
			// the word split is a gate, not a shell parser.
			name:     "env-prefixed claude is not positively identified",
			launcher: "env FOO=1 claude",
			ref:      validRef,
			wantErr:  true,
		},
		{
			name:     "empty launcher + valid ref is a ValidationErr",
			launcher: "",
			ref:      validRef,
			wantErr:  true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := resumeForkLauncher(tc.launcher, tc.ref, tc.plain)
			if tc.wantErr {
				var ec *ExitCodeError
				if !errors.As(err, &ec) || ec.Code != ExitValidation {
					t.Fatalf("resumeForkLauncher(%q, %q, %t) error = %v, want an ExitValidation ExitCodeError", tc.launcher, tc.ref, tc.plain, err)
				}
				// The message names the offending launcher so the 400 is actionable.
				if tc.launcher != "" && !strings.Contains(ec.Msg, tc.launcher) {
					t.Errorf("error message = %q, want it to name the launcher %q", ec.Msg, tc.launcher)
				}
				if got != "" {
					t.Errorf("launcher = %q on the error path, want it empty (nothing composed)", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("resumeForkLauncher(%q, %q, %t) unexpected error: %v", tc.launcher, tc.ref, tc.plain, err)
			}
			if got != tc.want {
				t.Errorf("resumeForkLauncher(%q, %q, %t) = %q, want %q", tc.launcher, tc.ref, tc.plain, got, tc.want)
			}
		})
	}
}

// TestSpawn_ResumeForkNonClaudeLauncher is the end-to-end half of the launcher
// gate: a fork whose resolved launcher is not claude must fail the spawn with
// ExitValidation (which the fork handler maps to 400) and create NOTHING — no wt
// call, no tmux window.
func TestSpawn_ResumeForkNonClaudeLauncher(t *testing.T) {
	dir := t.TempDir()
	repoRoot := filepath.Join(t.TempDir(), "my-checkout")
	if err := os.MkdirAll(repoRoot, 0o755); err != nil {
		t.Fatalf("mkdir repoRoot: %v", err)
	}

	// Stubs that FAIL the test if invoked — the gate must short-circuit before any
	// subprocess (riff's validation-before-subprocess discipline).
	wtCalled := filepath.Join(dir, "wt-called")
	tmuxCalled := filepath.Join(dir, "tmux-called")
	testutil.WriteStub(t, dir, "wt", "#!/bin/sh\n: > "+wtCalled+"\nexit 1\n")
	testutil.WriteStub(t, dir, "tmux", "#!/bin/sh\n: > "+tmuxCalled+"\nexit 1\n")
	// The repo's default tier resolves a NON-claude launcher.
	testutil.WriteStub(t, dir, "fab", "#!/bin/sh\necho 'codex --yolo'\n")
	t.Setenv("PATH", dir)

	_, err := Spawn(context.Background(), Options{
		RepoRoot:         repoRoot,
		Where:            "checkout",
		ResumeSessionRef: "5d80479e-8f25-46cd-a0d4-e51435508a37",
		WindowNameBase:   "feature-work-fork",
	})

	var ec *ExitCodeError
	if !errors.As(err, &ec) || ec.Code != ExitValidation {
		t.Fatalf("Spawn error = %v, want an ExitValidation ExitCodeError", err)
	}
	if !strings.Contains(ec.Msg, "codex --yolo") {
		t.Errorf("error message = %q, want it to name the resolved launcher", ec.Msg)
	}
	if _, statErr := os.Stat(wtCalled); statErr == nil {
		t.Error("wt was invoked on the launcher-gate path; nothing must be created")
	}
	if _, statErr := os.Stat(tmuxCalled); statErr == nil {
		t.Error("tmux was invoked on the launcher-gate path; nothing must be created")
	}
}

// TestWindowNameBase covers the fork endpoint's window-name-base seam
// (260806-s4av): a non-empty spec.WindowNameBase replaces the path-derived
// `riff-<basename>`; a blank one keeps today's derivation. Collision suffixing is
// resolveWindowName's job and is covered by TestResolveWindowName — the pairing
// (explicit base + collision) is asserted here to lock the composition.
func TestWindowNameBase(t *testing.T) {
	t.Run("blank base derives riff-<basename> from the window root", func(t *testing.T) {
		got := windowNameBase("/home/u/code/proj.worktrees/swift-fox", EffectiveSpec{})
		if want := "riff-swift-fox"; got != want {
			t.Errorf("windowNameBase = %q, want %q", got, want)
		}
	})

	t.Run("explicit base replaces the path derivation", func(t *testing.T) {
		got := windowNameBase("/home/u/code/proj", EffectiveSpec{WindowNameBase: "feature-work-fork"})
		if want := "feature-work-fork"; got != want {
			t.Errorf("windowNameBase = %q, want %q", got, want)
		}
	})

	t.Run("explicit base still collision-suffixes", func(t *testing.T) {
		base := windowNameBase("/irrelevant", EffectiveSpec{WindowNameBase: "feature-work-fork"})
		got := resolveWindowName([]string{"feature-work-fork"}, base)
		if want := "feature-work-fork-2"; got != want {
			t.Errorf("resolveWindowName = %q, want %q", got, want)
		}
	})
}

// TestSpawn_ResumeFork is the end-to-end fork composition (260806-s4av): a
// checkout-mode Spawn carrying ResumeSessionRef + WindowNameBase must (a) skip wt
// entirely, (b) name the window from the explicit base, (c) root the window at
// the repo root (SAME directory as the source), and (d) emit the resume flags
// inside the pane's shell string, attached to the launcher.
func TestSpawn_ResumeFork(t *testing.T) {
	const ref = "5d80479e-8f25-46cd-a0d4-e51435508a37"
	dir := t.TempDir()
	repoRoot := filepath.Join(t.TempDir(), "my-checkout")
	if err := os.MkdirAll(repoRoot, 0o755); err != nil {
		t.Fatalf("mkdir repoRoot: %v", err)
	}
	newWindowLog := filepath.Join(dir, "new-window.log")

	wtCalled := filepath.Join(dir, "wt-called")
	testutil.WriteStub(t, dir, "wt", "#!/bin/sh\n: > "+wtCalled+"\nexit 1\n")
	testutil.WriteStub(t, dir, "tmux", stubTmuxScript(newWindowLog))
	testutil.WriteStub(t, dir, "fab", "#!/bin/sh\necho 'claude --dangerously-skip-permissions'\n")
	t.Setenv("PATH", dir)

	res, err := Spawn(context.Background(), Options{
		RepoRoot:         repoRoot,
		Where:            "checkout",
		ResumeSessionRef: ref,
		WindowNameBase:   "feature-work-fork",
	})
	if err != nil {
		t.Fatalf("Spawn(fork) error: %v", err)
	}
	if _, statErr := os.Stat(wtCalled); statErr == nil {
		t.Error("a fork invoked wt create; a same-worktree fork must skip wt entirely")
	}

	gotName, gotRoot := readNewWindowArgs(t, newWindowLog)
	if want := "feature-work-fork"; gotName != want {
		t.Errorf("fork window name = %q, want %q", gotName, want)
	}
	if gotRoot != repoRoot {
		t.Errorf("fork window root (-c) = %q, want the SAME repo root %q", gotRoot, repoRoot)
	}
	if res.WindowName != "feature-work-fork" {
		t.Errorf("Result.WindowName = %q, want feature-work-fork", res.WindowName)
	}

	// The resume flags must land in the pane's shell string ATTACHED TO THE
	// LAUNCHER (`claude … --resume <uuid> --fork-session`), not as a separate
	// quoted positional.
	logged, readErr := os.ReadFile(newWindowLog)
	if readErr != nil {
		t.Fatalf("read new-window log: %v", readErr)
	}
	wantFragment := "claude --dangerously-skip-permissions --resume " + ref + " --fork-session"
	if !strings.Contains(string(logged), wantFragment) {
		t.Errorf("new-window argv missing the resume suffix %q; got %q", wantFragment, string(logged))
	}
}

// TestSpawn_ResumePlain is the end-to-end plain-resume composition: a
// checkout-mode Spawn carrying ResumeSessionRef + ResumePlain must emit
// `--resume <uuid>` attached to the launcher with NO `--fork-session` anywhere
// in the composed argv (a fork would mint a fresh session id; the plain form
// re-attaches the conversation under the same id).
func TestSpawn_ResumePlain(t *testing.T) {
	const ref = "5d80479e-8f25-46cd-a0d4-e51435508a37"
	dir := t.TempDir()
	repoRoot := filepath.Join(t.TempDir(), "my-checkout")
	if err := os.MkdirAll(repoRoot, 0o755); err != nil {
		t.Fatalf("mkdir repoRoot: %v", err)
	}
	newWindowLog := filepath.Join(dir, "new-window.log")

	testutil.WriteStub(t, dir, "tmux", stubTmuxScript(newWindowLog))
	testutil.WriteStub(t, dir, "fab", "#!/bin/sh\necho 'claude --dangerously-skip-permissions'\n")
	t.Setenv("PATH", dir)

	_, err := Spawn(context.Background(), Options{
		RepoRoot:         repoRoot,
		Where:            "checkout",
		ResumeSessionRef: ref,
		ResumePlain:      true,
	})
	if err != nil {
		t.Fatalf("Spawn(plain resume) error: %v", err)
	}

	logged, readErr := os.ReadFile(newWindowLog)
	if readErr != nil {
		t.Fatalf("read new-window log: %v", readErr)
	}
	wantFragment := "claude --dangerously-skip-permissions --resume " + ref
	if !strings.Contains(string(logged), wantFragment) {
		t.Errorf("new-window argv missing the plain resume suffix %q; got %q", wantFragment, string(logged))
	}
	if strings.Contains(string(logged), "--fork-session") {
		t.Errorf("new-window argv must not carry --fork-session in plain mode; got %q", string(logged))
	}
}

// stubTmuxScript returns a `tmux` stub that satisfies the single-bare-skill-pane
// spawn sequence (list-windows → new-window -P → select-pane → display-message)
// and appends the `new-window` invocation's args to newWindowLog so the test can
// read back the chosen -n/-c values. Any unhandled subcommand exits 0 (a no-op)
// so a future extra tmux call never wedges the test on this stub.
func stubTmuxScript(newWindowLog string) string {
	return "#!/bin/sh\n" +
		"case \"$1\" in\n" +
		"  list-windows) exit 0 ;;\n" + // no existing windows → base is free
		"  new-window) printf '%s\\n' \"$*\" >> " + newWindowLog + "; echo '%1' ;;\n" +
		"  select-pane) exit 0 ;;\n" +
		"  display-message) echo '@7' ;;\n" +
		"  *) exit 0 ;;\n" +
		"esac\n"
}

// readNewWindowArgs parses the stub tmux new-window log and returns the value
// following `-n` (the window name/base) and the value following `-c` (the working
// dir). The logged line is the space-joined `$*` of the new-window invocation.
func readNewWindowArgs(t *testing.T, logPath string) (name, root string) {
	t.Helper()
	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read new-window log: %v", err)
	}
	fields := strings.Fields(strings.TrimSpace(string(data)))
	// Take the FIRST occurrence of each flag: the engine emits `-n <base>` and
	// `-c <root>` BEFORE the trailing shell-string positional, which itself
	// contains a `-c` (`… -i -c 'claude' …`) that a last-wins scan would pick up.
	for i := 0; i < len(fields)-1; i++ {
		if fields[i] == "-n" && name == "" {
			name = fields[i+1]
		}
		if fields[i] == "-c" && root == "" {
			root = fields[i+1]
		}
	}
	if name == "" || root == "" {
		t.Fatalf("new-window log missing -n/-c: %q", string(data))
	}
	return name, root
}

// TestResolveLayout covers canonical-name passthrough, shortform resolution, and
// unknown-value error rules.
func TestResolveLayout(t *testing.T) {
	cases := []struct {
		name      string
		in        string
		want      string
		wantError bool
	}{
		{name: "canonical tiled", in: "tiled", want: "tiled"},
		{name: "canonical even-horizontal", in: "even-horizontal", want: "even-horizontal"},
		{name: "canonical even-vertical", in: "even-vertical", want: "even-vertical"},
		{name: "canonical main-horizontal", in: "main-horizontal", want: "main-horizontal"},
		{name: "canonical main-vertical", in: "main-vertical", want: "main-vertical"},
		{name: "canonical auto", in: "auto", want: "auto"},
		{name: "shortform t", in: "t", want: "tiled"},
		{name: "shortform h", in: "h", want: "even-horizontal"},
		{name: "shortform v", in: "v", want: "even-vertical"},
		{name: "shortform deck-h", in: "deck-h", want: "main-horizontal"},
		{name: "shortform deck-v", in: "deck-v", want: "main-vertical"},
		{name: "shortform a", in: "a", want: "auto"},
		{name: "unknown value errors", in: "diagonal", wantError: true},
		{name: "empty string errors", in: "", wantError: true},
		{name: "uppercase errors", in: "TILED", wantError: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ResolveLayout(tc.in)
			if tc.wantError {
				if err == nil {
					t.Fatalf("expected error, got nil (got = %q)", got)
				}
				msg := err.Error()
				for _, want := range []string{"auto", "tiled", "even-horizontal", "even-vertical", "main-horizontal", "main-vertical", "a", "t", "h", "v", "deck-h", "deck-v"} {
					if !strings.Contains(msg, want) {
						t.Errorf("error message missing %q (msg = %q)", want, msg)
					}
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Errorf("ResolveLayout(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestAutoLayout(t *testing.T) {
	cases := []struct {
		count int
		want  string
	}{
		{0, ""},
		{1, ""},
		{2, "even-horizontal"},
		{3, "tiled"},
		{4, "tiled"},
		{10, "tiled"},
	}
	for _, tc := range cases {
		got := autoLayout(tc.count)
		if got != tc.want {
			t.Errorf("autoLayout(%d) = %q, want %q", tc.count, got, tc.want)
		}
	}
}

// TestResolveActivePreset covers positional match, positional non-match,
// --preset resolution, conflict, unknown preset, and no-preset-available.
func TestResolveActivePreset(t *testing.T) {
	presets := map[string]string{
		"ship":        "/fab-fff",
		"investigate": "/fab-discuss",
	}
	t.Run("positional match consumes arg", func(t *testing.T) {
		p, rem, err := ResolveActivePreset([]string{"ship", "--", "--base", "main"}, "ship", "", presets)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if p == nil || p.Name != "ship" || p.Skill != "/fab-fff" {
			t.Errorf("preset = %#v, want ship", p)
		}
		if !reflect.DeepEqual(rem, []string{"--", "--base", "main"}) {
			t.Errorf("remaining = %v", rem)
		}
	})
	t.Run("positional non-match leaves args untouched", func(t *testing.T) {
		p, rem, err := ResolveActivePreset([]string{"nosuch"}, "nosuch", "", presets)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if p != nil {
			t.Errorf("preset = %#v, want nil", p)
		}
		if !reflect.DeepEqual(rem, []string{"nosuch"}) {
			t.Errorf("remaining = %v", rem)
		}
	})
	t.Run("--preset flag resolves", func(t *testing.T) {
		p, _, err := ResolveActivePreset(nil, "", "investigate", presets)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if p == nil || p.Name != "investigate" || p.Skill != "/fab-discuss" {
			t.Errorf("preset = %#v, want investigate", p)
		}
	})
	t.Run("conflict positional + --preset", func(t *testing.T) {
		_, _, err := ResolveActivePreset([]string{"ship"}, "ship", "investigate", presets)
		if err == nil {
			t.Fatalf("expected error, got nil")
		}
		if !strings.Contains(err.Error(), "mutually exclusive") {
			t.Errorf("error missing 'mutually exclusive': %v", err)
		}
	})
	t.Run("unknown preset via --preset", func(t *testing.T) {
		_, _, err := ResolveActivePreset(nil, "", "nope", presets)
		if err == nil {
			t.Fatalf("expected error, got nil")
		}
		if !strings.Contains(err.Error(), "unknown preset") {
			t.Errorf("error missing 'unknown preset': %v", err)
		}
		if !strings.Contains(err.Error(), "ship") || !strings.Contains(err.Error(), "investigate") {
			t.Errorf("error should list defined presets: %v", err)
		}
	})
	t.Run("no preset available returns nil", func(t *testing.T) {
		p, rem, err := ResolveActivePreset([]string{"ship"}, "ship", "", nil)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if p != nil {
			t.Errorf("preset = %#v, want nil", p)
		}
		if !reflect.DeepEqual(rem, []string{"ship"}) {
			t.Errorf("remaining = %v", rem)
		}
	})
}

// TestResolveEffectiveSpec covers pane/layout/passthrough resolution rules.
func TestResolveEffectiveSpec(t *testing.T) {
	t.Run("preset pane used when no CLI panes", func(t *testing.T) {
		preset := &Preset{Name: "incognito", Skill: "/fab-incognito"}
		spec, err := ResolveEffectiveSpec(nil, false, "auto", 1, preset, nil)
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		want := []PaneSpec{{Kind: PaneKindSkill, Value: "/fab-incognito"}}
		if !reflect.DeepEqual(spec.Panes, want) {
			t.Errorf("panes = %#v, want %#v", spec.Panes, want)
		}
	})
	t.Run("CLI panes replace preset panes", func(t *testing.T) {
		preset := &Preset{Name: "incognito", Skill: "/fab-incognito"}
		cli := []PaneSpec{{Kind: PaneKindSkill, Value: "/review"}}
		spec, err := ResolveEffectiveSpec(cli, false, "auto", 1, preset, nil)
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if len(spec.Panes) != 1 || spec.Panes[0].Value != "/review" {
			t.Errorf("panes = %#v, want 1 review pane", spec.Panes)
		}
	})
	t.Run("explicit CLI layout wins", func(t *testing.T) {
		cli := []PaneSpec{
			{Kind: PaneKindSkill, Value: "/a"},
			{Kind: PaneKindCmd, Value: "x"},
		}
		spec, err := ResolveEffectiveSpec(cli, true, "even-vertical", 1, nil, nil)
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if spec.Layout != "even-vertical" {
			t.Errorf("layout = %q, want even-vertical", spec.Layout)
		}
	})
	t.Run("explicit --layout auto resolves auto-by-count", func(t *testing.T) {
		cli := []PaneSpec{
			{Kind: PaneKindSkill, Value: "/a"},
			{Kind: PaneKindCmd, Value: "x"},
		}
		spec, err := ResolveEffectiveSpec(cli, true, "auto", 1, nil, nil)
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if spec.Layout != "even-horizontal" {
			t.Errorf("layout = %q, want even-horizontal (auto for 2 panes)", spec.Layout)
		}
	})
	t.Run("single-pane window suppresses layout regardless of source", func(t *testing.T) {
		cli := []PaneSpec{{Kind: PaneKindSkill, Value: "/fab-fff"}}
		spec, err := ResolveEffectiveSpec(cli, true, "main-horizontal", 1, nil, nil)
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if spec.Layout != "" {
			t.Errorf("layout = %q, want empty (1-pane suppression)", spec.Layout)
		}
	})
	t.Run("preset with empty skill yields one bare pane and empty layout", func(t *testing.T) {
		preset := &Preset{Name: "blank", Skill: ""}
		spec, err := ResolveEffectiveSpec(nil, false, "auto", 1, preset, nil)
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		want := []PaneSpec{{Kind: PaneKindSkill, Value: ""}}
		if !reflect.DeepEqual(spec.Panes, want) {
			t.Errorf("panes = %#v, want %#v (one bare skill pane)", spec.Panes, want)
		}
		if spec.Layout != "" {
			t.Errorf("layout = %q, want empty", spec.Layout)
		}
	})
	t.Run("passthrough is exactly the user's -- args", func(t *testing.T) {
		preset := &Preset{Name: "blank", Skill: ""}
		spec, err := ResolveEffectiveSpec(nil, false, "auto", 1, preset, []string{"--base", "main", "--reuse"})
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		want := []string{"--base", "main", "--reuse"}
		if !reflect.DeepEqual(spec.Passthrough, want) {
			t.Errorf("passthrough = %v, want %v", spec.Passthrough, want)
		}
	})
	t.Run("no panes anywhere defaults to single /fab-discuss pane", func(t *testing.T) {
		spec, err := ResolveEffectiveSpec(nil, false, "auto", 1, nil, nil)
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		want := []PaneSpec{{Kind: PaneKindSkill, Value: DefaultRiffSkill}}
		if !reflect.DeepEqual(spec.Panes, want) {
			t.Errorf("panes = %#v, want %#v", spec.Panes, want)
		}
	})
	t.Run("count respects CLI value", func(t *testing.T) {
		spec, err := ResolveEffectiveSpec(nil, false, "auto", 5, nil, nil)
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if spec.Count != 5 {
			t.Errorf("count = %d, want 5", spec.Count)
		}
	})
}

// TestApplySkillPrefix covers the spec-finalization normalization: every skill
// pane's non-empty value is rendered through the prefix exactly once, cmd panes
// and bare skill panes are untouched, an empty prefix is the identity, and the
// input spec's slice is never mutated (copy-on-write).
func TestApplySkillPrefix(t *testing.T) {
	cases := []struct {
		name   string
		prefix string
		panes  []PaneSpec
		want   []PaneSpec
	}{
		{
			name:   "codex prefix renders every skill pane",
			prefix: "$",
			panes: []PaneSpec{
				{Kind: PaneKindSkill, Value: "/fab-discuss"},
				{Kind: PaneKindCmd, Value: "just dev"},
				{Kind: PaneKindSkill, Value: "/fab-continue finish it"},
			},
			want: []PaneSpec{
				{Kind: PaneKindSkill, Value: "$fab-discuss"},
				{Kind: PaneKindCmd, Value: "just dev"},
				{Kind: PaneKindSkill, Value: "$fab-continue finish it"},
			},
		},
		{
			name:   "prose tasks and bare skill panes pass through",
			prefix: "$",
			panes: []PaneSpec{
				{Kind: PaneKindSkill, Value: "fix the bug in X"},
				{Kind: PaneKindSkill, Value: ""},
			},
			want: []PaneSpec{
				{Kind: PaneKindSkill, Value: "fix the bug in X"},
				{Kind: PaneKindSkill, Value: ""},
			},
		},
		{
			name:   "empty prefix is the identity",
			prefix: "",
			panes:  []PaneSpec{{Kind: PaneKindSkill, Value: "/fab-discuss"}},
			want:   []PaneSpec{{Kind: PaneKindSkill, Value: "/fab-discuss"}},
		},
		{
			name:   "slash prefix is byte-identical",
			prefix: "/",
			panes: []PaneSpec{
				{Kind: PaneKindSkill, Value: "/fab-discuss"},
				{Kind: PaneKindCmd, Value: "htop"},
			},
			want: []PaneSpec{
				{Kind: PaneKindSkill, Value: "/fab-discuss"},
				{Kind: PaneKindCmd, Value: "htop"},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			spec := EffectiveSpec{SkillPrefix: tc.prefix, Panes: tc.panes}
			orig := append([]PaneSpec(nil), tc.panes...)
			got := ApplySkillPrefix(spec)
			if !reflect.DeepEqual(got.Panes, tc.want) {
				t.Errorf("ApplySkillPrefix() panes = %#v, want %#v", got.Panes, tc.want)
			}
			if !reflect.DeepEqual(spec.Panes, orig) {
				t.Errorf("input spec mutated: %#v (was %#v)", spec.Panes, orig)
			}
		})
	}
}

// TestComposePanes covers the endpoint's (task, preset) → CLI-pane mapping — in
// particular the blank-agent-vs-/fab-discuss distinction the CLI default does
// NOT share. A nil result means "defer to preset/default"; a non-nil result
// means "these panes replace the preset's".
func TestComposePanes(t *testing.T) {
	preset := &Preset{Name: "incognito", Skill: "/fab-incognito"}
	barePreset := &Preset{Name: "blank", Skill: ""}

	cases := []struct {
		name   string
		task   string
		preset *Preset
		want   []PaneSpec
	}{
		{
			name: "task only → single task skill pane",
			task: "fix the bug",
			want: []PaneSpec{{Kind: PaneKindSkill, Value: "fix the bug"}},
		},
		{
			name:   "task + preset → task pane replaces the preset's pane",
			task:   "ship it",
			preset: preset,
			want:   []PaneSpec{{Kind: PaneKindSkill, Value: "ship it"}},
		},
		{
			name:   "empty task + preset → nil (defer to the preset's pane)",
			task:   "",
			preset: preset,
			want:   nil,
		},
		{
			name:   "empty task + bare preset → nil (defer to the preset's bare pane)",
			task:   "",
			preset: barePreset,
			want:   nil,
		},
		{
			name: "empty task + no preset → single BARE skill pane (blank agent, NOT /fab-discuss)",
			task: "",
			want: []PaneSpec{{Kind: PaneKindSkill, Value: ""}},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := composePanes(tc.task, tc.preset)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("composePanes(%q, %v) = %#v, want %#v", tc.task, tc.preset, got, tc.want)
			}
			// Guard the blank-agent invariant explicitly: the endpoint's default
			// pane must never be the CLI's /fab-discuss fallback.
			for _, p := range got {
				if p.Value == DefaultRiffSkill {
					t.Errorf("composePanes must not emit the CLI /fab-discuss default; got %#v", got)
				}
			}
		})
	}
}

// TestBuildSpawnArgvs exercises the pure argv-construction helper. select-pane
// is no longer emitted by buildSpawnArgvs — it is constructed at runtime by the
// orchestrator from the captured pane id. The server prefix is NOT included
// here either (tmuxArgv adds it at exec time).
func TestBuildSpawnArgvs(t *testing.T) {
	worktree := "/tmp/wt/alpha"
	name := "riff-alpha"
	launcher := "claude"

	t.Run("single skill pane (auto layout → no select-layout)", func(t *testing.T) {
		spec := EffectiveSpec{
			Panes:    []PaneSpec{{Kind: PaneKindSkill, Value: "/fab-discuss"}},
			Layout:   "",
			Launcher: launcher,
		}
		got := buildSpawnArgvs(worktree, name, spec)
		if len(got) != 1 {
			t.Fatalf("got %d argvs, want 1 (new-window only)", len(got))
		}
		if got[0][0] != "new-window" {
			t.Errorf("argv[0][0] = %q, want new-window", got[0][0])
		}
		for _, argv := range got {
			if argv[0] == "select-pane" {
				t.Errorf("buildSpawnArgvs unexpectedly returned a select-pane row: %v", argv)
			}
		}
	})

	t.Run("2 panes (skill + cmd) with auto → even-horizontal", func(t *testing.T) {
		spec := EffectiveSpec{
			Panes: []PaneSpec{
				{Kind: PaneKindSkill, Value: "/a"},
				{Kind: PaneKindCmd, Value: "just dev"},
			},
			Layout:   "even-horizontal",
			Launcher: launcher,
		}
		got := buildSpawnArgvs(worktree, name, spec)
		if len(got) != 3 {
			t.Fatalf("got %d argvs, want 3 (new-window + split-window + select-layout)", len(got))
		}
		if got[0][0] != "new-window" {
			t.Errorf("argv[0][0] = %q, want new-window", got[0][0])
		}
		if got[1][0] != "split-window" {
			t.Errorf("argv[1][0] = %q, want split-window", got[1][0])
		}
		if got[2][0] != "select-layout" || got[2][len(got[2])-1] != "even-horizontal" {
			t.Errorf("select-layout argv = %v", got[2])
		}
		cmdShell := got[1][len(got[1])-1]
		if !strings.Contains(cmdShell, "just dev") {
			t.Errorf("split-window shell string missing 'just dev': %q", cmdShell)
		}
		if strings.Contains(cmdShell, "${SHELL:-/bin/sh} -i -c") {
			t.Errorf("split-window cmd pane should NOT have interactive wrap: %q", cmdShell)
		}
	})

	t.Run("4 panes interleaved with tiled", func(t *testing.T) {
		spec := EffectiveSpec{
			Panes: []PaneSpec{
				{Kind: PaneKindCmd, Value: ""},
				{Kind: PaneKindSkill, Value: "/fab-discuss"},
				{Kind: PaneKindCmd, Value: "htop"},
				{Kind: PaneKindSkill, Value: ""},
			},
			Layout:   "tiled",
			Launcher: launcher,
		}
		got := buildSpawnArgvs(worktree, name, spec)
		if len(got) != 5 {
			t.Fatalf("got %d argvs, want 5", len(got))
		}
		pane0 := got[0][len(got[0])-1]
		if !strings.Contains(pane0, `exec "${SHELL:-/bin/sh}"`) {
			t.Errorf("pane 0 bare-cmd shell string = %q", pane0)
		}
		pane3 := got[3][len(got[3])-1]
		if !strings.Contains(pane3, "${SHELL:-/bin/sh} -i -c 'claude'") {
			t.Errorf("pane 3 bare-skill shell missing interactive wrap around bare launcher: %q", pane3)
		}
	})

	t.Run("bare --skill alone", func(t *testing.T) {
		spec := EffectiveSpec{
			Panes:    []PaneSpec{{Kind: PaneKindSkill, Value: ""}},
			Layout:   "",
			Launcher: launcher,
		}
		got := buildSpawnArgvs(worktree, name, spec)
		if len(got) != 1 {
			t.Fatalf("got %d argvs, want 1", len(got))
		}
		shell := got[0][len(got[0])-1]
		if strings.Contains(shell, "claude '") {
			t.Errorf("bare --skill should NOT produce claude '<arg>': %q", shell)
		}
	})

	t.Run("bare --cmd alone", func(t *testing.T) {
		spec := EffectiveSpec{
			Panes:    []PaneSpec{{Kind: PaneKindCmd, Value: ""}},
			Layout:   "",
			Launcher: launcher,
		}
		got := buildSpawnArgvs(worktree, name, spec)
		if len(got) != 1 {
			t.Fatalf("got %d argvs, want 1", len(got))
		}
		shell := got[0][len(got[0])-1]
		if shell != `exec "${SHELL:-/bin/sh}"` {
			t.Errorf("bare --cmd shell = %q, want the exec-only form", shell)
		}
	})

	t.Run("daemon path (session → -t =<session>: on new-window, =<session>:<name> on split/layout)", func(t *testing.T) {
		spec := EffectiveSpec{
			Panes: []PaneSpec{
				{Kind: PaneKindSkill, Value: "/a"},
				{Kind: PaneKindCmd, Value: "just dev"},
			},
			Layout:   "even-horizontal",
			Launcher: launcher,
			Session:  "work",
		}
		got := buildSpawnArgvs(worktree, name, spec)
		if len(got) != 3 {
			t.Fatalf("got %d argvs, want 3 (new-window + split-window + select-layout)", len(got))
		}
		// new-window carries `-t =work:` (exact-session form) so the window lands in the requested session.
		wantNewWindow := []string{
			"new-window",
			"-t", "=work:",
			"-n", name,
			"-c", worktree,
			paneShellString(launcher, spec.Panes[0]),
		}
		if !reflect.DeepEqual(got[0], wantNewWindow) {
			t.Errorf("new-window argv =\n  %#v\nwant\n  %#v", got[0], wantNewWindow)
		}
		// split-window + select-layout target the session-scoped window `=work:<name>`.
		wantSplit := []string{
			"split-window",
			"-h",
			"-t", "=work:" + name,
			"-c", worktree,
			paneShellString(launcher, spec.Panes[1]),
		}
		if !reflect.DeepEqual(got[1], wantSplit) {
			t.Errorf("split-window argv =\n  %#v\nwant\n  %#v", got[1], wantSplit)
		}
		wantLayout := []string{"select-layout", "-t", "=work:" + name, "even-horizontal"}
		if !reflect.DeepEqual(got[2], wantLayout) {
			t.Errorf("select-layout argv =\n  %#v\nwant\n  %#v", got[2], wantLayout)
		}
	})
}

// TestPlanFanOutRollback exercises the pure rollback-plan builder.
func TestPlanFanOutRollback(t *testing.T) {
	t.Run("all succeeded except index 1", func(t *testing.T) {
		results := []fanOutResult{
			{Index: 0, WorktreePath: "/tmp/wt/a", WindowName: "riff-a", Err: nil},
			{Index: 1, WorktreePath: "", WindowName: "", Err: errTestFail},
			{Index: 2, WorktreePath: "/tmp/wt/c", WindowName: "riff-c", Err: nil},
		}
		plan := planFanOutRollback(results, 1)
		if !reflect.DeepEqual(plan.Worktrees, []string{"a", "c"}) {
			t.Errorf("worktrees = %v, want [a c]", plan.Worktrees)
		}
		if !reflect.DeepEqual(plan.Windows, []string{"riff-a", "riff-c"}) {
			t.Errorf("windows = %v, want [riff-a riff-c]", plan.Windows)
		}
	})
	t.Run("partial success — worktree created but window failed", func(t *testing.T) {
		results := []fanOutResult{
			{Index: 0, WorktreePath: "/tmp/wt/a", WindowName: "riff-a", Err: nil},
			{Index: 1, WorktreePath: "/tmp/wt/b", WindowName: "", Err: errTestFail},
		}
		plan := planFanOutRollback(results, 1)
		if !reflect.DeepEqual(plan.Worktrees, []string{"a"}) {
			t.Errorf("worktrees = %v, want [a] (index 1's partial worktree excluded)", plan.Worktrees)
		}
		if !reflect.DeepEqual(plan.Windows, []string{"riff-a"}) {
			t.Errorf("windows = %v, want [riff-a]", plan.Windows)
		}
	})
	t.Run("no failures — plan includes all (caller shouldn't invoke)", func(t *testing.T) {
		results := []fanOutResult{
			{Index: 0, WorktreePath: "/tmp/wt/a", WindowName: "riff-a", Err: nil},
		}
		plan := planFanOutRollback(results, -1)
		if len(plan.Worktrees) != 1 || plan.Worktrees[0] != "a" {
			t.Errorf("worktrees = %v", plan.Worktrees)
		}
	})
}

var errTestFail = &ExitCodeError{Code: ExitSubprocess, Msg: "test"}

// stubLoadRiffPresets points the preset-source seam at a fixed table for the
// test's duration, so Spawn's preset resolution never touches the config root.
func stubLoadRiffPresets(t *testing.T, presets []settings.RiffPreset) {
	t.Helper()
	orig := loadRiffPresets
	loadRiffPresets = func() []settings.RiffPreset { return presets }
	t.Cleanup(func() { loadRiffPresets = orig })
}

// TestSpawn_PresetFromSettings covers Spawn's settings-backed preset resolution:
// the blank built-in composes a launcher-only shell string (no positional, no
// typed delivery), the incognito built-in renders /fab-incognito through
// ApplySkillPrefix, a user addition resolves through the same seam, and an
// unknown name is a ValidationErr listing the defined names.
func TestSpawn_PresetFromSettings(t *testing.T) {
	userPresets := append(append([]settings.RiffPreset{}, settings.BuiltinRiffPresets...),
		settings.RiffPreset{Name: "review", Skill: "/code-review high"})

	setup := func(t *testing.T) (repoRoot, newWindowLog string) {
		t.Helper()
		dir := t.TempDir()
		repoRoot = filepath.Join(t.TempDir(), "my-checkout")
		if err := os.MkdirAll(repoRoot, 0o755); err != nil {
			t.Fatalf("mkdir repoRoot: %v", err)
		}
		newWindowLog = filepath.Join(dir, "new-window.log")
		testutil.WriteStub(t, dir, "tmux", stubTmuxScript(newWindowLog))
		testutil.WriteStub(t, dir, "fab", "#!/bin/sh\necho 'claude'\n")
		t.Setenv("PATH", dir)
		stubLoadRiffPresets(t, userPresets)
		return repoRoot, newWindowLog
	}

	t.Run("blank built-in spawns the bare launcher", func(t *testing.T) {
		repoRoot, newWindowLog := setup(t)
		_, err := Spawn(context.Background(), Options{RepoRoot: repoRoot, Where: "checkout", Preset: "blank"})
		if err != nil {
			t.Fatalf("Spawn(blank) error: %v", err)
		}
		logged, readErr := os.ReadFile(newWindowLog)
		if readErr != nil {
			t.Fatalf("read new-window log: %v", readErr)
		}
		if !strings.Contains(string(logged), "-i -c 'claude'") {
			t.Errorf("blank shell string = %q, want the bare launcher wrap", string(logged))
		}
		if strings.Contains(string(logged), "claude '\\''") {
			t.Errorf("blank shell string carries a quoted positional: %q", string(logged))
		}
	})

	t.Run("incognito built-in renders /fab-incognito", func(t *testing.T) {
		repoRoot, newWindowLog := setup(t)
		_, err := Spawn(context.Background(), Options{RepoRoot: repoRoot, Where: "checkout", Preset: "incognito"})
		if err != nil {
			t.Fatalf("Spawn(incognito) error: %v", err)
		}
		logged, readErr := os.ReadFile(newWindowLog)
		if readErr != nil {
			t.Fatalf("read new-window log: %v", readErr)
		}
		if !strings.Contains(string(logged), `claude '\''/fab-incognito'\''`) {
			t.Errorf("incognito shell string missing the quoted skill positional: %q", string(logged))
		}
	})

	t.Run("user addition resolves through the same seam", func(t *testing.T) {
		repoRoot, newWindowLog := setup(t)
		_, err := Spawn(context.Background(), Options{RepoRoot: repoRoot, Where: "checkout", Preset: "review"})
		if err != nil {
			t.Fatalf("Spawn(review) error: %v", err)
		}
		logged, readErr := os.ReadFile(newWindowLog)
		if readErr != nil {
			t.Fatalf("read new-window log: %v", readErr)
		}
		if !strings.Contains(string(logged), "/code-review high") {
			t.Errorf("review shell string missing the user skill: %q", string(logged))
		}
	})

	t.Run("unknown preset is a ValidationErr listing the defined names", func(t *testing.T) {
		repoRoot, _ := setup(t)
		_, err := Spawn(context.Background(), Options{RepoRoot: repoRoot, Where: "checkout", Preset: "nope"})
		var ec *ExitCodeError
		if !errors.As(err, &ec) || ec.Code != ExitValidation {
			t.Fatalf("Spawn(nope) error = %v, want an ExitValidation ExitCodeError", err)
		}
		if !strings.Contains(ec.Msg, `unknown preset "nope" (defined: blank, discuss, incognito, review)`) {
			t.Errorf("error message = %q, want the sorted defined-names list", ec.Msg)
		}
	})
}

// TestParsePaneID covers the trimmed-single-line parse rule for the stdout of
// `tmux new-window -P -F '#{pane_id}'`. Pure.
func TestParsePaneID(t *testing.T) {
	cases := []struct {
		name      string
		in        string
		want      string
		wantError bool
	}{
		{name: "typical pane id with newline", in: "%87\n", want: "%87"},
		{name: "leading and trailing whitespace", in: "  %12  \n", want: "%12"},
		{name: "no trailing newline", in: "%3", want: "%3"},
		{name: "tabs trimmed", in: "\t%99\t\n", want: "%99"},
		{name: "empty input errors", in: "", wantError: true},
		{name: "whitespace-only input errors", in: "   \n\t", wantError: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parsePaneID(tc.in)
			if tc.wantError {
				if err == nil {
					t.Fatalf("expected error, got %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Errorf("parsePaneID(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestBuildNewWindowCaptureArgs asserts the argv shape passed to
// `tmux new-window -P -F '#{pane_id}' …` for the first-pane capture step. Pure.
func TestBuildNewWindowCaptureArgs(t *testing.T) {
	shell := `${SHELL:-/bin/sh} -i -c 'claude '\''/fab-discuss'\'''; exec "${SHELL:-/bin/sh}"`

	t.Run("CLI path (empty session → no -t target)", func(t *testing.T) {
		spec := EffectiveSpec{
			Panes:    []PaneSpec{{Kind: PaneKindSkill, Value: "/fab-discuss"}},
			Layout:   "",
			Launcher: "claude",
		}
		got := buildNewWindowCaptureArgs("/tmp/wt/alpha", "riff-alpha", spec)
		want := []string{
			"new-window",
			"-P",
			"-F", "#{pane_id}",
			"-n", "riff-alpha",
			"-c", "/tmp/wt/alpha",
			shell,
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("buildNewWindowCaptureArgs =\n  %#v\nwant\n  %#v", got, want)
		}
	})

	t.Run("daemon path (session → -t =<session>: creates window in it)", func(t *testing.T) {
		spec := EffectiveSpec{
			Panes:    []PaneSpec{{Kind: PaneKindSkill, Value: "/fab-discuss"}},
			Layout:   "",
			Launcher: "claude",
			Session:  "work",
		}
		got := buildNewWindowCaptureArgs("/tmp/wt/alpha", "riff-alpha", spec)
		want := []string{
			"new-window",
			"-P",
			"-F", "#{pane_id}",
			"-t", "=work:",
			"-n", "riff-alpha",
			"-c", "/tmp/wt/alpha",
			shell,
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("buildNewWindowCaptureArgs =\n  %#v\nwant\n  %#v", got, want)
		}
	})
}

// TestBuildWtDeleteArgs asserts the argv shape for the rollback `wt delete`
// subprocess: `--non-interactive` present, name positional, no deprecated
// `--worktree-name`.
func TestBuildWtDeleteArgs(t *testing.T) {
	got := buildWtDeleteArgs("pacing-canyon")
	want := []string{"delete", "--non-interactive", "pacing-canyon"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("buildWtDeleteArgs(%q) = %v, want %v", "pacing-canyon", got, want)
	}
	for _, tok := range got {
		if tok == "--worktree-name" {
			t.Errorf("argv must not contain deprecated --worktree-name flag: %v", got)
		}
	}
	hasNonInteractive := false
	for _, tok := range got {
		if tok == "--non-interactive" {
			hasNonInteractive = true
			break
		}
	}
	if !hasNonInteractive {
		t.Errorf("argv must contain --non-interactive: %v", got)
	}
}

// TestTmuxArgv asserts the server-prefix seam: an empty server label adds no
// `-L` prefix (CLI path, targeting via restored $TMUX), a non-empty label
// prepends `-L <server>` (daemon path).
func TestTmuxArgv(t *testing.T) {
	t.Run("empty server → no prefix", func(t *testing.T) {
		got := tmuxArgv(EffectiveSpec{Server: ""}, "list-windows", "-F", "#W")
		want := []string{"list-windows", "-F", "#W"}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("tmuxArgv(empty) = %v, want %v", got, want)
		}
	})
	t.Run("non-empty server → -L prefix", func(t *testing.T) {
		got := tmuxArgv(EffectiveSpec{Server: "myserver"}, "list-windows")
		want := []string{"-L", "myserver", "list-windows"}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("tmuxArgv(myserver) = %v, want %v", got, want)
		}
	})
}

// stubTmuxWithPanesScript extends stubTmuxScript with a list-panes answer so
// the receipt's pane collection can be pinned (pane 0 first).
func stubTmuxWithPanesScript(newWindowLog, panes string) string {
	return "#!/bin/sh\n" +
		"case \"$1\" in\n" +
		"  list-windows) exit 0 ;;\n" +
		"  new-window) printf '%s\\n' \"$*\" >> " + newWindowLog + "; echo '%20' ;;\n" +
		"  select-pane) exit 0 ;;\n" +
		"  display-message) echo '@9' ;;\n" +
		"  list-panes) printf '%s\\n' " + panes + " ;;\n" +
		"  *) exit 0 ;;\n" +
		"esac\n"
}

// TestRunReceiptCountOne: a count-1 Run returns one SpawnReceipt carrying the
// resolved window id/name, the full pane list (pane 0 first), the worktree
// path, and the branch derived from git.
func TestRunReceiptCountOne(t *testing.T) {
	dir := t.TempDir()
	worktree := t.TempDir()
	newWindowLog := filepath.Join(dir, "new-window.log")

	testutil.WriteStub(t, dir, "wt", "#!/bin/sh\nprintf 'Path: %s\\n' '"+worktree+"'\n")
	testutil.WriteStub(t, dir, "tmux", stubTmuxWithPanesScript(newWindowLog, "'%20' '%21'"))
	testutil.WriteStub(t, dir, "git", "#!/bin/sh\necho 'feature-x'\n")
	t.Setenv("PATH", dir)
	stubDeliverTask(t, func(int) error { return nil })

	spec := EffectiveSpec{
		Count:    1,
		Panes:    []PaneSpec{{Kind: PaneKindSkill, Value: "do X"}},
		Launcher: "kimi --auto",
		RepoRoot: t.TempDir(),
	}
	receipts, err := Run(context.Background(), spec)
	if err != nil {
		t.Fatalf("Run() = %v", err)
	}
	if len(receipts) != 1 {
		t.Fatalf("receipts = %d, want 1", len(receipts))
	}
	r := receipts[0]
	if r.WindowID != "@9" || r.WindowName != "riff-"+filepath.Base(worktree) {
		t.Errorf("receipt window = %q/%q, want @9/riff-%s", r.WindowID, r.WindowName, filepath.Base(worktree))
	}
	if len(r.PaneIDs) != 2 || r.PaneIDs[0] != "%20" || r.PaneIDs[1] != "%21" {
		t.Errorf("panes = %v, want [%%20 %%21] (pane 0 first)", r.PaneIDs)
	}
	if r.WorktreePath != worktree || r.Branch != "feature-x" {
		t.Errorf("worktree/branch = %q/%q, want %q/feature-x", r.WorktreePath, r.Branch, worktree)
	}
}

// TestRunReceiptDegraded: a failed list-panes leaves the captured pane-0 id
// and a failed git leaves the branch empty — neither fails the spawn.
func TestRunReceiptDegraded(t *testing.T) {
	dir := t.TempDir()
	worktree := t.TempDir()
	newWindowLog := filepath.Join(dir, "new-window.log")

	testutil.WriteStub(t, dir, "wt", "#!/bin/sh\nprintf 'Path: %s\\n' '"+worktree+"'\n")
	testutil.WriteStub(t, dir, "tmux", "#!/bin/sh\n"+
		"case \"$1\" in\n"+
		"  list-windows) exit 0 ;;\n"+
		"  new-window) printf '%s\\n' \"$*\" >> "+newWindowLog+"; echo '%20' ;;\n"+
		"  select-pane) exit 0 ;;\n"+
		"  display-message) echo '@9' ;;\n"+
		"  list-panes) exit 1 ;;\n"+
		"  *) exit 0 ;;\n"+
		"esac\n")
	testutil.WriteStub(t, dir, "git", "#!/bin/sh\nexit 1\n")
	t.Setenv("PATH", dir)
	stubDeliverTask(t, func(int) error { return nil })

	spec := EffectiveSpec{
		Count:    1,
		Panes:    []PaneSpec{{Kind: PaneKindSkill, Value: "do X"}},
		Launcher: "kimi --auto",
		RepoRoot: t.TempDir(),
	}
	receipts, err := Run(context.Background(), spec)
	if err != nil {
		t.Fatalf("Run() = %v, want nil (derivation failures never fail the spawn)", err)
	}
	r := receipts[0]
	if len(r.PaneIDs) != 1 || r.PaneIDs[0] != "%20" {
		t.Errorf("panes = %v, want the degraded [%%20]", r.PaneIDs)
	}
	if r.Branch != "" {
		t.Errorf("branch = %q, want empty on a git failure", r.Branch)
	}
}

// TestRunReceiptFanOutOrder: a count-2 fan-out returns one receipt per window
// in index order.
func TestRunReceiptFanOutOrder(t *testing.T) {
	dir := t.TempDir()
	worktree := t.TempDir()
	newWindowLog := filepath.Join(dir, "new-window.log")

	testutil.WriteStub(t, dir, "wt", "#!/bin/sh\nprintf 'Path: %s\\n' '"+worktree+"'\n")
	testutil.WriteStub(t, dir, "tmux", stubTmuxWithPanesScript(newWindowLog, "'%20'"))
	testutil.WriteStub(t, dir, "git", "#!/bin/sh\necho 'main'\n")
	t.Setenv("PATH", dir)
	stubDeliverTask(t, func(int) error { return nil })

	spec := EffectiveSpec{
		Count:    2,
		Panes:    []PaneSpec{{Kind: PaneKindSkill, Value: "do X"}},
		Launcher: "kimi --auto",
		RepoRoot: t.TempDir(),
	}
	receipts, err := Run(context.Background(), spec)
	if err != nil {
		t.Fatalf("Run() = %v", err)
	}
	if len(receipts) != 2 {
		t.Fatalf("receipts = %d, want 2", len(receipts))
	}
	for i, r := range receipts {
		if r.WindowID != "@9" || r.WorktreePath != worktree || r.Branch != "main" {
			t.Errorf("receipt %d = %+v", i, r)
		}
	}
}

func TestSpawn_ProviderFork(t *testing.T) {
	const ref = "5d80479e-8f25-46cd-a0d4-e51435508a37"
	for _, tc := range []struct{ name, launcher, provider, want string }{
		{"codex", "codex --no-alt-screen", "codex", "codex --no-alt-screen fork " + ref},
		{"absolute codex", "/opt/bin/codex --no-alt-screen", "codex", "/opt/bin/codex --no-alt-screen fork " + ref},
		{"codex with claude default", "claude --dangerously-skip-permissions", "codex", "codex fork " + ref},
		{"claude with codex default", "codex --no-alt-screen", "claude", "claude --resume " + ref + " --fork-session"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			repoRoot := filepath.Join(t.TempDir(), "my-checkout")
			if err := os.MkdirAll(repoRoot, 0o755); err != nil {
				t.Fatalf("mkdir repoRoot: %v", err)
			}
			newWindowLog := filepath.Join(dir, "new-window.log")

			wtCalled := filepath.Join(dir, "wt-called")
			testutil.WriteStub(t, dir, "wt", "#!/bin/sh\n: > "+wtCalled+"\nexit 1\n")
			testutil.WriteStub(t, dir, "tmux", stubTmuxScript(newWindowLog))
			testutil.WriteStub(t, dir, "fab", "#!/bin/sh\necho '"+tc.launcher+"'\n")
			t.Setenv("PATH", dir)

			res, err := Spawn(context.Background(), Options{
				RepoRoot:         repoRoot,
				Where:            "checkout",
				ResumeSessionRef: ref,
				ForkProvider:     tc.provider,
				WindowNameBase:   "feature-work-fork",
			})
			if err != nil {
				t.Fatalf("Spawn(fork) error: %v", err)
			}
			if _, statErr := os.Stat(wtCalled); statErr == nil {
				t.Error("a fork invoked wt create; a same-worktree fork must skip wt entirely")
			}

			gotName, gotRoot := readNewWindowArgs(t, newWindowLog)
			if want := "feature-work-fork"; gotName != want {
				t.Errorf("fork window name = %q, want %q", gotName, want)
			}
			if gotRoot != repoRoot {
				t.Errorf("fork window root (-c) = %q, want the SAME repo root %q", gotRoot, repoRoot)
			}
			if res.WindowName != "feature-work-fork" {
				t.Errorf("Result.WindowName = %q, want feature-work-fork", res.WindowName)
			}

			// Assert the actual shell command supplied to tmux.
			logged, readErr := os.ReadFile(newWindowLog)
			if readErr != nil {
				t.Fatalf("read new-window log: %v", readErr)
			}
			wantFragment := tc.want
			if !strings.Contains(string(logged), wantFragment) {
				t.Errorf("new-window argv missing the resume suffix %q; got %q", wantFragment, string(logged))
			}
		})
	}
}
