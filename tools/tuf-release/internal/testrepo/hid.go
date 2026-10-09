package testrepo

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"testing"
	"time"

	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

// HIDGeneration is a complete disposable top-level metadata generation that
// satisfies the production policy shape. Its keys exist only in test memory.
type HIDGeneration struct {
	Environment      string
	ReleaseID        string
	RootBytes        []byte
	TargetsBytes     []byte
	SnapshotBytes    []byte
	TimestampBytes   []byte
	RootVersion      int64
	TargetsVersion   int64
	SnapshotVersion  int64
	TimestampVersion int64
}

// HIDRepository creates policy-shaped test metadata and can advance it. It is
// intentionally available only from the test helper package.
type HIDRepository struct {
	now         time.Time
	environment string
	releaseID   string
	root        *metadata.Metadata[metadata.RootType]
	rootBytes   []byte
	targets     *metadata.Metadata[metadata.TargetsType]
	snapshot    *metadata.Metadata[metadata.SnapshotType]
	timestamp   *metadata.Metadata[metadata.TimestampType]
	keys        map[string][]*ecdsa.PrivateKey
}

// RolePrivateKey returns one ephemeral test key. Callers must keep its use in
// tests; the package never serializes these keys.
func (repository *HIDRepository) RolePrivateKey(t testing.TB, role string, index int) *ecdsa.PrivateKey {
	t.Helper()
	keys := repository.keys[role]
	if index < 0 || index >= len(keys) {
		t.Fatalf("test role %s key index %d is unavailable", role, index)
	}
	return keys[index]
}

func NewHIDRepository(t testing.TB, environment, releaseID string, now time.Time) (*HIDRepository, HIDGeneration) {
	t.Helper()
	repository := &HIDRepository{
		now: now.UTC().Truncate(time.Second), environment: environment,
		root:      metadata.Root(now.UTC().Truncate(time.Second).Add(365 * 24 * time.Hour)),
		targets:   metadata.Targets(now.UTC().Truncate(time.Second).Add(90 * 24 * time.Hour)),
		snapshot:  metadata.Snapshot(now.UTC().Truncate(time.Second).Add(7 * 24 * time.Hour)),
		timestamp: metadata.Timestamp(now.UTC().Truncate(time.Second).Add(24 * time.Hour)),
		keys:      make(map[string][]*ecdsa.PrivateKey),
	}
	repository.root.Signed.ConsistentSnapshot = true
	for _, role := range []string{metadata.ROOT, metadata.TARGETS, metadata.SNAPSHOT, metadata.TIMESTAMP} {
		count := 2
		if role == metadata.ROOT || role == metadata.TARGETS {
			count = 3
		}
		for index := 0; index < count; index++ {
			key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			public, err := metadata.KeyFromPublicKey(key.Public())
			if err != nil {
				t.Fatal(err)
			}
			if err := repository.root.Signed.AddKey(public, role); err != nil {
				t.Fatal(err)
			}
			repository.keys[role] = append(repository.keys[role], key)
		}
	}
	repository.root.Signed.Roles[metadata.ROOT].Threshold = 2
	repository.root.Signed.Roles[metadata.TARGETS].Threshold = 2
	repository.setTargets(t, releaseID)
	generation := repository.signGeneration(t)
	return repository, generation
}

func (repository *HIDRepository) Advance(t testing.TB, releaseID string) HIDGeneration {
	t.Helper()
	repository.targets.Signed.Version++
	repository.snapshot.Signed.Version++
	repository.timestamp.Signed.Version++
	repository.targets.Signed.Expires = repository.now.Add(90 * 24 * time.Hour)
	repository.snapshot.Signed.Expires = repository.now.Add(7 * 24 * time.Hour)
	repository.timestamp.Signed.Expires = repository.now.Add(24 * time.Hour)
	repository.setTargets(t, releaseID)
	return repository.signGeneration(t)
}

func (repository *HIDRepository) setTargets(t testing.TB, releaseID string) {
	t.Helper()
	repository.releaseID = releaseID
	repository.targets.Signed.Targets = make(map[string]*metadata.TargetFiles)
	entries := []struct {
		path string
		data []byte
	}{
		{"environments/" + repository.environment + "/channels/current.json", []byte(`{"channel":true}`)},
		{TargetPath(repository.environment, releaseID, "release-bundle.json"), []byte(`{"release":true}`)},
	}
	for _, entry := range entries {
		descriptor, err := metadata.TargetFile().FromBytes(entry.path, entry.data, "sha256")
		if err != nil {
			t.Fatal(err)
		}
		repository.targets.Signed.Targets[entry.path] = descriptor
	}
}

func (repository *HIDRepository) signGeneration(t testing.TB) HIDGeneration {
	t.Helper()
	if repository.rootBytes == nil {
		repository.root.ClearSignatures()
		for _, key := range repository.keys[metadata.ROOT][:2] {
			mustSignHID(t, repository.root, key)
		}
		repository.rootBytes = mustHIDBytes(t, repository.root)
	}
	repository.targets.ClearSignatures()
	for _, key := range repository.keys[metadata.TARGETS][:2] {
		mustSignHID(t, repository.targets, key)
	}
	rootBytes := append([]byte(nil), repository.rootBytes...)
	targetsBytes := mustHIDBytes(t, repository.targets)
	repository.snapshot.Signed.Meta = map[string]*metadata.MetaFiles{
		"targets.json": hidMetaFile(repository.targets.Signed.Version, targetsBytes),
	}
	repository.snapshot.ClearSignatures()
	mustSignHID(t, repository.snapshot, repository.keys[metadata.SNAPSHOT][0])
	snapshotBytes := mustHIDBytes(t, repository.snapshot)
	repository.timestamp.Signed.Meta = map[string]*metadata.MetaFiles{
		"snapshot.json": hidMetaFile(repository.snapshot.Signed.Version, snapshotBytes),
	}
	repository.timestamp.ClearSignatures()
	mustSignHID(t, repository.timestamp, repository.keys[metadata.TIMESTAMP][0])
	return HIDGeneration{
		Environment: repository.environment, ReleaseID: repository.releaseID,
		RootBytes: rootBytes, TargetsBytes: targetsBytes, SnapshotBytes: snapshotBytes,
		TimestampBytes: mustHIDBytes(t, repository.timestamp), RootVersion: repository.root.Signed.Version,
		TargetsVersion: repository.targets.Signed.Version, SnapshotVersion: repository.snapshot.Signed.Version,
		TimestampVersion: repository.timestamp.Signed.Version,
	}
}

func mustSignHID[T metadata.Roles](t testing.TB, value *metadata.Metadata[T], key *ecdsa.PrivateKey) {
	t.Helper()
	signer, err := signature.LoadSigner(key, crypto.SHA256)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := value.Sign(signer); err != nil {
		t.Fatal(err)
	}
}

func mustHIDBytes[T metadata.Roles](t testing.TB, value *metadata.Metadata[T]) []byte {
	t.Helper()
	encoded, err := value.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func hidMetaFile(version int64, data []byte) *metadata.MetaFiles {
	digest := sha256.Sum256(data)
	return &metadata.MetaFiles{Version: version, Length: int64(len(data)), Hashes: metadata.Hashes{"sha256": metadata.HexBytes(digest[:])}}
}
