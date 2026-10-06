package codebridge

// BootMarker is one cb/boots/<hostId>.json written by the extension when a
// tab-keyed window activated with zero workspace folders — the first-boot
// rescue's positive empty-boot signal. Field names are the extension's JSON
// contract and must not change. StartedAt stays a raw string so a malformed
// stamp never breaks enumeration. The marker shares the host record's hostId
// (both hash the tab-keyed workspace file), so one tab keys one marker.
type BootMarker struct {
	HostID        string `json:"hostId"`
	WorkspaceFile string `json:"workspaceFile"`
	Tab           string `json:"tab"`
	Server        string `json:"server"`
	PID           int    `json:"pid"`
	ExtVersion    string `json:"extVersion"`
	StartedAt     string `json:"startedAt"`
}

// ReadBootMarkers enumerates dir's *.json markers sorted by host id, sharing
// the ReadRecords posture: a missing dir is an empty list, not an error, and
// unreadable or undecodable files are skipped.
func ReadBootMarkers(dir string) ([]BootMarker, error) {
	return readJSONDir(dir, func(m BootMarker) string { return m.HostID })
}
