package prreview

import (
	"context"

	"rk/internal/diffrows"
)

func (f *Fetcher) FileRows(ctx context.Context, review *Review, path string) (FileBody, error) {
	ref, err := ParsePRURL(review.URL)
	if err != nil {
		return FileBody{}, err
	}
	file := review.FindFile(path)
	if file == nil {
		return FileBody{}, ErrNoPR
	}

	patchRows := diffrows.ParsePatch(file.Patch)
	body := FileBody{
		Path:    path,
		Rows:    diffrows.LineRowsFromPatch(patchRows),
		HeadSha: review.HeadSha,
		BaseSha: review.BaseSha,
	}

	for _, run := range diffrows.CollectRuns(patchRows) {
		sha := review.HeadSha
		if run.Side == diffrows.SideLeft {
			sha = review.BaseSha
		}
		spans, refine, coloured := f.spansFor(ctx, ref, path, sha, run.Start, run.Count)
		if refine {
			body.Refine = true
		}
		if spans == nil {
			continue
		}
		if coloured {
			body.Highlighted = true
		}
		for offset, rowIndex := range run.Rows {
			if offset < len(spans) {
				body.Rows[rowIndex].Spans = spans[offset]
			}
		}
	}

	// Rows the highlighter could not cover still ship their text — the ladder
	// degrades colour, never content.
	for i, row := range patchRows {
		if body.Rows[i].Spans == nil && row.Kind != diffrows.RowHunk && row.Text != "" {
			body.Rows[i].Spans = []Span{{Text: row.Text}}
		}
	}

	if lines, err := f.blobLines(ctx, ref, path, review.HeadSha); err == nil {
		body.TotalLines = len(lines)
	}
	return body, nil
}

// contextExpandMaxLines bounds one context-expansion response. It is
// deliberately larger than the lexing window (which the highlighter applies
// internally, per hunk) because the expander's unit is what a human asked to
// see: `↕ All N lines` on a file longer than this serves the first page and the
// next `↑` continues. A single unbounded response is what this prevents — the
// blob can be a generated file.
const contextExpandMaxLines = 1000

// ContextRows serves a post-image line range as context rows — the
// `↕ All N lines` / `↑ 5 lines` expanders. It reads the SAME cached blob the
// lexer uses, so expansion costs no extra gh call once a file has been opened.
//
// The FindFile gate is the endpoint's whole authorization story and is not
// optional: without it the route would serve ANY blob in the repository at the
// head sha, because `path` arrives from the query string and the contents route
// takes it as a route segment. The PR's own changed-file list is the closed set
// a review tile may read.
func (f *Fetcher) ContextRows(ctx context.Context, review *Review, path string, start, count int) (FileBody, error) {
	ref, err := ParsePRURL(review.URL)
	if err != nil {
		return FileBody{}, err
	}
	if review.FindFile(path) == nil {
		return FileBody{}, ErrNoPR
	}
	lines, err := f.blobLines(ctx, ref, path, review.HeadSha)
	if err != nil {
		return FileBody{}, err
	}
	if start < 1 {
		start = 1
	}
	if count <= 0 || count > contextExpandMaxLines {
		count = contextExpandMaxLines
	}
	if start > len(lines) {
		return FileBody{Path: path, TotalLines: len(lines), HeadSha: review.HeadSha, BaseSha: review.BaseSha}, nil
	}
	end := start + count - 1
	if end > len(lines) {
		end = len(lines)
	}

	spans, refine, coloured := f.spansFor(ctx, ref, path, review.HeadSha, start, end-start+1)
	body := FileBody{
		Path:        path,
		Refine:      refine,
		TotalLines:  len(lines),
		HeadSha:     review.HeadSha,
		BaseSha:     review.BaseSha,
		Highlighted: coloured,
		Rows:        make([]LineRow, 0, end-start+1),
	}
	for i := start; i <= end; i++ {
		row := LineRow{Kind: diffrows.RowCtx, Side: diffrows.SideRight, L: i, Right: i, At: i}
		if offset := i - start; spans != nil && offset < len(spans) {
			row.Spans = spans[offset]
		} else if lines[i-1] != "" {
			row.Spans = []Span{{Text: lines[i-1]}}
		}
		body.Rows = append(body.Rows, row)
	}
	return body, nil
}
