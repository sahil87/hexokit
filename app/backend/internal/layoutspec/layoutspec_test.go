package layoutspec

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// mustParse parses a fixture input that the table expects to succeed.
func mustParse(t *testing.T, raw string) Node {
	t.Helper()
	n, err := Parse(raw)
	if err != nil {
		t.Fatalf("Parse(%q): %v", raw, err)
	}
	return n
}

// ── shared fixture table (pins TS/Go parity) ────────────────────────────────

// fixtureFile mirrors app/frontend/src/lib/layout-tree.fixtures.json: the
// parse table (input → expected serialized tree, null = Parse must error) and
// the verb table (expect null = the verb must return an error; promote and
// cycle never error). The TS suite reads the same file, so the two ports
// cannot drift.
type fixtureFile struct {
	Parse []struct {
		Input  string  `json:"input"`
		Expect *string `json:"expect"`
	} `json:"parse"`
	Verbs []struct {
		Verb   string  `json:"verb"`
		Start  string  `json:"start"`
		Kind   string  `json:"kind"`
		ID     string  `json:"id"`
		Name   string  `json:"name"`
		Expect *string `json:"expect"`
	} `json:"verbs"`
}

func readFixtures(t *testing.T) fixtureFile {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "frontend", "src", "lib", "layout-tree.fixtures.json"))
	if err != nil {
		t.Fatalf("read shared fixture table: %v", err)
	}
	var f fixtureFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("decode shared fixture table: %v", err)
	}
	return f
}

// grammarFixtures mirrors app/frontend/src/lib/layout-grammar.fixtures.json:
// the leaf-grammar accept/reject corpus. accept = Parse succeeds AND
// ValidateFor passes with owner ("" = no owner supplied); expect is the
// serialized form of an accepted parse. The Vitest suite reads the same file.
type grammarFixtures struct {
	Grammar []struct {
		Input  string `json:"input"`
		Accept bool   `json:"accept"`
		Owner  string `json:"owner"`
		Expect string `json:"expect"`
	} `json:"grammar"`
}

func readGrammarFixtures(t *testing.T) grammarFixtures {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "frontend", "src", "lib", "layout-grammar.fixtures.json"))
	if err != nil {
		t.Fatalf("read shared grammar corpus: %v", err)
	}
	var f grammarFixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("decode shared grammar corpus: %v", err)
	}
	return f
}

func TestGrammarCorpus(t *testing.T) {
	for _, tc := range readGrammarFixtures(t).Grammar {
		n, err := Parse(tc.Input)
		ok := err == nil && ValidateFor(n, tc.Owner) == nil
		if ok != tc.Accept {
			t.Errorf("grammar %q (owner %q): accept = %v, want %v (parse err: %v)", tc.Input, tc.Owner, ok, tc.Accept, err)
			continue
		}
		if tc.Accept && err == nil {
			if got := n.String(); got != tc.Expect {
				t.Errorf("grammar %q.String() = %q, want %q", tc.Input, got, tc.Expect)
			}
		}
	}
}

func TestFixtureParseTable(t *testing.T) {
	for _, tc := range readFixtures(t).Parse {
		n, err := Parse(tc.Input)
		if tc.Expect == nil {
			if err == nil {
				t.Errorf("Parse(%q) = %q, want rejection", tc.Input, n)
			}
			continue
		}
		if err != nil {
			t.Errorf("Parse(%q): %v, want %q", tc.Input, err, *tc.Expect)
			continue
		}
		if got := n.String(); got != *tc.Expect {
			t.Errorf("Parse(%q).String() = %q, want %q", tc.Input, got, *tc.Expect)
		}
	}
}

func TestFixtureVerbTable(t *testing.T) {
	for _, tc := range readFixtures(t).Verbs {
		start := mustParse(t, tc.Start)
		var (
			got string
			err error
		)
		switch tc.Verb {
		case "add":
			var next Node
			next, err = Add(start, tc.Kind)
			got = next.String()
		case "close":
			var next Node
			next, err = Close(start, tc.ID)
			got = next.String()
		case "template":
			var next Node
			next, err = SetTemplate(start, tc.Name)
			got = next.String()
		case "promote":
			got = Promote(start, tc.ID).String()
		case "cycle":
			got = Cycle(start).String()
		default:
			t.Fatalf("fixture verb %q unknown to the Go port", tc.Verb)
		}
		label := tc.Verb + " " + tc.Start
		if tc.Expect == nil {
			if err == nil {
				t.Errorf("%s = %q, want an error", label, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v, want %q", label, err, *tc.Expect)
			continue
		}
		if got != *tc.Expect {
			t.Errorf("%s = %q, want %q", label, got, *tc.Expect)
		}
	}
}

// ── grammars ────────────────────────────────────────────────────────────────

func TestParseTreeGrammarRoundTrips(t *testing.T) {
	for _, raw := range []string{
		"tty", "gui",
		"h(tty,web)", "v(tty,web)",
		"h(tty,code,web)", "v(tty,code,web)",
		"h(tty,v(code,web))", "h(v(code,web),tty)",
		"v(tty,h(code,web))", "v(h(code,web),tty)",
		"h(tty,tty)", "h(tty,v(tty,tty))",
		"@12/tty", "@3/web",
		"h(tty,v(@12/tty,web))", "h(web,@12/web)",
		"h(tty,web,code,gui)",
		"v(h(tty,code,web),h(@3/tty,@4/tty,@5/code))",
	} {
		if got := mustParse(t, raw).String(); got != raw {
			t.Errorf("Parse(%q).String() = %q, want byte-identical round-trip", raw, got)
		}
	}
}

// The legacy preset → tree conversion table (spec § The Model), byte-exact.
func TestParseLegacyTable(t *testing.T) {
	table := map[string]string{
		"single:tty":              "tty",
		"single:code":             "code",
		"split-h:tty,web":         "h(tty,web)",
		"split-v:tty,web":         "v(tty,web)",
		"row:tty,code,web":        "h(tty,code,web)",
		"col:tty,code,web":        "v(tty,code,web)",
		"main-left:tty,code,web":  "h(tty,v(code,web))",
		"main-right:tty,code,web": "h(v(code,web),tty)",
		"main-top:tty,code,web":   "v(tty,h(code,web))",
	}
	for raw, want := range table {
		if got := mustParse(t, raw).String(); got != want {
			t.Errorf("Parse(%q).String() = %q, want %q", raw, got, want)
		}
	}
}

func TestParseRejections(t *testing.T) {
	for _, raw := range []string{
		// non-canonical trees
		"h(h(tty,web),code)", // same-direction nesting
		"v(v(tty,web))",      // single-child split, nested
		"h(tty)",             // single-child split
		// repeated non-tty bare kind
		"h(web,web)", "main-left:tty,code,code", "split-h:code,code",
		// whitespace, truncation, trailing input
		"h( tty,web)", "h(tty,web", "h(tty,web)x", "",
		// legacy arity / unknown shape / unknown surface / foreign legacy leaf
		"single:tty,web", "row:tty,web", "grid:tty,code", "single:desktop",
		"split-h:tty,@3/tty",
		// not a layout at all
		"foo", "main-bottom:tty,code,web",
	} {
		if n, err := Parse(raw); err == nil {
			t.Errorf("Parse(%q) = %q, want rejection", raw, n)
		}
	}
}

// The input cap fires before the recursive descent, so a deeply nested
// (attacker-controlled) value is rejected by length instead of exhausting the
// stack.
func TestParseRejectsOverLengthInput(t *testing.T) {
	deep := strings.Repeat("h(", 300) + "tty" + strings.Repeat(")", 300)
	if len(deep) <= MaxLayoutLen {
		t.Fatalf("test input is %d bytes, want > MaxLayoutLen (%d)", len(deep), MaxLayoutLen)
	}
	if n, err := Parse(deep); err == nil {
		t.Errorf("Parse(%d-byte deep tree) = %q, want rejection by the input cap", len(deep), n.String())
	}
	// A 513-byte input is rejected by length alone, never reaching the parser.
	atCap := strings.Repeat("h(", 169) + "tty" + strings.Repeat(")", 169)
	if len(atCap) > MaxLayoutLen {
		t.Fatalf("test input is %d bytes, want ≤ MaxLayoutLen (%d)", len(atCap), MaxLayoutLen)
	}
	over := atCap + strings.Repeat(")", MaxLayoutLen+1-len(atCap))
	if len(over) != MaxLayoutLen+1 {
		t.Fatalf("test input is %d bytes, want exactly %d", len(over), MaxLayoutLen+1)
	}
	if n, err := Parse(over); err == nil {
		t.Errorf("Parse(%d-byte input) = %q, want rejection by the input cap", len(over), n.String())
	}
}

// No tile-count cap remains: a canonical 6-leaf tree parses.
func TestParseSixLeafTree(t *testing.T) {
	raw := "v(h(tty,code,web),h(@3/tty,@4/tty,@5/code))"
	n := mustParse(t, raw)
	if got := n.String(); got != raw {
		t.Errorf("Parse(%q).String() = %q, want round-trip", raw, got)
	}
	if err := ValidateFor(n, "@9"); err != nil {
		t.Errorf("ValidateFor(%q, @9): %v", raw, err)
	}
}

func TestParseDuplicateTtyLegal(t *testing.T) {
	n := mustParse(t, "split-h:tty,tty")
	if got := n.String(); got != "h(tty,tty)" {
		t.Errorf("Parse(split-h:tty,tty).String() = %q", got)
	}
	if got := n.LeafIDs(); !reflect.DeepEqual(got, []string{"tty", "tty#2"}) {
		t.Errorf("LeafIDs(h(tty,tty)) = %v, want [tty tty#2]", got)
	}
}

// The owner rule is the write-path half of validation: Parse has no owner, so
// a self-naming foreign leaf parses and only ValidateFor rejects it.
func TestValidateForOwnerRules(t *testing.T) {
	table := []struct {
		raw   string
		owner string
		want  bool
	}{
		{"h(tty,@7/tty)", "@7", false}, // a foreign leaf naming the owner
		{"h(tty,@7/tty)", "@9", true},  // …but only for that owner
		{"h(tty,tty,@12/tty)", "@7", true},
		{"h(tty,@7/tty)", "", true},    // no owner supplied: rule skipped
		{"h(web,@12/web)", "@9", true}, // bare kind + foreign same kind coexist
	}
	for _, tc := range table {
		n := mustParse(t, tc.raw)
		if err := ValidateFor(n, tc.owner); (err == nil) != tc.want {
			t.Errorf("ValidateFor(%q, %q): err = %v, want valid = %v", tc.raw, tc.owner, err, tc.want)
		}
	}
}

func TestLeafIDAddresses(t *testing.T) {
	n := mustParse(t, "h(tty,@12/tty)")
	if got := n.LeafIDs(); !reflect.DeepEqual(got, []string{"tty", "@12/tty"}) {
		t.Errorf("LeafIDs(h(tty,@12/tty)) = %v, want [tty @12/tty]", got)
	}
	// Duplicate bare kinds number among the bare leaves only.
	n = mustParse(t, "h(tty,tty,@3/tty,@4/tty)")
	if got := n.LeafIDs(); !reflect.DeepEqual(got, []string{"tty", "tty#2", "@3/tty", "@4/tty"}) {
		t.Errorf("LeafIDs = %v, want [tty tty#2 @3/tty @4/tty]", got)
	}
}

func TestRemoveOrTTYAddressIDs(t *testing.T) {
	out, ok := RemoveOrTTY(mustParse(t, "h(tty,@12/tty)"), "@12/tty")
	if !ok || out.String() != "tty" {
		t.Errorf("RemoveOrTTY(h(tty,@12/tty), @12/tty) = %q, %v, want tty", out, ok)
	}
	if n, ok := RemoveOrTTY(mustParse(t, "h(tty,@12/tty)"), "@99/tty"); ok || n.String() != "h(tty,@12/tty)" {
		t.Errorf("RemoveOrTTY of an absent address = %q, %v, want unchanged, false", n, ok)
	}
	// Removing the last leaf drains the tree: the bare-tty fallback (a layout
	// never renders empty).
	out, ok = RemoveOrTTY(mustParse(t, "@12/tty"), "@12/tty")
	if !ok || out.String() != "tty" {
		t.Errorf("RemoveOrTTY draining the tree = %q, %v, want tty", out, ok)
	}
	if n, ok := RemoveOrTTY(mustParse(t, "h(tty,web)"), "code"); ok || n.String() != "h(tty,web)" {
		t.Errorf("RemoveOrTTY of an absent leaf = %q, %v, want unchanged, false", n, ok)
	}
}

func TestParseLeafAddress(t *testing.T) {
	home, kind, ok := ParseLeafAddress("@12/tty")
	if !ok || home != "@12" || kind != "tty" {
		t.Errorf("ParseLeafAddress(@12/tty) = %q, %q, %v", home, kind, ok)
	}
	for _, raw := range []string{"tty", "@12", "@x/tty", "@/tty", "@12/foo", "@12/tty/2", ""} {
		if home, kind, ok := ParseLeafAddress(raw); ok {
			t.Errorf("ParseLeafAddress(%q) = %q, %q, true, want false", raw, home, kind)
		}
	}
	// gui parses as an address — its rejection lives in validation.
	if _, _, ok := ParseLeafAddress("@7/gui"); !ok {
		t.Errorf("ParseLeafAddress(@7/gui) = false, want true")
	}
}

// A swap moves a foreign leaf whole — its home follows it to the new slot.
func TestSwapKeepsForeignHome(t *testing.T) {
	got := Promote(mustParse(t, "h(tty,@12/code)"), "@12/code")
	if got.String() != "h(@12/code,tty)" {
		t.Errorf("Promote(h(tty,@12/code), @12/code) = %q, want h(@12/code,tty)", got)
	}
}

// ── structure helpers ───────────────────────────────────────────────────────

func TestDefault(t *testing.T) {
	if got := Default(); !reflect.DeepEqual(got, Node{Kind: "tty"}) {
		t.Errorf("Default() = %+v, want the bare tty leaf", got)
	}
	if got := Default().String(); got != "tty" {
		t.Errorf("Default().String() = %q, want tty", got)
	}
}

func TestHas(t *testing.T) {
	n := mustParse(t, "h(tty,v(code,web))")
	for _, s := range []string{"tty", "code", "web"} {
		if !n.Has(s) {
			t.Errorf("Has(%q) = false on %q", s, n)
		}
	}
	if n.Has("gui") {
		t.Errorf("Has(gui) = true on a gui-less layout %q", n)
	}
}

// The review kind is a plain registry addition: it parses and round-trips
// like any other surface, and a second bare review tile is refused.
func TestReviewSurfaceKind(t *testing.T) {
	n, err := Parse("h(tty,review)")
	if err != nil {
		t.Fatalf("Parse(h(tty,review)): %v", err)
	}
	if got := n.String(); got != "h(tty,review)" {
		t.Errorf("round-trip = %q", got)
	}
	if !n.Has("review") {
		t.Error("Has(review) = false")
	}
	if _, err := Add(n, "review"); !errors.Is(err, ErrSurfaceRepeat) {
		t.Errorf("Add(review) twice: err = %v, want ErrSurfaceRepeat", err)
	}
	if _, err := Parse("split-h:tty,review"); err != nil {
		t.Errorf("legacy Parse(split-h:tty,review): %v", err)
	}
}

func TestIsSurface(t *testing.T) {
	for _, kind := range []string{"tty", "web", "code", "gui", "review", "diff"} {
		if !IsSurface(kind) {
			t.Errorf("IsSurface(%q) = false", kind)
		}
	}
	for _, kind := range []string{"", "desktop", "agents", "terminal", "chat"} {
		if IsSurface(kind) {
			t.Errorf("IsSurface(%q) = true", kind)
		}
	}
}

// THE REGISTRY-PARITY GUARD.
//
// A surface the frontend can WRITE but this package refuses to PARSE is the
// worst shape this bug takes: the toggle writes `@rk_win_layout`, the daemon
// rejects the string, and the user gets `unknown surface at byte N` from a
// button that looks like it should just work. It happened with `diff`, and the
// only reason it survived review is that the e2e mocks the options POST, so the
// validator never ran in a test.
//
// Every kind the frontend offers must parse here. When a surface is added,
// this list is the second place to change and the failure names itself.
func TestEveryShippedSurfaceParsesInALayout(t *testing.T) {
	for _, kind := range []string{"tty", "web", "code", "gui", "review", "diff"} {
		spec := "h(tty," + kind + ")"
		if _, err := Parse(spec); err != nil {
			t.Errorf("Parse(%q) = %v — the frontend can write this and the daemon would reject it", spec, err)
		}
	}
}

func TestTemplateOf(t *testing.T) {
	// The R5 case: v(h(code,web),tty) is main-bottom with slot A = tty.
	name, slots := TemplateOf(mustParse(t, "v(h(code,web),tty)"))
	if name != "main-bottom" || !reflect.DeepEqual(slots, []string{"tty", "code", "web"}) {
		t.Errorf("TemplateOf(v(h(code,web),tty)) = %q %v", name, slots)
	}
	// h(v(tty,code),web) is main-right's structure with slot A = web. (Every
	// canonical ≤3-leaf tree matches a template — "custom" needs N ≥ 4.)
	name, slots = TemplateOf(mustParse(t, "h(v(tty,code),web)"))
	if name != "main-right" || !reflect.DeepEqual(slots, []string{"web", "tty", "code"}) {
		t.Errorf("TemplateOf(h(v(tty,code),web)) = %q %v, want main-right [web tty code]", name, slots)
	}
	if name, _ := TemplateOf(mustParse(t, "tty")); name != "single" {
		t.Errorf("TemplateOf(tty) = %q, want single", name)
	}
	// Slots are leaf ids: a foreign leaf's slot is its address, so template
	// verbs keep the tile's home-window identity.
	name, slots = TemplateOf(mustParse(t, "h(tty,@12/code)"))
	if name != "row" || !reflect.DeepEqual(slots, []string{"tty", "@12/code"}) {
		t.Errorf("TemplateOf(h(tty,@12/code)) = %q %v, want row [tty @12/code]", name, slots)
	}
}

// SetTemplate/Cycle round-trip a foreign leaf whole — the rebuilt tree keeps
// the "@N/<kind>" address in its slot instead of degrading it to a bare kind.
func TestTemplateVerbsKeepForeignIdentity(t *testing.T) {
	if got, err := SetTemplate(mustParse(t, "h(tty,@12/code)"), "col"); err != nil || got.String() != "v(tty,@12/code)" {
		t.Errorf("SetTemplate(h(tty,@12/code), col) = %q, %v, want v(tty,@12/code)", got, err)
	}
	if got := Cycle(mustParse(t, "h(tty,@12/code)")); got.String() != "v(tty,@12/code)" {
		t.Errorf("Cycle(h(tty,@12/code)) = %q, want v(tty,@12/code)", got)
	}
	if got := Cycle(mustParse(t, "v(@3/web,tty)")); got.String() != "h(@3/web,tty)" {
		t.Errorf("Cycle(v(@3/web,tty)) = %q, want h(@3/web,tty)", got)
	}
}

// Slot A's id comes straight from the slot order: a foreign slot A swaps with
// a bare leaf of the same kind (a kind lookup would find the bare leaf and
// no-op).
func TestPromoteForeignSlotA(t *testing.T) {
	got := Promote(mustParse(t, "h(@12/web,web)"), "web")
	if got.String() != "h(web,@12/web)" {
		t.Errorf("Promote(h(@12/web,web), web) = %q, want h(web,@12/web)", got)
	}
}

func TestTemplatesFor(t *testing.T) {
	if got := TemplatesFor(1); len(got) != 0 {
		t.Errorf("TemplatesFor(1) = %v, want empty", got)
	}
	if got := TemplatesFor(2); !reflect.DeepEqual(got, []string{"row", "col"}) {
		t.Errorf("TemplatesFor(2) = %v", got)
	}
	want3 := []string{"row", "col", "main-left", "main-right", "main-top", "main-bottom"}
	if got := TemplatesFor(3); !reflect.DeepEqual(got, want3) {
		t.Errorf("TemplatesFor(3) = %v", got)
	}
}

// ── verb sentinels (fixture table covers the happy paths) ──────────────────

func TestAddSentinels(t *testing.T) {
	if _, err := Add(mustParse(t, "h(tty,web)"), "web"); !errors.Is(err, ErrSurfaceRepeat) {
		t.Errorf("Add a repeated non-tty: err = %v, want ErrSurfaceRepeat", err)
	}
	if _, err := Add(mustParse(t, "tty"), "bogus"); !errors.Is(err, ErrUnknownSurface) {
		t.Errorf("Add a bogus surface: err = %v, want ErrUnknownSurface", err)
	}
	// A duplicate tty is legal (the muxed relay supports N clients per pane).
	if got, err := Add(mustParse(t, "tty"), "tty"); err != nil || got.String() != "h(tty,tty)" {
		t.Errorf("Add(tty, tty) = %q, %v, want h(tty,tty)", got, err)
	}
	// No tile cap: a fourth tile splits the last leaf on its longer axis.
	if got, err := Add(mustParse(t, "h(tty,web,code)"), "gui"); err != nil || got.String() != "h(tty,web,v(code,gui))" {
		t.Errorf("Add(h(tty,web,code), gui) = %q, %v, want h(tty,web,v(code,gui))", got, err)
	}
}

// The repeat rule counts only BARE leaves: a tree holding @12/web but no bare
// web accepts adding web (h(web,@12/web) is a legal tree).
func TestAddRepeatCountsBareLeavesOnly(t *testing.T) {
	cases := []struct {
		name    string
		tree    string
		kind    string
		want    string
		wantErr error
	}{
		{"foreign web only, add bare web", "h(tty,@12/web)", "web", "h(tty,v(@12/web,web))", nil},
		{"foreign web sole leaf, add bare web", "@12/web", "web", "h(@12/web,web)", nil},
		{"bare web present, add web", "h(tty,web)", "web", "", ErrSurfaceRepeat},
		{"bare tty duplicate stays legal", "tty", "tty", "h(tty,tty)", nil},
		{"foreign tty only, add bare tty", "@12/tty", "tty", "h(@12/tty,tty)", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Add(mustParse(t, tc.tree), tc.kind)
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("Add(%q, %q): err = %v, want %v", tc.tree, tc.kind, err, tc.wantErr)
				}
				return
			}
			if err != nil || got.String() != tc.want {
				t.Errorf("Add(%q, %q) = %q, %v, want %q", tc.tree, tc.kind, got, err, tc.want)
			}
		})
	}
}

func TestCloseSentinels(t *testing.T) {
	if _, err := Close(mustParse(t, "tty"), "tty"); !errors.Is(err, ErrLayoutLastTile) {
		t.Errorf("Close the last tile: err = %v, want ErrLayoutLastTile", err)
	}
	if _, err := Close(mustParse(t, "h(tty,web)"), "code"); !errors.Is(err, ErrSurfaceAbsent) {
		t.Errorf("Close an absent leaf: err = %v, want ErrSurfaceAbsent", err)
	}
	// Closing one tile of a column leaves a column (structure kept).
	if got, err := Close(mustParse(t, "v(tty,code,web)"), "code"); err != nil || got.String() != "v(tty,web)" {
		t.Errorf("Close(v(tty,code,web), code) = %q, %v, want v(tty,web)", got, err)
	}
	// Close by duplicate-tty leaf id.
	if got, err := Close(mustParse(t, "h(tty,v(tty,web))"), "tty#2"); err != nil || got.String() != "h(tty,web)" {
		t.Errorf("Close by tty#2 = %q, %v, want h(tty,web)", got, err)
	}
}

func TestSetTemplateSentinel(t *testing.T) {
	if _, err := SetTemplate(mustParse(t, "h(tty,web)"), "main-left"); !errors.Is(err, ErrUnknownTemplate) {
		t.Errorf("SetTemplate outside TemplatesFor(n): err = %v, want ErrUnknownTemplate", err)
	}
	if _, err := SetTemplate(mustParse(t, "tty"), "row"); !errors.Is(err, ErrUnknownTemplate) {
		t.Errorf("SetTemplate on one tile: err = %v, want ErrUnknownTemplate", err)
	}
	if got, err := SetTemplate(mustParse(t, "h(tty,v(code,web))"), "main-bottom"); err != nil || got.String() != "v(h(code,web),tty)" {
		t.Errorf("SetTemplate(main-bottom) = %q, %v, want v(h(code,web),tty)", got, err)
	}
}

func TestPromoteNoOps(t *testing.T) {
	n := mustParse(t, "h(tty,v(code,web))")
	if got := Promote(n, "gui"); got.String() != n.String() {
		t.Errorf("Promote of an absent leaf = %q, want unchanged", got)
	}
	if got := Promote(n, "tty"); got.String() != n.String() {
		t.Errorf("Promote of slot A = %q, want unchanged", got)
	}
}

// The zero Node reads as Default on every verb (the "" → tty rule the CLI
// applies to an unset @rk_win_layout).
func TestZeroNodeReadsAsDefault(t *testing.T) {
	var zero Node
	if got := Promote(zero, "tty"); got.String() != "tty" {
		t.Errorf("Promote(zero) = %q, want tty", got)
	}
	if got, err := Add(zero, "web"); err != nil || got.String() != "h(tty,web)" {
		t.Errorf("Add(zero, web) = %q, %v, want h(tty,web)", got, err)
	}
	if got := Cycle(zero); got.String() != "tty" {
		t.Errorf("Cycle(zero) = %q, want tty", got)
	}
	if _, err := Close(zero, "tty"); !errors.Is(err, ErrLayoutLastTile) {
		t.Errorf("Close(zero): err = %v, want ErrLayoutLastTile", err)
	}
}
