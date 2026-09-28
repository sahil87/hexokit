package updatecheck

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestNormalizeTag(t *testing.T) {
	cases := map[string]string{
		"v0.6.0":  "0.6.0",
		"0.6.0":   "0.6.0",
		" v1.2.3": "1.2.3",
		"v1.2.3 ": "1.2.3",
	}
	for in, want := range cases {
		if got := normalizeTag(in); got != want {
			t.Errorf("normalizeTag(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseMajorMinor(t *testing.T) {
	ok := map[string][2]int{
		"0.6.0":     {0, 6},
		"1.2.3":     {1, 2},
		"10.20.30":  {10, 20},
		"2.5":       {2, 5},
		"1.4.0-rc1": {1, 4}, // trailing pre-release on patch tolerated
	}
	for in, want := range ok {
		maj, min, err := parseMajorMinor(in)
		if err != nil {
			t.Errorf("parseMajorMinor(%q) unexpected error: %v", in, err)
			continue
		}
		if maj != want[0] || min != want[1] {
			t.Errorf("parseMajorMinor(%q) = (%d,%d), want (%d,%d)", in, maj, min, want[0], want[1])
		}
	}
	for _, bad := range []string{"", "1", "dev", "x.y.z", "1.x"} {
		if _, _, err := parseMajorMinor(bad); err == nil {
			t.Errorf("parseMajorMinor(%q) expected error, got nil", bad)
		}
	}
}

func TestParsePatch(t *testing.T) {
	ok := map[string]int{
		"1.2.3":      3,
		"1.2":        0, // absent patch → 0
		"1.2.0-rc1":  0,
		"1.2.5+meta": 5,
	}
	for in, want := range ok {
		got, err := parsePatch(in)
		if err != nil {
			t.Errorf("parsePatch(%q) unexpected error: %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("parsePatch(%q) = %d, want %d", in, got, want)
		}
	}
	if _, err := parsePatch("1.2.x"); err == nil {
		t.Errorf("parsePatch(1.2.x) expected error, got nil")
	}
}

// TestCrossesThreshold covers the run-kit row's LOCAL notable evaluation — the
// only threshold evaluation left in this package (siblings arrive
// pre-evaluated by shll).
func TestCrossesThreshold(t *testing.T) {
	cases := []struct {
		installed, latest, notify string
		want                      bool
		note                      string
	}{
		{"0.5.3", "0.6.0", notifyNever, false, "never never matches"},
		{"0.5.3", "0.6.0", notifyMinor, true, "minor bump under minor matches"},
		{"0.5.3", "1.0.0", notifyMinor, true, "major bump under minor matches"},
		{"0.5.3", "0.5.9", notifyMinor, false, "patch bump under minor does NOT match"},
		{"0.5.3", "0.5.3", notifyMinor, false, "equal under minor does not match"},
		{"0.5.3", "0.5.9", notifyPatch, true, "patch bump under patch matches"},
		{"0.5.3", "0.6.0", notifyPatch, true, "minor bump under patch matches"},
		{"0.5.3", "1.0.0", notifyPatch, true, "major bump under patch matches"},
		{"0.5.3", "0.5.3", notifyPatch, false, "equal under patch does not match"},
		{"0.5.3", "0.5.2", notifyPatch, false, "older patch under patch does not match"},
		{"0.6.0", "0.5.9", notifyMinor, false, "older minor under minor does not match"},
		{"0.5.3", "vbad", notifyMinor, false, "unparseable latest never matches"},
		{"bad", "0.6.0", notifyPatch, false, "unparseable installed never matches"},
		{"0.5.3", "0.6.0", "banana", false, "unknown notify value fails closed"},
	}
	for _, c := range cases {
		if got := crossesThreshold(normalizeTag(c.installed), normalizeTag(c.latest), c.notify); got != c.want {
			t.Errorf("crossesThreshold(%q,%q,%q) = %v, want %v (%s)", c.installed, c.latest, c.notify, got, c.want, c.note)
		}
	}
}

func TestComputeKey(t *testing.T) {
	// Composite key = sorted "tool@latest" pairs, comma-joined. Sorts by the
	// joined pair (tool name first), NOT by roster order.
	matched := []ToolUpdate{
		{Tool: "run-kit", Installed: "3.8.0", Latest: "3.9.0"},
		{Tool: "fab-kit", Installed: "2.16.0", Latest: "2.17.0"},
	}
	if got, want := computeKey(matched), "fab-kit@2.17.0,run-kit@3.9.0"; got != want {
		t.Errorf("computeKey = %q, want %q", got, want)
	}
	if got := computeKey(nil); got != "" {
		t.Errorf("computeKey(nil) = %q, want empty", got)
	}
}

func TestNewSuppressesDevAndUnparseable(t *testing.T) {
	for _, v := range []string{"dev", "not-a-version", ""} {
		c := New(v, true)
		if !c.Suppressed() {
			t.Errorf("New(%q) expected suppressed=true", v)
		}
		if len(c.Snapshot().Matched) != 0 {
			t.Errorf("New(%q) snapshot should never match", v)
		}
	}
	c := New("0.5.3", true)
	if c.Suppressed() {
		t.Errorf("New(0.5.3) should not be suppressed")
	}
}

// TestVendoredContractFixture parses the vendored `shll check-updates --json`
// contract fixture (schema 1, released backend) and verifies the decoder tolerates
// unknown fields and preserves per-tool verdicts verbatim.
func TestVendoredContractFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "check-updates.json"))
	if err != nil {
		t.Fatalf("read vendored fixture: %v", err)
	}
	var report CheckReport
	if err := json.Unmarshal(raw, &report); err != nil {
		t.Fatalf("vendored fixture must decode (unknown fields tolerated): %v", err)
	}
	if report.Schema != checkUpdatesSchema {
		t.Errorf("fixture schema = %d, want %d", report.Schema, checkUpdatesSchema)
	}
	if report.Source != "released" {
		t.Errorf("fixture source = %q, want released", report.Source)
	}
	if len(report.Tools) != 4 {
		t.Fatalf("fixture tools = %d, want 4", len(report.Tools))
	}
	byName := map[string]CheckTool{}
	for _, tool := range report.Tools {
		byName[tool.Name] = tool
	}
	// The tool carrying an unknown sibling field still decodes its known fields.
	fk := byName["fab-kit"]
	if fk.Installed != "2.16.0" || fk.Latest != "2.17.0" || !fk.UpdateAvailable || !fk.Notable {
		t.Errorf("fab-kit row decoded wrong: %+v", fk)
	}
	// The sub-threshold row keeps its split verdict.
	tu := byName["tu"]
	if !tu.UpdateAvailable || tu.Notable {
		t.Errorf("tu row = %+v, want update_available && !notable", tu)
	}
}

// fixtureReport loads the vendored contract fixture as the check seam's return
// value — the representative report used across the verdict tests.
// run-kit=notable minor bump, fab-kit=notable, tu=sub-threshold patch, wt=current.
func fixtureReport(t *testing.T) CheckReport {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "check-updates.json"))
	if err != nil {
		t.Fatalf("read vendored fixture: %v", err)
	}
	var report CheckReport
	if err := json.Unmarshal(raw, &report); err != nil {
		t.Fatalf("decode vendored fixture: %v", err)
	}
	return report
}

// checkerWith wires a checker with a stubbed check exec, then leaves it to the
// caller to run a synchronous pass. current = running run-kit version.
func checkerWith(t *testing.T, current string, selfBrew bool, report CheckReport) *Checker {
	t.Helper()
	c := New(current, selfBrew)
	c.SetCheckForTest(func(string) (CheckReport, error) { return report, nil })
	return c
}

// TestVerdictsRunKitRowLocalComparison verifies the run-kit row is compared
// against the RUNNING ldflags version (not shll's brew-visible installed),
// producing BOTH verdicts, and honors the brew-install self-gate.
func TestVerdictsRunKitRowLocalComparison(t *testing.T) {
	// Fixture says installed 3.8.0 → 3.9.0, but the daemon RUNS 3.8.1: the
	// verdict must carry 3.8.1 and still be notable (minor bump).
	c := checkerWith(t, "3.8.1", true, fixtureReport(t))
	c.CheckOnceForTest()
	snap := c.Snapshot()
	rk := findVerdict(snap.Tools, "run-kit")
	if rk == nil {
		t.Fatalf("run-kit verdict missing, tools=%v", snap.Tools)
	}
	if rk.Installed != "3.8.1" || rk.Latest != "3.9.0" {
		t.Errorf("run-kit verdict versions = (%q,%q), want (3.8.1,3.9.0) — must use the RUNNING version", rk.Installed, rk.Latest)
	}
	if !rk.UpdateAvailable || !rk.Notable {
		t.Errorf("run-kit verdict flags = (ua=%v,notable=%v), want both true", rk.UpdateAvailable, rk.Notable)
	}
	if snap.Current != "3.8.1" || snap.Latest != "3.9.0" {
		t.Errorf("legacy fields = (%q,%q), want (3.8.1,3.9.0)", snap.Current, snap.Latest)
	}

	// A go-install/dev rk (selfBrew=false) must omit its own row entirely.
	c2 := checkerWith(t, "3.8.1", false, fixtureReport(t))
	c2.CheckOnceForTest()
	if findVerdict(c2.Snapshot().Tools, "run-kit") != nil {
		t.Errorf("non-brew run-kit must not list its own row")
	}
	if hasTool(c2.Snapshot().Matched, "run-kit") {
		t.Errorf("non-brew run-kit must not self-match")
	}
}

// TestVerdictsHexokitSelfRow verifies the self row is recognized under the
// roster name shll >= v0.1.34 reports (`hexokit`). shll's own verdict on the row
// is deliberately wrong (update_available/notable false against a lagging
// brew-visible version) so a sibling-branch fallthrough would drop the row.
func TestVerdictsHexokitSelfRow(t *testing.T) {
	report := CheckReport{Schema: 1, Source: "released", Tools: []CheckTool{
		{Name: "hexokit", Formula: "sahil87/tap/hexokit", Installed: "3.9.0", Latest: "3.9.0", Notify: "minor", UpdateAvailable: false, Notable: false},
		{Name: "fab-kit", Formula: "fab-kit", Installed: "2.17.0", Latest: "2.17.0", Notify: "minor"},
	}}
	// brew already carries 3.9.0 but the daemon still RUNS 3.8.1.
	c := checkerWith(t, "3.8.1", true, report)
	c.CheckOnceForTest()
	snap := c.Snapshot()
	hk := findVerdict(snap.Tools, "hexokit")
	if hk == nil {
		t.Fatalf("hexokit self verdict missing, tools=%v", snap.Tools)
	}
	if hk.Installed != "3.8.1" || hk.Latest != "3.9.0" {
		t.Errorf("hexokit verdict versions = (%q,%q), want (3.8.1,3.9.0) — must use the RUNNING version", hk.Installed, hk.Latest)
	}
	if !hk.UpdateAvailable || !hk.Notable {
		t.Errorf("hexokit verdict flags = (ua=%v,notable=%v), want both true (local comparison)", hk.UpdateAvailable, hk.Notable)
	}
	if snap.Current != "3.8.1" || snap.Latest != "3.9.0" {
		t.Errorf("legacy fields = (%q,%q), want (3.8.1,3.9.0)", snap.Current, snap.Latest)
	}
	if snap.Key != "hexokit@3.9.0" {
		t.Errorf("Key = %q, want hexokit@3.9.0 (the name shll reported)", snap.Key)
	}

	// The brew-install gate holds under the new name: a non-brew binary omits
	// its own row even when shll's row claims an update.
	gated := CheckReport{Schema: 1, Tools: []CheckTool{
		{Name: "hexokit", Installed: "3.8.0", Latest: "3.9.0", Notify: "minor", UpdateAvailable: true, Notable: true},
	}}
	c2 := checkerWith(t, "3.8.1", false, gated)
	c2.CheckOnceForTest()
	if v := findVerdict(c2.Snapshot().Tools, "hexokit"); v != nil {
		t.Errorf("non-brew hexokit must not list its own row, got %+v", v)
	}
	if hasTool(c2.Snapshot().Matched, "hexokit") {
		t.Errorf("non-brew hexokit must not self-match")
	}
}

// TestIsSelfTool covers the primary roster name plus the legacy names older
// shll releases report for the same row.
func TestIsSelfTool(t *testing.T) {
	for name, want := range map[string]bool{
		"hexokit":   true,
		"run-kit":   true,
		"rk":        true,
		"fab-kit":   false,
		"shll":      false,
		"":          false,
		"hexokit-x": false,
		"Hexokit":   false,
	} {
		if got := isSelfTool(name); got != want {
			t.Errorf("isSelfTool(%q) = %v, want %v", name, got, want)
		}
	}
}

// TestVerdictsRunKitSubThreshold verifies the local comparison produces the
// split verdict: a patch bump under notify:minor is update_available but NOT
// notable — it rides Tools but never Matched/Key.
func TestVerdictsRunKitSubThreshold(t *testing.T) {
	report := CheckReport{Schema: 1, Tools: []CheckTool{
		{Name: "run-kit", Formula: "run-kit", Installed: "3.8.0", Latest: "3.8.2", Notify: "minor", UpdateAvailable: true, Notable: false},
	}}
	c := checkerWith(t, "3.8.1", true, report)
	c.CheckOnceForTest()
	snap := c.Snapshot()
	rk := findVerdict(snap.Tools, "run-kit")
	if rk == nil {
		t.Fatalf("run-kit sub-threshold verdict missing, tools=%v", snap.Tools)
	}
	if !rk.UpdateAvailable || rk.Notable {
		t.Errorf("run-kit verdict flags = (ua=%v,notable=%v), want (true,false)", rk.UpdateAvailable, rk.Notable)
	}
	if len(snap.Matched) != 0 || snap.Key != "" {
		t.Errorf("sub-threshold run-kit must not match: matched=%v key=%q", snap.Matched, snap.Key)
	}

	// At latest (running 3.8.2 == latest): no row at all.
	c2 := checkerWith(t, "3.8.2", true, report)
	c2.CheckOnceForTest()
	if len(c2.Snapshot().Tools) != 0 {
		t.Errorf("run-kit at latest must list no verdict, got %v", c2.Snapshot().Tools)
	}
}

// TestVerdictsSiblingsTrustedVerbatim verifies sibling verdicts pass through
// unchanged (no local re-evaluation) and up-to-date tools are omitted.
func TestVerdictsSiblingsTrustedVerbatim(t *testing.T) {
	c := checkerWith(t, "3.9.0", true, fixtureReport(t)) // run-kit at latest
	c.CheckOnceForTest()
	snap := c.Snapshot()

	fk := findVerdict(snap.Tools, "fab-kit")
	if fk == nil || !fk.UpdateAvailable || !fk.Notable {
		t.Errorf("fab-kit verdict = %+v, want verbatim update_available+notable", fk)
	}
	tu := findVerdict(snap.Tools, "tu")
	if tu == nil || !tu.UpdateAvailable || tu.Notable {
		t.Errorf("tu verdict = %+v, want verbatim update_available && !notable", tu)
	}
	if findVerdict(snap.Tools, "wt") != nil {
		t.Errorf("up-to-date wt must be omitted from the verdict list")
	}
	if findVerdict(snap.Tools, "run-kit") != nil {
		t.Errorf("run-kit at latest must be omitted")
	}

	// Notable projection: fab-kit only (tu is sub-threshold).
	if len(snap.Matched) != 1 || snap.Matched[0].Tool != "fab-kit" {
		t.Errorf("Matched = %v, want [fab-kit]", snap.Matched)
	}
	if snap.Key != "fab-kit@2.17.0" {
		t.Errorf("Key = %q, want fab-kit@2.17.0 (notable set only)", snap.Key)
	}
	// run-kit absent from the match set → legacy fields empty.
	if snap.Current != "" || snap.Latest != "" {
		t.Errorf("legacy fields should be empty when run-kit unmatched, got (%q,%q)", snap.Current, snap.Latest)
	}
}

// TestVerdictsSortedOrder verifies the verdict list is deterministic
// sorted-name order regardless of report order.
func TestVerdictsSortedOrder(t *testing.T) {
	report := CheckReport{Schema: 1, Tools: []CheckTool{
		{Name: "tu", Installed: "0.9.1", Latest: "0.9.2", UpdateAvailable: true, Notable: false},
		{Name: "run-kit", Installed: "3.8.0", Latest: "3.9.0", Notify: "minor", UpdateAvailable: true, Notable: true},
		{Name: "fab-kit", Installed: "2.16.0", Latest: "2.17.0", UpdateAvailable: true, Notable: true},
	}}
	c := checkerWith(t, "3.8.0", true, report)
	c.CheckOnceForTest()
	snap := c.Snapshot()
	var names []string
	for _, v := range snap.Tools {
		names = append(names, v.Tool)
	}
	want := []string{"fab-kit", "run-kit", "tu"}
	if len(names) != len(want) {
		t.Fatalf("verdict names = %v, want %v", names, want)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Errorf("verdict order[%d] = %q, want %q", i, names[i], want[i])
		}
	}
	if snap.Key != "fab-kit@2.17.0,run-kit@3.9.0" {
		t.Errorf("Key = %q, want fab-kit@2.17.0,run-kit@3.9.0", snap.Key)
	}
}

// TestCheckOnceFiresOnKeyChange drives the OnQualify contract: fire on first
// non-empty key, re-fire on a changed key, no re-fire on an unchanged key.
func TestCheckOnceFiresOnKeyChange(t *testing.T) {
	c := New("3.8.0", true)
	c.SetSelfBrewForTest(true)

	var latest string
	c.SetCheckForTest(func(string) (CheckReport, error) {
		return CheckReport{Schema: 1, Tools: []CheckTool{
			{Name: "run-kit", Latest: latest, Notify: "minor", Formula: "run-kit"},
		}}, nil
	})

	var mu sync.Mutex
	var keys []string
	c.OnQualify = func(r Result) {
		mu.Lock()
		keys = append(keys, r.Key)
		mu.Unlock()
	}

	// 1) 3.9.0 → first non-empty key, fires.
	latest = "3.9.0"
	c.CheckOnceForTest()
	// 2) unchanged key → no re-fire.
	c.CheckOnceForTest()
	// 3) 3.10.0 → key changes, re-fires.
	latest = "3.10.0"
	c.CheckOnceForTest()

	mu.Lock()
	defer mu.Unlock()
	want := []string{"run-kit@3.9.0", "run-kit@3.10.0"}
	if len(keys) != len(want) {
		t.Fatalf("OnQualify fired %d times, want %d (%v)", len(keys), len(want), keys)
	}
	for i := range want {
		if keys[i] != want[i] {
			t.Errorf("OnQualify call %d key = %q, want %q", i, keys[i], want[i])
		}
	}
}

// TestCheckOnceClearThenReMatchRefires verifies a match → clear → re-match
// sequence fires on EVERY key change (R7): the first match, the clear-to-empty
// (a first-class cleared-verdict fire — the consumed-match clear), and the
// re-match. The cleared fire carries an empty key + empty matched set.
func TestCheckOnceClearThenReMatchRefires(t *testing.T) {
	c := New("3.8.0", true)
	c.SetSelfBrewForTest(true)

	var latest string
	c.SetCheckForTest(func(string) (CheckReport, error) {
		return CheckReport{Schema: 1, Tools: []CheckTool{
			{Name: "run-kit", Latest: latest, Notify: "minor", Formula: "run-kit"},
		}}, nil
	})
	var mu sync.Mutex
	var fired []Result
	c.OnQualify = func(r Result) {
		mu.Lock()
		fired = append(fired, r)
		mu.Unlock()
	}

	latest = "3.9.0" // match → fire (non-empty key)
	c.CheckOnceForTest()
	latest = "3.8.0" // back to installed → key clears → fire (empty key, R7)
	c.CheckOnceForTest()
	latest = "3.9.0" // re-match → fire (non-empty key)
	c.CheckOnceForTest()

	mu.Lock()
	defer mu.Unlock()
	if len(fired) != 3 {
		t.Fatalf("OnQualify fired %d times, want 3 (match + clear + re-match), keys=%v", len(fired), firedKeys(fired))
	}
	if fired[0].Key != "run-kit@3.9.0" {
		t.Errorf("fire 0 key = %q, want run-kit@3.9.0", fired[0].Key)
	}
	// The cleared verdict: empty key AND empty matched set (first-class R7 fire).
	if fired[1].Key != "" || len(fired[1].Matched) != 0 {
		t.Errorf("fire 1 (clear) = {Key:%q, Matched:%v}, want empty key + empty matched", fired[1].Key, fired[1].Matched)
	}
	if fired[2].Key != "run-kit@3.9.0" {
		t.Errorf("fire 2 key = %q, want run-kit@3.9.0", fired[2].Key)
	}
	if c.Snapshot().Key != "run-kit@3.9.0" {
		t.Errorf("final key = %q, want run-kit@3.9.0", c.Snapshot().Key)
	}
}

// TestCheckOnceEmptyToEmptyNoFire verifies the R7 no-fire boundary: an unchanged
// EMPTY key across two checks (nothing ever matched) must NOT fire — only a key
// CHANGE fires, and empty→empty is not a change.
func TestCheckOnceEmptyToEmptyNoFire(t *testing.T) {
	c := New("3.9.0", true) // already at latest — nothing matches
	c.SetSelfBrewForTest(true)
	c.SetCheckForTest(func(string) (CheckReport, error) {
		return CheckReport{Schema: 1, Tools: []CheckTool{
			{Name: "run-kit", Latest: "3.9.0", Notify: "minor", Formula: "run-kit"},
		}}, nil
	})
	fires := 0
	c.OnQualify = func(Result) { fires++ }

	c.CheckOnceForTest() // empty → empty (never fired before)
	c.CheckOnceForTest() // empty → empty again
	if fires != 0 {
		t.Errorf("OnQualify fired %d times on empty→empty, want 0", fires)
	}
}

// TestCheckOncePatchOnlyKeyStaysEmpty verifies a sub-threshold-only verdict
// (update_available, nothing notable) keeps the key empty and never fires —
// a patch-only finding is toast-only by policy, not a chip/broadcast event.
func TestCheckOncePatchOnlyKeyStaysEmpty(t *testing.T) {
	report := CheckReport{Schema: 1, Tools: []CheckTool{
		{Name: "tu", Installed: "0.9.1", Latest: "0.9.2", UpdateAvailable: true, Notable: false},
	}}
	c := checkerWith(t, "3.9.0", true, report)
	fires := 0
	c.OnQualify = func(Result) { fires++ }
	c.CheckOnceForTest()
	snap := c.Snapshot()
	if len(snap.Tools) != 1 || snap.Tools[0].Tool != "tu" {
		t.Fatalf("Tools = %v, want [tu]", snap.Tools)
	}
	if snap.Key != "" || len(snap.Matched) != 0 {
		t.Errorf("patch-only verdict must keep Key/Matched empty, got key=%q matched=%v", snap.Key, snap.Matched)
	}
	if fires != 0 {
		t.Errorf("OnQualify fired %d times on a patch-only verdict, want 0", fires)
	}
}

// firedKeys is a debug helper: the Key of each recorded fire.
func firedKeys(rs []Result) []string {
	ks := make([]string, len(rs))
	for i, r := range rs {
		ks[i] = r.Key
	}
	return ks
}

// TestCheckOnceErrorRetainsResult verifies stale-while-revalidate: a failed
// check (exec error / unparseable output) leaves the previous verdict intact
// and does not fire OnQualify.
func TestCheckOnceErrorRetainsResult(t *testing.T) {
	c := checkerWith(t, "3.8.0", true, fixtureReport(t))
	c.CheckOnceForTest()
	seeded := c.Snapshot()
	if len(seeded.Matched) == 0 {
		t.Fatalf("precondition: seeded verdict should match, got %+v", seeded)
	}

	fired := false
	c.OnQualify = func(Result) { fired = true }
	c.SetCheckForTest(func(string) (CheckReport, error) { return CheckReport{}, errors.New("shll not found on PATH") })
	c.CheckOnceForTest()

	got := c.Snapshot()
	if got.Key != seeded.Key || len(got.Matched) != len(seeded.Matched) || len(got.Tools) != len(seeded.Tools) {
		t.Errorf("after check error: snapshot = %+v, want retained %+v", got, seeded)
	}
	if fired {
		t.Errorf("OnQualify should not fire on a check error")
	}
}

// TestCheckNowReturnsFreshVerdict verifies the manual seam: CheckNow runs an
// inline pass and returns the fresh verdict synchronously.
func TestCheckNowReturnsFreshVerdict(t *testing.T) {
	c := checkerWith(t, "3.8.0", true, fixtureReport(t))
	got, err := c.CheckNow(context.Background(), SourceReleased)
	if err != nil {
		t.Fatalf("CheckNow error: %v", err)
	}
	if got.Key != "fab-kit@2.17.0,run-kit@3.9.0" {
		t.Errorf("CheckNow key = %q, want fab-kit@2.17.0,run-kit@3.9.0", got.Key)
	}
	if len(got.Tools) != 3 { // run-kit + fab-kit notable, tu sub-threshold
		t.Errorf("CheckNow tools = %v, want 3 verdicts", got.Tools)
	}
	// The cached snapshot converges with the returned verdict (shared state).
	if snap := c.Snapshot(); snap.Key != got.Key {
		t.Errorf("snapshot key = %q, want %q (manual + ambient share one cache)", snap.Key, got.Key)
	}
}

// githubFixtureReport loads the vendored GITHUB contract fixture — the twin of
// check-updates.json for `shll check-updates --source github --json`: source
// "github", NO notify/notable fields on any row (no notify policy in that
// backend). run-kit=minor+patch bump, fab-kit=minor bump, wt=current.
func githubFixtureReport(t *testing.T) CheckReport {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "check-updates-github.json"))
	if err != nil {
		t.Fatalf("read vendored github fixture: %v", err)
	}
	var report CheckReport
	if err := json.Unmarshal(raw, &report); err != nil {
		t.Fatalf("decode vendored github fixture: %v", err)
	}
	return report
}

// TestVendoredGithubContractFixture parses the vendored github-backend fixture
// and verifies the no-notify contract decodes with zero-valued notify/notable
// on every row (unknown fields still tolerated).
func TestVendoredGithubContractFixture(t *testing.T) {
	report := githubFixtureReport(t)
	if report.Schema != checkUpdatesSchema {
		t.Errorf("github fixture schema = %d, want %d", report.Schema, checkUpdatesSchema)
	}
	if report.Source != "github" {
		t.Errorf("github fixture source = %q, want github", report.Source)
	}
	if len(report.Tools) != 3 {
		t.Fatalf("github fixture tools = %d, want 3", len(report.Tools))
	}
	for _, tool := range report.Tools {
		if tool.Notify != "" || tool.Notable {
			t.Errorf("github row %q = (notify=%q, notable=%v), want zero values — the github contract carries no notify policy", tool.Name, tool.Notify, tool.Notable)
		}
	}
	byName := map[string]CheckTool{}
	for _, tool := range report.Tools {
		byName[tool.Name] = tool
	}
	if fk := byName["fab-kit"]; fk.Installed != "2.16.0" || fk.Latest != "2.17.0" || !fk.UpdateAvailable {
		t.Errorf("fab-kit github row decoded wrong (unknown fields must be tolerated): %+v", fk)
	}
	if wt := byName["wt"]; wt.UpdateAvailable {
		t.Errorf("wt github row = %+v, want up to date", wt)
	}
}

// TestCheckNowGithubSideChannel verifies the load-bearing cache-isolation
// contract: a github-sourced CheckNow returns the computed verdict (all rows
// notable=false under the no-notify contract, Source echoed) but performs NO
// cache write and fires NO OnQualify — and a released check afterwards still
// caches and fires normally.
func TestCheckNowGithubSideChannel(t *testing.T) {
	released := fixtureReport(t)
	github := githubFixtureReport(t)

	c := New("3.8.0", true)
	c.SetCheckForTest(func(source string) (CheckReport, error) {
		if source == SourceGithub {
			return github, nil
		}
		return released, nil
	})
	fires := 0
	c.OnQualify = func(Result) { fires++ }

	// Seed the shared cache from the released path.
	c.CheckOnceForTest()
	seeded := c.Snapshot()
	if seeded.Key != "fab-kit@2.17.0,run-kit@3.9.0" || fires != 1 {
		t.Fatalf("precondition: seeded released verdict key=%q fires=%d", seeded.Key, fires)
	}

	// The github side-channel query.
	got, err := c.CheckNow(context.Background(), SourceGithub)
	if err != nil {
		t.Fatalf("github CheckNow error: %v", err)
	}
	if got.Source != "github" {
		t.Errorf("github Result.Source = %q, want github", got.Source)
	}
	// run-kit (3.8.0→3.9.1, notify "" fail-closed) + fab-kit — both non-notable.
	if len(got.Tools) != 2 {
		t.Fatalf("github verdicts = %v, want 2 (run-kit + fab-kit)", got.Tools)
	}
	for _, v := range got.Tools {
		if !v.UpdateAvailable || v.Notable {
			t.Errorf("github verdict %q = (ua=%v, notable=%v), want updateAvailable && !notable", v.Tool, v.UpdateAvailable, v.Notable)
		}
	}
	if got.Key != "" || len(got.Matched) != 0 {
		t.Errorf("github verdict must have empty notable set, got key=%q matched=%v", got.Key, got.Matched)
	}

	// NO cache write: the snapshot still carries the seeded released verdict.
	if snap := c.Snapshot(); snap.Key != seeded.Key || len(snap.Tools) != len(seeded.Tools) || snap.Source != seeded.Source {
		t.Errorf("github check must not touch the cache: snapshot = %+v, want retained %+v", snap, seeded)
	}
	// NO OnQualify fire for the side-channel pass.
	if fires != 1 {
		t.Errorf("OnQualify fired %d times, want still 1 — a github check must never broadcast", fires)
	}

	// A released check afterwards still converges the cache and fires on change.
	released.Tools[0].Latest = "3.10.0" // run-kit row → key change
	if _, err := c.CheckNow(context.Background(), SourceReleased); err != nil {
		t.Fatalf("released CheckNow error: %v", err)
	}
	if snap := c.Snapshot(); snap.Key != "fab-kit@2.17.0,run-kit@3.10.0" {
		t.Errorf("released re-check key = %q, want fab-kit@2.17.0,run-kit@3.10.0", snap.Key)
	}
	if fires != 2 {
		t.Errorf("OnQualify fired %d times, want 2 — the released path must still fire", fires)
	}
}

// TestCheckNowPassesSourceToSeam verifies the source rides the check-exec seam:
// the manual github pass hands SourceGithub to the seam, while CheckOnceForTest
// (the ambient stand-in) stays released.
func TestCheckNowPassesSourceToSeam(t *testing.T) {
	var seen []string
	c := New("3.8.0", true)
	c.SetCheckForTest(func(source string) (CheckReport, error) {
		seen = append(seen, source)
		return CheckReport{Schema: 1}, nil
	})

	c.CheckOnceForTest()
	if _, err := c.CheckNow(context.Background(), SourceGithub); err != nil {
		t.Fatalf("github CheckNow error: %v", err)
	}

	want := []string{SourceReleased, SourceGithub}
	if len(seen) != len(want) || seen[0] != want[0] || seen[1] != want[1] {
		t.Errorf("seam saw sources %v, want %v", seen, want)
	}
}

// TestCheckUpdatesArgs verifies the argv builder: the literal `--source github`
// pair is appended ONLY for the validated SourceGithub enum value — released
// keeps the flag-free argv byte-for-byte, and an unvalidated string never
// reaches argv (Constitution I).
func TestCheckUpdatesArgs(t *testing.T) {
	cases := []struct {
		source string
		want   []string
	}{
		{SourceReleased, []string{"check-updates", "--json"}},
		{SourceGithub, []string{"check-updates", "--json", "--source", "github"}},
		{"bogus; rm -rf /", []string{"check-updates", "--json"}},
	}
	for _, tc := range cases {
		got := checkUpdatesArgs(tc.source)
		if len(got) != len(tc.want) {
			t.Errorf("checkUpdatesArgs(%q) = %v, want %v", tc.source, got, tc.want)
			continue
		}
		for i := range tc.want {
			if got[i] != tc.want[i] {
				t.Errorf("checkUpdatesArgs(%q)[%d] = %q, want %q", tc.source, i, got[i], tc.want[i])
			}
		}
	}
}

// TestCheckNowSurfacesFailure verifies the fail-loud manual posture: a failed
// check returns the error (and retains the previous verdict).
func TestCheckNowSurfacesFailure(t *testing.T) {
	c := checkerWith(t, "3.8.0", true, fixtureReport(t))
	c.CheckOnceForTest()
	seededKey := c.Snapshot().Key

	c.SetCheckForTest(func(string) (CheckReport, error) { return CheckReport{}, errors.New("shll not found on PATH") })
	if _, err := c.CheckNow(context.Background(), SourceReleased); err == nil {
		t.Fatalf("CheckNow must surface the check failure")
	}
	if c.Snapshot().Key != seededKey {
		t.Errorf("failed CheckNow must retain the previous verdict")
	}
}

// TestCheckNowSuppressed verifies a suppressed checker refuses a manual check
// without running the seam.
func TestCheckNowSuppressed(t *testing.T) {
	c := New("dev", true)
	if _, err := c.CheckNow(context.Background(), SourceReleased); err == nil {
		t.Fatalf("CheckNow on a suppressed checker must error")
	}
}

// TestRecheckAfterRunsDelayedCheck verifies R17's checker trigger: after Start
// captures the daemon context, RecheckAfter schedules a single delayed check
// that re-runs the exec and fires OnQualify on the resulting key change.
func TestRecheckAfterRunsDelayedCheck(t *testing.T) {
	// Capture the scheduled (delay, fn) instead of waiting a real ~2min.
	var gotDelay time.Duration
	var scheduled func()
	orig := afterFuncFn
	afterFuncFn = func(d time.Duration, fn func()) { gotDelay = d; scheduled = fn }
	t.Cleanup(func() { afterFuncFn = orig })

	c := New("3.8.0", true)
	c.SetSelfBrewForTest(true)

	var latest string
	c.SetCheckForTest(func(string) (CheckReport, error) {
		return CheckReport{Schema: 1, Tools: []CheckTool{
			{Name: "run-kit", Latest: latest, Notify: "minor", Formula: "run-kit"},
		}}, nil
	})
	fires := 0
	c.OnQualify = func(Result) { fires++ }

	// Start captures the daemon context (Start is a no-op body beyond capture for
	// a non-suppressed checker until the initial delay elapses; we only need the
	// captured context here).
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.Start(ctx)

	// Simulate the post-remediation state: run-kit now behind latest.
	latest = "3.9.0"
	c.RecheckAfter(90 * time.Second)
	if scheduled == nil {
		t.Fatalf("RecheckAfter did not schedule anything")
	}
	if gotDelay != 90*time.Second {
		t.Errorf("scheduled delay = %v, want 90s", gotDelay)
	}
	// Run the scheduled re-check — it recomputes the verdict and fires.
	scheduled()
	if fires != 1 {
		t.Errorf("delayed re-check fired OnQualify %d times, want 1", fires)
	}
	if c.Snapshot().Key != "run-kit@3.9.0" {
		t.Errorf("post-recheck key = %q, want run-kit@3.9.0", c.Snapshot().Key)
	}
}

// TestRecheckAfterNoopBeforeStartAndSuppressed verifies RecheckAfter is a no-op
// before Start (no daemon context) and on a suppressed checker.
func TestRecheckAfterNoopBeforeStartAndSuppressed(t *testing.T) {
	scheduledCount := 0
	orig := afterFuncFn
	afterFuncFn = func(_ time.Duration, _ func()) { scheduledCount++ }
	t.Cleanup(func() { afterFuncFn = orig })

	// Before Start: no captured context → no-op.
	c := New("3.8.0", true)
	c.RecheckAfter(time.Minute)
	if scheduledCount != 0 {
		t.Errorf("RecheckAfter before Start scheduled %d times, want 0", scheduledCount)
	}

	// Suppressed checker: no-op even after Start.
	sc := New("dev", true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sc.Start(ctx) // suppressed — returns without launching the poll goroutine
	sc.RecheckAfter(time.Minute)
	if scheduledCount != 0 {
		t.Errorf("RecheckAfter on a suppressed checker scheduled %d times, want 0", scheduledCount)
	}
}

// TestStartSuppressedIsNoop verifies a suppressed checker's Start never calls
// the check seam.
func TestStartSuppressedIsNoop(t *testing.T) {
	c := New("dev", true)
	called := false
	c.checkFn = func(ctx context.Context, source string) (CheckReport, error) {
		called = true
		return fixtureReport(t), nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	c.Start(ctx)
	<-ctx.Done()
	if called {
		t.Errorf("suppressed checker must not run the check")
	}
}

func hasTool(matched []ToolUpdate, tool string) bool {
	for _, m := range matched {
		if m.Tool == tool {
			return true
		}
	}
	return false
}

func findVerdict(tools []ToolVerdict, tool string) *ToolVerdict {
	for i := range tools {
		if tools[i].Tool == tool {
			return &tools[i]
		}
	}
	return nil
}

// TestAnyIncreaseExported locks the exported AnyIncrease wrapper (consumed by
// internal/desktop's update comparison) to the unexported anyIncrease semantics:
// any major/minor/patch increase qualifies; equal, downgrade, and unparseable
// inputs never do.
func TestAnyIncreaseExported(t *testing.T) {
	cases := []struct {
		installed, latest string
		want              bool
	}{
		{"3.12.2", "3.13.0", true},
		{"3.12.2", "3.12.3", true},
		{"3.12.2", "4.0.0", true},
		{"3.12.2", "3.12.2", false},
		{"3.13.0", "3.12.2", false},
		{"garbage", "3.12.2", false},
		{"3.12.2", "garbage", false},
	}
	for _, tc := range cases {
		if got := AnyIncrease(tc.installed, tc.latest); got != tc.want {
			t.Errorf("AnyIncrease(%q, %q) = %v, want %v", tc.installed, tc.latest, got, tc.want)
		}
	}
}
