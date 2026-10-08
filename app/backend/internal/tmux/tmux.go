package tmux

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"rk/internal/apphome"
	"rk/internal/settings"
	"rk/internal/validate"
)

// SessionOrderOption is the tmux server-scoped user option that stores the
// JSON-encoded sidebar session order.
const SessionOrderOption = "@rk_srv_session_order"

// ServerRankOption is the tmux server-scoped user option that stores this
// server's user-defined display rank (an integer, ascending) among the other
// tmux servers. Order data rides each server so a killed server takes only its
// own rank — no cross-server merge rule is needed. Mirrors SessionOrderOption.
const ServerRankOption = "@rk_srv_rank"

// OperatorRootOption is the tmux server-scoped user option that stores the
// directory of this server's last operator launch. `rk operator` stamps it on
// every successful create and reads it back on a `-L <server>` launch without
// `--dir` (the cron respawn argv), so a respawn lands where the operator last
// started. Its lifetime is the server's — the same as the operator window's.
const OperatorRootOption = "@rk_srv_operator_root"

// OriginOption is the tmux server-scoped user option that stores the full
// origin string (e.g. "http://127.0.0.1:3001") of the run-kit deployment
// covering this tmux server. The covering daemon stamps it on every supervisor
// dial (see tmuxctl.productionDial), and pane-side CLI commands (`rk url`,
// `rk notify`) read it at request time to resolve their server's origin when
// no explicit RK_HOST/RK_PORT env is set. It is NOT an environment variable:
// nothing sprays into child process environments, and a daemon restarted on a
// new port re-stamps on its next dial. Named "origin" (not the window-scoped
// @rk_win_web_<n> present/iframe URL) after internal/remote's "origin via
// `rk url`" language.
const OriginOption = "@rk_srv_origin"

// EphemeralOption is the tmux server-scoped user option marking the whole
// server ephemeral (scratch): presence with a non-empty value (canonically
// "1") opts the server out of layout-snapshot coverage and into the
// `rk mux reap --ephemeral` sweep. Unsetting it promotes the server back to
// durable — snapshot coverage resumes on the next due pass with no other
// action. The option dies with the tmux server, so no consumer can read it
// post-mortem: IsTestServerName remains the dead-socket fallback
// (IsTestServerName(name) ⇒ treated as ephemeral). "This server is scratch"
// is creator intent — underivable from tmux/filesystem/git — which is why it
// rides a user option like the rest of the @rk_* convention family.
//
// Dual-read window: external creators (e2e scripts, agents by convention)
// still stamp the retired unscoped name, so readers accept
// LegacyEphemeralOption as a fallback until the follow-up removal change.
const EphemeralOption = "@rk_srv_ephemeral"

// LegacyEphemeralOption is the retired unscoped name of EphemeralOption,
// dual-read for the deprecation window and removed by the follow-up change.
const LegacyEphemeralOption = "@rk_ephemeral"

// ProtectedOption is the tmux server-scoped user option marking the whole
// server protected: presence with a non-empty value (canonically "1") arms
// the kill guards — POST /api/servers/kill refuses without force, rk mux kill
// refuses panes on it without --force, and rk mux reap skips it
// unconditionally. Unsetting it demotes the server back to normal — there is
// no tombstone value. Exact mirror of EphemeralOption with inverted intent;
// a server carrying both marks behaves as protected wherever the two classes
// conflict (protected beats ephemeral). The rk-daemon production server is
// protected by derivation from its constant name (IsGuardedServer), never by
// this option — derived state is not togglable.
//
// Dual-read window: external creators still stamp the retired unscoped name,
// so readers accept LegacyProtectedOption as a fallback until the follow-up
// removal change.
const ProtectedOption = "@rk_srv_protected"

// LegacyProtectedOption is the retired unscoped name of ProtectedOption,
// dual-read for the deprecation window and removed by the follow-up change.
const LegacyProtectedOption = "@rk_protected"

// ManagedOption is the tmux server-scoped user option recording server
// provenance: presence with a non-empty value (canonically "1") marks the
// server rk-managed — birthed by an rk path whose -f <managed conf> actually
// applied — and gates the conf-apply paths (an unmarked server is external and
// never gets rk's tmux.conf sourced). Stamped only at server birth
// (stampManagedOnBirth); unsetting is the adopt-failure rollback, never a
// demote verb. The rk-daemon production server is managed by derivation from
// its constant name (IsManagedServer), never by this option.
const ManagedOption = "@rk_srv_managed"

// RoleOption is the tmux window user option that marks a window's orchestration
// role. The value set is closed: "" (unset) | "operator". "operator" is a
// server-scoped radio — at most one window per tmux server carries it, enforced
// by every rk write path (ClearWindowRoleExcept) — and the sidebar pins that
// window's row directly below the SESSIONS header. Mirrors the MarkerOption
// option family (validate.MarkerValues / ValidateRoleValue).
const RoleOption = "@rk_win_role"

// NoteOption is the tmux window user option carrying a free-text one-line
// status note — user/agent-authored annotation (the MarkerOption/FlairOption
// user-preference class, not derived state). The value schema is
// "<unix-epoch>:<text>" — the epoch prefix lets the UI age notes honestly
// (the @rk_agent_state staleness precedent). Read-side parse is tolerant: a
// non-numeric prefix degrades to the whole value as text with epoch 0, never
// dropped. Empty/absent = no note (degrade-to-absent everywhere).
const NoteOption = "@rk_win_note"

// LayoutOption carries the tab's surface layout: a canonical split tree,
// e.g. "h(tty,v(code,web))" (legacy "<shape>:<surface>[,<surface>…]" preset
// strings still parse). Unset renders the bare tty leaf.
const LayoutOption = "@rk_win_layout"

// layoutspecSingleWeb is the @rk_win_layout value a retired @rk_win_lens=iframe
// reads as (and the value MigrateLegacyOptions writes for it) — the tree form
// of the lone-web-tile layout.
const layoutspecSingleWeb = "web"

// MaxWebTabs bounds the indexed @rk_win_web_<n> family: ListWindows reads
// options through one fixed tmux format string, which cannot enumerate a
// family, so the URL slots are spelled out 1..MaxWebTabs. Every positional
// field offset after the slots derives from this constant (the
// listWindows*Field / layoutWindow*Field constants beside the two fixed-format
// parsers), so raising the cap stays a one-line change.
const MaxWebTabs = 16

// legacyWebTabSlots is the URL-slot count of the pre-16 fixed formats (the
// ListWindows and layoutWindowFormat layouts before the 8→16 cap raise). A
// capture line shorter than the current format's full length came from the
// 8-slot era and parses with offsets derived from this count — sparse legacy
// lines read tolerantly either way, but a fully-populated legacy line's root
// block otherwise misreads as extra URL slots and its trailing fields shift.
const legacyWebTabSlots = 8

// WebTabOption returns "@rk_win_web_<n>" (1 ≤ n ≤ MaxWebTabs); panics outside
// the range — callers validate first, the bound is a programming contract, not
// user input.
func WebTabOption(n int) string {
	if n < 1 || n > MaxWebTabs {
		panic(fmt.Sprintf("WebTabOption(%d): out of range 1..%d", n, MaxWebTabs))
	}
	return "@rk_win_web_" + strconv.Itoa(n)
}

// WebTabRootOption returns "@rk_win_web_<n>_root" — the absolute serve root for
// a file/dir present target held in slot n, read at request time by the
// /present/ route and never enumerated into ListWindows. Same range contract
// as WebTabOption.
func WebTabRootOption(n int) string {
	if n < 1 || n > MaxWebTabs {
		panic(fmt.Sprintf("WebTabRootOption(%d): out of range 1..%d", n, MaxWebTabs))
	}
	return "@rk_win_web_" + strconv.Itoa(n) + "_root"
}

// WebActiveOption is the 1-based index of the web tab the web surface shows.
const WebActiveOption = "@rk_win_web_active"

// CodeRootOption is the absolute folder the code surface opens (replaces the
// per-browser runkit-code-folder:* latch; seeded/followed by the frontend in a
// later change).
const CodeRootOption = "@rk_win_code_root"

// PrListenOption arms the PR-review comment listener for a window: "1" armed,
// unset disarmed. Per-window because the unit of work is a branch, and SHARED
// across viewers because arming is a fact about the work rather than a viewing
// posture (spec pr-review.md § The Listener → Arm state).
const PrListenOption = "@rk_win_pr_listen"

// ErrWebTabsFull is returned by WebAdd when the window already carries
// MaxWebTabs tabs and the URL is new; api maps it to 409.
var ErrWebTabsFull = errors.New("web tabs full")

// ErrWebTabRange is returned by WebRemove/WebSelect for a slot outside
// 1..len(tabs); api maps it to 400.
var ErrWebTabRange = errors.New("web tab index out of range")

// MarkerOption is the tmux window user option carrying the left-gutter marker:
// a closed-set `<mode>[:<stage>]` token (validate.MarkerValues), "" when unset.
// Modes are manual/auto/blocked, stages are 1/2/3, and a bare mode is stage 1.
const MarkerOption = "@rk_win_marker"

// legacyMarkerValues is the forward map from the flat pre-mode:stage marker
// tokens onto the mode × stage model. Stripe tokens carry manual stages; the
// two texture tokens carry blocked stages.
var legacyMarkerValues = map[string]string{
	"pipe": "manual:1", "dotted": "manual:1", "dashed": "manual:1", "solid": "manual:1",
	"double": "manual:2", "thick": "manual:3",
	"hatch": "blocked:2", "block": "blocked:3",
}

// NormalizeMarker maps a raw @rk_win_marker value onto the mode × stage model:
// flat tokens map forward per legacyMarkerValues, `<mode>[:<stage>]` tokens
// (and "") pass through, anything else normalizes to the empty unset state.
// The table lookup runs FIRST, so a flat token can never reach the membership
// check and never survives as itself — an invariant that holds whether
// MarkerValues spans both vocabularies or only the current one.
//
// It belongs at the read and restore seams rather than in legacy_options.go
// because that table maps option names and this is a same-name value remap.
func NormalizeMarker(raw string) string {
	if v, ok := legacyMarkerValues[raw]; ok {
		return v
	}
	if validate.MarkerValues[raw] {
		return raw
	}
	return ""
}

// FlairOption is the tmux window user option carrying the per-row flair
// decoration: a closed-set token (validate.FlairValues), "" when unset.
const FlairOption = "@rk_win_flair"

// OwnerOption is the tmux window user option recording that an operator has
// taken responsibility for the window at least once: a closed-set token
// (validate.OwnerValues), "" when unset. The intended writer is the operator
// at enrollment; the persisted value is the operator-touched trail after
// monitoring ends.
const OwnerOption = "@rk_win_owner"

// legacyTypeOption / legacyURLOption / legacyNoteOption are the retired
// unscoped names of the window lens/URL/note options; legacyWinLensOption /
// legacyWinURLOption / LegacyWinPresentRootOption are the retired scoped names
// superseded by LayoutOption and the indexed @rk_win_web_<n> family. They live
// here exactly once, shared by the legacyOptions migration table, the /options
// compat translator, and the note dual-read (the last dual-read reader).
const (
	legacyTypeOption           = "@rk_type"
	legacyURLOption            = "@rk_url"
	legacyNoteOption           = "@rk_note"
	legacyWinLensOption        = "@rk_win_lens"
	legacyWinURLOption         = "@rk_win_url"
	LegacyWinPresentRootOption = "@rk_win_present_root"
)

// ColorOption is the window-scoped (-w) user option carrying a window's
// color descriptor ("4" / "1+3"). Scope-named per fab/project/context.md.
const ColorOption = "@rk_win_color"

// SessionColorOption is the session-scoped user option carrying a session's
// color descriptor. Distinct from ColorOption so hierarchical format
// lookup never leaks one scope's value into the other.
const SessionColorOption = "@rk_ses_color"

// SessionFlairOption is the session-scoped user option carrying a session's
// per-row flair decoration (a validate.FlairValues token, "" when unset).
// Scope-split from FlairOption for the same reason SessionColorOption is
// split from ColorOption — see SetSessionFlair.
const SessionFlairOption = "@rk_ses_flair"

// OriginalTMUX captures the TMUX env var before init() strips it.
// Package-level var init runs before init(), so this sees the original value.
// Used by cmd/rk/context.go to restore TMUX in child process environments
// when querying the pane's own tmux server.
var OriginalTMUX = os.Getenv("TMUX")

// DefaultConfigPath is the default location for the tmux config file.
var DefaultConfigPath string

// configPath holds the resolved tmux config file path.
var configPath string

// managedConfigPath records whether the resolved config path IS the rk-managed
// default (false when tmux_conf or RK_TMUX_CONF redirected it). Computed once
// at init: in "you own everything" mode rk performs no ensure/refresh/doctor
// drift analysis on the file.
var managedConfigPath bool

// UserOwnedConfigPath reports whether the resolved tmux config path came from
// the tmux_conf key or RK_TMUX_CONF rather than the rk-managed default.
func UserOwnedConfigPath() bool {
	return !managedConfigPath
}

func init() {
	// Strip TMUX so subprocess calls target the correct tmux server.
	// The daemon runs inside the rk-daemon tmux pane and inherits TMUX
	// pointing to that server; bare tmux commands would target rk-daemon
	// instead of the default socket without this.
	os.Unsetenv("TMUX")

	if dir, err := apphome.ConfigDir(); err == nil {
		// The resolved config home (apphome's dual-read rule) — the same root
		// as settings.Dir()'s default: the RK_CONFIG_DIR test override
		// deliberately does not move this path (only the settings file needs
		// per-run isolation).
		DefaultConfigPath = filepath.Join(dir, "tmux.conf")
	}

	configPath = resolveConfigPath()
	if configPath != "" && !filepath.IsAbs(configPath) {
		if abs, err := filepath.Abs(configPath); err == nil {
			configPath = abs
		}
	}
	managedConfigPath = configPath == DefaultConfigPath
}

// RefreshDefaultConfigPath re-resolves DefaultConfigPath against the current
// config home. The init-time resolution runs before the serve-time home
// migration can publish the new home, so the first post-migration boot would
// otherwise keep managing (and force-refreshing) the LEGACY tmux.conf while
// every other resolver has moved on. When the resolved config path is the
// managed default (no tmux_conf key, no RK_TMUX_CONF), configPath follows; in
// "you own everything" mode only the default moves.
func RefreshDefaultConfigPath() {
	dir, err := apphome.ConfigDir()
	if err != nil {
		return
	}
	resolved := filepath.Join(dir, "tmux.conf")
	if resolved == DefaultConfigPath {
		return
	}
	DefaultConfigPath = resolved
	if managedConfigPath {
		configPath = resolved
	}
}

// resolveConfigPath resolves the tmux config path once at package init:
// RK_TMUX_CONF env (an undocumented per-process test escape — wins per the
// override order) → the tmux_conf config.yaml key → DefaultConfigPath.
// Resolution is init-time only; a config.yaml change applies on the next
// process start.
func resolveConfigPath() string {
	if p := os.Getenv("RK_TMUX_CONF"); p != "" {
		return p
	}
	if p := settings.Load().TmuxConf; p != "" {
		return p
	}
	return DefaultConfigPath
}

// ConfigPath returns the resolved tmux config path (see resolveConfigPath).
func ConfigPath() string {
	return configPath
}

// configArgs returns ["-f", configPath] if a config path is set, or nil.
// Used by commands that start the tmux server (CreateSession) or reload config.
func configArgs() []string {
	if configPath != "" {
		return []string{"-f", configPath}
	}
	return nil
}

// EnsureConfig implements the three-state managed-conf refresh at the default
// path: missing → write the stamped header + embed; managed & stale →
// force-write and report refreshed=true so the caller runs the reload sweep;
// managed & current or hand-edited → the file stays untouched (hand-edited
// confs are never clobbered). The tmux.d/ drop-in dir and the user.conf
// starter are scaffolded on every call, and the legacy ~/.rk migration runs
// first (best-effort, never fatal). Daemon start is the only trigger — no
// timer, no watcher.
//
// No-op when the resolved config path is not DefaultConfigPath (the tmux_conf
// key or RK_TMUX_CONF is set): that is "you own everything" mode — rk performs
// no ensure/refresh on a user-owned file (see settings.TmuxConf).
func EnsureConfig() (refreshed bool, err error) {
	if DefaultConfigPath == "" || !managedConfigPath {
		return false, nil
	}
	// Migration precedes the user.conf scaffold so a legacy drop-in named
	// user.conf wins over the fresh starter.
	migrateLegacyConfPaths()
	state, err := ClassifyConfigFile(DefaultConfigPath)
	if err != nil {
		return false, fmt.Errorf("checking config file: %w", err)
	}
	switch state {
	case ConfMissing:
		if err := writeManagedConfig(DefaultConfigPath); err != nil {
			return false, err
		}
	case ConfManagedStale:
		if err := writeManagedConfig(DefaultConfigPath); err != nil {
			return false, err
		}
		refreshed = true
	}
	if err := ensureDropInDir(); err != nil {
		return false, err
	}
	if err := scaffoldUserConf(); err != nil {
		return false, err
	}
	return refreshed, nil
}

// ForceWriteConfig writes the embedded default tmux.conf (with the managed
// header stamp) to DefaultConfigPath, overwriting any existing file, and
// scaffolds the tmux.d/ drop-in dir + user.conf starter (never overwritten).
// Equivalent to `rk mux init-conf --force`.
func ForceWriteConfig() error {
	if DefaultConfigPath == "" {
		return fmt.Errorf("could not determine home directory")
	}
	if err := writeManagedConfig(DefaultConfigPath); err != nil {
		return err
	}
	if err := ensureDropInDir(); err != nil {
		return err
	}
	return scaffoldUserConf()
}

// ensureDropInDir creates a tmux.d/ drop-in directory alongside DefaultConfigPath
// for user drop-in configs.
func ensureDropInDir() error {
	if DefaultConfigPath == "" {
		return nil
	}
	dropInDir := filepath.Join(filepath.Dir(DefaultConfigPath), "tmux.d")
	if err := os.MkdirAll(dropInDir, 0o755); err != nil {
		return fmt.Errorf("creating tmux drop-in directory: %w", err)
	}
	return nil
}

// ReloadConfig hot-reloads the tmux config via source-file on the specified server.
// Returns an error if no config path is set or the source-file command fails.
func ReloadConfig(server string) error {
	if configPath == "" {
		return fmt.Errorf("no tmux config path (run 'rk mux init-conf' or set the tmux_conf key in ~/.config/hexokit/config.yaml)")
	}
	ctx, cancel := withTimeout()
	defer cancel()
	args := append(configArgs(), "source-file", configPath)
	_, err := tmuxExecServer(ctx, server, args...)
	return err
}

// serverArgs returns the argument prefix for commands targeting a given server.
// For "default", returns an empty slice (no -L flag). For any other name, returns
// ["-L", name]. The -f config flag is only needed on server-creating commands
// (CreateSession) and ReloadConfig — not on every command.
func serverArgs(server string) []string {
	if server == "default" {
		return nil
	}
	return []string{"-L", server}
}

// ExactSessionTarget returns the unambiguous tmux target string for a session
// name: `=name:`. The leading `=` disables tmux's prefix/fnmatch name matching
// (exact match only) and the trailing `:` forces the string to parse as a
// session — never as a window name.
//
// The colon is load-bearing for commands whose `-t` is a *window* target
// (new-window; list-panes, even under `-s`): tmux resolves a bare name against
// the window names of the current/attached session BEFORE trying it as a
// session name, so a window that shares its name with the target session
// hijacks the command. Observed live (server "ext", 2026-07-17): with a window
// named "planner" in the attached session, `new-window -a -t planner` created
// its window in the attached session instead of session "planner", and
// `list-panes -s -t planner` listed the attached session's panes — which the
// window-index pane join then glued onto session "planner"'s windows. Since
// windows AND sessions are auto-named from folder basenames
// (automatic-rename-format), such collisions are routine, not exotic.
//
// Session names are validated to contain no `:` or `.` (validate.ValidateName)
// and cannot start with `=` in practice; pin-session names (`_rk-pin-<digits>`)
// and the control anchor are equally safe to wrap.
func ExactSessionTarget(session string) string {
	return "=" + session + ":"
}

// exactWindowInSession returns a session-qualified window target with an
// exact-match session part: `=session:windowSpec`. windowSpec must itself be
// unambiguous within the session — a window ID (@N) or a numeric index.
func exactWindowInSession(session, windowSpec string) string {
	return "=" + session + ":" + windowSpec
}

const (
	// TmuxTimeout is the default timeout for tmux commands.
	TmuxTimeout = 10 * time.Second
	// ActivityThresholdSeconds is how recently a window must have had activity to be "active".
	ActivityThresholdSeconds = 10
	// WindowActivityActive / WindowActivityIdle are the WindowInfo.Activity
	// states, derived from ActivityTimestamp against ActivityThresholdSeconds.
	WindowActivityActive = "active"
	WindowActivityIdle   = "idle"
	// listDelim is the tab delimiter used in tmux format strings.
	listDelim = "\t"
	// PinSessionPrefix is the reserved name prefix for run-kit's single-window
	// board pin-sessions. Each pinned window is LINKED into its own session named
	// `_rk-pin-<windowDigits>` (the window's `@N` id with the `@` stripped, since
	// tmux session names disallow `@`) — the window stays a member of its home
	// session too (dual membership). Sessions matching this prefix are filtered
	// out of user-facing session lists — a board is the set of pin-sessions
	// sharing an `@rk_ses_pin_board` value, not a session itself. Pin-sessions are
	// persistent across rk restarts (Constitution VI); there is no startup sweep.
	PinSessionPrefix = "_rk-pin-"
	// IsoSessionPrefix is the reserved name prefix for run-kit's single-window
	// isolated relay sessions: `_rk-iso-<windowDigits>` (the window's `@N` id
	// with the `@` stripped, since tmux session names disallow `@`). An
	// `open` op with `isolate: true` attaches through the window's iso session
	// (created on demand, the window LINKED in — it stays a member of its home
	// session too) so the stream gets an independent active-window pointer
	// without touching home's. Sessions matching this prefix are filtered out
	// of user-facing session lists exactly like pin-sessions. Lifecycle is
	// tmux-side: the attach argv chains `destroy-unattached on`, so tmux reaps
	// the session when its last client leaves.
	IsoSessionPrefix = "_rk-iso-"
	// ControlAnchorSessionName is the literal name of the hidden anchor session
	// created by the tmuxctl package on tmux servers that have zero user
	// sessions (a `tmux -CC attach` requires an attached session). It is
	// filtered from user-facing session lists in parseSessions — it's owned by
	// tmuxctl, not user-facing.
	ControlAnchorSessionName = "_rk-ctl"
	// OperatorSessionName is the literal name of the per-server session an
	// operator window (RoleOption "operator") is physically MOVED into on role-set
	// (single membership — unlike the link-based pin-sessions). It is never
	// name-skipped in parseSessions: the payload nests windows under sessions,
	// so a parse-level skip would erase the pinned operator row's data source.
	// User-facing surfaces hide it by content instead — sessions.FetchSessions
	// marks it hidden only while every window in it carries the operator role.
	OperatorSessionName = "_rk-operator"
)

// PinSessionName derives the single-window pin-session name for a window id by
// stripping the leading `@` (tmux session names disallow `@`): `@42` →
// `_rk-pin-42`. Returns ("", false) for an invalid window id. The mapping is
// pure and reversible (see WindowIDFromPinSession), so membership needs no
// name→id lookup table.
func PinSessionName(windowID string) (string, bool) {
	if !ValidWindowID(windowID) {
		return "", false
	}
	return PinSessionPrefix + windowID[1:], true
}

// WindowIDFromPinSession is the inverse of PinSessionName: `_rk-pin-42` → `@42`.
// Returns ("", false) when name lacks the prefix or the recovered id is not a
// valid `@<digits>` window id.
func WindowIDFromPinSession(name string) (string, bool) {
	if !strings.HasPrefix(name, PinSessionPrefix) {
		return "", false
	}
	id := "@" + strings.TrimPrefix(name, PinSessionPrefix)
	if !ValidWindowID(id) {
		return "", false
	}
	return id, true
}

// IsoSessionName derives the single-window isolated relay session name for a
// window id by stripping the leading `@` (tmux session names disallow `@`):
// `@42` → `_rk-iso-42`. Returns ("", false) for an invalid window id. The
// mapping is pure and reversible (see WindowIDFromIsoSession), so membership
// needs no name→id lookup table.
func IsoSessionName(windowID string) (string, bool) {
	if !ValidWindowID(windowID) {
		return "", false
	}
	return IsoSessionPrefix + windowID[1:], true
}

// WindowIDFromIsoSession is the inverse of IsoSessionName: `_rk-iso-42` → `@42`.
// Returns ("", false) when name lacks the prefix or the recovered id is not a
// valid `@<digits>` window id.
func WindowIDFromIsoSession(name string) (string, bool) {
	if !strings.HasPrefix(name, IsoSessionPrefix) {
		return "", false
	}
	id := "@" + strings.TrimPrefix(name, IsoSessionPrefix)
	if !ValidWindowID(id) {
		return "", false
	}
	return id, true
}

// IsHiddenLinkSession reports whether name is one of run-kit's single-window
// link-target sessions (a board pin-session or an isolated relay session) —
// rk-internal attach targets that are never user-facing session owners. Every
// site that treats pin-sessions as "not a user-facing owner" (session lists,
// layout snapshots, home-session resolution) keys on this one predicate so the
// two kinds can never drift apart.
func IsHiddenLinkSession(name string) bool {
	return strings.HasPrefix(name, PinSessionPrefix) || strings.HasPrefix(name, IsoSessionPrefix)
}

// AgentStateOption is the tmux PANE-scoped user option that carries the generic
// agent-lifecycle state written by agent-harness hooks (installed via
// `rk agent setup`). Value schema: "<state>:<epoch_seconds>", state ∈
// active|waiting|idle. It is the tier-2 signal owned by run-kit (tier 1 —
// change/stage — stays fab's). See docs/specs/agent-state.md.
//
// Dual-read window: `rk agent hook` dual-writes this name and the retired
// unscoped one, and every installed rk (and fab-kit) still reads the retired
// name, so readers prefer this name and fall back to
// LegacyAgentStateOption until the follow-up removal change.
const AgentStateOption = "@rk_pane_agent_state"

// LegacyAgentStateOption is the retired unscoped name of AgentStateOption,
// dual-read for the deprecation window and removed by the follow-up change.
const LegacyAgentStateOption = "@rk_agent_state"

// Agent lifecycle states carried by @rk_pane_agent_state. Any other token parses as
// unknown (empty state, zero epoch).
const (
	AgentStateActive  = "active"
	AgentStateWaiting = "waiting"
	AgentStateIdle    = "idle"
)

// AgentSessionOption is the tmux PANE-scoped user option that ties a pane to
// the live agent session running in it. Value schema: "<provider>:<session-ref>"
// (e.g. "claude:6f0d9e2a-1c3b-4f7e-9a2d-8b5c4e1f0a37"). <provider> is the
// rk agent setup registry agent name; <session-ref> is a provider-defined opaque
// reference (the session UUID for claude). It is written by the same
// `rk agent hook` binary that writes @rk_pane_agent_state, on the same fires. The
// pane→session mapping is underivable from disk/tmux/git (multiple transcripts
// share a cwd), which is exactly the class of fact Constitution X reserves for
// hooks. See docs/specs/agent-state.md § Agent Session Identity.
//
// Dual-read window: `rk agent hook` dual-writes this name and the retired
// previous one, so readers prefer this name and fall back to
// LegacyAgentSessionOption until the follow-up removal change.
const AgentSessionOption = "@rk_pane_agent_session"

// LegacyAgentSessionOption is the retired previous name of AgentSessionOption,
// dual-read for the deprecation window and removed by the follow-up change.
const LegacyAgentSessionOption = "@rk_pane_chat"

// PaneGitBranchOption / PaneGitWorktreeOption / PanePathTailOption are the
// PANE-scoped user options the daemon stamps with each pane's derived git info
// so the managed pane-border-format reads them (#{@rk_pane_*}) instead of
// forking `#()` git shell-jobs at draw time — the fix for the split-window
// server wedge. Writer = the snapshotter tick (subscriber-independent,
// only-on-change); the values are single-sourced from internal/gitinfo so the
// border shows exactly what the sidebar shows. See docs/specs (configuration /
// agent-state) and internal/snapshot.
const (
	// PaneGitBranchOption carries the branch name (empty for detached-past-grace
	// or no repo).
	PaneGitBranchOption = "@rk_pane_git_branch"
	// PaneGitWorktreeOption carries the worktree badge string
	// (PaneGitWorktreeBadge) when the pane's git root lies under a
	// worktrees/.worktrees directory, else empty.
	PaneGitWorktreeOption = "@rk_pane_git_worktree"
	// PanePathTailOption carries the last two segments of the pane's cwd.
	PanePathTailOption = "@rk_pane_pathtail"
)

// PaneGitWorktreeBadge is the exact string the retired pane-border shell job
// emitted for a worktree pane (a leading space, the nerd-font worktree glyph,
// and two trailing spaces). The daemon stamps it verbatim into
// PaneGitWorktreeOption so the border need only read the option; the border's
// own `#[bg=…]` style arm still wraps it.
const PaneGitWorktreeBadge = "   "

// SetPaneOption sets a user-defined pane option on the specified server
// (`set-option -p`). Mirrors SetWindowOption, pane-scoped.
func SetPaneOption(ctx context.Context, paneID, server, option, value string) error {
	_, err := tmuxExecServer(ctx, server, "set-option", "-p", "-t", paneID, option, value)
	return err
}

// GetPaneOption reads a user-defined pane option on the specified server —
// the read counterpart to SetPaneOption, via `show-options -p -qv`. Returns
// ("", nil) when the option is unset (tmux prints nothing with -qv). The call
// is bounded to the 5s short-tmux tier on top of the caller's context.
func GetPaneOption(ctx context.Context, paneID, server, option string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	raw, err := tmuxExecRawServer(ctx, server, "show-options", "-pqv", "-t", paneID, option)
	if err != nil {
		return "", err
	}
	return strings.TrimRight(raw, "\n"), nil
}

// shellCommands is the set of plain-shell pane_current_command values that the
// LEGACY reconciler fallback treats as "no agent" — applied only to
// two-segment @rk_agent_state values (no pid segment, older writers). A pane
// running one of these has no agent regardless of a leftover value (the guppi
// auto-clear lesson: a killed agent can strand a stale `active`). Pid-carrying
// values use the precise PID-liveness reconciler instead (agentProcessAlive)
// and never consult this set. See docs/specs/agent-state.md § Reader rules.
//
// The same set is the `rk mux panes` liveness-walk trigger: a shell foreground
// is the only case where "did the agent exit?" is an open question (an agent
// TUI owning the tty is not a candidate), so the nine common login shells are
// all listed — a shell missing here silently exempts its panes from the walk.
var shellCommands = map[string]bool{
	"sh":   true,
	"bash": true,
	"zsh":  true,
	"fish": true,
	"dash": true,
	"ksh":  true,
	"tcsh": true,
	"csh":  true,
	"nu":   true,
}

// IsShellCommand reports whether cmd is one of the plain shells the reconciler
// treats as having no agent. The ONE predicate over shellCommands — readers
// needing the shell/non-shell split (the reconciler's legacy fallback, the
// mux send gate's unknown-state warning, the mux panes liveness-walk trigger)
// share it; never copy the set.
func IsShellCommand(cmd string) bool {
	return shellCommands[cmd]
}

// isAgentState reports whether s is one of the three known agent states.
func isAgentState(s string) bool {
	return s == AgentStateActive || s == AgentStateWaiting || s == AgentStateIdle
}

// agentProcessAlive reports whether the agent process with the given pid is
// still alive, via the classic kill(pid, 0) liveness probe: no signal is sent,
// only existence/permission is checked. EPERM counts as alive (the process
// exists but belongs to another user). Package-level var so tests can stub it —
// parsePanes stays deterministic without real processes.
var agentProcessAlive = func(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

// agentStateStale is the single dead/no-agent reconcile decision shared by
// parsePanes (the sessions rollup) and PaneAgentState (the mux verbs'
// single-pane read): a pid-carrying value is trusted iff the agent process is
// alive (kill-0 liveness — precise, wrapper-launch-proof); a legacy
// two-segment value (pid 0) falls back to the shell-command heuristic (a
// plain-shell pane has no agent — the guppi auto-clear lesson).
func agentStateStale(pid int, command string) bool {
	if pid > 0 {
		return !agentProcessAlive(pid)
	}
	return IsShellCommand(command)
}

// parseAgentState parses a raw @rk_agent_state value of the form
// "<state>:<epoch_seconds>[:<pid>]" into a validated (state, epoch, pid)
// triple. The pid segment is optional: `rk agent hook` resolves the agent pid
// by walking up from getppid() until an ancestor's comm matches the agent
// literal (the hook's immediate parent is an ephemeral wrapper shell), and
// omits the segment when that walk finds no match. pid is 0 when the segment is
// absent (resolution failure, or legacy two-segment writers). A value
// that is empty, has the wrong segment count, carries an unknown state token,
// a non-integer epoch, or a malformed/non-positive pid yields ("", 0, 0) —
// unknown (malformed values are never partially trusted).
func parseAgentState(raw string) (string, int64, int) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", 0, 0
	}
	parts := strings.Split(raw, ":")
	if len(parts) < 2 || len(parts) > 3 {
		return "", 0, 0
	}
	state := parts[0]
	if !isAgentState(state) {
		return "", 0, 0
	}
	epoch, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return "", 0, 0
	}
	pid := 0
	if len(parts) == 3 {
		pid, err = strconv.Atoi(parts[2])
		if err != nil || pid <= 0 {
			return "", 0, 0
		}
	}
	return state, epoch, pid
}

// parseAgentSessionRef parses a raw agent-session option value of the form
// "<provider>:<session-ref>" into a validated (provider, ref) pair. It trims the
// value, splits on the FIRST colon (providers never contain a colon; a ref might
// in principle, so the tail after the first colon is the ref verbatim), and
// validates the provider shape ([a-z][a-z0-9_-]*, non-empty) and the ref
// (non-empty, no whitespace or control chars). Any violation — empty value,
// missing colon, empty/invalid provider, empty/whitespace ref — yields ("", "")
// (wholly unknown, mirroring parseAgentState's never-partially-trust tolerance).
// An unknown-but-well-formed provider is NOT rejected: presence-gating is
// provider-agnostic and codex/gemini adapters are additive.
func parseAgentSessionRef(raw string) (provider, ref string) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", ""
	}
	i := strings.IndexByte(raw, ':')
	if i < 0 {
		return "", ""
	}
	provider = raw[:i]
	ref = raw[i+1:]
	if !isAgentProvider(provider) || !isAgentSessionRef(ref) {
		return "", ""
	}
	return provider, ref
}

// isAgentProvider reports whether p matches [a-z][a-z0-9_-]* (a lowercase token,
// the shape of an rk agent setup registry agent name). Non-empty is implied by
// the leading-char requirement.
func isAgentProvider(p string) bool {
	if p == "" {
		return false
	}
	for i := 0; i < len(p); i++ {
		c := p[i]
		if i == 0 {
			if c < 'a' || c > 'z' {
				return false
			}
			continue
		}
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '_' && c != '-' {
			return false
		}
	}
	return true
}

// isAgentSessionRef reports whether r is a valid session-ref: non-empty with no
// whitespace or control characters (a well-formed opaque token; the provider
// defines its inner structure). A ref carrying whitespace/control bytes is a
// malformed value the reader must not trust.
func isAgentSessionRef(r string) bool {
	if r == "" {
		return false
	}
	for _, c := range r {
		if c <= ' ' || c == 0x7f {
			return false
		}
	}
	return true
}

// ValidAgentSessionRef is the exported isAgentSessionRef — the ONE session-ref
// shape gate, shared with packages outside tmux (rk cron add validates
// --session with it) so the rule is never duplicated.
func ValidAgentSessionRef(r string) bool {
	return isAgentSessionRef(r)
}

// ParseAgentSessionRef is the exported parseAgentSessionRef — the ONE
// "<provider>:<session-ref>" split+validate rule, shared so no consumer
// re-splits the raw option value.
func ParseAgentSessionRef(raw string) (provider, ref string) {
	return parseAgentSessionRef(raw)
}

// PaneInfo describes a single tmux pane within a window.
type PaneInfo struct {
	PaneID    string `json:"paneId"`
	PaneIndex int    `json:"paneIndex"`
	Cwd       string `json:"cwd"`
	Command   string `json:"command"`
	IsActive  bool   `json:"isActive"`
	GitBranch string `json:"gitBranch,omitempty"`
	// PanePID is the pane's shell PID (#{pane_pid}) — the root of the process
	// tree the mux verbs walk. AgentPID is the pid segment of a 3-segment
	// agent-state value after reconciliation (0 when absent or stale) — the
	// instrumented agent's pid that cross-checks the walk. Neither is a
	// dashboard field: they exist so `rk mux panes` can walk lazily without a
	// per-pane tmux round trip, and the /ws/state payload must not grow.
	PanePID  int `json:"-"`
	AgentPID int `json:"-"`
	// CwdMissing is true when Cwd is non-empty but no longer exists on disk —
	// e.g. a worktree that was deleted (archived) out from under a still-live
	// tmux pane. tmux keeps reporting the stale path until the shell's cwd
	// recovers, so the UI surfaces this as a "(deleted)" marker.
	CwdMissing bool `json:"cwdMissing,omitempty"`
	// AgentState is the generic agent-lifecycle state from the pane's
	// @rk_agent_state option (active|waiting|idle; empty = unknown), after the
	// reconciler (PID liveness for pid-carrying values; shell-command fallback
	// for legacy two-segment values). AgentStateEpoch is the option's
	// epoch-seconds segment (0 = unknown), from which idle/waiting duration is
	// computed rk-side.
	AgentState      string `json:"agentState,omitempty"`
	AgentStateEpoch int64  `json:"agentStateEpoch,omitempty"`
	// AgentProvider / AgentSessionRef are the pre-parsed halves of the pane's
	// agent-session option (provider = the agent setup registry name, ref = the
	// provider-defined session reference; both empty = no agent session), after
	// the same reconciler that governs the agent-state fields (a dead-pid or
	// shell pane never surfaces the identity). Parsed once here via
	// parseAgentSessionRef so no consumer re-splits the raw value. See
	// AgentSessionOption / docs/specs/agent-state.md.
	AgentProvider   string `json:"agentProvider,omitempty"`
	AgentSessionRef string `json:"agentSessionRef,omitempty"`
	// AltScreen is true when the pane's application is on tmux's alternate
	// screen (alternate_on). Alt-screen panes have no scrollback, so
	// capture-pane history for them is structurally empty — the export menu
	// gates its server-capture row on the window-level rollup of this.
	AltScreen bool `json:"altScreen,omitempty"`
}

// WindowInfo describes a single tmux window within a session.
type WindowInfo struct {
	Index             int     `json:"index"`
	WindowID          string  `json:"windowId"`
	Name              string  `json:"name"`
	WorktreePath      string  `json:"worktreePath"`
	Activity          string  `json:"activity"` // "active" or "idle"
	IsActiveWindow    bool    `json:"isActiveWindow"`
	PaneCommand       string  `json:"paneCommand,omitempty"`
	ActivityTimestamp int64   `json:"activityTimestamp"`
	Color             *string `json:"color,omitempty"`
	AgentState        string  `json:"agentState,omitempty"`
	AgentIdleDuration string  `json:"agentIdleDuration,omitempty"`
	// AgentProvider / AgentSessionRef are the window-level rollup of the panes'
	// reconciled agent-session identity (the active pane's session if set, else
	// the first pane carrying one), computed rk-side in FetchSessions by
	// rollupAgentSession. Per-pane truth is preserved on
	// Panes[].AgentProvider/AgentSessionRef. See AgentSessionOption.
	AgentProvider   string `json:"agentProvider,omitempty"`
	AgentSessionRef string `json:"agentSessionRef,omitempty"`
	// ConversationAvailable is the window-level rollup of whether the
	// window's reconciled agent identity resolves to a READABLE conversation:
	// the provider has a registered transcript adapter and either its bounded
	// resolution succeeded or its cheap ConversationChecker probe (opencode,
	// whose resolution is a request-priced export) says yes. Server-derived
	// (internal/sessions) so the flyout/palette never advertise a
	// transcript-backed action that predictably fails for an identity-only
	// provider. False whenever the identity is absent or unresolvable.
	ConversationAvailable bool `json:"conversationAvailable,omitempty"`
	// AltScreen is the window-level rollup of the ACTIVE pane's AltScreen (the
	// same active-pane rule CaptureWindowHistoryCtx targets), computed rk-side
	// in FetchSessions. True means tmux holds no scrollback for the window's
	// capture target, so the export menu gates its server-capture row on it.
	AltScreen       bool   `json:"altScreen"`
	FabChange       string `json:"fabChange,omitempty"`
	FabStage        string `json:"fabStage,omitempty"`
	FabDisplayState string `json:"fabDisplayState,omitempty"` // pipeline state of the displayed stage; empty when fab reports null/omits the field
	// Monitored* are the operator-watchlist tier: FetchSessions joins the fab
	// operator state file's tracked: list onto each window by pane ID (one
	// file read per fetch, rk-side — the frontend never touches the fab-owned
	// file). Monitored is true when any pane's PaneID matches a watchlist
	// entry's pane; the remaining fields carry that entry's values.
	Monitored       bool   `json:"monitored,omitempty"`
	MonitoredChange string `json:"monitoredChange,omitempty"` // the tracked item id (fab-change: the change ID)
	MonitoredStage  string `json:"monitoredStage,omitempty"`
	MonitoredRepo   string `json:"monitoredRepo,omitempty"`
	MonitoredBranch string `json:"monitoredBranch,omitempty"`
	MonitoredAgent  string `json:"monitoredAgent,omitempty"`
	// PR fields. PrURL/PrNumber are branch-derived in FetchSessions via
	// prstatus (enrichWindowPR — Layer 1), which also seeds PrState/PrIsDraft.
	// PrChecks/PrReview are attached by the SSE hub from the
	// in-memory prstatus collector snapshot (Layer 3), which also OVERRIDES
	// PrState/PrIsDraft on a URL hit but preserves the Layer-1 seed on a miss —
	// the collector only sees the authenticated user's own PRs, so a teammate's
	// draft reaches the client solely via that seed. Both layers are populated
	// outside this package.
	// PrListen is the @rk_win_pr_listen arm for the PR-review comment
	// listener: true only for the exact value "1" (an unrecognized value fails
	// CLOSED — the listener delivers work into an agent pane). It rides the
	// window payload so the SSE tick can advance the listener without a
	// subprocess, and so every viewer sees the same arm state.
	PrListen  bool    `json:"prListen,omitempty"`
	PrURL     *string `json:"prUrl,omitempty"`
	PrNumber  *int    `json:"prNumber,omitempty"`
	PrState   string  `json:"prState,omitempty"`
	PrChecks  string  `json:"prChecks,omitempty"`
	PrReview  string  `json:"prReview,omitempty"`
	PrIsDraft bool    `json:"prIsDraft,omitempty"`
	// PrReviewUnhandled is the count of review threads the listener's
	// eligibility predicate admits — !resolved ∧ !outdated ∧ !👀 — from the same
	// collector digest the listener reads. Collector-join-owned like
	// PrChecks/PrReview (reset then re-attached on a snapshot hit), so the
	// review toggle's dot means "threads are waiting on a human" for a CLOSED
	// tile too: without it the dot could only report tile-reported counts and
	// would sit lit on availability alone.
	PrReviewUnhandled int `json:"prReviewUnhandled,omitempty"`
	// PrFetchedAt is when the joined PR status was last fetched by the viewer-wide
	// collector (prstatus.PRStatus.FetchedAt). Collector-join-owned like
	// PrChecks/PrReview: set on a URL-keyed snapshot hit, reset to nil on a miss.
	// Surfaced in the StatusDotTip as an ambient "checked Xs ago" freshness
	// line; a manual refresh visibly resets it.
	PrFetchedAt *time.Time `json:"prFetchedAt,omitempty"`
	// Layout is the tab's surface layout, sourced from the LayoutOption window
	// user option (a split tree, e.g. "h(tty,v(code,web))"; legacy preset
	// strings still parse). "" (unset) renders the bare tty leaf. Read-side is
	// tolerant: the raw value rides through unvalidated (validation is
	// write-side; consumers parse).
	Layout string `json:"layout,omitempty"`
	// AwayIn maps a surface kind to the id of the window currently holding it
	// as a foreign leaf ("@12/tty" in that window's layout) — the home window's
	// view of a borrow, derived across ALL of the server's windows in
	// FetchSessions via DeriveAwayIn (nothing stored, Constitution II). Absent
	// kinds are not away. Dead homes and self-naming leaves never appear.
	AwayIn map[string]string `json:"awayIn,omitempty"`
	// WebTabs is the dense @rk_win_web_<n> family: slots 1..MaxWebTabs walked in
	// order, stopping at the first empty (a hand-written gap degrades to the
	// prefix — the write paths never produce gaps). Index 0 is tmux slot 1.
	WebTabs []string `json:"webTabs,omitempty"`
	// WebActive is the 1-based index into WebTabs the web surface shows, sourced
	// from WebActiveOption. 0 when no tabs; a non-numeric or out-of-range stored
	// value clamps to 1 when tabs exist (degrade, never error).
	WebActive int `json:"webActive,omitempty"`
	// CodeRoot is the absolute folder the code surface opens, sourced from
	// CodeRootOption. "" when unset.
	CodeRoot string `json:"codeRoot,omitempty"`
	// GitRoot is the resolved code folder derived from the window's active-pane
	// cwd (config.FindGitRoot — a filesystem walk, no subprocess), computed
	// rk-side in FetchSessions: the git toplevel when the cwd sits in a repo,
	// the raw cwd itself when outside any repo, and empty only when no cwd is
	// resolvable at all. It keys the code lens/surface availability
	// (docs/specs/right-panel.md) — editor state follows the code, so it is
	// keyed by the resolved folder, never window id.
	GitRoot string `json:"gitRoot,omitempty"`
	// Marker is the window's left-gutter marker state, sourced from the
	// @rk_win_marker window user option as a `<mode>[:<stage>]` token. It is an
	// independent label axis from Color. Legacy flat tokens normalize forward
	// and unknown tokens are dropped to "" by parseWindows.
	Marker string `json:"marker,omitempty"`
	// Role is the window's orchestration role, sourced from the @rk_win_role window
	// user option: "" (unset)/"operator". "operator" is a server-scoped radio —
	// at most one window per server carries it — and the sidebar pins that
	// window's row below the SESSIONS header. Unknown tokens are dropped to ""
	// by parseWindows (the Marker idiom).
	Role string `json:"role,omitempty"`
	// Flair is the window's per-row flair decoration, sourced from the
	// @rk_win_flair window user option: "" (unset)/"nyan"/"naruto"/"onepiece".
	// Pure decoration — an independent axis from Color and Marker. Unknown
	// tokens are dropped to "" by parseWindows (the Marker idiom).
	Flair string `json:"flair,omitempty"`
	// Owner records that an operator has taken responsibility for the window at
	// least once, sourced from the @rk_win_owner window user option: ""
	// (unset)/"operator". Unknown tokens are dropped to "" by parseWindows (the
	// Marker idiom).
	Owner string `json:"owner,omitempty"`
	// Note is the window's free-text one-line status note, sourced from the
	// NoteOption window user option ("<unix-epoch>:<text>" — the epoch lands in
	// NoteEpoch). Free text, NOT a closed set: no value validation on read; a
	// non-numeric epoch prefix degrades tolerantly to the whole value as text
	// with NoteEpoch 0 (rendered without an age, never dropped). Empty when
	// the option is unset (degrade-to-absent).
	Note string `json:"note,omitempty"`
	// NoteEpoch is the unix-seconds write time from the note's epoch prefix;
	// 0 for tolerant-parse notes (text-only, no age shown).
	NoteEpoch int64      `json:"noteEpoch,omitempty"`
	Panes     []PaneInfo `json:"panes,omitempty"`
}

// tmuxExecServer runs a tmux command targeting the specified server and returns stdout lines (empty lines filtered).
func tmuxExecServer(ctx context.Context, server string, args ...string) ([]string, error) {
	full := append(serverArgs(server), args...)
	out, err := RunOutput(ctx, full, RunOpts{})
	if err != nil {
		return nil, err
	}
	raw := strings.Trim(string(out), "\n\r ")
	if raw == "" {
		return nil, nil
	}
	lines := strings.Split(raw, "\n")
	var result []string
	for _, l := range lines {
		if l != "" {
			result = append(result, l)
		}
	}
	return result, nil
}

// ErrNoFieldDelimiter reports a successful -F read whose lines carry no
// listDelim. tmux ≥ 3.7 rewrites C0 characters — the tab delimiter included —
// to '_' for a client without a UTF-8 locale, output that would otherwise
// parse as an empty (not failed) enumeration.
var ErrNoFieldDelimiter = errors.New("tmux -F output has no field delimiter — non-UTF-8 client locale?")

// checkDelimited guards the list read paths against sanitized -F output.
// Every list format here has at least two fields, so a healthy line always
// contains listDelim; nil for empty output (a genuinely empty enumeration).
func checkDelimited(lines []string) error {
	if len(lines) == 0 {
		return nil
	}
	for _, line := range lines {
		if strings.Contains(line, listDelim) {
			return nil
		}
	}
	return ErrNoFieldDelimiter
}

// tmuxExecList is tmuxExecServer for tab-delimited `-F` list reads: the same
// exec and line split, plus the checkDelimited guard, so a routed list reader
// cannot map sanitized output to an empty enumeration. Precondition: the -F
// format has at least two fields — a single-field format would trip the
// guard on healthy output. Exec errors pass through unchanged (callers keep
// their own gone-server handling); the guard's failure is
// ErrNoFieldDelimiter, distinguishable via errors.Is.
func tmuxExecList(ctx context.Context, server string, args ...string) ([]string, error) {
	lines, err := tmuxExecServer(ctx, server, args...)
	if err != nil {
		return nil, err
	}
	if err := checkDelimited(lines); err != nil {
		return nil, err
	}
	return lines, nil
}

// tmuxExecRawServer runs a tmux command targeting the specified server and
// returns raw stdout. On non-zero exit, captured stderr is appended to the
// error message so callers can pattern-match on tmux's diagnostic text
// (e.g., "invalid option", "no server running") to distinguish operational
// states from real failures.
func tmuxExecRawServer(ctx context.Context, server string, args ...string) (string, error) {
	full := append(serverArgs(server), args...)
	out, err := RunOutput(ctx, full, RunOpts{})
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// withTimeout creates a context with the default tmux timeout.
func withTimeout() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), TmuxTimeout)
}

// SessionInfo describes a tmux session.
type SessionInfo struct {
	Name  string  `json:"name"`
	Color *string `json:"color,omitempty"`
	// ID is the tmux session id (#{session_id}, "$N" form) — the canonical
	// target handle. Additive JSON key.
	ID string `json:"id,omitempty"`
	// Path is the session working directory (#{session_path}). Additive JSON key.
	Path string `json:"path,omitempty"`
	// Flair is the session's per-row flair decoration, sourced from the
	// SessionFlairOption session user option (scope-split from the window's
	// FlairOption — see SetSessionFlair): "" (unset)/"nyan"/"naruto"/"onepiece".
	// Unknown tokens are dropped to "" by parseSessions (the window-Marker
	// closed-set idiom).
	Flair string `json:"flair,omitempty"`
	// Windows is the session's window count (#{session_windows}), used for
	// the per-server rollup on GET /api/servers. Additive JSON key.
	Windows int `json:"windows"`
}

// parseSessions parses tmux list-sessions output lines into SessionInfo structs,
// filtering out session-group copies.
// Format: name, grouped, group, group_size, @rk_ses_color, windows, @rk_ses_flair,
// session_id, session_path (9 fields).
// Exported for testing.
func parseSessions(lines []string) []SessionInfo {
	type rawEntry struct {
		name      string
		grouped   bool
		group     string
		groupSize int
		colorStr  string
		windows   int
		flair     string
		id        string
		path      string
	}

	// Pass 1: parse all valid lines.
	var entries []rawEntry
	for _, line := range lines {
		parts := strings.Split(line, listDelim)
		if len(parts) < 2 {
			continue
		}
		// Filter run-kit's single-window hidden link-target sessions (board
		// pin-sessions and isolated relay sessions) from every user-facing
		// session list. A pinned/isolated window is LINKED into its hidden
		// session (it stays a member of its home session too, so it
		// still appears in the sidebar natively via its home membership); the
		// link-target session ITSELF is never a user-facing SESSIONS entry (a
		// pin-session is rendered only as a BOARDS pane; an iso session is a
		// relay attach target). This is the single chokepoint — every
		// consumer (REST, SSE, board derivation, server-aggregate) flows
		// through ListSessions/parseSessions, so a single early-skip here
		// guarantees no link-target session leaks into the SESSIONS UI while
		// the window is still shown under its home session.
		if IsHiddenLinkSession(parts[0]) {
			continue
		}
		// Filter the tmuxctl control-mode anchor session — owned by the
		// tmuxctl package, not user-visible. Single chokepoint mirrors the
		// rk-relay-* skip above so every consumer (REST, SSE, board
		// derivation, server-aggregate) excludes it automatically.
		if parts[0] == ControlAnchorSessionName {
			continue
		}
		e := rawEntry{name: parts[0], grouped: parts[1] == "1"}
		if len(parts) >= 3 {
			e.group = parts[2]
		}
		if len(parts) >= 4 {
			e.groupSize, _ = strconv.Atoi(parts[3])
		}
		if len(parts) >= 5 {
			e.colorStr = parts[4]
		}
		if len(parts) >= 6 {
			e.windows, _ = strconv.Atoi(parts[5])
		}
		if len(parts) >= 7 {
			// Flair is a closed-set token; drop any value outside the set
			// (including "") to the empty unset state — the window-Marker idiom.
			if f := strings.TrimSpace(parts[6]); validate.FlairValues[f] {
				e.flair = f
			}
		}
		if len(parts) >= 8 {
			e.id = parts[7]
		}
		if len(parts) >= 9 {
			e.path = parts[8]
		}
		entries = append(entries, e)
	}

	// Build set of groups that still have a name-matching leader.
	groupHasLeader := make(map[string]bool)
	for _, e := range entries {
		if e.grouped && e.name == e.group {
			groupHasLeader[e.group] = true
		}
	}

	// Pass 2: filter — keep ungrouped sessions, group leaders, sole members,
	// and one representative from leaderless groups (renamed leader).
	leaderlessIncluded := make(map[string]bool)
	var sessions []SessionInfo
	for _, e := range entries {
		keep := false
		switch {
		case !e.grouped:
			keep = true
		case e.name == e.group:
			keep = true
		case e.groupSize == 1:
			keep = true
		case !groupHasLeader[e.group] && !leaderlessIncluded[e.group]:
			// Leader was renamed — no session matches the group name.
			// Include the first member as representative.
			leaderlessIncluded[e.group] = true
			keep = true
		}
		if keep {
			si := SessionInfo{Name: e.name, Windows: e.windows, Flair: e.flair, ID: e.id, Path: e.path}
			// Color is a value descriptor ("4" / "1+3"); normalize the raw
			// option token, dropping anything malformed.
			if normalized, ok := validate.NormalizeColorValue(e.colorStr); ok {
				si.Color = &normalized
			}
			sessions = append(sessions, si)
		}
	}
	return sessions
}

// ListPinSessionNames returns every `_rk-pin-*` session name on the given
// server. Board membership is derived from these single-window pin-sessions and
// their session vars (`@rk_ses_pin_board`/`@rk_ses_pin_home`/`@rk_ses_pin_order`). Returns nil
// (no error) if the server is not running. Read-only.
func ListPinSessionNames(ctx context.Context, server string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	lines, err := tmuxExecServer(ctx, server, "list-sessions", "-F", "#{session_name}")
	if err != nil {
		if containsServerGoneText(err.Error()) {
			return nil, nil
		}
		return nil, err
	}
	var pins []string
	for _, name := range lines {
		if strings.HasPrefix(name, PinSessionPrefix) {
			pins = append(pins, name)
		}
	}
	return pins, nil
}

// ListSessions returns sessions from the specified tmux server,
// filtering out session-group copies and run-kit's hidden link-target
// sessions (pin/iso — see IsHiddenLinkSession). Returns nil if no server is running.
// sessionListFormat is the 9-field list-sessions format string consumed by
// parseSessions AND buildSessionFacts (session_facts.go) — shared so the two
// enumerations can never read differently-shaped lines: name, grouped, group,
// group_size, @rk_ses_color, windows, @rk_ses_flair, session_id, session_path.
func sessionListFormat() string {
	return fmt.Sprintf("#{session_name}%s#{session_grouped}%s#{session_group}%s#{session_group_size}%s#{%s}%s#{session_windows}%s#{%s}%s#{session_id}%s#{session_path}", listDelim, listDelim, listDelim, listDelim, SessionColorOption, listDelim, listDelim, SessionFlairOption, listDelim, listDelim)
}

func ListSessions(ctx context.Context, server string) ([]SessionInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	lines, err := tmuxExecList(ctx, server, "list-sessions", "-F", sessionListFormat())
	if err != nil {
		if containsServerGoneText(err.Error()) {
			return nil, nil
		}
		return nil, err
	}
	sessions := parseSessions(lines)

	if len(sessions) == 0 {
		return nil, nil
	}
	return sessions, nil
}

// ClientInfo describes one size-arbitrating tmux client attached to a session
// on a server — the per-viewer fact behind the sidebar's viewer count. The
// parse layer (parseClients) has already excluded the attach classes that never
// arbitrate window size, so every entry is a real viewer.
type ClientInfo struct {
	TTY    string
	Width  int
	Height int
	// SessionName is #{session_name} — the session the client is attached to
	// (a group copy's own name when attached via one, e.g. devshell-82).
	SessionName string
	// SessionGroup is #{session_group}: the group leader's name on current
	// tmux, an opaque NUMERIC group id on tmux 3.6a, "" when ungrouped.
	SessionGroup string
	// SessionGroupList is #{session_group_list} — the comma-separated MEMBER
	// NAMES, the reliable cross-version cross-reference to the UI session
	// (see baseGroupName).
	SessionGroupList string
	// Flags is #{client_flags} split on commas (attached, focused, UTF-8, …).
	Flags []string
	// PID is #{client_pid} — the attach process's pid; for an rk-forked
	// attach, the daemon's own child. 0 on a tmux too old to report it.
	PID int
	// Created is #{client_created} — when the client attached (zero when
	// absent or unparsable).
	Created time.Time
	// Activity is #{client_activity} — the client's last activity (zero when
	// absent or unparsable).
	Activity time.Time
	// TermName is #{client_termname}.
	TermName string
}

// SessionKey returns the UI session key this client's attach counts against:
// the group leader's name for a grouped attach (a client attached via a
// derived group copy sizes the same shared windows, so it must land on the
// leader row parseSessions keeps), else the session's own name. A digits-only
// SessionGroup is tmux 3.6a's numeric group id, not a name — it falls back to
// baseGroupName over the member-name list (whose first non-anchor member is
// the same representative parseSessions keeps for a leaderless group).
func (c ClientInfo) SessionKey() string {
	if c.SessionGroup != "" && !isNumericGroupID(c.SessionGroup) {
		return c.SessionGroup
	}
	return baseGroupName(c.SessionName, c.SessionGroupList)
}

// isNumericGroupID reports whether s is tmux 3.6a's opaque numeric
// #{session_group} id (all digits) rather than a session name. Session names
// are validated free of leading `=`/`.`/`:` but may be all digits in
// principle; the digits-only heuristic only misfires on an all-digit GROUP
// name, which tmux itself never produces (it names groups after the leader).
func isNumericGroupID(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return len(s) > 0
}

// clientFormat is the list-clients format string: client_tty, client_width,
// client_height, session_name, session_group, session_group_list,
// client_flags, client_pid, client_created, client_activity, client_termname
// (11 fields). session_group_list rides along because #{session_group} is an
// opaque numeric id on tmux 3.6a (see baseGroupName) — the member-name list is
// the cross-version join key. client_pid is the attach process — for an
// rk-forked attach, the daemon's own child. The trailing fields are append-only
// so a 7-field line from an older tmux still parses (with zero values).
var clientFormat = strings.Join([]string{
	"#{client_tty}",
	"#{client_width}",
	"#{client_height}",
	"#{session_name}",
	"#{session_group}",
	"#{session_group_list}",
	"#{client_flags}",
	"#{client_pid}",
	"#{client_created}",
	"#{client_activity}",
	"#{client_termname}",
}, listDelim)

// nonSizingClientFlags are the client_flags tokens whose attach class never
// participates in window-size arbitration — control-mode is how the rk
// daemon's tmuxctl subscription attaches to every server. Matched on the
// comma-split tokens, never as a substring of the whole flags string.
var nonSizingClientFlags = map[string]bool{
	"control-mode": true,
	"ignore-size":  true,
}

// parseClients parses tmux list-clients output lines into ClientInfo structs.
// Lines are 11-field tab-delimited per clientFormat; the 7-field floor keeps a
// legacy line from an older tmux (fields 7–10 stay zero — PID 0, zero times,
// empty TermName — and the viewer still survives). A non-parsable trailing
// field yields its zero value, never a dropped line. A line is dropped when
// its flags contain a nonSizingClientFlags token or when its width/height
// parses non-positive (an unsized client cannot arbitrate window size either).
// Exported for testing.
func parseClients(lines []string) []ClientInfo {
	var clients []ClientInfo
	for _, line := range lines {
		parts := strings.Split(line, listDelim)
		if len(parts) < 7 {
			continue
		}
		width, _ := strconv.Atoi(strings.TrimSpace(parts[1]))
		height, _ := strconv.Atoi(strings.TrimSpace(parts[2]))
		if width <= 0 || height <= 0 {
			continue
		}
		flags := strings.Split(parts[6], ",")
		excluded := false
		for _, f := range flags {
			if nonSizingClientFlags[strings.TrimSpace(f)] {
				excluded = true
				break
			}
		}
		if excluded {
			continue
		}
		ci := ClientInfo{
			TTY:              strings.TrimSpace(parts[0]),
			Width:            width,
			Height:           height,
			SessionName:      parts[3],
			SessionGroup:     parts[4],
			SessionGroupList: parts[5],
			Flags:            flags,
		}
		if len(parts) > 7 {
			ci.PID, _ = strconv.Atoi(strings.TrimSpace(parts[7]))
		}
		if len(parts) > 8 {
			if sec, err := strconv.ParseInt(strings.TrimSpace(parts[8]), 10, 64); err == nil {
				ci.Created = time.Unix(sec, 0)
			}
		}
		if len(parts) > 9 {
			if sec, err := strconv.ParseInt(strings.TrimSpace(parts[9]), 10, 64); err == nil {
				ci.Activity = time.Unix(sec, 0)
			}
		}
		if len(parts) > 10 {
			ci.TermName = parts[10]
		}
		clients = append(clients, ci)
	}
	return clients
}

// ListClients returns the size-arbitrating clients attached to sessions on the
// specified server — one tmux round-trip, same cost class as ListSessions.
// Returns nil, nil when the server is not running (the ListSessions idiom).
func ListClients(ctx context.Context, server string) ([]ClientInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	lines, err := tmuxExecServer(ctx, server, "list-clients", "-F", clientFormat)
	if err != nil {
		if containsServerGoneText(err.Error()) {
			return nil, nil
		}
		return nil, err
	}
	return parseClients(lines), nil
}

// parsePanes parses tmux list-panes output lines into a window-id→[]PaneInfo map.
// Lines are 11-field tab-delimited: window_id, pane_id, pane_index, cwd,
// command, is_active, @rk_agent_state, alternate_on, @rk_pane_agent_state,
// @rk_pane_chat, @rk_pane_agent_session. Field 0 (window_id) is consumed for
// grouping and not stored in PaneInfo. Lines with fewer than 11 fields are
// silently skipped. Empty input returns nil.
//
// The grouping key is the stable window ID (@N), NOT the window index: the
// panes come from a separate list-panes call than the windows they are joined
// to (ListWindows), and an index join silently glues the wrong session's panes
// onto a window whenever the two calls' targets diverge (the bare-name
// session/window target collision ExactSessionTarget guards against) or a
// concurrent reorder shifts indices between the calls. A window-id join can
// only attach a pane to the window that actually owns it — at worst a window
// gets an empty pane list, a visible degradation instead of wrong data.
//
// The agent-state raw value is dual-read: field 8 (@rk_pane_agent_state) wins
// when non-empty, else field 6 (@rk_agent_state); it is parsed into
// AgentState/AgentStateEpoch (+ an optional agent pid) via parseAgentState,
// then reconciled: pid-carrying values are trusted iff the agent process is
// alive (kill-0 liveness — precise, wrapper-launch-proof); legacy two-segment
// values fall back to the shell-command heuristic (a plain-shell pane has no
// agent — the guppi auto-clear lesson that prevents a stranded `active` after
// a kill).
//
// The agent-session raw value is dual-read the same way (field 10
// @rk_pane_agent_session wins, else field 9 @rk_pane_chat) and parsed into
// AgentProvider/AgentSessionRef via parseAgentSessionRef, reconciled by the
// SAME liveness signal: the agent-session option carries no pid, so a dead
// agent (or a plain-shell pane with no live pid-bearing agent-state) must not
// leave a live-looking session ref. The agent-session fields are zeroed on
// exactly the same condition that zeros the agent-state fields — a dead pid,
// or the shell-command fallback.
//
// Accessible to same-package tests.
func parsePanes(lines []string) map[string][]PaneInfo {
	if len(lines) == 0 {
		return nil
	}
	byWindow := make(map[string][]PaneInfo)
	for _, line := range lines {
		parts := strings.Split(line, listDelim)
		if len(parts) < 12 {
			continue
		}
		windowID := strings.TrimSpace(parts[0])
		if !ValidWindowID(windowID) {
			continue
		}

		paneIndex, err := strconv.Atoi(strings.TrimSpace(parts[2]))
		if err != nil {
			continue
		}
		isActive := strings.TrimSpace(parts[5]) == "1"
		command := strings.TrimSpace(parts[4])
		// An unparseable pane_pid is 0 (no walk root), never a skipped pane —
		// the pid is an enrichment, the row is the data.
		panePID, _ := strconv.Atoi(strings.TrimSpace(parts[11]))
		// Dual-read: the scope-named field wins when its trimmed value is
		// non-empty, else the retired previous-name field (both ride the same
		// list-panes call during the deprecation window). Trimming per field
		// matches the parse helpers' own TrimSpace, so a whitespace-only new
		// value never blocks the legacy fallback.
		agentStateRaw := strings.TrimSpace(parts[8])
		if agentStateRaw == "" {
			agentStateRaw = strings.TrimSpace(parts[6])
		}
		agentSessionRaw := strings.TrimSpace(parts[10])
		if agentSessionRaw == "" {
			agentSessionRaw = strings.TrimSpace(parts[9])
		}
		agentState, agentEpoch, agentPID := parseAgentState(agentStateRaw)
		agentProvider, agentSessionRef := parseAgentSessionRef(agentSessionRaw)
		altScreen := strings.TrimSpace(parts[7]) == "1"
		// Reconciler. Primary form (pid-carrying values from current
		// agent setup hooks): PID liveness — the state is trusted iff the agent
		// process is still alive, regardless of the pane's command name. This
		// fixes the wrapped-launch false negative (an agent started via a
		// non-exec'ing shell wrapper reports pane_current_command = "bash"
		// while genuinely running) and precisely clears state from a
		// killed/crashed agent. Legacy fallback (two-segment values, no pid):
		// the original shell-command heuristic — a plain-shell pane has no
		// agent regardless of a leftover value.
		//
		// stale is the single dead/no-agent decision shared by both tiers:
		// the agent-session option has no pid of its own, so it borrows the
		// same pane's agent-state liveness (written by the same binary on the
		// same fires) — a dead agent zeros BOTH the agent-state and
		// agent-session fields, and a plain-shell pane never surfaces an agent
		// session.
		if agentStateStale(agentPID, command) {
			agentState, agentEpoch, agentPID = "", 0, 0
			agentProvider, agentSessionRef = "", ""
		}
		p := PaneInfo{
			PaneID:          strings.TrimSpace(parts[1]),
			PaneIndex:       paneIndex,
			Cwd:             parts[3],
			Command:         command,
			IsActive:        isActive,
			PanePID:         panePID,
			AgentPID:        agentPID,
			AgentState:      agentState,
			AgentStateEpoch: agentEpoch,
			AgentProvider:   agentProvider,
			AgentSessionRef: agentSessionRef,
			AltScreen:       altScreen,
		}
		byWindow[windowID] = append(byWindow[windowID], p)
	}
	if len(byWindow) == 0 {
		return nil
	}
	return byWindow
}

// denseWebTabs walks the @rk_win_web_<n> slot values in order and stops at the
// first empty slot — a gap means everything after it is ignored (the write
// paths never produce gaps; a hand-written gap degrades to the prefix, never
// an error). Index 0 of the result is tmux slot 1.
func denseWebTabs(slots []string) []string {
	var tabs []string
	for _, s := range slots {
		s = strings.TrimSpace(s)
		if s == "" {
			break
		}
		tabs = append(tabs, s)
	}
	return tabs
}

// clampWebActive normalizes the raw @rk_win_web_active value against the dense
// tab count: 0 when there are no tabs; otherwise the stored 1-based index,
// clamped to 1 when non-numeric or out of range (degrade, never error —
// Constitution II: the option is left as written).
func clampWebActive(raw string, tabs int) int {
	if tabs == 0 {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || n < 1 || n > tabs {
		return 1
	}
	return n
}

// Positional field indices (0-based) of the ListWindows format string,
// derived from MaxWebTabs so a cap raise stays a one-line change. The format
// builder (ListWindows) spells the same order: listWindowsFixedPrefix fixed
// fields, the MaxWebTabs URL slots, then the trailing fields below, with the
// legacy note always LAST (its free-text tail is rejoined by parseWindows).
const (
	listWindowsFixedPrefix     = 9
	listWindowsWebActiveField  = listWindowsFixedPrefix + MaxWebTabs
	listWindowsCodeRootField   = listWindowsWebActiveField + 1
	listWindowsMarkerField     = listWindowsWebActiveField + 2
	listWindowsRoleField       = listWindowsWebActiveField + 3
	listWindowsFlairField      = listWindowsWebActiveField + 4
	listWindowsOwnerField      = listWindowsWebActiveField + 5
	listWindowsPrListenField   = listWindowsWebActiveField + 6
	listWindowsNoteField       = listWindowsWebActiveField + 7
	listWindowsLegacyURLField  = listWindowsWebActiveField + 8
	listWindowsLegacyLensField = listWindowsWebActiveField + 9
	listWindowsLegacyNoteField = listWindowsWebActiveField + 10
	// listWindowsFullFields is the field count of a complete current-format
	// line; a shorter line is a pre-16-slot capture (see legacyWebTabSlots),
	// whose format also predates @rk_win_pr_listen.
	listWindowsFullFields = listWindowsLegacyNoteField + 1
)

// parseWindows parses tmux list-windows output lines into WindowInfo structs.
// nowUnix is the current Unix timestamp for activity threshold computation.
// Lines carry listWindowsFixedPrefix + MaxWebTabs + 10 tab-delimited fields
// plus the legacy-note tail: window_id, window_index, window_name,
// pane_current_path, window_activity, window_active, pane_current_command,
// @rk_win_color, @rk_win_layout, @rk_win_web_1 .. @rk_win_web_<MaxWebTabs>,
// @rk_win_web_active, @rk_win_code_root, @rk_win_marker, @rk_win_role,
// @rk_win_flair, @rk_win_owner, @rk_win_pr_listen, then @rk_win_note as a
// STRICT SINGLE FIELD, then the retired @rk_win_url (dual-read web_1
// fallback), the retired @rk_win_lens (dual-read web-leaf layout fallback),
// then the legacy note LAST. Lines with fewer than 8 fields are skipped;
// fields 8+ are optional (empty string if absent). A line shorter than a full
// current-format line (listWindowsFullFields) is a pre-16-slot capture and
// parses with the 8-slot-era offsets (legacyWebTabSlots), which also carry no
// @rk_win_pr_listen field. The web-tab slots read dense (walk 1..MaxWebTabs,
// stop at the first empty) and web_active degrades
// (non-numeric/out-of-range clamps per clampWebActive, never an error). The
// note is dual-read: the new field wins when non-empty, else the legacy note,
// whose free-text tail is rejoined (tabs inside it would otherwise shift
// sibling columns); the new note rides one field because write-side
// validation strips control chars.
// Exported for testing.
func parseWindows(lines []string, nowUnix int64) []WindowInfo {
	var windows []WindowInfo
	for _, line := range lines {
		parts := strings.Split(line, listDelim)
		if len(parts) < 8 {
			continue
		}

		windowID := strings.TrimSpace(parts[0])
		index, _ := strconv.Atoi(parts[1])
		activityTs, _ := strconv.ParseInt(parts[4], 10, 64)

		activity := "idle"
		if nowUnix-activityTs <= ActivityThresholdSeconds {
			activity = "active"
		}
		isActive := strings.TrimSpace(parts[5]) == "1"
		paneCmd := strings.TrimSpace(parts[6])

		// Color is a value descriptor ("4" / "1+3"); normalize the raw option
		// token, dropping anything malformed.
		var color *string
		if normalized, ok := validate.NormalizeColorValue(parts[7]); ok {
			color = &normalized
		}

		var layout string
		var webTabs []string
		var webActive int
		var codeRoot string
		if len(parts) >= listWindowsFixedPrefix {
			layout = strings.TrimSpace(parts[listWindowsFixedPrefix-1])
		}
		// The web slots are positional: a shorter line carries only its leading
		// slots — walk what is present (denseWebTabs stops at the first empty).
		// A line shorter than a full current-format line is a pre-16-slot
		// capture: parse it with the 8-slot-era offsets (legacyWebTabSlots) so
		// its trailing fields land where that format put them.
		slots := MaxWebTabs
		if len(parts) < listWindowsFullFields {
			slots = legacyWebTabSlots
		}
		webActiveField := listWindowsFixedPrefix + slots
		codeRootField := webActiveField + 1
		markerField := webActiveField + 2
		roleField := webActiveField + 3
		flairField := webActiveField + 4
		ownerField := webActiveField + 5
		// The 8-slot era predates @rk_win_pr_listen: its note follows owner.
		prListenField := -1
		noteField := webActiveField + 6
		if slots == MaxWebTabs {
			prListenField = noteField
			noteField++
		}
		legacyURLField := noteField + 1
		legacyLensField := noteField + 2
		legacyNoteField := noteField + 3
		if len(parts) > listWindowsFixedPrefix {
			end := min(webActiveField, len(parts))
			webTabs = denseWebTabs(parts[listWindowsFixedPrefix:end])
		}
		var activeRaw string
		if len(parts) > webActiveField {
			activeRaw = parts[webActiveField]
		}
		webActive = clampWebActive(activeRaw, len(webTabs))
		if len(parts) > codeRootField {
			codeRoot = strings.TrimSpace(parts[codeRootField])
		}

		// Marker is a closed-set `<mode>[:<stage>]` token. Legacy flat tokens
		// normalize forward on read; anything unknown drops to the unset state.
		var marker string
		if len(parts) > markerField {
			marker = NormalizeMarker(strings.TrimSpace(parts[markerField]))
		}

		// Role is a closed-set token ("operator"); drop any value outside the
		// set (including "") to the empty unset state. Same idiom as Marker.
		var role string
		if len(parts) > roleField {
			if r := strings.TrimSpace(parts[roleField]); validate.RoleValues[r] {
				role = r
			}
		}

		// Flair is a closed-set token ("nyan"/"naruto"/"onepiece"); drop any
		// value outside the set (including "") to the empty unset state. Same
		// idiom as Marker.
		var flair string
		if len(parts) > flairField {
			if f := strings.TrimSpace(parts[flairField]); validate.FlairValues[f] {
				flair = f
			}
		}

		// Owner is a closed-set token ("operator"); unknown non-empty tokens
		// drop to the empty unset state. Same idiom as Marker.
		var owner string
		if len(parts) > ownerField {
			if o := strings.TrimSpace(parts[ownerField]); validate.OwnerValues[o] {
				owner = o
			}
		}

		// PrListen arms the PR-review comment listener. Only the exact "1"
		// arms: the listener delivers work into an agent pane, so an
		// unrecognized value fails CLOSED.
		var prListen bool
		if prListenField >= 0 && len(parts) > prListenField {
			prListen = strings.TrimSpace(parts[prListenField]) == "1"
		}

		// Note is free text ("<epoch>:<text>"), NOT a closed set — no value
		// validation. Dual-read: the new note is a strict single field (joining
		// is WRONG for it) and wins when non-empty; the legacy note is the
		// format's last column, so its tail is rejoined to survive tabs inside
		// the text. Tolerant epoch split: a non-numeric prefix keeps the whole
		// value as text with epoch 0.
		var note string
		var noteEpoch int64
		var rawNote string
		if len(parts) > noteField {
			rawNote = parts[noteField]
		}
		// Retired @rk_win_url is the dual-read fallback for an empty slot 1:
		// external writers may still stamp it live, where the once-per-server
		// sweep cannot see it, so the family surfaces it as web_1 with the
		// active pointer defaulted — the same shape a first WebAdd produces.
		// Compat until the cleanup change removes the fallback.
		if len(webTabs) == 0 && len(parts) > legacyURLField {
			if legacyURL := strings.TrimSpace(parts[legacyURLField]); legacyURL != "" {
				webTabs = []string{legacyURL}
				webActive = 1
			}
		}
		// Retired @rk_win_lens: "iframe" was the web default-view hint; with
		// @rk_win_layout unset it reads as the web-leaf layout the migration row
		// would write — the same live-stamp dual-read as web_1.
		if layout == "" && len(parts) > legacyLensField {
			if legacyLens := strings.TrimSpace(parts[legacyLensField]); legacyLens == "iframe" {
				layout = layoutspecSingleWeb
			}
		}
		if rawNote == "" && len(parts) > legacyNoteField {
			rawNote = strings.Join(parts[legacyNoteField:], listDelim)
		}
		if rawNote != "" {
			note, noteEpoch = parseNoteValue(rawNote)
		}

		windows = append(windows, WindowInfo{
			Index:             index,
			WindowID:          windowID,
			Name:              parts[2],
			WorktreePath:      parts[3],
			Activity:          activity,
			IsActiveWindow:    isActive,
			PaneCommand:       paneCmd,
			ActivityTimestamp: activityTs,
			Color:             color,
			Layout:            layout,
			WebTabs:           webTabs,
			WebActive:         webActive,
			CodeRoot:          codeRoot,
			Marker:            marker,
			Role:              role,
			Flair:             flair,
			Owner:             owner,
			PrListen:          prListen,
			Note:              note,
			NoteEpoch:         noteEpoch,
		})
	}
	return windows
}

// parseNoteValue splits a note option value ("<unix-epoch>:<text>") into its
// text and epoch. Tolerant: a missing colon or a non-numeric prefix keeps the
// whole value as text with epoch 0 (rendered without an age, never dropped).
func parseNoteValue(raw string) (string, int64) {
	prefix, text, found := strings.Cut(raw, ":")
	if !found {
		return raw, 0
	}
	epoch, err := strconv.ParseInt(prefix, 10, 64)
	if err != nil || epoch < 0 {
		return raw, 0
	}
	return text, epoch
}

// paneFormat is the list-panes format string: window_id, pane_id, pane_index,
// pane_current_path, pane_current_command, pane_active, @rk_agent_state,
// alternate_on, @rk_pane_agent_state, @rk_pane_chat, @rk_pane_agent_session,
// pane_pid (12 fields). Each pair dual-reads a retired name under its
// scope-named successor — agent-state: field 6 (unscoped, retired) under field
// 8; agent-session: field 9 (@rk_pane_chat) under field 10 — new wins during
// the deprecation window (the @rk_win_note dual-read precedent); the follow-up
// removal change drops 6 and 9. The agent-state/agent-session fields carry the
// generic agent-lifecycle state and the pane→agent-session mapping (see
// AgentStateOption / AgentSessionOption / docs/specs/agent-state.md); field 11
// (pane_pid) is the walk root for the mux panes liveness check. None of them
// cost an extra subprocess since they ride the existing list-panes call.
var paneFormat = strings.Join([]string{
	"#{window_id}",
	"#{pane_id}",
	"#{pane_index}",
	"#{pane_current_path}",
	"#{pane_current_command}",
	"#{pane_active}",
	"#{" + LegacyAgentStateOption + "}",
	"#{alternate_on}",
	"#{" + AgentStateOption + "}",
	"#{" + LegacyAgentSessionOption + "}",
	"#{" + AgentSessionOption + "}",
	"#{pane_pid}",
}, listDelim)

// ListWindows returns windows for a given session on the specified server.
// Returns nil if session does not exist.
// Pane data is populated from a separate list-panes call; failure of that call
// is non-fatal — windows are returned with empty Panes fields.
func ListWindows(ctx context.Context, session string, server string) ([]WindowInfo, error) {
	return listWindows(ctx, session, server, false)
}

// ListWindowsStrict preserves list-windows/list-panes errors for live CLI
// inventories. Dashboard callers keep ListWindows' session-disappeared tolerance.
func ListWindowsStrict(ctx context.Context, session string, server string) ([]WindowInfo, error) {
	return listWindows(ctx, session, server, true)
}

func listWindows(ctx context.Context, session string, server string, strict bool) ([]WindowInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	fields := []string{
		"#{window_id}",
		"#{window_index}",
		"#{window_name}",
		"#{pane_current_path}",
		"#{window_activity}",
		"#{window_active}",
		"#{pane_current_command}",
		"#{" + ColorOption + "}",
		"#{" + LayoutOption + "}",
	}
	// The indexed web-tab family is spelled out slot by slot — one fixed format
	// string cannot enumerate a family (see MaxWebTabs).
	for n := 1; n <= MaxWebTabs; n++ {
		fields = append(fields, "#{"+WebTabOption(n)+"}")
	}
	fields = append(fields,
		"#{"+WebActiveOption+"}",
		"#{"+CodeRootOption+"}",
		"#{"+MarkerOption+"}",
		"#{"+RoleOption+"}",
		"#{"+FlairOption+"}",
		"#{"+OwnerOption+"}",
		// The PR-review listener arm rides the payload rather than a per-window
		// option read: the listener advances on the SSE tick, which must stay
		// subprocess-free.
		"#{"+PrListenOption+"}",
		// The new note is a strict single field (write-side validation strips
		// control chars). legacyWinURLOption is the retired @rk_win_url, dual-read
		// as a web_1 fallback and legacyWinLensOption the retired @rk_win_lens,
		// dual-read as a web-leaf layout fallback (both are stamped live by
		// external writers mid-session — the once-per-server sweep cannot see
		// them). The legacy note is free text in a tab-delimited format — it MUST
		// stay the last field so parseWindows can rejoin the tail (tabs inside the
		// text would otherwise shift sibling columns).
		"#{"+NoteOption+"}",
		"#{"+legacyWinURLOption+"}",
		"#{"+legacyWinLensOption+"}",
		"#{"+legacyNoteOption+"}",
	)
	format := strings.Join(fields, listDelim)

	lines, err := tmuxExecList(ctx, server, "list-windows", "-t", ExactSessionTarget(session), "-F", format)
	if err != nil {
		// Undelimited output is present but unparseable and must not read as
		// a window-less session; every other error is the session-gone-mid-tick
		// tolerance.
		if strict || errors.Is(err, ErrNoFieldDelimiter) {
			return nil, err
		}
		return nil, nil
	}

	windows := parseWindows(lines, time.Now().Unix())

	// Fetch pane data — non-fatal if list-panes fails (e.g., session disappears mid-tick).
	paneLines, paneErr := tmuxExecServer(ctx, server, "list-panes", "-s", "-t", ExactSessionTarget(session), "-F", paneFormat)
	if strict && paneErr == nil {
		paneErr = checkDelimited(paneLines)
	}
	if strict && paneErr != nil {
		return nil, fmt.Errorf("list panes: %w", paneErr)
	}
	if paneErr == nil {
		byWindow := parsePanes(paneLines)
		if byWindow != nil {
			for i := range windows {
				windows[i].Panes = byWindow[windows[i].WindowID]
			}
		}
	}

	return windows, nil
}

// ActiveWindowID returns the id (@N) of the active window in the given session
// on the specified server. The target uses the exact-match session form
// (`=<session>:`): a bare session target is a window-target collision hazard —
// session names and window names share the folder-basename auto-naming pool, so
// an ambiguous `session:` token can resolve to a window instead of the session.
func ActiveWindowID(ctx context.Context, server, session string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	lines, err := tmuxExecServer(ctx, server, "display-message", "-p", "-t", ExactSessionTarget(session), "#{window_id}")
	if err != nil {
		return "", err
	}
	if len(lines) == 0 {
		return "", fmt.Errorf("no active window reported for session %q", session)
	}
	return lines[0], nil
}

// baseGroupName returns the user-facing base session name for a session group,
// given the session's own name and its `#{session_group_list}` value (a
// comma-separated list of MEMBER NAMES). The base is the member that is not the
// _rk-ctl anchor — i.e. the real, user-facing session that the dashboard keys
// on. (Relay ephemerals no longer exist, so only the anchor is filtered.) When
// the list is empty (ungrouped session) or yields no qualifying member, the
// session's own name is returned.
//
// This MUST NOT key on `#{session_group}`: tmux 3.6a reports that field as an
// opaque NUMERIC group id (e.g. "0"), not the leader's name — so `name ==
// session_group` is never true for real grouped sessions. The group-list is the
// reliable cross-reference to the base session name. The returned name is the
// same value `parseSessions` keeps as `SessionInfo.Name`, so the active-window
// tracker keys (event + re-seed) align with the derivation lookup in
// internal/sessions.
func baseGroupName(name, groupList string) string {
	for _, member := range strings.Split(groupList, ",") {
		m := strings.TrimSpace(member)
		if m == "" {
			continue
		}
		if m == ControlAnchorSessionName {
			continue
		}
		return m
	}
	return name
}

// parseSessionGroups parses `list-sessions` output of the form
// `#{session_id}<delim>#{session_name}<delim>#{session_group_list}` into a
// `$sid`→base-session-name map. The _rk-ctl anchor is NOT filtered here — it
// shares its base session's group, so its `$sid` must resolve to the SAME base
// name for an active-window event fired against the anchor member to update the
// correct (user-facing) group. The
// group key is the base session name (via baseGroupName), NOT tmux's numeric
// `#{session_group}` id, so it matches the `SessionInfo.Name` the derivation
// path looks up. Lines with fewer than 3 fields are skipped. Exported
// (same-package) for testing.
func parseSessionGroups(lines []string) map[string]string {
	out := make(map[string]string, len(lines))
	for _, line := range lines {
		parts := strings.Split(line, listDelim)
		if len(parts) < 3 {
			continue
		}
		sid := strings.TrimSpace(parts[0])
		name := strings.TrimSpace(parts[1])
		groupList := strings.TrimSpace(parts[2])
		if sid == "" {
			continue
		}
		group := baseGroupName(name, groupList)
		if group == "" {
			continue
		}
		out[sid] = group
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// ListSessionGroups returns a `$sid`→session-group map for the server, used by
// the active-window tracker to resolve the `$sid` carried by
// `%session-window-changed` to a group in O(1). Ungrouped sessions fall back to
// their own name as the group key (see parseSessionGroups). Returns nil (no
// error) when the server is not running. Read-only — never mutates sessions
// (Constitution §VI).
func ListSessionGroups(ctx context.Context, server string) (map[string]string, error) {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	format := strings.Join([]string{
		"#{session_id}",
		"#{session_name}",
		"#{session_group_list}",
	}, listDelim)

	lines, err := tmuxExecServer(ctx, server, "list-sessions", "-F", format)
	if err != nil {
		if containsServerGoneText(err.Error()) {
			return nil, nil
		}
		return nil, err
	}
	return parseSessionGroups(lines), nil
}

// parseActiveWindowsByGroup parses `list-windows -a` output of the form
// `#{session_group_list}<delim>#{session_name}<delim>#{window_id}<delim>#{window_active}`
// into a base-session-name→active-`@wid` map for use as the Tier-1 re-seed.
//
// In a session group, EACH member carries its own active-window pointer, so
// `list-windows -a` emits one `window_active=1` row per member. The seed MUST
// reflect the BASE (user-facing) session's pointer — the same signal Tier 2
// reads — so only the row whose `#{session_name}` IS the base name (derived from
// `#{session_group_list}` via baseGroupName, never tmux's numeric
// `#{session_group}`) is honored. The map is keyed by that base name so it
// aligns with both parseSessionGroups and the derivation lookup
// (SessionInfo.Name). Ungrouped sessions have an empty group-list, so the base
// is their own name and their sole `window_active=1` row is taken. As a
// best-effort fallback, if a group never produces a base-member row in this
// listing (e.g. the base session is momentarily absent), the first active row
// for that base name is recorded. Lines with fewer than 4 fields are skipped.
// Exported (same-package) for testing.
func parseActiveWindowsByGroup(lines []string) map[string]string {
	out := make(map[string]string)
	baseSeen := make(map[string]bool)
	for _, line := range lines {
		parts := strings.Split(line, listDelim)
		if len(parts) < 4 {
			continue
		}
		groupList := strings.TrimSpace(parts[0])
		name := strings.TrimSpace(parts[1])
		wid := strings.TrimSpace(parts[2])
		active := strings.TrimSpace(parts[3]) == "1"
		if !active || wid == "" {
			continue
		}
		base := baseGroupName(name, groupList)
		if base == "" {
			continue
		}
		if name == base {
			// The base session's own pointer is authoritative for the seed.
			out[base] = wid
			baseSeen[base] = true
			continue
		}
		// Non-base (anchor) row — only used as a fallback if the
		// group never produces a base-member row in this listing.
		if !baseSeen[base] {
			if _, ok := out[base]; !ok {
				out[base] = wid
			}
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// ListActiveWindowsByGroup returns a group→active-`@wid` map snapshotting the
// current active window per session group, used to re-seed the active-window
// tracker on control-client (re)connect. tmux does NOT replay
// `%session-window-changed` on a fresh `-CC` attach, so without this seed the
// tracker would be empty (cold start) or stale (reconnect). Returns nil (no
// error) when the server is not running. Read-only — never mutates sessions
// (Constitution §VI).
func ListActiveWindowsByGroup(ctx context.Context, server string) (map[string]string, error) {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	format := strings.Join([]string{
		"#{session_group_list}",
		"#{session_name}",
		"#{window_id}",
		"#{window_active}",
	}, listDelim)

	lines, err := tmuxExecServer(ctx, server, "list-windows", "-a", "-F", format)
	if err != nil {
		if containsServerGoneText(err.Error()) {
			return nil, nil
		}
		return nil, err
	}
	return parseActiveWindowsByGroup(lines), nil
}

// CreateSession creates a new detached tmux session on the specified server,
// optionally in a specific directory.
//
// Because new-session may start the tmux server process, the command runs "as
// if the user had started tmux from $HOME" — on both halves of that contract:
//
//   - Environment (see sanitizeEnv): direnv's DIRENV_DIFF is reverse-applied so
//     the server is born with the operator's from-home environment, and
//     rk-owned (RK_*) and direnv-state (DIRENV_*) vars are stripped. Without
//     this, a server first-touched by the rk daemon inherits run-kit's
//     direnv-polluted environment (WORKTREE_INIT_SCRIPT, IDEAS_FILE,
//     RK_PORT/RK_HOST, RK_DAEMON_LOG, a direnv-mangled PATH), leaking run-kit's
//     project config into unrelated repos.
//   - Working directory (see ServerBirthDir): the exec runs with cmd.Dir pinned
//     to the operator's home, so a server this call births never inherits rk's
//     own CWD. A tmux server keeps the CWD of the process that first touches
//     its socket for its whole life; inheriting rk's CWD (often a git worktree
//     that is later deleted) parks the server on a dead inode — on tmux 3.7 the
//     server-side chdir guard (`getcwd` in spawn.c) then fails and every new
//     pane silently ignores its `-c` path. The explicit cwd argument still
//     lands as `-c` on the session itself; the Dir pin anchors only the server
//     process and the session's default start dir.
func CreateSession(name string, cwd string, server string) error {
	ctx, cancel := withTimeout()
	defer cancel()

	// new-session starts the tmux server when the socket is dead/absent; only
	// a create that births the server earns the ManagedOption stamp.
	birthsServer := !probeServerAlive(ctx, server)

	// new-session may start the tmux server, so pass -f to load our config.
	args := configArgs()
	args = append(args, "new-session", "-d", "-s", name)
	if cwd != "" {
		args = append(args, "-c", cwd)
	}

	full := append(serverArgs(server), args...)
	// Server-birth-capable invocation: the env/dir overrides ensure the born
	// server never inherits rk's own environment or CWD (see doc comment above).
	if err := Run(ctx, full, RunOpts{Env: CleanEnvForServer(), Dir: ServerBirthDir()}); err != nil {
		return err
	}
	stampManagedOnBirth(ctx, server, birthsServer)
	return nil
}

// ServerBirthDir returns the working directory every rk-birthed tmux server
// (and rk-created pin-session) is anchored to: the operator's home directory,
// falling back to "/" when the home cannot be resolved. "/" always exists and
// can never dangle — mirroring tmux ≤ 3.6a's own child-side fallback chain
// (target → $HOME → /). $HOME is what a login-shell-started tmux would give,
// so it is the least-surprising stable anchor. Shared by CreateSession,
// board.go's pin-session create, daemon.startSession, and
// tmuxctl.createAnchor.
func ServerBirthDir() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "/"
	}
	return home
}

// cleanPATH is the POSIX default PATH used only as a last-resort guard when the
// sanitized environment carries no PATH at all (see sanitizeEnv). It is no
// longer an unconditional reset — the direnv-reversed environment carries the
// operator's true from-home PATH.
const cleanPATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

// CleanEnvForServer returns a sanitized copy of the current environment for a
// tmux server rk is about to birth. See sanitizeEnv. Exported so every
// birth-capable seam shares one sanitization (CreateSession here;
// tmuxctl.createAnchor cross-package).
func CleanEnvForServer() []string {
	return sanitizeEnv(os.Environ())
}

// sanitizeEnv produces the environment for a user-facing tmux server born by
// rk, targeting the semantics "as if the user had started tmux from $HOME":
//
//  1. Reverse-apply direnv's DIRENV_DIFF (undoing run-kit's .envrc changes,
//     including restoring the operator's true pre-direnv PATH). A malformed
//     diff is logged and treated as absent — sanitization never fails hard.
//  2. Strip all RK_*-prefixed vars (RK_DAEMON_LOG, RK_PORT, RK_HOST, ...): rk
//     adds these post-direnv so diff reversal does not catch them.
//  3. Strip all DIRENV_*-prefixed vars (incl. DIRENV_DIFF itself): direnv
//     excludes its own state vars from the diff, so reversal leaves them; a
//     from-home shell has none.
//  4. As a last-resort guard, inject PATH=cleanPATH only if no PATH survives,
//     so the tmux server never starts with an empty PATH.
//  5. Re-apply tmux's UTF-8 client rule (applyUTF8Locale): step 1 can remove a
//     locale variable direnv had set, or restore a non-UTF-8 one, and a server
//     born locale-less hands that env to every pane it ever opens.
func sanitizeEnv(environ []string) []string {
	reversed, err := reverseDirenvDiff(environ)
	if err != nil {
		slog.Warn("direnv diff reversal failed; passing env through with strips",
			"err", err,
		)
		reversed = environ
	}

	env := make([]string, 0, len(reversed)+1)
	pathSeen := false
	for _, e := range reversed {
		if strings.HasPrefix(e, "RK_") || strings.HasPrefix(e, "DIRENV_") {
			continue
		}
		if strings.HasPrefix(e, "PATH=") {
			pathSeen = true
		}
		env = append(env, e)
	}
	if !pathSeen {
		env = append(env, "PATH="+cleanPATH)
	}
	return applyUTF8Locale(env)
}

// buildCreateWindowArgs builds the argv slice (after the "tmux" binary and any
// -L server prefix) for a plain window create. When name is empty the -n token
// is omitted entirely, so tmux applies its automatic-rename-format
// ('#{b:pane_current_path}' in the embedded configs) and the window names itself
// to the folder basename immediately — no rename round-trip is needed because
// -c cwd is passed on the create. A non-empty name pins the window (tmux
// disables automatic-rename on an explicit name), which is the desired behavior
// for deliberately named windows. Pure, no side effects, so the -n-conditional
// branch is unit-testable without a live tmux server (mirrors riff.go's
// buildNewWindowArgs).
func buildCreateWindowArgs(session, name, cwd string) []string {
	args := []string{"new-window", "-a", "-t", ExactSessionTarget(session)}
	if name != "" {
		args = append(args, "-n", name)
	}
	args = append(args, "-c", cwd)
	return args
}

// CreateWindow creates a new window in an existing session on the specified server.
// An empty name lets tmux auto-name the window to its folder basename (see
// buildCreateWindowArgs); a non-empty name pins it.
func CreateWindow(session, name, cwd string, server string) error {
	ctx, cancel := withTimeout()
	defer cancel()

	_, err := tmuxExecServer(ctx, server, buildCreateWindowArgs(session, name, cwd)...)
	return err
}

// killAudit emits a loud, durable WARN line before any tmux teardown so that
// post-mortem analysis can answer "who killed this server/session?". It is
// deliberately WARN (not Debug) because the failures it diagnoses — a real
// user session or whole server vanishing unexpectedly — are rare and we want
// the evidence to survive the default log level and the daemon log tee
// (RK_DAEMON_LOG). The `audit=kill` field makes every teardown greppable:
//
//	grep 'audit=kill' ~/Library/Caches/rk/daemon.log
//
// `callers` captures the immediate call chain (skipping killAudit + the kill
// wrapper itself) so an unexpected `kit` teardown points straight at the
// responsible code path (HTTP handler, relay cleanup, sweep, daemon reap).
func killAudit(op, server, target string) {
	slog.Warn("tmux teardown",
		"audit", "kill",
		"op", op,
		"server", server,
		"target", target,
		"callers", callerChain(2, 4),
	)
}

// callerChain returns a "file:line<-file:line<-…" string of up to `depth`
// frames starting `skip` levels above callerChain itself. Used only for audit
// logging — kept allocation-light and never on a hot path.
func callerChain(skip, depth int) string {
	pcs := make([]uintptr, depth)
	n := runtime.Callers(skip+1, pcs)
	if n == 0 {
		return "unknown"
	}
	frames := runtime.CallersFrames(pcs[:n])
	var b strings.Builder
	for i := 0; ; i++ {
		frame, more := frames.Next()
		if i > 0 {
			b.WriteString("<-")
		}
		b.WriteString(fmt.Sprintf("%s:%d", filepath.Base(frame.File), frame.Line))
		if !more {
			break
		}
	}
	return b.String()
}

// KillSession kills an entire tmux session on the specified server. Uses the
// default tmux timeout via context.Background — see KillSessionCtx for callers
// that need to supply their own context (e.g., relay handler cleanup that runs
// after the request context is cancelled).
func KillSession(session string, server string) error {
	return KillSessionCtx(context.Background(), server, session)
}

// KillSessionCtx kills a tmux session, scoping the underlying tmux call to the
// provided parent context wrapped with TmuxTimeout. Callers that need cleanup
// to survive request-context cancellation MUST pass context.Background() — the
// relay handler's deferred cleanup is the canonical use case.
func KillSessionCtx(ctx context.Context, server, session string) error {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	killAudit("kill-session", server, session)
	_, err := tmuxExecServer(ctx, server, "kill-session", "-t", ExactSessionTarget(session))
	return err
}

// ResolveWindowSession returns the window's HOME (non-pin, non-iso) session on
// the given server. A pinned or isolated window is a member of TWO sessions at
// once — its home session AND its single-window `_rk-pin-*`/`_rk-iso-*` session
// (both Pin and EnsureIsoSession use link-window, not move-window) — so a naive
// `display-message -t <windowID> -p "#{session_name}"` may report EITHER link
// (tmux's pick across links is order-unspecified). When the naive result is a
// hidden link-target name, this re-resolves deterministically to the non-hidden
// owner by enumerating `list-windows -a` and choosing the session for @N that
// is not a `_rk-pin-*`/`_rk-iso-*` name. A window whose ONLY link is its
// pin/iso session (its home session died while pinned/isolated, or a legacy
// move-based pin) legitimately resolves to that link-target session.
// The relay layers its own pin-session-first attach preference ABOVE this (see
// api/terminals_ws.go); this function's job is to name the home session for
// callers that need it (the REST /select handler, ProjectRoot).
//
// Not-found contract: callers (e.g. the relay) rely on a missing window
// surfacing as `window %q not found`. On tmux 3.6a, `display-message` for a
// missing `-t @N` exits 0 with empty stdout, so the empty-result guard is the
// primary not-found path. A tmux error whose stderr names a missing window
// (other tmux versions/phrasings) is also mapped to the same contract; genuine
// operational errors (dead server, deadline) are returned unchanged so callers
// can distinguish "window gone" from "tmux unavailable".
func ResolveWindowSession(ctx context.Context, server, windowID string) (string, error) {
	lines, err := tmuxExecServer(ctx, server, "display-message", "-t", windowID, "-p", "#{session_name}")
	if err != nil {
		if isMissingWindowErr(err) {
			return "", fmt.Errorf("window %q not found", windowID)
		}
		return "", err
	}
	if len(lines) == 0 {
		return "", fmt.Errorf("window %q not found", windowID)
	}
	session := strings.TrimSpace(lines[0])
	if session == "" {
		return "", fmt.Errorf("window %q not found", windowID)
	}
	// Dual membership: if tmux named a hidden link-target session (pin or
	// iso), re-resolve to the home (non-pin, non-iso) session. A window whose
	// only link is its pin/iso session keeps it (home is gone).
	if IsHiddenLinkSession(session) {
		if home, ok, herr := resolveHomeSession(ctx, server, windowID); herr != nil {
			return "", herr
		} else if ok {
			return home, nil
		}
	}
	return session, nil
}

// resolveHomeSession enumerates every session the window identified by windowID
// is linked into (via `list-windows -a`) and returns the first non-hidden
// (non-pin, non-iso) session. ok is false when the window is linked ONLY into
// hidden link-target sessions — i.e. it has no live home session — in which
// case the caller keeps the pin/iso session as the resolved owner. Read-only.
func resolveHomeSession(ctx context.Context, server, windowID string) (string, bool, error) {
	lines, err := tmuxExecServer(ctx, server, "list-windows", "-a", "-F", "#{session_name}\t#{window_id}")
	if err != nil {
		return "", false, err
	}
	for _, line := range lines {
		parts := strings.SplitN(strings.TrimSpace(line), "\t", 2)
		if len(parts) != 2 {
			continue
		}
		name := strings.TrimSpace(parts[0])
		wid := strings.TrimSpace(parts[1])
		if wid != windowID {
			continue
		}
		if IsHiddenLinkSession(name) {
			continue
		}
		return name, true, nil
	}
	return "", false, nil
}

// isMissingWindowErr reports whether err's stderr text matches tmux's
// missing-window phrasings (e.g. "can't find window: @N"). Used to map a tmux
// target-not-found error back to the not-found contract without swallowing
// operational failures (a dead server reports different stderr — see
// serverGoneText).
func isMissingWindowErr(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "can't find window") ||
		strings.Contains(msg, "window not found")
}

// resolveWindowSessionIndex resolves both the owning session name and the current
// window index for the window identified by windowID. Used by positional
// operations (MoveWindow) that must translate a stable ID into a mutable index.
func resolveWindowSessionIndex(ctx context.Context, server, windowID string) (string, int, error) {
	lines, err := tmuxExecServer(ctx, server, "display-message", "-t", windowID, "-p", "#{session_name}\t#{window_index}")
	if err != nil {
		return "", 0, err
	}
	if len(lines) == 0 {
		return "", 0, fmt.Errorf("window %q not found", windowID)
	}
	parts := strings.SplitN(strings.TrimSpace(lines[0]), "\t", 2)
	if len(parts) != 2 || parts[0] == "" {
		return "", 0, fmt.Errorf("window %q: unexpected display-message output %q", windowID, lines[0])
	}
	idx, err := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err != nil {
		return "", 0, fmt.Errorf("window %q: parse window index %q: %w", windowID, parts[1], err)
	}
	return parts[0], idx, nil
}

// MoveWindow reorders the window identified by windowID to before dstIndex within
// its own session, shifting intermediate windows via adjacent swaps. This gives
// "insert before" semantics (e.g., moving index 0 to index 2 in [a b c d] produces
// [b a c d]). The source is addressed by its stable window ID; reorder is inherently
// positional, so the destination remains a numeric index. The window's ID is
// preserved by the swaps (tmux move-window/swap-window contract).
//
// Active-window preservation: tmux pins a session's active window to its *index
// slot* during swap-window, so after the shuffle a DIFFERENT window would occupy
// the active slot. To keep the user's viewed terminal from drifting, the session's
// active window ID is captured before the swaps (from the same list-windows call)
// and restored with a final session-qualified select-window (-t <session>:@N)
// appended to the SAME \;-chained invocation — atomic, so no SSE poll or concurrent
// mutation observes the intermediate active-window state. The target is
// session-qualified rather than a bare @N because a bare window-id select is
// ambiguous inside a tmux session group (see SelectWindowInSession). Restoring by
// stable window ID also handles the edge where the dragged window is itself the
// active one.
func MoveWindow(windowID string, dstIndex int, server string) error {
	ctx, cancel := withTimeout()
	defer cancel()

	// Resolve the owning session and the source window's current index from its
	// stable window ID. Index is needed because the reorder is positional.
	session, srcIndex, err := resolveWindowSessionIndex(ctx, server, windowID)
	if err != nil {
		return err
	}
	if srcIndex == dstIndex {
		return nil
	}

	// Get sorted window indices so we can bubble via adjacent swaps, and — from the
	// same call, no extra subprocess — the active window's stable ID so it can be
	// restored after the shuffle (tmux otherwise pins the active window to its index
	// slot, drifting it to whatever window lands there).
	out, err := tmuxExecServer(ctx, server, "list-windows", "-t", ExactSessionTarget(session), "-F", "#{window_index}\t#{window_active}\t#{window_id}")
	if err != nil {
		return fmt.Errorf("list windows: %w", err)
	}

	var indices []int
	var activeWindowID string
	for _, line := range out {
		fields := strings.Split(strings.TrimSpace(line), "\t")
		if len(fields) < 3 {
			continue
		}
		idx, err := strconv.Atoi(strings.TrimSpace(fields[0]))
		if err != nil {
			continue
		}
		indices = append(indices, idx)
		if strings.TrimSpace(fields[1]) == "1" {
			activeWindowID = strings.TrimSpace(fields[2])
		}
	}
	sort.Ints(indices)

	srcPos, dstPos := -1, -1
	for i, idx := range indices {
		if idx == srcIndex {
			srcPos = i
		}
		if idx == dstIndex {
			dstPos = i
		}
	}
	if srcPos < 0 {
		return fmt.Errorf("source window index %d not found", srcIndex)
	}
	// Sentinel index (past the last window) → move source to end.
	// In this case, use "move to position" (full swaps), not "insert before."
	sentinel := dstPos < 0
	if sentinel {
		dstPos = len(indices) - 1
	}

	// "Insert before" semantics: source lands just before the target item.
	// When moving forward, stop one short (source ends up before dst).
	// When moving backward, go all the way (source takes dst's slot, dst shifts right).
	// Sentinel overrides: full swaps so source lands AT the end, not before it.
	endPos := dstPos
	if srcPos < dstPos && !sentinel {
		endPos = dstPos - 1
	}
	if srcPos == endPos {
		return nil
	}
	// Past this point the swap chain WILL run, drifting the active window off its
	// stable ID. Preserving it depends on having captured that ID above; every
	// session has exactly one active window, so an empty activeWindowID here means
	// the list-windows parse failed to find it. Fail before mutating rather than
	// execute the swaps and silently skip the restore (which would reintroduce the
	// active-window drift this function exists to prevent).
	if activeWindowID == "" {
		return fmt.Errorf("could not determine active window for session %q; refusing to reorder without an active-window ID to restore", session)
	}
	step := 1
	if srcPos > endPos {
		step = -1
	}
	// Emit all adjacent swaps as one \;-chained tmux invocation so no other
	// mutation can interleave mid-reorder (a concurrent kill/move observes only
	// the pre- or post-reorder layout). This mirrors the CreateWindowWithOptions
	// chaining pattern. The source index was resolved exactly once above.
	var args []string
	for pos := srcPos; pos != endPos; pos += step {
		if len(args) > 0 {
			args = append(args, ";")
		}
		src := exactWindowInSession(session, strconv.Itoa(indices[pos]))
		dst := exactWindowInSession(session, strconv.Itoa(indices[pos+step]))
		args = append(args, "swap-window", "-s", src, "-t", dst)
	}
	// Restore the pre-shuffle active window by its stable ID, appended to the SAME
	// chained invocation so the active-window slot is corrected atomically with the
	// swaps. Reached only on the swap-executing path — the srcIndex==dstIndex and
	// srcPos==endPos early returns above emit no swaps and no restore, and the
	// empty-activeWindowID guard above already bailed, so activeWindowID is non-empty here.
	//
	// The target is session-qualified (<session>:@N), not a bare @N: a bare
	// window-id select is ambiguous inside a tmux session group — group members
	// share window membership but keep independent active-window pointers, so a
	// bare -t @N may set the active window on the wrong member (see
	// SelectWindowInSession). Qualifying with the owning session pins the restore
	// to the session whose reorder we just performed.
	args = append(args, ";", "select-window", "-t", exactWindowInSession(session, activeWindowID))
	if _, err := tmuxExecServer(ctx, server, args...); err != nil {
		return fmt.Errorf("swap-window/select-window chain: %w", err)
	}
	return nil
}

// MoveWindowToSession moves the window identified by windowID to another session
// on the specified server. The source is a self-contained window ID; the
// destination is a session name. move-window preserves the window's ID in its new
// session (tmux contract).
func MoveWindowToSession(windowID string, dstSession string, server string) error {
	ctx, cancel := withTimeout()
	defer cancel()

	dst := ExactSessionTarget(dstSession)
	_, err := tmuxExecServer(ctx, server, "move-window", "-s", windowID, "-t", dst)
	return err
}

// LinkWindowToSession links the window identified by windowID INTO another
// session on the specified server, leaving it a member of its original
// session(s) too. Unlike MoveWindowToSession (which removes the window from its
// source), link-window makes the window a shared member of both sessions — the
// board pin-session model relies on this so a pinned window stays visible in its
// home session AND attachable via its `_rk-pin-*` session. The source is a
// self-contained window ID; the destination is a session name. link-window
// preserves the window's ID (tmux contract). tmux destroys the window only when
// its LAST link is removed, which is what makes Unpin = kill-session on the
// pin-session leave the window intact in home.
func LinkWindowToSession(windowID string, dstSession string, server string) error {
	ctx, cancel := withTimeout()
	defer cancel()

	dst := ExactSessionTarget(dstSession)
	_, err := tmuxExecServer(ctx, server, "link-window", "-s", windowID, "-t", dst)
	return err
}

// HasSession reports whether a session with the given name exists on the server.
// Uses an exact-match `has-session` probe (via ExactSessionTarget). Any error
// (unset session, dead server, deadline) is reported as false — the caller wants
// a boolean existence answer, not an operational error. Read-only.
func HasSession(ctx context.Context, server, session string) bool {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()
	_, err := tmuxExecRawServer(ctx, server, "has-session", "-t", ExactSessionTarget(session))
	return err == nil
}

// SetWindowOption sets a user-defined window option on the specified server.
func SetWindowOption(ctx context.Context, windowID string, server, option, value string) error {
	_, err := tmuxExecServer(ctx, server, "set-option", "-w", "-t", windowID, option, value)
	return err
}

// UnsetWindowOption removes a user-defined window option on the specified server.
func UnsetWindowOption(ctx context.Context, windowID string, server, option string) error {
	_, err := tmuxExecServer(ctx, server, "set-option", "-wu", "-t", windowID, option)
	return err
}

// GetWindowOption reads a user-defined window option on the specified server —
// the read counterpart to SetWindowOption, via `show-options -w -qv`. Returns
// ("", nil) when the option is unset (tmux prints nothing with -qv). The call
// is bounded to the 5s short-tmux tier on top of the caller's context.
func GetWindowOption(ctx context.Context, windowID, server, option string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	raw, err := tmuxExecRawServer(ctx, server, "show-options", "-wqv", "-t", windowID, option)
	if err != nil {
		return "", err
	}
	return strings.TrimRight(raw, "\n"), nil
}

// rkWinOptionPrefix is the user-option namespace run-kit writes at window
// scope; ShowWindowOptions filters to it so foreign options never leak out.
const rkWinOptionPrefix = "@rk_win_"

// ShowWindowOptions reads every `@rk_win_*` window user option in one
// `show-options -w` call — the GetWindowOption read counterpart generalised to
// the whole family (`rk tab show`). Returns an empty (non-nil) map when
// nothing is set: an unset window is a state, not an error.
func ShowWindowOptions(ctx context.Context, windowID, server string) (map[string]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	raw, err := tmuxExecRawServer(ctx, server, "show-options", "-wq", "-t", windowID)
	if err != nil {
		return nil, err
	}
	opts := map[string]string{}
	for _, line := range strings.Split(strings.TrimRight(raw, "\n"), "\n") {
		key, value, found := strings.Cut(line, " ")
		if !found || !strings.HasPrefix(key, rkWinOptionPrefix) {
			continue
		}
		opts[key] = value
	}
	return opts, nil
}

// roleCarriersFormat is the list-windows format for the RoleOption radio clear:
// window id plus its current role value.
var roleCarriersFormat = strings.Join([]string{"#{window_id}", "#{" + RoleOption + "}"}, listDelim)

// roleCarriersToClear parses roleCarriersFormat lines into the window IDs whose
// RoleOption must be unset: every window carrying a non-empty role except
// keepWindowID. Pure so the radio rule is unit-testable without a live server.
func roleCarriersToClear(lines []string, keepWindowID string) []string {
	var out []string
	for _, line := range lines {
		parts := strings.Split(line, listDelim)
		if len(parts) < 2 {
			continue
		}
		id := strings.TrimSpace(parts[0])
		if id == "" || id == keepWindowID || strings.TrimSpace(parts[1]) == "" {
			continue
		}
		out = append(out, id)
	}
	return out
}

// ClearWindowRoleExcept unsets RoleOption on every window on the target server
// except keepWindowID — the server-scoped radio half of the @rk_win_role contract:
// at most one window per server carries "operator". prefix is the
// server-targeting argv prefix (serverArgs(server) from the daemon/API, ["-S",
// socket] from an in-pane CLI) so every rk writer shares this one enforcement
// point; enforcement lives server-side in rk, never trusted to clients. The
// carriers are enumerated with one list-windows -a read and cleared with a
// single ;-chained set-option -wu batch (zero carriers → no tmux write call).
// It returns the IDs of the windows it cleared so the caller can demote any
// displaced carrier out of OperatorSessionName as part of the same promote
// flow (a roleless window stranded in _rk-operator would flip it visible with
// a confusing mixed population).
func ClearWindowRoleExcept(ctx context.Context, prefix []string, keepWindowID string) ([]string, error) {
	listArgs := append(append([]string{}, prefix...), "list-windows", "-a", "-F", roleCarriersFormat)
	out, err := RunOutput(ctx, listArgs, RunOpts{})
	if err != nil {
		return nil, err
	}
	raw := strings.Trim(string(out), "\n\r ")
	if raw == "" {
		return nil, nil
	}
	cleared := roleCarriersToClear(strings.Split(raw, "\n"), keepWindowID)
	var unset []string
	for _, id := range cleared {
		if len(unset) > 0 {
			unset = append(unset, ";")
		}
		unset = append(unset, "set-option", "-wu", "-t", id, RoleOption)
	}
	if len(unset) == 0 {
		return nil, nil
	}
	if err := Run(ctx, append(append([]string{}, prefix...), unset...), RunOpts{}); err != nil {
		return nil, err
	}
	return cleared, nil
}

// ClearWindowRoleExceptOnServer is the server-name flavor of
// ClearWindowRoleExcept for daemon/API callers (prefix derived via serverArgs).
func ClearWindowRoleExceptOnServer(ctx context.Context, server, keepWindowID string) ([]string, error) {
	return ClearWindowRoleExcept(ctx, serverArgs(server), keepWindowID)
}

// hasSessionArgv composes the exact-match has-session probe argv for prefix.
// Pure so the probe composition is unit-testable without a live server.
func hasSessionArgv(prefix []string, session string) []string {
	return append(append([]string{}, prefix...), "has-session", "-t", ExactSessionTarget(session))
}

// newDetachedSessionArgv composes the detached-create argv for prefix. The
// `-c` anchors session_path on an already-live server (session-path hygiene —
// the board.go pin-session precedent), distinct from a server-birth cmd.Dir
// override. Pure so the argv composition is unit-testable without a live server.
func newDetachedSessionArgv(prefix []string, session, cwd string) []string {
	return append(append([]string{}, prefix...), "new-session", "-d", "-s", session, "-c", cwd)
}

// hasSessionPrefix is the prefix-flavored exact-match has-session probe. Any
// error (unset session, dead server, deadline) is reported as false — callers
// want a boolean existence answer, not an operational error. Read-only.
func hasSessionPrefix(ctx context.Context, prefix []string, session string) bool {
	return Run(ctx, hasSessionArgv(prefix, session), RunOpts{}) == nil
}

// ensureDetachedSession creates session detached when missing (idempotent),
// anchored to ServerBirthDir for session_path hygiene.
func ensureDetachedSession(ctx context.Context, prefix []string, session string) error {
	if hasSessionPrefix(ctx, prefix, session) {
		return nil
	}
	return Run(ctx, newDetachedSessionArgv(prefix, session, ServerBirthDir()), RunOpts{})
}

// EnsureOperatorSession guarantees OperatorSessionName exists on the target
// server, creating it detached (anchored to ServerBirthDir) when missing.
// Idempotent: an existing session is a no-op, and a pre-existing user-created
// session of the same name (foreign windows and all) is adopted as-is.
func EnsureOperatorSession(ctx context.Context, prefix []string) error {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()
	return ensureDetachedSession(ctx, prefix, OperatorSessionName)
}

// windowSessionPrefix resolves the name of the session the window identified
// by windowID is a member of, via one display-message read under prefix.
func windowSessionPrefix(ctx context.Context, prefix []string, windowID string) (string, error) {
	out, err := RunOutput(ctx, append(append([]string{}, prefix...), "display-message", "-t", windowID, "-p", "#{session_name}"), RunOpts{})
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// MoveWindowIntoOperatorSession moves the window identified by windowID into
// OperatorSessionName, preserving the window's @N id across the move (tmux
// contract). When the operator session must be created it is born with a
// placeholder window (new-session always starts one); the placeholder is
// captured and killed after the move so the session ends holding exactly the
// promoted window (the board.go pin-session precedent). A pre-existing
// operator session (e.g. user-created, foreign windows) is adopted as-is — no
// placeholder is removed. A window already in the operator session is a no-op
// — tmux refuses a same-session move, so the membership probe keeps a repeated
// promote idempotent.
func MoveWindowIntoOperatorSession(ctx context.Context, prefix []string, windowID string) error {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()
	session, err := windowSessionPrefix(ctx, prefix, windowID)
	if err != nil {
		return err
	}
	if session == OperatorSessionName {
		return nil
	}
	// Capture the placeholder only when WE create the session (it did not exist
	// before this call); an adopted session keeps its windows.
	var placeholder string
	if !hasSessionPrefix(ctx, prefix, OperatorSessionName) {
		if err := Run(ctx, newDetachedSessionArgv(prefix, OperatorSessionName, ServerBirthDir()), RunOpts{}); err != nil {
			return err
		}
		out, err := RunOutput(ctx, append(append([]string{}, prefix...), "list-windows", "-t", ExactSessionTarget(OperatorSessionName), "-F", "#{window_id}"), RunOpts{})
		if err == nil {
			placeholder = strings.TrimSpace(string(out))
		}
	}
	if err := Run(ctx, append(append([]string{}, prefix...), "move-window", "-s", windowID, "-t", ExactSessionTarget(OperatorSessionName)), RunOpts{}); err != nil {
		return err
	}
	if placeholder != "" && placeholder != windowID {
		// Best-effort: a stray placeholder is cosmetic (the promoted window is
		// already home); it never blocks the promote.
		_ = Run(ctx, append(append([]string{}, prefix...), "kill-window", "-t", placeholder), RunOpts{})
	}
	return nil
}

// MoveWindowIntoOperatorSessionOnServer is the server-name flavor of
// MoveWindowIntoOperatorSession for daemon/API callers.
func MoveWindowIntoOperatorSessionOnServer(ctx context.Context, server, windowID string) error {
	return MoveWindowIntoOperatorSession(ctx, serverArgs(server), windowID)
}

// demoteDestinationSession derives the conventional session name a demoted
// window moves out to: the basename of its active pane's cwd (the folder
// auto-naming convention). An unreadable cwd, or a basename that is not a
// valid tmux session name (colons/periods are refused by tmux itself), falls
// back to the ServerBirthDir basename so demotion stays total. Pure.
func demoteDestinationSession(cwd, birthDir string) string {
	base := filepath.Base(strings.TrimRight(cwd, "/"))
	if cwd == "" || base == "." || base == "/" || validate.ValidateName(base, "Session name") != "" {
		base = filepath.Base(birthDir)
	}
	if validate.ValidateName(base, "Session name") != "" {
		return "rk-home"
	}
	return base
}

// DemoteWindowFromOperatorSession moves the window identified by windowID out
// of OperatorSessionName into the conventional session named after its active
// pane's cwd basename (created detached if missing, else moved into the
// existing one). A window NOT in the operator session is a no-op (role-clear
// on a legacy cosmetic-era operator stays a plain option unset). When the
// moved window was the operator session's last window, tmux destroys the empty
// session — expected; the next promote recreates it.
func DemoteWindowFromOperatorSession(ctx context.Context, prefix []string, windowID string) error {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()
	session, err := windowSessionPrefix(ctx, prefix, windowID)
	if err != nil {
		return err
	}
	if session != OperatorSessionName {
		return nil
	}
	// Best-effort cwd read: a failure degrades to the ServerBirthDir-basename
	// destination rather than aborting the demote.
	cwd := ""
	if out, err := RunOutput(ctx, append(append([]string{}, prefix...), "display-message", "-t", windowID, "-p", "#{pane_current_path}"), RunOpts{}); err == nil {
		cwd = strings.TrimSpace(string(out))
	}
	dest := demoteDestinationSession(cwd, ServerBirthDir())
	if dest == OperatorSessionName {
		// The window's own cwd basename collides with the operator session's
		// name — moving out to itself is meaningless; leave the window in place.
		return nil
	}
	// Capture the placeholder only when WE create the destination; an existing
	// destination keeps its windows.
	var placeholder string
	if !hasSessionPrefix(ctx, prefix, dest) {
		if err := Run(ctx, newDetachedSessionArgv(prefix, dest, ServerBirthDir()), RunOpts{}); err != nil {
			return err
		}
		out, err := RunOutput(ctx, append(append([]string{}, prefix...), "list-windows", "-t", ExactSessionTarget(dest), "-F", "#{window_id}"), RunOpts{})
		if err == nil {
			placeholder = strings.TrimSpace(string(out))
		}
	}
	if err := Run(ctx, append(append([]string{}, prefix...), "move-window", "-s", windowID, "-t", ExactSessionTarget(dest)), RunOpts{}); err != nil {
		return err
	}
	if placeholder != "" && placeholder != windowID {
		_ = Run(ctx, append(append([]string{}, prefix...), "kill-window", "-t", placeholder), RunOpts{})
	}
	return nil
}

// DemoteWindowFromOperatorSessionOnServer is the server-name flavor of
// DemoteWindowFromOperatorSession for daemon/API callers.
func DemoteWindowFromOperatorSessionOnServer(ctx context.Context, server, windowID string) error {
	return DemoteWindowFromOperatorSession(ctx, serverArgs(server), windowID)
}

// WindowOptionOp is a single set-or-unset operation on a window option, consumed
// by SetWindowOptions. A non-nil Value sets the option to that value; a nil Value
// unsets it (set-option -w -u). This pointer convention mirrors the JSON
// string|null shape the /options endpoint decodes.
type WindowOptionOp struct {
	Key   string
	Value *string
}

// appendOptionOps appends the `set-option` argv for each op to args, prefixing a
// "\;" chain separator before all but the first appended op when args is already
// non-empty. A non-nil op.Value emits `set-option -w -t <target> <key> <value>`;
// a nil Value emits `set-option -w -u -t <target> <key>`. When target is empty,
// the `-t <target>` qualifier is omitted (used by CreateWindowWithOptions, where
// the preceding new-window already scopes the chained set-options to the new
// window). All values are passed as argv elements — no shell strings (§I).
func appendOptionOps(args []string, target string, ops []WindowOptionOp) []string {
	for _, op := range ops {
		if len(args) > 0 {
			args = append(args, ";")
		}
		args = append(args, "set-option", "-w")
		if op.Value == nil {
			args = append(args, "-u")
		}
		if target != "" {
			args = append(args, "-t", target)
		}
		args = append(args, op.Key)
		if op.Value != nil {
			args = append(args, *op.Value)
		}
	}
	return args
}

// SetWindowOptions applies a batch of window-option set/unset operations to the
// window identified by windowID as a single \;-chained tmux invocation. The
// chain is ordered, not atomic — ops apply in slice order, but a reader polling
// mid-chain can observe a half-applied state — and reuses the same pattern
// CreateWindowWithOptions uses. A non-nil
// op.Value sets via `set-option -w -t <windowID> <key> <value>`; a nil Value
// unsets via `set-option -w -u -t <windowID> <key>`. All arguments are passed as
// an argv slice — no shell strings (constitution §I). A no-op (empty ops) issues
// no tmux call.
func SetWindowOptions(ctx context.Context, windowID, server string, ops []WindowOptionOp) error {
	if len(ops) == 0 {
		return nil
	}
	args := appendOptionOps(nil, windowID, ops)
	_, err := tmuxExecServer(ctx, server, args...)
	return err
}

// WindowLayoutWrite is one window's new @rk_win_layout value, consumed by
// SetWindowLayouts. Ordering is the caller's: pairs apply in slice order
// within the one chained invocation.
type WindowLayoutWrite struct {
	WindowID string
	Layout   string
}

// buildSetWindowLayoutsArgv composes the `set-option -w -t <id> @rk_win_layout
// <value>` ops for several windows into one \;-chained argv via the shared
// appendOptionOps chaining primitive (the SetWindowOptions pattern, one target
// per pair). Pure.
func buildSetWindowLayoutsArgv(pairs []WindowLayoutWrite) []string {
	var args []string
	for _, p := range pairs {
		value := p.Layout
		args = appendOptionOps(args, p.WindowID, []WindowOptionOp{{Key: LayoutOption, Value: &value}})
	}
	return args
}

// SetWindowLayouts writes several windows' @rk_win_layout values as a single
// \;-chained tmux invocation — the borrow/return write contract. The chain is
// ordered, not atomic: pairs apply in slice order (the caller puts the
// holder's removal first, so the leaf is never added to the target while the
// holder still shows it), and the api endpoints serialize the requests behind
// a per-server lock (layoutWriteMu in api/layout_borrow.go), but a reader
// polling between the chained writes can transiently observe the intermediate
// state. A no-op (empty pairs) issues no tmux call.
func SetWindowLayouts(ctx context.Context, server string, pairs []WindowLayoutWrite) error {
	if len(pairs) == 0 {
		return nil
	}
	_, err := tmuxExecServer(ctx, server, buildSetWindowLayoutsArgv(pairs)...)
	return err
}

// CreateWindowWithOptions creates a new window and atomically sets user-defined
// options using a single \;-chained tmux command. This prevents SSE from seeing
// the window before its metadata is set. The post-create option-setting reuses
// the same WindowOptionOp chaining primitive (appendOptionOps) the
// SetWindowOptions primitive uses; window creation and option-set stay in one
// invocation so they are atomic at creation. The new-window scopes the chained
// set-options to itself, so the ops are emitted without a `-t` target.
func CreateWindowWithOptions(session, name, cwd, server string, ops []WindowOptionOp) error {
	ctx, cancel := withTimeout()
	defer cancel()

	args := []string{"new-window", "-a", "-t", ExactSessionTarget(session), "-n", name}
	if cwd != "" {
		args = append(args, "-c", cwd)
	}
	args = appendOptionOps(args, "", ops)
	_, err := tmuxExecServer(ctx, server, args...)
	return err
}

// WindowBirth is what `new-window -P` reports for a freshly created window.
type WindowBirth struct {
	Session  string // #{session_name} as tmux reports it (confirms where the window landed)
	WindowID string // @N
	PaneID   string // %N — the window's initial pane
}

// buildCreateWindowWithCommandArgs composes the argv for
// `new-window -P -F '#{session_name}\t#{window_id}\t#{pane_id}' -a -t =S:
// -n NAME [-c CWD] [SHELL-CMD] [\; set-option -w …]`: the shell-command
// positional sits before the \; option ops (tmux grammar: new-window [flags]
// [shell-command], then \; starts the next command), and an empty shellCmd
// omits the positional entirely (the window boots tmux's default-shell).
// shellCmd is one opaque argv element — the caller composes it from quoted
// tokens; this builder never touches a shell itself (§I). Pure.
func buildCreateWindowWithCommandArgs(session, name, cwd, shellCmd string, ops []WindowOptionOp) []string {
	args := []string{"new-window", "-P", "-F",
		"#{session_name}" + listDelim + "#{window_id}" + listDelim + "#{pane_id}",
		"-a", "-t", ExactSessionTarget(session), "-n", name}
	if cwd != "" {
		args = append(args, "-c", cwd)
	}
	if shellCmd != "" {
		args = append(args, shellCmd)
	}
	return appendOptionOps(args, "", ops)
}

// parseWindowBirth parses the single tab-separated line `new-window -P`
// prints for the buildCreateWindowWithCommandArgs format; any other field
// count is an error naming the expected fields. Pure.
func parseWindowBirth(line string) (WindowBirth, error) {
	parts := strings.Split(line, listDelim)
	if len(parts) != 3 {
		return WindowBirth{}, fmt.Errorf("new-window -P returned %q, want session, window id, pane id", line)
	}
	return WindowBirth{Session: parts[0], WindowID: parts[1], PaneID: parts[2]}, nil
}

// CreateWindowWithCommandID is CreateWindowWithOptions plus the full birth
// triple — the tmux-reported session, the new window's @N, and its initial
// pane's %N, printed by the same creation call — and an optional
// shell-command positional for the window's initial pane ("" = tmux's
// default-shell). Callers needing only the id use the CreateWindowWithOptionsID
// delegate.
func CreateWindowWithCommandID(session, name, cwd, server, shellCmd string, ops []WindowOptionOp) (WindowBirth, error) {
	ctx, cancel := withTimeout()
	defer cancel()

	lines, err := tmuxExecServer(ctx, server, buildCreateWindowWithCommandArgs(session, name, cwd, shellCmd, ops)...)
	if err != nil {
		return WindowBirth{}, err
	}
	if len(lines) == 0 {
		return WindowBirth{}, fmt.Errorf("new-window -P returned no output, want session, window id, pane id")
	}
	return parseWindowBirth(lines[0])
}

// CreateWindowWithOptionsID is CreateWindowWithOptions plus the new window's
// id, reported via `new-window -P -F '#{window_id}'`. Callers that must embed
// the fresh @N in a follow-up write (rk present --window composing a
// /present/<windowId>/ URL) create with the creation-time options atomically,
// then apply the id-dependent options via SetWindowOptions. A delegate of
// CreateWindowWithCommandID with no shell-command, returning the WindowID.
func CreateWindowWithOptionsID(session, name, cwd, server string, ops []WindowOptionOp) (string, error) {
	birth, err := CreateWindowWithCommandID(session, name, cwd, server, "", ops)
	if err != nil {
		return "", err
	}
	return birth.WindowID, nil
}

// KillWindow kills a window by its window ID on the specified server.
func KillWindow(windowID string, server string) error {
	ctx, cancel := withTimeout()
	defer cancel()

	_, err := tmuxExecServer(ctx, server, "kill-window", "-t", windowID)
	return err
}

// RenameSession renames a tmux session on the specified server.
func RenameSession(session, name string, server string) error {
	ctx, cancel := withTimeout()
	defer cancel()

	_, err := tmuxExecServer(ctx, server, "rename-session", "-t", ExactSessionTarget(session), name)
	return err
}

// RenameWindow renames a window by its window ID on the specified server.
func RenameWindow(windowID string, name string, server string) error {
	ctx, cancel := withTimeout()
	defer cancel()

	_, err := tmuxExecServer(ctx, server, "rename-window", "-t", windowID, name)
	return err
}

// SendKeys sends keystrokes to a tmux window by its window ID on the specified server.
func SendKeys(windowID string, keys string, server string) error {
	ctx, cancel := withTimeout()
	defer cancel()

	_, err := tmuxExecServer(ctx, server, "send-keys", "-t", windowID, keys, "Enter")
	return err
}

// AgentSendBuffer is the named tmux paste buffer used by the agent-send injection
// path. A NAMED buffer (rather than the anonymous top-of-stack) means loading a
// message never clobbers whatever the user has on their buffer stack, and
// the paste (-d) deletes it afterwards so the buffer set stays clean.
const AgentSendBuffer = "rk-agent-send"

// SetBufferCtx loads text into a NAMED tmux buffer on the specified server,
// bounded by the CALLER's context. The agent-send handler threads ONE shared
// deadline through the whole injection sequence (set → paste → probe → Enter)
// so the route stays well under the 5s route-blocking budget (code-review.md)
// rather than granting each subprocess an independent 10s timeout. The text is
// a DISCRETE argv element (no shell string, no stdin) so any content —
// including newlines, tmux key names, or special characters — is stored
// verbatim (Constitution §I). tmuxExecServer has no stdin plumbing, so
// `set-buffer <text>` is used rather than `load-buffer -`.
//
// The `--` option terminator precedes the text so a message that itself starts
// with a dash (e.g. "--force is broken") is treated as the positional buffer
// data, not parsed as set-buffer flags (which would hard-fail). Verified on tmux
// 3.6a: with `--`, leading-dash text stores verbatim.
func SetBufferCtx(ctx context.Context, name, text string, server string) error {
	_, err := tmuxExecServer(ctx, server, "set-buffer", "-b", name, "--", text)
	return err
}

// SetAgentSendBufferCtx is the agent-send handler's fixed-buffer form of
// SetBufferCtx (the daemon's single shared buffer — the CLI uses its own
// per-invocation buffer names via SetBufferCtx).
func SetAgentSendBufferCtx(ctx context.Context, text string, server string) error {
	return SetBufferCtx(ctx, AgentSendBuffer, text, server)
}

// PasteBufferCtx pastes a NAMED buffer into the target PANE (not a window) on
// the specified server, bounded by the CALLER's context. `-p` requests
// bracketed paste (the Claude Code TUI enables bracketed paste, so a
// multiline / special-character message lands as one literal block with no
// per-line submission); `-d` deletes the buffer after pasting so the buffer set
// stays clean.
func PasteBufferCtx(ctx context.Context, name, paneID string, server string) error {
	_, err := tmuxExecServer(ctx, server, "paste-buffer", "-d", "-p", "-b", name, "-t", paneID)
	return err
}

// PasteBufferRawCtx pastes a named buffer without bracketed-paste markers.
// The -r flag preserves LF bytes instead of translating them to CR, while the
// absence of -p keeps the resulting stream byte-exact.
func PasteBufferRawCtx(ctx context.Context, name, paneID string, server string) error {
	_, err := tmuxExecServer(ctx, server, "paste-buffer", "-d", "-r", "-b", name, "-t", paneID)
	return err
}

// PasteAgentSendBufferCtx is the agent-send handler's fixed-buffer form of
// PasteBufferCtx.
func PasteAgentSendBufferCtx(ctx context.Context, paneID string, server string) error {
	return PasteBufferCtx(ctx, AgentSendBuffer, paneID, server)
}

// PasteAgentSendBufferRawCtx exposes the daemon's process-wide buffer to raw-mode
// injection. Callers must hold the engine's set-to-paste critical section so a
// send to another pane cannot replace the buffer before this unbracketed,
// LF-preserving paste consumes it.
func PasteAgentSendBufferRawCtx(ctx context.Context, paneID string, server string) error {
	return PasteBufferRawCtx(ctx, AgentSendBuffer, paneID, server)
}

// SendEnterToPaneCtx sends a single literal Enter key to the target PANE on the
// specified server (`send-keys -t <paneID> Enter`), bounded by the CALLER's
// context. Used by the agent-send path to submit a pasted message ONLY after the
// echo probe confirms it reached the live input buffer — never blindly. Targets
// the resolved pane, not the window.
func SendEnterToPaneCtx(ctx context.Context, paneID string, server string) error {
	_, err := tmuxExecServer(ctx, server, "send-keys", "-t", paneID, "Enter")
	return err
}

// SetSessionColor sets the SessionColorOption user option on a session. The
// value is a color-value descriptor ("4" / "1+3"), validated by the caller
// before it reaches the shared setSessionOption (board.go), which passes it as
// a discrete arg (no shell string) so a '+' in a blend value is safe
// (constitution §I).
// Uses a distinct name from window ColorOption to avoid tmux option inheritance.
func SetSessionColor(session string, colorValue string, server string) error {
	ctx, cancel := withTimeout()
	defer cancel()

	return setSessionOption(ctx, server, session, SessionColorOption, colorValue)
}

// UnsetSessionColor removes the SessionColorOption user option from a session.
func UnsetSessionColor(session string, server string) error {
	ctx, cancel := withTimeout()
	defer cancel()

	return unsetSessionOption(ctx, server, session, SessionColorOption)
}

// SetSessionFlair sets the SessionFlairOption user option on a session. The
// value is a closed-set flair token ("nyan" / "naruto" / "onepiece"),
// validated by the caller. Mirrors SetSessionColor.
//
// SCOPE-SPLIT NAMING (@rk_ses_flair, NOT @rk_win_flair): tmux user-option
// lookup is hierarchical and format expansion leaks a shared name across
// scopes in BOTH directions — a flairless window inherits its session's
// value, and list-sessions resolves the session's CURRENT window's window
// option ahead of the session option. Distinct per-scope names sever both
// fallbacks — the exact same reason window color is @rk_win_color while
// session color is @rk_ses_color.
func SetSessionFlair(session string, flair string, server string) error {
	ctx, cancel := withTimeout()
	defer cancel()

	return setSessionOption(ctx, server, session, SessionFlairOption, flair)
}

// UnsetSessionFlair removes the SessionFlairOption user option from a session.
// Mirrors UnsetSessionColor.
func UnsetSessionFlair(session string, server string) error {
	ctx, cancel := withTimeout()
	defer cancel()

	return unsetSessionOption(ctx, server, session, SessionFlairOption)
}

// SetWindowColor sets the ColorOption user option on a window by its window
// ID. The value is a color-value descriptor ("4" / "1+3"), validated by the
// caller. In practice window color now flows through SetWindowOptions; this
// remains for interface symmetry. Passed as a discrete arg (no shell string)
// per §I.
func SetWindowColor(windowID string, colorValue string, server string) error {
	ctx, cancel := withTimeout()
	defer cancel()

	_, err := tmuxExecServer(ctx, server, "set-option", "-w", "-t", windowID, ColorOption, colorValue)
	return err
}

// UnsetWindowColor removes the ColorOption user option from a window by its window ID.
func UnsetWindowColor(windowID string, server string) error {
	ctx, cancel := withTimeout()
	defer cancel()

	_, err := tmuxExecServer(ctx, server, "set-option", "-wu", "-t", windowID, ColorOption)
	return err
}

// SelectWindowInSession selects a window scoped to a specific session, targeting
// "<session>:<windowID>". A bare window-id target (`select-window -t @N`) is
// ambiguous inside a tmux session group — group members share window membership
// but keep independent active-window state, so tmux may set the active window on
// the wrong member. The REST window-select handler (api/windows.go handleWindowSelect)
// resolves the owning session and qualifies the target with it so the active window
// is set on the intended session, not an arbitrary group member.
func SelectWindowInSession(session, windowID, server string) error {
	ctx, cancel := withTimeout()
	defer cancel()

	target := exactWindowInSession(session, windowID)
	_, err := tmuxExecServer(ctx, server, "select-window", "-t", target)
	return err
}

// SplitWindow splits a window to create an independent pane on the specified server. Returns the new pane ID.
// If horizontal is true, the pane is split left/right (-h flag); otherwise top/bottom.
// If cwd is non-empty, the new pane starts in that directory (-c flag).
func SplitWindow(windowID string, horizontal bool, cwd string, server string) (string, error) {
	ctx, cancel := withTimeout()
	defer cancel()

	args := []string{"split-window"}
	if horizontal {
		args = append(args, "-h")
	}
	if cwd != "" {
		args = append(args, "-c", cwd)
	}
	args = append(args, "-t", windowID, "-d", "-P", "-F", "#{pane_id}")
	lines, err := tmuxExecServer(ctx, server, args...)
	if err != nil {
		return "", err
	}
	if len(lines) == 0 {
		return "", fmt.Errorf("split-window returned no pane ID")
	}
	return lines[0], nil
}

// KillActivePane kills the active pane of the window identified by windowID on
// the given server. Targeting a window ID with kill-pane kills that window's
// active pane.
//
// Silent-success contract (canonical pane-kill behavior): any tmux error is
// swallowed and nil is returned, because the pane may already be dead by the
// time this runs (e.g. the process exited, or a concurrent close-pane already
// killed it). Callers treat "close the pane" as best-effort idempotent — a
// missing pane is success, not failure.
func KillActivePane(windowID string, server string) error {
	ctx, cancel := withTimeout()
	defer cancel()

	_, err := tmuxExecServer(ctx, server, "kill-pane", "-t", windowID)
	// Pane may already be dead — ignore errors
	_ = err
	return nil
}

// KillPaneCtx kills the pane identified by paneID (%N) on the given server,
// bounded by the caller's context. Unlike KillActivePane (best-effort,
// silent-success), a tmux failure IS returned — the `rk mux kill` verb's
// missing-pane and kill-failure diagnostics depend on tmux's stderr.
func KillPaneCtx(ctx context.Context, paneID string, server string) error {
	_, err := tmuxExecServer(ctx, server, "kill-pane", "-t", paneID)
	return err
}

// CapturePane captures pane content (last N lines) on the specified server.
// Preserves blank lines. The -e flag preserves ANSI escape sequences (color +
// text attributes) so callers can render the pane in color rather than as flat
// monochrome text; the sole caller (the tile-grid preview) parses these with a
// client-side SGR renderer. Non-color callers can strip the escapes downstream.
func CapturePane(paneID string, lines int, server string) (string, error) {
	ctx, cancel := withTimeout()
	defer cancel()
	return CapturePaneCtx(ctx, paneID, lines, server)
}

// CapturePaneCtx captures pane content (last N lines) on the specified server,
// bounded by the CALLER's context — used by the agent-send echo probe, which
// threads one shared deadline across all its captures so the retry loop stays
// under the route budget. See CapturePane for the flag semantics.
func CapturePaneCtx(ctx context.Context, paneID string, lines int, server string) (string, error) {
	return tmuxExecRawServer(ctx, server, capturePaneArgs(paneID, lines, true)...)
}

// CapturePanePlainCtx captures pane content (last N lines) on the specified
// server as PLAIN text — no -e ANSI escape sequences — bounded by the caller's
// context. This is the mux capture verb's variant (agent-consumable output);
// the -e variant stays untouched for the SGR-aware chat echo probe. Content is
// returned untrimmed, byte-identical to tmux's output.
func CapturePanePlainCtx(ctx context.Context, paneID string, lines int, server string) (string, error) {
	return tmuxExecRawServer(ctx, server, capturePaneArgs(paneID, lines, false)...)
}

// capturePaneArgs builds the capture-pane argv for the last `lines` scrollback
// lines; escape toggles the -e flag (ANSI escapes preserved vs. plain text).
func capturePaneArgs(paneID string, lines int, escape bool) []string {
	args := []string{"capture-pane", "-t", paneID}
	if escape {
		args = append(args, "-e")
	}
	return append(args, "-p", "-S", strconv.Itoa(-lines))
}

// CaptureWindowHistoryCtx captures the FULL scrollback (`-S -`) of the active
// pane of the window identified by target (@N — a window target resolves to
// its active pane, the KillActivePane precedent), bounded by the caller's
// context. Plain text: no -e (ANSI escapes) and no -J (line structure as tmux
// renders it). Backs GET /api/windows/{windowId}/history.
func CaptureWindowHistoryCtx(ctx context.Context, target, server string) (string, error) {
	return tmuxExecRawServer(ctx, server, "capture-pane", "-t", target, "-p", "-S", "-")
}

// IsTestServerName reports whether name belongs to the unified test-socket
// umbrella: every Go and Playwright test tmux server is named
// rk-test-<role>-<pid>-<ns>, so "is this a test artifact?" collapses to a
// single HasPrefix("rk-test-") check. This is the one place the "rk-test-"
// literal lives; the tmuxctl supervisor (resurrection guard) consumes it.
//
// It is intentionally NOT applied in ListServers nor in the /api/servers
// handler — internal consumers (board.go in particular) iterate every real
// tmux server, and /api/servers surfaces every server so the operator sees
// exactly what `rk mux reap` will reap.
func IsTestServerName(name string) bool {
	return strings.HasPrefix(name, "rk-test-")
}

// socketDirPath returns the tmux socket directory for the current uid
// (/tmp/tmux-{uid}). This is the single definition of the socket-dir
// convention — both ScanSocketDir and the reaper consume it.
func socketDirPath() string {
	return fmt.Sprintf("/tmp/tmux-%d", os.Getuid())
}

// LockSocketSuffix is the filename suffix tmux uses for its per-socket lock
// files in the socket directory. Unlike the sockets themselves these are
// REGULAR files, not unix sockets, so the socket-mode filter alone would never
// surface them. The reaper sweeps stale `*.lock` files (PR #199 orphan class);
// ListServers ignores them. Single source of truth for the suffix.
const LockSocketSuffix = ".lock"

// ScanSocketDir returns the raw candidate names in the tmux socket directory
// (/tmp/tmux-{uid}) that the reaper may act on: every unix-socket file PLUS
// every `*.lock` regular file. It does NOT probe for liveness, so dead sockets
// ARE included. Returns nil (no error) when the directory does not exist or
// cannot be read (no servers running). This is the single source for the
// socket-dir candidate-collection convention, shared by ListServers (which
// skips the `.lock` entries — see ListServers) and the reaper.
func ScanSocketDir(ctx context.Context) ([]string, error) {
	return scanSocketDir(ctx, false)
}

func scanSocketDir(ctx context.Context, strict bool) ([]string, error) {
	if err := ctx.Err(); strict && err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(socketDirPath())
	if err != nil {
		// Missing directory means no servers; strict inventory must distinguish
		// an unreadable directory from an empty estate.
		if strict && !os.IsNotExist(err) {
			return nil, err
		}
		return nil, nil
	}
	return filterSocketEntries(entries), nil
}

// filterSocketEntries keeps the reapable candidates from a socket-dir listing:
// unix-socket files (live or dead tmux servers) AND `*.lock` regular files
// (tmux's per-socket lock artifacts, which are NOT sockets and so must be
// matched by name). Directories and all other regular files are dropped.
// Extracted so the filter is testable against a temp directory without
// depending on the hardcoded /tmp/tmux-{uid} path.
func filterSocketEntries(entries []os.DirEntry) []string {
	var candidates []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if strings.HasSuffix(e.Name(), LockSocketSuffix) {
			// tmux lock files are regular files, not sockets — match by name.
			candidates = append(candidates, e.Name())
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.Mode()&os.ModeSocket == 0 {
			continue
		}
		candidates = append(candidates, e.Name())
	}
	return candidates
}

// probeResult classifies a server-liveness probe three ways: the tmux server
// answered (probeAlive), the probe failed fast (probeDead — a dead/absent
// socket refuses the connection immediately), or the probe's context deadline
// expired (probeTimeout — the server is busy or hung, NOT proven dead).
type probeResult int

const (
	probeAlive probeResult = iota
	probeDead
	probeTimeout
)

// classifyProbe maps one probe attempt's outcome to its probeResult. The
// classification keys on the probe context: a failure whose probe context ran
// out (DeadlineExceeded) is a timeout — the child was killed mid-answer, so
// nothing is proven about the server; any other failure is a fast dead-socket
// refusal (a dead socket never blocks long enough to hit the deadline). Pure
// so the taxonomy is unit-testable without spawning tmux.
func classifyProbe(runErr, ctxErr error) probeResult {
	if runErr == nil {
		return probeAlive
	}
	if ctxErr == context.DeadlineExceeded {
		return probeTimeout
	}
	return probeDead
}

// probeServer runs one liveness probe against the named socket
// (`tmux -L <name> list-sessions`, 2s budget) and returns its three-way
// classification (see classifyProbe).
func probeServer(ctx context.Context, name string) probeResult {
	probeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(probeCtx, "tmux", "-L", name, "list-sessions")
	return classifyProbe(cmd.Run(), probeCtx.Err())
}

// probeServerAlive reports whether a tmux server is reachable on the named
// socket by running `tmux -L <name> list-sessions` with a short timeout.
// Used by the reaper (to distinguish live orphan test servers from dead
// sockets) and the birth-stamp pre-probe; only ListServers consumes the
// three-way classification. Semantics are byte-identical to a single
// `cmd.Run() == nil` attempt.
func probeServerAlive(ctx context.Context, name string) bool {
	return probeServer(ctx, name) == probeAlive
}

// keepFromProbes reduces a first probe result and (only meaningful when the
// first timed out) the retry's result to ListServers' keep/drop decision:
// alive keeps, dead drops, and a timeout whose retry also timed out KEEPS the
// name — a genuinely dead socket refuses instantly and never reaches that
// path, so a double timeout means live-but-busy, and dropping would vanish a
// healthy server from /api/servers. Pure so the full matrix is unit-testable
// without live servers.
func keepFromProbes(first, retry probeResult) bool {
	switch first {
	case probeAlive:
		return true
	case probeDead:
		return false
	default: // probeTimeout: a retry that refuses instantly proves dead
		return retry != probeDead
	}
}

// keepServerForListing is ListServers' per-candidate liveness policy: probe
// once; on timeout retry exactly ONCE with a fresh probe budget, then apply
// keepFromProbes. Stateless per request — no last-known-state cache
// (Constitution II).
func keepServerForListing(ctx context.Context, name string) bool {
	first := probeServer(ctx, name)
	if first == probeTimeout {
		return keepFromProbes(first, probeServer(ctx, name))
	}
	return keepFromProbes(first, first)
}

// ServerAlive probes whether a tmux server answers on the named socket and
// returns tmux's error verbatim (stderr appended) when it does not — a dead or
// absent socket. It is the diagnostic-carrying counterpart of ListSessions,
// which swallows the dead-server case into (nil, nil) for its dashboard
// callers: a CLI enumeration query must tell "no server" (operational failure)
// apart from "server alive, nothing user-facing to list". Read-only.
func ServerAlive(ctx context.Context, server string) error {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()
	_, err := tmuxExecRawServer(ctx, server, "list-sessions")
	return err
}

// ServerAllowlistEnv is the environment variable that, when set, scopes
// ListServers to only the live servers whose names prefix-match one of its
// comma-separated tokens. It is read directly in-package (like RK_TMUX_CONF /
// OriginalTMUX above), NOT threaded through internal/config — ListServers is a
// ctx-only free function and internal/tmux has no config dependency to carry it.
//
// It exists solely for test isolation: the e2e harness sets it to the test
// server name so the backend's enumeration ignores the operator's live
// kit/runWork servers. Production leaves it UNSET, in which case ListServers
// behaves exactly as before (all live servers). See matchesServerAllowlist.
const ServerAllowlistEnv = "RK_SERVER_ALLOWLIST"

// matchesServerAllowlist reports whether a tmux server name is admitted by the
// allowlist. An empty or whitespace-only allowlist is treated as UNSET and
// admits every name (so an empty RK_SERVER_ALLOWLIST never means "match
// nothing"). Otherwise the allowlist is a comma-separated list of prefixes:
// each token is trimmed of surrounding whitespace, empty tokens are ignored,
// and name matches when it HasPrefix ANY remaining token (exact match is the
// prefix-of-itself case). Prefix matching is required because multi-server e2e
// specs create rk-test-e2e-<role>-<pid>-<epoch> secondaries that an exact
// match would wrongly exclude. Extracted as a pure helper so it is unit-testable
// without live tmux servers.
func matchesServerAllowlist(name, allowlist string) bool {
	if strings.TrimSpace(allowlist) == "" {
		return true
	}
	for _, token := range strings.Split(allowlist, ",") {
		token = strings.TrimSpace(token)
		if token == "" {
			continue
		}
		if strings.HasPrefix(name, token) {
			return true
		}
	}
	return false
}

// ServerAllowed reports whether a tmux server name is admitted by this
// deployment's RK_SERVER_ALLOWLIST (ServerAllowlistEnv), with semantics
// identical to the ListServers filter: unset/blank env admits everything,
// otherwise matchesServerAllowlist decides. It is the shared "does this
// deployment cover this server?" predicate — consumers beyond enumeration
// (e.g. the tmuxctl origin stamp, which must not write a non-admitted host
// server's @rk_srv_origin) gate on it.
func ServerAllowed(name string) bool {
	return matchesServerAllowlist(name, os.Getenv(ServerAllowlistEnv))
}

// ListServers discovers available tmux servers by scanning the tmux socket directory
// at /tmp/tmux-{uid}/. Probes each socket to confirm the server is alive.
// Returns sorted server names.
//
// When the RK_SERVER_ALLOWLIST env var is set, the live-server list is further
// narrowed to names that prefix-match the allowlist (see matchesServerAllowlist).
// The filter lives HERE, not solely in the /api/servers handler, because the
// board route attaches servers from two distinct ListServers-rooted paths
// (GET /api/servers and the internal board.go board-entry enumeration); filtering
// only the handler would leave board enumeration unscoped. Production leaves the
// var UNSET, so this branch is a no-op there and the "surface every server"
// contract (see IsTestServerName / tmux.go:1332) is preserved byte-for-byte.
func ListServers(ctx context.Context) ([]string, error) {
	return listServers(ctx, false)
}

// ListServersStrict discovers live sockets without treating an unreadable
// socket directory or cancelled discovery as an empty fleet.
func ListServersStrict(ctx context.Context) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if _, err := exec.LookPath("tmux"); err != nil {
		return nil, fmt.Errorf("discover tmux servers: %w", err)
	}
	return listServers(ctx, true)
}

func listServers(ctx context.Context, strict bool) ([]string, error) {
	candidates, err := scanSocketDir(ctx, strict)
	if err != nil {
		return nil, err
	}

	// Probe each socket concurrently — bounded goroutine pool.
	sem := make(chan struct{}, 10)
	var mu sync.Mutex
	var wg sync.WaitGroup
	var servers []string

	for _, name := range candidates {
		// `.lock` files are not servers — ScanSocketDir surfaces them for the
		// reaper, but ListServers only enumerates real tmux servers, so skip
		// them rather than spend a doomed probe subprocess on each.
		if strings.HasSuffix(name, LockSocketSuffix) {
			continue
		}
		wg.Add(1)
		sem <- struct{}{} // acquire semaphore slot
		go func(name string) {
			defer wg.Done()
			defer func() { <-sem }() // release
			if keepServerForListing(ctx, name) {
				mu.Lock()
				servers = append(servers, name)
				mu.Unlock()
			}
		}(name)
	}
	wg.Wait()
	if strict && ctx.Err() != nil {
		return nil, ctx.Err()
	}

	// Env-gated test-isolation filter (via the shared ServerAllowed predicate).
	// Applied AFTER the liveness probe so only matching LIVE servers survive.
	// Unset/empty env => admits everything, so production behavior is unchanged.
	if allowlist := os.Getenv(ServerAllowlistEnv); strings.TrimSpace(allowlist) != "" {
		filtered := servers[:0]
		for _, name := range servers {
			if ServerAllowed(name) {
				filtered = append(filtered, name)
			}
		}
		servers = filtered
	}

	sort.Strings(servers)
	return servers, nil
}

// SetExitEmptyOff sets the server-scoped `exit-empty off` option on the named
// tmux server so the server is NOT reaped when its session count momentarily
// reaches zero. tmux's default is `exit-empty on`, which destroys the whole
// server (taking live agent sessions with it) the instant the last session
// closes — a Constitution VI violation. The embedded tmux.conf only reaches
// run-kit-CREATED servers via `-f`; this imperative set covers every server
// run-kit touches, including hand-created/foreign ones that never loaded our
// config. It is the backstop for the brief restart/reconnect window where the
// `_rk-ctl` anchor floor is momentarily absent (see tmuxctl.productionDial,
// which calls this BEFORE creating the anchor on every dial/reconnect).
//
// Server-scoped (`-g`) and idempotent — safe to re-run on every dial. Mirrors
// the existing tmuxExecServer/serverArgs exec pattern (no shell strings,
// ctx-scoped with TmuxTimeout). Change: 260602-a1wo-prevent-exit-empty-server-death.
func SetExitEmptyOff(ctx context.Context, server string) error {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	_, err := tmuxExecServer(ctx, server, "set-option", "-g", "exit-empty", "off")
	return err
}

// serverGoneText holds the tmux stderr fragments that mean the server's socket
// is gone — killed, never started, or otherwise unreachable. tmux uses several
// phrasings: a killed server reports "no server running on <path>", a socket
// that never existed reports "error connecting to <path> (No such file or
// directory)", and "failed to connect" is the older/alternate phrasing. This is
// the single definition of the bare dead-server sentinel set shared with the
// tmuxctl layer (Constitution III): tmuxctl.matchesServerDeadText delegates here
// via IsServerGone. Note: other tmux-package sites (e.g. ListKeys, KillServer,
// board enumeration) intentionally pair these phrasings with "invalid option"/
// "unknown option" for a distinct "absent-option-OR-dead" check and are out of
// scope here.
var serverGoneText = []string{
	"no server running",
	"failed to connect",
	"No such file or directory",
	// A client that connects while the server is mid-teardown (kill-server
	// returns before the process exits and unlinks its socket) loses the
	// connection and reports this instead of a dead-socket error. The server
	// is equally gone — without this sentinel a probe racing the death throes
	// surfaces a hard error where "dead" is the truthful answer.
	"server exited unexpectedly",
}

// IsServerGone reports whether err indicates the tmux server's socket is gone —
// killed, never started, or otherwise unreachable. Matches tmux's stderr for a
// missing/dead socket across the known phrasings. A nil error returns false.
func IsServerGone(err error) bool {
	if err == nil {
		return false
	}
	return containsServerGoneText(err.Error())
}

// containsServerGoneText reports whether s contains any dead-server sentinel
// substring. Accepts a raw string so callers holding stderr/error text (not an
// error value) can share the same sentinel set.
func containsServerGoneText(s string) bool {
	for _, frag := range serverGoneText {
		if strings.Contains(s, frag) {
			return true
		}
	}
	return false
}

// ListKeys runs "tmux list-keys" on the given server and returns the raw output lines.
// Returns nil (no error) if the server is not running.
func ListKeys(server string) ([]string, error) {
	ctx, cancel := withTimeout()
	defer cancel()

	lines, err := tmuxExecServer(ctx, server, "list-keys")
	if err != nil {
		// Server not running — return empty, not error
		if strings.Contains(err.Error(), "No such file or directory") ||
			strings.Contains(err.Error(), "no server running") {
			return nil, nil
		}
		return nil, err
	}
	return lines, nil
}

// KillServer kills a tmux server by name.
// Returns nil if the server is already gone (no socket).
func KillServer(server string) error {
	ctx, cancel := withTimeout()
	defer cancel()

	killAudit("kill-server", server, server)
	_, err := tmuxExecServer(ctx, server, "kill-server")
	if err != nil && strings.Contains(err.Error(), "No such file or directory") {
		return nil
	}
	return err
}

// GetSessionOrder reads the user-defined session order from tmux user-option
// @rk_srv_session_order. The stored value is a JSON-encoded array of session names.
//
// Returns an empty (non-nil) slice and a nil error when the option is unset.
// "Unset" is detected by tmux's stderr message ("unknown option") OR by the
// "no server running" / "failed to connect" socket-not-found cases — these
// are normal operational states (fresh server, no order ever set) and not
// errors that should bubble up.
//
// Other subprocess failures (exec failure, permission, malformed value) AND
// JSON decode errors propagate as wrapped errors so callers can surface 5xx.
func GetSessionOrder(ctx context.Context, server string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	out, err := tmuxExecRawServer(ctx, server, "show-option", "-sv", SessionOrderOption)
	if err != nil {
		errMsg := err.Error()
		// Treat "option unset" and "no server" as empty rather than an error.
		// Both are normal first-use states. tmux uses "invalid option:" for
		// unset user-options and "no server running"/"failed to connect" for
		// the absent-socket case.
		if strings.Contains(errMsg, "invalid option") ||
			strings.Contains(errMsg, "unknown option") ||
			strings.Contains(errMsg, "no server running") ||
			strings.Contains(errMsg, "failed to connect") {
			return []string{}, nil
		}
		return nil, fmt.Errorf("read %s: %w", SessionOrderOption, err)
	}
	raw := strings.TrimSpace(out)
	if raw == "" {
		return []string{}, nil
	}
	var order []string
	if jerr := json.Unmarshal([]byte(raw), &order); jerr != nil {
		return nil, fmt.Errorf("decode %s: %w", SessionOrderOption, jerr)
	}
	if order == nil {
		order = []string{}
	}
	return order, nil
}

// SetSessionOrder writes the session order to tmux user-option
// @rk_srv_session_order as a JSON-encoded array. A nil slice is treated as the
// empty slice (encoded as "[]") so that round-trips through GetSessionOrder
// are lossless.
func SetSessionOrder(ctx context.Context, server string, order []string) error {
	if order == nil {
		order = []string{}
	}
	encoded, err := json.Marshal(order)
	if err != nil {
		return fmt.Errorf("encode session order: %w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	_, err = tmuxExecRawServer(ctx, server, "set-option", "-s", SessionOrderOption, string(encoded))
	return err
}

// GetServerRank reads this server's user-defined display rank from the
// server-scoped user option @rk_srv_rank.
//
// Returns (nil, nil) when the option is unset. "Unset" is detected by tmux's
// stderr ("invalid option"/"unknown option") OR by the "no server running" /
// "failed to connect" socket-not-found cases — all normal operational states
// (fresh server, no rank ever set) that must NOT bubble as errors, exactly
// mirroring GetSessionOrder's taxonomy.
//
// Other subprocess failures AND a malformed (non-integer) stored value
// propagate as wrapped errors so callers can distinguish real failure.
func GetServerRank(ctx context.Context, server string) (*int, error) {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	out, err := tmuxExecRawServer(ctx, server, "show-option", "-sv", ServerRankOption)
	if err != nil {
		errMsg := err.Error()
		// Unset user-option ("invalid/unknown option") OR a dead/absent server
		// socket (IsServerGone: "no server running" / "failed to connect" /
		// "No such file or directory") are all normal first-use states, not
		// errors. IsServerGone is the shared dead-server sentinel (Constitution
		// III), covering the socket-file-missing case that a bare
		// "failed to connect" substring check would miss.
		if strings.Contains(errMsg, "invalid option") ||
			strings.Contains(errMsg, "unknown option") ||
			IsServerGone(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read %s: %w", ServerRankOption, err)
	}
	raw := strings.TrimSpace(out)
	if raw == "" {
		return nil, nil
	}
	rank, cerr := strconv.Atoi(raw)
	if cerr != nil {
		return nil, fmt.Errorf("decode %s: %w", ServerRankOption, cerr)
	}
	return &rank, nil
}

// SetServerRank writes this server's display rank to the server-scoped user
// option @rk_srv_rank as a decimal integer string. Mirrors SetSessionOrder.
func SetServerRank(ctx context.Context, server string, rank int) error {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	_, err := tmuxExecRawServer(ctx, server, "set-option", "-s", ServerRankOption, strconv.Itoa(rank))
	return err
}

// GetServerOrigin reads this server's covering-deployment origin from the
// server-scoped user option @rk_srv_origin.
//
// Returns ("", nil) when the option is unset. "Unset" is detected by tmux's
// stderr ("invalid option"/"unknown option") OR by the dead/absent socket
// cases (IsServerGone) — all normal first-use states (fresh server, no
// covering daemon ever stamped it) that must NOT bubble as errors, exactly
// mirroring GetServerRank's taxonomy.
//
// Other subprocess failures propagate as wrapped errors. The stored value is
// returned verbatim (no validation) — validation for use as a request target
// is the consumer's job (see cmd/rk/origin.go).
func GetServerOrigin(ctx context.Context, server string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	out, err := tmuxExecRawServer(ctx, server, "show-option", "-sv", OriginOption)
	if err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, "invalid option") ||
			strings.Contains(errMsg, "unknown option") ||
			IsServerGone(err) {
			return "", nil
		}
		return "", fmt.Errorf("read %s: %w", OriginOption, err)
	}
	return strings.TrimSpace(out), nil
}

// SetServerOrigin writes this server's covering-deployment origin to the
// server-scoped user option @rk_srv_origin. Mirrors SetServerRank.
func SetServerOrigin(ctx context.Context, server, origin string) error {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	_, err := tmuxExecRawServer(ctx, server, "set-option", "-s", OriginOption, origin)
	return err
}

// GetOperatorRoot reads this server's last operator launch directory from the
// server-scoped user option @rk_srv_operator_root.
//
// Returns ("", nil) when the option is unset. "Unset" is detected by tmux's
// stderr ("invalid option"/"unknown option") OR by the dead/absent socket
// cases (IsServerGone) — all normal first-use states (fresh server, no
// operator ever launched) that must NOT bubble as errors, exactly mirroring
// GetServerOrigin's taxonomy. Other subprocess failures propagate as wrapped
// errors. The stored value is returned verbatim — validation for use as a
// launch directory (absolute, exists, is a directory) is the caller's job.
func GetOperatorRoot(ctx context.Context, server string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	out, err := tmuxExecRawServer(ctx, server, "show-option", "-sv", OperatorRootOption)
	if err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, "invalid option") ||
			strings.Contains(errMsg, "unknown option") ||
			IsServerGone(err) {
			return "", nil
		}
		return "", fmt.Errorf("read %s: %w", OperatorRootOption, err)
	}
	// Strip only tmux's line terminator — the value is a directory path, so
	// leading/trailing whitespace in it is significant and kept verbatim.
	return strings.TrimSuffix(out, "\n"), nil
}

// SetOperatorRoot writes this server's last operator launch directory to the
// server-scoped user option @rk_srv_operator_root. Mirrors SetServerOrigin.
func SetOperatorRoot(ctx context.Context, server, dir string) error {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	_, err := tmuxExecRawServer(ctx, server, "set-option", "-s", OperatorRootOption, dir)
	return err
}

// isUnsetOptionErr reports whether a tmux subprocess error is the "option is
// not set" diagnostic (show-option/set-option -u against an absent user
// option) — distinct from a dead server (IsServerGone) and from real failures.
func isUnsetOptionErr(err error) bool {
	errMsg := err.Error()
	return strings.Contains(errMsg, "invalid option") ||
		strings.Contains(errMsg, "unknown option")
}

// readServerMarkDual reads a server-scoped boolean mark new-name-first:
// option via `show-option -sv`; when it is unset, the retired legacy name is
// read the same way (externally-written keys are dual-read for a release
// before the old name is dropped). A non-empty trimmed value of whichever
// resolved is truthy. An unset option on BOTH names OR a dead/absent socket
// (IsServerGone) reads as (false, nil) — liveness is the caller's concern, and
// a gone server is never marked. Other subprocess failures propagate wrapped.
func readServerMarkDual(ctx context.Context, server, option, legacy string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	out, err := tmuxExecRawServer(ctx, server, "show-option", "-sv", option)
	if err != nil && isUnsetOptionErr(err) {
		out, err = tmuxExecRawServer(ctx, server, "show-option", "-sv", legacy)
	}
	if err != nil {
		if isUnsetOptionErr(err) || IsServerGone(err) {
			return false, nil
		}
		return false, fmt.Errorf("read %s: %w", option, err)
	}
	return strings.TrimSpace(out) != "", nil
}

// ServerMarks is the batched per-server option read for the /api/servers
// fan-out — one dump carries what the per-option readers (GetServerRank,
// readServerMarkDual, IsManagedServer's option leg) read individually.
type ServerMarks struct {
	Rank      *int // @rk_srv_rank; nil when unset
	Ephemeral bool // @rk_srv_ephemeral, legacy @rk_ephemeral
	Protected bool // @rk_srv_protected, legacy @rk_protected
	Managed   bool // @rk_srv_managed (no legacy name)
}

// ReadServerMarks reads all of a server's rk marks in ONE `show-options -s`
// dump, keeping the /api/servers fan-out at one option exec per server instead
// of four. The parse (parseServerMarks) preserves readServerMarkDual's
// dual-read taxonomy. A dead/absent socket (IsServerGone) reads as zero marks
// with a nil error — liveness is the caller's concern, and a gone server is
// never marked; other subprocess failures propagate wrapped.
func ReadServerMarks(ctx context.Context, server string) (ServerMarks, error) {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	out, err := tmuxExecRawServer(ctx, server, "show-options", "-s")
	if err != nil {
		if IsServerGone(err) {
			return ServerMarks{}, nil
		}
		return ServerMarks{}, fmt.Errorf("read server marks: %w", err)
	}
	return parseServerMarks(out)
}

// parseServerMarks parses a `show-options -s` dump (`name value` lines) into
// ServerMarks. Pure so the full taxonomy is unit-testable without live tmux.
// Rank mirrors GetServerRank: absent or empty ⇒ nil; a malformed (non-integer)
// value propagates a wrapped decode error. Dump values may be tmux-quoted
// (`@rk_srv_rank "3"`); one pair of surrounding double quotes is stripped.
func parseServerMarks(dump string) (ServerMarks, error) {
	values := map[string]string{}
	for _, line := range strings.Split(dump, "\n") {
		name, value, found := strings.Cut(strings.TrimSpace(line), " ")
		if name == "" {
			continue
		}
		if !found {
			value = ""
		}
		values[name] = unquoteOptionValue(strings.TrimSpace(value))
	}

	var marks ServerMarks
	if raw := values[ServerRankOption]; raw != "" {
		rank, err := strconv.Atoi(raw)
		if err != nil {
			return ServerMarks{}, fmt.Errorf("decode %s: %w", ServerRankOption, err)
		}
		marks.Rank = &rank
	}
	marks.Ephemeral = dumpMarkDual(values, EphemeralOption, LegacyEphemeralOption)
	marks.Protected = dumpMarkDual(values, ProtectedOption, LegacyProtectedOption)
	marks.Managed = strings.TrimSpace(values[ManagedOption]) != ""
	return marks, nil
}

// dumpMarkDual applies the dual-read taxonomy to a parsed dump: the new name
// wins when PRESENT (even with an empty value, which reads false — mirroring
// readServerMarkDual, which consults the legacy name only on the unset
// diagnostic); the legacy name is consulted only when the new name is absent
// from the dump (the batched equivalent of the "invalid/unknown option"
// stderr). A non-empty trimmed value is truthy.
func dumpMarkDual(values map[string]string, option, legacy string) bool {
	if v, ok := values[option]; ok {
		return strings.TrimSpace(v) != ""
	}
	return strings.TrimSpace(values[legacy]) != ""
}

// unquoteOptionValue strips one pair of surrounding double quotes — tmux's
// show-options dump quotes values that contain spaces or special characters.
func unquoteOptionValue(v string) string {
	if len(v) >= 2 && strings.HasPrefix(v, `"`) && strings.HasSuffix(v, `"`) {
		return v[1 : len(v)-1]
	}
	return v
}

// IsEphemeralServer reports whether the named server carries the
// EphemeralOption mark — read new-name-first with LegacyEphemeralOption as
// the dual-read fallback (readServerMarkDual owns the taxonomy).
func IsEphemeralServer(ctx context.Context, server string) (bool, error) {
	return readServerMarkDual(ctx, server, EphemeralOption, LegacyEphemeralOption)
}

// MarkServerEphemeral writes the EphemeralOption creator opt-out mark ("1")
// server-scoped on the named server. Mirrors SetServerOrigin. Requires a live
// server — server-scoped options need a running tmux process.
func MarkServerEphemeral(ctx context.Context, server string) error {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	_, err := tmuxExecRawServer(ctx, server, "set-option", "-s", EphemeralOption, "1")
	return err
}

// IsProtectedServer reports whether the named server carries the
// ProtectedOption mark — read new-name-first with LegacyProtectedOption as
// the dual-read fallback (readServerMarkDual owns the taxonomy).
func IsProtectedServer(ctx context.Context, server string) (bool, error) {
	return readServerMarkDual(ctx, server, ProtectedOption, LegacyProtectedOption)
}

// MarkServerProtected writes the ProtectedOption mark ("1") server-scoped on
// the named server. Mirrors MarkServerEphemeral. Requires a live server —
// server-scoped options need a running tmux process.
func MarkServerProtected(ctx context.Context, server string) error {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	_, err := tmuxExecRawServer(ctx, server, "set-option", "-s", ProtectedOption, "1")
	return err
}

// UnmarkServerProtected removes the ProtectedOption mark from the named
// server (set-option -s -u) — unset demotes; there is no tombstone value. The
// retired legacy name is unset too: either name may be the armed one during
// the dual-read window, and a demote that left LegacyProtectedOption behind
// would re-arm the guard through the fallback read.
func UnmarkServerProtected(ctx context.Context, server string) error {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	for _, name := range []string{ProtectedOption, LegacyProtectedOption} {
		if _, err := tmuxExecRawServer(ctx, server, "set-option", "-s", "-u", name); err != nil {
			if isUnsetOptionErr(err) {
				continue
			}
			return fmt.Errorf("unset %s: %w", name, err)
		}
	}
	return nil
}

// IsGuardedServer is the combined kill-guard predicate: true when name is the
// rk-daemon production server (protected by derivation from its constant
// socket name — the derived state is not togglable and an option write on it
// is never the source of truth) OR the server carries the ProtectedOption
// mark. The daemon check short-circuits before any tmux read, so the derived
// answer needs no live server and never errors.
func IsGuardedServer(ctx context.Context, name string) (bool, error) {
	if name == productionDaemonServer {
		return true, nil
	}
	return IsProtectedServer(ctx, name)
}

// MarkServerManaged writes the ManagedOption provenance mark ("1")
// server-scoped on the named server. Mirrors MarkServerProtected. Requires a
// live server — server-scoped options need a running tmux process.
func MarkServerManaged(ctx context.Context, server string) error {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	_, err := tmuxExecRawServer(ctx, server, "set-option", "-s", ManagedOption, "1")
	return err
}

// UnmarkServerManaged removes the ManagedOption mark from the named server
// (set-option -s -u). It exists only as the adopt-failure rollback — a stamped
// server whose conf never applied is never left behind.
func UnmarkServerManaged(ctx context.Context, server string) error {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	_, err := tmuxExecRawServer(ctx, server, "set-option", "-s", "-u", ManagedOption)
	return err
}

// IsManagedServer is the combined provenance predicate: true when name is the
// rk-daemon production server (managed by derivation from its constant socket
// name — the derived state is not togglable and an option write on it is never
// the source of truth) OR the server carries the ManagedOption mark (a
// non-empty trimmed value is truthy; "1" is the documented convention). The
// daemon check short-circuits before any tmux read, so the derived answer
// needs no live server and never errors. The option read follows
// IsProtectedServer's taxonomy exactly: an unset option ("invalid
// option"/"unknown option" stderr) OR a dead/absent socket (IsServerGone)
// reads as (false, nil) — liveness is the caller's concern, and a gone server
// is never managed. Other subprocess failures propagate wrapped.
func IsManagedServer(ctx context.Context, name string) (bool, error) {
	if name == productionDaemonServer {
		return true, nil
	}
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	out, err := tmuxExecRawServer(ctx, name, "show-option", "-sv", ManagedOption)
	if err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, "invalid option") ||
			strings.Contains(errMsg, "unknown option") ||
			IsServerGone(err) {
			return false, nil
		}
		return false, fmt.Errorf("read %s: %w", ManagedOption, err)
	}
	return strings.TrimSpace(out) != "", nil
}

// stampManagedOnBirth writes the ManagedOption provenance mark after a create
// whose pre-probe read the server dead/absent (i.e. that create birthed the
// server — the moment its -f <managed conf> actually applied). A stamp failure
// degrades the server to external and never fails the create; the adopt verb
// recovers it.
func stampManagedOnBirth(ctx context.Context, server string, birthsServer bool) {
	if !birthsServer {
		return
	}
	if err := MarkServerManaged(ctx, server); err != nil {
		slog.Warn("managed stamp failed; server reads external until adopted",
			"server", server, "err", err)
	}
}
