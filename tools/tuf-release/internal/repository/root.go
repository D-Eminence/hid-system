package repository

import (
	"errors"
	"fmt"
	"time"

	"github.com/theupdateframework/go-tuf/v2/metadata"
)

type rootRolePolicy struct {
	keys      int
	threshold int
}

var governedRootRoles = map[string]rootRolePolicy{
	metadata.ROOT:      {keys: 3, threshold: 2},
	metadata.TARGETS:   {keys: 3, threshold: 2},
	metadata.SNAPSHOT:  {keys: 2, threshold: 1},
	metadata.TIMESTAMP: {keys: 2, threshold: 1},
}

// ValidateRoot validates the exact HID top-level key policy and the root's
// self-signature at a whole-second UTC reference time. It accepts old-key
// signatures carried by a rotated root; ValidateRootChain authenticates those.
func ValidateRoot(rootBytes []byte, reference time.Time) (*metadata.Metadata[metadata.RootType], error) {
	root, raw, err := decodeRoot(rootBytes)
	if err != nil {
		return nil, err
	}
	if err := validateRootPolicy(root, raw, reference, true); err != nil {
		return nil, err
	}
	return root, nil
}

// ValidateRootChain validates one sequential root rotation under both the old
// and new root thresholds. The new root must satisfy the current publication
// freshness window; an expired retained old root can still authenticate its
// direct successor.
func ValidateRootChain(previousBytes, nextBytes []byte, reference time.Time) error {
	previous, previousRaw, err := decodeRoot(previousBytes)
	if err != nil {
		return fmt.Errorf("previous root: %w", err)
	}
	if err := validateRootPolicy(previous, previousRaw, reference, false); err != nil {
		return fmt.Errorf("previous root: %w", err)
	}
	next, nextRaw, err := decodeRoot(nextBytes)
	if err != nil {
		return fmt.Errorf("next root: %w", err)
	}
	if err := validateRootPolicy(next, nextRaw, reference, true); err != nil {
		return fmt.Errorf("next root: %w", err)
	}
	if next.Signed.Version != previous.Signed.Version+1 {
		return fmt.Errorf("root rotation must advance exactly one version from %d to %d", previous.Signed.Version, previous.Signed.Version+1)
	}
	if err := previous.VerifyDelegate(metadata.ROOT, next); err != nil {
		return fmt.Errorf("next root does not meet the previous root threshold: %w", err)
	}
	return nil
}

func validateRootPolicy(root *metadata.Metadata[metadata.RootType], raw rawEnvelope, reference time.Time, requireFresh bool) error {
	if root == nil {
		return errors.New("root metadata is nil")
	}
	if err := requireWholeSecondUTC(reference, "root validation reference"); err != nil {
		return err
	}
	if err := validateCommon(metadata.ROOT, root.Signed.Type, root.Signed.SpecVersion, root.Signed.Version, root.Signed.Expires, raw); err != nil {
		return err
	}
	if !root.Signed.ConsistentSnapshot {
		return errors.New("root must enable consistent snapshots")
	}
	if len(root.Signed.Roles) != len(governedRootRoles) {
		return errors.New("root must contain exactly the four top-level roles")
	}
	if len(root.Signed.Keys) != 10 {
		return errors.New("root must contain exactly ten governed keys")
	}

	governedKeyIDs := make(map[string]string, 10)
	for _, roleName := range []string{metadata.ROOT, metadata.TARGETS, metadata.SNAPSHOT, metadata.TIMESTAMP} {
		policy := governedRootRoles[roleName]
		role, ok := root.Signed.Roles[roleName]
		if !ok || role == nil || len(role.KeyIDs) != policy.keys || role.Threshold != policy.threshold {
			return fmt.Errorf("root role %s must be threshold %d of exactly %d keys", roleName, policy.threshold, policy.keys)
		}
		roleSeen := make(map[string]struct{}, len(role.KeyIDs))
		for _, keyID := range role.KeyIDs {
			if !sha256Pattern.MatchString(keyID) {
				return fmt.Errorf("root role %s contains invalid key ID %q", roleName, keyID)
			}
			if _, duplicate := roleSeen[keyID]; duplicate {
				return fmt.Errorf("root role %s repeats key ID %s", roleName, keyID)
			}
			roleSeen[keyID] = struct{}{}
			if previousRole, reused := governedKeyIDs[keyID]; reused {
				return fmt.Errorf("root reuses key ID %s across roles %s and %s", keyID, previousRole, roleName)
			}
			if root.Signed.Keys[keyID] == nil {
				return fmt.Errorf("root role %s references missing key %s", roleName, keyID)
			}
			governedKeyIDs[keyID] = roleName
		}
	}
	if len(governedKeyIDs) != len(root.Signed.Keys) {
		return errors.New("root keys must equal the ten role-authorized keys")
	}

	fingerprints := make(map[string]string, len(root.Signed.Keys))
	for keyID, key := range root.Signed.Keys {
		if _, governed := governedKeyIDs[keyID]; !governed {
			return fmt.Errorf("root contains ungoverned key %s", keyID)
		}
		fingerprint, err := validateP256Key(keyID, key)
		if err != nil {
			return err
		}
		if previousKeyID, duplicate := fingerprints[fingerprint]; duplicate {
			return fmt.Errorf("root repeats one cryptographic public key as %s and %s", previousKeyID, keyID)
		}
		fingerprints[fingerprint] = keyID
	}
	if err := validateMetadataSignatures(root.Signatures); err != nil {
		return fmt.Errorf("root metadata: %w", err)
	}
	if err := root.VerifyDelegate(metadata.ROOT, root); err != nil {
		return fmt.Errorf("root does not meet its self-signature threshold: %w", err)
	}
	if requireFresh {
		remaining := root.Signed.Expires.Sub(reference)
		if remaining < 30*24*time.Hour {
			return fmt.Errorf("%w: root has less than 30 days remaining", ErrPublicationRefreshRequired)
		}
		if remaining > 365*24*time.Hour {
			return errors.New("root publication freshness exceeds 365 days")
		}
	}
	return nil
}

func requireWholeSecondUTC(value time.Time, label string) error {
	if value.IsZero() || value.Nanosecond() != 0 || value.Location() != time.UTC {
		return fmt.Errorf("%s must be a nonzero whole-second UTC time", label)
	}
	return nil
}
