package diffrows

import (
	"strings"

	"github.com/alecthomas/chroma/v2"
	"github.com/alecthomas/chroma/v2/lexers"
)

// The lexing window, its context pads, and the two byte caps. Measured against
// real PRs during apply rather than guessed: 200 lines is roughly three screens
// of an expanded hunk, 60 lines of pad clears any realistic block comment or
// raw string, and 256 KiB is ~0.3 s at Chroma's sub-1 MB/s throughput.
const (
	windowLines     = 200
	contextPadLines = 60
	WindowByteCap   = 256 << 10
)

// Span is one run of same-class text on a line. `Class` is Chroma's own short
// class name and is EMPTY for plain text — class-name length is payload here,
// because the string repeats once per token on every line shipped.
// Span is one run of same-class text on a line. `Class` is Chroma's own short
// class name and is EMPTY for plain text — class-name length is payload here,
// because the string repeats once per token on every line shipped.
type Span struct {
	Class string `json:"c,omitempty"`
	Text  string `json:"t"`
}

// tokenClass maps a Chroma token type onto its short class name. Chroma's own
// StandardTypes table IS the short-class vocabulary the spec describes
// (`k`/`nf`/`s`/`m`/`c`/`kd`/`kt`/`err`), so writing a second table here would
// only drift from it. Sub-types absent from the table walk up to their parent,
// which is what makes an unmapped dialect token still colour as its category.
// tokenClass maps a Chroma token type onto its short class name. Chroma's own
// StandardTypes table IS the short-class vocabulary the spec describes
// (`k`/`nf`/`s`/`m`/`c`/`kd`/`kt`/`err`), so writing a second table here would
// only drift from it. Sub-types absent from the table walk up to their parent,
// which is what makes an unmapped dialect token still colour as its category.
func tokenClass(t chroma.TokenType) string {
	for {
		if class, ok := chroma.StandardTypes[t]; ok {
			return class
		}
		parent := t.Parent()
		if parent == t {
			return ""
		}
		t = parent
	}
}

// LexerFor resolves a Chroma lexer by filename, falling back to the plaintext
// lexer. It returns nil when the match is plaintext — a nil lexer is the
// caller's signal to emit unhighlighted spans and skip the work entirely.
// LexerFor resolves a Chroma lexer by filename, falling back to the plaintext
// lexer. It returns nil when the match is plaintext — a nil lexer is the
// caller's signal to emit unhighlighted spans and skip the work entirely.
func LexerFor(path string) chroma.Lexer {
	lexer := lexers.Match(path)
	if lexer == nil {
		return nil
	}
	if lexer.Config() != nil && lexer.Config().Name == "plaintext" {
		return nil
	}
	return chroma.Coalesce(lexer)
}

// PlainSpans renders lines with no highlighting at all — the innermost rung of
// the R5 ladder, taken when no lexer matches, when the window is over the byte
// cap even with its pads dropped, or when lexing errors.
// PlainSpans renders lines with no highlighting at all — the innermost rung of
// the R5 ladder, taken when no lexer matches, when the window is over the byte
// cap even with its pads dropped, or when lexing errors.
func PlainSpans(lines []string) [][]Span {
	out := make([][]Span, len(lines))
	for i, line := range lines {
		if line == "" {
			out[i] = nil
			continue
		}
		out[i] = []Span{{Text: line}}
	}
	return out
}

// LexLines tokenises a contiguous slice of a file and buckets the tokens back
// into per-line span lists. Chroma emits a flat token stream with embedded
// newlines; the line is the unit of our API (R6), so the split happens here
// rather than in the renderer.
// LexLines tokenises a contiguous slice of a file and buckets the tokens back
// into per-line span lists. Chroma emits a flat token stream with embedded
// newlines; the line is the unit of our API (R6), so the split happens here
// rather than in the renderer.
func LexLines(lexer chroma.Lexer, lines []string) [][]Span {
	if lexer == nil || len(lines) == 0 {
		return PlainSpans(lines)
	}
	iterator, err := lexer.Tokenise(nil, strings.Join(lines, "\n")+"\n")
	if err != nil {
		return PlainSpans(lines)
	}
	out := make([][]Span, len(lines))
	row := 0
	for _, token := range iterator.Tokens() {
		class := tokenClass(token.Type)
		value := token.Value
		for {
			newline := strings.IndexByte(value, '\n')
			if newline < 0 {
				if value != "" && row < len(out) {
					out[row] = appendSpan(out[row], class, value)
				}
				break
			}
			if newline > 0 && row < len(out) {
				out[row] = appendSpan(out[row], class, value[:newline])
			}
			row++
			value = value[newline+1:]
			if row >= len(out) {
				return out
			}
		}
	}
	return out
}

// appendSpan coalesces adjacent same-class runs so a line of N tokens of one
// class ships as one span instead of N.
// appendSpan coalesces adjacent same-class runs so a line of N tokens of one
// class ships as one span instead of N.
func appendSpan(spans []Span, class, text string) []Span {
	if len(spans) > 0 && spans[len(spans)-1].Class == class {
		spans[len(spans)-1].Text += text
		return spans
	}
	return append(spans, Span{Class: class, Text: text})
}

// LexPatchRows is R5's tier 0.5: colour built from the PATCH's own text, with
// no blob and no request at all.
//
// The patch already carries every line it renders. That is not the whole file,
// so a hunk opening inside a block comment or a raw string lexes wrong — but on
// a real PR it is right for 93% of rows (4,566 of 4,895, measured on #1027) and
// costs ~72 ms of CPU across the file set instead of one ~0.6 s blob fetch per
// file. It is what the reader sees in the gap before the blob-backed rungs
// arrive, which is why it is a RUNG and not a replacement: the client's
// viewport pump still upgrades each file as it approaches, and that is what
// fixes the other 7%.
//
// Runs break at every hunk header, because the header is not code and the rows
// either side of it are not contiguous in the file — lexing across the gap
// would carry lexer state that does not belong.
//
// A file with no Chroma lexer is left exactly as it is: tier-0 plain rows. That
// is the common case for lockfiles and data, and the ladder degrades to absent
// colour rather than to an error.
// LexPatchRows is R5's tier 0.5: colour built from the PATCH's own text, with
// no blob and no request at all.
//
// The patch already carries every line it renders. That is not the whole file,
// so a hunk opening inside a block comment or a raw string lexes wrong — but on
// a real PR it is right for 93% of rows (4,566 of 4,895, measured on #1027) and
// costs ~72 ms of CPU across the file set instead of one ~0.6 s blob fetch per
// file. It is what the reader sees in the gap before the blob-backed rungs
// arrive, which is why it is a RUNG and not a replacement: the client's
// viewport pump still upgrades each file as it approaches, and that is what
// fixes the other 7%.
//
// Runs break at every hunk header, because the header is not code and the rows
// either side of it are not contiguous in the file — lexing across the gap
// would carry lexer state that does not belong.
//
// A file with no Chroma lexer is left exactly as it is: tier-0 plain rows. That
// is the common case for lockfiles and data, and the ladder degrades to absent
// colour rather than to an error.
func LexPatchRows(path string, rows []LineRow) {
	lexer := LexerFor(path)
	if lexer == nil {
		return
	}
	var run []string
	var at []int
	flush := func() {
		if len(run) == 0 {
			return
		}
		spans := LexLines(lexer, run)
		for i, idx := range at {
			// A line the lexer produced nothing for keeps its tier-0 span: an
			// empty span list would render the row blank, which is strictly
			// worse than rendering it uncoloured.
			if i < len(spans) && len(spans[i]) > 0 {
				rows[idx].Spans = spans[i]
			}
		}
		run, at = run[:0], at[:0]
	}
	for i := range rows {
		if rows[i].Kind == RowHunk {
			flush()
			continue
		}
		text := ""
		if len(rows[i].Spans) > 0 {
			text = rows[i].Spans[0].Text
		}
		run = append(run, text)
		at = append(at, i)
	}
	flush()
}

// LexWindow is R5's tier 1: lex a bounded window around the requested lines and
// slice the target rows out of it.
//
// `start` is 1-based and `count` is the number of lines wanted. The LEADING pad
// puts the lexer into the right state on entry (inside a block comment, inside
// a raw string); the TRAILING pad lets a construct opening inside the window
// find its terminator. `refine` reports that the window may have guessed —
// which is exactly "the leading pad did not reach the start of the blob", since
// a window anchored at line 1 starts the lexer in its true initial state.
//
// Over WindowByteCap the pads are dropped FIRST (a thousand-line window can be
// the whole of a generated file); past that the rows serve unhighlighted. The
// ladder degrades to briefly-imprecise or absent COLOUR, never to a blocked or
// failed request.
//
// `coloured` distinguishes "these spans carry token classes" from "these spans
// are the plain-text rung", which is what the wire's `highlighted` flag means.
// A caller that conflated the two would tell the client there is colour to
// render on a file no lexer matched.
// LexWindow is R5's tier 1: lex a bounded window around the requested lines and
// slice the target rows out of it.
//
// `start` is 1-based and `count` is the number of lines wanted. The LEADING pad
// puts the lexer into the right state on entry (inside a block comment, inside
// a raw string); the TRAILING pad lets a construct opening inside the window
// find its terminator. `refine` reports that the window may have guessed —
// which is exactly "the leading pad did not reach the start of the blob", since
// a window anchored at line 1 starts the lexer in its true initial state.
//
// Over WindowByteCap the pads are dropped FIRST (a thousand-line window can be
// the whole of a generated file); past that the rows serve unhighlighted. The
// ladder degrades to briefly-imprecise or absent COLOUR, never to a blocked or
// failed request.
//
// `coloured` distinguishes "these spans carry token classes" from "these spans
// are the plain-text rung", which is what the wire's `highlighted` flag means.
// A caller that conflated the two would tell the client there is colour to
// render on a file no lexer matched.
func LexWindow(lexer chroma.Lexer, lines []string, start, count int) (spans [][]Span, refine, coloured bool) {
	if start < 1 {
		start = 1
	}
	if count < 0 {
		count = 0
	}
	if start > len(lines) || count == 0 {
		return nil, false, false
	}
	end := start + count - 1
	if end > len(lines) {
		end = len(lines)
	}
	target := lines[start-1 : end]
	if lexer == nil {
		return PlainSpans(target), false, false
	}

	padStart, padEnd := start-contextPadLines, end+contextPadLines
	if padStart < 1 {
		padStart = 1
	}
	if padEnd > len(lines) {
		padEnd = len(lines)
	}
	if ByteLen(lines[padStart-1:padEnd]) > WindowByteCap {
		padStart, padEnd = start, end
	}
	if ByteLen(lines[padStart-1:padEnd]) > WindowByteCap {
		return PlainSpans(target), false, false
	}

	windowed := LexLines(lexer, lines[padStart-1:padEnd])
	offset := start - padStart
	out := make([][]Span, 0, len(target))
	for i := range target {
		if offset+i < len(windowed) {
			out = append(out, windowed[offset+i])
			continue
		}
		out = append(out, PlainSpans(target[i : i+1])[0])
	}
	return out, padStart > 1, true
}

// spansFor resolves the per-line spans for a blob range, preferring the tier-2
// whole-blob result when one exists and otherwise taking tier 1 and queueing
// the background pass.
func SliceSpans(full [][]Span, lines []string, start, count int) [][]Span {
	if start < 1 {
		start = 1
	}
	end := start + count - 1
	if end > len(lines) {
		end = len(lines)
	}
	if start > len(lines) || count <= 0 {
		return nil
	}
	out := make([][]Span, 0, end-start+1)
	for i := start; i <= end; i++ {
		if i-1 < len(full) {
			out = append(out, full[i-1])
			continue
		}
		out = append(out, PlainSpans(lines[i-1 : i])[0])
	}
	return out
}

// queueRefine is R5's tier 2: a bounded background goroutine lexes a SMALL blob
// end to end and populates the cache, so the next read of any window over that
// blob answers refine:false and the client swaps the corrected lines in place.
// Blobs over refinePassByteCap are never refined — their tier-1 colour is as
// good as it gets, which is still colour.
func ByteLen(lines []string) int {
	total := 0
	for _, line := range lines {
		total += len(line) + 1
	}
	return total
}
