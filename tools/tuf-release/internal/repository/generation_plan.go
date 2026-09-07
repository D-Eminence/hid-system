package repository

import (
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/strictjson"
)

const MaxGenerationPlanBytes int64 = 64_000

type GenerationPlan struct {
	SchemaVersion            string `json:"schema_version"`
	Environment              string `json:"environment"`
	RepositoryID             string `json:"repository_id"`
	ReleaseID                string `json:"release_id"`
	ReferenceTime            string `json:"reference_time"`
	PreviousRepository       string `json:"previous_repository"`
	PreviousRepositorySHA256 string `json:"previous_repository_sha256"`
	TargetsPlanPath          string `json:"targets_plan_path"`
	PreparedTargetsDirectory string `json:"prepared_targets_directory"`
	RootPath                 string `json:"root_path"`
	RootSHA256               string `json:"root_sha256"`
	RootVersion              int64  `json:"root_version"`
	TargetsMetadataPath      string `json:"targets_metadata_path"`
	TargetsMetadataSHA256    string `json:"targets_metadata_sha256"`
	TargetsVersion           int64  `json:"targets_version"`
	SnapshotMetadataPath     string `json:"snapshot_metadata_path"`
	SnapshotMetadataSHA256   string `json:"snapshot_metadata_sha256"`
	SnapshotVersion          int64  `json:"snapshot_version"`
	TimestampMetadataPath    string `json:"timestamp_metadata_path"`
	TimestampMetadataSHA256  string `json:"timestamp_metadata_sha256"`
	TimestampVersion         int64  `json:"timestamp_version"`
}

type ValidatedGenerationPlan struct {
	Plan          GenerationPlan
	ReferenceTime time.Time
}

// LoadGenerationInput resolves one strict plan and exact prepared metadata.
// Materialization still independently validates the complete candidate and
// predecessor, including the absent destination and every retained target.
func LoadGenerationInput(planPath, outputDirectory string) (GenerationInput, error) {
	validated, err := LoadGenerationPlan(planPath)
	if err != nil {
		return GenerationInput{}, err
	}
	plan := validated.Plan
	targetsPlan, err := LoadTargetsPlan(plan.TargetsPlanPath)
	if err != nil {
		return GenerationInput{}, err
	}
	if targetsPlan.Environment != plan.Environment || targetsPlan.RepositoryID != plan.RepositoryID || targetsPlan.ReleaseID != plan.ReleaseID ||
		targetsPlan.RootVersion != plan.RootVersion || targetsPlan.TargetsVersion != plan.TargetsVersion {
		return GenerationInput{}, errors.New("generation plan context does not match its targets plan")
	}
	rootBytes, err := ReadRootFile(plan.RootPath)
	if err != nil {
		return GenerationInput{}, err
	}
	if sha256Hex(rootBytes) != plan.RootSHA256 {
		return GenerationInput{}, errors.New("generation root SHA-256 does not match its plan")
	}
	prepared, err := LoadPreparedTargetsDirectory(plan.PreparedTargetsDirectory, targetsPlan, rootBytes)
	if err != nil {
		return GenerationInput{}, err
	}
	targetsBytes, err := ReadTargetsMetadataFile(plan.TargetsMetadataPath)
	if err != nil {
		return GenerationInput{}, err
	}
	snapshotBytes, err := ReadSnapshotMetadataFile(plan.SnapshotMetadataPath)
	if err != nil {
		return GenerationInput{}, err
	}
	timestampBytes, err := ReadTimestampMetadataFile(plan.TimestampMetadataPath)
	if err != nil {
		return GenerationInput{}, err
	}
	if sha256Hex(targetsBytes) != plan.TargetsMetadataSHA256 || sha256Hex(snapshotBytes) != plan.SnapshotMetadataSHA256 || sha256Hex(timestampBytes) != plan.TimestampMetadataSHA256 {
		return GenerationInput{}, errors.New("generation metadata SHA-256 does not match its plan")
	}
	return GenerationInput{
		PreviousDirectory: plan.PreviousRepository, PreviousRepositorySHA256: plan.PreviousRepositorySHA256,
		DestinationDirectory: outputDirectory, ReferenceTime: validated.ReferenceTime,
		ExpectedRootVersion: plan.RootVersion, ExpectedTargetsVersion: plan.TargetsVersion, ExpectedSnapshotVersion: plan.SnapshotVersion, ExpectedTimestampVersion: plan.TimestampVersion,
		Prepared: prepared, RootBytes: rootBytes, TargetsBytes: targetsBytes, SnapshotBytes: snapshotBytes, TimestampBytes: timestampBytes,
	}, nil
}

func LoadGenerationPlan(filePath string) (ValidatedGenerationPlan, error) {
	data, err := readRegularFile(filePath, MaxGenerationPlanBytes)
	if err != nil {
		return ValidatedGenerationPlan{}, fmt.Errorf("read generation plan: %w", err)
	}
	var raw any
	if err := strictjson.Decode(data, &raw); err != nil {
		return ValidatedGenerationPlan{}, fmt.Errorf("decode generation plan shape: %w", err)
	}
	if _, err := exactObject(raw, "generation plan",
		"environment", "prepared_targets_directory", "previous_repository", "previous_repository_sha256", "reference_time", "release_id",
		"repository_id", "root_path", "root_sha256", "root_version", "schema_version",
		"snapshot_metadata_path", "snapshot_metadata_sha256", "snapshot_version",
		"targets_metadata_path", "targets_metadata_sha256", "targets_plan_path", "targets_version",
		"timestamp_metadata_path", "timestamp_metadata_sha256", "timestamp_version"); err != nil {
		return ValidatedGenerationPlan{}, err
	}
	var plan GenerationPlan
	if err := strictjson.Decode(data, &plan); err != nil {
		return ValidatedGenerationPlan{}, fmt.Errorf("decode generation plan: %w", err)
	}
	return ValidateGenerationPlan(plan)
}

func ValidateGenerationPlan(plan GenerationPlan) (ValidatedGenerationPlan, error) {
	if plan.SchemaVersion != SchemaVersion || (plan.Environment != "staging" && plan.Environment != "production") ||
		plan.RepositoryID != governedRepositoryID(plan.Environment) || !releaseIDPattern.MatchString(plan.ReleaseID) {
		return ValidatedGenerationPlan{}, errors.New("generation plan schema or repository/release identity is invalid")
	}
	referenceTime, err := parseWholeSecondUTC(plan.ReferenceTime, "generation plan reference_time")
	if err != nil {
		return ValidatedGenerationPlan{}, err
	}
	if plan.RootVersion < 1 || plan.RootVersion > maxSafeInteger ||
		plan.TargetsVersion < 1 || plan.TargetsVersion > maxSafeInteger ||
		plan.SnapshotVersion < 1 || plan.SnapshotVersion > maxSafeInteger ||
		plan.TimestampVersion < 1 || plan.TimestampVersion > maxSafeInteger ||
		!sha256Pattern.MatchString(plan.RootSHA256) || !sha256Pattern.MatchString(plan.TargetsMetadataSHA256) ||
		!sha256Pattern.MatchString(plan.SnapshotMetadataSHA256) || !sha256Pattern.MatchString(plan.TimestampMetadataSHA256) {
		return ValidatedGenerationPlan{}, errors.New("generation plan versions or SHA-256 pins are invalid")
	}
	if filepath.Base(plan.RootPath) != strconv.FormatInt(plan.RootVersion, 10)+".root.json" ||
		filepath.Base(plan.TargetsMetadataPath) != strconv.FormatInt(plan.TargetsVersion, 10)+".targets.json" ||
		filepath.Base(plan.SnapshotMetadataPath) != strconv.FormatInt(plan.SnapshotVersion, 10)+".snapshot.json" ||
		filepath.Base(plan.TimestampMetadataPath) != "timestamp.json" {
		return ValidatedGenerationPlan{}, errors.New("generation plan metadata filenames do not match their roles and versions")
	}
	paths := []struct {
		value string
		label string
	}{
		{plan.TargetsPlanPath, "targets plan"},
		{plan.PreparedTargetsDirectory, "prepared targets directory"},
		{plan.RootPath, "root metadata"},
		{plan.TargetsMetadataPath, "targets metadata"},
		{plan.SnapshotMetadataPath, "snapshot metadata"},
		{plan.TimestampMetadataPath, "timestamp metadata"},
	}
	seen := make(map[string]string, len(paths))
	for _, candidate := range paths {
		if err := validateAbsoluteInput(candidate.value, "generation plan "+candidate.label); err != nil {
			return ValidatedGenerationPlan{}, err
		}
		if previousLabel, duplicate := seen[candidate.value]; duplicate {
			return ValidatedGenerationPlan{}, fmt.Errorf("generation plan paths for %s and %s must differ", previousLabel, candidate.label)
		}
		seen[candidate.value] = candidate.label
	}
	genesis := plan.RootVersion == 1 && plan.TargetsVersion == 1 && plan.SnapshotVersion == 1 && plan.TimestampVersion == 1
	if genesis {
		if plan.PreviousRepository != "" || plan.PreviousRepositorySHA256 != "" {
			return ValidatedGenerationPlan{}, errors.New("an all-version-1 genesis plan must not name a previous repository")
		}
	} else {
		if plan.PreviousRepository == "" || !sha256Pattern.MatchString(plan.PreviousRepositorySHA256) {
			return ValidatedGenerationPlan{}, errors.New("a non-genesis generation plan requires a pinned previous repository")
		}
		if err := validateAbsoluteInput(plan.PreviousRepository, "generation plan previous repository"); err != nil {
			return ValidatedGenerationPlan{}, err
		}
	}
	return ValidatedGenerationPlan{Plan: plan, ReferenceTime: referenceTime}, nil
}
