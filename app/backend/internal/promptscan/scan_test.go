package promptscan

import (
	"strings"
	"testing"
)

func TestScanClasses(t *testing.T) {
	cases := []struct {
		name    string
		content string
		want    Result
	}{
		// Class 1: question mark — last non-empty line only.
		{"question mark last line", "working...\nContinue?", Result{Indicator: IndicatorQuestionMark, Snippet: "Continue?"}},
		{"question mark earlier line only", "Everything ok?\nplain output", Result{Indicator: IndicatorNone, Reason: ReasonNoIndicator}},
		{"question mark 119 chars matches", strings.Repeat("x", 118) + "?", Result{Indicator: IndicatorQuestionMark, Snippet: strings.Repeat("x", 118) + "?"}},
		{"question mark 120 chars too long", strings.Repeat("x", 119) + "?", Result{Indicator: IndicatorNone, Reason: ReasonNoIndicator}},
		{"question mark hash comment", "# is this done?", Result{Indicator: IndicatorNone, Reason: ReasonNoIndicator}},
		{"question mark slash comment", "// is this done?", Result{Indicator: IndicatorNone, Reason: ReasonNoIndicator}},
		{"question mark star bullet", "* is this done?", Result{Indicator: IndicatorNone, Reason: ReasonNoIndicator}},
		{"question mark quote", "> is this done?", Result{Indicator: IndicatorNone, Reason: ReasonNoIndicator}},
		{"question mark timestamped", "12:34 is this done?", Result{Indicator: IndicatorNone, Reason: ReasonNoIndicator}},
		{"question mark trailing whitespace tolerated", "Continue?  ", Result{Indicator: IndicatorQuestionMark, Snippet: "Continue?  "}},
		// Classes 2–7.
		{"yes no bracket", "Overwrite file [y/N]", Result{Indicator: IndicatorYesNo, Snippet: "Overwrite file [y/N]"}},
		{"yes no parens", "continue (YES/NO)", Result{Indicator: IndicatorYesNo, Snippet: "continue (YES/NO)"}},
		{"action word above plain last line", "Allow?\nprocessing done", Result{Indicator: IndicatorActionWord, Snippet: "Allow?"}},
		{"action word case sensitive", "allow?\nprocessing done", Result{Indicator: IndicatorNone, Reason: ReasonNoIndicator}},
		{"imperative question", "Do you want to proceed", Result{Indicator: IndicatorImperativeQuestion, Snippet: "Do you want to proceed"}},
		{"imperative question case-insensitive", "should I continue", Result{Indicator: IndicatorImperativeQuestion, Snippet: "should I continue"}},
		{"colon prompt", "Enter your name:", Result{Indicator: IndicatorColonPrompt, Snippet: "Enter your name:"}},
		{"enumerated options", "1) yes  2) no", Result{Indicator: IndicatorEnumeratedOptions, Snippet: "1) yes  2) no"}},
		{"press key", "Press any key to continue", Result{Indicator: IndicatorPressKey, Snippet: "Press any key to continue"}},
		{"hit enter", "hit enter to accept", Result{Indicator: IndicatorPressKey, Snippet: "hit enter to accept"}},
		// Ordering rules.
		{"bottom-most wins", "Allow?\n1) yes  2) no", Result{Indicator: IndicatorEnumeratedOptions, Snippet: "1) yes  2) no"}},
		{"last line class 1 beats yes_no", "Continue [Y/n]?", Result{Indicator: IndicatorQuestionMark, Snippet: "Continue [Y/n]?"}},
		{"class order within a line", "Proceed? [y/n]", Result{Indicator: IndicatorYesNo, Snippet: "Proceed? [y/n]"}},
		// Blank lines skipped; trailing newline tolerated.
		{"blank lines ignored", "first\n\nContinue?\n\n", Result{Indicator: IndicatorQuestionMark, Snippet: "Continue?"}},
		{"no indicator", "building...\ndone", Result{Indicator: IndicatorNone, Reason: ReasonNoIndicator}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Scan(tc.content); got != tc.want {
				t.Errorf("Scan(%q) = %+v, want %+v", tc.content, got, tc.want)
			}
		})
	}
}

func TestScanGuards(t *testing.T) {
	cases := []struct {
		name    string
		content string
		want    Result
	}{
		{"empty", "", Result{Indicator: IndicatorNone, Reason: ReasonBlankCapture}},
		{"whitespace only", "  \n \t\n  ", Result{Indicator: IndicatorNone, Reason: ReasonBlankCapture}},
		{"last line bare prompt", "Continue?\n>\n", Result{Indicator: IndicatorNone, Reason: ReasonTurnBoundary}},
		{"second-to-last bare prompt padded", "output\n > \ntrailing", Result{Indicator: IndicatorNone, Reason: ReasonTurnBoundary}},
		{"prompt above last two lines is not a boundary", ">\nline1\nline2\nContinue?", Result{Indicator: IndicatorQuestionMark, Snippet: "Continue?"}},
		{"prompt with text is not a boundary", "output\n> echo hi?", Result{Indicator: IndicatorNone, Reason: ReasonNoIndicator}},
		{"blank guard precedes turn boundary", "\n\n", Result{Indicator: IndicatorNone, Reason: ReasonBlankCapture}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Scan(tc.content); got != tc.want {
				t.Errorf("Scan(%q) = %+v, want %+v", tc.content, got, tc.want)
			}
		})
	}
}

// A harness's arrow-key menu is recognised by its footer and reports the
// option under the cursor; it wins over the option rows' own classes.
func TestScanSelectMenu(t *testing.T) {
	menu := "How should I handle the spec?\n\n❯ 1. Repoint the locators (Recommended)\n     Edit only the bullets.\n  2. Drop the dead bullets only\n  3. Leave the spec, I'll handle it\n  4. Type something.\n──────\n  5. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n"
	got := Scan(menu)
	want := Result{Indicator: IndicatorSelectMenu, Input: InputKeys, Highlighted: 1, Snippet: "❯ 1. Repoint the locators (Recommended)"}
	if got != want {
		t.Errorf("Scan(menu) = %+v, want %+v", got, want)
	}
	moved := strings.Replace(menu, "❯ 1.", "  1.", 1)
	moved = strings.Replace(moved, "  3. Leave", "❯ 3. Leave", 1)
	if got := Scan(moved); got.Highlighted != 3 || got.Input != InputKeys {
		t.Errorf("Scan(moved) = %+v, want highlighted 3", got)
	}
	// Status lines under the footer, as a real capture carries them.
	withStatus := menu + "───────── scr-s1 ─\n  ━━━━ · $1.58\n  ⏵⏵ bypass permissions on\n"
	if got := Scan(withStatus); got.Indicator != IndicatorSelectMenu || got.Highlighted != 1 {
		t.Errorf("menu with status lines = %+v, want select_menu highlighted 1", got)
	}
	if got := Scan("1) yes  2) no\n"); got.Indicator != IndicatorEnumeratedOptions || got.Input != "" {
		t.Errorf("a plain numbered prompt must stay enumerated_options with no input hint: %+v", got)
	}
}

// Text that only mentions a menu's hint is not a menu: a transcript quoting
// the UI above a composer, a README line, a shell message, or an answered
// menu with a fresh composer below it. Each of these used to refuse a send.
func TestScanSelectMenuFalsePositives(t *testing.T) {
	menu := "❯ 1. Yes\n  2. No\nEnter to select · ↑/↓ to navigate\n"
	cases := []struct{ name, content, want string }{
		{"quoted hint above an empty composer", "⏺ The menu shows `Enter to select · ↑/↓ to navigate`\n\n> \n", IndicatorNone},
		{"README line above a composer with text", "Use arrow keys to navigate, Enter to select.\n❯ typed\n", IndicatorNone},
		{"shell message, no cursor row", "Press Enter to select the default.\n$ \n", IndicatorPressKey},
		{"answered menu with a new composer below", menu + strings.Repeat("output\n", 6) + "> \n", IndicatorNone},
		{"footer far above the bottom", menu + strings.Repeat("later output\n", 10), IndicatorNone},
		{"composer line starting with a number is not a cursor row", "❯ 1. first thing to do\n", IndicatorNone},
		{"boxed composer below an old menu", menu + "╭────╮\n│ >  │\n╰────╯\n", IndicatorNone},
		{"shell prompt below printed menu text", "$ cat ui.txt\n> 1. Yes\n  2. No\nEnter to select\n$ \n", IndicatorNone},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Scan(tc.content); got.Indicator != tc.want || got.Input != "" {
				t.Errorf("Scan() = %+v, want indicator %q", got, tc.want)
			}
		})
	}
}
