package ghhooks

import (
	"reflect"
	"testing"
)

func TestExtract(t *testing.T) {
	cases := []struct {
		name   string
		event  string
		body   string
		want   Event
		wantOK bool
	}{
		{
			name: "pull_request", event: "pull_request",
			body:   `{"action":"opened","repository":{"full_name":"o/r"},"pull_request":{"number":12,"head":{"ref":"feat-a"}}}`,
			want:   Event{Name: "pull_request", NWO: "o/r", PRs: []int{12}, Branch: "feat-a"},
			wantOK: true,
		},
		{
			name: "pull_request_review", event: "pull_request_review",
			body:   `{"repository":{"full_name":"o/r"},"pull_request":{"number":3,"head":{"ref":"fix"}},"review":{"state":"approved"}}`,
			want:   Event{Name: "pull_request_review", NWO: "o/r", PRs: []int{3}, Branch: "fix"},
			wantOK: true,
		},
		{
			name: "check_suite with PRs", event: "check_suite",
			body:   `{"repository":{"full_name":"o/r"},"check_suite":{"head_branch":"feat-x","pull_requests":[{"number":7},{"number":9}]}}`,
			want:   Event{Name: "check_suite", NWO: "o/r", PRs: []int{7, 9}, Branch: "feat-x"},
			wantOK: true,
		},
		{
			name: "check_suite for a fork carries no PR but a branch", event: "check_suite",
			body:   `{"repository":{"full_name":"o/r"},"check_suite":{"head_branch":"feat-x","pull_requests":[]}}`,
			want:   Event{Name: "check_suite", NWO: "o/r", Branch: "feat-x"},
			wantOK: true,
		},
		{
			name: "workflow_run", event: "workflow_run",
			body:   `{"repository":{"full_name":"o/r"},"workflow_run":{"head_branch":"main-x","pull_requests":[{"number":4}]}}`,
			want:   Event{Name: "workflow_run", NWO: "o/r", PRs: []int{4}, Branch: "main-x"},
			wantOK: true,
		},
		{name: "ping is ignored", event: "ping", body: `{"repository":{"full_name":"o/r"}}`},
		{name: "issues is ignored", event: "issues", body: `{"repository":{"full_name":"o/r"}}`},
		{name: "check_run is not subscribed", event: "check_run", body: `{"repository":{"full_name":"o/r"},"check_run":{"check_suite":{"head_branch":"x"}}}`},
		{name: "no event header", event: "", body: `{}`},
		{
			name: "no PR and no branch", event: "check_suite",
			body: `{"repository":{"full_name":"o/r"},"check_suite":{"pull_requests":[]}}`,
		},
		{
			name: "repository that is not owner/name", event: "pull_request",
			body: `{"repository":{"full_name":"bad repo"},"pull_request":{"number":1,"head":{"ref":"a"}}}`,
		},
		{
			name: "control characters leave the branch", event: "check_suite",
			body:   `{"repository":{"full_name":"o/r"},"check_suite":{"head_branch":"a\nb\u0000c","pull_requests":[]}}`,
			want:   Event{Name: "check_suite", NWO: "o/r", Branch: "abc"},
			wantOK: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok, err := Extract(tc.event, []byte(tc.body))
			if err != nil {
				t.Fatalf("Extract: %v", err)
			}
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v (event %+v)", ok, tc.wantOK, got)
			}
			if ok && !reflect.DeepEqual(got, tc.want) {
				t.Errorf("event = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestExtractMalformedJSON(t *testing.T) {
	if _, ok, err := Extract("pull_request", []byte(`{not json`)); err == nil || ok {
		t.Errorf("malformed body: ok=%v err=%v, want an error", ok, err)
	}
	// An unsubscribed event is never decoded, so its body cannot be an error.
	if _, ok, err := Extract("ping", []byte(`{not json`)); err != nil || ok {
		t.Errorf("unsubscribed event: ok=%v err=%v, want ignored without error", ok, err)
	}
}

func TestEventsExcludeCheckRun(t *testing.T) {
	want := []string{"pull_request", "pull_request_review", "check_suite", "workflow_run"}
	if !reflect.DeepEqual(Events, want) {
		t.Errorf("Events = %v, want %v", Events, want)
	}
}
