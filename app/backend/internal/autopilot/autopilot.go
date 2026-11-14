// Package autopilot is the operator's deterministic queue engine: the git, gh
// and wt choreography behind `rk operator autopilot`. It owns no state of its
// own. A queue is N `pane` tracked items chained by depends_on, a merge
// sequence is a chain of `github-pr` items, and every verb re-derives what to
// do from the operator state file, acts, and writes back under the store's
// lock. The lock is never held across a subprocess, and every write merges by
// item id, so an external writer's change between a load and a write survives.
//
// The engine never notifies: a failure or halt is an Escalation in the result
// plus a note on the item, and the caller turns it into a notification.
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

// Subprocess bounds by class (Constitution I). A fetch moves objects; the rest
// are local or single API calls.
const (
	gitFetchTimeout = 60 * time.Second
	gitTimeout      = 30 * time.Second
	ghTimeout       = 30 * time.Second
	wtTimeout       = 30 * time.Second
	fabTimeout      = 10 * time.Second
	defaultTimeout  = 30 * time.Second
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
		for _, a := range argv[1:] {
			if a == "fetch" {
				return gitFetchTimeout
			}
		}
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
// pane's derived fab change, and typed delivery into a pane.
type Panes interface {
	Snapshot(ctx context.Context) (map[string]operator.PaneInfo, error)
	Send(ctx context.Context, paneID, text string) error
}

// ErrPaneBusy is returned by Panes.Send when the pane's agent is working and a
// send would interrupt it; the caller defers to the next step.
var ErrPaneBusy = errors.New("pane agent is busy")

// SpawnRequest is one agent window: a worktree of Repo, prepared, then a tab.
type SpawnRequest struct {
	Repo         string
	Session      string
	WorktreeName string
	// BaseSHA pins the new branch's start point (never a ref: a
	// remote-tracking start point sets upstream tracking). NewBranch names it
	// when it differs from the worktree name.
	BaseSHA   string
	NewBranch string
	// CheckoutBranch puts the worktree on an existing branch (respawn,
	// recovery). ExistingWorktree opens the window in a worktree that already
	// holds the branch instead, since git refuses a second checkout.
	CheckoutBranch   string
	ExistingWorktree string
	// Prompt is the canonical `/skill args` form or plain text; "" is a bare
	// agent. Prepare runs in the new worktree before any window opens, and an
	// error rolls the worktree back.
	Prompt  string
	Prepare func(ctx context.Context, worktree string) error
	// Note marks the window: `@rk_win_marker` auto plus this note.
	Note string
}

// SpawnResult identifies the opened window.
type SpawnResult struct {
	PaneID       string
	Session      string
	WindowID     string
	WorktreePath string
	Branch       string
}

// Spawner opens agent windows and bare worktrees. The production
// implementation is RiffSpawner over internal/riff.
type Spawner interface {
	Spawn(ctx context.Context, req SpawnRequest) (SpawnResult, error)
	// Worktree returns a checkout of an existing branch and a cleanup to call
	// when done (a no-op when the branch already had a worktree).
	Worktree(ctx context.Context, repo, branch string) (path string, cleanup func(), err error)
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
	// By is the note author: operator.ByRun or operator.ByChat.
	By     string
	DryRun bool
	Now    func() time.Time
}

func (e Env) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}

func (e Env) by() string {
	if e.By == "" {
		return operator.ByRun
	}
	return e.By
}

// Action kinds reported by the verbs.
const (
	ActSpawned       = "spawned"
	ActRespawned     = "respawned"
	ActCherryPicked  = "cherry-picked"
	ActArmed         = "armed"
	ActMerged        = "merged"
	ActRetargeted    = "retargeted"
	ActRebased       = "rebased"
	ActDisarmed      = "disarmed"
	ActRecoverySent  = "recovery-sent"
	ActRecoverySpawn = "recovery-spawned"
	ActPaused        = "paused"
	ActQueued        = "queued"
	ActDone          = "done"
	ActPRTracked     = "pr-tracked"
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
	DryRun      bool         `json:"dry_run,omitempty"`
	Actions     []Action     `json:"actions"`
	Escalations []Escalation `json:"escalations"`
	// Report carries the per-merge lines (`ab12: merged (foo 1/2)`) and the
	// unreviewed summary.
	Report []string `json:"report"`
}

func newResult(dry bool) *StepResult {
	return &StepResult{DryRun: dry, Actions: []Action{}, Escalations: []Escalation{}, Report: []string{}}
}

// engine is one verb's working context.
type engine struct {
	env  Env
	res  *StepResult
	meta map[string]*repoMeta
}

func newEngine(env Env) *engine {
	return &engine{env: env, res: newResult(env.DryRun), meta: map[string]*repoMeta{}}
}

func (e *engine) act(kind, item, detail string) {
	e.res.Actions = append(e.res.Actions, Action{Kind: kind, Item: item, Detail: detail})
}

func (e *engine) reportf(format string, a ...interface{}) {
	e.res.Report = append(e.res.Report, fmt.Sprintf(format, a...))
}

// escalate records an escalation and, once per distinct text, a note on the
// item, so a retried step does not repeat itself in the ledger.
func (e *engine) escalate(id, reason string) {
	e.res.Escalations = append(e.res.Escalations, Escalation{Item: id, Reason: reason})
	_ = e.note(id, "escalated: "+reason)
}

func (e *engine) load() (*operator.State, error) { return operator.Load(e.env.StatePath) }

// mutate applies fn under the store's lock. The lock covers only fn, which is
// pure in-memory work.
func (e *engine) mutate(fn func(*operator.State) error) error {
	if e.env.DryRun {
		return nil
	}
	return operator.Mutate(e.env.StatePath, fn)
}

// patch applies fn to the item with id, re-read under the lock. An item
// removed since the load is skipped: external writes win.
func (e *engine) patch(id string, fn func(*operator.TrackedItem)) error {
	return e.mutate(func(st *operator.State) error {
		i := operator.IndexOf(st.Tracked, id)
		if i < 0 {
			return operator.ErrNoWrite
		}
		fn(&st.Tracked[i])
		st.Tracked[i].UpdatedAt = operator.NowRFC3339()
		return nil
	})
}

// setScope merges keys into the item's scope; a nil value stores null.
func (e *engine) setScope(id string, kv map[string]interface{}) error {
	return e.patch(id, func(it *operator.TrackedItem) {
		if it.Scope == nil {
			it.Scope = map[string]interface{}{}
		}
		for k, v := range kv {
			it.Scope[k] = v
		}
	})
}

// note appends a note unless the item's latest note already says the same.
func (e *engine) note(id, text string) error {
	if len(text) > operator.NoteTextCap {
		text = text[:operator.NoteTextCap]
	}
	by := e.env.by()
	return e.mutate(func(st *operator.State) error {
		i := operator.IndexOf(st.Tracked, id)
		if i < 0 {
			return operator.ErrNoWrite
		}
		it := &st.Tracked[i]
		if n := len(it.Notes); n > 0 && it.Notes[n-1].Text == text {
			return operator.ErrNoWrite
		}
		return operator.AppendNote(it, by, text)
	})
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
	if errors.As(err, &ee) {
		return strings.TrimSpace(ee.Stderr)
	}
	if err != nil {
		return err.Error()
	}
	return ""
}

// nowUnix is the window-note clock.
func nowUnix() int64 { return time.Now().Unix() }
