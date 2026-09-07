package repository

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/theupdateframework/go-tuf/v2/metadata"
)

func TestPublicationSuccessorRejectsLossOrSubstitutionOfValidRetainedMetadata(t *testing.T) {
	for _, scenario := range []string{"omit", "resign"} {
		t.Run(scenario, func(t *testing.T) {
			authority := newTestAuthority(t)
			plan := authority.plan(t)
			prepared, targets, snapshot1, timestamp1 := buildTestGenerationMetadata(t, authority, plan, 1, 1, authority.now)
			parent := t.TempDir()
			input := GenerationInput{DestinationDirectory: filepath.Join(parent, "previous"), ReferenceTime: authority.now, Prepared: prepared,
				ExpectedRootVersion: 1, ExpectedTargetsVersion: 1, ExpectedSnapshotVersion: 1, ExpectedTimestampVersion: 1,
				RootBytes: authority.rootBytes, TargetsBytes: targets, SnapshotBytes: snapshot1, TimestampBytes: timestamp1}
			first, err := MaterializeGeneration(input)
			if err != nil {
				t.Fatal(err)
			}
			reference := authority.now.Add(time.Hour)
			snapshot2, err := BuildSnapshot(authority.rootBytes, targets, SnapshotOptions{
				Environment: plan.Environment, RepositoryID: plan.RepositoryID, ReleaseID: plan.ReleaseID, RootVersion: 1, Version: 2,
				CreatedAt: reference, Expires: reference.Add(7 * 24 * time.Hour), ExpectedTargetsVersion: 1, ExpectedTargetsSHA256: sha256Hex(targets),
			}, loadSigner(t, authority.keys[metadata.SNAPSHOT][0]))
			if err != nil {
				t.Fatal(err)
			}
			timestamp2, err := BuildTimestamp(authority.rootBytes, snapshot2, TimestampOptions{
				Environment: plan.Environment, RepositoryID: plan.RepositoryID, ReleaseID: plan.ReleaseID, RootVersion: 1, Version: 2,
				CreatedAt: reference, Expires: reference.Add(24 * time.Hour), ExpectedSnapshotVersion: 2, ExpectedSnapshotSHA256: sha256Hex(snapshot2),
			}, loadSigner(t, authority.keys[metadata.TIMESTAMP][0]))
			if err != nil {
				t.Fatal(err)
			}
			input.PreviousDirectory, input.PreviousRepositorySHA256 = first.Repository, first.RepositorySHA256
			input.DestinationDirectory = filepath.Join(parent, "candidate")
			input.ReferenceTime = reference
			input.ExpectedSnapshotVersion, input.ExpectedTimestampVersion = 2, 2
			input.SnapshotBytes, input.TimestampBytes = snapshot2, timestamp2
			second, err := MaterializeGeneration(input)
			if err != nil {
				t.Fatal(err)
			}
			previous, err := InspectPublicationGeneration(first.Repository, "staging", reference, false)
			if err != nil {
				t.Fatal(err)
			}
			candidate, err := InspectPublicationGeneration(second.Repository, "staging", reference, true)
			if err != nil {
				t.Fatal(err)
			}
			if err := ValidatePublicationSuccessor(previous, candidate); err != nil {
				t.Fatal(err)
			}
			oldPath := filepath.Join(second.Repository, "metadata/1.snapshot.json")
			if scenario == "omit" {
				if err := os.Remove(oldPath); err != nil {
					t.Fatal(err)
				}
			} else {
				changed, err := BuildSnapshot(authority.rootBytes, targets, SnapshotOptions{
					Environment: plan.Environment, RepositoryID: plan.RepositoryID, ReleaseID: plan.ReleaseID, RootVersion: 1, Version: 1,
					CreatedAt: authority.now, Expires: authority.now.Add(7 * 24 * time.Hour), ExpectedTargetsVersion: 1, ExpectedTargetsSHA256: sha256Hex(targets),
				}, loadSigner(t, authority.keys[metadata.SNAPSHOT][1]))
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(oldPath, changed, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			// Each changed repository remains TUF-valid by itself. Publication
			// must nevertheless preserve exactly what clients previously saw.
			candidate, err = InspectPublicationGeneration(second.Repository, "staging", reference, true)
			if err != nil {
				t.Fatal(err)
			}
			if err := ValidatePublicationSuccessor(previous, candidate); err == nil {
				t.Fatal("valid but non-preserving successor accepted")
			}
		})
	}
}
