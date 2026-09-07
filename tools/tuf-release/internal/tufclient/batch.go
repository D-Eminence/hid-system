package tufclient

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/theupdateframework/go-tuf/v2/metadata"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/strictjson"
)

const (
	batchRequestSchema = "1.0.0"
	maxBatchTargets    = 512
	maxBatchRequest    = 1 << 20
)

type BatchTarget struct {
	Target string `json:"target"`
	Output string `json:"output"`
}

type BatchRequest struct {
	SchemaVersion string        `json:"schema_version"`
	Targets       []BatchTarget `json:"targets"`
}

func LoadBatchRequest(filePath string) (BatchRequest, error) {
	data, err := readRegularFile(filePath, maxBatchRequest)
	if err != nil {
		return BatchRequest{}, fmt.Errorf("read batch request: %w", err)
	}
	var request BatchRequest
	if err := strictjson.Decode(data, &request); err != nil {
		return BatchRequest{}, fmt.Errorf("decode batch request: %w", err)
	}
	if err := validateBatchRequest(request); err != nil {
		return BatchRequest{}, err
	}
	return request, nil
}

func validateBatchRequest(request BatchRequest) error {
	if request.SchemaVersion != batchRequestSchema {
		return fmt.Errorf("unsupported batch-request schema %q", request.SchemaVersion)
	}
	if len(request.Targets) == 0 || len(request.Targets) > maxBatchTargets {
		return fmt.Errorf("batch target count %d is outside 1..%d", len(request.Targets), maxBatchTargets)
	}
	seenTargets := make(map[string]struct{}, len(request.Targets))
	seenOutputs := make(map[string]struct{}, len(request.Targets))
	outputs := make([]string, 0, len(request.Targets))
	for index, entry := range request.Targets {
		if entry.Target == "" || len(entry.Target) > 512 || strings.ContainsRune(entry.Target, 0) {
			return fmt.Errorf("batch target %d has an invalid logical path", index)
		}
		if _, duplicate := seenTargets[entry.Target]; duplicate {
			return fmt.Errorf("batch request repeats target %q", entry.Target)
		}
		seenTargets[entry.Target] = struct{}{}
		if entry.Output == "" || len(entry.Output) > 4096 || strings.ContainsRune(entry.Output, 0) ||
			!filepath.IsAbs(entry.Output) || filepath.Clean(entry.Output) != entry.Output {
			return fmt.Errorf("batch target %d output must be a canonical absolute path", index)
		}
		if _, duplicate := seenOutputs[entry.Output]; duplicate {
			return fmt.Errorf("batch request repeats output %q", entry.Output)
		}
		for _, output := range outputs {
			if withinFilesystemPath(output, entry.Output) || withinFilesystemPath(entry.Output, output) {
				return fmt.Errorf("batch outputs %q and %q overlap", output, entry.Output)
			}
		}
		seenOutputs[entry.Output] = struct{}{}
		outputs = append(outputs, entry.Output)
	}
	return nil
}

// DownloadReleaseTargets validates and resolves the entire requested set before
// creating any output. Downloads then share this client's one authenticated
// refresh and exclusive durable-state lock. Outputs are individually committed
// with no-replace semantics; callers should use a fresh disposable workspace if
// they require cleanup after a later repository availability failure.
func (client *Client) DownloadReleaseTargets(releaseID string, request BatchRequest) error {
	if err := validateBatchRequest(request); err != nil {
		return err
	}
	for _, entry := range request.Targets {
		if err := validateTargetPath(client.configuration.Environment, releaseID, entry.Target); err != nil {
			return fmt.Errorf("batch target %q: %w", entry.Target, err)
		}
		if _, err := client.validateDestination(entry.Output); err != nil {
			return err
		}
	}
	if !client.refreshed {
		if _, err := client.Refresh(); err != nil {
			return err
		}
	}
	information := make([]*metadata.TargetFiles, len(request.Targets))
	for index, entry := range request.Targets {
		info, err := client.updater.GetTargetInfo(entry.Target)
		if err != nil {
			return fmt.Errorf("resolve verified target %q: %w", entry.Target, err)
		}
		if info.Length < 0 || info.Length > client.configuration.MaxTargetBytes {
			return fmt.Errorf("target %q length %d exceeds configured limit", entry.Target, info.Length)
		}
		information[index] = info
	}
	for index, entry := range request.Targets {
		if err := client.downloadVerifiedTarget(information[index], entry.Target, entry.Output); err != nil {
			return err
		}
	}
	return nil
}

func withinFilesystemPath(root, candidate string) bool {
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(candidate))
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}
