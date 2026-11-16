package autopilot

import (
	"context"
	"errors"
	"fmt"
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
// prepares it, opens the window, and marks it. The branch is resolved when the
// window opens, so the caller's first record of the pane already names it.
func (s RiffSpawner) Spawn(ctx context.Context, req SpawnRequest) (SpawnResult, error) {
	opts := riff.Options{
		Server: s.Server, Session: req.Session, RepoRoot: req.Repo, Task: req.Prompt,
		WorktreeName: req.WorktreeName, WorktreeBase: req.BaseSHA,
		WorktreeBranch: req.NewBranch, CheckoutBranch: req.CheckoutBranch,
	}
	prepare := req.Prepare
	if req.ExistingWorktree != "" {
		opts.Where = "checkout"
		opts.RepoRoot = req.ExistingWorktree
		opts.WorktreeName, opts.WorktreeBase, opts.WorktreeBranch, opts.CheckoutBranch = "", "", "", ""
		prepare = nil
	}
	branch := ""
	opened := func(ctx context.Context, pane, window, path string) error {
		closeWindow := func() error {
			target := window
			if target == "" {
				target = pane
			}
			return tmux.KillWindow(target, s.Server)
		}
		b, err := openedBranch(ctx, s.Run, req, path)
		if err != nil {
			err = fmt.Errorf("pane %s closed because its branch could not be read: %w", pane, err)
			if closeErr := closeWindow(); closeErr != nil {
				return errors.Join(fmt.Errorf("orphan pane %s: %w", pane, err), fmt.Errorf("window rollback failed: %w", closeErr))
			}
			return err
		}
		branch = b
		if req.Opened == nil {
			return nil
		}
		res := SpawnResult{PaneID: pane, WindowID: window, Session: req.Session, WorktreePath: path, Branch: branch}
		return persistOpened(req, res, closeWindow)
	}
	res, err := riff.SpawnObserved(ctx, opts, prepare, opened)
	if err != nil {
		return SpawnResult{}, err
	}
	out := SpawnResult{PaneID: res.PaneID, Session: res.Session, WindowID: res.WindowID, WorktreePath: res.WorktreePath, Branch: branch}
	if out.Session == "" {
		out.Session = req.Session
	}
	if err := s.mark(ctx, res.WindowID, req.Note); err != nil {
		return out, fmt.Errorf("pane %s marker not written: %w", res.PaneID, err)
	}
	return out, nil
}

// openedBranch names the branch the new window works on: the request's own
// when it fixed one, else the worktree's checked-out branch. A raw-task or
// bare spawn fixes none, so wt names the branch and only git knows it.
func openedBranch(ctx context.Context, run Runner, req SpawnRequest, worktree string) (string, error) {
	for _, b := range []string{req.NewBranch, req.CheckoutBranch} {
		if b != "" {
			return b, nil
		}
	}
	if worktree == "" {
		worktree = req.ExistingWorktree
	}
	if run == nil || worktree == "" {
		return "", errors.New("no worktree to read the branch from")
	}
	out, err := run.Run(ctx, worktree, "git", "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return "", err
	}
	if b := safeBranch(strings.TrimSpace(out)); b != "" {
		return b, nil
	}
	return "", fmt.Errorf("worktree %s is not on a named branch", worktree)
}

// Marker failures leave the recorded pane in place; the caller reports them.
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

// A pane whose ownership cannot be persisted must be closed before the
// launcher proceeds. If that compensation also fails, report its exact ID.
func persistOpened(req SpawnRequest, res SpawnResult, closePane func() error) error {
	if err := req.Opened(res); err != nil {
		if closeErr := closePane(); closeErr != nil {
			return errors.Join(fmt.Errorf("orphan pane %s: %w", res.PaneID, err), fmt.Errorf("window rollback failed: %w", closeErr))
		}
		return fmt.Errorf("pane %s closed because it could not be recorded: %w", res.PaneID, err)
	}
	return nil
}
