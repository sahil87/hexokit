package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"rk/internal/selfpath"
	"rk/internal/tmux"

	"github.com/spf13/cobra"
	"golang.org/x/term"
)

// rk agent setup — install the generic agent-state hooks that write the
// @rk_agent_state pane user option (see docs/specs/agent-state.md). It registers
// hook commands in a user-global agent config so any session of that agent, in
// any directory, under any workflow, reports lifecycle state. One registry row
// per supported harness (agent_registry.go carries the runtime descriptors);
// the verified per-harness capability matrix lives in
// docs/site/agent-hooks.md.
//
// Three installer kinds share the consent/diff/dry-run/uninstall machinery:
//   - jsonHooksMerge (claude ~/.claude/settings.json, codex
//     $CODEX_HOME/hooks.json, gemini ~/.gemini/settings.json): a JSON merge
//     that preserves existing (non-rk) hooks and all other config, is
//     idempotent (re-run replaces rk-owned entries in place, never
//     duplicates), and removes exactly the rk-owned entries on --uninstall.
//   - markerFile (copilot $COPILOT_HOME/hooks/run-kit.json, opencode
//     ~/.config/opencode/plugins/run-kit.js): a whole marker-owned file rk
//     creates/replaces/removes — the harness's native one-file-per-source
//     shape. A foreign marker-less file at the path is never touched.
//   - markerBlock (kimi $KIMI_CODE_HOME/config.toml): a marker-owned
//     [[hooks]] block upserted/removed via the same markerBlockBounds
//     machinery as the tmux guard PATH block — no TOML parser, byte-exact
//     preservation of user content.
//
// Installs are gated on the harness binary being on PATH (wiring a harness the
// machine does not have is noise); uninstalls are NOT gated — removal must
// work after the harness itself is gone. The install shows a diff and asks for
// confirmation before writing (it mutates user-global config). All file writes
// go through Go; the hook command is a fixed literal per state with nothing
// user-provided interpolated (Constitution §I).
//
// rk agent setup manages three artifact families: the per-agent hooks merge above,
// the user-global tmux guard shim (shim file + PATH block — see applyTmuxShim
// below and tmux_guard.go for the guard itself), and the user-global gui display
// block (a marker-owned shell-startup block that evals `rk gui env` inside tmux
// panes — see applyGuiDisplayBlocks below). It used to write
// a third managed artifact — a user-global "rk-display" SKILL.md that put
// run-kit's visual-display capability into an agent's context — but that context-injection
// responsibility has moved to the `rk skill` bundle (served by the skill
// subcommand, aggregated by the coming `shll agent-setup`). All rk agent setup does
// with the legacy skill now is a one-release CLEANUP courtesy: on BOTH the
// install and uninstall passes it offers to remove a stale, marker-owned
// rk-display skill left by an older run-kit (see removeLegacySkill). An absent
// file is silent in both modes — a fresh machine sees zero rk-display output.
// The cleanup path (and agentConfig.skillsDir, which locates the legacy skill)
// is scheduled for removal one release after this change.

// rkHookMarker is the LEGACY substring that identifies an rk-owned hook command:
// the pre-indirection self-contained one-liner inlined `tmux set-option … @rk_agent_state`,
// so the option name appearing in a command string was the "this entry is ours"
// signal. It IS the retired option name — first-generation one-liners inline
// the unscoped name, so the marker binds to LegacyAgentStateOption (binding it
// to the renamed constant would stop `rk agent setup` from recognising and
// stripping gen-1 entries).
//
// The NEW-generation command (agentStateHookCommand below) delegates to
// `rk agent hook` and no longer contains the option name, so it is instead
// identified by rkHookMarkerAgentHook (second generation) and
// rkHookMarkerAgentHookFamily (third generation). isRkEntry matches ALL THREE
// markers so a re-run of `rk agent setup` on the new binary strips
// older-generation entries and replaces them in place, and `--uninstall`
// removes every generation.
const rkHookMarker = tmux.LegacyAgentStateOption

// rkHookMarkerAgentHook identifies the second-generation delegating hook
// command by its ` agent-hook ` invocation substring. The surrounding spaces
// keep it from matching an unrelated token that merely contains "agent-hook".
const rkHookMarkerAgentHook = " agent-hook "

// rkHookMarkerAgentHookFamily identifies the third-generation delegating hook
// command — installed by `rk agent setup` — by its ` agent hook ` invocation
// substring (the family form; spaces included, same matching rule as the
// second-generation marker).
const rkHookMarkerAgentHookFamily = " agent hook "

// The rk-display skill was a SECOND managed artifact rk agent setup used to
// install — a user-global Claude Code skill that put run-kit's visual-display
// capability into an agent's context. That responsibility has moved to the
// `rk skill` bundle, so rk agent setup no longer WRITES this skill; it only cleans a
// stale copy for one release (see removeLegacySkill).
//
// rkDisplaySkillDir / rkDisplaySkillFile are the directory (under an agent's
// skillsDir) and file basename of the legacy skill; skillManagedByMarker is the
// ownership marker embedded in the skill's frontmatter. They are retained solely
// to LOCATE and RECOGNIZE a marker-owned legacy file for removal — scheduled for
// deletion one release after this change.
const (
	rkDisplaySkillDir    = "rk-display"
	rkDisplaySkillFile   = "SKILL.md"
	skillManagedByMarker = "managed-by: rk agent-setup"
)

// agentStateHookCommand builds the STABLE delegating hook command for a given
// state: a thin wrapper that invokes `rk agent hook` (the family form — the
// permanent `agent-hook` root alias keeps already-installed older-generation
// lines working), keeping all logic in the binary so hook behavior tracks
// `brew upgrade rk` with no settings churn and no agent session restarts. The
// former self-contained one-liner (which inlined the comm-validated ancestor
// walk and the `tmux set-option`) was frozen twice — once in
// ~/.claude/settings.json at install time, once in the harness's session-start
// snapshot — so a hook fix shipped in the binary reached zero running agents
// until every session was restarted (the #320↔#321 skew). Delegating to the
// binary lifts that freeze.
//
//	/bin/sh -c '[ -n "$TMUX_PANE" ] || exit 0; "<launcher>" agent hook --agent <provider> <state> 2>/dev/null || "<stable>" agent hook --agent <provider> <state> 2>/dev/null || true'
//
// Two paths, each covering the other's upgrade hole: launcherPath is the
// rk-owned launcher symlink (its target is the Cellar binary, live through
// Homebrew's unlink→install→link window), stablePath is the brew-prefix
// symlink (re-linked in finish, covering the gap between cleanup and the
// daemon's next re-point of the launcher). The `||` chain only ever advances
// on exec failure (127/126) — `rk agent hook` itself always exits 0. The
// interpreter is absolute for the same reason the rk paths are (below): hooks
// fire under the HARNESS's environment, and an agent session launched with a
// PATH missing /bin and /usr/bin cannot resolve a bare `sh` — every hook fire
// then fails loudly ("sh: not found") before the $TMUX_PANE guard can even
// run. The $TMUX_PANE guard stays in the wrapper as a cheap short-circuit (no
// binary spawn outside tmux). `|| true` preserves the never-fail contract even
// if both binaries are missing or moved. Both paths are machine-derived at
// install time; they are embedded double-quoted INSIDE the single-quoted sh -c
// body, so a path containing any of ' " $ ` \ would break out of (or be
// reinterpreted within) that quoting. state and provider are fixed registry
// literals (never user input); both paths MUST be pre-validated by
// validateHookPath (the install flow rejects shell-active characters rather
// than attempting escaping), which together close the interpolation surface
// (Constitution §I).
func agentStateHookCommand(launcherPath, stablePath, state, provider string) string {
	if launcherPath == "" {
		// No rk-owned launcher to exec (a foreign file holds the path): the
		// stable path alone, the shape gen-3 installs carried.
		return fmt.Sprintf(
			`/bin/sh -c '[ -n "$TMUX_PANE" ] || exit 0; "%s" agent hook --agent %s %s 2>/dev/null || true'`,
			stablePath, provider, state,
		)
	}
	return fmt.Sprintf(
		`/bin/sh -c '[ -n "$TMUX_PANE" ] || exit 0; "%s" agent hook --agent %s %s 2>/dev/null || "%s" agent hook --agent %s %s 2>/dev/null || true'`,
		launcherPath, provider, state, stablePath, provider, state,
	)
}

// agentStateHookCommandJSON builds the wrapper variant for harnesses whose
// hook contract parses stdout as a JSON result object (agy's hooks.json
// handlers): the rk report runs identically (same two-path fallback as
// agentStateHookCommand), then `{}` is echoed so the fire is a well-formed
// NO-DECISION result — an empty object carries no allow/deny/continue field,
// so native permission and termination behavior is preserved exactly. Always
// exits 0 (the trailing echo is the last command).
func agentStateHookCommandJSON(launcherPath, stablePath, state, provider string) string {
	if launcherPath == "" {
		return fmt.Sprintf(
			`/bin/sh -c '[ -n "$TMUX_PANE" ] && "%s" agent hook --agent %s %s 2>/dev/null; echo "{}"'`,
			stablePath, provider, state,
		)
	}
	return fmt.Sprintf(
		`/bin/sh -c '[ -n "$TMUX_PANE" ] && { "%s" agent hook --agent %s %s 2>/dev/null || "%s" agent hook --agent %s %s 2>/dev/null; }; echo "{}"'`,
		launcherPath, provider, state, stablePath, provider, state,
	)
}

// resolveRkPath returns the absolute path to embed in the installed hook. It
// prefers exec.LookPath("run-kit") — a long alias the formula installs — then
// exec.LookPath("rk") (the permanent short alias); on a Homebrew machine either
// yields the STABLE symlink (/home/linuxbrew/.linuxbrew/bin/run-kit or
// /opt/homebrew/bin/run-kit, and likewise for rk), NOT the version-pinned Cellar
// path. Both stable symlinks resolve to the same binary, so the order is a
// canonical-identity preference, not a correctness one. It falls back to
// os.Executable() WITHOUT resolving symlinks. Symlink resolution is deliberately
// avoided: it would pin the Cellar version and re-freeze the hook (the exact
// failure this change removes). On total resolution failure it returns "" so
// validateHookPath fails the install fast with a clear error: a bare-name
// fallback would reintroduce the PATH dependency the absolute path exists to
// eliminate, and writing a PATH-dependent hook that silently no-ops when the
// binary is off PATH at fire time is worse than a loud install-time failure the
// (interactive) user can act on.
func resolveRkPath() string {
	for _, name := range []string{"run-kit", "rk"} {
		if p, err := exec.LookPath(name); err == nil {
			if abs, err := filepath.Abs(p); err == nil {
				return abs
			}
			return p
		}
	}
	if p, err := os.Executable(); err == nil {
		// Intentionally NOT filepath.EvalSymlinks(p): that would pin the Cellar path.
		return p
	}
	return ""
}

// hookUnsafePathChars are the characters that must not appear in the rk path
// embedded in the hook command: the path sits inside a double-quoted region of a
// single-quoted `sh -c` string, so a single quote terminates the outer string
// and " $ ` \ are shell-active inside the double quotes.
const hookUnsafePathChars = "'\"$`\\"

// validateHookPath rejects a resolved rk path that cannot be embedded verbatim
// in the hook command as a STABLE, PATH-independent absolute path. It rejects
// three classes: (1) empty — resolveRkPath returning "" means total resolution
// failure, so there is no path to embed; (2) non-absolute (including a bare "rk")
// — the stable-hook design embeds an absolute path precisely to avoid the PATH
// dependency at hook-fire time, so a relative path defeats the whole change; and
// (3) shell-unsafe characters — the path sits inside a double-quoted region of a
// single-quoted sh -c string, so any of ' " $ ` \ would break the quoting.
// Rejection (a clear install-time error) is chosen over escaping or a silent
// fallback: escaping would have to survive three nested quoting layers
// (shell-in-shell-in-JSON — fragile to get right and to review), and such paths
// do not occur under Homebrew or any conventional install layout. rk agent setup
// is interactive, so the user is present to see the error and act on it.
func validateHookPath(path string) error {
	if path == "" {
		return fmt.Errorf("could not resolve the run-kit binary path; install run-kit on PATH (or at a conventional Homebrew location) and re-run")
	}
	if !filepath.IsAbs(path) {
		return fmt.Errorf("resolved run-kit path %q is not absolute; the hook must embed an absolute path to be PATH-independent at fire time — install run-kit at a conventional path and re-run", path)
	}
	if strings.ContainsAny(path, hookUnsafePathChars) {
		return fmt.Errorf("resolved run-kit path %q contains a shell-unsafe character (one of %s) and cannot be embedded in the hook command; install run-kit at a conventional path and re-run", path, hookUnsafePathChars)
	}
	// Control characters (newline, tab, DEL, …) are legal in a Unix path but
	// break the generated OpenCode JS string and Kimi TOML basic string, so the
	// install would succeed and leave an unparsable hook file behind.
	for _, r := range path {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("resolved run-kit path %q contains a control character and cannot be embedded in the hook command; install run-kit at a conventional path and re-run", path)
		}
	}
	return nil
}

// agentHook is one hook entry in an agent's event mapping: which harness event,
// an optional matcher (empty = no matcher), and the fixed state the command
// writes.
type agentHook struct {
	event   string // e.g. "UserPromptSubmit", "PreToolUse", "Notification", "Stop", "SessionStart"
	matcher string // optional; empty means the entry carries no "matcher" key
	// state is the positional token the installed wrapper passes to `rk
	// agent hook`: one of agentStateActive|Waiting|Idle (writes @rk_agent_state,
	// and also stamps @rk_pane_agent_session when the hook stdin carries a
	// session id) or agentHookStampToken (the SessionStart row: stamps
	// @rk_pane_agent_session AND writes @rk_agent_state idle — the boot-ready
	// signal — unless the payload's source is the provider's mid-turn
	// compaction source (agentRuntime.compactSource)).
	state string
}

// installerKind selects HOW an agent's hooks land in its native config (the
// three verified native shapes — see the file header).
type installerKind int

const (
	// kindJSONHooksMerge merges nested hook entries (hooks → <Event> →
	// [{matcher?, hooks: [{type:"command", command}]}]) into an existing JSON
	// config, preserving everything non-rk: claude settings.json, codex
	// hooks.json, and gemini settings.json all share this shape (verified
	// 2026-09-09 against the vendors' current docs).
	kindJSONHooksMerge installerKind = iota
	// kindMarkerFile writes a WHOLE marker-owned file — the native
	// one-file-per-source shape of copilot ($COPILOT_HOME/hooks/*.json) and
	// opencode (~/.config/opencode/plugins/*.js). rk never merges into or
	// removes a foreign marker-less file at the path.
	kindMarkerFile
	// kindMarkerBlock upserts a marker-owned region inside a user-owned file
	// (kimi's config.toml [[hooks]] tables) via the markerBlockBounds
	// machinery — no TOML parser, byte-exact preservation of surrounding
	// content.
	kindMarkerBlock
)

// agentConfig is one agent's install target: a display name, the runtime
// registry provider token, the installer kind with its target path(s), the
// ordered event→state mapping, the harness's user-global skills directory
// (legacy rk-display cleanup only), and the post-install activation note.
type agentConfig struct {
	name     string // display name
	provider string // agent_registry.go runtime key; the hook wrapper's --agent value
	kind     installerKind
	hooks    []agentHook
	// skillsDir locates the LEGACY rk-display skill for one-release cleanup
	// only (as {skillsDir}/rk-display/SKILL.md — see removeLegacySkill). rk
	// agent setup no longer installs any skill; an EMPTY skillsDir means "no
	// legacy skill to clean". Scheduled for removal one release after this
	// change.
	skillsDir string

	// kindJSONHooksMerge: the user-global settings file to merge into.
	settingsPath string
	// namedHooksDoc marks the Antigravity hooks.json shape: the document's top
	// level is a map of NAMED hooks (not a "hooks" event map), and rk owns
	// exactly one top-level key (rkNamedHookKey) holding flat event handler
	// arrays. The merge replaces/removes only that key.
	namedHooksDoc bool

	// kindMarkerFile: the marker-owned file path, its mode, and its full
	// content builder (launcher/stable are the validated absolute rk paths —
	// launcher first, stable fallback).
	filePath    string
	fileMode    os.FileMode
	fileContent func(launcher, stable string) string

	// kindMarkerBlock: the user-owned file and the marker-block builder.
	blockPath    string
	blockContent func(launcher, stable string) (begin, end, block string)

	// postInstallNote names the harness-side activation step the user still
	// owns after a successful write (codex's /hooks trust review; the other
	// harnesses load hook/plugin config at process start). Printed after an
	// install write so a written-but-inactive hook is never represented as
	// operational.
	postInstallNote string
}

// The three agent states are the canonical tokens from internal/tmux — imported,
// not re-declared, so the cross-repo @rk_agent_state convention has ONE source of
// truth per binary (A-021).
const (
	agentStateActive  = tmux.AgentStateActive
	agentStateWaiting = tmux.AgentStateWaiting
	agentStateIdle    = tmux.AgentStateIdle
)

// claudeSettingsRelPath is the user-global Claude Code settings file, relative to
// the home dir.
var claudeSettingsRelPath = filepath.Join(".claude", "settings.json")

// agentRegistry returns the per-agent install registry — one row per supported
// harness, in display order. Event mappings are verified against current vendor
// docs (2026-09-09) and the installed versions; the versioned capability
// matrix with sources lives in docs/site/agent-hooks.md. The runtime
// descriptors (comm, payload shape) live in agent_registry.go; this table adds
// only the install-time axes (config placement, format, activation note).
func agentRegistry(home string) []agentConfig {
	codexHome := os.Getenv("CODEX_HOME")
	if codexHome == "" {
		codexHome = filepath.Join(home, ".codex")
	}
	copilotHome := os.Getenv("COPILOT_HOME")
	if copilotHome == "" {
		copilotHome = filepath.Join(home, ".copilot")
	}
	kimiHome := os.Getenv("KIMI_CODE_HOME")
	if kimiHome == "" {
		kimiHome = filepath.Join(home, ".kimi-code")
	}
	return []agentConfig{
		{
			name:         "Claude Code",
			provider:     "claude",
			kind:         kindJSONHooksMerge,
			settingsPath: filepath.Join(home, claudeSettingsRelPath),
			skillsDir:    filepath.Join(home, ".claude", "skills"),
			hooks: []agentHook{
				{event: "UserPromptSubmit", state: agentStateActive},
				{event: "PreToolUse", state: agentStateActive},
				{event: "Notification", matcher: "permission_prompt|elicitation_dialog|agent_needs_input", state: agentStateWaiting},
				{event: "Notification", matcher: "idle_prompt", state: agentStateIdle},
				{event: "Stop", state: agentStateIdle},
				// SessionStart (token "stamp" — see agentHookStampToken) stamps
				// @rk_pane_agent_session within seconds of session start, before any prompt,
				// re-stamps on every session-id rotation, and writes
				// @rk_pane_agent_state idle as the boot-ready signal — withheld only
				// for source=compact, which fires mid-turn (SessionStart fires on
				// startup/resume/clear/compact).
				{event: "SessionStart", state: agentHookStampToken},
			},
		},
		{
			// Codex CLI (0.153.4 verified): hooks are stable and on by default;
			// hooks.json carries the SAME nested shape as Claude's settings.
			// SessionEnd fires when the main thread ends (incl. the 30-min idle
			// timeout) — a genuine idle signal. SubagentStart/SubagentStop are
			// deliberately NOT mapped: a child event must never replace the root
			// pane's identity or complete its turn.
			name:         "Codex",
			provider:     "codex",
			kind:         kindJSONHooksMerge,
			settingsPath: filepath.Join(codexHome, "hooks.json"),
			hooks: []agentHook{
				{event: "UserPromptSubmit", state: agentStateActive},
				{event: "PreToolUse", state: agentStateActive},
				{event: "PermissionRequest", state: agentStateWaiting},
				{event: "Stop", state: agentStateIdle},
				{event: "SessionEnd", state: agentStateIdle},
				{event: "SessionStart", state: agentHookStampToken},
			},
			postInstallNote: "Codex skips non-managed hooks until they are trusted: run `codex`, open /hooks, and review/trust the run-kit entries — until then they are installed but INACTIVE.",
		},
		{
			// Gemini CLI (0.54.4 verified): settings.json hooks share the
			// nested shape. Notification is observability-only (it cannot
			// grant permissions) but fires BEFORE the prompt, which is exactly
			// the waiting signal. Gemini's SessionStart sources are
			// startup|resume|clear — no mid-turn compact source exists.
			name:         "Gemini CLI",
			provider:     "gemini",
			kind:         kindJSONHooksMerge,
			settingsPath: filepath.Join(home, ".gemini", "settings.json"),
			hooks: []agentHook{
				{event: "BeforeAgent", state: agentStateActive},
				{event: "BeforeTool", state: agentStateActive},
				{event: "Notification", matcher: "ToolPermission", state: agentStateWaiting},
				{event: "AfterAgent", state: agentStateIdle},
				{event: "SessionEnd", state: agentStateIdle},
				{event: "SessionStart", state: agentHookStampToken},
			},
			postInstallNote: "Gemini CLI reads hooks at session start — restart running gemini sessions to pick them up.",
		},
		{
			// Copilot CLI (1.0.78 verified): one JSON file per source under
			// hooks/; camelCase event names select the camelCase payload
			// (sessionId). preToolUse command hooks are fail-closed on non-zero
			// exits — the never-fail wrapper (always exit 0) is what makes the
			// active mapping safe there. subagentStart/Stop deliberately NOT
			// mapped (root-pane identity rule).
			name:     "GitHub Copilot",
			provider: "copilot",
			kind:     kindMarkerFile,
			filePath: filepath.Join(copilotHome, "hooks", "run-kit.json"),
			fileMode: 0o600,
			fileContent: func(launcher, stable string) string {
				return copilotHooksFile(launcher, stable)
			},
			hooks:           copilotHooks,
			postInstallNote: "Copilot CLI loads hook configuration at CLI start — restart running copilot sessions to pick it up.",
		},
		{
			// Kimi Code CLI (0.41.0 verified): [[hooks]] tables in config.toml.
			// Only the documented fields are emitted — unknown fields fail the
			// whole config load. SessionStart sources are startup|resume (no
			// compact source), so the stamp token's compact gate is inert.
			name:            "Kimi Code",
			provider:        "kimi",
			kind:            kindMarkerBlock,
			blockPath:       filepath.Join(kimiHome, "config.toml"),
			blockContent:    kimiHooksBlock,
			hooks:           kimiHooks,
			postInstallNote: "Kimi Code reads hooks at session start — start a new kimi session to pick them up.",
		},
		{
			// OpenCode (1.18.25 verified): a marker-owned JS plugin over the
			// event stream (the only hook surface; there are no declarative
			// command hooks). The event→token mapping lives in the plugin
			// source itself.
			name:     "OpenCode",
			provider: "opencode",
			kind:     kindMarkerFile,
			filePath: filepath.Join(home, ".config", "opencode", "plugins", "run-kit.js"),
			fileMode: 0o644,
			fileContent: func(launcher, stable string) string {
				return opencodePluginFile(launcher, stable)
			},
			postInstallNote: "OpenCode loads plugins at startup — restart running opencode sessions to pick it up.",
		},
		{
			// Antigravity CLI (agy 1.1.11 verified against the shipped
			// agy-customizations hooks.md and antigravity.google/docs/hooks):
			// hooks.json at the user-global customization root, with NAMED
			// top-level hooks — rk owns only the "run-kit" key. PreInvocation
			// (before every model call) is the active + identity signal; Stop
			// (loop termination) maps to idle, gated on the payload's
			// fullyIdle so a stop with background tasks running stays honest.
			// PreToolUse is deliberately NOT hooked: its contract answers
			// permission decisions, and run-kit never emits allow/deny for
			// telemetry — so agy has NO waiting signal (documented gap). There
			// is no SessionStart event either; identity lands on the first
			// model invocation. agy hook handlers must answer a JSON object on
			// stdout — the JSON wrapper variant emits {} (a no-decision
			// result) after reporting.
			name:          "Antigravity",
			provider:      "agy",
			kind:          kindJSONHooksMerge,
			namedHooksDoc: true,
			settingsPath:  filepath.Join(home, ".gemini", "config", "hooks.json"),
			hooks: []agentHook{
				{event: "PreInvocation", state: agentStateActive},
				{event: "Stop (fullyIdle)", state: agentStateIdle},
			},
			postInstallNote: "Antigravity reads hooks at session start — start a new agy session to pick them up. No permission/waiting event is hooked (tool-permission hooks are decision contracts), so agy panes never report waiting.",
		},
	}
}

// consent captures how a write should be authorized for a single agent setup
// run, reconciling Principle 1 (a warranted confirmation MUST be satisfiable by
// a flag, and a non-TTY invocation MUST refuse — never hang on a prompt no one
// will answer) with Principle 5 (destructive writes MUST support --dry-run):
//   - dryRun: show the diff, write nothing, need no consent (--dry-run wins if
//     both are passed — a preview must never mutate).
//   - yes: skip the interactive prompt and write (non-interactive consent).
//   - neither, stdin is a TTY: fall back to the interactive [y/N] prompt.
//   - neither, stdin is NOT a TTY: refuse with an error naming --yes (a
//     success-looking silent no-op is the agent trap Principle 1 targets;
//     reference impl: shll uninstall).
//
// stdinIsTTY records whether the invocation's stdin is an interactive terminal.
// The zero value is false, so a default consent{} is "no flags, no TTY" — which
// refuses. Production sets it by inspecting the real stdin (see runAgentSetup);
// tests simulating an interactive session set it explicitly.
type consent struct {
	yes        bool
	dryRun     bool
	stdinIsTTY bool
}

// errNonInteractiveConsent is returned when a write is pending, neither --yes
// nor --dry-run was passed, and stdin is not a TTY — the Principle 1 non-TTY
// refusal. It names --yes so the caller (agent) knows how to proceed, and its
// presence guarantees nothing was written.
var errNonInteractiveConsent = errors.New("refusing to write without confirmation: stdin is not a TTY — pass --yes to consent non-interactively, or --dry-run to preview without writing")

// diffWriter selects the channel a pending write's diff renders to, given this
// consent mode (R5). On the --yes path the write is already authorized, so the
// diff is narration → the chatter channel (quiet-gated: `--yes --quiet` is
// silent on success). On the interactive and --dry-run paths the diff is either
// the context for the [y/N] prompt or the explicitly-requested dry-run output →
// the data channel (never gated). --dry-run wins over --yes (a preview is data),
// matching authorizeWrite's precedence.
func (c consent) diffWriter(sink outputSink) io.Writer {
	if c.yes && !c.dryRun {
		return sink.chatter
	}
	return sink.data
}

// authorizeWrite decides whether a pending write proceeds. On --dry-run it
// reports the preview to out and returns (false, nil) (no write); on --yes it
// returns (true, nil) without prompting; on a TTY with neither flag it prints
// promptSuffix and defers to the interactive prompt; with neither flag on a
// non-TTY stdin it refuses, returning (false, errNonInteractiveConsent) so
// nothing is written (Principle 1).
//
// promptSuffix (e.g. "Write these changes? [y/N] ") is emitted ONLY on the
// interactive path — the auto-answered --yes/--dry-run paths never read the
// prompt, so printing "[y/N] " there reads as a hang in an agent's transcript.
func (c consent) authorizeWrite(out io.Writer, reader *bufio.Reader, dryRunNote, promptSuffix string) (bool, error) {
	if c.dryRun {
		fmt.Fprintf(out, "%s\n", dryRunNote)
		return false, nil
	}
	if c.yes {
		return true, nil
	}
	if !c.stdinIsTTY {
		return false, errNonInteractiveConsent
	}
	fmt.Fprint(out, promptSuffix)
	return confirm(reader), nil
}

// newAgentSetupCmd builds one instance of the setup command. A cobra command
// object cannot have two parents, so the family member (`rk agent setup`) and
// the hidden root alias (`rk agent-setup`) are two instances sharing the
// runAgentSetup core; the flag variables bind per-instance so the two never
// share state. Args is pre-wrapped with usageArgs for both instances: root's
// init loop (root.go) only wraps DIRECT children's validators, and the family
// member's unwrapped NoArgs violation would exit 1 instead of usage-class 2
// (the alias's wrap is then applied twice — harmless: message and code survive).
// deprecated marks the root alias: hidden from help, and cobra prints the
// pointer (to OutOrStderr — stderr in production) before still running the
// command with identical flags and exit codes.
func newAgentSetupCmd(use string, deprecated bool) *cobra.Command {
	var uninstall, yes, dryRun bool
	c := &cobra.Command{
		Use:          use,
		Short:        "Install agent-harness hooks that report agent state to run-kit",
		Long:         agentSetupLong,
		Args:         usageArgs(cobra.NoArgs),
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			in := cmd.InOrStdin()
			return runAgentSetup(newSink(cmd), in, uninstall, consent{yes: yes, dryRun: dryRun, stdinIsTTY: isTerminal(in)})
		},
	}
	c.Flags().BoolVar(&uninstall, "uninstall", false, "Remove the rk-owned hook entries instead of installing them")
	c.Flags().BoolVarP(&yes, "yes", "y", false, "Write without prompting (non-interactive consent)")
	c.Flags().BoolVar(&dryRun, "dry-run", false, "Show the diff and write nothing (wins over --yes)")
	if deprecated {
		c.Hidden = true
		c.Deprecated = "use `rk agent setup` instead"
	}
	return c
}

// agentSetupLong is the setup command's Long help. It names every supported
// harness and its config target (kept honest by TestAgentSetupLongListsEveryProvider)
// and deliberately repeats that Codex hooks need the native /hooks trust review
// before they run — a written hook is not an active one.
const agentSetupLong = "Install (or --uninstall) the hooks that write the " + tmux.AgentStateOption + " tmux " +
	"pane option so run-kit can show any agent's active/waiting/idle state and its " +
	"session identity. Supported harnesses: Claude Code (~/.claude/settings.json), " +
	"Codex ($CODEX_HOME/hooks.json), Gemini CLI (~/.gemini/settings.json), GitHub " +
	"Copilot CLI ($COPILOT_HOME/hooks/run-kit.json), Kimi Code " +
	"($KIMI_CODE_HOME/config.toml), OpenCode (~/.config/opencode/plugins/run-kit.js), " +
	"and Antigravity CLI (~/.gemini/config/hooks.json) " +
	"— each wired only when its binary is on PATH. Installs preserve existing " +
	"configuration, re-running is idempotent, and a diff is shown for confirmation " +
	"before anything is written. Codex skips non-managed hooks until they are " +
	"trusted — after installing, run `codex` and review them via /hooks. Also " +
	"installs the tmux guard shim (~/.local/share/rk/shims/tmux plus a marker-owned " +
	"PATH block in the shell startup files) so `tmux kill-server` without an " +
	"explicit -L/-S socket is blocked via `rk mux guard`. Use --yes to write " +
	"without prompting (non-interactive), or --dry-run to preview the diff and " +
	"write nothing."

var (
	// agentSetupFamilyCmd is the `rk agent setup` family member.
	agentSetupFamilyCmd = newAgentSetupCmd("setup", false)
	// agentSetupAliasCmd is the hidden deprecation alias kept at the root so the
	// old human-typed form keeps working while pointing at the new one.
	agentSetupAliasCmd = newAgentSetupCmd("agent-setup", true)
)

// runAgentSetup applies the install/uninstall to every agent in the registry,
// showing a diff and prompting for confirmation before each write. It is split
// from the cobra RunE with an explicit outputSink/io.Reader so it is testable
// without a TTY.
//
// Output convention (Toolkit Principle 9): informational status lines go to the
// sink's chatter channel (dropped by --quiet); the settings diff and the
// interactive consent prompt go to the data channel (never gated — a consent
// prompt without the diff it asks about would be a dark pattern, and a dry-run's
// diff is the requested data). The non-TTY refusal is an error and always
// surfaces regardless of --quiet.
func runAgentSetup(sink outputSink, in io.Reader, uninstall bool, cons consent) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("could not determine home directory: %w", err)
	}

	// Resolve the absolute rk path ONCE per invocation — it is install-host-stable
	// within a single run, and resolving once keeps every installed hook entry
	// consistent. Only the install path needs it; uninstall passes "". The path is
	// validated before any merge: a shell-unsafe path must fail the install with a
	// clear error, never be embedded (see validateHookPath). The launcher path (the
	// rk-owned symlink the hooks exec FIRST) is home-derived and validated the same
	// way — both paths sit inside the wrapper's quoting.
	rkPath := ""
	launcherPath := ""
	if !uninstall {
		rkPath = resolveRkPath()
		if err := validateHookPath(rkPath); err != nil {
			return err
		}
		launcherPath = selfpath.LauncherFor(home)
		if err := validateHookPath(launcherPath); err != nil {
			return err
		}
	}

	reader := bufio.NewReader(in)

	// The launcher pointer is a hooks-family artifact — the installed wrappers
	// exec it first — so it is written AHEAD of every per-agent hook install, the
	// shim, and the gui display block (artifact before the things that exec it,
	// the tmux-shim ordering precedent). Its target is the RESOLVED Cellar binary
	// (EvalSymlinks of the validated PATH-found stable path): the launcher's whole
	// purpose is to stay live while brew's stable symlink dangles mid-upgrade, so
	// it must not itself point at that symlink. The running setup binary's own
	// location is deliberately not trusted (a dev-worktree `bin/rk agent setup`
	// must still point the launcher at the installed Homebrew binary). A declined
	// or foreign pointer never blocks the hooks — the wrapper's second path
	// (rkPath) covers a missing launcher. On uninstall the pointer comes off LAST,
	// after the hooks and the gui block that reference it.
	pointerState := guiPointerDeclined
	if !uninstall {
		target := rkPath
		if resolved, err := filepath.EvalSymlinks(rkPath); err == nil {
			target = resolved
		}
		var err error
		pointerState, err = installLauncherPointer(sink, reader, home, target, cons)
		if err != nil {
			return err
		}
		// A foreign regular file at the launcher path is never exec'd: a hook
		// that ran it would exit 0 and mask the stable fallback, silently
		// losing every state write. The wrappers then carry the stable path
		// alone (the pre-launcher shape); the pointer note above already says
		// how to reclaim the path.
		if pointerState == guiPointerForeign {
			launcherPath = ""
		}
	}
	for _, ac := range agentRegistry(home) {
		// Installs wire only harnesses whose binary is on PATH (writing config
		// for a tool the machine does not have is noise, mirroring the shll
		// gated-placement rule). Uninstalls are NOT gated: removal must work
		// after the harness itself is gone.
		if !uninstall && !agentBinaryOnPath(ac.provider) {
			sink.Notef("%s: skipped (the %s binary is not on PATH).\n", ac.name, ac.providerBinary())
			continue
		}
		if err := applyAgentConfig(sink, reader, ac, launcherPath, rkPath, uninstall, cons); err != nil {
			return err
		}
	}
	// The tmux guard shim is user-global (one shim, one PATH block), not
	// per-agent — applied once after the agent loop. $ZDOTDIR is read here at
	// the call boundary (like home above) so everything below stays pure over
	// injected paths.
	if err := applyTmuxShim(sink, reader, home, os.Getenv("ZDOTDIR"), rkPath, uninstall, cons); err != nil {
		return err
	}
	// The gui display block is likewise user-global and runs after the shim.
	// It does NOT depend on the shim being in place: it reaches rk through the
	// launcher pointer written above and gates on that step's verdict instead.
	return applyGuiDisplayBlocks(sink, reader, home, os.Getenv("ZDOTDIR"), pointerState, uninstall, cons)
}

// applyAgentConfig applies the agent's installer kind and, on BOTH the install
// and uninstall passes, cleans up any stale legacy rk-display skill. The legacy
// cleanup is a one-release courtesy that removes a marker-owned rk-display
// skill left by an older run-kit. Each step is handled independently — its own
// tolerant read, diff/prompt, and no-op report — so declining or no-op-ing one
// does not skip the other. The legacy cleanup is skipped entirely when
// skillsDir is empty (every non-claude row).
//
// On install the agent's postInstallNote is printed (chatter) whenever the
// harness has an activation step rk cannot perform for it — codex's /hooks
// trust review, or a session restart to load hook/plugin config — so a
// written-but-inactive hook is never represented as operational.
func applyAgentConfig(sink outputSink, reader *bufio.Reader, ac agentConfig, launcherPath, rkPath string, uninstall bool, cons consent) error {
	var err error
	switch ac.kind {
	case kindMarkerFile:
		err = applyAgentMarkerFile(sink, reader, ac, launcherPath, rkPath, uninstall, cons)
	case kindMarkerBlock:
		err = applyAgentMarkerBlock(sink, reader, ac, launcherPath, rkPath, uninstall, cons)
	default:
		err = applyAgentHooks(sink, reader, ac, launcherPath, rkPath, uninstall, cons)
	}
	if err != nil {
		return err
	}
	if !uninstall && ac.postInstallNote != "" {
		// Activation note — chatter (dropped by --quiet).
		sink.Notef("%s: %s\n", ac.name, ac.postInstallNote)
	}
	if ac.skillsDir != "" {
		if err := removeLegacySkill(sink, reader, ac, cons); err != nil {
			return err
		}
	}
	return nil
}

// applyAgentHooks reads one agent's settings file, computes the merged (or
// unmerged) result, prints a diff, and — on confirmation — writes it back. A
// no-op (result identical to current) is reported and skipped without prompting.
func applyAgentHooks(sink outputSink, reader *bufio.Reader, ac agentConfig, launcherPath, rkPath string, uninstall bool, cons consent) error {
	current, err := readSettings(ac.settingsPath)
	if err != nil {
		return fmt.Errorf("%s: read %s: %w", ac.name, ac.settingsPath, err)
	}

	next := cloneJSONMap(current)
	if uninstall {
		if ac.namedHooksDoc {
			unmergeNamedHook(next)
		} else {
			unmergeHooks(next)
		}
	} else {
		if ac.namedHooksDoc {
			mergeNamedHook(next, launcherPath, rkPath)
		} else {
			mergeHooks(next, ac.hooks, launcherPath, rkPath, ac.provider)
		}
	}

	beforeJSON := mustMarshalIndent(current)
	afterJSON := mustMarshalIndent(next)
	if beforeJSON == afterJSON {
		verb := "installed"
		if uninstall {
			verb = "absent"
		}
		// Informational status line — chatter (dropped by --quiet).
		sink.Notef("%s: hooks already %s in %s — nothing to do.\n", ac.name, verb, ac.settingsPath)
		return nil
	}

	action := "install"
	if uninstall {
		action = "uninstall"
	}
	// The diff routes PER CONSENT MODE (R5's net-effect clause: `--yes --quiet`
	// is fully silent on success):
	//   - interactive prompt / --dry-run → data (never gated): the interactive
	//     prompt without the diff it asks about would be a dark pattern, and a
	//     --dry-run diff is the explicitly-requested output.
	//   - --yes → chatter (quiet-gated): the write is already authorized, so the
	//     diff is narration of an action that will happen regardless. `--yes`
	//     non-quiet still shows it on stderr; `--yes --quiet` drops it, leaving
	//     the invocation silent on success.
	// The consent prompt itself (prompt suffix / dry-run note) always goes to the
	// data channel via authorizeWrite.
	//
	// WHAT renders splits on --dry-run: the full current+proposed JSON bodies
	// are the explicitly-requested preview data there; everywhere else the
	// semantic per-entry summary is what consent needs — the merge preserves
	// every non-rk entry, so dumping both full documents buries the prompt
	// (~90 lines fresh-run) without adding information.
	header := fmt.Sprintf("%s: will %s run-kit agent-state hooks in %s", ac.name, action, ac.settingsPath)
	if cons.dryRun {
		renderArtifactDiff(cons.diffWriter(sink), header, beforeJSON, afterJSON)
	} else {
		renderHooksSummary(cons.diffWriter(sink), header, ac.hooks, countRkOwned(ac, current), uninstall)
	}

	dryRunNote := fmt.Sprintf("%s: dry run — no changes written.", ac.name)
	ok, err := cons.authorizeWrite(sink.data, reader, dryRunNote, "\nWrite these changes? [y/N] ")
	if err != nil {
		return err
	}
	if !ok {
		if !cons.dryRun {
			// Status line — chatter.
			sink.Notef("%s: skipped (no changes written).\n", ac.name)
		}
		return nil
	}

	if err := writeSettings(ac.settingsPath, next); err != nil {
		return fmt.Errorf("%s: write %s: %w", ac.name, ac.settingsPath, err)
	}
	// Status line — chatter.
	sink.Notef("%s: wrote %s.\n", ac.name, ac.settingsPath)
	return nil
}

// removeLegacySkill cleans up a stale, rk-owned rk-display skill left by an older
// run-kit. It runs on BOTH the install and uninstall passes (see applyAgentConfig)
// because re-running plain `rk agent setup` is the documented upgrade action, so
// most machines only ever reach the install path — a cleanup gated on --uninstall
// would never fire for them. rk agent setup no longer WRITES this skill; this is a
// one-release courtesy scheduled for removal one release after this change.
//
// Behavior is uniform across both passes:
//   - ABSENT file → silent (a fresh machine must see zero rk-display output).
//   - marker-less (user-rewritten) file → left untouched with a skip note (rk only
//     removes files it owns).
//   - marker-owned file → offer removal (confirm), then os.RemoveAll the whole
//     rk-display/ directory. Removal is confirmed first because it deletes the
//     entire directory, including any user-added files within it.
func removeLegacySkill(sink outputSink, reader *bufio.Reader, ac agentConfig, cons consent) error {
	skillDir := filepath.Join(ac.skillsDir, rkDisplaySkillDir)
	skillPath := filepath.Join(skillDir, rkDisplaySkillFile)

	current, err := readSkill(skillPath)
	if err != nil {
		return fmt.Errorf("%s: read %s: %w", ac.name, skillPath, err)
	}

	if current == "" {
		// Absent legacy skill: nothing to clean, and nothing to say — a fresh
		// machine must produce no rk-display output at all.
		return nil
	}
	if !skillHasMarker(current) {
		// Removal narration — chatter (dropped by --quiet).
		sink.Notef("%s: %s was rewritten without the %q marker — leaving it untouched (rk only removes files it owns).\n", ac.name, skillPath, skillManagedByMarker)
		return nil
	}

	// The "found a legacy skill" line is narration (chatter), but the consent
	// prompt + dry-run note are interaction/requested-data and go to the data
	// channel (survive --quiet), mirroring applyAgentHooks.
	sink.Notef("%s: found a legacy rk-display skill at %s (rk agent setup no longer installs it).\n\n", ac.name, skillPath)
	dryRunNote := fmt.Sprintf("%s: dry run — legacy rk-display skill left in place (nothing removed).", ac.name)
	promptSuffix := fmt.Sprintf("Remove the %s directory? [y/N] ", skillDir)
	ok, err := cons.authorizeWrite(sink.data, reader, dryRunNote, promptSuffix)
	if err != nil {
		return err
	}
	if !ok {
		if !cons.dryRun {
			// Status line — chatter.
			sink.Notef("%s: legacy rk-display skill left in place (nothing removed).\n", ac.name)
		}
		return nil
	}

	if err := os.RemoveAll(skillDir); err != nil {
		return fmt.Errorf("%s: remove %s: %w", ac.name, skillDir, err)
	}
	// Status line — chatter.
	sink.Notef("%s: removed %s.\n", ac.name, skillDir)
	return nil
}

// skillHasMarker reports whether a legacy skill file carries the rk ownership
// marker. It is the whole-file analogue of isRkEntry: rk owned the entire
// SKILL.md, so a simple frontmatter-marker presence check gates its destructive
// removal (never a merge). A user who rewrote the file dropped the marker and
// thereby opts out of rk-managed removal.
func skillHasMarker(content string) bool {
	return strings.Contains(content, skillManagedByMarker)
}

// readSkill loads the current legacy skill file for cleanup. A missing file is
// treated tolerantly as empty content (never an error) — a fresh machine has no
// legacy skill, and removeLegacySkill treats empty as "nothing to clean". Any
// other read error surfaces so we never act on a file we failed to read.
func readSkill(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	return string(data), nil
}

// readFileIfExists loads a file, distinguishing ABSENCE from EMPTINESS: it
// returns (content, exists, err). readSkill's tolerant absent→"" collapse is
// wrong for ownership decisions — a zero-byte user file at a managed path is
// still a user file, and conflating it with "no file" would let rk overwrite
// it (the marker-less protection must key on existence, not on content).
func readFileIfExists(path string) (string, bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", false, nil
		}
		return "", false, err
	}
	return string(data), true, nil
}

// renderHooksSummary prints the semantic consent summary for the hooks merge on
// the interactive and --yes paths: one line per rk entry being installed
// (event, optional matcher, state), plus replace/remove accounting derived from
// the CURRENT settings via countRkEntries — never hardcoded, so the summary
// stays honest as the registry grows. The uninstall form is a single removal
// line. Full current+proposed bodies render only under --dry-run (see
// applyAgentHooks).
func renderHooksSummary(out io.Writer, header string, hooks []agentHook, existingRk int, uninstall bool) {
	fmt.Fprintf(out, "%s\n\n", header)
	entryWord := "entries"
	if existingRk == 1 {
		entryWord = "entry"
	}
	if uninstall {
		fmt.Fprintf(out, "  - removes %d rk-owned hook %s; all other settings and non-rk hooks preserved\n", existingRk, entryWord)
		return
	}
	for _, h := range hooks {
		label := h.state
		if h.state == agentHookStampToken {
			label = "session stamp + idle (boot-ready)"
		}
		if h.matcher != "" {
			fmt.Fprintf(out, "  + %s (%s) → %s\n", h.event, h.matcher, label)
		} else {
			fmt.Fprintf(out, "  + %s → %s\n", h.event, label)
		}
	}
	if existingRk > 0 {
		fmt.Fprintf(out, "  (replaces %d existing rk-owned %s in place; all other settings and non-rk hooks preserved)\n", existingRk, entryWord)
	} else {
		fmt.Fprintln(out, "  (all other settings and non-rk hooks preserved)")
	}
}

// countRkEntries counts the rk-owned hook entries across every event array in
// settings — the replace/remove accounting renderHooksSummary reports. Every
// hook-command generation counts (isRkEntry matches all three markers).
func countRkEntries(settings map[string]any) int {
	n := 0
	for _, v := range asMap(settings["hooks"]) {
		for _, e := range asSlice(v) {
			if isRkEntry(asMap(e)) {
				n++
			}
		}
	}
	return n
}

// renderArtifactDiff prints the shared "will <action> … / --- current / +++
// proposed" block for the settings-hooks merge. It was once shared with the
// rk-display skill install (now removed), so it stays a standalone helper — the
// diff framing is kept in one place.
//
// `current` and `proposed` are the already-formatted body strings (indented JSON
// for hooks); this helper adds no further trimming. The header carries no trailing
// newline — this function appends the blank line that separates it from the diff.
// The "Write these changes? [y/N] " prompt suffix is NOT emitted here — it is
// printed by authorizeWrite only on the interactive path, so the auto-answered
// --yes/--dry-run paths never dangle an unanswered prompt.
func renderArtifactDiff(out io.Writer, header, current, proposed string) {
	fmt.Fprintf(out, "%s\n\n", header)
	fmt.Fprintln(out, "--- current")
	fmt.Fprintln(out, current)
	fmt.Fprintln(out, "+++ proposed")
	fmt.Fprintln(out, proposed)
}

// isTerminal reports whether r is an interactive terminal, used to decide
// between the interactive [y/N] prompt and the Principle 1 non-TTY refusal. It
// uses term.IsTerminal (a TCGETS/TIOCGETA ioctl), NOT a bare os.ModeCharDevice
// check: a char-device test alone treats /dev/null (`rk agent setup </dev/null`,
// the exact non-interactive shape an agent uses) as a terminal, which would make
// the refusal silently not fire. A non-*os.File reader (e.g. a test's
// strings.Reader or a pipe) is not a TTY, so tests default to the
// non-interactive path unless they say otherwise.
func isTerminal(r io.Reader) bool {
	f, ok := r.(*os.File)
	if !ok {
		return false
	}
	return term.IsTerminal(int(f.Fd()))
}

// confirm reads a single line and returns true only for an explicit yes
// (y/yes, case-insensitive). Default (empty / anything else) is No — the
// conventional destructive-write default.
func confirm(reader *bufio.Reader) bool {
	line, _ := reader.ReadString('\n')
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes":
		return true
	default:
		return false
	}
}

// readSettings loads a JSON settings file into a generic map. A missing, empty,
// or all-whitespace file is treated tolerantly as an empty object (never an
// error) — install must work on a fresh machine with no settings.json yet. A
// genuinely malformed (non-empty, non-JSON) file IS surfaced as an error so we
// never silently clobber a file we failed to understand.
func readSettings(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{}, nil
		}
		return nil, err
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return map[string]any{}, nil
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("existing settings is not valid JSON: %w", err)
	}
	if m == nil {
		m = map[string]any{}
	}
	return m, nil
}

// writeSettings writes the settings map as indented JSON, creating the parent
// directory if needed. Mode 0600 matches the sensitivity of user agent config.
func writeSettings(path string, m map[string]any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("creating config directory: %w", err)
	}
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(path, data, 0o600)
}

// mergeHooks installs the given hook entries under settings["hooks"], preserving
// every non-rk entry. It is idempotent: for each (event, matcher) it first
// removes any existing rk-owned entry (identified by rkHookMarker in a command)
// from that event's array, then appends the fresh rk entry — so a re-run
// replaces in place and never duplicates. Non-rk entries and their order are
// preserved. The shared nested hooks shape (claude settings.json, codex
// hooks.json, gemini settings.json) is:
//
//	hooks → <Event> → [ { matcher?, hooks: [ {type:"command", command} ] } ]
func mergeHooks(settings map[string]any, hooks []agentHook, launcherPath, rkPath, provider string) {
	hooksRoot := asMap(settings["hooks"])
	if hooksRoot == nil {
		hooksRoot = map[string]any{}
	}

	// Strip every existing rk entry from each touched event array FIRST, once —
	// an event may carry more than one rk hook (e.g. Notification maps to both a
	// waiting and an idle entry), so removing per-hook would drop entries added
	// earlier in this same pass. removeRkEntries matches ALL generations, so a
	// re-run over old-generation entries replaces them in place. Non-rk entries
	// are untouched.
	touched := make(map[string]bool)
	for _, h := range hooks {
		if !touched[h.event] {
			hooksRoot[h.event] = removeRkEntries(asSlice(hooksRoot[h.event]))
			touched[h.event] = true
		}
	}

	// Now append the fresh rk entries.
	for _, h := range hooks {
		hooksRoot[h.event] = append(asSlice(hooksRoot[h.event]), rkHookEntry(h, launcherPath, rkPath, provider))
	}

	settings["hooks"] = hooksRoot
}

// unmergeHooks removes exactly the rk-owned hook entries from every event array,
// leaving non-rk entries and all other config untouched. An event array that
// becomes empty is deleted; a "hooks" object that becomes empty is deleted.
func unmergeHooks(settings map[string]any) {
	hooksRoot := asMap(settings["hooks"])
	if hooksRoot == nil {
		return
	}
	for event, v := range hooksRoot {
		arr := removeRkEntries(asSlice(v))
		if len(arr) == 0 {
			delete(hooksRoot, event)
		} else {
			hooksRoot[event] = arr
		}
	}
	if len(hooksRoot) == 0 {
		delete(settings, "hooks")
	} else {
		settings["hooks"] = hooksRoot
	}
}

// rkHookEntry builds the nested hook-entry object (claude/codex/gemini shape)
// for one agentHook: an optional matcher plus a single command handler.
func rkHookEntry(h agentHook, launcherPath, rkPath, provider string) map[string]any {
	entry := map[string]any{
		"hooks": []any{
			map[string]any{
				"type":    "command",
				"command": agentStateHookCommand(launcherPath, rkPath, h.state, provider),
			},
		},
	}
	if h.matcher != "" {
		entry["matcher"] = h.matcher
	}
	return entry
}

// removeRkEntries returns arr with every rk-owned entry removed. An entry is
// rk-owned if any of its command handlers carries the rkHookMarker. Non-rk
// entries keep their relative order.
func removeRkEntries(arr []any) []any {
	if len(arr) == 0 {
		return arr
	}
	out := make([]any, 0, len(arr))
	for _, e := range arr {
		if isRkEntry(asMap(e)) {
			continue
		}
		out = append(out, e)
	}
	return out
}

// isRkEntry reports whether a hook-entry object is rk-owned — one walk of the
// entry's hooks[] (rkEntryCommands owns it), true when any command carries a
// marker. Non-rk hooks carry no marker and are preserved untouched.
func isRkEntry(entry map[string]any) bool {
	return len(rkEntryCommands(entry)) > 0
}

// rkEntryCommands returns the marker-carrying command strings of a hook-entry
// object. It matches ALL THREE generations of the hook command: the LEGACY
// self-contained one-liner (which inlined the @rk_agent_state option name →
// rkHookMarker), the second-generation delegating one-liner (`rk agent-hook` →
// rkHookMarkerAgentHook), and the third-generation family form (`rk agent hook`
// → rkHookMarkerAgentHookFamily); the delegating forms no longer contain the
// option name. Matching all three is what lets `rk agent setup` on the new
// binary strip older-generation entries and replace them in place, and lets
// `--uninstall` remove every generation. rk doctor's agent-hooks row consumes
// the returned commands for generation classification.
func rkEntryCommands(entry map[string]any) []string {
	if entry == nil {
		return nil
	}
	var cmds []string
	for _, hv := range asSlice(entry["hooks"]) {
		handler := asMap(hv)
		if handler == nil {
			continue
		}
		cmd, ok := handler["command"].(string)
		if !ok {
			continue
		}
		if strings.Contains(cmd, rkHookMarker) ||
			strings.Contains(cmd, rkHookMarkerAgentHook) ||
			strings.Contains(cmd, rkHookMarkerAgentHookFamily) {
			cmds = append(cmds, cmd)
		}
	}
	return cmds
}

// --- tmux guard shim (second managed artifact) ----------------------------------

// The tmux guard shim puts `rk mux guard` (tmux_guard.go) in front of every
// PATH-resolved tmux invocation: a shim script at ~/.local/share/rk/shims/tmux
// plus a marker-owned PATH block in the user's shell startup files. Both pieces
// follow the same managed-artifact contract as the hooks merge: idempotent
// replace-in-place, diff + consent before writing, exact removal on
// --uninstall, and rk never touches a file (or file region) it does not own.

// tmuxGuardBlockBegin/End delimit the marker-owned PATH block. The lines are
// the ownership markers: re-install replaces exactly the region between them
// (inclusive), and --uninstall removes exactly that region.
const (
	tmuxGuardBlockBegin = "# >>> rk tmux guard >>>"
	tmuxGuardBlockEnd   = "# <<< rk tmux guard <<<"
)

// tmuxGuardPathBlock is the full marker-owned block appended to shell startup
// files. It prepends the rk shims dir to PATH so the shim shadows the real
// tmux. Nothing in it is user-interpolated ($HOME is expanded by the shell at
// source time, deliberately — the block is home-relocatable).
const tmuxGuardPathBlock = tmuxGuardBlockBegin + "\n" +
	`export PATH="$HOME/.local/share/rk/shims:$PATH"` + "\n" +
	tmuxGuardBlockEnd + "\n"

// tmuxShimPath is the installed shim location for a given home.
func tmuxShimPath(home string) string {
	return filepath.Join(rkShimsDir(home), "tmux")
}

// tmuxGuardStartupFiles returns the shell startup files the PATH block is
// managed in: .zshenv (read by every zsh, including the non-interactive
// shells agent Bash tools spawn) and ~/.bashrc always — both safe to create —
// plus ~/.bash_profile only when it already exists. Creating a NEW
// .bash_profile would make login bash skip ~/.profile (bash reads only the
// first of .bash_profile/.bash_login/.profile), silently breaking a user's
// existing setup; appending to one the user already has is side-effect-free.
//
// zdotdir is the caller's $ZDOTDIR (threaded as a parameter so tests stay
// hermetic over temp dirs, mirroring the injected home). When it is non-empty,
// zsh reads $ZDOTDIR/.zshenv and NEVER ~/.zshenv — writing the home copy there
// would report success while the zsh half of the install stays inert. Empty
// zdotdir falls back to the home dir (zsh's own default).
func tmuxGuardStartupFiles(home, zdotdir string) []string {
	zshenvDir := home
	if zdotdir != "" {
		zshenvDir = zdotdir
	}
	files := []string{
		filepath.Join(zshenvDir, ".zshenv"),
		filepath.Join(home, ".bashrc"),
	}
	bashProfile := filepath.Join(home, ".bash_profile")
	if _, err := os.Stat(bashProfile); err == nil {
		files = append(files, bashProfile)
	}
	return files
}

// markerBlockBounds locates the marker-owned region in lines: the begin line
// through the first end line below it, inclusive, matched whitespace-trimmed.
// found reports whether a begin marker exists. Two shapes are MALFORMED — the
// region's extent is unknowable, so callers MUST refuse to modify the file
// rather than assume ownership of user lines:
//   - a begin marker with no end marker below it (claiming begin→EOF would
//     destroy every user line after the marker), and
//   - a second begin marker before the end marker (a stray/duplicated begin
//     line — claiming first-begin→end would destroy every user line between
//     the two begins).
func markerBlockBounds(lines []string, begin, end string) (start, stop int, found bool, err error) {
	for i, line := range lines {
		if strings.TrimSpace(line) != begin {
			continue
		}
		for j := i + 1; j < len(lines); j++ {
			switch strings.TrimSpace(lines[j]) {
			case end:
				return i, j, true, nil
			case begin:
				return 0, 0, false, fmt.Errorf("marker block %q begins again before its end marker %q — the block is malformed", begin, end)
			}
		}
		return 0, 0, false, fmt.Errorf("marker block %q has no end marker %q — the block is malformed", begin, end)
	}
	return 0, 0, false, nil
}

// removeMarkerBlock returns content with the marker-owned region (the begin
// line through the end line, inclusive) removed. Marker lines are matched
// whitespace-trimmed. Content without the begin marker is returned unchanged;
// a malformed block (begin without end, or a second begin before the end) is
// an error — rk never claims a region whose extent it cannot know.
func removeMarkerBlock(content, begin, end string) (string, error) {
	lines := strings.Split(content, "\n")
	start, stop, found, err := markerBlockBounds(lines, begin, end)
	if err != nil {
		return "", err
	}
	if !found {
		return content, nil
	}
	out := append(append(make([]string, 0, len(lines)), lines[:start]...), lines[stop+1:]...)
	return strings.Join(out, "\n"), nil
}

// upsertMarkerBlock returns content carrying the marker-owned block exactly
// once. An existing block is replaced IN POSITION (never moved to EOF — a
// re-install must not hop the block past later user lines, which would change
// PATH precedence); otherwise the block is appended. The append mirrors the
// file's trailing-newline state (a file lacking a final newline gets the block
// without one) so an install → uninstall round trip is byte-exact. Re-running
// on already-current content is byte-idempotent. A malformed existing block
// (unterminated, or a duplicated begin) is an error, mirroring
// removeMarkerBlock.
func upsertMarkerBlock(content, begin, end, block string) (string, error) {
	blockLines := strings.Split(strings.TrimSuffix(block, "\n"), "\n")
	lines := strings.Split(content, "\n")
	start, stop, found, err := markerBlockBounds(lines, begin, end)
	if err != nil {
		return "", err
	}
	if found {
		out := append(make([]string, 0, len(lines)+len(blockLines)), lines[:start]...)
		out = append(out, blockLines...)
		out = append(out, lines[stop+1:]...)
		return strings.Join(out, "\n"), nil
	}
	// Append. strings.Split leaves a final "" element when content ends with a
	// newline (or is empty) — inserting the block before it keeps that trailing
	// newline; a file without one gets the block appended newline-free at the
	// end, so removal restores the original bytes exactly.
	if lines[len(lines)-1] == "" {
		out := append(make([]string, 0, len(lines)+len(blockLines)), lines[:len(lines)-1]...)
		out = append(out, blockLines...)
		out = append(out, "")
		return strings.Join(out, "\n"), nil
	}
	return strings.Join(append(lines, blockLines...), "\n"), nil
}

// applyTmuxShim installs (or --uninstall removes) the tmux guard shim: the
// shim file and the PATH block. home and zdotdir parameterize every path so
// tests run against temp dirs (zdotdir is the caller's $ZDOTDIR — see
// tmuxGuardStartupFiles).
//
// The two pieces are NOT independent on install: the PATH block is written
// only when the shim is in place (freshly written, already rk-owned, or a
// dry-run preview of that write). Wiring PATH after a declined shim write — or
// in front of a foreign marker-less file at the shim path — would put a
// non-rk executable (or nothing at all) in front of every tmux invocation.
// Uninstall keeps the pieces independent: stripping the PATH block is safe and
// wanted even when the shim file's removal was declined or skipped —
// including when the shim path could not be read (removeTmuxShimFile skips
// per-file, it never aborts the uninstall).
func applyTmuxShim(sink outputSink, reader *bufio.Reader, home, zdotdir, rkPath string, uninstall bool, cons consent) error {
	if uninstall {
		if err := removeTmuxShimFile(sink, reader, home, cons); err != nil {
			return err
		}
		return applyTmuxGuardPathBlocks(sink, reader, home, zdotdir, true, cons)
	}
	shimInPlace, err := installTmuxShimFile(sink, reader, home, rkPath, cons)
	if err != nil {
		return err
	}
	if !shimInPlace {
		sink.Notef("tmux guard: skipping the PATH block (the shim is not in place).\n")
		return nil
	}
	return applyTmuxGuardPathBlocks(sink, reader, home, zdotdir, false, cons)
}

// installTmuxShimFile writes the shim script (mode 0755) at
// ~/.local/share/rk/shims/tmux. A pre-existing marker-less file — INCLUDING a
// zero-byte one, hence the existence-aware read — is left untouched (rk only
// overwrites files it owns); an already-current shim is a reported no-op,
// except that a lost exec bit is repaired (chmod 0755) — content parity alone
// would leave a non-executable shim fronting PATH; otherwise the change is
// shown as a diff and written on consent. rkPath has
// already been validated by validateHookPath in runAgentSetup — the same
// shell-unsafe-char set applies here, since the path is embedded double-quoted
// in the script.
//
// The returned bool reports whether the shim is IN PLACE for PATH-wiring
// purposes (freshly written, already current, or a dry-run previewing the
// write); false means a foreign file or a declined write — the caller must
// not install the PATH block in front of either.
func installTmuxShimFile(sink outputSink, reader *bufio.Reader, home, rkPath string, cons consent) (bool, error) {
	shimPath := tmuxShimPath(home)
	current, exists, err := readFileIfExists(shimPath)
	if err != nil {
		return false, fmt.Errorf("tmux guard: read %s: %w", shimPath, err)
	}
	if exists && !strings.Contains(current, tmuxShimMarker) {
		// Chatter — rk only overwrites files it owns.
		sink.Notef("tmux guard: %s exists without the %q marker — leaving it untouched (rk only overwrites files it owns).\n", shimPath, tmuxShimMarker)
		return false, nil
	}
	desired := tmuxShimScript(rkPath)
	if current == desired {
		// Content being current does not prove the MODE is: an rk-owned shim
		// that lost its exec bit (a stray chmod 0644) still fronts every PATH
		// resolution, and each tmux call dies "Permission denied". Repair the
		// bit on rk's own artifact before reporting the shim in place.
		if info, statErr := os.Stat(shimPath); statErr == nil && info.Mode().Perm()&0o111 == 0 {
			if cons.dryRun {
				sink.Notef("tmux guard: dry run — %s lost its exec bit (would chmod 0755).\n", shimPath)
				return true, nil
			}
			if err := os.Chmod(shimPath, 0o755); err != nil {
				return false, fmt.Errorf("tmux guard: chmod %s: %w", shimPath, err)
			}
			sink.Notef("tmux guard: shim already installed at %s — restored its lost exec bit (chmod 0755).\n", shimPath)
			return true, nil
		}
		sink.Notef("tmux guard: shim already installed at %s — nothing to do.\n", shimPath)
		return true, nil
	}

	// The full script body renders only under --dry-run (the requested preview
	// data). Elsewhere one summary line suffices: marker-less foreign files were
	// skipped above, so this diff is only ever fresh-install or rk-owned→rk-owned
	// — the full-body dump (~135 lines) protects nothing and buries the prompt.
	if cons.dryRun {
		header := fmt.Sprintf("tmux guard: will install the tmux shim at %s", shimPath)
		renderArtifactDiff(cons.diffWriter(sink), header, strings.TrimSuffix(current, "\n"), strings.TrimSuffix(desired, "\n"))
	} else if exists {
		fmt.Fprintf(cons.diffWriter(sink), "tmux guard: will update the rk-owned tmux shim at %s.\n", shimPath)
	} else {
		fmt.Fprintf(cons.diffWriter(sink), "tmux guard: will install the tmux shim at %s (rk-owned guard script, %d lines).\n", shimPath, len(strings.Split(strings.TrimSuffix(desired, "\n"), "\n")))
	}
	ok, err := cons.authorizeWrite(sink.data, reader, "tmux guard: dry run — no shim written.", "\nWrite the tmux shim? [y/N] ")
	if err != nil {
		return false, err
	}
	if !ok {
		if cons.dryRun {
			// Nothing was written, but the dry run previews the full install —
			// report "in place" so the PATH-block preview follows, matching
			// what a consented run would do.
			return true, nil
		}
		sink.Notef("tmux guard: skipped (no shim written).\n")
		return false, nil
	}

	if err := os.MkdirAll(filepath.Dir(shimPath), 0o755); err != nil {
		return false, fmt.Errorf("tmux guard: create %s: %w", filepath.Dir(shimPath), err)
	}
	if err := os.WriteFile(shimPath, []byte(desired), 0o755); err != nil {
		return false, fmt.Errorf("tmux guard: write %s: %w", shimPath, err)
	}
	// WriteFile's perm applies only on create — an existing marker-owned file
	// keeps its old mode, so re-assert the exec bit explicitly.
	if err := os.Chmod(shimPath, 0o755); err != nil {
		return false, fmt.Errorf("tmux guard: chmod %s: %w", shimPath, err)
	}
	sink.Notef("tmux guard: wrote %s.\n", shimPath)
	return true, nil
}

// removeTmuxShimFile removes a marker-owned shim on --uninstall. An absent
// shim is silent (a machine that never installed it must see zero output); a
// marker-less file is left untouched with a skip note; a file that cannot be
// READ (unreadable, or a directory occupying its path) is likewise skipped
// with a note rather than aborting — ownership is unknowable, and hard-failing
// here would leave the PATH blocks in place, wiring PATH at a file rk cannot
// vouch for; a marker-owned shim is removed on consent. The shims dir is
// pruned afterwards if empty (best effort).
func removeTmuxShimFile(sink outputSink, reader *bufio.Reader, home string, cons consent) error {
	shimPath := tmuxShimPath(home)
	current, exists, err := readFileIfExists(shimPath)
	if err != nil {
		sink.Notef("tmux guard: %s: cannot read (%v) — leaving it untouched and continuing with the PATH blocks (repair or remove it by hand, then re-run).\n", shimPath, err)
		return nil
	}
	if !exists {
		return nil
	}
	// A marker-less file — including a zero-byte one (existence, not content,
	// is what makes it the user's) — is never removed.
	if !strings.Contains(current, tmuxShimMarker) {
		sink.Notef("tmux guard: %s was rewritten without the %q marker — leaving it untouched (rk only removes files it owns).\n", shimPath, tmuxShimMarker)
		return nil
	}

	sink.Notef("tmux guard: found the tmux shim at %s.\n\n", shimPath)
	promptSuffix := fmt.Sprintf("Remove %s? [y/N] ", shimPath)
	ok, err := cons.authorizeWrite(sink.data, reader, "tmux guard: dry run — shim left in place (nothing removed).", promptSuffix)
	if err != nil {
		return err
	}
	if !ok {
		if !cons.dryRun {
			sink.Notef("tmux guard: shim left in place (nothing removed).\n")
		}
		return nil
	}

	if err := os.Remove(shimPath); err != nil {
		return fmt.Errorf("tmux guard: remove %s: %w", shimPath, err)
	}
	// Prune the now-possibly-empty shims dir; os.Remove refuses non-empty
	// directories, so this can never delete anything else (best effort).
	_ = os.Remove(filepath.Dir(shimPath))
	sink.Notef("tmux guard: removed %s.\n", shimPath)
	return nil
}

// applyTmuxGuardPathBlocks upserts (install) or strips (uninstall) the
// marker-owned PATH block in each startup file, one diff + consent per file.
// A file already in the desired state is a no-op: silently skipped on
// uninstall (absence needs no narration), reported on install. A file whose
// marker block is malformed (begin without end) — or that cannot be READ at
// all (unreadable, or a directory occupying its path) — is refused with a
// skip note: rk cannot know what it would be modifying, so it touches nothing
// there and moves on to the other files (an unreadable ~/.zshenv must not
// stop ~/.bashrc from being processed). New files are created 0644; existing
// files keep their content around the block and their mode.
func applyTmuxGuardPathBlocks(sink outputSink, reader *bufio.Reader, home, zdotdir string, uninstall bool, cons consent) error {
	for _, path := range tmuxGuardStartupFiles(home, zdotdir) {
		current, err := readSkill(path)
		if err != nil {
			sink.Notef("tmux guard: %s: cannot read (%v) — leaving the file untouched and continuing with the other startup files.\n", path, err)
			continue
		}
		var next string
		var blockErr error
		if uninstall {
			next, blockErr = removeMarkerBlock(current, tmuxGuardBlockBegin, tmuxGuardBlockEnd)
		} else {
			next, blockErr = upsertMarkerBlock(current, tmuxGuardBlockBegin, tmuxGuardBlockEnd, tmuxGuardPathBlock)
		}
		if blockErr != nil {
			sink.Notef("tmux guard: %s: %v — leaving the file untouched (repair or remove the block by hand, then re-run).\n", path, blockErr)
			continue
		}
		if next == current {
			if !uninstall {
				sink.Notef("tmux guard: PATH block already present in %s — nothing to do.\n", path)
			}
			continue
		}

		// The whole-file current+next render survives only under --dry-run —
		// startup files are USER-authored, and echoing their full content back
		// for a 3-line owned block is the worst of the three dumps. The honest
		// unit of change is exactly the marker-owned block (upsertMarkerBlock
		// replaces in position or appends; removeMarkerBlock strips exactly it),
		// so the summary shows that block and where it lands.
		if cons.dryRun {
			action := "add"
			if uninstall {
				action = "remove"
			}
			header := fmt.Sprintf("tmux guard: will %s the rk tmux guard PATH block in %s", action, path)
			renderArtifactDiff(cons.diffWriter(sink), header, current, next)
		} else if uninstall {
			fmt.Fprintf(cons.diffWriter(sink), "tmux guard: will remove the %d-line rk tmux guard PATH block from %s.\n", strings.Count(tmuxGuardPathBlock, "\n"), path)
		} else {
			// Placement uses the SAME detection upsertMarkerBlock acts on
			// (markerBlockBounds' trimmed-line match), so the wording can never
			// disagree with what the write does; a substring-based check could
			// (e.g. the marker appearing inside a non-marker line). The error
			// case is unreachable — a malformed block already hit blockErr above.
			placement := "appended at end"
			if _, _, found, _ := markerBlockBounds(strings.Split(current, "\n"), tmuxGuardBlockBegin, tmuxGuardBlockEnd); found {
				placement = "replaced in position"
			}
			out := cons.diffWriter(sink)
			fmt.Fprintf(out, "tmux guard: will add the rk tmux guard PATH block in %s (%s):\n", path, placement)
			for _, line := range strings.Split(strings.TrimSuffix(tmuxGuardPathBlock, "\n"), "\n") {
				fmt.Fprintf(out, "  %s\n", line)
			}
		}
		dryRunNote := fmt.Sprintf("tmux guard: dry run — %s not modified.", path)
		ok, err := cons.authorizeWrite(sink.data, reader, dryRunNote, "\nWrite these changes? [y/N] ")
		if err != nil {
			return err
		}
		if !ok {
			if !cons.dryRun {
				sink.Notef("tmux guard: skipped %s (no changes written).\n", path)
			}
			continue
		}

		mode := os.FileMode(0o644)
		if info, statErr := os.Stat(path); statErr == nil {
			mode = info.Mode().Perm()
		}
		// $ZDOTDIR may name a directory that does not exist yet (a common
		// dotfiles setup) — create it so the write cannot ENOENT-abort the
		// run. Deliberately after consent: dry-run and declined prompts must
		// leave the filesystem untouched.
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return fmt.Errorf("tmux guard: create %s: %w", filepath.Dir(path), err)
		}
		if err := os.WriteFile(path, []byte(next), mode); err != nil {
			return fmt.Errorf("tmux guard: write %s: %w", path, err)
		}
		sink.Notef("tmux guard: wrote %s.\n", path)
	}
	return nil
}

// --- gui display block (third managed artifact) --------------------------------

// The gui display block puts DISPLAY (and RK_GUI_SOCKET) into shells started
// inside tmux panes by eval'ing `rk gui env` at shell start. That is read-time
// derivation, never a push (Constitution §X): the display is the supervisor's
// @rk_gui_display stamp, already served by `rk gui env`, so nothing is stored
// in the file and turning the GUI on later needs no re-setup — the block is
// inert while off (`rk gui env` prints nothing and exits 1, so eval "" is a
// no-op). It lives in the SAME startup files as the guard PATH block
// (tmuxGuardStartupFiles) and reuses the PATH block's entire flow.
//
// The artifact is split in two, exactly like the tmux guard's PATH block and
// shim: a HOST-INDEPENDENT block in the startup files, and a PER-MACHINE
// pointer under ~/.local/share/rk/ that carries the absolute rk path. Startup
// files are commonly dotfile-synced across hosts whose Homebrew prefixes
// differ (/opt/homebrew vs /home/linuxbrew/.linuxbrew), so a block embedding
// the host path can never converge — every re-run on either host rewrote the
// other's block. A synced file may carry only relocatable content.

// guiDisplayBlockBegin/End delimit the marker-owned gui display block — the
// ownership contract of the other marker blocks: re-install replaces exactly
// the region between them, --uninstall removes exactly it, and a malformed
// region is refused. The marker TEXT is frozen — it matches blocks already
// installed on user machines, which is how the old absolute-path body is
// found and replaced in position.
const (
	guiDisplayBlockBegin = "# >>> rk gui display >>>"
	guiDisplayBlockEnd   = "# <<< rk gui display <<<"
)

// guiPointerShellPath is the pointer's path as the BLOCK spells it: $HOME is
// expanded by the shell at source time (deliberately — the block is
// home-relocatable), and the relative tail is the same constant the Go side
// resolves through guiPointerPath, so the two can never disagree.
const guiPointerShellPath = `"$HOME/` + rkBinRelDir + `/run-kit"`

// guiDisplayBlock is the full marker-owned block. Nothing in it is
// interpolated — it is byte-identical on every host, so a dotfile-synced
// startup file converges and re-runs are the "already present" no-op. The
// guards are load-bearing: $TMUX_PANE scopes the eval to tmux panes (the same
// gate the installed agent hooks use); ${DISPLAY-} keeps a real X session's
// DISPLAY (desktop Linux, SSH X-forwarding) untouched and skips the exec in
// nested shells; -x on the pointer keeps a missing or dangling pointer silent
// by construction (one stat per shell start) rather than by relying on the
// redirection to swallow the shell's exec-failure message; stderr is
// discarded so an off/unreachable GUI stays silent.
const guiDisplayBlock = guiDisplayBlockBegin + "\n" +
	`[ -n "$TMUX_PANE" ] && [ -z "${DISPLAY-}" ] && [ -x ` + guiPointerShellPath + ` ] && eval "$(` + guiPointerShellPath + ` gui env 2>/dev/null)"` + "\n" +
	guiDisplayBlockEnd + "\n"

// guiPointerPath is the per-machine pointer: a symlink at
// ~/.local/share/rk/bin/run-kit whose target is the
// resolveRkPath/validateHookPath-validated absolute rk path. The bin dir is a
// sibling of the shims dir and MUST stay off PATH: resolveRkPath prefers
// exec.LookPath("run-kit"), so a pointer on PATH would resolve to itself on
// the next re-run and the link would loop. rk only ever writes a symlink
// here, so "is a symlink" is the ownership test — a regular file or directory
// at this path is the user's and is never touched.
func guiPointerPath(home string) string {
	return selfpath.LauncherFor(home)
}

// applyGuiDisplayBlocks installs (the gated block upsert, gated on the launcher
// step's verdict) or uninstalls (block strip, then pointer removal) the gui
// display artifact.
// Install gating mirrors the PATH block ↔ shim rule, for the same reason: a
// block that execs the pointer path in front of a foreign file would run a
// non-rk executable from every pane shell's startup, and in front of nothing
// it would be silently inert — so the block is written only when the pointer
// is in place (freshly linked, already current, or a dry-run previewing the
// link). The gate must hold on RE-install too: a foreign non-symlink at the
// pointer path is untrusted, so any block a previous install left behind is
// stripped (the block's own -x check would pass on the foreign file). A
// declined write is different — the pointer there is still an rk-owned
// symlink, stale or dangling, so an existing block stays. The block is
// independent of the tmux SHIM's outcome. Uninstall keeps the pieces
// independent: a declined pointer removal never skips the block strip and
// vice versa. The strip runs first so a shell starting mid-uninstall never
// execs a vanished target (the -x guard covers the window anyway).
func applyGuiDisplayBlocks(sink outputSink, reader *bufio.Reader, home, zdotdir string, pointerState guiPointerState, uninstall bool, cons consent) error {
	if uninstall {
		if err := applyGuiDisplayStartupBlocks(sink, reader, home, zdotdir, true, cons); err != nil {
			return err
		}
		return removeLauncherPointer(sink, reader, home, cons)
	}
	switch pointerState {
	case guiPointerInPlace:
		return applyGuiDisplayStartupBlocks(sink, reader, home, zdotdir, false, cons)
	case guiPointerForeign:
		sink.Notef("gui display: skipping the startup-file block (the pointer is not in place).\n")
		return applyGuiDisplayStartupBlocks(sink, reader, home, zdotdir, true, cons)
	default:
		sink.Notef("gui display: skipping the startup-file block (the pointer is not in place).\n")
		return nil
	}
}

// guiPointerState is installLauncherPointer's verdict on the pointer path,
// for block-writing purposes.
type guiPointerState int

const (
	// guiPointerDeclined: the user declined the link/relink (or an rk-owned
	// symlink could not be written). Whatever is at the path is still rk's.
	guiPointerDeclined guiPointerState = iota
	// guiPointerInPlace: freshly linked, already current, or a dry-run
	// previewing the link — safe to write the block.
	guiPointerInPlace
	// guiPointerForeign: a non-symlink occupies the path; rk never touches
	// it and a block must not exec it.
	guiPointerForeign
)

// installLauncherPointer links the launcher path → target (the resolved Cellar
// binary — EvalSymlinks of the validated stable path, so the launcher stays
// live while brew's stable symlink dangles mid-upgrade). An already-current
// symlink is a reported no-op; a symlink with any other target (a moved
// install, a dangling brew-rename leftover, an older rk install's stable-path
// target) is relinked on consent; a
// non-symlink at the path is foreign and left untouched. The link is replaced
// atomically (temp symlink in the same dir + rename) so a shell starting
// mid-update never sees a missing pointer, and the bin dir is created only
// AFTER consent so dry-run and declined prompts leave the filesystem
// untouched. target has already been validated by validateHookPath.
//
// The returned state tells the caller whether a block may be written
// (guiPointerInPlace), must be withheld but an existing one left alone
// (guiPointerDeclined), or must be withheld AND an existing one stripped
// (guiPointerForeign).
func installLauncherPointer(sink outputSink, reader *bufio.Reader, home, target string, cons consent) (guiPointerState, error) {
	linkPath := guiPointerPath(home)
	current, exists, foreign, err := guiPointerProbe(linkPath)
	if err != nil {
		return guiPointerDeclined, err
	}
	if foreign {
		sink.Notef("launcher: %s exists and is not a symlink — leaving it untouched (rk only replaces pointers it owns).\n", linkPath)
		return guiPointerForeign, nil
	}
	if exists && current == target {
		sink.Notef("launcher: pointer already links %s -> %s — nothing to do.\n", linkPath, target)
		return guiPointerInPlace, nil
	}

	out := cons.diffWriter(sink)
	if exists {
		fmt.Fprintf(out, "launcher: will relink %s -> %s (currently -> %s).\n", linkPath, target, current)
	} else {
		fmt.Fprintf(out, "launcher: will link %s -> %s.\n", linkPath, target)
	}
	dryRunNote := fmt.Sprintf("launcher: dry run — %s not written.", linkPath)
	ok, err := cons.authorizeWrite(sink.data, reader, dryRunNote, "\nWrite the pointer? [y/N] ")
	if err != nil {
		return guiPointerDeclined, err
	}
	if !ok {
		if cons.dryRun {
			// Nothing was written, but the dry run previews the full install —
			// report "in place" so the block preview follows, matching what a
			// consented run would do (the shim's dry-run posture).
			return guiPointerInPlace, nil
		}
		sink.Notef("launcher: skipped (no pointer written).\n")
		return guiPointerDeclined, nil
	}

	// Re-probe right before the write: the prompt above may have been pending
	// for a while, and rename would clobber whatever now sits at the path. A
	// non-symlink that appeared meanwhile is the user's — refuse, never replace.
	// A symlink whose state moved meanwhile (a concurrent rk re-pointing the
	// launcher mid-upgrade) wins too: committing the stale target captured
	// before the prompt could re-pin an old or already-deleted keg.
	freshCurrent, freshExists, foreign, err := guiPointerProbe(linkPath)
	if err != nil {
		return guiPointerDeclined, err
	}
	switch {
	case foreign:
		sink.Notef("launcher: %s changed to a non-symlink while the prompt was pending — leaving it untouched (rk only replaces pointers it owns).\n", linkPath)
		return guiPointerForeign, nil
	case !freshExists && exists:
		sink.Notef("launcher: %s was removed while the prompt was pending — leaving it absent.\n", linkPath)
		return guiPointerDeclined, nil
	case freshExists && freshCurrent == target:
		sink.Notef("launcher: pointer already links %s -> %s — nothing to do.\n", linkPath, target)
		return guiPointerInPlace, nil
	case freshExists && freshCurrent != current:
		sink.Notef("launcher: %s was re-pointed while the prompt was pending (now -> %s) — leaving the newer pointer untouched.\n", linkPath, freshCurrent)
		return guiPointerInPlace, nil
	}
	if err := os.MkdirAll(filepath.Dir(linkPath), 0o755); err != nil {
		return guiPointerDeclined, fmt.Errorf("launcher: create %s: %w", filepath.Dir(linkPath), err)
	}
	if err := selfpath.ReplaceSymlink(target, linkPath); err != nil {
		return guiPointerDeclined, fmt.Errorf("launcher: link %s: %w", linkPath, err)
	}
	sink.Notef("launcher: linked %s -> %s.\n", linkPath, target)
	return guiPointerInPlace, nil
}

// guiPointerProbe classifies what sits at the pointer path: absent
// (exists=false), an rk-owned symlink (exists=true, target in current), or a
// foreign non-symlink (foreign=true). Lstat, never Stat — a dangling symlink
// is still rk's.
func guiPointerProbe(linkPath string) (current string, exists, foreign bool, err error) {
	info, err := os.Lstat(linkPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", false, false, nil
		}
		return "", false, false, fmt.Errorf("launcher: stat %s: %w", linkPath, err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		return "", true, true, nil
	}
	current, err = os.Readlink(linkPath)
	if err != nil {
		return "", true, false, fmt.Errorf("launcher: readlink %s: %w", linkPath, err)
	}
	return current, true, false, nil
}

// removeLauncherPointer removes an rk-owned pointer on --uninstall. An
// absent pointer is silent (a machine that never installed it must see zero
// output); a non-symlink at the path is left untouched with a note; a symlink
// is removed on consent, and the bin dir is pruned afterwards if empty (best
// effort — os.Remove refuses non-empty directories, and the prune runs only
// when the parent is a REAL directory: a user's symlink named bin/ would
// otherwise be removed as an ordinary entry).
func removeLauncherPointer(sink outputSink, reader *bufio.Reader, home string, cons consent) error {
	linkPath := guiPointerPath(home)
	info, err := os.Lstat(linkPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		sink.Notef("launcher: %s: cannot stat (%v) — leaving it untouched (repair or remove it by hand, then re-run).\n", linkPath, err)
		return nil
	}
	if info.Mode()&os.ModeSymlink == 0 {
		sink.Notef("launcher: %s is not a symlink — leaving it untouched (rk only removes pointers it owns).\n", linkPath)
		return nil
	}

	sink.Notef("launcher: found the rk pointer at %s.\n\n", linkPath)
	promptSuffix := fmt.Sprintf("Remove %s? [y/N] ", linkPath)
	ok, err := cons.authorizeWrite(sink.data, reader, "launcher: dry run — pointer left in place (nothing removed).", promptSuffix)
	if err != nil {
		return err
	}
	if !ok {
		if !cons.dryRun {
			sink.Notef("launcher: pointer left in place (nothing removed).\n")
		}
		return nil
	}
	if err := os.Remove(linkPath); err != nil {
		return fmt.Errorf("launcher: remove %s: %w", linkPath, err)
	}
	if fi, err := os.Lstat(filepath.Dir(linkPath)); err == nil && fi.IsDir() {
		_ = os.Remove(filepath.Dir(linkPath))
	}
	sink.Notef("launcher: removed %s.\n", linkPath)
	return nil
}

// applyGuiDisplayStartupBlocks upserts (install) or strips (uninstall) the
// marker-owned gui display block in each startup file, one diff + consent per
// file — the applyTmuxGuardPathBlocks flow verbatim: per-file tolerant read,
// malformed-block refusal with a skip note, "already present" no-op note on
// install, silence on uninstall when absent, full diff on --dry-run (a
// one-line summary plus the block lines otherwise), consent through
// authorizeWrite, and a mode-preserving write with the parent MkdirAll'd only
// after consent.
func applyGuiDisplayStartupBlocks(sink outputSink, reader *bufio.Reader, home, zdotdir string, uninstall bool, cons consent) error {
	block := guiDisplayBlock
	for _, path := range tmuxGuardStartupFiles(home, zdotdir) {
		current, err := readSkill(path)
		if err != nil {
			sink.Notef("gui display: %s: cannot read (%v) — leaving the file untouched and continuing with the other startup files.\n", path, err)
			continue
		}
		var next string
		var blockErr error
		if uninstall {
			next, blockErr = removeMarkerBlock(current, guiDisplayBlockBegin, guiDisplayBlockEnd)
		} else {
			next, blockErr = upsertMarkerBlock(current, guiDisplayBlockBegin, guiDisplayBlockEnd, block)
		}
		if blockErr != nil {
			sink.Notef("gui display: %s: %v — leaving the file untouched (repair or remove the block by hand, then re-run).\n", path, blockErr)
			continue
		}
		if next == current {
			if !uninstall {
				sink.Notef("gui display: block already present in %s — nothing to do.\n", path)
			}
			continue
		}

		// The honest unit of change is exactly the marker-owned block: the full
		// file bodies render only under --dry-run (the requested preview);
		// elsewhere the summary shows the block and where it lands.
		if cons.dryRun {
			action := "add"
			if uninstall {
				action = "remove"
			}
			header := fmt.Sprintf("gui display: will %s the rk gui display block in %s", action, path)
			renderArtifactDiff(cons.diffWriter(sink), header, current, next)
		} else if uninstall {
			fmt.Fprintf(cons.diffWriter(sink), "gui display: will remove the %d-line rk gui display block from %s.\n", strings.Count(block, "\n"), path)
		} else {
			// Placement uses the SAME detection upsertMarkerBlock acts on (see
			// the PATH block's wording note); the error case is unreachable — a
			// malformed block already hit blockErr above.
			placement := "appended at end"
			if _, _, found, _ := markerBlockBounds(strings.Split(current, "\n"), guiDisplayBlockBegin, guiDisplayBlockEnd); found {
				placement = "replaced in position"
			}
			out := cons.diffWriter(sink)
			fmt.Fprintf(out, "gui display: will add the rk gui display block in %s (%s):\n", path, placement)
			for _, line := range strings.Split(strings.TrimSuffix(block, "\n"), "\n") {
				fmt.Fprintf(out, "  %s\n", line)
			}
		}
		dryRunNote := fmt.Sprintf("gui display: dry run — %s not modified.", path)
		ok, err := cons.authorizeWrite(sink.data, reader, dryRunNote, "\nWrite these changes? [y/N] ")
		if err != nil {
			return err
		}
		if !ok {
			if !cons.dryRun {
				sink.Notef("gui display: skipped %s (no changes written).\n", path)
			}
			continue
		}

		mode := os.FileMode(0o644)
		if info, statErr := os.Stat(path); statErr == nil {
			mode = info.Mode().Perm()
		}
		// $ZDOTDIR may name a directory that does not exist yet — created after
		// consent so dry-run and declined prompts leave the filesystem untouched.
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return fmt.Errorf("gui display: create %s: %w", filepath.Dir(path), err)
		}
		if err := os.WriteFile(path, []byte(next), mode); err != nil {
			return fmt.Errorf("gui display: write %s: %w", path, err)
		}
		sink.Notef("gui display: wrote %s.\n", path)
	}
	return nil
}

// --- generic JSON helpers -------------------------------------------------------

// asMap returns v as a map[string]any, or nil if it is not one.
func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// asSlice returns v as a []any, or nil if it is not one.
func asSlice(v any) []any {
	s, _ := v.([]any)
	return s
}

// cloneJSONMap deep-copies a JSON-shaped map (objects/arrays/scalars) via a
// marshal round-trip, so mutating the clone never touches the original (used to
// compute the "proposed" side of the diff without disturbing "current").
func cloneJSONMap(m map[string]any) map[string]any {
	data, err := json.Marshal(m)
	if err != nil {
		return map[string]any{}
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil || out == nil {
		return map[string]any{}
	}
	return out
}

// mustMarshalIndent renders a settings map as stable, indented JSON for the diff
// (map keys are sorted by encoding/json, so output is deterministic).
func mustMarshalIndent(m map[string]any) string {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return fmt.Sprintf("<unmarshalable: %v>", err)
	}
	return string(data)
}
