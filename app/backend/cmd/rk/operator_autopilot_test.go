package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	"rk/internal/autopilot"
	"rk/internal/operator"

	"github.com/spf13/cobra"
)

// cliRunner answers the engine's subprocesses without a real git or gh: the
// repo validation sees the requested directory as a git root, and nothing else
// is reachable.
type cliRunner struct{ calls []string }

func (r *cliRunner) Run(_ context.Context, dir string, argv ...string) (string, error) {
	r.calls = append(r.calls, strings.Join(argv, " "))
	if len(argv) >= 3 && argv[0] == "git" && argv[1] == "rev-parse" && argv[2] == "--show-toplevel" {
		return dir + "\n", nil
	}
	return "", &autopilot.ExecError{Argv: argv, Stderr: "unscripted in the CLI test", Err: fmt.Errorf("exit status 1")}
}

type cliPanes struct{}

func (cliPanes) Snapshot(context.Context) (map[string]operator.PaneInfo, error) {
	return map[string]operator.PaneInfo{}, nil
}
func (cliPanes) PID(context.Context, string) (int, error)   { return 123, nil }
func (cliPanes) Send(context.Context, string, string) error { return nil }

// autopilotSandbox stubs the engine environment and the setting, leaving the
// real state file under a temp state home.
func autopilotSandbox(t *testing.T, setting string) (statePath string, runner *cliRunner) {
	t.Helper()
	statePath = operatorSandbox(t)
	runner = &cliRunner{}
	prevEnv, prevSetting := autopilotEnvFn, autopilotSettingsFn
	autopilotEnvFn = func(cmd *cobra.Command, by string, dry bool) (autopilot.Env, error) {
		_, path, err := operatorStateTarget(cmd)
		if err != nil {
			return autopilot.Env{}, err
		}
		return autopilot.Env{
			Server: "autopilot-test-none", StatePath: path, Run: runner, Panes: cliPanes{},
			Session: func(context.Context, string) (string, error) { return "work", nil },
			By:      by, DryRun: dry,
		}, nil
	}
	autopilotSettingsFn = func() string { return setting }
	t.Cleanup(func() { autopilotEnvFn, autopilotSettingsFn = prevEnv, prevSetting })
	return statePath, runner
}

func autopilotCLI(t *testing.T, stdin string, args ...string) (string, error) {
	t.Helper()
	out, _, err := runOperatorCLI(t, stdin, append([]string{"autopilot"}, args...)...)
	return out, err
}

func queueJSON(repos ...string) string {
	entries := make([]string, 0, len(repos))
	for i, r := range repos {
		entries = append(entries, fmt.Sprintf(`{"id":"q%d","repo":%q,"task":"work %d"}`, i+1, r, i+1))
	}
	return "[" + strings.Join(entries, ",") + "]"
}

func TestAutopilotQueueHumanOutputAndModeSource(t *testing.T) {
	cases := []struct {
		name, setting string
		args          []string
		want          string
	}{
		{"default", "", nil, "mode: cherry-pick-ladder (default)"},
		{"setting", "stacked-prs", nil, "mode: stacked-prs (setting)"},
		{"flag over setting", "stacked-prs", []string{"--mode", "merge-auto"}, "mode: merge-auto (flag)"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			path, _ := autopilotSandbox(t, c.setting)
			repo := t.TempDir()
			out, err := autopilotCLI(t, queueJSON(repo), append([]string{"queue"}, c.args...)...)
			if err != nil {
				t.Fatalf("queue: %v", err)
			}
			if !strings.Contains(out, c.want) || !strings.Contains(out, "queued q1") {
				t.Fatalf("output = %q", out)
			}
			st, lerr := operator.Load(path)
			if lerr != nil || len(st.Tracked) != 1 {
				t.Fatalf("state = %+v err %v", st, lerr)
			}
		})
	}
}

func TestAutopilotQueueJSONEnvelope(t *testing.T) {
	autopilotSandbox(t, "")
	repo := t.TempDir()
	out, err := autopilotCLI(t, queueJSON(repo, repo), "queue", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var env struct {
		OK     bool `json:"ok"`
		Result struct {
			Mode    string   `json:"mode"`
			Source  string   `json:"source"`
			Items   []string `json:"items"`
			Misfits []string `json:"misfits"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(out), &env); err != nil {
		t.Fatalf("not one JSON document: %v\n%s", err, out)
	}
	if !env.OK || env.Result.Mode != "cherry-pick-ladder" || env.Result.Source != "default" || len(env.Result.Items) != 2 || env.Result.Misfits == nil {
		t.Fatalf("envelope = %+v", env)
	}
}

func TestAutopilotQueueMisfitIsPrinted(t *testing.T) {
	autopilotSandbox(t, "")
	repo := t.TempDir()
	in := fmt.Sprintf(`[{"id":"a","repo":%q,"task":"a"},{"id":"b","repo":%q,"task":"b","depends_on":["a"]}]`, repo, repo)
	out, err := autopilotCLI(t, in, "queue", "--mode", "merge-auto")
	if err != nil || !strings.Contains(out, "misfit: merge-auto with same-repo depends_on") {
		t.Fatalf("out = %q err %v", out, err)
	}
}

func TestAutopilotQueueUsageErrors(t *testing.T) {
	repo := t.TempDir()
	cases := []struct {
		name, setting, stdin string
		args                 []string
		want                 string
	}{
		{"invalid setting", "bogus", queueJSON(repo), nil, "cherry-pick-ladder, stacked-prs, merge-auto"},
		{"invalid flag", "", queueJSON(repo), []string{"--mode", "bogus"}, "invalid --mode"},
		{"not json", "", "not json", nil, "invalid queue entries"},
		{"empty queue", "", "[]", nil, "queue is empty"},
		{"relative repo", "", `[{"id":"a","repo":"rel","task":"a"}]`, nil, "absolute"},
		{"bad author", "", queueJSON(repo), []string{"--by", "robot"}, "invalid --by"},
		{"trailing input after the array", "", queueJSON(repo) + ` {"id":"x"}`, nil, "unexpected input after the JSON array"},
		{"input over the cap", "", queueJSON(repo) + strings.Repeat(" ", autopilotStdinCap), nil, "exceed the"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			path, _ := autopilotSandbox(t, c.setting)
			_, err := autopilotCLI(t, c.stdin, append([]string{"queue"}, c.args...)...)
			wantExit(t, err, 2, c.want)
			if _, statErr := os.Stat(path); statErr == nil {
				t.Fatal("a rejected queue wrote the state file")
			}
		})
	}
}

func TestAutopilotQueueDryRunWritesNothing(t *testing.T) {
	path, _ := autopilotSandbox(t, "")
	out, err := autopilotCLI(t, queueJSON(t.TempDir()), "queue", "--dry-run")
	if err != nil || !strings.Contains(out, "would queue q1") {
		t.Fatalf("out = %q err %v", out, err)
	}
	if _, statErr := os.Stat(path); statErr == nil {
		t.Fatal("dry-run wrote the state file")
	}
}

func TestAutopilotStepAndStopOnAnEmptyLedger(t *testing.T) {
	autopilotSandbox(t, "")
	out, err := autopilotCLI(t, "", "step")
	if err != nil || strings.TrimSpace(out) != "nothing to do" {
		t.Fatalf("step out = %q err %v", out, err)
	}
	out, err = autopilotCLI(t, "", "step", "--dry-run")
	if err != nil || strings.TrimSpace(out) != "dry-run: nothing to do" {
		t.Fatalf("dry-run out = %q err %v", out, err)
	}
	out, err = autopilotCLI(t, "", "stop", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var env struct {
		OK     bool                 `json:"ok"`
		Result autopilot.StepResult `json:"result"`
	}
	if err := json.Unmarshal([]byte(out), &env); err != nil || !env.OK || env.Result.Actions == nil || env.Result.Escalations == nil || env.Result.Report == nil {
		t.Fatalf("stop envelope = %s (%v)", out, err)
	}
	if _, err := autopilotCLI(t, "", "step", "--by", "user"); err == nil {
		t.Fatal("step accepts only run or chat as author")
	} else {
		wantExit(t, err, 2, "invalid --by")
	}
}

func TestAutopilotStepDryRunPlansASpawn(t *testing.T) {
	autopilotSandbox(t, "")
	repo := t.TempDir()
	if _, err := autopilotCLI(t, queueJSON(repo), "queue"); err != nil {
		t.Fatal(err)
	}
	out, err := autopilotCLI(t, "", "step", "--dry-run")
	if err != nil || !strings.Contains(out, "dry-run: spawned q1 would spawn in "+repo) {
		t.Fatalf("out = %q err %v", out, err)
	}
}

func TestAutopilotMergeRefusesUnfinishedQueue(t *testing.T) {
	autopilotSandbox(t, "")
	if _, err := autopilotCLI(t, queueJSON(t.TempDir()), "queue"); err != nil {
		t.Fatal(err)
	}
	_, err := autopilotCLI(t, "", "merge")
	wantExit(t, err, 1, "not done yet: q1")
	out, jerr := autopilotCLI(t, "", "merge", "--json")
	if jerr == nil || !strings.Contains(out, `"ok": false`) {
		t.Fatalf("out = %q err %v", out, jerr)
	}
}

func TestAutopilotStatus(t *testing.T) {
	autopilotSandbox(t, "")
	repo := t.TempDir()
	if _, err := autopilotCLI(t, queueJSON(repo, repo), "queue"); err != nil {
		t.Fatal(err)
	}
	out, err := autopilotCLI(t, "", "status")
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 3 || !strings.HasPrefix(lines[0], "q1 · pending · cherry-pick-ladder · "+repo) || !strings.HasPrefix(lines[1], "q2 · held · ") {
		t.Fatalf("status = %q", out)
	}
	out, err = autopilotCLI(t, "", "status", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var env struct {
		Result autopilot.StatusResult `json:"result"`
	}
	if err := json.Unmarshal([]byte(out), &env); err != nil || len(env.Result.Items) != 2 || env.Result.Complete {
		t.Fatalf("status envelope = %s (%v)", out, err)
	}
}

func TestAutopilotStatusOnNoQueue(t *testing.T) {
	autopilotSandbox(t, "")
	out, err := autopilotCLI(t, "", "status")
	if err != nil || strings.TrimSpace(out) != "no queue" {
		t.Fatalf("out = %q err %v", out, err)
	}
}

func TestAutopilotErrorMapping(t *testing.T) {
	if got := exitCode(autopilotError(&autopilot.InvalidError{})); got != 2 {
		t.Errorf("InvalidError exit = %d, want 2", got)
	}
	if got := exitCode(autopilotError(fmt.Errorf("busy"))); got != 1 {
		t.Errorf("operational exit = %d, want 1", got)
	}
}

func TestAutopilotHumanListsAreBoundedAndJSONComplete(t *testing.T) {
	for _, verb := range []string{"queue", "status", "step", "stop"} {
		for _, format := range []string{"human", "all", "json"} {
			t.Run(verb+"/"+format, func(t *testing.T) {
				path, _ := autopilotSandbox(t, "")
				repo := t.TempDir()
				entries := make([]autopilot.Entry, autopilotListCap+3)
				none := []string{}
				for i := range entries {
					entries[i] = autopilot.Entry{ID: fmt.Sprintf("item-%03d", i), Repo: repo, Task: "work", DependsOn: &none}
				}
				raw, _ := json.Marshal(entries)
				stdin := string(raw)
				if verb != "queue" {
					if _, err := autopilotCLI(t, stdin, "queue"); err != nil {
						t.Fatal(err)
					}
					stdin = ""
				}
				args := []string{verb}
				if verb == "step" {
					args = append(args, "--dry-run")
				}
				if format == "all" {
					args = append(args, "--all")
				}
				if format == "json" {
					args = append(args, "--json")
				}
				out, err := autopilotCLI(t, stdin, args...)
				if err != nil {
					t.Fatal(err)
				}
				last := "item-022"
				if format == "human" {
					if strings.Contains(out, last) || !strings.Contains(out, "23 total; showing 20 (cap 20), 3 omitted; use --all") {
						t.Fatalf("output = %s", out)
					}
				} else if !strings.Contains(out, last) || strings.Contains(out, "omitted; use --all") {
					t.Fatalf("output = %s", out)
				}
				if format == "json" && !json.Valid([]byte(out)) {
					t.Fatalf("invalid JSON: %s", out)
				}
				if verb == "queue" || verb == "stop" {
					st, err := operator.Load(path)
					if err != nil || len(st.Tracked) != len(entries) {
						t.Fatalf("display cap changed mutation: %+v %v", st, err)
					}
					if verb == "stop" {
						for _, it := range st.Tracked {
							if !it.Paused {
								t.Fatal("stop missed hidden item")
							}
						}
					}
				}
			})
		}
	}
}

func TestAutopilotStepRendererCapsEveryList(t *testing.T) {
	for _, all := range []bool{false, true} {
		var out bytes.Buffer
		cmd := &cobra.Command{}
		cmd.Flags().Bool("all", all, "")
		res := &autopilot.StepResult{}
		for i := 0; i < autopilotListCap+3; i++ {
			id := fmt.Sprintf("item-%03d", i)
			res.Actions = append(res.Actions, autopilot.Action{Kind: "merged", Item: id})
			res.Report = append(res.Report, "report "+id)
			res.Escalations = append(res.Escalations, autopilot.Escalation{Item: id, Reason: "failed"})
			res.Unreviewed = append(res.Unreviewed, id)
		}
		res.Report = append(res.Report, "merged without review: "+strings.Join(res.Unreviewed, ", "))
		renderStep(cmd, newSinkWriters(&out, &out), res)
		if strings.Contains(out.String(), "item-022") != all {
			t.Fatalf("all=%v: %s", all, out.String())
		}
		if !all && strings.Count(out.String(), "23 total; showing 20") != 4 {
			t.Fatalf("missing exact totals: %s", out.String())
		}
	}
}

func TestAutopilotQueueCapsMisfits(t *testing.T) {
	autopilotSandbox(t, "")
	repo := t.TempDir()
	entries := make([]autopilot.Entry, autopilotListCap+3)
	for i := range entries {
		entries[i] = autopilot.Entry{ID: fmt.Sprintf("item-%03d", i), Repo: repo, Task: "work"}
		if i > 0 {
			deps := []string{entries[i-1].ID}
			entries[i].DependsOn = &deps
		}
	}
	raw, _ := json.Marshal(entries)
	out, err := autopilotCLI(t, string(raw), "queue", "--mode", "merge-auto", "--dry-run")
	if err != nil || strings.Count(out, "misfit:") != autopilotListCap || !strings.Contains(out, "misfits: 22 total; showing 20") {
		t.Fatalf("output = %s; err = %v", out, err)
	}
}

func TestAutopilotCompletionSummaryIsBounded(t *testing.T) {
	path, _ := autopilotSandbox(t, "")
	repos := make([]string, autopilotListCap+3)
	for i := range repos {
		repos[i] = t.TempDir()
	}
	if _, err := autopilotCLI(t, queueJSON(repos...), "queue"); err != nil {
		t.Fatal(err)
	}
	if err := operator.Mutate(path, func(st *operator.State) error {
		for i := range st.Tracked {
			now := operator.NowRFC3339()
			st.Tracked[i].DoneAt = &now
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	out, err := autopilotCLI(t, "", "status")
	if err != nil || strings.Contains(out, "q23:") || !strings.Contains(out, "review PRs: 23 total; showing 20") || !strings.Contains(out, "repos: 23 total; showing 20") {
		t.Fatalf("output = %s; err = %v", out, err)
	}
	out, err = autopilotCLI(t, "", "status", "--json")
	if err != nil || !strings.Contains(out, "23. q23:") {
		t.Fatalf("JSON summary incomplete: %s; err = %v", out, err)
	}
}

func TestAutopilotMisfitDryRunThenOneLiveCall(t *testing.T) {
	path, _ := autopilotSandbox(t, "merge-auto")
	repo := t.TempDir()
	in := fmt.Sprintf(`[{"id":"a","repo":%q,"task":"a"},{"id":"b","repo":%q,"task":"b","depends_on":["a"]}]`, repo, repo)
	_, err := autopilotCLI(t, in, "queue")
	wantExit(t, err, 2, "queue not written")
	out, err := autopilotCLI(t, in, "queue", "--dry-run")
	if err != nil || !strings.Contains(out, "mode: merge-auto (setting)") || !strings.Contains(out, "misfit:") {
		t.Fatalf("preview = %s, err = %v", out, err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("preview or rejected queue wrote state: %v", err)
	}
	if _, err := autopilotCLI(t, in, "queue", "--mode", "stacked-prs"); err != nil {
		t.Fatal(err)
	}
	st, err := operator.Load(path)
	if err != nil || len(st.Tracked) != 2 {
		t.Fatalf("state = %+v, err = %v", st, err)
	}
	for _, it := range st.Tracked {
		if operator.ScopeString(it.Scope, "merge_mode") != "stacked-prs" {
			t.Fatal("unconfirmed mode persisted")
		}
	}
}

func TestAutopilotAlreadyTrackedIDMatchesHelpExitCode(t *testing.T) {
	path, _ := autopilotSandbox(t, "")
	in := queueJSON(t.TempDir())
	if _, err := autopilotCLI(t, in, "queue"); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(path)
	_, err := autopilotCLI(t, in, "queue")
	wantExit(t, err, 2, "already exists")
	after, _ := os.ReadFile(path)
	if string(after) != string(before) {
		t.Fatal("duplicate id changed state")
	}
	help, err := autopilotCLI(t, "", "queue", "--help")
	if err != nil || !strings.Contains(help, "2  usage error (bad entries, id already tracked") {
		t.Fatalf("help = %s, err = %v", help, err)
	}
}

func TestAutopilotMergeRejectsInvalidRepoFilter(t *testing.T) {
	for _, kind := range []string{"relative", "missing", "unmatched", "empty"} {
		t.Run(kind, func(t *testing.T) {
			path, runner := autopilotSandbox(t, "")
			if _, err := autopilotCLI(t, queueJSON(t.TempDir()), "queue"); err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			repo := "relative"
			switch kind {
			case "missing":
				repo = t.TempDir() + "/missing"
			case "unmatched":
				repo = t.TempDir()
			case "empty":
				repo = ""
			}
			out, err := autopilotCLI(t, "", "merge", "--repo", repo, "--json")
			wantExit(t, err, 2, "--repo")
			var envelope map[string]interface{}
			if json.Unmarshal([]byte(out), &envelope) != nil {
				t.Fatalf("not a JSON envelope: %s", out)
			}
			after, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(before, after) {
				t.Fatal("invalid filter changed state")
			}
			for _, call := range runner.calls {
				if strings.HasPrefix(call, "gh ") {
					t.Fatalf("invalid filter reached GitHub: %s", call)
				}
			}
		})
	}
}

func TestAutopilotQueueRejectsExplicitEmptyMode(t *testing.T) {
	autopilotSandbox(t, "")
	_, err := autopilotCLI(t, queueJSON(t.TempDir()), "queue", "--mode", "")
	wantExit(t, err, 2, "--mode")
}
