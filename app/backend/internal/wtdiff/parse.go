package wtdiff

import (
	"errors"
	"os/exec"
	"strings"
)

// parseStatus reads `git status --porcelain=v1 -z`.
//
// The record is `XY<space><path>NUL`, where X is the INDEX column and Y the
// WORKTREE column. A rename adds the OLD path as its own NUL-terminated field
// immediately after the record — so a parser that does not consume that second
// field shifts every subsequent record by one, which is the single easiest way
// to get this wrong and the reason this is not a Split-and-range loop.
//
// Ignored files are absent: `git status` omits them without --ignored, so the
// "someone dropped node_modules in the tree" worry never reaches us.
func parseStatus(raw string) []FileEntry {
	fields := strings.Split(raw, "\x00")
	var out []FileEntry
	for i := 0; i < len(fields); i++ {
		record := fields[i]
		if len(record) < 4 {
			continue
		}
		x, y := record[0], record[1]
		path := record[3:]
		entry := FileEntry{
			Path:   path,
			Status: projectStatus(x, y),
			// The index column carries a change, and `?` is not one.
			Staged: x != ' ' && x != '?',
		}
		if x == 'R' || y == 'R' {
			// The rename's source is the NEXT field, and consuming it here is
			// what keeps the loop in phase.
			if i+1 < len(fields) {
				entry.PreviousPath = fields[i+1]
				i++
			}
		}
		out = append(out, entry)
	}
	return out
}

// projectStatus collapses git's two columns to one word. The index column wins
// when both carry a change, because that is the more specific fact: a path that
// is staged-added and then edited is still an addition.
func projectStatus(x, y byte) string {
	if x == '?' || y == '?' {
		return StatusUntracked
	}
	for _, code := range []byte{x, y} {
		switch code {
		case 'R':
			return StatusRenamed
		case 'A':
			return StatusAdded
		case 'D':
			return StatusRemoved
		case 'M', 'T':
			return StatusModified
		}
	}
	return StatusModified
}

// splitPatches breaks one `git diff` stream into per-file patches, keyed by the
// file's POST-image path.
//
// Each file's text is trimmed to start at its first `@@`, which makes the input
// to ParsePatch byte-identical in shape to GitHub's REST `patch` field — so the
// shipped parser needs no change at all to read git's output.
func splitPatches(raw string) map[string]string {
	out := map[string]string{}
	if raw == "" {
		return out
	}
	for _, chunk := range strings.Split(raw, "\ndiff --git ") {
		chunk = strings.TrimPrefix(chunk, "diff --git ")
		if chunk == "" {
			continue
		}
		path := postImagePath(chunk)
		if path == "" {
			continue
		}
		// A binary file, a pure rename or a mode-only change has no hunks. It
		// records as a file with no patch, which the client already renders as
		// "no diff available" rather than as an empty diff.
		out[path] = trimToHunks(chunk)
	}
	return out
}

// postImagePath reads the `b/<path>` half of a `diff --git a/x b/y` line, or
// the `+++ b/<path>` header when the first line is ambiguous.
//
// The `+++` header is preferred wherever present because `diff --git` does not
// quote or escape consistently for paths containing spaces, while the `+++`
// line is one field to end of line.
func postImagePath(chunk string) string {
	for _, line := range strings.Split(chunk, "\n") {
		if strings.HasPrefix(line, "+++ b/") {
			return line[len("+++ b/"):]
		}
		if strings.HasPrefix(line, "+++ /dev/null") {
			// A deletion: the post image is absent, so the pre-image path is
			// the file's identity.
			break
		}
		if strings.HasPrefix(line, "@@") {
			break
		}
	}
	for _, line := range strings.Split(chunk, "\n") {
		if strings.HasPrefix(line, "--- a/") {
			return line[len("--- a/"):]
		}
		if strings.HasPrefix(line, "@@") {
			break
		}
	}
	// No ---/+++ pair at all: a pure rename or a mode change. Fall back to the
	// `diff --git a/x b/y` line's second half.
	first := chunk
	if i := strings.IndexByte(first, '\n'); i >= 0 {
		first = first[:i]
	}
	if i := strings.Index(first, " b/"); i >= 0 {
		return first[i+3:]
	}
	return ""
}

// trimToHunks drops a patch's extended headers, leaving the `@@` hunks.
func trimToHunks(patch string) string {
	i := strings.Index(patch, "\n@@")
	if i < 0 {
		if strings.HasPrefix(patch, "@@") {
			return patch
		}
		return ""
	}
	return patch[i+1:]
}

func asExitError(err error, target **exec.ExitError) bool {
	return errors.As(err, target)
}
