package autopilot

import "strings"

// noCherryPickInProgress reports git's answer to `cherry-pick --abort` when
// nothing was in progress: the state the abort wanted, so not a failure.
func noCherryPickInProgress(err error) bool {
	if err == nil {
		return true
	}
	msg := strings.ToLower(stderrOf(err))
	return strings.Contains(msg, "no cherry-pick or revert in progress") || strings.Contains(msg, "no cherry-pick in progress")
}
