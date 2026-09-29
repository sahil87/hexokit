package tmux

import (
	"errors"
	"testing"

	"rk/internal/layoutspec"
)

func TestDeriveAwayIn(t *testing.T) {
	windows := []WindowInfo{
		{WindowID: "@3", Layout: "tty"},
		{WindowID: "@7", Layout: "h(tty,@3/tty)"},
		{WindowID: "@9", Layout: "h(tty,@44/tty)"}, // @44 is dead
	}
	DeriveAwayIn(windows)

	if got := windows[0].AwayIn["tty"]; got != "@7" {
		t.Errorf("@3 awayIn = %v, want tty held by @7", windows[0].AwayIn)
	}
	if windows[1].AwayIn != nil {
		t.Errorf("@7 awayIn = %v, want empty", windows[1].AwayIn)
	}
	if windows[2].AwayIn != nil {
		t.Errorf("@9 awayIn = %v, want empty (dead homes derive nothing)", windows[2].AwayIn)
	}
	for _, w := range windows {
		for _, holder := range w.AwayIn {
			if holder == "@44" {
				t.Errorf("awayIn names dead window @44: %+v", w.AwayIn)
			}
		}
	}
}

// Two holders naming the same address (a hand-written race) resolve
// deterministically: the first in window-list order wins.
func TestDeriveAwayInDuplicateHolderFirstWins(t *testing.T) {
	windows := []WindowInfo{
		{WindowID: "@3", Layout: "tty"},
		{WindowID: "@7", Layout: "h(tty,@3/tty)"},
		{WindowID: "@9", Layout: "h(tty,@3/tty)"},
	}
	DeriveAwayIn(windows)

	if got := windows[0].AwayIn["tty"]; got != "@7" {
		t.Errorf("@3 awayIn = %v, want the first holder @7", windows[0].AwayIn)
	}
}

// A foreign leaf naming its own window is ignored.
func TestDeriveAwayInSelfLeafIgnored(t *testing.T) {
	windows := []WindowInfo{
		{WindowID: "@7", Layout: "h(@7/tty,@3/tty)"},
		{WindowID: "@3", Layout: "tty"},
	}
	DeriveAwayIn(windows)

	if windows[0].AwayIn != nil {
		t.Errorf("@7 awayIn = %v, want empty (self-leaf ignored)", windows[0].AwayIn)
	}
	if got := windows[1].AwayIn["tty"]; got != "@7" {
		t.Errorf("@3 awayIn = %v, want tty held by @7", windows[1].AwayIn)
	}
}

// A window whose stored layout fails to parse holds nothing and must not
// break the derivation of the others.
func TestDeriveAwayInMalformedLayoutIgnored(t *testing.T) {
	windows := []WindowInfo{
		{WindowID: "@7", Layout: "h(tty,@3/tty"},
		{WindowID: "@9", Layout: "h(tty,@3/tty)"},
		{WindowID: "@3", Layout: "tty"},
	}
	DeriveAwayIn(windows)

	if got := windows[2].AwayIn["tty"]; got != "@9" {
		t.Errorf("@3 awayIn = %v, want tty held by @9 (the malformed @7 ignored)", windows[2].AwayIn)
	}
}

func mustParse(t *testing.T, raw string) layoutspec.Node {
	t.Helper()
	n, err := layoutspec.Parse(raw)
	if err != nil {
		t.Fatalf("Parse(%q): %v", raw, err)
	}
	return n
}

func TestCheckLiveInOnePlace(t *testing.T) {
	windows := []WindowInfo{
		{WindowID: "@3", Layout: "tty"},
		{WindowID: "@7", Layout: "h(tty,@3/tty)"},
	}

	t.Run("unheld foreign leaf passes", func(t *testing.T) {
		tree := mustParse(t, "h(tty,@3/web)")
		if err := CheckLiveInOnePlace(tree, "@9", windows); err != nil {
			t.Errorf("unheld @3/web write: %v", err)
		}
	})

	t.Run("held by the writer itself passes", func(t *testing.T) {
		tree := mustParse(t, "h(tty,@3/tty)")
		if err := CheckLiveInOnePlace(tree, "@7", windows); err != nil {
			t.Errorf("@7 rewriting its own holding: %v", err)
		}
	})

	t.Run("held by a third window is a LeafHeldError", func(t *testing.T) {
		tree := mustParse(t, "h(tty,@3/tty)")
		err := CheckLiveInOnePlace(tree, "@9", windows)
		var held *LeafHeldError
		if !errors.As(err, &held) {
			t.Fatalf("err = %v, want *LeafHeldError", err)
		}
		if held.Address != "@3/tty" || held.Holder != "@7" {
			t.Errorf("held = %+v, want @3/tty held by @7", held)
		}
	})

	t.Run("self-window leaf rejected without any holder", func(t *testing.T) {
		tree := mustParse(t, "h(tty,@9/tty)")
		err := CheckLiveInOnePlace(tree, "@9", windows)
		var held *LeafHeldError
		if err == nil || errors.As(err, &held) {
			t.Errorf("err = %v, want the self-window validation error (not LeafHeldError)", err)
		}
	})
}

func TestCheckLiveInOnePlaceExcept(t *testing.T) {
	windows := []WindowInfo{
		{WindowID: "@3", Layout: "tty"},
		{WindowID: "@5", Layout: "tty"},
		{WindowID: "@7", Layout: "h(tty,@3/tty)"},
		{WindowID: "@8", Layout: "h(tty,@5/tty)"},
	}

	t.Run("the exempt address is skipped", func(t *testing.T) {
		tree := mustParse(t, "h(tty,@3/tty)")
		if err := CheckLiveInOnePlaceExcept(tree, "@9", windows, "@3/tty"); err != nil {
			t.Errorf("borrow of @7's held leaf: %v", err)
		}
	})

	t.Run("a second held leaf still conflicts", func(t *testing.T) {
		tree := mustParse(t, "h(tty,@3/tty,@5/tty)")
		err := CheckLiveInOnePlaceExcept(tree, "@9", windows, "@3/tty")
		var held *LeafHeldError
		if !errors.As(err, &held) {
			t.Fatalf("err = %v, want *LeafHeldError", err)
		}
		if held.Address != "@5/tty" || held.Holder != "@8" {
			t.Errorf("LeafHeldError = %+v, want {@5/tty @8}", held)
		}
	})
}
