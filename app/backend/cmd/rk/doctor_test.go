package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"rk/internal/codeserver"
	"rk/internal/config"
	"rk/internal/gui"
	"rk/internal/portpolicy"
	"rk/internal/settings"
	"rk/internal/tmux"
)

func TestDoctorCommandOutput(t *testing.T) {
	// Execute doctorCmd and capture its output.
	// The test result depends on whether tmux is installed,
	// but we verify the command runs and produces expected output either way.
	buf := new(bytes.Buffer)
	doctorCmd.SetOut(buf)
	doctorCmd.SetErr(buf)

	err := doctorCmd.RunE(doctorCmd, nil)
	output := buf.String()

	if err != nil {
		// tmux not found — verify failure output
		if output == "" {
			t.Error("expected output on failure, got empty string")
		}
		if !contains(output, "[FAIL]") {
			t.Errorf("expected [FAIL] in output, got: %s", output)
		}
	} else {
		// tmux found — verify success output
		if !contains(output, "[ OK ] tmux") {
			t.Errorf("expected '[ OK ] tmux' in output, got: %s", output)
		}
		if !contains(output, "All checks passed") {
			t.Errorf("expected 'All checks passed' in output, got: %s", output)
		}
	}
}

func contains(s, substr string) bool {
	return bytes.Contains([]byte(s), []byte(substr))
}

// TestDoctorReportOKMatchesChecks pins the worst-check-wins aggregation
// (Principle 4): the overall `ok` is true only when every check passed.
func TestDoctorReportOKMatchesChecks(t *testing.T) {
	report := runDoctorChecks()
	allOK := true
	for _, c := range report.Checks {
		if !c.OK {
			allOK = false
		}
	}
	if report.OK != allOK {
		t.Errorf("report.OK = %v but checks aggregate to %v (worst-check-wins violated)", report.OK, allOK)
	}
	if len(report.Checks) == 0 {
		t.Error("report has no checks")
	}
}

// TestDoctorJSONToStdoutErrEmpty verifies --json emits the report inside the
// {"ok","result"} envelope to stdout with the human diagnostic absent from
// stdout (it belongs on stderr); a failing report keeps exit 1 with the
// verdict in error beside result.
func TestDoctorJSONToStdoutErrEmpty(t *testing.T) {
	var stdout, stderr bytes.Buffer
	doctorCmd.SetOut(&stdout)
	doctorCmd.SetErr(&stderr)
	t.Cleanup(func() {
		doctorCmd.SetOut(nil)
		doctorCmd.SetErr(nil)
		doctorJSON = false
	})
	doctorJSON = true

	// RunE returns a non-nil error when a check fails (tmux absent); either way
	// stdout must carry the envelope and stderr must stay empty on the JSON path.
	err := doctorCmd.RunE(doctorCmd, nil)

	var env struct {
		OK     bool           `json:"ok"`
		Result doctorReport   `json:"result"`
		Error  *envelopeError `json:"error"`
	}
	if uerr := json.Unmarshal(stdout.Bytes(), &env); uerr != nil {
		t.Fatalf("stdout is not the doctor envelope: %v (got %q)", uerr, stdout.String())
	}
	if len(env.Result.Checks) == 0 {
		t.Error("envelope result has no checks")
	}
	if env.OK != (err == nil) {
		t.Errorf("ok = %v, want it to mirror the exit (err = %v)", env.OK, err)
	}
	if err != nil {
		if got := exitCode(err); got != 1 {
			t.Errorf("failing report: exit code = %d, want 1", got)
		}
		if env.Error == nil || env.Error.Message != "one or more dependency checks failed" {
			t.Errorf("error = %+v, want the verdict message beside result", env.Error)
		}
	}
	if stderr.Len() != 0 {
		t.Errorf("--json path wrote to stderr: %q", stderr.String())
	}
}

// TestDoctorJSONFlagRegistered pins the --json flag surface (help-dump
// re-verification depends on it).
func TestDoctorJSONFlagRegistered(t *testing.T) {
	if doctorCmd.Flags().Lookup("json") == nil {
		t.Error("doctor command is missing the --json flag")
	}
}

// withQuiet sets the package-level quiet var for the test's duration. newSink
// falls back to this var when a standalone subcommand cannot resolve the
// persistent --quiet flag (the shape the RunE-invoking tests use); production
// reads the flag off the invoked command via rootCmd.Execute(). Restore is
// mandatory — cobra does not reset package-global flag vars between calls.
func withQuiet(t *testing.T, v bool) {
	t.Helper()
	orig := quiet
	quiet = v
	t.Cleanup(func() { quiet = orig })
}

// TestDoctorQuietDropsChatterKeepsFailAndExit pins R4: under --quiet the banner,
// [ OK ] rows, and success tail (chatter) are suppressed on stderr, while a
// [FAIL] row (actionable error detail) and the non-zero exit survive.
func TestDoctorQuietDropsChatterKeepsFailAndExit(t *testing.T) {
	withQuiet(t, true)
	var stdout, stderr bytes.Buffer
	doctorCmd.SetOut(&stdout)
	doctorCmd.SetErr(&stderr)
	t.Cleanup(func() { doctorCmd.SetOut(nil); doctorCmd.SetErr(nil) })

	err := doctorCmd.RunE(doctorCmd, nil)
	errOut := stderr.String()

	// The banner and success tail are chatter and must never appear under --quiet.
	if contains(errOut, "Checking runtime dependencies") {
		t.Errorf("--quiet must drop the banner, got stderr: %q", errOut)
	}
	if contains(errOut, "All checks passed") {
		t.Errorf("--quiet must drop the success tail, got stderr: %q", errOut)
	}
	if contains(errOut, "[ OK ]") {
		t.Errorf("--quiet must drop [ OK ] rows, got stderr: %q", errOut)
	}

	if err != nil {
		// tmux absent — the FAIL row (error detail) and non-zero exit survive.
		if !contains(errOut, "[FAIL]") {
			t.Errorf("--quiet must keep [FAIL] rows (error detail), got stderr: %q", errOut)
		}
	} else {
		// tmux present — a fully-passing --quiet run is silent on stderr.
		if errOut != "" {
			t.Errorf("--quiet passing run must be silent on stderr, got: %q", errOut)
		}
	}
}

// TestDoctorQuietJSONEmitsExactlyJSON pins R4's --json clause: --quiet --json
// emits exactly the envelope (report under result) to stdout with empty stderr
// (the flag never gates the machine-data path).
func TestDoctorQuietJSONEmitsExactlyJSON(t *testing.T) {
	withQuiet(t, true)
	var stdout, stderr bytes.Buffer
	doctorCmd.SetOut(&stdout)
	doctorCmd.SetErr(&stderr)
	t.Cleanup(func() {
		doctorCmd.SetOut(nil)
		doctorCmd.SetErr(nil)
		doctorJSON = false
	})
	doctorJSON = true

	_ = doctorCmd.RunE(doctorCmd, nil)

	var env struct {
		OK     bool         `json:"ok"`
		Result doctorReport `json:"result"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &env); err != nil {
		t.Fatalf("--quiet --json stdout is not the doctor envelope: %v (got %q)", err, stdout.String())
	}
	if len(env.Result.Checks) == 0 {
		t.Error("envelope result has no checks")
	}
	if stderr.Len() != 0 {
		t.Errorf("--quiet --json wrote to stderr: %q", stderr.String())
	}
}

// TestDoctorQuietFlagWiredThroughRoot proves the production seam: invoking via
// rootCmd.Execute() with --quiet resolves the persistent flag on the command
// itself (not the var fallback), so newSink discards chatter. This exercises the
// real wiring the RunE-only tests bypass.
func TestDoctorQuietFlagWiredThroughRoot(t *testing.T) {
	var stdout, stderr bytes.Buffer
	rootCmd.SetOut(&stdout)
	rootCmd.SetErr(&stderr)
	rootCmd.SetArgs([]string{"doctor", "--quiet"})
	t.Cleanup(func() {
		rootCmd.SetOut(nil)
		rootCmd.SetErr(nil)
		rootCmd.SetArgs(nil)
		// Reset the persistent flag so it does not leak into other tests.
		_ = rootCmd.PersistentFlags().Set("quiet", "false")
		quiet = false
	})

	// Execute may return an error (tmux absent) — either way the banner/tail
	// chatter must be suppressed on stderr.
	_ = rootCmd.Execute()
	if contains(stderr.String(), "Checking runtime dependencies") || contains(stderr.String(), "[ OK ]") {
		t.Errorf("--quiet via rootCmd.Execute() must suppress chatter, got stderr: %q", stderr.String())
	}
}

// --- tmux guard shim check ------------------------------------------------------

// NOTE (tmux safety): these tests use temp homes, stub executables, and
// injected (pathEnv, lookPath) pairs only — no host PATH dependence, no tmux
// execution.

// doctorShimScript renders shim content whose embedded rk path names a REAL
// stub binary in a temp dir — the check now stats the exec target, so a
// healthy-install fixture must embed a path that exists (a literal
// /opt/homebrew/bin/rk would read as the dangling-rk failure).
func doctorShimScript(t *testing.T) string {
	t.Helper()
	return tmuxShimScript(writeStub(t, t.TempDir(), "rk", "#!/bin/sh\nexit 0\n", 0o755))
}

// installDoctorShim writes an rk-owned shim into the temp home plus a stub
// "real tmux" in its own dir, returning the shim path and a pathEnv where the
// stub sits behind the shims dir (the healthy installed layout).
func installDoctorShim(t *testing.T, home string) (shim, pathEnv string) {
	t.Helper()
	shim = tmuxShimPath(home)
	writeStub(t, filepath.Dir(shim), "tmux", doctorShimScript(t), 0o755)
	realDir := t.TempDir()
	writeStub(t, realDir, "tmux", stubTmuxContent, 0o755)
	return shim, filepath.Dir(shim) + string(os.PathListSeparator) + realDir
}

func TestTmuxGuardShimCheckNotInstalled(t *testing.T) {
	home := t.TempDir()
	c := tmuxGuardShimCheck(home, "", func(string) (string, error) {
		t.Fatal("lookPath must not be called when the shim is absent")
		return "", nil
	})
	if !c.OK {
		t.Errorf("absent shim must be OK (optional), got %+v", c)
	}
	if !strings.Contains(c.Note, "not installed") {
		t.Errorf("absent shim should carry a not-installed note, got %+v", c)
	}
}

// TestTmuxGuardShimCheckUnreadableFile pins the cycle-2 should-fix: an
// existing-but-unreadable file at the shim path is NOT the optional
// "not installed" state — exec.LookPath resolves it without read permission,
// so it may be fronting (and killing) every tmux invocation. The check must
// FAIL with a permissions hint instead of letting doctor exit 0.
func TestTmuxGuardShimCheckUnreadableFile(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root — file permissions do not restrict reads")
	}
	home := t.TempDir()
	shim := tmuxShimPath(home)
	writeStub(t, filepath.Dir(shim), "tmux", tmuxShimScript("/opt/homebrew/bin/rk"), 0o755)
	// Executable but not readable: LookPath resolves it, os.ReadFile fails.
	if err := os.Chmod(shim, 0o111); err != nil {
		t.Fatal(err)
	}
	c := tmuxGuardShimCheck(home, "", func(string) (string, error) {
		t.Fatal("lookPath must not be called for an unreadable file")
		return "", nil
	})
	if c.OK {
		t.Errorf("unreadable file at the shim path must FAIL, got %+v", c)
	}
	if !strings.Contains(c.Hint, "permissions") {
		t.Errorf("hint should point at permissions, got %+v", c)
	}
	if !strings.Contains(c.Hint, shim) {
		t.Errorf("hint should name the shim path, got %+v", c)
	}
}

// TestTmuxGuardShimCheckMarkerlessFile pins half of must-fix #4: a marker-less
// file at the shim path is a USER file, not an installed rk shim — the check
// reads it as not-installed (OK + note), never as the guard being active.
func TestTmuxGuardShimCheckMarkerlessFile(t *testing.T) {
	home := t.TempDir()
	shim := tmuxShimPath(home)
	writeStub(t, filepath.Dir(shim), "tmux", "#!/bin/sh\n# my own wrapper\nexec /usr/bin/tmux \"$@\"\n", 0o755)
	c := tmuxGuardShimCheck(home, "", func(string) (string, error) {
		t.Fatal("lookPath must not be called for a marker-less file")
		return "", nil
	})
	if !c.OK {
		t.Errorf("marker-less file must read as not-installed (OK), got %+v", c)
	}
	if !strings.Contains(c.Note, "non-rk file") {
		t.Errorf("note should say a non-rk file occupies the path, got %+v", c)
	}
}

// TestTmuxGuardShimCheckDanglingRkPath pins the cycle-3 must-fix: an installed
// shim whose EMBEDDED rk path no longer exists (the recorded brew rk→run-kit
// rename incident — a zombie keg path baked into the shim) degrades EVERY tmux
// command on the machine to a ~3s stall followed by an unguarded run — the
// shim's probe budget covers a transient relink, not a permanent break — so
// the check must FAIL with a re-install hint instead of vouching for the
// install.
func TestTmuxGuardShimCheckDanglingRkPath(t *testing.T) {
	t.Run("embedded rk path missing", func(t *testing.T) {
		home := t.TempDir()
		shim := tmuxShimPath(home)
		gone := filepath.Join(t.TempDir(), "rk") // never created — a dangling target
		writeStub(t, filepath.Dir(shim), "tmux", tmuxShimScript(gone), 0o755)
		c := tmuxGuardShimCheck(home, "", func(string) (string, error) {
			t.Fatal("lookPath must not be called when the embedded rk is dangling")
			return "", nil
		})
		if c.OK {
			t.Errorf("shim exec'ing a missing rk binary must FAIL, got %+v", c)
		}
		if !strings.Contains(c.Hint, gone) {
			t.Errorf("hint should name the dangling path %q, got %+v", gone, c)
		}
		if !strings.Contains(c.Hint, "rk agent setup") {
			t.Errorf("hint should carry the re-install remedy `rk agent setup`, got %+v", c)
		}
	})

	t.Run("no parseable exec target", func(t *testing.T) {
		home := t.TempDir()
		shim := tmuxShimPath(home)
		// Marker-owned (rk's artifact) but the exec line was mangled by hand —
		// there is no target to stat, and the shim cannot work.
		content := "#!/bin/sh\n# " + tmuxShimMarker + "\n"
		writeStub(t, filepath.Dir(shim), "tmux", content, 0o755)
		c := tmuxGuardShimCheck(home, "", func(string) (string, error) {
			t.Fatal("lookPath must not be called when the shim has no exec target")
			return "", nil
		})
		if c.OK {
			t.Errorf("shim with no parseable exec target must FAIL, got %+v", c)
		}
		if !strings.Contains(c.Hint, "rk agent setup") {
			t.Errorf("hint should carry the re-install remedy `rk agent setup`, got %+v", c)
		}
	})

	// The PR-review should-fix: bare os.Stat existence is not enough — a
	// directory or a non-executable file at the embedded target breaks every
	// shimmed tmux invocation exactly like a missing binary, so both must
	// FAIL instead of reading as a healthy install.
	t.Run("embedded rk path is a directory", func(t *testing.T) {
		home := t.TempDir()
		shim := tmuxShimPath(home)
		writeStub(t, filepath.Dir(shim), "tmux", tmuxShimScript(t.TempDir()), 0o755)
		c := tmuxGuardShimCheck(home, "", func(string) (string, error) {
			t.Fatal("lookPath must not be called when the embedded rk is a directory")
			return "", nil
		})
		if c.OK {
			t.Errorf("shim exec'ing a directory must FAIL, got %+v", c)
		}
		if !strings.Contains(c.Hint, "not an executable file") {
			t.Errorf("hint should say the target is not an executable file, got %+v", c)
		}
		if !strings.Contains(c.Hint, "rk agent setup") {
			t.Errorf("hint should carry the re-install remedy `rk agent setup`, got %+v", c)
		}
	})

	t.Run("embedded rk path not executable", func(t *testing.T) {
		home := t.TempDir()
		shim := tmuxShimPath(home)
		target := writeStub(t, t.TempDir(), "rk", "#!/bin/sh\nexit 0\n", 0o644)
		writeStub(t, filepath.Dir(shim), "tmux", tmuxShimScript(target), 0o755)
		c := tmuxGuardShimCheck(home, "", func(string) (string, error) {
			t.Fatal("lookPath must not be called when the embedded rk is not executable")
			return "", nil
		})
		if c.OK {
			t.Errorf("shim exec'ing a non-executable file must FAIL, got %+v", c)
		}
		if !strings.Contains(c.Hint, "not an executable file") {
			t.Errorf("hint should say the target is not an executable file, got %+v", c)
		}
		if !strings.Contains(c.Hint, "rk agent setup") {
			t.Errorf("hint should carry the re-install remedy `rk agent setup`, got %+v", c)
		}
	})
}

// oldGenerationDoctorShim renders the PRE-move shim content (steady-state exec
// `…" tmux-guard "$@"`) for the given rk path. Installed shims carry the
// literal frozen at install time, so doctor must keep verifying this form
// forever.
func oldGenerationDoctorShim(t *testing.T, rkPath string) string {
	t.Helper()
	old := strings.Replace(tmuxShimScript(rkPath),
		`exec "`+rkPath+`" mux guard "$@"`,
		`exec "`+rkPath+`" tmux-guard "$@"`, 1)
	if !strings.Contains(old, `" tmux-guard "$@"`) {
		t.Fatal("old-generation fixture is malformed — tmuxShimScript no longer matches the replaced exec line")
	}
	return old
}

// TestTmuxGuardShimCheckBothGenerations pins generation parity: tmuxShimExecTarget's
// first-quoted-value parse is generation-agnostic, so old- and new-form shims
// report identically across the healthy, dangling-target, and
// unparseable-exec-target states.
func TestTmuxGuardShimCheckBothGenerations(t *testing.T) {
	liveRk := writeStub(t, t.TempDir(), "rk", "#!/bin/sh\nexit 0\n", 0o755)
	danglingRk := filepath.Join(t.TempDir(), "rk") // never created

	generations := map[string]func(t *testing.T, rkPath string) string{
		"old form (tmux-guard exec)": oldGenerationDoctorShim,
		"new form (mux guard exec)": func(_ *testing.T, rkPath string) string {
			return tmuxShimScript(rkPath)
		},
	}

	for gen, render := range generations {
		t.Run(gen, func(t *testing.T) {
			// The exec target parse reads the embedded rk path out of BOTH
			// forms — every shim state builds on it.
			if got := tmuxShimExecTarget(render(t, liveRk)); got != liveRk {
				t.Errorf("tmuxShimExecTarget = %q, want %q", got, liveRk)
			}

			t.Run("healthy install", func(t *testing.T) {
				home := t.TempDir()
				shim := tmuxShimPath(home)
				writeStub(t, filepath.Dir(shim), "tmux", render(t, liveRk), 0o755)
				realDir := t.TempDir()
				writeStub(t, realDir, "tmux", stubTmuxContent, 0o755)
				pathEnv := filepath.Dir(shim) + string(os.PathListSeparator) + realDir
				c := tmuxGuardShimCheck(home, pathEnv, func(string) (string, error) { return shim, nil })
				if !c.OK {
					t.Errorf("healthy %s shim must be OK, got %+v", gen, c)
				}
				if !strings.Contains(c.Note, "resolves tmux to the shim") {
					t.Errorf("expected the resolves-to-shim note, got %+v", c)
				}
			})

			t.Run("dangling embedded target", func(t *testing.T) {
				home := t.TempDir()
				shim := tmuxShimPath(home)
				writeStub(t, filepath.Dir(shim), "tmux", render(t, danglingRk), 0o755)
				c := tmuxGuardShimCheck(home, "", func(string) (string, error) { return shim, nil })
				if c.OK {
					t.Errorf("a dangling embedded rk path must FAIL, got %+v", c)
				}
				if !strings.Contains(c.Hint, danglingRk) || !strings.Contains(c.Hint, "rk agent setup") {
					t.Errorf("hint should name the dangling path and the re-install remedy, got %+v", c)
				}
			})

			t.Run("unparseable exec target", func(t *testing.T) {
				home := t.TempDir()
				shim := tmuxShimPath(home)
				content := "#!/bin/sh\n# " + tmuxShimMarker + "\n"
				writeStub(t, filepath.Dir(shim), "tmux", content, 0o755)
				c := tmuxGuardShimCheck(home, "", func(string) (string, error) { return shim, nil })
				if c.OK {
					t.Errorf("an unparseable exec target must FAIL, got %+v", c)
				}
				if !strings.Contains(c.Hint, "rk agent setup") {
					t.Errorf("hint should carry the re-install remedy `rk agent setup`, got %+v", c)
				}
			})
		})
	}
}

func TestTmuxGuardShimCheckResolvesToShim(t *testing.T) {
	home := t.TempDir()
	shim, pathEnv := installDoctorShim(t, home)
	c := tmuxGuardShimCheck(home, pathEnv, func(string) (string, error) { return shim, nil })
	if !c.OK {
		t.Errorf("shim-resolving PATH with a real tmux behind it must be OK, got %+v", c)
	}
	if !strings.Contains(c.Note, "resolves tmux to the shim") {
		t.Errorf("expected a resolves-to-shim note, got %+v", c)
	}
}

// TestTmuxGuardShimCheckNoRealTmuxBehindShim pins the other half of must-fix
// #4: tmux resolving to the shim is NOT enough — with no real tmux behind it,
// every guarded call dies at exec time, so the check must FAIL.
func TestTmuxGuardShimCheckNoRealTmuxBehindShim(t *testing.T) {
	home := t.TempDir()
	shim := tmuxShimPath(home)
	writeStub(t, filepath.Dir(shim), "tmux", doctorShimScript(t), 0o755)
	// pathEnv carries ONLY the shims dir — nothing behind the shim.
	c := tmuxGuardShimCheck(home, filepath.Dir(shim), func(string) (string, error) { return shim, nil })
	if c.OK {
		t.Errorf("shim with no real tmux behind it must FAIL, got %+v", c)
	}
	if !strings.Contains(c.Hint, "no real tmux") {
		t.Errorf("hint should name the missing real tmux, got %+v", c)
	}
}

func TestTmuxGuardShimCheckPathRegression(t *testing.T) {
	home := t.TempDir()
	shim, pathEnv := installDoctorShim(t, home)
	_ = shim

	t.Run("resolves elsewhere", func(t *testing.T) {
		other := filepath.Join(t.TempDir(), "tmux")
		if err := os.WriteFile(other, []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		c := tmuxGuardShimCheck(home, pathEnv, func(string) (string, error) { return other, nil })
		if c.OK {
			t.Errorf("PATH resolving tmux elsewhere must FAIL, got %+v", c)
		}
		if !strings.Contains(c.Hint, "rk tmux guard") {
			t.Errorf("hint should point at the PATH block, got %+v", c)
		}
	})

	t.Run("no tmux on PATH at all", func(t *testing.T) {
		c := tmuxGuardShimCheck(home, pathEnv, func(string) (string, error) { return "", os.ErrNotExist })
		if c.OK {
			t.Errorf("installed shim with no PATH resolution must FAIL, got %+v", c)
		}
		if c.Hint == "" {
			t.Errorf("failure must carry a hint, got %+v", c)
		}
	})
}

// TestTmuxVersionCheckNoteShapes pins the three version-note shapes: the
// plain version at/above the floor, the shared below-floor message (WARN —
// the row stays OK, mirroring the code-server precedent), and no note for an
// unknown version (never block on a parse).
func TestTmuxVersionCheckNoteShapes(t *testing.T) {
	stub := func(v tmux.Version, known bool) {
		orig := tmuxVersionProbe
		tmuxVersionProbe = func(context.Context) (tmux.Version, bool) { return v, known }
		t.Cleanup(func() { tmuxVersionProbe = orig })
		stubDriftSeams(t, nil, nil)
	}

	t.Run("at or above floor carries the plain version", func(t *testing.T) {
		stub(tmux.Version{Major: 3, Minor: 6, Raw: "3.6a"}, true)
		c := tmuxVersionCheck()
		if !c.OK {
			t.Errorf("at-floor row must stay OK, got %+v", c)
		}
		if c.Note != "3.6a" {
			t.Errorf("note = %q, want the plain version %q", c.Note, "3.6a")
		}
	})

	t.Run("exactly the floor is not below", func(t *testing.T) {
		stub(tmux.Version{Major: 3, Minor: 4, Raw: "3.4"}, true)
		c := tmuxVersionCheck()
		if c.Note != "3.4" {
			t.Errorf("note = %q, want %q (>= comparison is load-bearing)", c.Note, "3.4")
		}
	})

	t.Run("below floor is OK with the upgrade message", func(t *testing.T) {
		stub(tmux.Version{Major: 3, Minor: 2, Raw: "3.2a"}, true)
		c := tmuxVersionCheck()
		if !c.OK {
			t.Errorf("below-floor row must stay OK (doctor is the detail view, not the gate), got %+v", c)
		}
		want := tmux.UpgradeHint(runtime.GOOS, exec.LookPath, "3.2a")
		if c.Note != want {
			t.Errorf("note = %q, want the shared upgrade message %q", c.Note, want)
		}
	})

	t.Run("unknown carries no note", func(t *testing.T) {
		stub(tmux.Version{}, false)
		c := tmuxVersionCheck()
		if !c.OK || c.Note != "" {
			t.Errorf("unknown version must be OK with an empty note, got %+v", c)
		}
	})
}

// stubDriftSeams substitutes the drift-sweep seams for a test: servers is the
// enumeration result (nil = no live servers) and versions maps server name to
// its probed version (a missing key reads as unknown).
func stubDriftSeams(t *testing.T, servers []string, versions map[string]tmux.Version) {
	t.Helper()
	origList, origProbe := tmuxServerList, tmuxServerVersionProbe
	tmuxServerList = func(context.Context) ([]string, error) { return servers, nil }
	tmuxServerVersionProbe = func(_ context.Context, server string) (tmux.Version, bool) {
		v, ok := versions[server]
		return v, ok
	}
	t.Cleanup(func() { tmuxServerList, tmuxServerVersionProbe = origList, origProbe })
}

// TestTmuxVersionCheckDriftNotes pins the drift-note shapes: a strictly-older
// running server appends the restart sentence (socket named) after the base
// note; equal, newer, suffix-only, and unknown server versions contribute
// nothing; enumeration errors and an unknown binary skip the sweep; the row
// stays OK in every branch (drift is informational — Constitution VI).
func TestTmuxVersionCheckDriftNotes(t *testing.T) {
	stubBinary := func(v tmux.Version, known bool) {
		orig := tmuxVersionProbe
		tmuxVersionProbe = func(context.Context) (tmux.Version, bool) { return v, known }
		t.Cleanup(func() { tmuxVersionProbe = orig })
	}
	binary := tmux.Version{Major: 3, Minor: 6, Raw: "3.6a"}
	driftSentence := func(server, raw string) string {
		return fmt.Sprintf("tmux 3.6a installed but running server %q is %s — restart your tmux server when convenient to pick it up (kills its sessions; pick a quiet moment)", server, raw)
	}

	t.Run("older server appends the drift sentence after the plain version", func(t *testing.T) {
		stubBinary(binary, true)
		stubDriftSeams(t, []string{"default"}, map[string]tmux.Version{
			"default": {Major: 3, Minor: 2, Raw: "3.2a"},
		})
		c := tmuxVersionCheck()
		if !c.OK {
			t.Errorf("drift must never fail the row, got %+v", c)
		}
		want := "3.6a; " + driftSentence("default", "3.2a")
		if c.Note != want {
			t.Errorf("note = %q, want %q", c.Note, want)
		}
	})

	t.Run("only strictly-older servers drift in a mixed sweep", func(t *testing.T) {
		stubBinary(binary, true)
		stubDriftSeams(t, []string{"default", "rk-daemon", "rk-fresh"}, map[string]tmux.Version{
			"default":   {Major: 3, Minor: 6, Raw: "3.6"}, // suffix-only difference — no drift
			"rk-daemon": {Major: 3, Minor: 2, Raw: "3.2a"},
			"rk-fresh":  {Major: 4, Minor: 0, Raw: "4.0"}, // server ahead — no drift
		})
		c := tmuxVersionCheck()
		want := "3.6a; " + driftSentence("rk-daemon", "3.2a")
		if c.Note != want {
			t.Errorf("note = %q, want %q", c.Note, want)
		}
	})

	t.Run("unknown server version is silently skipped", func(t *testing.T) {
		stubBinary(binary, true)
		stubDriftSeams(t, []string{"default"}, nil)
		c := tmuxVersionCheck()
		if c.Note != "3.6a" {
			t.Errorf("note = %q, want the plain version %q", c.Note, "3.6a")
		}
	})

	t.Run("enumeration error leaves the base note unchanged", func(t *testing.T) {
		stubBinary(binary, true)
		stubDriftSeams(t, nil, nil)
		origList := tmuxServerList
		tmuxServerList = func(context.Context) ([]string, error) { return nil, fmt.Errorf("socket dir unreadable") }
		t.Cleanup(func() { tmuxServerList = origList })
		c := tmuxVersionCheck()
		if !c.OK || c.Note != "3.6a" {
			t.Errorf("enumeration error must degrade to the base note, got %+v", c)
		}
	})

	t.Run("unknown binary version skips the sweep entirely", func(t *testing.T) {
		stubBinary(tmux.Version{}, false)
		origList := tmuxServerList
		tmuxServerList = func(context.Context) ([]string, error) {
			t.Error("server enumeration must not run when the binary version is unknown")
			return nil, nil
		}
		t.Cleanup(func() { tmuxServerList = origList })
		c := tmuxVersionCheck()
		if !c.OK || c.Note != "" {
			t.Errorf("unknown binary must keep today's empty-note row, got %+v", c)
		}
	})

	t.Run("drift appends after the below-floor upgrade message", func(t *testing.T) {
		below := tmux.Version{Major: 3, Minor: 3, Raw: "3.3"}
		stubBinary(below, true)
		stubDriftSeams(t, []string{"default"}, map[string]tmux.Version{
			"default": {Major: 3, Minor: 1, Raw: "3.1"},
		})
		c := tmuxVersionCheck()
		if !c.OK {
			t.Errorf("below-floor + drift must stay OK, got %+v", c)
		}
		want := tmux.UpgradeHint(runtime.GOOS, exec.LookPath, "3.3") +
			"; " + fmt.Sprintf("tmux 3.3 installed but running server %q is %s — restart your tmux server when convenient to pick it up (kills its sessions; pick a quiet moment)", "default", "3.1")
		if c.Note != want {
			t.Errorf("note = %q, want %q", c.Note, want)
		}
	})
}

// TestTmuxVersionCheckNoteSurvivesJSON proves the --json report carries the
// version via the check's existing `note` field.
func TestTmuxVersionCheckNoteSurvivesJSON(t *testing.T) {
	orig := tmuxVersionProbe
	tmuxVersionProbe = func(context.Context) (tmux.Version, bool) {
		return tmux.Version{Major: 3, Minor: 6, Raw: "3.6a"}, true
	}
	t.Cleanup(func() { tmuxVersionProbe = orig })
	stubDriftSeams(t, nil, nil)

	data, err := json.Marshal(doctorReport{OK: true, Checks: []doctorCheck{tmuxVersionCheck()}})
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Checks []struct {
			Name string `json:"name"`
			OK   bool   `json:"ok"`
			Note string `json:"note"`
		} `json:"checks"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded.Checks) != 1 || decoded.Checks[0].Note != "3.6a" || !decoded.Checks[0].OK {
		t.Errorf("--json check = %+v, want ok:true with note %q", decoded.Checks, "3.6a")
	}
}

// TestDoctorFailRowWording pins should-fix #3: the shared human [FAIL] row
// keeps its historical "<name> not found — <hint>" wording for absence-style
// checks, while the shim check (whose failures are mis-wirings, not absences)
// renders its own natural lead-in.
func TestDoctorFailRowWording(t *testing.T) {
	absence := doctorCheck{Name: "tmux", OK: false, Hint: "install tmux"}
	if got := doctorFailLabel(absence); got != "tmux not found" {
		t.Errorf("absence-style [FAIL] label = %q, want %q", got, "tmux not found")
	}
	home := t.TempDir()
	shim := tmuxShimPath(home)
	writeStub(t, filepath.Dir(shim), "tmux", doctorShimScript(t), 0o755)
	c := tmuxGuardShimCheck(home, "", func(string) (string, error) { return "", os.ErrNotExist })
	if c.OK {
		t.Fatalf("expected a failing shim check, got %+v", c)
	}
	if got := doctorFailLabel(c); got != "tmux-guard shim" {
		t.Errorf("shim [FAIL] label = %q, want %q", got, "tmux-guard shim")
	}
}

// stubEphemeralSeam substitutes the ephemeral-servers enumeration seam for a
// test: marked is the returned name set (nil = none), err the enumeration
// failure to inject.
func stubEphemeralSeam(t *testing.T, marked []string, err error) {
	t.Helper()
	orig := ephemeralServersList
	ephemeralServersList = func(context.Context) ([]string, error) { return marked, err }
	t.Cleanup(func() { ephemeralServersList = orig })
}

// TestEphemeralServersCheckBranches pins the three row shapes: a nonzero count
// carries the reap hint, zero reads as the quiet "none", and an enumeration
// failure degrades to an OK row naming the skip — the row is always OK-shaped
// (informational, never a verdict flipper).
func TestEphemeralServersCheckBranches(t *testing.T) {
	t.Run("nonzero count carries the reap hint", func(t *testing.T) {
		stubEphemeralSeam(t, []string{"scratch-a", "scratch-b"}, nil)
		c := ephemeralServersCheck()
		if !c.OK {
			t.Errorf("nonzero count must stay OK, got %+v", c)
		}
		want := "2 live server(s) marked " + tmux.EphemeralOption + " — sweep with `rk mux reap --ephemeral`"
		if c.Note != want {
			t.Errorf("note = %q, want %q", c.Note, want)
		}
	})

	t.Run("zero reads as none", func(t *testing.T) {
		stubEphemeralSeam(t, nil, nil)
		c := ephemeralServersCheck()
		if !c.OK || c.Note != "none" {
			t.Errorf("zero must be OK with note %q, got %+v", "none", c)
		}
	})

	t.Run("enumeration error degrades to a skip note", func(t *testing.T) {
		stubEphemeralSeam(t, nil, fmt.Errorf("socket dir unreadable"))
		c := ephemeralServersCheck()
		if !c.OK {
			t.Errorf("enumeration error must never fail the row, got %+v", c)
		}
		if !strings.Contains(c.Note, "skipped") || !strings.Contains(c.Note, "socket dir unreadable") {
			t.Errorf("note = %q, want a skip note naming the failure", c.Note)
		}
	})
}

// TestEphemeralServersCheckNeverFlipsVerdict proves the appended check cannot
// change the overall report verdict: with every seam stubbed healthy and two
// marked servers, runDoctorChecks stays OK and the row is present.
func TestEphemeralServersCheckNeverFlipsVerdict(t *testing.T) {
	stubEphemeralSeam(t, []string{"scratch"}, nil)
	found := false
	for _, c := range runDoctorChecks().Checks {
		if c.Name == "ephemeral servers" {
			found = true
			if !c.OK {
				t.Errorf("ephemeral servers row must always be OK-shaped, got %+v", c)
			}
		}
	}
	if !found {
		t.Error("runDoctorChecks must append the ephemeral servers row unconditionally")
	}
}

// stubLegacyScan substitutes the legacy-options scan seam for a test: results
// is the per-server tally (nil = none), err the enumeration failure to inject.
func stubLegacyScan(t *testing.T, results []legacyOptionsScanResult, err error) {
	t.Helper()
	orig := legacyOptionsScan
	legacyOptionsScan = func(context.Context) ([]legacyOptionsScanResult, error) { return results, err }
	t.Cleanup(func() { legacyOptionsScan = orig })
}

// TestLegacyOptionsCheckBranches pins the four note shapes: a clean fleet
// reads "none", dirty servers carry the sweep remediation, external servers
// get the never-rewritten suffix, and an enumeration failure degrades to an
// OK row naming the skip — the row is always OK-shaped (informational, never
// a verdict flipper).
func TestLegacyOptionsCheckBranches(t *testing.T) {
	t.Run("clean fleet reads none", func(t *testing.T) {
		stubLegacyScan(t, []legacyOptionsScanResult{{Server: "a", Count: 0, Managed: true}}, nil)
		c := legacyOptionsCheck()
		if !c.OK || c.Note != "none" {
			t.Errorf("clean fleet must be OK with note %q, got %+v", "none", c)
		}
	})

	t.Run("dirty servers carry the sweep remediation", func(t *testing.T) {
		stubLegacyScan(t, []legacyOptionsScanResult{
			{Server: "a", Count: 2, Managed: true},
			{Server: "b", Count: 1, Managed: true},
			{Server: "c", Count: 0, Managed: true},
		}, nil)
		c := legacyOptionsCheck()
		if !c.OK {
			t.Errorf("dirty servers must stay OK, got %+v", c)
		}
		want := "2 server(s) still carry legacy option names (@color/@session_color) — attach from the dashboard or run `rk mux adopt <server>` to sweep"
		if c.Note != want {
			t.Errorf("note = %q, want %q", c.Note, want)
		}
	})

	t.Run("external servers get the never-rewritten suffix", func(t *testing.T) {
		stubLegacyScan(t, []legacyOptionsScanResult{
			{Server: "a", Count: 1, Managed: true},
			{Server: "b", Count: 3, Managed: false},
		}, nil)
		c := legacyOptionsCheck()
		if !c.OK {
			t.Errorf("must stay OK, got %+v", c)
		}
		if !strings.Contains(c.Note, "2 server(s)") || !strings.Contains(c.Note, ", of which 1 external — rk will not rewrite those") {
			t.Errorf("note = %q, want the external suffix", c.Note)
		}
	})

	t.Run("enumeration error degrades to a skip note", func(t *testing.T) {
		stubLegacyScan(t, nil, fmt.Errorf("socket dir unreadable"))
		c := legacyOptionsCheck()
		if !c.OK {
			t.Errorf("enumeration error must never fail the row, got %+v", c)
		}
		if !strings.Contains(c.Note, "skipped") || !strings.Contains(c.Note, "socket dir unreadable") {
			t.Errorf("note = %q, want a skip note naming the failure", c.Note)
		}
	})

}

// TestLegacyOptionsCheckNeverFlipsVerdict proves the appended row cannot
// change the overall report verdict: with a dirty server in the scan,
// runDoctorChecks stays OK and the row is present.
func TestLegacyOptionsCheckNeverFlipsVerdict(t *testing.T) {
	stubLegacyScan(t, []legacyOptionsScanResult{{Server: "a", Count: 5, Managed: true}}, nil)
	found := false
	for _, c := range runDoctorChecks().Checks {
		if c.Name == "legacy tmux options" {
			found = true
			if !c.OK {
				t.Errorf("legacy tmux options row must always be OK-shaped, got %+v", c)
			}
		}
	}
	if !found {
		t.Error("runDoctorChecks must append the legacy tmux options row unconditionally")
	}
}

// TestLegacyOptionsScanSkipsFailingServer: the default scan skips a server
// whose per-server probes fail and still counts the rest (a socket dying
// mid-scan must not abort the whole row). Drives the production scan through
// the shared tmuxServerList seam; CountLegacyOptions/IsManagedServer fail on
// the dead name, the live one enumerates clean.
func TestLegacyOptionsScanSkipsFailingServer(t *testing.T) {
	orig := tmuxServerList
	tmuxServerList = func(context.Context) ([]string, error) {
		return []string{"rk-doctor-dead-definitely-not-live", "rk-daemon"}, nil
	}
	t.Cleanup(func() { tmuxServerList = orig })

	results, err := legacyOptionsScan(context.Background())
	if err != nil {
		t.Fatalf("scan errored on a dead server: %v — a failing server must be skipped", err)
	}
	for _, r := range results {
		if r.Server == "rk-doctor-dead-definitely-not-live" {
			t.Errorf("results = %+v — the dead server must be skipped, not counted", results)
		}
	}
}

// TestCodeServerCheckAbsentBinaryIsWarnNotFail proves the daemon-managed
// editor's doctor row never fails the report (260811-a2bo): an absent binary
// is the WARN case — OK with a remediation note — matching daemon start's
// warn-and-continue discipline. The remediation is rk-managed install
// guidance, never brew.
func TestCodeServerCheckAbsentBinaryIsWarnNotFail(t *testing.T) {
	t.Setenv("RK_CODE_SERVER_PORT", "3939")
	c := codeServerCheck(
		t.TempDir(), // no managed install under this home
		func(string) (string, error) { return "", fmt.Errorf("not found") },
		func(string) bool { return false },
	)
	if c.Name != "code-server" {
		t.Errorf("name = %q, want code-server", c.Name)
	}
	if !c.OK {
		t.Error("absent binary must not fail the check (WARN case)")
	}
	if !strings.Contains(c.Note, "not installed") || !strings.Contains(c.Note, ":3939") {
		t.Errorf("note = %q, want remediation + resolved port", c.Note)
	}
	if !strings.Contains(c.Note, "rk code-server install") {
		t.Errorf("note = %q, want the rk-managed install hint", c.Note)
	}
	if strings.Contains(c.Note, "brew") {
		t.Errorf("note = %q, must not suggest brew", c.Note)
	}
}

// TestCodeServerCheckManagedVersion proves the rk-managed install is reported
// with its version (from the current symlink) and wins over a PATH install —
// the same precedence as the daemon's resolution ladder.
func TestCodeServerCheckManagedVersion(t *testing.T) {
	t.Setenv("RK_PORT", "3000")
	t.Setenv("RK_CODE_SERVER_PORT", "")
	home := t.TempDir()
	bin := filepath.Join(codeserver.VersionDir(home, "4.132.0"), "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "code-server"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("4.132.0", codeserver.CurrentPath(home)); err != nil {
		t.Fatal(err)
	}

	c := codeServerCheck(
		home,
		func(string) (string, error) { return "/usr/bin/code-server", nil }, // PATH also resolves
		func(string) bool { return true },
	)
	if !c.OK || !strings.Contains(c.Note, "managed v4.132.0") {
		t.Errorf("note = %q, want the managed version (rung 1 wins over PATH)", c.Note)
	}
	if !strings.Contains(c.Note, "reachable on 127.0.0.1:3002") {
		t.Errorf("note = %q, want reachability alongside the version", c.Note)
	}
}

// TestCodeServerCheckReachabilityNotes covers the two installed states:
// reachable reports the loopback address; unreachable reports the
// daemon-starts-it hint. Both stay OK.
func TestCodeServerCheckReachabilityNotes(t *testing.T) {
	t.Setenv("RK_PORT", "3000")
	t.Setenv("RK_CODE_SERVER_PORT", "")
	lookPath := func(string) (string, error) { return "/usr/bin/code-server", nil }

	up := codeServerCheck(t.TempDir(), lookPath, func(string) bool { return true })
	if !up.OK || !strings.Contains(up.Note, "reachable on 127.0.0.1:3002") {
		t.Errorf("reachable: %+v, want OK + convention port :3002 note", up)
	}

	down := codeServerCheck(t.TempDir(), lookPath, func(string) bool { return false })
	if !down.OK || !strings.Contains(down.Note, "not currently reachable on 127.0.0.1:3002") {
		t.Errorf("unreachable: %+v, want OK + not-reachable note with :3002", down)
	}
}

// TestCodeServerCheckUnresolvablePort proves a degenerate config (RK_PORT whose
// +2 leaves 1-65535, no override) reports an explicit not-resolvable state
// instead of probing 127.0.0.1:0 and reporting a confusing ":0" note.
func TestCodeServerCheckUnresolvablePort(t *testing.T) {
	t.Setenv("RK_PORT", "65535")
	t.Setenv("RK_CODE_SERVER_PORT", "")
	dialed := false
	c := codeServerCheck(
		t.TempDir(),
		func(string) (string, error) { return "/usr/bin/code-server", nil },
		func(string) bool { dialed = true; return false },
	)
	if !c.OK {
		t.Error("an unresolvable port must not fail the check (WARN case)")
	}
	if dialed {
		t.Error("reachability was probed on an unresolvable port")
	}
	if !strings.Contains(c.Note, "not resolvable") {
		t.Errorf("note = %q, want an explicit not-resolvable state", c.Note)
	}
	if strings.Contains(c.Note, ":0") {
		t.Errorf("note = %q, must not surface the degenerate :0 port", c.Note)
	}
}

// TestRemovedEnvCheckRKSSHHost pins the set-but-ignored RK_SSH_HOST row: the
// check exists ONLY while the var is set (a failing row naming the ssh_host
// replacement key); unset, no row appears at all.
func TestRemovedEnvCheckRKSSHHost(t *testing.T) {
	t.Run("set env yields a failing row", func(t *testing.T) {
		t.Setenv("RK_SSH_HOST", "devbox")
		c, present := removedEnvCheck()
		if !present {
			t.Fatal("RK_SSH_HOST set: no check returned, want a row")
		}
		if c.OK {
			t.Error("check OK = true, want false (set-but-ignored is a failure)")
		}
		want := "RK_SSH_HOST is no longer read — set the ssh_host key in ~/.config/hexokit/config.yaml"
		if c.Hint != want {
			t.Errorf("hint = %q, want %q", c.Hint, want)
		}
	})

	t.Run("unset env yields no row", func(t *testing.T) {
		t.Setenv("RK_SSH_HOST", "")
		if _, present := removedEnvCheck(); present {
			t.Error("RK_SSH_HOST unset: a check row was returned, want none")
		}
	})
}

// --- tmux config row ----------------------------------------------------------

// withManagedDefaultConfig points DefaultConfigPath at a temp dir and forces
// the managed (non-user-owned) resolution fact for the test's duration.
func withManagedDefaultConfig(t *testing.T) string {
	t.Helper()
	origPath := tmux.DefaultConfigPath
	dest := filepath.Join(t.TempDir(), ".config", "run-kit", "tmux.conf")
	tmux.DefaultConfigPath = dest
	t.Cleanup(func() { tmux.DefaultConfigPath = origPath })
	origOwned := tmuxUserOwnedPath
	tmuxUserOwnedPath = func() bool { return false }
	t.Cleanup(func() { tmuxUserOwnedPath = origOwned })
	// Keep the legacy-probe home away from any real ~/.rk/tmux.conf.
	t.Setenv("HOME", t.TempDir())
	return dest
}

// TestTmuxConfigCheckStates pins the five drift-row shapes plus the unreadable
// degradation: the row is always OK (informational posture — it must never
// flip the verdict) and every note names its state.
func TestTmuxConfigCheckStates(t *testing.T) {
	t.Run("user-owned when tmux_conf redirects the path", func(t *testing.T) {
		orig := tmuxUserOwnedPath
		tmuxUserOwnedPath = func() bool { return true }
		t.Cleanup(func() { tmuxUserOwnedPath = orig })
		c := tmuxConfigCheck()
		if !c.OK {
			t.Errorf("user-owned row must stay OK, got %+v", c)
		}
		if !strings.Contains(c.Note, "user-owned") {
			t.Errorf("note = %q, want the user-owned report (no drift analysis)", c.Note)
		}
	})

	t.Run("managed current", func(t *testing.T) {
		withManagedDefaultConfig(t)
		orig := tmuxConfigClassify
		tmuxConfigClassify = func(string) (tmux.ConfState, error) { return tmux.ConfManagedCurrent, nil }
		t.Cleanup(func() { tmuxConfigClassify = orig })
		c := tmuxConfigCheck()
		if !c.OK || !strings.Contains(c.Note, "managed, current") {
			t.Errorf("current row = %+v, want OK + 'managed, current'", c)
		}
	})

	t.Run("managed stale names the daemon-start refresh with the pane caveat", func(t *testing.T) {
		withManagedDefaultConfig(t)
		orig := tmuxConfigClassify
		tmuxConfigClassify = func(string) (tmux.ConfState, error) { return tmux.ConfManagedStale, nil }
		t.Cleanup(func() { tmuxConfigClassify = orig })
		c := tmuxConfigCheck()
		if !c.OK || !strings.Contains(c.Note, "stale") || !strings.Contains(c.Note, "next daemon start") {
			t.Errorf("stale row = %+v, want OK + refresh note", c)
		}
		if !strings.Contains(c.Note, "panes created after") {
			t.Errorf("stale note must carry the history-limit pane-creation caveat, got %q", c.Note)
		}
	})

	t.Run("hand-edited carries the migration recipe", func(t *testing.T) {
		withManagedDefaultConfig(t)
		orig := tmuxConfigClassify
		tmuxConfigClassify = func(string) (tmux.ConfState, error) { return tmux.ConfHandEdited, nil }
		t.Cleanup(func() { tmuxConfigClassify = orig })
		c := tmuxConfigCheck()
		if !c.OK {
			t.Errorf("hand-edited row must stay OK, got %+v", c)
		}
		if !strings.Contains(c.Note, "tmux.d/user.conf") || !strings.Contains(c.Note, "rk mux init-conf --force") {
			t.Errorf("note = %q, want the recipe (user.conf + init-conf --force)", c.Note)
		}
	})

	t.Run("missing reports the scaffold trigger", func(t *testing.T) {
		withManagedDefaultConfig(t)
		orig := tmuxConfigClassify
		tmuxConfigClassify = func(string) (tmux.ConfState, error) { return tmux.ConfMissing, nil }
		t.Cleanup(func() { tmuxConfigClassify = orig })
		c := tmuxConfigCheck()
		if !c.OK || !strings.Contains(c.Note, "daemon start") {
			t.Errorf("missing row = %+v, want OK + scaffold note", c)
		}
	})

	t.Run("classifier error degrades to an OK note", func(t *testing.T) {
		withManagedDefaultConfig(t)
		orig := tmuxConfigClassify
		tmuxConfigClassify = func(string) (tmux.ConfState, error) { return tmux.ConfMissing, fmt.Errorf("permission denied") }
		t.Cleanup(func() { tmuxConfigClassify = orig })
		c := tmuxConfigCheck()
		if !c.OK || !strings.Contains(c.Note, "permission denied") {
			t.Errorf("unreadable row = %+v, want OK + note naming the failure", c)
		}
	})

	t.Run("un-migrated legacy conf carries the recipe naming the old path", func(t *testing.T) {
		withManagedDefaultConfig(t)
		// The legacy probe reads $HOME/.rk/tmux.conf directly (doctor is
		// read-only — it never migrates).
		home := os.Getenv("HOME")
		legacy := filepath.Join(home, ".rk", "tmux.conf")
		if err := os.MkdirAll(filepath.Dir(legacy), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(legacy, []byte("# hand-tuned\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		orig := tmuxConfigClassify
		tmuxConfigClassify = func(string) (tmux.ConfState, error) { return tmux.ConfManagedCurrent, nil }
		t.Cleanup(func() { tmuxConfigClassify = orig })
		c := tmuxConfigCheck()
		if !c.OK {
			t.Errorf("legacy-path row must stay OK, got %+v", c)
		}
		if !strings.Contains(c.Note, legacy) {
			t.Errorf("note = %q, want the recipe naming the old path %q", c.Note, legacy)
		}
		if !strings.Contains(c.Note, "rk mux init-conf --force") {
			t.Errorf("note = %q, want the init-conf --force recipe", c.Note)
		}
	})
}

// TestTmuxConfigCheckNeverFlipsVerdict proves the row cannot change the
// overall report verdict: with a hand-edited managed file (the worst drift
// state), runDoctorChecks still appends an OK row.
func TestTmuxConfigCheckNeverFlipsVerdict(t *testing.T) {
	withManagedDefaultConfig(t)
	orig := tmuxConfigClassify
	tmuxConfigClassify = func(string) (tmux.ConfState, error) { return tmux.ConfHandEdited, nil }
	t.Cleanup(func() { tmuxConfigClassify = orig })

	found := false
	for _, c := range runDoctorChecks().Checks {
		if c.Name == "tmux config" {
			found = true
			if !c.OK {
				t.Errorf("tmux config row must always be OK-shaped, got %+v", c)
			}
		}
	}
	if !found {
		t.Error("runDoctorChecks must append the tmux config row unconditionally")
	}
}

// --- code bridge row ----------------------------------------------------------

// writeBridgeFixture plants an installed rk-code-bridge extension of the given
// version under a temp extensions dir (code-server's <publisher>.<name>-<v>
// layout) and returns the dir.
func writeBridgeFixture(t *testing.T, version string) string {
	t.Helper()
	dir := t.TempDir()
	pkgDir := filepath.Join(dir, "run-kit.rk-code-bridge-"+version)
	if err := os.MkdirAll(pkgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := fmt.Sprintf(`{"name":"rk-code-bridge","publisher":"run-kit","version":%q}`, version)
	if err := os.WriteFile(filepath.Join(pkgDir, "package.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// TestCodeBridgeCheckNotInstalled pins the absent-extension row: the
// remediation note, no host enumeration, and the always-OK shape.
func TestCodeBridgeCheckNotInstalled(t *testing.T) {
	c := codeBridgeCheck(t.TempDir(), "1.2.3", func() (int, error) {
		t.Error("listHosts must not run when the extension is absent")
		return 0, nil
	})
	if c.Name != "code bridge" {
		t.Errorf("name = %q, want %q", c.Name, "code bridge")
	}
	if !c.OK {
		t.Errorf("not-installed row must stay OK, got %+v", c)
	}
	if c.Note != "not installed — run rk code-server install" {
		t.Errorf("note = %q, want the install remediation", c.Note)
	}
}

// TestCodeBridgeCheckInstalledWithLiveHosts pins the installed row: version
// plus live host count, and no bundled-is-newer clause when the embedded
// version matches.
func TestCodeBridgeCheckInstalledWithLiveHosts(t *testing.T) {
	dir := writeBridgeFixture(t, "1.2.3")
	c := codeBridgeCheck(dir, "1.2.3", func() (int, error) { return 2, nil })
	if !c.OK {
		t.Errorf("installed row must stay OK, got %+v", c)
	}
	if want := "installed v1.2.3; 2 live host(s)"; c.Note != want {
		t.Errorf("note = %q, want %q", c.Note, want)
	}
}

// TestCodeBridgeCheckBundledNewer pins the skew clause: appended when the
// embedded version is newer, absent on a dev build (no bundled VSIX → "").
func TestCodeBridgeCheckBundledNewer(t *testing.T) {
	dir := writeBridgeFixture(t, "1.2.3")

	newer := codeBridgeCheck(dir, "1.3.0", func() (int, error) { return 0, nil })
	want := "installed v1.2.3; 0 live host(s); bundled v1.3.0 is newer — run rk code-server update"
	if newer.Note != want {
		t.Errorf("note = %q, want %q", newer.Note, want)
	}

	devBuild := codeBridgeCheck(dir, "", func() (int, error) { return 1, nil })
	if strings.Contains(devBuild.Note, "bundled") {
		t.Errorf("dev-build note = %q, want no bundled-is-newer clause", devBuild.Note)
	}
	if want := "installed v1.2.3; 1 live host(s)"; devBuild.Note != want {
		t.Errorf("dev-build note = %q, want %q", devBuild.Note, want)
	}
}

// TestCodeBridgeCheckEnumerationError pins the degradation: a host-enumeration
// failure is an OK row naming the failure, with the installed version intact.
func TestCodeBridgeCheckEnumerationError(t *testing.T) {
	dir := writeBridgeFixture(t, "1.2.3")
	c := codeBridgeCheck(dir, "", func() (int, error) { return 0, fmt.Errorf("socket dir unreadable") })
	if !c.OK {
		t.Errorf("enumeration error must never fail the row, got %+v", c)
	}
	if !strings.Contains(c.Note, "installed v1.2.3") || !strings.Contains(c.Note, "socket dir unreadable") {
		t.Errorf("note = %q, want the installed version plus the failure", c.Note)
	}
}

// TestCodeBridgeCheckNeverFlipsVerdict proves the appended row cannot change
// the overall report verdict and appears in --json like every other check.
// The production seams are stubbed so the sweep stays off the real state dir.
func TestCodeBridgeCheckNeverFlipsVerdict(t *testing.T) {
	origVersion, origHosts := codeBridgeEmbeddedVersion, codeBridgeLiveHostCount
	codeBridgeEmbeddedVersion = func() string { return "" }
	codeBridgeLiveHostCount = func() (int, error) { return 0, nil }
	t.Cleanup(func() { codeBridgeEmbeddedVersion, codeBridgeLiveHostCount = origVersion, origHosts })

	report := runDoctorChecks()
	found := false
	for _, c := range report.Checks {
		if c.Name == "code bridge" {
			found = true
			if !c.OK {
				t.Errorf("code bridge row must always be OK-shaped, got %+v", c)
			}
		}
	}
	if !found {
		t.Fatal("runDoctorChecks must append the code bridge row")
	}

	data, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Checks []struct {
			Name string `json:"name"`
			OK   bool   `json:"ok"`
		} `json:"checks"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	jsonFound := false
	for _, c := range decoded.Checks {
		if c.Name == "code bridge" {
			jsonFound = true
			if !c.OK {
				t.Error("--json code bridge row must be ok:true")
			}
		}
	}
	if !jsonFound {
		t.Error("--json report is missing the code bridge row")
	}
}

// --- agent hooks check -----------------------------------------------------

// agentHooksFixture builds the (readFile, stat) seams for agentHooksCheck
// tests from a settings.json body plus a set of executable paths.
func agentHooksFixture(t *testing.T, home string, settingsBody []byte, readErr error, executables map[string]bool) (func(string) ([]byte, error), func(string) (os.FileInfo, error)) {
	t.Helper()
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	readFile := func(path string) ([]byte, error) {
		if path != settingsPath {
			return nil, os.ErrNotExist
		}
		if readErr != nil {
			return nil, readErr
		}
		if settingsBody == nil {
			return nil, os.ErrNotExist
		}
		return settingsBody, nil
	}
	stat := func(path string) (os.FileInfo, error) {
		if executables[path] {
			return fakeFileInfo{mode: 0o755}, nil
		}
		return nil, os.ErrNotExist
	}
	return readFile, stat
}

// fakeFileInfo is the minimal os.FileInfo for the stat seam.
type fakeFileInfo struct{ mode os.FileMode }

func (f fakeFileInfo) Name() string       { return "rk" }
func (f fakeFileInfo) Size() int64        { return 0 }
func (f fakeFileInfo) Mode() os.FileMode  { return f.mode }
func (f fakeFileInfo) ModTime() time.Time { return time.Time{} }
func (f fakeFileInfo) IsDir() bool        { return false }
func (f fakeFileInfo) Sys() any           { return nil }

// hookSettingsJSON wraps one hook command into a settings.json body.
func hookSettingsJSON(command string) []byte {
	return []byte(`{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":` +
		strconv.Quote(command) + `}]}]}}`)
}

func TestAgentHooksCheckAbsentFileIsNotInstalled(t *testing.T) {
	home := t.TempDir()
	readFile, stat := agentHooksFixture(t, home, nil, nil, nil)
	c := agentHooksCheck(home, readFile, stat)
	if !c.OK {
		t.Errorf("OK = false, want true (absent settings file is the optional not-installed case): %s", c.Hint)
	}
	if !strings.Contains(c.Note, "not installed") {
		t.Errorf("Note = %q, want the not-installed note", c.Note)
	}
}

func TestAgentHooksCheckNoRkEntriesIsNotInstalled(t *testing.T) {
	home := t.TempDir()
	body := []byte(`{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"/usr/local/bin/guard.sh"}]}]}}`)
	readFile, stat := agentHooksFixture(t, home, body, nil, nil)
	c := agentHooksCheck(home, readFile, stat)
	if !c.OK {
		t.Errorf("OK = false, want true (no rk entries): %s", c.Hint)
	}
	if !strings.Contains(c.Note, "not installed") {
		t.Errorf("Note = %q, want the not-installed note", c.Note)
	}
}

func TestAgentHooksCheckGen3Installed(t *testing.T) {
	home := t.TempDir()
	readFile, stat := agentHooksFixture(t, home, hookSettingsJSON(agentStateHookCommand(testLauncherPath, "/opt/homebrew/bin/rk", "active", "claude")), nil,
		map[string]bool{testLauncherPath: true, "/opt/homebrew/bin/rk": true})
	c := agentHooksCheck(home, readFile, stat)
	if !c.OK {
		t.Errorf("OK = false, want true (gen-3 with a live rk path): %s", c.Hint)
	}
	if !strings.Contains(c.Note, "generation 3") {
		t.Errorf("Note = %q, want the generation-3 installed note", c.Note)
	}
}

func TestAgentHooksCheckGen1StaleFails(t *testing.T) {
	home := t.TempDir()
	gen1 := `sh -c '[ -n "$TMUX_PANE" ] || exit 0; tmux set-option -pt "$TMUX_PANE" ` + rkHookMarker + ` "active:$(date +%s)" 2>/dev/null || true'`
	readFile, stat := agentHooksFixture(t, home, hookSettingsJSON(gen1), nil, nil)
	c := agentHooksCheck(home, readFile, stat)
	if c.OK {
		t.Error("OK = true, want false (gen-1 entries write legacy option names)")
	}
	if !strings.Contains(c.Hint, "generation 1") {
		t.Errorf("Hint = %q, want a generation-1 stale-hint", c.Hint)
	}
}

func TestAgentHooksCheckGen2StaleFails(t *testing.T) {
	home := t.TempDir()
	gen2 := `/bin/sh -c '[ -n "$TMUX_PANE" ] || exit 0; "/opt/homebrew/bin/rk" agent-hook --agent claude active 2>/dev/null || true'`
	readFile, stat := agentHooksFixture(t, home, hookSettingsJSON(gen2), nil, nil)
	c := agentHooksCheck(home, readFile, stat)
	if c.OK {
		t.Error("OK = true, want false (gen-2 entries are stale)")
	}
	if !strings.Contains(c.Hint, "generation 2") {
		t.Errorf("Hint = %q, want a generation-2 stale-hint", c.Hint)
	}
}

func TestAgentHooksCheckGen3DanglingPathFails(t *testing.T) {
	home := t.TempDir()
	readFile, stat := agentHooksFixture(t, home, hookSettingsJSON(agentStateHookCommand("/removed/keg/run-kit", "/removed/keg/rk", "active", "claude")), nil, nil)
	c := agentHooksCheck(home, readFile, stat)
	if c.OK {
		t.Error("OK = true, want false (gen-3 with a dangling rk path writes nothing)")
	}
	if !strings.Contains(c.Hint, "/removed/keg/rk") {
		t.Errorf("Hint = %q, want the dangling path named", c.Hint)
	}
}

func TestAgentHooksCheckUnreadableFileFails(t *testing.T) {
	home := t.TempDir()
	readFile, stat := agentHooksFixture(t, home, nil, os.ErrPermission, nil)
	c := agentHooksCheck(home, readFile, stat)
	if c.OK {
		t.Error("OK = true, want false (a present-but-unreadable settings file is not the not-installed case)")
	}
	if !strings.Contains(c.Hint, "unreadable") {
		t.Errorf("Hint = %q, want the unreadable-file hint", c.Hint)
	}
}

func TestClassifyHookGeneration(t *testing.T) {
	gen1 := `tmux set-option -pt "$TMUX_PANE" ` + rkHookMarker + ` "active:1"`
	gen2 := `"rk" agent-hook --agent claude active`
	gen3 := agentStateHookCommand(testLauncherPath, "/opt/homebrew/bin/rk", "idle", "claude")
	cases := []struct {
		cmd  string
		want int
	}{
		{gen1, 1},
		{gen2, 2},
		{gen3, 3},
		{"/usr/local/bin/guard.sh", 0},
	}
	for _, c := range cases {
		if got := classifyHookGeneration(c.cmd); got != c.want {
			t.Errorf("classifyHookGeneration(%q) = %d, want %d", c.cmd, got, c.want)
		}
	}
}

func TestHookRkPaths(t *testing.T) {
	// A two-path (fourth-generation) wrapper parses to BOTH embedded paths in
	// launcher-first order; a gen-3 single-path command parses to the one.
	twoPath := agentStateHookCommand(testLauncherPath, "/opt/homebrew/bin/rk", "active", "claude")
	got := hookRkPaths(twoPath)
	if len(got) != 2 || got[0] != testLauncherPath || got[1] != "/opt/homebrew/bin/rk" {
		t.Errorf("hookRkPaths(two-path) = %v, want [%s /opt/homebrew/bin/rk]", got, testLauncherPath)
	}
	twoPathJSON := agentStateHookCommandJSON(testLauncherPath, "/opt/homebrew/bin/rk", "idle", "agy")
	got = hookRkPaths(twoPathJSON)
	if len(got) != 2 || got[0] != testLauncherPath || got[1] != "/opt/homebrew/bin/rk" {
		t.Errorf("hookRkPaths(two-path JSON) = %v, want [%s /opt/homebrew/bin/rk]", got, testLauncherPath)
	}
	singlePath := `/bin/sh -c '[ -n "$TMUX_PANE" ] || exit 0; "/opt/homebrew/bin/rk" agent hook --agent claude active 2>/dev/null || true'`
	if got := hookRkPaths(singlePath); len(got) != 1 || got[0] != "/opt/homebrew/bin/rk" {
		t.Errorf("hookRkPaths(single-path) = %v, want [/opt/homebrew/bin/rk]", got)
	}
	if got := hookRkPaths("no quoted token"); len(got) != 0 {
		t.Errorf("hookRkPaths on an unquoted command = %v, want empty", got)
	}
}

// TestCheckHookRkPathTwoPathVerdicts pins the two-path dangling semantics: the
// check fails only when EVERY embedded path dangles (the hint lists them all);
// a partially dangling two-path wrapper passes with an advisory note naming
// the dangling side; a single-path (gen-3) wrapper passes with the
// add-the-fallback note.
func TestCheckHookRkPathTwoPathVerdicts(t *testing.T) {
	agent := agentConfig{name: "Test", provider: "claude"}
	statFor := func(live ...string) func(string) (os.FileInfo, error) {
		return func(path string) (os.FileInfo, error) {
			if slices.Contains(live, path) {
				return fakeFileInfo{mode: 0o755}, nil
			}
			return nil, os.ErrNotExist
		}
	}
	const stable = "/opt/homebrew/bin/rk"
	twoPath := agentStateHookCommand(testLauncherPath, stable, "active", "claude")
	twoPathJSON := agentStateHookCommandJSON(testLauncherPath, stable, "idle", "agy")

	t.Run("both paths live pass without a note (classic and JSON)", func(t *testing.T) {
		for _, cmd := range []string{twoPath, twoPathJSON} {
			hint, note := checkHookRkPath(agent, "settings.json", cmd, statFor(testLauncherPath, stable))
			if hint != "" || note != "" {
				t.Errorf("checkHookRkPath(both live) = (%q, %q), want clean pass", hint, note)
			}
		}
	})

	t.Run("all paths dangling fails, hint lists every path", func(t *testing.T) {
		hint, note := checkHookRkPath(agent, "settings.json", twoPath, statFor())
		if hint == "" {
			t.Fatal("all-dangling must fail")
		}
		if !strings.Contains(hint, testLauncherPath) || !strings.Contains(hint, stable) {
			t.Errorf("hint = %q, want both dangling paths named", hint)
		}
		if note != "" {
			t.Errorf("a failing check carries no advisory note, got %q", note)
		}
	})

	t.Run("launcher dangling, stable live → pass with the launcher note", func(t *testing.T) {
		hint, note := checkHookRkPath(agent, "settings.json", twoPath, statFor(stable))
		if hint != "" {
			t.Fatalf("partially dangling must pass, got hint %q", hint)
		}
		want := "launcher " + testLauncherPath + " dangling — re-run `rk agent setup`"
		if note != want {
			t.Errorf("note = %q, want %q", note, want)
		}
	})

	t.Run("stable dangling, launcher live → pass with the stable note", func(t *testing.T) {
		hint, note := checkHookRkPath(agent, "settings.json", twoPath, statFor(testLauncherPath))
		if hint != "" {
			t.Fatalf("partially dangling must pass, got hint %q", hint)
		}
		want := "stable path " + stable + " dangling — re-run `rk agent setup`"
		if note != want {
			t.Errorf("note = %q, want %q", note, want)
		}
	})

	t.Run("single-path gen-3 wrapper passes with the fallback note", func(t *testing.T) {
		singlePath := `/bin/sh -c '[ -n "$TMUX_PANE" ] || exit 0; "` + stable + `" agent hook --agent claude active 2>/dev/null || true'`
		hint, note := checkHookRkPath(agent, "settings.json", singlePath, statFor(stable))
		if hint != "" {
			t.Fatalf("a live single-path wrapper must pass, got hint %q", hint)
		}
		want := "single-path wrapper — re-run `rk agent setup` to add the launcher fallback"
		if note != want {
			t.Errorf("note = %q, want %q", note, want)
		}
	})
}

// TestExtractRkHookCommandsTwoConstPlugin pins the plugin parse: the RK and
// RK_FALLBACK consts synthesize ONE combined two-invocation command, so the
// dangling-path verdict matches the shell wrappers (fail only when both
// dangle); a plugin carrying only RK (pre-fallback generation) parses to the
// single path.
// A marker-owned plugin that lost its `const RK` line (fallback-only) must not
// read healthy: the extraction yields a sentinel path that can never stat.
func TestExtractRkHookCommandsFallbackOnlyPluginIsUnhealthy(t *testing.T) {
	content := "// " + skillManagedByMarker + "\nconst RK_FALLBACK = \"/opt/homebrew/bin/rk\";\n"
	cmds := extractRkHookCommands(content)
	if len(cmds) != 1 || !strings.Contains(cmds[0], opencodeMissingRKConst) {
		t.Fatalf("fallback-only plugin must yield the missing-RK sentinel command, got %q", cmds)
	}
	paths := hookRkPaths(cmds[0])
	if len(paths) != 1 || paths[0] != opencodeMissingRKConst {
		t.Fatalf("hookRkPaths = %q, want the sentinel", paths)
	}
	hint, _ := checkHookRkPath(agentConfig{name: "OpenCode", filePath: "/x/run-kit.js"}, "/x/run-kit.js", cmds[0], func(string) (os.FileInfo, error) { return nil, os.ErrNotExist })
	if hint == "" || !strings.Contains(hint, opencodeMissingRKConst) {
		t.Errorf("expected a failing hint naming the sentinel, got %q", hint)
	}
}

func TestExtractRkHookCommandsTwoConstPlugin(t *testing.T) {
	const stable = "/opt/homebrew/bin/rk"
	cmds := extractRkHookCommands(opencodePluginFile(testLauncherPath, stable))
	if len(cmds) != 1 {
		t.Fatalf("two-const plugin must synthesize exactly one combined command, got %v", cmds)
	}
	got := hookRkPaths(cmds[0])
	if len(got) != 2 || got[0] != testLauncherPath || got[1] != stable {
		t.Errorf("combined command paths = %v, want [%s %s] (launcher first)", got, testLauncherPath, stable)
	}

	rkOnly := "const RK = \"/opt/homebrew/bin/rk\";\nexecFile(RK, [\"agent\", \"hook\"])\n"
	cmds = extractRkHookCommands(rkOnly)
	if len(cmds) != 1 {
		t.Fatalf("single-const plugin must yield one command, got %v", cmds)
	}
	if got := hookRkPaths(cmds[0]); len(got) != 1 || got[0] != stable {
		t.Errorf("single-const paths = %v, want [%s]", got, stable)
	}
}

// TestCronTickerCheck pins the cron ticker row: always OK-shaped, reporting
// the cron_ticker setting state and the cron state dir's path.
func TestCronTickerCheck(t *testing.T) {
	t.Run("default on with the resolved state dir", func(t *testing.T) {
		t.Setenv(settings.ConfigDirEnv, t.TempDir())
		stateHome := t.TempDir()
		t.Setenv("XDG_STATE_HOME", stateHome)
		c := cronTickerCheck()
		if !c.OK {
			t.Errorf("row must always be OK-shaped, got %+v", c)
		}
		wantDir := filepath.Join(stateHome, "hexokit", "cron")
		if !strings.Contains(c.Note, "cron_ticker on") || !strings.Contains(c.Note, wantDir) {
			t.Errorf("note = %q, want the setting state and the state dir %s", c.Note, wantDir)
		}
	})

	t.Run("off when the setting disables it", func(t *testing.T) {
		cfgDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(cfgDir, "config.yaml"), []byte("cron_ticker: false\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Setenv(settings.ConfigDirEnv, cfgDir)
		t.Setenv("XDG_STATE_HOME", t.TempDir())
		c := cronTickerCheck()
		if !c.OK {
			t.Errorf("row must always be OK-shaped, got %+v", c)
		}
		if !strings.Contains(c.Note, "cron_ticker off") {
			t.Errorf("note = %q, want the off setting state", c.Note)
		}
	})
}

// TestCronTickerCheckNeverFlipsVerdict: the row is registered unconditionally
// and informational — it can never fail the report.
func TestCronTickerCheckNeverFlipsVerdict(t *testing.T) {
	t.Setenv(settings.ConfigDirEnv, t.TempDir())
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	found := false
	for _, c := range runDoctorChecks().Checks {
		if c.Name == "cron ticker" {
			found = true
			if !c.OK {
				t.Errorf("cron ticker row must always be OK-shaped, got %+v", c)
			}
		}
	}
	if !found {
		t.Error("runDoctorChecks must append the cron ticker row unconditionally")
	}
}

// --- agent hooks aggregation across providers --------------------------------

// agentHooksMapFixture builds the (readFile, stat) seams from a path→body map
// (absent keys read as not-exist) plus a set of executable paths.
func agentHooksMapFixture(t *testing.T, bodies map[string][]byte, executables map[string]bool) (func(string) ([]byte, error), func(string) (os.FileInfo, error)) {
	t.Helper()
	readFile := func(path string) ([]byte, error) {
		if body, ok := bodies[path]; ok {
			return body, nil
		}
		return nil, os.ErrNotExist
	}
	stat := func(path string) (os.FileInfo, error) {
		if executables[path] {
			return fakeFileInfo{mode: 0o755}, nil
		}
		return nil, os.ErrNotExist
	}
	return readFile, stat
}

func TestAgentHooksCheckAggregatesProviders(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", "")
	t.Setenv("COPILOT_HOME", "")
	t.Setenv("KIMI_CODE_HOME", "")
	// claude gen-3 (healthy) + codex gen-3 (healthy) → one aggregated note
	// naming both providers.
	bodies := map[string][]byte{
		filepath.Join(home, ".claude", "settings.json"): hookSettingsJSON(agentStateHookCommand(testLauncherPath, "/opt/homebrew/bin/rk", "active", "claude")),
		filepath.Join(home, ".codex", "hooks.json"):     hookSettingsJSON(agentStateHookCommand(testLauncherPath, "/opt/homebrew/bin/rk", "stamp", "codex")),
	}
	readFile, stat := agentHooksMapFixture(t, bodies, map[string]bool{testLauncherPath: true, "/opt/homebrew/bin/rk": true})
	c := agentHooksCheck(home, readFile, stat)
	if !c.OK {
		t.Fatalf("OK = false, want true: %s", c.Hint)
	}
	if !strings.Contains(c.Note, "claude") || !strings.Contains(c.Note, "codex") {
		t.Errorf("Note = %q, want both providers listed", c.Note)
	}
}

func TestAgentHooksCheckStaleInAnyProviderFails(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", "")
	t.Setenv("COPILOT_HOME", "")
	t.Setenv("KIMI_CODE_HOME", "")
	// claude healthy gen-3, codex carrying a stale gen-2 entry — the aggregate
	// must fail regardless of registry order.
	gen2 := `/bin/sh -c '[ -n "$TMUX_PANE" ] || exit 0; "/opt/homebrew/bin/rk" agent-hook --agent codex stamp 2>/dev/null || true'`
	bodies := map[string][]byte{
		filepath.Join(home, ".claude", "settings.json"): hookSettingsJSON(agentStateHookCommand(testLauncherPath, "/opt/homebrew/bin/rk", "active", "claude")),
		filepath.Join(home, ".codex", "hooks.json"):     hookSettingsJSON(gen2),
	}
	readFile, stat := agentHooksMapFixture(t, bodies, map[string]bool{testLauncherPath: true, "/opt/homebrew/bin/rk": true})
	c := agentHooksCheck(home, readFile, stat)
	if c.OK {
		t.Error("OK = true, want false (a stale entry in ANY provider fails the row)")
	}
	if !strings.Contains(c.Hint, "Codex") || !strings.Contains(c.Hint, "generation 2") {
		t.Errorf("Hint = %q, want the codex generation-2 stale hint", c.Hint)
	}
}

func TestAgentHooksCheckCopilotMarkerFile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", "")
	t.Setenv("COPILOT_HOME", "")
	t.Setenv("KIMI_CODE_HOME", "")
	// A copilot marker file whose embedded rk path dangles fails; a healthy one
	// reports installed.
	dangling := copilotHooksFile("/removed/keg/run-kit", "/removed/keg/rk")
	bodies := map[string][]byte{filepath.Join(home, ".copilot", "hooks", "run-kit.json"): []byte(dangling)}
	readFile, stat := agentHooksMapFixture(t, bodies, nil)
	c := agentHooksCheck(home, readFile, stat)
	if c.OK {
		t.Error("OK = true, want false (dangling embedded rk path)")
	}
	if !strings.Contains(c.Hint, "GitHub Copilot") {
		t.Errorf("Hint = %q, want the copilot prefix", c.Hint)
	}

	bodies[filepath.Join(home, ".copilot", "hooks", "run-kit.json")] = []byte(copilotHooksFile(testLauncherPath, "/opt/homebrew/bin/rk"))
	readFile, stat = agentHooksMapFixture(t, bodies, map[string]bool{testLauncherPath: true, "/opt/homebrew/bin/rk": true})
	c = agentHooksCheck(home, readFile, stat)
	if !c.OK || !strings.Contains(c.Note, "copilot") {
		t.Errorf("healthy copilot marker file: OK = %v Note = %q", c.OK, c.Note)
	}

	// A foreign marker-less file at the path is not an rk install.
	bodies[filepath.Join(home, ".copilot", "hooks", "run-kit.json")] = []byte(`{"version":1,"hooks":{}}`)
	readFile, stat = agentHooksMapFixture(t, bodies, nil)
	c = agentHooksCheck(home, readFile, stat)
	if !c.OK || !strings.Contains(c.Note, "not installed") {
		t.Errorf("foreign file: OK = %v Note = %q, want not-installed", c.OK, c.Note)
	}
}

func TestAgentHooksCheckKimiMarkerBlock(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", "")
	t.Setenv("COPILOT_HOME", "")
	t.Setenv("KIMI_CODE_HOME", "")
	_, _, block := kimiHooksBlock(testLauncherPath, "/opt/homebrew/bin/rk")
	bodies := map[string][]byte{
		filepath.Join(home, ".kimi-code", "config.toml"): []byte("model = \"k2\"\n" + block),
	}
	readFile, stat := agentHooksMapFixture(t, bodies, map[string]bool{testLauncherPath: true, "/opt/homebrew/bin/rk": true})
	c := agentHooksCheck(home, readFile, stat)
	if !c.OK || !strings.Contains(c.Note, "kimi") {
		t.Errorf("healthy kimi block: OK = %v Note = %q", c.OK, c.Note)
	}

	// A malformed block (begin without end) fails with the repair hint.
	bodies[filepath.Join(home, ".kimi-code", "config.toml")] = []byte("model = \"k2\"\n" + kimiHooksBlockBegin + "\n")
	readFile, stat = agentHooksMapFixture(t, bodies, nil)
	c = agentHooksCheck(home, readFile, stat)
	if c.OK || !strings.Contains(c.Hint, "Kimi") {
		t.Errorf("malformed kimi block: OK = %v Hint = %q, want a kimi failure", c.OK, c.Hint)
	}
}

func TestAgentHooksCheckOpencodePlugin(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", "")
	t.Setenv("COPILOT_HOME", "")
	t.Setenv("KIMI_CODE_HOME", "")
	bodies := map[string][]byte{
		filepath.Join(home, ".config", "opencode", "plugins", "run-kit.js"): []byte(opencodePluginFile(testLauncherPath, "/opt/homebrew/bin/rk")),
	}
	readFile, stat := agentHooksMapFixture(t, bodies, map[string]bool{testLauncherPath: true, "/opt/homebrew/bin/rk": true})
	c := agentHooksCheck(home, readFile, stat)
	if !c.OK || !strings.Contains(c.Note, "opencode") {
		t.Errorf("healthy opencode plugin: OK = %v Note = %q", c.OK, c.Note)
	}

	// Both embedded paths dangling fails — extractRkHookCommands recovers them
	// from the plugin's `const RK = "..."` / `const RK_FALLBACK = "..."` lines
	// so the dangle is caught.
	bodies[filepath.Join(home, ".config", "opencode", "plugins", "run-kit.js")] = []byte(opencodePluginFile("/removed/keg/run-kit", "/removed/keg/rk"))
	readFile, stat = agentHooksMapFixture(t, bodies, nil)
	c = agentHooksCheck(home, readFile, stat)
	if c.OK || !strings.Contains(c.Hint, "OpenCode") {
		t.Errorf("dangling opencode rk path: OK = %v Hint = %q, want an OpenCode failure", c.OK, c.Hint)
	}
}

func TestAgentHooksCheckAgyNamedDoc(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", "")
	t.Setenv("COPILOT_HOME", "")
	t.Setenv("KIMI_CODE_HOME", "")
	settings := map[string]any{"run-kit": agyNamedHookEntry(testLauncherPath, "/opt/homebrew/bin/rk")}
	body, _ := json.Marshal(settings)
	bodies := map[string][]byte{filepath.Join(home, ".gemini", "config", "hooks.json"): body}
	readFile, stat := agentHooksMapFixture(t, bodies, map[string]bool{testLauncherPath: true, "/opt/homebrew/bin/rk": true})
	c := agentHooksCheck(home, readFile, stat)
	if !c.OK || !strings.Contains(c.Note, "agy") {
		t.Errorf("healthy agy named hook: OK = %v Note = %q", c.OK, c.Note)
	}

	// Dangling embedded rk path fails.
	settings["run-kit"] = agyNamedHookEntry("/removed/keg/run-kit", "/removed/keg/rk")
	body, _ = json.Marshal(settings)
	bodies[filepath.Join(home, ".gemini", "config", "hooks.json")] = body
	readFile, stat = agentHooksMapFixture(t, bodies, nil)
	c = agentHooksCheck(home, readFile, stat)
	if c.OK || !strings.Contains(c.Hint, "Antigravity") {
		t.Errorf("dangling agy rk path: OK = %v Hint = %q, want an Antigravity failure", c.OK, c.Hint)
	}
}

// TestGuiCheckStates pins the gui row's states: the exact Note strings and
// the always-OK shape (the row reports state, never a verdict). The
// reachable+bare note appends the WM install hint (doctor-only; the status
// line keeps the bare "no window manager").
func TestGuiCheckStates(t *testing.T) {
	resolveAll := func(name string) (string, error) { return "/usr/bin/" + name, nil }
	resolveNone := func(name string) (string, error) { return "", fmt.Errorf("not found: %s", name) }
	reachable := gui.Info{Reachable: true, Width: 1920, Height: 1080}
	down := gui.Info{Reason: "not running"}

	cases := []struct {
		name             string
		enabled, session bool
		display, backend string
		wm               string
		geometry         string
		probe            gui.Info
		viewers          int
		locked           bool
		lookPath         func(string) (string, error)
		want             string
	}{
		{"off", false, false, "", "", "", "", gui.Info{}, 0, false, resolveAll,
			"off"},
		{"on reachable with wm", true, true, ":10", "Xtigervnc", "icewm-session", "1920x1080", reachable, 1, false, resolveAll,
			"on (Xtigervnc, :10, 1920x1080 fixed, 1 viewer, icewm-session)"},
		{"on reachable locked", true, true, ":10", "Xtigervnc", "icewm-session", "1920x1080", reachable, 1, true, resolveAll,
			"on (Xtigervnc, :10, 1920x1080 fixed, 1 viewer, icewm-session, locked)"},
		{"on reachable bare", true, true, ":10", "Xtigervnc", "", "1920x1080", reachable, 0, false, resolveAll,
			"on (Xtigervnc, :10, 1920x1080 fixed, 0 viewers, no window manager — sudo apt install --no-install-recommends icewm)"},
		{"on reachable fixed", true, true, ":10", "Xtigervnc", "icewm-session", "1600x900",
			gui.Info{Reachable: true, Width: 1600, Height: 900}, 1, false, resolveAll,
			"on (Xtigervnc, :10, 1600x900 fixed, 1 viewer, icewm-session)"},
		{"on reachable auto", true, true, ":10", "Xtigervnc", "icewm-session", "auto", reachable, 1, false, resolveAll,
			"on (Xtigervnc, :10, 1920x1080 auto, 1 viewer, icewm-session)"},
		{"on reachable empty geometry stays bare", true, true, ":10", "Xtigervnc", "icewm-session", "", reachable, 1, false, resolveAll,
			"on (Xtigervnc, :10, 1920x1080, 1 viewer, icewm-session)"},
		{"on session absent", true, false, "", "", "", "", down, 0, false, resolveAll,
			"on — not running (rk-gui session absent; the daemon starts it on 'rk daemon start')"},
		{"on no backend", true, true, "", "", "", "", down, 0, false, resolveNone,
			"on — not running (no VNC backend: install a VNC X server (TigerVNC) and icewm with your package manager)"},
		{"on backend exited", true, true, ":10", "Xtigervnc", "", "", down, 0, false, resolveAll,
			"on — not running (Xtigervnc exited — see the rk-gui pane; 'rk gui restart')"},
		{"on screen sharing off", true, true, "", "screen-sharing", "", "", down, 0, false, resolveAll,
			"on — not running (Screen Sharing is off: System Settings › General › Sharing › Screen Sharing)"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			check := guiCheck(c.enabled, c.session, c.display, c.backend, c.wm, c.geometry, c.probe, c.viewers, c.locked, c.lookPath)
			if !check.OK {
				t.Errorf("OK = false, want true — the gui row is never a verdict flipper")
			}
			if check.Name != "gui" {
				t.Errorf("Name = %q, want gui", check.Name)
			}
			if check.Note != c.want {
				t.Errorf("Note = %q, want exactly %q", check.Note, c.want)
			}
		})
	}
}

// TestMCPCheckBranches drives both branches of the pure mcp row builder:
// resolution success is an OK row with the tool-count note; a resolution
// failure is a verdict-flipping FAIL row carrying the Resolve error as hint.
func TestMCPCheckBranches(t *testing.T) {
	ok := mcpCheck(27, nil)
	if !ok.OK || ok.Note != "27 tools; all policy rows resolve" || ok.Hint != "" {
		t.Errorf("passing mcpCheck = %+v", ok)
	}
	fail := mcpCheck(0, fmt.Errorf("mcp policy row %q: path %q does not resolve", "capture", "mux capture"))
	if fail.OK || fail.Hint == "" || fail.failLabel != "mcp" {
		t.Errorf("failing mcpCheck = %+v", fail)
	}
}

// TestMCPDoctorRowPresent proves the shipped table resolves in-process and the
// row appears in runDoctorChecks (and therefore in doctor --json) as OK.
func TestMCPDoctorRowPresent(t *testing.T) {
	found := false
	for _, c := range runDoctorChecks().Checks {
		if c.Name == "mcp" {
			found = true
			if !c.OK {
				t.Errorf("mcp row must be OK against the shipped tree, got %+v", c)
			}
			if !strings.Contains(c.Note, "tools; all policy rows resolve") {
				t.Errorf("mcp note = %q", c.Note)
			}
		}
	}
	if !found {
		t.Error("runDoctorChecks must append the mcp row")
	}
}

// TestMCPRouteCheckBranches drives the pure route-row classifier over every
// probe outcome: the row is always OK (a state row, never a verdict flipper)
// and the note matches the probe's classification.
func TestMCPRouteCheckBranches(t *testing.T) {
	origin := "http://127.0.0.1:3000"
	cases := []struct {
		name     string
		status   int
		err      error
		tools    int
		wantNote string
	}{
		{"dial error", 0, fmt.Errorf("dial tcp: connection refused"), 10,
			"not reachable at http://127.0.0.1:3000/mcp — is the daemon running? (rk daemon start)"},
		{"404 predates the route", 404, nil, 10,
			"daemon at http://127.0.0.1:3000 answers 404 for /mcp — it predates the route; restart it (rk daemon restart)"},
		{"503 transport unconfigured", 503, nil, 10,
			"route present but the transport is not configured — the daemon logged why at start (see the mcp row above)"},
		{"400 mounted with tools", 400, nil, 10,
			"mounted at http://127.0.0.1:3000/mcp (10 tools)"},
		{"400 mounted, drift guard failed (no count)", 400, nil, 0,
			"mounted at http://127.0.0.1:3000/mcp"},
		{"405 mounted", 405, nil, 3,
			"mounted at http://127.0.0.1:3000/mcp (3 tools)"},
		{"200 mounted", 200, nil, 10,
			"mounted at http://127.0.0.1:3000/mcp (10 tools)"},
		{"unexpected 500", 500, nil, 10,
			"unexpected 500 from http://127.0.0.1:3000/mcp"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			gotURL := ""
			check := mcpRouteCheck(origin, c.tools, func(url string) (int, string, error) {
				gotURL = url
				return c.status, "", c.err
			})
			if !check.OK {
				t.Errorf("OK = false, want true — the mcp route row is never a verdict flipper")
			}
			if check.Name != "mcp route" {
				t.Errorf("Name = %q, want %q", check.Name, "mcp route")
			}
			if check.Note != c.wantNote {
				t.Errorf("Note = %q, want exactly %q", check.Note, c.wantNote)
			}
			if want := origin + "/mcp"; gotURL != want {
				t.Errorf("probe URL = %q, want %q", gotURL, want)
			}
		})
	}
}

// TestMCPRouteDoctorRowPresent: under a stubbed probe the row appears in
// runDoctorChecks (and therefore in doctor --json) immediately after the mcp
// row, always OK, and the report verdict is unaffected by a dial error.
func TestMCPRouteDoctorRowPresent(t *testing.T) {
	orig := doctorHTTPGet
	doctorHTTPGet = func(string) (int, string, error) {
		return 0, "", fmt.Errorf("dial tcp: connection refused")
	}
	t.Cleanup(func() { doctorHTTPGet = orig })

	report := runDoctorChecks()
	mcpIdx, routeIdx := -1, -1
	for i, c := range report.Checks {
		switch c.Name {
		case "mcp":
			mcpIdx = i
		case "mcp route":
			routeIdx = i
			if !c.OK {
				t.Errorf("mcp route row must be OK under a dial error, got %+v", c)
			}
			if !strings.Contains(c.Note, "not reachable at ") {
				t.Errorf("mcp route note = %q", c.Note)
			}
		}
	}
	if routeIdx < 0 {
		t.Fatal("runDoctorChecks must append the mcp route row")
	}
	if mcpIdx < 0 || routeIdx != mcpIdx+1 {
		t.Errorf("mcp route row must immediately follow the mcp row (mcp at %d, route at %d)", mcpIdx, routeIdx)
	}
}

// stubLocaleSeams substitutes the locale row's two seams for a test: the
// forced-locale record and the rk-daemon global-env probe (env nil + err nil
// models "server not running").
func stubLocaleSeams(t *testing.T, forcedName, forcedValue string, forcedOK bool, env map[string]string, err error) {
	t.Helper()
	origForced, origProbe := localeForced, daemonGlobalEnv
	localeForced = func() (string, string, bool) { return forcedName, forcedValue, forcedOK }
	daemonGlobalEnv = func(context.Context) (map[string]string, error) { return env, err }
	t.Cleanup(func() { localeForced, daemonGlobalEnv = origForced, origProbe })
}

// TestLocaleCheckNoteShapes pins the four row shapes: a forced process
// locale names the repaired variable beside a healthy daemon env; a healthy
// process beside a locale-less daemon env carries the pane consequence and
// the --full remediation; a gone server omits the daemon fragment; any other
// probe error degrades to a skip note. Every shape is OK.
func TestLocaleCheckNoteShapes(t *testing.T) {
	lookup := func(env map[string]string) func(string) (string, bool) {
		return func(k string) (string, bool) {
			v, ok := env[k]
			return v, ok
		}
	}
	probe := func(env map[string]string, err error) func(context.Context) (map[string]string, error) {
		return func(context.Context) (map[string]string, error) { return env, err }
	}
	forced := func(name, value string, ok bool) func() (string, string, bool) {
		return func() (string, string, bool) { return name, value, ok }
	}

	t.Run("forced process locale beside a UTF-8 daemon env", func(t *testing.T) {
		c := localeCheck(forced("LC_CTYPE", "C.UTF-8", true), lookup(map[string]string{"LC_CTYPE": "C.UTF-8"}),
			probe(map[string]string{"LANG": "en_IN.UTF-8", "PATH": "/usr/bin"}, nil))
		want := "process: no UTF-8 locale in environment; forced LC_CTYPE=C.UTF-8; rk-daemon server: LANG=en_IN.UTF-8"
		if !c.OK || c.Note != want {
			t.Errorf("got %+v, want OK with note %q", c, want)
		}
	})

	t.Run("UTF-8 process beside a locale-less daemon env", func(t *testing.T) {
		c := localeCheck(forced("", "", false), lookup(map[string]string{"LANG": "en_IN.UTF-8"}),
			probe(map[string]string{"PATH": "/usr/bin"}, nil))
		if !c.OK {
			t.Errorf("locale-less daemon env must stay OK, got %+v", c)
		}
		if !strings.HasPrefix(c.Note, "process: LANG=en_IN.UTF-8; ") {
			t.Errorf("note = %q, want the process fragment first", c.Note)
		}
		if !strings.Contains(c.Note, "rk-daemon server env: no UTF-8 locale") || !strings.Contains(c.Note, "rk daemon restart --full") {
			t.Errorf("note = %q, want the pane consequence and the --full remediation", c.Note)
		}
	})

	t.Run("LC_ALL=C in the daemon env defeats its UTF-8 LANG", func(t *testing.T) {
		c := localeCheck(forced("", "", false), lookup(map[string]string{"LANG": "en_IN.UTF-8"}),
			probe(map[string]string{"LC_ALL": "C", "LANG": "en_IN.UTF-8"}, nil))
		if !c.OK || !strings.Contains(c.Note, "rk-daemon server env: no UTF-8 locale") {
			t.Errorf("got %+v, want the locale-less daemon note", c)
		}
	})

	t.Run("unrepaired locale-less process reports plainly", func(t *testing.T) {
		// Reachable only when EnsureUTF8Locale's Setenv failed: nothing was
		// forced, yet the environment still has no UTF-8 locale.
		c := localeCheck(forced("", "", false), lookup(map[string]string{"LANG": "C"}), probe(nil, nil))
		if !c.OK || c.Note != "process: no UTF-8 locale in environment" {
			t.Errorf("got %+v, want OK with the plain no-locale note", c)
		}
	})

	t.Run("server not running omits the daemon fragment", func(t *testing.T) {
		c := localeCheck(forced("", "", false), lookup(map[string]string{"LANG": "en_IN.UTF-8"}), probe(nil, nil))
		if !c.OK || c.Note != "process: LANG=en_IN.UTF-8" {
			t.Errorf("got %+v, want OK with only the process fragment", c)
		}
	})

	t.Run("probe error degrades to a skip note", func(t *testing.T) {
		c := localeCheck(forced("", "", false), lookup(map[string]string{"LANG": "en_IN.UTF-8"}),
			probe(nil, fmt.Errorf("socket dir unreadable")))
		if !c.OK {
			t.Errorf("probe error must never fail the row, got %+v", c)
		}
		if !strings.Contains(c.Note, "probe skipped") || !strings.Contains(c.Note, "socket dir unreadable") {
			t.Errorf("note = %q, want a skip note naming the failure", c.Note)
		}
	})
}

// TestLocaleCheckNeverFlipsVerdict proves the appended row cannot change the
// overall report verdict even in its worst shape (locale-less daemon env),
// and that runDoctorChecks appends it unconditionally.
func TestLocaleCheckNeverFlipsVerdict(t *testing.T) {
	stubLocaleSeams(t, "LC_CTYPE", "C.UTF-8", true, map[string]string{"PATH": "/usr/bin"}, nil)
	found := false
	for _, c := range runDoctorChecks().Checks {
		if c.Name == "locale" {
			found = true
			if !c.OK {
				t.Errorf("locale row must always be OK-shaped, got %+v", c)
			}
		}
	}
	if !found {
		t.Error("runDoctorChecks must append the locale row unconditionally")
	}
}

// --- riff presets (stale project riff: block) row ----------------------------

// TestRiffPresetsBlockCheck pins the WARN-shaped advisory: no row when the
// repo's fab config carries no top-level riff: key; an OK row with the
// migration note when it does.
func TestRiffPresetsBlockCheck(t *testing.T) {
	t.Run("key absent yields no row", func(t *testing.T) {
		if _, present := riffPresetsBlockCheck("/repo", func(string, string) bool { return false }); present {
			t.Error("no riff: key: a check row was returned, want none")
		}
	})

	t.Run("key present yields an OK row with the note", func(t *testing.T) {
		c, present := riffPresetsBlockCheck("/repo", func(_ string, key string) bool { return key == "riff" })
		if !present {
			t.Fatal("riff: key present: no check returned, want a row")
		}
		if !c.OK {
			t.Error("check OK = false, want true (WARN-shaped — never a failure)")
		}
		if c.Name != "riff presets" {
			t.Errorf("name = %q, want %q", c.Name, "riff presets")
		}
		want := "fab/project/config.yaml has a riff: block that rk no longer reads — define presets under riff_presets in ~/.config/hexokit/config.yaml"
		if c.Note != want {
			t.Errorf("note = %q, want %q", c.Note, want)
		}
	})
}

// gitRepoWithFabConfig stages a temp git repo (a .git marker dir); when body is
// non-empty it also writes fab/project/config.yaml. Returns the repo root.
func gitRepoWithFabConfig(t *testing.T, body string) string {
	t.Helper()
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatalf("mkdir .git: %v", err)
	}
	if body != "" {
		dir := filepath.Join(root, "fab", "project")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir fab/project: %v", err)
		}
		if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(body), 0o644); err != nil {
			t.Fatalf("write config.yaml: %v", err)
		}
	}
	return root
}

func doctorHasRiffPresetsRow(report doctorReport) (doctorCheck, bool) {
	for _, c := range report.Checks {
		if c.Name == "riff presets" {
			return c, true
		}
	}
	return doctorCheck{}, false
}

// TestRiffPresetsBlockRowGating covers the row's presence gates end-to-end
// through runDoctorChecks: no row outside a git repo, in a non-fab repo, or in
// a fab project without a top-level riff: key; the row appears when the key is
// present.
func TestRiffPresetsBlockRowGating(t *testing.T) {
	t.Run("not a git repo → no row", func(t *testing.T) {
		restore := chdir(t, t.TempDir())
		defer restore()
		if _, found := doctorHasRiffPresetsRow(runDoctorChecks()); found {
			t.Error("non-git cwd: riff presets row present, want absent")
		}
	})

	t.Run("git repo without fab config → no row", func(t *testing.T) {
		restore := chdir(t, gitRepoWithFabConfig(t, ""))
		defer restore()
		if _, found := doctorHasRiffPresetsRow(runDoctorChecks()); found {
			t.Error("non-fab repo: riff presets row present, want absent")
		}
	})

	t.Run("fab config without riff key → no row", func(t *testing.T) {
		restore := chdir(t, gitRepoWithFabConfig(t, "project:\n    name: x\n"))
		defer restore()
		if _, found := doctorHasRiffPresetsRow(runDoctorChecks()); found {
			t.Error("fab config without riff:: riff presets row present, want absent")
		}
	})

	t.Run("fab config with riff key → OK row", func(t *testing.T) {
		restore := chdir(t, gitRepoWithFabConfig(t, "riff:\n  presets: {}\n"))
		defer restore()
		c, found := doctorHasRiffPresetsRow(runDoctorChecks())
		if !found {
			t.Fatal("riff: key present: row absent, want present")
		}
		if !c.OK || !strings.Contains(c.Note, "riff: block that rk no longer reads") {
			t.Errorf("row = %+v, want OK with the advisory note", c)
		}
	})
}

// TestPortsDoctorCheck table-tests the pure ports row builder: every shape
// stays OK (advisory only), with the default listing note and the collision
// note leading with the warning.
func TestPortsDoctorCheck(t *testing.T) {
	cases := []struct {
		name     string
		version  string
		cfg      config.Config
		wantNote string
	}{
		{
			name:     "default port",
			cfg:      config.Config{Port: portpolicy.DaemonDefault},
			wantNote: fmt.Sprintf("daemon :%d (default); reserved: rig 21000–21299, tunnel 3100–3199, sentinel 21999", portpolicy.DaemonDefault),
		},
		{
			name: "tunnel collision",
			cfg:  config.Config{Port: 3150},
			wantNote: "WARNING: port inside reserved block(s) tunnel 3100–3199: daemon :3150, code-server :3152 — set RK_PORT outside; " +
				"daemon :3150; code-server :3152; reserved: rig 21000–21299, tunnel 3100–3199, sentinel 21999",
		},
		{
			name:    "rig collision via code-server straddle, released build",
			version: "1.2.3",
			cfg:     config.Config{Port: 21297},
			wantNote: "WARNING: port inside reserved block(s) rig 21000–21299: daemon :21297, code-server :21299 — set RK_PORT outside; " +
				"daemon :21297; code-server :21299; reserved: rig 21000–21299, tunnel 3100–3199, sentinel 21999",
		},
		{
			name: "code-server-only collision via explicit override",
			cfg:  config.Config{Port: portpolicy.DaemonDefault, CodeServerPort: 3100},
			wantNote: fmt.Sprintf("WARNING: port inside reserved block(s) tunnel 3100–3199: code-server :3100 — set RK_CODE_SERVER_PORT outside; "+
				"daemon :%d (default); code-server :3100; reserved: rig 21000–21299, tunnel 3100–3199, sentinel 21999", portpolicy.DaemonDefault),
		},
		{
			name:     "rig port, dev build — rig block exempt",
			cfg:      config.Config{Port: 21297},
			wantNote: "daemon :21297; reserved: rig 21000–21299, tunnel 3100–3199, sentinel 21999",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.version != "" {
				orig := version
				version = tc.version
				t.Cleanup(func() { version = orig })
			}
			check := portsDoctorCheck(tc.cfg)
			if check.Name != "ports" {
				t.Errorf("name = %q, want ports", check.Name)
			}
			if !check.OK {
				t.Errorf("OK = false; the ports row must never fail (note %q)", check.Note)
			}
			if check.Note != tc.wantNote {
				t.Errorf("note = %q, want %q", check.Note, tc.wantNote)
			}
			// Worst-check-wins: appending the row can never flip the verdict.
			report := doctorReport{OK: true}
			report.Checks = append(report.Checks, check)
			if !report.OK {
				t.Error("ports row flipped report.OK")
			}
		})
	}
}

// TestPortsRowNeverFlipsVerdict proves the advisory ports row cannot change
// the overall report verdict (the riff-presets never-flips pattern): the same
// machine with and without a colliding RK_PORT yields the same report.OK.
func TestPortsRowNeverFlipsVerdict(t *testing.T) {
	t.Setenv("RK_PORT", "")
	without := runDoctorChecks().OK

	t.Setenv("RK_PORT", "3150")
	with := runDoctorChecks()
	if with.OK != without {
		t.Errorf("report.OK flipped with a colliding RK_PORT: %v → %v", without, with.OK)
	}
	for _, c := range with.Checks {
		if c.Name != "ports" {
			continue
		}
		if !c.OK {
			t.Errorf("ports row not OK on collision: %+v", c)
		}
		if !strings.HasPrefix(c.Note, "WARNING:") || !strings.Contains(c.Note, "tunnel") {
			t.Errorf("collision note must lead with the warning naming the block, got %q", c.Note)
		}
		return
	}
	t.Error("ports row absent from the report")
}

// TestRiffPresetsBlockRowNeverFlipsVerdict proves the advisory row cannot change
// the overall report verdict: the same repo with and without the riff: key
// yields the same report.OK.
func TestRiffPresetsBlockRowNeverFlipsVerdict(t *testing.T) {
	repo := gitRepoWithFabConfig(t, "project:\n    name: x\n")
	restore := chdir(t, repo)
	defer restore()
	without := runDoctorChecks().OK

	if err := os.WriteFile(filepath.Join(repo, "fab", "project", "config.yaml"), []byte("riff:\n  presets: {}\n"), 0o644); err != nil {
		t.Fatalf("write config.yaml: %v", err)
	}
	with := runDoctorChecks()
	if with.OK != without {
		t.Errorf("report.OK flipped with the advisory row present: %v → %v", without, with.OK)
	}
	if _, found := doctorHasRiffPresetsRow(with); !found {
		t.Error("riff presets row should be present after adding the riff: key")
	}
}

// TestPortPinCheck pins the advisory `port pin` row's gate and shape: it fires
// only when config.yaml's port equals the legacy default, the current default
// has moved off it, and RK_PORT is not overriding — and it is always OK-shaped
// with a Note, never a verdict flipper.
func TestPortPinCheck(t *testing.T) {
	cases := []struct {
		name        string
		pinned      int
		def         int
		legacy      int
		envOverride bool
		wantRow     bool
	}{
		{"dormant while default equals legacy (today)", 3000, 3000, 3000, false, false},
		{"fires when pinned at legacy and default moved", 3000, 6123, 3000, false, true},
		{"RK_PORT override suppresses", 3000, 6123, 3000, true, false},
		{"unpinned port suppresses", 4100, 6123, 3000, false, false},
		{"no port in config.yaml suppresses", 0, 6123, 3000, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, present := portPinCheck(tc.pinned, tc.def, tc.legacy, tc.envOverride)
			if present != tc.wantRow {
				t.Fatalf("portPinCheck(%d, %d, %d, %v) present = %v, want %v", tc.pinned, tc.def, tc.legacy, tc.envOverride, present, tc.wantRow)
			}
			if !present {
				return
			}
			if c.Name != "port pin" {
				t.Errorf("name = %q, want %q", c.Name, "port pin")
			}
			if !c.OK {
				t.Error("the pin row must stay OK-shaped (advisory)")
			}
			pinnedFrag := fmt.Sprintf("pinned at :%d", tc.pinned)
			defFrag := fmt.Sprintf(":%d", tc.def)
			if !strings.Contains(c.Note, pinnedFrag) || !strings.Contains(c.Note, defFrag) {
				t.Errorf("note %q must name the pinned port and the new default", c.Note)
			}
			if !strings.Contains(c.Note, "rk daemon restart") {
				t.Errorf("note %q must carry the move recipe", c.Note)
			}
		})
	}
}

// TestPortPinRowRealPolicyValues runs the full report builder against the
// embedded policy values (not injected constants): a config pinned at
// DaemonLegacy shows the advisory `port pin` row naming the real default, a
// config at the default or under an RK_PORT override shows none, and the
// verdict never flips.
func TestPortPinRowRealPolicyValues(t *testing.T) {
	if portpolicy.DaemonDefault == portpolicy.DaemonLegacy {
		t.Skip("DaemonDefault == DaemonLegacy: the pin row is dormant by design")
	}

	hasPinRow := func(report doctorReport) (doctorCheck, bool) {
		for _, c := range report.Checks {
			if c.Name == "port pin" {
				return c, true
			}
		}
		return doctorCheck{}, false
	}
	writePinnedConfig := func(t *testing.T, port int) {
		t.Helper()
		cfgDir := t.TempDir()
		content := fmt.Sprintf("port: %d\n", port)
		if err := os.WriteFile(filepath.Join(cfgDir, "config.yaml"), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Setenv(settings.ConfigDirEnv, cfgDir)
	}

	t.Run("pinned at the legacy port: row present, verdict unaffected", func(t *testing.T) {
		writePinnedConfig(t, portpolicy.DaemonLegacy)
		t.Setenv("RK_PORT", "")
		report := runDoctorChecks()
		row, found := hasPinRow(report)
		if !found {
			t.Fatal("port pin row absent for a config pinned at the legacy port")
		}
		if !row.OK {
			t.Errorf("row = %+v, want OK-shaped (advisory)", row)
		}
		defFrag := fmt.Sprintf(":%d", portpolicy.DaemonDefault)
		if !strings.Contains(row.Note, defFrag) || !strings.Contains(row.Note, "rk daemon restart") {
			t.Errorf("note %q must name :%d and the move recipe", row.Note, portpolicy.DaemonDefault)
		}
		if !report.OK {
			t.Error("the advisory pin row must never flip the report verdict")
		}
	})

	t.Run("already on the default: no row", func(t *testing.T) {
		writePinnedConfig(t, portpolicy.DaemonDefault)
		t.Setenv("RK_PORT", "")
		if row, found := hasPinRow(runDoctorChecks()); found {
			t.Errorf("port pin row present for an install on the default: %+v", row)
		}
	})

	t.Run("RK_PORT override: no row", func(t *testing.T) {
		writePinnedConfig(t, portpolicy.DaemonLegacy)
		t.Setenv("RK_PORT", strconv.Itoa(portpolicy.DaemonLegacy))
		if row, found := hasPinRow(runDoctorChecks()); found {
			t.Errorf("port pin row present under an RK_PORT override: %+v", row)
		}
	})
}

// TestRKPortOverride pins the valid-port rule behind the pin row's env gate:
// only a parseable in-range RK_PORT counts as an override.
func TestRKPortOverride(t *testing.T) {
	cases := []struct {
		value string
		want  bool
	}{
		{"", false},
		{"6123", true},
		{"abc", false},
		{"0", false},
		{"65536", false},
	}
	for _, tc := range cases {
		t.Run("RK_PORT="+tc.value, func(t *testing.T) {
			t.Setenv("RK_PORT", tc.value)
			if got := rkPortOverride(); got != tc.want {
				t.Errorf("rkPortOverride() = %v, want %v", got, tc.want)
			}
		})
	}
}
