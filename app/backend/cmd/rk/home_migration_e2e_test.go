package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"rk/internal/portpolicy"
	"rk/internal/settings"
	"rk/internal/snapshot"
	"rk/internal/testutil"
	"rk/internal/tmux"
)

// home_migration_e2e_test.go — the black-box proof of the one-time
// run-kit → hexokit home migration (the D9 dual-read + pickup contract). A
// REAL rk binary is built with the release ldflag (-X main.version=v0.0.0-test)
// so the serve-time migration gate (version != "dev") fires, then driven
// against a fully seeded legacy install under a temp HOME + XDG_STATE_HOME:
// legacy config home (config.yaml with theme + riff preset and no port, a
// stamp-verified PREVIOUS-header managed tmux.conf, tmux.d/user.conf) and
// legacy state home (a valid cron entry, a layout snapshot, prstatus.json).
//
// Trigger choice: the production path — a real `rk serve` boot. The two
// cheaper fallbacks were rejected: `rk daemon start` would open its serve
// window on the machine's real rk-daemon tmux server (never hermetic), and a
// direct homemigrate.Migrate() call would not exercise the serve RunE ordering
// (migrate → RefreshDefaultConfigPath → EnsureConfig force-refreshing the
// legacy-header managed conf). The serve boot is made hermetic without
// touching the implementation:
//
//   - HOME / XDG_STATE_HOME point at t.TempDir() roots — every file resolver
//     lands in the sandbox; RK_CONFIG_DIR stays UNSET because the migration
//     is skipped under it by design.
//   - TMUX_TMPDIR points at a private dir — the tmuxctl supervisor's fsnotify
//     watch dir resolves from it, so no live socket is ever opened.
//   - RK_SERVER_ALLOWLIST is a unique rk-test-homemig-<pid>-<ns> prefix — the
//     e2e-harness gate that scopes tmux.ListServers (and with it the
//     stale-conf RefreshSweep and the supervisor's @rk_srv_origin stamp) to
//     matching server names. ScanSocketDir still reads the real
//     /tmp/tmux-<uid>, but the allowlist filter drops every entry, so the
//     sweep reloads nothing. No tmux server is started by this test at all,
//     so there is no server to kill — only the serve process (SIGTERM, with a
//     SIGKILL cleanup guard).
//   - RK_PORT is a free loopback port; readiness is GET /api/health.
//
// The RK_PORT set for the boot doubles as proof that a transient env port
// does not change the written pin (port: <portpolicy.DaemonLegacy>).
//
// Skips when go or tmux is absent.

// TestHomeMigrationPickupE2E seeds a pre-rename install, proves the CLI
// dual-reads the legacy homes, boots serve once, and proves the new homes
// hold the migrated content, the pin, and the refreshed managed conf — with
// the legacy trees byte-unchanged.
func TestHomeMigrationPickupE2E(t *testing.T) {
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go not available — skipping home migration e2e test")
	}
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available — skipping home migration e2e test")
	}

	// Build the real binary with the release version stamp (the mcp e2e
	// pattern): the tmux.conf embed input is generated (scripts/build.sh), so
	// seed it the same way when absent — and remove a seeded copy on cleanup
	// so the test never leaves the working tree dirty.
	backendRoot := filepath.Join("..", "..")
	confPath := filepath.Join(backendRoot, "build", "tmux.conf")
	if _, err := os.Stat(confPath); os.IsNotExist(err) {
		src, err := os.ReadFile(filepath.Join("..", "..", "..", "configs", "tmux", "default.conf"))
		if err != nil {
			t.Fatalf("read canonical tmux.conf: %v", err)
		}
		if err := os.WriteFile(confPath, src, 0o644); err != nil {
			t.Fatalf("seed build/tmux.conf: %v", err)
		}
		t.Cleanup(func() { _ = os.Remove(confPath) })
	}
	bin := filepath.Join(t.TempDir(), "rk")
	buildCtx, buildCancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer buildCancel()
	if out, err := exec.CommandContext(buildCtx, "go", "build",
		"-ldflags", "-X main.version=v0.0.0-test", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, string(out))
	}

	// ── Seed the legacy install ──────────────────────────────────────────
	root := t.TempDir()
	home := filepath.Join(root, "home")
	stateHome := filepath.Join(root, "state")
	legacyConfig := filepath.Join(home, ".config", "run-kit")
	legacyState := filepath.Join(stateHome, "run-kit")

	// config.yaml: a comment, a theme, and one riff preset — NO port key, so
	// the migration must append the pin. Newline-terminated.
	configYAML := []byte("# home-migration e2e seed\ntheme: \"dark\"\nriff_presets:\n  probe: /review\n")
	hmWriteFile(t, filepath.Join(legacyConfig, "config.yaml"), configYAML, 0o644)

	// The managed tmux.conf in the PREVIOUS header form: the legacy suffix
	// with a stamp that verifies against the body, so the classifier reads it
	// as managed-stale (never hand-edited) and EnsureConfig force-refreshes
	// it onto the current header + embed at serve boot.
	tmuxBody := []byte("set -g history-limit 2000\n")
	bodySum := sha256.Sum256(tmuxBody)
	legacyTmuxConf := []byte("# rk-managed sha256:" + hex.EncodeToString(bodySum[:]) +
		" — DO NOT EDIT; overrides go in ~/.config/run-kit/tmux.d/" + "\n" + string(tmuxBody))
	if got := tmux.ClassifyManagedConf(legacyTmuxConf, tmux.DefaultConfigBytes()); got != tmux.ConfManagedStale {
		t.Fatalf("fixture sanity: legacy-header conf classifies %v, want ConfManagedStale", got)
	}
	hmWriteFile(t, filepath.Join(legacyConfig, "tmux.conf"), legacyTmuxConf, 0o644)
	userConf := []byte("set -g status off\n")
	hmWriteFile(t, filepath.Join(legacyConfig, "tmux.d", "user.conf"), userConf, 0o644)

	// One valid cron entry (loads clean through the tolerant entry-file
	// load), keyed to a server slug no live server ever has.
	cronEntryYAML := []byte("entries:\n" +
		"  - id: t3st\n" +
		"    name: pickup probe\n" +
		"    schedule:\n" +
		"      kind: every\n" +
		"      interval: 1h\n" +
		"    target:\n" +
		"      kind: role\n" +
		"      role: operator\n" +
		"    payload: ping the operator\n")
	cronDir := filepath.Join(legacyState, "cron")
	if err := os.MkdirAll(cronDir, 0o700); err != nil {
		t.Fatalf("seed cron dir: %v", err)
	}
	hmWriteFile(t, filepath.Join(cronDir, "e2epickup.yaml"), cronEntryYAML, 0o600)

	// One layout snapshot via the real store (so the on-disk shape is the
	// store's own), plus a prstatus.json seed cache that must NOT migrate.
	snapStore := snapshot.NewStore(filepath.Join(legacyState, "snapshots"))
	written, err := snapStore.Write(&snapshot.Snapshot{
		Server:  "e2esnap",
		TakenAt: time.Now().UTC(),
		Sessions: []snapshot.Session{{
			Name:    "boot",
			Windows: []snapshot.Window{{Index: 0, ID: "@1", Name: "shell"}},
		}},
	})
	if err != nil || !written {
		t.Fatalf("seed snapshot store: written=%v err=%v", written, err)
	}
	hmWriteFile(t, filepath.Join(legacyState, "prstatus.json"), []byte("{\"prs\":[]}\n"), 0o600)

	// The byte-unchanged baseline for both legacy trees, taken after seeding
	// and compared after every operation below.
	legacyDigestBefore := hmHashTrees(t, legacyConfig, legacyState)

	// ── Pre-migration: the CLI dual-reads the legacy homes ───────────────
	cliEnv := hmChildEnv(home, stateHome)
	cronRows := hmCronList(t, bin, cliEnv)
	hmAssertCronEntry(t, cronRows)
	snapRows := hmSnapshotList(t, bin, cliEnv)
	hmAssertSnapshotRow(t, snapRows)
	if got := hmEffectivePort(t, bin, cliEnv); got != portpolicy.DaemonLegacy {
		t.Errorf("pre-migration effective port = %d, want the legacy pin %d", got, portpolicy.DaemonLegacy)
	}
	// The dual-read must never CREATE the new home: only the migration's
	// atomic publish may.
	for _, dir := range []string{filepath.Join(home, ".config", "hexokit"), filepath.Join(stateHome, "hexokit")} {
		if _, err := os.Lstat(dir); !os.IsNotExist(err) {
			t.Fatalf("new home %s exists before migration (stat err = %v) — the dual-read must not create it", dir, err)
		}
	}

	// ── Trigger: a real release-build serve boot ─────────────────────────
	port := hmFreePort(t)
	sockBase, err := os.MkdirTemp("", "rkhm")
	if err != nil {
		t.Fatalf("private TMUX_TMPDIR: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(sockBase) })
	allowlist := fmt.Sprintf("rk-test-homemig-%d-%d", os.Getpid(), time.Now().UnixNano())

	logDir := t.TempDir()
	stdoutPath := filepath.Join(logDir, "serve.stdout")
	stderrPath := filepath.Join(logDir, "serve.stderr")
	stdoutF, err := os.Create(stdoutPath)
	if err != nil {
		t.Fatalf("serve stdout log: %v", err)
	}
	stderrF, err := os.Create(stderrPath)
	if err != nil {
		t.Fatalf("serve stderr log: %v", err)
	}
	serveLogs := func() string {
		_ = stdoutF.Sync()
		_ = stderrF.Sync()
		out, _ := os.ReadFile(stdoutPath)
		serr, _ := os.ReadFile(stderrPath)
		return fmt.Sprintf("stdout:\n%s\nstderr:\n%s", out, serr)
	}

	serveCmd := exec.Command(bin, "serve")
	serveCmd.Env = hmChildEnv(home, stateHome,
		"RK_HOST=127.0.0.1",
		"RK_PORT="+strconv.Itoa(port),
		"TMUX_TMPDIR="+sockBase,
		"RK_SERVER_ALLOWLIST="+allowlist,
	)
	serveCmd.Stdout = stdoutF
	serveCmd.Stderr = stderrF
	if err := serveCmd.Start(); err != nil {
		t.Fatalf("start serve: %v", err)
	}
	t.Cleanup(func() {
		_ = serveCmd.Process.Signal(syscall.SIGKILL)
		_ = stdoutF.Close()
		_ = stderrF.Close()
	})
	waitCh := make(chan error, 1)
	go func() { waitCh <- serveCmd.Wait() }()

	healthURL := fmt.Sprintf("http://127.0.0.1:%d/api/health", port)
	httpClient := &http.Client{Timeout: time.Second}
	serveExited := false
	ready := testutil.WaitUntil(t, 30*time.Second, func() bool {
		select {
		case err := <-waitCh:
			serveExited = true
			t.Logf("serve exited before readiness: %v", err)
			return false
		default:
		}
		resp, err := httpClient.Get(healthURL)
		if err != nil {
			return false
		}
		_ = resp.Body.Close()
		return resp.StatusCode == http.StatusOK
	})
	if !ready {
		if serveExited {
			t.Fatalf("serve exited before becoming ready — logs:\n%s", serveLogs())
		}
		t.Fatalf("serve did not answer %s within 30s — logs:\n%s", healthURL, serveLogs())
	}

	// ── Post-migration: the new homes hold the migrated content ──────────
	newConfig := filepath.Join(home, ".config", "hexokit")
	newState := filepath.Join(stateHome, "hexokit")

	// config.yaml: the original bytes plus the pin comment + port:
	// <DaemonLegacy> — the RK_PORT exported for this very boot must NOT leak
	// into the pin.
	wantConfig := append([]byte(configYAML), []byte(settings.PortPinComment+"\nport: "+strconv.Itoa(portpolicy.DaemonLegacy)+"\n")...)
	if got := hmReadFile(t, filepath.Join(newConfig, "config.yaml")); !reflect.DeepEqual(got, wantConfig) {
		t.Errorf("migrated config.yaml = %q, want the seeded bytes + pin %q", got, wantConfig)
	}
	// The whole config tree rides along: the user's tmux.d override survives
	// byte-identically.
	if got := hmReadFile(t, filepath.Join(newConfig, "tmux.d", "user.conf")); !reflect.DeepEqual(got, userConf) {
		t.Errorf("migrated tmux.d/user.conf = %q, want %q", got, userConf)
	}
	// The migrated managed tmux.conf (legacy header) was force-refreshed by
	// the serve boot's EnsureConfig onto the current stamped embed.
	wantManaged := tmux.ManagedConfigBytes(tmux.DefaultConfigBytes())
	if got := hmReadFile(t, filepath.Join(newConfig, "tmux.conf")); !reflect.DeepEqual(got, wantManaged) {
		t.Errorf("migrated managed tmux.conf was not refreshed to the current header + embed")
	}

	// The state home holds exactly the copy set: cron/ and snapshots/, with
	// content byte-identical to the legacy originals.
	if got := hmReadFile(t, filepath.Join(newState, "cron", "e2epickup.yaml")); !reflect.DeepEqual(got, cronEntryYAML) {
		t.Errorf("migrated cron entry = %q, want %q", got, cronEntryYAML)
	}
	legacySnap := hmReadFile(t, filepath.Join(legacyState, "snapshots", "e2esnap.json"))
	if got := hmReadFile(t, filepath.Join(newState, "snapshots", "e2esnap.json")); !reflect.DeepEqual(got, legacySnap) {
		t.Errorf("migrated snapshot differs from the legacy original")
	}
	if _, err := os.Lstat(filepath.Join(newState, "prstatus.json")); !os.IsNotExist(err) {
		t.Errorf("prstatus.json must NOT migrate (seed cache cold-starts), stat err = %v", err)
	}
	entries, err := os.ReadDir(newState)
	if err != nil {
		t.Fatalf("read migrated state home: %v", err)
	}
	for _, e := range entries {
		if e.Name() != "cron" && e.Name() != "snapshots" {
			t.Errorf("unexpected entry %q in the migrated state home — only cron/ and snapshots/ migrate", e.Name())
		}
	}

	// ── Post-migration: the CLI reads the migrated data ──────────────────
	cronRows = hmCronList(t, bin, cliEnv)
	hmAssertCronEntry(t, cronRows)
	snapRows = hmSnapshotList(t, bin, cliEnv)
	hmAssertSnapshotRow(t, snapRows)
	if got := hmEffectivePort(t, bin, cliEnv); got != portpolicy.DaemonLegacy {
		t.Errorf("post-migration effective port = %d, want the written pin %d", got, portpolicy.DaemonLegacy)
	}

	// ── Shutdown: SIGTERM must bring serve down cleanly ──────────────────
	if err := serveCmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("SIGTERM serve: %v", err)
	}
	select {
	case err := <-waitCh:
		if err != nil {
			t.Errorf("serve exit = %v, want clean — logs:\n%s", err, serveLogs())
		}
	case <-time.After(15 * time.Second):
		t.Fatalf("serve did not shut down within 15s of SIGTERM — logs:\n%s", serveLogs())
	}

	// ── The legacy trees are byte-unchanged ──────────────────────────────
	legacyDigestAfter := hmHashTrees(t, legacyConfig, legacyState)
	if !reflect.DeepEqual(legacyDigestBefore, legacyDigestAfter) {
		for path, before := range legacyDigestBefore {
			if after, ok := legacyDigestAfter[path]; !ok {
				t.Errorf("legacy entry %s vanished", path)
			} else if before != after {
				t.Errorf("legacy entry %s changed: %+v → %+v", path, before, after)
			}
		}
		for path := range legacyDigestAfter {
			if _, ok := legacyDigestBefore[path]; !ok {
				t.Errorf("legacy entry %s appeared", path)
			}
		}
		t.Fatal("legacy homes must stay byte-unchanged for one release")
	}
}

// hmChildEnv builds a child-process environment: the inherited environment
// minus every variable that could leak this machine's real homes, tmux
// context, or port overrides into the test, plus the sandboxed HOME and
// XDG_STATE_HOME and the caller's extras. RK_CONFIG_DIR is deliberately
// absent: the migration skips under it, so setting it would make the test
// vacuous.
func hmChildEnv(home, stateHome string, extra ...string) []string {
	scrub := map[string]bool{
		"HOME": true, "XDG_STATE_HOME": true, "XDG_CONFIG_HOME": true,
		"TMUX": true, "TMUX_PANE": true, "TMUX_TMPDIR": true,
		"RK_HOST": true, "RK_PORT": true, "RK_CONFIG_DIR": true, "RK_TMUX_CONF": true,
		"RK_SERVER_ALLOWLIST": true, "RK_DAEMON_LOG": true, "LOG_LEVEL": true,
	}
	env := make([]string, 0, len(os.Environ()))
	for _, kv := range os.Environ() {
		if k, _, _ := strings.Cut(kv, "="); scrub[k] {
			continue
		}
		env = append(env, kv)
	}
	return append(env, append([]string{"HOME=" + home, "XDG_STATE_HOME=" + stateHome}, extra...)...)
}

// hmRun runs the built binary as a child with the given env and returns its
// stdout, failing on any error with the stderr captured.
func hmRun(t *testing.T, bin string, env []string, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = env
	out, err := cmd.Output()
	if err != nil {
		stderr := ""
		if ee, ok := err.(*exec.ExitError); ok {
			stderr = string(ee.Stderr)
		}
		t.Fatalf("%s %s failed: %v\nstderr: %s", bin, strings.Join(args, " "), err, stderr)
	}
	return string(out)
}

// hmEnvelopeResult unwraps the {"ok":true,"result":…} envelope a --json verb
// writes.
func hmEnvelopeResult(t *testing.T, stdout string) json.RawMessage {
	t.Helper()
	var doc struct {
		OK     bool            `json:"ok"`
		Result json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal([]byte(stdout), &doc); err != nil {
		t.Fatalf("stdout is not one JSON envelope: %v (%q)", err, stdout)
	}
	if !doc.OK {
		t.Fatalf("envelope ok:false: %q", stdout)
	}
	return doc.Result
}

// hmCronRow is the subset of the cron list --json record under assertion.
type hmCronRow struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Target   string `json:"target"`
	Schedule struct {
		Kind string `json:"kind"`
	} `json:"schedule"`
}

func hmCronList(t *testing.T, bin string, env []string) []hmCronRow {
	t.Helper()
	out := hmRun(t, bin, env, "cron", "list", "--json", "-L", "e2epickup")
	var rows []hmCronRow
	if err := json.Unmarshal(hmEnvelopeResult(t, out), &rows); err != nil {
		t.Fatalf("cron list result is not a row array: %v (%q)", err, out)
	}
	return rows
}

func hmAssertCronEntry(t *testing.T, rows []hmCronRow) {
	t.Helper()
	if len(rows) != 1 {
		t.Fatalf("cron list rows = %v, want exactly the seeded entry", rows)
	}
	row := rows[0]
	if row.ID != "t3st" || row.Name != "pickup probe" || row.Target != "role:operator" || row.Schedule.Kind != "every" {
		t.Errorf("cron row = %+v, want the seeded t3st entry", row)
	}
}

// hmSnapshotRow is the subset of the snapshot list --json row under
// assertion.
type hmSnapshotRow struct {
	Server   string `json:"server"`
	Sessions int    `json:"sessions"`
	Windows  int    `json:"windows"`
}

func hmSnapshotList(t *testing.T, bin string, env []string) []hmSnapshotRow {
	t.Helper()
	// The `rk snapshot` root alias is deprecated (it prints a notice ahead of
	// the envelope); the `rk mux snapshot` family member is the live verb.
	out := hmRun(t, bin, env, "mux", "snapshot", "list", "--json")
	var rows []hmSnapshotRow
	if err := json.Unmarshal(hmEnvelopeResult(t, out), &rows); err != nil {
		t.Fatalf("snapshot list result is not a row array: %v (%q)", err, out)
	}
	return rows
}

func hmAssertSnapshotRow(t *testing.T, rows []hmSnapshotRow) {
	t.Helper()
	if len(rows) != 1 {
		t.Fatalf("snapshot list rows = %v, want exactly the seeded entry", rows)
	}
	if rows[0].Server != "e2esnap" || rows[0].Sessions != 1 || rows[0].Windows != 1 {
		t.Errorf("snapshot row = %+v, want server e2esnap with 1 session / 1 window", rows[0])
	}
}

// hmEffectivePort returns the ports --json effective daemon port (config.Load
// resolved: code default < config.yaml < RK_PORT — RK_PORT is scrubbed from
// the child env here, so this is the file-or-policy value).
func hmEffectivePort(t *testing.T, bin string, env []string) int {
	t.Helper()
	out := hmRun(t, bin, env, "ports", "--json")
	var doc struct {
		Daemon struct {
			EffectivePort int `json:"effective_port"`
		} `json:"daemon"`
	}
	if err := json.Unmarshal(hmEnvelopeResult(t, out), &doc); err != nil {
		t.Fatalf("ports result shape: %v (%q)", err, out)
	}
	return doc.Daemon.EffectivePort
}

// hmFreePort returns a currently-free loopback TCP port. The close-then-bind
// race is accepted (the e2e rigs do the same); a lost race surfaces as the
// readiness timeout with the serve logs attached.
func hmFreePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve a free port: %v", err)
	}
	defer func() { _ = l.Close() }()
	return l.Addr().(*net.TCPAddr).Port
}

func hmWriteFile(t *testing.T, path string, content []byte, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, content, mode); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func hmReadFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return data
}

// hmDigestEntry is one tree node in the byte-unchanged digest: kind,
// permission bits, and the content hash (files) or link target (symlinks).
type hmDigestEntry struct {
	Kind string
	Perm string
	Sum  string
	Link string
}

// hmHashTrees digests every root into one relpath-keyed map.
func hmHashTrees(t *testing.T, roots ...string) map[string]hmDigestEntry {
	t.Helper()
	out := map[string]hmDigestEntry{}
	for _, root := range roots {
		err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			rel, err := filepath.Rel(root, p)
			if err != nil || rel == "." {
				return err
			}
			key := filepath.Join(root, rel)
			info, err := os.Lstat(p)
			if err != nil {
				return err
			}
			perm := fmt.Sprintf("0%o", info.Mode().Perm())
			switch {
			case info.Mode()&os.ModeSymlink != 0:
				target, err := os.Readlink(p)
				if err != nil {
					return err
				}
				out[key] = hmDigestEntry{Kind: "symlink", Perm: perm, Link: target}
			case info.IsDir():
				out[key] = hmDigestEntry{Kind: "dir", Perm: perm}
			case info.Mode().IsRegular():
				data, err := os.ReadFile(p)
				if err != nil {
					return err
				}
				sum := sha256.Sum256(data)
				out[key] = hmDigestEntry{Kind: "file", Perm: perm, Sum: hex.EncodeToString(sum[:])}
			default:
				out[key] = hmDigestEntry{Kind: "special", Perm: perm}
			}
			return nil
		})
		if err != nil {
			t.Fatalf("digest %s: %v", root, err)
		}
	}
	return out
}
