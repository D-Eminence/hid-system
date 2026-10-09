package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/aws/aws-lambda-go/lambda"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/awsbroker"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/signingbroker"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	runtime, config, err := buildRuntime(context.Background())
	if err != nil {
		lambda.Start(func(ctx context.Context, _ json.RawMessage) (any, error) {
			logger.ErrorContext(ctx, "signing broker initialization failed",
				"operation", config.Operation,
				"environment", config.Environment,
				"state_id", config.StateID,
				"error", err,
			)
			return nil, err
		})
		return
	}
	lambda.Start(func(ctx context.Context, event json.RawMessage) (any, error) {
		result, invokeErr := runtime.Invoke(ctx, event)
		if invokeErr != nil {
			logger.ErrorContext(ctx, "signing broker invocation failed",
				"operation", config.Operation,
				"environment", config.Environment,
				"state_id", config.StateID,
				"role", config.Role,
				"candidate_id", config.CandidateID,
				"error", invokeErr,
			)
			return nil, invokeErr
		}
		logSuccessfulInvocation(ctx, logger, result)
		return result, nil
	})
}

func buildRuntime(ctx context.Context) (*awsbroker.Runtime, awsbroker.RuntimeConfig, error) {
	config, err := awsbroker.LoadRuntimeConfig(os.LookupEnv)
	if err != nil {
		return nil, config, err
	}
	awsConfiguration, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(config.ExpectedAWSRegion))
	if err != nil {
		return nil, config, err
	}
	if awsConfiguration.Region != config.ExpectedAWSRegion {
		return nil, config, errors.New("AWS SDK region differs from the fixed broker region")
	}
	runtime, err := awsbroker.NewRuntime(config, awsbroker.RuntimeClients{
		S3: s3.NewFromConfig(awsConfiguration), DynamoDB: dynamodb.NewFromConfig(awsConfiguration),
		KMS: kms.NewFromConfig(awsConfiguration, func(options *kms.Options) {
			// The SDK performs one attempt per invocation. KMS may still have
			// completed an operation whose response was lost; durable CAS and exact
			// replay ensure only one committed/exposed broker winner.
			options.RetryMaxAttempts = 1
		}),
		HTTPTransport: http.DefaultTransport,
	}, time.Now)
	return runtime, config, err
}

func logSuccessfulInvocation(ctx context.Context, logger *slog.Logger, value any) {
	switch result := value.(type) {
	case signingbroker.Result:
		attributes := []any{
			"operation", "sign",
			"environment", result.Environment,
			"state_id", result.StateID,
			"role", result.Role,
			"candidate_id", result.CandidateID,
			"release_id", result.ReleaseID,
			"request_sha256", result.RequestSHA256,
			"output_version", result.OutputVersion,
			"output_sha256", result.OutputSHA256,
			"state_revision", result.StateRevision,
			"idempotent_replay", result.IdempotentReplay,
		}
		if result.RequestObject != nil {
			attributes = append(attributes,
				"request_bucket", result.RequestObject.Bucket,
				"request_key", result.RequestObject.Key,
				"request_version_id", result.RequestObject.VersionID,
			)
		}
		logger.InfoContext(ctx, "signing broker request committed", attributes...)
	case awsbroker.CheckpointResult:
		logger.InfoContext(ctx, "signing broker checkpoint completed",
			"operation", "checkpoint",
			"action", result.Action,
			"environment", result.Environment,
			"state_id", result.StateID,
			"release_id", result.ReleaseID,
			"state_revision", result.Revision,
			"root_version", result.Versions.Root,
			"targets_version", result.Versions.Targets,
			"snapshot_version", result.Versions.Snapshot,
			"timestamp_version", result.Versions.Timestamp,
		)
	default:
		logger.ErrorContext(ctx, "signing broker returned an unexpected result type",
			"result_type", "unknown",
		)
	}
}
