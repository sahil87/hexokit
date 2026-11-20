package ghhooks

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"rk/internal/cron"
	"rk/internal/operator"
)

func prItem(t *testing.T, id, nwo string, pr int, branch string) operator.TrackedItem {
	t.Helper()
	scope := map[string]interface{}{"pr": float64(pr)}
	if branch != "" {
		scope["branch"] = branch
	}
	it, err := operator.NewGitHubPRItem(id, nil, scope, nwo)
	if err != nil {
		t.Fatalf("NewGitHubPRItem: %v", err)
	}
	return it
}

// queueItem is a queue item's ledger projection: a pane item whose scope.repo
// is a local checkout path.
func queueItem(id, repo, change, branch string) operator.TrackedItem {
	return operator.TrackedItem{
		ID: id, Kind: operator.KindPane,
		Scope: map[string]interface{}{"repo": repo, "change": change, "branch": branch},
	}
}

func state(branchMap map[string]operator.BranchMapEntry, items ...operator.TrackedItem) *operator.State {
	return &operator.State{Tracked: items, BranchMap: branchMap}
}

// source builds a Source over fixed ledgers; origins maps a checkout path to
// its owner/name. originCalls counts git lookups.
func source(servers []string, ledgers map[string]*operator.State, origins map[string]string, originCalls map[string]int) Source {
	return Source{
		Servers: func(context.Context) ([]string, error) { return servers, nil },
		State: func(_ context.Context, server string) (*operator.State, error) {
			st, ok := ledgers[server]
			if !ok {
				return nil, errors.New("unreadable ledger")
			}
			return st, nil
		},
		OriginNWO: func(_ context.Context, dir string) (string, error) {
			originCalls[dir]++
			nwo, ok := origins[dir]
			if !ok {
				return "", errors.New("not a git checkout")
			}
			return nwo, nil
		},
	}
}

func TestMatchGitHubPRItems(t *testing.T) {
	ledgers := map[string]*operator.State{
		"work": state(nil, prItem(t, "pr-12", "o/r", 12, "")),
		"play": state(nil),
		"byb":  state(nil, prItem(t, "pr-b", "O/R", 99, "feat-b")),
		"othr": state(nil, prItem(t, "pr-o", "other/repo", 12, "")),
	}
	src := source([]string{"work", "play", "byb", "othr"}, ledgers, nil, map[string]int{})

	t.Run("by PR number", func(t *testing.T) {
		hits := Match(context.Background(), src, Event{Name: "pull_request", NWO: "o/r", PRs: []int{12}, Branch: "x"}, nil)
		want := []Hit{{Server: "work", PR: 12, Branch: "x"}}
		if !reflect.DeepEqual(hits, want) {
			t.Errorf("hits = %+v, want %+v", hits, want)
		}
	})
	t.Run("by branch, repo compared case-insensitively", func(t *testing.T) {
		hits := Match(context.Background(), src, Event{Name: "check_suite", NWO: "o/r", Branch: "feat-b"}, nil)
		want := []Hit{{Server: "byb", Branch: "feat-b"}}
		if !reflect.DeepEqual(hits, want) {
			t.Errorf("hits = %+v, want %+v", hits, want)
		}
	})
	t.Run("an untracked PR matches nothing", func(t *testing.T) {
		if hits := Match(context.Background(), src, Event{Name: "pull_request", NWO: "o/r", PRs: []int{1234}, Branch: "nope"}, nil); len(hits) != 0 {
			t.Errorf("hits = %+v, want none", hits)
		}
	})
	t.Run("the same PR number in another repo does not match", func(t *testing.T) {
		hits := Match(context.Background(), src, Event{Name: "pull_request", NWO: "third/repo", PRs: []int{12}}, nil)
		if len(hits) != 0 {
			t.Errorf("hits = %+v, want none", hits)
		}
	})
}

func TestMatchQueueProjection(t *testing.T) {
	bm := map[string]operator.BranchMapEntry{"260101-ab12-thing": {Branch: "260101-ab12-thing", Repo: "/code/r"}}
	ledgers := map[string]*operator.State{
		// scope.branch is the stale spawn-time name; branch_map has the real one.
		"work": state(bm, queueItem("q1", "/code/r", "260101-ab12-thing", "spawn-time-name")),
		// A checkout of a different repo on the same branch name.
		"elsewhere": state(nil, queueItem("q2", "/code/other", "", "feat-x")),
		// A relative path is not a checkout rk can resolve.
		"rel": state(nil, queueItem("q3", "relative/path", "", "feat-x")),
	}
	origins := map[string]string{"/code/r": "o/r", "/code/other": "x/y"}
	calls := map[string]int{}
	src := source([]string{"work", "elsewhere", "rel"}, ledgers, origins, calls)

	t.Run("by branch_map branch and resolved nwo", func(t *testing.T) {
		hits := Match(context.Background(), src, Event{Name: "check_suite", NWO: "o/r", PRs: []int{5}, Branch: "260101-ab12-thing"}, nil)
		want := []Hit{{Server: "work", Branch: "260101-ab12-thing"}}
		if !reflect.DeepEqual(hits, want) {
			t.Errorf("hits = %+v, want %+v", hits, want)
		}
	})
	t.Run("the stale scope.branch no longer matches", func(t *testing.T) {
		if hits := Match(context.Background(), src, Event{Name: "check_suite", NWO: "o/r", Branch: "spawn-time-name"}, nil); len(hits) != 0 {
			t.Errorf("hits = %+v, want none", hits)
		}
	})
	t.Run("same branch name in another repo is not this repo's PR", func(t *testing.T) {
		if hits := Match(context.Background(), src, Event{Name: "check_suite", NWO: "o/r", Branch: "feat-x"}, nil); len(hits) != 0 {
			t.Errorf("hits = %+v, want none", hits)
		}
	})
	t.Run("git is only asked about items whose branch matches", func(t *testing.T) {
		clear(calls)
		Match(context.Background(), src, Event{Name: "pull_request", NWO: "o/r", PRs: []int{1}, Branch: "unrelated"}, nil)
		if len(calls) != 0 {
			t.Errorf("origin lookups for a non-matching branch: %v", calls)
		}
	})
	t.Run("a branch-less event cannot match a projection", func(t *testing.T) {
		if hits := Match(context.Background(), src, Event{Name: "pull_request", NWO: "o/r", PRs: []int{5}}, nil); len(hits) != 0 {
			t.Errorf("hits = %+v, want none", hits)
		}
	})
}

func TestMatchOnePerServerPRNumberWins(t *testing.T) {
	ledgers := map[string]*operator.State{
		"work": state(nil,
			prItem(t, "pr-by-branch", "o/r", 40, "feat-x"),
			prItem(t, "pr-12", "o/r", 12, ""),
			prItem(t, "pr-13", "o/r", 13, ""),
		),
	}
	src := source([]string{"work"}, ledgers, nil, map[string]int{})
	hits := Match(context.Background(), src, Event{Name: "check_suite", NWO: "o/r", PRs: []int{12, 13}, Branch: "feat-x"}, nil)
	want := []Hit{{Server: "work", PR: 12, Branch: "feat-x"}}
	if !reflect.DeepEqual(hits, want) {
		t.Errorf("hits = %+v, want one hit on the first matched PR %+v", hits, want)
	}
}

func TestMatchDoneItemsStillMatch(t *testing.T) {
	done := prItem(t, "pr-12", "o/r", 12, "")
	at := "2026-11-20T10:00:00Z"
	done.DoneAt = &at
	src := source([]string{"work"}, map[string]*operator.State{"work": state(nil, done)}, nil, map[string]int{})
	if hits := Match(context.Background(), src, Event{Name: "pull_request", NWO: "o/r", PRs: []int{12}}, nil); len(hits) != 1 {
		t.Errorf("hits = %+v, want the done item matched (one free check)", hits)
	}
}

func TestMatchSkipsUnreadableLedgerAndReports(t *testing.T) {
	ledgers := map[string]*operator.State{"good": state(nil, prItem(t, "pr-12", "o/r", 12, ""))}
	src := source([]string{"broken", "good"}, ledgers, nil, map[string]int{})
	var reported []string
	hits := Match(context.Background(), src, Event{Name: "pull_request", NWO: "o/r", PRs: []int{12}}, func(server string, _ error) {
		reported = append(reported, server)
	})
	if len(hits) != 1 || hits[0].Server != "good" {
		t.Errorf("hits = %+v, want only the readable server", hits)
	}
	if !reflect.DeepEqual(reported, []string{"broken"}) {
		t.Errorf("reported = %v, want [broken]", reported)
	}
}

func TestMatchServerDiscoveryFailure(t *testing.T) {
	src := Source{Servers: func(context.Context) ([]string, error) { return nil, errors.New("no tmux") }}
	var got error
	if hits := Match(context.Background(), src, Event{NWO: "o/r", PRs: []int{1}}, func(_ string, err error) { got = err }); len(hits) != 0 || got == nil {
		t.Errorf("hits = %+v, err = %v; want none and the error reported", hits, got)
	}
}

func TestReason(t *testing.T) {
	ev := Event{Name: "check_suite", NWO: "sahil87/hexokit"}
	if got := Reason(ev, Hit{PR: 1162}); got != "pr:sahil87/hexokit#1162:check_suite" {
		t.Errorf("PR reason = %q", got)
	}
	if got := Reason(ev, Hit{Branch: "feat-x"}); got != "pr:sahil87/hexokit#feat-x:check_suite" {
		t.Errorf("branch reason = %q", got)
	}
	long := Reason(ev, Hit{Branch: strings.Repeat("é", 300)})
	if n := len([]rune(long)); n != cron.MaxWakeReasonRunes {
		t.Errorf("long reason has %d runes, want it cut to %d", n, cron.MaxWakeReasonRunes)
	}
	if _, err := cron.NormalizeWakeReason(long); err != nil {
		t.Errorf("a truncated reason must pass the marker's own validation: %v", err)
	}
}
