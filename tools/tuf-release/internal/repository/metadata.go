package repository

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/x509"
	"encoding/asn1"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"sort"
	"time"

	"github.com/theupdateframework/go-tuf/v2/metadata"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/strictjson"
)

const (
	MaxRootMetadataBytes      = 512_000
	MaxTargetsMetadataBytes   = 5_000_000
	MaxSnapshotMetadataBytes  = 2_000_000
	MaxTimestampMetadataBytes = 64_000
	maxMetadataSignatures     = 20
	// maxSafeInteger is the largest integer represented exactly by both Go's
	// int64 metadata model and the JavaScript validator/publisher boundary.
	maxSafeInteger int64 = 1<<53 - 1
)

var lowerHexSignaturePattern = regexp.MustCompile(`^(?:[0-9a-f]{2})+$`)

type rawEnvelope struct {
	value  map[string]any
	signed map[string]any
}

func decodeRoot(data []byte) (*metadata.Metadata[metadata.RootType], rawEnvelope, error) {
	raw, err := validateMetadataShape(data, metadata.ROOT, MaxRootMetadataBytes)
	if err != nil {
		return nil, rawEnvelope{}, err
	}
	var root metadata.Metadata[metadata.RootType]
	if err := strictjson.Decode(data, &root); err != nil {
		return nil, rawEnvelope{}, fmt.Errorf("decode root metadata: %w", err)
	}
	return &root, raw, nil
}

func decodeTargets(data []byte) (*metadata.Metadata[metadata.TargetsType], rawEnvelope, error) {
	raw, err := validateMetadataShape(data, metadata.TARGETS, MaxTargetsMetadataBytes)
	if err != nil {
		return nil, rawEnvelope{}, err
	}
	var targets metadata.Metadata[metadata.TargetsType]
	if err := strictjson.Decode(data, &targets); err != nil {
		return nil, rawEnvelope{}, fmt.Errorf("decode targets metadata: %w", err)
	}
	return &targets, raw, nil
}

func decodeSnapshot(data []byte) (*metadata.Metadata[metadata.SnapshotType], rawEnvelope, error) {
	raw, err := validateMetadataShape(data, metadata.SNAPSHOT, MaxSnapshotMetadataBytes)
	if err != nil {
		return nil, rawEnvelope{}, err
	}
	var snapshot metadata.Metadata[metadata.SnapshotType]
	if err := strictjson.Decode(data, &snapshot); err != nil {
		return nil, rawEnvelope{}, fmt.Errorf("decode snapshot metadata: %w", err)
	}
	return &snapshot, raw, nil
}

func decodeTimestamp(data []byte) (*metadata.Metadata[metadata.TimestampType], rawEnvelope, error) {
	raw, err := validateMetadataShape(data, metadata.TIMESTAMP, MaxTimestampMetadataBytes)
	if err != nil {
		return nil, rawEnvelope{}, err
	}
	var timestamp metadata.Metadata[metadata.TimestampType]
	if err := strictjson.Decode(data, &timestamp); err != nil {
		return nil, rawEnvelope{}, fmt.Errorf("decode timestamp metadata: %w", err)
	}
	return &timestamp, raw, nil
}

func validateMetadataShape(data []byte, role string, maximum int) (rawEnvelope, error) {
	if len(data) == 0 || len(data) > maximum {
		return rawEnvelope{}, fmt.Errorf("%s metadata size is outside 1..%d", role, maximum)
	}
	var decoded any
	if err := strictjson.Decode(data, &decoded); err != nil {
		return rawEnvelope{}, fmt.Errorf("decode %s metadata shape: %w", role, err)
	}
	envelope, err := exactObject(decoded, role+" metadata", "signatures", "signed")
	if err != nil {
		return rawEnvelope{}, err
	}
	if err := validateRawSignatures(envelope["signatures"], role+" metadata signatures"); err != nil {
		return rawEnvelope{}, err
	}

	var signedKeys []string
	switch role {
	case metadata.ROOT:
		signedKeys = []string{"_type", "consistent_snapshot", "expires", "keys", "roles", "spec_version", "version"}
	case metadata.TARGETS:
		signedKeys = []string{"_type", "expires", "spec_version", "targets", "version"}
	case metadata.SNAPSHOT, metadata.TIMESTAMP:
		signedKeys = []string{"_type", "expires", "meta", "spec_version", "version"}
	default:
		return rawEnvelope{}, fmt.Errorf("unsupported metadata role %q", role)
	}
	signed, err := exactObject(envelope["signed"], role+" metadata signed payload", signedKeys...)
	if err != nil {
		return rawEnvelope{}, err
	}
	if rawRole, ok := signed["_type"].(string); !ok || rawRole != role {
		return rawEnvelope{}, fmt.Errorf("%s metadata has the wrong signed role", role)
	}
	if spec, ok := signed["spec_version"].(string); !ok || spec != metadata.SPECIFICATION_VERSION {
		return rawEnvelope{}, fmt.Errorf("%s metadata must use TUF spec_version %s", role, metadata.SPECIFICATION_VERSION)
	}
	if _, err := rawCanonicalTime(signed["expires"], role+" metadata expires"); err != nil {
		return rawEnvelope{}, err
	}

	switch role {
	case metadata.ROOT:
		if err := validateRawRoot(signed); err != nil {
			return rawEnvelope{}, err
		}
	case metadata.TARGETS:
		if err := validateRawTargets(signed); err != nil {
			return rawEnvelope{}, err
		}
	case metadata.SNAPSHOT:
		if err := validateRawMeta(signed, "targets.json"); err != nil {
			return rawEnvelope{}, err
		}
	case metadata.TIMESTAMP:
		if err := validateRawMeta(signed, "snapshot.json"); err != nil {
			return rawEnvelope{}, err
		}
	}
	return rawEnvelope{value: envelope, signed: signed}, nil
}

func validateRawSignatures(value any, label string) error {
	signatures, ok := value.([]any)
	if !ok || len(signatures) == 0 || len(signatures) > maxMetadataSignatures {
		return fmt.Errorf("%s must contain from 1 through %d records", label, maxMetadataSignatures)
	}
	seen := make(map[string]struct{}, len(signatures))
	for index, value := range signatures {
		signature, err := exactObject(value, fmt.Sprintf("%s[%d]", label, index), "keyid", "sig")
		if err != nil {
			return err
		}
		keyID, keyOK := signature["keyid"].(string)
		sig, sigOK := signature["sig"].(string)
		if !keyOK || !sha256Pattern.MatchString(keyID) {
			return fmt.Errorf("%s[%d] has an invalid key ID", label, index)
		}
		if !sigOK || len(sig) > 512 || !lowerHexSignaturePattern.MatchString(sig) {
			return fmt.Errorf("%s[%d] has an invalid lowercase-hex signature", label, index)
		}
		if _, duplicate := seen[keyID]; duplicate {
			return fmt.Errorf("%s repeats key ID %s", label, keyID)
		}
		seen[keyID] = struct{}{}
	}
	return nil
}

func validateRawRoot(signed map[string]any) error {
	keys, err := stringObject(signed["keys"], "root metadata keys")
	if err != nil {
		return err
	}
	for keyID, value := range keys {
		if !sha256Pattern.MatchString(keyID) {
			return fmt.Errorf("root metadata key ID %q is invalid", keyID)
		}
		key, err := exactObject(value, "root metadata key "+keyID, "keytype", "keyval", "scheme")
		if err != nil {
			return err
		}
		keyValue, err := exactObject(key["keyval"], "root metadata keyval "+keyID, "public")
		if err != nil {
			return err
		}
		if _, ok := keyValue["public"].(string); !ok {
			return fmt.Errorf("root metadata key %s public value must be a string", keyID)
		}
	}
	roles, err := exactObject(signed["roles"], "root metadata roles", metadata.ROOT, metadata.SNAPSHOT, metadata.TARGETS, metadata.TIMESTAMP)
	if err != nil {
		return err
	}
	for _, roleName := range []string{metadata.ROOT, metadata.TARGETS, metadata.SNAPSHOT, metadata.TIMESTAMP} {
		if _, err := exactObject(roles[roleName], "root metadata role "+roleName, "keyids", "threshold"); err != nil {
			return err
		}
	}
	return nil
}

func validateRawTargets(signed map[string]any) error {
	targets, err := stringObject(signed["targets"], "targets metadata targets")
	if err != nil {
		return err
	}
	for targetPath, value := range targets {
		descriptor, err := exactObject(value, "target descriptor "+targetPath, "hashes", "length")
		if err != nil {
			return err
		}
		if _, err := exactObject(descriptor["hashes"], "target hashes "+targetPath, "sha256"); err != nil {
			return err
		}
	}
	return nil
}

func validateRawMeta(signed map[string]any, requiredName string) error {
	metaFiles, err := exactObject(signed["meta"], "metadata references", requiredName)
	if err != nil {
		return err
	}
	descriptor, err := exactObject(metaFiles[requiredName], "metadata reference "+requiredName, "hashes", "length", "version")
	if err != nil {
		return err
	}
	_, err = exactObject(descriptor["hashes"], "metadata reference hashes "+requiredName, "sha256")
	return err
}

func exactObject(value any, label string, expected ...string) (map[string]any, error) {
	object, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s must be an object", label)
	}
	expectedSet := make(map[string]struct{}, len(expected))
	for _, name := range expected {
		expectedSet[name] = struct{}{}
	}
	if len(object) != len(expectedSet) {
		return nil, fmt.Errorf("%s must contain exactly %v", label, sortedCopy(expected))
	}
	for name := range object {
		if _, accepted := expectedSet[name]; !accepted {
			return nil, fmt.Errorf("%s contains unexpected member %q", label, name)
		}
	}
	for name := range expectedSet {
		if _, present := object[name]; !present {
			return nil, fmt.Errorf("%s omits required member %q", label, name)
		}
	}
	return object, nil
}

func stringObject(value any, label string) (map[string]any, error) {
	object, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s must be an object", label)
	}
	return object, nil
}

func rawCanonicalTime(value any, label string) (time.Time, error) {
	text, ok := value.(string)
	if !ok {
		return time.Time{}, fmt.Errorf("%s must be a string", label)
	}
	return parseWholeSecondUTC(text, label)
}

func validateCommon(role, roleType, specVersion string, version int64, expires time.Time, raw rawEnvelope) error {
	if roleType != role {
		return fmt.Errorf("%s metadata has the wrong signed role", role)
	}
	if specVersion != metadata.SPECIFICATION_VERSION {
		return fmt.Errorf("%s metadata has unsupported spec_version %q", role, specVersion)
	}
	if version < 1 || version > maxSafeInteger {
		return fmt.Errorf("%s metadata version must be a positive safe integer", role)
	}
	rawExpiry, err := rawCanonicalTime(raw.signed["expires"], role+" metadata expires")
	if err != nil {
		return err
	}
	if !expires.Equal(rawExpiry) {
		return fmt.Errorf("%s metadata expiry changed during decoding", role)
	}
	return nil
}

func validateMetadataSignatures(signatures []metadata.Signature) error {
	seen := make(map[string]struct{}, len(signatures))
	for index, signature := range signatures {
		if !sha256Pattern.MatchString(signature.KeyID) {
			return fmt.Errorf("signature %d has an invalid key ID", index)
		}
		if _, duplicate := seen[signature.KeyID]; duplicate {
			return fmt.Errorf("metadata repeats signature key ID %s", signature.KeyID)
		}
		seen[signature.KeyID] = struct{}{}
		if err := validateDERSignature(signature.Signature); err != nil {
			return fmt.Errorf("signature %d: %w", index, err)
		}
	}
	return nil
}

type ecdsaSignature struct {
	R *big.Int
	S *big.Int
}

func validateDERSignature(encoded []byte) error {
	if len(encoded) == 0 {
		return errors.New("signature is empty")
	}
	var decoded ecdsaSignature
	rest, err := asn1.Unmarshal(encoded, &decoded)
	if err != nil || len(rest) != 0 || decoded.R == nil || decoded.S == nil {
		return errors.New("signature is not one complete DER ECDSA pair")
	}
	order := elliptic.P256().Params().N
	if decoded.R.Sign() <= 0 || decoded.S.Sign() <= 0 || decoded.R.Cmp(order) >= 0 || decoded.S.Cmp(order) >= 0 {
		return errors.New("signature scalars are outside the P-256 range")
	}
	canonical, err := asn1.Marshal(decoded)
	if err != nil || !bytes.Equal(canonical, encoded) {
		return errors.New("signature is not canonical DER")
	}
	return nil
}

func validateP256Key(keyID string, key *metadata.Key) (string, error) {
	if key == nil || (key.Type != metadata.KeyTypeECDSA_SHA2_P256 && key.Type != metadata.KeyTypeECDSA_SHA2_P256_COMPAT) ||
		key.Scheme != metadata.KeySchemeECDSA_SHA2_P256 {
		return "", fmt.Errorf("key %s must be P-256 ECDSA/SHA-256", keyID)
	}
	calculatedID, err := key.ID()
	if err != nil || calculatedID != keyID {
		return "", fmt.Errorf("key %s does not match its canonical TUF key ID", keyID)
	}
	block, remainder := pem.Decode([]byte(key.Value.PublicKey))
	if block == nil || block.Type != "PUBLIC KEY" || len(block.Headers) != 0 || len(remainder) != 0 ||
		!bytes.Equal(pem.EncodeToMemory(block), []byte(key.Value.PublicKey)) {
		return "", fmt.Errorf("key %s public value must be one canonical PUBLIC KEY PEM block", keyID)
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return "", fmt.Errorf("key %s contains invalid SubjectPublicKeyInfo", keyID)
	}
	publicKey, ok := parsed.(*ecdsa.PublicKey)
	if !ok || publicKey.Curve != elliptic.P256() || publicKey.X == nil || publicKey.Y == nil ||
		!elliptic.P256().IsOnCurve(publicKey.X, publicKey.Y) {
		return "", fmt.Errorf("key %s is not a valid P-256 public key", keyID)
	}
	canonicalDER, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil || !bytes.Equal(canonicalDER, block.Bytes) {
		return "", fmt.Errorf("key %s public value is not canonical DER", keyID)
	}
	fingerprint := sha256.Sum256(canonicalDER)
	return hex.EncodeToString(fingerprint[:]), nil
}

func roleKeySet(root *metadata.Metadata[metadata.RootType], roleName string) (map[string]struct{}, error) {
	role, ok := root.Signed.Roles[roleName]
	if !ok || role == nil {
		return nil, fmt.Errorf("root omits role %s", roleName)
	}
	result := make(map[string]struct{}, len(role.KeyIDs))
	for _, keyID := range role.KeyIDs {
		if _, duplicate := result[keyID]; duplicate {
			return nil, fmt.Errorf("root role %s repeats key ID %s", roleName, keyID)
		}
		result[keyID] = struct{}{}
	}
	return result, nil
}

func sortedSignatures(signatures []metadata.Signature) []metadata.Signature {
	result := append([]metadata.Signature(nil), signatures...)
	sort.Slice(result, func(left, right int) bool { return result[left].KeyID < result[right].KeyID })
	return result
}
