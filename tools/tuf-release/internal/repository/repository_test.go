package repository

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

const testReleaseID = "r0000000001-gaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

type testAuthority struct {
	now       time.Time
	root      *metadata.Metadata[metadata.RootType]
	rootBytes []byte
	keys      map[string][]*ecdsa.PrivateKey
}

func newTestAuthority(t *testing.T) *testAuthority {
	t.Helper()
	now := time.Date(2026, time.September, 1, 12, 0, 0, 0, time.UTC)
	root := metadata.Root(now.Add(365 * 24 * time.Hour))
	keys := make(map[string][]*ecdsa.PrivateKey, len(governedRootRoles))
	for _, roleName := range []string{metadata.ROOT, metadata.TARGETS, metadata.SNAPSHOT, metadata.TIMESTAMP} {
		policy := governedRootRoles[roleName]
		for range policy.keys {
			privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			publicKey, err := metadata.KeyFromPublicKey(privateKey.Public())
			if err != nil {
				t.Fatal(err)
			}
			if err := root.Signed.AddKey(publicKey, roleName); err != nil {
				t.Fatal(err)
			}
			keys[roleName] = append(keys[roleName], privateKey)
		}
		root.Signed.Roles[roleName].Threshold = policy.threshold
	}
	root.ClearSignatures()
	for _, privateKey := range keys[metadata.ROOT][:governedRootRoles[metadata.ROOT].threshold] {
		signMetadata(t, root, privateKey)
	}
	root.Signatures = sortedSignatures(root.Signatures)
	rootBytes, err := root.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
	return &testAuthority{now: now, root: root, rootBytes: rootBytes, keys: keys}
}

func (authority *testAuthority) plan(t *testing.T) TargetsPlan {
	t.Helper()
	directory := t.TempDir()
	inputs := []struct {
		logical string
		name    string
		data    []byte
	}{
		{
			logical: "environments/staging/channels/current.json",
			name:    "current.json",
			data:    []byte(`{"release_id":"` + testReleaseID + `"}`),
		},
		{
			logical: "environments/staging/releases/" + testReleaseID + "/release-bundle.json",
			name:    "release-bundle.json",
			data:    []byte(`{"schema_version":"1.0.0","release_id":"` + testReleaseID + `"}`),
		},
	}
	plan := TargetsPlan{
		SchemaVersion: SchemaVersion, Environment: "staging", RepositoryID: "hid-staging-v1",
		ReleaseID: testReleaseID, CreatedAt: authority.now.Format(time.RFC3339),
		RootVersion: authority.root.Signed.Version, TargetsVersion: 1,
		TargetsExpires: authority.now.Add(90 * 24 * time.Hour).Format(time.RFC3339),
	}
	for _, input := range inputs {
		sourcePath := filepath.Join(directory, input.name)
		if err := os.WriteFile(sourcePath, input.data, 0o600); err != nil {
			t.Fatal(err)
		}
		plan.Targets = append(plan.Targets, TargetInput{
			Path: input.logical, SourcePath: sourcePath, Length: int64(len(input.data)), SHA256: sha256Hex(input.data),
		})
	}
	return plan
}

func TestRepositoryMetadataPipeline(t *testing.T) {
	authority := newTestAuthority(t)
	plan := authority.plan(t)
	prepared, err := PrepareTargets(plan, authority.rootBytes)
	if err != nil {
		t.Fatal(err)
	}
	repeated, err := PrepareTargets(plan, authority.rootBytes)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(prepared.Payload, repeated.Payload) || prepared.PayloadSHA256 != repeated.PayloadSHA256 {
		t.Fatal("targets preparation was not deterministic")
	}

	evidence := []DetachedSignature{
		targetsEvidence(t, authority, prepared, authority.keys[metadata.TARGETS][0]),
		targetsEvidence(t, authority, prepared, authority.keys[metadata.TARGETS][1]),
	}
	targetsBytes, err := AssembleTargets(prepared, authority.rootBytes, []DetachedSignature{evidence[1], evidence[0]})
	if err != nil {
		t.Fatal(err)
	}
	orderedTargetsBytes, err := AssembleTargets(prepared, authority.rootBytes, evidence)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(targetsBytes, orderedTargetsBytes) {
		t.Fatal("detached signature input order changed assembled metadata")
	}

	snapshotBytes, err := BuildSnapshot(authority.rootBytes, targetsBytes, SnapshotOptions{
		Environment: "staging", RepositoryID: "hid-staging-v1", ReleaseID: testReleaseID,
		RootVersion: authority.root.Signed.Version, Version: 1, CreatedAt: authority.now,
		Expires: authority.now.Add(7 * 24 * time.Hour), ExpectedTargetsVersion: 1,
		ExpectedTargetsSHA256: sha256Hex(targetsBytes),
	}, loadSigner(t, authority.keys[metadata.SNAPSHOT][0]))
	if err != nil {
		t.Fatal(err)
	}
	timestampBytes, err := BuildTimestamp(authority.rootBytes, snapshotBytes, TimestampOptions{
		Environment: "staging", RepositoryID: "hid-staging-v1", ReleaseID: testReleaseID,
		RootVersion: authority.root.Signed.Version, Version: 1, CreatedAt: authority.now,
		Expires: authority.now.Add(24 * time.Hour), ExpectedSnapshotVersion: 1,
		ExpectedSnapshotSHA256: sha256Hex(snapshotBytes),
	}, loadSigner(t, authority.keys[metadata.TIMESTAMP][0]))
	if err != nil {
		t.Fatal(err)
	}

	timestamp, _, err := decodeTimestamp(timestampBytes)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, _, err := decodeSnapshot(snapshotBytes)
	if err != nil {
		t.Fatal(err)
	}
	targets, _, err := decodeTargets(targetsBytes)
	if err != nil {
		t.Fatal(err)
	}
	if err := authority.root.VerifyDelegate(metadata.TARGETS, targets); err != nil {
		t.Fatal(err)
	}
	if err := authority.root.VerifyDelegate(metadata.SNAPSHOT, snapshot); err != nil {
		t.Fatal(err)
	}
	if err := authority.root.VerifyDelegate(metadata.TIMESTAMP, timestamp); err != nil {
		t.Fatal(err)
	}
	if err := snapshot.Signed.Meta["targets.json"].VerifyLengthHashes(targetsBytes); err != nil {
		t.Fatal(err)
	}
	if err := timestamp.Signed.Meta["snapshot.json"].VerifyLengthHashes(snapshotBytes); err != nil {
		t.Fatal(err)
	}
}

func TestTargetsPreparationRejectsChangedAndUnsafeInputs(t *testing.T) {
	authority := newTestAuthority(t)
	plan := authority.plan(t)
	if err := os.WriteFile(plan.Targets[0].SourcePath, []byte("changed"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := PrepareTargets(plan, authority.rootBytes); err == nil {
		t.Fatal("changed target bytes were accepted")
	}

	plan = authority.plan(t)
	link := filepath.Join(t.TempDir(), "target-link")
	if err := os.Symlink(plan.Targets[0].SourcePath, link); err != nil {
		t.Fatal(err)
	}
	plan.Targets[0].SourcePath = link
	if _, err := PrepareTargets(plan, authority.rootBytes); err == nil {
		t.Fatal("symlink target source was accepted")
	}

	plan = authority.plan(t)
	realParent := filepath.Dir(plan.Targets[0].SourcePath)
	ancestorLink := filepath.Join(t.TempDir(), "source-parent-link")
	if err := os.Symlink(realParent, ancestorLink); err != nil {
		t.Fatal(err)
	}
	plan.Targets[0].SourcePath = filepath.Join(ancestorLink, filepath.Base(plan.Targets[0].SourcePath))
	if _, err := PrepareTargets(plan, authority.rootBytes); err == nil {
		t.Fatal("target source below a symlink ancestor was accepted")
	}

	plan = authority.plan(t)
	plan.Targets[0], plan.Targets[1] = plan.Targets[1], plan.Targets[0]
	if _, err := PrepareTargets(plan, authority.rootBytes); err == nil {
		t.Fatal("unsorted target plan was accepted")
	}
}

func TestPreparedTargetsDirectoryIsCreateOnlyAndRevalidated(t *testing.T) {
	authority := newTestAuthority(t)
	plan := authority.plan(t)
	prepared, err := PrepareTargets(plan, authority.rootBytes)
	if err != nil {
		t.Fatal(err)
	}
	parent := t.TempDir()
	directory := filepath.Join(parent, "offline-request")
	request, err := WritePreparedTargetsDirectory(directory, prepared)
	if err != nil {
		t.Fatal(err)
	}
	if request.RootSHA256 != sha256Hex(authority.rootBytes) || request.PayloadSHA256 != prepared.PayloadSHA256 {
		t.Fatal("signing request did not bind the exact root and payload")
	}
	loaded, err := LoadPreparedTargetsDirectory(directory, plan, authority.rootBytes)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(loaded.Payload, prepared.Payload) {
		t.Fatal("prepared payload changed during directory round trip")
	}
	if _, err := WritePreparedTargetsDirectory(directory, prepared); err == nil {
		t.Fatal("prepared output directory was replaced")
	}

	if err := os.WriteFile(filepath.Join(directory, PreparedTargetsPayloadName), []byte("changed"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadPreparedTargetsDirectory(directory, plan, authority.rootBytes); err == nil {
		t.Fatal("changed offline payload was accepted")
	}

	secondDirectory := filepath.Join(parent, "second-request")
	if _, err := WritePreparedTargetsDirectory(secondDirectory, prepared); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(plan.Targets[0].SourcePath, []byte("changed after preparation"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadPreparedTargetsDirectory(secondDirectory, plan, authority.rootBytes); err == nil {
		t.Fatal("changed target source was accepted after offline preparation")
	}
}

func TestTargetsEvidenceCeremonyHelpersNeverSignAndVerifyBothCustodianSignatures(t *testing.T) {
	authority := newTestAuthority(t)
	prepared, err := PrepareTargets(authority.plan(t), authority.rootBytes)
	if err != nil {
		t.Fatal(err)
	}
	privateKey := authority.keys[metadata.TARGETS][0]
	key, err := metadata.KeyFromPublicKey(privateKey.Public())
	if err != nil {
		t.Fatal(err)
	}
	keyID, err := key.ID()
	if err != nil {
		t.Fatal(err)
	}
	signer := loadSigner(t, privateKey)
	tufSignature, err := signer.SignMessage(bytes.NewReader(prepared.Payload))
	if err != nil {
		t.Fatal(err)
	}
	signedAt := authority.now.Format(time.RFC3339)
	draft, statement, err := PrepareTargetsEvidenceAttestation(
		prepared, authority.rootBytes, keyID, hex.EncodeToString(tufSignature), signedAt,
	)
	if err != nil {
		t.Fatal(err)
	}
	if draft.Attestation != "" || !bytes.Contains(statement, []byte(targetsEvidenceAttestationDomain)) {
		t.Fatal("attestation preparation did not return the exact unsigned ceremony statement")
	}
	attestation, err := signer.SignMessage(bytes.NewReader(statement))
	if err != nil {
		t.Fatal(err)
	}
	complete, err := CompleteTargetsEvidence(
		prepared, authority.rootBytes, keyID, draft.Signature, signedAt, hex.EncodeToString(attestation),
	)
	if err != nil {
		t.Fatal(err)
	}
	if complete.Attestation == "" || complete.Signature != draft.Signature {
		t.Fatal("completed evidence changed the TUF signature or omitted the attestation")
	}

	wrongSigner := loadSigner(t, authority.keys[metadata.TARGETS][1])
	wrongTUFSignature, err := wrongSigner.SignMessage(bytes.NewReader(prepared.Payload))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := PrepareTargetsEvidenceAttestation(
		prepared, authority.rootBytes, keyID, hex.EncodeToString(wrongTUFSignature), signedAt,
	); err == nil {
		t.Fatal("TUF signature from a different custodian was accepted by ceremony preparation")
	}
	wrongAttestation, err := wrongSigner.SignMessage(bytes.NewReader(statement))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := CompleteTargetsEvidence(
		prepared, authority.rootBytes, keyID, draft.Signature, signedAt, hex.EncodeToString(wrongAttestation),
	); err == nil {
		t.Fatal("attestation from a different custodian was accepted by ceremony completion")
	}
}

func TestGenerationMaterializationIsAtomicAndSupportsTimestampRefresh(t *testing.T) {
	authority := newTestAuthority(t)
	plan := authority.plan(t)
	prepared, targetsBytes, snapshotBytes, timestampBytes := buildTestGenerationMetadata(t, authority, plan, 1, 1, authority.now)
	parent := t.TempDir()
	initialDirectory := filepath.Join(parent, "generation-1")
	initial, err := MaterializeGeneration(GenerationInput{
		DestinationDirectory: initialDirectory, ReferenceTime: authority.now, Prepared: prepared,
		ExpectedRootVersion: 1, ExpectedTargetsVersion: 1, ExpectedSnapshotVersion: 1, ExpectedTimestampVersion: 1,
		RootBytes: authority.rootBytes, TargetsBytes: targetsBytes, SnapshotBytes: snapshotBytes, TimestampBytes: timestampBytes,
	})
	if err != nil {
		t.Fatal(err)
	}
	if initial.FileCount != 6 || initial.RootVersion != 1 || initial.TargetsVersion != 1 ||
		initial.SnapshotVersion != 1 || initial.TimestampVersion != 1 || !sha256Pattern.MatchString(initial.RepositorySHA256) {
		t.Fatalf("unexpected initial generation result: %+v", initial)
	}
	if _, err := os.Stat(filepath.Join(initialDirectory, "metadata", "1.root.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := MaterializeGeneration(GenerationInput{
		DestinationDirectory: initialDirectory, ReferenceTime: authority.now, Prepared: prepared,
		ExpectedRootVersion: 1, ExpectedTargetsVersion: 1, ExpectedSnapshotVersion: 1, ExpectedTimestampVersion: 1,
		RootBytes: authority.rootBytes, TargetsBytes: targetsBytes, SnapshotBytes: snapshotBytes, TimestampBytes: timestampBytes,
	}); err == nil {
		t.Fatal("existing repository generation was replaced")
	}

	refreshTime := authority.now.Add(time.Hour)
	timestamp2, err := BuildTimestamp(authority.rootBytes, snapshotBytes, TimestampOptions{
		Environment: "staging", RepositoryID: "hid-staging-v1", ReleaseID: testReleaseID,
		RootVersion: 1, Version: 2, CreatedAt: refreshTime, Expires: refreshTime.Add(24 * time.Hour),
		ExpectedSnapshotVersion: 1, ExpectedSnapshotSHA256: sha256Hex(snapshotBytes),
	}, loadSigner(t, authority.keys[metadata.TIMESTAMP][1]))
	if err != nil {
		t.Fatal(err)
	}
	secondDirectory := filepath.Join(parent, "generation-2")
	second, err := MaterializeGeneration(GenerationInput{
		PreviousDirectory: initialDirectory, PreviousRepositorySHA256: initial.RepositorySHA256, DestinationDirectory: secondDirectory,
		ReferenceTime: refreshTime, Prepared: prepared, RootBytes: authority.rootBytes,
		ExpectedRootVersion: 1, ExpectedTargetsVersion: 1, ExpectedSnapshotVersion: 1, ExpectedTimestampVersion: 2,
		TargetsBytes: targetsBytes, SnapshotBytes: snapshotBytes, TimestampBytes: timestamp2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if second.TimestampVersion != 2 || second.FileCount != initial.FileCount || second.RepositorySHA256 == initial.RepositorySHA256 {
		t.Fatalf("unexpected refreshed generation result: %+v", second)
	}
	originalTimestamp, err := os.ReadFile(filepath.Join(initialDirectory, "metadata", "timestamp.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(originalTimestamp, timestampBytes) {
		t.Fatal("successor materialization mutated the previous generation")
	}
}

func TestGenerationMaterializationRejectsOnlineVersionGapsWithoutBrokerEvidence(t *testing.T) {
	for _, test := range []struct {
		name             string
		snapshotVersion  int64
		timestampVersion int64
		message          string
	}{
		{"snapshot", 3, 2, "snapshot version must remain exact or advance by one"},
		{"timestamp", 1, 3, "timestamp version must advance exactly one version"},
	} {
		t.Run(test.name, func(t *testing.T) {
			destination, err := materializationGapAttempt(t, test.snapshotVersion, test.timestampVersion)
			if err == nil || !strings.Contains(err.Error(), test.message) {
				t.Fatalf("unproven online-role version gap was accepted: %v", err)
			}
			if _, statErr := os.Lstat(destination); !errors.Is(statErr, os.ErrNotExist) {
				t.Fatal("rejected version-gap materialization left a destination generation")
			}
		})
	}
}

func TestMetadataSetValidatesCompleteCheckpointAndPermitsExpiryRecovery(t *testing.T) {
	authority := newTestAuthority(t)
	plan := authority.plan(t)
	_, targetsBytes, snapshotBytes, timestampBytes := buildTestGenerationMetadata(t, authority, plan, 1, 1, authority.now)
	input := MetadataSet{
		Environment: "staging", ReleaseID: testReleaseID, ReferenceTime: authority.now, RequireFresh: true,
		RootBytes: authority.rootBytes, TargetsBytes: targetsBytes, SnapshotBytes: snapshotBytes, TimestampBytes: timestampBytes,
	}
	state, err := ValidateMetadataSet(input)
	if err != nil {
		t.Fatal(err)
	}
	if state.RootVersion != 1 || state.TargetsVersion != 1 || state.SnapshotVersion != 1 || state.TimestampVersion != 1 ||
		state.RootSHA256 != sha256Hex(authority.rootBytes) || state.TargetsSHA256 != sha256Hex(targetsBytes) ||
		state.SnapshotSHA256 != sha256Hex(snapshotBytes) || state.TimestampSHA256 != sha256Hex(timestampBytes) {
		t.Fatalf("metadata-set state was not derived from its exact bytes: %+v", state)
	}

	expired := input
	expired.ReferenceTime = authority.now.Add(25 * time.Hour)
	if _, err := ValidateMetadataSet(expired); err == nil {
		t.Fatal("fresh checkpoint validation accepted an expired timestamp")
	}
	expired.RequireFresh = false
	if _, err := ValidateMetadataSet(expired); err != nil {
		t.Fatalf("structural checkpoint validation prevented expiry recovery: %v", err)
	}

	wrongRelease := input
	wrongRelease.ReleaseID = "r0000000002-g" + strings.Repeat("b", 40)
	if _, err := ValidateMetadataSet(wrongRelease); err == nil {
		t.Fatal("metadata set accepted a release identity absent from targets")
	}
	tampered := input
	tampered.SnapshotBytes = bytes.Clone(snapshotBytes)
	tampered.SnapshotBytes[len(tampered.SnapshotBytes)-2] ^= 1
	if _, err := ValidateMetadataSet(tampered); err == nil {
		t.Fatal("metadata set accepted changed snapshot bytes")
	}
}

func TestGenerationMaterializationRejectsChangedSourcesAndVersionRollback(t *testing.T) {
	authority := newTestAuthority(t)
	plan := authority.plan(t)
	prepared, targetsBytes, snapshotBytes, timestampBytes := buildTestGenerationMetadata(t, authority, plan, 1, 1, authority.now)
	parent := t.TempDir()
	changedDestination := filepath.Join(parent, "changed-source")
	if err := os.WriteFile(plan.Targets[1].SourcePath, []byte("changed after signatures"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := MaterializeGeneration(GenerationInput{
		DestinationDirectory: changedDestination, ReferenceTime: authority.now, Prepared: prepared,
		ExpectedRootVersion: 1, ExpectedTargetsVersion: 1, ExpectedSnapshotVersion: 1, ExpectedTimestampVersion: 1,
		RootBytes: authority.rootBytes, TargetsBytes: targetsBytes, SnapshotBytes: snapshotBytes, TimestampBytes: timestampBytes,
	}); err == nil {
		t.Fatal("changed target source was materialized")
	}
	if _, err := os.Lstat(changedDestination); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("failed materialization left a destination directory")
	}

	plan = authority.plan(t)
	prepared, targetsBytes, snapshotBytes, timestampBytes = buildTestGenerationMetadata(t, authority, plan, 1, 1, authority.now)
	initialDirectory := filepath.Join(parent, "valid-initial")
	initial, err := MaterializeGeneration(GenerationInput{
		DestinationDirectory: initialDirectory, ReferenceTime: authority.now, Prepared: prepared,
		ExpectedRootVersion: 1, ExpectedTargetsVersion: 1, ExpectedSnapshotVersion: 1, ExpectedTimestampVersion: 1,
		RootBytes: authority.rootBytes, TargetsBytes: targetsBytes, SnapshotBytes: snapshotBytes, TimestampBytes: timestampBytes,
	})
	if err != nil {
		t.Fatal(err)
	}
	rollbackDestination := filepath.Join(parent, "timestamp-rollback")
	if _, err := MaterializeGeneration(GenerationInput{
		PreviousDirectory: initialDirectory, PreviousRepositorySHA256: initial.RepositorySHA256, DestinationDirectory: rollbackDestination,
		ReferenceTime: authority.now, Prepared: prepared, RootBytes: authority.rootBytes,
		ExpectedRootVersion: 1, ExpectedTargetsVersion: 1, ExpectedSnapshotVersion: 1, ExpectedTimestampVersion: 1,
		TargetsBytes: targetsBytes, SnapshotBytes: snapshotBytes, TimestampBytes: timestampBytes,
	}); err == nil {
		t.Fatal("same-version timestamp refresh was accepted")
	}

	tamperedSnapshot := bytes.Clone(snapshotBytes)
	tamperedSnapshot[len(tamperedSnapshot)-1] ^= 1
	if _, err := MaterializeGeneration(GenerationInput{
		DestinationDirectory: filepath.Join(parent, "tampered-snapshot"), ReferenceTime: authority.now,
		ExpectedRootVersion: 1, ExpectedTargetsVersion: 1, ExpectedSnapshotVersion: 1, ExpectedTimestampVersion: 1,
		Prepared: prepared, RootBytes: authority.rootBytes, TargetsBytes: targetsBytes,
		SnapshotBytes: tamperedSnapshot, TimestampBytes: timestampBytes,
	}); err == nil {
		t.Fatal("tampered snapshot was materialized")
	}
}

func TestGenerationMaterializationBindsDecodedVersionsAndRequiresPinnedPredecessor(t *testing.T) {
	authority := newTestAuthority(t)
	plan := authority.plan(t)
	prepared, targetsBytes, snapshotBytes, timestampBytes := buildTestGenerationMetadata(t, authority, plan, 1, 1, authority.now)
	base := GenerationInput{
		ReferenceTime: authority.now, Prepared: prepared,
		ExpectedRootVersion: 1, ExpectedTargetsVersion: 1, ExpectedSnapshotVersion: 1, ExpectedTimestampVersion: 1,
		RootBytes: authority.rootBytes, TargetsBytes: targetsBytes, SnapshotBytes: snapshotBytes, TimestampBytes: timestampBytes,
	}
	mutations := []struct {
		name   string
		mutate func(*GenerationInput)
	}{
		{"root", func(input *GenerationInput) { input.ExpectedRootVersion = 2 }},
		{"targets", func(input *GenerationInput) { input.ExpectedTargetsVersion = 2 }},
		{"snapshot", func(input *GenerationInput) { input.ExpectedSnapshotVersion = 2 }},
		{"timestamp", func(input *GenerationInput) { input.ExpectedTimestampVersion = 2 }},
	}
	for _, test := range mutations {
		t.Run(test.name, func(t *testing.T) {
			input := base
			input.DestinationDirectory = filepath.Join(t.TempDir(), "generation")
			test.mutate(&input)
			if _, err := MaterializeGeneration(input); err == nil || !strings.Contains(err.Error(), "versions do not match") {
				t.Fatalf("decoded %s version was not bound to its plan value: %v", test.name, err)
			}
		})
	}

	prepared2, targetsBytes2, snapshotBytes2, timestamp2 := buildTestGenerationMetadata(t, authority, plan, 1, 2, authority.now)
	nonGenesis := base
	nonGenesis.DestinationDirectory = filepath.Join(t.TempDir(), "generation")
	nonGenesis.ExpectedTimestampVersion = 2
	nonGenesis.Prepared = prepared2
	nonGenesis.TargetsBytes = targetsBytes2
	nonGenesis.SnapshotBytes = snapshotBytes2
	nonGenesis.TimestampBytes = timestamp2
	if _, err := MaterializeGeneration(nonGenesis); err == nil || !strings.Contains(err.Error(), "pinned previous repository") {
		t.Fatalf("non-genesis generation without a predecessor was accepted: %v", err)
	}
}

func TestGenerationMaterializationFullyValidatesPinnedPredecessor(t *testing.T) {
	for _, attack := range []struct {
		name   string
		mutate func(*testing.T, string)
	}{
		{
			name: "invalid timestamp signature",
			mutate: func(t *testing.T, repositoryDirectory string) {
				path := filepath.Join(repositoryDirectory, "metadata", "timestamp.json")
				data, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				var envelope map[string]any
				if err := json.Unmarshal(data, &envelope); err != nil {
					t.Fatal(err)
				}
				signatures := envelope["signatures"].([]any)
				signatures[0].(map[string]any)["sig"] = "00"
				changed, err := json.Marshal(envelope)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, changed, 0o600); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "unreferenced target",
			mutate: func(t *testing.T, repositoryDirectory string) {
				data := []byte("orphaned target")
				path := filepath.Join(
					repositoryDirectory, "targets", "environments", "staging", "releases", testReleaseID,
					sha256Hex(data)+".orphan.bin",
				)
				if err := os.WriteFile(path, data, 0o600); err != nil {
					t.Fatal(err)
				}
			},
		},
	} {
		t.Run(attack.name, func(t *testing.T) {
			authority := newTestAuthority(t)
			plan := authority.plan(t)
			prepared, targetsBytes, snapshotBytes, timestampBytes := buildTestGenerationMetadata(t, authority, plan, 1, 1, authority.now)
			previousDirectory := filepath.Join(t.TempDir(), "generation-1")
			initial, err := MaterializeGeneration(GenerationInput{
				DestinationDirectory: previousDirectory, ReferenceTime: authority.now, Prepared: prepared,
				ExpectedRootVersion: 1, ExpectedTargetsVersion: 1, ExpectedSnapshotVersion: 1, ExpectedTimestampVersion: 1,
				RootBytes: authority.rootBytes, TargetsBytes: targetsBytes, SnapshotBytes: snapshotBytes, TimestampBytes: timestampBytes,
			})
			if err != nil {
				t.Fatal(err)
			}
			attack.mutate(t, previousDirectory)
			_, repinnedSHA256, err := hashGenerationDirectory(previousDirectory)
			if err != nil {
				t.Fatal(err)
			}
			if repinnedSHA256 == initial.RepositorySHA256 {
				t.Fatal("predecessor attack did not change its repository hash")
			}

			refreshTime := authority.now.Add(time.Hour)
			timestamp2, err := BuildTimestamp(authority.rootBytes, snapshotBytes, TimestampOptions{
				Environment: "staging", RepositoryID: "hid-staging-v1", ReleaseID: testReleaseID,
				RootVersion: 1, Version: 2, CreatedAt: refreshTime, Expires: refreshTime.Add(24 * time.Hour),
				ExpectedSnapshotVersion: 1, ExpectedSnapshotSHA256: sha256Hex(snapshotBytes),
			}, loadSigner(t, authority.keys[metadata.TIMESTAMP][0]))
			if err != nil {
				t.Fatal(err)
			}
			destination := filepath.Join(t.TempDir(), "generation-2")
			_, err = MaterializeGeneration(GenerationInput{
				PreviousDirectory: previousDirectory, PreviousRepositorySHA256: repinnedSHA256,
				DestinationDirectory: destination, ReferenceTime: refreshTime, Prepared: prepared,
				ExpectedRootVersion: 1, ExpectedTargetsVersion: 1, ExpectedSnapshotVersion: 1, ExpectedTimestampVersion: 2,
				RootBytes: authority.rootBytes, TargetsBytes: targetsBytes, SnapshotBytes: snapshotBytes, TimestampBytes: timestamp2,
			})
			if err == nil {
				t.Fatal("fully re-pinned but invalid previous repository was accepted")
			}
			if _, statErr := os.Lstat(destination); !errors.Is(statErr, os.ErrNotExist) {
				t.Fatal("rejected predecessor left a destination generation")
			}
		})
	}
}

func TestMaterializedGenerationPassesCloudflareValidator(t *testing.T) {
	node, validator := cloudflareValidator(t)

	authority := newTestAuthority(t)
	plan := authority.plan(t)
	prepared, targetsBytes, snapshotBytes, timestampBytes := buildTestGenerationMetadata(t, authority, plan, 1, 1, authority.now)
	destination := filepath.Join(t.TempDir(), "cross-validated-generation")
	result, err := MaterializeGeneration(GenerationInput{
		DestinationDirectory: destination, ReferenceTime: authority.now, Prepared: prepared,
		ExpectedRootVersion: 1, ExpectedTargetsVersion: 1, ExpectedSnapshotVersion: 1, ExpectedTimestampVersion: 1,
		RootBytes: authority.rootBytes, TargetsBytes: targetsBytes, SnapshotBytes: snapshotBytes, TimestampBytes: timestampBytes,
	})
	if err != nil {
		t.Fatal(err)
	}
	assertCloudflareGeneration(t, node, validator, destination, authority.now, result)
}

func TestTargetsAssemblyRejectsContextAndSignatureAttacks(t *testing.T) {
	authority := newTestAuthority(t)
	prepared, err := PrepareTargets(authority.plan(t), authority.rootBytes)
	if err != nil {
		t.Fatal(err)
	}
	first := targetsEvidence(t, authority, prepared, authority.keys[metadata.TARGETS][0])
	second := targetsEvidence(t, authority, prepared, authority.keys[metadata.TARGETS][1])
	valid := []DetachedSignature{first, second}

	t.Run("one signature", func(t *testing.T) {
		if _, err := AssembleTargets(prepared, authority.rootBytes, valid[:1]); err == nil {
			t.Fatal("one targets signature was accepted")
		}
	})
	t.Run("duplicate signature", func(t *testing.T) {
		if _, err := AssembleTargets(prepared, authority.rootBytes, []DetachedSignature{first, first}); err == nil {
			t.Fatal("duplicate targets signature was accepted")
		}
	})
	t.Run("unauthorized key", func(t *testing.T) {
		attacker := targetsEvidence(t, authority, prepared, authority.keys[metadata.ROOT][0])
		if _, err := AssembleTargets(prepared, authority.rootBytes, []DetachedSignature{first, attacker}); err == nil {
			t.Fatal("unauthorized targets signature was accepted")
		}
	})
	t.Run("wrong signer under authorized ID", func(t *testing.T) {
		forged := targetsEvidence(t, authority, prepared, authority.keys[metadata.TARGETS][2])
		forged.KeyID = second.KeyID
		if _, err := AssembleTargets(prepared, authority.rootBytes, []DetachedSignature{first, forged}); err == nil {
			t.Fatal("wrong-key signature was accepted")
		}
	})
	t.Run("changed payload", func(t *testing.T) {
		changed := clonePrepared(prepared)
		changed.Payload[len(changed.Payload)-1] ^= 1
		if _, err := AssembleTargets(changed, authority.rootBytes, valid); err == nil {
			t.Fatal("changed targets payload was accepted")
		}
	})
	t.Run("changed plan", func(t *testing.T) {
		changed := clonePrepared(prepared)
		changed.Plan.RepositoryID = "different-repository"
		if _, err := AssembleTargets(changed, authority.rootBytes, valid); err == nil {
			t.Fatal("changed prepared context was accepted")
		}
	})
	t.Run("attestation binds synchronized context", func(t *testing.T) {
		changedPrepared := clonePrepared(prepared)
		changedPrepared.Plan.RepositoryID = "different-repository"
		changedFirst, changedSecond := first, second
		changedFirst.RepositoryID = changedPrepared.Plan.RepositoryID
		changedSecond.RepositoryID = changedPrepared.Plan.RepositoryID
		if _, err := AssembleTargets(changedPrepared, authority.rootBytes, []DetachedSignature{changedFirst, changedSecond}); err == nil {
			t.Fatal("context changed consistently outside the custodian attestations was accepted")
		}
	})
	t.Run("attestation binds request-only context", func(t *testing.T) {
		requestPlan := authority.plan(t)
		requestPlan.TargetsExpires = authority.now.Add(89 * 24 * time.Hour).Format(time.RFC3339)
		requestPrepared, err := PrepareTargets(requestPlan, authority.rootBytes)
		if err != nil {
			t.Fatal(err)
		}
		requestEvidence := []DetachedSignature{
			targetsEvidence(t, authority, requestPrepared, authority.keys[metadata.TARGETS][0]),
			targetsEvidence(t, authority, requestPrepared, authority.keys[metadata.TARGETS][1]),
		}
		for index, privateKey := range authority.keys[metadata.TARGETS][:2] {
			requestEvidence[index].SignedAt = authority.now.Add(time.Minute).Format(time.RFC3339)
			requestEvidence[index].Attestation = targetsEvidenceAttestation(t, requestPrepared, requestEvidence[index], privateKey)
		}
		if _, err := AssembleTargets(requestPrepared, authority.rootBytes, requestEvidence); err != nil {
			t.Fatal(err)
		}
		changedPrepared := clonePrepared(requestPrepared)
		changedPrepared.Plan.CreatedAt = authority.now.Add(30 * time.Second).Format(time.RFC3339)
		if _, err := AssembleTargets(changedPrepared, authority.rootBytes, requestEvidence); err == nil {
			t.Fatal("created_at omitted from detached fields was not bound by the full request attestation")
		}
	})
	t.Run("wrong evidence context", func(t *testing.T) {
		mutations := []func(*DetachedSignature){
			func(value *DetachedSignature) { value.SchemaVersion = "2.0.0" },
			func(value *DetachedSignature) { value.Environment = "production" },
			func(value *DetachedSignature) { value.RepositoryID = "other-repository" },
			func(value *DetachedSignature) { value.ReleaseID = "r0000000002-g" + strings.Repeat("b", 40) },
			func(value *DetachedSignature) { value.RootVersion++ },
			func(value *DetachedSignature) { value.RootSHA256 = strings.Repeat("0", 64) },
			func(value *DetachedSignature) { value.TargetsVersion++ },
			func(value *DetachedSignature) { value.PayloadSHA256 = strings.Repeat("0", 64) },
			func(value *DetachedSignature) { value.SignedAt = authority.now.Add(time.Second).Format(time.RFC3339) },
		}
		for index, mutate := range mutations {
			changed := second
			mutate(&changed)
			if _, err := AssembleTargets(prepared, authority.rootBytes, []DetachedSignature{first, changed}); err == nil {
				t.Fatalf("evidence context mutation %d was accepted", index)
			}
		}
	})
	t.Run("changed TUF signature", func(t *testing.T) {
		resigned := targetsEvidence(t, authority, prepared, authority.keys[metadata.TARGETS][1])
		if resigned.Signature == second.Signature {
			t.Fatal("test signer unexpectedly repeated its ECDSA signature")
		}
		changed := second
		changed.Signature = resigned.Signature
		if _, err := AssembleTargets(prepared, authority.rootBytes, []DetachedSignature{first, changed}); err == nil {
			t.Fatal("changed valid TUF signature without a matching attestation was accepted")
		}
	})
	t.Run("changed attestation", func(t *testing.T) {
		resigned := targetsEvidence(t, authority, prepared, authority.keys[metadata.TARGETS][1])
		changed := second
		changed.Attestation = resigned.Attestation
		if _, err := AssembleTargets(prepared, authority.rootBytes, []DetachedSignature{first, changed}); err == nil {
			t.Fatal("attestation for a different TUF signature was accepted")
		}
	})
	t.Run("different attestation custodian", func(t *testing.T) {
		changed := second
		changed.Attestation = targetsEvidenceAttestation(t, prepared, changed, authority.keys[metadata.TARGETS][2])
		if _, err := AssembleTargets(prepared, authority.rootBytes, []DetachedSignature{first, changed}); err == nil {
			t.Fatal("attestation from a different authorized targets custodian was accepted")
		}
	})
	t.Run("TUF signature is not an attestation", func(t *testing.T) {
		changed := second
		changed.Attestation = changed.Signature
		if _, err := AssembleTargets(prepared, authority.rootBytes, []DetachedSignature{first, changed}); err == nil {
			t.Fatal("domain-foreign TUF signature was accepted as an evidence attestation")
		}
	})
	t.Run("noncanonical signature", func(t *testing.T) {
		changed := second
		changed.Signature = "00"
		if _, err := AssembleTargets(prepared, authority.rootBytes, []DetachedSignature{first, changed}); err == nil {
			t.Fatal("noncanonical DER signature was accepted")
		}
	})
	t.Run("noncanonical attestation", func(t *testing.T) {
		changed := second
		changed.Attestation = "00"
		if _, err := AssembleTargets(prepared, authority.rootBytes, []DetachedSignature{first, changed}); err == nil {
			t.Fatal("noncanonical DER attestation was accepted")
		}
	})
}

func TestOnlineRolesRejectMixAndUnauthorizedSigning(t *testing.T) {
	authority := newTestAuthority(t)
	prepared, err := PrepareTargets(authority.plan(t), authority.rootBytes)
	if err != nil {
		t.Fatal(err)
	}
	evidence := []DetachedSignature{
		targetsEvidence(t, authority, prepared, authority.keys[metadata.TARGETS][0]),
		targetsEvidence(t, authority, prepared, authority.keys[metadata.TARGETS][1]),
	}
	targetsBytes, err := AssembleTargets(prepared, authority.rootBytes, evidence)
	if err != nil {
		t.Fatal(err)
	}
	snapshotOptions := SnapshotOptions{
		Environment: "staging", RepositoryID: "hid-staging-v1", ReleaseID: testReleaseID,
		RootVersion: 1, Version: 1, CreatedAt: authority.now, Expires: authority.now.Add(7 * 24 * time.Hour),
		ExpectedTargetsVersion: 1, ExpectedTargetsSHA256: sha256Hex(targetsBytes),
	}
	unsafeVersion := snapshotOptions
	unsafeVersion.Version = maxSafeInteger + 1
	unsafeSigner := &trackingSigner{inner: loadSigner(t, authority.keys[metadata.SNAPSHOT][0])}
	if _, err := BuildSnapshot(authority.rootBytes, targetsBytes, unsafeVersion, unsafeSigner); err == nil {
		t.Fatal("non-JSON-safe snapshot output version was accepted")
	}
	if unsafeSigner.signCalls != 0 {
		t.Fatal("unsafe snapshot version reached the signer")
	}
	unsafeInputVersion := snapshotOptions
	unsafeInputVersion.ExpectedTargetsVersion = maxSafeInteger + 1
	if _, err := BuildSnapshot(authority.rootBytes, targetsBytes, unsafeInputVersion, unsafeSigner); err == nil {
		t.Fatal("non-JSON-safe snapshot input version was accepted")
	}
	if unsafeSigner.signCalls != 0 {
		t.Fatal("unsafe snapshot input version reached the signer")
	}

	unauthorized := &trackingSigner{inner: loadSigner(t, authority.keys[metadata.TARGETS][0])}
	if _, err := BuildSnapshot(authority.rootBytes, targetsBytes, snapshotOptions, unauthorized); err == nil {
		t.Fatal("unauthorized snapshot signer was accepted")
	}
	if unauthorized.signCalls != 0 {
		t.Fatal("unauthorized signer was invoked before authorization failed")
	}

	tamperedTargets := bytes.Clone(targetsBytes)
	tamperedTargets[len(tamperedTargets)-1] ^= 1
	if _, err := BuildSnapshot(authority.rootBytes, tamperedTargets, snapshotOptions, loadSigner(t, authority.keys[metadata.SNAPSHOT][0])); err == nil {
		t.Fatal("tampered targets metadata was accepted")
	}
	shortSnapshot := snapshotOptions
	shortSnapshot.Expires = authority.now.Add(71 * time.Hour)
	if _, err := BuildSnapshot(authority.rootBytes, targetsBytes, shortSnapshot, loadSigner(t, authority.keys[metadata.SNAPSHOT][0])); err == nil {
		t.Fatal("short-lived snapshot was accepted")
	}

	snapshotBytes, err := BuildSnapshot(authority.rootBytes, targetsBytes, snapshotOptions, loadSigner(t, authority.keys[metadata.SNAPSHOT][0]))
	if err != nil {
		t.Fatal(err)
	}
	timestampOptions := TimestampOptions{
		Environment: "staging", RepositoryID: "hid-staging-v1", ReleaseID: testReleaseID,
		RootVersion: 1, Version: 1, CreatedAt: authority.now, Expires: authority.now.Add(24 * time.Hour),
		ExpectedSnapshotVersion: 1, ExpectedSnapshotSHA256: sha256Hex(snapshotBytes),
	}
	unauthorized = &trackingSigner{inner: loadSigner(t, authority.keys[metadata.SNAPSHOT][0])}
	if _, err := BuildTimestamp(authority.rootBytes, snapshotBytes, timestampOptions, unauthorized); err == nil {
		t.Fatal("unauthorized timestamp signer was accepted")
	}
	if unauthorized.signCalls != 0 {
		t.Fatal("unauthorized timestamp signer was invoked")
	}
	tamperedSnapshot := bytes.Clone(snapshotBytes)
	tamperedSnapshot[0] ^= 1
	if _, err := BuildTimestamp(authority.rootBytes, tamperedSnapshot, timestampOptions, loadSigner(t, authority.keys[metadata.TIMESTAMP][0])); err == nil {
		t.Fatal("tampered snapshot metadata was accepted")
	}
}

func TestRootPolicyAndSequentialRotation(t *testing.T) {
	authority := newTestAuthority(t)
	if _, err := ValidateRoot(authority.rootBytes, authority.now); err != nil {
		t.Fatal(err)
	}

	wrongThreshold := cloneRoot(t, authority.rootBytes)
	wrongThreshold.Signed.Roles[metadata.TARGETS].Threshold = 1
	if _, err := ValidateRoot(rootBytes(t, wrongThreshold), authority.now); err == nil {
		t.Fatal("wrong targets threshold was accepted")
	}
	reusedKey := cloneRoot(t, authority.rootBytes)
	reusedKey.Signed.Roles[metadata.SNAPSHOT].KeyIDs[0] = reusedKey.Signed.Roles[metadata.TARGETS].KeyIDs[0]
	if _, err := ValidateRoot(rootBytes(t, reusedKey), authority.now); err == nil {
		t.Fatal("cross-role key reuse was accepted")
	}
	shortRoot := cloneRoot(t, authority.rootBytes)
	shortRoot.Signed.Expires = authority.now.Add(29 * 24 * time.Hour)
	resignRoot(t, shortRoot, authority.keys[metadata.ROOT])
	if _, err := ValidateRoot(rootBytes(t, shortRoot), authority.now); err == nil {
		t.Fatal("root below minimum publication freshness was accepted")
	}

	next := cloneRoot(t, authority.rootBytes)
	next.Signed.Version = 2
	oldTimestampID := next.Signed.Roles[metadata.TIMESTAMP].KeyIDs[0]
	if err := next.Signed.RevokeKey(oldTimestampID, metadata.TIMESTAMP); err != nil {
		t.Fatal(err)
	}
	newTimestampKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	newTimestampPublic, err := metadata.KeyFromPublicKey(newTimestampKey.Public())
	if err != nil {
		t.Fatal(err)
	}
	if err := next.Signed.AddKey(newTimestampPublic, metadata.TIMESTAMP); err != nil {
		t.Fatal(err)
	}
	resignRoot(t, next, authority.keys[metadata.ROOT])
	nextBytes := rootBytes(t, next)
	if err := ValidateRootChain(authority.rootBytes, nextBytes, authority.now); err != nil {
		t.Fatal(err)
	}
	skipped := cloneRoot(t, nextBytes)
	skipped.Signed.Version = 4
	resignRoot(t, skipped, authority.keys[metadata.ROOT])
	if err := ValidateRootChain(authority.rootBytes, rootBytes(t, skipped), authority.now); err == nil {
		t.Fatal("skipped root version was accepted")
	}
	unsafe := cloneRoot(t, authority.rootBytes)
	unsafe.Signed.Version = maxSafeInteger + 1
	resignRoot(t, unsafe, authority.keys[metadata.ROOT])
	if _, err := ValidateRoot(rootBytes(t, unsafe), authority.now); err == nil {
		t.Fatal("root version outside the cross-language safe integer range was accepted")
	}
}

func TestStrictPlanSignatureAndMetadataLoading(t *testing.T) {
	authority := newTestAuthority(t)
	plan := authority.plan(t)
	planBytes, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	planPath := filepath.Join(t.TempDir(), "targets-plan.json")
	if err := os.WriteFile(planPath, planBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadTargetsPlan(planPath); err != nil {
		t.Fatal(err)
	}
	unsafePlan := plan
	unsafePlan.TargetsVersion = maxSafeInteger + 1
	if _, err := validateTargetsPlan(unsafePlan); err == nil {
		t.Fatal("targets plan version outside the cross-language safe integer range was accepted")
	}
	duplicatePlan := bytes.Replace(planBytes, []byte(`{"schema_version":`), []byte(`{"schema_version":"1.0.0","schema_version":`), 1)
	if err := os.WriteFile(planPath, duplicatePlan, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadTargetsPlan(planPath); err == nil {
		t.Fatal("duplicate plan member was accepted")
	}
	linkPath := filepath.Join(t.TempDir(), "plan-link.json")
	if err := os.Symlink(planPath, linkPath); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadTargetsPlan(linkPath); err == nil {
		t.Fatal("symlink plan was accepted")
	}

	plan = authority.plan(t)
	prepared, err := PrepareTargets(plan, authority.rootBytes)
	if err != nil {
		t.Fatal(err)
	}
	evidence := targetsEvidence(t, authority, prepared, authority.keys[metadata.TARGETS][0])
	evidenceBytes, err := json.Marshal(evidence)
	if err != nil {
		t.Fatal(err)
	}
	evidencePath := filepath.Join(t.TempDir(), "signature.json")
	if err := os.WriteFile(evidencePath, evidenceBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	loadedEvidence, err := LoadDetachedSignature(evidencePath)
	if err != nil || !reflect.DeepEqual(loadedEvidence, evidence) {
		t.Fatalf("load complete detached evidence: %v", err)
	}
	var evidenceObject map[string]any
	if err := json.Unmarshal(evidenceBytes, &evidenceObject); err != nil {
		t.Fatal(err)
	}
	delete(evidenceObject, "attestation")
	missingAttestation, err := json.Marshal(evidenceObject)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(evidencePath, missingAttestation, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadDetachedSignature(evidencePath); err == nil {
		t.Fatal("detached signature without its custodian attestation was accepted")
	}
	unknownEvidence := bytes.Replace(evidenceBytes, []byte(`{"schema_version":`), []byte(`{"unexpected":true,"schema_version":`), 1)
	if err := os.WriteFile(evidencePath, unknownEvidence, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadDetachedSignature(evidencePath); err == nil {
		t.Fatal("unknown signature-evidence member was accepted")
	}

	upperEnvelope := bytes.Replace(authority.rootBytes, []byte(`"signed":`), []byte(`"SIGNED":`), 1)
	if _, err := ValidateRoot(upperEnvelope, authority.now); err == nil {
		t.Fatal("case-confused root member was accepted")
	}
}

func TestOnlineSigningPlanIsExactAndRoleBound(t *testing.T) {
	authority := newTestAuthority(t)
	plan := OnlineSigningPlan{
		SchemaVersion: SchemaVersion, Role: "snapshot", Environment: "staging",
		RepositoryID: "hid-staging-v1", ReleaseID: testReleaseID,
		CreatedAt: authority.now.Format(time.RFC3339), Expires: authority.now.Add(7 * 24 * time.Hour).Format(time.RFC3339),
		RootPath: "/private/hid-tuf/1.root.json", RootSHA256: strings.Repeat("a", 64), RootVersion: 1,
		InputMetadataPath: "/private/hid-tuf/1.targets.json", InputMetadataSHA256: strings.Repeat("b", 64),
		InputMetadataVersion: 1, OutputMetadataVersion: 1,
		AWSRegion: "us-east-1", AWSAccountID: "123456789012",
		KMSKeyARN:               "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789abc",
		KMSPublicKeyDERChecksum: strings.Repeat("c", 64),
	}
	if _, err := ValidateOnlineSigningPlan(plan, "snapshot"); err != nil {
		t.Fatal(err)
	}
	makeSuccessor := func(value *OnlineSigningPlan) {
		value.OutputMetadataVersion = 2
		value.PreviousMetadataPath = "/private/hid-tuf/1.snapshot.json"
		value.PreviousMetadataSHA256 = strings.Repeat("d", 64)
		value.PreviousRootPath = value.RootPath
		value.PreviousRootSHA256 = value.RootSHA256
	}
	successor := plan
	makeSuccessor(&successor)
	if _, err := ValidateOnlineSigningPlan(successor, "snapshot"); err != nil {
		t.Fatalf("valid successor plan was rejected: %v", err)
	}

	mutations := []func(*OnlineSigningPlan){
		func(value *OnlineSigningPlan) { value.Role = "timestamp" },
		func(value *OnlineSigningPlan) { value.Environment = "production"; value.ReleaseID = testReleaseID },
		func(value *OnlineSigningPlan) { value.Expires = authority.now.Add(71 * time.Hour).Format(time.RFC3339) },
		func(value *OnlineSigningPlan) { value.RootPath = "relative/root.json" },
		func(value *OnlineSigningPlan) { value.InputMetadataPath = value.RootPath },
		func(value *OnlineSigningPlan) { value.AWSAccountID = "123" },
		func(value *OnlineSigningPlan) {
			value.KMSKeyARN = "arn:aws:kms:us-west-2:123456789012:key/12345678-1234-1234-1234-123456789abc"
		},
		func(value *OnlineSigningPlan) { value.KMSKeyARN = "arn:aws:kms:us-east-1:123456789012:alias/snapshot" },
		func(value *OnlineSigningPlan) { value.RootSHA256 = strings.Repeat("A", 64) },
		func(value *OnlineSigningPlan) { value.OutputMetadataVersion = 0 },
		func(value *OnlineSigningPlan) { value.InputMetadataVersion = 2 },
		func(value *OnlineSigningPlan) { value.RootVersion = maxSafeInteger + 1 },
		func(value *OnlineSigningPlan) { value.InputMetadataVersion = maxSafeInteger + 1 },
		func(value *OnlineSigningPlan) { value.OutputMetadataVersion = maxSafeInteger + 1 },
		func(value *OnlineSigningPlan) { value.OutputMetadataVersion = 2 },
		func(value *OnlineSigningPlan) {
			value.PreviousMetadataPath = "/private/hid-tuf/1.snapshot.json"
			value.PreviousMetadataSHA256 = strings.Repeat("d", 64)
			value.PreviousRootPath = value.RootPath
			value.PreviousRootSHA256 = value.RootSHA256
		},
		func(value *OnlineSigningPlan) {
			makeSuccessor(value)
			value.PreviousMetadataPath = value.InputMetadataPath
		},
		func(value *OnlineSigningPlan) {
			makeSuccessor(value)
			value.PreviousRootPath = value.InputMetadataPath
		},
		func(value *OnlineSigningPlan) {
			makeSuccessor(value)
			value.PreviousRootSHA256 = strings.Repeat("e", 64)
		},
	}
	for index, mutate := range mutations {
		changed := plan
		mutate(&changed)
		if _, err := ValidateOnlineSigningPlan(changed, "snapshot"); err == nil {
			t.Fatalf("online signing plan mutation %d was accepted", index)
		}
	}

	planBytes, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	planPath := filepath.Join(t.TempDir(), "snapshot-signing-plan.json")
	if err := os.WriteFile(planPath, planBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOnlineSigningPlan(planPath, "snapshot"); err != nil {
		t.Fatal(err)
	}
	caseConfused := bytes.Replace(planBytes, []byte(`"role":`), []byte(`"ROLE":`), 1)
	if err := os.WriteFile(planPath, caseConfused, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOnlineSigningPlan(planPath, "snapshot"); err == nil {
		t.Fatal("case-confused online signing plan was accepted")
	}
}

func TestOnlineSigningPlanWallClockFreshnessIsExplicit(t *testing.T) {
	authority := newTestAuthority(t)
	plan := OnlineSigningPlan{
		SchemaVersion: SchemaVersion, Role: "snapshot", Environment: "staging",
		RepositoryID: "hid-staging-v1", ReleaseID: testReleaseID,
		RootPath: "/private/hid-tuf/1.root.json", RootSHA256: strings.Repeat("a", 64), RootVersion: 1,
		InputMetadataPath: "/private/hid-tuf/1.targets.json", InputMetadataSHA256: strings.Repeat("b", 64),
		InputMetadataVersion: 1, OutputMetadataVersion: 1,
		AWSRegion: "us-east-1", AWSAccountID: "123456789012",
		KMSKeyARN:               "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789abc",
		KMSPublicKeyDERChecksum: strings.Repeat("c", 64),
	}
	setCreatedAt := func(value time.Time) OnlineSigningPlan {
		changed := plan
		changed.CreatedAt = value.Format(time.RFC3339)
		changed.Expires = value.Add(7 * 24 * time.Hour).Format(time.RFC3339)
		return changed
	}
	for _, createdAt := range []time.Time{authority.now.Add(-5 * time.Minute), authority.now.Add(time.Minute)} {
		if _, err := ValidateOnlineSigningPlanAt(setCreatedAt(createdAt), "snapshot", authority.now); err != nil {
			t.Fatalf("boundary created_at %s was rejected: %v", createdAt, err)
		}
	}
	for _, createdAt := range []time.Time{
		authority.now.Add(-5*time.Minute - time.Second),
		authority.now.Add(time.Minute + time.Second),
	} {
		if _, err := ValidateOnlineSigningPlanAt(setCreatedAt(createdAt), "snapshot", authority.now); err == nil {
			t.Fatalf("out-of-window created_at %s was accepted", createdAt)
		}
	}
	if _, err := ValidateOnlineSigningPlanAt(setCreatedAt(authority.now), "snapshot", time.Time{}); err == nil {
		t.Fatal("zero wall clock was accepted")
	}
	if _, err := ValidateOnlineSigningPlan(setCreatedAt(authority.now.Add(-time.Hour)), "snapshot"); err != nil {
		t.Fatalf("deterministic structural validation consulted wall clock: %v", err)
	}
}

func TestOnlineSigningInputsBindVersionsPredecessorsAndRootHistory(t *testing.T) {
	authority := newTestAuthority(t)
	targetsPlan := authority.plan(t)
	_, targetsBytes, snapshotBytes, timestampBytes := buildTestGenerationMetadata(t, authority, targetsPlan, 1, 1, authority.now)

	snapshotPlan := OnlineSigningPlan{
		SchemaVersion: SchemaVersion, Role: "snapshot", Environment: targetsPlan.Environment,
		RepositoryID: targetsPlan.RepositoryID, ReleaseID: targetsPlan.ReleaseID,
		CreatedAt: authority.now.Format(time.RFC3339), Expires: authority.now.Add(7 * 24 * time.Hour).Format(time.RFC3339),
		RootPath: "/private/hid-tuf/1.root.json", RootSHA256: sha256Hex(authority.rootBytes), RootVersion: 1,
		InputMetadataPath: "/private/hid-tuf/1.targets.json", InputMetadataSHA256: sha256Hex(targetsBytes),
		InputMetadataVersion: 1, OutputMetadataVersion: 1,
		AWSRegion: "us-east-1", AWSAccountID: "123456789012",
		KMSKeyARN:               "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789abc",
		KMSPublicKeyDERChecksum: strings.Repeat("c", 64),
	}
	if err := ValidateOnlineSigningInputs(snapshotPlan, authority.rootBytes, targetsBytes, nil, nil); err != nil {
		t.Fatalf("valid genesis snapshot inputs were rejected: %v", err)
	}

	snapshotSuccessor := snapshotPlan
	snapshotSuccessor.OutputMetadataVersion = 2
	snapshotSuccessor.PreviousMetadataPath = "/private/hid-tuf/1.snapshot.json"
	snapshotSuccessor.PreviousMetadataSHA256 = sha256Hex(snapshotBytes)
	snapshotSuccessor.PreviousRootPath = snapshotSuccessor.RootPath
	snapshotSuccessor.PreviousRootSHA256 = snapshotSuccessor.RootSHA256
	if err := ValidateOnlineSigningInputs(snapshotSuccessor, authority.rootBytes, targetsBytes, snapshotBytes, authority.rootBytes); err != nil {
		t.Fatalf("valid snapshot successor inputs were rejected: %v", err)
	}

	wrongInputVersion := snapshotSuccessor
	wrongInputVersion.InputMetadataVersion = 2
	if err := ValidateOnlineSigningInputs(wrongInputVersion, authority.rootBytes, targetsBytes, snapshotBytes, authority.rootBytes); err == nil {
		t.Fatal("snapshot plan input version did not have to match its metadata bytes")
	}
	skippedOutputVersion := snapshotSuccessor
	skippedOutputVersion.OutputMetadataVersion = 3
	if err := ValidateOnlineSigningInputs(skippedOutputVersion, authority.rootBytes, targetsBytes, snapshotBytes, authority.rootBytes); err == nil {
		t.Fatal("snapshot plan skipped its predecessor version")
	}
	wrongPreviousRole := snapshotSuccessor
	wrongPreviousRole.PreviousMetadataPath = "/private/hid-tuf/timestamp.json"
	wrongPreviousRole.PreviousMetadataSHA256 = sha256Hex(timestampBytes)
	if err := ValidateOnlineSigningInputs(wrongPreviousRole, authority.rootBytes, targetsBytes, timestampBytes, authority.rootBytes); err == nil {
		t.Fatal("timestamp metadata was accepted as a snapshot predecessor")
	}
	tamperedPreviousPin := snapshotSuccessor
	tamperedPreviousPin.PreviousMetadataSHA256 = strings.Repeat("0", 64)
	if err := ValidateOnlineSigningInputs(tamperedPreviousPin, authority.rootBytes, targetsBytes, snapshotBytes, authority.rootBytes); err == nil {
		t.Fatal("snapshot predecessor SHA-256 mismatch was accepted")
	}

	_, alternateTargetsBytes, _, _ := buildTestGenerationMetadata(t, authority, targetsPlan, 1, 1, authority.now)
	if bytes.Equal(alternateTargetsBytes, targetsBytes) {
		t.Fatal("test setup did not produce distinct signed targets bytes")
	}
	sameTargetsVersionDifferentBytes := snapshotSuccessor
	sameTargetsVersionDifferentBytes.InputMetadataSHA256 = sha256Hex(alternateTargetsBytes)
	if err := ValidateOnlineSigningInputs(
		sameTargetsVersionDifferentBytes, authority.rootBytes, alternateTargetsBytes, snapshotBytes, authority.rootBytes,
	); err == nil {
		t.Fatal("same-version targets bytes differing from the previous snapshot reference were accepted")
	}
	targetsPlan2 := authority.plan(t)
	targetsPlan2.TargetsVersion = 2
	_, targetsBytes2, snapshotOverTargets2, _ := buildTestGenerationMetadata(t, authority, targetsPlan2, 1, 1, authority.now)
	nextTargetsInput := snapshotSuccessor
	nextTargetsInput.InputMetadataPath = "/private/hid-tuf/2.targets.json"
	nextTargetsInput.InputMetadataSHA256 = sha256Hex(targetsBytes2)
	nextTargetsInput.InputMetadataVersion = 2
	if err := ValidateOnlineSigningInputs(nextTargetsInput, authority.rootBytes, targetsBytes2, snapshotBytes, authority.rootBytes); err != nil {
		t.Fatalf("one-version targets input advance was rejected: %v", err)
	}
	rolledBackTargetsInput := snapshotSuccessor
	rolledBackTargetsInput.PreviousMetadataSHA256 = sha256Hex(snapshotOverTargets2)
	if err := ValidateOnlineSigningInputs(
		rolledBackTargetsInput, authority.rootBytes, targetsBytes, snapshotOverTargets2, authority.rootBytes,
	); err == nil {
		t.Fatal("targets input rollback from the previous snapshot reference was accepted")
	}
	targetsPlan3 := authority.plan(t)
	targetsPlan3.TargetsVersion = 3
	_, targetsBytes3, _, _ := buildTestGenerationMetadata(t, authority, targetsPlan3, 1, 1, authority.now)
	jumpedTargetsInput := snapshotSuccessor
	jumpedTargetsInput.InputMetadataPath = "/private/hid-tuf/3.targets.json"
	jumpedTargetsInput.InputMetadataSHA256 = sha256Hex(targetsBytes3)
	jumpedTargetsInput.InputMetadataVersion = 3
	if err := ValidateOnlineSigningInputs(jumpedTargetsInput, authority.rootBytes, targetsBytes3, snapshotBytes, authority.rootBytes); err == nil {
		t.Fatal("targets input version jump from the previous snapshot reference was accepted")
	}

	timestampSuccessor := snapshotPlan
	timestampSuccessor.Role = "timestamp"
	timestampSuccessor.Expires = authority.now.Add(24 * time.Hour).Format(time.RFC3339)
	timestampSuccessor.InputMetadataPath = "/private/hid-tuf/1.snapshot.json"
	timestampSuccessor.InputMetadataSHA256 = sha256Hex(snapshotBytes)
	timestampSuccessor.OutputMetadataVersion = 2
	timestampSuccessor.PreviousMetadataPath = "/private/hid-tuf/timestamp.json"
	timestampSuccessor.PreviousMetadataSHA256 = sha256Hex(timestampBytes)
	timestampSuccessor.PreviousRootPath = timestampSuccessor.RootPath
	timestampSuccessor.PreviousRootSHA256 = timestampSuccessor.RootSHA256
	if err := ValidateOnlineSigningInputs(timestampSuccessor, authority.rootBytes, snapshotBytes, timestampBytes, authority.rootBytes); err != nil {
		t.Fatalf("valid timestamp successor inputs were rejected: %v", err)
	}
	skippedTimestampOutput := timestampSuccessor
	skippedTimestampOutput.OutputMetadataVersion = 3
	if err := ValidateOnlineSigningInputs(
		skippedTimestampOutput, authority.rootBytes, snapshotBytes, timestampBytes, authority.rootBytes,
	); err == nil {
		t.Fatal("direct timestamp plan skipped its predecessor version")
	}
	buildSnapshotVersion := func(version int64) []byte {
		t.Helper()
		result, err := BuildSnapshot(authority.rootBytes, targetsBytes, SnapshotOptions{
			Environment: targetsPlan.Environment, RepositoryID: targetsPlan.RepositoryID, ReleaseID: targetsPlan.ReleaseID,
			RootVersion: 1, Version: version, CreatedAt: authority.now, Expires: authority.now.Add(7 * 24 * time.Hour),
			ExpectedTargetsVersion: 1, ExpectedTargetsSHA256: sha256Hex(targetsBytes),
		}, loadSigner(t, authority.keys[metadata.SNAPSHOT][0]))
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	alternateSnapshotBytes := buildSnapshotVersion(1)
	if bytes.Equal(alternateSnapshotBytes, snapshotBytes) {
		t.Fatal("test setup did not produce distinct signed snapshot bytes")
	}
	sameSnapshotVersionDifferentBytes := timestampSuccessor
	sameSnapshotVersionDifferentBytes.InputMetadataSHA256 = sha256Hex(alternateSnapshotBytes)
	if err := ValidateOnlineSigningInputs(
		sameSnapshotVersionDifferentBytes, authority.rootBytes, alternateSnapshotBytes, timestampBytes, authority.rootBytes,
	); err == nil {
		t.Fatal("same-version snapshot bytes differing from the previous timestamp reference were accepted")
	}
	snapshotBytes2 := buildSnapshotVersion(2)
	nextSnapshotInput := timestampSuccessor
	nextSnapshotInput.InputMetadataPath = "/private/hid-tuf/2.snapshot.json"
	nextSnapshotInput.InputMetadataSHA256 = sha256Hex(snapshotBytes2)
	nextSnapshotInput.InputMetadataVersion = 2
	if err := ValidateOnlineSigningInputs(nextSnapshotInput, authority.rootBytes, snapshotBytes2, timestampBytes, authority.rootBytes); err != nil {
		t.Fatalf("one-version snapshot input advance was rejected: %v", err)
	}
	timestampOverSnapshot2, err := BuildTimestamp(authority.rootBytes, snapshotBytes2, TimestampOptions{
		Environment: targetsPlan.Environment, RepositoryID: targetsPlan.RepositoryID, ReleaseID: targetsPlan.ReleaseID,
		RootVersion: 1, Version: 1, CreatedAt: authority.now, Expires: authority.now.Add(24 * time.Hour),
		ExpectedSnapshotVersion: 2, ExpectedSnapshotSHA256: sha256Hex(snapshotBytes2),
	}, loadSigner(t, authority.keys[metadata.TIMESTAMP][0]))
	if err != nil {
		t.Fatal(err)
	}
	rolledBackSnapshotInput := timestampSuccessor
	rolledBackSnapshotInput.PreviousMetadataSHA256 = sha256Hex(timestampOverSnapshot2)
	if err := ValidateOnlineSigningInputs(
		rolledBackSnapshotInput, authority.rootBytes, snapshotBytes, timestampOverSnapshot2, authority.rootBytes,
	); err == nil {
		t.Fatal("snapshot input rollback from the previous timestamp reference was accepted")
	}
	snapshotBytes3 := buildSnapshotVersion(3)
	jumpedSnapshotInput := timestampSuccessor
	jumpedSnapshotInput.InputMetadataPath = "/private/hid-tuf/3.snapshot.json"
	jumpedSnapshotInput.InputMetadataSHA256 = sha256Hex(snapshotBytes3)
	jumpedSnapshotInput.InputMetadataVersion = 3
	if err := ValidateOnlineSigningInputs(jumpedSnapshotInput, authority.rootBytes, snapshotBytes3, timestampBytes, authority.rootBytes); err == nil {
		t.Fatal("snapshot input version jump from the previous timestamp reference was accepted")
	}

	rotatedRoot := cloneRoot(t, authority.rootBytes)
	rotatedRoot.Signed.Version = 2
	oldSnapshotKeyID := rotatedRoot.Signed.Roles[metadata.SNAPSHOT].KeyIDs[0]
	if err := rotatedRoot.Signed.RevokeKey(oldSnapshotKeyID, metadata.SNAPSHOT); err != nil {
		t.Fatal(err)
	}
	newSnapshotKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	newSnapshotPublic, err := metadata.KeyFromPublicKey(newSnapshotKey.Public())
	if err != nil {
		t.Fatal(err)
	}
	if err := rotatedRoot.Signed.AddKey(newSnapshotPublic, metadata.SNAPSHOT); err != nil {
		t.Fatal(err)
	}
	resignRoot(t, rotatedRoot, authority.keys[metadata.ROOT])
	rotatedRootBytes := rootBytes(t, rotatedRoot)
	rotatedSuccessor := snapshotSuccessor
	rotatedSuccessor.RootPath = "/private/hid-tuf/2.root.json"
	rotatedSuccessor.RootSHA256 = sha256Hex(rotatedRootBytes)
	rotatedSuccessor.RootVersion = 2
	rotatedSuccessor.PreviousRootPath = "/private/hid-tuf/1.root.json"
	rotatedSuccessor.PreviousRootSHA256 = sha256Hex(authority.rootBytes)
	if err := ValidateOnlineSigningInputs(rotatedSuccessor, rotatedRootBytes, targetsBytes, snapshotBytes, authority.rootBytes); err != nil {
		t.Fatalf("authenticated root rotation with an old-key predecessor was rejected: %v", err)
	}

	unrelatedPreviousAuthority := newTestAuthority(t)
	badRootHistory := rotatedSuccessor
	badRootHistory.PreviousRootSHA256 = sha256Hex(unrelatedPreviousAuthority.rootBytes)
	if err := ValidateOnlineSigningInputs(
		badRootHistory, rotatedRootBytes, targetsBytes, snapshotBytes, unrelatedPreviousAuthority.rootBytes,
	); err == nil {
		t.Fatal("unrelated previous root was accepted as online root history")
	}
}

func TestGenerationPlanIsExactAndContextBound(t *testing.T) {
	plan := GenerationPlan{
		SchemaVersion: SchemaVersion, Environment: "staging", RepositoryID: "hid-staging-v1", ReleaseID: testReleaseID,
		ReferenceTime: "2026-09-01T12:00:00Z", PreviousRepository: "",
		TargetsPlanPath: "/private/hid-tuf/targets-plan.json", PreparedTargetsDirectory: "/private/hid-tuf/offline-request",
		RootPath: "/private/hid-tuf/1.root.json", RootSHA256: strings.Repeat("a", 64), RootVersion: 1,
		TargetsMetadataPath: "/private/hid-tuf/1.targets.json", TargetsMetadataSHA256: strings.Repeat("b", 64), TargetsVersion: 1,
		SnapshotMetadataPath: "/private/hid-tuf/1.snapshot.json", SnapshotMetadataSHA256: strings.Repeat("c", 64), SnapshotVersion: 1,
		TimestampMetadataPath: "/private/hid-tuf/timestamp.json", TimestampMetadataSHA256: strings.Repeat("d", 64), TimestampVersion: 1,
	}
	if _, err := ValidateGenerationPlan(plan); err != nil {
		t.Fatal(err)
	}
	mutations := []func(*GenerationPlan){
		func(value *GenerationPlan) { value.Environment = "production" },
		func(value *GenerationPlan) { value.RepositoryID = "hid-production-v1" },
		func(value *GenerationPlan) { value.ReferenceTime = "2026-09-01T12:00:00.1Z" },
		func(value *GenerationPlan) { value.RootPath = "/private/hid-tuf/root.json" },
		func(value *GenerationPlan) { value.TargetsMetadataPath = value.RootPath },
		func(value *GenerationPlan) { value.SnapshotMetadataSHA256 = strings.Repeat("A", 64) },
		func(value *GenerationPlan) { value.TimestampVersion = 0 },
		func(value *GenerationPlan) { value.RootVersion = maxSafeInteger + 1 },
		func(value *GenerationPlan) { value.PreviousRepositorySHA256 = strings.Repeat("e", 64) },
		func(value *GenerationPlan) { value.TimestampVersion = 2 },
		func(value *GenerationPlan) { value.PreviousRepository = "relative/repository" },
	}
	for index, mutate := range mutations {
		changed := plan
		mutate(&changed)
		if _, err := ValidateGenerationPlan(changed); err == nil {
			t.Fatalf("generation plan mutation %d was accepted", index)
		}
	}
	successor := plan
	successor.TimestampVersion = 2
	successor.PreviousRepository = "/private/hid-tuf/generation-1"
	successor.PreviousRepositorySHA256 = strings.Repeat("e", 64)
	if _, err := ValidateGenerationPlan(successor); err != nil {
		t.Fatalf("valid pinned successor plan was rejected: %v", err)
	}
	successor.PreviousRepositorySHA256 = strings.Repeat("E", 64)
	if _, err := ValidateGenerationPlan(successor); err == nil {
		t.Fatal("successor plan with a noncanonical predecessor SHA-256 was accepted")
	}

	encoded, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	filePath := filepath.Join(t.TempDir(), "generation-plan.json")
	if err := os.WriteFile(filePath, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadGenerationPlan(filePath); err != nil {
		t.Fatal(err)
	}
	duplicate := bytes.Replace(encoded, []byte(`{"schema_version":`), []byte(`{"schema_version":"1.0.0","schema_version":`), 1)
	if err := os.WriteFile(filePath, duplicate, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadGenerationPlan(filePath); err == nil {
		t.Fatal("duplicate generation-plan member was accepted")
	}
}

type trackingSigner struct {
	inner     signature.Signer
	signCalls int
}

func buildTestGenerationMetadata(t *testing.T, authority *testAuthority, plan TargetsPlan, snapshotVersion, timestampVersion int64, createdAt time.Time) (PreparedTargets, []byte, []byte, []byte) {
	t.Helper()
	prepared, err := PrepareTargets(plan, authority.rootBytes)
	if err != nil {
		t.Fatal(err)
	}
	evidence := []DetachedSignature{
		targetsEvidence(t, authority, prepared, authority.keys[metadata.TARGETS][0]),
		targetsEvidence(t, authority, prepared, authority.keys[metadata.TARGETS][1]),
	}
	targetsBytes, err := AssembleTargets(prepared, authority.rootBytes, evidence)
	if err != nil {
		t.Fatal(err)
	}
	snapshotBytes, err := BuildSnapshot(authority.rootBytes, targetsBytes, SnapshotOptions{
		Environment: plan.Environment, RepositoryID: plan.RepositoryID, ReleaseID: plan.ReleaseID,
		RootVersion: plan.RootVersion, Version: snapshotVersion, CreatedAt: createdAt,
		Expires: createdAt.Add(7 * 24 * time.Hour), ExpectedTargetsVersion: plan.TargetsVersion,
		ExpectedTargetsSHA256: sha256Hex(targetsBytes),
	}, loadSigner(t, authority.keys[metadata.SNAPSHOT][0]))
	if err != nil {
		t.Fatal(err)
	}
	timestampBytes, err := BuildTimestamp(authority.rootBytes, snapshotBytes, TimestampOptions{
		Environment: plan.Environment, RepositoryID: plan.RepositoryID, ReleaseID: plan.ReleaseID,
		RootVersion: plan.RootVersion, Version: timestampVersion, CreatedAt: createdAt,
		Expires: createdAt.Add(24 * time.Hour), ExpectedSnapshotVersion: snapshotVersion,
		ExpectedSnapshotSHA256: sha256Hex(snapshotBytes),
	}, loadSigner(t, authority.keys[metadata.TIMESTAMP][0]))
	if err != nil {
		t.Fatal(err)
	}
	return prepared, targetsBytes, snapshotBytes, timestampBytes
}

func materializationGapAttempt(t *testing.T, snapshotVersion, timestampVersion int64) (string, error) {
	t.Helper()
	authority := newTestAuthority(t)
	plan := authority.plan(t)
	prepared, targetsBytes, snapshot1, timestamp1 := buildTestGenerationMetadata(t, authority, plan, 1, 1, authority.now)
	parent := t.TempDir()
	previousDirectory := filepath.Join(parent, "generation-1")
	previous, err := MaterializeGeneration(GenerationInput{
		DestinationDirectory: previousDirectory, ReferenceTime: authority.now, Prepared: prepared,
		ExpectedRootVersion: 1, ExpectedTargetsVersion: 1, ExpectedSnapshotVersion: 1, ExpectedTimestampVersion: 1,
		RootBytes: authority.rootBytes, TargetsBytes: targetsBytes, SnapshotBytes: snapshot1, TimestampBytes: timestamp1,
	})
	if err != nil {
		t.Fatal(err)
	}

	referenceTime := authority.now.Add(time.Hour)
	snapshotBytes := snapshot1
	if snapshotVersion != 1 {
		snapshotBytes, err = BuildSnapshot(authority.rootBytes, targetsBytes, SnapshotOptions{
			Environment: plan.Environment, RepositoryID: plan.RepositoryID, ReleaseID: plan.ReleaseID,
			RootVersion: plan.RootVersion, Version: snapshotVersion, CreatedAt: referenceTime,
			Expires: referenceTime.Add(7 * 24 * time.Hour), ExpectedTargetsVersion: plan.TargetsVersion,
			ExpectedTargetsSHA256: sha256Hex(targetsBytes),
		}, loadSigner(t, authority.keys[metadata.SNAPSHOT][0]))
		if err != nil {
			t.Fatal(err)
		}
	}
	timestampBytes, err := BuildTimestamp(authority.rootBytes, snapshotBytes, TimestampOptions{
		Environment: plan.Environment, RepositoryID: plan.RepositoryID, ReleaseID: plan.ReleaseID,
		RootVersion: plan.RootVersion, Version: timestampVersion, CreatedAt: referenceTime,
		Expires: referenceTime.Add(24 * time.Hour), ExpectedSnapshotVersion: snapshotVersion,
		ExpectedSnapshotSHA256: sha256Hex(snapshotBytes),
	}, loadSigner(t, authority.keys[metadata.TIMESTAMP][0]))
	if err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(parent, "gap-generation")
	_, err = MaterializeGeneration(GenerationInput{
		PreviousDirectory: previousDirectory, PreviousRepositorySHA256: previous.RepositorySHA256,
		DestinationDirectory: destination, ReferenceTime: referenceTime, Prepared: prepared,
		ExpectedRootVersion: 1, ExpectedTargetsVersion: 1,
		ExpectedSnapshotVersion: snapshotVersion, ExpectedTimestampVersion: timestampVersion,
		RootBytes: authority.rootBytes, TargetsBytes: targetsBytes,
		SnapshotBytes: snapshotBytes, TimestampBytes: timestampBytes,
	})
	return destination, err
}

func cloudflareValidator(t *testing.T) (string, string) {
	t.Helper()
	node, nodeErr := exec.LookPath("node")
	_, sourceFile, _, _ := runtime.Caller(0)
	workspace := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "..", "..", "..", ".."))
	validator := filepath.Join(workspace, "infra", "cloudflare", "scripts", "tuf-repository-layout.mjs")
	dependency := filepath.Join(workspace, "infra", "cloudflare", "node_modules", "json-dup-key-validator")
	required := os.Getenv("HID_REQUIRE_CLOUDFLARE_VALIDATOR") == "1"
	if nodeErr != nil {
		if required {
			t.Fatal(nodeErr)
		}
		t.Skip("Node.js is unavailable for cross-validator test")
	}
	for _, requiredPath := range []string{validator, dependency} {
		if _, err := os.Stat(requiredPath); err != nil {
			if required {
				t.Fatal(err)
			}
			t.Skip("Cloudflare validator dependencies are not installed")
		}
	}
	return node, validator
}

func assertCloudflareGeneration(
	t *testing.T,
	node, validator, destination string,
	referenceTime time.Time,
	result GenerationResult,
) {
	t.Helper()
	validatorURL := (&url.URL{Scheme: "file", Path: validator}).String()
	script := `
import { validateTufRepositoryDirectory } from ` + strconv.Quote(validatorURL) + `
const result = await validateTufRepositoryDirectory(process.argv[1], 'staging', { now: new Date(process.argv[2]) })
process.stdout.write(JSON.stringify(result))
	`
	command := exec.Command(
		node, "--input-type=module", "--eval", script, destination, referenceTime.Format(time.RFC3339),
	)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	output, err := command.Output()
	if err != nil {
		t.Fatalf("Cloudflare validator rejected Go materialization: %v\n%s", err, stderr.Bytes())
	}
	var validated struct {
		RepositorySHA256 string `json:"repositorySha256"`
		FileCount        int    `json:"fileCount"`
		RootVersion      int64  `json:"rootVersion"`
		TargetsVersion   int64  `json:"targetsVersion"`
		SnapshotVersion  int64  `json:"snapshotVersion"`
		TimestampVersion int64  `json:"timestampVersion"`
	}
	if err := json.Unmarshal(output, &validated); err != nil {
		t.Fatalf("decode Cloudflare validator output: %v: %q", err, output)
	}
	if validated.RepositorySHA256 != result.RepositorySHA256 || validated.FileCount != result.FileCount ||
		validated.RootVersion != result.RootVersion || validated.TargetsVersion != result.TargetsVersion ||
		validated.SnapshotVersion != result.SnapshotVersion || validated.TimestampVersion != result.TimestampVersion {
		t.Fatalf("Go and Cloudflare validators disagree: Go=%+v Cloudflare=%+v", result, validated)
	}
}

func (signer *trackingSigner) PublicKey(options ...signature.PublicKeyOption) (crypto.PublicKey, error) {
	return signer.inner.PublicKey(options...)
}

func (signer *trackingSigner) SignMessage(message io.Reader, options ...signature.SignOption) ([]byte, error) {
	signer.signCalls++
	return signer.inner.SignMessage(message, options...)
}

func targetsEvidence(t *testing.T, authority *testAuthority, prepared PreparedTargets, privateKey *ecdsa.PrivateKey) DetachedSignature {
	t.Helper()
	signer := loadSigner(t, privateKey)
	encoded, err := signer.SignMessage(bytes.NewReader(prepared.Payload))
	if err != nil {
		t.Fatal(err)
	}
	key, err := metadata.KeyFromPublicKey(privateKey.Public())
	if err != nil {
		t.Fatal(err)
	}
	keyID, err := key.ID()
	if err != nil {
		t.Fatal(err)
	}
	detached := DetachedSignature{
		SchemaVersion: SchemaVersion, Environment: prepared.Plan.Environment, RepositoryID: prepared.Plan.RepositoryID,
		ReleaseID: prepared.Plan.ReleaseID, RootVersion: prepared.Plan.RootVersion,
		RootSHA256:     prepared.RootSHA256,
		TargetsVersion: prepared.Plan.TargetsVersion, PayloadSHA256: prepared.PayloadSHA256,
		KeyID: keyID, Signature: hex.EncodeToString(encoded), SignedAt: authority.now.Format(time.RFC3339),
	}
	detached.Attestation = targetsEvidenceAttestation(t, prepared, detached, privateKey)
	return detached
}

func targetsEvidenceAttestation(t *testing.T, prepared PreparedTargets, detached DetachedSignature, privateKey *ecdsa.PrivateKey) string {
	t.Helper()
	signer := loadSigner(t, privateKey)
	request, err := NewTargetsSigningRequest(prepared)
	if err != nil {
		t.Fatal(err)
	}
	statement, err := canonicalTargetsEvidenceAttestation(request, detached)
	if err != nil {
		t.Fatal(err)
	}
	attestation, err := signer.SignMessage(bytes.NewReader(statement))
	if err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(attestation)
}

func loadSigner(t *testing.T, privateKey *ecdsa.PrivateKey) signature.Signer {
	t.Helper()
	signer, err := signature.LoadSigner(privateKey, crypto.SHA256)
	if err != nil {
		t.Fatal(err)
	}
	return signer
}

func signMetadata[T metadata.Roles](t *testing.T, value *metadata.Metadata[T], privateKey *ecdsa.PrivateKey) {
	t.Helper()
	if _, err := value.Sign(loadSigner(t, privateKey)); err != nil {
		t.Fatal(err)
	}
}

func resignRoot(t *testing.T, root *metadata.Metadata[metadata.RootType], rootKeys []*ecdsa.PrivateKey) {
	t.Helper()
	root.ClearSignatures()
	for _, privateKey := range rootKeys[:governedRootRoles[metadata.ROOT].threshold] {
		signMetadata(t, root, privateKey)
	}
	root.Signatures = sortedSignatures(root.Signatures)
}

func cloneRoot(t *testing.T, encoded []byte) *metadata.Metadata[metadata.RootType] {
	t.Helper()
	var root metadata.Metadata[metadata.RootType]
	if _, err := root.FromBytes(encoded); err != nil {
		t.Fatal(err)
	}
	return &root
}

func rootBytes(t *testing.T, root *metadata.Metadata[metadata.RootType]) []byte {
	t.Helper()
	encoded, err := root.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func clonePrepared(prepared PreparedTargets) PreparedTargets {
	result := prepared
	result.Plan = deepCopyTargetsPlan(prepared.Plan)
	result.Payload = bytes.Clone(prepared.Payload)
	result.Targets = append([]PreparedTarget(nil), prepared.Targets...)
	return result
}
