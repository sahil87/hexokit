package promptscan

import (
	"strings"
	"unicode"
)

// Composer is what an agent harness's input line holds, read from an
// attribute-preserving capture (`capture-pane -e`). Text is the content after
// the prompt glyph; Ghost reports that the text is rendered dim (SGR 2) — the
// harness's own suggestion, such as Claude Code's next-command hint, which a
// plain capture cannot tell from typed input. Found is false when no composer
// line was seen.
type Composer struct {
	Text  string `json:"text"`
	Ghost bool   `json:"ghost"`
	Found bool   `json:"-"`
}

// composerGlyphs are the prompt glyphs harness composers start with: Claude
// Code's ❯, Codex's ›, and a bare >.
const composerGlyphs = "❯›>"

// ScanComposer finds the composer in an escape-preserving capture: the last
// line whose visible text starts with a prompt glyph. The composer always sits
// below the transcript, so scanning upward from the bottom cannot pick a quoted
// `>` line out of the output above it. Pure.
func ScanComposer(escaped string) Composer {
	lines := strings.Split(escaped, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		plain, dim := stripSGR(lines[i])
		start := 0
		for start < len(plain) && unicode.IsSpace(plain[start]) {
			start++
		}
		if start >= len(plain) || !strings.ContainsRune(composerGlyphs, plain[start]) {
			continue
		}
		// Claude Code pads the glyph with a no-break space; IsSpace covers it.
		textStart := start + 1
		for textStart < len(plain) && unicode.IsSpace(plain[textStart]) {
			textStart++
		}
		text := strings.TrimRightFunc(string(plain[textStart:]), unicode.IsSpace)
		c := Composer{Text: text, Found: true}
		if text != "" {
			c.Ghost = dim[textStart]
		}
		return c
	}
	return Composer{}
}

// stripSGR removes escape sequences from one line, returning its visible runes
// and, per rune, whether the dim attribute was active. Only SGR (`ESC [ … m`)
// changes state: 0 resets, 2 sets dim, 22 clears it; 38/48 colour selectors
// consume their sub-parameters (5;n or 2;r;g;b) so a colour index never reads
// as the dim attribute. Other CSI sequences are dropped.
func stripSGR(line string) (plain []rune, dim []bool) {
	runes := []rune(line)
	active := false
	for i := 0; i < len(runes); i++ {
		if runes[i] != 0x1b || i+1 >= len(runes) || runes[i+1] != '[' {
			plain = append(plain, runes[i])
			dim = append(dim, active)
			continue
		}
		j := i + 2
		for j < len(runes) && (runes[j] == ';' || (runes[j] >= '0' && runes[j] <= '9')) {
			j++
		}
		if j < len(runes) && runes[j] == 'm' {
			active = applySGR(string(runes[i+2:j]), active)
		}
		i = j
	}
	return plain, dim
}

// applySGR folds one SGR parameter list into the dim state.
func applySGR(params string, active bool) bool {
	parts := strings.Split(params, ";")
	for k := 0; k < len(parts); k++ {
		switch parts[k] {
		case "", "0":
			active = false
		case "2":
			active = true
		case "22":
			active = false
		case "38", "48", "58":
			if k+1 < len(parts) {
				switch parts[k+1] {
				case "5":
					k += 2
				case "2":
					k += 4
				}
			}
		}
	}
	return active
}
