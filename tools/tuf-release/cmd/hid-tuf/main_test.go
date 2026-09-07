package main

import (
	"bytes"
	"errors"
	"flag"
	"io"
	"os"
	"path/filepath"
	"testing"
)

const cliTestGitSHA = "0123456789abcdef0123456789abcdef01234567"

func TestParseExactFlagsRejectsDuplicatesAliasesAndPositionals(t *testing.T) {
	t.Parallel()
	tests := map[string][]string{
		"duplicate":   {"--config", "one.json", "--config", "two.json"},
		"equals":      {"--config=one.json"},
		"single-dash": {"-config", "one.json"},
		"positional":  {"one.json", "--config"},
		"empty":       {"--config", ""},
		"missing":     {},
	}
	for name, arguments := range tests {
		name, arguments := name, arguments
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			flags := flag.NewFlagSet("test", flag.ContinueOnError)
			flags.SetOutput(io.Discard)
			flags.String("config", "", "config")
			if err := parseExactFlags(flags, arguments, "config"); err == nil {
				t.Fatalf("accepted %s command line: %q", name, arguments)
			}
		})
	}
	flags := flag.NewFlagSet("test", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	config := flags.String("config", "", "config")
	if err := parseExactFlags(flags, []string{"--config", "one.json"}, "config"); err != nil {
		t.Fatal(err)
	}
	if *config != "one.json" {
		t.Fatalf("unexpected parsed config %q", *config)
	}
}

func TestRunPackAndExtractFrontendNoninteractively(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	for name, contents := range map[string]string{
		"index.html": "<html></html>", "manifest.webmanifest": "{}", "service-worker.js": "self.skipWaiting()",
	} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	outputDirectory := t.TempDir()
	archive := filepath.Join(outputDirectory, "web.tar")
	manifest := filepath.Join(outputDirectory, "web.json")
	var stdout, stderr bytes.Buffer
	if err := run([]string{
		"pack-frontend", "--root", root, "--application", "web", "--git-sha", cliTestGitSHA,
		"--archive", archive, "--manifest", manifest,
	}, &stdout, &stderr); err != nil {
		t.Fatalf("pack command failed: %v, stderr=%q", err, stderr.String())
	}
	if stdout.Len() == 0 {
		t.Fatal("pack command did not emit a receipt")
	}
	destination := filepath.Join(t.TempDir(), "web")
	stdout.Reset()
	stderr.Reset()
	if err := run([]string{
		"extract-frontend", "--archive", archive, "--manifest", manifest, "--output", destination,
	}, &stdout, &stderr); err != nil {
		t.Fatalf("extract command failed: %v, stderr=%q", err, stderr.String())
	}
	if _, err := os.Stat(filepath.Join(destination, "index.html")); err != nil {
		t.Fatalf("verified frontend was not extracted: %v", err)
	}
	if err := run([]string{
		"extract-frontend", "--archive", archive, "--manifest", manifest, "--output", destination,
	}, io.Discard, io.Discard); err == nil {
		t.Fatal("extract command replaced an existing destination")
	}
	manifestLink := filepath.Join(t.TempDir(), "manifest-link.json")
	if err := os.Symlink(manifest, manifestLink); err != nil {
		t.Fatal(err)
	}
	if err := extractFrontend(archive, manifestLink, filepath.Join(t.TempDir(), "linked-manifest")); err == nil {
		t.Fatal("extract command followed a manifest symlink")
	}
	archiveLink := filepath.Join(t.TempDir(), "archive-link.tar")
	if err := os.Symlink(archive, archiveLink); err != nil {
		t.Fatal(err)
	}
	if err := extractFrontend(archiveLink, manifest, filepath.Join(t.TempDir(), "linked-archive")); err == nil {
		t.Fatal("extract command followed an archive symlink")
	}
}

func TestRunRejectsAmbiguousCommandsBeforeSideEffects(t *testing.T) {
	t.Parallel()
	for name, arguments := range map[string][]string{
		"get-duplicate": {"get", "--config", "one", "--config", "two", "--release", "release", "--target", "target"},
		"batch-equals":  {"get-batch", "--config=one", "--release", "release", "--request", "request"},
		"pack-extra":    {"pack-frontend", "--root", "root", "--application", "web", "--git-sha", cliTestGitSHA, "--archive", "a", "--manifest", "m", "extra"},
		"unknown":       {"publish", "--config", "trust.json"},
	} {
		name, arguments := name, arguments
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if err := run(arguments, io.Discard, io.Discard); err == nil {
				t.Fatalf("accepted ambiguous %s command", name)
			}
		})
	}
}

func TestWriteAllDetectsShortWrite(t *testing.T) {
	t.Parallel()
	if err := writeAll(shortWriter{}, []byte("release")); !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("short write was not rejected: %v", err)
	}
}

type shortWriter struct{}

func (shortWriter) Write(data []byte) (int, error) {
	return len(data) / 2, nil
}
