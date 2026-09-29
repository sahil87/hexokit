package prreview

import (
	"context"
	"encoding/json"
	"strconv"
)

type ghPRFile struct {
	Filename         string `json:"filename"`
	PreviousFilename string `json:"previous_filename"`
	Status           string `json:"status"`
	Additions        int    `json:"additions"`
	Deletions        int    `json:"deletions"`
	Patch            string `json:"patch"`
	Sha              string `json:"sha"`
}

// fetchFiles walks the PR's changed files. `--paginate` concatenates the pages
// into one JSON array when combined with `--slurp`, which is what keeps this a
// single decode regardless of file count.
func (f *Fetcher) fetchFiles(ctx context.Context, ref PRRef) ([]FileEntry, error) {
	path := "repos/" + ref.Repository() + "/pulls/" + strconv.Itoa(ref.Number) +
		"/files?per_page=" + strconv.Itoa(filesPerPage)
	args := append(f.restArgs(ref, path), "--paginate", "--slurp")
	out, err := f.ghExec(ctx, nil, args...)
	if err != nil {
		return nil, err
	}
	// --slurp wraps the pages as an array of arrays; a single page with no
	// --paginate effect still decodes as one inner array.
	var pages [][]ghPRFile
	if err := json.Unmarshal(out, &pages); err != nil {
		var flat []ghPRFile
		if flatErr := json.Unmarshal(out, &flat); flatErr != nil {
			return nil, err
		}
		pages = [][]ghPRFile{flat}
	}
	files := make([]FileEntry, 0, filesPerPage)
	for _, page := range pages {
		for _, file := range page {
			files = append(files, FileEntry{
				Path:         file.Filename,
				PreviousPath: file.PreviousFilename,
				Status:       file.Status,
				Additions:    file.Additions,
				Deletions:    file.Deletions,
				Patch:        file.Patch,
				Sha:          file.Sha,
				HasPatch:     file.Patch != "",
			})
		}
	}
	return files, nil
}

// restArgs builds `gh api` argv for a REST path, adding --hostname only for a
// non-github.com host so the common case matches gh's own default resolution.
func (f *Fetcher) restArgs(ref PRRef, path string, extra ...string) []string {
	args := []string{"api"}
	if ref.Host != "" && ref.Host != "github.com" {
		args = append(args, "--hostname", ref.Host)
	}
	args = append(args, path)
	return append(args, extra...)
}

// FindFile returns the file entry for a path, or nil.
func (r *Review) FindFile(path string) *FileEntry {
	for i := range r.Files {
		if r.Files[i].Path == path {
			return &r.Files[i]
		}
	}
	return nil
}
