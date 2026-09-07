package awsbroker

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	kmstypes "github.com/aws/aws-sdk-go-v2/service/kms/types"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/theupdateframework/go-tuf/v2/metadata"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/signingbroker"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/testrepo"
)

type fakeKMS struct {
	key       *ecdsa.PrivateKey
	keyARN    string
	getCalls  int
	signCalls int
}

func (client *fakeKMS) GetPublicKey(_ context.Context, input *kms.GetPublicKeyInput, _ ...func(*kms.Options)) (*kms.GetPublicKeyOutput, error) {
	client.getCalls++
	if aws.ToString(input.KeyId) != client.keyARN {
		return nil, errors.New("wrong key")
	}
	der, err := x509.MarshalPKIXPublicKey(client.key.Public())
	if err != nil {
		return nil, err
	}
	return &kms.GetPublicKeyOutput{
		KeyId: aws.String(client.keyARN), PublicKey: der, KeySpec: kmstypes.KeySpecEccNistP256,
		KeyUsage:          kmstypes.KeyUsageTypeSignVerify,
		SigningAlgorithms: []kmstypes.SigningAlgorithmSpec{kmstypes.SigningAlgorithmSpecEcdsaSha256},
	}, nil
}

func (client *fakeKMS) Sign(_ context.Context, input *kms.SignInput, _ ...func(*kms.Options)) (*kms.SignOutput, error) {
	client.signCalls++
	if aws.ToString(input.KeyId) != client.keyARN || input.MessageType != kmstypes.MessageTypeDigest ||
		input.SigningAlgorithm != kmstypes.SigningAlgorithmSpecEcdsaSha256 || len(input.Message) != sha256.Size {
		return nil, errors.New("wrong sign contract")
	}
	signature, err := ecdsa.SignASN1(rand.Reader, client.key, input.Message)
	if err != nil {
		return nil, err
	}
	return &kms.SignOutput{KeyId: aws.String(client.keyARN), SigningAlgorithm: input.SigningAlgorithm, Signature: signature}, nil
}

func validSignRuntimeConfig(now time.Time, rootHash, publicKeyHash string) RuntimeConfig {
	return RuntimeConfig{
		Operation: "sign", Environment: "staging", RepositoryID: "hid-staging-v1", StateID: "hid-staging-broker-v1",
		BootstrapRootSHA256: rootHash, StateTableName: "hid-staging-tuf-broker-state",
		StateBucketName: "hid-staging-evidence-123456", StateObjectPrefix: "tuf-signing-broker/state/hid-staging-broker-v1/",
		StorageEncryptionKeyARN: "arn:aws:kms:us-east-1:123456789012:key/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
		ObjectLockMode:          "COMPLIANCE", StateRetentionDays: StateRetentionDays, EvidenceRetentionDays: 365,
		ExpectedAWSAccountID: "123456789012", ExpectedAWSRegion: "us-east-1",
		Role: "snapshot", CandidateID: "one",
		SigningKMSKeyARN:          "arn:aws:kms:us-east-1:123456789012:key/bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
		SigningKMSPublicKeySHA256: publicKeyHash, RequestBucketName: "hid-staging-evidence-123456",
		RequestObjectPrefix: "tuf-signing-broker/requests/hid-staging-broker-v1/snapshot-one/",
	}
}

func TestSigningRuntimeConnectsImmutableInvocationStateCASAndPinnedKMS(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	clockNow := now
	repositoryFixture, initial := testrepo.NewHIDRepository(t, "staging", stateTestRelease, now)
	nextRelease := "r0000000002-gbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	next := repositoryFixture.Advance(t, nextRelease)
	snapshotKey := repositoryFixture.RolePrivateKey(t, metadata.SNAPSHOT, 0)
	publicDER, err := x509.MarshalPKIXPublicKey(snapshotKey.Public())
	if err != nil {
		t.Fatal(err)
	}
	publicDigest := sha256.Sum256(publicDER)
	rootHash := digestHex(initial.RootBytes)
	config := validSignRuntimeConfig(now, rootHash, hex.EncodeToString(publicDigest[:]))
	s3Client := newFakeS3()
	dynamoClient := &fakeDynamo{}
	seedStore, err := NewStateStore(StateStoreConfig{
		Environment: config.Environment, RepositoryID: config.RepositoryID, StateID: config.StateID,
		BootstrapRootSHA256: rootHash, TableName: config.StateTableName, BucketName: config.StateBucketName,
		StateObjectPrefix: config.StateObjectPrefix, ExpectedBucketOwner: config.ExpectedAWSAccountID,
		EncryptionKeyARN: config.StorageEncryptionKeyARN, ObjectLockMode: config.ObjectLockMode,
		RetentionDays: config.StateRetentionDays, Clock: func() time.Time { return now },
	}, s3Client, dynamoClient)
	if err != nil {
		t.Fatal(err)
	}
	initialCheckpoint := signingbroker.Checkpoint{
		SchemaVersion: signingbroker.CheckpointSchemaVersion, Environment: initial.Environment,
		RepositoryID: config.RepositoryID, StateID: config.StateID, BootstrapRootSHA256: rootHash,
		Revision: 1, ReleaseID: initial.ReleaseID,
		RootHistory:               []signingbroker.MetadataRecord{signingbroker.NewMetadataRecord(initial.RootVersion, initial.RootBytes)},
		Targets:                   signingbroker.NewMetadataRecord(initial.TargetsVersion, initial.TargetsBytes),
		Snapshot:                  signingbroker.NewMetadataRecord(initial.SnapshotVersion, initial.SnapshotBytes),
		Timestamp:                 signingbroker.NewMetadataRecord(initial.TimestampVersion, initial.TimestampBytes),
		SnapshotVersionHighWater:  initial.SnapshotVersion,
		TimestampVersionHighWater: initial.TimestampVersion,
	}
	if err := seedStore.CompareAndSwap(context.Background(), config.StateID, 0, initialCheckpoint); err != nil {
		t.Fatal(err)
	}
	kmsClient := &fakeKMS{key: snapshotKey, keyARN: config.SigningKMSKeyARN}
	runtime, err := NewRuntime(config, RuntimeClients{S3: s3Client, DynamoDB: dynamoClient, KMS: kmsClient}, func() time.Time { return clockNow })
	if err != nil {
		t.Fatal(err)
	}
	request := signingbroker.Request{
		SchemaVersion: signingbroker.SchemaVersion, Environment: config.Environment, RepositoryID: config.RepositoryID,
		Role: "snapshot", ReleaseID: next.ReleaseID, CreatedAt: now.Format(time.RFC3339),
		Expires: now.Add(7 * 24 * time.Hour).Format(time.RFC3339), RootVersion: next.RootVersion,
		RootSHA256: digestHex(next.RootBytes), RootBytes: next.RootBytes,
		InputMetadataVersion: next.TargetsVersion, InputMetadataSHA256: digestHex(next.TargetsBytes), InputMetadataBytes: next.TargetsBytes,
	}
	requestBytes, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	nonCanonicalBytes, err := json.MarshalIndent(request, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	nonCanonicalHash := digestHex(nonCanonicalBytes)
	nonCanonicalKey := config.RequestObjectPrefix + "noncanonical.json"
	nonCanonicalVersion := "noncanonical-request-version-1"
	s3Client.objects[objectMapKey(nonCanonicalKey, nonCanonicalVersion)] = storedS3Object{
		data: nonCanonicalBytes, versionID: nonCanonicalVersion, contentType: "application/json",
		checksum: checksumBase64(nonCanonicalBytes),
		kmsKey:   config.StorageEncryptionKeyARN, mode: s3types.ObjectLockRetentionModeCompliance,
		retainUntil: now.Add(time.Duration(config.EvidenceRetentionDays) * 24 * time.Hour), metadata: map[string]string{
			"hid-schema": SigningRequestObjectSchema, "hid-state-id": config.StateID,
			"hid-role": config.Role, "hid-candidate": config.CandidateID, "hid-sha256": nonCanonicalHash,
		},
	}
	nonCanonicalEvent, _ := json.Marshal(SigningInvocation{
		SchemaVersion: SigningInvocationSchema, Bucket: config.RequestBucketName,
		Key: nonCanonicalKey, VersionID: nonCanonicalVersion, SHA256: nonCanonicalHash,
	})
	updatesBeforeRejectedRequest := dynamoClient.updateCalls
	if _, err := runtime.Invoke(context.Background(), nonCanonicalEvent); err == nil || !strings.Contains(err.Error(), "canonical JSON") {
		t.Fatalf("non-canonical locked S3 request was accepted: %v", err)
	}
	if kmsClient.getCalls != 0 || kmsClient.signCalls != 0 || dynamoClient.updateCalls != updatesBeforeRejectedRequest {
		t.Fatal("non-canonical locked S3 request reached KMS or mutated broker state")
	}
	requestHash := digestHex(requestBytes)
	requestKey := config.RequestObjectPrefix + "request.json"
	requestVersion := "request-version-1"
	s3Client.objects[objectMapKey(requestKey, requestVersion)] = storedS3Object{
		data: requestBytes, versionID: requestVersion, contentType: "application/json",
		checksum: checksumBase64(requestBytes),
		kmsKey:   config.StorageEncryptionKeyARN, mode: s3types.ObjectLockRetentionModeCompliance,
		retainUntil: now.Add(time.Duration(config.EvidenceRetentionDays) * 24 * time.Hour), metadata: map[string]string{
			"hid-schema": SigningRequestObjectSchema, "hid-state-id": config.StateID,
			"hid-role": config.Role, "hid-candidate": config.CandidateID, "hid-sha256": requestHash,
		},
	}
	event, _ := json.Marshal(SigningInvocation{
		SchemaVersion: SigningInvocationSchema, Bucket: config.RequestBucketName,
		Key: requestKey, VersionID: requestVersion, SHA256: requestHash,
	})
	value, err := runtime.Invoke(context.Background(), event)
	if err != nil {
		t.Fatal(err)
	}
	result, ok := value.(signingbroker.Result)
	if !ok || result.OutputVersion != 2 || result.StateRevision != 2 || result.IdempotentReplay ||
		result.OutputSHA256 != digestHex(result.OutputBytes) || result.RequestSHA256 != requestHash || result.RequestObject == nil ||
		result.RequestObject.Bucket != config.RequestBucketName || result.RequestObject.Key != requestKey ||
		result.RequestObject.VersionID != requestVersion || result.RequestObject.SHA256 != requestHash ||
		kmsClient.getCalls != 1 || kmsClient.signCalls != 1 {
		t.Fatalf("unexpected runtime result: %#v, KMS get/sign=%d/%d", value, kmsClient.getCalls, kmsClient.signCalls)
	}
	clockNow = now.Add(time.Hour)
	value, err = runtime.Invoke(context.Background(), event)
	if err != nil {
		t.Fatal(err)
	}
	replayed := value.(signingbroker.Result)
	if !replayed.IdempotentReplay || !strings.EqualFold(replayed.OutputSHA256, result.OutputSHA256) || kmsClient.signCalls != 1 {
		t.Fatal("runtime replay reached KMS or returned different output")
	}
	alternateVersion := "request-version-2"
	s3Client.objects[objectMapKey(requestKey, alternateVersion)] = storedS3Object{
		data: requestBytes, versionID: alternateVersion, contentType: "application/json",
		checksum: checksumBase64(requestBytes),
		kmsKey:   config.StorageEncryptionKeyARN, mode: s3types.ObjectLockRetentionModeCompliance,
		retainUntil: now.Add(time.Duration(config.EvidenceRetentionDays) * 24 * time.Hour), metadata: map[string]string{
			"hid-schema": SigningRequestObjectSchema, "hid-state-id": config.StateID,
			"hid-role": config.Role, "hid-candidate": config.CandidateID, "hid-sha256": requestHash,
		},
	}
	alternateEvent, _ := json.Marshal(SigningInvocation{
		SchemaVersion: SigningInvocationSchema, Bucket: config.RequestBucketName,
		Key: requestKey, VersionID: alternateVersion, SHA256: requestHash,
	})
	if _, err := runtime.Invoke(context.Background(), alternateEvent); !errors.Is(err, signingbroker.ErrPending) {
		t.Fatalf("same request bytes from a different immutable S3 version replayed authorization: %v", err)
	}
	if kmsClient.signCalls != 1 {
		t.Fatal("different immutable S3 version reached KMS")
	}
}

func runtimeEnvironment(operation string) map[string]string {
	values := map[string]string{
		"HID_BROKER_CONFIG_SCHEMA": RuntimeConfigSchema, "HID_BROKER_OPERATION": operation,
		"HID_BROKER_ENVIRONMENT": "staging", "HID_REPOSITORY_ID": "hid-staging-v1",
		"HID_STATE_ID": "hid-staging-broker-v1", "HID_BOOTSTRAP_ROOT_SHA256": strings.Repeat("a", 64),
		"HID_STATE_TABLE_NAME": "hid-staging-tuf-broker-state", "HID_STATE_BUCKET_NAME": "hid-staging-evidence-123456",
		"HID_STATE_OBJECT_PREFIX": "tuf-signing-broker/state/hid-staging-broker-v1/",
		"HID_STORAGE_KMS_KEY_ARN": "arn:aws:kms:us-east-1:123456789012:key/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
		"HID_OBJECT_LOCK_MODE":    "COMPLIANCE", "HID_STATE_RETENTION_DAYS": "730",
		"HID_EVIDENCE_RETENTION_DAYS": "365",
		"HID_EXPECTED_AWS_ACCOUNT_ID": "123456789012", "HID_EXPECTED_AWS_REGION": "us-east-1",
	}
	if operation == "sign" {
		values["HID_ROLE"] = "snapshot"
		values["HID_CANDIDATE"] = "one"
		values["HID_KMS_KEY_ARN"] = "arn:aws:kms:us-east-1:123456789012:key/bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"
		values["HID_KMS_PUBLIC_KEY_SPKI_SHA256"] = strings.Repeat("b", 64)
		values["HID_REQUEST_BUCKET_NAME"] = values["HID_STATE_BUCKET_NAME"]
		values["HID_REQUEST_OBJECT_PREFIX"] = "tuf-signing-broker/requests/hid-staging-broker-v1/snapshot-one/"
		values["HID_MAX_PLAN_AGE_SECONDS"] = "300"
		values["HID_MAX_CLOCK_SKEW_SECONDS"] = "60"
		values["HID_REQUIRE_OBJECT_LOCK_RETENTION"] = "true"
	} else {
		values["HID_PUBLIC_REPOSITORY_URL"] = "https://updates.staging.healthidentitydirectory.com/"
		values["HID_BOOTSTRAP_ROOT_BUCKET_NAME"] = values["HID_STATE_BUCKET_NAME"]
		values["HID_BOOTSTRAP_ROOT_OBJECT_KEY"] = "tuf-signing-broker/bootstrap/hid-staging-broker-v1/root.json"
		values["HID_BOOTSTRAP_ROOT_OBJECT_VERSION_ID"] = "bootstrap-version-1"
		values["HID_CHECKPOINT_RULE_ARN"] = "arn:aws:events:us-east-1:123456789012:rule/hid-staging-tuf-broker-checkpoint"
	}
	return values
}

func TestRuntimeEnvironmentIsCompleteAndFixed(t *testing.T) {
	for _, operation := range []string{"sign", "checkpoint"} {
		t.Run(operation, func(t *testing.T) {
			values := runtimeEnvironment(operation)
			config, err := LoadRuntimeConfig(func(name string) (string, bool) { value, ok := values[name]; return value, ok })
			if err != nil {
				t.Fatal(err)
			}
			if config.Operation != operation || config.ExpectedAWSRegion != "us-east-1" ||
				config.StateRetentionDays != 730 || config.EvidenceRetentionDays != 365 {
				t.Fatalf("unexpected parsed runtime configuration: %+v", config)
			}
		})
	}
	mutations := []struct {
		name  string
		key   string
		value string
	}{
		{"schema", "HID_BROKER_CONFIG_SCHEMA", "v2"},
		{"short state retention", "HID_STATE_RETENTION_DAYS", "729"},
		{"long state retention", "HID_STATE_RETENTION_DAYS", "731"},
		{"evidence exceeds fixed state retention", "HID_EVIDENCE_RETENTION_DAYS", "731"},
		{"plan age", "HID_MAX_PLAN_AGE_SECONDS", "301"},
		{"request bucket", "HID_REQUEST_BUCKET_NAME", "other-bucket"},
		{"state trust reset", "HID_STATE_ID", "hid-staging-broker-v2"},
		{"region", "HID_EXPECTED_AWS_REGION", "us-west-2"},
	}
	for _, mutation := range mutations {
		t.Run(mutation.name, func(t *testing.T) {
			values := runtimeEnvironment("sign")
			values[mutation.key] = mutation.value
			if _, err := LoadRuntimeConfig(func(name string) (string, bool) { value, ok := values[name]; return value, ok }); err == nil {
				t.Fatal("runtime configuration drift was accepted")
			}
		})
	}
}

func TestScheduledCheckpointEventIsStrictAndTimeBound(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	handler := &ScheduledCheckpointHandler{
		runner: &CheckpointRunner{}, accountID: "123456789012", region: "us-east-1",
		ruleARN: "arn:aws:events:us-east-1:123456789012:rule/hid-staging-tuf-broker-checkpoint",
		clock:   func() time.Time { return now },
	}
	event := scheduledEvent{
		Version: "0", ID: "12345678-1234-4123-8123-123456789abc", DetailType: "Scheduled Event",
		Source: "aws.events", Account: "123456789012", Time: now.Format(time.RFC3339), Region: "us-east-1",
		Resources: []string{handler.ruleARN}, Detail: json.RawMessage(`{}`),
	}
	encoded, _ := json.Marshal(event)
	if _, err := handler.Invoke(context.Background(), encoded); err == nil || strings.Contains(err.Error(), "does not match its fixed rule") {
		t.Fatalf("valid scheduled event did not pass the event gate: %v", err)
	}
	event.Time = now.Add(-10*time.Minute - time.Second).Format(time.RFC3339)
	encoded, _ = json.Marshal(event)
	if _, err := handler.Invoke(context.Background(), encoded); err == nil || !strings.Contains(err.Error(), "does not match its fixed rule") {
		t.Fatalf("stale scheduled event was accepted: %v", err)
	}
	duplicate := []byte(`{"version":"0","version":"0"}`)
	if _, err := handler.Invoke(context.Background(), duplicate); err == nil || !strings.Contains(err.Error(), "duplicate object name") {
		t.Fatalf("duplicate scheduled-event member was accepted: %v", err)
	}
	for _, noncanonical := range []string{"2026-09-02T13:00:00+01:00", "2026-09-02T12:00:00.000Z"} {
		event.Time = noncanonical
		encoded, _ = json.Marshal(event)
		if _, err := handler.Invoke(context.Background(), encoded); err == nil || !strings.Contains(err.Error(), "time is invalid") {
			t.Fatalf("noncanonical scheduled-event time %q was accepted: %v", noncanonical, err)
		}
	}
}

func TestRequestHashUsesExactObjectBytes(t *testing.T) {
	data := []byte(`{"value":1}`)
	digest := sha256.Sum256(data)
	if got := digestHex(data); got != hex.EncodeToString(digest[:]) || base64.StdEncoding.EncodeToString(digest[:]) == got {
		t.Fatal("request object digest encodings are confused")
	}
}
