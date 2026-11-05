package openaimcp

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

// fakeRelease serves a GitHub latest-release document and its zip assets.
type fakeRelease struct {
	tag       string
	zips      map[string][]byte // asset name → bytes
	digests   map[string]string // asset name → "sha256:<hex>" override ("" = omit)
	downloads atomic.Int32
}

func buildZip(t *testing.T, members map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range members {
		h := &zip.FileHeader{Name: name, Method: zip.Deflate}
		h.SetMode(0o755)
		w, err := zw.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		io.WriteString(w, body)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func sha(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func (f *fakeRelease) server(t *testing.T) *httptest.Server {
	t.Helper()
	var ts *httptest.Server
	ts = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/repos/"+Repo+"/releases/latest":
			type asset struct {
				Name   string `json:"name"`
				URL    string `json:"browser_download_url"`
				Digest string `json:"digest,omitempty"`
			}
			var assets []asset
			for name, body := range f.zips {
				d := "sha256:" + sha(body)
				if override, ok := f.digests[name]; ok {
					d = override
				}
				assets = append(assets, asset{Name: name, URL: ts.URL + "/dl/" + name, Digest: d})
			}
			json.NewEncoder(w).Encode(map[string]any{"tag_name": f.tag, "assets": assets})
		case strings.HasPrefix(r.URL.Path, "/dl/"):
			f.downloads.Add(1)
			body, ok := f.zips[strings.TrimPrefix(r.URL.Path, "/dl/")]
			if !ok {
				http.NotFound(w, r)
				return
			}
			w.Write(body)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(ts.Close)
	return ts
}

func testInstaller(ts *httptest.Server) *Installer {
	ins := NewInstaller()
	ins.Client = ts.Client()
	ins.APIBase = ts.URL
	ins.GOOS, ins.GOARCH = "linux", "amd64"
	return ins
}

func TestInstallHappyPath(t *testing.T) {
	zipBytes := buildZip(t, map[string]string{BinaryName: "#!/bin/sh\necho v0.0.19\n", "cloudflared": "not wanted", "LICENSE": "text"})
	f := &fakeRelease{tag: "v0.0.19", zips: map[string][]byte{
		"tunnel-client-v0.0.19-linux-amd64.zip":  zipBytes,
		"tunnel-client-v0.0.19-darwin-arm64.zip": []byte("other platform"),
	}}
	ts := f.server(t)
	l := Layout{Root: filepath.Join(t.TempDir(), "openai-mcp")}

	res, err := testInstaller(ts).Install(context.Background(), l)
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	if res.Version != "0.0.19" || res.AlreadyCurrent {
		t.Errorf("result = %+v, want version 0.0.19, fresh install", res)
	}
	info, err := os.Stat(l.CurrentBinary())
	if err != nil {
		t.Fatalf("current binary: %v", err)
	}
	if info.Mode().Perm()&0o100 == 0 {
		t.Errorf("binary mode = %o, want executable", info.Mode().Perm())
	}
	if data, _ := os.ReadFile(l.CurrentBinary()); string(data) != "#!/bin/sh\necho v0.0.19\n" {
		t.Errorf("binary content = %q", data)
	}
	if _, err := os.Stat(filepath.Join(l.BinDir(), "0.0.19", "cloudflared")); !os.IsNotExist(err) {
		t.Errorf("cloudflared extracted (stat err %v); only %s is wanted", err, BinaryName)
	}
	if v, err := l.InstalledVersion(); err != nil || v != "0.0.19" {
		t.Errorf("InstalledVersion() = %q, %v", v, err)
	}
	entries, _ := os.ReadDir(l.BinDir())
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".staging-") {
			t.Errorf("staging dir left behind: %s", e.Name())
		}
	}
}

func TestInstallIsIdempotent(t *testing.T) {
	f := &fakeRelease{tag: "v0.0.19", zips: map[string][]byte{
		"tunnel-client-v0.0.19-linux-amd64.zip": buildZip(t, map[string]string{BinaryName: "bin"}),
	}}
	ts := f.server(t)
	l := Layout{Root: t.TempDir()}
	ins := testInstaller(ts)
	if _, err := ins.Install(context.Background(), l); err != nil {
		t.Fatalf("first Install: %v", err)
	}
	res, err := ins.Install(context.Background(), l)
	if err != nil {
		t.Fatalf("second Install: %v", err)
	}
	if !res.AlreadyCurrent {
		t.Error("second Install: AlreadyCurrent = false")
	}
	if n := f.downloads.Load(); n != 1 {
		t.Errorf("downloads = %d, want 1", n)
	}
}

func TestInstallUpgradeFlipsCurrent(t *testing.T) {
	f := &fakeRelease{tag: "v0.0.18", zips: map[string][]byte{
		"tunnel-client-v0.0.18-linux-amd64.zip": buildZip(t, map[string]string{BinaryName: "old"}),
	}}
	ts := f.server(t)
	l := Layout{Root: t.TempDir()}
	ins := testInstaller(ts)
	if _, err := ins.Install(context.Background(), l); err != nil {
		t.Fatalf("Install 0.0.18: %v", err)
	}
	f.tag = "v0.0.19"
	f.zips = map[string][]byte{"tunnel-client-v0.0.19-linux-amd64.zip": buildZip(t, map[string]string{BinaryName: "new"})}
	if _, err := ins.Install(context.Background(), l); err != nil {
		t.Fatalf("Install 0.0.19: %v", err)
	}
	if data, _ := os.ReadFile(l.CurrentBinary()); string(data) != "new" {
		t.Errorf("current binary = %q, want the upgraded one", data)
	}
	if _, err := os.Stat(filepath.Join(l.BinDir(), "0.0.18", BinaryName)); err != nil {
		t.Errorf("rollback version pruned too early: %v", err)
	}
}

func TestInstallFailsClosed(t *testing.T) {
	asset := "tunnel-client-v0.0.19-linux-amd64.zip"
	good := buildZip(t, map[string]string{BinaryName: "bin"})
	cases := []struct {
		name    string
		zips    map[string][]byte
		digests map[string]string
		wantErr string
	}{
		{"checksum mismatch", map[string][]byte{asset: good}, map[string]string{asset: "sha256:" + strings.Repeat("0", 64)}, "checksum mismatch"},
		{"missing digest", map[string][]byte{asset: good}, map[string]string{asset: ""}, "no sha256 digest"},
		{"no asset for platform", map[string][]byte{"tunnel-client-v0.0.19-darwin-arm64.zip": good}, nil, "no asset"},
		{"archive without the binary", map[string][]byte{asset: buildZip(t, map[string]string{"cloudflared": "x"})}, nil, "does not contain"},
		{"binary nested in a dir", map[string][]byte{asset: buildZip(t, map[string]string{"sub/" + BinaryName: "x"})}, nil, "does not contain"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := &fakeRelease{tag: "v0.0.19", zips: c.zips, digests: c.digests}
			ts := f.server(t)
			l := Layout{Root: t.TempDir()}
			_, err := testInstaller(ts).Install(context.Background(), l)
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Fatalf("Install err = %v, want containing %q", err, c.wantErr)
			}
			if _, statErr := os.Lstat(filepath.Join(l.BinDir(), "current")); !os.IsNotExist(statErr) {
				t.Errorf("current exists after a failed install (lstat err %v)", statErr)
			}
		})
	}
}

func TestInstallUnsupportedPlatform(t *testing.T) {
	f := &fakeRelease{tag: "v0.0.19"}
	ts := f.server(t)
	ins := testInstaller(ts)
	ins.GOOS = "windows"
	if _, err := ins.Install(context.Background(), Layout{Root: t.TempDir()}); err == nil || !strings.Contains(err.Error(), "unsupported platform") {
		t.Fatalf("Install on windows err = %v, want unsupported platform", err)
	}
}

func TestInstalledVersionWithoutInstall(t *testing.T) {
	if v, err := (Layout{Root: t.TempDir()}).InstalledVersion(); err != nil || v != "" {
		t.Errorf("InstalledVersion() on an empty layout = %q, %v; want empty, nil", v, err)
	}
}

func TestInstallRejectsNonVersionTag(t *testing.T) {
	for _, tag := range []string{"v..", "v../x", "vlatest", "v1.2/../.."} {
		f := &fakeRelease{tag: tag, zips: map[string][]byte{}}
		ts := f.server(t)
		root := t.TempDir()
		keep := filepath.Join(root, "api-key")
		os.WriteFile(keep, []byte("sk-keep\n"), 0o600)
		_, err := testInstaller(ts).Install(context.Background(), Layout{Root: root})
		if err == nil || !strings.Contains(err.Error(), "not a version") {
			t.Errorf("tag %q: err = %v, want a not-a-version rejection", tag, err)
		}
		if _, statErr := os.Stat(keep); statErr != nil {
			t.Errorf("tag %q: a file beside bin/ was disturbed: %v", tag, statErr)
		}
	}
}

func TestInstallCreatesPrivateRoot(t *testing.T) {
	f := &fakeRelease{tag: "v0.0.19", zips: map[string][]byte{
		"tunnel-client-v0.0.19-linux-amd64.zip": buildZip(t, map[string]string{BinaryName: "bin"}),
	}}
	ts := f.server(t)
	l := Layout{Root: filepath.Join(t.TempDir(), "openai-mcp")}
	if _, err := testInstaller(ts).Install(context.Background(), l); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(l.Root)
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o700 {
		t.Errorf("root mode = %o, want 700 (it will hold the key)", mode)
	}
}

func TestExtractBinarySkipsSymlinkMember(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	h := &zip.FileHeader{Name: BinaryName}
	h.SetMode(os.ModeSymlink | 0o777)
	w, _ := zw.CreateHeader(h)
	io.WriteString(w, "/etc/passwd")
	zw.Close()
	archive := filepath.Join(t.TempDir(), "a.zip")
	os.WriteFile(archive, buf.Bytes(), 0o644)
	err := extractBinary(archive, filepath.Join(t.TempDir(), BinaryName))
	if err == nil || !strings.Contains(err.Error(), "does not contain") {
		t.Errorf("symlink member: err = %v, want it skipped (does not contain)", err)
	}
}
