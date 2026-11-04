package push

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// DefaultIcon is the notification icon served from the PWA manifest's icon set.
const DefaultIcon = "/generated-icons/icon-192.png"

// notifyTimeout bounds the whole fan-out so a hung push service can never block
// the caller (operator loop). Aligns with the Process Execution timeout norms.
const notifyTimeout = 10 * time.Second

// payload is the JSON the service worker's `push` handler parses. `URL` is the
// optional deep-link target the SW stores on the notification and navigates to
// on click (e.g. `/{server}/{N}` for a waiting agent);
// omitempty so a push with no target sends nothing extra and the SW falls back
// to the app root.
type payload struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	Icon  string `json:"icon"`
	URL   string `json:"url,omitempty"`
}

// NotifyResult summarizes a fan-out. The CLI ignores it; the HTTP handler
// returns it as a small JSON body.
type NotifyResult struct {
	Sent   int `json:"sent"`
	Pruned int `json:"pruned"`
}

// vapidSubscriber is the `sub` claim in the VAPID JWT. A mailto:/https: URI is
// expected by push services; a stable placeholder is acceptable for a
// single-user box.
const vapidSubscriber = "https://github.com/sahil87/hexokit"

// Notify sends a push to every stored subscription, signed with the server's
// VAPID keypair, under a bounded timeout. Subscriptions the push service
// reports gone (404/410) are pruned from the store. Individual send failures
// are tolerated — they neither stop the fan-out nor surface to the caller. `url`
// is an optional deep-link target carried to the service worker (empty ⇒
// omitted from the payload; the SW falls back to the app root on click).
func Notify(ctx context.Context, title, body, url string) (NotifyResult, error) {
	keys, err := LoadOrCreateVAPIDKeys()
	if err != nil {
		return NotifyResult{}, err
	}

	subs := LoadSubscriptions()
	if len(subs) == 0 {
		return NotifyResult{}, nil
	}

	msg, err := json.Marshal(payload{Title: title, Body: body, Icon: DefaultIcon, URL: url})
	if err != nil {
		return NotifyResult{}, err
	}

	sendCtx, cancel := context.WithTimeout(ctx, notifyTimeout)
	defer cancel()

	dead := make(map[string]bool)
	sent := 0
	for _, s := range subs {
		ws := &webpush.Subscription{
			Endpoint: s.Endpoint,
			Keys: webpush.Keys{
				P256dh: s.Keys.P256dh,
				Auth:   s.Keys.Auth,
			},
		}
		resp, err := webpush.SendNotificationWithContext(sendCtx, msg, ws, &webpush.Options{
			Subscriber:      vapidSubscriber,
			VAPIDPublicKey:  keys.Public,
			VAPIDPrivateKey: keys.Private,
			TTL:             30,
		})
		if err != nil {
			// Transport-level failure: tolerate, don't prune (could be transient).
			continue
		}
		// Drain and close so connections can be reused.
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()

		switch resp.StatusCode {
		case http.StatusNotFound, http.StatusGone:
			dead[s.Endpoint] = true
		default:
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				sent++
			}
		}
	}

	if err := RemoveSubscriptions(dead); err != nil {
		// Pruning is best-effort; report the count we attempted anyway.
		return NotifyResult{Sent: sent, Pruned: len(dead)}, err
	}
	return NotifyResult{Sent: sent, Pruned: len(dead)}, nil
}
