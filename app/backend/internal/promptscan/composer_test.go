package promptscan

import "testing"

func TestScanComposer(t *testing.T) {
	cases := []struct {
		name, escaped string
		want          Composer
	}{
		{"claude ghost suggestion", "output line\n\x1b[39m❯\u00a0 \x1b[2m/fab-ff\x1b[0m\n  status bar\n", Composer{Text: "/fab-ff", Ghost: true, Found: true}},
		{"typed text", "output\n❯ /fab-fff 2611-ab12\n", Composer{Text: "/fab-fff 2611-ab12", Ghost: false, Found: true}},
		{"empty composer", "output\n❯ \n", Composer{Text: "", Ghost: false, Found: true}},
		{"codex glyph", "› \x1b[2msuggested\x1b[22m\n", Composer{Text: "suggested", Ghost: true, Found: true}},
		{"quoted line above the composer is ignored", "> a markdown quote\n❯ typed\n", Composer{Text: "typed", Found: true}},
		{"colour index 2 is not dim", "❯ \x1b[38;5;2mgreen text\x1b[0m\n", Composer{Text: "green text", Ghost: false, Found: true}},
		{"truecolour is not dim", "❯ \x1b[38;2;2;2;2mgrey\x1b[0m\n", Composer{Text: "grey", Ghost: false, Found: true}},
		{"dim then 22 before text", "❯ \x1b[2m\x1b[22mnormal\n", Composer{Text: "normal", Ghost: false, Found: true}},
		{"no composer", "just output\nmore output\n", Composer{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ScanComposer(tc.escaped); got != tc.want {
				t.Errorf("ScanComposer() = %+v, want %+v", got, tc.want)
			}
		})
	}
}
