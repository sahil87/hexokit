package promptscan

import (
	"encoding/json"
	"strings"
	"unicode"
)

// Composer is what an agent harness's input line holds, read from an
// attribute-preserving capture (`capture-pane -e`). Text is the content after
// the prompt glyph; Ghost reports that every character of it is rendered dim
// (SGR 2) — text the harness drew itself, a suggestion or a placeholder, which
// a plain capture cannot tell from typed input. Found is false when no
// composer line was seen; such a Composer marshals as JSON null, so a reader
// can never mistake "unknown" for "empty".
type Composer struct {
	Text  string `json:"text"`
	Ghost bool   `json:"ghost"`
	Found bool   `json:"-"`
}

// MarshalJSON renders an unfound composer as null.
func (c Composer) MarshalJSON() ([]byte, error) {
	if !c.Found {
		return []byte("null"), nil
	}
	type plain Composer
	return json.Marshal(plain(c))
}

// composerGlyphs are the prompt glyphs harness composers start with: Claude
// Code's ❯, Codex's ›, and the bare > of Gemini CLI, Copilot and others.
const composerGlyphs = "❯›>"

// ScanComposer finds the composer in an escape-preserving capture: the last
// line whose visible text, after any box-drawing border and whitespace, starts
// with a prompt glyph. The composer always sits below the transcript, so
// scanning upward from the bottom cannot pick a quoted `>` line out of the
// output above it. Pure.
func ScanComposer(escaped string) Composer {
	lines := strings.Split(escaped, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		plain, attrs := stripEscapes(lines[i])
		start := 0
		for start < len(plain) && composerPadding(plain[start]) {
			start++
		}
		if start >= len(plain) || !strings.ContainsRune(composerGlyphs, plain[start]) {
			continue
		}
		textStart := start + 1
		for textStart < len(plain) && unicode.IsSpace(plain[textStart]) {
			textStart++
		}
		textEnd := len(plain)
		for textEnd > textStart && composerPadding(plain[textEnd-1]) {
			textEnd--
		}
		c := Composer{Text: string(plain[textStart:textEnd]), Found: true}
		if c.Text != "" {
			c.Ghost = allDim(attrs[textStart:textEnd], plain[textStart:textEnd])
		}
		return c
	}
	return Composer{}
}

// composerPadding is whitespace or a box-drawing border rune (the boxed
// composers of Gemini CLI, Copilot and OpenCode), which the composer's text
// never starts or ends with.
func composerPadding(r rune) bool {
	return unicode.IsSpace(r) || (r >= 0x2500 && r <= 0x257F)
}

// allDim reports that at least one rune is dim and every non-space rune is,
// allowing one non-dim rune that carries the inverse attribute — the
// harness's drawn cursor, which tmux renders as an inverse cell over the
// first suggestion character. A lone typed character under that cursor has
// no dim rune at all and is not ghost.
func allDim(attrs []cellAttr, text []rune) bool {
	cursorSeen, dimSeen := false, false
	for i, r := range text {
		if unicode.IsSpace(r) {
			continue
		}
		if attrs[i].dim {
			dimSeen = true
			continue
		}
		if attrs[i].inverse && !cursorSeen {
			cursorSeen = true
			continue
		}
		return false
	}
	return dimSeen
}

// cellAttr is the attribute state under one visible rune.
type cellAttr struct{ dim, inverse bool }

// stripEscapes removes escape sequences from one line, returning its visible
// runes and the attribute state under each. A CSI sequence (`ESC [`,
// parameter bytes 0x30–0x3F, intermediate bytes 0x20–0x2F, one final byte
// 0x40–0x7E) is consumed whole and applied only when its final byte is `m`;
// an OSC (`ESC ]` … BEL or `ESC \`) is consumed whole; a charset designation
// (`ESC ( x`, `ESC ) x`) is consumed and `ESC ( 0` / SO select the
// line-drawing set, under which visible runes are dropped until `ESC ( B` /
// SI (tmux emits box borders as `SO lqk SI`); other control characters are
// dropped; any other ESC pair is dropped. SGR parameters: 0 resets, 2 sets dim, 22 clears it, 7 sets
// inverse, 27 clears it; a 38/48/58 colour selector consumes its
// sub-parameters (5;n or 2;r;g;b, or the colon form inside one parameter) so a
// colour index never reads as an attribute.
func stripEscapes(line string) (plain []rune, attrs []cellAttr) {
	runes := []rune(line)
	var state cellAttr
	lineDrawing := false
	for i := 0; i < len(runes); i++ {
		if runes[i] != 0x1b || i+1 >= len(runes) {
			switch {
			case runes[i] == 0x0e:
				lineDrawing = true
			case runes[i] == 0x0f:
				lineDrawing = false
			case runes[i] < 0x20 || runes[i] == 0x7f || lineDrawing:
			default:
				plain = append(plain, runes[i])
				attrs = append(attrs, state)
			}
			continue
		}
		switch runes[i+1] {
		case '(', ')':
			if i+2 < len(runes) {
				lineDrawing = runes[i+2] == '0'
			}
			i += 2
		case '[':
			j := i + 2
			for j < len(runes) && runes[j] >= 0x30 && runes[j] <= 0x3F {
				j++
			}
			params := string(runes[i+2 : j])
			for j < len(runes) && runes[j] >= 0x20 && runes[j] <= 0x2F {
				j++
			}
			if j < len(runes) && runes[j] == 'm' {
				state = applySGR(params, state)
			}
			i = j
		case ']':
			j := i + 2
			for j < len(runes) && runes[j] != 0x07 && !(runes[j] == 0x1b && j+1 < len(runes) && runes[j+1] == '\\') {
				j++
			}
			if j < len(runes) && runes[j] == 0x1b {
				j++
			}
			i = j
		default:
			i++
		}
	}
	return plain, attrs
}

// applySGR folds one SGR parameter list into the attribute state.
func applySGR(params string, state cellAttr) cellAttr {
	parts := strings.Split(params, ";")
	for k := 0; k < len(parts); k++ {
		head, sub, colon := strings.Cut(parts[k], ":")
		switch head {
		case "", "0":
			state = cellAttr{}
		case "2":
			state.dim = true
		case "22":
			state.dim = false
		case "7":
			state.inverse = true
		case "27":
			state.inverse = false
		case "38", "48", "58":
			if colon {
				_ = sub // colon form carries its sub-parameters in this token
				continue
			}
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
	return state
}
