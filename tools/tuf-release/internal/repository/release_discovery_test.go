package repository

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/testrepo"
)

func TestDiscoverTargetsReleaseIDIsSingleNamespaceAndUntrusted(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	releaseOne := "r0000000001-gaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	_, generation := testrepo.NewHIDRepository(t, "staging", releaseOne, now)
	discovered, err := DiscoverTargetsReleaseID(generation.TargetsBytes, "staging")
	if err != nil {
		t.Fatal(err)
	}
	if discovered != releaseOne {
		t.Fatalf("discovered %q, want %q", discovered, releaseOne)
	}

	releaseTwo := "r0000000002-gbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	var envelope map[string]any
	if err := json.Unmarshal(generation.TargetsBytes, &envelope); err != nil {
		t.Fatal(err)
	}
	targets := envelope["signed"].(map[string]any)["targets"].(map[string]any)
	for path, descriptor := range targets {
		if strings.Contains(path, "/releases/") {
			targets["environments/staging/releases/"+releaseTwo+"/release-bundle.json"] = descriptor
			break
		}
	}
	mixed, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DiscoverTargetsReleaseID(mixed, "staging"); err == nil || !strings.Contains(err.Error(), "mixes") {
		t.Fatalf("mixed release namespaces were accepted: %v", err)
	}
	noChannel := bytes.Replace(
		generation.TargetsBytes,
		[]byte("environments/staging/channels/current.json"),
		[]byte("environments/staging/releases/"+releaseOne+"/channel-copy.json"),
		1,
	)
	if _, err := DiscoverTargetsReleaseID(noChannel, "staging"); err == nil || !strings.Contains(err.Error(), "one channel") {
		t.Fatalf("targets without the current channel were accepted: %v", err)
	}
	if _, err := DiscoverTargetsReleaseID(generation.TargetsBytes, "production"); err == nil {
		t.Fatal("cross-environment targets release discovery was accepted")
	}
}
