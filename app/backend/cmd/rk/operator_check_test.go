package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"rk/internal/mcp"
	"rk/internal/operator"

	"github.com/spf13/pflag"
)

// stubCheck replaces the operator.Check seam and records the server it was
// asked to check; no tmux server or state file is reached.
func stubCheck(t *testing.T, res operator.CheckResult, err error) *[]string {
	t.Helper()
	var servers []string
	prev := operatorCheckFn
	operatorCheckFn = func(_ context.Context, server string, _ operator.CheckOptions) (operator.CheckResult, error) {
		servers = append(servers, server)
		return res, err
	}
	t.Cleanup(func() { operatorCheckFn = prev })
	prevTmux := operatorOriginalTMUXFn
	operatorOriginalTMUXFn = func() string { return "" }
	t.Cleanup(func() { operatorOriginalTMUXFn = prevTmux })
	return &servers
}

func check(t *testing.T, args ...string) (string, string, error) {
	t.Helper()
	return runOperatorCLI(t, "", append([]string{"check"}, args...)...)
}

func strp(s string) *string { return &s }

func richCheckResult() operator.CheckResult {
	return operator.CheckResult{
		CheckedAt: "2026-11-11T12:00:00Z",
		Changed:   true,
		Changes: []operator.CheckDelta{
			{Kind: operator.DeltaChanged, ID: "pr-1120", Fields: map[string]operator.FieldChange{"state": {From: "OPEN", To: "MERGED"}}},
			{Kind: operator.DeltaStageAdvance, ID: "r2-check", Pane: "%12", From: strp("apply"), To: strp("review")},
			{Kind: operator.DeltaDue, ID: "linear-inbox", Age: "12m", Instruction: "check the Linear inbox for new issues"},
		},
		Open: []operator.CheckDelta{
			{Kind: operator.DeltaPaneDeath, ID: "old-pane", Pane: "%7"},
		},
		Notices: []operator.CheckNotice{
			{ID: "ci-probe", Kind: operator.NoticeProbeError, Error: "exit 1: HTTP 502", Failures: 1},
		},
	}
}

func TestOperatorCheckRegisteredAndDocumented(t *testing.T) {
	var found bool
	for _, c := range operatorCmd.Commands() {
		found = found || c.Name() == "check"
	}
	if !found {
		t.Fatal("check is not registered on operatorCmd")
	}
	for _, name := range []string{"server", "json"} {
		if operatorCheckCmd.Flags().Lookup(name) == nil {
			t.Errorf("check lacks --%s", name)
		}
	}
	if sh := operatorCheckCmd.Flags().ShorthandLookup("L"); sh == nil || sh.Name != "server" {
		t.Error("check lacks the -L shorthand for --server")
	}
	for _, section := range []string{"Examples:", "Exit codes:"} {
		if !strings.Contains(operatorCheckCmd.Long, section) {
			t.Errorf("long help lacks a %q section", section)
		}
	}
	operatorCheckCmd.Flags().VisitAll(func(f *pflag.Flag) {
		if strings.Contains(f.Usage, "`") {
			t.Errorf("--%s help contains a backtick (pflag would read it as a metavar)", f.Name)
		}
	})
}

func TestOperatorCheckAppearsInHelpDumpAndNotInTheMCPTable(t *testing.T) {
	doc := buildDump(rootCmd, displayVersion())
	op, ok := childByName(doc.Root, "operator")
	if !ok {
		t.Fatal("help-dump has no operator command")
	}
	if _, ok := childByName(op, "check"); !ok {
		t.Error("help-dump does not list operator check")
	}
	for _, row := range mcp.Table {
		if strings.HasPrefix(row.Path, "operator check") {
			t.Errorf("operator check must not be in the MCP table: %+v", row)
		}
	}
}

func TestOperatorCheckHumanOutput(t *testing.T) {
	servers := stubCheck(t, richCheckResult(), nil)
	out, errOut, err := check(t, "-L", "work")
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if errOut != "" {
		t.Errorf("stderr = %q", errOut)
	}
	want := "changed 3, open 1, notices 1\n" +
		"  new   pr-1120       changed        state: \"OPEN\" → \"MERGED\"\n" +
		"  new   r2-check      stage_advance  %12 apply → review\n" +
		"  new   linear-inbox  due            12m — check the Linear inbox for new issues\n" +
		"  open  old-pane      pane_death     %7\n" +
		"  note  ci-probe      probe_error    exit 1: HTTP 502 (failures 1)\n"
	if out != want {
		t.Errorf("output:\n%s\nwant:\n%s", out, want)
	}
	if len(*servers) != 1 || (*servers)[0] != "work" {
		t.Errorf("servers checked = %v, want [work]", *servers)
	}
}

func TestOperatorCheckNoChangeStillPrintsOpenAndNotices(t *testing.T) {
	res := operator.CheckResult{
		Open:    []operator.CheckDelta{{Kind: operator.DeltaDone, ID: "a", Then: strp("ship it")}},
		Notices: []operator.CheckNotice{{ID: "g", Kind: operator.NoticeGHUnavailable, Error: "gh unavailable"}},
	}
	stubCheck(t, res, nil)
	out, _, err := check(t)
	if err != nil {
		t.Fatal(err)
	}
	want := "no change, open 1, notices 1\n" +
		"  open  a  done            then: ship it\n" +
		"  note  g  gh_unavailable  gh unavailable\n"
	if out != want {
		t.Errorf("output:\n%s\nwant:\n%s", out, want)
	}

	stubCheck(t, operator.CheckResult{}, nil)
	out, _, err = check(t)
	if err != nil || out != "no change\n" {
		t.Errorf("empty result: out %q err %v", out, err)
	}
}

func TestOperatorCheckDetailPerKind(t *testing.T) {
	cases := []struct {
		d    operator.CheckDelta
		want string
	}{
		{operator.CheckDelta{Kind: operator.DeltaDone}, ""},
		{operator.CheckDelta{Kind: operator.DeltaPaneMismatch, Pane: "%1"}, "%1 found null"},
		{operator.CheckDelta{Kind: operator.DeltaPaneMismatch, Pane: "%1", Found: strp("c1")}, "%1 found c1"},
		{operator.CheckDelta{Kind: operator.DeltaAgentExited, Pane: "%2", Command: strp("zsh")}, "%2 zsh"},
		{operator.CheckDelta{Kind: operator.DeltaReviewFail, Pane: "%3", From: strp("review"), To: strp("apply")}, "%3 review → apply"},
		{operator.CheckDelta{Kind: operator.DeltaAgentState, Pane: "%4", From: strp("active"), To: strp("waiting"), Duration: strp("3m")}, "%4 active → waiting (3m)"},
		{operator.CheckDelta{Kind: operator.DeltaAgentState, Pane: "%4", To: strp("idle")}, "%4 null → idle"},
		{operator.CheckDelta{Kind: operator.DeltaPaused, Error: "paused after 3 consecutive probe failures"}, "paused after 3 consecutive probe failures"},
		{operator.CheckDelta{Kind: operator.DeltaStale, Age: "20m"}, "20m"},
		{operator.CheckDelta{Kind: operator.DeltaDue, Age: "6m"}, "6m"},
		{operator.CheckDelta{Kind: operator.DeltaUnknownDep, Dep: "ghost"}, "ghost"},
		{operator.CheckDelta{Kind: operator.DeltaChanged, Fields: map[string]operator.FieldChange{
			"b": {From: nil, To: 2}, "a": {From: "x", To: "y"},
		}}, `a: "x" → "y"; b: null → 2`},
	}
	for _, tc := range cases {
		if got := checkDetail(tc.d); got != tc.want {
			t.Errorf("%s detail = %q, want %q", tc.d.Kind, got, tc.want)
		}
	}
}

func TestOperatorCheckJSONEnvelope(t *testing.T) {
	stubCheck(t, richCheckResult(), nil)
	out, _, err := check(t, "--json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		OK     bool `json:"ok"`
		Result struct {
			CheckedAt string                   `json:"checked_at"`
			Changed   bool                     `json:"changed"`
			Changes   []map[string]interface{} `json:"changes"`
			Open      []map[string]interface{} `json:"open"`
			Notices   []map[string]interface{} `json:"notices"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("stdout is not one JSON document: %v\n%s", err, out)
	}
	if !doc.OK || !doc.Result.Changed || len(doc.Result.Changes) != 3 || len(doc.Result.Open) != 1 || len(doc.Result.Notices) != 1 {
		t.Fatalf("doc = %+v", doc)
	}
	if doc.Result.CheckedAt != "2026-11-11T12:00:00Z" || doc.Result.Changes[0]["kind"] != "changed" || doc.Result.Changes[0]["id"] != "pr-1120" {
		t.Errorf("changes[0] = %v", doc.Result.Changes[0])
	}
	fields, _ := doc.Result.Changes[0]["fields"].(map[string]interface{})
	if st, _ := fields["state"].(map[string]interface{}); st["from"] != "OPEN" || st["to"] != "MERGED" {
		t.Errorf("fields = %v", fields)
	}
	if n := doc.Result.Notices[0]; n["kind"] != "probe_error" || n["failures"] != float64(1) {
		t.Errorf("notice = %v", n)
	}
}

func TestOperatorCheckJSONEmptyListsMarshalAsArrays(t *testing.T) {
	stubCheck(t, operator.CheckResult{
		CheckedAt: "2026-11-11T12:00:00Z",
		Changes:   []operator.CheckDelta{}, Open: []operator.CheckDelta{}, Notices: []operator.CheckNotice{},
	}, nil)
	out, _, err := check(t, "--json")
	if err != nil {
		t.Fatal(err)
	}
	want := `{"ok":true,"result":{"checked_at":"2026-11-11T12:00:00Z","changed":false,"changes":[],"open":[],"notices":[]}}`
	if strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(out, "\n", ""), " ", "")) != want {
		t.Errorf("stdout = %s", out)
	}
}

func TestOperatorCheckUsesTheCallersServerWhenNoFlag(t *testing.T) {
	servers := stubCheck(t, operator.CheckResult{}, nil)
	operatorOriginalTMUXFn = func() string { return "/tmp/tmux-1000/mine,123,0" }
	if _, _, err := check(t); err != nil {
		t.Fatal(err)
	}
	if len(*servers) != 1 || (*servers)[0] != "mine" {
		t.Errorf("servers checked = %v, want [mine] from $TMUX", *servers)
	}
}

func TestOperatorCheckExitCodes(t *testing.T) {
	t.Run("bad server name is usage, nothing is checked", func(t *testing.T) {
		servers := stubCheck(t, operator.CheckResult{}, nil)
		_, _, err := check(t, "-L", "bad name!")
		wantExit(t, err, 2, "")
		if len(*servers) != 0 {
			t.Errorf("Check ran for an invalid server: %v", *servers)
		}
	})
	t.Run("extra argument is usage", func(t *testing.T) {
		stubCheck(t, operator.CheckResult{}, nil)
		_, _, err := check(t, "extra")
		wantExit(t, err, 2, "")
	})
	t.Run("busy state file is operational", func(t *testing.T) {
		stubCheck(t, operator.CheckResult{}, fmt.Errorf("%w: lock held", operator.ErrBusy))
		_, _, err := check(t)
		wantExit(t, err, 1, "busy")
	})
	t.Run("tmux failure is operational", func(t *testing.T) {
		stubCheck(t, operator.CheckResult{}, errors.New("list sessions: no server running"))
		_, _, err := check(t)
		wantExit(t, err, 1, "no server running")
	})
	t.Run("changes are still exit 0", func(t *testing.T) {
		stubCheck(t, richCheckResult(), nil)
		if _, _, err := check(t); err != nil {
			t.Errorf("err = %v, want exit 0 for a check that found changes", err)
		}
	})
}

func TestOperatorCheckJSONFailureEnvelope(t *testing.T) {
	stubCheck(t, operator.CheckResult{}, fmt.Errorf("%w: lock held", operator.ErrBusy))
	out, _, err := check(t, "--json")
	wantExit(t, err, 1, "busy")
	var doc struct {
		OK    bool `json:"ok"`
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if jerr := json.Unmarshal([]byte(out), &doc); jerr != nil || doc.OK || !strings.Contains(doc.Error.Message, "busy") {
		t.Errorf("stdout = %s (decode err %v)", out, jerr)
	}
}
