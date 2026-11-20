package ghhooks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	hooks, err := decodeHooks(t, hooksJSON)
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

// ghHookLines renders a JSON array the way `gh api --paginate --jq '.[]'`
// prints it: one compact object per line.
func ghHookLines(t *testing.T, array string) []byte {
	t.Helper()
	var objs []json.RawMessage
	if err := json.Unmarshal([]byte(array), &objs); err != nil {
		t.Fatal(err)
	}
	var out []byte
	for _, o := range objs {
		out = append(out, o...)
		out = append(out, '\n')
	}
	return out
}

func decodeHooks(t *testing.T, array string) ([]Hook, error) {
	t.Helper()
	stubGH(t, func(...string) ([]byte, error) { return ghHookLines(t, array), nil })
	return ListHooks(context.Background(), "o/r")
}

func TestRemoveForwarderHooksDeletesOnlyForwarderHooks(t *testing.T) {
	var deleted []string
	calls := stubGH(t, func(args ...string) ([]byte, error) {
		if len(args) > 1 && args[1] == "-X" {
			deleted = append(deleted, args[3])
			return nil, nil
		}
		return ghHookLines(t, hooksJSON), nil
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
	if !reflect.DeepEqual((*calls)[0], []string{"api", "--paginate", "repos/o/r/hooks", "--jq", ".[]"}) {
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
		return ghHookLines(t, hooksJSON), nil
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

func TestListHooksReadsEveryPage(t *testing.T) {
	// gh flattens pages, so 31+ hooks arrive as 31+ lines — the first page's 30
	// are not all there is.
	var lines []byte
	for i := 1; i <= 35; i++ {
		name, url := "web", "https://ci.example/hook"
		if i == 33 {
			name, url = "cli", "https://webhook-forwarder.github.com/hook"
		}
		lines = append(lines, []byte(fmt.Sprintf(`{"id":%d,"name":%q,"config":{"url":%q}}`+"\n", i, name, url))...)
	}
	stubGH(t, func(args ...string) ([]byte, error) {
		if len(args) > 1 && args[1] == "-X" {
			return nil, nil
		}
		return lines, nil
	})
	hooks, err := ListHooks(context.Background(), "o/r")
	if err != nil || len(hooks) != 35 {
		t.Fatalf("hooks = %d, err = %v, want all 35", len(hooks), err)
	}
	removed, err := RemoveForwarderHooks(context.Background(), "o/r")
	if err != nil || !reflect.DeepEqual(removed, []int64{33}) {
		t.Errorf("removed = %v err = %v, want the forwarder hook beyond the first page", removed, err)
	}
}

func TestDeleteHookOnlyTreatsHTTP404AsGone(t *testing.T) {
	stubGH(t, func(...string) ([]byte, error) { return nil, errors.New("gh api: rate limit, retry in 404s") })
	if err := DeleteHook(context.Background(), "o/r", 1); err == nil {
		t.Error("a stray 404 in other text must not read as already-gone")
	}
}
