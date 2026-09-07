package signingbroker

import (
	"bytes"
	"errors"
	"fmt"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/repository"
)

func NewMetadataRecord(version int64, data []byte) MetadataRecord {
	return MetadataRecord{Version: version, SHA256: digestHex(data), Bytes: bytes.Clone(data)}
}

func validateCheckpoint(checkpoint Checkpoint, config fixedTrustConfig, reference time.Time) error {
	if checkpoint.SchemaVersion != CheckpointSchemaVersion || checkpoint.Environment != config.environment ||
		checkpoint.RepositoryID != config.repositoryID || checkpoint.StateID != config.stateID ||
		checkpoint.BootstrapRootSHA256 != config.bootstrapRootSHA256 {
		return errors.New("signing-broker checkpoint context does not match fixed configuration")
	}
	if checkpoint.Revision < 1 || checkpoint.Revision >= maxSafeInteger {
		return errors.New("signing-broker checkpoint revision is outside the advanceable safe range")
	}
	if !releaseIDPattern.MatchString(checkpoint.ReleaseID) {
		return errors.New("signing-broker checkpoint release ID is invalid")
	}
	if len(checkpoint.RootHistory) == 0 || len(checkpoint.RootHistory) > MaxRootHistoryRecords {
		return errors.New("signing-broker checkpoint root history count is invalid")
	}
	rootBytes := make([][]byte, len(checkpoint.RootHistory))
	for index, record := range checkpoint.RootHistory {
		if err := validateRecord(record, repository.MaxRootMetadataBytes, fmt.Sprintf("root history %d", index)); err != nil {
			return err
		}
		rootBytes[index] = bytes.Clone(record.Bytes)
	}
	rootHistory, err := repository.ValidateRootHistory(rootBytes, reference, false)
	if err != nil {
		return fmt.Errorf("validate signing-broker root history: %w", err)
	}
	first := checkpoint.RootHistory[0]
	latest := checkpoint.RootHistory[len(checkpoint.RootHistory)-1]
	if rootHistory.FirstVersion != 1 || first.Version != 1 || first.SHA256 != config.bootstrapRootSHA256 ||
		rootHistory.FirstSHA256 != config.bootstrapRootSHA256 || rootHistory.LatestVersion != latest.Version ||
		rootHistory.LatestSHA256 != latest.SHA256 {
		return errors.New("signing-broker root history is not anchored at its fixed version-1 bootstrap root")
	}
	if err := validateRecord(checkpoint.Targets, repository.MaxTargetsMetadataBytes, "current targets"); err != nil {
		return err
	}
	if err := validateRecord(checkpoint.Snapshot, repository.MaxSnapshotMetadataBytes, "current snapshot"); err != nil {
		return err
	}
	if err := validateRecord(checkpoint.Timestamp, repository.MaxTimestampMetadataBytes, "current timestamp"); err != nil {
		return err
	}
	current, err := repository.ValidateMetadataSet(repository.MetadataSet{
		Environment: checkpoint.Environment, ReleaseID: checkpoint.ReleaseID, ReferenceTime: reference,
		RequireFresh: false, RootBytes: latest.Bytes, TargetsBytes: checkpoint.Targets.Bytes,
		SnapshotBytes: checkpoint.Snapshot.Bytes, TimestampBytes: checkpoint.Timestamp.Bytes,
	})
	if err != nil {
		return fmt.Errorf("validate signing-broker current metadata: %w", err)
	}
	if !matchesRecord(latest, current.RootVersion, current.RootSHA256) ||
		!matchesRecord(checkpoint.Targets, current.TargetsVersion, current.TargetsSHA256) ||
		!matchesRecord(checkpoint.Snapshot, current.SnapshotVersion, current.SnapshotSHA256) ||
		!matchesRecord(checkpoint.Timestamp, current.TimestampVersion, current.TimestampSHA256) {
		return errors.New("signing-broker checkpoint records do not match authenticated metadata")
	}
	if checkpoint.SnapshotVersionHighWater < checkpoint.Snapshot.Version ||
		checkpoint.SnapshotVersionHighWater > maxSafeInteger ||
		checkpoint.TimestampVersionHighWater < checkpoint.Timestamp.Version ||
		checkpoint.TimestampVersionHighWater > maxSafeInteger {
		return errors.New("signing-broker checkpoint online-role high-water marks are invalid")
	}
	if checkpoint.PendingSnapshot == nil && checkpoint.SnapshotVersionHighWater != checkpoint.Snapshot.Version {
		return errors.New("signing-broker snapshot high-water mark requires its pending output")
	}
	if checkpoint.PendingTimestamp == nil && checkpoint.TimestampVersionHighWater != checkpoint.Timestamp.Version &&
		checkpoint.PendingSnapshot == nil {
		return errors.New("signing-broker burned timestamp high-water mark requires a replacement snapshot")
	}
	if checkpoint.PendingSnapshot != nil {
		if err := validatePendingSnapshot(checkpoint, *checkpoint.PendingSnapshot, reference); err != nil {
			return err
		}
	}
	if checkpoint.PendingTimestamp != nil {
		if err := validatePendingTimestamp(checkpoint, *checkpoint.PendingTimestamp, reference); err != nil {
			return err
		}
	}
	return nil
}

func validatePendingSnapshot(checkpoint Checkpoint, pending PendingSnapshot, reference time.Time) error {
	if !validCandidateID(pending.CandidateID) || !sha256Pattern.MatchString(pending.RequestSHA256) ||
		!releaseIDPattern.MatchString(pending.ReleaseID) || pending.StateRevision < 1 ||
		pending.StateRevision > checkpoint.Revision {
		return errors.New("pending snapshot identity is invalid")
	}
	if pending.RequestObject != nil {
		prefix := fmt.Sprintf(
			"tuf-signing-broker/requests/%s/snapshot-%s/",
			checkpoint.StateID,
			pending.CandidateID,
		)
		if err := validateImmutableRequestObjectIdentity(*pending.RequestObject, prefix, pending.RequestSHA256); err != nil {
			return fmt.Errorf("pending snapshot request source: %w", err)
		}
	}
	createdAt, err := parseWholeSecondUTC(pending.CreatedAt, "pending snapshot created_at")
	if err != nil || createdAt.After(reference.Add(time.Minute)) {
		return errors.New("pending snapshot creation time is invalid")
	}
	if err := validateRecord(pending.Root, repository.MaxRootMetadataBytes, "pending snapshot root"); err != nil {
		return err
	}
	if err := validateRecord(pending.Targets, repository.MaxTargetsMetadataBytes, "pending snapshot targets"); err != nil {
		return err
	}
	if err := validateRecord(pending.Snapshot, repository.MaxSnapshotMetadataBytes, "pending snapshot metadata"); err != nil {
		return err
	}
	currentRoot := checkpoint.RootHistory[len(checkpoint.RootHistory)-1]
	if err := validateRootTransition(checkpoint.RootHistory, currentRoot, pending.Root, reference); err != nil {
		return fmt.Errorf("pending snapshot root transition: %w", err)
	}
	if !sameOrNext(checkpoint.Targets, pending.Targets) {
		return errors.New("pending targets must remain exact or advance one version")
	}
	if pending.Snapshot.Version != checkpoint.SnapshotVersionHighWater ||
		pending.Snapshot.Version <= checkpoint.Snapshot.Version {
		return errors.New("pending snapshot output does not equal the checkpoint high-water mark")
	}
	derived, err := repository.ValidateSnapshotSet(repository.SnapshotSet{
		Environment: checkpoint.Environment, ReleaseID: pending.ReleaseID, ReferenceTime: reference,
		RequireFresh: false, RootBytes: pending.Root.Bytes, TargetsBytes: pending.Targets.Bytes,
		SnapshotBytes: pending.Snapshot.Bytes,
	})
	if err != nil {
		return fmt.Errorf("validate pending snapshot metadata: %w", err)
	}
	if !matchesRecord(pending.Root, derived.RootVersion, derived.RootSHA256) ||
		!matchesRecord(pending.Targets, derived.TargetsVersion, derived.TargetsSHA256) ||
		!matchesRecord(pending.Snapshot, derived.SnapshotVersion, derived.SnapshotSHA256) {
		return errors.New("pending snapshot records do not match authenticated metadata")
	}
	return nil
}

func validatePendingTimestamp(checkpoint Checkpoint, pending PendingTimestamp, reference time.Time) error {
	if !validCandidateID(pending.CandidateID) || !sha256Pattern.MatchString(pending.RequestSHA256) ||
		!releaseIDPattern.MatchString(pending.ReleaseID) || pending.StateRevision < 1 ||
		pending.StateRevision > checkpoint.Revision {
		return errors.New("pending timestamp identity is invalid")
	}
	if pending.RequestObject != nil {
		prefix := fmt.Sprintf(
			"tuf-signing-broker/requests/%s/timestamp-%s/",
			checkpoint.StateID,
			pending.CandidateID,
		)
		if err := validateImmutableRequestObjectIdentity(*pending.RequestObject, prefix, pending.RequestSHA256); err != nil {
			return fmt.Errorf("pending timestamp request source: %w", err)
		}
	}
	createdAt, err := parseWholeSecondUTC(pending.CreatedAt, "pending timestamp created_at")
	if err != nil || createdAt.After(reference.Add(time.Minute)) {
		return errors.New("pending timestamp creation time is invalid")
	}
	if err := validateRecord(pending.Root, repository.MaxRootMetadataBytes, "pending timestamp root"); err != nil {
		return err
	}
	if err := validateRecord(pending.Snapshot, repository.MaxSnapshotMetadataBytes, "pending timestamp snapshot"); err != nil {
		return err
	}
	if err := validateRecord(pending.Timestamp, repository.MaxTimestampMetadataBytes, "pending timestamp metadata"); err != nil {
		return err
	}
	expectedRoot := checkpoint.RootHistory[len(checkpoint.RootHistory)-1]
	expectedSnapshot := checkpoint.Snapshot
	expectedRelease := checkpoint.ReleaseID
	if checkpoint.PendingSnapshot != nil {
		expectedRoot = checkpoint.PendingSnapshot.Root
		expectedSnapshot = checkpoint.PendingSnapshot.Snapshot
		expectedRelease = checkpoint.PendingSnapshot.ReleaseID
	}
	if pending.ReleaseID != expectedRelease || !sameRecord(pending.Root, expectedRoot) || !sameRecord(pending.Snapshot, expectedSnapshot) {
		return errors.New("pending timestamp does not select the broker-authorized snapshot context")
	}
	if pending.Timestamp.Version != checkpoint.TimestampVersionHighWater ||
		pending.Timestamp.Version <= checkpoint.Timestamp.Version {
		return errors.New("pending timestamp output does not equal the checkpoint high-water mark")
	}
	derived, err := repository.ValidateTimestampSet(repository.TimestampSet{
		ReferenceTime: reference, RequireFresh: false, RootBytes: pending.Root.Bytes,
		SnapshotBytes: pending.Snapshot.Bytes, TimestampBytes: pending.Timestamp.Bytes,
	})
	if err != nil {
		return fmt.Errorf("validate pending timestamp metadata: %w", err)
	}
	if !matchesRecord(pending.Root, derived.RootVersion, derived.RootSHA256) ||
		!matchesRecord(pending.Snapshot, derived.SnapshotVersion, derived.SnapshotSHA256) ||
		!matchesRecord(pending.Timestamp, derived.TimestampVersion, derived.TimestampSHA256) {
		return errors.New("pending timestamp records do not match authenticated metadata")
	}
	return nil
}

func validateRecord(record MetadataRecord, maximum int, label string) error {
	if record.Version < 1 || record.Version > maxSafeInteger || !sha256Pattern.MatchString(record.SHA256) ||
		len(record.Bytes) == 0 || len(record.Bytes) > maximum || digestHex(record.Bytes) != record.SHA256 {
		return fmt.Errorf("%s record is invalid", label)
	}
	return nil
}

func matchesRecord(record MetadataRecord, version int64, hash string) bool {
	return record.Version == version && record.SHA256 == hash
}

func sameRecord(left, right MetadataRecord) bool {
	return left.Version == right.Version && left.SHA256 == right.SHA256 && bytes.Equal(left.Bytes, right.Bytes)
}

func sameOrNext(current, candidate MetadataRecord) bool {
	if candidate.Version == current.Version {
		return sameRecord(current, candidate)
	}
	return current.Version < maxSafeInteger && candidate.Version == current.Version+1
}

func validateRecoveryTargetsTransition(current, previous, candidate MetadataRecord) error {
	if sameRecord(previous, candidate) {
		return nil
	}
	if !sameRecord(previous, current) {
		return errors.New("unpublished next targets must remain byte-identical during online-role recovery")
	}
	if !sameOrNext(current, candidate) {
		return errors.New("targets must remain exact or advance one version")
	}
	return nil
}

func validateRecoveryRootTransition(
	history []MetadataRecord,
	current, previous, candidate MetadataRecord,
	reference time.Time,
) error {
	if sameRecord(previous, candidate) {
		return nil
	}
	if !sameRecord(previous, current) {
		return errors.New("an unpublished next root must remain byte-identical during online-role recovery")
	}
	return validateRootTransition(history, current, candidate, reference)
}

func pendingSnapshotNeedsRefresh(checkpoint Checkpoint, pending PendingSnapshot, reference time.Time) (bool, error) {
	_, err := repository.ValidateSnapshotSet(repository.SnapshotSet{
		Environment: checkpoint.Environment, ReleaseID: pending.ReleaseID,
		ReferenceTime: reference, RequireFresh: true,
		RootBytes: pending.Root.Bytes, TargetsBytes: pending.Targets.Bytes,
		SnapshotBytes: pending.Snapshot.Bytes,
	})
	if err == nil {
		return false, nil
	}
	if errors.Is(err, repository.ErrPublicationRefreshRequired) {
		return true, nil
	}
	return false, fmt.Errorf("classify pending snapshot publication freshness: %w", err)
}

func authorizedSnapshotNeedsRefresh(checkpoint Checkpoint, reference time.Time) (bool, error) {
	root := checkpoint.RootHistory[len(checkpoint.RootHistory)-1]
	targets := checkpoint.Targets
	snapshot := checkpoint.Snapshot
	releaseID := checkpoint.ReleaseID
	if checkpoint.PendingSnapshot != nil {
		root = checkpoint.PendingSnapshot.Root
		targets = checkpoint.PendingSnapshot.Targets
		snapshot = checkpoint.PendingSnapshot.Snapshot
		releaseID = checkpoint.PendingSnapshot.ReleaseID
	}
	_, err := repository.ValidateSnapshotSet(repository.SnapshotSet{
		Environment: checkpoint.Environment, ReleaseID: releaseID,
		ReferenceTime: reference, RequireFresh: true,
		RootBytes: root.Bytes, TargetsBytes: targets.Bytes, SnapshotBytes: snapshot.Bytes,
	})
	if err == nil {
		return false, nil
	}
	if errors.Is(err, repository.ErrPublicationRefreshRequired) {
		return true, nil
	}
	return false, fmt.Errorf("classify authorized snapshot publication freshness: %w", err)
}

func pendingGenerationNeedsRefresh(checkpoint Checkpoint, pending PendingTimestamp, reference time.Time) (bool, error) {
	root := checkpoint.RootHistory[len(checkpoint.RootHistory)-1]
	targets := checkpoint.Targets
	snapshot := checkpoint.Snapshot
	releaseID := checkpoint.ReleaseID
	if checkpoint.PendingSnapshot != nil {
		root = checkpoint.PendingSnapshot.Root
		targets = checkpoint.PendingSnapshot.Targets
		snapshot = checkpoint.PendingSnapshot.Snapshot
		releaseID = checkpoint.PendingSnapshot.ReleaseID
	}
	_, err := repository.ValidateMetadataSet(repository.MetadataSet{
		Environment: checkpoint.Environment, ReleaseID: releaseID,
		ReferenceTime: reference, RequireFresh: true,
		RootBytes: root.Bytes, TargetsBytes: targets.Bytes,
		SnapshotBytes: snapshot.Bytes, TimestampBytes: pending.Timestamp.Bytes,
	})
	if err == nil {
		return false, nil
	}
	if errors.Is(err, repository.ErrPublicationRefreshRequired) {
		return true, nil
	}
	return false, fmt.Errorf("classify pending generation publication freshness: %w", err)
}

func pendingBlocksRole(role string, checkpoint Checkpoint, reference time.Time) (bool, error) {
	switch role {
	case "snapshot":
		if checkpoint.PendingSnapshot != nil {
			needsRefresh, err := pendingSnapshotNeedsRefresh(checkpoint, *checkpoint.PendingSnapshot, reference)
			return !needsRefresh, err
		}
		if checkpoint.PendingTimestamp != nil {
			needsRefresh, err := authorizedSnapshotNeedsRefresh(checkpoint, reference)
			return !needsRefresh, err
		}
	case "timestamp":
		if checkpoint.PendingTimestamp != nil {
			needsRefresh, err := pendingGenerationNeedsRefresh(checkpoint, *checkpoint.PendingTimestamp, reference)
			return !needsRefresh, err
		}
	}
	return false, nil
}

func validateRootTransition(history []MetadataRecord, current, candidate MetadataRecord, reference time.Time) error {
	if candidate.Version == current.Version {
		if !sameRecord(current, candidate) {
			return errors.New("same-version root bytes differ from current state")
		}
		return nil
	}
	if current.Version >= maxSafeInteger || candidate.Version != current.Version+1 {
		return errors.New("root must remain exact or advance one version")
	}
	rootBytes := make([][]byte, 0, len(history)+1)
	for _, record := range history {
		rootBytes = append(rootBytes, record.Bytes)
	}
	rootBytes = append(rootBytes, candidate.Bytes)
	if _, err := repository.ValidateRootHistory(rootBytes, reference, true); err != nil {
		return err
	}
	return nil
}

func validCandidateID(value string) bool {
	return value == "one" || value == "two"
}

func cloneCheckpoint(checkpoint Checkpoint) Checkpoint {
	result := checkpoint
	result.RootHistory = make([]MetadataRecord, len(checkpoint.RootHistory))
	for index, record := range checkpoint.RootHistory {
		result.RootHistory[index] = cloneRecord(record)
	}
	result.Targets = cloneRecord(checkpoint.Targets)
	result.Snapshot = cloneRecord(checkpoint.Snapshot)
	result.Timestamp = cloneRecord(checkpoint.Timestamp)
	if checkpoint.PendingSnapshot != nil {
		pending := *checkpoint.PendingSnapshot
		pending.RequestObject = cloneImmutableRequestObject(pending.RequestObject)
		pending.Root = cloneRecord(pending.Root)
		pending.Targets = cloneRecord(pending.Targets)
		pending.Snapshot = cloneRecord(pending.Snapshot)
		result.PendingSnapshot = &pending
	}
	if checkpoint.PendingTimestamp != nil {
		pending := *checkpoint.PendingTimestamp
		pending.RequestObject = cloneImmutableRequestObject(pending.RequestObject)
		pending.Root = cloneRecord(pending.Root)
		pending.Snapshot = cloneRecord(pending.Snapshot)
		pending.Timestamp = cloneRecord(pending.Timestamp)
		result.PendingTimestamp = &pending
	}
	return result
}

func cloneRecord(record MetadataRecord) MetadataRecord {
	result := record
	result.Bytes = bytes.Clone(record.Bytes)
	return result
}
