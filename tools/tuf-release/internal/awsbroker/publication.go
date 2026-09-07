package awsbroker

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/repository"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/signingbroker"
)

const (
	BootstrapRootObjectSchema = "hid.tuf.signing-broker.bootstrap-root/v1"
	CheckpointResultSchema    = "hid.tuf.signing-broker.checkpoint-result/v1"
)

type GenerationVersions struct {
	Root      int64 `json:"root"`
	Targets   int64 `json:"targets"`
	Snapshot  int64 `json:"snapshot"`
	Timestamp int64 `json:"timestamp"`
}

type PublishedGenerationSource interface {
	FetchGeneration(context.Context, GenerationVersions, string) (signingbroker.PublishedGeneration, error)
}

type PublicRepositoryConfig struct {
	Environment string
	BaseURL     string
}

type PublicRepository struct {
	config PublicRepositoryConfig
	base   *url.URL
	client *http.Client
}

func NewPublicRepository(config PublicRepositoryConfig, transport http.RoundTripper) (*PublicRepository, error) {
	expectedURL := "https://updates.healthidentitydirectory.com/"
	if config.Environment == "staging" {
		expectedURL = "https://updates.staging.healthidentitydirectory.com/"
	} else if config.Environment != "production" {
		return nil, errors.New("public repository environment is invalid")
	}
	if config.BaseURL != expectedURL {
		return nil, errors.New("public repository URL is not the governed environment origin")
	}
	base, err := url.Parse(config.BaseURL)
	if err != nil || base.Scheme != "https" || base.Host != base.Hostname() || base.Path != "/" || base.RawQuery != "" || base.Fragment != "" || base.User != nil {
		return nil, errors.New("public repository URL is not one normalized HTTPS origin")
	}
	if isNil(transport) {
		return nil, errors.New("public repository HTTP transport is required")
	}
	return &PublicRepository{
		config: config, base: base,
		client: &http.Client{
			Transport: transport,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return errors.New("public TUF repository redirects are forbidden")
			},
		},
	}, nil
}

func (repositorySource *PublicRepository) FetchGeneration(ctx context.Context, versions GenerationVersions, releaseID string) (signingbroker.PublishedGeneration, error) {
	if repositorySource == nil || isNil(ctx) || !validGenerationVersions(versions) ||
		(releaseID != "" && !releaseIDPattern.MatchString(releaseID)) {
		return signingbroker.PublishedGeneration{}, errors.New("public generation request is invalid")
	}
	timestamp, err := repositorySource.fetch(ctx, "metadata/timestamp.json", repository.MaxTimestampMetadataBytes, false)
	if err != nil {
		return signingbroker.PublishedGeneration{}, err
	}
	root, err := repositorySource.fetch(ctx, versionedMetadataPath(versions.Root, "root"), repository.MaxRootMetadataBytes, true)
	if err != nil {
		return signingbroker.PublishedGeneration{}, err
	}
	targets, err := repositorySource.fetch(ctx, versionedMetadataPath(versions.Targets, "targets"), repository.MaxTargetsMetadataBytes, true)
	if err != nil {
		return signingbroker.PublishedGeneration{}, err
	}
	snapshot, err := repositorySource.fetch(ctx, versionedMetadataPath(versions.Snapshot, "snapshot"), repository.MaxSnapshotMetadataBytes, true)
	if err != nil {
		return signingbroker.PublishedGeneration{}, err
	}
	if releaseID == "" {
		releaseID, err = repository.DiscoverTargetsReleaseID(targets, repositorySource.config.Environment)
		if err != nil {
			return signingbroker.PublishedGeneration{}, fmt.Errorf("discover bootstrap release ID: %w", err)
		}
	}
	return signingbroker.PublishedGeneration{
		Environment: repositorySource.config.Environment, ReleaseID: releaseID,
		RootBytes: root, TargetsBytes: targets, SnapshotBytes: snapshot, TimestampBytes: timestamp,
	}, nil
}

func (repositorySource *PublicRepository) fetch(ctx context.Context, relativePath string, maximum int, immutable bool) ([]byte, error) {
	expected := *repositorySource.base
	expected.Path = "/" + relativePath
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, expected.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("construct public repository request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Accept-Encoding", "identity")
	request.Header.Set("User-Agent", "hid-tuf-checkpoint/1")
	response, err := repositorySource.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("fetch fixed public repository path %s: %w", relativePath, err)
	}
	if response == nil || response.Body == nil {
		return nil, fmt.Errorf("fetch fixed public repository path %s returned no response body", relativePath)
	}
	closeBody := func() { _ = response.Body.Close() }
	if response.Request == nil || response.Request.URL.String() != expected.String() || response.StatusCode != http.StatusOK {
		closeBody()
		return nil, fmt.Errorf("fixed public repository path %s returned an unexpected URL or status", relativePath)
	}
	mediaType, parameters, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" || parameters["charset"] != "utf-8" || len(parameters) != 1 {
		closeBody()
		return nil, fmt.Errorf("fixed public repository path %s has the wrong media type", relativePath)
	}
	expectedCache := "no-store"
	if immutable {
		expectedCache = "public, max-age=31536000, immutable"
	}
	if response.Header.Get("Cache-Control") != expectedCache || response.Header.Get("Content-Encoding") != "" ||
		response.Header.Get("X-Content-Type-Options") != "nosniff" {
		closeBody()
		return nil, fmt.Errorf("fixed public repository path %s has the wrong security/cache headers", relativePath)
	}
	if response.ContentLength == 0 || response.ContentLength > int64(maximum) {
		closeBody()
		return nil, fmt.Errorf("fixed public repository path %s exceeds its size policy", relativePath)
	}
	data, readErr := io.ReadAll(io.LimitReader(response.Body, int64(maximum)+1))
	closeErr := response.Body.Close()
	if readErr != nil {
		return nil, fmt.Errorf("read fixed public repository path %s: %w", relativePath, readErr)
	}
	if closeErr != nil {
		return nil, fmt.Errorf("close fixed public repository path %s: %w", relativePath, closeErr)
	}
	if len(data) == 0 || len(data) > maximum || response.ContentLength >= 0 && int64(len(data)) != response.ContentLength {
		return nil, fmt.Errorf("fixed public repository path %s returned invalid length", relativePath)
	}
	return data, nil
}

func validGenerationVersions(versions GenerationVersions) bool {
	return versions.Root >= 1 && versions.Root <= maxSafeInteger && versions.Targets >= 1 && versions.Targets <= maxSafeInteger &&
		versions.Snapshot >= 1 && versions.Snapshot <= maxSafeInteger && versions.Timestamp >= 1 && versions.Timestamp <= maxSafeInteger
}

func versionedMetadataPath(version int64, role string) string {
	return "metadata/" + strconv.FormatInt(version, 10) + "." + role + ".json"
}

type CheckpointRunnerConfig struct {
	Environment                  string
	StateID                      string
	BootstrapRootSHA256          string
	BootstrapRootObjectKey       string
	BootstrapRootObjectVersionID string
}

type CheckpointResult struct {
	SchemaVersion string             `json:"schema_version"`
	Action        string             `json:"action"`
	Environment   string             `json:"environment"`
	StateID       string             `json:"state_id"`
	ReleaseID     string             `json:"release_id"`
	Revision      int64              `json:"revision"`
	Versions      GenerationVersions `json:"versions"`
}

type CheckpointRunner struct {
	config     CheckpointRunnerConfig
	controller *signingbroker.PublicationController
	source     PublishedGenerationSource
	bootstrap  *ImmutableObjectReader
}

func NewCheckpointRunner(
	config CheckpointRunnerConfig,
	controller *signingbroker.PublicationController,
	source PublishedGenerationSource,
	bootstrapReader *ImmutableObjectReader,
) (*CheckpointRunner, error) {
	if config.Environment != "staging" && config.Environment != "production" ||
		!identifierPattern.MatchString(config.StateID) || config.StateID != "hid-"+config.Environment+"-broker-v1" ||
		!sha256Pattern.MatchString(config.BootstrapRootSHA256) || !validObjectKey(config.BootstrapRootObjectKey) ||
		config.BootstrapRootObjectKey != "tuf-signing-broker/bootstrap/"+config.StateID+"/root.json" ||
		!validVersionID(config.BootstrapRootObjectVersionID) || controller == nil || isNil(source) || bootstrapReader == nil {
		return nil, errors.New("checkpoint runner configuration is invalid")
	}
	return &CheckpointRunner{config: config, controller: controller, source: source, bootstrap: bootstrapReader}, nil
}

func (runner *CheckpointRunner) Check(ctx context.Context) (CheckpointResult, error) {
	if runner == nil || isNil(ctx) {
		return CheckpointResult{}, errors.New("checkpoint runner and context are required")
	}
	checkpoint, err := runner.controller.CurrentCheckpoint(ctx)
	if errors.Is(err, signingbroker.ErrStateNotFound) {
		return runner.bootstrapCheckpoint(ctx)
	}
	if err != nil {
		return CheckpointResult{}, err
	}
	currentRoot := checkpoint.RootHistory[len(checkpoint.RootHistory)-1]
	versions := GenerationVersions{
		Root: currentRoot.Version, Targets: checkpoint.Targets.Version,
		Snapshot: checkpoint.Snapshot.Version, Timestamp: checkpoint.Timestamp.Version,
	}
	releaseID := checkpoint.ReleaseID
	action := "verified"
	advance := checkpoint.PendingTimestamp != nil
	if advance {
		action = "advanced"
		pendingTimestamp := checkpoint.PendingTimestamp
		versions.Root = pendingTimestamp.Root.Version
		versions.Snapshot = pendingTimestamp.Snapshot.Version
		versions.Timestamp = pendingTimestamp.Timestamp.Version
		releaseID = pendingTimestamp.ReleaseID
		if checkpoint.PendingSnapshot != nil {
			versions.Targets = checkpoint.PendingSnapshot.Targets.Version
		}
	}
	published, err := runner.source.FetchGeneration(ctx, versions, releaseID)
	if err != nil {
		return CheckpointResult{}, err
	}
	if advance {
		checkpoint, err = runner.controller.AdvancePublished(ctx, published)
	} else {
		checkpoint, err = runner.controller.VerifyPublished(ctx, published)
	}
	if err != nil {
		return CheckpointResult{}, err
	}
	return checkpointResult(action, checkpoint), nil
}

func (runner *CheckpointRunner) bootstrapCheckpoint(ctx context.Context) (CheckpointResult, error) {
	privateRoot, err := runner.bootstrap.Read(
		ctx, runner.config.BootstrapRootObjectKey, runner.config.BootstrapRootObjectVersionID,
		runner.config.BootstrapRootSHA256, repository.MaxRootMetadataBytes,
		map[string]string{
			"hid-schema": BootstrapRootObjectSchema, "hid-state-id": runner.config.StateID,
			"hid-sha256": runner.config.BootstrapRootSHA256,
		},
	)
	if err != nil {
		return CheckpointResult{}, fmt.Errorf("load pinned private bootstrap root: %w", err)
	}
	versions := GenerationVersions{Root: 1, Targets: 1, Snapshot: 1, Timestamp: 1}
	published, err := runner.source.FetchGeneration(ctx, versions, "")
	if err != nil {
		return CheckpointResult{}, err
	}
	if !bytes.Equal(privateRoot, published.RootBytes) {
		return CheckpointResult{}, errors.New("public bootstrap root differs from the pinned private immutable version")
	}
	checkpoint, err := runner.controller.BootstrapPublished(ctx, published)
	if err != nil {
		return CheckpointResult{}, err
	}
	return checkpointResult("bootstrapped", checkpoint), nil
}

func checkpointResult(action string, checkpoint signingbroker.Checkpoint) CheckpointResult {
	root := checkpoint.RootHistory[len(checkpoint.RootHistory)-1]
	return CheckpointResult{
		SchemaVersion: CheckpointResultSchema, Action: action, Environment: checkpoint.Environment,
		StateID: checkpoint.StateID, ReleaseID: checkpoint.ReleaseID, Revision: checkpoint.Revision,
		Versions: GenerationVersions{Root: root.Version, Targets: checkpoint.Targets.Version, Snapshot: checkpoint.Snapshot.Version, Timestamp: checkpoint.Timestamp.Version},
	}
}

// Compile-time assertion that PublicRepository remains the bounded source used
// by the Lambda runtime.
var _ PublishedGenerationSource = (*PublicRepository)(nil)
