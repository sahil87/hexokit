// Package riff is the extracted spawn engine behind `rk riff` and the web-UI
// spawn endpoint (POST /api/riff). It creates a git worktree via `wt`, opens a
// tmux window rooted in it, and launches one or more agent/shell panes in a
// multi-pane layout, with presets, named layouts, and parallel fan-out.
//
// The engine is parameterized by EXPLICIT targets — a tmux server label, a
// target session, and a repo root — instead of the ambient `$TMUX` /
// process-cwd state the CLI used to rely on. On the daemon path the session is
// used to scope every window op (`-L <server>` selects the socket, and
// `-t <session>` selects which session the window is created in — a `-L`-only
// call with no attached client lands the window in the socket's ambient
// session, not the requested one). Two frontends drive it:
//
//   - The CLI (cmd/rk/riff.go) derives its targets from $TMUX + process cwd and
//     calls the engine with an EMPTY server label — meaning "target the user's
//     current tmux server via the restored $TMUX env" (EffectiveSpec.OriginalTMUX,
//     sourced from internal/tmux.OriginalTMUX), preserving byte-identical behavior.
//   - The HTTP handler (api/riff.go) derives its targets from the request +
//     target session and calls the engine with a NON-EMPTY server label —
//     meaning "target that tmux server via a `-L <server>` argv prefix" (the
//     daemon's cwd is not the target repo, so RepoRoot is passed explicitly and
//     `wt create` / `fab agent -o yaml` run with their Dir set to it).
//
// Security (constitution §I): every subprocess is an argv-slice
// exec.CommandContext with an explicit timeout — no shell strings. The only
// argv element subject to user input is the trailing tmux shell string, whose
// task/skill component is single-quote-escaped via internal/shellq; the
// launcher itself (resolved from fab-kit's committed fab/project/config.yaml) is
// the documented shell-expansion exception.
package riff

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"rk/internal/settings"
	"rk/internal/tmux"
)

// Subprocess timeouts — `wt create` is the slowest step (matches constitution
// §Process Execution's 30s build-op guidance); tmux and fab operations are
// cheap. FabTimeout bounds each `fab agent` launcher-resolution call.
const (
	WtTimeout        = 30 * time.Second
	TmuxTimeout      = 10 * time.Second
	FabTimeout       = 10 * time.Second
	DefaultRiffSkill = settings.RiffDiscussSkill // the built-in `discuss` preset's value — one source for the bare `rk riff` default
	DefaultLauncher  = "claude --dangerously-skip-permissions"
)

// Exit code discipline — the CLI maps these to os.Exit codes; the HTTP handler
// maps them to status codes (by constant IDENTITY, not numeric value — see
// riffStatusForError). See ExitCodeError.
//
// The numeric values conform to the shll toolkit exit-code convention
// (Principle 4): 1 = operational failure, 2 = usage error, 3 = the documented
// subprocess class. ExitValidation (usage: bad flags/args/preset/layout/count)
// is 2; ExitPrecondition (operational: $TMUX unset, wt missing) is 1.
const (
	ExitValidation   = 2 // usage: unknown layout, invalid count, unknown/conflicting preset (CLI flag-parse errors are tagged usageError in cmd/rk/riff.go, not emitted here)
	ExitPrecondition = 1 // operational: $TMUX unset, wt not on PATH (CLI-only preconditions)
	ExitSubprocess   = 3 // operational: wt/tmux non-zero exit, output parse failure, timeouts
)

// ExitCodeError signals a specific non-zero exit/status class. The CLI's RunE
// wrapper inspects Code and calls os.Exit(Code); the HTTP handler maps Code
// (e.g. ExitValidation → 400) to a status. Exported so both frontends can
// classify engine failures without re-parsing error strings.
type ExitCodeError struct {
	Code int
	Msg  string
}

func (e *ExitCodeError) Error() string { return e.Msg }

// ValidationErr / SubprocessErr are constructors for the two engine-produced
// failure classes. Preconditions ($TMUX, wt-on-PATH) stay CLI-side.
func ValidationErr(format string, a ...any) error {
	return &ExitCodeError{Code: ExitValidation, Msg: fmt.Sprintf(format, a...)}
}

func SubprocessErr(format string, a ...any) error {
	return &ExitCodeError{Code: ExitSubprocess, Msg: fmt.Sprintf(format, a...)}
}

// PaneSpec is one pane in the ordered pane list. Kind dispatches how Value is
// interpreted (skill → launcher pane; cmd → shell pane). Empty Value means
// "bare" (bare launcher / bare $SHELL).
type PaneSpec struct {
	Kind  string // PaneKindSkill or PaneKindCmd
	Value string
}

// Pane-kind constants for PaneSpec.Kind, riff-owned (the engine's single
// source of truth).
const (
	PaneKindSkill = "skill"
	PaneKindCmd   = "cmd"
)

// EffectiveSpec is the fully-resolved plan for spawning riff windows on a
// target. Server/RepoRoot are the explicit targeting inputs; OriginalTMUX (used
// only when Server is empty) restores the CLI caller's $TMUX so bare tmux calls
// reach the user's current server.
type EffectiveSpec struct {
	Panes       []PaneSpec
	Layout      string   // canonical name, or "" for single-pane / explicit single-pane no-op
	Count       int      // number of parallel worktree/window pairs (≥ 1)
	Passthrough []string // forwarded to wt create
	Launcher    string
	Server      string // tmux server label; "" → target current server via OriginalTMUX
	// Session is the tmux session the window is created in (daemon path). When
	// non-empty, tmux window operations are session-scoped: `new-window -t
	// <session>`, `split-window`/`select-layout` target `<session>:<window>`, and
	// the collision probe reads `list-windows -t <session>`. Empty (the CLI path)
	// leaves every call unscoped so the ambient/attached session is targeted —
	// byte-identical to pre-session behavior.
	Session      string
	RepoRoot     string // working dir for `wt create` / `fab agent -o yaml`; may be "" for the CLI (process cwd)
	OriginalTMUX string // restored into child env when Server == "" (CLI path)
	// SkillPrefix is the resolved agent's skill-invocation prefix (`/` or `$`),
	// consumed exactly once by ApplySkillPrefix at the spec-finalization seam —
	// composition (taskPaneShellString/paneShellString) and typed delivery read
	// the already-rendered pane values and never see this field. Empty behaves
	// as "/" (specs built without resolution stay byte-identical).
	SkillPrefix string
	// Where selects isolation: "checkout" opens the window directly in RepoRoot
	// (no worktree); "worktree" (or "", the default) creates a worktree via wt
	// first. The CLI never sets this, so it is always the worktree default there.
	Where string
	// WorktreeName, when non-empty in worktree mode, is forwarded to
	// `wt create --worktree-name`. Empty = wt generates the name (today's path).
	// Ignored in checkout mode. The CLI never sets this.
	WorktreeName string
	// WindowNameBase, when non-empty, replaces the derived `riff-<basename>`
	// window-name base (the collision suffixing in resolveWindowName still
	// applies). Empty = today's derivation. The CLI never sets this.
	//
	// There is deliberately NO ResumeSessionRef/ResumePlain here: the fork ref is
	// consumed at the launcher seam in Spawn (folded into Launcher via
	// resumeForkLauncher) and nothing downstream of the spec reads it, so a spec
	// copy would be write-only provenance — the same reason Tier lives on Options
	// only.
	WindowNameBase string
}

// Result is the outcome of a single spawned window, returned by Spawn for the
// HTTP handler to build its response.
type Result struct {
	Server     string
	Session    string
	WindowName string
	// WindowID is the tmux window id (@N) of the created window, resolved
	// after new-window from the captured pane's window.
	WindowID string
	// PaneID is the captured pane-0 id (%N) — the typed task-delivery target.
	PaneID string
}

// Options are the HTTP handler's inputs for a single (count=1) spawn.
type Options struct {
	Server   string // tmux server label (non-empty for the daemon path)
	Session  string // target session the window is created in (scopes tmux window ops)
	RepoRoot string // repo root for wt create / launcher resolution (required)
	Task     string // optional task text → launcher positional arg (auto-submits)
	Preset   string // optional preset name from run-kit's riff_presets (built-ins + user)
	// Where selects isolation: "checkout" opens the window directly in RepoRoot
	// (no worktree); "worktree" or "" (default) creates a worktree first.
	Where string
	// WorktreeName, when non-empty in worktree mode, names the created worktree
	// (`wt create --worktree-name`). Empty = wt auto-generates. Ignored in
	// checkout mode.
	WorktreeName string
	// Tier is the fab agent tier resolved for the launcher (`fab agent <tier>
	// -o yaml`). Empty = the default tier (`fab agent -o yaml`, today's path).
	Tier string
	// ResumeSessionRef identifies the conversation to fork (or resume with
	// ResumePlain). Validated again at the launcher composition seam.
	ResumeSessionRef string
	// ForkProvider pins a conversation fork to its source provider. When the
	// configured launcher differs, use the provider executable with its own
	// defaults. Empty preserves existing resume consumers' launcher validation.
	ForkProvider string
	// ResumePlain reattaches a Claude conversation under the same session ID
	// using --resume. False selects a fork. Incompatible with ForkProvider.
	ResumePlain bool
	// WindowNameBase, when non-empty, replaces the derived `riff-<basename>`
	// window-name base — the fork endpoint passes `<sourceWindowName>-fork`. The
	// existing resolveWindowName collision suffixing (-2, -3, …) still applies.
	// Empty = today's path-derived base. The CLI never sets this.
	WindowNameBase string
}

// isCheckout reports whether opts requests checkout (non-isolated) mode.
func (o Options) isCheckout() bool { return o.Where == whereCheckout }

// Where values for Options.Where / EffectiveSpec.Where.
const (
	whereWorktree = "worktree"
	whereCheckout = "checkout"
)

// loadRiffPresets is the preset-source seam (production: the settings-backed
// merged view) — tests inject a fixed table without touching the config root.
var loadRiffPresets = settings.LoadRiffPresets

// Spawn is the single-window entry used by the HTTP handler. It resolves the
// launcher (rooted at opts.RepoRoot), resolves the preset (if named) from
// run-kit's riff_presets (built-ins + user), composes the effective pane spec
// per the task/preset rules (R6/R7), then runs the wt+tmux spawn sequence once
// and returns the created window's identity.
//
// Pane composition:
//   - task non-empty  → a single skill pane with Task as the launcher arg
//     (replaces the preset's pane).
//   - task empty, preset → the preset's single skill pane (empty skill = bare
//     launcher).
//   - task empty, no preset → a single BARE skill pane (blank agent).
//
// Isolation (opts.Where):
//   - "worktree" (or "", default) → `wt create` (optionally --worktree-name) then
//     a tmux window rooted at the new worktree (base riff-<worktree-basename>).
//   - "checkout"                  → NO wt call; a tmux window rooted at
//     opts.RepoRoot (base riff-<repoRoot-basename>).
//
// The launcher is resolved for opts.Tier (empty = default tier). An unknown
// preset returns an ExitCodeError{Code: ExitValidation} the handler maps to 400.
// All subprocess failures return ExitCodeError{Code: ExitSubprocess}.
func Spawn(ctx context.Context, opts Options) (Result, error) {
	if opts.RepoRoot == "" {
		return Result{}, ValidationErr("run-kit riff: repo root is empty")
	}

	// Preserve configured launcher options when they match the source provider.
	// A fork must never hand a source session ID to another provider.
	agent := ResolveAgent(ctx, opts.RepoRoot, opts.Tier)
	if opts.ForkProvider != "" {
		if opts.ResumePlain || !sessionUUIDRe.MatchString(opts.ResumeSessionRef) {
			return Result{}, ValidationErr("run-kit riff: fork requires a valid session UUID and fork mode")
		}
		switch opts.ForkProvider {
		case "claude", "codex":
		default:
			return Result{}, ValidationErr("run-kit riff: unsupported fork provider %q", opts.ForkProvider)
		}
		if launcherCommandName(agent.Launcher) != opts.ForkProvider {
			agent = ResolvedAgent{Launcher: opts.ForkProvider, SkillPrefix: "/"}
			if opts.ForkProvider == "codex" {
				agent.SkillPrefix = "$"
			}
		}
	}
	// Older resume consumers carry Claude IDs without an explicit provider.
	if opts.ForkProvider == "" && sessionUUIDRe.MatchString(opts.ResumeSessionRef) && launcherCommandName(agent.Launcher) != "claude" {
		return Result{}, ValidationErr("run-kit riff: cannot resume a Claude conversation with launcher %q", agent.Launcher)
	}
	launcher, err := resumeForkLauncher(agent.Launcher, opts.ResumeSessionRef, opts.ResumePlain)
	if err != nil {
		return Result{}, err
	}

	var preset *Preset
	if opts.Preset != "" {
		available := settings.RiffPresetMap(loadRiffPresets())
		skill, ok := available[opts.Preset]
		if !ok {
			return Result{}, ValidationErr("run-kit riff: unknown preset %q (defined: %s)", opts.Preset, joinPresetNames(available))
		}
		preset = &Preset{Name: opts.Preset, Skill: skill}
	}

	// composePanes maps the (task, preset) pair to the endpoint's CLI-pane input
	// for ResolveEffectiveSpec (the blank-agent-vs-/fab-discuss distinction).
	cliPanes := composePanes(opts.Task, preset)

	// layoutExplicit=false (the endpoint exposes no --layout) so the layout is
	// auto-by-count; a single pane forces "" either way.
	spec, err := ResolveEffectiveSpec(cliPanes, false, "auto", 1, preset, nil)
	if err != nil {
		return Result{}, err
	}
	spec.Launcher = launcher
	spec.Server = opts.Server
	spec.Session = opts.Session
	spec.RepoRoot = opts.RepoRoot
	// Normalize the isolation inputs at this seam: an empty Where means the
	// worktree default, and WorktreeName is meaningless in checkout mode (the
	// API already rejects that pairing — R6 — so this is defense-in-depth). Both
	// normalizations are behavior-preserving: worktree mode was already the
	// empty-Where path, and a checkout-mode name never reached wt.
	spec.Where = opts.Where
	if spec.Where == "" {
		spec.Where = whereWorktree
	}
	spec.WorktreeName = opts.WorktreeName
	if opts.isCheckout() {
		spec.WorktreeName = ""
	}
	// WindowNameBase is consumed by spawnRiffReturningName's base derivation. The
	// fork ref needs no spec field — it was already folded into spec.Launcher
	// above, which is the only place anything downstream reads it.
	spec.WindowNameBase = opts.WindowNameBase

	// Skill-prefix normalization is the last spec-finalization step: every skill
	// pane's value is rendered for the resolved agent's provider exactly once
	// here, so composition and typed delivery read already-rendered values.
	spec.SkillPrefix = agent.SkillPrefix
	spec = ApplySkillPrefix(spec)

	// Checkout mode roots the window directly at the repo checkout (no worktree);
	// worktree mode creates one first. Everything after — the tmux spawn sequence
	// (collision naming, new-window/split/select-layout/select-pane, window-id
	// capture) — is identical, so both paths converge on spawnRiffReturningName.
	windowRoot := opts.RepoRoot
	if !opts.isCheckout() {
		windowRoot, err = runWtCreate(ctx, spec, spec.Passthrough)
		if err != nil {
			return Result{}, err
		}
	}
	name, windowID, paneID, err := spawnRiffReturningName(ctx, windowRoot, spec)
	if err != nil {
		return Result{}, err
	}
	// Typed-mode task delivery is fire-and-forget on the daemon path: the HTTP
	// response must not block on agent boot (deliver.go).
	deliverDaemonTask(spec, name, paneID)
	return Result{
		Server:     opts.Server,
		Session:    opts.Session,
		WindowName: name,
		WindowID:   windowID,
		PaneID:     paneID,
	}, nil
}

// SpawnReceipt is one spawned window's identity, returned by Run in index
// order (one per spawned window for --count N, one for count 1) for the CLI's
// --json receipt. PaneIDs is every pane of the window (pane 0 first),
// collected after the split phase; Branch is the worktree's branch. Both
// derivations are best-effort — a failure leaves PaneIDs as the captured
// pane-0 id and Branch empty, and never fails the spawn.
type SpawnReceipt struct {
	WindowID     string
	WindowName   string
	Server       string
	PaneIDs      []string
	WorktreePath string
	Branch       string
}

// Run is the CLI entry: it dispatches count==1 to a direct spawn and count≥2 to
// the fan-out orchestrator. The CLI has already resolved the effective spec
// (panes/layout/count/passthrough), launcher, server label (""), and
// OriginalTMUX. Returns an ExitCodeError on failure (the CLI maps Code to
// os.Exit).
func Run(ctx context.Context, spec EffectiveSpec) ([]SpawnReceipt, error) {
	if spec.Count <= 1 {
		worktreePath, err := runWtCreate(ctx, spec, spec.Passthrough)
		if err != nil {
			return nil, err
		}
		name, windowID, paneID, err := spawnRiffReturningName(ctx, worktreePath, spec)
		if err != nil {
			return nil, err
		}
		// Typed-mode task delivery is synchronous on the CLI path; a failure
		// warns without failing the spawn (deliver.go).
		deliverCliTask(ctx, spec, name, paneID)
		return []SpawnReceipt{{
			WindowID:     windowID,
			WindowName:   name,
			Server:       spec.Server,
			PaneIDs:      collectPaneIDs(ctx, spec, windowID, paneID),
			WorktreePath: worktreePath,
			Branch:       worktreeBranch(ctx, worktreePath),
		}}, nil
	}
	return runCount(ctx, spec)
}

// collectPaneIDs lists the window's panes (`list-panes -t <windowID> -F
// '#{pane_id}'`, pane 0 first) after the split phase. Best-effort: a failure —
// or an unresolved window id — degrades to the captured pane-0 id; the window
// exists either way.
func collectPaneIDs(parent context.Context, spec EffectiveSpec, windowID, paneID string) []string {
	if windowID == "" {
		return []string{paneID}
	}
	ctx, cancel := context.WithTimeout(parent, TmuxTimeout)
	defer cancel()
	out, err := tmux.RunOutput(ctx, tmuxArgv(spec, "list-panes", "-t", windowID, "-F", "#{pane_id}"), tmux.RunOpts{Env: childEnv(spec)})
	if err != nil {
		return []string{paneID}
	}
	var ids []string
	for _, raw := range strings.Split(string(out), "\n") {
		if line := strings.TrimSpace(raw); line != "" {
			ids = append(ids, line)
		}
	}
	if len(ids) == 0 {
		return []string{paneID}
	}
	return ids
}

// worktreeBranch derives the worktree's branch (`git -C <wt> rev-parse
// --abbrev-ref HEAD`) — wt create prints a Path: line but no branch line.
// Best-effort: "" on any failure.
func worktreeBranch(parent context.Context, worktreePath string) string {
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// ResolvedAgent is fab's fully-resolved agent for a tier: the launcher shell
// command plus the provider's skill-invocation prefix (`/` for claude-syntax
// providers, `$` for codex) as exposed on `fab agent [tier] -o yaml`'s
// `command` / `skill_prefix` keys.
type ResolvedAgent struct {
	Launcher    string
	SkillPrefix string
}

// defaultResolvedAgent is the never-errors floor: the claude default launcher
// with the claude-syntax prefix.
var defaultResolvedAgent = ResolvedAgent{Launcher: DefaultLauncher, SkillPrefix: "/"}

// ResolveLauncher resolves the agent launcher by shelling out to fab (see
// ResolveAgent). Best-effort and never errors: on ANY failure (fab absent,
// non-zero exit, timeout, empty / whitespace-only / multi-line stdout) it
// falls back silently to DefaultLauncher.
func ResolveLauncher(parent context.Context, repoRoot, tier string) string {
	return ResolveAgent(parent, repoRoot, tier).Launcher
}

// ResolveAgent resolves the launcher AND the provider's skill-invocation prefix
// by shelling out to `fab agent [tier] -o yaml`, which prints fab-kit's
// fully-resolved agent for the named tier (empty tier → the default tier).
// Delegating to fab means rk never parses fab-kit's tier→provider schema and
// can't drift from it (constitution §III); the prefix rule lives in fab
// (agent.SkillPrefix) so there is a single owner toolkit-wide. The subprocess
// Dir is set to repoRoot so fab's cwd-based repo discovery resolves the TARGET
// project (the daemon's own cwd is not the target repo); the CLI passes its
// process cwd + an empty tier.
//
// Best-effort and never errors. The fallback ladder:
//  1. `-o yaml` parses with a `command` key → {command, skill_prefix}
//     (skill_prefix absent — an older fab — reads as "/").
//  2. `-o yaml` fails or carries no command → retry legacy
//     `fab agent [tier] --print` (fabs predating -o yaml resolved launchers
//     fine; degrading them to the default would be an unrelated regression) →
//     {printed, "/"}.
//  3. both fail → {DefaultLauncher, "/"}.
func ResolveAgent(parent context.Context, repoRoot, tier string) ResolvedAgent {
	out, err := runFabAgent(parent, repoRoot, fabAgentYAMLArgs(tier))
	if agent, ok := parseFabAgentYAML(string(out), err); ok {
		return agent
	}
	out, err = runFabAgent(parent, repoRoot, fabAgentArgs(tier))
	if launcher, ok := parseFabAgentOutput(string(out), err); ok {
		return ResolvedAgent{Launcher: launcher, SkillPrefix: "/"}
	}
	return defaultResolvedAgent
}

// runFabAgent runs one `fab` argv with the FabTimeout bound and Dir=repoRoot
// (when non-empty). Output() (not CombinedOutput()) so stderr can't pollute
// the parsed fields.
func runFabAgent(parent context.Context, repoRoot string, argv []string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(parent, FabTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "fab", argv...)
	if repoRoot != "" {
		cmd.Dir = repoRoot
	}
	return cmd.Output()
}

// fabAgentYAMLArgs builds the `fab` argv for agent resolution: `agent -o yaml`
// for an empty tier (today's default-tier path) or `agent <tier> -o yaml` for a
// named tier (the positional-tier form). Pure.
func fabAgentYAMLArgs(tier string) []string {
	if tier == "" {
		return []string{"agent", "-o", "yaml"}
	}
	return []string{"agent", tier, "-o", "yaml"}
}

// fabAgentArgs builds the `fab` argv for legacy launcher resolution: `agent
// --print` for an empty tier (today's default-tier path) or `agent <tier>
// --print` for a named tier (the positional-tier form). Pure.
func fabAgentArgs(tier string) []string {
	if tier == "" {
		return []string{"agent", "--print"}
	}
	return []string{"agent", tier, "--print"}
}

// parseFabAgentYAML is the pure post-processing seam for ResolveAgent's
// `fab agent -o yaml` call: a tolerant line-based extraction of the two
// top-level scalar keys `command` and `skill_prefix` (the output is
// fab-controlled; nested keys like `dispatch.command` carry leading whitespace
// and are ignored). Each value is everything after the first ": ",
// unquoted-verbatim — `command` legitimately contains `"` and `$(...)`.
// Returns (agent, true) only when err is nil and a non-empty top-level
// `command` parsed; a missing `skill_prefix` (older fab) reads as "/" — the
// only prefix a pre-skill_prefix fab can need. Pure — no I/O — so the
// fallback rules are testable in isolation.
func parseFabAgentYAML(stdout string, err error) (ResolvedAgent, bool) {
	if err != nil {
		return ResolvedAgent{}, false
	}
	agent := ResolvedAgent{SkillPrefix: "/"}
	for _, line := range strings.Split(stdout, "\n") {
		if line == "" || line[0] == ' ' || line[0] == '\t' {
			continue
		}
		key, value, found := strings.Cut(line, ": ")
		if !found {
			continue
		}
		switch key {
		case "command":
			agent.Launcher = strings.TrimSpace(value)
		case "skill_prefix":
			if v := strings.TrimSpace(value); v != "" {
				agent.SkillPrefix = v
			}
		}
	}
	if agent.Launcher == "" {
		return ResolvedAgent{}, false
	}
	return agent, true
}

// parseFabAgentOutput is the pure post-processing seam for ResolveAgent's
// legacy `--print` retry. Returns (trimmed launcher, true) only when err is nil
// and stdout trims to a single non-empty line; otherwise ("", false). A trimmed
// multi-line result is malformed. Pure — no I/O — so the fallback rules are
// testable in isolation.
func parseFabAgentOutput(stdout string, err error) (string, bool) {
	if err != nil {
		return "", false
	}
	launcher := strings.TrimSpace(stdout)
	if launcher == "" {
		return "", false
	}
	if strings.ContainsRune(launcher, '\n') {
		return "", false
	}
	return launcher, true
}

// buildWtCreateArgs returns the argv (after "wt") for worktree creation:
// `create [--worktree-name <name>] --non-interactive --worktree-open skip
// <passthrough...>`. A non-empty WorktreeName (worktree mode only) is prepended
// as `--worktree-name <name>` so it skips wt's name prompt; an empty name yields
// the byte-identical pre-feature argv. The `spec.Where != whereCheckout` guard
// keeps the helper self-contained (Spawn already blanks a checkout-mode name,
// and checkout never reaches wt anyway; the CLI/fan-out paths pass no name). Pure.
func buildWtCreateArgs(spec EffectiveSpec, passthrough []string) []string {
	argv := []string{"create"}
	if spec.Where != whereCheckout && spec.WorktreeName != "" {
		argv = append(argv, "--worktree-name", spec.WorktreeName)
	}
	argv = append(argv, "--non-interactive", "--worktree-open", "skip")
	return append(argv, passthrough...)
}

// runWtCreate invokes `wt create [--worktree-name <name>] --non-interactive
// --worktree-open skip <passthrough...>` (with Dir=RepoRoot when set) and parses
// the `Path:` line for the worktree path. Returns a SubprocessErr on
// failure/parse-miss/timeout.
func runWtCreate(parent context.Context, spec EffectiveSpec, passthrough []string) (string, error) {
	ctx, cancel := context.WithTimeout(parent, WtTimeout)
	defer cancel()

	argv := buildWtCreateArgs(spec, passthrough)
	cmd := exec.CommandContext(ctx, "wt", argv...)
	if spec.RepoRoot != "" {
		cmd.Dir = spec.RepoRoot
	}
	out, runErr := cmd.CombinedOutput()
	output := string(out)
	if runErr != nil {
		return "", SubprocessErr("run-kit riff: wt create failed: %v\n%s", runErr, output)
	}

	path := parseWorktreePath(output)
	if path == "" {
		return "", SubprocessErr("run-kit riff: could not find 'Path:' line in wt output:\n%s", output)
	}
	if info, err := os.Stat(path); err != nil || !info.IsDir() {
		return "", SubprocessErr("run-kit riff: worktree path %q does not exist or is not a directory\n%s", path, output)
	}
	return path, nil
}

// parseWorktreePath scans wt's output for `^Path: <path>$`. Returns the path or
// "" if not found. Pure — testable without a real wt invocation.
func parseWorktreePath(output string) string {
	for _, raw := range strings.Split(output, "\n") {
		line := strings.TrimSpace(raw)
		if !strings.HasPrefix(line, "Path:") {
			continue
		}
		value := strings.TrimSpace(strings.TrimPrefix(line, "Path:"))
		if value != "" {
			return value
		}
	}
	return ""
}

// spawnRiffReturningName performs the tmux spawn sequence for one riff window on
// spec.Server and returns the resolved window name, window id, and pane-0 id.
// It probes existing window names for collision resolution, then runs three phases:
//  1. `tmux new-window -P -F '#{pane_id}' …` to capture the first pane id,
//  2. the remaining argv rows from buildSpawnArgvs (split-window × N + optional
//     select-layout),
//  3. `tmux select-pane -t <pane-id>` to focus pane 0.
//
// After creation it resolves the window id from the captured pane
// (`display-message -t <pane-id> -p '#{window_id}'`) so the HTTP caller can
// navigate to /$server/$window; a resolve failure is non-fatal (empty id
// returned — the CLI ignores it, the handler falls back to a name-only response
// if ever needed). The pane-0 id is the typed task-delivery target.
func spawnRiffReturningName(ctx context.Context, worktreePath string, spec EffectiveSpec) (string, string, string, error) {
	existing, err := listWindowNames(ctx, spec)
	if err != nil {
		return "", "", "", err
	}
	resolvedName := resolveWindowName(existing, windowNameBase(worktreePath, spec))

	if len(spec.Panes) == 0 {
		return resolvedName, "", "", &ExitCodeError{Code: ExitValidation, Msg: "run-kit riff: spawnRiff invariant violated: spec.Panes is empty"}
	}

	paneID, err := runTmuxNewWindowCapturePaneID(ctx, spec, buildNewWindowCaptureArgs(worktreePath, resolvedName, spec))
	if err != nil {
		return resolvedName, "", "", err
	}

	rest := buildSpawnArgvs(worktreePath, resolvedName, spec)
	if len(rest) > 0 {
		rest = rest[1:]
	}
	for _, argv := range rest {
		if err := runTmuxArgv(ctx, spec, argv); err != nil {
			return resolvedName, "", "", err
		}
	}

	if err := runTmuxArgv(ctx, spec, []string{"select-pane", "-t", paneID}); err != nil {
		return resolvedName, "", "", err
	}

	// Best-effort window-id resolution from the captured pane id, for the HTTP
	// caller's navigation. A failure here does not fail the spawn — the window
	// already exists and will surface via SSE regardless.
	windowID := resolveWindowIDFromPane(ctx, spec, paneID)
	return resolvedName, windowID, paneID, nil
}

// resolveWindowIDFromPane resolves the @N window id owning paneID via
// `tmux display-message -t <pane-id> -p '#{window_id}'`. Best-effort: returns ""
// on any failure (the window still exists; only the navigation hint is lost).
func resolveWindowIDFromPane(parent context.Context, spec EffectiveSpec, paneID string) string {
	ctx, cancel := context.WithTimeout(parent, TmuxTimeout)
	defer cancel()

	out, err := tmux.RunOutput(ctx, tmuxArgv(spec, "display-message", "-t", paneID, "-p", "#{window_id}"), tmux.RunOpts{Env: childEnv(spec)})
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// runTmuxNewWindowCapturePaneID runs `tmux new-window -P -F '#{pane_id}' …` and
// returns the captured pane id (trimmed). SubprocessErr on failure/timeout/empty
// stdout. Uses tmux.RunOutput so stderr is excluded from the parsed id.
func runTmuxNewWindowCapturePaneID(parent context.Context, spec EffectiveSpec, argv []string) (string, error) {
	ctx, cancel := context.WithTimeout(parent, TmuxTimeout)
	defer cancel()

	stdout, err := tmux.RunOutput(ctx, tmuxArgv(spec, argv...), tmux.RunOpts{Env: childEnv(spec)})
	if err != nil {
		return "", SubprocessErr("run-kit riff: tmux new-window failed: %v", err)
	}
	id, parseErr := parsePaneID(string(stdout))
	if parseErr != nil {
		return "", SubprocessErr("run-kit riff: tmux new-window output parse failed: %v", parseErr)
	}
	return id, nil
}

// runTmuxArgv executes one tmux argv (server-prefixed + child-env) with a
// TmuxTimeout context. SubprocessErr on non-zero exit / timeout.
func runTmuxArgv(parent context.Context, spec EffectiveSpec, argv []string) error {
	ctx, cancel := context.WithTimeout(parent, TmuxTimeout)
	defer cancel()

	if err := tmux.Run(ctx, tmuxArgv(spec, argv...), tmux.RunOpts{Env: childEnv(spec)}); err != nil {
		return SubprocessErr("run-kit riff: tmux %s failed: %v", argv[0], err)
	}
	return nil
}

// listWindowNames runs `tmux list-windows -F '#W'` against the target server —
// scoped to spec.Session (`-t <session>`) on the daemon path so the collision
// probe reads the SAME session the window will be created in; unscoped on the
// CLI path — and returns the trimmed, non-empty window names. SubprocessErr on
// failure/timeout.
func listWindowNames(parent context.Context, spec EffectiveSpec) ([]string, error) {
	ctx, cancel := context.WithTimeout(parent, TmuxTimeout)
	defer cancel()

	listArgs := []string{"list-windows", "-F", "#W"}
	if spec.Session != "" {
		listArgs = []string{"list-windows", "-t", tmux.ExactSessionTarget(spec.Session), "-F", "#W"}
	}
	out, err := tmux.RunOutput(ctx, tmuxArgv(spec, listArgs...), tmux.RunOpts{Env: childEnv(spec)})
	if err != nil {
		return nil, SubprocessErr("run-kit riff: tmux list-windows failed: %v", err)
	}

	var names []string
	for _, raw := range strings.Split(string(out), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		names = append(names, line)
	}
	return names, nil
}

// tmuxArgv prepends the server-targeting `-L <server>` prefix when spec.Server
// is non-empty (the daemon path). When empty (the CLI path), no prefix is added
// and targeting relies on the restored $TMUX in childEnv.
func tmuxArgv(spec EffectiveSpec, args ...string) []string {
	if spec.Server == "" {
		return args
	}
	return append([]string{"-L", spec.Server}, args...)
}

// childEnv returns the subprocess env. On the CLI path (Server == "") it
// restores $TMUX from spec.OriginalTMUX so bare tmux calls target the user's
// current server (internal/tmux's init() strips $TMUX). On the daemon path
// (Server != "") the `-L <server>` prefix selects the socket (NOT the session)
// and the explicit `-t <session>` targets select the session, so the ambient
// env is used unchanged — no $TMUX is restored.
func childEnv(spec EffectiveSpec) []string {
	env := os.Environ()
	if spec.Server == "" && spec.OriginalTMUX != "" {
		env = append(env, "TMUX="+spec.OriginalTMUX)
	}
	return env
}

// windowNameBase returns the window-name base before collision suffixing: an
// explicit spec.WindowNameBase when set (the fork endpoint's
// `<sourceWindowName>-fork`), else the path-derived `riff-<basename>` both riff
// modes have always used. Pure.
func windowNameBase(windowRoot string, spec EffectiveSpec) string {
	if spec.WindowNameBase != "" {
		return spec.WindowNameBase
	}
	return "riff-" + filepath.Base(windowRoot)
}

// resolveWindowName returns base if free, else the first free base-2, base-3, …
// Pure — deterministic for a given input. Gaps are filled before extending.
func resolveWindowName(existing []string, base string) string {
	set := make(map[string]struct{}, len(existing))
	for _, name := range existing {
		set[name] = struct{}{}
	}
	if _, clash := set[base]; !clash {
		return base
	}
	for i := 2; ; i++ {
		candidate := fmt.Sprintf("%s-%d", base, i)
		if _, clash := set[candidate]; !clash {
			return candidate
		}
	}
}

// --- Fan-out (CLI-only; the HTTP endpoint fixes count at 1) ---

// fanOutResult records one goroutine's outcome for rollback planning and the
// success receipt.
type fanOutResult struct {
	Index        int
	WorktreePath string
	WindowName   string
	WindowID     string
	PaneID       string
	Err          error
}

// rollbackPlan lists the cleanup ops after a partial fan-out failure.
type rollbackPlan struct {
	Worktrees []string
	Windows   []string
}

// planFanOutRollback computes the rollback plan from completed goroutine
// results. Pure. The failing goroutine's own artifacts are excluded (failureIdx);
// every other created worktree/window is included so rollback cleans it up.
func planFanOutRollback(results []fanOutResult, failureIdx int) rollbackPlan {
	plan := rollbackPlan{}
	for _, r := range results {
		if r.Index == failureIdx {
			continue
		}
		if r.WorktreePath != "" {
			plan.Worktrees = append(plan.Worktrees, filepath.Base(r.WorktreePath))
		}
		if r.WindowName != "" {
			plan.Windows = append(plan.Windows, r.WindowName)
		}
	}
	return plan
}

// runCount spawns spec.Count worktree/window pairs in parallel, rolling back
// successful ones on any failure. The first-reported error propagates out. On
// success the receipts are built in index order (pane/branch derivation is
// best-effort and runs after the parallel phase).
func runCount(ctx context.Context, spec EffectiveSpec) ([]SpawnReceipt, error) {
	n := spec.Count
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	results := make([]fanOutResult, n)
	var wg sync.WaitGroup
	wg.Add(n)

	var firstFailOnce sync.Once
	firstFailIdx := -1
	var firstFailErr error
	recordFailure := func(i int, err error) {
		firstFailOnce.Do(func() {
			firstFailIdx = i
			firstFailErr = err
		})
	}

	for i := 0; i < n; i++ {
		go func(i int) {
			defer wg.Done()
			res := fanOutResult{Index: i}
			defer func() { results[i] = res }()

			worktreePath, err := runWtCreate(ctx, spec, spec.Passthrough)
			if err != nil {
				res.Err = err
				recordFailure(i, err)
				cancel()
				return
			}
			res.WorktreePath = worktreePath

			windowName, windowID, paneID, err := spawnRiffReturningName(ctx, worktreePath, spec)
			res.WindowName = windowName
			res.WindowID = windowID
			res.PaneID = paneID
			if err != nil {
				res.Err = err
				recordFailure(i, err)
				cancel()
				return
			}
			// Typed-mode task delivery is synchronous per window (inside this
			// goroutine); a failure warns without failing the spawn or
			// triggering rollback (deliver.go).
			deliverCliTask(ctx, spec, windowName, paneID)
		}(i)
	}
	wg.Wait()

	if firstFailErr == nil {
		receipts := make([]SpawnReceipt, n)
		for i, res := range results {
			receipts[i] = SpawnReceipt{
				WindowID:     res.WindowID,
				WindowName:   res.WindowName,
				Server:       spec.Server,
				PaneIDs:      collectPaneIDs(ctx, spec, res.WindowID, res.PaneID),
				WorktreePath: res.WorktreePath,
				Branch:       worktreeBranch(ctx, res.WorktreePath),
			}
		}
		return receipts, nil
	}
	failureIdx := firstFailIdx
	firstErr := firstFailErr

	plan := planFanOutRollback(results, failureIdx)
	rollbackFanOut(context.Background(), spec, plan)

	var ece *ExitCodeError
	if errors.As(firstErr, &ece) {
		return nil, ece
	}
	return nil, SubprocessErr("run-kit riff: fan-out failed: %v", firstErr)
}

// rollbackFanOut invokes `wt delete` per worktree and `tmux kill-window` per
// window. Best-effort — errors logged to stderr but do not halt rollback. Uses a
// fresh (non-cancelled) context.
func rollbackFanOut(ctx context.Context, spec EffectiveSpec, plan rollbackPlan) {
	for _, wtName := range plan.Worktrees {
		if err := runWtDelete(ctx, spec, wtName); err != nil {
			fmt.Fprintf(os.Stderr, "run-kit riff: rollback warning: wt delete %s failed: %v\n", wtName, err)
		}
	}
	for _, winName := range plan.Windows {
		if err := runTmuxArgv(ctx, spec, []string{"kill-window", "-t", windowTarget(spec, winName)}); err != nil {
			fmt.Fprintf(os.Stderr, "run-kit riff: rollback warning: tmux kill-window %s failed: %v\n", winName, err)
		}
	}
}

// buildWtDeleteArgs returns the argv (after "wt") for the rollback delete.
// `--non-interactive` is mandatory (no tty during rollback); the name is
// positional (`wt` deprecated `--worktree-name`). Pure.
func buildWtDeleteArgs(name string) []string {
	return []string{"delete", "--non-interactive", name}
}

// runWtDelete invokes `wt delete --non-interactive <name>` (Dir=RepoRoot when
// set). Returns the raw exec error — the caller logs and continues.
func runWtDelete(parent context.Context, spec EffectiveSpec, name string) error {
	ctx, cancel := context.WithTimeout(parent, WtTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "wt", buildWtDeleteArgs(name)...)
	if spec.RepoRoot != "" {
		cmd.Dir = spec.RepoRoot
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v\n%s", err, string(out))
	}
	return nil
}
