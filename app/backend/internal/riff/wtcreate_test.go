package riff

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"rk/internal/testutil"
)

const wtStubVersion = "wt version v0.1.8"

// wtStubReceipt is the success receipt a stub wt prints for worktree: the
// branch and name are the worktree's basename, the base is null.
func wtStubReceipt(worktree string) string {
	name := filepath.Base(worktree)
	return fmt.Sprintf(`{"ok":true,"result":{"path":%q,"name":%q,"branch":%q,"base_ref":null,"base_sha":null,"mode":"new","init":"ok"}}`, worktree, name, name)
}

// wtStubScript is a wt stand-in: `--version` answers v0.1.8, `create` runs
// createPre then prints the success receipt for worktree, and `delete` runs
// deleteBody (a no-op when empty).
func wtStubScript(worktree, createPre, deleteBody string) string {
	if deleteBody == "" {
		deleteBody = "true"
	}
	return "#!/bin/sh\ncase \"$1\" in\n" +
		"  --version) echo '" + wtStubVersion + "';;\n" +
		"  create)\n" + createPre + "\n    printf '%s\\n' '" + wtStubReceipt(worktree) + "';;\n" +
		"  delete) " + deleteBody + ";;\n" +
		"esac\n"
}

// wtStubCreateScript is a wt stand-in whose create prints the given stdout
// document, writes stderr, and exits with code.
func wtStubCreateScript(stdout, stderr string, code int) string {
	return "#!/bin/sh\ncase \"$1\" in\n" +
		"  --version) echo '" + wtStubVersion + "';;\n" +
		"  create)\n    printf '%s\\n' " + shQuote(stdout) + "\n    printf '%s\\n' " + shQuote(stderr) + " >&2\n    exit " + fmt.Sprint(code) + ";;\n" +
		"  delete) echo \"$*\" >> \"$WT_DELETE_LOG\";;\n" +
		"esac\n"
}

// shQuote single-quotes s for a stub script.
func shQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// resetWtVersionGate clears the process-wide version-gate cache around a test.
func resetWtVersionGate(t *testing.T) {
	t.Helper()
	clear := func() {
		wtVersionGate.mu.Lock()
		wtVersionGate.ok = false
		wtVersionGate.mu.Unlock()
	}
	clear()
	t.Cleanup(clear)
}

func TestParseWtVersion(t *testing.T) {
	cases := []struct {
		in   string
		want [3]int
		ok   bool
	}{
		{"wt version v0.1.8", [3]int{0, 1, 8}, true},
		{"wt version v0.1.8\n", [3]int{0, 1, 8}, true},
		{"wt version v1.12.30", [3]int{1, 12, 30}, true},
		{"wt version dev", [3]int{}, false},
		{"wt version v0.1", [3]int{}, false},
		{"wt version v0.1.8-rc1", [3]int{}, false},
		{"v0.1.8", [3]int{}, false},
		{"", [3]int{}, false},
	}
	for _, tc := range cases {
		got, ok := parseWtVersion(tc.in)
		if ok != tc.ok || got != tc.want {
			t.Errorf("parseWtVersion(%q) = %v, %v; want %v, %v", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

func TestWtVersionLess(t *testing.T) {
	cases := []struct {
		a, b [3]int
		want bool
	}{
		{[3]int{0, 1, 7}, [3]int{0, 1, 8}, true},
		{[3]int{0, 1, 8}, [3]int{0, 1, 8}, false},
		{[3]int{0, 1, 9}, [3]int{0, 1, 8}, false},
		{[3]int{0, 2, 0}, [3]int{0, 1, 8}, false},
		{[3]int{0, 0, 99}, [3]int{0, 1, 8}, true},
		{[3]int{1, 0, 0}, [3]int{0, 9, 9}, false},
	}
	for _, tc := range cases {
		if got := wtVersionLess(tc.a, tc.b); got != tc.want {
			t.Errorf("wtVersionLess(%v, %v) = %v, want %v", tc.a, tc.b, got, tc.want)
		}
	}
}

// versionStub answers `--version` from a file the test rewrites, and logs every
// create so a refused spawn can prove wt create never ran.
func versionStub(t *testing.T, dir, versionFile, createLog, worktree string) {
	t.Helper()
	testutil.WriteStub(t, dir, "wt", "#!/bin/sh\ncase \"$1\" in\n"+
		"  --version) read v < "+versionFile+"; echo \"$v\";;\n"+
		"  create) echo create >> "+createLog+"; printf '%s\\n' '"+wtStubReceipt(worktree)+"';;\n"+
		"esac\n")
}

func TestEnsureWtVersion_RefusesOldThenAcceptsAfterUpdate(t *testing.T) {
	resetWtVersionGate(t)
	dir := t.TempDir()
	worktree := filepath.Join(t.TempDir(), "swift-fox")
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatal(err)
	}
	versionFile := filepath.Join(dir, "version")
	createLog := filepath.Join(dir, "create.log")
	newWindowLog := filepath.Join(dir, "new-window.log")
	versionStub(t, dir, versionFile, createLog, worktree)
	testutil.WriteStub(t, dir, "tmux", stubTmuxScript(newWindowLog))
	testutil.WriteStub(t, dir, "fab", "#!/bin/sh\necho 'claude'\n")
	t.Setenv("PATH", dir)

	if err := os.WriteFile(versionFile, []byte("wt version v0.1.7\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := Spawn(context.Background(), Options{RepoRoot: t.TempDir()})
	var ece *ExitCodeError
	if !errors.As(err, &ece) || ece.Code != ExitPrecondition {
		t.Fatalf("old wt: err = %v, want an ExitPrecondition ExitCodeError", err)
	}
	for _, want := range []string{"v0.1.7", "too old", ">= v0.1.8", "wt update"} {
		if !strings.Contains(ece.Msg, want) {
			t.Errorf("message %q lacks %q", ece.Msg, want)
		}
	}
	if strings.Contains(ece.Msg, "\n") {
		t.Errorf("message must be one line: %q", ece.Msg)
	}
	if _, statErr := os.Stat(createLog); statErr == nil {
		t.Fatal("wt create ran under a too-old wt")
	}

	if err := os.WriteFile(versionFile, []byte("wt version v0.1.8\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Spawn(context.Background(), Options{RepoRoot: t.TempDir()}); err != nil {
		t.Fatalf("after the update the next spawn must pass the gate in the same process: %v", err)
	}
	if _, statErr := os.Stat(createLog); statErr != nil {
		t.Error("wt create did not run after the gate passed")
	}
}

func TestEnsureWtVersion_UnparseableRefusesAndShowsRaw(t *testing.T) {
	resetWtVersionGate(t)
	dir := t.TempDir()
	versionFile := filepath.Join(dir, "version")
	if err := os.WriteFile(versionFile, []byte("wt version dev-build\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	versionStub(t, dir, versionFile, filepath.Join(dir, "create.log"), t.TempDir())
	t.Setenv("PATH", dir)

	err := ensureWtVersion(context.Background())
	var ece *ExitCodeError
	if !errors.As(err, &ece) || ece.Code != ExitPrecondition {
		t.Fatalf("err = %v, want an ExitPrecondition ExitCodeError", err)
	}
	if !strings.Contains(ece.Msg, "wt version dev-build") || !strings.Contains(ece.Msg, "wt update") {
		t.Errorf("message %q must show the raw version and the fix", ece.Msg)
	}
}

func TestEnsureWtVersion_PassingProbeIsCached(t *testing.T) {
	resetWtVersionGate(t)
	dir := t.TempDir()
	versionFile := filepath.Join(dir, "version")
	if err := os.WriteFile(versionFile, []byte("wt version v0.1.8\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	versionStub(t, dir, versionFile, filepath.Join(dir, "create.log"), t.TempDir())
	t.Setenv("PATH", dir)

	if err := ensureWtVersion(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(versionFile, []byte("wt version v0.0.1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ensureWtVersion(context.Background()); err != nil {
		t.Fatalf("a passing probe must be cached for the process: %v", err)
	}
}

func TestEnsureWtVersion_MissingWtIsPrecondition(t *testing.T) {
	resetWtVersionGate(t)
	t.Setenv("PATH", t.TempDir())
	var ece *ExitCodeError
	if err := ensureWtVersion(context.Background()); !errors.As(err, &ece) || ece.Code != ExitPrecondition {
		t.Fatalf("err = %v, want ExitPrecondition", err)
	}
}

func TestRunWtCreate_ReceiptDecode(t *testing.T) {
	resetWtVersionGate(t)
	worktree := filepath.Join(t.TempDir(), "kept-wt")
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatal(err)
	}
	okNew := fmt.Sprintf(`{"ok":true,"result":{"path":%q,"name":"kept-wt","branch":"kept-wt","base_ref":"origin/main","base_sha":"b3c1e28c0000000000000000000000000000abcd","mode":"new","init":"ok"}}`, worktree)
	okNulls := fmt.Sprintf(`{"ok":true,"result":{"path":%q,"name":"kept-wt","branch":null,"base_ref":null,"base_sha":null,"mode":"temp","init":"skipped"}}`, worktree)
	fetchFail := `{"ok":false,"error":{"code":3,"message":"Failed to fetch remote 'origin'"}}`
	badBase := `{"ok":false,"error":{"code":2,"message":"Invalid --base ref: origin/nope"}}`
	initFail := fmt.Sprintf(`{"ok":false,"error":{"code":7,"message":"init script exited with status 1"},"result":{"path":%q,"name":"kept-wt","branch":"kept-wt","base_ref":null,"base_sha":null,"mode":"new","init":"failed"}}`, worktree)

	t.Run("success carries every field", func(t *testing.T) {
		t.Setenv("PATH", writeWtDir(t, wtStubCreateScript(okNew, "phase output", 0)))
		got, err := runWtCreate(context.Background(), EffectiveSpec{}, nil)
		if err != nil {
			t.Fatal(err)
		}
		want := wtCreated{Path: worktree, Name: "kept-wt", Branch: "kept-wt", BaseRef: "origin/main", BaseSHA: "b3c1e28c0000000000000000000000000000abcd", Mode: "new", Init: "ok"}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %+v, want %+v", got, want)
		}
	})

	t.Run("null fields read as empty strings", func(t *testing.T) {
		t.Setenv("PATH", writeWtDir(t, wtStubCreateScript(okNulls, "", 0)))
		got, err := runWtCreate(context.Background(), EffectiveSpec{}, nil)
		if err != nil {
			t.Fatal(err)
		}
		if got.Branch != "" || got.BaseRef != "" || got.BaseSHA != "" || got.Path != worktree || got.Init != "skipped" {
			t.Errorf("got %+v", got)
		}
	})

	for _, tc := range []struct {
		name, doc, stderr string
		code              int
		wantMsg           string
	}{
		{"exit 3 fetch failure", fetchFail, "Error: fetch failed\nWhy: offline", 3, "Failed to fetch remote 'origin'"},
		{"exit 2 invalid base", badBase, "", 2, "Invalid --base ref: origin/nope"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("PATH", writeWtDir(t, wtStubCreateScript(tc.doc, tc.stderr, tc.code)))
			_, err := runWtCreate(context.Background(), EffectiveSpec{}, nil)
			var wtErr *WtCreateError
			if !errors.As(err, &wtErr) || wtErr.Code != tc.code || wtErr.Kept != nil {
				t.Fatalf("err = %v, want a WtCreateError{Code:%d} with no kept worktree", err, tc.code)
			}
			if !strings.Contains(err.Error(), tc.wantMsg) {
				t.Errorf("error %q lacks wt's message %q", err, tc.wantMsg)
			}
			if tc.stderr != "" && !strings.Contains(err.Error(), "Why: offline") {
				t.Errorf("error %q lacks the stderr tail", err)
			}
			var ece *ExitCodeError
			if !errors.As(err, &ece) || ece.Code != ExitSubprocess {
				t.Errorf("err does not unwrap to an ExitSubprocess ExitCodeError: %v", err)
			}
		})
	}

	t.Run("exit 7 names the kept worktree", func(t *testing.T) {
		t.Setenv("PATH", writeWtDir(t, wtStubCreateScript(initFail, "init blew up", 7)))
		_, err := runWtCreate(context.Background(), EffectiveSpec{}, nil)
		var wtErr *WtCreateError
		if !errors.As(err, &wtErr) || wtErr.Code != 7 || wtErr.KeptPath() != worktree || wtErr.Kept.Init != "failed" {
			t.Fatalf("err = %v, want a WtCreateError{Code:7} keeping %s", err, worktree)
		}
		if !strings.Contains(err.Error(), worktree) || !strings.Contains(err.Error(), "init script exited with status 1") {
			t.Errorf("error %q must name the kept path and wt's message", err)
		}
	})

	t.Run("non-JSON stdout is a subprocess error carrying stderr", func(t *testing.T) {
		t.Setenv("PATH", writeWtDir(t, wtStubCreateScript("", "Error: unknown flag: --bogus", 2)))
		_, err := runWtCreate(context.Background(), EffectiveSpec{}, []string{"--bogus"})
		var wtErr *WtCreateError
		if errors.As(err, &wtErr) {
			t.Fatalf("a missing document must not read as a receipt: %v", err)
		}
		var ece *ExitCodeError
		if !errors.As(err, &ece) || ece.Code != ExitSubprocess {
			t.Fatalf("err = %v, want an ExitSubprocess ExitCodeError", err)
		}
		if !strings.Contains(err.Error(), "unknown flag: --bogus") {
			t.Errorf("error %q must carry wt's stderr", err)
		}
	})

	t.Run("a receipt whose path is not a directory", func(t *testing.T) {
		missing := fmt.Sprintf(`{"ok":true,"result":{"path":%q,"name":"x","branch":"x","base_ref":null,"base_sha":null,"mode":"new","init":"ok"}}`, filepath.Join(t.TempDir(), "absent"))
		t.Setenv("PATH", writeWtDir(t, wtStubCreateScript(missing, "", 0)))
		_, err := runWtCreate(context.Background(), EffectiveSpec{}, nil)
		var ece *ExitCodeError
		if !errors.As(err, &ece) || ece.Code != ExitSubprocess || !strings.Contains(err.Error(), "not a directory") {
			t.Fatalf("err = %v", err)
		}
	})
}

func writeWtDir(t *testing.T, script string) string {
	t.Helper()
	dir := t.TempDir()
	testutil.WriteStub(t, dir, "wt", script)
	return dir
}

func TestRunWtCreate_NoUpstreamEnv(t *testing.T) {
	resetWtVersionGate(t)
	worktree := filepath.Join(t.TempDir(), "swift-fox")
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		set  bool
	}{{"requested", true}, {"not requested", false}} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			envLog := filepath.Join(dir, "env.log")
			testutil.WriteStub(t, dir, "wt", wtStubScript(worktree,
				`    echo "$GIT_CONFIG_COUNT|$GIT_CONFIG_KEY_0|$GIT_CONFIG_VALUE_0" > `+envLog, ""))
			t.Setenv("PATH", dir)
			t.Setenv("GIT_CONFIG_COUNT", "")
			t.Setenv("GIT_CONFIG_KEY_0", "")
			t.Setenv("GIT_CONFIG_VALUE_0", "")
			if _, err := runWtCreate(context.Background(), EffectiveSpec{WorktreeNoUpstream: tc.set}, nil); err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(envLog)
			if err != nil {
				t.Fatal(err)
			}
			want := "||"
			if tc.set {
				want = "1|branch.autoSetupMerge|false"
			}
			if strings.TrimSpace(string(got)) != want {
				t.Errorf("wt saw GIT_CONFIG_{COUNT|KEY_0|VALUE_0} = %q, want %q", strings.TrimSpace(string(got)), want)
			}
		})
	}
}

func TestRunWtCreate_NoUpstreamIgnoredInCheckoutMode(t *testing.T) {
	spec := EffectiveSpec{Where: whereCheckout, WorktreeNoUpstream: true, WorktreeFetch: true, WorktreeBase: "origin/main"}
	if got := buildWtCreateArgs(spec, nil); !reflect.DeepEqual(got, []string{"create", "--json", "--non-interactive", "--open", "skip"}) {
		t.Errorf("argv = %v", got)
	}
}

func exitSevenDoc(worktree string) string {
	return fmt.Sprintf(`{"ok":false,"error":{"code":7,"message":"init script exited with status 1"},"result":{"path":%q,"name":%q,"branch":%q,"base_ref":null,"base_sha":null,"mode":"new","init":"failed"}}`, worktree, filepath.Base(worktree), filepath.Base(worktree))
}

func TestSpawn_InitFailureKeepsWorktreeAndOpensNoWindow(t *testing.T) {
	resetWtVersionGate(t)
	dir := t.TempDir()
	worktree := filepath.Join(t.TempDir(), "kept-wt")
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatal(err)
	}
	deleteLog := filepath.Join(dir, "delete.log")
	newWindowLog := filepath.Join(dir, "new-window.log")
	testutil.WriteStub(t, dir, "wt", wtStubCreateScript(exitSevenDoc(worktree), "init blew up", 7))
	testutil.WriteStub(t, dir, "tmux", stubTmuxScript(newWindowLog))
	testutil.WriteStub(t, dir, "fab", "#!/bin/sh\necho 'claude'\n")
	t.Setenv("PATH", dir)
	t.Setenv("WT_DELETE_LOG", deleteLog)

	res, err := Spawn(context.Background(), Options{RepoRoot: t.TempDir()})
	var wtErr *WtCreateError
	if !errors.As(err, &wtErr) || wtErr.Code != 7 {
		t.Fatalf("err = %v, want a WtCreateError{Code:7}", err)
	}
	if !strings.Contains(err.Error(), worktree) {
		t.Errorf("error %q must name the kept worktree %s", err, worktree)
	}
	if res.WorktreePath != worktree || res.Init != "failed" {
		t.Errorf("Result = %+v, want the kept path and init failed", res)
	}
	if _, statErr := os.Stat(deleteLog); statErr == nil {
		t.Error("wt delete ran: an init failure must keep the worktree")
	}
	if _, statErr := os.Stat(newWindowLog); statErr == nil {
		t.Error("a window was opened for a failed init")
	}
	if _, statErr := os.Stat(worktree); statErr != nil {
		t.Error("the worktree is gone")
	}
}

func TestSpawnObserved_HookCarriesTheReceipt(t *testing.T) {
	resetWtVersionGate(t)
	dir := t.TempDir()
	worktree := filepath.Join(t.TempDir(), "swift-fox")
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatal(err)
	}
	sha := "b3c1e28c0000000000000000000000000000abcd"
	doc := fmt.Sprintf(`{"ok":true,"result":{"path":%q,"name":"swift-fox","branch":"260101-ab12-x","base_ref":"origin/main","base_sha":%q,"mode":"new","init":"ok"}}`, worktree, sha)
	argvLog := filepath.Join(dir, "wt-argv.log")
	testutil.WriteStub(t, dir, "wt", "#!/bin/sh\ncase \"$1\" in\n  --version) echo '"+wtStubVersion+"';;\n  create) echo \"$*\" > "+argvLog+"; printf '%s\\n' '"+doc+"';;\nesac\n")
	testutil.WriteStub(t, dir, "tmux", stubTmuxScript(filepath.Join(dir, "new-window.log")))
	testutil.WriteStub(t, dir, "fab", "#!/bin/sh\necho 'claude'\n")
	t.Setenv("PATH", dir)

	var got OpenedWindow
	res, err := SpawnObserved(context.Background(), Options{
		RepoRoot: t.TempDir(), WorktreeName: "swift-fox", WorktreeBase: "origin/main", WorktreeFetch: true,
	}, nil, func(_ context.Context, w OpenedWindow) error {
		got = w
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	want := OpenedWindow{PaneID: "%1", WindowID: "@7", WorktreePath: worktree, Branch: "260101-ab12-x", BaseRef: "origin/main", BaseSHA: sha}
	if got != want {
		t.Errorf("hook got %+v, want %+v", got, want)
	}
	if res.Branch != "260101-ab12-x" || res.BaseRef != "origin/main" || res.BaseSHA != sha || res.Init != "ok" {
		t.Errorf("Result = %+v", res)
	}
	argv, _ := os.ReadFile(argvLog)
	if !strings.Contains(string(argv), "--base origin/main --fetch --json") {
		t.Errorf("wt argv %q lacks --base origin/main --fetch --json", strings.TrimSpace(string(argv)))
	}
}

func TestRun_FanOutKeepsAnInitFailedWorktree(t *testing.T) {
	resetWtVersionGate(t)
	dir := t.TempDir()
	okWT := filepath.Join(t.TempDir(), "ok-wt")
	keptWT := filepath.Join(t.TempDir(), "kept-wt")
	for _, p := range []string{okWT, keptWT} {
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	deleteLog := filepath.Join(dir, "delete.log")
	claim := filepath.Join(dir, "claim")
	testutil.WriteStub(t, dir, "wt", "#!/bin/sh\ncase \"$1\" in\n"+
		"  --version) echo '"+wtStubVersion+"';;\n"+
		"  create)\n"+
		"    if mkdir "+claim+" 2>/dev/null; then printf '%s\\n' '"+wtStubReceipt(okWT)+"'; exit 0; fi\n"+
		"    printf '%s\\n' '"+exitSevenDoc(keptWT)+"'; exit 7;;\n"+
		"  delete) echo \"$*\" >> "+deleteLog+";;\n"+
		"esac\n")
	testutil.WriteStub(t, dir, "tmux", stubTmuxScript(filepath.Join(dir, "new-window.log")))
	t.Setenv("PATH", dir)
	stubDeliverTask(t, func(int) error { return nil })

	_, err := Run(context.Background(), EffectiveSpec{
		Count: 2, Panes: []PaneSpec{{Kind: PaneKindSkill, Value: "x"}}, Launcher: "claude", RepoRoot: t.TempDir(),
	})
	if err == nil {
		t.Fatal("Run succeeded; one worktree's init failed")
	}
	if del, _ := os.ReadFile(deleteLog); strings.Contains(string(del), "kept-wt") {
		t.Errorf("rollback deleted the init-failed worktree: %q", del)
	}
	if _, statErr := os.Stat(keptWT); statErr != nil {
		t.Error("the init-failed worktree is gone")
	}
}
