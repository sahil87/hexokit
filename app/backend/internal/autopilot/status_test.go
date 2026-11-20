package autopilot

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"rk/internal/operator"
)

func TestDeriveQueuePrecedence(t *testing.T) {
	x := newFx(t)
	// done › paused › skipped › held › pending/spawn-unknown/spawned/dead.
	done := x.queue("done", operator.MergeModeCherryPickLadder, "ghost")
	now := fxNow.Format(time.RFC3339)
	done.DoneAt = &now
	done.Paused = true
	paused := x.queue("paused", operator.MergeModeCherryPickLadder, "ghost")
	paused.Paused = true
	paused.Scope[scopeSkipped] = true
	skippedItem := x.queue("skipped", operator.MergeModeCherryPickLadder, "ghost")
	skippedItem.Scope[scopeSkipped] = true
	x.queue("held", operator.MergeModeCherryPickLadder, "ghost")
	deadHeld := x.queue("dead-held", operator.MergeModeCherryPickLadder, "ghost")
	x.pane(deadHeld, false)

	st := x.state()
	want := map[string]QueueStatus{
		"done": QueueDone, "paused": QueuePaused, "skipped": QueueSkipped, "held": QueueHeld, "dead-held": QueueHeld,
	}
	for id, w := range want {
		if got := deriveQueue(st, x.f, st.Tracked[operator.IndexOf(st.Tracked, id)]); got != w {
			t.Errorf("%s = %s, want %s", id, got, w)
		}
	}
}

func TestDeriveQueuePaneStatuses(t *testing.T) {
	cases := []struct {
		name  string
		setup func(x *fx, it *operator.TrackedItem)
		want  QueueStatus
	}{
		{"no pane, no marker", func(x *fx, it *operator.TrackedItem) {}, QueuePending},
		{"marker, no pane", func(x *fx, it *operator.TrackedItem) { it.Scope[scopeSpawning] = "t" }, QueueSpawnUnknown},
		{"live pane", func(x *fx, it *operator.TrackedItem) { x.pane(it, true) }, QueueSpawned},
		{"recorded pane gone", func(x *fx, it *operator.TrackedItem) { x.pane(it, false) }, QueueDead},
		{"a crashed respawn leaves the old pane id and its marker", func(x *fx, it *operator.TrackedItem) {
			x.pane(it, false)
			it.Scope[scopeSpawning] = "t"
			it.Scope[scopeRespawned] = true
		}, QueueSpawnUnknown},
		{"completion observed", func(x *fx, it *operator.TrackedItem) {
			x.pane(it, true)
			x.f.queueFor(it.ID).completed = true
		}, QueueDone},
		{"pane snapshot unavailable reads a recorded pane as alive", func(x *fx, it *operator.TrackedItem) {
			x.pane(it, false)
			x.f.panesKnown = false
		}, QueueSpawned},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			x := newFx(t)
			it := x.queue("a", operator.MergeModeCherryPickLadder)
			c.setup(x, it)
			st := x.state()
			if got := deriveQueue(st, x.f, st.Tracked[0]); got != c.want {
				t.Fatalf("status = %s, want %s", got, c.want)
			}
		})
	}
}

func TestDeriveQueueHeldByDependencies(t *testing.T) {
	t.Run("an unfinished dependency holds", func(t *testing.T) {
		x := newFx(t)
		x.queue("a", operator.MergeModeCherryPickLadder)
		x.queue("b", operator.MergeModeCherryPickLadder, "a")
		st := x.state()
		if got := deriveQueue(st, x.f, st.Tracked[1]); got != QueueHeld {
			t.Fatalf("b = %s", got)
		}
	})
	t.Run("a dependency whose completion is observed counts as done", func(t *testing.T) {
		x := newFx(t)
		a := x.queue("a", operator.MergeModeCherryPickLadder)
		a.Scope["stop_stage"] = "hydrate"
		x.pane(a, true)
		x.f.queueFor("a").completed = true
		x.queue("b", operator.MergeModeCherryPickLadder, "a")
		st := x.state()
		if got := deriveQueue(st, x.f, st.Tracked[1]); got != QueuePending {
			t.Fatalf("b = %s: a stop-stage dependency needs no PR", got)
		}
	})
	t.Run("a same-repo dependency needs its PR", func(t *testing.T) {
		x := newFx(t)
		a := x.queue("a", operator.MergeModeCherryPickLadder)
		now := fxNow.Format(time.RFC3339)
		a.DoneAt = &now
		x.queue("b", operator.MergeModeCherryPickLadder, "a")
		st := x.state()
		if got := deriveQueue(st, x.f, st.Tracked[1]); got != QueueHeld {
			t.Fatalf("no PR observed: b = %s", got)
		}
		x.f.queueFor("b").depPR["a"] = true
		if got := deriveQueue(st, x.f, st.Tracked[1]); got != QueuePending {
			t.Fatalf("PR observed: b = %s", got)
		}
	})
	t.Run("merge-auto waits for the dependency's PR to read merged", func(t *testing.T) {
		x := newFx(t)
		a := x.queue("a", operator.MergeModeMergeAuto)
		now := fxNow.Format(time.RFC3339)
		a.DoneAt = &now
		x.queue("b", operator.MergeModeMergeAuto, "a")
		st := x.state()
		if got := deriveQueue(st, x.f, st.Tracked[1]); got != QueueHeld {
			t.Fatalf("b = %s before a's PR is read", got)
		}
		x.f.queueFor("b").depPR["a"] = true
		if got := deriveQueue(st, x.f, st.Tracked[1]); got != QueueHeld {
			t.Fatalf("b = %s: an existing PR is not a merged one", got)
		}
		x.f.queueFor("b").depMerged["a"] = true
		if got := deriveQueue(st, x.f, st.Tracked[1]); got != QueuePending {
			t.Fatalf("b = %s once a's PR reads merged", got)
		}
	})
	t.Run("a dependency that survives only in branch_map is satisfied", func(t *testing.T) {
		x := newFx(t)
		x.queue("b", operator.MergeModeCherryPickLadder, "gone")
		st := x.state()
		st.BranchMap["gone"] = operator.BranchMapEntry{Branch: "gone-branch", Repo: "/r"}
		if got := deriveQueue(st, x.f, st.Tracked[0]); got != QueuePending {
			t.Fatalf("b = %s", got)
		}
	})
}

// derive reads the ledger and the facts only; it never reaches outside.
func TestFingerprintCoversDecisionInputsNotObservationClocks(t *testing.T) {
	x := newFx(t)
	it := x.queue("p", operator.MergeModeCherryPickLadder)
	base := fingerprint(*it)
	noise := *it
	noise.UpdatedAt, noise.Unchanged, noise.Failures = "2030-01-01T00:00:00Z", 5, 2
	checked := "2030-01-01T00:00:00Z"
	noise.CheckedAt = &checked
	noise.Last = map[string]interface{}{"state": "OPEN"}
	noise.Seen = []string{"x"}
	noise.Notes = []operator.Note{{Text: "hello"}}
	noise.Scope = map[string]interface{}{}
	for k, v := range it.Scope {
		noise.Scope[k] = v
	}
	noise.Scope["stage"], noise.Scope[scopeEscalated] = "apply", map[string]interface{}{"k": "v"}
	if got := fingerprint(noise); got != base {
		t.Fatalf("observation clocks changed the fingerprint:\n%s\n%s", base, got)
	}
	for name, mutate := range map[string]func(*operator.TrackedItem){
		"scope.repo":   func(i *operator.TrackedItem) { i.Scope["repo"] = "/other" },
		"scope.branch": func(i *operator.TrackedItem) { i.Scope["branch"] = "other-branch" },
		"probe":        func(i *operator.TrackedItem) { i.Probe.Argv = append([]string{}, "gh", "pr", "view", "8") },
		"respawned":    func(i *operator.TrackedItem) { i.Scope[scopeRespawned] = true },
		"paused":       func(i *operator.TrackedItem) { i.Paused = true },
		"done_at":      func(i *operator.TrackedItem) { now := "2030-01-01T00:00:00Z"; i.DoneAt = &now },
		"depends_on":   func(i *operator.TrackedItem) { i.DependsOn = []string{"q"} },
	} {
		changed := *it
		changed.Scope = map[string]interface{}{}
		for k, v := range it.Scope {
			changed.Scope[k] = v
		}
		mutate(&changed)
		if fingerprint(changed) == base {
			t.Errorf("a change to %s did not change the fingerprint", name)
		}
	}
}

// status lists queue items only and carries no PR fields: a former PR
// projection in the ledger is left to `track list`.
func TestStatusCarriesQueueFactsOnly(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("merge-auto", Entry{ID: "a", Repo: foo.Dir, Change: "aaaa", StopStage: ptr("hydrate")}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	h.attachBranch("a", "a-branch")
	h.setDone("a")
	h.setDone("b")
	h.attachBranch("b", "b-branch")
	h.gh.add(1, "a-branch").State = "MERGED"
	h.gh.add(2, "b-branch")
	pr, err := operator.NewGitHubPRItem("pr-41", nil, map[string]interface{}{"repo": foo.Dir, "pr": 41}, "o/foo")
	if err != nil {
		t.Fatal(err)
	}
	writeOperatorItems(t, h.env.StatePath, pr)

	res, err := Status(context.Background(), h.env)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Items) != 2 || res.Items[0].ID != "a" || res.Items[1].ID != "b" || !res.Complete || res.Summary == "" {
		t.Fatalf("status = %+v", res)
	}
	raw, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	for _, gone := range []string{"pr_status", "fixes", "halted", "sequence", "pr-41", `"pr"`} {
		if strings.Contains(string(raw), gone) {
			t.Fatalf("status JSON carries %q: %s", gone, raw)
		}
	}
	var doc struct {
		Items []map[string]interface{} `json:"items"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"id", "state", "mode", "repo", "branch", "depends_on", "queue", "task", "change", "stop_stage"} {
		found := false
		for _, item := range doc.Items {
			if _, ok := item[key]; ok {
				found = true
			}
		}
		if !found {
			t.Errorf("status JSON lost the %q key: %s", key, raw)
		}
	}
}
