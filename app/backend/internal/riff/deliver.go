package riff

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"rk/internal/inject"
	"rk/internal/tmux"
)

// Task delivery: a skill pane's non-empty Value is the task. A claude launcher
// takes it as the positional argument at composition time (instant, race-free);
// any other launcher composes bare (taskPaneShellString) and the task is typed
// into the booted pane-0 after the window spawns, via inject.DeliverWhenReady —
// the same boot-readiness wait + verified send the tutorial uses. A delivery
// failure never fails the spawn: the window and agent exist either way, so the
// CLI prints a paste-it-yourself warning and the daemon logs server-side.

// deliveryMode is how a skill pane's task reaches the agent.
type deliveryMode int

const (
	deliveryNone       deliveryMode = iota // no task
	deliveryPositional                     // claude: the task rides the launcher argv
	deliveryTyped                          // other launchers: typed post-boot
)

// taskDeliveryMode decides the delivery mode for a (launcher, task) pair at the
// composition seam. The gate is LauncherCommandName — deliberately naive about
// shell grammar (a launcher it cannot positively identify as claude gets typed
// delivery, the provider-agnostic path).
func taskDeliveryMode(launcher, task string) deliveryMode {
	if task == "" {
		return deliveryNone
	}
	if LauncherCommandName(launcher) == forkLauncherCommand {
		return deliveryPositional
	}
	return deliveryTyped
}

// specTask returns the spawn's task: pane 0's skill value ("" when pane 0 is
// not a skill pane or carries no value).
func specTask(spec EffectiveSpec) string {
	if len(spec.Panes) == 0 || spec.Panes[0].Kind != PaneKindSkill {
		return ""
	}
	return spec.Panes[0].Value
}

// deliveryServer resolves the tmux server label the delivery targets: the
// spec's own label on the daemon path; on the CLI path (empty label) the
// basename of the caller's $TMUX socket — the mux family's muxServer
// derivation, where "default" addresses the default server.
func deliveryServer(spec EffectiveSpec) string {
	if spec.Server != "" {
		return spec.Server
	}
	socket := spec.OriginalTMUX
	if i := strings.IndexByte(socket, ','); i >= 0 {
		socket = socket[:i]
	}
	if socket == "" {
		return "default"
	}
	return filepath.Base(socket)
}

// taskSendBuffer is the named buffer task deliveries paste through — distinct
// from the daemon's agent-send buffer and the mux-send per-invocation names.
const taskSendBuffer = "rk-riff-task"

// taskEngine serializes task deliveries process-wide: per-pane locks plus the
// set→paste critical section on the shared named buffer (the daemon serves
// concurrent spawns; the CLI fan-out delivers from per-window goroutines).
var taskEngine = inject.NewEngine(taskSendBuffer)

// riffInjectTmux is the engine's inject.Tmux substrate: the name-parameterized
// buffer primitives of internal/tmux, addressed by server label
// (deliveryServer). The cmd/rk mux family carries its own near-identical
// adapter; cmd packages cannot be imported from here.
type riffInjectTmux struct{}

func (riffInjectTmux) ClearPaneMode(ctx context.Context, paneID, server string) error {
	return tmux.ClearPaneModeCtx(ctx, paneID, server)
}
func (riffInjectTmux) CapturePane(ctx context.Context, paneID string, lines int, server string) (string, error) {
	return tmux.CapturePaneCtx(ctx, paneID, lines, server)
}
func (riffInjectTmux) SetBuffer(ctx context.Context, name, text, server string) error {
	return tmux.SetBufferCtx(ctx, name, text, server)
}
func (riffInjectTmux) PasteBuffer(ctx context.Context, name, paneID, server string) error {
	return tmux.PasteBufferCtx(ctx, name, paneID, server)
}
func (riffInjectTmux) PasteBufferRaw(ctx context.Context, name, paneID, server string) error {
	return tmux.PasteBufferRawCtx(ctx, name, paneID, server)
}
func (riffInjectTmux) SendEnter(ctx context.Context, paneID, server string) error {
	return tmux.SendEnterToPaneCtx(ctx, paneID, server)
}
func (riffInjectTmux) SendKeys(ctx context.Context, paneID, server string, keys ...string) error {
	return tmux.SendKeysToPane(ctx, paneID, server, keys...)
}
func (riffInjectTmux) PaneSize(ctx context.Context, paneID, server string) (int, int, error) {
	return tmux.PaneSizeCtx(ctx, paneID, server)
}

// deliverTaskFn is the delivery seam: production runs the spawn-then-deliver
// composite (readiness wait → engine send) with the reconciled state reader;
// tests substitute a recorder so the spawn paths run without a live tmux.
var deliverTaskFn = func(ctx context.Context, server, paneID, task string) error {
	_, err := inject.DeliverWhenReady(ctx, riffInjectTmux{}, server, paneID, inject.Sanitize(task), true, taskEngine, inject.ReadyOpts{
		State: tmux.PaneAgentState,
	})
	return err
}

// cliStderrFn supplies the CLI's degrade-warning writer (a seam so tests
// capture it).
var cliStderrFn = func() io.Writer { return os.Stderr }

// deliverCliTask runs the CLI path's synchronous typed delivery after a
// successful spawn. A failure warns (naming the window and carrying the
// sanitized task text — the user-controlled raw form could carry terminal
// escape sequences, and the sanitized form is what delivery would have pasted)
// and never propagates — no rollback, exit code still reflects the spawn.
// Positional/none modes are no-ops.
func deliverCliTask(ctx context.Context, spec EffectiveSpec, window, paneID string) {
	task := specTask(spec)
	if taskDeliveryMode(spec.Launcher, task) != deliveryTyped {
		return
	}
	if err := deliverTaskFn(ctx, deliveryServer(spec), paneID, task); err != nil {
		fmt.Fprintf(cliStderrFn(), "run-kit riff: could not deliver the task to window %q (%v) — paste this into the agent yourself:\n  %s\n", window, err, inject.Sanitize(task))
	}
}

// taskDeliveryBudget bounds a daemon-path delivery end to end (the readiness
// wait plus the send) so a wedged pane cannot pin a goroutine forever.
const taskDeliveryBudget = 40 * time.Second

// deliverTaskAsyncFn is the daemon-path delivery seam: production launches a
// background goroutine off context.Background() — never the request context,
// which cancels at response write — so the HTTP response never blocks on agent
// boot; a failure is logged with the server/window/pane identifiers. Tests
// substitute a synchronous recorder.
var deliverTaskAsyncFn = func(server, window, paneID, task string) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), taskDeliveryBudget)
		defer cancel()
		if err := deliverTaskFn(ctx, server, paneID, task); err != nil {
			log.Printf("run-kit riff: task delivery failed (server %q, window %q, pane %s): %v", server, window, paneID, err)
		}
	}()
}

// deliverDaemonTask kicks the daemon path's fire-and-forget typed delivery
// after a successful spawn. Positional/none modes are no-ops.
func deliverDaemonTask(spec EffectiveSpec, window, paneID string) {
	task := specTask(spec)
	if taskDeliveryMode(spec.Launcher, task) != deliveryTyped {
		return
	}
	deliverTaskAsyncFn(spec.Server, window, paneID, task)
}
