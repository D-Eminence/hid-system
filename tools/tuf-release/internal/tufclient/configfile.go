package tufclient

import (
	"fmt"
	"path/filepath"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/strictjson"
)

type FileConfig struct {
	SchemaVersion     string `json:"schema_version"`
	Environment       string `json:"environment"`
	RepositoryID      string `json:"repository_id"`
	MetadataURL       string `json:"metadata_url"`
	TargetsURL        string `json:"targets_url"`
	TrustedRootPath   string `json:"trusted_root_path"`
	TrustedRootSHA256 string `json:"trusted_root_sha256"`
	StateDir          string `json:"state_dir"`
	MaxTargetBytes    int64  `json:"max_target_bytes"`
}

func LoadConfig(filePath string) (Config, error) {
	data, err := readRegularFile(filePath, 64_000)
	if err != nil {
		return Config{}, err
	}
	var loaded FileConfig
	if err := strictjson.Decode(data, &loaded); err != nil {
		return Config{}, fmt.Errorf("decode trust configuration: %w", err)
	}
	if loaded.SchemaVersion != "1.0.0" {
		return Config{}, fmt.Errorf("unsupported trust configuration schema %q", loaded.SchemaVersion)
	}
	base, err := filepath.Abs(filepath.Dir(filePath))
	if err != nil {
		return Config{}, err
	}
	resolvePath := func(value string) string {
		if filepath.IsAbs(value) {
			return filepath.Clean(value)
		}
		return filepath.Join(base, value)
	}
	return Config{
		Environment: loaded.Environment, RepositoryID: loaded.RepositoryID,
		MetadataURL: loaded.MetadataURL, TargetsURL: loaded.TargetsURL,
		TrustedRootPath:   resolvePath(loaded.TrustedRootPath),
		TrustedRootSHA256: loaded.TrustedRootSHA256, StateDir: resolvePath(loaded.StateDir),
		MaxTargetBytes: loaded.MaxTargetBytes,
	}, nil
}
