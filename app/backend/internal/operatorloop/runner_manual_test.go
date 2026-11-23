package operatorloop

import (
	"testing"

	"rk/internal/cron"
)

// Only a trigger:manual fire waives the idle floor; schedule, wake and other
// trigger reasons keep it.
func TestManualTrigger(t *testing.T) {
	cases := map[string]bool{
		cron.TriggerReasonPrefix + cron.DefaultWakeReason: true,
		"schedule":                      false,
		"wake":                          false,
		"trigger:pr:o/r#12:check_suite": false,
		"trigger:note":                  false,
		"":                              false,
	}
	for reason, want := range cases {
		if got := manualTrigger(cron.Fire{Reason: cron.FireReason(reason)}); got != want {
			t.Errorf("manualTrigger(%q) = %v, want %v", reason, got, want)
		}
	}
}
