package autopilot

import (
	"context"
	"errors"
	"fmt"
	"os"
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
	var opened func(context.Context, string, string, string) error
	if req.Opened != nil {
		opened = func(ctx context.Context, pane, window, path string) error {
			branch := req.NewBranch
			if branch == "" {
				branch = req.CheckoutBranch
			}
			res := SpawnResult{PaneID: pane, WindowID: window, Session: req.Session, WorktreePath: path, Branch: branch}
			return persistOpened(req, res, func() error {
				target := window
				if target == "" {
					target = pane
				}
				return tmux.KillWindow(target, s.Server)
			})
		}
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
	res, err := riff.SpawnObserved(ctx, opts, prepare, opened)
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
		} else {
			return out, fmt.Errorf("pane %s opened but branch lookup failed: %w", out.PaneID, berr)
		}
	}
	if err := s.mark(ctx, res.WindowID, req.Note); err != nil {
		return out, fmt.Errorf("pane %s marker not written: %w", res.PaneID, err)
	}
	return out, nil
}

// Marker failures retain the recorded pane for reconciliation by the caller.
func (s RiffSpawner) mark(ctx context.Context, windowID, note string) error {
	if windowID == "" {
		return nil
	}
	auto := windowMarkerAuto
	ops := []tmux.WindowOptionOp{{Key: tmux.MarkerOption, Value: &auto}}
	if note != "" {
		v := fmt.Sprintf("%d:%s", nowUnix(), note)
		ops = append(ops, tmux.WindowOptionOp{Key: tmux.NoteOption, Value: &v})
	}
	return tmux.SetWindowOptions(ctx, windowID, s.Server, ops)
}

// Worktree checks the branch out in a new worktree for git work.
func (s RiffSpawner) Worktree(ctx context.Context, repo, branch string) (string, func() error, error) {
	name := "ap-" + strings.NewReplacer("/", "-", " ", "-").Replace(branch)
	path, err := riff.CreateWorktree(ctx, repo, riff.WorktreeOptions{Name: name, CheckoutBranch: branch})
	if err != nil {
		return "", nil, err
	}
	return path, func() error { return s.RemoveWorktree(context.Background(), repo, path) }, nil
}

func (s RiffSpawner) RemoveWorktree(ctx context.Context, repo, path string) error {
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return nil
	}
	return riff.DeleteWorktree(ctx, repo, filepath.Base(path))
}

// A pane whose ownership cannot be persisted must be closed before the
// launcher proceeds. If that compensation also fails, report its exact ID.
func persistOpened(req SpawnRequest, res SpawnResult, closePane func() error) error {
	if err := req.Opened(res); err != nil {
		if closeErr := closePane(); closeErr != nil {
			return errors.Join(fmt.Errorf("orphan pane %s: %w", res.PaneID, err), fmt.Errorf("window rollback failed: %w", closeErr))
		}
		return fmt.Errorf("pane %s closed because its claim could not be recorded: %w", res.PaneID, err)
	}
	return nil
}
