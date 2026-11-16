// Package autopilot is the operator's deterministic queue engine: the git, gh
// and wt choreography behind `rk operator autopilot`. It owns no state of its
// own. A queue is N `pane` tracked items chained by depends_on, a merge
// sequence is a chain of `github-pr` items, and every verb re-derives what to
// do from the operator state file, acts, and writes back under the store's
// lock. The lock is never held across a subprocess, and every write merges by
// item id, so an external writer's change between a load and a write survives.
//
// step, merge and stop are single-writer: each takes the server's pass lock
// for the whole pass and returns busy when another pass holds it, so no
// engine state needs a claim or a compare-and-set.
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
// pane's derived fab change, and a pane's process id.
type Panes interface {
	Snapshot(ctx context.Context) (map[string]operator.PaneInfo, error)
	PID(ctx context.Context, paneID string) (int, error)
}

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
	ActSpawned      = "spawned"
	ActRespawned    = "respawned"
	ActCherryPicked = "cherry-picked"
	ActArmed        = "armed"
	ActMerged       = "merged"
	ActDisarmed     = "disarmed"
	ActPaused       = "paused"
	ActDone         = "done"
	ActPRTracked    = "pr-tracked"
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
	// Report carries the per-merge lines (`ab12: merged (foo 1/2)`) and the
	// unreviewed summary.
	Report []string `json:"report"`
	// Human output caps this list independently of the per-merge report.
	Unreviewed []string `json:"-"`
}

func newResult(dry bool) *StepResult {
	return &StepResult{DryRun: dry, Actions: []Action{}, Escalations: []Escalation{}, Report: []string{}}
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

func (e *engine) reportf(format string, a ...interface{}) {
	e.res.Report = append(e.res.Report, fmt.Sprintf(format, a...))
}

// escalate records an escalation and, once per distinct reason, a note on the
// item, so a retried step does not repeat itself in the ledger.
func (e *engine) escalate(id, reason string) {
	if e.readOnly {
		e.warnings = append(e.warnings, id+": "+reason)
		return
	}
	e.res.Escalations = append(e.res.Escalations, Escalation{Item: id, Reason: reason})
	if id != "" {
		if err := e.recordEscalation(id, reason); err != nil {
			e.res.Escalations = append(e.res.Escalations, Escalation{Item: id, Reason: "escalation note not written: " + err.Error()})
		}
	}
}

func (e *engine) load(ids ...string) (*operator.State, error) {
	st, err := operator.Load(e.env.StatePath)
	if err != nil {
		id := ""
		if len(ids) > 0 {
			id = ids[0]
		}
		e.escalate(id, "state load failed: "+err.Error())
	}
	return st, err
}

// mutate applies fn under the store's lock. The lock covers only fn, which is
// pure in-memory work.
func (e *engine) mutate(fn func(*operator.State) error) error {
	if e.env.DryRun {
		return nil
	}
	return operator.Mutate(e.env.StatePath, fn)
}

// patch applies fn to the item with id, re-read under the lock. An item
// removed since the load is an error: no advancing action may be acknowledged.
func (e *engine) patch(id string, fn func(*operator.TrackedItem)) error {
	return e.mutate(func(st *operator.State) error {
		i := operator.IndexOf(st.Tracked, id)
		if i < 0 {
			return fmt.Errorf("item %s is no longer tracked", id)
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

// escalatedSeen reports whether the item's structured escalation record already
// holds reason. Decisions read this map, never note text.
func escalatedSeen(it operator.TrackedItem, reason string) bool {
	seen, _ := it.Scope[scopeEscalated].(map[string]interface{})
	_, ok := seen[escalationKey(reason)]
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

// recordEscalation stores the reason's first-seen time in scope.escalated and,
// on that first sighting only, appends a human note.
func (e *engine) recordEscalation(id, reason string) error {
	key := escalationKey(reason)
	by := e.env.by()
	return e.mutate(func(st *operator.State) error {
		i := operator.IndexOf(st.Tracked, id)
		if i < 0 {
			return operator.ErrNoWrite
		}
		it := &st.Tracked[i]
		if escalatedSeen(*it, reason) {
			return operator.ErrNoWrite
		}
		seen := map[string]interface{}{}
		if cur, ok := it.Scope[scopeEscalated].(map[string]interface{}); ok {
			for k, v := range cur {
				seen[k] = v
			}
		}
		seen[key] = operator.NowRFC3339()
		if it.Scope == nil {
			it.Scope = map[string]interface{}{}
		}
		it.Scope[scopeEscalated] = seen
		return operator.AppendNote(it, by, escalationKey("escalated: "+reason))
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
	if errors.As(err, &ee) && strings.TrimSpace(ee.Stderr) != "" {
		return strings.TrimSpace(ee.Stderr)
	}
	if err != nil {
		return err.Error()
	}
	return ""
}

// nowUnix is the window-note clock.
func nowUnix() int64 { return time.Now().Unix() }
