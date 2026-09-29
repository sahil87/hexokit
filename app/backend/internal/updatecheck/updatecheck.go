// Package updatecheck periodically asks `shll check-updates` which shll-toolkit
// tools (run-kit and its siblings) have a newer release, and caches the verdict
// in memory, firing a callback whenever the set of notable tools changes.
//
// The check itself is DELEGATED: one exec of `shll check-updates --json`
// per pass replaces the former manifest HTTP fetch, `brew list --versions`
// join, and sibling threshold evaluation (Constitution III — wrap, don't
// reinvent). The AMBIENT loop passes no backend flag (`released` is shll's
// default, so the invocation is valid across every shll version carrying
// `check-updates` and is decoupled from backend-flag evolution); that
// no-backend-flag posture applies to the RELEASED path only — a manual check
// may request the GitHub backend (SourceGithub → the literal `--source github`
// argv pair), which runs as a SIDE-CHANNEL query: exec + verdict computation +
// returned Result, but NO cache write and NO OnQualify fire, so the chip, the
// dismissal key, and the scoped `shll update` argv stay bound to the
// notify-policy-bearing released source (the github contract carries no
// notify/notable fields at all — every row lands notable=false).
// Per-tool verdicts (`update_available`, `notable`) are
// consumed verbatim from shll's JSON for every sibling tool; only run-kit's own
// row is re-compared locally, because shll can only see the brew-installed
// version — not the version this daemon is actually running (ldflags).
//
// The checker suppresses itself entirely when the running version is the "dev"
// sentinel or unparseable (a dev build never checks, which also keeps e2e runs
// off the toolchain).
//
// State is derived and ephemeral (Constitution II — no database, no file): the
// latest verdict lives in an in-memory struct guarded by a mutex. Failure
// posture (ambient loop): when `shll` is not on PATH, exits non-zero, or emits
// unparseable/wrong-schema JSON, the pass is skipped silently and the previous
// verdict is retained (stale-while-revalidate) — no fallback fetch, no error
// surfaced to clients. The MANUAL path (CheckNow, driving POST
// /api/updates/check) surfaces the same failure as an error so a deliberate
// invocation gets an honest answer.
package updatecheck

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os/exec"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// selfToolName is the roster name shll (>= v0.1.34) reports for this
	// binary's own row — the one row compared against the RUNNING ldflags
	// version (not the brew-visible version shll reports) and gated on this
	// binary being a brew install.
	selfToolName = "hexokit"
	// checkTimeout bounds the `shll check-updates` exec (Constitution I). One
	// subprocess wraps a network fetch plus brew reads, so it gets the
	// constitution's 30s build-op tier rather than the 10s tmux tier.
	checkTimeout = 30 * time.Second
	// initialCheckDelay is how long after startup the first check runs, so it
	// never competes with boot.
	initialCheckDelay = 30 * time.Second
	// checkInterval is the steady-state cadence. ~4 checks/day.
	checkInterval = 6 * time.Hour
	// devVersion is the sentinel for local (non-ldflags) builds — the checker is
	// suppressed for it (matches cmd/rk/root.go's `version = "dev"`).
	devVersion = "dev"
	// checkUpdatesSchema is the `schema` value this caller understands. A report
	// with any other value is a failed check (fail-closed on contract drift).
	checkUpdatesSchema = 1

	// notify policy values carried verbatim in shll's report — consumed only for
	// the run-kit row's LOCAL threshold evaluation (sibling verdicts arrive
	// pre-evaluated).
	notifyNever = "never"
	notifyPatch = "patch"
	notifyMinor = "minor"
)

// Check-backend source values. The handler maps the request body onto this
// closed enum; nothing user-controlled ever reaches argv (Constitution I) —
// checkUpdatesArgs appends the literal `--source github` pair only for the
// validated SourceGithub value.
const (
	// SourceReleased is the default released-manifest backend. The zero value:
	// no `--source` flag is passed, keeping the ambient invocation valid across
	// every shll version carrying `check-updates`.
	SourceReleased = ""
	// SourceGithub selects shll's GitHub release-tags backend (fresh, no notify
	// policy). A github check is a side-channel query — see checkOnce.
	SourceGithub = "github"
)

// selfToolLegacyNames are the roster names older shll releases (< v0.1.34)
// report for the same row. Mirrors shll's own LegacyNames for the tool, so the
// self row is still recognized while a box runs a pre-rename shll.
var selfToolLegacyNames = []string{"rk", "run-kit"}

// isSelfTool reports whether a roster name is this binary's own row.
func isSelfTool(name string) bool {
	return name == selfToolName || slices.Contains(selfToolLegacyNames, name)
}

// CheckTool is one tool's entry in the `shll check-updates --json` report
// (vendored contract, schema 1 — see testdata/check-updates.json). A tool is
// listed only when both installed and latest resolve. Unknown sibling fields
// are tolerated by the decoder.
type CheckTool struct {
	// Name is the roster name (e.g. "hexokit", "fab-kit").
	Name string `json:"name"`
	// Formula is the Homebrew formula name (informational to this caller).
	Formula string `json:"formula"`
	// Installed is the brew-visible installed version.
	Installed string `json:"installed"`
	// Latest is the newest published version.
	Latest string `json:"latest"`
	// Notify is the per-tool policy: "never", "patch", or "minor".
	Notify string `json:"notify"`
	// UpdateAvailable reports installed < latest.
	UpdateAvailable bool `json:"update_available"`
	// Notable reports the pending bump crosses the tool's notify threshold.
	Notable bool `json:"notable"`
}

// CheckReport is the decoded `shll check-updates --json` document.
type CheckReport struct {
	Schema int         `json:"schema"`
	Source string      `json:"source"`
	Tools  []CheckTool `json:"tools"`
}

// ToolVerdict is one tool's verdict in the cached result: a tool with a pending
// update (installed < latest), whether or not the bump is notable. Up-to-date
// tools never appear.
type ToolVerdict struct {
	// Tool is the roster name (e.g. "hexokit", "fab-kit").
	Tool string
	// Installed is the version currently installed (the running ldflags version
	// for the self row; shll's brew-visible version for every other tool).
	Installed string
	// Latest is the newest published version for this tool.
	Latest string
	// UpdateAvailable reports installed < latest (always true for a listed
	// verdict — carried explicitly so payload consumers can filter uniformly).
	UpdateAvailable bool
	// Notable reports the pending bump crosses the tool's notify threshold.
	Notable bool
}

// ToolUpdate is one NOTABLE tool in the verdict — the match set that drives the
// chip, the composite dismissal key, and the scoped `shll update` argv.
type ToolUpdate struct {
	// Tool is the roster name (e.g. "hexokit", "fab-kit").
	Tool string
	// Installed is the version currently installed.
	Installed string
	// Latest is the newest published version for this tool.
	Latest string
}

// Result is the cached verdict of the most recent successful check. The zero
// value (empty Tools/Matched, empty Key) is the "no update / not yet checked"
// state.
type Result struct {
	// Tools is the full per-tool verdict list: every tool with a pending update
	// (update_available), INCLUDING sub-threshold (notable=false) rows, in
	// deterministic sorted-name order. Up-to-date tools are omitted — an empty
	// list means everything is current.
	Tools []ToolVerdict
	// Matched lists every NOTABLE tool (the subset of Tools whose bump crosses
	// its notify threshold), in the same sorted-name order. This set drives the
	// chip, the dismissal Key, and the scoped `shll update` argv.
	Matched []ToolUpdate
	// Key is the composite dismissal key: sorted "tool@latest" pairs of the
	// NOTABLE set, comma joined (e.g. "fab-kit@2.17.0,hexokit@3.9.0"). Empty
	// when nothing notable matches.
	Key string
	// Current and Latest are populated from the self row (see isSelfTool) when
	// it is in the notable match set (else empty). Retained for transitional frontend
	// compat — a not-yet-reloaded client keys off a non-empty Latest.
	Current string
	Latest  string
	// Source echoes the report's self-identified backend (CheckReport.Source —
	// e.g. "released" or "github"), propagated to the check response / SSE
	// payload so the client reacts to what actually ran. Empty when the report
	// carried no source (e.g. legacy test stubs).
	Source string
}

// Checker runs `shll check-updates` on a background tick and caches the latest
// verdict.
type Checker struct {
	current    string // running run-kit version (no leading "v")
	selfBrew   bool   // whether THIS run-kit binary is a Homebrew install
	suppressed bool   // true when current is "dev" or unparseable — no check ever runs

	mu     sync.RWMutex
	result Result

	// checkFn returns the decoded `shll check-updates --json` report for the
	// given backend source (SourceReleased or SourceGithub). The default execs
	// the real shll; tests stub it. Kept as a field (not a package var) so
	// parallel tests don't race a shared seam.
	checkFn func(ctx context.Context, source string) (CheckReport, error)

	// OnQualify, when set, is invoked with the new verdict whenever a check
	// changes Key at all — to a non-empty value (first match, re-match after
	// clearing, any newer latest or newly-matching tool) OR to empty (all
	// previously-matched tools became current: the "consumed match" clear). An
	// unchanged key (empty or not) never re-fires. Wired in serve.go to
	// sseHub.broadcastUpdateAvailable. Set before Start.
	OnQualify func(Result)

	// startCtx is the daemon context captured at Start, so a RecheckAfter timer
	// is bound to the daemon lifetime (it dies with the process). nil until
	// Start; RecheckAfter is a no-op before Start or on a suppressed checker.
	startCtx context.Context

	// recheckHook, when set (SetRecheckHookForTest), replaces RecheckAfter's real
	// scheduling with a delay-recording hook for cross-package handler tests.
	recheckHook func(time.Duration)
}

// New constructs a Checker for the given running run-kit version and its own
// brew-install status. The version is normalized (leading "v" stripped). When
// the version is the "dev" sentinel or does not parse as X.Y.Z, the checker is
// permanently suppressed: Start is a no-op and Snapshot always reports no update.
func New(current string, selfBrew bool) *Checker {
	norm := normalizeTag(current)
	c := &Checker{current: norm, selfBrew: selfBrew}
	c.result = Result{}
	if current == devVersion {
		c.suppressed = true
	} else if _, _, err := parseMajorMinor(norm); err != nil {
		c.suppressed = true
	}
	c.checkFn = defaultCheck
	return c
}

// Snapshot returns the current cached verdict. The returned Result shares its
// slices with the checker; callers MUST NOT mutate them.
func (c *Checker) Snapshot() Result {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.result
}

// Suppressed reports whether this checker is permanently suppressed (dev or
// unparseable running version). Exposed so the /api/updates/check handler can
// map suppression to its own status code instead of a generic check failure.
func (c *Checker) Suppressed() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.suppressed
}

// Start launches the background poll goroutine: an initial check after
// initialCheckDelay, then a fixed checkInterval ticker, exiting on ctx.Done().
// A suppressed checker (dev/unparseable running version) is a no-op.
func (c *Checker) Start(ctx context.Context) {
	c.mu.Lock()
	suppressed := c.suppressed
	c.startCtx = ctx
	c.mu.Unlock()
	if suppressed {
		slog.Info("update checker suppressed", "version", c.current)
		return
	}
	go func() {
		select {
		case <-ctx.Done():
			return
		case <-time.After(initialCheckDelay):
		}
		c.checkOnce(ctx, SourceReleased)

		ticker := time.NewTicker(checkInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				c.checkOnce(ctx, SourceReleased)
			}
		}
	}()
}

// CheckNow runs one immediate synchronous check pass against the given backend
// source and returns the fresh verdict. For SourceReleased it is the SAME code
// path the ambient loop uses (exec + verdict update + OnQualify on key change);
// for SourceGithub it is a SIDE-CHANNEL query (exec + verdict computation +
// returned Result, no cache write, no OnQualify — see checkOnce). It is the
// seam behind POST /api/updates/check: on failure (shll missing / non-zero
// exit / unparseable or wrong-schema JSON) the previous verdict is retained and
// the error is returned so a MANUAL check can surface it, while the ambient
// loop ignores the same error (fail-silent). A suppressed checker returns an
// error without checking.
func (c *Checker) CheckNow(ctx context.Context, source string) (Result, error) {
	if c.Suppressed() {
		return Result{}, fmt.Errorf("update checks are suppressed for this build")
	}
	return c.checkOnce(ctx, source)
}

// checkOnce performs one exec + verdict pass for the given backend source. On
// the released path it updates the cached verdict and fires OnQualify when the
// composite Key changes at all (including to empty). Any OTHER source is a
// side-channel query: the computed Result is returned WITHOUT touching the
// shared cache or firing OnQualify — the github contract carries no
// notify/notable fields (every row lands notable=false via the fail-closed
// threshold), so caching it would wipe a legit released chip (Key→"" clear
// broadcast) and 409 the scoped `shll update` (which reads Snapshot().Matched).
// On a failed check it logs a warning, retains the previous verdict
// (stale-while-revalidate), and returns the error for the manual path — the
// ambient callers ignore it.
func (c *Checker) checkOnce(ctx context.Context, source string) (Result, error) {
	c.mu.RLock()
	checkFn := c.checkFn
	c.mu.RUnlock()

	checkCtx, cancel := context.WithTimeout(ctx, checkTimeout)
	defer cancel()

	report, err := checkFn(checkCtx, source)
	if err != nil {
		slog.Warn("update check failed (retaining previous result)", "err", err)
		return Result{}, err
	}

	verdicts := c.computeVerdicts(report)
	matched := notableSet(verdicts)
	key := computeKey(matched)
	current, latest := runKitFields(matched)
	newResult := Result{Tools: verdicts, Matched: matched, Key: key, Current: current, Latest: latest, Source: report.Source}

	if source != SourceReleased {
		// Side-channel query: return the fresh verdict without converging the
		// cached released verdict or broadcasting.
		return newResult, nil
	}

	c.mu.Lock()
	prevKey := c.result.Key
	c.result = newResult
	onQualify := c.OnQualify
	c.mu.Unlock()

	// Fire whenever the key CHANGES at all: to a non-empty value (first match,
	// re-match after clearing, a newer latest, or a newly-matching tool) OR to
	// empty (all previously-matched tools became current — the consumed-match
	// clear). An unchanged key (empty or not) must NOT re-fire. The cleared
	// verdict is first-class: it broadcasts + replaces the cached SSE slot so a
	// reconnecting/new tab never replays a stale consumed match (R7/R8).
	if key != prevKey && onQualify != nil {
		onQualify(newResult)
	}
	return newResult, nil
}

// computeVerdicts maps a check report onto the verdict list. Sibling tools are
// trusted VERBATIM (their update_available/notable arrive pre-evaluated by
// shll); the self row (see isSelfTool) is re-compared locally against the RUNNING ldflags
// version using shll's latest + notify (shll can only see the brew-installed
// version), and additionally requires this binary to be a brew install (a
// go-install/dev rk cannot self-update through the brew-based remediation, so
// its row would advertise an un-actionable update). Only tools with a pending
// update are listed; iteration is sorted by name so the verdict order is
// deterministic regardless of report order. The self verdict keeps the name
// shll reported, so the scoped `shll update` argv names a tool that shll knows.
func (c *Checker) computeVerdicts(report CheckReport) []ToolVerdict {
	tools := make([]CheckTool, len(report.Tools))
	copy(tools, report.Tools)
	sort.Slice(tools, func(i, j int) bool { return tools[i].Name < tools[j].Name })

	var verdicts []ToolVerdict
	for _, tool := range tools {
		if isSelfTool(tool.Name) {
			if !c.selfBrew {
				continue
			}
			latest := normalizeTag(tool.Latest)
			if !anyIncrease(c.current, latest) {
				continue
			}
			verdicts = append(verdicts, ToolVerdict{
				Tool:            tool.Name,
				Installed:       c.current,
				Latest:          latest,
				UpdateAvailable: true,
				Notable:         crossesThreshold(c.current, latest, tool.Notify),
			})
			continue
		}
		if !tool.UpdateAvailable {
			continue
		}
		verdicts = append(verdicts, ToolVerdict{
			Tool:            tool.Name,
			Installed:       normalizeTag(tool.Installed),
			Latest:          normalizeTag(tool.Latest),
			UpdateAvailable: true,
			Notable:         tool.Notable,
		})
	}
	return verdicts
}

// notableSet projects the notable subset of a verdict list onto the match set
// that drives the chip, the dismissal key, and the `shll update` argv.
func notableSet(verdicts []ToolVerdict) []ToolUpdate {
	var matched []ToolUpdate
	for _, v := range verdicts {
		if !v.Notable {
			continue
		}
		matched = append(matched, ToolUpdate{Tool: v.Tool, Installed: v.Installed, Latest: v.Latest})
	}
	return matched
}

// SetCheckForTest replaces the check-exec seam with a stub and clears
// suppression. Exported so tests in OTHER packages (e.g. api handler tests that
// need a checker with a canned verdict) can drive the checker without a real
// `shll` binary. The stub receives the requested backend source (SourceReleased
// or SourceGithub) so tests can observe/branch on it; it is context-free for
// caller convenience.
func (c *Checker) SetCheckForTest(fn func(source string) (CheckReport, error)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.checkFn = func(_ context.Context, source string) (CheckReport, error) { return fn(source) }
	c.suppressed = false
}

// SetSelfBrewForTest overrides the run-kit brew-install gate.
func (c *Checker) SetSelfBrewForTest(brew bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.selfBrew = brew
}

// CheckOnceForTest runs a single synchronous RELEASED check (exec + verdict
// update + OnQualify). Exported so cross-package tests can materialise a
// qualifying snapshot deterministically without waiting for the ~30s scheduler.
func (c *Checker) CheckOnceForTest() {
	c.checkOnce(context.Background(), SourceReleased)
}

// afterFuncFn schedules fn to run after d, returning a no-op. Package-var seam
// (mirrors the check seam) so tests can capture the scheduled delay + fn and
// invoke it synchronously instead of waiting a real ~2 minutes. Default is
// time.AfterFunc; the returned timer is intentionally not retained (the timer is
// fire-and-forget — a superseding check simply recomputes the verdict).
var afterFuncFn = func(d time.Duration, fn func()) { time.AfterFunc(d, fn) }

// RecheckAfter schedules a single delayed re-check (one exec + verdict pass)
// after d, bound to the daemon context captured at Start. It is the
// post-remediation trigger the /api/update handler calls after spawning a scoped
// `shll update`: a consumed match then propagates as a cleared/changed verdict
// (OnQualify fire → SSE broadcast → frontend clear) within minutes instead of
// waiting for the 6h ticker (R17). No-op on a suppressed checker or before Start
// (no daemon context yet). When run-kit was in the spawned scope the daemon
// restarts and this process-local timer dies with it — harmless.
func (c *Checker) RecheckAfter(d time.Duration) {
	c.mu.RLock()
	suppressed := c.suppressed
	ctx := c.startCtx
	hook := c.recheckHook
	c.mu.RUnlock()
	if hook != nil {
		hook(d)
		return
	}
	if suppressed || ctx == nil {
		return
	}
	afterFuncFn(d, func() {
		select {
		case <-ctx.Done():
			return
		default:
			c.checkOnce(ctx, SourceReleased)
		}
	})
}

// SetRecheckHookForTest replaces RecheckAfter's scheduling with a hook that
// simply records the requested delay. Exported so CROSS-PACKAGE tests (the
// api/update handler test) can assert the handler triggers a post-remediation
// re-check without wiring a real daemon context or timer. Same-package tests
// drive the real path via the afterFuncFn seam instead.
func (c *Checker) SetRecheckHookForTest(fn func(time.Duration)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.recheckHook = fn
}

// defaultCheck runs the real `shll check-updates --json` exec for the given
// backend source and decodes its report. Context-bound with an explicit
// argument slice and no shell string (Constitution I). Error mapping is the
// caller rule from the vendored contract: shll absent from PATH, a non-zero
// exit (1 = check failed, 2 = usage error — any non-zero skips; this includes
// an older shll without `--source` support, which the fail-loud manual path
// surfaces honestly), unparseable JSON, or an unsupported schema all fail the
// pass.
func defaultCheck(ctx context.Context, source string) (CheckReport, error) {
	shllPath, err := exec.LookPath("shll")
	if err != nil {
		return CheckReport{}, fmt.Errorf("shll not found on PATH")
	}
	cmd := exec.CommandContext(ctx, shllPath, checkUpdatesArgs(source)...)
	out, err := cmd.Output()
	if err != nil {
		return CheckReport{}, fmt.Errorf("shll check-updates failed: %w", err)
	}
	var report CheckReport
	if err := json.Unmarshal(out, &report); err != nil {
		return CheckReport{}, fmt.Errorf("shll check-updates returned unparseable JSON: %w", err)
	}
	if report.Schema != checkUpdatesSchema {
		return CheckReport{}, fmt.Errorf("shll check-updates schema %d unsupported (want %d)", report.Schema, checkUpdatesSchema)
	}
	return report, nil
}

// checkUpdatesArgs builds the `shll check-updates` argv tail for a backend
// source. The literal `--source github` pair is appended ONLY for the validated
// SourceGithub enum value — the source string itself is never spliced into the
// command (Constitution I); any other value (including SourceReleased) keeps
// the flag-free released argv.
func checkUpdatesArgs(source string) []string {
	args := []string{"check-updates", "--json"}
	if source == SourceGithub {
		args = append(args, "--source", "github")
	}
	return args
}

// computeKey builds the composite dismissal key: sorted "tool@latest" pairs,
// comma-joined. Empty when nothing matched.
func computeKey(matched []ToolUpdate) string {
	if len(matched) == 0 {
		return ""
	}
	pairs := make([]string, 0, len(matched))
	for _, m := range matched {
		pairs = append(pairs, m.Tool+"@"+m.Latest)
	}
	sort.Strings(pairs)
	return strings.Join(pairs, ",")
}

// runKitFields returns the (current, latest) for the self row when it is in
// the match set — for transitional frontend compat. Empty otherwise.
func runKitFields(matched []ToolUpdate) (current, latest string) {
	for _, m := range matched {
		if isSelfTool(m.Tool) {
			return m.Installed, m.Latest
		}
	}
	return "", ""
}

// normalizeTag strips a single leading "v" and surrounding whitespace so a "v"-
// prefixed report value and a bare ldflags version compare on equal footing.
func normalizeTag(tag string) string {
	return strings.TrimPrefix(strings.TrimSpace(tag), "v")
}

// parseMajorMinor parses the major and minor components of an X.Y.Z version.
// It requires at least "X.Y" and tolerates trailing components (patch,
// pre-release suffixes on the patch). Returns an error when major/minor are
// absent or non-numeric. Retained (with the other semver helpers below) SOLELY
// for the run-kit row's local comparison and New's suppression parse — the
// sibling-wide threshold evaluation moved behind `shll check-updates`.
func parseMajorMinor(v string) (major, minor int, err error) {
	parts := strings.Split(v, ".")
	if len(parts) < 2 {
		return 0, 0, fmt.Errorf("version %q has fewer than 2 components", v)
	}
	major, err = strconv.Atoi(strings.TrimSpace(parts[0]))
	if err != nil {
		return 0, 0, fmt.Errorf("version %q major not an int: %w", v, err)
	}
	minor, err = strconv.Atoi(strings.TrimSpace(parts[1]))
	if err != nil {
		return 0, 0, fmt.Errorf("version %q minor not an int: %w", v, err)
	}
	return major, minor, nil
}

// parsePatch parses the patch (third) component of an X.Y.Z version, tolerating
// a pre-release suffix (e.g. "0-rc1" → 0). Returns 0 when the patch component is
// absent, and an error when it is present but non-numeric.
func parsePatch(v string) (int, error) {
	parts := strings.Split(v, ".")
	if len(parts) < 3 {
		return 0, nil
	}
	patchField := parts[2]
	if i := strings.IndexAny(patchField, "-+"); i >= 0 {
		patchField = patchField[:i]
	}
	patchField = strings.TrimSpace(patchField)
	if patchField == "" {
		return 0, nil
	}
	p, err := strconv.Atoi(patchField)
	if err != nil {
		return 0, fmt.Errorf("version %q patch not an int: %w", v, err)
	}
	return p, nil
}

// crossesThreshold reports whether latest crosses installed under the given
// notify policy (the run-kit row's LOCAL notable evaluation):
//   - "never": never matches.
//   - "patch": matches on ANY version increase (major, minor, or patch).
//   - "minor": matches on a minor-or-major increase; patch differences never
//     match.
//
// An unparseable installed or latest never matches (defensive — a malformed
// report value must not panic or falsely notify). An unknown notify value is
// treated as "never" (fail-closed).
func crossesThreshold(installed, latest, notify string) bool {
	switch notify {
	case notifyNever:
		return false
	case notifyMinor:
		return minorOrMajorIncrease(installed, latest)
	case notifyPatch:
		return anyIncrease(installed, latest)
	default:
		return false
	}
}

// minorOrMajorIncrease reports whether latest is a minor OR major increase over
// installed. Patch-level differences (equal major+minor) never qualify.
func minorOrMajorIncrease(installed, latest string) bool {
	iMaj, iMin, err := parseMajorMinor(installed)
	if err != nil {
		return false
	}
	lMaj, lMin, err := parseMajorMinor(latest)
	if err != nil {
		return false
	}
	if lMaj != iMaj {
		return lMaj > iMaj
	}
	return lMin > iMin
}

// AnyIncrease reports whether latest is any increase (major, minor, or patch)
// over installed. Exported for reuse by internal/desktop's update comparison
// (the desktop-app installer), so the semver-increase logic lives in exactly
// one place. Thin wrapper over anyIncrease. No "v"-prefix handling: inputs
// must be bare semver — callers strip any leading "v" before comparing (see
// normalizeTag; internal/desktop strips it when parsing the release tag).
func AnyIncrease(installed, latest string) bool {
	return anyIncrease(installed, latest)
}

// anyIncrease reports whether latest is any increase (major, minor, or patch)
// over installed — the run-kit row's local `update_available` evaluation.
func anyIncrease(installed, latest string) bool {
	iMaj, iMin, err := parseMajorMinor(installed)
	if err != nil {
		return false
	}
	lMaj, lMin, err := parseMajorMinor(latest)
	if err != nil {
		return false
	}
	if lMaj != iMaj {
		return lMaj > iMaj
	}
	if lMin != iMin {
		return lMin > iMin
	}
	iPatch, err := parsePatch(installed)
	if err != nil {
		return false
	}
	lPatch, err := parsePatch(latest)
	if err != nil {
		return false
	}
	return lPatch > iPatch
}
