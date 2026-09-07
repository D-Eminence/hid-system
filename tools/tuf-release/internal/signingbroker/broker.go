package signingbroker

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/repository"
	"github.com/sigstore/sigstore/pkg/signature"
)

func New(config Config, store StateStore, signers SignerFactory, clock func() time.Time) (*Broker, error) {
	if err := validateConfig(config); err != nil {
		return nil, err
	}
	if isNil(store) {
		return nil, errors.New("signing-broker state store is required")
	}
	if isNil(signers) {
		return nil, errors.New("signing-broker signer factory is required")
	}
	decisions, ok := store.(CompletedDecisionStore)
	if !ok || isNil(decisions) {
		return nil, errors.New("signing-broker completed-decision store is required")
	}
	if clock == nil {
		return nil, errors.New("signing-broker clock is required")
	}
	return &Broker{
		config: config, store: store, decisions: decisions,
		signers: signers, now: clock,
	}, nil
}

func NewPublicationController(config PublicationConfig, store StateStore, clock func() time.Time) (*PublicationController, error) {
	if err := validatePublicationConfig(config); err != nil {
		return nil, err
	}
	if isNil(store) {
		return nil, errors.New("signing-broker state store is required")
	}
	if clock == nil {
		return nil, errors.New("signing-broker clock is required")
	}
	return &PublicationController{config: config, store: store, now: clock}, nil
}

// Sign validates the complete caller request and independently loaded durable
// checkpoint before initializing a signer. The output version, predecessor,
// root authority, and selected key all come from fixed configuration/state.
func (broker *Broker) Sign(ctx context.Context, requestBytes []byte) (Result, error) {
	return broker.sign(ctx, requestBytes, nil, true)
}

// SignImmutableRequest permits an exact committed replay while requiring the
// AWS adapter's verified minimum remaining-retention window before any new
// signer can be initialized. The boolean is not caller data; it is derived
// from the immutable storage envelope by the trusted adapter.
func (broker *Broker) SignImmutableRequest(
	ctx context.Context,
	requestBytes []byte,
	requestObject ImmutableRequestObject,
	minimumRetentionSatisfied bool,
) (Result, error) {
	return broker.sign(ctx, requestBytes, &requestObject, minimumRetentionSatisfied)
}

func (broker *Broker) sign(
	ctx context.Context,
	requestBytes []byte,
	requestObject *ImmutableRequestObject,
	minimumRetentionSatisfied bool,
) (Result, error) {
	if broker == nil || isNil(ctx) {
		return Result{}, errors.New("signing-broker and context are required")
	}
	request, err := DecodeRequest(requestBytes)
	if err != nil {
		return Result{}, err
	}
	canonicalRequest, err := json.Marshal(request)
	if err != nil {
		return Result{}, fmt.Errorf("canonicalize signing-broker request: %w", err)
	}
	if !bytes.Equal(requestBytes, canonicalRequest) {
		return Result{}, errors.New("signing-broker request must use its canonical JSON encoding")
	}
	now := broker.now()
	validated, err := validateRequestEnvelope(request, broker.config)
	if err != nil {
		return Result{}, err
	}
	if requestObject != nil {
		if err := validateImmutableRequestObject(*requestObject, broker.config, validated.requestHash); err != nil {
			return Result{}, err
		}
		requestObject = cloneImmutableRequestObject(requestObject)
	}
	clockErr := validateRequestClock(validated, now)
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	checkpoint, err := broker.store.Load(ctx, broker.config.StateID)
	if err != nil {
		return Result{}, fmt.Errorf("load fixed signing-broker checkpoint: %w", err)
	}
	checkpoint = cloneCheckpoint(checkpoint)
	reference := now.UTC().Truncate(time.Second)
	if err := validateCheckpoint(checkpoint, broker.config.trustConfig(), reference); err != nil {
		return Result{}, err
	}
	if replay, found := broker.exactPendingResult(validated, requestObject, checkpoint); found {
		return replay, nil
	}
	if replay, found, err := broker.completedResult(ctx, validated, requestObject, checkpoint); found || err != nil {
		return replay, err
	}
	blocked, err := pendingBlocksRole(broker.config.Role, checkpoint, reference)
	if err != nil {
		return Result{}, err
	}
	if blocked {
		return Result{}, ErrPending
	}
	if !minimumRetentionSatisfied {
		return Result{}, errors.New("immutable signing request lacks the minimum remaining retention for new output")
	}
	if clockErr != nil {
		return Result{}, clockErr
	}
	switch broker.config.Role {
	case "snapshot":
		return broker.signSnapshot(ctx, validated, requestObject, checkpoint, reference)
	case "timestamp":
		return broker.signTimestamp(ctx, validated, requestObject, checkpoint, reference)
	default:
		return Result{}, errors.New("fixed signing-broker role is unsupported")
	}
}

func (broker *Broker) completedResult(
	ctx context.Context,
	request validatedRequest,
	requestObject *ImmutableRequestObject,
	checkpoint Checkpoint,
) (Result, bool, error) {
	decision, err := broker.decisions.LoadCompletedDecision(ctx, DecisionLookup{
		StateID: broker.config.StateID, Role: broker.config.Role,
		CandidateID: broker.config.CandidateID, RequestSHA256: request.requestHash,
		RequestObject: cloneImmutableRequestObject(requestObject),
	})
	if errors.Is(err, ErrDecisionNotFound) {
		return Result{}, false, nil
	}
	if err != nil {
		return Result{}, false, fmt.Errorf("load completed signing decision: %w", err)
	}
	if decision.Role != broker.config.Role || decision.CandidateID != broker.config.CandidateID ||
		decision.RequestSHA256 != request.requestHash ||
		!sameImmutableRequestObject(decision.RequestObject, requestObject) ||
		decision.ReleaseID != request.value.ReleaseID || decision.CreatedAt != request.value.CreatedAt ||
		decision.StateRevision < 1 || decision.StateRevision > checkpoint.Revision {
		return Result{}, false, errors.New("completed signing decision identity is invalid")
	}
	if err := validateRecord(decision.Root, repository.MaxRootMetadataBytes, "completed decision root"); err != nil {
		return Result{}, false, err
	}
	maximumInput := repository.MaxSnapshotMetadataBytes
	if broker.config.Role == "snapshot" {
		maximumInput = repository.MaxTargetsMetadataBytes
	}
	if err := validateRecord(decision.Input, maximumInput, "completed decision input"); err != nil {
		return Result{}, false, err
	}
	maximumOutput := repository.MaxTimestampMetadataBytes
	if broker.config.Role == "snapshot" {
		maximumOutput = repository.MaxSnapshotMetadataBytes
	}
	if err := validateRecord(decision.Output, maximumOutput, "completed decision output"); err != nil {
		return Result{}, false, err
	}
	requestRoot := NewMetadataRecord(request.value.RootVersion, request.value.RootBytes)
	requestInput := NewMetadataRecord(
		request.value.InputMetadataVersion,
		request.value.InputMetadataBytes,
	)
	if !sameRecord(decision.Root, requestRoot) || !sameRecord(decision.Input, requestInput) {
		return Result{}, false, errors.New("completed signing decision inputs differ from the exact request")
	}
	rootAnchored := false
	for _, root := range checkpoint.RootHistory {
		if sameRecord(root, decision.Root) {
			rootAnchored = true
			break
		}
	}
	if !rootAnchored && checkpoint.PendingSnapshot != nil && sameRecord(checkpoint.PendingSnapshot.Root, decision.Root) {
		rootAnchored = true
	}
	if !rootAnchored && checkpoint.PendingTimestamp != nil && sameRecord(checkpoint.PendingTimestamp.Root, decision.Root) {
		rootAnchored = true
	}
	if !rootAnchored {
		return Result{}, false, errors.New("completed signing decision root is outside anchored history")
	}
	if broker.config.Role == "snapshot" {
		derived, err := repository.ValidateSnapshotSet(repository.SnapshotSet{
			Environment: broker.config.Environment, ReleaseID: decision.ReleaseID,
			ReferenceTime: request.createdAt, RequireFresh: true,
			RootBytes: decision.Root.Bytes, TargetsBytes: decision.Input.Bytes,
			SnapshotBytes: decision.Output.Bytes,
		})
		if err != nil {
			return Result{}, false, fmt.Errorf("validate completed snapshot decision: %w", err)
		}
		if !matchesRecord(decision.Root, derived.RootVersion, derived.RootSHA256) ||
			!matchesRecord(decision.Input, derived.TargetsVersion, derived.TargetsSHA256) ||
			!matchesRecord(decision.Output, derived.SnapshotVersion, derived.SnapshotSHA256) {
			return Result{}, false, errors.New("completed snapshot decision records differ from authenticated metadata")
		}
	} else {
		derived, err := repository.ValidateTimestampSet(repository.TimestampSet{
			ReferenceTime: request.createdAt, RequireFresh: true,
			RootBytes: decision.Root.Bytes, SnapshotBytes: decision.Input.Bytes,
			TimestampBytes: decision.Output.Bytes,
		})
		if err != nil {
			return Result{}, false, fmt.Errorf("validate completed timestamp decision: %w", err)
		}
		if !matchesRecord(decision.Root, derived.RootVersion, derived.RootSHA256) ||
			!matchesRecord(decision.Input, derived.SnapshotVersion, derived.SnapshotSHA256) ||
			!matchesRecord(decision.Output, derived.TimestampVersion, derived.TimestampSHA256) {
			return Result{}, false, errors.New("completed timestamp decision records differ from authenticated metadata")
		}
	}
	return decisionResult(broker.config, decision), true, nil
}

func (broker *Broker) exactPendingResult(
	request validatedRequest,
	requestObject *ImmutableRequestObject,
	checkpoint Checkpoint,
) (Result, bool) {
	switch broker.config.Role {
	case "snapshot":
		if checkpoint.PendingSnapshot != nil {
			pending := checkpoint.PendingSnapshot
			if pending.CandidateID == broker.config.CandidateID && pending.RequestSHA256 == request.requestHash &&
				sameImmutableRequestObject(pending.RequestObject, requestObject) {
				return snapshotResult(broker.config, *pending, true), true
			}
		}
	case "timestamp":
		if checkpoint.PendingTimestamp != nil {
			pending := checkpoint.PendingTimestamp
			if pending.CandidateID == broker.config.CandidateID && pending.RequestSHA256 == request.requestHash &&
				sameImmutableRequestObject(pending.RequestObject, requestObject) {
				return timestampResult(broker.config, *pending, true), true
			}
		}
	}
	return Result{}, false
}

func (broker *Broker) signSnapshot(
	ctx context.Context,
	request validatedRequest,
	requestObject *ImmutableRequestObject,
	checkpoint Checkpoint,
	reference time.Time,
) (Result, error) {
	currentRoot := checkpoint.RootHistory[len(checkpoint.RootHistory)-1]
	previousRoot := currentRoot
	previousSnapshot := checkpoint.Snapshot
	previousTargets := checkpoint.Targets
	if checkpoint.PendingSnapshot != nil {
		pending := checkpoint.PendingSnapshot
		needsRefresh, err := pendingSnapshotNeedsRefresh(checkpoint, *pending, reference)
		if err != nil {
			return Result{}, err
		}
		if !needsRefresh {
			return Result{}, ErrPending
		}
		previousRoot = pending.Root
		previousSnapshot = pending.Snapshot
		previousTargets = pending.Targets
	} else if checkpoint.PendingTimestamp != nil {
		needsRefresh, err := authorizedSnapshotNeedsRefresh(checkpoint, reference)
		if err != nil {
			return Result{}, err
		}
		if !needsRefresh {
			return Result{}, ErrPending
		}
	}
	if checkpoint.SnapshotVersionHighWater >= maxSafeInteger {
		return Result{}, errors.New("snapshot version cannot be advanced safely")
	}
	root := NewMetadataRecord(request.value.RootVersion, request.value.RootBytes)
	targets := NewMetadataRecord(request.value.InputMetadataVersion, request.value.InputMetadataBytes)
	if root.SHA256 != request.value.RootSHA256 || targets.SHA256 != request.value.InputMetadataSHA256 {
		return Result{}, errors.New("snapshot request records changed after validation")
	}
	if err := validateRecoveryRootTransition(
		checkpoint.RootHistory,
		currentRoot,
		previousRoot,
		root,
		request.createdAt,
	); err != nil {
		return Result{}, fmt.Errorf("validate snapshot request root transition: %w", err)
	}
	if err := validateRecoveryTargetsTransition(checkpoint.Targets, previousTargets, targets); err != nil {
		return Result{}, fmt.Errorf("validate snapshot request targets transition: %w", err)
	}
	if _, err := repository.ValidateTargetsSet(repository.TargetsSet{
		Environment: broker.config.Environment, ReleaseID: request.value.ReleaseID,
		ReferenceTime: reference.Add(publicationSafetyMargin), RequireFresh: true,
		RootBytes: root.Bytes, TargetsBytes: targets.Bytes,
	}); err != nil {
		return Result{}, fmt.Errorf("validate snapshot authority publication margin: %w", err)
	}
	outputVersion := checkpoint.SnapshotVersionHighWater + 1
	plan, err := broker.onlinePlan(request, outputVersion, previousRoot, previousSnapshot)
	if err != nil {
		return Result{}, err
	}
	if err := repository.ValidateOnlineSigningInputsAtHighWater(
		plan,
		root.Bytes,
		targets.Bytes,
		previousSnapshot.Bytes,
		previousRoot.Bytes,
		repository.OnlineVersionHighWater{
			Output: checkpoint.SnapshotVersionHighWater,
			Input:  previousTargets.Version,
		},
	); err != nil {
		return Result{}, fmt.Errorf("validate snapshot request against durable checkpoint: %w", err)
	}
	if err := broker.recheckBeforeSigner(request); err != nil {
		return Result{}, err
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	signer, err := broker.signers.NewSigner(ctx, SignerConfig{
		KeyARN: broker.config.KMSKeyARN, PublicKeyDERChecksum: broker.config.KMSPublicKeyDERChecksum,
	})
	if err != nil {
		return Result{}, fmt.Errorf("initialize fixed snapshot signer: %w", err)
	}
	if err := verifySignerIdentity(signer, broker.config.KMSPublicKeyDERChecksum); err != nil {
		return Result{}, fmt.Errorf("verify fixed snapshot signer identity: %w", err)
	}
	outputBytes, err := repository.BuildSnapshot(root.Bytes, targets.Bytes, repository.SnapshotOptions{
		Environment: broker.config.Environment, RepositoryID: broker.config.RepositoryID,
		ReleaseID: request.value.ReleaseID, RootVersion: root.Version, Version: outputVersion,
		CreatedAt: request.createdAt, Expires: request.expires,
		ExpectedTargetsVersion: targets.Version, ExpectedTargetsSHA256: targets.SHA256,
	}, signer)
	if err != nil {
		return Result{}, err
	}
	output := NewMetadataRecord(outputVersion, outputBytes)
	commitReference, err := broker.recheckBeforeCommit(request)
	if err != nil {
		return Result{}, err
	}
	if _, err := repository.ValidateSnapshotSet(repository.SnapshotSet{
		Environment: broker.config.Environment, ReleaseID: request.value.ReleaseID,
		ReferenceTime: commitReference.Add(publicationSafetyMargin), RequireFresh: true, RootBytes: root.Bytes,
		TargetsBytes: targets.Bytes, SnapshotBytes: output.Bytes,
	}); err != nil {
		return Result{}, fmt.Errorf("validate broker snapshot publication margin before commit: %w", err)
	}
	pending := PendingSnapshot{
		CandidateID: broker.config.CandidateID, RequestSHA256: request.requestHash,
		ReleaseID: request.value.ReleaseID, CreatedAt: request.value.CreatedAt,
		StateRevision: checkpoint.Revision + 1,
		RequestObject: cloneImmutableRequestObject(requestObject),
		Root:          root, Targets: targets, Snapshot: output,
	}
	next := cloneCheckpoint(checkpoint)
	next.Revision++
	next.SnapshotVersionHighWater = outputVersion
	next.PendingSnapshot = &pending
	next.PendingTimestamp = nil
	if err := broker.store.CompareAndSwap(ctx, broker.config.StateID, checkpoint.Revision, next); err != nil {
		if reconciled, ok := broker.reconcileCommittedRequest(ctx, request, requestObject); ok {
			return reconciled, nil
		}
		return Result{}, fmt.Errorf("commit pending snapshot authorization: %w", err)
	}
	return snapshotResult(broker.config, pending, false), nil
}

func (broker *Broker) signTimestamp(
	ctx context.Context,
	request validatedRequest,
	requestObject *ImmutableRequestObject,
	checkpoint Checkpoint,
	reference time.Time,
) (Result, error) {
	if checkpoint.PendingTimestamp != nil {
		pending := checkpoint.PendingTimestamp
		needsRefresh, err := pendingGenerationNeedsRefresh(checkpoint, *pending, reference)
		if err != nil {
			return Result{}, err
		}
		if !needsRefresh {
			return Result{}, ErrPending
		}
	}
	if checkpoint.TimestampVersionHighWater >= maxSafeInteger {
		return Result{}, errors.New("timestamp version cannot be advanced safely")
	}
	expectedRoot := checkpoint.RootHistory[len(checkpoint.RootHistory)-1]
	expectedTargets := checkpoint.Targets
	expectedSnapshot := checkpoint.Snapshot
	expectedRelease := checkpoint.ReleaseID
	if checkpoint.PendingSnapshot != nil {
		expectedRoot = checkpoint.PendingSnapshot.Root
		expectedTargets = checkpoint.PendingSnapshot.Targets
		expectedSnapshot = checkpoint.PendingSnapshot.Snapshot
		expectedRelease = checkpoint.PendingSnapshot.ReleaseID
	}
	snapshotNeedsRefresh, err := authorizedSnapshotNeedsRefresh(checkpoint, reference.Add(publicationSafetyMargin))
	if err != nil {
		return Result{}, err
	}
	if snapshotNeedsRefresh {
		return Result{}, errors.New("broker-authorized snapshot context lacks publication freshness")
	}
	root := NewMetadataRecord(request.value.RootVersion, request.value.RootBytes)
	snapshot := NewMetadataRecord(request.value.InputMetadataVersion, request.value.InputMetadataBytes)
	if request.value.ReleaseID != expectedRelease || !sameRecord(root, expectedRoot) || !sameRecord(snapshot, expectedSnapshot) {
		return Result{}, errors.New("timestamp request does not select the broker-authorized snapshot context")
	}
	currentRoot := checkpoint.RootHistory[len(checkpoint.RootHistory)-1]
	previousRoot := currentRoot
	previousTimestamp := checkpoint.Timestamp
	if checkpoint.PendingTimestamp != nil {
		previousRoot = checkpoint.PendingTimestamp.Root
		previousTimestamp = checkpoint.PendingTimestamp.Timestamp
	}
	outputVersion := checkpoint.TimestampVersionHighWater + 1
	plan, err := broker.onlinePlan(request, outputVersion, previousRoot, previousTimestamp)
	if err != nil {
		return Result{}, err
	}
	if err := repository.ValidateOnlineSigningInputsAtHighWater(
		plan,
		root.Bytes,
		snapshot.Bytes,
		previousTimestamp.Bytes,
		previousRoot.Bytes,
		repository.OnlineVersionHighWater{
			Output: checkpoint.TimestampVersionHighWater,
			Input:  checkpoint.SnapshotVersionHighWater,
		},
	); err != nil {
		return Result{}, fmt.Errorf("validate timestamp request against durable checkpoint: %w", err)
	}
	if err := broker.recheckBeforeSigner(request); err != nil {
		return Result{}, err
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	signer, err := broker.signers.NewSigner(ctx, SignerConfig{
		KeyARN: broker.config.KMSKeyARN, PublicKeyDERChecksum: broker.config.KMSPublicKeyDERChecksum,
	})
	if err != nil {
		return Result{}, fmt.Errorf("initialize fixed timestamp signer: %w", err)
	}
	if err := verifySignerIdentity(signer, broker.config.KMSPublicKeyDERChecksum); err != nil {
		return Result{}, fmt.Errorf("verify fixed timestamp signer identity: %w", err)
	}
	outputBytes, err := repository.BuildTimestamp(root.Bytes, snapshot.Bytes, repository.TimestampOptions{
		Environment: broker.config.Environment, RepositoryID: broker.config.RepositoryID,
		ReleaseID: request.value.ReleaseID, RootVersion: root.Version, Version: outputVersion,
		CreatedAt: request.createdAt, Expires: request.expires,
		ExpectedSnapshotVersion: snapshot.Version, ExpectedSnapshotSHA256: snapshot.SHA256,
	}, signer)
	if err != nil {
		return Result{}, err
	}
	output := NewMetadataRecord(outputVersion, outputBytes)
	commitReference, err := broker.recheckBeforeCommit(request)
	if err != nil {
		return Result{}, err
	}
	if _, err := repository.ValidateMetadataSet(repository.MetadataSet{
		Environment: broker.config.Environment, ReleaseID: request.value.ReleaseID,
		ReferenceTime: commitReference.Add(publicationSafetyMargin), RequireFresh: true,
		RootBytes: root.Bytes, TargetsBytes: expectedTargets.Bytes,
		SnapshotBytes: snapshot.Bytes, TimestampBytes: output.Bytes,
	}); err != nil {
		return Result{}, fmt.Errorf("validate broker generation publication margin before commit: %w", err)
	}
	pending := PendingTimestamp{
		CandidateID: broker.config.CandidateID, RequestSHA256: request.requestHash,
		ReleaseID: request.value.ReleaseID, CreatedAt: request.value.CreatedAt,
		StateRevision: checkpoint.Revision + 1,
		RequestObject: cloneImmutableRequestObject(requestObject),
		Root:          root, Snapshot: snapshot, Timestamp: output,
	}
	next := cloneCheckpoint(checkpoint)
	next.Revision++
	next.TimestampVersionHighWater = outputVersion
	next.PendingTimestamp = &pending
	if err := broker.store.CompareAndSwap(ctx, broker.config.StateID, checkpoint.Revision, next); err != nil {
		if reconciled, ok := broker.reconcileCommittedRequest(ctx, request, requestObject); ok {
			return reconciled, nil
		}
		return Result{}, fmt.Errorf("commit pending timestamp authorization: %w", err)
	}
	return timestampResult(broker.config, pending, false), nil
}

func (broker *Broker) reconcileCommittedRequest(
	ctx context.Context,
	request validatedRequest,
	requestObject *ImmutableRequestObject,
) (Result, bool) {
	checkpoint, err := broker.store.Load(ctx, broker.config.StateID)
	if err != nil {
		return Result{}, false
	}
	reference := broker.now().UTC().Truncate(time.Second)
	if err := validateCheckpoint(checkpoint, broker.config.trustConfig(), reference); err != nil {
		return Result{}, false
	}
	return broker.exactPendingResult(request, requestObject, checkpoint)
}

func (broker *Broker) onlinePlan(request validatedRequest, outputVersion int64, previousRoot, previousRole MetadataRecord) (repository.OnlineSigningPlan, error) {
	region, account, err := kmsIdentity(broker.config.KMSKeyARN)
	if err != nil {
		return repository.OnlineSigningPlan{}, err
	}
	inputName := "targets.json"
	previousName := "snapshot.json"
	if broker.config.Role == "timestamp" {
		inputName = "snapshot.json"
		previousName = "timestamp.json"
	}
	return repository.OnlineSigningPlan{
		SchemaVersion: repository.SchemaVersion, Role: broker.config.Role,
		Environment: broker.config.Environment, RepositoryID: broker.config.RepositoryID,
		ReleaseID: request.value.ReleaseID, CreatedAt: request.value.CreatedAt, Expires: request.value.Expires,
		RootPath: "/broker/request/root.json", RootSHA256: request.value.RootSHA256, RootVersion: request.value.RootVersion,
		InputMetadataPath:   "/broker/request/" + inputName,
		InputMetadataSHA256: request.value.InputMetadataSHA256, InputMetadataVersion: request.value.InputMetadataVersion,
		OutputMetadataVersion:  outputVersion,
		PreviousMetadataPath:   "/broker/state/" + previousName,
		PreviousMetadataSHA256: previousRole.SHA256,
		PreviousRootPath:       "/broker/state/root.json", PreviousRootSHA256: previousRoot.SHA256,
		AWSRegion: region, AWSAccountID: account, KMSKeyARN: broker.config.KMSKeyARN,
		KMSPublicKeyDERChecksum: broker.config.KMSPublicKeyDERChecksum,
	}, nil
}

func (broker *Broker) recheckBeforeSigner(request validatedRequest) error {
	_, err := broker.recheckRequest(request, "signer initialization")
	return err
}

func (broker *Broker) recheckBeforeCommit(request validatedRequest) (time.Time, error) {
	return broker.recheckRequest(request, "durable commit")
}

func (broker *Broker) recheckRequest(request validatedRequest, boundary string) (time.Time, error) {
	now := broker.now()
	rechecked, err := validateRequest(request.value, broker.config, now)
	if err != nil {
		return time.Time{}, fmt.Errorf("recheck signing-broker clock immediately before %s: %w", boundary, err)
	}
	if rechecked.requestHash != request.requestHash || !bytes.Equal(rechecked.value.RootBytes, request.value.RootBytes) ||
		!bytes.Equal(rechecked.value.InputMetadataBytes, request.value.InputMetadataBytes) {
		return time.Time{}, fmt.Errorf("signing-broker request changed before %s", boundary)
	}
	return now.UTC().Truncate(time.Second), nil
}

func snapshotResult(config Config, pending PendingSnapshot, replay bool) Result {
	return Result{
		SchemaVersion: SchemaVersion, Environment: config.Environment, RepositoryID: config.RepositoryID,
		StateID: config.StateID, Role: "snapshot", CandidateID: pending.CandidateID,
		ReleaseID: pending.ReleaseID, RequestSHA256: pending.RequestSHA256,
		RequestObject: cloneImmutableRequestObject(pending.RequestObject),
		RootVersion:   pending.Root.Version, RootSHA256: pending.Root.SHA256,
		InputMetadataVersion: pending.Targets.Version, InputMetadataSHA256: pending.Targets.SHA256,
		OutputVersion: pending.Snapshot.Version, OutputSHA256: pending.Snapshot.SHA256,
		OutputBytes: bytes.Clone(pending.Snapshot.Bytes), StateRevision: pending.StateRevision, IdempotentReplay: replay,
	}
}

func timestampResult(config Config, pending PendingTimestamp, replay bool) Result {
	return Result{
		SchemaVersion: SchemaVersion, Environment: config.Environment, RepositoryID: config.RepositoryID,
		StateID: config.StateID, Role: "timestamp", CandidateID: pending.CandidateID,
		ReleaseID: pending.ReleaseID, RequestSHA256: pending.RequestSHA256,
		RequestObject: cloneImmutableRequestObject(pending.RequestObject),
		RootVersion:   pending.Root.Version, RootSHA256: pending.Root.SHA256,
		InputMetadataVersion: pending.Snapshot.Version, InputMetadataSHA256: pending.Snapshot.SHA256,
		OutputVersion: pending.Timestamp.Version, OutputSHA256: pending.Timestamp.SHA256,
		OutputBytes: bytes.Clone(pending.Timestamp.Bytes), StateRevision: pending.StateRevision, IdempotentReplay: replay,
	}
}

func decisionResult(config Config, decision CompletedDecision) Result {
	return Result{
		SchemaVersion: SchemaVersion, Environment: config.Environment,
		RepositoryID: config.RepositoryID, StateID: config.StateID,
		Role: decision.Role, CandidateID: decision.CandidateID,
		ReleaseID: decision.ReleaseID, RequestSHA256: decision.RequestSHA256,
		RequestObject: cloneImmutableRequestObject(decision.RequestObject),
		RootVersion:   decision.Root.Version, RootSHA256: decision.Root.SHA256,
		InputMetadataVersion: decision.Input.Version,
		InputMetadataSHA256:  decision.Input.SHA256,
		OutputVersion:        decision.Output.Version, OutputSHA256: decision.Output.SHA256,
		OutputBytes: bytes.Clone(decision.Output.Bytes), StateRevision: decision.StateRevision,
		IdempotentReplay: true,
	}
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

func verifySignerIdentity(signer interface {
	PublicKey(...signature.PublicKeyOption) (crypto.PublicKey, error)
}, expectedChecksum string) error {
	if isNil(signer) {
		return errors.New("signer is nil")
	}
	public, err := signer.PublicKey()
	if err != nil {
		return err
	}
	publicKey, ok := public.(*ecdsa.PublicKey)
	if !ok || publicKey.Curve != elliptic.P256() || publicKey.X == nil || publicKey.Y == nil ||
		!elliptic.P256().IsOnCurve(publicKey.X, publicKey.Y) {
		return errors.New("signer public key is not valid P-256 ECDSA")
	}
	der, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		return fmt.Errorf("marshal signer public key: %w", err)
	}
	if digestHex(der) != expectedChecksum {
		return errors.New("signer public-key checksum does not match fixed configuration")
	}
	return nil
}
