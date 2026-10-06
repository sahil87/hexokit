package codeserver

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// buildTarball assembles a code-server-shaped release tarball in memory: a
// single top-level dir, an executable bin/code-server, a symlink entry, and a
// plain file. Returns the gzipped bytes.
func buildTarball(t *testing.T, version string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	top := "code-server-" + version + "-linux-amd64"

	add := func(hdr *tar.Header, body []byte) {
		t.Helper()
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if len(body) > 0 {
			if _, err := tw.Write(body); err != nil {
				t.Fatal(err)
			}
		}
	}
	add(&tar.Header{Name: top + "/", Typeflag: tar.TypeDir, Mode: 0o755}, nil)
	add(&tar.Header{Name: top + "/bin", Typeflag: tar.TypeDir, Mode: 0o755}, nil)
	add(&tar.Header{Name: top + "/bin/code-server", Typeflag: tar.TypeReg, Mode: 0o755, Size: int64(len("#!/bin/sh\n"))}, []byte("#!/bin/sh\n"))
	add(&tar.Header{Name: top + "/lib/node", Typeflag: tar.TypeReg, Mode: 0o755, Size: 4}, []byte("node"))
	add(&tar.Header{Name: top + "/lib/node-link", Typeflag: tar.TypeSymlink, Linkname: "node"}, nil)
	add(&tar.Header{Name: top + "/README.md", Typeflag: tar.TypeReg, Mode: 0o644, Size: 5}, []byte("hello"))

	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// installServer serves the release listing AND the tarball download for one
// canned (version, payload) pair. digest overrides the asset's advertised
// digest when non-empty ("" advertises the payload's true digest; "NONE"
// omits the digest field entirely).
func installServer(t *testing.T, version string, payload []byte, digest string) *httptest.Server {
	t.Helper()
	trueSum := hex.EncodeToString(sha256.New().Sum(nil)) // placeholder, replaced below
	h := sha256.Sum256(payload)
	trueSum = hex.EncodeToString(h[:])
	advertised := digest
	if advertised == "" {
		advertised = trueSum
	}
	return newReleaseServer(t, func(base string) http.Handler {
		mux := http.NewServeMux()
		mux.HandleFunc("/repos/coder/code-server/releases/latest", func(w http.ResponseWriter, r *http.Request) {
			asset := fmt.Sprintf(`{"name":"code-server-%s-linux-amd64.tar.gz","browser_download_url":%q`, version, base+"/dl/tarball")
			if advertised != "NONE" {
				asset += fmt.Sprintf(`,"digest":"sha256:%s"`, advertised)
			}
			asset += "}"
			fmt.Fprintf(w, `{"tag_name":"v%s","assets":[%s]}`, version, asset)
		})
		mux.HandleFunc("/dl/tarball", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Length", fmt.Sprint(len(payload)))
			w.Write(payload)
		})
		return mux
	})
}

func TestInstallHappyPath(t *testing.T) {
	home := isolateHome(t)
	payload := buildTarball(t, "4.132.0")
	srv := installServer(t, "4.132.0", payload, "")

	res, err := testInstaller(srv, "linux", "amd64").Install(context.Background(), home)
	if err != nil {
		t.Fatal(err)
	}
	if res.AlreadyCurrent {
		t.Error("AlreadyCurrent = true on a fresh install")
	}
	if res.Version != "4.132.0" {
		t.Errorf("Version = %q, want 4.132.0", res.Version)
	}

	// Binary present at the stripped layout path, executable bit preserved.
	bin := filepath.Join(VersionDir(home, "4.132.0"), "bin", "code-server")
	info, err := os.Stat(bin)
	if err != nil {
		t.Fatalf("installed binary missing: %v", err)
	}
	if info.Mode().Perm()&0o111 == 0 {
		t.Errorf("binary mode %v lost its executable bit", info.Mode())
	}
	// Symlink entry recreated.
	link, err := os.Readlink(filepath.Join(VersionDir(home, "4.132.0"), "lib", "node-link"))
	if err != nil || link != "node" {
		t.Errorf("symlink = %q, %v — want node, nil", link, err)
	}
	// current flipped atomically to the version dir.
	got, err := InstalledVersion(home)
	if err != nil || got != "4.132.0" {
		t.Errorf("InstalledVersion = %q, %v — want 4.132.0, nil", got, err)
	}
	// No staging residue.
	entries, err := os.ReadDir(BinDir(home))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".staging-") {
			t.Errorf("staging dir left behind: %s", e.Name())
		}
	}
}

func TestInstallAlreadyCurrentSkipsDownload(t *testing.T) {
	home := isolateHome(t)
	payload := buildTarball(t, "4.132.0")
	srv := installServer(t, "4.132.0", payload, "")

	ins := testInstaller(srv, "linux", "amd64")
	if _, err := ins.Install(context.Background(), home); err != nil {
		t.Fatal(err)
	}

	// Second run: the tarball endpoint must NOT be hit again.
	srv2 := newReleaseServer(t, func(base string) http.Handler {
		mux := http.NewServeMux()
		mux.HandleFunc("/repos/coder/code-server/releases/latest", func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprintf(w, `{"tag_name":"v4.132.0","assets":[{"name":"code-server-4.132.0-linux-amd64.tar.gz","browser_download_url":%q,"digest":"sha256:00"}]}`, base+"/dl/tarball")
		})
		mux.HandleFunc("/dl/tarball", func(w http.ResponseWriter, r *http.Request) {
			t.Error("tarball re-downloaded for an already-current install")
		})
		return mux
	})
	res, err := testInstaller(srv2, "linux", "amd64").Install(context.Background(), home)
	if err != nil {
		t.Fatal(err)
	}
	if !res.AlreadyCurrent {
		t.Error("AlreadyCurrent = false, want true (skip)")
	}
}

func TestInstallDigestMismatchFailsClosed(t *testing.T) {
	home := isolateHome(t)
	payload := buildTarball(t, "4.133.0")
	// Advertise a digest that does not match the payload.
	srv := installServer(t, "4.133.0", payload, strings.Repeat("0", 64))

	_, err := testInstaller(srv, "linux", "amd64").Install(context.Background(), home)
	if err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("err = %v, want a checksum-mismatch failure", err)
	}
	// Fail-closed: no version dir, no current symlink.
	if _, statErr := os.Stat(VersionDir(home, "4.133.0")); !os.IsNotExist(statErr) {
		t.Error("version dir left behind after a digest mismatch")
	}
	if got, _ := InstalledVersion(home); got != "" {
		t.Errorf("InstalledVersion = %q, want \"\" (current untouched)", got)
	}
}

func TestInstallMissingDigestFailsClosed(t *testing.T) {
	home := isolateHome(t)
	payload := buildTarball(t, "4.133.0")
	srv := installServer(t, "4.133.0", payload, "NONE")

	_, err := testInstaller(srv, "linux", "amd64").Install(context.Background(), home)
	if err == nil || !strings.Contains(err.Error(), "no sha256 digest") {
		t.Fatalf("err = %v, want a missing-digest failure", err)
	}
	if got, _ := InstalledVersion(home); got != "" {
		t.Errorf("InstalledVersion = %q, want \"\" (current untouched)", got)
	}
}

func TestInstallUpgradeFlipsSymlink(t *testing.T) {
	home := isolateHome(t)
	srv := installServer(t, "4.132.0", buildTarball(t, "4.132.0"), "")
	if _, err := testInstaller(srv, "linux", "amd64").Install(context.Background(), home); err != nil {
		t.Fatal(err)
	}
	// A superseded version left over from before the previous install.
	if err := os.MkdirAll(filepath.Join(VersionDir(home, "4.131.0"), "bin"), 0o755); err != nil {
		t.Fatal(err)
	}

	srv2 := installServer(t, "4.133.0", buildTarball(t, "4.133.0"), "")
	res, err := testInstaller(srv2, "linux", "amd64").Install(context.Background(), home)
	if err != nil {
		t.Fatal(err)
	}
	if res.AlreadyCurrent {
		t.Error("AlreadyCurrent = true on a version change")
	}
	got, _ := InstalledVersion(home)
	if got != "4.133.0" {
		t.Errorf("InstalledVersion = %q, want 4.133.0 after the flip", got)
	}
	// The post-flip prune keeps exactly current + the pre-flip target (the
	// rollback version): 4.132.0 stays, 4.131.0 is gone.
	if _, err := os.Stat(filepath.Join(VersionDir(home, "4.132.0"), "bin", "code-server")); err != nil {
		t.Errorf("previous version dir pruned — it is the rollback the flip keeps: %v", err)
	}
	if _, err := os.Stat(VersionDir(home, "4.131.0")); !os.IsNotExist(err) {
		t.Errorf("superseded version dir survived the flip (stat err = %v)", err)
	}
}

func TestExtractRefusesEscapingEntries(t *testing.T) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	body := []byte("x")
	if err := tw.WriteHeader(&tar.Header{Name: "code-server-1-linux-amd64/../../evil", Typeflag: tar.TypeReg, Mode: 0o644, Size: int64(len(body))}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}

	src := filepath.Join(t.TempDir(), "evil.tar.gz")
	if err := os.WriteFile(src, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := extractTarball(src, t.TempDir()); err == nil || !strings.Contains(err.Error(), "escaping the install dir") {
		t.Errorf("err = %v, want an escape refusal", err)
	}
}

func TestExtractRefusesEscapingSymlink(t *testing.T) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: "code-server-1-linux-amd64/link", Typeflag: tar.TypeSymlink, Linkname: "../../../etc/passwd"}); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}

	src := filepath.Join(t.TempDir(), "evil.tar.gz")
	if err := os.WriteFile(src, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := extractTarball(src, t.TempDir()); err == nil || !strings.Contains(err.Error(), "refusing symlink") {
		t.Errorf("err = %v, want a symlink escape refusal", err)
	}
}

// Guard: lexically tame symlink CHAINS must not redirect writes outside dest.
// self->. resolves to dest; up->self/.. cleans to "." (passes every lexical
// check) but RESOLVES to dest's parent — a later file entry under up/ would
// land outside dest. Only resolution-aware parent verification catches this.
func TestExtractRefusesSymlinkTraversalChain(t *testing.T) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	top := "code-server-1-linux-amd64"
	if err := tw.WriteHeader(&tar.Header{Name: top + "/self", Typeflag: tar.TypeSymlink, Linkname: "."}); err != nil {
		t.Fatal(err)
	}
	if err := tw.WriteHeader(&tar.Header{Name: top + "/up", Typeflag: tar.TypeSymlink, Linkname: "self/.."}); err != nil {
		t.Fatal(err)
	}
	body := []byte("pwned")
	if err := tw.WriteHeader(&tar.Header{Name: top + "/up/evil", Typeflag: tar.TypeReg, Mode: 0o644, Size: int64(len(body))}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}

	src := filepath.Join(t.TempDir(), "evil.tar.gz")
	if err := os.WriteFile(src, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	parent := t.TempDir()
	dest := filepath.Join(parent, "dest")
	if err := os.Mkdir(dest, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := extractTarball(src, dest); err == nil || !strings.Contains(err.Error(), "escaping the install dir") {
		t.Errorf("err = %v, want an escape refusal", err)
	}
	if _, err := os.Stat(filepath.Join(parent, "evil")); !os.IsNotExist(err) {
		t.Errorf("evil landed outside dest (stat err = %v)", err)
	}
}

// Guard: a symlink target of exactly ".." must be refused — Clean("..") has
// no "../" prefix, so the prefix check alone would let it through.
func TestExtractRefusesDotDotSymlink(t *testing.T) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: "code-server-1-linux-amd64/link", Typeflag: tar.TypeSymlink, Linkname: ".."}); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}

	src := filepath.Join(t.TempDir(), "evil.tar.gz")
	if err := os.WriteFile(src, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := extractTarball(src, t.TempDir()); err == nil || !strings.Contains(err.Error(), "refusing symlink") {
		t.Errorf("err = %v, want a symlink escape refusal", err)
	}
}

// Guard: the happy-path extraction must never write outside dest even though
// the test payload is benign — proves the strip-join stays under dest.
func TestExtractStaysUnderDest(t *testing.T) {
	payload := buildTarball(t, "4.132.0")
	src := filepath.Join(t.TempDir(), "ok.tar.gz")
	if err := os.WriteFile(src, payload, 0o644); err != nil {
		t.Fatal(err)
	}
	dest := t.TempDir()
	if err := extractTarball(src, dest); err != nil {
		t.Fatal(err)
	}
	// The top-level tarball dir must NOT survive into dest.
	entries, err := os.ReadDir(dest)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, e := range entries {
		names[e.Name()] = true
	}
	if !names["bin"] || !names["lib"] || !names["README.md"] {
		t.Errorf("dest entries = %v, want the stripped top level (bin, lib, README.md)", names)
	}
	if names["code-server-4.132.0-linux-amd64"] {
		t.Error("top-level tarball dir was not stripped")
	}
	// Silences the io import check if the payload shape changes.
	var _ io.Reader
}

// Regression for the production failure on the REAL code-server tarball:
// node_modules/.bin is full of up-and-back-down relative symlinks
// (.bin/esvalidate -> ../esprima/bin/esvalidate.js). These resolve INSIDE the
// tree and must extract — a "../" prefix ban refuses every genuine release.
func TestExtractAllowsIntraTreeDotDotSymlink(t *testing.T) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	top := "code-server-1-linux-amd64"
	script := "#!/usr/bin/env node\n"
	for _, hdr := range []*tar.Header{
		{Name: top + "/node_modules/esprima/bin", Typeflag: tar.TypeDir, Mode: 0o755},
		{Name: top + "/node_modules/esprima/bin/esvalidate.js", Typeflag: tar.TypeReg, Mode: 0o755, Size: int64(len(script))},
		{Name: top + "/node_modules/.bin", Typeflag: tar.TypeDir, Mode: 0o755},
		{Name: top + "/node_modules/.bin/esvalidate", Typeflag: tar.TypeSymlink, Linkname: "../esprima/bin/esvalidate.js"},
	} {
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if hdr.Typeflag == tar.TypeReg {
			if _, err := tw.Write([]byte(script)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}

	src := filepath.Join(t.TempDir(), "real-shape.tar.gz")
	if err := os.WriteFile(src, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	dest := t.TempDir()
	if err := extractTarball(src, dest); err != nil {
		t.Fatalf("intra-tree ../ symlink must extract, got: %v", err)
	}
	resolved, err := filepath.EvalSymlinks(filepath.Join(dest, "node_modules", ".bin", "esvalidate"))
	if err != nil {
		t.Fatal(err)
	}
	want, err := filepath.EvalSymlinks(filepath.Join(dest, "node_modules", "esprima", "bin", "esvalidate.js"))
	if err != nil {
		t.Fatal(err)
	}
	if resolved != want {
		t.Errorf("link resolves to %q, want %q", resolved, want)
	}
}
