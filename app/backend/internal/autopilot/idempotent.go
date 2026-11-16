package autopilot

import "strings"

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
