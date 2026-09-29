package prreview

import (
	"context"

	"github.com/alecthomas/chroma/v2"

	"rk/internal/diffrows"
)

// refinePassByteCap bounds the BACKGROUND whole-blob pass. It lives here rather
// than with the lexer because it is a property of the refinement STRATEGY — how
// much work this package is willing to do off the request path — not of lexing.
const refinePassByteCap = 512 << 10

// spansFor resolves the per-line spans for a blob range, preferring the tier-2
// whole-blob result when one exists and otherwise taking tier 1 and queueing
// the background pass.
func (f *Fetcher) spansFor(ctx context.Context, ref PRRef, path, sha string, start, count int) (spans [][]diffrows.Span, refine, coloured bool) {
	lines, err := f.blobLines(ctx, ref, path, sha)
	if err != nil || len(lines) == 0 {
		return nil, false, false
	}
	// The tier-2 pass only ever runs behind a non-nil lexer, so a published
	// result is coloured by construction.
	if full := f.refinedSpans(f.blobs.get(sha, path)); full != nil {
		return diffrows.SliceSpans(full, lines, start, count), false, true
	}
	lexer := diffrows.LexerFor(path)
	spans, refine, coloured = diffrows.LexWindow(lexer, lines, start, count)
	if refine {
		f.queueRefine(ref, path, sha, lines, lexer)
	}
	return spans, refine, coloured
}

// refinedSpans reads an entry's tier-2 result under refineMu. The background
// pass publishes `full` on another goroutine, so every read of it is guarded —
// an unsynchronized read here would be a data race, not merely a stale answer.
// refinedSpans reads an entry's tier-2 result under refineMu. The background
// pass publishes `full` on another goroutine, so every read of it is guarded —
// an unsynchronized read here would be a data race, not merely a stale answer.
func (f *Fetcher) refinedSpans(entry *blobEntry) [][]diffrows.Span {
	if entry == nil {
		return nil
	}
	f.refineMu.Lock()
	defer f.refineMu.Unlock()
	return entry.full
}

// queueRefine is R5's tier 2: a bounded background goroutine lexes a SMALL blob
// end to end and populates the cache, so the next read of any window over that
// blob answers refine:false and the client swaps the corrected lines in place.
// Blobs over refinePassByteCap are never refined — their tier-1 colour is as
// good as it gets, which is still colour.
func (f *Fetcher) queueRefine(ref PRRef, path, sha string, lines []string, lexer chroma.Lexer) {
	if lexer == nil || sha == "" {
		return
	}
	size := entryBytes(lines)
	if size > refinePassByteCap {
		return
	}
	entry := f.blobs.get(sha, path)
	if entry == nil {
		return
	}
	f.refineMu.Lock()
	if entry.refining || entry.full != nil {
		f.refineMu.Unlock()
		return
	}
	entry.refining = true
	f.refineMu.Unlock()

	go func() {
		full := diffrows.LexLines(lexer, lines)
		f.refineMu.Lock()
		entry.full = full
		entry.refining = false
		f.refineMu.Unlock()
		// The spans roughly double the entry's footprint; tell the LRU so the
		// budget stays honest.
		f.blobs.note(sha, path, size)
	}()
}
