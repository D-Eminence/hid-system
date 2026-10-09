// Command hid-tuf-repo is the isolated release-operator metadata boundary.
// It never creates/imports a key and has no generic arbitrary-signing command.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/kms"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/kmssigner"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/repository"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, os.Args[1:], os.Stdout); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "hid-tuf-repo:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, arguments []string, output io.Writer) error {
	if len(arguments) == 0 {
		return errors.New(usage())
	}
	switch arguments[0] {
	case "prepare-targets":
		return runPrepareTargets(arguments[1:], output)
	case "prepare-targets-attestation":
		return runPrepareTargetsAttestation(arguments[1:], output)
	case "complete-targets-evidence":
		return runCompleteTargetsEvidence(arguments[1:], output)
	case "assemble-targets":
		return runAssembleTargets(arguments[1:], output)
	case "sign-snapshot":
		return runSignSnapshot(ctx, arguments[1:], output)
	case "sign-timestamp":
		return runSignTimestamp(ctx, arguments[1:], output)
	case "materialize-generation":
		return runMaterializeGeneration(arguments[1:], output)
	default:
		return errors.New(usage())
	}
}

func usage() string {
	return "usage:\n" +
		"  hid-tuf-repo prepare-targets ABSOLUTE_PLAN ABSOLUTE_ROOT ABSENT_OUTPUT_DIRECTORY\n" +
		"  hid-tuf-repo prepare-targets-attestation ABSOLUTE_PLAN ABSOLUTE_ROOT ABSOLUTE_PREPARED_DIRECTORY KEY_ID TUF_SIGNATURE_HEX SIGNED_AT ABSENT_STATEMENT_JSON\n" +
		"  hid-tuf-repo complete-targets-evidence ABSOLUTE_PLAN ABSOLUTE_ROOT ABSOLUTE_PREPARED_DIRECTORY KEY_ID TUF_SIGNATURE_HEX SIGNED_AT ATTESTATION_HEX ABSENT_EVIDENCE_JSON\n" +
		"  hid-tuf-repo assemble-targets ABSOLUTE_PLAN ABSOLUTE_ROOT ABSOLUTE_PREPARED_DIRECTORY ABSENT_VERSIONED_TARGETS_JSON ABSOLUTE_SIGNATURE_1 ABSOLUTE_SIGNATURE_2\n" +
		"  hid-tuf-repo sign-snapshot ABSOLUTE_SIGNING_PLAN ABSENT_VERSIONED_SNAPSHOT_JSON\n" +
		"  hid-tuf-repo sign-timestamp ABSOLUTE_SIGNING_PLAN ABSENT_TIMESTAMP_JSON\n" +
		"  hid-tuf-repo materialize-generation ABSOLUTE_GENERATION_PLAN ABSENT_OUTPUT_DIRECTORY"
}

func runPrepareTargetsAttestation(arguments []string, output io.Writer) error {
	if len(arguments) != 7 {
		return errors.New(usage())
	}
	planPath, rootPath, preparedDirectory := arguments[0], arguments[1], arguments[2]
	keyID, tufSignature, signedAt, outputPath := arguments[3], arguments[4], arguments[5], arguments[6]
	if err := requireTargetsCeremonyInputs(planPath, rootPath, preparedDirectory); err != nil {
		return err
	}
	if filepath.Base(outputPath) != repository.TargetsAttestationStatementName {
		return fmt.Errorf("targets attestation output filename must be %s", repository.TargetsAttestationStatementName)
	}
	if err := requireOutputPath(outputPath, "targets attestation output"); err != nil {
		return err
	}
	if filepath.Dir(outputPath) == preparedDirectory {
		return errors.New("targets attestation output must be outside the prepared targets directory")
	}
	plan, rootBytes, prepared, err := loadPreparedTargets(planPath, rootPath, preparedDirectory)
	if err != nil {
		return err
	}
	_, statement, err := repository.PrepareTargetsEvidenceAttestation(prepared, rootBytes, keyID, tufSignature, signedAt)
	if err != nil {
		return err
	}
	if err := repository.WriteExclusiveEvidenceFile(outputPath, statement, repository.MaxTargetsAttestationBytes); err != nil {
		return err
	}
	return writeResult(output, map[string]any{
		"schema_version": repository.SchemaVersion, "action": "prepare-targets-attestation",
		"environment": plan.Environment, "repository_id": plan.RepositoryID, "release_id": plan.ReleaseID,
		"root_sha256": prepared.RootSHA256, "targets_version": plan.TargetsVersion,
		"payload_sha256": prepared.PayloadSHA256, "keyid": keyID,
		"signed_at": signedAt, "statement_sha256": sha256Hex(statement),
	})
}

func runCompleteTargetsEvidence(arguments []string, output io.Writer) error {
	if len(arguments) != 8 {
		return errors.New(usage())
	}
	planPath, rootPath, preparedDirectory := arguments[0], arguments[1], arguments[2]
	keyID, tufSignature, signedAt, attestation, outputPath := arguments[3], arguments[4], arguments[5], arguments[6], arguments[7]
	if err := requireTargetsCeremonyInputs(planPath, rootPath, preparedDirectory); err != nil {
		return err
	}
	if filepath.Base(outputPath) != repository.TargetsSignatureEvidenceName {
		return fmt.Errorf("targets evidence output filename must be %s", repository.TargetsSignatureEvidenceName)
	}
	if err := requireOutputPath(outputPath, "targets evidence output"); err != nil {
		return err
	}
	if filepath.Dir(outputPath) == preparedDirectory {
		return errors.New("targets evidence output must be outside the prepared targets directory")
	}
	plan, rootBytes, prepared, err := loadPreparedTargets(planPath, rootPath, preparedDirectory)
	if err != nil {
		return err
	}
	evidence, err := repository.CompleteTargetsEvidence(prepared, rootBytes, keyID, tufSignature, signedAt, attestation)
	if err != nil {
		return err
	}
	evidenceBytes, err := json.MarshalIndent(evidence, "", "  ")
	if err != nil {
		return fmt.Errorf("encode targets signature evidence: %w", err)
	}
	evidenceBytes = append(evidenceBytes, '\n')
	if err := repository.WriteExclusiveEvidenceFile(outputPath, evidenceBytes, repository.MaxDetachedSignatureBytes); err != nil {
		return err
	}
	return writeResult(output, map[string]any{
		"schema_version": repository.SchemaVersion, "action": "complete-targets-evidence",
		"environment": plan.Environment, "repository_id": plan.RepositoryID, "release_id": plan.ReleaseID,
		"root_sha256": prepared.RootSHA256, "targets_version": plan.TargetsVersion,
		"payload_sha256": prepared.PayloadSHA256, "keyid": keyID,
		"signed_at": signedAt, "evidence_sha256": sha256Hex(evidenceBytes),
	})
}

func requireTargetsCeremonyInputs(planPath, rootPath, preparedDirectory string) error {
	for _, input := range []struct {
		path  string
		label string
	}{
		{planPath, "targets plan"}, {rootPath, "root metadata"},
	} {
		if err := requireInputPath(input.path, input.label); err != nil {
			return err
		}
	}
	return requireInputDirectory(preparedDirectory, "prepared targets")
}

func loadPreparedTargets(planPath, rootPath, preparedDirectory string) (repository.TargetsPlan, []byte, repository.PreparedTargets, error) {
	plan, err := repository.LoadTargetsPlan(planPath)
	if err != nil {
		return repository.TargetsPlan{}, nil, repository.PreparedTargets{}, err
	}
	rootBytes, err := repository.ReadRootFile(rootPath)
	if err != nil {
		return repository.TargetsPlan{}, nil, repository.PreparedTargets{}, err
	}
	prepared, err := repository.LoadPreparedTargetsDirectory(preparedDirectory, plan, rootBytes)
	if err != nil {
		return repository.TargetsPlan{}, nil, repository.PreparedTargets{}, err
	}
	return plan, rootBytes, prepared, nil
}

func runPrepareTargets(arguments []string, output io.Writer) error {
	if len(arguments) != 3 {
		return errors.New(usage())
	}
	planPath, rootPath, outputDirectory := arguments[0], arguments[1], arguments[2]
	if err := requireInputPath(planPath, "targets plan"); err != nil {
		return err
	}
	if err := requireInputPath(rootPath, "root metadata"); err != nil {
		return err
	}
	plan, err := repository.LoadTargetsPlan(planPath)
	if err != nil {
		return err
	}
	rootBytes, err := repository.ReadRootFile(rootPath)
	if err != nil {
		return err
	}
	prepared, err := repository.PrepareTargets(plan, rootBytes)
	if err != nil {
		return err
	}
	request, err := repository.WritePreparedTargetsDirectory(outputDirectory, prepared)
	if err != nil {
		return err
	}
	return writeResult(output, map[string]any{
		"schema_version": repository.SchemaVersion, "action": "prepare-targets",
		"environment": request.Environment, "repository_id": request.RepositoryID,
		"release_id": request.ReleaseID, "root_version": request.RootVersion,
		"root_sha256": request.RootSHA256, "targets_version": request.TargetsVersion,
		"payload_sha256": request.PayloadSHA256,
	})
}

func runAssembleTargets(arguments []string, output io.Writer) error {
	if len(arguments) != 6 {
		return errors.New(usage())
	}
	planPath, rootPath, preparedDirectory, outputPath := arguments[0], arguments[1], arguments[2], arguments[3]
	for _, input := range []struct {
		path  string
		label string
	}{
		{planPath, "targets plan"}, {rootPath, "root metadata"},
		{arguments[4], "detached signature 1"}, {arguments[5], "detached signature 2"},
	} {
		if err := requireInputPath(input.path, input.label); err != nil {
			return err
		}
	}
	if err := requireInputDirectory(preparedDirectory, "prepared targets"); err != nil {
		return err
	}
	plan, err := repository.LoadTargetsPlan(planPath)
	if err != nil {
		return err
	}
	if filepath.Base(outputPath) != strconv.FormatInt(plan.TargetsVersion, 10)+".targets.json" {
		return errors.New("targets output filename must equal its signed version")
	}
	if err := requireOutputPath(outputPath, "targets metadata output"); err != nil {
		return err
	}
	rootBytes, err := repository.ReadRootFile(rootPath)
	if err != nil {
		return err
	}
	prepared, err := repository.LoadPreparedTargetsDirectory(preparedDirectory, plan, rootBytes)
	if err != nil {
		return err
	}
	evidence := make([]repository.DetachedSignature, 2)
	for index, signaturePath := range arguments[4:] {
		evidence[index], err = repository.LoadDetachedSignature(signaturePath)
		if err != nil {
			return err
		}
	}
	metadataBytes, err := repository.AssembleTargets(prepared, rootBytes, evidence)
	if err != nil {
		return err
	}
	if err := repository.WriteExclusiveMetadataFile(outputPath, metadataBytes, repository.MaxTargetsMetadataBytes); err != nil {
		return err
	}
	return writeResult(output, map[string]any{
		"schema_version": repository.SchemaVersion, "action": "assemble-targets",
		"environment": plan.Environment, "repository_id": plan.RepositoryID, "release_id": plan.ReleaseID,
		"root_sha256": prepared.RootSHA256, "targets_version": plan.TargetsVersion,
		"targets_sha256": sha256Hex(metadataBytes),
	})
}

func runSignSnapshot(ctx context.Context, arguments []string, output io.Writer) error {
	if len(arguments) != 2 {
		return errors.New(usage())
	}
	return runOnlineRole(ctx, "snapshot", arguments[0], arguments[1], output)
}

func runSignTimestamp(ctx context.Context, arguments []string, output io.Writer) error {
	if len(arguments) != 2 {
		return errors.New(usage())
	}
	return runOnlineRole(ctx, "timestamp", arguments[0], arguments[1], output)
}

func runMaterializeGeneration(arguments []string, output io.Writer) error {
	if len(arguments) != 2 {
		return errors.New(usage())
	}
	planPath, outputDirectory := arguments[0], arguments[1]
	if err := requireInputPath(planPath, "generation plan"); err != nil {
		return err
	}
	if err := requireOutputDirectory(outputDirectory, "repository generation output"); err != nil {
		return err
	}
	validated, err := repository.LoadGenerationPlan(planPath)
	if err != nil {
		return err
	}
	plan := validated.Plan
	for _, input := range []struct {
		path  string
		label string
	}{
		{plan.TargetsPlanPath, "targets plan"},
		{plan.RootPath, "root metadata"},
		{plan.TargetsMetadataPath, "targets metadata"},
		{plan.SnapshotMetadataPath, "snapshot metadata"},
		{plan.TimestampMetadataPath, "timestamp metadata"},
	} {
		if err := requireInputPath(input.path, input.label); err != nil {
			return err
		}
	}
	if err := requireInputDirectory(plan.PreparedTargetsDirectory, "prepared targets"); err != nil {
		return err
	}
	if plan.PreviousRepository != "" {
		if err := requireInputDirectory(plan.PreviousRepository, "previous repository"); err != nil {
			return err
		}
	}
	targetsPlan, err := repository.LoadTargetsPlan(plan.TargetsPlanPath)
	if err != nil {
		return err
	}
	if targetsPlan.Environment != plan.Environment || targetsPlan.RepositoryID != plan.RepositoryID ||
		targetsPlan.ReleaseID != plan.ReleaseID || targetsPlan.RootVersion != plan.RootVersion ||
		targetsPlan.TargetsVersion != plan.TargetsVersion {
		return errors.New("generation plan context does not match its targets plan")
	}
	rootBytes, err := repository.ReadRootFile(plan.RootPath)
	if err != nil {
		return err
	}
	if sha256Hex(rootBytes) != plan.RootSHA256 {
		return errors.New("generation root SHA-256 does not match its plan")
	}
	prepared, err := repository.LoadPreparedTargetsDirectory(plan.PreparedTargetsDirectory, targetsPlan, rootBytes)
	if err != nil {
		return err
	}
	targetsBytes, err := repository.ReadTargetsMetadataFile(plan.TargetsMetadataPath)
	if err != nil {
		return err
	}
	snapshotBytes, err := repository.ReadSnapshotMetadataFile(plan.SnapshotMetadataPath)
	if err != nil {
		return err
	}
	timestampBytes, err := repository.ReadTimestampMetadataFile(plan.TimestampMetadataPath)
	if err != nil {
		return err
	}
	if sha256Hex(targetsBytes) != plan.TargetsMetadataSHA256 ||
		sha256Hex(snapshotBytes) != plan.SnapshotMetadataSHA256 ||
		sha256Hex(timestampBytes) != plan.TimestampMetadataSHA256 {
		return errors.New("generation metadata SHA-256 does not match its plan")
	}
	result, err := repository.MaterializeGeneration(repository.GenerationInput{
		PreviousDirectory: plan.PreviousRepository, PreviousRepositorySHA256: plan.PreviousRepositorySHA256,
		DestinationDirectory: outputDirectory, ReferenceTime: validated.ReferenceTime,
		ExpectedRootVersion: plan.RootVersion, ExpectedTargetsVersion: plan.TargetsVersion,
		ExpectedSnapshotVersion: plan.SnapshotVersion, ExpectedTimestampVersion: plan.TimestampVersion,
		Prepared: prepared, RootBytes: rootBytes, TargetsBytes: targetsBytes,
		SnapshotBytes: snapshotBytes, TimestampBytes: timestampBytes,
	})
	if err != nil {
		return err
	}
	return writeResult(output, result)
}

func runOnlineRole(ctx context.Context, roleName, planPath, outputPath string, output io.Writer) error {
	if err := requireInputPath(planPath, roleName+" signing plan"); err != nil {
		return err
	}
	validated, err := repository.LoadOnlineSigningPlan(planPath, roleName)
	if err != nil {
		return err
	}
	validated, err = repository.ValidateOnlineSigningPlanAt(validated.Plan, roleName, time.Now())
	if err != nil {
		return err
	}
	plan := validated.Plan
	expectedOutput := "timestamp.json"
	maximumOutput := repository.MaxTimestampMetadataBytes
	if roleName == "snapshot" {
		expectedOutput = strconv.FormatInt(plan.OutputMetadataVersion, 10) + ".snapshot.json"
		maximumOutput = repository.MaxSnapshotMetadataBytes
	}
	if filepath.Base(outputPath) != expectedOutput {
		return fmt.Errorf("%s output filename must be %s", roleName, expectedOutput)
	}
	if err := requireOutputPath(outputPath, roleName+" metadata output"); err != nil {
		return err
	}
	rootBytes, err := repository.ReadRootFile(plan.RootPath)
	if err != nil {
		return err
	}
	var inputBytes []byte
	if roleName == "snapshot" {
		inputBytes, err = repository.ReadTargetsMetadataFile(plan.InputMetadataPath)
	} else {
		inputBytes, err = repository.ReadSnapshotMetadataFile(plan.InputMetadataPath)
	}
	if err != nil {
		return err
	}
	var previousBytes, previousRootBytes []byte
	if plan.PreviousMetadataPath != "" {
		if err := requireInputPath(plan.PreviousMetadataPath, "previous "+roleName+" metadata"); err != nil {
			return err
		}
		if err := requireInputPath(plan.PreviousRootPath, "previous online root"); err != nil {
			return err
		}
		if roleName == "snapshot" {
			previousBytes, err = repository.ReadSnapshotMetadataFile(plan.PreviousMetadataPath)
		} else {
			previousBytes, err = repository.ReadTimestampMetadataFile(plan.PreviousMetadataPath)
		}
		if err != nil {
			return err
		}
		previousRootBytes, err = repository.ReadRootFile(plan.PreviousRootPath)
		if err != nil {
			return err
		}
	}
	if err := repository.ValidateOnlineSigningInputs(plan, rootBytes, inputBytes, previousBytes, previousRootBytes); err != nil {
		return err
	}
	validated, err = repository.ValidateOnlineSigningPlanAt(plan, roleName, time.Now())
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	awsConfiguration, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(plan.AWSRegion))
	if err != nil {
		return fmt.Errorf("load AWS configuration for %s signer: %w", roleName, err)
	}
	signer, err := kmssigner.New(ctx, kms.NewFromConfig(awsConfiguration), kmssigner.Config{
		KeyARN: plan.KMSKeyARN, PublicKeyDERChecksum: plan.KMSPublicKeyDERChecksum,
	})
	if err != nil {
		return fmt.Errorf("initialize %s KMS signer: %w", roleName, err)
	}

	var metadataBytes []byte
	if roleName == "snapshot" {
		metadataBytes, err = repository.BuildSnapshot(rootBytes, inputBytes, repository.SnapshotOptions{
			Environment: plan.Environment, RepositoryID: plan.RepositoryID, ReleaseID: plan.ReleaseID,
			RootVersion: plan.RootVersion, Version: plan.OutputMetadataVersion,
			CreatedAt: validated.CreatedAt, Expires: validated.Expires,
			ExpectedTargetsVersion: plan.InputMetadataVersion, ExpectedTargetsSHA256: plan.InputMetadataSHA256,
		}, signer)
	} else {
		metadataBytes, err = repository.BuildTimestamp(rootBytes, inputBytes, repository.TimestampOptions{
			Environment: plan.Environment, RepositoryID: plan.RepositoryID, ReleaseID: plan.ReleaseID,
			RootVersion: plan.RootVersion, Version: plan.OutputMetadataVersion,
			CreatedAt: validated.CreatedAt, Expires: validated.Expires,
			ExpectedSnapshotVersion: plan.InputMetadataVersion, ExpectedSnapshotSHA256: plan.InputMetadataSHA256,
		}, signer)
	}
	if err != nil {
		return err
	}
	if err := repository.WriteExclusiveMetadataFile(outputPath, metadataBytes, maximumOutput); err != nil {
		return err
	}
	return writeResult(output, map[string]any{
		"schema_version": repository.SchemaVersion, "action": "sign-" + roleName,
		"environment": plan.Environment, "repository_id": plan.RepositoryID, "release_id": plan.ReleaseID,
		"root_sha256": plan.RootSHA256, "metadata_version": plan.OutputMetadataVersion,
		"metadata_sha256": sha256Hex(metadataBytes),
	})
}

func requireInputPath(filePath, label string) error {
	if filePath == "" || !filepath.IsAbs(filePath) || filepath.Clean(filePath) != filePath {
		return fmt.Errorf("%s path must be canonical and absolute", label)
	}
	parent := filepath.Dir(filePath)
	realParent, err := filepath.EvalSymlinks(parent)
	if err != nil || realParent != parent {
		return fmt.Errorf("%s parent path must contain no symbolic links", label)
	}
	info, err := os.Lstat(filePath)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s must be a regular non-symbolic-link file", label)
	}
	return nil
}

func requireInputDirectory(directory, label string) error {
	if directory == "" || !filepath.IsAbs(directory) || filepath.Clean(directory) != directory {
		return fmt.Errorf("%s path must be canonical and absolute", label)
	}
	realDirectory, err := filepath.EvalSymlinks(directory)
	if err != nil || realDirectory != directory {
		return fmt.Errorf("%s path must contain no symbolic links", label)
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s must be a real directory", label)
	}
	return nil
}

func requireOutputPath(filePath, label string) error {
	if filePath == "" || !filepath.IsAbs(filePath) || filepath.Clean(filePath) != filePath {
		return fmt.Errorf("%s path must be canonical and absolute", label)
	}
	parent := filepath.Dir(filePath)
	realParent, err := filepath.EvalSymlinks(parent)
	if err != nil || realParent != parent {
		return fmt.Errorf("%s parent path must be an existing path without symbolic links", label)
	}
	info, err := os.Lstat(parent)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s parent must be a real directory", label)
	}
	if _, err := os.Lstat(filePath); !errors.Is(err, os.ErrNotExist) {
		if err == nil {
			return fmt.Errorf("%s already exists", label)
		}
		return err
	}
	return nil
}

func requireOutputDirectory(directory, label string) error {
	if directory == "" || !filepath.IsAbs(directory) || filepath.Clean(directory) != directory {
		return fmt.Errorf("%s path must be canonical and absolute", label)
	}
	parent := filepath.Dir(directory)
	realParent, err := filepath.EvalSymlinks(parent)
	if err != nil || realParent != parent {
		return fmt.Errorf("%s parent must be an existing path without symbolic links", label)
	}
	info, err := os.Lstat(parent)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s parent must be a real directory", label)
	}
	if _, err := os.Lstat(directory); !errors.Is(err, os.ErrNotExist) {
		if err == nil {
			return fmt.Errorf("%s already exists", label)
		}
		return err
	}
	return nil
}

func writeResult(output io.Writer, result any) error {
	encoder := json.NewEncoder(output)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(result)
}

func sha256Hex(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}
