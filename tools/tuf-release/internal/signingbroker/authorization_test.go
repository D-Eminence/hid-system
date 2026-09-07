package signingbroker

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/theupdateframework/go-tuf/v2/metadata"
)

type authorizationStore struct {
	*memoryStore
	reads  int
	onRead func(int)
}

func (store *authorizationStore) Load(ctx context.Context, stateID string) (Checkpoint, error) {
	store.reads++
	if store.onRead != nil {
		store.onRead(store.reads)
	}
	return store.memoryStore.Load(ctx, stateID)
}

func publicationTestGeneration(generation testGeneration) PublishedGeneration {
	return PublishedGeneration{
		Environment: "staging", ReleaseID: generation.releaseID,
		RootBytes: generation.rootBytes, TargetsBytes: generation.targetsBytes,
		SnapshotBytes: generation.snapshotBytes, TimestampBytes: generation.timestampBytes,
	}
}

func pendingPublicationFixture(t *testing.T) (*brokerFixture, *PublicationController, *authorizationStore, PublishedGeneration, PublishedGeneration) {
	t.Helper()
	fixture := newBrokerFixture(t)
	next := fixture.generation(t, testReleaseTwo, 2, 2, 2)
	snapshotBroker := fixture.broker(t, "snapshot", "one", fixture.keys[metadata.SNAPSHOT][0],
		&trackingFactory{signer: newTrackingSigner(t, fixture.keys[metadata.SNAPSHOT][0])})
	snapshot, err := snapshotBroker.Sign(context.Background(), fixture.requestBytes(t, "snapshot", next.releaseID, next.rootBytes, next.rootVersion, next.targetsBytes, next.targetsVersion))
	if err != nil {
		t.Fatal(err)
	}
	timestampBroker := fixture.broker(t, "timestamp", "one", fixture.keys[metadata.TIMESTAMP][0],
		&trackingFactory{signer: newTrackingSigner(t, fixture.keys[metadata.TIMESTAMP][0])})
	timestamp, err := timestampBroker.Sign(context.Background(), fixture.requestBytes(t, "timestamp", next.releaseID, next.rootBytes, next.rootVersion, snapshot.OutputBytes, snapshot.OutputVersion))
	if err != nil {
		t.Fatal(err)
	}
	next.snapshotBytes, next.timestampBytes = snapshot.OutputBytes, timestamp.OutputBytes
	store := &authorizationStore{memoryStore: fixture.store}
	controller, err := NewPublicationController(PublicationConfig{
		Environment: "staging", RepositoryID: "hid-staging-v1", StateID: fixture.store.checkpoint.StateID,
		BootstrapRootSHA256: digestHex(fixture.rootBytes),
	}, store, func() time.Time { return fixture.now })
	if err != nil {
		t.Fatal(err)
	}
	return fixture, controller, store, publicationTestGeneration(fixture.initial), publicationTestGeneration(next)
}

func TestPendingPublicationAuthorizationBindsExactStateWithoutWriting(t *testing.T) {
	fixture, controller, store, current, candidate := pendingPublicationFixture(t)
	before := fixture.store.casCalls
	authorization, err := controller.AuthorizePendingPublication(context.Background(), current, candidate)
	if err != nil {
		t.Fatal(err)
	}
	if store.reads != 2 || fixture.store.casCalls != before || authorization.StateRevision != 3 ||
		authorization.Candidate.Timestamp.Version != 2 || authorization.Current.Timestamp.Version != 1 ||
		authorization.Candidate.Timestamp.SHA256 != digestHex(candidate.TimestampBytes) ||
		authorization.BootstrapRootSHA256 != digestHex(fixture.rootBytes) ||
		authorization.AuthorizedAt != fixture.now.Format(time.RFC3339) ||
		authorization.ExpiresAt != fixture.now.Add(5*time.Minute).Format(time.RFC3339) {
		t.Fatalf("authorization omitted its state, metadata or bounded time binding: %+v", authorization)
	}
	if _, err := controller.AdvancePublished(context.Background(), candidate); err != nil {
		t.Fatal(err)
	}
	if _, err := controller.AuthorizePendingPublication(context.Background(), current, candidate); err == nil {
		t.Fatal("previously authorized bytes were accepted after publication consumed pending state")
	}
}

func TestPendingPublicationAuthorizationRejectsSubstitutionAndMissingState(t *testing.T) {
	for _, part := range []string{"environment", "release", "root", "targets", "snapshot", "timestamp"} {
		for _, predecessor := range []bool{false, true} {
			t.Run(part+map[bool]string{true: "-current", false: "-candidate"}[predecessor], func(t *testing.T) {
				fixture, controller, _, current, candidate := pendingPublicationFixture(t)
				changed := &candidate
				if predecessor {
					changed = &current
				}
				switch part {
				case "environment":
					changed.Environment = "production"
				case "release":
					changed.ReleaseID = testReleaseOne
					if predecessor {
						changed.ReleaseID = testReleaseTwo
					}
				case "root":
					changed.RootBytes = append(bytes.Clone(changed.RootBytes), '\n')
				case "targets":
					changed.TargetsBytes = append(bytes.Clone(changed.TargetsBytes), '\n')
				case "snapshot":
					changed.SnapshotBytes = append(bytes.Clone(changed.SnapshotBytes), '\n')
				case "timestamp":
					changed.TimestampBytes = append(bytes.Clone(changed.TimestampBytes), '\n')
				}
				before := fixture.store.casCalls
				if _, err := controller.AuthorizePendingPublication(context.Background(), current, candidate); err == nil {
					t.Fatal("substituted metadata was authorized")
				}
				if fixture.store.casCalls != before {
					t.Fatal("authorization wrote state")
				}
			})
		}
	}
	fixture, controller, _, current, candidate := pendingPublicationFixture(t)
	fixture.store.checkpoint = nil
	if _, err := controller.AuthorizePendingPublication(context.Background(), current, candidate); !errors.Is(err, ErrStateNotFound) {
		t.Fatalf("missing state was not rejected: %v", err)
	}
}

func TestPendingPublicationAuthorizationRejectsConcurrentStateAndClockChanges(t *testing.T) {
	for _, scenario := range []string{"revision", "same-revision-bytes", "slow-load", "slow-reload", "clock-rollback", "cancel"} {
		t.Run(scenario, func(t *testing.T) {
			fixture, controller, store, current, candidate := pendingPublicationFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			store.onRead = func(read int) {
				if scenario == "slow-load" && read == 1 {
					fixture.now = fixture.now.Add(19 * time.Hour)
				}
				if read != 2 {
					return
				}
				switch scenario {
				case "revision":
					fixture.store.checkpoint.Revision++
				case "same-revision-bytes":
					fixture.store.checkpoint.PendingTimestamp.Timestamp.Bytes = append(fixture.store.checkpoint.PendingTimestamp.Timestamp.Bytes, '\n')
				case "slow-reload":
					fixture.now = fixture.now.Add(time.Minute + time.Second)
				case "clock-rollback":
					fixture.now = fixture.now.Add(-time.Second)
				case "cancel":
					cancel()
				}
			}
			if _, err := controller.AuthorizePendingPublication(ctx, current, candidate); err == nil {
				t.Fatal("state or clock change was authorized")
			}
		})
	}
}

func TestBootstrapPublicationAuthorizationRequiresPinnedRootAndAbsentState(t *testing.T) {
	fixture, controller, store, _, _ := pendingPublicationFixture(t)
	candidate := publicationTestGeneration(fixture.initial)
	if _, err := controller.AuthorizeBootstrapPublication(context.Background(), candidate); err == nil {
		t.Fatal("bootstrap authorized with populated state")
	}
	fixture.store.checkpoint = nil
	before := fixture.store.casCalls
	decision, err := controller.AuthorizeBootstrapPublication(context.Background(), candidate)
	if err != nil {
		t.Fatal(err)
	}
	if decision.StateRevision != 0 || decision.Candidate.Root.SHA256 != digestHex(candidate.RootBytes) || fixture.store.casCalls != before {
		t.Fatal("bootstrap authorization changed state or root")
	}
	other := newBrokerFixture(t)
	if _, err := controller.AuthorizeBootstrapPublication(context.Background(), publicationTestGeneration(other.initial)); err == nil {
		t.Fatal("different bootstrap authority accepted")
	}
	store.reads = 0
	store.onRead = func(read int) {
		if read == 2 {
			fixture.store.checkpoint = other.store.checkpoint
		}
	}
	if _, err := controller.AuthorizeBootstrapPublication(context.Background(), candidate); !errors.Is(err, ErrStateConflict) {
		t.Fatalf("concurrent bootstrap not rejected: %v", err)
	}
}
