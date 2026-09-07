package repository

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/secure-systems-lab/go-securesystemslib/cjson"
	"github.com/theupdateframework/go-tuf/v2/metadata"
	"golang.org/x/sys/unix"
)

const MaxRepositoryFiles = 20_000

var (
	versionedMetadataPattern  = regexp.MustCompile(`^metadata/([1-9][0-9]*)\.(root|targets|snapshot)\.json$`)
	physicalTargetNamePattern = regexp.MustCompile(`^([0-9a-f]{64})\.([a-z0-9][a-z0-9._-]*)$`)
)

type GenerationInput struct {
	PreviousDirectory        string
	PreviousRepositorySHA256 string
	DestinationDirectory     string
	ReferenceTime            time.Time
	ExpectedRootVersion      int64
	ExpectedTargetsVersion   int64
	ExpectedSnapshotVersion  int64
	ExpectedTimestampVersion int64
	Prepared                 PreparedTargets
	RootBytes                []byte
	TargetsBytes             []byte
	SnapshotBytes            []byte
	TimestampBytes           []byte
}

type GenerationResult struct {
	SchemaVersion    string `json:"schema_version"`
	Environment      string `json:"environment"`
	RepositoryID     string `json:"repository_id"`
	ReleaseID        string `json:"release_id"`
	Repository       string `json:"repository"`
	RepositorySHA256 string `json:"repository_sha256"`
	FileCount        int    `json:"file_count"`
	RootVersion      int64  `json:"root_version"`
	TargetsVersion   int64  `json:"targets_version"`
	SnapshotVersion  int64  `json:"snapshot_version"`
	TimestampVersion int64  `json:"timestamp_version"`
}

type generationMetadata struct {
	root      *metadata.Metadata[metadata.RootType]
	targets   *metadata.Metadata[metadata.TargetsType]
	snapshot  *metadata.Metadata[metadata.SnapshotType]
	timestamp *metadata.Metadata[metadata.TimestampType]
}

type previousGeneration struct {
	rootVersion      int64
	rootBytes        []byte
	targetsVersion   int64
	targetsBytes     []byte
	snapshotVersion  int64
	snapshotBytes    []byte
	timestampVersion int64
	timestampBytes   []byte
}

type generationFile struct {
	Path   string `json:"path"`
	Length int64  `json:"length"`
	SHA256 string `json:"sha256"`
}

type validatedGenerationDirectory struct {
	state            previousGeneration
	files            []generationFile
	repositorySHA256 string
}

type retainedRootMetadata struct {
	value *metadata.Metadata[metadata.RootType]
	raw   rawEnvelope
	data  []byte
}

type retainedTargetsMetadata struct {
	value *metadata.Metadata[metadata.TargetsType]
	raw   rawEnvelope
	data  []byte
}

type retainedSnapshotMetadata struct {
	value *metadata.Metadata[metadata.SnapshotType]
	raw   rawEnvelope
	data  []byte
}

type retainedTimestampMetadata struct {
	value *metadata.Metadata[metadata.TimestampType]
	raw   rawEnvelope
	data  []byte
}

type retainedPhysicalTarget struct {
	length int64
	sha256 string
}

// MaterializeGeneration creates one absent, private whole-generation
// repository directory. A supplied predecessor is copied without its mutable
// timestamp and version transitions are checked before the new current files
// are committed. The independent Cloudflare validator remains mandatory before
// upload and verifies the entire retained metadata/target closure.
func MaterializeGeneration(input GenerationInput) (GenerationResult, error) {
	return materializeGeneration(context.Background(), input, nil)
}

// PendingGenerationAuthorizer is a trusted runtime adapter, not plan data. The
// production implementation reloads and authenticates durable broker state.
type PendingGenerationAuthorizer interface {
	AuthorizeMaterialization(context.Context, MetadataSet, MetadataSet) error
}

// MaterializePendingGeneration permits online gaps only through a live state
// authorizer. The ordinary materializer and GenerationPlan have no gap flag.
// Fresh authorization is mandatory again before upload and deployment.
func MaterializePendingGeneration(ctx context.Context, input GenerationInput, authorizer PendingGenerationAuthorizer) (GenerationResult, error) {
	if ctx == nil || authorizer == nil {
		return GenerationResult{}, errors.New("pending materialization requires a context and durable state authorizer")
	}
	return materializeGeneration(ctx, input, authorizer)
}

func materializeGeneration(ctx context.Context, input GenerationInput, authorizer PendingGenerationAuthorizer) (GenerationResult, error) {
	current, err := validateCurrentGeneration(input)
	if err != nil {
		return GenerationResult{}, err
	}
	genesis := current.root.Signed.Version == 1 && current.targets.Signed.Version == 1 &&
		current.snapshot.Signed.Version == 1 && current.timestamp.Signed.Version == 1
	if genesis {
		if authorizer != nil {
			return GenerationResult{}, errors.New("pending materialization cannot bootstrap a repository")
		}
		if input.PreviousDirectory != "" || input.PreviousRepositorySHA256 != "" {
			return GenerationResult{}, errors.New("an all-version-1 genesis generation must not name a previous repository")
		}
	} else if input.PreviousDirectory == "" || !sha256Pattern.MatchString(input.PreviousRepositorySHA256) {
		return GenerationResult{}, errors.New("a non-genesis generation requires a pinned previous repository")
	}
	parent, base, err := validateAbsentDestination(input.DestinationDirectory)
	if err != nil {
		return GenerationResult{}, err
	}
	if !genesis {
		if err := validatePreviousDirectory(input.PreviousDirectory, input.DestinationDirectory); err != nil {
			return GenerationResult{}, err
		}
	}

	temporary, err := os.MkdirTemp(parent, ".hid-tuf-generation-")
	if err != nil {
		return GenerationResult{}, err
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.RemoveAll(temporary)
		}
	}()
	if err := os.Chmod(temporary, 0o700); err != nil {
		return GenerationResult{}, err
	}
	for _, directory := range []string{"metadata", "targets"} {
		if err := os.Mkdir(filepath.Join(temporary, directory), 0o700); err != nil {
			return GenerationResult{}, err
		}
	}

	var previous previousGeneration
	var authorize func() error
	if !genesis {
		previous, err = copyPreviousGeneration(
			input.PreviousDirectory,
			temporary,
			input.Prepared.Plan.Environment,
			input.PreviousRepositorySHA256,
			input.ReferenceTime,
		)
		if err != nil {
			return GenerationResult{}, err
		}
		if authorizer == nil {
			if err := validateVersionTransition(previous, current, input.RootBytes, input.TargetsBytes, input.SnapshotBytes, input.ReferenceTime); err != nil {
				return GenerationResult{}, err
			}
		} else {
			if err := validateOfflineVersionTransition(previous, current, input.RootBytes, input.TargetsBytes, input.ReferenceTime); err != nil {
				return GenerationResult{}, err
			}
			if current.snapshot.Signed.Version < previous.snapshotVersion || current.timestamp.Signed.Version <= previous.timestampVersion ||
				current.snapshot.Signed.Version == previous.snapshotVersion && !bytes.Equal(previous.snapshotBytes, input.SnapshotBytes) {
				return GenerationResult{}, errors.New("pending online metadata must advance without same-version substitution")
			}
			previousRelease, err := DiscoverTargetsReleaseID(previous.targetsBytes, input.Prepared.Plan.Environment)
			if err != nil {
				return GenerationResult{}, err
			}
			authorize = func() error {
				if err := ctx.Err(); err != nil {
					return err
				}
				return authorizer.AuthorizeMaterialization(ctx,
					MetadataSet{Environment: input.Prepared.Plan.Environment, ReleaseID: previousRelease, ReferenceTime: input.ReferenceTime,
						RootBytes: bytes.Clone(previous.rootBytes), TargetsBytes: bytes.Clone(previous.targetsBytes), SnapshotBytes: bytes.Clone(previous.snapshotBytes), TimestampBytes: bytes.Clone(previous.timestampBytes)},
					MetadataSet{Environment: input.Prepared.Plan.Environment, ReleaseID: input.Prepared.Plan.ReleaseID, ReferenceTime: input.ReferenceTime,
						RootBytes: bytes.Clone(input.RootBytes), TargetsBytes: bytes.Clone(input.TargetsBytes), SnapshotBytes: bytes.Clone(input.SnapshotBytes), TimestampBytes: bytes.Clone(input.TimestampBytes)})
			}
			if err := authorize(); err != nil {
				return GenerationResult{}, fmt.Errorf("authorize pending materialization: %w", err)
			}
		}
	}

	metadataFiles := []struct {
		name string
		data []byte
	}{
		{strconv.FormatInt(current.root.Signed.Version, 10) + ".root.json", input.RootBytes},
		{strconv.FormatInt(current.targets.Signed.Version, 10) + ".targets.json", input.TargetsBytes},
		{strconv.FormatInt(current.snapshot.Signed.Version, 10) + ".snapshot.json", input.SnapshotBytes},
		{"timestamp.json", input.TimestampBytes},
	}
	for _, file := range metadataFiles {
		if err := writeOrVerify(filepath.Join(temporary, "metadata", file.name), file.data); err != nil {
			return GenerationResult{}, fmt.Errorf("materialize metadata %s: %w", file.name, err)
		}
	}
	for _, target := range input.Prepared.Targets {
		data, err := readRegularFile(target.SourcePath, MaxTargetBytes)
		if err != nil {
			return GenerationResult{}, fmt.Errorf("re-read generation target %q: %w", target.LogicalPath, err)
		}
		if int64(len(data)) != target.Length || sha256Hex(data) != target.SHA256 {
			return GenerationResult{}, fmt.Errorf("generation target %q changed after offline signing", target.LogicalPath)
		}
		destination := filepath.Join(temporary, filepath.FromSlash(target.PhysicalPath))
		if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
			return GenerationResult{}, err
		}
		if err := writeOrVerify(destination, data); err != nil {
			return GenerationResult{}, fmt.Errorf("materialize target %q: %w", target.LogicalPath, err)
		}
	}
	validated, err := validateGenerationDirectory(temporary, input.Prepared.Plan.Environment, input.ReferenceTime, true)
	if err != nil {
		return GenerationResult{}, err
	}
	if validated.state.rootVersion != current.root.Signed.Version ||
		validated.state.targetsVersion != current.targets.Signed.Version ||
		validated.state.snapshotVersion != current.snapshot.Signed.Version ||
		validated.state.timestampVersion != current.timestamp.Signed.Version {
		return GenerationResult{}, errors.New("materialized repository current metadata differs from the supplied generation")
	}
	if err := syncGenerationDirectories(temporary); err != nil {
		return GenerationResult{}, err
	}
	if authorize != nil {
		if err := authorize(); err != nil {
			return GenerationResult{}, fmt.Errorf("reauthorize pending materialization before commit: %w", err)
		}
	}
	committed := filepath.Join(parent, base)
	if err := unix.Renameat2(unix.AT_FDCWD, temporary, unix.AT_FDCWD, committed, unix.RENAME_NOREPLACE); err != nil {
		return GenerationResult{}, fmt.Errorf("commit repository generation without replacement: %w", err)
	}
	cleanup = false
	if err := syncDirectory(parent); err != nil {
		return GenerationResult{}, err
	}
	return GenerationResult{
		SchemaVersion: SchemaVersion, Environment: input.Prepared.Plan.Environment,
		RepositoryID: input.Prepared.Plan.RepositoryID, ReleaseID: input.Prepared.Plan.ReleaseID,
		Repository: committed, RepositorySHA256: validated.repositorySHA256, FileCount: len(validated.files),
		RootVersion: current.root.Signed.Version, TargetsVersion: current.targets.Signed.Version,
		SnapshotVersion: current.snapshot.Signed.Version, TimestampVersion: current.timestamp.Signed.Version,
	}, nil
}

func validateCurrentGeneration(input GenerationInput) (generationMetadata, error) {
	validatedPlan, err := validateTargetsPlan(input.Prepared.Plan)
	if err != nil {
		return generationMetadata{}, err
	}
	for _, expected := range []struct {
		role    string
		version int64
	}{
		{metadata.ROOT, input.ExpectedRootVersion},
		{metadata.TARGETS, input.ExpectedTargetsVersion},
		{metadata.SNAPSHOT, input.ExpectedSnapshotVersion},
		{metadata.TIMESTAMP, input.ExpectedTimestampVersion},
	} {
		if expected.version < 1 || expected.version > maxSafeInteger {
			return generationMetadata{}, fmt.Errorf("expected %s version must be a positive safe integer", expected.role)
		}
	}
	if err := requireWholeSecondUTC(input.ReferenceTime, "generation reference time"); err != nil {
		return generationMetadata{}, err
	}
	if input.ReferenceTime.Before(validatedPlan.CreatedAt) {
		return generationMetadata{}, errors.New("generation reference time precedes targets preparation")
	}
	root, err := ValidateRoot(input.RootBytes, input.ReferenceTime)
	if err != nil {
		return generationMetadata{}, fmt.Errorf("validate generation root: %w", err)
	}
	if root.Signed.Version != input.Prepared.Plan.RootVersion || sha256Hex(input.RootBytes) != input.Prepared.RootSHA256 {
		return generationMetadata{}, errors.New("generation root does not match prepared targets context")
	}
	unsignedTargets, _, err := validatePreparedTargets(input.Prepared, root)
	if err != nil {
		return generationMetadata{}, err
	}
	targets, targetsRaw, err := decodeTargets(input.TargetsBytes)
	if err != nil {
		return generationMetadata{}, err
	}
	if err := validateTargetsPolicy(targets, targetsRaw, root, input.ReferenceTime, input.Prepared.Plan.Environment, input.Prepared.Plan.ReleaseID, true); err != nil {
		return generationMetadata{}, err
	}
	unsignedPayload, err := cjson.EncodeCanonical(unsignedTargets.Signed)
	if err != nil {
		return generationMetadata{}, err
	}
	signedPayload, err := cjson.EncodeCanonical(targets.Signed)
	if err != nil || !bytes.Equal(unsignedPayload, signedPayload) || !bytes.Equal(signedPayload, input.Prepared.Payload) {
		return generationMetadata{}, errors.New("signed targets payload differs from the offline-prepared payload")
	}
	snapshot, snapshotRaw, err := decodeSnapshot(input.SnapshotBytes)
	if err != nil {
		return generationMetadata{}, err
	}
	if err := validateSnapshotPolicy(snapshot, snapshotRaw, root, input.ReferenceTime, true); err != nil {
		return generationMetadata{}, err
	}
	targetsReference := snapshot.Signed.Meta["targets.json"]
	if targetsReference.Version != targets.Signed.Version {
		return generationMetadata{}, errors.New("snapshot does not select the supplied targets version")
	}
	if err := targetsReference.VerifyLengthHashes(input.TargetsBytes); err != nil {
		return generationMetadata{}, fmt.Errorf("snapshot targets reference: %w", err)
	}
	timestamp, timestampRaw, err := decodeTimestamp(input.TimestampBytes)
	if err != nil {
		return generationMetadata{}, err
	}
	if err := validateTimestampPolicy(timestamp, timestampRaw, root, input.ReferenceTime, true); err != nil {
		return generationMetadata{}, err
	}
	snapshotReference := timestamp.Signed.Meta["snapshot.json"]
	if snapshotReference.Version != snapshot.Signed.Version {
		return generationMetadata{}, errors.New("timestamp does not select the supplied snapshot version")
	}
	if err := snapshotReference.VerifyLengthHashes(input.SnapshotBytes); err != nil {
		return generationMetadata{}, fmt.Errorf("timestamp snapshot reference: %w", err)
	}
	if root.Signed.Version != input.ExpectedRootVersion || targets.Signed.Version != input.ExpectedTargetsVersion ||
		snapshot.Signed.Version != input.ExpectedSnapshotVersion || timestamp.Signed.Version != input.ExpectedTimestampVersion {
		return generationMetadata{}, errors.New("decoded metadata role versions do not match the generation plan")
	}
	return generationMetadata{root: root, targets: targets, snapshot: snapshot, timestamp: timestamp}, nil
}

func validatePreviousDirectory(previous, destination string) error {
	if previous == "" || !filepath.IsAbs(previous) || filepath.Clean(previous) != previous {
		return errors.New("previous repository must be a canonical absolute path")
	}
	info, err := os.Lstat(previous)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("previous repository must be a real directory")
	}
	realPrevious, err := filepath.EvalSymlinks(previous)
	if err != nil || realPrevious != previous {
		return errors.New("previous repository path must contain no symbolic links")
	}
	for _, pair := range [][2]string{{previous, destination}, {destination, previous}} {
		relative, err := filepath.Rel(pair[0], pair[1])
		if err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative) {
			return errors.New("previous and destination repository paths must not overlap")
		}
	}
	return nil
}

func copyPreviousGeneration(previous, destination, environment, expectedSHA256 string, reference time.Time) (previousGeneration, error) {
	entries, err := os.ReadDir(previous)
	if err != nil {
		return previousGeneration{}, err
	}
	if len(entries) != 2 || entries[0].Name()+":"+entries[1].Name() != "metadata:targets" ||
		!entries[0].IsDir() || !entries[1].IsDir() {
		return previousGeneration{}, errors.New("previous repository root must contain only metadata and targets directories")
	}
	fileCount := 0
	err = filepath.WalkDir(previous, func(sourcePath string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if sourcePath == previous {
			return nil
		}
		relative, err := filepath.Rel(previous, sourcePath)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("previous repository entry %s is a symbolic link", relative)
		}
		if entry.IsDir() {
			if relative == "metadata" || relative == "targets" || strings.HasPrefix(relative, "targets/") {
				return nil
			}
			return fmt.Errorf("previous repository directory %s is invalid", relative)
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("previous repository entry %s is not a regular file", relative)
		}
		fileCount++
		if fileCount > MaxRepositoryFiles {
			return fmt.Errorf("previous repository exceeds %d files", MaxRepositoryFiles)
		}
		maximum, _, _, err := classifyGenerationFile(relative, environment)
		if err != nil {
			return err
		}
		data, err := readRegularFile(sourcePath, maximum)
		if err != nil {
			return fmt.Errorf("read previous repository file %s: %w", relative, err)
		}
		destinationPath := filepath.Join(destination, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(destinationPath), 0o700); err != nil {
			return err
		}
		return writeExclusiveFile(destinationPath, data, 0o600)
	})
	if err != nil {
		return previousGeneration{}, err
	}
	_, copiedSHA256, err := hashGenerationDirectory(destination)
	if err != nil {
		return previousGeneration{}, fmt.Errorf("hash copied previous repository: %w", err)
	}
	if copiedSHA256 != expectedSHA256 {
		return previousGeneration{}, errors.New("previous repository SHA-256 does not match the generation plan")
	}
	validated, err := validateGenerationDirectory(destination, environment, reference, false)
	if err != nil {
		return previousGeneration{}, fmt.Errorf("validate previous repository: %w", err)
	}
	if validated.repositorySHA256 != expectedSHA256 {
		return previousGeneration{}, errors.New("validated previous repository SHA-256 changed unexpectedly")
	}
	if err := os.Remove(filepath.Join(destination, "metadata", "timestamp.json")); err != nil {
		return previousGeneration{}, fmt.Errorf("remove copied mutable timestamp: %w", err)
	}
	return validated.state, nil
}

func validateGenerationDirectory(directory, environment string, reference time.Time, requireFresh bool) (validatedGenerationDirectory, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return validatedGenerationDirectory{}, err
	}
	if len(entries) != 2 || entries[0].Name()+":"+entries[1].Name() != "metadata:targets" ||
		!entries[0].IsDir() || !entries[1].IsDir() {
		return validatedGenerationDirectory{}, errors.New("repository root must contain only metadata and targets directories")
	}
	files, repositorySHA256, err := hashGenerationDirectory(directory)
	if err != nil {
		return validatedGenerationDirectory{}, err
	}
	if len(files) < 5 {
		return validatedGenerationDirectory{}, errors.New("repository must contain at least five governed files")
	}

	roots := make(map[int64]retainedRootMetadata)
	targets := make(map[int64]retainedTargetsMetadata)
	snapshots := make(map[int64]retainedSnapshotMetadata)
	physicalTargets := make(map[string]retainedPhysicalTarget)
	var timestamp *retainedTimestampMetadata
	err = filepath.WalkDir(directory, func(filePath string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if filePath == directory {
			return nil
		}
		relative, err := filepath.Rel(directory, filePath)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("repository entry %s is a symbolic link", relative)
		}
		if entry.IsDir() {
			if relative == "metadata" || relative == "targets" || strings.HasPrefix(relative, "targets/") {
				return nil
			}
			return fmt.Errorf("repository directory %s is invalid", relative)
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("repository entry %s is not a regular file", relative)
		}
		maximum, role, version, err := classifyGenerationFile(relative, environment)
		if err != nil {
			return err
		}
		data, err := readRegularFile(filePath, maximum)
		if err != nil {
			return fmt.Errorf("read repository file %s: %w", relative, err)
		}
		switch role {
		case metadata.ROOT:
			parsed, raw, err := decodeRoot(data)
			if err != nil || parsed.Signed.Version != version || parsed.Signed.Version > maxSafeInteger {
				return fmt.Errorf("root file %s does not match a positive safe signed version", relative)
			}
			if _, duplicate := roots[version]; duplicate {
				return fmt.Errorf("repository repeats root version %d", version)
			}
			roots[version] = retainedRootMetadata{value: parsed, raw: raw, data: bytes.Clone(data)}
		case metadata.TARGETS:
			parsed, raw, err := decodeTargets(data)
			if err != nil || parsed.Signed.Version != version || parsed.Signed.Version > maxSafeInteger {
				return fmt.Errorf("targets file %s does not match a positive safe signed version", relative)
			}
			if _, duplicate := targets[version]; duplicate {
				return fmt.Errorf("repository repeats targets version %d", version)
			}
			targets[version] = retainedTargetsMetadata{value: parsed, raw: raw, data: bytes.Clone(data)}
		case metadata.SNAPSHOT:
			parsed, raw, err := decodeSnapshot(data)
			if err != nil || parsed.Signed.Version != version || parsed.Signed.Version > maxSafeInteger {
				return fmt.Errorf("snapshot file %s does not match a positive safe signed version", relative)
			}
			if _, duplicate := snapshots[version]; duplicate {
				return fmt.Errorf("repository repeats snapshot version %d", version)
			}
			snapshots[version] = retainedSnapshotMetadata{value: parsed, raw: raw, data: bytes.Clone(data)}
		case metadata.TIMESTAMP:
			if timestamp != nil {
				return errors.New("repository contains more than one timestamp metadata file")
			}
			parsed, raw, err := decodeTimestamp(data)
			if err != nil || parsed.Signed.Version < 1 || parsed.Signed.Version > maxSafeInteger {
				return fmt.Errorf("timestamp file %s does not contain a positive safe signed version", relative)
			}
			timestamp = &retainedTimestampMetadata{value: parsed, raw: raw, data: bytes.Clone(data)}
		case "target":
			expectedSHA256 := physicalTargetNamePattern.FindStringSubmatch(filepath.Base(relative))[1]
			actualSHA256 := sha256Hex(data)
			if actualSHA256 != expectedSHA256 {
				return fmt.Errorf("target %s does not match its hash prefix", relative)
			}
			physicalTargets[relative] = retainedPhysicalTarget{length: int64(len(data)), sha256: actualSHA256}
		default:
			return fmt.Errorf("repository file %s has unsupported role %q", relative, role)
		}
		return nil
	})
	if err != nil {
		return validatedGenerationDirectory{}, err
	}
	if len(roots) == 0 || len(targets) == 0 || len(snapshots) == 0 || timestamp == nil {
		return validatedGenerationDirectory{}, errors.New("repository omits a top-level metadata role")
	}
	if len(physicalTargets) == 0 {
		return validatedGenerationDirectory{}, errors.New("repository contains no target files")
	}

	rootVersions := sortedVersionKeys(roots)
	rootAuthorities := make([]*metadata.Metadata[metadata.RootType], 0, len(rootVersions))
	for index, version := range rootVersions {
		if version != int64(index)+1 {
			return validatedGenerationDirectory{}, errors.New("root metadata versions must be retained contiguously from version 1")
		}
		retained := roots[version]
		if err := validateRootPolicy(retained.value, retained.raw, reference, false); err != nil {
			return validatedGenerationDirectory{}, fmt.Errorf("validate retained root %d: %w", version, err)
		}
		if index > 0 {
			previous := rootAuthorities[index-1]
			if err := previous.VerifyDelegate(metadata.ROOT, retained.value); err != nil {
				return validatedGenerationDirectory{}, fmt.Errorf("retained root %d does not meet root %d's threshold: %w", version, version-1, err)
			}
		}
		rootAuthorities = append(rootAuthorities, retained.value)
	}
	latestRoot := rootAuthorities[len(rootAuthorities)-1]

	for version, retained := range targets {
		if err := validateRetainedTargetsMetadata(retained, environment); err != nil {
			return validatedGenerationDirectory{}, fmt.Errorf("validate retained targets %d: %w", version, err)
		}
		if !strictlySignedByAnyRetainedRoot(rootAuthorities, metadata.TARGETS, retained.value.Signatures, retained.value) {
			return validatedGenerationDirectory{}, fmt.Errorf("retained targets %d is not threshold-signed by any retained root", version)
		}
	}
	for version, retained := range snapshots {
		if err := validateRetainedSnapshotMetadata(retained); err != nil {
			return validatedGenerationDirectory{}, fmt.Errorf("validate retained snapshot %d: %w", version, err)
		}
		if !strictlySignedByAnyRetainedRoot(rootAuthorities, metadata.SNAPSHOT, retained.value.Signatures, retained.value) {
			return validatedGenerationDirectory{}, fmt.Errorf("retained snapshot %d is not threshold-signed by any retained root", version)
		}
	}
	if err := validateRetainedTimestampMetadata(*timestamp); err != nil {
		return validatedGenerationDirectory{}, fmt.Errorf("validate retained timestamp: %w", err)
	}
	if err := verifyCurrentRole(latestRoot, metadata.TIMESTAMP, timestamp.value.Signatures, timestamp.value); err != nil {
		return validatedGenerationDirectory{}, fmt.Errorf("validate current timestamp authority: %w", err)
	}

	snapshotReference := timestamp.value.Signed.Meta["snapshot.json"]
	currentSnapshot, present := snapshots[snapshotReference.Version]
	if !present {
		return validatedGenerationDirectory{}, fmt.Errorf("timestamp selects missing snapshot version %d", snapshotReference.Version)
	}
	if err := verifyRetainedMetadataReference(snapshotReference, snapshotReference.Version, currentSnapshot.data, "timestamp snapshot.json"); err != nil {
		return validatedGenerationDirectory{}, err
	}
	snapshotVersions := sortedVersionKeys(snapshots)
	if snapshotReference.Version != snapshotVersions[len(snapshotVersions)-1] {
		return validatedGenerationDirectory{}, errors.New("timestamp does not select the highest retained snapshot version")
	}
	if err := verifyCurrentRole(latestRoot, metadata.SNAPSHOT, currentSnapshot.value.Signatures, currentSnapshot.value); err != nil {
		return validatedGenerationDirectory{}, fmt.Errorf("validate current snapshot authority: %w", err)
	}

	selectedTargetsVersions := make(map[int64]struct{}, len(targets))
	previousTargetsVersion := int64(0)
	for _, snapshotVersion := range snapshotVersions {
		retained := snapshots[snapshotVersion]
		reference := retained.value.Signed.Meta["targets.json"]
		selected, present := targets[reference.Version]
		if !present {
			return validatedGenerationDirectory{}, fmt.Errorf("snapshot %d selects missing targets version %d", snapshotVersion, reference.Version)
		}
		if err := verifyRetainedMetadataReference(reference, reference.Version, selected.data, fmt.Sprintf("snapshot %d targets.json", snapshotVersion)); err != nil {
			return validatedGenerationDirectory{}, err
		}
		if reference.Version < previousTargetsVersion {
			return validatedGenerationDirectory{}, errors.New("retained snapshots roll back targets versions")
		}
		previousTargetsVersion = reference.Version
		selectedTargetsVersions[reference.Version] = struct{}{}
	}
	for version := range targets {
		if _, selected := selectedTargetsVersions[version]; !selected {
			return validatedGenerationDirectory{}, fmt.Errorf("retained targets version %d is not selected by any retained snapshot", version)
		}
	}
	currentTargetsReference := currentSnapshot.value.Signed.Meta["targets.json"]
	currentTargets := targets[currentTargetsReference.Version]
	targetVersions := sortedVersionKeys(targets)
	for index, version := range targetVersions {
		if version != int64(index)+1 {
			return validatedGenerationDirectory{}, errors.New("targets metadata versions must be retained contiguously from version 1")
		}
	}
	if currentTargetsReference.Version != targetVersions[len(targetVersions)-1] {
		return validatedGenerationDirectory{}, errors.New("current snapshot does not select the highest retained targets version")
	}
	if err := verifyCurrentRole(latestRoot, metadata.TARGETS, currentTargets.value.Signatures, currentTargets.value); err != nil {
		return validatedGenerationDirectory{}, fmt.Errorf("validate current targets authority: %w", err)
	}

	referencedPhysicalTargets := make(map[string]struct{})
	immutableReleaseTargets := make(map[string]string)
	for version, retained := range targets {
		for logicalPath, descriptor := range retained.value.Signed.Targets {
			releaseTarget, err := validateRetainedLogicalTargetPath(logicalPath, environment)
			if err != nil {
				return validatedGenerationDirectory{}, fmt.Errorf("retained targets %d path %q: %w", version, logicalPath, err)
			}
			if descriptor == nil || descriptor.Length < 1 || descriptor.Length > MaxTargetBytes ||
				descriptor.Custom != nil || len(descriptor.Hashes) != 1 {
				return validatedGenerationDirectory{}, fmt.Errorf("retained targets %d descriptor %q is outside the governed shape", version, logicalPath)
			}
			digest, present := descriptor.Hashes["sha256"]
			if !present || len(digest) != 32 {
				return validatedGenerationDirectory{}, fmt.Errorf("retained targets %d descriptor %q requires one SHA-256 hash", version, logicalPath)
			}
			digestHex := hex.EncodeToString(digest)
			if releaseTarget {
				identity := strconv.FormatInt(descriptor.Length, 10) + ":" + digestHex
				if previousIdentity, seen := immutableReleaseTargets[logicalPath]; seen && previousIdentity != identity {
					return validatedGenerationDirectory{}, fmt.Errorf("immutable release target %q changes across retained targets metadata", logicalPath)
				}
				immutableReleaseTargets[logicalPath] = identity
			}
			physicalPath := physicalTargetPath(logicalPath, digestHex)
			physical, present := physicalTargets[physicalPath]
			if !present {
				return validatedGenerationDirectory{}, fmt.Errorf("retained targets %d references missing %s", version, physicalPath)
			}
			if physical.length != descriptor.Length || physical.sha256 != digestHex {
				return validatedGenerationDirectory{}, fmt.Errorf("physical target %s does not match retained targets metadata", physicalPath)
			}
			referencedPhysicalTargets[physicalPath] = struct{}{}
		}
	}
	for physicalPath := range physicalTargets {
		if _, referenced := referencedPhysicalTargets[physicalPath]; !referenced {
			return validatedGenerationDirectory{}, fmt.Errorf("physical target %s is not referenced by retained targets metadata", physicalPath)
		}
	}

	latestRootVersion := rootVersions[len(rootVersions)-1]
	if requireFresh {
		if err := validateRootPolicy(roots[latestRootVersion].value, roots[latestRootVersion].raw, reference, true); err != nil {
			return validatedGenerationDirectory{}, fmt.Errorf("validate current root freshness: %w", err)
		}
		if err := validateGenerationFreshness(currentTargets.value.Signed.Expires, reference, 14*24*time.Hour, 90*24*time.Hour, metadata.TARGETS); err != nil {
			return validatedGenerationDirectory{}, err
		}
		if err := validateGenerationFreshness(currentSnapshot.value.Signed.Expires, reference, 72*time.Hour, 7*24*time.Hour, metadata.SNAPSHOT); err != nil {
			return validatedGenerationDirectory{}, err
		}
		if err := validateGenerationFreshness(timestamp.value.Signed.Expires, reference, 6*time.Hour, 24*time.Hour, metadata.TIMESTAMP); err != nil {
			return validatedGenerationDirectory{}, err
		}
	}

	return validatedGenerationDirectory{
		state: previousGeneration{
			rootVersion: latestRootVersion, rootBytes: bytes.Clone(roots[latestRootVersion].data),
			targetsVersion: currentTargetsReference.Version, targetsBytes: bytes.Clone(currentTargets.data),
			snapshotVersion: snapshotReference.Version, snapshotBytes: bytes.Clone(currentSnapshot.data),
			timestampVersion: timestamp.value.Signed.Version,
			timestampBytes:   bytes.Clone(timestamp.data),
		},
		files: files, repositorySHA256: repositorySHA256,
	}, nil
}

func sortedVersionKeys[T any](values map[int64]T) []int64 {
	versions := make([]int64, 0, len(values))
	for version := range values {
		versions = append(versions, version)
	}
	sort.Slice(versions, func(left, right int) bool { return versions[left] < versions[right] })
	return versions
}

func validateRetainedTargetsMetadata(retained retainedTargetsMetadata, environment string) error {
	value := retained.value
	if err := validateCommon(metadata.TARGETS, value.Signed.Type, value.Signed.SpecVersion, value.Signed.Version, value.Signed.Expires, retained.raw); err != nil {
		return err
	}
	if value.Signed.Delegations != nil || len(value.Signed.Targets) == 0 || len(value.Signed.Targets) > MaxTargets {
		return errors.New("targets metadata delegation or target count is outside policy")
	}
	for logicalPath := range value.Signed.Targets {
		if _, err := validateRetainedLogicalTargetPath(logicalPath, environment); err != nil {
			return err
		}
	}
	return validateMetadataSignatures(value.Signatures)
}

func validateRetainedSnapshotMetadata(retained retainedSnapshotMetadata) error {
	value := retained.value
	if err := validateCommon(metadata.SNAPSHOT, value.Signed.Type, value.Signed.SpecVersion, value.Signed.Version, value.Signed.Expires, retained.raw); err != nil {
		return err
	}
	if len(value.Signed.Meta) != 1 {
		return errors.New("snapshot must contain exactly the targets.json reference")
	}
	if err := validateSafeMetadataReference(value.Signed.Meta["targets.json"], "targets.json"); err != nil {
		return err
	}
	return validateMetadataSignatures(value.Signatures)
}

func validateRetainedTimestampMetadata(retained retainedTimestampMetadata) error {
	value := retained.value
	if err := validateCommon(metadata.TIMESTAMP, value.Signed.Type, value.Signed.SpecVersion, value.Signed.Version, value.Signed.Expires, retained.raw); err != nil {
		return err
	}
	if len(value.Signed.Meta) != 1 {
		return errors.New("timestamp must contain exactly the snapshot.json reference")
	}
	if err := validateSafeMetadataReference(value.Signed.Meta["snapshot.json"], "snapshot.json"); err != nil {
		return err
	}
	return validateMetadataSignatures(value.Signatures)
}

func validateSafeMetadataReference(reference *metadata.MetaFiles, name string) error {
	if err := validateMetadataFile(reference, name); err != nil {
		return err
	}
	if reference.Version > maxSafeInteger || reference.Length > maxSafeInteger {
		return fmt.Errorf("metadata reference %s exceeds the safe integer range", name)
	}
	return nil
}

func strictlySignedByAnyRetainedRoot(authorities []*metadata.Metadata[metadata.RootType], role string, signatures []metadata.Signature, value any) bool {
	for _, authority := range authorities {
		policy := authority.Signed.Roles[role]
		if policy == nil || len(signatures) != policy.Threshold {
			continue
		}
		authorized, err := roleKeySet(authority, role)
		if err != nil {
			continue
		}
		allAuthorized := true
		for _, signature := range signatures {
			if _, present := authorized[signature.KeyID]; !present {
				allAuthorized = false
				break
			}
		}
		if allAuthorized && authority.VerifyDelegate(role, value) == nil {
			return true
		}
	}
	return false
}

func verifyCurrentRole(authority *metadata.Metadata[metadata.RootType], role string, signatures []metadata.Signature, value any) error {
	policy := authority.Signed.Roles[role]
	if policy == nil || len(signatures) != policy.Threshold {
		return fmt.Errorf("%s metadata must carry exactly its current threshold of signatures", role)
	}
	authorized, err := roleKeySet(authority, role)
	if err != nil {
		return err
	}
	for _, signature := range signatures {
		if _, present := authorized[signature.KeyID]; !present {
			return fmt.Errorf("%s metadata carries signature %s outside the current root role", role, signature.KeyID)
		}
	}
	if err := authority.VerifyDelegate(role, value); err != nil {
		return fmt.Errorf("%s metadata does not meet the current root threshold: %w", role, err)
	}
	return nil
}

func verifyRetainedMetadataReference(reference *metadata.MetaFiles, expectedVersion int64, data []byte, label string) error {
	if err := validateSafeMetadataReference(reference, label); err != nil {
		return err
	}
	if reference.Version != expectedVersion {
		return fmt.Errorf("%s reference version differs from selected metadata", label)
	}
	if err := reference.VerifyLengthHashes(data); err != nil {
		return fmt.Errorf("%s reference: %w", label, err)
	}
	return nil
}

func validateRetainedLogicalTargetPath(logicalPath, environment string) (bool, error) {
	segments := strings.Split(logicalPath, "/")
	if len(segments) == 4 && segments[0] == "environments" && segments[1] == environment &&
		segments[2] == "channels" && segments[3] == "current.json" {
		return false, validateLogicalTargetPath(logicalPath, environment, "")
	}
	if len(segments) >= 5 && segments[0] == "environments" && segments[1] == environment &&
		segments[2] == "releases" && releaseIDPattern.MatchString(segments[3]) {
		return true, validateLogicalTargetPath(logicalPath, environment, segments[3])
	}
	return false, errors.New("logical target is outside the governed environment namespace")
}

func validateGenerationFreshness(expires, reference time.Time, minimum, maximum time.Duration, role string) error {
	remaining := expires.Sub(reference)
	if remaining < minimum || remaining > maximum {
		return fmt.Errorf("%s publication freshness is outside its governed window", role)
	}
	return nil
}

func classifyGenerationFile(relative, environment string) (int64, string, int64, error) {
	if relative == "metadata/timestamp.json" {
		return MaxTimestampMetadataBytes, metadata.TIMESTAMP, 0, nil
	}
	if match := versionedMetadataPattern.FindStringSubmatch(relative); match != nil {
		version, err := strconv.ParseInt(match[1], 10, 64)
		if err != nil || version < 1 || version > maxSafeInteger {
			return 0, "", 0, fmt.Errorf("metadata path %s has an invalid version", relative)
		}
		switch match[2] {
		case metadata.ROOT:
			return MaxRootMetadataBytes, metadata.ROOT, version, nil
		case metadata.TARGETS:
			return MaxTargetsMetadataBytes, metadata.TARGETS, version, nil
		case metadata.SNAPSHOT:
			return MaxSnapshotMetadataBytes, metadata.SNAPSHOT, version, nil
		}
	}
	if strings.HasPrefix(relative, "targets/") {
		match := physicalTargetNamePattern.FindStringSubmatch(filepath.Base(relative))
		if match == nil {
			return 0, "", 0, fmt.Errorf("physical target path %s has an invalid hash-prefixed name", relative)
		}
		logical := strings.TrimPrefix(filepath.ToSlash(filepath.Join(filepath.Dir(relative), match[2])), "targets/")
		segments := strings.Split(logical, "/")
		releaseID := ""
		if len(segments) >= 4 && segments[0] == "environments" && segments[1] == environment && segments[2] == "releases" {
			releaseID = segments[3]
		}
		if releaseID != "" && !releaseIDPattern.MatchString(releaseID) {
			return 0, "", 0, fmt.Errorf("physical target path %s has an invalid release ID", relative)
		}
		if err := validateLogicalTargetPath(logical, environment, releaseID); err != nil {
			return 0, "", 0, fmt.Errorf("physical target path %s: %w", relative, err)
		}
		return MaxTargetBytes, "target", 0, nil
	}
	return 0, "", 0, fmt.Errorf("repository file %s is outside the governed layout", relative)
}

func validateVersionTransition(previous previousGeneration, current generationMetadata, rootBytes, targetsBytes, snapshotBytes []byte, reference time.Time) error {
	if err := validateOfflineVersionTransition(previous, current, rootBytes, targetsBytes, reference); err != nil {
		return err
	}
	if err := validateRoleVersionTransition("snapshot", previous.snapshotVersion, current.snapshot.Signed.Version, previous.snapshotBytes, snapshotBytes); err != nil {
		return err
	}
	if current.timestamp.Signed.Version != previous.timestampVersion+1 {
		return errors.New("timestamp version must advance exactly one version from the previous generation")
	}
	return nil
}

func validateOfflineVersionTransition(previous previousGeneration, current generationMetadata, rootBytes, targetsBytes []byte, reference time.Time) error {
	if current.root.Signed.Version == previous.rootVersion {
		if !bytes.Equal(rootBytes, previous.rootBytes) {
			return errors.New("same-version root bytes differ from the previous generation")
		}
	} else if current.root.Signed.Version == previous.rootVersion+1 {
		if err := ValidateRootChain(previous.rootBytes, rootBytes, reference); err != nil {
			return err
		}
	} else {
		return errors.New("root version must remain exact or advance by one")
	}
	if err := validateRoleVersionTransition("targets", previous.targetsVersion, current.targets.Signed.Version, previous.targetsBytes, targetsBytes); err != nil {
		return err
	}
	return nil
}

func validateRoleVersionTransition(roleName string, previousVersion, currentVersion int64, previousBytes, currentBytes []byte) error {
	if currentVersion == previousVersion {
		if !bytes.Equal(previousBytes, currentBytes) {
			return fmt.Errorf("same-version %s bytes differ from the previous generation", roleName)
		}
		return nil
	}
	if currentVersion != previousVersion+1 {
		return fmt.Errorf("%s version must remain exact or advance by one", roleName)
	}
	return nil
}

func writeOrVerify(filePath string, data []byte) error {
	existing, err := readRegularFile(filePath, int64(len(data)))
	if err == nil {
		if !bytes.Equal(existing, data) {
			return errors.New("existing retained file has different bytes")
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) && !errors.Is(err, unix.ENOENT) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(filePath), 0o700); err != nil {
		return err
	}
	return writeExclusiveFile(filePath, data, 0o600)
}

func hashGenerationDirectory(directory string) ([]generationFile, string, error) {
	files := make([]generationFile, 0)
	err := filepath.WalkDir(directory, func(filePath string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 || !entry.Type().IsRegular() {
			return errors.New("materialized repository contains a non-regular entry")
		}
		relative, err := filepath.Rel(directory, filePath)
		if err != nil {
			return err
		}
		data, err := readRegularFile(filePath, MaxTargetBytes)
		if err != nil {
			return err
		}
		files = append(files, generationFile{Path: filepath.ToSlash(relative), Length: int64(len(data)), SHA256: sha256Hex(data)})
		if len(files) > MaxRepositoryFiles {
			return fmt.Errorf("repository exceeds %d files", MaxRepositoryFiles)
		}
		return nil
	})
	if err != nil {
		return nil, "", err
	}
	sort.Slice(files, func(left, right int) bool { return files[left].Path < files[right].Path })
	canonical, err := cjson.EncodeCanonical(files)
	if err != nil {
		return nil, "", err
	}
	return files, sha256Hex(canonical), nil
}

func syncGenerationDirectories(root string) error {
	directories := make([]string, 0)
	err := filepath.WalkDir(root, func(filePath string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("generation contains a symbolic link")
		}
		if entry.IsDir() {
			directories = append(directories, filePath)
		}
		return nil
	})
	if err != nil {
		return err
	}
	sort.Slice(directories, func(left, right int) bool {
		return strings.Count(directories[left], string(filepath.Separator)) > strings.Count(directories[right], string(filepath.Separator))
	})
	for _, directory := range directories {
		if err := syncDirectory(directory); err != nil {
			return err
		}
	}
	return nil
}
