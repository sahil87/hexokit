package push

import (
	"os"
	"path/filepath"
	"testing"
)

// isolateHome points state-home persistence at a throwaway HOME and
// XDG_STATE_HOME so tests neither read nor clobber the developer's real
// state files.
func isolateHome(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("XDG_STATE_HOME", filepath.Join(dir, ".local", "state"))
	return dir
}

// stateFile returns the expected path of a state-home leaf under the
// isolated HOME.
func stateFile(t *testing.T, home string, parts ...string) string {
	t.Helper()
	return filepath.Join(append([]string{home, ".local", "state", "hexokit"}, parts...)...)
}

func TestVAPIDKeys_generateOnceAndReuse(t *testing.T) {
	home := isolateHome(t)

	k1, err := LoadOrCreateVAPIDKeys()
	if err != nil {
		t.Fatalf("first load: %v", err)
	}
	if k1.Public == "" || k1.Private == "" {
		t.Fatal("expected non-empty public and private keys")
	}

	k2, err := LoadOrCreateVAPIDKeys()
	if err != nil {
		t.Fatalf("second load: %v", err)
	}
	if k2.Public != k1.Public || k2.Private != k1.Private {
		t.Error("keypair regenerated on reload; expected reuse of the persisted keys")
	}

	// The private key file must be mode 0600.
	info, err := os.Stat(stateFile(t, home, "vapid.json"))
	if err != nil {
		t.Fatalf("stat vapid.json: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0600 {
		t.Errorf("vapid.json mode = %o, want 0600", perm)
	}

	// Fresh install must never create ~/.rk.
	if _, err := os.Stat(filepath.Join(home, ".rk")); !os.IsNotExist(err) {
		t.Errorf("~/.rk should not exist on a fresh install, stat err = %v", err)
	}
}

func TestSubscriptions_addAndDedupeByEndpoint(t *testing.T) {
	isolateHome(t)

	a := Subscription{Endpoint: "https://push.example/a"}
	a.Keys.P256dh = "p1"
	a.Keys.Auth = "auth1"
	if err := AddSubscription(a); err != nil {
		t.Fatalf("add a: %v", err)
	}

	b := Subscription{Endpoint: "https://push.example/b"}
	b.Keys.P256dh = "p2"
	b.Keys.Auth = "auth2"
	if err := AddSubscription(b); err != nil {
		t.Fatalf("add b: %v", err)
	}

	if got := len(LoadSubscriptions()); got != 2 {
		t.Fatalf("len after two distinct adds = %d, want 2", got)
	}

	// Re-subscribe with the same endpoint as `a` but new keys → replace, not append.
	aPrime := Subscription{Endpoint: "https://push.example/a"}
	aPrime.Keys.P256dh = "p1-new"
	aPrime.Keys.Auth = "auth1-new"
	if err := AddSubscription(aPrime); err != nil {
		t.Fatalf("re-add a: %v", err)
	}

	subs := LoadSubscriptions()
	if len(subs) != 2 {
		t.Fatalf("len after dedupe = %d, want 2", len(subs))
	}
	for _, s := range subs {
		if s.Endpoint == "https://push.example/a" && s.Keys.P256dh != "p1-new" {
			t.Errorf("endpoint a keys = %q, want replaced value %q", s.Keys.P256dh, "p1-new")
		}
	}
}

func TestSubscriptions_remove(t *testing.T) {
	isolateHome(t)

	for _, ep := range []string{"e1", "e2", "e3"} {
		s := Subscription{Endpoint: ep}
		s.Keys.P256dh = "p"
		s.Keys.Auth = "a"
		if err := AddSubscription(s); err != nil {
			t.Fatalf("add %s: %v", ep, err)
		}
	}

	if err := RemoveSubscriptions(map[string]bool{"e2": true}); err != nil {
		t.Fatalf("remove: %v", err)
	}
	subs := LoadSubscriptions()
	if len(subs) != 2 {
		t.Fatalf("len after remove = %d, want 2", len(subs))
	}
	for _, s := range subs {
		if s.Endpoint == "e2" {
			t.Error("e2 should have been removed")
		}
	}

	// Removing nothing is a no-op (no error).
	if err := RemoveSubscriptions(nil); err != nil {
		t.Errorf("remove(nil) = %v, want nil", err)
	}
}

func TestLoadSubscriptions_tolerantOfMissingAndCorrupt(t *testing.T) {
	home := isolateHome(t)

	// Missing file → empty list, no panic/error.
	if got := LoadSubscriptions(); len(got) != 0 {
		t.Errorf("missing store len = %d, want 0", len(got))
	}

	// Corrupt file → empty list, no error.
	p := stateFile(t, home, "push-subscriptions.json")
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(p, []byte("not json{"), 0644); err != nil {
		t.Fatalf("write corrupt: %v", err)
	}
	if got := LoadSubscriptions(); len(got) != 0 {
		t.Errorf("corrupt store len = %d, want 0", len(got))
	}
}
