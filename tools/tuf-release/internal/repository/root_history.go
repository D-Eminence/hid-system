package repository

import (
	"errors"
	"fmt"
	"time"

	"github.com/theupdateframework/go-tuf/v2/metadata"
)

// RootHistoryState describes one authenticated, contiguous retained root
// chain. Callers still pin the first root hash independently.
type RootHistoryState struct {
	FirstVersion  int64
	FirstSHA256   string
	LatestVersion int64
	LatestSHA256  string
}

// ValidateRootHistory authenticates every sequential root under both its old
// and new root authorities. Retained roots may be expired; optionally the last
// root must satisfy the current publication freshness window.
func ValidateRootHistory(history [][]byte, reference time.Time, requireLatestFresh bool) (RootHistoryState, error) {
	if err := requireWholeSecondUTC(reference, "root-history reference time"); err != nil {
		return RootHistoryState{}, err
	}
	if len(history) == 0 || len(history) > MaxRepositoryFiles {
		return RootHistoryState{}, errors.New("root history count is outside the governed range")
	}
	var previous *metadata.Metadata[metadata.RootType]
	var firstVersion int64
	for index, rootBytes := range history {
		root, raw, err := decodeRoot(rootBytes)
		if err != nil {
			return RootHistoryState{}, fmt.Errorf("decode retained root %d: %w", index, err)
		}
		if err := validateRootPolicy(root, raw, reference, false); err != nil {
			return RootHistoryState{}, fmt.Errorf("validate retained root %d: %w", index, err)
		}
		if index == 0 {
			firstVersion = root.Signed.Version
		} else {
			if root.Signed.Version != previous.Signed.Version+1 {
				return RootHistoryState{}, errors.New("root history versions must advance contiguously")
			}
			if err := previous.VerifyDelegate(metadata.ROOT, root); err != nil {
				return RootHistoryState{}, fmt.Errorf("retained root %d does not meet its predecessor threshold: %w", index, err)
			}
		}
		previous = root
	}
	if previous == nil {
		return RootHistoryState{}, errors.New("root history is empty")
	}
	if requireLatestFresh {
		latestBytes := history[len(history)-1]
		latest, raw, err := decodeRoot(latestBytes)
		if err != nil {
			return RootHistoryState{}, err
		}
		if err := validateRootPolicy(latest, raw, reference, true); err != nil {
			return RootHistoryState{}, fmt.Errorf("validate latest root freshness: %w", err)
		}
	}
	return RootHistoryState{
		FirstVersion: firstVersion, FirstSHA256: sha256Hex(history[0]),
		LatestVersion: previous.Signed.Version, LatestSHA256: sha256Hex(history[len(history)-1]),
	}, nil
}
