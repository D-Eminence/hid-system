package signingbroker

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/repository"
)

// PublicationConfirmation records a fresh observation of the durable published
// checkpoint. It is neither permission to publish nor a lock or a claim that
// public endpoints cannot change after this observation. Repository file
// closure and its independently retained hash remain the operator's concern.
type PublicationConfirmation struct {
	SchemaVersion       string              `json:"schema_version"`
	Environment         string              `json:"environment"`
	RepositoryID        string              `json:"repository_id"`
	StateID             string              `json:"state_id"`
	BootstrapRootSHA256 string              `json:"bootstrap_root_sha256"`
	PriorStateRevision  int64               `json:"prior_state_revision"`
	StateRevision       int64               `json:"state_revision"`
	ReleaseID           string              `json:"release_id"`
	ConfirmedAt         string              `json:"confirmed_at"`
	Published           PublicationMetadata `json:"published"`
}

// ConfirmPublished authenticates exact candidate bytes as the durable current
// generation at a revision newer than the publication attempt's prior state.
// Pending metadata is never confirmation. This operation does not fetch public
// endpoints, sign, invoke the canary, or mutate its checkpoint.
func (controller *PublicationController) ConfirmPublished(ctx context.Context, candidate PublishedGeneration, expectedPriorRevision int64) (PublicationConfirmation, error) {
	if controller == nil || isNil(ctx) {
		return PublicationConfirmation{}, errors.New("publication controller and context are required")
	}
	if expectedPriorRevision < 0 || expectedPriorRevision >= maxSafeInteger {
		return PublicationConfirmation{}, errors.New("prior publication revision is outside the safe range")
	}
	if err := ctx.Err(); err != nil {
		return PublicationConfirmation{}, err
	}
	checkpoint, err := controller.store.Load(ctx, controller.config.StateID)
	if err != nil {
		return PublicationConfirmation{}, fmt.Errorf("load publication confirmation checkpoint: %w", err)
	}
	checkpoint = cloneCheckpoint(checkpoint)
	// Storage reads may be slow: freshness is evaluated after the first read.
	now := controller.now().UTC().Truncate(time.Second)
	if err := validateCheckpoint(checkpoint, controller.config.trustConfig(), now); err != nil {
		return PublicationConfirmation{}, err
	}
	if checkpoint.Revision <= expectedPriorRevision {
		return PublicationConfirmation{}, errors.New("published checkpoint has not advanced beyond the prior publication revision")
	}
	root := checkpoint.RootHistory[len(checkpoint.RootHistory)-1]
	if !matchesPublication(candidate, checkpoint.Environment, checkpoint.ReleaseID,
		root, checkpoint.Targets, checkpoint.Snapshot, checkpoint.Timestamp) {
		return PublicationConfirmation{}, errors.New("confirmation candidate does not exactly match durable published metadata")
	}
	if expectedPriorRevision == 0 && (root.Version != 1 || checkpoint.Targets.Version != 1 ||
		checkpoint.Snapshot.Version != 1 || checkpoint.Timestamp.Version != 1) {
		return PublicationConfirmation{}, errors.New("zero prior revision requires the all-version-one bootstrap generation")
	}
	validateFresh := func(reference time.Time) error {
		// Confirmation is post-publication observation, so use the canary's
		// actual-time policy floors, without reserving another upload margin.
		// Expired/below-floor metadata remains diagnosable but cannot close a
		// successful publication attempt.
		_, err := repository.ValidateMetadataSet(repository.MetadataSet{
			Environment: candidate.Environment, ReleaseID: candidate.ReleaseID,
			ReferenceTime: reference, RequireFresh: true,
			RootBytes: candidate.RootBytes, TargetsBytes: candidate.TargetsBytes,
			SnapshotBytes: candidate.SnapshotBytes, TimestampBytes: candidate.TimestampBytes,
		})
		if err != nil {
			return fmt.Errorf("published confirmation candidate lacks current freshness: %w", err)
		}
		return nil
	}
	if err := validateFresh(now); err != nil {
		return PublicationConfirmation{}, err
	}
	latest, err := controller.store.Load(ctx, controller.config.StateID)
	if err != nil {
		return PublicationConfirmation{}, fmt.Errorf("reload publication confirmation checkpoint: %w", err)
	}
	if !reflect.DeepEqual(checkpoint, latest) {
		return PublicationConfirmation{}, ErrStateConflict
	}
	if err := ctx.Err(); err != nil {
		return PublicationConfirmation{}, err
	}
	finished := controller.now().UTC().Truncate(time.Second)
	if finished.Before(now) || finished.Sub(now) > time.Minute {
		return PublicationConfirmation{}, errors.New("publication confirmation clock moved or validation exceeded one minute")
	}
	// Unlike pre-upload authorization, this observation has no safety margin.
	// Recheck at completion so a slow reload cannot cross a policy floor.
	if err := validateFresh(finished); err != nil {
		return PublicationConfirmation{}, err
	}
	if err := ctx.Err(); err != nil {
		return PublicationConfirmation{}, err
	}
	return PublicationConfirmation{
		SchemaVersion: SchemaVersion, Environment: checkpoint.Environment,
		RepositoryID: checkpoint.RepositoryID, StateID: checkpoint.StateID,
		BootstrapRootSHA256: checkpoint.BootstrapRootSHA256,
		PriorStateRevision:  expectedPriorRevision, StateRevision: checkpoint.Revision,
		ReleaseID: checkpoint.ReleaseID, ConfirmedAt: finished.Format(time.RFC3339),
		Published: publicationMetadata(root, checkpoint.Targets, checkpoint.Snapshot, checkpoint.Timestamp),
	}, nil
}
