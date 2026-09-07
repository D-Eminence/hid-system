package signingbroker

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/repository"
)

// BootstrapPublished creates revision 1 only from an all-version-1 generation
// whose exact root hash equals the independently configured bootstrap pin.
func (broker *Broker) BootstrapPublished(ctx context.Context, published PublishedGeneration) (Checkpoint, error) {
	if broker == nil {
		return Checkpoint{}, errors.New("signing-broker is required")
	}
	controller := PublicationController{
		config: PublicationConfig{
			Environment: broker.config.Environment, RepositoryID: broker.config.RepositoryID,
			StateID: broker.config.StateID, BootstrapRootSHA256: broker.config.BootstrapRootSHA256,
		},
		store: broker.store, now: broker.now,
	}
	return controller.BootstrapPublished(ctx, published)
}

func (controller *PublicationController) BootstrapPublished(ctx context.Context, published PublishedGeneration) (Checkpoint, error) {
	if controller == nil || isNil(ctx) {
		return Checkpoint{}, errors.New("signing-broker and context are required")
	}
	now := controller.now().UTC().Truncate(time.Second)
	if published.Environment != controller.config.Environment || !releaseIDPattern.MatchString(published.ReleaseID) {
		return Checkpoint{}, errors.New("published bootstrap context does not match fixed configuration")
	}
	state, err := repository.ValidateMetadataSet(repository.MetadataSet{
		Environment: published.Environment, ReleaseID: published.ReleaseID, ReferenceTime: now, RequireFresh: true,
		RootBytes: published.RootBytes, TargetsBytes: published.TargetsBytes,
		SnapshotBytes: published.SnapshotBytes, TimestampBytes: published.TimestampBytes,
	})
	if err != nil {
		return Checkpoint{}, fmt.Errorf("validate published bootstrap generation: %w", err)
	}
	if state.RootVersion != 1 || state.TargetsVersion != 1 || state.SnapshotVersion != 1 || state.TimestampVersion != 1 ||
		state.RootSHA256 != controller.config.BootstrapRootSHA256 {
		return Checkpoint{}, errors.New("published bootstrap must be an all-version-1 generation under the fixed root")
	}
	checkpoint := Checkpoint{
		SchemaVersion: CheckpointSchemaVersion, Environment: controller.config.Environment,
		RepositoryID: controller.config.RepositoryID, StateID: controller.config.StateID,
		BootstrapRootSHA256: controller.config.BootstrapRootSHA256, Revision: 1,
		ReleaseID:                 published.ReleaseID,
		RootHistory:               []MetadataRecord{NewMetadataRecord(1, published.RootBytes)},
		Targets:                   NewMetadataRecord(1, published.TargetsBytes),
		Snapshot:                  NewMetadataRecord(1, published.SnapshotBytes),
		Timestamp:                 NewMetadataRecord(1, published.TimestampBytes),
		SnapshotVersionHighWater:  1,
		TimestampVersionHighWater: 1,
	}
	if err := validateCheckpoint(checkpoint, controller.config.trustConfig(), now); err != nil {
		return Checkpoint{}, fmt.Errorf("self-validate bootstrap checkpoint: %w", err)
	}
	if err := controller.store.CompareAndSwap(ctx, controller.config.StateID, 0, checkpoint); err != nil {
		return Checkpoint{}, fmt.Errorf("create bootstrap checkpoint: %w", err)
	}
	return cloneCheckpoint(checkpoint), nil
}

// AdvancePublished accepts only the exact complete generation authorized by
// pending broker outputs. It never signs and advances state through one CAS.
func (broker *Broker) AdvancePublished(ctx context.Context, published PublishedGeneration) (Checkpoint, error) {
	if broker == nil {
		return Checkpoint{}, errors.New("signing-broker is required")
	}
	controller := PublicationController{
		config: PublicationConfig{
			Environment: broker.config.Environment, RepositoryID: broker.config.RepositoryID,
			StateID: broker.config.StateID, BootstrapRootSHA256: broker.config.BootstrapRootSHA256,
		},
		store: broker.store, now: broker.now,
	}
	return controller.AdvancePublished(ctx, published)
}

func (controller *PublicationController) AdvancePublished(ctx context.Context, published PublishedGeneration) (Checkpoint, error) {
	if controller == nil || isNil(ctx) {
		return Checkpoint{}, errors.New("signing-broker and context are required")
	}
	now := controller.now().UTC().Truncate(time.Second)
	checkpoint, err := controller.store.Load(ctx, controller.config.StateID)
	if err != nil {
		return Checkpoint{}, fmt.Errorf("load fixed signing-broker checkpoint: %w", err)
	}
	checkpoint = cloneCheckpoint(checkpoint)
	if err := validateCheckpoint(checkpoint, controller.config.trustConfig(), now); err != nil {
		return Checkpoint{}, err
	}
	if checkpoint.PendingTimestamp == nil {
		return Checkpoint{}, errors.New("no broker-authorized timestamp is pending publication")
	}
	expectedRoot := checkpoint.RootHistory[len(checkpoint.RootHistory)-1]
	expectedTargets := checkpoint.Targets
	expectedSnapshot := checkpoint.Snapshot
	expectedRelease := checkpoint.ReleaseID
	if checkpoint.PendingSnapshot != nil {
		expectedRoot = checkpoint.PendingSnapshot.Root
		expectedTargets = checkpoint.PendingSnapshot.Targets
		expectedSnapshot = checkpoint.PendingSnapshot.Snapshot
		expectedRelease = checkpoint.PendingSnapshot.ReleaseID
	}
	expectedTimestamp := checkpoint.PendingTimestamp.Timestamp
	if published.Environment != controller.config.Environment || published.ReleaseID != expectedRelease ||
		!bytes.Equal(published.RootBytes, expectedRoot.Bytes) || !bytes.Equal(published.TargetsBytes, expectedTargets.Bytes) ||
		!bytes.Equal(published.SnapshotBytes, expectedSnapshot.Bytes) || !bytes.Equal(published.TimestampBytes, expectedTimestamp.Bytes) {
		return Checkpoint{}, errors.New("published generation does not exactly match broker-authorized pending bytes")
	}
	state, err := repository.ValidateMetadataSet(repository.MetadataSet{
		Environment: published.Environment, ReleaseID: published.ReleaseID, ReferenceTime: now, RequireFresh: true,
		RootBytes: published.RootBytes, TargetsBytes: published.TargetsBytes,
		SnapshotBytes: published.SnapshotBytes, TimestampBytes: published.TimestampBytes,
	})
	if err != nil {
		return Checkpoint{}, fmt.Errorf("validate published pending generation: %w", err)
	}
	if !matchesRecord(expectedRoot, state.RootVersion, state.RootSHA256) ||
		!matchesRecord(expectedTargets, state.TargetsVersion, state.TargetsSHA256) ||
		!matchesRecord(expectedSnapshot, state.SnapshotVersion, state.SnapshotSHA256) ||
		!matchesRecord(expectedTimestamp, state.TimestampVersion, state.TimestampSHA256) {
		return Checkpoint{}, errors.New("published generation derived state differs from pending authorization")
	}
	next := cloneCheckpoint(checkpoint)
	next.Revision++
	next.ReleaseID = expectedRelease
	currentRoot := next.RootHistory[len(next.RootHistory)-1]
	if expectedRoot.Version == currentRoot.Version+1 {
		next.RootHistory = append(next.RootHistory, cloneRecord(expectedRoot))
	}
	next.Targets = cloneRecord(expectedTargets)
	next.Snapshot = cloneRecord(expectedSnapshot)
	next.Timestamp = cloneRecord(expectedTimestamp)
	next.PendingSnapshot = nil
	next.PendingTimestamp = nil
	if err := validateCheckpoint(next, controller.config.trustConfig(), now); err != nil {
		return Checkpoint{}, fmt.Errorf("self-validate advanced checkpoint: %w", err)
	}
	if err := controller.store.CompareAndSwap(ctx, controller.config.StateID, checkpoint.Revision, next); err != nil {
		return Checkpoint{}, fmt.Errorf("advance published checkpoint: %w", err)
	}
	return cloneCheckpoint(next), nil
}

// VerifyPublished authenticates and compares the fixed public repository with
// the durable current checkpoint without signing or mutating state. Pending
// candidate output is deliberately ignored until AdvancePublished observes
// the exact complete authorized generation.
func (controller *PublicationController) VerifyPublished(ctx context.Context, published PublishedGeneration) (Checkpoint, error) {
	if controller == nil || isNil(ctx) {
		return Checkpoint{}, errors.New("signing-broker and context are required")
	}
	now := controller.now().UTC().Truncate(time.Second)
	checkpoint, err := controller.store.Load(ctx, controller.config.StateID)
	if err != nil {
		return Checkpoint{}, fmt.Errorf("load fixed signing-broker checkpoint: %w", err)
	}
	checkpoint = cloneCheckpoint(checkpoint)
	if err := validateCheckpoint(checkpoint, controller.config.trustConfig(), now); err != nil {
		return Checkpoint{}, err
	}
	currentRoot := checkpoint.RootHistory[len(checkpoint.RootHistory)-1]
	if published.Environment != controller.config.Environment || published.ReleaseID != checkpoint.ReleaseID ||
		!bytes.Equal(published.RootBytes, currentRoot.Bytes) || !bytes.Equal(published.TargetsBytes, checkpoint.Targets.Bytes) ||
		!bytes.Equal(published.SnapshotBytes, checkpoint.Snapshot.Bytes) || !bytes.Equal(published.TimestampBytes, checkpoint.Timestamp.Bytes) {
		return Checkpoint{}, errors.New("public generation does not exactly match the durable current checkpoint")
	}
	state, err := repository.ValidateMetadataSet(repository.MetadataSet{
		Environment: published.Environment, ReleaseID: published.ReleaseID, ReferenceTime: now, RequireFresh: true,
		RootBytes: published.RootBytes, TargetsBytes: published.TargetsBytes,
		SnapshotBytes: published.SnapshotBytes, TimestampBytes: published.TimestampBytes,
	})
	if err != nil {
		return Checkpoint{}, fmt.Errorf("validate public current generation: %w", err)
	}
	if !matchesRecord(currentRoot, state.RootVersion, state.RootSHA256) ||
		!matchesRecord(checkpoint.Targets, state.TargetsVersion, state.TargetsSHA256) ||
		!matchesRecord(checkpoint.Snapshot, state.SnapshotVersion, state.SnapshotSHA256) ||
		!matchesRecord(checkpoint.Timestamp, state.TimestampVersion, state.TimestampSHA256) {
		return Checkpoint{}, errors.New("public generation derived state differs from the durable current checkpoint")
	}
	return checkpoint, nil
}

// CurrentCheckpoint loads and authenticates the durable checkpoint without
// contacting a public repository or mutating state. Callers use it only to
// choose bounded, exact-version canary fetches; VerifyPublished and
// AdvancePublished independently reload state before making a decision.
func (controller *PublicationController) CurrentCheckpoint(ctx context.Context) (Checkpoint, error) {
	if controller == nil || isNil(ctx) {
		return Checkpoint{}, errors.New("signing-broker and context are required")
	}
	now := controller.now().UTC().Truncate(time.Second)
	checkpoint, err := controller.store.Load(ctx, controller.config.StateID)
	if err != nil {
		return Checkpoint{}, fmt.Errorf("load fixed signing-broker checkpoint: %w", err)
	}
	checkpoint = cloneCheckpoint(checkpoint)
	if err := validateCheckpoint(checkpoint, controller.config.trustConfig(), now); err != nil {
		return Checkpoint{}, err
	}
	return checkpoint, nil
}
