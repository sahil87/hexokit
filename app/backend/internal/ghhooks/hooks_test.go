package ghhooks

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

// hooksJSON: hook 1 is the shape observed on a repo while `gh webhook forward`
// ran; the rest are hooks the predicate must never match.
const hooksJSON = `[
 {"id":1,"name":"cli","active":true,"events":["check_suite","pull_request"],"config":{"content_type":"json","insecure_ssl":"0","url":"https://webhook-forwarder.github.com/hook"}},
 {"id":2,"name":"web","active":true,"events":["push"],"config":{"url":"https://ci.example/hook"}},
 {"id":3,"name":"web","active":true,"events":["push"],"config":{"url":"https://webhook-forwarder.github.com/hook"}},
 {"id":4,"name":"cli","active":true,"events":["push"],"config":{"url":"https://ci.example/hook"}},
 {"id":5,"name":"cli","active":true,"events":["pull_request"],"config":{"content_type":"json","url":"https://webhook-forwarder.github.com/hook"}}
]`

func TestIsForwarderHook(t *testing.T) {
	hooks, err := decodeHooks(hooksJSON)
	if err != nil {
		t.Fatal(err)
	}
	want := map[int64]bool{1: true, 2: false, 3: false, 4: false, 5: true}
	for _, h := range hooks {
		if got := IsForwarderHook(h); got != want[h.ID] {
			t.Errorf("IsForwarderHook(hook %d) = %v, want %v", h.ID, got, want[h.ID])
		}
	}
}

func decodeHooks(raw string) ([]Hook, error) {
	var out []Hook
	stub := runGH
	runGH = func(context.Context, ...string) ([]byte, error) { return []byte(raw), nil }
	defer func() { runGH = stub }()
	out, err := ListHooks(context.Background(), "o/r")
	return out, err
}

func TestRemoveForwarderHooksDeletesOnlyForwarderHooks(t *testing.T) {
	var deleted []string
	calls := stubGH(t, func(args ...string) ([]byte, error) {
		if len(args) > 1 && args[1] == "-X" {
			deleted = append(deleted, args[3])
			return nil, nil
		}
		return []byte(hooksJSON), nil
	})
	removed, err := RemoveForwarderHooks(context.Background(), "o/r")
	if err != nil {
		t.Fatalf("RemoveForwarderHooks: %v", err)
	}
	if !reflect.DeepEqual(removed, []int64{1, 5}) {
		t.Errorf("removed = %v, want [1 5]", removed)
	}
	if want := []string{"repos/o/r/hooks/1", "repos/o/r/hooks/5"}; !reflect.DeepEqual(deleted, want) {
		t.Errorf("DELETE targets = %v, want %v", deleted, want)
	}
	if (*calls)[0][0] != "api" || (*calls)[0][1] != "repos/o/r/hooks" {
		t.Errorf("first call = %v, want the hook listing", (*calls)[0])
	}
}

func TestRemoveForwarderHooksErrors(t *testing.T) {
	stubGH(t, func(...string) ([]byte, error) { return nil, errors.New("gh api: HTTP 404") })
	if _, err := RemoveForwarderHooks(context.Background(), "o/r"); err == nil {
		t.Error("a listing failure must surface")
	}
	stubGH(t, func(args ...string) ([]byte, error) {
		if len(args) > 1 && args[1] == "-X" {
			return nil, errors.New("gh api: HTTP 403")
		}
		return []byte(hooksJSON), nil
	})
	removed, err := RemoveForwarderHooks(context.Background(), "o/r")
	if err == nil || !strings.Contains(err.Error(), "hook 1") || len(removed) != 0 {
		t.Errorf("removed=%v err=%v, want the sweep to stop at the first failed delete", removed, err)
	}
	stubGH(t, func(...string) ([]byte, error) { return []byte(`not json`), nil })
	if _, err := ListHooks(context.Background(), "o/r"); err == nil {
		t.Error("undecodable listing must be an error")
	}
	if _, err := ListHooks(context.Background(), "bad repo"); err == nil {
		t.Error("an invalid repo must be rejected before gh runs")
	}
}

func TestDeleteHookTreatsAnAlreadyRemovedHookAsDone(t *testing.T) {
	stubGH(t, func(...string) ([]byte, error) { return nil, errors.New("gh api: Not Found (HTTP 404)") })
	if err := DeleteHook(context.Background(), "o/r", 1); err != nil {
		t.Errorf("a 404 means the extension already removed its hook, got %v", err)
	}
	stubGH(t, func(...string) ([]byte, error) { return nil, errors.New("gh api: Forbidden (HTTP 403)") })
	if err := DeleteHook(context.Background(), "o/r", 1); err == nil {
		t.Error("any other failure must surface")
	}
}
