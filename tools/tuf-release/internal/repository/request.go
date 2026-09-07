package repository

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"

	"golang.org/x/sys/unix"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/strictjson"
)

const (
	PreparedTargetsPayloadName = "targets.signed.json"
	TargetsSigningRequestName  = "targets-signing-request.json"
	MaxSigningRequestBytes     = 1 << 20
)

type SigningRequestTarget struct {
	LogicalPath  string `json:"logical_path"`
	PhysicalPath string `json:"physical_path"`
	Length       int64  `json:"length"`
	SHA256       string `json:"sha256"`
}

type TargetsSigningRequest struct {
	SchemaVersion  string                 `json:"schema_version"`
	Environment    string                 `json:"environment"`
	RepositoryID   string                 `json:"repository_id"`
	ReleaseID      string                 `json:"release_id"`
	CreatedAt      string                 `json:"created_at"`
	RootVersion    int64                  `json:"root_version"`
	RootSHA256     string                 `json:"root_sha256"`
	TargetsVersion int64                  `json:"targets_version"`
	TargetsExpires string                 `json:"targets_expires"`
	PayloadName    string                 `json:"payload_name"`
	PayloadLength  int64                  `json:"payload_length"`
	PayloadSHA256  string                 `json:"payload_sha256"`
	Targets        []SigningRequestTarget `json:"targets"`
}

func NewTargetsSigningRequest(prepared PreparedTargets) (TargetsSigningRequest, error) {
	if _, err := validateTargetsPlan(prepared.Plan); err != nil {
		return TargetsSigningRequest{}, err
	}
	if len(prepared.Payload) == 0 || len(prepared.Payload) > MaxTargetsMetadataBytes ||
		sha256Hex(prepared.Payload) != prepared.PayloadSHA256 || !sha256Pattern.MatchString(prepared.RootSHA256) {
		return TargetsSigningRequest{}, errors.New("prepared targets hashes or payload size are invalid")
	}
	if len(prepared.Targets) != len(prepared.Plan.Targets) {
		return TargetsSigningRequest{}, errors.New("prepared targets inventory count is invalid")
	}
	requestTargets := make([]SigningRequestTarget, len(prepared.Targets))
	for index, target := range prepared.Targets {
		input := prepared.Plan.Targets[index]
		if target.LogicalPath != input.Path || target.PhysicalPath != physicalTargetPath(input.Path, input.SHA256) ||
			target.SourcePath != input.SourcePath || target.Length != input.Length || target.SHA256 != input.SHA256 {
			return TargetsSigningRequest{}, fmt.Errorf("prepared targets inventory entry %d does not match its plan", index)
		}
		requestTargets[index] = SigningRequestTarget{
			LogicalPath: target.LogicalPath, PhysicalPath: target.PhysicalPath,
			Length: target.Length, SHA256: target.SHA256,
		}
	}
	return TargetsSigningRequest{
		SchemaVersion: SchemaVersion, Environment: prepared.Plan.Environment, RepositoryID: prepared.Plan.RepositoryID,
		ReleaseID: prepared.Plan.ReleaseID, CreatedAt: prepared.Plan.CreatedAt,
		RootVersion: prepared.Plan.RootVersion, RootSHA256: prepared.RootSHA256,
		TargetsVersion: prepared.Plan.TargetsVersion, TargetsExpires: prepared.Plan.TargetsExpires,
		PayloadName: PreparedTargetsPayloadName, PayloadLength: int64(len(prepared.Payload)),
		PayloadSHA256: prepared.PayloadSHA256, Targets: requestTargets,
	}, nil
}

func LoadTargetsSigningRequest(filePath string) (TargetsSigningRequest, error) {
	data, err := readRegularFile(filePath, MaxSigningRequestBytes)
	if err != nil {
		return TargetsSigningRequest{}, fmt.Errorf("read targets signing request: %w", err)
	}
	var raw any
	if err := strictjson.Decode(data, &raw); err != nil {
		return TargetsSigningRequest{}, fmt.Errorf("decode targets signing request shape: %w", err)
	}
	object, err := exactObject(raw, "targets signing request",
		"created_at", "environment", "payload_length", "payload_name", "payload_sha256", "release_id",
		"repository_id", "root_sha256", "root_version", "schema_version", "targets", "targets_expires", "targets_version")
	if err != nil {
		return TargetsSigningRequest{}, err
	}
	targets, ok := object["targets"].([]any)
	if !ok {
		return TargetsSigningRequest{}, errors.New("targets signing request targets must be an array")
	}
	for index, target := range targets {
		if _, err := exactObject(target, fmt.Sprintf("targets signing request target %d", index), "length", "logical_path", "physical_path", "sha256"); err != nil {
			return TargetsSigningRequest{}, err
		}
	}
	var request TargetsSigningRequest
	if err := strictjson.Decode(data, &request); err != nil {
		return TargetsSigningRequest{}, fmt.Errorf("decode targets signing request: %w", err)
	}
	if request.SchemaVersion != SchemaVersion || request.PayloadName != PreparedTargetsPayloadName ||
		request.PayloadLength < 1 || request.PayloadLength > MaxTargetsMetadataBytes ||
		!sha256Pattern.MatchString(request.PayloadSHA256) || !sha256Pattern.MatchString(request.RootSHA256) {
		return TargetsSigningRequest{}, errors.New("targets signing request header is invalid")
	}
	return request, nil
}

// WritePreparedTargetsDirectory atomically creates a private, absent output
// directory containing only the canonical payload and its signing request.
func WritePreparedTargetsDirectory(directory string, prepared PreparedTargets) (TargetsSigningRequest, error) {
	request, err := NewTargetsSigningRequest(prepared)
	if err != nil {
		return TargetsSigningRequest{}, err
	}
	requestBytes, err := json.MarshalIndent(request, "", "  ")
	if err != nil {
		return TargetsSigningRequest{}, fmt.Errorf("encode targets signing request: %w", err)
	}
	requestBytes = append(requestBytes, '\n')
	if err := createAtomicDirectory(directory, map[string][]byte{
		PreparedTargetsPayloadName: prepared.Payload,
		TargetsSigningRequestName:  requestBytes,
	}); err != nil {
		return TargetsSigningRequest{}, err
	}
	return request, nil
}

// LoadPreparedTargetsDirectory re-reads all plan sources, root bytes, payload,
// and request evidence. This prevents a changed source or signing request from
// crossing the offline ceremony/assembly boundary.
func LoadPreparedTargetsDirectory(directory string, plan TargetsPlan, rootBytes []byte) (PreparedTargets, error) {
	if err := requireExactDirectoryFiles(directory, PreparedTargetsPayloadName, TargetsSigningRequestName); err != nil {
		return PreparedTargets{}, err
	}
	payload, err := readRegularFile(filepath.Join(directory, PreparedTargetsPayloadName), MaxTargetsMetadataBytes)
	if err != nil {
		return PreparedTargets{}, fmt.Errorf("read prepared targets payload: %w", err)
	}
	request, err := LoadTargetsSigningRequest(filepath.Join(directory, TargetsSigningRequestName))
	if err != nil {
		return PreparedTargets{}, err
	}
	prepared, err := PrepareTargets(plan, rootBytes)
	if err != nil {
		return PreparedTargets{}, err
	}
	expectedRequest, err := NewTargetsSigningRequest(prepared)
	if err != nil {
		return PreparedTargets{}, err
	}
	if !bytes.Equal(payload, prepared.Payload) || !reflect.DeepEqual(request, expectedRequest) {
		return PreparedTargets{}, errors.New("prepared targets directory does not match the current plan, root, sources, and canonical payload")
	}
	return prepared, nil
}

func createAtomicDirectory(destination string, files map[string][]byte) error {
	parent, base, err := validateAbsentDestination(destination)
	if err != nil {
		return err
	}
	temporary, err := os.MkdirTemp(parent, ".hid-tuf-prepared-")
	if err != nil {
		return err
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.RemoveAll(temporary)
		}
	}()
	if err := os.Chmod(temporary, 0o700); err != nil {
		return err
	}
	for name, data := range files {
		if filepath.Base(name) != name || name == "." || name == ".." {
			return fmt.Errorf("prepared output name %q is invalid", name)
		}
		if err := writeExclusiveFile(filepath.Join(temporary, name), data, 0o600); err != nil {
			return err
		}
	}
	if err := syncDirectory(temporary); err != nil {
		return err
	}
	if err := unix.Renameat2(unix.AT_FDCWD, temporary, unix.AT_FDCWD, filepath.Join(parent, base), unix.RENAME_NOREPLACE); err != nil {
		return fmt.Errorf("commit prepared targets directory without replacement: %w", err)
	}
	cleanup = false
	return syncDirectory(parent)
}

func validateAbsentDestination(destination string) (string, string, error) {
	if destination == "" || !filepath.IsAbs(destination) || filepath.Clean(destination) != destination {
		return "", "", errors.New("output directory must be a canonical absolute path")
	}
	parent := filepath.Dir(destination)
	base := filepath.Base(destination)
	if base == "." || base == string(filepath.Separator) {
		return "", "", errors.New("output directory basename is invalid")
	}
	info, err := os.Lstat(parent)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", "", errors.New("output parent must be an existing real directory")
	}
	realParent, err := filepath.EvalSymlinks(parent)
	if err != nil || realParent != parent {
		return "", "", errors.New("output parent path must contain no symbolic links")
	}
	if _, err := os.Lstat(destination); !errors.Is(err, os.ErrNotExist) {
		if err == nil {
			return "", "", errors.New("output directory already exists")
		}
		return "", "", err
	}
	return parent, base, nil
}

func requireExactDirectoryFiles(directory string, expected ...string) error {
	if directory == "" || !filepath.IsAbs(directory) || filepath.Clean(directory) != directory {
		return errors.New("prepared targets directory must be a canonical absolute path")
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("prepared targets path must be a real directory")
	}
	realDirectory, err := filepath.EvalSymlinks(directory)
	if err != nil || realDirectory != directory {
		return errors.New("prepared targets directory path must contain no symbolic links")
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	if len(entries) != len(expected) {
		return errors.New("prepared targets directory has missing or unexpected entries")
	}
	expectedSet := make(map[string]struct{}, len(expected))
	for _, name := range expected {
		expectedSet[name] = struct{}{}
	}
	for _, entry := range entries {
		if _, ok := expectedSet[entry.Name()]; !ok || !entry.Type().IsRegular() {
			return fmt.Errorf("prepared targets directory contains invalid entry %q", entry.Name())
		}
	}
	return nil
}

func syncDirectory(directory string) error {
	file, err := os.Open(directory)
	if err != nil {
		return err
	}
	return errors.Join(file.Sync(), file.Close())
}
