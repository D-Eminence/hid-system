package repository

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

func readRegularFile(filePath string, maximum int64) ([]byte, error) {
	file, err := openRegularFile(filePath, maximum)
	if err != nil {
		return nil, err
	}
	data, readErr := io.ReadAll(io.LimitReader(file, maximum+1))
	closeErr := file.Close()
	if readErr != nil || closeErr != nil {
		return nil, errors.Join(readErr, closeErr)
	}
	if int64(len(data)) > maximum {
		return nil, errors.New("regular file grew beyond its configured bound while being read")
	}
	return data, nil
}

func openRegularFile(filePath string, maximum int64) (*os.File, error) {
	if maximum < 0 {
		return nil, errors.New("maximum regular-file size must not be negative")
	}
	absolutePath, err := filepath.Abs(filePath)
	if err != nil {
		return nil, fmt.Errorf("resolve regular-file path: %w", err)
	}
	absolutePath = filepath.Clean(absolutePath)
	segments := strings.Split(strings.TrimPrefix(absolutePath, string(filepath.Separator)), string(filepath.Separator))
	if len(segments) == 0 || segments[len(segments)-1] == "" {
		return nil, errors.New("regular-file path has no leaf component")
	}

	// Resolve every ancestor through a directory descriptor. O_NOFOLLOW on the
	// final pathname component alone is insufficient: an attacker could replace
	// or pre-create an ancestor as a symlink between validation and open. Holding
	// each opened directory descriptor also makes later ancestor renames unable
	// to redirect the leaf lookup.
	directoryDescriptor, err := unix.Open(string(filepath.Separator), unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	for _, segment := range segments[:len(segments)-1] {
		if segment == "" || segment == "." || segment == ".." {
			_ = unix.Close(directoryDescriptor)
			return nil, errors.New("regular-file path contains an unsafe ancestor component")
		}
		nextDescriptor, openErr := unix.Openat(
			directoryDescriptor,
			segment,
			unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW,
			0,
		)
		_ = unix.Close(directoryDescriptor)
		if openErr != nil {
			return nil, openErr
		}
		directoryDescriptor = nextDescriptor
	}
	leaf := segments[len(segments)-1]
	if leaf == "" || leaf == "." || leaf == ".." {
		_ = unix.Close(directoryDescriptor)
		return nil, errors.New("regular-file path contains an unsafe leaf component")
	}
	fileDescriptor, openErr := unix.Openat(
		directoryDescriptor,
		leaf,
		unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK,
		0,
	)
	_ = unix.Close(directoryDescriptor)
	if openErr != nil {
		return nil, openErr
	}
	file := os.NewFile(uintptr(fileDescriptor), absolutePath)
	if file == nil {
		_ = unix.Close(fileDescriptor)
		return nil, errors.New("wrap bounded regular-file descriptor")
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > maximum {
		_ = file.Close()
		return nil, errors.New("path is not a bounded regular file")
	}
	return file, nil
}

// writeExclusiveFile makes the final pathname visible only after all bytes are
// written and fsynced. Every ancestor is resolved through a held no-follow
// directory descriptor, and renameat2 prevents replacement at commit time.
func writeExclusiveFile(filePath string, data []byte, mode os.FileMode) error {
	if filePath == "" || !filepath.IsAbs(filePath) || filepath.Clean(filePath) != filePath {
		return errors.New("exclusive output path must be canonical and absolute")
	}
	parentPath := filepath.Dir(filePath)
	leaf := filepath.Base(filePath)
	if leaf == "" || leaf == "." || leaf == ".." || strings.ContainsRune(leaf, 0) {
		return errors.New("exclusive output path has an unsafe leaf component")
	}
	parentDescriptor, err := openDirectoryNoFollow(parentPath)
	if err != nil {
		return fmt.Errorf("open exclusive output parent: %w", err)
	}
	defer unix.Close(parentDescriptor)

	var temporaryName string
	var fileDescriptor int
	for attempt := 0; attempt < 32; attempt++ {
		random := make([]byte, 16)
		if _, err := rand.Read(random); err != nil {
			return fmt.Errorf("generate exclusive output temporary name: %w", err)
		}
		temporaryName = ".hid-tuf-write-" + hex.EncodeToString(random)
		fileDescriptor, err = unix.Openat(
			parentDescriptor,
			temporaryName,
			unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_CLOEXEC|unix.O_NOFOLLOW,
			uint32(mode.Perm()),
		)
		if err == nil {
			break
		}
		if !errors.Is(err, unix.EEXIST) {
			return fmt.Errorf("create exclusive output temporary file: %w", err)
		}
	}
	if fileDescriptor < 0 {
		return errors.New("could not allocate an exclusive output temporary file")
	}
	committed := false
	defer func() {
		if !committed {
			_ = unix.Unlinkat(parentDescriptor, temporaryName, 0)
		}
	}()
	file := os.NewFile(uintptr(fileDescriptor), filepath.Join(parentPath, temporaryName))
	if file == nil {
		_ = unix.Close(fileDescriptor)
		return errors.New("wrap exclusive output temporary descriptor")
	}
	written, writeErr := io.Copy(file, bytes.NewReader(data))
	if writeErr == nil && written != int64(len(data)) {
		writeErr = io.ErrShortWrite
	}
	if writeErr == nil {
		writeErr = file.Sync()
	}
	closeErr := file.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		return fmt.Errorf("write exclusive output temporary file: %w", err)
	}
	if err := unix.Renameat2(parentDescriptor, temporaryName, parentDescriptor, leaf, unix.RENAME_NOREPLACE); err != nil {
		return fmt.Errorf("commit exclusive output without replacement: %w", err)
	}
	committed = true
	if err := unix.Fsync(parentDescriptor); err != nil {
		return fmt.Errorf("sync exclusive output parent: %w", err)
	}
	return nil
}

func openDirectoryNoFollow(directory string) (int, error) {
	if directory == "" || !filepath.IsAbs(directory) || filepath.Clean(directory) != directory {
		return -1, errors.New("directory path must be canonical and absolute")
	}
	directoryDescriptor, err := unix.Open(
		string(filepath.Separator),
		unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC,
		0,
	)
	if err != nil {
		return -1, err
	}
	segments := strings.Split(strings.TrimPrefix(directory, string(filepath.Separator)), string(filepath.Separator))
	for _, segment := range segments {
		if segment == "" {
			continue
		}
		if segment == "." || segment == ".." {
			_ = unix.Close(directoryDescriptor)
			return -1, errors.New("directory path contains an unsafe component")
		}
		nextDescriptor, openErr := unix.Openat(
			directoryDescriptor,
			segment,
			unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW,
			0,
		)
		_ = unix.Close(directoryDescriptor)
		if openErr != nil {
			return -1, openErr
		}
		directoryDescriptor = nextDescriptor
	}
	return directoryDescriptor, nil
}

func sha256Hex(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}
