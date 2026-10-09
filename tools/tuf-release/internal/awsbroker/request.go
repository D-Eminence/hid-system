package awsbroker

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/signingbroker"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/strictjson"
)

const (
	SigningInvocationSchema    = "hid.tuf.signing-broker.invoke/v1"
	SigningRequestObjectSchema = "hid.tuf.signing-broker.request/v1"
	maxInvocationBytes         = 16_384
	signingRequestMaximumBytes = signingbroker.MaxRequestBytes
)

// SigningInvocation contains only the location and digest of one immutable
// request object. All policy-bearing request content is decoded by the broker.
type SigningInvocation struct {
	SchemaVersion string `json:"schema_version"`
	Bucket        string `json:"bucket"`
	Key           string `json:"key"`
	VersionID     string `json:"version_id"`
	SHA256        string `json:"sha256"`
}

type RequestLoaderConfig struct {
	StateID      string
	Role         string
	CandidateID  string
	BucketName   string
	ObjectPrefix string
}

type RequestLoader struct {
	config RequestLoaderConfig
	reader *ImmutableObjectReader
}

type LoadedSigningRequest struct {
	Bytes                     []byte
	MinimumRetentionSatisfied bool
	RequestObject             signingbroker.ImmutableRequestObject
}

func NewRequestLoader(config RequestLoaderConfig, reader *ImmutableObjectReader) (*RequestLoader, error) {
	if !identifierPattern.MatchString(config.StateID) ||
		(config.Role != "snapshot" && config.Role != "timestamp") ||
		(config.CandidateID != "one" && config.CandidateID != "two") ||
		!bucketPattern.MatchString(config.BucketName) {
		return nil, errors.New("signing request loader configuration is invalid")
	}
	expectedPrefix := fmt.Sprintf("tuf-signing-broker/requests/%s/%s-%s/", config.StateID, config.Role, config.CandidateID)
	if config.ObjectPrefix != expectedPrefix {
		return nil, errors.New("signing request loader prefix is not its fixed candidate namespace")
	}
	if reader == nil || reader.config.BucketName != config.BucketName {
		return nil, errors.New("signing request loader requires its fixed-bucket immutable reader")
	}
	return &RequestLoader{config: config, reader: reader}, nil
}

func (loader *RequestLoader) Load(ctx context.Context, invocationBytes []byte) (LoadedSigningRequest, error) {
	if loader == nil || isNil(ctx) || len(invocationBytes) == 0 || len(invocationBytes) > maxInvocationBytes {
		return LoadedSigningRequest{}, errors.New("signing invocation is outside its size limit")
	}
	var invocation SigningInvocation
	if err := strictjson.Decode(invocationBytes, &invocation); err != nil {
		return LoadedSigningRequest{}, fmt.Errorf("decode strict signing invocation: %w", err)
	}
	if invocation.SchemaVersion != SigningInvocationSchema || invocation.Bucket != loader.config.BucketName ||
		!strings.HasPrefix(invocation.Key, loader.config.ObjectPrefix) || !validObjectKey(invocation.Key) ||
		!strings.HasSuffix(invocation.Key, ".json") || !validVersionID(invocation.VersionID) ||
		!sha256Pattern.MatchString(invocation.SHA256) {
		return LoadedSigningRequest{}, errors.New("signing invocation does not select one fixed immutable request object")
	}
	remainder := strings.TrimPrefix(invocation.Key, loader.config.ObjectPrefix)
	if remainder == "" || strings.Contains(remainder, "/") {
		return LoadedSigningRequest{}, errors.New("signing request key must be one file directly beneath its fixed prefix")
	}
	data, minimumRetentionSatisfied, err := loader.reader.ReadForSigningReplay(
		ctx, invocation.Key, invocation.VersionID, invocation.SHA256, signingbroker.MaxRequestBytes, map[string]string{
			"hid-schema": SigningRequestObjectSchema, "hid-state-id": loader.config.StateID,
			"hid-role": loader.config.Role, "hid-candidate": loader.config.CandidateID,
			"hid-sha256": invocation.SHA256,
		})
	if err != nil {
		return LoadedSigningRequest{}, err
	}
	return LoadedSigningRequest{
		Bytes:                     data,
		MinimumRetentionSatisfied: minimumRetentionSatisfied,
		RequestObject: signingbroker.ImmutableRequestObject{
			Bucket: invocation.Bucket, Key: invocation.Key,
			VersionID: invocation.VersionID, SHA256: invocation.SHA256,
		},
	}, nil
}
