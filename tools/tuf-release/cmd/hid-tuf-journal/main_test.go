package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/awsbroker"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/publicationjournal"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/signingbroker"
)

type commandJournal struct {
	record     *publicationjournal.Record
	loseCommit bool
	reads      int
	writes     int
}

func (s *commandJournal) Load(context.Context, string) (publicationjournal.Record, error) {
	s.reads++
	if s.record == nil {
		return publicationjournal.Record{}, publicationjournal.ErrNotFound
	}
	return *s.record, nil
}
func (s *commandJournal) CompareAndSwap(_ context.Context, _ string, prior int64, next publicationjournal.Record) error {
	if s.record == nil && prior != 0 || s.record != nil && s.record.Revision != prior {
		return publicationjournal.ErrConflict
	}
	s.writes++
	s.record = &next
	if s.loseCommit {
		return errors.New("lost response")
	}
	return nil
}
func (*commandJournal) Reference() (awsbroker.PublicationEvidenceReference, error) {
	return awsbroker.PublicationEvidenceReference{Bucket: "test", Key: "slot", VersionID: "version", SHA256: strings.Repeat("a", 64)}, nil
}
func (*commandJournal) ArchiveEvidence(context.Context, []byte, string) (awsbroker.PublicationEvidenceReference, error) {
	return awsbroker.PublicationEvidenceReference{}, errors.New("unused")
}
func (*commandJournal) ArchiveGeneration(context.Context, string, string) (awsbroker.PublicationEvidenceReference, error) {
	return awsbroker.PublicationEvidenceReference{}, errors.New("unused")
}
func digest(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }

func commandFixture(t *testing.T) ([]string, publicationjournal.Binding, *commandJournal, journalFactory, func() time.Time, *int) {
	t.Helper()
	now := time.Date(2026, 9, 5, 12, 0, 0, 0, time.UTC)
	config := awsbroker.PublicationJournalOperatorConfig{SchemaVersion: "hid.tuf.publication-journal-operator/v1", GitHubRepository: "D-Eminence/hid-system", WorkflowRef: "D-Eminence/hid-system/.github/workflows/tuf-publish.yml@" + strings.Repeat("c", 40),
		Reader: awsbroker.PublicationReaderConfig{SchemaVersion: "hid.tuf.publication-reader/v1", Environment: "staging", RepositoryID: "hid-staging-v1", StateID: "hid-staging-broker-v1",
			BootstrapRootSHA256: strings.Repeat("a", 64), TableName: "hid-staging-tuf-broker-state", BucketName: "hid-staging-evidence-123456", StateObjectPrefix: "tuf-signing-broker/state/hid-staging-broker-v1/",
			ExpectedAWSAccountID: "123456789012", ExpectedAWSRegion: "us-east-1", EncryptionKeyARN: "arn:aws:kms:us-east-1:123456789012:key/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", ObjectLockMode: "GOVERNANCE"}}
	directory := t.TempDir()
	configPath := filepath.Join(directory, "config.json")
	requestPath := filepath.Join(directory, "request.json")
	data, _ := json.Marshal(config)
	if err := os.WriteFile(configPath, data, 0600); err != nil {
		t.Fatal(err)
	}
	role := signingbroker.PublicationRole{Version: 1, SHA256: strings.Repeat("a", 64)}
	binding := publicationjournal.Binding{Owner: "123:1", GitSHA: strings.Repeat("a", 40), ArtifactIdentity: "environments/staging/releases/r0000000001-g" + strings.Repeat("a", 40) + "/release-bundle.json", ArtifactSHA256: strings.Repeat("b", 64), ArtifactSetSHA256: strings.Repeat("c", 64), GitHubRepository: config.GitHubRepository, WorkflowRef: config.WorkflowRef, ActorID: "12345", RepositorySHA256: strings.Repeat("b", 64), WorkflowSHA256: strings.Repeat("c", 64), ConfigSHA256: strings.Repeat("d", 64), ExecutableSHA256: strings.Repeat("e", 64),
		Authorization: signingbroker.PublicationAuthorization{SchemaVersion: "1.0.0", Environment: "staging", RepositoryID: config.Reader.RepositoryID, StateID: config.Reader.StateID, BootstrapRootSHA256: config.Reader.BootstrapRootSHA256, ReleaseID: "r0000000001-g" + strings.Repeat("a", 40), AuthorizedAt: now.Format(time.RFC3339), ExpiresAt: now.Add(5 * time.Minute).Format(time.RFC3339), Candidate: signingbroker.PublicationMetadata{Root: role, Targets: role, Snapshot: role, Timestamp: role}}}
	backend := &commandJournal{}
	calls := 0
	factory := func(_ context.Context, actual awsbroker.PublicationJournalOperatorConfig) (journalBackend, error) {
		calls++
		if actual.WorkflowRef != config.WorkflowRef || actual.Reader != config.Reader {
			t.Fatal("factory config was not pinned")
		}
		return backend, nil
	}
	return []string{configPath, digest(data), requestPath}, binding, backend, factory, func() time.Time { return now }, &calls
}
func requestFile(t *testing.T, path string, request journalRequest) {
	t.Helper()
	data, _ := json.Marshal(request)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestJournalCommandCommitsThenReadsBackBeforeEmittingEvidence(t *testing.T) {
	args, binding, backend, factory, clock, _ := commandFixture(t)
	requestFile(t, args[2], journalRequest{Action: "begin", Binding: binding})
	var output bytes.Buffer
	if err := run(context.Background(), args, &output, factory, clock); err != nil {
		t.Fatal(err)
	}
	if backend.reads != 2 || backend.writes != 1 || !strings.Contains(output.String(), `"schema_version":"hid.tuf.publication-journal-result/v1"`) {
		t.Fatal("command skipped durable readback")
	}
	requestFile(t, args[2], journalRequest{Action: "advance", Owner: binding.Owner, Revision: 1, Phase: publicationjournal.ArchiveVerified, EvidenceHash: strings.Repeat("f", 64)})
	output.Reset()
	if err := run(context.Background(), args, &output, factory, clock); err != nil {
		t.Fatal(err)
	}
	requestFile(t, args[2], journalRequest{Action: "advance", Owner: binding.Owner, Revision: 2, Phase: publicationjournal.UploadStarted, EvidenceHash: strings.Repeat("f", 64), Authorization: binding.Authorization})
	output.Reset()
	if err := run(context.Background(), args, &output, factory, clock); err != nil {
		t.Fatal(err)
	}
	if backend.record.Phase != publicationjournal.UploadStarted {
		t.Fatal("intent was not committed")
	}
	requestFile(t, args[2], journalRequest{Action: "fail", Owner: binding.Owner, Revision: 3, FailureCode: "external-outcome-unknown", EvidenceHash: strings.Repeat("f", 64)})
	output.Reset()
	if err := run(context.Background(), args, &output, factory, clock); err != nil {
		t.Fatal(err)
	}
	if backend.record.Result != "failed" {
		t.Fatal("failure evidence was not retained")
	}
}
func TestJournalCommandNeverTurnsLostCommitResponseIntoMutationPermission(t *testing.T) {
	args, binding, backend, factory, clock, _ := commandFixture(t)
	backend.loseCommit = true
	requestFile(t, args[2], journalRequest{Action: "begin", Binding: binding})
	var output bytes.Buffer
	if err := run(context.Background(), args, &output, factory, clock); err == nil || output.Len() != 0 {
		t.Fatal("ambiguous claim emitted success")
	}
	if backend.record == nil || backend.reads != 1 || backend.writes != 1 {
		t.Fatal("command recovered or discarded ambiguous commit")
	}
	backend.loseCommit = false
	if err := run(context.Background(), args, &output, factory, clock); err == nil || backend.writes != 1 || output.Len() != 0 {
		t.Fatal("new process stole ambiguous attempt")
	}
}
func TestJournalCommandRejectsUnpinnedOrAmbiguousInputsBeforeAWS(t *testing.T) {
	for _, scenario := range []string{"config-hash", "config-link", "config-extra", "request-duplicate", "request-extra", "reset", "retry", "resume", "steal", "delete"} {
		t.Run(scenario, func(t *testing.T) {
			args, binding, _, factory, clock, calls := commandFixture(t)
			requestFile(t, args[2], journalRequest{Action: "begin", Binding: binding})
			switch scenario {
			case "config-hash":
				args[1] = strings.Repeat("f", 64)
			case "config-link":
				link := args[0] + ".link"
				if err := os.Symlink(args[0], link); err != nil {
					t.Fatal(err)
				}
				args[0] = link
			case "config-extra":
				data, _ := os.ReadFile(args[0])
				data = bytes.Replace(data, []byte("{"), []byte(`{"extra":true,`), 1)
				if err := os.WriteFile(args[0], data, 0600); err != nil {
					t.Fatal(err)
				}
				args[1] = digest(data)
			case "request-duplicate":
				if err := os.WriteFile(args[2], []byte(`{"action":"read","action":"begin"}`), 0600); err != nil {
					t.Fatal(err)
				}
			case "request-extra":
				if err := os.WriteFile(args[2], []byte(`{"action":"read","secret":"forbidden"}`), 0600); err != nil {
					t.Fatal(err)
				}
			default:
				requestFile(t, args[2], journalRequest{Action: scenario})
			}
			var output bytes.Buffer
			if err := run(context.Background(), args, &output, factory, clock); err == nil || *calls != 0 || output.Len() != 0 {
				t.Fatal("invalid command reached AWS or emitted success")
			}
		})
	}
}
