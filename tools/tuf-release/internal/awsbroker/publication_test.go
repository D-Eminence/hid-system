package awsbroker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/s3/types"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/repository"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/signingbroker"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/testrepo"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func publicResponse(request *http.Request, data []byte, immutable bool) *http.Response {
	cache := "no-store"
	if immutable {
		cache = "public, max-age=31536000, immutable"
	}
	return &http.Response{
		StatusCode: http.StatusOK, Request: request, Body: io.NopCloser(bytes.NewReader(data)),
		ContentLength: int64(len(data)),
		Header: http.Header{
			"Content-Type":           []string{"application/json; charset=utf-8"},
			"Cache-Control":          []string{cache},
			"X-Content-Type-Options": []string{"nosniff"},
		},
	}
}

func TestPublicRepositoryFetchesOnlyFixedVersionedPaths(t *testing.T) {
	bodies := map[string][]byte{
		"/metadata/timestamp.json":  []byte(`{"timestamp":4}`),
		"/metadata/2.root.json":     []byte(`{"root":2}`),
		"/metadata/3.targets.json":  []byte(`{"targets":3}`),
		"/metadata/4.snapshot.json": []byte(`{"snapshot":4}`),
	}
	var paths []string
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		paths = append(paths, request.URL.Path)
		data, ok := bodies[request.URL.Path]
		if !ok {
			return nil, errors.New("unexpected path")
		}
		if request.Method != http.MethodGet || request.Header.Get("Accept-Encoding") != "identity" ||
			request.Header.Get("Accept") != "application/json" {
			t.Fatal("public fetch did not use the fixed GET/header contract")
		}
		return publicResponse(request, data, request.URL.Path != "/metadata/timestamp.json"), nil
	})
	source, err := NewPublicRepository(PublicRepositoryConfig{
		Environment: "staging", BaseURL: "https://updates.staging.healthidentitydirectory.com/",
	}, transport)
	if err != nil {
		t.Fatal(err)
	}
	published, err := source.FetchGeneration(context.Background(), GenerationVersions{Root: 2, Targets: 3, Snapshot: 4, Timestamp: 4}, stateTestRelease)
	if err != nil {
		t.Fatal(err)
	}
	if published.Environment != "staging" || published.ReleaseID != stateTestRelease ||
		!bytes.Equal(published.RootBytes, bodies["/metadata/2.root.json"]) ||
		!reflect.DeepEqual(paths, []string{"/metadata/timestamp.json", "/metadata/2.root.json", "/metadata/3.targets.json", "/metadata/4.snapshot.json"}) {
		t.Fatalf("unexpected public generation: %+v, paths=%v", published, paths)
	}
}

func TestPublicRepositoryRejectsRedirectsAndResponsePolicyDrift(t *testing.T) {
	newSource := func(t *testing.T, transport roundTripFunc) *PublicRepository {
		t.Helper()
		source, err := NewPublicRepository(PublicRepositoryConfig{
			Environment: "production", BaseURL: "https://updates.healthidentitydirectory.com/",
		}, transport)
		if err != nil {
			t.Fatal(err)
		}
		return source
	}
	versions := GenerationVersions{Root: 1, Targets: 1, Snapshot: 1, Timestamp: 1}

	t.Run("redirect", func(t *testing.T) {
		source := newSource(t, func(request *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusFound, Request: request, Body: io.NopCloser(strings.NewReader("redirect")),
				Header: http.Header{"Location": []string{"https://attacker.example/metadata/timestamp.json"}},
			}, nil
		})
		if _, err := source.FetchGeneration(context.Background(), versions, stateTestRelease); err == nil {
			t.Fatal("public repository redirect was accepted")
		}
	})

	for _, testCase := range []struct {
		name   string
		change func(*http.Response)
	}{
		{"status", func(response *http.Response) { response.StatusCode = http.StatusNotFound }},
		{"media type", func(response *http.Response) { response.Header.Set("Content-Type", "application/octet-stream") }},
		{"cache", func(response *http.Response) { response.Header.Set("Cache-Control", "public, max-age=60") }},
		{"content encoding", func(response *http.Response) { response.Header.Set("Content-Encoding", "gzip") }},
		{"length", func(response *http.Response) { response.ContentLength = repository.MaxTimestampMetadataBytes + 1 }},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			source := newSource(t, func(request *http.Request) (*http.Response, error) {
				response := publicResponse(request, []byte(`{"timestamp":1}`), false)
				testCase.change(response)
				return response, nil
			})
			if _, err := source.FetchGeneration(context.Background(), versions, stateTestRelease); err == nil {
				t.Fatal("public repository response policy drift was accepted")
			}
		})
	}
	if _, err := NewPublicRepository(PublicRepositoryConfig{
		Environment: "staging", BaseURL: "https://updates.healthidentitydirectory.com/",
	}, roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, nil })); err == nil {
		t.Fatal("cross-environment public repository origin was accepted")
	}
}

type memoryCheckpointStore struct {
	mu         sync.Mutex
	checkpoint *signingbroker.Checkpoint
	casCalls   int
}

func (store *memoryCheckpointStore) Load(_ context.Context, stateID string) (signingbroker.Checkpoint, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.checkpoint == nil || store.checkpoint.StateID != stateID {
		return signingbroker.Checkpoint{}, signingbroker.ErrStateNotFound
	}
	return cloneTestCheckpoint(*store.checkpoint), nil
}

func (store *memoryCheckpointStore) CompareAndSwap(_ context.Context, stateID string, expected int64, next signingbroker.Checkpoint) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.casCalls++
	if next.StateID != stateID || next.Revision != expected+1 ||
		expected == 0 && store.checkpoint != nil || expected > 0 && (store.checkpoint == nil || store.checkpoint.Revision != expected) {
		return signingbroker.ErrStateConflict
	}
	value := cloneTestCheckpoint(next)
	store.checkpoint = &value
	return nil
}

func cloneTestCheckpoint(input signingbroker.Checkpoint) signingbroker.Checkpoint {
	encoded, err := json.Marshal(input)
	if err != nil {
		panic(err)
	}
	var output signingbroker.Checkpoint
	if err := json.Unmarshal(encoded, &output); err != nil {
		panic(err)
	}
	return output
}

type generationSource struct {
	generation signingbroker.PublishedGeneration
	requests   []GenerationVersions
}

func (source *generationSource) FetchGeneration(_ context.Context, versions GenerationVersions, releaseID string) (signingbroker.PublishedGeneration, error) {
	source.requests = append(source.requests, versions)
	result := source.generation
	if releaseID != "" && releaseID != result.ReleaseID {
		return signingbroker.PublishedGeneration{}, errors.New("wrong release requested")
	}
	return result, nil
}

func TestCheckpointRunnerBootstrapsVerifiesAndAdvancesExactGeneration(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	repositoryFixture, initial := testrepo.NewHIDRepository(t, "staging", stateTestRelease, now)
	if _, err := repository.ValidateMetadataSet(repository.MetadataSet{
		Environment: initial.Environment, ReleaseID: initial.ReleaseID, ReferenceTime: now, RequireFresh: true,
		RootBytes: initial.RootBytes, TargetsBytes: initial.TargetsBytes,
		SnapshotBytes: initial.SnapshotBytes, TimestampBytes: initial.TimestampBytes,
	}); err != nil {
		t.Fatalf("invalid HID test fixture: %v", err)
	}
	store := &memoryCheckpointStore{}
	rootHash := digestHex(initial.RootBytes)
	controller, err := signingbroker.NewPublicationController(signingbroker.PublicationConfig{
		Environment: "staging", RepositoryID: "hid-staging-v1", StateID: "hid-staging-broker-v1",
		BootstrapRootSHA256: rootHash,
	}, store, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	s3Client := newFakeS3()
	stateConfig := stateTestConfig(now)
	stateConfig.BootstrapRootSHA256 = rootHash
	reader, err := NewImmutableObjectReader(ImmutableObjectReaderConfig{
		BucketName: stateConfig.BucketName, ExpectedBucketOwner: stateConfig.ExpectedBucketOwner,
		EncryptionKeyARN: stateConfig.EncryptionKeyARN, ObjectLockMode: stateConfig.ObjectLockMode,
		Clock: stateConfig.Clock,
	}, s3Client)
	if err != nil {
		t.Fatal(err)
	}
	bootstrapKey := "tuf-signing-broker/bootstrap/hid-staging-broker-v1/root.json"
	bootstrapVersion := "bootstrap-version-1"
	s3Client.objects[objectMapKey(bootstrapKey, bootstrapVersion)] = storedS3Object{
		data: initial.RootBytes, versionID: bootstrapVersion, contentType: "application/json",
		checksum: checksumBase64(initial.RootBytes),
		kmsKey:   stateConfig.EncryptionKeyARN, mode: types.ObjectLockRetentionModeCompliance,
		retainUntil: now.Add(365 * 24 * time.Hour),
		metadata: map[string]string{
			"hid-schema": BootstrapRootObjectSchema, "hid-state-id": "hid-staging-broker-v1", "hid-sha256": rootHash,
		},
	}
	source := &generationSource{generation: signingbroker.PublishedGeneration{
		Environment: initial.Environment, ReleaseID: initial.ReleaseID, RootBytes: initial.RootBytes,
		TargetsBytes: initial.TargetsBytes, SnapshotBytes: initial.SnapshotBytes, TimestampBytes: initial.TimestampBytes,
	}}
	runner, err := NewCheckpointRunner(CheckpointRunnerConfig{
		Environment: "staging", StateID: "hid-staging-broker-v1", BootstrapRootSHA256: rootHash,
		BootstrapRootObjectKey: bootstrapKey, BootstrapRootObjectVersionID: bootstrapVersion,
	}, controller, source, reader)
	if err != nil {
		t.Fatal(err)
	}
	result, err := runner.Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "bootstrapped" || result.Revision != 1 || result.ReleaseID != stateTestRelease || store.casCalls != 1 {
		t.Fatalf("unexpected bootstrap result: %+v", result)
	}
	result, err = runner.Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "verified" || result.Revision != 1 || store.casCalls != 1 {
		t.Fatalf("read-only verification mutated state: %+v", result)
	}

	nextRelease := "r0000000002-gbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	next := repositoryFixture.Advance(t, nextRelease)
	checkpoint := cloneTestCheckpoint(*store.checkpoint)
	checkpoint.Revision = 3
	checkpoint.SnapshotVersionHighWater = next.SnapshotVersion
	checkpoint.TimestampVersionHighWater = next.TimestampVersion
	checkpoint.PendingSnapshot = &signingbroker.PendingSnapshot{
		CandidateID: "one", RequestSHA256: strings.Repeat("a", 64), ReleaseID: next.ReleaseID,
		CreatedAt: now.Format(time.RFC3339), StateRevision: 2,
		Root:     signingbroker.NewMetadataRecord(next.RootVersion, next.RootBytes),
		Targets:  signingbroker.NewMetadataRecord(next.TargetsVersion, next.TargetsBytes),
		Snapshot: signingbroker.NewMetadataRecord(next.SnapshotVersion, next.SnapshotBytes),
	}
	checkpoint.PendingTimestamp = &signingbroker.PendingTimestamp{
		CandidateID: "one", RequestSHA256: strings.Repeat("b", 64), ReleaseID: next.ReleaseID,
		CreatedAt: now.Format(time.RFC3339), StateRevision: 3,
		Root:      signingbroker.NewMetadataRecord(next.RootVersion, next.RootBytes),
		Snapshot:  signingbroker.NewMetadataRecord(next.SnapshotVersion, next.SnapshotBytes),
		Timestamp: signingbroker.NewMetadataRecord(next.TimestampVersion, next.TimestampBytes),
	}
	store.checkpoint = &checkpoint
	source.generation = signingbroker.PublishedGeneration{
		Environment: next.Environment, ReleaseID: next.ReleaseID, RootBytes: next.RootBytes,
		TargetsBytes: next.TargetsBytes, SnapshotBytes: next.SnapshotBytes, TimestampBytes: next.TimestampBytes,
	}
	result, err = runner.Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "advanced" || result.Revision != 4 || result.ReleaseID != nextRelease ||
		store.checkpoint.PendingSnapshot != nil || store.checkpoint.PendingTimestamp != nil {
		t.Fatalf("pending exact generation was not advanced: %+v", result)
	}
}

func TestCheckpointRunnerRejectsPublicBootstrapRootSubstitution(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	_, initial := testrepo.NewHIDRepository(t, "staging", stateTestRelease, now)
	store := &memoryCheckpointStore{}
	rootHash := digestHex(initial.RootBytes)
	controller, err := signingbroker.NewPublicationController(signingbroker.PublicationConfig{
		Environment: "staging", RepositoryID: "hid-staging-v1", StateID: "hid-staging-broker-v1", BootstrapRootSHA256: rootHash,
	}, store, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	stateConfig := stateTestConfig(now)
	s3Client := newFakeS3()
	reader, _ := NewImmutableObjectReader(ImmutableObjectReaderConfig{
		BucketName: stateConfig.BucketName, ExpectedBucketOwner: stateConfig.ExpectedBucketOwner,
		EncryptionKeyARN: stateConfig.EncryptionKeyARN, ObjectLockMode: stateConfig.ObjectLockMode, Clock: stateConfig.Clock,
	}, s3Client)
	key, version := "tuf-signing-broker/bootstrap/hid-staging-broker-v1/root.json", "bootstrap-version-1"
	s3Client.objects[objectMapKey(key, version)] = storedS3Object{
		data: initial.RootBytes, versionID: version, contentType: "application/json", kmsKey: stateConfig.EncryptionKeyARN,
		checksum: checksumBase64(initial.RootBytes),
		mode:     types.ObjectLockRetentionModeCompliance, retainUntil: now.Add(time.Hour),
		metadata: map[string]string{"hid-schema": BootstrapRootObjectSchema, "hid-state-id": "hid-staging-broker-v1", "hid-sha256": rootHash},
	}
	substituted := initial
	substituted.RootBytes = append(bytes.Clone(initial.RootBytes), '\n')
	source := &generationSource{generation: signingbroker.PublishedGeneration{
		Environment: substituted.Environment, ReleaseID: substituted.ReleaseID, RootBytes: substituted.RootBytes,
		TargetsBytes: substituted.TargetsBytes, SnapshotBytes: substituted.SnapshotBytes, TimestampBytes: substituted.TimestampBytes,
	}}
	runner, err := NewCheckpointRunner(CheckpointRunnerConfig{
		Environment: "staging", StateID: "hid-staging-broker-v1", BootstrapRootSHA256: rootHash,
		BootstrapRootObjectKey: key, BootstrapRootObjectVersionID: version,
	}, controller, source, reader)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := runner.Check(context.Background()); err == nil || !strings.Contains(err.Error(), "differs") {
		t.Fatalf("substituted public bootstrap root was accepted: %v", err)
	}
	if store.checkpoint != nil || store.casCalls != 0 {
		t.Fatal("substituted bootstrap root created durable state")
	}
}
