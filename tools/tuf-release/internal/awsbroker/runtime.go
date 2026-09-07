package awsbroker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/kmssigner"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/signingbroker"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/strictjson"
	"github.com/sigstore/sigstore/pkg/signature"
)

const RuntimeConfigSchema = "hid.tuf.signing-broker.config/v1"

const (
	StateRetentionDays    = 730
	requestRetentionGrace = 10 * time.Minute
)

var (
	regionPattern       = regexp.MustCompile(`^[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]?$`)
	checkpointIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
)

type EnvironmentLookup func(string) (string, bool)

type RuntimeConfig struct {
	Operation                    string
	Environment                  string
	RepositoryID                 string
	StateID                      string
	BootstrapRootSHA256          string
	StateTableName               string
	StateBucketName              string
	StateObjectPrefix            string
	StorageEncryptionKeyARN      string
	ObjectLockMode               string
	StateRetentionDays           int
	EvidenceRetentionDays        int
	ExpectedAWSAccountID         string
	ExpectedAWSRegion            string
	Role                         string
	CandidateID                  string
	SigningKMSKeyARN             string
	SigningKMSPublicKeySHA256    string
	RequestBucketName            string
	RequestObjectPrefix          string
	PublicRepositoryURL          string
	BootstrapRootBucketName      string
	BootstrapRootObjectKey       string
	BootstrapRootObjectVersionID string
	CheckpointRuleARN            string
}

func LoadRuntimeConfig(lookup EnvironmentLookup) (RuntimeConfig, error) {
	if lookup == nil {
		return RuntimeConfig{}, errors.New("runtime environment lookup is required")
	}
	require := func(name string) (string, error) {
		value, ok := lookup(name)
		if !ok || value == "" || value != strings.TrimSpace(value) || strings.ContainsRune(value, 0) {
			return "", fmt.Errorf("required runtime setting %s is missing or invalid", name)
		}
		return value, nil
	}
	schema, err := require("HID_BROKER_CONFIG_SCHEMA")
	if err != nil || schema != RuntimeConfigSchema {
		return RuntimeConfig{}, errors.New("runtime configuration schema is invalid")
	}
	names := []string{
		"HID_BROKER_OPERATION", "HID_BROKER_ENVIRONMENT", "HID_REPOSITORY_ID", "HID_STATE_ID",
		"HID_BOOTSTRAP_ROOT_SHA256", "HID_STATE_TABLE_NAME", "HID_STATE_BUCKET_NAME",
		"HID_STATE_OBJECT_PREFIX", "HID_STORAGE_KMS_KEY_ARN", "HID_OBJECT_LOCK_MODE",
		"HID_STATE_RETENTION_DAYS", "HID_EVIDENCE_RETENTION_DAYS",
		"HID_EXPECTED_AWS_ACCOUNT_ID", "HID_EXPECTED_AWS_REGION",
	}
	values := make(map[string]string, len(names))
	for _, name := range names {
		values[name], err = require(name)
		if err != nil {
			return RuntimeConfig{}, err
		}
	}
	parseDays := func(name string) (int, error) {
		days, parseErr := strconv.Atoi(values[name])
		if parseErr != nil || days < 1 || strconv.Itoa(days) != values[name] {
			return 0, fmt.Errorf("%s must be a canonical positive integer", name)
		}
		return days, nil
	}
	stateRetentionDays, err := parseDays("HID_STATE_RETENTION_DAYS")
	if err != nil {
		return RuntimeConfig{}, err
	}
	evidenceRetentionDays, err := parseDays("HID_EVIDENCE_RETENTION_DAYS")
	if err != nil {
		return RuntimeConfig{}, err
	}
	config := RuntimeConfig{
		Operation: values["HID_BROKER_OPERATION"], Environment: values["HID_BROKER_ENVIRONMENT"],
		RepositoryID: values["HID_REPOSITORY_ID"], StateID: values["HID_STATE_ID"],
		BootstrapRootSHA256: values["HID_BOOTSTRAP_ROOT_SHA256"], StateTableName: values["HID_STATE_TABLE_NAME"],
		StateBucketName: values["HID_STATE_BUCKET_NAME"], StateObjectPrefix: values["HID_STATE_OBJECT_PREFIX"],
		StorageEncryptionKeyARN: values["HID_STORAGE_KMS_KEY_ARN"], ObjectLockMode: values["HID_OBJECT_LOCK_MODE"],
		StateRetentionDays: stateRetentionDays, EvidenceRetentionDays: evidenceRetentionDays,
		ExpectedAWSAccountID: values["HID_EXPECTED_AWS_ACCOUNT_ID"],
		ExpectedAWSRegion:    values["HID_EXPECTED_AWS_REGION"],
	}
	if config.StateID != "hid-"+config.Environment+"-broker-v1" {
		return RuntimeConfig{}, errors.New("runtime state ID differs from the governed environment state ID")
	}
	minimumEvidenceDays := 90
	if config.Environment == "production" {
		minimumEvidenceDays = 180
	}
	if config.StateRetentionDays != StateRetentionDays || config.EvidenceRetentionDays < minimumEvidenceDays ||
		config.EvidenceRetentionDays > StateRetentionDays {
		return RuntimeConfig{}, errors.New("runtime state or evidence retention differs from the fixed policy")
	}
	if !regionPattern.MatchString(config.ExpectedAWSRegion) ||
		!strings.Contains(config.StorageEncryptionKeyARN, ":"+config.ExpectedAWSRegion+":"+config.ExpectedAWSAccountID+":key/") {
		return RuntimeConfig{}, errors.New("runtime AWS region/account pins do not match the storage key")
	}
	switch config.Operation {
	case "sign":
		signNames := []string{
			"HID_ROLE", "HID_CANDIDATE", "HID_KMS_KEY_ARN", "HID_KMS_PUBLIC_KEY_SPKI_SHA256",
			"HID_REQUEST_BUCKET_NAME", "HID_REQUEST_OBJECT_PREFIX", "HID_MAX_PLAN_AGE_SECONDS",
			"HID_MAX_CLOCK_SKEW_SECONDS", "HID_REQUIRE_OBJECT_LOCK_RETENTION",
		}
		for _, name := range signNames {
			values[name], err = require(name)
			if err != nil {
				return RuntimeConfig{}, err
			}
		}
		if values["HID_MAX_PLAN_AGE_SECONDS"] != "300" || values["HID_MAX_CLOCK_SKEW_SECONDS"] != "60" ||
			values["HID_REQUIRE_OBJECT_LOCK_RETENTION"] != "true" {
			return RuntimeConfig{}, errors.New("signing runtime policy constants differ from the broker contract")
		}
		config.Role = values["HID_ROLE"]
		config.CandidateID = values["HID_CANDIDATE"]
		config.SigningKMSKeyARN = values["HID_KMS_KEY_ARN"]
		config.SigningKMSPublicKeySHA256 = values["HID_KMS_PUBLIC_KEY_SPKI_SHA256"]
		config.RequestBucketName = values["HID_REQUEST_BUCKET_NAME"]
		config.RequestObjectPrefix = values["HID_REQUEST_OBJECT_PREFIX"]
		if config.RequestBucketName != config.StateBucketName ||
			!strings.Contains(config.SigningKMSKeyARN, ":"+config.ExpectedAWSRegion+":"+config.ExpectedAWSAccountID+":key/") {
			return RuntimeConfig{}, errors.New("signing runtime storage or KMS identity differs from fixed AWS context")
		}
	case "checkpoint":
		checkpointNames := []string{
			"HID_PUBLIC_REPOSITORY_URL", "HID_BOOTSTRAP_ROOT_BUCKET_NAME", "HID_BOOTSTRAP_ROOT_OBJECT_KEY",
			"HID_BOOTSTRAP_ROOT_OBJECT_VERSION_ID", "HID_CHECKPOINT_RULE_ARN",
		}
		for _, name := range checkpointNames {
			values[name], err = require(name)
			if err != nil {
				return RuntimeConfig{}, err
			}
		}
		config.PublicRepositoryURL = values["HID_PUBLIC_REPOSITORY_URL"]
		config.BootstrapRootBucketName = values["HID_BOOTSTRAP_ROOT_BUCKET_NAME"]
		config.BootstrapRootObjectKey = values["HID_BOOTSTRAP_ROOT_OBJECT_KEY"]
		config.BootstrapRootObjectVersionID = values["HID_BOOTSTRAP_ROOT_OBJECT_VERSION_ID"]
		config.CheckpointRuleARN = values["HID_CHECKPOINT_RULE_ARN"]
		arnParts := strings.SplitN(config.StorageEncryptionKeyARN, ":", 6)
		expectedRuleARN := ""
		if len(arnParts) == 6 {
			expectedRuleARN = fmt.Sprintf("arn:%s:events:%s:%s:rule/hid-%s-tuf-broker-checkpoint", arnParts[1], config.ExpectedAWSRegion, config.ExpectedAWSAccountID, config.Environment)
		}
		if config.BootstrapRootBucketName != config.StateBucketName || config.CheckpointRuleARN != expectedRuleARN {
			return RuntimeConfig{}, errors.New("checkpoint bootstrap bucket or schedule-rule ARN differs from fixed configuration")
		}
	default:
		return RuntimeConfig{}, errors.New("runtime operation must be sign or checkpoint")
	}
	return config, nil
}

type RuntimeClients struct {
	S3            S3Client
	DynamoDB      DynamoDBClient
	KMS           kmssigner.Client
	HTTPTransport http.RoundTripper
}

type Runtime struct {
	operation  string
	sign       *SignHandler
	checkpoint *ScheduledCheckpointHandler
}

func NewRuntime(config RuntimeConfig, clients RuntimeClients, clock func() time.Time) (*Runtime, error) {
	stateStore, err := NewStateStore(StateStoreConfig{
		Environment: config.Environment, RepositoryID: config.RepositoryID, StateID: config.StateID,
		BootstrapRootSHA256: config.BootstrapRootSHA256, TableName: config.StateTableName,
		BucketName: config.StateBucketName, StateObjectPrefix: config.StateObjectPrefix,
		ExpectedBucketOwner: config.ExpectedAWSAccountID, EncryptionKeyARN: config.StorageEncryptionKeyARN,
		ObjectLockMode: config.ObjectLockMode, RetentionDays: config.StateRetentionDays, Clock: clock,
	}, clients.S3, clients.DynamoDB)
	if err != nil {
		return nil, err
	}
	minimumRemainingRetention := time.Duration(0)
	if config.Operation == "sign" {
		minimumRemainingRetention = time.Duration(config.EvidenceRetentionDays)*24*time.Hour - requestRetentionGrace
	}
	objectReader, err := NewImmutableObjectReader(ImmutableObjectReaderConfig{
		BucketName: config.StateBucketName, ExpectedBucketOwner: config.ExpectedAWSAccountID,
		EncryptionKeyARN: config.StorageEncryptionKeyARN, ObjectLockMode: config.ObjectLockMode,
		MinimumRemainingRetention: minimumRemainingRetention, Clock: clock,
	}, clients.S3)
	if err != nil {
		return nil, err
	}
	runtime := &Runtime{operation: config.Operation}
	switch config.Operation {
	case "sign":
		if isNil(clients.KMS) {
			return nil, errors.New("signing runtime KMS client is required")
		}
		loader, err := NewRequestLoader(RequestLoaderConfig{
			StateID: config.StateID, Role: config.Role, CandidateID: config.CandidateID,
			BucketName: config.RequestBucketName, ObjectPrefix: config.RequestObjectPrefix,
		}, objectReader)
		if err != nil {
			return nil, err
		}
		broker, err := signingbroker.New(signingbroker.Config{
			Environment: config.Environment, RepositoryID: config.RepositoryID, StateID: config.StateID,
			Role: config.Role, CandidateID: config.CandidateID, KMSKeyARN: config.SigningKMSKeyARN,
			KMSPublicKeyDERChecksum: config.SigningKMSPublicKeySHA256,
			BootstrapRootSHA256:     config.BootstrapRootSHA256,
			RequestBucketName:       config.RequestBucketName,
			RequestObjectPrefix:     config.RequestObjectPrefix,
		}, stateStore, &kmsSignerFactory{client: clients.KMS}, clock)
		if err != nil {
			return nil, err
		}
		runtime.sign = &SignHandler{loader: loader, broker: broker}
	case "checkpoint":
		controller, err := signingbroker.NewPublicationController(signingbroker.PublicationConfig{
			Environment: config.Environment, RepositoryID: config.RepositoryID, StateID: config.StateID,
			BootstrapRootSHA256: config.BootstrapRootSHA256,
		}, stateStore, clock)
		if err != nil {
			return nil, err
		}
		publicRepository, err := NewPublicRepository(PublicRepositoryConfig{
			Environment: config.Environment, BaseURL: config.PublicRepositoryURL,
		}, clients.HTTPTransport)
		if err != nil {
			return nil, err
		}
		runner, err := NewCheckpointRunner(CheckpointRunnerConfig{
			Environment: config.Environment, StateID: config.StateID,
			BootstrapRootSHA256:          config.BootstrapRootSHA256,
			BootstrapRootObjectKey:       config.BootstrapRootObjectKey,
			BootstrapRootObjectVersionID: config.BootstrapRootObjectVersionID,
		}, controller, publicRepository, objectReader)
		if err != nil {
			return nil, err
		}
		runtime.checkpoint = &ScheduledCheckpointHandler{
			runner: runner, accountID: config.ExpectedAWSAccountID, region: config.ExpectedAWSRegion,
			ruleARN: config.CheckpointRuleARN, clock: clock,
		}
	default:
		return nil, errors.New("unsupported broker runtime operation")
	}
	return runtime, nil
}

func (runtime *Runtime) Invoke(ctx context.Context, event json.RawMessage) (any, error) {
	if runtime == nil {
		return nil, errors.New("broker runtime is nil")
	}
	if runtime.operation == "sign" {
		return runtime.sign.Invoke(ctx, event)
	}
	if runtime.operation == "checkpoint" {
		return runtime.checkpoint.Invoke(ctx, event)
	}
	return nil, errors.New("broker runtime operation is invalid")
}

type SignHandler struct {
	loader *RequestLoader
	broker *signingbroker.Broker
}

func (handler *SignHandler) Invoke(ctx context.Context, event json.RawMessage) (signingbroker.Result, error) {
	if handler == nil || handler.loader == nil || handler.broker == nil || isNil(ctx) {
		return signingbroker.Result{}, errors.New("signing handler is uninitialized")
	}
	request, err := handler.loader.Load(ctx, event)
	if err != nil {
		return signingbroker.Result{}, err
	}
	return handler.broker.SignImmutableRequest(
		ctx,
		request.Bytes,
		request.RequestObject,
		request.MinimumRetentionSatisfied,
	)
}

type scheduledEvent struct {
	Version    string          `json:"version"`
	ID         string          `json:"id"`
	DetailType string          `json:"detail-type"`
	Source     string          `json:"source"`
	Account    string          `json:"account"`
	Time       string          `json:"time"`
	Region     string          `json:"region"`
	Resources  []string        `json:"resources"`
	Detail     json.RawMessage `json:"detail"`
}

type ScheduledCheckpointHandler struct {
	runner    *CheckpointRunner
	accountID string
	region    string
	ruleARN   string
	clock     func() time.Time
}

func (handler *ScheduledCheckpointHandler) Invoke(ctx context.Context, event json.RawMessage) (CheckpointResult, error) {
	if handler == nil || handler.runner == nil || handler.clock == nil || isNil(ctx) || len(event) == 0 || len(event) > 64_000 {
		return CheckpointResult{}, errors.New("scheduled checkpoint handler is uninitialized or event is invalid")
	}
	var decoded scheduledEvent
	if err := strictjson.Decode(event, &decoded); err != nil {
		return CheckpointResult{}, fmt.Errorf("decode strict checkpoint schedule event: %w", err)
	}
	eventTime, err := time.Parse(time.RFC3339, decoded.Time)
	if err != nil || eventTime.IsZero() || eventTime.Nanosecond() != 0 || decoded.Time != eventTime.UTC().Format(time.RFC3339) {
		return CheckpointResult{}, errors.New("checkpoint schedule event time is invalid")
	}
	now := handler.clock().UTC()
	if decoded.Version != "0" || !checkpointIDPattern.MatchString(decoded.ID) ||
		decoded.DetailType != "Scheduled Event" || decoded.Source != "aws.events" ||
		decoded.Account != handler.accountID || decoded.Region != handler.region ||
		len(decoded.Resources) != 1 || decoded.Resources[0] != handler.ruleARN ||
		string(decoded.Detail) != "{}" || eventTime.Before(now.Add(-10*time.Minute)) || eventTime.After(now.Add(time.Minute)) {
		return CheckpointResult{}, errors.New("checkpoint schedule event does not match its fixed rule or clock window")
	}
	return handler.runner.Check(ctx)
}

type kmsSignerFactory struct {
	client kmssigner.Client
}

func (factory *kmsSignerFactory) NewSigner(ctx context.Context, config signingbroker.SignerConfig) (signature.Signer, error) {
	if factory == nil || isNil(factory.client) {
		return nil, errors.New("KMS signer factory is uninitialized")
	}
	return kmssigner.New(ctx, factory.client, kmssigner.Config{
		KeyARN: config.KeyARN, PublicKeyDERChecksum: config.PublicKeyDERChecksum,
	})
}

var _ signingbroker.SignerFactory = (*kmsSignerFactory)(nil)
