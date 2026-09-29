package tmux

// Web-tab family operations over the indexed @rk_win_web_<n> options: one
// tmux call to read the family, one chained SetWindowOptions call to mutate
// it — atomic against the SSE tick (the present.go precedent). The family is
// DENSE on every write path: slots 1..len with no gaps, URL and root moving
// together under shifts.

import (
	"context"
	neturl "net/url"
	"strconv"
	"strings"
	"time"

	"rk/internal/present"
)

// webNowFn is the clock behind WebAdd's ?v= refresh — a seam so tests can pin
// the cache-buster (mirrors cmd/rk's presentNowFn).
var webNowFn = func() int64 { return time.Now().Unix() }

// WebTabFamily is one window's dense web-tab state plus its layout option,
// read in one tmux call.
type WebTabFamily struct {
	Tabs   []string // dense; index 0 is tmux slot 1
	Roots  []string // parallel to Tabs; "" where the slot has no root
	Active int      // 1-based; 0 when no tabs (the clampWebActive degrade rule)
	Layout string   // raw @rk_win_layout value ("" when unset)
}

// webFamilyFormat is the display-message format behind ReadWebTabFamily: the
// MaxWebTabs URL slots, the MaxWebTabs roots, the active pointer, the layout,
// and the retired @rk_win_url (dual-read web_1 fallback), tab-delimited in one
// call.
var webFamilyFormat = func() string {
	fields := make([]string, 0, 2*MaxWebTabs+3)
	for n := 1; n <= MaxWebTabs; n++ {
		fields = append(fields, "#{"+WebTabOption(n)+"}")
	}
	for n := 1; n <= MaxWebTabs; n++ {
		fields = append(fields, "#{"+WebTabRootOption(n)+"}")
	}
	return strings.Join(append(fields,
		"#{"+WebActiveOption+"}",
		"#{"+LayoutOption+"}",
		"#{"+legacyWinURLOption+"}",
	), listDelim)
}()

// webRootsFormat is the list-windows format behind ListDeclaredWebRoots: the
// MaxWebTabs root slots spelled out (the same fixed-format trick as
// webFamilyFormat — a format string cannot enumerate a family, so the slots
// are literal), tab-delimited per window row.
var webRootsFormat = func() string {
	fields := make([]string, 0, MaxWebTabs)
	for n := 1; n <= MaxWebTabs; n++ {
		fields = append(fields, "#{"+WebTabRootOption(n)+"}")
	}
	return strings.Join(fields, listDelim)
}()

// ReadWebTabFamily reads the window's web-tab family in one tmux call: the
// dense URL slots (walked to the first empty — a hand-written gap degrades to
// the prefix), their parallel roots, and the clamped active pointer. When slot
// 1 is empty the retired @rk_win_url dual-reads as a single-tab fallback (the
// frontend polls it mid-session), so the Web* verbs operate on the same
// effective family ListWindows surfaces.
func ReadWebTabFamily(ctx context.Context, windowID, server string) (WebTabFamily, error) {
	lines, err := tmuxExecServer(ctx, server, "display-message", "-p", "-t", windowID, webFamilyFormat)
	if err != nil {
		return WebTabFamily{}, err
	}
	var f WebTabFamily
	if len(lines) == 0 {
		return f, nil
	}
	parts := strings.Split(lines[0], listDelim)
	end := min(MaxWebTabs, len(parts))
	f.Tabs = denseWebTabs(parts[:end])
	var legacyURL string
	if len(parts) > 2*MaxWebTabs+2 {
		legacyURL = strings.TrimSpace(parts[2*MaxWebTabs+2])
	}
	if len(f.Tabs) == 0 && legacyURL != "" {
		// @rk_win_url is never swept (see the legacyOptions comment); with no
		// web_1 it IS the family's first tab. Roots stay empty — the retired
		// name carried no parallel root on this path.
		f.Tabs = []string{legacyURL}
		f.Roots = []string{""}
	} else {
		f.Roots = make([]string, len(f.Tabs))
		for i := range f.Tabs {
			if len(parts) > MaxWebTabs+i {
				f.Roots[i] = strings.TrimSpace(parts[MaxWebTabs+i])
			}
		}
	}
	var activeRaw string
	if len(parts) > 2*MaxWebTabs {
		activeRaw = parts[2*MaxWebTabs]
	}
	f.Active = clampWebActive(activeRaw, len(f.Tabs))
	if len(parts) > 2*MaxWebTabs+1 {
		f.Layout = strings.TrimSpace(parts[2*MaxWebTabs+1])
	}
	return f, nil
}

// WebAdd appends url to the window's web-tab family and returns its 1-based
// index. Idempotent on an identical stored URL: returns (existing, true) with
// no append. For /present/ URLs identity is the TARGET (window, name, server,
// serve root — the slot index and ?v= cache-buster are incidental), so a
// re-presented target finds its existing slot, and the hit ALSO rewrites the
// slot with a fresh ?v= cache-buster (the re-present-is-refresh contract,
// falling out of the add verb). root, when non-empty, is written to
// WebTabRootOption(n); when empty the slot's root is unset (a port/URL target
// replacing a stale file/dir root). WebActiveOption is set to 1 only when the
// family was empty before — the first tab becomes active; otherwise the
// pointer is untouched ("add" is not "show"). Returns ErrWebTabsFull when the
// family already holds MaxWebTabs tabs and url is new. Every write rides one
// chained SetWindowOptions call.
func WebAdd(ctx context.Context, windowID, server, url, root string) (int, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	f, err := ReadWebTabFamily(ctx, windowID, server)
	if err != nil {
		return 0, false, err
	}
	for i, tab := range f.Tabs {
		if !webTabURLIdentical(tab, url) {
			continue
		}
		n := i + 1
		if strings.HasPrefix(tab, "/present/") {
			// The URL alone under-identifies a /present/ target: a directory
			// URL carries no name, and two files can share a basename — so
			// the serve root is part of the identity. Two roots = two tabs.
			// An empty stored root (the @rk_win_url dual-read path carries
			// none) is a wildcard that adopts the incoming root on the hit.
			stored := ""
			if i < len(f.Roots) {
				stored = f.Roots[i]
			}
			if stored != "" && root != "" && stored != root {
				continue
			}
			var ops []WindowOptionOp
			// Same-form hit: the bump rewrites the STORED url — its identity
			// pattern is the same form in both, so BumpVersion keeps the
			// form's own shape and only refreshes ?v=. Cross-form hit
			// (stored-legacy → incoming-new): rewrite the stored slot to the
			// incoming new-form URL with its fresh ?v= — WebAdd's upgrade-
			// on-re-present path dissolves the legacy form with ordinary
			// use, not a sweep.
			sid, sok := presentTargetIdentity(tab)
			iid, iok := presentTargetIdentity(url)
			rewritten := url // cross-form default: adopt the incoming URL
			if !sok || !iok || sid[:1] == iid[:1] {
				// Same form (or a degenerate parse — an ok=false identity is
				// empty, so the ok guards must run BEFORE the [:1] slices):
				// only refresh the buster in place, preserving the form's own
				// shape.
				rewritten = present.BumpVersion(tab, webNowFn)
			}
			if rewritten != tab {
				ops = append(ops, WindowOptionOp{Key: WebTabOption(n), Value: &rewritten})
			}
			if stored == "" && root != "" {
				ops = append(ops, WindowOptionOp{Key: WebTabRootOption(n), Value: &root})
			}
			if len(ops) > 0 {
				if err := SetWindowOptions(ctx, windowID, server, ops); err != nil {
					return 0, false, err
				}
			}
		}
		return n, true, nil
	}
	if len(f.Tabs) == MaxWebTabs {
		return 0, false, ErrWebTabsFull
	}
	n := len(f.Tabs) + 1
	ops := []WindowOptionOp{{Key: WebTabOption(n), Value: &url}}
	if root != "" {
		ops = append(ops, WindowOptionOp{Key: WebTabRootOption(n), Value: &root})
	} else {
		ops = append(ops, WindowOptionOp{Key: WebTabRootOption(n), Value: nil})
	}
	if len(f.Tabs) == 0 {
		active := "1"
		ops = append(ops, WindowOptionOp{Key: WebActiveOption, Value: &active})
	}
	if err := SetWindowOptions(ctx, windowID, server, ops); err != nil {
		return 0, false, err
	}
	return n, false, nil
}

// WebRemove unsets slot n and shifts slots n+1..len down by one — URL AND root
// move together — then unsets the former last slot and its root. The active
// pointer repoints per repointActive (an emptied family unsets it). n outside
// 1..len is ErrWebTabRange and writes nothing. Every write rides one chained
// SetWindowOptions call.
func WebRemove(ctx context.Context, windowID, server string, n int) error {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	f, err := ReadWebTabFamily(ctx, windowID, server)
	if err != nil {
		return err
	}
	if n < 1 || n > len(f.Tabs) {
		return ErrWebTabRange
	}
	tabs, roots := shiftWebTabs(f.Tabs, f.Roots, n)
	ops := make([]WindowOptionOp, 0, 2*len(tabs)+3)
	for i, tab := range tabs {
		v := tab
		ops = append(ops, WindowOptionOp{Key: WebTabOption(i + 1), Value: &v})
		if roots[i] != "" {
			r := roots[i]
			ops = append(ops, WindowOptionOp{Key: WebTabRootOption(i + 1), Value: &r})
		} else {
			ops = append(ops, WindowOptionOp{Key: WebTabRootOption(i + 1), Value: nil})
		}
	}
	// The former last slot (now one past the dense end) and its root go away.
	ops = append(ops,
		WindowOptionOp{Key: WebTabOption(len(tabs) + 1), Value: nil},
		WindowOptionOp{Key: WebTabRootOption(len(tabs) + 1), Value: nil},
	)
	// Removing the last tab also clears the retired @rk_win_url dual-read
	// source — otherwise an emptied family would resurrect it as web_1 on the
	// next read (the live-flip unset path the frontend exercises).
	if len(tabs) == 0 {
		ops = append(ops, WindowOptionOp{Key: legacyWinURLOption, Value: nil})
	}
	switch newActive := repointActive(f.Active, n, len(tabs)); {
	case newActive == 0:
		ops = append(ops, WindowOptionOp{Key: WebActiveOption, Value: nil})
	case newActive != f.Active:
		v := strconv.Itoa(newActive)
		ops = append(ops, WindowOptionOp{Key: WebActiveOption, Value: &v})
	}
	return SetWindowOptions(ctx, windowID, server, ops)
}

// WebSelect sets WebActiveOption=n; n outside 1..len is ErrWebTabRange and
// writes nothing.
func WebSelect(ctx context.Context, windowID, server string, n int) error {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	f, err := ReadWebTabFamily(ctx, windowID, server)
	if err != nil {
		return err
	}
	if n < 1 || n > len(f.Tabs) {
		return ErrWebTabRange
	}
	v := strconv.Itoa(n)
	return SetWindowOptions(ctx, windowID, server, []WindowOptionOp{{Key: WebActiveOption, Value: &v}})
}

// ListDeclaredWebRoots enumerates, in one `list-windows -a -F` call, every
// serve root any window on the server currently declares (the
// @rk_win_web_<n>_root options) — deduplicated and in first-seen order. Empty
// slots are skipped; the retired @rk_win_present_root stays out of scope (its
// dual-read rides the legacy /present/@N route arm). The /present/ content
// route re-derives this set on EVERY request (Constitution II/X): a root
// resolves only while at least one live window declares it. Empty input is a
// null error with a nil slice (tmuxExec returns no lines).
func ListDeclaredWebRoots(ctx context.Context, server string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	lines, err := tmuxExecServer(ctx, server, "list-windows", "-a", "-F", webRootsFormat)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var roots []string
	for _, line := range lines {
		for _, field := range strings.Split(line, listDelim) {
			root := strings.TrimSpace(field)
			if root == "" || seen[root] {
				continue
			}
			seen[root] = true
			roots = append(roots, root)
		}
	}
	return roots, nil
}

// WebMove moves slot n (1-based) to position to (1-based): the tab leaves n
// and inserts at to, URL and root moving as a pair (the shiftWebTabs paired
// precedent). The active pointer repoints to follow tab identity — the moved
// tab lands at to, the slots between n and to shift by one step (the
// repointMoveActive rule). n or to outside 1..len is ErrWebTabRange and writes
// nothing; n == to is a no-op success. Every write rides one chained
// SetWindowOptions call.
func WebMove(ctx context.Context, windowID, server string, n, to int) error {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	f, err := ReadWebTabFamily(ctx, windowID, server)
	if err != nil {
		return err
	}
	if n < 1 || n > len(f.Tabs) || to < 1 || to > len(f.Tabs) {
		return ErrWebTabRange
	}
	if n == to {
		return nil
	}
	tabs, roots := moveWebTabs(f.Tabs, f.Roots, n, to)
	ops := make([]WindowOptionOp, 0, 2*len(tabs)+1)
	for i, tab := range tabs {
		v := tab
		ops = append(ops, WindowOptionOp{Key: WebTabOption(i + 1), Value: &v})
		if roots[i] != "" {
			r := roots[i]
			ops = append(ops, WindowOptionOp{Key: WebTabRootOption(i + 1), Value: &r})
		} else {
			ops = append(ops, WindowOptionOp{Key: WebTabRootOption(i + 1), Value: nil})
		}
	}
	if newActive := repointMoveActive(f.Active, n, to); newActive != f.Active {
		v := strconv.Itoa(newActive)
		ops = append(ops, WindowOptionOp{Key: WebActiveOption, Value: &v})
	}
	return SetWindowOptions(ctx, windowID, server, ops)
}

// shiftWebTabs removes slot n (1-based) from the dense family, shifting the
// slots above it down by one — URL and root move together. roots is parallel
// to tabs ("" where a slot has no root) and may be shorter than tabs.
func shiftWebTabs(tabs, roots []string, n int) ([]string, []string) {
	newTabs := make([]string, 0, len(tabs)-1)
	newRoots := make([]string, 0, len(tabs)-1)
	for j, tab := range tabs {
		if j == n-1 {
			continue
		}
		newTabs = append(newTabs, tab)
		root := ""
		if j < len(roots) {
			root = roots[j]
		}
		newRoots = append(newRoots, root)
	}
	return newTabs, newRoots
}

// moveWebTabs removes slot n (1-based) and reinserts it at position to
// (1-based) — the moved tab's final position. Slots shift around it; URL and
// root move together. roots is parallel to tabs ("" where a slot has no root)
// and may be shorter than tabs.
func moveWebTabs(tabs, roots []string, n, to int) ([]string, []string) {
	src := n - 1
	dst := to - 1
	idx := make([]int, len(tabs))
	for i := range idx {
		idx[i] = i
	}
	moved := idx[src]
	idx = append(idx[:src], idx[src+1:]...)
	idx = append(idx[:dst], append([]int{moved}, idx[dst:]...)...)
	newTabs := make([]string, len(tabs))
	newRoots := make([]string, len(tabs))
	for pos, orig := range idx {
		newTabs[pos] = tabs[orig]
		newRoots[pos] = ""
		if orig < len(roots) {
			newRoots[pos] = roots[orig]
		}
	}
	return newTabs, newRoots
}

// repointMoveActive computes the active pointer after slot n moves to position
// to: the moved tab lands at to, and the slots strictly between n and to shift
// one step the other way — so the pointer follows the moved/affected slots'
// identity.
func repointMoveActive(active, n, to int) int {
	if active == n {
		return to
	}
	if n < to && active > n && active <= to {
		return active - 1
	}
	if n > to && active >= to && active < n {
		return active + 1
	}
	return active
}

// repointActive computes the active pointer after slot n leaves a family that
// now holds newLen tabs: 0 when the family is empty (the caller unsets the
// option); active == n → min(n, newLen); active > n → active-1; active < n →
// unchanged.
func repointActive(active, n, newLen int) int {
	if newLen == 0 {
		return 0
	}
	switch {
	case active == n:
		return min(n, newLen)
	case active > n:
		return active - 1
	default:
		return active
	}
}

// webTabURLIdentical reports slot identity between a stored and an incoming
// URL: /present/ URLs compare by TARGET identity — same-form hits use the
// form's own identity (legacy: windowId+path tail+query-minus-v; new:
// server+hash+path tail); a LEGACY↔NEW pair matches on the path tail alone
// (the upgrade-on-re-present seam — WebAdd's root comparison is the decisive
// tie-breaker there). The slot index and the ?v= cache-buster embedded in the
// path/query legitimately differ between two computes of one target (a
// re-present must find its existing slot, not append a duplicate). Every
// other URL kind compares verbatim.
func webTabURLIdentical(stored, incoming string) bool {
	if stored == incoming {
		return true
	}
	sid, sok := presentTargetIdentity(stored)
	iid, iok := presentTargetIdentity(incoming)
	if !sok || !iok {
		return false
	}
	// Same form → exact identity equality. Cross form → path-tail equality
	// (the re-present upgrade seam: path tail is the LAST "\n"-delimited field
	// of an identity in both forms).
	if sid[:1] == iid[:1] {
		return sid == iid
	}
	return identityTail(sid) == identityTail(iid)
}

// identityTail extracts the final "\n"-delimited field of a present identity
// (the path tail in both forms) for the cross-form comparison.
func identityTail(identity string) string {
	idx := strings.LastIndex(identity, "\n")
	if idx >= 0 {
		return identity[idx+1:]
	}
	return identity
}

// presentTargetIdentity extracts the target identity of a /present/ URL.
// The legacy slot form (/present/@N/{n}/{path}?server=) resolves to
// (windowId, path tail, query-minus-v); the new content-keyed form
// (/present/{server}/{hash}/{path}) resolves to (server, hash, path tail).
// ?v= is dropped in both forms — the cache-buster is slot plumbing, not
// target identity. ok=false for non-/present/ or unparseable URLs.
func presentTargetIdentity(raw string) (identity string, ok bool) {
	u, err := neturl.Parse(raw)
	if err != nil || !strings.HasPrefix(u.Path, "/present/") {
		return "", false
	}
	rest := strings.TrimPrefix(u.Path, "/present/")
	first, remainder, found := strings.Cut(rest, "/")
	if !found {
		return "", false
	}
	segments := strings.Split(remainder, "/")
	q := u.Query()
	q.Del("v")
	if strings.HasPrefix(first, "@") {
		// LEGACY slot form — windowId + optional slot + query-minus-v. The "l"
		// form prefix keeps a legacy and a new URL that share every part from
		// collapsing to one identity. The path tail is the FINAL field so
		// identityTail reads it from both forms on the cross-form seam.
		if len(segments) > 1 && webSlotSegment(segments[0]) {
			segments = segments[1:]
		}
		return "l\n" + first + "\n" + q.Encode() + "\n" + strings.Join(segments, "/"), true
	}
	// NEW content-keyed form — (server, hash, path tail). The "n" form prefix
	// pairs with "l"; an empty hash segment fails closed (strings.Split never
	// yields an empty slice — "/present/{server}/" arrives as [""], so the
	// emptiness check is on the segment, not the slice). The path tail is the
	// FINAL field so identityTail reads it from both forms on the cross-form
	// seam.
	hash := segments[0]
	if hash == "" {
		return "", false
	}
	tail := strings.Join(segments[1:], "/")
	return "n\n" + first + "\n" + hash + "\n" + q.Encode() + "\n" + tail, true
}

// legacyPresentSlotMax pins the slot bound of the RETIRED /present/@N/{n}/
// URL form: the form was only ever composed under the 8-slot cap, so its
// sniff gate stays ^[1-8]$ regardless of MaxWebTabs (api/present.go
// presentSlotPattern is the routing-side twin — the two must agree).
const legacyPresentSlotMax = 8

// webSlotSegment reports whether a path segment is a web-tab slot index in the
// retired slot form (mirrors the ^[1-8]$ gate — the /present/ route's sniff
// rule).
func webSlotSegment(segment string) bool {
	if len(segment) != 1 {
		return false
	}
	return segment[0] >= '1' && segment[0] <= '0'+legacyPresentSlotMax
}
