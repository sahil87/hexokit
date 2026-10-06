package homemigrate

import (
	"context"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"

	"rk/internal/apphome"
	"rk/internal/codebridge"
	"rk/internal/settings"
)

// legacyLiveHostsFn is the seam for the live code-bridge host check under the
// legacy state home's cb/ registry — tests substitute it so no test dials a
// socket. The default is codebridge.LiveHosts itself (pid alive AND __ping).
var legacyLiveHostsFn = codebridge.LiveHosts

// LegacyHomeState is the read-only guard evaluation for one legacy run-kit
// home: whether anything sits at the path, whether the home root is itself a
// symlink, why the home is left whole this boot (Hold — "" when deletable),
// and whether only cb/ is retained (KeepCB — a live legacy code-bridge host).
// rk doctor reads the same evaluation the deletion acts on, so the two can
// never drift apart.
type LegacyHomeState struct {
	Label         string // "config" or "state"
	Path          string // the legacy home's path
	Present       bool   // anything exists at Path
	SymlinkedRoot bool   // Path itself is a symlink
	Hold          string // the guard holding the home back this boot; "" when deletable
	KeepCB        bool   // state home only: delete every entry but cb/ (a live legacy host)
}

// LegacyHomes evaluates the deletion guards for both legacy run-kit homes
// without touching the disk (the one probe with a side effect is
// codebridge.LiveHosts's pruning of dead legacy cb records — the same sweep
// `rk code hosts` performs). Every guard is evaluated per home, so a held
// config home never holds back the state home.
func LegacyHomes(ctx context.Context) []LegacyHomeState {
	var out []LegacyHomeState
	for _, h := range []struct {
		label             string
		legacyDir, newDir func() (string, error)
	}{
		{"config", apphome.LegacyConfigDir, apphome.NewConfigDir},
		{"state", apphome.LegacyStateDir, apphome.NewStateDir},
	} {
		legacy, err := h.legacyDir()
		if err != nil {
			out = append(out, LegacyHomeState{Label: h.label, Hold: fmt.Sprintf("the legacy %s home path is unresolvable: %v", h.label, err)})
			continue
		}
		newDir, err := h.newDir()
		if err != nil {
			out = append(out, LegacyHomeState{Label: h.label, Path: legacy, Hold: fmt.Sprintf("the hexokit %s home path is unresolvable: %v", h.label, err)})
			continue
		}
		out = append(out, evalLegacyHome(ctx, h.label, legacy, newDir))
	}
	return out
}

// evalLegacyHome applies the per-home guards in order: the hexokit home must
// exist (a failed migration leaves the legacy home authoritative), the hexokit
// home must not resolve into the legacy tree, no symlink inside the hexokit
// home may point into the legacy tree, and (state only) no live code-bridge
// host may be registered under the legacy cb/ registry. Every unresolvable or
// unreadable step holds the home back — a deletion that cannot prove its
// guards never runs.
func evalLegacyHome(ctx context.Context, label, legacy, newDir string) LegacyHomeState {
	st := LegacyHomeState{Label: label, Path: legacy}
	fi, err := os.Lstat(legacy)
	if err != nil {
		return st // absent — nothing to delete
	}
	st.Present = true
	st.SymlinkedRoot = fi.Mode()&os.ModeSymlink != 0
	if !st.SymlinkedRoot && !fi.IsDir() {
		st.Hold = fmt.Sprintf("%s is not a directory", legacy)
		return st
	}
	if !isDir(newDir) {
		st.Hold = fmt.Sprintf("the hexokit %s home %s does not exist", label, newDir)
		return st
	}
	if hold := newHomeRealPathHold(label, legacy, newDir); hold != "" {
		st.Hold = hold
		return st
	}
	link, err := linkIntoLegacy(legacy, newDir)
	if err != nil {
		st.Hold = fmt.Sprintf("the hexokit %s home %s is unreadable: %v", label, newDir, err)
		return st
	}
	if link != "" {
		st.Hold = fmt.Sprintf("symlink %s in the hexokit %s home points into the legacy home", link, label)
		return st
	}
	if label == "state" && legacyCBLive(ctx, legacy) {
		if st.SymlinkedRoot {
			// Removing the link would pull cb/ out from under the live host.
			st.Hold = fmt.Sprintf("a live code-bridge host is registered under %s and the home root is a symlink", filepath.Join(legacy, "cb"))
			return st
		}
		st.KeepCB = true
	}
	return st
}

// newHomeRealPathHold holds the home back when the hexokit home's real path
// resolves to the legacy home or inside it (a user symlinking
// ~/.config/hexokit at run-kit would otherwise lose everything), or when
// either path cannot be resolved at all.
func newHomeRealPathHold(label, legacy, newDir string) string {
	legacyReal, err := filepath.EvalSymlinks(legacy)
	if err != nil {
		return fmt.Sprintf("the legacy %s home %s does not resolve: %v", label, legacy, err)
	}
	newReal, err := filepath.EvalSymlinks(newDir)
	if err != nil {
		return fmt.Sprintf("the hexokit %s home %s does not resolve: %v", label, newDir, err)
	}
	if linkStaysInside(legacyReal, newDir, newReal) {
		return fmt.Sprintf("the hexokit %s home %s resolves into the legacy tree", label, newDir)
	}
	return ""
}

// linkIntoLegacy walks the hexokit home and returns the first symlink whose
// target resolves — lexically, relative targets against the link's own dir —
// to the legacy home or a path inside it, or "" when none does. A walk failure
// (an unreadable tree) is an error, not an empty result.
func linkIntoLegacy(legacy, newDir string) (string, error) {
	var found string
	err := filepath.WalkDir(newDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type()&os.ModeSymlink == 0 {
			return nil
		}
		target, err := os.Readlink(path)
		if err != nil {
			return err
		}
		if linkStaysInside(legacy, path, target) {
			found = path
			return filepath.SkipAll
		}
		return nil
	})
	return found, err
}

// legacyCBLive reports whether a live code-bridge host is registered under the
// legacy state home's cb/ registry. An unreadable registry (other than absent,
// which reads empty) counts as live: deleting under a maybe-live host is worse
// than keeping cb/ for one more boot.
func legacyCBLive(ctx context.Context, legacy string) bool {
	live, _, err := legacyLiveHostsFn(ctx, filepath.Join(legacy, "cb", "hosts"))
	return err != nil || len(live) > 0
}

// DeleteLegacyHomes deletes the stale run-kit config and state homes, each
// independently when every guard holds for it. Run at release daemon start
// right after Migrate and MoveRKTenants, sharing their call-site gates (the
// dev-build skip and the port-busy deferral) and skipped entirely under the
// RK_CONFIG_DIR test override. The posture matches Migrate: best-effort and
// non-fatal — every failure logs a warning and the daemon keeps starting, and
// every deletion and hold-back is logged. A symlinked legacy root loses only
// the link (its target is untouched); symlinks inside the tree are removed as
// links (os.RemoveAll never follows them).
func DeleteLegacyHomes(logger *slog.Logger) {
	if logger == nil {
		logger = slog.Default()
	}
	if settings.ConfigRootOverridden() {
		logger.Debug("legacy home deletion skipped: " + settings.ConfigDirEnv + " isolates the run")
		return
	}
	for _, st := range LegacyHomes(context.Background()) {
		if !st.Present {
			continue
		}
		deleteLegacyHome(logger, st)
	}
}

// deleteLegacyHome applies one home's guard evaluation: a held home is left
// whole, a symlinked root loses only the link, a KeepCB state home loses every
// entry but cb/, and anything else is removed whole.
func deleteLegacyHome(logger *slog.Logger, st LegacyHomeState) {
	switch {
	case st.Hold != "":
		logger.Info("legacy home left in place", "home", st.Label, "path", st.Path, "reason", st.Hold)
	case st.SymlinkedRoot:
		if err := os.Remove(st.Path); err != nil {
			logger.Warn("legacy home deletion failed; left in place", "home", st.Label, "path", st.Path, "err", err)
			return
		}
		logger.Info("legacy home symlink removed (target untouched)", "home", st.Label, "path", st.Path)
	case st.KeepCB:
		deleteAllButCB(logger, st)
	default:
		if err := os.RemoveAll(st.Path); err != nil {
			logger.Warn("legacy home deletion failed; left in place", "home", st.Label, "path", st.Path, "err", err)
			return
		}
		logger.Info("legacy home deleted", "home", st.Label, "path", st.Path)
	}
}

// deleteAllButCB removes every entry of the legacy state home except cb/,
// which a live code-bridge host still registers under. A later boot whose
// check finds no live host there removes the rest.
func deleteAllButCB(logger *slog.Logger, st LegacyHomeState) {
	entries, err := os.ReadDir(st.Path)
	if err != nil {
		logger.Warn("legacy state home deletion failed; left in place", "path", st.Path, "err", err)
		return
	}
	for _, e := range entries {
		if e.Name() == "cb" {
			continue
		}
		p := filepath.Join(st.Path, e.Name())
		if err := os.RemoveAll(p); err != nil {
			logger.Warn("legacy state home entry deletion failed", "path", p, "err", err)
			continue
		}
		logger.Info("legacy state home entry deleted", "path", p)
	}
	logger.Info("legacy state home kept cb/ (a live code-bridge host is registered there)", "path", st.Path)
}
