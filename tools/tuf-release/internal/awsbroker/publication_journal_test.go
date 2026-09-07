package awsbroker

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/publicationjournal"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/signingbroker"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dynamotypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

type journalFakeS3 struct {
	*fakeS3
	writeMu                   sync.Mutex
	failAfterWrite            bool
	weakenRetentionAfterWrite bool
	deleteMarker              bool
	lastList                  *s3.ListObjectVersionsInput
	lastPut                   *s3.PutObjectInput
}

func (client *journalFakeS3) PutObject(ctx context.Context, input *s3.PutObjectInput, options ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	client.writeMu.Lock()
	defer client.writeMu.Unlock()
	client.lastPut = input
	if aws.ToString(input.IfNoneMatch) != "*" {
		return nil, errors.New("missing conditional create")
	}
	client.mu.Lock()
	for key := range client.objects {
		if strings.HasPrefix(key, aws.ToString(input.Key)+"\x00") {
			client.mu.Unlock()
			return nil, errors.New("precondition failed: immutable slot exists")
		}
	}
	client.mu.Unlock()
	output, err := client.fakeS3.PutObject(ctx, input, options...)
	if client.weakenRetentionAfterWrite && output != nil {
		client.mu.Lock()
		key := objectMapKey(aws.ToString(input.Key), aws.ToString(output.VersionId))
		object := client.objects[key]
		// Leave a still-active year so the shared immutable reader succeeds;
		// ArchiveEvidence must independently reject loss of its original century.
		object.retainUntil = aws.ToTime(input.ObjectLockRetainUntilDate).Add(-time.Duration(StateRetentionDays-365) * 24 * time.Hour)
		client.objects[key] = object
		client.mu.Unlock()
	}
	if client.failAfterWrite {
		return nil, errors.New("simulated lost S3 commit response")
	}
	return output, err
}

func (client *journalFakeS3) ListObjectVersions(_ context.Context, input *s3.ListObjectVersionsInput, _ ...func(*s3.Options)) (*s3.ListObjectVersionsOutput, error) {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.lastList = input
	if aws.ToInt32(input.MaxKeys) != 2 || aws.ToString(input.ExpectedBucketOwner) != "123456789012" {
		return nil, errors.New("unbounded or unpinned version inventory")
	}
	output := &s3.ListObjectVersionsOutput{IsTruncated: aws.Bool(false)}
	for key, object := range client.objects {
		objectKey := strings.Split(key, "\x00")[0]
		if strings.HasPrefix(objectKey, aws.ToString(input.Prefix)) {
			output.Versions = append(output.Versions, s3types.ObjectVersion{Key: aws.String(objectKey), VersionId: aws.String(object.versionID), IsLatest: aws.Bool(true)})
		}
	}
	if client.deleteMarker {
		output.DeleteMarkers = []s3types.DeleteMarkerEntry{{Key: input.Prefix, VersionId: aws.String("deleted-version")}}
	}
	return output, nil
}

type journalFakeDynamo struct {
	mu               sync.Mutex
	item             map[string]dynamotypes.AttributeValue
	history          []map[string]dynamotypes.AttributeValue
	failBeforeCommit bool
	failAfterCommit  bool
	lastGet          *dynamodb.GetItemInput
	lastUpdate       *dynamodb.UpdateItemInput
}

func (client *journalFakeDynamo) GetItem(_ context.Context, input *dynamodb.GetItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.lastGet = input
	if !aws.ToBool(input.ConsistentRead) {
		return nil, errors.New("publication head was not read consistently")
	}
	return &dynamodb.GetItemOutput{Item: cloneAttributes(client.item)}, nil
}

func (client *journalFakeDynamo) UpdateItem(_ context.Context, input *dynamodb.UpdateItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.lastUpdate = input
	if client.failBeforeCommit {
		return nil, errors.New("simulated DynamoDB outage")
	}
	for name := range input.ExpressionAttributeNames {
		if !strings.Contains(aws.ToString(input.ConditionExpression)+" "+aws.ToString(input.UpdateExpression), name) {
			return nil, errors.New("unused expression attribute name")
		}
	}
	values := input.ExpressionAttributeValues
	if values[":oldRevision"] == nil {
		if len(client.item) != 0 {
			return nil, &dynamotypes.ConditionalCheckFailedException{}
		}
		if aws.ToString(input.ConditionExpression) != "attribute_not_exists(#state) AND attribute_not_exists(#record)" {
			return nil, errors.New("unconditional genesis head")
		}
	} else if !reflect.DeepEqual(client.item["revision"], values[":oldRevision"]) || !reflect.DeepEqual(client.item["journal"], values[":oldJournal"]) || !reflect.DeepEqual(client.item["schema_version"], values[":schema"]) {
		return nil, &dynamotypes.ConditionalCheckFailedException{}
	}
	client.item = cloneAttributes(input.Key)
	client.item["schema_version"], client.item["revision"], client.item["journal"] = values[":schema"], values[":revision"], values[":journal"]
	client.history = append(client.history, cloneAttributes(client.item))
	if client.failAfterCommit {
		return nil, errors.New("simulated lost DynamoDB commit response")
	}
	return &dynamodb.UpdateItemOutput{}, nil
}

func journalFixture(t *testing.T) (*PublicationJournalStore, *publicationjournal.Controller, *journalFakeS3, *journalFakeDynamo, publicationjournal.Binding, *time.Time) {
	t.Helper()
	now := time.Date(2026, 9, 5, 12, 0, 0, 0, time.UTC)
	policy := publicationjournal.Config{Environment: "staging", RepositoryID: "hid-staging-v1", StateID: "hid-staging-broker-v1", BootstrapRootSHA256: strings.Repeat("a", 64),
		GitHubRepository: "D-Eminence/hid-system", WorkflowRef: "D-Eminence/hid-system/.github/workflows/tuf-publish.yml@" + strings.Repeat("c", 40)}
	s3Client := &journalFakeS3{fakeS3: newFakeS3()}
	dynamo := &journalFakeDynamo{}
	config := PublicationJournalConfig{Policy: policy, TableName: "hid-staging-tuf-broker-state", BucketName: "hid-staging-evidence-123456",
		ObjectPrefix: "tuf-publication-journal/hid-staging-publication-v1/", ExpectedBucketOwner: "123456789012",
		EncryptionKeyARN: "arn:aws:kms:us-east-1:123456789012:key/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", ObjectLockMode: "GOVERNANCE"}
	store, err := NewPublicationJournalStore(config, s3Client, dynamo, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	controller, err := publicationjournal.New(policy, store, store.clock)
	if err != nil {
		t.Fatal(err)
	}
	role := signingbroker.PublicationRole{Version: 1, SHA256: policy.BootstrapRootSHA256}
	binding := publicationjournal.Binding{Owner: "123:1", GitSHA: strings.Repeat("a", 40), ArtifactIdentity: "environments/staging/releases/" + stateTestRelease + "/release-bundle.json",
		ArtifactSHA256: strings.Repeat("a", 64), ArtifactSetSHA256: strings.Repeat("b", 64), GitHubRepository: policy.GitHubRepository, WorkflowRef: policy.WorkflowRef, ActorID: "12345",
		RepositorySHA256: strings.Repeat("b", 64), WorkflowSHA256: strings.Repeat("c", 64), ConfigSHA256: strings.Repeat("d", 64), ExecutableSHA256: strings.Repeat("e", 64),
		Authorization: signingbroker.PublicationAuthorization{SchemaVersion: "1.0.0", Environment: policy.Environment, RepositoryID: policy.RepositoryID, StateID: policy.StateID,
			BootstrapRootSHA256: policy.BootstrapRootSHA256, ReleaseID: stateTestRelease, AuthorizedAt: now.Format(time.RFC3339), ExpiresAt: now.Add(5 * time.Minute).Format(time.RFC3339),
			Candidate: signingbroker.PublicationMetadata{Root: role, Targets: role, Snapshot: role, Timestamp: role}}}
	return store, controller, s3Client, dynamo, binding, &now
}

func buildJournal(t *testing.T, controller *publicationjournal.Controller, binding publicationjournal.Binding) publicationjournal.Record {
	t.Helper()
	current, err := controller.Begin(context.Background(), binding)
	if err != nil {
		t.Fatal(err)
	}
	for _, phase := range []publicationjournal.Phase{publicationjournal.ArchiveVerified, publicationjournal.UploadStarted, publicationjournal.Uploaded} {
		current, err = controller.Advance(context.Background(), binding.Owner, current.Revision, phase, strings.Repeat("f", 64), binding.Authorization)
		if err != nil {
			t.Fatal(err)
		}
	}
	return current
}

func TestDurablePublicationJournalRoundTripAndExactStorageEnvelope(t *testing.T) {
	store, controller, s3Client, dynamo, binding, now := journalFixture(t)
	expected := buildJournal(t, controller, binding)
	fresh, err := NewPublicationJournalStore(store.config, s3Client, dynamo, store.clock)
	if err != nil {
		t.Fatal(err)
	}
	actual, err := fresh.Load(context.Background(), store.journalID())
	if err != nil || actual != expected {
		t.Fatalf("durable readback differs: %v", err)
	}
	if len(s3Client.objects) != 4 || len(dynamo.history) != 4 || !aws.ToBool(dynamo.lastGet.ConsistentRead) {
		t.Fatal("journal did not retain all immutable revisions")
	}
	put := s3Client.lastPut
	if aws.ToString(put.IfNoneMatch) != "*" || aws.ToString(put.ExpectedBucketOwner) != store.config.ExpectedBucketOwner ||
		aws.ToString(put.SSEKMSKeyId) != store.config.EncryptionKeyARN || !aws.ToTime(put.ObjectLockRetainUntilDate).Equal(now.Add(time.Duration(StateRetentionDays)*24*time.Hour)) {
		t.Fatal("immutable journal put omitted fixed integrity/retention pins")
	}
	if dynamo.lastUpdate.Key["state_id"].(*dynamotypes.AttributeValueMemberS).Value != store.journalID() ||
		strings.Contains(aws.ToString(dynamo.lastUpdate.ConditionExpression), "attribute_not_exists") {
		t.Fatal("journal did not isolate exact predecessor CAS")
	}
}

func TestDurablePublicationJournalRejectsTamperingTruncationAndReplay(t *testing.T) {
	for _, scenario := range []string{"old-head", "deleted-head", "missing-middle", "changed-middle", "duplicate-version", "delete-marker", "wrong-head-version", "head-duplicate-json", "head-environment", "weak-retention", "wrong-kms", "wrong-checksum"} {
		t.Run(scenario, func(t *testing.T) {
			store, controller, s3Client, dynamo, binding, _ := journalFixture(t)
			buildJournal(t, controller, binding)
			var middleKey string
			for key := range s3Client.objects {
				if strings.HasPrefix(key, store.slotKey(2)+"\x00") {
					middleKey = key
				}
			}
			object := s3Client.objects[middleKey]
			switch scenario {
			case "old-head":
				dynamo.item = cloneAttributes(dynamo.history[1])
			case "deleted-head":
				dynamo.item = nil
			case "missing-middle":
				delete(s3Client.objects, middleKey)
			case "changed-middle":
				object.data = append(object.data, '\n')
				s3Client.objects[middleKey] = object
			case "duplicate-version":
				object.versionID = "duplicate-version"
				s3Client.objects[objectMapKey(store.slotKey(2), object.versionID)] = object
			case "delete-marker":
				s3Client.deleteMarker = true
			case "weak-retention":
				object.retainUntil = time.Unix(1, 0)
				s3Client.objects[middleKey] = object
			case "wrong-kms":
				object.kmsKey = "other-key"
				s3Client.objects[middleKey] = object
			case "wrong-checksum":
				object.checksum = "bad"
				s3Client.objects[middleKey] = object
			case "head-environment":
				dynamo.item["state_id"] = &dynamotypes.AttributeValueMemberS{Value: "hid-production-publication-v1"}
			case "head-duplicate-json":
				value := dynamo.item["journal"].(*dynamotypes.AttributeValueMemberS).Value
				dynamo.item["journal"] = &dynamotypes.AttributeValueMemberS{Value: strings.Replace(value, "{", `{"revision":4,`, 1)}
			case "wrong-head-version":
				var ref publicationJournalRef
				_ = json.Unmarshal([]byte(dynamo.item["journal"].(*dynamotypes.AttributeValueMemberS).Value), &ref)
				ref.VersionID = "substituted-version"
				data, _ := json.Marshal(ref)
				dynamo.item["journal"] = &dynamotypes.AttributeValueMemberS{Value: string(data)}
			}
			if _, err := store.Load(context.Background(), store.journalID()); err == nil {
				t.Fatal("accepted tampered/truncated journal")
			}
		})
	}
}

func TestPublicationJournalOrphanAndAmbiguousWritesRemainFailures(t *testing.T) {
	for _, scenario := range []string{"lost-s3-response", "head-not-committed", "lost-head-response"} {
		t.Run(scenario, func(t *testing.T) {
			store, controller, s3Client, dynamo, binding, _ := journalFixture(t)
			if scenario == "lost-s3-response" {
				s3Client.failAfterWrite = true
			}
			if scenario == "head-not-committed" {
				dynamo.failBeforeCommit = true
			}
			if scenario == "lost-head-response" {
				dynamo.failAfterCommit = true
			}
			if _, err := controller.Begin(context.Background(), binding); err == nil {
				t.Fatal("ambiguous storage result returned a claim")
			}
			s3Client.failAfterWrite, dynamo.failBeforeCommit, dynamo.failAfterCommit = false, false, false
			if len(s3Client.objects) != 1 {
				t.Fatal("lost immutable evidence of the interrupted claim")
			}
			if _, err := controller.Begin(context.Background(), binding); err == nil {
				t.Fatal("interrupted claim was silently retried")
			}
			_, err := store.Load(context.Background(), store.journalID())
			if scenario != "lost-head-response" && !errors.Is(err, publicationjournal.ErrUnresolved) {
				t.Fatalf("orphan slot did not block head recovery: %v", err)
			}
		})
	}
}

func TestImmutableSlotElectsOnlyOneCompetingWriter(t *testing.T) {
	store, _, s3Client, dynamo, binding, _ := journalFixture(t)
	stores := make([]*PublicationJournalStore, 16)
	for index := range stores {
		var err error
		stores[index], err = NewPublicationJournalStore(store.config, s3Client, dynamo, store.clock)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := stores[index].Load(context.Background(), store.journalID()); !errors.Is(err, publicationjournal.ErrNotFound) {
			t.Fatal(err)
		}
	}
	var group sync.WaitGroup
	var mu sync.Mutex
	successes := 0
	for index, candidateStore := range stores {
		group.Add(1)
		go func(index int, candidateStore *PublicationJournalStore) {
			defer group.Done()
			candidate := binding
			candidate.Owner = strconv.Itoa(index+1) + ":1"
			next := publicationjournal.Record{SchemaVersion: "1.0.0", Revision: 1, Binding: candidate, Phase: publicationjournal.Claimed,
				ClaimedAt: binding.Authorization.AuthorizedAt, UpdatedAt: binding.Authorization.AuthorizedAt, Result: "pending", ResumeDisposition: "same-run-only"}
			if err := candidateStore.CompareAndSwap(context.Background(), store.journalID(), 0, next); err == nil {
				mu.Lock()
				successes++
				mu.Unlock()
			}
		}(index, candidateStore)
	}
	group.Wait()
	if successes != 1 || len(s3Client.objects) != 1 || len(dynamo.history) != 1 {
		t.Fatalf("competing slot writes succeeded %d times", successes)
	}
}
