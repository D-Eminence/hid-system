package tufclient

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func TestLoadConfigIsStrictAndResolvesRelativePaths(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	configPath := filepath.Join(directory, "trust.json")
	valid := `{
  "schema_version": "1.0.0",
  "environment": "staging",
  "repository_id": "hid-tuf-staging-v1",
  "metadata_url": "https://updates.example.test/metadata",
  "targets_url": "https://updates.example.test/targets",
  "trusted_root_path": "roots/root.json",
  "trusted_root_sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "state_dir": "state",
  "max_target_bytes": 26214400
}`
	if err := os.WriteFile(configPath, []byte(valid), 0o600); err != nil {
		t.Fatal(err)
	}
	configuration, err := LoadConfig(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if configuration.TrustedRootPath != filepath.Join(directory, "roots", "root.json") {
		t.Fatalf("trusted root path was not resolved relative to config: %q", configuration.TrustedRootPath)
	}
	if configuration.StateDir != filepath.Join(directory, "state") {
		t.Fatalf("state path was not resolved relative to config: %q", configuration.StateDir)
	}

	attacks := map[string]string{
		"duplicate": strings.Replace(valid, `"environment": "staging"`, `"environment": "staging", "environment": "production"`, 1),
		"unknown":   strings.Replace(valid, `"schema_version": "1.0.0"`, `"schema_version": "1.0.0", "allow_unsafe_http": true`, 1),
		"trailing":  valid + ` {"schema_version":"1.0.0"}`,
		"schema":    strings.Replace(valid, `"schema_version": "1.0.0"`, `"schema_version": "2.0.0"`, 1),
	}
	for name, contents := range attacks {
		name, contents := name, contents
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			attackPath := filepath.Join(t.TempDir(), "trust.json")
			if err := os.WriteFile(attackPath, []byte(contents), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := LoadConfig(attackPath); err == nil {
				t.Fatalf("LoadConfig accepted %s JSON", name)
			}
		})
	}
}

func TestLoadConfigRejectsNonRegularAndOversizedInputs(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	realPath := filepath.Join(directory, "real.json")
	if err := os.WriteFile(realPath, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	symlinkPath := filepath.Join(directory, "link.json")
	if err := os.Symlink(realPath, symlinkPath); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadConfig(symlinkPath); err == nil {
		t.Fatal("LoadConfig followed a symlink")
	}

	fifoPath := filepath.Join(directory, "fifo.json")
	if err := unix.Mkfifo(fifoPath, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadConfig(fifoPath); err == nil {
		t.Fatal("LoadConfig accepted a FIFO")
	}

	oversizedPath := filepath.Join(directory, "oversized.json")
	if err := os.WriteFile(oversizedPath, []byte(strings.Repeat(" ", 64_001)), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadConfig(oversizedPath); err == nil {
		t.Fatal("LoadConfig accepted an oversized file")
	}

	directoryPath := filepath.Join(directory, "directory.json")
	if err := os.Mkdir(directoryPath, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadConfig(directoryPath); err == nil {
		t.Fatal("LoadConfig accepted a directory")
	}
}

func TestValidateConfigRejectsOriginAndTrustBoundaryAmbiguity(t *testing.T) {
	t.Parallel()
	valid := Config{
		Environment: "staging", RepositoryID: "hid-tuf-staging-v1",
		MetadataURL: "https://updates.example.test/metadata", TargetsURL: "https://updates.example.test/targets",
		TrustedRootPath: "/tmp/root.json", StateDir: "/tmp/state",
		TrustedRootSHA256: strings.Repeat("a", 64), MaxTargetBytes: 25 << 20,
	}
	tests := map[string]func(*Config){
		"environment":        func(value *Config) { value.Environment = "prod" },
		"repository":         func(value *Config) { value.RepositoryID = "UPPER" },
		"http":               func(value *Config) { value.MetadataURL = "http://updates.example.test/metadata" },
		"different-origin":   func(value *Config) { value.TargetsURL = "https://other.example.test/targets" },
		"credentials":        func(value *Config) { value.MetadataURL = "https://user@updates.example.test/metadata" },
		"query":              func(value *Config) { value.TargetsURL += "?generation=1" },
		"noncanonical-path":  func(value *Config) { value.MetadataURL += "/../metadata" },
		"root-pin-case":      func(value *Config) { value.TrustedRootSHA256 = strings.Repeat("A", 64) },
		"target-size":        func(value *Config) { value.MaxTargetBytes = (25 << 20) + 1 },
		"missing-trust-path": func(value *Config) { value.TrustedRootPath = "" },
	}
	for name, mutate := range tests {
		name, mutate := name, mutate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			candidate := valid
			mutate(&candidate)
			if err := validateConfig(&candidate); err == nil {
				t.Fatalf("validateConfig accepted %s ambiguity: %+v", name, candidate)
			}
		})
	}

	unsafeTest := valid
	unsafeTest.AllowUnsafeHTTP = true
	unsafeTest.MetadataURL = "http://127.0.0.1/metadata"
	unsafeTest.TargetsURL = "http://127.0.0.1/targets"
	if err := validateConfig(&unsafeTest); err != nil {
		t.Fatalf("test-only HTTP configuration should remain available to package callers: %v", err)
	}
	if unsafeTest.HTTPClient == nil {
		t.Fatal(fmt.Errorf("validation did not install a bounded HTTP client"))
	}
}
