package tufclient

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/theupdateframework/go-tuf/v2/metadata"
	"github.com/theupdateframework/go-tuf/v2/metadata/config"
	"github.com/theupdateframework/go-tuf/v2/metadata/updater"
	"golang.org/x/sys/unix"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/strictjson"
)

const (
	markerSchema      = "1.0.0"
	maxSafeTUFVersion = int64(1<<53 - 1)
)

var (
	environments   = map[string]struct{}{"staging": {}, "production": {}}
	releasePattern = regexp.MustCompile(`^r[0-9]{10}-g[a-f0-9]{40}$`)
)

type Config struct {
	Environment       string
	RepositoryID      string
	MetadataURL       string
	TargetsURL        string
	TrustedRootPath   string
	TrustedRootSHA256 string
	StateDir          string
	MaxTargetBytes    int64
	AllowUnsafeHTTP   bool
	HTTPClient        *http.Client
}

type RoleState struct {
	Version int64     `json:"version"`
	Expires time.Time `json:"expires"`
}

type State struct {
	Root      RoleState `json:"root"`
	Targets   RoleState `json:"targets"`
	Snapshot  RoleState `json:"snapshot"`
	Timestamp RoleState `json:"timestamp"`
}

type Client struct {
	configuration Config
	updater       *updater.Updater
	lock          *os.File
	marker        stateMarker
	refreshed     bool
}

type stateMarker struct {
	SchemaVersion       string `json:"schema_version"`
	Environment         string `json:"environment"`
	RepositoryID        string `json:"repository_id"`
	BootstrapRootSHA256 string `json:"bootstrap_root_sha256"`
	TrustedRootVersion  int64  `json:"trusted_root_version"`
	TrustedRootSHA256   string `json:"trusted_root_sha256"`
	MetadataURL         string `json:"metadata_url"`
	TargetsURL          string `json:"targets_url"`
}

func Open(configuration Config) (*Client, error) {
	if err := validateConfig(&configuration); err != nil {
		return nil, err
	}
	root, err := readRegularFile(configuration.TrustedRootPath, 512_000)
	if err != nil {
		return nil, fmt.Errorf("read trusted root: %w", err)
	}
	digest := sha256.Sum256(root)
	if hex.EncodeToString(digest[:]) != configuration.TrustedRootSHA256 {
		return nil, errors.New("trusted root SHA-256 does not match the out-of-band pin")
	}
	bootstrapRoot, err := metadata.Root().FromBytes(root)
	if err != nil {
		return nil, fmt.Errorf("parse pinned bootstrap root: %w", err)
	}
	if !isSafeTUFVersion(bootstrapRoot.Signed.Version) {
		return nil, errors.New("pinned bootstrap root version must be a positive safe integer")
	}
	if err := ensurePrivateStateDir(configuration.StateDir); err != nil {
		return nil, err
	}
	resolvedStateDir, err := filepath.EvalSymlinks(configuration.StateDir)
	if err != nil {
		return nil, fmt.Errorf("resolve durable state directory: %w", err)
	}
	configuration.StateDir = resolvedStateDir
	lockPath := filepath.Join(configuration.StateDir, ".lock")
	lock, err := openStateLock(lockPath)
	if err != nil {
		return nil, fmt.Errorf("open client-state lock: %w", err)
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lock.Close()
		return nil, errors.New("another HID TUF client is using this state directory")
	}
	closeOnError := func(value error) (*Client, error) {
		_ = syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
		_ = lock.Close()
		return nil, value
	}

	expectedMarker := stateMarker{
		SchemaVersion: markerSchema, Environment: configuration.Environment,
		RepositoryID: configuration.RepositoryID, BootstrapRootSHA256: configuration.TrustedRootSHA256,
		TrustedRootVersion: bootstrapRoot.Signed.Version, TrustedRootSHA256: configuration.TrustedRootSHA256,
		MetadataURL: configuration.MetadataURL, TargetsURL: configuration.TargetsURL,
	}
	marker, err := verifyOrCreateMarker(configuration.StateDir, expectedMarker)
	if err != nil {
		return closeOnError(err)
	}
	metadataDir := filepath.Join(configuration.StateDir, "metadata")
	targetsDir := filepath.Join(configuration.StateDir, "targets")
	for _, directory := range []string{metadataDir, targetsDir} {
		if err := ensurePrivateStateDir(directory); err != nil {
			return closeOnError(err)
		}
	}
	trustedRoot := root
	cachedRootPath := filepath.Join(metadataDir, "root.json")
	cachedRoot, cachedErr := readRegularFile(cachedRootPath, 512_000)
	if cachedErr == nil {
		cachedDigest := sha256.Sum256(cachedRoot)
		if hex.EncodeToString(cachedDigest[:]) != marker.TrustedRootSHA256 {
			return closeOnError(errors.New("cached trusted root does not match the durable root-state pin"))
		}
		parsedCachedRoot, parseErr := metadata.Root().FromBytes(cachedRoot)
		if parseErr != nil {
			return closeOnError(fmt.Errorf("parse cached trusted root: %w", parseErr))
		}
		if parsedCachedRoot.Signed.Version != marker.TrustedRootVersion {
			return closeOnError(errors.New("cached trusted root version does not match the durable root-state pin"))
		}
		trustedRoot = cachedRoot
	} else if !errors.Is(cachedErr, os.ErrNotExist) {
		return closeOnError(fmt.Errorf("read cached trusted root: %w", cachedErr))
	} else if marker.TrustedRootVersion != bootstrapRoot.Signed.Version || marker.TrustedRootSHA256 != configuration.TrustedRootSHA256 {
		return closeOnError(errors.New("durable root-state pin exists but cached trusted root is missing"))
	}

	updaterConfig, err := config.New(configuration.MetadataURL, trustedRoot)
	if err != nil {
		return closeOnError(err)
	}
	updaterConfig.LocalMetadataDir = metadataDir
	updaterConfig.LocalTargetsDir = targetsDir
	updaterConfig.RemoteTargetsURL = configuration.TargetsURL
	updaterConfig.PrefixTargetsWithHash = true
	updaterConfig.MaxRootRotations = 64
	updaterConfig.MaxDelegations = 8
	updaterConfig.RootMaxLength = 512_000
	updaterConfig.TimestampMaxLength = 64_000
	updaterConfig.SnapshotMaxLength = 2_000_000
	updaterConfig.TargetsMaxLength = 5_000_000
	if err := updaterConfig.SetDefaultFetcherHTTPClient(configuration.HTTPClient); err != nil {
		return closeOnError(err)
	}
	if err := updaterConfig.SetDefaultFetcherRetry(250*time.Millisecond, 2); err != nil {
		return closeOnError(err)
	}
	up, err := updater.New(updaterConfig)
	if err != nil {
		return closeOnError(fmt.Errorf("initialize pinned-root updater: %w", err))
	}
	return &Client{configuration: configuration, updater: up, lock: lock, marker: marker}, nil
}

func openStateLock(lockPath string) (*os.File, error) {
	fileDescriptor, err := unix.Open(lockPath, unix.O_CREAT|unix.O_RDWR|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fileDescriptor), lockPath)
	if file == nil {
		_ = unix.Close(fileDescriptor)
		return nil, errors.New("wrap client-state lock descriptor")
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		file.Close()
		return nil, errors.New("client-state lock must be a private regular file")
	}
	return file, nil
}

func (client *Client) Close() error {
	if client.lock == nil {
		return nil
	}
	err := syscall.Flock(int(client.lock.Fd()), syscall.LOCK_UN)
	err = errors.Join(err, client.lock.Close())
	client.lock = nil
	return err
}

func (client *Client) Refresh() (State, error) {
	if client.refreshed {
		return State{}, errors.New("refresh may run only once per client invocation")
	}
	client.refreshed = true
	refreshErr := client.updater.Refresh()
	durabilityErr := client.persistTrustedRootState()
	if durabilityErr != nil {
		return State{}, fmt.Errorf("persist trusted TUF root state: %w", durabilityErr)
	}
	if refreshErr != nil {
		return State{}, fmt.Errorf("TUF refresh failed closed: %w", refreshErr)
	}
	trusted := client.updater.GetTrustedMetadataSet()
	if trusted.Root == nil || trusted.Targets[metadata.TARGETS] == nil || trusted.Snapshot == nil || trusted.Timestamp == nil {
		return State{}, errors.New("TUF refresh returned incomplete top-level metadata")
	}
	for role, version := range map[string]int64{
		metadata.ROOT:      trusted.Root.Signed.Version,
		metadata.TARGETS:   trusted.Targets[metadata.TARGETS].Signed.Version,
		metadata.SNAPSHOT:  trusted.Snapshot.Signed.Version,
		metadata.TIMESTAMP: trusted.Timestamp.Signed.Version,
	} {
		if !isSafeTUFVersion(version) {
			return State{}, fmt.Errorf("trusted %s version is outside the positive safe integer range", role)
		}
	}
	return State{
		Root:      roleState(trusted.Root.Signed.Version, trusted.Root.Signed.Expires),
		Targets:   roleState(trusted.Targets[metadata.TARGETS].Signed.Version, trusted.Targets[metadata.TARGETS].Signed.Expires),
		Snapshot:  roleState(trusted.Snapshot.Signed.Version, trusted.Snapshot.Signed.Expires),
		Timestamp: roleState(trusted.Timestamp.Signed.Version, trusted.Timestamp.Signed.Expires),
	}, nil
}

func (client *Client) DownloadReleaseTarget(releaseID, targetPath, destination string) error {
	if err := validateTargetPath(client.configuration.Environment, releaseID, targetPath); err != nil {
		return err
	}
	canonicalDestination, err := client.validateDestination(destination)
	if err != nil {
		return err
	}
	if !client.refreshed {
		if _, err := client.Refresh(); err != nil {
			return err
		}
	}
	info, err := client.updater.GetTargetInfo(targetPath)
	if err != nil {
		return fmt.Errorf("resolve verified target %q: %w", targetPath, err)
	}
	if info.Length < 0 || info.Length > client.configuration.MaxTargetBytes {
		return fmt.Errorf("target %q length %d exceeds configured limit", targetPath, info.Length)
	}
	return client.downloadVerifiedTarget(info, targetPath, canonicalDestination)
}

func (client *Client) validateDestination(destination string) (string, error) {
	if destination == "" || strings.ContainsRune(destination, 0) {
		return "", errors.New("destination path is invalid")
	}
	canonical, err := filepath.Abs(destination)
	if err != nil {
		return "", err
	}
	canonical = filepath.Clean(canonical)
	if err := rejectSymlinkAncestors(filepath.Dir(canonical)); err != nil {
		return "", fmt.Errorf("destination parent is unsafe: %w", err)
	}
	if withinFilesystemPath(client.configuration.StateDir, canonical) {
		return "", fmt.Errorf("destination %q overlaps private TUF client state", destination)
	}
	if _, err := os.Lstat(canonical); err == nil {
		return "", fmt.Errorf("destination %q already exists", destination)
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	return canonical, nil
}

func rejectSymlinkAncestors(directory string) error {
	volume := filepath.VolumeName(directory)
	root := volume + string(filepath.Separator)
	relative := strings.TrimPrefix(directory, root)
	current := root
	for _, segment := range strings.Split(relative, string(filepath.Separator)) {
		if segment == "" {
			continue
		}
		current = filepath.Join(current, segment)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("path component %q is a symlink", current)
		}
		if !info.IsDir() {
			return fmt.Errorf("path component %q is not a directory", current)
		}
	}
	return nil
}

func (client *Client) downloadVerifiedTarget(info *metadata.TargetFiles, targetPath, destination string) error {
	if _, err := os.Lstat(destination); err == nil {
		return fmt.Errorf("destination %q already exists", destination)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	parent := filepath.Dir(destination)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return err
	}
	cacheFile, err := os.CreateTemp(filepath.Join(client.configuration.StateDir, "targets"), ".hid-tuf-download-")
	if err != nil {
		return err
	}
	cachePath := cacheFile.Name()
	if err := cacheFile.Close(); err != nil {
		_ = os.Remove(cachePath)
		return err
	}
	if err := os.Remove(cachePath); err != nil {
		return err
	}
	defer os.Remove(cachePath)
	_, verifiedBytes, err := client.updater.DownloadTarget(info, cachePath, "")
	if err != nil {
		return fmt.Errorf("download/verify target %q: %w", targetPath, err)
	}
	if int64(len(verifiedBytes)) != info.Length {
		return errors.New("verified target length changed after download")
	}
	temporary, err := os.CreateTemp(parent, ".hid-tuf-target-")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	writeErr := writeAll(temporary, verifiedBytes)
	err = errors.Join(writeErr, temporary.Sync(), temporary.Close())
	if err != nil {
		return err
	}
	if err := os.Link(temporaryPath, destination); err != nil {
		return fmt.Errorf("atomically commit verified target: %w", err)
	}
	if err := syncDirectory(parent); err != nil {
		return err
	}
	return nil
}

func (client *Client) persistTrustedRootState() error {
	trusted := client.updater.GetTrustedMetadataSet()
	if trusted.Root == nil {
		return errors.New("updater has no trusted root to checkpoint")
	}
	metadataDir := filepath.Join(client.configuration.StateDir, "metadata")
	rootBytes, err := readRegularFile(filepath.Join(metadataDir, "root.json"), 512_000)
	if err != nil {
		return fmt.Errorf("read persisted trusted root: %w", err)
	}
	parsedRoot, err := metadata.Root().FromBytes(rootBytes)
	if err != nil {
		return fmt.Errorf("parse persisted trusted root: %w", err)
	}
	if parsedRoot.Signed.Version != trusted.Root.Signed.Version {
		return errors.New("persisted and in-memory trusted root versions differ")
	}
	if !isSafeTUFVersion(parsedRoot.Signed.Version) {
		return errors.New("persisted trusted root version is outside the positive safe integer range")
	}
	digest := sha256.Sum256(rootBytes)
	digestHex := hex.EncodeToString(digest[:])
	if parsedRoot.Signed.Version < client.marker.TrustedRootVersion {
		return errors.New("trusted root checkpoint would roll back")
	}
	if parsedRoot.Signed.Version == client.marker.TrustedRootVersion && digestHex != client.marker.TrustedRootSHA256 {
		return errors.New("trusted root bytes changed without a version increase")
	}
	if err := syncTrustedMetadata(metadataDir); err != nil {
		return err
	}
	if parsedRoot.Signed.Version > client.marker.TrustedRootVersion {
		client.marker.TrustedRootVersion = parsedRoot.Signed.Version
		client.marker.TrustedRootSHA256 = digestHex
		encoded, err := json.MarshalIndent(client.marker, "", "  ")
		if err != nil {
			return err
		}
		if err := atomicWrite(filepath.Join(client.configuration.StateDir, "state.json"), append(encoded, '\n'), 0o600); err != nil {
			return err
		}
	}
	return nil
}

func syncTrustedMetadata(directory string) error {
	for _, name := range []string{"root.json", "timestamp.json", "snapshot.json", "targets.json"} {
		file, err := os.Open(filepath.Join(directory, name))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		info, statErr := file.Stat()
		if statErr != nil || !info.Mode().IsRegular() {
			_ = file.Close()
			if statErr != nil {
				return statErr
			}
			return fmt.Errorf("trusted metadata %q is not a regular file", name)
		}
		syncErr := file.Sync()
		closeErr := file.Close()
		if err := errors.Join(syncErr, closeErr); err != nil {
			return err
		}
	}
	return syncDirectory(directory)
}

func DefaultHTTPClient() *http.Client {
	dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	return &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			Proxy: http.ProxyFromEnvironment, DialContext: dialer.DialContext,
			ForceAttemptHTTP2: true, TLSHandshakeTimeout: 5 * time.Second,
			ResponseHeaderTimeout: 10 * time.Second, IdleConnTimeout: 30 * time.Second,
		},
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return errors.New("TUF repository redirects are forbidden")
		},
	}
}

func validateConfig(configuration *Config) error {
	if _, ok := environments[configuration.Environment]; !ok {
		return errors.New("environment must be staging or production")
	}
	if !validIdentifier(configuration.RepositoryID, 64) {
		return errors.New("repository ID is invalid")
	}
	if !isLowerHex(configuration.TrustedRootSHA256, 64) {
		return errors.New("trusted root pin must be 64 lowercase hexadecimal characters")
	}
	if configuration.TrustedRootPath == "" || configuration.StateDir == "" {
		return errors.New("trusted root path and durable state directory are required")
	}
	trustedRootPath, err := filepath.Abs(configuration.TrustedRootPath)
	if err != nil {
		return fmt.Errorf("resolve trusted root path: %w", err)
	}
	stateDir, err := filepath.Abs(configuration.StateDir)
	if err != nil {
		return fmt.Errorf("resolve durable state path: %w", err)
	}
	configuration.TrustedRootPath = filepath.Clean(trustedRootPath)
	configuration.StateDir = filepath.Clean(stateDir)
	metadataURL, err := validateBaseURL(configuration.MetadataURL, configuration.AllowUnsafeHTTP)
	if err != nil {
		return fmt.Errorf("metadata URL: %w", err)
	}
	targetsURL, err := validateBaseURL(configuration.TargetsURL, configuration.AllowUnsafeHTTP)
	if err != nil {
		return fmt.Errorf("targets URL: %w", err)
	}
	if metadataURL.Scheme != targetsURL.Scheme || metadataURL.Host != targetsURL.Host {
		return errors.New("metadata and targets must use the same exact origin")
	}
	configuration.MetadataURL = strings.TrimSuffix(configuration.MetadataURL, "/")
	configuration.TargetsURL = strings.TrimSuffix(configuration.TargetsURL, "/")
	if configuration.MaxTargetBytes == 0 {
		configuration.MaxTargetBytes = 25 << 20
	}
	if configuration.MaxTargetBytes < 1 || configuration.MaxTargetBytes > 25<<20 {
		return errors.New("maximum target size is outside the Cloudflare-compatible range 1..26214400 bytes")
	}
	if configuration.HTTPClient == nil {
		configuration.HTTPClient = DefaultHTTPClient()
	}
	configuration.HTTPClient = invocationHTTPClient(configuration.HTTPClient, time.Now().Add(60*time.Second))
	return nil
}

func validateBaseURL(value string, allowHTTP bool) (*url.URL, error) {
	parsed, err := url.Parse(value)
	if err != nil {
		return nil, err
	}
	if parsed.Scheme != "https" && !(allowHTTP && parsed.Scheme == "http") {
		return nil, errors.New("HTTPS is required")
	}
	if parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("URL must have an exact origin/path and no credentials, query, or fragment")
	}
	if strings.Contains(parsed.Path, "//") || path.Clean(parsed.Path) != parsed.Path {
		return nil, errors.New("URL path is not canonical")
	}
	return parsed, nil
}

func validateTargetPath(environment, releaseID, value string) error {
	if !releasePattern.MatchString(releaseID) {
		return errors.New("release ID is invalid")
	}
	if value == "" || len(value) > 512 || value != path.Clean(value) || strings.HasPrefix(value, "/") || strings.Contains(value, "\\") || strings.ContainsRune(value, 0) {
		return errors.New("target path is unsafe")
	}
	for _, character := range value {
		if !(character == '/' || character == '.' || character == '-' || character == '_' ||
			character >= '0' && character <= '9' || character >= 'a' && character <= 'z') {
			return errors.New("target path is outside the portable lowercase ASCII allowlist")
		}
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return errors.New("target path contains an unsafe segment")
		}
	}
	prefix := "environments/" + environment + "/releases/" + releaseID + "/"
	if !strings.HasPrefix(value, prefix) || value == prefix {
		return fmt.Errorf("target path must remain below %q", prefix)
	}
	return nil
}

func verifyOrCreateMarker(stateDir string, expected stateMarker) (stateMarker, error) {
	markerPath := filepath.Join(stateDir, "state.json")
	data, err := readRegularFile(markerPath, 16_384)
	if errors.Is(err, os.ErrNotExist) {
		entries, readErr := os.ReadDir(stateDir)
		if readErr != nil {
			return stateMarker{}, readErr
		}
		for _, entry := range entries {
			if entry.Name() != ".lock" {
				return stateMarker{}, errors.New("state directory is nonempty but has no trusted state marker; refusing silent rebootstrap")
			}
		}
		encoded, marshalErr := json.MarshalIndent(expected, "", "  ")
		if marshalErr != nil {
			return stateMarker{}, marshalErr
		}
		encoded = append(encoded, '\n')
		if writeErr := atomicWrite(markerPath, encoded, 0o600); writeErr != nil {
			return stateMarker{}, writeErr
		}
		return expected, nil
	}
	if err != nil {
		return stateMarker{}, err
	}
	var actual stateMarker
	if err := strictjson.Decode(data, &actual); err != nil {
		return stateMarker{}, fmt.Errorf("decode state marker: %w", err)
	}
	if actual.SchemaVersion != expected.SchemaVersion || actual.Environment != expected.Environment ||
		actual.RepositoryID != expected.RepositoryID || actual.BootstrapRootSHA256 != expected.BootstrapRootSHA256 ||
		actual.MetadataURL != expected.MetadataURL || actual.TargetsURL != expected.TargetsURL {
		return stateMarker{}, errors.New("state marker does not match repository, environment, origin, or bootstrap-root pin")
	}
	if actual.TrustedRootVersion < expected.TrustedRootVersion || !isSafeTUFVersion(actual.TrustedRootVersion) || !isLowerHex(actual.TrustedRootSHA256, 64) {
		return stateMarker{}, errors.New("state marker has an invalid trusted-root checkpoint")
	}
	return actual, nil
}

func ensurePrivateStateDir(directory string) error {
	info, err := os.Lstat(directory)
	if errors.Is(err, os.ErrNotExist) {
		return os.MkdirAll(directory, 0o700)
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("client state path must be a real directory")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return errors.New("client state directory must not grant group or other permissions")
	}
	return nil
}

func readRegularFile(filePath string, maximum int64) ([]byte, error) {
	if maximum < 0 {
		return nil, errors.New("maximum regular-file size must not be negative")
	}
	fileDescriptor, err := unix.Open(filePath, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fileDescriptor), filePath)
	if file == nil {
		_ = unix.Close(fileDescriptor)
		return nil, errors.New("wrap bounded regular-file descriptor")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > maximum {
		return nil, errors.New("path is not a bounded regular file")
	}
	data, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maximum {
		return nil, errors.New("regular file grew beyond its configured bound while being read")
	}
	return data, nil
}

func atomicWrite(filePath string, data []byte, mode os.FileMode) error {
	file, err := os.CreateTemp(filepath.Dir(filePath), ".hid-tuf-state-")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if err := file.Chmod(mode); err != nil {
		file.Close()
		return err
	}
	if err := writeAll(file, data); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporary, filePath); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(filePath))
}

func writeAll(output io.Writer, data []byte) error {
	written, err := io.Copy(output, bytes.NewReader(data))
	if err != nil {
		return err
	}
	if written != int64(len(data)) {
		return io.ErrShortWrite
	}
	return nil
}

func syncDirectory(directory string) error {
	file, err := os.Open(directory)
	if err != nil {
		return err
	}
	err = file.Sync()
	return errors.Join(err, file.Close())
}

func roleState(version int64, expires time.Time) RoleState {
	return RoleState{Version: version, Expires: expires.UTC()}
}

func isSafeTUFVersion(version int64) bool {
	return version >= 1 && version <= maxSafeTUFVersion
}

func validIdentifier(value string, maximum int) bool {
	if value == "" || len(value) > maximum {
		return false
	}
	for _, character := range value {
		if !(character >= 'a' && character <= 'z' || character >= '0' && character <= '9' || character == '-') {
			return false
		}
	}
	return true
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

type deadlineRoundTripper struct {
	base     http.RoundTripper
	deadline time.Time
}

func (transport deadlineRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	requestContext, cancel := context.WithDeadline(request.Context(), transport.deadline)
	response, err := transport.base.RoundTrip(request.Clone(requestContext))
	if err != nil {
		cancel()
		return nil, err
	}
	if response.Body == nil {
		cancel()
		return response, nil
	}
	response.Body = &cancelReadCloser{ReadCloser: response.Body, cancel: cancel}
	return response, nil
}

type cancelReadCloser struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (body *cancelReadCloser) Read(buffer []byte) (int, error) {
	count, err := body.ReadCloser.Read(buffer)
	if err != nil {
		body.cancel()
	}
	return count, err
}

func (body *cancelReadCloser) Close() error {
	err := body.ReadCloser.Close()
	body.cancel()
	return err
}

func invocationHTTPClient(source *http.Client, deadline time.Time) *http.Client {
	client := *source
	base := client.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	client.Transport = deadlineRoundTripper{base: base, deadline: deadline}
	if client.Timeout <= 0 || client.Timeout > 30*time.Second {
		client.Timeout = 30 * time.Second
	}
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return errors.New("TUF repository redirects are forbidden")
	}
	return &client
}
