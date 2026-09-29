package validate

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// Characters that are never valid in tmux session/window names.
var forbiddenChars = regexp.MustCompile(`[;&|` + "`" + `$(){}[\]<>!#*?\n\r\t]`)

// MaxNameLength is the maximum allowed length for names.
const MaxNameLength = 128

// ValidateName validates a tmux session or window name.
// Returns empty string if valid, error message if invalid.
func ValidateName(name, label string) string {
	if strings.TrimSpace(name) == "" {
		return fmt.Sprintf("%s cannot be empty", label)
	}
	if len(name) > MaxNameLength {
		return fmt.Sprintf("%s exceeds maximum length of %d characters", label, MaxNameLength)
	}
	if forbiddenChars.MatchString(name) {
		return fmt.Sprintf("%s contains forbidden characters", label)
	}
	if strings.Contains(name, ":") || strings.Contains(name, ".") {
		return fmt.Sprintf("%s cannot contain colons or periods", label)
	}
	return ""
}

// ValidateNewName validates a name for a to-be-created or renamed-to session
// or window: the permissive ValidateName rule tightened with "no spaces", so
// the safe charset the frontend's live transforms steer toward is a real
// backend contract, not just UI steering. Existing-name lookups (URL params,
// rename/kill/upload targets, session-order entries) deliberately stay on
// ValidateName — sessions created outside run-kit (raw `tmux rename-session`)
// can carry spaces and must remain operable. Hyphens stay legal here: internal
// sessions (`_rk-pin-*`, `rk-test-e2e`, group names) rely on them; the session
// hyphen→underscore rule is UI-only steering.
// Returns empty string if valid, error message if invalid.
func ValidateNewName(name, label string) string {
	if msg := ValidateName(name, label); msg != "" {
		return msg
	}
	if strings.Contains(name, " ") {
		return fmt.Sprintf("%s cannot contain spaces", label)
	}
	return ""
}

// colorFamilyNames is the closed set of owned-palette family-name color values
// accepted alongside the numeric vocabulary: the 10 hue-family names defined by
// the frontend (themes.ts HUE_FAMILIES) plus their "-dark"/"-light" shade
// variants ("blue-dark", "blue-light"). Normal-shade picks are still written in
// the legacy numeric vocabulary by the frontend write seam (familyToLegacy),
// but dark/light shades have no legacy form and are stored as these names
// verbatim. A closed set bounds the injection/abuse surface (constitution §I)
// exactly as the numeric rule does — the value flows into `tmux set-option`
// and the settings file.
var colorFamilyNames = func() map[string]bool {
	families := []string{"red", "orange", "amber", "olive", "green", "teal", "blue", "purple", "magenta", "slate"}
	m := make(map[string]bool, len(families)*3)
	for _, f := range families {
		m[f] = true
		m[f+"-dark"] = true
		m[f+"-light"] = true
	}
	return m
}()

// ValidateColorValue validates a swatch color value: an owned-palette family
// name ("blue", optionally "-dark"-/"-light"-suffixed for the dark/light
// shade) OR a legacy numeric descriptor — a single ANSI index ("4") or a
// two-hue blend of two indices joined by '+' ("1+3"), every index an integer
// in [0, 15]. Legacy numeric values remain valid forever (read + write).
// Returns empty string if valid, an error message otherwise. This is the
// single shared color-value rule reused by the window, session, and server
// color handlers (constitution §I — input validated before it ever reaches
// `tmux set-option` or the settings file).
func ValidateColorValue(value string) string {
	if colorFamilyNames[strings.TrimSpace(value)] {
		return ""
	}
	_, msg := parseColorIndices(value)
	return msg
}

// parseColorIndices splits a color-value descriptor into its 1–2 ANSI indices,
// validating each. Returns the parsed indices and an empty message on success,
// or nil and an error message otherwise. Surrounding/internal whitespace around
// each index is tolerated so the rule matches the frontend parser
// (themes.ts parseColorValue), which trims each part; empty parts are rejected
// explicitly rather than relying on strconv error shapes.
func parseColorIndices(value string) ([]int, string) {
	parts := strings.Split(value, "+")
	if len(parts) < 1 || len(parts) > 2 {
		return nil, "Color must be a palette family name, a single index (0-15), or a blend (a+b)"
	}
	indices := make([]int, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			return nil, "Color must be a palette family name, a single index (0-15), or a blend (a+b)"
		}
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil, "Color must be a palette family name, a single index (0-15), or a blend (a+b)"
		}
		if n < 0 || n > 15 {
			return nil, "Color indices must be between 0 and 15"
		}
		indices = append(indices, n)
	}
	return indices, ""
}

// NormalizeColorValue parses a stored color value (a family-name value, a
// legacy bare integer, or the string descriptor) and returns its canonical
// string form, or ("", false) when malformed. Family-name values ("blue",
// "blue-dark", "blue-light") canonicalize to their trimmed verbatim form
// (case-sensitive — the frontend only ever writes the canonical names);
// numeric forms re-serialize the parsed indices ("4" or "a+b"), so
// equivalent-but-noisy inputs ("01", " 1 + 3 ") collapse to a single
// representation. Used by tolerant-read storage paths (the settings store at
// ~/.config/hexokit/config.yaml) and the tmux option readers to accept any
// stored vocabulary on read and always normalize to the canonical string.
func NormalizeColorValue(value string) (string, bool) {
	if name := strings.TrimSpace(value); colorFamilyNames[name] {
		return name, true
	}
	indices, msg := parseColorIndices(value)
	if msg != "" {
		return "", false
	}
	parts := make([]string, len(indices))
	for i, n := range indices {
		parts[i] = strconv.Itoa(n)
	}
	return strings.Join(parts, "+"), true
}

// MaxSettingValueLength caps the ssh_host / instance_name settings values —
// 253 is the DNS hostname maximum, a comfortable bound for both an SSH
// destination and a display name.
const MaxSettingValueLength = 253

// ValidateSSHHost validates a (already-trimmed, non-empty) ssh_host settings
// value: the verbatim SSH destination spliced into
// `vscode://vscode-remote/ssh-remote+{host}` editor deeplink URLs client-side.
// Whitespace and control characters are rejected outright (an SSH alias or
// user@host form never contains them, and they would corrupt the deeplink);
// length is capped at MaxSettingValueLength. Returns an empty string if valid,
// an error message otherwise.
func ValidateSSHHost(value string) string {
	if len(value) > MaxSettingValueLength {
		return fmt.Sprintf("SSH host exceeds maximum length of %d characters", MaxSettingValueLength)
	}
	for _, r := range value {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return "SSH host cannot contain whitespace or control characters"
		}
	}
	// The settings serializer wraps values in double quotes; an embedded quote
	// would corrupt the quoted round-trip (and never appears in a real SSH
	// destination).
	if strings.Contains(value, "\"") {
		return "SSH host cannot contain double quotes"
	}
	return ""
}

// ValidateInstanceName validates a (already-trimmed, non-empty) instance_name
// settings value: a display label, so inner spaces are legal but control
// characters are not; length is capped at MaxSettingValueLength. Returns an
// empty string if valid, an error message otherwise.
func ValidateInstanceName(value string) string {
	if len(value) > MaxSettingValueLength {
		return fmt.Sprintf("Instance name exceeds maximum length of %d characters", MaxSettingValueLength)
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return "Instance name cannot contain control characters"
		}
	}
	// Same quoted-round-trip guard as ValidateSSHHost.
	if strings.Contains(value, "\"") {
		return "Instance name cannot contain double quotes"
	}
	return ""
}

// markerTokens, roleTokens, and flairTokens are the ordered closed sets of
// accepted named values for their channels (the empty string — "unset" — is
// implied and always a member). Slice order is the presentation order in the
// derived validator error message. Each channel's exported membership map and
// its error message are both derived from this single slice, so adding a token
// cannot drift the map and the message out of sync.
var (
	markerTokens = []string{
		"manual", "manual:1", "manual:2", "manual:3",
		"auto", "auto:1", "auto:2", "auto:3",
		"blocked", "blocked:1", "blocked:2", "blocked:3",
	}
	roleTokens  = []string{"operator"}
	flairTokens = []string{"rain", "scan", "nyan", "naruto", "onepiece", "pacman", "matrix", "aquarium", "nemo", "roadrunner", "invaders", "cube", "warp", "spidey", "ironman", "noon"}
	ownerTokens = []string{"operator"}
)

// closedSet builds the membership map for an ordered token slice, including
// the implied empty string ("unset"). A closed set bounds the injection/abuse
// surface (constitution §I) exactly as the color-value rule does — every one
// of these values flows into `tmux set-option`.
func closedSet(tokens []string) map[string]bool {
	m := make(map[string]bool, len(tokens)+1)
	m[""] = true
	for _, t := range tokens {
		m[t] = true
	}
	return m
}

// validateClosedSet validates value against a channel's closed set, deriving
// the error message from the ordered token slice ("{label} must be one of:
// a, b, c (or empty to clear)"). An empty value is always valid (it means
// unset). Returns an empty string if valid, the error message otherwise. The
// single shared closed-set rule behind ValidateMarkerValue / ValidateRoleValue
// / ValidateFlairValue.
func validateClosedSet(value, label string, set map[string]bool, tokens []string) string {
	if set[value] {
		return ""
	}
	return label + " must be one of: " + strings.Join(tokens, ", ") + " (or empty to clear)"
}

// MarkerValues is the closed set of accepted @rk_win_marker window-option values,
// derived from markerTokens. The empty string means "unset" (no marker). The
// current value schema is `<mode>[:<stage>]` — mode ∈ manual/auto/blocked (the
// categorical shape axis) × stage ∈ 1/2/3 (the ordinal width/count axis; a
// bare mode means stage 1) — all fully static.
var MarkerValues = closedSet(markerTokens)

// ValidateMarkerValue validates an @rk_win_marker value: "" or one of the
// twelve `<mode>[:<stage>]` tokens (manual/manual:1…blocked:3). Returns an
// empty string if valid, an error message otherwise. This is the shared
// marker-value rule used by the window-option handler.
func ValidateMarkerValue(value string) string {
	return validateClosedSet(value, "Marker", MarkerValues, markerTokens)
}

// RoleValues is the closed set of accepted @rk_win_role window-option values,
// derived from roleTokens. The empty string means "unset" (no role);
// "operator" marks the window as the server's operator (the orchestrator
// window, pinned below the SESSIONS header in the sidebar).
var RoleValues = closedSet(roleTokens)

// ValidateRoleValue validates an @rk_win_role value: one of ""/operator. Returns
// an empty string if valid, an error message otherwise. The single shared
// role-value rule reused by the window-option handler and the rk role CLI.
func ValidateRoleValue(value string) string {
	return validateClosedSet(value, "Role", RoleValues, roleTokens)
}

// FlairValues is the closed set of accepted @rk_win_flair values (window and
// session user options), derived from flairTokens. The empty string means
// "unset" (no flair); the named states select the per-row flair animation in
// the UI.
var FlairValues = closedSet(flairTokens)

// ValidateFlairValue validates an @rk_win_flair value against flairTokens (one of
// ""/rain/scan/nyan/naruto/onepiece/pacman/matrix/aquarium/nemo/roadrunner/
// invaders/cube/warp/spidey/ironman/noon). Returns an empty string if valid, an
// error message otherwise. The single shared flair-value rule reused by the
// window-option and session-flair handlers.
func ValidateFlairValue(value string) string {
	return validateClosedSet(value, "Flair", FlairValues, flairTokens)
}

// OwnerValues is the closed set of accepted @rk_win_owner window-option values,
// derived from ownerTokens. The empty string means "unset" (no owner);
// "operator" records that an operator has taken responsibility for the window
// at least once.
var OwnerValues = closedSet(ownerTokens)

// ValidateOwnerValue validates an @rk_win_owner value: one of ""/operator.
// Returns an empty string if valid, an error message otherwise. The single
// shared owner-value rule reused by the window-option handler and the rk tab
// owner CLI.
func ValidateOwnerValue(value string) string {
	return validateClosedSet(value, "Owner", OwnerValues, ownerTokens)
}

// NoteTextMaxLength caps the free-text @rk_win_note value (the tab's one-line
// status note). The bound lives server-side (Constitution §I) and protects the
// UI surfaces that render the note inline.
const NoteTextMaxLength = 120

// ValidateNoteText validates the free text of an @rk_win_note value: trimmed,
// length-capped, and free of control characters (tabs/newlines would corrupt
// the tab-delimited list-windows read format; any other control rune would
// leak into tmux and the rendered UI). Returns the trimmed text and an empty
// message when valid, or "" and the error message otherwise. Text that trims
// to empty is NOT an error here — each caller decides what empty means (the
// /options handler treats it as unset; the rk tab note CLI rejects it in favor
// of --off). The single shared note rule consumed by the /options handler and
// the rk tab note CLI.
func ValidateNoteText(text string) (trimmed string, errMsg string) {
	trimmed = strings.TrimSpace(text)
	if len(trimmed) > NoteTextMaxLength {
		return "", fmt.Sprintf("note exceeds %d characters", NoteTextMaxLength)
	}
	for _, r := range trimmed {
		if unicode.IsControl(r) {
			return "", "note cannot contain control characters"
		}
	}
	return trimmed, ""
}

// ValidateWebTabURL validates an @rk_win_web_<n> window-option value against
// the scheme allowlist (constitution §I — the value becomes an iframe src on
// every viewer's web tile): root-relative paths on the server's own origin,
// and absolute http:/https: URLs with a host.
// Everything else — javascript:/data:/file: and any other scheme,
// scheme-relative "//…", backslash host escapes, and bare hosts — is rejected
// with a message naming the accepted forms. The empty/whitespace check stays
// with the caller (it owns the "cannot be empty" wording). Returns empty string
// if valid, an error message otherwise.
func ValidateWebTabURL(value string) string {
	const accepted = "URL must be an http:// or https:// URL, or a root-relative path"
	if strings.HasPrefix(value, "/") && !strings.HasPrefix(value, "//") && !strings.Contains(value, `\`) {
		u, err := url.Parse(value)
		if err == nil && u.Scheme == "" && u.Host == "" {
			return ""
		}
	}
	u, err := url.Parse(value)
	if err != nil || u.Host == "" {
		return accepted
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return accepted
	}
	return ""
}

// windowIDPattern matches a tmux window ID: an '@' followed by one or more digits
// (e.g. "@5"). Window IDs originate from tmux's #{window_id} and are never
// user-typed, but they flow into subprocess args, so they are validated against
// this strict shape (constitution §I — Security First). This is intentionally
// stricter than ValidateName, which permits '@' but does not constrain the value
// to the @N form.
var windowIDPattern = regexp.MustCompile(`^@[0-9]+$`)

// ValidateWindowID validates a tmux window ID (the canonical window identity).
// Returns empty string if valid, error message if invalid.
func ValidateWindowID(id, label string) string {
	if id == "" {
		return fmt.Sprintf("%s cannot be empty", label)
	}
	if !windowIDPattern.MatchString(id) {
		return fmt.Sprintf("%s must be a tmux window ID of the form @N", label)
	}
	return ""
}

// serverNamePattern matches valid server names: alphanumeric, hyphens, underscores.
var serverNamePattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// MaxServerNameLength is the maximum allowed length for server names.
const MaxServerNameLength = 64

// ValidateServerName validates a tmux server name against a strict pattern.
// Returns empty string if valid, error message if invalid.
func ValidateServerName(name string) string {
	if name == "" {
		return "Server name cannot be empty"
	}
	if len(name) > MaxServerNameLength {
		return fmt.Sprintf("Server name exceeds maximum length of %d characters", MaxServerNameLength)
	}
	if !serverNamePattern.MatchString(name) {
		return "Server name must contain only alphanumeric characters, hyphens, and underscores"
	}
	return ""
}

// tierNamePattern matches a fab agent tier name: alphanumeric plus hyphen and
// underscore. A tier flows into a subprocess as a bare positional
// (`fab agent <tier> -o yaml`), so it is validated against this strict identifier
// shape before use (constitution §I — Security First). Mirrors serverNamePattern.
// The leading char is constrained to alphanumeric or underscore so a tier can
// never be interpreted as a flag by `fab agent` — a leading `-` would make the
// positional a bare `-doing`-style option.
var tierNamePattern = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_-]*$`)

// MaxTierNameLength bounds a tier name. Tiers are short config keys
// (default/doing/fast/…); 64 is generous and matches the server-name bound.
const MaxTierNameLength = 64

// ValidateTier validates a fab agent tier name. Returns empty string if valid,
// an error message otherwise. An empty tier is the caller's "default tier"
// sentinel and is validated separately (callers skip this when the value is
// empty); this rule applies to a NON-empty tier that will reach argv. A leading
// `-` is rejected (see tierNamePattern) so the tier can't become a bare flag.
func ValidateTier(name string) string {
	return ValidateIdentifier(name, "Tier name")
}

// ValidateIdentifier is the shared strict-identifier rule behind ValidateTier
// (tierNamePattern, MaxTierNameLength): alphanumeric plus hyphen and
// underscore, ≤ 64 chars, leading char constrained to alphanumeric or
// underscore so a name reaching argv as a bare positional can never read as a
// flag (constitution §I). label prefixes the error messages ("Tier name").
// Returns empty string if valid.
func ValidateIdentifier(name, label string) string {
	if len(name) > MaxTierNameLength {
		return fmt.Sprintf("%s exceeds maximum length of %d characters", label, MaxTierNameLength)
	}
	if !tierNamePattern.MatchString(name) {
		return label + " must contain only alphanumeric characters, hyphens, and underscores, and must not start with a hyphen"
	}
	return ""
}

// ValidateWorktreeName validates a riff worktree name. It layers riff-seam-only
// hardening over the shared tmux-safe ValidateName rule (which the session/window
// callers also use — that shared rule is deliberately left unchanged). The extra
// rejections address how a worktree name is consumed downstream of riff: it
// becomes a `wt create --worktree-name` argv element (a leading `-` could look
// like a flag), a worktree directory basename (a `/` would split the path), and
// a `riff-<name>` tmux window name (a leading space is a surprising, error-prone
// name). Returns empty string if valid, an error message otherwise.
func ValidateWorktreeName(name string) string {
	if msg := ValidateName(name, "Worktree name"); msg != "" {
		return msg
	}
	if strings.HasPrefix(name, "-") {
		return "Worktree name must not start with a hyphen"
	}
	if strings.Contains(name, "/") {
		return "Worktree name must not contain a slash"
	}
	if strings.Contains(name, " ") {
		return "Worktree name must not contain spaces"
	}
	return ""
}

// ValidateRemoteName validates an `rk remote` name. The name becomes a tmux
// window name on the rk-daemon socket (`rk-remotes` session), a remotes.yaml
// lookup key, and a bare argv element after `-n` / inside `-t` targets — so it
// layers remote-seam hardening over the shared tmux-safe ValidateNewName rule
// (which already bans empty/overlong names, forbidden metacharacters, colons,
// periods, and spaces). The extra rejections mirror ValidateWorktreeName: a
// leading `-` could read as a flag, and a `/` corrupts tmux target syntax.
// Returns empty string if valid, an error message otherwise.
func ValidateRemoteName(name string) string {
	if msg := ValidateNewName(name, "Remote name"); msg != "" {
		return msg
	}
	if strings.HasPrefix(name, "-") {
		return "Remote name must not start with a hyphen"
	}
	if strings.Contains(name, "/") {
		return "Remote name must not contain a slash"
	}
	return ""
}

// ValidateRemoteTarget validates an `rk remote` ssh target — a verbatim SSH
// destination (a ~/.ssh/config alias or `user@host` form) that flows into ssh
// argv as a bare positional. It applies the ValidateSSHHost rules (no
// whitespace/control characters, no double quotes, DNS-bounded length) plus a
// leading-`-` rejection so a hostile target can never be parsed as an ssh
// option (constitution §I — Security First; mirrors tierNamePattern's
// flag-injection defense). Returns empty string if valid, an error message
// otherwise.
func ValidateRemoteTarget(target string) string {
	if strings.TrimSpace(target) == "" {
		return "SSH target cannot be empty"
	}
	if strings.HasPrefix(target, "-") {
		return "SSH target must not start with a hyphen"
	}
	if msg := ValidateSSHHost(target); msg != "" {
		return msg
	}
	return ""
}

// toolNamePattern matches a shll-toolkit tool name (a manifest key such as
// "run-kit", "fab-kit", "tu", "wt"): alphanumeric plus hyphen and underscore,
// with the leading char constrained to alphanumeric or underscore. Tool names
// originate from the REMOTE shll.ai version manifest and flow into a subprocess
// as bare positionals (`shll update <tool…>`), so they are validated against
// this strict identifier shape before use (constitution §I — Security First).
// A leading `-` is disallowed so a manifest-sourced name can never be
// interpreted as a flag by shll's arg parser. Mirrors tierNamePattern.
var toolNamePattern = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_-]*$`)

// MaxToolNameLength bounds a tool name. Toolkit tool names are short identifiers
// (run-kit/fab-kit/tu/wt); 64 is generous and matches the server/tier bounds.
const MaxToolNameLength = 64

// ValidateToolName validates a shll-toolkit tool name sourced from the remote
// manifest before it is passed as an argument to `shll update`. Returns empty
// string if valid, an error message otherwise. Rejects an empty name, a leading
// `-` (flag-injection defense), whitespace/control characters, and any other
// non-identifier character (see toolNamePattern).
func ValidateToolName(name string) string {
	if name == "" {
		return "Tool name cannot be empty"
	}
	if len(name) > MaxToolNameLength {
		return fmt.Sprintf("Tool name exceeds maximum length of %d characters", MaxToolNameLength)
	}
	if !toolNamePattern.MatchString(name) {
		return "Tool name must contain only alphanumeric characters, hyphens, and underscores, and must not start with a hyphen"
	}
	return ""
}

// ValidateGUIID validates a GUI surface id. Exactly one GUI session exists per
// host, so the closed set is the single id "host" — the validator is where a
// second id lands later. Returns empty string if valid, an error message
// otherwise.
func ValidateGUIID(id string) string {
	if id == "host" {
		return ""
	}
	return `gui id must be "host"`
}

// ExpandTilde expands a leading ~ to $HOME and resolves the path.
// Returns the expanded path and an empty error string on success,
// or an empty path and error message on failure.
func ExpandTilde(raw string) (string, string) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", "cannot determine home directory"
	}

	var expanded string

	if raw == "~" || strings.HasPrefix(raw, "~/") {
		expanded = filepath.Join(home, raw[1:])
		if raw == "~" {
			expanded = home
		}
	} else if strings.HasPrefix(raw, "~") {
		// Reject ~username syntax
		return "", "~user expansion is not supported; use ~/path"
	} else if filepath.IsAbs(raw) {
		expanded = filepath.Clean(raw)
	} else {
		// Bare relative path — resolve relative to $HOME
		expanded = filepath.Join(home, raw)
	}

	expanded = filepath.Clean(expanded)

	// Reject paths that escape $HOME
	if expanded != home && !strings.HasPrefix(expanded, home+"/") {
		return "", "Path must be under home directory"
	}

	return expanded, ""
}

// ValidatePath validates a file path.
// Returns empty string if valid, error message if invalid.
func ValidatePath(path, label string) string {
	if strings.TrimSpace(path) == "" {
		return fmt.Sprintf("%s cannot be empty", label)
	}
	if len(path) > 1024 {
		return fmt.Sprintf("%s exceeds maximum length", label)
	}
	if strings.ContainsAny(path, "\x00\n\r") {
		return fmt.Sprintf("%s contains invalid characters", label)
	}
	return ""
}

// SanitizeFilename sanitizes a user-provided filename for safe disk storage.
func SanitizeFilename(name string) string {
	// Strip null bytes
	sanitized := strings.ReplaceAll(name, "\x00", "")
	// Replace path separators with dash
	sanitized = strings.NewReplacer("/", "-", "\\", "-").Replace(sanitized)
	// Strip leading dots
	sanitized = strings.TrimLeft(sanitized, ".")
	// Strip sequences of 2+ dots (traversal remnants)
	sanitized = regexp.MustCompile(`\.{2,}`).ReplaceAllString(sanitized, "")
	// Collapse multiple dashes
	sanitized = regexp.MustCompile(`-{2,}`).ReplaceAllString(sanitized, "-")
	// Strip leading/trailing dashes
	sanitized = strings.Trim(sanitized, "-")
	sanitized = strings.TrimSpace(sanitized)

	if sanitized == "" {
		return "upload"
	}
	return sanitized
}
