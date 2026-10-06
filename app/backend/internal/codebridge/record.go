package codebridge

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// HostRecord is one cb/hosts/<hostId>.json file as written by the extension
// on activation. Field names are the extension's JSON contract and must not
// change. StartedAt stays a raw string (RFC 3339 as written by the extension)
// so a malformed timestamp never breaks enumeration. Tab and Server carry the
// tab identity and appear only on hosts opened through a tab-keyed workspace
// file; a folder-opened host has neither.
type HostRecord struct {
	HostID     string `json:"hostId"`
	Folder     string `json:"folder"`
	PID        int    `json:"pid"`
	Sock       string `json:"sock"`
	ExtVersion string `json:"extVersion"`
	StartedAt  string `json:"startedAt"`
	Tab        string `json:"tab,omitempty"`
	Server     string `json:"server,omitempty"`
}

// recordPath is the registry file for one host id.
func recordPath(dir, hostID string) string {
	return filepath.Join(dir, hostID+".json")
}

// ReadRecords enumerates dir's *.json host records, sorted by host id for
// deterministic listing. The registry is a discovery hint only: records are
// candidates for liveness verification (LiveHosts), never proof of a live
// host. A missing dir is an empty list, not an error; unreadable or undecodable
// files are skipped.
func ReadRecords(dir string) ([]HostRecord, error) {
	return readJSONDir(dir, func(rec HostRecord) string { return rec.HostID })
}

// readJSONDir is the one registry enumeration loop: every *.json file under
// dir decoded into T, sorted by host id for deterministic listing. A missing
// dir is an empty list, not an error; unreadable or undecodable files are
// skipped.
func readJSONDir[T any](dir string, hostID func(T) string) ([]T, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []T
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var item T
		if err := json.Unmarshal(data, &item); err != nil {
			continue
		}
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool { return hostID(out[i]) < hostID(out[j]) })
	return out, nil
}
