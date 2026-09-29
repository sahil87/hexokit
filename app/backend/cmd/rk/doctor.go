package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"rk/internal/codebridge"
	"rk/internal/codeserver"
	"rk/internal/config"
	"rk/internal/cron"
	"rk/internal/daemon"
	"rk/internal/fabconfig"
	"rk/internal/gui"
	"rk/internal/mcp"
	"rk/internal/portpolicy"
	"rk/internal/settings"
	"rk/internal/tmux"

	"github.com/spf13/cobra"
)

// doctorJSON requests machine-readable output on stdout. Principle 2 names
// `doctor` as a --json carrier; the structured result goes to stdout (data)
// while the human diagnostic remains on stderr.
var doctorJSON bool

// tmuxVersionProbe is the seam for the PATH tmux version probe, shared by the
// doctor tmux row and the serve-startup warning — tests substitute it to
// drive the below-floor / unknown branches without a real tmux.
var tmuxVersionProbe = tmux.CurrentVersion

// tmuxServerList / tmuxServerVersionProbe are the seams for the drift sweep
// (live-server enumeration + per-server version probe) — tests substitute
// them to drive every drift branch without live tmux servers.
var (
	tmuxServerList         = tmux.ListServers
	tmuxServerVersionProbe = tmux.ServerVersion
)

// ephemeralServersList is the seam for the ephemeral-servers check — tests
// substitute it to drive the nonzero/zero/enumeration-error branches without
// live tmux servers.
var ephemeralServersList = tmux.EphemeralServers

// doctorCheck is one dependency check in the --json report. `ok` is the pass
// flag; `hint` carries the remediation string on failure (empty when ok);
// `note` carries informational state on a passing check (e.g. an optional
// artifact reported as not installed).
type doctorCheck struct {
	Name string `json:"name"`
	OK   bool   `json:"ok"`
	Hint string `json:"hint,omitempty"`
	Note string `json:"note,omitempty"`
	// failLabel overrides the human [FAIL] row's default "<name> not found"
	// lead-in for checks whose failures are not absences (the shim check fails
	// on mis-wiring, not on a missing binary). Unexported on purpose: it is
	// human rendering only and never appears in --json.
	failLabel string
}

// doctorReport is the top-level --json document. `ok` is the overall verdict:
// worst-check-wins — false when any check failed (Principle 4 aggregation rule).
type doctorReport struct {
	OK     bool          `json:"ok"`
	Checks []doctorCheck `json:"checks"`
}

// runDoctorChecks performs every dependency check and returns the structured
// report. It is pure of any output stream so both the human and JSON renderers
// consume the same result — the single source of truth for the verdict.
func runDoctorChecks() doctorReport {
	report := doctorReport{OK: true}

	if _, err := exec.LookPath("tmux"); err != nil {
		report.Checks = append(report.Checks, doctorCheck{Name: "tmux", OK: false, Hint: tmux.InstallHint(runtime.GOOS, exec.LookPath)})
		report.OK = false
	} else {
		report.Checks = append(report.Checks, tmuxVersionCheck())
	}

	if home, err := os.UserHomeDir(); err == nil {
		c := tmuxGuardShimCheck(home, os.Getenv("PATH"), exec.LookPath)
		report.Checks = append(report.Checks, c)
		if !c.OK {
			report.OK = false
		}
	}

	// code-server (260811-a2bo) — the daemon-managed editor behind /code/.
	// Always WARN-shaped (OK with a note), never a FAIL: an absent or
	// not-yet-started editor must not fail doctor — daemon start itself only
	// warns and continues (internal/daemon ensureCodeServer). home may be ""
	// when unresolvable — the managed-install rung is then skipped.
	home, _ := os.UserHomeDir()
	report.Checks = append(report.Checks, codeServerCheck(home, exec.LookPath, dialTCP))

	// code bridge — the rk-code-bridge extension behind `rk code exec`,
	// installed by `rk code-server install`/`update`. Always OK-shaped (the
	// code-server posture): absence is a note, never a verdict flipper.
	report.Checks = append(report.Checks, codeBridgeCheck(codeserver.ExtensionsDir(home), codeBridgeEmbeddedVersion(), codeBridgeLiveHostCount))

	// gui — the host desktop surface (the rk-gui session + RFB relay).
	// Always OK-shaped: off is the default and not-running is a state, never
	// a dependency failure. See guiDoctorCheck.
	report.Checks = append(report.Checks, guiDoctorCheck())

	// mcp — the policy-table drift guard. Unlike the state rows above, a table
	// that cannot resolve is a real defect, so this row is a verdict flipper.
	c, mcpTools := mcpDoctorCheck()
	report.Checks = append(report.Checks, c)
	if !c.OK {
		report.OK = false
	}

	// mcp route — the daemon's /mcp streamable-HTTP transport, probed over the
	// resolved origin. Always OK-shaped (the code-server state posture): a
	// stopped or pre-route daemon is a state, not a dependency failure — the
	// mcp row above remains the verdict flipper. The tool count rides the
	// drift guard's resolution (0 when it failed, dropping the tools suffix).
	report.Checks = append(report.Checks, mcpRouteDoctorCheck(context.Background(), mcpTools))

	// Ephemeral servers — informational hygiene count, always OK-shaped (the
	// code-server/drift posture): scratch servers are deliberate creator
	// opt-in, never a dependency failure.
	report.Checks = append(report.Checks, ephemeralServersCheck())

	// Agent hooks — the rk-owned settings.json hook entries' install state:
	// stale generations still write the retired option names, and a gen-3 hook
	// whose embedded rk path dangles writes nothing at all.
	if home != "" {
		c := agentHooksCheck(home, os.ReadFile, os.Stat)
		report.Checks = append(report.Checks, c)
		if !c.OK {
			report.OK = false
		}
	}

	// Legacy tmux options — informational count of live servers still carrying
	// the pre-scope-named option keys, always OK-shaped: the attach/adopt-time
	// sweep is the healer, doctor only reports.
	report.Checks = append(report.Checks, legacyOptionsCheck())

	// tmux config — the managed-conf ownership/drift row, always OK-shaped
	// (informational only: remediation is the note's recipe, never a failure).
	report.Checks = append(report.Checks, tmuxConfigCheck())

	// Cron ticker — configuration + disk facts only (the setting state and
	// the cron state dir's resolvability), always OK-shaped: doctor runs in a
	// separate process from the daemon, so live goroutine state is not
	// reportable and nothing here may fail the report.
	report.Checks = append(report.Checks, cronTickerCheck())

	// Locale — whether this process and the rk-daemon server's global env pass
	// tmux's client UTF-8 rule, always OK-shaped: the process side is already
	// repaired at startup (only the forced record can say the host lacked a
	// locale) and a locale-less server is a state its panes inherit, never a
	// dependency failure.
	report.Checks = append(report.Checks, localeCheck(localeForced, os.LookupEnv, daemonGlobalEnv))

	// Set-but-ignored env vars: RK_SSH_HOST no longer has any reader (the
	// ssh_host setting is the only source), so a row appears ONLY when it is
	// set — steady-state output stays noise-free.
	if c, ok := removedEnvCheck(); ok {
		report.Checks = append(report.Checks, c)
		if !c.OK {
			report.OK = false
		}
	}

	// Stale project riff: block — the preset layer moved to run-kit's own
	// riff_presets setting, so a leftover top-level riff: key in the cwd repo's
	// fab/project/config.yaml is silently ignored at spawn. Advisory only,
	// WARN-shaped (the removedEnvCheck "second return false → no row" pattern,
	// but never flipping the verdict — a third-party repo's stale config must
	// not fail rk doctor).
	if cwd, err := os.Getwd(); err == nil {
		if repoRoot := config.FindGitRoot(cwd); repoRoot != "" && fabconfig.IsFabProject(repoRoot) {
			if c, ok := riffPresetsBlockCheck(repoRoot, fabconfig.HasTopLevelKey); ok {
				report.Checks = append(report.Checks, c)
			}
		}
	}

	// Ports — the effective daemon port against the reserved blocks
	// (portpolicy). Always OK-shaped (the code-server/ephemeral posture): a
	// collision is advisory only — warn, never refuse, never a verdict flipper.
	report.Checks = append(report.Checks, portsDoctorCheck(config.Load()))

	// Port pin — the home migration pins existing installs at the legacy
	// daemon port; once the default moves, nudge pinned installs toward it.
	// Advisory only, OK-shaped (the removedEnvCheck "second return false → no
	// row" pattern): no row while the pin is dormant or overridden.
	if c, ok := portPinCheck(settings.Load().Port, portpolicy.DaemonDefault, portpolicy.DaemonLegacy, rkPortOverride()); ok {
		report.Checks = append(report.Checks, c)
	}

	return report
}

// portPinCheck advises an install pinned at the pre-rename daemon port how to
// move to the current default. OK-shaped with a Note, never a verdict
// flipper; the second return value is false when no row should appear (the
// removedEnvCheck pattern). The row fires only when config.yaml's port equals
// the legacy default, the current default has moved off it, and RK_PORT is
// not overriding — so it stays dormant while DaemonDefault == DaemonLegacy.
// Pure over its inputs so table tests can inject both policy constants.
func portPinCheck(pinned, def, legacy int, envOverride bool) (doctorCheck, bool) {
	if pinned != legacy || def == legacy || envOverride {
		return doctorCheck{}, false
	}
	return doctorCheck{
		Name: "port pin",
		OK:   true,
		Note: fmt.Sprintf("pinned at :%d (kept through the HexoKit rename); new installs default to :%d — to move: set port: %d in ~/.config/hexokit/config.yaml, rk daemon restart, then re-point Tailscale Serve, bookmarks/phone shortcuts, and MCP clients at :%d/mcp",
			pinned, def, def, def),
	}, true
}

// rkPortOverride reports whether RK_PORT is set to a valid port — while it
// wins over config.yaml anyway, the pin row stays quiet.
func rkPortOverride() bool {
	v := os.Getenv(config.PortEnvVar)
	if v == "" {
		return false
	}
	p, err := strconv.Atoi(v)
	return err == nil && p >= 1 && p <= 65535
}

// portsDoctorCheck reports the effective daemon port and the reserved port
// blocks (portpolicy). Always OK-shaped, never a verdict flipper: a collision
// leads the note with a warning naming the block(s), the actual colliding
// footprint port(s), and the remedy env var(s), followed by the full resolved
// footprint — a code-server-only collision is never attributed to the daemon
// port. A working daemon may already sit inside a block, so the row stays
// advisory. Collisions come from reservedCollisions, the same read serve and
// `rk ports` use (dev builds exempt the rig block). Pure over the resolved
// config for table testing.
func portsDoctorCheck(cfg config.Config) doctorCheck {
	check := doctorCheck{Name: "ports", OK: true}
	daemonFrag := fmt.Sprintf("daemon :%d", cfg.Port)
	if cfg.Port == portpolicy.DaemonDefault {
		daemonFrag += " (default)"
	}
	reserved := "reserved: " + portpolicy.Summary()
	if blocks := reservedCollisions(cfg); len(blocks) > 0 {
		details := make([]string, len(blocks))
		seen := map[string]bool{}
		var envVars []string
		for i, b := range blocks {
			ports, envs := footprintSummary(blockFootprintHits(cfg, b))
			details[i] = b.String() + ": " + ports
			for _, e := range envs {
				if !seen[e] {
					seen[e] = true
					envVars = append(envVars, e)
				}
			}
		}
		footprint := daemonFrag
		if cs := cfg.ResolvedCodeServerPort(); cs != 0 {
			footprint += fmt.Sprintf("; code-server :%d", cs)
		}
		check.Note = fmt.Sprintf("WARNING: port inside reserved block(s) %s — set %s outside; %s; %s",
			strings.Join(details, "; "), strings.Join(envVars, " / "), footprint, reserved)
		return check
	}
	check.Note = fmt.Sprintf("%s; %s", daemonFrag, reserved)
	return check
}

// localeForced / daemonGlobalEnv are the seams for the locale row — tests
// substitute them to drive every note shape without touching the real
// environment or a live tmux server.
var (
	localeForced    = tmux.ForcedLocale
	daemonGlobalEnv = func(ctx context.Context) (map[string]string, error) {
		return tmux.ServerGlobalEnv(ctx, daemon.ServerSocket)
	}
)

// localeCheck reports whether the rk process and the rk-daemon tmux server's
// global environment satisfy tmux's client UTF-8 rule (tmux.LocaleStatus).
// Always OK-shaped. The process fragment reads the forced-locale record
// because EnsureUTF8Locale has already repaired the environment by the time
// any check runs. The server fragment matters because panes born in that
// server inherit its global env, not rk's: an Electron- or launchd-born
// server stays locale-less until `rk daemon restart --full`. Remediation
// rides the note — the human renderer prints Hint only on FAIL rows. A gone
// server (nil env) omits the fragment; any other probe error degrades to a
// skip note.
func localeCheck(forced func() (string, string, bool), lookup func(string) (string, bool), probe func(context.Context) (map[string]string, error)) doctorCheck {
	check := doctorCheck{Name: "locale", OK: true}
	var frags []string
	if name, value, ok := forced(); ok {
		frags = append(frags, fmt.Sprintf("process: no UTF-8 locale in environment; forced %s=%s", name, value))
	} else if name, value, utf8 := tmux.LocaleStatus(lookup); utf8 {
		frags = append(frags, fmt.Sprintf("process: %s=%s", name, value))
	} else {
		frags = append(frags, "process: no UTF-8 locale in environment")
	}

	ctx, cancel := context.WithTimeout(context.Background(), tmux.TmuxTimeout)
	defer cancel()
	env, err := probe(ctx)
	switch {
	case err != nil:
		frags = append(frags, fmt.Sprintf("%s server env: probe skipped — %v", daemon.ServerSocket, err))
	case env == nil:
		// Server not running: nothing to report.
	default:
		name, value, utf8 := tmux.LocaleStatus(func(k string) (string, bool) {
			v, ok := env[k]
			return v, ok
		})
		if utf8 {
			frags = append(frags, fmt.Sprintf("%s server: %s=%s", daemon.ServerSocket, name, value))
		} else {
			frags = append(frags, fmt.Sprintf("%s server env: no UTF-8 locale — panes born there run without one; run 'rk daemon restart --full' from a terminal with LANG set", daemon.ServerSocket))
		}
	}
	check.Note = strings.Join(frags, "; ")
	return check
}

// cronTickerCheck reports the cron ticker's configuration facts: the
// cron_ticker setting state and the cron state dir's resolvability/path.
// Always OK-shaped (the ephemeral/tmux-config posture) — informational only,
// never a verdict flipper.
func cronTickerCheck() doctorCheck {
	check := doctorCheck{Name: "cron ticker", OK: true}
	state := "on"
	if !settings.Load().CronTicker {
		state = "off"
	}
	dir, err := cron.DefaultDir()
	if err != nil {
		check.Note = fmt.Sprintf("cron_ticker %s; state dir unresolvable: %v", state, err)
		return check
	}
	check.Note = fmt.Sprintf("cron_ticker %s; state dir %s", state, dir)
	return check
}

// removedEnvCheck flags a set-but-ignored RK_SSH_HOST: the env read was
// removed (the ssh_host key in ~/.config/hexokit/config.yaml is the only
// ssh-host source), so a still-exported value silently does nothing. The
// second return value is false when the var is unset — no row, no noise.
func removedEnvCheck() (doctorCheck, bool) {
	if os.Getenv("RK_SSH_HOST") == "" {
		return doctorCheck{}, false
	}
	return doctorCheck{
		Name:      "RK_SSH_HOST",
		OK:        false,
		Hint:      "RK_SSH_HOST is no longer read — set the ssh_host key in ~/.config/hexokit/config.yaml",
		failLabel: "RK_SSH_HOST set but ignored",
	}, true
}

// riffPresetsBlockCheck advises when the repo's fab/project/config.yaml still
// carries a top-level riff: key — rk no longer reads it (presets live under
// riff_presets in ~/.config/hexokit/config.yaml). WARN-shaped: OK with a Note,
// never a verdict flipper. The second return value is false when the key is
// absent — no row, no noise (the removedEnvCheck pattern).
func riffPresetsBlockCheck(repoRoot string, hasKey func(string, string) bool) (doctorCheck, bool) {
	if !hasKey(repoRoot, "riff") {
		return doctorCheck{}, false
	}
	return doctorCheck{
		Name: "riff presets",
		OK:   true,
		Note: "fab/project/config.yaml has a riff: block that rk no longer reads — define presets under riff_presets in ~/.config/hexokit/config.yaml",
	}, true
}

// ephemeralServersCheck reports the count of live servers carrying the
// @rk_ephemeral mark with the reap remediation hint. Always OK — the row is
// informational and must never flip the overall verdict. The enumeration
// rides the reaper's own semantics via tmux.EphemeralServers (live-only,
// _rk-ctl/rk-daemon hard-skipped, per-server failures isolated); an
// enumeration error degrades to an OK row naming the skip rather than
// blocking or failing doctor (the drift sweep's never-block posture).
func ephemeralServersCheck() doctorCheck {
	check := doctorCheck{Name: "ephemeral servers", OK: true}
	ctx, cancel := context.WithTimeout(context.Background(), tmux.TmuxTimeout)
	defer cancel()
	marked, err := ephemeralServersList(ctx)
	if err != nil {
		check.Note = fmt.Sprintf("skipped — enumeration failed: %v", err)
		return check
	}
	if len(marked) == 0 {
		check.Note = "none"
		return check
	}
	check.Note = fmt.Sprintf("%d live server(s) marked %s — sweep with `rk mux reap --ephemeral`", len(marked), tmux.EphemeralOption)
	return check
}

// legacyOptionsScanResult is one live server's legacy-option tally: how many
// pre-scope-named option keys it still holds at any scope, and whether rk
// manages it (the daemon sweep never touches an unmanaged server).
type legacyOptionsScanResult struct {
	Server  string
	Count   int
	Managed bool
}

// legacyOptionsScan is the seam for the legacy-options row — tests substitute
// it to drive every note shape without live tmux servers. The default
// enumerates only live servers via ListServers (a tmux command on a dead
// socket resurrects a server) and shares the migrator's table and scope walk
// via CountLegacyOptions.
var legacyOptionsScan = func(ctx context.Context) ([]legacyOptionsScanResult, error) {
	servers, err := tmux.ListServers(ctx)
	if err != nil {
		return nil, err
	}
	results := make([]legacyOptionsScanResult, 0, len(servers))
	for _, server := range servers {
		count, err := tmux.CountLegacyOptions(ctx, server)
		if err != nil {
			// One failing server (socket died mid-scan) must not abort the
			// whole row — count the rest (the per-carrier sweep posture).
			slog.Debug("legacy options scan: skipping server", "server", server, "err", err)
			continue
		}
		managed, err := tmux.IsManagedServer(ctx, server)
		if err != nil {
			slog.Debug("legacy options scan: managed check failed; skipping server", "server", server, "err", err)
			continue
		}
		results = append(results, legacyOptionsScanResult{Server: server, Count: count, Managed: managed})
	}
	return results, nil
}

// legacyOptionsCheck reports how many live servers still carry legacy option
// names (@color/@session_color) at any scope. Always OK-shaped (the
// ephemeral-servers posture — informational, never a verdict flipper):
// remediation is the attach/adopt-time sweep named in the note, never doctor
// itself (doctor diagnoses, it never migrates). External servers are counted
// with a distinct phrasing because the daemon will never heal those. An
// enumeration failure degrades to an OK row naming the skip.
func legacyOptionsCheck() doctorCheck {
	check := doctorCheck{Name: "legacy tmux options", OK: true}
	ctx, cancel := context.WithTimeout(context.Background(), tmux.TmuxTimeout)
	defer cancel()
	results, err := legacyOptionsScan(ctx)
	if err != nil {
		check.Note = fmt.Sprintf("skipped — enumeration failed: %v", err)
		return check
	}
	dirty, external := 0, 0
	for _, r := range results {
		if r.Count > 0 {
			dirty++
			if !r.Managed {
				external++
			}
		}
	}
	if dirty == 0 {
		check.Note = "none"
		return check
	}
	check.Note = fmt.Sprintf("%d server(s) still carry legacy option names (@color/@session_color) — attach from the dashboard or run `rk mux adopt <server>` to sweep", dirty)
	if external > 0 {
		check.Note += fmt.Sprintf(", of which %d external — rk will not rewrite those", external)
	}
	return check
}

// tmuxVersionCheck is the passing tmux row, enriched with the probed version:
// the plain version at/above the floor, the shared below-floor message below
// it (WARN-shaped — the row stays OK, mirroring the code-server precedent;
// doctor is the detail view, not the enforcement point), and no note for an
// unknown version (never block on a parse). When the binary version is known,
// drift sentences for running servers still executing an older version are
// appended (see tmuxDriftNotes). --json carries the note verbatim.
func tmuxVersionCheck() doctorCheck {
	check := doctorCheck{Name: "tmux", OK: true}
	ctx, cancel := context.WithTimeout(context.Background(), tmux.TmuxTimeout)
	defer cancel()
	v, ok := tmuxVersionProbe(ctx)
	if !ok {
		return check
	}
	if v.BelowFloor() {
		check.Note = tmux.UpgradeHint(runtime.GOOS, exec.LookPath, v.Raw)
	} else {
		check.Note = v.Raw
	}
	check.Note = strings.Join(append([]string{check.Note}, tmuxDriftNotes(v)...), "; ")
	return check
}

// tmuxDriftNotes sweeps the live tmux servers and returns one drift sentence
// per server still executing a version strictly older than the on-disk binary
// — an upgrade replaces the binary but never the running servers, and that
// latency is invisible without this note. Informational only, doctor-only,
// and never a restart (Constitution VI: the timing is the user's call — the
// sentence names the cost). Only servers ListServers confirmed live are
// probed (a tmux command on a dead socket can resurrect a server); every
// failure — enumeration error, unknown server version — degrades to a silent
// skip, so drift can never fail or block the row.
func tmuxDriftNotes(binary tmux.Version) []string {
	ctx, cancel := context.WithTimeout(context.Background(), tmux.TmuxTimeout)
	defer cancel()
	servers, err := tmuxServerList(ctx)
	if err != nil {
		return nil
	}
	var notes []string
	for _, server := range servers {
		probeCtx, probeCancel := context.WithTimeout(context.Background(), tmux.TmuxTimeout)
		sv, ok := tmuxServerVersionProbe(probeCtx, server)
		probeCancel()
		if !ok || !sv.OlderThan(binary) {
			continue
		}
		notes = append(notes, fmt.Sprintf("tmux %s installed but running server %q is %s — restart your tmux server when convenient to pick it up (kills its sessions; pick a quiet moment)", binary.Raw, server, sv.Raw))
	}
	return notes
}

// tmuxConfigClassify is the seam for the managed-conf classifier — tests
// substitute it to drive every tmux config row state without fixture files.
var tmuxConfigClassify = tmux.ClassifyConfigFile

// tmuxUserOwnedPath is the seam for the user-owned resolution fact — tests
// substitute it to drive the tmux_conf-set branch.
var tmuxUserOwnedPath = tmux.UserOwnedConfigPath

// tmuxConfigCheck reports the managed tmux.conf's ownership/drift state.
// Always OK-shaped (the ephemeral/drift posture — the row is informational and
// must never flip the overall verdict); the note carries the state and, for
// drifted files, the migration recipe. Read-only: doctor diagnoses, it never
// migrates. When tmux_conf/RK_TMUX_CONF points rk at a user path, rk performs
// no ensure/refresh on it (settings.TmuxConf documents "you own everything"),
// so the row reports user-owned and skips drift analysis. Refresh notes carry
// the pane-creation caveat: history-limit-class options apply only to panes
// created after reload.
func tmuxConfigCheck() doctorCheck {
	check := doctorCheck{Name: "tmux config", OK: true}
	recipe := "move your customizations into ~/.config/hexokit/tmux.d/user.conf, then run `rk mux init-conf --force` to restore the managed file"
	if tmuxUserOwnedPath() {
		check.Note = "user-owned (tmux_conf set) — unmanaged"
		return check
	}
	// No resolvable home dir at init leaves DefaultConfigPath empty — there is
	// no managed path to classify, so report the skip instead of feeding "" to
	// the classifier (whose read error would render as a confusing
	// "state unreadable" note).
	if tmux.DefaultConfigPath == "" {
		check.Note = "skipped — home directory not resolvable, no managed path"
		return check
	}
	// A legacy ~/.rk/tmux.conf the migration deliberately left behind (not
	// byte-equal to the embed, so possibly hand-edited) outranks the new
	// path's state: its content is the one at risk of being forgotten.
	if home, err := os.UserHomeDir(); err == nil {
		legacy := filepath.Join(home, ".rk", "tmux.conf")
		if _, err := os.Stat(legacy); err == nil {
			check.Note = fmt.Sprintf("old config still at %s — %s", legacy, recipe)
			return check
		}
	}
	state, err := tmuxConfigClassify(tmux.DefaultConfigPath)
	if err != nil {
		check.Note = fmt.Sprintf("state unreadable: %v", err)
		return check
	}
	switch state {
	case tmux.ConfManagedCurrent:
		check.Note = "managed, current"
	case tmux.ConfManagedStale:
		check.Note = "managed, stale — refreshes on next daemon start (history-limit-class options apply only to panes created after the reload)"
	case tmux.ConfMissing:
		check.Note = "not written yet — scaffolds on next daemon start or via `rk mux init-conf`"
	default: // hand-edited
		check.Note = "hand-edited — rk leaves it untouched; " + recipe
	}
	return check
}

// guiCheck reports the GUI surface's state: off (the default), on+reachable
// with the resolved backend/display/geometry/viewer count/window manager and
// the resolution pin — the geometry segment carries the gui.geometry setting's
// fixed/auto marker next to the probe's live WxH (a bare display appends the
// install hint — doctor is the diagnostic surface; 'rk gui status' keeps the
// bare 'no window manager') — or on+not-running with the fixed reason set
// (gui.NotRunningReason owns the strings). Always OK-shaped — the code-server
// posture: a missing or down desktop is a note, never a verdict flipper. Pure
// over the injected inputs so tests never touch tmux, the probe, or PATH.
func guiCheck(enabled, session bool, display, backend, wm, geometry string, probe gui.Info, viewers int, locked bool, lookPath func(string) (string, error)) doctorCheck {
	check := doctorCheck{Name: "gui", OK: true}
	if !enabled {
		check.Note = "off"
		return check
	}
	if probe.Reachable {
		bin := backend
		if bin == "" {
			bin, _ = gui.ResolveBackend(lookPath)
		}
		if wm == "" {
			wm = "no window manager"
			// Empty off Linux — the darwin mirror runs no WM, so no hint.
			if hint := gui.WMInstallHint(lookPath); hint != "" {
				wm += " — " + hint
			}
		}
		check.Note = guiOnSummary(bin, display, probe.Width, probe.Height, geometry, viewers, wm, locked)
		return check
	}
	check.Note = "on — not running (" + gui.NotRunningReason(session, backend, lookPath) + ")"
	return check
}

// guiDoctorCheck gathers the live facts for the gui row. Every tmux read is
// gated on the daemon running — a has-session probe on a dead rk-daemon
// socket would birth a tmux server; with the daemon down the row reads as
// session-absent.
func guiDoctorCheck() doctorCheck {
	st := settings.Load()
	if !st.GUIEnabled {
		return guiCheck(false, false, "", "", "", "", gui.Info{}, 0, false, guiLookPathFn)
	}
	if !guiDaemonRunningFn() {
		return guiCheck(true, false, "", "", "", "", gui.Info{}, 0, false, guiLookPathFn)
	}
	ctx, cancel := context.WithTimeout(context.Background(), tmux.TmuxTimeout)
	defer cancel()
	session := guiSessionExistsFn(ctx)
	display, backend, wm := "", "", ""
	locked := false
	if session {
		display, backend, wm, _ = guiSessionOptionsFn(ctx)
		locked = guiLockedFn(ctx)
	}
	var info gui.Info
	if session {
		if network, addr, err := gui.BackendAddr(daemon.GUIWindowName); err == nil {
			info, _ = guiProbeFn(ctx, network, addr)
		}
	}
	return guiCheck(true, session, display, backend, wm, st.GUIGeometry, info, guiViewersFn(), locked, guiLookPathFn)
}

// dialTCP is the production reachability probe for the code-server doctor row:
// a bare TCP dial of 127.0.0.1:{port}, mirroring the SSE hub's probe shape.
func dialTCP(addr string) bool {
	conn, err := net.DialTimeout("tcp", addr, 400*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// codeServerCheck reports the daemon-managed code-server's state: install
// source (rk-managed under ~/.rk/code-server-bin, else a user-managed PATH
// install), the resolved port (preset RK_CODE_SERVER_PORT, else RK_PORT+2),
// and reachability. Pure over an injected (home, lookPath, dial) triple so
// tests never depend on the host. Never OK=false — absence is the WARN case
// (the daemon warns and continues without it, spawning the install job), so
// the row carries a remediation Note.
func codeServerCheck(home string, lookPath func(string) (string, error), dial func(string) bool) doctorCheck {
	port := config.Load().ResolvedCodeServerPort()
	check := doctorCheck{Name: "code-server", OK: true}
	// A degenerate config (RK_PORT whose +2 leaves 1-65535, no valid override)
	// resolves to 0 — the feature is off, so report that rather than probing
	// the meaningless 127.0.0.1:0. Mirrors the /code route's 503 branch.
	if port == 0 {
		check.Note = "port not resolvable — RK_PORT+2 falls outside 1-65535 and no valid RK_CODE_SERVER_PORT is set, so /code/ is off (lower RK_PORT or set RK_CODE_SERVER_PORT)"
		return check
	}
	reachability := func() string {
		if dial(fmt.Sprintf("127.0.0.1:%d", port)) {
			return fmt.Sprintf("reachable on 127.0.0.1:%d", port)
		}
		return fmt.Sprintf("not currently reachable on 127.0.0.1:%d (the daemon starts it on `rk daemon start`)", port)
	}
	// The managed rung mirrors the daemon's resolution ladder: the rk-owned
	// install wins over a PATH install when both exist.
	if home != "" {
		if managed := codeserver.ManagedBinary(home); managed != "" {
			version, err := codeserver.InstalledVersion(home)
			if err != nil || version == "" {
				version = "unknown"
			}
			check.Note = fmt.Sprintf("managed v%s; %s", version, reachability())
			return check
		}
	}
	if _, err := lookPath("code-server"); err != nil {
		check.Note = fmt.Sprintf("not installed — the daemon-managed editor behind /code/ is unavailable (resolved port :%d; the daemon installs it automatically on start, or run `rk code-server install`)", port)
		return check
	}
	check.Note = "installed (PATH); " + reachability()
	return check
}

// codeBridgeEmbeddedVersion / codeBridgeLiveHostCount are the seams for the
// code bridge row's production inputs — tests substitute them so
// runDoctorChecks never touches the real embed dir or state dir. The version
// is "" when the build carries no VSIX (a dev build — the row then omits the
// bundled-is-newer clause); the host count is the same liveness-pruning
// enumeration `rk code hosts` performs.
var codeBridgeEmbeddedVersion = func() string {
	_, version, ok := codebridge.Embedded()
	if !ok {
		return ""
	}
	return version
}
var codeBridgeLiveHostCount = func() (int, error) {
	// Bounded: each ping is capped inside LiveHostsMerged and the sweep as a
	// whole gets a ceiling so doctor never hangs on a dead socket.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	live, _, err := codebridge.LiveHostsMerged(ctx)
	if err != nil {
		return 0, err
	}
	return len(live), nil
}

// codeBridgeCheck reports the rk-code-bridge extension's state: not installed
// (a remediation note), else the installed version and live host count, plus
// a bundled-is-newer clause when the embedded VSIX is ahead. Always OK-shaped
// — the bridge is optional tooling, never a dependency failure. Pure over the
// injected (extensionsDir, embeddedVersion, listHosts) triple so tests never
// touch the real state dir.
func codeBridgeCheck(extensionsDir string, embeddedVersion string, listHosts func() (int, error)) doctorCheck {
	check := doctorCheck{Name: "code bridge", OK: true}
	installed, err := codeserver.InstalledBridgeVersion(extensionsDir)
	if err != nil {
		check.Note = fmt.Sprintf("state unreadable: %v", err)
		return check
	}
	if installed == "" {
		check.Note = "not installed — run rk code-server install"
		return check
	}
	n, err := listHosts()
	if err != nil {
		check.Note = fmt.Sprintf("installed v%s; live host count unavailable — enumeration failed: %v", installed, err)
	} else {
		check.Note = fmt.Sprintf("installed v%s; %d live host(s)", installed, n)
	}
	if embeddedVersion != "" && codebridge.OlderThan(installed, embeddedVersion) {
		check.Note += fmt.Sprintf("; bundled v%s is newer — run rk code-server update", embeddedVersion)
	}
	return check
}

// tmuxGuardShimCheck reports the tmux guard shim's install state (see
// tmux_guard.go / agent_setup.go). The shim is OPTIONAL — an absent shim is a
// passing check with an informational note, never a failure; a marker-less
// file at the shim path is a USER file, not an installed shim, and reads as
// not-installed too (ownership is verified via tmuxShimMarker, mirroring
// `rk agent setup`). The check fails on the mis-wired states: a file at the shim
// path exists but cannot be read (exec.LookPath can still resolve it, so tmux
// commands may be dying against a file doctor cannot vouch for), the shim's
// EMBEDDED rk path no longer exists (a dangling binary — the brew rk→run-kit
// rename shape — makes every tmux command on the machine stall through the
// shim's ~3s probe budget and then run UNGUARDED, while the shim file itself
// looks installed), the shim is installed but `tmux` no longer resolves to it
// (a PATH-ordering regression — the guard is silently bypassed), or `tmux`
// resolves to the shim but NO real tmux exists behind it (findRealTmux fails —
// every guarded tmux call would die at exec time). Pure over an injected
// (home, pathEnv, lookPath) triple so tests never depend on the host PATH.
func tmuxGuardShimCheck(home, pathEnv string, lookPath func(string) (string, error)) doctorCheck {
	check := doctorCheck{Name: "tmux-guard shim", failLabel: "tmux-guard shim", OK: true}
	shimPath := tmuxShimPath(home)
	content, exists, err := readFileIfExists(shimPath)
	if err != nil {
		// NOT the absent case: a file EXISTS at the shim path but cannot be
		// read. PATH resolution does not need read permission, so this file
		// may be fronting every tmux invocation — folding it into the
		// optional "not installed" OK note would let doctor exit 0 on a
		// machine where every tmux command fails.
		check.OK = false
		check.Hint = fmt.Sprintf("unreadable file at %s (%v) — PATH may still resolve tmux to it; fix its permissions (chmod 0755) or remove it, then re-run `rk doctor`", shimPath, err)
		return check
	}
	if !exists {
		check.Note = "not installed (optional — install with `rk agent setup`)"
		return check
	}
	if !strings.Contains(content, tmuxShimMarker) {
		check.Note = fmt.Sprintf("not installed (a non-rk file occupies %s — rk only recognizes shims it owns)", shimPath)
		return check
	}
	// The shim is only as alive as the rk binary its exec line names: verify
	// the embedded target is still a regular executable file before vouching
	// for the install. The dangling case is real (the recorded brew
	// rk→run-kit rename left a shim exec'ing a removed keg path) and is the
	// single most damaging mis-wiring — the shim's probe budget cannot outwait
	// a PERMANENTLY dangling path, so every tmux command on the machine pays
	// ~3s and then falls open to an unguarded run, while the shim file itself
	// looks healthy. A directory or non-executable file at the target degrades
	// every shimmed invocation the same way, so bare existence is not enough.
	target := tmuxShimExecTarget(content)
	if target == "" {
		check.OK = false
		check.Hint = fmt.Sprintf("shim at %s carries no parseable exec target — re-install it with `rk agent setup`", shimPath)
		return check
	}
	info, statErr := os.Stat(target)
	if statErr != nil {
		check.OK = false
		check.Hint = fmt.Sprintf("shim at %s execs %q, which is missing (%v) — every tmux command would stall ~3s and then run UNGUARDED; re-install the shim with `rk agent setup`", shimPath, target, statErr)
		return check
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		check.OK = false
		check.Hint = fmt.Sprintf("shim at %s execs %q, which is not an executable file (mode %v) — every tmux command would stall ~3s and then run UNGUARDED; re-install the shim with `rk agent setup`", shimPath, target, info.Mode())
		return check
	}
	resolved, err := lookPath("tmux")
	if err != nil {
		check.OK = false
		check.Hint = "shim installed but no tmux resolves on PATH — open a new shell, or check the `rk tmux guard` block in ~/.zshenv"
		return check
	}
	if !doctorSamePath(resolved, shimPath) {
		check.OK = false
		check.Hint = fmt.Sprintf("shim installed at %s but PATH resolves tmux to %s — the shims dir must precede it (check the `rk tmux guard` block in ~/.zshenv, then open a new shell)", shimPath, resolved)
		return check
	}
	// The shim only fronts the real tmux — confirm one actually exists behind
	// it, or every guarded tmux invocation dies at exec time.
	if _, err := findRealTmux(pathEnv, rkShimsDir(home)); err != nil {
		check.OK = false
		check.Hint = "PATH resolves tmux to the shim but no real tmux exists behind it — every tmux command will fail; install tmux (or fix PATH), then re-run `rk doctor`"
		return check
	}
	check.Note = "installed; PATH resolves tmux to the shim"
	return check
}

// mcpCheck builds the mcp doctor row from the policy-table resolution result.
// A table that cannot resolve against the live Cobra tree is a defect (a
// renamed or re-flagged verb), so this row is a verdict flipper — unlike the
// always-OK state rows (gui, code-server). Pure over its inputs for tests.
func mcpCheck(n int, err error) doctorCheck {
	if err != nil {
		return doctorCheck{Name: "mcp", OK: false, failLabel: "mcp", Hint: err.Error()}
	}
	return doctorCheck{Name: "mcp", OK: true, Note: fmt.Sprintf("%d tools; all policy rows resolve", n)}
}

// mcpDoctorCheck resolves the shipped policy table in-process (introspection
// only — no exec, no tmux), reports the tool count, and returns the resolved
// count alongside so the mcp route row can quote it without re-resolving (0
// on failure).
func mcpDoctorCheck() (doctorCheck, int) {
	resolved, err := mcp.Resolve(rootCmd, mcp.Table)
	if err != nil {
		return mcpCheck(0, err), 0
	}
	return mcpCheck(len(resolved), nil), len(resolved)
}

// doctorMCPClientTimeout bounds the /mcp route probe's HTTP client;
// doctorMCPBodyCap caps the response body read — the probe keys on the
// status, the body is diagnostic only.
const (
	doctorMCPClientTimeout = 2 * time.Second
	doctorMCPBodyCap       = 1 << 10
)

// doctorHTTPGet is the seam for the mcp route row's live probe (the dialTCP
// idiom): a session-less GET with the SSE accept header — the SDK's stateful
// handler answers it 400 without opening an MCP session, which is the
// "route is mounted" signature. Tests substitute it so runDoctorChecks never
// dials.
var doctorHTTPGet = func(url string) (int, string, error) {
	client := &http.Client{Timeout: doctorMCPClientTimeout}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Accept", "text/event-stream")
	resp, err := client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, doctorMCPBodyCap))
	if err != nil {
		return resp.StatusCode, "", err
	}
	return resp.StatusCode, string(body), nil
}

// mcpRouteCheck classifies a bounded GET <origin>/mcp. The SDK's stateful
// handler answers a session-less GET with 400 ("GET requires an
// Mcp-Session-Id header"), which is the positive signature — no MCP session
// is opened by the probe. Pure over the injected probe so tests never dial.
func mcpRouteCheck(origin string, tools int, get func(url string) (int, string, error)) doctorCheck {
	check := doctorCheck{Name: "mcp route", OK: true}
	status, _, err := get(origin + mcp.HTTPRoutePath)
	switch {
	case err != nil:
		check.Note = fmt.Sprintf("not reachable at %s/mcp — is the daemon running? (rk daemon start)", origin)
	case status == http.StatusNotFound:
		check.Note = fmt.Sprintf("daemon at %s answers 404 for /mcp — it predates the route; restart it (rk daemon restart)", origin)
	case status == http.StatusServiceUnavailable:
		check.Note = "route present but the transport is not configured — the daemon logged why at start (see the mcp row above)"
	case status == http.StatusBadRequest || status == http.StatusMethodNotAllowed || (status >= 200 && status < 300):
		check.Note = fmt.Sprintf("mounted at %s/mcp", origin)
		if tools > 0 {
			check.Note += fmt.Sprintf(" (%d tools)", tools)
		}
	default:
		check.Note = fmt.Sprintf("unexpected %d from %s/mcp", status, origin)
	}
	return check
}

// mcpRouteDoctorCheck is the live wrapper: the caller's resolved origin plus
// the production probe.
func mcpRouteDoctorCheck(ctx context.Context, tools int) doctorCheck {
	return mcpRouteCheck(resolveOrigin(ctx), tools, doctorHTTPGet)
}

// doctorFailLabel returns the human [FAIL] row's lead-in. Pre-existing checks
// fail on absence, so the default stays the historical "<name> not found"; a
// check whose failures are not absences (the shim check fails on mis-wiring)
// supplies its own failLabel instead. The row shape "  [FAIL] <label> —
// <hint>" is shared by every check.
func doctorFailLabel(c doctorCheck) string {
	if c.failLabel != "" {
		return c.failLabel
	}
	return c.Name + " not found"
}

// doctorSamePath reports whether two paths name the same file after symlink
// evaluation (falling back to lexical cleaning when resolution fails).
func doctorSamePath(a, b string) bool {
	resolve := func(p string) string {
		if r, err := filepath.EvalSymlinks(p); err == nil {
			return r
		}
		return filepath.Clean(p)
	}
	return resolve(a) == resolve(b)
}

var doctorCmd = &cobra.Command{
	Use:   "doctor",
	Short: "Check runtime dependencies",
	RunE: func(cmd *cobra.Command, args []string) error {
		report := runDoctorChecks()
		sink := newSink(cmd)

		if doctorJSON {
			var reportErr error
			if !report.OK {
				reportErr = fmt.Errorf("one or more dependency checks failed")
			}
			return sink.Envelope(report, reportErr)
		}

		// Human diagnostic output goes to stderr (Principle 2: this is status,
		// not the data a machine consumer parses — that is the --json path).
		// Under --quiet (Principle 9) the banner, [ OK ] rows, and success tail
		// are chatter and drop; [FAIL] rows carry the remediation hint (actionable
		// error detail) and MUST survive, so they write to ungated stderr.
		stderr := cmd.ErrOrStderr()
		sink.Notef("Checking runtime dependencies...\n")
		for _, c := range report.Checks {
			switch {
			case c.OK && c.Note != "":
				sink.Notef("  [ OK ] %s — %s\n", c.Name, c.Note)
			case c.OK:
				sink.Notef("  [ OK ] %s\n", c.Name)
			default:
				fmt.Fprintf(stderr, "  [FAIL] %s — %s\n", doctorFailLabel(c), c.Hint)
			}
		}
		if !report.OK {
			return fmt.Errorf("one or more dependency checks failed")
		}
		sink.Notef("\nAll checks passed.\n")
		return nil
	},
}

func init() {
	doctorCmd.Flags().BoolVar(&doctorJSON, "json", false, "Emit the dependency report as JSON to stdout, wrapped in the {\"ok\",\"result\"} envelope")
}

// --- agent hooks check -----------------------------------------------------

// classifyHookGeneration classifies an rk-owned hook command by its marker:
// 1 = the retired self-contained one-liner (inlines LegacyAgentStateOption),
// 2 = the delegating ` agent-hook ` root form, 3 = the delegating
// ` agent hook ` family form. 0 means no marker matched (an rk entry with an
// unrecognized command shape).
func classifyHookGeneration(cmd string) int {
	switch {
	case strings.Contains(cmd, rkHookMarker):
		return 1
	case strings.Contains(cmd, rkHookMarkerAgentHook):
		return 2
	case strings.Contains(cmd, rkHookMarkerAgentHookFamily):
		return 3
	}
	return 0
}

// hookRkPaths extracts every rk binary path embedded in a gen-3 hook command —
// the double-quoted token immediately before each ` agent hook ` invocation
// marker. A fourth-generation wrapper carries TWO invocations (launcher first,
// stable fallback second); a third-generation one carries one. Empty when the
// command carries none.
func hookRkPaths(cmd string) []string {
	var paths []string
	rest := cmd
	for {
		idx := strings.Index(rest, rkHookMarkerAgentHookFamily)
		if idx < 0 {
			return paths
		}
		head := rest[:idx]
		if end := strings.LastIndex(head, `"`); end >= 0 {
			if start := strings.LastIndex(head[:end], `"`); start >= 0 {
				paths = append(paths, head[start+1:end])
			}
		}
		rest = rest[idx+len(rkHookMarkerAgentHookFamily):]
	}
}

// agentHooksCheck reports the rk-owned agent-hooks install state across EVERY
// agent in the registry: which hook generations are installed per agent and
// whether a gen-3 entry's embedded rk path still resolves to an executable.
// The hooks are OPTIONAL — agents with no rk artifacts are a passing check with
// an informational note. The check fails when any gen-1/gen-2 entry survives
// (those write the retired option names — the dual-read window absorbs them,
// but the stale entries are what keep the window open), when a gen-3 entry's
// embedded rk path dangles (the hook fires and writes nothing, silently), or
// when an rk-owned artifact is unreadable/malformed. Pure over an injected
// (home, readFile, stat) triple in the tmuxGuardShimCheck style so tests never
// depend on the host.
func agentHooksCheck(home string, readFile func(string) ([]byte, error), stat func(string) (os.FileInfo, error)) doctorCheck {
	check := doctorCheck{Name: "agent hooks", failLabel: "agent hooks", OK: true}
	var installed []string
	var notes []string
	for _, agent := range agentRegistry(home) {
		st, failHint, note := agentHooksStatus(agent, readFile, stat)
		if failHint != "" {
			check.OK = false
			check.Hint = failHint
			return check
		}
		if st {
			installed = append(installed, agent.provider)
		}
		if note != "" {
			notes = append(notes, fmt.Sprintf("%s: %s", agent.name, note))
		}
	}
	if len(installed) == 0 {
		check.Note = "not installed (optional — install with `rk agent setup`)"
		return check
	}
	check.Note = fmt.Sprintf("installed (generation 3): %s; writes %s + %s", strings.Join(installed, ", "), tmux.AgentStateOption, tmux.LegacyAgentStateOption)
	if len(notes) > 0 {
		check.Note += " — " + strings.Join(notes, "; ")
	}
	return check
}

// agentHooksStatus reports whether one registry agent has rk-owned hooks
// installed, returning a failure hint when the agent's artifacts are present
// but broken (stale generation, every embedded rk path dangling,
// unreadable/malformed file) and an advisory note when they pass with a
// caveat (a partially dangling two-path wrapper, a single-path gen-3 wrapper).
// Absent artifacts are (false, "", "") — the hooks are optional.
func agentHooksStatus(agent agentConfig, readFile func(string) ([]byte, error), stat func(string) (os.FileInfo, error)) (installed bool, failHint, note string) {
	switch agent.kind {
	case kindMarkerFile:
		return markerFileHooksStatus(agent, readFile, stat)
	case kindMarkerBlock:
		return markerBlockHooksStatus(agent, readFile, stat)
	default:
		return jsonHooksStatus(agent, readFile, stat)
	}
}

// jsonHooksStatus classifies the rk-owned entries of a kindJSONHooksMerge
// agent's settings file. claude/codex/gemini carry the nested shape under a
// "hooks" root; agy's named-hooks document IS the root (walked whole). The
// recursive command walk collects every "command" string in the relevant
// subtree, so both shapes classify through the same generation markers.
func jsonHooksStatus(agent agentConfig, readFile func(string) ([]byte, error), stat func(string) (os.FileInfo, error)) (bool, string, string) {
	data, err := readFile(agent.settingsPath)
	if err != nil {
		if os.IsNotExist(err) {
			return false, "", ""
		}
		// A present-but-unreadable settings file is NOT the absent case: the
		// hooks it carries may be firing (or failing) on every turn while
		// doctor cannot vouch for them.
		return false, fmt.Sprintf("%s: unreadable settings file at %s (%v) — fix its permissions or remove it, then re-run `rk doctor`", agent.name, agent.settingsPath, err), ""
	}
	var settings map[string]any
	if err := json.Unmarshal(data, &settings); err != nil {
		return false, fmt.Sprintf("%s: settings file at %s is not parseable JSON (%v) — fix it, then re-run `rk doctor`", agent.name, agent.settingsPath, err), ""
	}
	root := any(asMap(settings["hooks"]))
	if agent.namedHooksDoc {
		root = settings
	}
	var stale, gen3 int
	staleGen := 0
	note := ""
	for _, cmd := range walkJSONCommands(root) {
		switch gen := classifyHookGeneration(cmd); gen {
		case 1, 2:
			stale++
			if staleGen == 0 || gen < staleGen {
				staleGen = gen
			}
		case 3:
			gen3++
			hint, n := checkHookRkPath(agent, agent.settingsPath, cmd, stat)
			if hint != "" {
				return false, hint, ""
			}
			if note == "" {
				note = n
			}
		}
	}
	if stale > 0 {
		noun := "entries"
		if stale == 1 {
			noun = "entry"
		}
		return false, fmt.Sprintf("%s: %d stale hook %s in %s (generation %d) — they write legacy option names; re-run `rk agent setup` to replace them", agent.name, stale, noun, agent.settingsPath, staleGen), ""
	}
	if agent.namedHooksDoc {
		_, ok := settings[rkNamedHookKey]
		return ok, "", note
	}
	return gen3 > 0, "", note
}

// walkJSONCommands collects every "command" string value in a JSON-shaped
// tree — one walk covering the nested hooks→Event→[].hooks[] shape and agy's
// named flat handler arrays alike. Non-marker commands classify as generation
// 0 downstream and are ignored.
func walkJSONCommands(v any) []string {
	var out []string
	switch t := v.(type) {
	case map[string]any:
		for key, val := range t {
			if key == "command" {
				if s, ok := val.(string); ok {
					out = append(out, s)
				}
				continue
			}
			out = append(out, walkJSONCommands(val)...)
		}
	case []any:
		for _, e := range t {
			out = append(out, walkJSONCommands(e)...)
		}
	}
	return out
}

// markerFileHooksStatus checks a kindMarkerFile agent (copilot/opencode): the
// marker-owned file exists, and every embedded rk hook command's path resolves
// to an executable.
func markerFileHooksStatus(agent agentConfig, readFile func(string) ([]byte, error), stat func(string) (os.FileInfo, error)) (bool, string, string) {
	data, err := readFile(agent.filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return false, "", ""
		}
		return false, fmt.Sprintf("%s: unreadable hooks file at %s (%v) — fix its permissions or remove it, then re-run `rk doctor`", agent.name, agent.filePath, err), ""
	}
	content := string(data)
	if !markerFileOwned(content) {
		// A foreign marker-less file at the path is not an rk install.
		return false, "", ""
	}
	note := ""
	for _, cmd := range extractRkHookCommands(content) {
		hint, n := checkHookRkPath(agent, agent.filePath, cmd, stat)
		if hint != "" {
			return false, hint, ""
		}
		if note == "" {
			note = n
		}
	}
	return true, "", note
}

// markerBlockHooksStatus checks a kindMarkerBlock agent (kimi): the
// marker-owned block is present and well-formed, and its embedded rk paths
// resolve. A malformed block (begin without end, or a duplicated begin) fails
// with the repair hint rather than being guessed at.
func markerBlockHooksStatus(agent agentConfig, readFile func(string) ([]byte, error), stat func(string) (os.FileInfo, error)) (bool, string, string) {
	data, err := readFile(agent.blockPath)
	if err != nil {
		if os.IsNotExist(err) {
			return false, "", ""
		}
		return false, fmt.Sprintf("%s: unreadable config at %s (%v) — fix its permissions, then re-run `rk doctor`", agent.name, agent.blockPath, err), ""
	}
	begin, end, _ := agent.blockContent("", "")
	lines := strings.Split(string(data), "\n")
	start, stop, found, blockErr := markerBlockBounds(lines, begin, end)
	if blockErr != nil {
		return false, fmt.Sprintf("%s: %s: %v — repair or remove the block by hand, then re-run `rk agent setup`", agent.name, agent.blockPath, blockErr), ""
	}
	if !found {
		return false, "", ""
	}
	note := ""
	for _, line := range lines[start : stop+1] {
		if cmd, ok := kimiBlockCommand(line); ok {
			hint, n := checkHookRkPath(agent, agent.blockPath, cmd, stat)
			if hint != "" {
				return false, hint, ""
			}
			if note == "" {
				note = n
			}
		}
	}
	return true, "", note
}

// checkHookRkPath checks every rk path embedded in a gen-3 hook command. It
// FAILS only when every embedded path dangles (the hook fires and writes
// nothing on both paths). A partially dangling two-path wrapper passes with a
// note — a dangling launcher is the expected state between brew cleanup and
// the daemon's next re-point, so failing on it would page for a self-healing
// condition; the same holds for a dangling stable path behind a live launcher.
// A single-path (third-generation) wrapper passes with the re-run note: it
// works, but lacks the launcher fallback.
func checkHookRkPath(agent agentConfig, path, cmd string, stat func(string) (os.FileInfo, error)) (failHint, note string) {
	paths := hookRkPaths(cmd)
	if len(paths) == 0 {
		return "", ""
	}
	live := make([]bool, len(paths))
	liveCount := 0
	for i, p := range paths {
		info, statErr := stat(p)
		if statErr == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0 {
			live[i] = true
			liveCount++
		}
	}
	if liveCount == 0 {
		return fmt.Sprintf("%s: gen-3 hook in %s execs %s, none of which is an existing regular executable — hooks fire and write nothing; re-run `rk agent setup`", agent.name, path, quotedList(paths)), ""
	}
	if len(paths) == 1 {
		return "", "single-path wrapper — re-run `rk agent setup` to add the launcher fallback"
	}
	for i, p := range paths {
		if live[i] {
			continue
		}
		if i == 0 {
			return "", fmt.Sprintf("launcher %s dangling — re-run `rk agent setup`", p)
		}
		return "", fmt.Sprintf("stable path %s dangling — re-run `rk agent setup`", p)
	}
	return "", ""
}

// quotedList renders paths as `"a", "b"` for a failure hint.
func quotedList(paths []string) string {
	quoted := make([]string, len(paths))
	for i, p := range paths {
		quoted[i] = fmt.Sprintf("%q", p)
	}
	return strings.Join(quoted, ", ")
}

// extractRkHookCommands returns the rk hook command strings from raw file
// content: the JSON form (copilot's `"command": "..."` values) and the JS
// plugin's `const RK = "<path>"` / `const RK_FALLBACK = "<path>"` consts,
// from which one synthetic two-path command is built. The scan keys on the
// ` agent hook ` / ` agent-hook ` invocation markers — the same ownership
// signal markerFileOwned uses.
// opencodeMissingRKConst is the sentinel path extractRkHookCommands reports
// for a plugin file whose `const RK` line is missing; it can never stat, so
// checkHookRkPath fails the row and names it.
const opencodeMissingRKConst = "<missing const RK>"

func extractRkHookCommands(content string) []string {
	var cmds []string
	var doc map[string]any
	if json.Unmarshal([]byte(content), &doc) == nil {
		for _, ev := range asMap(doc["hooks"]) {
			for _, e := range asSlice(ev) {
				entry := asMap(e)
				if cmd, ok := entry["command"].(string); ok &&
					(strings.Contains(cmd, rkHookMarkerAgentHook) || strings.Contains(cmd, rkHookMarkerAgentHookFamily)) {
					cmds = append(cmds, cmd)
				}
			}
		}
		return cmds
	}
	// Non-JSON (the opencode plugin): the binary paths sit in the RK and
	// RK_FALLBACK consts. They are combined into ONE synthetic two-invocation
	// command so the dangling-path semantics (fail only when both dangle) match
	// the shell wrappers the plugin mirrors.
	var rk, rkFallback string
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if rest, ok := strings.CutPrefix(line, `const RK = "`); ok {
			if p, ok := strings.CutSuffix(rest, `";`); ok {
				rk = p
			}
		}
		if rest, ok := strings.CutPrefix(line, `const RK_FALLBACK = "`); ok {
			if p, ok := strings.CutSuffix(rest, `";`); ok {
				rkFallback = p
			}
		}
	}
	switch {
	case rk != "" && rkFallback != "":
		cmds = append(cmds, fmt.Sprintf(`; "%s" agent hook x || "%s" agent hook `, rk, rkFallback))
	case rk != "":
		cmds = append(cmds, fmt.Sprintf(`; "%s" agent hook `, rk))
	case rkFallback != "":
		// An rk-owned plugin with RK_FALLBACK but no RK (truncated or
		// hand-edited): report() calls the missing RK first and swallows the
		// exception, so no hook ever writes. Surface it as a dangling path
		// rather than letting an empty extraction read healthy.
		cmds = append(cmds, fmt.Sprintf(`; "%s" agent hook `, opencodeMissingRKConst))
	}
	return cmds
}

// kimiBlockCommand extracts the command value from a `command = "..."` TOML
// line inside the kimi marker block, undoing tomlBasicString's escaping.
func kimiBlockCommand(line string) (string, bool) {
	line = strings.TrimSpace(line)
	rest, ok := strings.CutPrefix(line, `command = "`)
	if !ok {
		return "", false
	}
	val, ok := strings.CutSuffix(rest, `"`)
	if !ok {
		return "", false
	}
	var b strings.Builder
	for i := 0; i < len(val); i++ {
		if val[i] == '\\' && i+1 < len(val) {
			i++
		}
		b.WriteByte(val[i])
	}
	return b.String(), true
}
