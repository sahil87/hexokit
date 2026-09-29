package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"rk/internal/config"
	"rk/internal/riff"
	"rk/internal/settings"
	"rk/internal/tmux"
	"rk/internal/validate"

	"github.com/spf13/cobra"
)

// The spawn engine lives in internal/riff (extracted by 260713-sbk1). This file
// is the CLI FRONTEND: it parses flags, checks CLI-only preconditions ($TMUX
// set, wt on PATH), derives the repo root from the process cwd, resolves the
// effective spec + launcher via the engine's exported helpers, and hands off to
// riff.Run with an EMPTY server label (target the user's current tmux server via
// the restored $TMUX). The engine owns the wt+tmux spawn mechanics, fan-out,
// and rollback.

var (
	// riffPaneSpecs is the shared ordered list of pane specs accumulated from
	// argv-order occurrences of --skill and --cmd. Both flags append into this
	// same slice via the paneFlag.target binding, so interleaved uses produce
	// the correct pane order.
	riffPaneSpecs []riff.PaneSpec

	riffLayoutFlag     string
	riffCountFlag      int
	riffPresetFlag     string
	riffListPresetsFlg bool
	riffServerFlag     string
	riffSessionFlag    string
	riffRepoFlag       string
	riffJSONFlag       bool
)

// riffWindowReceipt is one spawned window in the --json receipt — the engine's
// SpawnReceipt rendered with the receipt's key names (id/panes/worktree).
type riffWindowReceipt struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Server   string   `json:"server"`
	Panes    []string `json:"panes"`
	Worktree string   `json:"worktree"`
	Branch   string   `json:"branch"`
}

var riffCmd = &cobra.Command{
	Use:   "riff [preset] [--skill <skill>...] [--cmd <cmd>...] [--layout <name>] [--count <N>] [--preset <name>] [--list-presets] [-- <wt-flags>...]",
	Short: "Create a worktree, tmux window, and Claude Code session",
	Long: `Create a git worktree via wt, open a new tmux window in it, and launch
a Claude Code session with a skill or slash-command. Supports multi-pane
windows via repeatable --skill and --cmd flags, named layouts, presets from
run-kit's riff_presets, and parallel spawning across N worktrees via --count.

Prerequisites:
  - You must be inside a tmux session ($TMUX set).
  - 'wt' must be on your PATH (https://github.com/sahil87/wt).
  - The resolved launcher command (default: claude --dangerously-skip-permissions) must be available.
  - 'fab' on PATH is optional: it is used to resolve the launcher (see below);
    when absent, the default launcher is used.

Flags before -- are parsed by run-kit; flags after -- are forwarded verbatim to
wt create (e.g., --worktree-name, --base, --reuse). Run 'wt create --help' to
see the available passthrough flags.

Pane array model:
  --skill and --cmd are repeatable. Each occurrence adds one pane; argv order
  (left to right) becomes pane order (pane 0, 1, 2, …). Both flags may be
  interleaved. Bare --skill (no value) launches a blank Claude session; bare
  --cmd drops into $SHELL (fallback /bin/sh).

Launcher resolution:
  The launcher is resolved by running 'fab agent -o yaml', which prints
  fab-kit's fully-resolved default-tier agent (command + skill prefix). If
  'fab' is not on PATH or the call fails, falls back to
  'claude --dangerously-skip-permissions' with the '/' skill prefix.

Presets:
  Named invocations like 'run-kit riff incognito' or 'run-kit riff --preset
  incognito' resolve against run-kit's riff_presets: three built-ins ship with
  the binary (discuss → /fab-discuss, incognito → /fab-incognito, blank → a
  bare agent), and user entries under riff_presets in
  ~/.config/hexokit/config.yaml add to them — a name matching a built-in
  overrides it. Each preset is exactly one skill pane. CLI --skill/--cmd flags
  replace the preset's pane entirely. Run 'run-kit riff --list-presets' to see
  the merged list.

Count:
  --count N (short -N) creates N worktree/window pairs in parallel, each with
  the same pane shape. Worktree names come from wt's random adjective-noun
  generator. On any failure, successful worktrees and windows are rolled back
  before returning a non-zero exit.

Examples:
  run-kit riff                                           # default: 1 pane, /fab-discuss
  run-kit riff --skill /review                           # single-pane with specific skill
  run-kit riff --skill /fab-fff --cmd "just dev"         # 2 panes (even-horizontal by default)
  run-kit riff --cmd --skill /fab --cmd htop --skill     # 4 interleaved panes (auto-tiled)
  run-kit riff --skill /a --cmd x --cmd y --layout main-vertical
  run-kit riff incognito                                 # invoke the 'incognito' built-in preset
  run-kit riff --preset blank                            # named-flag preset alias
  run-kit riff discuss --count 3                         # 3 parallel discuss workspaces (also: -N 3)
  run-kit riff -- --worktree-name pacing-canyon          # name the worktree

Exit codes:
  0  success
  1  precondition failure ($TMUX unset, wt not found)
  2  validation/usage error (unknown layout, invalid --count, unknown/conflicting preset, bad flag)
  3  subprocess failure (wt or tmux non-zero, output parse failure, timeout)`,
	// Interspersed=false so the "--" separator terminates cobra's flag parsing
	// and the remainder lands in args[] for passthrough to `wt create`.
	//
	// DisableFlagParsing=true lets us pre-process argv (rewriting `--skill V`
	// to `--skill=V` so pflag's NoOptDefVal + Set path handles both bare
	// and with-value forms uniformly) before handing the cleaned argv to
	// pflag.Parse. See pane_spec.go for the motivation.
	DisableFlagParsing: true,
	RunE:               runRiffWithExitCode,
}

// skillPaneFlag / cmdPaneFlag are the two pflag.Value instances bound to
// --skill and --cmd. Both append into the shared riffPaneSpecs slice so
// argv-order is preserved across interleaved occurrences.
var (
	skillPaneFlag = &paneFlag{kind: riff.PaneKindSkill, target: &riffPaneSpecs}
	cmdPaneFlag   = &paneFlag{kind: riff.PaneKindCmd, target: &riffPaneSpecs}
)

func init() {
	// Interspersed=true (pflag default) so flags may appear before OR after
	// the positional preset token (e.g., `rk riff discuss --count 3`). The
	// `--` separator still terminates parsing so wt passthrough works.
	riffCmd.Flags().SetInterspersed(true)

	// --skill and --cmd are repeatable pane flags. NoOptDefVal is set to the
	// bare sentinel so pflag accepts bare usage; space-form with a value is
	// handled by rewritePaneSpaceForm which rewrites argv to equals-form.
	riffCmd.Flags().Var(skillPaneFlag, "skill", "Claude Code skill/slash-command for a pane (repeatable; bare form launches a blank Claude session)")
	riffCmd.Flags().Lookup("skill").NoOptDefVal = paneBareSentinel
	riffCmd.Flags().Var(cmdPaneFlag, "cmd", "Shell command for a pane (repeatable; bare form drops into $SHELL)")
	riffCmd.Flags().Lookup("cmd").NoOptDefVal = paneBareSentinel

	riffCmd.Flags().StringVar(&riffLayoutFlag, "layout", "auto", layoutFlagUsage())
	riffCmd.Flags().IntVarP(&riffCountFlag, "count", "N", 1, "Spawn N worktree/window pairs in parallel (N >= 1)")
	riffCmd.Flags().StringVar(&riffPresetFlag, "preset", "", "Named preset from run-kit's riff_presets (built-ins: discuss, incognito, blank)")
	riffCmd.Flags().BoolVar(&riffListPresetsFlg, "list-presets", false, "List defined presets and exit")
	riffCmd.Flags().StringVarP(&riffServerFlag, "server", "L", "", "Address the named tmux server (no $TMUX required; with --session unset and no $TMUX the window lands in the server's current session)")
	riffCmd.Flags().StringVar(&riffSessionFlag, "session", "", "Session the window is created in (=S exact form, e.g. --session =work)")
	riffCmd.Flags().StringVar(&riffRepoFlag, "repo", "", "Repo to spawn from (absolute or cwd-relative; must be the git toplevel; default: the process cwd's repo)")
	riffCmd.Flags().BoolVar(&riffJSONFlag, "json", false, "Emit the machine-readable envelope (exactly one JSON document on stdout)")

	riffCmd.Args = cobra.ArbitraryArgs
	cobra.OnInitialize() // no-op but retains ordering explicitly
}

// runRiffWithExitCode is the cobra RunE. Because the command sets
// DisableFlagParsing=true (so we can pre-process --skill/--cmd space-form),
// we manually call Flags().Parse on the rewritten argv. --help / -h are
// handled explicitly since cobra's own help path is bypassed.
//
// A manual flag-parse failure is returned as a usageError (CLI-local
// *exitCodeError, exit 2) so cobra's own error path prints `Error: <msg>` and
// the central execute() seam owns the exit code. On a successful parse it
// delegates to runRiff and inspects the returned error: a *riff.ExitCodeError is
// printed to stderr and os.Exited with its Code (the riff engine's own 1/2/3
// classes); any other error is returned to main.execute() as a generic exit-1
// error.
func runRiffWithExitCode(cmd *cobra.Command, args []string) error {
	// Reset accumulator + flag vars so repeated cobra.Execute() calls (tests)
	// start fresh.
	riffPaneSpecs = nil
	riffLayoutFlag = "auto"
	riffCountFlag = 1
	riffPresetFlag = ""
	riffListPresetsFlg = false
	riffServerFlag = ""
	riffSessionFlag = ""
	riffRepoFlag = ""
	riffJSONFlag = false

	rewritten := rewritePaneSpaceForm(args)

	// pflag's Parse drops the "--" separator from Args(), so the boundary must
	// be captured here: only the head is flag-parsed and preset-resolved; the
	// tail forwards to `wt create` verbatim — a preset-named token after "--"
	// (`rk riff -- discuss`) is a wt argument, never the positional preset.
	riffArgv, wtArgv := splitAtSeparator(rewritten)

	for _, tok := range rewritten {
		if tok == "-h" || tok == "--help" {
			return cmd.Help()
		}
		if tok == "--" {
			break
		}
	}

	// A manual flag-parse failure (e.g. `riff --nope`) is a usage error.
	// DisableFlagParsing means the root SetFlagErrorFunc never sees this parse
	// error, so we tag it usage-class locally with usageError (the CLI-local
	// *exitCodeError, exit 2) and RETURN it — this lets cobra's own error path
	// print `Error: unknown flag: --nope` exactly as the pre-DisableFlagParsing
	// binary did (usageError preserves the message verbatim), and the central
	// execute() seam classifies the carried code to exit 2. A riff-engine error
	// (*riff.ExitCodeError, from runRiff) is still printed here and os.Exited with
	// its own class code (1/2/3) — that path owns its bare-message stderr and is
	// unchanged.
	if parseErr := cmd.Flags().Parse(riffArgv); parseErr != nil {
		return usageError(parseErr)
	}
	err := runRiff(cmd, cmd.Flags().Args(), wtArgv)
	if err == nil {
		return nil
	}
	var ece *riff.ExitCodeError
	if errors.As(err, &ece) {
		// Under --json the error envelope is written first — no outer wrapper
		// runs after an os.Exit (usage ⇔ ExitValidation, else operational).
		if riffJSONFlag {
			code := envelopeCodeOperational
			if ece.Code == riff.ExitValidation {
				code = envelopeCodeUsage
			}
			newSink(cmd).JSONError(envelopeError{Code: code, Message: ece.Msg})
		}
		fmt.Fprintln(cmd.ErrOrStderr(), ece.Msg)
		os.Exit(ece.Code)
	}
	return err
}

// runRiff orchestrates the CLI flow:
//  0. Targeting flags (-L/--session/--repo) — pure validation, no subprocess
//  1. --list-presets short-circuit (before any other work — never side-effects)
//  2. Preconditions ($TMUX set unless -L names the server, wt on PATH)
//  3. Signal wrap on root context
//  4. Layout / count / preset-conflict validation (fail-fast, no subprocess)
//  5. Launcher resolution (engine helper, rooted at the repo root)
//  6. Preset resolution (positional or --preset; args are pre-"--" only)
//  7. Effective spec assembly (engine helper; wtArgs forward to wt create)
//  8. Dispatch to riff.Run (engine owns count==1 direct spawn + count≥2 fan-out)
func runRiff(cmd *cobra.Command, args, wtArgs []string) error {
	// Step 0: targeting flags. --repo must name a git toplevel (it replaces the
	// process-cwd derivation for wt create and launcher resolution — the MCP
	// executor's cwd is not the repo); --session takes the =S exact form; -L is
	// a validated server name.
	repoRoot, err := riffRepoRoot()
	if err != nil {
		return err
	}
	if riffServerFlag != "" {
		if msg := validate.ValidateServerName(riffServerFlag); msg != "" {
			return usageError(fmt.Errorf("invalid --server value: %s", msg))
		}
	}
	session := ""
	if riffSessionFlag != "" {
		if !strings.HasPrefix(riffSessionFlag, "=") {
			return usageError(fmt.Errorf("--session takes the =S exact form (got %q)", riffSessionFlag))
		}
		name := riffSessionFlag[1:]
		if msg := validate.ValidateName(name, "Session name"); msg != "" {
			return usageError(fmt.Errorf("--session: %s", msg))
		}
		session = name
	}

	// Step 1: --list-presets is a pure read + print. Must short-circuit BEFORE
	// preconditions — a user outside tmux should still be able to list presets.
	if riffListPresetsFlg {
		return printPresets(settings.LoadRiffPresets(), cmd.OutOrStdout())
	}

	// Step 2: preconditions (fast-fail order: $TMUX first, wt second). An
	// explicit -L waives the $TMUX check (the daemon-invocable form — every
	// tmux call is addressed with -L <name>).
	if err := checkPreconditions(riffServerFlag); err != nil {
		return err
	}

	// Step 3: signal wrap — Ctrl-C / SIGTERM cancel every subprocess below via
	// exec.CommandContext propagation.
	ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// With -L and no $TMUX there is no caller session to inherit: default to
	// the server's current session (the tab new rule) so the window lands
	// somewhere defined.
	if session == "" && riffServerFlag != "" && tmux.OriginalTMUX == "" {
		s, err := riffCurrentSessionFn(ctx, riffServerFlag)
		if err != nil {
			return fmt.Errorf("run-kit riff: resolve the current session of server %s: %w", riffServerFlag, err)
		}
		session = s
	}

	// Step 4a: count validation — must be ≥ 1.
	if riffCountFlag < 1 {
		return &riff.ExitCodeError{Code: riff.ExitValidation, Msg: fmt.Sprintf("run-kit riff: --count requires a positive integer (got %d)", riffCountFlag)}
	}

	// Step 4b: layout validation — resolve to canonical or error with full list.
	canonicalLayout, err := riff.ResolveLayout(riffLayoutFlag)
	if err != nil {
		return &riff.ExitCodeError{Code: riff.ExitValidation, Msg: err.Error()}
	}

	// Step 5: agent resolution via the engine helper (rooted at the repo root
	// so fab resolves this repo). An empty tier = the default tier (`fab
	// agent -o yaml`), preserving today's CLI behavior — the per-tier picker is
	// a web-UI-only affordance. Never errors — falls back to the default.
	agent := riff.ResolveAgent(ctx, repoRoot, "")

	// Step 6: preset resolution against run-kit's riff_presets (built-ins +
	// user) — not repo-scoped.
	available := settings.RiffPresetMap(settings.LoadRiffPresets())
	positional := ""
	if len(args) > 0 {
		positional = args[0]
	}
	preset, remaining, err := riff.ResolveActivePreset(args, positional, riffPresetFlag, available)
	if err != nil {
		return &riff.ExitCodeError{Code: riff.ExitValidation, Msg: err.Error()}
	}

	// Step 7: effective spec (engine helper). cobra's Changed() tells us whether
	// --layout was explicitly set. The wt passthrough is the positionals left
	// after preset consumption plus the verbatim post-"--" tokens.
	layoutExplicit := cmd.Flags().Changed("layout")
	spec, err := riff.ResolveEffectiveSpec(riffPaneSpecs, layoutExplicit, canonicalLayout, riffCountFlag, preset, append(remaining, wtArgs...))
	if err != nil {
		return err
	}
	spec.Launcher = agent.Launcher
	// Empty server label → target the user's current tmux server via the
	// restored $TMUX (captured before internal/tmux's init() stripped it); an
	// explicit -L targets that server with the -L argv prefix.
	spec.Server = riffServerFlag
	spec.Session = session
	spec.RepoRoot = repoRoot
	spec.OriginalTMUX = tmux.OriginalTMUX
	// Render skill-pane values for the resolved provider exactly once, here at
	// the CLI's spec-finalization seam (the Spawn daemon path does the same) —
	// covers the /fab-discuss default-pane fallback and --skill values.
	spec.SkillPrefix = agent.SkillPrefix
	spec = riff.ApplySkillPrefix(spec)

	// Step 8: dispatch to the engine; under --json print the receipts.
	receipts, err := riff.Run(ctx, spec)
	if err != nil {
		return err
	}
	if riffJSONFlag {
		printRiffReceipts(cmd, receipts)
	}
	return nil
}

// printRiffReceipts renders the --json success document: one window entry per
// spawned window, in spawn order. The server label is the -L value, else the
// caller's socket basename.
func printRiffReceipts(cmd *cobra.Command, receipts []riff.SpawnReceipt) {
	windows := make([]riffWindowReceipt, 0, len(receipts))
	for _, r := range receipts {
		server := r.Server
		if server == "" {
			server = cliServerLabel(tmux.OriginalTMUX)
		}
		panes := r.PaneIDs
		if panes == nil {
			panes = []string{}
		}
		windows = append(windows, riffWindowReceipt{
			ID:       r.WindowID,
			Name:     r.WindowName,
			Server:   server,
			Panes:    panes,
			Worktree: r.WorktreePath,
			Branch:   r.Branch,
		})
	}
	newSink(cmd).JSONResult(struct {
		Windows []riffWindowReceipt `json:"windows"`
	}{Windows: windows})
}

// riffRepoRoot resolves the repo root: --repo (a cwd-relative or absolute path
// that MUST be the git toplevel — a nested directory is a usage error) wins;
// else the process-cwd derivation (empty tolerated, as before — the engine
// then runs subprocesses in the inherited cwd).
func riffRepoRoot() (string, error) {
	if riffRepoFlag == "" {
		repoRoot := ""
		if cwd, cwdErr := os.Getwd(); cwdErr == nil {
			repoRoot = config.FindGitRoot(cwd)
		}
		return repoRoot, nil
	}
	abs, err := filepath.Abs(riffRepoFlag)
	if err != nil {
		return "", usageError(fmt.Errorf("invalid --repo value %q: %v", riffRepoFlag, err))
	}
	if root := config.FindGitRoot(abs); root != abs {
		return "", usageError(fmt.Errorf("--repo %q is not a git toplevel (resolved root: %q)", riffRepoFlag, root))
	}
	return abs, nil
}

// riffCurrentSessionFn resolves a server's current session name for the -L
// default (no $TMUX): `display-message -p '#{session_name}'` addressed at the
// server. Package-level so tests stub it (the ownTabRunOutputFn pattern).
var riffCurrentSessionFn = func(ctx context.Context, server string) (string, error) {
	args := []string{"display-message", "-p", "#{session_name}"}
	if server != "default" {
		args = append([]string{"-L", server}, args...)
	}
	sessCtx, cancel := context.WithTimeout(ctx, tabCmdTimeout)
	defer cancel()
	out, err := ownTabRunOutputFn(sessCtx, args)
	if err != nil {
		return "", err
	}
	session := strings.TrimSpace(string(out))
	if session == "" {
		return "", fmt.Errorf("empty response from tmux")
	}
	return session, nil
}

// checkPreconditions validates the CLI-only preconditions: inside tmux (waived
// when -L names the server explicitly) and wt on PATH — $TMUX first, wt
// second; fast-fail on the first miss. internal/tmux's init() strips $TMUX; we
// read the original via tmux.OriginalTMUX (captured pre-init).
func checkPreconditions(server string) error {
	if server == "" && tmux.OriginalTMUX == "" {
		return &riff.ExitCodeError{Code: riff.ExitPrecondition, Msg: "run-kit riff: not inside a tmux session ($TMUX unset) — start tmux first (or pass -L <server> to address a server by name)"}
	}
	if _, err := exec.LookPath("wt"); err != nil {
		return &riff.ExitCodeError{Code: riff.ExitPrecondition, Msg: "run-kit riff: wt not found on PATH (required companion tool — see https://github.com/sahil87/wt)"}
	}
	return nil
}

// printPresets writes the merged preset list (built-ins + user, in RiffPresets
// order) to out as indented plain text: one `name:` block per preset — suffixed
// ` (built-in)`, or ` (built-in, overridden)` when the user's value replaced the
// built-in's — with its single skill pane (`""` for the bare launcher). The
// list is never empty (the built-ins always exist). Returns nil on all paths.
func printPresets(presets []settings.RiffPreset, out io.Writer) error {
	for i, p := range presets {
		if i > 0 {
			fmt.Fprintln(out)
		}
		marker := ""
		if p.BuiltIn {
			marker = " (built-in)"
			if skill, ok := builtinRiffPresetSkill(p.Name); ok && skill != p.Skill {
				marker = " (built-in, overridden)"
			}
		}
		fmt.Fprintf(out, "%s:%s\n", p.Name, marker)
		fmt.Fprintln(out, "  panes:")
		fmt.Fprintf(out, "    - skill: %s\n", quoteIfEmpty(p.Skill))
	}
	return nil
}

// builtinRiffPresetSkill returns the code-default skill for a built-in preset
// name (ok=false for user-added names) — the reference an override is detected
// against in printPresets.
func builtinRiffPresetSkill(name string) (string, bool) {
	for _, b := range settings.BuiltinRiffPresets {
		if b.Name == name {
			return b.Skill, true
		}
	}
	return "", false
}

// quoteIfEmpty renders an empty string as the literal "" so bare skill/cmd
// entries are visually distinguishable from a missing line.
func quoteIfEmpty(s string) string {
	if s == "" {
		return `""`
	}
	return s
}
