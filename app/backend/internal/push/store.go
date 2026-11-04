// Package push owns the server-side Web Push state: the VAPID keypair and the
// set of browser push subscriptions. Both are persisted as JSON files under
// the state home (no database — Constitution §II), mirroring internal/settings.
package push

import (
	"encoding/json"
	"os"
	"path/filepath"

	webpush "github.com/SherClockHolmes/webpush-go"

	"rk/internal/apphome"
	"rk/internal/fsatomic"
)

// VAPIDKeys holds the server's VAPID keypair. Only Public is ever served to a
// client; Private is used to sign push requests and never leaves the server.
type VAPIDKeys struct {
	Public  string `json:"public"`
	Private string `json:"private"`
}

// Subscription is a browser PushSubscription as POSTed by the frontend. The
// JSON shape matches the webpush.Subscription the send path consumes.
type Subscription struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}

// resolveStateLeaf resolves an apphome state-home leaf, creating the state
// dir when absent so writers never fail on a fresh install.
func resolveStateLeaf(path string, err error) (string, error) {
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return "", err
	}
	return path, nil
}

func vapidPath() (string, error) {
	return resolveStateLeaf(apphome.VAPIDPath())
}

func subscriptionsPath() (string, error) {
	return resolveStateLeaf(apphome.PushSubscriptionsPath())
}

// LoadOrCreateVAPIDKeys returns the persisted VAPID keypair, generating and
// persisting a new one (private key file mode 0600, written atomically) on
// first need. The keypair is reused on every subsequent call — it is never
// regenerated once written.
func LoadOrCreateVAPIDKeys() (VAPIDKeys, error) {
	p, err := vapidPath()
	if err != nil {
		return VAPIDKeys{}, err
	}

	if data, err := os.ReadFile(p); err == nil {
		var k VAPIDKeys
		if json.Unmarshal(data, &k) == nil && k.Public != "" && k.Private != "" {
			return k, nil
		}
		// Fall through to regenerate on a corrupt/incomplete file.
	}

	private, public, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		return VAPIDKeys{}, err
	}
	k := VAPIDKeys{Public: public, Private: private}
	data, err := json.MarshalIndent(k, "", "  ")
	if err != nil {
		return VAPIDKeys{}, err
	}
	// 0600: the private key must not be world-readable.
	if err := fsatomic.WriteFile(p, data, 0600); err != nil {
		return VAPIDKeys{}, err
	}
	return k, nil
}

// LoadSubscriptions returns the stored subscriptions. A missing, empty, or
// corrupt store is treated as an empty list — the read path never errors on a
// bad file (fail-silent discipline).
func LoadSubscriptions() []Subscription {
	p, err := subscriptionsPath()
	if err != nil {
		return nil
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return nil
	}
	var subs []Subscription
	if err := json.Unmarshal(data, &subs); err != nil {
		return nil
	}
	return subs
}

// SaveSubscriptions writes the subscription list atomically as a JSON array.
// The store holds endpoints and per-subscription encryption keys, so it is
// written 0600 — not world-readable on multi-user hosts.
func SaveSubscriptions(subs []Subscription) error {
	p, err := subscriptionsPath()
	if err != nil {
		return err
	}
	if subs == nil {
		subs = []Subscription{}
	}
	data, err := json.MarshalIndent(subs, "", "  ")
	if err != nil {
		return err
	}
	return fsatomic.WriteFile(p, data, 0600)
}

// AddSubscription stores a subscription, de-duplicating by endpoint: a
// re-subscribe with an existing endpoint replaces the prior entry rather than
// appending a duplicate.
func AddSubscription(sub Subscription) error {
	subs := LoadSubscriptions()
	replaced := false
	for i, existing := range subs {
		if existing.Endpoint == sub.Endpoint {
			subs[i] = sub
			replaced = true
			break
		}
	}
	if !replaced {
		subs = append(subs, sub)
	}
	return SaveSubscriptions(subs)
}

// RemoveSubscriptions removes every subscription whose endpoint is in the
// supplied set and persists the result. A no-op (and no write) when the set is
// empty or nothing matches.
func RemoveSubscriptions(endpoints map[string]bool) error {
	if len(endpoints) == 0 {
		return nil
	}
	subs := LoadSubscriptions()
	kept := make([]Subscription, 0, len(subs))
	removed := false
	for _, s := range subs {
		if endpoints[s.Endpoint] {
			removed = true
			continue
		}
		kept = append(kept, s)
	}
	if !removed {
		return nil
	}
	return SaveSubscriptions(kept)
}
