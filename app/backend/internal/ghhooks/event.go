package ghhooks

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"unicode"

	"rk/internal/validate"
)

// Events are the GitHub event names the forwarder subscribes to. check_run is
// deliberately absent: check_suite already covers a PR's checks settling, at
// a fraction of the delivery volume.
var Events = []string{"pull_request", "pull_request_review", "check_suite", "workflow_run"}

// HookPath is the one route the receiver serves.
const HookPath = "/hooks/github"

// EventHeader carries the event name on a GitHub delivery.
const EventHeader = "X-GitHub-Event"

// Event is what the receiver keeps of a delivery: which repo, which PRs, which
// head branch. Nothing else of the payload survives Extract.
type Event struct {
	Name   string
	NWO    string
	PRs    []int
	Branch string
}

// payload is the union of the fields the four event kinds carry that matter
// for mapping; every other field is dropped by the decoder.
type payload struct {
	Repository struct {
		FullName string `json:"full_name"`
	} `json:"repository"`
	PullRequest *pullRequest `json:"pull_request"`
	CheckSuite  *checkRun    `json:"check_suite"`
	WorkflowRun *checkRun    `json:"workflow_run"`
}

type pullRequest struct {
	Number int `json:"number"`
	Head   struct {
		Ref string `json:"ref"`
	} `json:"head"`
}

// checkRun is the shared shape of check_suite and workflow_run.
type checkRun struct {
	HeadBranch   string `json:"head_branch"`
	PullRequests []struct {
		Number int `json:"number"`
	} `json:"pull_requests"`
}

// Extract reads the repository and PR identity out of a delivery. ok is false
// for an event the receiver does not map, a repository name that is not
// owner/name, and a delivery that names neither a PR nor a branch — all of
// which are ignored, not errors. A body that is not JSON is an error.
func Extract(event string, body []byte) (ev Event, ok bool, err error) {
	if !slices.Contains(Events, event) {
		return Event{}, false, nil
	}
	var p payload
	if err := json.Unmarshal(body, &p); err != nil {
		return Event{}, false, fmt.Errorf("decoding %s payload: %w", event, err)
	}
	ev = Event{Name: event, NWO: p.Repository.FullName}
	if validate.ValidateGitHubRepo(ev.NWO) != "" {
		return Event{}, false, nil
	}
	switch event {
	case "pull_request", "pull_request_review":
		if p.PullRequest != nil {
			ev.PRs = positive(p.PullRequest.Number)
			ev.Branch = p.PullRequest.Head.Ref
		}
	case "check_suite":
		ev.PRs, ev.Branch = fromCheckRun(p.CheckSuite)
	case "workflow_run":
		ev.PRs, ev.Branch = fromCheckRun(p.WorkflowRun)
	}
	ev.Branch = cleanBranch(ev.Branch)
	if len(ev.PRs) == 0 && ev.Branch == "" {
		return Event{}, false, nil
	}
	return ev, true, nil
}

func fromCheckRun(c *checkRun) (prs []int, branch string) {
	if c == nil {
		return nil, ""
	}
	for _, pr := range c.PullRequests {
		prs = append(prs, positive(pr.Number)...)
	}
	return prs, c.HeadBranch
}

func positive(n int) []int {
	if n > 0 {
		return []int{n}
	}
	return nil
}

// cleanBranch drops control characters: the branch rides into a one-line wake
// marker reason, and git itself never allows them in a ref name.
func cleanBranch(branch string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, strings.TrimSpace(branch))
}
