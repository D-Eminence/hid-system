package signingbroker

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/repository"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/strictjson"
)

const maxSafeInteger int64 = 1<<53 - 1

// publicationSafetyMargin reserves enough time for the signed output to be
// durably committed, uploaded, preview-verified, and observed by multiple
// five-minute checkpoint intervals before it reaches the hard publication
// freshness floor. The fixed signing Lambda itself has a 30-second timeout.
const publicationSafetyMargin = 30 * time.Minute

var (
	identifierPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`)
	bucketPattern     = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
	releaseIDPattern  = regexp.MustCompile(`^r[0-9]{10}-g[0-9a-f]{40}$`)
	sha256Pattern     = regexp.MustCompile(`^[0-9a-f]{64}$`)
	kmsARNPattern     = regexp.MustCompile(`^arn:(aws|aws-us-gov|aws-cn|aws-iso|aws-iso-b):kms:([a-z0-9][a-z0-9-]{2,31}):([0-9]{12}):key/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$`)
	versionIDPattern  = regexp.MustCompile(`^[!-~]+$`)
)

type validatedRequest struct {
	value       Request
	createdAt   time.Time
	expires     time.Time
	requestHash string
}

func DecodeRequest(data []byte) (Request, error) {
	if len(data) == 0 || len(data) > MaxRequestBytes {
		return Request{}, fmt.Errorf("signing-broker request size is outside 1..%d", MaxRequestBytes)
	}
	var request Request
	if err := strictjson.Decode(data, &request); err != nil {
		return Request{}, fmt.Errorf("decode strict signing-broker request: %w", err)
	}
	return request, nil
}

func validateConfig(config Config) error {
	if err := validateTrustConfig(config.trustConfig()); err != nil {
		return err
	}
	if config.Role != "snapshot" && config.Role != "timestamp" {
		return errors.New("signing-broker role must be snapshot or timestamp")
	}
	if config.CandidateID != "one" && config.CandidateID != "two" {
		return errors.New("signing-broker candidate ID must be one or two")
	}
	if !kmsARNPattern.MatchString(config.KMSKeyARN) {
		return errors.New("signing-broker KMS key ARN must identify one immutable key")
	}
	if !sha256Pattern.MatchString(config.KMSPublicKeyDERChecksum) {
		return errors.New("signing-broker public-key pin must be lowercase SHA-256")
	}
	if !bucketPattern.MatchString(config.RequestBucketName) || strings.Contains(config.RequestBucketName, "..") {
		return errors.New("signing-broker request bucket name is invalid")
	}
	expectedPrefix := fmt.Sprintf(
		"tuf-signing-broker/requests/%s/%s-%s/",
		config.StateID,
		config.Role,
		config.CandidateID,
	)
	if config.RequestObjectPrefix != expectedPrefix {
		return errors.New("signing-broker request prefix is not its fixed candidate namespace")
	}
	return nil
}

func validatePublicationConfig(config PublicationConfig) error {
	return validateTrustConfig(config.trustConfig())
}

func validateTrustConfig(config fixedTrustConfig) error {
	if config.environment != "staging" && config.environment != "production" {
		return errors.New("signing-broker environment must be staging or production")
	}
	expectedRepository := "hid-" + config.environment + "-v1"
	if config.repositoryID != expectedRepository {
		return errors.New("signing-broker repository ID does not match its environment")
	}
	expectedStateID := "hid-" + config.environment + "-broker-v1"
	if !identifierPattern.MatchString(config.stateID) || config.stateID != expectedStateID {
		return errors.New("signing-broker state ID must equal the governed environment state ID")
	}
	if !sha256Pattern.MatchString(config.bootstrapRootSHA256) {
		return errors.New("signing-broker bootstrap-root pin must be lowercase SHA-256")
	}
	return nil
}

func (config Config) trustConfig() fixedTrustConfig {
	return fixedTrustConfig{
		environment: config.Environment, repositoryID: config.RepositoryID,
		stateID: config.StateID, bootstrapRootSHA256: config.BootstrapRootSHA256,
	}
}

func (config PublicationConfig) trustConfig() fixedTrustConfig {
	return fixedTrustConfig{
		environment: config.Environment, repositoryID: config.RepositoryID,
		stateID: config.StateID, bootstrapRootSHA256: config.BootstrapRootSHA256,
	}
}

func validateRequest(request Request, config Config, now time.Time) (validatedRequest, error) {
	validated, err := validateRequestEnvelope(request, config)
	if err != nil {
		return validatedRequest{}, err
	}
	if err := validateRequestClock(validated, now); err != nil {
		return validatedRequest{}, err
	}
	return validated, nil
}

func validateRequestEnvelope(request Request, config Config) (validatedRequest, error) {
	if request.SchemaVersion != SchemaVersion || request.Environment != config.Environment ||
		request.RepositoryID != config.RepositoryID || request.Role != config.Role {
		return validatedRequest{}, errors.New("signing-broker request context does not match fixed configuration")
	}
	if !releaseIDPattern.MatchString(request.ReleaseID) {
		return validatedRequest{}, errors.New("signing-broker request release ID is invalid")
	}
	createdAt, err := parseWholeSecondUTC(request.CreatedAt, "signing-broker request created_at")
	if err != nil {
		return validatedRequest{}, err
	}
	expires, err := parseWholeSecondUTC(request.Expires, "signing-broker request expires")
	if err != nil {
		return validatedRequest{}, err
	}
	lifetime := expires.Sub(createdAt)
	if request.Role == "snapshot" && (lifetime < 72*time.Hour || lifetime > 7*24*time.Hour) {
		return validatedRequest{}, errors.New("snapshot request lifetime must be from 72 hours through 7 days")
	}
	if request.Role == "timestamp" && (lifetime < 6*time.Hour || lifetime > 24*time.Hour) {
		return validatedRequest{}, errors.New("timestamp request lifetime must be from 6 through 24 hours")
	}
	if request.RootVersion < 1 || request.RootVersion > maxSafeInteger ||
		request.InputMetadataVersion < 1 || request.InputMetadataVersion > maxSafeInteger {
		return validatedRequest{}, errors.New("signing-broker request versions must be positive JSON-safe integers")
	}
	if !sha256Pattern.MatchString(request.RootSHA256) || digestHex(request.RootBytes) != request.RootSHA256 {
		return validatedRequest{}, errors.New("signing-broker request root hash does not match its bytes")
	}
	if !sha256Pattern.MatchString(request.InputMetadataSHA256) || digestHex(request.InputMetadataBytes) != request.InputMetadataSHA256 {
		return validatedRequest{}, errors.New("signing-broker request input hash does not match its bytes")
	}
	if len(request.RootBytes) == 0 || len(request.RootBytes) > repository.MaxRootMetadataBytes {
		return validatedRequest{}, errors.New("signing-broker request root size is outside policy")
	}
	maximumInput := repository.MaxSnapshotMetadataBytes
	if request.Role == "snapshot" {
		maximumInput = repository.MaxTargetsMetadataBytes
	}
	if len(request.InputMetadataBytes) == 0 || len(request.InputMetadataBytes) > maximumInput {
		return validatedRequest{}, errors.New("signing-broker request input metadata size is outside policy")
	}
	canonical, err := json.Marshal(request)
	if err != nil {
		return validatedRequest{}, fmt.Errorf("canonicalize signing-broker request: %w", err)
	}
	return validatedRequest{value: cloneRequest(request), createdAt: createdAt, expires: expires, requestHash: digestHex(canonical)}, nil
}

func validateRequestClock(request validatedRequest, now time.Time) error {
	if now.IsZero() {
		return errors.New("signing-broker wall clock is required")
	}
	now = now.UTC()
	if request.createdAt.Before(now.Add(-5 * time.Minute)) {
		return errors.New("signing-broker request is more than 5 minutes old")
	}
	if request.createdAt.After(now.Add(time.Minute)) {
		return errors.New("signing-broker request is more than 1 minute in the future")
	}
	minimumFreshness := 72 * time.Hour
	if request.value.Role == "timestamp" {
		minimumFreshness = 6 * time.Hour
	}
	if request.expires.Sub(now) < minimumFreshness+publicationSafetyMargin {
		return fmt.Errorf(
			"%s signing-broker request leaves less than %s of publication freshness including the operational safety margin",
			request.value.Role,
			minimumFreshness+publicationSafetyMargin,
		)
	}
	return nil
}

func validateImmutableRequestObject(object ImmutableRequestObject, config Config, requestHash string) error {
	if object.Bucket != config.RequestBucketName {
		return errors.New("immutable signing request object does not use the fixed bucket")
	}
	return validateImmutableRequestObjectIdentity(
		object,
		config.RequestObjectPrefix,
		requestHash,
	)
}

func validateImmutableRequestObjectIdentity(object ImmutableRequestObject, prefix, requestHash string) error {
	if !bucketPattern.MatchString(object.Bucket) || strings.Contains(object.Bucket, "..") ||
		object.SHA256 != requestHash || !strings.HasPrefix(object.Key, prefix) ||
		!validImmutableObjectKey(object.Key) || !strings.HasSuffix(object.Key, ".json") ||
		!validImmutableVersionID(object.VersionID) {
		return errors.New("immutable signing request object does not match its fixed versioned source")
	}
	remainder := strings.TrimPrefix(object.Key, prefix)
	if remainder == "" || strings.Contains(remainder, "/") {
		return errors.New("immutable signing request object is not one file in its fixed candidate namespace")
	}
	return nil
}

func sameImmutableRequestObject(left, right *ImmutableRequestObject) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func cloneImmutableRequestObject(object *ImmutableRequestObject) *ImmutableRequestObject {
	if object == nil {
		return nil
	}
	cloned := *object
	return &cloned
}

func validImmutableObjectKey(key string) bool {
	if len(key) < 1 || len(key) > 1024 || strings.HasPrefix(key, "/") || strings.HasSuffix(key, "/") ||
		strings.ContainsAny(key, "\x00\r\n\\") || strings.Contains(key, "//") {
		return false
	}
	for _, segment := range strings.Split(key, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

func validImmutableVersionID(value string) bool {
	return len(value) >= 1 && len(value) <= 1024 && value != "null" &&
		versionIDPattern.MatchString(value) && !strings.ContainsAny(value, "\\\"")
}

func parseWholeSecondUTC(value, label string) (time.Time, error) {
	parsed, err := time.Parse("2006-01-02T15:04:05Z", value)
	if err != nil || parsed.Format("2006-01-02T15:04:05Z") != value {
		return time.Time{}, fmt.Errorf("%s must be a real whole-second UTC timestamp", label)
	}
	return parsed, nil
}

func digestHex(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func cloneRequest(request Request) Request {
	result := request
	result.RootBytes = bytes.Clone(request.RootBytes)
	result.InputMetadataBytes = bytes.Clone(request.InputMetadataBytes)
	return result
}

func kmsIdentity(keyARN string) (string, string, error) {
	match := kmsARNPattern.FindStringSubmatch(keyARN)
	if match == nil {
		return "", "", errors.New("invalid fixed KMS key ARN")
	}
	return match[2], match[3], nil
}
