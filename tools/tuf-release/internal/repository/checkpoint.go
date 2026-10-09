package repository

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"time"
)

// ErrPublicationRefreshRequired marks authenticated metadata that has fallen
// below its minimum publication window. It is deliberately distinct from an
// excessive lifetime, clock rollback, or structural/signature failure.
var ErrPublicationRefreshRequired = errors.New("metadata publication refresh is required")

// MetadataSet is the complete current top-level metadata checkpoint held by a
// trusted broker or publication canary. It contains no signing material.
type MetadataSet struct {
	Environment    string
	ReleaseID      string
	ReferenceTime  time.Time
	RequireFresh   bool
	RootBytes      []byte
	TargetsBytes   []byte
	SnapshotBytes  []byte
	TimestampBytes []byte
}

// MetadataSetState is derived exclusively from authenticated metadata bytes.
type MetadataSetState struct {
	RootVersion      int64
	RootSHA256       string
	TargetsVersion   int64
	TargetsSHA256    string
	SnapshotVersion  int64
	SnapshotSHA256   string
	TimestampVersion int64
	TimestampSHA256  string
}

// TargetsSet is the complete offline-authorized input to snapshot signing. It
// lets the fixed broker require an operational publication margin from both
// the authority root and targets before invoking an online signer.
type TargetsSet struct {
	Environment   string
	ReleaseID     string
	ReferenceTime time.Time
	RequireFresh  bool
	RootBytes     []byte
	TargetsBytes  []byte
}

// SnapshotSet is a coherent root, targets, and snapshot tuple used to verify a
// broker's pending snapshot before it can authorize timestamp signing.
type SnapshotSet struct {
	Environment   string
	ReleaseID     string
	ReferenceTime time.Time
	RequireFresh  bool
	RootBytes     []byte
	TargetsBytes  []byte
	SnapshotBytes []byte
}

// TimestampSet is a coherent root, snapshot, and timestamp tuple used to
// verify a pending online generation before publication.
type TimestampSet struct {
	ReferenceTime  time.Time
	RequireFresh   bool
	RootBytes      []byte
	SnapshotBytes  []byte
	TimestampBytes []byte
}

// ValidateTargetsSet authenticates an exact root/targets tuple and returns
// versions and hashes derived only from those bytes.
func ValidateTargetsSet(input TargetsSet) (MetadataSetState, error) {
	if err := requireWholeSecondUTC(input.ReferenceTime, "targets-set reference time"); err != nil {
		return MetadataSetState{}, err
	}
	root, rootRaw, err := decodeRoot(input.RootBytes)
	if err != nil {
		return MetadataSetState{}, fmt.Errorf("decode targets-set root: %w", err)
	}
	if err := validateRootPolicy(root, rootRaw, input.ReferenceTime, input.RequireFresh); err != nil {
		return MetadataSetState{}, fmt.Errorf("validate targets-set root: %w", err)
	}
	targets, targetsRaw, err := decodeTargets(input.TargetsBytes)
	if err != nil {
		return MetadataSetState{}, fmt.Errorf("decode targets-set targets: %w", err)
	}
	if err := validateTargetsPolicyWithFreshness(
		targets, targetsRaw, root, input.ReferenceTime, input.Environment, input.ReleaseID, true, input.RequireFresh,
	); err != nil {
		return MetadataSetState{}, fmt.Errorf("validate targets-set targets: %w", err)
	}
	return MetadataSetState{
		RootVersion: root.Signed.Version, RootSHA256: digestHex(input.RootBytes),
		TargetsVersion: targets.Signed.Version, TargetsSHA256: digestHex(input.TargetsBytes),
	}, nil
}

// ValidateSnapshotSet authenticates the exact selected targets and signed
// snapshot bytes and returns versions/hashes derived from those bytes.
func ValidateSnapshotSet(input SnapshotSet) (MetadataSetState, error) {
	if err := requireWholeSecondUTC(input.ReferenceTime, "snapshot-set reference time"); err != nil {
		return MetadataSetState{}, err
	}
	root, rootRaw, err := decodeRoot(input.RootBytes)
	if err != nil {
		return MetadataSetState{}, fmt.Errorf("decode snapshot-set root: %w", err)
	}
	if err := validateRootPolicy(root, rootRaw, input.ReferenceTime, input.RequireFresh); err != nil {
		return MetadataSetState{}, fmt.Errorf("validate snapshot-set root: %w", err)
	}
	targets, targetsRaw, err := decodeTargets(input.TargetsBytes)
	if err != nil {
		return MetadataSetState{}, fmt.Errorf("decode snapshot-set targets: %w", err)
	}
	if err := validateTargetsPolicyWithFreshness(
		targets, targetsRaw, root, input.ReferenceTime, input.Environment, input.ReleaseID, true, input.RequireFresh,
	); err != nil {
		return MetadataSetState{}, fmt.Errorf("validate snapshot-set targets: %w", err)
	}
	snapshot, snapshotRaw, err := decodeSnapshot(input.SnapshotBytes)
	if err != nil {
		return MetadataSetState{}, fmt.Errorf("decode snapshot-set snapshot: %w", err)
	}
	if err := validateSnapshotPolicyWithFreshness(snapshot, snapshotRaw, root, input.ReferenceTime, true, input.RequireFresh); err != nil {
		return MetadataSetState{}, fmt.Errorf("validate snapshot-set snapshot: %w", err)
	}
	reference := snapshot.Signed.Meta["targets.json"]
	if reference == nil || reference.Version != targets.Signed.Version {
		return MetadataSetState{}, errors.New("snapshot set does not select its targets version")
	}
	if err := reference.VerifyLengthHashes(input.TargetsBytes); err != nil {
		return MetadataSetState{}, fmt.Errorf("snapshot-set targets reference: %w", err)
	}
	return MetadataSetState{
		RootVersion: root.Signed.Version, RootSHA256: digestHex(input.RootBytes),
		TargetsVersion: targets.Signed.Version, TargetsSHA256: digestHex(input.TargetsBytes),
		SnapshotVersion: snapshot.Signed.Version, SnapshotSHA256: digestHex(input.SnapshotBytes),
	}, nil
}

// ValidateTimestampSet authenticates the exact selected snapshot and signed
// timestamp bytes and returns versions/hashes derived from those bytes.
func ValidateTimestampSet(input TimestampSet) (MetadataSetState, error) {
	if err := requireWholeSecondUTC(input.ReferenceTime, "timestamp-set reference time"); err != nil {
		return MetadataSetState{}, err
	}
	root, rootRaw, err := decodeRoot(input.RootBytes)
	if err != nil {
		return MetadataSetState{}, fmt.Errorf("decode timestamp-set root: %w", err)
	}
	if err := validateRootPolicy(root, rootRaw, input.ReferenceTime, input.RequireFresh); err != nil {
		return MetadataSetState{}, fmt.Errorf("validate timestamp-set root: %w", err)
	}
	snapshot, snapshotRaw, err := decodeSnapshot(input.SnapshotBytes)
	if err != nil {
		return MetadataSetState{}, fmt.Errorf("decode timestamp-set snapshot: %w", err)
	}
	if err := validateSnapshotPolicyWithFreshness(snapshot, snapshotRaw, root, input.ReferenceTime, true, input.RequireFresh); err != nil {
		return MetadataSetState{}, fmt.Errorf("validate timestamp-set snapshot: %w", err)
	}
	timestamp, timestampRaw, err := decodeTimestamp(input.TimestampBytes)
	if err != nil {
		return MetadataSetState{}, fmt.Errorf("decode timestamp-set timestamp: %w", err)
	}
	if err := validateTimestampPolicyWithFreshness(timestamp, timestampRaw, root, input.ReferenceTime, true, input.RequireFresh); err != nil {
		return MetadataSetState{}, fmt.Errorf("validate timestamp-set timestamp: %w", err)
	}
	reference := timestamp.Signed.Meta["snapshot.json"]
	if reference == nil || reference.Version != snapshot.Signed.Version {
		return MetadataSetState{}, errors.New("timestamp set does not select its snapshot version")
	}
	if err := reference.VerifyLengthHashes(input.SnapshotBytes); err != nil {
		return MetadataSetState{}, fmt.Errorf("timestamp-set snapshot reference: %w", err)
	}
	return MetadataSetState{
		RootVersion: root.Signed.Version, RootSHA256: digestHex(input.RootBytes),
		SnapshotVersion: snapshot.Signed.Version, SnapshotSHA256: digestHex(input.SnapshotBytes),
		TimestampVersion: timestamp.Signed.Version, TimestampSHA256: digestHex(input.TimestampBytes),
	}, nil
}

// ValidateMetadataSet authenticates a complete coherent top-level TUF state.
// With RequireFresh false, expiry syntax and signatures still validate but an
// expired checkpoint can be recovered by a new online metadata request.
func ValidateMetadataSet(input MetadataSet) (MetadataSetState, error) {
	if err := requireWholeSecondUTC(input.ReferenceTime, "metadata-set reference time"); err != nil {
		return MetadataSetState{}, err
	}
	if input.Environment != "staging" && input.Environment != "production" {
		return MetadataSetState{}, errors.New("metadata-set environment must be staging or production")
	}
	if !releaseIDPattern.MatchString(input.ReleaseID) {
		return MetadataSetState{}, errors.New("metadata-set release ID is invalid")
	}

	root, rootRaw, err := decodeRoot(input.RootBytes)
	if err != nil {
		return MetadataSetState{}, fmt.Errorf("decode metadata-set root: %w", err)
	}
	if err := validateRootPolicy(root, rootRaw, input.ReferenceTime, input.RequireFresh); err != nil {
		return MetadataSetState{}, fmt.Errorf("validate metadata-set root: %w", err)
	}
	targets, targetsRaw, err := decodeTargets(input.TargetsBytes)
	if err != nil {
		return MetadataSetState{}, fmt.Errorf("decode metadata-set targets: %w", err)
	}
	if err := validateTargetsPolicyWithFreshness(
		targets, targetsRaw, root, input.ReferenceTime, input.Environment, input.ReleaseID, true, input.RequireFresh,
	); err != nil {
		return MetadataSetState{}, fmt.Errorf("validate metadata-set targets: %w", err)
	}
	snapshot, snapshotRaw, err := decodeSnapshot(input.SnapshotBytes)
	if err != nil {
		return MetadataSetState{}, fmt.Errorf("decode metadata-set snapshot: %w", err)
	}
	if err := validateSnapshotPolicyWithFreshness(snapshot, snapshotRaw, root, input.ReferenceTime, true, input.RequireFresh); err != nil {
		return MetadataSetState{}, fmt.Errorf("validate metadata-set snapshot: %w", err)
	}
	targetsReference := snapshot.Signed.Meta["targets.json"]
	if targetsReference == nil || targetsReference.Version != targets.Signed.Version {
		return MetadataSetState{}, errors.New("metadata-set snapshot does not select its targets version")
	}
	if err := targetsReference.VerifyLengthHashes(input.TargetsBytes); err != nil {
		return MetadataSetState{}, fmt.Errorf("metadata-set snapshot targets reference: %w", err)
	}
	timestamp, timestampRaw, err := decodeTimestamp(input.TimestampBytes)
	if err != nil {
		return MetadataSetState{}, fmt.Errorf("decode metadata-set timestamp: %w", err)
	}
	if err := validateTimestampPolicyWithFreshness(timestamp, timestampRaw, root, input.ReferenceTime, true, input.RequireFresh); err != nil {
		return MetadataSetState{}, fmt.Errorf("validate metadata-set timestamp: %w", err)
	}
	snapshotReference := timestamp.Signed.Meta["snapshot.json"]
	if snapshotReference == nil || snapshotReference.Version != snapshot.Signed.Version {
		return MetadataSetState{}, errors.New("metadata-set timestamp does not select its snapshot version")
	}
	if err := snapshotReference.VerifyLengthHashes(input.SnapshotBytes); err != nil {
		return MetadataSetState{}, fmt.Errorf("metadata-set timestamp snapshot reference: %w", err)
	}

	return MetadataSetState{
		RootVersion: root.Signed.Version, RootSHA256: digestHex(input.RootBytes),
		TargetsVersion: targets.Signed.Version, TargetsSHA256: digestHex(input.TargetsBytes),
		SnapshotVersion: snapshot.Signed.Version, SnapshotSHA256: digestHex(input.SnapshotBytes),
		TimestampVersion: timestamp.Signed.Version, TimestampSHA256: digestHex(input.TimestampBytes),
	}, nil
}

func digestHex(data []byte) string {
	digest := sha256.Sum256(data)
	return fmt.Sprintf("%x", digest[:])
}
