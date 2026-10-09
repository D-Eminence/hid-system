package awsbroker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dynamodbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/repository"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/signingbroker"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/strictjson"
)

const (
	decisionRecordSchema   = "hid.tuf.signing-broker.completed-decision/v2"
	decisionRecordIDPrefix = "decision:"
	maxDecisionRecordBytes = 100_000
)

type decisionIdentity struct {
	Role          string                                `json:"role"`
	CandidateID   string                                `json:"candidate_id"`
	RequestSHA256 string                                `json:"request_sha256"`
	RequestObject *signingbroker.ImmutableRequestObject `json:"request_object"`
}

type decisionManifest struct {
	SchemaVersion string                                `json:"schema_version"`
	Environment   string                                `json:"environment"`
	RepositoryID  string                                `json:"repository_id"`
	StateID       string                                `json:"state_id"`
	Role          string                                `json:"role"`
	CandidateID   string                                `json:"candidate_id"`
	RequestSHA256 string                                `json:"request_sha256"`
	RequestObject *signingbroker.ImmutableRequestObject `json:"request_object"`
	ReleaseID     string                                `json:"release_id"`
	CreatedAt     string                                `json:"created_at"`
	StateRevision int64                                 `json:"state_revision"`
	StateJournal  blobRef                               `json:"state_journal"`
	Root          blobRef                               `json:"root"`
	Input         blobRef                               `json:"input"`
	Output        blobRef                               `json:"output"`
}

func (store *StateStore) LoadCompletedDecision(
	ctx context.Context,
	lookup signingbroker.DecisionLookup,
) (signingbroker.CompletedDecision, error) {
	if store == nil || isNil(ctx) || lookup.StateID != store.config.StateID ||
		(lookup.Role != "snapshot" && lookup.Role != "timestamp") ||
		(lookup.CandidateID != "one" && lookup.CandidateID != "two") ||
		!sha256Pattern.MatchString(lookup.RequestSHA256) {
		return signingbroker.CompletedDecision{}, errors.New("completed decision lookup is invalid")
	}
	if err := store.validateRequestObject(
		lookup.RequestObject,
		lookup.Role,
		lookup.CandidateID,
		lookup.RequestSHA256,
	); err != nil {
		return signingbroker.CompletedDecision{}, fmt.Errorf("completed decision request source: %w", err)
	}
	recordID, err := completedDecisionRecordID(decisionIdentity{
		Role: lookup.Role, CandidateID: lookup.CandidateID,
		RequestSHA256: lookup.RequestSHA256,
		RequestObject: cloneRequestObject(lookup.RequestObject),
	})
	if err != nil {
		return signingbroker.CompletedDecision{}, err
	}
	output, err := store.dynamodb.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(store.config.TableName),
		ConsistentRead: aws.Bool(true),
		Key: map[string]dynamodbtypes.AttributeValue{
			"state_id":  &dynamodbtypes.AttributeValueMemberS{Value: store.config.StateID},
			"record_id": &dynamodbtypes.AttributeValueMemberS{Value: recordID},
		},
	})
	if err != nil {
		return signingbroker.CompletedDecision{}, fmt.Errorf("read completed decision: %w", err)
	}
	if output == nil {
		return signingbroker.CompletedDecision{}, errors.New("read completed decision: DynamoDB returned nil output")
	}
	if len(output.Item) == 0 {
		return signingbroker.CompletedDecision{}, signingbroker.ErrDecisionNotFound
	}
	manifestBytes, err := decodeDecisionItem(output.Item, store.config.StateID, recordID)
	if err != nil {
		return signingbroker.CompletedDecision{}, err
	}
	manifest, err := store.decodeDecisionManifest(manifestBytes, lookup)
	if err != nil {
		return signingbroker.CompletedDecision{}, err
	}
	if err := store.validateDecisionJournal(ctx, manifest); err != nil {
		return signingbroker.CompletedDecision{}, err
	}
	resolve := func(ref blobRef, maximum int, label string) (signingbroker.MetadataRecord, error) {
		if err := store.validateBlobRef(ref, maximum); err != nil {
			return signingbroker.MetadataRecord{}, fmt.Errorf("completed decision %s reference: %w", label, err)
		}
		data, err := store.readLockedObject(
			ctx,
			ref.Key,
			ref.VersionID,
			ref.SHA256,
			ref.Length,
			maximum,
			true,
		)
		if err != nil {
			return signingbroker.MetadataRecord{}, fmt.Errorf("read completed decision %s: %w", label, err)
		}
		return signingbroker.MetadataRecord{Version: ref.Version, SHA256: ref.SHA256, Bytes: data}, nil
	}
	root, err := resolve(manifest.Root, repository.MaxRootMetadataBytes, "root")
	if err != nil {
		return signingbroker.CompletedDecision{}, err
	}
	inputMaximum := repository.MaxSnapshotMetadataBytes
	outputMaximum := repository.MaxTimestampMetadataBytes
	if manifest.Role == "snapshot" {
		inputMaximum = repository.MaxTargetsMetadataBytes
		outputMaximum = repository.MaxSnapshotMetadataBytes
	}
	input, err := resolve(manifest.Input, inputMaximum, "input")
	if err != nil {
		return signingbroker.CompletedDecision{}, err
	}
	decisionOutput, err := resolve(manifest.Output, outputMaximum, "output")
	if err != nil {
		return signingbroker.CompletedDecision{}, err
	}
	return signingbroker.CompletedDecision{
		Role: manifest.Role, CandidateID: manifest.CandidateID,
		RequestSHA256: manifest.RequestSHA256,
		RequestObject: cloneRequestObject(manifest.RequestObject),
		ReleaseID:     manifest.ReleaseID, CreatedAt: manifest.CreatedAt,
		StateRevision: manifest.StateRevision,
		Root:          root, Input: input, Output: decisionOutput,
	}, nil
}

func (store *StateStore) ensureManifestDecisions(
	ctx context.Context,
	manifest stateManifest,
	journal blobRef,
) error {
	if err := store.bindManifestToJournal(manifest, journal); err != nil {
		return fmt.Errorf("bind decision source manifest to its journal: %w", err)
	}
	if pending := manifest.PendingSnapshot; pending != nil {
		decisionManifest, err := store.snapshotDecisionAtJournal(ctx, manifest, journal, pending)
		if err != nil {
			return fmt.Errorf("bind completed snapshot decision to state journal: %w", err)
		}
		if err := store.ensureDecision(ctx, decisionManifest); err != nil {
			return fmt.Errorf("archive completed snapshot decision: %w", err)
		}
	}
	if pending := manifest.PendingTimestamp; pending != nil {
		decisionManifest, err := store.timestampDecisionAtJournal(ctx, manifest, journal, pending)
		if err != nil {
			return fmt.Errorf("bind completed timestamp decision to state journal: %w", err)
		}
		if err := store.ensureDecision(ctx, decisionManifest); err != nil {
			return fmt.Errorf("archive completed timestamp decision: %w", err)
		}
	}
	return nil
}

func (store *StateStore) snapshotDecisionAtJournal(
	ctx context.Context,
	manifest stateManifest,
	journal blobRef,
	pending *manifestPendingSnapshot,
) (decisionManifest, error) {
	if pending == nil {
		return decisionManifest{}, errors.New("snapshot decision has no pending record")
	}
	authorizedManifest, authorizedJournal, err := store.journalAtRevision(
		ctx,
		manifest,
		journal,
		pending.StateRevision,
	)
	if err != nil {
		return decisionManifest{}, err
	}
	decision := decisionManifest{
		SchemaVersion: decisionRecordSchema, Environment: manifest.Environment,
		RepositoryID: manifest.RepositoryID, StateID: manifest.StateID,
		Role: "snapshot", CandidateID: pending.CandidateID,
		RequestSHA256: pending.RequestSHA256,
		RequestObject: cloneRequestObject(pending.RequestObject),
		ReleaseID:     pending.ReleaseID, CreatedAt: pending.CreatedAt,
		StateRevision: pending.StateRevision, StateJournal: authorizedJournal,
		Root: pending.Root, Input: pending.Targets, Output: pending.Snapshot,
	}
	if !decisionAppearsInStateManifest(decision, authorizedManifest) {
		return decisionManifest{}, errors.New("snapshot decision is absent from its claimed state journal")
	}
	return decision, nil
}

func (store *StateStore) timestampDecisionAtJournal(
	ctx context.Context,
	manifest stateManifest,
	journal blobRef,
	pending *manifestPendingTimestamp,
) (decisionManifest, error) {
	if pending == nil {
		return decisionManifest{}, errors.New("timestamp decision has no pending record")
	}
	authorizedManifest, authorizedJournal, err := store.journalAtRevision(
		ctx,
		manifest,
		journal,
		pending.StateRevision,
	)
	if err != nil {
		return decisionManifest{}, err
	}
	decision := decisionManifest{
		SchemaVersion: decisionRecordSchema, Environment: manifest.Environment,
		RepositoryID: manifest.RepositoryID, StateID: manifest.StateID,
		Role: "timestamp", CandidateID: pending.CandidateID,
		RequestSHA256: pending.RequestSHA256,
		RequestObject: cloneRequestObject(pending.RequestObject),
		ReleaseID:     pending.ReleaseID, CreatedAt: pending.CreatedAt,
		StateRevision: pending.StateRevision, StateJournal: authorizedJournal,
		Root: pending.Root, Input: pending.Snapshot, Output: pending.Timestamp,
	}
	if !decisionAppearsInStateManifest(decision, authorizedManifest) {
		return decisionManifest{}, errors.New("timestamp decision is absent from its claimed state journal")
	}
	return decision, nil
}

func (store *StateStore) validateDecisionJournal(ctx context.Context, decision decisionManifest) error {
	store.mu.RLock()
	loadedRevision := store.loadedRevision
	loadedManifestBytes := append([]byte(nil), store.loadedManifest...)
	loadedJournal := store.loadedJournal
	store.mu.RUnlock()
	if loadedRevision < 1 || len(loadedManifestBytes) == 0 {
		return errors.New("completed decision cannot be authenticated before broker state is loaded")
	}
	if decision.StateRevision > loadedRevision {
		return errors.New("completed decision revision is newer than loaded broker state")
	}
	loadedManifest, err := store.decodeManifest(loadedManifestBytes, loadedRevision)
	if err != nil {
		return fmt.Errorf("decode loaded state before completed decision authentication: %w", err)
	}
	authorizedManifest, authorizedJournal, err := store.journalAtRevision(
		ctx,
		loadedManifest,
		loadedJournal,
		decision.StateRevision,
	)
	if err != nil {
		return fmt.Errorf("authenticate completed decision journal ancestry: %w", err)
	}
	if authorizedJournal != decision.StateJournal {
		return errors.New("completed decision journal is not the exact reachable state journal")
	}
	if !decisionAppearsInStateManifest(decision, authorizedManifest) {
		return errors.New("completed decision is absent from its authenticated state journal")
	}
	return nil
}

func (store *StateStore) journalAtRevision(
	ctx context.Context,
	manifest stateManifest,
	journal blobRef,
	targetRevision int64,
) (stateManifest, blobRef, error) {
	if targetRevision < 1 || targetRevision > manifest.Revision {
		return stateManifest{}, blobRef{}, errors.New("requested state journal revision is outside the committed chain")
	}
	currentManifest := manifest
	currentJournal := journal
	for {
		if err := ctx.Err(); err != nil {
			return stateManifest{}, blobRef{}, err
		}
		if err := store.bindManifestToJournal(currentManifest, currentJournal); err != nil {
			return stateManifest{}, blobRef{}, err
		}
		if currentManifest.Revision == targetRevision {
			return currentManifest, currentJournal, nil
		}
		if currentManifest.PreviousJournal == nil {
			return stateManifest{}, blobRef{}, errors.New("committed state journal chain ended before the requested revision")
		}
		predecessorJournal := *currentManifest.PreviousJournal
		predecessorBytes, err := store.readLockedObject(
			ctx,
			predecessorJournal.Key,
			predecessorJournal.VersionID,
			predecessorJournal.SHA256,
			predecessorJournal.Length,
			maxManifestBytes,
			true,
		)
		if err != nil {
			return stateManifest{}, blobRef{}, fmt.Errorf("read predecessor state journal: %w", err)
		}
		predecessorManifest, err := store.decodeManifest(predecessorBytes, currentManifest.Revision-1)
		if err != nil {
			return stateManifest{}, blobRef{}, fmt.Errorf("decode predecessor state journal: %w", err)
		}
		currentManifest = predecessorManifest
		currentJournal = predecessorJournal
	}
}

func (store *StateStore) bindManifestToJournal(manifest stateManifest, journal blobRef) error {
	if err := store.validateJournalRef(journal, manifest.Revision); err != nil {
		return err
	}
	encoded, err := json.Marshal(manifest)
	if err != nil {
		return fmt.Errorf("encode state manifest for journal binding: %w", err)
	}
	if len(encoded) == 0 || len(encoded) > maxManifestBytes ||
		int64(len(encoded)) != journal.Length || digestHex(encoded) != journal.SHA256 {
		return errors.New("state manifest does not match its immutable journal reference")
	}
	return nil
}

func decisionAppearsInStateManifest(decision decisionManifest, manifest stateManifest) bool {
	if decision.StateRevision != manifest.Revision || decision.StateJournal.Version != manifest.Revision {
		return false
	}
	sameRequestObject := func(left, right *signingbroker.ImmutableRequestObject) bool {
		return left != nil && right != nil && *left == *right
	}
	if decision.Role == "snapshot" {
		pending := manifest.PendingSnapshot
		return pending != nil && pending.CandidateID == decision.CandidateID &&
			pending.RequestSHA256 == decision.RequestSHA256 &&
			sameRequestObject(pending.RequestObject, decision.RequestObject) &&
			pending.ReleaseID == decision.ReleaseID && pending.CreatedAt == decision.CreatedAt &&
			pending.StateRevision == decision.StateRevision && pending.Root == decision.Root &&
			pending.Targets == decision.Input && pending.Snapshot == decision.Output
	}
	if decision.Role == "timestamp" {
		pending := manifest.PendingTimestamp
		return pending != nil && pending.CandidateID == decision.CandidateID &&
			pending.RequestSHA256 == decision.RequestSHA256 &&
			sameRequestObject(pending.RequestObject, decision.RequestObject) &&
			pending.ReleaseID == decision.ReleaseID && pending.CreatedAt == decision.CreatedAt &&
			pending.StateRevision == decision.StateRevision && pending.Root == decision.Root &&
			pending.Snapshot == decision.Input && pending.Timestamp == decision.Output
	}
	return false
}

func (store *StateStore) ensureDecision(ctx context.Context, manifest decisionManifest) error {
	lookup := signingbroker.DecisionLookup{
		StateID: manifest.StateID, Role: manifest.Role,
		CandidateID: manifest.CandidateID, RequestSHA256: manifest.RequestSHA256,
		RequestObject: manifest.RequestObject,
	}
	if _, err := store.decodeDecisionManifestMustMarshal(manifest, lookup); err != nil {
		return err
	}
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		return fmt.Errorf("encode completed decision: %w", err)
	}
	if len(manifestBytes) == 0 || len(manifestBytes) > maxDecisionRecordBytes {
		return errors.New("completed decision exceeds its size limit")
	}
	recordID, err := completedDecisionRecordID(decisionIdentity{
		Role: manifest.Role, CandidateID: manifest.CandidateID,
		RequestSHA256: manifest.RequestSHA256,
		RequestObject: cloneRequestObject(manifest.RequestObject),
	})
	if err != nil {
		return err
	}
	input := &dynamodb.UpdateItemInput{
		TableName: aws.String(store.config.TableName),
		Key: map[string]dynamodbtypes.AttributeValue{
			"state_id":  &dynamodbtypes.AttributeValueMemberS{Value: store.config.StateID},
			"record_id": &dynamodbtypes.AttributeValueMemberS{Value: recordID},
		},
		ConditionExpression: aws.String(
			"attribute_not_exists(#state) AND attribute_not_exists(#record) AND attribute_not_exists(#schema) AND attribute_not_exists(#decision)",
		),
		ExpressionAttributeNames: map[string]string{
			"#state": "state_id", "#record": "record_id",
			"#schema": "schema_version", "#decision": "decision",
		},
		ExpressionAttributeValues: map[string]dynamodbtypes.AttributeValue{
			":schema":   &dynamodbtypes.AttributeValueMemberS{Value: decisionRecordSchema},
			":decision": &dynamodbtypes.AttributeValueMemberS{Value: string(manifestBytes)},
		},
		UpdateExpression: aws.String("SET #schema = :schema, #decision = :decision"),
		ReturnValues:     dynamodbtypes.ReturnValueAllNew,
	}
	output, updateErr := store.dynamodb.UpdateItem(ctx, input)
	if updateErr == nil && output != nil {
		stored, decodeErr := decodeDecisionItem(output.Attributes, store.config.StateID, recordID)
		if decodeErr == nil && string(stored) == string(manifestBytes) {
			return nil
		}
	}
	matches, reconcileErr := store.completedDecisionMatches(ctx, recordID, manifestBytes)
	if reconcileErr == nil && matches {
		return nil
	}
	if updateErr != nil {
		return fmt.Errorf("create immutable completed decision: %w", updateErr)
	}
	if output == nil {
		return errors.New("create immutable completed decision: DynamoDB returned nil output")
	}
	if reconcileErr != nil {
		return reconcileErr
	}
	return errors.New("completed decision record differs from the exact prior decision")
}

func (store *StateStore) completedDecisionMatches(
	ctx context.Context,
	recordID string,
	manifest []byte,
) (bool, error) {
	output, err := store.dynamodb.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(store.config.TableName),
		ConsistentRead: aws.Bool(true),
		Key: map[string]dynamodbtypes.AttributeValue{
			"state_id":  &dynamodbtypes.AttributeValueMemberS{Value: store.config.StateID},
			"record_id": &dynamodbtypes.AttributeValueMemberS{Value: recordID},
		},
	})
	if err != nil {
		return false, fmt.Errorf("reconcile completed decision: %w", err)
	}
	if output == nil || len(output.Item) == 0 {
		return false, nil
	}
	stored, err := decodeDecisionItem(output.Item, store.config.StateID, recordID)
	if err != nil {
		return false, err
	}
	return string(stored) == string(manifest), nil
}

func (store *StateStore) decodeDecisionManifestMustMarshal(
	manifest decisionManifest,
	lookup signingbroker.DecisionLookup,
) (decisionManifest, error) {
	encoded, err := json.Marshal(manifest)
	if err != nil {
		return decisionManifest{}, fmt.Errorf("encode completed decision for validation: %w", err)
	}
	return store.decodeDecisionManifest(encoded, lookup)
}

func (store *StateStore) decodeDecisionManifest(
	data []byte,
	lookup signingbroker.DecisionLookup,
) (decisionManifest, error) {
	if len(data) == 0 || len(data) > maxDecisionRecordBytes {
		return decisionManifest{}, errors.New("completed decision is outside its size limit")
	}
	var manifest decisionManifest
	if err := strictjson.Decode(data, &manifest); err != nil {
		return decisionManifest{}, fmt.Errorf("decode strict completed decision: %w", err)
	}
	if manifest.SchemaVersion != decisionRecordSchema ||
		manifest.Environment != store.config.Environment ||
		manifest.RepositoryID != store.config.RepositoryID || manifest.StateID != store.config.StateID ||
		manifest.Role != lookup.Role || manifest.CandidateID != lookup.CandidateID ||
		manifest.RequestSHA256 != lookup.RequestSHA256 || manifest.RequestObject == nil ||
		lookup.RequestObject == nil || *manifest.RequestObject != *lookup.RequestObject ||
		!releaseIDPattern.MatchString(manifest.ReleaseID) || manifest.StateRevision < 1 ||
		manifest.StateRevision > maxSafeInteger {
		return decisionManifest{}, errors.New("completed decision context is invalid")
	}
	if err := store.validateJournalRef(manifest.StateJournal, manifest.StateRevision); err != nil {
		return decisionManifest{}, fmt.Errorf("completed decision state journal: %w", err)
	}
	if err := store.validateRequestObject(
		manifest.RequestObject,
		manifest.Role,
		manifest.CandidateID,
		manifest.RequestSHA256,
	); err != nil {
		return decisionManifest{}, fmt.Errorf("completed decision request source: %w", err)
	}
	inputMaximum := repository.MaxSnapshotMetadataBytes
	outputMaximum := repository.MaxTimestampMetadataBytes
	if manifest.Role == "snapshot" {
		inputMaximum = repository.MaxTargetsMetadataBytes
		outputMaximum = repository.MaxSnapshotMetadataBytes
	}
	for _, reference := range []struct {
		label   string
		value   blobRef
		maximum int
	}{
		{label: "root", value: manifest.Root, maximum: repository.MaxRootMetadataBytes},
		{label: "input", value: manifest.Input, maximum: inputMaximum},
		{label: "output", value: manifest.Output, maximum: outputMaximum},
	} {
		if err := store.validateBlobRef(reference.value, reference.maximum); err != nil {
			return decisionManifest{}, fmt.Errorf("completed decision %s reference: %w", reference.label, err)
		}
	}
	return manifest, nil
}

func completedDecisionRecordID(identity decisionIdentity) (string, error) {
	if identity.RequestObject == nil {
		return "", errors.New("completed decision identity requires immutable request provenance")
	}
	encoded, err := json.Marshal(identity)
	if err != nil {
		return "", fmt.Errorf("encode completed decision identity: %w", err)
	}
	return decisionRecordIDPrefix + digestHex(encoded), nil
}

func decodeDecisionItem(
	item map[string]dynamodbtypes.AttributeValue,
	stateID string,
	recordID string,
) ([]byte, error) {
	if len(item) != 4 {
		return nil, errors.New("completed decision record has unexpected attributes")
	}
	stringValue := func(name string) (string, error) {
		value, ok := item[name].(*dynamodbtypes.AttributeValueMemberS)
		if !ok {
			return "", fmt.Errorf("completed decision record %s is not a string", name)
		}
		return value.Value, nil
	}
	storedStateID, err := stringValue("state_id")
	if err != nil || storedStateID != stateID {
		return nil, errors.New("completed decision record has the wrong state ID")
	}
	storedRecordID, err := stringValue("record_id")
	if err != nil || storedRecordID != recordID {
		return nil, errors.New("completed decision record has the wrong record ID")
	}
	schema, err := stringValue("schema_version")
	if err != nil || schema != decisionRecordSchema {
		return nil, errors.New("completed decision record has the wrong schema")
	}
	decision, err := stringValue("decision")
	if err != nil || len(decision) == 0 || len(decision) > maxDecisionRecordBytes {
		return nil, errors.New("completed decision record is outside its size limit")
	}
	return []byte(decision), nil
}

var _ signingbroker.CompletedDecisionStore = (*StateStore)(nil)
