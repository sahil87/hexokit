package autopilot

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"

	"rk/internal/riff"
	"rk/internal/tmux"
)

const windowMarkerAuto = "auto"

// RiffSpawner is the production Spawner: the wt + tmux window + launcher engine
// of internal/riff, in-process, targeting an explicit tmux server and session.
type RiffSpawner struct {
	Server string
	Run    Runner
}

// Spawn creates the worktree (or reuses one that already holds the branch),
// prepares it, opens the window, and marks it.
func (s RiffSpawner) Spawn(ctx context.Context, req SpawnRequest) (SpawnResult, error) {
	opts := riff.Options{
		Server: s.Server, Session: req.Session, RepoRoot: req.Repo, Task: req.Prompt,
		WorktreeName: req.WorktreeName, WorktreeBase: req.BaseSHA,
		WorktreeBranch: req.NewBranch, CheckoutBranch: req.CheckoutBranch,
	}
	prepare := req.Prepare
	root := ""
	if req.ExistingWorktree != "" {
		opts.Where = "checkout"
		opts.RepoRoot = req.ExistingWorktree
		opts.WorktreeName, opts.WorktreeBase, opts.WorktreeBranch, opts.CheckoutBranch = "", "", "", ""
		prepare = nil
		root = req.ExistingWorktree
	}
	res, err := riff.SpawnPrepared(ctx, opts, prepare)
	if err != nil {
		return SpawnResult{}, err
	}
	if root == "" {
		root = res.WorktreePath
	}
	out := SpawnResult{PaneID: res.PaneID, Session: res.Session, WindowID: res.WindowID, WorktreePath: res.WorktreePath}
	if out.Session == "" {
		out.Session = req.Session
	}
	if root != "" && s.Run != nil {
		if b, berr := s.Run.Run(ctx, root, "git", "rev-parse", "--abbrev-ref", "HEAD"); berr == nil {
			out.Branch = strings.TrimSpace(b)
		}
	}
	s.mark(ctx, res.WindowID, req.Note)
	return out, nil
}

// mark sets the window's auto marker and its note. Best-effort: the agent is
// already running either way.
func (s RiffSpawner) mark(ctx context.Context, windowID, note string) {
	if windowID == "" {
		return
	}
	auto := windowMarkerAuto
	ops := []tmux.WindowOptionOp{{Key: tmux.MarkerOption, Value: &auto}}
	if note != "" {
		v := fmt.Sprintf("%d:%s", nowUnix(), note)
		ops = append(ops, tmux.WindowOptionOp{Key: tmux.NoteOption, Value: &v})
	}
	_ = tmux.SetWindowOptions(ctx, windowID, s.Server, ops)
}

// Worktree checks the branch out in a new worktree for git work.
func (s RiffSpawner) Worktree(ctx context.Context, repo, branch string) (string, func(), error) {
	name := "ap-" + strings.NewReplacer("/", "-", " ", "-").Replace(branch)
	path, err := riff.CreateWorktree(ctx, repo, riff.WorktreeOptions{Name: name, CheckoutBranch: branch})
	if err != nil {
		return "", nil, err
	}
	return path, func() { _ = riff.DeleteWorktree(context.Background(), repo, filepath.Base(path)) }, nil
}
