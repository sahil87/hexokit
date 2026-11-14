package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

const trackTestSocket = "/tmp/tmux-1000/opsrv"

// resetOperatorFlags restores every flag under the track, adopt and brief commands —
// cobra and pflag keep flag values and Changed bits across Execute calls.
func resetOperatorFlags() {
	var reset func(c *cobra.Command)
	reset = func(c *cobra.Command) {
		for _, fs := range []*pflag.FlagSet{c.Flags(), c.PersistentFlags()} {
			fs.VisitAll(func(f *pflag.Flag) {
				if sv, ok := f.Value.(pflag.SliceValue); ok {
					_ = sv.Replace(nil)
				} else {
					_ = f.Value.Set(f.DefValue)
				}
				f.Changed = false
			})
		}
		for _, sub := range c.Commands() {
			reset(sub)
		}
	}
	reset(operatorTrackCmd)
	reset(operatorAdoptCmd)
	reset(operatorCheckCmd)
	reset(operatorBriefCmd)
	reset(operatorRunExecCmd)
	reset(operatorAutopilotCmd)
	quiet = false
}

// operatorSandbox points the state home at a temp dir and stubs every seam
// that would reach a live tmux server; it returns the state file the verbs
// resolve for trackTestSocket.
func operatorSandbox(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("XDG_STATE_HOME", home)
	prevSock, prevTmux := operatorSocketPathFn, operatorOriginalTMUXFn
	operatorSocketPathFn = func(context.Context, string) string { return trackTestSocket }
	operatorOriginalTMUXFn = func() string { return "" }
	t.Cleanup(func() { operatorSocketPathFn, operatorOriginalTMUXFn = prevSock, prevTmux })
	return filepath.Join(home, "hexokit", "operator", "tmp-tmux--1000-opsrv.yaml")
}

// runOperatorCLI drives `rk operator <args...>` through the real cobra Execute
// seam so flag parsing and exit classification run as in production.
func runOperatorCLI(t *testing.T, stdin string, args ...string) (stdout, stderr string, err error) {
	t.Helper()
	resetRootFlagState(t)
	resetOperatorFlags()
	t.Cleanup(resetOperatorFlags)
	var out, errOut bytes.Buffer
	rootCmd.SetOut(&out)
	rootCmd.SetErr(&errOut)
	rootCmd.SetIn(strings.NewReader(stdin))
	rootCmd.SetArgs(append([]string{"operator"}, args...))
	t.Cleanup(func() {
		rootCmd.SetOut(nil)
		rootCmd.SetErr(nil)
		rootCmd.SetIn(nil)
		rootCmd.SetArgs(nil)
	})
	err = rootCmd.Execute()
	return out.String(), errOut.String(), err
}

func track(t *testing.T, args ...string) (string, error) {
	t.Helper()
	out, _, err := runOperatorCLI(t, "", append([]string{"track"}, args...)...)
	return out, err
}

func mustTrack(t *testing.T, args ...string) string {
	t.Helper()
	out, err := track(t, args...)
	if err != nil {
		t.Fatalf("rk operator track %v: %v", args, err)
	}
	return out
}

func wantExit(t *testing.T, err error, want int, sub string) {
	t.Helper()
	if err == nil {
		t.Fatalf("succeeded, want exit %d (%q)", want, sub)
	}
	if got := exitCode(err); got != want {
		t.Errorf("exit = %d, want %d (err: %v)", got, want, err)
	}
	if !strings.Contains(err.Error(), sub) {
		t.Errorf("error = %q, want it to contain %q", err, sub)
	}
}

type trackedJSON struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Notes []struct {
		At   string `json:"at"`
		By   string `json:"by"`
		Text string `json:"text"`
	} `json:"notes"`
	Scope map[string]interface{} `json:"scope"`
}

func listJSON(t *testing.T, extra ...string) []trackedJSON {
	t.Helper()
	out := mustTrack(t, append([]string{"list", "--json"}, extra...)...)
	var doc struct {
		OK     bool          `json:"ok"`
		Result []trackedJSON `json:"result"`
	}
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("list --json is not one JSON document: %v\n%s", err, out)
	}
	if !doc.OK {
		t.Fatalf("list --json ok = false:\n%s", out)
	}
	return doc.Result
}

func TestOperatorTrackRegisteredUnderOperator(t *testing.T) {
	var found bool
	for _, c := range operatorCmd.Commands() {
		if c.Name() == "track" {
			found = true
		}
	}
	if !found {
		t.Fatal("track is not registered on operatorCmd")
	}
	if operatorCmd.Args == nil || operatorCmd.RunE == nil {
		t.Error("operatorCmd must keep its own Args validator and RunE")
	}

	verbs := map[string]bool{}
	for _, c := range operatorTrackCmd.Commands() {
		verbs[c.Name()] = true
	}
	for _, want := range []string{"add", "update", "observe", "rm", "list", "note", "pause", "resume"} {
		if !verbs[want] {
			t.Errorf("verb %q missing", want)
		}
	}
	if len(verbs) != 8 || verbs["clock"] {
		t.Errorf("verbs = %v, want exactly the eight (no clock)", verbs)
	}
	for _, name := range []string{"text", "pause", "resume"} {
		if operatorTrackUpdateCmd.Flags().Lookup(name) != nil {
			t.Errorf("track update has a --%s flag", name)
		}
	}
	for _, c := range append(operatorTrackCmd.Commands(), operatorAdoptCmd) {
		if f := c.Flags().Lookup("server"); f == nil && c.InheritedFlags().Lookup("server") == nil {
			t.Errorf("%s has no -L/--server", c.Name())
		}
	}
}

func TestOperatorTrackHelpNamesTheSurface(t *testing.T) {
	out, _, err := runOperatorCLI(t, "", "track", "add", "--help")
	if err != nil {
		t.Fatalf("--help: %v", err)
	}
	for _, want := range []string{"<id>", "--kind", "--argv", "--done-when", "--mode", "--text", "--server", "Examples:", "Exit codes:"} {
		if !strings.Contains(out, want) {
			t.Errorf("track add --help lacks %q:\n%s", want, out)
		}
	}
}

func TestOperatorTrackNoteAddAndListJSON(t *testing.T) {
	state := operatorSandbox(t)

	out := mustTrack(t, "add", "n1", "--kind", "note", "--text", "remember X")
	if out != "added n1\n" {
		t.Errorf("add output = %q", out)
	}
	if _, err := os.Stat(state); err != nil {
		t.Fatalf("state file not at the resolved path: %v", err)
	}
	mustTrack(t, "note", "n1", "from the chat", "--by", "chat")

	items := listJSON(t)
	if len(items) != 1 || items[0].ID != "n1" || len(items[0].Notes) != 2 {
		t.Fatalf("items = %+v", items)
	}
	if n := items[0].Notes[0]; n.By != "user" || n.Text != "remember X" || n.At == "" {
		t.Errorf("first note = %+v", n)
	}
	if n := items[0].Notes[1]; n.By != "chat" || n.Text != "from the chat" {
		t.Errorf("second note = %+v", n)
	}

	plain := mustTrack(t, "list")
	if !strings.HasPrefix(plain, "n1 · note · watching · ") {
		t.Errorf("list = %q", plain)
	}
	if kindOnly := mustTrack(t, "list", "--kind", "pane"); kindOnly != "" {
		t.Errorf("list --kind pane = %q, want nothing", kindOnly)
	}
}

func TestOperatorTrackNoteReadsStdin(t *testing.T) {
	operatorSandbox(t)
	mustTrack(t, "add", "n1", "--kind", "note", "--text", "seed")
	_, _, err := runOperatorCLI(t, "multi\nline from stdin\n", "track", "note", "n1", "-", "--by", "run")
	if err != nil {
		t.Fatal(err)
	}
	notes := listJSON(t)[0].Notes
	if len(notes) != 2 || notes[1].Text != "multi\nline from stdin" || notes[1].By != "run" {
		t.Errorf("notes = %+v", notes)
	}
}

func TestOperatorTrackAddShellObservePauseResumeRm(t *testing.T) {
	operatorSandbox(t)
	mustTrack(t, "add", "s1", "--kind", "shell", "--argv", "myprobe", "--argv", "--flag", "--fields", "status",
		"--done-when", `status == "green"`, "--check-every", "2m")
	mustTrack(t, "observe", "s1", "--json", `{"status":"red","noise":1}`)
	mustTrack(t, "update", "s1", "--check-every", "10m", "--then", "ship it", "--scope", `{"env":"prod"}`)
	mustTrack(t, "pause", "s1")

	it := listJSON(t)[0]
	if it.Scope["env"] != "prod" {
		t.Errorf("scope = %v", it.Scope)
	}
	if out := mustTrack(t, "list"); !strings.HasPrefix(out, "s1 · shell · paused · ") || !strings.HasSuffix(out, " · ship it\n") {
		t.Errorf("list = %q", out)
	}
	if out := mustTrack(t, "resume", "s1"); out != "resumed s1\n" {
		t.Errorf("resume output = %q", out)
	}
	mustTrack(t, "observe", "s1", "--error", "boom")
	if out := mustTrack(t, "rm", "s1"); out != "removed s1\n" {
		t.Errorf("rm output = %q", out)
	}
	if got := listJSON(t); len(got) != 0 {
		t.Errorf("items after rm = %+v", got)
	}
}

func TestOperatorTrackPaneAddPrintsModeLine(t *testing.T) {
	// --pane is left unset: the pane_pid lookup would query a live tmux server.
	operatorSandbox(t)
	out := mustTrack(t, "add", "p1", "--kind", "pane", "--change", "260101-ab12-x", "--repo", "/r", "--branch", "b", "--mode", "merge-auto")
	if out != "mode: merge-auto (flag)\nadded p1\n" {
		t.Errorf("output = %q", out)
	}
	it := listJSON(t)[0]
	if it.Scope["merge_mode"] != "merge-auto" || it.Scope["change"] != "260101-ab12-x" {
		t.Errorf("scope = %v", it.Scope)
	}
}

func TestOperatorTrackJSONReceiptsAndErrorEnvelope(t *testing.T) {
	operatorSandbox(t)
	out := mustTrack(t, "add", "t1", "--kind", "task", "--json")
	var ok struct {
		OK     bool                 `json:"ok"`
		Result operatorTrackReceipt `json:"result"`
	}
	if err := json.Unmarshal([]byte(out), &ok); err != nil || !ok.OK || ok.Result.ID != "t1" || ok.Result.Action != "added" {
		t.Fatalf("receipt = %s (%v)", out, err)
	}

	out, err := track(t, "add", "t1", "--kind", "task", "--json")
	wantExit(t, err, 1, "already exists")
	var fail struct {
		OK    bool `json:"ok"`
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if jerr := json.Unmarshal([]byte(out), &fail); jerr != nil || fail.OK || fail.Error.Code != "operational" {
		t.Fatalf("operational envelope = %s (%v)", out, jerr)
	}

	out, err = track(t, "add", "t2", "--kind", "email", "--json")
	wantExit(t, err, 2, "unknown --kind")
	if jerr := json.Unmarshal([]byte(out), &fail); jerr != nil || fail.Error.Code != "usage" {
		t.Fatalf("usage envelope = %s (%v)", out, jerr)
	}
}

func TestOperatorTrackExitCodes(t *testing.T) {
	cases := []struct {
		name string
		args []string
		exit int
		want string
	}{
		{"missing kind", []string{"add", "x"}, 2, "--kind is required"},
		{"unknown kind", []string{"add", "x", "--kind", "email"}, 2, "unknown --kind"},
		{"retired kind", []string{"add", "x", "--kind", "fab-change"}, 2, "unknown --kind"},
		{"bad scope json", []string{"add", "x", "--kind", "task", "--scope", "{nope"}, 2, "invalid --scope JSON"},
		{"scope not an object", []string{"add", "x", "--kind", "task", "--scope", "null"}, 2, "--scope"},
		{"by on non-note", []string{"add", "x", "--kind", "task", "--by", "chat"}, 2, "--by applies only to kind note"},
		{"note without text", []string{"add", "x", "--kind", "note"}, 2, "requires --text"},
		{"text on non-note", []string{"add", "x", "--kind", "task", "--text", "hi"}, 2, "--text applies only to kind note"},
		{"invalid mode", []string{"add", "x", "--kind", "pane", "--mode", "yolo"}, 2, "unknown --mode"},
		{"unknown flag", []string{"add", "x", "--kind", "task", "--bogus"}, 2, "unknown flag"},
		{"clock is gone", []string{"clock"}, 2, "unknown command"},
		{"update text is gone", []string{"update", "x", "--text", "hi"}, 2, "unknown flag"},
		{"update pause is gone", []string{"update", "x", "--pause"}, 2, "unknown flag"},
		{"update with nothing to do", []string{"update", "x"}, 2, "nothing to update"},
		{"update unknown id", []string{"update", "zz", "--then", "x"}, 1, "no tracked item zz"},
		{"observe neither flag", []string{"observe", "x"}, 2, "exactly one of --json or --error"},
		{"observe both flags", []string{"observe", "x", "--json", "{}", "--error", "e"}, 2, "exactly one of --json or --error"},
		{"observe bad json", []string{"observe", "x", "--json", "{nope"}, 2, "invalid --json"},
		{"observe non-object", []string{"observe", "x", "--json", "[1]"}, 2, "must be a JSON object"},
		{"observe unknown id", []string{"observe", "zz", "--error", "e"}, 1, "no tracked item zz"},
		{"rm unknown id", []string{"rm", "zz"}, 1, "no tracked item zz"},
		{"rm arg count", []string{"rm"}, 2, "accepts 1 arg"},
		{"pause unknown id", []string{"pause", "zz"}, 1, "no tracked item zz"},
		{"resume unknown id", []string{"resume", "zz"}, 1, "no tracked item zz"},
		{"note unknown author", []string{"note", "x", "hi", "--by", "robot"}, 2, "invalid --by"},
		{"note empty text", []string{"note", "x", "  "}, 2, "must not be empty"},
		{"note arg count", []string{"note", "x"}, 2, "accepts 2 arg"},
		{"note unknown id", []string{"note", "zz", "hi"}, 1, "no tracked item zz"},
		{"list unknown kind", []string{"list", "--kind", "email"}, 2, "unknown --kind"},
		{"list stray arg", []string{"list", "stray"}, 2, "unknown command"},
		{"bad server name", []string{"list", "-L", "bad name"}, 2, "Server name"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			operatorSandbox(t)
			_, err := track(t, tc.args...)
			wantExit(t, err, tc.exit, tc.want)
		})
	}
}

func TestOperatorTrackOverLengthNoteIsUsageError(t *testing.T) {
	operatorSandbox(t)
	mustTrack(t, "add", "n1", "--kind", "note", "--text", "seed")
	_, err := track(t, "note", "n1", strings.Repeat("x", 1001))
	wantExit(t, err, 2, "1000-character cap")
	if got := listJSON(t)[0].Notes; len(got) != 1 {
		t.Errorf("notes = %+v, want the over-length note rejected", got)
	}
}

func TestOperatorTrackDuplicateAndUnparsableStateAreOperational(t *testing.T) {
	state := operatorSandbox(t)
	mustTrack(t, "add", "t1", "--kind", "task")
	_, err := track(t, "add", "t1", "--kind", "task")
	wantExit(t, err, 1, "already exists")

	if werr := os.WriteFile(state, []byte("tracked: [unclosed\n"), 0o600); werr != nil {
		t.Fatal(werr)
	}
	_, err = track(t, "list")
	wantExit(t, err, 1, state)
	_, err = track(t, "pause", "t1")
	wantExit(t, err, 1, state)
}

func TestOperatorTrackListOnAbsentStateIsPureRead(t *testing.T) {
	state := operatorSandbox(t)
	out := mustTrack(t, "list")
	if out != "" {
		t.Errorf("list = %q, want nothing", out)
	}
	if _, err := os.Stat(filepath.Dir(state)); !os.IsNotExist(err) {
		t.Error("list created the state directory")
	}
}

func TestOperatorTrackServerResolution(t *testing.T) {
	home := t.TempDir()
	t.Setenv("XDG_STATE_HOME", home)
	var asked []string
	prevSock, prevTmux := operatorSocketPathFn, operatorOriginalTMUXFn
	operatorSocketPathFn = func(_ context.Context, server string) string {
		asked = append(asked, server)
		return "/tmp/tmux-1000/" + server
	}
	operatorOriginalTMUXFn = func() string { return "/tmp/tmux-1000/fromenv,123,0" }
	t.Cleanup(func() { operatorSocketPathFn, operatorOriginalTMUXFn = prevSock, prevTmux })

	mustTrack(t, "add", "a", "--kind", "task")
	mustTrack(t, "add", "b", "--kind", "task", "-L", "other")
	if strings.Join(asked, ",") != "fromenv,other" {
		t.Errorf("servers asked = %v, want the $TMUX server then the explicit one", asked)
	}
	for _, slug := range []string{"tmp-tmux--1000-fromenv", "tmp-tmux--1000-other"} {
		if _, err := os.Stat(filepath.Join(home, "hexokit", "operator", slug+".yaml")); err != nil {
			t.Errorf("missing state file for %s: %v", slug, err)
		}
	}
}

func TestOperatorTrackUnknownSocket(t *testing.T) {
	home := t.TempDir()
	t.Setenv("XDG_STATE_HOME", home)
	prevSock, prevTmux := operatorSocketPathFn, operatorOriginalTMUXFn
	operatorSocketPathFn = func(context.Context, string) string { return "" }
	operatorOriginalTMUXFn = func() string { return "" }
	t.Cleanup(func() { operatorSocketPathFn, operatorOriginalTMUXFn = prevSock, prevTmux })

	t.Run("a named server is an operational error", func(t *testing.T) {
		_, err := track(t, "list", "-L", "loom", "--json")
		wantExit(t, err, 1, `"loom"`)
		if _, statErr := os.Stat(filepath.Join(home, "hexokit", "operator")); !os.IsNotExist(statErr) {
			t.Error("a named server with an unknown socket touched the state directory")
		}
	})

	t.Run("the default server keeps the default ledger", func(t *testing.T) {
		mustTrack(t, "add", "a", "--kind", "task")
		if _, err := os.Stat(filepath.Join(home, "hexokit", "operator", "default.yaml")); err != nil {
			t.Errorf("default.yaml missing: %v", err)
		}
	})
}
