package awsbroker

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/strictjson"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

type PublicationEvidenceReference struct {
	Bucket    string `json:"bucket"`
	Key       string `json:"key"`
	VersionID string `json:"version_id"`
	SHA256    string `json:"sha256"`
}

// Reference returns the exact successfully read-back head, never an intent
// inferred from a failed write response. Load must have just succeeded.
func (store *PublicationJournalStore) Reference() (PublicationEvidenceReference, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if !store.loaded || store.loadedHead == nil {
		return PublicationEvidenceReference{}, errors.New("journal reference requires successful readback")
	}
	return PublicationEvidenceReference{Bucket: store.config.BucketName, Key: store.loadedHead.Key,
		VersionID: store.loadedHead.VersionID, SHA256: store.loadedHead.SHA256}, nil
}

// ArchiveEvidence preserves bounded structured public evidence, not process
// output, credentials or raw errors. Caller must construct the reviewed schema.
// A duplicate or ambiguous write fails; it is never an automatic replay grant.
func (store *PublicationJournalStore) ArchiveEvidence(ctx context.Context, data []byte, expectedSHA256 string) (PublicationEvidenceReference, error) {
	if store == nil || isNil(ctx) || len(data) == 0 || len(data) > maxPublicationEntryBytes || digestHex(data) != expectedSHA256 {
		return PublicationEvidenceReference{}, errors.New("publication evidence is not bounded or hash-pinned")
	}
	var envelope struct {
		SchemaVersion string          `json:"schema_version"`
		Phase         string          `json:"phase"`
		Binding       json.RawMessage `json:"binding"`
		Payload       json.RawMessage `json:"payload"`
	}
	if err := strictjson.Decode(data, &envelope); err != nil {
		return PublicationEvidenceReference{}, err
	}
	if envelope.SchemaVersion != "hid.tuf.publication-evidence/v1" || len(envelope.Binding) == 0 || len(envelope.Payload) == 0 {
		return PublicationEvidenceReference{}, errors.New("publication evidence envelope is invalid")
	}
	if err := ctx.Err(); err != nil {
		return PublicationEvidenceReference{}, err
	}
	key := store.config.ObjectPrefix + "evidence/" + expectedSHA256 + ".json"
	digest, _ := hex.DecodeString(expectedSHA256)
	checksum := base64.StdEncoding.EncodeToString(digest)
	metadata := map[string]string{"schema": envelope.SchemaVersion, "journal-id": store.journalID()}
	retainUntil := store.clock().UTC().Add(time.Duration(StateRetentionDays) * 24 * time.Hour)
	output, err := store.s3.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(store.config.BucketName), Key: aws.String(key),
		ExpectedBucketOwner: aws.String(store.config.ExpectedBucketOwner), Body: bytes.NewReader(data), ContentLength: aws.Int64(int64(len(data))),
		ContentType: aws.String("application/json"), ChecksumAlgorithm: s3types.ChecksumAlgorithmSha256, ChecksumSHA256: aws.String(checksum), IfNoneMatch: aws.String("*"),
		ServerSideEncryption: s3types.ServerSideEncryptionAwsKms, SSEKMSKeyId: aws.String(store.config.EncryptionKeyARN),
		ObjectLockMode:            s3types.ObjectLockMode(store.config.ObjectLockMode),
		ObjectLockRetainUntilDate: aws.Time(retainUntil), Metadata: metadata})
	if err != nil || output == nil || !validVersionID(aws.ToString(output.VersionId)) || aws.ToString(output.ChecksumSHA256) != checksum ||
		output.ServerSideEncryption != s3types.ServerSideEncryptionAwsKms || aws.ToString(output.SSEKMSKeyId) != store.config.EncryptionKeyARN {
		return PublicationEvidenceReference{}, errors.New("immutable evidence write failed or is ambiguous; reconciliation required")
	}
	ref := PublicationEvidenceReference{Bucket: store.config.BucketName, Key: key, VersionID: aws.ToString(output.VersionId), SHA256: expectedSHA256}
	verified, err := store.reader.Read(ctx, key, ref.VersionID, expectedSHA256, maxPublicationEntryBytes, metadata)
	if err != nil || !bytes.Equal(verified, data) {
		return PublicationEvidenceReference{}, errors.New("immutable evidence readback failed")
	}
	retention, err := store.s3.GetObjectRetention(ctx, &s3.GetObjectRetentionInput{Bucket: aws.String(store.config.BucketName), Key: aws.String(key),
		VersionId: aws.String(ref.VersionID), ExpectedBucketOwner: aws.String(store.config.ExpectedBucketOwner)})
	if err != nil || retention == nil || retention.Retention == nil || string(retention.Retention.Mode) != store.config.ObjectLockMode ||
		retention.Retention.RetainUntilDate == nil || retention.Retention.RetainUntilDate.Before(retainUntil) {
		return PublicationEvidenceReference{}, errors.New("immutable evidence retention readback failed")
	}
	if err := ctx.Err(); err != nil {
		return PublicationEvidenceReference{}, err
	}
	return ref, nil
}
