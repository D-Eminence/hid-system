package signingbroker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/repository"
)

func generationMaterializationInput(generation testGeneration, destination string, reference time.Time) repository.GenerationInput {
	return repository.GenerationInput{
		DestinationDirectory: destination, ReferenceTime: reference, Prepared: generation.prepared,
		ExpectedRootVersion: generation.rootVersion, ExpectedTargetsVersion: generation.targetsVersion,
		ExpectedSnapshotVersion: generation.snapshotVersion, ExpectedTimestampVersion: generation.timestampVersion,
		RootBytes: generation.rootBytes, TargetsBytes: generation.targetsBytes, SnapshotBytes: generation.snapshotBytes, TimestampBytes: generation.timestampBytes,
	}
}

func verifyRecoveredPublicationRepository(t *testing.T, result repository.GenerationResult, now time.Time) {
	t.Helper()
	inspected, err := repository.InspectPublicationGeneration(result.Repository, "staging", now, true)
	if err != nil {
		t.Fatal(err)
	}
	if inspected.SHA256() != result.RepositorySHA256 {
		t.Fatal("recovered materialization hash differs from independent inspection")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		if os.Getenv("HID_REQUIRE_CLOUDFLARE_VALIDATOR") == "1" {
			t.Fatal(err)
		}
		t.Log("Node unavailable; recovered-generation Node interoperability check not required")
		return
	}
	_, source, _, _ := runtime.Caller(0)
	validator := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../../infra/cloudflare/scripts/tuf-repository-layout.mjs"))
	if _, err := os.Stat(filepath.Join(filepath.Dir(validator), "../node_modules/json-dup-key-validator")); err != nil {
		if os.Getenv("HID_REQUIRE_CLOUDFLARE_VALIDATOR") == "1" {
			t.Fatal(err)
		}
		t.Log("Cloudflare validator dependencies unavailable; Node interoperability check not required")
		return
	}
	script := `import { pathToFileURL } from 'node:url'; const {validateTufRepositoryDirectory}=await import(pathToFileURL(process.argv[1])); const result=await validateTufRepositoryDirectory(process.argv[2], 'staging', {now:new Date(process.argv[3])}); process.stdout.write(JSON.stringify({hash:result.repositorySha256,snapshot:result.snapshotVersion,timestamp:result.timestampVersion}));`
	output, err := exec.Command(node, "--input-type=module", "-e", script, validator, result.Repository, now.Format(time.RFC3339)).Output()
	if err != nil {
		t.Fatalf("independent recovered-generation validation failed: %v", err)
	}
	var verified struct {
		Hash      string `json:"hash"`
		Snapshot  int64  `json:"snapshot"`
		Timestamp int64  `json:"timestamp"`
	}
	if err := json.Unmarshal(output, &verified); err != nil {
		t.Fatal(err)
	}
	if verified.Hash != result.RepositorySHA256 || verified.Snapshot != 3 || verified.Timestamp != 3 {
		t.Fatalf("validator disagrees with recovered generation: %+v", verified)
	}
}

type changedMaterializationAuthorizer struct {
	controller *PublicationController
	calls      int
	change     func()
}

func (authorizer *changedMaterializationAuthorizer) AuthorizeMaterialization(ctx context.Context, current, candidate repository.MetadataSet) error {
	authorizer.calls++
	if authorizer.calls == 2 {
		authorizer.change()
	}
	return authorizer.controller.AuthorizeMaterialization(ctx, current, candidate)
}

func TestPendingMaterializationReauthorizesBeforeAtomicCommit(t *testing.T) {
	fixture, controller, _, current, candidate := pendingPublicationFixture(t)
	parent := t.TempDir()
	initial, err := repository.MaterializeGeneration(generationMaterializationInput(fixture.initial, filepath.Join(parent, "initial"), fixture.now))
	if err != nil {
		t.Fatal(err)
	}
	// Recreate the exact unsigned targets context used by the pending fixture.
	next := fixture.generation(t, testReleaseTwo, 2, 2, 2)
	input := generationMaterializationInput(next, filepath.Join(parent, "must-not-commit"), fixture.now)
	input.RootBytes, input.TargetsBytes, input.SnapshotBytes, input.TimestampBytes = candidate.RootBytes, candidate.TargetsBytes, candidate.SnapshotBytes, candidate.TimestampBytes
	input.PreviousDirectory, input.PreviousRepositorySHA256 = initial.Repository, initial.RepositorySHA256
	authorizer := &changedMaterializationAuthorizer{controller: controller, change: func() { fixture.store.checkpoint.PendingTimestamp = nil }}
	if _, err := repository.MaterializePendingGeneration(context.Background(), input, authorizer); err == nil {
		t.Fatal("changed pending state committed a generation")
	}
	if authorizer.calls != 2 {
		t.Fatalf("expected pre-copy and pre-commit state authorization, got %d", authorizer.calls)
	}
	if _, err := os.Stat(input.DestinationDirectory); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("failed reauthorization left a committed generation")
	}
	entries, err := os.ReadDir(parent)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "initial" {
		t.Fatal("failed materialization left private temporary output")
	}
	data, err := os.ReadFile(filepath.Join(initial.Repository, "metadata/timestamp.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, current.TimestampBytes) {
		t.Fatal("failed materialization changed its predecessor")
	}
}
