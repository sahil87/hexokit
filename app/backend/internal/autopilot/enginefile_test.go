package autopilot

import (
	"os"
	"path/filepath"
	"testing"

	"rk/internal/operator"
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

func TestEngineFileRecoveryFieldsAndFixItems(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "operator.yaml")
	st := newEngineState()
	st.PRs = append(st.PRs, engineItem{
		ID: "pr-1", Item: "a", MergeSeq: "s", NWO: "o/r", PR: 1,
		Recovery: []string{"ci-fix", "rebase"}, FixHead: "abc", RecoveryAt: "2026-11-16T12:00:00Z", FixItem: "ab12-fix",
	})
	st.Fixes = append(st.Fixes, engineItem{ID: "ab12-fix", Repo: "/r", Branch: "a-branch", Change: "ab12"})
	if err := writeEngineFile(statePath, st); err != nil {
		t.Fatal(err)
	}
	got, err := loadEngineFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	pr := got.PRs[0].tracked()
	if !roundSpent(pr, "ci-fix") || !roundSpent(pr, "rebase") || roundSpent(pr, "other") {
		t.Fatalf("recovery rounds = %#v", pr.Scope[scopeRecovery])
	}
	if operator.ScopeString(pr.Scope, scopeFixHead) != "abc" || operator.ScopeString(pr.Scope, scopeRecoverAt) == "" || operator.ScopeString(pr.Scope, scopeFixItem) != "ab12-fix" {
		t.Fatalf("recovery fields not round-tripped: %#v", pr.Scope)
	}
	for _, key := range []string{scopeRecovery, scopeFixHead, scopeRecoverAt, scopeFixItem} {
		if _, present := projectionScope(pr)[key]; present {
			t.Fatalf("engine key %s leaked into the ledger projection", key)
		}
	}
	view, _, err := engineView(statePath)
	if err != nil {
		t.Fatal(err)
	}
	fix := view.Tracked[operator.IndexOf(view.Tracked, "ab12-fix")]
	if legacyQueueItem(view, fix) {
		t.Fatal("fix item became queue work")
	}
	parent, ok := fixParent(view, fix.ID)
	if !ok || parent.ID != "pr-1" {
		t.Fatalf("fix parent = %#v, %v", parent, ok)
	}
	owned, err := OwnedIDs(statePath)
	if err != nil || !owned["ab12-fix"] {
		t.Fatalf("owned ids = %#v, %v", owned, err)
	}
	if got.upsertFix(engineItem{ID: "ab12-fix"}) || !got.remove("ab12-fix") || got.has("ab12-fix") {
		t.Fatal("fix upsert/remove did not use the fixes list")
	}
}
