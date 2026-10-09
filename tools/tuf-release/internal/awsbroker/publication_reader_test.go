package awsbroker

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/signingbroker"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/testrepo"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func publicationReaderTestConfig(now time.Time) PublicationReaderConfig {
	state := stateTestConfig(now)
	return PublicationReaderConfig{SchemaVersion: "hid.tuf.publication-reader/v1",
		Environment: state.Environment, RepositoryID: state.RepositoryID, StateID: state.StateID,
		BootstrapRootSHA256: state.BootstrapRootSHA256, TableName: state.TableName, BucketName: state.BucketName,
		StateObjectPrefix: state.StateObjectPrefix, ExpectedAWSAccountID: state.ExpectedBucketOwner, ExpectedAWSRegion: "us-east-1",
		EncryptionKeyARN: state.EncryptionKeyARN, ObjectLockMode: state.ObjectLockMode}
}

func TestPublicationReaderAuthenticatesLockedStateAndHasNoWriteSurface(t *testing.T) {
	now := time.Date(2026, 9, 5, 12, 0, 0, 0, time.UTC)
	_, genesis := testrepo.NewHIDRepository(t, "staging", stateTestRelease, now)
	config := publicationReaderTestConfig(now)
	config.BootstrapRootSHA256 = digestHex(genesis.RootBytes)
	s3Client, dynamoClient := newFakeS3(), &fakeDynamo{}
	state, err := NewStateStore(config.stateConfig(func() time.Time { return now }), s3Client, dynamoClient)
	if err != nil {
		t.Fatal(err)
	}
	writer, err := signingbroker.NewPublicationController(signingbroker.PublicationConfig{
		Environment: config.Environment, RepositoryID: config.RepositoryID, StateID: config.StateID, BootstrapRootSHA256: config.BootstrapRootSHA256,
	}, state, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	generation := signingbroker.PublishedGeneration{Environment: genesis.Environment, ReleaseID: genesis.ReleaseID,
		RootBytes: genesis.RootBytes, TargetsBytes: genesis.TargetsBytes, SnapshotBytes: genesis.SnapshotBytes, TimestampBytes: genesis.TimestampBytes}
	if _, err := writer.BootstrapPublished(context.Background(), generation); err != nil {
		t.Fatal(err)
	}
	puts, updates := s3Client.putCalls, dynamoClient.updateCalls
	reader, err := NewPublicationReader(config, s3Client, dynamoClient, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reader.VerifyPublished(context.Background(), generation); err != nil {
		t.Fatal(err)
	}
	if _, err := reader.BootstrapPublished(context.Background(), generation); err == nil {
		t.Fatal("read-only controller bootstrapped state")
	}
	if _, err := (publicationS3Reader{s3Client}).PutObject(context.Background(), &s3.PutObjectInput{}); err == nil {
		t.Fatal("read-only S3 client wrote state")
	}
	if _, err := (publicationDynamoReader{dynamoClient}).UpdateItem(context.Background(), &dynamodb.UpdateItemInput{}); err == nil {
		t.Fatal("read-only DynamoDB client wrote state")
	}
	if s3Client.putCalls != puts || dynamoClient.updateCalls != updates {
		t.Fatal("publication reader reached a storage write API")
	}
	if s3Client.retentionCalls == 0 || s3Client.getCalls == 0 || !*dynamoClient.lastGet.ConsistentRead {
		t.Fatal("publication reader bypassed locked, strongly consistent state validation")
	}
}

func TestPublicationReaderRejectsUnpinnedConfiguration(t *testing.T) {
	now := time.Date(2026, 9, 5, 12, 0, 0, 0, time.UTC)
	valid := publicationReaderTestConfig(now)
	encoded, err := json.Marshal(valid)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodePublicationReaderConfig(encoded); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*PublicationReaderConfig){
		func(c *PublicationReaderConfig) { c.SchemaVersion = "" },
		func(c *PublicationReaderConfig) { c.ExpectedAWSRegion = "eu-west-1" },
		func(c *PublicationReaderConfig) { c.ExpectedAWSAccountID = "111111111111" },
		func(c *PublicationReaderConfig) { c.BootstrapRootSHA256 = "" },
		func(c *PublicationReaderConfig) { c.RepositoryID = "hid-production-v1" },
		func(c *PublicationReaderConfig) { c.StateObjectPrefix = "tuf-signing-broker/state/" },
		func(c *PublicationReaderConfig) { c.TableName = "other-table" },
	} {
		changed := valid
		mutate(&changed)
		data, _ := json.Marshal(changed)
		if _, err := DecodePublicationReaderConfig(data); err == nil {
			t.Fatal("invalid publication trust config decoded")
		}
		if _, err := NewPublicationReader(changed, newFakeS3(), &fakeDynamo{}, func() time.Time { return now }); err == nil {
			t.Fatal("typed invalid config bypassed constructor")
		}
	}
	for _, data := range []string{
		strings.Replace(string(encoded), "{", `{"unexpected":true,`, 1),
		strings.Replace(string(encoded), "{", `{"environment":"staging",`, 1),
		string(encoded) + "{}",
	} {
		if _, err := DecodePublicationReaderConfig([]byte(data)); err == nil {
			t.Fatal("ambiguous config JSON was accepted")
		}
	}
}
