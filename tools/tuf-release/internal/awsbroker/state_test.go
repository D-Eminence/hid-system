package awsbroker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dynamodbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/signingbroker"
)

const stateTestRelease = "r0000000001-gaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

type storedS3Object struct {
	data            []byte
	versionID       string
	contentType     string
	contentEncoding string
	checksum        string
	kmsKey          string
	mode            s3types.ObjectLockRetentionMode
	retainUntil     time.Time
	metadata        map[string]string
}

type fakeS3 struct {
	mu             sync.Mutex
	objects        map[string]storedS3Object
	putCalls       int
	getCalls       int
	retentionCalls int
	nextVersion    int
	lastGet        *s3.GetObjectInput
	lastRetention  *s3.GetObjectRetentionInput
}

func newFakeS3() *fakeS3 {
	return &fakeS3{objects: make(map[string]storedS3Object)}
}

func objectMapKey(key, version string) string { return key + "\x00" + version }

func checksumBase64(data []byte) string {
	digest := sha256.Sum256(data)
	return base64.StdEncoding.EncodeToString(digest[:])
}

func (client *fakeS3) PutObject(_ context.Context, input *s3.PutObjectInput, _ ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.putCalls++
	if input == nil || input.Body == nil {
		return nil, errors.New("invalid put")
	}
	data, err := io.ReadAll(input.Body)
	if err != nil {
		return nil, err
	}
	client.nextVersion++
	versionID := fmt.Sprintf("version-%d", client.nextVersion)
	metadata := make(map[string]string, len(input.Metadata))
	for key, value := range input.Metadata {
		metadata[key] = value
	}
	object := storedS3Object{
		data: data, versionID: versionID, contentType: aws.ToString(input.ContentType),
		checksum: aws.ToString(input.ChecksumSHA256), kmsKey: aws.ToString(input.SSEKMSKeyId),
		mode: s3types.ObjectLockRetentionMode(input.ObjectLockMode), retainUntil: aws.ToTime(input.ObjectLockRetainUntilDate),
		metadata: metadata,
	}
	client.objects[objectMapKey(aws.ToString(input.Key), versionID)] = object
	return &s3.PutObjectOutput{
		VersionId: aws.String(versionID), ChecksumSHA256: input.ChecksumSHA256,
		ServerSideEncryption: input.ServerSideEncryption, SSEKMSKeyId: input.SSEKMSKeyId,
	}, nil
}

func (client *fakeS3) GetObject(_ context.Context, input *s3.GetObjectInput, _ ...func(*s3.Options)) (*s3.GetObjectOutput, error) {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.getCalls++
	client.lastGet = input
	object, ok := client.objects[objectMapKey(aws.ToString(input.Key), aws.ToString(input.VersionId))]
	if !ok {
		return nil, errors.New("not found")
	}
	metadata := make(map[string]string, len(object.metadata))
	for key, value := range object.metadata {
		metadata[key] = value
	}
	output := &s3.GetObjectOutput{
		Body: io.NopCloser(bytes.NewReader(object.data)), ContentLength: aws.Int64(int64(len(object.data))),
		ContentType: aws.String(object.contentType), VersionId: aws.String(object.versionID),
		ContentEncoding:      aws.String(object.contentEncoding),
		ServerSideEncryption: s3types.ServerSideEncryptionAwsKms,
		SSEKMSKeyId:          aws.String(object.kmsKey), Metadata: metadata,
	}
	if object.checksum != "" {
		output.ChecksumSHA256 = aws.String(object.checksum)
	}
	return output, nil
}

func (client *fakeS3) GetObjectRetention(_ context.Context, input *s3.GetObjectRetentionInput, _ ...func(*s3.Options)) (*s3.GetObjectRetentionOutput, error) {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.retentionCalls++
	client.lastRetention = input
	object, ok := client.objects[objectMapKey(aws.ToString(input.Key), aws.ToString(input.VersionId))]
	if !ok {
		return nil, errors.New("not found")
	}
	return &s3.GetObjectRetentionOutput{Retention: &s3types.ObjectLockRetention{
		Mode: object.mode, RetainUntilDate: aws.Time(object.retainUntil),
	}}, nil
}

type fakeDynamo struct {
	mu              sync.Mutex
	item            map[string]dynamodbtypes.AttributeValue
	decisions       map[string]map[string]dynamodbtypes.AttributeValue
	getCalls        int
	updateCalls     int
	forceConflict   bool
	commitThenError bool
	lastGet         *dynamodb.GetItemInput
	lastUpdate      *dynamodb.UpdateItemInput
	updates         []*dynamodb.UpdateItemInput
}

func (client *fakeDynamo) GetItem(_ context.Context, input *dynamodb.GetItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.getCalls++
	client.lastGet = input
	recordID, _ := input.Key["record_id"].(*dynamodbtypes.AttributeValueMemberS)
	if recordID == nil || recordID.Value == stateRecordID {
		return &dynamodb.GetItemOutput{Item: cloneAttributes(client.item)}, nil
	}
	return &dynamodb.GetItemOutput{Item: cloneAttributes(client.decisions[recordID.Value])}, nil
}

func (client *fakeDynamo) UpdateItem(_ context.Context, input *dynamodb.UpdateItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.updateCalls++
	client.lastUpdate = input
	client.updates = append(client.updates, input)
	if client.forceConflict {
		return nil, &dynamodbtypes.ConditionalCheckFailedException{Message: aws.String("forced conflict")}
	}
	recordID, _ := input.Key["record_id"].(*dynamodbtypes.AttributeValueMemberS)
	if recordID != nil && recordID.Value != stateRecordID {
		if client.decisions == nil {
			client.decisions = make(map[string]map[string]dynamodbtypes.AttributeValue)
		}
		if len(client.decisions[recordID.Value]) != 0 {
			return nil, &dynamodbtypes.ConditionalCheckFailedException{Message: aws.String("decision exists")}
		}
		client.decisions[recordID.Value] = map[string]dynamodbtypes.AttributeValue{
			"state_id":       cloneAttribute(input.Key["state_id"]),
			"record_id":      cloneAttribute(input.Key["record_id"]),
			"schema_version": cloneAttribute(input.ExpressionAttributeValues[":schema"]),
			"decision":       cloneAttribute(input.ExpressionAttributeValues[":decision"]),
		}
		return &dynamodb.UpdateItemOutput{
			Attributes: cloneAttributes(client.decisions[recordID.Value]),
		}, nil
	}
	if expected, ok := input.ExpressionAttributeValues[":expected"].(*dynamodbtypes.AttributeValueMemberN); ok {
		current, currentOK := client.item["revision"].(*dynamodbtypes.AttributeValueMemberN)
		if !currentOK || current.Value != expected.Value {
			return nil, &dynamodbtypes.ConditionalCheckFailedException{Message: aws.String("stale revision")}
		}
		expectedManifest, expectedOK := input.ExpressionAttributeValues[":expected_manifest"].(*dynamodbtypes.AttributeValueMemberS)
		currentManifest, currentOK := client.item["manifest"].(*dynamodbtypes.AttributeValueMemberS)
		if !expectedOK || !currentOK || currentManifest.Value != expectedManifest.Value {
			return nil, &dynamodbtypes.ConditionalCheckFailedException{Message: aws.String("changed manifest")}
		}
		expectedJournal, expectedOK := input.ExpressionAttributeValues[":expected_journal"].(*dynamodbtypes.AttributeValueMemberS)
		currentJournal, currentOK := client.item["journal"].(*dynamodbtypes.AttributeValueMemberS)
		if !expectedOK || !currentOK || currentJournal.Value != expectedJournal.Value {
			return nil, &dynamodbtypes.ConditionalCheckFailedException{Message: aws.String("changed journal")}
		}
	} else if len(client.item) != 0 {
		return nil, &dynamodbtypes.ConditionalCheckFailedException{Message: aws.String("already exists")}
	}
	client.item = map[string]dynamodbtypes.AttributeValue{
		"state_id":       cloneAttribute(input.Key["state_id"]),
		"record_id":      cloneAttribute(input.Key["record_id"]),
		"schema_version": cloneAttribute(input.ExpressionAttributeValues[":schema"]),
		"revision":       cloneAttribute(input.ExpressionAttributeValues[":next"]),
		"manifest":       cloneAttribute(input.ExpressionAttributeValues[":manifest"]),
		"journal":        cloneAttribute(input.ExpressionAttributeValues[":journal"]),
	}
	if client.commitThenError {
		client.commitThenError = false
		return nil, errors.New("simulated lost UpdateItem response")
	}
	return &dynamodb.UpdateItemOutput{Attributes: cloneAttributes(client.item)}, nil
}

func cloneAttributes(input map[string]dynamodbtypes.AttributeValue) map[string]dynamodbtypes.AttributeValue {
	if input == nil {
		return nil
	}
	result := make(map[string]dynamodbtypes.AttributeValue, len(input))
	for key, value := range input {
		result[key] = cloneAttribute(value)
	}
	return result
}

func cloneAttribute(value dynamodbtypes.AttributeValue) dynamodbtypes.AttributeValue {
	switch value := value.(type) {
	case *dynamodbtypes.AttributeValueMemberS:
		return &dynamodbtypes.AttributeValueMemberS{Value: value.Value}
	case *dynamodbtypes.AttributeValueMemberN:
		return &dynamodbtypes.AttributeValueMemberN{Value: value.Value}
	default:
		return value
	}
}

func stateTestConfig(now time.Time) StateStoreConfig {
	rootHash := digestHex([]byte(`{"root":1}`))
	return StateStoreConfig{
		Environment: "staging", RepositoryID: "hid-staging-v1", StateID: "hid-staging-broker-v1",
		BootstrapRootSHA256: rootHash, TableName: "hid-staging-tuf-broker-state",
		BucketName: "hid-staging-evidence-123456", StateObjectPrefix: "tuf-signing-broker/state/hid-staging-broker-v1/",
		ExpectedBucketOwner: "123456789012",
		EncryptionKeyARN:    "arn:aws:kms:us-east-1:123456789012:key/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
		ObjectLockMode:      "COMPLIANCE", RetentionDays: StateRetentionDays, Clock: func() time.Time { return now },
	}
}

func stateTestCheckpoint(revision int64) signingbroker.Checkpoint {
	root := signingbroker.NewMetadataRecord(1, []byte(`{"root":1}`))
	return signingbroker.Checkpoint{
		SchemaVersion: signingbroker.CheckpointSchemaVersion, Environment: "staging", RepositoryID: "hid-staging-v1",
		StateID: "hid-staging-broker-v1", BootstrapRootSHA256: root.SHA256,
		Revision: revision, ReleaseID: stateTestRelease, RootHistory: []signingbroker.MetadataRecord{root},
		Targets:                   signingbroker.NewMetadataRecord(1, []byte(`{"targets":1}`)),
		Snapshot:                  signingbroker.NewMetadataRecord(1, []byte(`{"snapshot":1}`)),
		Timestamp:                 signingbroker.NewMetadataRecord(1, []byte(`{"timestamp":1}`)),
		SnapshotVersionHighWater:  1,
		TimestampVersionHighWater: 1,
	}
}

func TestStateStoreRoundTripReusesImmutableBlobsAndCASesManifest(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	s3Client := newFakeS3()
	dynamoClient := &fakeDynamo{}
	store, err := NewStateStore(stateTestConfig(now), s3Client, dynamoClient)
	if err != nil {
		t.Fatal(err)
	}
	initial := stateTestCheckpoint(1)
	if err := store.CompareAndSwap(context.Background(), initial.StateID, 0, initial); err != nil {
		t.Fatal(err)
	}
	if s3Client.putCalls != 5 || dynamoClient.updateCalls != 1 {
		t.Fatalf("bootstrap wrote %d immutable blobs/journals and %d pointers", s3Client.putCalls, dynamoClient.updateCalls)
	}
	_, initialManifestBytes, initialJournal, err := decodeStateItem(
		dynamoClient.item,
		initial.StateID,
	)
	if err != nil {
		t.Fatal(err)
	}
	var initialManifest stateManifest
	if err := json.Unmarshal(initialManifestBytes, &initialManifest); err != nil {
		t.Fatal(err)
	}
	if initialManifest.SchemaVersion != stateManifestSchema ||
		initialManifest.CheckpointSchema != signingbroker.CheckpointSchemaVersion ||
		initialManifest.SnapshotVersionHighWater != 1 || initialManifest.TimestampVersionHighWater != 1 {
		t.Fatalf("genesis manifest omitted its exact schemas or high-water marks: %+v", initialManifest)
	}
	legacyManifest := initialManifest
	legacyManifest.SchemaVersion = "hid.tuf.signing-broker.state-manifest/v2"
	legacyBytes, err := json.Marshal(legacyManifest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.decodeManifest(legacyBytes, 1); err == nil {
		t.Fatal("predeployment v2 state manifest was silently migrated")
	}
	initialJournalObject, ok := s3Client.objects[objectMapKey(initialJournal.Key, initialJournal.VersionID)]
	if !ok || !bytes.Equal(initialJournalObject.data, initialManifestBytes) ||
		initialJournalObject.retainUntil != now.Add(StateRetentionDays*24*time.Hour) {
		t.Fatal("genesis state pointer is not bound to its 100-year immutable journal")
	}
	loaded, err := store.Load(context.Background(), initial.StateID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(loaded, initial) {
		t.Fatalf("state round trip differs\nwant: %#v\n got: %#v", initial, loaded)
	}
	if dynamoClient.lastGet == nil || dynamoClient.lastGet.ConsistentRead == nil || !*dynamoClient.lastGet.ConsistentRead {
		t.Fatal("state load was not a consistent DynamoDB read")
	}

	next := loaded
	next.Revision = 2
	next.SnapshotVersionHighWater = 2
	nextTargets := signingbroker.NewMetadataRecord(2, []byte(`{"targets":2}`))
	nextSnapshot := signingbroker.NewMetadataRecord(2, []byte(`{"snapshot":2}`))
	requestObject := &signingbroker.ImmutableRequestObject{
		Bucket:    "hid-staging-evidence-123456",
		Key:       "tuf-signing-broker/requests/hid-staging-broker-v1/snapshot-one/request.json",
		VersionID: "request-version-1", SHA256: strings.Repeat("b", 64),
	}
	next.PendingSnapshot = &signingbroker.PendingSnapshot{
		CandidateID: "one", RequestSHA256: strings.Repeat("b", 64), ReleaseID: stateTestRelease,
		CreatedAt: now.Format(time.RFC3339), StateRevision: 2,
		RequestObject: requestObject,
		Root:          loaded.RootHistory[0], Targets: nextTargets, Snapshot: nextSnapshot,
	}
	if err := store.CompareAndSwap(context.Background(), next.StateID, 1, next); err != nil {
		t.Fatal(err)
	}
	if s3Client.putCalls != 8 {
		t.Fatalf("unchanged current/root records were rewritten; got %d total puts", s3Client.putCalls)
	}
	reloaded, err := store.Load(context.Background(), next.StateID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(reloaded, next) {
		t.Fatalf("advanced state round trip differs\nwant: %#v\n got: %#v", next, reloaded)
	}
	_, _, secondJournal, err := decodeStateItem(dynamoClient.item, next.StateID)
	if err != nil {
		t.Fatal(err)
	}
	var secondManifest stateManifest
	if err := json.Unmarshal(
		[]byte(dynamoClient.item["manifest"].(*dynamodbtypes.AttributeValueMemberS).Value),
		&secondManifest,
	); err != nil {
		t.Fatal(err)
	}
	if secondManifest.PreviousJournal == nil || *secondManifest.PreviousJournal != initialJournal {
		t.Fatal("advanced state manifest does not chain to the exact genesis journal version")
	}
	if secondManifest.SnapshotVersionHighWater != 2 || secondManifest.TimestampVersionHighWater != 1 {
		t.Fatal("advanced state manifest did not persist exact online-role high-water marks")
	}
	pointerCASFound := false
	for _, update := range dynamoClient.updates {
		if aws.ToString(update.ConditionExpression) ==
			"#schema = :schema AND #revision = :expected AND #manifest = :expected_manifest AND #journal = :expected_journal" {
			pointerCASFound = true
			break
		}
	}
	if !pointerCASFound {
		t.Fatal("non-genesis state update omitted exact revision and predecessor-manifest conditions")
	}
	if len(dynamoClient.decisions) != 1 {
		t.Fatalf("pending state did not create exactly one completed-decision index: %d", len(dynamoClient.decisions))
	}
	decisionRecordID := ""
	for recordID := range dynamoClient.decisions {
		decisionRecordID = recordID
	}
	delete(dynamoClient.decisions, decisionRecordID)
	carried := reloaded
	carried.Revision = 3
	carried.TimestampVersionHighWater = 2
	timestampRequestHash := strings.Repeat("c", 64)
	carried.PendingTimestamp = &signingbroker.PendingTimestamp{
		CandidateID: "two", RequestSHA256: timestampRequestHash, ReleaseID: stateTestRelease,
		CreatedAt: now.Format(time.RFC3339), StateRevision: 3,
		RequestObject: &signingbroker.ImmutableRequestObject{
			Bucket:    "hid-staging-evidence-123456",
			Key:       "tuf-signing-broker/requests/hid-staging-broker-v1/timestamp-two/request.json",
			VersionID: "timestamp-request-version-1", SHA256: timestampRequestHash,
		},
		Root: loaded.RootHistory[0], Snapshot: nextSnapshot,
		Timestamp: signingbroker.NewMetadataRecord(2, []byte(`{"timestamp":2}`)),
	}
	if err := store.CompareAndSwap(context.Background(), carried.StateID, 2, carried); err != nil {
		t.Fatal(err)
	}
	if len(dynamoClient.decisions) != 2 || len(dynamoClient.decisions[decisionRecordID]) == 0 {
		t.Fatal("pre-transition archival did not reconstruct a missing completed-decision index")
	}
	published := carried
	published.Revision = 4
	published.Targets = nextTargets
	published.Snapshot = nextSnapshot
	published.Timestamp = carried.PendingTimestamp.Timestamp
	published.PendingSnapshot = nil
	published.PendingTimestamp = nil
	if err := store.CompareAndSwap(context.Background(), published.StateID, 3, published); err != nil {
		t.Fatal(err)
	}
	lookup := signingbroker.DecisionLookup{
		StateID: published.StateID, Role: "snapshot", CandidateID: "one",
		RequestSHA256: strings.Repeat("b", 64), RequestObject: requestObject,
	}
	decision, err := store.LoadCompletedDecision(context.Background(), lookup)
	if err != nil {
		t.Fatal(err)
	}
	if decision.StateRevision != 2 || !reflect.DeepEqual(decision.Root, loaded.RootHistory[0]) ||
		!reflect.DeepEqual(decision.Input, nextTargets) || !reflect.DeepEqual(decision.Output, nextSnapshot) {
		t.Fatalf("completed decision did not survive pending-state clearance: %#v", decision)
	}
	journalCount := 0
	for objectKey := range s3Client.objects {
		if strings.Contains(objectKey, "/manifests/") {
			journalCount++
		}
	}
	if journalCount != 4 {
		t.Fatalf("expected one immutable manifest journal per transition, got %d", journalCount)
	}
	decisionValue := dynamoClient.decisions[decisionRecordID]["decision"].(*dynamodbtypes.AttributeValueMemberS)
	originalDecision := decisionValue.Value
	var persistedDecision decisionManifest
	if err := json.Unmarshal([]byte(originalDecision), &persistedDecision); err != nil {
		t.Fatal(err)
	}
	if persistedDecision.StateJournal != secondJournal || persistedDecision.StateRevision != 2 {
		t.Fatal("completed decision is not bound to the exact journal that first committed it")
	}

	t.Run("requires authenticated state head", func(t *testing.T) {
		freshStore, err := NewStateStore(stateTestConfig(now), s3Client, dynamoClient)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := freshStore.LoadCompletedDecision(context.Background(), lookup); err == nil ||
			!strings.Contains(err.Error(), "before broker state is loaded") {
			t.Fatalf("completed decision loaded without an authenticated state head: %v", err)
		}
	})

	mutateDecision := func(t *testing.T, mutate func(*decisionManifest)) {
		t.Helper()
		var changed decisionManifest
		if err := json.Unmarshal([]byte(originalDecision), &changed); err != nil {
			t.Fatal(err)
		}
		mutate(&changed)
		encoded, err := json.Marshal(changed)
		if err != nil {
			t.Fatal(err)
		}
		decisionValue.Value = string(encoded)
		t.Cleanup(func() { decisionValue.Value = originalDecision })
	}

	t.Run("rejects substituted decision journal version", func(t *testing.T) {
		mutateDecision(t, func(changed *decisionManifest) {
			changed.StateJournal.VersionID = "unreachable-orphan-version"
		})
		if _, err := store.LoadCompletedDecision(context.Background(), lookup); err == nil ||
			!strings.Contains(err.Error(), "not the exact reachable state journal") {
			t.Fatalf("unreachable decision journal version was accepted: %v", err)
		}
	})

	t.Run("rejects decision absent from predecessor journal", func(t *testing.T) {
		mutateDecision(t, func(changed *decisionManifest) {
			changed.StateRevision = 1
			changed.StateJournal = initialJournal
		})
		if _, err := store.LoadCompletedDecision(context.Background(), lookup); err == nil ||
			!strings.Contains(err.Error(), "absent from its authenticated state journal") {
			t.Fatalf("decision absent from its claimed committed journal was accepted: %v", err)
		}
	})

	t.Run("rejects altered decision output reference", func(t *testing.T) {
		mutateDecision(t, func(changed *decisionManifest) {
			changed.Output.VersionID = "substituted-output-version"
		})
		if _, err := store.LoadCompletedDecision(context.Background(), lookup); err == nil ||
			!strings.Contains(err.Error(), "absent from its authenticated state journal") {
			t.Fatalf("altered completed-decision output reference was accepted: %v", err)
		}
	})

	t.Run("rejects expired historical decision journal", func(t *testing.T) {
		mapKey := objectMapKey(secondJournal.Key, secondJournal.VersionID)
		object := s3Client.objects[mapKey]
		object.retainUntil = now.Add(-time.Second)
		s3Client.objects[mapKey] = object
		t.Cleanup(func() {
			object.retainUntil = now.Add(StateRetentionDays * 24 * time.Hour)
			s3Client.objects[mapKey] = object
		})
		if _, err := store.LoadCompletedDecision(context.Background(), lookup); err == nil ||
			!strings.Contains(err.Error(), "active fixed-mode retention") {
			t.Fatalf("expired historical decision journal was accepted: %v", err)
		}
	})
}

func TestStateStoreArchivesTimestampDecisionToItsExactJournal(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	s3Client := newFakeS3()
	dynamoClient := &fakeDynamo{}
	store, err := NewStateStore(stateTestConfig(now), s3Client, dynamoClient)
	if err != nil {
		t.Fatal(err)
	}
	initial := stateTestCheckpoint(1)
	if err := store.CompareAndSwap(context.Background(), initial.StateID, 0, initial); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.Load(context.Background(), initial.StateID)
	if err != nil {
		t.Fatal(err)
	}
	requestHash := strings.Repeat("c", 64)
	requestObject := &signingbroker.ImmutableRequestObject{
		Bucket:    "hid-staging-evidence-123456",
		Key:       "tuf-signing-broker/requests/hid-staging-broker-v1/timestamp-two/request.json",
		VersionID: "timestamp-request-version-1", SHA256: requestHash,
	}
	nextTimestamp := signingbroker.NewMetadataRecord(2, []byte(`{"timestamp":2}`))
	pending := loaded
	pending.Revision = 2
	pending.TimestampVersionHighWater = 2
	pending.PendingTimestamp = &signingbroker.PendingTimestamp{
		CandidateID: "two", RequestSHA256: requestHash, ReleaseID: stateTestRelease,
		CreatedAt: now.Format(time.RFC3339), StateRevision: 2,
		RequestObject: requestObject,
		Root:          loaded.RootHistory[0], Snapshot: loaded.Snapshot, Timestamp: nextTimestamp,
	}
	if err := store.CompareAndSwap(context.Background(), pending.StateID, 1, pending); err != nil {
		t.Fatal(err)
	}
	_, _, decisionJournal, err := decodeStateItem(dynamoClient.item, pending.StateID)
	if err != nil {
		t.Fatal(err)
	}
	published := pending
	published.Revision = 3
	published.Timestamp = nextTimestamp
	published.PendingTimestamp = nil
	if err := store.CompareAndSwap(context.Background(), published.StateID, 2, published); err != nil {
		t.Fatal(err)
	}
	lookup := signingbroker.DecisionLookup{
		StateID: published.StateID, Role: "timestamp", CandidateID: "two",
		RequestSHA256: requestHash, RequestObject: requestObject,
	}
	decision, err := store.LoadCompletedDecision(context.Background(), lookup)
	if err != nil {
		t.Fatal(err)
	}
	if decision.StateRevision != 2 || !reflect.DeepEqual(decision.Root, loaded.RootHistory[0]) ||
		!reflect.DeepEqual(decision.Input, loaded.Snapshot) || !reflect.DeepEqual(decision.Output, nextTimestamp) {
		t.Fatalf("timestamp completed decision changed during archival: %#v", decision)
	}
	recordID, err := completedDecisionRecordID(decisionIdentity{
		Role: "timestamp", CandidateID: "two", RequestSHA256: requestHash,
		RequestObject: requestObject,
	})
	if err != nil {
		t.Fatal(err)
	}
	decisionValue, ok := dynamoClient.decisions[recordID]["decision"].(*dynamodbtypes.AttributeValueMemberS)
	if !ok {
		t.Fatal("timestamp completed-decision index is missing")
	}
	var persisted decisionManifest
	if err := json.Unmarshal([]byte(decisionValue.Value), &persisted); err != nil {
		t.Fatal(err)
	}
	if persisted.StateJournal != decisionJournal || persisted.Role != "timestamp" {
		t.Fatal("timestamp decision is not bound to its exact committed journal")
	}
}

func TestStateStoreRejectsPendingRequestProvenanceBeforeWriting(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	requestHash := strings.Repeat("b", 64)
	valid := &signingbroker.ImmutableRequestObject{
		Bucket:    "hid-staging-evidence-123456",
		Key:       "tuf-signing-broker/requests/hid-staging-broker-v1/snapshot-one/request.json",
		VersionID: "request-version-1", SHA256: requestHash,
	}
	cases := []struct {
		name      string
		candidate string
		object    *signingbroker.ImmutableRequestObject
	}{
		{name: "missing", candidate: "one"},
		{name: "invalid candidate", candidate: "three", object: cloneRequestObject(valid)},
		{name: "wrong bucket", candidate: "one", object: cloneRequestObject(valid)},
		{name: "wrong candidate prefix", candidate: "one", object: cloneRequestObject(valid)},
		{name: "invalid version", candidate: "one", object: cloneRequestObject(valid)},
		{name: "wrong hash", candidate: "one", object: cloneRequestObject(valid)},
	}
	cases[2].object.Bucket = "foreign-evidence-123456"
	cases[3].object.Key = "tuf-signing-broker/requests/hid-staging-broker-v1/snapshot-two/request.json"
	cases[4].object.VersionID = "null"
	cases[5].object.SHA256 = strings.Repeat("c", 64)

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			s3Client := newFakeS3()
			dynamoClient := &fakeDynamo{}
			store, err := NewStateStore(stateTestConfig(now), s3Client, dynamoClient)
			if err != nil {
				t.Fatal(err)
			}
			checkpoint := stateTestCheckpoint(1)
			if err := store.CompareAndSwap(context.Background(), checkpoint.StateID, 0, checkpoint); err != nil {
				t.Fatal(err)
			}
			checkpoint, err = store.Load(context.Background(), checkpoint.StateID)
			if err != nil {
				t.Fatal(err)
			}
			checkpoint.Revision = 2
			checkpoint.SnapshotVersionHighWater = 2
			checkpoint.PendingSnapshot = &signingbroker.PendingSnapshot{
				CandidateID: testCase.candidate, RequestSHA256: requestHash, ReleaseID: stateTestRelease,
				CreatedAt: now.Format(time.RFC3339), StateRevision: 2, RequestObject: testCase.object,
				Root: checkpoint.RootHistory[0], Targets: checkpoint.Targets,
				Snapshot: signingbroker.NewMetadataRecord(2, []byte(`{"snapshot":2}`)),
			}
			putCalls := s3Client.putCalls
			updateCalls := dynamoClient.updateCalls
			if err := store.CompareAndSwap(context.Background(), checkpoint.StateID, 1, checkpoint); err == nil ||
				!strings.Contains(err.Error(), "request source") {
				t.Fatalf("invalid pending request provenance was accepted: %v", err)
			}
			if s3Client.putCalls != putCalls || dynamoClient.updateCalls != updateCalls {
				t.Fatal("invalid pending request provenance caused a storage write")
			}
		})
	}
}

func TestStateStoreCASBindsTheExactLoadedPointer(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	s3Client := newFakeS3()
	dynamoClient := &fakeDynamo{}
	store, err := NewStateStore(stateTestConfig(now), s3Client, dynamoClient)
	if err != nil {
		t.Fatal(err)
	}
	initial := stateTestCheckpoint(1)
	if err := store.CompareAndSwap(context.Background(), initial.StateID, 0, initial); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.Load(context.Background(), initial.StateID)
	if err != nil {
		t.Fatal(err)
	}
	dynamoClient.item["manifest"].(*dynamodbtypes.AttributeValueMemberS).Value += " "
	loaded.Revision++
	loaded.SnapshotVersionHighWater = 2
	requestHash := strings.Repeat("d", 64)
	loaded.PendingSnapshot = &signingbroker.PendingSnapshot{
		CandidateID: "one", RequestSHA256: requestHash, ReleaseID: stateTestRelease,
		CreatedAt: now.Format(time.RFC3339), StateRevision: 2,
		RequestObject: &signingbroker.ImmutableRequestObject{
			Bucket:    "hid-staging-evidence-123456",
			Key:       "tuf-signing-broker/requests/hid-staging-broker-v1/snapshot-one/request.json",
			VersionID: "request-version-1", SHA256: requestHash,
		},
		Root: loaded.RootHistory[0], Targets: loaded.Targets,
		Snapshot: signingbroker.NewMetadataRecord(2, []byte(`{"snapshot":2}`)),
	}
	if err := store.CompareAndSwap(context.Background(), loaded.StateID, 1, loaded); !errors.Is(err, signingbroker.ErrStateConflict) {
		t.Fatalf("same-revision pointer substitution did not cause a CAS conflict: %v", err)
	}

	freshStore, err := NewStateStore(stateTestConfig(now), s3Client, dynamoClient)
	if err != nil {
		t.Fatal(err)
	}
	if err := freshStore.CompareAndSwap(context.Background(), loaded.StateID, 1, loaded); !errors.Is(err, signingbroker.ErrStateConflict) {
		t.Fatalf("state advance without an exact predecessor load was accepted: %v", err)
	}
}

func TestStateStoreReconcilesAnAmbiguousCommittedUpdate(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	s3Client := newFakeS3()
	dynamoClient := &fakeDynamo{commitThenError: true}
	store, err := NewStateStore(stateTestConfig(now), s3Client, dynamoClient)
	if err != nil {
		t.Fatal(err)
	}
	initial := stateTestCheckpoint(1)
	if err := store.CompareAndSwap(context.Background(), initial.StateID, 0, initial); err != nil {
		t.Fatalf("exact committed pointer was not reconciled after a lost response: %v", err)
	}
	if dynamoClient.getCalls != 1 {
		t.Fatal("ambiguous UpdateItem result was not reconciled with one consistent read")
	}
	loaded, err := store.Load(context.Background(), initial.StateID)
	if err != nil || !reflect.DeepEqual(loaded, initial) {
		t.Fatalf("reconciled state is not the exact committed checkpoint: %#v, %v", loaded, err)
	}
}

func TestStateStoreConflictReturnsNoAuthorizedState(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	s3Client := newFakeS3()
	dynamoClient := &fakeDynamo{forceConflict: true}
	store, err := NewStateStore(stateTestConfig(now), s3Client, dynamoClient)
	if err != nil {
		t.Fatal(err)
	}
	err = store.CompareAndSwap(context.Background(), "hid-staging-broker-v1", 0, stateTestCheckpoint(1))
	if !errors.Is(err, signingbroker.ErrStateConflict) {
		t.Fatalf("conditional failure did not map to ErrStateConflict: %v", err)
	}
	if len(dynamoClient.item) != 0 || s3Client.putCalls != 5 {
		t.Fatal("CAS conflict authorized state or did not preserve its retained orphan-blob audit trail")
	}
	if _, err := store.Load(context.Background(), "hid-staging-broker-v1"); !errors.Is(err, signingbroker.ErrStateNotFound) {
		t.Fatalf("conflicted bootstrap became loadable: %v", err)
	}
}

func TestStateStoreRejectsPointerManifestAndBlobTampering(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	newStore := func(t *testing.T) (*StateStore, *fakeS3, *fakeDynamo) {
		t.Helper()
		s3Client := newFakeS3()
		dynamoClient := &fakeDynamo{}
		store, err := NewStateStore(stateTestConfig(now), s3Client, dynamoClient)
		if err != nil {
			t.Fatal(err)
		}
		if err := store.CompareAndSwap(context.Background(), "hid-staging-broker-v1", 0, stateTestCheckpoint(1)); err != nil {
			t.Fatal(err)
		}
		return store, s3Client, dynamoClient
	}

	t.Run("unexpected pointer attribute", func(t *testing.T) {
		store, _, dynamoClient := newStore(t)
		dynamoClient.item["injected"] = &dynamodbtypes.AttributeValueMemberS{Value: "value"}
		if _, err := store.Load(context.Background(), "hid-staging-broker-v1"); err == nil || !strings.Contains(err.Error(), "unexpected attributes") {
			t.Fatalf("unexpected pointer attribute was accepted: %v", err)
		}
	})

	t.Run("duplicate manifest member", func(t *testing.T) {
		store, _, dynamoClient := newStore(t)
		value := dynamoClient.item["manifest"].(*dynamodbtypes.AttributeValueMemberS)
		value.Value = strings.Replace(value.Value, `{"schema_version":`, `{"schema_version":"duplicate","schema_version":`, 1)
		if _, err := store.Load(context.Background(), "hid-staging-broker-v1"); err == nil {
			t.Fatalf("duplicate manifest member was accepted: %v", err)
		}
	})

	t.Run("changed immutable journal bytes", func(t *testing.T) {
		store, s3Client, dynamoClient := newStore(t)
		journalValue := dynamoClient.item["journal"].(*dynamodbtypes.AttributeValueMemberS).Value
		var journal blobRef
		if err := json.Unmarshal([]byte(journalValue), &journal); err != nil {
			t.Fatal(err)
		}
		mapKey := objectMapKey(journal.Key, journal.VersionID)
		object := s3Client.objects[mapKey]
		object.data = append(object.data, '\n')
		s3Client.objects[mapKey] = object
		if _, err := store.Load(context.Background(), "hid-staging-broker-v1"); err == nil {
			t.Fatal("changed immutable state journal bytes were accepted")
		}
	})

	t.Run("substituted journal version", func(t *testing.T) {
		store, _, dynamoClient := newStore(t)
		journalValue := dynamoClient.item["journal"].(*dynamodbtypes.AttributeValueMemberS)
		var journal blobRef
		if err := json.Unmarshal([]byte(journalValue.Value), &journal); err != nil {
			t.Fatal(err)
		}
		journal.VersionID = "substituted-version"
		encoded, _ := json.Marshal(journal)
		journalValue.Value = string(encoded)
		if _, err := store.Load(context.Background(), "hid-staging-broker-v1"); err == nil {
			t.Fatal("substituted immutable journal version was accepted")
		}
	})

	t.Run("substituted blob key", func(t *testing.T) {
		store, _, dynamoClient := newStore(t)
		var manifest stateManifest
		value := dynamoClient.item["manifest"].(*dynamodbtypes.AttributeValueMemberS)
		if err := json.Unmarshal([]byte(value.Value), &manifest); err != nil {
			t.Fatal(err)
		}
		manifest.Targets.Key = "tuf-signing-broker/state/hid-staging-broker-v1/../foreign.json"
		encoded, _ := json.Marshal(manifest)
		value.Value = string(encoded)
		if _, err := store.Load(context.Background(), "hid-staging-broker-v1"); err == nil {
			t.Fatalf("substituted blob key was accepted: %v", err)
		}
	})

	t.Run("expired retention", func(t *testing.T) {
		store, s3Client, _ := newStore(t)
		for key, object := range s3Client.objects {
			object.retainUntil = now.Add(-time.Second)
			s3Client.objects[key] = object
			break
		}
		if _, err := store.Load(context.Background(), "hid-staging-broker-v1"); err == nil || !strings.Contains(err.Error(), "active fixed-mode retention") {
			t.Fatalf("expired Object Lock retention was accepted: %v", err)
		}
	})

	t.Run("changed object bytes", func(t *testing.T) {
		store, s3Client, _ := newStore(t)
		for key, object := range s3Client.objects {
			object.data = append(object.data, 'x')
			s3Client.objects[key] = object
			break
		}
		if _, err := store.Load(context.Background(), "hid-staging-broker-v1"); err == nil {
			t.Fatal("changed immutable object bytes were accepted")
		}
	})

	t.Run("encoded object", func(t *testing.T) {
		store, s3Client, _ := newStore(t)
		for key, object := range s3Client.objects {
			object.contentEncoding = "gzip"
			s3Client.objects[key] = object
			break
		}
		if _, err := store.Load(context.Background(), "hid-staging-broker-v1"); err == nil || !strings.Contains(err.Error(), "version, length, or encryption policy") {
			t.Fatalf("content-encoded immutable object was accepted: %v", err)
		}
	})
}

func TestStateStoreRejectsPersistedPendingRequestProvenanceTampering(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	requestHash := strings.Repeat("b", 64)
	newPendingStore := func(t *testing.T) (*StateStore, *fakeDynamo) {
		t.Helper()
		s3Client := newFakeS3()
		dynamoClient := &fakeDynamo{}
		store, err := NewStateStore(stateTestConfig(now), s3Client, dynamoClient)
		if err != nil {
			t.Fatal(err)
		}
		initial := stateTestCheckpoint(1)
		if err := store.CompareAndSwap(context.Background(), initial.StateID, 0, initial); err != nil {
			t.Fatal(err)
		}
		loaded, err := store.Load(context.Background(), initial.StateID)
		if err != nil {
			t.Fatal(err)
		}
		loaded.Revision++
		loaded.SnapshotVersionHighWater = 2
		loaded.PendingSnapshot = &signingbroker.PendingSnapshot{
			CandidateID: "one", RequestSHA256: requestHash, ReleaseID: stateTestRelease,
			CreatedAt: now.Format(time.RFC3339), StateRevision: 2,
			RequestObject: &signingbroker.ImmutableRequestObject{
				Bucket:    "hid-staging-evidence-123456",
				Key:       "tuf-signing-broker/requests/hid-staging-broker-v1/snapshot-one/request.json",
				VersionID: "request-version-1", SHA256: requestHash,
			},
			Root: loaded.RootHistory[0], Targets: loaded.Targets,
			Snapshot: signingbroker.NewMetadataRecord(2, []byte(`{"snapshot":2}`)),
		}
		if err := store.CompareAndSwap(context.Background(), loaded.StateID, 1, loaded); err != nil {
			t.Fatal(err)
		}
		return store, dynamoClient
	}

	cases := []struct {
		name   string
		change func(*stateManifest)
	}{
		{name: "missing source", change: func(manifest *stateManifest) { manifest.PendingSnapshot.RequestObject = nil }},
		{name: "wrong bucket", change: func(manifest *stateManifest) {
			manifest.PendingSnapshot.RequestObject.Bucket = "foreign-evidence-123456"
		}},
		{name: "wrong prefix", change: func(manifest *stateManifest) {
			manifest.PendingSnapshot.RequestObject.Key = "tuf-signing-broker/requests/hid-staging-broker-v1/snapshot-two/request.json"
		}},
		{name: "invalid version", change: func(manifest *stateManifest) { manifest.PendingSnapshot.RequestObject.VersionID = "null" }},
		{name: "wrong hash", change: func(manifest *stateManifest) { manifest.PendingSnapshot.RequestObject.SHA256 = strings.Repeat("c", 64) }},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			store, dynamoClient := newPendingStore(t)
			value := dynamoClient.item["manifest"].(*dynamodbtypes.AttributeValueMemberS)
			var manifest stateManifest
			if err := json.Unmarshal([]byte(value.Value), &manifest); err != nil {
				t.Fatal(err)
			}
			testCase.change(&manifest)
			encoded, err := json.Marshal(manifest)
			if err != nil {
				t.Fatal(err)
			}
			value.Value = string(encoded)
			if _, err := store.Load(context.Background(), "hid-staging-broker-v1"); err == nil {
				t.Fatalf("tampered persisted request provenance was accepted: %v", err)
			}
		})
	}
}

func TestStateStoreConfigurationAndTransitionAreFailClosed(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	valid := stateTestConfig(now)
	cases := []struct {
		name   string
		change func(*StateStoreConfig)
	}{
		{"wrong repository", func(config *StateStoreConfig) { config.RepositoryID = "hid-production-v1" }},
		{"unbound prefix", func(config *StateStoreConfig) { config.StateObjectPrefix = "tuf-signing-broker/state/other/" }},
		{"alias encryption key", func(config *StateStoreConfig) {
			config.EncryptionKeyARN = "arn:aws:kms:us-east-1:123456789012:alias/state"
		}},
		{"wrong owner", func(config *StateStoreConfig) { config.ExpectedBucketOwner = "123" }},
		{"short retention", func(config *StateStoreConfig) { config.RetentionDays = StateRetentionDays - 1 }},
		{"nil clock", func(config *StateStoreConfig) { config.Clock = nil }},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			config := valid
			testCase.change(&config)
			if _, err := NewStateStore(config, newFakeS3(), &fakeDynamo{}); err == nil {
				t.Fatal("invalid state-store configuration was accepted")
			}
		})
	}
	store, err := NewStateStore(valid, newFakeS3(), &fakeDynamo{})
	if err != nil {
		t.Fatal(err)
	}
	checkpoint := stateTestCheckpoint(2)
	if err := store.CompareAndSwap(context.Background(), checkpoint.StateID, 0, checkpoint); err == nil || !strings.Contains(err.Error(), "exactly one revision") {
		t.Fatalf("revision jump was accepted: %v", err)
	}
}

func TestStateStoreRejectsHighWaterRollbackJumpAndPendingSubstitutionBeforeWriting(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	newLoaded := func(t *testing.T) (*StateStore, *fakeS3, *fakeDynamo, signingbroker.Checkpoint) {
		t.Helper()
		s3Client := newFakeS3()
		dynamoClient := &fakeDynamo{}
		store, err := NewStateStore(stateTestConfig(now), s3Client, dynamoClient)
		if err != nil {
			t.Fatal(err)
		}
		initial := stateTestCheckpoint(1)
		if err := store.CompareAndSwap(context.Background(), initial.StateID, 0, initial); err != nil {
			t.Fatal(err)
		}
		loaded, err := store.Load(context.Background(), initial.StateID)
		if err != nil {
			t.Fatal(err)
		}
		return store, s3Client, dynamoClient, loaded
	}
	setSnapshot := func(checkpoint *signingbroker.Checkpoint, version int64, hashByte string) {
		requestHash := strings.Repeat(hashByte, 64)
		checkpoint.SnapshotVersionHighWater = version
		checkpoint.PendingSnapshot = &signingbroker.PendingSnapshot{
			CandidateID: "one", RequestSHA256: requestHash, ReleaseID: stateTestRelease,
			CreatedAt: now.Format(time.RFC3339), StateRevision: checkpoint.Revision,
			RequestObject: &signingbroker.ImmutableRequestObject{
				Bucket:    "hid-staging-evidence-123456",
				Key:       "tuf-signing-broker/requests/hid-staging-broker-v1/snapshot-one/request.json",
				VersionID: "snapshot-request-version-" + hashByte, SHA256: requestHash,
			},
			Root: checkpoint.RootHistory[0], Targets: checkpoint.Targets,
			Snapshot: signingbroker.NewMetadataRecord(version, []byte(`{"snapshot":`+strconv.FormatInt(version, 10)+`}`)),
		}
	}
	setTimestamp := func(checkpoint *signingbroker.Checkpoint, version int64, hashByte string) {
		requestHash := strings.Repeat(hashByte, 64)
		root := checkpoint.RootHistory[len(checkpoint.RootHistory)-1]
		snapshot := checkpoint.Snapshot
		if checkpoint.PendingSnapshot != nil {
			root = checkpoint.PendingSnapshot.Root
			snapshot = checkpoint.PendingSnapshot.Snapshot
		}
		checkpoint.TimestampVersionHighWater = version
		checkpoint.PendingTimestamp = &signingbroker.PendingTimestamp{
			CandidateID: "two", RequestSHA256: requestHash, ReleaseID: stateTestRelease,
			CreatedAt: now.Format(time.RFC3339), StateRevision: checkpoint.Revision,
			RequestObject: &signingbroker.ImmutableRequestObject{
				Bucket:    "hid-staging-evidence-123456",
				Key:       "tuf-signing-broker/requests/hid-staging-broker-v1/timestamp-two/request.json",
				VersionID: "timestamp-request-version-" + hashByte, SHA256: requestHash,
			},
			Root: root, Snapshot: snapshot,
			Timestamp: signingbroker.NewMetadataRecord(version, []byte(`{"timestamp":`+strconv.FormatInt(version, 10)+`}`)),
		}
	}

	for _, testCase := range []struct {
		name   string
		change func(*signingbroker.Checkpoint)
	}{
		{name: "zero high-water", change: func(next *signingbroker.Checkpoint) {
			next.SnapshotVersionHighWater = 0
		}},
		{name: "unsafe high-water", change: func(next *signingbroker.Checkpoint) {
			next.TimestampVersionHighWater = maxSafeInteger + 1
		}},
		{name: "high-water jump", change: func(next *signingbroker.Checkpoint) {
			setSnapshot(next, 3, "b")
		}},
		{name: "pending mismatch", change: func(next *signingbroker.Checkpoint) {
			setSnapshot(next, 2, "b")
			next.PendingSnapshot.Snapshot = signingbroker.NewMetadataRecord(3, []byte(`{"snapshot":3}`))
		}},
		{name: "both roles advance", change: func(next *signingbroker.Checkpoint) {
			setSnapshot(next, 2, "b")
			setTimestamp(next, 2, "c")
		}},
		{name: "orphan burned timestamp", change: func(next *signingbroker.Checkpoint) {
			next.TimestampVersionHighWater = 2
		}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			store, s3Client, dynamoClient, next := newLoaded(t)
			next.Revision = 2
			testCase.change(&next)
			putCalls := s3Client.putCalls
			updateCalls := dynamoClient.updateCalls
			if err := store.CompareAndSwap(context.Background(), next.StateID, 1, next); err == nil {
				t.Fatal("invalid high-water transition was accepted")
			}
			if s3Client.putCalls != putCalls || dynamoClient.updateCalls != updateCalls {
				t.Fatal("invalid high-water transition wrote state before rejection")
			}
		})
	}

	t.Run("decrease and same-version replacement", func(t *testing.T) {
		store, s3Client, dynamoClient, pending := newLoaded(t)
		pending.Revision = 2
		setSnapshot(&pending, 2, "b")
		if err := store.CompareAndSwap(context.Background(), pending.StateID, 1, pending); err != nil {
			t.Fatal(err)
		}
		for _, testCase := range []struct {
			name   string
			change func(*signingbroker.Checkpoint)
		}{
			{name: "decrease", change: func(next *signingbroker.Checkpoint) {
				next.SnapshotVersionHighWater = 1
				next.PendingSnapshot = nil
			}},
			{name: "same-version replacement", change: func(next *signingbroker.Checkpoint) {
				next.PendingSnapshot.RequestSHA256 = strings.Repeat("c", 64)
				next.PendingSnapshot.RequestObject.SHA256 = strings.Repeat("c", 64)
				next.PendingSnapshot.RequestObject.VersionID = "substituted-request-version"
			}},
		} {
			t.Run(testCase.name, func(t *testing.T) {
				next := pending
				next = cloneTestCheckpoint(next)
				next.Revision = 3
				testCase.change(&next)
				putCalls := s3Client.putCalls
				updateCalls := dynamoClient.updateCalls
				if err := store.CompareAndSwap(context.Background(), next.StateID, 2, next); err == nil {
					t.Fatal("invalid pending transition was accepted")
				}
				if s3Client.putCalls != putCalls || dynamoClient.updateCalls != updateCalls {
					t.Fatal("invalid pending transition wrote state before rejection")
				}
			})
		}
	})
}

func TestStateStorePersistsBurnedTimestampGapThroughRecoveredPublication(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	s3Client := newFakeS3()
	dynamoClient := &fakeDynamo{}
	store, err := NewStateStore(stateTestConfig(now), s3Client, dynamoClient)
	if err != nil {
		t.Fatal(err)
	}
	checkpoint := stateTestCheckpoint(1)
	if err := store.CompareAndSwap(context.Background(), checkpoint.StateID, 0, checkpoint); err != nil {
		t.Fatal(err)
	}
	checkpoint, err = store.Load(context.Background(), checkpoint.StateID)
	if err != nil {
		t.Fatal(err)
	}
	newRequest := func(role, candidate, version string, hashByte byte) *signingbroker.ImmutableRequestObject {
		hash := strings.Repeat(string(hashByte), 64)
		return &signingbroker.ImmutableRequestObject{
			Bucket:    "hid-staging-evidence-123456",
			Key:       fmt.Sprintf("tuf-signing-broker/requests/hid-staging-broker-v1/%s-%s/request.json", role, candidate),
			VersionID: version, SHA256: hash,
		}
	}

	checkpoint.Revision = 2
	checkpoint.SnapshotVersionHighWater = 2
	snapshotRequest2 := newRequest("snapshot", "one", "snapshot-request-v2", 'b')
	checkpoint.PendingSnapshot = &signingbroker.PendingSnapshot{
		CandidateID: "one", RequestSHA256: snapshotRequest2.SHA256, RequestObject: snapshotRequest2,
		ReleaseID: stateTestRelease, CreatedAt: now.Format(time.RFC3339), StateRevision: 2,
		Root: checkpoint.RootHistory[0], Targets: checkpoint.Targets,
		Snapshot: signingbroker.NewMetadataRecord(2, []byte(`{"snapshot":2}`)),
	}
	if err := store.CompareAndSwap(context.Background(), checkpoint.StateID, 1, checkpoint); err != nil {
		t.Fatal(err)
	}

	checkpoint.Revision = 3
	checkpoint.TimestampVersionHighWater = 2
	timestampRequest2 := newRequest("timestamp", "two", "timestamp-request-v2", 'c')
	checkpoint.PendingTimestamp = &signingbroker.PendingTimestamp{
		CandidateID: "two", RequestSHA256: timestampRequest2.SHA256, RequestObject: timestampRequest2,
		ReleaseID: stateTestRelease, CreatedAt: now.Format(time.RFC3339), StateRevision: 3,
		Root: checkpoint.PendingSnapshot.Root, Snapshot: checkpoint.PendingSnapshot.Snapshot,
		Timestamp: signingbroker.NewMetadataRecord(2, []byte(`{"timestamp":2}`)),
	}
	if err := store.CompareAndSwap(context.Background(), checkpoint.StateID, 2, checkpoint); err != nil {
		t.Fatal(err)
	}

	checkpoint.Revision = 4
	checkpoint.SnapshotVersionHighWater = 3
	snapshotRequest3 := newRequest("snapshot", "one", "snapshot-request-v3", 'd')
	checkpoint.PendingSnapshot = &signingbroker.PendingSnapshot{
		CandidateID: "one", RequestSHA256: snapshotRequest3.SHA256, RequestObject: snapshotRequest3,
		ReleaseID: stateTestRelease, CreatedAt: now.Format(time.RFC3339), StateRevision: 4,
		Root: checkpoint.RootHistory[0], Targets: checkpoint.Targets,
		Snapshot: signingbroker.NewMetadataRecord(3, []byte(`{"snapshot":3}`)),
	}
	checkpoint.PendingTimestamp = nil
	if err := store.CompareAndSwap(context.Background(), checkpoint.StateID, 3, checkpoint); err != nil {
		t.Fatal(err)
	}
	reloaded, err := store.Load(context.Background(), checkpoint.StateID)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.TimestampVersionHighWater != 2 || reloaded.Timestamp.Version != 1 ||
		reloaded.PendingSnapshot == nil || reloaded.PendingTimestamp != nil {
		t.Fatalf("burned timestamp gap did not survive manifest round-trip: %+v", reloaded)
	}

	reloaded.Revision = 5
	reloaded.TimestampVersionHighWater = 3
	timestampRequest3 := newRequest("timestamp", "two", "timestamp-request-v3", 'e')
	reloaded.PendingTimestamp = &signingbroker.PendingTimestamp{
		CandidateID: "two", RequestSHA256: timestampRequest3.SHA256, RequestObject: timestampRequest3,
		ReleaseID: stateTestRelease, CreatedAt: now.Format(time.RFC3339), StateRevision: 5,
		Root: reloaded.PendingSnapshot.Root, Snapshot: reloaded.PendingSnapshot.Snapshot,
		Timestamp: signingbroker.NewMetadataRecord(3, []byte(`{"timestamp":3}`)),
	}
	if err := store.CompareAndSwap(context.Background(), reloaded.StateID, 4, reloaded); err != nil {
		t.Fatal(err)
	}

	reloaded.Revision = 6
	reloaded.Snapshot = reloaded.PendingSnapshot.Snapshot
	reloaded.Timestamp = reloaded.PendingTimestamp.Timestamp
	reloaded.PendingSnapshot = nil
	reloaded.PendingTimestamp = nil
	if err := store.CompareAndSwap(context.Background(), reloaded.StateID, 5, reloaded); err != nil {
		t.Fatal(err)
	}
	final, err := store.Load(context.Background(), reloaded.StateID)
	if err != nil {
		t.Fatal(err)
	}
	if final.Snapshot.Version != 3 || final.Timestamp.Version != 3 ||
		final.SnapshotVersionHighWater != 3 || final.TimestampVersionHighWater != 3 ||
		final.PendingSnapshot != nil || final.PendingTimestamp != nil {
		t.Fatalf("recovered publication lost monotonic high-water state: %+v", final)
	}
}

func TestStateStoreObjectsRemainReadableBeyondEvidenceRetention(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	clockNow := now
	config := stateTestConfig(now)
	config.Clock = func() time.Time { return clockNow }
	s3Client := newFakeS3()
	dynamoClient := &fakeDynamo{}
	store, err := NewStateStore(config, s3Client, dynamoClient)
	if err != nil {
		t.Fatal(err)
	}
	checkpoint := stateTestCheckpoint(1)
	if err := store.CompareAndSwap(context.Background(), checkpoint.StateID, 0, checkpoint); err != nil {
		t.Fatal(err)
	}
	clockNow = now.Add(366 * 24 * time.Hour)
	loaded, err := store.Load(context.Background(), checkpoint.StateID)
	if err != nil {
		t.Fatalf("long-lived broker state expired with the evidence window: %v", err)
	}
	if !reflect.DeepEqual(loaded, checkpoint) {
		t.Fatal("long-lived broker state changed after the evidence window")
	}
}
