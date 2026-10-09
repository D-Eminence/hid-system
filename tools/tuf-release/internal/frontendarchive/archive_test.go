package frontendarchive

import (
	"archive/tar"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"time"
)

const testGitSHA = "0123456789abcdef0123456789abcdef01234567"

func TestPackIsDeterministicAndExtractsAtomically(t *testing.T) {
	t.Parallel()
	first := makeFrontend(t, map[string]string{
		"index.html": "<html>HID</html>", "manifest.webmanifest": "{}",
		"service-worker.js": "self.addEventListener('fetch', () => {})", "assets/app.js": "console.log('hid')",
	})
	second := makeFrontend(t, map[string]string{
		"service-worker.js": "self.addEventListener('fetch', () => {})", "assets/app.js": "console.log('hid')",
		"manifest.webmanifest": "{}", "index.html": "<html>HID</html>",
	})
	for _, root := range []string{first, second} {
		if err := filepath.Walk(root, func(name string, info os.FileInfo, err error) error {
			if err == nil {
				return os.Chtimes(name, time.Unix(1_700_000_000, 0), time.Unix(1_700_000_000, 0))
			}
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chmod(filepath.Join(second, "assets", "app.js"), 0o600); err != nil {
		t.Fatal(err)
	}

	var firstArchive, secondArchive bytes.Buffer
	firstManifest, err := Pack(first, "web", testGitSHA, &firstArchive, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	secondManifest, err := Pack(second, "web", testGitSHA, &secondArchive, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(firstArchive.Bytes(), secondArchive.Bytes()) {
		t.Fatal("archives differ despite identical content")
	}
	firstJSON, _ := firstManifest.Bytes()
	secondJSON, _ := secondManifest.Bytes()
	if !bytes.Equal(firstJSON, secondJSON) {
		t.Fatal("content manifests differ despite identical content")
	}

	destination := filepath.Join(t.TempDir(), "verified-web")
	if err := Extract(bytes.NewReader(firstArchive.Bytes()), firstManifest, destination, DefaultLimits()); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(filepath.Join(destination, "assets", "app.js"))
	if err != nil || string(contents) != "console.log('hid')" {
		t.Fatalf("unexpected extracted file: %q, %v", contents, err)
	}
	if err := Extract(bytes.NewReader(firstArchive.Bytes()), firstManifest, destination, DefaultLimits()); err == nil {
		t.Fatal("extract unexpectedly replaced an existing destination")
	}
}

func TestPackRejectsSymlinkAndExecutable(t *testing.T) {
	t.Parallel()
	root := makeFrontend(t, map[string]string{
		"index.html": "x", "manifest.webmanifest": "{}", "service-worker.js": "x",
	})
	if err := os.Symlink("index.html", filepath.Join(root, "linked.html")); err != nil {
		t.Fatal(err)
	}
	if _, err := Pack(root, "web", testGitSHA, &bytes.Buffer{}, DefaultLimits()); err == nil {
		t.Fatal("pack accepted a symlink")
	}
	if err := os.Remove(filepath.Join(root, "linked.html")); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(root, "service-worker.js"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Pack(root, "web", testGitSHA, &bytes.Buffer{}, DefaultLimits()); err == nil {
		t.Fatal("pack accepted an executable file")
	}
}

func TestManifestRejectsUnknownFieldsOrderingAndCaseCollisions(t *testing.T) {
	t.Parallel()
	unknown := []byte(`{"schema_version":"1.0.0","app":"web","git_sha":"0123456789abcdef0123456789abcdef01234567","archive_profile":"hid-frontend-ustar-v1","file_count":0,"total_size_bytes":0,"files":[],"secret":"no"}`)
	if _, err := ParseManifest(unknown); err == nil {
		t.Fatal("manifest accepted an unknown field")
	}
	manifest := validManifest()
	manifest.Files = append(manifest.Files, Entry{Path: "INDEX.HTML", Length: 1, SHA256: digest("x"), Mode: 0o644})
	manifest.FileCount++
	manifest.TotalSizeBytes++
	sortEntries(manifest.Files)
	if err := manifest.Validate(DefaultLimits()); err == nil {
		t.Fatal("manifest accepted a case collision")
	}
}

func TestExtractRejectsTraversalAbsoluteLinkAndHashMismatch(t *testing.T) {
	t.Parallel()
	manifest := validManifest()
	tests := []struct {
		name     string
		header   tar.Header
		contents string
	}{
		{name: "traversal", header: canonicalHeader("../escape", 1), contents: "x"},
		{name: "absolute", header: canonicalHeader("/escape", 1), contents: "x"},
		{name: "symlink", header: tar.Header{Name: "index.html", Typeflag: tar.TypeSymlink, Linkname: "/tmp/x", Mode: 0o644, ModTime: time.Unix(0, 0).UTC()}, contents: ""},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			archive := oneEntryTar(t, testCase.header, testCase.contents)
			destination := filepath.Join(t.TempDir(), "output")
			if err := Extract(bytes.NewReader(archive), manifest, destination, DefaultLimits()); err == nil {
				t.Fatalf("extract accepted %s entry", testCase.name)
			}
			if _, err := os.Stat(destination); !os.IsNotExist(err) {
				t.Fatal("failed extraction committed destination")
			}
		})
	}

	root := makeFrontend(t, map[string]string{
		"index.html": "x", "manifest.webmanifest": "{}", "service-worker.js": "x",
	})
	var archive bytes.Buffer
	packed, err := Pack(root, "web", testGitSHA, &archive, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	packed.Files[0].SHA256 = digest("wrong")
	if err := Extract(bytes.NewReader(archive.Bytes()), packed, filepath.Join(t.TempDir(), "bad"), DefaultLimits()); err == nil {
		t.Fatal("extract accepted a manifest hash mismatch")
	}
}

func TestExtractRejectsDuplicateOversizeAndTruncation(t *testing.T) {
	t.Parallel()
	header := canonicalHeader("index.html", 1)
	var duplicate bytes.Buffer
	writer := tar.NewWriter(&duplicate)
	for range 2 {
		if err := writer.WriteHeader(&header); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write([]byte("x")); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := Extract(bytes.NewReader(duplicate.Bytes()), validManifest(), filepath.Join(t.TempDir(), "duplicate"), DefaultLimits()); err == nil {
		t.Fatal("extract accepted duplicate/archive-manifest mismatch")
	}

	root := makeFrontend(t, map[string]string{
		"index.html": "large", "manifest.webmanifest": "{}", "service-worker.js": "x",
	})
	limits := DefaultLimits()
	limits.MaxFileBytes = 4
	if _, err := Pack(root, "web", testGitSHA, &bytes.Buffer{}, limits); err == nil {
		t.Fatal("pack accepted an oversized file")
	}
}

func TestExtractRejectsNonUSTARAndTrailingPayload(t *testing.T) {
	t.Parallel()
	manifest := validManifest()

	var nonUSTAR bytes.Buffer
	writer := tar.NewWriter(&nonUSTAR)
	for _, entry := range manifest.Files {
		header := canonicalHeader(entry.Path, entry.Length)
		header.Format = tar.FormatGNU
		if err := writer.WriteHeader(&header); err != nil {
			t.Fatal(err)
		}
		contents := map[string]string{
			"index.html": "x", "manifest.webmanifest": "{}", "service-worker.js": "x",
		}[entry.Path]
		if _, err := writer.Write([]byte(contents)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := Extract(bytes.NewReader(nonUSTAR.Bytes()), manifest, filepath.Join(t.TempDir(), "gnu"), DefaultLimits()); err == nil {
		t.Fatal("extract accepted a GNU-format archive")
	}

	root := makeFrontend(t, map[string]string{
		"index.html": "x", "manifest.webmanifest": "{}", "service-worker.js": "x",
	})
	var canonical bytes.Buffer
	packed, err := Pack(root, "web", testGitSHA, &canonical, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	canonical.WriteString("hidden payload")
	if err := Extract(bytes.NewReader(canonical.Bytes()), packed, filepath.Join(t.TempDir(), "trailing"), DefaultLimits()); err == nil {
		t.Fatal("extract accepted data after the canonical archive end marker")
	}
}

func makeFrontend(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for name, contents := range files {
		filePath := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filePath, []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func validManifest() Manifest {
	entries := []Entry{
		{Path: "index.html", Length: 1, SHA256: digest("x"), Mode: 0o644},
		{Path: "manifest.webmanifest", Length: 2, SHA256: digest("{}"), Mode: 0o644},
		{Path: "service-worker.js", Length: 1, SHA256: digest("x"), Mode: 0o644},
	}
	return Manifest{
		SchemaVersion: SchemaVersion, App: "web", GitSHA: testGitSHA,
		ArchiveProfile: ArchiveProfile, FileCount: len(entries), TotalSizeBytes: 4, Files: entries,
	}
}

func canonicalHeader(name string, size int64) tar.Header {
	return tar.Header{Name: name, Size: size, Typeflag: tar.TypeReg, Mode: 0o644, Uid: 0, Gid: 0, ModTime: time.Unix(0, 0).UTC(), Format: tar.FormatUSTAR}
}

func oneEntryTar(t *testing.T, header tar.Header, contents string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := tar.NewWriter(&buffer)
	if err := writer.WriteHeader(&header); err != nil {
		t.Fatal(err)
	}
	if contents != "" {
		if _, err := writer.Write([]byte(contents)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func digest(value string) string {
	hash := sha256.Sum256([]byte(value))
	return hex.EncodeToString(hash[:])
}

func sortEntries(entries []Entry) {
	for left := range entries {
		for right := left + 1; right < len(entries); right++ {
			if entries[right].Path < entries[left].Path {
				entries[left], entries[right] = entries[right], entries[left]
			}
		}
	}
}
