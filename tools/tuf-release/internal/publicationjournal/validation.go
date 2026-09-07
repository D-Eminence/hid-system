package publicationjournal

import (
	"context"
	"errors"
	"time"
)

// ValidateRecord validates historical structure without authorizing a live
// operation. Durable readers must also validate every adjacent transition.
func ValidateRecord(config Config, record Record) error {
	controller, err := New(config, &transitionStore{}, func() time.Time { return time.Unix(1, 0) })
	if err != nil {
		return err
	}
	return controller.validateRecord(record)
}

// ValidateTransition replays the same policy used for live operations at the
// recorded observation time. It never accesses a cloud store or permits an
// external side effect; callers must authenticate the immutable record bytes.
func ValidateTransition(config Config, previous *Record, next Record) error {
	if err := ValidateRecord(config, next); err != nil {
		return err
	}
	if previous != nil {
		if err := ValidateRecord(config, *previous); err != nil {
			return err
		}
	}
	// Replay under the explicitly approved pin that governed this historical
	// record, without changing the active pin used by live callers.
	if config.WorkflowRef != next.Binding.WorkflowRef {
		history := []string{config.WorkflowRef}
		for _, ref := range config.HistoricalWorkflowRefs {
			if ref != next.Binding.WorkflowRef {
				history = append(history, ref)
			}
		}
		config.WorkflowRef, config.HistoricalWorkflowRefs = next.Binding.WorkflowRef, history
	}
	when, err := canonicalTime(next.UpdatedAt)
	if err != nil {
		return err
	}
	store := &transitionStore{record: previous}
	controller, err := New(config, store, func() time.Time { return when })
	if err != nil {
		return err
	}
	var replay Record
	if previous == nil || previous.Phase == Confirmed {
		replay, err = controller.Begin(context.Background(), next.Binding)
	} else if next.Result == "failed" {
		replay, err = controller.RecordFailure(context.Background(), next.Binding.Owner, previous.Revision, next.FailureCode, next.EvidenceSHA256)
	} else if next.Phase == Confirmed {
		replay, err = controller.Confirm(context.Background(), next.Binding.Owner, previous.Revision, next.Confirmation, next.EvidenceSHA256)
	} else {
		replay, err = controller.Advance(context.Background(), next.Binding.Owner, previous.Revision, next.Phase, next.EvidenceSHA256, next.OperationAuthorization)
	}
	if err != nil {
		return err
	}
	if replay != next {
		return errors.New("publication journal transition changes immutable binding or recorded result")
	}
	return nil
}

type transitionStore struct{ record *Record }

func (store *transitionStore) Load(context.Context, string) (Record, error) {
	if store.record == nil {
		return Record{}, ErrNotFound
	}
	return *store.record, nil
}
func (store *transitionStore) CompareAndSwap(_ context.Context, _ string, prior int64, next Record) error {
	if store.record == nil && prior != 0 || store.record != nil && store.record.Revision != prior {
		return ErrConflict
	}
	store.record = &next
	return nil
}
