// Package signingbroker implements the provider-neutral, state-pinned policy
// boundary for HID snapshot and timestamp signing. Persistence and remote
// signing are interfaces so the policy can be tested without credentials.
package signingbroker

import (
	"context"
	"errors"
	"time"

	"github.com/sigstore/sigstore/pkg/signature"
)

const (
	SchemaVersion           = "1.0.0"
	CheckpointSchemaVersion = "2.0.0"
	MaxRequestBytes         = 8 << 20
	MaxRootHistoryRecords   = 128
)

var (
	ErrStateNotFound    = errors.New("signing-broker state not found")
	ErrStateConflict    = errors.New("signing-broker state revision conflict")
	ErrDecisionNotFound = errors.New("signing-broker completed decision not found")
	ErrPending          = errors.New("signing-broker publication is already pending")
)

type Config struct {
	Environment             string
	RepositoryID            string
	StateID                 string
	Role                    string
	CandidateID             string
	KMSKeyARN               string
	KMSPublicKeyDERChecksum string
	BootstrapRootSHA256     string
	RequestBucketName       string
	RequestObjectPrefix     string
}

type PublicationConfig struct {
	Environment         string
	RepositoryID        string
	StateID             string
	BootstrapRootSHA256 string
}

type SignerConfig struct {
	KeyARN               string
	PublicKeyDERChecksum string
}

type SignerFactory interface {
	NewSigner(context.Context, SignerConfig) (signature.Signer, error)
}

// StateStore resolves any external immutable blob references before returning
// a Checkpoint. An AWS adapter should store large metadata in immutable S3
// versions and keep only authenticated references/revisions in DynamoDB.
type StateStore interface {
	Load(context.Context, string) (Checkpoint, error)
	CompareAndSwap(context.Context, string, int64, Checkpoint) error
}

// CompletedDecisionStore preserves exact request-to-output decisions after a
// publication checkpoint consumes pending state. Production brokers require
// this extension so retries can never create a second output version.
type CompletedDecisionStore interface {
	LoadCompletedDecision(context.Context, DecisionLookup) (CompletedDecision, error)
}

type DecisionLookup struct {
	StateID       string
	Role          string
	CandidateID   string
	RequestSHA256 string
	RequestObject *ImmutableRequestObject
}

type CompletedDecision struct {
	Role          string
	CandidateID   string
	RequestSHA256 string
	RequestObject *ImmutableRequestObject
	ReleaseID     string
	CreatedAt     string
	Root          MetadataRecord
	Input         MetadataRecord
	Output        MetadataRecord
	StateRevision int64
}

type Request struct {
	SchemaVersion        string `json:"schema_version"`
	Environment          string `json:"environment"`
	RepositoryID         string `json:"repository_id"`
	Role                 string `json:"role"`
	ReleaseID            string `json:"release_id"`
	CreatedAt            string `json:"created_at"`
	Expires              string `json:"expires"`
	RootVersion          int64  `json:"root_version"`
	RootSHA256           string `json:"root_sha256"`
	RootBytes            []byte `json:"root"`
	InputMetadataVersion int64  `json:"input_metadata_version"`
	InputMetadataSHA256  string `json:"input_metadata_sha256"`
	InputMetadataBytes   []byte `json:"input_metadata"`
}

type MetadataRecord struct {
	Version int64  `json:"version"`
	SHA256  string `json:"sha256"`
	Bytes   []byte `json:"bytes"`
}

// ImmutableRequestObject binds a broker decision to the exact versioned S3
// object whose storage envelope the AWS adapter authenticated.
type ImmutableRequestObject struct {
	Bucket    string `json:"bucket"`
	Key       string `json:"key"`
	VersionID string `json:"version_id"`
	SHA256    string `json:"sha256"`
}

type PendingSnapshot struct {
	CandidateID   string                  `json:"candidate_id"`
	RequestSHA256 string                  `json:"request_sha256"`
	ReleaseID     string                  `json:"release_id"`
	CreatedAt     string                  `json:"created_at"`
	StateRevision int64                   `json:"state_revision"`
	RequestObject *ImmutableRequestObject `json:"request_object,omitempty"`
	Root          MetadataRecord          `json:"root"`
	Targets       MetadataRecord          `json:"targets"`
	Snapshot      MetadataRecord          `json:"snapshot"`
}

type PendingTimestamp struct {
	CandidateID   string                  `json:"candidate_id"`
	RequestSHA256 string                  `json:"request_sha256"`
	ReleaseID     string                  `json:"release_id"`
	CreatedAt     string                  `json:"created_at"`
	StateRevision int64                   `json:"state_revision"`
	RequestObject *ImmutableRequestObject `json:"request_object,omitempty"`
	Root          MetadataRecord          `json:"root"`
	Snapshot      MetadataRecord          `json:"snapshot"`
	Timestamp     MetadataRecord          `json:"timestamp"`
}

type Checkpoint struct {
	SchemaVersion             string            `json:"schema_version"`
	Environment               string            `json:"environment"`
	RepositoryID              string            `json:"repository_id"`
	StateID                   string            `json:"state_id"`
	BootstrapRootSHA256       string            `json:"bootstrap_root_sha256"`
	Revision                  int64             `json:"revision"`
	ReleaseID                 string            `json:"release_id"`
	RootHistory               []MetadataRecord  `json:"root_history"`
	Targets                   MetadataRecord    `json:"targets"`
	Snapshot                  MetadataRecord    `json:"snapshot"`
	Timestamp                 MetadataRecord    `json:"timestamp"`
	SnapshotVersionHighWater  int64             `json:"snapshot_version_high_water"`
	TimestampVersionHighWater int64             `json:"timestamp_version_high_water"`
	PendingSnapshot           *PendingSnapshot  `json:"pending_snapshot,omitempty"`
	PendingTimestamp          *PendingTimestamp `json:"pending_timestamp,omitempty"`
}

type Result struct {
	SchemaVersion        string                  `json:"schema_version"`
	Environment          string                  `json:"environment"`
	RepositoryID         string                  `json:"repository_id"`
	StateID              string                  `json:"state_id"`
	Role                 string                  `json:"role"`
	CandidateID          string                  `json:"candidate_id"`
	ReleaseID            string                  `json:"release_id"`
	RequestSHA256        string                  `json:"request_sha256"`
	RequestObject        *ImmutableRequestObject `json:"request_object,omitempty"`
	RootVersion          int64                   `json:"root_version"`
	RootSHA256           string                  `json:"root_sha256"`
	InputMetadataVersion int64                   `json:"input_metadata_version"`
	InputMetadataSHA256  string                  `json:"input_metadata_sha256"`
	OutputVersion        int64                   `json:"output_version"`
	OutputSHA256         string                  `json:"output_sha256"`
	OutputBytes          []byte                  `json:"output"`
	StateRevision        int64                   `json:"state_revision"`
	IdempotentReplay     bool                    `json:"idempotent_replay"`
}

type PublishedGeneration struct {
	Environment    string
	ReleaseID      string
	RootBytes      []byte
	TargetsBytes   []byte
	SnapshotBytes  []byte
	TimestampBytes []byte
}

type Broker struct {
	config    Config
	store     StateStore
	decisions CompletedDecisionStore
	signers   SignerFactory
	now       func() time.Time
}

type PublicationController struct {
	config PublicationConfig
	store  StateStore
	now    func() time.Time
}

type fixedTrustConfig struct {
	environment         string
	repositoryID        string
	stateID             string
	bootstrapRootSHA256 string
}
