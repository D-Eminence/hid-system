package signingbroker

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/repository"
	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

const (
	testReleaseOne = "r0000000001-gaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testReleaseTwo = "r0000000002-gbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

type testGeneration struct {
	prepared         repository.PreparedTargets
	releaseID        string
	rootBytes        []byte
	targetsBytes     []byte
	snapshotBytes    []byte
	timestampBytes   []byte
	rootVersion      int64
	targetsVersion   int64
	snapshotVersion  int64
	timestampVersion int64
}

type brokerFixture struct {
	now       time.Time
	root      *metadata.Metadata[metadata.RootType]
	rootBytes []byte
	keys      map[string][]*ecdsa.PrivateKey
	initial   testGeneration
	store     *memoryStore
}

type memoryStore struct {
	mu              sync.Mutex
	checkpoint      *Checkpoint
	loadCalls       int
	casCalls        int
	forceConflict   bool
	commitThenError bool
	decisions       []CompletedDecision
}

func (store *memoryStore) Load(_ context.Context, stateID string) (Checkpoint, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.loadCalls++
	if store.checkpoint == nil || store.checkpoint.StateID != stateID {
		return Checkpoint{}, ErrStateNotFound
	}
	return cloneCheckpoint(*store.checkpoint), nil
}

func (store *memoryStore) CompareAndSwap(_ context.Context, stateID string, expected int64, next Checkpoint) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.casCalls++
	if store.forceConflict || next.StateID != stateID {
		return ErrStateConflict
	}
	if expected == 0 {
		if store.checkpoint != nil || next.Revision != 1 {
			return ErrStateConflict
		}
	} else if store.checkpoint == nil || store.checkpoint.Revision != expected || next.Revision != expected+1 {
		return ErrStateConflict
	}
	cloned := cloneCheckpoint(next)
	store.checkpoint = &cloned
	store.archiveDecisions(next)
	if store.commitThenError {
		store.commitThenError = false
		return errors.New("simulated lost CAS response")
	}
	return nil
}

func (store *memoryStore) LoadCompletedDecision(_ context.Context, lookup DecisionLookup) (CompletedDecision, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.checkpoint == nil {
		return CompletedDecision{}, ErrDecisionNotFound
	}
	for _, decision := range store.decisions {
		if lookup.StateID == store.checkpoint.StateID && decision.Role == lookup.Role &&
			decision.CandidateID == lookup.CandidateID && decision.RequestSHA256 == lookup.RequestSHA256 &&
			sameImmutableRequestObject(decision.RequestObject, lookup.RequestObject) {
			return cloneCompletedDecision(decision), nil
		}
	}
	return CompletedDecision{}, ErrDecisionNotFound
}

func (store *memoryStore) archiveDecisions(checkpoint Checkpoint) {
	archive := func(decision CompletedDecision) {
		for _, existing := range store.decisions {
			if existing.Role == decision.Role && existing.CandidateID == decision.CandidateID &&
				existing.RequestSHA256 == decision.RequestSHA256 &&
				sameImmutableRequestObject(existing.RequestObject, decision.RequestObject) {
				return
			}
		}
		store.decisions = append(store.decisions, cloneCompletedDecision(decision))
	}
	if pending := checkpoint.PendingSnapshot; pending != nil {
		archive(CompletedDecision{
			Role: "snapshot", CandidateID: pending.CandidateID,
			RequestSHA256: pending.RequestSHA256,
			RequestObject: cloneImmutableRequestObject(pending.RequestObject),
			ReleaseID:     pending.ReleaseID, CreatedAt: pending.CreatedAt,
			Root: pending.Root, Input: pending.Targets, Output: pending.Snapshot,
			StateRevision: pending.StateRevision,
		})
	}
	if pending := checkpoint.PendingTimestamp; pending != nil {
		archive(CompletedDecision{
			Role: "timestamp", CandidateID: pending.CandidateID,
			RequestSHA256: pending.RequestSHA256,
			RequestObject: cloneImmutableRequestObject(pending.RequestObject),
			ReleaseID:     pending.ReleaseID, CreatedAt: pending.CreatedAt,
			Root: pending.Root, Input: pending.Snapshot, Output: pending.Timestamp,
			StateRevision: pending.StateRevision,
		})
	}
}

func cloneCompletedDecision(decision CompletedDecision) CompletedDecision {
	result := decision
	result.RequestObject = cloneImmutableRequestObject(decision.RequestObject)
	result.Root = cloneRecord(decision.Root)
	result.Input = cloneRecord(decision.Input)
	result.Output = cloneRecord(decision.Output)
	return result
}

type trackingSigner struct {
	inner      signature.Signer
	beforeSign func()
	mu         sync.Mutex
	calls      int
}

func (signer *trackingSigner) PublicKey(options ...signature.PublicKeyOption) (crypto.PublicKey, error) {
	return signer.inner.PublicKey(options...)
}

func (signer *trackingSigner) SignMessage(message io.Reader, options ...signature.SignOption) ([]byte, error) {
	signer.mu.Lock()
	signer.calls++
	signer.mu.Unlock()
	if signer.beforeSign != nil {
		signer.beforeSign()
	}
	return signer.inner.SignMessage(message, options...)
}

func (signer *trackingSigner) callCount() int {
	signer.mu.Lock()
	defer signer.mu.Unlock()
	return signer.calls
}

type trackingFactory struct {
	mu      sync.Mutex
	signer  signature.Signer
	calls   int
	configs []SignerConfig
}

func (factory *trackingFactory) NewSigner(_ context.Context, config SignerConfig) (signature.Signer, error) {
	factory.mu.Lock()
	defer factory.mu.Unlock()
	factory.calls++
	factory.configs = append(factory.configs, config)
	return factory.signer, nil
}

func (factory *trackingFactory) callCount() int {
	factory.mu.Lock()
	defer factory.mu.Unlock()
	return factory.calls
}

func TestBrokerSignsStateDerivedGenerationAndCanaryAdvancesExactBytes(t *testing.T) {
	fixture := newBrokerFixture(t)
	next := fixture.generation(t, testReleaseTwo, 2, 2, 2)

	snapshotSigner := newTrackingSigner(t, fixture.keys[metadata.SNAPSHOT][0])
	snapshotFactory := &trackingFactory{signer: snapshotSigner}
	snapshotBroker := fixture.broker(t, "snapshot", "one", fixture.keys[metadata.SNAPSHOT][0], snapshotFactory)
	snapshotRequest := fixture.requestBytes(t, "snapshot", next.releaseID, next.rootBytes, next.rootVersion, next.targetsBytes, next.targetsVersion)
	snapshotResult, err := snapshotBroker.Sign(context.Background(), snapshotRequest)
	if err != nil {
		t.Fatal(err)
	}
	if snapshotResult.OutputVersion != 2 || snapshotResult.StateRevision != 2 || snapshotResult.IdempotentReplay ||
		snapshotResult.OutputSHA256 != digestHex(snapshotResult.OutputBytes) || snapshotSigner.callCount() != 1 {
		t.Fatalf("unexpected snapshot result: %+v, sign calls=%d", snapshotResult, snapshotSigner.callCount())
	}
	replayed, err := snapshotBroker.Sign(context.Background(), snapshotRequest)
	if err != nil {
		t.Fatal(err)
	}
	if !replayed.IdempotentReplay || !bytes.Equal(replayed.OutputBytes, snapshotResult.OutputBytes) || snapshotSigner.callCount() != 1 {
		t.Fatal("identical snapshot retry did not return stored output without signing")
	}

	timestampSigner := newTrackingSigner(t, fixture.keys[metadata.TIMESTAMP][0])
	timestampFactory := &trackingFactory{signer: timestampSigner}
	timestampBroker := fixture.broker(t, "timestamp", "one", fixture.keys[metadata.TIMESTAMP][0], timestampFactory)
	timestampRequest := fixture.requestBytes(
		t, "timestamp", next.releaseID, next.rootBytes, next.rootVersion,
		snapshotResult.OutputBytes, snapshotResult.OutputVersion,
	)
	timestampResult, err := timestampBroker.Sign(context.Background(), timestampRequest)
	if err != nil {
		t.Fatal(err)
	}
	if timestampResult.OutputVersion != 2 || timestampResult.StateRevision != 3 || timestampSigner.callCount() != 1 {
		t.Fatalf("unexpected timestamp result: %+v", timestampResult)
	}

	advanced, err := timestampBroker.AdvancePublished(context.Background(), PublishedGeneration{
		Environment: "staging", ReleaseID: next.releaseID, RootBytes: next.rootBytes,
		TargetsBytes: next.targetsBytes, SnapshotBytes: snapshotResult.OutputBytes,
		TimestampBytes: timestampResult.OutputBytes,
	})
	if err != nil {
		t.Fatal(err)
	}
	if advanced.Revision != 4 || advanced.ReleaseID != next.releaseID || advanced.Targets.Version != 2 ||
		advanced.Snapshot.Version != 2 || advanced.Timestamp.Version != 2 ||
		advanced.PendingSnapshot != nil || advanced.PendingTimestamp != nil {
		t.Fatalf("canary did not advance the exact complete pending generation: %+v", advanced)
	}

	changed := timestampResult.OutputBytes
	changed = append(bytes.Clone(changed), '\n')
	if _, err := timestampBroker.AdvancePublished(context.Background(), PublishedGeneration{
		Environment: "staging", ReleaseID: next.releaseID, RootBytes: next.rootBytes,
		TargetsBytes: next.targetsBytes, SnapshotBytes: snapshotResult.OutputBytes,
		TimestampBytes: changed,
	}); err == nil {
		t.Fatal("canary advanced bytes outside a pending broker authorization")
	}
}

func TestPublicationControllerVerifiesCurrentGenerationWithoutConsumingPendingOutput(t *testing.T) {
	fixture := newBrokerFixture(t)
	controller, err := NewPublicationController(PublicationConfig{
		Environment: "staging", RepositoryID: "hid-staging-v1", StateID: fixture.store.checkpoint.StateID,
		BootstrapRootSHA256: digestHex(fixture.initial.rootBytes),
	}, fixture.store, func() time.Time { return fixture.now })
	if err != nil {
		t.Fatal(err)
	}
	current := PublishedGeneration{
		Environment: "staging", ReleaseID: fixture.initial.releaseID,
		RootBytes: fixture.initial.rootBytes, TargetsBytes: fixture.initial.targetsBytes,
		SnapshotBytes: fixture.initial.snapshotBytes, TimestampBytes: fixture.initial.timestampBytes,
	}
	beforeCAS := fixture.store.casCalls
	verified, err := controller.VerifyPublished(context.Background(), current)
	if err != nil {
		t.Fatal(err)
	}
	if verified.Revision != 1 || fixture.store.casCalls != beforeCAS {
		t.Fatal("current-generation verification mutated durable state")
	}

	next := fixture.generation(t, testReleaseTwo, 2, 2, 2)
	snapshotBroker := fixture.broker(
		t, "snapshot", "one", fixture.keys[metadata.SNAPSHOT][0],
		&trackingFactory{signer: newTrackingSigner(t, fixture.keys[metadata.SNAPSHOT][0])},
	)
	if _, err := snapshotBroker.Sign(context.Background(), fixture.requestBytes(
		t, "snapshot", next.releaseID, next.rootBytes, next.rootVersion, next.targetsBytes, next.targetsVersion,
	)); err != nil {
		t.Fatal(err)
	}
	verified, err = controller.VerifyPublished(context.Background(), current)
	if err != nil {
		t.Fatal(err)
	}
	if verified.PendingSnapshot == nil || fixture.store.checkpoint.PendingSnapshot == nil {
		t.Fatal("read-only current verification consumed pending snapshot authorization")
	}
	tampered := current
	tampered.TimestampBytes = append(bytes.Clone(current.TimestampBytes), '\n')
	if _, err := controller.VerifyPublished(context.Background(), tampered); err == nil {
		t.Fatal("changed public generation was accepted as current")
	}
}

func TestBrokerClockAndStrictRequestFailBeforeSigner(t *testing.T) {
	fixture := newBrokerFixture(t)
	generation := fixture.generation(t, testReleaseTwo, 2, 2, 2)
	factory := &trackingFactory{signer: newTrackingSigner(t, fixture.keys[metadata.SNAPSHOT][0])}
	broker := fixture.broker(t, "snapshot", "one", fixture.keys[metadata.SNAPSHOT][0], factory)
	request := fixture.request(t, "snapshot", generation.releaseID, generation.rootBytes, 1, generation.targetsBytes, 2)
	request.CreatedAt = fixture.now.Add(-5*time.Minute - time.Second).Format(time.RFC3339)
	request.Expires = fixture.now.Add(7*24*time.Hour - 5*time.Minute - time.Second).Format(time.RFC3339)
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := broker.Sign(context.Background(), encoded); err == nil || !strings.Contains(err.Error(), "more than 5 minutes old") {
		t.Fatalf("stale request was accepted: %v", err)
	}
	if fixture.store.loadCalls != 1 || factory.callCount() != 0 {
		t.Fatal("stale non-replay request did not stop after the replay-state check")
	}

	unknown := bytes.Replace(encoded, []byte(`{"schema_version":`), []byte(`{"output_version":999,"schema_version":`), 1)
	if _, err := broker.Sign(context.Background(), unknown); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("caller-selected output version was not rejected as unknown: %v", err)
	}
	duplicate := bytes.Replace(encoded, []byte(`{"schema_version":`), []byte(`{"schema_version":"1.0.0","schema_version":`), 1)
	if _, err := broker.Sign(context.Background(), duplicate); err == nil || !strings.Contains(err.Error(), "duplicate object name") {
		t.Fatalf("duplicate request field was accepted: %v", err)
	}
}

func TestBrokerReservesPublicationMarginAndRechecksBeforeCommit(t *testing.T) {
	for _, role := range []string{"snapshot", "timestamp"} {
		t.Run(role+" short margin", func(t *testing.T) {
			fixture := newBrokerFixture(t)
			input := fixture.initial.snapshotBytes
			inputVersion := fixture.initial.snapshotVersion
			key := fixture.keys[metadata.TIMESTAMP][0]
			if role == "snapshot" {
				next := fixture.generation(t, testReleaseTwo, 2, 2, 2)
				input = next.targetsBytes
				inputVersion = next.targetsVersion
				key = fixture.keys[metadata.SNAPSHOT][0]
			}
			request := fixture.request(t, role, testReleaseTwo, fixture.initial.rootBytes, 1, input, inputVersion)
			minimum := 72 * time.Hour
			if role == "timestamp" {
				minimum = 6 * time.Hour
				request.ReleaseID = fixture.initial.releaseID
			}
			request.Expires = fixture.now.Add(minimum + publicationSafetyMargin - time.Second).Format(time.RFC3339)
			encoded, err := json.Marshal(request)
			if err != nil {
				t.Fatal(err)
			}
			factory := &trackingFactory{signer: newTrackingSigner(t, key)}
			broker := fixture.broker(t, role, "one", key, factory)
			if _, err := broker.Sign(context.Background(), encoded); err == nil ||
				!strings.Contains(err.Error(), "operational safety margin") {
				t.Fatalf("request without the publication margin was accepted: %v", err)
			}
			if factory.callCount() != 0 || fixture.store.checkpoint.SnapshotVersionHighWater != 1 ||
				fixture.store.checkpoint.TimestampVersionHighWater != 1 {
				t.Fatal("short-margin request reached a signer or consumed a version")
			}
		})
	}

	t.Run("clock advances during signing", func(t *testing.T) {
		fixture := newBrokerFixture(t)
		next := fixture.generation(t, testReleaseTwo, 2, 2, 2)
		signer := newTrackingSigner(t, fixture.keys[metadata.SNAPSHOT][0])
		signer.beforeSign = func() { fixture.now = fixture.now.Add(5*time.Minute + time.Second) }
		factory := &trackingFactory{signer: signer}
		broker := fixture.broker(t, "snapshot", "one", fixture.keys[metadata.SNAPSHOT][0], factory)
		if _, err := broker.Sign(context.Background(), fixture.requestBytes(
			t, "snapshot", next.releaseID, next.rootBytes, 1, next.targetsBytes, 2,
		)); err == nil || !strings.Contains(err.Error(), "before durable commit") ||
			!strings.Contains(err.Error(), "more than 5 minutes old") {
			t.Fatalf("post-sign clock advance was committed: %v", err)
		}
		if signer.callCount() != 1 || fixture.store.casCalls != 0 ||
			fixture.store.checkpoint.SnapshotVersionHighWater != 1 || fixture.store.checkpoint.PendingSnapshot != nil {
			t.Fatal("failed post-sign freshness gate consumed a version or committed pending state")
		}
	})

	t.Run("offline authority lacks margin", func(t *testing.T) {
		fixture := newBrokerFixture(t)
		next := fixture.generationWithTargetsExpiry(
			t, testReleaseTwo, 2, 2, 2,
			fixture.now.Add(14*24*time.Hour+publicationSafetyMargin-time.Second),
		)
		factory := &trackingFactory{signer: newTrackingSigner(t, fixture.keys[metadata.SNAPSHOT][0])}
		broker := fixture.broker(t, "snapshot", "one", fixture.keys[metadata.SNAPSHOT][0], factory)
		if _, err := broker.Sign(context.Background(), fixture.requestBytes(
			t, "snapshot", next.releaseID, next.rootBytes, 1, next.targetsBytes, 2,
		)); err == nil || !strings.Contains(err.Error(), "authority publication margin") ||
			!errors.Is(err, repository.ErrPublicationRefreshRequired) {
			t.Fatalf("near-floor offline authority reached signing: %v", err)
		}
		if factory.callCount() != 0 || fixture.store.checkpoint.SnapshotVersionHighWater != 1 {
			t.Fatal("near-floor offline authority reached a signer or consumed a version")
		}
	})
}

func TestBrokerReturnsDelayedAndCommitReconciledReplayWithoutSigningAgain(t *testing.T) {
	fixture := newBrokerFixture(t)
	next := fixture.generation(t, testReleaseTwo, 2, 2, 2)
	request := fixture.requestBytes(t, "snapshot", next.releaseID, next.rootBytes, 1, next.targetsBytes, 2)
	requestObject := fixture.requestObject("snapshot", "one", request, "request-version-1")
	signer := newTrackingSigner(t, fixture.keys[metadata.SNAPSHOT][0])
	factory := &trackingFactory{signer: signer}
	now := fixture.now
	config := fixture.brokerConfig(t, "snapshot", "one", fixture.keys[metadata.SNAPSHOT][0])
	broker, err := New(config, fixture.store, factory, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}

	fixture.store.commitThenError = true
	reconciled, err := broker.SignImmutableRequest(context.Background(), request, requestObject, true)
	if err != nil {
		t.Fatal(err)
	}
	if !reconciled.IdempotentReplay || signer.callCount() != 1 || fixture.store.checkpoint.PendingSnapshot == nil ||
		reconciled.RequestObject == nil || *reconciled.RequestObject != requestObject {
		t.Fatal("committed state was not reconciled to its exact stored output")
	}
	reconciled.RequestObject.VersionID = "mutated-result-version"
	if fixture.store.checkpoint.PendingSnapshot.RequestObject.VersionID != requestObject.VersionID {
		t.Fatal("mutating result request provenance changed durable checkpoint state")
	}

	now = now.Add(10 * time.Minute)
	delayed, err := broker.SignImmutableRequest(context.Background(), request, requestObject, false)
	if err != nil {
		t.Fatal(err)
	}
	if !delayed.IdempotentReplay || !bytes.Equal(delayed.OutputBytes, reconciled.OutputBytes) || signer.callCount() != 1 {
		t.Fatal("delayed exact replay reached the signer or returned different output")
	}
	differentVersion := requestObject
	differentVersion.VersionID = "request-version-2"
	if _, err := broker.SignImmutableRequest(context.Background(), request, differentVersion, false); !errors.Is(err, ErrPending) {
		t.Fatalf("different immutable request version replayed an existing authorization: %v", err)
	}
	if signer.callCount() != 1 {
		t.Fatal("different immutable request version reached the signer")
	}
}

func TestBrokerRejectsShortRetentionBeforeNewSigning(t *testing.T) {
	fixture := newBrokerFixture(t)
	next := fixture.generation(t, testReleaseTwo, 2, 2, 2)
	request := fixture.requestBytes(t, "snapshot", next.releaseID, next.rootBytes, 1, next.targetsBytes, 2)
	requestObject := fixture.requestObject("snapshot", "one", request, "request-version-1")
	factory := &trackingFactory{signer: newTrackingSigner(t, fixture.keys[metadata.SNAPSHOT][0])}
	broker := fixture.broker(t, "snapshot", "one", fixture.keys[metadata.SNAPSHOT][0], factory)
	if _, err := broker.SignImmutableRequest(context.Background(), request, requestObject, false); err == nil ||
		!strings.Contains(err.Error(), "minimum remaining retention") {
		t.Fatalf("short-retention immutable request was accepted for new signing: %v", err)
	}
	if factory.callCount() != 0 || fixture.store.checkpoint.PendingSnapshot != nil {
		t.Fatal("short-retention request reached the signer or mutated state")
	}
}

func TestBrokerRejectsCorruptStateTransitionAndWrongSignerBeforeSigning(t *testing.T) {
	fixture := newBrokerFixture(t)
	next := fixture.generation(t, testReleaseTwo, 2, 2, 2)

	t.Run("corrupt durable checkpoint", func(t *testing.T) {
		store := &memoryStore{checkpoint: checkpointPointer(cloneCheckpoint(*fixture.store.checkpoint))}
		store.checkpoint.Timestamp.SHA256 = strings.Repeat("0", 64)
		factory := &trackingFactory{signer: newTrackingSigner(t, fixture.keys[metadata.SNAPSHOT][0])}
		broker := fixture.brokerWithStore(t, store, "snapshot", "one", fixture.keys[metadata.SNAPSHOT][0], factory)
		if _, err := broker.Sign(context.Background(), fixture.requestBytes(
			t, "snapshot", next.releaseID, next.rootBytes, 1, next.targetsBytes, 2,
		)); err == nil {
			t.Fatal("corrupt checkpoint was accepted")
		}
		if factory.callCount() != 0 {
			t.Fatal("corrupt checkpoint initialized a signer")
		}
	})

	t.Run("targets version jump", func(t *testing.T) {
		jump := fixture.generation(t, testReleaseTwo, 3, 2, 2)
		factory := &trackingFactory{signer: newTrackingSigner(t, fixture.keys[metadata.SNAPSHOT][0])}
		broker := fixture.broker(t, "snapshot", "one", fixture.keys[metadata.SNAPSHOT][0], factory)
		if _, err := broker.Sign(context.Background(), fixture.requestBytes(
			t, "snapshot", jump.releaseID, jump.rootBytes, 1, jump.targetsBytes, 3,
		)); err == nil {
			t.Fatal("targets version jump was accepted")
		}
		if factory.callCount() != 0 {
			t.Fatal("invalid targets transition initialized a signer")
		}
	})

	t.Run("factory returns different authorized key", func(t *testing.T) {
		wrong := newTrackingSigner(t, fixture.keys[metadata.SNAPSHOT][1])
		factory := &trackingFactory{signer: wrong}
		broker := fixture.broker(t, "snapshot", "one", fixture.keys[metadata.SNAPSHOT][0], factory)
		if _, err := broker.Sign(context.Background(), fixture.requestBytes(
			t, "snapshot", next.releaseID, next.rootBytes, 1, next.targetsBytes, 2,
		)); err == nil || !strings.Contains(err.Error(), "checksum") {
			t.Fatalf("wrong fixed signer was accepted: %v", err)
		}
		if wrong.callCount() != 0 {
			t.Fatal("wrong fixed signer signed a message")
		}
	})
}

func TestBrokerCASFailureReturnsNoAuthorizedOutputAndPendingBlocksSubstitution(t *testing.T) {
	fixture := newBrokerFixture(t)
	next := fixture.generation(t, testReleaseTwo, 2, 2, 2)
	request := fixture.requestBytes(t, "snapshot", next.releaseID, next.rootBytes, 1, next.targetsBytes, 2)

	fixture.store.forceConflict = true
	signer := newTrackingSigner(t, fixture.keys[metadata.SNAPSHOT][0])
	factory := &trackingFactory{signer: signer}
	broker := fixture.broker(t, "snapshot", "one", fixture.keys[metadata.SNAPSHOT][0], factory)
	result, err := broker.Sign(context.Background(), request)
	if err == nil || !errors.Is(err, ErrStateConflict) || len(result.OutputBytes) != 0 {
		t.Fatalf("CAS conflict returned an authorized output: result=%+v err=%v", result, err)
	}
	if signer.callCount() != 1 || fixture.store.checkpoint.PendingSnapshot != nil {
		t.Fatal("CAS conflict mutated durable pending state")
	}

	fixture.store.forceConflict = false
	if _, err := broker.Sign(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	changed := fixture.request(t, "snapshot", next.releaseID, next.rootBytes, 1, next.targetsBytes, 2)
	changed.Expires = fixture.now.Add(6 * 24 * time.Hour).Format(time.RFC3339)
	changedBytes, err := json.Marshal(changed)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := broker.Sign(context.Background(), changedBytes); !errors.Is(err, ErrPending) {
		t.Fatalf("distinct same-version snapshot request bypassed pending state: %v", err)
	}
}

func TestTimestampRequiresExactBrokerPendingSnapshot(t *testing.T) {
	fixture := newBrokerFixture(t)
	next := fixture.generation(t, testReleaseTwo, 2, 2, 2)
	factory := &trackingFactory{signer: newTrackingSigner(t, fixture.keys[metadata.TIMESTAMP][0])}
	broker := fixture.broker(t, "timestamp", "one", fixture.keys[metadata.TIMESTAMP][0], factory)
	request := fixture.requestBytes(t, "timestamp", next.releaseID, next.rootBytes, 1, next.snapshotBytes, 2)
	if _, err := broker.Sign(context.Background(), request); err == nil || !strings.Contains(err.Error(), "broker-authorized snapshot context") {
		t.Fatalf("unapproved snapshot reached timestamp signing: %v", err)
	}
	if factory.callCount() != 0 {
		t.Fatal("unapproved snapshot initialized timestamp signer")
	}
}

func TestTimestampRefreshCanAdvanceWithoutNewSnapshot(t *testing.T) {
	fixture := newBrokerFixture(t)
	clockNow := fixture.now
	signer := newTrackingSigner(t, fixture.keys[metadata.TIMESTAMP][0])
	factory := &trackingFactory{signer: signer}
	broker, err := New(
		fixture.brokerConfig(t, "timestamp", "one", fixture.keys[metadata.TIMESTAMP][0]),
		fixture.store,
		factory,
		func() time.Time { return clockNow },
	)
	if err != nil {
		t.Fatal(err)
	}
	request := fixture.requestBytes(
		t, "timestamp", fixture.initial.releaseID, fixture.initial.rootBytes, 1,
		fixture.initial.snapshotBytes, 1,
	)
	requestObject := fixture.requestObject("timestamp", "one", request, "timestamp-request-version-1")
	result, err := broker.SignImmutableRequest(context.Background(), request, requestObject, true)
	if err != nil {
		t.Fatal(err)
	}
	if result.OutputVersion != 2 || fixture.store.checkpoint.PendingSnapshot != nil ||
		fixture.store.checkpoint.PendingTimestamp == nil {
		t.Fatal("timestamp-only refresh did not create exactly one pending timestamp")
	}
	advanced, err := broker.AdvancePublished(context.Background(), PublishedGeneration{
		Environment: "staging", ReleaseID: fixture.initial.releaseID,
		RootBytes: fixture.initial.rootBytes, TargetsBytes: fixture.initial.targetsBytes,
		SnapshotBytes: fixture.initial.snapshotBytes, TimestampBytes: result.OutputBytes,
	})
	if err != nil {
		t.Fatal(err)
	}
	if advanced.Targets.Version != 1 || advanced.Snapshot.Version != 1 || advanced.Timestamp.Version != 2 {
		t.Fatalf("timestamp refresh changed non-timestamp state: %+v", advanced)
	}
	for _, delay := range []time.Duration{time.Minute, time.Hour} {
		clockNow = fixture.now.Add(delay)
		replayed, err := broker.SignImmutableRequest(
			context.Background(),
			request,
			requestObject,
			false,
		)
		if err != nil {
			t.Fatalf("completed decision did not replay after %s: %v", delay, err)
		}
		if !replayed.IdempotentReplay || replayed.StateRevision != result.StateRevision ||
			!bytes.Equal(replayed.OutputBytes, result.OutputBytes) || signer.callCount() != 1 {
			t.Fatalf("completed decision replay after %s changed output or reached signer", delay)
		}
	}
}

func TestExpiredPendingGenerationSupersedesWithoutReusingOnlineVersions(t *testing.T) {
	fixture := newBrokerFixture(t)
	next := fixture.generation(t, testReleaseTwo, 2, 2, 2)
	initialDirectory := filepath.Join(t.TempDir(), "published-generation")
	initialInput := generationMaterializationInput(fixture.initial, initialDirectory, fixture.now)
	initialRepository, err := repository.MaterializeGeneration(initialInput)
	if err != nil {
		t.Fatal(err)
	}

	snapshotSigner := newTrackingSigner(t, fixture.keys[metadata.SNAPSHOT][0])
	snapshotBroker := fixture.broker(
		t,
		"snapshot",
		"one",
		fixture.keys[metadata.SNAPSHOT][0],
		&trackingFactory{signer: snapshotSigner},
	)
	timestampSigner := newTrackingSigner(t, fixture.keys[metadata.TIMESTAMP][0])
	timestampBroker := fixture.broker(
		t,
		"timestamp",
		"one",
		fixture.keys[metadata.TIMESTAMP][0],
		&trackingFactory{signer: timestampSigner},
	)

	snapshotRequestV2 := fixture.requestBytes(
		t,
		"snapshot",
		next.releaseID,
		next.rootBytes,
		next.rootVersion,
		next.targetsBytes,
		next.targetsVersion,
	)
	snapshotObjectV2 := fixture.requestObject("snapshot", "one", snapshotRequestV2, "snapshot-request-v2")
	snapshotV2, err := snapshotBroker.SignImmutableRequest(context.Background(), snapshotRequestV2, snapshotObjectV2, true)
	if err != nil {
		t.Fatal(err)
	}
	timestampRequestV2 := fixture.requestBytes(
		t,
		"timestamp",
		next.releaseID,
		next.rootBytes,
		next.rootVersion,
		snapshotV2.OutputBytes,
		snapshotV2.OutputVersion,
	)
	timestampObjectV2 := fixture.requestObject("timestamp", "one", timestampRequestV2, "timestamp-request-v2")
	timestampV2, err := timestampBroker.SignImmutableRequest(context.Background(), timestampRequestV2, timestampObjectV2, true)
	if err != nil {
		t.Fatal(err)
	}
	if snapshotV2.OutputVersion != 2 || timestampV2.OutputVersion != 2 ||
		fixture.store.checkpoint.SnapshotVersionHighWater != 2 ||
		fixture.store.checkpoint.TimestampVersionHighWater != 2 {
		t.Fatal("initial pending generation did not establish version-2 high-water marks")
	}

	fixture.now = fixture.now.Add(4*24*time.Hour + time.Second)
	snapshotRequestV3 := fixture.requestBytes(
		t,
		"snapshot",
		next.releaseID,
		next.rootBytes,
		next.rootVersion,
		next.targetsBytes,
		next.targetsVersion,
	)
	snapshotObjectV3 := fixture.requestObject("snapshot", "one", snapshotRequestV3, "snapshot-request-v3")
	snapshotV3, err := snapshotBroker.SignImmutableRequest(context.Background(), snapshotRequestV3, snapshotObjectV3, true)
	if err != nil {
		t.Fatal(err)
	}
	checkpoint := fixture.store.checkpoint
	if snapshotV3.OutputVersion != 3 || checkpoint.SnapshotVersionHighWater != 3 ||
		checkpoint.TimestampVersionHighWater != 2 || checkpoint.PendingSnapshot == nil ||
		checkpoint.PendingTimestamp != nil {
		t.Fatalf("snapshot recovery did not burn the stale generation safely: %+v", checkpoint)
	}

	for _, replay := range []struct {
		broker  *Broker
		request []byte
		object  ImmutableRequestObject
		want    Result
	}{
		{snapshotBroker, snapshotRequestV2, snapshotObjectV2, snapshotV2},
		{timestampBroker, timestampRequestV2, timestampObjectV2, timestampV2},
	} {
		got, err := replay.broker.SignImmutableRequest(context.Background(), replay.request, replay.object, false)
		if err != nil {
			t.Fatal(err)
		}
		if !got.IdempotentReplay || got.OutputVersion != 2 ||
			!bytes.Equal(got.OutputBytes, replay.want.OutputBytes) {
			t.Fatal("superseded version-2 decision did not replay its exact archived output")
		}
	}
	if snapshotSigner.callCount() != 2 || timestampSigner.callCount() != 1 {
		t.Fatal("completed-decision replay reached an online signer")
	}

	timestampRequestV3 := fixture.requestBytes(
		t,
		"timestamp",
		next.releaseID,
		next.rootBytes,
		next.rootVersion,
		snapshotV3.OutputBytes,
		snapshotV3.OutputVersion,
	)
	timestampObjectV3 := fixture.requestObject("timestamp", "one", timestampRequestV3, "timestamp-request-v3")
	timestampV3, err := timestampBroker.SignImmutableRequest(context.Background(), timestampRequestV3, timestampObjectV3, true)
	if err != nil {
		t.Fatal(err)
	}
	if timestampV3.OutputVersion != 3 || fixture.store.checkpoint.TimestampVersionHighWater != 3 {
		t.Fatal("timestamp recovery reused or skipped its durable high-water successor")
	}
	controller, err := NewPublicationController(PublicationConfig{
		Environment: "staging", RepositoryID: "hid-staging-v1", StateID: fixture.store.checkpoint.StateID,
		BootstrapRootSHA256: digestHex(fixture.rootBytes),
	}, fixture.store, func() time.Time { return fixture.now })
	if err != nil {
		t.Fatal(err)
	}
	recovered := PublishedGeneration{
		Environment: "staging", ReleaseID: next.releaseID, RootBytes: next.rootBytes, TargetsBytes: next.targetsBytes,
		SnapshotBytes: snapshotV3.OutputBytes, TimestampBytes: timestampV3.OutputBytes,
	}
	beforeAuthorizationCAS := fixture.store.casCalls
	authorization, err := controller.AuthorizePendingPublication(context.Background(), publicationTestGeneration(fixture.initial), recovered)
	if err != nil {
		t.Fatal(err)
	}
	if authorization.Candidate.Snapshot.Version != 3 || authorization.Candidate.Timestamp.Version != 3 ||
		authorization.Current.Timestamp.Version != 1 || fixture.store.casCalls != beforeAuthorizationCAS {
		t.Fatal("recovered gap did not receive read-only exact state authorization")
	}
	stale := recovered
	stale.SnapshotBytes, stale.TimestampBytes = snapshotV2.OutputBytes, timestampV2.OutputBytes
	if _, err := controller.AuthorizePendingPublication(context.Background(), publicationTestGeneration(fixture.initial), stale); err == nil {
		t.Fatal("superseded pending output was authorized for upload")
	}
	recoveredInput := generationMaterializationInput(next, filepath.Join(t.TempDir(), "recovered-generation"), fixture.now)
	recoveredInput.PreviousDirectory = initialDirectory
	recoveredInput.PreviousRepositorySHA256 = initialRepository.RepositorySHA256
	recoveredInput.SnapshotBytes, recoveredInput.TimestampBytes = recovered.SnapshotBytes, recovered.TimestampBytes
	recoveredInput.ExpectedSnapshotVersion, recoveredInput.ExpectedTimestampVersion = 3, 3
	if _, err := repository.MaterializeGeneration(recoveredInput); err == nil {
		t.Fatal("ordinary materializer accepted a recovered online gap")
	}
	recoveredRepository, err := repository.MaterializePendingGeneration(context.Background(), recoveredInput, controller)
	if err != nil {
		t.Fatal(err)
	}
	verifyRecoveredPublicationRepository(t, recoveredRepository, fixture.now)
	if _, err := os.Stat(filepath.Join(recoveredRepository.Repository, "metadata", "2.snapshot.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("superseded private snapshot leaked into published history")
	}
	if _, err := os.Stat(filepath.Join(recoveredRepository.Repository, "metadata", "1.snapshot.json")); err != nil {
		t.Fatal("published immutable snapshot was not retained")
	}
	advanced, err := timestampBroker.AdvancePublished(context.Background(), PublishedGeneration{
		Environment: "staging", ReleaseID: next.releaseID,
		RootBytes: next.rootBytes, TargetsBytes: next.targetsBytes,
		SnapshotBytes: snapshotV3.OutputBytes, TimestampBytes: timestampV3.OutputBytes,
	})
	if err != nil {
		t.Fatal(err)
	}
	if advanced.Snapshot.Version != 3 || advanced.Timestamp.Version != 3 ||
		advanced.SnapshotVersionHighWater != 3 || advanced.TimestampVersionHighWater != 3 ||
		advanced.PendingSnapshot != nil || advanced.PendingTimestamp != nil {
		t.Fatalf("recovered generation did not publish at the burned-version successors: %+v", advanced)
	}
}

func TestPendingRecoveryFreshnessBoundariesAndClockRollbackFailClosed(t *testing.T) {
	t.Run("snapshot", func(t *testing.T) {
		fixture := newBrokerFixture(t)
		next := fixture.generation(t, testReleaseTwo, 2, 2, 2)
		signer := newTrackingSigner(t, fixture.keys[metadata.SNAPSHOT][0])
		broker := fixture.broker(t, "snapshot", "one", fixture.keys[metadata.SNAPSHOT][0], &trackingFactory{signer: signer})
		requestV2 := fixture.requestBytes(t, "snapshot", next.releaseID, next.rootBytes, 1, next.targetsBytes, 2)
		if _, err := broker.Sign(context.Background(), requestV2); err != nil {
			t.Fatal(err)
		}
		fixture.now = fixture.now.Add(4 * 24 * time.Hour)
		atBoundary := fixture.requestBytes(t, "snapshot", next.releaseID, next.rootBytes, 1, next.targetsBytes, 2)
		if _, err := broker.Sign(context.Background(), atBoundary); !errors.Is(err, ErrPending) {
			t.Fatalf("exactly 72 hours of snapshot freshness did not preserve pending state: %v", err)
		}
		fixture.now = fixture.now.Add(time.Second)
		belowBoundary := fixture.requestBytes(t, "snapshot", next.releaseID, next.rootBytes, 1, next.targetsBytes, 2)
		result, err := broker.Sign(context.Background(), belowBoundary)
		if err != nil {
			t.Fatal(err)
		}
		if result.OutputVersion != 3 || signer.callCount() != 2 {
			t.Fatal("snapshot did not supersede exactly below its publication threshold")
		}
	})

	t.Run("timestamp", func(t *testing.T) {
		fixture := newBrokerFixture(t)
		signer := newTrackingSigner(t, fixture.keys[metadata.TIMESTAMP][0])
		broker := fixture.broker(t, "timestamp", "one", fixture.keys[metadata.TIMESTAMP][0], &trackingFactory{signer: signer})
		requestV2 := fixture.requestBytes(
			t, "timestamp", fixture.initial.releaseID, fixture.initial.rootBytes, 1,
			fixture.initial.snapshotBytes, 1,
		)
		if _, err := broker.Sign(context.Background(), requestV2); err != nil {
			t.Fatal(err)
		}
		fixture.now = fixture.now.Add(18 * time.Hour)
		atBoundary := fixture.requestBytes(
			t, "timestamp", fixture.initial.releaseID, fixture.initial.rootBytes, 1,
			fixture.initial.snapshotBytes, 1,
		)
		if _, err := broker.Sign(context.Background(), atBoundary); !errors.Is(err, ErrPending) {
			t.Fatalf("exactly 6 hours of timestamp freshness did not preserve pending state: %v", err)
		}
		fixture.now = fixture.now.Add(time.Second)
		belowBoundary := fixture.requestBytes(
			t, "timestamp", fixture.initial.releaseID, fixture.initial.rootBytes, 1,
			fixture.initial.snapshotBytes, 1,
		)
		result, err := broker.Sign(context.Background(), belowBoundary)
		if err != nil {
			t.Fatal(err)
		}
		if result.OutputVersion != 3 || signer.callCount() != 2 {
			t.Fatal("timestamp did not supersede exactly below its publication threshold")
		}
	})

	t.Run("clock rollback", func(t *testing.T) {
		fixture := newBrokerFixture(t)
		next := fixture.generation(t, testReleaseTwo, 2, 2, 2)
		signer := newTrackingSigner(t, fixture.keys[metadata.SNAPSHOT][0])
		broker := fixture.broker(t, "snapshot", "one", fixture.keys[metadata.SNAPSHOT][0], &trackingFactory{signer: signer})
		requestV2 := fixture.requestBytes(t, "snapshot", next.releaseID, next.rootBytes, 1, next.targetsBytes, 2)
		if _, err := broker.Sign(context.Background(), requestV2); err != nil {
			t.Fatal(err)
		}
		fixture.now = fixture.now.Add(-time.Minute)
		rollbackRequest := fixture.requestBytes(t, "snapshot", next.releaseID, next.rootBytes, 1, next.targetsBytes, 2)
		if _, err := broker.Sign(context.Background(), rollbackRequest); err == nil || !strings.Contains(err.Error(), "exceeds") {
			t.Fatalf("clock rollback was treated as recoverable pending expiry: %v", err)
		}
		if signer.callCount() != 1 || fixture.store.checkpoint.SnapshotVersionHighWater != 2 {
			t.Fatal("clock rollback reached the signer or advanced the high-water mark")
		}
	})
}

func TestSnapshotRejectsUnrelatedSameVersionRootBeforeSigner(t *testing.T) {
	fixture := newBrokerFixture(t)
	unrelated := newBrokerFixture(t)
	unrelatedGeneration := unrelated.generation(t, testReleaseTwo, 2, 2, 2)
	factory := &trackingFactory{signer: newTrackingSigner(t, fixture.keys[metadata.SNAPSHOT][0])}
	broker := fixture.broker(t, "snapshot", "one", fixture.keys[metadata.SNAPSHOT][0], factory)
	if _, err := broker.Sign(context.Background(), fixture.requestBytes(
		t, "snapshot", unrelatedGeneration.releaseID, unrelatedGeneration.rootBytes, 1,
		unrelatedGeneration.targetsBytes, 2,
	)); err == nil || !strings.Contains(err.Error(), "same-version root") {
		t.Fatalf("unrelated same-version root was accepted: %v", err)
	}
	if factory.callCount() != 0 {
		t.Fatal("unrelated root initialized a signer")
	}
}

func TestBrokerBootstrapIsPinnedAllVersionOneAndCreateOnly(t *testing.T) {
	fixture := newBrokerFixture(t)
	store := &memoryStore{}
	factory := &trackingFactory{signer: newTrackingSigner(t, fixture.keys[metadata.SNAPSHOT][0])}
	broker := fixture.brokerWithStore(t, store, "snapshot", "one", fixture.keys[metadata.SNAPSHOT][0], factory)
	published := PublishedGeneration{
		Environment: "staging", ReleaseID: fixture.initial.releaseID, RootBytes: fixture.initial.rootBytes,
		TargetsBytes: fixture.initial.targetsBytes, SnapshotBytes: fixture.initial.snapshotBytes,
		TimestampBytes: fixture.initial.timestampBytes,
	}
	checkpoint, err := broker.BootstrapPublished(context.Background(), published)
	if err != nil {
		t.Fatal(err)
	}
	if checkpoint.Revision != 1 || checkpoint.RootHistory[0].SHA256 != broker.config.BootstrapRootSHA256 {
		t.Fatalf("unexpected bootstrap checkpoint: %+v", checkpoint)
	}
	if _, err := broker.BootstrapPublished(context.Background(), published); !errors.Is(err, ErrStateConflict) {
		t.Fatalf("existing bootstrap state was replaced: %v", err)
	}
	wrongConfig := broker.config
	wrongConfig.BootstrapRootSHA256 = strings.Repeat("f", 64)
	wrongBroker, err := New(wrongConfig, &memoryStore{}, factory, func() time.Time { return fixture.now })
	if err != nil {
		t.Fatal(err)
	}
	if _, err := wrongBroker.BootstrapPublished(context.Background(), published); err == nil {
		t.Fatal("bootstrap accepted a root outside the immutable configuration pin")
	}
}

func newBrokerFixture(t *testing.T) *brokerFixture {
	t.Helper()
	fixture := &brokerFixture{
		now:  time.Date(2026, time.September, 2, 12, 0, 0, 0, time.UTC),
		keys: make(map[string][]*ecdsa.PrivateKey),
	}
	fixture.root = metadata.Root(fixture.now.Add(365 * 24 * time.Hour))
	roleCounts := map[string]int{metadata.ROOT: 3, metadata.TARGETS: 3, metadata.SNAPSHOT: 2, metadata.TIMESTAMP: 2}
	roleThresholds := map[string]int{metadata.ROOT: 2, metadata.TARGETS: 2, metadata.SNAPSHOT: 1, metadata.TIMESTAMP: 1}
	for _, role := range []string{metadata.ROOT, metadata.TARGETS, metadata.SNAPSHOT, metadata.TIMESTAMP} {
		for index := 0; index < roleCounts[role]; index++ {
			privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			key, err := metadata.KeyFromPublicKey(privateKey.Public())
			if err != nil {
				t.Fatal(err)
			}
			if err := fixture.root.Signed.AddKey(key, role); err != nil {
				t.Fatal(err)
			}
			fixture.keys[role] = append(fixture.keys[role], privateKey)
		}
		fixture.root.Signed.Roles[role].Threshold = roleThresholds[role]
	}
	fixture.root.ClearSignatures()
	for _, key := range fixture.keys[metadata.ROOT][:2] {
		if _, err := fixture.root.Sign(loadSigner(t, key)); err != nil {
			t.Fatal(err)
		}
	}
	sort.Slice(fixture.root.Signatures, func(left, right int) bool {
		return fixture.root.Signatures[left].KeyID < fixture.root.Signatures[right].KeyID
	})
	var err error
	fixture.rootBytes, err = fixture.root.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
	fixture.initial = fixture.generation(t, testReleaseOne, 1, 1, 1)
	checkpoint := Checkpoint{
		SchemaVersion: CheckpointSchemaVersion, Environment: "staging", RepositoryID: "hid-staging-v1",
		StateID: "hid-staging-broker-v1", BootstrapRootSHA256: digestHex(fixture.rootBytes), Revision: 1,
		ReleaseID:                 testReleaseOne,
		RootHistory:               []MetadataRecord{NewMetadataRecord(1, fixture.rootBytes)},
		Targets:                   NewMetadataRecord(1, fixture.initial.targetsBytes),
		Snapshot:                  NewMetadataRecord(1, fixture.initial.snapshotBytes),
		Timestamp:                 NewMetadataRecord(1, fixture.initial.timestampBytes),
		SnapshotVersionHighWater:  1,
		TimestampVersionHighWater: 1,
	}
	fixture.store = &memoryStore{checkpoint: &checkpoint}
	return fixture
}

func (fixture *brokerFixture) generation(t *testing.T, releaseID string, targetsVersion, snapshotVersion, timestampVersion int64) testGeneration {
	return fixture.generationWithTargetsExpiry(
		t, releaseID, targetsVersion, snapshotVersion, timestampVersion,
		fixture.now.Add(90*24*time.Hour),
	)
}

func (fixture *brokerFixture) generationWithTargetsExpiry(
	t *testing.T,
	releaseID string,
	targetsVersion, snapshotVersion, timestampVersion int64,
	targetsExpires time.Time,
) testGeneration {
	t.Helper()
	directory := t.TempDir()
	inputs := []struct {
		path string
		name string
		data []byte
	}{
		{path: "environments/staging/channels/current.json", name: "current.json", data: []byte(`{"release_id":"` + releaseID + `"}`)},
		{path: "environments/staging/releases/" + releaseID + "/release-bundle.json", name: "release-bundle.json", data: []byte(`{"release_id":"` + releaseID + `"}`)},
	}
	plan := repository.TargetsPlan{
		SchemaVersion: repository.SchemaVersion, Environment: "staging", RepositoryID: "hid-staging-v1",
		ReleaseID: releaseID, CreatedAt: fixture.now.Format(time.RFC3339), RootVersion: 1,
		TargetsVersion: targetsVersion, TargetsExpires: targetsExpires.Format(time.RFC3339),
	}
	for _, input := range inputs {
		filePath := filepath.Join(directory, input.name)
		if err := os.WriteFile(filePath, input.data, 0o600); err != nil {
			t.Fatal(err)
		}
		plan.Targets = append(plan.Targets, repository.TargetInput{
			Path: input.path, SourcePath: filePath, Length: int64(len(input.data)), SHA256: digestHex(input.data),
		})
	}
	prepared, err := repository.PrepareTargets(plan, fixture.rootBytes)
	if err != nil {
		t.Fatal(err)
	}
	evidence := make([]repository.DetachedSignature, 0, 2)
	for _, privateKey := range fixture.keys[metadata.TARGETS][:2] {
		signer := loadSigner(t, privateKey)
		tufSignature, err := signer.SignMessage(bytes.NewReader(prepared.Payload))
		if err != nil {
			t.Fatal(err)
		}
		publicKey, err := metadata.KeyFromPublicKey(privateKey.Public())
		if err != nil {
			t.Fatal(err)
		}
		keyID, err := publicKey.ID()
		if err != nil {
			t.Fatal(err)
		}
		draft, statement, err := repository.PrepareTargetsEvidenceAttestation(
			prepared, fixture.rootBytes, keyID, hex.EncodeToString(tufSignature), fixture.now.Format(time.RFC3339),
		)
		if err != nil {
			t.Fatal(err)
		}
		attestation, err := signer.SignMessage(bytes.NewReader(statement))
		if err != nil {
			t.Fatal(err)
		}
		complete, err := repository.CompleteTargetsEvidence(
			prepared, fixture.rootBytes, keyID, draft.Signature, draft.SignedAt, hex.EncodeToString(attestation),
		)
		if err != nil {
			t.Fatal(err)
		}
		evidence = append(evidence, complete)
	}
	targetsBytes, err := repository.AssembleTargets(prepared, fixture.rootBytes, evidence)
	if err != nil {
		t.Fatal(err)
	}
	snapshotBytes, err := repository.BuildSnapshot(fixture.rootBytes, targetsBytes, repository.SnapshotOptions{
		Environment: "staging", RepositoryID: "hid-staging-v1", ReleaseID: releaseID, RootVersion: 1,
		Version: snapshotVersion, CreatedAt: fixture.now, Expires: fixture.now.Add(7 * 24 * time.Hour),
		ExpectedTargetsVersion: targetsVersion, ExpectedTargetsSHA256: digestHex(targetsBytes),
	}, loadSigner(t, fixture.keys[metadata.SNAPSHOT][0]))
	if err != nil {
		t.Fatal(err)
	}
	timestampBytes, err := repository.BuildTimestamp(fixture.rootBytes, snapshotBytes, repository.TimestampOptions{
		Environment: "staging", RepositoryID: "hid-staging-v1", ReleaseID: releaseID, RootVersion: 1,
		Version: timestampVersion, CreatedAt: fixture.now, Expires: fixture.now.Add(24 * time.Hour),
		ExpectedSnapshotVersion: snapshotVersion, ExpectedSnapshotSHA256: digestHex(snapshotBytes),
	}, loadSigner(t, fixture.keys[metadata.TIMESTAMP][0]))
	if err != nil {
		t.Fatal(err)
	}
	return testGeneration{
		prepared:  prepared,
		releaseID: releaseID, rootBytes: bytes.Clone(fixture.rootBytes), targetsBytes: targetsBytes,
		snapshotBytes: snapshotBytes, timestampBytes: timestampBytes, rootVersion: 1,
		targetsVersion: targetsVersion, snapshotVersion: snapshotVersion, timestampVersion: timestampVersion,
	}
}

func (fixture *brokerFixture) request(t *testing.T, role, releaseID string, rootBytes []byte, rootVersion int64, inputBytes []byte, inputVersion int64) Request {
	t.Helper()
	lifetime := 7 * 24 * time.Hour
	if role == "timestamp" {
		lifetime = 24 * time.Hour
	}
	return Request{
		SchemaVersion: SchemaVersion, Environment: "staging", RepositoryID: "hid-staging-v1", Role: role,
		ReleaseID: releaseID, CreatedAt: fixture.now.Format(time.RFC3339), Expires: fixture.now.Add(lifetime).Format(time.RFC3339),
		RootVersion: rootVersion, RootSHA256: digestHex(rootBytes), RootBytes: bytes.Clone(rootBytes),
		InputMetadataVersion: inputVersion, InputMetadataSHA256: digestHex(inputBytes), InputMetadataBytes: bytes.Clone(inputBytes),
	}
}

func (fixture *brokerFixture) requestBytes(t *testing.T, role, releaseID string, rootBytes []byte, rootVersion int64, inputBytes []byte, inputVersion int64) []byte {
	t.Helper()
	encoded, err := json.Marshal(fixture.request(t, role, releaseID, rootBytes, rootVersion, inputBytes, inputVersion))
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func (fixture *brokerFixture) broker(t *testing.T, role, candidate string, key *ecdsa.PrivateKey, factory SignerFactory) *Broker {
	t.Helper()
	return fixture.brokerWithStore(t, fixture.store, role, candidate, key, factory)
}

func (fixture *brokerFixture) brokerWithStore(t *testing.T, store StateStore, role, candidate string, key *ecdsa.PrivateKey, factory SignerFactory) *Broker {
	t.Helper()
	broker, err := New(fixture.brokerConfig(t, role, candidate, key), store, factory, func() time.Time { return fixture.now })
	if err != nil {
		t.Fatal(err)
	}
	return broker
}

func newTrackingSigner(t *testing.T, key *ecdsa.PrivateKey) *trackingSigner {
	t.Helper()
	return &trackingSigner{inner: loadSigner(t, key)}
}

func loadSigner(t *testing.T, key *ecdsa.PrivateKey) signature.Signer {
	t.Helper()
	signer, err := signature.LoadSigner(key, crypto.SHA256)
	if err != nil {
		t.Fatal(err)
	}
	return signer
}

func checkpointPointer(value Checkpoint) *Checkpoint {
	return &value
}

func TestBrokerRejectsNonCanonicalRequestBytesBeforeStateOrSigner(t *testing.T) {
	fixture := newBrokerFixture(t)
	next := fixture.generation(t, testReleaseTwo, 2, 2, 2)
	request := fixture.request(t, "snapshot", next.releaseID, next.rootBytes, 1, next.targetsBytes, 2)
	encoded, err := json.MarshalIndent(request, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	factory := &trackingFactory{signer: newTrackingSigner(t, fixture.keys[metadata.SNAPSHOT][0])}
	broker := fixture.broker(t, "snapshot", "one", fixture.keys[metadata.SNAPSHOT][0], factory)
	if _, err := broker.Sign(context.Background(), encoded); err == nil || !strings.Contains(err.Error(), "canonical JSON") {
		t.Fatalf("non-canonical request encoding was accepted: %v", err)
	}
	if fixture.store.loadCalls != 0 || factory.callCount() != 0 {
		t.Fatal("non-canonical request reached state or signer")
	}
}

func (fixture *brokerFixture) brokerConfig(t *testing.T, role, candidate string, key *ecdsa.PrivateKey) Config {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(key.Public())
	if err != nil {
		t.Fatal(err)
	}
	return Config{
		Environment: "staging", RepositoryID: "hid-staging-v1", StateID: "hid-staging-broker-v1",
		Role: role, CandidateID: candidate,
		KMSKeyARN:               "arn:aws:kms:eu-west-1:111122223333:key/12345678-1234-1234-1234-123456789abc",
		KMSPublicKeyDERChecksum: digestHex(der), BootstrapRootSHA256: digestHex(fixture.rootBytes),
		RequestBucketName: "hid-staging-evidence-111122223333",
		RequestObjectPrefix: fmt.Sprintf(
			"tuf-signing-broker/requests/hid-staging-broker-v1/%s-%s/",
			role,
			candidate,
		),
	}
}

func (fixture *brokerFixture) requestObject(role, candidate string, requestBytes []byte, versionID string) ImmutableRequestObject {
	return ImmutableRequestObject{
		Bucket: "hid-staging-evidence-111122223333",
		Key: fmt.Sprintf(
			"tuf-signing-broker/requests/hid-staging-broker-v1/%s-%s/request.json",
			role,
			candidate,
		),
		VersionID: versionID,
		SHA256:    digestHex(requestBytes),
	}
}

func TestDigestHelperMatchesSHA256(t *testing.T) {
	data := []byte("hid-broker")
	digest := sha256.Sum256(data)
	if digestHex(data) != hex.EncodeToString(digest[:]) {
		t.Fatal("digest helper did not return lowercase SHA-256")
	}
}
