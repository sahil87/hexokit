package desktop

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// Release is a resolved desktop-app release: the version plus the platform
// asset (macOS DMG / Linux AppImage) matching the host architecture.
type Release struct {
	// Version is the release version with no leading "v" (e.g. "3.13.0").
	Version string
	// AssetName is the matched asset filename.
	AssetName string
	// AssetURL is the asset's browser_download_url.
	AssetURL string
	// Digest is the asset's SHA256 hex digest when the API supplied one
	// ("" when absent or a non-sha256 algorithm — on darwin the checksum step
	// is then skipped and codesign remains the hard verification gate; on
	// linux a missing digest REFUSES the install, there is no second gate).
	Digest string
}

// ghAsset / ghRelease decode the subset of the GitHub releases API this
// package consumes. Unknown fields are tolerated. No GitHub client library —
// net/http + encoding/json only (intake § Impact: no new dependencies).
type ghAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	// Digest is "sha256:<hex>" when GitHub computed one for the upload.
	Digest string `json:"digest"`
}

type ghRelease struct {
	TagName string    `json:"tag_name"`
	Assets  []ghAsset `json:"assets"`
}

// archLabel maps a (GOOS, GOARCH) pair onto the release asset's arch label
// and extension (mirroring electron-builder's per-target ${arch} naming:
// darwin amd64 → x64 in the DMG name, while linux amd64 → x86_64 in the
// AppImage name). Errors before any HTTP request on an unsupported pair.
func archLabel(goos, goarch string) (label, suffix string, err error) {
	switch goos {
	case "darwin":
		switch goarch {
		case "arm64":
			return "arm64", ".dmg", nil
		case "amd64":
			return "x64", ".dmg", nil
		}
		return "", "", fmt.Errorf("unsupported architecture %q — desktop DMGs are published for arm64 and x64 only", goarch)
	case "linux":
		switch goarch {
		case "amd64":
			return "x86_64", ".AppImage", nil
		case "arm64":
			return "arm64", ".AppImage", nil
		}
		return "", "", fmt.Errorf("unsupported architecture %q — desktop AppImages are published for x86_64 and arm64 only", goarch)
	}
	return "", "", fmt.Errorf("unsupported platform %q — the desktop shell is packaged for macOS and Linux only", goos)
}

// assetKind names the package format for error messages.
func assetKind(goos string) string {
	if goos == "linux" {
		return "AppImage"
	}
	return "DMG"
}

// normalizeReleaseTag maps a user-supplied --version value onto the repo's
// v-prefixed tag convention: a bare semver ("3.12.2") gains the "v"; anything
// already prefixed (or non-numeric) passes through untouched.
func normalizeReleaseTag(tag string) string {
	if tag != "" && tag[0] >= '0' && tag[0] <= '9' {
		return "v" + tag
	}
	return tag
}

// ResolveRelease queries the GitHub releases API for the latest release (tag
// == "") or a specific tag, and selects the asset for the host platform and
// architecture. Unauthenticated by default (public repo); Token is sent purely
// for rate-limit headroom. A 403/429 produces the explicit rate-limit error
// the intake requires.
func (ins *Installer) ResolveRelease(ctx context.Context, tag string) (Release, error) {
	label, suffix, err := archLabel(ins.GOOS, ins.Arch)
	if err != nil {
		return Release{}, err
	}

	endpoint := ins.APIBase + "/repos/" + ins.Repo + "/releases/latest"
	if tag != "" {
		tag = normalizeReleaseTag(tag)
		endpoint = ins.APIBase + "/repos/" + ins.Repo + "/releases/tags/" + url.PathEscape(tag)
	}

	reqCtx, cancel := context.WithTimeout(ctx, apiTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return Release{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	if ins.Token != "" {
		req.Header.Set("Authorization", "Bearer "+ins.Token)
	}

	resp, err := ins.Client.Do(req)
	if err != nil {
		return Release{}, fmt.Errorf("querying GitHub releases: %w", err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
		// fall through to decode
	case http.StatusForbidden, http.StatusTooManyRequests:
		return Release{}, fmt.Errorf(
			"GitHub API request denied (HTTP %d) — likely the unauthenticated rate limit (60 requests/hour per IP); run `gh auth login` or set GITHUB_TOKEN for more headroom",
			resp.StatusCode)
	case http.StatusNotFound:
		if tag != "" {
			return Release{}, fmt.Errorf("release %s not found in %s", tag, ins.Repo)
		}
		return Release{}, fmt.Errorf("no releases found in %s", ins.Repo)
	default:
		return Release{}, fmt.Errorf("GitHub API returned HTTP %d for %s", resp.StatusCode, endpoint)
	}

	var rel ghRelease
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return Release{}, fmt.Errorf("decoding GitHub release response: %w", err)
	}

	assetSuffix := "-" + label + suffix
	// Prefer the current prefix; fall back to the pre-rename prefix so a
	// release carrying either artifact naming resolves (the rename ships one
	// release ahead of any consumer that still publishes the old name).
	for _, prefix := range []string{assetPrefix, legacyAssetPrefix} {
		for _, a := range rel.Assets {
			if strings.HasPrefix(a.Name, prefix) && strings.HasSuffix(a.Name, assetSuffix) {
				return Release{
					Version:   strings.TrimPrefix(rel.TagName, "v"),
					AssetName: a.Name,
					AssetURL:  a.BrowserDownloadURL,
					Digest:    parseSHA256Digest(a.Digest),
				}, nil
			}
		}
	}
	return Release{}, fmt.Errorf("release %s has no %s %s asset (looked for %s*%s or %s*%s)", rel.TagName, label, assetKind(ins.GOOS), assetPrefix, assetSuffix, legacyAssetPrefix, assetSuffix)
}

// parseSHA256Digest extracts the hex digest from a GitHub asset digest value
// ("sha256:<hex>"). Absent or non-sha256 values yield "" — how a missing
// digest is handled is platform-specific (see Release.Digest).
func parseSHA256Digest(d string) string {
	if hex, ok := strings.CutPrefix(d, "sha256:"); ok {
		return hex
	}
	return ""
}
