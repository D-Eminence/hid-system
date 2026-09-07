// Command hid-tuf-publication performs a fresh read-only authorization for one
// pending repository generation. It never signs, writes state, or publishes.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/awsbroker"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/repository"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/signingbroker"
	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type controllerFactory func(context.Context, awsbroker.PublicationReaderConfig) (*signingbroker.PublicationController, error)

type authorizationResult struct {
	SchemaVersion            string                                 `json:"schema_version"`
	RepositorySHA256         string                                 `json:"repository_sha256"`
	PreviousRepositorySHA256 string                                 `json:"previous_repository_sha256"`
	FileCount                int                                    `json:"file_count"`
	Authorization            signingbroker.PublicationAuthorization `json:"authorization"`
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if err := run(ctx, os.Args[1:], os.Stdout, newAWSController, time.Now); err != nil {
		fmt.Fprintln(os.Stderr, "hid-tuf-publication:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, output io.Writer, factory controllerFactory, clock func() time.Time) error {
	if len(args) == 4 && args[0] == "materialize" {
		return materialize(ctx, args[1:], output, factory)
	}
	if len(args) == 5 && args[0] == "confirm" {
		return confirm(ctx, args[1:], output, factory, clock)
	}
	if len(args) != 5 {
		return errors.New("usage: hid-tuf-publication ABSOLUTE_CONFIG ABSOLUTE_PREDECESSOR EXPECTED_PREDECESSOR_SHA256 ABSOLUTE_CANDIDATE EXPECTED_CANDIDATE_SHA256\n       hid-tuf-publication ABSOLUTE_CONFIG - - ABSOLUTE_BOOTSTRAP_CANDIDATE EXPECTED_CANDIDATE_SHA256\n       hid-tuf-publication materialize ABSOLUTE_CONFIG ABSOLUTE_GENERATION_PLAN ABSENT_DESTINATION\n       hid-tuf-publication confirm ABSOLUTE_CONFIG ABSOLUTE_CANDIDATE EXPECTED_CANDIDATE_SHA256 EXPECTED_PRIOR_STATE_REVISION")
	}
	configBytes, err := repository.ReadOperatorConfigFile(args[0])
	if err != nil {
		return err
	}
	config, err := awsbroker.DecodePublicationReaderConfig(configBytes)
	if err != nil {
		return err
	}
	reference := clock().UTC().Truncate(time.Second)
	var previous repository.PublicationGeneration
	if args[1] != "-" {
		previous, err = repository.InspectPublicationGeneration(args[1], config.Environment, reference, false)
		if err != nil {
			return fmt.Errorf("inspect publication predecessor: %w", err)
		}
		// This pin must come from retained evidence of the previous publication,
		// not from recalculating the caller's directory. Current metadata alone
		// cannot authenticate the complete immutable file history.
		if previous.SHA256() != args[2] {
			return errors.New("predecessor repository differs from the protected previous publication hash")
		}
	} else if args[2] != "-" {
		return errors.New("bootstrap publication requires '-' for both predecessor and predecessor hash")
	}
	candidate, err := repository.InspectPublicationGeneration(args[3], config.Environment, reference, true)
	if err != nil {
		return fmt.Errorf("inspect publication candidate: %w", err)
	}
	if candidate.SHA256() != args[4] {
		return errors.New("candidate repository differs from the expected publication hash")
	}
	if args[1] != "-" {
		if err := repository.ValidatePublicationSuccessor(previous, candidate); err != nil {
			return err
		}
	} else {
		state, err := repository.ValidateMetadataSet(candidate.Metadata())
		if err != nil {
			return err
		}
		if state.RootVersion != 1 || state.TargetsVersion != 1 || state.SnapshotVersion != 1 || state.TimestampVersion != 1 || state.RootSHA256 != config.BootstrapRootSHA256 {
			return errors.New("bootstrap candidate differs from the pinned all-version-one generation")
		}
	}
	// All local inputs and retained file closure are checked before credentials
	// or AWS clients are initialized. Only the protected config supplies trust.
	controller, err := factory(ctx, config)
	if err != nil {
		return err
	}
	toPublished := func(generation repository.PublicationGeneration) signingbroker.PublishedGeneration {
		set := generation.Metadata()
		return signingbroker.PublishedGeneration{Environment: set.Environment, ReleaseID: set.ReleaseID,
			RootBytes: set.RootBytes, TargetsBytes: set.TargetsBytes, SnapshotBytes: set.SnapshotBytes, TimestampBytes: set.TimestampBytes}
	}
	var authorization signingbroker.PublicationAuthorization
	if args[1] == "-" {
		authorization, err = controller.AuthorizeBootstrapPublication(ctx, toPublished(candidate))
	} else {
		authorization, err = controller.AuthorizePendingPublication(ctx, toPublished(previous), toPublished(candidate))
	}
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(authorizationResult{
		SchemaVersion: "hid.tuf.publication-authorization/v1", RepositorySHA256: candidate.SHA256(),
		PreviousRepositorySHA256: previous.SHA256(), FileCount: candidate.FileCount(), Authorization: authorization,
	})
}

type lazyMaterializationAuthorizer struct {
	config     awsbroker.PublicationReaderConfig
	factory    controllerFactory
	controller *signingbroker.PublicationController
}

func (authorizer *lazyMaterializationAuthorizer) AuthorizeMaterialization(ctx context.Context, current, candidate repository.MetadataSet) error {
	if authorizer.controller == nil {
		controller, err := authorizer.factory(ctx, authorizer.config)
		if err != nil {
			return err
		}
		authorizer.controller = controller
	}
	return authorizer.controller.AuthorizeMaterialization(ctx, current, candidate)
}

func materialize(ctx context.Context, args []string, output io.Writer, factory controllerFactory) error {
	configBytes, err := repository.ReadOperatorConfigFile(args[0])
	if err != nil {
		return err
	}
	config, err := awsbroker.DecodePublicationReaderConfig(configBytes)
	if err != nil {
		return err
	}
	input, err := repository.LoadGenerationInput(args[1], args[2])
	if err != nil {
		return err
	}
	if input.Prepared.Plan.Environment != config.Environment || input.Prepared.Plan.RepositoryID != config.RepositoryID {
		return errors.New("materialization plan differs from the protected publication configuration")
	}
	result, err := repository.MaterializePendingGeneration(ctx, input, &lazyMaterializationAuthorizer{config: config, factory: factory})
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(result)
}

func newAWSController(ctx context.Context, config awsbroker.PublicationReaderConfig) (*signingbroker.PublicationController, error) {
	loaded, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(config.ExpectedAWSRegion))
	if err != nil {
		return nil, err
	}
	// Retain only the credential provider. Service endpoint overrides, SDK
	// middleware, discovery, and shared-config endpoint settings cannot redirect
	// this state read. Use SDK-owned regional endpoints and normal TLS validation.
	client := &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
		return errors.New("publication state redirects are forbidden")
	}}
	configAWS := aws.Config{Region: config.ExpectedAWSRegion, Credentials: loaded.Credentials, HTTPClient: client, RetryMaxAttempts: 2}
	return awsbroker.NewPublicationReader(config, s3.NewFromConfig(configAWS), dynamodb.NewFromConfig(configAWS), time.Now)
}
