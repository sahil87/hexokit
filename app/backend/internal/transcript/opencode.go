package transcript

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sync"
	"syscall"
	"time"

	"rk/internal/apphome"
)

// providerOpencode is the routing key for the OpenCode adapter.
const providerOpencode = "opencode"

// opencodeRefRe validates the NATIVE session-id shape, verified against the
// tagged v1.18.25 source (packages/opencode/src/id/id.ts): the literal `ses_`
// prefix, a 12-char lowercase-hex timestamp, then a 14-char base62 tail over a
// MIXED-CASE alphabet (0-9A-Za-z) — most genuine ids contain uppercase, and
// rejecting them would make the integration non-functional. The literal prefix
// still forbids a leading dash, and the export argv additionally carries an
// end-of-options separator (belt and braces).
var opencodeRefRe = regexp.MustCompile(`^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$`)

// opencodeExportTimeout bounds the native `opencode export` subprocess —
// Constitution §I's 5-10s rule covers tmux helpers; an export serializes a
// whole session, so it gets a wider but still hard bound.
const opencodeExportTimeout = 15 * time.Second

// opencodeExportMaxBytes bounds the captured export stdout: a pathological or
// hostile session must not load unboundedly into memory.
const opencodeExportMaxBytes = 32 << 20

// opencodeExportGrace is the documented validity window of a materialized
// artifact: every path TranscriptPath returns stays on disk for at least this
// long (it exceeds the operator queue's 30-minute TTL, so a queued request's
// embedded paths are still readable when the operator acts on them).
const opencodeExportGrace = time.Hour

// opencodeExportCap bounds the IN-GRACE artifact count. When capacity is
// exhausted, a new materialization is REFUSED (errExportCapacity) rather than
// evicting an in-grace artifact whose path may already be embedded in a
// rendered operator prompt — handed-out paths are never invalidated early.
const opencodeExportCap = 16

// errExportTooLarge marks an export that exceeded opencodeExportMaxBytes.
var errExportTooLarge = errors.New("transcript: opencode export exceeded the output bound")

// errExportCapacity marks a refused materialization: the in-grace artifact cap
// is reached, so serving this request would require evicting a path already
// handed to a consumer. Transient by construction — the grace window expires.
var errExportCapacity = errors.New("transcript: opencode export capacity reached (recent artifacts still in their validity grace) — retry later")

// opencodeExportMu serializes the prune-check-write critical section so
// concurrent request-time resolutions can't race past the capacity bound.
var opencodeExportMu sync.Mutex

// opencodeAdapter materializes an OpenCode session's conversation via the
// NATIVE `opencode export --sanitize -- <sessionID>` command (verified on
// 1.18.25: sessionID positional, JSON on stdout, unknown session exits 1) — no
// database driver, no SQLite read. OpenCode keeps sessions in its own store
// with no per-session transcript file, so resolution is a request-time
// subprocess that writes the JSON into a USER-PRIVATE state dir and returns
// the path (the TranscriptLocator contract is a path; the artifact is a
// disposable per-request materialization — valid for a documented grace
// window, pruned past it, and REFUSED when the in-grace cap is exhausted
// rather than evicting a path already handed to a consumer — never
// authoritative state).
type opencodeAdapter struct{}

func init() { Register(opencodeAdapter{}) }

func (opencodeAdapter) Provider() string { return providerOpencode }

// opencodeExportArgs builds the export argv: `--sanitize` for redaction, then
// an end-of-options separator so no ref can ever read as flags.
func opencodeExportArgs(ref string) []string {
	return []string{"export", "--sanitize", "--", ref}
}

// boundedBuffer is an exec.Stdout sink that fails the write past the byte cap
// (exec surfaces the write error from Wait/Run).
type boundedBuffer struct {
	buf      bytes.Buffer
	limit    int64
	overflow bool
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	if int64(b.buf.Len())+int64(len(p)) > b.limit {
		b.overflow = true
		return 0, errExportTooLarge
	}
	return b.buf.Write(p)
}

// opencodeExportFn runs the export and returns its bounded JSON stdout.
// Package-level seam so tests never spawn the real binary.
var opencodeExportFn = func(ctx context.Context, ref string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, opencodeExportTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "opencode", opencodeExportArgs(ref)...)
	out := &boundedBuffer{limit: opencodeExportMaxBytes}
	cmd.Stdout = out
	err := cmd.Run()
	if out.overflow {
		return nil, errExportTooLarge
	}
	return out.buf.Bytes(), err
}

// opencodeOnPathFn is the PATH-probe seam for the availability check.
var opencodeOnPathFn = func() bool {
	_, err := exec.LookPath("opencode")
	return err == nil
}

// opencodeExportDirFn resolves the USER-PRIVATE materialization dir
// (<state home>/opencode-export, via apphome.StateDir) — a same-machine
// attacker cannot pre-place content in a user-owned state tree, unlike a
// predictable shared /tmp dir. A package-level seam keeps tests hermetic.
var opencodeExportDirFn = func() (string, error) {
	root, err := apphome.StateDir()
	if err != nil {
		return "", fmt.Errorf("resolving opencode export dir: %w", err)
	}
	return filepath.Join(root, "opencode-export"), nil
}

// ensureOpencodeExportDir creates the materialization dir private (0700) or
// verifies/tightens an existing one. A SYMLINK or non-directory at the path is
// an error (never followed); a real dir owned by another uid is an error; a
// real dir owned by us with too-open perms is tightened to 0700.
func ensureOpencodeExportDir() (string, error) {
	dir, err := opencodeExportDirFn()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return "", err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("transcript: opencode export dir %s is not a real directory — refusing to use it", dir)
	}
	if st, ok := info.Sys().(*syscall.Stat_t); ok && int(st.Uid) != os.Getuid() {
		return "", fmt.Errorf("transcript: opencode export dir %s is owned by uid %d — refusing to use it", dir, st.Uid)
	}
	if info.Mode().Perm()&0o077 != 0 {
		if err := os.Chmod(dir, 0o700); err != nil {
			return "", fmt.Errorf("transcript: tightening opencode export dir perms: %w", err)
		}
	}
	return dir, nil
}

// writeOpencodeExport writes data to <dir>/<ref>.json race-safely: a
// CreateTemp sibling (O_EXCL, 0600, random name — never a preplaced target),
// then an atomic rename onto the final path. Rename REPLACES a preplaced
// symlink at the target rather than following it. Failures remove the temp
// file.
func writeOpencodeExport(dir, ref string, data []byte) (string, error) {
	tmp, err := os.CreateTemp(dir, ".export-*")
	if err != nil {
		return "", err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return "", err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return "", err
	}
	target := filepath.Join(dir, ref+".json")
	if err := os.Rename(tmpName, target); err != nil {
		os.Remove(tmpName)
		return "", err
	}
	return target, nil
}

// prunePastGraceLocked removes artifacts past the documented grace window
// (they are no longer valid by policy) and reports the IN-GRACE count. Caller
// holds opencodeExportMu. Best-effort per file — an unreadable entry is
// skipped, never fatal.
func prunePastGraceLocked(dir string, now time.Time) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	inGrace := 0
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if now.Sub(info.ModTime()) > opencodeExportGrace {
			_ = os.Remove(filepath.Join(dir, e.Name()))
			continue
		}
		inGrace++
	}
	return inGrace
}

// ConversationAvailable is the derive-tick probe (ConversationChecker): a
// well-formed native ref plus the opencode binary on PATH. Deliberately cheap —
// the real resolution is an export subprocess that runs ONLY at request time
// (POST / queue drain revalidate), never on the dashboard's derive tick.
func (opencodeAdapter) ConversationAvailable(ref string) bool {
	return opencodeRefRe.MatchString(ref) && opencodeOnPathFn()
}

// TranscriptPath exports the session's JSON into the private state dir and
// returns its path. An unknown session (the export's non-zero exit) is
// ErrTranscriptNotFound; an oversized export, an unsafe pre-existing dir, and
// an unstartable binary are plain errors (the 500 class), mirroring the other
// adapters' invalid/not-found/server-error split.
func (opencodeAdapter) TranscriptPath(ref string) (string, error) {
	if !opencodeRefRe.MatchString(ref) {
		return "", ErrInvalidRef
	}
	dir, err := ensureOpencodeExportDir()
	if err != nil {
		return "", err
	}
	out, err := opencodeExportFn(context.Background(), ref)
	var exitErr *exec.ExitError
	switch {
	case err == nil && len(out) > 0:
		// proceed
	case errors.Is(err, errExportTooLarge):
		return "", err
	case errors.As(err, &exitErr) || (err == nil && len(out) == 0):
		return "", ErrTranscriptNotFound
	default:
		return "", fmt.Errorf("transcript: opencode export: %w", err)
	}
	opencodeExportMu.Lock()
	defer opencodeExportMu.Unlock()
	// Capacity is checked under the lock BEFORE writing: when the in-grace cap
	// is reached, the new materialization is refused rather than evicting a
	// path already handed to a consumer.
	if inGrace := prunePastGraceLocked(dir, time.Now()); inGrace >= opencodeExportCap {
		return "", errExportCapacity
	}
	path, err := writeOpencodeExport(dir, ref, out)
	if err != nil {
		return "", err
	}
	return path, nil
}
