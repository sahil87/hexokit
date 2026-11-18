// Package promptscan classifies captured pane text for a pending prompt —
// a yes/no confirmation, a numbered menu, a colon-terminated input request,
// an open question — so a hook-less pane whose agent state never flips to
// waiting can still be recognised as blocked on a human.
//
// The package is pure text → Result: no tmux, exec, or I/O. Indicator and
// reason identifiers are a cross-tool contract shared verbatim with fab-kit's
// `fab pane questions`, whose classifier this mirrors; that verb is to
// delegate to `rk mux capture --classify` when rk is present and map the
// fields structurally, so renaming any identifier here breaks the contract.
package promptscan

import (
	"regexp"
	"strings"
)

// Indicator class names, one per mechanical prompt shape. IndicatorNone is
// the no-match value; Result.Reason then says why.
const (
	IndicatorQuestionMark       = "question_mark"
	IndicatorYesNo              = "yes_no"
	IndicatorActionWord         = "action_word"
	IndicatorImperativeQuestion = "imperative_question"
	IndicatorColonPrompt        = "colon_prompt"
	IndicatorEnumeratedOptions  = "enumerated_options"
	// IndicatorSelectMenu is a harness's arrow-key menu (Claude Code's
	// AskUserQuestion menus): answered with keys, never text.
	IndicatorSelectMenu = "select_menu"
	// InputKeys is Result.Input for a select menu.
	InputKeys         = "keys"
	IndicatorPressKey = "press_key"
	IndicatorNone     = "none"
)

// Reasons a capture classifies as IndicatorNone.
const (
	ReasonBlankCapture = "blank_capture"
	ReasonTurnBoundary = "turn_boundary"
	ReasonNoIndicator  = "no_indicator"
)

// Result is one classification. Snippet is the matched line verbatim and is
// empty when Indicator is IndicatorNone; Reason is set only then.
type Result struct {
	Indicator string
	Snippet   string
	Reason    string
	// Input is InputKeys for a select menu (typed text is not accepted; the
	// harness reads ↑/↓ and Enter), else empty.
	Input string
	// Highlighted is the 1-based index of the option the menu's cursor is on
	// (0 when unknown); Enter picks it.
	Highlighted int
}

// questionMarkMaxLen bounds class 1: a line at or beyond this length ending
// in "?" is prose, not a prompt.
const questionMarkMaxLen = 120

var (
	// turnBoundaryPattern is Claude Code's bare human-turn prompt — a lone ">"
	// on an otherwise empty line. Its presence in the last two lines means the
	// screen sits at a normal turn boundary, not at a question.
	turnBoundaryPattern       = regexp.MustCompile(`^\s*>\s*$`)
	timestampPrefixPattern    = regexp.MustCompile(`^\s*[\[(]?\d{1,4}[-/:]\d{1,2}`)
	yesNoPattern              = regexp.MustCompile(`(?i)(\[y/n\]|\(y/n\)|\(yes/no\))`)
	actionWordPattern         = regexp.MustCompile(`\b(Allow|Approve|Confirm|Proceed)\?`)
	imperativeQuestionPattern = regexp.MustCompile(`(?i)(Do you want to|Should I|Would you like)`)
	enumeratedOptionsPattern  = regexp.MustCompile(`[1-9]\)`)
	pressKeyPattern           = regexp.MustCompile(`(?i)(Press.*key|press.*enter|hit.*enter)`)
	// selectMenuFooterPattern is the key hint a harness prints under an
	// arrow-key menu.
	selectMenuFooterPattern = regexp.MustCompile(`(?i)(enter to select|↑/↓ to navigate|arrow keys to navigate|use arrow keys)`)
	// selectMenuCursorPattern is the highlighted option row: a cursor glyph
	// before a numbered option.
	selectMenuCursorPattern = regexp.MustCompile(`^\s*[❯›>]\s*(\d{1,2})[.)]\s`)
	// composerLinePattern is a composer or turn-boundary line: a prompt glyph
	// (after an optional box border) alone or followed by text, or a bare
	// shell prompt. A menu never has one below its footer; a transcript that
	// merely mentions a menu's hint does.
	composerLinePattern = regexp.MustCompile(`^\s*[│┃]?\s*[❯›>](\s|$)|^\s*\$\s*$`)
)

// SelectMenuWindow bounds how far above the footer the cursor row is sought
// and how far up the footer itself may sit; a caller that captures a pane
// for the menu check needs at least this many lines.
const SelectMenuWindow = 24

// selectMenuFooterReach is how many non-blank lines from the bottom the
// footer may sit: a live menu ends with its hint, then at most the harness's
// status lines.
const selectMenuFooterReach = 8

// questionMarkExcludedPrefixes are line openers that make a trailing "?"
// commentary or quotation rather than a prompt.
var questionMarkExcludedPrefixes = []string{"#", "//", "*", ">"}

// Scan classifies captured pane text. Guards run first: blank content, then
// a turn boundary in the last two lines. Otherwise non-empty lines are walked
// bottom-most first; class 1 (question-mark ending) applies to the actual last
// line only, classes 2–7 to every line. The first line with any match wins.
func Scan(content string) Result {
	if strings.TrimSpace(content) == "" {
		return Result{Indicator: IndicatorNone, Reason: ReasonBlankCapture}
	}
	lines := splitLines(content)
	if hasTurnBoundary(lines) {
		return Result{Indicator: IndicatorNone, Reason: ReasonTurnBoundary}
	}
	if r, ok := scanSelectMenu(lines); ok {
		return r
	}

	var nonEmpty []string
	for _, l := range lines {
		if strings.TrimSpace(l) != "" {
			nonEmpty = append(nonEmpty, l)
		}
	}
	lastIdx := len(nonEmpty) - 1
	for i := lastIdx; i >= 0; i-- {
		line := nonEmpty[i]
		if i == lastIdx && isQuestionMarkLine(line) {
			return Result{Indicator: IndicatorQuestionMark, Snippet: line}
		}
		if ind, ok := matchOtherClasses(line); ok {
			return Result{Indicator: ind, Snippet: line}
		}
	}
	return Result{Indicator: IndicatorNone, Reason: ReasonNoIndicator}
}

// splitLines splits on "\n", dropping only the single empty element a
// terminating newline leaves behind — real blank lines are preserved.
func splitLines(content string) []string {
	lines := strings.Split(content, "\n")
	if n := len(lines); n > 0 && lines[n-1] == "" {
		lines = lines[:n-1]
	}
	return lines
}

// hasTurnBoundary reports whether either of the last two lines is a bare
// turn-boundary prompt.
func hasTurnBoundary(lines []string) bool {
	start := len(lines) - 2
	if start < 0 {
		start = 0
	}
	for _, l := range lines[start:] {
		if turnBoundaryPattern.MatchString(l) {
			return true
		}
	}
	return false
}

// isQuestionMarkLine implements class 1 against a single line.
func isQuestionMarkLine(line string) bool {
	trimmed := strings.TrimRight(line, " \t")
	if !strings.HasSuffix(trimmed, "?") || len(trimmed) >= questionMarkMaxLen {
		return false
	}
	leading := strings.TrimLeft(line, " \t")
	for _, prefix := range questionMarkExcludedPrefixes {
		if strings.HasPrefix(leading, prefix) {
			return false
		}
	}
	return !timestampPrefixPattern.MatchString(line)
}

// matchOtherClasses tests classes 2–7 against one line in listed order.
func matchOtherClasses(line string) (string, bool) {
	switch {
	case yesNoPattern.MatchString(line):
		return IndicatorYesNo, true
	case actionWordPattern.MatchString(line):
		return IndicatorActionWord, true
	case imperativeQuestionPattern.MatchString(line):
		return IndicatorImperativeQuestion, true
	case strings.HasSuffix(strings.TrimRight(line, " \t"), ":"):
		return IndicatorColonPrompt, true
	case enumeratedOptionsPattern.MatchString(line):
		return IndicatorEnumeratedOptions, true
	case pressKeyPattern.MatchString(line):
		return IndicatorPressKey, true
	}
	return "", false
}

// scanSelectMenu recognises a live arrow-key menu and reports the option
// under its cursor. All three must hold, so a transcript that merely quotes
// a menu's hint, or an answered menu above a fresh composer, never matches:
// the footer hint sits within the last selectMenuFooterReach non-blank lines;
// no composer or turn-boundary line lies below it; and a cursor row (`❯ N.`)
// sits within SelectMenuWindow lines above it. It runs after the guards and
// before every other class, since a menu's option rows would otherwise
// classify as enumerated options that a typed digit cannot answer.
func scanSelectMenu(lines []string) (Result, bool) {
	footer, seen := -1, 0
	for i := len(lines) - 1; i >= 0 && seen < selectMenuFooterReach; i-- {
		if strings.TrimSpace(lines[i]) == "" {
			continue
		}
		seen++
		if composerLinePattern.MatchString(lines[i]) {
			return Result{}, false
		}
		if selectMenuFooterPattern.MatchString(lines[i]) {
			footer = i
			break
		}
	}
	if footer < 0 {
		return Result{}, false
	}
	for i := footer - 1; i >= 0 && i >= footer-SelectMenuWindow; i-- {
		if m := selectMenuCursorPattern.FindStringSubmatch(lines[i]); m != nil {
			n := 0
			for _, c := range m[1] {
				n = n*10 + int(c-'0')
			}
			return Result{Indicator: IndicatorSelectMenu, Input: InputKeys, Highlighted: n, Snippet: strings.TrimSpace(lines[i])}, true
		}
	}
	return Result{}, false
}
