package operator

import (
	"context"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func TestAdd_ScopeAllowList(t *testing.T) {
	tests := []struct {
		name string
		spec AddSpec
		want string // error substring; empty = allowed
	}{
		{"engine key", AddSpec{ID: "x", Kind: KindPane, Scope: map[string]interface{}{"armed": true}}, "scope.armed is owned by autopilot"},
		{"every engine key refused", AddSpec{ID: "x", Kind: KindGitHubPR, Scope: map[string]interface{}{"deferred": true}}, "scope.deferred is owned by autopilot"},
		{"check-owned key", AddSpec{ID: "x", Kind: KindPane, Scope: map[string]interface{}{"stage": "apply"}}, "scope.stage is owned by rk operator check"},
		{"merge_mode through scope", AddSpec{ID: "x", Kind: KindPane, Scope: map[string]interface{}{"merge_mode": "merge-auto"}}, "set through --mode"},
		{"unknown key", AddSpec{ID: "x", Kind: KindPane, Scope: map[string]interface{}{"foo": 1}}, "keep your own facts in scope.memo"},
		{"memo must be an object", AddSpec{ID: "x", Kind: KindPane, Scope: map[string]interface{}{"memo": "text"}}, "scope.memo must be a JSON object"},
		{"force writes a refused key", AddSpec{ID: "x", Kind: KindPane, Force: true, Scope: map[string]interface{}{"armed": true, "foo": 1}}, ""},
		{"identity, binding, free keys at creation", AddSpec{ID: "x", Kind: KindPane, Scope: map[string]interface{}{
			"repo": "/r", "change": "c", "task": "t", "bare": false, "pane": "%1", "session": "s", "branch": "b",
			"stop_stage": "apply", "spawned_by": "chat", "recovery": "rebase", "fix_head": "abc", "memo": map[string]interface{}{"a": 1},
		}}, ""},
		{"linear watcher query", AddSpec{ID: "x", Kind: KindLinear, Instruction: "look", Scope: map[string]interface{}{"repo": "/r", "query": map[string]interface{}{"team": "DEV"}}}, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			path := seededState(t, seedShell)
			stubSeams(t)
			before, _ := os.ReadFile(path)
			_, err := Add(context.Background(), path, tc.spec)
			if tc.want == "" {
				if err != nil {
					t.Fatalf("Add: %v", err)
				}
				return
			}
			wantErr(t, err, tc.want)
			if !isInvalid(err) {
				t.Errorf("err = %T, want an InvalidError (usage class)", err)
			}
			if after, _ := os.ReadFile(path); string(before) != string(after) {
				t.Error("state file changed on a refused add")
			}
		})
	}
}

// The creation sugar (--pane --repo --stage --agent …, --mode) is not a free
// scope write and keeps working at creation.
func TestAdd_SugarFlagsAndModeStillWriteScope(t *testing.T) {
	path := seededState(t, seedShell)
	stubSeams(t)
	mustAdd(t, path, AddSpec{
		ID: "w1", Kind: KindPane, Mode: MergeModeMergeAuto,
		PaneSugar: map[string]string{"pane": "%5", "repo": "/r", "session": "s", "branch": "b", "stage": "apply", "agent": "claude", "stop-stage": "review", "spawned-by": "chat", "change": "c"},
	})
	it := item(t, path, "w1")
	for k, want := range map[string]string{"pane": "%5", "repo": "/r", "session": "s", "branch": "b", "stage": "apply", "agent": "claude", "stop_stage": "review", "spawned_by": "chat", "change": "c", "merge_mode": MergeModeMergeAuto} {
		if got := scopeString(it.Scope, k); got != want {
			t.Errorf("scope.%s = %q, want %q", k, got, want)
		}
	}
}

func TestMemo_MergesPerKeyAndNeverEngineOwned(t *testing.T) {
	path := ownershipState(t)
	ctx := context.Background()
	up := func(memo interface{}) error {
		return Update(ctx, path, UpdateSpec{ID: "q1", Scope: map[string]interface{}{"memo": memo}})
	}
	// A queue item's memo is the caller's even though its binding is not.
	if err := up(map[string]interface{}{"why": "design", "owner": "sam"}); err != nil {
		t.Fatal(err)
	}
	if err := up(map[string]interface{}{"why": "legal", "extra": map[string]interface{}{"n": 1}}); err != nil {
		t.Fatal(err)
	}
	want := map[string]interface{}{"why": "legal", "owner": "sam", "extra": map[string]interface{}{"n": 1}}
	if got := item(t, path, "q1").Scope["memo"]; !reflect.DeepEqual(got, want) {
		t.Fatalf("memo = %v, want %v", got, want)
	}
	if err := up(map[string]interface{}{"owner": nil}); err != nil {
		t.Fatal(err)
	}
	if got, _ := item(t, path, "q1").Scope["memo"].(map[string]interface{}); got["owner"] != nil || got["why"] != "legal" {
		t.Fatalf("a null member must delete just that key: %v", got)
	}
	if err := up(nil); err != nil {
		t.Fatal(err)
	}
	if _, ok := item(t, path, "q1").Scope["memo"]; ok {
		t.Fatal("null memo must clear the map")
	}
	wantErr(t, up("text"), "scope.memo must be a JSON object")
	// The engine's keys are untouched by memo writes.
	if got := item(t, path, "q1").Scope["queue"]; got != "q" {
		t.Fatalf("scope.queue = %v", got)
	}
}

func TestRemove_ArmedPRItemNeedsForce(t *testing.T) {
	path := ownershipState(t)
	if err := Update(context.Background(), path, UpdateSpec{ID: "pr-done", Force: true, Scope: map[string]interface{}{"armed": true}}); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(path)
	err := Remove(path, "pr-done", false)
	wantErr(t, err, "armed for auto-merge")
	wantErr(t, err, "--force")
	if !isInvalid(err) {
		t.Errorf("err = %T, want an InvalidError (usage class)", err)
	}
	if after, _ := os.ReadFile(path); string(before) != string(after) {
		t.Error("state file changed on a refused remove")
	}
	if err := Update(context.Background(), path, UpdateSpec{ID: "pr-done", Force: true, Scope: map[string]interface{}{"armed": false}}); err != nil {
		t.Fatal(err)
	}
	if err := Remove(path, "pr-done", false); err != nil {
		t.Fatalf("a disarmed PR item must remove: %v", err)
	}
	if err := Update(context.Background(), path, UpdateSpec{ID: "q1", Force: true, Scope: map[string]interface{}{"armed": true}}); err != nil {
		t.Fatal(err)
	}
	if err := Remove(path, "q1", false); err != nil {
		t.Fatalf("only github-pr items are protected: %v", err)
	}
}

func TestRemove_ArmedPRItemForce(t *testing.T) {
	path := ownershipState(t)
	if err := Update(context.Background(), path, UpdateSpec{ID: "pr-done", Force: true, Scope: map[string]interface{}{"armed": true}}); err != nil {
		t.Fatal(err)
	}
	if err := Remove(path, "pr-done", true); err != nil {
		t.Fatalf("--force: %v", err)
	}
}

// Every registered key has exactly one class, the engine set is what
// EngineScopeKeys reports, and the keys the brief tells agents to write are on
// the allow-list.
func TestScopeKeyTable(t *testing.T) {
	engine := EngineScopeKeys()
	if !sort.StringsAreSorted(engine) || len(engine) == 0 {
		t.Fatalf("EngineScopeKeys = %v", engine)
	}
	for _, k := range engine {
		if !ScopeKeyKnown(k) || EngineMayWrite(k) == false {
			t.Errorf("engine key %q not writable by the engine", k)
		}
	}
	for _, k := range []string{"memo", "recovery", "fix_head", "stop_stage", "spawned_by", "query"} {
		if !ScopeKeyKnown(k) || strings.Contains(strings.Join(engine, ","), k) {
			t.Errorf("%q must be a known, non-engine key", k)
		}
	}
	if EngineMayWrite("memo") || EngineMayWrite("recovery") || EngineMayWrite("nope") {
		t.Error("the engine must not write memo, recovery or unregistered keys")
	}
}
