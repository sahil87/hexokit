package operator

import (
	"reflect"
	"testing"
)

func TestNewGitHubPRItemRequiresExplicitRepository(t *testing.T) {
	for _, nwo := range []string{"", "repo", "/repo", "owner/", "--repo", "owner/repo/extra"} {
		if _, err := NewGitHubPRItem("pr-1", nil, map[string]interface{}{"pr": 1}, nwo); err == nil {
			t.Errorf("accepted repository %q", nwo)
		}
	}
	it, err := NewGitHubPRItem("pr-1", nil, map[string]interface{}{"pr": 1}, "owner/repo")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"gh", "pr", "view", "1", "--repo", "owner/repo", "--json", "state,mergedAt,mergeable"}
	if !reflect.DeepEqual(it.Probe.Argv, want) {
		t.Fatalf("argv = %q", it.Probe.Argv)
	}
}
