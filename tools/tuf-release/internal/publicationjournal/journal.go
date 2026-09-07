// Package publicationjournal orders one publication attempt per environment.
// It is a coordination policy, not a TUF authorization mechanism. Its caller
// must authenticate the binding using the protected publication operator.
// A durable, conditional, history-preserving Store is required for live use;
// process-local memory and workflow concurrency alone do not satisfy that port.
package publicationjournal

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"strings"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/signingbroker"
)

const maxSafeInteger int64 = 9007199254740991

var (
	ErrNotFound       = errors.New("publication journal is absent")
	ErrConflict       = errors.New("publication journal owner or revision changed")
	ErrUnresolved     = errors.New("publication attempt is unresolved; independent reconciliation is required")
	sha256Pattern     = regexp.MustCompile(`^[a-f0-9]{64}$`)
	ownerPattern      = regexp.MustCompile(`^[1-9][0-9]{0,18}:[1-9][0-9]{0,8}$`)
	releasePattern    = regexp.MustCompile(`^r[0-9]{10}-g[a-f0-9]{40}$`)
	gitPattern        = regexp.MustCompile(`^[a-f0-9]{40}$`)
	repositoryPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+$`)
	actorPattern      = regexp.MustCompile(`^[1-9][0-9]{0,19}$`)
)

type Phase string

const (
	Claimed         Phase = "claimed"
	ArchiveVerified Phase = "archive-verified"
	ParentStarted   Phase = "parent-started"
	ParentCreated   Phase = "parent-created"
	UploadStarted   Phase = "upload-started"
	Uploaded        Phase = "uploaded"
	PreviewVerified Phase = "preview-verified"
	DeployStarted   Phase = "deploy-started"
	Deployed        Phase = "deployed"
	RouteStarted    Phase = "route-started"
	RouteActivated  Phase = "route-activated"
	Confirmed       Phase = "confirmed"
)

type Config struct {
	Environment         string
	RepositoryID        string
	StateID             string
	BootstrapRootSHA256 string
	GitHubRepository    string
	WorkflowRef         string
	// Historical pins permit audit readback only. They never authorize a new
	// claim or continuation after the active workflow has been replaced.
	HistoricalWorkflowRefs []string
}

// Binding values originate from protected runner configuration, retained
// archive evidence and a fresh authenticated operator result, never a candidate
// supplied authorization file. Owner is the GitHub run ID and attempt number.
type Binding struct {
	GitSHA                   string                                 `json:"git_sha"`
	ArtifactIdentity         string                                 `json:"artifact_identity"`
	ArtifactSHA256           string                                 `json:"artifact_sha256"`
	ArtifactSetSHA256        string                                 `json:"artifact_set_sha256"`
	GitHubRepository         string                                 `json:"github_repository"`
	WorkflowRef              string                                 `json:"workflow_ref"`
	ActorID                  string                                 `json:"actor_id"`
	Owner                    string                                 `json:"owner"`
	RepositorySHA256         string                                 `json:"repository_sha256"`
	PreviousRepositorySHA256 string                                 `json:"previous_repository_sha256"`
	WorkflowSHA256           string                                 `json:"workflow_sha256"`
	ConfigSHA256             string                                 `json:"config_sha256"`
	ExecutableSHA256         string                                 `json:"executable_sha256"`
	Authorization            signingbroker.PublicationAuthorization `json:"authorization"`
}

// Record contains values only, so storage cannot alias mutable caller slices.
// Stores must retain the previous revisions as audit evidence, not discard them.
type Record struct {
	SchemaVersion          string                                 `json:"schema_version"`
	Revision               int64                                  `json:"revision"`
	Binding                Binding                                `json:"binding"`
	Phase                  Phase                                  `json:"phase"`
	EvidenceSHA256         string                                 `json:"evidence_sha256"`
	ClaimedAt              string                                 `json:"claimed_at"`
	UpdatedAt              string                                 `json:"updated_at"`
	Confirmation           signingbroker.PublicationConfirmation  `json:"confirmation"`
	OperationAuthorization signingbroker.PublicationAuthorization `json:"operation_authorization"`
	Result                 string                                 `json:"result"`
	FailureCode            string                                 `json:"failure_code"`
	ResumeDisposition      string                                 `json:"resume_disposition"`
}

type Store interface {
	Load(context.Context, string) (Record, error)
	CompareAndSwap(context.Context, string, int64, Record) error
}

type Controller struct {
	config Config
	store  Store
	clock  func() time.Time
}

func New(config Config, store Store, clock func() time.Time) (*Controller, error) {
	if (config.Environment != "staging" && config.Environment != "production") ||
		config.RepositoryID != "hid-"+config.Environment+"-v1" ||
		config.StateID != "hid-"+config.Environment+"-broker-v1" || !sha256Pattern.MatchString(config.BootstrapRootSHA256) ||
		!repositoryPattern.MatchString(config.GitHubRepository) || !validWorkflowRef(config.GitHubRepository, config.WorkflowRef) ||
		isNilStore(store) || clock == nil {
		return nil, errors.New("fixed publication journal configuration, store and clock are required")
	}
	seen := map[string]bool{config.WorkflowRef: true}
	if len(config.HistoricalWorkflowRefs) > 64 {
		return nil, errors.New("historical workflow pin policy exceeds its bound")
	}
	for _, ref := range config.HistoricalWorkflowRefs {
		if !validWorkflowRef(config.GitHubRepository, ref) || seen[ref] {
			return nil, errors.New("historical workflow pins must be exact and distinct")
		}
		seen[ref] = true
	}
	config.HistoricalWorkflowRefs = append([]string(nil), config.HistoricalWorkflowRefs...)
	return &Controller{config: config, store: store, clock: clock}, nil
}

func validWorkflowRef(repository, ref string) bool {
	parts := strings.Split(ref, "@")
	return len(parts) == 2 && gitPattern.MatchString(parts[1]) &&
		parts[0] == repository+"/.github/workflows/tuf-publish.yml"
}

func isNilStore(store Store) bool {
	if store == nil {
		return true
	}
	value := reflect.ValueOf(store)
	switch value.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return value.IsNil()
	default:
		return false
	}
}

func (controller *Controller) key() string {
	return "hid-" + controller.config.Environment + "-publication-v1"
}

// Begin never resumes an existing attempt, even for the same owner. A crash
// after a claim or intent might have performed an external side effect. There
// is deliberately no TTL, takeover, retry, clear, or automatic recovery API.
func (controller *Controller) Begin(ctx context.Context, binding Binding) (Record, error) {
	if err := controller.checkContext(ctx); err != nil {
		return Record{}, err
	}
	current, loadErr := controller.store.Load(ctx, controller.key())
	if loadErr != nil && !errors.Is(loadErr, ErrNotFound) {
		return Record{}, loadErr
	}
	now := controller.clock().UTC().Truncate(time.Second)
	if err := controller.validateBinding(binding); err != nil {
		return Record{}, err
	}
	issued, err := canonicalTime(binding.Authorization.AuthorizedAt)
	if err != nil || issued.After(now) || now.Sub(issued) > time.Minute {
		return Record{}, errors.New("journal claim requires a freshly authenticated publication")
	}
	return controller.beginLoaded(ctx, binding, current, now, errors.Is(loadErr, ErrNotFound))
}

func (controller *Controller) beginLoaded(ctx context.Context, binding Binding, current Record, now time.Time, absent bool) (Record, error) {
	revision := int64(0)
	if absent {
		if current != (Record{}) || binding.PreviousRepositorySHA256 != "" || binding.Authorization.StateRevision != 0 {
			return Record{}, errors.New("empty journal requires an authenticated bootstrap")
		}
	} else {
		if err := controller.validateRecord(current); err != nil {
			return Record{}, err
		}
		if current.Phase != Confirmed {
			return Record{}, ErrUnresolved
		}
		if binding.Owner == current.Binding.Owner || binding.PreviousRepositorySHA256 != current.Binding.RepositorySHA256 ||
			binding.Authorization.Current != current.Confirmation.Published ||
			binding.Authorization.StateRevision < current.Confirmation.StateRevision {
			return Record{}, errors.New("publication claim does not follow the confirmed predecessor")
		}
		previousTime, _ := canonicalTime(current.UpdatedAt)
		if now.Before(previousTime) {
			return Record{}, errors.New("publication journal clock moved backwards")
		}
		revision = current.Revision
	}
	if revision >= maxSafeInteger {
		return Record{}, errors.New("publication journal revision exhausted")
	}
	next := Record{SchemaVersion: "1.0.0", Revision: revision + 1, Binding: binding, Phase: Claimed,
		ClaimedAt: now.Format(time.RFC3339), UpdatedAt: now.Format(time.RFC3339), Result: "pending", ResumeDisposition: "same-run-only"}
	return controller.commit(ctx, revision, next)
}

// Advance records a verified receipt or an intent BEFORE its external action.
// The caller must not perform the effect if this CAS fails. An intent can only
// advance to its verified result; it cannot be replayed after an uncertain exit.
func (controller *Controller) Advance(ctx context.Context, owner string, revision int64, phase Phase, evidenceSHA256 string, fresh ...signingbroker.PublicationAuthorization) (Record, error) {
	current, now, err := controller.owned(ctx, owner, revision)
	if err != nil {
		return Record{}, err
	}
	allowed := map[Phase]Phase{Claimed: ArchiveVerified, ArchiveVerified: UploadStarted,
		ParentStarted: ParentCreated, ParentCreated: UploadStarted,
		UploadStarted: Uploaded, Uploaded: PreviewVerified, PreviewVerified: DeployStarted,
		DeployStarted: Deployed, Deployed: RouteStarted, RouteStarted: RouteActivated}
	bootstrapParent := current.Phase == ArchiveVerified && phase == ParentStarted && current.Binding.Authorization.StateRevision == 0
	if !bootstrapParent && allowed[current.Phase] != phase || phase == "" || !sha256Pattern.MatchString(evidenceSHA256) {
		return Record{}, errors.New("publication journal transition or evidence hash is invalid")
	}
	next := current
	next.Revision++
	next.Phase, next.EvidenceSHA256, next.UpdatedAt = phase, evidenceSHA256, now.Format(time.RFC3339)
	next.OperationAuthorization = signingbroker.PublicationAuthorization{}
	if isIntent(phase) {
		if len(fresh) != 1 {
			return Record{}, errors.New("effect intent requires fresh exact publication authorization")
		}
		if err := validateFreshAuthorization(current.Binding.Authorization, fresh[0], now); err != nil {
			return Record{}, err
		}
		next.OperationAuthorization = fresh[0]
	}
	return controller.commit(ctx, revision, next)
}

func (controller *Controller) Confirm(ctx context.Context, owner string, revision int64, confirmation signingbroker.PublicationConfirmation, evidenceSHA256 string) (Record, error) {
	current, now, err := controller.owned(ctx, owner, revision)
	if err != nil {
		return Record{}, err
	}
	if current.Phase != Deployed && current.Phase != RouteActivated {
		return Record{}, errors.New("publication was not deployed before confirmation")
	}
	if !sha256Pattern.MatchString(evidenceSHA256) {
		return Record{}, errors.New("confirmation evidence hash is invalid")
	}
	if err := validateConfirmation(current.Binding.Authorization, confirmation); err != nil {
		return Record{}, err
	}
	confirmed, _ := canonicalTime(confirmation.ConfirmedAt)
	updated, _ := canonicalTime(current.UpdatedAt)
	if confirmed.Before(updated) || confirmed.After(now) || now.Sub(confirmed) > time.Minute {
		return Record{}, errors.New("journal completion requires fresh post-deployment confirmation")
	}
	next := current
	next.Revision++
	next.Phase, next.EvidenceSHA256, next.UpdatedAt, next.Confirmation = Confirmed, evidenceSHA256, now.Format(time.RFC3339), confirmation
	next.Result, next.ResumeDisposition = "completed", "new-attempt-only"
	next.OperationAuthorization = signingbroker.PublicationAuthorization{}
	return controller.commit(ctx, revision, next)
}

func (controller *Controller) checkContext(ctx context.Context) error {
	if controller == nil || ctx == nil {
		return errors.New("publication journal controller and context are required")
	}
	return ctx.Err()
}

func (controller *Controller) owned(ctx context.Context, owner string, revision int64) (Record, time.Time, error) {
	if err := controller.checkContext(ctx); err != nil {
		return Record{}, time.Time{}, err
	}
	current, err := controller.store.Load(ctx, controller.key())
	if err != nil {
		return Record{}, time.Time{}, err
	}
	if err := controller.validateRecord(current); err != nil {
		return Record{}, time.Time{}, err
	}
	if current.Binding.Owner != owner || current.Revision != revision {
		return Record{}, time.Time{}, ErrConflict
	}
	if current.Binding.WorkflowRef != controller.config.WorkflowRef {
		return Record{}, time.Time{}, errors.New("historical workflow cannot continue a publication")
	}
	if revision >= maxSafeInteger || current.Phase == Confirmed || current.Result == "failed" {
		return Record{}, time.Time{}, errors.New("publication attempt is closed or revision exhausted")
	}
	now := controller.clock().UTC().Truncate(time.Second)
	previous, _ := canonicalTime(current.UpdatedAt)
	if now.Before(previous) {
		return Record{}, time.Time{}, errors.New("publication journal clock moved backwards")
	}
	claimed, _ := canonicalTime(current.ClaimedAt)
	if now.Sub(claimed) > 30*time.Minute {
		return Record{}, time.Time{}, errors.New("publication attempt is stale; independent reconciliation is required")
	}
	return current, now, nil
}

func (controller *Controller) commit(ctx context.Context, previous int64, next Record) (Record, error) {
	if err := controller.validateRecord(next); err != nil {
		return Record{}, err
	}
	if err := ctx.Err(); err != nil {
		return Record{}, err
	}
	if err := controller.store.CompareAndSwap(ctx, controller.key(), previous, next); err != nil {
		return Record{}, err
	}
	// A committed intent with a canceled caller remains unresolved. Never let
	// the caller treat a canceled storage operation as permission for an effect.
	if err := ctx.Err(); err != nil {
		return Record{}, err
	}
	return next, nil
}

func (controller *Controller) validateBinding(binding Binding) error {
	if binding.WorkflowRef != controller.config.WorkflowRef {
		return errors.New("publication requires the active workflow pin")
	}
	return controller.validateHistoricalBinding(binding)
}

func (controller *Controller) validateHistoricalBinding(binding Binding) error {
	approved := binding.WorkflowRef == controller.config.WorkflowRef
	for _, ref := range controller.config.HistoricalWorkflowRefs {
		approved = approved || binding.WorkflowRef == ref
	}
	auth := binding.Authorization
	if !ownerPattern.MatchString(binding.Owner) || !sha256Pattern.MatchString(binding.RepositorySHA256) ||
		!gitPattern.MatchString(binding.GitSHA) || !strings.HasSuffix(auth.ReleaseID, "-g"+binding.GitSHA) ||
		binding.ArtifactIdentity != "environments/"+auth.Environment+"/releases/"+auth.ReleaseID+"/release-bundle.json" ||
		!sha256Pattern.MatchString(binding.ArtifactSHA256) || !sha256Pattern.MatchString(binding.ArtifactSetSHA256) ||
		binding.GitHubRepository != controller.config.GitHubRepository || !approved || !actorPattern.MatchString(binding.ActorID) ||
		!sha256Pattern.MatchString(binding.WorkflowSHA256) || !sha256Pattern.MatchString(binding.ConfigSHA256) ||
		!sha256Pattern.MatchString(binding.ExecutableSHA256) || auth.SchemaVersion != "1.0.0" ||
		auth.Environment != controller.config.Environment || auth.RepositoryID != controller.config.RepositoryID ||
		auth.StateID != controller.config.StateID || auth.BootstrapRootSHA256 != controller.config.BootstrapRootSHA256 ||
		!releasePattern.MatchString(auth.ReleaseID) || auth.StateRevision < 0 || auth.StateRevision >= maxSafeInteger {
		return errors.New("publication journal binding differs from fixed trust or has invalid identity")
	}
	issued, err := canonicalTime(auth.AuthorizedAt)
	if err != nil {
		return err
	}
	expires, err := canonicalTime(auth.ExpiresAt)
	if err != nil || expires.Sub(issued) != 5*time.Minute {
		return errors.New("publication authorization lifetime is invalid")
	}
	bootstrap := auth.StateRevision == 0
	if bootstrap && binding.PreviousRepositorySHA256 != "" || !bootstrap && !sha256Pattern.MatchString(binding.PreviousRepositorySHA256) {
		return errors.New("publication predecessor hash is invalid")
	}
	for selection, roles := range []signingbroker.PublicationMetadata{auth.Current, auth.Candidate} {
		if bootstrap && selection == 0 {
			if roles != (signingbroker.PublicationMetadata{}) {
				return errors.New("bootstrap must not have current metadata")
			}
			continue
		}
		for _, role := range []signingbroker.PublicationRole{roles.Root, roles.Targets, roles.Snapshot, roles.Timestamp} {
			if role.Version < 1 || role.Version > maxSafeInteger || !sha256Pattern.MatchString(role.SHA256) || bootstrap && role.Version != 1 {
				return errors.New("publication metadata identity is invalid")
			}
		}
	}
	if bootstrap && auth.Candidate.Root.SHA256 != controller.config.BootstrapRootSHA256 {
		return errors.New("bootstrap root is not pinned")
	}
	return nil
}

func (controller *Controller) validateRecord(record Record) error {
	if record.SchemaVersion != "1.0.0" || record.Revision < 1 || record.Revision > maxSafeInteger {
		return errors.New("publication journal record is invalid")
	}
	if err := controller.validateHistoricalBinding(record.Binding); err != nil {
		return err
	}
	claimed, err := canonicalTime(record.ClaimedAt)
	if err != nil {
		return err
	}
	updated, err := canonicalTime(record.UpdatedAt)
	if err != nil || updated.Before(claimed) {
		return errors.New("publication journal chronology is invalid")
	}
	issued, _ := canonicalTime(record.Binding.Authorization.AuthorizedAt)
	if claimed.Before(issued) || claimed.Sub(issued) > time.Minute {
		return errors.New("journal claim was not freshly authorized")
	}
	switch record.Phase {
	case Claimed:
		if record.Result != "failed" && (record.EvidenceSHA256 != "" || updated != claimed) {
			return errors.New("claim unexpectedly contains effect evidence or changed time")
		}
		if record.Result == "failed" && !sha256Pattern.MatchString(record.EvidenceSHA256) {
			return errors.New("failed claim lacks evidence")
		}
	case ArchiveVerified, ParentStarted, ParentCreated, UploadStarted, Uploaded, PreviewVerified, DeployStarted, Deployed, RouteStarted, RouteActivated, Confirmed:
		if !sha256Pattern.MatchString(record.EvidenceSHA256) {
			return errors.New("publication journal evidence hash is invalid")
		}
	default:
		return errors.New("publication journal phase is invalid")
	}
	if (record.Phase == ParentStarted || record.Phase == ParentCreated) && record.Binding.Authorization.StateRevision != 0 {
		return errors.New("parent creation is restricted to bootstrap publication")
	}
	if record.Phase == Confirmed {
		if record.OperationAuthorization != (signingbroker.PublicationAuthorization{}) {
			return errors.New("completed record contains effect authorization")
		}
		if record.Result != "completed" || record.ResumeDisposition != "new-attempt-only" || record.FailureCode != "" {
			return errors.New("completed publication disposition is invalid")
		}
		if err := validateConfirmation(record.Binding.Authorization, record.Confirmation); err != nil {
			return err
		}
		confirmed, _ := canonicalTime(record.Confirmation.ConfirmedAt)
		if confirmed.Before(claimed) || confirmed.After(updated) || updated.Sub(confirmed) > time.Minute {
			return errors.New("stored confirmation chronology is invalid")
		}
		return nil
	}
	if record.Result == "failed" {
		if record.ResumeDisposition != "reconciliation-required" || !validFailureCode(record.FailureCode) {
			return errors.New("publication failure disposition is invalid")
		}
	} else if record.Result != "pending" || record.ResumeDisposition != "same-run-only" || record.FailureCode != "" {
		return errors.New("publication disposition is invalid")
	}
	if record.Result != "failed" && isIntent(record.Phase) {
		if err := validateFreshAuthorization(record.Binding.Authorization, record.OperationAuthorization, updated); err != nil {
			return err
		}
	} else if record.OperationAuthorization != (signingbroker.PublicationAuthorization{}) {
		return errors.New("unexpected effect authorization")
	}
	if record.Confirmation != (signingbroker.PublicationConfirmation{}) {
		return errors.New("unconfirmed attempt contains completion evidence")
	}
	return nil
}

// RecordFailure preserves an unresolved attempt without storing raw errors or
// secret-bearing logs. It cannot clear, resume, steal or complete an attempt.
func (controller *Controller) RecordFailure(ctx context.Context, owner string, revision int64, code, evidenceSHA256 string) (Record, error) {
	if err := controller.checkContext(ctx); err != nil {
		return Record{}, err
	}
	current, err := controller.store.Load(ctx, controller.key())
	if err != nil {
		return Record{}, err
	}
	if err := controller.validateRecord(current); err != nil {
		return Record{}, err
	}
	if current.Binding.Owner != owner || current.Revision != revision {
		return Record{}, ErrConflict
	}
	if current.Result != "pending" || revision >= maxSafeInteger || !validFailureCode(code) || !sha256Pattern.MatchString(evidenceSHA256) {
		return Record{}, errors.New("failure transition is invalid")
	}
	now := controller.clock().UTC().Truncate(time.Second)
	updated, _ := canonicalTime(current.UpdatedAt)
	if now.Before(updated) {
		return Record{}, errors.New("publication failure clock moved backwards")
	}
	next := current
	next.Revision++
	next.Result, next.FailureCode, next.ResumeDisposition = "failed", code, "reconciliation-required"
	next.EvidenceSHA256, next.UpdatedAt = evidenceSHA256, now.Format(time.RFC3339)
	next.OperationAuthorization = signingbroker.PublicationAuthorization{}
	return controller.commit(ctx, revision, next)
}

func isIntent(phase Phase) bool {
	return phase == ParentStarted || phase == UploadStarted || phase == DeployStarted || phase == RouteStarted
}

func validateFreshAuthorization(original, fresh signingbroker.PublicationAuthorization, now time.Time) error {
	issued, err := canonicalTime(fresh.AuthorizedAt)
	if err != nil || issued.After(now) || now.Sub(issued) > time.Minute {
		return errors.New("effect authorization is not freshly obtained")
	}
	expires, err := canonicalTime(fresh.ExpiresAt)
	if err != nil || expires.Sub(issued) != 5*time.Minute {
		return errors.New("effect authorization lifetime is invalid")
	}
	fresh.AuthorizedAt, fresh.ExpiresAt = original.AuthorizedAt, original.ExpiresAt
	if fresh != original {
		return errors.New("effect authorization changed the exact publication binding")
	}
	return nil
}

func validFailureCode(code string) bool {
	switch code {
	case "validation-failed", "external-outcome-unknown", "canary-timeout", "canceled", "storage-failed":
		return true
	}
	return false
}

func validateConfirmation(auth signingbroker.PublicationAuthorization, confirmation signingbroker.PublicationConfirmation) error {
	if confirmation.SchemaVersion != "1.0.0" || confirmation.Environment != auth.Environment ||
		confirmation.RepositoryID != auth.RepositoryID || confirmation.StateID != auth.StateID ||
		confirmation.BootstrapRootSHA256 != auth.BootstrapRootSHA256 || confirmation.ReleaseID != auth.ReleaseID ||
		confirmation.PriorStateRevision != auth.StateRevision || confirmation.StateRevision <= auth.StateRevision ||
		confirmation.StateRevision > maxSafeInteger || confirmation.Published != auth.Candidate {
		return errors.New("confirmation differs from the exact publication attempt")
	}
	_, err := canonicalTime(confirmation.ConfirmedAt)
	return err
}

func canonicalTime(value string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil || parsed.UTC().Format(time.RFC3339) != value {
		return time.Time{}, fmt.Errorf("publication journal time is not canonical UTC")
	}
	return parsed, nil
}
