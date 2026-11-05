package openaimcp

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"rk/internal/versionprune"
)

const (
	// Repo is the upstream repository tunnel-client releases resolve from.
	Repo = "openai/tunnel-client"
	// defaultAPIBase is the GitHub REST API origin (tests point at httptest).
	defaultAPIBase = "https://api.github.com"
	// resolveTimeout bounds the latest-release API call (the code-server
	// bound: api.github.com routinely exceeds 10 s on slow links).
	resolveTimeout = 30 * time.Second
	// downloadTimeout bounds the ~30 MB archive transfer on a slow link.
	downloadTimeout = 10 * time.Minute
	// maxBinarySize caps the extracted member, so a hostile archive cannot
	// fill the disk. The real binary is ~26 MB.
	maxBinarySize = 256 << 20
	// currentLinkName is the symlink beside the version dirs naming the
	// active one.
	currentLinkName = "current"
)

// Installer carries the seams for the managed tunnel-client install. The
// struct (not package vars) holds the client and platform so parallel tests
// never race (the internal/codeserver Installer idiom).
type Installer struct {
	Client   *http.Client
	GOOS     string
	GOARCH   string
	APIBase  string
	Progress io.Writer
}

// NewInstaller returns an Installer with production defaults.
func NewInstaller() *Installer {
	return &Installer{
		Client:   &http.Client{}, // per-call contexts carry the timeouts
		GOOS:     runtime.GOOS,
		GOARCH:   runtime.GOARCH,
		APIBase:  defaultAPIBase,
		Progress: io.Discard,
	}
}

// InstallResult reports a completed install.
type InstallResult struct {
	// Version is the active release version, no leading "v".
	Version string
	// Path is the active version dir.
	Path string
	// AlreadyCurrent reports the idempotent skip: nothing was downloaded.
	AlreadyCurrent bool
}

// versionPattern is the shape a release tag must have once its "v" is
// stripped. The version becomes a directory name under bin/ that Install may
// RemoveAll, so anything that could climb out of bin/ is refused.
var versionPattern = regexp.MustCompile(`^[0-9]+(\.[0-9]+){1,3}([-+][0-9A-Za-z.]+)?$`)

// release is a resolved tunnel-client release for the host platform.
type release struct {
	version   string
	assetName string
	assetURL  string
	digest    string // sha256 hex; "" when GitHub supplied none
}

// InstalledVersion reads the current symlink's target; "" when nothing is
// installed.
func (l Layout) InstalledVersion() (string, error) {
	target, err := os.Readlink(filepath.Join(l.BinDir(), currentLinkName))
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return filepath.Base(target), nil
}

// Install makes the latest tunnel-client release the active managed install
// under l.BinDir(): resolve the release and its host-platform asset, skip
// when current already names it, download into a staging dir hashing as it
// streams, FAIL CLOSED on a missing or mismatched GitHub digest, extract only
// the top-level tunnel-client member, promote staging to <version>/, flip
// current with a temp symlink + rename, and prune superseded versions
// (keeping the pre-flip one for rollback). Both promotions are same-
// filesystem renames, so a crash leaves the old install intact or a stray
// staging dir, never a torn current.
func (ins *Installer) Install(ctx context.Context, l Layout) (InstallResult, error) {
	rel, err := ins.resolveLatest(ctx)
	if err != nil {
		return InstallResult{}, err
	}
	installed, err := l.InstalledVersion()
	if err != nil {
		return InstallResult{}, fmt.Errorf("reading the active version: %w", err)
	}
	dest := filepath.Join(l.BinDir(), rel.version)
	if installed == rel.version {
		return InstallResult{Version: rel.version, Path: dest, AlreadyCurrent: true}, nil
	}
	if rel.digest == "" {
		return InstallResult{}, fmt.Errorf("release %s supplied no sha256 digest for %s; refusing to install an unverified binary", rel.version, rel.assetName)
	}

	// The root also holds the key file, so it is created private here too.
	if err := os.MkdirAll(l.Root, 0o700); err != nil {
		return InstallResult{}, fmt.Errorf("creating %s: %w", l.Root, err)
	}
	if err := os.MkdirAll(l.BinDir(), 0o755); err != nil {
		return InstallResult{}, fmt.Errorf("creating %s: %w", l.BinDir(), err)
	}
	staging, err := os.MkdirTemp(l.BinDir(), ".staging-")
	if err != nil {
		return InstallResult{}, fmt.Errorf("creating staging dir under %s: %w", l.BinDir(), err)
	}
	defer os.RemoveAll(staging) // a no-op after a successful promotion

	archive := filepath.Join(staging, rel.assetName)
	sum, err := ins.download(ctx, rel, archive)
	if err != nil {
		return InstallResult{}, err
	}
	if !strings.EqualFold(sum, rel.digest) {
		return InstallResult{}, fmt.Errorf("checksum mismatch for %s: downloaded sha256:%s, release digest sha256:%s; refusing to install an unverified binary", rel.assetName, sum, rel.digest)
	}

	tree := filepath.Join(staging, "tree")
	if err := os.Mkdir(tree, 0o755); err != nil {
		return InstallResult{}, err
	}
	if err := extractBinary(archive, filepath.Join(tree, BinaryName)); err != nil {
		return InstallResult{}, fmt.Errorf("extracting %s: %w", rel.assetName, err)
	}

	if err := os.RemoveAll(dest); err != nil {
		return InstallResult{}, fmt.Errorf("clearing leftover version dir %s: %w", dest, err)
	}
	if err := os.Rename(tree, dest); err != nil {
		return InstallResult{}, fmt.Errorf("promoting staged install to %s: %w", dest, err)
	}
	current := filepath.Join(l.BinDir(), currentLinkName)
	tmp := current + ".tmp"
	if err := os.Remove(tmp); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return InstallResult{}, fmt.Errorf("clearing stale temp symlink: %w", err)
	}
	if err := os.Symlink(rel.version, tmp); err != nil {
		return InstallResult{}, fmt.Errorf("creating temp symlink: %w", err)
	}
	if err := os.Rename(tmp, current); err != nil {
		return InstallResult{}, fmt.Errorf("flipping the current symlink: %w", err)
	}

	versionprune.Prune(l.BinDir(), installed, versionprune.WriterLogger(ins.Progress))
	return InstallResult{Version: rel.version, Path: dest}, nil
}

// assetName is the release archive for a version and platform:
// tunnel-client-v<ver>-<os>-<arch>.zip, published for linux and darwin on
// amd64 and arm64. The tunnel-client-runtime-* build is deliberately not
// used: its CLI surface is not the one the profile was verified against.
func assetName(version, goos, goarch string) (string, error) {
	if (goos != "linux" && goos != "darwin") || (goarch != "amd64" && goarch != "arm64") {
		return "", fmt.Errorf("unsupported platform %s/%s: tunnel-client is installed for linux and darwin (amd64, arm64); put tunnel-client on PATH instead", goos, goarch)
	}
	return fmt.Sprintf("%s-v%s-%s-%s.zip", BinaryName, version, goos, goarch), nil
}

// resolveLatest reads the latest release and picks the host-platform asset.
// The platform is validated before any request.
func (ins *Installer) resolveLatest(ctx context.Context) (release, error) {
	if _, err := assetName("0", ins.GOOS, ins.GOARCH); err != nil {
		return release{}, err
	}
	endpoint := ins.APIBase + "/repos/" + Repo + "/releases/latest"
	reqCtx, cancel := context.WithTimeout(ctx, resolveTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return release{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := ins.Client.Do(req)
	if err != nil {
		return release{}, fmt.Errorf("querying GitHub releases: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return release{}, fmt.Errorf("GitHub API returned HTTP %d for %s", resp.StatusCode, endpoint)
	}
	var doc struct {
		TagName string `json:"tag_name"`
		Assets  []struct {
			Name   string `json:"name"`
			URL    string `json:"browser_download_url"`
			Digest string `json:"digest"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return release{}, fmt.Errorf("decoding GitHub release response: %w", err)
	}
	version := strings.TrimPrefix(doc.TagName, "v")
	if !versionPattern.MatchString(version) {
		return release{}, fmt.Errorf("latest release tag %q in %s is not a version", doc.TagName, Repo)
	}
	want, err := assetName(version, ins.GOOS, ins.GOARCH)
	if err != nil {
		return release{}, err
	}
	for _, a := range doc.Assets {
		if a.Name == want {
			digest, ok := strings.CutPrefix(a.Digest, "sha256:")
			if !ok {
				digest = ""
			}
			return release{version: version, assetName: a.Name, assetURL: a.URL, digest: digest}, nil
		}
	}
	return release{}, fmt.Errorf("release %s has no asset %s", doc.TagName, want)
}

// download fetches the asset to dest, hashing while streaming, and returns
// the sha256 hex.
func (ins *Installer) download(ctx context.Context, rel release, dest string) (string, error) {
	dlCtx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(dlCtx, http.MethodGet, rel.assetURL, nil)
	if err != nil {
		return "", err
	}
	resp, err := ins.Client.Do(req)
	if err != nil {
		return "", fmt.Errorf("downloading %s: %w", rel.assetName, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("downloading %s: HTTP %d", rel.assetName, resp.StatusCode)
	}
	fmt.Fprintf(ins.Progress, "Downloading %s...\n", rel.assetName)
	f, err := os.Create(dest)
	if err != nil {
		return "", fmt.Errorf("creating staged archive: %w", err)
	}
	hasher := sha256.New()
	_, copyErr := io.Copy(io.MultiWriter(f, hasher), resp.Body)
	closeErr := f.Close()
	if copyErr != nil {
		return "", fmt.Errorf("downloading %s: %w", rel.assetName, copyErr)
	}
	if closeErr != nil {
		return "", fmt.Errorf("writing %s: %w", dest, closeErr)
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

// extractBinary copies the archive's top-level tunnel-client member to dest
// with mode 0755. Nothing else in the archive is extracted, so no entry name
// is ever joined onto a path.
func extractBinary(archive, dest string) error {
	zr, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer zr.Close()
	for _, member := range zr.File {
		if member.Name != BinaryName || !member.Mode().IsRegular() {
			continue
		}
		if member.UncompressedSize64 > maxBinarySize {
			return fmt.Errorf("%s is %d bytes, over the %d-byte cap", BinaryName, member.UncompressedSize64, maxBinarySize)
		}
		src, err := member.Open()
		if err != nil {
			return err
		}
		defer src.Close()
		out, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o755)
		if err != nil {
			return err
		}
		n, copyErr := io.Copy(out, io.LimitReader(src, maxBinarySize+1))
		closeErr := out.Close()
		if copyErr != nil {
			return copyErr
		}
		if n > maxBinarySize {
			return fmt.Errorf("%s exceeds the %d-byte cap", BinaryName, maxBinarySize)
		}
		return closeErr
	}
	return fmt.Errorf("archive does not contain a top-level %s", BinaryName)
}
