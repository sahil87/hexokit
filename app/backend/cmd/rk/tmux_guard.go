package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"rk/internal/selfpath"
	"rk/internal/tmux"

	"github.com/spf13/cobra"
)

// rk mux guard — a PATH-shim guard that fronts the real tmux binary. Agents
// running inside run-kit-managed tmux panes have killed the host tmux server
// four documented times; the fatal command shape is `tmux kill-server` without
// an explicit socket. tmux socket resolution is -L/-S > $TMUX > TMUX_TMPDIR,
// so inside a pane even `TMUX_TMPDIR=… tmux kill-server` routes to the HOST
// server ($TMUX wins). Prose guidance (CLAUDE.md, agent memory) has failed to
// prevent this; the guard is the deterministic, harness-agnostic veto.
//
// The guard is a machine-invoked contract (cli-layering.md delegation rule 3):
// installed PATH shims exec the command literally, so the move under `mux` is
// a factory-built pair — the visible `rk mux guard` family member and the
// PERMANENT hidden root alias `rk tmux-guard` (never warns, never removed;
// tmuxGuardAliasCmd below).
//
// `rk agent setup` installs a shim at ~/.local/share/rk/shims/tmux that execs
// `rk mux guard "$@"` (see agent_setup.go), and prepends that directory to
// PATH via a marker-owned block in the user's shell startup files. Every
// PATH-resolved `tmux …` then flows through here:
//
//   - Block rule (v1): an invocation whose command chain includes kill-server
//     and carries NO explicit -L/-S refuses to exec, exits 1, and explains the
//     resolution-precedence trap. The block applies whether or not $TMUX is
//     set — a bare kill-server with $TMUX unset targets the DEFAULT host
//     server, which is equally destructive. Explicit -L/-S always passes
//     (including -L naming the host server): the guard enforces explicitness,
//     not policy. Scoped kills (kill-session/-window/-pane) are never blocked.
//   - Pass rule: everything else execs the real tmux verbatim via a
//     process-replacing exec (syscall.Exec) with the original argv slice and
//     environment — preserving argv, stdio/TTY, signals, and exit code. The
//     env has $TMUX restored from tmux.OriginalTMUX (internal/tmux's init()
//     strips it process-wide — see tmuxGuardExecEnv).
//     Constitution §I note: exec.CommandContext is deliberately NOT used here —
//     the guard is a transparent wrapper around frequently long-lived
//     interactive clients (attach), where any timeout is wrong by construction
//     and a supervising relay would break TTY/signal semantics. The §I
//     substance is kept: an explicit argument slice, no shell string, nothing
//     user-interpolated.
//   - Escape hatch: RK_TMUX_GUARD=off disables the guard for that invocation
//     (exec passthrough, no message), so deliberate host teardown stays
//     possible without uninstalling. The variable is stripped from the exec'd
//     env so the hatch never outlives its invocation (see tmuxGuardExecEnv —
//     tmux would otherwise bake it into a newly started server's global
//     environment).
//
// Absolute-path invocations (/usr/bin/tmux …) bypass PATH and are out of scope
// — the shim targets the accidental case, which is how all four deaths
// happened.

// rkTmuxGuardEnvVar is the escape-hatch environment variable; the value
// rkTmuxGuardOff disables the guard for a single invocation.
const (
	rkTmuxGuardEnvVar = "RK_TMUX_GUARD"
	rkTmuxGuardOff    = "off"
)

// tmuxGlobalValueFlags are the tmux global (pre-command) flags that consume a
// value, per tmux's getopt optstring "2c:CDdf:lL:NqS:T:uUvV": the value is
// either the remainder of the same token (-Lname) or the next token (-L name).
// Every other global flag is bare and may be clustered (-2uv).
const tmuxGlobalValueFlags = "cfLST"

// tmuxKillServerCommand is the guarded command word. tmux resolves unique
// command-name prefixes, so the guard must also match unambiguous prefixes:
// among tmux commands only kill-server and kill-session share "kill-se", so
// prefixes of length >= len("kill-ser") uniquely name kill-server.
const (
	tmuxKillServerCommand = "kill-server"
	tmuxKillServerMinAbbr = len("kill-ser")
)

// tmuxGuardBlockedMessage is the exact refusal printed on a blocked
// invocation. It states the resolution-precedence trap and both remedies.
const tmuxGuardBlockedMessage = "rk mux guard: BLOCKED: `tmux kill-server` without an explicit -L/-S socket.\n" +
	"Socket resolution is -L/-S > $TMUX > TMUX_TMPDIR — inside a tmux pane this\n" +
	"command targets the HOST server ($TMUX), even under TMUX_TMPDIR.\n" +
	"Re-run with an explicit socket:  tmux -L <scratch-name> kill-server\n" +
	"Bypass (you are sure):           RK_TMUX_GUARD=off tmux kill-server"

// --- shim artifact identity (installed by rk agent setup, see agent_setup.go) ---

// tmuxShimMarker is the ownership marker embedded in the installed shim
// script. rk agent setup only overwrites/removes a shim carrying it (the same
// marker-owned contract as its other artifacts), and findRealTmux sniffs it to
// avoid ever resolving the shim as "the real tmux" (exec recursion). The marker
// TEXT is frozen — it matches artifacts already installed on user machines.
const tmuxShimMarker = "managed-by: rk agent-setup (tmux guard shim)"

// The shim probes a momentarily-unreachable rk path for
// tmuxShimProbeAttempts × tmuxShimProbeInterval (~3s) before failing open.
// The window being covered is a package manager's NON-ATOMIC relink: brew
// upgrade unlinks the old keg's symlinks and then links the new keg's, so the
// stable /…/bin/run-kit symlink dangles for a few seconds. The shim fronts
// EVERY PATH-resolved tmux invocation on the machine, so during that window
// every tmux command — rk's own, an agent's, a cron job's — died with exit 127
// until this probe existed.
const (
	tmuxShimProbeAttempts = 15
	tmuxShimProbeInterval = "0.2"
)

// rkShimsRelDir is the shims directory relative to $HOME. Shared by rkShimsDir
// (Go) and the shim script's own fail-open PATH walk (shell, composed from
// $HOME at run time), so the directory findRealTmux skips and the one the
// script skips can never disagree.
const rkShimsRelDir = ".local/share/rk/shims"

// rkBinRelDir is the per-machine pointer directory relative to $HOME — a
// sibling of the shims dir that MUST stay off PATH (see guiPointerPath).
// Aliased to selfpath.LauncherRelDir so the Go side and the gui display
// block's shell literal resolve through one owner.
const rkBinRelDir = selfpath.LauncherRelDir

// tmuxShimNormPathFunc is the shim's separator-normalizing helper, kept OUT of
// tmuxShimTemplate and passed in as an argument: its ${x%%//*} / ${x%/}
// expansions would otherwise have to be %-escaped for fmt.Sprintf, which is
// exactly the kind of quoting that breaks silently. It collapses repeated
// slashes and drops a trailing one — the separator half of what filepath.Clean
// gives findRealTmux's directory exclusion — so `…/shims`, `…/shims/`, and
// `…//shims` all compare equal. The result lands in $_rk_np rather than on
// stdout so the PATH walk forks nothing per candidate.
const tmuxShimNormPathFunc = `# Normalize a path for comparison into $_rk_np: collapse repeated slashes and
# drop a trailing one, so ".../shims", ".../shims/", and "...//shims" all
# compare equal (what filepath.Clean gives the Go-side exclusion).
_rk_normpath() {
	_rk_np="$1"
	while :; do
		case "$_rk_np" in
		*//*) _rk_np="${_rk_np%%//*}/${_rk_np#*//}" ;;
		*) break ;;
		esac
	done
	case "$_rk_np" in
	/) ;;
	*/) _rk_np="${_rk_np%/}" ;;
	esac
}`

// tmuxShimTemplate is the script rendered by tmuxShimScript. Verbs are
// explicitly indexed so the rk path and the ownership marker can each appear
// twice without duplicating an argument:
//
//	%[1]s tmuxShimMarker        %[2]s rk path (absolute, validated)
//	%[3]d tmuxShimProbeAttempts %[4]s tmuxShimProbeInterval
//	%[5]s rkShimsRelDir         %[6]s tmuxShimNormPathFunc
//
// Three stages, in order: probe the embedded rk path, exec `rk mux guard`
// (the steady state — byte-identical behavior to the original one-line shim),
// or fail OPEN to the real tmux behind a crude backstop. See tmuxShimScript
// for why failing open is the right trade and which lines are load-bearing.
//
// Every literal `%` in this string is a format verb — a shell parameter
// expansion needing one (`${x%/}`) belongs in an argument like
// tmuxShimNormPathFunc, not inline.
const tmuxShimTemplate = `#!/bin/sh
# %[1]s
#
# Hands every PATH-resolved tmux invocation to rk mux guard, which refuses a
# bare kill-server (no -L/-S). rk sits behind a package-manager symlink that
# dangles for a few seconds during an upgrade, and this shim fronts EVERY tmux
# caller on the machine — so a hard failure here is a machine-wide tmux outage.
# Probe briefly, then fail OPEN to the real tmux.

# Every variable this script owns lives in the _rk_ namespace and is dropped
# before control is handed on. POSIX sh keeps the export attribute when
# assigning to a name the caller exported, so a generic name (n, real, c…)
# hands this script's own value to tmux — and tmux copies its starting
# environment into a new server's GLOBAL environment, where it would outlive
# the invocation for every future pane. unset inside a function is global in
# POSIX sh, so one list keeps both exec sites honest.
_rk_scrub() {
	unset _rk_path _rk_n _rk_ks _rk_sock _rk_a _rk_np _rk_shims _rk_real _rk_d _rk_c _rk_sniff _rk_ifs _rk_ifs_set
}

_rk_path="%[2]s"

# Wait out a transient dangling rk path (%[3]d probes, %[4]ss apart). The steady
# state tests once and never sleeps.
_rk_n=0
while [ ! -x "$_rk_path" ] && [ "$_rk_n" -lt %[3]d ]; do
	sleep %[4]s
	_rk_n=$((_rk_n + 1))
done

# NOTE: keep this the FIRST exec line in the script, with the rk path spelled
# LITERALLY — rk doctor reads the path back out of it (tmuxShimExecTarget).
if [ -x "$_rk_path" ]; then
	_rk_scrub
	exec "%[2]s" mux guard "$@"
fi

# rk is still unreachable. Best-effort backstop for the one shape the guard
# exists for: a literal bare kill-server with no -L/-S socket. Deliberately
# crude — tmux's argv grammar is NOT reimplemented here. The documented
# RK_TMUX_GUARD=off per-invocation hatch still applies. Checked BEFORE the
# fail-open notice so a refusal never also claims the guard was bypassed.
if [ "$RK_TMUX_GUARD" != off ]; then
	_rk_ks=0
	_rk_sock=0
	for _rk_a in "$@"; do
		case "$_rk_a" in
		kill-server) _rk_ks=1 ;;
		-L*|-S*) _rk_sock=1 ;;
		esac
	done
	if [ "$_rk_ks" = 1 ] && [ "$_rk_sock" = 0 ]; then
		echo "rk mux guard: BLOCKED: tmux kill-server without an explicit -L/-S socket (fallback guard — rk is unreachable at $_rk_path)." >&2
		echo "Re-run with an explicit socket:  tmux -L <scratch-name> kill-server" >&2
		exit 1
	fi
fi

%[6]s

# Resolve the real tmux the way findRealTmux does: skip empty PATH entries,
# skip the rk shims dir (compared after normalizing BOTH sides, so a trailing
# or doubled separator in $PATH or $HOME cannot smuggle the shims dir past the
# exclusion), and skip any candidate that sniffs as an rk shim. set -f keeps a
# PATH entry containing a glob character from being pathname-expanded during
# word splitting.
_rk_normpath "$HOME/%[5]s"
_rk_shims="$_rk_np"
_rk_real=""
# IFS is the caller's, not ours: it may be EXPORTED, in which case assigning
# to it hands the exec'd tmux our ":" (assignment keeps the export attribute —
# the same trap the _rk_ namespace exists for), and an unconditional unset
# would strip the caller's IFS from the environment entirely. Save the exact
# state — set-to-a-value and unset are distinct — and put it back below.
_rk_ifs_set="${IFS+1}"
_rk_ifs="$IFS"
set -f
IFS=:
for _rk_d in $PATH; do
	[ -n "$_rk_d" ] || continue
	_rk_normpath "$_rk_d"
	[ "$_rk_np" != "$_rk_shims" ] || continue
	_rk_c="$_rk_d/tmux"
	[ -f "$_rk_c" ] && [ -x "$_rk_c" ] || continue
	# grep exits 0 on a match, 1 on a clean miss, and >=2 (or 127) when the
	# sniff itself failed. Only a clean miss earns an exec: exec'ing a
	# relocated copy of THIS script would fork-loop forever, so a candidate
	# whose identity cannot be verified is skipped too. Refusing to resolve is
	# recoverable; a fork loop is not.
	grep -qF -e "%[1]s" -e tmux-guard "$_rk_c" 2>/dev/null
	_rk_sniff=$?
	[ "$_rk_sniff" -eq 1 ] || continue
	_rk_real="$_rk_c"
	break
done
if [ -n "$_rk_ifs_set" ]; then
	IFS="$_rk_ifs"
else
	unset IFS
fi
set +f

if [ -n "$_rk_real" ]; then
	# Move the resolved tmux into the positional parameters so the exec below
	# needs no variable of ours to survive the unset.
	set -- "$_rk_real" "$@"
	# The notice sits here, not before the walk: the no-real-tmux path below
	# must not first claim the invocation is running unguarded.
	echo "rk mux guard: $_rk_path is not executable (rk may be mid-upgrade) — running tmux unguarded for this invocation." >&2
	# RK_TMUX_GUARD goes too, for the same reason rk mux guard strips it
	# (tmuxGuardExecEnv): forwarding it through "tmux new-session -d" would bake
	# the per-invocation hatch into the new server's global environment, making
	# it permanent for every future pane.
	_rk_scrub
	unset RK_TMUX_GUARD
	exec "$@"
fi

echo "rk mux guard: no real tmux found on PATH (the rk shim itself is excluded); install tmux or fix PATH ordering." >&2
exit 1
`

// tmuxShimScript renders the shim installed at ~/.local/share/rk/shims/tmux.
// rkPath is the absolute run-kit binary path (resolved by resolveRkPath, the
// stable Homebrew symlink) — embedded rather than the bare name `rk` so the
// shim cannot break tmux in a shell where rk is off PATH at fire time,
// mirroring the agent-state hook's stable-path rationale. The path sits inside
// double quotes, so it MUST be pre-validated by validateHookPath (rejects
// ' " $ ` \); every other interpolated value is a compile-time constant, so
// nothing environment-derived is unvalidated (Constitution §I).
//
// The script is self-healing rather than a single exec, because the embedded
// path is only as stable as the package manager's symlink:
//
//   - Probe: when the rk path is not executable, poll it (see the probe
//     constants above) so an invocation landing inside an upgrade's relink
//     window stalls instead of exiting 127. An executable rk is tested once
//     and never sleeps, so the steady state is unchanged.
//   - Fail OPEN: after the budget, resolve the real tmux with a PATH walk
//     mirroring findRealTmux's exclusions and exec it. The guard catches
//     ACCIDENTAL kill-server; the chance of one firing inside a few-second
//     window is negligible next to the certainty of breaking every tmux caller
//     on the machine at every upgrade. Availability wins. The shell sniff is
//     deliberately MORE conservative than sniffsAsTmuxShim: it scans the whole
//     candidate rather than a 512-byte head, and skips any candidate it cannot
//     verify — a false skip degrades to a clear "no real tmux" error, while a
//     false accept would exec a relocated copy of this script and fork-loop.
//   - Backstop: before failing open, refuse the literal bare-kill-server shape
//     (a flat token scan, RK_TMUX_GUARD=off honored). Over- and under-blocking
//     are both acceptable on a path that only runs while rk is unreachable;
//     porting tmuxGuardBlocks to shell is not.
//
// Line order is load-bearing: tmuxShimExecTarget parses the FIRST exec line,
// and the fail-open path adds a second one.
//
// Environment hygiene is load-bearing too. Every shell variable is _rk_-prefixed
// and unset before each exec, because POSIX sh keeps the export attribute when
// assigning to a name the caller exported — an unprefixed `n` handed tmux `n=0`
// on the steady-state hot path. The fail-open exec additionally drops
// RK_TMUX_GUARD, mirroring tmuxGuardExecEnv's strip: tmux copies its starting
// environment into a new server's GLOBAL environment, so forwarding the hatch
// through `RK_TMUX_GUARD=off tmux new-session -d` would make it permanent for
// every future pane of that server — re-opening the exact death vector the
// guard exists to close.
func tmuxShimScript(rkPath string) string {
	return fmt.Sprintf(tmuxShimTemplate,
		tmuxShimMarker,
		rkPath,
		tmuxShimProbeAttempts,
		tmuxShimProbeInterval,
		rkShimsRelDir,
		tmuxShimNormPathFunc,
	)
}

// tmuxShimExecTarget extracts the absolute rk path embedded in an installed
// shim script: the value between the first double-quote pair on its FIRST
// `exec` line. tmuxShimScript pins that line to the literal rk path (its
// fail-open stage execs the real tmux from a variable further down, so
// first-match semantics are what keep this pointing at rk) — and
// validateHookPath guarantees the path itself contains no quote. Returns ""
// when no such line exists — the shim then has no parseable exec target and
// cannot work. Doctor uses this to verify the embedded rk binary still exists
// (a permanently dangling path — e.g. after a brew rename — degrades EVERY
// tmux command on the machine to the shim's unguarded fallback).
func tmuxShimExecTarget(content string) string {
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "exec ") {
			continue
		}
		first := strings.IndexByte(line, '"')
		if first < 0 {
			continue
		}
		rest := line[first+1:]
		second := strings.IndexByte(rest, '"')
		if second < 0 {
			continue
		}
		return rest[:second]
	}
	return ""
}

// rkShimsDir is the directory rk agent setup installs PATH shims into, and the
// directory the guard skips when resolving the real tmux.
func rkShimsDir(home string) string {
	return filepath.Join(home, filepath.FromSlash(rkShimsRelDir))
}

// rkBinDir is the per-machine pointer directory for a given home.
func rkBinDir(home string) string {
	return filepath.Dir(selfpath.LauncherFor(home))
}

// --- guard decision ---------------------------------------------------------

// parseTmuxGlobalFlags scans the global-flag window of a tmux argv: the tokens
// before the first command word. It reports whether an explicit -L/-S socket
// flag is present and returns the index of the first command-word token.
//
// Grammar mirrored: flags may be clustered (-2uLfoo); a value flag consumes
// the remainder of its token or, when it ends the token, the next token; a
// bare `--` ends flag parsing. Parsing deliberately stops at the first
// non-flag token (the BSD-getopt view): glibc getopt would permute a
// post-command `-L` into the global window on Linux, but crediting that would
// require emulating a platform quirk — and mis-parsing in this direction only
// ever produces a false-positive block whose message states the canonical
// remedy (see plan Design Decisions).
func parseTmuxGlobalFlags(args []string) (explicitSocket bool, commandStart int) {
	i := 0
	for i < len(args) {
		tok := args[i]
		if tok == "--" {
			return explicitSocket, i + 1
		}
		if len(tok) < 2 || tok[0] != '-' {
			return explicitSocket, i
		}
		chars := tok[1:]
		valueInNextToken := false
		for j := 0; j < len(chars); j++ {
			c := chars[j]
			if c == 'L' || c == 'S' {
				explicitSocket = true
			}
			if strings.IndexByte(tmuxGlobalValueFlags, c) >= 0 {
				// Value flag: the rest of this token is the value, or the next
				// token when nothing follows in this one.
				valueInNextToken = j == len(chars)-1
				break
			}
		}
		i++
		if valueInNextToken && i < len(args) {
			i++ // skip the flag's value token
		}
	}
	return explicitSocket, i
}

// tmuxCommandWords extracts the command word (first token) of every command in
// a tmux command chain, mirroring tmux cmd_parse_from_arguments semantics:
//
//   - a token that is exactly ";" terminates the current command;
//   - a token ending in an unescaped ";" has the semicolon stripped, stays part
//     of the CURRENT command, and terminates it;
//   - a token ending in "\;" carries a literal ";" and does not terminate.
//
// Every non-first token of a command is data (send-keys strings, targets, key
// names) and is never treated as a command word — which is exactly what keeps
// `send-keys 'tmux kill-server' Enter` from false-triggering the guard while
// `new-window \; kill-server` is still caught.
func tmuxCommandWords(tokens []string) []string {
	var words []string
	startOfCommand := true
	for _, tok := range tokens {
		if tok == ";" {
			startOfCommand = true
			continue
		}
		word := tok
		terminates := false
		if strings.HasSuffix(word, ";") {
			trimmed := word[:len(word)-1]
			if strings.HasSuffix(trimmed, `\`) {
				word = trimmed[:len(trimmed)-1] + ";" // escaped: literal semicolon
			} else {
				word = trimmed
				terminates = true
			}
		}
		if startOfCommand && word != "" {
			words = append(words, word)
			startOfCommand = false
		}
		if terminates {
			startOfCommand = true
		}
	}
	return words
}

// isKillServerWord reports whether a command word names kill-server, including
// tmux's unambiguous-prefix resolution ("kill-ser" and longer — shorter
// prefixes are ambiguous with kill-session and rejected by tmux itself).
func isKillServerWord(word string) bool {
	return len(word) >= tmuxKillServerMinAbbr && strings.HasPrefix(tmuxKillServerCommand, word)
}

// tmuxGuardBlocks is the guard's decision function, pure over the tmux argv
// (everything after `rk mux guard`): blocked ⇔ some command word in the chain
// names kill-server AND no explicit -L/-S socket flag is present.
func tmuxGuardBlocks(args []string) bool {
	explicitSocket, commandStart := parseTmuxGlobalFlags(args)
	if explicitSocket {
		return false
	}
	for _, word := range tmuxCommandWords(args[commandStart:]) {
		if isKillServerWord(word) {
			return true
		}
	}
	return false
}

// --- real tmux resolution -----------------------------------------------------

// tmuxShimSniffLimit bounds how much of a candidate binary head is read when
// sniffing for the shim marker — the shim script is tiny, so its markers
// always sit within the first few hundred bytes.
const tmuxShimSniffLimit = 512

// findRealTmux resolves the real tmux binary from pathEnv (a PATH-style list),
// skipping the shim so the guard never execs itself:
//
//   - directory entries equal to shimDir are skipped (the installed layout);
//   - any candidate whose head sniffs as the rk shim is skipped regardless of
//     location (defense against a relocated shim copy — resolving it would
//     exec-loop shim → rk mux guard → shim forever);
//   - empty PATH entries (POSIX cwd) are skipped — the real tmux is never
//     resolved from the current directory.
//
// The first surviving executable regular file named "tmux" wins.
func findRealTmux(pathEnv, shimDir string) (string, error) {
	cleanShimDir := filepath.Clean(shimDir)
	for _, dir := range filepath.SplitList(pathEnv) {
		if dir == "" {
			continue
		}
		if shimDir != "" && filepath.Clean(dir) == cleanShimDir {
			continue
		}
		candidate := filepath.Join(dir, "tmux")
		info, err := os.Stat(candidate)
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
			continue
		}
		if sniffsAsTmuxShim(candidate) {
			continue
		}
		return candidate, nil
	}
	return "", fmt.Errorf("rk mux guard: no real tmux found on PATH (the rk shim itself is excluded); install tmux or fix PATH ordering")
}

// sniffsAsTmuxShim reports whether the head of a candidate file identifies it
// as the rk tmux shim (by ownership marker, or by the retained `tmux-guard`
// literal that old-generation shims exec — kept to catch installed pre-move
// copies). Read errors report false — the exec attempt will surface them.
func sniffsAsTmuxShim(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	buf := make([]byte, tmuxShimSniffLimit)
	n, err := io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return false
	}
	head := string(buf[:n])
	return strings.Contains(head, tmuxShimMarker) || strings.Contains(head, "tmux-guard")
}

// --- command ------------------------------------------------------------------

// tmuxGuardExec is the process-replacing exec seam, injectable so unit tests
// never execute a real binary (they capture the argv instead). Production is
// syscall.Exec: on success it never returns — the guard process IS tmux from
// that point, so stdio, signals, and the exit code are inherently preserved.
var tmuxGuardExec = syscall.Exec

// tmuxGuardExecEnv builds the environment handed to the real tmux: the current
// environment with $TMUX restored from tmux.OriginalTMUX and RK_TMUX_GUARD
// stripped.
//
// TMUX restore: internal/tmux's init() runs os.Unsetenv("TMUX") process-wide
// (so the daemon's bare tmux subprocess calls target the default socket) and
// fires before RunE ever runs here — exec'ing with the stripped os.Environ()
// would hand the real tmux an env with NO $TMUX, silently retargeting every
// shimmed bare tmux command from the pane's own server to the DEFAULT server:
// the exact inversion of the guard's safety goal (and RK_TMUX_GUARD=off
// kill-server would destroy the wrong server). Mirrors riff's childEnv
// restoration. When the caller had no $TMUX, nothing is restored — the env
// stays TMUX-free, matching a direct tmux invocation.
//
// RK_TMUX_GUARD strip: the escape hatch must never outlive its one invocation.
// When a server is STARTED under the hatch (`RK_TMUX_GUARD=off tmux
// new-session -d`), tmux copies the starting environment into the new server's
// GLOBAL environment, so every future pane of that server would inherit
// RK_TMUX_GUARD=off and a later bare kill-server from any of them would sail
// through the guard — the "per-invocation" hatch made transitively permanent.
// Stripping the variable before exec keeps the hatch scoped to exactly the
// command it was typed on (on the normal pass path there is nothing meaningful
// to forward anyway — the variable is the guard's own control knob, not
// tmux's).
func tmuxGuardExecEnv() []string {
	source := os.Environ()
	env := make([]string, 0, len(source)+1)
	for _, kv := range source {
		if strings.HasPrefix(kv, rkTmuxGuardEnvVar+"=") {
			continue
		}
		env = append(env, kv)
	}
	if tmux.OriginalTMUX != "" {
		env = append(env, "TMUX="+tmux.OriginalTMUX)
	}
	return env
}

// runTmuxGuard decides and (on pass) execs the real tmux. All failure paths
// return *exitCodeError so the cobra wrapper prints the message verbatim
// (multi-line, no "Error:" prefix) and exits with the carried code.
func runTmuxGuard(args []string) error {
	shimDir := ""
	if home, err := os.UserHomeDir(); err == nil {
		shimDir = rkShimsDir(home)
	}
	// Escape hatch first: RK_TMUX_GUARD=off means no decision and no message.
	if os.Getenv(rkTmuxGuardEnvVar) != rkTmuxGuardOff && tmuxGuardBlocks(args) {
		return &exitCodeError{code: 1, msg: tmuxGuardBlockedMessage}
	}
	realTmux, err := findRealTmux(os.Getenv("PATH"), shimDir)
	if err != nil {
		return &exitCodeError{code: 1, msg: err.Error()}
	}
	argv := append([]string{realTmux}, args...)
	if err := tmuxGuardExec(realTmux, argv, tmuxGuardExecEnv()); err != nil {
		return &exitCodeError{code: 1, msg: fmt.Sprintf("rk mux guard: exec %s: %v", realTmux, err)}
	}
	return nil
}

// newTmuxGuardCmd builds one guard command instance (the newAgentHookCmd /
// newReapCmd precedent — a cobra command object cannot have two parents, so the
// family member and the permanent root alias are two instances sharing the
// untouched runTmuxGuard core).
func newTmuxGuardCmd(use string) *cobra.Command {
	return &cobra.Command{
		Use:   use,
		Short: "Front the real tmux binary, blocking bare kill-server",
		Long: "Guard wrapper installed in front of the real tmux binary (via the PATH shim " +
			"written by `rk agent setup`). A `kill-server` invocation without an explicit " +
			"-L/-S socket is refused with an explanation of the socket-resolution trap " +
			"(-L/-S > $TMUX > TMUX_TMPDIR); every other invocation execs the real tmux " +
			"verbatim, preserving argv, stdio, and exit code. Set RK_TMUX_GUARD=off to " +
			"bypass the guard for one invocation.",
		// tmux flags (-L, -S, -2, …) must reach the guard verbatim, never be parsed
		// as cobra flags — DisableFlagParsing hands the raw argv to RunE.
		Args:               cobra.ArbitraryArgs,
		DisableFlagParsing: true,
		SilenceUsage:       true,
		SilenceErrors:      true,
		RunE: func(cmd *cobra.Command, args []string) error {
			err := runTmuxGuard(args)
			if err == nil {
				return nil
			}
			// Every runTmuxGuard failure is an *exitCodeError; print its message
			// verbatim (the BLOCKED refusal is multi-line and must not gain cobra's
			// "Error:" prefix) and exit with the carried code — the shell-init
			// pattern. Errors are actionable detail and always survive --quiet.
			var ece *exitCodeError
			if errors.As(err, &ece) {
				fmt.Fprintln(cmd.ErrOrStderr(), ece.msg)
				exitRecorded(err, ece.code)
				return nil
			}
			return err
		},
	}
}

var (
	// muxGuardFamilyCmd is the `rk mux guard` family member.
	muxGuardFamilyCmd = newTmuxGuardCmd("guard [tmux args...]")
	// tmuxGuardAliasCmd is the PERMANENT hidden root alias: installed PATH shims
	// carry the literal `tmux-guard` invocation frozen at install time, fronting
	// every PATH-resolved tmux call on the machine, so this form must resolve —
	// silently — FOREVER (cli-layering.md delegation rule 3: machine-invoked
	// entry points are contracts). It is NOT deprecated and MUST NOT warn, and
	// no cleanup sweep may remove it.
	tmuxGuardAliasCmd = func() *cobra.Command {
		c := newTmuxGuardCmd("tmux-guard [tmux args...]")
		c.Hidden = true
		return c
	}()
)
