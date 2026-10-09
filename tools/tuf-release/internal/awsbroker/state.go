package awsbroker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dynamodbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/repository"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/signingbroker"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/strictjson"
)

const (
	statePointerSchema  = "hid.tuf.signing-broker.state-pointer/v2"
	stateManifestSchema = "hid.tuf.signing-broker.state-manifest/v3"
	stateRecordID       = "checkpoint"
	maxManifestBytes    = 300_000
	maxSafeInteger      = int64(1<<53 - 1)
)

var (
	awsAccountPattern = regexp.MustCompile(`^[0-9]{12}$`)
	bucketPattern     = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
	identifierPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`)
	sha256Pattern     = regexp.MustCompile(`^[0-9a-f]{64}$`)
	kmsKeyARNPattern  = regexp.MustCompile(`^arn:(?:aws|aws-us-gov|aws-cn|aws-iso|aws-iso-b):kms:[a-z0-9][a-z0-9-]{2,31}:[0-9]{12}:key/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$`)
	releaseIDPattern  = regexp.MustCompile(`^r[0-9]{10}-g[0-9a-f]{40}$`)
	versionIDPattern  = regexp.MustCompile(`^[!-~]+$`)
)

// S3Client is the complete S3 surface used by the broker runtime.
type S3Client interface {
	GetObject(context.Context, *s3.GetObjectInput, ...func(*s3.Options)) (*s3.GetObjectOutput, error)
	GetObjectRetention(context.Context, *s3.GetObjectRetentionInput, ...func(*s3.Options)) (*s3.GetObjectRetentionOutput, error)
	PutObject(context.Context, *s3.PutObjectInput, ...func(*s3.Options)) (*s3.PutObjectOutput, error)
}

// DynamoDBClient is the complete DynamoDB surface used by StateStore.
type DynamoDBClient interface {
	GetItem(context.Context, *dynamodb.GetItemInput, ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error)
	UpdateItem(context.Context, *dynamodb.UpdateItemInput, ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error)
}

// StateStoreConfig pins every AWS storage identity and retention property.
// StateObjectPrefix must equal tuf-signing-broker/state/<state-id>/.
type StateStoreConfig struct {
	Environment         string
	RepositoryID        string
	StateID             string
	BootstrapRootSHA256 string
	TableName           string
	BucketName          string
	StateObjectPrefix   string
	ExpectedBucketOwner string
	EncryptionKeyARN    string
	ObjectLockMode      string
	RetentionDays       int
	Clock               func() time.Time
}

// StateStore implements signingbroker.StateStore with immutable S3 bodies and
// a small DynamoDB compare-and-swap pointer. A lost CAS can leave harmless,
// retained orphan blobs but can never authorize their contents.
type StateStore struct {
	config         StateStoreConfig
	s3             S3Client
	dynamodb       DynamoDBClient
	mu             sync.RWMutex
	loadedRevision int64
	loadedManifest []byte
	loadedJournal  blobRef
	refs           map[string]blobRef
}

var _ signingbroker.StateStore = (*StateStore)(nil)

type blobRef struct {
	Version   int64  `json:"version"`
	SHA256    string `json:"sha256"`
	Key       string `json:"key"`
	VersionID string `json:"version_id"`
	Length    int64  `json:"length"`
}

type manifestPendingSnapshot struct {
	CandidateID   string                                `json:"candidate_id"`
	RequestSHA256 string                                `json:"request_sha256"`
	ReleaseID     string                                `json:"release_id"`
	CreatedAt     string                                `json:"created_at"`
	StateRevision int64                                 `json:"state_revision"`
	RequestObject *signingbroker.ImmutableRequestObject `json:"request_object"`
	Root          blobRef                               `json:"root"`
	Targets       blobRef                               `json:"targets"`
	Snapshot      blobRef                               `json:"snapshot"`
}

type manifestPendingTimestamp struct {
	CandidateID   string                                `json:"candidate_id"`
	RequestSHA256 string                                `json:"request_sha256"`
	ReleaseID     string                                `json:"release_id"`
	CreatedAt     string                                `json:"created_at"`
	StateRevision int64                                 `json:"state_revision"`
	RequestObject *signingbroker.ImmutableRequestObject `json:"request_object"`
	Root          blobRef                               `json:"root"`
	Snapshot      blobRef                               `json:"snapshot"`
	Timestamp     blobRef                               `json:"timestamp"`
}

type stateManifest struct {
	SchemaVersion             string                    `json:"schema_version"`
	CheckpointSchema          string                    `json:"checkpoint_schema"`
	Environment               string                    `json:"environment"`
	RepositoryID              string                    `json:"repository_id"`
	StateID                   string                    `json:"state_id"`
	BootstrapRootSHA256       string                    `json:"bootstrap_root_sha256"`
	Revision                  int64                     `json:"revision"`
	PreviousJournal           *blobRef                  `json:"previous_journal,omitempty"`
	ReleaseID                 string                    `json:"release_id"`
	RootHistory               []blobRef                 `json:"root_history"`
	Targets                   blobRef                   `json:"targets"`
	Snapshot                  blobRef                   `json:"snapshot"`
	Timestamp                 blobRef                   `json:"timestamp"`
	SnapshotVersionHighWater  int64                     `json:"snapshot_version_high_water"`
	TimestampVersionHighWater int64                     `json:"timestamp_version_high_water"`
	PendingSnapshot           *manifestPendingSnapshot  `json:"pending_snapshot,omitempty"`
	PendingTimestamp          *manifestPendingTimestamp `json:"pending_timestamp,omitempty"`
}

func NewStateStore(config StateStoreConfig, s3Client S3Client, dynamoClient DynamoDBClient) (*StateStore, error) {
	if err := validateStateStoreConfig(config); err != nil {
		return nil, err
	}
	if isNil(s3Client) || isNil(dynamoClient) {
		return nil, errors.New("AWS broker state clients are required")
	}
	return &StateStore{config: config, s3: s3Client, dynamodb: dynamoClient, refs: make(map[string]blobRef)}, nil
}

func validateStateStoreConfig(config StateStoreConfig) error {
	if config.Environment != "staging" && config.Environment != "production" {
		return errors.New("AWS broker state environment must be staging or production")
	}
	if config.RepositoryID != "hid-"+config.Environment+"-v1" {
		return errors.New("AWS broker state repository ID does not match its environment")
	}
	if !identifierPattern.MatchString(config.StateID) || config.StateID != "hid-"+config.Environment+"-broker-v1" {
		return errors.New("AWS broker state ID is invalid")
	}
	if !sha256Pattern.MatchString(config.BootstrapRootSHA256) {
		return errors.New("AWS broker bootstrap-root pin must be lowercase SHA-256")
	}
	if config.TableName != "hid-"+config.Environment+"-tuf-broker-state" {
		return errors.New("AWS broker state table name does not match its environment")
	}
	if !bucketPattern.MatchString(config.BucketName) || strings.Contains(config.BucketName, "..") {
		return errors.New("AWS broker state bucket name is invalid")
	}
	expectedPrefix := "tuf-signing-broker/state/" + config.StateID + "/"
	if config.StateObjectPrefix != expectedPrefix {
		return errors.New("AWS broker state object prefix is not the fixed state namespace")
	}
	if !awsAccountPattern.MatchString(config.ExpectedBucketOwner) {
		return errors.New("AWS broker expected bucket owner must be a 12-digit account ID")
	}
	if !kmsKeyARNPattern.MatchString(config.EncryptionKeyARN) || !strings.Contains(config.EncryptionKeyARN, ":"+config.ExpectedBucketOwner+":key/") {
		return errors.New("AWS broker state encryption key must be an immutable key in the expected account")
	}
	if config.ObjectLockMode != string(s3types.ObjectLockModeGovernance) && config.ObjectLockMode != string(s3types.ObjectLockModeCompliance) {
		return errors.New("AWS broker state Object Lock mode must be GOVERNANCE or COMPLIANCE")
	}
	if config.RetentionDays != StateRetentionDays {
		return fmt.Errorf("AWS broker state retention days must equal %d", StateRetentionDays)
	}
	if config.Clock == nil || config.Clock().IsZero() {
		return errors.New("AWS broker state clock is required")
	}
	return nil
}

func (store *StateStore) Load(ctx context.Context, stateID string) (signingbroker.Checkpoint, error) {
	if store == nil || isNil(ctx) || stateID != store.config.StateID {
		return signingbroker.Checkpoint{}, errors.New("AWS broker state load context is invalid")
	}
	if err := ctx.Err(); err != nil {
		return signingbroker.Checkpoint{}, err
	}
	output, err := store.dynamodb.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(store.config.TableName),
		ConsistentRead: aws.Bool(true),
		Key: map[string]dynamodbtypes.AttributeValue{
			"state_id":  &dynamodbtypes.AttributeValueMemberS{Value: store.config.StateID},
			"record_id": &dynamodbtypes.AttributeValueMemberS{Value: stateRecordID},
		},
	})
	if err != nil {
		return signingbroker.Checkpoint{}, fmt.Errorf("read broker state pointer: %w", err)
	}
	if output == nil {
		return signingbroker.Checkpoint{}, errors.New("read broker state pointer: DynamoDB returned nil output")
	}
	if len(output.Item) == 0 {
		return signingbroker.Checkpoint{}, signingbroker.ErrStateNotFound
	}
	revision, manifestBytes, journal, err := decodeStateItem(output.Item, store.config.StateID)
	if err != nil {
		return signingbroker.Checkpoint{}, err
	}
	if err := store.validateJournalRef(journal, revision); err != nil {
		return signingbroker.Checkpoint{}, fmt.Errorf("broker state journal reference: %w", err)
	}
	journalBytes, err := store.readLockedObject(
		ctx,
		journal.Key,
		journal.VersionID,
		journal.SHA256,
		journal.Length,
		maxManifestBytes,
		true,
	)
	if err != nil {
		return signingbroker.Checkpoint{}, fmt.Errorf("read exact broker state journal: %w", err)
	}
	if !bytes.Equal(journalBytes, manifestBytes) {
		return signingbroker.Checkpoint{}, errors.New("broker state pointer differs from its immutable journal")
	}
	manifest, err := store.decodeManifest(manifestBytes, revision)
	if err != nil {
		return signingbroker.Checkpoint{}, err
	}
	checkpoint, refs, err := store.resolveManifest(ctx, manifest)
	if err != nil {
		return signingbroker.Checkpoint{}, err
	}
	if err := validateCheckpointHighWaterShape(checkpoint); err != nil {
		return signingbroker.Checkpoint{}, fmt.Errorf("validate resolved broker checkpoint: %w", err)
	}
	store.mu.Lock()
	store.loadedRevision = revision
	store.loadedManifest = bytes.Clone(manifestBytes)
	store.loadedJournal = journal
	store.refs = refs
	store.mu.Unlock()
	return checkpoint, nil
}

func decodeStateItem(item map[string]dynamodbtypes.AttributeValue, stateID string) (int64, []byte, blobRef, error) {
	expected := []string{"state_id", "record_id", "schema_version", "revision", "manifest", "journal"}
	if len(item) != len(expected) {
		return 0, nil, blobRef{}, errors.New("broker state pointer has unexpected attributes")
	}
	for _, name := range expected {
		if _, ok := item[name]; !ok {
			return 0, nil, blobRef{}, fmt.Errorf("broker state pointer omits %s", name)
		}
	}
	stringValue := func(name string) (string, error) {
		value, ok := item[name].(*dynamodbtypes.AttributeValueMemberS)
		if !ok {
			return "", fmt.Errorf("broker state pointer %s is not a string", name)
		}
		return value.Value, nil
	}
	storedState, err := stringValue("state_id")
	if err != nil || storedState != stateID {
		return 0, nil, blobRef{}, errors.New("broker state pointer has the wrong state ID")
	}
	recordID, err := stringValue("record_id")
	if err != nil || recordID != stateRecordID {
		return 0, nil, blobRef{}, errors.New("broker state pointer has the wrong record ID")
	}
	schema, err := stringValue("schema_version")
	if err != nil || schema != statePointerSchema {
		return 0, nil, blobRef{}, errors.New("broker state pointer has the wrong schema")
	}
	revisionValue, ok := item["revision"].(*dynamodbtypes.AttributeValueMemberN)
	if !ok {
		return 0, nil, blobRef{}, errors.New("broker state pointer revision is not numeric")
	}
	revision, err := strconv.ParseInt(revisionValue.Value, 10, 64)
	if err != nil || revision < 1 || revision > maxSafeInteger || strconv.FormatInt(revision, 10) != revisionValue.Value {
		return 0, nil, blobRef{}, errors.New("broker state pointer revision is not a canonical positive safe integer")
	}
	manifest, err := stringValue("manifest")
	if err != nil || len(manifest) == 0 || len(manifest) > maxManifestBytes {
		return 0, nil, blobRef{}, errors.New("broker state pointer manifest is outside its size limit")
	}
	journalValue, err := stringValue("journal")
	if err != nil || len(journalValue) == 0 || len(journalValue) > 4096 {
		return 0, nil, blobRef{}, errors.New("broker state pointer journal reference is outside its size limit")
	}
	var journal blobRef
	if err := strictjson.Decode([]byte(journalValue), &journal); err != nil {
		return 0, nil, blobRef{}, fmt.Errorf("decode strict broker state journal reference: %w", err)
	}
	return revision, []byte(manifest), journal, nil
}

func (store *StateStore) decodeManifest(data []byte, revision int64) (stateManifest, error) {
	var manifest stateManifest
	if err := strictjson.Decode(data, &manifest); err != nil {
		return stateManifest{}, fmt.Errorf("decode strict broker state manifest: %w", err)
	}
	if manifest.SchemaVersion != stateManifestSchema || manifest.CheckpointSchema != signingbroker.CheckpointSchemaVersion ||
		manifest.Environment != store.config.Environment || manifest.RepositoryID != store.config.RepositoryID ||
		manifest.StateID != store.config.StateID || manifest.Revision != revision ||
		manifest.BootstrapRootSHA256 != store.config.BootstrapRootSHA256 || !releaseIDPattern.MatchString(manifest.ReleaseID) {
		return stateManifest{}, errors.New("broker state manifest context is invalid")
	}
	if manifest.SnapshotVersionHighWater < 1 || manifest.SnapshotVersionHighWater > maxSafeInteger ||
		manifest.TimestampVersionHighWater < 1 || manifest.TimestampVersionHighWater > maxSafeInteger {
		return stateManifest{}, errors.New("broker state manifest high-water marks are invalid")
	}
	if len(manifest.RootHistory) == 0 || len(manifest.RootHistory) > signingbroker.MaxRootHistoryRecords {
		return stateManifest{}, errors.New("broker state manifest root history count is invalid")
	}
	if revision == 1 && manifest.PreviousJournal != nil {
		return stateManifest{}, errors.New("genesis broker state manifest has a predecessor journal")
	}
	if revision > 1 {
		if manifest.PreviousJournal == nil {
			return stateManifest{}, errors.New("broker state manifest omits its predecessor journal")
		}
		if err := store.validateJournalRef(*manifest.PreviousJournal, revision-1); err != nil {
			return stateManifest{}, fmt.Errorf("broker state predecessor journal: %w", err)
		}
	}
	return manifest, nil
}

func (store *StateStore) resolveManifest(ctx context.Context, manifest stateManifest) (signingbroker.Checkpoint, map[string]blobRef, error) {
	checkpoint := signingbroker.Checkpoint{
		SchemaVersion: manifest.CheckpointSchema, Environment: manifest.Environment,
		RepositoryID: manifest.RepositoryID, StateID: manifest.StateID,
		BootstrapRootSHA256: manifest.BootstrapRootSHA256, Revision: manifest.Revision,
		ReleaseID:                 manifest.ReleaseID,
		SnapshotVersionHighWater:  manifest.SnapshotVersionHighWater,
		TimestampVersionHighWater: manifest.TimestampVersionHighWater,
	}
	refs := make(map[string]blobRef)
	resolve := func(ref blobRef, maximum int, label string) (signingbroker.MetadataRecord, error) {
		if err := store.validateBlobRef(ref, maximum); err != nil {
			return signingbroker.MetadataRecord{}, fmt.Errorf("%s reference: %w", label, err)
		}
		data, err := store.readLockedObject(ctx, ref.Key, ref.VersionID, ref.SHA256, ref.Length, maximum, true)
		if err != nil {
			return signingbroker.MetadataRecord{}, fmt.Errorf("read %s: %w", label, err)
		}
		refs[recordFingerprint(ref.Version, ref.SHA256, ref.Length)] = ref
		return signingbroker.MetadataRecord{Version: ref.Version, SHA256: ref.SHA256, Bytes: data}, nil
	}
	checkpoint.RootHistory = make([]signingbroker.MetadataRecord, len(manifest.RootHistory))
	for index, ref := range manifest.RootHistory {
		record, err := resolve(ref, repository.MaxRootMetadataBytes, fmt.Sprintf("root history %d", index))
		if err != nil {
			return signingbroker.Checkpoint{}, nil, err
		}
		checkpoint.RootHistory[index] = record
	}
	var err error
	if checkpoint.Targets, err = resolve(manifest.Targets, repository.MaxTargetsMetadataBytes, "current targets"); err != nil {
		return signingbroker.Checkpoint{}, nil, err
	}
	if checkpoint.Snapshot, err = resolve(manifest.Snapshot, repository.MaxSnapshotMetadataBytes, "current snapshot"); err != nil {
		return signingbroker.Checkpoint{}, nil, err
	}
	if checkpoint.Timestamp, err = resolve(manifest.Timestamp, repository.MaxTimestampMetadataBytes, "current timestamp"); err != nil {
		return signingbroker.Checkpoint{}, nil, err
	}
	if pending := manifest.PendingSnapshot; pending != nil {
		if err := store.validateRequestObject(pending.RequestObject, "snapshot", pending.CandidateID, pending.RequestSHA256); err != nil {
			return signingbroker.Checkpoint{}, nil, fmt.Errorf("pending snapshot request source: %w", err)
		}
		resolved := &signingbroker.PendingSnapshot{
			CandidateID: pending.CandidateID, RequestSHA256: pending.RequestSHA256,
			ReleaseID: pending.ReleaseID, CreatedAt: pending.CreatedAt,
			StateRevision: pending.StateRevision,
			RequestObject: cloneRequestObject(pending.RequestObject),
		}
		if resolved.Root, err = resolve(pending.Root, repository.MaxRootMetadataBytes, "pending snapshot root"); err != nil {
			return signingbroker.Checkpoint{}, nil, err
		}
		if resolved.Targets, err = resolve(pending.Targets, repository.MaxTargetsMetadataBytes, "pending snapshot targets"); err != nil {
			return signingbroker.Checkpoint{}, nil, err
		}
		if resolved.Snapshot, err = resolve(pending.Snapshot, repository.MaxSnapshotMetadataBytes, "pending snapshot"); err != nil {
			return signingbroker.Checkpoint{}, nil, err
		}
		checkpoint.PendingSnapshot = resolved
	}
	if pending := manifest.PendingTimestamp; pending != nil {
		if err := store.validateRequestObject(pending.RequestObject, "timestamp", pending.CandidateID, pending.RequestSHA256); err != nil {
			return signingbroker.Checkpoint{}, nil, fmt.Errorf("pending timestamp request source: %w", err)
		}
		resolved := &signingbroker.PendingTimestamp{
			CandidateID: pending.CandidateID, RequestSHA256: pending.RequestSHA256,
			ReleaseID: pending.ReleaseID, CreatedAt: pending.CreatedAt,
			StateRevision: pending.StateRevision,
			RequestObject: cloneRequestObject(pending.RequestObject),
		}
		if resolved.Root, err = resolve(pending.Root, repository.MaxRootMetadataBytes, "pending timestamp root"); err != nil {
			return signingbroker.Checkpoint{}, nil, err
		}
		if resolved.Snapshot, err = resolve(pending.Snapshot, repository.MaxSnapshotMetadataBytes, "pending timestamp snapshot"); err != nil {
			return signingbroker.Checkpoint{}, nil, err
		}
		if resolved.Timestamp, err = resolve(pending.Timestamp, repository.MaxTimestampMetadataBytes, "pending timestamp"); err != nil {
			return signingbroker.Checkpoint{}, nil, err
		}
		checkpoint.PendingTimestamp = resolved
	}
	return checkpoint, refs, nil
}

func (store *StateStore) CompareAndSwap(ctx context.Context, stateID string, expectedRevision int64, checkpoint signingbroker.Checkpoint) error {
	if store == nil || isNil(ctx) || stateID != store.config.StateID || expectedRevision < 0 || expectedRevision >= maxSafeInteger {
		return errors.New("AWS broker state CAS context is invalid")
	}
	if checkpoint.Revision != expectedRevision+1 {
		return errors.New("AWS broker state CAS must advance exactly one revision")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	store.mu.RLock()
	loadedRevision := store.loadedRevision
	loadedManifest := bytes.Clone(store.loadedManifest)
	loadedJournal := store.loadedJournal
	reusable := make(map[string]blobRef, len(store.refs))
	for fingerprint, ref := range store.refs {
		reusable[fingerprint] = ref
	}
	store.mu.RUnlock()
	if expectedRevision > 0 && (loadedRevision != expectedRevision || len(loadedManifest) == 0 ||
		store.validateJournalRef(loadedJournal, expectedRevision) != nil) {
		return signingbroker.ErrStateConflict
	}
	if err := validateCheckpointHighWaterShape(checkpoint); err != nil {
		return err
	}
	if expectedRevision > 0 {
		previousManifest, err := store.decodeManifest(loadedManifest, expectedRevision)
		if err != nil {
			return fmt.Errorf("decode predecessor before decision archival: %w", err)
		}
		if err := validateCheckpointTransition(previousManifest, checkpoint); err != nil {
			return err
		}
		if err := store.ensureManifestDecisions(ctx, previousManifest, loadedJournal); err != nil {
			return err
		}
	} else if err := validateGenesisCheckpoint(checkpoint); err != nil {
		return err
	}
	manifest, nextRefs, err := store.persistCheckpoint(
		ctx,
		checkpoint,
		reusable,
		loadedJournal,
	)
	if err != nil {
		return err
	}
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		return fmt.Errorf("encode broker state manifest: %w", err)
	}
	if len(manifestBytes) == 0 || len(manifestBytes) > maxManifestBytes {
		return errors.New("encoded broker state manifest exceeds the DynamoDB safety limit")
	}
	journal, err := store.writeManifestJournal(ctx, checkpoint.Revision, manifestBytes)
	if err != nil {
		return err
	}
	input, err := store.updateInput(
		expectedRevision,
		checkpoint.Revision,
		loadedManifest,
		loadedJournal,
		manifestBytes,
		journal,
	)
	if err != nil {
		return err
	}
	output, err := store.dynamodb.UpdateItem(ctx, input)
	if err != nil {
		if committed, _ := store.pointerMatches(ctx, checkpoint.Revision, manifestBytes, journal); committed {
			return store.finishCommittedTransition(ctx, manifest, manifestBytes, journal, nextRefs)
		}
		var conflict *dynamodbtypes.ConditionalCheckFailedException
		if errors.As(err, &conflict) {
			return signingbroker.ErrStateConflict
		}
		return fmt.Errorf("conditionally update broker state pointer: %w", err)
	}
	if output == nil {
		return errors.New("conditionally update broker state pointer: DynamoDB returned nil output")
	}
	revision, returnedManifest, returnedJournal, err := decodeStateItem(output.Attributes, store.config.StateID)
	if err != nil || revision != checkpoint.Revision || !bytes.Equal(returnedManifest, manifestBytes) ||
		returnedJournal != journal {
		if committed, _ := store.pointerMatches(ctx, checkpoint.Revision, manifestBytes, journal); committed {
			return store.finishCommittedTransition(ctx, manifest, manifestBytes, journal, nextRefs)
		}
		return errors.New("DynamoDB CAS response did not contain the exact committed broker state")
	}
	return store.finishCommittedTransition(ctx, manifest, manifestBytes, journal, nextRefs)
}

func validateCheckpointHighWaterShape(checkpoint signingbroker.Checkpoint) error {
	if checkpoint.SnapshotVersionHighWater < checkpoint.Snapshot.Version ||
		checkpoint.SnapshotVersionHighWater > maxSafeInteger ||
		checkpoint.TimestampVersionHighWater < checkpoint.Timestamp.Version ||
		checkpoint.TimestampVersionHighWater > maxSafeInteger {
		return errors.New("AWS broker checkpoint high-water marks are invalid")
	}
	if checkpoint.PendingSnapshot == nil {
		if checkpoint.SnapshotVersionHighWater != checkpoint.Snapshot.Version {
			return errors.New("AWS broker snapshot high-water mark requires pending metadata")
		}
	} else if checkpoint.PendingSnapshot.Snapshot.Version != checkpoint.SnapshotVersionHighWater ||
		checkpoint.PendingSnapshot.Snapshot.Version <= checkpoint.Snapshot.Version {
		return errors.New("AWS broker pending snapshot does not equal its high-water mark")
	}
	if checkpoint.PendingTimestamp == nil {
		if checkpoint.TimestampVersionHighWater != checkpoint.Timestamp.Version && checkpoint.PendingSnapshot == nil {
			return errors.New("AWS broker burned timestamp high-water mark requires a replacement snapshot")
		}
	} else if checkpoint.PendingTimestamp.Timestamp.Version != checkpoint.TimestampVersionHighWater ||
		checkpoint.PendingTimestamp.Timestamp.Version <= checkpoint.Timestamp.Version {
		return errors.New("AWS broker pending timestamp does not equal its high-water mark")
	}
	return nil
}

func validateGenesisCheckpoint(checkpoint signingbroker.Checkpoint) error {
	if checkpoint.Revision != 1 || len(checkpoint.RootHistory) != 1 ||
		checkpoint.RootHistory[0].Version != 1 || checkpoint.Targets.Version != 1 ||
		checkpoint.Snapshot.Version != 1 || checkpoint.Timestamp.Version != 1 ||
		checkpoint.SnapshotVersionHighWater != 1 || checkpoint.TimestampVersionHighWater != 1 ||
		checkpoint.PendingSnapshot != nil || checkpoint.PendingTimestamp != nil {
		return errors.New("AWS broker genesis checkpoint must be an all-version-1 published state")
	}
	return nil
}

func validateCheckpointTransition(previous stateManifest, next signingbroker.Checkpoint) error {
	snapshotDelta := next.SnapshotVersionHighWater - previous.SnapshotVersionHighWater
	timestampDelta := next.TimestampVersionHighWater - previous.TimestampVersionHighWater
	if snapshotDelta < 0 || snapshotDelta > 1 || timestampDelta < 0 || timestampDelta > 1 ||
		snapshotDelta+timestampDelta > 1 {
		return errors.New("AWS broker checkpoint high-water transition is not one monotonic role step")
	}
	switch {
	case snapshotDelta == 1:
		return validateSnapshotSigningTransition(previous, next)
	case timestampDelta == 1:
		return validateTimestampSigningTransition(previous, next)
	default:
		return validatePublicationTransition(previous, next)
	}
}

func validateSnapshotSigningTransition(previous stateManifest, next signingbroker.Checkpoint) error {
	if !publishedStateMatchesManifest(next, previous) || next.PendingSnapshot == nil ||
		next.PendingSnapshot.StateRevision != next.Revision || next.PendingTimestamp != nil {
		return errors.New("AWS broker snapshot signing transition changes published state or lacks one new pending decision")
	}
	currentRoot := previous.RootHistory[len(previous.RootHistory)-1]
	previousRoot := currentRoot
	previousTargets := previous.Targets
	if previous.PendingSnapshot != nil {
		previousRoot = previous.PendingSnapshot.Root
		previousTargets = previous.PendingSnapshot.Targets
	}
	if !recordFollowsRecoveryBaseline(currentRoot, previousRoot, next.PendingSnapshot.Root) ||
		!recordFollowsRecoveryBaseline(previous.Targets, previousTargets, next.PendingSnapshot.Targets) {
		return errors.New("AWS broker snapshot recovery skips unpublished root or targets metadata")
	}
	return nil
}

func validateTimestampSigningTransition(previous stateManifest, next signingbroker.Checkpoint) error {
	if !publishedStateMatchesManifest(next, previous) || next.PendingTimestamp == nil ||
		next.PendingTimestamp.StateRevision != next.Revision ||
		!pendingSnapshotMatchesManifest(next.PendingSnapshot, previous.PendingSnapshot) {
		return errors.New("AWS broker timestamp signing transition changes published or pending snapshot state")
	}
	expectedRoot := previous.RootHistory[len(previous.RootHistory)-1]
	expectedSnapshot := previous.Snapshot
	expectedRelease := previous.ReleaseID
	if previous.PendingSnapshot != nil {
		expectedRoot = previous.PendingSnapshot.Root
		expectedSnapshot = previous.PendingSnapshot.Snapshot
		expectedRelease = previous.PendingSnapshot.ReleaseID
	}
	if next.PendingTimestamp.ReleaseID != expectedRelease ||
		!recordMatchesRef(next.PendingTimestamp.Root, expectedRoot) ||
		!recordMatchesRef(next.PendingTimestamp.Snapshot, expectedSnapshot) {
		return errors.New("AWS broker timestamp transition selects an unauthorized snapshot context")
	}
	return nil
}

func validatePublicationTransition(previous stateManifest, next signingbroker.Checkpoint) error {
	if previous.PendingTimestamp == nil || next.PendingSnapshot != nil || next.PendingTimestamp != nil {
		return errors.New("AWS broker no-high-water transition is not a complete pending publication")
	}
	expectedRoot := previous.RootHistory[len(previous.RootHistory)-1]
	expectedTargets := previous.Targets
	expectedSnapshot := previous.Snapshot
	expectedRelease := previous.ReleaseID
	if previous.PendingSnapshot != nil {
		expectedRoot = previous.PendingSnapshot.Root
		expectedTargets = previous.PendingSnapshot.Targets
		expectedSnapshot = previous.PendingSnapshot.Snapshot
		expectedRelease = previous.PendingSnapshot.ReleaseID
	}
	if next.ReleaseID != expectedRelease || !recordMatchesRef(next.Targets, expectedTargets) ||
		!recordMatchesRef(next.Snapshot, expectedSnapshot) ||
		!recordMatchesRef(next.Timestamp, previous.PendingTimestamp.Timestamp) ||
		next.SnapshotVersionHighWater != next.Snapshot.Version ||
		next.TimestampVersionHighWater != next.Timestamp.Version ||
		!publishedRootHistoryMatches(next.RootHistory, previous.RootHistory, expectedRoot) {
		return errors.New("AWS broker publication transition differs from pending authorization")
	}
	return nil
}

func publishedStateMatchesManifest(checkpoint signingbroker.Checkpoint, manifest stateManifest) bool {
	if checkpoint.ReleaseID != manifest.ReleaseID ||
		!recordMatchesRef(checkpoint.Targets, manifest.Targets) ||
		!recordMatchesRef(checkpoint.Snapshot, manifest.Snapshot) ||
		!recordMatchesRef(checkpoint.Timestamp, manifest.Timestamp) ||
		len(checkpoint.RootHistory) != len(manifest.RootHistory) {
		return false
	}
	for index, ref := range manifest.RootHistory {
		if !recordMatchesRef(checkpoint.RootHistory[index], ref) {
			return false
		}
	}
	return true
}

func publishedRootHistoryMatches(records []signingbroker.MetadataRecord, previous []blobRef, expected blobRef) bool {
	if len(previous) == 0 {
		return false
	}
	current := previous[len(previous)-1]
	expectedLength := len(previous)
	if expected.Version == current.Version+1 {
		expectedLength++
	} else if expected != current {
		return false
	}
	if len(records) != expectedLength {
		return false
	}
	for index, ref := range previous {
		if !recordMatchesRef(records[index], ref) {
			return false
		}
	}
	return expectedLength == len(previous) || recordMatchesRef(records[len(records)-1], expected)
}

func recordFollowsRecoveryBaseline(current, previous blobRef, candidate signingbroker.MetadataRecord) bool {
	if recordMatchesRef(candidate, previous) {
		return true
	}
	return previous == current && current.Version < maxSafeInteger && candidate.Version == current.Version+1
}

func recordMatchesRef(record signingbroker.MetadataRecord, ref blobRef) bool {
	return record.Version == ref.Version && record.SHA256 == ref.SHA256 && int64(len(record.Bytes)) == ref.Length
}

func pendingSnapshotMatchesManifest(pending *signingbroker.PendingSnapshot, manifest *manifestPendingSnapshot) bool {
	if pending == nil || manifest == nil {
		return pending == nil && manifest == nil
	}
	return pending.CandidateID == manifest.CandidateID && pending.RequestSHA256 == manifest.RequestSHA256 &&
		pending.ReleaseID == manifest.ReleaseID && pending.CreatedAt == manifest.CreatedAt &&
		pending.StateRevision == manifest.StateRevision && pending.RequestObject != nil &&
		manifest.RequestObject != nil && *pending.RequestObject == *manifest.RequestObject &&
		recordMatchesRef(pending.Root, manifest.Root) && recordMatchesRef(pending.Targets, manifest.Targets) &&
		recordMatchesRef(pending.Snapshot, manifest.Snapshot)
}

func (store *StateStore) finishCommittedTransition(
	ctx context.Context,
	manifest stateManifest,
	manifestBytes []byte,
	journal blobRef,
	refs map[string]blobRef,
) error {
	store.recordCommitted(manifest.Revision, manifestBytes, journal, refs)
	if err := store.ensureManifestDecisions(ctx, manifest, journal); err != nil {
		return err
	}
	return nil
}

func (store *StateStore) pointerMatches(
	ctx context.Context,
	revision int64,
	manifest []byte,
	journal blobRef,
) (bool, error) {
	output, err := store.dynamodb.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(store.config.TableName),
		ConsistentRead: aws.Bool(true),
		Key: map[string]dynamodbtypes.AttributeValue{
			"state_id":  &dynamodbtypes.AttributeValueMemberS{Value: store.config.StateID},
			"record_id": &dynamodbtypes.AttributeValueMemberS{Value: stateRecordID},
		},
	})
	if err != nil {
		return false, fmt.Errorf("reconcile broker state pointer: %w", err)
	}
	if output == nil || len(output.Item) == 0 {
		return false, nil
	}
	storedRevision, storedManifest, storedJournal, err := decodeStateItem(output.Item, store.config.StateID)
	if err != nil {
		return false, err
	}
	return storedRevision == revision && bytes.Equal(storedManifest, manifest) && storedJournal == journal, nil
}

func (store *StateStore) recordCommitted(
	revision int64,
	manifest []byte,
	journal blobRef,
	refs map[string]blobRef,
) {
	store.mu.Lock()
	store.loadedRevision = revision
	store.loadedManifest = bytes.Clone(manifest)
	store.loadedJournal = journal
	store.refs = refs
	store.mu.Unlock()
}

func (store *StateStore) updateInput(
	expectedRevision int64,
	nextRevision int64,
	expectedManifest []byte,
	expectedJournal blobRef,
	manifest []byte,
	journal blobRef,
) (*dynamodb.UpdateItemInput, error) {
	condition := "attribute_not_exists(#state) AND attribute_not_exists(#record) AND attribute_not_exists(#revision) AND attribute_not_exists(#manifest) AND attribute_not_exists(#journal) AND attribute_not_exists(#schema)"
	journalBytes, err := json.Marshal(journal)
	if err != nil {
		return nil, fmt.Errorf("encode broker state journal reference: %w", err)
	}
	values := map[string]dynamodbtypes.AttributeValue{
		":schema":   &dynamodbtypes.AttributeValueMemberS{Value: statePointerSchema},
		":next":     &dynamodbtypes.AttributeValueMemberN{Value: strconv.FormatInt(nextRevision, 10)},
		":manifest": &dynamodbtypes.AttributeValueMemberS{Value: string(manifest)},
		":journal":  &dynamodbtypes.AttributeValueMemberS{Value: string(journalBytes)},
	}
	if expectedRevision > 0 {
		condition = "#schema = :schema AND #revision = :expected AND #manifest = :expected_manifest AND #journal = :expected_journal"
		expectedJournalBytes, err := json.Marshal(expectedJournal)
		if err != nil {
			return nil, fmt.Errorf("encode predecessor journal reference: %w", err)
		}
		values[":expected"] = &dynamodbtypes.AttributeValueMemberN{Value: strconv.FormatInt(expectedRevision, 10)}
		values[":expected_manifest"] = &dynamodbtypes.AttributeValueMemberS{Value: string(expectedManifest)}
		values[":expected_journal"] = &dynamodbtypes.AttributeValueMemberS{Value: string(expectedJournalBytes)}
	}
	return &dynamodb.UpdateItemInput{
		TableName: aws.String(store.config.TableName),
		Key: map[string]dynamodbtypes.AttributeValue{
			"state_id":  &dynamodbtypes.AttributeValueMemberS{Value: store.config.StateID},
			"record_id": &dynamodbtypes.AttributeValueMemberS{Value: stateRecordID},
		},
		ConditionExpression: aws.String(condition),
		ExpressionAttributeNames: map[string]string{
			"#state": "state_id", "#record": "record_id", "#schema": "schema_version",
			"#revision": "revision", "#manifest": "manifest", "#journal": "journal",
		},
		ExpressionAttributeValues: values,
		UpdateExpression:          aws.String("SET #schema = :schema, #revision = :next, #manifest = :manifest, #journal = :journal"),
		ReturnValues:              dynamodbtypes.ReturnValueAllNew,
	}, nil
}

func (store *StateStore) persistCheckpoint(
	ctx context.Context,
	checkpoint signingbroker.Checkpoint,
	reusable map[string]blobRef,
	previousJournal blobRef,
) (stateManifest, map[string]blobRef, error) {
	if checkpoint.SchemaVersion != signingbroker.CheckpointSchemaVersion || checkpoint.Environment != store.config.Environment ||
		checkpoint.RepositoryID != store.config.RepositoryID || checkpoint.StateID != store.config.StateID ||
		checkpoint.BootstrapRootSHA256 != store.config.BootstrapRootSHA256 || !releaseIDPattern.MatchString(checkpoint.ReleaseID) ||
		len(checkpoint.RootHistory) == 0 || len(checkpoint.RootHistory) > signingbroker.MaxRootHistoryRecords {
		return stateManifest{}, nil, errors.New("checkpoint context is invalid for AWS persistence")
	}
	if pending := checkpoint.PendingSnapshot; pending != nil {
		if pending.StateRevision < 1 || pending.StateRevision > checkpoint.Revision {
			return stateManifest{}, nil, errors.New("pending snapshot state revision is invalid")
		}
		if err := store.validateRequestObject(pending.RequestObject, "snapshot", pending.CandidateID, pending.RequestSHA256); err != nil {
			return stateManifest{}, nil, fmt.Errorf("pending snapshot request source: %w", err)
		}
	}
	if pending := checkpoint.PendingTimestamp; pending != nil {
		if pending.StateRevision < 1 || pending.StateRevision > checkpoint.Revision {
			return stateManifest{}, nil, errors.New("pending timestamp state revision is invalid")
		}
		if err := store.validateRequestObject(pending.RequestObject, "timestamp", pending.CandidateID, pending.RequestSHA256); err != nil {
			return stateManifest{}, nil, fmt.Errorf("pending timestamp request source: %w", err)
		}
	}
	nextRefs := make(map[string]blobRef, len(reusable)+8)
	for fingerprint, ref := range reusable {
		nextRefs[fingerprint] = ref
	}
	persist := func(record signingbroker.MetadataRecord, maximum int, label string) (blobRef, error) {
		if record.Version < 1 || record.Version > maxSafeInteger || !sha256Pattern.MatchString(record.SHA256) ||
			len(record.Bytes) == 0 || len(record.Bytes) > maximum || digestHex(record.Bytes) != record.SHA256 {
			return blobRef{}, fmt.Errorf("%s record is invalid", label)
		}
		fingerprint := recordFingerprint(record.Version, record.SHA256, int64(len(record.Bytes)))
		if ref, ok := reusable[fingerprint]; ok {
			if err := store.validateBlobRef(ref, maximum); err != nil {
				return blobRef{}, fmt.Errorf("reusable %s reference: %w", label, err)
			}
			return ref, nil
		}
		if ref, ok := nextRefs[fingerprint]; ok {
			return ref, nil
		}
		ref, err := store.writeLockedObject(ctx, checkpoint.Revision, label, record)
		if err != nil {
			return blobRef{}, err
		}
		nextRefs[fingerprint] = ref
		return ref, nil
	}
	manifest := stateManifest{
		SchemaVersion: stateManifestSchema, CheckpointSchema: checkpoint.SchemaVersion,
		Environment: checkpoint.Environment, RepositoryID: checkpoint.RepositoryID,
		StateID: checkpoint.StateID, BootstrapRootSHA256: checkpoint.BootstrapRootSHA256,
		Revision: checkpoint.Revision, ReleaseID: checkpoint.ReleaseID,
		SnapshotVersionHighWater:  checkpoint.SnapshotVersionHighWater,
		TimestampVersionHighWater: checkpoint.TimestampVersionHighWater,
		RootHistory:               make([]blobRef, len(checkpoint.RootHistory)),
	}
	if checkpoint.Revision > 1 {
		if err := store.validateJournalRef(previousJournal, checkpoint.Revision-1); err != nil {
			return stateManifest{}, nil, fmt.Errorf("checkpoint predecessor journal: %w", err)
		}
		manifest.PreviousJournal = &previousJournal
	}
	for index, record := range checkpoint.RootHistory {
		ref, err := persist(record, repository.MaxRootMetadataBytes, fmt.Sprintf("root-%06d", index+1))
		if err != nil {
			return stateManifest{}, nil, err
		}
		manifest.RootHistory[index] = ref
	}
	var err error
	if manifest.Targets, err = persist(checkpoint.Targets, repository.MaxTargetsMetadataBytes, "targets"); err != nil {
		return stateManifest{}, nil, err
	}
	if manifest.Snapshot, err = persist(checkpoint.Snapshot, repository.MaxSnapshotMetadataBytes, "snapshot"); err != nil {
		return stateManifest{}, nil, err
	}
	if manifest.Timestamp, err = persist(checkpoint.Timestamp, repository.MaxTimestampMetadataBytes, "timestamp"); err != nil {
		return stateManifest{}, nil, err
	}
	if pending := checkpoint.PendingSnapshot; pending != nil {
		value := &manifestPendingSnapshot{
			CandidateID: pending.CandidateID, RequestSHA256: pending.RequestSHA256,
			ReleaseID: pending.ReleaseID, CreatedAt: pending.CreatedAt,
			StateRevision: pending.StateRevision,
			RequestObject: cloneRequestObject(pending.RequestObject),
		}
		if value.Root, err = persist(pending.Root, repository.MaxRootMetadataBytes, "pending-snapshot-root"); err != nil {
			return stateManifest{}, nil, err
		}
		if value.Targets, err = persist(pending.Targets, repository.MaxTargetsMetadataBytes, "pending-snapshot-targets"); err != nil {
			return stateManifest{}, nil, err
		}
		if value.Snapshot, err = persist(pending.Snapshot, repository.MaxSnapshotMetadataBytes, "pending-snapshot"); err != nil {
			return stateManifest{}, nil, err
		}
		manifest.PendingSnapshot = value
	}
	if pending := checkpoint.PendingTimestamp; pending != nil {
		value := &manifestPendingTimestamp{
			CandidateID: pending.CandidateID, RequestSHA256: pending.RequestSHA256,
			ReleaseID: pending.ReleaseID, CreatedAt: pending.CreatedAt,
			StateRevision: pending.StateRevision,
			RequestObject: cloneRequestObject(pending.RequestObject),
		}
		if value.Root, err = persist(pending.Root, repository.MaxRootMetadataBytes, "pending-timestamp-root"); err != nil {
			return stateManifest{}, nil, err
		}
		if value.Snapshot, err = persist(pending.Snapshot, repository.MaxSnapshotMetadataBytes, "pending-timestamp-snapshot"); err != nil {
			return stateManifest{}, nil, err
		}
		if value.Timestamp, err = persist(pending.Timestamp, repository.MaxTimestampMetadataBytes, "pending-timestamp"); err != nil {
			return stateManifest{}, nil, err
		}
		manifest.PendingTimestamp = value
	}
	return manifest, nextRefs, nil
}

func (store *StateStore) writeManifestJournal(
	ctx context.Context,
	revision int64,
	manifest []byte,
) (blobRef, error) {
	if revision < 1 || revision > maxSafeInteger || len(manifest) == 0 || len(manifest) > maxManifestBytes {
		return blobRef{}, errors.New("broker state journal input is invalid")
	}
	hash := digestHex(manifest)
	key := fmt.Sprintf(
		"%smanifests/%d-%s.json",
		store.config.StateObjectPrefix,
		revision,
		hash,
	)
	checksumBytes, err := hex.DecodeString(hash)
	if err != nil {
		return blobRef{}, errors.New("decode broker state journal SHA-256")
	}
	checksum := base64.StdEncoding.EncodeToString(checksumBytes)
	now := store.config.Clock().UTC().Truncate(time.Second)
	if now.IsZero() {
		return blobRef{}, errors.New("AWS broker state clock returned zero")
	}
	retainUntil := now.Add(time.Duration(store.config.RetentionDays) * 24 * time.Hour)
	output, err := store.s3.PutObject(ctx, &s3.PutObjectInput{
		Bucket:                    aws.String(store.config.BucketName),
		Key:                       aws.String(key),
		Body:                      bytes.NewReader(manifest),
		ContentLength:             aws.Int64(int64(len(manifest))),
		ContentType:               aws.String("application/json"),
		ExpectedBucketOwner:       aws.String(store.config.ExpectedBucketOwner),
		ChecksumAlgorithm:         s3types.ChecksumAlgorithmSha256,
		ChecksumSHA256:            aws.String(checksum),
		ServerSideEncryption:      s3types.ServerSideEncryptionAwsKms,
		SSEKMSKeyId:               aws.String(store.config.EncryptionKeyARN),
		ObjectLockMode:            s3types.ObjectLockMode(store.config.ObjectLockMode),
		ObjectLockRetainUntilDate: aws.Time(retainUntil),
		Metadata: map[string]string{
			"hid-schema": stateManifestSchema, "hid-state-id": store.config.StateID,
			"hid-sha256": hash, "hid-revision": strconv.FormatInt(revision, 10),
		},
	})
	if err != nil {
		return blobRef{}, fmt.Errorf("write immutable broker state journal: %w", err)
	}
	if output == nil || !validVersionID(aws.ToString(output.VersionId)) ||
		output.ServerSideEncryption != s3types.ServerSideEncryptionAwsKms ||
		aws.ToString(output.SSEKMSKeyId) != store.config.EncryptionKeyARN ||
		aws.ToString(output.ChecksumSHA256) != checksum {
		return blobRef{}, errors.New("write immutable broker state journal: S3 response violated the storage contract")
	}
	ref := blobRef{
		Version: revision, SHA256: hash, Key: key,
		VersionID: aws.ToString(output.VersionId), Length: int64(len(manifest)),
	}
	if err := store.verifyRetention(ctx, ref.Key, ref.VersionID, retainUntil); err != nil {
		return blobRef{}, fmt.Errorf("confirm immutable broker state journal retention: %w", err)
	}
	return ref, nil
}

func (store *StateStore) validateJournalRef(ref blobRef, expectedRevision int64) error {
	if ref.Version != expectedRevision || expectedRevision < 1 || expectedRevision > maxSafeInteger ||
		!sha256Pattern.MatchString(ref.SHA256) || ref.Length < 1 || ref.Length > maxManifestBytes ||
		!validVersionID(ref.VersionID) || !validObjectKey(ref.Key) {
		return errors.New("immutable journal reference is invalid")
	}
	expectedKey := fmt.Sprintf(
		"%smanifests/%d-%s.json",
		store.config.StateObjectPrefix,
		expectedRevision,
		ref.SHA256,
	)
	if ref.Key != expectedKey {
		return errors.New("immutable journal reference path does not bind its revision and hash")
	}
	return nil
}

func (store *StateStore) validateRequestObject(
	object *signingbroker.ImmutableRequestObject,
	role string,
	candidateID string,
	requestSHA256 string,
) error {
	if (role != "snapshot" && role != "timestamp") || (candidateID != "one" && candidateID != "two") ||
		object == nil || object.Bucket != store.config.BucketName || !sha256Pattern.MatchString(requestSHA256) ||
		object.SHA256 != requestSHA256 || !validVersionID(object.VersionID) || !validObjectKey(object.Key) ||
		!strings.HasSuffix(object.Key, ".json") {
		return errors.New("immutable request reference is invalid")
	}
	expectedPrefix := fmt.Sprintf(
		"tuf-signing-broker/requests/%s/%s-%s/",
		store.config.StateID,
		role,
		candidateID,
	)
	if !strings.HasPrefix(object.Key, expectedPrefix) {
		return errors.New("immutable request reference is outside its fixed candidate namespace")
	}
	remainder := strings.TrimPrefix(object.Key, expectedPrefix)
	if remainder == "" || strings.Contains(remainder, "/") {
		return errors.New("immutable request reference is not one direct file")
	}
	return nil
}

func cloneRequestObject(object *signingbroker.ImmutableRequestObject) *signingbroker.ImmutableRequestObject {
	if object == nil {
		return nil
	}
	cloned := *object
	return &cloned
}

func (store *StateStore) validateBlobRef(ref blobRef, maximum int) error {
	if ref.Version < 1 || ref.Version > maxSafeInteger || !sha256Pattern.MatchString(ref.SHA256) ||
		ref.Length < 1 || ref.Length > int64(maximum) || !validVersionID(ref.VersionID) ||
		!strings.HasPrefix(ref.Key, store.config.StateObjectPrefix) || len(ref.Key) > 1024 ||
		strings.Contains(ref.Key, "//") || strings.Contains(ref.Key, "/../") || !strings.HasSuffix(ref.Key, ".json") {
		return errors.New("immutable blob reference is invalid")
	}
	remainder := strings.TrimPrefix(ref.Key, store.config.StateObjectPrefix)
	parts := strings.Split(remainder, "/")
	if len(parts) != 3 || parts[0] != "revisions" {
		return errors.New("immutable blob reference is outside a canonical revision path")
	}
	revision, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || revision < 1 || revision > maxSafeInteger || strconv.FormatInt(revision, 10) != parts[1] ||
		!strings.HasSuffix(parts[2], fmt.Sprintf("-v%d-%s.json", ref.Version, ref.SHA256)) {
		return errors.New("immutable blob reference path does not bind its revision, version, and hash")
	}
	return nil
}

func (store *StateStore) writeLockedObject(ctx context.Context, revision int64, label string, record signingbroker.MetadataRecord) (blobRef, error) {
	key := fmt.Sprintf("%srevisions/%d/%s-v%d-%s.json", store.config.StateObjectPrefix, revision, label, record.Version, record.SHA256)
	checksumBytes, err := hex.DecodeString(record.SHA256)
	if err != nil {
		return blobRef{}, errors.New("decode state blob SHA-256")
	}
	checksum := base64.StdEncoding.EncodeToString(checksumBytes)
	now := store.config.Clock().UTC().Truncate(time.Second)
	if now.IsZero() {
		return blobRef{}, errors.New("AWS broker state clock returned zero")
	}
	retainUntil := now.Add(time.Duration(store.config.RetentionDays) * 24 * time.Hour)
	output, err := store.s3.PutObject(ctx, &s3.PutObjectInput{
		Bucket:                    aws.String(store.config.BucketName),
		Key:                       aws.String(key),
		Body:                      bytes.NewReader(record.Bytes),
		ContentLength:             aws.Int64(int64(len(record.Bytes))),
		ContentType:               aws.String("application/json"),
		ExpectedBucketOwner:       aws.String(store.config.ExpectedBucketOwner),
		ChecksumAlgorithm:         s3types.ChecksumAlgorithmSha256,
		ChecksumSHA256:            aws.String(checksum),
		ServerSideEncryption:      s3types.ServerSideEncryptionAwsKms,
		SSEKMSKeyId:               aws.String(store.config.EncryptionKeyARN),
		ObjectLockMode:            s3types.ObjectLockMode(store.config.ObjectLockMode),
		ObjectLockRetainUntilDate: aws.Time(retainUntil),
		Metadata: map[string]string{
			"hid-schema": stateManifestSchema, "hid-state-id": store.config.StateID,
			"hid-sha256": record.SHA256, "hid-revision": strconv.FormatInt(revision, 10),
		},
	})
	if err != nil {
		return blobRef{}, fmt.Errorf("write immutable state blob %s: %w", label, err)
	}
	if output == nil || !validVersionID(aws.ToString(output.VersionId)) ||
		output.ServerSideEncryption != s3types.ServerSideEncryptionAwsKms ||
		aws.ToString(output.SSEKMSKeyId) != store.config.EncryptionKeyARN || aws.ToString(output.ChecksumSHA256) != checksum {
		return blobRef{}, fmt.Errorf("write immutable state blob %s: S3 response violated the storage contract", label)
	}
	ref := blobRef{Version: record.Version, SHA256: record.SHA256, Key: key, VersionID: aws.ToString(output.VersionId), Length: int64(len(record.Bytes))}
	if err := store.verifyRetention(ctx, ref.Key, ref.VersionID, retainUntil); err != nil {
		return blobRef{}, fmt.Errorf("confirm immutable state blob %s retention: %w", label, err)
	}
	return ref, nil
}

func (store *StateStore) readLockedObject(ctx context.Context, key, versionID, expectedSHA string, expectedLength int64, maximum int, requireStateMetadata bool) ([]byte, error) {
	if err := store.verifyRetention(ctx, key, versionID, time.Time{}); err != nil {
		return nil, err
	}
	output, err := store.s3.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(store.config.BucketName), Key: aws.String(key), VersionId: aws.String(versionID),
		ExpectedBucketOwner: aws.String(store.config.ExpectedBucketOwner), ChecksumMode: s3types.ChecksumModeEnabled,
	})
	if err != nil {
		return nil, fmt.Errorf("get exact immutable S3 version: %w", err)
	}
	if output == nil || output.Body == nil {
		return nil, errors.New("get exact immutable S3 version returned no body")
	}
	if aws.ToString(output.VersionId) != versionID || aws.ToInt64(output.ContentLength) != expectedLength ||
		expectedLength < 1 || expectedLength > int64(maximum) || output.DeleteMarker != nil && *output.DeleteMarker ||
		output.ServerSideEncryption != s3types.ServerSideEncryptionAwsKms || aws.ToString(output.SSEKMSKeyId) != store.config.EncryptionKeyARN ||
		aws.ToString(output.ContentEncoding) != "" {
		_ = output.Body.Close()
		return nil, errors.New("immutable S3 object response violated version, length, or encryption policy")
	}
	if output.ContentType == nil || *output.ContentType != "application/json" {
		_ = output.Body.Close()
		return nil, errors.New("immutable S3 object is not application/json")
	}
	checksumBytes, err := hex.DecodeString(expectedSHA)
	if err != nil || output.ChecksumSHA256 == nil || *output.ChecksumSHA256 != base64.StdEncoding.EncodeToString(checksumBytes) {
		_ = output.Body.Close()
		return nil, errors.New("immutable S3 object service checksum is missing or differs")
	}
	if requireStateMetadata {
		expectedMetadata := map[string]string{
			"hid-schema": stateManifestSchema, "hid-state-id": store.config.StateID, "hid-sha256": expectedSHA,
		}
		if len(output.Metadata) != 4 {
			_ = output.Body.Close()
			return nil, errors.New("immutable S3 state object has unexpected metadata")
		}
		for name, value := range expectedMetadata {
			if output.Metadata[name] != value {
				_ = output.Body.Close()
				return nil, fmt.Errorf("immutable S3 state object metadata %s differs", name)
			}
		}
		revision, ok := store.stateObjectRevision(key)
		if !ok || output.Metadata["hid-revision"] != revision {
			_ = output.Body.Close()
			return nil, errors.New("immutable S3 state object revision metadata differs")
		}
	}
	data, err := io.ReadAll(io.LimitReader(output.Body, int64(maximum)+1))
	closeErr := output.Body.Close()
	if err != nil {
		return nil, fmt.Errorf("read immutable S3 object: %w", err)
	}
	if closeErr != nil {
		return nil, fmt.Errorf("close immutable S3 object: %w", closeErr)
	}
	if int64(len(data)) != expectedLength || len(data) > maximum || digestHex(data) != expectedSHA {
		return nil, errors.New("immutable S3 object bytes differ from their manifest")
	}
	return data, nil
}

func (store *StateStore) stateObjectRevision(key string) (string, bool) {
	remainder := strings.TrimPrefix(key, store.config.StateObjectPrefix)
	if remainder == key {
		return "", false
	}
	parts := strings.Split(remainder, "/")
	if len(parts) == 3 && parts[0] == "revisions" {
		return parts[1], true
	}
	if len(parts) == 2 && parts[0] == "manifests" {
		revision, _, found := strings.Cut(parts[1], "-")
		if !found || revision == "" {
			return "", false
		}
		return revision, true
	}
	return "", false
}

func (store *StateStore) verifyRetention(ctx context.Context, key, versionID string, minimum time.Time) error {
	output, err := store.s3.GetObjectRetention(ctx, &s3.GetObjectRetentionInput{
		Bucket: aws.String(store.config.BucketName), Key: aws.String(key), VersionId: aws.String(versionID),
		ExpectedBucketOwner: aws.String(store.config.ExpectedBucketOwner),
	})
	if err != nil {
		return fmt.Errorf("get exact S3 Object Lock retention: %w", err)
	}
	now := store.config.Clock().UTC().Truncate(time.Second)
	if output == nil || output.Retention == nil || string(output.Retention.Mode) != store.config.ObjectLockMode ||
		output.Retention.RetainUntilDate == nil || !output.Retention.RetainUntilDate.After(now) {
		return errors.New("immutable S3 object has no active fixed-mode retention")
	}
	if !minimum.IsZero() && output.Retention.RetainUntilDate.Before(minimum) {
		return errors.New("immutable S3 object retention is shorter than requested")
	}
	return nil
}

func recordFingerprint(version int64, hash string, length int64) string {
	return strconv.FormatInt(version, 10) + ":" + hash + ":" + strconv.FormatInt(length, 10)
}

func digestHex(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func validVersionID(value string) bool {
	return len(value) >= 1 && len(value) <= 1024 && value != "null" &&
		versionIDPattern.MatchString(value) && !strings.ContainsAny(value, "\\\"")
}

func isNil(value any) bool {
	if value == nil {
		return true
	}
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return reflected.IsNil()
	default:
		return false
	}
}
