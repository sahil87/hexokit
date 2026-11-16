package autopilot

import (
	"context"
	"errors"
	"strings"
)

// These responses assert the requested state, unlike authentication, transport,
// and ambiguous policy errors. Unknown failures keep the durable intent marker.
func alreadyApplied(err error, operation string) bool {
	if err == nil {
		return true
	}
	msg := strings.ToLower(stderrOf(err))
	var phrases []string
	switch operation {
	case "arm":
		phrases = []string{"already enabled", "already has auto"}
	case "disarm":
		phrases = []string{"auto-merge is already disabled", "auto merge is already disabled", "auto-merge is not enabled", "auto merge is not enabled", "auto-merge is not currently enabled", "auto merge is not currently enabled"}
	case "ready":
		phrases = []string{"already marked as ready", "already ready for review", "pull request is not a draft"}
	case "rebase-abort":
		phrases = []string{"no rebase in progress"}
	case "cherry-pick-abort":
		phrases = []string{"no cherry-pick or revert in progress", "no cherry-pick in progress"}
	case "merge":
		phrases = []string{"pull request is already merged", "pull request was already merged"}
	}
	for _, phrase := range phrases {
		if strings.Contains(msg, phrase) {
			return true
		}
	}
	return false
}

// The base name is not always included in gh's "not changed" response. Verify
// the postcondition instead of treating an arbitrary edit failure as success.
func (e *engine) retarget(ctx context.Context, repo, n, base string) error {
	_, err := e.gh(ctx, repo, "pr", "edit", n, "--base", base)
	if err == nil {
		return nil
	}
	msg := strings.ToLower(stderrOf(err))
	if strings.Contains(msg, "already") || strings.Contains(msg, "base branch was not changed") {
		view, viewErr := e.viewPR(ctx, repo, n, "baseRefName")
		if viewErr != nil {
			return errors.Join(err, viewErr)
		}
		if view.BaseRefName == base {
			return nil
		}
	}
	return err
}
