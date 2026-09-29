package diffrows

// LineRow is the wire shape of one rendered row. The response is an ARRAY of
// these, never one HTML blob per file (R6): a blob cannot be interleaved, and
// interleaving a composer, a thread card and an expander between line N and
// line N+1 is the comment layer's whole job.
//
// Side + L are GitHub's own (side, line) half of a comment address; At carries
// a deleted row's post-image anchor. Together with the file's path they are the
// anchoring contract the client renders as data-side / data-l / data-at.
type LineRow struct {
	Kind   string `json:"kind"`
	Side   string `json:"side,omitempty"`
	L      int    `json:"l,omitempty"`
	Left   int    `json:"left,omitempty"`
	Right  int    `json:"right,omitempty"`
	At     int    `json:"at,omitempty"`
	Header string `json:"header,omitempty"`
	Spans  []Span `json:"spans,omitempty"`
}

// FileBody is one file's rows plus the refinement flag and the bounds the
// client needs to render context expanders.
type FileBody struct {
	Path string    `json:"path"`
	Rows []LineRow `json:"rows"`
	// Refine is true when any row in this response came from a tier-1 window
	// that may have guessed. The client re-requests the file once to swap the
	// corrected lines in place (R5).
	Refine bool `json:"refine"`
	// TotalLines is the post-image line count, so the expander can offer
	// `↕ All N lines` without a second read.
	TotalLines int    `json:"totalLines"`
	HeadSha    string `json:"headSha"`
	BaseSha    string `json:"baseSha"`
	// Highlighted is false when no Chroma lexer matched the path or the blob
	// could not be read — the rows still render, just without colour.
	Highlighted bool `json:"highlighted"`
}

// FileRows builds one file's diff rows from its patch, highlighting each row
// against the image it belongs to: added and context rows against the
// POST-image (head sha) blob, deleted rows against the PRE-image (base sha).
//
// Lexing a hunk body as a standalone fragment is not permitted — it starts the
// lexer mid-file with the wrong state, which is exactly what the context pads
// in LexWindow exist to prevent (R5).
// LineRowsFromPatch turns parsed patch rows into wire rows — the diff's whole
// STRUCTURE (kinds, both sides' line numbers, hunk headers, the anchor address
// every comment hangs off) plus each line's TEXT as one classless span.
//
// The text is not optional. A LineRow has no text field of its own: content
// lives only in Spans, so a row built without them renders as an empty line —
// the eagerly-expanded file shows its line numbers and +/- gutter over blank
// rows until colour arrives. Emitting one classless span here is what makes
// tier 0 genuinely readable, and it is the same shape LexWindow produces for a
// file with no Chroma lexer, so the colour pass simply REPLACES it.
//
// This half costs nothing: the patch is already in the cached Review document,
// so structure is pure in-memory work. Only spansFor below reaches the network,
// which is why the list path can ship rows for every file within its budget
// without a single extra gh subprocess, and colour can arrive afterwards.
func LineRowsFromPatch(patchRows []PatchRow) []LineRow {
	rows := make([]LineRow, len(patchRows))
	for i, row := range patchRows {
		rows[i] = LineRow{
			Kind:   row.Kind,
			Left:   row.Left,
			Right:  row.Right,
			At:     row.At,
			Header: row.Header,
		}
		switch row.Kind {
		case RowAdd, RowCtx:
			rows[i].Side = SideRight
			rows[i].L = row.Right
		case RowDel:
			rows[i].Side = SideLeft
			rows[i].L = row.Left
		}
		// A hunk header renders from Header; an empty line needs no span.
		if row.Kind != RowHunk && row.Text != "" {
			rows[i].Spans = []Span{{Text: row.Text}}
		}
	}
	return rows
}
