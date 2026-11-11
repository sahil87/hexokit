package autostart

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"rk/internal/fsatomic"
)

// systemdUnitName is the user unit `on` writes and `off` removes. It names
// the product, not the binary (rk ↔ run-kit has drifted before), because off
// must find the same file forever.
const systemdUnitName = "hexokit-daemon.service"

const (
	systemdCtlTimeout = 10 * time.Second
	// systemdRestartTimeout bounds `on --now`: restart blocks for the whole
	// oneshot, which the unit itself caps with TimeoutStartSec.
	systemdRestartTimeout = 120 * time.Second
	systemdLookupTimeout  = 5 * time.Second

	// systemdBootedPath exists exactly when systemd is PID 1 (sd_booted(3)).
	systemdBootedPath    = "/run/systemd/system"
	systemdFallbackShell = "/bin/sh"
)

// systemdInjectedEnv are the variables systemd sets in every service process.
// Unstripped, they land in the rk-daemon tmux server's global environment and
// so in every agent (S1 findings, environment item 3).
var systemdInjectedEnv = []string{
	"INVOCATION_ID",
	"JOURNAL_STREAM",
	"MANAGERPID",
	"SYSTEMD_EXEC_PID",
	"MEMORY_PRESSURE_WATCH",
	"MEMORY_PRESSURE_WRITE",
}

var systemdErrMissing = errors.New("daemon autostart: systemd not found — on Linux, autostart needs a systemd user manager (systemctl --user)")

// systemdUnitTemplate is the S1 winning shape L7: oneshot + RemainAfterExit so the
// unit reads active after `rk daemon start` exits, KillMode=process so neither
// stop nor a start timeout ever kills the tmux server it births, and no
// Restart= — the OS starts the daemon once and never supervises it.
// TimeoutStartSec bounds a login profile that blocks (oneshot has no start
// timeout by default).
const systemdUnitTemplate = `# %s — rewritten by ` + "`rk daemon autostart on`" + `, removed by ` + "`off`" + `. Do not edit.
[Unit]
Description=HexoKit daemon (started once at boot/login, not supervised)

[Service]
Type=oneshot
RemainAfterExit=yes
KillMode=process
TimeoutStartSec=90
ExecStart=%s -lc "%s"

[Install]
WantedBy=default.target
`

// systemdRunFunc runs one bounded subprocess and returns its stdout. A non-zero exit
// returns the stdout read so far together with the error.
type systemdRunFunc func(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, error)

// systemd is the Linux backend: a per-user systemd unit. Every OS touchpoint
// is a field so tests run no real systemctl/loginctl/getent and write only
// under a temp dir.
type systemd struct {
	run        systemdRunFunc
	configDir  func() (string, error)
	username   func() (string, error)
	lookPath   func(string) (string, error)
	booted     func() bool
	rkPath     func() (string, error)
	getenv     func(string) string
	executable func(string) bool
}

func init() {
	Register("linux", func() Backend { return newSystemd() })
}

func newSystemd() *systemd {
	return &systemd{
		run:        systemdExecRun,
		configDir:  os.UserConfigDir,
		username:   systemdCurrentUsername,
		lookPath:   exec.LookPath,
		booted:     func() bool { return systemdIsDir(systemdBootedPath) },
		rkPath:     RKPath,
		getenv:     os.Getenv,
		executable: systemdIsExecutable,
	}
}

func systemdExecRun(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		call := strings.Join(append([]string{name}, args...), " ")
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return out, fmt.Errorf("%s: %w: %s", call, err, msg)
		}
		return out, fmt.Errorf("%s: %w", call, err)
	}
	return out, nil
}

func systemdCurrentUsername() (string, error) {
	u, err := user.Current()
	if err != nil {
		return "", fmt.Errorf("looking up the current user: %w", err)
	}
	return u.Username, nil
}

func systemdIsDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func systemdIsExecutable(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0
}

func (s *systemd) On(ctx context.Context, opts OnOptions) (Result, error) {
	if err := s.preflight(); err != nil {
		return Result{}, err
	}
	path, err := s.unitPath()
	if err != nil {
		return Result{}, err
	}
	res := Result{Name: systemdUnitName, Path: path}
	username, err := s.username()
	if err != nil {
		return res, err
	}
	shell, err := s.loginShell(ctx, username)
	if err != nil {
		return res, err
	}
	rk, err := s.rkPath()
	if err != nil {
		return res, fmt.Errorf("resolving the rk path: %w", err)
	}
	unit, err := systemdRenderUnit(shell, rk)
	if err != nil {
		return res, err
	}

	written, err := systemdWriteUnit(path, unit)
	if err != nil {
		return res, err
	}
	if written {
		if _, err := s.systemctl(ctx, systemdCtlTimeout, "daemon-reload"); err != nil {
			return res, err
		}
	}
	wasEnabled := s.isEnabled(ctx)
	if !wasEnabled {
		if _, err := s.systemctl(ctx, systemdCtlTimeout, "enable", systemdUnitName); err != nil {
			return res, err
		}
	}
	res.Changed = written || !wasEnabled

	// restart, not start: a bare start on an already-active RemainAfterExit
	// unit is a no-op, while restart re-runs ExecStart — and with
	// --if-not-running that is a success that touches nothing when the daemon
	// is already up.
	if opts.Now {
		if _, err := s.systemctl(ctx, systemdRestartTimeout, "restart", systemdUnitName); err != nil {
			return res, err
		}
		res.Started = true
	}
	res.Hints = systemdHints(username, shell, s.linger(ctx, username))
	return res, nil
}

// Off disables and deletes the unit. It never runs stop: the daemon the unit
// started keeps running, and even a stop under KillMode=process would leave
// the tmux server alive.
func (s *systemd) Off(ctx context.Context) (Result, error) {
	if err := s.preflight(); err != nil {
		return Result{}, err
	}
	path, err := s.unitPath()
	if err != nil {
		return Result{}, err
	}
	res := Result{Name: systemdUnitName, Path: path}
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return res, nil
	}
	if err != nil {
		return res, fmt.Errorf("reading %s: %w", path, err)
	}
	if !systemdIsManaged(data) {
		return res, systemdForeignError(path)
	}
	if _, err := s.systemctl(ctx, systemdCtlTimeout, "disable", systemdUnitName); err != nil {
		return res, err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return res, fmt.Errorf("removing %s: %w", path, err)
	}
	if _, err := s.systemctl(ctx, systemdCtlTimeout, "daemon-reload"); err != nil {
		return res, err
	}
	res.Changed = true
	return res, nil
}

// Status reports the registration. Probes that fail (loginctl without a
// session, a unit systemd never loaded) degrade their field instead of
// failing the verb.
func (s *systemd) Status(ctx context.Context) (Status, error) {
	if err := s.preflight(); err != nil {
		return Status{}, err
	}
	path, err := s.unitPath()
	if err != nil {
		return Status{}, err
	}
	st := Status{Platform: "linux", Manager: "systemd", Name: systemdUnitName, Path: path}
	username, err := s.username()
	if err != nil {
		return st, err
	}

	shell, shellErr := s.loginShell(ctx, username)
	if shellErr != nil {
		st.Hints = append(st.Hints, shellErr.Error())
	}
	st.Shell = shell
	rk, rkErr := s.rkPath()
	if rkErr != nil {
		st.Hints = append(st.Hints, "cannot resolve the rk path: "+rkErr.Error())
	}
	st.RKPath = rk

	data, err := os.ReadFile(path)
	st.Registered = err == nil && systemdIsManaged(data)
	if st.Registered && shellErr == nil && rkErr == nil {
		if want, err := systemdRenderUnit(shell, rk); err == nil && want != string(data) {
			st.Stale = true
			st.Hints = append(st.Hints, "the unit differs from what `rk daemon autostart on` would write now (the rk path or login shell changed): re-run it to refresh")
		}
	}

	st.Enabled = s.isEnabled(ctx)
	st.LastResult, st.LastExitCode = s.lastRun(ctx)
	st.Linger = s.linger(ctx, username)
	if st.Registered && st.Enabled {
		st.StartsAt = StartsAtLogin
		if st.Linger != nil && *st.Linger {
			st.StartsAt = StartsAtBoot
		}
	}
	if st.Registered {
		st.Hints = append(st.Hints, systemdHints(username, shell, st.Linger)...)
	}
	return st, nil
}

func (s *systemd) preflight() error {
	if _, err := s.lookPath("systemctl"); err != nil || !s.booted() {
		return systemdErrMissing
	}
	return nil
}

func (s *systemd) unitPath() (string, error) {
	dir, err := s.configDir()
	if err != nil {
		return "", fmt.Errorf("resolving the config dir: %w", err)
	}
	return filepath.Join(dir, "systemd", "user", systemdUnitName), nil
}

func (s *systemd) systemctl(ctx context.Context, timeout time.Duration, args ...string) ([]byte, error) {
	return s.run(ctx, timeout, "systemctl", append([]string{"--user"}, args...)...)
}

// isEnabled reads `is-enabled`, which exits non-zero for disabled and
// not-found units — those are answers, not failures.
func (s *systemd) isEnabled(ctx context.Context) bool {
	out, _ := s.systemctl(ctx, systemdCtlTimeout, "is-enabled", systemdUnitName)
	return strings.TrimSpace(string(out)) == "enabled"
}

// lastRun returns the unit's last Result and main-process exit code, or
// ("", nil) when the unit has not run since the user manager started.
func (s *systemd) lastRun(ctx context.Context) (string, *int) {
	out, err := s.systemctl(ctx, systemdCtlTimeout, "show", systemdUnitName,
		"-p", "Result", "-p", "ExecMainStatus", "-p", "ExecMainStartTimestampMonotonic")
	if err != nil {
		return "", nil
	}
	props := systemdParseProperties(out)
	if started := props["ExecMainStartTimestampMonotonic"]; started == "" || started == "0" {
		return "", nil
	}
	var code *int
	if n, err := strconv.Atoi(props["ExecMainStatus"]); err == nil {
		code = &n
	}
	return props["Result"], code
}

func systemdParseProperties(out []byte) map[string]string {
	props := map[string]string{}
	for _, line := range strings.Split(string(out), "\n") {
		if k, v, ok := strings.Cut(strings.TrimSpace(line), "="); ok {
			props[k] = v
		}
	}
	return props
}

// linger returns nil when logind cannot answer (no session, no logind).
func (s *systemd) linger(ctx context.Context, username string) *bool {
	out, err := s.run(ctx, systemdLookupTimeout, "loginctl", "show-user", username, "-p", "Linger", "--value")
	if err != nil {
		return nil
	}
	switch strings.TrimSpace(string(out)) {
	case "yes":
		on := true
		return &on
	case "no":
		off := false
		return &off
	}
	return nil
}

// systemdHints is the advice both on and status print: how to get a
// boot-time start, and which profile the login shell actually reads.
func systemdHints(username, shell string, linger *bool) []string {
	var hints []string
	switch {
	case linger == nil:
		hints = append(hints, "cannot read the lingering state (loginctl); without lingering the daemon starts at login, not at boot")
	case !*linger:
		hints = append(hints, "lingering is off, so the daemon starts at login, not at boot; to start it at boot run: loginctl enable-linger "+username)
	}
	if shell != "" {
		hints = append(hints, systemdProfileHint(shell))
	}
	return hints
}

// systemdProfileHint names the files a non-interactive login shell reads: exports
// kept only in the interactive rc file never reach the daemon or its agents,
// and an rc-only TMUX_TMPDIR splits the tmux socket path.
func systemdProfileHint(shell string) string {
	const what = "keep PATH, credentials and TMUX_TMPDIR exports there"
	switch base := filepath.Base(shell); base {
	case "zsh":
		return "the daemon starts through `zsh -l`, which reads ~/.zprofile but not ~/.zshrc: " + what
	case "bash":
		return "the daemon starts through `bash -l`, which reads ~/.bash_profile or ~/.profile but not ~/.bashrc: " + what
	default:
		return "the daemon starts through `" + base + " -l` (a non-interactive login shell): exports made only for interactive shells are not seen; " + what + " in your login profile"
	}
}

// loginShell resolves the user's shell from the passwd database (getent also
// covers NSS/LDAP accounts), not from $SHELL, which reflects whatever shell
// ran rk; $SHELL and /bin/sh are only fallbacks.
func (s *systemd) loginShell(ctx context.Context, username string) (string, error) {
	shell := ""
	if out, err := s.run(ctx, systemdLookupTimeout, "getent", "passwd", username); err == nil {
		shell = systemdPasswdShell(out)
	}
	if shell == "" {
		shell = s.getenv("SHELL")
	}
	if shell == "" {
		shell = systemdFallbackShell
	}
	if err := systemdCheckShell(shell); err != nil {
		return "", err
	}
	if !s.executable(shell) {
		return "", fmt.Errorf("login shell %s is not an executable file", shell)
	}
	return shell, nil
}

// systemdPasswdShell returns field 7 of the first passwd line, or "".
func systemdPasswdShell(out []byte) string {
	line, _, _ := strings.Cut(strings.TrimSpace(string(out)), "\n")
	fields := strings.Split(line, ":")
	if len(fields) < 7 {
		return ""
	}
	return strings.TrimSpace(fields[6])
}

func systemdCheckShell(shell string) error {
	if err := systemdCheckPath("login shell", shell); err != nil {
		return err
	}
	if strings.ContainsAny(shell, " \t") {
		return fmt.Errorf("login shell %q contains whitespace", shell)
	}
	switch filepath.Base(shell) {
	case "nologin", "false":
		return fmt.Errorf("login shell %s does not run commands; set a real shell with chsh first", shell)
	}
	return nil
}

// systemdCheckPath admits only absolute paths free of control characters: a
// newline would end the ExecStart line and inject unit directives.
func systemdCheckPath(what, p string) error {
	if !filepath.IsAbs(p) {
		return fmt.Errorf("%s %q is not an absolute path", what, p)
	}
	for _, r := range p {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("%s %q contains a control character", what, p)
		}
	}
	return nil
}

// systemdRenderUnit produces the unit file byte-for-byte. Pure, so Status can compare
// a fresh render against the file on disk.
func systemdRenderUnit(shell, rkPath string) (string, error) {
	if err := systemdCheckShell(shell); err != nil {
		return "", err
	}
	if err := systemdCheckPath("rk path", rkPath); err != nil {
		return "", err
	}
	script := StartScript(rkPath, systemdInjectedEnv)
	return fmt.Sprintf(systemdUnitTemplate, ManagedMarker, systemdEscape(shell), systemdEscape(script)), nil
}

var systemdEscaper = strings.NewReplacer(`\`, `\\`, `"`, `\"`, `%`, `%%`, `$`, `$$`)

// systemdEscape makes s literal inside an ExecStart double-quoted word:
// systemd C-unescapes backslashes and quotes, expands %-specifiers and
// $VARIABLES, so each is doubled or escaped.
func systemdEscape(s string) string {
	return systemdEscaper.Replace(s)
}

func systemdIsManaged(data []byte) bool {
	return bytes.Contains(data, []byte(ManagedMarker))
}

func systemdForeignError(path string) error {
	return fmt.Errorf("%s exists and is not managed by rk daemon autostart; remove or rename it first", path)
}

// systemdWriteUnit writes unit to path unless the file already holds exactly those
// bytes, and reports whether it wrote. It refuses to overwrite a file it did
// not generate.
func systemdWriteUnit(path, unit string) (bool, error) {
	existing, err := os.ReadFile(path)
	switch {
	case err == nil && !systemdIsManaged(existing):
		return false, systemdForeignError(path)
	case err == nil && string(existing) == unit:
		return false, nil
	case err != nil && !errors.Is(err, fs.ErrNotExist):
		return false, fmt.Errorf("reading %s: %w", path, err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return false, fmt.Errorf("creating %s: %w", filepath.Dir(path), err)
	}
	if err := fsatomic.WriteFile(path, []byte(unit), 0o644); err != nil {
		return false, fmt.Errorf("writing %s: %w", path, err)
	}
	return true, nil
}
