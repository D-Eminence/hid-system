package repository

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"reflect"
	"time"

	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

type SnapshotOptions struct {
	Environment            string
	RepositoryID           string
	ReleaseID              string
	RootVersion            int64
	Version                int64
	CreatedAt              time.Time
	Expires                time.Time
	ExpectedTargetsVersion int64
	ExpectedTargetsSHA256  string
}

type TimestampOptions struct {
	Environment             string
	RepositoryID            string
	ReleaseID               string
	RootVersion             int64
	Version                 int64
	CreatedAt               time.Time
	Expires                 time.Time
	ExpectedSnapshotVersion int64
	ExpectedSnapshotSHA256  string
}

// BuildSnapshot constructs and signs only a complete, root-authorized snapshot
// role. The signer is checked against the snapshot role before SignMessage can
// be invoked, so this is not a generic KMS signing surface.
func BuildSnapshot(rootBytes, targetsBytes []byte, options SnapshotOptions, signer signature.Signer) ([]byte, error) {
	if err := validateOnlineContext(options.Environment, options.RepositoryID, options.ReleaseID, options.RootVersion, options.Version, options.CreatedAt); err != nil {
		return nil, err
	}
	if err := requireWholeSecondUTC(options.Expires, "snapshot expiry"); err != nil {
		return nil, err
	}
	lifetime := options.Expires.Sub(options.CreatedAt)
	if lifetime < 72*time.Hour || lifetime > 7*24*time.Hour {
		return nil, errors.New("snapshot lifetime must be from 72 hours through 7 days")
	}
	if err := validateOnlineMetadataVersion(options.ExpectedTargetsVersion, "expected targets metadata"); err != nil {
		return nil, err
	}
	if !sha256Pattern.MatchString(options.ExpectedTargetsSHA256) {
		return nil, errors.New("snapshot requires an expected targets version and lowercase SHA-256")
	}
	if sha256Hex(targetsBytes) != options.ExpectedTargetsSHA256 {
		return nil, errors.New("targets metadata SHA-256 does not match snapshot options")
	}

	root, err := ValidateRoot(rootBytes, options.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("validate snapshot authority root: %w", err)
	}
	if root.Signed.Version != options.RootVersion {
		return nil, fmt.Errorf("snapshot root version %d does not match root version %d", options.RootVersion, root.Signed.Version)
	}
	targets, targetsRaw, err := decodeTargets(targetsBytes)
	if err != nil {
		return nil, err
	}
	if err := validateTargetsPolicy(targets, targetsRaw, root, options.CreatedAt, options.Environment, options.ReleaseID, true); err != nil {
		return nil, fmt.Errorf("validate snapshot targets input: %w", err)
	}
	if targets.Signed.Version != options.ExpectedTargetsVersion {
		return nil, errors.New("targets metadata version does not match snapshot options")
	}

	keyID, err := authorizeSigner(root, metadata.SNAPSHOT, signer)
	if err != nil {
		return nil, err
	}
	snapshot := metadata.Snapshot(options.Expires)
	snapshot.Signed.Version = options.Version
	snapshot.Signed.Meta = map[string]*metadata.MetaFiles{
		"targets.json": metadataFile(targets.Signed.Version, targetsBytes),
	}
	createdSignature, err := snapshot.Sign(signer)
	if err != nil {
		return nil, fmt.Errorf("sign snapshot metadata: %w", err)
	}
	if createdSignature == nil || createdSignature.KeyID != keyID || len(snapshot.Signatures) != 1 {
		return nil, errors.New("snapshot signer identity changed during signing")
	}
	snapshot.Signatures = sortedSignatures(snapshot.Signatures)
	encoded, err := snapshot.ToBytes(false)
	if err != nil {
		return nil, fmt.Errorf("serialize snapshot metadata: %w", err)
	}
	decoded, raw, err := decodeSnapshot(encoded)
	if err != nil {
		return nil, fmt.Errorf("self-decode snapshot metadata: %w", err)
	}
	if decoded.Signed.Version != options.Version {
		return nil, errors.New("serialized snapshot metadata version does not match snapshot options")
	}
	if err := validateSnapshotPolicy(decoded, raw, root, options.CreatedAt, true); err != nil {
		return nil, fmt.Errorf("self-validate snapshot metadata: %w", err)
	}
	return encoded, nil
}

// BuildTimestamp constructs and signs only a complete, root-authorized
// timestamp role that selects the exact caller-pinned snapshot bytes.
func BuildTimestamp(rootBytes, snapshotBytes []byte, options TimestampOptions, signer signature.Signer) ([]byte, error) {
	if err := validateOnlineContext(options.Environment, options.RepositoryID, options.ReleaseID, options.RootVersion, options.Version, options.CreatedAt); err != nil {
		return nil, err
	}
	if err := requireWholeSecondUTC(options.Expires, "timestamp expiry"); err != nil {
		return nil, err
	}
	lifetime := options.Expires.Sub(options.CreatedAt)
	if lifetime < 6*time.Hour || lifetime > 24*time.Hour {
		return nil, errors.New("timestamp lifetime must be from 6 through 24 hours")
	}
	if err := validateOnlineMetadataVersion(options.ExpectedSnapshotVersion, "expected snapshot metadata"); err != nil {
		return nil, err
	}
	if !sha256Pattern.MatchString(options.ExpectedSnapshotSHA256) {
		return nil, errors.New("timestamp requires an expected snapshot version and lowercase SHA-256")
	}
	if sha256Hex(snapshotBytes) != options.ExpectedSnapshotSHA256 {
		return nil, errors.New("snapshot metadata SHA-256 does not match timestamp options")
	}

	root, err := ValidateRoot(rootBytes, options.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("validate timestamp authority root: %w", err)
	}
	if root.Signed.Version != options.RootVersion {
		return nil, fmt.Errorf("timestamp root version %d does not match root version %d", options.RootVersion, root.Signed.Version)
	}
	snapshot, snapshotRaw, err := decodeSnapshot(snapshotBytes)
	if err != nil {
		return nil, err
	}
	if err := validateSnapshotPolicy(snapshot, snapshotRaw, root, options.CreatedAt, true); err != nil {
		return nil, fmt.Errorf("validate timestamp snapshot input: %w", err)
	}
	if snapshot.Signed.Version != options.ExpectedSnapshotVersion {
		return nil, errors.New("snapshot metadata version does not match timestamp options")
	}

	keyID, err := authorizeSigner(root, metadata.TIMESTAMP, signer)
	if err != nil {
		return nil, err
	}
	timestamp := metadata.Timestamp(options.Expires)
	timestamp.Signed.Version = options.Version
	timestamp.Signed.Meta = map[string]*metadata.MetaFiles{
		"snapshot.json": metadataFile(snapshot.Signed.Version, snapshotBytes),
	}
	createdSignature, err := timestamp.Sign(signer)
	if err != nil {
		return nil, fmt.Errorf("sign timestamp metadata: %w", err)
	}
	if createdSignature == nil || createdSignature.KeyID != keyID || len(timestamp.Signatures) != 1 {
		return nil, errors.New("timestamp signer identity changed during signing")
	}
	timestamp.Signatures = sortedSignatures(timestamp.Signatures)
	encoded, err := timestamp.ToBytes(false)
	if err != nil {
		return nil, fmt.Errorf("serialize timestamp metadata: %w", err)
	}
	decoded, raw, err := decodeTimestamp(encoded)
	if err != nil {
		return nil, fmt.Errorf("self-decode timestamp metadata: %w", err)
	}
	if decoded.Signed.Version != options.Version {
		return nil, errors.New("serialized timestamp metadata version does not match timestamp options")
	}
	if err := validateTimestampPolicy(decoded, raw, root, options.CreatedAt, true); err != nil {
		return nil, fmt.Errorf("self-validate timestamp metadata: %w", err)
	}
	return encoded, nil
}

// ValidateOnlineSigningInputs performs all plan-, byte-, and predecessor-bound
// checks that do not require access to the remote signer. Callers should run it
// before initializing AWS or any other signing dependency.
func ValidateOnlineSigningInputs(plan OnlineSigningPlan, rootBytes, inputBytes, previousBytes, previousRootBytes []byte) error {
	return validateOnlineSigningInputs(plan, rootBytes, inputBytes, previousBytes, previousRootBytes, nil)
}

// OnlineVersionHighWater is trusted durable-state continuity supplied only by
// the fixed signing broker. It permits the broker to burn an exposed pending
// version and move forward without weakening the strict operator-plan API.
type OnlineVersionHighWater struct {
	Output int64
	Input  int64
}

// ValidateOnlineSigningInputsAtHighWater applies the ordinary signing checks
// plus broker-authenticated high-water continuity. Callers must derive both
// values from protected durable state, never from an online signing request.
func ValidateOnlineSigningInputsAtHighWater(
	plan OnlineSigningPlan,
	rootBytes, inputBytes, previousBytes, previousRootBytes []byte,
	highWater OnlineVersionHighWater,
) error {
	return validateOnlineSigningInputs(
		plan,
		rootBytes,
		inputBytes,
		previousBytes,
		previousRootBytes,
		&highWater,
	)
}

func validateOnlineSigningInputs(
	plan OnlineSigningPlan,
	rootBytes, inputBytes, previousBytes, previousRootBytes []byte,
	highWater *OnlineVersionHighWater,
) error {
	validated, err := ValidateOnlineSigningPlan(plan, plan.Role)
	if err != nil {
		return err
	}
	if sha256Hex(rootBytes) != plan.RootSHA256 {
		return errors.New("online signing root SHA-256 does not match its plan")
	}
	if sha256Hex(inputBytes) != plan.InputMetadataSHA256 {
		return fmt.Errorf("%s input metadata SHA-256 does not match its plan", plan.Role)
	}

	root, err := ValidateRoot(rootBytes, validated.CreatedAt)
	if err != nil {
		return fmt.Errorf("validate %s authority root: %w", plan.Role, err)
	}
	if root.Signed.Version != plan.RootVersion {
		return fmt.Errorf("%s root version %d does not match root metadata version %d", plan.Role, plan.RootVersion, root.Signed.Version)
	}

	var inputVersion int64
	switch plan.Role {
	case metadata.SNAPSHOT:
		targets, raw, err := decodeTargets(inputBytes)
		if err != nil {
			return fmt.Errorf("decode snapshot input metadata: %w", err)
		}
		if err := validateTargetsPolicy(targets, raw, root, validated.CreatedAt, plan.Environment, plan.ReleaseID, true); err != nil {
			return fmt.Errorf("validate snapshot targets input: %w", err)
		}
		if targets.Signed.Version != plan.InputMetadataVersion {
			return errors.New("snapshot input metadata version does not match its bytes")
		}
		inputVersion = targets.Signed.Version
	case metadata.TIMESTAMP:
		snapshot, raw, err := decodeSnapshot(inputBytes)
		if err != nil {
			return fmt.Errorf("decode timestamp input metadata: %w", err)
		}
		if err := validateSnapshotPolicy(snapshot, raw, root, validated.CreatedAt, true); err != nil {
			return fmt.Errorf("validate timestamp snapshot input: %w", err)
		}
		if snapshot.Signed.Version != plan.InputMetadataVersion {
			return errors.New("timestamp input metadata version does not match its bytes")
		}
		inputVersion = snapshot.Signed.Version
	default:
		return fmt.Errorf("unsupported online signing role %q", plan.Role)
	}

	if plan.OutputMetadataVersion == 1 {
		if len(previousBytes) != 0 || len(previousRootBytes) != 0 {
			return errors.New("genesis online signing input unexpectedly includes previous metadata or root bytes")
		}
		return nil
	}
	if len(previousBytes) == 0 {
		return errors.New("non-genesis online signing input omits previous metadata bytes")
	}
	if len(previousRootBytes) == 0 {
		return errors.New("non-genesis online signing input omits previous root bytes")
	}
	if sha256Hex(previousBytes) != plan.PreviousMetadataSHA256 {
		return fmt.Errorf("previous %s metadata SHA-256 does not match its plan", plan.Role)
	}
	if sha256Hex(previousRootBytes) != plan.PreviousRootSHA256 {
		return errors.New("previous online root SHA-256 does not match its plan")
	}

	previousRoot, previousRootRaw, err := decodeRoot(previousRootBytes)
	if err != nil {
		return fmt.Errorf("decode previous online root: %w", err)
	}
	if err := validateRootPolicy(previousRoot, previousRootRaw, validated.CreatedAt, false); err != nil {
		return fmt.Errorf("validate previous online root: %w", err)
	}
	if err := validateOnlineMetadataVersion(previousRoot.Signed.Version, "previous online root"); err != nil {
		return err
	}
	if previousRoot.Signed.Version == root.Signed.Version {
		if !bytes.Equal(previousRootBytes, rootBytes) {
			return errors.New("same-version previous and current online roots must have identical bytes")
		}
	} else if previousRoot.Signed.Version < maxSafeInteger &&
		root.Signed.Version == previousRoot.Signed.Version+1 {
		if err := ValidateRootChain(previousRootBytes, rootBytes, validated.CreatedAt); err != nil {
			return fmt.Errorf("validate online root transition: %w", err)
		}
	} else {
		return errors.New("online root must remain byte-identical or advance by exactly one authenticated version")
	}

	var previousVersion int64
	var previousInput *metadata.MetaFiles
	switch plan.Role {
	case metadata.SNAPSHOT:
		previous, raw, err := decodeSnapshot(previousBytes)
		if err != nil {
			return fmt.Errorf("decode previous snapshot metadata: %w", err)
		}
		if err := validateSnapshotPredecessor(previous, raw, previousRoot); err != nil {
			return fmt.Errorf("validate previous snapshot metadata: %w", err)
		}
		previousInput = previous.Signed.Meta["targets.json"]
		previousVersion = previous.Signed.Version
	case metadata.TIMESTAMP:
		previous, raw, err := decodeTimestamp(previousBytes)
		if err != nil {
			return fmt.Errorf("decode previous timestamp metadata: %w", err)
		}
		if err := validateTimestampPredecessor(previous, raw, previousRoot); err != nil {
			return fmt.Errorf("validate previous timestamp metadata: %w", err)
		}
		previousInput = previous.Signed.Meta["snapshot.json"]
		previousVersion = previous.Signed.Version
	}
	if err := validateOnlineInputTransition(
		plan.Role,
		map[string]string{metadata.SNAPSHOT: "targets", metadata.TIMESTAMP: "snapshot"}[plan.Role],
		previousInput,
		inputVersion,
		inputBytes,
		highWater,
	); err != nil {
		return err
	}
	outputBase := previousVersion
	if highWater != nil {
		if highWater.Output < previousVersion || highWater.Output >= maxSafeInteger {
			return fmt.Errorf("%s output high-water mark is outside durable predecessor continuity", plan.Role)
		}
		outputBase = highWater.Output
	}
	if outputBase >= maxSafeInteger || plan.OutputMetadataVersion != outputBase+1 {
		return fmt.Errorf("%s output version must advance exactly one version from its durable high-water mark", plan.Role)
	}
	return nil
}

func validateOnlineInputTransition(
	roleName, inputRoleName string,
	previous *metadata.MetaFiles,
	inputVersion int64,
	inputBytes []byte,
	highWater *OnlineVersionHighWater,
) error {
	if previous == nil {
		return fmt.Errorf("previous %s metadata omits its %s reference", roleName, inputRoleName)
	}
	inputBase := previous.Version
	if highWater != nil {
		if highWater.Input < previous.Version || highWater.Input > maxSafeInteger {
			return fmt.Errorf("%s input %s high-water mark is outside durable predecessor continuity", roleName, inputRoleName)
		}
		inputBase = highWater.Input
	}
	if inputVersion == previous.Version {
		if err := previous.VerifyLengthHashes(inputBytes); err != nil {
			return fmt.Errorf("same-version %s input %s bytes differ from the previous metadata reference: %w", roleName, inputRoleName, err)
		}
	}
	if inputVersion == inputBase || inputBase < maxSafeInteger && inputVersion == inputBase+1 {
		return nil
	}
	return fmt.Errorf("%s input %s version must remain exact or advance by one from its durable high-water mark", roleName, inputRoleName)
}

func validateOnlineContext(environment, repositoryID, releaseID string, rootVersion, version int64, createdAt time.Time) error {
	if environment != "staging" && environment != "production" {
		return errors.New("online metadata environment must be staging or production")
	}
	if !repositoryIDPattern.MatchString(repositoryID) || !releaseIDPattern.MatchString(releaseID) {
		return errors.New("online metadata repository or release identity is invalid")
	}
	if repositoryID != governedRepositoryID(environment) {
		return errors.New("online metadata repository identity does not match its environment")
	}
	if err := validateOnlineMetadataVersion(rootVersion, "online metadata root"); err != nil {
		return err
	}
	if err := validateOnlineMetadataVersion(version, "online metadata role"); err != nil {
		return err
	}
	return requireWholeSecondUTC(createdAt, "online metadata creation time")
}

func validateOnlineMetadataVersion(version int64, label string) error {
	if version < 1 || version > maxSafeInteger {
		return fmt.Errorf("%s version must be a positive JSON-safe integer", label)
	}
	return nil
}

func authorizeSigner(root *metadata.Metadata[metadata.RootType], roleName string, signer signature.Signer) (string, error) {
	if signer == nil || (reflect.ValueOf(signer).Kind() == reflect.Pointer && reflect.ValueOf(signer).IsNil()) {
		return "", fmt.Errorf("%s signer is nil", roleName)
	}
	publicKey, err := signer.PublicKey()
	if err != nil {
		return "", fmt.Errorf("read %s signer public key: %w", roleName, err)
	}
	key, err := metadata.KeyFromPublicKey(publicKey)
	if err != nil {
		return "", fmt.Errorf("convert %s signer public key: %w", roleName, err)
	}
	keyID, err := key.ID()
	if err != nil {
		return "", fmt.Errorf("identify %s signer public key: %w", roleName, err)
	}
	authorized, err := roleKeySet(root, roleName)
	if err != nil {
		return "", err
	}
	if _, ok := authorized[keyID]; !ok || root.Signed.Keys[keyID] == nil {
		return "", fmt.Errorf("signer key %s is not authorized for %s", keyID, roleName)
	}
	return keyID, nil
}

func validateSnapshotPolicy(snapshot *metadata.Metadata[metadata.SnapshotType], raw rawEnvelope, root *metadata.Metadata[metadata.RootType], reference time.Time, requireSignature bool) error {
	return validateSnapshotPolicyWithFreshness(snapshot, raw, root, reference, requireSignature, true)
}

func validateSnapshotPolicyWithFreshness(snapshot *metadata.Metadata[metadata.SnapshotType], raw rawEnvelope, root *metadata.Metadata[metadata.RootType], reference time.Time, requireSignature, requireFresh bool) error {
	if err := validateSnapshotShape(snapshot, raw); err != nil {
		return err
	}
	if requireFresh {
		remaining := snapshot.Signed.Expires.Sub(reference)
		if remaining < 72*time.Hour {
			return fmt.Errorf("%w: snapshot has less than 72 hours remaining", ErrPublicationRefreshRequired)
		}
		if remaining > 7*24*time.Hour {
			return errors.New("snapshot publication freshness exceeds 7 days")
		}
	}
	return validateOnlineSignatures(root, metadata.SNAPSHOT, snapshot.Signatures, snapshot, requireSignature)
}

func validateSnapshotPredecessor(snapshot *metadata.Metadata[metadata.SnapshotType], raw rawEnvelope, root *metadata.Metadata[metadata.RootType]) error {
	if err := validateSnapshotShape(snapshot, raw); err != nil {
		return err
	}
	return validateOnlineSignatures(root, metadata.SNAPSHOT, snapshot.Signatures, snapshot, true)
}

func validateSnapshotShape(snapshot *metadata.Metadata[metadata.SnapshotType], raw rawEnvelope) error {
	if snapshot == nil {
		return errors.New("snapshot metadata is nil")
	}
	if err := validateCommon(metadata.SNAPSHOT, snapshot.Signed.Type, snapshot.Signed.SpecVersion, snapshot.Signed.Version, snapshot.Signed.Expires, raw); err != nil {
		return err
	}
	if err := validateOnlineMetadataVersion(snapshot.Signed.Version, "snapshot metadata"); err != nil {
		return err
	}
	if len(snapshot.Signed.Meta) != 1 {
		return errors.New("snapshot must contain exactly the targets.json reference")
	}
	if err := validateMetadataFile(snapshot.Signed.Meta["targets.json"], "targets.json"); err != nil {
		return err
	}
	return nil
}

func validateTimestampPolicy(timestamp *metadata.Metadata[metadata.TimestampType], raw rawEnvelope, root *metadata.Metadata[metadata.RootType], reference time.Time, requireSignature bool) error {
	return validateTimestampPolicyWithFreshness(timestamp, raw, root, reference, requireSignature, true)
}

func validateTimestampPolicyWithFreshness(timestamp *metadata.Metadata[metadata.TimestampType], raw rawEnvelope, root *metadata.Metadata[metadata.RootType], reference time.Time, requireSignature, requireFresh bool) error {
	if err := validateTimestampShape(timestamp, raw); err != nil {
		return err
	}
	if requireFresh {
		remaining := timestamp.Signed.Expires.Sub(reference)
		if remaining < 6*time.Hour {
			return fmt.Errorf("%w: timestamp has less than 6 hours remaining", ErrPublicationRefreshRequired)
		}
		if remaining > 24*time.Hour {
			return errors.New("timestamp publication freshness exceeds 24 hours")
		}
	}
	return validateOnlineSignatures(root, metadata.TIMESTAMP, timestamp.Signatures, timestamp, requireSignature)
}

func validateTimestampPredecessor(timestamp *metadata.Metadata[metadata.TimestampType], raw rawEnvelope, root *metadata.Metadata[metadata.RootType]) error {
	if err := validateTimestampShape(timestamp, raw); err != nil {
		return err
	}
	return validateOnlineSignatures(root, metadata.TIMESTAMP, timestamp.Signatures, timestamp, true)
}

func validateTimestampShape(timestamp *metadata.Metadata[metadata.TimestampType], raw rawEnvelope) error {
	if timestamp == nil {
		return errors.New("timestamp metadata is nil")
	}
	if err := validateCommon(metadata.TIMESTAMP, timestamp.Signed.Type, timestamp.Signed.SpecVersion, timestamp.Signed.Version, timestamp.Signed.Expires, raw); err != nil {
		return err
	}
	if err := validateOnlineMetadataVersion(timestamp.Signed.Version, "timestamp metadata"); err != nil {
		return err
	}
	if len(timestamp.Signed.Meta) != 1 {
		return errors.New("timestamp must contain exactly the snapshot.json reference")
	}
	if err := validateMetadataFile(timestamp.Signed.Meta["snapshot.json"], "snapshot.json"); err != nil {
		return err
	}
	return nil
}

func validateMetadataFile(file *metadata.MetaFiles, name string) error {
	if file == nil || file.Version < 1 || file.Version > maxSafeInteger || file.Length < 1 || len(file.Hashes) != 1 {
		return fmt.Errorf("metadata reference %s is outside the governed shape", name)
	}
	digest, ok := file.Hashes["sha256"]
	if !ok || len(digest) != sha256.Size {
		return fmt.Errorf("metadata reference %s requires exactly one SHA-256 hash", name)
	}
	return nil
}

func validateOnlineSignatures(root *metadata.Metadata[metadata.RootType], roleName string, signatures []metadata.Signature, value any, required bool) error {
	if !required {
		if len(signatures) != 0 {
			return fmt.Errorf("unsigned %s metadata unexpectedly contains signatures", roleName)
		}
		return nil
	}
	if len(signatures) != 1 {
		return fmt.Errorf("%s metadata must contain exactly one signature", roleName)
	}
	if err := validateMetadataSignatures(signatures); err != nil {
		return fmt.Errorf("%s metadata: %w", roleName, err)
	}
	authorized, err := roleKeySet(root, roleName)
	if err != nil {
		return err
	}
	if _, ok := authorized[signatures[0].KeyID]; !ok {
		return fmt.Errorf("%s metadata signature %s is not authorized", roleName, signatures[0].KeyID)
	}
	if err := root.VerifyDelegate(roleName, value); err != nil {
		return fmt.Errorf("%s metadata signature does not verify: %w", roleName, err)
	}
	return nil
}

func metadataFile(version int64, data []byte) *metadata.MetaFiles {
	digest := sha256.Sum256(data)
	return &metadata.MetaFiles{
		Version: version,
		Length:  int64(len(data)),
		Hashes:  metadata.Hashes{"sha256": metadata.HexBytes(digest[:])},
	}
}
