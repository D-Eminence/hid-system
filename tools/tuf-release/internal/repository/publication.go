package repository

import (
	"bytes"
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// PublicationGeneration can only be constructed by inspecting a complete
// authenticated repository. Its private manifest binds retained files as well
// as the current four metadata roles. It is evidence, not a filesystem lock.
type PublicationGeneration struct {
	metadata MetadataSet
	files    []generationFile
	sha256   string
}

func (generation PublicationGeneration) SHA256() string { return generation.sha256 }
func (generation PublicationGeneration) FileCount() int { return len(generation.files) }

type PublicationFile struct {
	Path   string `json:"path"`
	Length int64  `json:"length"`
	SHA256 string `json:"sha256"`
}

func (generation PublicationGeneration) Files() []PublicationFile {
	files := make([]PublicationFile, len(generation.files))
	for index, file := range generation.files {
		files[index] = PublicationFile{Path: file.Path, Length: file.Length, SHA256: file.SHA256}
	}
	return files
}
func (generation PublicationGeneration) Metadata() MetadataSet {
	value := generation.metadata
	value.RootBytes = bytes.Clone(value.RootBytes)
	value.TargetsBytes = bytes.Clone(value.TargetsBytes)
	value.SnapshotBytes = bytes.Clone(value.SnapshotBytes)
	value.TimestampBytes = bytes.Clone(value.TimestampBytes)
	return value
}

func InspectPublicationGeneration(directory, environment string, reference time.Time, requireFresh bool) (PublicationGeneration, error) {
	if environment != "staging" && environment != "production" || reference.IsZero() ||
		!filepath.IsAbs(directory) || filepath.Clean(directory) != directory {
		return PublicationGeneration{}, errors.New("publication repository path or context is invalid")
	}
	resolved, err := filepath.EvalSymlinks(directory)
	if err != nil || resolved != directory {
		return PublicationGeneration{}, errors.New("publication repository path must contain no symbolic links")
	}
	validated, err := validateGenerationDirectory(directory, environment, reference, requireFresh)
	if err != nil {
		return PublicationGeneration{}, err
	}
	state := validated.state
	timestamp, err := readRegularFile(filepath.Join(directory, "metadata", "timestamp.json"), MaxTimestampMetadataBytes)
	if err != nil {
		return PublicationGeneration{}, err
	}
	releaseID, err := DiscoverTargetsReleaseID(state.targetsBytes, environment)
	if err != nil {
		return PublicationGeneration{}, err
	}
	set := MetadataSet{
		Environment: environment, ReleaseID: releaseID, ReferenceTime: reference, RequireFresh: requireFresh,
		RootBytes: state.rootBytes, TargetsBytes: state.targetsBytes, SnapshotBytes: state.snapshotBytes, TimestampBytes: timestamp,
	}
	if _, err := ValidateMetadataSet(set); err != nil {
		return PublicationGeneration{}, err
	}
	// The layout validator hashes and parses in separate bounded passes. Match
	// the selected exact bytes to that manifest and detect any intervening edit.
	expected := map[string][]byte{
		"metadata/" + strconv.FormatInt(state.rootVersion, 10) + ".root.json":         state.rootBytes,
		"metadata/" + strconv.FormatInt(state.targetsVersion, 10) + ".targets.json":   state.targetsBytes,
		"metadata/" + strconv.FormatInt(state.snapshotVersion, 10) + ".snapshot.json": state.snapshotBytes,
		"metadata/timestamp.json": timestamp,
	}
	for _, file := range validated.files {
		if data, ok := expected[file.Path]; ok {
			if int64(len(data)) != file.Length || sha256Hex(data) != file.SHA256 {
				return PublicationGeneration{}, errors.New("publication metadata changed while being inspected")
			}
			delete(expected, file.Path)
		}
	}
	if len(expected) != 0 {
		return PublicationGeneration{}, errors.New("publication metadata is absent from the repository manifest")
	}
	_, finalHash, err := hashGenerationDirectory(directory)
	if err != nil {
		return PublicationGeneration{}, err
	}
	if finalHash != validated.repositorySHA256 {
		return PublicationGeneration{}, errors.New("publication repository changed while being inspected")
	}
	return PublicationGeneration{metadata: set, files: validated.files, sha256: finalHash}, nil
}

// ValidatePublicationSuccessor preserves every previously published immutable
// file. Snapshot/timestamp gaps are deliberately not authorizations here; the
// publisher must separately exact-match the durable broker checkpoint.
func ValidatePublicationSuccessor(previous, candidate PublicationGeneration) error {
	if !sha256Pattern.MatchString(previous.sha256) || !sha256Pattern.MatchString(candidate.sha256) ||
		previous.metadata.Environment != candidate.metadata.Environment {
		return errors.New("inspected publication predecessor and candidate are required")
	}
	previousFiles := make(map[string]generationFile, len(previous.files))
	for _, file := range previous.files {
		if file.Path != "metadata/timestamp.json" {
			previousFiles[file.Path] = file
		}
	}
	state, err := ValidateMetadataSet(candidate.Metadata())
	if err != nil {
		return err
	}
	selectedMetadata := map[string]bool{
		"metadata/" + strconv.FormatInt(state.RootVersion, 10) + ".root.json":         true,
		"metadata/" + strconv.FormatInt(state.TargetsVersion, 10) + ".targets.json":   true,
		"metadata/" + strconv.FormatInt(state.SnapshotVersion, 10) + ".snapshot.json": true,
		"metadata/timestamp.json": true,
	}
	for _, file := range candidate.files {
		if prior, exists := previousFiles[file.Path]; exists {
			if prior != file {
				return fmt.Errorf("published immutable file %s changed", file.Path)
			}
			delete(previousFiles, file.Path)
		} else if strings.HasPrefix(file.Path, "metadata/") && !selectedMetadata[file.Path] {
			return fmt.Errorf("candidate introduces unselected metadata %s", file.Path)
		}
	}
	if len(previousFiles) != 0 {
		return errors.New("candidate omits previously published immutable files")
	}
	return nil
}
