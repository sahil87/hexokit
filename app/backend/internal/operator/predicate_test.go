package operator

import (
	"strconv"
	"strings"
	"testing"
)

func TestParse_Valid(t *testing.T) {
	tests := []struct {
		name string
		src  string
	}{
		{"single equality", `state == "MERGED"`},
		{"inequality", `ready != false`},
		{"and-joined clauses", `conclusion == "success" and status == "completed"`},
		{"dotted path", `checks.conclusion == "success"`},
		{"leading dot stripped", `.state == "MERGED"`},
		{"null literal", `mergedAt == null`},
		{"integer literal", `count == 42`},
		{"negative float literal", `score != -1.5`},
		{"bool literal", `draft == true`},
		{"hyphenated key", `merge-state == "clean"`},
		{"literal containing the separator", `msg == "a and b"`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Parse(tc.src); err != nil {
				t.Errorf("Parse(%q) = %v, want nil error", tc.src, err)
			}
		})
	}
}

func TestParse_Invalid(t *testing.T) {
	tests := []struct {
		name        string
		src         string
		wantClause  string // substring naming the offending clause
		wantMessage string // substring describing the rejection
	}{
		{"empty", ``, "", "empty predicate"},
		{"unquoted string literal", `state == MERGED`, `state == MERGED`, "JSON scalar"},
		{"or rejected", `state == "MERGED" or ready == true`, `or ready == true`, "and"},
		{"comparison rejected", `count > 3`, `count > 3`, "== or !="},
		{"bare equals rejected", `state = "MERGED"`, `state = "MERGED"`, "== or !="},
		{"regex rejected", `state =~ "MER"`, `state =~ "MER"`, "== or !="},
		{"function rejected", `lower(state) == "merged"`, `lower(state) == "merged"`, "== or !="},
		{"array literal rejected", `state == ["MERGED"]`, `state == ["MERGED"]`, "JSON scalar"},
		{"object literal rejected", `state == {"s":1}`, `state == {"s":1}`, "JSON scalar"},
		{"missing literal", `state ==`, `state ==`, "missing literal"},
		{"missing path", `== "MERGED"`, `== "MERGED"`, "missing field path"},
		{"lone dot path", `. == null`, `. == null`, "missing field path"},
		{"trailing and", `state == "MERGED" and `, "", "missing clause"},
		{"double and", `state == "MERGED" and and ready == true`, `and ready == true`, "== or !="},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Parse(tc.src)
			if err == nil {
				t.Fatalf("Parse(%q) = nil error, want rejection", tc.src)
			}
			if tc.wantClause != "" && !strings.Contains(err.Error(), strconv.Quote(tc.wantClause)) {
				t.Errorf("Parse(%q) error = %q, want it to name clause %q", tc.src, err, tc.wantClause)
			}
			if !strings.Contains(err.Error(), tc.wantMessage) {
				t.Errorf("Parse(%q) error = %q, want substring %q", tc.src, err, tc.wantMessage)
			}
		})
	}
}

// TestEval covers the R2 GIVEN/WHEN/THEN examples plus the comparison
// semantics (absent path = null, numeric coercion across YAML/JSON decodings).
func TestEval(t *testing.T) {
	last := map[string]interface{}{
		"state":  "MERGED",
		"count":  3, // YAML-style int decoding
		"checks": map[string]interface{}{"conclusion": "success"},
	}
	tests := []struct {
		name string
		src  string
		last map[string]interface{}
		want bool
	}{
		{"R2 example: both clauses hold", `state == "MERGED" and checks.conclusion == "success"`, last, true},
		{"R2 example: inequality false", `state != "MERGED"`, last, false},
		{"R2 example: absent path compares as null", `missing == null`, last, true},
		{"absent path != null is false", `missing != null`, last, false},
		{"present value is not null", `state == null`, last, false},
		{"dotted path miss compares as null", `checks.verdict == null`, last, true},
		{"dotted path through a scalar compares as null", `state.conclusion == null`, last, true},
		{"inequality holds on different value", `state != "CLOSED"`, last, true},
		{"equality fails on different value", `state == "CLOSED"`, last, false},
		{"numeric coercion: YAML int vs JSON literal", `count == 3`, last, true},
		{"numeric coercion: float literal", `count == 3.0`, last, true},
		{"numeric mismatch", `count == 4`, last, false},
		{"type mismatch never equal", `state == 1`, last, false},
		{"bool literal", `draft != true`, last, true},
		{"second clause fails the AND", `state == "MERGED" and checks.conclusion == "failure"`, last, false},
		{"leading-dot path", `.state == "MERGED"`, last, true},
		{"empty object", `state == "MERGED"`, map[string]interface{}{}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p, err := Parse(tc.src)
			if err != nil {
				t.Fatalf("Parse(%q): %v", tc.src, err)
			}
			if got := p.Eval(tc.last); got != tc.want {
				t.Errorf("Eval(%q) = %v, want %v", tc.src, got, tc.want)
			}
		})
	}
}
