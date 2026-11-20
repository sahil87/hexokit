package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"testing"

	"rk/internal/autopilot"
	"rk/internal/operator"

	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

// cliRunner answers the engine's subprocesses without a real git or gh: the
// repo validation sees the requested directory as a git root, and nothing else
// is reachable.
type cliRunner struct {
	calls []string
}

func (r *cliRunner) Run(_ context.Context, dir string, argv ...string) (string, error) {
	r.calls = append(r.calls, strings.Join(argv, " "))
	if len(argv) >= 3 && argv[0] == "git" && argv[1] == "rev-parse" && argv[2] == "--show-toplevel" {
		return dir + "\n", nil
	}
	return "", &autopilot.ExecError{Argv: argv, Stderr: "unscripted in the CLI test", Err: fmt.Errorf("exit status 1")}
}

type cliPanes struct{}

func (*cliPanes) Snapshot(context.Context) (map[string]operator.PaneInfo, error) {
	return map[string]operator.PaneInfo{}, nil
}
func (*cliPanes) PID(context.Context, string) (int, error) { return 123, nil }

// autopilotSandbox stubs the engine environment and the setting, leaving the
// real state file under a temp state home.
func autopilotSandbox(t *testing.T, setting string) (statePath string, runner *cliRunner) {
	t.Helper()
	statePath = operatorSandbox(t)
	runner = &cliRunner{}
	panes := &cliPanes{}
	prevEnv, prevSetting := autopilotEnvFn, autopilotSettingsFn
	autopilotEnvFn = func(cmd *cobra.Command, by string, dry bool) (autopilot.Env, error) {
		_, path, err := operatorStateTarget(cmd)
		if err != nil {
			return autopilot.Env{}, err
		}
		return autopilot.Env{
			Server: "autopilot-test-none", StatePath: path, Run: runner, Panes: panes,
			Session: func(context.Context, string) (string, error) { return "work", nil },
			DryRun:  dry,
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
			engine := readCLIEngine(t, path)
			if len(engine.Queue) != 1 {
				t.Fatalf("engine = %+v", engine)
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
		{"removed author flag", "", queueJSON(repo), []string{"--by", "robot"}, "unknown flag: --by"},
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
	if err := json.Unmarshal([]byte(out), &env); err != nil || !env.OK || env.Result.Actions == nil || env.Result.Escalations == nil {
		t.Fatalf("stop envelope = %s (%v)", out, err)
	}
	if _, err := autopilotCLI(t, "", "step", "--by", "user"); err == nil {
		t.Fatal("removed --by flag accepted")
	} else {
		wantExit(t, err, 2, "unknown flag: --by")
	}
}

func TestAutopilotStepDryRunPlansASpawn(t *testing.T) {
	autopilotSandbox(t, "")
	repo := t.TempDir()
	if _, err := autopilotCLI(t, queueJSON(repo), "queue"); err != nil {
		t.Fatal(err)
	}
	out, err := autopilotCLI(t, "", "step", "--dry-run")
	if err != nil || !strings.Contains(out, "dry-run: spawn q1 (Q2)") {
		t.Fatalf("out = %q err %v", out, err)
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
					engine := readCLIEngine(t, path)
					if len(engine.Queue) != len(entries) {
						t.Fatalf("display cap changed mutation: %+v", engine)
					}
					if verb == "stop" {
						for _, it := range engine.Queue {
							if !it.Paused {
								t.Fatalf("stop missed %s", it.ID)
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
			res.Actions = append(res.Actions, autopilot.Action{Kind: "done", Item: id})
			res.Escalations = append(res.Escalations, autopilot.Escalation{Item: id, Reason: "failed"})
		}
		renderStep(cmd, newSinkWriters(&out, &out), res)
		if strings.Contains(out.String(), "item-022") != all {
			t.Fatalf("all=%v: %s", all, out.String())
		}
		if !all && strings.Count(out.String(), "23 total; showing 20") != 2 {
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
	writeCLIEngineDone(t, path)
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
	engine := readCLIEngine(t, path)
	if len(engine.Queue) != 2 {
		t.Fatalf("engine = %+v", engine)
	}
	for _, it := range engine.Queue {
		if it.MergeMode != "stacked-prs" {
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
	before, _ := os.ReadFile(cliEnginePath(path))
	_, err := autopilotCLI(t, in, "queue")
	wantExit(t, err, 2, "already exists")
	after, _ := os.ReadFile(cliEnginePath(path))
	if string(after) != string(before) {
		t.Fatal("duplicate id changed state")
	}
	help, err := autopilotCLI(t, "", "queue", "--help")
	if err != nil || !strings.Contains(help, "2  usage error (bad entries, id already tracked") {
		t.Fatalf("help = %s, err = %v", help, err)
	}
}

func TestAutopilotQueueRejectsExplicitEmptyMode(t *testing.T) {
	autopilotSandbox(t, "")
	_, err := autopilotCLI(t, queueJSON(t.TempDir()), "queue", "--mode", "")
	wantExit(t, err, 2, "--mode")
}

// holdAutopilotPassLock takes the pass lock the way another running pass does:
// an exclusive flock on <state file stem>.autopilot.lock.
func holdAutopilotPassLock(t *testing.T, statePath string) (release func()) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(statePath), 0o700); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(strings.TrimSuffix(statePath, ".yaml")+".autopilot.lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.Close() })
	return func() { _ = f.Close() }
}

func TestAutopilotBusyPassExitsZeroAndDoesNothing(t *testing.T) {
	path, runner := autopilotSandbox(t, "")
	if _, err := autopilotCLI(t, queueJSON(t.TempDir()), "queue"); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(cliEnginePath(path))
	holdAutopilotPassLock(t, path)
	runner.calls = nil
	for _, verb := range []string{"step", "stop"} {
		out, err := autopilotCLI(t, "", verb)
		if err != nil || !strings.Contains(out, "busy: another autopilot pass is running on this server; retry later") {
			t.Fatalf("%s human out = %q err %v", verb, out, err)
		}
		out, err = autopilotCLI(t, "", verb, "--json")
		var env struct {
			OK     bool `json:"ok"`
			Result struct {
				Busy    bool  `json:"busy"`
				Actions []any `json:"actions"`
			} `json:"result"`
		}
		if err != nil || json.Unmarshal([]byte(out), &env) != nil || !env.OK || !env.Result.Busy || len(env.Result.Actions) != 0 {
			t.Fatalf("%s json out = %q err %v", verb, out, err)
		}
	}
	after, _ := os.ReadFile(cliEnginePath(path))
	if !bytes.Equal(before, after) || len(runner.calls) != 0 {
		t.Fatalf("a busy pass changed state or ran subprocesses: %q", runner.calls)
	}
	// queue, status and a dry-run step do not take the pass lock.
	if out, err := autopilotCLI(t, "", "status"); err != nil || strings.Contains(out, "busy") {
		t.Fatalf("status out = %q err %v", out, err)
	}
	if out, err := autopilotCLI(t, "", "step", "--dry-run"); err != nil || strings.Contains(out, "busy") {
		t.Fatalf("dry-run out = %q err %v", out, err)
	}
	_, err := autopilotCLI(t, `[{"id":"later","repo":"`+t.TempDir()+`","task":"x"}]`, "queue")
	wantExit(t, err, 1, "queue not written, retry")
}

func TestAutopilotNotBusyOnceThePassLockIsFree(t *testing.T) {
	path, _ := autopilotSandbox(t, "")
	release := holdAutopilotPassLock(t, path)
	if out, _ := autopilotCLI(t, "", "step"); !strings.Contains(out, "busy") {
		t.Fatalf("out = %q", out)
	}
	release()
	if out, err := autopilotCLI(t, "", "step"); err != nil || strings.TrimSpace(out) != "nothing to do" {
		t.Fatalf("out = %q err %v", out, err)
	}
}

func TestAutopilotHelpDescribesTheQueueOnlyEngine(t *testing.T) {
	for verb, wants := range map[string][]string{
		"step": {
			"0  stepped (with or without actions or escalations), or busy",
			`If another pass`, `holds it, step does nothing, prints "busy" and exits 0`,
			`"dry-run: <action> <item> (<row>)"`, "reads merged",
		},
		"stop": {
			"0  stopped, or busy", "pause every unspawned, unfinished queue item", "no PR is read or changed",
			"rk operator autopilot resume <id>",
		},
		"rm": {
			"unspawned queue item", "any other id, including a pr's, is an unknown id",
			"2  usage error (unknown id, spawned or spawning item, or unfinished dependents)",
		},
		"resume": {
			"skipped or paused", "neither skipped nor paused",
		},
		"": {
			"readiness, sha-pinned spawn, one respawn and completion", "the operator run's work",
			"the operator merges green prs without asking", "the operator merges only on the user's word",
			"verbs: queue, step, stop, status, rm, resume, pause",
		},
	} {
		args := []string{"--help"}
		if verb != "" {
			args = []string{verb, "--help"}
		}
		help, err := autopilotCLI(t, "", args...)
		if err != nil {
			t.Fatal(err)
		}
		flat := strings.Join(strings.Fields(strings.ToLower(help)), " ")
		for _, want := range wants {
			if !strings.Contains(flat, strings.Join(strings.Fields(strings.ToLower(want)), " ")) {
				t.Errorf("%q help lacks %q:\n%s", verb, want, help)
			}
		}
		for _, gone := range []string{"disarm", "halted", "merge sequence", "pr_status"} {
			if strings.Contains(flat, gone) {
				t.Errorf("%q help still names %q:\n%s", verb, gone, help)
			}
		}
	}
	help, err := autopilotCLI(t, "", "status", "--help")
	flat := strings.Join(strings.Fields(help), " ")
	if err != nil || strings.Contains(flat, "stored facts only") {
		t.Fatalf("status help = %s err %v", help, err)
	}
	for _, want := range []string{
		"makes read-only GitHub calls", "merge-auto predecessor's PR is merged", "Queue Completion Summary", "exits 1",
		"1 operational failure (state file unreadable, a gh lookup failed)",
		"takes no pass lock and reports no escalations",
	} {
		if !strings.Contains(flat, want) {
			t.Errorf("status help lacks %q:\n%s", want, help)
		}
	}
	for _, gone := range []string{"pr_status", "Recovery-spawn", "fixing", "halted"} {
		if strings.Contains(flat, gone) {
			t.Errorf("status help still names %q:\n%s", gone, help)
		}
	}
}

// The engine has seven verbs; merge is the operator run's work, not a verb.
func TestAutopilotHasSevenVerbsAndNoMerge(t *testing.T) {
	var names []string
	for _, c := range operatorAutopilotCmd.Commands() {
		names = append(names, c.Name())
	}
	sort.Strings(names)
	if got, want := strings.Join(names, ","), "pause,queue,resume,rm,status,step,stop"; got != want {
		t.Fatalf("autopilot verbs = %s, want %s", got, want)
	}
	autopilotSandbox(t, "")
	out, err := autopilotCLI(t, "", "merge")
	if err == nil || exitCode(err) == 0 || !strings.Contains(err.Error()+out, "unknown command") {
		t.Fatalf("merge = %q, %v; want an unknown-command failure", out, err)
	}
	help, err := autopilotCLI(t, "", "--help")
	if err != nil || strings.Contains(help, "merge sequence") || strings.Contains(help, "\n  merge ") {
		t.Fatalf("help names a merge verb: %s, %v", help, err)
	}
}

// status carries queue facts only: no PR column, no pr_status, no fixes list,
// and a former PR projection in the ledger is not listed.
func TestAutopilotStatusCarriesNoPRFields(t *testing.T) {
	path, _ := autopilotSandbox(t, "")
	repo := t.TempDir()
	if _, err := autopilotCLI(t, queueJSON(repo), "queue"); err != nil {
		t.Fatal(err)
	}
	writeCLIEngineDone(t, path)
	pr, err := operator.NewGitHubPRItem("pr-7", nil, map[string]interface{}{"repo": repo, "pr": 7, "merge_seq": "seq", "item": "q1"}, "o/r")
	if err != nil {
		t.Fatal(err)
	}
	if err := operator.Mutate(path, func(st *operator.State) error {
		st.Tracked = append(st.Tracked, pr)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	out, err := autopilotCLI(t, "", "status")
	if err != nil || !strings.HasPrefix(out, "q1 · done · cherry-pick-ladder · "+repo) || strings.Contains(out, "PR #") || strings.Contains(out, "pr-7") {
		t.Fatalf("status = %q err %v", out, err)
	}
	out, err = autopilotCLI(t, "", "status", "--json")
	if err != nil {
		t.Fatal(err)
	}
	for _, gone := range []string{"pr_status", `"fixes"`, `"halted"`, `"sequence"`, "pr-7"} {
		if strings.Contains(out, gone) {
			t.Fatalf("status envelope carries %s: %s", gone, out)
		}
	}
	if !strings.Contains(out, `"state": "done"`) || !strings.Contains(out, `"summary"`) {
		t.Fatalf("status envelope lost queue facts: %s", out)
	}
}

// A legacy engine file's prs and fixes lists are ignored by status.
func TestAutopilotStatusIgnoresLegacyPRAndFixLists(t *testing.T) {
	path, _ := autopilotSandbox(t, "")
	enginePath := cliEnginePath(path)
	if err := os.MkdirAll(filepath.Dir(enginePath), 0o700); err != nil {
		t.Fatal(err)
	}
	data := []byte("version: 1\nmigrated: true\nqueue: []\nprs:\n  - id: pr-41\n    merge_seq: s\n    pr: 41\nfixes:\n  - id: ab12-fix\n    repo: /r\n")
	if err := os.WriteFile(enginePath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	out, err := autopilotCLI(t, "", "status")
	if err != nil || strings.TrimSpace(out) != "no queue" {
		t.Fatalf("status = %q err %v", out, err)
	}
}

// rm and resume of a former PR id are unknown-id usage errors that write
// nothing; a queue item carrying only the retired halted marker has nothing to
// resume.
func TestAutopilotRmAndResumeRefuseFormerPRItems(t *testing.T) {
	path, _ := autopilotSandbox(t, "")
	repo := t.TempDir()
	enginePath := cliEnginePath(path)
	if err := os.MkdirAll(filepath.Dir(enginePath), 0o700); err != nil {
		t.Fatal(err)
	}
	data := []byte("version: 1\nmigrated: true\nqueue:\n  - id: q1\n    queue: q\n    repo: " + repo + "\n    task: work\n    depends_on: []\n    halted: true\n" +
		"prs:\n  - id: pr-41\n    merge_seq: s\n    pr: 41\n    halted: true\n")
	if err := os.WriteFile(enginePath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"rm", "pr-41"}, {"rm", "s"}, {"resume", "pr-41"}} {
		_, err := autopilotCLI(t, "", args...)
		wantExit(t, err, 2, "unknown autopilot item")
	}
	_, err := autopilotCLI(t, "", "resume", "q1")
	wantExit(t, err, 2, "not skipped or paused")
	after, _ := os.ReadFile(enginePath)
	if !bytes.Equal(after, data) {
		t.Fatalf("a refused verb rewrote the engine file:\n%s", after)
	}
}

// stop pauses the unspawned items, writes no halt marker and reads no PR.
func TestAutopilotStopPausesUnspawnedItemsOnly(t *testing.T) {
	path, runner := autopilotSandbox(t, "")
	if _, err := autopilotCLI(t, queueJSON(t.TempDir(), t.TempDir()), "queue"); err != nil {
		t.Fatal(err)
	}
	runner.calls = nil
	out, err := autopilotCLI(t, "", "stop")
	if err != nil || !strings.Contains(out, "paused q1") || !strings.Contains(out, "paused q2") {
		t.Fatalf("stop = %q err %v", out, err)
	}
	engine := readCLIEngine(t, path)
	if len(engine.Queue) != 2 || !engine.Queue[0].Paused || !engine.Queue[1].Paused {
		t.Fatalf("queue = %+v", engine.Queue)
	}
	raw, _ := os.ReadFile(cliEnginePath(path))
	if strings.Contains(string(raw), "halted") {
		t.Fatalf("stop wrote a halt marker:\n%s", raw)
	}
	for _, call := range runner.calls {
		if strings.HasPrefix(call, "gh ") {
			t.Fatalf("stop read GitHub: %s", call)
		}
	}
}

func TestAutopilotStatusGitHubFailureMatchesTheHelp(t *testing.T) {
	path, _ := autopilotSandbox(t, "")
	repo := t.TempDir()
	if _, err := autopilotCLI(t, queueJSON(repo, repo), "queue"); err != nil {
		t.Fatal(err)
	}
	writeCLIEngineFirstDoneBranch(t, path)
	if err := operator.Mutate(path, func(st *operator.State) error {
		for i := range st.Tracked {
			st.Tracked[i].Notes = nil
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	out, err := autopilotCLI(t, "", "status")
	wantExit(t, err, 1, "q2: dependency q1 PR lookup failed")
	if strings.Contains(out, "q1 ·") {
		t.Fatalf("human view listed items after a failed lookup: %q", out)
	}
	out, err = autopilotCLI(t, "", "status", "--json")
	wantExit(t, err, 1, "PR lookup failed")
	var env struct {
		OK     bool `json:"ok"`
		Result struct {
			Items []struct{ ID, State string } `json:"items"`
		} `json:"result"`
	}
	if json.Unmarshal([]byte(out), &env) != nil || env.OK || len(env.Result.Items) != 2 || env.Result.Items[1].State != "held" {
		t.Fatalf("envelope = %s", out)
	}
	st, _ := operator.Load(path)
	for _, it := range st.Tracked {
		if len(it.Notes) != 0 {
			t.Fatal("status wrote a note")
		}
	}
}

type cliEngineItem struct {
	ID        string   `yaml:"id"`
	MergeMode string   `yaml:"merge_mode"`
	Paused    bool     `yaml:"paused"`
	DoneAt    *string  `yaml:"done_at"`
	Pane      string   `yaml:"pane"`
	Spawning  string   `yaml:"spawning"`
	DependsOn []string `yaml:"depends_on"`
}

type cliEngineState struct {
	Queue []cliEngineItem `yaml:"queue"`
}

func cliEnginePath(statePath string) string {
	return strings.TrimSuffix(statePath, filepath.Ext(statePath)) + ".autopilot.yaml"
}

func readCLIEngine(t *testing.T, statePath string) cliEngineState {
	t.Helper()
	data, err := os.ReadFile(cliEnginePath(statePath))
	if err != nil {
		t.Fatal(err)
	}
	var engine cliEngineState
	if err := yaml.Unmarshal(data, &engine); err != nil {
		t.Fatal(err)
	}
	return engine
}

func writeCLIEngineDone(t *testing.T, statePath string, branches ...bool) {
	t.Helper()
	path := cliEnginePath(statePath)
	var raw map[string]interface{}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := yaml.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	now := operator.NowRFC3339()
	items, _ := raw["queue"].([]interface{})
	for _, item := range items {
		fields := item.(map[string]interface{})
		fields["done_at"] = now
		if len(branches) > 0 && branches[0] {
			fields["branch"] = fields["id"].(string) + "-branch"
		}
	}
	data, err = yaml.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func writeCLIEngineFirstDoneBranch(t *testing.T, statePath string) {
	t.Helper()
	path := cliEnginePath(statePath)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]interface{}
	if err := yaml.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	items := raw["queue"].([]interface{})
	first := items[0].(map[string]interface{})
	now := operator.NowRFC3339()
	first["done_at"] = now
	first["branch"] = "q1-branch"
	data, err = yaml.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}
