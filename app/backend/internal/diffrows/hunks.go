package diffrows

import (
	"strconv"
	"strings"
)

// Row kinds. `hunk` is the `@@ … @@` header row; the three code kinds are the
// unified diff's own three line classes.
const (
	RowHunk = "hunk"
	RowCtx  = "ctx"
	RowAdd  = "add"
	RowDel  = "del"
)

// Sides, as GitHub addresses them: L is the pre-image (base), R the post-image
// (head). This is half of GitHub's own (path, side, line) comment address.
const (
	SideLeft  = "L"
	SideRight = "R"
)

// PatchRow is one parsed row of a unified patch, before highlighting.
//
// Left/Right are the gutter numbers (0 when the row is absent from that side).
// At is the row's POST-IMAGE anchor: for a deletion — which has no post-image
// line of its own — it is the post-image line the deletion sat before, which is
// what lets a deleted row be positioned in a post-image-ordered layout and what
// `data-at` carries to the comment layer (R6).
type PatchRow struct {
	Kind   string
	Left   int
	Right  int
	At     int
	Text   string
	Header string
}

// hunkHeader is `@@ -<oldStart>[,<oldCount>] +<newStart>[,<newCount>] @@[ ctx]`.
type hunkHeader struct {
	oldStart int
	newStart int
	trailing string
}

// ParsePatch walks a unified patch into rows. It is a pure state machine over
// the patch text — no I/O, no blob — so it unit-tests directly.
//
// Malformed input degrades rather than erroring: a body line before any `@@`
// header is dropped, and an unparseable header starts a hunk at line 1. A patch
// is display data, and half a diff beats an error banner.
func ParsePatch(patch string) []PatchRow {
	if patch == "" {
		return nil
	}
	var rows []PatchRow
	left, right := 0, 0
	inHunk := false
	for _, line := range strings.Split(strings.TrimSuffix(patch, "\n"), "\n") {
		if strings.HasPrefix(line, "@@") {
			header := parseHunkHeader(line)
			left, right = header.oldStart, header.newStart
			inHunk = true
			rows = append(rows, PatchRow{Kind: RowHunk, Header: line, Text: header.trailing, At: right})
			continue
		}
		if !inHunk {
			continue
		}
		switch {
		case strings.HasPrefix(line, "+"):
			rows = append(rows, PatchRow{Kind: RowAdd, Right: right, At: right, Text: line[1:]})
			right++
		case strings.HasPrefix(line, "-"):
			// The deletion has no post-image line, so its anchor is the
			// post-image line it sat BEFORE — the current right pointer.
			rows = append(rows, PatchRow{Kind: RowDel, Left: left, At: right, Text: line[1:]})
			left++
		case strings.HasPrefix(line, `\`):
			// "\ No newline at end of file" — metadata, not a row.
		default:
			// A context line, including the empty line git emits as "".
			text := line
			if strings.HasPrefix(line, " ") {
				text = line[1:]
			}
			rows = append(rows, PatchRow{Kind: RowCtx, Left: left, Right: right, At: right, Text: text})
			left++
			right++
		}
	}
	return rows
}

func parseHunkHeader(line string) hunkHeader {
	header := hunkHeader{oldStart: 1, newStart: 1}
	rest := strings.TrimPrefix(line, "@@")
	end := strings.Index(rest, "@@")
	if end < 0 {
		return header
	}
	header.trailing = strings.TrimSpace(rest[end+2:])
	for _, field := range strings.Fields(rest[:end]) {
		if len(field) < 2 {
			continue
		}
		start := field[1:]
		if comma := strings.IndexByte(start, ','); comma >= 0 {
			start = start[:comma]
		}
		value, err := strconv.Atoi(start)
		if err != nil {
			continue
		}
		switch field[0] {
		case '-':
			header.oldStart = value
		case '+':
			header.newStart = value
		}
	}
	return header
}

// runs groups consecutive rows that lex against the same image into contiguous
// line ranges, so one lexing window covers a whole hunk side instead of one per
// row.
// LineRun's fields are exported because the run crosses a package boundary:
// prreview ranges over CollectRuns' output to build a file body.
type LineRun struct {
	Side  string
	Start int
	Count int
	Rows  []int // indexes into the row slice, in order
}

func CollectRuns(rows []PatchRow) []LineRun {
	var runs []LineRun
	for i, row := range rows {
		var side string
		var line int
		switch row.Kind {
		case RowAdd, RowCtx:
			side, line = SideRight, row.Right
		case RowDel:
			side, line = SideLeft, row.Left
		default:
			continue
		}
		if line <= 0 {
			continue
		}
		if n := len(runs); n > 0 {
			last := &runs[n-1]
			if last.Side == side && last.Start+last.Count == line {
				last.Count++
				last.Rows = append(last.Rows, i)
				continue
			}
		}
		runs = append(runs, LineRun{Side: side, Start: line, Count: 1, Rows: []int{i}})
	}
	return runs
}

func RenderHunk(rows []PatchRow, start int) string {
	var out []string
	out = append(out, rows[start].Header)
	for _, row := range rows[start+1:] {
		switch row.Kind {
		case RowHunk:
			return joinLines(out)
		case RowAdd:
			out = append(out, "+"+row.Text)
		case RowDel:
			out = append(out, "-"+row.Text)
		default:
			out = append(out, " "+row.Text)
		}
	}
	return joinLines(out)
}

func joinLines(lines []string) string { return strings.Join(lines, "\n") }
