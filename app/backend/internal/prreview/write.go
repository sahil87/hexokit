package prreview

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"rk/internal/diffrows"
	"strconv"
)

// The write paths.
//
// EVERY body goes to gh on STDIN via `gh api … --input -`, never on argv
// (Constitution I). Comment bodies are user-authored prose — the least
// argv-safe input in the system — and a body on argv is also a body in the
// process table.
//
// Which API each verb speaks is not arbitrary: REST has no review-thread object
// at all (no isResolved, no isOutdated, no resolve verb), while GraphQL has no
// reply-by-parent verb that does not first construct a review. Each call uses
// the API that is the only one expressing it.

// ErrNoPendingReview is returned when a review-mode comment cannot find or
// create the viewer's pending review.
var ErrNoPendingReview = errors.New("no pending review")

// CommentMode selects the composer's two GitHub modes. They differ for the
// LISTENER, not just for the user: a pending review is invisible to gh until
// submitted, so only ModeSingle can dispatch on post.
type CommentMode string

const (
	ModeSingle CommentMode = "single"
	ModeReview CommentMode = "review"
)

// NewComment is one line-anchored comment request.
type NewComment struct {
	Path string
	Line int
	// StartLine, when non-zero, makes this a multi-line comment anchored from
	// StartLine to Line.
	StartLine int
	// Side is L (pre-image) or R (post-image) — GitHub's own address half.
	Side string
	Body string
	Mode CommentMode
}

// AddComment posts a line-anchored comment. ModeSingle posts it immediately
// (REST, anchored to the head sha); ModeReview appends it to the viewer's
// single pending review (GraphQL find-or-create — GitHub permits exactly one
// pending review per viewer per PR, so an unconditional create 422s on the
// second comment).
//
// StartLine (a multi-line anchor) is honored on the single-comment path only:
// addPullRequestReviewThread takes a single line, and the spec explicitly
// declines to build a batched-review authoring loop.
func (f *Fetcher) AddComment(ctx context.Context, review *Review, in NewComment) error {
	ref, err := ParsePRURL(review.URL)
	if err != nil {
		return err
	}
	defer f.Invalidate(review.URL)

	if in.Mode == ModeReview {
		return f.addPendingComment(ctx, ref, in)
	}

	body := map[string]any{
		"path":      in.Path,
		"body":      in.Body,
		"commit_id": review.HeadSha,
		"line":      in.Line,
		"side":      apiSide(in.Side),
	}
	if in.StartLine > 0 && in.StartLine < in.Line {
		body["start_line"] = in.StartLine
		body["start_side"] = apiSide(in.Side)
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	_, err = f.ghExec(ctx, payload, f.restArgs(ref,
		"repos/"+ref.Repository()+"/pulls/"+strconv.Itoa(ref.Number)+"/comments",
		"--method", "POST", "--input", "-")...)
	return err
}

// Reply appends a comment to an existing thread. REST is the only API with a
// reply-by-parent verb that does not wrap the reply in a review.
func (f *Fetcher) Reply(ctx context.Context, review *Review, commentDatabaseID int64, body string) error {
	ref, err := ParsePRURL(review.URL)
	if err != nil {
		return err
	}
	if commentDatabaseID <= 0 {
		return fmt.Errorf("reply: no parent comment id")
	}
	defer f.Invalidate(review.URL)
	payload, err := json.Marshal(map[string]any{"body": body})
	if err != nil {
		return err
	}
	_, err = f.ghExec(ctx, payload, f.restArgs(ref,
		"repos/"+ref.Repository()+"/pulls/"+strconv.Itoa(ref.Number)+
			"/comments/"+strconv.FormatInt(commentDatabaseID, 10)+"/replies",
		"--method", "POST", "--input", "-")...)
	return err
}

const resolveMutation = `mutation($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) { thread { id isResolved } }
}`

const unresolveMutation = `mutation($threadId: ID!) {
  unresolveReviewThread(input: {threadId: $threadId}) { thread { id isResolved } }
}`

// SetThreadResolved resolves or unresolves a thread. GraphQL only — REST has
// no thread object.
func (f *Fetcher) SetThreadResolved(ctx context.Context, review *Review, threadID string, resolved bool) error {
	ref, err := ParsePRURL(review.URL)
	if err != nil {
		return err
	}
	if threadID == "" {
		return fmt.Errorf("thread: empty id")
	}
	defer f.Invalidate(review.URL)
	mutation := unresolveMutation
	if resolved {
		mutation = resolveMutation
	}
	_, err = f.graphql(ctx, ref, mutation, map[string]any{"threadId": threadID})
	return err
}

// MarkEyes posts the 👀 reaction on a comment — the dedupe marker.
//
// ORDERING IS LOAD-BEARING: this runs only AFTER a verified submit. Marking
// first would strand a comment silently when the injection failed its probe.
func (f *Fetcher) MarkEyes(ctx context.Context, review *Review, commentDatabaseID int64) error {
	ref, err := ParsePRURL(review.URL)
	if err != nil {
		return err
	}
	if commentDatabaseID <= 0 {
		return fmt.Errorf("mark: no comment id")
	}
	defer f.Invalidate(review.URL)
	payload, err := json.Marshal(map[string]any{"content": "eyes"})
	if err != nil {
		return err
	}
	_, err = f.ghExec(ctx, payload, f.restArgs(ref,
		"repos/"+ref.Repository()+"/pulls/comments/"+
			strconv.FormatInt(commentDatabaseID, 10)+"/reactions",
		"--method", "POST", "--input", "-")...)
	return err
}

const pendingReviewQuery = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id
      reviews(first: 1, states: [PENDING]) { nodes { id } }
    }
  }
}`

const addReviewMutation = `mutation($pullRequestId: ID!) {
  addPullRequestReview(input: {pullRequestId: $pullRequestId}) { pullRequestReview { id } }
}`

const addThreadMutation = `mutation($reviewId: ID!, $path: String!, $line: Int!, $side: DiffSide!, $body: String!) {
  addPullRequestReviewThread(input: {pullRequestReviewId: $reviewId, path: $path, line: $line, side: $side, body: $body}) {
    thread { id }
  }
}`

// addPendingComment finds or creates the viewer's single pending review and
// appends the comment to it.
func (f *Fetcher) addPendingComment(ctx context.Context, ref PRRef, in NewComment) error {
	out, err := f.graphql(ctx, ref, pendingReviewQuery, map[string]any{
		"owner": ref.Owner, "repo": ref.Repo, "number": ref.Number,
	})
	if err != nil {
		return err
	}
	var decoded struct {
		Data struct {
			Repository struct {
				PullRequest struct {
					ID      string `json:"id"`
					Reviews struct {
						Nodes []struct {
							ID string `json:"id"`
						} `json:"nodes"`
					} `json:"reviews"`
				} `json:"pullRequest"`
			} `json:"repository"`
		} `json:"data"`
	}
	if err := json.Unmarshal(out, &decoded); err != nil {
		return err
	}
	pr := decoded.Data.Repository.PullRequest
	reviewID := ""
	if len(pr.Reviews.Nodes) > 0 {
		reviewID = pr.Reviews.Nodes[0].ID
	}
	if reviewID == "" {
		if pr.ID == "" {
			return ErrNoPendingReview
		}
		created, err := f.graphql(ctx, ref, addReviewMutation, map[string]any{"pullRequestId": pr.ID})
		if err != nil {
			return err
		}
		var newReview struct {
			Data struct {
				AddPullRequestReview struct {
					PullRequestReview struct {
						ID string `json:"id"`
					} `json:"pullRequestReview"`
				} `json:"addPullRequestReview"`
			} `json:"data"`
		}
		if err := json.Unmarshal(created, &newReview); err != nil {
			return err
		}
		reviewID = newReview.Data.AddPullRequestReview.PullRequestReview.ID
	}
	if reviewID == "" {
		return ErrNoPendingReview
	}
	_, err = f.graphql(ctx, ref, addThreadMutation, map[string]any{
		"reviewId": reviewID,
		"path":     in.Path,
		"line":     in.Line,
		"side":     apiSide(in.Side),
		"body":     in.Body,
	})
	return err
}

// graphql runs one GraphQL document with its variables as a JSON body on
// STDIN. Variables ride the body rather than `-F` flags for the same reason
// comment bodies do: a body is the one channel that cannot be read out of the
// process table.
func (f *Fetcher) graphql(ctx context.Context, ref PRRef, query string, variables map[string]any) ([]byte, error) {
	payload, err := json.Marshal(map[string]any{"query": query, "variables": variables})
	if err != nil {
		return nil, err
	}
	args := []string{"api", "graphql"}
	if ref.Host != "" && ref.Host != "github.com" {
		args = append(args, "--hostname", ref.Host)
	}
	args = append(args, "--input", "-")
	return f.ghExec(ctx, payload, args...)
}

// GitHub's REST `side`/`start_side` and its GraphQL `DiffSide` enum both spell
// the sides out; this package's wire and DOM vocabulary is the one-letter form
// (diffrows.SideLeft/diffrows.SideRight, matching the R264/L120 anchor refs). The two are NOT
// interchangeable: posting "R" fails the create-comment oneOf with
// `R is not a member of ["LEFT", "RIGHT"]`, and the error names every other
// subschema instead of the side, so translate at the API boundary.
const (
	apiSideLeft  = "LEFT"
	apiSideRight = "RIGHT"
)

func apiSide(side string) string {
	if side == diffrows.SideLeft {
		return apiSideLeft
	}
	return apiSideRight
}
