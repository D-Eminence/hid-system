package tufclient

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/testrepo"
)

const (
	clientTestSHA = "0123456789abcdef0123456789abcdef01234567"
	releaseID     = "r0000000001-g" + clientTestSHA
)

func TestPinnedRootRefreshAndAtomicDownload(t *testing.T) {
	t.Parallel()
	targetPath := testrepo.TargetPath("staging", releaseID, "release-bundle.json")
	repository := testrepo.New(t, targetPath, []byte(`{"release":"valid"}`), testrepo.Options{})
	server := httptest.NewServer(http.FileServer(http.Dir(repository.PublicDir)))
	defer server.Close()
	configuration := clientConfig(t, repository.Root, server.URL, t.TempDir())
	client, err := Open(configuration)
	if err != nil {
		t.Fatal(err)
	}
	state, err := client.Refresh()
	if err != nil {
		t.Fatal(err)
	}
	if state.Root.Version != 1 || state.Targets.Version != 1 || state.Snapshot.Version != 1 || state.Timestamp.Version != 1 {
		t.Fatalf("unexpected metadata state: %+v", state)
	}
	destination := filepath.Join(t.TempDir(), "verified", "release-bundle.json")
	if err := client.DownloadReleaseTarget(releaseID, targetPath, destination); err != nil {
		t.Fatal(err)
	}
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(destination)
	if err != nil || string(data) != `{"release":"valid"}` {
		t.Fatalf("unexpected verified target: %q, %v", data, err)
	}
	if info, err := os.Stat(destination); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("verified output permissions are not private: %v, %v", info, err)
	}

	client, err = Open(configuration)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if _, err := client.Refresh(); err != nil {
		t.Fatal(err)
	}
	if err := client.DownloadReleaseTarget(releaseID, targetPath, destination); err == nil {
		t.Fatal("client overwrote an existing destination")
	}
}

func TestTargetTamperingAndWrongPathFailClosed(t *testing.T) {
	t.Parallel()
	targetPath := testrepo.TargetPath("staging", releaseID, "release-bundle.json")
	repository := testrepo.New(t, targetPath, []byte("approved"), testrepo.Options{})
	server := httptest.NewServer(http.FileServer(http.Dir(repository.PublicDir)))
	defer server.Close()
	configuration := clientConfig(t, repository.Root, server.URL, t.TempDir())
	client, err := Open(configuration)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if _, err := client.Refresh(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(repository.PhysicalTargetPath(targetPath, []byte("approved")), []byte("modified"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := client.DownloadReleaseTarget(releaseID, targetPath, filepath.Join(t.TempDir(), "target")); err == nil {
		t.Fatal("client accepted a modified target")
	}
	for _, wrong := range []string{
		"../release-bundle.json",
		testrepo.TargetPath("production", releaseID, "release-bundle.json"),
		"environments/staging/releases/r0000000002-g" + clientTestSHA + "/release-bundle.json",
	} {
		if err := client.DownloadReleaseTarget(releaseID, wrong, filepath.Join(t.TempDir(), "target")); err == nil {
			t.Fatalf("client accepted wrong target path %q", wrong)
		}
	}
}

func TestUnavailableTargetAndOversizedTargetFailClosed(t *testing.T) {
	t.Parallel()
	targetPath := testrepo.TargetPath("staging", releaseID, "release-bundle.json")
	repository := testrepo.New(t, targetPath, []byte("approved"), testrepo.Options{})
	server := httptest.NewServer(http.FileServer(http.Dir(repository.PublicDir)))
	defer server.Close()

	t.Run("unavailable", func(t *testing.T) {
		configuration := clientConfig(t, repository.Root, server.URL, t.TempDir())
		client, err := Open(configuration)
		if err != nil {
			t.Fatal(err)
		}
		defer client.Close()
		if _, err := client.Refresh(); err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(repository.PhysicalTargetPath(targetPath, []byte("approved"))); err != nil {
			t.Fatal(err)
		}
		if err := client.DownloadReleaseTarget(releaseID, targetPath, filepath.Join(t.TempDir(), "target")); err == nil {
			t.Fatal("client accepted an unavailable target")
		}
	})

	t.Run("configured-size-bound", func(t *testing.T) {
		configuration := clientConfig(t, repository.Root, server.URL, t.TempDir())
		configuration.MaxTargetBytes = 1
		client, err := Open(configuration)
		if err != nil {
			t.Fatal(err)
		}
		defer client.Close()
		if _, err := client.Refresh(); err != nil {
			t.Fatal(err)
		}
		if err := client.DownloadReleaseTarget(releaseID, targetPath, filepath.Join(t.TempDir(), "target")); err == nil {
			t.Fatal("client accepted a target above the configured bound")
		}
	})
}

func TestMetadataTamperingMissingAndUnavailableFailClosed(t *testing.T) {
	t.Parallel()
	targetPath := testrepo.TargetPath("staging", releaseID, "release-bundle.json")
	t.Run("invalid-signature", func(t *testing.T) {
		repository := testrepo.New(t, targetPath, []byte("approved"), testrepo.Options{})
		filePath := repository.MetadataPath("timestamp.json")
		data, err := os.ReadFile(filePath)
		if err != nil {
			t.Fatal(err)
		}
		modified := strings.Replace(string(data), `"version":1`, `"version":2`, 1)
		if modified == string(data) {
			t.Fatal("test did not modify timestamp metadata")
		}
		if err := os.WriteFile(filePath, []byte(modified), 0o600); err != nil {
			t.Fatal(err)
		}
		server := httptest.NewServer(http.FileServer(http.Dir(repository.PublicDir)))
		defer server.Close()
		client, err := Open(clientConfig(t, repository.Root, server.URL, t.TempDir()))
		if err != nil {
			t.Fatal(err)
		}
		defer client.Close()
		if _, err := client.Refresh(); err == nil {
			t.Fatal("client accepted modified metadata")
		}
	})

	t.Run("missing", func(t *testing.T) {
		repository := testrepo.New(t, targetPath, []byte("approved"), testrepo.Options{})
		if err := os.Remove(repository.MetadataPath("timestamp.json")); err != nil {
			t.Fatal(err)
		}
		server := httptest.NewServer(http.FileServer(http.Dir(repository.PublicDir)))
		defer server.Close()
		client, err := Open(clientConfig(t, repository.Root, server.URL, t.TempDir()))
		if err != nil {
			t.Fatal(err)
		}
		defer client.Close()
		if _, err := client.Refresh(); err == nil {
			t.Fatal("client accepted missing metadata")
		}
	})

	t.Run("unavailable", func(t *testing.T) {
		repository := testrepo.New(t, targetPath, []byte("approved"), testrepo.Options{})
		server := httptest.NewServer(http.FileServer(http.Dir(repository.PublicDir)))
		configuration := clientConfig(t, repository.Root, server.URL, t.TempDir())
		server.Close()
		client, err := Open(configuration)
		if err != nil {
			t.Fatal(err)
		}
		defer client.Close()
		if _, err := client.Refresh(); err == nil {
			t.Fatal("client accepted unavailable repository")
		}
	})
}

func TestEveryExpiredTopLevelRoleFailsClosed(t *testing.T) {
	t.Parallel()
	targetPath := testrepo.TargetPath("staging", releaseID, "release-bundle.json")
	now := time.Now().UTC().Truncate(time.Second)
	tests := []struct {
		name    string
		options testrepo.Options
	}{
		{name: "root", options: testrepo.Options{Now: now, RootExpires: now.Add(-time.Hour)}},
		{name: "targets", options: testrepo.Options{Now: now, TargetsExpires: now.Add(-time.Hour)}},
		{name: "snapshot", options: testrepo.Options{Now: now, SnapshotExpires: now.Add(-time.Hour)}},
		{name: "timestamp", options: testrepo.Options{Now: now, TimestampExpires: now.Add(-time.Hour)}},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			repository := testrepo.New(t, targetPath, []byte("approved"), testCase.options)
			server := httptest.NewServer(http.FileServer(http.Dir(repository.PublicDir)))
			defer server.Close()
			client, err := Open(clientConfig(t, repository.Root, server.URL, t.TempDir()))
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			if _, err := client.Refresh(); err == nil {
				t.Fatalf("client accepted expired %s metadata", testCase.name)
			}
		})
	}
}

func TestDurableStateRejectsRollbackRebootstrapAndConcurrentUse(t *testing.T) {
	t.Parallel()
	targetPath := testrepo.TargetPath("staging", releaseID, "release-bundle.json")
	repository := testrepo.New(t, targetPath, []byte("version-one"), testrepo.Options{})
	server := httptest.NewServer(http.FileServer(http.Dir(repository.PublicDir)))
	defer server.Close()
	stateDir := filepath.Join(t.TempDir(), "state")
	configuration := clientConfig(t, repository.Root, server.URL, stateDir)

	first, err := Open(configuration)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.Refresh(); err != nil {
		t.Fatal(err)
	}
	oldTimestamp, err := os.ReadFile(repository.MetadataPath("timestamp.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Open(configuration); err == nil {
		t.Fatal("client allowed concurrent use of one durable state directory")
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}

	repository.AddOrReplaceTarget(t, targetPath, []byte("version-two"))
	second, err := Open(configuration)
	if err != nil {
		t.Fatal(err)
	}
	state, err := second.Refresh()
	if err != nil {
		t.Fatal(err)
	}
	if state.Timestamp.Version != 2 {
		t.Fatalf("expected timestamp version 2, got %d", state.Timestamp.Version)
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(repository.MetadataPath("timestamp.json"), oldTimestamp, 0o600); err != nil {
		t.Fatal(err)
	}
	rolledBack, err := Open(configuration)
	if err != nil {
		t.Fatal(err)
	}
	defer rolledBack.Close()
	if _, err := rolledBack.Refresh(); err == nil {
		t.Fatal("client accepted a timestamp rollback")
	}

	otherRoot := testrepo.New(t, targetPath, []byte("other-root"), testrepo.Options{})
	wrong := clientConfig(t, otherRoot.Root, server.URL, stateDir)
	if _, err := Open(wrong); err == nil {
		t.Fatal("client silently re-bootstrapped existing state with another root")
	}
}

func TestMixedMetadataGenerationsFailClosed(t *testing.T) {
	t.Parallel()
	targetPath := testrepo.TargetPath("staging", releaseID, "release-bundle.json")
	for _, role := range []string{"snapshot", "targets"} {
		role := role
		t.Run(role, func(t *testing.T) {
			t.Parallel()
			repository := testrepo.New(t, targetPath, []byte("version-one"), testrepo.Options{})
			oldGeneration, err := os.ReadFile(repository.MetadataPath("1." + role + ".json"))
			if err != nil {
				t.Fatal(err)
			}
			repository.AddOrReplaceTarget(t, targetPath, []byte("version-two"))
			if err := os.WriteFile(repository.MetadataPath("2."+role+".json"), oldGeneration, 0o600); err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(http.FileServer(http.Dir(repository.PublicDir)))
			defer server.Close()
			client, err := Open(clientConfig(t, repository.Root, server.URL, t.TempDir()))
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			if _, err := client.Refresh(); err == nil {
				t.Fatalf("client accepted mixed %s metadata generations", role)
			}
		})
	}
}

func TestPinAndRedirectFailures(t *testing.T) {
	t.Parallel()
	targetPath := testrepo.TargetPath("staging", releaseID, "release-bundle.json")
	repository := testrepo.New(t, targetPath, []byte("approved"), testrepo.Options{})
	server := httptest.NewServer(http.FileServer(http.Dir(repository.PublicDir)))
	defer server.Close()
	configuration := clientConfig(t, repository.Root, server.URL, t.TempDir())
	configuration.TrustedRootSHA256 = strings.Repeat("0", 64)
	if _, err := Open(configuration); err == nil {
		t.Fatal("client accepted a wrong root pin")
	}
	stateParent := t.TempDir()
	stateDirectory := filepath.Join(stateParent, "hid-tuf-state")
	if err := os.Mkdir(stateDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	lockTarget := filepath.Join(t.TempDir(), "external-lock")
	if err := os.WriteFile(lockTarget, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(lockTarget, filepath.Join(stateDirectory, ".lock")); err != nil {
		t.Fatal(err)
	}
	configuration = clientConfig(t, repository.Root, server.URL, stateParent)
	if _, err := Open(configuration); err == nil {
		t.Fatal("client followed a symlinked state lock")
	}

	redirect := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, server.URL+request.URL.Path, http.StatusFound)
	}))
	defer redirect.Close()
	configuration = clientConfig(t, repository.Root, redirect.URL, t.TempDir())
	configuration.HTTPClient = &http.Client{
		Transport: http.DefaultTransport,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return nil
		},
	}
	client, err := Open(configuration)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if _, err := client.Refresh(); err == nil {
		t.Fatal("client followed a repository redirect")
	}
}

func TestUnsafeTargetPathsFailBeforeNetworkUse(t *testing.T) {
	t.Parallel()
	for _, value := range []string{
		"", ".", "../release-bundle.json", "/environments/staging/releases/" + releaseID + "/bundle.json",
		"environments/staging/releases/" + releaseID, "environments/staging/releases/" + releaseID + "/",
		"environments/staging/releases/" + releaseID + "/../bundle.json",
		"environments/staging/releases/" + releaseID + "/UPPER.json",
		"environments/staging/releases/" + releaseID + "/café.json",
		"environments/staging/releases/" + releaseID + "/back\\slash.json",
		"environments/production/releases/" + releaseID + "/bundle.json",
	} {
		if err := validateTargetPath("staging", releaseID, value); err == nil {
			t.Fatalf("accepted unsafe or cross-boundary target path %q", value)
		}
	}
	if err := validateTargetPath("staging", releaseID,
		"environments/staging/releases/"+releaseID+"/release-bundle.json"); err != nil {
		t.Fatalf("rejected valid release target path: %v", err)
	}
	stateDirectory := t.TempDir()
	client := &Client{configuration: Config{Environment: "staging", StateDir: stateDirectory}}
	if err := client.DownloadReleaseTarget(releaseID,
		"environments/staging/releases/"+releaseID+"/release-bundle.json",
		filepath.Join(stateDirectory, "targets", "injected.json")); err == nil {
		t.Fatal("single-target download accepted an output inside private client state")
	}
	symlinkParent := filepath.Join(t.TempDir(), "state-link")
	if err := os.Symlink(stateDirectory, symlinkParent); err != nil {
		t.Fatal(err)
	}
	if err := client.DownloadReleaseTarget(releaseID,
		"environments/staging/releases/"+releaseID+"/release-bundle.json",
		filepath.Join(symlinkParent, "targets", "injected.json")); err == nil {
		t.Fatal("single-target download accepted a symlinked destination parent")
	}
}

func TestInvocationHTTPClientOverridesRedirectAndBoundsWholeInvocation(t *testing.T) {
	t.Parallel()
	source := &http.Client{
		Timeout: time.Hour,
		Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			<-request.Context().Done()
			return nil, request.Context().Err()
		}),
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return nil },
	}
	deadline := time.Now().Add(40 * time.Millisecond)
	bounded := invocationHTTPClient(source, deadline)
	if bounded.Timeout != 30*time.Second {
		t.Fatalf("per-request timeout is not bounded: %s", bounded.Timeout)
	}
	if source.Timeout != time.Hour {
		t.Fatal("invocationHTTPClient mutated its caller's HTTP client")
	}
	started := time.Now()
	_, err := bounded.Get("https://updates.example.test/metadata/timestamp.json")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("whole-invocation deadline was not enforced: %v", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("deadline enforcement was unexpectedly slow: %s", elapsed)
	}
	if err := bounded.CheckRedirect(&http.Request{}, nil); err == nil {
		t.Fatal("caller-supplied permissive redirect policy survived hardening")
	}
}

func TestWriteAllDetectsShortWrite(t *testing.T) {
	t.Parallel()
	if err := writeAll(shortClientWriter{}, []byte("verified target")); !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("short write was not rejected: %v", err)
	}
}

func TestPersistedRotatedRootRejectsRevokedTimestampReplay(t *testing.T) {
	t.Parallel()
	targetPath := testrepo.TargetPath("staging", releaseID, "release-bundle.json")
	repository := testrepo.New(t, targetPath, []byte("approved"), testrepo.Options{})
	oldTimestamp, err := os.ReadFile(repository.MetadataPath("timestamp.json"))
	if err != nil {
		t.Fatal(err)
	}
	var replayOldGeneration atomic.Bool
	files := http.FileServer(http.Dir(repository.PublicDir))
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if replayOldGeneration.Load() {
			switch request.URL.Path {
			case "/metadata/3.root.json":
				http.NotFound(writer, request)
				return
			case "/metadata/timestamp.json":
				writer.Header().Set("Content-Type", "application/json")
				_, _ = writer.Write(oldTimestamp)
				return
			}
		}
		files.ServeHTTP(writer, request)
	}))
	defer server.Close()

	stateParent := t.TempDir()
	configuration := clientConfig(t, repository.Root, server.URL, stateParent)
	first, err := Open(configuration)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.Refresh(); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}

	repository.RotateTimestampKey(t)
	second, err := Open(configuration)
	if err != nil {
		t.Fatal(err)
	}
	state, err := second.Refresh()
	if err != nil {
		t.Fatal(err)
	}
	if state.Root.Version != 2 || state.Timestamp.Version != 2 {
		t.Fatalf("rotation did not reach root/timestamp version 2: %+v", state)
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}

	replayOldGeneration.Store(true)
	replayed, err := Open(configuration)
	if err != nil {
		t.Fatal(err)
	}
	defer replayed.Close()
	if _, err := replayed.Refresh(); err == nil {
		t.Fatal("client accepted metadata signed by a timestamp key revoked by the persisted root")
	}
}

func clientConfig(t *testing.T, root []byte, serverURL, stateParent string) Config {
	t.Helper()
	rootPath := filepath.Join(t.TempDir(), "root.json")
	if err := os.WriteFile(rootPath, root, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(root)
	return Config{
		Environment: "staging", RepositoryID: "hid-tuf-staging-v1",
		MetadataURL: serverURL + "/metadata", TargetsURL: serverURL + "/targets",
		TrustedRootPath: rootPath, TrustedRootSHA256: hex.EncodeToString(digest[:]),
		StateDir: filepath.Join(stateParent, "hid-tuf-state"), MaxTargetBytes: 16 << 20,
		AllowUnsafeHTTP: true, HTTPClient: DefaultHTTPClient(),
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

type shortClientWriter struct{}

func (shortClientWriter) Write(data []byte) (int, error) {
	return len(data) / 2, nil
}
