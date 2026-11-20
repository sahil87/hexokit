package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/spf13/pflag"

	"rk/internal/cron"
)

// wakeEnv points the state home at a temp dir, pins the marker clock and the
// ambient server, and returns the cron dir.
func wakeEnv(t *testing.T) string {
	t.Helper()
	state := t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	prevNow := wakeNowFn
	wakeNowFn = func() time.Time { return time.Unix(1_700_000_000, 0) }
	t.Cleanup(func() { wakeNowFn = prevNow })
	prevTmux := operatorOriginalTMUXFn
	operatorOriginalTMUXFn = func() string { return "" }
	t.Cleanup(func() { operatorOriginalTMUXFn = prevTmux })
	dir, err := cron.DefaultDir()
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func wake(t *testing.T, args ...string) (string, string, error) {
	t.Helper()
	return runOperatorCLI(t, "", append([]string{"wake"}, args...)...)
}

func TestOperatorWakeRegisteredAndDocumented(t *testing.T) {
	var found bool
	for _, c := range operatorCmd.Commands() {
		found = found || c.Name() == "wake"
	}
	if !found {
		t.Fatal("wake is not registered on operatorCmd")
	}
	for _, name := range []string{"server", "reason", "json"} {
		if operatorWakeCmd.Flags().Lookup(name) == nil {
			t.Errorf("wake lacks --%s", name)
		}
	}
	if sh := operatorWakeCmd.Flags().ShorthandLookup("L"); sh == nil || sh.Name != "server" {
		t.Error("wake lacks the -L shorthand for --server")
	}
	for _, section := range []string{"Flags:", "Examples:", "Exit codes:", "rk operator check"} {
		if !strings.Contains(operatorWakeCmd.Long, section) {
			t.Errorf("long help lacks %q", section)
		}
	}
	operatorWakeCmd.Flags().VisitAll(func(f *pflag.Flag) {
		if strings.Contains(f.Usage, "`") {
			t.Errorf("--%s help contains a backtick (pflag would read it as a metavar)", f.Name)
		}
	})
}

func TestOperatorWakeWritesMarkerWithDefaultReason(t *testing.T) {
	dir := wakeEnv(t)
	out, errOut, err := wake(t, "-L", "work")
	if err != nil {
		t.Fatalf("wake: %v", err)
	}
	if errOut != "" || out != "wake queued for work: manual\n" {
		t.Errorf("out = %q, err = %q", out, errOut)
	}
	path := filepath.Join(dir, "work.wake")
	data, rerr := os.ReadFile(path)
	if rerr != nil || string(data) != "1700000000 manual\n" {
		t.Fatalf("marker = %q, %v", data, rerr)
	}
	if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o600 {
		t.Errorf("marker mode = %v, want 0600", fi.Mode().Perm())
	}
}

func TestOperatorWakeReasonAndAmbientServer(t *testing.T) {
	dir := wakeEnv(t)
	if _, _, err := wake(t, "--reason", "  new note on pr-41  "); err != nil {
		t.Fatal(err)
	}
	m, ok, err := cron.ReadWakeMarker(dir, "default")
	if err != nil || !ok || m.Reason != "new note on pr-41" {
		t.Fatalf("marker = %+v ok=%v err=%v", m, ok, err)
	}
}

func TestOperatorWakeJSONEnvelope(t *testing.T) {
	dir := wakeEnv(t)
	out, _, err := wake(t, "-L", "work", "--reason", "note", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var env struct {
		OK     bool        `json:"ok"`
		Result wakeReceipt `json:"result"`
	}
	if err := json.Unmarshal([]byte(out), &env); err != nil {
		t.Fatalf("not one JSON document: %q (%v)", out, err)
	}
	if !env.OK || env.Result.Server != "work" || env.Result.Reason != "note" {
		t.Errorf("envelope = %+v", env)
	}
	if _, ok, _ := cron.ReadWakeMarker(dir, "work"); !ok {
		t.Error("marker missing after a --json wake")
	}
}

func TestOperatorWakeUsageErrorsWriteNothing(t *testing.T) {
	dir := wakeEnv(t)
	cases := []struct {
		name string
		args []string
	}{
		{"newline in reason", []string{"-L", "work", "--reason", "a\nb"}},
		{"over-long reason", []string{"-L", "work", "--reason", strings.Repeat("x", cron.MaxWakeReasonRunes+1)}},
		{"bad server name", []string{"-L", "bad name!"}},
		{"extra argument", []string{"-L", "work", "stray"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, _, err := wake(t, tc.args...)
			wantExit(t, err, 2, "")
			if entries, _ := os.ReadDir(dir); len(entries) != 0 {
				t.Errorf("a usage error left files behind: %v", entries)
			}
		})
	}
}

func TestOperatorWakeJSONUsageError(t *testing.T) {
	wakeEnv(t)
	out, _, err := wake(t, "-L", "work", "--reason", "a\nb", "--json")
	wantExit(t, err, 2, "")
	var env struct {
		OK    bool `json:"ok"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if jerr := json.Unmarshal([]byte(out), &env); jerr != nil || env.OK || env.Error.Code != "usage" {
		t.Fatalf("envelope = %q (%v)", out, jerr)
	}
}

// TestOperatorWakeWriteFailureIsOperational: a cron dir that cannot be created
// exits 1.
func TestOperatorWakeWriteFailureIsOperational(t *testing.T) {
	dir := wakeEnv(t)
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dir, []byte("not a dir"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err := wake(t, "-L", "work")
	wantExit(t, err, 1, "")
}

func TestOperatorWakeAppearsInHelpDump(t *testing.T) {
	doc := buildDump(rootCmd, displayVersion())
	op, ok := childByName(doc.Root, "operator")
	if !ok {
		t.Fatal("help-dump has no operator command")
	}
	if _, ok := childByName(op, "wake"); !ok {
		t.Error("help-dump does not list operator wake")
	}
}
