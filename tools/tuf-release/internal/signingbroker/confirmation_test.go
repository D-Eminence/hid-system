package signingbroker

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"
)

func confirmedPublicationFixture(t *testing.T) (*brokerFixture, *PublicationController, *authorizationStore, PublishedGeneration, int64) {
	t.Helper()
	fixture, controller, store, _, candidate := pendingPublicationFixture(t)
	prior := fixture.store.checkpoint.Revision
	if _, err := controller.AdvancePublished(context.Background(), candidate); err != nil {
		t.Fatal(err)
	}
	store.reads = 0
	return fixture, controller, store, candidate, prior
}

func TestPublishedConfirmationRequiresExactAdvancedPublishedState(t *testing.T) {
	fixture, controller, store, _, candidate := pendingPublicationFixture(t)
	prior := fixture.store.checkpoint.Revision
	before := fixture.store.casCalls
	for _, previousRevision := range []int64{1, prior} {
		if _, err := controller.ConfirmPublished(context.Background(), candidate, previousRevision); err == nil {
			t.Fatal("pending metadata was accepted as published confirmation")
		}
	}
	if fixture.store.casCalls != before {
		t.Fatal("failed confirmation wrote state")
	}
	advanced, err := controller.AdvancePublished(context.Background(), candidate)
	if err != nil {
		t.Fatal(err)
	}
	before, store.reads = fixture.store.casCalls, 0
	confirmation, err := controller.ConfirmPublished(context.Background(), candidate, prior)
	if err != nil {
		t.Fatal(err)
	}
	root := advanced.RootHistory[len(advanced.RootHistory)-1]
	if confirmation.SchemaVersion != SchemaVersion || confirmation.Environment != advanced.Environment ||
		confirmation.RepositoryID != advanced.RepositoryID || confirmation.StateID != advanced.StateID ||
		confirmation.BootstrapRootSHA256 != advanced.BootstrapRootSHA256 || confirmation.PriorStateRevision != prior ||
		confirmation.StateRevision != advanced.Revision || confirmation.ReleaseID != candidate.ReleaseID ||
		confirmation.ConfirmedAt != fixture.now.Format(time.RFC3339) ||
		confirmation.Published != publicationMetadata(root, advanced.Targets, advanced.Snapshot, advanced.Timestamp) ||
		store.reads != 2 || fixture.store.casCalls != before {
		t.Fatalf("confirmation omitted exact state/metadata/time binding or wrote state: %+v", confirmation)
	}
	for _, previousRevision := range []int64{advanced.Revision, advanced.Revision + 1, 0} {
		if _, err := controller.ConfirmPublished(context.Background(), candidate, previousRevision); err == nil {
			t.Fatal("non-advanced or false-bootstrap prior revision was accepted")
		}
	}
}

func TestPublishedConfirmationSupportsPinnedBootstrapWithoutWriting(t *testing.T) {
	fixture, controller, store, _, _ := pendingPublicationFixture(t)
	candidate := publicationTestGeneration(fixture.initial)
	fixture.store.checkpoint = nil
	if _, err := controller.ConfirmPublished(context.Background(), candidate, 0); !errors.Is(err, ErrStateNotFound) {
		t.Fatalf("absent bootstrap checkpoint was not rejected: %v", err)
	}
	if _, err := controller.BootstrapPublished(context.Background(), candidate); err != nil {
		t.Fatal(err)
	}
	before := fixture.store.casCalls
	store.reads = 0
	confirmation, err := controller.ConfirmPublished(context.Background(), candidate, 0)
	if err != nil {
		t.Fatal(err)
	}
	if confirmation.PriorStateRevision != 0 || confirmation.StateRevision != 1 ||
		confirmation.Published.Root.SHA256 != digestHex(candidate.RootBytes) || store.reads != 2 || fixture.store.casCalls != before {
		t.Fatal("bootstrap confirmation omitted pinned state or wrote state")
	}
}

func TestPublishedConfirmationRejectsSubstitutionAndInvalidInputs(t *testing.T) {
	for _, part := range []string{"environment", "release", "root", "targets", "snapshot", "timestamp", "checkpoint-trust", "checkpoint-hash"} {
		t.Run(part, func(t *testing.T) {
			fixture, controller, _, candidate, prior := confirmedPublicationFixture(t)
			before := fixture.store.casCalls
			switch part {
			case "environment":
				candidate.Environment = "production"
			case "release":
				candidate.ReleaseID = testReleaseOne
			case "root":
				candidate.RootBytes = append(bytes.Clone(candidate.RootBytes), '\n')
			case "targets":
				candidate.TargetsBytes = append(bytes.Clone(candidate.TargetsBytes), '\n')
			case "snapshot":
				candidate.SnapshotBytes = append(bytes.Clone(candidate.SnapshotBytes), '\n')
			case "timestamp":
				candidate.TimestampBytes = append(bytes.Clone(candidate.TimestampBytes), '\n')
			case "checkpoint-trust":
				fixture.store.checkpoint.RepositoryID = "other"
			case "checkpoint-hash":
				fixture.store.checkpoint.Timestamp.SHA256 = digestHex([]byte("other"))
			}
			if _, err := controller.ConfirmPublished(context.Background(), candidate, prior); err == nil {
				t.Fatal("substituted metadata or checkpoint was confirmed")
			}
			if fixture.store.casCalls != before {
				t.Fatal("failed confirmation wrote state")
			}
		})
	}
	fixture, controller, store, candidate, _ := confirmedPublicationFixture(t)
	before := fixture.store.casCalls
	for _, prior := range []int64{-1, maxSafeInteger} {
		if _, err := controller.ConfirmPublished(context.Background(), candidate, prior); err == nil {
			t.Fatal("invalid prior revision accepted")
		}
	}
	if _, err := controller.ConfirmPublished(nil, candidate, 1); err == nil {
		t.Fatal("nil context accepted")
	}
	var missing *PublicationController
	if _, err := missing.ConfirmPublished(context.Background(), candidate, 1); err == nil {
		t.Fatal("nil controller accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := controller.ConfirmPublished(ctx, candidate, 1); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled context was not rejected: %v", err)
	}
	if store.reads != 0 || fixture.store.casCalls != before {
		t.Fatal("invalid confirmation arguments accessed state")
	}
}

func TestPublishedConfirmationRejectsConcurrentStateClockAndCancellationChanges(t *testing.T) {
	for _, scenario := range []string{"revision", "same-revision-bytes", "missing-reload", "slow-first-load", "slow-reload", "clock-rollback", "cancel"} {
		t.Run(scenario, func(t *testing.T) {
			fixture, controller, store, candidate, prior := confirmedPublicationFixture(t)
			before := fixture.store.casCalls
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			store.onRead = func(read int) {
				if scenario == "slow-first-load" && read == 1 {
					fixture.now = fixture.now.Add(19 * time.Hour)
				}
				if read != 2 {
					return
				}
				switch scenario {
				case "revision":
					fixture.store.checkpoint.Revision++
				case "same-revision-bytes":
					fixture.store.checkpoint.Timestamp.Bytes = append(fixture.store.checkpoint.Timestamp.Bytes, '\n')
				case "missing-reload":
					fixture.store.checkpoint = nil
				case "slow-reload":
					fixture.now = fixture.now.Add(time.Minute + time.Second)
				case "clock-rollback":
					fixture.now = fixture.now.Add(-time.Second)
				case "cancel":
					cancel()
				}
			}
			if _, err := controller.ConfirmPublished(ctx, candidate, prior); err == nil {
				t.Fatal("changed state/clock/context was confirmed")
			}
			if fixture.store.casCalls != before {
				t.Fatal("confirmation wrote state")
			}
		})
	}
}

func TestPublishedConfirmationUsesActualFreshnessAndRechecksAfterReload(t *testing.T) {
	fixture, controller, store, candidate, prior := confirmedPublicationFixture(t)
	// A six-hour timestamp floor is sufficient for confirmation, unlike the
	// additional thirty minutes reserved before a fresh upload.
	fixture.now = fixture.now.Add(18 * time.Hour)
	before := fixture.store.casCalls
	if _, err := controller.ConfirmPublished(context.Background(), candidate, prior); err != nil {
		t.Fatalf("actual-time freshness floor was not accepted: %v", err)
	}
	store.reads = 0
	store.onRead = func(read int) {
		if read == 2 {
			fixture.now = fixture.now.Add(time.Second)
		}
	}
	if _, err := controller.ConfirmPublished(context.Background(), candidate, prior); err == nil {
		t.Fatal("confirmation crossed its freshness floor during the second read")
	}
	store.onRead = nil
	fixture.now = fixture.now.Add(7 * time.Hour)
	if _, err := controller.ConfirmPublished(context.Background(), candidate, prior); err == nil {
		t.Fatal("expired published metadata confirmed a successful publication")
	}
	if fixture.store.casCalls != before {
		t.Fatal("confirmation freshness checks wrote state")
	}
}
