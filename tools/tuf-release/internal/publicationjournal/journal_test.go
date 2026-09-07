package publicationjournal

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/signingbroker"
)

type memoryStore struct {
	mu               sync.Mutex
	record           *Record
	history          []Record
	failBeforeCommit bool
	failAfterCommit  bool
	afterCommit      func()
}

func (store *memoryStore) Load(_ context.Context, key string) (Record, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if key != "hid-staging-publication-v1" {
		return Record{}, errors.New("wrong coordination key")
	}
	if store.record == nil {
		return Record{}, ErrNotFound
	}
	return *store.record, nil
}

func (store *memoryStore) CompareAndSwap(_ context.Context, key string, expected int64, next Record) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.failBeforeCommit {
		return errors.New("simulated durable write failure")
	}
	if key != "hid-staging-publication-v1" || store.record == nil && expected != 0 ||
		store.record != nil && store.record.Revision != expected {
		return ErrConflict
	}
	store.record = &next
	store.history = append(store.history, next)
	if store.afterCommit != nil {
		store.afterCommit()
	}
	if store.failAfterCommit {
		return errors.New("simulated lost commit response")
	}
	return nil
}

func fixture(t *testing.T) (*Controller, *memoryStore, Binding, *time.Time) {
	t.Helper()
	now := time.Date(2026, 9, 5, 12, 0, 0, 0, time.UTC)
	config := Config{Environment: "staging", RepositoryID: "hid-staging-v1", StateID: "hid-staging-broker-v1", BootstrapRootSHA256: strings.Repeat("a", 64),
		GitHubRepository: "D-Eminence/hid-system", WorkflowRef: "D-Eminence/hid-system/.github/workflows/tuf-publish.yml@" + strings.Repeat("c", 40)}
	store := &memoryStore{}
	controller, err := New(config, store, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	role := signingbroker.PublicationRole{Version: 1, SHA256: config.BootstrapRootSHA256}
	binding := Binding{Owner: "123:1", RepositorySHA256: strings.Repeat("b", 64), WorkflowSHA256: strings.Repeat("c", 64),
		ConfigSHA256: strings.Repeat("d", 64), ExecutableSHA256: strings.Repeat("e", 64),
		GitSHA: strings.Repeat("a", 40), ArtifactIdentity: "environments/staging/releases/r0000000001-g" + strings.Repeat("a", 40) + "/release-bundle.json",
		ArtifactSHA256: strings.Repeat("f", 64), ArtifactSetSHA256: strings.Repeat("e", 64),
		GitHubRepository: config.GitHubRepository, WorkflowRef: config.WorkflowRef, ActorID: "12345",
		Authorization: signingbroker.PublicationAuthorization{SchemaVersion: "1.0.0", Environment: config.Environment, RepositoryID: config.RepositoryID,
			StateID: config.StateID, BootstrapRootSHA256: config.BootstrapRootSHA256, ReleaseID: "r0000000001-g" + strings.Repeat("a", 40),
			AuthorizedAt: now.Format(time.RFC3339), ExpiresAt: now.Add(5 * time.Minute).Format(time.RFC3339),
			Candidate: signingbroker.PublicationMetadata{Root: role, Targets: role, Snapshot: role, Timestamp: role}}}
	return controller, store, binding, &now
}

func advance(t *testing.T, controller *Controller, current Record, phases ...Phase) Record {
	t.Helper()
	for _, phase := range phases {
		var err error
		current, err = controller.Advance(context.Background(), current.Binding.Owner, current.Revision, phase, strings.Repeat("f", 64), current.Binding.Authorization)
		if err != nil {
			t.Fatalf("advance to %s: %v", phase, err)
		}
	}
	return current
}

func confirmation(binding Binding, now time.Time) signingbroker.PublicationConfirmation {
	auth := binding.Authorization
	return signingbroker.PublicationConfirmation{SchemaVersion: "1.0.0", Environment: auth.Environment, RepositoryID: auth.RepositoryID,
		StateID: auth.StateID, BootstrapRootSHA256: auth.BootstrapRootSHA256, PriorStateRevision: auth.StateRevision,
		StateRevision: auth.StateRevision + 1, ReleaseID: auth.ReleaseID, ConfirmedAt: now.Format(time.RFC3339), Published: auth.Candidate}
}

func TestCompleteOrderedPublicationAndPinnedSuccessor(t *testing.T) {
	controller, store, binding, now := fixture(t)
	current, err := controller.Begin(context.Background(), binding)
	if err != nil {
		t.Fatal(err)
	}
	current = advance(t, controller, current, ArchiveVerified, ParentStarted, ParentCreated, UploadStarted, Uploaded, PreviewVerified, DeployStarted, Deployed, RouteStarted, RouteActivated)
	completed, err := controller.Confirm(context.Background(), binding.Owner, current.Revision, confirmation(binding, *now), strings.Repeat("f", 64))
	if err != nil {
		t.Fatal(err)
	}
	if completed.Phase != Confirmed || len(store.history) != 12 || completed.Revision != 12 {
		t.Fatal("missing ordered publication history")
	}
	next := binding
	next.Owner = "124:1"
	next.PreviousRepositorySHA256 = binding.RepositorySHA256
	next.RepositorySHA256 = strings.Repeat("c", 64)
	next.Authorization.StateRevision = completed.Confirmation.StateRevision + 2
	next.Authorization.Current = binding.Authorization.Candidate
	next.Authorization.Candidate.Snapshot.Version++
	next.Authorization.Candidate.Timestamp.Version++
	for _, mutation := range []string{"owner", "predecessor", "current-metadata", "prior-state"} {
		changed := next
		switch mutation {
		case "owner":
			changed.Owner = binding.Owner
		case "predecessor":
			changed.PreviousRepositorySHA256 = strings.Repeat("d", 64)
		case "current-metadata":
			changed.Authorization.Current.Timestamp.SHA256 = strings.Repeat("d", 64)
		case "prior-state":
			changed.Authorization.StateRevision = 0
		}
		if _, err := controller.Begin(context.Background(), changed); err == nil {
			t.Fatalf("accepted changed %s", mutation)
		}
	}
	nextRecord, err := controller.Begin(context.Background(), next)
	if err != nil {
		t.Fatal(err)
	}
	if len(store.history) != 13 {
		t.Fatal("failed claims changed the journal")
	}
	nextRecord = advance(t, controller, nextRecord, ArchiveVerified)
	if _, err := controller.Advance(context.Background(), next.Owner, nextRecord.Revision, ParentStarted, strings.Repeat("f", 64)); err == nil {
		t.Fatal("non-bootstrap attempt created a parent Worker")
	}
}

func TestEveryInterruptedPhaseBlocksNewAttemptAndCannotReplayIntent(t *testing.T) {
	phases := []Phase{Claimed, ArchiveVerified, ParentStarted, ParentCreated, UploadStarted, Uploaded, PreviewVerified, DeployStarted, Deployed, RouteStarted, RouteActivated}
	for index, phase := range phases {
		t.Run(string(phase), func(t *testing.T) {
			controller, store, binding, now := fixture(t)
			current, err := controller.Begin(context.Background(), binding)
			if err != nil {
				t.Fatal(err)
			}
			current = advance(t, controller, current, phases[1:index+1]...)
			*now = now.Add(365 * 24 * time.Hour)
			binding.Authorization.AuthorizedAt = now.Format(time.RFC3339)
			binding.Authorization.ExpiresAt = now.Add(5 * time.Minute).Format(time.RFC3339)
			restarted, err := New(controller.config, store, controller.clock)
			if err != nil {
				t.Fatal(err)
			}
			for _, owner := range []string{binding.Owner, "125:1"} {
				binding.Owner = owner
				if _, err := restarted.Begin(context.Background(), binding); !errors.Is(err, ErrUnresolved) {
					t.Fatalf("unresolved claim expired or resumed: %v", err)
				}
			}
			if _, err := restarted.Advance(context.Background(), current.Binding.Owner, current.Revision, phase, strings.Repeat("f", 64)); err == nil {
				t.Fatal("replayed an existing phase")
			}
			if len(store.history) != index+1 {
				t.Fatal("failed restart changed journal")
			}
		})
	}
}

func TestConcurrentClaimsAndIntentCASPermitOnlyOneEffect(t *testing.T) {
	controller, store, binding, _ := fixture(t)
	var group sync.WaitGroup
	var successes int
	var mu sync.Mutex
	for index := 0; index < 32; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			if _, err := controller.Begin(context.Background(), binding); err == nil {
				mu.Lock()
				successes++
				mu.Unlock()
			}
		}()
	}
	group.Wait()
	if successes != 1 {
		t.Fatalf("concurrent successful claims: %d", successes)
	}
	current := advance(t, controller, *store.record, ArchiveVerified)
	successes = 0
	for index := 0; index < 32; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			if _, err := controller.Advance(context.Background(), binding.Owner, current.Revision, UploadStarted, strings.Repeat("f", 64), binding.Authorization); err == nil {
				mu.Lock()
				successes++
				mu.Unlock() // simulated effect only after successful intent CAS
			}
		}()
	}
	group.Wait()
	if successes != 1 || len(store.history) != 3 {
		t.Fatal("concurrent intent allowed duplicate effects")
	}
}

func TestStoreFailuresNeverPermitEffectOrLoseUnresolvedMarker(t *testing.T) {
	for _, committed := range []bool{false, true} {
		controller, store, binding, _ := fixture(t)
		current, err := controller.Begin(context.Background(), binding)
		if err != nil {
			t.Fatal(err)
		}
		current = advance(t, controller, current, ArchiveVerified)
		store.failBeforeCommit, store.failAfterCommit = !committed, committed
		if _, err := controller.Advance(context.Background(), binding.Owner, current.Revision, UploadStarted, strings.Repeat("f", 64), binding.Authorization); err == nil {
			t.Fatal("ambiguous write authorized an effect")
		}
		store.failBeforeCommit, store.failAfterCommit = false, false
		if _, err := controller.Begin(context.Background(), binding); !errors.Is(err, ErrUnresolved) {
			t.Fatal("failed transition lost the unresolved marker")
		}
	}
}

func TestConfirmationRequiresExactFreshObservedPublishedState(t *testing.T) {
	controller, store, binding, now := fixture(t)
	current, err := controller.Begin(context.Background(), binding)
	if err != nil {
		t.Fatal(err)
	}
	valid := confirmation(binding, *now)
	if _, err := controller.Confirm(context.Background(), binding.Owner, current.Revision, valid, strings.Repeat("f", 64)); err == nil {
		t.Fatal("confirmed before deployment")
	}
	current = advance(t, controller, current, ArchiveVerified, UploadStarted, Uploaded, PreviewVerified, DeployStarted, Deployed)
	for _, scenario := range []string{"owner", "revision", "root", "release", "prior", "not-advanced", "future", "stale", "evidence"} {
		changed, owner, revision, evidence := valid, binding.Owner, current.Revision, strings.Repeat("f", 64)
		switch scenario {
		case "owner":
			owner = "777:1"
		case "revision":
			revision--
		case "root":
			changed.Published.Root.SHA256 = strings.Repeat("e", 64)
		case "release":
			changed.ReleaseID = "r0000000002-g" + strings.Repeat("a", 40)
		case "prior":
			changed.PriorStateRevision++
		case "not-advanced":
			changed.StateRevision = 0
		case "future":
			changed.ConfirmedAt = now.Add(time.Second).Format(time.RFC3339)
		case "stale":
			changed.ConfirmedAt = now.Add(-61 * time.Second).Format(time.RFC3339)
		case "evidence":
			evidence = "invalid"
		}
		if _, err := controller.Confirm(context.Background(), owner, revision, changed, evidence); err == nil {
			t.Fatalf("accepted %s confirmation", scenario)
		}
	}
	if len(store.history) != 7 {
		t.Fatal("failed confirmation changed journal")
	}
	if _, err := controller.Confirm(context.Background(), binding.Owner, current.Revision, valid, strings.Repeat("f", 64)); err != nil {
		t.Fatal(err)
	}
}

func TestInvalidRecordsBindingsClocksAndCancellationFailClosed(t *testing.T) {
	for _, scenario := range []string{"existing-zero", "owner", "environment", "bootstrap-role", "bootstrap-current", "hash", "old-auth", "future-auth", "lifetime"} {
		controller, store, binding, now := fixture(t)
		switch scenario {
		case "existing-zero":
			store.record = &Record{}
		case "owner":
			binding.Owner = "../owner"
		case "environment":
			binding.Authorization.Environment = "production"
		case "bootstrap-role":
			binding.Authorization.Candidate = signingbroker.PublicationMetadata{}
		case "bootstrap-current":
			binding.Authorization.Current = binding.Authorization.Candidate
		case "hash":
			binding.ConfigSHA256 = "bad"
		case "old-auth":
			*now = now.Add(61 * time.Second)
		case "future-auth":
			*now = now.Add(-time.Second)
		case "lifetime":
			binding.Authorization.ExpiresAt = now.Add(time.Hour).Format(time.RFC3339)
		}
		if _, err := controller.Begin(context.Background(), binding); err == nil {
			t.Fatalf("accepted %s", scenario)
		}
		if len(store.history) != 0 {
			t.Fatal("invalid binding mutated store")
		}
	}
	controller, store, binding, now := fixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := controller.Begin(ctx, binding); !errors.Is(err, context.Canceled) {
		t.Fatal("ignored cancellation")
	}
	current, err := controller.Begin(context.Background(), binding)
	if err != nil {
		t.Fatal(err)
	}
	*now = now.Add(-time.Second)
	if _, err := controller.Advance(context.Background(), binding.Owner, current.Revision, ArchiveVerified, strings.Repeat("f", 64)); err == nil {
		t.Fatal("ignored clock rollback")
	}
	store.record.Phase = "unknown"
	*now = now.Add(time.Second)
	if _, err := controller.Begin(context.Background(), binding); err == nil {
		t.Fatal("accepted malformed stored phase")
	}
	var missing *memoryStore
	if _, err := New(controller.config, missing, controller.clock); err == nil {
		t.Fatal("accepted typed nil store")
	}
}

func TestCancellationAfterCommittedClaimLeavesUnresolvedAttempt(t *testing.T) {
	controller, store, binding, _ := fixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	store.afterCommit = cancel
	if _, err := controller.Begin(ctx, binding); !errors.Is(err, context.Canceled) {
		t.Fatalf("committed canceled claim was returned as success: %v", err)
	}
	store.afterCommit = nil
	if _, err := controller.Begin(context.Background(), binding); !errors.Is(err, ErrUnresolved) {
		t.Fatal("cancellation removed the durable unresolved claim")
	}
}
