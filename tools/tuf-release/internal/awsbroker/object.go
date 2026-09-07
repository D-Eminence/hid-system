package awsbroker

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// ImmutableObjectReaderConfig pins an Object-Locked, versioned, SSE-KMS S3
// namespace used for request and bootstrap inputs.
type ImmutableObjectReaderConfig struct {
	BucketName                string
	ExpectedBucketOwner       string
	EncryptionKeyARN          string
	ObjectLockMode            string
	MinimumRemainingRetention time.Duration
	Clock                     func() time.Time
}

// ImmutableObjectReader retrieves only explicit S3 versions and verifies the
// complete storage envelope before returning bounded bytes.
type ImmutableObjectReader struct {
	config ImmutableObjectReaderConfig
	s3     S3Client
}

func NewImmutableObjectReader(config ImmutableObjectReaderConfig, client S3Client) (*ImmutableObjectReader, error) {
	if !bucketPattern.MatchString(config.BucketName) || strings.Contains(config.BucketName, "..") ||
		!awsAccountPattern.MatchString(config.ExpectedBucketOwner) || !kmsKeyARNPattern.MatchString(config.EncryptionKeyARN) ||
		!strings.Contains(config.EncryptionKeyARN, ":"+config.ExpectedBucketOwner+":key/") ||
		config.ObjectLockMode != string(s3types.ObjectLockModeGovernance) && config.ObjectLockMode != string(s3types.ObjectLockModeCompliance) ||
		config.MinimumRemainingRetention < 0 || config.MinimumRemainingRetention > time.Duration(StateRetentionDays)*24*time.Hour ||
		config.Clock == nil || config.Clock().IsZero() {
		return nil, errors.New("immutable S3 reader configuration is invalid")
	}
	if isNil(client) {
		return nil, errors.New("immutable S3 reader client is required")
	}
	return &ImmutableObjectReader{config: config, s3: client}, nil
}

func (reader *ImmutableObjectReader) Read(
	ctx context.Context,
	key string,
	versionID string,
	expectedSHA256 string,
	maximum int,
	expectedMetadata map[string]string,
) ([]byte, error) {
	data, minimumRetentionSatisfied, err := reader.read(
		ctx, key, versionID, expectedSHA256, maximum, expectedMetadata,
	)
	if err != nil {
		return nil, err
	}
	if !minimumRetentionSatisfied {
		return nil, errors.New("immutable input lacks the required active fixed-mode retention window")
	}
	return data, nil
}

// ReadForSigningReplay verifies the full immutable envelope but reports a
// short remaining-retention window instead of rejecting it. The signing
// broker may use such an object only to replay an already committed exact
// result; it must reject it before initializing a signer for new output.
func (reader *ImmutableObjectReader) ReadForSigningReplay(
	ctx context.Context,
	key string,
	versionID string,
	expectedSHA256 string,
	maximum int,
	expectedMetadata map[string]string,
) ([]byte, bool, error) {
	return reader.read(ctx, key, versionID, expectedSHA256, maximum, expectedMetadata)
}

func (reader *ImmutableObjectReader) read(
	ctx context.Context,
	key string,
	versionID string,
	expectedSHA256 string,
	maximum int,
	expectedMetadata map[string]string,
) ([]byte, bool, error) {
	if reader == nil || isNil(ctx) || !validObjectKey(key) || !validVersionID(versionID) ||
		!sha256Pattern.MatchString(expectedSHA256) || maximum < 1 || maximum > signingRequestMaximumBytes {
		return nil, false, errors.New("immutable S3 read request is invalid")
	}
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	retention, err := reader.s3.GetObjectRetention(ctx, &s3.GetObjectRetentionInput{
		Bucket: aws.String(reader.config.BucketName), Key: aws.String(key), VersionId: aws.String(versionID),
		ExpectedBucketOwner: aws.String(reader.config.ExpectedBucketOwner),
	})
	if err != nil {
		return nil, false, fmt.Errorf("get immutable input Object Lock retention: %w", err)
	}
	now := reader.config.Clock().UTC().Truncate(time.Second)
	if retention == nil || retention.Retention == nil || string(retention.Retention.Mode) != reader.config.ObjectLockMode ||
		retention.Retention.RetainUntilDate == nil || !retention.Retention.RetainUntilDate.After(now) {
		return nil, false, errors.New("immutable input has no active fixed-mode retention")
	}
	minimumRetentionSatisfied := !retention.Retention.RetainUntilDate.Before(
		now.Add(reader.config.MinimumRemainingRetention),
	)
	output, err := reader.s3.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(reader.config.BucketName), Key: aws.String(key), VersionId: aws.String(versionID),
		ExpectedBucketOwner: aws.String(reader.config.ExpectedBucketOwner), ChecksumMode: s3types.ChecksumModeEnabled,
	})
	if err != nil {
		return nil, false, fmt.Errorf("get exact immutable input version: %w", err)
	}
	if output == nil || output.Body == nil {
		return nil, false, errors.New("get exact immutable input version returned no body")
	}
	closeBody := func() { _ = output.Body.Close() }
	length := aws.ToInt64(output.ContentLength)
	if aws.ToString(output.VersionId) != versionID || length < 1 || length > int64(maximum) ||
		output.DeleteMarker != nil && *output.DeleteMarker || output.ServerSideEncryption != s3types.ServerSideEncryptionAwsKms ||
		aws.ToString(output.SSEKMSKeyId) != reader.config.EncryptionKeyARN || aws.ToString(output.ContentType) != "application/json" ||
		aws.ToString(output.ContentEncoding) != "" {
		closeBody()
		return nil, false, errors.New("immutable input response violated version, size, media-type, or encryption policy")
	}
	expectedDigest, err := hex.DecodeString(expectedSHA256)
	if err != nil {
		closeBody()
		return nil, false, errors.New("decode immutable input SHA-256")
	}
	if output.ChecksumSHA256 == nil || *output.ChecksumSHA256 != base64.StdEncoding.EncodeToString(expectedDigest) {
		closeBody()
		return nil, false, errors.New("immutable input full-object S3 checksum is missing or differs from its invocation pin")
	}
	if expectedMetadata != nil {
		if len(output.Metadata) != len(expectedMetadata) {
			closeBody()
			return nil, false, errors.New("immutable input has unexpected S3 metadata")
		}
		for name, expected := range expectedMetadata {
			if output.Metadata[name] != expected {
				closeBody()
				return nil, false, fmt.Errorf("immutable input S3 metadata %s differs", name)
			}
		}
	}
	data, readErr := io.ReadAll(io.LimitReader(output.Body, int64(maximum)+1))
	closeErr := output.Body.Close()
	if readErr != nil {
		return nil, false, fmt.Errorf("read immutable input: %w", readErr)
	}
	if closeErr != nil {
		return nil, false, fmt.Errorf("close immutable input: %w", closeErr)
	}
	if int64(len(data)) != length || len(data) > maximum || digestHex(data) != expectedSHA256 {
		return nil, false, errors.New("immutable input bytes differ from their invocation pin")
	}
	return data, minimumRetentionSatisfied, nil
}

func validObjectKey(key string) bool {
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
