package ghhooks

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"time"

	"rk/internal/operator"
	"rk/internal/tmux"
)

// gitTimeout bounds the `git remote get-url` lookup of one checkout.
const gitTimeout = 5 * time.Second

// gitOriginURL is the git subprocess seam: the origin URL of the checkout at
// dir. Argv only, never a shell string.
var gitOriginURL = func(ctx context.Context, dir string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-C", dir, "remote", "get-url", "origin")
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git remote get-url origin in %s: %w", dir, err)
	}
	return out.String(), nil
}

// GitOriginNWO resolves a local checkout to the GitHub owner/name of its
// origin remote.
func GitOriginNWO(ctx context.Context, dir string) (string, error) {
	url, err := gitOriginURL(ctx, dir)
	if err != nil {
		return "", err
	}
	nwo, ok := ParseOriginURL(url)
	if !ok {
		return "", fmt.Errorf("origin of %s is not a GitHub owner/name: %q", dir, url)
	}
	return nwo, nil
}

// DefaultSource reads the real world: live tmux servers, each server's
// operator ledger from the state home (a missing ledger is an empty one, an
// unparsable one an error the mapping logs and skips), and git for origins.
func DefaultSource() Source {
	return Source{
		Servers: tmux.ListServers,
		State: func(ctx context.Context, server string) (*operator.State, error) {
			path, err := operator.StatePathForServer(ctx, server)
			if err != nil {
				return nil, err
			}
			return operator.Load(path)
		},
		OriginNWO: GitOriginNWO,
	}
}
