package autopilot

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"rk/internal/operator"
	"rk/internal/riff"
)

// ---- real git ---------------------------------------------------------------

func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func gitOK(dir string, args ...string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), gitTimeout)
	defer cancel()
	return exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...).Run() == nil
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func commitFile(t *testing.T, dir, file, content, msg string) string {
	t.Helper()
	write(t, filepath.Join(dir, file), content)
	runGit(t, dir, "add", file)
	runGit(t, dir, "commit", "-m", msg)
	return runGit(t, dir, "rev-parse", "HEAD")
}

// testRepo is a clone of a bare origin, both on `main`, with one commit.
type testRepo struct {
	Dir    string
	Origin string
	t      *testing.T
}

func newRepo(t *testing.T, name string) *testRepo {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	origin := filepath.Join(root, name+"-origin.git")
	dir := filepath.Join(root, name)
	runGit(t, root, "init", "--bare", "-b", "main", origin)
	runGit(t, root, "clone", origin, dir)
	runGit(t, dir, "checkout", "-b", "main")
	commitFile(t, dir, "shared.txt", "base\n", "initial")
	runGit(t, dir, "push", "-u", "origin", "main")
	return &testRepo{Dir: dir, Origin: origin, t: t}
}

// advanceOrigin commits a file on origin/main through a second clone, so the
// main checkout's local HEAD lags the remote.
func (r *testRepo) advanceOrigin(file, content string) string {
	r.t.Helper()
	other := filepath.Join(r.t.TempDir(), "other")
	runGit(r.t, filepath.Dir(other), "clone", r.Origin, other)
	sha := commitFile(r.t, other, file, content, "advance "+file)
	runGit(r.t, other, "push", "origin", "main")
	return sha
}

// branch creates a local branch at `from` with one commit and returns its tip.
func (r *testRepo) branch(name, from, file, content string) string {
	r.t.Helper()
	runGit(r.t, r.Dir, "branch", name, from)
	wt := filepath.Join(r.t.TempDir(), "bw")
	runGit(r.t, r.Dir, "worktree", "add", wt, name)
	sha := commitFile(r.t, wt, file, content, "work on "+name)
	runGit(r.t, r.Dir, "worktree", "remove", "--force", wt)
	return sha
}

func (r *testRepo) pushBranch(name string) { runGit(r.t, r.Dir, "push", "origin", name) }

// ---- scripted runner ----------------------------------------------------------

// scriptRunner runs git for real and routes gh, fab and wt to scripted
// handlers. Every call is recorded.
type scriptRunner struct {
	mu       sync.Mutex
	calls    []string
	handlers []handler
	onRun    func(argv []string)
}

type handler struct {
	prefix string
	fn     func(dir string, argv []string) (string, error)
}

func (s *scriptRunner) on(prefix string, fn func(dir string, argv []string) (string, error)) {
	s.handlers = append([]handler{{prefix, fn}}, s.handlers...)
}

func (s *scriptRunner) reply(prefix, out string) {
	s.on(prefix, func(string, []string) (string, error) { return out, nil })
}

func (s *scriptRunner) fail(prefix, stderr string) {
	s.on(prefix, func(_ string, argv []string) (string, error) {
		return "", &ExecError{Argv: argv, Stderr: stderr, Err: fmt.Errorf("exit status 1")}
	})
}

func (s *scriptRunner) Run(ctx context.Context, dir string, argv ...string) (string, error) {
	line := strings.Join(argv, " ")
	s.mu.Lock()
	s.calls = append(s.calls, line)
	hook := s.onRun
	s.mu.Unlock()
	if hook != nil {
		hook(argv)
	}
	if argv[0] == "git" {
		return ExecRunner{}.Run(ctx, dir, argv...)
	}
	for _, h := range s.handlers {
		if strings.HasPrefix(line, h.prefix) {
			return h.fn(dir, argv)
		}
	}
	return "", &ExecError{Argv: argv, Stderr: "no scripted handler for " + line, Err: fmt.Errorf("exit status 127")}
}

func (s *scriptRunner) called(prefix string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, c := range s.calls {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

func (s *scriptRunner) reset() {
	s.mu.Lock()
	s.calls = nil
	s.mu.Unlock()
}

// ---- gh simulator -------------------------------------------------------------

type simPR struct {
	Number int
	Branch string
	URL    string
	State  string
	Checks []checkRun
}

type ghSim struct {
	t   *testing.T
	prs map[int]*simPR
	run *scriptRunner
}

func newGHSim(t *testing.T, run *scriptRunner) *ghSim {
	g := &ghSim{t: t, prs: map[int]*simPR{}, run: run}
	run.on("gh ", g.handle)
	return g
}

func (g *ghSim) add(number int, branch string) *simPR {
	pr := &simPR{Number: number, Branch: branch, URL: fmt.Sprintf("https://example.test/pull/%d", number), State: "OPEN"}
	g.prs[number] = pr
	return pr
}

func (g *ghSim) find(ref string) *simPR {
	for _, p := range g.prs {
		if fmt.Sprint(p.Number) == ref || p.Branch == ref {
			return p
		}
	}
	return nil
}

func ghErr(argv []string, msg string) error {
	return &ExecError{Argv: argv, Stderr: msg, Err: fmt.Errorf("exit status 1")}
}

func (g *ghSim) handle(dir string, argv []string) (string, error) {
	args := argv[1:]
	switch {
	case len(args) >= 2 && args[0] == "repo" && args[1] == "view":
		return "main\n", nil
	case len(args) >= 3 && args[0] == "pr" && args[1] == "view":
		p := g.find(args[2])
		if p == nil {
			return "", ghErr(argv, "no pull requests found for "+args[2])
		}
		b, _ := json.Marshal(map[string]interface{}{"url": p.URL, "state": p.State})
		return string(b), nil
	case len(args) >= 3 && args[0] == "pr" && args[1] == "checks":
		p := g.find(args[2])
		if p == nil {
			return "", ghErr(argv, "no pull requests found")
		}
		if len(p.Checks) == 0 {
			return "", ghErr(argv, "no required checks reported on the 'x' branch")
		}
		b, _ := json.Marshal(p.Checks)
		for _, c := range p.Checks {
			if c.State != "SUCCESS" {
				return string(b), ghErr(argv, "")
			}
		}
		return string(b), nil
	}
	return "", ghErr(argv, "unscripted gh call")
}

// ---- fakes --------------------------------------------------------------------

type fakePanes struct {
	mu    sync.Mutex
	panes map[string]operator.PaneInfo
}

func (f *fakePanes) Snapshot(ctx context.Context) (map[string]operator.PaneInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]operator.PaneInfo{}
	for k, v := range f.panes {
		out[k] = v
	}
	return out, nil
}

// gitTry runs git without failing the test, for the fake's wt-modelled steps
// whose failure is an outcome (a failed fetch, an unresolvable base).
func gitTry(dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// fakeSpawner stands in for RiffSpawner and the wt it drives: for a new
// worktree it does what `wt create --base <ref> --fetch` does (fetch origin,
// resolve the ref to a SHA, add a worktree on a new branch cut from it, no
// upstream) and reports the receipt's branch and base SHA; a failed fetch or
// an unresolvable base fails as wt's exit 3 / exit 2 do. The git calls are the
// fake's own, not the engine runner's, so argv assertions on the runner see
// only what the engine itself ran. The engine's Prepare hook runs the way riff
// runs it: a failed hook deletes the worktree.
type fakeSpawner struct {
	t        *testing.T
	root     string
	reqs     []SpawnRequest
	n        int
	failWith error
	// initFails makes wt's init script fail after the worktree exists (exit 7):
	// the worktree is kept and no window opens.
	initFails bool
	during    func()
}

func newFakeSpawner(t *testing.T) *fakeSpawner {
	return &fakeSpawner{t: t, root: t.TempDir()}
}

func (f *fakeSpawner) Spawn(ctx context.Context, req SpawnRequest) (SpawnResult, error) {
	f.reqs = append(f.reqs, req)
	f.n++
	if f.failWith != nil {
		return SpawnResult{}, f.failWith
	}
	if f.during != nil {
		f.during()
	}
	path := req.ExistingWorktree
	branch, baseSHA := req.CheckoutBranch, ""
	if path == "" {
		path = filepath.Join(f.root, fmt.Sprintf("%s-%d", req.WorktreeName, f.n))
		switch {
		case req.CheckoutBranch != "":
			runGit(f.t, req.Repo, "worktree", "add", path, req.CheckoutBranch)
		default:
			if req.BaseRef == "" {
				f.t.Fatalf("a new worktree needs a BaseRef: %+v", req)
			}
			if out, err := gitTry(req.Repo, "fetch", "origin"); err != nil {
				return SpawnResult{}, &riff.WtCreateError{Code: 3, Message: "Failed to fetch remote 'origin': " + out}
			}
			sha, err := gitTry(req.Repo, "rev-parse", "--verify", "-q", req.BaseRef+"^{commit}")
			if err != nil {
				return SpawnResult{}, &riff.WtCreateError{Code: 2, Message: "Invalid --base ref: " + req.BaseRef}
			}
			baseSHA = sha
			branch = req.WorktreeName
			if req.NewBranch != "" {
				branch = req.NewBranch
			}
			runGit(f.t, req.Repo, "-c", "branch.autoSetupMerge=false", "worktree", "add", "-b", branch, path, req.BaseRef)
			if f.initFails {
				return SpawnResult{}, &riff.WtCreateError{
					Code: 7, Message: "init script exited with status 1",
					Kept: &riff.KeptWorktree{Path: path, Name: filepath.Base(path), Init: "failed"},
				}
			}
		}
		if req.Prepare != nil {
			if err := req.Prepare(ctx, path); err != nil {
				runGit(f.t, req.Repo, "worktree", "remove", "--force", path)
				return SpawnResult{}, err
			}
		}
	}
	branch, err := openedBranch(ctx, ExecRunner{}, req, riff.OpenedWindow{WorktreePath: path, Branch: branch})
	if err != nil {
		f.t.Fatalf("branch of %s: %v", path, err)
	}
	res := SpawnResult{PaneID: fmt.Sprintf("%%%d", 100+f.n), Session: req.Session, WorktreePath: path, Branch: branch, BaseSHA: baseSHA}
	if req.Opened != nil {
		if err := req.Opened(res); err != nil {
			return res, err
		}
	}
	return res, nil
}

// ---- environment -----------------------------------------------------------

type harness struct {
	t     *testing.T
	env   Env
	run   *scriptRunner
	gh    *ghSim
	panes *fakePanes
	spawn *fakeSpawner
	clock time.Time
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	prev := resolveAgentFn
	resolveAgentFn = func(context.Context, string, string) riff.ResolvedAgent {
		return riff.ResolvedAgent{Launcher: "claude", SkillPrefix: "/"}
	}
	t.Cleanup(func() { resolveAgentFn = prev })

	run := &scriptRunner{}
	h := &harness{t: t, run: run, panes: &fakePanes{panes: map[string]operator.PaneInfo{}}, spawn: newFakeSpawner(t), clock: time.Now()}
	h.gh = newGHSim(t, run)
	run.on("fab resolve --folder", func(_ string, argv []string) (string, error) {
		return "260101-" + argv[3] + "-folder\n", nil
	})
	run.reply("fab status set-base-branch", "")
	run.reply("fab change switch", "")
	h.env = Env{
		// A server label no tmux server answers to: the pane-pid lookup fails
		// soft instead of touching a live server.
		Server:    "autopilot-test-none",
		StatePath: filepath.Join(t.TempDir(), "operator", "state.yaml"),
		Run:       run, Spawn: h.spawn, Panes: h.panes,
		Session: func(context.Context, string) (string, error) { return "work", nil },
		Now:     func() time.Time { return h.clock },
	}
	return h
}

func (h *harness) state() *operator.State {
	h.t.Helper()
	st, _, err := engineView(h.env.StatePath)
	if err != nil {
		h.t.Fatal(err)
	}
	return st
}

func (h *harness) item(id string) operator.TrackedItem {
	h.t.Helper()
	st := h.state()
	i := operator.IndexOf(st.Tracked, id)
	if i < 0 {
		h.t.Fatalf("no item %s in %v", id, ids(st.Tracked))
	}
	return st.Tracked[i]
}

func (h *harness) has(id string) bool {
	return operator.IndexOf(h.state().Tracked, id) >= 0
}

func ids(items []operator.TrackedItem) []string {
	var out []string
	for _, it := range items {
		out = append(out, it.ID)
	}
	return out
}

func (h *harness) queue(mode string, entries ...Entry) QueueReceipt {
	h.t.Helper()
	rec, err := enqueue(context.Background(), h.env, entries, QueueOptions{Mode: mode}, "", false)
	if err != nil {
		h.t.Fatalf("Enqueue: %v", err)
	}
	return rec
}

func (h *harness) step() *StepResult {
	h.t.Helper()
	res, err := Step(context.Background(), h.env)
	if err != nil {
		h.t.Fatalf("Step: %v", err)
	}
	return res
}

// livePanes puts every pane an engine item recorded into the pane snapshot, as
// a running agent would be.
func (h *harness) livePanes() {
	h.t.Helper()
	for _, it := range h.state().Tracked {
		if pane := operator.ScopeString(it.Scope, "pane"); pane != "" {
			h.panes.panes[pane] = operator.PaneInfo{PaneID: pane}
		}
	}
}

// setDone marks an item done with the evidence a finished pane leaves.
func (h *harness) setDone(id string) {
	h.t.Helper()
	e := newEngine(h.env)
	now := time.Now().UTC().Format(time.RFC3339)
	if err := e.patch(id, func(it *operator.TrackedItem) { it.DoneAt = &now }); err != nil {
		h.t.Fatal(err)
	}
}

// attachBranch records a spawned item's branch and a pane, as a spawn does.
func (h *harness) attachBranch(id, branch string) {
	h.t.Helper()
	h.panes.panes["%900"] = operator.PaneInfo{PaneID: "%900"}
	e := newEngine(h.env)
	if err := e.patch(id, func(it *operator.TrackedItem) {
		it.Scope["branch"] = branch
		it.Scope["pane"] = "%900"
	}); err != nil {
		h.t.Fatal(err)
	}
	if err := e.upsertProjection(h.item(id)); err != nil {
		h.t.Fatal(err)
	}
}

func hasEscalation(res *StepResult, substr string) bool {
	for _, e := range res.Escalations {
		if strings.Contains(e.Reason, substr) {
			return true
		}
	}
	return false
}

func hasAction(res *StepResult, kind, item string) bool {
	for _, a := range res.Actions {
		if a.Kind == kind && (item == "" || a.Item == item) {
			return true
		}
	}
	return false
}

// shipped marks the named queue items done with a branch `<name>-branch` and an
// open PR numbered from first, and returns the PRs in order.
func (h *harness) shipped(first int, names ...string) []*simPR {
	h.t.Helper()
	var prs []*simPR
	for i, n := range names {
		h.setDone(n)
		h.attachBranch(n, n+"-branch")
		prs = append(prs, h.gh.add(first+i, n+"-branch"))
	}
	return prs
}

func (f *fakePanes) PID(context.Context, string) (int, error) { return 123, nil }

// stateOf is the engine's derived queue status for the item, read-only.
func (h *harness) stateOf(it operator.TrackedItem) QueueStatus {
	h.t.Helper()
	e := newEngine(h.env)
	e.readOnly = true
	st, f, err := e.observe(context.Background())
	if err != nil {
		h.t.Fatal(err)
	}
	return deriveQueue(st, f, st.Tracked[operator.IndexOf(st.Tracked, it.ID)])
}

// decideFor runs observe and decide against the harness state and returns the
// engine and the item's decision.
func (h *harness) decideFor(id string) (*engine, Decision) {
	h.t.Helper()
	e := newEngine(h.env)
	st, f, err := e.observe(context.Background())
	if err != nil {
		h.t.Fatal(err)
	}
	for _, d := range decide(st, f) {
		if d.Item == id {
			return e, d
		}
	}
	h.t.Fatalf("no decision for %s", id)
	return nil, Decision{}
}

// decisionRows lists the rows decide picks for the harness state, by item.
func (h *harness) decisionRows() map[string]string {
	h.t.Helper()
	e := newEngine(h.env)
	e.readOnly = true
	st, f, err := e.observe(context.Background())
	if err != nil {
		h.t.Fatal(err)
	}
	rows := map[string]string{}
	for _, d := range decide(st, f) {
		rows[d.Item] = d.Row
	}
	return rows
}

// decisions observes and decides against the harness state with e.
func (h *harness) decisions(e *engine) []Decision {
	h.t.Helper()
	st, f, err := e.observe(context.Background())
	if err != nil {
		h.t.Fatal(err)
	}
	return decide(st, f)
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
