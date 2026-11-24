package autopilot

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"rk/internal/testutil"
)

// The production spawner hands wt the engine's base ref with a fetch, tells wt
// to set no upstream, and reports the receipt's branch and pinned base SHA; a
// respawn never reaches wt.
func TestRiffSpawnerAsksWtToFetchAndSkipUpstream(t *testing.T) {
	dir := t.TempDir()
	worktree := filepath.Join(t.TempDir(), "a")
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatal(err)
	}
	const sha = "b3c1e28c0000000000000000000000000000abcd"
	receipt := fmt.Sprintf(`{"ok":true,"result":{"path":%q,"name":"a","branch":"a","base_ref":"origin/main","base_sha":%q,"mode":"new","init":"ok"}}`, worktree, sha)
	wtLog := filepath.Join(dir, "wt.log")
	testutil.WriteStub(t, dir, "wt", "#!/bin/sh\ncase \"$1\" in\n"+
		"  --version) echo 'wt version v0.1.8';;\n"+
		"  create) echo \"$* | $GIT_CONFIG_COUNT $GIT_CONFIG_KEY_0 $GIT_CONFIG_VALUE_0\" >> "+wtLog+"; printf '%s\\n' '"+receipt+"';;\n"+
		"esac\n")
	testutil.WriteStub(t, dir, "tmux", "#!/bin/sh\ncase \"$1\" in\n  -L) shift 2;;\nesac\ncase \"$1\" in\n"+
		"  new-window) echo '%1';;\n  display-message) echo '@7';;\n  *) exit 0;;\nesac\n")
	testutil.WriteStub(t, dir, "fab", "#!/bin/sh\nprintf 'command: claude\\nskill_prefix: /\\n'\n")
	t.Setenv("PATH", dir)

	s := RiffSpawner{Server: "srv", Run: ExecRunner{}}
	var opened SpawnResult
	res, err := s.Spawn(context.Background(), SpawnRequest{
		Repo: t.TempDir(), Session: "s", WorktreeName: "a", BaseRef: "origin/main",
		Opened: func(r SpawnResult) error { opened = r; return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	log, _ := os.ReadFile(wtLog)
	if got := strings.TrimSpace(string(log)); !strings.Contains(got, "--name a --base origin/main --fetch --json") || !strings.HasSuffix(got, "| 1 branch.autoSetupMerge false") {
		t.Errorf("wt saw %q, want --base origin/main --fetch --json with branch.autoSetupMerge=false", got)
	}
	if res.Branch != "a" || res.BaseSHA != sha || res.WorktreePath != worktree {
		t.Errorf("result = %+v", res)
	}
	if opened.Branch != "a" || opened.BaseSHA != sha || opened.WorktreePath != worktree {
		t.Errorf("the window-opened record = %+v, want the receipt's branch and base SHA", opened)
	}

	if _, err := s.Spawn(context.Background(), SpawnRequest{
		Repo: t.TempDir(), Session: "s", WorktreeName: "a", CheckoutBranch: "a", ExistingWorktree: worktree,
	}); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(wtLog)
	if strings.Count(string(after), "\n") != 1 {
		t.Errorf("a respawn must not call wt create; log:\n%s", after)
	}
}
