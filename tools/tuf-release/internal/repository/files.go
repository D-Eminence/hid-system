package repository

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

func ReadRootFile(filePath string) ([]byte, error) {
	return readSecurityFile(filePath, MaxRootMetadataBytes, "root metadata")
}

func ReadTargetsMetadataFile(filePath string) ([]byte, error) {
	return readSecurityFile(filePath, MaxTargetsMetadataBytes, "targets metadata")
}

func ReadSnapshotMetadataFile(filePath string) ([]byte, error) {
	return readSecurityFile(filePath, MaxSnapshotMetadataBytes, "snapshot metadata")
}

func ReadTimestampMetadataFile(filePath string) ([]byte, error) {
	return readSecurityFile(filePath, MaxTimestampMetadataBytes, "timestamp metadata")
}

func ReadOperatorConfigFile(filePath string) ([]byte, error) {
	return readSecurityFile(filePath, 64_000, "operator configuration")
}

func WriteExclusiveMetadataFile(filePath string, data []byte, maximum int) error {
	return writeExclusiveSecurityFile(filePath, data, int64(maximum), "metadata output")
}

// WriteExclusiveEvidenceFile writes bounded ceremony evidence with private
// permissions and without replacing any existing pathname.
func WriteExclusiveEvidenceFile(filePath string, data []byte, maximum int64) error {
	return writeExclusiveSecurityFile(filePath, data, maximum, "evidence output")
}

func writeExclusiveSecurityFile(filePath string, data []byte, maximum int64, label string) error {
	if maximum < 1 || len(data) == 0 || int64(len(data)) > maximum {
		return fmt.Errorf("%s size is outside 1..%d", label, maximum)
	}
	if err := requireCanonicalAbsoluteFilePath(filePath, label); err != nil {
		return err
	}
	if _, err := os.Lstat(filePath); !errors.Is(err, os.ErrNotExist) {
		if err == nil {
			return fmt.Errorf("%s already exists", label)
		}
		return err
	}
	if err := writeExclusiveFile(filePath, data, 0o600); err != nil {
		return err
	}
	return nil
}

func readSecurityFile(filePath string, maximum int, label string) ([]byte, error) {
	if err := requireCanonicalAbsoluteFilePath(filePath, label); err != nil {
		return nil, err
	}
	data, err := readRegularFile(filePath, int64(maximum))
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", label, err)
	}
	return data, nil
}

func requireCanonicalAbsoluteFilePath(filePath, label string) error {
	if filePath == "" || !filepath.IsAbs(filePath) || filepath.Clean(filePath) != filePath {
		return fmt.Errorf("%s path must be canonical and absolute", label)
	}
	parent := filepath.Dir(filePath)
	info, err := os.Lstat(parent)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s parent must be an existing real directory", label)
	}
	realParent, err := filepath.EvalSymlinks(parent)
	if err != nil || realParent != parent {
		return fmt.Errorf("%s parent path must contain no symbolic links", label)
	}
	return nil
}
