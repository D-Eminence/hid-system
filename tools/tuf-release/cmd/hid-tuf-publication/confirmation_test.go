package main

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/awsbroker"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/signingbroker"
)

func TestConfirmationCommandObservesPublishedNotPendingState(t *testing.T) {
	args, factory, clock, store := publicationCommandFixture(t)
	confirmationArgs := []string{"confirm", args[0], args[3], args[4], "3"}
	var output bytes.Buffer
	if err := run(context.Background(), confirmationArgs, &output, factory, clock); err == nil || output.Len() != 0 {
		t.Fatal("pending-only generation was confirmed")
	}
	checkpoint := &store.checkpoint
	checkpoint.Revision++
	checkpoint.ReleaseID = checkpoint.PendingSnapshot.ReleaseID
	checkpoint.Targets = checkpoint.PendingSnapshot.Targets
	checkpoint.Snapshot = checkpoint.PendingSnapshot.Snapshot
	checkpoint.Timestamp = checkpoint.PendingTimestamp.Timestamp
	checkpoint.PendingSnapshot, checkpoint.PendingTimestamp = nil, nil
	if err := run(context.Background(), confirmationArgs, &output, factory, clock); err != nil {
		t.Fatal(err)
	}
	var result confirmationResult
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.SchemaVersion != "hid.tuf.publication-confirmation/v1" || result.RepositorySHA256 != args[4] ||
		result.Confirmation.StateRevision != 4 || result.Confirmation.PriorStateRevision != 3 ||
		result.Confirmation.Published.Timestamp.Version != 2 || store.writes != 0 {
		t.Fatalf("confirmation did not bind the exact published generation: %+v", result)
	}
}

func TestConfirmationCommandRejectsLocalInputsBeforeAWS(t *testing.T) {
	for _, scenario := range []string{"hash", "-1", "03", "+3", "9007199254740992", "invalid"} {
		t.Run(scenario, func(t *testing.T) {
			args, _, clock, _ := publicationCommandFixture(t)
			confirmationArgs := []string{"confirm", args[0], args[3], args[4], "3"}
			if scenario == "hash" {
				confirmationArgs[3] = "bad-hash"
			} else {
				confirmationArgs[4] = scenario
			}
			factory := func(context.Context, awsbroker.PublicationReaderConfig) (*signingbroker.PublicationController, error) {
				t.Fatal("invalid confirmation input reached AWS initialization")
				return nil, nil
			}
			var output bytes.Buffer
			if err := run(context.Background(), confirmationArgs, &output, factory, clock); err == nil || output.Len() != 0 {
				t.Fatal("invalid local input emitted confirmation")
			}
		})
	}
}
