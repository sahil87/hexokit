package ghhooks

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"rk/internal/validate"
)

// The shape `gh webhook forward` registers on a repository (cli/gh-webhook
// v0.2.0, observed on a live repo): a hook named "cli" whose config.url is
// GitHub's relay, not the local --url. The relay URL is the only thing that
// ties a hook to a forwarder, so it is what cleanup keys on.
const (
	forwarderHookName = "cli"
	forwarderHookURL  = "https://webhook-forwarder.github.com/hook"
)

// Hook is the part of a repository hook cleanup reads.
type Hook struct {
	ID     int64    `json:"id"`
	Name   string   `json:"name"`
	Events []string `json:"events"`
	Config struct {
		URL string `json:"url"`
	} `json:"config"`
}

// IsForwarderHook reports whether h is a hook `gh webhook forward` created.
// It is the only gate on deletion: any hook that is not this exact shape —
// CI, deploy, chat integrations — is never touched.
func IsForwarderHook(h Hook) bool {
	return h.Name == forwarderHookName && h.Config.URL == forwarderHookURL
}

// ListHooks returns nwo's repository hooks.
func ListHooks(ctx context.Context, nwo string) ([]Hook, error) {
	if msg := validate.ValidateGitHubRepo(nwo); msg != "" {
		return nil, fmt.Errorf("%s", msg)
	}
	out, err := runGH(ctx, "api", "repos/"+nwo+"/hooks")
	if err != nil {
		return nil, err
	}
	var hooks []Hook
	if err := json.Unmarshal(out, &hooks); err != nil {
		return nil, fmt.Errorf("decoding hooks of %s: %w", nwo, err)
	}
	return hooks, nil
}

// DeleteHook removes one repository hook by id.
func DeleteHook(ctx context.Context, nwo string, id int64) error {
	if msg := validate.ValidateGitHubRepo(nwo); msg != "" {
		return fmt.Errorf("%s", msg)
	}
	_, err := runGH(ctx, "api", "-X", "DELETE", fmt.Sprintf("repos/%s/hooks/%d", nwo, id))
	if err != nil && strings.Contains(err.Error(), "404") {
		// Already gone: the extension removes its own hook when its session is
		// killed, and cleanup runs right behind that.
		return nil
	}
	return err
}

// RemoveForwarderHooks deletes every forwarder-created hook on nwo and returns
// the ids it deleted. Other hooks are left alone. A delete that fails stops
// the sweep with the ids removed so far.
func RemoveForwarderHooks(ctx context.Context, nwo string) (removed []int64, err error) {
	hooks, err := ListHooks(ctx, nwo)
	if err != nil {
		return nil, err
	}
	for _, h := range hooks {
		if !IsForwarderHook(h) {
			continue
		}
		if err := DeleteHook(ctx, nwo, h.ID); err != nil {
			return removed, fmt.Errorf("deleting hook %d on %s: %w", h.ID, nwo, err)
		}
		removed = append(removed, h.ID)
	}
	return removed, nil
}
