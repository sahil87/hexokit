// Package autopilot is the operator's deterministic queue engine: the git, gh
// and wt choreography behind `rk operator autopilot`. Durable intent lives in
// the per-server engine file; the tracked ledger carries projections and check
// facts only. Every lock-holding verb runs under one pass lock and writes the
// engine file atomically before returning.
//
// A pass is observe → derive → decide → execute. Observe reads engine state,
// projections, and external facts; derive computes a status per item; decide
// picks at most one rule-table action per item; executors apply those actions
// in engine order. Statuses are derived each pass rather than stored. PR
// readying, arming, merging and recovery are the operator run's work, not the
// engine's.
//
// Escalations are reported in the result, written as by: run notes on ledger
// projections, and sent through Env.Notify once per engine-file dedupe key.
package autopilot

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"rk/internal/operator"
)

// Subprocess bounds by class (Constitution I): the engine's calls are local or
// single API calls; wt does the fetching.
const (
	gitTimeout     = 30 * time.Second
	ghTimeout      = 30 * time.Second
	wtTimeout      = 30 * time.Second
	fabTimeout     = 10 * time.Second
	defaultTimeout = 30 * time.Second
)

// Runner executes one argv in dir and returns stdout. A non-zero exit is an
// *ExecError, and stdout is still returned: `gh pr checks` reports failing
// checks through its exit status while printing the JSON.
type Runner interface {
	Run(ctx context.Context, dir string, argv ...string) (string, error)
}

// ExecError is a failed subprocess: a start failure, a timeout or a non-zero
// exit. Stderr is the process's own message.
type ExecError struct {
	Argv   []string
	Dir    string
	Stderr string
	Err    error
}

func (e *ExecError) Error() string {
	msg := strings.TrimSpace(e.Stderr)
	if msg == "" {
		msg = e.Err.Error()
	}
	return fmt.Sprintf("%s: %s", strings.Join(e.Argv, " "), msg)
}

func (e *ExecError) Unwrap() error { return e.Err }

// ExecRunner is the production Runner: argv-slice exec.CommandContext with a
// per-class timeout, never a shell string.
type ExecRunner struct{}

// Run implements Runner.
func (ExecRunner) Run(ctx context.Context, dir string, argv ...string) (string, error) {
	if len(argv) == 0 {
		return "", errors.New("autopilot: empty argv")
	}
	ctx, cancel := context.WithTimeout(ctx, timeoutFor(argv))
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = dir
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return stdout.String(), &ExecError{Argv: argv, Dir: dir, Stderr: stderr.String(), Err: err}
	}
	return stdout.String(), nil
}

func timeoutFor(argv []string) time.Duration {
	switch argv[0] {
	case "git":
		return gitTimeout
	case "gh":
		return ghTimeout
	case "wt":
		return wtTimeout
	case "fab":
		return fabTimeout
	}
	return defaultTimeout
}

// Panes is the engine's view of the tmux server: the pane snapshot with each
// pane's derived fab change, and a pane's process id.
type Panes interface {
	Snapshot(ctx context.Context) (map[string]operator.PaneInfo, error)
	PID(ctx context.Context, paneID string) (int, error)
}

// SpawnRequest is one agent window: a worktree of Repo, prepared, then a tab.
type SpawnRequest struct {
	Repo    string
	Session string
	// EnsureSession asks the spawner to create Session when it is absent and
	// join it when present; unset, Session is a landing session that already
	// exists.
	EnsureSession bool
	WorktreeName  string
	// BaseRef is the new branch's start point, `origin/<base>`: the spawner has
	// wt fetch and resolve it, and the SHA wt pinned comes back as
	// SpawnResult.BaseSHA. wt sets upstream tracking on a branch cut from a
	// remote-tracking ref, so the spawner suppresses it — fab's /git-pr pushes
	// a branch without an upstream with `push -u origin <branch>`, where a
	// tracking branch would take a bare `git push` to its base. NewBranch names
	// the branch when it differs from the worktree name.
	BaseRef   string
	NewBranch string
	// CheckoutBranch puts the worktree on an existing branch (respawn).
	// ExistingWorktree opens the window in a worktree that already holds the
	// branch instead, since git refuses a second checkout.
	CheckoutBranch   string
	ExistingWorktree string
	// Prompt is the canonical `/skill args` form or plain text; "" is a bare
	// agent. Prepare runs in the new worktree before any window opens, and an
	// error rolls the worktree back.
	Prompt  string
	Prepare func(ctx context.Context, worktree string) error
	// Note marks the window: `@rk_win_marker` auto plus this note.
	Note string
	// Opened persists the pane before any further spawn work.
	Opened func(SpawnResult) error
}

// SpawnResult identifies the opened window.
type SpawnResult struct {
	PaneID       string
	Session      string
	WindowID     string
	WorktreePath string
	Branch       string
	// BaseSHA is the commit wt cut the new branch from, as its receipt states
	// it ("" for a respawn, which cuts nothing).
	BaseSHA string
}

// Spawner opens agent windows. The production implementation is RiffSpawner
// over internal/riff.
type Spawner interface {
	Spawn(ctx context.Context, req SpawnRequest) (SpawnResult, error)
}

// Env is everything a verb needs. Run, Spawn, Panes and Session are seams;
// tests inject fakes, and cmd/rk wires the production ones.
type Env struct {
	Server    string
	StatePath string
	Run       Runner
	Spawn     Spawner
	Panes     Panes
	// Session resolves the tmux session a repo's windows land in (the
	// role-aware default `rk tab new` uses).
	Session func(ctx context.Context, repo string) (string, error)
	DryRun  bool
	Now     func() time.Time
	// Notify delivers an escalation best-effort. Nil disables push delivery.
	Notify func(ctx context.Context, title, body string)
}

func (e Env) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}

// Action kinds reported by the verbs.
const (
	ActSpawned      = "spawned"
	ActRespawned    = "respawned"
	ActCherryPicked = "cherry-picked"
	ActPaused       = "paused"
	ActDone         = "done"
	ActPRTracked    = "pr-tracked"
	ActRemoved      = "removed"
	ActResumed      = "resumed"
)

// Action is one thing a verb did (or, under --dry-run, would do).
type Action struct {
	Kind   string `json:"kind"`
	Item   string `json:"item"`
	Detail string `json:"detail,omitempty"`
}

// Escalation is a structured line the caller turns into a notification.
type Escalation struct {
	Item   string `json:"item"`
	Reason string `json:"reason"`
}

// StepResult is what one verb pass did.
type StepResult struct {
	DryRun bool `json:"dry_run,omitempty"`
	// Busy: another pass holds the server's pass lock, so this call did
	// nothing.
	Busy        bool         `json:"busy,omitempty"`
	Actions     []Action     `json:"actions"`
	Escalations []Escalation `json:"escalations"`
}

func newResult(dry bool) *StepResult {
	return &StepResult{DryRun: dry, Actions: []Action{}, Escalations: []Escalation{}}
}

// engine is one verb's working context.
type engine struct {
	env  Env
	res  *StepResult
	meta map[string]*repoMeta
	// readOnly is the status view: failures are collected in warnings, never
	// reported as escalations and never written as notes.
	readOnly bool
	warnings []string
}

func newEngine(env Env) *engine {
	return &engine{env: env, res: newResult(env.DryRun), meta: map[string]*repoMeta{}}
}

func (e *engine) act(kind, item, detail string) {
	e.res.Actions = append(e.res.Actions, Action{Kind: kind, Item: item, Detail: detail})
}

// escalate records an escalation and, once per distinct reason, a note on the
// item, so a retried step does not repeat itself in the ledger.
func (e *engine) escalate(id, reason string) { e.escalateAs(id, escalationKey(reason), reason) }

// escalateAs is escalate with an explicit dedupe key supplied by the row.
func (e *engine) escalateAs(id, key, reason string) {
	if e.readOnly {
		e.warnings = append(e.warnings, id+": "+reason)
		return
	}
	e.res.Escalations = append(e.res.Escalations, Escalation{Item: id, Reason: reason})
	if err := e.recordEscalation(id, key, reason, ""); err != nil {
		e.res.Escalations = append(e.res.Escalations, Escalation{Item: id, Reason: "escalation note not written: " + err.Error()})
	}
}

// patch applies fn to the item with id, re-read under the lock. An item
// removed since the load is an error: no advancing action may be acknowledged.
func (e *engine) patch(id string, fn func(*operator.TrackedItem)) error {
	return e.mutateEngine(func(st *engineState) error {
		item, ok := st.find(id)
		if !ok {
			return fmt.Errorf("item %s is no longer tracked", id)
		}
		it := item.tracked()
		fn(&it)
		it.UpdatedAt = operator.NowRFC3339()
		applyEngineItem(item, it, item.Projected)
		return nil
	})
}

// escalatedSeen reports whether the item's structured escalation record already
// holds key. Decisions read this map, never note text.
func escalatedSeen(it operator.TrackedItem, key string) bool {
	seen, _ := it.Scope[scopeEscalated].(map[string]interface{})
	_, ok := seen[key]
	return ok
}

// escalationKey bounds a reason to the note cap so the record and the note
// carry the same text.
func escalationKey(reason string) string {
	if r := []rune(reason); len(r) > operator.NoteTextCap {
		return string(r[:operator.NoteTextCap])
	}
	return reason
}

// recordEscalation stores the engine-file dedupe key first. Only that first
// sighting writes a run note and sends a notification; a missing projection
// after a successful earlier projection is deliberately not recreated.
func (e *engine) recordEscalation(id, key, reason, fp string) error {
	if id == "" {
		e.notifyEscalation(id, reason)
		return nil
	}
	if fp != "" {
		st, err := e.load(id)
		if err != nil {
			return err
		}
		i := operator.IndexOf(st.Tracked, id)
		if i < 0 || fingerprint(st.Tracked[i]) != fp {
			return errItemChanged
		}
	}
	first := false
	var tracked operator.TrackedItem
	if err := e.mutateEngine(func(st *engineState) error {
		item, ok := st.find(id)
		if !ok {
			return fmt.Errorf("item %s is no longer in the engine state", id)
		}
		tracked = item.tracked()
		if escalatedSeen(tracked, key) {
			return nil
		}
		if item.Escalated == nil {
			item.Escalated = map[string]interface{}{}
		}
		item.Escalated[key] = operator.NowRFC3339()
		first = true
		return nil
	}); err != nil {
		return err
	}
	if !first {
		return nil
	}
	var noteErr error
	_, present, err := e.projection(id)
	if err != nil {
		noteErr = err
	} else if !present && scopeBool(tracked, scopeProjected) {
		// A user removed the projection: notify only and keep managing the engine item.
	} else {
		if !present {
			noteErr = e.upsertProjection(tracked)
		}
		if noteErr == nil {
			noteErr = operator.AddNote(e.env.StatePath, id, operator.ByRun, escalationKey("escalated: "+reason))
		}
	}
	e.notifyEscalation(id, reason)
	return noteErr
}

func (e *engine) notifyEscalation(id, reason string) {
	if e.env.Notify == nil || e.env.DryRun {
		return
	}
	title := id
	if title == "" {
		title = "autopilot"
	}
	e.env.Notify(context.Background(), title, reason)
}

func (e *engine) run(ctx context.Context, dir string, argv ...string) (string, error) {
	return e.env.Run.Run(ctx, dir, argv...)
}

func (e *engine) git(ctx context.Context, dir string, args ...string) (string, error) {
	out, err := e.run(ctx, dir, append([]string{"git"}, args...)...)
	return strings.TrimSpace(out), err
}

func (e *engine) gh(ctx context.Context, dir string, args ...string) (string, error) {
	return e.run(ctx, dir, append([]string{"gh"}, args...)...)
}

// stderrOf returns the process's own message for an error ("" when none).
func stderrOf(err error) string {
	var ee *ExecError
	if errors.As(err, &ee) && strings.TrimSpace(ee.Stderr) != "" {
		return strings.TrimSpace(ee.Stderr)
	}
	if err != nil {
		return err.Error()
	}
	return ""
}

// errItemChanged marks a write refused because the item no longer carries what
// the pass observed: external writes win.
var errItemChanged = errors.New("item changed externally")

// nowUnix is the window-note clock.
func nowUnix() int64 { return time.Now().Unix() }
