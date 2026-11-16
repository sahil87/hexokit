package main

import (
	"rk/internal/autopilot"
	"rk/internal/operator"

	"github.com/spf13/cobra"
)

var operatorAutopilotRemoveCmd = &cobra.Command{
	Use:   "rm <id> [--all] [--json]",
	Short: "Remove an unspawned queue item or a halted merge sequence",
	Long: `Remove one unspawned queue item (no pane and no spawning marker), or every PR
item of a halted merge sequence. The argument is a queue item id, a PR item id,
or a merge_seq. A queue item with unfinished dependents is refused. Engine state
and projections are updated under the pass lock, then one pass runs.

Flags:
  -L, --server    tmux server (default: the caller's own server from $TMUX)
  --all           show every entry (human lists default to 20 entries each)
  --json          machine-readable envelope on stdout

Examples:
  rk operator autopilot rm ab12
  rk operator autopilot rm pr-41

Exit codes:
  0  removed, or busy
  1  operational failure or a pass error
  2  usage error (unknown id, spawned or spawning item, unfinished dependents,
     or a sequence that is not halted)`,
	Args:         usageArgs(cobra.ExactArgs(1)),
	SilenceUsage: true,
	RunE:         runAutopilotRemove,
}

var operatorAutopilotResumeCmd = &cobra.Command{
	Use:   "resume <id> [--all] [--json]",
	Short: "Resume one halted, skipped, or paused autopilot item",
	Long: `Clear halted, skipped, or paused intent on one engine item, including a pause
on its projection, then run one pass. Clearing halted on the item that carries
it resumes that item's derived downstream cone.

Flags:
  -L, --server    tmux server (default: the caller's own server from $TMUX)
  --all           show every entry (human lists default to 20 entries each)
  --json          machine-readable envelope on stdout

Examples:
  rk operator autopilot resume pr-41
  rk operator autopilot resume ab12

Exit codes:
  0  resumed, or busy
  1  operational failure or a pass error
  2  usage error (unknown id, or the item is not halted, skipped, or paused)`,
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
