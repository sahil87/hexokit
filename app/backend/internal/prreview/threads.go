package prreview

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

// threadsQuery is the DETAIL thread read: full comment bodies plus the viewer
// login on the node the query already selects. The digest counterpart lives in
// internal/prstatus and carries only what the listener's predicate needs — see
// this package's doc comment for why the two are separate.
// GitHub prices a GraphQL query on the `first:` values a query DECLARES, not on
// the rows it returns — the cost of this one is (threads x comments)/100 + 1
// whether the PR has five threads or five hundred. At `comments(first: 100)`
// that was 101 points EVERY time the tile mounted, measured: a page reload cost
// ~100 points and ~36 reloads exhausted the 5,000/hour budget, which is what
// took the whole PR-status join down with it.
//
// Thread coverage is kept wide and the COMMENT bound is the one that gives:
// a missing thread is feedback the reader never sees, while a thread past its
// twentieth comment is one nobody is reading in a side panel. 100 x 20 costs
// 21 — a 5x cut for a truncation that effectively never fires. The listener is
// unaffected either way: its 👀 marker rides the FIRST comment.
//
// The four PR SCALARS ride this query for free, and that is measured, not
// assumed: with `title state headRefOid baseRefOid` selected, `rateLimit { cost }`
// still reads 21 and the call still returns in ~0.78 s. A scalar is not a
// connection, so it declares no node product and adds nothing to the price.
// They used to cost a REST round trip of their own (~0.65 s on the critical
// path) for no reason but habit. R3a's rule reads both ways: a nested
// connection is never free because it rides an existing call, and a scalar
// never needs a call of its own.
const threadsQuery = `query($owner: String!, $repo: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      title
      state
      headRefOid
      baseRefOid
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          diffSide
          comments(first: 20) {
            nodes {
              id
              databaseId
              body
              createdAt
              url
              author { login }
              reactions(content: EYES, first: 1) { totalCount }
            }
          }
        }
      }
    }
  }
}`

type ghThreadsResponse struct {
	Data struct {
		Viewer struct {
			Login string `json:"login"`
		} `json:"viewer"`
		Repository struct {
			PullRequest struct {
				Title         string `json:"title"`
				State         string `json:"state"`
				HeadRefOid    string `json:"headRefOid"`
				BaseRefOid    string `json:"baseRefOid"`
				ReviewThreads struct {
					Nodes []ghThread `json:"nodes"`
				} `json:"reviewThreads"`
			} `json:"pullRequest"`
		} `json:"repository"`
	} `json:"data"`
}

type ghThread struct {
	ID         string `json:"id"`
	IsResolved bool   `json:"isResolved"`
	IsOutdated bool   `json:"isOutdated"`
	Path       string `json:"path"`
	Line       *int   `json:"line"`
	StartLine  *int   `json:"startLine"`
	DiffSide   string `json:"diffSide"`
	Comments   struct {
		Nodes []ghThreadComment `json:"nodes"`
	} `json:"comments"`
}

type ghThreadComment struct {
	ID         string `json:"id"`
	DatabaseID int64  `json:"databaseId"`
	Body       string `json:"body"`
	CreatedAt  string `json:"createdAt"`
	URL        string `json:"url"`
	Author     *struct {
		Login string `json:"login"`
	} `json:"author"`
	Reactions struct {
		TotalCount int `json:"totalCount"`
	} `json:"reactions"`
}

// prMeta is the PR-level read: the two shas the diff is expressed against plus
// the display identity. Head and base shas are load-bearing twice over — they
// key the blob cache and they decide which image each row is lexed against (R5).
type prMeta struct {
	Title   string
	State   string
	HeadSha string
	BaseSha string
}

// fetchThreads runs the one GraphQL read the detail document needs: the review
// threads, the viewer login, and the PR meta, all off the same node.
func (f *Fetcher) fetchThreads(ctx context.Context, ref PRRef) (prMeta, []Thread, string, error) {
	args := []string{"api", "graphql"}
	if ref.Host != "" && ref.Host != "github.com" {
		args = append(args, "--hostname", ref.Host)
	}
	args = append(args,
		"-f", "query="+threadsQuery,
		"-F", "owner="+ref.Owner,
		"-F", "repo="+ref.Repo,
		"-F", "number="+strconv.Itoa(ref.Number),
	)
	out, err := f.ghExec(ctx, nil, args...)
	if err != nil {
		return prMeta{}, nil, "", err
	}
	var decoded ghThreadsResponse
	if err := json.Unmarshal(out, &decoded); err != nil {
		return prMeta{}, nil, "", err
	}
	pr := decoded.Data.Repository.PullRequest
	nodes := pr.ReviewThreads.Nodes
	threads := make([]Thread, 0, len(nodes))
	for _, node := range nodes {
		threads = append(threads, projectThread(node))
	}
	meta := prMeta{
		Title: pr.Title,
		// GraphQL spells the enum "OPEN" where REST spells it "open". The field
		// is write-only today, which makes a silent drift MORE likely to survive
		// unnoticed, not less — so normalise at the boundary and keep the wire
		// byte-identical to what the REST read produced.
		State:   strings.ToLower(pr.State),
		HeadSha: pr.HeadRefOid,
		BaseSha: pr.BaseRefOid,
	}
	return meta, threads, decoded.Data.Viewer.Login, nil
}

func projectThread(node ghThread) Thread {
	thread := Thread{
		ID:         node.ID,
		IsResolved: node.IsResolved,
		IsOutdated: node.IsOutdated,
		Path:       node.Path,
		Side:       node.DiffSide,
	}
	if node.Line != nil {
		thread.Line = *node.Line
	}
	if node.StartLine != nil {
		thread.StartLine = *node.StartLine
	}
	for _, comment := range node.Comments.Nodes {
		author := ""
		if comment.Author != nil {
			author = comment.Author.Login
		}
		thread.Comments = append(thread.Comments, Comment{
			ID:         comment.ID,
			DatabaseID: comment.DatabaseID,
			Author:     author,
			Body:       comment.Body,
			CreatedAt:  parseGhTime(comment.CreatedAt),
			URL:        comment.URL,
			Eyes:       comment.Reactions.TotalCount > 0,
		})
	}
	return thread
}

// FirstComment returns the thread's opening comment, or nil for the malformed
// zero-comment case gh can return mid-deletion.
func (t Thread) FirstComment() *Comment {
	if len(t.Comments) == 0 {
		return nil
	}
	return &t.Comments[0]
}

// SuggestionOnly reports whether EVERY comment in the thread is nothing but a
// ```suggestion fence. Such a thread is a mechanical edit GitHub commits with
// one button, so the listener never spends an agent turn on it. A thread that
// argues a point AND offers a suggestion is not suggestion-only and still
// dispatches.
func (t Thread) SuggestionOnly() bool {
	if len(t.Comments) == 0 {
		return false
	}
	for _, comment := range t.Comments {
		if !isSuggestionOnlyBody(comment.Body) {
			return false
		}
	}
	return true
}

func isSuggestionOnlyBody(body string) bool {
	inFence := false
	sawSuggestion := false
	for _, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") {
			if !inFence {
				if !strings.EqualFold(strings.TrimPrefix(trimmed, "```"), "suggestion") {
					return false
				}
				sawSuggestion = true
			}
			inFence = !inFence
			continue
		}
		if inFence || trimmed == "" {
			continue
		}
		return false
	}
	return sawSuggestion && !inFence
}

// parseGhTime decodes GitHub's RFC3339 stamps. An unparseable value yields the
// zero time rather than an error — a timestamp is display sugar and must never
// fail a whole thread fetch.
func parseGhTime(raw string) time.Time {
	if raw == "" {
		return time.Time{}
	}
	parsed, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return time.Time{}
	}
	return parsed
}
