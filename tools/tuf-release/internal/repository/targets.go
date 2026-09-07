package repository

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/secure-systems-lab/go-securesystemslib/cjson"
	"github.com/theupdateframework/go-tuf/v2/metadata"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/strictjson"
)

const (
	MaxDetachedSignatureBytes        int64 = 16_384
	MaxTargetsAttestationBytes       int64 = MaxSigningRequestBytes + 4_096
	TargetsAttestationStatementName        = "targets-evidence-attestation-statement.json"
	TargetsSignatureEvidenceName           = "targets-signature-evidence.json"
	targetsEvidenceAttestationDomain       = "hid-system:tuf:targets-signature-evidence-attestation:v1"
)

type PreparedTarget struct {
	LogicalPath  string `json:"logical_path"`
	PhysicalPath string `json:"physical_path"`
	SourcePath   string `json:"source_path"`
	Length       int64  `json:"length"`
	SHA256       string `json:"sha256"`
}

// PreparedTargets is the exact canonical payload presented to offline targets
// custodians. It contains no private key and cannot itself authorize metadata.
type PreparedTargets struct {
	Plan          TargetsPlan      `json:"plan"`
	Payload       []byte           `json:"payload"`
	PayloadSHA256 string           `json:"payload_sha256"`
	RootSHA256    string           `json:"root_sha256"`
	Targets       []PreparedTarget `json:"targets"`
}

type DetachedSignature struct {
	SchemaVersion  string `json:"schema_version"`
	Environment    string `json:"environment"`
	RepositoryID   string `json:"repository_id"`
	ReleaseID      string `json:"release_id"`
	RootVersion    int64  `json:"root_version"`
	RootSHA256     string `json:"root_sha256"`
	TargetsVersion int64  `json:"targets_version"`
	PayloadSHA256  string `json:"payload_sha256"`
	KeyID          string `json:"keyid"`
	Signature      string `json:"sig"`
	SignedAt       string `json:"signed_at"`
	// Attestation is a second signature by KeyID over the domain-separated,
	// canonical full signing request, KeyID, Signature, and SignedAt.
	Attestation string `json:"attestation"`
}

type targetsEvidenceAttestationStatement struct {
	Domain       string                `json:"domain"`
	Request      TargetsSigningRequest `json:"request"`
	KeyID        string                `json:"keyid"`
	TUFSignature string                `json:"tuf_signature"`
	SignedAt     string                `json:"signed_at"`
}

// PrepareTargets verifies every target's no-follow regular-file bytes before
// producing the exact canonical targets payload for an offline ceremony.
func PrepareTargets(plan TargetsPlan, rootBytes []byte) (PreparedTargets, error) {
	validated, err := validateTargetsPlan(plan)
	if err != nil {
		return PreparedTargets{}, err
	}
	root, err := ValidateRoot(rootBytes, validated.CreatedAt)
	if err != nil {
		return PreparedTargets{}, fmt.Errorf("validate targets authority root: %w", err)
	}
	if root.Signed.Version != plan.RootVersion {
		return PreparedTargets{}, fmt.Errorf("targets plan root version %d does not match root version %d", plan.RootVersion, root.Signed.Version)
	}

	targets := metadata.Targets(validated.Expires)
	targets.Signed.Version = plan.TargetsVersion
	preparedTargets := make([]PreparedTarget, 0, len(plan.Targets))
	for _, input := range plan.Targets {
		data, err := readRegularFile(input.SourcePath, MaxTargetBytes)
		if err != nil {
			return PreparedTargets{}, fmt.Errorf("read target %q: %w", input.Path, err)
		}
		if int64(len(data)) != input.Length {
			return PreparedTargets{}, fmt.Errorf("target %q length changed: got %d, expected %d", input.Path, len(data), input.Length)
		}
		actualSHA256 := sha256Hex(data)
		if actualSHA256 != input.SHA256 {
			return PreparedTargets{}, fmt.Errorf("target %q SHA-256 changed", input.Path)
		}
		digest, err := hex.DecodeString(input.SHA256)
		if err != nil {
			return PreparedTargets{}, fmt.Errorf("decode target %q SHA-256: %w", input.Path, err)
		}
		targets.Signed.Targets[input.Path] = &metadata.TargetFiles{
			Length: input.Length,
			Hashes: metadata.Hashes{"sha256": metadata.HexBytes(digest)},
			Path:   input.Path,
		}
		preparedTargets = append(preparedTargets, PreparedTarget{
			LogicalPath: input.Path, PhysicalPath: physicalTargetPath(input.Path, input.SHA256),
			SourcePath: input.SourcePath, Length: input.Length, SHA256: input.SHA256,
		})
	}
	payload, err := cjson.EncodeCanonical(targets.Signed)
	if err != nil {
		return PreparedTargets{}, fmt.Errorf("canonicalize targets payload: %w", err)
	}
	prepared := PreparedTargets{
		Plan: deepCopyTargetsPlan(plan), Payload: bytes.Clone(payload), PayloadSHA256: sha256Hex(payload), RootSHA256: sha256Hex(rootBytes),
		Targets: append([]PreparedTarget(nil), preparedTargets...),
	}
	if _, _, err := validatePreparedTargets(prepared, root); err != nil {
		return PreparedTargets{}, fmt.Errorf("self-validate prepared targets: %w", err)
	}
	return prepared, nil
}

// LoadDetachedSignature reads one strict, bounded, no-follow signature-evidence
// record. The TUF signature and its same-custodian request attestation are
// validated during assembly against the exact prepared request and root role.
func LoadDetachedSignature(filePath string) (DetachedSignature, error) {
	data, err := readRegularFile(filePath, MaxDetachedSignatureBytes)
	if err != nil {
		return DetachedSignature{}, fmt.Errorf("read detached signature: %w", err)
	}
	var raw any
	if err := strictjson.Decode(data, &raw); err != nil {
		return DetachedSignature{}, fmt.Errorf("decode detached signature shape: %w", err)
	}
	if _, err := exactObject(raw, "detached signature",
		"attestation", "environment", "keyid", "payload_sha256", "release_id", "repository_id", "root_sha256", "root_version",
		"schema_version", "sig", "signed_at", "targets_version"); err != nil {
		return DetachedSignature{}, err
	}
	var signature DetachedSignature
	if err := strictjson.Decode(data, &signature); err != nil {
		return DetachedSignature{}, fmt.Errorf("decode detached signature: %w", err)
	}
	return signature, nil
}

// PrepareTargetsEvidenceAttestation returns the exact detached evidence record
// (without its attestation) and the canonical domain-separated bytes that the
// same offline targets custodian must sign. It handles no private key and
// validates the supplied TUF signature before emitting ceremony material.
func PrepareTargetsEvidenceAttestation(prepared PreparedTargets, rootBytes []byte, keyID, tufSignature, signedAt string) (DetachedSignature, []byte, error) {
	plan, root, request, authorized, err := targetsEvidenceContext(prepared, rootBytes)
	if err != nil {
		return DetachedSignature{}, nil, err
	}
	detached := DetachedSignature{
		SchemaVersion: SchemaVersion, Environment: prepared.Plan.Environment,
		RepositoryID: prepared.Plan.RepositoryID, ReleaseID: prepared.Plan.ReleaseID,
		RootVersion: prepared.Plan.RootVersion, RootSHA256: prepared.RootSHA256,
		TargetsVersion: prepared.Plan.TargetsVersion, PayloadSHA256: prepared.PayloadSHA256,
		KeyID: keyID, Signature: tufSignature, SignedAt: signedAt,
	}
	_, _, statement, err := validateDetachedEvidenceCore(detached, prepared, request, plan, root, authorized)
	if err != nil {
		return DetachedSignature{}, nil, err
	}
	return detached, statement, nil
}

// CompleteTargetsEvidence validates a same-custodian attestation and returns
// the exact strict evidence object accepted by AssembleTargets. The caller
// supplies public signatures only; this function never opens or invokes a key.
func CompleteTargetsEvidence(prepared PreparedTargets, rootBytes []byte, keyID, tufSignature, signedAt, attestation string) (DetachedSignature, error) {
	detached, _, err := PrepareTargetsEvidenceAttestation(prepared, rootBytes, keyID, tufSignature, signedAt)
	if err != nil {
		return DetachedSignature{}, err
	}
	detached.Attestation = attestation
	plan, root, request, authorized, err := targetsEvidenceContext(prepared, rootBytes)
	if err != nil {
		return DetachedSignature{}, err
	}
	if _, err := validateDetachedSignature(detached, prepared, request, plan, root, authorized); err != nil {
		return DetachedSignature{}, err
	}
	return detached, nil
}

// AssembleTargets imports exactly the configured targets threshold of detached
// signatures. It exposes no generic signing operation and rejects any signature
// or context outside the selected root, release, repository, and payload.
func AssembleTargets(prepared PreparedTargets, rootBytes []byte, evidence []DetachedSignature) ([]byte, error) {
	validatedPlan, err := validateTargetsPlan(prepared.Plan)
	if err != nil {
		return nil, err
	}
	root, err := ValidateRoot(rootBytes, validatedPlan.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("validate targets authority root: %w", err)
	}
	if root.Signed.Version != prepared.Plan.RootVersion {
		return nil, fmt.Errorf("prepared root version %d does not match root version %d", prepared.Plan.RootVersion, root.Signed.Version)
	}
	if sha256Hex(rootBytes) != prepared.RootSHA256 {
		return nil, errors.New("prepared root SHA-256 does not match root bytes")
	}
	targets, raw, err := validatePreparedTargets(prepared, root)
	if err != nil {
		return nil, err
	}
	request, err := NewTargetsSigningRequest(prepared)
	if err != nil {
		return nil, fmt.Errorf("construct targets signing request for evidence attestation: %w", err)
	}

	role := root.Signed.Roles[metadata.TARGETS]
	if role == nil || len(evidence) != role.Threshold {
		return nil, fmt.Errorf("targets assembly requires exactly the threshold of %d detached signatures", governedRootRoles[metadata.TARGETS].threshold)
	}
	authorized, err := roleKeySet(root, metadata.TARGETS)
	if err != nil {
		return nil, err
	}
	seen := make(map[string]struct{}, len(evidence))
	signatures := make([]metadata.Signature, 0, len(evidence))
	for index, detached := range evidence {
		encoded, err := validateDetachedSignature(detached, prepared, request, validatedPlan, root, authorized)
		if err != nil {
			return nil, fmt.Errorf("detached signature %d: %w", index, err)
		}
		if _, duplicate := seen[detached.KeyID]; duplicate {
			return nil, fmt.Errorf("detached signatures repeat key ID %s", detached.KeyID)
		}
		seen[detached.KeyID] = struct{}{}
		signatures = append(signatures, metadata.Signature{KeyID: detached.KeyID, Signature: metadata.HexBytes(encoded)})
	}
	targets.Signatures = sortedSignatures(signatures)
	if err := validateTargetsPolicy(targets, raw, root, validatedPlan.CreatedAt, prepared.Plan.Environment, prepared.Plan.ReleaseID, true); err != nil {
		return nil, err
	}
	encoded, err := targets.ToBytes(false)
	if err != nil {
		return nil, fmt.Errorf("serialize signed targets metadata: %w", err)
	}
	decoded, decodedRaw, err := decodeTargets(encoded)
	if err != nil {
		return nil, fmt.Errorf("self-decode signed targets metadata: %w", err)
	}
	if err := validateTargetsPolicy(decoded, decodedRaw, root, validatedPlan.CreatedAt, prepared.Plan.Environment, prepared.Plan.ReleaseID, true); err != nil {
		return nil, fmt.Errorf("self-validate signed targets metadata: %w", err)
	}
	return encoded, nil
}

func targetsEvidenceContext(prepared PreparedTargets, rootBytes []byte) (validatedPlan, *metadata.Metadata[metadata.RootType], TargetsSigningRequest, map[string]struct{}, error) {
	plan, err := validateTargetsPlan(prepared.Plan)
	if err != nil {
		return validatedPlan{}, nil, TargetsSigningRequest{}, nil, err
	}
	root, err := ValidateRoot(rootBytes, plan.CreatedAt)
	if err != nil {
		return validatedPlan{}, nil, TargetsSigningRequest{}, nil, fmt.Errorf("validate targets evidence root: %w", err)
	}
	if root.Signed.Version != prepared.Plan.RootVersion || sha256Hex(rootBytes) != prepared.RootSHA256 {
		return validatedPlan{}, nil, TargetsSigningRequest{}, nil, errors.New("targets evidence root does not match the prepared request")
	}
	if _, _, err := validatePreparedTargets(prepared, root); err != nil {
		return validatedPlan{}, nil, TargetsSigningRequest{}, nil, err
	}
	request, err := NewTargetsSigningRequest(prepared)
	if err != nil {
		return validatedPlan{}, nil, TargetsSigningRequest{}, nil, err
	}
	authorized, err := roleKeySet(root, metadata.TARGETS)
	if err != nil {
		return validatedPlan{}, nil, TargetsSigningRequest{}, nil, err
	}
	return plan, root, request, authorized, nil
}

func validatePreparedTargets(prepared PreparedTargets, root *metadata.Metadata[metadata.RootType]) (*metadata.Metadata[metadata.TargetsType], rawEnvelope, error) {
	validatedPlan, err := validateTargetsPlan(prepared.Plan)
	if err != nil {
		return nil, rawEnvelope{}, err
	}
	if !sha256Pattern.MatchString(prepared.PayloadSHA256) || sha256Hex(prepared.Payload) != prepared.PayloadSHA256 {
		return nil, rawEnvelope{}, errors.New("prepared targets payload SHA-256 does not match")
	}
	if !sha256Pattern.MatchString(prepared.RootSHA256) {
		return nil, rawEnvelope{}, errors.New("prepared targets root SHA-256 is invalid")
	}
	targets, raw, err := decodeTargetsPayload(prepared.Payload)
	if err != nil {
		return nil, rawEnvelope{}, err
	}
	canonical, err := cjson.EncodeCanonical(targets.Signed)
	if err != nil || !bytes.Equal(canonical, prepared.Payload) {
		return nil, rawEnvelope{}, errors.New("prepared targets payload is not its exact canonical encoding")
	}
	if err := validateTargetsPolicy(targets, raw, root, validatedPlan.CreatedAt, prepared.Plan.Environment, prepared.Plan.ReleaseID, false); err != nil {
		return nil, rawEnvelope{}, err
	}
	if targets.Signed.Version != prepared.Plan.TargetsVersion || !targets.Signed.Expires.Equal(validatedPlan.Expires) {
		return nil, rawEnvelope{}, errors.New("prepared targets payload does not match plan version or expiry")
	}
	if len(prepared.Targets) != len(prepared.Plan.Targets) {
		return nil, rawEnvelope{}, errors.New("prepared target inventory does not match plan count")
	}
	for index, input := range prepared.Plan.Targets {
		preparedTarget := prepared.Targets[index]
		if preparedTarget.LogicalPath != input.Path || preparedTarget.SourcePath != input.SourcePath ||
			preparedTarget.Length != input.Length || preparedTarget.SHA256 != input.SHA256 ||
			preparedTarget.PhysicalPath != physicalTargetPath(input.Path, input.SHA256) {
			return nil, rawEnvelope{}, fmt.Errorf("prepared target inventory entry %d does not match plan", index)
		}
		descriptor := targets.Signed.Targets[input.Path]
		if descriptor == nil || descriptor.Length != input.Length || len(descriptor.Hashes) != 1 ||
			hex.EncodeToString(descriptor.Hashes["sha256"]) != input.SHA256 {
			return nil, rawEnvelope{}, fmt.Errorf("prepared target descriptor %q does not match plan", input.Path)
		}
	}
	return targets, raw, nil
}

func decodeTargetsPayload(payload []byte) (*metadata.Metadata[metadata.TargetsType], rawEnvelope, error) {
	if len(payload) == 0 || len(payload) > MaxTargetsMetadataBytes {
		return nil, rawEnvelope{}, errors.New("prepared targets payload has an invalid size")
	}
	var decoded any
	if err := strictjson.Decode(payload, &decoded); err != nil {
		return nil, rawEnvelope{}, fmt.Errorf("decode prepared targets payload shape: %w", err)
	}
	signed, err := exactObject(decoded, "prepared targets payload", "_type", "expires", "spec_version", "targets", "version")
	if err != nil {
		return nil, rawEnvelope{}, err
	}
	if role, ok := signed["_type"].(string); !ok || role != metadata.TARGETS {
		return nil, rawEnvelope{}, errors.New("prepared targets payload has the wrong role")
	}
	if spec, ok := signed["spec_version"].(string); !ok || spec != metadata.SPECIFICATION_VERSION {
		return nil, rawEnvelope{}, errors.New("prepared targets payload has the wrong spec_version")
	}
	if _, err := rawCanonicalTime(signed["expires"], "prepared targets expires"); err != nil {
		return nil, rawEnvelope{}, err
	}
	if err := validateRawTargets(signed); err != nil {
		return nil, rawEnvelope{}, err
	}
	var signedTargets metadata.TargetsType
	if err := strictjson.Decode(payload, &signedTargets); err != nil {
		return nil, rawEnvelope{}, fmt.Errorf("decode prepared targets payload: %w", err)
	}
	return &metadata.Metadata[metadata.TargetsType]{Signed: signedTargets, Signatures: []metadata.Signature{}}, rawEnvelope{signed: signed}, nil
}

func validateTargetsPolicy(targets *metadata.Metadata[metadata.TargetsType], raw rawEnvelope, root *metadata.Metadata[metadata.RootType], reference time.Time, environment, releaseID string, requireSignatures bool) error {
	return validateTargetsPolicyWithFreshness(targets, raw, root, reference, environment, releaseID, requireSignatures, true)
}

func validateTargetsPolicyWithFreshness(targets *metadata.Metadata[metadata.TargetsType], raw rawEnvelope, root *metadata.Metadata[metadata.RootType], reference time.Time, environment, releaseID string, requireSignatures, requireFresh bool) error {
	if targets == nil {
		return errors.New("targets metadata is nil")
	}
	if err := validateCommon(metadata.TARGETS, targets.Signed.Type, targets.Signed.SpecVersion, targets.Signed.Version, targets.Signed.Expires, raw); err != nil {
		return err
	}
	if requireFresh {
		remaining := targets.Signed.Expires.Sub(reference)
		if remaining < 14*24*time.Hour {
			return fmt.Errorf("%w: targets has less than 14 days remaining", ErrPublicationRefreshRequired)
		}
		if remaining > 90*24*time.Hour {
			return errors.New("targets publication freshness exceeds 90 days")
		}
	}
	if targets.Signed.Delegations != nil {
		return errors.New("top-level targets metadata must not contain delegations")
	}
	if len(targets.Signed.Targets) == 0 || len(targets.Signed.Targets) > MaxTargets {
		return fmt.Errorf("targets metadata count is outside 1..%d", MaxTargets)
	}
	for targetPath, descriptor := range targets.Signed.Targets {
		if err := validateLogicalTargetPath(targetPath, environment, releaseID); err != nil {
			return fmt.Errorf("targets metadata path %q: %w", targetPath, err)
		}
		if descriptor == nil || descriptor.Length < 1 || descriptor.Length > MaxTargetBytes || descriptor.Custom != nil || len(descriptor.Hashes) != 1 {
			return fmt.Errorf("target descriptor %q is outside the governed shape", targetPath)
		}
		digest, ok := descriptor.Hashes["sha256"]
		if !ok || len(digest) != 32 {
			return fmt.Errorf("target descriptor %q requires exactly one SHA-256 hash", targetPath)
		}
	}
	if requireSignatures {
		role := root.Signed.Roles[metadata.TARGETS]
		if role == nil || len(targets.Signatures) != role.Threshold {
			return errors.New("targets metadata must contain exactly its signature threshold")
		}
		if err := validateMetadataSignatures(targets.Signatures); err != nil {
			return fmt.Errorf("targets metadata: %w", err)
		}
		authorized, err := roleKeySet(root, metadata.TARGETS)
		if err != nil {
			return err
		}
		for _, signature := range targets.Signatures {
			if _, ok := authorized[signature.KeyID]; !ok {
				return fmt.Errorf("targets metadata signature %s is not authorized", signature.KeyID)
			}
		}
		if err := root.VerifyDelegate(metadata.TARGETS, targets); err != nil {
			return fmt.Errorf("targets metadata does not meet its root threshold: %w", err)
		}
	} else if len(targets.Signatures) != 0 {
		return errors.New("prepared targets payload unexpectedly contains signatures")
	}
	return nil
}

// DiscoverTargetsReleaseID extracts the single immutable release namespace
// selected by structurally valid top-level targets metadata. The returned ID
// is untrusted until the caller authenticates the complete metadata set with
// ValidateMetadataSet; this helper exists only for first-checkpoint discovery.
func DiscoverTargetsReleaseID(data []byte, environment string) (string, error) {
	if environment != "staging" && environment != "production" {
		return "", errors.New("targets release discovery environment is invalid")
	}
	targets, _, err := decodeTargets(data)
	if err != nil {
		return "", fmt.Errorf("decode targets for release discovery: %w", err)
	}
	channelPath := "environments/" + environment + "/channels/current.json"
	channelCount := 0
	releaseCount := 0
	releaseID := ""
	for logicalPath := range targets.Signed.Targets {
		if logicalPath == channelPath {
			channelCount++
			continue
		}
		segments := strings.Split(logicalPath, "/")
		if len(segments) < 5 || segments[0] != "environments" || segments[1] != environment ||
			segments[2] != "releases" || !releaseIDPattern.MatchString(segments[3]) {
			return "", fmt.Errorf("targets release discovery path %q is outside the governed namespace", logicalPath)
		}
		if releaseID == "" {
			releaseID = segments[3]
		} else if releaseID != segments[3] {
			return "", errors.New("targets metadata mixes immutable release namespaces")
		}
		if err := validateLogicalTargetPath(logicalPath, environment, releaseID); err != nil {
			return "", fmt.Errorf("targets release discovery path %q: %w", logicalPath, err)
		}
		releaseCount++
	}
	if channelCount != 1 || releaseCount == 0 || releaseID == "" {
		return "", errors.New("targets metadata must select one channel and one immutable release namespace")
	}
	return releaseID, nil
}

func validateDetachedSignature(detached DetachedSignature, prepared PreparedTargets, request TargetsSigningRequest, plan validatedPlan, root *metadata.Metadata[metadata.RootType], authorized map[string]struct{}) ([]byte, error) {
	encoded, publicKey, statement, err := validateDetachedEvidenceCore(detached, prepared, request, plan, root, authorized)
	if err != nil {
		return nil, err
	}
	if !lowerHexSignaturePattern.MatchString(detached.Attestation) || len(detached.Attestation) > 512 {
		return nil, errors.New("attestation must be bounded lowercase hexadecimal")
	}
	attestation, err := hex.DecodeString(detached.Attestation)
	if err != nil {
		return nil, errors.New("attestation is not valid hexadecimal")
	}
	if err := validateDERSignature(attestation); err != nil {
		return nil, fmt.Errorf("attestation: %w", err)
	}
	digest := sha256.Sum256(statement)
	if !ecdsa.VerifyASN1(publicKey, digest[:], attestation) {
		return nil, errors.New("custodian attestation does not authenticate the signing request and TUF signature")
	}
	return encoded, nil
}

func validateDetachedEvidenceCore(detached DetachedSignature, prepared PreparedTargets, request TargetsSigningRequest, plan validatedPlan, root *metadata.Metadata[metadata.RootType], authorized map[string]struct{}) ([]byte, *ecdsa.PublicKey, []byte, error) {
	if detached.SchemaVersion != SchemaVersion || detached.Environment != prepared.Plan.Environment ||
		detached.RepositoryID != prepared.Plan.RepositoryID || detached.ReleaseID != prepared.Plan.ReleaseID ||
		detached.RootVersion != prepared.Plan.RootVersion || detached.RootSHA256 != prepared.RootSHA256 || detached.TargetsVersion != prepared.Plan.TargetsVersion ||
		detached.PayloadSHA256 != prepared.PayloadSHA256 {
		return nil, nil, nil, errors.New("signature evidence context does not match the prepared targets payload")
	}
	if _, ok := authorized[detached.KeyID]; !ok {
		return nil, nil, nil, fmt.Errorf("key ID %q is not authorized for targets", detached.KeyID)
	}
	if !lowerHexSignaturePattern.MatchString(detached.Signature) || len(detached.Signature) > 512 {
		return nil, nil, nil, errors.New("signature must be bounded lowercase hexadecimal")
	}
	encoded, err := hex.DecodeString(detached.Signature)
	if err != nil {
		return nil, nil, nil, errors.New("signature is not valid hexadecimal")
	}
	if err := validateDERSignature(encoded); err != nil {
		return nil, nil, nil, err
	}
	signedAt, err := parseWholeSecondUTC(detached.SignedAt, "detached signature signed_at")
	if err != nil {
		return nil, nil, nil, err
	}
	if signedAt.Before(plan.CreatedAt) || !signedAt.Before(plan.Expires) {
		return nil, nil, nil, errors.New("detached signature time must be within the targets metadata validity interval")
	}
	statement, err := canonicalTargetsEvidenceAttestation(request, detached)
	if err != nil {
		return nil, nil, nil, err
	}
	key := root.Signed.Keys[detached.KeyID]
	if key == nil {
		return nil, nil, nil, fmt.Errorf("authorized targets key %s is absent from root", detached.KeyID)
	}
	parsed, err := key.ToPublicKey()
	if err != nil {
		return nil, nil, nil, fmt.Errorf("parse targets evidence key %s: %w", detached.KeyID, err)
	}
	publicKey, ok := parsed.(*ecdsa.PublicKey)
	if !ok {
		return nil, nil, nil, fmt.Errorf("targets evidence key %s is not P-256 ECDSA", detached.KeyID)
	}
	payloadDigest := sha256.Sum256(prepared.Payload)
	if !ecdsa.VerifyASN1(publicKey, payloadDigest[:], encoded) {
		return nil, nil, nil, errors.New("custodian TUF signature does not authenticate the prepared targets payload")
	}
	return encoded, publicKey, statement, nil
}

func canonicalTargetsEvidenceAttestation(request TargetsSigningRequest, detached DetachedSignature) ([]byte, error) {
	encoded, err := cjson.EncodeCanonical(targetsEvidenceAttestationStatement{
		Domain: targetsEvidenceAttestationDomain, Request: request, KeyID: detached.KeyID,
		TUFSignature: detached.Signature, SignedAt: detached.SignedAt,
	})
	if err != nil {
		return nil, fmt.Errorf("canonicalize targets evidence attestation: %w", err)
	}
	return encoded, nil
}

func deepCopyTargetsPlan(plan TargetsPlan) TargetsPlan {
	result := plan
	result.Targets = append([]TargetInput(nil), plan.Targets...)
	return result
}
