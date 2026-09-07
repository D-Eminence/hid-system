package awsbroker

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/signingbroker"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/strictjson"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// PublicationReaderConfig is independently pinned by the protected publisher;
// it must never be derived from the candidate repository or upload receipt.
type PublicationReaderConfig struct {
	SchemaVersion        string `json:"schema_version"`
	Environment          string `json:"environment"`
	RepositoryID         string `json:"repository_id"`
	StateID              string `json:"state_id"`
	BootstrapRootSHA256  string `json:"bootstrap_root_sha256"`
	TableName            string `json:"table_name"`
	BucketName           string `json:"bucket_name"`
	StateObjectPrefix    string `json:"state_object_prefix"`
	ExpectedAWSAccountID string `json:"expected_aws_account_id"`
	ExpectedAWSRegion    string `json:"expected_aws_region"`
	EncryptionKeyARN     string `json:"encryption_key_arn"`
	ObjectLockMode       string `json:"object_lock_mode"`
}

func DecodePublicationReaderConfig(data []byte) (PublicationReaderConfig, error) {
	var config PublicationReaderConfig
	if len(data) == 0 || len(data) > 64_000 {
		return config, errors.New("publication reader configuration exceeds its size policy")
	}
	if err := strictjson.Decode(data, &config); err != nil {
		return config, err
	}
	return config, validatePublicationReaderConfig(config, time.Now)
}

func validatePublicationReaderConfig(config PublicationReaderConfig, clock func() time.Time) error {
	if config.SchemaVersion != "hid.tuf.publication-reader/v1" || !regionPattern.MatchString(config.ExpectedAWSRegion) ||
		!strings.Contains(config.EncryptionKeyARN, ":"+config.ExpectedAWSRegion+":"+config.ExpectedAWSAccountID+":key/") ||
		config.Environment == "production" && config.ObjectLockMode != "COMPLIANCE" {
		return errors.New("publication reader schema, AWS context or production retention is invalid")
	}
	return validateStateStoreConfig(config.stateConfig(clock))
}

func (config PublicationReaderConfig) stateConfig(clock func() time.Time) StateStoreConfig {
	return StateStoreConfig{
		Environment: config.Environment, RepositoryID: config.RepositoryID, StateID: config.StateID,
		BootstrapRootSHA256: config.BootstrapRootSHA256, TableName: config.TableName, BucketName: config.BucketName,
		StateObjectPrefix: config.StateObjectPrefix, ExpectedBucketOwner: config.ExpectedAWSAccountID,
		EncryptionKeyARN: config.EncryptionKeyARN, ObjectLockMode: config.ObjectLockMode, RetentionDays: StateRetentionDays, Clock: clock,
	}
}

type PublicationS3Reader interface {
	GetObject(context.Context, *s3.GetObjectInput, ...func(*s3.Options)) (*s3.GetObjectOutput, error)
	GetObjectRetention(context.Context, *s3.GetObjectRetentionInput, ...func(*s3.Options)) (*s3.GetObjectRetentionOutput, error)
}

type PublicationDynamoReader interface {
	GetItem(context.Context, *dynamodb.GetItemInput, ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error)
}

type publicationS3Reader struct{ PublicationS3Reader }

func (publicationS3Reader) PutObject(context.Context, *s3.PutObjectInput, ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	return nil, errors.New("publication reader cannot write S3 state")
}

type publicationDynamoReader struct{ PublicationDynamoReader }

func (publicationDynamoReader) UpdateItem(context.Context, *dynamodb.UpdateItemInput, ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	return nil, errors.New("publication reader cannot update DynamoDB state")
}

type publicationStateReader struct{ store *StateStore }

func (reader publicationStateReader) Load(ctx context.Context, stateID string) (signingbroker.Checkpoint, error) {
	return reader.store.Load(ctx, stateID)
}
func (publicationStateReader) CompareAndSwap(context.Context, string, int64, signingbroker.Checkpoint) error {
	return errors.New("publication reader cannot advance a checkpoint")
}

func NewPublicationReader(config PublicationReaderConfig, s3Reader PublicationS3Reader, dynamoReader PublicationDynamoReader, clock func() time.Time) (*signingbroker.PublicationController, error) {
	if err := validatePublicationReaderConfig(config, clock); err != nil {
		return nil, err
	}
	if isNil(s3Reader) || isNil(dynamoReader) {
		return nil, errors.New("publication state readers are required")
	}
	store, err := NewStateStore(config.stateConfig(clock), publicationS3Reader{s3Reader}, publicationDynamoReader{dynamoReader})
	if err != nil {
		return nil, err
	}
	return signingbroker.NewPublicationController(signingbroker.PublicationConfig{
		Environment: config.Environment, RepositoryID: config.RepositoryID, StateID: config.StateID, BootstrapRootSHA256: config.BootstrapRootSHA256,
	}, publicationStateReader{store}, clock)
}
