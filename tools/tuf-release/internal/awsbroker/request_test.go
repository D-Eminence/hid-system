package awsbroker

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

func requestTestLoader(t *testing.T, now time.Time, data []byte) (*RequestLoader, *fakeS3, SigningInvocation) {
	t.Helper()
	config := stateTestConfig(now)
	reader, err := NewImmutableObjectReader(ImmutableObjectReaderConfig{
		BucketName: config.BucketName, ExpectedBucketOwner: config.ExpectedBucketOwner,
		EncryptionKeyARN: config.EncryptionKeyARN, ObjectLockMode: config.ObjectLockMode,
		MinimumRemainingRetention: 365*24*time.Hour - requestRetentionGrace, Clock: config.Clock,
	}, newFakeS3())
	if err != nil {
		t.Fatal(err)
	}
	s3Client := reader.s3.(*fakeS3)
	loader, err := NewRequestLoader(RequestLoaderConfig{
		StateID: config.StateID, Role: "snapshot", CandidateID: "one", BucketName: config.BucketName,
		ObjectPrefix: "tuf-signing-broker/requests/hid-staging-broker-v1/snapshot-one/",
	}, reader)
	if err != nil {
		t.Fatal(err)
	}
	key := loader.config.ObjectPrefix + "request.json"
	versionID := "immutable-request-version"
	hash := digestHex(data)
	s3Client.objects[objectMapKey(key, versionID)] = storedS3Object{
		data: data, versionID: versionID, contentType: "application/json", checksum: checksumBase64(data),
		kmsKey: config.EncryptionKeyARN, mode: s3types.ObjectLockRetentionModeCompliance,
		retainUntil: now.Add(365 * 24 * time.Hour),
		metadata: map[string]string{
			"hid-schema": SigningRequestObjectSchema, "hid-state-id": config.StateID,
			"hid-role": "snapshot", "hid-candidate": "one", "hid-sha256": hash,
		},
	}
	return loader, s3Client, SigningInvocation{
		SchemaVersion: SigningInvocationSchema, Bucket: config.BucketName,
		Key: key, VersionID: versionID, SHA256: hash,
	}
}

func TestRequestLoaderReadsOnlyExactLockedVersion(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	data := []byte(`{"schema_version":"1.0.0"}`)
	loader, s3Client, invocation := requestTestLoader(t, now, data)
	encoded, err := json.Marshal(invocation)
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := loader.Load(context.Background(), encoded)
	if err != nil {
		t.Fatal(err)
	}
	if string(loaded.Bytes) != string(data) || !loaded.MinimumRetentionSatisfied ||
		loaded.RequestObject.Bucket != invocation.Bucket || loaded.RequestObject.Key != invocation.Key ||
		loaded.RequestObject.VersionID != invocation.VersionID || loaded.RequestObject.SHA256 != invocation.SHA256 ||
		s3Client.getCalls != 1 || s3Client.retentionCalls != 1 {
		t.Fatal("exact request body was not loaded once")
	}
	if s3Client.lastGet == nil || aws.ToString(s3Client.lastGet.Bucket) != invocation.Bucket ||
		aws.ToString(s3Client.lastGet.Key) != invocation.Key || aws.ToString(s3Client.lastGet.VersionId) != invocation.VersionID ||
		aws.ToString(s3Client.lastGet.ExpectedBucketOwner) != loader.reader.config.ExpectedBucketOwner ||
		s3Client.lastGet.ChecksumMode != s3types.ChecksumModeEnabled {
		t.Fatal("S3 read was not bound to exact bucket, owner, key, version, and checksum mode")
	}
}

func TestRequestLoaderReportsShortActiveRetentionOnlyForBrokerReplay(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	loader, s3Client, invocation := requestTestLoader(t, now, []byte(`{"request":true}`))
	mapKey := objectMapKey(invocation.Key, invocation.VersionID)
	object := s3Client.objects[mapKey]
	object.retainUntil = now.Add(24 * time.Hour)
	s3Client.objects[mapKey] = object
	encoded, _ := json.Marshal(invocation)
	loaded, err := loader.Load(context.Background(), encoded)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.MinimumRetentionSatisfied {
		t.Fatal("short active request retention was reported as sufficient for new signing")
	}
}

func TestRequestLoaderRejectsUntrustedInvocationBeforeS3(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	loader, s3Client, valid := requestTestLoader(t, now, []byte(`{"request":true}`))
	cases := []struct {
		name   string
		change func(*SigningInvocation)
	}{
		{"wrong schema", func(value *SigningInvocation) { value.SchemaVersion = "2" }},
		{"wrong bucket", func(value *SigningInvocation) { value.Bucket = "foreign-bucket" }},
		{"wrong prefix", func(value *SigningInvocation) {
			value.Key = "tuf-signing-broker/requests/hid-staging-broker-v1/snapshot-two/request.json"
		}},
		{"nested key", func(value *SigningInvocation) { value.Key = loader.config.ObjectPrefix + "nested/request.json" }},
		{"null version", func(value *SigningInvocation) { value.VersionID = "null" }},
		{"uppercase hash", func(value *SigningInvocation) { value.SHA256 = strings.ToUpper(value.SHA256) }},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			value := valid
			testCase.change(&value)
			encoded, _ := json.Marshal(value)
			if _, err := loader.Load(context.Background(), encoded); err == nil {
				t.Fatal("untrusted invocation was accepted")
			}
		})
	}
	duplicate := []byte(`{"schema_version":"` + SigningInvocationSchema + `","schema_version":"` + SigningInvocationSchema + `","bucket":"x","key":"x","version_id":"x","sha256":"` + strings.Repeat("a", 64) + `"}`)
	if _, err := loader.Load(context.Background(), duplicate); err == nil || !strings.Contains(err.Error(), "duplicate object name") {
		t.Fatalf("duplicate invocation field was accepted: %v", err)
	}
	unknown := []byte(`{"schema_version":"` + SigningInvocationSchema + `","bucket":"x","key":"x","version_id":"x","sha256":"` + strings.Repeat("a", 64) + `","output_version":99}`)
	if _, err := loader.Load(context.Background(), unknown); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("caller-selected output version was accepted: %v", err)
	}
	if s3Client.getCalls != 0 || s3Client.retentionCalls != 0 {
		t.Fatal("rejected invocation reached S3")
	}
}

func TestRequestLoaderRejectsStorageEnvelopeTampering(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	mutations := []struct {
		name   string
		change func(*storedS3Object)
	}{
		{"expired retention", func(value *storedS3Object) { value.retainUntil = now }},
		{"wrong lock mode", func(value *storedS3Object) { value.mode = s3types.ObjectLockRetentionModeGovernance }},
		{"wrong encryption key", func(value *storedS3Object) {
			value.kmsKey = "arn:aws:kms:us-east-1:123456789012:key/bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"
		}},
		{"wrong media type", func(value *storedS3Object) { value.contentType = "application/octet-stream" }},
		{"content encoding", func(value *storedS3Object) { value.contentEncoding = "gzip" }},
		{"missing checksum", func(value *storedS3Object) { value.checksum = "" }},
		{"changed bytes", func(value *storedS3Object) { value.data = append(value.data, 'x') }},
		{"wrong metadata", func(value *storedS3Object) { value.metadata["hid-role"] = "timestamp" }},
	}
	for _, testCase := range mutations {
		t.Run(testCase.name, func(t *testing.T) {
			loader, s3Client, invocation := requestTestLoader(t, now, []byte(`{"request":true}`))
			mapKey := objectMapKey(invocation.Key, invocation.VersionID)
			object := s3Client.objects[mapKey]
			testCase.change(&object)
			s3Client.objects[mapKey] = object
			encoded, _ := json.Marshal(invocation)
			if _, err := loader.Load(context.Background(), encoded); err == nil {
				t.Fatal("tampered immutable request was accepted")
			}
		})
	}
}

func TestImmutableReaderAndRequestLoaderConfigurationsArePinned(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	config := stateTestConfig(now)
	readerConfig := ImmutableObjectReaderConfig{
		BucketName: config.BucketName, ExpectedBucketOwner: config.ExpectedBucketOwner,
		EncryptionKeyARN: config.EncryptionKeyARN, ObjectLockMode: config.ObjectLockMode, Clock: config.Clock,
	}
	badReader := readerConfig
	badReader.EncryptionKeyARN = "arn:aws:kms:us-east-1:000000000000:key/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
	if _, err := NewImmutableObjectReader(badReader, newFakeS3()); err == nil {
		t.Fatal("cross-account encryption key was accepted")
	}
	reader, err := NewImmutableObjectReader(readerConfig, newFakeS3())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewRequestLoader(RequestLoaderConfig{
		StateID: config.StateID, Role: "snapshot", CandidateID: "one", BucketName: config.BucketName,
		ObjectPrefix: "tuf-signing-broker/requests/hid-staging-broker-v1/snapshot-two/",
	}, reader); err == nil {
		t.Fatal("cross-candidate request prefix was accepted")
	}
}
