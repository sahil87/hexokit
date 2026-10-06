// Package versionprune deletes superseded releases from a managed-install
// root — the layout both code-server (<state>/code-server/bin) and the Linux
// desktop install (<state>/desktop) share: one <root>/<version>/ dir per
// installed release plus a `current` symlink whose flip is the activation.
//
// The keep set is the `current` target (the live install — never deleted)
// plus one rollback version: the version `current` pointed at before the
// flip, passed by the caller, or — with no flip history — the highest semver
// strictly below the current target. Everything is best-effort: failures are
// logged and pruning continues, so a prune never breaks an install or a
// daemon start.
package versionprune

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// currentLinkName is the activation symlink every managed-install root uses.
const currentLinkName = "current"

// Prune removes every version dir under root except the `current` symlink's
// target and previous (see the package doc for the empty-previous fallback).
// A nil logger uses slog.Default.
func Prune(root, previous string, logger *slog.Logger) {
	if logger == nil {
		logger = slog.Default()
	}
	target, err := os.Readlink(filepath.Join(root, currentLinkName))
	if err != nil {
		// No resolvable current symlink (missing root included): nothing
		// identifies the live version, so deleting anything could kill the
		// active install.
		if !os.IsNotExist(err) {
			logger.Warn("version pruning skipped: current symlink unreadable", "root", root, "err", err)
		}
		return
	}
	current := filepath.Base(target)
	entries, err := os.ReadDir(root)
	if err != nil {
		logger.Warn("version pruning skipped: root unreadable", "root", root, "err", err)
		return
	}
	if previous == "" {
		previous = highestBelow(entries, current)
	}
	keep := map[string]bool{current: true}
	if previous != "" {
		keep[previous] = true
	}
	for _, e := range entries {
		name := e.Name()
		if keep[name] {
			continue
		}
		if _, ok := parseVersion(name); !ok {
			continue // current itself, staging dirs, anything not a version
		}
		if e.Type()&os.ModeSymlink != 0 {
			// A symlinked version entry is someone else's layout (a
			// dotfiles-style link); never recurse into it.
			logger.Info("version pruning: leaving symlinked version entry in place", "root", root, "version", name)
			continue
		}
		if !e.IsDir() {
			continue
		}
		if err := os.RemoveAll(filepath.Join(root, name)); err != nil {
			logger.Warn("version pruning: removing old version failed", "root", root, "version", name, "err", err)
			continue
		}
		logger.Info("version pruning: removed old version", "root", root, "version", name)
	}
}

// WriterLogger returns a logger that renders prune output as plain CLI
// chatter lines on w (warn-level lines prefixed "warning: ") — the install
// commands' Progress channel, so --quiet suppresses prune output like the
// rest of the install chatter.
func WriterLogger(w io.Writer) *slog.Logger {
	return slog.New(writerHandler{w: w})
}

// writerHandler is the minimal slog.Handler behind WriterLogger: one line per
// record, message then key=value attrs, no timestamps or level names.
type writerHandler struct{ w io.Writer }

func (h writerHandler) Enabled(context.Context, slog.Level) bool { return true }

func (h writerHandler) Handle(_ context.Context, r slog.Record) error {
	var b strings.Builder
	if r.Level >= slog.LevelWarn {
		b.WriteString("warning: ")
	}
	b.WriteString(r.Message)
	r.Attrs(func(a slog.Attr) bool {
		fmt.Fprintf(&b, " %s=%v", a.Key, a.Value)
		return true
	})
	b.WriteByte('\n')
	_, err := io.WriteString(h.w, b.String())
	return err
}

func (h writerHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h writerHandler) WithGroup(string) slog.Handler      { return h }

// highestBelow returns the highest-semver version dir strictly below current,
// or "" when none qualifies (or current itself is not a version — then no
// fallback previous exists and only the current target is kept). Symlinked and
// regular-file entries are unmanaged (Prune never deletes them), so one must
// never become the rollback candidate — that would keep it while every real
// rollback dir is deleted.
func highestBelow(entries []os.DirEntry, current string) string {
	cur, ok := parseVersion(current)
	if !ok {
		return ""
	}
	best := ""
	var bestV version
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		v, ok := parseVersion(e.Name())
		if !ok || compare(v, cur) >= 0 {
			continue
		}
		if best == "" || compare(v, bestV) > 0 {
			best, bestV = e.Name(), v
		}
	}
	return best
}

type version [3]int

// parseVersion parses a strict X.Y.Z version dir name. Anything else — the
// `current` symlink, `.staging-*` dirs, pre-release or v-prefixed names — is
// not a managed version and is never pruned.
func parseVersion(name string) (version, bool) {
	var v version
	parts := strings.Split(name, ".")
	if len(parts) != 3 {
		return v, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return version{}, false
		}
		v[i] = n
	}
	return v, true
}

func compare(a, b version) int {
	for i := range a {
		switch {
		case a[i] < b[i]:
			return -1
		case a[i] > b[i]:
			return 1
		}
	}
	return 0
}
