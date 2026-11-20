package main

import (
	"rk/internal/autopilot"
	"rk/internal/operator"

	"github.com/spf13/cobra"
)

var operatorAutopilotRemoveCmd = &cobra.Command{
	Use:   "rm <id> [--all] [--json]",
	Short: "Remove an unspawned queue item",
	Long: `Remove one unspawned queue item (no pane and no spawning marker) and its
identity-only projection. A queue item with unfinished dependents is refused. Any
other id, including a PR's, is an unknown id. Engine state and the projection are
updated under the pass lock, then one pass runs.

Flags:
  -L, --server    tmux server (default: the caller's own server from $TMUX)
  --all           show every entry (human lists default to 20 entries each)
  --json          machine-readable envelope on stdout

Examples:
  rk operator autopilot rm ab12

Exit codes:
  0  removed, or busy
  1  operational failure or a pass error
  2  usage error (unknown id, spawned or spawning item, or unfinished dependents)`,
	Args:         usageArgs(cobra.ExactArgs(1)),
	SilenceUsage: true,
	RunE:         runAutopilotRemove,
}

var operatorAutopilotResumeCmd = &cobra.Command{
	Use:   "resume <id> [--all] [--json]",
	Short: "Resume one skipped or paused queue item",
	Long: `Clear skipped or paused intent on one queue item, including a pause on its
projection, then run one pass.

Flags:
  -L, --server    tmux server (default: the caller's own server from $TMUX)
  --all           show every entry (human lists default to 20 entries each)
  --json          machine-readable envelope on stdout

Examples:
  rk operator autopilot resume ab12

Exit codes:
  0  resumed, or busy
  1  operational failure or a pass error
  2  usage error (unknown id, or the item is neither skipped nor paused)`,
	Args:         usageArgs(cobra.ExactArgs(1)),
	SilenceUsage: true,
	RunE:         runAutopilotResume,
}

func runAutopilotRemove(cmd *cobra.Command, args []string) error {
	env, err := autopilotEnvFn(cmd, operator.ByChat, false)
	if err != nil {
		return autopilotFinish(cmd, nil, nil, err)
	}
	res, err := autopilot.Remove(operatorTrackContext(cmd), env, args[0])
	return autopilotFinish(cmd, res, func(s outputSink) { renderStep(cmd, s, res) }, err)
}

func runAutopilotResume(cmd *cobra.Command, args []string) error {
	env, err := autopilotEnvFn(cmd, operator.ByChat, false)
	if err != nil {
		return autopilotFinish(cmd, nil, nil, err)
	}
	res, err := autopilot.Resume(operatorTrackContext(cmd), env, args[0])
	return autopilotFinish(cmd, res, func(s outputSink) { renderStep(cmd, s, res) }, err)
}

var operatorAutopilotPauseCmd = &cobra.Command{
	Use:   "pause <id> [--json]",
	Short: "Hold an unspawned queue item until resume",
	Long: `Set paused on one unspawned engine queue item, so the spawn gate skips it
until 'rk operator autopilot pause' is undone by 'rk operator autopilot resume
<id>' — the user gate of a plan step. A queue entry can also start paused
('"paused": true' in its JSON). A spawned, done, or non-queue id is a usage
error: a live pane is not held by a flag (stop its agent instead). An already
paused item is a no-op.

Flags:
  -L, --server    tmux server (default: the caller's own server from $TMUX)
  --json          machine-readable envelope on stdout

Examples:
  rk operator autopilot pause mp-f2

Exit codes:
  0  paused, already paused, or busy
  1  operational failure
  2  usage error (unknown, spawned, or done id)`,
	Args:         usageArgs(cobra.ExactArgs(1)),
	SilenceUsage: true,
	RunE:         runAutopilotPause,
}

func runAutopilotPause(cmd *cobra.Command, args []string) error {
	env, err := autopilotEnvFn(cmd, operator.ByChat, false)
	if err != nil {
		return autopilotFinish(cmd, nil, nil, err)
	}
	res, err := autopilot.Pause(operatorTrackContext(cmd), env, args[0])
	return autopilotFinish(cmd, res, func(s outputSink) { renderStep(cmd, s, res) }, err)
}
