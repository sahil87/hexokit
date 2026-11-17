package promptscan

import (
	"encoding/json"
	"testing"
)

func TestScanComposer(t *testing.T) {
	cases := []struct {
		name, escaped string
		want          Composer
	}{
		{"claude ghost suggestion", "output line\n\x1b[39m❯\u00a0 \x1b[2m/fab-ff\x1b[0m\n  status bar\n", Composer{Text: "/fab-ff", Ghost: true, Found: true}},
		{"typed text", "output\n❯ /fab-fff 2611-ab12\n", Composer{Text: "/fab-fff 2611-ab12", Found: true}},
		{"empty composer", "output\n❯ \n", Composer{Found: true}},
		{"codex glyph", "› \x1b[2msuggested\x1b[22m\n", Composer{Text: "suggested", Ghost: true, Found: true}},
		{"boxed gemini composer", "│ > typed here   │\n", Composer{Text: "typed here", Found: true}},
		{"quoted line above the composer is ignored", "> a markdown quote\n❯ typed\n", Composer{Text: "typed", Found: true}},
		{"colour index 2 is not dim", "❯ \x1b[38;5;2mgreen text\x1b[0m\n", Composer{Text: "green text", Found: true}},
		{"truecolour is not dim", "❯ \x1b[38;2;2;2;2mgrey\x1b[0m\n", Composer{Text: "grey", Found: true}},
		{"colon-form colour is not dim", "❯ \x1b[38:5:2mx\x1b[0m\n", Composer{Text: "x", Found: true}},
		{"colon-form underline is dropped", "❯ \x1b[4:3mcurly\x1b[0m\n", Composer{Text: "curly", Found: true}},
		{"dim with colour in one sequence", "❯ \x1b[2;37m/fab-ff\x1b[0m\n", Composer{Text: "/fab-ff", Ghost: true, Found: true}},
		{"bold is not dim", "❯ \x1b[1mloud\x1b[0m\n", Composer{Text: "loud", Found: true}},
		{"dim then 22 before text", "❯ \x1b[2m\x1b[22mnormal\n", Composer{Text: "normal", Found: true}},
		{"inverse cursor over the first suggestion character", "❯ \x1b[7m/\x1b[0;2mfab-ff\x1b[0m\n", Composer{Text: "/fab-ff", Ghost: true, Found: true}},
		{"typed prefix with a dim completion is not ghost", "❯ fo\x1b[2mo\x1b[0m\n", Composer{Text: "foo", Found: true}},
		{"cursor-visibility sequence is consumed", "❯ \x1b[?25lhello\x1b[?25h\n", Composer{Text: "hello", Found: true}},
		{"erase sequences are consumed", "❯ \x1b[Khello\x1b[2J\n", Composer{Text: "hello", Found: true}},
		{"OSC hyperlink is consumed", "❯ \x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\\n", Composer{Text: "link", Found: true}},
		{"OSC before the glyph does not hide the line", "\x1b]0;title\x07❯ typed\n", Composer{Text: "typed", Found: true}},
		{"a footer line starting with > masks the composer, failing safe", "❯ /fab-ff\n> quoted in footer\n", Composer{Text: "quoted in footer", Found: true}},
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

func TestComposerJSON(t *testing.T) {
	for _, tc := range []struct {
		c    Composer
		want string
	}{
		{Composer{}, "null"},
		{Composer{Found: true}, `{"text":"","ghost":false}`},
		{Composer{Text: "/fab-ff", Ghost: true, Found: true}, `{"text":"/fab-ff","ghost":true}`},
	} {
		b, err := json.Marshal(tc.c)
		if err != nil || string(b) != tc.want {
			t.Errorf("marshal %+v = %s err %v, want %s", tc.c, b, err, tc.want)
		}
	}
}
