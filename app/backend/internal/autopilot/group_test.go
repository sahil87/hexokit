package autopilot

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"

	"rk/internal/operator"
)

func (h *harness) queueGroup(group string, entries ...Entry) QueueReceipt {
	h.t.Helper()
	rec, err := enqueue(context.Background(), h.env, entries, QueueOptions{Group: group, GroupSet: group != ""}, "", false)
	if err != nil {
		h.t.Fatalf("Enqueue: %v", err)
	}
	return rec
}

func groupOf(it operator.TrackedItem) string { return operator.ScopeString(it.Scope, scopeGroup) }

func TestEnqueueGroupStampsEveryItemOfTheCallOnly(t *testing.T) {
	h := newHarness(t)
	foo, bar := newRepo(t, "foo"), newRepo(t, "bar")
	rec := h.queueGroup("operator-triggers",
		Entry{ID: "a", Repo: foo.Dir, Task: "a"},
		Entry{ID: "b", Repo: bar.Dir, Task: "b"},
	)
	if rec.Group != "operator-triggers" {
		t.Fatalf("receipt group = %q", rec.Group)
	}
	h.queue("", Entry{ID: "c", Repo: foo.Dir, Task: "c", DependsOn: &[]string{"a"}})
	h.queueGroup("other", Entry{ID: "d", Repo: foo.Dir, Task: "d", DependsOn: &[]string{}})

	for id, want := range map[string]string{"a": "operator-triggers", "b": "operator-triggers", "c": "", "d": "other"} {
		if got := groupOf(h.item(id)); got != want {
			t.Errorf("item %s group = %q, want %q", id, got, want)
		}
	}
	raw, err := os.ReadFile(engineFilePath(h.env.StatePath))
	if err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(string(raw), "group:"); n != 3 {
		t.Fatalf("want a group key on exactly the three grouped items, got %d:\n%s", n, raw)
	}
}

func TestEnqueueWithoutGroupWritesNoGroupKey(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	rec := h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	if rec.Group != "" {
		t.Fatalf("receipt group = %q", rec.Group)
	}
	raw, err := os.ReadFile(engineFilePath(h.env.StatePath))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "group") {
		t.Fatalf("an ungrouped queue wrote a group key:\n%s", raw)
	}
	out, err := json.Marshal(rec)
	if err != nil || strings.Contains(string(out), "group") {
		t.Fatalf("receipt JSON = %s (%v)", out, err)
	}
}

func TestEnqueueGroupRejectionsWriteNothing(t *testing.T) {
	cases := []struct {
		name  string
		opts  QueueOptions
		wantE string
	}{
		{"reserved prefix", QueueOptions{Group: "_rk-x", GroupSet: true}, "may not start with _rk-"},
		{"space", QueueOptions{Group: "a b", GroupSet: true}, "spaces"},
		{"colon", QueueOptions{Group: "a:b", GroupSet: true}, "invalid --group"},
		{"period", QueueOptions{Group: "a.b", GroupSet: true}, "invalid --group"},
		{"forbidden char", QueueOptions{Group: "a;b", GroupSet: true}, "invalid --group"},
		{"too long", QueueOptions{Group: strings.Repeat("g", 200), GroupSet: true}, "invalid --group"},
		{"explicit empty", QueueOptions{GroupSet: true}, "--group must not be empty"},
	}
	for _, c := range cases {
		for _, dry := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s dry=%v", c.name, dry), func(t *testing.T) {
				h := newHarness(t)
				foo := newRepo(t, "foo")
				h.env.DryRun = dry
				_, err := Enqueue(context.Background(), h.env, []Entry{{ID: "a", Repo: foo.Dir, Task: "a"}}, c.opts, "")
				var inv *InvalidError
				if !errors.As(err, &inv) || !strings.Contains(err.Error(), c.wantE) {
					t.Fatalf("err = %v, want InvalidError containing %q", err, c.wantE)
				}
				if es, loadErr := loadEngineFile(h.env.StatePath); loadErr != nil || len(es.Queue) != 0 {
					t.Fatalf("a rejected queue wrote items: %+v (%v)", es, loadErr)
				}
			})
		}
	}
}

func TestEnqueueGroupDryRunReportsAndWritesNothing(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.env.DryRun = true
	rec, err := Enqueue(context.Background(), h.env, []Entry{{ID: "a", Repo: foo.Dir, Task: "a"}}, QueueOptions{Group: "g", GroupSet: true}, "")
	if err != nil || rec.Group != "g" || len(rec.Items) != 1 {
		t.Fatalf("rec = %+v err = %v", rec, err)
	}
	if es, loadErr := loadEngineFile(h.env.StatePath); loadErr != nil || len(es.Queue) != 0 {
		t.Fatalf("dry-run wrote items: %+v (%v)", es, loadErr)
	}
}

func TestEngineFileRoundTripsGroup(t *testing.T) {
	statePath := t.TempDir() + "/default.yaml"
	st := newEngineState()
	st.Queue = append(st.Queue,
		engineItem{ID: "a", Repo: "/repo/a", Task: "x", Group: "g"},
		engineItem{ID: "b", Repo: "/repo/a", Task: "x"},
	)
	if err := writeEngineFile(statePath, st); err != nil {
		t.Fatal(err)
	}
	got, err := loadEngineFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if got.Queue[0].Group != "g" || got.Queue[1].Group != "" {
		t.Fatalf("reloaded = %+v", got.Queue)
	}
	if back := engineItemFromTracked(got.Queue[0].tracked(), false); back.Group != "g" {
		t.Fatalf("scope round trip lost the group: %+v", back)
	}
	if _, ok := got.Queue[1].tracked().Scope[scopeGroup]; ok {
		t.Error("an ungrouped item carries a group scope key")
	}
}

func TestGroupedSpawnAndRespawnLandInTheGroupWithoutTheSeam(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.env.Session = func(context.Context, string) (string, error) {
		t.Error("the landing-session seam was consulted for a grouped item")
		return "work", nil
	}
	h.queueGroup("plan-a", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	if res := h.step(); !hasAction(res, ActSpawned, "a") {
		t.Fatalf("no spawn: %+v", res)
	}
	req := h.spawn.reqs[0]
	if req.Session != "plan-a" || !req.EnsureSession {
		t.Fatalf("spawn request = %+v", req)
	}
	if got := operator.ScopeString(h.item("a").Scope, "session"); got != "plan-a" {
		t.Fatalf("recorded session = %q", got)
	}

	delete(h.panes.panes, "%101")
	if res := h.step(); !hasAction(res, ActRespawned, "a") {
		t.Fatalf("no respawn: %+v", res)
	}
	req = h.spawn.reqs[len(h.spawn.reqs)-1]
	if req.Session != "plan-a" || !req.EnsureSession || req.CheckoutBranch != "a" {
		t.Fatalf("respawn request = %+v", req)
	}
}

func TestUngroupedSpawnAndRespawnUseTheSeamAndDoNotEnsure(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	h.step()
	delete(h.panes.panes, "%101")
	h.step()
	if len(h.spawn.reqs) != 2 {
		t.Fatalf("requests = %d", len(h.spawn.reqs))
	}
	for i, req := range h.spawn.reqs {
		if req.Session != "work" || req.EnsureSession {
			t.Errorf("request %d = %+v, want the seam's session and no ensure", i, req)
		}
	}
}

func TestGroupedItemsOfDifferentReposShareTheGroup(t *testing.T) {
	h := newHarness(t)
	foo, bar := newRepo(t, "foo"), newRepo(t, "bar")
	h.queueGroup("plan-a", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: bar.Dir, Task: "b", DependsOn: &[]string{}})
	h.step()
	if len(h.spawn.reqs) != 2 {
		t.Fatalf("requests = %d", len(h.spawn.reqs))
	}
	for _, req := range h.spawn.reqs {
		if req.Session != "plan-a" {
			t.Errorf("request %s landed in %q", req.WorktreeName, req.Session)
		}
	}
}

func TestGroupedSpawnFailureLeavesTheItemPendingAndRetriesIntoTheGroup(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queueGroup("plan-a", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	h.spawn.failWith = errors.New("group session plan-a: tmux unavailable")
	res := h.step()
	if !hasEscalation(res, "tmux unavailable") || spawningSet(h.item("a")) || h.stateOf(h.item("a")) != QueuePending {
		t.Fatalf("res=%+v scope=%+v", res, h.item("a").Scope)
	}
	h.spawn.failWith = nil
	if res := h.step(); !hasAction(res, ActSpawned, "a") {
		t.Fatalf("the item was not retried: %+v", res)
	}
	if last := h.spawn.reqs[len(h.spawn.reqs)-1]; last.Session != "plan-a" {
		t.Fatalf("retry landed in %q", last.Session)
	}
}

func TestStatusShowsGroupOnlyWhenSet(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queueGroup("plan-a", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	h.queue("", Entry{ID: "b", Repo: foo.Dir, Task: "b", DependsOn: &[]string{}})
	res, err := Status(context.Background(), h.env)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Items []map[string]interface{} `json:"items"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Items[0]["group"] != "plan-a" {
		t.Errorf("item a = %v", doc.Items[0])
	}
	if _, ok := doc.Items[1]["group"]; ok {
		t.Errorf("item b carries group: %v", doc.Items[1])
	}
}
