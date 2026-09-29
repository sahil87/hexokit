package tmux

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

// Managed ownership of the default tmux.conf: rk declares ownership in-band
// via a hash-stamped first line, so "did the user edit this?" is a local,
// deterministic check against the embedded default — no version registry, no
// timestamps, no sidecar state file (Constitution II).

const (
	// managedHeaderPrefix opens line 1 of every rk-written managed tmux.conf.
	managedHeaderPrefix = "# rk-managed sha256:"
	// managedHeaderSuffix completes the managed header line. It doubles as the
	// cheapest doc surface: the override pointer sits in the file at the
	// moment of temptation.
	managedHeaderSuffix = " — DO NOT EDIT; overrides go in ~/.config/hexokit/tmux.d/"
)

// legacyManagedHeaderSuffixes holds prior suffixes a managed file may still
// carry — written by earlier releases pointing at the pre-rename config home.
// A stamp-verified legacy header classifies ConfManagedStale (never
// ConfHandEdited) so EnsureConfig force-refreshes the migrated conf onto the
// current header + embed.
var legacyManagedHeaderSuffixes = []string{
	" — DO NOT EDIT; overrides go in ~/.config/run-kit/tmux.d/",
}

// ConfState is the classification of the on-disk managed tmux.conf against the
// embedded default (see ClassifyConfigFile).
type ConfState int

const (
	// ConfMissing: no file at the managed path.
	ConfMissing ConfState = iota
	// ConfManagedCurrent: header present, stamp verifies, body == embed.
	ConfManagedCurrent
	// ConfManagedStale: header present, stamp verifies, body != embed — an
	// rk-written file an embed change left behind.
	ConfManagedStale
	// ConfHandEdited: no header, or the stamp does not verify. Hands off —
	// the file is never written, never auto-migrated.
	ConfHandEdited
)

// managedHash stamps a body: SHA-256, lowercase hex.
func managedHash(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// ManagedConfigBytes renders a managed file: the stamped header line, then the
// body verbatim. The stamp covers exactly the bytes after the header line's
// newline.
func ManagedConfigBytes(body []byte) []byte {
	header := managedHeaderPrefix + managedHash(body) + managedHeaderSuffix + "\n"
	return append([]byte(header), body...)
}

// matchManagedHeader splits a header line into its stamp and reports whether
// the suffix is the current one. Only the prefix plus a known suffix (current
// or legacy) qualify; anything else is not an rk-managed header.
func matchManagedHeader(header string) (stamp string, current bool, ok bool) {
	if !strings.HasPrefix(header, managedHeaderPrefix) {
		return "", false, false
	}
	for i, suffix := range append([]string{managedHeaderSuffix}, legacyManagedHeaderSuffixes...) {
		if strings.HasSuffix(header, suffix) {
			return strings.TrimSuffix(strings.TrimPrefix(header, managedHeaderPrefix), suffix), i == 0, true
		}
	}
	return "", false, false
}

// ClassifyManagedConf classifies file content against the embedded default.
// Pure: it reads nothing but its inputs. Absence is a filesystem fact and is
// not representable here — see ClassifyConfigFile for the full four-state
// classification.
func ClassifyManagedConf(content, embed []byte) ConfState {
	line, body, found := bytes.Cut(content, []byte("\n"))
	if !found {
		return ConfHandEdited
	}
	stamp, currentSuffix, ok := matchManagedHeader(string(line))
	if !ok {
		return ConfHandEdited
	}
	if stamp != managedHash(body) {
		return ConfHandEdited
	}
	// A stamp-verified legacy header is stale by definition: the file must be
	// rewritten onto the current header even when the body matches the embed.
	if !currentSuffix || !bytes.Equal(body, embed) {
		return ConfManagedStale
	}
	return ConfManagedCurrent
}

// ClassifyConfigFile classifies the file at path against the embedded default.
// Shared by the ensure path and the doctor drift row so both agree on every
// state.
func ClassifyConfigFile(path string) (ConfState, error) {
	content, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return ConfMissing, nil
	}
	if err != nil {
		return ConfMissing, fmt.Errorf("reading config file: %w", err)
	}
	return ClassifyManagedConf(content, DefaultConfigBytes()), nil
}

// writeManagedConfig writes the embedded default to path with the managed
// header stamp (0o644, mirroring the sibling config writes).
func writeManagedConfig(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("creating config directory: %w", err)
	}
	return os.WriteFile(path, ManagedConfigBytes(DefaultConfigBytes()), 0o644)
}

// userConfStarter is the scaffolded override file: a commented starter only —
// it changes nothing until the user uncomments the example.
const userConfStarter = `# HexoKit tmux overrides — sourced after the managed tmux.conf.
# This file is yours: rk scaffolds it once and never overwrites it.
#
# Example:
# set -g status-right " #[fg=colour7]%H:%M "
#
# Sibling drop-ins in this directory are sourced in lexicographic order —
# use numeric prefixes (10-*.conf, 20-*.conf) when ordering matters.
`

// scaffoldUserConf creates tmux.d/user.conf as a commented starter when
// absent. An existing user.conf is user-owned and never overwritten —
// including under --force.
func scaffoldUserConf() error {
	if DefaultConfigPath == "" {
		return nil
	}
	path := filepath.Join(filepath.Dir(DefaultConfigPath), "tmux.d", "user.conf")
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("checking user.conf: %w", err)
	}
	return os.WriteFile(path, []byte(userConfStarter), 0o644)
}

// migrateLegacyConfPaths performs the ~/.rk → ~/.config/hexokit tmux migration
// (migration 2), best-effort and never fatal: old tmux.d/*.conf drop-ins move
// into the new tmux.d/ (a same-name file already at the new path wins — never
// overwritten) and the old dir is breadcrumb-renamed; an old tmux.conf is
// breadcrumb-renamed only when byte-equal to the current embed — the only
// zero-false-positive managed-detector for pre-header files. Anything else may
// carry user edits and is left untouched for the doctor recipe (hand-edited
// confs are never auto-migrated).
func migrateLegacyConfPaths() {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	legacyRoot := filepath.Join(home, ".rk")
	newRoot := filepath.Dir(DefaultConfigPath)
	if filepath.Clean(legacyRoot) == filepath.Clean(newRoot) {
		return
	}
	migrateLegacyDropIns(filepath.Join(legacyRoot, "tmux.d"), filepath.Join(newRoot, "tmux.d"))

	legacyConf := filepath.Join(legacyRoot, "tmux.conf")
	content, err := os.ReadFile(legacyConf)
	if err != nil {
		return
	}
	if !bytes.Equal(content, DefaultConfigBytes()) {
		return
	}
	if err := os.Rename(legacyConf, legacyConf+".migrated"); err != nil {
		slog.Warn("legacy tmux.conf breadcrumb failed; leaving in place", "path", legacyConf, "err", err)
	}
}

// migrateLegacyDropIns moves legacy *.conf drop-ins into the new drop-in dir
// and breadcrumb-renames the old dir. The old dir is renamed even when some
// files stayed behind (name conflicts or move failures) — they remain
// reachable under the renamed dir.
func migrateLegacyDropIns(legacyDir, newDir string) {
	entries, err := os.ReadDir(legacyDir)
	if err != nil {
		return // no legacy drop-in dir (or unreadable) — nothing to migrate
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".conf") {
			continue
		}
		dst := filepath.Join(newDir, e.Name())
		if _, err := os.Stat(dst); err == nil {
			continue // the new path wins — never overwritten
		}
		if err := os.MkdirAll(newDir, 0o755); err != nil {
			slog.Warn("legacy tmux.d migration: cannot create new drop-in dir", "dir", newDir, "err", err)
			return
		}
		if err := os.Rename(filepath.Join(legacyDir, e.Name()), dst); err != nil {
			slog.Warn("legacy tmux.d drop-in migration failed; leaving in place", "file", e.Name(), "err", err)
		}
	}
	if err := os.Rename(legacyDir, legacyDir+".migrated"); err != nil {
		slog.Warn("legacy tmux.d breadcrumb failed; leaving in place", "dir", legacyDir, "err", err)
	}
}

// sweepListServers / sweepReloadConfig / sweepIsManaged are the reload-sweep
// seams — tests substitute them to prove the sweep only touches live-enumerated
// managed servers. sweepMigrateLegacy is the legacy-option sweep seam on the
// same pattern.
var (
	sweepListServers   = ListServers
	sweepReloadConfig  = ReloadConfig
	sweepIsManaged     = IsManagedServer
	sweepMigrateLegacy = MigrateLegacyOptionsOnce
)

// RefreshSweep reloads the tmux config on every live managed server. It runs
// only after a stale managed conf was force-written — reloading unchanged
// config on every start would be wasted tmux traffic, and a fresh
// (missing→written) file needs no sweep because no server was started with
// older content. The enumeration rides ListServers — live-socket-probed,
// load-bearing: a tmux command on a dead socket resurrects a server. External
// (unmarked) servers are skipped — rk never pushes its conf onto a server it
// did not birth; a managed-check read failure also skips (fail-closed).
// Per-server failures log and continue; the sweep never fails daemon start.
func RefreshSweep(ctx context.Context) {
	servers, err := sweepListServers(ctx)
	if err != nil {
		slog.Warn("tmux config reload sweep: server enumeration failed", "err", err)
		return
	}
	for _, server := range servers {
		managed, err := sweepIsManaged(ctx, server)
		if err != nil {
			slog.Debug("tmux config reload sweep: managed check failed; skipping", "server", server, "err", err)
			continue
		}
		if !managed {
			slog.Debug("tmux config reload sweep: external server; skipping", "server", server)
			continue
		}
		if err := sweepReloadConfig(server); err != nil {
			slog.Warn("tmux config reload failed", "server", server, "err", err)
		}
		// Legacy-option sweep rides the same managed gate — rk never rewrites
		// options on a server it did not birth. No hub wake: RefreshSweep runs
		// at daemon start, before any client connects.
		if _, err := sweepMigrateLegacy(ctx, server); err != nil {
			slog.Warn("legacy option sweep failed", "server", server, "err", err)
		}
	}
}
