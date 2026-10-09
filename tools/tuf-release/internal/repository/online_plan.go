package repository

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/strictjson"
)

const MaxOnlineSigningPlanBytes int64 = 64_000

var (
	awsAccountPattern  = regexp.MustCompile(`^[0-9]{12}$`)
	awsRegionPattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{2,31}$`)
	kmsResourcePattern = regexp.MustCompile(`^key/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$`)
)

type OnlineSigningPlan struct {
	SchemaVersion           string `json:"schema_version"`
	Role                    string `json:"role"`
	Environment             string `json:"environment"`
	RepositoryID            string `json:"repository_id"`
	ReleaseID               string `json:"release_id"`
	CreatedAt               string `json:"created_at"`
	Expires                 string `json:"expires"`
	RootPath                string `json:"root_path"`
	RootSHA256              string `json:"root_sha256"`
	RootVersion             int64  `json:"root_version"`
	InputMetadataPath       string `json:"input_metadata_path"`
	InputMetadataSHA256     string `json:"input_metadata_sha256"`
	InputMetadataVersion    int64  `json:"input_metadata_version"`
	OutputMetadataVersion   int64  `json:"output_metadata_version"`
	PreviousMetadataPath    string `json:"previous_metadata_path"`
	PreviousMetadataSHA256  string `json:"previous_metadata_sha256"`
	PreviousRootPath        string `json:"previous_root_path"`
	PreviousRootSHA256      string `json:"previous_root_sha256"`
	AWSRegion               string `json:"aws_region"`
	AWSAccountID            string `json:"aws_account_id"`
	KMSKeyARN               string `json:"kms_key_arn"`
	KMSPublicKeyDERChecksum string `json:"kms_public_key_der_sha256"`
}

type ValidatedOnlineSigningPlan struct {
	Plan      OnlineSigningPlan
	CreatedAt time.Time
	Expires   time.Time
}

func LoadOnlineSigningPlan(filePath, requiredRole string) (ValidatedOnlineSigningPlan, error) {
	data, err := readRegularFile(filePath, MaxOnlineSigningPlanBytes)
	if err != nil {
		return ValidatedOnlineSigningPlan{}, fmt.Errorf("read online signing plan: %w", err)
	}
	var raw any
	if err := strictjson.Decode(data, &raw); err != nil {
		return ValidatedOnlineSigningPlan{}, fmt.Errorf("decode online signing plan shape: %w", err)
	}
	if _, err := exactObject(raw, "online signing plan",
		"aws_account_id", "aws_region", "created_at", "environment", "expires", "input_metadata_path",
		"input_metadata_sha256", "input_metadata_version", "kms_key_arn", "kms_public_key_der_sha256",
		"output_metadata_version", "previous_metadata_path", "previous_metadata_sha256", "release_id",
		"previous_root_path", "previous_root_sha256", "repository_id", "role", "root_path", "root_sha256",
		"root_version", "schema_version"); err != nil {
		return ValidatedOnlineSigningPlan{}, err
	}
	var plan OnlineSigningPlan
	if err := strictjson.Decode(data, &plan); err != nil {
		return ValidatedOnlineSigningPlan{}, fmt.Errorf("decode online signing plan: %w", err)
	}
	return ValidateOnlineSigningPlan(plan, requiredRole)
}

func ValidateOnlineSigningPlan(plan OnlineSigningPlan, requiredRole string) (ValidatedOnlineSigningPlan, error) {
	if requiredRole != "snapshot" && requiredRole != "timestamp" {
		return ValidatedOnlineSigningPlan{}, errors.New("required online signing role must be snapshot or timestamp")
	}
	if plan.SchemaVersion != SchemaVersion || plan.Role != requiredRole {
		return ValidatedOnlineSigningPlan{}, fmt.Errorf("online signing plan is not schema %s role %s", SchemaVersion, requiredRole)
	}
	createdAt, err := parseWholeSecondUTC(plan.CreatedAt, "online signing plan created_at")
	if err != nil {
		return ValidatedOnlineSigningPlan{}, err
	}
	expires, err := parseWholeSecondUTC(plan.Expires, "online signing plan expires")
	if err != nil {
		return ValidatedOnlineSigningPlan{}, err
	}
	if err := validateOnlineContext(plan.Environment, plan.RepositoryID, plan.ReleaseID, plan.RootVersion, plan.OutputMetadataVersion, createdAt); err != nil {
		return ValidatedOnlineSigningPlan{}, err
	}
	if err := validateOnlineMetadataVersion(plan.InputMetadataVersion, "online signing input metadata"); err != nil {
		return ValidatedOnlineSigningPlan{}, err
	}
	if !sha256Pattern.MatchString(plan.RootSHA256) || !sha256Pattern.MatchString(plan.InputMetadataSHA256) ||
		!sha256Pattern.MatchString(plan.KMSPublicKeyDERChecksum) {
		return ValidatedOnlineSigningPlan{}, errors.New("online signing plan versions or SHA-256 pins are invalid")
	}
	if err := validateAbsoluteInput(plan.RootPath, "online signing root"); err != nil {
		return ValidatedOnlineSigningPlan{}, err
	}
	if err := validateAbsoluteInput(plan.InputMetadataPath, "online signing input metadata"); err != nil {
		return ValidatedOnlineSigningPlan{}, err
	}
	if plan.RootPath == plan.InputMetadataPath {
		return ValidatedOnlineSigningPlan{}, errors.New("online signing root and input metadata paths must differ")
	}
	if plan.OutputMetadataVersion == 1 {
		if plan.InputMetadataVersion != 1 {
			return ValidatedOnlineSigningPlan{}, errors.New("genesis online signing plan must select input metadata version 1")
		}
		if plan.PreviousMetadataPath != "" || plan.PreviousMetadataSHA256 != "" ||
			plan.PreviousRootPath != "" || plan.PreviousRootSHA256 != "" {
			return ValidatedOnlineSigningPlan{}, errors.New("genesis online signing plan must not select previous metadata or root")
		}
	} else {
		if err := validateAbsoluteInput(plan.PreviousMetadataPath, "previous online metadata"); err != nil {
			return ValidatedOnlineSigningPlan{}, err
		}
		if !sha256Pattern.MatchString(plan.PreviousMetadataSHA256) {
			return ValidatedOnlineSigningPlan{}, errors.New("non-genesis online signing plan requires a lowercase previous metadata SHA-256")
		}
		if plan.PreviousMetadataPath == plan.RootPath || plan.PreviousMetadataPath == plan.InputMetadataPath {
			return ValidatedOnlineSigningPlan{}, errors.New("online signing root, input, and previous metadata paths must differ")
		}
		if err := validateAbsoluteInput(plan.PreviousRootPath, "previous online root"); err != nil {
			return ValidatedOnlineSigningPlan{}, err
		}
		if !sha256Pattern.MatchString(plan.PreviousRootSHA256) {
			return ValidatedOnlineSigningPlan{}, errors.New("non-genesis online signing plan requires a lowercase previous root SHA-256")
		}
		if plan.PreviousRootPath == plan.InputMetadataPath || plan.PreviousRootPath == plan.PreviousMetadataPath {
			return ValidatedOnlineSigningPlan{}, errors.New("previous online root path must differ from the input and previous role metadata paths")
		}
		if plan.PreviousRootPath == plan.RootPath && plan.PreviousRootSHA256 != plan.RootSHA256 {
			return ValidatedOnlineSigningPlan{}, errors.New("one root path cannot select different current and previous root hashes")
		}
	}
	if !awsRegionPattern.MatchString(plan.AWSRegion) || !awsAccountPattern.MatchString(plan.AWSAccountID) {
		return ValidatedOnlineSigningPlan{}, errors.New("online signing AWS region or account ID is invalid")
	}
	arn := strings.Split(plan.KMSKeyARN, ":")
	if len(arn) != 6 || arn[0] != "arn" || arn[2] != "kms" || arn[3] != plan.AWSRegion ||
		arn[4] != plan.AWSAccountID || !kmsResourcePattern.MatchString(arn[5]) {
		return ValidatedOnlineSigningPlan{}, errors.New("online signing KMS key ARN does not match its exact region/account or immutable-key shape")
	}
	if arn[1] != "aws" && arn[1] != "aws-us-gov" && arn[1] != "aws-cn" && arn[1] != "aws-iso" && arn[1] != "aws-iso-b" {
		return ValidatedOnlineSigningPlan{}, errors.New("online signing KMS key ARN partition is invalid")
	}
	lifetime := expires.Sub(createdAt)
	if requiredRole == "snapshot" && (lifetime < 72*time.Hour || lifetime > 7*24*time.Hour) {
		return ValidatedOnlineSigningPlan{}, errors.New("snapshot signing plan lifetime must be from 72 hours through 7 days")
	}
	if requiredRole == "timestamp" && (lifetime < 6*time.Hour || lifetime > 24*time.Hour) {
		return ValidatedOnlineSigningPlan{}, errors.New("timestamp signing plan lifetime must be from 6 through 24 hours")
	}
	return ValidatedOnlineSigningPlan{Plan: plan, CreatedAt: createdAt, Expires: expires}, nil
}

// ValidateOnlineSigningPlanAt adds the invocation-time wall-clock gate without
// making plan loading depend on the local clock. Callers must perform this
// check immediately before initializing any remote signer dependencies.
func ValidateOnlineSigningPlanAt(plan OnlineSigningPlan, requiredRole string, now time.Time) (ValidatedOnlineSigningPlan, error) {
	validated, err := ValidateOnlineSigningPlan(plan, requiredRole)
	if err != nil {
		return ValidatedOnlineSigningPlan{}, err
	}
	if now.IsZero() {
		return ValidatedOnlineSigningPlan{}, errors.New("online signing wall clock is required")
	}
	if validated.CreatedAt.Before(now.Add(-5 * time.Minute)) {
		return ValidatedOnlineSigningPlan{}, errors.New("online signing plan created_at is more than 5 minutes old")
	}
	if validated.CreatedAt.After(now.Add(time.Minute)) {
		return ValidatedOnlineSigningPlan{}, errors.New("online signing plan created_at is more than 1 minute in the future")
	}
	return validated, nil
}

func validateAbsoluteInput(filePath, label string) error {
	// Existence is checked by the role-specific bounded read immediately before
	// signing. This validation binds only the immutable plan representation.
	if filePath == "" || strings.ContainsRune(filePath, 0) || !filepath.IsAbs(filePath) || filepath.Clean(filePath) != filePath {
		return fmt.Errorf("%s path must be canonical and absolute", label)
	}
	return nil
}
