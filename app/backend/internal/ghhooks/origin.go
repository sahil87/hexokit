package ghhooks

import (
	"net/url"
	"strings"

	"rk/internal/validate"
)

// ParseOriginURL reduces a git remote URL to the GitHub owner/name it points
// at. It reads the https, ssh:// and scp-like (git@host:owner/name) forms and
// ignores the host: the result is only ever compared with an event's repo.
func ParseOriginURL(raw string) (nwo string, ok bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", false
	}
	var path string
	if strings.Contains(raw, "://") {
		u, err := url.Parse(raw)
		if err != nil {
			return "", false
		}
		path = u.Path
	} else if _, rest, found := strings.Cut(raw, ":"); found {
		path = rest
	} else {
		return "", false
	}
	path = strings.TrimSuffix(strings.Trim(path, "/"), ".git")
	parts := strings.Split(path, "/")
	if len(parts) < 2 {
		return "", false
	}
	nwo = parts[len(parts)-2] + "/" + parts[len(parts)-1]
	if validate.ValidateGitHubRepo(nwo) != "" {
		return "", false
	}
	return nwo, true
}
