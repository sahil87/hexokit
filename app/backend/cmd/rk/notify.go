package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/spf13/cobra"
)

// notifyTimeout bounds the POST so a hung server never blocks the caller. A
// notify failure must never stall the operator loop.
const notifyTimeout = 8 * time.Second

var (
	notifyTitle string
	notifyJSON  bool
)

// notifyReceipt is the --json success document: delivered is the POST's 2xx
// verdict — the fail-silent contract is unchanged (exit 0 either way), so the
// receipt is where the truth goes.
type notifyReceipt struct {
	Delivered bool `json:"delivered"`
}

var notifyCmd = &cobra.Command{
	Use:   "notify <message>",
	Short: "Send a Web Push notification to subscribed devices",
	Long: "Send a Web Push notification via the local run-kit server to every " +
		"subscribed browser/device. Fail-silent: if the server is unreachable or " +
		"returns an error, the command exits 0 and prints nothing, so it never " +
		"stalls a calling process. --json prints the receipt " +
		"{\"delivered\":bool} — delivered:false is not an error.",
	Args: cobra.ExactArgs(1),
	// SilenceErrors/SilenceUsage: the fail-silent contract means we never want
	// cobra to print an error or usage on a failed send. RunE always returns nil.
	SilenceErrors: true,
	SilenceUsage:  true,
	RunE: func(cmd *cobra.Command, args []string) error {
		delivered := sendNotify(cmd.Context(), notifyTitle, args[0])
		if notifyJSON {
			newSink(cmd).JSONResult(notifyReceipt{Delivered: delivered})
		}
		return nil
	},
}

func init() {
	notifyCmd.Flags().StringVar(&notifyTitle, "title", "", "Optional notification title")
	notifyCmd.Flags().BoolVar(&notifyJSON, "json", false, "Emit the machine-readable envelope (exactly one JSON document on stdout)")
}

// sendNotify POSTs {title, body} to the local server's /api/notify, targeting
// the origin resolveOrigin() derives for the caller (explicit RK_HOST/RK_PORT
// env → the covering tmux server's @rk_srv_origin → the portpolicy default).
// It is fail-silent by design: any error (unreachable server, non-2xx,
// timeout) is swallowed and produces no output. The return is the one fact
// the failure path hides: true iff the POST returned 2xx.
func sendNotify(parent context.Context, title, body string) bool {
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, notifyTimeout)
	defer cancel()

	url := resolveOrigin(ctx) + "/api/notify"

	payload, err := json.Marshal(map[string]string{"title": title, "body": body})
	if err != nil {
		return false
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false // server unreachable / timeout — fail silent
	}
	defer resp.Body.Close()
	// Non-2xx is also swallowed: nothing is surfaced, exit 0.
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}
