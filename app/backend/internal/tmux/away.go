package tmux

// Cross-window layout facts: a foreign leaf ("@A/<kind>") in one window's
// layout makes that window the HOLDER of another window's surface. The two
// derivations over that fact — the home window's awayIn map and the
// live-in-one-place write check — share the holdings walk so they cannot
// drift. Both are pure (no I/O): the caller supplies the server's windows.

import (
	"fmt"

	"rk/internal/layoutspec"
)

// LeafHeldError reports a layout write that would put a foreign leaf live in
// a second place: another window's layout already holds the same address.
type LeafHeldError struct {
	Address string
	Holder  string
}

func (e *LeafHeldError) Error() string {
	return fmt.Sprintf("surface %s is already live in tab %s — use POST /api/layout/borrow to move it", e.Address, e.Holder)
}

// foreignHoldings maps each foreign-leaf address appearing in any window's
// parsed layout to its holder's window id. Two windows naming the same
// address (a hand-written race) resolve deterministically: the first in
// window-list order wins. Windows whose layout is unset or fails to parse
// hold nothing (read-side tolerance — a malformed value must never break the
// fetch or a write check).
func foreignHoldings(windows []WindowInfo) map[string]string {
	holdings := map[string]string{}
	for _, w := range windows {
		if w.Layout == "" {
			continue
		}
		tree, err := layoutspec.Parse(w.Layout)
		if err != nil {
			continue
		}
		for _, id := range tree.LeafIDs() {
			if _, _, ok := layoutspec.ParseLeafAddress(id); !ok {
				continue
			}
			if _, taken := holdings[id]; !taken {
				holdings[id] = w.WindowID
			}
		}
	}
	return holdings
}

// LeafHolder returns the id of the window whose parsed layout holds the given
// foreign-leaf address, excluding `exclude` (the writer itself) — the
// foreignHoldings lookup with the writer filtered out.
func LeafHolder(windows []WindowInfo, address, exclude string) (string, bool) {
	holder, held := foreignHoldings(windows)[address]
	if !held || holder == exclude {
		return "", false
	}
	return holder, true
}

// DeriveAwayIn populates each window's AwayIn in place from the server's
// window set: a foreign leaf "@A/<kind>" in window W's layout, where A exists
// in the set and A ≠ W, sets A.AwayIn[kind] = W. Leaves naming dead windows
// and self-naming leaves are ignored; duplicate holders resolve first-wins in
// list order (foreignHoldings). Callers pass EVERY window of one server — @N
// ids are unique per server, so a holder may live in any session.
func DeriveAwayIn(windows []WindowInfo) {
	byID := make(map[string]int, len(windows))
	for i, w := range windows {
		byID[w.WindowID] = i
	}
	for address, holder := range foreignHoldings(windows) {
		home, kind, ok := layoutspec.ParseLeafAddress(address)
		if !ok || home == holder {
			continue
		}
		homeIdx, exists := byID[home]
		if !exists {
			continue
		}
		if windows[homeIdx].AwayIn == nil {
			windows[homeIdx].AwayIn = map[string]string{}
		}
		windows[homeIdx].AwayIn[kind] = holder
	}
}

// CheckLiveInOnePlace vets a layout tree about to be written to window
// `owner`: canonical validation with the self-window rule (ValidateFor), then
// the live-in-one-place rule — every foreign leaf the tree introduces must be
// unheld or held by the owner itself. A leaf held by a third window yields a
// *LeafHeldError naming that holder; the caller maps it to the conflict
// response of its surface (HTTP 409, CLI error).
func CheckLiveInOnePlace(tree layoutspec.Node, owner string, windows []WindowInfo) error {
	return checkLiveInOnePlace(tree, owner, windows, "")
}

// CheckLiveInOnePlaceExcept is CheckLiveInOnePlace with one exempt foreign-leaf
// address: the borrow endpoint's intended move source — that leaf's current
// holder is expected, so its held state must not trip the check. Every OTHER
// foreign leaf in the tree is still holder-checked.
func CheckLiveInOnePlaceExcept(tree layoutspec.Node, owner string, windows []WindowInfo, exempt string) error {
	return checkLiveInOnePlace(tree, owner, windows, exempt)
}

func checkLiveInOnePlace(tree layoutspec.Node, owner string, windows []WindowInfo, exempt string) error {
	if err := layoutspec.ValidateFor(tree, owner); err != nil {
		return err
	}
	holdings := foreignHoldings(windows)
	for _, id := range tree.LeafIDs() {
		if id == exempt {
			continue
		}
		if _, _, ok := layoutspec.ParseLeafAddress(id); !ok {
			continue
		}
		if holder, held := holdings[id]; held && holder != owner {
			return &LeafHeldError{Address: id, Holder: holder}
		}
	}
	return nil
}
