// Package wtdiff reads a git working tree's uncommitted changes.
//
// It is the local sibling of internal/prreview: same row vocabulary
// (internal/diffrows), same list/body split, same eager budget — and none of
// the machinery prreview needs to survive a network. There is no cache, no
// TTL, no stale-while-revalidate, no single-flight and no availability probe,
// because there is nothing to be slow or rate-limited about. Measured on a
// 216-file / 1.70 MB working tree: `git status` 0.01 s, `git diff HEAD` 0.04 s.
// Caching a 50 ms local read would buy nothing and cost a staleness bug.
//
// What it DOES keep is the eager budget, which bounds RENDER cost — a number
// that does not care where the rows came from.
package wtdiff

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"rk/internal/diffrows"
)

// ErrNoRepo is returned when a window resolves to no git repository. It is a
// STATE, not a failure: the surface is repo-backed, so there is no tile rather
// than an empty one.
var ErrNoRepo = errors.New("window is not in a git repository")

// gitTimeout bounds every git subprocess. Generous for a local read; it exists
// so a wedged filesystem or a stale index lock cannot pin a request goroutine.
const gitTimeout = 10 * time.Second

// Status values, projected from git's two-column porcelain code.
const (
	StatusModified  = "modified"
	StatusAdded     = "added"
	StatusRemoved   = "removed"
	StatusRenamed   = "renamed"
	StatusUntracked = "untracked"
)

// Why a file shipped collapsed — the same vocabulary prreview uses, so the
// client's Load-diff affordance needs no new case.
const (
	CollapsedLarge  = "large"
	CollapsedBudget = "budget"
)

// The eager-expansion budget. Identical reasoning to prreview's: a per-FILE cap
// so one generated file cannot dominate the page, a whole-TREE cap so a huge
// rebase does not try to render everything, and a file-count floor.
const (
	maxEagerRowsPerFile = 500
	maxEagerRows        = 5000
	maxEagerFiles       = 75
)

// untrackedByteCap bounds a single untracked file's eager expansion. An
// untracked file is one git has never seen, so it can be anything the user
// dropped in the tree — a database dump, a core file, a video.
const untrackedByteCap = 256 << 10

// FindFile returns the entry for a path, or nil. It is the authorization gate
// every body read passes through — see the route comment.
func (s *Snapshot) FindFile(path string) *FileEntry {
	for i := range s.Files {
		if s.Files[i].Path == path {
			return &s.Files[i]
		}
	}
	return nil
}

// FileEntry is one changed file. Deliberately shaped like prreview.FileEntry so
// the client's file row renders both without branching.
type FileEntry struct {
	Path         string `json:"path"`
	PreviousPath string `json:"previousPath,omitempty"`
	Status       string `json:"status"`
	// Staged reports that the INDEX carries a change for this path. A file can
	// be staged and dirty at once (porcelain `MM`); this is true then, and the
	// rows show the union, which is what `git diff HEAD` returns and what the
	// reader is asking about.
	Staged    bool               `json:"staged"`
	Additions int                `json:"additions"`
	Deletions int                `json:"deletions"`
	HasPatch  bool               `json:"hasPatch"`
	RowCount  int                `json:"rowCount"`
	Rows      []diffrows.LineRow `json:"rows,omitempty"`
	Collapsed string             `json:"collapsed,omitempty"`

	// patch is the file's unified patch, kept off the wire: the client renders
	// from Rows, and echoing the patch would roughly double the payload.
	patch string
}

// Snapshot is one read of the working tree.
type Snapshot struct {
	// Digest fingerprints everything the tile renders. The client polls it and
	// re-reads only when it moves, so a tree nobody is touching costs one small
	// response per tick instead of the whole document.
	Digest string      `json:"digest"`
	Root   string      `json:"root"`
	Files  []FileEntry `json:"files"`
	ReadAt time.Time   `json:"readAt"`
	// Clean reports a working tree with no changes at all. The tile stays
	// available and renders an empty state — the lens exists whenever the
	// window has a repo, and emptiness selects its CONTENT.
	Clean bool `json:"clean"`
}

type gitRunner func(ctx context.Context, dir string, args ...string) ([]byte, error)

// Reader reads working trees. The git seam is injectable so every test runs
// without a repository on disk.
type Reader struct {
	gitExec gitRunner
	now     func() time.Time
}

func NewReader() *Reader {
	return &Reader{gitExec: defaultGitExec, now: time.Now}
}

// NewTestReader builds a Reader with the subprocess seam replaced.
func NewTestReader(git func(ctx context.Context, dir string, args ...string) ([]byte, error)) *Reader {
	r := NewReader()
	if git != nil {
		r.gitExec = git
	}
	return r
}

// Read returns the working tree's changes at `root`.
//
// Two subprocesses for the tracked half, plus one per eagerly-expanded
// untracked file. No caching: see the package comment.
func (r *Reader) Read(ctx context.Context, root string) (*Snapshot, error) {
	status, err := r.gitExec(ctx, root, "status", "--porcelain=v1", "-z")
	if err != nil {
		return nil, err
	}
	entries := parseStatus(string(status))

	// One call carries every tracked change, staged and unstaged, against HEAD.
	// A repository with no commits has no HEAD, and that is not an error — it
	// is a tree where everything is untracked.
	patches := map[string]string{}
	var diffRaw []byte
	if len(trackedPaths(entries)) > 0 {
		diff, diffErr := r.gitExec(ctx, root, "diff", "HEAD", "--no-color", "--no-ext-diff", "-M")
		if diffErr == nil {
			diffRaw = diff
			patches = splitPatches(string(diff))
		}
	}

	files := make([]FileEntry, 0, len(entries))
	for _, entry := range entries {
		file := entry
		if patch, ok := patches[file.Path]; ok {
			file.patch = patch
			file.HasPatch = patch != ""
		}
		files = append(files, file)
	}
	r.expandUntracked(ctx, root, files)
	applyEagerBudget(files)

	return &Snapshot{
		Digest: digestOf(status, diffRaw, files, root),
		Root:   root,
		Files:  files,
		ReadAt: r.now(),
		Clean:  len(files) == 0,
	}, nil
}

// Digest fingerprints the working tree without building the document.
//
// It runs the SAME two reads Read does, because anything cheaper is wrong: a
// `git status` hash alone does not move when a file that is ALREADY modified is
// edited again, which is the commonest change there is. Verified directly —
// editing a tracked file's content leaves the porcelain output byte-identical.
//
// What it saves is the WIRE, not the work: ~70 bytes instead of a megabyte, so
// a client can ask "has anything changed?" on a short cadence and pull the
// document only when the answer is yes.
func (r *Reader) Digest(ctx context.Context, root string) (string, error) {
	status, err := r.gitExec(ctx, root, "status", "--porcelain=v1", "-z")
	if err != nil {
		return "", err
	}
	entries := parseStatus(string(status))
	var diffRaw []byte
	if len(trackedPaths(entries)) > 0 {
		diffRaw, _ = r.gitExec(ctx, root, "diff", "HEAD", "--no-color", "--no-ext-diff", "-M")
	}
	return digestOf(status, diffRaw, entries, root), nil
}

// digestOf hashes the three things that decide what the tile shows.
//
// The third is not obvious and is load-bearing: an UNTRACKED file's content
// appears in neither the status output (which carries only its path) nor
// `git diff HEAD` (which does not see it at all), so editing a new file would
// otherwise never move the digest. Its size and mtime stand in for its content
// — one stat per untracked path, microseconds, and no extra subprocess.
func digestOf(status, diff []byte, files []FileEntry, root string) string {
	h := sha256.New()
	h.Write(status)
	h.Write([]byte{0})
	h.Write(diff)
	for _, file := range files {
		if file.Status != StatusUntracked {
			continue
		}
		h.Write([]byte{0})
		h.Write([]byte(file.Path))
		if info, err := os.Stat(filepath.Join(root, file.Path)); err == nil {
			fmt.Fprintf(h, ":%d:%d", info.Size(), info.ModTime().UnixNano())
		}
	}
	return hex.EncodeToString(h.Sum(nil)[:16])
}

// FileRows serves one file's rows, with token spans.
//
// `path` MUST already have been checked against the snapshot's own file list by
// the caller — that closed set is the authorization, exactly as it is for the
// PR surface. Without it the route would serve any file in the repository, and
// through a `..` segment, any file outside it.
func (r *Reader) FileRows(ctx context.Context, root string, file *FileEntry) (diffrows.FileBody, error) {
	patch := file.patch
	if patch == "" && file.Status == StatusUntracked {
		out, err := r.untrackedPatch(ctx, root, file.Path)
		if err != nil {
			return diffrows.FileBody{}, err
		}
		patch = out
	}
	rows := diffrows.LineRowsFromPatch(diffrows.ParsePatch(patch))
	// The same pass the PR surface's R5 tier 0.5 runs — shared, because a patch
	// is a patch. Here it is the ONLY colour there is: the post image is the
	// file on disk and the patch already carries its text, so there is nothing
	// a blob fetch would add and no refinement tier to climb to.
	diffrows.LexPatchRows(file.Path, rows)
	return diffrows.FileBody{Path: file.Path, Rows: rows}, nil
}

func (r *Reader) expandUntracked(ctx context.Context, root string, files []FileEntry) {
	for i := range files {
		file := &files[i]
		if file.Status != StatusUntracked {
			continue
		}
		patch, err := r.untrackedPatch(ctx, root, file.Path)
		if err != nil {
			continue
		}
		file.patch = patch
		file.HasPatch = patch != ""
		file.Additions = strings.Count(patch, "\n+")
	}
}

// untrackedPatch renders a file git has never seen as an all-added patch.
//
// `--no-index` makes git diff two paths outside its own index, which is the
// only way to get a real unified patch for an untracked file without writing to
// the index (`git add -N` would, and this surface performs no writes).
func (r *Reader) untrackedPatch(ctx context.Context, root, path string) (string, error) {
	out, err := r.gitExec(ctx, root, "diff", "--no-color", "--no-ext-diff", "--no-index", "/dev/null", path)
	if err != nil {
		return "", err
	}
	return trimToHunks(string(out)), nil
}

func trackedPaths(files []FileEntry) []string {
	var out []string
	for _, file := range files {
		if file.Status != StatusUntracked {
			out = append(out, file.Path)
		}
	}
	return out
}

// applyEagerBudget stamps RowCount on every file and fills Rows for the prefix
// that fits, in the tree's own order.
func applyEagerBudget(files []FileEntry) {
	rows, expanded := 0, 0
	for i := range files {
		file := &files[i]
		if !file.HasPatch {
			continue
		}
		patchRows := diffrows.ParsePatch(file.patch)
		file.RowCount = len(patchRows)
		switch {
		case file.RowCount > maxEagerRowsPerFile:
			file.Collapsed = CollapsedLarge
		case expanded >= maxEagerFiles || rows+file.RowCount > maxEagerRows:
			file.Collapsed = CollapsedBudget
		default:
			file.Rows = diffrows.LineRowsFromPatch(patchRows)
			diffrows.LexPatchRows(file.Path, file.Rows)
			rows += file.RowCount
			expanded++
		}
	}
}

// defaultGitExec runs one git invocation with an explicit argv slice under
// gitTimeout (Constitution I: exec.CommandContext + argv, never a shell string).
//
// `git diff --no-index` exits 1 when it finds differences, which for us is the
// SUCCESS case — treating that as a failure would silently drop every untracked
// file. Only a higher code is a real error.
func defaultGitExec(ctx context.Context, dir string, args ...string) ([]byte, error) {
	callCtx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(callCtx, "git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.Output()
	if err != nil {
		var exitErr *exec.ExitError
		if ok := asExitError(err, &exitErr); ok && exitErr.ExitCode() == 1 && isDiff(args) {
			return out, nil
		}
		return nil, err
	}
	return out, nil
}

func isDiff(args []string) bool {
	return len(args) > 0 && args[0] == "diff"
}
