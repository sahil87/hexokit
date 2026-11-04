package tabaddr

import (
	"testing"
)

func TestParseAcceptedForms(t *testing.T) {
	tests := []struct {
		in   string
		want Addr
	}{
		{"", Addr{}},
		{"@12", Addr{WindowID: "@12"}},
		{"@1", Addr{WindowID: "@1"}},
		{"@12/web", Addr{WindowID: "@12", Surface: "web"}},
		{"@12/tty", Addr{WindowID: "@12", Surface: "tty"}},
		{"@12/web/3", Addr{WindowID: "@12", Surface: "web", Index: 3}},
		{"@12/web/1", Addr{WindowID: "@12", Surface: "web", Index: 1}},
		{"@12/web/8", Addr{WindowID: "@12", Surface: "web", Index: 8}},
		{"@12/web/16", Addr{WindowID: "@12", Surface: "web", Index: 16}},
		{"web", Addr{Surface: "web"}},
		{"code", Addr{Surface: "code"}},
		{"web/3", Addr{Surface: "web", Index: 3}},
		{"3", Addr{Surface: "web", Index: 3}}, // bare integer = web/<n> on the own tab
		{"1", Addr{Surface: "web", Index: 1}},
		{"8", Addr{Surface: "web", Index: 8}},
		{"16", Addr{Surface: "web", Index: 16}},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			got, err := Parse(tt.in)
			if err != nil {
				t.Fatalf("Parse(%q): %v", tt.in, err)
			}
			if got != tt.want {
				t.Errorf("Parse(%q) = %+v, want %+v", tt.in, got, tt.want)
			}
			// String(Parse(x)) re-parses to the same Addr for every form.
			again, err := Parse(got.String())
			if err != nil || again != got {
				t.Errorf("Parse(String(Parse(%q))) = %+v, %v, want %+v", tt.in, again, err, got)
			}
		})
	}
}

// String round-trips byte-identically on the canonical forms; the bare-integer
// shorthand canonicalizes to web/<n> (one Addr, one spelling).
func TestStringRoundTrip(t *testing.T) {
	for _, in := range []string{"", "@12", "@12/web", "@12/web/3", "web", "web/3", "code"} {
		a, err := Parse(in)
		if err != nil {
			t.Fatalf("Parse(%q): %v", in, err)
		}
		if got := a.String(); got != in {
			t.Errorf("String(Parse(%q)) = %q, want byte-identical round-trip", in, got)
		}
	}
	a, err := Parse("3")
	if err != nil {
		t.Fatalf("Parse(3): %v", err)
	}
	if got := a.String(); got != "web/3" {
		t.Errorf("String(Parse(3)) = %q, want the canonical web/3", got)
	}
}

func TestParseRejections(t *testing.T) {
	for _, in := range []string{
		"@x",         // bad @N
		"@12x",       // bad @N
		"@",          // bad @N
		"@1/web/17",  // <n> above MaxWebTabs
		"@1/web/0",   // <n> below 1
		"@1/web/-1",  // negative <n>
		"17",         // bare integer above MaxWebTabs
		"0",          // bare integer below 1
		"@1/tty/2",   // <n> on a non-web surface
		"@1/code/2",  // <n> on a non-web surface
		"@1/web/3/x", // fourth segment
		"@1/web/3/4", // fourth segment
		"@1//web",    // empty segment
		"/web",       // empty first segment
		"@1/web/",    // empty trailing segment
		"@1/bogus",   // unknown surface
		"desktop",    // spec'd-but-unshipped surface
		"web/x",      // non-integer <n>
		"=s:1",       // session:window qualifiers are cmd/rk's job, not tabaddr's
		"s:1",        // bare session:window is rejected (the rk mux rule)
	} {
		if _, err := Parse(in); err == nil {
			t.Errorf("Parse(%q): err = nil, want rejection", in)
		}
	}
}
