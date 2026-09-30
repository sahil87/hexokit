// Package layoutspec is the Go port of the frontend's surface-layout tree
// model (app/frontend/src/lib/layout-tree.ts, plus the verbs of
// surface-layout.ts): the "@rk_win_layout" value is a CANONICAL SPLIT TREE —
// "h(tty,v(code,web))" — and the legacy "<shape>:<surface,…>" preset strings
// parse permanently into their trees. The /options validator and the CLI
// share this one package so they cannot drift from the frontend's parser, and
// shared JSON fixture tables (layout-tree.fixtures.json and
// layout-grammar.fixtures.json under app/frontend/src/lib/, read by
// layoutspec_test.go) pin identical inputs → outputs on both sides.
// The package is pure — no tmux, no I/O. Unlike the frontend, Go trees carry
// no sizes: divider positions are per-viewer frontend state.
package layoutspec

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode"
)

// Node is one node of the canonical split tree: a leaf (Kind set — a surface
// kind) or a split (Dir "h" = children left→right, "v" = top→bottom, with ≥2
// Children, and a child split never of its parent's direction, so each
// arrangement has exactly one encoding). A bare leaf tiles the layout's own
// window; Home set ("@12") marks a foreign leaf tiling another window's
// surface on the same server, serialized as the "@12/<kind>" address. N holds
// the optional "/<n>" instance suffix as raw digits — the tokenizer
// recognises it so the grammar stays forward-compatible, and canonical
// validation rejects any leaf carrying one (v1 tiles one instance per
// surface). Non-tty bare kinds never repeat; duplicate bare tty tiles are
// legal (the muxed relay supports N clients per pane). There is no leaf-count
// cap: tree size is bounded by MaxLayoutLen before parsing.
type Node struct {
	Kind     string
	Home     string
	N        string
	Dir      string
	Children []Node
}

// MaxLayoutLen bounds the input byte length BEFORE parsing: parseNode's
// recursion depth is bounded by len(raw)/2 (each level consumes ≥2 bytes), so
// the cap keeps a hostile @rk_win_layout value from exhausting the stack. An
// all-bare canonical tree over the five surface kinds is ≤ 26 bytes and
// legacy presets stay under 30, but foreign address leaves run 7–11 bytes
// each, so cross-tab trees need the headroom.
const MaxLayoutLen = 512

// splitGapPX mirrors the frontend's SPLIT_GAP_PX gutter: the nominal geometry
// Add resolves the split direction from is computed with it, so the Go and TS
// verbs pick the same axis.
const splitGapPX = 6

// nominalBox mirrors the frontend's NOMINAL_BOX: the fallback geometry for
// callers with no measured rects (mobile, the CLI).
var nominalBox = rect{w: 1600, h: 1000}

// surfaceKindList is the closed surface registry — the frontend's ViewName
// set; spec'd-but-unshipped surfaces (desktop, agents) are rejected until the
// frontend ships them, and extending the registry is appending one entry.
var surfaceKindList = []string{"tty", "web", "code", "gui", "review", "diff"}

// IsSurface reports whether kind is in the surface registry.
func IsSurface(kind string) bool {
	for _, k := range surfaceKindList {
		if k == kind {
			return true
		}
	}
	return false
}

// IsLeaf reports whether the node is a leaf (a surface kind, not a split).
func (n Node) IsLeaf() bool {
	return n.Kind != ""
}

// IsForeign reports whether the leaf tiles another window's surface; a bare
// leaf (Home empty) tiles the layout's own window.
func (n Node) IsForeign() bool {
	return n.IsLeaf() && n.Home != ""
}

// HasForeign reports whether any leaf of the tree is a foreign leaf.
func (n Node) HasForeign() bool {
	for _, l := range n.leafNodes() {
		if l.IsForeign() {
			return true
		}
	}
	return false
}

// Address returns the leaf's identity string: the "@12/tty" address for a
// foreign leaf, the bare kind otherwise.
func (n Node) Address() string {
	if n.Home == "" {
		return n.Kind
	}
	return n.Home + "/" + n.Kind
}

// ParseLeafAddress splits a foreign-leaf address ("@12/tty") into its home
// window and kind. ok=false for bare kinds, malformed addresses, unknown
// kinds, and "/<n>"-suffixed forms — the grammar-level half of the leaf
// rules; the foreign-gui rejection lives in validation, not here.
func ParseLeafAddress(raw string) (home, kind string, ok bool) {
	if !strings.HasPrefix(raw, "@") {
		return "", "", false
	}
	digits, rest, found := strings.Cut(raw[1:], "/")
	if !found || digits == "" {
		return "", "", false
	}
	for _, r := range digits {
		if !unicode.IsDigit(r) {
			return "", "", false
		}
	}
	if !IsSurface(rest) {
		return "", "", false
	}
	return "@" + digits, rest, true
}

func leaf(kind string) Node {
	return Node{Kind: kind}
}

// leafFromID builds a leaf from a leaf id (LeafIDs form): a foreign address
// ("@12/tty") keeps its home; a bare id is the kind, a duplicate-occurrence
// suffix ("tty#2") dropped — occurrences of one kind build identical leaves.
func leafFromID(id string) Node {
	if home, kind, ok := ParseLeafAddress(id); ok {
		return Node{Kind: kind, Home: home}
	}
	kind := id
	if i := strings.IndexByte(kind, '#'); i >= 0 {
		kind = kind[:i]
	}
	return leaf(kind)
}

// splitNode builds a split; a single-child split lifts to the child
// (canonical form).
func splitNode(dir string, children ...Node) Node {
	if len(children) == 1 {
		return children[0]
	}
	return Node{Dir: dir, Children: children}
}

// Leaves returns the leaf kinds in reading order (depth-first, left-to-right).
func (n Node) Leaves() []string {
	if n.IsLeaf() {
		return []string{n.Kind}
	}
	var out []string
	for _, c := range n.Children {
		out = append(out, c.Leaves()...)
	}
	return out
}

// leafNodes returns the leaf nodes in reading order (depth-first,
// left-to-right).
func (n Node) leafNodes() []Node {
	if n.IsLeaf() {
		return []Node{n}
	}
	var out []Node
	for _, c := range n.Children {
		out = append(out, c.leafNodes()...)
	}
	return out
}

// LeafIDs returns the stable per-leaf ids in reading order: a foreign leaf's
// id is its address string ("@12/tty"); a bare leaf's id is the kind itself
// for a unique bare kind, with duplicate bare kinds (only tty can repeat)
// numbered "tty", "tty#2", … by occurrence among the bare leaves.
func (n Node) LeafIDs() []string {
	list := n.leafNodes()
	bareTotals := map[string]int{}
	for _, l := range list {
		if l.Home == "" {
			bareTotals[l.Kind]++
		}
	}
	seen := map[string]int{}
	out := make([]string, len(list))
	for i, l := range list {
		if l.Home != "" {
			out[i] = l.Address()
			continue
		}
		if bareTotals[l.Kind] == 1 {
			out[i] = l.Kind
			continue
		}
		seen[l.Kind]++
		if seen[l.Kind] == 1 {
			out[i] = l.Kind
		} else {
			out[i] = l.Kind + "#" + strconv.Itoa(seen[l.Kind])
		}
	}
	return out
}

// Has reports whether the layout's leaves contain the surface. A foreign
// leaf counts by kind — Has does not distinguish bare from foreign.
func (n Node) Has(surface string) bool {
	for _, k := range n.Leaves() {
		if k == surface {
			return true
		}
	}
	return false
}

// HasBare reports whether the layout holds a BARE leaf of the surface. A
// foreign leaf of the same kind does not count: a bare kind and a foreign
// leaf of that kind may coexist in one tree.
func (n Node) HasBare(surface string) bool {
	for _, l := range n.leafNodes() {
		if l.Home == "" && l.Kind == surface {
			return true
		}
	}
	return false
}

// String serializes the tree to its grammar form — the only form writers
// emit (a legacy preset string Parse accepts rewrites to this on write). A
// foreign leaf emits its "@<home>/<kind>" address.
func (n Node) String() string {
	if n.IsLeaf() {
		if n.N != "" {
			return n.Address() + "/" + n.N
		}
		return n.Address()
	}
	parts := make([]string, len(n.Children))
	for i, c := range n.Children {
		parts[i] = c.String()
	}
	return n.Dir + "(" + strings.Join(parts, ",") + ")"
}

// ── parsing (tree grammar + permanent legacy preset grammar) ───────────────

// Parse validates a stored @rk_win_layout value: the tree grammar, or the
// legacy "<shape>:<a>,<b>[,<c>]" preset grammar (accepted permanently,
// converted losslessly per the spec table — bare kinds only). Untrusted
// strings (tmux option values, API bodies) are validated HERE so callers may
// pass raw values. Anything malformed — unknown kind, whitespace, a
// non-canonical tree, a "/<n>" suffix, a repeated foreign address, a foreign
// gui, a repeated non-tty bare surface, a legacy arity mismatch — is an
// error. The input is NEVER normalised into validity. The self-window rule (a
// foreign leaf naming the owning window) needs the owner, which parse-time
// callers do not have — write paths enforce it via ValidateFor.
func Parse(raw string) (Node, error) {
	if raw == "" || strings.IndexFunc(raw, unicode.IsSpace) >= 0 {
		return Node{}, fmt.Errorf("layout %q: empty or contains whitespace", raw)
	}
	if len(raw) > MaxLayoutLen {
		return Node{}, fmt.Errorf("layout exceeds the %d-byte input cap (%d bytes)", MaxLayoutLen, len(raw))
	}
	var (
		n   Node
		err error
	)
	if strings.Contains(raw, ":") {
		n, err = parseLegacy(raw)
	} else {
		n, err = parseTreeGrammar(raw)
	}
	if err != nil {
		return Node{}, err
	}
	if err := validate(n, ""); err != nil {
		return Node{}, fmt.Errorf("layout %q: %v", raw, err)
	}
	return n, nil
}

// ValidateFor applies canonical-tree validation for the window holding the
// layout: ≥2 children per split, no child split with its parent's direction,
// no repeated bare non-tty kind (duplicate bare tty tiles are legal), a bare
// kind and a foreign leaf of the same kind MAY coexist. Foreign-leaf rules:
// no foreign gui (one desktop per host), no repeated address, no "/<n>"
// suffix on any leaf (grammar-only in v1), and — only when owner names the
// owning window — no foreign leaf naming the owner. There is no leaf-count
// cap: tree size is bounded by MaxLayoutLen before parsing.
func ValidateFor(n Node, owner string) error {
	return validate(n, owner)
}

func validate(n Node, owner string) error {
	leaves := n.leafNodes()
	if len(leaves) == 0 {
		return errors.New("no leaves")
	}
	bareSeen := map[string]bool{}
	addresses := map[string]bool{}
	for _, l := range leaves {
		if l.N != "" {
			return fmt.Errorf("surface instance suffix /%s is grammar-only (v1)", l.N)
		}
		if l.Home != "" {
			if l.Kind == "gui" {
				return fmt.Errorf("foreign gui %q: one desktop per host", l.Address())
			}
			if owner != "" && l.Home == owner {
				return fmt.Errorf("foreign leaf %q names the layout's own window", l.Address())
			}
			if addresses[l.Address()] {
				return fmt.Errorf("repeated foreign address %q", l.Address())
			}
			addresses[l.Address()] = true
			continue
		}
		if l.Kind == "tty" {
			continue // duplicate bare tty tiles are legal (muxed relay)
		}
		if bareSeen[l.Kind] {
			return fmt.Errorf("repeated surface %q", l.Kind)
		}
		bareSeen[l.Kind] = true
	}
	var walk func(n Node, parentDir string) error
	walk = func(n Node, parentDir string) error {
		if n.IsLeaf() {
			return nil
		}
		if len(n.Children) < 2 {
			return errors.New("a split takes ≥2 children")
		}
		if parentDir != "" && n.Dir == parentDir {
			return fmt.Errorf("a %q split nests inside its parent direction", n.Dir)
		}
		for _, c := range n.Children {
			if err := walk(c, n.Dir); err != nil {
				return err
			}
		}
		return nil
	}
	return walk(n, "")
}

// treeParser is the recursive-descent cursor for the tree grammar.
type treeParser struct {
	raw string
	i   int
}

func parseTreeGrammar(raw string) (Node, error) {
	p := &treeParser{raw: raw}
	n, err := p.parseNode()
	if err != nil {
		return Node{}, fmt.Errorf("layout %q: %v", raw, err)
	}
	if p.i != len(raw) {
		return Node{}, fmt.Errorf("layout %q: trailing input at byte %d", raw, p.i)
	}
	return n, nil
}

func (p *treeParser) parseNode() (Node, error) {
	if p.i >= len(p.raw) {
		return Node{}, errors.New("unexpected end of input")
	}
	if ch := p.raw[p.i]; ch == 'h' || ch == 'v' {
		dir := string(ch)
		p.i++
		if p.i >= len(p.raw) || p.raw[p.i] != '(' {
			return Node{}, fmt.Errorf("split %q not followed by (", dir)
		}
		p.i++
		var children []Node
		for {
			c, err := p.parseNode()
			if err != nil {
				return Node{}, err
			}
			children = append(children, c)
			if p.i < len(p.raw) && p.raw[p.i] == ',' {
				p.i++
				continue
			}
			break
		}
		if p.i >= len(p.raw) || p.raw[p.i] != ')' {
			return Node{}, errors.New("split not closed by )")
		}
		p.i++
		return Node{Dir: dir, Children: children}, nil
	}
	// No surface kind is a prefix of another, and a leaf must be followed by a
	// delimiter or the end of input. A foreign leaf opens with "@<digits>/";
	// the optional "/<n>" suffix tokenizes on both forms and is rejected by
	// canonical validation (grammar-only in v1). "-L <srv>" and "=<session>:"
	// qualifiers carry characters this grammar has no token for, so they fail
	// here.
	var home string
	if p.raw[p.i] == '@' {
		p.i++
		start := p.i
		for p.i < len(p.raw) && p.raw[p.i] >= '0' && p.raw[p.i] <= '9' {
			p.i++
		}
		if p.i == start {
			return Node{}, fmt.Errorf("@ at byte %d not followed by window digits", start-1)
		}
		home = p.raw[start-1 : p.i]
		if p.i >= len(p.raw) || p.raw[p.i] != '/' {
			return Node{}, fmt.Errorf("foreign address %q not followed by /<kind>", home)
		}
		p.i++
	}
	for _, kind := range surfaceKindList {
		if !strings.HasPrefix(p.raw[p.i:], kind) {
			continue
		}
		next := p.i + len(kind)
		if next < len(p.raw) && p.raw[next] != ',' && p.raw[next] != ')' && p.raw[next] != '/' {
			return Node{}, fmt.Errorf("surface %q not followed by a delimiter", kind)
		}
		p.i += len(kind)
		out := Node{Kind: kind, Home: home}
		if p.i < len(p.raw) && p.raw[p.i] == '/' {
			p.i++
			start := p.i
			for p.i < len(p.raw) && p.raw[p.i] >= '0' && p.raw[p.i] <= '9' {
				p.i++
			}
			if p.i == start {
				return Node{}, fmt.Errorf("/ after %q not followed by instance digits", kind)
			}
			out.N = p.raw[start:p.i]
			if p.i < len(p.raw) && p.raw[p.i] != ',' && p.raw[p.i] != ')' {
				return Node{}, fmt.Errorf("surface instance %q/%s not followed by a delimiter", kind, out.N)
			}
		}
		return out, nil
	}
	return Node{}, fmt.Errorf("unknown surface at byte %d", p.i)
}

// legacyArity is the fixed slot count per legacy preset shape.
var legacyArity = map[string]int{
	"single":     1,
	"split-h":    2,
	"split-v":    2,
	"row":        3,
	"col":        3,
	"main-left":  3,
	"main-right": 3,
	"main-top":   3,
}

// parseLegacy converts the legacy "<shape>:<a>,<b>[,<c>]" preset grammar to
// its tree (the permanent table in the spec).
func parseLegacy(raw string) (Node, error) {
	shape, rest, _ := strings.Cut(raw, ":")
	arity, ok := legacyArity[shape]
	if !ok {
		return Node{}, fmt.Errorf("layout %q: unknown shape %q", raw, shape)
	}
	parts := strings.Split(rest, ",")
	if len(parts) != arity {
		return Node{}, fmt.Errorf("layout %q: shape %q takes %d surfaces, got %d", raw, shape, arity, len(parts))
	}
	kinds := make([]Node, len(parts))
	for i, s := range parts {
		if !IsSurface(s) {
			return Node{}, fmt.Errorf("layout %q: unknown surface %q", raw, s)
		}
		kinds[i] = leaf(s)
	}
	switch shape {
	case "single":
		return kinds[0], nil
	case "split-h":
		return splitNode("h", kinds...), nil
	case "split-v":
		return splitNode("v", kinds...), nil
	case "row":
		return splitNode("h", kinds...), nil
	case "col":
		return splitNode("v", kinds...), nil
	case "main-left":
		return splitNode("h", kinds[0], splitNode("v", kinds[1], kinds[2])), nil
	case "main-right":
		return splitNode("h", splitNode("v", kinds[1], kinds[2]), kinds[0]), nil
	case "main-top":
		return splitNode("v", kinds[0], splitNode("h", kinds[1], kinds[2])), nil
	}
	panic("unreachable: legacyArity and the builder switch cover the same shapes")
}

// ── pure tree operations ────────────────────────────────────────────────────

// Sentinels for the disallowed mutations below — where the frontend verbs
// return null. The CLI maps these to exit codes; the /options validator never
// calls the verbs.
var (
	// ErrLayoutLastTile: Close on a single-tile layout.
	ErrLayoutLastTile = errors.New("the last tile never closes")
	// ErrSurfaceAbsent: Close/Promote on a surface the layout does not hold.
	ErrSurfaceAbsent = errors.New("surface is not in the layout")
	// ErrSurfaceRepeat: Add a non-tty surface the layout already holds.
	ErrSurfaceRepeat = errors.New("surface is already in the layout")
	// ErrUnknownSurface: a kind outside the surface registry (user input).
	ErrUnknownSurface = errors.New("unknown surface")
	// ErrUnknownTemplate: SetTemplate to a template that does not apply to the
	// layout's tile count.
	ErrUnknownTemplate = errors.New("template does not apply to the tile count")
)

// Default is the layout an unset @rk_win_layout renders (the frontend's
// effectiveLayout fallback): the bare tty leaf. Every verb treats a leaf-less
// Node as Default.
func Default() Node {
	return leaf("tty")
}

// normalize maps a leaf-less Node (the zero value) to Default so callers may
// pass an empty struct for "unset".
func normalize(n Node) Node {
	if len(n.Leaves()) == 0 {
		return Default()
	}
	return n
}

// normalise canonicalises: merge same-direction nesting and lift
// single-child splits. Canonical input is a fixpoint.
func normalise(n Node) Node {
	if n.IsLeaf() {
		return n
	}
	var children []Node
	for _, c := range n.Children {
		c = normalise(c)
		if !c.IsLeaf() && c.Dir == n.Dir {
			children = append(children, c.Children...)
		} else {
			children = append(children, c)
		}
	}
	return splitNode(n.Dir, children...)
}

// lastPath is the child-index path of the last leaf in reading order —
// reached by descending into the last child at every level.
func lastPath(n Node) []int {
	var path []int
	for !n.IsLeaf() {
		last := len(n.Children) - 1
		path = append(path, last)
		n = n.Children[last]
	}
	return path
}

// pathOf returns the child-index path of a leaf id (empty at the root leaf).
func pathOf(n Node, leafID string) ([]int, bool) {
	ids := n.LeafIDs()
	li := 0
	var walk func(n Node, path []int) ([]int, bool)
	walk = func(n Node, path []int) ([]int, bool) {
		if n.IsLeaf() {
			ok := ids[li] == leafID
			li++
			return path, ok
		}
		for i, c := range n.Children {
			if p, ok := walk(c, append(path, i)); ok {
				return p, true
			}
		}
		return nil, false
	}
	return walk(n, nil)
}

// replaceAt rebuilds the tree with the node at path substituted.
func replaceAt(n Node, path []int, value Node) Node {
	if len(path) == 0 {
		return value
	}
	children := make([]Node, len(n.Children))
	copy(children, n.Children)
	children[path[0]] = replaceAt(children[path[0]], path[1:], value)
	return Node{Dir: n.Dir, Children: children}
}

// removeAt drops the subtree at path; ok=false marks the removed node itself.
func removeAt(n Node, path []int) (out Node, ok bool) {
	if len(path) == 0 {
		return Node{}, false
	}
	children := make([]Node, 0, len(n.Children))
	for i, c := range n.Children {
		if i != path[0] {
			children = append(children, c)
			continue
		}
		if r, rok := removeAt(c, path[1:]); rok {
			children = append(children, r)
		}
	}
	if len(children) == 0 {
		return Node{}, false
	}
	return Node{Dir: n.Dir, Children: children}, true
}

func indexOf(ss []string, s string) int {
	for i, v := range ss {
		if v == s {
			return i
		}
	}
	return -1
}

func contains(ss []string, s string) bool {
	return indexOf(ss, s) >= 0
}

// swapLeaves exchanges two leaves by id. Leaf identity moves whole — a
// foreign leaf carries its home to the new position. An involution, and a
// no-op when either id is absent.
func swapLeaves(n Node, a, b string) Node {
	if a == b {
		return n
	}
	ids := n.LeafIDs()
	list := n.leafNodes()
	byID := make(map[string]Node, len(ids))
	for i, id := range ids {
		byID[id] = list[i]
	}
	la, aok := byID[a]
	lb, bok := byID[b]
	if !aok || !bok {
		return n
	}
	li := 0
	var walk func(n Node) Node
	walk = func(n Node) Node {
		if n.IsLeaf() {
			id := ids[li]
			li++
			switch id {
			case a:
				return lb
			case b:
				return la
			}
			return n
		}
		children := make([]Node, len(n.Children))
		for i, c := range n.Children {
			children[i] = walk(c)
		}
		return Node{Dir: n.Dir, Children: children}
	}
	return walk(n)
}

// ── templates (generators, not the model) ───────────────────────────────────

// templateNames is the registry order — it drives TemplateOf matching,
// TemplatesFor, and the Cycle walk.
var templateNames = []string{"row", "col", "main-left", "main-right", "main-top", "main-bottom"}

// indexKinds are distinct stand-in kinds for structure comparisons and slot
// mapping. It is NOT the surface registry — surfaceKindList is — and it only
// has to be as long as the largest template, which matches at N ≤ 5. Adding a
// surface does not belong here.
var indexKinds = []string{"tty", "web", "code", "gui", "review"}

// buildTemplate builds a template's tree for any N from a slot order; slot 0
// is the template's main tile. Slots are LEAF IDS (TemplateOf's output form):
// a foreign address rebuilds a foreign leaf, so a template verb round-trips
// "@N/<kind>" tiles without losing their home-window identity.
func buildTemplate(name string, slots []string) Node {
	leaves := make([]Node, len(slots))
	for i, id := range slots {
		leaves[i] = leafFromID(id)
	}
	switch name {
	case "row":
		return splitNode("h", leaves...)
	case "col":
		return splitNode("v", leaves...)
	case "main-left":
		if len(leaves) < 3 {
			return splitNode("h", leaves...)
		}
		return splitNode("h", leaves[0], splitNode("v", leaves[1:]...))
	case "main-right":
		if len(leaves) < 3 {
			return splitNode("h", leaves...)
		}
		return splitNode("h", splitNode("v", leaves[1:]...), leaves[0])
	case "main-top":
		if len(leaves) < 3 {
			return splitNode("v", leaves...)
		}
		return splitNode("v", leaves[0], splitNode("h", leaves[1:]...))
	case "main-bottom":
		if len(leaves) < 3 {
			return splitNode("v", leaves...)
		}
		return splitNode("v", splitNode("h", leaves[1:]...), leaves[0])
	}
	return Node{}
}

// structureSig is the structure signature: the tree's shape with leaves
// replaced by their reading-order indices, e.g. "h(0,v(1,2))".
func structureSig(n Node) string {
	var b strings.Builder
	i := 0
	var walk func(n Node)
	walk = func(n Node) {
		if n.IsLeaf() {
			b.WriteString(strconv.Itoa(i))
			i++
			return
		}
		b.WriteString(n.Dir)
		b.WriteByte('(')
		for j, c := range n.Children {
			if j > 0 {
				b.WriteByte(',')
			}
			walk(c)
		}
		b.WriteByte(')')
	}
	walk(n)
	return b.String()
}

// TemplateOf reports which template a tree is (structure match, kinds
// ignored) and its LEAF IDS in that template's slot order: the first template
// in registry order whose structure matches, "single" at one leaf, "custom"
// otherwise. The slots are reading order for "single" and "custom". A foreign
// leaf's slot is its address, so SetTemplate/Cycle rebuilds carry the tile's
// home-window identity.
func TemplateOf(n Node) (name string, slots []string) {
	real := n.LeafIDs()
	count := len(real)
	if count == 1 {
		return "single", real
	}
	if count > len(indexKinds) {
		return "custom", real
	}
	sig := structureSig(n)
	indexSlots := indexKinds[:count]
	for _, name := range templateNames {
		built := buildTemplate(name, indexSlots)
		if structureSig(built) != sig {
			continue
		}
		slots := make([]string, count)
		for j, kind := range built.Leaves() {
			slots[indexOf(indexKinds, kind)] = real[j]
		}
		return name, slots
	}
	return "custom", real
}

// SlotOrder returns the tree's LEAF IDS in template slot order — slot A is the
// template's main tile; reading order for a custom tree.
func SlotOrder(n Node) []string {
	_, slots := TemplateOf(n)
	return slots
}

// TemplatesFor lists the structurally distinct templates at a tile count, in
// registry order: nil for 1, [row col] for 2, [row col main-left main-right
// main-top main-bottom] for 3.
func TemplatesFor(count int) []string {
	if count < 2 || count > len(indexKinds) {
		return nil
	}
	indexSlots := indexKinds[:count]
	seen := map[string]bool{}
	var out []string
	for _, name := range templateNames {
		sig := structureSig(buildTemplate(name, indexSlots))
		if seen[sig] {
			continue
		}
		seen[sig] = true
		out = append(out, name)
	}
	return out
}

// ── mutations (verbs) ───────────────────────────────────────────────────────

// rect is an absolute pixel box — the nominal add geometry.
type rect struct {
	x, y, w, h float64
}

// lastLeafRect computes the last leaf's rect inside the nominal box with
// equal shares and the split gutter — the frontend's addSurface with no
// measured rects.
func lastLeafRect(n Node) rect {
	last := nominalBox
	var walk func(n Node, b rect)
	walk = func(n Node, b rect) {
		if n.IsLeaf() {
			last = b
			return
		}
		horiz := n.Dir == "h"
		count := float64(len(n.Children))
		avail := b.h
		if horiz {
			avail = b.w
		}
		share := (avail - splitGapPX*(count-1)) / count
		at := b.y
		if horiz {
			at = b.x
		}
		for _, c := range n.Children {
			var cb rect
			if horiz {
				cb = rect{x: at, y: b.y, w: share, h: b.h}
			} else {
				cb = rect{x: b.x, y: at, w: b.w, h: share}
			}
			walk(c, cb)
			at += share + splitGapPX
		}
	}
	walk(n, nominalBox)
	return last
}

// Add splits the LAST leaf in reading order along its longer axis (ties →
// horizontal), the new leaf landing after it (right or bottom), on the
// nominal 1600×1000 box (the CLI has no measured rects). There is no tile
// cap — the size floor gates surface-add offers on the frontend.
// ErrSurfaceRepeat when a non-tty surface is already open as a BARE leaf
// (duplicate tty tiles are legal; a foreign leaf of the same kind does not
// block the add); ErrUnknownSurface outside the registry.
func Add(n Node, kind string) (Node, error) {
	n = normalize(n)
	if !IsSurface(kind) {
		return Node{}, fmt.Errorf("%w: %q", ErrUnknownSurface, kind)
	}
	if kind != "tty" && n.HasBare(kind) {
		return Node{}, fmt.Errorf("%w: %q", ErrSurfaceRepeat, kind)
	}
	r := lastLeafRect(n)
	dir := "v"
	if r.w >= r.h {
		dir = "h" // wider than tall splits right; a tie splits horizontally
	}
	path := lastPath(n)
	target := n
	for _, i := range path {
		target = target.Children[i]
	}
	return normalise(replaceAt(n, path, splitNode(dir, target, leaf(kind)))), nil
}

// Close removes a leaf (by leaf id — the kind for a unique kind) and
// normalises: the neighbours absorb its share and the remaining STRUCTURE is
// kept (closing one tile of a column leaves a column). ErrLayoutLastTile on a
// single-tile layout; ErrSurfaceAbsent when absent.
func Close(n Node, leafID string) (Node, error) {
	n = normalize(n)
	if len(n.Leaves()) < 2 {
		return Node{}, ErrLayoutLastTile
	}
	path, ok := pathOf(n, leafID)
	if !ok {
		return Node{}, fmt.Errorf("%w: %q", ErrSurfaceAbsent, leafID)
	}
	out, _ := removeAt(n, path)
	return normalise(out), nil
}

// RemoveOrTTY drops a leaf by id (the kind for a unique bare kind, the address
// for a foreign leaf) and normalises, with the empty-tree fallback: a removal
// that drains the tree yields the bare tty leaf — a layout never renders
// empty. ok=false only when the leaf is absent — unlike Close there is no
// last-tile sentinel, so the borrow/return paths can fall back instead of
// failing.
func RemoveOrTTY(n Node, leafID string) (Node, bool) {
	n = normalize(n)
	path, ok := pathOf(n, leafID)
	if !ok {
		return n, false
	}
	out, ok := removeAt(n, path)
	if !ok {
		return Default(), true
	}
	return normalise(out), true
}

// Promote swaps the leaf (by leaf id) with slot A — the template's main tile
// (SlotOrder[0]), or the first leaf in reading order for a custom tree. A
// no-op when the leaf is absent or already slot A.
func Promote(n Node, leafID string) Node {
	n = normalize(n)
	ids := n.LeafIDs()
	if !contains(ids, leafID) {
		return n
	}
	mainID := SlotOrder(n)[0]
	if mainID == leafID {
		return n
	}
	return swapLeaves(n, leafID, mainID)
}

// Cycle returns the next entry of TemplatesFor(tile count) after the current
// template, rebuilt from the current slot order (wrapping). A custom tree
// cycles to the first template; one tile is a no-op.
func Cycle(n Node) Node {
	n = normalize(n)
	ring := TemplatesFor(len(n.Leaves()))
	if len(ring) == 0 {
		return n
	}
	name, slots := TemplateOf(n)
	next := ring[0] // a custom tree cycles to the first template
	if i := indexOf(ring, name); i >= 0 {
		next = ring[(i+1)%len(ring)]
	}
	return buildTemplate(next, slots)
}

// SetTemplate rebuilds TEMPLATES[name] from the current slot order — lossy
// for a custom tree. ErrUnknownTemplate when the name is not a template for
// the current tile count.
func SetTemplate(n Node, name string) (Node, error) {
	n = normalize(n)
	if !contains(TemplatesFor(len(n.Leaves())), name) {
		return Node{}, fmt.Errorf("%w: %q", ErrUnknownTemplate, name)
	}
	return buildTemplate(name, SlotOrder(n)), nil
}
