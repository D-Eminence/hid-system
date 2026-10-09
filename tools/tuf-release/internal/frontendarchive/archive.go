package frontendarchive

import (
	"archive/tar"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/strictjson"
	"golang.org/x/sys/unix"
)

const (
	SchemaVersion  = "1.0.0"
	ArchiveProfile = "hid-frontend-ustar-v1"
	MediaType      = "application/vnd.hid.frontend-ustar"
)

var requiredFiles = [...]string{"index.html", "manifest.webmanifest", "service-worker.js"}

type Limits struct {
	MaxFiles        int
	MaxFileBytes    int64
	MaxTotalBytes   int64
	MaxArchiveBytes int64
}

func DefaultLimits() Limits {
	return Limits{MaxFiles: 20_000, MaxFileBytes: 25 << 20, MaxTotalBytes: 25 << 20, MaxArchiveBytes: 25 << 20}
}

type Entry struct {
	Path   string `json:"path"`
	Length int64  `json:"length"`
	SHA256 string `json:"sha256"`
	Mode   int64  `json:"mode"`
}

type Manifest struct {
	SchemaVersion  string  `json:"schema_version"`
	App            string  `json:"app"`
	GitSHA         string  `json:"git_sha"`
	ArchiveProfile string  `json:"archive_profile"`
	FileCount      int     `json:"file_count"`
	TotalSizeBytes int64   `json:"total_size_bytes"`
	Files          []Entry `json:"files"`
}

func (m Manifest) Bytes() ([]byte, error) {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

func ParseManifest(data []byte) (Manifest, error) {
	var manifest Manifest
	if err := strictjson.Decode(data, &manifest); err != nil {
		return Manifest{}, fmt.Errorf("decode frontend manifest: %w", err)
	}
	if err := manifest.Validate(DefaultLimits()); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func (m Manifest) Validate(limits Limits) error {
	if m.SchemaVersion != SchemaVersion {
		return fmt.Errorf("unsupported frontend manifest schema %q", m.SchemaVersion)
	}
	if !validName(m.App) {
		return fmt.Errorf("invalid application %q", m.App)
	}
	if !isLowerHex(m.GitSHA, 40) {
		return errors.New("git_sha must be forty lowercase hexadecimal characters")
	}
	if m.ArchiveProfile != ArchiveProfile {
		return fmt.Errorf("unsupported frontend archive profile %q", m.ArchiveProfile)
	}
	if len(m.Files) == 0 || len(m.Files) > limits.MaxFiles {
		return fmt.Errorf("frontend manifest file count %d is outside 1..%d", len(m.Files), limits.MaxFiles)
	}
	if m.FileCount != len(m.Files) {
		return errors.New("frontend manifest file_count does not match files")
	}
	seen := map[string]struct{}{}
	seenFolded := map[string]string{}
	var total int64
	previous := ""
	for index, entry := range m.Files {
		if err := validatePath(entry.Path); err != nil {
			return fmt.Errorf("manifest entry %d: %w", index, err)
		}
		if index > 0 && entry.Path <= previous {
			return fmt.Errorf("manifest paths are not uniquely sorted at %q", entry.Path)
		}
		previous = entry.Path
		folded := strings.ToLower(entry.Path)
		if prior, ok := seenFolded[folded]; ok {
			return fmt.Errorf("case-colliding paths %q and %q", prior, entry.Path)
		}
		seenFolded[folded] = entry.Path
		seen[entry.Path] = struct{}{}
		if entry.Length < 0 || entry.Length > limits.MaxFileBytes {
			return fmt.Errorf("entry %q length is outside bounds", entry.Path)
		}
		if !isLowerHex(entry.SHA256, 64) {
			return fmt.Errorf("entry %q has invalid SHA-256", entry.Path)
		}
		if entry.Mode != 0o644 {
			return fmt.Errorf("entry %q mode must be 420 (0644)", entry.Path)
		}
		total += entry.Length
		if total > limits.MaxTotalBytes {
			return fmt.Errorf("manifest total length exceeds %d", limits.MaxTotalBytes)
		}
	}
	if total != m.TotalSizeBytes {
		return errors.New("frontend manifest total_size_bytes does not match file lengths")
	}
	if total < 1 {
		return errors.New("frontend manifest must contain at least one byte of content")
	}
	if canonicalArchiveLength(m.Files) > limits.MaxArchiveBytes {
		return fmt.Errorf("canonical frontend archive exceeds %d bytes", limits.MaxArchiveBytes)
	}
	for _, name := range requiredFiles {
		if _, ok := seen[name]; !ok {
			return fmt.Errorf("required frontend file %q is missing", name)
		}
	}
	return nil
}

func Pack(root, application, gitSHA string, output io.Writer, limits Limits) (Manifest, error) {
	if !validName(application) {
		return Manifest{}, fmt.Errorf("invalid application %q", application)
	}
	if !isLowerHex(gitSHA, 40) {
		return Manifest{}, errors.New("git SHA must be forty lowercase hexadecimal characters")
	}
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return Manifest{}, fmt.Errorf("inspect frontend root: %w", err)
	}
	if !rootInfo.IsDir() {
		return Manifest{}, errors.New("frontend root must be a directory")
	}
	rootDirectory, err := openRootDirectory(root, rootInfo)
	if err != nil {
		return Manifest{}, err
	}
	defer rootDirectory.Close()

	var names []string
	err = filepath.WalkDir(root, func(filePath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if filePath == root {
			return nil
		}
		relative, err := filepath.Rel(root, filePath)
		if err != nil {
			return err
		}
		logical := filepath.ToSlash(relative)
		if err := validatePath(logical); err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("frontend source contains symlink %q", logical)
		}
		if entry.IsDir() {
			return nil
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("frontend source contains non-regular file %q", logical)
		}
		if info.Mode().Perm()&0o111 != 0 {
			return fmt.Errorf("frontend source contains executable file %q", logical)
		}
		if info.Size() > limits.MaxFileBytes {
			return fmt.Errorf("frontend file %q exceeds %d bytes", logical, limits.MaxFileBytes)
		}
		names = append(names, logical)
		return nil
	})
	if err != nil {
		return Manifest{}, fmt.Errorf("enumerate frontend: %w", err)
	}
	sort.Strings(names)
	if len(names) == 0 || len(names) > limits.MaxFiles {
		return Manifest{}, fmt.Errorf("frontend file count %d is outside 1..%d", len(names), limits.MaxFiles)
	}
	for index := 1; index < len(names); index++ {
		if strings.EqualFold(names[index-1], names[index]) {
			return Manifest{}, fmt.Errorf("case-colliding frontend paths %q and %q", names[index-1], names[index])
		}
	}

	writer := tar.NewWriter(output)
	manifest := Manifest{SchemaVersion: SchemaVersion, App: application, GitSHA: gitSHA, ArchiveProfile: ArchiveProfile}
	var total int64
	archiveLength := int64(1024)
	for _, logical := range names {
		file, err := openRegularBeneath(rootDirectory, logical)
		if err != nil {
			_ = writer.Close()
			return Manifest{}, fmt.Errorf("open %q: %w", logical, err)
		}
		info, err := file.Stat()
		if err != nil {
			file.Close()
			_ = writer.Close()
			return Manifest{}, err
		}
		if !info.Mode().IsRegular() || info.Mode().Perm()&0o111 != 0 {
			file.Close()
			_ = writer.Close()
			return Manifest{}, fmt.Errorf("frontend source changed type or executable mode at %q", logical)
		}
		if info.Size() > limits.MaxFileBytes {
			file.Close()
			_ = writer.Close()
			return Manifest{}, fmt.Errorf("frontend file %q exceeds %d bytes", logical, limits.MaxFileBytes)
		}
		archiveLength += 512 + paddedLength(info.Size())
		if archiveLength > limits.MaxArchiveBytes {
			file.Close()
			_ = writer.Close()
			return Manifest{}, fmt.Errorf("canonical frontend archive exceeds %d bytes", limits.MaxArchiveBytes)
		}
		total += info.Size()
		if total > limits.MaxTotalBytes {
			file.Close()
			_ = writer.Close()
			return Manifest{}, fmt.Errorf("frontend total size exceeds %d", limits.MaxTotalBytes)
		}
		header := &tar.Header{
			Name: logical, Mode: 0o644, Size: info.Size(), Typeflag: tar.TypeReg,
			Uid: 0, Gid: 0, Uname: "", Gname: "", ModTime: time.Unix(0, 0).UTC(), Format: tar.FormatUSTAR,
		}
		if err := writer.WriteHeader(header); err != nil {
			file.Close()
			_ = writer.Close()
			return Manifest{}, fmt.Errorf("write USTAR header for %q: %w", logical, err)
		}
		hash := sha256.New()
		written, err := io.Copy(io.MultiWriter(writer, hash), file)
		closeErr := file.Close()
		if err != nil || closeErr != nil {
			_ = writer.Close()
			return Manifest{}, errors.Join(err, closeErr)
		}
		if written != info.Size() {
			_ = writer.Close()
			return Manifest{}, fmt.Errorf("file %q changed during packaging", logical)
		}
		manifest.Files = append(manifest.Files, Entry{
			Path: logical, Length: written, SHA256: hex.EncodeToString(hash.Sum(nil)), Mode: 0o644,
		})
		manifest.TotalSizeBytes += written
	}
	if err := writer.Close(); err != nil {
		return Manifest{}, fmt.Errorf("close USTAR archive: %w", err)
	}
	manifest.FileCount = len(manifest.Files)
	if err := manifest.Validate(limits); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func Extract(input io.Reader, manifest Manifest, destination string, limits Limits) (err error) {
	if err := manifest.Validate(limits); err != nil {
		return err
	}
	if _, err := os.Lstat(destination); err == nil {
		return fmt.Errorf("destination %q already exists", destination)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	parent := filepath.Dir(destination)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return err
	}
	temporary, err := os.MkdirTemp(parent, ".hid-frontend-extract-")
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			err = errors.Join(err, os.RemoveAll(temporary))
		}
	}()

	reader := tar.NewReader(input)
	seenFolded := map[string]string{}
	var total int64
	index := 0
	previous := ""
	for {
		header, readErr := reader.Next()
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return fmt.Errorf("read USTAR header: %w", readErr)
		}
		if index >= len(manifest.Files) || index >= limits.MaxFiles {
			return errors.New("archive contains more files than its manifest or configured limit")
		}
		if err := validateArchiveHeader(header); err != nil {
			return err
		}
		if index > 0 && header.Name <= previous {
			return fmt.Errorf("archive paths are not uniquely sorted at %q", header.Name)
		}
		previous = header.Name
		folded := strings.ToLower(header.Name)
		if prior, ok := seenFolded[folded]; ok {
			return fmt.Errorf("archive paths %q and %q collide", prior, header.Name)
		}
		seenFolded[folded] = header.Name
		expected := manifest.Files[index]
		if header.Name != expected.Path || header.Size != expected.Length {
			return fmt.Errorf("archive entry %d does not match manifest", index)
		}
		if header.Size > limits.MaxFileBytes {
			return fmt.Errorf("archive entry %q exceeds per-file limit", header.Name)
		}
		total += header.Size
		if total > limits.MaxTotalBytes {
			return errors.New("archive exceeds total-size limit")
		}
		outputPath := filepath.Join(temporary, filepath.FromSlash(header.Name))
		if !within(temporary, outputPath) {
			return fmt.Errorf("archive path %q escapes destination", header.Name)
		}
		if err := os.MkdirAll(filepath.Dir(outputPath), 0o700); err != nil {
			return err
		}
		file, err := os.OpenFile(outputPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return fmt.Errorf("create extracted file %q: %w", header.Name, err)
		}
		hash := sha256.New()
		written, copyErr := io.CopyN(io.MultiWriter(file, hash), reader, header.Size)
		closeErr := file.Close()
		if copyErr != nil || closeErr != nil {
			return errors.Join(copyErr, closeErr)
		}
		if written != header.Size || hex.EncodeToString(hash.Sum(nil)) != expected.SHA256 {
			return fmt.Errorf("archive entry %q failed length/hash verification", header.Name)
		}
		if err := os.Chmod(outputPath, 0o644); err != nil {
			return err
		}
		index++
	}
	var trailing [1]byte
	if count, readErr := input.Read(trailing[:]); count != 0 || !errors.Is(readErr, io.EOF) {
		return errors.New("archive contains data after the canonical two-block end marker")
	}
	if index != len(manifest.Files) {
		return fmt.Errorf("archive contains %d files; manifest requires %d", index, len(manifest.Files))
	}
	if err := chmodDirectories(temporary); err != nil {
		return err
	}
	if err := unix.Renameat2(unix.AT_FDCWD, temporary, unix.AT_FDCWD, destination, unix.RENAME_NOREPLACE); err != nil {
		return fmt.Errorf("commit extracted frontend: %w", err)
	}
	return nil
}

func validateArchiveHeader(header *tar.Header) error {
	if err := validatePath(header.Name); err != nil {
		return err
	}
	if header.Format != tar.FormatUSTAR {
		return fmt.Errorf("archive entry %q is not encoded as USTAR", header.Name)
	}
	if header.Typeflag != tar.TypeReg {
		return fmt.Errorf("archive entry %q is not a regular file", header.Name)
	}
	if header.Mode != 0o644 || header.Uid != 0 || header.Gid != 0 || header.Uname != "" || header.Gname != "" {
		return fmt.Errorf("archive entry %q has non-canonical ownership or mode", header.Name)
	}
	if header.Linkname != "" || header.Devmajor != 0 || header.Devminor != 0 || !header.AccessTime.IsZero() || !header.ChangeTime.IsZero() {
		return fmt.Errorf("archive entry %q contains non-canonical auxiliary metadata", header.Name)
	}
	if !header.ModTime.Equal(time.Unix(0, 0).UTC()) {
		return fmt.Errorf("archive entry %q has non-canonical modification time", header.Name)
	}
	if len(header.PAXRecords) != 0 || len(header.Xattrs) != 0 {
		return fmt.Errorf("archive entry %q contains extended metadata", header.Name)
	}
	return nil
}

func validatePath(value string) error {
	if value == "" || len(value) > 240 || value != path.Clean(value) || strings.HasPrefix(value, "/") || strings.Contains(value, "\\") || strings.ContainsRune(value, 0) {
		return fmt.Errorf("unsafe frontend path %q", value)
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return fmt.Errorf("unsafe frontend path %q", value)
		}
	}
	for _, character := range value {
		if character > 0x7f || !(character == '/' || character == '.' || character == '-' || character == '_' ||
			character >= '0' && character <= '9' || character >= 'A' && character <= 'Z' || character >= 'a' && character <= 'z') {
			return fmt.Errorf("frontend path %q is outside the portable ASCII allowlist", value)
		}
	}
	return nil
}

func within(root, candidate string) bool {
	relative, err := filepath.Rel(root, candidate)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

func openRootDirectory(root string, expected os.FileInfo) (*os.File, error) {
	fileDescriptor, err := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, fmt.Errorf("open frontend root without following links: %w", err)
	}
	directory := os.NewFile(uintptr(fileDescriptor), root)
	if directory == nil {
		_ = unix.Close(fileDescriptor)
		return nil, errors.New("wrap frontend root descriptor")
	}
	actual, err := directory.Stat()
	if err != nil || !actual.IsDir() || !os.SameFile(expected, actual) {
		_ = directory.Close()
		if err != nil {
			return nil, err
		}
		return nil, errors.New("frontend root changed while it was being opened")
	}
	return directory, nil
}

func openRegularBeneath(root *os.File, logical string) (*os.File, error) {
	segments := strings.Split(logical, "/")
	current, err := unix.Dup(int(root.Fd()))
	if err != nil {
		return nil, err
	}
	unix.CloseOnExec(current)
	for _, segment := range segments[:len(segments)-1] {
		next, openErr := unix.Openat(current, segment, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
		_ = unix.Close(current)
		if openErr != nil {
			return nil, openErr
		}
		current = next
	}
	fileDescriptor, openErr := unix.Openat(current, segments[len(segments)-1], unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	_ = unix.Close(current)
	if openErr != nil {
		return nil, openErr
	}
	file := os.NewFile(uintptr(fileDescriptor), logical)
	if file == nil {
		_ = unix.Close(fileDescriptor)
		return nil, errors.New("wrap frontend file descriptor")
	}
	return file, nil
}

func chmodDirectories(root string) error {
	return filepath.WalkDir(root, func(filePath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return os.Chmod(filePath, 0o755)
		}
		return nil
	})
}

func isLowerHex(value string, length int) bool {
	if len(value) != length {
		return false
	}
	for _, character := range value {
		if !(character >= '0' && character <= '9' || character >= 'a' && character <= 'f') {
			return false
		}
	}
	return true
}

func canonicalArchiveLength(entries []Entry) int64 {
	total := int64(1024)
	for _, entry := range entries {
		total += 512 + paddedLength(entry.Length)
	}
	return total
}

func paddedLength(length int64) int64 {
	return (length + 511) / 512 * 512
}

func validName(value string) bool {
	if value == "" || len(value) > 32 {
		return false
	}
	for _, character := range value {
		if !(character >= 'a' && character <= 'z' || character >= '0' && character <= '9' || character == '-') {
			return false
		}
	}
	return true
}
