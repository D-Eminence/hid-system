package awsbroker

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/publicationjournal"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/strictjson"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dynamotypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

const (
	publicationJournalSchema       = "hid.tuf.publication-journal/v1"
	publicationHeadSchema          = "hid.tuf.publication-head/v1"
	publicationRecordID            = "publication-head"
	maxPublicationEntryBytes       = 64000
	maxPublicationRevisions  int64 = 8192
)

type PublicationJournalS3 interface {
	S3Client
	ListObjectVersions(context.Context, *s3.ListObjectVersionsInput, ...func(*s3.Options)) (*s3.ListObjectVersionsOutput, error)
}

// PublicationJournalConfig isolates coordination from the broker checkpoint,
// while reusing the existing evidence archive and DynamoDB physical table.
type PublicationJournalConfig struct {
	Policy              publicationjournal.Config
	TableName           string
	BucketName          string
	ObjectPrefix        string
	ExpectedBucketOwner string
	EncryptionKeyARN    string
	ObjectLockMode      string
}

type publicationJournalRef struct {
	Revision  int64  `json:"revision"`
	Key       string `json:"key"`
	VersionID string `json:"version_id"`
	SHA256    string `json:"sha256"`
	Length    int64  `json:"length"`
}

type publicationJournalEntry struct {
	SchemaVersion string                    `json:"schema_version"`
	JournalID     string                    `json:"journal_id"`
	Record        publicationjournal.Record `json:"record"`
	Previous      *publicationJournalRef    `json:"previous"`
}

type PublicationJournalStore struct {
	config       PublicationJournalConfig
	s3           PublicationJournalS3
	dynamo       DynamoDBClient
	reader       *ImmutableObjectReader
	clock        func() time.Time
	mu           sync.Mutex
	loaded       bool
	loadedHead   *publicationJournalRef
	loadedRecord *publicationjournal.Record
}

var _ publicationjournal.Store = (*PublicationJournalStore)(nil)

func NewPublicationJournalStore(config PublicationJournalConfig, client PublicationJournalS3, dynamo DynamoDBClient, clock func() time.Time) (*PublicationJournalStore, error) {
	if isNil(client) || isNil(dynamo) || clock == nil || clock().IsZero() {
		return nil, errors.New("publication journal clients and clock are required")
	}
	if config.TableName != "hid-"+config.Policy.Environment+"-tuf-broker-state" ||
		config.ObjectPrefix != "tuf-publication-journal/hid-"+config.Policy.Environment+"-publication-v1/" ||
		config.Policy.Environment == "production" && config.ObjectLockMode != "COMPLIANCE" {
		return nil, errors.New("publication journal storage namespace or retention is invalid")
	}
	reader, err := NewImmutableObjectReader(ImmutableObjectReaderConfig{BucketName: config.BucketName,
		ExpectedBucketOwner: config.ExpectedBucketOwner, EncryptionKeyARN: config.EncryptionKeyARN,
		ObjectLockMode: config.ObjectLockMode, Clock: clock}, client)
	if err != nil {
		return nil, err
	}
	store := &PublicationJournalStore{config: config, s3: client, dynamo: dynamo, reader: reader, clock: clock}
	if _, err := publicationjournal.New(config.Policy, store, clock); err != nil {
		return nil, err
	}
	return store, nil
}

func (store *PublicationJournalStore) journalID() string {
	return "hid-" + store.config.Policy.Environment + "-publication-v1"
}
func (store *PublicationJournalStore) slotKey(revision int64) string {
	return fmt.Sprintf("%sslots/%016d.json", store.config.ObjectPrefix, revision)
}
func (store *PublicationJournalStore) metadata(revision int64) map[string]string {
	return map[string]string{"schema": publicationJournalSchema, "journal-id": store.journalID(), "revision": strconv.FormatInt(revision, 10)}
}

func (store *PublicationJournalStore) Load(ctx context.Context, journalID string) (publicationjournal.Record, error) {
	if store == nil || isNil(ctx) || journalID != store.journalID() {
		return publicationjournal.Record{}, errors.New("publication journal read context is invalid")
	}
	if err := ctx.Err(); err != nil {
		return publicationjournal.Record{}, err
	}
	// Each instance is serialized so its CAS predecessor cannot be replaced by
	// another goroutine's read. Multiple instances coordinate via durable CAS.
	store.mu.Lock()
	defer store.mu.Unlock()
	store.loaded, store.loadedHead, store.loadedRecord = false, nil, nil
	head, err := store.readHead(ctx)
	if err != nil {
		return publicationjournal.Record{}, err
	}
	nextRevision := int64(1)
	if head != nil {
		nextRevision = head.Revision + 1
	}
	if _, occupied, err := store.slotVersion(ctx, nextRevision); err != nil {
		return publicationjournal.Record{}, err
	} else if occupied {
		return publicationjournal.Record{}, fmt.Errorf("immutable successor slot exists beyond the current head: %w", publicationjournal.ErrUnresolved)
	}
	if head == nil {
		store.loaded = true
		return publicationjournal.Record{}, publicationjournal.ErrNotFound
	}
	entries := make([]publicationJournalEntry, int(head.Revision))
	refs := make([]publicationJournalRef, len(entries))
	// Fixed slot names allow bounded parallel readback, but every exact version,
	// hash and predecessor link is still checked before returning any state.
	workCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	var group sync.WaitGroup
	var firstErr error
	var errorMu sync.Mutex
	jobs := make(chan int)
	for worker := 0; worker < 16; worker++ {
		group.Add(1)
		go func() {
			defer group.Done()
			for index := range jobs {
				entry, ref, err := store.readSlot(workCtx, int64(index+1))
				if err != nil {
					errorMu.Lock()
					if firstErr == nil {
						firstErr = err
					}
					errorMu.Unlock()
					cancel()
					continue
				}
				entries[index], refs[index] = entry, ref
			}
		}()
	}
dispatch:
	for index := range entries {
		select {
		case jobs <- index:
		case <-workCtx.Done():
			break dispatch
		}
	}
	close(jobs)
	group.Wait()
	if firstErr != nil {
		return publicationjournal.Record{}, firstErr
	}
	if err := ctx.Err(); err != nil {
		return publicationjournal.Record{}, err
	}
	for index, entry := range entries {
		var previous *publicationjournal.Record
		if index == 0 {
			if entry.Previous != nil {
				return publicationjournal.Record{}, errors.New("publication genesis unexpectedly links a predecessor")
			}
		} else {
			if entry.Previous == nil || *entry.Previous != refs[index-1] {
				return publicationjournal.Record{}, errors.New("publication history is truncated, substituted or reordered")
			}
			previous = &entries[index-1].Record
		}
		if err := publicationjournal.ValidateTransition(store.config.Policy, previous, entry.Record); err != nil {
			return publicationjournal.Record{}, fmt.Errorf("publication history transition %d: %w", index+1, err)
		}
	}
	if refs[len(refs)-1] != *head {
		return publicationjournal.Record{}, errors.New("publication head differs from its immutable revision slot")
	}
	latest, err := store.readHead(ctx)
	if err != nil {
		return publicationjournal.Record{}, err
	}
	if latest == nil || *latest != *head {
		return publicationjournal.Record{}, publicationjournal.ErrConflict
	}
	if _, occupied, err := store.slotVersion(ctx, nextRevision); err != nil {
		return publicationjournal.Record{}, err
	} else if occupied {
		return publicationjournal.Record{}, publicationjournal.ErrUnresolved
	}
	record := entries[len(entries)-1].Record
	store.loaded, store.loadedHead, store.loadedRecord = true, head, &record
	return record, nil
}

func (store *PublicationJournalStore) CompareAndSwap(ctx context.Context, journalID string, previous int64, next publicationjournal.Record) error {
	if store == nil || isNil(ctx) || journalID != store.journalID() {
		return errors.New("publication journal write context is invalid")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if !store.loaded || previous < 0 || previous >= maxPublicationRevisions || next.Revision != previous+1 ||
		store.loadedHead == nil && previous != 0 || store.loadedHead != nil && store.loadedHead.Revision != previous {
		return publicationjournal.ErrConflict
	}
	if err := publicationjournal.ValidateTransition(store.config.Policy, store.loadedRecord, next); err != nil {
		return err
	}
	entry := publicationJournalEntry{SchemaVersion: publicationJournalSchema, JournalID: store.journalID(), Record: next, Previous: store.loadedHead}
	data, err := json.Marshal(entry)
	if err != nil || len(data) > maxPublicationEntryBytes {
		return errors.New("publication journal entry exceeds its canonical size bound")
	}
	digest, _ := hex.DecodeString(digestHex(data))
	checksum := base64.StdEncoding.EncodeToString(digest)
	key := store.slotKey(next.Revision)
	// An occupied slot freezes this append. Never overwrite it, choose another
	// key for the same revision, or treat a lost response as mutation permission.
	output, err := store.s3.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(store.config.BucketName), Key: aws.String(key),
		ExpectedBucketOwner: aws.String(store.config.ExpectedBucketOwner), Body: bytes.NewReader(data), ContentLength: aws.Int64(int64(len(data))),
		ContentType: aws.String("application/json"), ChecksumAlgorithm: s3types.ChecksumAlgorithmSha256, ChecksumSHA256: aws.String(checksum), IfNoneMatch: aws.String("*"),
		ServerSideEncryption: s3types.ServerSideEncryptionAwsKms, SSEKMSKeyId: aws.String(store.config.EncryptionKeyARN),
		ObjectLockMode: s3types.ObjectLockMode(store.config.ObjectLockMode), ObjectLockRetainUntilDate: aws.Time(store.clock().UTC().Add(time.Duration(StateRetentionDays) * 24 * time.Hour)),
		Metadata: store.metadata(next.Revision)})
	store.loaded = false
	if err != nil {
		return fmt.Errorf("create immutable publication slot; reconcile before retry: %w", err)
	}
	if output == nil || !validVersionID(aws.ToString(output.VersionId)) || aws.ToString(output.ChecksumSHA256) != checksum ||
		output.ServerSideEncryption != s3types.ServerSideEncryptionAwsKms || aws.ToString(output.SSEKMSKeyId) != store.config.EncryptionKeyARN {
		return errors.New("immutable publication slot write returned invalid evidence; reconciliation required")
	}
	ref := publicationJournalRef{Revision: next.Revision, Key: key, VersionID: aws.ToString(output.VersionId), SHA256: digestHex(data), Length: int64(len(data))}
	readback, err := store.reader.Read(ctx, ref.Key, ref.VersionID, ref.SHA256, maxPublicationEntryBytes, store.metadata(next.Revision))
	if err != nil || !bytes.Equal(readback, data) {
		return errors.New("immutable publication slot readback failed; reconciliation required")
	}
	refBytes, _ := json.Marshal(ref)
	values := map[string]dynamotypes.AttributeValue{
		":schema":   &dynamotypes.AttributeValueMemberS{Value: publicationHeadSchema},
		":revision": &dynamotypes.AttributeValueMemberN{Value: strconv.FormatInt(next.Revision, 10)},
		":journal":  &dynamotypes.AttributeValueMemberS{Value: string(refBytes)},
	}
	condition := "attribute_not_exists(#state) AND attribute_not_exists(#record)"
	names := map[string]string{"#schema": "schema_version", "#revision": "revision", "#journal": "journal"}
	if previous != 0 {
		oldBytes, _ := json.Marshal(store.loadedHead)
		values[":oldRevision"] = &dynamotypes.AttributeValueMemberN{Value: strconv.FormatInt(previous, 10)}
		values[":oldJournal"] = &dynamotypes.AttributeValueMemberS{Value: string(oldBytes)}
		condition = "#schema = :schema AND #revision = :oldRevision AND #journal = :oldJournal"
	} else {
		names["#state"], names["#record"] = "state_id", "record_id"
	}
	commit, err := store.dynamo.UpdateItem(ctx, &dynamodb.UpdateItemInput{TableName: aws.String(store.config.TableName), Key: store.headKey(),
		UpdateExpression: aws.String("SET #schema = :schema, #revision = :revision, #journal = :journal"), ConditionExpression: aws.String(condition),
		ExpressionAttributeNames:  names,
		ExpressionAttributeValues: values})
	if err != nil {
		return fmt.Errorf("publication head commit failed or is ambiguous; immutable slot remains unresolved: %w", err)
	}
	if commit == nil {
		return errors.New("publication head commit returned no response; reconciliation required")
	}
	// Unlike signing replay, even successful readback after a transport error
	// could not authorize a side effect. The error branch above never recovers.
	if err := ctx.Err(); err != nil {
		return err
	}
	return nil
}

func (store *PublicationJournalStore) headKey() map[string]dynamotypes.AttributeValue {
	return map[string]dynamotypes.AttributeValue{"state_id": &dynamotypes.AttributeValueMemberS{Value: store.journalID()}, "record_id": &dynamotypes.AttributeValueMemberS{Value: publicationRecordID}}
}

func (store *PublicationJournalStore) readHead(ctx context.Context) (*publicationJournalRef, error) {
	output, err := store.dynamo.GetItem(ctx, &dynamodb.GetItemInput{TableName: aws.String(store.config.TableName), ConsistentRead: aws.Bool(true), Key: store.headKey()})
	if err != nil {
		return nil, err
	}
	if output == nil {
		return nil, errors.New("publication head read returned no response")
	}
	if len(output.Item) == 0 {
		return nil, nil
	}
	if len(output.Item) != 5 {
		return nil, errors.New("publication head attributes are invalid")
	}
	for name, value := range map[string]string{"state_id": store.journalID(), "record_id": publicationRecordID, "schema_version": publicationHeadSchema} {
		actual, ok := output.Item[name].(*dynamotypes.AttributeValueMemberS)
		if !ok || actual.Value != value {
			return nil, errors.New("publication head identity is invalid")
		}
	}
	revision, ok := output.Item["revision"].(*dynamotypes.AttributeValueMemberN)
	if !ok {
		return nil, errors.New("publication head revision is invalid")
	}
	number, err := strconv.ParseInt(revision.Value, 10, 64)
	if err != nil || number < 1 || number > maxPublicationRevisions || strconv.FormatInt(number, 10) != revision.Value {
		return nil, errors.New("publication history revision is noncanonical or requires a governed archival migration")
	}
	value, ok := output.Item["journal"].(*dynamotypes.AttributeValueMemberS)
	if !ok || len(value.Value) > 4096 {
		return nil, errors.New("publication head reference is invalid")
	}
	var ref publicationJournalRef
	if err := strictjson.Decode([]byte(value.Value), &ref); err != nil {
		return nil, err
	}
	canonical, _ := json.Marshal(ref)
	if string(canonical) != value.Value || ref.Revision != number || ref.Key != store.slotKey(number) || !validVersionID(ref.VersionID) ||
		!sha256Pattern.MatchString(ref.SHA256) || ref.Length < 1 || ref.Length > maxPublicationEntryBytes {
		return nil, errors.New("publication head reference violates fixed-slot bounds")
	}
	return &ref, nil
}

// Version inventory exposes delete markers and duplicate versions instead of
// treating a hidden/deleted immutable slot as absent. IAM bounds this read to
// the publication prefix; no broad bucket-list permission is required.
func (store *PublicationJournalStore) slotVersion(ctx context.Context, revision int64) (string, bool, error) {
	key := store.slotKey(revision)
	output, err := store.s3.ListObjectVersions(ctx, &s3.ListObjectVersionsInput{Bucket: aws.String(store.config.BucketName),
		ExpectedBucketOwner: aws.String(store.config.ExpectedBucketOwner), Prefix: aws.String(key), MaxKeys: aws.Int32(2)})
	if err != nil {
		return "", false, err
	}
	if output == nil || aws.ToBool(output.IsTruncated) || len(output.DeleteMarkers) != 0 || len(output.CommonPrefixes) != 0 || len(output.Versions) > 1 {
		return "", false, errors.New("immutable publication slot contains ambiguous versions or delete markers")
	}
	if len(output.Versions) == 0 {
		return "", false, nil
	}
	version := output.Versions[0]
	if aws.ToString(version.Key) != key || !aws.ToBool(version.IsLatest) || !validVersionID(aws.ToString(version.VersionId)) {
		return "", false, errors.New("publication slot inventory identity is invalid")
	}
	return aws.ToString(version.VersionId), true, nil
}

func (store *PublicationJournalStore) readSlot(ctx context.Context, revision int64) (publicationJournalEntry, publicationJournalRef, error) {
	version, exists, err := store.slotVersion(ctx, revision)
	if err != nil {
		return publicationJournalEntry{}, publicationJournalRef{}, err
	}
	if !exists {
		return publicationJournalEntry{}, publicationJournalRef{}, errors.New("publication history has a missing immutable revision")
	}
	key := store.slotKey(revision)
	output, err := store.s3.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(store.config.BucketName), Key: aws.String(key), VersionId: aws.String(version),
		ExpectedBucketOwner: aws.String(store.config.ExpectedBucketOwner), ChecksumMode: s3types.ChecksumModeEnabled})
	if err != nil {
		return publicationJournalEntry{}, publicationJournalRef{}, err
	}
	if output == nil || output.Body == nil {
		return publicationJournalEntry{}, publicationJournalRef{}, errors.New("publication slot returned no body")
	}
	data, readErr := io.ReadAll(io.LimitReader(output.Body, maxPublicationEntryBytes+1))
	closeErr := output.Body.Close()
	if readErr != nil || closeErr != nil || len(data) == 0 || len(data) > maxPublicationEntryBytes || int64(len(data)) != aws.ToInt64(output.ContentLength) {
		return publicationJournalEntry{}, publicationJournalRef{}, errors.New("publication slot body is incomplete or unbounded")
	}
	ref := publicationJournalRef{Revision: revision, Key: key, VersionID: version, SHA256: digestHex(data), Length: int64(len(data))}
	// The shared reader enforces exact version, metadata, checksum, KMS and
	// active fixed-mode retention before these bytes enter chain validation.
	verified, err := store.reader.Read(ctx, key, version, ref.SHA256, maxPublicationEntryBytes, store.metadata(revision))
	if err != nil || !bytes.Equal(verified, data) {
		return publicationJournalEntry{}, publicationJournalRef{}, errors.New("publication immutable envelope failed authentication")
	}
	var entry publicationJournalEntry
	if err := strictjson.Decode(data, &entry); err != nil {
		return entry, ref, err
	}
	canonical, _ := json.Marshal(entry)
	if !bytes.Equal(canonical, data) || entry.SchemaVersion != publicationJournalSchema || entry.JournalID != store.journalID() || entry.Record.Revision != revision ||
		strings.Contains(entry.JournalID, "/") {
		return entry, ref, errors.New("publication slot content violates its canonical identity")
	}
	updated, err := time.Parse(time.RFC3339, entry.Record.UpdatedAt)
	retention, retentionErr := store.s3.GetObjectRetention(ctx, &s3.GetObjectRetentionInput{Bucket: aws.String(store.config.BucketName), Key: aws.String(key), VersionId: aws.String(version), ExpectedBucketOwner: aws.String(store.config.ExpectedBucketOwner)})
	if err != nil || retentionErr != nil || retention == nil || retention.Retention == nil || retention.Retention.RetainUntilDate == nil ||
		retention.Retention.RetainUntilDate.Before(updated.Add(time.Duration(StateRetentionDays)*24*time.Hour)) {
		return entry, ref, errors.New("journal retention no longer covers its original recorded lifetime")
	}
	return entry, ref, nil
}
