package autopilot

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEngineFileMissingAndTolerantRead(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "default.yaml")
	st, err := loadEngineFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if st.Version != 1 || len(st.Queue) != 0 || len(st.PRs) != 0 {
		t.Fatalf("missing file = %#v", st)
	}
	if _, err := os.Stat(engineFilePath(statePath)); !os.IsNotExist(err) {
		t.Fatalf("read created engine file: %v", err)
	}
	path := engineFilePath(statePath)
	if err := os.WriteFile(path, []byte("version: 1\nfuture: tolerated\nqueue: []\nprs: []\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadEngineFile(statePath); err != nil {
		t.Fatalf("unknown fields rejected: %v", err)
	}
}

func TestEngineFileRoundTripOrderAndMode(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "nested", "default.yaml")
	st := newEngineState()
	st.Queue = append(st.Queue, engineItem{ID: "a1", Repo: "/repo/a"}, engineItem{ID: "a2", Repo: "/repo/b"})
	st.PRs = append(st.PRs, engineItem{ID: "pr-2", Item: "a2", MergeSeq: "repo", PR: 2})
	if err := writeEngineFile(statePath, st); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(engineFilePath(statePath))
	if err != nil {
		t.Fatal(err)
	}
	if got := fi.Mode().Perm(); got != 0o600 {
		t.Fatalf("mode = %o", got)
	}
	got, err := loadEngineFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if got.Queue[0].ID != "a1" || got.Queue[1].ID != "a2" || got.PRs[0].ID != "pr-2" {
		t.Fatalf("order not preserved: %#v", got)
	}
	if got.Queue[0].DependsOn == nil || got.PRs[0].Escalated == nil {
		t.Fatal("empty collections not normalized")
	}
}

func TestEngineStateLookupUpsertRemove(t *testing.T) {
	st := newEngineState()
	if !st.upsert(engineItem{ID: "a1"}, false) || st.upsert(engineItem{ID: "a1"}, false) {
		t.Fatal("upsert did not preserve the existing queue item")
	}
	if !st.upsert(engineItem{ID: "pr-1"}, true) || !st.has("pr-1") {
		t.Fatal("PR item not found")
	}
	if !st.remove("a1") || st.has("a1") || st.remove("a1") {
		t.Fatal("remove queue item failed")
	}
}
