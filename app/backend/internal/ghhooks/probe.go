package ghhooks

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"rk/internal/validate"
)

// Admin is the outcome of the admin probe.
type Admin int

const (
	// AdminProbeFailed: gh errored, timed out, is not authenticated, or
	// answered something other than a boolean. Treated like NoAdmin for every
	// decision; the distinction only reaches doctor's wording. The zero value,
	// so an unset result never reads as admin.
	AdminProbeFailed Admin = iota
	// AdminNo: the account cannot create a hook on the repo.
	AdminNo
	// AdminYes: the account has admin on the repo.
	AdminYes
)

// ProbeResult is one repo's probe: the classification and, for AdminProbeFailed,
// why.
type ProbeResult struct {
	Admin Admin
	Err   error
}

// ghTimeout bounds every short gh call (the probe, the extension check, hook
// listing and deletion).
const ghTimeout = 10 * time.Second

// runGH is the gh subprocess seam: argv after `gh`, stdout back.
var runGH = func(ctx context.Context, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, ghTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "gh", args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("gh %s: %w", args[0], ctx.Err())
		}
		if msg := firstLine(stderr.String()); msg != "" {
			return nil, fmt.Errorf("gh %s: %s", args[0], msg)
		}
		return nil, fmt.Errorf("gh %s: %w", args[0], err)
	}
	return stdout.Bytes(), nil
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	return line
}

// ProbeAdmin asks GitHub whether the logged-in account has admin on nwo
// (`gh api repos/<nwo> --jq .permissions.admin`). Never persisted: gh is the
// durable source, so every caller re-derives.
func ProbeAdmin(ctx context.Context, nwo string) ProbeResult {
	if msg := validate.ValidateGitHubRepo(nwo); msg != "" {
		return ProbeResult{Err: errors.New(msg)}
	}
	out, err := runGH(ctx, "api", "repos/"+nwo, "--jq", ".permissions.admin")
	if err != nil {
		return ProbeResult{Err: err}
	}
	switch strings.TrimSpace(string(out)) {
	case "true":
		return ProbeResult{Admin: AdminYes}
	case "false":
		return ProbeResult{Admin: AdminNo}
	}
	return ProbeResult{Err: fmt.Errorf("unexpected permissions.admin answer %q", firstLine(string(out)))}
}

// ExtensionInstalled reports whether the gh-webhook extension answers.
// `gh webhook forward --help` exits 0 only when the extension is present.
func ExtensionInstalled(ctx context.Context) bool {
	_, err := runGH(ctx, "webhook", "forward", "--help")
	return err == nil
}

// ExtensionInstallHint is the one-line remedy doctor shows when the extension
// is missing. rk never installs it: that edits the user's gh configuration.
const ExtensionInstallHint = "gh extension install cli/gh-webhook"
