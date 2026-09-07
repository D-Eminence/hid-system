package awsbroker

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/repository"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

type PublicationArchive struct {
	SchemaVersion    string                   `json:"schema_version"`
	Environment      string                   `json:"environment"`
	RepositorySHA256 string                   `json:"repository_sha256"`
	Files            []PublicationArchiveFile `json:"files"`
}
type PublicationArchiveFile struct {
	repository.PublicationFile
	Reference PublicationEvidenceReference `json:"reference"`
}

// ArchiveGeneration preserves and reads back every metadata/target byte before
// publication. Object keys are content-addressed; this is harmless data replay,
// NOT replay of journal intents or Cloudflare actions. No archive code executes.
func (store *PublicationJournalStore) ArchiveGeneration(ctx context.Context, directory, expected string) (PublicationEvidenceReference, error) {
	if store == nil || isNil(ctx) || !sha256Pattern.MatchString(expected) {
		return PublicationEvidenceReference{}, errors.New("archive context and exact repository hash are required")
	}
	if err := ctx.Err(); err != nil { return PublicationEvidenceReference{}, err }
	generation, err := repository.InspectPublicationGeneration(directory, store.config.Policy.Environment, store.clock(), true)
	if err != nil {
		return PublicationEvidenceReference{}, err
	}
	if generation.SHA256() != expected {
		return PublicationEvidenceReference{}, errors.New("archive differs from protected repository hash")
	}
	manifest := PublicationArchive{SchemaVersion: "hid.tuf.publication-archive/v1", Environment: store.config.Policy.Environment, RepositorySHA256: expected}
	for _, file := range generation.Files() {
		if err := ctx.Err(); err != nil {
			return PublicationEvidenceReference{}, err
		}
		path := filepath.Join(directory, filepath.FromSlash(file.Path))
		resolved, err := filepath.EvalSymlinks(path)
		if err != nil || resolved != path {
			return PublicationEvidenceReference{}, errors.New("archive file path changed")
		}
		// Generation inspection rejects symlinks/special files. Open again with
		// no-follow/nonblocking flags and rehash; no caller byte is trusted twice.
		input, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
		if err != nil {
			return PublicationEvidenceReference{}, err
		}
		stat, err := input.Stat()
		if err != nil || !stat.Mode().IsRegular() || stat.Size() != file.Length || file.Length < 1 || file.Length > 25*1024*1024 {
			input.Close()
			return PublicationEvidenceReference{}, errors.New("archive file is not bounded regular data")
		}
		data, err := io.ReadAll(io.LimitReader(input, file.Length+1))
		closeErr := input.Close()
		if err != nil || closeErr != nil || int64(len(data)) != file.Length || digestHex(data) != file.SHA256 {
			return PublicationEvidenceReference{}, errors.New("archive file changed during read")
		}
		ref, err := store.archiveBytes(ctx, data, "objects/"+file.SHA256, "application/octet-stream")
		if err != nil {
			return PublicationEvidenceReference{}, err
		}
		manifest.Files = append(manifest.Files, PublicationArchiveFile{PublicationFile: file, Reference: ref})
	}
	data, err := json.Marshal(manifest)
	if err != nil || len(data) > 8*1024*1024 {
		return PublicationEvidenceReference{}, errors.New("archive manifest exceeds bound")
	}
	// A second whole-directory inspection prevents a mixed-generation archive.
	after, err := repository.InspectPublicationGeneration(directory, store.config.Policy.Environment, store.clock(), true)
	if err != nil || after.SHA256() != expected {
		return PublicationEvidenceReference{}, errors.New("repository changed during archival")
	}
	return store.archiveBytes(ctx, data, "manifests/"+digestHex(data)+".json", "application/json")
}

func (store *PublicationJournalStore) archiveBytes(ctx context.Context, data []byte, suffix, contentType string) (PublicationEvidenceReference, error) {
	key := store.config.ObjectPrefix + "archives/" + suffix
	hash := digestHex(data)
	listed, err := store.s3.ListObjectVersions(ctx, &s3.ListObjectVersionsInput{Bucket: aws.String(store.config.BucketName), ExpectedBucketOwner: aws.String(store.config.ExpectedBucketOwner), Prefix: aws.String(key), MaxKeys: aws.Int32(2)})
	if err != nil {
		return PublicationEvidenceReference{}, err
	}
	if listed == nil || aws.ToBool(listed.IsTruncated) || len(listed.DeleteMarkers) != 0 || len(listed.CommonPrefixes) != 0 || len(listed.Versions) > 1 {
		return PublicationEvidenceReference{}, errors.New("archive object inventory is ambiguous")
	}
	var version string
	digest, _ := hex.DecodeString(hash)
	checksum := base64.StdEncoding.EncodeToString(digest)
	metadata := map[string]string{"schema": "hid.tuf.publication-archive/v1", "journal-id": store.journalID(), "sha256": hash}
	if len(listed.Versions) == 1 {
		prior := listed.Versions[0]
		if aws.ToString(prior.Key) != key || !aws.ToBool(prior.IsLatest) || !validVersionID(aws.ToString(prior.VersionId)) {
			return PublicationEvidenceReference{}, errors.New("archive object version is invalid")
		}
		version = aws.ToString(prior.VersionId)
	} else {
		output, err := store.s3.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(store.config.BucketName), Key: aws.String(key), ExpectedBucketOwner: aws.String(store.config.ExpectedBucketOwner),
			Body: bytes.NewReader(data), ContentLength: aws.Int64(int64(len(data))), ContentType: aws.String(contentType), ChecksumAlgorithm: s3types.ChecksumAlgorithmSha256, ChecksumSHA256: aws.String(checksum), IfNoneMatch: aws.String("*"),
			ServerSideEncryption: s3types.ServerSideEncryptionAwsKms, SSEKMSKeyId: aws.String(store.config.EncryptionKeyARN), ObjectLockMode: s3types.ObjectLockMode(store.config.ObjectLockMode),
			ObjectLockRetainUntilDate: aws.Time(store.clock().UTC().Add(time.Duration(StateRetentionDays) * 24 * time.Hour)), Metadata: metadata})
		if err != nil || output == nil || !validVersionID(aws.ToString(output.VersionId)) || aws.ToString(output.ChecksumSHA256) != checksum ||
			output.ServerSideEncryption != s3types.ServerSideEncryptionAwsKms || aws.ToString(output.SSEKMSKeyId) != store.config.EncryptionKeyARN {
			return PublicationEvidenceReference{}, errors.New("archive write failed or is ambiguous")
		}
		version = aws.ToString(output.VersionId)
	}
	retention, err := store.s3.GetObjectRetention(ctx, &s3.GetObjectRetentionInput{Bucket: aws.String(store.config.BucketName), Key: aws.String(key), VersionId: aws.String(version), ExpectedBucketOwner: aws.String(store.config.ExpectedBucketOwner)})
	// Reused content must still cover at least the complete release acceptance
	// and recovery window; normal new archives use 2 years (730 days) of retention.
	if err != nil || retention == nil || retention.Retention == nil || string(retention.Retention.Mode) != store.config.ObjectLockMode ||
		retention.Retention.RetainUntilDate == nil || retention.Retention.RetainUntilDate.Before(store.clock().Add(365*24*time.Hour)) {
		return PublicationEvidenceReference{}, errors.New("archive retention is insufficient")
	}
	output, err := store.s3.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(store.config.BucketName), Key: aws.String(key), VersionId: aws.String(version), ExpectedBucketOwner: aws.String(store.config.ExpectedBucketOwner), ChecksumMode: s3types.ChecksumModeEnabled})
	if err != nil {
		return PublicationEvidenceReference{}, err
	}
	if output == nil || output.Body == nil {
		return PublicationEvidenceReference{}, errors.New("archive readback returned no body")
	}
	defer output.Body.Close()
	if aws.ToString(output.VersionId) != version || aws.ToString(output.ContentType) != contentType || aws.ToInt64(output.ContentLength) != int64(len(data)) ||
		aws.ToString(output.ChecksumSHA256) != checksum || output.ServerSideEncryption != s3types.ServerSideEncryptionAwsKms || aws.ToString(output.SSEKMSKeyId) != store.config.EncryptionKeyARN || len(output.Metadata) != len(metadata) {
		return PublicationEvidenceReference{}, errors.New("archive readback envelope differs")
	}
	for name, value := range metadata {
		if output.Metadata[name] != value {
			return PublicationEvidenceReference{}, errors.New("archive metadata differs")
		}
	}
	readback, err := io.ReadAll(io.LimitReader(output.Body, int64(len(data))+1))
	if err != nil || !bytes.Equal(readback, data) {
		return PublicationEvidenceReference{}, errors.New("archive readback bytes differ")
	}
	if err := ctx.Err(); err != nil {
		return PublicationEvidenceReference{}, err
	}
	return PublicationEvidenceReference{Bucket: store.config.BucketName, Key: key, VersionID: version, SHA256: hash}, nil
}
