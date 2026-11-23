package autopilot

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEngineFileMissingAndTolerantRead(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "default.yaml")
	st, err := loadEngineFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if st.Version != 1 || len(st.Queue) != 0 {
		t.Fatalf("missing file = %#v", st)
	}
	if _, err := os.Stat(engineFilePath(statePath)); !os.IsNotExist(err) {
		t.Fatalf("read created engine file: %v", err)
	}
	path := engineFilePath(statePath)
	if err := os.WriteFile(path, []byte("version: 1\nfuture: tolerated\nqueue: []\n"), 0o600); err != nil {
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
	if got.Queue[0].ID != "a1" || got.Queue[1].ID != "a2" {
		t.Fatalf("order not preserved: %#v", got)
	}
	if got.Queue[0].DependsOn == nil || got.Queue[0].Escalated == nil {
		t.Fatal("empty collections not normalized")
	}
}

func TestEngineStateLookupUpsertRemove(t *testing.T) {
	st := newEngineState()
	if !st.upsert(engineItem{ID: "a1"}) || st.upsert(engineItem{ID: "a1"}) {
		t.Fatal("upsert did not preserve the existing queue item")
	}
	if !st.has("a1") {
		t.Fatal("queue item not found")
	}
	if !st.remove("a1") || st.has("a1") || st.remove("a1") {
		t.Fatal("remove queue item failed")
	}
}

// An engine file written before the PR work left the engine still carries the
// `prs` and `fixes` lists and the removed item keys: it loads, the queue item is
// managed normally, and the next locked write drops everything the engine no
// longer holds.
func TestLegacyEngineFileLoadsIsIgnoredAndDroppedOnWrite(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	legacy := "version: 1\nmigrated: true\nqueue:\n" +
		"  - id: a\n    queue: q\n    repo: " + repo.Dir + "\n    task: work\n    merge_mode: cherry-pick-ladder\n" +
		"    depends_on: []\n    halted: true\n    pr_dropped: true\n    recovery: [ci-fix]\n    fix_head: abc\n    item: x\n" +
		"prs:\n  - id: pr-41\n    item: a\n    merge_seq: s\n    nwo: o/r\n    pr: 41\n    halted: true\n    depends_on: []\n" +
		"fixes:\n  - id: fix-1\n    repo: " + repo.Dir + "\n    depends_on: []\n"
	if err := os.MkdirAll(filepath.Dir(h.env.StatePath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(engineFilePath(h.env.StatePath), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	owned, err := OwnedIDs(h.env.StatePath)
	if err != nil || !owned["a"] || owned["pr-41"] || owned["fix-1"] || len(owned) != 1 {
		t.Fatalf("owned ids = %#v, %v", owned, err)
	}
	res, err := Step(context.Background(), h.env)
	if err != nil || !hasAction(res, ActSpawned, "a") {
		t.Fatalf("the queue item was not managed normally: %+v, %v", res, err)
	}
	data, err := os.ReadFile(engineFilePath(h.env.StatePath))
	if err != nil {
		t.Fatal(err)
	}
	for _, gone := range []string{"prs:", "fixes:", "halted", "pr_dropped", "recovery", "fix_head", "pr-41", "fix-1", "item:"} {
		if strings.Contains(string(data), gone) {
			t.Fatalf("the rewritten engine file still carries %q:\n%s", gone, data)
		}
	}
	if !strings.Contains(string(data), "pane:") {
		t.Fatalf("the spawn did not reach the rewritten file:\n%s", data)
	}
}

// QueueEntries reads each queue item's entry from the engine file.
func TestQueueEntriesReadsTheEngineFile(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	stop := "hydrate"
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "only the F1 brief", StopStage: &stop})
	got, err := QueueEntries(h.env.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	if e, ok := got["a"]; !ok || e.Task != "only the F1 brief" || e.StopStage != "hydrate" || e.MergeMode == "" {
		t.Errorf("entries = %+v", got)
	}
}

func TestEngineFileRoundTripsPlainAndBase(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "default.yaml")
	st := newEngineState()
	st.Queue = append(st.Queue,
		engineItem{ID: "a", Repo: "/repo/a", Task: "bump deps", Plain: true, Base: "eng-v2"},
		engineItem{ID: "b", Repo: "/repo/a", Task: "x"},
	)
	if err := writeEngineFile(statePath, st); err != nil {
		t.Fatal(err)
	}
	got, err := loadEngineFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	a, b := got.Queue[0], got.Queue[1]
	if !a.Plain || a.Base != "eng-v2" {
		t.Fatalf("reloaded a = %+v", a)
	}
	back := engineItemFromTracked(a.tracked(), false)
	if !back.Plain || back.Base != "eng-v2" {
		t.Fatalf("scope round trip lost plain/base: %+v", back)
	}
	if b.Plain || b.Base != "" {
		t.Fatalf("legacy item reads plain=%v base=%q", b.Plain, b.Base)
	}
	raw, err := os.ReadFile(engineFilePath(statePath))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(raw), "plain:") != 1 || strings.Count(string(raw), "base:") != 1 {
		t.Fatalf("unset plain/base must be omitted from the file:\n%s", raw)
	}
}

func TestEngineFileWithoutPlainAndBaseLoadsAsToday(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "default.yaml")
	legacy := "version: 1\nqueue:\n  - id: a\n    repo: /repo/a\n    task: x\n    depends_on: []\n    done_at: null\n    escalated: {}\n"
	if err := os.WriteFile(engineFilePath(statePath), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := loadEngineFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	it := st.Queue[0].tracked()
	if scopeBool(it, scopePlain) {
		t.Error("a file without plain loads as plain: false")
	}
	if _, ok := it.Scope[scopeBase]; ok {
		t.Error("a file without base carries no base scope key")
	}
}

func TestQueueEntriesCarryPlainAndBase(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "bump deps", Plain: true})
	got, err := QueueEntries(h.env.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	if e := got["a"]; !e.Plain || e.Base != "" {
		t.Errorf("entry = %+v", e)
	}
}
