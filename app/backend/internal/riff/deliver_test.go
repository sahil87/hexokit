package riff

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"rk/internal/testutil"
)

func TestTaskDeliveryMode(t *testing.T) {
	cases := []struct {
		name     string
		launcher string
		task     string
		want     deliveryMode
	}{
		{"empty task", "kimi --auto", "", deliveryNone},
		{"empty task on claude", "claude", "", deliveryNone},
		{"claude positional", "claude --dangerously-skip-permissions", "do X", deliveryPositional},
		{"absolute claude path positional", "/opt/homebrew/bin/claude --foo", "do X", deliveryPositional},
		{"kimi typed", "kimi --auto", "do X", deliveryTyped},
		{"codex typed", "codex --yolo", "do X", deliveryTyped},
		{"env-prefixed claude is not identified → typed", "env FOO=1 claude", "do X", deliveryTyped},
		{"empty launcher + task → typed", "", "do X", deliveryTyped},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := taskDeliveryMode(tc.launcher, tc.task); got != tc.want {
				t.Errorf("taskDeliveryMode(%q, %q) = %v, want %v", tc.launcher, tc.task, got, tc.want)
			}
		})
	}
}

// TestTaskPaneShellString pins the composition-seam branch: a claude launcher's
// task composition is byte-identical to the positional form, and any other
// launcher with a task composes BARE (the task is typed post-boot).
func TestTaskPaneShellString(t *testing.T) {
	claude := "claude --dangerously-skip-permissions"
	taskPane := PaneSpec{Kind: PaneKindSkill, Value: "do X"}

	t.Run("claude task composition is byte-identical to the positional form", func(t *testing.T) {
		want := `${SHELL:-/bin/sh} -i -c 'claude --dangerously-skip-permissions '\''do X'\'''; exec "${SHELL:-/bin/sh}"`
		if got := taskPaneShellString(claude, taskPane); got != want {
			t.Errorf("taskPaneShellString(claude, do X) =\n  %q\nwant\n  %q", got, want)
		}
		if got := taskPaneShellString(claude, taskPane); got != paneShellString(claude, taskPane) {
			t.Errorf("claude composition diverged from paneShellString: %q vs %q", got, paneShellString(claude, taskPane))
		}
	})

	t.Run("non-claude task composes bare", func(t *testing.T) {
		want := buildSkillShellString("kimi --auto", "")
		if got := taskPaneShellString("kimi --auto", taskPane); got != want {
			t.Errorf("taskPaneShellString(kimi, do X) =\n  %q\nwant the bare composition\n  %q", got, want)
		}
		if strings.Contains(taskPaneShellString("kimi --auto", taskPane), "do X") {
			t.Error("a typed-mode composition must not embed the task text")
		}
	})

	t.Run("bare skill pane untouched", func(t *testing.T) {
		pane := PaneSpec{Kind: PaneKindSkill, Value: ""}
		if got := taskPaneShellString("kimi --auto", pane); got != buildSkillShellString("kimi --auto", "") {
			t.Errorf("bare pane composition = %q, want unchanged", got)
		}
	})

	t.Run("cmd pane untouched", func(t *testing.T) {
		pane := PaneSpec{Kind: PaneKindCmd, Value: "htop"}
		if got := taskPaneShellString("kimi --auto", pane); got != buildCmdShellString("htop") {
			t.Errorf("cmd pane composition = %q, want unchanged", got)
		}
	})
}

func TestDeliveryServer(t *testing.T) {
	cases := []struct {
		name string
		spec EffectiveSpec
		want string
	}{
		{"daemon label passes through", EffectiveSpec{Server: "srv"}, "srv"},
		{"CLI path derives the socket basename", EffectiveSpec{OriginalTMUX: "/tmp/tmux-1000/default,4242,0"}, "default"},
		{"CLI path on a named server", EffectiveSpec{OriginalTMUX: "/tmp/tmux-1000/work,4242,0"}, "work"},
		{"empty everywhere → default", EffectiveSpec{}, "default"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := deliveryServer(tc.spec); got != tc.want {
				t.Errorf("deliveryServer() = %q, want %q", got, tc.want)
			}
		})
	}
}

// asyncDelivery records one deliverTaskAsyncFn invocation.
type asyncDelivery struct {
	server, window, paneID, task string
}

// stubAsyncDelivery points the daemon-path delivery seam at a recorder.
func stubAsyncDelivery(t *testing.T) *[]asyncDelivery {
	t.Helper()
	var mu sync.Mutex
	var calls []asyncDelivery
	orig := deliverTaskAsyncFn
	deliverTaskAsyncFn = func(server, window, paneID, task string) {
		mu.Lock()
		defer mu.Unlock()
		calls = append(calls, asyncDelivery{server, window, paneID, task})
	}
	t.Cleanup(func() { deliverTaskAsyncFn = orig })
	return &calls
}

// stubDeliverTask points the delivery seam at a fake; calls records each
// (paneID, task) pair. errFn decides per-call failure.
func stubDeliverTask(t *testing.T, errFn func(call int) error) *[][2]string {
	t.Helper()
	var mu sync.Mutex
	var calls [][2]string
	orig := deliverTaskFn
	deliverTaskFn = func(_ context.Context, _, paneID, task string) error {
		mu.Lock()
		defer mu.Unlock()
		calls = append(calls, [2]string{paneID, task})
		if errFn != nil {
			return errFn(len(calls))
		}
		return nil
	}
	t.Cleanup(func() { deliverTaskFn = orig })
	return &calls
}

// stubCliStderr captures the CLI degrade-warning writer.
func stubCliStderr(t *testing.T) *bytes.Buffer {
	t.Helper()
	buf := &bytes.Buffer{}
	orig := cliStderrFn
	cliStderrFn = func() io.Writer { return buf }
	t.Cleanup(func() { cliStderrFn = orig })
	return buf
}

// stubTmuxScriptServerLabel is stubTmuxScript for the daemon path: the engine
// prefixes every argv with `-L <server>`, which the stub strips before
// dispatching on the subcommand.
func stubTmuxScriptServerLabel(newWindowLog string) string {
	return "#!/bin/sh\n" +
		"if [ \"$1\" = \"-L\" ]; then shift 2; fi\n" +
		"case \"$1\" in\n" +
		"  list-windows) exit 0 ;;\n" +
		"  new-window) printf '%s\\n' \"$*\" >> " + newWindowLog + "; echo '%9' ;;\n" +
		"  select-pane) exit 0 ;;\n" +
		"  display-message) echo '@7' ;;\n" +
		"  *) exit 0 ;;\n" +
		"esac\n"
}

// TestSpawnNonClaudeTaskTypedDelivery: a non-claude launcher + task composes
// pane 0 BARE (no positional task in the new-window argv) and the task is
// handed to the daemon-path delivery seam with the captured pane-0 id.
func TestSpawnNonClaudeTaskTypedDelivery(t *testing.T) {
	dir := t.TempDir()
	repoRoot := t.TempDir()
	newWindowLog := filepath.Join(dir, "new-window.log")

	testutil.WriteStub(t, dir, "wt", wtStubScript(repoRoot, "", ""))
	testutil.WriteStub(t, dir, "tmux", stubTmuxScriptServerLabel(newWindowLog))
	// The repo's default tier resolves a NON-claude launcher.
	testutil.WriteStub(t, dir, "fab", "#!/bin/sh\necho 'kimi --auto'\n")
	t.Setenv("PATH", dir)

	calls := stubAsyncDelivery(t)

	res, err := Spawn(context.Background(), Options{
		Server:   "srv",
		Session:  "work",
		RepoRoot: repoRoot,
		Task:     "do X",
	})
	if err != nil {
		t.Fatalf("Spawn() error: %v", err)
	}
	if res.PaneID != "%9" {
		t.Errorf("Result.PaneID = %q, want the captured pane-0 id %%9", res.PaneID)
	}

	logged, readErr := os.ReadFile(newWindowLog)
	if readErr != nil {
		t.Fatalf("read new-window log: %v", readErr)
	}
	if strings.Contains(string(logged), "do X") {
		t.Errorf("new-window argv embeds the task positionally: %q", string(logged))
	}
	if !strings.Contains(string(logged), "kimi --auto") {
		t.Errorf("new-window argv missing the bare launcher: %q", string(logged))
	}

	if len(*calls) != 1 {
		t.Fatalf("async deliveries = %v, want exactly one", *calls)
	}
	d := (*calls)[0]
	if d.server != "srv" || d.paneID != "%9" || d.task != "do X" || d.window != res.WindowName {
		t.Errorf("delivery = %+v, want server srv, pane %%9, task %q, window %q", d, "do X", res.WindowName)
	}
}

// TestSpawnCodexSkillPrefixRenderedTask: a codex launcher (skill_prefix `$`
// from `fab agent -o yaml`) gets its slash-shaped task rendered at the spec
// seam — the typed delivery carries `$fab-discuss` while pane 0 composes BARE
// (typed delivery path, so the rendered text never enters the shell string).
func TestSpawnCodexSkillPrefixRenderedTask(t *testing.T) {
	dir := t.TempDir()
	repoRoot := t.TempDir()
	newWindowLog := filepath.Join(dir, "new-window.log")

	testutil.WriteStub(t, dir, "wt", wtStubScript(repoRoot, "", ""))
	testutil.WriteStub(t, dir, "tmux", stubTmuxScriptServerLabel(newWindowLog))
	// The repo's default tier resolves a codex launcher with the $ prefix.
	testutil.WriteStub(t, dir, "fab", "#!/bin/sh\nprintf 'command: %s\\nskill_prefix: %s\\n' 'codex --yolo' '$'\n")
	t.Setenv("PATH", dir)

	calls := stubAsyncDelivery(t)

	res, err := Spawn(context.Background(), Options{
		Server:   "srv",
		Session:  "work",
		RepoRoot: repoRoot,
		Task:     "/fab-discuss",
	})
	if err != nil {
		t.Fatalf("Spawn() error: %v", err)
	}

	logged, readErr := os.ReadFile(newWindowLog)
	if readErr != nil {
		t.Fatalf("read new-window log: %v", readErr)
	}
	if strings.Contains(string(logged), "fab-discuss") {
		t.Errorf("new-window argv embeds the task: %q (typed delivery composes bare)", string(logged))
	}
	if !strings.Contains(string(logged), "codex --yolo") {
		t.Errorf("new-window argv missing the bare launcher: %q", string(logged))
	}

	if len(*calls) != 1 {
		t.Fatalf("async deliveries = %v, want exactly one", *calls)
	}
	d := (*calls)[0]
	if d.task != "$fab-discuss" {
		t.Errorf("delivered task = %q, want the prefix-rendered %q", d.task, "$fab-discuss")
	}
	if d.server != "srv" || d.paneID != res.PaneID || d.window != res.WindowName {
		t.Errorf("delivery = %+v, want server srv, pane %q, window %q", d, res.PaneID, res.WindowName)
	}
}

// TestSpawnClaudeTaskPositionalNoDelivery: a claude launcher keeps the
// positional composition and triggers ZERO typed-delivery calls.
func TestSpawnClaudeTaskPositionalNoDelivery(t *testing.T) {
	dir := t.TempDir()
	repoRoot := t.TempDir()
	newWindowLog := filepath.Join(dir, "new-window.log")

	testutil.WriteStub(t, dir, "wt", wtStubScript(repoRoot, "", ""))
	testutil.WriteStub(t, dir, "tmux", stubTmuxScriptServerLabel(newWindowLog))
	testutil.WriteStub(t, dir, "fab", "#!/bin/sh\necho 'claude --dangerously-skip-permissions'\n")
	t.Setenv("PATH", dir)

	calls := stubAsyncDelivery(t)

	_, err := Spawn(context.Background(), Options{
		Server:   "srv",
		Session:  "work",
		RepoRoot: repoRoot,
		Task:     "do X",
	})
	if err != nil {
		t.Fatalf("Spawn() error: %v", err)
	}
	logged, readErr := os.ReadFile(newWindowLog)
	if readErr != nil {
		t.Fatalf("read new-window log: %v", readErr)
	}
	// The stub logs the invocation's $* — argv elements verbatim — so the
	// single-quote-escaped positional composition appears literally.
	wantFragment := `claude --dangerously-skip-permissions '\''do X'\''`
	if !strings.Contains(string(logged), wantFragment) {
		t.Errorf("new-window argv = %q, want the claude positional composition %q", string(logged), wantFragment)
	}
	if len(*calls) != 0 {
		t.Errorf("async deliveries = %v, want none for a claude (positional) task", *calls)
	}
}

// TestSpawnDaemonDeliveryDoesNotBlock: with the PRODUCTION async wrapper, the
// spawn returns while the delivery is still in flight — the HTTP response
// never waits on agent boot.
func TestSpawnDaemonDeliveryDoesNotBlock(t *testing.T) {
	dir := t.TempDir()
	repoRoot := t.TempDir()
	newWindowLog := filepath.Join(dir, "new-window.log")

	testutil.WriteStub(t, dir, "wt", wtStubScript(repoRoot, "", ""))
	testutil.WriteStub(t, dir, "tmux", stubTmuxScriptServerLabel(newWindowLog))
	testutil.WriteStub(t, dir, "fab", "#!/bin/sh\necho 'kimi --auto'\n")
	t.Setenv("PATH", dir)

	// The delivery blocks until released; Spawn must not wait for it.
	release := make(chan struct{})
	done := make(chan struct{})
	orig := deliverTaskFn
	deliverTaskFn = func(_ context.Context, _, _, _ string) error {
		<-release
		close(done)
		return nil
	}
	t.Cleanup(func() { deliverTaskFn = orig })

	_, err := Spawn(context.Background(), Options{
		Server:   "srv",
		Session:  "work",
		RepoRoot: repoRoot,
		Task:     "do X",
	})
	if err != nil {
		t.Fatalf("Spawn() error: %v", err)
	}
	// Spawn returned while the delivery goroutine is still parked on release.
	close(release)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Error("delivery goroutine never ran")
	}
}

// TestRunCliTypedDeliveryWarning: on the CLI path a delivery failure prints
// the paste-it-yourself warning naming the window and carrying the task text,
// and the spawn still succeeds (Run returns nil — no rollback, exit 0).
func TestRunCliTypedDeliveryWarning(t *testing.T) {
	dir := t.TempDir()
	worktree := t.TempDir()
	newWindowLog := filepath.Join(dir, "new-window.log")

	testutil.WriteStub(t, dir, "wt", wtStubScript(worktree, "", ""))
	testutil.WriteStub(t, dir, "tmux", stubTmuxScript(newWindowLog))
	t.Setenv("PATH", dir)

	stubDeliverTask(t, func(int) error { return fmt.Errorf("not ready") })
	stderr := stubCliStderr(t)

	spec := EffectiveSpec{
		Count:    1,
		Panes:    []PaneSpec{{Kind: PaneKindSkill, Value: "do X"}},
		Launcher: "kimi --auto",
		RepoRoot: t.TempDir(),
	}
	if _, err := Run(context.Background(), spec); err != nil {
		t.Fatalf("Run() = %v, want nil (a delivery failure never fails the spawn)", err)
	}
	got := stderr.String()
	if !strings.Contains(got, "do X") || !strings.Contains(got, "window") {
		t.Errorf("warning = %q, want it to name the window and carry the task text", got)
	}
	if !strings.Contains(got, filepath.Base(worktree)) {
		t.Errorf("warning = %q, want it to name the spawned window (base %q)", got, filepath.Base(worktree))
	}
}

// TestRunCliFanOutDeliveryFailureKeepsWindows: fan-out with one failed
// delivery leaves every window alive — the run succeeds and exactly one
// warning is printed (no rollback is triggered).
func TestRunCliFanOutDeliveryFailureKeepsWindows(t *testing.T) {
	dir := t.TempDir()
	worktree := t.TempDir()
	newWindowLog := filepath.Join(dir, "new-window.log")
	killLog := filepath.Join(dir, "kill-window.log")

	testutil.WriteStub(t, dir, "wt", wtStubScript(worktree, "", ""))
	// The stub also logs kill-window calls so the test can prove no rollback ran.
	testutil.WriteStub(t, dir, "tmux", "#!/bin/sh\n"+
		"case \"$1\" in\n"+
		"  list-windows) exit 0 ;;\n"+
		"  new-window) printf '%s\\n' \"$*\" >> "+newWindowLog+"; echo '%1' ;;\n"+
		"  select-pane) exit 0 ;;\n"+
		"  display-message) echo '@7' ;;\n"+
		"  kill-window) printf '%s\\n' \"$*\" >> "+killLog+" ;;\n"+
		"  *) exit 0 ;;\n"+
		"esac\n")
	t.Setenv("PATH", dir)

	// Exactly one of the two deliveries fails (whichever runs first).
	var once sync.Once
	stubDeliverTask(t, func(int) error {
		fail := false
		once.Do(func() { fail = true })
		if fail {
			return fmt.Errorf("not ready")
		}
		return nil
	})
	stderr := stubCliStderr(t)

	spec := EffectiveSpec{
		Count:    2,
		Panes:    []PaneSpec{{Kind: PaneKindSkill, Value: "do X"}},
		Launcher: "kimi --auto",
		RepoRoot: t.TempDir(),
	}
	if _, err := Run(context.Background(), spec); err != nil {
		t.Fatalf("Run() = %v, want nil (delivery failures never fail the fan-out)", err)
	}
	if n := strings.Count(stderr.String(), "could not deliver the task"); n != 1 {
		t.Errorf("warnings = %d, want exactly 1 (the failed window); stderr = %q", n, stderr.String())
	}
	if data, err := os.ReadFile(killLog); err == nil && strings.TrimSpace(string(data)) != "" {
		t.Errorf("rollback ran (kill-window logged: %q); a delivery failure must not roll back", string(data))
	}
}
