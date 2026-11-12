package operator

import (
	"strings"
	"testing"
	"time"
)

func TestNormalizeCheckEvery(t *testing.T) {
	tests := []struct {
		name    string
		mode    string
		given   string
		want    *string
		wantErr string
	}{
		{"pane forces null", probePane, "2m", nil, ""},
		{"none forces null", probeNone, "2m", nil, ""},
		{"shell default 5m", probeShell, "", strPtr("5m"), ""},
		{"agent default 5m", probeAgent, "", strPtr("5m"), ""},
		{"explicit value kept verbatim", probeShell, "2m", strPtr("2m"), ""},
		{"floor value accepted", probeAgent, "1m", strPtr("1m"), ""},
		{"below floor rejected", probeShell, "30s", nil, "below the 1m0s floor"},
		{"invalid duration rejected", probeShell, "often", nil, "invalid --check-every"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeCheckEvery(tc.mode, tc.given)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("normalizeCheckEvery(%q, %q) err = %v, want %q", tc.mode, tc.given, err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("normalizeCheckEvery(%q, %q): %v", tc.mode, tc.given, err)
			}
			if (got == nil) != (tc.want == nil) || (got != nil && *got != *tc.want) {
				t.Errorf("normalizeCheckEvery(%q, %q) = %v, want %v", tc.mode, tc.given, got, tc.want)
			}
		})
	}
}

func strPtr(s string) *string { return &s }

func TestValidateItem(t *testing.T) {
	shellItem := TrackedItem{
		ID: "x", Kind: KindShell,
		Probe: ProbeSpec{Mode: probeShell, Argv: []string{"true"}, Fields: []string{"a"}},
	}
	tests := []struct {
		name    string
		mutate  func(*TrackedItem)
		wantErr string
	}{
		{"valid shell item", nil, ""},
		{"unknown kind", func(it *TrackedItem) { it.Kind = "email" }, "unknown kind"},
		{"kind-forbidden probe mode", func(it *TrackedItem) { it.Kind = KindNote }, "does not allow probe mode"},
		{"shell probe without argv", func(it *TrackedItem) { it.Probe.Argv = nil }, "requires --argv"},
		{"shell probe without fields", func(it *TrackedItem) { it.Probe.Fields = nil }, "requires --fields"},
		{"malformed done_when names the clause", func(it *TrackedItem) { it.DoneWhen = strPtr(`state == MERGED`) }, "invalid --done-when"},
		{"valid done_when", func(it *TrackedItem) { it.DoneWhen = strPtr(`state == "MERGED"`) }, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			it := shellItem
			if tc.mutate != nil {
				tc.mutate(&it)
			}
			err := validateItem(it)
			if tc.wantErr == "" {
				if err != nil {
					t.Errorf("validateItem = %v, want nil", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("validateItem = %v, want %q", err, tc.wantErr)
			}
		})
	}
}

func TestValidateDeps(t *testing.T) {
	existing := []TrackedItem{{ID: "a"}, {ID: "b"}}
	tests := []struct {
		name    string
		it      TrackedItem
		wantErr string
	}{
		{"no deps", TrackedItem{ID: "c"}, ""},
		{"known deps", TrackedItem{ID: "c", DependsOn: []string{"a", "b"}}, ""},
		{"unknown dep", TrackedItem{ID: "c", DependsOn: []string{"zz"}}, "no tracked item with that id"},
		{"self dependency", TrackedItem{ID: "a", DependsOn: []string{"a"}}, "names the item itself"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := validateDeps(tc.it, existing)
			if tc.wantErr == "" && err != nil {
				t.Errorf("validateDeps = %v, want nil", err)
			}
			if tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)) {
				t.Errorf("validateDeps = %v, want %q", err, tc.wantErr)
			}
		})
	}
}

func TestItemDone(t *testing.T) {
	tests := []struct {
		name string
		it   TrackedItem
		want bool
	}{
		{"null done_when is never done", TrackedItem{Kind: KindPane}, false},
		{"done_when fires on last", TrackedItem{
			DoneWhen: strPtr(`state == "MERGED"`),
			Last:     map[string]interface{}{"state": "MERGED"},
		}, true},
		{"done_when false on last", TrackedItem{
			DoneWhen: strPtr(`state == "MERGED"`),
			Last:     map[string]interface{}{"state": "OPEN"},
		}, false},
		{"unparseable stored done_when is not done (fail-safe)", TrackedItem{
			DoneWhen: strPtr(`state == MERGED`),
			Last:     map[string]interface{}{"state": "MERGED"},
		}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := itemDone(tc.it); got != tc.want {
				t.Errorf("itemDone = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestItemStale(t *testing.T) {
	now := time.Date(2026, 9, 11, 12, 0, 0, 0, time.UTC)
	ago := func(d time.Duration) *string {
		s := now.Add(-d).Format(time.RFC3339)
		return &s
	}
	tests := []struct {
		name string
		it   TrackedItem
		want bool
	}{
		{"agent item past 2x cadence is stale", TrackedItem{
			Probe: ProbeSpec{Mode: probeAgent}, CheckEvery: strPtr("5m"), CheckedAt: ago(11 * time.Minute),
		}, true},
		{"agent item within 2x cadence is fresh", TrackedItem{
			Probe: ProbeSpec{Mode: probeAgent}, CheckEvery: strPtr("5m"), CheckedAt: ago(9 * time.Minute),
		}, false},
		{"null checked_at falls back to added_at", TrackedItem{
			Probe: ProbeSpec{Mode: probeAgent}, CheckEvery: strPtr("5m"),
			AddedAt: now.Add(-11 * time.Minute).Format(time.RFC3339),
		}, true},
		{"shell items never stale (the binary probes them)", TrackedItem{
			Probe: ProbeSpec{Mode: probeShell}, CheckEvery: strPtr("5m"), CheckedAt: ago(time.Hour),
		}, false},
		{"null check_every never stale", TrackedItem{
			Probe: ProbeSpec{Mode: probeAgent}, CheckedAt: ago(time.Hour),
		}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := itemStale(tc.it, now); got != tc.want {
				t.Errorf("itemStale = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestHeldDep(t *testing.T) {
	done := TrackedItem{ID: "a", DoneWhen: strPtr(`x == 1`), Last: map[string]interface{}{"x": 1}}
	open := TrackedItem{ID: "b", DoneWhen: strPtr(`x == 1`), Last: map[string]interface{}{"x": 0}}
	items := []TrackedItem{done, open}
	tests := []struct {
		name string
		it   TrackedItem
		want string
	}{
		{"satisfied dep", TrackedItem{ID: "c", DependsOn: []string{"a"}}, ""},
		{"unsatisfied dep", TrackedItem{ID: "c", DependsOn: []string{"b"}}, "b"},
		{"missing dep is unsatisfied", TrackedItem{ID: "c", DependsOn: []string{"zz"}}, "zz"},
		{"first unsatisfied dep wins", TrackedItem{ID: "c", DependsOn: []string{"a", "b"}}, "b"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := heldDep(items, tc.it); got != tc.want {
				t.Errorf("heldDep = %q, want %q", got, tc.want)
			}
		})
	}
}
