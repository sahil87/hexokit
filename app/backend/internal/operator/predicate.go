// done_when grammar: one or more clauses joined by " and "; a clause is
// `<path> <op> <literal>` with <path> a field name or dotted path (a leading
// "." is accepted and stripped), <op> ∈ {==, !=}, and <literal> a JSON scalar
// (double-quoted string, number, true, false, null). No "or", no comparison
// operators, no regex, no functions. A path absent from the evaluated object
// compares as null. The grammar is deliberately equality-only: table-testable
// and hard for an LLM to compose wrong.
package operator

import (
	"encoding/json"
	"fmt"
	"strings"
)

type cmpOp int

const (
	opEq cmpOp = iota
	opNe
)

// clause is one parsed `<path> <op> <literal>` term.
type clause struct {
	path []string
	op   cmpOp
	lit  interface{} // JSON scalar: nil, bool, string, or float64
}

// Predicate is a parsed done_when expression — the AND of its clauses.
type Predicate struct {
	clauses []clause
}

// Parse compiles src into a Predicate. Malformed input is rejected with an
// error naming the offending clause.
func Parse(src string) (Predicate, error) {
	rest := strings.TrimSpace(src)
	if rest == "" {
		return Predicate{}, fmt.Errorf("empty predicate")
	}
	var clauses []clause
	for {
		c, r, err := parseClause(rest)
		if err != nil {
			return Predicate{}, fmt.Errorf("invalid clause %q: %v", clauseText(rest), err)
		}
		clauses = append(clauses, c)
		rest = r
		if rest == "" {
			break
		}
		if strings.TrimSpace(rest) == "and" {
			return Predicate{}, fmt.Errorf("invalid predicate %q: missing clause after ' and'", src)
		}
		if !strings.HasPrefix(rest, " and ") {
			return Predicate{}, fmt.Errorf("invalid clause %q: clauses join with ' and ' only (no 'or', comparisons, regex, or functions)", clauseText(rest))
		}
		rest = strings.TrimPrefix(rest, " and ")
		if strings.TrimSpace(rest) == "" {
			return Predicate{}, fmt.Errorf("invalid clause %q: missing clause after ' and '", clauseText(rest))
		}
	}
	return Predicate{clauses: clauses}, nil
}

// clauseText names the offending clause in errors: the text from the clause
// start to the next " and " boundary (or the end of the input).
func clauseText(s string) string {
	if i := strings.Index(s, " and "); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return strings.TrimSpace(s)
}

// parseClause consumes one clause from the front of s, returning the clause
// and the remaining input (left-trimmed).
func parseClause(s string) (clause, string, error) {
	s = strings.TrimLeft(s, " ")
	i := 0
	for i < len(s) && isPathChar(s[i]) {
		i++
	}
	if i == 0 {
		return clause{}, "", fmt.Errorf("missing field path")
	}
	path := strings.TrimPrefix(s[:i], ".")
	if path == "" {
		// A lone "." would split into a key named "" and make `. == null`
		// true for every object — reject it as a missing path.
		return clause{}, "", fmt.Errorf("missing field path")
	}
	rest := strings.TrimLeft(s[i:], " ")

	var op cmpOp
	switch {
	case strings.HasPrefix(rest, "=="):
		op = opEq
		rest = rest[2:]
	case strings.HasPrefix(rest, "!="):
		op = opNe
		rest = rest[2:]
	default:
		return clause{}, "", fmt.Errorf("operator must be == or != (no comparisons or regex)")
	}
	rest = strings.TrimLeft(rest, " ")
	if rest == "" {
		return clause{}, "", fmt.Errorf("missing literal")
	}
	lit, n, err := parseLiteral(rest)
	if err != nil {
		return clause{}, "", err
	}
	// The remainder keeps its leading whitespace: the " and " clause boundary
	// requires the literal spaces.
	return clause{path: strings.Split(path, "."), op: op, lit: lit}, rest[n:], nil
}

// isPathChar gates field-name characters: letters, digits, and the
// punctuation a dotted path or a hyphenated key carries.
func isPathChar(c byte) bool {
	return c == '.' || c == '_' || c == '-' ||
		(c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}

// parseLiteral decodes one JSON scalar from the front of s, returning the
// value and the number of bytes consumed. Anything that is not a JSON scalar
// (an unquoted bare word, an array, an object) is rejected.
func parseLiteral(s string) (interface{}, int, error) {
	dec := json.NewDecoder(strings.NewReader(s))
	var v interface{}
	if err := dec.Decode(&v); err != nil {
		return nil, 0, fmt.Errorf("literal must be a JSON scalar (double-quoted string, number, true, false, null)")
	}
	switch v.(type) {
	case nil, bool, string, float64:
		return v, int(dec.InputOffset()), nil
	default:
		return nil, 0, fmt.Errorf("literal must be a JSON scalar (double-quoted string, number, true, false, null)")
	}
}

// Eval reports whether every clause holds against last (an observed-fields
// object). A path absent from last compares as null.
func (p Predicate) Eval(last map[string]interface{}) bool {
	for _, c := range p.clauses {
		if !c.eval(last) {
			return false
		}
	}
	return true
}

func (c clause) eval(last map[string]interface{}) bool {
	var cur interface{} = last
	for _, seg := range c.path {
		m, ok := cur.(map[string]interface{})
		if !ok {
			cur = nil
			break
		}
		cur, ok = m[seg]
		if !ok {
			cur = nil
			break
		}
	}
	eq := scalarEqual(cur, c.lit)
	if c.op == opNe {
		return !eq
	}
	return eq
}

// scalarEqual compares an observed value with a JSON-scalar literal. Numbers
// compare numerically across int/int64/float64/json.Number (observed values
// arrive via YAML, literals via JSON); a type mismatch is never equal.
func scalarEqual(observed, literal interface{}) bool {
	if on, ok := asFloat(observed); ok {
		ln, lok := asFloat(literal)
		return lok && on == ln
	}
	if observed == nil || literal == nil {
		return observed == nil && literal == nil
	}
	return observed == literal
}

func asFloat(v interface{}) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case uint64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	}
	return 0, false
}
