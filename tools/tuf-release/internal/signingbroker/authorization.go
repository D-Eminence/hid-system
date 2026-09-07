package signingbroker

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"reflect"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/repository"
)

// PublicationAuthorization is short-lived evidence of a fresh state read, not
// a bearer token or a state lock. Publishers must obtain it again at every
// external boundary and serialize publication for each environment.
type PublicationAuthorization struct {
	SchemaVersion       string              `json:"schema_version"`
	Environment         string              `json:"environment"`
	RepositoryID        string              `json:"repository_id"`
	StateID             string              `json:"state_id"`
	BootstrapRootSHA256 string              `json:"bootstrap_root_sha256"`
	StateRevision       int64               `json:"state_revision"`
	ReleaseID           string              `json:"release_id"`
	AuthorizedAt        string              `json:"authorized_at"`
	ExpiresAt           string              `json:"expires_at"`
	Current             PublicationMetadata `json:"current"`
	Candidate           PublicationMetadata `json:"candidate"`
}

type PublicationMetadata struct {
	Root      PublicationRole `json:"root"`
	Targets   PublicationRole `json:"targets"`
	Snapshot  PublicationRole `json:"snapshot"`
	Timestamp PublicationRole `json:"timestamp"`
}

type PublicationRole struct {
	Version int64  `json:"version"`
	SHA256  string `json:"sha256"`
}

// AuthorizeMaterialization connects the repository's private recovered-output
// constructor to the same fresh authorization used at the upload boundary.
func (controller *PublicationController) AuthorizeMaterialization(ctx context.Context, current, candidate repository.MetadataSet) error {
	convert := func(set repository.MetadataSet) PublishedGeneration {
		return PublishedGeneration{Environment: set.Environment, ReleaseID: set.ReleaseID, RootBytes: set.RootBytes,
			TargetsBytes: set.TargetsBytes, SnapshotBytes: set.SnapshotBytes, TimestampBytes: set.TimestampBytes}
	}
	_, err := controller.AuthorizePendingPublication(ctx, convert(current), convert(candidate))
	return err
}

// AuthorizeBootstrapPublication permits only the independently pinned,
// all-version-one repository while durable state is still absent. It does
// not initialize state; the public canary performs that separate transition.
func (controller *PublicationController) AuthorizeBootstrapPublication(ctx context.Context, candidate PublishedGeneration) (PublicationAuthorization, error) {
	if controller == nil || isNil(ctx) {
		return PublicationAuthorization{}, errors.New("publication controller and context are required")
	}
	if err := ctx.Err(); err != nil {
		return PublicationAuthorization{}, err
	}
	if _, err := controller.store.Load(ctx, controller.config.StateID); !errors.Is(err, ErrStateNotFound) {
		if err != nil {
			return PublicationAuthorization{}, err
		}
		return PublicationAuthorization{}, errors.New("bootstrap publication requires absent durable state")
	}
	now := controller.now().UTC().Truncate(time.Second)
	if candidate.Environment != controller.config.Environment {
		return PublicationAuthorization{}, errors.New("bootstrap publication environment differs from fixed configuration")
	}
	state, err := repository.ValidateMetadataSet(repository.MetadataSet{
		Environment: candidate.Environment, ReleaseID: candidate.ReleaseID, ReferenceTime: now.Add(publicationSafetyMargin), RequireFresh: true,
		RootBytes: candidate.RootBytes, TargetsBytes: candidate.TargetsBytes, SnapshotBytes: candidate.SnapshotBytes, TimestampBytes: candidate.TimestampBytes,
	})
	if err != nil {
		return PublicationAuthorization{}, err
	}
	if state.RootVersion != 1 || state.TargetsVersion != 1 || state.SnapshotVersion != 1 || state.TimestampVersion != 1 || state.RootSHA256 != controller.config.BootstrapRootSHA256 {
		return PublicationAuthorization{}, errors.New("bootstrap publication must use the fixed all-version-one root")
	}
	if _, err := controller.store.Load(ctx, controller.config.StateID); !errors.Is(err, ErrStateNotFound) {
		if err != nil {
			return PublicationAuthorization{}, err
		}
		return PublicationAuthorization{}, ErrStateConflict
	}
	if err := ctx.Err(); err != nil {
		return PublicationAuthorization{}, err
	}
	finished := controller.now().UTC().Truncate(time.Second)
	if finished.Before(now) || finished.Sub(now) > time.Minute {
		return PublicationAuthorization{}, errors.New("bootstrap publication authorization clock moved or validation exceeded one minute")
	}
	return PublicationAuthorization{
		SchemaVersion: SchemaVersion, Environment: controller.config.Environment, RepositoryID: controller.config.RepositoryID,
		StateID: controller.config.StateID, BootstrapRootSHA256: controller.config.BootstrapRootSHA256, ReleaseID: candidate.ReleaseID,
		AuthorizedAt: now.Format(time.RFC3339), ExpiresAt: now.Add(5 * time.Minute).Format(time.RFC3339),
		Candidate: publicationMetadata(NewMetadataRecord(1, candidate.RootBytes), NewMetadataRecord(1, candidate.TargetsBytes), NewMetadataRecord(1, candidate.SnapshotBytes), NewMetadataRecord(1, candidate.TimestampBytes)),
	}, nil
}

// AuthorizePendingPublication authenticates both the actual predecessor and
// the exact pending candidate against freshly loaded durable state. Expired
// published metadata may be recovered; the candidate must retain the full
// publication margin. No signing or state mutation occurs. Repository file
// closure, immutability and hashes are independently checked by the publisher.
func (controller *PublicationController) AuthorizePendingPublication(ctx context.Context, current, candidate PublishedGeneration) (PublicationAuthorization, error) {
	if controller == nil || isNil(ctx) {
		return PublicationAuthorization{}, errors.New("publication controller and context are required")
	}
	if err := ctx.Err(); err != nil {
		return PublicationAuthorization{}, err
	}
	checkpoint, err := controller.store.Load(ctx, controller.config.StateID)
	if err != nil {
		return PublicationAuthorization{}, fmt.Errorf("load publication authorization checkpoint: %w", err)
	}
	checkpoint = cloneCheckpoint(checkpoint)
	// Sample after the potentially slow storage read; a pre-read clock can
	// authorize metadata that expired while the immutable objects were loaded.
	now := controller.now().UTC().Truncate(time.Second)
	if err := validateCheckpoint(checkpoint, controller.config.trustConfig(), now); err != nil {
		return PublicationAuthorization{}, err
	}
	currentRoot := checkpoint.RootHistory[len(checkpoint.RootHistory)-1]
	if !matchesPublication(current, checkpoint.Environment, checkpoint.ReleaseID,
		currentRoot, checkpoint.Targets, checkpoint.Snapshot, checkpoint.Timestamp) {
		return PublicationAuthorization{}, errors.New("publication predecessor does not exactly match durable current metadata")
	}
	if checkpoint.PendingTimestamp == nil {
		return PublicationAuthorization{}, errors.New("no broker-authorized timestamp is pending publication")
	}
	root, targets, snapshot, releaseID := currentRoot, checkpoint.Targets, checkpoint.Snapshot, checkpoint.ReleaseID
	if pending := checkpoint.PendingSnapshot; pending != nil {
		root, targets, snapshot, releaseID = pending.Root, pending.Targets, pending.Snapshot, pending.ReleaseID
	}
	timestamp := checkpoint.PendingTimestamp.Timestamp
	if !matchesPublication(candidate, checkpoint.Environment, releaseID, root, targets, snapshot, timestamp) {
		return PublicationAuthorization{}, errors.New("publication candidate does not exactly match broker-authorized pending bytes")
	}
	if _, err := repository.ValidateMetadataSet(repository.MetadataSet{
		Environment: candidate.Environment, ReleaseID: candidate.ReleaseID,
		ReferenceTime: now.Add(publicationSafetyMargin), RequireFresh: true,
		RootBytes: candidate.RootBytes, TargetsBytes: candidate.TargetsBytes,
		SnapshotBytes: candidate.SnapshotBytes, TimestampBytes: candidate.TimestampBytes,
	}); err != nil {
		return PublicationAuthorization{}, fmt.Errorf("publication candidate lacks freshness margin: %w", err)
	}
	// Re-read after validation so an intervening signing/canary CAS invalidates
	// this decision. The immutable store contract forbids same-revision rewrites;
	// compare the full checkpoint too, so faulty adapters also fail closed.
	latest, err := controller.store.Load(ctx, controller.config.StateID)
	if err != nil {
		return PublicationAuthorization{}, fmt.Errorf("reload publication authorization checkpoint: %w", err)
	}
	if !reflect.DeepEqual(checkpoint, latest) {
		return PublicationAuthorization{}, ErrStateConflict
	}
	if err := ctx.Err(); err != nil {
		return PublicationAuthorization{}, err
	}
	finished := controller.now().UTC().Truncate(time.Second)
	if finished.Before(now) || finished.Sub(now) > time.Minute {
		return PublicationAuthorization{}, errors.New("publication authorization clock moved or state validation exceeded one minute")
	}
	return PublicationAuthorization{
		SchemaVersion: SchemaVersion, Environment: checkpoint.Environment, RepositoryID: checkpoint.RepositoryID,
		StateID: checkpoint.StateID, BootstrapRootSHA256: checkpoint.BootstrapRootSHA256,
		StateRevision: checkpoint.Revision, ReleaseID: releaseID,
		AuthorizedAt: now.Format(time.RFC3339), ExpiresAt: now.Add(5 * time.Minute).Format(time.RFC3339),
		Current:   publicationMetadata(currentRoot, checkpoint.Targets, checkpoint.Snapshot, checkpoint.Timestamp),
		Candidate: publicationMetadata(root, targets, snapshot, timestamp),
	}, nil
}

func matchesPublication(generation PublishedGeneration, environment, releaseID string, root, targets, snapshot, timestamp MetadataRecord) bool {
	return generation.Environment == environment && generation.ReleaseID == releaseID &&
		bytes.Equal(generation.RootBytes, root.Bytes) && bytes.Equal(generation.TargetsBytes, targets.Bytes) &&
		bytes.Equal(generation.SnapshotBytes, snapshot.Bytes) && bytes.Equal(generation.TimestampBytes, timestamp.Bytes)
}

func publicationMetadata(root, targets, snapshot, timestamp MetadataRecord) PublicationMetadata {
	role := func(record MetadataRecord) PublicationRole {
		return PublicationRole{Version: record.Version, SHA256: record.SHA256}
	}
	return PublicationMetadata{Root: role(root), Targets: role(targets), Snapshot: role(snapshot), Timestamp: role(timestamp)}
}
