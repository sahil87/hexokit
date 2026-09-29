// Package settings owns the hexokit preference store at
// ~/.config/hexokit/config.yaml — the single registry-driven settings
// surface.
//
// Override order: code default < config.yaml < env < CLI flag. Env forms
// exist ONLY for deployment-bootstrap keys (RK_PORT, RK_HOST,
// RK_CODE_SERVER_PORT); the daemon port is the one bootstrap binding that is
// also a config.yaml key here (the `port` entry — RK_PORT still wins over
// it). RK_HOST and RK_CODE_SERVER_PORT stay env-only. The only other env
// reads are the undocumented per-process escapes RK_TMUX_CONF, LOG_LEVEL, and
// RK_CONFIG_DIR (below), which win over their config.yaml keys but are never
// user-facing.
//
// The config root is fixed under $HOME/.config — never $XDG_CONFIG_HOME,
// never os.UserConfigDir: rk runs as daemon + CLI + agents-in-panes, and an
// env-dependent path would silently fork which file each context reads. Only
// $HOME moves the root, with one test-only carve-out: RK_CONFIG_DIR
// (ConfigDirEnv) relocates the root verbatim so the e2e harness can isolate
// per-run config state — the same class of in-package,
// unset-means-production-identical escape as RK_SERVER_ALLOWLIST and
// RK_TMUX_CONF, never user-facing deployment configuration. The home dir name
// itself resolves through internal/apphome (hexokit, dual-reading the legacy
// run-kit dir for one release).
package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"rk/internal/apphome"
	"rk/internal/gui"
	"rk/internal/portpolicy"
	"rk/internal/validate"
)

// Settings holds user preferences persisted at ~/.config/hexokit/config.yaml
// (a legacy ~/.rk/settings.yaml is fallback-read and migrated on first save).
type Settings struct {
	Theme      string
	ThemeDark  string
	ThemeLight string
	// InstanceColor is the per-instance accent color ("host color") — a color
	// value descriptor ("4" for a single ANSI index, "1+3" for a two-hue
	// blend). Scalar (one color per instance), unlike the ServerColors map.
	// Empty means "no explicit color set" — the frontend falls back to a
	// hostname-hash default. Stored as a string so a blend can round-trip;
	// reads tolerate a legacy bare integer (normalized on load).
	InstanceColor string
	// SSHHost is the verbatim SSH destination remote clients use to reach this
	// host — an alias from the client's ~/.ssh/config or a `user@host` form.
	// Empty means "unset": /api/health then omits sshHost (this key is the
	// only ssh-host surface — no env form exists). Scalar, like InstanceColor.
	SSHHost string
	// Port is the daemon listen port pinned in config.yaml. 0 means "unset":
	// the effective port falls back to the code default (portpolicy.DaemonDefault).
	// RK_PORT, when set to a valid port, wins over this key. Read at serve
	// startup (and by every CLI that resolves the origin), so a change applies
	// on the next daemon restart.
	Port int
	// PortPinNote records that the file carried the migration's pin comment
	// (PortPinComment) above the port key, so serialize re-emits it. Any
	// registry write to port clears the flag: a user-chosen port is no longer
	// the migration pin.
	PortPinNote bool
	// InstanceName is the display-name override for this run-kit instance.
	// Empty means "unset": display surfaces derive the name from os.Hostname()
	// (via /api/health `hostname`). Scalar, like InstanceColor.
	InstanceName string
	// server name → color value descriptor ("4" for a single ANSI index,
	// "1+3" for a two-hue blend). Stored as a string so a blend can round-trip;
	// reads tolerate a legacy bare integer (normalized on load).
	ServerColors map[string]string
	// ServerFlairs is server name → flair token — the flair decoration on the
	// server's sidebar surfaces (group header, SERVER tile). A closed set
	// (validate.FlairValues, the single universal vocabulary); reads drop
	// anything outside it.
	ServerFlairs map[string]string
	// BoardOrder is the user-defined display order of board names; rank = slice
	// index. Boards absent from the list sort after ranked boards, alphabetically
	// (the sort itself lives at the API layer — this package only persists the
	// list). nil when no order has been set (legacy files / never reordered).
	BoardOrder []string
	// RiffPresets is the USER tier of rk riff presets only: preset name → skill
	// invocation ("" = a bare agent). The built-ins live in BuiltinRiffPresets
	// (the code tier), not in this map — a user entry matching a built-in's name
	// overrides it, any other name is an addition. RiffPresets(Settings) is the
	// merged view every read site uses. nil at default so the section omits.
	RiffPresets map[string]string
	// AutoName arms the auto-name-on-idle trigger: on a window's busy→idle
	// transition the server's operator window is handed a fix-tab-name request.
	// Strictly opt-in (default false — the trigger injects prompts into the
	// operator on its own). A settings POST applies the new value to the
	// running hub's tracker without a daemon restart.
	AutoName bool
	// CronTicker runs the cron tick evaluator inside the daemon. On by
	// default; read by the ticker at every iteration, so a flip takes effect
	// without a daemon restart.
	CronTicker bool
	// PrReviewListener runs the PR-review comment listener inside the daemon:
	// armed windows (@rk_win_pr_listen) have their unhandled review threads
	// dispatched into their own agent. On by default; read at every SSE tick,
	// so a flip takes effect without a daemon restart.
	PrReviewListener bool
	// EasterEggs shows the screen-break Easter eggs' AUTOMATIC occasions (the
	// fist when the viewed tab's PR merges, the eye when an update chip lights).
	// On by default. Read by the frontend on page load and applied live in the
	// browser that flips it; the palette's explicit Easter egg entries ignore it.
	EasterEggs bool
	// GUIEnabled turns the GUI surface on: the daemon runs the host desktop
	// (the rk-gui sibling session) and the UI shows the 4th tile toggle.
	// Strictly opt-in (default false) — no code path other than an explicit
	// user write may set it true. A settings POST applies the flip live.
	GUIEnabled bool
	// GUIWM pins the window manager the GUI supervisor starts. Empty picks
	// the first installed rung of the ladder. Read at supervise start, so a
	// change applies on the next rk gui restart.
	GUIWM string
	// GUIGeometry is the GUI desktop's pixel size: a fixed WxH, or "auto" to
	// follow the focused desktop viewer's tile. Applies live via RandR when
	// the display is reachable.
	GUIGeometry string
	// TmuxConf is the path to the tmux.conf rk passes to tmux. Empty means
	// "unset": tmux resolution falls back to its built-in default. The user
	// owns the file — rk performs no ensure/refresh on it. Read at tmux
	// command construction, so a change applies on the next daemon restart.
	TmuxConf string
	// LogLevel is the daemon log verbosity: "info" or "debug". Read at serve
	// startup (the LOG_LEVEL env escape wins when set), so a change applies on
	// the next daemon restart.
	LogLevel string
}

// Default returns the default settings.
func Default() Settings {
	return Settings{
		Theme:            "system",
		ThemeDark:        "default-dark",
		ThemeLight:       "default-light",
		CronTicker:       true,
		PrReviewListener: true,
		EasterEggs:       true,
		GUIGeometry:      gui.GeometryDefault,
		LogLevel:         "info",
	}
}

// ConfigDirEnv is the test-isolation env var that relocates the config root.
// Unset or whitespace-only means production behavior (the fixed $HOME root);
// set means the value is the config root verbatim. Test harnesses only —
// never a user-facing deployment key.
const ConfigDirEnv = "RK_CONFIG_DIR"

// minPort/maxPort bound the valid TCP port range accepted by the port key's
// parse and apply hooks.
const (
	minPort = 1
	maxPort = 65535
)

// PortPinComment is the one-line note the home migration writes directly
// above a pinned `port:` key. parse recognizes the exact line and sets
// Settings.PortPinNote so serialize can re-emit it — without the round-trip
// the comment would vanish on the first whole-file Save.
const PortPinComment = "# port pinned during the HexoKit rename so remote access keeps working (fresh installs use the new default; see rk doctor)"

// Dir returns the config root: the resolved home under the fixed
// $HOME/.config (apphome.ConfigDir — the dual-read rule picks the legacy
// run-kit dir while an install is unmigrated), unless the test-only
// RK_CONFIG_DIR override is set, which wins over the rule (see ConfigDirEnv
// and the package doc comment). The only other environment input is $HOME.
func Dir() (string, error) {
	if ConfigRootOverridden() {
		return os.Getenv(ConfigDirEnv), nil
	}
	return apphome.ConfigDir()
}

// ConfigRootOverridden reports whether the RK_CONFIG_DIR test override is
// active (set to a non-whitespace value). While active, the legacy
// ~/.rk/settings.yaml fallback-read and migration rename are suppressed too —
// an isolated run must neither import the developer's real legacy settings
// nor rename a file in the real $HOME. The same suppression gates the
// home migration and the legacy-home virtual port pin.
func ConfigRootOverridden() bool {
	return strings.TrimSpace(os.Getenv(ConfigDirEnv)) != ""
}

// configPath returns the settings file path: {config root}/config.yaml (see
// Dir for the root resolution and the test-only carve-out).
func configPath() (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "config.yaml"), nil
}

// legacySettingsPath returns the pre-migration settings file location,
// ~/.rk/settings.yaml — read as a fallback when config.yaml is absent, and
// breadcrumb-renamed after a successful save.
func legacySettingsPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".rk", "settings.yaml"), nil
}

// resolveSource names the settings file Load reads: config.yaml under the
// config root when it can be opened as a regular file, else the legacy
// ~/.rk/settings.yaml (skipped under the RK_CONFIG_DIR override), else
// ("", false). Load and Stamp both go through it so they can never disagree
// about the source — an unreadable or directory-shaped primary path falls
// back to the legacy file for BOTH, otherwise Stamp would fingerprint a path
// Load never parsed and later edits to the real source would go unnoticed.
func resolveSource() (string, bool) {
	p, err := configPath()
	if err != nil {
		return "", false
	}
	if readableFile(p) {
		return p, true
	}
	if ConfigRootOverridden() {
		return "", false
	}
	legacy, lerr := legacySettingsPath()
	if lerr != nil {
		return "", false
	}
	if readableFile(legacy) {
		return legacy, true
	}
	return "", false
}

// readableFile reports whether path opens as a regular file — the same
// condition under which os.ReadFile succeeds, probed without reading it.
func readableFile(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	fi, err := f.Stat()
	return err == nil && fi.Mode().IsRegular()
}

// Load reads config.yaml from the config root (see Dir) and returns the
// parsed Settings. When that file is unreadable, it falls back to the legacy
// ~/.rk/settings.yaml (same format — skipped under the RK_CONFIG_DIR
// override); when both are absent or unreadable it returns Default().
func Load() Settings {
	p, ok := resolveSource()
	if !ok {
		return Default()
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return Default()
	}
	return parse(string(data))
}

// ParseBytes runs the config.yaml parser over raw bytes without touching the
// filesystem or home resolution — the home migration's pin decision reads the
// legacy file's port this way so the parse rules can never drift.
func ParseBytes(data []byte) Settings {
	return parse(string(data))
}

// Stamp returns a change fingerprint of the settings file Load would read:
// path + mtime + size of the source resolveSource picks, so the fallback to
// the legacy file is identical to Load's. An absent or unreadable source
// yields the stable empty fingerprint, so "no file" never reads as a change.
// Callers use it as a cheap stat gate to re-parse only when the file changed.
func Stamp() string {
	p, ok := resolveSource()
	if !ok {
		return ""
	}
	fi, err := os.Stat(p)
	if err != nil {
		return ""
	}
	return stampString(p, fi)
}

// stampString renders the fingerprint for one stat-ed file.
func stampString(path string, fi os.FileInfo) string {
	return fmt.Sprintf("%s:%d:%d", path, fi.ModTime().UnixNano(), fi.Size())
}

// Save writes the settings to config.yaml under the config root (see Dir),
// creating the root if absent. After a successful write, a still-present
// legacy ~/.rk/settings.yaml is renamed to settings.yaml.migrated —
// best-effort; a rename failure never fails the save, and the rename is
// skipped under the RK_CONFIG_DIR override (never touch the real $HOME
// from an isolated run).
func Save(s Settings) error {
	p, err := configPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		return err
	}
	content := serialize(s)
	if err := os.WriteFile(p, []byte(content), 0644); err != nil {
		return err
	}
	if !ConfigRootOverridden() {
		if legacy, err := legacySettingsPath(); err == nil {
			_ = os.Rename(legacy, legacy+".migrated")
		}
	}
	return nil
}

// nestedSection describes one nested config.yaml section for parse/serialize.
// Two shapes exist, built by mapSection (string map: `  name: "value"` entries)
// and listSection (string list: `  - "value"` entries). Adding a section is a
// registry entry plus its Settings field — not new scanner branches.
type nestedSection struct {
	// key is the section heading ("server_colors").
	key string
	// parseEntry consumes one indented, non-empty, non-comment line (trimmed)
	// while this section is active, silently skipping malformed entries.
	parseEntry func(s *Settings, trimmed string)
	// serialize emits the whole section (heading + entries), or "" when the
	// section is empty — sections are omitted when empty so a settings file
	// without them serializes byte-identically to one that never had them.
	serialize func(s *Settings) string
}

// registryEntry is one settings key in the single-source-of-truth registry.
// Scalar entries carry parse/serialize hooks; nested entries (maps and lists)
// carry a section built by mapSection/listSection instead. Adding a key is one
// entry — parse and serialize need no new branches.
type registryEntry struct {
	key      string // config.yaml key ("theme", "server_colors")
	kind     string // value type: enum, string, color, path, bool, map, list
	def      string // default value, text form ("{}", "[]" for nested sections)
	desc     string // one-line description
	category string // grouping for later UI surfaces
	ui       bool   // exposed on the settings UI surface
	live     bool   // applies on next read without a daemon restart
	// options lists an enum kind's legal values in display order. Display
	// metadata for generated controls only — the apply hook owns enforcement.
	// Nil on non-enum kinds.
	options []string
	// parse consumes one scalar "key: value" line (value already trimmed).
	// Nil on nested-section entries.
	parse func(s *Settings, value string)
	// serialize emits the scalar line(s) for the key, or "" when the value is
	// at its default — defaults are omitted so an untouched file round-trips
	// byte-identically. Nil on nested-section entries.
	serialize func(s *Settings) string
	// section is the nested-section machinery for map/list keys. Zero value
	// (section.key == "") on scalar entries.
	section nestedSection
	// read returns the key's current value in its natural JSON shape for
	// GET /api/settings: a string pointer (nil surfaces as JSON null), a
	// bool, a map[string]string, or a []string.
	read func(s *Settings) any
	// apply merges one JSON patch value onto s per Constitution IX
	// partial-merge semantics (null unsets; string scalars trim, with
	// trimmed-to-empty treated as null; maps merge per-entry with an entry
	// null unsetting that entry and a top-level null clearing the map; the
	// list replaces wholesale with null equivalent to []). The value is
	// validated before s is touched — an error means no mutation.
	apply func(s *Settings, value json.RawMessage) error
}

// registry is the single source of truth for every settings key. Slice order
// IS serialization order: scalar keys first (theme … log_level), then the
// nested sections. Descriptions/defaults/flags are data for the settings API
// and pane that later phases build on this table.
var registry = []registryEntry{
	{
		key: "theme", kind: "enum", def: "system",
		desc:     "UI color mode — system, dark, light, or a named theme.",
		category: "appearance", ui: true, live: true,
		options: []string{"system", "dark", "light"},
		parse: func(s *Settings, value string) {
			if value != "" {
				s.Theme = value
			}
		},
		serialize: func(s *Settings) string { return "theme: " + s.Theme + "\n" },
		read:      func(s *Settings) any { v := s.Theme; return &v },
		apply:     nonEmptyString(func(s *Settings) *string { return &s.Theme }, "system"),
	},
	{
		key: "theme_dark", kind: "string", def: "default-dark",
		desc:     "Theme applied when the UI is in dark mode.",
		category: "appearance", ui: true, live: true,
		parse: func(s *Settings, value string) {
			if value != "" {
				s.ThemeDark = value
			}
		},
		serialize: func(s *Settings) string { return "theme_dark: " + s.ThemeDark + "\n" },
		read:      func(s *Settings) any { v := s.ThemeDark; return &v },
		apply:     nonEmptyString(func(s *Settings) *string { return &s.ThemeDark }, "default-dark"),
	},
	{
		key: "theme_light", kind: "string", def: "default-light",
		desc:     "Theme applied when the UI is in light mode.",
		category: "appearance", ui: true, live: true,
		parse: func(s *Settings, value string) {
			if value != "" {
				s.ThemeLight = value
			}
		},
		serialize: func(s *Settings) string { return "theme_light: " + s.ThemeLight + "\n" },
		read:      func(s *Settings) any { v := s.ThemeLight; return &v },
		apply:     nonEmptyString(func(s *Settings) *string { return &s.ThemeLight }, "default-light"),
	},
	{
		key: "instance_color", kind: "color", def: "",
		desc:     "Per-instance accent color descriptor (\"4\" for one ANSI index, \"1+3\" for a two-hue blend).",
		category: "appearance", ui: true, live: true,
		// Tolerant read: accept a legacy bare integer OR the quoted string
		// descriptor ("1+3"); normalize and drop anything malformed.
		parse: func(s *Settings, value string) {
			colorStr := strings.Trim(value, "\"")
			if normalized, ok := validate.NormalizeColorValue(colorStr); ok {
				s.InstanceColor = normalized
			}
		},
		// Always quoted so a blend ("1+3") round-trips unambiguously.
		serialize: quotedScalar("instance_color", func(s *Settings) *string { return &s.InstanceColor }),
		read:      emptyableString(func(s *Settings) *string { return &s.InstanceColor }),
		apply:     validatedScalar(func(s *Settings) *string { return &s.InstanceColor }, validate.ValidateColorValue, ""),
	},
	{
		key: "ssh_host", kind: "string", def: "",
		desc:     "Verbatim SSH destination remote clients use to reach this host (ssh config alias or user@host).",
		category: "connectivity", ui: true, live: true,
		// Tolerant read: quote-stripped and trimmed (serialize always quotes
		// so the value round-trips unambiguously).
		parse:     quoteTrimmedScalar(func(s *Settings) *string { return &s.SSHHost }),
		serialize: quotedScalar("ssh_host", func(s *Settings) *string { return &s.SSHHost }),
		read:      emptyableString(func(s *Settings) *string { return &s.SSHHost }),
		apply:     validatedScalar(func(s *Settings) *string { return &s.SSHHost }, validate.ValidateSSHHost, ""),
	},
	{
		key: "port", kind: "port", def: strconv.Itoa(portpolicy.DaemonDefault),
		desc:     "Daemon listen port. RK_PORT wins when set. Takes effect on the next daemon restart (rk daemon restart); re-point Tailscale Serve / bookmarks after a move.",
		category: "connectivity", ui: false, live: false,
		// Tolerant read: quote-stripped, trimmed, kept only when a valid port;
		// anything else stays unset and never errors.
		parse: func(s *Settings, value string) {
			if n, err := strconv.Atoi(strings.TrimSpace(strings.Trim(value, "\""))); err == nil && n >= minPort && n <= maxPort {
				s.Port = n
			}
		},
		// Serialize-when-set, INCLUDING a value equal to the default: the key
		// is a pin, and Save rewrites the whole file — omit-at-default would
		// silently drop a `port: 3000` pin on any settings save. Port == 0
		// (unset) emits nothing, so an untouched file round-trips
		// byte-identically. The migration's pin comment (PortPinComment) is
		// re-emitted directly above the key while PortPinNote holds.
		serialize: func(s *Settings) string {
			if s.Port != 0 {
				if s.PortPinNote {
					return PortPinComment + "\nport: " + strconv.Itoa(s.Port) + "\n"
				}
				return "port: " + strconv.Itoa(s.Port) + "\n"
			}
			return ""
		},
		// Natural JSON shape: the number when set, null when unset.
		read: func(s *Settings) any {
			if s.Port != 0 {
				return s.Port
			}
			return nil
		},
		// Strict write: JSON integers in range only (no numeric strings) —
		// the registry's strict-write/tolerant-read posture. Any successful
		// write, set or null, clears PortPinNote: a user-chosen port is no
		// longer the migration pin.
		apply: func(s *Settings, raw json.RawMessage) error {
			if jsonNull(raw) {
				s.Port = 0
				s.PortPinNote = false
				return nil
			}
			var n int
			if err := json.Unmarshal(raw, &n); err != nil {
				return fmt.Errorf("port must be an integer %d-%d or null: %w", minPort, maxPort, err)
			}
			if n < minPort || n > maxPort {
				return fmt.Errorf("port must be an integer %d-%d, got %d", minPort, maxPort, n)
			}
			s.Port = n
			s.PortPinNote = false
			return nil
		},
	},
	{
		key: "instance_name", kind: "string", def: "",
		desc:     "Display-name override for this run-kit instance.",
		category: "identity", ui: true, live: true,
		parse:     quoteTrimmedScalar(func(s *Settings) *string { return &s.InstanceName }),
		serialize: quotedScalar("instance_name", func(s *Settings) *string { return &s.InstanceName }),
		read:      emptyableString(func(s *Settings) *string { return &s.InstanceName }),
		apply:     validatedScalar(func(s *Settings) *string { return &s.InstanceName }, validate.ValidateInstanceName, ""),
	},
	{
		key: "auto_name", kind: "bool", def: "false",
		desc:     "Arms the auto-name-on-idle trigger: the operator window is asked to fix tab names on busy→idle transitions.",
		category: "behavior", ui: true, live: true,
		// Tolerant read: any strconv.ParseBool value; anything else keeps the
		// default (off) — the safe direction for an opt-in trigger.
		parse: func(s *Settings, value string) {
			if b, err := strconv.ParseBool(strings.Trim(value, "\"")); err == nil {
				s.AutoName = b
			}
		},
		serialize: func(s *Settings) string {
			if s.AutoName {
				return "auto_name: true\n"
			}
			return ""
		},
		read:  func(s *Settings) any { return s.AutoName },
		apply: boolValue(func(s *Settings) *bool { return &s.AutoName }, false),
	},
	{
		key: "cron_ticker", kind: "bool", def: "true",
		desc:     "Runs the cron tick evaluator inside the daemon: scheduled entries fire while the daemon is up.",
		category: "behavior", ui: true, live: true,
		// Tolerant read: any strconv.ParseBool value; anything else keeps the
		// default (on) — the safe direction for a scheduling substrate.
		parse: func(s *Settings, value string) {
			if b, err := strconv.ParseBool(strings.Trim(value, "\"")); err == nil {
				s.CronTicker = b
			}
		},
		serialize: func(s *Settings) string {
			if !s.CronTicker {
				return "cron_ticker: false\n"
			}
			return ""
		},
		read:  func(s *Settings) any { return s.CronTicker },
		apply: boolValue(func(s *Settings) *bool { return &s.CronTicker }, true),
	},
	{
		key: "pr_review_listener", kind: "bool", def: "true",
		desc:     "Runs the PR-review comment listener inside the daemon: armed tabs have their unhandled review threads dispatched into their own agent.",
		category: "behavior", ui: true, live: true,
		// Tolerant read: any strconv.ParseBool value; anything else keeps the
		// default (on) — the safe direction for a listener with its own
		// per-window arm switch.
		parse: func(s *Settings, value string) {
			if b, err := strconv.ParseBool(strings.Trim(value, "\"")); err == nil {
				s.PrReviewListener = b
			}
		},
		serialize: func(s *Settings) string {
			if !s.PrReviewListener {
				return "pr_review_listener: false\n"
			}
			return ""
		},
		read:  func(s *Settings) any { return s.PrReviewListener },
		apply: boolValue(func(s *Settings) *bool { return &s.PrReviewListener }, true),
	},
	{
		key: "easter_eggs", kind: "bool", def: "true",
		desc:     "Shows the screen-break Easter eggs: the fist when the viewed tab's PR merges, the eye when an update is available. Off hides the automatic ones; the palette's Easter egg entries still work.",
		category: "behavior", ui: true, live: true,
		// Tolerant read: any strconv.ParseBool value; anything else keeps the
		// default (on) — the safe direction for a cosmetic default-on feature.
		parse: func(s *Settings, value string) {
			if b, err := strconv.ParseBool(strings.Trim(value, "\"")); err == nil {
				s.EasterEggs = b
			}
		},
		serialize: func(s *Settings) string {
			if !s.EasterEggs {
				return "easter_eggs: false\n"
			}
			return ""
		},
		read:  func(s *Settings) any { return s.EasterEggs },
		apply: boolValue(func(s *Settings) *bool { return &s.EasterEggs }, true),
	},
	{
		key: "gui.enabled", kind: "bool", def: "false",
		desc:     "Turns the GUI surface on: runs the host desktop (rk-gui session) and shows the 4th tile toggle. Off by default; nothing flips it but you.",
		category: "behavior", ui: true, live: true,
		// Tolerant read: any strconv.ParseBool value; anything else keeps the
		// default (off) — the safe direction for an opt-in surface.
		parse: func(s *Settings, value string) {
			if b, err := strconv.ParseBool(strings.Trim(value, "\"")); err == nil {
				s.GUIEnabled = b
			}
		},
		serialize: func(s *Settings) string {
			if s.GUIEnabled {
				return "gui.enabled: true\n"
			}
			return ""
		},
		read:  func(s *Settings) any { return s.GUIEnabled },
		apply: boolValue(func(s *Settings) *bool { return &s.GUIEnabled }, false),
	},
	{
		key: "gui.wm", kind: "string", def: "",
		desc:     "Pin the window manager the GUI supervisor starts. Empty picks the first installed one from the ladder (icewm-session → openbox → xfwm4 → i3 → kwin_x11 → x-session-manager). Takes effect on rk gui restart. Run rk gui wm --list for installed and installable desktops.",
		category: "behavior", ui: true, live: false,
		parse:     quoteTrimmedScalar(func(s *Settings) *string { return &s.GUIWM }),
		serialize: quotedScalar("gui.wm", func(s *Settings) *string { return &s.GUIWM }),
		read:      func(s *Settings) any { return s.GUIWM },
		apply:     plainScalar(func(s *Settings) *string { return &s.GUIWM }),
	},
	{
		key: "gui.geometry", kind: "string", def: gui.GeometryDefault,
		desc:     "The GUI desktop's pixel size. Fixed sizes keep windows where they are; Auto follows the focused desktop viewer's tile. Applies live.",
		category: "behavior", ui: true, live: true,
		parse:     validatedQuoteTrimmedScalar(func(s *Settings) *string { return &s.GUIGeometry }, gui.ValidateGeometry),
		serialize: quotedScalarOmittingDefault("gui.geometry", gui.GeometryDefault, func(s *Settings) *string { return &s.GUIGeometry }),
		read:      func(s *Settings) any { return s.GUIGeometry },
		apply:     validatedScalar(func(s *Settings) *string { return &s.GUIGeometry }, gui.ValidateGeometry, gui.GeometryDefault),
	},
	{
		key: "tmux_conf", kind: "path", def: "",
		desc:     "Path to the tmux.conf rk passes to tmux; empty uses the built-in default. The RK_TMUX_CONF env escape wins when set.",
		category: "advanced", ui: true, live: false,
		parse:     quoteTrimmedScalar(func(s *Settings) *string { return &s.TmuxConf }),
		serialize: quotedScalar("tmux_conf", func(s *Settings) *string { return &s.TmuxConf }),
		read:      emptyableString(func(s *Settings) *string { return &s.TmuxConf }),
		apply:     plainScalar(func(s *Settings) *string { return &s.TmuxConf }),
	},
	{
		key: "log_level", kind: "enum", def: "info",
		desc:     "Daemon log verbosity — info or debug. The LOG_LEVEL env escape wins when set.",
		category: "advanced", ui: true, live: false,
		options: []string{"info", "debug"},
		// Tolerant read: only info/debug are accepted; anything else keeps the
		// default.
		parse: func(s *Settings, value string) {
			switch v := strings.Trim(value, "\""); v {
			case "info", "debug":
				s.LogLevel = v
			}
		},
		serialize: func(s *Settings) string {
			if s.LogLevel != "" && s.LogLevel != "info" {
				return "log_level: " + s.LogLevel + "\n"
			}
			return ""
		},
		read: func(s *Settings) any { v := s.LogLevel; return &v },
		apply: validatedScalar(func(s *Settings) *string { return &s.LogLevel }, func(value string) string {
			if value == "info" || value == "debug" {
				return ""
			}
			return "log_level must be info or debug"
		}, "info"),
	},
	{
		key: "server_colors", kind: "map", def: "{}",
		desc:     "Server name → accent color descriptor for the server's sidebar surfaces.",
		category: "appearance", ui: true, live: true,
		// Tolerant color read: accept a legacy bare integer OR the string
		// descriptor ("1+3"); normalize and drop anything malformed.
		section: mapSection("server_colors", func(s *Settings) *map[string]string { return &s.ServerColors }, validate.NormalizeColorValue),
		read:    func(s *Settings) any { return s.ServerColors },
		apply: mapValue(func(s *Settings) *map[string]string { return &s.ServerColors },
			validate.ValidateColorValue, validate.NormalizeColorValue),
	},
	{
		key: "server_flairs", kind: "map", def: "{}",
		desc:     "Server name → flair token (a closed set: validate.FlairValues) for the server's sidebar surfaces.",
		category: "appearance", ui: true, live: true,
		// Tolerant flair read: accept only non-empty tokens in the universal
		// set; no canonicalization needed — flair tokens round-trip as-is.
		section: mapSection("server_flairs", func(s *Settings) *map[string]string { return &s.ServerFlairs }, normalizeFlairValue),
		read:    func(s *Settings) any { return s.ServerFlairs },
		apply: mapValue(func(s *Settings) *map[string]string { return &s.ServerFlairs },
			validate.ValidateFlairValue, normalizeFlairValue),
	},
	{
		key: "board_order", kind: "list", def: "[]",
		desc:     "User-defined board display order; rank = list index.",
		category: "layout", ui: true, live: true,
		section: listSection("board_order", func(s *Settings) *[]string { return &s.BoardOrder }),
		read:    func(s *Settings) any { return s.BoardOrder },
		apply:   listValue(func(s *Settings) *[]string { return &s.BoardOrder }),
	},
	{
		key: "riff_presets", kind: "map", def: riffPresetsDefaultText,
		desc:     "Preset name → skill invocation for rk riff <name>; a name matching a built-in (discuss, incognito, blank) overrides it, any other name is an addition. Empty value = bare agent.",
		category: "behavior", ui: false, live: true,
		// Preset names are strict identifiers: a name is a line-scanner map key
		// (a `:` would split the line) and a CLI positional (`rk riff <name>` —
		// a leading `-` would read as a flag). Skipped on parse, 400 on apply.
		section: mapSectionChecked("riff_presets", func(s *Settings) *map[string]string { return &s.RiffPresets }, validateRiffPresetName, normalizeRiffPresetValue),
		// The USER tier as stored (nil → JSON null, like the other maps at
		// default) — the built-ins are the code tier, never persisted.
		read: func(s *Settings) any { return s.RiffPresets },
		apply: mapValueChecked(func(s *Settings) *map[string]string { return &s.RiffPresets },
			validateRiffPresetName, validateRiffPresetValue, normalizeRiffPresetValue),
	},
}

// quoteTrimmedScalar builds the parse hook for a plain string scalar: the
// value is quote-stripped and trimmed (serialize always quotes so the value
// round-trips unambiguously).
func quoteTrimmedScalar(target func(*Settings) *string) func(*Settings, string) {
	return func(s *Settings, value string) {
		*target(s) = strings.TrimSpace(strings.Trim(value, "\""))
	}
}

// quotedScalar builds the serialize hook for a string scalar emitted quoted
// and omitted when empty — a settings file without the key serializes
// byte-identically to one that never had it.
func quotedScalar(key string, target func(*Settings) *string) func(*Settings) string {
	return func(s *Settings) string {
		if v := *target(s); v != "" {
			return key + ": \"" + v + "\"\n"
		}
		return ""
	}
}

// validatedQuoteTrimmedScalar builds the parse hook for a validated string
// scalar: quote-stripped and trimmed, kept only when the validator accepts it
// — anything else keeps the default (the tolerant-read posture).
func validatedQuoteTrimmedScalar(target func(*Settings) *string, validator func(string) string) func(*Settings, string) {
	return func(s *Settings, value string) {
		if v := strings.TrimSpace(strings.Trim(value, "\"")); validator(v) == "" {
			*target(s) = v
		}
	}
}

// quotedScalarOmittingDefault builds the serialize hook for a string scalar
// with a non-empty default: emitted quoted, omitted when the value equals the
// default so a file without the key round-trips byte-identically.
func quotedScalarOmittingDefault(key, def string, target func(*Settings) *string) func(*Settings) string {
	return func(s *Settings) string {
		if v := *target(s); v != "" && v != def {
			return key + ": \"" + v + "\"\n"
		}
		return ""
	}
}

// mapSection builds a nested string-map section. Values are quote-stripped on
// read (the serializer quotes; legacy bare values are unquoted) and passed
// through normalize — a tolerant read that canonicalizes and drops anything
// malformed. Serialization sorts keys for deterministic output and always
// quotes values so they round-trip unambiguously.
func mapSection(key string, target func(s *Settings) *map[string]string, normalize func(string) (string, bool)) nestedSection {
	return mapSectionChecked(key, target, nil, normalize)
}

// mapSectionChecked is mapSection plus a name gate: a non-nil validateName
// skips entries whose key fails it (tolerant read, matching the strict-write
// mapValueChecked apply hook).
func mapSectionChecked(key string, target func(s *Settings) *map[string]string, validateName func(string) string, normalize func(string) (string, bool)) nestedSection {
	return nestedSection{
		key: key,
		parseEntry: func(s *Settings, trimmed string) {
			k, v, ok := strings.Cut(trimmed, ":")
			if !ok {
				return
			}
			name := strings.TrimSpace(k)
			value := strings.Trim(strings.TrimSpace(v), "\"")
			if name == "" {
				return
			}
			if validateName != nil && validateName(name) != "" {
				return
			}
			normalized, ok := normalize(value)
			if !ok {
				return
			}
			m := target(s)
			if *m == nil {
				*m = make(map[string]string)
			}
			(*m)[name] = normalized
		},
		serialize: func(s *Settings) string {
			m := *target(s)
			if len(m) == 0 {
				return ""
			}
			out := key + ":\n"
			names := make([]string, 0, len(m))
			for name := range m {
				names = append(names, name)
			}
			sort.Strings(names)
			for _, name := range names {
				out += "  " + name + ": \"" + m[name] + "\"\n"
			}
			return out
		},
	}
}

// listSection builds a nested string-list section (a YAML sequence). Entries
// are quote-stripped on read; serialization quotes each name so it
// round-trips unambiguously.
func listSection(key string, target func(s *Settings) *[]string) nestedSection {
	return nestedSection{
		key: key,
		parseEntry: func(s *Settings, trimmed string) {
			// A YAML sequence item: "  - name". Strip the leading "- " marker.
			if !strings.HasPrefix(trimmed, "-") {
				return
			}
			name := strings.TrimSpace(strings.TrimPrefix(trimmed, "-"))
			name = strings.Trim(name, "\"")
			if name != "" {
				l := target(s)
				*l = append(*l, name)
			}
		},
		serialize: func(s *Settings) string {
			l := *target(s)
			if len(l) == 0 {
				return ""
			}
			out := key + ":\n"
			for _, name := range l {
				out += "  - \"" + name + "\"\n"
			}
			return out
		},
	}
}

// normalizeFlairValue is the membership-check normalize for the server_flairs
// mapSection: a value survives iff it is a non-empty token in the universal
// flair set. Unlike colors, flair tokens need no canonical form — pass/fail
// only.
func normalizeFlairValue(value string) (string, bool) {
	if value != "" && validate.FlairValues[value] {
		return value, true
	}
	return "", false
}

// validateRiffPresetName is the name gate for the riff_presets section: the
// shared strict-identifier rule (validate.ValidateIdentifier). A preset name is
// a line-scanner map key (a `:` would split the line) and a CLI positional
// (`rk riff <name>` — a leading `-` would read as a flag), though it never
// enters argv as anything but a map-key lookup.
func validateRiffPresetName(name string) string {
	return validate.ValidateIdentifier(name, "Preset name")
}

// validateRiffPresetValue / normalizeRiffPresetValue accept any skill text the
// line-scoped settings format can round-trip. Values reach the launcher only
// through the skill-pane path (shell-quoted positional or typed-after-boot),
// the same latitude --skill already has — but the map serializer writes values
// raw inside double quotes and the parser reads one line per entry, so a value
// carrying a double quote or a newline cannot persist intact: rejected on
// apply (strict write, 400), dropped on parse (tolerant read). Values are
// trimmed; the empty string MUST survive both paths (a bare agent).
func validateRiffPresetValue(value string) string {
	if strings.ContainsAny(value, "\"\n") {
		return "must not contain double quotes or newlines (the settings format cannot round-trip them)"
	}
	return ""
}
func normalizeRiffPresetValue(value string) (string, bool) {
	v := strings.TrimSpace(value)
	if validateRiffPresetValue(v) != "" {
		return "", false
	}
	return v, true
}

// KeyInfo is the exported, read-only metadata view of one registry entry —
// what GET /api/settings serves alongside the current value.
type KeyInfo struct {
	Key         string
	Kind        string
	Default     string
	Description string
	Category    string
	UI          bool
	Live        bool
	// Options carries an enum kind's legal values in display order; nil for
	// non-enum kinds.
	Options []string
}

// Registry returns the registry's metadata in registry slice order (the same
// order serialize() emits — the stable display order).
func Registry() []KeyInfo {
	infos := make([]KeyInfo, len(registry))
	for i := range registry {
		e := &registry[i]
		infos[i] = KeyInfo{
			Key:         e.key,
			Kind:        e.kind,
			Default:     e.def,
			Description: e.desc,
			Category:    e.category,
			UI:          e.ui,
			Live:        e.live,
			// Copied: the exported view must not alias the package-global
			// registry slice, or a caller write mutates every later Registry()
			// call and /api/settings response.
			Options: append([]string(nil), e.options...),
		}
	}
	return infos
}

// ReadValue returns the key's current value on s in its natural JSON shape:
// a string pointer (nil — surfacing as JSON null — for an unset scalar with
// an empty default), a bool, a map[string]string, or a []string. Returned
// string pointers point at copies — writing through one never mutates s.
func ReadValue(s *Settings, key string) (any, bool) {
	e := findEntry(key)
	if e == nil {
		return nil, false
	}
	return e.read(s), true
}

// ApplyValue merges one JSON patch value for key onto s (in memory — the
// caller owns Load/Save) per Constitution IX partial-merge semantics. The
// whole value is validated before s is touched; an error means no mutation.
// Board-order entry VALIDITY (tmux.ValidBoardName, duplicates) is NOT checked
// here — it lives at the API layer because this package cannot import
// internal/tmux (tmux imports settings; a back-reference would be a cycle).
func ApplyValue(s *Settings, key string, value json.RawMessage) error {
	e := findEntry(key)
	if e == nil {
		return fmt.Errorf("unknown settings key: %s", key)
	}
	return e.apply(s, value)
}

// findEntry returns the registry entry for key, or nil for an unknown key.
func findEntry(key string) *registryEntry {
	for i := range registry {
		if registry[i].key == key {
			return &registry[i]
		}
	}
	return nil
}

// jsonNull reports whether raw is exactly the JSON null literal.
func jsonNull(raw json.RawMessage) bool {
	return string(raw) == "null"
}

// emptyableString builds the read hook for a string scalar whose unset state
// surfaces as JSON null (nil pointer) rather than "".
func emptyableString(target func(*Settings) *string) func(*Settings) any {
	return func(s *Settings) any {
		if v := *target(s); v != "" {
			return &v
		}
		return (*string)(nil)
	}
}

// validatedScalar builds the apply hook for a validated string scalar
// (color descriptors, ssh_host, instance_name, log_level): trimmed, with a
// trimmed-to-empty value treated as null (unset, restoring the registry
// default), and a non-empty value validated before any mutation.
func validatedScalar(target func(*Settings) *string, validator func(string) string, def string) func(*Settings, json.RawMessage) error {
	return func(s *Settings, raw json.RawMessage) error {
		if jsonNull(raw) {
			*target(s) = def
			return nil
		}
		var v string
		if err := json.Unmarshal(raw, &v); err != nil {
			return fmt.Errorf("value must be a string or null: %w", err)
		}
		v = strings.TrimSpace(v)
		if v == "" {
			*target(s) = def
			return nil
		}
		if msg := validator(v); msg != "" {
			return errors.New(msg)
		}
		*target(s) = v
		return nil
	}
}

// plainScalar builds the apply hook for an unvalidated string scalar
// (tmux_conf): trimmed, trimmed-to-empty treated as null (unset).
func plainScalar(target func(*Settings) *string) func(*Settings, json.RawMessage) error {
	return validatedScalar(target, func(string) string { return "" }, "")
}

// nonEmptyString builds the apply hook for a string scalar that must carry a
// non-empty value (theme, theme_dark, theme_light): trimmed; null unsets to
// the registry default; a trimmed-to-empty non-null value is rejected —
// unlike the unsettable scalars there is no meaningful "unset" state, since
// the file format omits these keys only at their defaults.
func nonEmptyString(target func(*Settings) *string, def string) func(*Settings, json.RawMessage) error {
	return func(s *Settings, raw json.RawMessage) error {
		if jsonNull(raw) {
			*target(s) = def
			return nil
		}
		var v string
		if err := json.Unmarshal(raw, &v); err != nil {
			return fmt.Errorf("value must be a string or null: %w", err)
		}
		v = strings.TrimSpace(v)
		if v == "" {
			return fmt.Errorf("value must be a non-empty string")
		}
		*target(s) = v
		return nil
	}
}

// boolValue builds the apply hook for a bool scalar (auto_name, cron_ticker,
// pr_review_listener,
// easter_eggs): a JSON bool sets; null unsets to the key's registry default.
func boolValue(target func(*Settings) *bool, def bool) func(*Settings, json.RawMessage) error {
	return func(s *Settings, raw json.RawMessage) error {
		if jsonNull(raw) {
			*target(s) = def
			return nil
		}
		var v bool
		if err := json.Unmarshal(raw, &v); err != nil {
			return fmt.Errorf("value must be a boolean or null: %w", err)
		}
		*target(s) = v
		return nil
	}
}

// mapValue builds the apply hook for a map-kind key (server_colors,
// server_flairs): the patch merges PER ENTRY — an entry value of null unsets
// that entry, a string entry is validated then set (a trimmed-to-empty string
// unsets, matching the empty-equals-unset contract of the folded per-key
// endpoints), and a top-level null clears the whole map. All entries are
// validated before any mutation.
func mapValue(target func(*Settings) *map[string]string, validator func(string) string, normalize func(string) (string, bool)) func(*Settings, json.RawMessage) error {
	return mapValueChecked(target, nil, validator, normalize)
}

// mapValueChecked is mapValue plus a strict-write name gate: a non-nil
// validateName rejects any patch entry whose key fails it (error → 400), before
// any value validation or mutation.
func mapValueChecked(target func(*Settings) *map[string]string, validateName func(string) string, validator func(string) string, normalize func(string) (string, bool)) func(*Settings, json.RawMessage) error {
	return func(s *Settings, raw json.RawMessage) error {
		if jsonNull(raw) {
			*target(s) = nil
			return nil
		}
		var entries map[string]*string
		if err := json.Unmarshal(raw, &entries); err != nil {
			return fmt.Errorf("value must be an object or null: %w", err)
		}
		// Validate everything before touching s (all-or-nothing).
		names := make([]string, 0, len(entries))
		for name := range entries {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			if validateName != nil {
				if msg := validateName(name); msg != "" {
					return errors.New(msg)
				}
			}
			v := entries[name]
			if v == nil {
				continue // entry null unsets — nothing to validate
			}
			trimmed := strings.TrimSpace(*v)
			if trimmed == "" {
				continue // empty string unsets, like null
			}
			if msg := validator(trimmed); msg != "" {
				return fmt.Errorf("entry %q: %s", name, msg)
			}
		}
		m := target(s)
		for _, name := range names {
			v := entries[name]
			if v == nil || strings.TrimSpace(*v) == "" {
				delete(*m, name)
				continue
			}
			normalized, ok := normalize(strings.TrimSpace(*v))
			if !ok {
				return fmt.Errorf("entry %q: value failed normalization", name)
			}
			if *m == nil {
				*m = make(map[string]string)
			}
			(*m)[name] = normalized
		}
		return nil
	}
}

// listValue builds the apply hook for the list-kind key (board_order): the
// patch replaces the stored list wholesale (rank = index — every reorder
// writes the full list so stale names self-heal); top-level null or [] clears.
// Entry name validity is the API layer's job (see ApplyValue).
func listValue(target func(*Settings) *[]string) func(*Settings, json.RawMessage) error {
	return func(s *Settings, raw json.RawMessage) error {
		if jsonNull(raw) {
			*target(s) = nil
			return nil
		}
		var names []string
		if err := json.Unmarshal(raw, &names); err != nil {
			return fmt.Errorf("value must be an array or null: %w", err)
		}
		if len(names) == 0 {
			*target(s) = nil
			return nil
		}
		out := make([]string, len(names))
		copy(out, names)
		*target(s) = out
		return nil
	}
}

// parse extracts settings from simple "key: value" lines.
// Supports one level of nesting: indented lines under a registered section
// heading are parsed as that section's entries. Keys not in the registry are
// ignored.
func parse(data string) Settings {
	s := Default()
	var active *nestedSection
	for _, line := range strings.Split(data, "\n") {
		raw := line
		trimmed := strings.TrimSpace(raw)
		if trimmed == PortPinComment {
			s.PortPinNote = true
			continue
		}
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}

		// Detect indentation: if the raw line starts with whitespace, it's a
		// nested entry under the current section heading.
		indented := len(raw) > 0 && (raw[0] == ' ' || raw[0] == '\t')

		if indented && active != nil {
			active.parseEntry(&s, trimmed)
			continue
		}

		// Non-indented line — end any active section.
		active = nil

		key, value, ok := strings.Cut(trimmed, ":")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)

		for i := range registry {
			if key != registry[i].key {
				continue
			}
			if registry[i].section.key != "" {
				active = &registry[i].section
			} else {
				registry[i].parse(&s, value)
			}
			break
		}
	}
	return s
}

// serialize produces the "key: value" text representation, in registry order
// (scalar keys first, then nested sections; defaults and empty sections
// omitted).
func serialize(s Settings) string {
	out := ""
	for i := range registry {
		if registry[i].section.key != "" {
			out += registry[i].section.serialize(&s)
		} else {
			out += registry[i].serialize(&s)
		}
	}
	return out
}

// GetServerColor returns the color-value descriptor for the named server, or nil.
func GetServerColor(server string) *string {
	s := Load()
	if v, ok := s.ServerColors[server]; ok {
		return &v
	}
	return nil
}

// SetServerColor sets or clears the color-value descriptor for the named server.
func SetServerColor(server string, color *string) error {
	s := Load()
	if color == nil {
		delete(s.ServerColors, server)
	} else {
		if s.ServerColors == nil {
			s.ServerColors = make(map[string]string)
		}
		s.ServerColors[server] = *color
	}
	return Save(s)
}

// GetServerFlair returns the flair token for the named server, or nil. Mirrors
// GetServerColor.
func GetServerFlair(server string) *string {
	s := Load()
	if v, ok := s.ServerFlairs[server]; ok {
		return &v
	}
	return nil
}

// SetServerFlair sets or clears the flair token for the named server (nil
// clears). Mirrors SetServerColor (load-then-save).
func SetServerFlair(server string, flair *string) error {
	s := Load()
	if flair == nil {
		delete(s.ServerFlairs, server)
	} else {
		if s.ServerFlairs == nil {
			s.ServerFlairs = make(map[string]string)
		}
		s.ServerFlairs[server] = *flair
	}
	return Save(s)
}

// GetInstanceColor returns the instance accent color-value descriptor, or nil
// when no explicit color is set. Mirrors GetServerColor.
func GetInstanceColor() *string {
	s := Load()
	if s.InstanceColor == "" {
		return nil
	}
	return &s.InstanceColor
}

// SetInstanceColor sets or clears the instance accent color-value descriptor
// (nil clears). Mirrors SetServerColor (load-then-save).
func SetInstanceColor(color *string) error {
	s := Load()
	if color == nil {
		s.InstanceColor = ""
	} else {
		s.InstanceColor = *color
	}
	return Save(s)
}

// GetSSHHost returns the stored SSH destination, or nil when unset. Mirrors
// GetInstanceColor.
func GetSSHHost() *string {
	s := Load()
	if s.SSHHost == "" {
		return nil
	}
	return &s.SSHHost
}

// SetSSHHost sets or clears the stored SSH destination (nil clears). Mirrors
// SetInstanceColor (load-then-save).
func SetSSHHost(host *string) error {
	s := Load()
	if host == nil {
		s.SSHHost = ""
	} else {
		s.SSHHost = *host
	}
	return Save(s)
}

// GetInstanceName returns the stored instance display-name override, or nil
// when unset. Mirrors GetInstanceColor.
func GetInstanceName() *string {
	s := Load()
	if s.InstanceName == "" {
		return nil
	}
	return &s.InstanceName
}

// SetInstanceName sets or clears the stored instance display-name override
// (nil clears). Mirrors SetInstanceColor (load-then-save).
func SetInstanceName(name *string) error {
	s := Load()
	if name == nil {
		s.InstanceName = ""
	} else {
		s.InstanceName = *name
	}
	return Save(s)
}

// GetBoardOrder returns the user-defined board display order (rank = index), or
// nil when no order has been set. Mirrors GetServerColor.
func GetBoardOrder() []string {
	return Load().BoardOrder
}

// SetBoardOrder persists the full ordered board-name list, replacing any prior
// order. A nil/empty slice clears the stored order. Mirrors SetServerColor —
// every reorder writes the whole list, so staleness self-heals.
func SetBoardOrder(names []string) error {
	s := Load()
	if len(names) == 0 {
		s.BoardOrder = nil
	} else {
		s.BoardOrder = names
	}
	return Save(s)
}

// --- riff presets -----------------------------------------------------------

// RiffDiscussSkill is the one source of the /fab-discuss literal: the built-in
// `discuss` preset's skill, aliased by riff.DefaultRiffSkill so the bare
// `rk riff` default and the built-in cannot drift.
const RiffDiscussSkill = "/fab-discuss"

// riffPresetsDefaultText is the riff_presets registry entry's `def` text: the
// built-in map as sorted-key JSON (display metadata for GET /api/settings).
const riffPresetsDefaultText = `{"blank":"","discuss":"/fab-discuss","incognito":"/fab-incognito"}`

// RiffPreset is one riff preset in the merged view: a name and the single
// skill it renders into one skill pane (an empty Skill is the bare launcher).
// BuiltIn marks the name as a built-in — the Skill may still be a user
// override of the built-in's value.
type RiffPreset struct {
	Name    string
	Skill   string
	BuiltIn bool
}

// BuiltinRiffPresets is the code-default preset tier, in canonical display
// order. The user tier (Settings.RiffPresets) stores overrides/additions only.
var BuiltinRiffPresets = []RiffPreset{
	{Name: "discuss", Skill: RiffDiscussSkill, BuiltIn: true},
	{Name: "incognito", Skill: "/fab-incognito", BuiltIn: true},
	{Name: "blank", Skill: "", BuiltIn: true}, // empty skill = bare launcher
}

// RiffPresets returns the effective preset list: built-ins in canonical order
// (discuss, incognito, blank), each carrying a user override when the user map
// names it, followed by user-added names sorted. Never empty.
func RiffPresets(s Settings) []RiffPreset {
	out := make([]RiffPreset, 0, len(BuiltinRiffPresets)+len(s.RiffPresets))
	for _, b := range BuiltinRiffPresets {
		p := b
		if v, ok := s.RiffPresets[b.Name]; ok {
			p.Skill = v
		}
		out = append(out, p)
	}
	var added []string
	for name := range s.RiffPresets {
		if !isBuiltinRiffPreset(name) {
			added = append(added, name)
		}
	}
	sort.Strings(added)
	for _, name := range added {
		out = append(out, RiffPreset{Name: name, Skill: s.RiffPresets[name]})
	}
	return out
}

// LoadRiffPresets is RiffPresets(Load()).
func LoadRiffPresets() []RiffPreset {
	return RiffPresets(Load())
}

// RiffPresetMap projects a merged preset list to a name → skill lookup map.
func RiffPresetMap(presets []RiffPreset) map[string]string {
	out := make(map[string]string, len(presets))
	for _, p := range presets {
		out[p.Name] = p.Skill
	}
	return out
}

// isBuiltinRiffPreset reports whether name is one of the built-in preset names.
func isBuiltinRiffPreset(name string) bool {
	for _, b := range BuiltinRiffPresets {
		if b.Name == name {
			return true
		}
	}
	return false
}
