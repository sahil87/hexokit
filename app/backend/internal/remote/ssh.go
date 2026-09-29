package remote

import (
	"context"
	"fmt"
	"net/url"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"rk/internal/updatecheck"
)

// Timeouts for the ssh-exec steps. Each remote command runs under its own
// exec.CommandContext deadline (Constitution I — timeouts live at call sites).
const (
	// sshProbeTimeout bounds quick remote queries (rk --version, rk url,
	// rk daemon status). ConnectTimeout=5 bounds the TCP setup inside it.
	sshProbeTimeout = 20 * time.Second
	// sshInstallTimeout bounds the curl-install bootstrap — a brew install on
	// a cold box legitimately takes minutes.
	sshInstallTimeout = 5 * time.Minute
	// sshDaemonStartTimeout bounds the remote `rk daemon start` (tmux work).
	sshDaemonStartTimeout = 60 * time.Second
	// stderrTailLines caps how much remote stderr an error message carries.
	stderrTailLines = 5
)

// remotePathPrefix is prepended to every remote rk invocation: ssh exec runs
// a non-interactive (usually non-login) shell whose PATH often misses the
// Homebrew/linuxbrew bin dirs, so a brew-installed rk — and the tmux binary
// the remote `rk daemon start` needs — would not resolve. Fixed literal, the
// remote-side mirror of the desktop shell's augmentPath GUI-PATH fix.
const remotePathPrefix = `PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin"`

// Fixed remote command strings. These are literals — nothing user-provided is
// ever interpolated into a remote command (the target rides as its own argv
// element on the ssh invocation).
const (
	remoteVersionCmd     = remotePathPrefix + " rk --version"
	remoteURLCmd         = remotePathPrefix + " rk url"
	remoteDaemonStartCmd = remotePathPrefix + " rk daemon start"
	remoteDaemonJSONCmd  = remotePathPrefix + " rk daemon status --json"
	// remoteInstallCmd is the project's standard public install step — the
	// same command docs/site/install.md documents. Not scp, not a bespoke
	// installer.
	remoteInstallCmd = "curl -fsSL https://shll.ai/install | sh -s -- run-kit"
)

// execResult carries a completed subprocess run for classification.
type execResult struct {
	stdout   string
	stderr   string
	exitCode int // -1 when the process did not run/exit normally
	err      error
}

// runCmdFn is the subprocess seam — tests substitute it to script ssh
// behavior without a network. The default runs the command via
// exec.CommandContext under the caller's (already deadline-bounded) context.
var runCmdFn = runCmdImpl

func runCmdImpl(ctx context.Context, name string, args ...string) execResult {
	cmd := exec.CommandContext(ctx, name, args...)
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	code := 0
	if err != nil {
		code = -1
		if exitErr, ok := err.(*exec.ExitError); ok {
			code = exitErr.ExitCode()
		}
	}
	return execResult{stdout: stdout.String(), stderr: stderr.String(), exitCode: code, err: err}
}

// sshExec runs a fixed remote command string on target over ssh, under a
// fresh timeout-bounded context. Every probe/bootstrap invocation is
// non-interactive (BatchMode=yes — v1 has no interactive auth) with a bounded
// TCP setup (ConnectTimeout=5). The tunnel command deliberately does NOT go
// through here: its argv is the byte-exact spec in tunnelArgs.
func sshExec(ctx context.Context, target, remoteCmd string, timeout time.Duration) execResult {
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return runCmdFn(runCtx, "ssh",
		"-o", "BatchMode=yes",
		"-o", "ConnectTimeout=5",
		target, remoteCmd)
}

// sshUnreachable classifies an ssh-level failure: ssh itself exits 255 when
// the connection or authentication fails (a remote command's own exit code
// passes through as anything else).
func sshUnreachable(res execResult) bool {
	return res.exitCode == 255
}

// rkMissing classifies "rk is not installed on the remote": the remote shell
// exits 127 for an unknown command; the stderr fallback matches only the
// shell's exact "command not found" diagnostic (a bare "not found" substring
// would let unrelated stderr — a missing config file, say — trigger a
// spurious installer run).
func rkMissing(res execResult) bool {
	if res.exitCode == 127 {
		return true
	}
	return res.err != nil && strings.Contains(res.stderr, "command not found")
}

// authFailureError builds the actionable BatchMode failure: the stderr tail
// plus the hint to run `ssh <target>` once from a terminal (key setup /
// host-key trust happen there — StrictHostKeyChecking is never weakened).
func authFailureError(target string, res execResult) error {
	tail := stderrTail(res.stderr)
	if tail != "" {
		tail = ":\n" + tail
	}
	return fmt.Errorf("ssh to %s failed non-interactively%s\nHint: run `ssh %s` once from a terminal to set up keys and host trust, then retry", target, tail, target)
}

// stderrTail returns the last few non-empty lines of captured stderr.
func stderrTail(stderr string) string {
	var lines []string
	for _, l := range strings.Split(stderr, "\n") {
		if strings.TrimSpace(l) != "" {
			lines = append(lines, strings.TrimRight(l, "\r"))
		}
	}
	if len(lines) > stderrTailLines {
		lines = lines[len(lines)-stderrTailLines:]
	}
	return strings.Join(lines, "\n")
}

// versionPattern extracts a semver-ish token from `rk --version` output
// ("run-kit version v3.12.7" → "3.12.7") — the Go mirror of the desktop
// shell's parseRkVersion.
var versionPattern = regexp.MustCompile(`\bv?(\d+\.\d+\.\d+\S*)`)

// parseRemoteVersion returns the bare version from `rk --version` output, or
// "" when unrecognizable.
func parseRemoteVersion(output string) string {
	m := versionPattern.FindStringSubmatch(output)
	if m == nil {
		return ""
	}
	return m[1]
}

// comparableVersion reports whether v carries a comparable numeric version —
// a "dev" (non-ldflags) build or an unparseable string cannot anchor a skew
// decision.
func comparableVersion(v string) bool {
	return parseRemoteVersion(v) != ""
}

// VersionOlder reports whether the remote rk is older than the local one —
// the only skew direction connect acts on (the installer installs latest;
// connect never downgrades). Either side lacking a comparable version means
// "no actionable skew". Exported for the CLI's status output.
func VersionOlder(remoteVersion, localVersion string) bool {
	if !comparableVersion(remoteVersion) || !comparableVersion(localVersion) {
		return false
	}
	return updatecheck.AnyIncrease(parseRemoteVersion(remoteVersion), parseRemoteVersion(localVersion))
}

// VersionNewer reports whether the remote rk is newer than the local one —
// never acted on, only noted in status output.
func VersionNewer(remoteVersion, localVersion string) bool {
	if !comparableVersion(remoteVersion) || !comparableVersion(localVersion) {
		return false
	}
	return updatecheck.AnyIncrease(parseRemoteVersion(localVersion), parseRemoteVersion(remoteVersion))
}

// parseRemotePort extracts the port from a remote `rk url` line
// ("http://127.0.0.1:6123"). The origin itself is derived state — used for
// the -L forward spec and never stored (Constitution II).
func parseRemotePort(output string) (int, error) {
	raw := strings.TrimSpace(output)
	// rk url prints exactly one line; tolerate surrounding chatter defensively
	// by taking the first field that parses as a URL.
	for _, field := range strings.Fields(raw) {
		u, err := url.Parse(field)
		if err != nil || u.Port() == "" {
			continue
		}
		p, err := strconv.Atoi(u.Port())
		if err != nil {
			continue
		}
		return p, nil
	}
	return 0, fmt.Errorf("remote `rk url` printed %q — expected an http origin with a port", raw)
}

// daemonUpMarker substrings: a remote `rk daemon start` that fails because
// the daemon is already running — or because something is already serving the
// configured port — means the server side is up, which is connect's goal.
func remoteDaemonAlreadyUp(res execResult) bool {
	combined := res.stdout + res.stderr
	return strings.Contains(combined, "daemon already running") ||
		strings.Contains(combined, "already serving on")
}
