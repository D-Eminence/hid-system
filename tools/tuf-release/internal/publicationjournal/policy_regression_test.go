package publicationjournal

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/signingbroker"
)

func TestExplicitPublicationIdentityBindingsFailClosed(t *testing.T) {
	mutations := map[string]func(*Binding){
		"missing-git-sha":           func(binding *Binding) { binding.GitSHA = "" },
		"abbreviated-git-sha":       func(binding *Binding) { binding.GitSHA = strings.Repeat("a", 7) },
		"uppercase-git-sha":         func(binding *Binding) { binding.GitSHA = strings.Repeat("A", 40) },
		"different-release-git-sha": func(binding *Binding) { binding.GitSHA = strings.Repeat("b", 40) },
		"missing-artifact-identity": func(binding *Binding) { binding.ArtifactIdentity = "" },
		"artifact-cross-environment": func(binding *Binding) {
			binding.ArtifactIdentity = strings.Replace(binding.ArtifactIdentity, "/staging/", "/production/", 1)
		},
		"artifact-cross-release": func(binding *Binding) {
			binding.ArtifactIdentity = strings.Replace(binding.ArtifactIdentity, "r0000000001", "r0000000002", 1)
		},
		"artifact-cross-git-sha": func(binding *Binding) {
			binding.ArtifactIdentity = strings.Replace(binding.ArtifactIdentity, strings.Repeat("a", 40), strings.Repeat("b", 40), 1)
		},
		"artifact-traversal": func(binding *Binding) { binding.ArtifactIdentity = "../" + binding.ArtifactIdentity },
		"artifact-other-file": func(binding *Binding) {
			binding.ArtifactIdentity = strings.Replace(binding.ArtifactIdentity, "release-bundle.json", "other.json", 1)
		},
		"missing-artifact-digest":     func(binding *Binding) { binding.ArtifactSHA256 = "" },
		"short-artifact-digest":       func(binding *Binding) { binding.ArtifactSHA256 = strings.Repeat("f", 63) },
		"uppercase-artifact-digest":   func(binding *Binding) { binding.ArtifactSHA256 = strings.Repeat("F", 64) },
		"missing-artifact-set-digest": func(binding *Binding) { binding.ArtifactSetSHA256 = "" },
		"invalid-artifact-set-digest": func(binding *Binding) { binding.ArtifactSetSHA256 = strings.Repeat("z", 64) },
		"missing-github-repository":   func(binding *Binding) { binding.GitHubRepository = "" },
		"cross-github-repository":     func(binding *Binding) { binding.GitHubRepository = "another-owner/hid-system" },
		"missing-workflow-ref":        func(binding *Binding) { binding.WorkflowRef = "" },
		"mutable-workflow-ref": func(binding *Binding) {
			binding.WorkflowRef = strings.Split(binding.WorkflowRef, "@")[0] + "@refs/heads/main"
		},
		"other-workflow-file": func(binding *Binding) {
			binding.WorkflowRef = strings.Replace(binding.WorkflowRef, "tuf-publish.yml", "developer.yml", 1)
		},
		"unapproved-workflow-commit": func(binding *Binding) {
			binding.WorkflowRef = strings.Split(binding.WorkflowRef, "@")[0] + "@" + strings.Repeat("d", 40)
		},
		"missing-actor-id":      func(binding *Binding) { binding.ActorID = "" },
		"actor-name-not-id":     func(binding *Binding) { binding.ActorID = "release-admin" },
		"zero-actor-id":         func(binding *Binding) { binding.ActorID = "0" },
		"noncanonical-actor-id": func(binding *Binding) { binding.ActorID = "012345" },
		"oversize-actor-id":     func(binding *Binding) { binding.ActorID = strings.Repeat("1", 21) },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			controller, store, binding, _ := fixture(t)
			mutate(&binding)
			if _, err := controller.Begin(context.Background(), binding); err == nil {
				t.Fatal("accepted invalid publication identity")
			}
			if store.record != nil || len(store.history) != 0 {
				t.Fatal("invalid identity left a claim or journal history")
			}
		})
	}
}

func TestEveryExternalIntentRequiresFreshExactAuthorization(t *testing.T) {
	prerequisites := map[Phase][]Phase{
		ParentStarted: {ArchiveVerified},
		UploadStarted: {ArchiveVerified},
		DeployStarted: {ArchiveVerified, UploadStarted, Uploaded, PreviewVerified},
		RouteStarted:  {ArchiveVerified, UploadStarted, Uploaded, PreviewVerified, DeployStarted, Deployed},
	}
	for phase, before := range prerequisites {
		t.Run(string(phase), func(t *testing.T) {
			controller, store, binding, now := fixture(t)
			current, err := controller.Begin(context.Background(), binding)
			if err != nil {
				t.Fatal(err)
			}
			current = advance(t, controller, current, before...)
			*now = now.Add(2 * time.Minute)
			fresh := binding.Authorization
			fresh.AuthorizedAt = now.Format(time.RFC3339)
			fresh.ExpiresAt = now.Add(5 * time.Minute).Format(time.RFC3339)
			for _, scenario := range []string{"missing", "duplicate", "original-stale", "future", "too-old", "lifetime", "environment", "repository", "state-id", "state-revision", "root-pin", "release", "candidate-version", "candidate-hash", "current-metadata"} {
				t.Run(scenario, func(t *testing.T) {
					changed := fresh
					args := []signingbroker.PublicationAuthorization{changed}
					switch scenario {
					case "missing":
						args = nil
					case "duplicate":
						args = append(args, changed)
					case "original-stale":
						changed = binding.Authorization
					case "future":
						changed.AuthorizedAt = now.Add(time.Second).Format(time.RFC3339)
						changed.ExpiresAt = now.Add(5*time.Minute + time.Second).Format(time.RFC3339)
					case "too-old":
						changed.AuthorizedAt = now.Add(-61 * time.Second).Format(time.RFC3339)
						changed.ExpiresAt = now.Add(5*time.Minute - 61*time.Second).Format(time.RFC3339)
					case "lifetime":
						changed.ExpiresAt = now.Add(6 * time.Minute).Format(time.RFC3339)
					case "environment":
						changed.Environment = "production"
					case "repository":
						changed.RepositoryID = "other-repository"
					case "state-id":
						changed.StateID = "other-state"
					case "state-revision":
						changed.StateRevision++
					case "root-pin":
						changed.BootstrapRootSHA256 = strings.Repeat("b", 64)
					case "release":
						changed.ReleaseID = "r0000000002-g" + binding.GitSHA
					case "candidate-version":
						changed.Candidate.Timestamp.Version++
					case "candidate-hash":
						changed.Candidate.Targets.SHA256 = strings.Repeat("d", 64)
					case "current-metadata":
						changed.Current = binding.Authorization.Candidate
					}
					if len(args) == 1 {
						args[0] = changed
					}
					if _, err := controller.Advance(context.Background(), binding.Owner, current.Revision, phase, strings.Repeat("f", 64), args...); err == nil {
						t.Fatal("effect intent accepted missing, stale or changed authorization")
					}
					if *store.record != current || len(store.history) != int(current.Revision) {
						t.Fatal("invalid intent changed the durable record")
					}
				})
			}
			next, err := controller.Advance(context.Background(), binding.Owner, current.Revision, phase, strings.Repeat("f", 64), fresh)
			if err != nil {
				t.Fatalf("fresh authorization with unchanged publication identity failed: %v", err)
			}
			if next.OperationAuthorization != fresh || next.Binding != binding || next.UpdatedAt != now.Format(time.RFC3339) {
				t.Fatal("intent failed to retain fresh evidence and immutable claim binding")
			}
			if err := ValidateTransition(controller.config, &current, next); err != nil {
				t.Fatalf("valid fresh intent cannot be replay-validated: %v", err)
			}
		})
	}
}

func TestStaleAttemptCannotContinueEvenWithFreshAuthorizationOrConfirmation(t *testing.T) {
	for _, phase := range []Phase{Claimed, ArchiveVerified, UploadStarted, Deployed} {
		t.Run(string(phase), func(t *testing.T) {
			controller, store, binding, now := fixture(t)
			current, err := controller.Begin(context.Background(), binding)
			if err != nil {
				t.Fatal(err)
			}
			if phase != Claimed {
				current = advance(t, controller, current, ArchiveVerified)
			}
			if phase == UploadStarted || phase == Deployed {
				current = advance(t, controller, current, UploadStarted)
			}
			if phase == Deployed {
				current = advance(t, controller, current, Uploaded, PreviewVerified, DeployStarted, Deployed)
			}
			*now = now.Add(30*time.Minute + time.Second)
			fresh := binding.Authorization
			fresh.AuthorizedAt = now.Format(time.RFC3339)
			fresh.ExpiresAt = now.Add(5 * time.Minute).Format(time.RFC3339)
			next := map[Phase]Phase{Claimed: ArchiveVerified, ArchiveVerified: UploadStarted, UploadStarted: Uploaded, Deployed: RouteStarted}[phase]
			if _, err := controller.Advance(context.Background(), binding.Owner, current.Revision, next, strings.Repeat("f", 64), fresh); err == nil {
				t.Fatal("stale attempt continued")
			}
			if phase == Deployed {
				if _, err := controller.Confirm(context.Background(), binding.Owner, current.Revision, confirmation(binding, *now), strings.Repeat("f", 64)); err == nil {
					t.Fatal("stale attempt completed using fresh confirmation")
				}
			}
			if *store.record != current || len(store.history) != int(current.Revision) {
				t.Fatal("stale continuation changed the journal")
			}
			failed, err := controller.RecordFailure(context.Background(), binding.Owner, current.Revision, "canary-timeout", strings.Repeat("f", 64))
			if err != nil {
				t.Fatalf("stale attempt cannot retain its failure: %v", err)
			}
			if failed.Result != "failed" || failed.ResumeDisposition != "reconciliation-required" {
				t.Fatal("stale failure lost the reconciliation requirement")
			}
			if err := ValidateTransition(controller.config, &current, failed); err != nil {
				t.Fatalf("historical stale failure rejected: %v", err)
			}
		})
	}
}

func TestFailureRecordsCloseEveryUnresolvedPhaseWithoutAuthorizingRetry(t *testing.T) {
	phases := []Phase{Claimed, ArchiveVerified, ParentStarted, ParentCreated, UploadStarted, Uploaded, PreviewVerified, DeployStarted, Deployed, RouteStarted, RouteActivated}
	for index, phase := range phases {
		t.Run(string(phase), func(t *testing.T) {
			controller, store, binding, now := fixture(t)
			current, err := controller.Begin(context.Background(), binding)
			if err != nil {
				t.Fatal(err)
			}
			current = advance(t, controller, current, phases[1:index+1]...)
			*now = now.Add(time.Second)
			failed, err := controller.RecordFailure(context.Background(), binding.Owner, current.Revision, "external-outcome-unknown", strings.Repeat("d", 64))
			if err != nil {
				t.Fatal(err)
			}
			if failed.Phase != phase || failed.Binding != binding || failed.ClaimedAt != current.ClaimedAt || failed.Revision != current.Revision+1 ||
				failed.Result != "failed" || failed.ResumeDisposition != "reconciliation-required" || failed.FailureCode != "external-outcome-unknown" ||
				failed.OperationAuthorization != (signingbroker.PublicationAuthorization{}) || failed.Confirmation != (signingbroker.PublicationConfirmation{}) {
				t.Fatal("failure changed identity, phase or closure semantics")
			}
			if err := ValidateTransition(controller.config, &current, failed); err != nil {
				t.Fatalf("valid failure transition rejected: %v", err)
			}
			if _, err := controller.RecordFailure(context.Background(), binding.Owner, failed.Revision, "canceled", strings.Repeat("f", 64)); err == nil {
				t.Fatal("failed record accepted another mutation")
			}
			if _, err := controller.Advance(context.Background(), binding.Owner, failed.Revision, ArchiveVerified, strings.Repeat("f", 64), binding.Authorization); err == nil {
				t.Fatal("failed record resumed")
			}
			if _, err := controller.Confirm(context.Background(), binding.Owner, failed.Revision, confirmation(binding, *now), strings.Repeat("f", 64)); err == nil {
				t.Fatal("failed record completed")
			}
			for _, owner := range []string{binding.Owner, "124:1"} {
				retry := binding
				retry.Owner = owner
				if _, err := controller.Begin(context.Background(), retry); !errors.Is(err, ErrUnresolved) {
					t.Fatalf("failed attempt allowed takeover or retry: %v", err)
				}
			}
			if *store.record != failed || len(store.history) != int(failed.Revision) {
				t.Fatal("closed failure record changed")
			}
		})
	}
}

func TestFailureCodesAreBoundedAndInvalidFailureInputsNeverCommit(t *testing.T) {
	for _, code := range []string{"validation-failed", "external-outcome-unknown", "canary-timeout", "canceled", "storage-failed"} {
		t.Run(code, func(t *testing.T) {
			controller, _, binding, _ := fixture(t)
			current, err := controller.Begin(context.Background(), binding)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := controller.RecordFailure(context.Background(), binding.Owner, current.Revision, code, strings.Repeat("f", 64)); err != nil {
				t.Fatalf("bounded failure code rejected: %v", err)
			}
		})
	}
	for _, scenario := range []string{"empty-code", "raw-error", "owner", "revision", "evidence", "clock-rollback", "canceled"} {
		t.Run(scenario, func(t *testing.T) {
			controller, store, binding, now := fixture(t)
			current, err := controller.Begin(context.Background(), binding)
			if err != nil {
				t.Fatal(err)
			}
			owner, revision, code, evidence := binding.Owner, current.Revision, "storage-failed", strings.Repeat("f", 64)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch scenario {
			case "empty-code":
				code = ""
			case "raw-error":
				code = "request failed: Authorization: Bearer example-sensitive-token"
			case "owner":
				owner = "999:1"
			case "revision":
				revision++
			case "evidence":
				evidence = "raw-possibly-sensitive-error"
			case "clock-rollback":
				*now = now.Add(-time.Second)
			case "canceled":
				cancel()
			}
			if _, err := controller.RecordFailure(ctx, owner, revision, code, evidence); err == nil {
				t.Fatal("invalid failure input accepted")
			}
			if *store.record != current || len(store.history) != 1 {
				t.Fatal("invalid failure mutated the store")
			}
		})
	}
}

func TestValidateTransitionRejectsImmutableBindingsAndResultMutations(t *testing.T) {
	controller, store, binding, now := fixture(t)
	current, err := controller.Begin(context.Background(), binding)
	if err != nil {
		t.Fatal(err)
	}
	current = advance(t, controller, current, ArchiveVerified, UploadStarted, Uploaded, PreviewVerified, DeployStarted, Deployed)
	if _, err := controller.Confirm(context.Background(), binding.Owner, current.Revision, confirmation(binding, *now), strings.Repeat("f", 64)); err != nil {
		t.Fatal(err)
	}
	for index, record := range store.history {
		var previous *Record
		if index > 0 {
			previous = &store.history[index-1]
		}
		if err := ValidateTransition(controller.config, previous, record); err != nil {
			t.Fatalf("valid history revision %d rejected: %v", record.Revision, err)
		}
	}
	previous, next := store.history[2], store.history[3] // upload intent -> receipt, structurally valid mutable evidence
	mutations := map[string]func(*Record){
		"owner":          func(record *Record) { record.Binding.Owner = "124:1" },
		"actor":          func(record *Record) { record.Binding.ActorID = "67890" },
		"artifact-hash":  func(record *Record) { record.Binding.ArtifactSHA256 = strings.Repeat("a", 64) },
		"artifact-set":   func(record *Record) { record.Binding.ArtifactSetSHA256 = strings.Repeat("a", 64) },
		"repository":     func(record *Record) { record.Binding.RepositorySHA256 = strings.Repeat("a", 64) },
		"workflow-bytes": func(record *Record) { record.Binding.WorkflowSHA256 = strings.Repeat("a", 64) },
		"config-bytes":   func(record *Record) { record.Binding.ConfigSHA256 = strings.Repeat("a", 64) },
		"executable":     func(record *Record) { record.Binding.ExecutableSHA256 = strings.Repeat("a", 64) },
		"git-and-artifact": func(record *Record) {
			record.Binding.GitSHA = strings.Repeat("b", 40)
			record.Binding.Authorization.ReleaseID = "r0000000001-g" + record.Binding.GitSHA
			record.Binding.ArtifactIdentity = "environments/staging/releases/" + record.Binding.Authorization.ReleaseID + "/release-bundle.json"
		},
		"candidate-metadata": func(record *Record) {
			record.Binding.Authorization.Candidate.Timestamp.SHA256 = strings.Repeat("b", 64)
		},
		"revision-gap":       func(record *Record) { record.Revision++ },
		"result":             func(record *Record) { record.Result = "completed" },
		"resume-disposition": func(record *Record) { record.ResumeDisposition = "new-attempt-only" },
		"failure-on-pending": func(record *Record) { record.FailureCode = "storage-failed" },
		"phase-skip":         func(record *Record) { record.Phase = PreviewVerified },
		"spurious-op-auth":   func(record *Record) { record.OperationAuthorization = binding.Authorization },
		"spurious-confirm":   func(record *Record) { record.Confirmation = confirmation(binding, *now) },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			changed := next
			mutate(&changed)
			if err := ValidateTransition(controller.config, &previous, changed); err == nil {
				t.Fatal("accepted altered immutable binding or recorded transition")
			}
		})
	}
	if err := ValidateTransition(controller.config, nil, next); err == nil {
		t.Fatal("accepted a truncated non-genesis record as journal genesis")
	}
	if err := ValidateTransition(controller.config, &previous, previous); err == nil {
		t.Fatal("accepted a replayed intent as its own successor")
	}
}

func TestHistoricalWorkflowPinsPermitAuditButNeverLiveContinuation(t *testing.T) {
	controller, store, binding, now := fixture(t)
	current, err := controller.Begin(context.Background(), binding)
	if err != nil {
		t.Fatal(err)
	}
	current = advance(t, controller, current, ArchiveVerified, UploadStarted)
	rotated := controller.config
	rotated.WorkflowRef = strings.Split(binding.WorkflowRef, "@")[0] + "@" + strings.Repeat("d", 40)
	rotated.HistoricalWorkflowRefs = []string{binding.WorkflowRef}
	replacement, err := New(rotated, store, controller.clock)
	if err != nil {
		t.Fatal(err)
	}
	for index, record := range store.history {
		var previous *Record
		if index > 0 {
			previous = &store.history[index-1]
		}
		if err := ValidateRecord(rotated, record); err != nil {
			t.Fatalf("approved historical record rejected after workflow rotation: %v", err)
		}
		if err := ValidateTransition(rotated, previous, record); err != nil {
			t.Fatalf("approved historical transition rejected after workflow rotation: %v", err)
		}
	}
	if _, err := replacement.Advance(context.Background(), binding.Owner, current.Revision, Uploaded, strings.Repeat("f", 64)); err == nil {
		t.Fatal("replaced workflow was allowed to continue")
	}
	if _, err := replacement.Confirm(context.Background(), binding.Owner, current.Revision, confirmation(binding, *now), strings.Repeat("f", 64)); err == nil {
		t.Fatal("replaced workflow was allowed to confirm")
	}
	freshStore := &memoryStore{}
	newController, err := New(rotated, freshStore, controller.clock)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := newController.Begin(context.Background(), binding); err == nil {
		t.Fatal("historical pin was allowed to create a new claim")
	}
	if freshStore.record != nil || len(freshStore.history) != 0 {
		t.Fatal("historical live claim changed an empty store")
	}
	unknown := rotated
	unknown.HistoricalWorkflowRefs = nil
	if err := ValidateRecord(unknown, current); err == nil {
		t.Fatal("unknown historical pin was accepted by record validation")
	}
	if err := ValidateTransition(unknown, &store.history[1], current); err == nil {
		t.Fatal("unknown historical pin was accepted by transition validation")
	}
	failed, err := replacement.RecordFailure(context.Background(), binding.Owner, current.Revision, "canceled", strings.Repeat("e", 64))
	if err != nil {
		t.Fatalf("replaced workflow's pending attempt cannot retain failure evidence: %v", err)
	}
	if err := ValidateTransition(rotated, &current, failed); err != nil {
		t.Fatalf("historical failure transition rejected: %v", err)
	}
	if failed.Result != "failed" || failed.ResumeDisposition != "reconciliation-required" || failed.Binding != binding {
		t.Fatal("historical failure changed binding or failed to freeze the attempt")
	}
}

func TestWorkflowRotationPreservesConfirmedPredecessorForNewActiveClaim(t *testing.T) {
	controller, store, binding, now := fixture(t)
	current, err := controller.Begin(context.Background(), binding)
	if err != nil {
		t.Fatal(err)
	}
	current = advance(t, controller, current, ArchiveVerified, UploadStarted, Uploaded, PreviewVerified, DeployStarted, Deployed)
	completed, err := controller.Confirm(context.Background(), binding.Owner, current.Revision, confirmation(binding, *now), strings.Repeat("f", 64))
	if err != nil {
		t.Fatal(err)
	}
	rotated := controller.config
	rotated.WorkflowRef = strings.Split(binding.WorkflowRef, "@")[0] + "@" + strings.Repeat("d", 40)
	rotated.HistoricalWorkflowRefs = []string{binding.WorkflowRef}
	replacement, err := New(rotated, store, controller.clock)
	if err != nil {
		t.Fatal(err)
	}
	next := binding
	next.Owner = "124:1"
	next.WorkflowRef = rotated.WorkflowRef
	next.WorkflowSHA256 = strings.Repeat("d", 64)
	next.PreviousRepositorySHA256 = binding.RepositorySHA256
	next.RepositorySHA256 = strings.Repeat("c", 64)
	next.Authorization.StateRevision = completed.Confirmation.StateRevision
	next.Authorization.Current = binding.Authorization.Candidate
	next.Authorization.Candidate.Snapshot.Version++
	next.Authorization.Candidate.Timestamp.Version++
	claimed, err := replacement.Begin(context.Background(), next)
	if err != nil {
		t.Fatalf("new workflow cannot follow approved historical completion: %v", err)
	}
	if err := ValidateTransition(rotated, &completed, claimed); err != nil {
		t.Fatalf("workflow rotation transition rejected: %v", err)
	}
}

func TestHistoricalWorkflowConfigurationIsExactBoundedAndCopied(t *testing.T) {
	controller, _, binding, _ := fixture(t)
	base := strings.Split(binding.WorkflowRef, "@")[0] + "@"
	for _, scenario := range []string{"active-duplicated", "history-duplicated", "mutable-ref", "wrong-path", "cross-repository", "uppercase-sha", "too-many"} {
		t.Run(scenario, func(t *testing.T) {
			config := controller.config
			config.HistoricalWorkflowRefs = []string{base + strings.Repeat("d", 40)}
			switch scenario {
			case "active-duplicated":
				config.HistoricalWorkflowRefs = []string{config.WorkflowRef}
			case "history-duplicated":
				config.HistoricalWorkflowRefs = append(config.HistoricalWorkflowRefs, config.HistoricalWorkflowRefs[0])
			case "mutable-ref":
				config.HistoricalWorkflowRefs[0] = base + "refs/heads/main"
			case "wrong-path":
				config.HistoricalWorkflowRefs[0] = strings.Replace(config.HistoricalWorkflowRefs[0], "tuf-publish.yml", "other.yml", 1)
			case "cross-repository":
				config.HistoricalWorkflowRefs[0] = "other-owner/other-repo/.github/workflows/tuf-publish.yml@" + strings.Repeat("d", 40)
			case "uppercase-sha":
				config.HistoricalWorkflowRefs[0] = base + strings.Repeat("D", 40)
			case "too-many":
				config.HistoricalWorkflowRefs = nil
				for index := 0; index < 65; index++ {
					config.HistoricalWorkflowRefs = append(config.HistoricalWorkflowRefs, base+fmt.Sprintf("%040x", index))
				}
			}
			if _, err := New(config, &memoryStore{}, controller.clock); err == nil {
				t.Fatal("invalid historical workflow policy accepted")
			}
		})
	}
	config := controller.config
	approved := base + strings.Repeat("d", 40)
	config.HistoricalWorkflowRefs = []string{approved}
	retained, err := New(config, &memoryStore{}, controller.clock)
	if err != nil {
		t.Fatal(err)
	}
	config.HistoricalWorkflowRefs[0] = base + strings.Repeat("e", 40)
	if retained.config.HistoricalWorkflowRefs[0] != approved {
		t.Fatal("caller-owned historical policy slice changed an existing controller")
	}
}
