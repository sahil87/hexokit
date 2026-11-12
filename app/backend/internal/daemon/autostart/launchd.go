package autostart

import (
	"bufio"
	"bytes"
	"context"
	"encoding/xml"
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

	"rk/internal/apphome"
	"rk/internal/fsatomic"
)

// The macOS backend: a per-user LaunchAgent in the gui/<uid> domain, run once
// at login (RunAtLoad) and never kept alive. A boot-time LaunchDaemon would
// run as root, which the autostart plan rules out, so macOS only ever starts
// at login.
const (
	launchdLabel         = "ai.shll.hexokit.daemon"
	launchdAgentsRelDir  = "Library/LaunchAgents"
	launchdLogName       = "autostart.log"
	launchdFallbackShell = "/bin/zsh"
	launchdCmdTimeout    = 10 * time.Second
)

func init() {
	Register("darwin", newLaunchd)
}

// launchd holds its OS touchpoints as fields so tests drive every verb from
// any host without reaching a real launchctl, dscl, or home directory.
type launchd struct {
	// run executes name+args and reports its combined output and exit code;
	// err is non-nil only when the command could not run at all.
	run      func(ctx context.Context, name string, args ...string) (out []byte, exitCode int, err error)
	homeDir  func() (string, error)
	uid      func() int
	username func() (string, error)
	rkPath   func() (string, error)
	logsDir  func() (string, error)
}

func newLaunchd() Backend {
	return &launchd{
		run:      launchdRun,
		homeDir:  os.UserHomeDir,
		uid:      os.Getuid,
		username: launchdUsername,
		rkPath:   RKPath,
		logsDir:  apphome.LogsDir,
	}
}

func launchdRun(ctx context.Context, name string, args ...string) ([]byte, int, error) {
	ctx, cancel := context.WithTimeout(ctx, launchdCmdTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && ctx.Err() == nil {
		return out, exitErr.ExitCode(), nil
	}
	if err != nil {
		return out, -1, err
	}
	return out, 0, nil
}

func launchdUsername() (string, error) {
	u, err := user.Current()
	if err != nil {
		return "", err
	}
	return u.Username, nil
}

// launchdDesired is what On would write now.
type launchdDesired struct {
	path  string
	plist []byte
	shell string
	rk    string
	log   string
}

func (l *launchd) desired(ctx context.Context) (launchdDesired, error) {
	home, err := l.homeDir()
	if err != nil {
		return launchdDesired{}, fmt.Errorf("resolving home directory: %w", err)
	}
	rk, err := l.rkPath()
	if err != nil {
		return launchdDesired{}, fmt.Errorf("resolving rk path: %w", err)
	}
	logs, err := l.logsDir()
	if err != nil {
		return launchdDesired{}, fmt.Errorf("resolving logs directory: %w", err)
	}
	shell := l.loginShell(ctx)
	log := filepath.Join(logs, launchdLogName)
	return launchdDesired{
		path:  launchdPlistPath(home),
		plist: launchdPlist(shell, StartScript(rk, nil), log),
		shell: shell,
		rk:    rk,
		log:   log,
	}, nil
}

// loginShell reads the user's login shell from the directory service rather
// than $SHELL, which reflects whatever shell ran rk, not what login uses.
func (l *launchd) loginShell(ctx context.Context) string {
	name, err := l.username()
	if err != nil || name == "" {
		return launchdFallbackShell
	}
	out, code, err := l.run(ctx, "dscl", ".", "-read", "/Users/"+name, "UserShell")
	if err != nil || code != 0 {
		return launchdFallbackShell
	}
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		if v, ok := strings.CutPrefix(sc.Text(), "UserShell:"); ok {
			if v = strings.TrimSpace(v); filepath.IsAbs(v) {
				return v
			}
		}
	}
	return launchdFallbackShell
}

// launchdPlist renders the LaunchAgent. No KeepAlive: launchd runs the job
// once per load and never restarts it. AbandonProcessGroup stops launchd from
// killing the job's process group when the shell exits, so the tmux server
// the start births outlives the job.
func launchdPlist(shell, script, logPath string) []byte {
	var b bytes.Buffer
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ` + ManagedMarker + ` -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>` + launchdLabel + `</string>
  <key>ProgramArguments</key>
  <array>
    <string>` + launchdEscape(shell) + `</string>
    <string>-lc</string>
    <string>` + launchdEscape(script) + `</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardOutPath</key>
  <string>` + launchdEscape(logPath) + `</string>
  <key>StandardErrorPath</key>
  <string>` + launchdEscape(logPath) + `</string>
</dict>
</plist>
`)
	return b.Bytes()
}

func launchdEscape(s string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

func launchdPlistPath(home string) string {
	return filepath.Join(home, filepath.FromSlash(launchdAgentsRelDir), launchdLabel+".plist")
}

func (l *launchd) domain() string {
	return "gui/" + strconv.Itoa(l.uid())
}

func (l *launchd) service() string {
	return l.domain() + "/" + launchdLabel
}

func (l *launchd) launchctl(ctx context.Context, args ...string) error {
	out, code, err := l.run(ctx, "launchctl", args...)
	if err != nil {
		return fmt.Errorf("launchctl %s: %w", strings.Join(args, " "), err)
	}
	if code != 0 {
		return fmt.Errorf("launchctl %s: exit %d: %s", strings.Join(args, " "), code, strings.TrimSpace(string(out)))
	}
	return nil
}

// printService returns `launchctl print` output for the job and whether it
// is loaded (launchctl exits non-zero for an unknown service).
func (l *launchd) printService(ctx context.Context) ([]byte, bool) {
	out, code, err := l.run(ctx, "launchctl", "print", l.service())
	return out, err == nil && code == 0
}

// launchdReadOwned reads the plist at path; exists is false when there is none. A
// file that lacks ManagedMarker is an error: rk never overwrites or deletes a
// plist it did not write.
func launchdReadOwned(path string) (data []byte, exists bool, err error) {
	data, err = os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if !bytes.Contains(data, []byte(ManagedMarker)) {
		return nil, true, fmt.Errorf("refusing to modify %s: it was not written by rk daemon autostart", path)
	}
	return data, true, nil
}

func (l *launchd) On(ctx context.Context, opts OnOptions) (Result, error) {
	want, err := l.desired(ctx)
	if err != nil {
		return Result{}, err
	}
	have, exists, err := launchdReadOwned(want.path)
	if err != nil {
		return Result{}, err
	}
	// launchd does not create the log file's directory and a missing one
	// fails the job before the shell runs, so it is ensured on every On, not
	// only when the plist is rewritten.
	for _, dir := range []string{filepath.Dir(want.path), filepath.Dir(want.log)} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return Result{}, err
		}
	}
	changed := !exists || !bytes.Equal(have, want.plist)
	if changed {
		if err := fsatomic.WriteFile(want.path, want.plist, 0o644); err != nil {
			return Result{}, err
		}
	}
	// Clears a `launchctl disable` override left from earlier; neither loads
	// nor starts the job.
	if err := l.launchctl(ctx, "enable", l.service()); err != nil {
		return Result{}, err
	}
	res := Result{Name: launchdLabel, Path: want.path, Changed: changed}
	if !opts.Now {
		res.Hints = []string{"The daemon starts at your next login; add --now to start it now."}
		return res, nil
	}
	// bootstrap runs the job at once (RunAtLoad); a job that is already
	// loaded with the current plist is re-run with kickstart instead. Either
	// way the start command is a no-op success when the daemon is up.
	_, loaded := l.printService(ctx)
	switch {
	case loaded && !changed:
		err = l.launchctl(ctx, "kickstart", l.service())
	case loaded:
		if err = l.launchctl(ctx, "bootout", l.service()); err == nil {
			err = l.launchctl(ctx, "bootstrap", l.domain(), want.path)
		}
	default:
		err = l.launchctl(ctx, "bootstrap", l.domain(), want.path)
	}
	if err != nil {
		return res, err
	}
	res.Started = true
	return res, nil
}

func (l *launchd) Off(ctx context.Context) (Result, error) {
	home, err := l.homeDir()
	if err != nil {
		return Result{}, fmt.Errorf("resolving home directory: %w", err)
	}
	path := launchdPlistPath(home)
	_, exists, err := launchdReadOwned(path)
	if err != nil {
		return Result{}, err
	}
	// bootout unloads the job, whose shell exited after its one run; the
	// daemon's tmux server is in its own session and is left running.
	_, loaded := l.printService(ctx)
	if loaded {
		if err := l.launchctl(ctx, "bootout", l.service()); err != nil {
			return Result{}, err
		}
	}
	if exists {
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return Result{}, err
		}
	}
	return Result{Name: launchdLabel, Path: path, Changed: exists || loaded}, nil
}

func (l *launchd) Status(ctx context.Context) (Status, error) {
	want, err := l.desired(ctx)
	if err != nil {
		return Status{}, err
	}
	st := Status{
		Platform: "darwin",
		Manager:  "launchd",
		Name:     launchdLabel,
		Path:     want.path,
		RKPath:   want.rk,
		Shell:    want.shell,
	}
	have, err := os.ReadFile(want.path)
	if errors.Is(err, fs.ErrNotExist) {
		st.Hints = []string{"Turn it on with: rk daemon autostart on"}
		return st, nil
	}
	if err != nil {
		return Status{}, err
	}
	if !bytes.Contains(have, []byte(ManagedMarker)) {
		st.Hints = []string{"A plist at " + want.path + " was not written by rk daemon autostart; rk will not modify it. Remove it yourself to let `rk daemon autostart on` register."}
		return st, nil
	}
	st.Registered = true
	st.StartsAt = StartsAtLogin
	st.Enabled = !l.disabled(ctx)
	st.Stale = !bytes.Equal(have, want.plist)

	if out, loaded := l.printService(ctx); loaded {
		st.LastExitCode, st.LastResult = launchdLastExit(out)
	} else {
		st.LastResult = "not loaded"
	}

	if !st.Enabled {
		st.Hints = append(st.Hints, "launchd has this job disabled; re-run: rk daemon autostart on")
	}
	if st.Stale {
		st.Hints = append(st.Hints, "The registration differs from what rk would write now (rk path or login shell changed); refresh it with: rk daemon autostart on")
	}
	if st.LastExitCode != nil && *st.LastExitCode != 0 {
		st.Hints = append(st.Hints, "The last start failed; see "+want.log)
	}
	if h := launchdRCHint(want.shell); h != "" {
		st.Hints = append(st.Hints, h)
	}
	return st, nil
}

// disabled reports whether `launchctl print-disabled` lists the job as
// disabled (macOS 13+ prints `=> disabled`, older releases `=> true`).
func (l *launchd) disabled(ctx context.Context) bool {
	out, code, err := l.run(ctx, "launchctl", "print-disabled", l.domain())
	if err != nil || code != 0 {
		return false
	}
	key := `"` + launchdLabel + `" =>`
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		if v, ok := strings.CutPrefix(strings.TrimSpace(sc.Text()), key); ok {
			v = strings.TrimSpace(v)
			return v == "disabled" || v == "true"
		}
	}
	return false
}

// launchdLastExit parses the `last exit code = …` line of `launchctl print`.
func launchdLastExit(out []byte) (*int, string) {
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		v, ok := strings.CutPrefix(strings.TrimSpace(sc.Text()), "last exit code =")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		if strings.HasPrefix(v, "(never exited)") {
			return nil, "never run"
		}
		// A signal exit reads e.g. `last exit code = 9: Killed`.
		num, _, _ := strings.Cut(v, ":")
		code, err := strconv.Atoi(strings.TrimSpace(num))
		if err != nil {
			return nil, ""
		}
		if code == 0 {
			return &code, "success"
		}
		return &code, "failed"
	}
	return nil, ""
}

// launchdRCHint names the interactive-only rc file a `<shell> -lc` start does
// not read. fish reads config.fish for login shells too, so it gets none.
func launchdRCHint(shell string) string {
	var profile, rc string
	switch filepath.Base(shell) {
	case "zsh":
		profile, rc = "~/.zprofile", "~/.zshrc"
	case "bash":
		profile, rc = "~/.bash_profile", "~/.bashrc"
	default:
		return ""
	}
	return fmt.Sprintf("The daemon starts through %s -lc, which reads %s but not %s: keep PATH, credentials and TMUX_TMPDIR in %s", shell, profile, rc, profile)
}
