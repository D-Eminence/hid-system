package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/awsbroker"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/repository"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/signingbroker"
)

type confirmationResult struct {
	SchemaVersion    string                                `json:"schema_version"`
	RepositorySHA256 string                                `json:"repository_sha256"`
	FileCount        int                                   `json:"file_count"`
	Confirmation     signingbroker.PublicationConfirmation `json:"confirmation"`
}

// confirm observes the separately authorized public canary's durable result.
// It never invokes that canary, advances the checkpoint, or authorizes upload.
func confirm(ctx context.Context, args []string, output io.Writer, factory controllerFactory, clock func() time.Time) error {
	prior, err := strconv.ParseInt(args[3], 10, 64)
	if err != nil || prior < 0 || prior >= 9007199254740991 || strconv.FormatInt(prior, 10) != args[3] {
		return errors.New("confirmation requires a canonical nonnegative JavaScript-safe prior state revision")
	}
	configBytes, err := repository.ReadOperatorConfigFile(args[0])
	if err != nil {
		return err
	}
	config, err := awsbroker.DecodePublicationReaderConfig(configBytes)
	if err != nil {
		return err
	}
	candidate, err := repository.InspectPublicationGeneration(args[1], config.Environment, clock().UTC().Truncate(time.Second), true)
	if err != nil {
		return err
	}
	if candidate.SHA256() != args[2] {
		return errors.New("confirmation candidate differs from the expected repository hash")
	}
	controller, err := factory(ctx, config)
	if err != nil {
		return err
	}
	set := candidate.Metadata()
	confirmation, err := controller.ConfirmPublished(ctx, signingbroker.PublishedGeneration{
		Environment: set.Environment, ReleaseID: set.ReleaseID, RootBytes: set.RootBytes,
		TargetsBytes: set.TargetsBytes, SnapshotBytes: set.SnapshotBytes, TimestampBytes: set.TimestampBytes,
	}, prior)
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(confirmationResult{
		SchemaVersion: "hid.tuf.publication-confirmation/v1", RepositorySHA256: candidate.SHA256(),
		FileCount: candidate.FileCount(), Confirmation: confirmation,
	})
}
