package autopilot

import (
	"os"
	"testing"
)

// TestMain pins a hermetic git environment for the whole package: the engine's
// real runner inherits the process env, so its own `git commit` (cherry-pick)
// and `git rebase` need an identity even on hosts (CI) with no user git config,
// and must not pick up a developer's global hooks or signing config.
func TestMain(m *testing.M) {
	for k, v := range map[string]string{
		"GIT_AUTHOR_NAME":     "t",
		"GIT_AUTHOR_EMAIL":    "t@t",
		"GIT_COMMITTER_NAME":  "t",
		"GIT_COMMITTER_EMAIL": "t@t",
		"GIT_CONFIG_GLOBAL":   "/dev/null",
		"GIT_CONFIG_NOSYSTEM": "1",
	} {
		os.Setenv(k, v)
	}
	os.Exit(m.Run())
}
