package prreview

import "rk/internal/diffrows"

// HunkAround renders the unified hunk containing a thread's anchor line, so the
// listener can hand an agent the code the comment is about rather than a bare
// line number. Returns "" when the file has no patch or no hunk covers the
// line.
//
// `side` is L (pre-image) or R (post-image); the anchor is matched against the
// matching side's numbering.
func (r *Review) HunkAround(path, side string, line int) string {
	file := r.FindFile(path)
	if file == nil || file.Patch == "" || line <= 0 {
		return ""
	}
	rows := diffrows.ParsePatch(file.Patch)
	start := -1
	for i, row := range rows {
		if row.Kind == diffrows.RowHunk {
			start = i
			continue
		}
		matched := row.Right == line
		if side == diffrows.SideLeft {
			matched = row.Left == line
		}
		if !matched || start < 0 {
			continue
		}
		return diffrows.RenderHunk(rows, start)
	}
	return ""
}

// diffrows.RenderHunk re-renders one hunk (header + body) in unified form from its
// parsed rows.
