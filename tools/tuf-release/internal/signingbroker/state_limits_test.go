package signingbroker

import (
	"strings"
	"testing"
	"time"
)

func TestCheckpointRootHistoryHasABoundedRuntimeFootprint(t *testing.T) {
	checkpoint := Checkpoint{
		SchemaVersion:       CheckpointSchemaVersion,
		Environment:         "staging",
		RepositoryID:        "hid-staging-v1",
		StateID:             "hid-staging-broker-v1",
		BootstrapRootSHA256: strings.Repeat("a", 64),
		Revision:            1,
		ReleaseID:           "r0000000001-gaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		RootHistory:         make([]MetadataRecord, MaxRootHistoryRecords+1),
	}
	err := validateCheckpoint(checkpoint, checkpointTrustConfig(checkpoint), time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC))
	if err == nil || !strings.Contains(err.Error(), "root history count") {
		t.Fatalf("oversized root history was accepted: %v", err)
	}
}

func TestStateIdentifierGrammarRejectsAmbiguousSeparatorsAndEdges(t *testing.T) {
	for _, stateID := range []string{"hid_staging_state", "hid.staging.state", "hid-staging-state-"} {
		config := fixedTrustConfig{
			environment: "staging", repositoryID: "hid-staging-v1", stateID: stateID,
			bootstrapRootSHA256: strings.Repeat("a", 64),
		}
		if err := validateTrustConfig(config); err == nil {
			t.Fatalf("ambiguous state ID %q was accepted", stateID)
		}
	}
}

func checkpointTrustConfig(checkpoint Checkpoint) fixedTrustConfig {
	return fixedTrustConfig{
		environment: checkpoint.Environment, repositoryID: checkpoint.RepositoryID,
		stateID: checkpoint.StateID, bootstrapRootSHA256: checkpoint.BootstrapRootSHA256,
	}
}
