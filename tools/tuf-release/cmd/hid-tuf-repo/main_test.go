package main

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/repository"
	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

const commandTestReleaseID = "r0000000001-gaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

type ceremonyFixture struct {
	now               time.Time
	root              *metadata.Metadata[metadata.RootType]
	rootPath          string
	planPath          string
	preparedDirectory string
	targetKeys        []*ecdsa.PrivateKey
}

func TestRunRejectsUnknownOrIncompleteCommands(t *testing.T) {
	for _, arguments := range [][]string{
		nil, {"unknown"}, {"prepare-targets"}, {"prepare-targets-attestation"},
		{"complete-targets-evidence"}, {"assemble-targets"}, {"sign-snapshot"},
		{"sign-timestamp"}, {"materialize-generation"},
	} {
		if err := run(context.Background(), arguments, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "usage:") {
			t.Fatalf("arguments %v did not fail with usage", arguments)
		}
	}
}

func TestOnlineCommandRejectsExistingOutputBeforeAnyAWSOperation(t *testing.T) {
	directory := t.TempDir()
	now := time.Now().UTC().Truncate(time.Second)
	plan := repository.OnlineSigningPlan{
		SchemaVersion: repository.SchemaVersion, Role: "snapshot", Environment: "staging",
		RepositoryID: "hid-staging-v1", ReleaseID: "r0000000001-gaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		CreatedAt: now.Format(time.RFC3339), Expires: now.Add(7 * 24 * time.Hour).Format(time.RFC3339),
		RootPath: filepath.Join(directory, "1.root.json"), RootSHA256: strings.Repeat("a", 64), RootVersion: 1,
		InputMetadataPath: filepath.Join(directory, "1.targets.json"), InputMetadataSHA256: strings.Repeat("b", 64),
		InputMetadataVersion: 1, OutputMetadataVersion: 1,
		AWSRegion: "us-east-1", AWSAccountID: "123456789012",
		KMSKeyARN:               "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789abc",
		KMSPublicKeyDERChecksum: strings.Repeat("c", 64),
	}
	encoded, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	planPath := filepath.Join(directory, "snapshot-plan.json")
	outputPath := filepath.Join(directory, "1.snapshot.json")
	if err := os.WriteFile(planPath, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outputPath, []byte("do not replace"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	err = run(ctx, []string{"sign-snapshot", planPath, outputPath}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("existing output did not fail before AWS initialization: %v", err)
	}
	contents, readErr := os.ReadFile(outputPath)
	if readErr != nil || string(contents) != "do not replace" {
		t.Fatal("existing output was modified")
	}
}

func TestTargetsEvidenceCommandsRoundTripWithoutHandlingPrivateKeys(t *testing.T) {
	fixture := newCeremonyFixture(t)
	evidencePaths := make([]string, 0, 2)
	for index, privateKey := range fixture.targetKeys[:2] {
		custodianDirectory := filepath.Join(filepath.Dir(fixture.preparedDirectory), "custodian-"+string(rune('1'+index)))
		if err := os.Mkdir(custodianDirectory, 0o700); err != nil {
			t.Fatal(err)
		}
		evidencePaths = append(evidencePaths, completeCustodianEvidence(t, fixture, privateKey, custodianDirectory))
	}

	targetsPath := filepath.Join(filepath.Dir(fixture.preparedDirectory), "1.targets.json")
	if err := run(context.Background(), []string{
		"assemble-targets", fixture.planPath, fixture.rootPath, fixture.preparedDirectory,
		targetsPath, evidencePaths[0], evidencePaths[1],
	}, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	targetsBytes, err := os.ReadFile(targetsPath)
	if err != nil {
		t.Fatal(err)
	}
	targets, err := metadata.Targets().FromBytes(targetsBytes)
	if err != nil {
		t.Fatal(err)
	}
	if err := fixture.root.VerifyDelegate(metadata.TARGETS, targets); err != nil {
		t.Fatalf("assembled targets did not meet the offline threshold: %v", err)
	}
}

func TestTargetsEvidenceCommandsRejectPreparedDirectoryOutputAndBadAttestation(t *testing.T) {
	fixture := newCeremonyFixture(t)
	privateKey := fixture.targetKeys[0]
	keyID, tufSignature := signPreparedPayload(t, fixture, privateKey)
	signedAt := fixture.now.Format(time.RFC3339)
	insidePrepared := filepath.Join(fixture.preparedDirectory, repository.TargetsAttestationStatementName)
	if err := run(context.Background(), []string{
		"prepare-targets-attestation", fixture.planPath, fixture.rootPath, fixture.preparedDirectory,
		keyID, tufSignature, signedAt, insidePrepared,
	}, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "outside the prepared targets directory") {
		t.Fatalf("prepared-directory output was accepted: %v", err)
	}
	if _, err := os.Lstat(insidePrepared); !os.IsNotExist(err) {
		t.Fatal("rejected prepared-directory output created an artifact")
	}

	outputDirectory := filepath.Join(filepath.Dir(fixture.preparedDirectory), "bad-attestation")
	if err := os.Mkdir(outputDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	evidencePath := filepath.Join(outputDirectory, repository.TargetsSignatureEvidenceName)
	if err := run(context.Background(), []string{
		"complete-targets-evidence", fixture.planPath, fixture.rootPath, fixture.preparedDirectory,
		keyID, tufSignature, signedAt, "3006020101020101", evidencePath,
	}, &bytes.Buffer{}); err == nil {
		t.Fatal("invalid attestation was accepted")
	}
	if _, err := os.Lstat(evidencePath); !os.IsNotExist(err) {
		t.Fatal("invalid attestation left an evidence artifact")
	}
}

func TestOnlineCommandRejectsStalePlanBeforeLocalInputsOrAWS(t *testing.T) {
	directory := t.TempDir()
	now := time.Now().UTC().Truncate(time.Second)
	plan := repository.OnlineSigningPlan{
		SchemaVersion: repository.SchemaVersion, Role: "snapshot", Environment: "staging",
		RepositoryID: "hid-staging-v1", ReleaseID: "r0000000001-gaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		CreatedAt: now.Add(-5*time.Minute - time.Second).Format(time.RFC3339),
		Expires:   now.Add(7*24*time.Hour - 5*time.Minute - time.Second).Format(time.RFC3339),
		RootPath:  filepath.Join(directory, "missing-root.json"), RootSHA256: strings.Repeat("a", 64), RootVersion: 1,
		InputMetadataPath: filepath.Join(directory, "missing-targets.json"), InputMetadataSHA256: strings.Repeat("b", 64),
		InputMetadataVersion: 1, OutputMetadataVersion: 1,
		AWSRegion: "us-east-1", AWSAccountID: "123456789012",
		KMSKeyARN:               "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789abc",
		KMSPublicKeyDERChecksum: strings.Repeat("c", 64),
	}
	encoded, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	planPath := filepath.Join(directory, "stale-snapshot-plan.json")
	if err := os.WriteFile(planPath, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	err = run(context.Background(), []string{
		"sign-snapshot", planPath, filepath.Join(directory, "1.snapshot.json"),
	}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "more than 5 minutes old") {
		t.Fatalf("stale plan reached local input or AWS initialization: %v", err)
	}
}

func TestMaterializeCommandRejectsNonGenesisPlanWithoutPinnedPredecessor(t *testing.T) {
	directory := t.TempDir()
	plan := repository.GenerationPlan{
		SchemaVersion: repository.SchemaVersion, Environment: "staging", RepositoryID: "hid-staging-v1",
		ReleaseID: "r0000000001-gaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ReferenceTime: "2026-09-01T12:00:00Z",
		TargetsPlanPath: filepath.Join(directory, "targets-plan.json"), PreparedTargetsDirectory: filepath.Join(directory, "prepared"),
		RootPath: filepath.Join(directory, "1.root.json"), RootSHA256: strings.Repeat("a", 64), RootVersion: 1,
		TargetsMetadataPath: filepath.Join(directory, "1.targets.json"), TargetsMetadataSHA256: strings.Repeat("b", 64), TargetsVersion: 1,
		SnapshotMetadataPath: filepath.Join(directory, "1.snapshot.json"), SnapshotMetadataSHA256: strings.Repeat("c", 64), SnapshotVersion: 1,
		TimestampMetadataPath: filepath.Join(directory, "timestamp.json"), TimestampMetadataSHA256: strings.Repeat("d", 64), TimestampVersion: 2,
	}
	encoded, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	planPath := filepath.Join(directory, "generation-plan.json")
	if err := os.WriteFile(planPath, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	err = run(context.Background(), []string{
		"materialize-generation", planPath, filepath.Join(directory, "generation-2"),
	}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "requires a pinned previous repository") {
		t.Fatalf("non-genesis plan reached materialization inputs: %v", err)
	}
}

func TestSecurityPathsRejectRelativeAndSymlinkedParents(t *testing.T) {
	if err := requireInputPath("relative.json", "input"); err == nil {
		t.Fatal("relative input path was accepted")
	}
	realDirectory := t.TempDir()
	filePath := filepath.Join(realDirectory, "input.json")
	if err := os.WriteFile(filePath, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	linkParent := filepath.Join(t.TempDir(), "linked")
	if err := os.Symlink(realDirectory, linkParent); err != nil {
		t.Fatal(err)
	}
	if err := requireInputPath(filepath.Join(linkParent, "input.json"), "input"); err == nil {
		t.Fatal("input below a symlinked parent was accepted")
	}
}

// newCeremonyFixture creates only disposable test keys in a test-owned
// temporary directory. It is not a provisioning path for any environment.
func newCeremonyFixture(t *testing.T) ceremonyFixture {
	t.Helper()
	directory := t.TempDir()
	now := time.Date(2026, time.September, 2, 12, 0, 0, 0, time.UTC)
	root := metadata.Root(now.Add(365 * 24 * time.Hour))
	roleCounts := map[string]int{
		metadata.ROOT: 3, metadata.TARGETS: 3, metadata.SNAPSHOT: 2, metadata.TIMESTAMP: 2,
	}
	roleThresholds := map[string]int{
		metadata.ROOT: 2, metadata.TARGETS: 2, metadata.SNAPSHOT: 1, metadata.TIMESTAMP: 1,
	}
	keys := make(map[string][]*ecdsa.PrivateKey, len(roleCounts))
	for _, roleName := range []string{metadata.ROOT, metadata.TARGETS, metadata.SNAPSHOT, metadata.TIMESTAMP} {
		for index := 0; index < roleCounts[roleName]; index++ {
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
		root.Signed.Roles[roleName].Threshold = roleThresholds[roleName]
	}
	root.ClearSignatures()
	for _, privateKey := range keys[metadata.ROOT][:roleThresholds[metadata.ROOT]] {
		signer := loadTestSigner(t, privateKey)
		if _, err := root.Sign(signer); err != nil {
			t.Fatal(err)
		}
	}
	sort.Slice(root.Signatures, func(left, right int) bool {
		return root.Signatures[left].KeyID < root.Signatures[right].KeyID
	})
	rootBytes, err := root.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
	rootPath := filepath.Join(directory, "1.root.json")
	if err := os.WriteFile(rootPath, rootBytes, 0o600); err != nil {
		t.Fatal(err)
	}

	targetInputs := []struct {
		logical string
		name    string
		data    []byte
	}{
		{
			logical: "environments/staging/channels/current.json", name: "current.json",
			data: []byte(`{"release_id":"` + commandTestReleaseID + `"}`),
		},
		{
			logical: "environments/staging/releases/" + commandTestReleaseID + "/release-bundle.json",
			name:    "release-bundle.json", data: []byte(`{"schema_version":"1.0.0"}`),
		},
	}
	plan := repository.TargetsPlan{
		SchemaVersion: repository.SchemaVersion, Environment: "staging", RepositoryID: "hid-staging-v1",
		ReleaseID: commandTestReleaseID, CreatedAt: now.Format(time.RFC3339), RootVersion: 1, TargetsVersion: 1,
		TargetsExpires: now.Add(90 * 24 * time.Hour).Format(time.RFC3339),
	}
	for _, target := range targetInputs {
		sourcePath := filepath.Join(directory, target.name)
		if err := os.WriteFile(sourcePath, target.data, 0o600); err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(target.data)
		plan.Targets = append(plan.Targets, repository.TargetInput{
			Path: target.logical, SourcePath: sourcePath, Length: int64(len(target.data)),
			SHA256: hex.EncodeToString(digest[:]),
		})
	}
	planBytes, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	planPath := filepath.Join(directory, "targets-plan.json")
	if err := os.WriteFile(planPath, planBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	preparedDirectory := filepath.Join(directory, "prepared")
	if err := run(context.Background(), []string{
		"prepare-targets", planPath, rootPath, preparedDirectory,
	}, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	return ceremonyFixture{
		now: now, root: root, rootPath: rootPath, planPath: planPath,
		preparedDirectory: preparedDirectory, targetKeys: keys[metadata.TARGETS],
	}
}

func completeCustodianEvidence(t *testing.T, fixture ceremonyFixture, privateKey *ecdsa.PrivateKey, outputDirectory string) string {
	t.Helper()
	keyID, tufSignature := signPreparedPayload(t, fixture, privateKey)
	signedAt := fixture.now.Format(time.RFC3339)
	statementPath := filepath.Join(outputDirectory, repository.TargetsAttestationStatementName)
	var prepareReceipt bytes.Buffer
	if err := run(context.Background(), []string{
		"prepare-targets-attestation", fixture.planPath, fixture.rootPath, fixture.preparedDirectory,
		keyID, tufSignature, signedAt, statementPath,
	}, &prepareReceipt); err != nil {
		t.Fatal(err)
	}
	statement, err := os.ReadFile(statementPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(statement) == 0 || statement[len(statement)-1] == '\n' {
		t.Fatal("attestation statement is empty or was changed from its canonical raw bytes")
	}
	var receipt map[string]any
	if err := json.Unmarshal(prepareReceipt.Bytes(), &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt["statement_sha256"] != sha256Hex(statement) || receipt["signed_at"] != signedAt {
		t.Fatal("attestation statement receipt does not bind its exact bytes and signing time")
	}
	statementInfo, err := os.Stat(statementPath)
	if err != nil || statementInfo.Mode().Perm() != 0o600 {
		t.Fatalf("attestation statement mode is not 0600: %v %v", statementInfo, err)
	}
	originalStatement := bytes.Clone(statement)
	if err := run(context.Background(), []string{
		"prepare-targets-attestation", fixture.planPath, fixture.rootPath, fixture.preparedDirectory,
		keyID, tufSignature, signedAt, statementPath,
	}, &bytes.Buffer{}); err == nil {
		t.Fatal("existing attestation statement was replaced")
	}
	unchanged, err := os.ReadFile(statementPath)
	if err != nil || !bytes.Equal(unchanged, originalStatement) {
		t.Fatal("existing attestation statement changed after a rejected rewrite")
	}

	signer := loadTestSigner(t, privateKey)
	attestation, err := signer.SignMessage(bytes.NewReader(statement))
	if err != nil {
		t.Fatal(err)
	}
	evidencePath := filepath.Join(outputDirectory, repository.TargetsSignatureEvidenceName)
	var completeReceipt bytes.Buffer
	if err := run(context.Background(), []string{
		"complete-targets-evidence", fixture.planPath, fixture.rootPath, fixture.preparedDirectory,
		keyID, tufSignature, signedAt, hex.EncodeToString(attestation), evidencePath,
	}, &completeReceipt); err != nil {
		t.Fatal(err)
	}
	evidence, err := repository.LoadDetachedSignature(evidencePath)
	if err != nil {
		t.Fatalf("completed evidence did not strict-load: %v", err)
	}
	if evidence.KeyID != keyID || evidence.Signature != tufSignature || evidence.SignedAt != signedAt {
		t.Fatal("completed evidence changed its custodian inputs")
	}
	evidenceInfo, err := os.Stat(evidencePath)
	if err != nil || evidenceInfo.Mode().Perm() != 0o600 {
		t.Fatalf("targets evidence mode is not 0600: %v %v", evidenceInfo, err)
	}
	return evidencePath
}

func signPreparedPayload(t *testing.T, fixture ceremonyFixture, privateKey *ecdsa.PrivateKey) (string, string) {
	t.Helper()
	payload, err := os.ReadFile(filepath.Join(fixture.preparedDirectory, repository.PreparedTargetsPayloadName))
	if err != nil {
		t.Fatal(err)
	}
	signer := loadTestSigner(t, privateKey)
	tufSignature, err := signer.SignMessage(bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	publicKey, err := metadata.KeyFromPublicKey(privateKey.Public())
	if err != nil {
		t.Fatal(err)
	}
	keyID, err := publicKey.ID()
	if err != nil {
		t.Fatal(err)
	}
	return keyID, hex.EncodeToString(tufSignature)
}

func loadTestSigner(t *testing.T, privateKey *ecdsa.PrivateKey) signature.Signer {
	t.Helper()
	signer, err := signature.LoadSigner(privateKey, crypto.SHA256)
	if err != nil {
		t.Fatal(err)
	}
	return signer
}
