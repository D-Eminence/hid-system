package main

import (
	"bytes"
	"context"
	"crypto"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/awsbroker"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/repository"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/signingbroker"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/testrepo"
	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

const releaseOne = "r0000000001-gaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const releaseTwo = "r0000000002-gbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

type publicationTestStore struct {
	checkpoint signingbroker.Checkpoint
	writes     int
	absent     bool
}

func (store *publicationTestStore) Load(context.Context, string) (signingbroker.Checkpoint, error) {
	if store.absent {
		return signingbroker.Checkpoint{}, signingbroker.ErrStateNotFound
	}
	return store.checkpoint, nil
}
func (store *publicationTestStore) CompareAndSwap(context.Context, string, int64, signingbroker.Checkpoint) error {
	store.writes++
	return errors.New("unexpected write")
}
func digest(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }

func writeTestRepository(t *testing.T, directory string, generations ...testrepo.HIDGeneration) {
	t.Helper()
	for _, generation := range generations {
		files := map[string][]byte{
			"metadata/" + strconv.FormatInt(generation.RootVersion, 10) + ".root.json":         generation.RootBytes,
			"metadata/" + strconv.FormatInt(generation.TargetsVersion, 10) + ".targets.json":   generation.TargetsBytes,
			"metadata/" + strconv.FormatInt(generation.SnapshotVersion, 10) + ".snapshot.json": generation.SnapshotBytes,
			"metadata/timestamp.json": generation.TimestampBytes,
		}
		for logical, data := range map[string][]byte{
			"environments/staging/channels/current.json":                                     []byte(`{"channel":true}`),
			"environments/staging/releases/" + generation.ReleaseID + "/release-bundle.json": []byte(`{"release":true}`),
		} {
			files["targets/"+filepath.ToSlash(filepath.Dir(logical))+"/"+digest(data)+"."+filepath.Base(logical)] = data
		}
		for path, data := range files {
			path = filepath.Join(directory, path)
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, data, 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func publicationCommandFixture(t *testing.T) ([]string, controllerFactory, func() time.Time, *publicationTestStore) {
	t.Helper()
	return publicationCommandFixtureAtVersion(t, 1)
}

func refreshPublicationTestGeneration(t *testing.T, authority *testrepo.HIDRepository, previous testrepo.HIDGeneration, version int64, now time.Time) testrepo.HIDGeneration {
	t.Helper()
	snapshotSigner, err := signature.LoadSigner(authority.RolePrivateKey(t, metadata.SNAPSHOT, 0), crypto.SHA256)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := repository.BuildSnapshot(previous.RootBytes, previous.TargetsBytes, repository.SnapshotOptions{
		Environment: "staging", RepositoryID: "hid-staging-v1", ReleaseID: previous.ReleaseID, RootVersion: 1, Version: version,
		CreatedAt: now, Expires: now.Add(7 * 24 * time.Hour), ExpectedTargetsVersion: previous.TargetsVersion, ExpectedTargetsSHA256: digest(previous.TargetsBytes),
	}, snapshotSigner)
	if err != nil {
		t.Fatal(err)
	}
	timestampSigner, err := signature.LoadSigner(authority.RolePrivateKey(t, metadata.TIMESTAMP, 0), crypto.SHA256)
	if err != nil {
		t.Fatal(err)
	}
	timestamp, err := repository.BuildTimestamp(previous.RootBytes, snapshot, repository.TimestampOptions{
		Environment: "staging", RepositoryID: "hid-staging-v1", ReleaseID: previous.ReleaseID, RootVersion: 1, Version: version,
		CreatedAt: now, Expires: now.Add(24 * time.Hour), ExpectedSnapshotVersion: version, ExpectedSnapshotSHA256: digest(snapshot),
	}, timestampSigner)
	if err != nil {
		t.Fatal(err)
	}
	previous.SnapshotBytes, previous.TimestampBytes = snapshot, timestamp
	previous.SnapshotVersion, previous.TimestampVersion = version, version
	return previous
}

func publicationCommandFixtureAtVersion(t *testing.T, publishedVersion int64) ([]string, controllerFactory, func() time.Time, *publicationTestStore) {
	t.Helper()
	now := time.Date(2026, 9, 5, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	authority, genesis := testrepo.NewHIDRepository(t, "staging", releaseOne, now)
	generations := []testrepo.HIDGeneration{genesis}
	if publishedVersion == 2 {
		generations = append(generations, refreshPublicationTestGeneration(t, authority, genesis, 2, now),
			refreshPublicationTestGeneration(t, authority, genesis, 3, now))
	} else if publishedVersion == 1 {
		generations = append(generations, authority.Advance(t, releaseTwo))
	} else {
		t.Fatal("unsupported publication fixture version")
	}
	current, next := generations[publishedVersion-1], generations[publishedVersion]
	directory := t.TempDir()
	previousPath, candidatePath := filepath.Join(directory, "previous"), filepath.Join(directory, "candidate")
	writeTestRepository(t, previousPath, generations[:publishedVersion]...)
	writeTestRepository(t, candidatePath, generations...)
	config := awsbroker.PublicationReaderConfig{
		SchemaVersion: "hid.tuf.publication-reader/v1", Environment: "staging", RepositoryID: "hid-staging-v1", StateID: "hid-staging-broker-v1",
		BootstrapRootSHA256: digest(genesis.RootBytes), TableName: "hid-staging-tuf-broker-state", BucketName: "hid-staging-evidence-123456",
		StateObjectPrefix: "tuf-signing-broker/state/hid-staging-broker-v1/", ExpectedAWSAccountID: "123456789012", ExpectedAWSRegion: "us-east-1",
		EncryptionKeyARN: "arn:aws:kms:us-east-1:123456789012:key/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", ObjectLockMode: "GOVERNANCE",
	}
	configPath := filepath.Join(directory, "operator.json")
	data, _ := json.Marshal(config)
	if err := os.WriteFile(configPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	record := signingbroker.NewMetadataRecord
	revision := publishedVersion * 3
	store := &publicationTestStore{checkpoint: signingbroker.Checkpoint{
		SchemaVersion: signingbroker.CheckpointSchemaVersion, Environment: config.Environment, RepositoryID: config.RepositoryID, StateID: config.StateID,
		BootstrapRootSHA256: config.BootstrapRootSHA256, Revision: revision, ReleaseID: current.ReleaseID,
		RootHistory: []signingbroker.MetadataRecord{record(1, genesis.RootBytes)}, Targets: record(current.TargetsVersion, current.TargetsBytes),
		Snapshot: record(publishedVersion, current.SnapshotBytes), Timestamp: record(publishedVersion, current.TimestampBytes), SnapshotVersionHighWater: publishedVersion + 1, TimestampVersionHighWater: publishedVersion + 1,
		PendingSnapshot: &signingbroker.PendingSnapshot{
			CandidateID: "one", RequestSHA256: strings.Repeat("a", 64), ReleaseID: next.ReleaseID, CreatedAt: now.Format(time.RFC3339), StateRevision: revision - 1,
			Root: record(1, next.RootBytes), Targets: record(next.TargetsVersion, next.TargetsBytes), Snapshot: record(publishedVersion+1, next.SnapshotBytes),
		},
		PendingTimestamp: &signingbroker.PendingTimestamp{
			CandidateID: "one", RequestSHA256: strings.Repeat("b", 64), ReleaseID: next.ReleaseID, CreatedAt: now.Format(time.RFC3339), StateRevision: revision,
			Root: record(1, next.RootBytes), Snapshot: record(publishedVersion+1, next.SnapshotBytes), Timestamp: record(publishedVersion+1, next.TimestampBytes),
		},
	}}
	factory := func(_ context.Context, actual awsbroker.PublicationReaderConfig) (*signingbroker.PublicationController, error) {
		if actual != config {
			t.Fatal("factory received unpinned configuration")
		}
		return signingbroker.NewPublicationController(signingbroker.PublicationConfig{
			Environment: config.Environment, RepositoryID: config.RepositoryID, StateID: config.StateID, BootstrapRootSHA256: config.BootstrapRootSHA256,
		}, store, clock)
	}
	inspected, err := repository.InspectPublicationGeneration(candidatePath, "staging", now, true)
	if err != nil {
		t.Fatal(err)
	}
	previous, err := repository.InspectPublicationGeneration(previousPath, "staging", now, false)
	if err != nil {
		t.Fatal(err)
	}
	return []string{configPath, previousPath, previous.SHA256(), candidatePath, inspected.SHA256()}, factory, clock, store
}

func TestPublicationCommandBindsRepositoryClosureAndFreshState(t *testing.T) {
	args, factory, clock, store := publicationCommandFixture(t)
	var output bytes.Buffer
	if err := run(context.Background(), args, &output, factory, clock); err != nil {
		t.Fatal(err)
	}
	var result authorizationResult
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.RepositorySHA256 != args[4] || result.PreviousRepositorySHA256 != args[2] || result.FileCount != 9 ||
		result.Authorization.StateRevision != 3 || result.Authorization.Candidate.Timestamp.Version != 2 || store.writes != 0 {
		t.Fatalf("publication command did not bind inspected closure and state: %+v", result)
	}
	store.checkpoint.PendingTimestamp = nil
	output.Reset()
	if err := run(context.Background(), args, &output, factory, clock); err == nil || output.Len() != 0 {
		t.Fatal("failed authorization emitted a decision")
	}
}

func TestPublicationCommandRejectsUnretainedOrMutatedInputsBeforeAWS(t *testing.T) {
	for _, scenario := range []string{"hash", "previous-hash", "missing-old-snapshot", "changed-target", "config-duplicate", "ancestor-symlink", "bootstrap-hash", "legacy-arguments"} {
		t.Run(scenario, func(t *testing.T) {
			args, _, clock, _ := publicationCommandFixture(t)
			switch scenario {
			case "hash":
				args[4] = strings.Repeat("a", 64)
			case "previous-hash":
				args[2] = strings.Repeat("a", 64)
			case "bootstrap-hash":
				args[1] = "-"
			case "legacy-arguments":
				args = []string{args[0], args[1], args[3], args[4]}
			case "missing-old-snapshot":
				for _, path := range []string{"metadata/1.snapshot.json", "metadata/1.targets.json",
					"targets/environments/staging/releases/" + releaseOne + "/" + digest([]byte(`{"release":true}`)) + ".release-bundle.json"} {
					if err := os.Remove(filepath.Join(args[3], path)); err != nil {
						t.Fatal(err)
					}
				}
			case "changed-target":
				files, err := filepath.Glob(filepath.Join(args[3], "targets/environments/staging/channels/*.current.json"))
				if err != nil || len(files) != 1 {
					t.Fatal("missing channel test fixture")
				}
				if err := os.WriteFile(files[0], []byte("changed"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "config-duplicate":
				data, err := os.ReadFile(args[0])
				if err != nil {
					t.Fatal(err)
				}
				data = []byte(strings.Replace(string(data), "{", `{"environment":"staging",`, 1))
				if err := os.WriteFile(args[0], data, 0o600); err != nil {
					t.Fatal(err)
				}
			case "ancestor-symlink":
				link := filepath.Join(t.TempDir(), "link")
				if err := os.Symlink(filepath.Dir(args[0]), link); err != nil {
					t.Fatal(err)
				}
				args[0] = filepath.Join(link, filepath.Base(args[0]))
			}
			var output bytes.Buffer
			factory := func(context.Context, awsbroker.PublicationReaderConfig) (*signingbroker.PublicationController, error) {
				t.Fatal("invalid local input reached AWS initialization")
				return nil, nil
			}
			if err := run(context.Background(), args, &output, factory, clock); err == nil || output.Len() != 0 {
				t.Fatal("invalid local input was authorized")
			}
		})
	}
}

func TestPublicationCommandRejectsPrunedPredecessorBeforeAWS(t *testing.T) {
	args, factory, clock, store := publicationCommandFixtureAtVersion(t, 2)
	var output bytes.Buffer
	if err := run(context.Background(), args, &output, factory, clock); err != nil {
		t.Fatalf("complete published predecessor was not authorized: %v", err)
	}
	for _, directory := range []string{args[1], args[3]} {
		if err := os.Remove(filepath.Join(directory, "metadata/1.snapshot.json")); err != nil {
			t.Fatal(err)
		}
	}
	previous, err := repository.InspectPublicationGeneration(args[1], "staging", clock(), false)
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := repository.InspectPublicationGeneration(args[3], "staging", clock(), true)
	if err != nil {
		t.Fatal(err)
	}
	if err := repository.ValidatePublicationSuccessor(previous, candidate); err != nil {
		t.Fatalf("pruned fixture must retain the supplied predecessor: %v", err)
	}
	// Both directories remain valid and preserve the supplied current metadata;
	// only the independent full-generation pin detects lost published history.
	args[4] = candidate.SHA256()
	output.Reset()
	factory = func(context.Context, awsbroker.PublicationReaderConfig) (*signingbroker.PublicationController, error) {
		t.Fatal("pruned predecessor reached AWS initialization")
		return nil, nil
	}
	if err := run(context.Background(), args, &output, factory, clock); err == nil ||
		!strings.Contains(err.Error(), "protected previous publication hash") || output.Len() != 0 || store.writes != 0 {
		t.Fatalf("pruned predecessor was not rejected by its independent pin: %v", err)
	}
}

func TestPublicationCommandBootstrapRequiresExplicitAbsentPredecessorPins(t *testing.T) {
	args, factory, clock, store := publicationCommandFixture(t)
	args[3], args[4] = args[1], args[2]
	args[1], args[2] = "-", "-"
	store.absent = true
	var output bytes.Buffer
	if err := run(context.Background(), args, &output, factory, clock); err != nil {
		t.Fatal(err)
	}
	var result authorizationResult
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.RepositorySHA256 != args[4] || result.PreviousRepositorySHA256 != "" ||
		result.Authorization.StateRevision != 0 || result.Authorization.Candidate.Timestamp.Version != 1 || store.writes != 0 {
		t.Fatalf("bootstrap command did not bind explicit absent predecessor pins: %+v", result)
	}
}

func TestPublicationCommandMaterializesOnlyStateAuthorizedPreparedTargets(t *testing.T) {
	args, factory, clock, store := publicationCommandFixture(t)
	base := filepath.Dir(args[0])
	pending := store.checkpoint.PendingSnapshot
	targetsPlan := repository.TargetsPlan{
		SchemaVersion: repository.SchemaVersion, Environment: "staging", RepositoryID: "hid-staging-v1", ReleaseID: releaseTwo,
		CreatedAt: clock().Format(time.RFC3339), RootVersion: 1, TargetsVersion: 2, TargetsExpires: clock().Add(90 * 24 * time.Hour).Format(time.RFC3339),
	}
	for _, entry := range []struct {
		path string
		data []byte
	}{
		{"environments/staging/channels/current.json", []byte(`{"channel":true}`)},
		{"environments/staging/releases/" + releaseTwo + "/release-bundle.json", []byte(`{"release":true}`)},
	} {
		targetsPlan.Targets = append(targetsPlan.Targets, repository.TargetInput{Path: entry.path,
			SourcePath: filepath.Join(args[3], "targets", filepath.Dir(entry.path), digest(entry.data)+"."+filepath.Base(entry.path)), Length: int64(len(entry.data)), SHA256: digest(entry.data)})
	}
	prepared, err := repository.PrepareTargets(targetsPlan, pending.Root.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	preparedDirectory := filepath.Join(base, "prepared")
	if _, err := repository.WritePreparedTargetsDirectory(preparedDirectory, prepared); err != nil {
		t.Fatal(err)
	}
	targetsPlanPath := filepath.Join(base, "targets-plan.json")
	data, _ := json.Marshal(targetsPlan)
	if err := os.WriteFile(targetsPlanPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	previous, err := repository.InspectPublicationGeneration(args[1], "staging", clock(), false)
	if err != nil {
		t.Fatal(err)
	}
	plan := repository.GenerationPlan{
		SchemaVersion: repository.SchemaVersion, Environment: "staging", RepositoryID: "hid-staging-v1", ReleaseID: releaseTwo, ReferenceTime: clock().Format(time.RFC3339),
		PreviousRepository: args[1], PreviousRepositorySHA256: previous.SHA256(), TargetsPlanPath: targetsPlanPath, PreparedTargetsDirectory: preparedDirectory,
		RootPath: filepath.Join(args[3], "metadata/1.root.json"), RootSHA256: pending.Root.SHA256, RootVersion: 1,
		TargetsMetadataPath: filepath.Join(args[3], "metadata/2.targets.json"), TargetsMetadataSHA256: pending.Targets.SHA256, TargetsVersion: 2,
		SnapshotMetadataPath: filepath.Join(args[3], "metadata/2.snapshot.json"), SnapshotMetadataSHA256: pending.Snapshot.SHA256, SnapshotVersion: 2,
		TimestampMetadataPath: filepath.Join(args[3], "metadata/timestamp.json"), TimestampMetadataSHA256: store.checkpoint.PendingTimestamp.Timestamp.SHA256, TimestampVersion: 2,
	}
	planPath := filepath.Join(base, "generation-plan.json")
	data, _ = json.Marshal(plan)
	if err := os.WriteFile(planPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	destination := filepath.Join(base, "materialized")
	if err := run(context.Background(), []string{"materialize", args[0], planPath, destination}, &output, factory, clock); err != nil {
		t.Fatal(err)
	}
	var result repository.GenerationResult
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.RepositorySHA256 != args[4] || result.Repository != destination || store.writes != 0 {
		t.Fatal("materialization command differs from authorized repository or wrote state")
	}
	store.checkpoint.PendingTimestamp = nil
	output.Reset()
	destination = filepath.Join(base, "must-not-materialize")
	if err := run(context.Background(), []string{"materialize", args[0], planPath, destination}, &output, factory, clock); err == nil || output.Len() != 0 {
		t.Fatal("unavailable pending timestamp authorized materialization")
	}
	if _, err := os.Stat(destination); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("failed materialization committed its destination")
	}
}
