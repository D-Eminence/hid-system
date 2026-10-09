package awsbroker

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/repository"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/testrepo"
	"github.com/aws/aws-sdk-go-v2/aws"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

func TestPublicationArchiveReadsEveryImmutableVersionBeforeAcceptingReplay(t *testing.T) {
	store, _, s3Client, _, _, now := journalFixture(t)
	data := []byte("public artifact bytes\x00\xff")
	suffix := "objects/" + digestHex(data)
	ref, err := store.archiveBytes(context.Background(), data, suffix, "application/octet-stream")
	if err != nil {
		t.Fatal(err)
	}
	if ref.SHA256 != digestHex(data) || s3Client.putCalls != 1 || s3Client.getCalls != 1 || s3Client.retentionCalls != 1 {
		t.Fatal("archive did not read exact retained bytes")
	}
	if s3Client.lastPut.ChecksumAlgorithm != s3types.ChecksumAlgorithmSha256 || aws.ToString(s3Client.lastPut.IfNoneMatch) != "*" {
		t.Fatal("archive lacks conditional Object Lock checksum headers")
	}
	if !aws.ToTime(s3Client.lastPut.ObjectLockRetainUntilDate).Equal(now.Add(730 * 24 * time.Hour)) {
		t.Fatal("archive did not request exactly 730 days of Object Lock retention")
	}
	second, err := store.archiveBytes(context.Background(), data, suffix, "application/octet-stream")
	if err != nil || second != ref || s3Client.putCalls != 1 || s3Client.getCalls != 2 {
		t.Fatalf("safe data readback differs: %v", err)
	}
	for _, scenario := range []string{"checksum", "bytes", "retention", "kms", "type", "metadata", "duplicate", "delete-marker"} {
		t.Run(scenario, func(t *testing.T) {
			key := objectMapKey(ref.Key, ref.VersionID)
			original := s3Client.objects[key]
			changed := original
			switch scenario {
			case "checksum":
				changed.checksum = "wrong"
			case "bytes":
				changed.data = []byte("tampered")
			case "retention":
				changed.retainUntil = now.Add(24 * time.Hour)
			case "kms":
				changed.kmsKey = "other"
			case "type":
				changed.contentType = "text/html"
			case "metadata":
				changed.metadata = map[string]string{}
			case "duplicate":
				s3Client.objects[objectMapKey(ref.Key, "duplicate")] = changed
			case "delete-marker":
				s3Client.deleteMarker = true
			}
			s3Client.objects[key] = changed
			if _, err := store.archiveBytes(context.Background(), data, suffix, "application/octet-stream"); err == nil {
				t.Fatal("tampered archived data accepted")
			}
			s3Client.objects[key] = original
			delete(s3Client.objects, objectMapKey(ref.Key, "duplicate"))
			s3Client.deleteMarker = false
		})
	}
}

func TestPublicationGenerationArchiveBindsCompleteManifestAndRejectsChangedDirectory(t *testing.T) {
	store, _, s3Client, _, _, now := journalFixture(t)
	_, generation := testrepo.NewHIDRepository(t, "staging", stateTestRelease, *now)
	directory := t.TempDir()
	files := map[string][]byte{"metadata/1.root.json": generation.RootBytes, "metadata/1.targets.json": generation.TargetsBytes,
		"metadata/1.snapshot.json": generation.SnapshotBytes, "metadata/timestamp.json": generation.TimestampBytes}
	for logical, data := range map[string][]byte{"environments/staging/channels/current.json": []byte(`{"channel":true}`), "environments/staging/releases/" + stateTestRelease + "/release-bundle.json": []byte(`{"release":true}`)} {
		files["targets/"+filepath.ToSlash(filepath.Dir(logical))+"/"+digestHex(data)+"."+filepath.Base(logical)] = data
	}
	for path, data := range files {
		path = filepath.Join(directory, path)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	inspected, err := repository.InspectPublicationGeneration(directory, "staging", *now, true)
	if err != nil {
		t.Fatal(err)
	}
	ref, err := store.ArchiveGeneration(context.Background(), directory, inspected.SHA256())
	if err != nil {
		t.Fatal(err)
	}
	var manifest PublicationArchive
	if err := json.Unmarshal(s3Client.objects[objectMapKey(ref.Key, ref.VersionID)].data, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.RepositorySHA256 != inspected.SHA256() || len(manifest.Files) != len(files) {
		t.Fatal("archive manifest lacks exact generation closure")
	}
	for _, file := range manifest.Files {
		if file.Reference.SHA256 != digestHex(files[file.Path]) || file.SHA256 != file.Reference.SHA256 {
			t.Fatal("archive reference differs from target bytes")
		}
	}
	puts := s3Client.putCalls
	if _, err := store.ArchiveGeneration(context.Background(), directory, strings.Repeat("f", 64)); err == nil {
		t.Fatal("unapproved repository archived")
	}
	if err := os.WriteFile(filepath.Join(directory, "metadata/timestamp.json"), []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ArchiveGeneration(context.Background(), directory, inspected.SHA256()); err == nil {
		t.Fatal("changed repository archived")
	}
	if s3Client.putCalls != puts {
		t.Fatal("invalid archive reached writes")
	}
}

func TestPublicationEvidenceAndReferenceRequireExactReadback(t *testing.T) {
	store, controller, s3Client, _, binding, now := journalFixture(t)
	if _, err := store.Reference(); err == nil {
		t.Fatal("absent journal yielded reference")
	}
	if _, err := controller.Begin(context.Background(), binding); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Reference(); err == nil {
		t.Fatal("unread journal yielded reference")
	}
	if _, err := store.Load(context.Background(), store.journalID()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Reference(); err != nil {
		t.Fatal(err)
	}
	retentionCalls := s3Client.retentionCalls
	data, _ := json.Marshal(map[string]any{"schema_version": "hid.tuf.publication-evidence/v1", "phase": "archive-verified", "binding": binding, "payload": map[string]bool{"verified": true}})
	ref, err := store.ArchiveEvidence(context.Background(), data, digestHex(data))
	if err != nil {
		t.Fatal(err)
	}
	if ref.Key != store.config.ObjectPrefix+"evidence/"+digestHex(data)+".json" {
		t.Fatal("evidence namespace drift")
	}
	if !aws.ToTime(s3Client.lastPut.ObjectLockRetainUntilDate).Equal(now.Add(730 * 24 * time.Hour)) {
		t.Fatal("evidence did not request exactly 730 days of Object Lock retention")
	}
	if s3Client.retentionCalls != retentionCalls+2 {
		t.Fatal("evidence did not verify both active and original long-term retention")
	}
	if _, err := store.ArchiveEvidence(context.Background(), data, digestHex(data)); err == nil {
		t.Fatal("ambiguous evidence write retried")
	}
	puts := s3Client.putCalls
	if _, err := store.ArchiveEvidence(context.Background(), data, strings.Repeat("f", 64)); err == nil {
		t.Fatal("unbound evidence accepted")
	}
	bad := []byte(`{"schema_version":"hid.tuf.publication-evidence/v1","phase":"archive-verified","binding":{},"payload":{},"secret":"forbidden"}`)
	if _, err := store.ArchiveEvidence(context.Background(), bad, digestHex(bad)); err == nil {
		t.Fatal("unexpected evidence properties accepted")
	}
	if s3Client.putCalls != puts {
		t.Fatal("invalid evidence reached writes")
	}
	weakStore, _, weakS3, _, _, _ := journalFixture(t)
	weakS3.weakenRetentionAfterWrite = true
	if _, err := weakStore.ArchiveEvidence(context.Background(), data, digestHex(data)); err == nil {
		t.Fatal("shortened evidence retention accepted after write")
	}
}

func TestPublicationJournalOperatorConfigurationFailsClosed(t *testing.T) {
	store, _, _, _, _, now := journalFixture(t)
	config := PublicationJournalOperatorConfig{SchemaVersion: "hid.tuf.publication-journal-operator/v1", Reader: publicationReaderTestConfig(*now), GitHubRepository: store.config.Policy.GitHubRepository, WorkflowRef: store.config.Policy.WorkflowRef}
	data, _ := json.Marshal(config)
	if _, err := DecodePublicationJournalOperatorConfig(data); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*PublicationJournalOperatorConfig){
		func(c *PublicationJournalOperatorConfig) { c.SchemaVersion = "other" }, func(c *PublicationJournalOperatorConfig) { c.Reader.Environment = "production" },
		func(c *PublicationJournalOperatorConfig) { c.Reader.ExpectedAWSRegion = "eu-west-1" }, func(c *PublicationJournalOperatorConfig) { c.WorkflowRef = "main" },
		func(c *PublicationJournalOperatorConfig) { c.HistoricalWorkflowRefs = []string{c.WorkflowRef} }, func(c *PublicationJournalOperatorConfig) { c.GitHubRepository = "other/repo" },
	} {
		c := config
		change(&c)
		data, _ := json.Marshal(c)
		if _, err := DecodePublicationJournalOperatorConfig(data); err == nil {
			t.Fatal("invalid journal config accepted")
		}
	}
	if _, err := DecodePublicationJournalOperatorConfig(append(data, []byte(`{}`)...)); err == nil {
		t.Fatal("trailing config accepted")
	}
}
