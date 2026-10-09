package tufclient

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/testrepo"
)

func TestLoadBatchRequestRejectsAmbiguousInputs(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	target := testrepo.TargetPath("staging", releaseID, "release-bundle.json")
	firstOutput := filepath.Join(directory, "one.json")
	secondOutput := filepath.Join(directory, "two.json")
	valid := fmt.Sprintf(`{"schema_version":"1.0.0","targets":[{"target":%q,"output":%q},{"target":%q,"output":%q}]}`,
		target, firstOutput, testrepo.TargetPath("staging", releaseID, "content/app.tar"), secondOutput)
	validPath := filepath.Join(directory, "valid.json")
	if err := os.WriteFile(validPath, []byte(valid), 0o600); err != nil {
		t.Fatal(err)
	}
	request, err := LoadBatchRequest(validPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(request.Targets) != 2 {
		t.Fatalf("unexpected batch size %d", len(request.Targets))
	}

	attacks := map[string]string{
		"duplicate-json-name": strings.Replace(valid, `"schema_version":"1.0.0"`, `"schema_version":"1.0.0","schema_version":"1.0.0"`, 1),
		"unknown-field":       strings.Replace(valid, `"schema_version":"1.0.0"`, `"schema_version":"1.0.0","environment":"staging"`, 1),
		"duplicate-target":    strings.Replace(valid, testrepo.TargetPath("staging", releaseID, "content/app.tar"), target, 1),
		"duplicate-output":    strings.Replace(valid, secondOutput, firstOutput, 1),
		"relative-output":     strings.Replace(valid, firstOutput, "relative.json", 1),
		"noncanonical-output": strings.Replace(valid, firstOutput,
			directory+string(filepath.Separator)+"nested"+string(filepath.Separator)+".."+string(filepath.Separator)+"one.json", 1),
		"nested-output": strings.Replace(valid, secondOutput,
			firstOutput+string(filepath.Separator)+"nested.json", 1),
		"empty":    `{"schema_version":"1.0.0","targets":[]}`,
		"trailing": valid + ` {}`,
	}
	for name, contents := range attacks {
		name, contents := name, contents
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			filePath := filepath.Join(t.TempDir(), "batch.json")
			if err := os.WriteFile(filePath, []byte(contents), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := LoadBatchRequest(filePath); err == nil {
				t.Fatalf("batch loader accepted %s request", name)
			}
		})
	}

	symlink := filepath.Join(directory, "batch-link.json")
	if err := os.Symlink(validPath, symlink); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadBatchRequest(symlink); err == nil {
		t.Fatal("batch loader followed a request-file symlink")
	}
	oversized := filepath.Join(directory, "oversized.json")
	if err := os.WriteFile(oversized, []byte(strings.Repeat(" ", maxBatchRequest+1)), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadBatchRequest(oversized); err == nil {
		t.Fatal("batch loader accepted an oversized request")
	}
}

func TestBatchDownloadUsesOneRefreshAndNoReplaceOutputs(t *testing.T) {
	t.Parallel()
	firstTarget := testrepo.TargetPath("staging", releaseID, "release-bundle.json")
	secondTarget := testrepo.TargetPath("staging", releaseID, "content/app.tar")
	repository := testrepo.New(t, firstTarget, []byte("bundle"), testrepo.Options{})
	repository.AddOrReplaceTarget(t, secondTarget, []byte("archive"))
	server := httptest.NewServer(http.FileServer(http.Dir(repository.PublicDir)))
	defer server.Close()
	configuration := clientConfig(t, repository.Root, server.URL, t.TempDir())
	client, err := Open(configuration)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	outputDirectory := t.TempDir()
	firstOutput := filepath.Join(outputDirectory, "bundle.json")
	secondOutput := filepath.Join(outputDirectory, "app.tar")
	request := BatchRequest{SchemaVersion: batchRequestSchema, Targets: []BatchTarget{
		{Target: firstTarget, Output: firstOutput},
		{Target: secondTarget, Output: secondOutput},
	}}
	if err := client.DownloadReleaseTargets(releaseID, request); err != nil {
		t.Fatal(err)
	}
	for filePath, expected := range map[string]string{firstOutput: "bundle", secondOutput: "archive"} {
		data, err := os.ReadFile(filePath)
		if err != nil || string(data) != expected {
			t.Fatalf("unexpected verified batch output %q: %q, %v", filePath, data, err)
		}
		info, err := os.Stat(filePath)
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("batch output is not private: %v, %v", info, err)
		}
	}
	if err := client.DownloadReleaseTargets(releaseID, request); err == nil {
		t.Fatal("batch download replaced existing outputs")
	}
}

func TestBatchPreflightCreatesNoOutputOnInvalidSet(t *testing.T) {
	t.Parallel()
	target := testrepo.TargetPath("staging", releaseID, "release-bundle.json")
	repository := testrepo.New(t, target, []byte("bundle"), testrepo.Options{})
	server := httptest.NewServer(http.FileServer(http.Dir(repository.PublicDir)))
	defer server.Close()
	configuration := clientConfig(t, repository.Root, server.URL, t.TempDir())
	client, err := Open(configuration)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	output := filepath.Join(t.TempDir(), "must-not-exist.json")
	request := BatchRequest{SchemaVersion: batchRequestSchema, Targets: []BatchTarget{
		{Target: target, Output: output},
		{Target: testrepo.TargetPath("production", releaseID, "wrong.json"), Output: filepath.Join(t.TempDir(), "wrong.json")},
	}}
	if err := client.DownloadReleaseTargets(releaseID, request); err == nil {
		t.Fatal("batch accepted a cross-environment target")
	}
	if _, err := os.Lstat(output); !os.IsNotExist(err) {
		t.Fatal("batch created an output before completing preflight")
	}

	stateOutput := filepath.Join(configuration.StateDir, "targets", "overwrite.json")
	request = BatchRequest{SchemaVersion: batchRequestSchema, Targets: []BatchTarget{{Target: target, Output: stateOutput}}}
	if err := client.DownloadReleaseTargets(releaseID, request); err == nil {
		t.Fatal("batch accepted an output inside private client state")
	}
}
